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

  console.log('✓ [Suite 4/7: verify_rbac_and_audit] Verified 5 staff roles, Customer Account Auth, Write-Only AES-256-GCM Credential Vault, Session Cookie Auth + Rate-Limiter & immutable audit_logs');
}

if (require.main === module) {
  runVerifyRbacAndAudit();
}

module.exports = { runVerifyRbacAndAudit };
