'use strict';

/**
 * Magic-Byte Validated Product Image Upload Pipeline (src/core/checkout/imageUploader.js)
 * Restricts uploads strictly to verified JPEG, PNG, and WebP images (<= 5 MB) and saves to public/uploads/.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT_DIR } = require('../../config/appConfig');
const { getDb } = require('../../db/database');
const { recordAuditLog } = require('../auth/rbac');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

function detectImageFormatFromMagicBytes(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: '.jpg', mime: 'image/jpeg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { ext: '.png', mime: 'image/png' };
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    buf.slice(0, 4).toString('ascii') === 'RIFF' &&
    buf.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: '.webp', mime: 'image/webp' };
  }
  return null;
}

function uploadProductImage({
  productId,
  imageBase64,
  caption = 'Front / Nutrition Pack View',
  setAsPrimary = false,
  actorEmail = 'catalog@sasynaturals.com',
  actorRole = 'PRODUCT_MANAGER'
}) {
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    throw new Error('Missing image payload.');
  }
  const cleanBase64 = imageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
  const buf = Buffer.from(cleanBase64, 'base64');

  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image size must be between 1 byte and 5 MB (received ${buf.length} bytes).`);
  }

  const format = detectImageFormatFromMagicBytes(buf);
  if (!format) {
    throw new Error('Security Violation: File magic bytes do not match a valid JPEG, PNG, or WebP image.');
  }

  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(productId));
  if (!product) {
    throw new Error(`Product #${productId} not found.`);
  }

  const uploadsDir = path.join(ROOT_DIR, 'public/uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
  const fileName = `${product.slug}-${hash}${format.ext}`;
  const filePath = path.join(uploadsDir, fileName);
  fs.writeFileSync(filePath, buf);

  const publicUrl = `/uploads/${fileName}`;
  let gallery = [];
  try {
    gallery = JSON.parse(product.gallery_json || '[]');
    if (!Array.isArray(gallery)) gallery = [];
  } catch {
    gallery = [];
  }
  gallery.push({ url: publicUrl, caption: String(caption || '').trim(), mime: format.mime });

  if (setAsPrimary) {
    db.prepare('UPDATE products SET image_url = ?, image_caption = ?, gallery_json = ? WHERE id = ?').run(
      publicUrl,
      String(caption || '').trim(),
      JSON.stringify(gallery),
      product.id
    );
  } else {
    db.prepare('UPDATE products SET gallery_json = ? WHERE id = ?').run(JSON.stringify(gallery), product.id);
  }

  recordAuditLog({
    actorEmail,
    actorRole,
    action: 'PRODUCT_IMAGE_UPLOADED',
    entityType: 'PRODUCT',
    entityId: product.sku_base,
    details: { publicUrl, bytes: buf.length, mime: format.mime, setAsPrimary }
  });

  return {
    productId: product.id,
    publicUrl,
    mime: format.mime,
    bytes: buf.length,
    galleryCount: gallery.length
  };
}

module.exports = {
  MAX_IMAGE_BYTES,
  detectImageFormatFromMagicBytes,
  uploadProductImage
};
