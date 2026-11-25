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
  renderAdminPortalPage,
  renderStaticInfoPage
} = require('../src/views/renderViews');
const { INFO_PAGES } = require('../server');

function assertZeroDuplicateIdsAndValidFragments(html, pageName) {
  // Strip <script> blocks before scanning HTML attributes
  const htmlNoScripts = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const idRegex = /(?<![a-zA-Z0-9_-])id="([^"]+)"/g;
  const seenIds = new Set();
  const duplicateIds = [];
  let match;
  while ((match = idRegex.exec(htmlNoScripts)) !== null) {
    const idVal = match[1];
    if (seenIds.has(idVal)) {
      duplicateIds.push(idVal);
    }
    seenIds.add(idVal);
  }
  assert.strictEqual(
    duplicateIds.length,
    0,
    `[${pageName}] Found duplicate HTML id attributes: ${duplicateIds.join(', ')}`
  );

  // Verify every in-page href="#fragment" resolves to an existing DOM id on the same page
  const hashHrefRegex = /(?<![a-zA-Z0-9_-])href="#([^"]+)"/g;
  let hrefMatch;
  while ((hrefMatch = hashHrefRegex.exec(htmlNoScripts)) !== null) {
    const targetId = hrefMatch[1];
    assert(
      seenIds.has(targetId),
      `[${pageName}] Broken in-page bookmark link href="#${targetId}" has no matching id="${targetId}" in DOM`
    );
  }
}

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
    { name: 'FAQ', html: renderStaticInfoPage({ slug: 'faq', ...INFO_PAGES.faq }) },
    { name: 'Shipping & Returns', html: renderStaticInfoPage({ slug: 'shipping-returns', ...INFO_PAGES['shipping-returns'] }) },
    { name: 'Admin Portal', html: renderAdminPortalPage({ categories, products, variants, orders, payments, staffUsers, auditLogs, settings, movements }) }
  ];

  for (const page of pages) {
    assert(page.html.includes('id="app-mount" data-ssr-rendered="true"'), `[${page.name}] Missing SSR hydration marker`);
    assert(page.html.includes(`data-app-version="${APP_VERSION}"`), `[${page.name}] Missing APP_VERSION marker`);
    assert(page.html.includes(`/assets/sasya-core.css?v=${APP_VERSION}`), `[${page.name}] Missing versioned CSS asset`);
    assert(page.html.includes(`/assets/sasya-client.js?v=${APP_VERSION}`), `[${page.name}] Missing versioned JS asset`);
    assert(page.html.includes('href="#app-mount" class="sn-skip-link"'), `[${page.name}] Missing skip-to-main-content bookmark link`);
    assert(page.html.includes('id="site-header"') && page.html.includes('id="site-footer"'), `[${page.name}] Missing #site-header or #site-footer landmark IDs`);
    assert(page.html.includes('id="webpage"') && page.html.includes('id="breadcrumb"'), `[${page.name}] Missing #webpage or #breadcrumb JSON-LD fragment target IDs`);
    assert(page.html.includes(`/site.webmanifest?v=${APP_VERSION}`), `[${page.name}] Missing /site.webmanifest link`);
    const h1Matches = page.html.match(/<h1[\s>]/g) || [];
    assert.strictEqual(h1Matches.length, 1, `[${page.name}] Expected exactly 1 <h1> tag, found ${h1Matches.length}`);
    assertZeroDuplicateIdsAndValidFragments(page.html, page.name);
  }

  const homeHtml = pages.find(p => p.name === 'Home').html;
  assert(homeHtml.includes('id="hero-banner"') && homeHtml.includes('id="pantry-categories"') && homeHtml.includes('id="featured-harvests"') && homeHtml.includes('id="bestsellers"'), 'Home page must include section bookmark IDs');
  assert(homeHtml.includes('rel="bookmark"'), 'Product and category cards must include rel="bookmark"');

  const pdpHtml = pages.find(p => p.name === 'PDP Almonds').html;
  assert(pdpHtml.includes('data-pdp-spec-tab="nutrition"'), 'PDP must render the Nutritional Value (Per 100 g) tab');
  assert(pdpHtml.includes('id="origin-compliance"') && pdpHtml.includes('id="nutrition-facts"'), 'PDP must render #origin-compliance and #nutrition-facts bookmark IDs on spec panes');
  assert(pdpHtml.includes('id="pack-variants"') && pdpHtml.includes('id="delivery-checker"') && pdpHtml.includes('id="related-products"'), 'PDP must render #pack-variants, #delivery-checker, and #related-products bookmark IDs');
  assert(pdpHtml.includes('Per 100 g Edible Portion'), 'PDP must SSR-render the FSSAI Per-100g nutrition table in DOM');
  assert(pdpHtml.includes('class="sn-pack-pill-save"'), 'PDP pack pills must render per-weight Save X% badges');
  assert(pdpHtml.includes('data-product-pincode-rules='), 'PDP must embed data-product-pincode-rules on product container and PIN input');

  const faqHtml = pages.find(p => p.name === 'FAQ').html;
  assert(faqHtml.includes('id="faq-what-pack-sizes-do-you-offer"'), 'FAQ page must render deterministic question bookmark IDs');
  assert(faqHtml.includes('"@type":"FAQPage"'), 'FAQ page must embed FAQPage JSON-LD schema');

  const adminHtml = pages.find(p => p.name === 'Admin Portal').html;
  assert(adminHtml.includes('data-open-create-prod-modal="true"'), 'Admin Portal + Add New Product buttons must open the full 4-Tab Product Modal');
  assert(adminHtml.includes('id="sn-edit-prod-sku-input"') && adminHtml.includes('id="sn-edit-prod-photo-file"'), 'Admin 4-Tab Product Modal Tab 1 must include SKU Prefix and Primary Photo upload inputs');
  assert(adminHtml.includes('data-prod-modal-tab="pricing"'), 'Admin Product Edit Modal must include isolated Pack-Weight Pricing & Discounts tab');
  assert(adminHtml.includes('data-var-stock-input="100"') && adminHtml.includes('data-var-stock-input="1000"'), 'Admin 4-Tab Product Modal Tab 2 must include per-weight stock quantity inputs');
  assert(adminHtml.includes('data-prod-modal-tab="nutrition"') && adminHtml.includes('data-apply-nut-preset="1"'), 'Admin Product Edit Modal must include isolated FSSAI Nutrition tab and 1-click IFCT category presets');
  assert(adminHtml.includes('data-prod-modal-tab="pincode"'), 'Admin Product Edit Modal must include isolated Delivery PIN & Zone Rules tab');
  assert(adminHtml.includes('id="sn-edit-pin-mode"') && adminHtml.includes('id="sn-edit-pin-test-btn"'), 'Admin Product Edit Modal must render PIN restriction mode selector and live PIN rule simulator');
  assert(adminHtml.includes('data-var-disc-input="500"') && adminHtml.includes('data-var-disc-input="1000"'), 'Admin Product Edit Modal must render per-weight discount inputs for 100g, 250g, 500g, and 1kg');

  console.log(`✓ [Suite 1/7: verify_hydration] Passed 9/9 SSR routes with data-ssr-rendered="true", 0 duplicate HTML IDs, 100% resolved #hash bookmarks, FAQPage & APP_VERSION=${APP_VERSION}`);
}

if (require.main === module) {
  runVerifyHydration();
}

module.exports = { runVerifyHydration };
