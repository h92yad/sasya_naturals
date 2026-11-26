'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDb } = require('../../db/database');
const {
  PAYMENT_CONFIG,
  SELLER_ORIGIN_STATE,
  ORDER_PAYMENT_STATUSES,
  ORDER_FULFILMENT_STATUSES
} = require('../../config/appConfig');
const { getVaultSecret } = require('../auth/credentialVault');
const {
  evaluateProductPincodeServiceability,
  validatePincodeServiceability,
  verifyCodOtp,
  isPhoneCodVerified
} = require('./codProtection');
const { lintContentText } = require('../content/contentLinter');

// Load compiled Rust WebAssembly Commerce Core (wasm_core.wasm)
const wasmPath = path.join(__dirname, 'wasm_core.wasm');
const wasmBytes = fs.readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
const wasmInstance = new WebAssembly.Instance(wasmModule, {});
const rustWasm = wasmInstance.exports;

function wasmLineTotalPaise(unitPricePaise, quantity) {
  return Number(rustWasm.compute_line_total_paise(BigInt(unitPricePaise), BigInt(quantity)));
}

function wasmInclusiveGstPaise(lineTotalPaise, gstPercent) {
  return Number(rustWasm.compute_inclusive_gst_paise(BigInt(lineTotalPaise), BigInt(gstPercent)));
}

function wasmCouponDiscountPaise(subtotalPaise, discountType, discountValue, minOrderPaise, maxDiscountPaise) {
  const typeCode = discountType === 'PERCENT' ? 1 : (discountType === 'FLAT_PAISE' ? 2 : 0);
  return Number(
    rustWasm.compute_coupon_discount_paise(
      BigInt(subtotalPaise),
      typeCode,
      BigInt(discountValue),
      BigInt(minOrderPaise),
      BigInt(maxDiscountPaise)
    )
  );
}

function wasmShippingPaise(discountedSubtotalPaise, freeThresholdPaise, standardShippingPaise) {
  return Number(
    rustWasm.compute_shipping_paise(
      BigInt(discountedSubtotalPaise),
      BigInt(freeThresholdPaise),
      BigInt(standardShippingPaise)
    )
  );
}

function wasmBillable500gSlabs(totalProductGrams, packagingTareGrams) {
  return Number(
    rustWasm.compute_billable_500g_slabs(
      BigInt(totalProductGrams),
      BigInt(packagingTareGrams)
    )
  );
}

function wasmZoneWeightShippingPaise({
  discountedSubtotalPaise,
  totalProductGrams,
  packagingTareGrams,
  base500gPaise,
  extra500gPaise,
  freeModeCode,
  freeThresholdPaise,
  freeMaxWeightGrams,
  isCod,
  codFeePaise
}) {
  return Number(
    rustWasm.compute_zone_weight_shipping_paise(
      BigInt(discountedSubtotalPaise),
      BigInt(totalProductGrams),
      BigInt(packagingTareGrams),
      BigInt(base500gPaise),
      BigInt(extra500gPaise),
      Number(freeModeCode),
      BigInt(freeThresholdPaise),
      BigInt(freeMaxWeightGrams),
      isCod ? 1 : 0,
      BigInt(codFeePaise)
    )
  );
}

function wasmOrderTotalPaise(subtotalPaise, discountPaise, shippingPaise) {
  return Number(
    rustWasm.compute_order_total_paise(
      BigInt(subtotalPaise),
      BigInt(discountPaise),
      BigInt(shippingPaise)
    )
  );
}

function getShippingPolicyFromDb() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM store_settings').all();
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));

  const freeMode = map.shipping_free_mode || 'THRESHOLD_WITH_WEIGHT_CAP';
  const freeModeCode =
    freeMode === 'DISABLED' ? 0 : (freeMode === 'UNCONDITIONAL_THRESHOLD' ? 2 : 1);

  return {
    freeMode,
    freeModeCode,
    freeThresholdPaise: Math.round(Number(map.free_shipping_threshold_inr ?? 799) * 100),
    freeMaxWeightGrams: Math.round(Number(map.free_shipping_max_weight_grams ?? 2000)),
    packagingTareGrams: Math.round(Number(map.shipping_packaging_tare_grams ?? 150)),
    codFeePaise: Math.round(Number(map.shipping_cod_fee_inr ?? 40) * 100),
    zones: {
      ZONE_A: {
        code: 'ZONE_A',
        label: 'Zone A (Local Bengaluru)',
        base500gPaise: Math.round(Number(map.zone_a_base_inr ?? 40) * 100),
        extra500gPaise: Math.round(Number(map.zone_a_extra_inr ?? 15) * 100)
      },
      ZONE_B: {
        code: 'ZONE_B',
        label: 'Zone B (South India Regional)',
        base500gPaise: Math.round(Number(map.zone_b_base_inr ?? 55) * 100),
        extra500gPaise: Math.round(Number(map.zone_b_extra_inr ?? 25) * 100)
      },
      ZONE_C: {
        code: 'ZONE_C',
        label: 'Zone C (Rest of India National)',
        base500gPaise: Math.round(Number(map.zone_c_base_inr ?? 75) * 100),
        extra500gPaise: Math.round(Number(map.zone_c_extra_inr ?? 35) * 100)
      },
      ZONE_D: {
        code: 'ZONE_D',
        label: 'Zone D (Special / North-East / J&K / Islands)',
        base500gPaise: Math.round(Number(map.zone_d_base_inr ?? 110) * 100),
        extra500gPaise: Math.round(Number(map.zone_d_extra_inr ?? 55) * 100)
      }
    }
  };
}

function resolveShippingZone(pincode = '560001', policy = getShippingPolicyFromDb()) {
  const cleanPin = String(pincode || '560001').trim();
  const prefix3 = cleanPin.slice(0, 3);
  const prefix2 = cleanPin.slice(0, 2);

  if (prefix3 === '560') {
    return policy.zones.ZONE_A;
  }
  if (['18', '19', '78', '79'].includes(prefix2) || ['744', '682'].includes(prefix3)) {
    return policy.zones.ZONE_D;
  }
  if (['50', '51', '52', '53', '56', '57', '58', '59', '60', '61', '62', '63', '64', '67', '68', '69'].includes(prefix2)) {
    return policy.zones.ZONE_B;
  }
  return policy.zones.ZONE_C;
}

function updateShippingPolicySettings(updates = {}, actorEmail = 'superadmin@sashyanaturals.com', actorRole = 'SUPER_ADMIN') {
  const db = getDb();
  const keyBounds = {
    free_shipping_threshold_inr: { min: 0, max: 100000 },
    free_shipping_max_weight_grams: { min: 100, max: 50000 },
    shipping_packaging_tare_grams: { min: 0, max: 5000 },
    shipping_cod_fee_inr: { min: 0, max: 500 },
    zone_a_base_inr: { min: 0, max: 5000 },
    zone_a_extra_inr: { min: 0, max: 5000 },
    zone_b_base_inr: { min: 0, max: 5000 },
    zone_b_extra_inr: { min: 0, max: 5000 },
    zone_c_base_inr: { min: 0, max: 5000 },
    zone_c_extra_inr: { min: 0, max: 5000 },
    zone_d_base_inr: { min: 0, max: 5000 },
    zone_d_extra_inr: { min: 0, max: 5000 }
  };
  const allowedKeys = ['shipping_free_mode', ...Object.keys(keyBounds)];

  if (updates.shipping_free_mode && !['DISABLED', 'THRESHOLD_WITH_WEIGHT_CAP', 'UNCONDITIONAL_THRESHOLD'].includes(updates.shipping_free_mode)) {
    throw new Error(`Invalid shipping_free_mode: ${updates.shipping_free_mode}`);
  }

  const stmt = db.prepare("INSERT OR REPLACE INTO store_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))");
  const applied = {};
  for (const key of allowedKeys) {
    if (updates[key] !== undefined && updates[key] !== null && String(updates[key]).trim() !== '') {
      const val = String(updates[key]).trim();
      if (key !== 'shipping_free_mode') {
        const numVal = Number(val);
        const bounds = keyBounds[key];
        if (!Number.isFinite(numVal) || numVal < bounds.min || numVal > bounds.max) {
          throw new Error(`Invalid numeric value for ${key}: "${val}" (must be between ${bounds.min} and ${bounds.max}).`);
        }
      }
      stmt.run(key, val);
      applied[key] = val;
    }
  }

  db.prepare(`
    INSERT INTO audit_logs (actor_email, actor_role, action, entity_type, entity_id, details_json)
    VALUES (?, ?, 'SHIPPING_POLICY_UPDATED', 'STORE_SETTINGS', 'SHIPPING_ENGINE', ?)
  `).run(actorEmail, actorRole, JSON.stringify(applied));

  return getShippingPolicyFromDb();
}

function getActiveRazorpayKeyId() {
  return getVaultSecret('RAZORPAY_KEY_ID', PAYMENT_CONFIG.keyId);
}

function getActiveRazorpayKeySecret() {
  return getVaultSecret('RAZORPAY_KEY_SECRET', PAYMENT_CONFIG.keySecret);
}

