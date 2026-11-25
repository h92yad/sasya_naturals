'use strict';

/**
 * Write-Only AES-256-GCM Credential Vault (src/core/auth/credentialVault.js)
 * Allows Super Admin to add Razorpay, SMTP, and WhatsApp API credentials once in the Admin Console.
 * Once added, secrets are encrypted at rest and permanently hidden in the UI behind a masked badge.
 */
const crypto = require('node:crypto');
const { getDb } = require('../../db/database');
const { SESSION_SECRET } = require('../../config/appConfig');
const { recordAuditLog } = require('./rbac');

const ALLOWED_VAULT_KEYS = [
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'SMTP_API_KEY',
  'WHATSAPP_OTP_API_KEY'
];

function deriveVaultKey() {
  return crypto.createHash('sha256').update(`sasya_vault_aes256_${SESSION_SECRET}`).digest();
}

function buildMaskedHint(rawSecret) {
  const clean = String(rawSecret || '').trim();
  if (clean.length <= 6) return '•••••• (Hidden)';
  const prefix = clean.slice(0, 4);
  const suffix = clean.slice(-4);
  return `${prefix}••••••••${suffix} (Hidden)`;
}

function saveVaultCredential({ keyName, secretValue, actorEmail = 'superadmin@sashyanaturals.com', actorRole = 'SUPER_ADMIN' }) {
  const cleanKey = String(keyName || '').trim().toUpperCase();
  if (!ALLOWED_VAULT_KEYS.includes(cleanKey)) {
    throw new Error(`Unsupported vault credential key: ${cleanKey}`);
  }
  const cleanVal = String(secretValue || '').trim();
  if (!cleanVal || cleanVal.length < 6) {
    throw new Error(`Credential value for ${cleanKey} must be at least 6 characters.`);
  }

  const key = deriveVaultKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(cleanVal, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const maskedHint = buildMaskedHint(cleanVal);

  const db = getDb();
  db.prepare(`
    UPDATE credential_vault
    SET encrypted_ciphertext = ?,
        iv_hex = ?,
        auth_tag_hex = ?,
        masked_hint = ?,
        is_configured = 1,
        updated_by = ?,
        updated_at = datetime('now')
    WHERE key_name = ?
  `).run(
    encrypted.toString('hex'),
    iv.toString('hex'),
    authTag.toString('hex'),
    maskedHint,
    actorEmail,
    cleanKey
  );

  recordAuditLog({
    actorEmail,
    actorRole,
    action: 'VAULT_CREDENTIAL_SEALED',
    entityType: 'CREDENTIAL_VAULT',
    entityId: cleanKey,
    details: { maskedHint, status: 'ENCRYPTED_AND_HIDDEN' }
  });

  return {
    keyName: cleanKey,
    isConfigured: true,
    maskedHint
  };
}

/**
 * Returns public metadata for the Admin Console. NEVER exposes plaintext or ciphertext.
 */
function listVaultStatus() {
  const db = getDb();
  return db.prepare(`
    SELECT key_name, label, provider_group, masked_hint, is_configured, updated_by, updated_at
    FROM credential_vault
    ORDER BY provider_group, key_name
  `).all();
}

/**
 * Internal server-only decryptor. Used only inside server-side payment/notification routines.
 */
function getVaultSecret(keyName, fallbackEnvValue = '') {
  const db = getDb();
  const row = db.prepare('SELECT * FROM credential_vault WHERE key_name = ? AND is_configured = 1').get(keyName);
  if (!row || !row.encrypted_ciphertext || !row.iv_hex || !row.auth_tag_hex) {
    return fallbackEnvValue;
  }
  try {
    const key = deriveVaultKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv_hex, 'hex'));
    decipher.setAuthTag(Buffer.from(row.auth_tag_hex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(row.encrypted_ciphertext, 'hex')),
      decipher.final()
    ]);
    return decrypted.toString('utf8');
  } catch {
    return fallbackEnvValue;
  }
}

module.exports = {
  ALLOWED_VAULT_KEYS,
  saveVaultCredential,
  listVaultStatus,
  getVaultSecret
};
