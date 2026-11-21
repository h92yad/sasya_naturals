'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { DB_PATH } = require('../config/appConfig');

let dbInstance = null;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `pbkdf2_sha512$100000$${salt}$${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.startsWith('pbkdf2_sha512$')) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 4) return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = parts[3];
  const actual = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function getDb() {
  if (dbInstance) return dbInstance;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  dbInstance = new DatabaseSync(DB_PATH);
  dbInstance.exec('PRAGMA journal_mode = WAL;');
  dbInstance.exec('PRAGMA foreign_keys = ON;');
  initSchema(dbInstance);
  seedDatabaseIfEmpty(dbInstance);
  ensureCompleteSection3CatalogAndCustomerAddresses(dbInstance);
  return dbInstance;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'CUSTOMER',
      permissions_json TEXT NOT NULL DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS customer_addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT 'Home',
      recipient_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      line1 TEXT NOT NULL,
      line2 TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      pincode TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      subtitle TEXT NOT NULL,
      description TEXT NOT NULL,
      image_url TEXT NOT NULL,
      display_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku_base TEXT UNIQUE NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      short_description TEXT NOT NULL,
      description TEXT NOT NULL,
      origin_region TEXT NOT NULL,
      harvest_batch TEXT NOT NULL,
      shelf_life_months INTEGER NOT NULL DEFAULT 9,
      fssai_notes TEXT NOT NULL,
      ingredients TEXT NOT NULL,
      allergen_info TEXT NOT NULL,
      gst_percent INTEGER NOT NULL DEFAULT 5,
      image_url TEXT NOT NULL,
      image_caption TEXT NOT NULL DEFAULT '',
      is_featured INTEGER NOT NULL DEFAULT 0,
      is_new_arrival INTEGER NOT NULL DEFAULT 0,
      is_bestseller INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      rating_value REAL NOT NULL DEFAULT 4.8,
      review_count INTEGER NOT NULL DEFAULT 24,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS product_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      sku TEXT UNIQUE NOT NULL,
      pack_label TEXT NOT NULL,
      weight_grams INTEGER NOT NULL,
      mrp_paise INTEGER NOT NULL,
      selling_price_paise INTEGER NOT NULL,
      promo_price_paise INTEGER,
      stock_qty INTEGER NOT NULL DEFAULT 50,
      low_stock_threshold INTEGER NOT NULL DEFAULT 10,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS inventory_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      variant_id INTEGER NOT NULL REFERENCES product_variants(id),
      delta_qty INTEGER NOT NULL,
      previous_qty INTEGER NOT NULL,
      new_qty INTEGER NOT NULL,
      reason TEXT NOT NULL,
      reference_id TEXT NOT NULL DEFAULT '',
      actor_name TEXT NOT NULL DEFAULT 'System',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS coupons (
      code TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      discount_type TEXT NOT NULL,
      discount_value INTEGER NOT NULL,
      min_order_paise INTEGER NOT NULL DEFAULT 0,
      max_discount_paise INTEGER NOT NULL DEFAULT 100000,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      user_id INTEGER REFERENCES users(id),
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      shipping_line1 TEXT NOT NULL,
      shipping_line2 TEXT NOT NULL DEFAULT '',
      shipping_city TEXT NOT NULL,
      shipping_state TEXT NOT NULL,
      shipping_pincode TEXT NOT NULL,
      delivery_instructions TEXT NOT NULL DEFAULT '',
      subtotal_paise INTEGER NOT NULL,
      discount_paise INTEGER NOT NULL DEFAULT 0,
      gst_paise INTEGER NOT NULL DEFAULT 0,
      shipping_paise INTEGER NOT NULL DEFAULT 0,
      total_paise INTEGER NOT NULL,
      coupon_code TEXT NOT NULL DEFAULT '',
      payment_method TEXT NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
      fulfilment_status TEXT NOT NULL DEFAULT 'Pending Payment',
      gateway_order_id TEXT NOT NULL DEFAULT '',
      gateway_payment_id TEXT NOT NULL DEFAULT '',
      gateway_signature TEXT NOT NULL DEFAULT '',
      courier_name TEXT NOT NULL DEFAULT '',
      tracking_number TEXT NOT NULL DEFAULT '',
      tracking_url TEXT NOT NULL DEFAULT '',
      dispatch_date TEXT NOT NULL DEFAULT '',
      manual_shipping_charge_paise INTEGER NOT NULL DEFAULT 0,
      stock_deducted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      variant_id INTEGER NOT NULL REFERENCES product_variants(id),
      product_name TEXT NOT NULL,
      sku TEXT NOT NULL,
      pack_label TEXT NOT NULL,
      weight_grams INTEGER NOT NULL,
      unit_price_paise INTEGER NOT NULL,
      mrp_paise INTEGER NOT NULL,
      gst_percent INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      line_total_paise INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      order_number TEXT NOT NULL,
      gateway_provider TEXT NOT NULL,
      gateway_order_id TEXT NOT NULL,
      gateway_payment_id TEXT NOT NULL DEFAULT '',
      method TEXT NOT NULL,
      amount_paise INTEGER NOT NULL,
      status TEXT NOT NULL,
      verified_on_server INTEGER NOT NULL DEFAULT 0,
      cod_collected_at TEXT NOT NULL DEFAULT '',
      refund_amount_paise INTEGER NOT NULL DEFAULT 0,
      refund_reason TEXT NOT NULL DEFAULT '',
      refunded_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER,
      actor_email TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notification_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL,
      recipient TEXT NOT NULL,
      event_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_preview TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'SENT_SANDBOX',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS credential_vault (
      key_name TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      provider_group TEXT NOT NULL,
      encrypted_ciphertext TEXT NOT NULL DEFAULT '',
      iv_hex TEXT NOT NULL DEFAULT '',
      auth_tag_hex TEXT NOT NULL DEFAULT '',
      masked_hint TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
      is_configured INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT NOT NULL DEFAULT 'system',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cod_otps (
      phone TEXT PRIMARY KEY,
      otp_hash TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blocked_pincodes (
      pincode TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      block_cod_only INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Safe idempotent column migrations for existing databases
  const safeAlter = [
    "ALTER TABLE products ADD COLUMN hsn_code TEXT NOT NULL DEFAULT '080290'",
    "ALTER TABLE products ADD COLUMN gallery_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE orders ADD COLUMN tax_supply_type TEXT NOT NULL DEFAULT 'CGST_SGST'",
    "ALTER TABLE orders ADD COLUMN cgst_paise INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE orders ADD COLUMN sgst_paise INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE orders ADD COLUMN igst_paise INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE orders ADD COLUMN cod_otp_verified INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE order_items ADD COLUMN hsn_code TEXT NOT NULL DEFAULT '080290'"
  ];
  for (const sql of safeAlter) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists
    }
  }

  seedVaultAndHsnDefaults(db);
}

function seedVaultAndHsnDefaults(db) {
  const vaultEntries = [
    ['RAZORPAY_KEY_ID', 'Razorpay Live/Test Key ID', 'RAZORPAY'],
    ['RAZORPAY_KEY_SECRET', 'Razorpay Key Secret (HMAC-SHA256)', 'RAZORPAY'],
    ['RAZORPAY_WEBHOOK_SECRET', 'Razorpay Async Webhook Secret', 'RAZORPAY'],
    ['SMTP_API_KEY', 'Transactional Email (SMTP / Resend / SES) API Key', 'NOTIFICATIONS'],
    ['WHATSAPP_OTP_API_KEY', 'SMS / WhatsApp COD OTP Provider API Key', 'NOTIFICATIONS']
  ];
  const insertVault = db.prepare(`
    INSERT OR IGNORE INTO credential_vault (key_name, label, provider_group, is_configured, masked_hint)
    VALUES (?, ?, ?, 0, 'NOT_CONFIGURED')
  `);
  for (const [k, label, grp] of vaultEntries) {
    insertVault.run(k, label, grp);
  }

  db.prepare(`
    INSERT OR IGNORE INTO blocked_pincodes (pincode, reason, block_cod_only)
    VALUES ('999999', 'Unserviceable Test PIN Code', 0),
           ('800099', 'High RTO Zone - Prepaid Only (COD Disabled)', 1)
  `).run();

  // Assign authentic Indian GST HSN codes by category if default
  db.prepare("UPDATE products SET hsn_code = '080132' WHERE slug LIKE '%cashew%'").run();
  db.prepare("UPDATE products SET hsn_code = '080420' WHERE slug LIKE '%fig%'").run();
  db.prepare("UPDATE products SET hsn_code = '100821' WHERE category_id = 2").run();
  db.prepare("UPDATE products SET hsn_code = '100790' WHERE slug LIKE '%jowar%'").run();
  db.prepare("UPDATE products SET hsn_code = '091030' WHERE slug LIKE '%turmeric%'").run();
  db.prepare("UPDATE products SET hsn_code = '090411' WHERE slug LIKE '%pepper%'").run();
  db.prepare("UPDATE products SET hsn_code = '090831' WHERE slug LIKE '%cardamom%'").run();
  db.prepare("UPDATE products SET hsn_code = '090422' WHERE slug LIKE '%chilli%'").run();
  db.prepare("UPDATE products SET hsn_code = '090611' WHERE slug LIKE '%cinnamon%'").run();

  // Backfill CGST/SGST vs IGST on seeded orders
  db.prepare(`
    UPDATE orders
    SET tax_supply_type = 'CGST_SGST',
        cgst_paise = gst_paise / 2,
        sgst_paise = gst_paise - (gst_paise / 2),
        igst_paise = 0
    WHERE shipping_state = 'Karnataka' AND cgst_paise = 0 AND igst_paise = 0
  `).run();

  db.prepare(`
    UPDATE orders
    SET tax_supply_type = 'IGST',
        cgst_paise = 0,
        sgst_paise = 0,
        igst_paise = gst_paise
    WHERE shipping_state != 'Karnataka' AND cgst_paise = 0 AND igst_paise = 0
  `).run();

  // Seed configurable 4-Zone + 500g Weight-Slab + Free-Delivery Policy settings
  const defaultShippingSettings = [
    ['shipping_free_mode', 'THRESHOLD_WITH_WEIGHT_CAP'], // DISABLED | THRESHOLD_WITH_WEIGHT_CAP | UNCONDITIONAL_THRESHOLD
    ['free_shipping_threshold_inr', '799'],
    ['free_shipping_max_weight_grams', '2000'],
    ['shipping_packaging_tare_grams', '150'],
    ['shipping_cod_fee_inr', '40'],
    ['zone_a_base_inr', '40'],
    ['zone_a_extra_inr', '15'],
    ['zone_b_base_inr', '55'],
    ['zone_b_extra_inr', '25'],
    ['zone_c_base_inr', '75'],
    ['zone_c_extra_inr', '35'],
    ['zone_d_base_inr', '110'],
    ['zone_d_extra_inr', '55']
  ];
  const insertShipSetting = db.prepare('INSERT OR IGNORE INTO store_settings (key, value) VALUES (?, ?)');
  for (const [k, v] of defaultShippingSettings) {
    insertShipSetting.run(k, v);
  }
}

function seedDatabaseIfEmpty(db) {
  const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM categories').get();
  if (countRow && countRow.cnt > 0) return;

  // 1. Store compliance & business settings (Section 11 — Configurable, not hardcoded assumptions)
  const settings = [
    ['business_legal_name', 'Sasya Naturals (Configurable Legal Entity Name)'],
    ['brand_domain', 'sasynaturals.com'],
    ['gstin', 'CONFIGURABLE_PENDING_TAX_ADVISER_VERIFICATION'],
    ['fssai_license', 'CONFIGURABLE_PENDING_FSSAI_VERIFICATION'],
    ['support_email', 'care@sasynaturals.com'],
    ['support_phone', '+91 80 4568 2200'],
    ['registered_address', 'Configurable Registered Office & Dispatch Address, Bengaluru, Karnataka'],
    ['free_shipping_threshold_inr', '799'],
    ['standard_shipping_charge_inr', '60'],
    ['cod_enabled', 'true'],
    ['email_template_order_confirmed', 'Namaste {{customer_name}}, your Sasya Naturals order {{order_number}} for Rs. {{total_inr}} is confirmed. We will share manual courier tracking once packed.'],
    ['email_template_order_shipped', 'Good news! Your Sasya Naturals order {{order_number}} has been dispatched via {{courier_name}} (Tracking: {{tracking_number}}).']
  ];
  const insertSetting = db.prepare('INSERT OR REPLACE INTO store_settings (key, value) VALUES (?, ?)');
  for (const [k, v] of settings) insertSetting.run(k, v);

  // 2. Seed 5 RBAC Staff Accounts + 1 Sample Customer Account (Section 5)
  const insertUser = db.prepare(`
    INSERT INTO users (email, full_name, phone, password_hash, role, permissions_json, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);
  const defaultHash = hashPassword('Sasya@2026');
  insertUser.run('superadmin@sasynaturals.com', 'Himanshu Yadav (Super Admin)', '+91 98100 10001', defaultHash, 'SUPER_ADMIN', JSON.stringify(['*']));
  insertUser.run('catalog@sasynaturals.com', 'Meera Nair (Product Manager)', '+91 98100 10002', defaultHash, 'PRODUCT_MANAGER', JSON.stringify(['products.view', 'products.write', 'inventory.view', 'inventory.write']));
  insertUser.run('orders@sasynaturals.com', 'Raghavendra Rao (Order Manager)', '+91 98100 10003', defaultHash, 'ORDER_MANAGER', JSON.stringify(['orders.view', 'orders.write', 'shipping.update']));
  insertUser.run('accounts@sasynaturals.com', 'Priya Sharma (Accounts Manager)', '+91 98100 10004', defaultHash, 'ACCOUNTS_MANAGER', JSON.stringify(['payments.view', 'payments.refund', 'reports.view']));
  insertUser.run('staff@sasynaturals.com', 'Karthik Verma (Dispatch Staff)', '+91 98100 10005', defaultHash, 'STAFF', JSON.stringify(['orders.view', 'shipping.update']));
  insertUser.run('ananya.iyer@example.com', 'Ananya Iyer', '+91 98450 22334', defaultHash, 'CUSTOMER', JSON.stringify([]));

  // 3. Seed 3 Initial Categories (Section 3.1)
  const insertCat = db.prepare(`
    INSERT INTO categories (slug, name, subtitle, description, image_url, display_order, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);
  insertCat.run(
    'dry-fruits',
    'Dry Fruits',
    'Single-Orchard Kernels, Whole Nuts & Sun-Dried Fruits',
    'Hand-graded almonds from Kashmir, whole W240 cashews from Goa, green pistachios, snow-white walnut halves, seedless black raisins, Ajwa dates, and dried figs packed fresh in nitrogen-flushed pouches.',
    '/images/cat-dry-fruits.jpg',
    1
  );
  insertCat.run(
    'millets-grains',
    'Millets & Grains',
    'Unpolished Native Siridhanya & Heirloom Indian Grains',
    'Low-glycemic, rain-fed native millets including ragi, foxtail millet, little millet, kodo millet, barnyard millet, jowar, and bajra. Cleaned without chemical polishing so the natural bran layer stays intact.',
    '/images/cat-millets-grains.jpg',
    2
  );
  insertCat.run(
    'spices',
    'Spices',
    'Cold-Milled Single-Origin Spices & Whole Aromatics',
    'High-oil heirloom spices sourced directly from grower cooperatives in Meghalaya, Guntur, Wayanad, and Idukki. Stone-ground in small batches without artificial colors or anti-caking fillers.',
    '/images/cat-spices.jpg',
    3
  );

  // 4. Seed Complete Product Catalogue with Pack-Size Variants (100 g, 250 g, 500 g, 1 kg)
  const catalogData = [
    {
      skuBase: 'SN-DF-ALM',
      slug: 'kashmiri-mamra-almonds',
      name: 'Kashmiri Mamra Giri Almonds',
      catId: 1,
      shortDesc: 'High-oil, unblanched heirloom Mamra almond kernels harvested from Pulwama orchards.',
      desc: 'Harvested from rain-fed almond trees in the Pulwama valley of Kashmir, these Mamra kernels contain significantly higher natural almond oil than mass-irrigated varieties. Every batch is shelled by hand and sorted for uniform crunch without artificial bleaching or mineral oil glazing.',
      origin: 'Pulwama, Jammu & Kashmir',
      batch: 'SN-KSH-2611A',
      shelfLife: 9,
      fssai: '100% Natural Tree Nut. Store in an airtight jar away from moisture.',
      ingredients: '100% Unblanched Kashmiri Mamra Almond Kernels (Prunus dulcis)',
      allergen: 'Contains Tree Nuts (Almonds). Packed in a facility that handles cashews, walnuts, and pistachios.',
      gst: 5,
      image: '/images/cat-dry-fruits.jpg',
      caption: 'Hand-shelled Kashmiri Mamra almonds in terracotta bowl',
      featured: 1,
      newArrival: 0,
      bestseller: 1,
      rating: 4.9,
      reviews: 68,
      base100gMrp: 36000,
      base100gSell: 32000
    },
    {
      skuBase: 'SN-DF-CSH',
      slug: 'goan-w240-whole-cashews',
      name: 'Goan W240 Jumbo Whole Cashews',
      catId: 1,
      shortDesc: 'Creamy, ivory-white W240 grade whole cashews steam-roasted for natural sweetness.',
      desc: 'Sourced from laterite hillside orchards in Bicholim, Goa, these W240 jumbo whole cashews are processed using gentle steam roasting rather than drum charring. The kernels retain their natural ivory tone, crisp snap, and clean buttery finish.',
      origin: 'Bicholim, Goa',
      batch: 'SN-GOA-2611B',
      shelfLife: 9,
      fssai: 'Grade W240 Whole Kernels. Zero broken pieces guaranteed at packing.',
      ingredients: '100% Whole Cashew Kernels (Anacardium occidentale)',
      allergen: 'Contains Tree Nuts (Cashews).',
      gst: 5,
      image: '/images/cat-dry-fruits.jpg',
      caption: 'Whole W240 Goan cashews',
      featured: 1,
      newArrival: 0,
      bestseller: 1,
      rating: 4.8,
      reviews: 54,
      base100gMrp: 22000,
      base100gSell: 18500
    },
    {
      skuBase: 'SN-DF-PST',
      slug: 'lightly-salted-roasted-pistachios',
      name: 'Lightly Salted Roasted Pistachios',
      catId: 1,
      shortDesc: 'Naturally split jumbo pistachios dry-roasted with a pinch of rock salt.',
      desc: 'Large, naturally split pistachio nuts dry-roasted in small cast-iron batches with unrefined Sendha Namak (pink rock salt). Free from synthetic green food dyes and excess sodium crust.',
      origin: 'Kerman Cultivar / Packed in Bengaluru',
      batch: 'SN-PST-2611C',
      shelfLife: 9,
      fssai: 'Dry-roasted without oil. Contains 1.2% rock salt.',
      ingredients: 'Pistachio Nuts (98.8%), Unrefined Pink Rock Salt (1.2%)',
      allergen: 'Contains Tree Nuts (Pistachios).',
      gst: 12,
      image: '/images/cat-dry-fruits.jpg',
      caption: 'Dry-roasted green pistachios',
      featured: 0,
      newArrival: 1,
      bestseller: 0,
      rating: 4.8,
      reviews: 31,
      base100gMrp: 28000,
      base100gSell: 24500
    },
    {
      skuBase: 'SN-DF-WLN',
      slug: 'kashmiri-snow-white-walnut-halves',
      name: 'Kashmiri Snow-White Walnut Halves (Akhrot Giri)',
      catId: 1,
      shortDesc: 'Paper-shell Kupwara walnut halves rich in plant omega-3 fatty acids.',
      desc: 'Hand-cracked from thin-shelled Kagzi walnuts grown in Kupwara, Kashmir. We select only light-amber and snow-white butterfly halves so you never taste rancid or bitter dark skins.',
      origin: 'Kupwara, Jammu & Kashmir',
      batch: 'SN-WLN-2610D',
      shelfLife: 6,
      fssai: 'High natural polyunsaturated fat content. Refrigerate after opening.',
      ingredients: '100% Shelled Kashmiri Walnut Halves (Juglans regia)',
      allergen: 'Contains Tree Nuts (Walnuts).',
      gst: 5,
      image: '/images/cat-dry-fruits.jpg',
      caption: 'Kashmiri walnut butterfly halves',
      featured: 1,
      newArrival: 0,
      bestseller: 0,
      rating: 4.9,
      reviews: 42,
      base100gMrp: 26000,
      base100gSell: 22500
    },
    {
      skuBase: 'SN-DF-FIG',
      slug: 'afghan-jumbo-dried-figs-anjeer',
      name: 'Sun-Dried Jumbo Anjeer (Dried Figs)',
      catId: 1,
      shortDesc: 'Soft, honey-sweet sun-dried figs strung on natural cord without sulphur bleaching.',
      desc: 'Plump, thin-skinned figs dried slowly in dry mountain air and braided into flat wheels. Never treated with sulphur dioxide gas or coated in glucose syrup. Ideal for soaking overnight or slicing into morning porridge.',
      origin: 'Kandahar / Packed in Bengaluru',
      batch: 'SN-ANJ-2611E',
      shelfLife: 9,
      fssai: 'Unsulphured dried fruit. Natural sugar crystals may form in cool storage.',
      ingredients: '100% Whole Sun-Dried Figs (Ficus carica)',
      allergen: 'Packed in a facility that handles tree nuts.',
      gst: 5,
      image: '/images/cat-dry-fruits.jpg',
      caption: 'Sun-dried Anjeer figs',
      featured: 0,
      newArrival: 0,
      bestseller: 1,
      rating: 4.8,
      reviews: 39,
      base100gMrp: 25000,
      base100gSell: 21500
    },
    {
      skuBase: 'SN-DF-MIX',
      slug: 'royal-panchmeva-daily-trail-mix',
      name: 'Royal Panchmeva Roasted & Raw Dry Fruit Mix',
      catId: 1,
      shortDesc: 'Balanced five-ingredient blend of Mamra almonds, W240 cashews, walnuts, pistachios, and black raisins.',
      desc: 'Formulated for daily family nutrition without cheap peanut or candied papaya fillers. Every pouch combines equal weights of Kashmiri almonds, Goan cashews, walnut halves, green pistachio kernels, and seedless black raisins.',
      origin: 'Small-Batch Blended in Karnataka',
      batch: 'SN-PMV-2611F',
      shelfLife: 9,
      fssai: 'Zero added sugar, zero vegetable oil, zero artificial preservatives.',
      ingredients: 'Almonds (22%), Cashews (22%), Walnuts (20%), Pistachio Kernels (18%), Seedless Black Raisins (18%)',
      allergen: 'Contains Tree Nuts (Almonds, Cashews, Walnuts, Pistachios).',
      gst: 12,
      image: '/images/cat-dry-fruits.jpg',
      caption: 'Royal Panchmeva five-nut blend',
      featured: 1,
      newArrival: 1,
      bestseller: 1,
      rating: 4.9,
      reviews: 47,
      base100gMrp: 24000,
      base100gSell: 19900
    },

    // Category 2: Millets & Grains
    {
      skuBase: 'SN-ML-RAG',
      slug: 'unpolished-haveri-finger-millet-ragi',
      name: 'Unpolished Haveri Finger Millet (Ragi Whole & Flour)',
      catId: 2,
      shortDesc: 'Calcium-rich red ragi harvested from rain-fed red loam farms in Haveri.',
      desc: 'Grown without synthetic fertilizers by smallholder farmers in Haveri, Karnataka. Our finger millet is de-stoned and gravity-cleaned while keeping the mineral-dense reddish bran intact. Suitable for sprouting, malt, mudde, and dosa batters.',
      origin: 'Haveri, Karnataka',
      batch: 'SN-RAG-2611A',
      shelfLife: 9,
      fssai: 'Naturally gluten-free whole grain millet.',
      ingredients: '100% Unpolished Finger Millet (Eleusine coracana)',
      allergen: 'Naturally Gluten-Free. Packed on dedicated millet cleaning lines.',
      gst: 5,
      image: '/images/cat-millets-grains.jpg',
      caption: 'Unpolished red Ragi finger millet in clay bowl',
      featured: 1,
      newArrival: 0,
      bestseller: 1,
      rating: 4.9,
      reviews: 61,
      base100gMrp: 4500,
      base100gSell: 3500
    },
    {
      skuBase: 'SN-ML-FOX',
      slug: 'chitradurga-unpolished-foxtail-millet',
      name: 'Chitradurga Unpolished Foxtail Millet (Navane / Kangni)',
      catId: 2,
      shortDesc: 'Golden hull-removed foxtail millet for fluffy pulao, pongal, and daily rice replacement.',
      desc: 'Grown in the drylands of Chitradurga, foxtail millet cooks in 15 minutes with a light, nutty aroma. We use rubber-roll de-husking to remove only the indigestible outer husk while preserving dietary fiber and B-vitamins.',
      origin: 'Chitradurga, Karnataka',
      batch: 'SN-FOX-2611B',
      shelfLife: 9,
      fssai: 'Soak for 30 minutes before cooking for optimal digestibility.',
      ingredients: '100% Unpolished Foxtail Millet (Setaria italica)',
      allergen: 'Naturally Gluten-Free.',
      gst: 5,
      image: '/images/cat-millets-grains.jpg',
      caption: 'Golden unpolished Foxtail Millet',
      featured: 1,
      newArrival: 0,
      bestseller: 1,
      rating: 4.8,
      reviews: 44,
      base100gMrp: 5500,
      base100gSell: 4200
    },
    {
      skuBase: 'SN-ML-LIT',
      slug: 'native-little-millet-saame-kutki',
      name: 'Native Unpolished Little Millet (Saame / Kutki)',
      catId: 2,
      shortDesc: 'Tiny, fast-cooking millet grain ideal for curd rice, lemon rice, and upma.',
      desc: 'Little millet is the closest textural match to short-grain ponni rice, making it effortless for families transitioning to millet meals. Sourced from rain-fed plots in Dharwad and triple-cleaned for zero grit.',
      origin: 'Dharwad, Karnataka',
      batch: 'SN-LIT-2611C',
      shelfLife: 9,
      fssai: 'Unpolished Siridhanya millet grain.',
      ingredients: '100% Unpolished Little Millet (Panicum sumatrense)',
      allergen: 'Naturally Gluten-Free.',
      gst: 5,
      image: '/images/cat-millets-grains.jpg',
      caption: 'Native Little Millet grain',
      featured: 0,
      newArrival: 1,
      bestseller: 0,
      rating: 4.7,
      reviews: 28,
      base100gMrp: 6000,
      base100gSell: 4600
    },
    {
      skuBase: 'SN-ML-KOD',
      slug: 'vindhya-unpolished-kodo-millet',
      name: 'Heirloom Unpolished Kodo Millet (Arikelu / Kodra)',
      catId: 2,
      shortDesc: 'Earthy, slow-digesting Kodo millet prized for sustained daytime energy.',
      desc: 'Cultivated in mineral-rich soils without chemical pesticides, Kodo millet offers high soluble fiber and slow carbohydrate release. Rinse twice and soak for 45 minutes before pressure cooking.',
      origin: 'Mandla & Dindori Belt, Madhya Pradesh',
      batch: 'SN-KOD-2611D',
      shelfLife: 9,
      fssai: 'Lab-tested for zero mycotoxins and zero pesticide residue.',
      ingredients: '100% Unpolished Kodo Millet (Paspalum scrobiculatum)',
      allergen: 'Naturally Gluten-Free.',
      gst: 5,
      image: '/images/cat-millets-grains.jpg',
      caption: 'Unpolished Kodo Millet',
      featured: 0,
      newArrival: 0,
      bestseller: 0,
      rating: 4.8,
      reviews: 22,
      base100gMrp: 5800,
      base100gSell: 4500
    },
    {
      skuBase: 'SN-ML-JWR',
      slug: 'solapur-maldandi-jowar-sorghum',
      name: 'Solapur Maldandi White Jowar (Sorghum Grain)',
      catId: 2,
      shortDesc: 'Sweet, soft-rolling Maldandi cultivar jowar for tender bhakri and rotis.',
      desc: 'The Maldandi winter-crop variety from Solapur is famous across Maharashtra and North Karnataka for yielding soft, pliable rotis that stay tender for hours. Cleaned and sun-dried without fumigation chemicals.',
      origin: 'Solapur, Maharashtra',
      batch: 'SN-JWR-2611E',
      shelfLife: 9,
      fssai: 'Whole grain sorghum suitable for home milling or whole cooking.',
      ingredients: '100% Maldandi White Sorghum (Sorghum bicolor)',
      allergen: 'Naturally Gluten-Free.',
      gst: 5,
      image: '/images/cat-millets-grains.jpg',
      caption: 'Solapur Maldandi White Jowar',
      featured: 0,
      newArrival: 1,
      bestseller: 0,
      rating: 4.9,
      reviews: 35,
      base100gMrp: 4200,
      base100gSell: 3200
    },

    // Category 3: Spices
    {
      skuBase: 'SN-SP-TUR',
      slug: 'meghalaya-lakadong-turmeric-powder',
      name: 'Meghalaya Lakadong High-Curcumin Turmeric Powder',
      catId: 3,
      shortDesc: 'Single-origin Jaintia Hills turmeric tested at 7.8% natural curcumin content.',
      desc: 'Grown in the misty foothills of West Jaintia Hills, Meghalaya, our Lakadong turmeric rhizomes are sun-cured and cold-milled below 42 degrees Celsius to protect volatile essential oils. Lab-verified at 7.8% curcumin, which is more than double ordinary market turmeric.',
      origin: 'West Jaintia Hills, Meghalaya',
      batch: 'SN-LAK-2611A',
      shelfLife: 12,
      fssai: 'Lab-certified 7.8% curcumin. Zero lead chromate, zero starch filler.',
      ingredients: '100% Pure Lakadong Turmeric Rhizome Powder (Curcuma longa)',
      allergen: 'None. Pure single-ingredient spice.',
      gst: 5,
      image: '/images/cat-spices.jpg',
      caption: 'Golden Lakadong Turmeric in brass bowl',
      featured: 1,
      newArrival: 0,
      bestseller: 1,
      rating: 5.0,
      reviews: 84,
      base100gMrp: 16000,
      base100gSell: 13500
    },
    {
      skuBase: 'SN-SP-PEP',
      slug: 'wayanad-tellicherry-garbled-black-pepper',
      name: 'Wayanad TGSEB Bold Black Peppercorns',
      catId: 3,
      shortDesc: '4.75mm+ Tellicherry Garbled Special Extra Bold peppercorns grown on forest vines.',
      desc: 'Intercropped on silver-oak shade trees in Wayanad, Kerala, these late-harvest peppercorns are picked just as the berries turn deep orange-red, giving them intense piperine heat and citrus-wood aroma.',
      origin: 'Wayanad, Kerala',
      batch: 'SN-PEP-2611B',
      shelfLife: 18,
      fssai: 'Grade TGSEB (>4.75mm pinhead free). Unextracted whole berries.',
      ingredients: '100% Whole Black Peppercorns (Piper nigrum)',
      allergen: 'None.',
      gst: 5,
      image: '/images/cat-spices.jpg',
      caption: 'Wayanad Tellicherry bold black peppercorns',
      featured: 1,
      newArrival: 0,
      bestseller: 1,
      rating: 4.9,
      reviews: 53,
      base100gMrp: 19500,
      base100gSell: 16500
    },
    {
      skuBase: 'SN-SP-CRD',
      slug: 'idukki-8mm-green-cardamom-pods',
      name: 'Idukki 8mm+ Bold Green Cardamom (Elaichi)',
      catId: 3,
      shortDesc: 'Aromatic 8mm bold green pods packed with sticky, oil-rich black seeds.',
      desc: 'Harvested from high-altitude estates in the Cardamom Hills of Idukki, Kerala. Each 8mm+ pod is cured in temperature-controlled chambers to lock in its natural parrot-green chlorophyll color and sweet eucalyptus aroma without artificial green spray.',
      origin: 'Idukki, Kerala',
      batch: 'SN-CRD-2611C',
      shelfLife: 12,
      fssai: 'Alleppey Green Extra Bold (AGEB 8mm+). Zero artificial coloring.',
      ingredients: '100% Whole Green Cardamom Pods (Elettaria cardamomum)',
      allergen: 'None.',
      gst: 5,
      image: '/images/cat-spices.jpg',
      caption: 'Idukki 8mm bold green cardamom pods',
      featured: 1,
      newArrival: 1,
      bestseller: 1,
      rating: 4.9,
      reviews: 49,
      base100gMrp: 48000,
      base100gSell: 42000
    },
    {
      skuBase: 'SN-SP-CHL',
      slug: 'byadgi-guntur-heirloom-chilli-powder',
      name: 'Dharwad Byadgi & Guntur Balanced Red Chilli Powder',
      catId: 3,
      shortDesc: 'Deep crimson natural color from wrinkled Byadgi chillies with clean medium heat.',
      desc: 'We blend 70% wrinkled Dharwad Byadgi chillies for deep paprika-red natural color and sweet aroma with 30% Guntur Sannam chillies for balanced warmth. Pounded at low speed without added vegetable oil or Sudan red dye.',
      origin: 'Byadgi (Karnataka) & Guntur (Andhra Pradesh)',
      batch: 'SN-CHL-2611D',
      shelfLife: 12,
      fssai: 'Zero artificial Sudan dye, zero added oil.',
      ingredients: 'Byadgi Red Chilli (70%), Guntur Sannam Red Chilli (30%)',
      allergen: 'None.',
      gst: 5,
      image: '/images/cat-spices.jpg',
      caption: 'Sun-dried Byadgi and Guntur red chilli blend',
      featured: 0,
      newArrival: 0,
      bestseller: 0,
      rating: 4.8,
      reviews: 37,
      base100gMrp: 11500,
      base100gSell: 9500
    },
    {
      skuBase: 'SN-SP-CIN',
      slug: 'true-ceylon-alba-cinnamon-quills',
      name: 'True Ceylon Cinnamon Quills (Cinnamomum verum)',
      catId: 3,
      shortDesc: 'Paper-thin, multi-layered sweet cinnamon cigars with ultra-low coumarin.',
      desc: 'Unlike thick, single-bark Cassia sold in supermarkets, true Cinnamomum verum quills consist of delicate concentric inner bark layers rolled by hand. Mildly sweet, citrusy, and safe for daily herbal teas and baking.',
      origin: 'Southern Highlands / Packed in Bengaluru',
      batch: 'SN-CIN-2611E',
      shelfLife: 18,
      fssai: 'True Cinnamomum verum (<0.004% coumarin). Not Cassia bark.',
      ingredients: '100% True Cinnamon Inner Bark Quills (Cinnamomum verum)',
      allergen: 'None.',
      gst: 5,
      image: '/images/cat-spices.jpg',
      caption: 'Hand-rolled True Ceylon Cinnamon quills',
      featured: 0,
      newArrival: 1,
      bestseller: 0,
      rating: 4.9,
      reviews: 29,
      base100gMrp: 29000,
      base100gSell: 24500
    }
  ];

  const insertProd = db.prepare(`
    INSERT INTO products (
      sku_base, slug, name, category_id, short_description, description,
      origin_region, harvest_batch, shelf_life_months, fssai_notes,
      ingredients, allergen_info, gst_percent, image_url, image_caption,
      is_featured, is_new_arrival, is_bestseller, is_active, rating_value, review_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);

  const insertVar = db.prepare(`
    INSERT INTO product_variants (
      product_id, sku, pack_label, weight_grams, mrp_paise,
      selling_price_paise, promo_price_paise, stock_qty, low_stock_threshold, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 10, 1)
  `);

  const packMultipliers = [
    { label: '100 g', grams: 100, suffix: '100G', mult: 1.0, stock: 45 },
    { label: '250 g', grams: 250, suffix: '250G', mult: 2.35, stock: 60 },
    { label: '500 g', grams: 500, suffix: '500G', mult: 4.45, stock: 35 },
    { label: '1 kg',  grams: 1000, suffix: '1KG', mult: 8.5, stock: 20 }
  ];

  for (const p of catalogData) {
    const info = insertProd.run(
      p.skuBase, p.slug, p.name, p.catId, p.shortDesc, p.desc,
      p.origin, p.batch, p.shelfLife, p.fssai,
      p.ingredients, p.allergen, p.gst, p.image, p.caption,
      p.featured, p.newArrival, p.bestseller, p.rating, p.reviews
    );
    const productId = Number(info.lastInsertRowid);

    for (const pm of packMultipliers) {
      const mrp = Math.round((p.base100gMrp * pm.mult) / 500) * 500;
      const sell = Math.round((p.base100gSell * pm.mult) / 500) * 500;
      insertVar.run(
        productId,
        `${p.skuBase}-${pm.suffix}`,
        pm.label,
        pm.grams,
        mrp,
        sell,
        sell,
        pm.stock
      );
    }
  }

  // 5. Seed Promotional Coupons
  const insertCoupon = db.prepare(`
    INSERT INTO coupons (code, description, discount_type, discount_value, min_order_paise, max_discount_paise, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);
  insertCoupon.run('SASYA10', '10% off on orders above Rs. 499', 'PERCENT', 10, 49900, 50000);
  insertCoupon.run('WELCOME15', '15% off first pantry order above Rs. 999', 'PERCENT', 15, 99900, 75000);
  insertCoupon.run('PANTRY100', 'Flat Rs. 100 off on orders above Rs. 799', 'FLAT_PAISE', 10000, 79900, 10000);

  // 6. Seed 2 Realistic Sample Orders (1 Shipped Online Order with Manual Tracking + 1 Confirmed COD Order)
  const insertOrder = db.prepare(`
    INSERT INTO orders (
      order_number, user_id, customer_name, customer_email, customer_phone,
      shipping_line1, shipping_line2, shipping_city, shipping_state, shipping_pincode,
      delivery_instructions, subtotal_paise, discount_paise, gst_paise, shipping_paise,
      total_paise, coupon_code, payment_method, payment_status, fulfilment_status,
      gateway_order_id, gateway_payment_id, gateway_signature,
      courier_name, tracking_number, tracking_url, dispatch_date, manual_shipping_charge_paise, stock_deducted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const ord1 = insertOrder.run(
    'SN-2026-1001',
    6,
    'Ananya Iyer',
    'ananya.iyer@example.com',
    '+91 98450 22334',
    'Flat 402, Banyan Courtyard, Indiranagar 12th Main',
    'HAL 2nd Stage',
    'Bengaluru',
    'Karnataka',
    '560038',
    'Leave with security desk if unavailable',
    107000,
    10700,
    4586,
    0,
    96300,
    'SASYA10',
    'ONLINE_UPI',
    'PAID',
    'Shipped',
    'order_rzp_SN20261001',
    'pay_rzp_SN20261001',
    'verified_server_hmac_sha256',
    'Blue Dart Express',
    'BD804921184IN',
    'https://www.bluedart.com/tracking?awb=BD804921184IN',
    '2026-11-20',
    6500
  );

  const insertOrderItem = db.prepare(`
    INSERT INTO order_items (
      order_id, product_id, variant_id, product_name, sku, pack_label,
      weight_grams, unit_price_paise, mrp_paise, gst_percent, quantity, line_total_paise
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertOrderItem.run(Number(ord1.lastInsertRowid), 1, 2, 'Kashmiri Mamra Giri Almonds', 'SN-DF-ALM-250G', '250 g', 250, 75000, 84500, 5, 1, 75000);
  insertOrderItem.run(Number(ord1.lastInsertRowid), 12, 46, 'Meghalaya Lakadong High-Curcumin Turmeric Powder', 'SN-SP-TUR-250G', '250 g', 250, 32000, 37500, 5, 1, 32000);

  db.prepare(`
    INSERT INTO payments (
      order_id, order_number, gateway_provider, gateway_order_id, gateway_payment_id,
      method, amount_paise, status, verified_on_server
    ) VALUES (?, 'SN-2026-1001', 'razorpay', 'order_rzp_SN20261001', 'pay_rzp_SN20261001', 'ONLINE_UPI', 96300, 'PAID', 1)
  `).run(Number(ord1.lastInsertRowid));

  const ord2 = insertOrder.run(
    'SN-2026-1002',
    null,
    'Vikramaditya Deshmukh',
    'vikram.deshmukh@example.com',
    '+91 98201 77412',
    '14, Prabhat Road, Deccan Gymkhana',
    'Near Kamala Nehru Park',
    'Pune',
    'Maharashtra',
    '411004',
    'Call prior to delivery',
    63000,
    0,
    3000,
    6000,
    69000,
    '',
    'COD',
    'COD_PENDING',
    'Confirmed',
    'cod_SN20261002',
    '',
    '',
    '',
    '',
    '',
    '',
    0
  );
  insertOrderItem.run(Number(ord2.lastInsertRowid), 2, 6, 'Goan W240 Jumbo Whole Cashews', 'SN-DF-CSH-250G', '250 g', 250, 43500, 51500, 5, 1, 43500);
  insertOrderItem.run(Number(ord2.lastInsertRowid), 8, 31, 'Chitradurga Unpolished Foxtail Millet (Navane / Kangni)', 'SN-ML-FOX-500G', '500 g', 500, 19500, 24500, 5, 1, 19500);

  db.prepare(`
    INSERT INTO payments (
      order_id, order_number, gateway_provider, gateway_order_id, gateway_payment_id,
      method, amount_paise, status, verified_on_server
    ) VALUES (?, 'SN-2026-1002', 'cod_manual', 'cod_SN20261002', '', 'COD', 69000, 'COD_PENDING', 1)
  `).run(Number(ord2.lastInsertRowid));

  // 7. Initial Audit Log & Notification Log
  db.prepare(`
    INSERT INTO audit_logs (actor_id, actor_email, actor_role, action, entity_type, entity_id, details_json)
    VALUES (1, 'superadmin@sasynaturals.com', 'SUPER_ADMIN', 'SYSTEM_SEED_INITIALIZED', 'CATALOG', 'ALL', ?)
  `).run(JSON.stringify({ categories: 3, products: catalogData.length, variants: catalogData.length * 4 }));

  db.prepare(`
    INSERT INTO notification_logs (order_number, channel, recipient, event_type, subject, body_preview)
    VALUES ('SN-2026-1001', 'EMAIL', 'ananya.iyer@example.com', 'ORDER_SHIPPED', 'Your Sasya Naturals Order SN-2026-1001 has been shipped', 'Dispatched via Blue Dart Express (AWB: BD804921184IN)')
  `).run();
}

function ensureCompleteSection3CatalogAndCustomerAddresses(db) {
  // 1. Ensure extra notification templates exist in store_settings (Section 8)
  const extraTemplates = [
    ['email_template_order_delivered', 'Namaste {{customer_name}}, your Sasya Naturals order {{order_number}} has been marked Delivered. Thank you for choosing unpolished Indian staples.'],
    ['email_template_order_cancelled', 'Your Sasya Naturals order {{order_number}} has been updated to {{status}}. Any eligible refund is processed back to your original payment method.']
  ];
  const insertTpl = db.prepare('INSERT OR IGNORE INTO store_settings (key, value) VALUES (?, ?)');
  for (const [k, v] of extraTemplates) {
    insertTpl.run(k, v);
  }

  // 2. Seed sample saved addresses for customer Ananya Iyer (Section 4 Customer Account)
  const cust = db.prepare("SELECT id FROM users WHERE email = 'ananya.iyer@example.com'").get();
  if (cust) {
    const addrCount = db.prepare('SELECT COUNT(*) AS cnt FROM customer_addresses WHERE user_id = ?').get(cust.id).cnt;
    if (addrCount === 0) {
      const insAddr = db.prepare(`
        INSERT INTO customer_addresses (user_id, label, recipient_name, phone, line1, line2, city, state, pincode, is_default)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insAddr.run(
        cust.id,
        'Home (Bengaluru)',
        'Ananya Iyer',
        '+91 98450 22334',
        'Flat 402, Banyan Courtyard, Indiranagar 12th Main',
        'HAL 2nd Stage',
        'Bengaluru',
        'Karnataka',
        '560038',
        1
      );
      insAddr.run(
        cust.id,
        'Parents Residence (Mysuru)',
        'Saraswathi & Ramesh Iyer',
        '+91 98450 99881',
        'No. 28, Temple Road, V.V. Mohalla',
        'Near Kalidasa Road',
        'Mysuru',
        'Karnataka',
        '570002',
        0
      );
    }
  }

  // 3. Seed the 6 remaining Section 3.1 standalone products if not already present:
  // Dry Fruits: Raisins, Dates | Millets: Barnyard Millet, Bajra | Spices: Cloves, Coriander Powder
  const extraProducts = [
    {
      skuBase: 'SN-DF-RSN',
      slug: 'nashik-seedless-black-raisins-kali-kishmish',
      name: 'Nashik Seedless Black Raisins (Kali Kishmish)',
      catId: 1,
      shortDesc: 'Shade-dried, naturally sweet Sharad seedless black raisins without mineral oil glaze.',
      desc: 'Harvested from late-season Sharad black grapes in the Niphad valley of Nashik, Maharashtra. Dried in ventilated shade houses so the skins stay soft and iron-rich without sulphur fumigation or petroleum jelly coating.',
      origin: 'Nashik, Maharashtra',
      batch: 'SN-RSN-2611G',
      shelfLife: 9,
      fssai: 'Unsulphured shade-dried fruit. Rinse briefly in warm water before soaking.',
      ingredients: '100% Sun & Shade Dried Seedless Black Grapes (Vitis vinifera)',
      allergen: 'Packed in a facility that handles tree nuts.',
      gst: 5,
      hsn: '080620',
      image: '/images/cat-dry-fruits.jpg',
      caption: 'Shade-dried Nashik seedless black raisins',
      featured: 0,
      newArrival: 1,
      bestseller: 1,
      rating: 4.8,
      reviews: 36,
      base100gMrp: 11000,
      base100gSell: 8500
    },
    {
      skuBase: 'SN-DF-DAT',
      slug: 'king-medjool-ajwa-soft-dates-khajoor',
      name: 'Soft Pitted Medjool & Kutch Crown Dates (Khajoor)',
      catId: 1,
      shortDesc: 'Fleshy, caramel-toned soft dates harvested ripe and packed without glucose syrup.',
      desc: 'Large, thin-skinned soft dates with a rich caramel pulp that melts on the palate. Free from invert sugar glaze and artificial preservatives, making them an immediate natural sweetener for milkshakes, laddoos, and pre-workout snacks.',
      origin: 'Mundra Belt (Kutch) / Packed in Bengaluru',
      batch: 'SN-DAT-2611H',
      shelfLife: 9,
      fssai: '100% natural unglazed dates. Store in a cool, dry place.',
      ingredients: '100% Whole Soft Dates (Phoenix dactylifera)',
      allergen: 'May contain occasional natural fruit pit fragments.',
      gst: 12,
      hsn: '080410',
      image: '/images/cat-dry-fruits.jpg',
      caption: 'Soft caramel-toned whole dates',
      featured: 0,
      newArrival: 1,
      bestseller: 0,
      rating: 4.9,
      reviews: 41,
      base100gMrp: 18500,
      base100gSell: 15500
    },
    {
      skuBase: 'SN-ML-BRN',
      slug: 'uttarakhand-unpolished-barnyard-millet-sanwa',
      name: 'Uttarakhand Unpolished Barnyard Millet (Sanwa / Oodalu)',
      catId: 2,
      shortDesc: 'Fast-cooking Himalayan barnyard millet high in insoluble fiber and plant iron.',
      desc: 'Cultivated on terraced rain-fed slopes in Almora, Uttarakhand, our barnyard millet (Sanwa or Oodalu) cooks into light, separate grains in under 12 minutes. Popular across India for both daily millet rice bowls and traditional fasting (vrat) kheer or khichdi.',
      origin: 'Almora, Uttarakhand',
      batch: 'SN-BRN-2611F',
      shelfLife: 9,
      fssai: 'Unpolished Siridhanya grain. Soak 20 minutes prior to boiling.',
      ingredients: '100% Unpolished Barnyard Millet (Echinochloa frumentacea)',
      allergen: 'Naturally Gluten-Free.',
      gst: 5,
      hsn: '100821',
      image: '/images/cat-millets-grains.jpg',
      caption: 'Unpolished Barnyard Millet (Sanwa / Oodalu)',
      featured: 0,
      newArrival: 1,
      bestseller: 0,
      rating: 4.8,
      reviews: 27,
      base100gMrp: 6200,
      base100gSell: 4800
    },
    {
      skuBase: 'SN-ML-BAJ',
      slug: 'rajasthani-deshi-pearl-millet-bajra-sajje',
      name: 'Barmer Deshi Pearl Millet (Bajra / Sajje Whole Grain)',
      catId: 2,
      shortDesc: 'Heirloom non-hybrid desert pearl millet with sweet, nutty winter warmth.',
      desc: 'Sourced from dryland farms in Barmer, Rajasthan, this heirloom small-seeded Deshi Bajra produces far sweeter rotlas and khichdi than bitter commercial hybrid pearl millet. Gravity-cleaned and ready for fresh home milling or whole-grain porridge.',
      origin: 'Barmer, Rajasthan',
      batch: 'SN-BAJ-2611G',
      shelfLife: 9,
      fssai: 'Whole unpolished pearl millet grain rich in iron and zinc.',
      ingredients: '100% Heirloom Pearl Millet (Pennisetum glaucum)',
      allergen: 'Naturally Gluten-Free.',
      gst: 5,
      hsn: '100821',
      image: '/images/cat-millets-grains.jpg',
      caption: 'Barmer heirloom Deshi Bajra pearl millet',
      featured: 0,
      newArrival: 0,
      bestseller: 1,
      rating: 4.8,
      reviews: 33,
      base100gMrp: 4000,
      base100gSell: 3000
    },
    {
      skuBase: 'SN-SP-CLV',
      slug: 'kanyakumari-hand-picked-whole-cloves-laung',
      name: 'Kanyakumari Hand-Picked Whole Cloves (Laung)',
      catId: 3,
      shortDesc: 'Full-crowned hill cloves from Maramalai estates with high natural eugenol oil.',
      desc: 'Harvested by hand from high-elevation spice gardens in the Maramalai hills of Kanyakumari, Tamil Nadu. Each clove bud retains its round, unopened crown cap and exudes sweet, numbing eugenol oil when pressed between two fingers.',
      origin: 'Maramalai Hills, Kanyakumari, Tamil Nadu',
      batch: 'SN-CLV-2611F',
      shelfLife: 18,
      fssai: 'Unextracted whole clove buds with intact flower crowns.',
      ingredients: '100% Whole Dried Clove Buds (Syzygium aromaticum)',
      allergen: 'None.',
      gst: 5,
      hsn: '090710',
      image: '/images/cat-spices.jpg',
      caption: 'Whole Kanyakumari hill cloves with intact crowns',
      featured: 0,
      newArrival: 1,
      bestseller: 0,
      rating: 4.9,
      reviews: 38,
      base100gMrp: 24000,
      base100gSell: 19500
    },
    {
      skuBase: 'SN-SP-COR',
      slug: 'kumbakonam-cold-milled-coriander-powder-dhaniya',
      name: 'Single-Origin Cold-Milled Coriander Powder (Dhaniya)',
      catId: 3,
      shortDesc: 'Aromatic split-husk green coriander seeds stone-ground at low temperature.',
      desc: 'Prepared from sun-ripened eagle-grade coriander seeds grown in the fertile Cauvery delta. We roast the seeds lightly to release their citrusy linalool aroma and cold-mill them in small batches without husk bran fillers or synthetic green tint.',
      origin: 'Cauvery Delta, Tamil Nadu',
      batch: 'SN-COR-2611G',
      shelfLife: 12,
      fssai: '100% pure ground coriander seed. Zero husk filler.',
      ingredients: '100% Whole Coriander Seeds (Coriandrum sativum)',
      allergen: 'None.',
      gst: 5,
      hsn: '090922',
      image: '/images/cat-spices.jpg',
      caption: 'Freshly cold-milled aromatic coriander powder',
      featured: 0,
      newArrival: 0,
      bestseller: 1,
      rating: 4.8,
      reviews: 45,
      base100gMrp: 8500,
      base100gSell: 6800
    }
  ];

  const checkProd = db.prepare('SELECT id FROM products WHERE sku_base = ?');
  const insertProd = db.prepare(`
    INSERT INTO products (
      sku_base, slug, name, category_id, short_description, description,
      origin_region, harvest_batch, shelf_life_months, fssai_notes,
      ingredients, allergen_info, gst_percent, hsn_code, image_url, image_caption,
      is_featured, is_new_arrival, is_bestseller, is_active, rating_value, review_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const insertVar = db.prepare(`
    INSERT INTO product_variants (
      product_id, sku, pack_label, weight_grams, mrp_paise,
      selling_price_paise, promo_price_paise, stock_qty, low_stock_threshold, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 10, 1)
  `);
  const packMultipliers = [
    { label: '100 g', grams: 100, suffix: '100G', mult: 1.0, stock: 45 },
    { label: '250 g', grams: 250, suffix: '250G', mult: 2.35, stock: 60 },
    { label: '500 g', grams: 500, suffix: '500G', mult: 4.45, stock: 35 },
    { label: '1 kg',  grams: 1000, suffix: '1KG', mult: 8.5, stock: 20 }
  ];

  for (const p of extraProducts) {
    const existing = checkProd.get(p.skuBase);
    if (!existing) {
      const info = insertProd.run(
        p.skuBase, p.slug, p.name, p.catId, p.shortDesc, p.desc,
        p.origin, p.batch, p.shelfLife, p.fssai,
        p.ingredients, p.allergen, p.gst, p.hsn, p.image, p.caption,
        p.featured, p.newArrival, p.bestseller, p.rating, p.reviews
      );
      const productId = Number(info.lastInsertRowid);
      for (const pm of packMultipliers) {
        const mrp = Math.round((p.base100gMrp * pm.mult) / 500) * 500;
        const sell = Math.round((p.base100gSell * pm.mult) / 500) * 500;
        insertVar.run(
          productId,
          `${p.skuBase}-${pm.suffix}`,
          pm.label,
          pm.grams,
          mrp,
          sell,
          sell,
          pm.stock
        );
      }
    }
  }

  // 4. Ensure distinct historical timestamps across Daily (2026-11-21), Weekly (2026-11-19), and Monthly (2026-11-08)
  db.prepare("UPDATE orders SET created_at = '2026-11-19 14:30:00' WHERE order_number = 'SN-2026-1001'").run();
  db.prepare("UPDATE orders SET created_at = '2026-11-21 09:45:00' WHERE order_number = 'SN-2026-1002'").run();

  const ord1000 = db.prepare("SELECT id FROM orders WHERE order_number = 'SN-2026-1000'").get();
  if (!ord1000) {
    const custId = cust ? cust.id : 6;
    const insOrd1000 = db.prepare(`
      INSERT INTO orders (
        order_number, user_id, customer_name, customer_email, customer_phone,
        shipping_line1, shipping_line2, shipping_city, shipping_state, shipping_pincode,
        delivery_instructions, subtotal_paise, discount_paise, gst_paise,
        tax_supply_type, cgst_paise, sgst_paise, igst_paise,
        shipping_paise, total_paise, coupon_code, payment_method, payment_status, fulfilment_status,
        gateway_order_id, gateway_payment_id, gateway_signature,
        courier_name, tracking_number, tracking_url, dispatch_date, manual_shipping_charge_paise,
        stock_deducted, created_at, updated_at
      ) VALUES (
        'SN-2026-1000', ?, 'Ananya Iyer', 'ananya.iyer@example.com', '+91 98450 22334',
        'Flat 402, Banyan Courtyard, Indiranagar 12th Main', 'HAL 2nd Stage', 'Bengaluru', 'Karnataka', '560038',
        'Ring doorbell once', 138000, 10000, 6095,
        'CGST_SGST', 3047, 3048, 0,
        0, 128000, 'PANTRY100', 'ONLINE_CARD', 'PAID', 'Delivered',
        'order_rzp_SN20261000', 'pay_rzp_SN20261000', 'verified_server_hmac_sha256',
        'Delhivery Express', 'DLV77482910IN', 'https://www.delhivery.com/track/package/DLV77482910IN', '2026-11-09', 5500,
        1, '2026-11-08 11:15:00', '2026-11-11 16:20:00'
      )
    `).run(custId);

    const ord1000Id = Number(insOrd1000.lastInsertRowid);
    const insItem = db.prepare(`
      INSERT INTO order_items (
        order_id, product_id, variant_id, product_name, sku, hsn_code, pack_label,
        weight_grams, unit_price_paise, mrp_paise, gst_percent, quantity, line_total_paise
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insItem.run(ord1000Id, 4, 14, 'Kashmiri Snow-White Walnut Halves (Akhrot Giri)', 'SN-DF-WLN-250G', '080290', '250 g', 250, 53000, 61000, 5, 1, 53000);
    insItem.run(ord1000Id, 14, 54, 'Idukki 8mm+ Bold Green Cardamom (Elaichi)', 'SN-SP-CRD-100G', '090831', '100 g', 100, 42000, 48000, 5, 1, 42000);
    insItem.run(ord1000Id, 7, 27, 'Unpolished Haveri Finger Millet (Ragi Whole & Flour)', 'SN-ML-RAG-1KG', '100821', '1 kg', 1000, 30000, 38000, 5, 1, 43000);

    db.prepare(`
      INSERT INTO payments (
        order_id, order_number, gateway_provider, gateway_order_id, gateway_payment_id,
        method, amount_paise, status, verified_on_server, created_at, updated_at
      ) VALUES (?, 'SN-2026-1000', 'razorpay', 'order_rzp_SN20261000', 'pay_rzp_SN20261000', 'ONLINE_CARD', 128000, 'PAID', 1, '2026-11-08 11:16:00', '2026-11-08 11:16:00')
    `).run(ord1000Id);
  }
}

module.exports = {
  getDb,
  hashPassword,
  verifyPassword
};