function computeRazorpaySignature(gatewayOrderId, gatewayPaymentId, secret = getActiveRazorpayKeySecret()) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${gatewayOrderId}|${gatewayPaymentId}`)
    .digest('hex');
}

function verifyRazorpaySignature(gatewayOrderId, gatewayPaymentId, providedSignature, secret = getActiveRazorpayKeySecret()) {
  if (!gatewayOrderId || !gatewayPaymentId || !providedSignature) return false;
  const expected = computeRazorpaySignature(gatewayOrderId, gatewayPaymentId, secret);
  if (expected.length !== providedSignature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(providedSignature, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Splits total GST paise into Intra-State (CGST + SGST) or Inter-State (IGST) based on place of supply.
 */
function computeStateGstSplit(gstPaise, shippingState = 'Karnataka', shippingPincode = '560001') {
  const cleanState = String(shippingState || '').trim().toLowerCase();
  const cleanPin = String(shippingPincode || '').trim();
  const isIntraState =
    cleanState === SELLER_ORIGIN_STATE.toLowerCase() ||
    cleanPin.startsWith('56') ||
    cleanPin.startsWith('57') ||
    cleanPin.startsWith('58') ||
    cleanPin.startsWith('59');

  if (isIntraState) {
    const cgstPaise = Math.floor(gstPaise / 2);
    const sgstPaise = gstPaise - cgstPaise;
    return {
      taxSupplyType: 'CGST_SGST',
      cgstPaise,
      sgstPaise,
      igstPaise: 0
    };
  }
  return {
    taxSupplyType: 'IGST',
    cgstPaise: 0,
    sgstPaise: 0,
    igstPaise: gstPaise
  };
}

const VALID_COUPON_USAGE_TYPES = ['UNIVERSAL', 'ONCE_PER_CUSTOMER', 'SINGLE_USE_GLOBAL'];
const VALID_COUPON_VISIBILITIES = ['PUBLIC_CHIP', 'SECRET_CODE'];

/**
 * Returns current Indian Standard Time (UTC+05:30) formatted as YYYY-MM-DDTHH:mm (16 chars).
 */
function getCurrentIstIsoMinute(nowDate = new Date()) {
  const istMs = nowDate.getTime() + (5.5 * 60 * 60 * 1000);
  return new Date(istMs).toISOString().slice(0, 16);
}

/**
 * Normalizes an IST datetime-local string into YYYY-MM-DDTHH:mm (or empty string).
 */
function normalizeIstDateTimeInput(val, isEndOfDayFallback = false) {
  const raw = String(val || '').trim();
  if (!raw) return '';
  const normalized = raw.replace(' ', 'T');
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?Z?)?$/);
  if (!match) {
    throw new Error('Invalid IST date-time format. Use YYYY-MM-DDTHH:mm (for example 2026-11-25T09:00).');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] !== undefined ? Number(match[4]) : (isEndOfDayFallback ? 23 : 0);
  const minute = match[5] !== undefined ? Number(match[5]) : (isEndOfDayFallback ? 59 : 0);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('Invalid IST date-time: calendar month, day, hour, or minute is out of range.');
  }
  const testDate = new Date(Date.UTC(year, month - 1, day));
  if (
    testDate.getUTCFullYear() !== year ||
    testDate.getUTCMonth() !== month - 1 ||
    testDate.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date "${match[1]}-${match[2]}-${match[3]}".`);
  }

  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${match[1]}-${match[2]}-${match[3]}T${hh}:${mm}`;
}

/**
 * Normalizes an Indian mobile phone number to its trailing 10 digits for per-customer coupon tracking.
 */
function normalizePhoneForCoupon(phone) {
  const digits = String(phone || '').replace(/\D+/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * Counts finalized, non-cancelled, non-refunded redemptions for a coupon code.
 * Unpaid PENDING_PAYMENT / FAILED orders and Cancelled/Refunded orders never burn a coupon slot.
 */
function getCouponUsageStats(db, couponCode, { customerEmail = '', customerPhone = '' } = {}) {
  const cleanCode = String(couponCode || '').trim().toUpperCase();
  if (!cleanCode) return { totalUsed: 0, customerUsed: 0 };

  const rows = db.prepare(`
    SELECT customer_email, customer_phone
    FROM orders
    WHERE UPPER(coupon_code) = ?
      AND fulfilment_status NOT IN ('Cancelled', 'Refunded')
      AND payment_status IN ('PAID', 'COD_PENDING', 'COD_COLLECTED', 'PARTIALLY_REFUNDED')
  `).all(cleanCode);

  const totalUsed = rows.length;
  const cleanEmail = String(customerEmail || '').trim().toLowerCase();
  const cleanPhone10 = normalizePhoneForCoupon(customerPhone);
  let customerUsed = 0;

  if (cleanEmail || (cleanPhone10 && cleanPhone10.length >= 10)) {
    for (const r of rows) {
      const rowEmail = String(r.customer_email || '').trim().toLowerCase();
      const rowPhone10 = normalizePhoneForCoupon(r.customer_phone);
      const emailMatch = Boolean(cleanEmail && rowEmail && rowEmail === cleanEmail);
      const phoneMatch = Boolean(cleanPhone10 && cleanPhone10.length >= 10 && rowPhone10 && rowPhone10 === cleanPhone10);
      if (emailMatch || phoneMatch) {
        customerUsed += 1;
      }
    }
  }

  return { totalUsed, customerUsed };
}

/**
 * Evaluates a coupon row's live lifecycle status, IST schedule window, total usage cap, per-customer cap, and optional subtotal requirement.
 */
function evaluateCouponStatus(db, coupon, {
  subtotalPaise = null,
  customerEmail = '',
  customerPhone = '',
  nowIst = null
} = {}) {
  if (!coupon) {
    return {
      valid: false,
      status: 'INVALID',
      message: 'Coupon code is invalid.',
      totalUsed: 0,
      customerUsed: 0,
      effectiveMaxTotalUses: 0,
      effectiveMaxUsesPerCustomer: 0
    };
  }

  const currentIst = nowIst || getCurrentIstIsoMinute();
  const usageType = VALID_COUPON_USAGE_TYPES.includes(String(coupon.usage_type || '').toUpperCase())
    ? String(coupon.usage_type).toUpperCase()
    : 'UNIVERSAL';
  const effectiveMaxTotalUses = usageType === 'SINGLE_USE_GLOBAL'
    ? 1
    : Math.max(0, Number(coupon.max_total_uses) || 0);
  const effectiveMaxUsesPerCustomer = usageType === 'ONCE_PER_CUSTOMER'
    ? Math.max(1, Number(coupon.max_uses_per_customer) || 1)
    : Math.max(0, Number(coupon.max_uses_per_customer) || 0);

  const { totalUsed, customerUsed } = getCouponUsageStats(db, coupon.code, {
    customerEmail,
    customerPhone
  });

  if (!Number(coupon.is_active)) {
    return {
      valid: false,
      status: 'PAUSED',
      message: `Coupon "${coupon.code}" is currently paused or inactive.`,
      totalUsed,
      customerUsed,
      effectiveMaxTotalUses,
      effectiveMaxUsesPerCustomer
    };
  }

  const startsAtIst = String(coupon.starts_at_ist || '').trim();
  if (startsAtIst && currentIst < startsAtIst) {
    return {
      valid: false,
      status: 'SCHEDULED',
      message: `Coupon "${coupon.code}" is scheduled to start on ${startsAtIst.replace('T', ' ')} IST.`,
      totalUsed,
      customerUsed,
      effectiveMaxTotalUses,
      effectiveMaxUsesPerCustomer
    };
  }

  const expiresAtIst = String(coupon.expires_at_ist || '').trim();
  if (expiresAtIst && currentIst > expiresAtIst) {
    return {
      valid: false,
      status: 'EXPIRED',
      message: `Coupon "${coupon.code}" expired on ${expiresAtIst.replace('T', ' ')} IST.`,
      totalUsed,
      customerUsed,
      effectiveMaxTotalUses,
      effectiveMaxUsesPerCustomer
    };
  }

  if (effectiveMaxTotalUses > 0 && totalUsed >= effectiveMaxTotalUses) {
    return {
      valid: false,
      status: 'LIMIT_REACHED',
      message: `Coupon "${coupon.code}" has reached its maximum redemption limit (${effectiveMaxTotalUses}/${effectiveMaxTotalUses} used).`,
      totalUsed,
      customerUsed,
      effectiveMaxTotalUses,
      effectiveMaxUsesPerCustomer
    };
  }

  if (effectiveMaxUsesPerCustomer > 0 && customerUsed >= effectiveMaxUsesPerCustomer) {
    return {
      valid: false,
      status: 'CUSTOMER_LIMIT_REACHED',
      message: `Coupon "${coupon.code}" has already been used on a previous order for this email or phone number (limit: ${effectiveMaxUsesPerCustomer} per customer).`,
      totalUsed,
      customerUsed,
      effectiveMaxTotalUses,
      effectiveMaxUsesPerCustomer
    };
  }

  if (subtotalPaise !== null && subtotalPaise !== undefined && subtotalPaise < Number(coupon.min_order_paise || 0)) {
    return {
      valid: false,
      status: 'MIN_SUBTOTAL_NOT_MET',
      message: `Coupon "${coupon.code}" requires a minimum subtotal of Rs. ${(Number(coupon.min_order_paise) / 100).toFixed(0)}.`,
      totalUsed,
      customerUsed,
      effectiveMaxTotalUses,
      effectiveMaxUsesPerCustomer
    };
  }

  return {
    valid: true,
    status: 'ACTIVE',
    message: '',
    totalUsed,
    customerUsed,
    effectiveMaxTotalUses,
    effectiveMaxUsesPerCustomer
  };
}

/**
 * Lists all coupons enriched with live computed status, IST window evaluation, and finalized redemption counts.
 */
function listEnrichedCoupons(nowIst = null) {
  const db = getDb();
  const currentIst = nowIst || getCurrentIstIsoMinute();
  const rows = db.prepare('SELECT * FROM coupons ORDER BY is_auto_apply DESC, is_active DESC, code ASC').all();
  return rows.map(c => {
    const evalRes = evaluateCouponStatus(db, c, { nowIst: currentIst });
    return {
      ...c,
      usage_type: VALID_COUPON_USAGE_TYPES.includes(String(c.usage_type || '').toUpperCase())
        ? String(c.usage_type).toUpperCase()
        : 'UNIVERSAL',
      visibility: VALID_COUPON_VISIBILITIES.includes(String(c.visibility || '').toUpperCase())
        ? String(c.visibility).toUpperCase()
        : 'PUBLIC_CHIP',
      is_auto_apply: Number(c.is_auto_apply) ? 1 : 0,
      is_active: Number(c.is_active) ? 1 : 0,
      computed_status: evalRes.status,
      status_message: evalRes.message,
      total_used: evalRes.totalUsed,
      effective_max_total_uses: evalRes.effectiveMaxTotalUses,
      effective_max_uses_per_customer: evalRes.effectiveMaxUsesPerCustomer
    };
  });
}

/**
 * Creates or updates a promotional coupon in the coupons table and records an immutable audit log entry.
 */
function upsertAdminCoupon(payload = {}, actor = {}) {
  const db = getDb();
  const rawCode = String(payload.code || '')
    .trim()
    .toUpperCase();

  if (!/^[A-Z0-9_-]{3,24}$/.test(rawCode)) {
    throw new Error('Coupon code must be 3 to 24 alphanumeric characters (A-Z, 0-9, hyphen, or underscore) without spaces or special symbols.');
  }
  const cleanCode = rawCode;

  const rawDesc = String(payload.description || '')
    .replace(/[\u2013\u2014]/g, '-')
    .trim();
  if (!rawDesc) {
    throw new Error('Coupon description is required.');
  }
  const lintCheck = lintContentText(`${cleanCode} ${rawDesc}`, `coupon_${cleanCode}`);
  if (!lintCheck.valid) {
    throw new Error(lintCheck.issues.join(' '));
  }

  const rawType = String(payload.discountType || payload.discount_type || 'PERCENT').trim().toUpperCase();
  const discountType = (rawType === 'FLAT_PAISE' || rawType === 'FLAT_INR' || rawType === 'FLAT')
    ? 'FLAT_PAISE'
    : (rawType === 'PERCENT' ? 'PERCENT' : '');
  if (!discountType) {
    throw new Error('Invalid discountType. Must be PERCENT or FLAT_PAISE.');
  }

  let discountValue = 0;
  if (discountType === 'PERCENT') {
    const rawPct = payload.discountValueInr !== undefined ? payload.discountValueInr : (payload.discountValue ?? payload.discount_value);
    discountValue = Math.round(Number(rawPct));
    if (!Number.isFinite(discountValue) || discountValue < 1 || discountValue > 90) {
      throw new Error('Percentage discount value must be between 1% and 90%.');
    }
  } else {
    if (payload.discountValuePaise !== undefined) {
      discountValue = Math.round(Number(payload.discountValuePaise));
    } else if (payload.discountValueInr !== undefined) {
      discountValue = Math.round(Number(payload.discountValueInr) * 100);
    } else {
      const rawVal = Number(payload.discountValue ?? payload.discount_value);
      discountValue = rawType === 'FLAT_INR' || rawType === 'FLAT'
        ? Math.round(rawVal * 100)
        : Math.round(rawVal);
    }
    if (!Number.isFinite(discountValue) || discountValue < 100 || discountValue > 500000) {
      throw new Error('Flat discount amount must be between Rs. 1 and Rs. 5,000.');
    }
  }

  const minOrderPaise = payload.minOrderInr !== undefined
    ? Math.max(0, Math.round(Number(payload.minOrderInr) * 100))
    : Math.max(0, Math.round(Number(payload.minOrderPaise ?? payload.min_order_paise ?? 0)));
  if (!Number.isFinite(minOrderPaise) || minOrderPaise < 0) {
    throw new Error('Minimum order subtotal must be a non-negative amount.');
  }
  if (discountType === 'FLAT_PAISE' && minOrderPaise < discountValue) {
    throw new Error('Minimum order subtotal for a flat discount coupon must be at least equal to the flat discount amount.');
  }

  let maxDiscountPaise = payload.maxDiscountInr !== undefined
    ? Math.max(0, Math.round(Number(payload.maxDiscountInr) * 100))
    : Math.max(0, Math.round(Number(payload.maxDiscountPaise ?? payload.max_discount_paise ?? 0)));
  if (!Number.isFinite(maxDiscountPaise) || maxDiscountPaise < 0) {
    throw new Error('Maximum discount cap must be a non-negative amount.');
  }
  if (discountType === 'FLAT_PAISE') {
    maxDiscountPaise = discountValue;
  } else if (maxDiscountPaise === 0) {
    maxDiscountPaise = 500000; // Default Rs. 5,000 cap when 0 / uncapped is entered for PERCENT
  }

  const rawUsageType = String(payload.usageType || payload.usage_type || 'UNIVERSAL').trim().toUpperCase();
  if (!VALID_COUPON_USAGE_TYPES.includes(rawUsageType)) {
    throw new Error(`Invalid usageType "${rawUsageType}". Must be UNIVERSAL, ONCE_PER_CUSTOMER, or SINGLE_USE_GLOBAL.`);
  }

  let maxTotalUses = Math.max(0, Math.round(Number(payload.maxTotalUses ?? payload.max_total_uses ?? 0) || 0));
  let maxUsesPerCustomer = Math.max(0, Math.round(Number(payload.maxUsesPerCustomer ?? payload.max_uses_per_customer ?? 0) || 0));
  if (rawUsageType === 'SINGLE_USE_GLOBAL') {
    maxTotalUses = 1;
    maxUsesPerCustomer = 1;
  } else if (rawUsageType === 'ONCE_PER_CUSTOMER') {
    maxUsesPerCustomer = Math.max(1, maxUsesPerCustomer || 1);
  }

  const startsAtIst = normalizeIstDateTimeInput(payload.startsAtIst ?? payload.starts_at_ist ?? '', false);
  const expiresAtIst = normalizeIstDateTimeInput(payload.expiresAtIst ?? payload.expires_at_ist ?? '', true);
  if (startsAtIst && expiresAtIst && startsAtIst >= expiresAtIst) {
    throw new Error(`Coupon expiry time (${expiresAtIst} IST) must be after start time (${startsAtIst} IST).`);
  }

  const rawVisibility = String(payload.visibility || 'PUBLIC_CHIP').trim().toUpperCase();
  const visibility = VALID_COUPON_VISIBILITIES.includes(rawVisibility) ? rawVisibility : 'PUBLIC_CHIP';
  const isAutoApply = (payload.isAutoApply === true || payload.isAutoApply === 1 || payload.isAutoApply === '1' || payload.is_auto_apply === 1 || payload.is_auto_apply === true) ? 1 : 0;
  const isActive = (payload.isActive === undefined && payload.is_active === undefined)
    ? 1
    : ((payload.isActive === true || payload.isActive === 1 || payload.isActive === '1' || payload.is_active === 1 || payload.is_active === true) ? 1 : 0);

  const existing = db.prepare('SELECT code FROM coupons WHERE code = ?').get(cleanCode);

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    if (isAutoApply === 1) {
      db.prepare('UPDATE coupons SET is_auto_apply = 0 WHERE code != ?').run(cleanCode);
    }

    if (existing) {
      db.prepare(`
        UPDATE coupons
        SET description = ?,
            discount_type = ?,
            discount_value = ?,
            min_order_paise = ?,
            max_discount_paise = ?,
            usage_type = ?,
            max_total_uses = ?,
            max_uses_per_customer = ?,
            starts_at_ist = ?,
            expires_at_ist = ?,
            visibility = ?,
            is_auto_apply = ?,
            is_active = ?,
            updated_at = datetime('now')
        WHERE code = ?
      `).run(
        rawDesc,
        discountType,
        discountValue,
        minOrderPaise,
        maxDiscountPaise,
        rawUsageType,
        maxTotalUses,
        maxUsesPerCustomer,
        startsAtIst,
        expiresAtIst,
        visibility,
        isAutoApply,
        isActive,
        cleanCode
      );
    } else {
      db.prepare(`
        INSERT INTO coupons (
          code, description, discount_type, discount_value, min_order_paise, max_discount_paise,
          usage_type, max_total_uses, max_uses_per_customer, starts_at_ist, expires_at_ist,
          visibility, is_auto_apply, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        cleanCode,
        rawDesc,
        discountType,
        discountValue,
        minOrderPaise,
        maxDiscountPaise,
        rawUsageType,
        maxTotalUses,
        maxUsesPerCustomer,
        startsAtIst,
        expiresAtIst,
        visibility,
        isAutoApply,
        isActive
      );
    }

    db.prepare(`
      INSERT INTO audit_logs (actor_id, actor_email, actor_role, action, entity_type, entity_id, details_json)
      VALUES (?, ?, ?, ?, 'COUPON', ?, ?)
    `).run(
      actor.actorId || null,
      actor.actorEmail || 'superadmin@sashyanaturals.com',
      actor.actorRole || 'SUPER_ADMIN',
      existing ? 'COUPON_UPDATED' : 'COUPON_CREATED',
      cleanCode,
      JSON.stringify({
        code: cleanCode,
        discountType,
        discountValue,
        minOrderPaise,
        maxDiscountPaise,
        usageType: rawUsageType,
        maxTotalUses,
        maxUsesPerCustomer,
        startsAtIst,
        expiresAtIst,
        visibility,
        isAutoApply,
        isActive
      })
    );

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return listEnrichedCoupons().find(c => c.code === cleanCode);
}

