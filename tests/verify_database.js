'use strict';

const assert = require('node:assert');
const { PROTECTED_PATTERNS } = require('../src/config/appConfig');
const { getDb, verifyPassword } = require('../src/db/database');

function runVerifyDatabase() {
  const db = getDb();
  const requiredTables = [
    'store_settings',
    'users',
    'customer_addresses',
    'categories',
    'products',
    'product_variants',
    'inventory_movements',
    'coupons',
    'orders',
    'order_items',
    'payments',
    'audit_logs',
    'notification_logs',
    'credential_vault',
    'cod_otps',
    'blocked_pincodes'
  ];

  for (const tbl of requiredTables) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tbl);
    assert(row && row.name === tbl, `Missing required database table: ${tbl}`);
  }

  // Verify 3 categories
  const cats = db.prepare('SELECT * FROM categories').all();
  assert.strictEqual(cats.length, 3, 'Expected 3 initial categories (Dry Fruits, Millets & Grains, Spices)');

  // Verify products have 4 pack-size variants (100 g, 250 g, 500 g, 1 kg)
  const products = db.prepare('SELECT * FROM products').all();
  assert(products.length >= 16, 'Expected at least 16 seeded products across 3 categories');
  const firstVars = db.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY weight_grams').all(products[0].id);
  assert.deepStrictEqual(
    firstVars.map(v => v.pack_label),
    ['100 g', '250 g', '500 g', '1 kg'],
    'Product must have 100 g, 250 g, 500 g, and 1 kg pack variants'
  );

  // Verify PBKDF2 password hashing (never plaintext)
  const admin = db.prepare("SELECT * FROM users WHERE email = 'superadmin@sasynaturals.com'").get();
  assert(admin && admin.password_hash.startsWith('pbkdf2_sha512$'), 'Passwords must be hashed with PBKDF2-SHA512');
  assert(verifyPassword('Sasya@2026', admin.password_hash), 'Password verification failed');

  // Verify PROTECTED_PATTERNS guardrail
  assert(PROTECTED_PATTERNS.includes('data/sasya_store.db'), 'PROTECTED_PATTERNS must protect data/sasya_store.db');
  assert(PROTECTED_PATTERNS.includes('.env'), 'PROTECTED_PATTERNS must protect .env');

  console.log(`✓ [Suite 2/7: verify_database] Verified ${requiredTables.length} tables, ${products.length} products, 4 pack variants, PBKDF2 hashes & PROTECTED_PATTERNS`);
}

if (require.main === module) {
  runVerifyDatabase();
}

module.exports = { runVerifyDatabase };
