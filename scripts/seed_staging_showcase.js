'use strict';

/**
 * Toggleable Staging Sample Catalogue Seeder (scripts/seed_staging_showcase.js)
 *
 * Usage:
 *   node scripts/seed_staging_showcase.js --apply       # Adds 2 sample categories + 4 sample products (with 4 pack variants each) for client review on Staging
 *   node scripts/seed_staging_showcase.js --reset-live  # Cleanly removes the sample categories & products to restore the exact 3-category, 22-product live catalogue
 */
const { getDb } = require('../src/db/database');
const { lintContentText } = require('../src/core/content/contentLinter');

const SAMPLE_CATEGORIES = [
  {
    slug: 'cold-pressed-oils',
    name: 'Cold-Pressed Oils',
    subtitle: 'Traditional Wood-Ghani Kachchi Ghani Extraction',
    description: 'Single-seed groundnut and black sesame oils pressed below 42 degrees Celsius in traditional wooden kolhus without hexane or chemical refining.',
    image_url: '/images/cat-spices.jpg',
    display_order: 4
  },
  {
    slug: 'ghee-forest-honey',
    name: 'A2 Ghee & Wild Honey',
    subtitle: 'Cultured Bilona Cow Ghee & Raw Multifloral Honey',
    description: 'Small-batch curd-churned Hallikar A2 cow ghee and unheated Nilgiri forest honey harvested sustainably by regional tribal cooperatives.',
    image_url: '/images/cat-dry-fruits.jpg',
    display_order: 5
  }
];