/**
 * Toggles a coupon's active/paused state (or auto-apply flag) and logs the change.
 */
function toggleAdminCouponActive(code, isActive, actor = {}) {
  const db = getDb();
  const cleanCode = String(code || '').trim().toUpperCase();
  const existing = db.prepare('SELECT * FROM coupons WHERE code = ?').get(cleanCode);
  if (!existing) {
    throw new Error(`Coupon "${cleanCode}" not found.`);
  }
  const nextActive = (isActive === true || isActive === 1 || isActive === '1') ? 1 : 0;
  db.prepare("UPDATE coupons SET is_active = ?, updated_at = datetime('now') WHERE code = ?").run(nextActive, cleanCode);
  db.prepare(`
    INSERT INTO audit_logs (actor_id, actor_email, actor_role, action, entity_type, entity_id, details_json)
    VALUES (?, ?, ?, 'COUPON_STATUS_TOGGLED', 'COUPON', ?, ?)
  `).run(
    actor.actorId || null,
    actor.actorEmail || 'superadmin@sashyanaturals.com',
    actor.actorRole || 'SUPER_ADMIN',
    cleanCode,
    JSON.stringify({ code: cleanCode, isActive: nextActive })
  );
  return listEnrichedCoupons().find(c => c.code === cleanCode);
}

/**
 * Deletes a coupon code from the coupons table and records an audit log entry.
 */
function deleteAdminCoupon(code, actor = {}) {
  const db = getDb();
  const cleanCode = String(code || '').trim().toUpperCase();
  const existing = db.prepare('SELECT * FROM coupons WHERE code = ?').get(cleanCode);
  if (!existing) {
    throw new Error(`Coupon "${cleanCode}" not found.`);
  }
  db.prepare('DELETE FROM coupons WHERE code = ?').run(cleanCode);

  // Unlink deleted coupon from content_hellobar_json if it was linked
  const hbRow = db.prepare("SELECT value FROM store_settings WHERE key = 'content_hellobar_json'").get();
  if (hbRow && hbRow.value) {
    try {
      const hbObj = JSON.parse(hbRow.value);
      if (hbObj && String(hbObj.linkedCouponCode || '').toUpperCase() === cleanCode) {
        hbObj.linkedCouponCode = '';
        db.prepare(
          "INSERT OR REPLACE INTO store_settings (key, value, updated_at) VALUES ('content_hellobar_json', ?, datetime('now'))"
        ).run(JSON.stringify(hbObj));
      }
    } catch {
      // ignore malformed JSON
    }
  }

  db.prepare(`
    INSERT INTO audit_logs (actor_id, actor_email, actor_role, action, entity_type, entity_id, details_json)
    VALUES (?, ?, ?, 'COUPON_DELETED', 'COUPON', ?, ?)
  `).run(
    actor.actorId || null,
    actor.actorEmail || 'superadmin@sashyanaturals.com',
    actor.actorRole || 'SUPER_ADMIN',
    cleanCode,
    JSON.stringify({ code: cleanCode })
  );
  return { deleted: true, code: cleanCode };
}

/**
 * Deterministically calculates cart totals in integer paise via Rust WASM Core + database variant prices.
 */
