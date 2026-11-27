'use strict';

const assert = require('node:assert');
const { getDb } = require('../src/db/database');
const { assertAdminPermission, recordAuditLog } = require('../src/core/auth/rbac');

function runVerifyRbacAndAudit() {
  const db = getDb();
  const superAdmin = db.prepare("SELECT * FROM users WHERE role = 'SUPER_ADMIN'").get();
  const productMgr = db.prepare("SELECT * FROM users WHERE role = 'PRODUCT_MANAGER'").get();
  const orderMgr = db.prepare("SELECT * FROM users WHERE role = 'ORDER_MANAGER'").get();
  const accountsMgr = db.prepare("SELECT * FROM users WHERE role = 'ACCOUNTS_MANAGER'").get();
  const staffUser = db.prepare("SELECT * FROM users WHERE role = 'STAFF'").get();

  // 1. Super Admin has full access
  assert.strictEqual(assertAdminPermission(superAdmin, 'staff.manage'), true);
  assert.strictEqual(assertAdminPermission(superAdmin, 'products.write'), true);
  assert.strictEqual(assertAdminPermission(superAdmin, 'payments.refund'), true);

  // 2. Product Manager can edit products/inventory, CANNOT refund or manage staff
  assert.strictEqual(assertAdminPermission(productMgr, 'products.write'), true);
  assert.strictEqual(assertAdminPermission(productMgr, 'inventory.write'), true);
  assert.throws(() => assertAdminPermission(productMgr, 'payments.refund'), /RBAC Permission Denied/);
  assert.throws(() => assertAdminPermission(productMgr, 'shipping.update'), /RBAC Permission Denied/);

  // 3. Order Manager can update orders and manual shipping, CANNOT write products
  assert.strictEqual(assertAdminPermission(orderMgr, 'orders.write'), true);
  assert.strictEqual(assertAdminPermission(orderMgr, 'shipping.update'), true);
  assert.throws(() => assertAdminPermission(orderMgr, 'products.write'), /RBAC Permission Denied/);

  // 4. Accounts Manager can view payments/reports and refund, CANNOT edit product catalog (Section 5 requirement)
  assert.strictEqual(assertAdminPermission(accountsMgr, 'payments.view'), true);
  assert.strictEqual(assertAdminPermission(accountsMgr, 'payments.refund'), true);
  assert.strictEqual(assertAdminPermission(accountsMgr, 'reports.view'), true);
  assert.throws(() => assertAdminPermission(accountsMgr, 'products.write'), /RBAC Permission Denied/);

  // 5. Staff only accesses explicitly assigned permissions in permissions_json
  assert.strictEqual(assertAdminPermission(staffUser, 'shipping.update'), true);
  assert.throws(() => assertAdminPermission(staffUser, 'products.write'), /RBAC Permission Denied/);
  assert.throws(() => assertAdminPermission(staffUser, 'payments.refund'), /RBAC Permission Denied/);

  // 6. Verify immutable audit log recording
  const beforeCount = db.prepare('SELECT COUNT(*) AS cnt FROM audit_logs').get().cnt;
  recordAuditLog({
    actorId: superAdmin.id,
    actorEmail: superAdmin.email,
    actorRole: superAdmin.role,
    action: 'RBAC_VERIFICATION_GATE_TEST',
    entityType: 'SYSTEM',
    entityId: 'GATE_4',
    details: { verifiedRoles: 5 }
  });
  const afterCount = db.prepare('SELECT COUNT(*) AS cnt FROM audit_logs').get().cnt;
  assert.strictEqual(afterCount, beforeCount + 1, 'Audit log entry was not persisted');

  // 7. Verify Write-Only AES-256-GCM Credential Vault (Once added, encrypted at rest and hidden in console status)
  const { saveVaultCredential, listVaultStatus, getVaultSecret } = require('../src/core/auth/credentialVault');
  const sealed = saveVaultCredential({
    keyName: 'SMTP_API_KEY',
    secretValue: 're_live_SasyaSecretKey987654321',
    actorEmail: superAdmin.email,
    actorRole: superAdmin.role
  });
  assert.strictEqual(sealed.isConfigured, true);
  assert(sealed.maskedHint.includes('••••••••') && !sealed.maskedHint.includes('SasyaSecretKey'), 'Masked hint must hide the raw secret');

  const publicVaultList = listVaultStatus();
  const smtpEntry = publicVaultList.find(v => v.key_name === 'SMTP_API_KEY');
  assert(smtpEntry && smtpEntry.is_configured === 1, 'Vault status must mark key as configured');
  assert(!JSON.stringify(smtpEntry).includes('SasyaSecretKey'), 'Public vault status must NEVER leak plaintext or ciphertext');
  assert.strictEqual(getVaultSecret('SMTP_API_KEY'), 're_live_SasyaSecretKey987654321', 'Internal server decryptor must recover exact secret');
  db.prepare("UPDATE credential_vault SET encrypted_ciphertext = '', iv_hex = '', auth_tag_hex = '', masked_hint = 'NOT_CONFIGURED', is_configured = 0 WHERE key_name = 'SMTP_API_KEY'").run();

  // 8. Verify Hardened Session Cookie Login (Staff & Customer, including @sashyanaturals.com + @sasynaturals.com dual-alias) & 5-Attempt Lockout Rate-Limiter
  const { loginAdminWithPassword, loginCustomerWithPassword, verifySessionToken, clearFailedAttempts } = require('../src/core/auth/sessionManager');
  clearFailedAttempts('10.0.0.99:superadmin@sashyanaturals.com');
  const loginRes = loginAdminWithPassword('superadmin@sashyanaturals.com', 'Sashya@2026', '10.0.0.99');
  assert(loginRes.sessionToken && loginRes.csrfToken, 'Valid password login must issue signed sessionToken and csrfToken');
  const decodedSession = verifySessionToken(loginRes.sessionToken);
  assert.strictEqual(decodedSession.role, 'SUPER_ADMIN');
  // Also verify backward-compatible @sasynaturals.com and Sasya@2026 login
  const legacyLoginRes = loginAdminWithPassword('superadmin@sasynaturals.com', 'Sasya@2026', '10.0.0.99');
  assert(legacyLoginRes.sessionToken, 'Backward-compatible @sasynaturals.com + Sasya@2026 login must succeed');

  // Customer Account login check (Section 4)
  clearFailedAttempts('cust:10.0.0.99:ananya.iyer@example.com');
  const custLoginRes = loginCustomerWithPassword('ananya.iyer@example.com', 'Sashya@2026', '10.0.0.99');
  assert(custLoginRes.sessionToken && custLoginRes.user.role === 'CUSTOMER', 'Customer login must issue signed sessionToken');

  for (let i = 0; i < 5; i++) {
    assert.throws(() => loginAdminWithPassword('superadmin@sashyanaturals.com', 'WrongPass', '10.0.0.88'), /Invalid staff email or password/);
  }
  assert.throws(() => loginAdminWithPassword('superadmin@sashyanaturals.com', 'Sashya@2026', '10.0.0.88'), /Too many failed login attempts/);
  clearFailedAttempts('10.0.0.88:superadmin@sashyanaturals.com');

  // 9. Verify Section 5.1 Comprehensive Reports Engine (Daily vs Weekly vs Monthly, 22-Product Net Sales, Order & Payment Summaries, CSV Export)
  const { buildComprehensiveReports, exportReportToCsv } = require('../src/core/reports/reportingEngine');
  const reports = buildComprehensiveReports({
    orders: db.prepare('SELECT * FROM orders ORDER BY id DESC').all(),
    orderItems: db.prepare('SELECT * FROM order_items ORDER BY id DESC').all(),
    payments: db.prepare('SELECT * FROM payments ORDER BY id DESC').all(),
    products: db.prepare('SELECT * FROM products ORDER BY id').all(),
    categories: db.prepare('SELECT * FROM categories ORDER BY display_order').all(),
    referenceDateStr: '2026-11-21'
  });

  // Daily (2026-11-21) vs Weekly (Last 7 Days) vs Monthly (2026-11 MTD) must be distinct
  const [dailyWin, weeklyWin, monthlyWin] = reports.periodWindows;
  assert.strictEqual(dailyWin.ordersCount, 1, 'Daily window (2026-11-21) must contain only 1 order (SN-2026-1002)');
  assert.strictEqual(weeklyWin.ordersCount, 2, 'Weekly window (Last 7 Days) must contain 2 orders (SN-2026-1001 & SN-2026-1002)');
  assert.strictEqual(monthlyWin.ordersCount, 3, 'Monthly window (2026-11 MTD) must contain 3 orders (SN-2026-1000, SN-2026-1001, SN-2026-1002)');
  assert(reports.dailySales.length >= 3, 'Granular daily time-series must list at least 3 distinct dates');
  assert(reports.weeklySales.length >= 2, 'Granular weekly time-series must list at least 2 distinct ISO weeks');
  assert(reports.productSales.length >= 22, 'Product-wise sales report must cover all active catalogue products without truncation');
  assert.strictEqual(reports.orderStatusSummary.length, 9, 'Order status summary must cover all 9 fulfilment statuses');
  assert.strictEqual(reports.paymentMethodSummary.length, 4, 'Payment method summary must cover UPI, Card, NetBanking, and COD');

  const prodCsv = exportReportToCsv(reports, 'products');
  assert(prodCsv.includes('Product Name') && prodCsv.includes('Kashmiri Mamra Giri Almonds'), 'Products CSV export must include headers and products');

  // 10. Verify Change Password, Forgot Password 6-Digit OTP Reset & Explicit LOGGED_OUT Cookie State (v1.7.0)
  const {
    changeUserPassword,
    requestPasswordResetOtp,
    resetPasswordWithOtp,
    buildCustomerCookieHeader
  } = require('../src/core/auth/sessionManager');

  const logoutCookie = buildCustomerCookieHeader('', true);
  assert(logoutCookie.includes('sn_customer_session=LOGGED_OUT'), 'Customer sign-out cookie must explicitly record LOGGED_OUT state');

  // Forgot Password 6-digit OTP reset to known baseline (Sasya@2026)
  const otpDispatch1 = requestPasswordResetOtp('ananya.iyer@example.com');
  assert(otpDispatch1.sent && /^\d{6}$/.test(otpDispatch1.sandboxOtpPreview), 'requestPasswordResetOtp must generate a 6-digit OTP');
  const otpResetRes1 = resetPasswordWithOtp({
    email: 'ananya.iyer@example.com',
    otpCode: otpDispatch1.sandboxOtpPreview,
    newPassword: 'Sasya@2026'
  });
  assert(otpResetRes1.sessionToken && otpResetRes1.user.email === 'ananya.iyer@example.com', 'resetPasswordWithOtp must reset password and return sessionToken');
  // Verify OTP is single-use
  assert.throws(
    () => resetPasswordWithOtp({ email: 'ananya.iyer@example.com', otpCode: otpDispatch1.sandboxOtpPreview, newPassword: 'Sasya@2026' }),
    /Please request a 6-digit password reset OTP first/,
    'Consumed password reset OTP must not be reusable'
  );

  // Change password from Sasya@2026 -> SasyaNew@2026
  const changedRes = changeUserPassword({
    userId: custLoginRes.user.id,
    currentPassword: 'Sasya@2026',
    newPassword: 'SasyaNew@2026'
  });
  assert.strictEqual(changedRes.updated, true, 'changeUserPassword must update password hash when currentPassword matches');
  assert.throws(
    () => loginCustomerWithPassword('ananya.iyer@example.com', 'Sasya@2026', '10.0.0.99'),
    /Invalid customer email or password/,
    'Old password must be rejected after changeUserPassword'
  );
  clearFailedAttempts('cust:10.0.0.99:ananya.iyer@example.com');
  const newLoginRes = loginCustomerWithPassword('ananya.iyer@example.com', 'SasyaNew@2026', '10.0.0.99');
  assert(newLoginRes.sessionToken, 'Customer must be able to sign in with the newly changed password');

  // Restore baseline password back to Sasya@2026
  changeUserPassword({
    userId: custLoginRes.user.id,
    currentPassword: 'SasyaNew@2026',
    newPassword: 'Sasya@2026'
  });

  // 8. Verify Admin Manual Order Creation & Automatic GST Tax Invoice Generation (v2.3.0)
  const { createAdminOrder } = require('../src/core/checkout/checkoutEngine');
  const { renderGstInvoicePage } = require('../src/views/renderViews');
  const firstVariant = db.prepare('SELECT id, stock_qty FROM product_variants WHERE is_active = 1 AND stock_qty > 5 ORDER BY id LIMIT 1').get();
  const createdManualOrder = createAdminOrder({
    customerName: 'Vikramaditya Rao',
    customerEmail: 'vikram.rao@example.in',
    customerPhone: '9845098765',
    shippingLine1: 'No. 19, Lavelle Road',
    shippingLine2: 'Near Cubbon Park',
    shippingCity: 'Bengaluru',
    shippingState: 'Karnataka',
    shippingPincode: '560001',
    items: [{ variantId: firstVariant.id, quantity: 2 }],
    paymentMethod: 'ONLINE_UPI',
    paymentStatus: 'PAID',
    gatewayPaymentId: 'UTR9988776655',
    actorId: superAdmin.id,
    actorEmail: superAdmin.email,
    actorRole: superAdmin.role
  });
  assert(createdManualOrder.orderNumber.startsWith('SN-2026-'), 'createAdminOrder must assign a sequential SN-2026-XXXX order number');
  assert.strictEqual(createdManualOrder.invoiceUrl, `/orders/${createdManualOrder.orderNumber}/invoice`, 'createAdminOrder must return the automatic GST Tax Invoice URL');
  assert.strictEqual(createdManualOrder.paymentStatus, 'PAID', 'createAdminOrder must record PAID status');
  assert.strictEqual(createdManualOrder.fulfilmentStatus, 'Confirmed', 'createAdminOrder must confirm PAID manual orders');

  const afterVar = db.prepare('SELECT stock_qty FROM product_variants WHERE id = ?').get(firstVariant.id);
  assert.strictEqual(afterVar.stock_qty, firstVariant.stock_qty - 2, 'createAdminOrder must immediately deduct variant stock for PAID orders');

  const ordRow = db.prepare('SELECT * FROM orders WHERE id = ?').get(createdManualOrder.orderId);
  const ordItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(createdManualOrder.orderId);
  const invoiceHtml = renderGstInvoicePage({ order: ordRow, orderItems: ordItems, settingsMap: {} });
  assert(invoiceHtml.includes(`INV-${createdManualOrder.orderNumber}`), 'Auto-generated GST Tax Invoice must contain the invoice number');
  assert(invoiceHtml.includes('Vikramaditya Rao'), 'Auto-generated GST Tax Invoice must render the recipient details');

  // Clean up temporary test order & restore stock
  db.prepare('UPDATE product_variants SET stock_qty = ? WHERE id = ?').run(firstVariant.stock_qty, firstVariant.id);
  db.prepare('DELETE FROM inventory_movements WHERE reference_id = ?').run(createdManualOrder.orderNumber);
  db.prepare('DELETE FROM notification_logs WHERE order_number = ?').run(createdManualOrder.orderNumber);
  db.prepare('DELETE FROM audit_logs WHERE entity_id = ?').run(createdManualOrder.orderNumber);
  db.prepare('DELETE FROM payments WHERE order_id = ?').run(createdManualOrder.orderId);
  db.prepare('DELETE FROM order_items WHERE order_id = ?').run(createdManualOrder.orderId);
  db.prepare('DELETE FROM orders WHERE id = ?').run(createdManualOrder.orderId);

  // 9. Verify Module 6 Users & Purchases CSV Export & Module 9 Storefront Content & SEO Manager (v2.4.0)
  const {
    getStorefrontContentAndSeo,
    updateHomepageContent,
    updateInfoPageContent,
    updateRouteSeoMeta,
    buildUsersAndPurchasesExportCsv
  } = require('../src/core/content/contentStore');

  const customerUsers = db.prepare("SELECT * FROM users WHERE role = 'CUSTOMER' ORDER BY id").all();
  const customerAddresses = db.prepare('SELECT * FROM customer_addresses ORDER BY id').all();
  const allOrders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
  const allOrderItems = db.prepare('SELECT * FROM order_items ORDER BY id DESC').all();
  const usersSummaryCsv = buildUsersAndPurchasesExportCsv({
    customerUsers,
    customerAddresses,
    orders: allOrders,
    orderItems: allOrderItems,
    exportType: 'users_summary'
  });
  assert(usersSummaryCsv.includes('User ID,Account Type,Full Name,Email,Mobile Phone'), 'Users summary CSV must include full header');
  assert(usersSummaryCsv.includes('ananya.iyer@example.com'), 'Users summary CSV must include registered customer Ananya Iyer');

  const userPurchasesCsv = buildUsersAndPurchasesExportCsv({
    customerUsers,
    customerAddresses,
    orders: allOrders,
    orderItems: allOrderItems,
    exportType: 'user_purchases'
  });
  assert(userPurchasesCsv.includes('Order Number,Order Date,Payment Method,Payment Status,Fulfilment Status,SKU,HSN Code'), 'User purchases CSV must include itemized purchase columns');
  assert(userPurchasesCsv.includes('SN-2026-1000'), 'User purchases CSV must include order SN-2026-1000');

  const updatedHome = updateHomepageContent(
    {
      heroBatchCaptionLeft: 'Harvest Batch: Dec 2026',
      heroHighlightBanner: 'Pure | Natural | Wholesome',
      region1Title: 'Kashmir',
      region5Sub: 'Aromatic Spices'
    },
    { actorId: superAdmin.id, actorEmail: superAdmin.email, actorRole: superAdmin.role }
  );
  assert.strictEqual(updatedHome.heroBatchCaptionLeft, 'Harvest Batch: Dec 2026', 'updateHomepageContent must persist updated hero batch caption');
  assert.strictEqual(updatedHome.heroHighlightBanner, 'Pure | Natural | Wholesome', 'updateHomepageContent must persist updated hero highlight ribbon');
  assert.strictEqual(updatedHome.region5Sub, 'Aromatic Spices', 'updateHomepageContent must persist updated 5-region origin bar copy');

  const updatedFaq = updateInfoPageContent(
    {
      slug: 'faq',
      title: 'Frequently Asked Questions',
      subtitle: 'Pack Sizes, Payments, Manual Courier Tracking & Storage',
      paragraphsText: 'What pack sizes do you offer? All dry fruits, millets, and spices are available in 100 g, 250 g, 500 g, and 1 kg packs.'
    },
    { actorId: superAdmin.id, actorEmail: superAdmin.email, actorRole: superAdmin.role }
  );
  assert.strictEqual(updatedFaq.title, 'Frequently Asked Questions', 'updateInfoPageContent must persist updated info page');

  const updatedSeo = updateRouteSeoMeta(
    {
      routePath: '/shop',
      metaTitle: 'All Natural Products Catalogue | Sashya Naturals',
      metaDescription: 'Browse all Sashya Naturals dry fruits, unpolished millets, and single-origin spices with 100 g, 250 g, 500 g, and 1 kg pack variants.',
      ogImagePath: '/images/hero-pantry.jpg'
    },
    { actorId: superAdmin.id, actorEmail: superAdmin.email, actorRole: superAdmin.role }
  );
  assert.strictEqual(updatedSeo.metaTitle, 'All Natural Products Catalogue | Sashya Naturals', 'updateRouteSeoMeta must persist route SEO metadata');
  assert.strictEqual(getStorefrontContentAndSeo().homepage.heroBatchCaptionLeft, 'Harvest Batch: Dec 2026');

  // Clean up test content overrides back to baseline defaults
  db.prepare("DELETE FROM store_settings WHERE key IN ('content_homepage_json', 'content_pages_json', 'content_seo_json')").run();
  db.prepare("DELETE FROM audit_logs WHERE action IN ('HOMEPAGE_CONTENT_UPDATED', 'INFO_PAGE_CONTENT_UPDATED', 'ROUTE_SEO_META_UPDATED')").run();

  // 11. Verify v2.5.0 500-Edge-Case Adversarial Audit Remediations (F-02, F-05, F-09, F-10, EC-001..EC-411)
  const {
    calculateCartPricing,
    updateOrderFulfilmentAndShipping,
    updateOrderDeliveryAddress
  } = require('../src/core/checkout/checkoutEngine');

  // F-02 / EC-001: Duplicate variantId rows in cart must be consolidated and checked against available stock
  const consolidatedPricing = calculateCartPricing([
    { variantId: firstVariant.id, quantity: 2 },
    { variantId: firstVariant.id, quantity: 3 }
  ]);
  assert.strictEqual(consolidatedPricing.lineItems.length, 1, 'Duplicate variantId rows must consolidate into 1 line item');
  assert.strictEqual(consolidatedPricing.lineItems[0].quantity, 5, 'Consolidated line item quantity must equal sum of duplicate rows');
  assert.throws(
    () => calculateCartPricing([
      { variantId: firstVariant.id, quantity: Math.floor(firstVariant.stock_qty / 2) + 1 },
      { variantId: firstVariant.id, quantity: Math.floor(firstVariant.stock_qty / 2) + 5 }
    ]),
    /Insufficient stock/,
    'Duplicate variant rows exceeding total stock must be rejected'
  );

  // F-09 / EC-004 / EC-005: Strict paymentMethod <-> paymentStatus compatibility in createAdminOrder
  assert.throws(
    () => createAdminOrder({
      customerName: 'Mismatch Test',
      customerEmail: 'mismatch@example.in',
      customerPhone: '9845012345',
      shippingLine1: '12 MG Road',
      shippingCity: 'Bengaluru',
      shippingState: 'Karnataka',
      shippingPincode: '560001',
      items: [{ variantId: firstVariant.id, quantity: 1 }],
      paymentMethod: 'COD',
      paymentStatus: 'PAID'
    }),
    /Invalid payment status "PAID" for Cash on Delivery/,
    'COD with PAID status must be rejected'
  );
  assert.throws(
    () => createAdminOrder({
      customerName: 'Mismatch Test 2',
      customerEmail: 'mismatch2@example.in',
      customerPhone: '9845012345',
      shippingLine1: '12 MG Road',
      shippingCity: 'Bengaluru',
      shippingState: 'Karnataka',
      shippingPincode: '560001',
      items: [{ variantId: firstVariant.id, quantity: 1 }],
      paymentMethod: 'ONLINE_UPI',
      paymentStatus: 'COD_PENDING'
    }),
    /Invalid payment status "COD_PENDING" for Online Payment/,
    'Prepaid method with COD_PENDING status must be rejected'
  );

  // F-05 / EC-051: Marking order Shipped without Courier or AWB Tracking must throw
  assert.throws(
    () => updateOrderFulfilmentAndShipping({
      orderNumber: 'SN-2026-1002',
      fulfilmentStatus: 'Shipped',
      courierName: '',
      trackingNumber: ''
    }),
    /Dispatched orders require Courier Name and Tracking Number/,
    'Shipping an order without courier name must be blocked'
  );

  // F-10 / EC-059: Editing delivery address of an already Shipped or Delivered order must throw
  assert.throws(
    () => updateOrderDeliveryAddress({
      orderNumber: 'SN-2026-1001', // Shipped in seed data
      customerName: 'Ananya Iyer',
      customerPhone: '9845011223',
      shippingLine1: 'New Street',
      shippingCity: 'Bengaluru',
      shippingState: 'Karnataka',
      shippingPincode: '560038'
    }),
    /Delivery address cannot be modified after order SN-2026-1001 is Shipped/,
    'Post-dispatch address modification must be blocked'
  );

  // EC-403: Reject external http/https URLs in ogImagePath
  assert.throws(
    () => updateRouteSeoMeta(
      {
        routePath: '/shop',
        metaTitle: 'Valid Shop Title | Sashya Naturals',
        metaDescription: 'Valid Shop Description',
        ogImagePath: 'https://evil.example.com/tracker.png'
      },
      { actorId: superAdmin.id, actorEmail: superAdmin.email, actorRole: superAdmin.role }
    ),
    /OpenGraph image path must be a local storefront path starting with "\/"/,
    'External URLs in ogImagePath must be rejected'
  );

  // EC-354: CSV formula injection guard
  const formulaCsv = buildUsersAndPurchasesExportCsv({
    customerUsers: [],
    customerAddresses: [],
    orders: [{
      id: 9999,
      order_number: 'SN-2026-9999',
      customer_name: '=CMD("calc")',
      customer_email: 'formula@example.in',
      customer_phone: '+919845012345',
      shipping_city: 'Bengaluru',
      shipping_state: 'Karnataka',
      shipping_pincode: '560001',
      payment_status: 'PAID',
      fulfilment_status: 'Confirmed',
      total_paise: 25000,
      created_at: '2026-11-22'
    }],
    orderItems: [],
    exportType: 'users_summary'
  });
  assert(formulaCsv.includes('\'=CMD'), 'CSV export must prefix formula-triggering cells with a single quote');

  // 12. Verify v2.7.0 FSSAI Per-100g Nutritional Profiles & Per-Weight Variant Discount Controls
  const { parseProductNutrition, normalizeNutritionPayload } = require('../src/db/database');
  const { renderProductDetailPage } = require('../src/views/renderViews');

  const ragiProd = db.prepare("SELECT * FROM products WHERE sku_base = 'SN-ML-RAG'").get();
  assert(ragiProd, 'Haveri Finger Millet (Ragi) product must exist');
  const ragiNut = parseProductNutrition(ragiProd);
  assert.strictEqual(ragiNut.energy_kcal, 328, 'Haveri Ragi IFCT energy_kcal must be 328');
  assert(ragiNut.bioactive_value.includes('344 mg Calcium'), 'Haveri Ragi bioactive_value must highlight 344 mg Calcium');

  // Verify en-dash / em-dash normalization in normalizeNutritionPayload so contentLinter never fails on pasted ranges
  const sanitizedNut = normalizeNutritionPayload({
    energy_kcal: 350,
    protein_g: 11.2,
    bioactive_label: 'Natural Curcumin — Lab Tested',
    bioactive_value: '7.5–8.0% Curcuminoids'
  }, ragiNut);
  assert(!/[—–]/.test(sanitizedNut.bioactive_label) && !/[—–]/.test(sanitizedNut.bioactive_value), 'normalizeNutritionPayload must convert em/en-dashes to ASCII hyphens');

  // Verify per-weight distinct discount percentages render accurately on PDP variant pills
  const ragiCat = db.prepare('SELECT * FROM categories WHERE id = ?').get(ragiProd.category_id);
  const ragiVars = db.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY weight_grams ASC').all(ragiProd.id);
  const customVars = ragiVars.map(v => {
    if (v.weight_grams === 1000) {
      // Set 1 kg MRP Rs 400 (40000 paise), Selling Rs 280 (28000 paise) -> Save 30%
      return { ...v, mrp_paise: 40000, selling_price_paise: 28000, promo_price_paise: 28000 };
    }
    return v;
  });
  const ragiPdpHtml = renderProductDetailPage({
    product: ragiProd,
    category: ragiCat,
    variants: customVars,
    relatedProducts: [],
    allVariants: customVars
  });
  assert(ragiPdpHtml.includes('Save 30%'), 'PDP must display the distinct 30% per-weight discount badge on the 1 kg variant pill');
  assert(ragiPdpHtml.includes('344 mg Calcium (IFCT 2017)'), 'PDP must render the product-specific bioactive highlight in the Nutritional Value tab');

  // 13. Verify Fail-Closed Production Go-Live Launch Guardrail (Payment Gateway + Email Notification & Verification)
  const {
    isLiveProductionHost,
    evaluateLaunchReadiness,
    assertProductionLaunchReady
  } = require('../src/core/auth/launchReadiness');

  assert.strictEqual(isLiveProductionHost('sashyanaturals.com'), true, 'sashyanaturals.com must be detected as live host');
  assert.strictEqual(isLiveProductionHost('www.sashyanaturals.com'), true, 'www.sashyanaturals.com must be detected as live host');
  assert.strictEqual(isLiveProductionHost('staging.sashyanaturals.com'), false, 'staging.sashyanaturals.com must NOT be locked by live host gate');

  // In default unconfigured state, launch readiness MUST be false and throw LAUNCH_GUARDRAIL_BLOCKED
  const initialLaunch = evaluateLaunchReadiness();
  assert.strictEqual(initialLaunch.isReady, false, 'Default unconfigured vault must block production launch');
  assert.throws(() => assertProductionLaunchReady(), /LAUNCH_GUARDRAIL_BLOCKED/, 'assertProductionLaunchReady must throw when vault is unconfigured');

  // Sealing a sandbox rzp_test_ key MUST STILL block launch
  saveVaultCredential({ keyName: 'RAZORPAY_KEY_ID', secretValue: 'rzp_test_SandboxKey123456', actorEmail: superAdmin.email, actorRole: superAdmin.role });
  saveVaultCredential({ keyName: 'RAZORPAY_KEY_SECRET', secretValue: 'live_rzp_secret_998877665544', actorEmail: superAdmin.email, actorRole: superAdmin.role });
  saveVaultCredential({ keyName: 'RAZORPAY_WEBHOOK_SECRET', secretValue: 'live_whsec_9988776655', actorEmail: superAdmin.email, actorRole: superAdmin.role });
  assert.strictEqual(evaluateLaunchReadiness().paymentGatewayLive, false, 'Sandbox rzp_test_ key must NOT pass paymentGatewayLive guardrail');

  // Sealing a live rzp_live_ key passes Payment Gateway check, but missing Email Notification/Verification still blocks launch
  saveVaultCredential({ keyName: 'RAZORPAY_KEY_ID', secretValue: 'rzp_live_ProdKey9988776655', actorEmail: superAdmin.email, actorRole: superAdmin.role });
  const afterRzp = evaluateLaunchReadiness();
  assert.strictEqual(afterRzp.paymentGatewayLive, true, 'Live rzp_live_ key + secret + webhook must satisfy paymentGatewayLive');
  assert.strictEqual(afterRzp.isReady, false, 'Launch must still be blocked until SMTP_API_KEY and email_verification_live are active');

  // Sealing live SMTP_API_KEY and confirming email_verification_live = '1' unlocks launch (when sample categories are not active)
  saveVaultCredential({ keyName: 'SMTP_API_KEY', secretValue: 're_live_ProdEmailKey987654321', actorEmail: superAdmin.email, actorRole: superAdmin.role });
  db.prepare("INSERT OR REPLACE INTO store_settings (key, value, updated_at) VALUES ('email_verification_live', '1', datetime('now'))").run();
  const readyState = evaluateLaunchReadiness();
  if (readyState.stagingSampleDataClean) {
    assert.strictEqual(readyState.isReady, true, 'Launch guardrail must unlock when Live Razorpay + Live SMTP + email_verification_live are all active');
    assert.doesNotThrow(() => assertProductionLaunchReady());
  }

  // Clean up test vault credentials and settings back to unconfigured baseline
  db.prepare("UPDATE credential_vault SET encrypted_ciphertext = '', iv_hex = '', auth_tag_hex = '', masked_hint = 'NOT_CONFIGURED', is_configured = 0").run();
  db.prepare("DELETE FROM store_settings WHERE key = 'email_verification_live'").run();
  db.prepare("DELETE FROM audit_logs WHERE action = 'VAULT_CREDENTIAL_SEALED'").run();
  assert.strictEqual(evaluateLaunchReadiness().isReady, false, 'Baseline vault reset must re-lock production launch guardrail');

  // 14. Verify v3.4.0 4,500-Adversarial-Attack Remediations across all 9 Admin Modules
  assert.strictEqual(assertAdminPermission(accountsMgr, 'customers.view'), true, 'ACCOUNTS_MANAGER must be granted customers.view for Module 6 CSV exports');
  assert.throws(
    () => requestPasswordResetOtp('superadmin@sashyanaturals.com'),
    /Staff and administrator passwords cannot be reset via public OTP/,
    'requestPasswordResetOtp must reject Staff/SuperAdmin accounts'
  );
  assert.throws(
    () => normalizeNutritionPayload({ protein_g: 450, carbs_g: 600, total_fat_g: 10, saturated_fat_g: 85 }, ragiNut, { strict: true }),
    /FSSAI Nutritional Physics Violation/,
    'normalizeNutritionPayload with strict:true must reject impossible per-100g macros'
  );
  const { updateHelloBarConfig } = require('../src/core/content/contentStore');
  updateHelloBarConfig({ topbarBadge1: 'Bi-Directional Sync Test A' });
  assert.strictEqual(getStorefrontContentAndSeo().homepage.topbarBadge1, 'Bi-Directional Sync Test A');
  updateHomepageContent({ topbarBadge1: 'Bi-Directional Sync Test B' });
  assert.strictEqual(getStorefrontContentAndSeo().helloBar.topbarBadge1, 'Bi-Directional Sync Test B');
  db.prepare("DELETE FROM store_settings WHERE key IN ('content_homepage_json', 'content_hellobar_json')").run();
  db.prepare("DELETE FROM audit_logs WHERE action IN ('HOMEPAGE_CONTENT_UPDATED', 'HELLOBAR_CONTENT_UPDATED')").run();

  // 15. Verify v4.0.0 Full Storefront Editability (All 5 Lean Audit Areas)
  const {
    renderHomePage,
    renderCatalogPage,
    renderCheckoutPage,
    renderTrackOrderPage,
    renderCustomerAccountPage,
    renderStaticInfoPage
  } = require('../src/views/renderViews');
  const { buildOrganizationNode } = require('../src/core/content/schemaBuilder');

  try {
    // 15a. Homepage section eyebrows/headings + footer copyright line
    updateHomepageContent({
      homeCategoriesEyebrow: 'Custom Pantry Collections Eyebrow',
      homeCategoriesHeading: 'Custom Five Natural Collections Heading',
      homeFeaturedEyebrow: 'Custom Harvest Selection Eyebrow',
      homeFeaturedHeading: 'Custom Single-Origin Staples Heading',
      homeBestsellersEyebrow: 'Custom Most Reordered Eyebrow',
      homeBestsellersHeading: 'Custom Household Bestsellers Heading',
      footerCopyrightLine: 'Custom GST & Verified Pincode Compliance Line'
    });
    const activeCategories = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY display_order').all();
    const activeProducts = db.prepare('SELECT * FROM products WHERE is_active = 1 ORDER BY id').all();
    const activeVariants = db.prepare('SELECT * FROM product_variants WHERE is_active = 1 ORDER BY id').all();
    const homeHtml = renderHomePage({
      categories: activeCategories,
      products: activeProducts,
      variants: activeVariants
    });
    assert(homeHtml.includes('Custom Five Natural Collections Heading'), 'Homepage must render custom homeCategoriesHeading');
    assert(homeHtml.includes('Custom Single-Origin Staples Heading'), 'Homepage must render custom homeFeaturedHeading');
    assert(homeHtml.includes('Custom Household Bestsellers Heading'), 'Homepage must render custom homeBestsellersHeading');
    assert(homeHtml.includes('Custom GST &amp; Verified Pincode Compliance Line'), 'Global footer must render custom footerCopyrightLine');

    // 15b. Functional storefront page headings (/shop, /checkout, /track-order, /account) via Module 9.2
    updateInfoPageContent({
      slug: 'shop',
      title: 'Custom All Natural Products Heading',
      subtitle: 'Custom Farm-to-Kitchen Eyebrow',
      paragraphsText: 'Custom catalog intro paragraph for testing.'
    });
    const shopHtml = renderCatalogPage({
      title: 'All Natural Products',
      subtitle: 'Complete Farm-to-Kitchen Catalogue',
      canonicalPath: '/shop',
      categories: activeCategories,
      products: activeProducts,
      variants: activeVariants
    });
    assert(shopHtml.includes('Custom All Natural Products Heading'), '/shop must render custom infoPages.shop title');
    assert(shopHtml.includes('Custom Farm-to-Kitchen Eyebrow'), '/shop must render custom infoPages.shop subtitle');
    assert(shopHtml.includes('Custom catalog intro paragraph for testing.'), '/shop must render custom infoPages.shop intro paragraph');

    updateInfoPageContent({
      slug: 'checkout',
      title: 'Custom Express Checkout Heading',
      subtitle: 'Custom Checkout Eyebrow',
      paragraphsText: 'Complete your order securely.'
    });
    const checkoutHtml = renderCheckoutPage({ categories: activeCategories });
    assert(checkoutHtml.includes('Custom Express Checkout Heading'), '/checkout must render custom infoPages.checkout title');

    updateInfoPageContent({
      slug: 'track-order',
      title: 'Custom Order Lookup Heading',
      subtitle: 'Custom Dispatch Status Eyebrow',
      paragraphsText: 'Enter your order number and mobile phone below.'
    });
    const trackHtml = renderTrackOrderPage({ categories: activeCategories, order: null, orderItems: [], searchedOrderNumber: '' });
    assert(trackHtml.includes('Custom Order Lookup Heading'), '/track-order must render custom infoPages["track-order"] title');

    updateInfoPageContent({
      slug: 'account',
      title: 'Custom Customer Account Heading',
      subtitle: 'Custom Account Eyebrow',
      paragraphsText: 'Manage your saved addresses and order history.'
    });
    const accountHtml = renderCustomerAccountPage({ categories: activeCategories, customerUser: null, savedAddresses: [], customerOrders: [] });
    assert(accountHtml.includes('Custom Customer Account Heading'), '/account must render custom infoPages.account title');

    // 15c. Live store_settings synchronization on /contact, /shipping-returns, and Organization JSON-LD
    const prevEmailRow = db.prepare("SELECT value FROM store_settings WHERE key = 'support_email'").get();
    db.prepare("INSERT OR REPLACE INTO store_settings (key, value, updated_at) VALUES ('support_email', 'support@sashyanaturals.com', datetime('now'))").run();
    const contactHtml = renderStaticInfoPage({
      slug: 'contact',
      title: 'Contact & Bulk Orders',
      subtitle: 'Bengaluru Support Desk',
      paragraphs: ['Customer Support Email: support@sashyanaturals.com (Monday to Saturday, 9:30 AM to 6:30 PM IST).'],
      categories: activeCategories
    });
    assert(contactHtml.includes('support@sashyanaturals.com'), '/contact #support-channels must render live support_email from store_settings');
    assert(!contactHtml.includes('contact-phone-whatsapp'), '/contact must not display phone support card');
    const orgNode = buildOrganizationNode();
    assert.strictEqual(orgNode.contactPoint.email, 'support@sashyanaturals.com', 'Organization JSON-LD must use live support_email from store_settings');
    if (prevEmailRow) {
      db.prepare("UPDATE store_settings SET value = ? WHERE key = 'support_email'").run(prevEmailRow.value);
    } else {
      db.prepare("DELETE FROM store_settings WHERE key = 'support_email'").run();
    }
  } finally {
    // Clean up Section 15 test mutations
    db.prepare("DELETE FROM store_settings WHERE key IN ('content_homepage_json', 'content_pages_json')").run();
    db.prepare("DELETE FROM audit_logs WHERE action IN ('HOMEPAGE_CONTENT_UPDATED', 'INFO_PAGE_CONTENT_UPDATED')").run();
  }

  console.log('✓ [Suite 4/7: verify_rbac_and_audit] Verified 5 staff roles, Customer Account Auth + OTP Password Reset, Write-Only AES-256-GCM Credential Vault, Fail-Closed Production Go-Live Guardrail, Session Cookie Auth, Section 5.1 Reports Engine, Admin Manual Order + Auto-Invoice, Users CSV Export, Storefront Content/SEO Manager, v2.5.0 Adversarial Edge-Case Guards, v2.7.0 FSSAI Nutrition + Per-Weight Discounts, v3.4.0 4,500-Attack Hardening, v4.0.0 Full Storefront Editability & immutable audit_logs');
}

if (require.main === module) {
  runVerifyRbacAndAudit();
}

module.exports = { runVerifyRbacAndAudit };


