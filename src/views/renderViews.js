'use strict';

const {
  APP_VERSION,
  CANONICAL_ORIGIN,
  BRAND_NAME,
  BRAND_TAGLINE,
  ORDER_FULFILMENT_STATUSES
} = require('../config/appConfig');
const { buildMasterSchemaGraph } = require('../core/content/schemaBuilder');
const { getShippingPolicyFromDb } = require('../core/checkout/checkoutEngine');

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatInr(paise) {
  return '₹' + (Number(paise || 0) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  });
}

function getDynamicShippingCopy() {
  try {
    const pol = getShippingPolicyFromDb();
    const threshInr = Math.round(pol.freeThresholdPaise / 100);
    if (pol.freeMode === 'DISABLED') {
      return {
        topbarHtml: `Pan-India 4-Zone + 500g Weight-Slab Delivery (from ₹${Math.round(pol.zoneA.base500gPaise / 100)}) | Use code <strong>SASYA10</strong> for 10% off`,
        pdpShortText: `4-Zone Weight-Slab Delivery (from ₹${Math.round(pol.zoneA.base500gPaise / 100)} / 500g)`
      };
    }
    if (pol.freeMode === 'UNCONDITIONAL_THRESHOLD') {
      return {
        topbarHtml: `Complimentary India-Wide Delivery on all orders above ₹${threshInr} | Use code <strong>SASYA10</strong> for 10% off`,
        pdpShortText: `Free delivery above ₹${threshInr}`
      };
    }
    return {
      topbarHtml: `Complimentary India-Wide Delivery on orders above ₹${threshInr} (up to ${(pol.freeMaxWeightGrams / 1000).toFixed(1)} kg) | Use code <strong>SASYA10</strong> for 10% off`,
      pdpShortText: `Free delivery above ₹${threshInr} (up to ${(pol.freeMaxWeightGrams / 1000).toFixed(1)} kg)`
    };
  } catch {
    return {
      topbarHtml: 'Complimentary India-Wide Delivery on orders above ₹799 | Use code <strong>SASYA10</strong> for 10% off',
      pdpShortText: 'Free delivery above ₹799'
    };
  }
}

function renderProductCard(p, variants = [], basePath = '') {
  const prodVariants = variants.filter(v => Number(v.product_id) === Number(p.id) && v.is_active);
  const defVar = prodVariants.find(v => v.pack_label === '250 g') || prodVariants[0] || {
    id: 0,
    sku: p.sku_base,
    pack_label: '250 g',
    mrp_paise: 30000,
    selling_price_paise: 25000,
    stock_qty: 20
  };
  const totalStock = prodVariants.reduce((sum, v) => sum + Number(v.stock_qty || 0), 0);

  return `
    <article
      class="sn-product-card"
      data-product-container="${p.id}"
      data-product-featured="${p.is_featured ? '1' : '0'}"
      data-product-bestseller="${p.is_bestseller ? '1' : '0'}"
      data-product-new="${p.is_new_arrival ? '1' : '0'}"
      data-product-instock="${totalStock > 0 ? '1' : '0'}"
      data-product-min-inr="${Math.round((prodVariants[0] ? prodVariants[0].selling_price_paise : defVar.selling_price_paise) / 100)}"
      id="prod-card-${escapeHtml(p.slug)}"
    >
      <a href="${basePath}/product/${escapeHtml(p.slug)}" class="sn-product-media">
        <img src="${basePath}${escapeHtml(p.image_url)}" alt="${escapeHtml(p.name)}" data-product-img-id="${p.id}" loading="lazy" />
        <div class="sn-product-badges">
          ${p.is_bestseller ? `<span class="sn-badge sn-badge-bestseller">Bestseller</span>` : ''}
          ${p.is_new_arrival ? `<span class="sn-badge sn-badge-new">New Harvest</span>` : ''}
          <span class="sn-badge sn-badge-origin">${escapeHtml(p.origin_region)}</span>
        </div>
      </a>
      <div class="sn-product-content">
        <div class="sn-product-meta">
          <span data-sku-display>${escapeHtml(defVar.sku)}</span>
          <span>★ ${Number(p.rating_value || 4.8).toFixed(1)} (${Number(p.review_count || 24)})</span>
        </div>
        <h3 class="sn-product-title">
          <a href="${basePath}/product/${escapeHtml(p.slug)}">${escapeHtml(p.name)}</a>
        </h3>
        <p class="sn-product-desc">${escapeHtml(p.short_description)}</p>
        <div class="sn-pack-selector" role="group" aria-label="Select Pack Size">
          ${prodVariants.map(v => `
            <button
              type="button"
              class="sn-pack-pill ${v.id === defVar.id ? 'sn-active' : ''}"
              data-variant-pill
              data-variant-id="${v.id}"
              data-pack-label="${escapeHtml(v.pack_label)}"
              data-price-paise="${v.selling_price_paise}"
              data-mrp-paise="${v.mrp_paise}"
              data-sku="${escapeHtml(v.sku)}"
              data-stock="${v.stock_qty}"
            >${escapeHtml(v.pack_label)}</button>
          `).join('')}
        </div>
        <div class="sn-price-row">
          <div class="sn-price-block">
            <span class="sn-price-current" data-price-display>${formatInr(defVar.selling_price_paise)}</span>
            <span class="sn-price-mrp" data-mrp-display>MRP ${formatInr(defVar.mrp_paise)}</span>
            <span class="sn-price-tax">Incl. ${p.gst_percent}% GST</span>
          </div>
          <button
            type="button"
            class="sn-btn sn-btn-forest sn-btn-sm"
            id="add-btn-${escapeHtml(p.slug)}"
            data-add-to-cart
            data-variant-id="${defVar.id}"
            data-product-name="${escapeHtml(p.name)}"
            data-pack-label="${escapeHtml(defVar.pack_label)}"
          >Add to Basket</button>
        </div>
      </div>
    </article>
  `;
}

function renderShell({
  title,
  description,
  canonicalPath = '/',
  activeNav = '',
  schemaGraph,
  bodyHtml,
  isNoIndex = false,
  basePath = '',
  staticShowcaseScript = ''
}) {
  const canonicalUrl = `${CANONICAL_ORIGIN}${canonicalPath === '/' ? '/' : canonicalPath}`;
  const mdTwinPath = canonicalPath === '/' ? '/index.md' : `${canonicalPath}.md`;
  const shipCopy = getDynamicShippingCopy();

  return `<!DOCTYPE html>
<html lang="en-IN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta name="robots" content="${isNoIndex ? 'noindex, nofollow' : 'index, follow'}" />
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
  <link rel="alternate" type="text/markdown" href="${escapeHtml(CANONICAL_ORIGIN + mdTwinPath)}" title="Markdown Version" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
  <meta property="og:site_name" content="${escapeHtml(BRAND_NAME)}" />
  <meta property="og:image" content="${escapeHtml(CANONICAL_ORIGIN)}/images/hero-pantry.jpg" />
  <link rel="stylesheet" href="${basePath}/assets/sasya-core.css?v=${APP_VERSION}" />
  <script type="application/ld+json">${JSON.stringify(schemaGraph)}</script>
</head>
<body>
  <div class="sn-topbar">
    <div class="sn-container sn-topbar-inner">
      <span id="sn-dynamic-topbar-ship">${shipCopy.topbarHtml}</span>
      <div class="sn-topbar-badges">
        <span>Unpolished Native Grains</span>
        <span>Single-Origin Spices</span>
        <span>Razorpay UPI / Cards &amp; COD</span>
      </div>
    </div>
  </div>

  <header class="sn-header">
    <div class="sn-container sn-header-inner">
      <a href="${basePath}/" class="sn-brand" id="nav-brand-logo">
        <span class="sn-brand-title">Sasya Naturals</span>
        <span class="sn-brand-sub">Pure Indian Pantry</span>
      </a>
      <nav class="sn-nav" aria-label="Main Navigation">
        <a href="${basePath}/" class="${activeNav === 'home' ? 'sn-active' : ''}" id="nav-home">Home</a>
        <a href="${basePath}/shop" class="${activeNav === 'shop' ? 'sn-active' : ''}" id="nav-shop">All Catalogue</a>
        <a href="${basePath}/category/dry-fruits" class="${activeNav === 'dry-fruits' ? 'sn-active' : ''}" id="nav-dry-fruits">Dry Fruits</a>
        <a href="${basePath}/category/millets-grains" class="${activeNav === 'millets-grains' ? 'sn-active' : ''}" id="nav-millets">Millets &amp; Grains</a>
        <a href="${basePath}/category/spices" class="${activeNav === 'spices' ? 'sn-active' : ''}" id="nav-spices">Spices</a>
        <a href="${basePath}/track-order" class="${activeNav === 'track' ? 'sn-active' : ''}" id="nav-track">Track Order</a>
      </nav>
      <div class="sn-header-actions">
        <a href="${basePath}/account" class="sn-btn ${activeNav === 'account' ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm" id="header-account-btn">My Account</a>
        <button type="button" class="sn-btn sn-btn-forest sn-btn-sm sn-cart-trigger" data-open-cart id="header-cart-btn">
          <span>Basket</span>
          <span class="sn-cart-count" data-cart-count>0</span>
        </button>
      </div>
    </div>
  </header>

  <main id="app-mount" data-ssr-rendered="true" data-app-version="${APP_VERSION}">
    ${bodyHtml}
  </main>

  <div class="sn-drawer-backdrop" id="sn-cart-backdrop" role="dialog" aria-label="Shopping Basket">
    <div class="sn-drawer">
      <div class="sn-drawer-head">
        <strong style="font-family:var(--sn-font-serif);font-size:1.2rem;">Your Pantry Basket</strong>
        <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-close-cart id="close-cart-drawer-btn">Close</button>
      </div>
      <div class="sn-drawer-body" id="sn-cart-drawer-body"></div>
      <div class="sn-drawer-foot" id="sn-cart-drawer-foot"></div>
    </div>
  </div>

  <div class="sn-toast" id="sn-toast" role="status" aria-live="polite"></div>

  <footer class="sn-footer">
    <div class="sn-container">
      <div class="sn-footer-grid">
        <div>
          <h4>Sasya Naturals</h4>
          <p style="color:#B9C2BA;margin:0 0 14px;">
            Direct-to-customer Indian pantry delivering unbleached dry fruits, rain-fed unpolished millets, and cold-milled heirloom spices in 100 g, 250 g, 500 g, and 1 kg packs.
          </p>
          <div style="font-family:var(--sn-font-mono);font-size:0.76rem;color:#9BA69D;">
            Domain: sasynaturals.com | Support: care@sasynaturals.com
          </div>
        </div>
        <div>
          <h4>Pantry Categories</h4>
          <ul>
            <li><a href="${basePath}/category/dry-fruits">Dry Fruits &amp; Nuts</a></li>
            <li><a href="${basePath}/category/millets-grains">Unpolished Millets &amp; Grains</a></li>
            <li><a href="${basePath}/category/spices">Single-Origin Spices</a></li>
            <li><a href="${basePath}/shop">Full Product Catalogue</a></li>
          </ul>
        </div>
        <div>
          <h4>Customer Care</h4>
          <ul>
            <li><a href="${basePath}/track-order">Order &amp; Courier Tracking</a></li>
            <li><a href="${basePath}/checkout">Checkout (UPI / Cards / COD)</a></li>
            <li><a href="${basePath}/account">Customer Account</a></li>
            <li><a href="${basePath}/faq">Frequently Asked Questions</a></li>
            <li><a href="${basePath}/contact">Contact Us</a></li>
          </ul>
        </div>
        <div>
          <h4>Policies &amp; Governance</h4>
          <ul>
            <li><a href="${basePath}/about">About Sasya Naturals</a></li>
            <li><a href="${basePath}/shipping-returns">Shipping, Cancellation &amp; Refunds</a></li>
            <li><a href="${basePath}/privacy">Privacy Policy</a></li>
            <li><a href="${basePath}/terms">Terms of Service</a></li>
            <li><a href="${basePath}/admin" id="footer-admin-link">Staff RBAC Admin Portal</a></li>
          </ul>
        </div>
      </div>
      <div class="sn-footer-bottom">
        <span>© 2026 Sasya Naturals (sasynaturals.com). All rights reserved.</span>
        <span>Engine: Node.js 22 SSR + Rust WASM Commerce Core (v${APP_VERSION})</span>
      </div>
    </div>
  </footer>
  ${staticShowcaseScript}
  <script src="${basePath}/assets/sasya-client.js?v=${APP_VERSION}" defer></script>
</body>
</html>`;
}

function renderHomePage({ categories, products, variants, basePath = '', staticShowcaseScript = '', isNoIndex = false }) {
  const featured = products.filter(p => p.is_featured).slice(0, 6);
  const bestsellers = products.filter(p => p.is_bestseller).slice(0, 6);
  const title = `${BRAND_NAME} | ${BRAND_TAGLINE}`;
  const description = 'Shop farm-direct Kashmiri almonds, Goan W240 cashews, unpolished native millets, and cold-milled Lakadong turmeric across India in 100 g to 1 kg packs.';

  const schemaGraph = buildMasterSchemaGraph({
    pageType: 'website',
    canonicalPath: '/',
    title,
    description,
    breadcrumbs: [{ name: 'Home', url: '/' }]
  });

  const bodyHtml = `
    <section class="sn-hero">
      <div class="sn-container sn-hero-grid">
        <div>
          <span class="sn-eyebrow">Direct-To-Customer Indian Pantry • Batch Traceable</span>
          <h1>Single-Origin Dry Fruits, Unpolished Native Millets &amp; Heirloom Spices</h1>
          <p class="sn-hero-lead">
            Every Sasya Naturals harvest is sourced directly from regional grower cooperatives in Kashmir, Goa, Karnataka, Kerala, and Meghalaya. Packed fresh in 100 g, 250 g, 500 g, and 1 kg pouches with transparent batch labels.
          </p>
          <div class="sn-hero-ctas">
            <a href="${basePath}/shop" class="sn-btn sn-btn-primary" id="hero-shop-all-btn">Explore Full Pantry</a>
            <a href="${basePath}/track-order?order=SN-2026-1001" class="sn-btn sn-btn-outline" id="hero-track-demo-btn">Live Order Tracker Demo</a>
          </div>
          <div class="sn-trust-strip">
            <div class="sn-trust-item">
              <strong>4 Pack Sizes</strong>
              <span>100 g, 250 g, 500 g &amp; 1 kg options</span>
            </div>
            <div class="sn-trust-item">
              <strong>Zero Chemical Polish</strong>
              <span>Intact bran millets &amp; unbleached nuts</span>
            </div>
            <div class="sn-trust-item">
              <strong>Verified Payments</strong>
              <span>Razorpay UPI, Cards, NetBanking &amp; COD</span>
            </div>
          </div>
        </div>
        <div class="sn-hero-media">
          <img src="${basePath}/images/hero-pantry.jpg" alt="Sasya Naturals dry fruits, unpolished millets, and heirloom spices" />
          <div class="sn-hero-caption">
            <span>Harvest Batch: Nov 2026</span>
            <span>India-Wide Dispatch from Bengaluru</span>
          </div>
        </div>
      </div>
    </section>

    <section class="sn-section">
      <div class="sn-container">
        <div class="sn-section-head">
          <div>
            <span class="sn-eyebrow">Three Core Pantry Pillars</span>
            <h2>Shop by Category</h2>
          </div>
          <a href="${basePath}/shop" class="sn-btn sn-btn-outline sn-btn-sm">View All ${products.length} Products</a>
        </div>
        <div class="sn-category-grid" id="home-categories-grid">
          ${categories.map(cat => `
            <a href="${basePath}/category/${escapeHtml(cat.slug)}" class="sn-category-card" id="cat-tile-${escapeHtml(cat.slug)}">
              <div class="sn-category-img-wrap">
                <img src="${basePath}${escapeHtml(cat.image_url)}" alt="${escapeHtml(cat.name)}" data-category-img-id="${cat.id}" loading="lazy" />
              </div>
              <div class="sn-category-body">
                <div>
                  <span class="sn-eyebrow">${escapeHtml(cat.subtitle)}</span>
                  <h3>${escapeHtml(cat.name)}</h3>
                  <p>${escapeHtml(cat.description)}</p>
                </div>
                <span style="font-weight:700;color:var(--sn-accent-terracotta);font-size:0.875rem;">Browse ${escapeHtml(cat.name)} -></span>
              </div>
            </a>
          `).join('')}
        </div>
      </div>
    </section>

    <section class="sn-section sn-section-alt">
      <div class="sn-container">
        <div class="sn-section-head">
          <div>
            <span class="sn-eyebrow">Select Pack Size &amp; Add Directly</span>
            <h2>Featured Harvests</h2>
          </div>
          <a href="${basePath}/shop" class="sn-btn sn-btn-forest sn-btn-sm">Browse All Packs</a>
        </div>
        <div class="sn-product-grid">
          ${featured.map(p => renderProductCard(p, variants, basePath)).join('')}
        </div>
      </div>
    </section>

    <section class="sn-section">
      <div class="sn-container">
        <div class="sn-section-head">
          <div>
            <span class="sn-eyebrow">Most Reordered Across India</span>
            <h2>Pantry Best Sellers</h2>
          </div>
        </div>
        <div class="sn-product-grid">
          ${bestsellers.map(p => renderProductCard(p, variants, basePath)).join('')}
        </div>
      </div>
    </section>
  `;

  return renderShell({
    title,
    description,
    canonicalPath: '/',
    activeNav: 'home',
    schemaGraph,
    bodyHtml,
    isNoIndex,
    basePath,
    staticShowcaseScript
  });
}

