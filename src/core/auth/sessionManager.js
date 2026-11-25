'use strict';

/**
 * Hardened Admin Session Cookie Authentication, CSRF & Rate-Limiter (src/core/auth/sessionManager.js)
 */
const crypto = require('node:crypto');
const { getDb, verifyPassword } = require('../../db/database');
const { SESSION_SECRET, IS_PROD } = require('../../config/appConfig');
const { recordAuditLog } = require('./rbac');

const SESSION_COOKIE_NAME = 'sn_admin_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILED_ATTEMPTS = 5;

const loginAttemptsMap = new Map();
const MAX_RATE_LIMIT_ENTRIES = 2000;
const revokedSessionTokens = new Set();
const MAX_REVOKED_TOKENS = 5000;

function revokeSessionToken(token) {
  if (!token || typeof token !== 'string') return;
  if (revokedSessionTokens.size >= MAX_REVOKED_TOKENS) {
    const oldest = revokedSessionTokens.values().next().value;
    if (oldest) revokedSessionTokens.delete(oldest);
  }
  revokedSessionTokens.add(token);
}

function signSessionToken(payloadObj) {
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  if (revokedSessionTokens.has(token)) return null;
  const [payloadB64, sig] = token.split('.');
  const expectedSig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payloadB64)
    .digest('base64url');
  if (sig.length !== expectedSig.length) return null;
  try {
    const valid = crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expectedSig, 'utf8'));
    if (!valid) return null;
    const data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function generateCsrfToken(sessionToken) {
  return crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(`csrf_${sessionToken}`)
    .digest('hex')
    .slice(0, 32);
}

function verifyCsrfToken(sessionToken, providedCsrf) {
  if (!providedCsrf) return false;
  if (!sessionToken) return false;
  const expected = generateCsrfToken(sessionToken);
  if (String(providedCsrf).length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(String(providedCsrf), 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

function checkLoginRateLimit(key) {
  const now = Date.now();
  const record = loginAttemptsMap.get(key);
  if (!record) return;
  if (now - record.firstAttemptAt > RATE_LIMIT_WINDOW_MS) {
    loginAttemptsMap.delete(key);
    return;
  }
  if (record.count >= MAX_FAILED_ATTEMPTS) {
    const err = new Error('Too many failed login attempts. Account locked for 15 minutes.');
    err.statusCode = 429;
    throw err;
  }
}

function recordFailedAttempt(key) {
  const now = Date.now();
  const record = loginAttemptsMap.get(key);
  if (!record || now - record.firstAttemptAt > RATE_LIMIT_WINDOW_MS) {
    if (loginAttemptsMap.size >= MAX_RATE_LIMIT_ENTRIES) {
      const oldestKey = loginAttemptsMap.keys().next().value;
      if (oldestKey) loginAttemptsMap.delete(oldestKey);
    }
    loginAttemptsMap.set(key, { count: 1, firstAttemptAt: now });
  } else {
    record.count += 1;
  }
}

function clearFailedAttempts(key) {
  loginAttemptsMap.delete(key);
  if (typeof key === 'string') {
    loginAttemptsMap.delete(key.replace(/@sasynaturals\.com$/i, '@sashyanaturals.com'));
    loginAttemptsMap.delete(key.replace(/@sashyanaturals\.com$/i, '@sasynaturals.com'));
  }
}

function normalizeStaffOrCustomerEmail(rawEmail) {
  const clean = String(rawEmail || '').trim().toLowerCase();
  if (clean.endsWith('@sasynaturals.com')) {
    return clean.replace(/@sasynaturals\.com$/, '@sashyanaturals.com');
  }
  return clean;
}

function checkPasswordWithTrimFallback(rawPassword, passwordHash, requireSymbol = false) {
  const str = String(rawPassword || '').trim();
  if (str.length < 8 || str.length > 128) return false;
  if (requireSymbol && !/[!@#$%^&*]/.test(str)) return false;
  return verifyPassword(str, passwordHash);
}

function loginAdminWithPassword(email, password, clientIp = '127.0.0.1') {
  const cleanEmail = normalizeStaffOrCustomerEmail(email);
  const altEmail = cleanEmail.replace(/@sashyanaturals\.com$/, '@sasynaturals.com');
  const rateKey = `${clientIp}:${cleanEmail}`;
  const isSharedLoopbackProxy = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1';
  if (!isSharedLoopbackProxy) {
    checkLoginRateLimit(rateKey);
  }

  const db = getDb();
  const user = db
    .prepare("SELECT * FROM users WHERE lower(email) IN (?, ?) AND role != 'CUSTOMER' AND is_active = 1")
    .get(cleanEmail, altEmail);
  if (!user || !checkPasswordWithTrimFallback(password, user.password_hash, true)) {
    if (isSharedLoopbackProxy) {
      checkLoginRateLimit(rateKey);
    }
    recordFailedAttempt(rateKey);
    const err = new Error('Invalid staff email or password.');
    err.statusCode = 401;
    throw err;
  }

  clearFailedAttempts(rateKey);
  const exp = Date.now() + SESSION_TTL_MS;
  const sessionToken = signSessionToken({
    uid: user.id,
    email: user.email,
    role: user.role,
    exp
  });
  const csrfToken = generateCsrfToken(sessionToken);

  recordAuditLog({
    actorId: user.id,
    actorEmail: user.email,
    actorRole: user.role,
    action: 'ADMIN_SESSION_LOGIN',
    entityType: 'AUTH',
    entityId: user.email,
    details: { ip: clientIp }
  });

  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role
    },
    sessionToken,
    csrfToken
  };
}

function parseCookies(cookieHeader = '') {
  const out = {};
  if (!cookieHeader) return out;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      out[k] = v;
    }
  }
  return out;
}

const CUSTOMER_COOKIE_NAME = 'sn_customer_session';

function loginCustomerWithPassword(email, password, clientIp = '127.0.0.1') {
  const cleanEmail = normalizeStaffOrCustomerEmail(email);
  const rateKey = `cust:${clientIp}:${cleanEmail}`;
  checkLoginRateLimit(rateKey);

  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE lower(email) = ? AND is_active = 1").get(cleanEmail);
  if (!user || !checkPasswordWithTrimFallback(password, user.password_hash)) {
    recordFailedAttempt(rateKey);
    const err = new Error('Invalid customer email or password.');
    err.statusCode = 401;
    throw err;
  }

  clearFailedAttempts(rateKey);
  const exp = Date.now() + SESSION_TTL_MS;
  const sessionToken = signSessionToken({
    uid: user.id,
    email: user.email,
    role: user.role,
    exp
  });

  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      phone: user.phone,
      role: user.role
    },
    sessionToken
  };
}

