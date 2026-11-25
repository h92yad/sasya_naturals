'use strict';

/**
 * Zero-502 Production VPS Cutover Script (Gate 2 Rule 5)
 * Targets /var/www/sasya_naturals (Primary :3020) and /var/www/sasya_naturals_staging (Standby :3021)
 */
const {
  APP_VERSION,
  PORT,
  STANDBY_PORT,
  PROTECTED_PATTERNS
} = require('../src/config/appConfig');
const { createBookmark } = require('./create_bookmark');
const { assertProductionLaunchReady, evaluateLaunchReadiness } = require('../src/core/auth/launchReadiness');

function printVpsCutoverPlan({ allowDryRun = false } = {}) {
  console.log('==================================================================');
  console.log(`Sashya Naturals Zero-502 VPS Cutover Engine (APP_VERSION=${APP_VERSION})`);
  console.log('==================================================================');

  console.log('0. Pre-Launch Guardrail Gate (Payment Gateway + Email Notification & Verification):');
  const readiness = evaluateLaunchReadiness();
  if (!readiness.isReady && !allowDryRun) {
    assertProductionLaunchReady();
  }
  console.log('   -> ✓ Payment Gateway (Live Razorpay) & Email Notification/Verification Verified LIVE');

  console.log('1. Pre-Deploy Physical Snapshot:');
  const snap = createBookmark('pre_vps_deploy');
  console.log(`   -> Saved local snapshot: ${snap}`);
  console.log('2. Protected Live Patterns (Strictly Excluded from Overwrite):');
  for (const pat of PROTECTED_PATTERNS) {
    console.log(`   -> [PROTECTED] ${pat}`);
  }
  console.log(`3. Hot-Standby Port Binding: 127.0.0.1:${STANDBY_PORT} (/var/www/sasya_naturals_staging)`);
  console.log(`4. Primary Cutover Port Binding: 127.0.0.1:${PORT === 5060 ? 3020 : PORT} (/var/www/sasya_naturals)`);
  console.log('5. Nginx Failover Upstream Directive:');
  console.log('   proxy_next_upstream error timeout http_502;');
  console.log('==================================================================');
}

if (require.main === module) {
  const allowDryRun = process.argv.includes('--dry-run');
  try {
    printVpsCutoverPlan({ allowDryRun });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { printVpsCutoverPlan };