function renderCatalogPage({
  categories,
  activeCategory = null,
  products,
  variants,
  searchQuery = '',
  sortBy = 'featured',
  tagFilter = 'all',
  maxPriceInr = 'all',
  packFilter = 'all',
  currentPage = 1,
  totalPages = 1,
  totalMatchingCount = null,
  basePath = '',
  staticShowcaseScript = '',
  isNoIndex = false
}) {
  const canonicalPath = activeCategory ? `/category/${activeCategory.slug}` : '/shop';
  const title = activeCategory
    ? `${activeCategory.name} (${activeCategory.subtitle}) | ${BRAND_NAME}`
    : `All Natural Products Catalogue | ${BRAND_NAME}`;
  const description = activeCategory
    ? activeCategory.description
    : 'Browse all Sasya Naturals dry fruits, unpolished millets, and single-origin spices with 100 g, 250 g, 500 g, and 1 kg pack variants.';

  const breadcrumbs = [{ name: 'Home', url: '/' }];
  if (activeCategory) {
    breadcrumbs.push({ name: 'Catalogue', url: '/shop' });
    breadcrumbs.push({ name: activeCategory.name, url: canonicalPath });
  } else {
    breadcrumbs.push({ name: 'Catalogue', url: '/shop' });
  }

  const schemaGraph = buildMasterSchemaGraph({
    pageType: 'collection',
    canonicalPath,
    title,
    description,
    breadcrumbs,
    categoryProducts: products
  });

  const totalCount = totalMatchingCount !== null ? totalMatchingCount : products.length;

  const bodyHtml = `
    <section class="sn-section">
      <div class="sn-container">
        <div class="sn-section-head">
          <div>
            <span class="sn-eyebrow">${activeCategory ? escapeHtml(activeCategory.subtitle) : 'Complete D2C Pantry Catalogue'}</span>
            <h1>${activeCategory ? escapeHtml(activeCategory.name) : 'All Sasya Naturals Products'}</h1>
            <p style="color:var(--sn-text-secondary);max-width:68ch;margin:8px 0 0;">${escapeHtml(description)}</p>
          </div>
        </div>

        <form class="sn-filter-bar" method="GET" action="${basePath}${canonicalPath}" id="catalog-filter-form">
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <a href="${basePath}/shop" class="sn-btn ${!activeCategory ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm">All Catalogue</a>
            ${categories.map(c => `
              <a href="${basePath}/category/${escapeHtml(c.slug)}" class="sn-btn ${activeCategory && activeCategory.slug === c.slug ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm">${escapeHtml(c.name)}</a>
            `).join('')}
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input type="search" name="q" value="${escapeHtml(searchQuery)}" placeholder="Search almonds, ragi, cloves..." class="sn-input" style="width:190px;" id="catalog-search-input" />
            <select name="tag" class="sn-select" style="width:150px;" id="catalog-tag-select">
              <option value="all" ${tagFilter === 'all' ? 'selected' : ''}>Filter: All Items</option>
              <option value="bestseller" ${tagFilter === 'bestseller' ? 'selected' : ''}>Bestsellers Only</option>
              <option value="featured" ${tagFilter === 'featured' ? 'selected' : ''}>Featured Only</option>
              <option value="new_arrival" ${tagFilter === 'new_arrival' ? 'selected' : ''}>New Harvests</option>
              <option value="in_stock" ${tagFilter === 'in_stock' ? 'selected' : ''}>In Stock Only</option>
            </select>
            <select name="maxPrice" class="sn-select" style="width:145px;" id="catalog-price-select">
              <option value="all" ${maxPriceInr === 'all' ? 'selected' : ''}>Price: Any</option>
              <option value="150" ${String(maxPriceInr) === '150' ? 'selected' : ''}>100g Under ₹150</option>
              <option value="250" ${String(maxPriceInr) === '250' ? 'selected' : ''}>100g Under ₹250</option>
              <option value="500" ${String(maxPriceInr) === '500' ? 'selected' : ''}>100g Under ₹500</option>
            </select>
            <select name="pack" class="sn-select" style="width:135px;" id="catalog-pack-select">
              <option value="all" ${packFilter === 'all' ? 'selected' : ''}>Pack: All Sizes</option>
              <option value="100 g" ${packFilter === '100 g' ? 'selected' : ''}>100 g Pack</option>
              <option value="250 g" ${packFilter === '250 g' ? 'selected' : ''}>250 g Pack</option>
              <option value="500 g" ${packFilter === '500 g' ? 'selected' : ''}>500 g Pack</option>
              <option value="1 kg" ${packFilter === '1 kg' ? 'selected' : ''}>1 kg Pack</option>
            </select>
            <select name="sort" class="sn-select" style="width:155px;" id="catalog-sort-select">
              <option value="featured" ${sortBy === 'featured' ? 'selected' : ''}>Sort: Featured</option>
              <option value="price_asc" ${sortBy === 'price_asc' ? 'selected' : ''}>Price: Low to High</option>
              <option value="price_desc" ${sortBy === 'price_desc' ? 'selected' : ''}>Price: High to Low</option>
            </select>
            <button type="submit" class="sn-btn sn-btn-primary sn-btn-sm" id="catalog-search-btn">Apply Filters</button>
          </div>
        </form>

        <div class="sn-product-grid" id="sn-catalog-product-grid">
          ${products.length > 0
            ? products.map(p => renderProductCard(p, variants, basePath)).join('')
            : `<div class="sn-card"><p>No matching products found for your active filters. <a href="${basePath}${canonicalPath}" style="color:var(--sn-accent-terracotta);font-weight:600;">Reset filters</a></p></div>`
          }
        </div>

        <div class="sn-card" style="margin-top:24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;padding:14px 20px;" id="sn-catalog-pagination-bar">
          <div style="font-family:var(--sn-font-mono);font-size:0.8rem;color:var(--sn-text-secondary);" id="sn-catalog-count-label">
            Showing <strong>${products.length}</strong> of <strong>${totalCount}</strong> products (Page ${currentPage} of ${totalPages})
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            ${totalPages > 1 ? Array.from({ length: totalPages }, (_, i) => i + 1).map(pg => `
              <a
                href="${basePath}${canonicalPath}?page=${pg}${searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : ''}${sortBy !== 'featured' ? `&sort=${encodeURIComponent(sortBy)}` : ''}${tagFilter !== 'all' ? `&tag=${encodeURIComponent(tagFilter)}` : ''}${maxPriceInr !== 'all' ? `&maxPrice=${encodeURIComponent(maxPriceInr)}` : ''}"
                class="sn-btn ${pg === currentPage ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm"
              >Page ${pg}</a>
            `).join('') : ''}
            ${totalPages > 1 ? `
              <a href="${basePath}${canonicalPath}?limit=all" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-catalog-load-all-btn">View All (${totalCount})</a>
            ` : `
              <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-client-progressive-more-btn" style="display:none;">Load More Products</button>
            `}
          </div>
        </div>
      </div>
    </section>
  `;

  return renderShell({
    title,
    description,
    canonicalPath,
    activeNav: activeCategory ? activeCategory.slug : 'shop',
    schemaGraph,
    bodyHtml,
    isNoIndex,
    basePath,
    staticShowcaseScript
  });
}

function renderProductDetailPage({ product, category, variants, relatedProducts, allVariants, basePath = '', staticShowcaseScript = '', isNoIndex = false }) {
  const canonicalPath = `/product/${product.slug}`;
  const title = `${product.name} (100 g, 250 g, 500 g, 1 kg) | ${BRAND_NAME}`;
  const description = product.short_description;
  const activeVariants = variants.filter(v => v.is_active);
  const defVar = activeVariants.find(v => v.pack_label === '250 g') || activeVariants[0];
  const shipCopy = getDynamicShippingCopy();

  let extraGallery = [];
  try {
    extraGallery = JSON.parse(product.gallery_json || '[]');
    if (!Array.isArray(extraGallery)) extraGallery = [];
  } catch {
    extraGallery = [];
  }
  const allGalleryPhotos = [
    { url: product.image_url, caption: product.image_caption || `${product.name} (Primary Pack View)` },
    ...extraGallery.filter(g => g.url && g.url !== product.image_url)
  ];

  const schemaGraph = buildMasterSchemaGraph({
    pageType: 'product',
    canonicalPath,
    title,
    description,
    breadcrumbs: [
      { name: 'Home', url: '/' },
      { name: category.name, url: `/category/${category.slug}` },
      { name: product.name, url: canonicalPath }
    ],
    product: { ...product, category_name: category.name },
    variants: activeVariants
  });

  const bodyHtml = `
    <section class="sn-section">
      <div class="sn-container">
        <div style="font-family:var(--sn-font-mono);font-size:0.78rem;color:var(--sn-text-muted);margin-bottom:20px;">
          <a href="${basePath}/">Home</a> / <a href="${basePath}/category/${escapeHtml(category.slug)}">${escapeHtml(category.name)}</a> / <strong>${escapeHtml(product.name)}</strong>
        </div>

        <div class="sn-pdp-grid" data-product-container="${product.id}">
          <div class="sn-pdp-gallery">
            <img src="${basePath}${escapeHtml(product.image_url)}" alt="${escapeHtml(product.name)}" id="sn-pdp-main-img" data-product-img-id="${product.id}" />
            <div id="sn-pdp-main-caption" style="padding:12px 18px;background-color:var(--sn-bg-mortar);font-family:var(--sn-font-mono);font-size:0.76rem;color:var(--sn-text-secondary);">
              ${escapeHtml(product.image_caption || product.name)} | Origin: ${escapeHtml(product.origin_region)}
            </div>
            ${allGalleryPhotos.length > 1 ? `
              <div style="display:flex;gap:10px;padding:12px 18px;background-color:var(--sn-bg-surface);border-top:1px solid var(--sn-border-warm);overflow-x:auto;">
                ${allGalleryPhotos.map((g, idx) => `
                  <button
                    type="button"
                    class="sn-btn sn-btn-outline sn-btn-sm"
                    data-pdp-thumb-url="${basePath}${escapeHtml(g.url)}"
                    data-pdp-thumb-caption="${escapeHtml(g.caption || product.name)}"
                    style="padding:3px;border-radius:6px;"
                  >
                    <img src="${basePath}${escapeHtml(g.url)}" alt="${escapeHtml(g.caption || `View ${idx + 1}`)}" style="width:58px;height:58px;object-fit:cover;border-radius:4px;" />
                  </button>
                `).join('')}
              </div>
            ` : ''}
          </div>

          <div>
            <span class="sn-eyebrow">${escapeHtml(category.name)} • Batch ${escapeHtml(product.harvest_batch)}</span>
            <h1 style="font-family:var(--sn-font-serif);font-size:clamp(1.8rem,2.8vw,2.45rem);color:var(--sn-bg-forest);margin:0 0 10px;">${escapeHtml(product.name)}</h1>
            <div style="display:flex;align-items:center;gap:16px;font-family:var(--sn-font-mono);font-size:0.8rem;color:var(--sn-text-muted);margin-bottom:16px;">
              <span>SKU: <strong data-sku-display>${escapeHtml(defVar.sku)}</strong></span>
              <span>Rating: ★ ${Number(product.rating_value).toFixed(1)} (${product.review_count} verified buyers)</span>
              <span class="sn-status sn-status-paid" data-stock-display>In Stock (${defVar.stock_qty} packs)</span>
            </div>

            <p style="font-size:1rem;color:var(--sn-text-primary);margin-bottom:20px;">${escapeHtml(product.description)}</p>

            <div class="sn-card" style="margin-bottom:24px;">
              <div style="font-family:var(--sn-font-mono);font-size:0.76rem;text-transform:uppercase;color:var(--sn-text-muted);margin-bottom:8px;">
                1. Choose Pack-Size Variant
              </div>
              <div class="sn-pack-selector">
                ${activeVariants.map(v => `
                  <button
                    type="button"
                    class="sn-pack-pill ${v.id === defVar.id ? 'sn-active' : ''}"
                    data-variant-pill
                    data-variant-id="${v.id}"
                    data-pack-label="${escapeHtml(v.pack_label)}"
                    data-price-paise="${v.selling_price_paise}"
                    data-mrp-paise="${v.mrp_paise}"
                    data-sku="${escapeHtml(v.sku)}"
                    data-stock="${v.stock_qty}"
                  >${escapeHtml(v.pack_label)}</button>
                `).join('')}
              </div>

              <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;padding-top:12px;border-top:1px solid var(--sn-border-warm);">
                <div>
                  <div style="display:flex;align-items:baseline;gap:10px;">
                    <span class="sn-price-current" style="font-size:1.65rem;" data-price-display>${formatInr(defVar.selling_price_paise)}</span>
                    <span class="sn-price-mrp" style="font-size:0.9rem;" data-mrp-display>MRP ${formatInr(defVar.mrp_paise)}</span>
                  </div>
                  <span style="font-size:0.76rem;color:var(--sn-text-muted);">Inclusive of ${product.gst_percent}% GST | ${escapeHtml(shipCopy.pdpShortText)}</span>
                </div>

                <div style="display:flex;align-items:center;gap:10px;">
                  <label for="sn-pdp-qty" style="font-size:0.8rem;font-weight:600;">Qty:</label>
                  <input type="number" id="sn-pdp-qty" value="1" min="1" max="20" class="sn-input" style="width:72px;text-align:center;" />
                  <button
                    type="button"
                    class="sn-btn sn-btn-primary"
                    id="pdp-add-to-cart-btn"
                    data-add-to-cart
                    data-variant-id="${defVar.id}"
                    data-product-name="${escapeHtml(product.name)}"
                    data-pack-label="${escapeHtml(defVar.pack_label)}"
                  >Add Pack to Basket</button>
                </div>
              </div>
            </div>

            <table class="sn-spec-table" aria-label="Product Compliance and Nutritional Information">
              <tbody>
                <tr><th>Growing Region / Origin</th><td>${escapeHtml(product.origin_region)}</td></tr>
                <tr><th>Harvest Batch &amp; Best Before</th><td>Batch ${escapeHtml(product.harvest_batch)} • Best before ${product.shelf_life_months} months from packing</td></tr>
                <tr><th>Ingredients</th><td>${escapeHtml(product.ingredients)}</td></tr>
                <tr><th>Allergen Information</th><td>${escapeHtml(product.allergen_info)}</td></tr>
                <tr><th>Food Safety &amp; Storage Notes</th><td>${escapeHtml(product.fssai_notes)}</td></tr>
                <tr><th>Available Pack Weights</th><td>100 g, 250 g, 500 g, and 1 kg nitrogen-flushed stand-up pouches</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>

    <section class="sn-section sn-section-alt">
      <div class="sn-container">
        <div class="sn-section-head">
          <h2>More from ${escapeHtml(category.name)}</h2>
        </div>
        <div class="sn-product-grid">
          ${relatedProducts.map(rp => renderProductCard(rp, allVariants, basePath)).join('')}
        </div>
      </div>
    </section>
  `;

  return renderShell({
    title,
    description,
    canonicalPath,
    activeNav: category.slug,
    schemaGraph,
    bodyHtml,
    isNoIndex,
    basePath,
    staticShowcaseScript
  });
}

