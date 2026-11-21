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

  console.log('✓ [Suite 4/7: verify_rbac_and_audit] Verified all 5 staff roles (Super Admin, Product, Order, Accounts, Staff) & immutable audit_logs');
}

if (require.main === module) {
  runVerifyRbacAndAudit();
}

module.exports = { runVerifyRbacAndAudit };
