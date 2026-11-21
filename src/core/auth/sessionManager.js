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
    loginAttemptsMap.set(key, { count: 1, firstAttemptAt: now });
  } else {
    record.count += 1;
  }
}

function clearFailedAttempts(key) {
  loginAttemptsMap.delete(key);
}

function loginAdminWithPassword(email, password, clientIp = '127.0.0.1') {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const rateKey = `${clientIp}:${cleanEmail}`;
  checkLoginRateLimit(rateKey);

  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE lower(email) = ? AND role != 'CUSTOMER' AND is_active = 1").get(cleanEmail);
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
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
  signSessionToken,
  verifySessionToken,
  generateCsrfToken,
  loginAdminWithPassword,
  parseCookies,
  buildSessionCookieHeader,
  clearFailedAttempts
};