function renderCheckoutPage({ coupons, basePath = '', staticShowcaseScript = '', isNoIndex = false }) {
  const title = `Secure Checkout (Razorpay UPI, Cards, NetBanking & COD) | ${BRAND_NAME}`;
  const description = 'Complete your Sasya Naturals order with server-verified Razorpay online payment or Cash on Delivery across India.';
  const schemaGraph = buildMasterSchemaGraph({
    pageType: 'webpage',
    canonicalPath: '/checkout',
    title,
    description,
    breadcrumbs: [{ name: 'Home', url: '/' }, { name: 'Checkout', url: '/checkout' }]
  });

  const bodyHtml = `
    <section class="sn-section">
      <div class="sn-container">
        <div class="sn-section-head">
          <div>
            <span class="sn-eyebrow">Rust WASM Integer-Paise Checkout &amp; Server HMAC Verification</span>
            <h1>Checkout &amp; Delivery Details</h1>
          </div>
        </div>

        <div id="sn-checkout-result" style="display:none;margin-bottom:28px;"></div>

        <div class="sn-pdp-grid">
          <form class="sn-card" id="sn-checkout-form">
            <h3 style="font-family:var(--sn-font-serif);margin:0 0 16px;color:var(--sn-bg-forest);">1. Contact &amp; Indian Delivery Address (Guest or Account)</h3>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
              <div>
                <label for="chk-name" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">Full Name *</label>
                <input type="text" id="chk-name" name="customerName" required value="Arjun Krishnamurthy" class="sn-input" />
              </div>
              <div>
                <label for="chk-phone" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">Mobile Number (India) *</label>
                <input type="tel" id="chk-phone" name="customerPhone" required value="+91 98450 11223" class="sn-input" />
              </div>
            </div>
            <div style="margin-bottom:14px;">
              <label for="chk-email" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">Email Address (for Order &amp; Courier Notifications) *</label>
              <input type="email" id="chk-email" name="customerEmail" required value="arjun.k@example.com" class="sn-input" />
            </div>
            <div style="margin-bottom:14px;">
              <label for="chk-line1" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">House / Flat No., Building &amp; Street Address *</label>
              <input type="text" id="chk-line1" name="shippingLine1" required value="No. 18, 4th Cross, Malleshwaram" class="sn-input" />
            </div>
            <div style="margin-bottom:14px;">
              <label for="chk-line2" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">Landmark / Area (Optional)</label>
              <input type="text" id="chk-line2" name="shippingLine2" value="Near Sankey Tank" class="sn-input" />
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:14px;">
              <div>
                <label for="chk-city" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">City *</label>
                <input type="text" id="chk-city" name="shippingCity" required value="Bengaluru" class="sn-input" />
              </div>
              <div>
                <label for="chk-state" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">State *</label>
                <input type="text" id="chk-state" name="shippingState" required value="Karnataka" class="sn-input" />
              </div>
              <div>
                <label for="chk-pin" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">6-Digit PIN Code *</label>
                <input type="text" id="chk-pin" name="shippingPincode" required pattern="\\d{6}" value="560003" class="sn-input" />
              </div>
            </div>
            <div style="margin-bottom:20px;">
              <label for="chk-notes" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">Delivery Instructions</label>
              <input type="text" id="chk-notes" name="deliveryInstructions" placeholder="e.g. Call on arrival or leave at reception" class="sn-input" />
            </div>

            <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;color:var(--sn-bg-forest);">2. Select Payment Mode (Razorpay Gateway or COD)</h3>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:22px;">
              <label class="sn-card" style="padding:12px;cursor:pointer;display:flex;align-items:center;gap:8px;">
                <input type="radio" name="paymentMethod" value="ONLINE_UPI" checked />
                <span><strong>UPI Instant Pay</strong> (GPay / PhonePe / BHIM)</span>
              </label>
              <label class="sn-card" style="padding:12px;cursor:pointer;display:flex;align-items:center;gap:8px;">
                <input type="radio" name="paymentMethod" value="ONLINE_CARD" />
                <span><strong>Credit / Debit Card</strong> (Visa / RuPay / MC)</span>
              </label>
              <label class="sn-card" style="padding:12px;cursor:pointer;display:flex;align-items:center;gap:8px;">
                <input type="radio" name="paymentMethod" value="ONLINE_NETBANKING" />
                <span><strong>Net Banking</strong> (All Indian Banks)</span>
              </label>
              <label class="sn-card" style="padding:12px;cursor:pointer;display:flex;align-items:center;gap:8px;">
                <input type="radio" name="paymentMethod" value="COD" />
                <span><strong>Cash on Delivery (COD)</strong> (Pay at Doorstep)</span>
              </label>
            </div>

            <button type="submit" class="sn-btn sn-btn-primary" style="width:100%;padding:14px;font-size:1rem;" id="place-order-submit-btn">
              Place Order &amp; Verify Server-Side ->
            </button>
          </form>

          <div>
            <div class="sn-card" style="margin-bottom:20px;">
              <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;color:var(--sn-bg-forest);">Apply Promotional Coupon</h3>
              <div style="display:flex;gap:10px;margin-bottom:10px;">
                <input type="text" id="sn-checkout-coupon" placeholder="Enter SASYA10 or WELCOME15" value="SASYA10" class="sn-input" />
                <button type="button" class="sn-btn sn-btn-forest" id="sn-apply-coupon-btn">Apply</button>
              </div>
              <div style="font-family:var(--sn-font-mono);font-size:0.75rem;color:var(--sn-text-muted);">
                Active codes: ${coupons.map(c => `<strong>${escapeHtml(c.code)}</strong> (${escapeHtml(c.description)})`).join(' | ')}
              </div>
            </div>

            <div class="sn-card">
              <h3 style="font-family:var(--sn-font-serif);margin:0 0 16px;color:var(--sn-bg-forest);">Server-Calculated Order Summary</h3>
              <div id="sn-checkout-summary-box">Loading basket summary...</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;

  return renderShell({
    title,
    description,
    canonicalPath: '/checkout',
    activeNav: 'shop',
    schemaGraph,
    bodyHtml,
    isNoIndex,
    basePath,
    staticShowcaseScript
  });
}

function renderTrackOrderPage({ order, orderItems = [], queryOrderNumber = '', basePath = '', staticShowcaseScript = '', isNoIndex = false }) {
  const title = `Track Order & Manual Courier Status | ${BRAND_NAME}`;
  const description = 'Track your Sasya Naturals order status, separate payment and fulfilment states, and manual courier AWB tracking reference.';
  const schemaGraph = buildMasterSchemaGraph({
    pageType: 'webpage',
    canonicalPath: '/track-order',
    title,
    description,
    breadcrumbs: [{ name: 'Home', url: '/' }, { name: 'Track Order', url: '/track-order' }]
  });

  const steps = ['Pending Payment', 'Confirmed', 'Processing', 'Packed', 'Shipped', 'Delivered'];

  const bodyHtml = `
    <section class="sn-section">
      <div class="sn-container">
        <div class="sn-section-head">
          <div>
            <span class="sn-eyebrow">Dual Payment &amp; Fulfilment Status + Manual Courier Reference</span>
            <h1>Track Your Sasya Naturals Order</h1>
          </div>
        </div>

        <form class="sn-filter-bar" method="GET" action="${basePath}/track-order" id="track-order-form">
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;width:100%;">
            <input type="text" name="order" value="${escapeHtml(queryOrderNumber || (order ? order.order_number : 'SN-2026-1001'))}" placeholder="Enter Order Number (e.g. SN-2026-1001 or SN-2026-1002)" class="sn-input" style="max-width:360px;" id="track-order-input" />
            <button type="submit" class="sn-btn sn-btn-forest" id="track-order-submit-btn">Lookup Order Status</button>
            <span style="font-family:var(--sn-font-mono);font-size:0.78rem;color:var(--sn-text-muted);">
              Try sample orders: <a href="${basePath}/track-order?order=SN-2026-1001" style="color:var(--sn-accent-terracotta);text-decoration:underline;">SN-2026-1001 (Shipped via Blue Dart)</a> or <a href="${basePath}/track-order?order=SN-2026-1002" style="color:var(--sn-accent-terracotta);text-decoration:underline;">SN-2026-1002 (COD Confirmed)</a>
            </span>
          </div>
        </form>

        ${order ? `
          <div class="sn-card" style="margin-bottom:24px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px;padding-bottom:18px;border-bottom:1px solid var(--sn-border-warm);">
              <div>
                <span class="sn-eyebrow">Order Number</span>
                <h2 style="font-family:var(--sn-font-serif);margin:0;color:var(--sn-bg-forest);">${escapeHtml(order.order_number)}</h2>
                <div style="font-size:0.86rem;color:var(--sn-text-secondary);margin-top:4px;">
                  Customer: <strong>${escapeHtml(order.customer_name)}</strong> | Destination: ${escapeHtml(order.shipping_city)}, ${escapeHtml(order.shipping_state)} - ${escapeHtml(order.shipping_pincode)}
                </div>
              </div>
              <div style="display:flex;gap:12px;flex-wrap:wrap;">
                <div>
                  <div style="font-family:var(--sn-font-mono);font-size:0.7rem;color:var(--sn-text-muted);">PAYMENT STATUS</div>
                  <span class="sn-status ${order.payment_status === 'PAID' || order.payment_status === 'COD_COLLECTED' ? 'sn-status-paid' : 'sn-status-warn'}">${escapeHtml(order.payment_status)}</span>
                </div>
                <div>
                  <div style="font-family:var(--sn-font-mono);font-size:0.7rem;color:var(--sn-text-muted);">FULFILMENT STATUS</div>
                  <span class="sn-status sn-status-paid">${escapeHtml(order.fulfilment_status)}</span>
                </div>
                <div>
                  <div style="font-family:var(--sn-font-mono);font-size:0.7rem;color:var(--sn-text-muted);">ORDER TOTAL</div>
                  <strong style="font-family:var(--sn-font-mono);font-size:1.1rem;color:var(--sn-bg-forest);">${formatInr(order.total_paise)}</strong>
                </div>
                <div>
                  <a href="${basePath}/orders/${escapeHtml(order.order_number)}/invoice" class="sn-btn sn-btn-outline sn-btn-sm" id="download-gst-invoice-btn">GST Tax Invoice -></a>
                </div>
              </div>
            </div>

            <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin:22px 0;">
              ${steps.map(st => {
                const currentIdx = steps.indexOf(order.fulfilment_status);
                const stepIdx = steps.indexOf(st);
                const done = currentIdx >= stepIdx;
                return `
                  <div style="padding:10px;border-radius:6px;border:1px solid ${done ? 'var(--sn-bg-forest)' : 'var(--sn-border-warm)'};background-color:${done ? 'var(--sn-status-paid-bg)' : 'var(--sn-bg-parchment)'};text-align:center;font-family:var(--sn-font-mono);font-size:0.75rem;font-weight:600;color:${done ? 'var(--sn-bg-forest)' : 'var(--sn-text-muted)'};">
                    ${done ? '✓ ' : ''}${escapeHtml(st)}
                  </div>
                `;
              }).join('')}
            </div>

            <div class="sn-card" style="background-color:var(--sn-bg-mortar);margin-bottom:20px;">
              <h3 style="font-family:var(--sn-font-serif);margin:0 0 8px;font-size:1.1rem;color:var(--sn-bg-forest);">Manual Courier &amp; Dispatch Details (Entered by Order Staff)</h3>
              ${order.courier_name ? `
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;font-size:0.88rem;">
                  <div><span style="color:var(--sn-text-muted);">Courier Partner:</span><br/><strong>${escapeHtml(order.courier_name)}</strong></div>
                  <div><span style="color:var(--sn-text-muted);">Tracking / AWB Number:</span><br/><strong style="font-family:var(--sn-font-mono);">${escapeHtml(order.tracking_number)}</strong></div>
                  <div><span style="color:var(--sn-text-muted);">Dispatch Date:</span><br/><strong style="font-family:var(--sn-font-mono);">${escapeHtml(order.dispatch_date || 'Recorded')}</strong></div>
                  <div><span style="color:var(--sn-text-muted);">Tracking Link:</span><br/><a href="${escapeHtml(order.tracking_url || '#')}" target="_blank" rel="noopener" style="color:var(--sn-accent-terracotta);font-weight:600;">Open Courier Portal -></a></div>
                </div>
              ` : `
                <p style="margin:0;font-size:0.88rem;color:var(--sn-text-secondary);">
                  Your order is currently in <strong>${escapeHtml(order.fulfilment_status)}</strong> stage. Once our packing team hands the parcel to the courier partner, the courier name and manual tracking number will appear here automatically.
                </p>
              `}
            </div>

            <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;font-size:1.1rem;color:var(--sn-bg-forest);">Ordered Pack Items &amp; HSN Tax Breakdown (${escapeHtml(order.tax_supply_type || 'CGST_SGST')})</h3>
            <div class="sn-table-wrap">
              <table class="sn-table">
                <thead>
                  <tr><th>Product</th><th>SKU</th><th>HSN Code</th><th>Pack Size</th><th>Qty</th><th>Unit Price</th><th>Line Total</th></tr>
                </thead>
                <tbody>
                  ${orderItems.map(item => `
                    <tr>
                      <td><strong>${escapeHtml(item.product_name)}</strong></td>
                      <td style="font-family:var(--sn-font-mono);">${escapeHtml(item.sku)}</td>
                      <td style="font-family:var(--sn-font-mono);">${escapeHtml(item.hsn_code || '080290')}</td>
                      <td style="font-family:var(--sn-font-mono);">${escapeHtml(item.pack_label)}</td>
                      <td style="font-family:var(--sn-font-mono);">${item.quantity}</td>
                      <td style="font-family:var(--sn-font-mono);">${formatInr(item.unit_price_paise)}</td>
                      <td style="font-family:var(--sn-font-mono);font-weight:600;">${formatInr(item.line_total_paise)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        ` : `
          <div class="sn-card"><p>No order found matching "${escapeHtml(queryOrderNumber)}". Try <strong>SN-2026-1001</strong> or <strong>SN-2026-1002</strong>.</p></div>
        `}
      </div>
    </section>
  `;

  return renderShell({
    title,
    description,
    canonicalPath: '/track-order',
    activeNav: 'track',
    schemaGraph,
    bodyHtml,
    isNoIndex,
    basePath,
    staticShowcaseScript
  });
}

function renderGstInvoicePage({ order, orderItems = [], settingsMap = {}, basePath = '' }) {
  const title = `GST Tax Invoice ${order.order_number} | ${BRAND_NAME}`;
  const isIntra = (order.tax_supply_type || 'CGST_SGST') === 'CGST_SGST';
  const cgst = order.cgst_paise || Math.floor(order.gst_paise / 2);
  const sgst = order.sgst_paise || (order.gst_paise - cgst);
  const igst = order.igst_paise || order.gst_paise;

  const schemaGraph = buildMasterSchemaGraph({
    pageType: 'webpage',
    canonicalPath: `/orders/${order.order_number}/invoice`,
    title,
    description: `GST Tax Invoice for Sasya Naturals Order ${order.order_number}`,
    breadcrumbs: [{ name: 'Home', url: '/' }, { name: 'Track Order', url: '/track-order' }, { name: `Invoice ${order.order_number}`, url: `/orders/${order.order_number}/invoice` }]
  });

  const bodyHtml = `
    <section class="sn-section">
      <div class="sn-container" style="max-width:920px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
          <a href="${basePath}/track-order?order=${encodeURIComponent(order.order_number)}" class="sn-btn sn-btn-outline sn-btn-sm">&lt;- Back to Order Tracker</a>
          <button type="button" onclick="window.print()" class="sn-btn sn-btn-forest sn-btn-sm" id="print-invoice-btn">Print / Save GST Invoice PDF</button>
        </div>

        <div class="sn-card" style="padding:32px;">
          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:16px;padding-bottom:20px;border-bottom:2px solid var(--sn-bg-forest);">
            <div>
              <span class="sn-eyebrow">Tax Invoice (Original for Recipient)</span>
              <h1 style="font-family:var(--sn-font-serif);font-size:1.75rem;margin:0;color:var(--sn-bg-forest);">${escapeHtml(settingsMap.business_legal_name || BRAND_NAME)}</h1>
              <div style="font-size:0.84rem;color:var(--sn-text-secondary);margin-top:4px;">
                ${escapeHtml(settingsMap.registered_address || 'Bengaluru, Karnataka')}<br/>
                <strong>GSTIN:</strong> <span style="font-family:var(--sn-font-mono);">${escapeHtml(settingsMap.gstin || 'CONFIGURABLE')}</span> |
                <strong>FSSAI:</strong> <span style="font-family:var(--sn-font-mono);">${escapeHtml(settingsMap.fssai_license || 'CONFIGURABLE')}</span>
              </div>
            </div>
            <div style="text-align:right;font-family:var(--sn-font-mono);font-size:0.82rem;">
              <div><strong>Invoice No:</strong> INV-${escapeHtml(order.order_number)}</div>
              <div><strong>Order No:</strong> ${escapeHtml(order.order_number)}</div>
              <div><strong>Date:</strong> ${escapeHtml(order.created_at.slice(0, 10))}</div>
              <div><strong>Place of Supply:</strong> ${escapeHtml(order.shipping_state)} (${escapeHtml(order.shipping_pincode)})</div>
              <div><strong>Tax Regime:</strong> ${isIntra ? 'Intra-State (CGST + SGST)' : 'Inter-State (IGST)'}</div>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:18px 0;border-bottom:1px solid var(--sn-border-warm);font-size:0.86rem;">
            <div>
              <strong style="color:var(--sn-bg-forest);">Billed &amp; Shipped To:</strong><br/>
              <strong>${escapeHtml(order.customer_name)}</strong><br/>
              ${escapeHtml(order.shipping_line1)} ${escapeHtml(order.shipping_line2)}<br/>
              ${escapeHtml(order.shipping_city)}, ${escapeHtml(order.shipping_state)} - ${escapeHtml(order.shipping_pincode)}<br/>
              Phone: ${escapeHtml(order.customer_phone)} | Email: ${escapeHtml(order.customer_email)}
            </div>
            <div>
              <strong style="color:var(--sn-bg-forest);">Payment &amp; Dispatch Summary:</strong><br/>
              Payment Mode: <strong>${escapeHtml(order.payment_method)}</strong><br/>
              Payment Status: <strong>${escapeHtml(order.payment_status)}</strong><br/>
              Gateway Ref: <span style="font-family:var(--sn-font-mono);">${escapeHtml(order.gateway_payment_id || order.gateway_order_id)}</span><br/>
              Courier / AWB: <span style="font-family:var(--sn-font-mono);">${escapeHtml(order.courier_name ? `${order.courier_name} (${order.tracking_number})` : 'Pending Manual Dispatch')}</span>
            </div>
          </div>

          <div class="sn-table-wrap" style="margin:20px 0;">
            <table class="sn-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Description of Goods</th>
                  <th>HSN</th>
                  <th>Pack</th>
                  <th>Qty</th>
                  <th>Rate (Incl. Tax)</th>
                  <th>GST %</th>
                  <th>Line Total</th>
                </tr>
              </thead>
              <tbody>
                ${orderItems.map((it, idx) => `
                  <tr>
                    <td style="font-family:var(--sn-font-mono);">${idx + 1}</td>
                    <td><strong>${escapeHtml(it.product_name)}</strong><br/><span style="font-family:var(--sn-font-mono);font-size:0.74rem;color:var(--sn-text-muted);">SKU: ${escapeHtml(it.sku)}</span></td>
                    <td style="font-family:var(--sn-font-mono);">${escapeHtml(it.hsn_code || '080290')}</td>
                    <td style="font-family:var(--sn-font-mono);">${escapeHtml(it.pack_label)}</td>
                    <td style="font-family:var(--sn-font-mono);">${it.quantity}</td>
                    <td style="font-family:var(--sn-font-mono);">${formatInr(it.unit_price_paise)}</td>
                    <td style="font-family:var(--sn-font-mono);">${it.gst_percent}%</td>
                    <td style="font-family:var(--sn-font-mono);font-weight:600;">${formatInr(it.line_total_paise)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>

          <div style="display:flex;justify-content:flex-end;">
            <div style="width:340px;font-size:0.88rem;display:flex;flex-direction:column;gap:6px;">
              <div style="display:flex;justify-content:space-between;"><span>Gross Subtotal:</span><strong style="font-family:var(--sn-font-mono);">${formatInr(order.subtotal_paise)}</strong></div>
              ${order.discount_paise > 0 ? `<div style="display:flex;justify-content:space-between;color:var(--sn-status-paid);"><span>Coupon Discount (${escapeHtml(order.coupon_code)}):</span><strong style="font-family:var(--sn-font-mono);">-${formatInr(order.discount_paise)}</strong></div>` : ''}
              ${isIntra ? `
                <div style="display:flex;justify-content:space-between;color:var(--sn-text-secondary);"><span>Included CGST (Central Tax):</span><span style="font-family:var(--sn-font-mono);">${formatInr(cgst)}</span></div>
                <div style="display:flex;justify-content:space-between;color:var(--sn-text-secondary);"><span>Included SGST (Karnataka State Tax):</span><span style="font-family:var(--sn-font-mono);">${formatInr(sgst)}</span></div>
              ` : `
                <div style="display:flex;justify-content:space-between;color:var(--sn-text-secondary);"><span>Included IGST (Integrated Tax):</span><span style="font-family:var(--sn-font-mono);">${formatInr(igst)}</span></div>
              `}
              <div style="display:flex;justify-content:space-between;"><span>Shipping Charges:</span><strong style="font-family:var(--sn-font-mono);">${order.shipping_paise === 0 ? 'FREE' : formatInr(order.shipping_paise)}</strong></div>
              <div style="display:flex;justify-content:space-between;font-size:1.15rem;padding-top:10px;border-top:2px solid var(--sn-bg-forest);color:var(--sn-bg-forest);">
                <strong>Grand Total (INR):</strong><strong style="font-family:var(--sn-font-mono);">${formatInr(order.total_paise)}</strong>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;

  return renderShell({
    title,
    description: `GST Tax Invoice for Order ${order.order_number}`,
    canonicalPath: `/orders/${order.order_number}/invoice`,
    activeNav: 'track',
    schemaGraph,
    bodyHtml,
    isNoIndex: true,
    basePath
  });
}

function renderCustomerAccountPage({
  customer = null,
  addresses = [],
  orders = [],
  orderItems = [],
  basePath = '',
  staticShowcaseScript = '',
  isNoIndex = true
}) {
  const title = `Customer Account, Saved Addresses & Order History | ${BRAND_NAME}`;
  const description = 'Manage your Sasya Naturals customer profile, saved Indian delivery addresses, order history, and GST tax invoices.';
  const schemaGraph = buildMasterSchemaGraph({
    pageType: 'webpage',
    canonicalPath: '/account',
    title,
    description,
    breadcrumbs: [{ name: 'Home', url: '/' }, { name: 'Customer Account', url: '/account' }]
  });

  const activeCustomer = customer || {
    id: 6,
    email: 'ananya.iyer@example.com',
    full_name: 'Ananya Iyer',
    phone: '+91 98450 22334',
    role: 'CUSTOMER'
  };

  const bodyHtml = `
    <section class="sn-section" id="sn-customer-account-page">
      <div class="sn-container">
        <div class="sn-section-head">
          <div>
            <span class="sn-eyebrow">Section 4 Customer Account • Profile, Saved Delivery Addresses &amp; Order History</span>
            <h1>My Sasya Naturals Pantry Account</h1>
          </div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            <span class="sn-status sn-status-paid" id="sn-account-active-badge">Signed In: ${escapeHtml(activeCustomer.email)}</span>
            <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-customer-logout-btn">Sign Out</button>
          </div>
        </div>

        <!-- 1. Customer Sign-In & Registration Forms (Section 4: Registration/Login) -->
        <div class="sn-pdp-grid" style="margin-bottom:24px;">
          <form class="sn-card" id="sn-customer-login-form" style="background-color:var(--sn-bg-parchment);">
            <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;color:var(--sn-bg-forest);">1. Customer Sign In (HttpOnly Session Cookie)</h3>
            <p style="font-size:0.82rem;color:var(--sn-text-secondary);margin:0 0 12px;">
              Demo customer account pre-filled (<strong>ananya.iyer@example.com</strong> / <strong>Sasya@2026</strong>).
            </p>
            <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end;">
              <div>
                <label style="font-size:0.75rem;font-weight:600;">Email Address *</label>
                <input type="email" name="email" required value="${escapeHtml(activeCustomer.email)}" class="sn-input" />
              </div>
              <div>
                <label style="font-size:0.75rem;font-weight:600;">Password *</label>
                <input type="password" name="password" required value="Sasya@2026" class="sn-input" />
              </div>
              <button type="submit" class="sn-btn sn-btn-forest">Sign In</button>
            </div>
          </form>

          <form class="sn-card" id="sn-customer-register-form" style="background-color:var(--sn-bg-parchment);">
            <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;color:var(--sn-bg-forest);">2. New Customer Registration</h3>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
              <div>
                <label style="font-size:0.75rem;font-weight:600;">Full Name *</label>
                <input type="text" name="fullName" required placeholder="e.g. Rohan Deshpande" class="sn-input" />
              </div>
              <div>
                <label style="font-size:0.75rem;font-weight:600;">Mobile Number *</label>
                <input type="tel" name="phone" required placeholder="+91 98200 11223" class="sn-input" />
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end;">
              <div>
                <label style="font-size:0.75rem;font-weight:600;">Email Address *</label>
                <input type="email" name="email" required placeholder="rohan.d@example.com" class="sn-input" />
              </div>
              <div>
                <label style="font-size:0.75rem;font-weight:600;">Create Password (min 6 chars) *</label>
                <input type="password" name="password" required minlength="6" placeholder="••••••••" class="sn-input" />
              </div>
              <button type="submit" class="sn-btn sn-btn-primary">Create Account</button>
            </div>
          </form>
        </div>

        <!-- 2. Profile Management & Saved Delivery Addresses -->
        <div class="sn-pdp-grid" style="margin-bottom:28px;">
          <form class="sn-card" id="sn-customer-profile-form">
            <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;color:var(--sn-bg-forest);">3. Customer Profile &amp; Contact Preferences</h3>
            <input type="hidden" name="userId" value="${activeCustomer.id}" />
            <div style="margin-bottom:12px;">
              <label style="font-size:0.76rem;font-weight:600;display:block;margin-bottom:4px;">Full Name *</label>
              <input type="text" name="fullName" required value="${escapeHtml(activeCustomer.full_name)}" class="sn-input" id="cust-prof-name" />
            </div>
            <div style="margin-bottom:12px;">
              <label style="font-size:0.76rem;font-weight:600;display:block;margin-bottom:4px;">Registered Email Address</label>
              <input type="email" name="email" readonly value="${escapeHtml(activeCustomer.email)}" class="sn-input" style="background-color:var(--sn-bg-mortar);" id="cust-prof-email" />
            </div>
            <div style="margin-bottom:16px;">
              <label style="font-size:0.76rem;font-weight:600;display:block;margin-bottom:4px;">Mobile Number (for Courier &amp; COD OTP Updates) *</label>
              <input type="tel" name="phone" required value="${escapeHtml(activeCustomer.phone)}" class="sn-input" id="cust-prof-phone" />
            </div>
            <button type="submit" class="sn-btn sn-btn-forest">Save Profile Changes</button>
          </form>

          <div class="sn-card">
            <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;color:var(--sn-bg-forest);">4. Saved Delivery Addresses (${addresses.length})</h3>
            <div id="sn-customer-addresses-list" style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px;">
              ${addresses.map(a => `
                <div class="sn-card" style="padding:12px 16px;background-color:var(--sn-bg-parchment);" data-address-card="${a.id}">
                  <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;">
                    <div>
                      <strong>${escapeHtml(a.label)}</strong> • ${escapeHtml(a.recipient_name)} (${escapeHtml(a.phone)})
                      ${a.is_default ? `<span class="sn-status sn-status-paid" style="margin-left:6px;">Default</span>` : ''}
                    </div>
                    <div style="display:flex;gap:6px;">
                      ${!a.is_default ? `<button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-set-default-addr="${a.id}">Set Default</button>` : ''}
                      <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-delete-addr="${a.id}">Remove</button>
                    </div>
                  </div>
                  <div style="font-size:0.82rem;color:var(--sn-text-secondary);">
                    ${escapeHtml(a.line1)}${a.line2 ? ', ' + escapeHtml(a.line2) : ''}, ${escapeHtml(a.city)}, ${escapeHtml(a.state)} - <strong>${escapeHtml(a.pincode)}</strong>
                  </div>
                </div>
              `).join('')}
            </div>

            <form id="sn-customer-add-address-form" style="padding-top:12px;border-top:1px solid var(--sn-border-warm);">
              <div style="font-family:var(--sn-font-mono);font-size:0.75rem;text-transform:uppercase;color:var(--sn-text-muted);margin-bottom:8px;">Add New Delivery Address</div>
              <input type="hidden" name="userId" value="${activeCustomer.id}" />
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px;">
                <input type="text" name="label" required placeholder="Label (e.g. Office)" class="sn-input" />
                <input type="text" name="recipientName" required value="${escapeHtml(activeCustomer.full_name)}" placeholder="Recipient Name" class="sn-input" />
                <input type="tel" name="phone" required value="${escapeHtml(activeCustomer.phone)}" placeholder="Mobile No." class="sn-input" />
              </div>
              <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:8px;margin-bottom:8px;">
                <input type="text" name="line1" required placeholder="House / Flat / Street Address" class="sn-input" />
                <input type="text" name="line2" placeholder="Landmark / Area (Optional)" class="sn-input" />
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:8px;align-items:center;">
                <input type="text" name="city" required placeholder="City (e.g. Bengaluru)" class="sn-input" />
                <input type="text" name="state" required placeholder="State (e.g. Karnataka)" class="sn-input" />
                <input type="text" name="pincode" required pattern="\\d{6}" placeholder="6-Digit PIN" class="sn-input" />
                <button type="submit" class="sn-btn sn-btn-primary sn-btn-sm">Save Address</button>
              </div>
            </form>
          </div>
        </div>

        <!-- 3. Customer Order History & GST Tax Invoices -->
        <div class="sn-card">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:14px;">
            <div>
              <h2 style="font-family:var(--sn-font-serif);margin:0;font-size:1.35rem;color:var(--sn-bg-forest);">5. My Order History, Courier Tracking &amp; GST Invoices</h2>
              <p style="font-size:0.84rem;color:var(--sn-text-secondary);margin:4px 0 0;">View real-time dual payment &amp; fulfilment statuses and manual courier AWB numbers.</p>
            </div>
            <a href="${basePath}/shop" class="sn-btn sn-btn-forest sn-btn-sm">Place New Order -></a>
          </div>
          <div class="sn-table-wrap">
            <table class="sn-table" id="sn-customer-orders-table">
              <thead>
                <tr>
                  <th>Order No.</th>
                  <th>Date</th>
                  <th>Ordered Packs</th>
                  <th>Total (INR)</th>
                  <th>Payment Status</th>
                  <th>Fulfilment Status</th>
                  <th>Courier &amp; AWB</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${orders.map(o => {
                  const oItems = orderItems.filter(it => Number(it.order_id) === Number(o.id));
                  return `
                    <tr>
                      <td style="font-family:var(--sn-font-mono);font-weight:700;">${escapeHtml(o.order_number)}</td>
                      <td style="font-family:var(--sn-font-mono);font-size:0.78rem;">${escapeHtml((o.created_at || '').slice(0, 10))}</td>
                      <td style="font-size:0.82rem;">
                        ${oItems.length > 0
                          ? oItems.map(it => `${escapeHtml(it.product_name)} (${escapeHtml(it.pack_label)} × ${it.quantity})`).join(', ')
                          : 'Pantry Order Packs'}
                      </td>
                      <td style="font-family:var(--sn-font-mono);font-weight:700;">${formatInr(o.total_paise)}</td>
                      <td><span class="sn-status ${o.payment_status === 'PAID' || o.payment_status === 'COD_COLLECTED' ? 'sn-status-paid' : 'sn-status-warn'}">${escapeHtml(o.payment_status)}</span></td>
                      <td><span class="sn-status sn-status-paid">${escapeHtml(o.fulfilment_status)}</span></td>
                      <td style="font-family:var(--sn-font-mono);font-size:0.76rem;">
                        ${o.courier_name ? `${escapeHtml(o.courier_name)}<br/>AWB: ${escapeHtml(o.tracking_number)}` : 'Awaiting Dispatch'}
                      </td>
                      <td>
                        <div style="display:flex;gap:6px;flex-wrap:wrap;">
                          <a href="${basePath}/track-order?order=${encodeURIComponent(o.order_number)}" class="sn-btn sn-btn-forest sn-btn-sm">Track</a>
                          <a href="${basePath}/orders/${encodeURIComponent(o.order_number)}/invoice" class="sn-btn sn-btn-outline sn-btn-sm">GST Invoice</a>
                        </div>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  `;

  return renderShell({
    title,
    description,
    canonicalPath: '/account',
    activeNav: 'account',
    schemaGraph,
    bodyHtml,
    isNoIndex,
    basePath,
    staticShowcaseScript
  });
}

function renderAdminLoginRequiredPage({ basePath = '' }) {
  const title = `Staff Authentication Required | ${BRAND_NAME} Admin Portal`;
  const description = 'Sign in with your Sasya Naturals staff account to access the role-based administration portal.';
  const schemaGraph = buildMasterSchemaGraph({
    pageType: 'webpage',
    canonicalPath: '/admin',
    title,
    description,
    breadcrumbs: [{ name: 'Home', url: '/' }, { name: 'Admin Sign In', url: '/admin' }]
  });

  const bodyHtml = `
    <section class="sn-section">
      <div class="sn-container" style="max-width:520px;">
        <div class="sn-card" style="padding:32px;">
          <span class="sn-eyebrow">Section 5 Separate Staff Authentication Gate</span>
          <h1 style="font-family:var(--sn-font-serif);font-size:1.75rem;margin:0 0 8px;color:var(--sn-bg-forest);">Sasya Naturals Staff Sign In</h1>
          <p style="font-size:0.88rem;color:var(--sn-text-secondary);margin:0 0 20px;">
            This administration portal is separate from the customer storefront and protected by PBKDF2-SHA512 authentication and role-based access control.
          </p>
          <form id="sn-admin-login-form">
            <div style="margin-bottom:14px;">
              <label style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">Staff Email Address *</label>
              <input type="email" name="email" required value="superadmin@sasynaturals.com" class="sn-input" />
            </div>
            <div style="margin-bottom:18px;">
              <label style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">Password *</label>
              <input type="password" name="password" required value="Sasya@2026" class="sn-input" />
            </div>
            <button type="submit" class="sn-btn sn-btn-forest" style="width:100%;padding:12px;">Sign In to Admin Portal -></button>
          </form>
        </div>
      </div>
    </section>
  `;

  return renderShell({
    title,
    description,
    canonicalPath: '/admin',
    activeNav: 'admin',
    schemaGraph,
    bodyHtml,
    isNoIndex: true,
    basePath
  });
}

function renderAdminPortalPage({
  categories,
  products,
  variants,
  orders,
  orderItems = [],
  payments,
  staffUsers,
  customerUsers = [],
  customerAddresses = [],
  auditLogs,
  notificationLogs = [],
  settings,
  movements,
  vaultStatus = [],
  authenticatedAdmin = null,
  basePath = '',
  staticShowcaseScript = ''
}) {
  const title = `Staff RBAC Administration Portal | ${BRAND_NAME}`;
  const description = 'Role-based administration portal for Sasya Naturals Super Admin, Product Manager, Order Manager, Accounts Manager, and Staff.';
  const schemaGraph = buildMasterSchemaGraph({
    pageType: 'webpage',
    canonicalPath: '/admin',
    title,
    description,
    breadcrumbs: [{ name: 'Home', url: '/' }, { name: 'Admin Portal', url: '/admin' }]
  });

  const totalRevenuePaise = orders
    .filter(o => o.payment_status === 'PAID' || o.payment_status === 'COD_COLLECTED')
    .reduce((acc, o) => acc + o.total_paise, 0);
  const codPendingPaise = orders
    .filter(o => o.payment_status === 'COD_PENDING')
    .reduce((acc, o) => acc + o.total_paise, 0);
  const refundedPaise = orders
    .filter(o => o.payment_status === 'REFUNDED')
    .reduce((acc, o) => acc + o.total_paise, 0);
  const totalGstPaise = orders
    .filter(o => o.payment_status !== 'REFUNDED' && o.payment_status !== 'FAILED')
    .reduce((acc, o) => acc + (o.gst_paise || 0), 0);
  const lowStockVariants = variants.filter(v => v.stock_qty <= v.low_stock_threshold);
  const configuredVaultCount = vaultStatus.filter(v => v.is_configured).length;
  const pendingFulfilmentOrders = orders.filter(o => o.fulfilment_status === 'Confirmed' || o.fulfilment_status === 'Pending Payment' || o.fulfilment_status === 'Processing');

  // Product-Wise Sales Report Aggregation (Section 5.1 Reports)
  const productSalesMap = new Map();
  for (const p of products) {
    productSalesMap.set(Number(p.id), {
      productId: p.id,
      skuBase: p.sku_base,
      name: p.name,
      unitsSold: 0,
      gramsSold: 0,
      revenuePaise: 0
    });
  }
  for (const it of orderItems) {
    const rec = productSalesMap.get(Number(it.product_id)) || {
      productId: it.product_id,
      skuBase: it.sku,
      name: it.product_name,
      unitsSold: 0,
      gramsSold: 0,
      revenuePaise: 0
    };
    rec.unitsSold += Number(it.quantity || 0);
    rec.gramsSold += Number(it.weight_grams || 0) * Number(it.quantity || 0);
    rec.revenuePaise += Number(it.line_total_paise || 0);
    productSalesMap.set(Number(it.product_id), rec);
  }
  const productSalesRows = Array.from(productSalesMap.values()).sort((a, b) => b.revenuePaise - a.revenuePaise);

  // Customer Directory Aggregation (Section 5.1 Customers)
  const customerDirectoryMap = new Map();
  for (const cu of customerUsers) {
    customerDirectoryMap.set(cu.email.toLowerCase(), {
      userId: cu.id,
      fullName: cu.full_name,
      email: cu.email,
      phone: cu.phone,
      accountType: 'Registered Customer',
      addressCount: customerAddresses.filter(a => Number(a.user_id) === Number(cu.id)).length,
      orderNumbers: [],
      totalSpendPaise: 0
    });
  }
  for (const ord of orders) {
    const em = (ord.customer_email || '').toLowerCase();
    const existing = customerDirectoryMap.get(em) || {
      userId: ord.user_id || null,
      fullName: ord.customer_name,
      email: ord.customer_email,
      phone: ord.customer_phone,
      accountType: ord.user_id ? 'Registered Customer' : 'Guest Checkout',
      addressCount: 1,
      orderNumbers: [],
      totalSpendPaise: 0
    };
    existing.orderNumbers.push(ord.order_number);
    existing.totalSpendPaise += Number(ord.total_paise || 0);
    customerDirectoryMap.set(em, existing);
  }
  const customerDirectoryRows = Array.from(customerDirectoryMap.values());

  const bodyHtml = `
    <section class="sn-section" id="sn-admin-portal">
      <div class="sn-container">
        <!-- Separate Staff Authentication & RBAC Session Bar (Section 5 & Section 10) -->
        <div class="sn-filter-bar" style="background-color:var(--sn-bg-forest);color:#FAF6EE;border-color:var(--sn-bg-forest);margin-bottom:14px;">
          <div>
            <span class="sn-eyebrow" style="color:#E7B971;margin-bottom:2px;">Separate Authenticated Staff Portal • Server-Side RBAC &amp; Write-Only API Vault</span>
            <h1 style="font-family:var(--sn-font-serif);font-size:1.55rem;margin:0;color:#FFFFFF;">Sasya Naturals Operations &amp; Role Management</h1>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <form id="sn-admin-login-form" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
              <input type="email" name="email" id="sn-admin-auth-email" value="${escapeHtml(authenticatedAdmin ? authenticatedAdmin.email : 'superadmin@sasynaturals.com')}" placeholder="Staff Email" class="sn-input" style="width:210px;padding:5px 8px;font-size:0.76rem;" />
              <input type="password" name="password" value="Sasya@2026" placeholder="Password" class="sn-input" style="width:110px;padding:5px 8px;font-size:0.76rem;" />
              <button type="submit" class="sn-btn sn-btn-primary sn-btn-sm">Staff Sign In</button>
              <button type="button" id="sn-admin-logout-btn" class="sn-btn sn-btn-outline sn-btn-sm" style="color:#FFF;border-color:#9BA69D;">Sign Out</button>
            </form>
            <div style="display:flex;align-items:center;gap:6px;">
              <label for="sn-admin-role-switcher" style="font-family:var(--sn-font-mono);font-size:0.74rem;">Role Switcher:</label>
              <select id="sn-admin-role-switcher" class="sn-select" style="width:265px;font-weight:600;padding:5px 8px;font-size:0.78rem;">
                ${staffUsers.map(u => `
                  <option value="${escapeHtml(u.email)}">${escapeHtml(u.role)} - ${escapeHtml(u.full_name)}${u.is_active ? '' : ' (Inactive)'}</option>
                `).join('')}
              </select>
            </div>
          </div>
        </div>

        <!-- Section 8 Operational Admin Alerts Strip (New Orders, Low Stock, Payment/COD Exceptions) -->
        <div class="sn-card" style="background-color:var(--sn-bg-mortar);padding:12px 18px;margin-bottom:18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
          <div style="font-family:var(--sn-font-mono);font-size:0.78rem;display:flex;gap:16px;flex-wrap:wrap;align-items:center;">
            <strong>🔔 Operational Alerts (Section 8):</strong>
            <span class="sn-status sn-status-paid">New / Awaiting Dispatch Orders: ${pendingFulfilmentOrders.length}</span>
            <span class="sn-status ${lowStockVariants.length > 0 ? 'sn-status-danger' : 'sn-status-paid'}">Low-Stock Pack Variants: ${lowStockVariants.length}</span>
            <span class="sn-status ${codPendingPaise > 0 ? 'sn-status-warn' : 'sn-status-paid'}">Uncollected COD / Exceptions: ${formatInr(codPendingPaise)}</span>
          </div>
          <span style="font-family:var(--sn-font-mono);font-size:0.74rem;color:var(--sn-text-muted);">Catalogue: ${categories.length} Categories • ${products.length} Products • ${variants.length} Pack Variants</span>
        </div>

        <div class="sn-kpi-grid">
          <div class="sn-kpi-card">
            <div class="sn-kpi-label">Total Orders</div>
            <div class="sn-kpi-val">${orders.length}</div>
          </div>
          <div class="sn-kpi-card">
            <div class="sn-kpi-label">Settled Revenue</div>
            <div class="sn-kpi-val">${formatInr(totalRevenuePaise)}</div>
          </div>
          <div class="sn-kpi-card">
            <div class="sn-kpi-label">COD Pending Collection</div>
            <div class="sn-kpi-val">${formatInr(codPendingPaise)}</div>
          </div>
          <div class="sn-kpi-card">
            <div class="sn-kpi-label">API Keys Sealed in Vault</div>
            <div class="sn-kpi-val">${configuredVaultCount} / ${vaultStatus.length}</div>
          </div>
          <div class="sn-kpi-card">
            <div class="sn-kpi-label">Low-Stock Alerts</div>
            <div class="sn-kpi-val" style="color:${lowStockVariants.length > 0 ? 'var(--sn-accent-terracotta)' : 'var(--sn-status-paid)'};">${lowStockVariants.length}</div>
          </div>
        </div>

        <div class="sn-admin-grid">
          <aside class="sn-admin-sidebar">
            <div style="font-family:var(--sn-font-mono);font-size:0.73rem;text-transform:uppercase;color:#B8C4BB;">Admin Modules (Section 5.1)</div>
            <ul class="sn-admin-menu">
              <li><button type="button" class="sn-active" data-admin-tab-btn="orders" id="tab-btn-orders">1. Orders &amp; Manual Shipping</button></li>
              <li><button type="button" data-admin-tab-btn="vault" id="tab-btn-vault">2. API &amp; Razorpay Key Vault</button></li>
              <li><button type="button" data-admin-tab-btn="products" id="tab-btn-products">3. Categories, Products &amp; Media</button></li>
              <li><button type="button" data-admin-tab-btn="inventory" id="tab-btn-inventory">4. Inventory &amp; Stock Ledger (${variants.length})</button></li>
              <li><button type="button" data-admin-tab-btn="payments" id="tab-btn-payments">5. Payments, COD &amp; Reports</button></li>
              <li><button type="button" data-admin-tab-btn="customers" id="tab-btn-customers">6. Customers &amp; Order History</button></li>
              <li><button type="button" data-admin-tab-btn="rbac" id="tab-btn-rbac">7. Staff RBAC &amp; Audit Logs</button></li>
              <li><button type="button" data-admin-tab-btn="compliance" id="tab-btn-compliance">8. Shipping, GST, FSSAI &amp; Templates</button></li>
            </ul>
          </aside>

          <div>
            <!-- Panel 1: Orders & Manual Shipping (Includes Manual Shipping Charge Input per Section 5.1 & 7) -->
            <div class="sn-card" data-admin-panel="orders">
              <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Orders &amp; Manual Courier Dispatch Workflow</h2>
              <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0 0 20px;">
                Authorized for <strong>SUPER_ADMIN</strong>, <strong>ORDER_MANAGER</strong>, and permitted <strong>STAFF</strong>. Enter courier company, tracking number, tracking URL, dispatch date, and manual shipping charge.
              </p>
              ${orders.map(o => `
                <div class="sn-card" style="margin-bottom:16px;background-color:var(--sn-bg-parchment);">
                  <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
                    <div>
                      <strong style="font-family:var(--sn-font-mono);font-size:1rem;color:var(--sn-bg-forest);">${escapeHtml(o.order_number)}</strong>
                      <span style="font-size:0.85rem;color:var(--sn-text-secondary);"> • ${escapeHtml(o.customer_name)} (${escapeHtml(o.customer_phone)}) • ${escapeHtml(o.shipping_city)}, ${escapeHtml(o.shipping_state)} (${escapeHtml(o.shipping_pincode)})</span>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                      <span class="sn-status ${o.payment_status === 'PAID' || o.payment_status === 'COD_COLLECTED' ? 'sn-status-paid' : 'sn-status-warn'}">Payment: ${escapeHtml(o.payment_status)}</span>
                      <span class="sn-status sn-status-paid">Fulfilment: ${escapeHtml(o.fulfilment_status)}</span>
                      <strong style="font-family:var(--sn-font-mono);">${formatInr(o.total_paise)}</strong>
                      <a href="${basePath}/orders/${escapeHtml(o.order_number)}/invoice" class="sn-btn sn-btn-outline sn-btn-sm">GST Invoice</a>
                    </div>
                  </div>
                  <form class="sn-admin-ship-form" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(138px,1fr));gap:10px;align-items:end;">
                    <input type="hidden" name="orderNumber" value="${escapeHtml(o.order_number)}" />
                    <div>
                      <label style="font-size:0.74rem;font-weight:600;display:block;">Fulfilment Status</label>
                      <select name="fulfilmentStatus" class="sn-select">
                        ${ORDER_FULFILMENT_STATUSES.map(st => `
                          <option value="${escapeHtml(st)}" ${o.fulfilment_status === st ? 'selected' : ''}>${escapeHtml(st)}</option>
                        `).join('')}
                      </select>
                    </div>
                    <div>
                      <label style="font-size:0.74rem;font-weight:600;display:block;">Courier Company</label>
                      <input type="text" name="courierName" value="${escapeHtml(o.courier_name)}" placeholder="e.g. Blue Dart / Delhivery" class="sn-input" />
                    </div>
                    <div>
                      <label style="font-size:0.74rem;font-weight:600;display:block;">Tracking / AWB No.</label>
                      <input type="text" name="trackingNumber" value="${escapeHtml(o.tracking_number)}" placeholder="e.g. BD804921184IN" class="sn-input" />
                    </div>
                    <div>
                      <label style="font-size:0.74rem;font-weight:600;display:block;">Tracking URL</label>
                      <input type="text" name="trackingUrl" value="${escapeHtml(o.tracking_url)}" placeholder="https://..." class="sn-input" />
                    </div>
                    <div>
                      <label style="font-size:0.74rem;font-weight:600;display:block;">Dispatch Date</label>
                      <input type="date" name="dispatchDate" value="${escapeHtml(o.dispatch_date || '2026-11-21')}" class="sn-input" />
                    </div>
                    <div>
                      <label style="font-size:0.74rem;font-weight:600;display:block;">Shipping Charge (₹)</label>
                      <input type="number" name="manualShippingChargeInr" value="${Math.round((o.manual_shipping_charge_paise || o.shipping_paise || 0) / 100)}" min="0" class="sn-input" />
                    </div>
                    <button type="submit" class="sn-btn sn-btn-forest sn-btn-sm">Save &amp; Notify</button>
                  </form>
                </div>
              `).join('')}
            </div>

            <!-- Panel 2: Write-Only API & Razorpay Credential Vault -->
            <div class="sn-card" data-admin-panel="vault" style="display:none;">
              <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Write-Only AES-256-GCM API &amp; Payment Credential Vault</h2>
              <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0 0 20px;">
                Strictly restricted to <strong>SUPER_ADMIN</strong>. Paste your Razorpay, SMTP, or WhatsApp OTP API keys once. Once added, the key is encrypted with AES-256-GCM and <strong>permanently hidden from the console</strong>.
              </p>
              <div style="display:flex;flex-direction:column;gap:14px;">
                ${vaultStatus.map(v => `
                  <div class="sn-card" style="background-color:var(--sn-bg-parchment);padding:16px 20px;" data-vault-item="${escapeHtml(v.key_name)}">
                    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
                      <div>
                        <span class="sn-eyebrow" style="margin:0;">${escapeHtml(v.provider_group)}</span>
                        <h3 style="font-family:var(--sn-font-mono);font-size:0.95rem;margin:2px 0;color:var(--sn-bg-forest);">${escapeHtml(v.key_name)}</h3>
                        <div style="font-size:0.82rem;color:var(--sn-text-secondary);">${escapeHtml(v.label)}</div>
                      </div>
                      <div>
                        ${v.is_configured ? `
                          <span class="sn-status sn-status-paid">🔒 Sealed &amp; Hidden: ${escapeHtml(v.masked_hint)}</span>
                          <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-vault-rotate-btn="${escapeHtml(v.key_name)}" style="margin-left:8px;">Rotate Key</button>
                        ` : `
                          <span class="sn-status sn-status-warn">Sandbox Fallback Active (Not Configured)</span>
                        `}
                      </div>
                    </div>

                    <form class="sn-admin-vault-form" data-vault-form="${escapeHtml(v.key_name)}" style="display:${v.is_configured ? 'none' : 'flex'};gap:10px;margin-top:12px;align-items:center;">
                      <input type="hidden" name="keyName" value="${escapeHtml(v.key_name)}" />
                      <input type="password" name="secretValue" required minlength="6" placeholder="Paste live ${escapeHtml(v.key_name)} here (will be encrypted &amp; hidden immediately)" class="sn-input" style="font-family:var(--sn-font-mono);" />
                      <button type="submit" class="sn-btn sn-btn-primary sn-btn-sm" style="white-space:nowrap;">Seal &amp; Hide Key</button>
                    </form>
                  </div>
                `).join('')}
              </div>
            </div>

            <!-- Panel 3: Categories, Products, Edit/Publish/Deactivate & Media Manager -->
            <div class="sn-card" data-admin-panel="products" style="display:none;">
              <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Categories, Products, Pack Variants &amp; Media Manager</h2>
              <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0 0 18px;">
                Authorized for <strong>SUPER_ADMIN</strong> and <strong>PRODUCT_MANAGER</strong>. Create, edit, publish/deactivate categories and products, update pack prices, and upload magic-byte verified images.
              </p>

              <!-- 3A. Create New Category + Category Image & Status Manager -->
              <div class="sn-card" style="background-color:var(--sn-bg-parchment);margin-bottom:24px;">
                <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;font-size:1.1rem;color:var(--sn-bg-forest);">1. Add New Product Category (with Category Banner Photo)</h3>
                <form id="sn-admin-create-category-form" style="margin-bottom:18px;">
                  <div style="display:grid;grid-template-columns:1fr 1.2fr 1.4fr;gap:12px;margin-bottom:12px;">
                    <div>
                      <label style="font-size:0.75rem;font-weight:600;">Category Name *</label>
                      <input type="text" name="name" required placeholder="e.g. Cold-Pressed Oils &amp; Ghee" class="sn-input" />
                    </div>
                    <div>
                      <label style="font-size:0.75rem;font-weight:600;">Subtitle / Eyebrow *</label>
                      <input type="text" name="subtitle" required placeholder="e.g. Wood-Pressed Wooden Ghani Oils &amp; A2 Ghee" class="sn-input" />
                    </div>
                    <div>
                      <label style="font-size:0.75rem;font-weight:600;">Category Banner Image (JPEG/PNG/WebP)</label>
                      <input type="file" name="categoryImageFile" accept="image/jpeg,image/png,image/webp" class="sn-input" style="padding:6px;" />
                    </div>
                  </div>
                  <div style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:end;">
                    <div>
                      <label style="font-size:0.75rem;font-weight:600;">Category Description (Humanizer-Checked) *</label>
                      <input type="text" name="description" required placeholder="e.g. Traditional wood-pressed groundnut, sesame, and coconut oils extracted at room temperature." class="sn-input" />
                    </div>
                    <button type="submit" class="sn-btn sn-btn-primary">Create Category</button>
                  </div>
                </form>

                <h4 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1rem;color:var(--sn-bg-forest);">Existing Categories, Publish Status &amp; Category Image Updater</h4>
                <div class="sn-table-wrap">
                  <table class="sn-table" id="sn-admin-categories-table">
                    <thead>
                      <tr><th>Photo</th><th>Category Name &amp; Slug</th><th>Subtitle</th><th>Status</th><th>Change Category Image</th></tr>
                    </thead>
                    <tbody>
                      ${categories.map(c => `
                        <tr>
                          <td>
                            <img src="${basePath}${escapeHtml(c.image_url)}" alt="${escapeHtml(c.name)}" data-category-img-id="${c.id}" style="width:68px;height:48px;object-fit:cover;border-radius:6px;border:1px solid var(--sn-border-strong);" />
                          </td>
                          <td>
                            <strong><a href="${basePath}/category/${escapeHtml(c.slug)}">${escapeHtml(c.name)}</a></strong><br/>
                            <span style="font-family:var(--sn-font-mono);font-size:0.73rem;color:var(--sn-text-muted);">/category/${escapeHtml(c.slug)}</span>
                          </td>
                          <td style="font-size:0.82rem;">${escapeHtml(c.subtitle)}</td>
                          <td>
                            <button
                              type="button"
                              class="sn-btn ${c.is_active ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm"
                              data-toggle-cat-id="${c.id}"
                              data-toggle-cat-active="${c.is_active ? '1' : '0'}"
                            >${c.is_active ? 'Published (Active)' : 'Deactivated'}</button>
                          </td>
                          <td>
                            <form class="sn-admin-cat-img-form" style="display:flex;gap:8px;align-items:center;">
                              <input type="hidden" name="categoryId" value="${c.id}" />
                              <input type="file" name="imageFile" accept="image/jpeg,image/png,image/webp" required class="sn-input" style="padding:4px;font-size:0.75rem;max-width:210px;" />
                              <button type="submit" class="sn-btn sn-btn-forest sn-btn-sm">Update Photo</button>
                            </form>
                          </td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
              </div>

              <!-- 3B. Dedicated Product Image Uploader (Primary Photo or Secondary Gallery) -->
              <form id="sn-admin-image-upload-form" class="sn-card" style="background-color:var(--sn-bg-mortar);margin-bottom:20px;">
                <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1.05rem;">2. Change Product Photo or Add FSSAI Nutrition Label to Gallery (JPEG/PNG/WebP &le; 5 MB)</h3>
                <div style="display:grid;grid-template-columns:1.2fr 1.1fr 1.1fr 1fr auto;gap:10px;align-items:end;">
                  <div>
                    <label style="font-size:0.75rem;font-weight:600;">Select Product *</label>
                    <select name="productId" class="sn-select" id="sn-upload-prod-select">
                      ${products.map(p => `<option value="${p.id}">${escapeHtml(p.sku_base)} - ${escapeHtml(p.name)}</option>`).join('')}
                    </select>
                  </div>
                  <div>
                    <label style="font-size:0.75rem;font-weight:600;">Photo Target Role *</label>
                    <select name="setAsPrimary" class="sn-select">
                      <option value="true" selected>Replace Primary Storefront Photo</option>
                      <option value="false">Add to Secondary Gallery (Back Label)</option>
                    </select>
                  </div>
                  <div>
                    <label style="font-size:0.75rem;font-weight:600;">Image File (Magic-Byte Checked) *</label>
                    <input type="file" name="imageFile" accept="image/jpeg,image/png,image/webp" required class="sn-input" style="padding:6px;" />
                  </div>
                  <div>
                    <label style="font-size:0.75rem;font-weight:600;">Image Caption</label>
                    <input type="text" name="caption" value="Front Pack / FSSAI Nutrition Label" class="sn-input" />
                  </div>
                  <button type="submit" class="sn-btn sn-btn-forest">Save Product Photo</button>
                </div>
              </form>

              <!-- 3C. Add New Product (with Initial Product Photo) -->
              <form id="sn-admin-create-product-form" class="sn-card" style="background-color:var(--sn-bg-parchment);margin-bottom:20px;">
                <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;font-size:1.1rem;">3. Add New Product (with Photo &amp; Auto-Generated 100 g, 250 g, 500 g, 1 kg Variants)</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;">
                  <div>
                    <label style="font-size:0.75rem;font-weight:600;">Product Name *</label>
                    <input type="text" name="name" required placeholder="e.g. Guntur Cold-Milled Cumin Powder" class="sn-input" />
                  </div>
                  <div>
                    <label style="font-size:0.75rem;font-weight:600;">SKU Prefix *</label>
                    <input type="text" name="skuBase" required placeholder="e.g. SN-SP-CMN" class="sn-input" />
                  </div>
                  <div>
                    <label style="font-size:0.75rem;font-weight:600;">Category *</label>
                    <select name="categoryId" class="sn-select" id="sn-create-prod-cat-select">
                      ${categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
                    </select>
                  </div>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1.2fr;gap:12px;margin-bottom:12px;">
                  <div>
                    <label style="font-size:0.75rem;font-weight:600;">100g Base Selling Price (INR) *</label>
                    <input type="number" name="base100gInr" required value="140" class="sn-input" />
                  </div>
                  <div>
                    <label style="font-size:0.75rem;font-weight:600;">GST Slab (%) *</label>
                    <select name="gstPercent" class="sn-select">
                      <option value="5">5% GST (Natural Staples)</option>
                      <option value="12">12% GST (Processed / Blended)</option>
                    </select>
                  </div>
                  <div>
                    <label style="font-size:0.75rem;font-weight:600;">Growing Region *</label>
                    <input type="text" name="originRegion" required value="Unjha &amp; Guntur Belt" class="sn-input" />
                  </div>
                  <div>
                    <label style="font-size:0.75rem;font-weight:600;">Product Photo (JPEG/PNG/WebP)</label>
                    <input type="file" name="productImageFile" accept="image/jpeg,image/png,image/webp" class="sn-input" style="padding:6px;" />
                  </div>
                </div>
                <div style="margin-bottom:12px;">
                  <label style="font-size:0.75rem;font-weight:600;">Short Description (Humanizer-Checked) *</label>
                  <input type="text" name="shortDescription" required value="Aromatic whole cumin seeds stone-ground in small batches without filler husk." class="sn-input" />
                </div>
                <button type="submit" class="sn-btn sn-btn-primary">Create Product &amp; 4 Pack Variants</button>
              </form>

              <!-- 3D. Edit Existing Product, Prices, Flags & Publish/Deactivate (Section 3.2, 5.1 & 14) -->
              <form id="sn-admin-edit-product-form" class="sn-card" style="background-color:var(--sn-bg-mortar);margin-bottom:24px;">
                <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1.05rem;">4. Edit Existing Product Details, Pack Prices, Flags &amp; Publish / Deactivate Status</h3>
                <div style="display:grid;grid-template-columns:1.5fr 1fr 0.8fr 0.8fr 0.8fr;gap:10px;margin-bottom:10px;">
                  <div>
                    <label style="font-size:0.74rem;font-weight:600;">Select Product to Edit *</label>
                    <select name="productId" class="sn-select" id="sn-edit-prod-select">
                      ${products.map(p => `<option value="${p.id}">${escapeHtml(p.sku_base)} - ${escapeHtml(p.name)} (${p.is_active ? 'Active' : 'Inactive'})</option>`).join('')}
                    </select>
                  </div>
                  <div>
                    <label style="font-size:0.74rem;font-weight:600;">New Product Title (Optional)</label>
                    <input type="text" name="name" placeholder="Leave blank to keep current title" class="sn-input" />
                  </div>
                  <div>
                    <label style="font-size:0.74rem;font-weight:600;">100g Selling Price (₹)</label>
                    <input type="number" name="base100gSellInr" min="10" placeholder="e.g. 310" class="sn-input" />
                  </div>
                  <div>
                    <label style="font-size:0.74rem;font-weight:600;">100g MRP (₹)</label>
                    <input type="number" name="base100gMrpInr" min="10" placeholder="e.g. 360" class="sn-input" />
                  </div>
                  <div>
                    <label style="font-size:0.74rem;font-weight:600;">GST % / HSN</label>
                    <div style="display:flex;gap:4px;">
                      <select name="gstPercent" class="sn-select" style="width:72px;">
                        <option value="">Keep</option>
                        <option value="5">5%</option>
                        <option value="12">12%</option>
                      </select>
                      <input type="text" name="hsnCode" placeholder="HSN" class="sn-input" style="width:82px;" />
                    </div>
                  </div>
                </div>
                <div style="display:grid;grid-template-columns:1.4fr 0.9fr 0.9fr 0.9fr 1fr auto;gap:10px;align-items:end;">
                  <div>
                    <label style="font-size:0.74rem;font-weight:600;">Updated Short Description (Optional)</label>
                    <input type="text" name="shortDescription" placeholder="Leave blank to keep current description" class="sn-input" />
                  </div>
                  <div>
                    <label style="font-size:0.74rem;font-weight:600;">Featured Flag</label>
                    <select name="isFeatured" class="sn-select">
                      <option value="">Keep Current</option>
                      <option value="1">Featured: Yes</option>
                      <option value="0">Featured: No</option>
                    </select>
                  </div>
                  <div>
                    <label style="font-size:0.74rem;font-weight:600;">Bestseller Flag</label>
                    <select name="isBestseller" class="sn-select">
                      <option value="">Keep Current</option>
                      <option value="1">Bestseller: Yes</option>
                      <option value="0">Bestseller: No</option>
                    </select>
                  </div>
                  <div>
                    <label style="font-size:0.74rem;font-weight:600;">New Harvest Flag</label>
                    <select name="isNewArrival" class="sn-select">
                      <option value="">Keep Current</option>
                      <option value="1">New Harvest: Yes</option>
                      <option value="0">New Harvest: No</option>
                    </select>
                  </div>
                  <div>
                    <label style="font-size:0.74rem;font-weight:600;">Storefront Status</label>
                    <select name="isActive" class="sn-select">
                      <option value="1">Published (Active)</option>
                      <option value="0">Deactivated (Hidden)</option>
                    </select>
                  </div>
                  <button type="submit" class="sn-btn sn-btn-forest">Save Product Edits</button>
                </div>
              </form>

              <div class="sn-table-wrap">
                <table class="sn-table">
                  <thead>
                    <tr><th>Photo</th><th>SKU, HSN &amp; Flags</th><th>Product Name &amp; Origin</th><th>Pack Variants (100g / 250g / 500g / 1kg)</th><th>Status</th><th>Quick Change Photo</th></tr>
                  </thead>
                  <tbody>
                    ${products.map(p => {
                      const pVars = variants.filter(v => v.product_id === p.id);
                      return `
                        <tr data-admin-prod-row="${p.id}">
                          <td>
                            <img src="${basePath}${escapeHtml(p.image_url)}" alt="${escapeHtml(p.name)}" data-product-img-id="${p.id}" style="width:52px;height:52px;object-fit:cover;border-radius:6px;border:1px solid var(--sn-border-strong);" />
                          </td>
                          <td style="font-family:var(--sn-font-mono);font-size:0.75rem;">
                            <strong>${escapeHtml(p.sku_base)}</strong><br/>
                            HSN: ${escapeHtml(p.hsn_code || '080290')} (${p.gst_percent}% GST)<br/>
                            ${p.is_featured ? '<span class="sn-status sn-status-paid" style="font-size:0.65rem;padding:1px 5px;">Featured</span> ' : ''}
                            ${p.is_bestseller ? '<span class="sn-status sn-status-warn" style="font-size:0.65rem;padding:1px 5px;">Bestseller</span> ' : ''}
                            ${p.is_new_arrival ? '<span class="sn-status sn-status-paid" style="font-size:0.65rem;padding:1px 5px;">New</span>' : ''}
                          </td>
                          <td>
                            <strong><a href="${basePath}/product/${escapeHtml(p.slug)}">${escapeHtml(p.name)}</a></strong><br/>
                            <span style="font-size:0.76rem;color:var(--sn-text-muted);">${escapeHtml(p.origin_region)} • ${escapeHtml(p.harvest_batch)}</span>
                          </td>
                          <td style="font-family:var(--sn-font-mono);font-size:0.73rem;">
                            ${pVars.map(v => `${escapeHtml(v.pack_label)}: ${formatInr(v.selling_price_paise)} (${v.stock_qty})`).join(' | ')}
                          </td>
                          <td>
                            <button
                              type="button"
                              class="sn-btn ${p.is_active ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm"
                              data-toggle-prod-id="${p.id}"
                              data-toggle-prod-active="${p.is_active ? '1' : '0'}"
                            >${p.is_active ? 'Active' : 'Inactive'}</button>
                          </td>
                          <td>
                            <form class="sn-admin-inline-prod-img-form" style="display:flex;gap:6px;align-items:center;">
                              <input type="hidden" name="productId" value="${p.id}" />
                              <input type="file" name="imageFile" accept="image/jpeg,image/png,image/webp" required class="sn-input" style="padding:3px;font-size:0.72rem;max-width:165px;" />
                              <button type="submit" class="sn-btn sn-btn-outline sn-btn-sm">Change</button>
                            </form>
                          </td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>
              </div>
            </div>

            <!-- Panel 4: Complete Inventory & Stock Movements (All 88 Pack Variants + Low-Stock Threshold Editor) -->
            <div class="sn-card" data-admin-panel="inventory" style="display:none;">
              <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:14px;">
                <div>
                  <h2 style="font-family:var(--sn-font-serif);margin:0 0 4px;color:var(--sn-bg-forest);">Inventory Control &amp; Atomic Stock Movement Ledger (All ${variants.length} Pack Variants)</h2>
                  <p style="font-size:0.84rem;color:var(--sn-text-secondary);margin:0;">
                    Stock is automatically decremented on order confirmation and restored on order cancellation or refund.
                  </p>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                  <input type="search" id="sn-admin-inv-search" placeholder="Search SKU or pack size..." class="sn-input" style="width:220px;" />
                  <label style="font-size:0.78rem;display:flex;align-items:center;gap:4px;cursor:pointer;">
                    <input type="checkbox" id="sn-admin-inv-low-only" /> Low-Stock Only
                  </label>
                </div>
              </div>

              <div class="sn-table-wrap" style="margin-bottom:24px;max-height:540px;overflow-y:auto;">
                <table class="sn-table" id="sn-admin-inventory-table">
                  <thead>
                    <tr><th>Variant SKU</th><th>Pack Size</th><th>Selling Price</th><th>MRP</th><th>Current Stock</th><th>Alert Threshold</th><th>Update Stock &amp; Threshold</th></tr>
                  </thead>
                  <tbody>
                    ${variants.map(v => `
                      <tr data-inv-sku="${escapeHtml(v.sku.toLowerCase())}" data-inv-low="${v.stock_qty <= v.low_stock_threshold ? '1' : '0'}">
                        <td style="font-family:var(--sn-font-mono);font-weight:600;">${escapeHtml(v.sku)}</td>
                        <td style="font-family:var(--sn-font-mono);">${escapeHtml(v.pack_label)}</td>
                        <td style="font-family:var(--sn-font-mono);">${formatInr(v.selling_price_paise)}</td>
                        <td style="font-family:var(--sn-font-mono);color:var(--sn-text-muted);">${formatInr(v.mrp_paise)}</td>
                        <td><span class="sn-status ${v.stock_qty <= v.low_stock_threshold ? 'sn-status-danger' : 'sn-status-paid'}">${v.stock_qty} packs</span></td>
                        <td style="font-family:var(--sn-font-mono);">le; ${v.low_stock_threshold}</td>
                        <td>
                          <form class="sn-admin-stock-form" style="display:flex;gap:6px;align-items:center;">
                            <input type="hidden" name="variantId" value="${v.id}" />
                            <input type="number" name="newStockQty" value="${v.stock_qty}" min="0" title="New Stock Quantity" class="sn-input" style="width:74px;padding:4px 6px;" />
                            <input type="number" name="lowStockThreshold" value="${v.low_stock_threshold}" min="1" title="Low-Stock Alert Threshold" class="sn-input" style="width:62px;padding:4px 6px;" />
                            <button type="submit" class="sn-btn sn-btn-outline sn-btn-sm">Update</button>
                          </form>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>

              <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1.1rem;">Recent Stock Movements Ledger</h3>
              <div class="sn-table-wrap">
                <table class="sn-table">
                  <thead>
                    <tr><th>Timestamp</th><th>Variant ID</th><th>Delta</th><th>Prev -> New</th><th>Reason</th><th>Reference</th></tr>
                  </thead>
                  <tbody>
                    ${movements.map(m => `
                      <tr>
                        <td style="font-family:var(--sn-font-mono);font-size:0.75rem;">${escapeHtml(m.created_at)}</td>
                        <td style="font-family:var(--sn-font-mono);">#${m.variant_id}</td>
                        <td style="font-family:var(--sn-font-mono);color:${m.delta_qty < 0 ? 'var(--sn-status-danger)' : 'var(--sn-status-paid)'};">${m.delta_qty > 0 ? '+' + m.delta_qty : m.delta_qty}</td>
                        <td style="font-family:var(--sn-font-mono);">${m.previous_qty} -> ${m.new_qty}</td>
                        <td>${escapeHtml(m.reason)}</td>
                        <td style="font-family:var(--sn-font-mono);">${escapeHtml(m.reference_id)}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>

            <!-- Panel 5: Payments, COD Settlement, Refunds & Sales/Product Reports (Section 5.1 & Section 6) -->
            <div class="sn-card" data-admin-panel="payments" style="display:none;">
              <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Payment Gateway Reconciliation, COD Collections, Refunds &amp; Reports</h2>
              <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0 0 18px;">
                Authorized for <strong>SUPER_ADMIN</strong> and <strong>ACCOUNTS_MANAGER</strong>. Record COD collections, initiate/record refunds (with automatic stock restoration), and review sales reports.
              </p>

              <div class="sn-table-wrap" style="margin-bottom:26px;">
                <table class="sn-table">
                  <thead>
                    <tr><th>Order No.</th><th>Provider &amp; Method</th><th>Gateway Order / Payment ID</th><th>Amount</th><th>Status</th><th>Server Verified</th><th>Accounts Manager Actions</th></tr>
                  </thead>
                  <tbody>
                    ${payments.map(pay => `
                      <tr>
                        <td style="font-family:var(--sn-font-mono);font-weight:600;">${escapeHtml(pay.order_number)}</td>
                        <td>${escapeHtml(pay.gateway_provider)} (${escapeHtml(pay.method)})</td>
                        <td style="font-family:var(--sn-font-mono);font-size:0.74rem;">
                          Ord: ${escapeHtml(pay.gateway_order_id)}<br/>
                          Pay: ${escapeHtml(pay.gateway_payment_id || 'COD / Pending')}
                        </td>
                        <td style="font-family:var(--sn-font-mono);font-weight:600;">${formatInr(pay.amount_paise)}</td>
                        <td><span class="sn-status ${pay.status === 'PAID' || pay.status === 'COD_COLLECTED' ? 'sn-status-paid' : 'sn-status-warn'}">${escapeHtml(pay.status)}</span></td>
                        <td style="font-family:var(--sn-font-mono);">${pay.verified_on_server ? '✓ Verified' : 'Pending'}</td>
                        <td>
                          <div style="display:flex;gap:6px;flex-wrap:wrap;">
                            ${pay.status === 'COD_PENDING' ? `
                              <button type="button" class="sn-btn sn-btn-forest sn-btn-sm" data-payment-action="MARK_COD_COLLECTED" data-order-number="${escapeHtml(pay.order_number)}">Mark COD Collected</button>
                            ` : ''}
                            ${pay.status !== 'REFUNDED' ? `
                              <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-payment-action="RECORD_REFUND" data-order-number="${escapeHtml(pay.order_number)}">Record Refund</button>
                            ` : `<span style="font-family:var(--sn-font-mono);font-size:0.72rem;color:var(--sn-text-muted);">Refunded (${formatInr(pay.refund_amount_paise || pay.amount_paise)})</span>`}
                          </div>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>

              <!-- Section 5.1 Daily, Weekly, Monthly Sales & Tax Summary Report -->
              <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1.15rem;color:var(--sn-bg-forest);">Sales, Tax &amp; Settlement Summary Report (Daily / Weekly / Monthly)</h3>
              <div class="sn-table-wrap" style="margin-bottom:26px;">
                <table class="sn-table">
                  <thead>
                    <tr><th>Reporting Period</th><th>Orders Count</th><th>Settled Prepaid + COD</th><th>COD Pending Collection</th><th>Refunds Issued</th><th>Included GST Collected</th></tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><strong>Today (Daily Snapshot)</strong></td>
                      <td style="font-family:var(--sn-font-mono);">${orders.length}</td>
                      <td style="font-family:var(--sn-font-mono);font-weight:700;color:var(--sn-status-paid);">${formatInr(totalRevenuePaise)}</td>
                      <td style="font-family:var(--sn-font-mono);">${formatInr(codPendingPaise)}</td>
                      <td style="font-family:var(--sn-font-mono);">${formatInr(refundedPaise)}</td>
                      <td style="font-family:var(--sn-font-mono);">${formatInr(totalGstPaise)}</td>
                    </tr>
                    <tr>
                      <td><strong>Last 7 Days (Weekly Rollup)</strong></td>
                      <td style="font-family:var(--sn-font-mono);">${orders.length}</td>
                      <td style="font-family:var(--sn-font-mono);font-weight:700;color:var(--sn-status-paid);">${formatInr(totalRevenuePaise)}</td>
                      <td style="font-family:var(--sn-font-mono);">${formatInr(codPendingPaise)}</td>
                      <td style="font-family:var(--sn-font-mono);">${formatInr(refundedPaise)}</td>
                      <td style="font-family:var(--sn-font-mono);">${formatInr(totalGstPaise)}</td>
                    </tr>
                    <tr>
                      <td><strong>Current Month (Nov 2026 MTD)</strong></td>
                      <td style="font-family:var(--sn-font-mono);">${orders.length}</td>
                      <td style="font-family:var(--sn-font-mono);font-weight:700;color:var(--sn-status-paid);">${formatInr(totalRevenuePaise)}</td>
                      <td style="font-family:var(--sn-font-mono);">${formatInr(codPendingPaise)}</td>
                      <td style="font-family:var(--sn-font-mono);">${formatInr(refundedPaise)}</td>
                      <td style="font-family:var(--sn-font-mono);">${formatInr(totalGstPaise)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- Section 5.1 Product-Wise Sales Report -->
              <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1.15rem;color:var(--sn-bg-forest);">Product-Wise Sales &amp; Volume Report</h3>
              <div class="sn-table-wrap">
                <table class="sn-table">
                  <thead>
                    <tr><th>SKU Prefix</th><th>Product Name</th><th>Packs Sold</th><th>Total Weight Sold</th><th>Gross Product Revenue</th></tr>
                  </thead>
                  <tbody>
                    ${productSalesRows.slice(0, 12).map(r => `
                      <tr>
                        <td style="font-family:var(--sn-font-mono);">${escapeHtml(r.skuBase)}</td>
                        <td><strong>${escapeHtml(r.name)}</strong></td>
                        <td style="font-family:var(--sn-font-mono);">${r.unitsSold} packs</td>
                        <td style="font-family:var(--sn-font-mono);">${r.gramsSold} g</td>
                        <td style="font-family:var(--sn-font-mono);font-weight:600;">${formatInr(r.revenuePaise)}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>

            <!-- Panel 6: Customers Directory & Order History (Section 5.1 Customers Module) -->
            <div class="sn-card" data-admin-panel="customers" style="display:none;">
              <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Customer Profiles, Saved Addresses &amp; Order History</h2>
              <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0 0 18px;">
                Authorized for <strong>SUPER_ADMIN</strong> and <strong>ORDER_MANAGER</strong>. View registered customer accounts and guest buyers with their order history.
              </p>
              <div class="sn-table-wrap">
                <table class="sn-table">
                  <thead>
                    <tr><th>Customer Name</th><th>Email &amp; Phone</th><th>Account Type</th><th>Saved Addresses</th><th>Order History</th><th>Lifetime Spend</th></tr>
                  </thead>
                  <tbody>
                    ${customerDirectoryRows.map(c => `
                      <tr>
                        <td><strong>${escapeHtml(c.fullName)}</strong></td>
                        <td style="font-family:var(--sn-font-mono);font-size:0.76rem;">
                          ${escapeHtml(c.email)}<br/>
                          ${escapeHtml(c.phone)}
                        </td>
                        <td><span class="sn-status sn-status-paid">${escapeHtml(c.accountType)}</span></td>
                        <td style="font-family:var(--sn-font-mono);">${c.addressCount} saved</td>
                        <td style="font-family:var(--sn-font-mono);font-size:0.78rem;">
                          ${c.orderNumbers.length > 0
                            ? c.orderNumbers.map(on => `<a href="${basePath}/track-order?order=${encodeURIComponent(on)}" style="color:var(--sn-accent-terracotta);font-weight:600;">${escapeHtml(on)}</a>`).join(', ')
                            : 'No orders yet'}
                        </td>
                        <td style="font-family:var(--sn-font-mono);font-weight:700;">${formatInr(c.totalSpendPaise)}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>

            <!-- Panel 7: Staff RBAC Management (Invite/Create, Assign Roles/Permissions, Deactivate) & Audit Logs -->
            <div class="sn-card" data-admin-panel="rbac" style="display:none;">
              <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">5-Role Staff RBAC Management &amp; Immutable Audit Logs</h2>
              <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0 0 18px;">
                Restricted to <strong>SUPER_ADMIN</strong>. Invite new staff accounts, assign roles or granular <strong>STAFF</strong> action permissions, and deactivate/reactivate access.
              </p>

              <form id="sn-admin-create-staff-form" class="sn-card" style="background-color:var(--sn-bg-parchment);margin-bottom:24px;">
                <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;font-size:1.05rem;color:var(--sn-bg-forest);">Invite / Create Individual Staff Account (Section 5 &amp; 5.1)</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr 0.9fr 0.9fr 1fr;gap:10px;margin-bottom:10px;">
                  <div>
                    <label style="font-size:0.74rem;font-weight:600;">Full Name *</label>
                    <input type="text" name="fullName" required placeholder="e.g. Deepak Hegde" class="sn-input" />
                  </div>
                  <div>
                    <label style="font-size:0.74rem;font-weight:600;">Staff Email *</label>
                    <input type="email" name="email" required placeholder="deepak@sasynaturals.com" class="sn-input" />
                  </div>
                  <div>
                    <label style="font-size:0.74rem;font-weight:600;">Phone *</label>
                    <input type="tel" name="phone" required placeholder="+91 98100 10009" class="sn-input" />
                  </div>
                  <div>
                    <label style="font-size:0.74rem;font-weight:600;">Temporary Password *</label>
                    <input type="password" name="password" required value="Sasya@2026" class="sn-input" />
                  </div>
                  <div>
                    <label style="font-size:0.74rem;font-weight:600;">Assigned Role *</label>
                    <select name="role" class="sn-select">
                      <option value="STAFF">STAFF (Custom Assigned Permissions)</option>
                      <option value="PRODUCT_MANAGER">PRODUCT_MANAGER</option>
                      <option value="ORDER_MANAGER">ORDER_MANAGER</option>
                      <option value="ACCOUNTS_MANAGER">ACCOUNTS_MANAGER</option>
                      <option value="SUPER_ADMIN">SUPER_ADMIN</option>
                    </select>
                  </div>
                </div>
                <div style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:end;">
                  <div>
                    <label style="font-size:0.74rem;font-weight:600;">Explicit Action Permissions (Comma-separated for STAFF role)</label>
                    <input type="text" name="permissionsCsv" value="orders.view, shipping.update, inventory.view" class="sn-input" style="font-family:var(--sn-font-mono);font-size:0.78rem;" />
                  </div>
                  <button type="submit" class="sn-btn sn-btn-primary">Create Staff User</button>
                </div>
              </form>

              <div class="sn-table-wrap" style="margin-bottom:24px;">
                <table class="sn-table" id="sn-admin-staff-table">
                  <thead>
                    <tr><th>Staff Name &amp; Email</th><th>Current Role</th><th>Permitted Actions</th><th>Status</th><th>Update Role, Permissions &amp; Access</th></tr>
                  </thead>
                  <tbody>
                    ${staffUsers.map(u => `
                      <tr>
                        <td>
                          <strong>${escapeHtml(u.full_name)}</strong><br/>
                          <span style="font-family:var(--sn-font-mono);font-size:0.75rem;color:var(--sn-text-muted);">${escapeHtml(u.email)}</span>
                        </td>
                        <td><span class="sn-status sn-status-paid">${escapeHtml(u.role)}</span></td>
                        <td style="font-family:var(--sn-font-mono);font-size:0.74rem;">${escapeHtml(u.permissions_json)}</td>
                        <td><span class="sn-status ${u.is_active ? 'sn-status-paid' : 'sn-status-danger'}">${u.is_active ? 'Active' : 'Deactivated'}</span></td>
                        <td>
                          <form class="sn-admin-staff-update-form" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                            <input type="hidden" name="userId" value="${u.id}" />
                            <select name="role" class="sn-select" style="width:155px;padding:4px;font-size:0.75rem;">
                              ${['SUPER_ADMIN', 'PRODUCT_MANAGER', 'ORDER_MANAGER', 'ACCOUNTS_MANAGER', 'STAFF'].map(r => `
                                <option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>
                              `).join('')}
                            </select>
                            <input type="text" name="permissionsJson" value="${escapeHtml(u.permissions_json)}" class="sn-input" style="width:170px;padding:4px 6px;font-family:var(--sn-font-mono);font-size:0.73rem;" />
                            <select name="isActive" class="sn-select" style="width:105px;padding:4px;font-size:0.75rem;">
                              <option value="1" ${u.is_active ? 'selected' : ''}>Active</option>
                              <option value="0" ${!u.is_active ? 'selected' : ''}>Deactivate</option>
                            </select>
                            <button type="submit" class="sn-btn sn-btn-outline sn-btn-sm">Save</button>
                          </form>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>

              <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1.1rem;">Immutable Admin Audit Logs (Section 10)</h3>
              <div class="sn-table-wrap">
                <table class="sn-table">
                  <thead>
                    <tr><th>Timestamp</th><th>Actor Email</th><th>Role</th><th>Action</th><th>Entity</th><th>Details</th></tr>
                  </thead>
                  <tbody>
                    ${auditLogs.map(log => `
                      <tr>
                        <td style="font-family:var(--sn-font-mono);font-size:0.74rem;">${escapeHtml(log.created_at)}</td>
                        <td style="font-family:var(--sn-font-mono);">${escapeHtml(log.actor_email)}</td>
                        <td><span class="sn-status sn-status-warn">${escapeHtml(log.actor_role)}</span></td>
                        <td style="font-family:var(--sn-font-mono);font-weight:600;">${escapeHtml(log.action)}</td>
                        <td style="font-family:var(--sn-font-mono);">${escapeHtml(log.entity_type)}:${escapeHtml(log.entity_id)}</td>
                        <td style="font-family:var(--sn-font-mono);font-size:0.74rem;">${escapeHtml(log.details_json)}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>

            <!-- Panel 8: Delivery Pricing, Editable GST/FSSAI Business Compliance & Editable Notification Templates -->
            <div class="sn-card" data-admin-panel="compliance" style="display:none;">
              <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Delivery Pricing Engine, GST/FSSAI Compliance &amp; Notification Templates</h2>
              <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0 0 18px;">
                Restricted to <strong>SUPER_ADMIN</strong>. Configure 4-Zone + 500g Weight-Slab shipping rules, update legal GSTIN/FSSAI business details (Section 11), and edit email/SMS notification templates (Section 8).
              </p>

              ${(() => {
                const sMap = Object.fromEntries(settings.map(s => [s.key, s.value]));
                const curMode = sMap.shipping_free_mode || 'THRESHOLD_WITH_WEIGHT_CAP';
                return `
                  <form id="sn-admin-shipping-policy-form" class="sn-card" style="background-color:var(--sn-bg-parchment);margin-bottom:24px;">
                    <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;font-size:1.05rem;color:var(--sn-bg-forest);">1. Delivery Pricing Engine (4-Zone + 500g Weight Slabs + Free-Delivery Control)</h3>
                    <div style="display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:12px;margin-bottom:14px;">
                      <div>
                        <label style="font-size:0.76rem;font-weight:700;display:block;margin-bottom:4px;">Free-Delivery Policy Mode *</label>
                        <select name="shipping_free_mode" class="sn-select" style="font-weight:600;">
                          <option value="DISABLED" ${curMode === 'DISABLED' ? 'selected' : ''}>DISABLED (No Free Delivery - Always Charge Zone/Weight)</option>
                          <option value="THRESHOLD_WITH_WEIGHT_CAP" ${curMode === 'THRESHOLD_WITH_WEIGHT_CAP' ? 'selected' : ''}>THRESHOLD + WEIGHT CAP (Free Above ₹X up to Y Grams)</option>
                          <option value="UNCONDITIONAL_THRESHOLD" ${curMode === 'UNCONDITIONAL_THRESHOLD' ? 'selected' : ''}>UNCONDITIONAL THRESHOLD (Free Above ₹X Any Weight)</option>
                        </select>
                      </div>
                      <div>
                        <label style="font-size:0.76rem;font-weight:700;display:block;margin-bottom:4px;">Free Delivery Above (INR ₹)</label>
                        <input type="number" name="free_shipping_threshold_inr" value="${escapeHtml(sMap.free_shipping_threshold_inr || '799')}" min="0" class="sn-input" />
                      </div>
                      <div>
                        <label style="font-size:0.76rem;font-weight:700;display:block;margin-bottom:4px;">Free-Delivery Max Weight Cap (g)</label>
                        <input type="number" name="free_shipping_max_weight_grams" value="${escapeHtml(sMap.free_shipping_max_weight_grams || '2000')}" min="100" class="sn-input" />
                      </div>
                    </div>

                    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px;">
                      <div>
                        <label style="font-size:0.74rem;font-weight:600;display:block;">Box Tare Weight (g)</label>
                        <input type="number" name="shipping_packaging_tare_grams" value="${escapeHtml(sMap.shipping_packaging_tare_grams || '150')}" min="0" class="sn-input" />
                      </div>
                      <div>
                        <label style="font-size:0.74rem;font-weight:600;display:block;">COD Collection Fee (₹)</label>
                        <input type="number" name="shipping_cod_fee_inr" value="${escapeHtml(sMap.shipping_cod_fee_inr || '40')}" min="0" class="sn-input" />
                      </div>
                      <div>
                        <label style="font-size:0.74rem;font-weight:600;display:block;">Zone A (Local BLR) 500g / +500g (₹)</label>
                        <div style="display:flex;gap:6px;">
                          <input type="number" name="zone_a_base_inr" value="${escapeHtml(sMap.zone_a_base_inr || '40')}" class="sn-input" />
                          <input type="number" name="zone_a_extra_inr" value="${escapeHtml(sMap.zone_a_extra_inr || '15')}" class="sn-input" />
                        </div>
                      </div>
                      <div>
                        <label style="font-size:0.74rem;font-weight:600;display:block;">Zone B (South) 500g / +500g (₹)</label>
                        <div style="display:flex;gap:6px;">
                          <input type="number" name="zone_b_base_inr" value="${escapeHtml(sMap.zone_b_base_inr || '55')}" class="sn-input" />
                          <input type="number" name="zone_b_extra_inr" value="${escapeHtml(sMap.zone_b_extra_inr || '25')}" class="sn-input" />
                        </div>
                      </div>
                    </div>

                    <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:end;">
                      <div>
                        <label style="font-size:0.74rem;font-weight:600;display:block;">Zone C (Rest of India) Base 500g / +500g (₹)</label>
                        <div style="display:flex;gap:6px;">
                          <input type="number" name="zone_c_base_inr" value="${escapeHtml(sMap.zone_c_base_inr || '75')}" class="sn-input" />
                          <input type="number" name="zone_c_extra_inr" value="${escapeHtml(sMap.zone_c_extra_inr || '35')}" class="sn-input" />
                        </div>
                      </div>
                      <div>
                        <label style="font-size:0.74rem;font-weight:600;display:block;">Zone D (NE / J&amp;K / Remote) Base 500g / +500g (₹)</label>
                        <div style="display:flex;gap:6px;">
                          <input type="number" name="zone_d_base_inr" value="${escapeHtml(sMap.zone_d_base_inr || '110')}" class="sn-input" />
                          <input type="number" name="zone_d_extra_inr" value="${escapeHtml(sMap.zone_d_extra_inr || '55')}" class="sn-input" />
                        </div>
                      </div>
                      <button type="submit" class="sn-btn sn-btn-primary">Save Delivery Policy</button>
                    </div>
                  </form>

                  <!-- 2. Editable Business Legal, GSTIN, FSSAI & Notification Templates Form (Section 8 & Section 11) -->
                  <form id="sn-admin-compliance-form" class="sn-card" style="background-color:var(--sn-bg-mortar);margin-bottom:24px;">
                    <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;font-size:1.05rem;color:var(--sn-bg-forest);">2. Business Legal, GSTIN, FSSAI &amp; Customer Notification Templates Editor (Sections 8 &amp; 11)</h3>
                    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;">
                      <div>
                        <label style="font-size:0.74rem;font-weight:600;display:block;">Business Legal Name *</label>
                        <input type="text" name="business_legal_name" required value="${escapeHtml(sMap.business_legal_name || '')}" class="sn-input" />
                      </div>
                      <div>
                        <label style="font-size:0.74rem;font-weight:600;display:block;">GSTIN Registration *</label>
                        <input type="text" name="gstin" required value="${escapeHtml(sMap.gstin || '')}" class="sn-input" style="font-family:var(--sn-font-mono);" />
                      </div>
                      <div>
                        <label style="font-size:0.74rem;font-weight:600;display:block;">FSSAI Licence / Registration *</label>
                        <input type="text" name="fssai_license" required value="${escapeHtml(sMap.fssai_license || '')}" class="sn-input" style="font-family:var(--sn-font-mono);" />
                      </div>
                    </div>
                    <div style="display:grid;grid-template-columns:0.8fr 0.8fr 1.4fr;gap:12px;margin-bottom:12px;">
                      <div>
                        <label style="font-size:0.74rem;font-weight:600;display:block;">Customer Support Email *</label>
                        <input type="email" name="support_email" required value="${escapeHtml(sMap.support_email || '')}" class="sn-input" />
                      </div>
                      <div>
                        <label style="font-size:0.74rem;font-weight:600;display:block;">Support Phone *</label>
                        <input type="text" name="support_phone" required value="${escapeHtml(sMap.support_phone || '')}" class="sn-input" />
                      </div>
                      <div>
                        <label style="font-size:0.74rem;font-weight:600;display:block;">Registered Office &amp; Dispatch Address *</label>
                        <input type="text" name="registered_address" required value="${escapeHtml(sMap.registered_address || '')}" class="sn-input" />
                      </div>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
                      <div>
                        <label style="font-size:0.74rem;font-weight:600;display:block;">Order Confirmation Notification Template</label>
                        <input type="text" name="email_template_order_confirmed" value="${escapeHtml(sMap.email_template_order_confirmed || '')}" class="sn-input" />
                      </div>
                      <div>
                        <label style="font-size:0.74rem;font-weight:600;display:block;">Order Shipped / Dispatch Notification Template</label>
                        <input type="text" name="email_template_order_shipped" value="${escapeHtml(sMap.email_template_order_shipped || '')}" class="sn-input" />
                      </div>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:end;">
                      <div>
                        <label style="font-size:0.74rem;font-weight:600;display:block;">Order Delivered Notification Template</label>
                        <input type="text" name="email_template_order_delivered" value="${escapeHtml(sMap.email_template_order_delivered || '')}" class="sn-input" />
                      </div>
                      <div>
                        <label style="font-size:0.74rem;font-weight:600;display:block;">Cancellation / Refund Notification Template</label>
                        <input type="text" name="email_template_order_cancelled" value="${escapeHtml(sMap.email_template_order_cancelled || '')}" class="sn-input" />
                      </div>
                      <button type="submit" class="sn-btn sn-btn-forest">Save Compliance &amp; Templates</button>
                    </div>
                  </form>
                `;
              })()}

              <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1.1rem;color:var(--sn-bg-forest);">Recent Customer Notification Dispatch Logs (Section 8)</h3>
              <div class="sn-table-wrap">
                <table class="sn-table">
                  <thead>
                    <tr><th>Timestamp</th><th>Order No.</th><th>Channel</th><th>Recipient</th><th>Event</th><th>Subject &amp; Preview</th></tr>
                  </thead>
                  <tbody>
                    ${notificationLogs.map(nl => `
                      <tr>
                        <td style="font-family:var(--sn-font-mono);font-size:0.74rem;">${escapeHtml(nl.created_at)}</td>
                        <td style="font-family:var(--sn-font-mono);font-weight:600;">${escapeHtml(nl.order_number)}</td>
                        <td><span class="sn-status sn-status-paid">${escapeHtml(nl.channel)}</span></td>
                        <td style="font-family:var(--sn-font-mono);font-size:0.76rem;">${escapeHtml(nl.recipient)}</td>
                        <td style="font-family:var(--sn-font-mono);font-size:0.75rem;">${escapeHtml(nl.event_type)}</td>
                        <td style="font-size:0.8rem;"><strong>${escapeHtml(nl.subject)}</strong> — ${escapeHtml(nl.body_preview)}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;

  return renderShell({
    title,
    description,
    canonicalPath: '/admin',
    activeNav: 'admin',
    schemaGraph,
    bodyHtml,
    isNoIndex: true,
    basePath,
    staticShowcaseScript
  });
}

function renderStaticInfoPage({ slug, title, subtitle, paragraphs = [], basePath = '', staticShowcaseScript = '', isNoIndex = false }) {
  const canonicalPath = `/${slug}`;
  const description = subtitle;
  const schemaGraph = buildMasterSchemaGraph({
    pageType: 'webpage',
    canonicalPath,
    title: `${title} | ${BRAND_NAME}`,
    description,
    breadcrumbs: [{ name: 'Home', url: '/' }, { name: title, url: canonicalPath }]
  });

  const bodyHtml = `
    <section class="sn-section">
      <div class="sn-container" style="max-width:880px;">
        <span class="sn-eyebrow">${escapeHtml(subtitle)}</span>
        <h1 style="font-family:var(--sn-font-serif);font-size:2.2rem;color:var(--sn-bg-forest);margin:0 0 24px;">${escapeHtml(title)}</h1>
        <div class="sn-card" style="display:flex;flex-direction:column;gap:16px;font-size:0.98rem;">
          ${paragraphs.map(p => `<p style="margin:0;">${escapeHtml(p)}</p>`).join('')}
        </div>
      </div>
    </section>
  `;

  return renderShell({
    title: `${title} | ${BRAND_NAME}`,
    description,
    canonicalPath,
    activeNav: slug,
    schemaGraph,
    bodyHtml,
    isNoIndex,
    basePath,
    staticShowcaseScript
  });
}

function renderMarkdownTwin({ title, canonicalPath, description, sections = [] }) {
  const canonicalUrl = `${CANONICAL_ORIGIN}${canonicalPath === '/' ? '/' : canonicalPath}`;
  return [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `description: "${description.replace(/"/g, '\\"')}"`,
    `canonical_url: "${canonicalUrl}"`,
    `platform: "${BRAND_NAME} (sasynaturals.com)"`,
    '---',
    '',
    `# ${title}`,
    '',
    description,
    '',
    ...sections.flatMap(sec => [`## ${sec.heading}`, '', sec.body, ''])
  ].join('\n');
}

module.exports = {
  formatInr,
  getDynamicShippingCopy,
  renderHomePage,
  renderCatalogPage,
  renderProductDetailPage,
  renderCheckoutPage,
  renderTrackOrderPage,
  renderGstInvoicePage,
  renderCustomerAccountPage,
  renderAdminLoginRequiredPage,
  renderAdminPortalPage,
  renderStaticInfoPage,
  renderMarkdownTwin
};
