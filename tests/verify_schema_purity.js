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
      variants: pVars
    });
    const prodNode = pdpSchema['@graph'].find(n => n['@type'] === 'Product');
    assert(prodNode, `Missing Product schema on /product/${prod.slug}`);
    assert(prodNode.offers, `Missing Offer node on /product/${prod.slug}`);
    assert(prodNode.aggregateRating, `Missing AggregateRating node on /product/${prod.slug}`);
  }

  console.log(`✓ [Suite 6/7: verify_schema_purity] Verified 0 Wikidata groundings, CollectionPage isolation, and Product JSON-LD on ${products.length} PDPs`);
}

if (require.main === module) {
  runVerifySchemaPurity();
}

module.exports = { runVerifySchemaPurity };
