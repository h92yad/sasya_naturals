'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const {
  APP_VERSION,
  IS_PROD,
  PORT,
  CANONICAL_ORIGIN,
  BRAND_NAME,
  BRAND_TAGLINE
} = require('./src/config/appConfig');
const { getDb } = require('./src/db/database');
const {
  calculateCartPricing,
  createOrder,
  verifyAndCaptureOnlinePayment,
  updateOrderFulfilmentAndShipping
} = require('./src/core/checkout/checkoutEngine');
const {
  requestCodOtp,
  verifyCodOtp,
  validatePincodeServiceability
} = require('./src/core/checkout/codProtection');
const { uploadProductImage } = require('./src/core/checkout/imageUploader');
const {
  assertAdminPermission,
  recordAuditLog
} = require('./src/core/auth/rbac');
const {
  saveVaultCredential,
  listVaultStatus
} = require('./src/core/auth/credentialVault');
const {
  SESSION_COOKIE_NAME,
  verifySessionToken,
  loginAdminWithPassword,
  parseCookies,
  buildSessionCookieHeader
} = require('./src/core/auth/sessionManager');
const { lintContentText } = require('./src/core/content/contentLinter');
const {
  renderHomePage,
  renderCatalogPage,
  renderProductDetailPage,
  renderCheckoutPage,
  renderTrackOrderPage,
  renderGstInvoicePage,
  renderAdminPortalPage,
  renderStaticInfoPage,
  renderMarkdownTwin
} = require('./src/views/renderViews');

