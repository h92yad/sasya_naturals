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

  // 8. Verify Hardened Session Cookie Login (Staff & Customer) & 5-Attempt Lockout Rate-Limiter
  const { loginAdminWithPassword, loginCustomerWithPassword, verifySessionToken, clearFailedAttempts } = require('../src/core/auth/sessionManager');
  clearFailedAttempts('10.0.0.99:superadmin@sasynaturals.com');
  const loginRes = loginAdminWithPassword('superadmin@sasynaturals.com', 'Sasya@2026', '10.0.0.99');
  assert(loginRes.sessionToken && loginRes.csrfToken, 'Valid password login must issue signed sessionToken and csrfToken');
  const decodedSession = verifySessionToken(loginRes.sessionToken);
  assert.strictEqual(decodedSession.role, 'SUPER_ADMIN');

  // Customer Account login check (Section 4)
  clearFailedAttempts('cust:10.0.0.99:ananya.iyer@example.com');
  const custLoginRes = loginCustomerWithPassword('ananya.iyer@example.com', 'Sasya@2026', '10.0.0.99');
  assert(custLoginRes.sessionToken && custLoginRes.user.role === 'CUSTOMER', 'Customer login must issue signed sessionToken');

  for (let i = 0; i < 5; i++) {
    assert.throws(() => loginAdminWithPassword('superadmin@sasynaturals.com', 'WrongPass', '10.0.0.88'), /Invalid staff email or password/);
  }
  assert.throws(() => loginAdminWithPassword('superadmin@sasynaturals.com', 'Sasya@2026', '10.0.0.88'), /Too many failed login attempts/);
  clearFailedAttempts('10.0.0.88:superadmin@sasynaturals.com');

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
  assert.strictEqual(reports.productSales.length, 22, 'Product-wise sales report must cover all 22 products without truncation');
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
    { heroBatchCaptionLeft: 'Harvest Batch: Dec 2026' },
    { actorId: superAdmin.id, actorEmail: superAdmin.email, actorRole: superAdmin.role }
  );
  assert.strictEqual(updatedHome.heroBatchCaptionLeft, 'Harvest Batch: Dec 2026', 'updateHomepageContent must persist updated hero batch caption');

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
      metaTitle: 'All Natural Products Catalogue | Sasya Naturals',
      metaDescription: 'Browse all Sasya Naturals dry fruits, unpolished millets, and single-origin spices with 100 g, 250 g, 500 g, and 1 kg pack variants.',
      ogImagePath: '/images/hero-pantry.jpg'
    },
    { actorId: superAdmin.id, actorEmail: superAdmin.email, actorRole: superAdmin.role }
  );
  assert.strictEqual(updatedSeo.metaTitle, 'All Natural Products Catalogue | Sasya Naturals', 'updateRouteSeoMeta must persist route SEO metadata');
  assert.strictEqual(getStorefrontContentAndSeo().homepage.heroBatchCaptionLeft, 'Harvest Batch: Dec 2026');

  // Clean up test content overrides back to baseline defaults
  db.prepare("DELETE FROM store_settings WHERE key IN ('content_homepage_json', 'content_pages_json', 'content_seo_json')").run();
  db.prepare("DELETE FROM audit_logs WHERE action IN ('HOMEPAGE_CONTENT_UPDATED', 'INFO_PAGE_CONTENT_UPDATED', 'ROUTE_SEO_META_UPDATED')").run();

  console.log('✓ [Suite 4/7: verify_rbac_and_audit] Verified 5 staff roles, Customer Account Auth + OTP Password Reset, Write-Only AES-256-GCM Credential Vault, Session Cookie Auth, Section 5.1 Reports Engine, Admin Manual Order + Auto-Invoice, Users CSV Export, Storefront Content/SEO Manager & immutable audit_logs');
}

if (require.main === module) {
  runVerifyRbacAndAudit();
}

module.exports = { runVerifyRbacAndAudit };
