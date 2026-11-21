'use strict';

/**
 * COD Anti-Fraud, PIN-Code Serviceability & Mobile OTP Verification Gate (src/core/checkout/codProtection.js)
 */
const crypto = require('node:crypto');
const { getDb } = require('../../db/database');
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
 * Validates Indian 6-digit PIN code serviceability and checks whether COD is blocked for high-RTO zones.
 */
function validatePincodeServiceability(pincode, paymentMethod = 'ONLINE_UPI') {
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

  const isIntraStateKarnataka = cleanPin.startsWith('56') || cleanPin.startsWith('57') || cleanPin.startsWith('58') || cleanPin.startsWith('59');
  return {
    serviceable: true,
    pincode: cleanPin,
    codAllowedForPin: !blocked || blocked.block_cod_only === 0 ? true : false,
    taxSupplyType: isIntraStateKarnataka ? 'CGST_SGST' : 'IGST'
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
    VALUES ('COD_OTP', 'SMS_WHATSAPP', ?, 'COD_OTP_DISPATCHED', 'Sasya Naturals COD Verification OTP', ?)
  `).run(phone, `Your 6-digit verification code for Sasya Naturals Cash on Delivery is ${otpCode}. Valid for 10 minutes.`);

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
  validatePincodeServiceability,
  requestCodOtp,
  verifyCodOtp,
  isPhoneCodVerified
};