const INFO_PAGES = {
  about: {
    title: 'About Sasya Naturals',
    subtitle: 'Direct-To-Customer Indian Pantry • Pure Dry Fruits, Native Millets & Heirloom Spices',
    paragraphs: [
      'Sasya Naturals connects Indian households directly with regional grower cooperatives harvesting unbleached dry fruits, unpolished rain-fed millets, and high-oil single-origin spices.',
      'Every product is offered in 100 g, 250 g, 500 g, and 1 kg nitrogen-flushed packs with full batch traceability, harvest origin disclosure, and clear allergen labelling.'
    ]
  },
  contact: {
    title: 'Contact Customer Support',
    subtitle: 'Order Assistance, Bulk Enquiries & Dispatch Support',
    paragraphs: [
      'Customer Support Email: care@sasynaturals.com | Phone: +91 80 4568 2200 (Monday to Saturday, 9:30 AM to 6:30 PM IST).',
      'For order tracking queries, please keep your Order Number (for example SN-2026-1001) ready.'
    ]
  },
  faq: {
    title: 'Frequently Asked Questions',
    subtitle: 'Pack Sizes, Payments, Manual Courier Tracking & Storage',
    paragraphs: [
      'What pack sizes do you offer? All dry fruits, millets, and spices are available in 100 g, 250 g, 500 g, and 1 kg packs.',
      'What payment methods are accepted? We accept UPI, credit cards, debit cards, and net banking via Razorpay (verified server-side), as well as Cash on Delivery (COD) across India.',
      'How do I track my shipment? Once our dispatch staff hands your parcel to Blue Dart, Delhivery, or India Post, the courier name and tracking AWB number appear on the Track Order page.'
    ]
  },
  privacy: {
    title: 'Privacy Policy',
    subtitle: 'Customer Data Protection & Order Privacy',
    paragraphs: [
      'Sasya Naturals collects only the contact, delivery address, and payment reference details required to fulfil your order, issue GST tax invoices, and send shipment updates.',
      'Payment card and UPI credentials are processed directly by our PCI-DSS compliant gateway partner (Razorpay) and are never stored on Sasya Naturals servers.'
    ]
  },
  terms: {
    title: 'Terms of Service',
    subtitle: 'Ordering, Pricing, Tax & Fulfilment Terms',
    paragraphs: [
      'All prices listed on sasynaturals.com are in Indian Rupees (INR) and indicate applicable GST percentages. Orders are confirmed only after server-side payment verification or COD confirmation.',
      'Pack weights (100 g, 250 g, 500 g, 1 kg) represent net product weight at the time of packing.'
    ]
  },
  'shipping-returns': {
    title: 'Shipping, Cancellation, Return & Refund Policy',
    subtitle: 'India-Wide Dispatch, Damaged Parcel Replacement & Refund Timelines',
    paragraphs: [
      'Orders above Rs. 799 qualify for complimentary India-wide delivery. Standard orders below Rs. 799 carry a flat Rs. 60 shipping fee.',
      'Orders may be cancelled prior to dispatch. If a parcel arrives damaged or tampered, contact care@sasynaturals.com within 48 hours of delivery for a verified replacement or refund to your original payment source.'
    ]
  },
  account: {
    title: 'Customer Account & Saved Addresses',
    subtitle: 'Manage Your Profile, Saved Delivery Addresses & Order History',
    paragraphs: [
      'Signed-in customers can view past orders, download tax invoices, and manage default delivery addresses across India. Guest checkout is also always available without mandatory registration.'
    ]
  }
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString('utf8');
      if (body.length > 8 * 1024 * 1024) {
        reject(new Error('Request payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function sendHtml(res, statusCode, html, canonicalPath = '/') {
  const mdTwin = canonicalPath === '/' ? '/index.md' : `${canonicalPath}.md`;
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Link': `<${CANONICAL_ORIGIN}${mdTwin}>; rel="alternate"; type="text/markdown"; title="Markdown Version", <${CANONICAL_ORIGIN}/llms.txt>; rel="llms-txt"; type="text/markdown"`
  });
  res.end(html);
}

/**
 * Resolves authenticated staff user:
 * 1. First checks signed HttpOnly session cookie (sn_admin_session).
 * 2. In non-production mode (NODE_ENV !== 'production'), falls back to x-admin-email header for RBAC demo testing.
 */
function resolveAdminUser(req) {
  const db = getDb();
  const cookies = parseCookies(req.headers.cookie || '');
  if (cookies[SESSION_COOKIE_NAME]) {
    const verified = verifySessionToken(cookies[SESSION_COOKIE_NAME]);
    if (verified && verified.email) {
      const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(verified.email);
      if (user) return user;
    }
  }
  if (!IS_PROD) {
    const headerEmail = req.headers['x-admin-email'] || 'superadmin@sasynaturals.com';
    return db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(String(headerEmail).trim());
  }
  return null;
}

function createServerHandler() {
  return async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
      const db = getDb();

      // 1. Static Assets (/assets/*, /images/*, /uploads/*)
      if (pathname.startsWith('/assets/') || pathname.startsWith('/images/') || pathname.startsWith('/uploads/')) {
        const filePath = path.join(__dirname, 'public', pathname);
        if (!filePath.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(filePath)) {
          res.writeHead(404);
          return res.end('Asset not found');
        }
        const ext = path.extname(filePath).toLowerCase();
        const mimeMap = {
          '.css': 'text/css; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.wasm': 'application/wasm',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml'
        };
        res.writeHead(200, {
          'Content-Type': mimeMap[ext] || 'application/octet-stream',
          'Cache-Control': 'public, max-age=3600'
        });
        return fs.createReadStream(filePath).pipe(res);
      }

      // 2. Discovery Endpoints (/robots.txt, /sitemap.xml, /llms.txt)
      if (pathname === '/robots.txt') {
        const txt = [
          'User-agent: *',
          'Allow: /',
          'Allow: /llms.txt',
          'Disallow: /admin',
          'Disallow: /orders/',
          'Disallow: /api/',
          '',
          `Sitemap: ${CANONICAL_ORIGIN}/sitemap.xml`
        ].join('\n');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(txt);
      }

      if (pathname === '/sitemap.xml') {
        const cats = db.prepare('SELECT slug FROM categories WHERE is_active = 1').all();
        const prods = db.prepare('SELECT slug FROM products WHERE is_active = 1').all();
        const urls = [
          '/',
          '/shop',
          ...cats.map(c => `/category/${c.slug}`),
          ...prods.map(p => `/product/${p.slug}`),
          '/track-order',
          '/about',
          '/contact',
          '/faq',
          '/privacy',
          '/terms',
          '/shipping-returns'
        ];
        const xml = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
          ...urls.map(u => `  <url><loc>${CANONICAL_ORIGIN}${u}</loc><changefreq>daily</changefreq></url>`),
          '</urlset>'
        ].join('\n');
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
        return res.end(xml);
      }

      if (pathname === '/llms.txt') {
        const cats = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY display_order').all();
        const prods = db.prepare('SELECT * FROM products WHERE is_active = 1 ORDER BY id').all();
        const lines = [
          `# ${BRAND_NAME} (${CANONICAL_ORIGIN})`,
          '',
          `> ${BRAND_TAGLINE}. Direct-to-customer Indian e-commerce platform offering 100 g, 250 g, 500 g, and 1 kg pack-size variants with Razorpay & Cash on Delivery.`,
          '',
          '## Core Categories',
          ...cats.map(c => `- [${c.name}](${CANONICAL_ORIGIN}/category/${c.slug}): ${c.description}`),
          '',
          '## Product Catalogue',
          ...prods.map(p => `- [${p.name}](${CANONICAL_ORIGIN}/product/${p.slug}): ${p.short_description} (HSN: ${p.hsn_code}, Origin: ${p.origin_region}, Batch: ${p.harvest_batch})`)
        ];
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        return res.end(lines.join('\n'));
      }

      // 3. Markdown Twins (*.md)
      if (pathname.endsWith('.md')) {
        const baseRoute = pathname.slice(0, -3) || '/';
        if (baseRoute === '/index' || baseRoute === '/') {
          const prods = db.prepare('SELECT * FROM products WHERE is_active = 1').all();
          const md = renderMarkdownTwin({
            title: `${BRAND_NAME} | ${BRAND_TAGLINE}`,
            canonicalPath: '/',
            description: 'Direct-to-customer dry fruits, unpolished millets, and single-origin spices.',
            sections: prods.map(p => ({ heading: p.name, body: `${p.description} (Origin: ${p.origin_region})` }))
          });
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
          return res.end(md);
        }
        if (baseRoute.startsWith('/product/')) {
          const slug = baseRoute.replace('/product/', '');
          const product = db.prepare('SELECT * FROM products WHERE slug = ? AND is_active = 1').get(slug);
          if (!product) {
            res.writeHead(404);
            return res.end('Not found');
          }
          const pVars = db.prepare('SELECT * FROM product_variants WHERE product_id = ? AND is_active = 1').all(product.id);
          const md = renderMarkdownTwin({
            title: product.name,
            canonicalPath: `/product/${product.slug}`,
            description: product.short_description,
            sections: [
              { heading: 'Product Overview', body: product.description },
              { heading: 'Origin & Compliance', body: `Origin: ${product.origin_region} | HSN: ${product.hsn_code} | Batch: ${product.harvest_batch} | Ingredients: ${product.ingredients} | Allergens: ${product.allergen_info}` },
              { heading: 'Available Pack Variants', body: pVars.map(v => `- ${v.pack_label} (${v.sku}): Rs. ${(v.selling_price_paise / 100).toFixed(2)} (MRP Rs. ${(v.mrp_paise / 100).toFixed(2)})`).join('\n') }
            ]
          });
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
          return res.end(md);
        }
      }

      // 4. REST API Endpoints
      if (pathname === '/api/health') {
        return sendJson(res, 200, {
          status: 'ok',
          appVersion: APP_VERSION,
          engine: 'node22-ssr-rust-wasm',
          port: PORT
        });
      }

      if (pathname === '/api/admin/auth/login' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const clientIp = req.socket.remoteAddress || '127.0.0.1';
        const authResult = loginAdminWithPassword(body.email, body.password, clientIp);
        return sendJson(
          res,
          200,
          { user: authResult.user, csrfToken: authResult.csrfToken },
          { 'Set-Cookie': buildSessionCookieHeader(authResult.sessionToken, false) }
        );
      }

      if (pathname === '/api/admin/auth/logout' && req.method === 'POST') {
        return sendJson(
          res,
          200,
          { loggedOut: true },
          { 'Set-Cookie': buildSessionCookieHeader('', true) }
        );
      }

      if (pathname === '/api/admin/vault/status' && req.method === 'GET') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'settings.manage');
        return sendJson(res, 200, { vault: listVaultStatus() });
      }

      if (pathname === '/api/admin/vault/seal' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'settings.manage');
        const body = await readJsonBody(req);
        const sealed = saveVaultCredential({
          keyName: body.keyName,
          secretValue: body.secretValue,
          actorEmail: adminUser.email,
          actorRole: adminUser.role
        });
        return sendJson(res, 200, sealed);
      }

      if (pathname === '/api/checkout/cod-otp/request' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const otpRes = requestCodOtp(body.phone);
        return sendJson(res, 200, otpRes);
      }

      if (pathname === '/api/checkout/cod-otp/verify' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const verRes = verifyCodOtp(body.phone, body.otpCode);
        return sendJson(res, 200, verRes);
      }

      if (pathname === '/api/checkout/pincode/check' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const pinRes = validatePincodeServiceability(body.pincode, body.paymentMethod || 'ONLINE_UPI');
        return sendJson(res, 200, pinRes);
      }

      if (pathname === '/api/cart/calculate' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const pricing = calculateCartPricing(
          body.items || [],
          body.couponCode || '',
          body.paymentMethod || 'ONLINE_UPI',
          body.shippingState || 'Karnataka',
          body.shippingPincode || '560001'
        );
        return sendJson(res, 200, { pricing });
      }

      if (pathname === '/api/orders/create' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const orderResult = createOrder(body);
        return sendJson(res, 201, orderResult);
      }

      if (pathname === '/api/payments/verify' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const verifyResult = verifyAndCaptureOnlinePayment(body);
        return sendJson(res, 200, verifyResult);
      }

      if (pathname === '/api/admin/orders/fulfilment' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'shipping.update');
        const body = await readJsonBody(req);
        const updated = updateOrderFulfilmentAndShipping({
          ...body,
          actorEmail: adminUser.email,
          actorRole: adminUser.role
        });
        return sendJson(res, 200, { order: updated });
      }

      if (pathname === '/api/admin/inventory/adjust' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'inventory.write');
        const body = await readJsonBody(req);
        const variantId = Number(body.variantId);
        const newStockQty = Math.max(0, Number(body.newStockQty));
        const variant = db.prepare('SELECT * FROM product_variants WHERE id = ?').get(variantId);
        if (!variant) return sendJson(res, 404, { error: 'Variant not found' });

        const delta = newStockQty - variant.stock_qty;
        db.prepare('UPDATE product_variants SET stock_qty = ? WHERE id = ?').run(newStockQty, variantId);
        db.prepare(`
          INSERT INTO inventory_movements (variant_id, delta_qty, previous_qty, new_qty, reason, reference_id, actor_name)
          VALUES (?, ?, ?, ?, ?, 'ADMIN_PORTAL', ?)
        `).run(variantId, delta, variant.stock_qty, newStockQty, body.reason || 'ADMIN_STOCK_UPDATE', adminUser.email);

        recordAuditLog({
          actorId: adminUser.id,
          actorEmail: adminUser.email,
          actorRole: adminUser.role,
          action: 'INVENTORY_ADJUSTED',
          entityType: 'VARIANT',
          entityId: variant.sku,
          details: { previousQty: variant.stock_qty, newQty: newStockQty }
        });

        return sendJson(res, 200, { variantId, newStockQty });
      }

      if (pathname === '/api/admin/products/upload-image' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'products.write');
        const body = await readJsonBody(req);
        const uploadRes = uploadProductImage({
          productId: body.productId,
          imageBase64: body.imageBase64,
          caption: body.caption,
          setAsPrimary: Boolean(body.setAsPrimary),
          actorEmail: adminUser.email,
          actorRole: adminUser.role
        });
        return sendJson(res, 201, uploadRes);
      }

      if (pathname === '/api/admin/products/create' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'products.write');
        const body = await readJsonBody(req);

        const lintCheck = lintContentText(`${body.name || ''} ${body.shortDescription || ''}`, 'new_product');
        if (!lintCheck.valid) {
          return sendJson(res, 400, { error: lintCheck.issues.join(' ') });
        }

        const slug = String(body.name || 'new-product')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
        const skuBase = String(body.skuBase || 'SN-NEW').trim().toUpperCase();
        const catId = Number(body.categoryId || 3);
        const base100gPaise = Math.max(1000, Math.round(Number(body.base100gInr || 150) * 100));
        const gstPercent = Number(body.gstPercent || 5);

        const prodRes = db.prepare(`
          INSERT INTO products (
            sku_base, slug, name, category_id, short_description, description,
            origin_region, harvest_batch, shelf_life_months, fssai_notes,
            ingredients, allergen_info, gst_percent, hsn_code, image_url, image_caption,
            is_featured, is_new_arrival, is_bestseller, is_active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SN-BATCH-2611', 12, 'Store in a cool, dry container.', ?, 'Packed in a facility handling tree nuts.', ?, '091030', '/images/cat-spices.jpg', ?, 0, 1, 0, 1)
        `).run(
          skuBase,
          slug,
          body.name,
          catId,
          body.shortDescription,
          body.shortDescription,
          body.originRegion || 'India',
          `100% Pure ${body.name}`,
          gstPercent,
          body.name
        );

        const newProdId = Number(prodRes.lastInsertRowid);
        const packs = [
          { label: '100 g', grams: 100, suffix: '100G', mult: 1.0 },
          { label: '250 g', grams: 250, suffix: '250G', mult: 2.35 },
          { label: '500 g', grams: 500, suffix: '500G', mult: 4.45 },
          { label: '1 kg',  grams: 1000, suffix: '1KG', mult: 8.5 }
        ];
        for (const pm of packs) {
          const sell = Math.round(base100gPaise * pm.mult);
          const mrp = Math.round(sell * 1.15);
          db.prepare(`
            INSERT INTO product_variants (product_id, sku, pack_label, weight_grams, mrp_paise, selling_price_paise, promo_price_paise, stock_qty)
            VALUES (?, ?, ?, ?, ?, ?, ?, 40)
          `).run(newProdId, `${skuBase}-${pm.suffix}`, pm.label, pm.grams, mrp, sell, sell);
        }

        recordAuditLog({
          actorId: adminUser.id,
          actorEmail: adminUser.email,
          actorRole: adminUser.role,
          action: 'PRODUCT_CREATED',
          entityType: 'PRODUCT',
          entityId: skuBase,
          details: { name: body.name, slug }
        });

        return sendJson(res, 201, { product: { id: newProdId, name: body.name, slug } });
      }

      // 5. Storefront, GST Tax Invoice & Admin SSR HTML Routes
      const categories = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY display_order').all();
      const allProducts = db.prepare('SELECT * FROM products WHERE is_active = 1 ORDER BY id').all();
      const allVariants = db.prepare('SELECT * FROM product_variants WHERE is_active = 1 ORDER BY weight_grams').all();

      if (pathname === '/') {
        const html = renderHomePage({ categories, products: allProducts, variants: allVariants });
        return sendHtml(res, 200, html, '/');
      }

      if (pathname.startsWith('/orders/') && pathname.endsWith('/invoice')) {
        const ordNum = decodeURIComponent(pathname.replace('/orders/', '').replace('/invoice', '')).trim().toUpperCase();
        const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(ordNum);
        if (!order) {
          res.writeHead(404);
          return res.end('Order invoice not found');
        }
        const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
        const settingsRows = db.prepare('SELECT * FROM store_settings').all();
        const settingsMap = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));
        const html = renderGstInvoicePage({ order, orderItems, settingsMap });
        return sendHtml(res, 200, html, pathname);
      }

      if (pathname === '/shop' || pathname.startsWith('/category/')) {
        let activeCategory = null;
        if (pathname.startsWith('/category/')) {
          const catSlug = pathname.replace('/category/', '');
          activeCategory = categories.find(c => c.slug === catSlug);
          if (!activeCategory) {
            res.writeHead(404);
            return res.end('Category not found');
          }
        }

        const q = (parsedUrl.searchParams.get('q') || '').trim();
        const sort = parsedUrl.searchParams.get('sort') || 'featured';
        let filtered = activeCategory
          ? allProducts.filter(p => p.category_id === activeCategory.id)
          : [...allProducts];

        if (q) {
          const ql = q.toLowerCase();
          filtered = filtered.filter(p =>
            p.name.toLowerCase().includes(ql) ||
            p.short_description.toLowerCase().includes(ql) ||
            p.origin_region.toLowerCase().includes(ql)
          );
        }

        if (sort === 'price_asc' || sort === 'price_desc') {
          const minPriceMap = new Map();
          for (const p of filtered) {
            const pVars = allVariants.filter(v => v.product_id === p.id);
            minPriceMap.set(p.id, pVars.length ? Math.min(...pVars.map(v => v.selling_price_paise)) : 0);
          }
          filtered.sort((a, b) =>
            sort === 'price_asc'
              ? minPriceMap.get(a.id) - minPriceMap.get(b.id)
              : minPriceMap.get(b.id) - minPriceMap.get(a.id)
          );
        }

        const html = renderCatalogPage({
          categories,
          activeCategory,
          products: filtered,
          variants: allVariants,
          searchQuery: q,
          sortBy: sort
        });
        return sendHtml(res, 200, html, pathname);
      }

      if (pathname.startsWith('/product/')) {
        const prodSlug = pathname.replace('/product/', '');
        const product = allProducts.find(p => p.slug === prodSlug);
        if (!product) {
          res.writeHead(404);
          return res.end('Product not found');
        }
        const category = categories.find(c => c.id === product.category_id) || categories[0];
        const prodVariants = allVariants.filter(v => v.product_id === product.id);
        const relatedProducts = allProducts
          .filter(p => p.category_id === product.category_id && p.id !== product.id)
          .slice(0, 3);

        const html = renderProductDetailPage({
          product,
          category,
          variants: prodVariants,
          relatedProducts,
          allVariants
        });
        return sendHtml(res, 200, html, pathname);
      }

      if (pathname === '/checkout' || pathname === '/cart') {
        const coupons = db.prepare('SELECT * FROM coupons WHERE is_active = 1').all();
        const html = renderCheckoutPage({ coupons });
        return sendHtml(res, 200, html, '/checkout');
      }

      if (pathname === '/track-order') {
        const ordNum = (parsedUrl.searchParams.get('order') || 'SN-2026-1001').trim().toUpperCase();
        const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(ordNum);
        const orderItems = order
          ? db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id)
          : [];
        const html = renderTrackOrderPage({ order, orderItems, queryOrderNumber: ordNum });
        return sendHtml(res, 200, html, '/track-order');
      }

      if (pathname === '/admin') {
        const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
        const payments = db.prepare('SELECT * FROM payments ORDER BY id DESC').all();
        const staffUsers = db.prepare("SELECT * FROM users WHERE role != 'CUSTOMER' ORDER BY id").all();
        const auditLogs = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 30').all();
        const settings = db.prepare('SELECT * FROM store_settings ORDER BY key').all();
        const movements = db.prepare('SELECT * FROM inventory_movements ORDER BY id DESC LIMIT 25').all();
        const vaultStatus = listVaultStatus();

        const html = renderAdminPortalPage({
          categories,
          products: allProducts,
          variants: allVariants,
          orders,
          payments,
          staffUsers,
          auditLogs,
          settings,
          movements,
          vaultStatus
        });
        return sendHtml(res, 200, html, '/admin');
      }

      const infoKey = pathname.slice(1);
      if (INFO_PAGES[infoKey]) {
        const page = INFO_PAGES[infoKey];
        const html = renderStaticInfoPage({
          slug: infoKey,
          title: page.title,
          subtitle: page.subtitle,
          paragraphs: page.paragraphs
        });
        return sendHtml(res, 200, html, pathname);
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    } catch (err) {
      const code = err.statusCode || 400;
      sendJson(res, code, { error: err.message });
    }
  };
}

function startServer(port = PORT) {
  getDb();
  const server = http.createServer(createServerHandler());
  server.on('error', (err) => {
    console.error(`[FATAL_PORT_BIND_ERROR] Failed to bind strictly to port ${port}:`, err.message);
    process.exit(1);
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`[Sasya Naturals SSR + Rust WASM] Live on http://localhost:${port} (APP_VERSION=${APP_VERSION})`);
  });
  return server;
}

if (require.main === module) {
  startServer(PORT);
}

module.exports = {
  INFO_PAGES,
  createServerHandler,
  startServer
};