function registerCustomerAccount({ fullName, email, phone, password }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(fullName || '').trim();
  const cleanPhone = String(phone || '').trim();
  const rawPass = String(password || '');

  if (!cleanName || !cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Full Name and a valid Email Address are required.');
  }
  if (rawPass.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  const { hashPassword } = require('../../db/database');
  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(cleanEmail);
  if (existing) {
    throw new Error('An account with this email address already exists. Please sign in.');
  }

  const passHash = hashPassword(rawPass);
  const res = db.prepare(`
    INSERT INTO users (email, full_name, phone, password_hash, role, permissions_json, is_active)
    VALUES (?, ?, ?, ?, 'CUSTOMER', '[]', 1)
  `).run(cleanEmail, cleanName, cleanPhone, passHash);

  const newId = Number(res.lastInsertRowid);
  const exp = Date.now() + SESSION_TTL_MS;
  const sessionToken = signSessionToken({
    uid: newId,
    email: cleanEmail,
    role: 'CUSTOMER',
    exp
  });

  return {
    user: {
      id: newId,
      email: cleanEmail,
      fullName: cleanName,
      phone: cleanPhone,
      role: 'CUSTOMER'
    },
    sessionToken
  };
}

function changeUserPassword({ userId, currentPassword, newPassword }) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(Number(userId));
  if (!user) {
    throw new Error('User account not found.');
  }
  if (!verifyPassword(String(currentPassword || ''), user.password_hash)) {
    const err = new Error('Current password is incorrect.');
    err.statusCode = 401;
    throw err;
  }
  const cleanNew = String(newPassword || '');
  if (cleanNew.length < 6) {
    throw new Error('New password must be at least 6 characters.');
  }

  const { hashPassword } = require('../../db/database');
  const nextHash = hashPassword(cleanNew);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(nextHash, user.id);

  recordAuditLog({
    actorId: user.id,
    actorEmail: user.email,
    actorRole: user.role,
    action: 'USER_PASSWORD_CHANGED',
    entityType: 'USER',
    entityId: user.email,
    details: { role: user.role }
  });

  return { updated: true, email: user.email };
}