const SAMPLE_PRODUCTS = [
  {
    categorySlug: 'cold-pressed-oils',
    sku_base: 'SN-OL-GNT',
    slug: 'anantapur-wood-pressed-groundnut-oil',
    name: 'Anantapur Wood-Pressed Groundnut Oil',
    short_description: 'Unfiltered first-press peanut oil with natural nutty aroma and high oleic stability for Indian cooking.',
    description: 'Pressed in traditional vagai-wood pestles from sun-dried Anantapur Spanish peanuts. Naturally clarified by gravity settling for 72 hours without steam deodorization or synthetic anti-foaming agents.',
    origin_region: 'Anantapur, Andhra Pradesh',
    harvest_batch: 'SN-OL-2026-11A',
    hsn_code: '150810',
    gst_percent: 5,
    image_url: '/images/prod-turmeric.jpg',
    image_caption: 'Anantapur Wood-Pressed Groundnut Oil',
    fssai_notes: 'FSSAI Veg Mark. Store in a cool, dark cupboard away from direct sunlight.',
    ingredients: '100% Cold-Pressed Groundnut (Peanut) Oil',
    allergen_info: 'Contains Peanuts. Pressed in a dedicated groundnut kolhu.',
    shelf_life_months: 9,
    base_250g_mrp_paise: 19000,
    base_250g_sell_paise: 15500,
    is_featured: 1,
    is_bestseller: 1,
    is_new_arrival: 1,
    nutrition: {
      energy_kcal: 884,
      protein_g: 0,
      carbs_g: 0,
      dietary_fiber_g: 0,
      total_sugars_g: 0,
      added_sugars_g: 0,
      total_fat_g: 100,
      saturated_fat_g: 17,
      trans_fat_g: 0,
      sodium_mg: 0,
      bioactive_label: 'Monounsaturated Oleic Acid & Vitamin E',
      bioactive_value: '48 g MUFA & 15.7 mg Alpha-Tocopherol (IFCT 2017)'
    }
  },
  {
    categorySlug: 'cold-pressed-oils',
    sku_base: 'SN-OL-SES',
    slug: 'tiruvannamalai-black-sesame-gingelly-oil',
    name: 'Tiruvannamalai Black Sesame Gingelly Oil',
    short_description: 'Aromatic cold-pressed black til oil pressed with palm jaggery for idli podi, pickles, and tempering.',
    description: 'Extracted from unhulled Tiruvannamalai black sesame seeds seasoned with a touch of organic palm jaggery during wood-pressing. Rich in natural sesamol and sesamin antioxidants.',
    origin_region: 'Tiruvannamalai, Tamil Nadu',
    harvest_batch: 'SN-OL-2026-11B',
    hsn_code: '151550',
    gst_percent: 5,
    image_url: '/images/prod-pepper.jpg',
    image_caption: 'Tiruvannamalai Black Sesame Gingelly Oil',
    fssai_notes: 'FSSAI Veg Mark. Natural sediment at the bottom indicates authentic unfiltered cold extraction.',
    ingredients: '98% Unhulled Black Sesame Seeds, 2% Organic Palm Jaggery (Clarifying Agent)',
    allergen_info: 'Contains Sesame Seeds.',
    shelf_life_months: 9,
    base_250g_mrp_paise: 24000,
    base_250g_sell_paise: 19500,
    is_featured: 0,
    is_bestseller: 0,
    is_new_arrival: 1,
    nutrition: {
      energy_kcal: 884,
      protein_g: 0,
      carbs_g: 0,
      dietary_fiber_g: 0,
      total_sugars_g: 0,
      added_sugars_g: 0,
      total_fat_g: 100,
      saturated_fat_g: 14.2,
      trans_fat_g: 0,
      sodium_mg: 0,
      bioactive_label: 'Natural Sesamin & Sesamolin Lignans',
      bioactive_value: '40 g MUFA & 42 g PUFA (IFCT 2017)'
    }
  },
  {
    categorySlug: 'ghee-forest-honey',
    sku_base: 'SN-GH-A2B',
    slug: 'mysuru-hallikar-a2-cultured-bilona-cow-ghee',
    name: 'Mysuru Hallikar A2 Cultured Bilona Cow Ghee',
    short_description: 'Danedar slow-simmered A2 cow ghee churned from whole-milk clay-pot curd over firewood.',
    description: 'Prepared via the traditional Vedic bilona method from grass-grazed native Hallikar cows in Mysuru. Whole A2 milk is cultured overnight in earthen pots, hand-churned into makkhan, and slow-simmered to a golden granular finish.',
    origin_region: 'Mysuru, Karnataka',
    harvest_batch: 'SN-GH-2026-11A',
    hsn_code: '040590',
    gst_percent: 12,
    image_url: '/images/prod-cashews.jpg',
    image_caption: 'Mysuru Hallikar A2 Cultured Bilona Cow Ghee',
    fssai_notes: 'FSSAI Dairy Mark. Keep spoon dry after every use.',
    ingredients: '100% Cultured A2 Cow Milk Fat (Clarified Butter)',
    allergen_info: 'Contains Milk / Dairy.',
    shelf_life_months: 12,
    base_250g_mrp_paise: 68000,
    base_250g_sell_paise: 57500,
    is_featured: 1,
    is_bestseller: 1,
    is_new_arrival: 1,
    nutrition: {
      energy_kcal: 897,
      protein_g: 0,
      carbs_g: 0,
      dietary_fiber_g: 0,
      total_sugars_g: 0,
      added_sugars_g: 0,
      total_fat_g: 99.7,
      saturated_fat_g: 62.5,
      trans_fat_g: 0,
      sodium_mg: 0,
      bioactive_label: 'Short-Chain Butyric Acid & Vitamin A',
      bioactive_value: '3.6% Butyrate & Conjugated Linoleic Acid (IFCT 2017)'
    }
  },
  {
    categorySlug: 'ghee-forest-honey',
    sku_base: 'SN-GH-HNY',
    slug: 'nilgiri-shola-raw-unheated-wild-forest-honey',
    name: 'Nilgiri Shola Raw Unheated Wild Forest Honey',
    short_description: 'Single-harvest multifloral wild rock-bee honey strained through muslin with natural pollen intact.',
    description: 'Collected from wild Apis dorsata hives in the high-altitude Nilgiri biosphere. Never pasteurized, micro-filtered, or blended with C3/C4 sugar syrups, preserving native bee pollen and live diastase enzymes.',
    origin_region: 'Nilgiris, Tamil Nadu',
    harvest_batch: 'SN-GH-2026-11B',
    hsn_code: '040900',
    gst_percent: 5,
    image_url: '/images/prod-dates.jpg',
    image_caption: 'Nilgiri Shola Raw Unheated Wild Forest Honey',
    fssai_notes: 'FSSAI Veg Mark. Raw honey may crystallize in winter; place jar in warm water to liquefy. Do not feed to infants under 12 months.',
    ingredients: '100% Raw Unpasteurized Multifloral Forest Honey',
    allergen_info: 'Contains natural wildflower bee pollen.',
    shelf_life_months: 18,
    base_250g_mrp_paise: 36000,
    base_250g_sell_paise: 29500,
    is_featured: 1,
    is_bestseller: 0,
    is_new_arrival: 1,
    nutrition: {
      energy_kcal: 319,
      protein_g: 0.3,
      carbs_g: 79.5,
      dietary_fiber_g: 0.2,
      total_sugars_g: 78.2,
      added_sugars_g: 0,
      total_fat_g: 0,
      saturated_fat_g: 0,
      trans_fat_g: 0,
      sodium_mg: 4,
      bioactive_label: 'Live Diastase Enzymes & Wildflower Polyphenols',
      bioactive_value: 'NMR Tested Zero Added C3/C4 Syrup (IFCT 2017)'
    }
  }
];

