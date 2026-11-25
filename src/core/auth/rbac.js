'use strict';

const { getDb } = require('../../db/database');
const { STAFF_ROLES } = require('../../config/appConfig');

const ROLE_PERMISSIONS_MATRIX = {
  [STAFF_ROLES.SUPER_ADMIN]: [
    'overview.view',
    'products.view',
    'products.write',
    'inventory.view',
    'inventory.write',
    'orders.view',
    'orders.write',
    'shipping.update',
    'payments.view',
    'payments.refund',
    'customers.view',
    'reports.view',
    'staff.manage',
    'settings.manage',
    'audit.view'
  ],
  [STAFF_ROLES.PRODUCT_MANAGER]: [
    'overview.view',
    'products.view',
    'products.write',
    'inventory.view',
    'inventory.write'
  ],
  [STAFF_ROLES.ORDER_MANAGER]: [
    'overview.view',
    'orders.view',
    'orders.write',
    'shipping.update',
    'inventory.view',
    'customers.view'
  ],
  [STAFF_ROLES.ACCOUNTS_MANAGER]: [
    'overview.view',
    'payments.view',
    'payments.refund',
    'reports.view',
    'orders.view',
    'customers.view'
  ],
  [STAFF_ROLES.STAFF]: [
    'overview.view',
    'orders.view',
    'shipping.update'
  ]
};

const VALID_ADMIN_PERMISSIONS = new Set(ROLE_PERMISSIONS_MATRIX[STAFF_ROLES.SUPER_ADMIN]);

function hasPermission(user, requiredPermission) {
  if (!user || !user.role || !user.is_active) return false;
  if (user.role === STAFF_ROLES.SUPER_ADMIN) return true;

  // For STAFF role, strictly enforce explicitly assigned permissions in permissions_json (never staff.manage or settings.manage)
  if (user.role === STAFF_ROLES.STAFF) {
    let customPerms = [];
    if (user.permissions_json) {
      try {
        const parsed = typeof user.permissions_json === 'string'
          ? JSON.parse(user.permissions_json)
          : user.permissions_json;
        if (Array.isArray(parsed)) {
          customPerms = parsed.filter(
            p => VALID_ADMIN_PERMISSIONS.has(p) && p !== 'staff.manage' && p !== 'settings.manage'
          );
        }
      } catch {
        customPerms = [];
      }
    }
    if (customPerms.length > 0) {
      return customPerms.includes(requiredPermission);
    }
  }

  const rolePerms = ROLE_PERMISSIONS_MATRIX[user.role] || [];
  if (rolePerms.includes('*') || rolePerms.includes(requiredPermission)) {
    return true;
  }

  return false;
}

function assertAdminPermission(user, requiredPermission) {
  if (!user) {
    const err = new Error('Authentication required for Admin Portal.');
    err.statusCode = 401;
    throw err;
  }
  if (!hasPermission(user, requiredPermission)) {
    const err = new Error(
      `RBAC Permission Denied: Role "${user.role}" is not authorized for action "${requiredPermission}".`
    );
    err.statusCode = 403;
    throw err;
  }
  return true;
}

function recordAuditLog({
  actorId = null,
  actorEmail,
  actorRole,
  action,
  entityType,
  entityId,
  details = {}
}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_logs (actor_id, actor_email, actor_role, action, entity_type, entity_id, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    actorId,
    actorEmail || 'system@sashyanaturals.com',
    actorRole || 'SYSTEM',
    action,
    entityType,
    String(entityId),
    JSON.stringify(details)
  );
}

module.exports = {
  ROLE_PERMISSIONS_MATRIX,
  VALID_ADMIN_PERMISSIONS,
  hasPermission,
  assertAdminPermission,
  recordAuditLog
};
