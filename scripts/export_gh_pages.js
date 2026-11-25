'use strict';

/**
 * Dual-Mode GitHub Pages Showcase Exporter (scripts/export_gh_pages.js)
 * Exports every SSR route, asset, image, and Rust WASM module into /docs for 24/7 $0 GitHub Pages showcasing.
 * Enforces Guardrail: Injects <meta name="robots" content="noindex, nofollow"> on GitHub Pages showcase HTML.
 */
const fs = require('node:fs');
const path = require('node:path');
const { getDb } = require('../src/db/database');
const { INFO_PAGES } = require('../server');
const {
  renderHomePage,
  renderCatalogPage,
  renderProductDetailPage,
  renderCheckoutPage,
  renderTrackOrderPage,
  renderAdminPortalPage,
  renderStaticInfoPage
} = require('../src/views/renderViews');

const ROOT_DIR = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(ROOT_DIR, 'docs');
const BASE_PATH = process.env.GH_PAGES_BASE_PATH || '/sasya_naturals';

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function writeRouteHtml(routePath, html) {
  const clean = routePath.replace(/^\/+|\/+$/g, '');
  const outDir = clean ? path.join(DOCS_DIR, clean) : DOCS_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');
}

function runExport() {
  const db = getDb();
  fs.rmSync(DOCS_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOCS_DIR, { recursive: true });

  // Copy static assets, images, and Rust WASM binary
  copyDirRecursive(path.join(ROOT_DIR, 'public/assets'), path.join(DOCS_DIR, 'assets'));
  copyDirRecursive(path.join(ROOT_DIR, 'public/images'), path.join(DOCS_DIR, 'images'));
  fs.writeFileSync(path.join(DOCS_DIR, '.nojekyll'), '', 'utf8');
  const { APP_VERSION, BRAND_NAME, BRAND_TAGLINE } = require('../src/config/appConfig');
  fs.writeFileSync(
    path.join(DOCS_DIR, 'site.webmanifest'),
    JSON.stringify({
      name: `${BRAND_NAME} - ${BRAND_TAGLINE}`,
      short_name: BRAND_NAME,
      description: 'Farm-direct Kashmiri almonds, Goan W240 cashews, unpolished native millets, and single-origin Indian spices.',
      start_url: `${BASE_PATH}/`,
      scope: `${BASE_PATH}/`,
      display: 'standalone',
      background_color: '#FAF5E4',
      theme_color: '#212C64',
      icons: [
        { src: `${BASE_PATH}/images/favicon-32.png?v=${APP_VERSION}`, sizes: '32x32', type: 'image/png' },
        { src: `${BASE_PATH}/images/apple-touch-icon.png?v=${APP_VERSION}`, sizes: '180x180', type: 'image/png' },
        { src: `${BASE_PATH}/images/favicon.webp?v=${APP_VERSION}`, sizes: '192x192', type: 'image/webp' }
      ],
      shortcuts: [
        { name: 'Shop All Catalogue', short_name: 'Catalogue', url: `${BASE_PATH}/shop` },
        { name: 'Track Order Status', short_name: 'Track Order', url: `${BASE_PATH}/track-order` },
        { name: 'Frequently Asked Questions', short_name: 'FAQs', url: `${BASE_PATH}/faq` }
      ]
    }, null, 2),
    'utf8'
  );

  const categories = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY display_order').all();
  const products = db.prepare('SELECT * FROM products WHERE is_active = 1 ORDER BY id').all();
  const variants = db.prepare('SELECT * FROM product_variants WHERE is_active = 1 ORDER BY weight_grams').all();
  const { listEnrichedCoupons } = require('../src/core/checkout/checkoutEngine');
  const coupons = listEnrichedCoupons().filter(c => c.is_active === 1);
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
  const payments = db.prepare('SELECT * FROM payments ORDER BY id DESC').all();
  const staffUsers = db.prepare("SELECT * FROM users WHERE role != 'CUSTOMER' ORDER BY id").all();
  const auditLogs = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 30').all();
  const settings = db.prepare('SELECT * FROM store_settings ORDER BY key').all();
  const movements = db.prepare('SELECT * FROM inventory_movements ORDER BY id DESC LIMIT 25').all();

  const variantSnap = db.prepare(`
    SELECT
      v.id AS variant_id,
      v.product_id,
      v.sku,
      v.pack_label,
      v.weight_grams,
      v.mrp_paise,
      v.selling_price_paise,
      p.name AS product_name,
      p.gst_percent,
      p.pincode_restriction_mode,
      p.pincode_rules_json
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    WHERE v.is_active = 1 AND p.is_active = 1
  `).all();

  const staticShowcaseScript = `<script>
    window.__SN_STATIC_SHOWCASE__ = true;
    window.__SN_BASE_PATH__ = ${JSON.stringify(BASE_PATH)};
    window.__SN_STATIC_DATA__ = ${JSON.stringify({ variants: variantSnap, coupons })};
  </script>`;

  // 1. Home
  writeRouteHtml('/', renderHomePage({
    categories,
    products,
    variants,
    basePath: BASE_PATH,
    staticShowcaseScript,
    isNoIndex: true
  }));

  // 2. Shop & Categories
  writeRouteHtml('/shop', renderCatalogPage({
    categories,
    activeCategory: null,
    products,
    variants,
    basePath: BASE_PATH,
    staticShowcaseScript,
    isNoIndex: true
  }));

  for (const cat of categories) {
    const catProducts = products.filter(p => p.category_id === cat.id);
    writeRouteHtml(`/category/${cat.slug}`, renderCatalogPage({
      categories,
      activeCategory: cat,
      products: catProducts,
      variants,
      basePath: BASE_PATH,
      staticShowcaseScript,
      isNoIndex: true
    }));
  }

  // 3. All Single Product Detail Pages
  for (const prod of products) {
    const category = categories.find(c => c.id === prod.category_id) || categories[0];
    const prodVariants = variants.filter(v => v.product_id === prod.id);
    const relatedProducts = products
      .filter(p => p.category_id === prod.category_id && p.id !== prod.id)
      .slice(0, 3);

    writeRouteHtml(`/product/${prod.slug}`, renderProductDetailPage({
      product: prod,
      category,
      variants: prodVariants,
      relatedProducts,
      allVariants: variants,
      basePath: BASE_PATH,
      staticShowcaseScript,
      isNoIndex: true
    }));
  }

  // 4. Checkout & Track Order & Admin
  const demoCustForCheckout = db.prepare("SELECT * FROM users WHERE role = 'CUSTOMER' ORDER BY id LIMIT 1").get() || null;
  const demoAddressesForCheckout = demoCustForCheckout
    ? db.prepare('SELECT * FROM customer_addresses WHERE user_id = ? ORDER BY is_default DESC, id ASC').all(demoCustForCheckout.id)
    : [];
  writeRouteHtml('/checkout', renderCheckoutPage({
    coupons,
    customer: demoCustForCheckout,
    addresses: demoAddressesForCheckout,
    basePath: BASE_PATH,
    staticShowcaseScript,
    isNoIndex: true
  }));

  const sampleOrder = orders[0];
  const sampleItems = sampleOrder
    ? db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(sampleOrder.id)
    : [];
  writeRouteHtml('/track-order', renderTrackOrderPage({
    order: sampleOrder,
    orderItems: sampleItems,
    queryOrderNumber: sampleOrder ? sampleOrder.order_number : 'SN-2026-1001',
    basePath: BASE_PATH,
    staticShowcaseScript,
    isNoIndex: true
  }));

  const { listVaultStatus } = require('../src/core/auth/credentialVault');
  const { renderGstInvoicePage, renderCustomerAccountPage } = require('../src/views/renderViews');
  const settingsMap = Object.fromEntries(settings.map(s => [s.key, s.value]));
  const allOrderItems = db.prepare('SELECT * FROM order_items ORDER BY id DESC').all();
  const customerUsers = db.prepare("SELECT * FROM users WHERE role = 'CUSTOMER' ORDER BY id").all();
  const customerAddresses = db.prepare('SELECT * FROM customer_addresses ORDER BY is_default DESC, id ASC').all();
  const notificationLogs = db.prepare('SELECT * FROM notification_logs ORDER BY id DESC LIMIT 25').all();

  for (const ord of orders) {
    const ordItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(ord.id);
    writeRouteHtml(`/orders/${ord.order_number}/invoice`, renderGstInvoicePage({
      order: ord,
      orderItems: ordItems,
      settingsMap,
      basePath: BASE_PATH
    }));
  }

  const demoCust = customerUsers[0] || null;
  const demoAddresses = demoCust
    ? customerAddresses.filter(a => Number(a.user_id) === Number(demoCust.id))
    : customerAddresses;

  writeRouteHtml('/account', renderCustomerAccountPage({
    customer: demoCust,
    addresses: demoAddresses,
    orders,
    orderItems: allOrderItems,
    basePath: BASE_PATH,
    staticShowcaseScript,
    isNoIndex: true
  }));

  writeRouteHtml('/admin', renderAdminPortalPage({
    categories,
    products,
    variants,
    orders,
    orderItems: allOrderItems,
    payments,
    staffUsers,
    customerUsers,
    customerAddresses,
    auditLogs,
    notificationLogs,
    settings,
    movements,
    vaultStatus: listVaultStatus(),
    authenticatedAdmin: staffUsers[0] || null,
    basePath: BASE_PATH,
    staticShowcaseScript
  }));

  // 5. Info & Policy Pages (excluding /account which is now rendered above)
  for (const [slug, info] of Object.entries(INFO_PAGES)) {
    if (slug === 'account') continue;
    writeRouteHtml(`/${slug}`, renderStaticInfoPage({
      slug,
      title: info.title,
      subtitle: info.subtitle,
      paragraphs: info.paragraphs,
      basePath: BASE_PATH,
      staticShowcaseScript,
      isNoIndex: true
    }));
  }

  console.log(`[GitHub Pages Showcase Exporter] Exported ${3 + categories.length + products.length + 3 + Object.keys(INFO_PAGES).length} static routes + Rust WASM core to /docs (basePath=${BASE_PATH})`);
}

if (require.main === module) {
  runExport();
}

module.exports = { runExport };
