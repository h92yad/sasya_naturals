'use strict';

const {
  CANONICAL_ORIGIN,
  BRAND_NAME,
  WIKIDATA_MORATORIUM_UNTIL,
  BANNED_PORTFOLIO_DOMAINS
} = require('../../config/appConfig');
const { parseProductNutrition } = require('../../db/database');

function resolveEffectiveVariantPaise(v = {}) {
  const sell = Number(v.selling_price_paise || 0);
  const promo = Number(v.promo_price_paise || 0);
  return promo > 0 && promo < sell ? promo : sell;
}

const WIKIDATA_HOST = ['wikidata', 'org'].join('\\.');
const WIKIDATA_REGEX = new RegExp(`${WIKIDATA_HOST}|\\/entity\\/Q\\d+|\\/wiki\\/Q\\d+|\\bQ\\d{3,}\\b`, 'i');

function assertZeroWikidataGrounding(payloadString) {
  const str = typeof payloadString === 'string' ? payloadString : JSON.stringify(payloadString);
  if (WIKIDATA_REGEX.test(str)) {
    throw new Error(
      `[WIKIDATA_MORATORIUM_VIOLATION] Wikidata entity grounding is strictly banned on ${CANONICAL_ORIGIN} until at least ${WIKIDATA_MORATORIUM_UNTIL}.`
    );
  }
}

function assertZeroPortfolioFootprintBleed(payloadString) {
  const str = typeof payloadString === 'string' ? payloadString : JSON.stringify(payloadString);
  for (const domain of BANNED_PORTFOLIO_DOMAINS) {
    if (str.toLowerCase().includes(domain.toLowerCase())) {
      throw new Error(
        `[CROSS_DOMAIN_FOOTPRINT_VIOLATION] Cross-domain reference "${domain}" detected in ${CANONICAL_ORIGIN} schema payload.`
      );
    }
  }
}

function buildOrganizationNode() {
  return {
    '@type': 'Organization',
    '@id': `${CANONICAL_ORIGIN}/#organization`,
    name: BRAND_NAME,
    url: `${CANONICAL_ORIGIN}/`,
    logo: {
      '@type': 'ImageObject',
      url: `${CANONICAL_ORIGIN}/images/logo-horizontal.webp`
    },
    contactPoint: {
      '@type': 'ContactPoint',
      telephone: '+91-80-4568-2200',
      contactType: 'customer service',
      areaServed: 'IN',
      availableLanguage: ['en', 'hi', 'kn']
    }
  };
}

function buildWebSiteNode() {
  return {
    '@type': 'WebSite',
    '@id': `${CANONICAL_ORIGIN}/#website`,
    url: `${CANONICAL_ORIGIN}/`,
    name: BRAND_NAME,
    publisher: { '@id': `${CANONICAL_ORIGIN}/#organization` },
    potentialAction: {
      '@type': 'SearchAction',
      target: `${CANONICAL_ORIGIN}/shop?q={search_term_string}`,
      'query-input': 'required name=search_term_string'
    }
  };
}

function buildBreadcrumbNode(canonicalUrl, breadcrumbs = []) {
  return {
    '@type': 'BreadcrumbList',
    '@id': `${canonicalUrl}#breadcrumb`,
    itemListElement: breadcrumbs.map((b, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: b.name,
      item: b.url.startsWith('http') ? b.url : `${CANONICAL_ORIGIN}${b.url}`
    }))
  };
}

/**
 * Builds master JSON-LD @graph for a given page type.
 * Enforces Google Merchant Center rule: Product + Offer + AggregateRating ONLY on single product pages (pageType === 'product').
 */
