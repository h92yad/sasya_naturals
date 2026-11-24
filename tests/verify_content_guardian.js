'use strict';

const assert = require('node:assert');
const { getDb } = require('../src/db/database');
const { lintContentText } = require('../src/core/content/contentLinter');
const { INFO_PAGES } = require('../server');

function runVerifyContentGuardian() {
  const db = getDb();
  const categories = db.prepare('SELECT * FROM categories').all();
  const products = db.prepare('SELECT * FROM products').all();

  const failures = [];

  for (const cat of categories) {
    const res = lintContentText(`${cat.name} ${cat.subtitle} ${cat.description}`, `category:${cat.slug}`);
    if (!res.valid) failures.push(...res.issues);
  }

  for (const prod of products) {
    const res = lintContentText(
      `${prod.name} ${prod.short_description} ${prod.description} ${prod.fssai_notes} ${prod.ingredients} ${prod.allergen_info} ${prod.nutrition_json || ''}`,
      `product:${prod.slug}`
    );
    if (!res.valid) failures.push(...res.issues);
  }

  for (const [slug, page] of Object.entries(INFO_PAGES)) {
    const res = lintContentText(`${page.title} ${page.subtitle} ${page.paragraphs.join(' ')}`, `page:${slug}`);
    if (!res.valid) failures.push(...res.issues);
  }

  assert.strictEqual(failures.length, 0, `Content Guardian Violations:\n${failures.join('\n')}`);
  console.log(`✓ [Suite 5/7: verify_content_guardian] Passed humanizer-en audit across ${categories.length} categories, ${products.length} products (including FSSAI nutrition & allergens), and ${Object.keys(INFO_PAGES).length} policy pages`);
}

if (require.main === module) {
  runVerifyContentGuardian();
}

module.exports = { runVerifyContentGuardian };
