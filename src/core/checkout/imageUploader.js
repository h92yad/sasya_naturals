'use strict';

/**
 * Magic-Byte Validated Product & Category Image Upload Pipeline (src/core/checkout/imageUploader.js)
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
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  // Reject polyglot files embedding executable HTML / JS / PHP / SVG script payloads
  const asciiSample = buf.slice(0, Math.min(buf.length, 16384)).toString('latin1');
  if (/<\s*script|<\?php|<\s*html|<!doctype\s+html|javascript:|onerror\s*=|onload\s*=/i.test(asciiSample)) {
    return null;
  }
  // JPEG: FF D8 FF and must end with EOI marker FF D9 (or have valid JFIF/Exif/quantization structure)
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const hasEoi = buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
    if (!hasEoi && buf.length < 128) return null;
    return { ext: '.jpg', mime: 'image/jpeg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR chunk header at bytes 12..16
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a &&
    buf.slice(12, 16).toString('ascii') === 'IHDR'
  ) {
    return { ext: '.png', mime: 'image/png' };
  }
  // WebP: "RIFF" .... "WEBP" + "VP8" chunk at bytes 12..15
  if (
    buf.slice(0, 4).toString('ascii') === 'RIFF' &&
    buf.slice(8, 12).toString('ascii') === 'WEBP' &&
    buf.slice(12, 15).toString('ascii') === 'VP8'
  ) {
    return { ext: '.webp', mime: 'image/webp' };
  }
  return null;
}

function saveVerifiedImageToUploads(imageBase64, prefixSlug = 'media') {
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

  const uploadsDir = path.join(ROOT_DIR, 'public/uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
  const safePrefix = String(prefixSlug || 'media').replace(/[^a-z0-9-_]/gi, '-').toLowerCase();
  const fileName = `${safePrefix}-${hash}${format.ext}`;
  const filePath = path.join(uploadsDir, fileName);
  fs.writeFileSync(filePath, buf);

  return {
    publicUrl: `/uploads/${fileName}`,
    mime: format.mime,
    bytes: buf.length
  };
}

function uploadProductImage({
  productId,
  imageBase64,
  caption = 'Front / Nutrition Pack View',
  setAsPrimary = true,
  actorEmail = 'catalog@sashyanaturals.com',
  actorRole = 'PRODUCT_MANAGER'
}) {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(productId));
  if (!product) {
    throw new Error(`Product #${productId} not found.`);
  }

  const saved = saveVerifiedImageToUploads(imageBase64, product.slug);

  let gallery = [];
  try {
    gallery = JSON.parse(product.gallery_json || '[]');
    if (!Array.isArray(gallery)) gallery = [];
  } catch {
    gallery = [];
  }
  gallery = gallery.filter(g => g && g.url !== saved.publicUrl);
  gallery.push({
    url: saved.publicUrl,
    caption: String(caption || '').trim().slice(0, 140),
    mime: saved.mime,
    isPrimary: Boolean(setAsPrimary)
  });
  if (gallery.length > 12) {
    gallery = gallery.slice(-12);
  }

  if (setAsPrimary) {
    db.prepare('UPDATE products SET image_url = ?, image_caption = ?, gallery_json = ? WHERE id = ?').run(
      saved.publicUrl,
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
    action: setAsPrimary ? 'PRODUCT_PRIMARY_IMAGE_CHANGED' : 'PRODUCT_GALLERY_IMAGE_ADDED',
    entityType: 'PRODUCT',
    entityId: product.sku_base,
    details: { publicUrl: saved.publicUrl, bytes: saved.bytes, mime: saved.mime, setAsPrimary }
  });

  return {
    productId: product.id,
    publicUrl: saved.publicUrl,
    mime: saved.mime,
    bytes: saved.bytes,
    setAsPrimary: Boolean(setAsPrimary),
    galleryCount: gallery.length
  };
}

function uploadCategoryImage({
  categoryId,
  imageBase64,
  actorEmail = 'catalog@sashyanaturals.com',
  actorRole = 'PRODUCT_MANAGER'
}) {
  const db = getDb();
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(categoryId));
  if (!category) {
    throw new Error(`Category #${categoryId} not found.`);
  }

  const saved = saveVerifiedImageToUploads(imageBase64, `cat-${category.slug}`);

  db.prepare('UPDATE categories SET image_url = ? WHERE id = ?').run(saved.publicUrl, category.id);

  recordAuditLog({
    actorEmail,
    actorRole,
    action: 'CATEGORY_IMAGE_CHANGED',
    entityType: 'CATEGORY',
    entityId: category.slug,
    details: { publicUrl: saved.publicUrl, bytes: saved.bytes, mime: saved.mime }
  });

  return {
    categoryId: category.id,
    slug: category.slug,
    publicUrl: saved.publicUrl,
    mime: saved.mime,
    bytes: saved.bytes
  };
}

module.exports = {
  MAX_IMAGE_BYTES,
  detectImageFormatFromMagicBytes,
  saveVerifiedImageToUploads,
  uploadProductImage,
  uploadCategoryImage
};