function requestPasswordResetOtp(email) {
  const cleanEmail = normalizeStaffOrCustomerEmail(email);
  const altEmail = cleanEmail.replace(/@sashyanaturals\.com$/, '@sasynaturals.com');
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Please enter a valid registered email address.');
  }
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE lower(email) IN (?, ?) AND is_active = 1').get(cleanEmail, altEmail);
  if (!user) {
    throw new Error('No active account found with that email address.');
  }
  if (user.role !== 'CUSTOMER') {
    const err = new Error('Staff and administrator passwords cannot be reset via public OTP. Contact a Super Administrator.');
    err.statusCode = 403;
    throw err;
  }

  const otpCode = String(crypto.randomInt(100000, 999999));
  const otpHash = crypto.createHash('sha256').update(otpCode).digest('hex');
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
  const resetKey = `pwd_reset:${cleanEmail}`;

  db.prepare(`
    INSERT INTO cod_otps (phone, otp_hash, verified, attempts, expires_at, created_at)
    VALUES (?, ?, 0, 0, ?, datetime('now'))
    ON CONFLICT(phone) DO UPDATE SET
      otp_hash = excluded.otp_hash,
      verified = 0,
      attempts = 0,
      expires_at = excluded.expires_at,
      created_at = datetime('now')
  `).run(resetKey, otpHash, expiresAt);

  db.prepare(`
    INSERT INTO notification_logs (order_number, channel, recipient, event_type, subject, body_preview)
    VALUES ('AUTH_OTP', 'EMAIL', ?, 'PASSWORD_RESET_OTP', 'Sashya Naturals Password Reset OTP', ?)
  `).run(cleanEmail, `Your 6-digit password reset code is ${otpCode} (valid for 10 minutes).`);

  return {
    sent: true,
    email: cleanEmail,
    expiresInSeconds: 600,
    sandboxOtpPreview: !IS_PROD ? otpCode : undefined
  };
}

function resetPasswordWithOtp({ email, otpCode, newPassword }) {
  const cleanEmail = normalizeStaffOrCustomerEmail(email);
  const altEmail = cleanEmail.replace(/@sashyanaturals\.com$/, '@sasynaturals.com');
  const cleanOtp = String(otpCode || '').trim();
  const cleanNew = String(newPassword || '').trim();

  if (cleanNew.length < 6) {
    throw new Error('New password must be at least 6 characters.');
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE lower(email) IN (?, ?) AND is_active = 1').get(cleanEmail, altEmail);
  if (!user) {
    throw new Error('No active account found with that email address.');
  }
  if (user.role !== 'CUSTOMER') {
    const err = new Error('Staff and administrator passwords cannot be reset via public OTP.');
    err.statusCode = 403;
    throw err;
  }

  const resetKey = `pwd_reset:${cleanEmail}`;
  const row = db.prepare('SELECT * FROM cod_otps WHERE phone = ?').get(resetKey);
  if (!row) {
    throw new Error('Please request a 6-digit password reset OTP first.');
  }
  if (Date.now() > row.expires_at) {
    throw new Error('Password reset OTP has expired. Please request a new code.');
  }
  if (row.attempts >= 5) {
    throw new Error('Too many failed OTP attempts. Please request a new code.');
  }

  const inputHash = crypto.createHash('sha256').update(cleanOtp).digest('hex');
  if (inputHash !== row.otp_hash) {
    db.prepare('UPDATE cod_otps SET attempts = attempts + 1 WHERE phone = ?').run(resetKey);
    throw new Error('Incorrect 6-digit password reset OTP.');
  }

  const { hashPassword } = require('../../db/database');
  const nextHash = hashPassword(cleanNew);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(nextHash, user.id);
  db.prepare('DELETE FROM cod_otps WHERE phone = ?').run(resetKey);

  for (const k of loginAttemptsMap.keys()) {
    if (k.endsWith(cleanEmail) || k.endsWith(altEmail)) {
      loginAttemptsMap.delete(k);
    }
  }

  recordAuditLog({
    actorId: user.id,
    actorEmail: user.email,
    actorRole: user.role,
    action: 'USER_PASSWORD_RESET_VIA_OTP',
    entityType: 'USER',
    entityId: user.email,
    details: { role: user.role }
  });

  const exp = Date.now() + SESSION_TTL_MS;
  const sessionToken = signSessionToken({
    uid: user.id,
    email: user.email,
    role: user.role,
    exp
  });

  return {
    reset: true,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      phone: user.phone,
      role: user.role
    },
    sessionToken
  };
}

function buildCustomerCookieHeader(sessionToken, clear = false) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const parts = [
    `${CUSTOMER_COOKIE_NAME}=${clear ? 'LOGGED_OUT' : sessionToken}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`
  ];
  if (IS_PROD) parts.push('Secure');
  return parts.join('; ');
}

function buildSessionCookieHeader(sessionToken, clear = false) {
  const maxAge = clear ? 0 : Math.floor(SESSION_TTL_MS / 1000);
  const parts = [
    `${SESSION_COOKIE_NAME}=${clear ? '' : sessionToken}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`
  ];
  if (IS_PROD) parts.push('Secure');
  return parts.join('; ');
}

module.exports = {
  SESSION_COOKIE_NAME,
  CUSTOMER_COOKIE_NAME,
  normalizeStaffOrCustomerEmail,
  signSessionToken,
  verifySessionToken,
  revokeSessionToken,
  generateCsrfToken,
  verifyCsrfToken,
  loginAdminWithPassword,
  loginCustomerWithPassword,
  registerCustomerAccount,
  changeUserPassword,
  requestPasswordResetOtp,
  resetPasswordWithOtp,
  parseCookies,
  buildSessionCookieHeader,
  buildCustomerCookieHeader,
  clearFailedAttempts
};
