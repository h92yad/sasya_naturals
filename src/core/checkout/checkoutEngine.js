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
  validatePincodeServiceability,
  verifyCodOtp,
  isPhoneCodVerified
} = require('./codProtection');

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

function updateShippingPolicySettings(updates = {}, actorEmail = 'superadmin@sasynaturals.com', actorRole = 'SUPER_ADMIN') {
  const db = getDb();
  const allowedKeys = [
    'shipping_free_mode',
    'free_shipping_threshold_inr',
    'free_shipping_max_weight_grams',
    'shipping_packaging_tare_grams',
    'shipping_cod_fee_inr',
    'zone_a_base_inr',
    'zone_a_extra_inr',
    'zone_b_base_inr',
    'zone_b_extra_inr',
    'zone_c_base_inr',
    'zone_c_extra_inr',
    'zone_d_base_inr',
    'zone_d_extra_inr'
  ];

  if (updates.shipping_free_mode && !['DISABLED', 'THRESHOLD_WITH_WEIGHT_CAP', 'UNCONDITIONAL_THRESHOLD'].includes(updates.shipping_free_mode)) {
    throw new Error(`Invalid shipping_free_mode: ${updates.shipping_free_mode}`);
  }

  const stmt = db.prepare("INSERT OR REPLACE INTO store_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))");
  const applied = {};
  for (const key of allowedKeys) {
    if (updates[key] !== undefined && updates[key] !== null && String(updates[key]).trim() !== '') {
      const val = String(updates[key]).trim();
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

/**
 * Deterministically calculates cart totals in integer paise via Rust WASM Core + database variant prices.
 */
function calculateCartPricing(items = [], couponCode = '', paymentMethod = 'ONLINE_UPI', shippingState = 'Karnataka', shippingPincode = '560001') {
  const db = getDb();
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Cart is empty. Please add at least one product pack.');
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
      p.is_active AS product_active
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    WHERE v.id = ?
  `);

  let subtotalPaise = 0;
  let mrpTotalPaise = 0;
  let rawGstPaise = 0;
  let totalWeightGrams = 0;
  const lineItems = [];

  for (const rawItem of items) {
    const variantId = Number(rawItem.variantId);
    const quantity = Math.max(1, Math.min(50, Math.floor(Number(rawItem.quantity || 1))));
    if (!Number.isFinite(variantId) || variantId <= 0) {
      throw new Error('Invalid product variant selection.');
    }
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

    subtotalPaise += lineTotalPaise;
    mrpTotalPaise += lineMrpPaise;
    rawGstPaise += lineGstPaise;
    totalWeightGrams += row.weight_grams * quantity;

    lineItems.push({
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
      lineGstPaise
    });
  }

  let discountPaise = 0;
  let appliedCoupon = '';
  let couponMessage = '';
  const cleanCode = String(couponCode || '').trim().toUpperCase();

  if (cleanCode) {
    const coupon = db.prepare('SELECT * FROM coupons WHERE code = ? AND is_active = 1').get(cleanCode);
    if (!coupon) {
      couponMessage = `Coupon "${cleanCode}" is invalid or expired.`;
    } else if (subtotalPaise < coupon.min_order_paise) {
      couponMessage = `Coupon "${cleanCode}" requires a minimum subtotal of Rs. ${(coupon.min_order_paise / 100).toFixed(0)}.`;
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
  const codAllowed = totalPaise <= PAYMENT_CONFIG.maxCodOrderPaise;

  if (paymentMethod === 'COD' && !codAllowed) {
    throw new Error(`Cash on Delivery is available for orders up to Rs. ${(PAYMENT_CONFIG.maxCodOrderPaise / 100).toFixed(0)}.`);
  }

  return {
    engine: 'rust-wasm-v1.2-zone-slab',
    lineItems,
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
    couponMessage,
    codAllowed,
    amountForFreeShippingPaise: shipPolicy.freeMode === 'DISABLED'
      ? 0
      : Math.max(0, shipPolicy.freeThresholdPaise - discountedSubtotalPaise)
  };
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
  if (!customerName || !customerEmail || !customerPhone || !shippingLine1 || !shippingCity || !shippingState || !shippingPincode) {
    throw new Error('Please complete all required customer contact and Indian delivery address fields.');
  }

  // Validate PIN code serviceability & high-RTO COD rules
  validatePincodeServiceability(shippingPincode, paymentMethod);

  const validMethods = ['ONLINE_UPI', 'ONLINE_CARD', 'ONLINE_NETBANKING', 'COD'];
  if (!validMethods.includes(paymentMethod)) {
    throw new Error(`Unsupported payment method: ${paymentMethod}`);
  }

  const isCod = paymentMethod === 'COD';
  let codOtpVerified = 0;

  if (isCod) {
    if (codOtpCode) {
      verifyCodOtp(customerPhone, codOtpCode);
      codOtpVerified = 1;
    } else if (isPhoneCodVerified(customerPhone)) {
      codOtpVerified = 1;
    } else if (requireCodOtp) {
      throw new Error('Cash on Delivery requires 6-digit Mobile OTP verification to prevent RTO fraud.');
    }
  }

  const pricing = calculateCartPricing(items, couponCode, paymentMethod, shippingState, shippingPincode);
  const db = getDb();

  const seqRow = db.prepare('SELECT COUNT(*) AS cnt FROM orders').get();
  const nextSeq = 1001 + Number(seqRow ? seqRow.cnt : 0);
  const orderNumber = `SN-2026-${nextSeq}`;
  const gatewayOrderId = isCod
    ? `cod_${orderNumber.replace(/-/g, '')}`
    : `order_rzp_${orderNumber.replace(/-/g, '')}_${crypto.randomBytes(3).toString('hex')}`;

  const paymentStatus = isCod ? 'COD_PENDING' : 'PENDING_PAYMENT';
  const fulfilmentStatus = isCod ? 'Confirmed' : 'Pending Payment';

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
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
          customerName
        );
        if (remainingStock <= item.lowStockThreshold) {
          db.prepare(`
            INSERT INTO notification_logs (order_number, channel, recipient, event_type, subject, body_preview)
            VALUES (?, 'ADMIN_ALERT', 'catalog@sasynaturals.com', 'LOW_STOCK_ALERT', ?, ?)
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
      String(customerEmail).trim(),
      isCod ? 'ORDER_CONFIRMED_COD' : 'ORDER_CREATED_AWAITING_PAYMENT',
      `Sasya Naturals Order ${orderNumber} (${fulfilmentStatus})`,
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
  actorEmail = 'superadmin@sasynaturals.com',
  actorRole = 'SUPER_ADMIN'
}) {
  if (!customerName || !customerEmail || !customerPhone || !shippingLine1 || !shippingCity || !shippingState || !shippingPincode) {
    throw new Error('Please complete all required customer contact and Indian delivery address fields.');
  }

  validatePincodeServiceability(shippingPincode, paymentMethod);

  const validMethods = ['ONLINE_UPI', 'ONLINE_CARD', 'ONLINE_NETBANKING', 'COD'];
  if (!validMethods.includes(paymentMethod)) {
    throw new Error(`Unsupported payment method: ${paymentMethod}`);
  }

  const pricing = calculateCartPricing(items, couponCode, paymentMethod, shippingState, shippingPincode);
  const db = getDb();

  let resolvedUserId = userId ? Number(userId) : null;
  if (!resolvedUserId && customerEmail) {
    const existingCustomer = db
      .prepare("SELECT id FROM users WHERE lower(email) = lower(?) AND role = 'CUSTOMER' LIMIT 1")
      .get(String(customerEmail).trim());
    if (existingCustomer) {
      resolvedUserId = existingCustomer.id;
    }
  }

  const isCod = paymentMethod === 'COD';
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

  const seqRow = db.prepare('SELECT COUNT(*) AS cnt FROM orders').get();
  const nextSeq = 1001 + Number(seqRow ? seqRow.cnt : 0);
  const orderNumber = `SN-2026-${nextSeq}`;
  const gatewayOrderId = isCod
    ? `cod_admin_${orderNumber.replace(/-/g, '')}`
    : `order_admin_${orderNumber.replace(/-/g, '')}_${crypto.randomBytes(2).toString('hex')}`;
  const cleanRef = String(gatewayPaymentId || '').trim();
  const finalGatewayPaymentId = cleanRef || (finalPaymentStatus === 'PAID' ? `utr_admin_${orderNumber.replace(/-/g, '')}` : '');

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
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
            VALUES (?, 'ADMIN_ALERT', 'catalog@sasynaturals.com', 'LOW_STOCK_ALERT', ?, ?)
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
      `Sasya Naturals Order ${orderNumber} & GST Tax Invoice (${fulfilmentStatus})`,
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
            VALUES (?, 'ADMIN_ALERT', 'catalog@sasynaturals.com', 'LOW_STOCK_ALERT', ?, ?)
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
      `Payment Confirmed for Sasya Naturals Order ${orderNumber}`,
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
  courierName = '',
  trackingNumber = '',
  trackingUrl = '',
  dispatchDate = '',
  manualShippingChargePaise = 0,
  actorEmail = 'admin@sasynaturals.com',
  actorRole = 'ORDER_MANAGER'
}) {
  if (!ORDER_FULFILMENT_STATUSES.includes(fulfilmentStatus)) {
    throw new Error(`Invalid fulfilment status: ${fulfilmentStatus}`);
  }
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber);
  if (!order) throw new Error(`Order ${orderNumber} not found.`);

  if (fulfilmentStatus === 'Shipped' && (!courierName || !trackingNumber)) {
    throw new Error('Dispatched orders require Courier Name and Tracking Number (Manual Shipping Workflow Section 7).');
  }

  const shouldRestoreStock =
    (fulfilmentStatus === 'Cancelled' || fulfilmentStatus === 'Refunded') &&
    order.stock_deducted === 1;

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
    }

    const nextStockDeducted = shouldRestoreStock ? 0 : order.stock_deducted;
    const nextPaymentStatus =
      fulfilmentStatus === 'Delivered' && order.payment_status === 'COD_PENDING'
        ? 'COD_COLLECTED'
        : (fulfilmentStatus === 'Refunded' ? 'REFUNDED' : order.payment_status);

    db.prepare(`
      UPDATE orders
      SET fulfilment_status = ?,
          payment_status = ?,
          courier_name = COALESCE(NULLIF(?, ''), courier_name),
          tracking_number = COALESCE(NULLIF(?, ''), tracking_number),
          tracking_url = COALESCE(NULLIF(?, ''), tracking_url),
          dispatch_date = COALESCE(NULLIF(?, ''), dispatch_date),
          manual_shipping_charge_paise = CASE WHEN ? > 0 THEN ? ELSE manual_shipping_charge_paise END,
          stock_deducted = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      fulfilmentStatus,
      nextPaymentStatus,
      courierName,
      trackingNumber,
      trackingUrl,
      dispatchDate,
      Number(manualShippingChargePaise || 0),
      Number(manualShippingChargePaise || 0),
      nextStockDeducted,
      order.id
    );

    if (nextPaymentStatus === 'COD_COLLECTED') {
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
        courierName,
        trackingNumber,
        stockRestored: shouldRestoreStock
      })
    );

    db.prepare(`
      INSERT INTO notification_logs (order_number, channel, recipient, event_type, subject, body_preview)
      VALUES (?, 'EMAIL', ?, ?, ?, ?)
    `).run(
      orderNumber,
      order.customer_email,
      `ORDER_${fulfilmentStatus.toUpperCase().replace(/\s+/g, '_')}`,
      `Order ${orderNumber} status updated to ${fulfilmentStatus}`,
      courierName ? `Courier: ${courierName}, Tracking: ${trackingNumber}` : `Status: ${fulfilmentStatus}`
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
  actorEmail = 'accounts@sasynaturals.com',
  actorRole = 'ACCOUNTS_MANAGER'
}) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(String(orderNumber || '').trim());
  if (!order) {
    throw new Error(`Order ${orderNumber} not found.`);
  }

  if (actionType === 'MARK_COD_COLLECTED') {
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
    const finalRefundPaise = refundAmountPaise !== null && Number(refundAmountPaise) > 0
      ? Math.min(order.total_paise, Math.round(Number(refundAmountPaise)))
      : order.total_paise;

    // Delegate full order status & atomic stock restoration
    const updatedOrder = updateOrderFulfilmentAndShipping({
      orderNumber: order.order_number,
      fulfilmentStatus: 'Refunded',
      actorEmail,
      actorRole
    });

    db.prepare(`
      UPDATE payments
      SET status = 'REFUNDED',
          refund_amount_paise = ?,
          refund_reason = ?,
          refunded_by = ?,
          updated_at = datetime('now')
      WHERE order_id = ?
    `).run(finalRefundPaise, String(refundReason || 'Approved Refund').trim(), actorEmail, order.id);

    db.prepare(`
      INSERT INTO audit_logs (actor_email, actor_role, action, entity_type, entity_id, details_json)
      VALUES (?, ?, 'PAYMENT_REFUND_RECORDED', 'PAYMENT', ?, ?)
    `).run(
      actorEmail,
      actorRole,
      order.order_number,
      JSON.stringify({ refundAmountPaise: finalRefundPaise, refundReason })
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
  actorEmail = 'orders@sasynaturals.com',
  actorRole = 'ORDER_MANAGER'
}) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(String(orderNumber || '').trim());
  if (!order) {
    throw new Error(`Order ${orderNumber} not found.`);
  }

  const nextName = String(customerName || order.customer_name).trim();
  const nextPhone = String(customerPhone || order.customer_phone).trim();
  const nextLine1 = String(shippingLine1 || order.shipping_line1).trim();
  const nextLine2 = shippingLine2 !== undefined ? String(shippingLine2).trim() : order.shipping_line2;
  const nextCity = String(shippingCity || order.shipping_city).trim();
  const nextState = String(shippingState || order.shipping_state).trim();
  const nextPin = String(shippingPincode || order.shipping_pincode).trim();
  const nextNotes = deliveryInstructions !== undefined ? String(deliveryInstructions).trim() : order.delivery_instructions;

  if (!nextLine1 || !nextCity || !nextState || !/^\d{6}$/.test(nextPin)) {
    throw new Error('Street address, city, state, and a valid 6-digit Indian PIN code are required.');
  }

  const gstSplit = computeStateGstSplit(order.gst_paise || 0, nextState, nextPin);

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
    order.id
  );

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
      taxSupplyType: gstSplit.taxSupplyType
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
  calculateCartPricing,
  createOrder,
  createAdminOrder,
  verifyAndCaptureOnlinePayment,
  updateOrderFulfilmentAndShipping,
  recordPaymentAdminAction,
  updateOrderDeliveryAddress
};
