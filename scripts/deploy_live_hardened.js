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

function printVpsCutoverPlan() {
  console.log('==================================================================');
  console.log(`Sasya Naturals Zero-502 VPS Cutover Engine (APP_VERSION=${APP_VERSION})`);
  console.log('==================================================================');
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
  printVpsCutoverPlan();
}

module.exports = { printVpsCutoverPlan };