function calculateCartPricing(
  items = [],
  couponCode = '',
  paymentMethod = 'ONLINE_UPI',
  shippingState = 'Karnataka',
  shippingPincode = '560001',
  customerContext = {}
) {
  const db = getDb();
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Cart is empty. Please add at least one product pack.');
  }
  const cleanShipPin = String(shippingPincode || '560001').trim();
  if (!/^[1-8]\d{5}$/.test(cleanShipPin)) {
    throw new Error(`PIN code "${cleanShipPin}" is not a valid 6-digit Indian PIN code.`);
  }
  shippingPincode = cleanShipPin;

  // Consolidate duplicate variantId rows so combined quantity is validated against available stock (EC-001 / EC-002)
  const consolidatedMap = new Map();
  for (const rawItem of items) {
    const variantId = Number(rawItem && rawItem.variantId);
    const qty = Math.max(1, Math.min(50, Math.floor(Number((rawItem && rawItem.quantity) || 1))));
    if (!Number.isFinite(variantId) || variantId <= 0) {
      throw new Error('Invalid product variant selection.');
    }
    consolidatedMap.set(variantId, Math.min(50, (consolidatedMap.get(variantId) || 0) + qty));
  }

  const variantStmt = db.prepare(`
    SELECT
      v.id AS variant_id,
      v.product_id,
      v.sku,
      v.pack_label,
      v.weight_grams,
      v.mrp_paise,
      v.selling_price_paise,
      v.promo_price_paise,
      v.stock_qty,
      v.low_stock_threshold,
      v.is_active AS variant_active,
      p.name AS product_name,
      p.slug AS product_slug,
      p.gst_percent,
      p.hsn_code,
      p.image_url,
      p.is_active AS product_active,
      p.pincode_restriction_mode,
      p.pincode_rules_json
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    WHERE v.id = ?
  `);

  let subtotalPaise = 0;
  let mrpTotalPaise = 0;
  let rawGstPaise = 0;
  let totalWeightGrams = 0;
  const lineItems = [];
  const unserviceableItems = [];
  const codRestrictedItems = [];

  for (const [variantId, quantity] of consolidatedMap.entries()) {
    const row = variantStmt.get(variantId);
    if (!row || !row.variant_active || !row.product_active) {
      throw new Error(`Product variant #${variantId} is unavailable.`);
    }
    if (row.stock_qty < quantity) {
      throw new Error(`Insufficient stock for ${row.product_name} (${row.pack_label}). Available: ${row.stock_qty}.`);
    }

    const unitPricePaise = row.promo_price_paise && row.promo_price_paise > 0
      ? row.promo_price_paise
      : row.selling_price_paise;
    const lineTotalPaise = wasmLineTotalPaise(unitPricePaise, quantity);
    const lineMrpPaise = wasmLineTotalPaise(row.mrp_paise, quantity);
    const lineGstPaise = wasmInclusiveGstPaise(lineTotalPaise, row.gst_percent);

    const pinEval = evaluateProductPincodeServiceability(row, shippingPincode, paymentMethod);

    subtotalPaise += lineTotalPaise;
    mrpTotalPaise += lineMrpPaise;
    rawGstPaise += lineGstPaise;
    totalWeightGrams += row.weight_grams * quantity;

    const lineItemObj = {
      productId: row.product_id,
      variantId: row.variant_id,
      productName: row.product_name,
      productSlug: row.product_slug,
      imageUrl: row.image_url,
      sku: row.sku,
      hsnCode: row.hsn_code || '080290',
      packLabel: row.pack_label,
      weightGrams: row.weight_grams,
      unitPricePaise,
      mrpPaise: row.mrp_paise,
      gstPercent: row.gst_percent,
      quantity,
      stockQty: row.stock_qty,
      lowStockThreshold: row.low_stock_threshold || 10,
      lineTotalPaise,
      lineGstPaise,
      pincodeServiceable: pinEval.serviceable,
      deliverablePrepaid: pinEval.deliverablePrepaid,
      codAllowedForProduct: pinEval.codAllowedForProduct,
      pincodeRestricted: pinEval.restricted,
      pincodeRestrictionMode: pinEval.mode,
      pincodeRestrictionScope: pinEval.scope,
      pincodeRestrictionReason: pinEval.reason
    };

    lineItems.push(lineItemObj);

    if (!pinEval.deliverablePrepaid) {
      unserviceableItems.push({
        productId: row.product_id,
        variantId: row.variant_id,
        productName: row.product_name,
        packLabel: row.pack_label,
        reason: pinEval.reason
      });
    } else if (!pinEval.codAllowedForProduct) {
      codRestrictedItems.push({
        productId: row.product_id,
        variantId: row.variant_id,
        productName: row.product_name,
        packLabel: row.pack_label,
        reason: pinEval.reason
      });
    }
  }

  let discountPaise = 0;
  let appliedCoupon = '';
  let couponMessage = '';
  let couponStatus = 'NONE';
  const cleanCode = String(couponCode || '').trim().toUpperCase();

  if (cleanCode) {
    const coupon = db.prepare('SELECT * FROM coupons WHERE code = ?').get(cleanCode);
    if (!coupon) {
      couponStatus = 'INVALID';
      couponMessage = `Coupon "${cleanCode}" is invalid or expired.`;
    } else {
      const evalRes = evaluateCouponStatus(db, coupon, {
        subtotalPaise,
        customerEmail: customerContext && customerContext.customerEmail ? customerContext.customerEmail : '',
        customerPhone: customerContext && customerContext.customerPhone ? customerContext.customerPhone : '',
        nowIst: customerContext && customerContext.nowIst ? customerContext.nowIst : null
      });
      couponStatus = evalRes.status;
      if (!evalRes.valid) {
        couponMessage = evalRes.message;
      } else {
        discountPaise = wasmCouponDiscountPaise(
          subtotalPaise,
          coupon.discount_type,
          coupon.discount_value,
          coupon.min_order_paise,
          coupon.max_discount_paise
        );
        appliedCoupon = coupon.code;
        couponMessage = `Coupon ${coupon.code} applied (-Rs. ${(discountPaise / 100).toFixed(2)}).`;
      }
    }
  }

  const discountedSubtotalPaise = Math.max(0, subtotalPaise - discountPaise);
  const gstPaise = subtotalPaise > 0
    ? Math.round(rawGstPaise * (discountedSubtotalPaise / subtotalPaise))
    : 0;

  const gstSplit = computeStateGstSplit(gstPaise, shippingState, shippingPincode);

  // 4-Zone + 500g Weight-Slab + Free-Delivery Toggle/Threshold/Weight-Cap calculation via Rust WASM
  const shipPolicy = getShippingPolicyFromDb();
  const zoneInfo = resolveShippingZone(shippingPincode, shipPolicy);
  const isCod = paymentMethod === 'COD';
  const grossWeightGrams = totalWeightGrams + shipPolicy.packagingTareGrams;
  const billable500gSlabs = wasmBillable500gSlabs(totalWeightGrams, shipPolicy.packagingTareGrams);

  const rawZoneFreightPaise = wasmZoneWeightShippingPaise({
    discountedSubtotalPaise,
    totalProductGrams: totalWeightGrams,
    packagingTareGrams: shipPolicy.packagingTareGrams,
    base500gPaise: zoneInfo.base500gPaise,
    extra500gPaise: zoneInfo.extra500gPaise,
    freeModeCode: 0, // raw freight before free-delivery rule
    freeThresholdPaise: shipPolicy.freeThresholdPaise,
    freeMaxWeightGrams: shipPolicy.freeMaxWeightGrams,
    isCod: false,
    codFeePaise: 0
  });

  const shippingPaise = wasmZoneWeightShippingPaise({
    discountedSubtotalPaise,
    totalProductGrams: totalWeightGrams,
    packagingTareGrams: shipPolicy.packagingTareGrams,
    base500gPaise: zoneInfo.base500gPaise,
    extra500gPaise: zoneInfo.extra500gPaise,
    freeModeCode: shipPolicy.freeModeCode,
    freeThresholdPaise: shipPolicy.freeThresholdPaise,
    freeMaxWeightGrams: shipPolicy.freeMaxWeightGrams,
    isCod,
    codFeePaise: shipPolicy.codFeePaise
  });

  const codFeeAppliedPaise = isCod ? shipPolicy.codFeePaise : 0;
  const freightPaise = Math.max(0, shippingPaise - codFeeAppliedPaise);
  const freeShippingApplied = freightPaise === 0 && rawZoneFreightPaise > 0;

  const totalPaise = wasmOrderTotalPaise(subtotalPaise, discountPaise, shippingPaise);
  const codAllowedByCap = totalPaise <= PAYMENT_CONFIG.maxCodOrderPaise;

  if (paymentMethod === 'COD' && !codAllowedByCap) {
    throw new Error(`Cash on Delivery is available for orders up to Rs. ${(PAYMENT_CONFIG.maxCodOrderPaise / 100).toFixed(0)}.`);
  }

  const codAllowed = codAllowedByCap && codRestrictedItems.length === 0;

  return {
    engine: 'rust-wasm-v1.2-zone-slab',
    lineItems,
    unserviceableItems,
    codRestrictedItems,
    allItemsServiceable: unserviceableItems.length === 0 && (paymentMethod !== 'COD' || codRestrictedItems.length === 0),
    mrpTotalPaise,
    subtotalPaise,
    discountPaise,
    discountedSubtotalPaise,
    gstPaise,
    taxSupplyType: gstSplit.taxSupplyType,
    cgstPaise: gstSplit.cgstPaise,
    sgstPaise: gstSplit.sgstPaise,
    igstPaise: gstSplit.igstPaise,
    shippingPaise,
    freightPaise,
    rawZoneFreightPaise,
    codFeePaise: codFeeAppliedPaise,
    shippingZone: zoneInfo.code,
    shippingZoneLabel: zoneInfo.label,
    totalWeightGrams,
    packagingTareGrams: shipPolicy.packagingTareGrams,
    grossWeightGrams,
    billable500gSlabs,
    freeShippingMode: shipPolicy.freeMode,
    freeShippingThresholdPaise: shipPolicy.freeThresholdPaise,
    freeShippingMaxWeightGrams: shipPolicy.freeMaxWeightGrams,
    freeShippingApplied,
    totalPaise,
    appliedCoupon,
    couponStatus,
    couponMessage,
    codAllowed,
    amountForFreeShippingPaise: shipPolicy.freeMode === 'DISABLED'
      ? 0
      : Math.max(0, shipPolicy.freeThresholdPaise - discountedSubtotalPaise)
  };
}

function assertCartPincodeServiceability(pricing, shippingPincode, paymentMethod = 'ONLINE_UPI') {
  if (!pricing) return;
  if (Array.isArray(pricing.unserviceableItems) && pricing.unserviceableItems.length > 0) {
    const details = pricing.unserviceableItems
      .map(it => `"${it.productName}" (${it.reason})`)
      .join('; ');
    throw new Error(`Delivery to PIN code ${shippingPincode} is restricted for: ${details}`);
  }
  if (paymentMethod === 'COD' && Array.isArray(pricing.codRestrictedItems) && pricing.codRestrictedItems.length > 0) {
    const details = pricing.codRestrictedItems
      .map(it => `"${it.productName}" (${it.reason})`)
      .join('; ');
    throw new Error(
      `Cash on Delivery at PIN code ${shippingPincode} is unavailable for: ${details}. Please choose UPI, Card, or Net Banking.`
    );
  }
}

function allocateNextOrderNumber(db) {
  const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId, COUNT(*) AS cnt FROM orders').get();
  let candidateSeq = 1000 + Math.max(Number(row ? row.maxId : 0), Number(row ? row.cnt : 0)) + 1;
  while (db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`SN-2026-${candidateSeq}`)) {
    candidateSeq += 1;
  }
  return `SN-2026-${candidateSeq}`;
}

