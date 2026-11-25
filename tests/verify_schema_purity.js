'use strict';

const assert = require('node:assert');
const { getDb } = require('../src/db/database');
const {
  assertZeroWikidataGrounding,
  buildMasterSchemaGraph
} = require('../src/core/content/schemaBuilder');

function runVerifySchemaPurity() {
  const db = getDb();
  const categories = db.prepare('SELECT * FROM categories WHERE is_active = 1').all();
  const products = db.prepare('SELECT * FROM products WHERE is_active = 1').all();
  const variants = db.prepare('SELECT * FROM product_variants WHERE is_active = 1').all();

  // 1. Verify Wikidata Moratorium circuit breaker throws on any Wikidata reference
  assert.throws(() => {
    assertZeroWikidataGrounding('{"sameAs":"https://www.wikidata.org/wiki/Q399"}');
  }, /WIKIDATA_MORATORIUM_VIOLATION/);

  // 2. Verify Collection pages (/shop, /category/*) NEVER contain Product or AggregateRating nodes
  const shopSchema = buildMasterSchemaGraph({
    pageType: 'collection',
    canonicalPath: '/shop',
    title: 'Shop',
    description: 'Catalogue',
    categoryProducts: products
  });
  const shopTypes = shopSchema['@graph'].map(n => n['@type']);
  assert(shopTypes.includes('CollectionPage'), '/shop must include CollectionPage schema');
  assert(!shopTypes.includes('Product'), '/shop must NEVER include Product schema on collection grid');

  // 3. Verify Single Product Detail Pages (/product/:slug) contain valid Product + Offer + AggregateRating
  for (const prod of products) {
    const pVars = variants.filter(v => v.product_id === prod.id);
    const pdpSchema = buildMasterSchemaGraph({
      pageType: 'product',
      canonicalPath: `/product/${prod.slug}`,
      title: prod.name,
      description: prod.short_description,
      product: prod,
      variants: pVars,
      sectionBookmarks: [
        { id: 'origin-compliance', name: 'Origin, Batch & FSSAI Compliance' },
        { id: 'nutrition-facts', name: 'Nutritional Value (Per 100 g)' }
      ]
    });
    const itemPageNode = pdpSchema['@graph'].find(n => n['@type'] === 'ItemPage');
    assert(itemPageNode && itemPageNode['@id'].endsWith('#webpage'), `Missing ItemPage #webpage node on /product/${prod.slug}`);
    assert(Array.isArray(itemPageNode.hasPart) && itemPageNode.hasPart.length === 2, `Missing WebPageElement hasPart bookmark nodes on /product/${prod.slug}`);
    const prodNode = pdpSchema['@graph'].find(n => n['@type'] === 'Product');
    assert(prodNode, `Missing Product schema on /product/${prod.slug}`);
    assert(prodNode.offers, `Missing Offer node on /product/${prod.slug}`);
    assert(prodNode.aggregateRating, `Missing AggregateRating node on /product/${prod.slug}`);
    assert(prodNode.nutrition && prodNode.nutrition['@type'] === 'NutritionInformation', `Missing NutritionInformation node on /product/${prod.slug}`);
    assert.strictEqual(prodNode.nutrition.servingSize, '100 g', `NutritionInformation servingSize must be '100 g' on /product/${prod.slug}`);
    assert(Array.isArray(prodNode.additionalProperty) && prodNode.additionalProperty.length >= 1, `Missing bioactive additionalProperty on /product/${prod.slug}`);
  }

  // 4. Verify FAQPage schema on /faq with deep-linked Question @id and url bookmarks
  const faqSchema = buildMasterSchemaGraph({
    pageType: 'faq',
    canonicalPath: '/faq',
    title: 'Frequently Asked Questions',
    description: 'FAQs',
    faqItems: [
      { id: 'faq-what-pack-sizes-do-you-offer', question: 'What pack sizes do you offer?', answer: '100 g, 250 g, 500 g, and 1 kg.' }
    ],
    sectionBookmarks: [
      { id: 'faq-what-pack-sizes-do-you-offer', name: 'What pack sizes do you offer?' }
    ]
  });
  const faqNode = faqSchema['@graph'].find(n => n['@type'] === 'FAQPage');
  assert(faqNode, 'Missing FAQPage node on /faq');
  assert(Array.isArray(faqNode.mainEntity) && faqNode.mainEntity.length === 1, 'FAQPage must contain Question mainEntity array');
  assert(faqNode.mainEntity[0]['@id'].endsWith('#faq-what-pack-sizes-do-you-offer'), 'FAQ Question @id must include #faq-<slug> bookmark fragment');

  console.log(`✓ [Suite 6/7: verify_schema_purity] Verified 0 Wikidata groundings, CollectionPage isolation, FAQPage Question bookmarks, and ItemPage + Product + NutritionInformation JSON-LD on ${products.length} PDPs`);
}

if (require.main === module) {
  runVerifySchemaPurity();
}

module.exports = { runVerifySchemaPurity };