function applyStagingSampleCatalogue() {
  const db = getDb();
  const { hashPassword } = require('../src/db/database');

  // Ensure all 5 default staff roles and demo customer account have active status and baseline password Sashya@2026 on Staging
  const baselinePassHash = hashPassword('Sashya@2026');
  const baselineEmails = [
    'superadmin@sashyanaturals.com',
    'catalog@sashyanaturals.com',
    'orders@sashyanaturals.com',
    'accounts@sashyanaturals.com',
    'dispatch@sashyanaturals.com',
    'superadmin@sasynaturals.com',
    'catalog@sasynaturals.com',
    'orders@sasynaturals.com',
    'accounts@sasynaturals.com',
    'dispatch@sasynaturals.com',
    'ananya.iyer@example.com'
  ];
  const resetUserStmt = db.prepare('UPDATE users SET password_hash = ?, is_active = 1 WHERE lower(email) = ?');
  for (const em of baselineEmails) {
    resetUserStmt.run(baselinePassHash, em);
  }

  // Lint every sample category and product before inserting
  for (const cat of SAMPLE_CATEGORIES) {
    const check = lintContentText(`${cat.name} ${cat.subtitle} ${cat.description}`, `sample_category:${cat.slug}`);
    if (!check.valid) throw new Error(check.issues.join('\n'));
  }
  for (const prod of SAMPLE_PRODUCTS) {
    const check = lintContentText(
      `${prod.name} ${prod.short_description} ${prod.description} ${prod.fssai_notes} ${prod.ingredients} ${prod.allergen_info} ${JSON.stringify(prod.nutrition)}`,
      `sample_product:${prod.slug}`
    );
    if (!check.valid) throw new Error(check.issues.join('\n'));
  }

  const upsertCat = db.prepare(`
    INSERT INTO categories (slug, name, subtitle, description, image_url, display_order, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      subtitle = excluded.subtitle,
      description = excluded.description,
      image_url = excluded.image_url,
      display_order = excluded.display_order,
      is_active = 1
  `);

  for (const cat of SAMPLE_CATEGORIES) {
    upsertCat.run(cat.slug, cat.name, cat.subtitle, cat.description, cat.image_url, cat.display_order);
  }

  const upsertProd = db.prepare(`
    INSERT INTO products (
      category_id, sku_base, slug, name, short_description, description,
      origin_region, harvest_batch, hsn_code, gst_percent, image_url, image_caption,
      gallery_json, fssai_notes, ingredients, allergen_info, nutrition_json,
      shelf_life_months, rating_value, review_count, is_featured, is_bestseller, is_new_arrival, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, 4.9, 18, ?, ?, ?, 1)
    ON CONFLICT(slug) DO UPDATE SET
      category_id = excluded.category_id,
      name = excluded.name,
      short_description = excluded.short_description,
      description = excluded.description,
      nutrition_json = excluded.nutrition_json,
      is_active = 1
  `);

  const upsertVar = db.prepare(`
    INSERT INTO product_variants (
      product_id, sku, pack_label, weight_grams, mrp_paise, selling_price_paise, promo_price_paise, stock_qty, low_stock_threshold, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 28, 5, 1)
    ON CONFLICT(sku) DO UPDATE SET
      mrp_paise = excluded.mrp_paise,
      selling_price_paise = excluded.selling_price_paise,
      is_active = 1
  `);

  const packMultipliers = [
    { label: '100 g', grams: 100, mult: 0.45 },
    { label: '250 g', grams: 250, mult: 1.0 },
    { label: '500 g', grams: 500, mult: 1.9 },
    { label: '1 kg', grams: 1000, mult: 3.6 }
  ];

  for (const prod of SAMPLE_PRODUCTS) {
    const catRow = db.prepare('SELECT id FROM categories WHERE slug = ?').get(prod.categorySlug);
    if (!catRow) continue;
    upsertProd.run(
      catRow.id,
      prod.sku_base,
      prod.slug,
      prod.name,
      prod.short_description,
      prod.description,
      prod.origin_region,
      prod.harvest_batch,
      prod.hsn_code,
      prod.gst_percent,
      prod.image_url,
      prod.image_caption,
      prod.fssai_notes,
      prod.ingredients,
      prod.allergen_info,
      JSON.stringify(prod.nutrition),
      prod.shelf_life_months,
      prod.is_featured,
      prod.is_bestseller,
      prod.is_new_arrival
    );
    const prodRow = db.prepare('SELECT id FROM products WHERE slug = ?').get(prod.slug);
    for (const pm of packMultipliers) {
      const sku = `${prod.sku_base}-${pm.grams}G`;
      const mrp = Math.round((prod.base_250g_mrp_paise * pm.mult) / 500) * 500;
      const sell = Math.round((prod.base_250g_sell_paise * pm.mult) / 500) * 500;
      upsertVar.run(prodRow.id, sku, pm.label, pm.grams, mrp, sell);
    }
  }

  const totalCats = db.prepare('SELECT COUNT(*) AS cnt FROM categories WHERE is_active = 1').get().cnt;
  const totalProds = db.prepare('SELECT COUNT(*) AS cnt FROM products WHERE is_active = 1').get().cnt;
  console.log(`✓ [Staging Sample Catalogue Applied] Active Categories: ${totalCats}, Active Products: ${totalProds}`);
}

