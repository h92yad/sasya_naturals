'use strict';

/**
 * Production Go-Live Launch Readiness Guardrail (src/core/auth/launchReadiness.js)
 *
 * Fail-closed circuit breaker ensuring sashyanaturals.com / sasynaturals.com CANNOT
 * go live to the public unless:
 *   1. Payment Gateway (Razorpay) is sealed in the Credential Vault with a LIVE key (rzp_live_*),
 *      live secret, and webhook secret (rejecting rzp_test_* sandbox keys).
 *   2. Email Notification & Verification (SMTP_API_KEY) is sealed in the Credential Vault
 *      and email_verification_live === '1' is confirmed in store_settings.
 *   3. No staging sample categories (cold-pressed-oils, ghee-forest-honey) remain active.
 */
const { getDb } = require('../../db/database');
const { getVaultSecret } = require('./credentialVault');

const LIVE_PRODUCTION_HOSTS = new Set([
  'sashyanaturals.com',
  'www.sashyanaturals.com',
  'sasynaturals.com',
  'www.sasynaturals.com'
]);

const STAGING_SAMPLE_CATEGORY_SLUGS = [
  'cold-pressed-oils',
  'ghee-forest-honey'
];

function isLiveProductionHost(hostHeader = '') {
  const cleanHost = String(hostHeader || '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '');
  return LIVE_PRODUCTION_HOSTS.has(cleanHost);
}

function evaluateLaunchReadiness() {
  const db = getDb();
  const blockers = [];

  // 1. Check Razorpay Live Payment Gateway Keys in Credential Vault
  const rzpKeyId = String(getVaultSecret('RAZORPAY_KEY_ID', '') || '').trim();
  const rzpKeySecret = String(getVaultSecret('RAZORPAY_KEY_SECRET', '') || '').trim();
  const rzpWebhookSecret = String(getVaultSecret('RAZORPAY_WEBHOOK_SECRET', '') || '').trim();

  const isRzpKeyLive = rzpKeyId.startsWith('rzp_live_') && rzpKeyId.length >= 16;
  const isRzpSecretLive = rzpKeySecret.length >= 12 && !rzpKeySecret.includes('sandbox');
  const isRzpWebhookLive = rzpWebhookSecret.length >= 8 && !rzpWebhookSecret.includes('sandbox');

  if (!rzpKeyId) {
    blockers.push('Payment Gateway: RAZORPAY_KEY_ID is not sealed in the Credential Vault.');
  } else if (!isRzpKeyLive) {
    blockers.push('Payment Gateway: RAZORPAY_KEY_ID is still a sandbox/test key (must start with "rzp_live_").');
  }

  if (!isRzpSecretLive) {
    blockers.push('Payment Gateway: RAZORPAY_KEY_SECRET is not sealed with a live production secret in the Credential Vault.');
  }

  if (!isRzpWebhookLive) {
    blockers.push('Payment Gateway: RAZORPAY_WEBHOOK_SECRET is not sealed in the Credential Vault.');
  }

  const paymentGatewayLive = isRzpKeyLive && isRzpSecretLive && isRzpWebhookLive;

  // 2. Check Email Notification & Customer Email Verification Readiness
  const smtpApiKey = String(getVaultSecret('SMTP_API_KEY', '') || '').trim();
  const isSmtpKeySealed = smtpApiKey.length >= 10 && !smtpApiKey.includes('sandbox') && !smtpApiKey.includes('test');

  const emailVerifyRow = db.prepare("SELECT value FROM store_settings WHERE key = 'email_verification_live'").get();
  const isEmailVerificationVerified = Boolean(emailVerifyRow && emailVerifyRow.value === '1');

  if (!isSmtpKeySealed) {
    blockers.push('Email Notifications: Live SMTP_API_KEY is not sealed in the Credential Vault.');
  }
  if (!isEmailVerificationVerified) {
    blockers.push("Email Verification: Outbound email notification & OTP verification is not marked live (store_settings.email_verification_live != '1').");
  }

  const emailNotificationsLive = isSmtpKeySealed && isEmailVerificationVerified;

  // 3. Check that Staging-only sample categories are not active in the database
  const placeholders = STAGING_SAMPLE_CATEGORY_SLUGS.map(() => '?').join(', ');
  const activeSampleCats = db
    .prepare(`SELECT slug FROM categories WHERE slug IN (${placeholders}) AND is_active = 1`)
    .all(...STAGING_SAMPLE_CATEGORY_SLUGS);

  if (activeSampleCats.length > 0) {
    blockers.push(
      `Staging Sample Data: Sample categories (${activeSampleCats.map(c => c.slug).join(', ')}) are still active. Run "npm run staging:reset-live" before going live.`
    );
  }

  const isReady = paymentGatewayLive && emailNotificationsLive && activeSampleCats.length === 0 && blockers.length === 0;

  return {
    isReady,
    paymentGatewayLive,
    emailNotificationsLive,
    stagingSampleDataClean: activeSampleCats.length === 0,
    checks: {
      razorpayLiveKeyId: isRzpKeyLive,
      razorpayLiveSecret: isRzpSecretLive,
      razorpayWebhookSecret: isRzpWebhookLive,
      smtpApiKeySealed: isSmtpKeySealed,
      emailVerificationConfirmed: isEmailVerificationVerified,
      stagingSampleCategoriesPurged: activeSampleCats.length === 0
    },
    blockers
  };
}

function assertProductionLaunchReady() {
  const status = evaluateLaunchReadiness();
  if (!status.isReady) {
    const err = new Error(
      `[LAUNCH_GUARDRAIL_BLOCKED] Production go-live is blocked until Payment Gateway and Email Notification & Verification are live:\n` +
      status.blockers.map((b, idx) => `  ${idx + 1}. ${b}`).join('\n')
    );
    err.statusCode = 503;
    err.launchStatus = status;
    throw err;
  }
  return status;
}

function renderLaunchingSoonGuardrailHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex">
  <title>Sashya Naturals — Launching Soon</title>
  <link rel="icon" type="image/webp" href="/images/favicon.webp">
  <link rel="preload" href="/assets/fonts/lora-latin-var.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/assets/fonts/poppins-latin-400.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/assets/fonts/poppins-latin-600.woff2" as="font" type="font/woff2" crossorigin>
  <style>
    @font-face { font-family: 'Lora'; font-style: normal; font-weight: 500 700; font-display: block; src: url('/assets/fonts/lora-latin-var.woff2') format('woff2'); }
    @font-face { font-family: 'Poppins'; font-style: normal; font-weight: 400; font-display: block; src: url('/assets/fonts/poppins-latin-400.woff2') format('woff2'); }
    @font-face { font-family: 'Poppins'; font-style: normal; font-weight: 600; font-display: block; src: url('/assets/fonts/poppins-latin-600.woff2') format('woff2'); }
    body { font-family: 'Poppins', system-ui, -apple-system, sans-serif; background: #FAF5E4; color: #161B33; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; text-align: center; padding: 16px; box-sizing: border-box; }
    .card { max-width: 480px; padding: 2.5rem; border: 1px solid #E2D7B5; border-radius: 14px; background: #FFFDF8; box-shadow: 0 10px 30px rgba(27, 36, 88, 0.08); }
    .logo { height: 56px; width: auto; margin: 0 auto 1.25rem; display: block; object-fit: contain; }
    h1 { font-family: 'Lora', Georgia, serif; margin: 0 0 0.75rem; font-size: 1.75rem; letter-spacing: -0.02em; color: #1B2458; }
    p { margin: 0; color: #2E3654; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card" data-launch-guardrail-locked="true">
    <img src="/images/logo-horizontal.webp" alt="Sashya Naturals — Rooted in Trust" class="logo" />
    <h1>Sashya Naturals</h1>
    <p>Heirloom Dry Fruits, Unpolished Native Millets &amp; Single-Origin Indian Spices.<br><br><strong>Our online store is launching soon.</strong></p>
  </div>
</body>
</html>`;
}

module.exports = {
  LIVE_PRODUCTION_HOSTS,
  isLiveProductionHost,
  evaluateLaunchReadiness,
  assertProductionLaunchReady,
  renderLaunchingSoonGuardrailHtml
};
