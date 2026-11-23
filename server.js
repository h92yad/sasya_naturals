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
const { getDb, hashPassword } = require('./src/db/database');
const {
  calculateCartPricing,
  createOrder,
  createAdminOrder,
  verifyAndCaptureOnlinePayment,
  updateOrderFulfilmentAndShipping,
  recordPaymentAdminAction,
  updateOrderDeliveryAddress
} = require('./src/core/checkout/checkoutEngine');
const {
  requestCodOtp,
  verifyCodOtp,
  validatePincodeServiceability
} = require('./src/core/checkout/codProtection');
const {
  uploadProductImage,
  uploadCategoryImage,
  saveVerifiedImageToUploads
} = require('./src/core/checkout/imageUploader');
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
  CUSTOMER_COOKIE_NAME,
  verifySessionToken,
  loginAdminWithPassword,
  loginCustomerWithPassword,
  registerCustomerAccount,
  changeUserPassword,
  requestPasswordResetOtp,
  resetPasswordWithOtp,
  parseCookies,
  buildSessionCookieHeader,
  buildCustomerCookieHeader
} = require('./src/core/auth/sessionManager');
const { lintContentText } = require('./src/core/content/contentLinter');
const {
  getStorefrontContentAndSeo,
  updateHomepageContent,
  updateInfoPageContent,
  updateRouteSeoMeta,
  buildUsersAndPurchasesExportCsv
} = require('./src/core/content/contentStore');
const {
  renderHomePage,
  renderCatalogPage,
  renderProductDetailPage,
  renderCheckoutPage,
  renderTrackOrderPage,
  renderGstInvoicePage,
  renderCustomerAccountPage,
  renderAdminLoginRequiredPage,
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
    subtitle: '4-Zone + 500g Weight-Slab Courier Dispatch, Damaged Parcel Replacement & Refund Timelines',
    paragraphs: [
      'Delivery charges are calculated transparently using our 4-Zone (Local Bengaluru, South India, National, and Remote/NE) + 500g billable weight-slab engine (including 150g protective carton tare weight). Orders meeting the active free-delivery threshold and weight cap qualify for complimentary shipping.',
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

function resolveCustomerUser(req) {
  const db = getDb();
  const cookies = parseCookies(req.headers.cookie || '');
  const cookieVal = cookies[CUSTOMER_COOKIE_NAME];
  if (cookieVal === 'LOGGED_OUT') {
    return null;
  }
  if (cookieVal) {
    const verified = verifySessionToken(cookieVal);
    if (verified && verified.email) {
      const user = db.prepare('SELECT * FROM users WHERE lower(email) = ? AND is_active = 1').get(verified.email.toLowerCase());
      if (user) return user;
    }
    return null;
  }
  if (!IS_PROD) {
    return db.prepare("SELECT * FROM users WHERE email = 'ananya.iyer@example.com'").get();
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

      // 2. Discovery Endpoints (/favicon.ico, /robots.txt, /sitemap.xml, /llms.txt)
      if (pathname === '/favicon.ico') {
        const svgFavicon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#143022"/><text x="16" y="22" font-family="Georgia,serif" font-size="18" font-weight="bold" fill="#FAF6EE" text-anchor="middle">S</text></svg>';
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
        return res.end(svgFavicon);
      }

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
        const infoSlug = baseRoute.replace(/^\/+/, '');
        const liveInfoPages = getStorefrontContentAndSeo().infoPages;
        if (liveInfoPages[infoSlug]) {
          const pg = liveInfoPages[infoSlug];
          const md = renderMarkdownTwin({
            title: pg.title,
            canonicalPath: `/${infoSlug}`,
            description: pg.subtitle,
            sections: pg.paragraphs.map((p, idx) => ({ heading: `Section ${idx + 1}`, body: p }))
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

      // Customer Account Auth, Profile & Saved Delivery Addresses APIs (Section 4)
      if (pathname === '/api/account/login' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const clientIp = req.socket.remoteAddress || '127.0.0.1';
        const authRes = loginCustomerWithPassword(body.email, body.password, clientIp);
        return sendJson(
          res,
          200,
          { user: authRes.user },
          { 'Set-Cookie': buildCustomerCookieHeader(authRes.sessionToken, false) }
        );
      }

      if (pathname === '/api/account/register' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const regRes = registerCustomerAccount(body);
        return sendJson(
          res,
          201,
          { user: regRes.user },
          { 'Set-Cookie': buildCustomerCookieHeader(regRes.sessionToken, false) }
        );
      }

      if (pathname === '/api/account/logout' && req.method === 'POST') {
        return sendJson(
          res,
          200,
          { loggedOut: true },
          { 'Set-Cookie': buildCustomerCookieHeader('', true) }
        );
      }

      if (pathname === '/api/account/profile' && req.method === 'POST') {
        const cust = resolveCustomerUser(req);
        if (!cust) return sendJson(res, 401, { error: 'Please sign in to update your profile.' });
        const body = await readJsonBody(req);
        const fullName = String(body.fullName || cust.full_name).trim();
        const phone = String(body.phone || cust.phone).trim();
        db.prepare('UPDATE users SET full_name = ?, phone = ? WHERE id = ?').run(fullName, phone, cust.id);
        return sendJson(res, 200, { user: { id: cust.id, email: cust.email, fullName, phone } });
      }

      if (pathname === '/api/account/password/change' && req.method === 'POST') {
        const cust = resolveCustomerUser(req);
        if (!cust) return sendJson(res, 401, { error: 'Please sign in to change your password.' });
        const body = await readJsonBody(req);
        const changed = changeUserPassword({
          userId: cust.id,
          currentPassword: body.currentPassword,
          newPassword: body.newPassword
        });
        return sendJson(res, 200, changed);
      }

      if (pathname === '/api/account/password/reset-otp/request' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const otpInfo = requestPasswordResetOtp(body.email);
        return sendJson(res, 200, otpInfo);
      }

      if (pathname === '/api/account/password/reset-otp/confirm' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const resetRes = resetPasswordWithOtp({
          email: body.email,
          otpCode: body.otpCode,
          newPassword: body.newPassword
        });
        const cookieHeader = resetRes.user.role === 'CUSTOMER'
          ? buildCustomerCookieHeader(resetRes.sessionToken, false)
          : buildSessionCookieHeader(resetRes.sessionToken, false);
        return sendJson(
          res,
          200,
          { user: resetRes.user },
          { 'Set-Cookie': cookieHeader }
        );
      }

      if (pathname === '/api/account/addresses/add' && req.method === 'POST') {
        const cust = resolveCustomerUser(req);
        if (!cust) return sendJson(res, 401, { error: 'Please sign in to manage addresses.' });
        const body = await readJsonBody(req);
        const label = String(body.label || 'Home').trim();
        const recipientName = String(body.recipientName || cust.full_name).trim();
        const phone = String(body.phone || cust.phone).trim();
        const line1 = String(body.line1 || '').trim();
        const line2 = String(body.line2 || '').trim();
        const city = String(body.city || '').trim();
        const state = String(body.state || '').trim();
        const pincode = String(body.pincode || '').trim();
        if (!line1 || !city || !state || !/^\d{6}$/.test(pincode)) {
          return sendJson(res, 400, { error: 'Complete street address, city, state, and 6-digit PIN code are required.' });
        }
        const info = db.prepare(`
          INSERT INTO customer_addresses (user_id, label, recipient_name, phone, line1, line2, city, state, pincode, is_default)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `).run(cust.id, label, recipientName, phone, line1, line2, city, state, pincode);
        return sendJson(res, 201, {
          address: {
            id: Number(info.lastInsertRowid),
            user_id: cust.id,
            label,
            recipient_name: recipientName,
            phone,
            line1,
            line2,
            city,
            state,
            pincode,
            is_default: 0
          }
        });
      }

      if (pathname === '/api/account/addresses/default' && req.method === 'POST') {
        const cust = resolveCustomerUser(req);
        if (!cust) return sendJson(res, 401, { error: 'Please sign in.' });
        const body = await readJsonBody(req);
        const addrId = Number(body.addressId);
        db.prepare('UPDATE customer_addresses SET is_default = 0 WHERE user_id = ?').run(cust.id);
        db.prepare('UPDATE customer_addresses SET is_default = 1 WHERE id = ? AND user_id = ?').run(addrId, cust.id);
        return sendJson(res, 200, { defaultAddressId: addrId });
      }

      if (pathname === '/api/account/addresses/delete' && req.method === 'POST') {
        const cust = resolveCustomerUser(req);
        if (!cust) return sendJson(res, 401, { error: 'Please sign in.' });
        const body = await readJsonBody(req);
        const addrId = Number(body.addressId);
        db.prepare('DELETE FROM customer_addresses WHERE id = ? AND user_id = ?').run(addrId, cust.id);
        return sendJson(res, 200, { deletedAddressId: addrId });
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

      if (pathname === '/api/admin/settings/shipping' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'settings.manage');
        const body = await readJsonBody(req);
        const { updateShippingPolicySettings } = require('./src/core/checkout/checkoutEngine');
        const policy = updateShippingPolicySettings(body, adminUser.email, adminUser.role);
        return sendJson(res, 200, { policy });
      }

      if (pathname === '/api/admin/settings/compliance' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'settings.manage');
        const body = await readJsonBody(req);
        const allowedKeys = [
          'business_legal_name',
          'gstin',
          'fssai_license',
          'support_email',
          'support_phone',
          'registered_address',
          'email_template_order_confirmed',
          'email_template_order_shipped',
          'email_template_order_delivered',
          'email_template_order_cancelled'
        ];
        const upsert = db.prepare("INSERT OR REPLACE INTO store_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))");
        const updated = {};
        for (const k of allowedKeys) {
          if (body[k] !== undefined) {
            const val = String(body[k]).trim();
            upsert.run(k, val);
            updated[k] = val;
          }
        }
        recordAuditLog({
          actorId: adminUser.id,
          actorEmail: adminUser.email,
          actorRole: adminUser.role,
          action: 'COMPLIANCE_AND_TEMPLATES_UPDATED',
          entityType: 'SETTINGS',
          entityId: 'COMPLIANCE_TEMPLATES',
          details: updated
        });
        return sendJson(res, 200, { settings: updated });
      }

      if (pathname === '/api/admin/reports/summary' && req.method === 'GET') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'reports.view');
        const { buildComprehensiveReports } = require('./src/core/reports/reportingEngine');
        const reports = buildComprehensiveReports({
          orders: db.prepare('SELECT * FROM orders ORDER BY id DESC').all(),
          orderItems: db.prepare('SELECT * FROM order_items ORDER BY id DESC').all(),
          payments: db.prepare('SELECT * FROM payments ORDER BY id DESC').all(),
          products: db.prepare('SELECT * FROM products ORDER BY id').all(),
          categories: db.prepare('SELECT * FROM categories ORDER BY display_order').all()
        });
        return sendJson(res, 200, { reports });
      }

      if (pathname === '/api/admin/reports/export.csv' && req.method === 'GET') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'reports.view');
        const { buildComprehensiveReports, exportReportToCsv } = require('./src/core/reports/reportingEngine');
        const reportType = parsedUrl.searchParams.get('type') || 'daily';
        const reports = buildComprehensiveReports({
          orders: db.prepare('SELECT * FROM orders ORDER BY id DESC').all(),
          orderItems: db.prepare('SELECT * FROM order_items ORDER BY id DESC').all(),
          payments: db.prepare('SELECT * FROM payments ORDER BY id DESC').all(),
          products: db.prepare('SELECT * FROM products ORDER BY id').all(),
          categories: db.prepare('SELECT * FROM categories ORDER BY display_order').all()
        });
        const csvContent = exportReportToCsv(reports, reportType);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="sasya-naturals-report-${reportType}.csv"`,
          'Cache-Control': 'no-store'
        });
        return res.end(csvContent);
      }

      if (pathname === '/api/admin/users/export.csv' && req.method === 'GET') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'customers.view');
        const exportType = parsedUrl.searchParams.get('type') === 'user_purchases' ? 'user_purchases' : 'users_summary';
        const csvContent = buildUsersAndPurchasesExportCsv({
          customerUsers: db.prepare("SELECT * FROM users WHERE role = 'CUSTOMER' ORDER BY id").all(),
          customerAddresses: db.prepare('SELECT * FROM customer_addresses ORDER BY id').all(),
          orders: db.prepare('SELECT * FROM orders ORDER BY id DESC').all(),
          orderItems: db.prepare('SELECT * FROM order_items ORDER BY id DESC').all(),
          exportType
        });
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="sasya-naturals-${exportType}.csv"`,
          'Cache-Control': 'no-store'
        });
        return res.end(csvContent);
      }

      if (pathname === '/api/admin/content/homepage' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'settings.manage');
        const body = await readJsonBody(req);
        const homepage = updateHomepageContent(body, {
          actorId: adminUser.id,
          actorEmail: adminUser.email,
          actorRole: adminUser.role
        });
        return sendJson(res, 200, { homepage });
      }

      if (pathname === '/api/admin/content/page' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'settings.manage');
        const body = await readJsonBody(req);
        const page = updateInfoPageContent(
          {
            slug: body.slug,
            title: body.title,
            subtitle: body.subtitle,
            paragraphsText: body.paragraphsText || body.paragraphs
          },
          {
            actorId: adminUser.id,
            actorEmail: adminUser.email,
            actorRole: adminUser.role
          }
        );
        return sendJson(res, 200, { page });
      }

      if (pathname === '/api/admin/content/seo' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'settings.manage');
        const body = await readJsonBody(req);
        const seo = updateRouteSeoMeta(
          {
            routePath: body.routePath,
            metaTitle: body.metaTitle,
            metaDescription: body.metaDescription,
            ogImagePath: body.ogImagePath
          },
          {
            actorId: adminUser.id,
            actorEmail: adminUser.email,
            actorRole: adminUser.role
          }
        );
        return sendJson(res, 200, { seo });
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

      if (pathname === '/api/admin/orders/create' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'orders.write');
        const body = await readJsonBody(req);
        const created = createAdminOrder({
          ...body,
          actorId: adminUser.id,
          actorEmail: adminUser.email,
          actorRole: adminUser.role
        });
        return sendJson(res, 201, created);
      }

      if (pathname === '/api/admin/orders/fulfilment' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'shipping.update');
        const body = await readJsonBody(req);
        if (body.fulfilmentStatus === 'Refunded') {
          assertAdminPermission(adminUser, 'payments.refund');
        }
        const manualShippingChargePaise = body.manualShippingChargePaise !== undefined
          ? Number(body.manualShippingChargePaise)
          : (body.manualShippingChargeInr !== undefined && String(body.manualShippingChargeInr).trim() !== ''
            ? Math.round(Number(body.manualShippingChargeInr) * 100)
            : null);
        const updated = updateOrderFulfilmentAndShipping({
          ...body,
          manualShippingChargePaise,
          actorEmail: adminUser.email,
          actorRole: adminUser.role
        });
        return sendJson(res, 200, { order: updated });
      }

      if (pathname === '/api/admin/orders/update-address' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'shipping.update');
        const body = await readJsonBody(req);
        const updated = updateOrderDeliveryAddress({
          ...body,
          actorEmail: adminUser.email,
          actorRole: adminUser.role
        });
        return sendJson(res, 200, { order: updated });
      }

      if (pathname === '/api/admin/payments/action' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'payments.refund');
        const body = await readJsonBody(req);
        const updatedOrder = recordPaymentAdminAction({
          orderNumber: body.orderNumber,
          actionType: body.actionType,
          refundReason: body.refundReason,
          refundAmountPaise: body.refundAmountInr ? Math.round(Number(body.refundAmountInr) * 100) : null,
          actorEmail: adminUser.email,
          actorRole: adminUser.role
        });
        return sendJson(res, 200, { order: updatedOrder });
      }

      if (pathname === '/api/admin/inventory/adjust' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'inventory.write');
        const body = await readJsonBody(req);
        const variantId = Number(body.variantId);
        if (!Number.isFinite(Number(body.newStockQty))) {
          return sendJson(res, 400, { error: 'Valid numeric stock quantity is required.' });
        }
        const newStockQty = Math.max(0, Math.floor(Number(body.newStockQty)));
        const variant = db.prepare('SELECT * FROM product_variants WHERE id = ?').get(variantId);
        if (!variant) return sendJson(res, 404, { error: 'Variant not found' });

        const lowStockThreshold = body.lowStockThreshold !== undefined && Number.isFinite(Number(body.lowStockThreshold))
          ? Math.max(1, Math.floor(Number(body.lowStockThreshold)))
          : variant.low_stock_threshold;

        const delta = newStockQty - variant.stock_qty;
        db.prepare('UPDATE product_variants SET stock_qty = ?, low_stock_threshold = ? WHERE id = ?').run(newStockQty, lowStockThreshold, variantId);

        if (delta !== 0) {
          db.prepare(`
            INSERT INTO inventory_movements (variant_id, delta_qty, previous_qty, new_qty, reason, reference_id, actor_name)
            VALUES (?, ?, ?, ?, ?, 'ADMIN_PORTAL', ?)
          `).run(variantId, delta, variant.stock_qty, newStockQty, body.reason || 'ADMIN_STOCK_UPDATE', adminUser.email);
        }

        if (newStockQty <= lowStockThreshold && variant.stock_qty > lowStockThreshold) {
          db.prepare(`
            INSERT INTO notification_logs (order_number, channel, recipient, event_type, subject, body_preview)
            VALUES ('ADMIN_PORTAL', 'ADMIN_ALERT', 'catalog@sasynaturals.com', 'LOW_STOCK_ALERT', ?, ?)
          `).run(
            `Low Stock Alert: ${variant.sku} (${newStockQty} remaining)`,
            `Variant ${variant.sku} (${variant.pack_label}) adjusted to ${newStockQty} units (threshold: ${lowStockThreshold}).`
          );
        }

        recordAuditLog({
          actorId: adminUser.id,
          actorEmail: adminUser.email,
          actorRole: adminUser.role,
          action: 'INVENTORY_ADJUSTED',
          entityType: 'VARIANT',
          entityId: variant.sku,
          details: { previousQty: variant.stock_qty, newQty: newStockQty, lowStockThreshold, delta }
        });

        return sendJson(res, 200, {
          variantId,
          sku: variant.sku,
          newStockQty,
          lowStockThreshold,
          isLowStock: newStockQty <= lowStockThreshold
        });
      }

      if (pathname === '/api/admin/categories/create' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'products.write');
        const body = await readJsonBody(req);

        const name = String(body.name || '').trim();
        const subtitle = String(body.subtitle || '').trim();
        const description = String(body.description || '').trim();
        if (!name || !subtitle || !description) {
          return sendJson(res, 400, { error: 'Category name, subtitle, and description are required.' });
        }

        const lintCheck = lintContentText(`${name} ${subtitle} ${description}`, 'new_category');
        if (!lintCheck.valid) {
          return sendJson(res, 400, { error: lintCheck.issues.join(' ') });
        }

        const rawSlug = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
        const slug = rawSlug || `category-${Date.now()}`;
        const existingCat = db.prepare('SELECT id FROM categories WHERE slug = ? OR lower(name) = lower(?)').get(slug, name);
        if (existingCat) {
          return sendJson(res, 400, { error: `A category matching "${name}" (/${slug}) already exists.` });
        }

        let imageUrl = '/images/cat-spices.jpg';
        if (body.imageBase64) {
          const savedImg = saveVerifiedImageToUploads(body.imageBase64, `cat-${slug}`);
          imageUrl = savedImg.publicUrl;
        }

        const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM categories').get();
        const displayOrder = Number(countRow ? countRow.cnt : 3) + 1;

        const catRes = db.prepare(`
          INSERT INTO categories (slug, name, subtitle, description, image_url, display_order, is_active)
          VALUES (?, ?, ?, ?, ?, ?, 1)
        `).run(slug, name, subtitle, description, imageUrl, displayOrder);

        const newCatId = Number(catRes.lastInsertRowid);
        recordAuditLog({
          actorId: adminUser.id,
          actorEmail: adminUser.email,
          actorRole: adminUser.role,
          action: 'CATEGORY_CREATED',
          entityType: 'CATEGORY',
          entityId: slug,
          details: { id: newCatId, name, imageUrl }
        });

        return sendJson(res, 201, {
          category: { id: newCatId, slug, name, subtitle, description, imageUrl }
        });
      }

      if (pathname === '/api/admin/categories/update' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'products.write');
        const body = await readJsonBody(req);

        const catId = Number(body.categoryId);
        const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(catId);
        if (!cat) {
          return sendJson(res, 404, { error: 'Category not found' });
        }

        const nextName = body.name && String(body.name).trim() ? String(body.name).trim() : cat.name;
        const nextSubtitle = body.subtitle && String(body.subtitle).trim() ? String(body.subtitle).trim() : cat.subtitle;
        const nextDescription = body.description && String(body.description).trim()
          ? String(body.description).trim()
          : cat.description;
        const nextActive = body.isActive !== undefined && body.isActive !== ''
          ? (Number(body.isActive) ? 1 : 0)
          : cat.is_active;

        const lintCheck = lintContentText(`${nextName} ${nextSubtitle} ${nextDescription}`, 'edit_category');
        if (!lintCheck.valid) {
          return sendJson(res, 400, { error: lintCheck.issues.join(' ') });
        }

        let nextImageUrl = cat.image_url;
        if (body.imageBase64) {
          const savedImg = saveVerifiedImageToUploads(body.imageBase64, `cat-${cat.slug}`);
          nextImageUrl = savedImg.publicUrl;
        }

        db.prepare(`
          UPDATE categories
          SET name = ?,
              subtitle = ?,
              description = ?,
              image_url = ?,
              is_active = ?
          WHERE id = ?
        `).run(nextName, nextSubtitle, nextDescription, nextImageUrl, nextActive, catId);

        recordAuditLog({
          actorId: adminUser.id,
          actorEmail: adminUser.email,
          actorRole: adminUser.role,
          action: 'CATEGORY_UPDATED',
          entityType: 'CATEGORY',
          entityId: cat.slug,
          details: { categoryId: catId, name: nextName, subtitle: nextSubtitle, isActive: nextActive, imageUrl: nextImageUrl }
        });

        return sendJson(res, 200, {
          category: {
            id: catId,
            slug: cat.slug,
            name: nextName,
            subtitle: nextSubtitle,
            description: nextDescription,
            imageUrl: nextImageUrl,
            isActive: nextActive
          }
        });
      }

      if (pathname === '/api/admin/categories/toggle-status' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'products.write');
        const body = await readJsonBody(req);
        const catId = Number(body.categoryId);
        const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(catId);
        if (!cat) return sendJson(res, 404, { error: 'Category not found' });
        const nextActive = body.isActive !== undefined ? (Number(body.isActive) ? 1 : 0) : (cat.is_active ? 0 : 1);
        db.prepare('UPDATE categories SET is_active = ? WHERE id = ?').run(nextActive, catId);
        recordAuditLog({
          actorId: adminUser.id,
          actorEmail: adminUser.email,
          actorRole: adminUser.role,
          action: nextActive ? 'CATEGORY_PUBLISHED' : 'CATEGORY_DEACTIVATED',
          entityType: 'CATEGORY',
          entityId: cat.slug,
          details: { categoryId: catId, isActive: nextActive }
        });
        return sendJson(res, 200, { categoryId: catId, isActive: nextActive });
      }

      if (pathname === '/api/admin/categories/upload-image' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'products.write');
        const body = await readJsonBody(req);
        const uploadRes = uploadCategoryImage({
          categoryId: body.categoryId,
          imageBase64: body.imageBase64,
          actorEmail: adminUser.email,
          actorRole: adminUser.role
        });
        return sendJson(res, 200, uploadRes);
      }

      if (pathname === '/api/admin/products/upload-image' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'products.write');
        const body = await readJsonBody(req);
        const setAsPrimary = body.setAsPrimary !== false && body.setAsPrimary !== 'false';
        const uploadRes = uploadProductImage({
          productId: body.productId,
          imageBase64: body.imageBase64,
          caption: body.caption,
          setAsPrimary,
          actorEmail: adminUser.email,
          actorRole: adminUser.role
        });
        return sendJson(res, 201, uploadRes);
      }

      if (pathname === '/api/admin/products/create' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'products.write');
        const body = await readJsonBody(req);

        const rawName = String(body.name || '').trim();
        const rawShortDesc = String(body.shortDescription || '').trim();
        if (!rawName || !rawShortDesc) {
          return sendJson(res, 400, { error: 'Product name and short description are required.' });
        }

        const lintCheck = lintContentText(`${rawName} ${rawShortDesc}`, 'new_product');
        if (!lintCheck.valid) {
          return sendJson(res, 400, { error: lintCheck.issues.join(' ') });
        }

        let slug = rawName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
        if (!slug) {
          slug = `product-${Date.now()}`;
        }
        const skuBase = String(body.skuBase || 'SN-NEW').trim().toUpperCase();
        if (!skuBase) {
          return sendJson(res, 400, { error: 'SKU Base is required.' });
        }

        const dupProd = db.prepare('SELECT id, sku_base, slug FROM products WHERE upper(sku_base) = ? OR slug = ?').get(skuBase, slug);
        if (dupProd) {
          return sendJson(res, 400, { error: `A product with SKU Base "${skuBase}" or slug "${slug}" already exists.` });
        }

        const catId = Number(body.categoryId || 3);
        const catRow = db.prepare('SELECT * FROM categories WHERE id = ?').get(catId);
        if (!catRow) {
          return sendJson(res, 400, { error: 'Selected category does not exist.' });
        }

        const base100gInr = Number(body.base100gInr ?? 150);
        if (!Number.isFinite(base100gInr) || base100gInr < 10) {
          return sendJson(res, 400, { error: 'Base 100g price must be at least ₹10.' });
        }
        const base100gPaise = Math.round(base100gInr * 100);
        const gstPercent = Number(body.gstPercent ?? 5);
        if (![0, 5, 12, 18, 28].includes(gstPercent)) {
          return sendJson(res, 400, { error: 'GST slab must be one of 0%, 5%, 12%, 18%, or 28%.' });
        }

        const defaultHsnByCat = { 1: '080290', 2: '100829', 3: '091030' };
        const defaultImgByCat = { 1: '/images/cat-dry-fruits.jpg', 2: '/images/cat-millets-grains.jpg', 3: '/images/cat-spices.jpg' };
        const hsnCode = String(body.hsnCode || defaultHsnByCat[catId] || '091030').trim();

        let imageUrl = catRow.hero_image_url || defaultImgByCat[catId] || '/images/cat-spices.jpg';
        if (body.imageBase64) {
          const savedImg = saveVerifiedImageToUploads(body.imageBase64, slug);
          imageUrl = savedImg.publicUrl;
        }

        const prodRes = db.prepare(`
          INSERT INTO products (
            sku_base, slug, name, category_id, short_description, description,
            origin_region, harvest_batch, shelf_life_months, fssai_notes,
            ingredients, allergen_info, gst_percent, hsn_code, image_url, image_caption,
            is_featured, is_new_arrival, is_bestseller, is_active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SN-BATCH-2611', 12, 'Store in a cool, dry container.', ?, 'Packed in a facility handling tree nuts.', ?, ?, ?, ?, 0, 1, 0, 1)
        `).run(
          skuBase,
          slug,
          rawName,
          catId,
          rawShortDesc,
          rawShortDesc,
          String(body.originRegion || 'India').trim() || 'India',
          `100% Pure ${rawName}`,
          gstPercent,
          hsnCode,
          imageUrl,
          rawName
        );

        const newProdId = Number(prodRes.lastInsertRowid);
        const packs = [
          { label: '100 g', grams: 100, suffix: '100G', mult: 1.0 },
          { label: '250 g', grams: 250, suffix: '250G', mult: 2.35 },
          { label: '500 g', grams: 500, suffix: '500G', mult: 4.45 },
          { label: '1 kg',  grams: 1000, suffix: '1KG', mult: 8.5 }
        ];
        for (const pm of packs) {
          const sell = Math.round((base100gPaise / 100) * pm.mult) * 100;
          const mrp = Math.round(((sell / 100) * 1.15)) * 100;
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
          details: { name: rawName, slug, imageUrl, hsnCode }
        });

        return sendJson(res, 201, { product: { id: newProdId, name: rawName, slug, imageUrl } });
      }

      if (pathname === '/api/admin/products/update' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'products.write');
        const body = await readJsonBody(req);
        const productId = Number(body.productId);
        const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
        if (!prod) return sendJson(res, 404, { error: 'Product not found' });

        const nextName = body.name && String(body.name).trim() ? String(body.name).trim() : prod.name;
        const nextShortDesc = body.shortDescription && String(body.shortDescription).trim()
          ? String(body.shortDescription).trim()
          : prod.short_description;
        const nextDesc = body.description && String(body.description).trim()
          ? String(body.description).trim()
          : nextShortDesc;
        const nextOrigin = body.originRegion && String(body.originRegion).trim()
          ? String(body.originRegion).trim()
          : prod.origin_region;

        let nextCatId = prod.category_id;
        if (body.categoryId !== undefined && body.categoryId !== '') {
          const candidateCat = db.prepare('SELECT id FROM categories WHERE id = ?').get(Number(body.categoryId));
          if (!candidateCat) {
            return sendJson(res, 400, { error: 'Selected category does not exist.' });
          }
          nextCatId = Number(candidateCat.id);
        }

        const lintCheck = lintContentText(`${nextName} ${nextShortDesc}`, 'edit_product');
        if (!lintCheck.valid) {
          return sendJson(res, 400, { error: lintCheck.issues.join(' ') });
        }

        const nextGst = body.gstPercent !== undefined && body.gstPercent !== '' ? Number(body.gstPercent) : prod.gst_percent;
        if (![0, 5, 12, 18, 28].includes(nextGst)) {
          return sendJson(res, 400, { error: 'GST slab must be one of 0%, 5%, 12%, 18%, or 28%.' });
        }
        const nextHsn = body.hsnCode && String(body.hsnCode).trim() ? String(body.hsnCode).trim() : prod.hsn_code;
        const nextFeatured = body.isFeatured !== undefined && body.isFeatured !== '' ? (Number(body.isFeatured) ? 1 : 0) : prod.is_featured;
        const nextBestseller = body.isBestseller !== undefined && body.isBestseller !== '' ? (Number(body.isBestseller) ? 1 : 0) : prod.is_bestseller;
        const nextNewArrival = body.isNewArrival !== undefined && body.isNewArrival !== '' ? (Number(body.isNewArrival) ? 1 : 0) : prod.is_new_arrival;
        const nextActive = body.isActive !== undefined && body.isActive !== '' ? (Number(body.isActive) ? 1 : 0) : prod.is_active;

        db.prepare(`
          UPDATE products
          SET name = ?,
              category_id = ?,
              origin_region = ?,
              short_description = ?,
              description = ?,
              gst_percent = ?,
              hsn_code = ?,
              is_featured = ?,
              is_bestseller = ?,
              is_new_arrival = ?,
              is_active = ?
          WHERE id = ?
        `).run(nextName, nextCatId, nextOrigin, nextShortDesc, nextDesc, nextGst, nextHsn, nextFeatured, nextBestseller, nextNewArrival, nextActive, productId);

        if (body.base100gSellInr !== undefined && body.base100gSellInr !== '') {
          const sellInrNum = Number(body.base100gSellInr);
          if (!Number.isFinite(sellInrNum) || sellInrNum < 10) {
            return sendJson(res, 400, { error: 'Base 100g selling price must be at least ₹10.' });
          }
          const baseSellPaise = Math.round(sellInrNum * 100);
          const mrpInrNum = body.base100gMrpInr !== undefined && body.base100gMrpInr !== ''
            ? Number(body.base100gMrpInr)
            : Math.round(sellInrNum * 1.15);
          if (!Number.isFinite(mrpInrNum) || mrpInrNum < sellInrNum) {
            return sendJson(res, 400, { error: 'Base 100g MRP cannot be lower than the selling price.' });
          }
          const baseMrpPaise = Math.round(mrpInrNum * 100);
          const pVars = db.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY weight_grams ASC').all(productId);
          const v100 = pVars.find(v => v.weight_grams === 100) || pVars[0];
          const priceChanged = !v100 || v100.selling_price_paise !== baseSellPaise || v100.mrp_paise !== baseMrpPaise;
          if (priceChanged) {
            const multMap = { 100: 1.0, 250: 2.35, 500: 4.45, 1000: 8.5 };
            for (const v of pVars) {
              const mult = multMap[v.weight_grams] || (v.weight_grams / 100);
              const newSell = Math.round((baseSellPaise / 100) * mult) * 100;
              const newMrp = Math.max(newSell, Math.round((baseMrpPaise / 100) * mult) * 100);
              db.prepare('UPDATE product_variants SET selling_price_paise = ?, promo_price_paise = ?, mrp_paise = ? WHERE id = ?').run(newSell, newSell, newMrp, v.id);
            }
          }
        }

        recordAuditLog({
          actorId: adminUser.id,
          actorEmail: adminUser.email,
          actorRole: adminUser.role,
          action: 'PRODUCT_UPDATED',
          entityType: 'PRODUCT',
          entityId: prod.sku_base,
          details: { productId, name: nextName, categoryId: nextCatId, originRegion: nextOrigin, isActive: nextActive, isFeatured: nextFeatured, isBestseller: nextBestseller }
        });

        return sendJson(res, 200, { productId, name: nextName, categoryId: nextCatId, originRegion: nextOrigin, isActive: nextActive });
      }

      if (pathname === '/api/admin/staff/create' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'staff.manage');
        const body = await readJsonBody(req);
        const fullName = String(body.fullName || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const phone = String(body.phone || '').trim();
        const password = String(body.password || 'Sasya@2026');
        const role = String(body.role || 'STAFF').trim().toUpperCase();
        const allowedStaffRoles = ['SUPER_ADMIN', 'PRODUCT_MANAGER', 'ORDER_MANAGER', 'ACCOUNTS_MANAGER', 'STAFF'];
        if (!fullName || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return sendJson(res, 400, { error: 'Staff full name and a valid email address are required.' });
        }
        if (!allowedStaffRoles.includes(role)) {
          return sendJson(res, 400, { error: `Invalid staff role "${role}".` });
        }
        if (password.length < 8) {
          return sendJson(res, 400, { error: 'Temporary password must be at least 8 characters.' });
        }
        const existingUser = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email);
        if (existingUser) {
          return sendJson(res, 400, { error: `A user account with email "${email}" already exists.` });
        }
        let permsArray = String(body.permissionsCsv || 'orders.view, shipping.update')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
        if (role !== 'SUPER_ADMIN') {
          permsArray = permsArray.filter(p => p !== '*' && p !== 'staff.manage' && p !== 'settings.manage');
        }
        const passHash = hashPassword(password);
        const resStaff = db.prepare(`
          INSERT INTO users (email, full_name, phone, password_hash, role, permissions_json, is_active)
          VALUES (?, ?, ?, ?, ?, ?, 1)
        `).run(email, fullName, phone, passHash, role, JSON.stringify(permsArray));

        recordAuditLog({
          actorId: adminUser.id,
          actorEmail: adminUser.email,
          actorRole: adminUser.role,
          action: 'STAFF_USER_CREATED',
          entityType: 'USER',
          entityId: email,
          details: { fullName, role, permissions: permsArray }
        });

        return sendJson(res, 201, {
          staff: { id: Number(resStaff.lastInsertRowid), fullName, email, role, permissions: permsArray }
        });
      }

      if (pathname === '/api/admin/staff/update' && req.method === 'POST') {
        const adminUser = resolveAdminUser(req);
        assertAdminPermission(adminUser, 'staff.manage');
        const body = await readJsonBody(req);
        const userId = Number(body.userId);
        const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        if (!targetUser || targetUser.role === 'CUSTOMER') {
          return sendJson(res, 404, { error: 'Staff user not found' });
        }

        const allowedStaffRoles = ['SUPER_ADMIN', 'PRODUCT_MANAGER', 'ORDER_MANAGER', 'ACCOUNTS_MANAGER', 'STAFF'];
        const nextRole = String(body.role || targetUser.role).trim().toUpperCase();
        if (!allowedStaffRoles.includes(nextRole)) {
          return sendJson(res, 400, { error: `Invalid staff role "${nextRole}".` });
        }
        const nextActive = body.isActive !== undefined ? (Number(body.isActive) ? 1 : 0) : targetUser.is_active;

        // Guard against self-deactivation or self-demotion from SUPER_ADMIN
        if (targetUser.id === adminUser.id) {
          if (!nextActive) {
            return sendJson(res, 400, { error: 'You cannot deactivate your own active admin account.' });
          }
          if (targetUser.role === 'SUPER_ADMIN' && nextRole !== 'SUPER_ADMIN') {
            return sendJson(res, 400, { error: 'You cannot demote your own Super Admin account.' });
          }
        }

        // Guard against removing the last active SUPER_ADMIN
        if (targetUser.role === 'SUPER_ADMIN' && (nextRole !== 'SUPER_ADMIN' || !nextActive)) {
          const otherSuperAdmins = db.prepare(
            "SELECT COUNT(*) AS cnt FROM users WHERE role = 'SUPER_ADMIN' AND is_active = 1 AND id != ?"
          ).get(targetUser.id);
          if (!otherSuperAdmins || Number(otherSuperAdmins.cnt) < 1) {
            return sendJson(res, 400, { error: 'Cannot demote or deactivate the last active Super Admin account.' });
          }
        }

        let nextPermsJson = targetUser.permissions_json;
        if (body.permissionsJson !== undefined) {
          const raw = String(body.permissionsJson).trim();
          let arr = [];
          try {
            const parsed = JSON.parse(raw);
            arr = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
          } catch {
            arr = raw.split(',').map(s => s.trim()).filter(Boolean);
          }
          if (nextRole !== 'SUPER_ADMIN') {
            arr = arr.filter(p => p !== '*' && p !== 'staff.manage' && p !== 'settings.manage');
          }
          nextPermsJson = JSON.stringify(arr);
        }

        db.prepare('UPDATE users SET role = ?, permissions_json = ?, is_active = ? WHERE id = ?').run(
          nextRole,
          nextPermsJson,
          nextActive,
          userId
        );

        recordAuditLog({
          actorId: adminUser.id,
          actorEmail: adminUser.email,
          actorRole: adminUser.role,
          action: 'STAFF_PERMISSIONS_UPDATED',
          entityType: 'USER',
          entityId: targetUser.email,
          details: { role: nextRole, permissionsJson: nextPermsJson, isActive: nextActive }
        });

        return sendJson(res, 200, { userId, role: nextRole, permissionsJson: nextPermsJson, isActive: nextActive });
      }

      // 5. Storefront, Customer Account, GST Tax Invoice & Admin SSR HTML Routes
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
        const tag = parsedUrl.searchParams.get('tag') || 'all';
        const maxPrice = parsedUrl.searchParams.get('maxPrice') || 'all';
        const pack = parsedUrl.searchParams.get('pack') || 'all';
        const pageParam = Math.max(1, Number(parsedUrl.searchParams.get('page') || 1));
        const limitParam = parsedUrl.searchParams.get('limit') === 'all' ? 999 : 12;

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

        if (tag === 'bestseller') filtered = filtered.filter(p => p.is_bestseller);
        if (tag === 'featured') filtered = filtered.filter(p => p.is_featured);
        if (tag === 'new_arrival') filtered = filtered.filter(p => p.is_new_arrival);
        if (tag === 'in_stock') {
          filtered = filtered.filter(p => {
            const pv = allVariants.filter(v => v.product_id === p.id);
            return pv.some(v => v.stock_qty > 0);
          });
        }

        if (maxPrice !== 'all' && Number(maxPrice) > 0) {
          const maxPaise = Number(maxPrice) * 100;
          filtered = filtered.filter(p => {
            const pv = allVariants.filter(v => v.product_id === p.id);
            const minSell = pv.length ? Math.min(...pv.map(v => v.selling_price_paise)) : 0;
            return minSell <= maxPaise;
          });
        }

        if (pack !== 'all') {
          filtered = filtered.filter(p => {
            const pv = allVariants.filter(v => v.product_id === p.id);
            return pv.some(v => v.pack_label === pack && v.stock_qty > 0);
          });
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

        const totalMatchingCount = filtered.length;
        const totalPages = Math.max(1, Math.ceil(totalMatchingCount / limitParam));
        const currentPage = Math.min(pageParam, totalPages);
        const pagedProducts = filtered.slice((currentPage - 1) * limitParam, currentPage * limitParam);

        const html = renderCatalogPage({
          categories,
          activeCategory,
          products: pagedProducts,
          variants: allVariants,
          searchQuery: q,
          sortBy: sort,
          tagFilter: tag,
          maxPriceInr: maxPrice,
          packFilter: pack,
          currentPage,
          totalPages,
          totalMatchingCount
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
        const category = categories.find(c => c.id === product.category_id)
          || db.prepare('SELECT * FROM categories WHERE id = ?').get(product.category_id)
          || categories[0];
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
        const customer = resolveCustomerUser(req);
        const addresses = customer
          ? db.prepare('SELECT * FROM customer_addresses WHERE user_id = ? ORDER BY is_default DESC, id ASC').all(customer.id)
          : [];
        const html = renderCheckoutPage({ coupons, customer, addresses });
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

      if (pathname === '/account') {
        const customer = resolveCustomerUser(req);
        const addresses = customer
          ? db.prepare('SELECT * FROM customer_addresses WHERE user_id = ? ORDER BY is_default DESC, id ASC').all(customer.id)
          : [];
        const custOrders = customer
          ? db.prepare('SELECT * FROM orders WHERE user_id = ? OR lower(customer_email) = ? ORDER BY id DESC').all(customer.id, customer.email.toLowerCase())
          : db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 5').all();
        const allOrderItems = db.prepare('SELECT * FROM order_items').all();
        const html = renderCustomerAccountPage({
          customer,
          addresses,
          orders: custOrders,
          orderItems: allOrderItems
        });
        return sendHtml(res, 200, html, '/account');
      }

      if (pathname === '/admin') {
        const adminUser = resolveAdminUser(req);
        if (!adminUser) {
          const loginHtml = renderAdminLoginRequiredPage({});
          return sendHtml(res, 200, loginHtml, '/admin');
        }
        const allCategoriesAdmin = db.prepare('SELECT * FROM categories ORDER BY display_order').all();
        const allProductsAdmin = db.prepare('SELECT * FROM products ORDER BY id').all();
        const allVariantsAdmin = db.prepare('SELECT * FROM product_variants ORDER BY product_id, weight_grams').all();
        const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
        const orderItems = db.prepare('SELECT * FROM order_items ORDER BY id DESC').all();
        const payments = db.prepare('SELECT * FROM payments ORDER BY id DESC').all();
        const staffUsers = db.prepare("SELECT * FROM users WHERE role != 'CUSTOMER' ORDER BY id").all();
        const customerUsers = db.prepare("SELECT * FROM users WHERE role = 'CUSTOMER' ORDER BY id").all();
        const customerAddresses = db.prepare('SELECT * FROM customer_addresses ORDER BY id').all();
        const auditLogs = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 250').all();
        const notificationLogs = db.prepare('SELECT * FROM notification_logs ORDER BY id DESC LIMIT 250').all();
        const settings = db.prepare('SELECT * FROM store_settings ORDER BY key').all();
        const movements = db.prepare('SELECT * FROM inventory_movements ORDER BY id DESC LIMIT 250').all();
        const vaultStatus = listVaultStatus();

        const html = renderAdminPortalPage({
          categories: allCategoriesAdmin,
          products: allProductsAdmin,
          variants: allVariantsAdmin,
          orders,
          orderItems,
          payments,
          staffUsers,
          customerUsers,
          customerAddresses,
          auditLogs,
          notificationLogs,
          settings,
          movements,
          vaultStatus,
          authenticatedAdmin: adminUser
        });
        return sendHtml(res, 200, html, '/admin');
      }

      const infoKey = pathname.slice(1);
      const liveInfoPages = getStorefrontContentAndSeo().infoPages;
      if (liveInfoPages[infoKey] || INFO_PAGES[infoKey]) {
        const page = liveInfoPages[infoKey] || INFO_PAGES[infoKey];
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
