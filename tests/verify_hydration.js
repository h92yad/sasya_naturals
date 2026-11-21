'use strict';

const assert = require('node:assert');
const { APP_VERSION } = require('../src/config/appConfig');
const { getDb } = require('../src/db/database');
const {
  renderHomePage,
  renderCatalogPage,
  renderProductDetailPage,
  renderCheckoutPage,
  renderTrackOrderPage,
  renderAdminPortalPage
} = require('../src/views/renderViews');

function runVerifyHydration() {
  const db = getDb();
  const categories = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY display_order').all();
  const products = db.prepare('SELECT * FROM products WHERE is_active = 1 ORDER BY id').all();
  const variants = db.prepare('SELECT * FROM product_variants WHERE is_active = 1 ORDER BY weight_grams').all();
  const coupons = db.prepare('SELECT * FROM coupons WHERE is_active = 1').all();
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
  const payments = db.prepare('SELECT * FROM payments ORDER BY id DESC').all();
  const staffUsers = db.prepare("SELECT * FROM users WHERE role != 'CUSTOMER'").all();
  const auditLogs = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 10').all();
  const settings = db.prepare('SELECT * FROM store_settings').all();
  const movements = db.prepare('SELECT * FROM inventory_movements LIMIT 10').all();

  const pages = [
    { name: 'Home', html: renderHomePage({ categories, products, variants }) },
    { name: 'Shop', html: renderCatalogPage({ categories, activeCategory: null, products, variants }) },
    { name: 'Category Dry Fruits', html: renderCatalogPage({ categories, activeCategory: categories[0], products: products.filter(p => p.category_id === categories[0].id), variants }) },
    { name: 'PDP Almonds', html: renderProductDetailPage({ product: products[0], category: categories[0], variants: variants.filter(v => v.product_id === products[0].id), relatedProducts: products.slice(1, 4), allVariants: variants }) },
    { name: 'Checkout', html: renderCheckoutPage({ coupons }) },
    { name: 'Track Order', html: renderTrackOrderPage({ order: orders[0], orderItems: [] }) },
    { name: 'Admin Portal', html: renderAdminPortalPage({ categories, products, variants, orders, payments, staffUsers, auditLogs, settings, movements }) }
  ];

  for (const page of pages) {
    assert(page.html.includes('id="app-mount" data-ssr-rendered="true"'), `[${page.name}] Missing SSR hydration marker`);
    assert(page.html.includes(`data-app-version="${APP_VERSION}"`), `[${page.name}] Missing APP_VERSION marker`);
    assert(page.html.includes(`/assets/sasya-core.css?v=${APP_VERSION}`), `[${page.name}] Missing versioned CSS asset`);
    assert(page.html.includes(`/assets/sasya-client.js?v=${APP_VERSION}`), `[${page.name}] Missing versioned JS asset`);
    const h1Matches = page.html.match(/<h1[\s>]/g) || [];
    assert.strictEqual(h1Matches.length, 1, `[${page.name}] Expected exactly 1 <h1> tag, found ${h1Matches.length}`);
  }

  console.log(`✓ [Suite 1/7: verify_hydration] Passed 7/7 SSR routes with data-ssr-rendered="true" and APP_VERSION=${APP_VERSION}`);
}

if (require.main === module) {
  runVerifyHydration();
}

module.exports = { runVerifyHydration };