function resetToLiveCatalogue() {
  const db = getDb();
  for (const prod of SAMPLE_PRODUCTS) {
    const prodRow = db.prepare('SELECT id FROM products WHERE slug = ?').get(prod.slug);
    if (prodRow) {
      db.prepare('DELETE FROM product_variants WHERE product_id = ?').run(prodRow.id);
      db.prepare('DELETE FROM products WHERE id = ?').run(prodRow.id);
    }
  }
  for (const cat of SAMPLE_CATEGORIES) {
    db.prepare('DELETE FROM categories WHERE slug = ?').run(cat.slug);
  }
  const totalCats = db.prepare('SELECT COUNT(*) AS cnt FROM categories WHERE is_active = 1').get().cnt;
  const totalProds = db.prepare('SELECT COUNT(*) AS cnt FROM products WHERE is_active = 1').get().cnt;
  console.log(`✓ [Live Catalogue Restored] Active Categories: ${totalCats}, Active Products: ${totalProds}`);
}

if (require.main === module) {
  const arg = process.argv[2] || '--apply';
  if (arg === '--reset-live') {
    resetToLiveCatalogue();
  } else {
    applyStagingSampleCatalogue();
  }
}

module.exports = {
  SAMPLE_CATEGORIES,
  SAMPLE_PRODUCTS,
  applyStagingSampleCatalogue,
  resetToLiveCatalogue
};