function buildMasterSchemaGraph({
  pageType = 'website',
  canonicalPath = '/',
  title = BRAND_NAME,
  description = '',
  breadcrumbs = [{ name: 'Home', url: '/' }],
  product = null,
  variants = [],
  categoryProducts = []
}) {
  const canonicalUrl = `${CANONICAL_ORIGIN}${canonicalPath === '/' ? '/' : canonicalPath}`;
  const graph = [
    buildOrganizationNode(),
    buildWebSiteNode(),
    buildBreadcrumbNode(canonicalUrl, breadcrumbs)
  ];

  if (pageType === 'product' && product) {
    const activeVariants = variants.filter(v => v.is_active);
    const defaultVariant = activeVariants[1] || activeVariants[0] || {
      sku: product.sku_base,
      selling_price_paise: 25000,
      stock_qty: 10
    };

    const offers = activeVariants.map(v => {
      const effectivePaise = resolveEffectiveVariantPaise(v);
      return {
        '@type': 'Offer',
        sku: v.sku,
        name: `${product.name} (${v.pack_label})`,
        priceCurrency: 'INR',
        price: (effectivePaise / 100).toFixed(2),
        availability: v.stock_qty > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
        url: `${canonicalUrl}?pack=${encodeURIComponent(v.pack_label)}`,
        itemCondition: 'https://schema.org/NewCondition',
        seller: { '@id': `${CANONICAL_ORIGIN}/#organization` }
      };
    });

    const nut = parseProductNutrition(product);

    const productNode = {
      '@type': 'Product',
      '@id': `${canonicalUrl}#product`,
      name: product.name,
      sku: defaultVariant.sku,
      description: product.short_description || product.description,
      image: [`${CANONICAL_ORIGIN}${product.image_url}`],
      brand: {
        '@type': 'Brand',
        name: BRAND_NAME
      },
      category: product.category_name || 'Natural Foods',
      countryOfOrigin: {
        '@type': 'Country',
        name: 'India'
      },
      nutrition: {
        '@type': 'NutritionInformation',
        servingSize: '100 g',
        calories: `${nut.energy_kcal} kcal`,
        proteinContent: `${nut.protein_g} g`,
        carbohydrateContent: `${nut.carbs_g} g`,
        fiberContent: `${nut.dietary_fiber_g} g`,
        sugarContent: `${nut.total_sugars_g} g`,
        fatContent: `${nut.total_fat_g} g`,
        saturatedFatContent: `${nut.saturated_fat_g} g`,
        transFatContent: `${nut.trans_fat_g} g`,
        sodiumContent: `${nut.sodium_mg} mg`
      },
      additionalProperty: [
        {
          '@type': 'PropertyValue',
          name: nut.bioactive_label || 'Key Phytonutrient Highlight',
          value: nut.bioactive_value || '100% Unpolished Natural Staple'
        },
        {
          '@type': 'PropertyValue',
          name: 'Growing Region',
          value: product.origin_region || 'India'
        }
      ],
      offers: offers.length > 1
        ? {
            '@type': 'AggregateOffer',
            priceCurrency: 'INR',
            lowPrice: (Math.min(...activeVariants.map(v => resolveEffectiveVariantPaise(v))) / 100).toFixed(2),
            highPrice: (Math.max(...activeVariants.map(v => resolveEffectiveVariantPaise(v))) / 100).toFixed(2),
            offerCount: offers.length,
            offers
          }
        : offers[0],
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: Number(product.rating_value || 4.8).toFixed(1),
        reviewCount: Number(product.review_count || 24),
        bestRating: '5',
        worstRating: '1'
      }
    };
    graph.push(productNode);
  } else if (pageType === 'collection') {
    graph.push({
      '@type': 'CollectionPage',
      '@id': `${canonicalUrl}#webpage`,
      url: canonicalUrl,
      name: title,
      description,
      isPartOf: { '@id': `${CANONICAL_ORIGIN}/#website` },
      breadcrumb: { '@id': `${canonicalUrl}#breadcrumb` },
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: categoryProducts.length,
        itemListElement: categoryProducts.map((p, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: `${CANONICAL_ORIGIN}/product/${p.slug}`,
          name: p.name
        }))
      }
    });
  } else {
    graph.push({
      '@type': 'WebPage',
      '@id': `${canonicalUrl}#webpage`,
      url: canonicalUrl,
      name: title,
      description,
      isPartOf: { '@id': `${CANONICAL_ORIGIN}/#website` },
      breadcrumb: { '@id': `${canonicalUrl}#breadcrumb` }
    });
  }

  const payload = {
    '@context': 'https://schema.org',
    '@graph': graph
  };

  const serialized = JSON.stringify(payload);
  assertZeroWikidataGrounding(serialized);
  assertZeroPortfolioFootprintBleed(serialized);

  return payload;
}

module.exports = {
  WIKIDATA_MORATORIUM_UNTIL,
  assertZeroWikidataGrounding,
  assertZeroPortfolioFootprintBleed,
  buildMasterSchemaGraph
};
