'use strict';

/**
 * COD Anti-Fraud, PIN-Code Serviceability & Mobile OTP Verification Gate (src/core/checkout/codProtection.js)
 */
const crypto = require('node:crypto');
const {
  getDb,
  parseProductPincodeRules,
  normalizePincodeRulesPayload
} = require('../../db/database');
const { IS_PROD } = require('../../config/appConfig');

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

function hashOtp(phone, otpCode) {
  return crypto.createHash('sha256').update(`sasya_cod_otp_${phone}_${otpCode}`).digest('hex');
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D+/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * Resolves a 6-digit Indian PIN code into one of the 4 shipping zones (ZONE_A, ZONE_B, ZONE_C, ZONE_D).
 */
function resolvePincodeZoneCode(pincode = '560001') {
  const cleanPin = String(pincode || '560001').trim();
  const prefix3 = cleanPin.slice(0, 3);
  const prefix2 = cleanPin.slice(0, 2);

  if (prefix3 === '560') {
    return 'ZONE_A';
  }
  if (['18', '19', '78', '79'].includes(prefix2) || ['744', '682'].includes(prefix3)) {
    return 'ZONE_D';
  }
  if (['50', '51', '52', '53', '56', '57', '58', '59', '60', '61', '62', '63', '64', '67', '68', '69'].includes(prefix2)) {
    return 'ZONE_B';
  }
  return 'ZONE_C';
}

/**
 * Returns true if the given 6-digit PIN code matches any zone, exact PIN, prefix, or range in rules.
 */
function doesPincodeMatchRuleTargets(pincode, rules = {}) {
  const cleanPin = String(pincode || '').trim();
  if (!/^[1-8]\d{5}$/.test(cleanPin)) return false;

  const zoneCode = resolvePincodeZoneCode(cleanPin);
  if (Array.isArray(rules.zones) && rules.zones.includes(zoneCode)) {
    return true;
  }
  if (Array.isArray(rules.pincodes) && rules.pincodes.includes(cleanPin)) {
    return true;
  }
  if (Array.isArray(rules.prefixes) && rules.prefixes.some(pr => cleanPin.startsWith(String(pr)))) {
    return true;
  }
  const pinNum = Number(cleanPin);
  if (
    Array.isArray(rules.ranges) &&
    rules.ranges.some(r => r && Number(r.from) <= pinNum && pinNum <= Number(r.to))
  ) {
    return true;
  }
  return false;
}

/**
 * Evaluates a product's PIN code restriction rules against a destination 6-digit PIN code and payment method.
 */
function evaluateProductPincodeServiceability(productOrRules, pincode, paymentMethod = 'ONLINE_UPI') {
  const cleanPin = String(pincode || '').trim();
  const rules =
    productOrRules &&
    typeof productOrRules === 'object' &&
    Array.isArray(productOrRules.zones) &&
    typeof productOrRules.mode === 'string'
      ? normalizePincodeRulesPayload(productOrRules)
      : parseProductPincodeRules(productOrRules || {});

  const zoneCode = resolvePincodeZoneCode(cleanPin);

  if (!rules || rules.mode === 'NONE') {
    return {
      serviceable: true,
      deliverablePrepaid: true,
      codAllowedForProduct: true,
      restricted: false,
      mode: 'NONE',
      scope: 'BLOCK_DELIVERY',
      zoneCode,
      reason: ''
    };
  }

  const matched = doesPincodeMatchRuleTargets(cleanPin, rules);
  const isViolation = rules.mode === 'ALLOW_ONLY' ? !matched : matched;

  if (!isViolation) {
    return {
      serviceable: true,
      deliverablePrepaid: true,
      codAllowedForProduct: true,
      restricted: false,
      mode: rules.mode,
      scope: rules.scope,
      zoneCode,
      reason: ''
    };
  }

  if (rules.scope === 'BLOCK_COD_ONLY') {
    const isCod = paymentMethod === 'COD';
    return {
      serviceable: !isCod,
      deliverablePrepaid: true,
      codAllowedForProduct: false,
      restricted: true,
      mode: rules.mode,
      scope: 'BLOCK_COD_ONLY',
      zoneCode,
      reason: rules.reason || 'Cash on Delivery is unavailable for this product at the entered PIN code.'
    };
  }

  return {
    serviceable: false,
    deliverablePrepaid: false,
    codAllowedForProduct: false,
    restricted: true,
    mode: rules.mode,
    scope: 'BLOCK_DELIVERY',
    zoneCode,
    reason: rules.reason || 'This product cannot be delivered to the entered PIN code.'
  };
}

/**
 * Validates Indian 6-digit PIN code serviceability and checks global + optional per-product PIN rules.
 */
function validatePincodeServiceability(pincode, paymentMethod = 'ONLINE_UPI', options = {}) {
  const cleanPin = String(pincode || '').trim();
  if (!/^[1-8]\d{5}$/.test(cleanPin)) {
    throw new Error(`PIN code "${cleanPin}" is not a valid serviceable 6-digit Indian PIN code (must start with 1 to 8).`);
  }

  const db = getDb();
  const blocked = db.prepare('SELECT * FROM blocked_pincodes WHERE pincode = ?').get(cleanPin);
  if (blocked) {
    if (blocked.block_cod_only === 0) {
      throw new Error(`Delivery is currently unserviceable for PIN code ${cleanPin}: ${blocked.reason}`);
    }
    if (paymentMethod === 'COD') {
      throw new Error(`Cash on Delivery is unavailable for PIN code ${cleanPin} (${blocked.reason}). Please choose UPI, Card, or Net Banking.`);
    }
  }

  const globalCodAllowed = !blocked || blocked.block_cod_only === 0 ? true : false;
  const isIntraStateKarnataka = cleanPin.startsWith('56') || cleanPin.startsWith('57') || cleanPin.startsWith('58') || cleanPin.startsWith('59');
  const zoneCode = resolvePincodeZoneCode(cleanPin);

  let productServiceability = null;
  let targetProduct = options && options.product ? options.product : null;
  if (!targetProduct && options && options.productId) {
    targetProduct = db.prepare(
      'SELECT id, name, slug, sku_base, pincode_restriction_mode, pincode_rules_json FROM products WHERE id = ?'
    ).get(Number(options.productId));
  }

  if (targetProduct) {
    productServiceability = evaluateProductPincodeServiceability(targetProduct, cleanPin, paymentMethod);
    const shouldThrow = !options || options.throwOnProductBlock !== false;
    if (!productServiceability.deliverablePrepaid && shouldThrow) {
      throw new Error(`Delivery for "${targetProduct.name}" is unavailable at PIN code ${cleanPin}: ${productServiceability.reason}`);
    }
    if (productServiceability.deliverablePrepaid && !productServiceability.codAllowedForProduct && paymentMethod === 'COD' && shouldThrow) {
      throw new Error(`Cash on Delivery is unavailable for "${targetProduct.name}" at PIN code ${cleanPin}: ${productServiceability.reason}`);
    }
  }

  return {
    serviceable: productServiceability ? productServiceability.serviceable : true,
    deliverablePrepaid: productServiceability ? productServiceability.deliverablePrepaid : true,
    pincode: cleanPin,
    zoneCode,
    codAllowedForPin: globalCodAllowed && (productServiceability ? productServiceability.codAllowedForProduct : true),
    taxSupplyType: isIntraStateKarnataka ? 'CGST_SGST' : 'IGST',
    productServiceability
  };
}

/**
 * Generates and dispatches a 6-digit OTP for COD mobile number verification.
 */
function requestCodOtp(rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (phone.length !== 10) {
    throw new Error('Please enter a valid 10-digit Indian mobile number for COD OTP verification.');
  }

  const otpCode = String(crypto.randomInt(100000, 999999));
  const otpHash = hashOtp(phone, otpCode);
  const expiresAt = Date.now() + OTP_TTL_MS;

  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO cod_otps (phone, otp_hash, verified, attempts, expires_at, created_at)
    VALUES (?, ?, 0, 0, ?, datetime('now'))
  `).run(phone, otpHash, expiresAt);

  db.prepare(`
    INSERT INTO notification_logs (order_number, channel, recipient, event_type, subject, body_preview)
    VALUES ('COD_OTP', 'SMS_WHATSAPP', ?, 'COD_OTP_DISPATCHED', 'Sashya Naturals COD Verification OTP', ?)
  `).run(phone, `Your 6-digit verification code for Sashya Naturals Cash on Delivery is ${otpCode}. Valid for 10 minutes.`);

  return {
    phone,
    sent: true,
    expiresInSeconds: 600,
    // In non-production mode, return sandbox preview so QA/testers can enter the OTP without SMS gateway charges
    sandboxOtpPreview: !IS_PROD ? otpCode : undefined
  };
}

/**
 * Verifies a 6-digit COD OTP code for the customer's mobile number.
 */
function verifyCodOtp(rawPhone, otpCode) {
  const phone = normalizePhone(rawPhone);
  const cleanOtp = String(otpCode || '').trim();
  if (phone.length !== 10 || !/^\d{6}$/.test(cleanOtp)) {
    throw new Error('Invalid phone number or 6-digit COD OTP code.');
  }

  const db = getDb();
  const row = db.prepare('SELECT * FROM cod_otps WHERE phone = ?').get(phone);
  if (!row) {
    throw new Error('No COD verification OTP found for this mobile number. Please request an OTP first.');
  }
  if (Date.now() > row.expires_at) {
    throw new Error('COD OTP has expired. Please request a fresh OTP.');
  }
  if (row.attempts >= 5) {
    throw new Error('Maximum OTP verification attempts exceeded. Please request a new OTP.');
  }

  const expectedHash = hashOtp(phone, cleanOtp);
  const valid = crypto.timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(row.otp_hash, 'hex'));
  if (!valid) {
    db.prepare('UPDATE cod_otps SET attempts = attempts + 1 WHERE phone = ?').run(phone);
    throw new Error('Incorrect 6-digit COD OTP code.');
  }

  db.prepare('UPDATE cod_otps SET verified = 1 WHERE phone = ?').run(phone);
  return { phone, verified: true };
}

function isPhoneCodVerified(rawPhone) {
  const phone = normalizePhone(rawPhone);
  const db = getDb();
  const row = db.prepare('SELECT * FROM cod_otps WHERE phone = ? AND verified = 1').get(phone);
  return Boolean(row && Date.now() <= row.expires_at);
}

module.exports = {
  normalizePhone,
  resolvePincodeZoneCode,
  doesPincodeMatchRuleTargets,
  evaluateProductPincodeServiceability,
  validatePincodeServiceability,
  requestCodOtp,
  verifyCodOtp,
  isPhoneCodVerified
};