function createOrder({
  userId = null,
  customerName,
  customerEmail,
  customerPhone,
  shippingLine1,
  shippingLine2 = '',
  shippingCity,
  shippingState,
  shippingPincode,
  deliveryInstructions = '',
  items,
  couponCode = '',
  paymentMethod = 'ONLINE_UPI',
  codOtpCode = '',
  requireCodOtp = false
}) {
  const cleanName = String(customerName || '').trim();
  const cleanEmail = String(customerEmail || '').trim();
  const cleanPhone = String(customerPhone || '').trim();
  const cleanLine1 = String(shippingLine1 || '').trim();
  const cleanCity = String(shippingCity || '').trim();
  const cleanState = String(shippingState || '').trim();
  const cleanPincode = String(shippingPincode || '').trim();

  if (!cleanName || !cleanEmail || !cleanPhone || !cleanLine1 || !cleanCity || !cleanState || !cleanPincode) {
    throw new Error('Please complete all required customer contact and Indian delivery address fields.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error('Please provide a valid customer email address.');
  }
  const phoneDigits = cleanPhone.replace(/\D/g, '');
  if (phoneDigits.length < 10 || phoneDigits.length > 15 || !/^[6-9]\d{9}$/.test(phoneDigits.slice(-10))) {
    throw new Error('Please provide a valid 10-digit Indian mobile phone number.');
  }

  // Validate PIN code serviceability & high-RTO COD rules
  validatePincodeServiceability(cleanPincode, paymentMethod);

  const validMethods = ['ONLINE_UPI', 'ONLINE_CARD', 'ONLINE_NETBANKING', 'COD'];
  if (!validMethods.includes(paymentMethod)) {
    throw new Error(`Unsupported payment method: ${paymentMethod}`);
  }

  const isCod = paymentMethod === 'COD';
  let codOtpVerified = 0;

  if (isCod) {
    if (codOtpCode) {
      verifyCodOtp(cleanPhone, codOtpCode);
      codOtpVerified = 1;
    } else if (isPhoneCodVerified(cleanPhone)) {
      codOtpVerified = 1;
    } else if (requireCodOtp) {
      throw new Error('Cash on Delivery requires 6-digit Mobile OTP verification to prevent RTO fraud.');
    }
  }

  const pricing = calculateCartPricing(items, couponCode, paymentMethod, cleanState, cleanPincode, {
    customerEmail: cleanEmail,
    customerPhone: cleanPhone
  });
  const explicitCoupon = String(couponCode || '').trim();
  if (explicitCoupon && ['INVALID', 'MIN_SUBTOTAL_NOT_MET', 'EXPIRED', 'SCHEDULED', 'LIMIT_REACHED', 'CUSTOMER_LIMIT_REACHED', 'PAUSED'].includes(pricing.couponStatus)) {
    throw new Error(pricing.couponMessage || `Coupon "${explicitCoupon}" cannot be applied to this order.`);
  }
  assertCartPincodeServiceability(pricing, cleanPincode, paymentMethod);
  const db = getDb();

  const orderNumber = allocateNextOrderNumber(db);
  const gatewayOrderId = isCod
    ? `cod_${orderNumber.replace(/-/g, '')}`
    : `order_rzp_${orderNumber.replace(/-/g, '')}_${crypto.randomBytes(3).toString('hex')}`;

  const paymentStatus = isCod ? 'COD_PENDING' : 'PENDING_PAYMENT';
  const fulfilmentStatus = isCod ? 'Confirmed' : 'Pending Payment';

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    if (pricing.appliedCoupon) {
      const lockedCoupon = db.prepare('SELECT * FROM coupons WHERE code = ?').get(pricing.appliedCoupon);
      const lockedEval = evaluateCouponStatus(db, lockedCoupon, {
        subtotalPaise: pricing.subtotalPaise,
        customerEmail: cleanEmail,
        customerPhone: cleanPhone
      });
      if (!lockedEval.valid) {
        throw new Error(lockedEval.message);
      }
    }
    const insertOrderStmt = db.prepare(`
      INSERT INTO orders (
        order_number, user_id, customer_name, customer_email, customer_phone,
        shipping_line1, shipping_line2, shipping_city, shipping_state, shipping_pincode,
        delivery_instructions, subtotal_paise, discount_paise, gst_paise,
        tax_supply_type, cgst_paise, sgst_paise, igst_paise,
        shipping_paise, total_paise, coupon_code, payment_method, payment_status, fulfilment_status,
        gateway_order_id, stock_deducted, cod_otp_verified
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const ordResult = insertOrderStmt.run(
      orderNumber,
      userId,
      cleanName,
      cleanEmail,
      cleanPhone,
      cleanLine1,
      String(shippingLine2 || '').trim(),
      cleanCity,
      cleanState,
      cleanPincode,
      String(deliveryInstructions || '').trim(),
      pricing.subtotalPaise,
      pricing.discountPaise,
      pricing.gstPaise,
      pricing.taxSupplyType,
      pricing.cgstPaise,
      pricing.sgstPaise,
      pricing.igstPaise,
      pricing.shippingPaise,
      pricing.totalPaise,
      pricing.appliedCoupon,
      paymentMethod,
      paymentStatus,
      fulfilmentStatus,
      gatewayOrderId,
      isCod ? 1 : 0,
      codOtpVerified
    );
    const orderId = Number(ordResult.lastInsertRowid);

    const insertItemStmt = db.prepare(`
      INSERT INTO order_items (
        order_id, product_id, variant_id, product_name, sku, hsn_code, pack_label,
        weight_grams, unit_price_paise, mrp_paise, gst_percent, quantity, line_total_paise
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const deductStockStmt = db.prepare(`
      UPDATE product_variants
      SET stock_qty = stock_qty - ?
      WHERE id = ? AND stock_qty >= ?
    `);

    const insertMovementStmt = db.prepare(`
      INSERT INTO inventory_movements (
        variant_id, delta_qty, previous_qty, new_qty, reason, reference_id, actor_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of pricing.lineItems) {
      insertItemStmt.run(
        orderId,
        item.productId,
        item.variantId,
        item.productName,
        item.sku,
        item.hsnCode,
        item.packLabel,
        item.weightGrams,
        item.unitPricePaise,
        item.mrpPaise,
        item.gstPercent,
        item.quantity,
        item.lineTotalPaise
      );

      if (isCod) {
        const res = deductStockStmt.run(item.quantity, item.variantId, item.quantity);
        if (res.changes !== 1) {
          throw new Error(`Stock race condition detected for ${item.productName} (${item.packLabel}).`);
        }
        const remainingStock = item.stockQty - item.quantity;
        insertMovementStmt.run(
          item.variantId,
          -item.quantity,
          item.stockQty,
          remainingStock,
          'ORDER_PLACED_COD',
          orderNumber,
          cleanName
        );
        if (remainingStock <= item.lowStockThreshold) {
          db.prepare(`
            INSERT INTO notification_logs (order_number, channel, recipient, event_type, subject, body_preview)
            VALUES (?, 'ADMIN_ALERT', 'catalog@sashyanaturals.com', 'LOW_STOCK_ALERT', ?, ?)
          `).run(
            orderNumber,
            `Low Stock Alert: ${item.sku} (${remainingStock} remaining)`,
            `${item.productName} (${item.packLabel}) dropped to ${remainingStock} units.`
          );
        }
      }
    }

    db.prepare(`
      INSERT INTO payments (
        order_id, order_number, gateway_provider, gateway_order_id, method, amount_paise, status, verified_on_server
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      orderNumber,
      isCod ? 'cod_manual' : PAYMENT_CONFIG.provider,
      gatewayOrderId,
      paymentMethod,
      pricing.totalPaise,
      paymentStatus,
      isCod ? 1 : 0
    );

    db.prepare(`
      INSERT INTO notification_logs (order_number, channel, recipient, event_type, subject, body_preview)
      VALUES (?, 'EMAIL', ?, ?, ?, ?)
    `).run(
      orderNumber,
      cleanEmail,
      isCod ? 'ORDER_CONFIRMED_COD' : 'ORDER_CREATED_AWAITING_PAYMENT',
      `Sashya Naturals Order ${orderNumber} (${fulfilmentStatus})`,
      `Order total Rs. ${(pricing.totalPaise / 100).toFixed(2)} via ${paymentMethod}. Tax Invoice: /orders/${orderNumber}/invoice`
    );

    db.exec('COMMIT;');

    return {
      orderId,
      orderNumber,
      paymentMethod,
      paymentStatus,
      fulfilmentStatus,
      gatewayOrderId,
      razorpayKeyId: getActiveRazorpayKeyId(),
      invoiceUrl: `/orders/${orderNumber}/invoice`,
      pricing,
      sandboxSignaturePreview: !isCod
        ? computeRazorpaySignature(gatewayOrderId, `pay_rzp_${orderNumber.replace(/-/g, '')}`)
        : null
    };
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function createAdminOrder({
  userId = null,
  customerName,
  customerEmail,
  customerPhone,
  shippingLine1,
  shippingLine2 = '',
  shippingCity,
  shippingState,
  shippingPincode,
  deliveryInstructions = '',
  items,
  couponCode = '',
  paymentMethod = 'ONLINE_UPI',
  paymentStatus = null,
  gatewayPaymentId = '',
  actorId = null,
  actorEmail = 'superadmin@sashyanaturals.com',
  actorRole = 'SUPER_ADMIN'
}) {
  const cleanName = String(customerName || '').trim();
  const cleanEmail = String(customerEmail || '').trim();
  const cleanPhone = String(customerPhone || '').trim();
  const cleanLine1 = String(shippingLine1 || '').trim();
  const cleanCity = String(shippingCity || '').trim();
  const cleanState = String(shippingState || '').trim();
  const cleanPincode = String(shippingPincode || '').trim();

  if (!cleanName || !cleanEmail || !cleanPhone || !cleanLine1 || !cleanCity || !cleanState || !cleanPincode) {
    throw new Error('Please complete all required customer contact and Indian delivery address fields.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error('Please provide a valid customer email address.');
  }
  const adminOrdPhoneDigits = cleanPhone.replace(/\D/g, '');
  if (adminOrdPhoneDigits.length < 10 || adminOrdPhoneDigits.length > 15 || !/^[6-9]\d{9}$/.test(adminOrdPhoneDigits.slice(-10))) {
    throw new Error('Please provide a valid 10-digit Indian mobile phone number.');
  }

  validatePincodeServiceability(cleanPincode, paymentMethod);

  const validMethods = ['ONLINE_UPI', 'ONLINE_CARD', 'ONLINE_NETBANKING', 'COD'];
  if (!validMethods.includes(paymentMethod)) {
    throw new Error(`Unsupported payment method: ${paymentMethod}`);
  }

  const isCod = paymentMethod === 'COD';
  if (isCod && paymentStatus && !['COD_PENDING', 'COD_COLLECTED'].includes(paymentStatus)) {
    throw new Error(`Invalid payment status "${paymentStatus}" for Cash on Delivery (must be COD_PENDING or COD_COLLECTED).`);
  }
  if (!isCod && paymentStatus && !['PAID', 'PENDING_PAYMENT'].includes(paymentStatus)) {
    throw new Error(`Invalid payment status "${paymentStatus}" for Online Payment (must be PAID or PENDING_PAYMENT).`);
  }

  const pricing = calculateCartPricing(items, couponCode, paymentMethod, cleanState, cleanPincode, {
    customerEmail: cleanEmail,
    customerPhone: cleanPhone
  });
  const explicitCoupon = String(couponCode || '').trim();
  if (explicitCoupon && ['INVALID', 'MIN_SUBTOTAL_NOT_MET', 'EXPIRED', 'SCHEDULED', 'LIMIT_REACHED', 'CUSTOMER_LIMIT_REACHED', 'PAUSED'].includes(pricing.couponStatus)) {
    throw new Error(pricing.couponMessage || `Coupon "${explicitCoupon}" cannot be applied to this order.`);
  }
  assertCartPincodeServiceability(pricing, cleanPincode, paymentMethod);
  const db = getDb();

  let resolvedUserId = userId ? Number(userId) : null;
  if (!resolvedUserId && cleanEmail) {
    const existingCustomer = db
      .prepare("SELECT id FROM users WHERE lower(email) = lower(?) AND role = 'CUSTOMER' LIMIT 1")
      .get(cleanEmail);
    if (existingCustomer) {
      resolvedUserId = existingCustomer.id;
    }
  }

  let finalPaymentStatus;
  let fulfilmentStatus;
  let shouldDeductStock = false;

  if (isCod) {
    finalPaymentStatus = paymentStatus === 'COD_COLLECTED' ? 'COD_COLLECTED' : 'COD_PENDING';
    fulfilmentStatus = 'Confirmed';
    shouldDeductStock = true;
  } else {
    finalPaymentStatus = paymentStatus === 'PENDING_PAYMENT' ? 'PENDING_PAYMENT' : 'PAID';
    fulfilmentStatus = finalPaymentStatus === 'PAID' ? 'Confirmed' : 'Pending Payment';
    shouldDeductStock = finalPaymentStatus === 'PAID';
  }

  const orderNumber = allocateNextOrderNumber(db);
  const gatewayOrderId = isCod
    ? `cod_admin_${orderNumber.replace(/-/g, '')}`
    : `order_admin_${orderNumber.replace(/-/g, '')}_${crypto.randomBytes(2).toString('hex')}`;
  const cleanRef = String(gatewayPaymentId || '').trim().slice(0, 64);
  const finalGatewayPaymentId = cleanRef || (finalPaymentStatus === 'PAID' ? `utr_admin_${orderNumber.replace(/-/g, '')}` : '');

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    if (pricing.appliedCoupon) {
      const lockedCoupon = db.prepare('SELECT * FROM coupons WHERE code = ?').get(pricing.appliedCoupon);
      const lockedEval = evaluateCouponStatus(db, lockedCoupon, {
        subtotalPaise: pricing.subtotalPaise,
        customerEmail: cleanEmail,
        customerPhone: cleanPhone
      });
      if (!lockedEval.valid) {
        throw new Error(lockedEval.message);
      }
    }
    const insertOrderStmt = db.prepare(`
      INSERT INTO orders (
        order_number, user_id, customer_name, customer_email, customer_phone,
        shipping_line1, shipping_line2, shipping_city, shipping_state, shipping_pincode,
        delivery_instructions, subtotal_paise, discount_paise, gst_paise,
        tax_supply_type, cgst_paise, sgst_paise, igst_paise,
        shipping_paise, total_paise, coupon_code, payment_method, payment_status, fulfilment_status,
        gateway_order_id, gateway_payment_id, stock_deducted, cod_otp_verified
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const ordResult = insertOrderStmt.run(
      orderNumber,
      resolvedUserId,
      String(customerName).trim(),
      String(customerEmail).trim(),
      String(customerPhone).trim(),
      String(shippingLine1).trim(),
      String(shippingLine2 || '').trim(),
      String(shippingCity).trim(),
      String(shippingState).trim(),
      String(shippingPincode).trim(),
      String(deliveryInstructions || '').trim(),
      pricing.subtotalPaise,
      pricing.discountPaise,
      pricing.gstPaise,
      pricing.taxSupplyType,
      pricing.cgstPaise,
      pricing.sgstPaise,
      pricing.igstPaise,
      pricing.shippingPaise,
      pricing.totalPaise,
      pricing.appliedCoupon,
      paymentMethod,
      finalPaymentStatus,
      fulfilmentStatus,
      gatewayOrderId,
      finalGatewayPaymentId,
      shouldDeductStock ? 1 : 0,
      isCod ? 1 : 0
    );
    const orderId = Number(ordResult.lastInsertRowid);

    const insertItemStmt = db.prepare(`
      INSERT INTO order_items (
        order_id, product_id, variant_id, product_name, sku, hsn_code, pack_label,
        weight_grams, unit_price_paise, mrp_paise, gst_percent, quantity, line_total_paise
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const deductStockStmt = db.prepare(`
      UPDATE product_variants
      SET stock_qty = stock_qty - ?
      WHERE id = ? AND stock_qty >= ?
    `);

    const insertMovementStmt = db.prepare(`
      INSERT INTO inventory_movements (
        variant_id, delta_qty, previous_qty, new_qty, reason, reference_id, actor_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of pricing.lineItems) {
      insertItemStmt.run(
        orderId,
        item.productId,
        item.variantId,
        item.productName,
        item.sku,
        item.hsnCode,
        item.packLabel,
        item.weightGrams,
        item.unitPricePaise,
        item.mrpPaise,
        item.gstPercent,
        item.quantity,
        item.lineTotalPaise
      );

      if (shouldDeductStock) {
        const res = deductStockStmt.run(item.quantity, item.variantId, item.quantity);
        if (res.changes !== 1) {
          throw new Error(`Insufficient stock for ${item.productName} (${item.packLabel}).`);
        }
        const remainingStock = item.stockQty - item.quantity;
        insertMovementStmt.run(
          item.variantId,
          -item.quantity,
          item.stockQty,
          remainingStock,
          'ADMIN_MANUAL_ORDER',
          orderNumber,
          actorEmail
        );
        if (remainingStock <= item.lowStockThreshold) {
          db.prepare(`
            INSERT INTO notification_logs (order_number, channel, recipient, event_type, subject, body_preview)
            VALUES (?, 'ADMIN_ALERT', 'catalog@sashyanaturals.com', 'LOW_STOCK_ALERT', ?, ?)
          `).run(
            orderNumber,
            `Low Stock Alert: ${item.sku} (${remainingStock} remaining)`,
            `${item.productName} (${item.packLabel}) dropped to ${remainingStock} units.`
          );
        }
      }
    }

    db.prepare(`
      INSERT INTO payments (
        order_id, order_number, gateway_provider, gateway_order_id, gateway_payment_id, method, amount_paise, status, verified_on_server, cod_collected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      orderNumber,
      isCod ? 'cod_manual' : 'admin_manual_verified',
      gatewayOrderId,
      finalGatewayPaymentId,
      paymentMethod,
      pricing.totalPaise,
      finalPaymentStatus,
      (finalPaymentStatus === 'PAID' || finalPaymentStatus === 'COD_COLLECTED' || isCod) ? 1 : 0,
      finalPaymentStatus === 'COD_COLLECTED' ? new Date().toISOString() : ''
    );

    const invoiceUrl = `/orders/${orderNumber}/invoice`;

    db.prepare(`
      INSERT INTO notification_logs (order_number, channel, recipient, event_type, subject, body_preview)
      VALUES (?, 'EMAIL', ?, 'ADMIN_ORDER_CREATED_WITH_INVOICE', ?, ?)
    `).run(
      orderNumber,
      String(customerEmail).trim(),
      `Sashya Naturals Order ${orderNumber} & GST Tax Invoice (${fulfilmentStatus})`,
      `Manual order created by ${actorEmail}. Total Rs. ${(pricing.totalPaise / 100).toFixed(2)} (${finalPaymentStatus}). GST Invoice: ${invoiceUrl}`
    );

    db.prepare(`
      INSERT INTO audit_logs (actor_id, actor_email, actor_role, action, entity_type, entity_id, details_json)
      VALUES (?, ?, ?, 'ADMIN_ORDER_CREATED', 'ORDER', ?, ?)
    `).run(
      actorId,
      actorEmail,
      actorRole,
      orderNumber,
      JSON.stringify({
        customerName: String(customerName).trim(),
        customerEmail: String(customerEmail).trim(),
        shippingState: String(shippingState).trim(),
        shippingPincode: String(shippingPincode).trim(),
        itemCount: pricing.lineItems.length,
        totalPaise: pricing.totalPaise,
        taxSupplyType: pricing.taxSupplyType,
        paymentMethod,
        paymentStatus: finalPaymentStatus,
        fulfilmentStatus,
        invoiceUrl
      })
    );

    db.exec('COMMIT;');

    return {
      orderId,
      orderNumber,
      paymentMethod,
      paymentStatus: finalPaymentStatus,
      fulfilmentStatus,
      gatewayOrderId,
      gatewayPaymentId: finalGatewayPaymentId,
      invoiceUrl,
      pricing
    };
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function verifyAndCaptureOnlinePayment({
  orderNumber,
  gatewayOrderId,
  gatewayPaymentId,
  gatewaySignature
}) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber);
  if (!order) {
    throw new Error(`Order ${orderNumber} not found.`);
  }

  if (order.payment_status === 'PAID') {
    return {
      alreadyPaid: true,
      orderNumber: order.order_number,
      paymentStatus: order.payment_status,
      fulfilmentStatus: order.fulfilment_status
    };
  }

  if (order.payment_method === 'COD') {
    throw new Error(`Order ${orderNumber} is a Cash on Delivery order and cannot be captured via online gateway verification.`);
  }

  if (['Cancelled', 'Refunded', 'Refund Initiated'].includes(order.fulfilment_status) || ['REFUNDED', 'REFUND_INITIATED'].includes(order.payment_status)) {
    throw new Error(`Order ${orderNumber} has already been ${order.fulfilment_status} and cannot be captured.`);
  }

  if (order.gateway_order_id !== gatewayOrderId) {
    throw new Error('Gateway order ID mismatch.');
  }

  const isValid = verifyRazorpaySignature(gatewayOrderId, gatewayPaymentId, gatewaySignature);
  if (!isValid) {
    db.prepare(`
      UPDATE orders SET payment_status = 'FAILED', updated_at = datetime('now') WHERE id = ?
    `).run(order.id);
    db.prepare(`
      UPDATE payments SET status = 'FAILED', updated_at = datetime('now') WHERE order_id = ?
    `).run(order.id);
    throw new Error('Cryptographic payment signature verification failed (HMAC-SHA256 mismatch).');
  }

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    if (!order.stock_deducted) {
      const getVarStmt = db.prepare('SELECT stock_qty, low_stock_threshold FROM product_variants WHERE id = ?');
      const deductStmt = db.prepare('UPDATE product_variants SET stock_qty = stock_qty - ? WHERE id = ? AND stock_qty >= ?');
      const moveStmt = db.prepare(`
        INSERT INTO inventory_movements (variant_id, delta_qty, previous_qty, new_qty, reason, reference_id, actor_name)
        VALUES (?, ?, ?, ?, 'ONLINE_PAYMENT_VERIFIED', ?, 'Razorpay Server Verification')
      `);

      for (const item of items) {
        const vRow = getVarStmt.get(item.variant_id);
        const prevQty = vRow ? vRow.stock_qty : 0;
        const threshold = vRow ? vRow.low_stock_threshold : 10;
        const res = deductStmt.run(item.quantity, item.variant_id, item.quantity);
        if (res.changes !== 1) {
          throw new Error(`Insufficient stock while capturing order ${orderNumber} for SKU ${item.sku}.`);
        }
        const remaining = prevQty - item.quantity;
        moveStmt.run(item.variant_id, -item.quantity, prevQty, remaining, orderNumber);
        if (remaining <= threshold) {
          db.prepare(`
            INSERT INTO notification_logs (order_number, channel, recipient, event_type, subject, body_preview)
            VALUES (?, 'ADMIN_ALERT', 'catalog@sashyanaturals.com', 'LOW_STOCK_ALERT', ?, ?)
          `).run(
            orderNumber,
            `Low Stock Alert: ${item.sku} (${remaining} remaining)`,
            `${item.product_name} (${item.pack_label}) dropped to ${remaining} units.`
          );
        }
      }
    }

    db.prepare(`
      UPDATE orders
      SET payment_status = 'PAID',
          fulfilment_status = 'Confirmed',
          gateway_payment_id = ?,
          gateway_signature = ?,
          stock_deducted = 1,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(gatewayPaymentId, gatewaySignature, order.id);

    db.prepare(`
      UPDATE payments
      SET gateway_payment_id = ?,
          status = 'PAID',
          verified_on_server = 1,
          updated_at = datetime('now')
      WHERE order_id = ?
    `).run(gatewayPaymentId, order.id);

    db.prepare(`
      INSERT INTO notification_logs (order_number, channel, recipient, event_type, subject, body_preview)
      VALUES (?, 'EMAIL', ?, 'PAYMENT_CONFIRMED', ?, ?)
    `).run(
      orderNumber,
      order.customer_email,
      `Payment Confirmed for Sashya Naturals Order ${orderNumber}`,
      `Server-verified payment ${gatewayPaymentId} of Rs. ${(order.total_paise / 100).toFixed(2)}. Invoice: /orders/${orderNumber}/invoice`
    );

    db.exec('COMMIT;');

    return {
      alreadyPaid: false,
      orderNumber,
      paymentStatus: 'PAID',
      fulfilmentStatus: 'Confirmed',
      gatewayPaymentId,
      invoiceUrl: `/orders/${orderNumber}/invoice`
    };
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function updateOrderFulfilmentAndShipping({
  orderNumber,
  fulfilmentStatus,
  courierName,
  trackingNumber,
  trackingUrl,
  dispatchDate,
  manualShippingChargePaise = null,
  actorEmail = 'admin@sashyanaturals.com',
  actorRole = 'ORDER_MANAGER'
}) {
  if (!ORDER_FULFILMENT_STATUSES.includes(fulfilmentStatus)) {
    throw new Error(`Invalid fulfilment status: ${fulfilmentStatus}`);
  }
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber);
  if (!order) throw new Error(`Order ${orderNumber} not found.`);

  const cleanCourier = String(courierName || '').trim();
  const cleanTracking = String(trackingNumber || '').trim();
  const cleanTrackingUrl = String(trackingUrl || '').trim();
  const cleanDispatchDate = String(dispatchDate || '').trim();

  if (cleanTrackingUrl && !/^https?:\/\/[^\s"'<>]+$/i.test(cleanTrackingUrl)) {
    throw new Error('Tracking URL must begin with https:// or http:// and contain no spaces or HTML characters.');
  }

  if (cleanDispatchDate) {
    const dm = cleanDispatchDate.match(/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
    if (!dm) {
      throw new Error('Dispatch date must be a valid YYYY-MM-DD calendar date.');
    }
    const dy = Number(dm[1]), dmo = Number(dm[2]), dd = Number(dm[3]);
    const dt = new Date(Date.UTC(dy, dmo - 1, dd));
    if (dt.getUTCFullYear() !== dy || dt.getUTCMonth() !== dmo - 1 || dt.getUTCDate() !== dd) {
      throw new Error('Dispatch date must be a valid YYYY-MM-DD calendar date.');
    }
  }

  const nextCourier = courierName !== undefined ? cleanCourier : (order.courier_name || '');
  const nextTracking = trackingNumber !== undefined ? cleanTracking : (order.tracking_number || '');
  const nextTrackingUrl = trackingUrl !== undefined ? cleanTrackingUrl : (order.tracking_url || '');
  const nextDispatchDate = dispatchDate !== undefined ? cleanDispatchDate : (order.dispatch_date || '');

  if (fulfilmentStatus === 'Shipped' && (!nextCourier || !nextTracking)) {
    throw new Error('Dispatched orders require Courier Name and Tracking Number (Manual Shipping Workflow Section 7).');
  }

  if (
    order.fulfilment_status === 'Delivered' &&
    ['Pending Payment', 'Confirmed', 'Processing', 'Packed', 'Shipped', 'Cancelled'].includes(fulfilmentStatus)
  ) {
    throw new Error(`Order ${orderNumber} has already been Delivered and cannot be transitioned backwards to ${fulfilmentStatus}.`);
  }

  if (order.payment_status === 'REFUNDED' && fulfilmentStatus !== 'Refunded') {
    throw new Error(`Order ${orderNumber} has already been refunded and cannot be transitioned back to ${fulfilmentStatus}.`);
  }

  if (
    ['Packed', 'Shipped', 'Delivered'].includes(fulfilmentStatus) &&
    ['PENDING_PAYMENT', 'FAILED'].includes(order.payment_status)
  ) {
    throw new Error(`Cannot mark order ${orderNumber} as ${fulfilmentStatus} while payment status is ${order.payment_status}.`);
  }

  if (
    fulfilmentStatus === 'Pending Payment' &&
    ['PAID', 'COD_COLLECTED'].includes(order.payment_status)
  ) {
    throw new Error(`Cannot revert order ${orderNumber} to Pending Payment after payment is already ${order.payment_status}.`);
  }

  const shouldRestoreStock =
    (fulfilmentStatus === 'Cancelled' || fulfilmentStatus === 'Refunded') &&
    order.stock_deducted === 1;

  const shouldRedeductStock =
    ['Confirmed', 'Processing', 'Packed', 'Shipped', 'Delivered'].includes(fulfilmentStatus) &&
    order.stock_deducted === 0 &&
    !['PENDING_PAYMENT', 'FAILED', 'REFUNDED'].includes(order.payment_status);

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    if (shouldRestoreStock) {
      const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
      const getVarStmt = db.prepare('SELECT stock_qty FROM product_variants WHERE id = ?');
      const restoreStmt = db.prepare('UPDATE product_variants SET stock_qty = stock_qty + ? WHERE id = ?');
      const moveStmt = db.prepare(`
        INSERT INTO inventory_movements (variant_id, delta_qty, previous_qty, new_qty, reason, reference_id, actor_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        const vRow = getVarStmt.get(item.variant_id);
        const prevQty = vRow ? vRow.stock_qty : 0;
        restoreStmt.run(item.quantity, item.variant_id);
        moveStmt.run(
          item.variant_id,
          item.quantity,
          prevQty,
          prevQty + item.quantity,
          `ORDER_${fulfilmentStatus.toUpperCase()}_RESTOCK`,
          orderNumber,
          actorEmail
        );
      }
    } else if (shouldRedeductStock) {
      const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
      const getVarStmt = db.prepare('SELECT stock_qty FROM product_variants WHERE id = ?');
      const deductStmt = db.prepare('UPDATE product_variants SET stock_qty = stock_qty - ? WHERE id = ? AND stock_qty >= ?');
      const moveStmt = db.prepare(`
        INSERT INTO inventory_movements (variant_id, delta_qty, previous_qty, new_qty, reason, reference_id, actor_name)
        VALUES (?, ?, ?, ?, 'ORDER_REOPENED_DEDUCT', ?, ?)
      `);

      for (const item of items) {
        const vRow = getVarStmt.get(item.variant_id);
        const prevQty = vRow ? vRow.stock_qty : 0;
        const res = deductStmt.run(item.quantity, item.variant_id, item.quantity);
        if (res.changes !== 1) {
          throw new Error(`Insufficient stock to reopen order ${orderNumber} for SKU ${item.sku}.`);
        }
        moveStmt.run(item.variant_id, -item.quantity, prevQty, prevQty - item.quantity, orderNumber, actorEmail);
      }
    }

    const nextStockDeducted = shouldRestoreStock ? 0 : (shouldRedeductStock ? 1 : order.stock_deducted);
    let nextPaymentStatus = order.payment_status;
    if (fulfilmentStatus === 'Delivered' && order.payment_status === 'COD_PENDING') {
      nextPaymentStatus = 'COD_COLLECTED';
    } else if (fulfilmentStatus === 'Refunded') {
      nextPaymentStatus = 'REFUNDED';
    } else if (fulfilmentStatus === 'Cancelled' && ['PAID', 'COD_COLLECTED', 'PARTIALLY_REFUNDED'].includes(order.payment_status)) {
      nextPaymentStatus = 'REFUNDED';
    } else if (fulfilmentStatus === 'Refund Initiated' && ['PAID', 'COD_COLLECTED', 'PARTIALLY_REFUNDED'].includes(order.payment_status)) {
      nextPaymentStatus = 'REFUND_INITIATED';
    }

    const hasExplicitShipCharge = manualShippingChargePaise !== null && manualShippingChargePaise !== undefined;
    const nextManualShippingChargePaise = hasExplicitShipCharge
      ? Math.max(0, Math.round(Number(manualShippingChargePaise) || 0))
      : order.manual_shipping_charge_paise;
    const nextShippingPaise = hasExplicitShipCharge ? nextManualShippingChargePaise : order.shipping_paise;
    const nextTotalPaise = hasExplicitShipCharge
      ? wasmOrderTotalPaise(order.subtotal_paise, order.discount_paise, nextShippingPaise)
      : order.total_paise;

    db.prepare(`
      UPDATE orders
      SET fulfilment_status = ?,
          payment_status = ?,
          courier_name = ?,
          tracking_number = ?,
          tracking_url = ?,
          dispatch_date = ?,
          manual_shipping_charge_paise = ?,
          shipping_paise = ?,
          total_paise = ?,
          stock_deducted = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      fulfilmentStatus,
      nextPaymentStatus,
      nextCourier,
      nextTracking,
      nextTrackingUrl,
      nextDispatchDate,
      nextManualShippingChargePaise,
      nextShippingPaise,
      nextTotalPaise,
      nextStockDeducted,
      order.id
    );

    if (hasExplicitShipCharge) {
      db.prepare(`
        UPDATE payments SET amount_paise = ?, updated_at = datetime('now') WHERE order_id = ?
      `).run(nextTotalPaise, order.id);
    }

    if (nextPaymentStatus === 'COD_COLLECTED' && order.payment_status !== 'COD_COLLECTED') {
      db.prepare(`
        UPDATE payments SET status = 'COD_COLLECTED', cod_collected_at = datetime('now'), updated_at = datetime('now')
        WHERE order_id = ?
      `).run(order.id);
    } else if (nextPaymentStatus === 'REFUNDED') {
      db.prepare(`
        UPDATE payments SET status = 'REFUNDED', refund_amount_paise = amount_paise, refunded_by = ?, updated_at = datetime('now')
        WHERE order_id = ?
      `).run(actorEmail, order.id);
    }

    db.prepare(`
      INSERT INTO audit_logs (actor_email, actor_role, action, entity_type, entity_id, details_json)
      VALUES (?, ?, 'ORDER_FULFILMENT_UPDATED', 'ORDER', ?, ?)
    `).run(
      actorEmail,
      actorRole,
      orderNumber,
      JSON.stringify({
        previousFulfilment: order.fulfilment_status,
        newFulfilment: fulfilmentStatus,
        courierName: nextCourier,
        trackingNumber: nextTracking,
        stockRestored: shouldRestoreStock,
        stockRededucted: shouldRedeductStock
      })
    );

    // Interpolate configured notification template from store_settings if present (EC-092 to EC-094)
    const templateKeyMap = {
      Confirmed: 'email_template_order_confirmed',
      Shipped: 'email_template_order_shipped',
      Delivered: 'email_template_order_delivered',
      Cancelled: 'email_template_order_cancelled'
    };
    const tplKey = templateKeyMap[fulfilmentStatus];
    const tplRow = tplKey ? db.prepare('SELECT value FROM store_settings WHERE key = ?').get(tplKey) : null;
    let bodyPreview = nextCourier ? `Courier: ${nextCourier}, Tracking: ${nextTracking}` : `Status: ${fulfilmentStatus}`;
    if (tplRow && tplRow.value) {
      bodyPreview = String(tplRow.value)
        .replace(/\{\{order_number\}\}/g, orderNumber)
        .replace(/\{\{customer_name\}\}/g, order.customer_name)
        .replace(/\{\{courier_name\}\}/g, nextCourier || 'Courier Partner')
        .replace(/\{\{tracking_number\}\}/g, nextTracking || 'AWB Pending');
    }

    db.prepare(`
      INSERT INTO notification_logs (order_number, channel, recipient, event_type, subject, body_preview)
      VALUES (?, 'EMAIL', ?, ?, ?, ?)
    `).run(
      orderNumber,
      order.customer_email,
      `ORDER_${fulfilmentStatus.toUpperCase().replace(/\s+/g, '_')}`,
      `Order ${orderNumber} status updated to ${fulfilmentStatus}`,
      bodyPreview
    );

    db.exec('COMMIT;');
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function recordPaymentAdminAction({
  orderNumber,
  actionType = 'MARK_COD_COLLECTED', // MARK_COD_COLLECTED | RECORD_REFUND
  refundReason = 'Customer requested refund',
  refundAmountPaise = null,
  actorEmail = 'accounts@sashyanaturals.com',
  actorRole = 'ACCOUNTS_MANAGER'
}) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(String(orderNumber || '').trim());
  if (!order) {
    throw new Error(`Order ${orderNumber} not found.`);
  }

  if (actionType === 'MARK_COD_COLLECTED') {
    if (order.payment_status === 'COD_COLLECTED') {
      throw new Error(`Order ${order.order_number} COD payment has already been marked collected.`);
    }
    if (
      order.payment_status !== 'COD_PENDING' ||
      !['Shipped', 'Delivered'].includes(order.fulfilment_status)
    ) {
      throw new Error(`Order ${order.order_number} cannot be marked COD collected before dispatch (current status: ${order.payment_status} / ${order.fulfilment_status}).`);
    }

    db.exec('BEGIN IMMEDIATE TRANSACTION;');
    try {
      db.prepare(`
        UPDATE orders
        SET payment_status = 'COD_COLLECTED',
            updated_at = datetime('now')
        WHERE id = ?
      `).run(order.id);

      db.prepare(`
        UPDATE payments
        SET status = 'COD_COLLECTED',
            cod_collected_at = datetime('now'),
            updated_at = datetime('now')
        WHERE order_id = ?
      `).run(order.id);

      db.prepare(`
        INSERT INTO audit_logs (actor_email, actor_role, action, entity_type, entity_id, details_json)
        VALUES (?, ?, 'COD_PAYMENT_COLLECTED', 'PAYMENT', ?, ?)
      `).run(actorEmail, actorRole, order.order_number, JSON.stringify({ amountPaise: order.total_paise }));

      db.exec('COMMIT;');
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  if (actionType === 'RECORD_REFUND') {
    if (order.payment_status === 'REFUNDED') {
      throw new Error(`Order ${order.order_number} has already been refunded.`);
    }
    if (!['PAID', 'COD_COLLECTED', 'REFUND_INITIATED', 'PARTIALLY_REFUNDED'].includes(order.payment_status)) {
      throw new Error(`Cannot record a refund on order ${order.order_number} because payment was never collected (status: ${order.payment_status}).`);
    }
    if (refundAmountPaise !== null && refundAmountPaise !== undefined) {
      const numRef = Number(refundAmountPaise);
      if (!Number.isFinite(numRef) || numRef <= 0) {
        throw new Error('Refund amount must be a positive amount greater than zero.');
      }
    }

    const finalRefundPaise = refundAmountPaise !== null && refundAmountPaise !== undefined && Number(refundAmountPaise) > 0
      ? Math.min(order.total_paise, Math.round(Number(refundAmountPaise)))
      : order.total_paise;
    const isFullRefund = finalRefundPaise >= order.total_paise;
    const nextPaymentStatus = isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED';

    let updatedOrder;
    if (isFullRefund) {
      // Full refund: transition order to Refunded and atomically restore stock
      updatedOrder = updateOrderFulfilmentAndShipping({
        orderNumber: order.order_number,
        fulfilmentStatus: 'Refunded',
        actorEmail,
        actorRole
      });
    } else {
      // Partial refund: keep stock_deducted and fulfilment workflow active, mark payment_status as PARTIALLY_REFUNDED
      db.prepare(`
        UPDATE orders
        SET payment_status = 'PARTIALLY_REFUNDED',
            updated_at = datetime('now')
        WHERE id = ?
      `).run(order.id);
      updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    }

    db.prepare(`
      UPDATE payments
      SET status = ?,
          refund_amount_paise = ?,
          refund_reason = ?,
          refunded_by = ?,
          updated_at = datetime('now')
      WHERE order_id = ?
    `).run(nextPaymentStatus, finalRefundPaise, String(refundReason || 'Approved Refund').trim(), actorEmail, order.id);

    db.prepare(`
      INSERT INTO audit_logs (actor_email, actor_role, action, entity_type, entity_id, details_json)
      VALUES (?, ?, 'PAYMENT_REFUND_RECORDED', 'PAYMENT', ?, ?)
    `).run(
      actorEmail,
      actorRole,
      order.order_number,
      JSON.stringify({ refundAmountPaise: finalRefundPaise, isFullRefund, refundReason })
    );

    return updatedOrder;
  }

  throw new Error(`Unsupported payment actionType: ${actionType}`);
}

function updateOrderDeliveryAddress({
  orderNumber,
  customerName,
  customerPhone,
  shippingLine1,
  shippingLine2 = '',
  shippingCity,
  shippingState,
  shippingPincode,
  deliveryInstructions = '',
  actorEmail = 'orders@sashyanaturals.com',
  actorRole = 'ORDER_MANAGER'
}) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(String(orderNumber || '').trim());
  if (!order) {
    throw new Error(`Order ${orderNumber} not found.`);
  }

  if (['Shipped', 'Delivered', 'Cancelled', 'Refunded'].includes(order.fulfilment_status)) {
    throw new Error(`Delivery address cannot be modified after order ${order.order_number} is ${order.fulfilment_status}.`);
  }

  const trimmedName = customerName !== undefined ? String(customerName).trim() : order.customer_name;
  const trimmedPhone = customerPhone !== undefined ? String(customerPhone).trim() : order.customer_phone;
  const nextName = trimmedName || order.customer_name;
  const nextPhone = trimmedPhone || order.customer_phone;
  const nextLine1 = String(shippingLine1 !== undefined ? shippingLine1 : order.shipping_line1).trim();
  const nextLine2 = shippingLine2 !== undefined ? String(shippingLine2).trim() : order.shipping_line2;
  const nextCity = String(shippingCity !== undefined ? shippingCity : order.shipping_city).trim();
  const nextState = String(shippingState !== undefined ? shippingState : order.shipping_state).trim();
  const nextPin = String(shippingPincode !== undefined ? shippingPincode : order.shipping_pincode).trim();
  const nextNotes = deliveryInstructions !== undefined ? String(deliveryInstructions).trim() : order.delivery_instructions;

  if (!trimmedName || !trimmedPhone || !nextLine1 || !nextCity || !nextState || !/^\d{6}$/.test(nextPin)) {
    throw new Error('Recipient name, phone, street address, city, state, and a valid 6-digit Indian PIN code are required.');
  }
  const addrPhoneDigits = nextPhone.replace(/\D/g, '');
  if (addrPhoneDigits.length < 10 || addrPhoneDigits.length > 15 || !/^[6-9]\d{9}$/.test(addrPhoneDigits.slice(-10))) {
    throw new Error('Please provide a valid 10-digit Indian mobile phone number.');
  }

  validatePincodeServiceability(nextPin, order.payment_method);

  const ordItems = db.prepare(`
    SELECT oi.product_id, oi.product_name, oi.weight_grams, oi.quantity, p.pincode_restriction_mode, p.pincode_rules_json
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `).all(order.id);

  for (const it of ordItems) {
    const pinEval = evaluateProductPincodeServiceability(it, nextPin, order.payment_method);
    if (!pinEval.deliverablePrepaid) {
      throw new Error(`Delivery to PIN code ${nextPin} is restricted for "${it.product_name}" (${pinEval.reason})`);
    }
    if (!pinEval.codAllowedForProduct && order.payment_method === 'COD') {
      throw new Error(`Cash on Delivery at PIN code ${nextPin} is unavailable for "${it.product_name}" (${pinEval.reason})`);
    }
  }

  const gstSplit = computeStateGstSplit(order.gst_paise || 0, nextState, nextPin);

  let nextShippingPaise = order.shipping_paise;
  let nextTotalPaise = order.total_paise;
  if (nextPin !== order.shipping_pincode && !(Number(order.manual_shipping_charge_paise) > 0)) {
    const totalProductGrams = ordItems.reduce(
      (acc, it) => acc + ((Number(it.weight_grams) || 250) * (Number(it.quantity) || 1)),
      0
    );
    const discountedSubtotalPaise = Math.max(
      0,
      (Number(order.subtotal_paise) || 0) - (Number(order.discount_paise) || 0)
    );
    const shipPolicy = getShippingPolicyFromDb();
    const zoneInfo = resolveShippingZone(nextPin, shipPolicy);
    const isCod = order.payment_method === 'COD';
    nextShippingPaise = wasmZoneWeightShippingPaise({
      discountedSubtotalPaise,
      totalProductGrams,
      packagingTareGrams: shipPolicy.packagingTareGrams,
      base500gPaise: zoneInfo.base500gPaise,
      extra500gPaise: zoneInfo.extra500gPaise,
      freeModeCode: shipPolicy.freeModeCode,
      freeThresholdPaise: shipPolicy.freeThresholdPaise,
      freeMaxWeightGrams: shipPolicy.freeMaxWeightGrams,
      isCod,
      codFeePaise: shipPolicy.codFeePaise
    });
    nextTotalPaise = wasmOrderTotalPaise(order.subtotal_paise, order.discount_paise, nextShippingPaise);
  }

  db.prepare(`
    UPDATE orders
    SET customer_name = ?,
        customer_phone = ?,
        shipping_line1 = ?,
        shipping_line2 = ?,
        shipping_city = ?,
        shipping_state = ?,
        shipping_pincode = ?,
        delivery_instructions = ?,
        tax_supply_type = ?,
        cgst_paise = ?,
        sgst_paise = ?,
        igst_paise = ?,
        shipping_paise = ?,
        total_paise = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    nextName,
    nextPhone,
    nextLine1,
    nextLine2,
    nextCity,
    nextState,
    nextPin,
    nextNotes,
    gstSplit.taxSupplyType,
    gstSplit.cgstPaise,
    gstSplit.sgstPaise,
    gstSplit.igstPaise,
    nextShippingPaise,
    nextTotalPaise,
    order.id
  );

  if (nextTotalPaise !== order.total_paise) {
    db.prepare(`
      UPDATE payments SET amount_paise = ?, updated_at = datetime('now') WHERE order_id = ?
    `).run(nextTotalPaise, order.id);
  }

  db.prepare(`
    INSERT INTO audit_logs (actor_email, actor_role, action, entity_type, entity_id, details_json)
    VALUES (?, ?, 'ORDER_DELIVERY_ADDRESS_UPDATED', 'ORDER', ?, ?)
  `).run(
    actorEmail,
    actorRole,
    order.order_number,
    JSON.stringify({
      shippingLine1: nextLine1,
      shippingCity: nextCity,
      shippingState: nextState,
      shippingPincode: nextPin,
      taxSupplyType: gstSplit.taxSupplyType,
      shippingPaise: nextShippingPaise,
      totalPaise: nextTotalPaise
    })
  );

  return db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
}

module.exports = {
  rustWasm,
  wasmLineTotalPaise,
  wasmInclusiveGstPaise,
  wasmCouponDiscountPaise,
  wasmShippingPaise,
  wasmBillable500gSlabs,
  wasmZoneWeightShippingPaise,
  wasmOrderTotalPaise,
  getShippingPolicyFromDb,
  resolveShippingZone,
  updateShippingPolicySettings,
  ORDER_PAYMENT_STATUSES,
  ORDER_FULFILMENT_STATUSES,
  getActiveRazorpayKeyId,
  getActiveRazorpayKeySecret,
  computeRazorpaySignature,
  verifyRazorpaySignature,
  computeStateGstSplit,
  VALID_COUPON_USAGE_TYPES,
  VALID_COUPON_VISIBILITIES,
  getCurrentIstIsoMinute,
  normalizeIstDateTimeInput,
  normalizePhoneForCoupon,
  getCouponUsageStats,
  evaluateCouponStatus,
  listEnrichedCoupons,
  upsertAdminCoupon,
  toggleAdminCouponActive,
  deleteAdminCoupon,
  calculateCartPricing,
  assertCartPincodeServiceability,
  createOrder,
  createAdminOrder,
  verifyAndCaptureOnlinePayment,
  updateOrderFulfilmentAndShipping,
  recordPaymentAdminAction,
  updateOrderDeliveryAddress
};
