'use strict';

const {
  APP_VERSION,
  CANONICAL_ORIGIN,
  BRAND_NAME,
  BRAND_TAGLINE,
  ORDER_FULFILMENT_STATUSES
} = require('../config/appConfig');
const { buildMasterSchemaGraph } = require('../core/content/schemaBuilder');

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

  return `
    <article class="sn-product-card" data-product-container="${p.id}" id="prod-card-${escapeHtml(p.slug)}">
      <a href="${basePath}/product/${escapeHtml(p.slug)}" class="sn-product-media">
        <img src="${basePath}${escapeHtml(p.image_url)}" alt="${escapeHtml(p.name)}" loading="lazy" />
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
      <span>Complimentary India-Wide Delivery on orders above ₹799 | Use code <strong>SASYA10</strong> for 10% off</span>
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
        <a href="${basePath}/admin" class="${activeNav === 'admin' ? 'sn-active' : ''}" id="nav-admin">Admin Portal</a>
      </nav>
      <div class="sn-header-actions">
        <a href="${basePath}/account" class="sn-btn sn-btn-outline sn-btn-sm" id="header-account-btn">Account</a>
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
            <li><a href="${basePath}/admin">Staff RBAC Admin Portal</a></li>
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
        <div class="sn-category-grid">
          ${categories.map(cat => `
            <a href="${basePath}/category/${escapeHtml(cat.slug)}" class="sn-category-card" id="cat-tile-${escapeHtml(cat.slug)}">
              <div class="sn-category-img-wrap">
                <img src="${basePath}${escapeHtml(cat.image_url)}" alt="${escapeHtml(cat.name)}" loading="lazy" />
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
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <a href="${basePath}/shop" class="sn-btn ${!activeCategory ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm">All (${products.length})</a>
            ${categories.map(c => `
              <a href="${basePath}/category/${escapeHtml(c.slug)}" class="sn-btn ${activeCategory && activeCategory.slug === c.slug ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm">${escapeHtml(c.name)}</a>
            `).join('')}
          </div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;min-width:300px;">
            <input type="search" name="q" value="${escapeHtml(searchQuery)}" placeholder="Search almonds, ragi, turmeric..." class="sn-input" style="width:220px;" id="catalog-search-input" />
            <select name="sort" class="sn-select" style="width:165px;" id="catalog-sort-select" onchange="this.form.submit()">
              <option value="featured" ${sortBy === 'featured' ? 'selected' : ''}>Sort: Featured</option>
              <option value="price_asc" ${sortBy === 'price_asc' ? 'selected' : ''}>Price: Low to High</option>
              <option value="price_desc" ${sortBy === 'price_desc' ? 'selected' : ''}>Price: High to Low</option>
            </select>
            <button type="submit" class="sn-btn sn-btn-primary sn-btn-sm" id="catalog-search-btn">Filter</button>
          </div>
        </form>

        <div class="sn-product-grid">
          ${products.length > 0
            ? products.map(p => renderProductCard(p, variants, basePath)).join('')
            : `<div class="sn-card"><p>No matching products found for "${escapeHtml(searchQuery)}". <a href="${basePath}/shop" style="color:var(--sn-accent-terracotta);font-weight:600;">Reset filters</a></p></div>`
          }
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
            <img src="${basePath}${escapeHtml(product.image_url)}" alt="${escapeHtml(product.name)}" />
            <div style="padding:12px 18px;background-color:var(--sn-bg-mortar);font-family:var(--sn-font-mono);font-size:0.76rem;color:var(--sn-text-secondary);">
              ${escapeHtml(product.image_caption || product.name)} | Origin: ${escapeHtml(product.origin_region)}
            </div>
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
                  <span style="font-size:0.76rem;color:var(--sn-text-muted);">Inclusive of ${product.gst_percent}% GST | Free delivery above ₹799</span>
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

            <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;font-size:1.1rem;color:var(--sn-bg-forest);">Ordered Pack Items</h3>
            <div class="sn-table-wrap">
              <table class="sn-table">
                <thead>
                  <tr><th>Product</th><th>SKU</th><th>Pack Size</th><th>Qty</th><th>Unit Price</th><th>Line Total</th></tr>
                </thead>
                <tbody>
                  ${orderItems.map(item => `
                    <tr>
                      <td><strong>${escapeHtml(item.product_name)}</strong></td>
                      <td style="font-family:var(--sn-font-mono);">${escapeHtml(item.sku)}</td>
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

function renderAdminPortalPage({
  categories,
  products,
  variants,
  orders,
  payments,
  staffUsers,
  auditLogs,
  settings,
  movements,
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
  const lowStockVariants = variants.filter(v => v.stock_qty <= v.low_stock_threshold);

  const bodyHtml = `
    <section class="sn-section" id="sn-admin-portal">
      <div class="sn-container">
        <div class="sn-filter-bar" style="background-color:var(--sn-bg-forest);color:#FAF6EE;border-color:var(--sn-bg-forest);">
          <div>
            <span class="sn-eyebrow" style="color:#E7B971;margin-bottom:2px;">Separate Authenticated Staff Portal • Server-Side RBAC</span>
            <h1 style="font-family:var(--sn-font-serif);font-size:1.55rem;margin:0;color:#FFFFFF;">Sasya Naturals Operations &amp; Role Management</h1>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <label for="sn-admin-role-switcher" style="font-family:var(--sn-font-mono);font-size:0.75rem;">Active RBAC Staff Session:</label>
            <select id="sn-admin-role-switcher" class="sn-select" style="width:295px;font-weight:600;">
              ${staffUsers.map(u => `
                <option value="${escapeHtml(u.email)}">${escapeHtml(u.role)} - ${escapeHtml(u.full_name)}</option>
              `).join('')}
            </select>
          </div>
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
            <div class="sn-kpi-label">Active SKUs &amp; Variants</div>
            <div class="sn-kpi-val">${products.length} / ${variants.length}</div>
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
              <li><button type="button" data-admin-tab-btn="products" id="tab-btn-products">2. Products &amp; Pack Variants</button></li>
              <li><button type="button" data-admin-tab-btn="inventory" id="tab-btn-inventory">3. Inventory &amp; Stock Ledger</button></li>
              <li><button type="button" data-admin-tab-btn="payments" id="tab-btn-payments">4. Payments, COD &amp; Reports</button></li>
              <li><button type="button" data-admin-tab-btn="rbac" id="tab-btn-rbac">5. Staff RBAC &amp; Audit Logs</button></li>
              <li><button type="button" data-admin-tab-btn="compliance" id="tab-btn-compliance">6. GST &amp; FSSAI Compliance</button></li>
            </ul>
          </aside>

          <div>
            <!-- Panel 1: Orders & Manual Shipping -->
            <div class="sn-card" data-admin-panel="orders">
              <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Orders &amp; Manual Courier Dispatch Workflow</h2>
              <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0 0 20px;">
                Authorized for <strong>SUPER_ADMIN</strong>, <strong>ORDER_MANAGER</strong>, and permitted <strong>STAFF</strong>. Payment status and fulfilment status are tracked independently.
              </p>
              ${orders.map(o => `
                <div class="sn-card" style="margin-bottom:16px;background-color:var(--sn-bg-parchment);">
                  <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
                    <div>
                      <strong style="font-family:var(--sn-font-mono);font-size:1rem;color:var(--sn-bg-forest);">${escapeHtml(o.order_number)}</strong>
                      <span style="font-size:0.85rem;color:var(--sn-text-secondary);"> • ${escapeHtml(o.customer_name)} (${escapeHtml(o.customer_phone)}) • ${escapeHtml(o.shipping_city)} (${escapeHtml(o.shipping_pincode)})</span>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center;">
                      <span class="sn-status ${o.payment_status === 'PAID' || o.payment_status === 'COD_COLLECTED' ? 'sn-status-paid' : 'sn-status-warn'}">Payment: ${escapeHtml(o.payment_status)}</span>
                      <span class="sn-status sn-status-paid">Fulfilment: ${escapeHtml(o.fulfilment_status)}</span>
                      <strong style="font-family:var(--sn-font-mono);">${formatInr(o.total_paise)}</strong>
                    </div>
                  </div>
                  <form class="sn-admin-ship-form" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px;align-items:end;">
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
                    <button type="submit" class="sn-btn sn-btn-forest sn-btn-sm">Save &amp; Notify</button>
                  </form>
                </div>
              `).join('')}
            </div>

            <!-- Panel 2: Products & Pack Variants -->
            <div class="sn-card" data-admin-panel="products" style="display:none;">
              <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Product Catalogue &amp; Pack-Size Variant Builder</h2>
              <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0 0 18px;">
                Authorized for <strong>SUPER_ADMIN</strong> and <strong>PRODUCT_MANAGER</strong>. Accounts Managers and Order Managers are blocked by server RBAC.
              </p>
              <form id="sn-admin-create-product-form" class="sn-card" style="background-color:var(--sn-bg-parchment);margin-bottom:24px;">
                <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;font-size:1.1rem;">Add New Product (Auto-Generates 100 g, 250 g, 500 g &amp; 1 kg Variants)</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;">
                  <div>
                    <label style="font-size:0.75rem;font-weight:600;">Product Name *</label>
                    <input type="text" name="name" required placeholder="e.g. Kanyakumari Hand-Picked Cloves" class="sn-input" />
                  </div>
                  <div>
                    <label style="font-size:0.75rem;font-weight:600;">SKU Prefix *</label>
                    <input type="text" name="skuBase" required placeholder="e.g. SN-SP-CLV" class="sn-input" />
                  </div>
                  <div>
                    <label style="font-size:0.75rem;font-weight:600;">Category *</label>
                    <select name="categoryId" class="sn-select">
                      ${categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
                    </select>
                  </div>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;">
                  <div>
                    <label style="font-size:0.75rem;font-weight:600;">100g Base Selling Price (INR) *</label>
                    <input type="number" name="base100gInr" required value="180" class="sn-input" />
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
                    <input type="text" name="originRegion" required value="Kanyakumari, Tamil Nadu" class="sn-input" />
                  </div>
                </div>
                <div style="margin-bottom:12px;">
                  <label style="font-size:0.75rem;font-weight:600;">Short Description (Humanizer-Checked) *</label>
                  <input type="text" name="shortDescription" required value="Sun-dried whole clove buds rich in natural eugenol essential oil." class="sn-input" />
                </div>
                <button type="submit" class="sn-btn sn-btn-primary">Create Product &amp; 4 Pack Variants</button>
              </form>

              <div class="sn-table-wrap">
                <table class="sn-table">
                  <thead>
                    <tr><th>SKU Base</th><th>Product Name</th><th>Origin &amp; Batch</th><th>GST</th><th>Pack Variants (100g / 250g / 500g / 1kg)</th></tr>
                  </thead>
                  <tbody>
                    ${products.map(p => {
                      const pVars = variants.filter(v => v.product_id === p.id);
                      return `
                        <tr>
                          <td style="font-family:var(--sn-font-mono);">${escapeHtml(p.sku_base)}</td>
                          <td><strong><a href="${basePath}/product/${escapeHtml(p.slug)}">${escapeHtml(p.name)}</a></strong></td>
                          <td>${escapeHtml(p.origin_region)} (${escapeHtml(p.harvest_batch)})</td>
                          <td style="font-family:var(--sn-font-mono);">${p.gst_percent}%</td>
                          <td style="font-family:var(--sn-font-mono);font-size:0.76rem;">
                            ${pVars.map(v => `${escapeHtml(v.pack_label)}: ${formatInr(v.selling_price_paise)} (${v.stock_qty})`).join(' | ')}
                          </td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>
              </div>
            </div>

            <!-- Panel 3: Inventory & Stock Movements -->
            <div class="sn-card" data-admin-panel="inventory" style="display:none;">
              <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Inventory Control &amp; Atomic Stock Movement Ledger</h2>
              <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0 0 18px;">
                Stock is automatically decremented on order confirmation and restored on order cancellation or refund.
              </p>
              <div class="sn-table-wrap" style="margin-bottom:24px;">
                <table class="sn-table">
                  <thead>
                    <tr><th>Variant SKU</th><th>Pack</th><th>Price</th><th>Current Stock</th><th>Quick Stock Update</th></tr>
                  </thead>
                  <tbody>
                    ${variants.slice(0, 16).map(v => `
                      <tr>
                        <td style="font-family:var(--sn-font-mono);">${escapeHtml(v.sku)}</td>
                        <td style="font-family:var(--sn-font-mono);">${escapeHtml(v.pack_label)}</td>
                        <td style="font-family:var(--sn-font-mono);">${formatInr(v.selling_price_paise)}</td>
                        <td><span class="sn-status ${v.stock_qty <= v.low_stock_threshold ? 'sn-status-danger' : 'sn-status-paid'}">${v.stock_qty} packs</span></td>
                        <td>
                          <form class="sn-admin-stock-form" style="display:flex;gap:6px;">
                            <input type="hidden" name="variantId" value="${v.id}" />
                            <input type="number" name="newStockQty" value="${v.stock_qty}" min="0" class="sn-input" style="width:80px;padding:4px 8px;" />
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

            <!-- Panel 4: Payments, COD & Reports -->
            <div class="sn-card" data-admin-panel="payments" style="display:none;">
              <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Payment Gateway Reconciliation, COD Collections &amp; Settlement</h2>
              <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0 0 18px;">
                Authorized for <strong>SUPER_ADMIN</strong> and <strong>ACCOUNTS_MANAGER</strong>. All online payments require server-side HMAC-SHA256 verification.
              </p>
              <div class="sn-table-wrap">
                <table class="sn-table">
                  <thead>
                    <tr><th>Order No.</th><th>Provider &amp; Method</th><th>Gateway Order ID</th><th>Gateway Payment ID</th><th>Amount</th><th>Status</th><th>Server Verified</th></tr>
                  </thead>
                  <tbody>
                    ${payments.map(pay => `
                      <tr>
                        <td style="font-family:var(--sn-font-mono);font-weight:600;">${escapeHtml(pay.order_number)}</td>
                        <td>${escapeHtml(pay.gateway_provider)} (${escapeHtml(pay.method)})</td>
                        <td style="font-family:var(--sn-font-mono);font-size:0.75rem;">${escapeHtml(pay.gateway_order_id)}</td>
                        <td style="font-family:var(--sn-font-mono);font-size:0.75rem;">${escapeHtml(pay.gateway_payment_id || 'COD / Pending')}</td>
                        <td style="font-family:var(--sn-font-mono);font-weight:600;">${formatInr(pay.amount_paise)}</td>
                        <td><span class="sn-status ${pay.status === 'PAID' || pay.status === 'COD_COLLECTED' ? 'sn-status-paid' : 'sn-status-warn'}">${escapeHtml(pay.status)}</span></td>
                        <td style="font-family:var(--sn-font-mono);">${pay.verified_on_server ? '✓ HMAC Verified' : 'Pending'}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>

            <!-- Panel 5: Staff RBAC & Audit Logs -->
            <div class="sn-card" data-admin-panel="rbac" style="display:none;">
              <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">5-Role Staff RBAC Directory &amp; Immutable Audit Logs</h2>
              <div class="sn-table-wrap" style="margin-bottom:24px;">
                <table class="sn-table">
                  <thead>
                    <tr><th>Staff Name</th><th>Email</th><th>Assigned Role</th><th>Permitted Actions</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    ${staffUsers.map(u => `
                      <tr>
                        <td><strong>${escapeHtml(u.full_name)}</strong></td>
                        <td style="font-family:var(--sn-font-mono);">${escapeHtml(u.email)}</td>
                        <td><span class="sn-status sn-status-paid">${escapeHtml(u.role)}</span></td>
                        <td style="font-family:var(--sn-font-mono);font-size:0.75rem;">${escapeHtml(u.permissions_json)}</td>
                        <td>Active</td>
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

            <!-- Panel 6: GST & FSSAI Business Compliance Settings -->
            <div class="sn-card" data-admin-panel="compliance" style="display:none;">
              <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Configurable Business, Tax (GST) &amp; FSSAI Settings (Section 11)</h2>
              <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0 0 18px;">
                Per Guardrail Section 6, licences and tax numbers are stored as configurable fields for the business owner and tax adviser to verify before production launch.
              </p>
              <table class="sn-spec-table">
                <tbody>
                  ${settings.map(s => `
                    <tr>
                      <th style="font-family:var(--sn-font-mono);">${escapeHtml(s.key)}</th>
                      <td>${escapeHtml(s.value)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
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
  renderHomePage,
  renderCatalogPage,
  renderProductDetailPage,
  renderCheckoutPage,
  renderTrackOrderPage,
  renderAdminPortalPage,
  renderStaticInfoPage,
  renderMarkdownTwin
};
