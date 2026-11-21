'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT_DIR, BANNED_PORTFOLIO_DOMAINS } = require('../src/config/appConfig');
const { runExport } = require('../scripts/export_gh_pages');

function scanDirectoryForFootprintLeaks(dirPath) {
  const leaks = [];
  if (!fs.existsSync(dirPath)) return leaks;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      leaks.push(...scanDirectoryForFootprintLeaks(full));
    } else if (/\.(js|css|html|md|rs)$/.test(entry.name)) {
      const content = fs.readFileSync(full, 'utf8').toLowerCase();
      for (const banned of BANNED_PORTFOLIO_DOMAINS) {
        if (content.includes(banned.toLowerCase())) {
          leaks.push(`Cross-domain leak "${banned}" found in ${full}`);
        }
      }
      if (/wikidata\.org/i.test(content)) {
        leaks.push(`Wikidata URL found in ${full}`);
      }
    }
  }
  return leaks;
}

function runVerifyFootprintAndCadence() {
  // 1. Scan src/, public/, and rust/ for zero cross-domain or Wikidata leaks
  const srcLeaks = [
    ...scanDirectoryForFootprintLeaks(path.join(ROOT_DIR, 'src')),
    ...scanDirectoryForFootprintLeaks(path.join(ROOT_DIR, 'public')),
    ...scanDirectoryForFootprintLeaks(path.join(ROOT_DIR, 'rust/sasya_commerce_core/src'))
  ];
  assert.strictEqual(srcLeaks.length, 0, `Footprint violations:\n${srcLeaks.join('\n')}`);

  // 2. Run GitHub Pages Dual-Mode Exporter and verify noindex, nofollow + wasm_core.wasm presence
  runExport();
  const docsIndex = fs.readFileSync(path.join(ROOT_DIR, 'docs/index.html'), 'utf8');
  assert(
    docsIndex.includes('<meta name="robots" content="noindex, nofollow" />'),
    'GitHub Pages static export in /docs must contain noindex, nofollow meta tag'
  );
  assert(
    fs.existsSync(path.join(ROOT_DIR, 'docs/assets/wasm_core.wasm')),
    'GitHub Pages static export in /docs must bundle Rust WASM binary (wasm_core.wasm)'
  );

  console.log('✓ [Suite 7/7: verify_footprint_and_cadence] Verified 0 cross-domain leaks, 0 Wikidata leaks, and GitHub Pages /docs showcase with noindex + Rust WASM');
}

if (require.main === module) {
  runVerifyFootprintAndCadence();
}

module.exports = { runVerifyFootprintAndCadence };
