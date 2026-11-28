'use strict';

const {
  APP_VERSION,
  CANONICAL_ORIGIN,
  IS_STAGING,
  BRAND_NAME,
  BRAND_TAGLINE,
  ORDER_FULFILMENT_STATUSES
} = require('../config/appConfig');
const {
  getDb,
  parseProductNutrition,
  parseProductPincodeRules,
  summarizePincodeRules
} = require('../db/database');
const { buildMasterSchemaGraph } = require('../core/content/schemaBuilder');
const {
  getShippingPolicyFromDb,
  evaluateCouponStatus,
  listEnrichedCoupons
} = require('../core/checkout/checkoutEngine');
const { buildComprehensiveReports } = require('../core/reports/reportingEngine');
const { getStorefrontContentAndSeo } = require('../core/content/contentStore');
const { evaluateLaunchReadiness } = require('../core/auth/launchReadiness');

function getActiveNavCategories() {
  try {
    const db = getDb();
    const cats = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY display_order, id').all();
    const counts = db.prepare('SELECT category_id, COUNT(*) AS cnt FROM products WHERE is_active = 1 GROUP BY category_id').all();
    const countMap = new Map(counts.map(r => [Number(r.category_id), Number(r.cnt)]));
    return cats.map(c => ({
      ...c,
      productCount: countMap.get(Number(c.id)) || 0
    }));
  } catch {
    return [];
  }
}

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

const IMAGE_UPLOAD_SPECS = {
  product: {
    dimensions: '1200 × 900 px (min 640 × 480 px)',
    aspectRatio: '4:3 Landscape',
    formats: 'JPEG, PNG, or WebP (Max 3 MB)',
    summary: 'Dimensions: 1200 × 900 px (min 640 × 480 px) • Aspect Ratio: 4:3 Landscape • Format: JPEG, PNG, or WebP (Max 3 MB)'
  },
  category: {
    dimensions: '1200 × 900 px (min 800 × 600 px)',
    aspectRatio: '4:3 Landscape',
    formats: 'JPEG, PNG, or WebP (Max 3 MB)',
    summary: 'Dimensions: 1200 × 900 px (min 800 × 600 px) • Aspect Ratio: 4:3 Landscape • Format: JPEG, PNG, or WebP (Max 3 MB)'
  },
  hero: {
    dimensions: '1160 × 992 px (2x Retina) or 580 × 496 px',
    aspectRatio: '7:6 (1.17:1) Composition',
    formats: 'JPEG, PNG, or WebP (Max 3 MB)',
    summary: 'Dimensions: 1160 × 992 px (or 580 × 496 px) • Aspect Ratio: 7:6 (1.17:1) • Format: JPEG, PNG, or WebP (Max 3 MB)'
  },
  opengraph: {
    dimensions: '1200 × 630 px (or 1376 × 768 px)',
    aspectRatio: '1.91:1 / 16:9 Widescreen',
    formats: 'JPEG, PNG, or WebP',
    summary: 'Dimensions: 1200 × 630 px (or 1376 × 768 px) • Aspect Ratio: 1.91:1 / 16:9 Widescreen • Format: JPEG, PNG, or WebP'
  }
};

function renderImageSpecTooltip(typeKey = 'product') {
  const spec = IMAGE_UPLOAD_SPECS[typeKey] || IMAGE_UPLOAD_SPECS.product;
  return `<span class="sn-img-spec-tooltip" tabindex="0" role="note" aria-label="${escapeHtml(spec.summary)}" title="${escapeHtml(spec.summary)}" data-img-spec-badge="${escapeHtml(typeKey)}">ⓘ Specs<span class="sn-img-spec-popover" aria-hidden="true"><strong>Dimensions:</strong> ${escapeHtml(spec.dimensions)}<br/><strong>Aspect Ratio:</strong> ${escapeHtml(spec.aspectRatio)}<br/><strong>Format:</strong> ${escapeHtml(spec.formats)}</span></span>`;
}

function classifyInventoryHealthTier(stockQty, threshold) {
  const qty = Number(stockQty || 0);
  const thresh = Math.max(1, Number(threshold || 10));
  if (qty <= 0) return 'OUT';
  if (qty <= thresh) return 'LOW';
  if (qty <= Math.ceil(thresh * 1.5)) return 'WATCH';
  return 'HEALTHY';
}

function renderInventoryAnalyticsCharts({ variants = [], products = [], categories = [] }) {
  const totalVariants = Math.max(1, variants.length);
  const prodMap = new Map(products.map(p => [Number(p.id), p]));

  let healthyCount = 0;
  let watchCount = 0;
  let lowCount = 0;
  let outCount = 0;
  let totalPacks = 0;
  let totalWeightGrams = 0;
  let totalValuePaise = 0;

  const catStatsMap = new Map();
  for (const c of categories) {
    catStatsMap.set(Number(c.id), {
      id: Number(c.id),
      name: c.name,
      packs: 0,
      weightGrams: 0,
      valuePaise: 0,
      skuCount: 0,
      healthySkus: 0,
      watchSkus: 0,
      lowOrOutSkus: 0
    });
  }

  const packLabels = ['100 g', '250 g', '500 g', '1 kg'];
  const packStatsMap = new Map(
    packLabels.map(lbl => [
      lbl,
      { label: lbl, packs: 0, skuCount: 0, healthySkus: 0, watchSkus: 0, lowOrOutSkus: 0 }
    ])
  );

  const enrichedVariants = variants.map(v => {
    const qty = Number(v.stock_qty || 0);
    const thresh = Math.max(1, Number(v.low_stock_threshold || 10));
    const tier = classifyInventoryHealthTier(qty, thresh);
    const prod = prodMap.get(Number(v.product_id));
    const prodName = prod ? prod.name : `Product #${v.product_id}`;
    const catId = prod ? Number(prod.category_id) : 1;

    if (tier === 'HEALTHY') healthyCount++;
    else if (tier === 'WATCH') watchCount++;
    else if (tier === 'LOW') lowCount++;
    else outCount++;

    totalPacks += qty;
    totalWeightGrams += qty * Number(v.weight_grams || 0);
    totalValuePaise += qty * Number(v.selling_price_paise || 0);

    const cs = catStatsMap.get(catId);
    if (cs) {
      cs.packs += qty;
      cs.weightGrams += qty * Number(v.weight_grams || 0);
      cs.valuePaise += qty * Number(v.selling_price_paise || 0);
      cs.skuCount += 1;
      if (tier === 'HEALTHY') cs.healthySkus += 1;
      else if (tier === 'WATCH') cs.watchSkus += 1;
      else cs.lowOrOutSkus += 1;
    }

    const ps = packStatsMap.get(v.pack_label);
    if (ps) {
      ps.packs += qty;
      ps.skuCount += 1;
      if (tier === 'HEALTHY') ps.healthySkus += 1;
      else if (tier === 'WATCH') ps.watchSkus += 1;
      else ps.lowOrOutSkus += 1;
    }

    return {
      ...v,
      qty,
      thresh,
      tier,
      ratio: qty / thresh,
      prodName,
      catId
    };
  });

  // Donut SVG geometry (r = 44, C = 276.46)
  const C = 276.46;
  const hLen = (healthyCount / totalVariants) * C;
  const wLen = (watchCount / totalVariants) * C;
  const lLen = (lowCount / totalVariants) * C;
  const oLen = (outCount / totalVariants) * C;
  const healthyPct = Math.round((healthyCount / totalVariants) * 100);
  const totalWeightKg = (totalWeightGrams / 1000).toLocaleString('en-IN', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  });

  // Top 4 Restock Priority SKUs (lowest ratio = qty / thresh, then lowest qty)
  const prioritySkus = [...enrichedVariants]
    .sort((a, b) => (a.ratio - b.ratio) || (a.qty - b.qty) || (a.id - b.id))
    .slice(0, 4);

  return `
    <!-- v4.1.1: Restructured 3-Tier Inventory Analytics Dashboard -->
    <div id="sn-inv-analytics-dashboard">
      <!-- Tier 1: Full-Width 4-Tile Warehouse Summary Strip -->
      <div class="sn-inv-kpi-strip">
        <div class="sn-inv-kpi-tile">
          <span class="sn-inv-kpi-tile-lbl">Active Warehouse SKUs</span>
          <span class="sn-inv-kpi-tile-val">${variants.length} SKUs</span>
          <span class="sn-inv-kpi-tile-sub">${products.length} Products &times; 4 Pack Sizes</span>
        </div>
        <div class="sn-inv-kpi-tile" style="border-left-color:#1E6B3A;">
          <span class="sn-inv-kpi-tile-lbl">Total Warehouse Packs</span>
          <span class="sn-inv-kpi-tile-val" id="sn-inv-kpi-packs">${totalPacks.toLocaleString('en-IN')}</span>
          <span class="sn-inv-kpi-tile-sub">Sealed Barrier Pouches in Stock</span>
        </div>
        <div class="sn-inv-kpi-tile" style="border-left-color:#D99B1A;">
          <span class="sn-inv-kpi-tile-lbl">Total Net Pantry Weight</span>
          <span class="sn-inv-kpi-tile-val" id="sn-inv-kpi-weight">${totalWeightKg} kg</span>
          <span class="sn-inv-kpi-tile-sub">Combined Net Harvest Weight</span>
        </div>
        <div class="sn-inv-kpi-tile" style="border-left-color:#8C520A;">
          <span class="sn-inv-kpi-tile-lbl">Total Retail Stock Value</span>
          <span class="sn-inv-kpi-tile-val" id="sn-inv-kpi-value">${formatInr(totalValuePaise)}</span>
          <span class="sn-inv-kpi-tile-sub">At Active Storefront Selling Prices</span>
        </div>
      </div>

      <!-- Tier 2: Symmetrical 2-Column Bento Analytics Grid (50% / 50% width, minmax(0, 1fr)) -->
      <div class="sn-inv-bento-grid">
        <!-- Left Bento Box: Chart 1 (SKU Stock Health Donut & 2x2 Tiers) + Pack-Size Distribution -->
        <div class="sn-inv-chart-card" id="sn-inv-chart-health-card">
          <div class="sn-inv-card-section">
            <div class="sn-inv-chart-header">
              <h3 class="sn-inv-chart-title">1. SKU Stock Health Breakdown</h3>
              <span class="sn-inv-chart-badge">Click Tier to Filter</span>
            </div>
            <p class="sn-inv-chart-sub">Distribution of all ${variants.length} SKUs relative to their minimum alert threshold.</p>

            <div class="sn-inv-donut-layout">
              <div class="sn-inv-donut-svg-wrap">
                <svg viewBox="0 0 112 112" width="108" height="108" style="transform:rotate(-90deg);" aria-label="SKU Stock Health Donut Chart">
                  <circle cx="56" cy="56" r="44" fill="none" stroke="rgba(17,26,77,0.08)" stroke-width="14"></circle>
                  <circle id="sn-inv-donut-seg-healthy" cx="56" cy="56" r="44" fill="none" stroke="#1E6B3A" stroke-width="14" stroke-dasharray="${hLen.toFixed(2)} ${C}" stroke-dashoffset="0"></circle>
                  <circle id="sn-inv-donut-seg-watch" cx="56" cy="56" r="44" fill="none" stroke="#E5B83B" stroke-width="14" stroke-dasharray="${wLen.toFixed(2)} ${C}" stroke-dashoffset="${(-hLen).toFixed(2)}"></circle>
                  <circle id="sn-inv-donut-seg-low" cx="56" cy="56" r="44" fill="none" stroke="#C85A17" stroke-width="14" stroke-dasharray="${lLen.toFixed(2)} ${C}" stroke-dashoffset="${(-(hLen + wLen)).toFixed(2)}"></circle>
                  <circle id="sn-inv-donut-seg-out" cx="56" cy="56" r="44" fill="none" stroke="#B42318" stroke-width="14" stroke-dasharray="${oLen.toFixed(2)} ${C}" stroke-dashoffset="${(-(hLen + wLen + lLen)).toFixed(2)}"></circle>
                </svg>
                <div class="sn-inv-donut-center">
                  <span class="sn-inv-donut-pct" id="sn-inv-donut-pct">${healthyPct}%</span>
                  <span class="sn-inv-donut-lbl">Healthy</span>
                </div>
              </div>

              <div class="sn-inv-tier-legend">
                <button type="button" class="sn-inv-tier-btn" data-inv-chart-tier="HEALTHY" title="Filter table to Healthy SKUs (> 1.5x threshold)">
                  <div class="sn-inv-tier-btn-top">
                    <span class="sn-inv-tier-name"><span class="sn-inv-tier-dot" style="background:#1E6B3A;"></span>Healthy</span>
                    <strong id="sn-inv-tier-count-healthy" style="font-family:var(--sn-font-mono);font-size:0.92rem;color:#1E6B3A;">${healthyCount}</strong>
                  </div>
                  <span class="sn-inv-tier-rule">Stock &gt; 1.5&times; Min Alert</span>
                </button>
                <button type="button" class="sn-inv-tier-btn" data-inv-chart-tier="WATCH" title="Filter table to Watchlist SKUs (1.0x - 1.5x threshold)">
                  <div class="sn-inv-tier-btn-top">
                    <span class="sn-inv-tier-name"><span class="sn-inv-tier-dot" style="background:#D99B1A;"></span>Watchlist</span>
                    <strong id="sn-inv-tier-count-watch" style="font-family:var(--sn-font-mono);font-size:0.92rem;color:#92400E;">${watchCount}</strong>
                  </div>
                  <span class="sn-inv-tier-rule">1.0&times; to 1.5&times; Min Alert</span>
                </button>
                <button type="button" class="sn-inv-tier-btn" data-inv-chart-tier="LOW" title="Filter table to Low-Stock SKUs (<= threshold)">
                  <div class="sn-inv-tier-btn-top">
                    <span class="sn-inv-tier-name"><span class="sn-inv-tier-dot" style="background:#C85A17;"></span>Low Stock</span>
                    <strong id="sn-inv-tier-count-low" style="font-family:var(--sn-font-mono);font-size:0.92rem;color:#C85A17;">${lowCount}</strong>
                  </div>
                  <span class="sn-inv-tier-rule">Stock &le; Min Alert</span>
                </button>
                <button type="button" class="sn-inv-tier-btn" data-inv-chart-tier="OUT" title="Filter table to Out-of-Stock SKUs (0 packs)">
                  <div class="sn-inv-tier-btn-top">
                    <span class="sn-inv-tier-name"><span class="sn-inv-tier-dot" style="background:#B42318;"></span>Out of Stock</span>
                    <strong id="sn-inv-tier-count-out" style="font-family:var(--sn-font-mono);font-size:0.92rem;color:#B42318;">${outCount}</strong>
                  </div>
                  <span class="sn-inv-tier-rule">0 Packs Remaining</span>
                </button>
              </div>
            </div>
          </div>

          <div class="sn-inv-card-divider">
            <div class="sn-inv-chart-header" style="margin-bottom:6px;">
              <h3 class="sn-inv-chart-title" style="font-size:0.88rem;">Stock by Pack Weight (100 g • 250 g • 500 g • 1 kg)</h3>
              <span class="sn-inv-chart-badge">Click Pack to Filter</span>
            </div>
            <div class="sn-inv-pack-bars-grid" id="sn-inv-pack-bars-group">
              ${Array.from(packStatsMap.values()).map(ps => {
                const sharePct = totalPacks > 0 ? Math.round((ps.packs / totalPacks) * 100) : 0;
                return `
                  <div class="sn-inv-bar-row" data-inv-chart-pack="${escapeHtml(ps.label)}" title="Click to filter table to ${escapeHtml(ps.label)} packs">
                    <div class="sn-inv-bar-meta" style="margin-bottom:4px;">
                      <strong style="font-family:var(--sn-font-mono);color:var(--sn-bg-forest);">${escapeHtml(ps.label)}</strong>
                      <span style="font-family:var(--sn-font-mono);font-size:0.71rem;" data-inv-pack-summary="${escapeHtml(ps.label)}"><strong>${ps.packs.toLocaleString('en-IN')}</strong> packs (${sharePct}%)</span>
                    </div>
                    <div class="sn-inv-stacked-track" style="height:6px;">
                      <div class="sn-inv-stacked-seg" data-inv-pack-bar="${escapeHtml(ps.label)}" style="width:${Math.min(100, Math.max(14, sharePct * 2.2))}%;background:${ps.lowOrOutSkus > 0 ? '#C85A17' : 'var(--sn-bg-forest)'};"></div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        </div>

        <!-- Right Bento Box: Chart 2 (Category Stock Distribution) + Chart 3 (Top Restock Priority SKUs) -->
        <div class="sn-inv-chart-card" id="sn-inv-chart-distribution-card">
          <div class="sn-inv-card-section">
            <div class="sn-inv-chart-header">
              <h3 class="sn-inv-chart-title">2. Stock &amp; Valuation by Category</h3>
              <span class="sn-inv-chart-badge">Click Category to Filter</span>
            </div>
            <p class="sn-inv-chart-sub">Stacked SKU health bar (Green Healthy / Gold Watch / Red Low) &amp; category totals.</p>

            <div class="sn-inv-bar-group" id="sn-inv-cat-bars-group">
              ${Array.from(catStatsMap.values()).map(cs => {
                const tot = Math.max(1, cs.skuCount);
                const hPct = Math.round((cs.healthySkus / tot) * 100);
                const wPct = Math.round((cs.watchSkus / tot) * 100);
                const lPct = Math.max(0, 100 - hPct - wPct);
                const kg = (cs.weightGrams / 1000).toFixed(1);
                return `
                  <div class="sn-inv-bar-row" data-inv-chart-cat="${cs.id}" title="Click to filter inventory table to ${escapeHtml(cs.name)}">
                    <div class="sn-inv-bar-meta">
                      <strong style="color:var(--sn-bg-forest);white-space:nowrap;">${escapeHtml(cs.name)} <span style="font-weight:500;color:var(--sn-text-muted);font-size:0.71rem;">(${cs.skuCount} SKUs)</span></strong>
                      <span style="font-family:var(--sn-font-mono);font-size:0.72rem;white-space:nowrap;" data-inv-cat-summary="${cs.id}"><strong>${cs.packs.toLocaleString('en-IN')}</strong> packs • ${kg} kg • ${formatInr(cs.valuePaise)}</span>
                    </div>
                    <div class="sn-inv-stacked-track">
                      <div class="sn-inv-stacked-seg" data-inv-cat-seg-h="${cs.id}" style="width:${hPct}%;background:#1E6B3A;" title="Healthy: ${cs.healthySkus} SKUs"></div>
                      <div class="sn-inv-stacked-seg" data-inv-cat-seg-w="${cs.id}" style="width:${wPct}%;background:#E5B83B;" title="Watchlist: ${cs.watchSkus} SKUs"></div>
                      <div class="sn-inv-stacked-seg" data-inv-cat-seg-l="${cs.id}" style="width:${lPct}%;background:#B42318;" title="Low / Out: ${cs.lowOrOutSkus} SKUs"></div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>

          <div class="sn-inv-card-divider" id="sn-inv-chart-priority-card">
            <div class="sn-inv-chart-header" style="margin-bottom:6px;">
              <h3 class="sn-inv-chart-title" style="font-size:0.88rem;">3. Top Restock Priority SKUs (Stock vs. Min Alert)</h3>
              <span class="sn-inv-chart-badge">Click to Restock</span>
            </div>
            <div class="sn-inv-priority-list" id="sn-inv-priority-bars-list">
              ${prioritySkus.map(v => {
                const maxScale = Math.max(v.thresh * 3, v.qty, 30);
                const fillPct = Math.min(100, Math.round((v.qty / maxScale) * 100));
                const threshMarkerPct = Math.min(96, Math.round((v.thresh / maxScale) * 100));
                const barColor = v.tier === 'OUT' ? '#B42318' : (v.tier === 'LOW' ? '#C85A17' : (v.tier === 'WATCH' ? '#D99B1A' : '#1E6B3A'));
                return `
                  <div class="sn-inv-priority-item" data-inv-jump-variant="${v.id}" data-inv-jump-sku="${escapeHtml(v.sku)}" title="Click to jump to ${escapeHtml(v.sku)} (${escapeHtml(v.prodName)}) and focus stock input">
                    <div class="sn-inv-priority-head">
                      <span class="sn-inv-priority-label">
                        <strong style="font-family:var(--sn-font-mono);color:var(--sn-bg-forest);">${escapeHtml(v.sku)}</strong>
                        <span style="color:var(--sn-text-secondary);"> • ${escapeHtml(v.prodName)}</span>
                      </span>
                      <span style="font-family:var(--sn-font-mono);font-size:0.71rem;font-weight:700;color:${barColor};white-space:nowrap;">${v.qty} / &le;${v.thresh}</span>
                    </div>
                    <div class="sn-inv-bullet-track">
                      <div class="sn-inv-bullet-fill" style="width:${fillPct}%;background:${barColor};"></div>
                      <div class="sn-inv-bullet-marker" style="left:${threshMarkerPct}%;" title="Alert Threshold: ${v.thresh} packs"></div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        </div>
      </div>

      <!-- Tier 3: Full-Width Collapsible Product x 4-Pack Stock Heatmap Matrix -->
      <div class="sn-inv-heatmap-card" id="sn-inv-heatmap-card">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
          <div>
            <h3 class="sn-inv-chart-title" style="margin:0;">4. All ${products.length}-Product &times; 4-Pack Stock Heatmap Matrix (100g | 250g | 500g | 1kg)</h3>
            <span style="font-size:0.74rem;color:var(--sn-text-secondary);">Color-coded warehouse matrix across all ${variants.length} pack variants. Click any cell to jump directly to its stock input below.</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-family:var(--sn-font-mono);font-size:0.68rem;display:inline-flex;align-items:center;gap:4px;"><span class="sn-inv-tier-dot" style="background:#1E6B3A;"></span>Healthy</span>
            <span style="font-family:var(--sn-font-mono);font-size:0.68rem;display:inline-flex;align-items:center;gap:4px;"><span class="sn-inv-tier-dot" style="background:#D99B1A;"></span>Watch</span>
            <span style="font-family:var(--sn-font-mono);font-size:0.68rem;display:inline-flex;align-items:center;gap:4px;"><span class="sn-inv-tier-dot" style="background:#C85A17;"></span>Low</span>
            <span style="font-family:var(--sn-font-mono);font-size:0.68rem;display:inline-flex;align-items:center;gap:4px;"><span class="sn-inv-tier-dot" style="background:#B42318;"></span>Out</span>
            <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-inv-toggle-heatmap-btn" style="padding:3px 10px;font-size:0.72rem;">− Hide Heatmap</button>
          </div>
        </div>

        <div class="sn-inv-heatmap-grid" id="sn-inv-heatmap-grid">
          ${products.map(p => {
            const pVars = enrichedVariants
              .filter(v => Number(v.product_id) === Number(p.id))
              .sort((a, b) => Number(a.weight_grams) - Number(b.weight_grams));
            return `
              <div class="sn-inv-heatmap-prod">
                <div class="sn-inv-heatmap-prod-name" title="${escapeHtml(p.name)} (${escapeHtml(p.sku_base)})">${escapeHtml(p.name)}</div>
                ${pVars.map(v => {
                  const cellCls = v.tier === 'OUT'
                    ? 'sn-heatmap-out'
                    : (v.tier === 'LOW' ? 'sn-heatmap-low' : (v.tier === 'WATCH' ? 'sn-heatmap-watch' : 'sn-heatmap-healthy'));
                  const shortPack = v.weight_grams === 1000 ? '1kg' : `${v.weight_grams}g`;
                  return `
                    <button
                      type="button"
                      class="sn-inv-heatmap-cell ${cellCls}"
                      data-inv-heatmap-cell="${v.id}"
                      data-inv-jump-variant="${v.id}"
                      data-inv-jump-sku="${escapeHtml(v.sku)}"
                      title="${escapeHtml(v.sku)} • ${escapeHtml(p.name)} (${escapeHtml(v.pack_label)}): ${v.qty} packs in stock (Alert threshold <= ${v.thresh})"
                    >
                      <span data-inv-heatmap-qty="${v.id}">${v.qty}</span>
                      <span class="sn-inv-heatmap-cell-pack">${shortPack}</span>
                    </button>
                  `;
                }).join('')}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;
}

function slugifyBookmarkId(text, prefix = 'sec', usedSet = null) {
  const base = String(text || '')
    .toLowerCase()
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56) || 'section';
  const candidate = prefix ? `${prefix}-${base}` : base;
  if (!usedSet) return candidate;
  let uniqueId = candidate;
  let counter = 2;
  while (usedSet.has(uniqueId)) {
    uniqueId = `${candidate}-${counter}`;
    counter += 1;
  }
  usedSet.add(uniqueId);
  return uniqueId;
}

function renderBreadcrumbNav(breadcrumbs = [], basePath = '') {
  if (!Array.isArray(breadcrumbs) || breadcrumbs.length === 0) return '';
  return `
    <nav id="breadcrumb" class="sn-breadcrumb-nav" aria-label="Breadcrumb">
      <ol class="sn-breadcrumb-list">
        ${breadcrumbs.map((b, idx) => {
          const isLast = idx === breadcrumbs.length - 1;
          const href = b.url === '/' ? `${basePath}/` : `${basePath}${b.url}`;
          return `
            <li class="sn-breadcrumb-item">
              ${isLast
                ? `<span aria-current="page">${escapeHtml(b.name)}</span>`
                : `<a href="${escapeHtml(href)}">${escapeHtml(b.name)}</a>`
              }
            </li>
          `;
        }).join('')}
      </ol>
    </nav>
  `;
}

function renderSectionJumpBar() {
  return '';
}

function renderHeadingAnchor() {
  return '';
}

function getDynamicShippingCopy() {
  try {
    const pol = getShippingPolicyFromDb();
    const threshInr = Math.round(pol.freeThresholdPaise / 100);
    if (pol.freeMode === 'DISABLED') {
      const zoneABaseInr = Math.round(((pol.zones && pol.zones.ZONE_A && pol.zones.ZONE_A.base500gPaise) || 4000) / 100);
      const shippingPolicyClause = `Pan-India 4-Zone + 500g Weight-Slab Delivery (from ₹${zoneABaseInr})`;
      return {
        shippingPolicyClause,
        topbarHtml: `${shippingPolicyClause} | Use code <strong>SASHYA10</strong> for 10% off`,
        pdpShortText: `4-Zone Weight-Slab Delivery (from ₹${zoneABaseInr} / 500g)`
      };
    }
    if (pol.freeMode === 'UNCONDITIONAL_THRESHOLD') {
      const shippingPolicyClause = `Complimentary India-Wide Delivery on all orders above ₹${threshInr}`;
      return {
        shippingPolicyClause,
        topbarHtml: `${shippingPolicyClause} | Use code <strong>SASHYA10</strong> for 10% off`,
        pdpShortText: `Free delivery above ₹${threshInr}`
      };
    }
    const shippingPolicyClause = `Complimentary India-Wide Delivery on orders above ₹${threshInr} (up to ${(pol.freeMaxWeightGrams / 1000).toFixed(1)} kg)`;
    return {
      shippingPolicyClause,
      topbarHtml: `${shippingPolicyClause} | Use code <strong>SASHYA10</strong> for 10% off`,
      pdpShortText: `Free delivery above ₹${threshInr} (up to ${(pol.freeMaxWeightGrams / 1000).toFixed(1)} kg)`
    };
  } catch {
    const shippingPolicyClause = 'Complimentary India-Wide Delivery on orders above ₹799';
    return {
      shippingPolicyClause,
      topbarHtml: `${shippingPolicyClause} | Use code <strong>SASHYA10</strong> for 10% off`,
      pdpShortText: 'Free delivery above ₹799'
    };
  }
}

/**
 * Resolves the Storefront Hello Bar (.sn-topbar) state.
 * - If disabled or announcement content is empty, returns { visible: false } so the Hello Bar disappears completely.
 * - If linkedCouponCode is set and that coupon is not ACTIVE (expired, limit reached, paused, scheduled),
 *   either hides the entire bar ('HIDE_BAR') or strips the coupon clause ('STRIP_COUPON_CLAUSE').
 */
function resolveHelloBarForRender(helloBarConfig = null, shipCopy = getDynamicShippingCopy(), nowIst = null) {
  const cfg = helloBarConfig || (getStorefrontContentAndSeo().helloBar);
  if (!cfg || !cfg.enabled) {
    return { visible: false, announcementHtml: '', announcementPlain: '', badges: [], linkedCouponStatus: 'DISABLED' };
  }

  let rawText = String(cfg.templateText || '').trim();
  if (!rawText) {
    return { visible: false, announcementHtml: '', announcementPlain: '', badges: [], linkedCouponStatus: 'EMPTY_CONTENT' };
  }

  const linkedCode = String(cfg.linkedCouponCode || '').trim().toUpperCase();
  let linkedCouponStatus = 'NONE';
  if (linkedCode) {
    try {
      const db = getDb();
      const couponRow = db.prepare('SELECT * FROM coupons WHERE code = ?').get(linkedCode);
      const evalRes = evaluateCouponStatus(db, couponRow, { nowIst });
      linkedCouponStatus = evalRes.status;
      if (!evalRes.valid) {
        if (cfg.expiredCouponBehavior === 'HIDE_BAR') {
          return { visible: false, announcementHtml: '', announcementPlain: '', badges: [], linkedCouponStatus };
        }
        // Default: STRIP_COUPON_CLAUSE
        const segments = rawText.split(/\s*\|\s*/).map(s => s.trim()).filter(Boolean);
        if (segments.length > 1) {
          const codeRegex = new RegExp(`\\b${linkedCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          const filtered = segments.filter(seg => !codeRegex.test(seg) && !/\buse\s+code\b/i.test(seg));
          rawText = filtered.join(' | ').trim();
        } else {
          const codeRegex = new RegExp(`\\b${linkedCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          if (codeRegex.test(rawText) || /\buse\s+code\b/i.test(rawText)) {
            rawText = '';
          }
        }
      }
    } catch {
      // Fallback if DB is unavailable
    }
  }

  if (!rawText) {
    return { visible: false, announcementHtml: '', announcementPlain: '', badges: [], linkedCouponStatus };
  }

  const shippingClause = (shipCopy && shipCopy.shippingPolicyClause)
    ? shipCopy.shippingPolicyClause
    : 'Complimentary India-Wide Delivery on orders above ₹799';
  const expandedPlain = rawText.replace(/\{\{\s*SHIPPING_POLICY\s*\}\}/gi, shippingClause).trim();
  if (!expandedPlain) {
    return { visible: false, announcementHtml: '', announcementPlain: '', badges: [], linkedCouponStatus };
  }

  // Escape HTML and bold uppercase coupon tokens after "code " (e.g. Use code SASHYA10 -> Use code <strong>SASHYA10</strong>)
  let announcementHtml = escapeHtml(expandedPlain).replace(
    /\b(code\s+)([A-Z0-9_-]{3,24})\b/gi,
    (_, prefix, codeTok) => `${prefix}<strong>${codeTok}</strong>`
  );
  if (linkedCode && !announcementHtml.includes(`<strong>${escapeHtml(linkedCode)}</strong>`)) {
    const escapedLinked = escapeHtml(linkedCode);
    const exactCodeRe = new RegExp(`\\b(${escapedLinked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'g');
    announcementHtml = announcementHtml.replace(exactCodeRe, '<strong>$1</strong>');
  }

  const badges = [cfg.topbarBadge1, cfg.topbarBadge2, cfg.topbarBadge3]
    .map(b => String(b || '').trim())
    .filter(Boolean);

  return {
    visible: true,
    announcementHtml,
    announcementPlain: expandedPlain,
    badges,
    linkedCouponStatus
  };
}

function renderProductCard(p, variants = [], basePath = '', idPrefix = '') {
  const prodVariants = variants.filter(v => Number(v.product_id) === Number(p.id) && v.is_active);
  const defVar = prodVariants.find(v => v.pack_label === '250 g' && Number(v.stock_qty) > 0)
    || prodVariants.find(v => Number(v.stock_qty) > 0)
    || prodVariants.find(v => v.pack_label === '250 g')
    || prodVariants[0]
    || {
      id: 0,
      sku: p.sku_base,
      pack_label: '250 g',
      mrp_paise: 30000,
      selling_price_paise: 25000,
      stock_qty: 20
    };
  const defInStock = Number(defVar.stock_qty || 0) > 0;
  const totalStock = prodVariants.reduce((sum, v) => sum + Number(v.stock_qty || 0), 0);
  const savePct = defVar.mrp_paise > defVar.selling_price_paise
    ? Math.round(((defVar.mrp_paise - defVar.selling_price_paise) / defVar.mrp_paise) * 100)
    : 0;
  const minSellPaise = prodVariants.length > 0
    ? Math.min(...prodVariants.map(v => Number(v.selling_price_paise || 0)))
    : defVar.selling_price_paise;
  const pinRules = parseProductPincodeRules(p);
  const pinSummary = summarizePincodeRules(pinRules);

  return `
    <article
      class="sn-product-card"
      data-product-container="${p.id}"
      data-product-featured="${p.is_featured ? '1' : '0'}"
      data-product-bestseller="${p.is_bestseller ? '1' : '0'}"
      data-product-new="${p.is_new_arrival ? '1' : '0'}"
      data-product-instock="${totalStock > 0 ? '1' : '0'}"
      data-product-min-inr="${Math.round(minSellPaise / 100)}"
      data-product-pincode-rules="${escapeHtml(JSON.stringify(pinRules))}"
      id="${idPrefix}prod-card-${escapeHtml(p.slug)}"
    >
      <a href="${basePath}/product/${escapeHtml(p.slug)}" rel="bookmark" class="sn-product-media">
        <img src="${basePath}${escapeHtml(p.image_url)}" alt="${escapeHtml(p.name)}" data-product-img-id="${p.id}" loading="lazy" />
        <div class="sn-product-badges">
          ${p.is_bestseller ? `<span class="sn-badge sn-badge-bestseller">Bestseller</span>` : ''}
          ${p.is_new_arrival ? `<span class="sn-badge sn-badge-new">New Harvest</span>` : ''}
          ${pinSummary.hasRestriction ? `<span class="sn-badge" style="background-color:var(--sn-bg-forest);color:#FAF5E4;">${escapeHtml(pinSummary.shortBadge)}</span>` : ''}
        </div>
      </a>
      <div class="sn-product-content">
        <div class="sn-product-meta">
          <span data-sku-display>${escapeHtml(defVar.sku)}</span>
          <span>★ ${Number(p.rating_value || 4.8).toFixed(1)} (${Number(p.review_count || 24)})</span>
        </div>
        <div class="sn-product-origin-eyebrow">${escapeHtml(p.origin_region)}</div>
        <h3 class="sn-product-title">
          <a href="${basePath}/product/${escapeHtml(p.slug)}" rel="bookmark">${escapeHtml(p.name)}</a>
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
            <div style="display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;">
              <span class="sn-price-current" data-price-display>${formatInr(defVar.selling_price_paise)}</span>
              <span class="sn-price-mrp" data-mrp-display>MRP ${formatInr(defVar.mrp_paise)}</span>
              <span class="sn-price-save" data-save-display style="${savePct > 0 ? '' : 'display:none;'}">Save ${savePct}%</span>
            </div>
            <span class="sn-price-tax">Incl. ${p.gst_percent}% GST</span>
          </div>
          <button
            type="button"
            class="sn-btn sn-btn-forest sn-btn-sm"
            id="${idPrefix}add-btn-${escapeHtml(p.slug)}"
            data-add-to-cart
            data-variant-id="${defVar.id}"
            data-product-name="${escapeHtml(p.name)}"
            data-pack-label="${escapeHtml(defVar.pack_label)}"
            ${defInStock ? '' : 'disabled'}
          >${defInStock ? 'Add to Basket' : 'Out of Stock'}</button>
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
  const contentAndSeo = getStorefrontContentAndSeo();
  const hp = contentAndSeo.homepage;
  const helloBarRender = resolveHelloBarForRender(contentAndSeo.helloBar, shipCopy);
  const routeSeo = contentAndSeo.seoRoutes[canonicalPath] || null;
  const finalTitle = routeSeo && routeSeo.metaTitle ? routeSeo.metaTitle : title;
  const finalDescription = routeSeo && routeSeo.metaDescription ? routeSeo.metaDescription : description;
  const ogImgPath = routeSeo && routeSeo.ogImagePath ? routeSeo.ogImagePath : '/images/hero-pantry.jpg';

  const navCategories = getActiveNavCategories();
  const hasCategoryOverflow = navCategories.length > 3;
  const isOverflowCatActive = hasCategoryOverflow && navCategories.slice(2).some(c => c.slug === activeNav);
  const hasInlineBreadcrumbId = bodyHtml.includes('id="breadcrumb"');

  return `<!DOCTYPE html>
<html lang="en-IN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(finalTitle)}</title>
  <meta name="description" content="${escapeHtml(finalDescription)}" />
  <meta name="robots" content="${isNoIndex || IS_STAGING ? 'noindex, nofollow' : 'index, follow'}" />
  <meta name="theme-color" content="#212C64" />
  <meta name="application-name" content="${escapeHtml(BRAND_NAME)}" />
  <meta name="apple-mobile-web-app-title" content="${escapeHtml(BRAND_NAME)}" />
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
  <link rel="alternate" type="text/markdown" href="${escapeHtml(CANONICAL_ORIGIN + mdTwinPath)}" title="Markdown Version" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(finalTitle)}" />
  <meta property="og:description" content="${escapeHtml(finalDescription)}" />
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
  <meta property="og:site_name" content="${escapeHtml(BRAND_NAME)}" />
  <meta property="og:image" content="${escapeHtml(CANONICAL_ORIGIN)}${escapeHtml(ogImgPath)}" />
  <link rel="icon" type="image/webp" href="${basePath}/images/favicon.webp?v=${APP_VERSION}" />
  <link rel="icon" type="image/png" sizes="32x32" href="${basePath}/images/favicon-32.png?v=${APP_VERSION}" />
  <link rel="apple-touch-icon" sizes="180x180" href="${basePath}/images/apple-touch-icon.png?v=${APP_VERSION}" />
  <link rel="manifest" href="${basePath}/site.webmanifest?v=${APP_VERSION}" />
  <link rel="preload" href="${basePath}/assets/fonts/news701-bt-bold.ttf" as="font" type="font/ttf" crossorigin />
  <link rel="preload" href="${basePath}/assets/fonts/manrope-var-wght.ttf" as="font" type="font/ttf" crossorigin />
  <link rel="preload" href="${basePath}/assets/fonts/poppins-regular.ttf" as="font" type="font/ttf" crossorigin />
  <link rel="preload" href="${basePath}/assets/fonts/poppins-latin-500.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="preload" href="${basePath}/assets/fonts/poppins-latin-600.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="preload" href="${basePath}/assets/fonts/poppins-latin-700.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="stylesheet" href="${basePath}/assets/sasya-core.css?v=${APP_VERSION}" />
  <script type="application/ld+json">${JSON.stringify(schemaGraph)}</script>
</head>
<body>
  <a href="#app-mount" class="sn-skip-link" id="sn-skip-to-main">Skip to main content</a>
  ${helloBarRender.visible ? `
  <div class="sn-topbar" id="sn-hellobar">
    <div class="sn-container sn-topbar-inner">
      <span id="sn-dynamic-topbar-ship">${helloBarRender.announcementHtml}</span>
      ${helloBarRender.badges.length > 0 ? `
      <div class="sn-topbar-badges">
        ${helloBarRender.badges.map(b => `<span>${escapeHtml(b)}</span>`).join('')}
      </div>
      ` : ''}
    </div>
  </div>
  ` : ''}

  <header class="sn-header" id="site-header">
    <div class="sn-container sn-header-inner">
      <a href="${basePath}/" class="sn-brand" id="nav-brand-logo" aria-label="${escapeHtml(BRAND_NAME)} — Rooted in Trust">
        <img src="${basePath}/images/logo-horizontal.webp?v=${APP_VERSION}" alt="${escapeHtml(BRAND_NAME)} — Rooted in Trust" class="sn-brand-logo-img" width="116" height="36" />
      </a>
      <nav class="sn-nav ${hasCategoryOverflow ? 'sn-nav-has-overflow' : ''}" id="sn-main-nav" aria-label="Main Navigation" data-nav-cat-count="${navCategories.length}">
        <form action="${basePath}/shop" method="GET" class="sn-mobile-nav-search">
          <input type="search" name="q" placeholder="Search almonds, ragi, spices..." class="sn-input" aria-label="Search products on mobile" />
          <button type="submit" class="sn-btn sn-btn-forest sn-btn-sm">Search</button>
        </form>
        <a href="${basePath}/" class="${activeNav === 'home' ? 'sn-active' : ''}" id="nav-home">Home</a>
        <a href="${basePath}/shop" class="${activeNav === 'shop' ? 'sn-active' : ''}" id="nav-shop">All Catalogue</a>

        <!-- Desktop Priority+ Inline Category Pillars (All 3 shown when <=3; Top 2 shown when 4..15) -->
        ${navCategories.map((c, idx) => {
          const navId = c.slug === 'millets-grains' ? 'nav-millets' : `nav-${escapeHtml(c.slug)}`;
          const hideOnDesktopOverflow = hasCategoryOverflow && idx >= 2 ? 'sn-nav-cat-overflow-desktop' : '';
          return `<a href="${basePath}/category/${escapeHtml(c.slug)}" class="sn-nav-cat-inline ${hideOnDesktopOverflow} ${activeNav === c.slug ? 'sn-active' : ''}" id="${navId}" data-nav-cat-inline="${idx}" data-category-id="${c.id}">${escapeHtml(c.name)}</a>`;
        }).join('')}

        <!-- Desktop Priority+ "Categories (N) ▾" 2-Column Visual Popover Menu (Active when >3 Categories) -->
        <div class="sn-nav-dropdown-wrap" id="sn-nav-categories-dropdown-wrap" style="${hasCategoryOverflow ? '' : 'display:none;'}">
          <button
            type="button"
            class="sn-nav-dropdown-trigger ${isOverflowCatActive ? 'sn-active' : ''}"
            id="sn-nav-categories-trigger"
            aria-haspopup="true"
            aria-expanded="false"
            data-toggle-cat-popover
          >
            <span>Categories (<span id="sn-nav-cat-total-count">${navCategories.length}</span>)</span>
            <span class="sn-nav-dropdown-chevron" aria-hidden="true">▾</span>
          </button>
          <div class="sn-nav-categories-popover" id="sn-nav-categories-popover" role="menu" aria-label="All Pantry Categories">
            <div class="sn-nav-popover-head">
              <span>All Pantry Collections (<strong id="sn-nav-popover-count">${navCategories.length}</strong>)</span>
              <a href="${basePath}/shop" class="sn-nav-popover-all-link">View All Products &rarr;</a>
            </div>
            <div class="sn-nav-popover-grid" id="sn-nav-categories-popover-grid">
              ${navCategories.map(c => `
                <a href="${basePath}/category/${escapeHtml(c.slug)}" class="sn-nav-popover-card ${activeNav === c.slug ? 'sn-active' : ''}" role="menuitem" data-popover-cat-id="${c.id}">
                  <img src="${basePath}${escapeHtml(c.image_url || '/images/cat-spices.jpg')}" alt="${escapeHtml(c.name)}" data-category-img-id="${c.id}" loading="lazy" width="42" height="42" />
                  <div class="sn-nav-popover-card-body">
                    <div class="sn-nav-popover-card-title">
                      <strong>${escapeHtml(c.name)}</strong>
                      <span class="sn-nav-popover-badge">${c.productCount}</span>
                    </div>
                    <span class="sn-nav-popover-card-sub">${escapeHtml(c.subtitle || 'Farm-Direct Pantry')}</span>
                  </div>
                </a>
              `).join('')}
            </div>
          </div>
        </div>

        <!-- Mobile Drawer 2-Column Compact Category Grid (Scales cleanly up to 15+ categories without clipping) -->
        <div class="sn-mobile-cat-section" id="sn-mobile-cat-section">
          <div class="sn-mobile-cat-header">
            <span>Pantry Categories (<span id="sn-mobile-cat-count">${navCategories.length}</span>)</span>
          </div>
          <div class="sn-mobile-cat-grid ${navCategories.length > 3 ? 'sn-mobile-cat-grid-2col' : ''}" id="sn-mobile-cat-grid">
            ${navCategories.map(c => `
              <a href="${basePath}/category/${escapeHtml(c.slug)}" class="sn-mobile-cat-tile ${activeNav === c.slug ? 'sn-active' : ''}" data-mobile-cat-id="${c.id}">
                <img src="${basePath}${escapeHtml(c.image_url || '/images/cat-spices.jpg')}" alt="${escapeHtml(c.name)}" data-category-img-id="${c.id}" loading="lazy" width="30" height="30" />
                <span class="sn-mobile-cat-tile-name">${escapeHtml(c.name)}</span>
              </a>
            `).join('')}
          </div>
        </div>

        <a href="${basePath}/track-order" class="${activeNav === 'track' ? 'sn-active' : ''}" id="nav-track">Track Order</a>
        <a href="${basePath}/account" class="sn-mobile-nav-only ${activeNav === 'account' ? 'sn-active' : ''}" id="nav-account-mobile">My Account &amp; Saved Addresses</a>
      </nav>
      <div class="sn-header-actions">
        <form action="${basePath}/shop" method="GET" class="sn-header-search" id="sn-header-search-form">
          <input type="search" name="q" placeholder="Search almonds, ragi, spices..." class="sn-header-search-input" id="sn-header-search-input" aria-label="Search products" />
          <button type="submit" class="sn-header-search-btn" aria-label="Search">🔍</button>
        </form>
        <a href="${basePath}/account" class="sn-btn ${activeNav === 'account' ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm" id="header-account-btn" aria-label="My Account">
          <span class="sn-account-label-full">My Account</span>
          <span class="sn-account-label-compact" aria-hidden="true">👤</span>
        </a>
        <button type="button" class="sn-btn sn-btn-forest sn-btn-sm sn-cart-trigger" data-open-cart id="header-cart-btn">
          <span>Basket</span>
          <span class="sn-cart-count" data-cart-count>0</span>
        </button>
        <button type="button" class="sn-btn sn-btn-outline sn-btn-sm sn-hamburger" id="mobile-menu-btn" data-mobile-menu aria-label="Toggle Navigation Menu" aria-expanded="false">☰</button>
      </div>
    </div>
  </header>
  <script>(function(){try{var c=JSON.parse(localStorage.getItem('sn_cart_v1')||'[]'),n=c.reduce(function(a,i){return a+Number(i.quantity||1)},0);if(n>0)document.querySelectorAll('[data-cart-count]').forEach(function(e){e.textContent=String(n)})}catch(e){}})();</script>

  <main id="app-mount" data-ssr-rendered="true" data-app-version="${APP_VERSION}">
    <div id="webpage">
      ${hasInlineBreadcrumbId ? '' : '<nav id="breadcrumb" aria-label="Breadcrumb" style="display:none;"></nav>'}
      ${bodyHtml}
    </div>
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

  <footer class="sn-footer" id="site-footer">
    <div class="sn-container">
      <div class="sn-footer-grid">
        <div id="footer-brand">
          <h4>Sashya Naturals</h4>
          <p style="color:#EAEFF8;margin:0 0 14px;">
            ${escapeHtml(hp.footerBlurb)}
          </p>
          <div style="font-family:var(--sn-font-mono);font-size:0.76rem;color:#C8D0E8;">
            ${escapeHtml(hp.footerSupportLine)}
          </div>
        </div>
        <div id="footer-categories">
          <h4>Pantry Categories</h4>
          <ul id="sn-footer-categories-list">
            ${navCategories.slice(0, 8).map(c => `
              <li><a href="${basePath}/category/${escapeHtml(c.slug)}">${escapeHtml(c.name)}</a></li>
            `).join('')}
            <li><a href="${basePath}/shop">Full Product Catalogue (${navCategories.length} Categories)</a></li>
          </ul>
        </div>
        <div id="footer-customer-care">
          <h4>Customer Care</h4>
          <ul>
            <li><a href="${basePath}/track-order">Order &amp; Courier Tracking</a></li>
            <li><a href="${basePath}/checkout">Checkout (UPI / Cards / COD)</a></li>
            <li><a href="${basePath}/account">Customer Account</a></li>
            <li><a href="${basePath}/faq">Frequently Asked Questions</a></li>
            <li><a href="${basePath}/contact">Contact Us</a></li>
          </ul>
        </div>
        <div id="footer-policies">
          <h4>Policies &amp; Governance</h4>
          <ul>
            <li><a href="${basePath}/about">About Sashya Naturals</a></li>
            <li><a href="${basePath}/shipping-returns">Shipping, Cancellation &amp; Refunds</a></li>
            <li><a href="${basePath}/privacy">Privacy Policy</a></li>
            <li><a href="${basePath}/terms">Terms of Service</a></li>
            ${staticShowcaseScript ? `<li><a href="${basePath}/admin" id="footer-admin-link">Staff RBAC Admin Portal</a></li>` : ''}
          </ul>
        </div>
      </div>
      <div class="sn-footer-bottom">
        <span>${escapeHtml(hp.footerCopyrightLine || '© 2026 Sashya Naturals (sashyanaturals.com). All rights reserved.')}</span>
        <span>${staticShowcaseScript ? `Engine: Node.js 22 SSR + Rust WASM Commerce Core (v${APP_VERSION})` : 'FSSAI Licensed &amp; GST Compliant • 100% Farm-Direct Indian Pantry'}</span>
      </div>
    </div>
  </footer>
  ${staticShowcaseScript}
  <script src="${basePath}/assets/sasya-client.js?v=${APP_VERSION}" defer></script>
</body>
</html>`;
}

function renderHomePage({ categories, products, variants, basePath = '', staticShowcaseScript = '', isNoIndex = false }) {
  // Interleave featured products across all active categories for visual variety
  const featuredPool = products.filter(p => p.is_featured);
  const featured = [];
  const activeCatIds = categories.length > 0 ? categories.map(c => Number(c.id)) : [1, 2, 3];
  const byCat = activeCatIds.map(cid => featuredPool.filter(p => Number(p.category_id) === cid));
  for (let i = 0; i < 6; i++) {
    for (const group of byCat) {
      if (group[i] && featured.length < 6) featured.push(group[i]);
    }
  }
  for (const p of featuredPool) {
    if (featured.length < 6 && !featured.some(f => f.id === p.id)) featured.push(p);
  }
  const featuredIds = new Set(featured.map(p => p.id));
  const bestsellers = [
    ...products.filter(p => p.is_bestseller && !featuredIds.has(p.id)),
    ...products.filter(p => !p.is_bestseller && !featuredIds.has(p.id)),
    ...products.filter(p => p.is_bestseller && featuredIds.has(p.id))
  ].slice(0, 6);

  const contentAndSeo = getStorefrontContentAndSeo();
  const hp = contentAndSeo.homepage;
  const homeSeo = contentAndSeo.seoRoutes['/'] || {};
  const title = homeSeo.metaTitle || `${BRAND_NAME} | ${BRAND_TAGLINE}`;
  const description = homeSeo.metaDescription || 'Shop farm-direct Kashmiri almonds, Goan W240 cashews, unpolished native millets, and cold-milled Lakadong turmeric across India in 100 g to 1 kg packs.';

  const testimonialsSectionEyebrow = hp.testimonialsEyebrow || 'Verified Indian Households • Repeat Pantry Orders';
  const testimonialsSectionHeading = hp.testimonialsHeading || 'What Families Across India Say';
  const showTestimonials =
    hp.testimonialsEnabled !== false &&
    hp.testimonialsEnabled !== '0' &&
    hp.testimonialsEnabled !== 0 &&
    hp.testimonialsEnabled !== 'false';

  const sectionBookmarks = [
    { id: 'hero-banner', name: 'Farm-Direct Pantry Hero', shortLabel: 'Overview' },
    { id: 'trust-assurance', name: 'Quality & FSSAI Assurance', shortLabel: 'FSSAI Trust' },
    { id: 'pantry-categories', name: hp.homeCategoriesHeading || 'Shop by Category', shortLabel: 'Categories' },
    { id: 'featured-harvests', name: hp.homeFeaturedHeading || 'Featured Harvests', shortLabel: 'Featured' },
    { id: 'bestsellers', name: hp.homeBestsellersHeading || 'Pantry Best Sellers', shortLabel: 'Best Sellers' },
    ...(showTestimonials
      ? [{ id: 'customer-testimonials', name: testimonialsSectionHeading, shortLabel: 'Testimonials' }]
      : [])
  ];

  const schemaGraph = buildMasterSchemaGraph({
    pageType: 'website',
    canonicalPath: '/',
    title,
    description,
    breadcrumbs: [{ name: 'Home', url: '/' }],
    sectionBookmarks
  });

  const catSectionEyebrow =
    categories.length !== 3 && (!hp.homeCategoriesEyebrow || hp.homeCategoriesEyebrow === 'Three Core Pantry Pillars')
      ? `${categories.length} Curated Pantry Collections`
      : (hp.homeCategoriesEyebrow || 'Three Core Pantry Pillars');
  const catSectionHeading = hp.homeCategoriesHeading || 'Shop by Category';
  const featuredSectionEyebrow = hp.homeFeaturedEyebrow || 'Select Pack Size & Add Directly';
  const featuredSectionHeading = hp.homeFeaturedHeading || 'Featured Harvests';
  const bestsellersSectionEyebrow = hp.homeBestsellersEyebrow || 'Most Reordered Across India';
  const bestsellersSectionHeading = hp.homeBestsellersHeading || 'Pantry Best Sellers';

  const rawTestimonialList =
    Array.isArray(hp.testimonialsList) && hp.testimonialsList.length > 0
      ? hp.testimonialsList
      : [
          {
            name: hp.t1Name || 'Ananya Iyer',
            location: hp.t1Location || 'Indiranagar, Bengaluru',
            rating: hp.t1Rating || '5.0',
            product: hp.t1Product || 'Kashmiri Mamra Giri Almonds • 500 g Pack',
            quote:
              hp.t1Quote ||
              'The Mamra almonds have noticeably higher natural oil and crunch than supermarket packs. The resealable pouch keeps them crisp even during Bengaluru monsoons.'
          },
          {
            name: hp.t2Name || 'Vikramaditya Rao',
            location: hp.t2Location || 'Bandra West, Mumbai',
            rating: hp.t2Rating || '5.0',
            product: hp.t2Product || 'Haveri Finger Millet (Ragi) • 1 kg Pack',
            quote:
              hp.t2Quote ||
              'Unpolished Haveri ragi and foxtail millet cook evenly without gritty husks. Having batch numbers and lab-tested nutrition on every pack gives complete peace of mind.'
          },
          {
            name: hp.t3Name || 'Sneha Menon',
            location: hp.t3Location || 'Jubilee Hills, Hyderabad',
            rating: hp.t3Rating || '4.9',
            product: hp.t3Product || 'Meghalaya Lakadong Turmeric • 250 g Pack',
            quote:
              hp.t3Quote ||
              'Opening the Lakadong turmeric and Wayanad black pepper pouches fills the kitchen with aroma. You only need half a pinch compared to regular store-bought powders.'
          }
        ];
  const testimonialItems = rawTestimonialList.map((item, index) => ({
    idx: index + 1,
    name: item.name || 'Verified Household Buyer',
    location: item.location || 'Bengaluru, Karnataka',
    rating: item.rating || '5.0',
    product: item.product || 'Sashya Naturals Pantry Pack',
    quote: item.quote || ''
  }));
  const testimonialSlides = [];
  for (let i = 0; i < testimonialItems.length; i += 3) {
    testimonialSlides.push(testimonialItems.slice(i, i + 3));
  }
  const avgTestimonialRating = (
    testimonialItems.reduce((acc, item) => acc + (Number(item.rating) || 5.0), 0) /
    Math.max(1, testimonialItems.length)
  ).toFixed(1);

  const rawHeading = String(hp.heroHeading || 'A Little More Goodness, Every Day.').trim();
  let heroLine1 = rawHeading;
  let heroLine2 = '';
  if (rawHeading.includes('\n')) {
    const parts = rawHeading.split('\n').map(s => s.trim()).filter(Boolean);
    heroLine1 = parts[0] || rawHeading;
    heroLine2 = parts.slice(1).join(' ');
  } else if (rawHeading.includes(',')) {
    const commaIdx = rawHeading.indexOf(',');
    heroLine1 = rawHeading.slice(0, commaIdx + 1).trim();
    heroLine2 = rawHeading.slice(commaIdx + 1).trim();
  }

  const rawPackText = String(hp.heroPackSizesText || 'Available in convenient 100 g, 250 g, 500 g and 1 kg packs.').trim();
  const convMatch = rawPackText.match(/^(.*?\bconvenient\s+)(.+)$/i);
  const formattedPackSizesHtml = convMatch
    ? `${escapeHtml(convMatch[1])}<strong>${escapeHtml(convMatch[2])}</strong>`
    : escapeHtml(rawPackText).replace(/(\b\d+\s*(?:g|kg)\b)/gi, '<strong>$1</strong>');

  const rawHeroUrl = hp.heroImageUrl || '/images/hero-pouch-spread.jpg';
  const heroImgSrc = `${basePath}${escapeHtml(rawHeroUrl)}${rawHeroUrl === '/images/hero-pouch-spread.jpg' ? `?v=${APP_VERSION}` : ''}`;

  const bodyHtml = `
    <section class="sn-hero" id="hero-banner">
      <div class="sn-container sn-hero-shell">
        <div class="sn-hero-grid">
          <div class="sn-hero-copy">
            <div class="sn-hero-pill-eyebrow" id="hero-eyebrow-pill">${escapeHtml(hp.heroEyebrow)}</div>
            <h1 class="sn-hero-display-title">
              <span class="sn-hero-title-line1">${escapeHtml(heroLine1)}</span>
              ${heroLine2 ? `
              <span class="sn-hero-title-line2">
                <span>${escapeHtml(heroLine2)}</span>
                <svg class="sn-hero-title-swoosh" viewBox="0 0 180 26" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M4 19.5C44 6.2 114 4.5 175 15.2C138 11.8 70 14.2 10 23.2C4.2 24 1.5 20.4 4 19.5Z" fill="#F2C12E"/>
                  <path d="M12 15.4C54 6.4 118 5.4 166 13.2" stroke="#E5AF16" stroke-width="2.4" stroke-linecap="round"/>
                </svg>
              </span>
              ` : `
              <svg class="sn-hero-title-swoosh" viewBox="0 0 180 26" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M4 19.5C44 6.2 114 4.5 175 15.2C138 11.8 70 14.2 10 23.2C4.2 24 1.5 20.4 4 19.5Z" fill="#F2C12E"/>
                <path d="M12 15.4C54 6.4 118 5.4 166 13.2" stroke="#E5AF16" stroke-width="2.4" stroke-linecap="round"/>
              </svg>
              `}
            </h1>
            <p class="sn-hero-lead">
              ${escapeHtml(hp.heroLead)}
            </p>
            <div class="sn-hero-mobile-actions">
              <a href="${basePath}/shop" class="sn-btn sn-btn-forest sn-btn-sm sn-hero-mobile-cta">Shop All Harvests &rarr;</a>
              <a href="#pantry-categories" class="sn-btn sn-btn-outline sn-btn-sm sn-hero-mobile-cta-alt">Explore Categories</a>
            </div>
            <p class="sn-hero-body-text">
              ${escapeHtml(hp.heroBodyText || '')}
            </p>
            <div class="sn-hero-brush-ribbon" id="hero-highlight-ribbon">
              <svg class="sn-hero-brush-bg" viewBox="0 0 460 58" preserveAspectRatio="none" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M14 10C48 4 398 3 442 9C455 11 458 21 448 27C457 32 452 44 436 48C392 54 52 55 16 49C3 46 2 34 11 28C3 22 5 12 14 10Z" fill="url(#snBrushGrad)"/>
                <path d="M22 6C110 2 350 2 434 7" stroke="#F6D365" stroke-width="2" stroke-linecap="round" opacity="0.75"/>
                <path d="M26 52C120 55 340 55 428 50" stroke="#E5B228" stroke-width="2" stroke-linecap="round" opacity="0.7"/>
                <defs>
                  <linearGradient id="snBrushGrad" x1="0" y1="0" x2="460" y2="58" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stop-color="#F7D358"/>
                    <stop offset="50%" stop-color="#F2C12E"/>
                    <stop offset="100%" stop-color="#F5CC46"/>
                  </linearGradient>
                </defs>
              </svg>
              <span class="sn-hero-brush-text">${escapeHtml(hp.heroHighlightBanner || 'Pure | Natural | Wholesome')}</span>
            </div>
            <div class="sn-hero-pack-row" id="hero-pack-sizes-row">
              <svg class="sn-hero-pack-icon" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M7 11.5L11.5 5.5H24.5L29 11.5V28.5C29 29.88 27.88 31 26.5 31H9.5C8.12 31 7 29.88 7 28.5V11.5Z" stroke="#16215B" stroke-width="1.9" stroke-linejoin="round"/>
                <path d="M7 11.5H29" stroke="#16215B" stroke-width="1.9"/>
                <path d="M18 5.5V11.5" stroke="#16215B" stroke-width="1.7"/>
                <rect x="11" y="17" width="8" height="9" rx="1.2" stroke="#16215B" stroke-width="1.6"/>
                <path d="M13 21.5H17" stroke="#16215B" stroke-width="1.4" stroke-linecap="round"/>
                <path d="M23 15V28" stroke="#16215B" stroke-width="1.5" stroke-dasharray="2 2"/>
              </svg>
              <span class="sn-hero-pack-text">${formattedPackSizesHtml}</span>
            </div>
          </div>
          <div class="sn-hero-visual">
            <img src="${heroImgSrc}" alt="Sashya Naturals stand-up pouch surrounded by wooden bowls of dry fruits, native millets, and heirloom spices" class="sn-hero-pouch-img" />
          </div>
        </div>

        <div class="sn-hero-origins-bar" id="trust-assurance" aria-label="Regional Sourcing Origins">
          <div class="sn-hero-origin-item">
            <svg class="sn-hero-origin-icon" viewBox="0 0 56 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M6 42C6 22 15.5 8 28 8C40.5 8 50 22 50 42" stroke="#16215B" stroke-width="2" stroke-linecap="round"/>
              <path d="M7 42L21 22L29 33L36 24L49 42H7Z" stroke="#16215B" stroke-width="1.9" stroke-linejoin="round"/>
              <path d="M21 22L25 32L21 42H7L21 22Z" fill="#16215B" fill-opacity="0.14"/>
              <path d="M36 24L49 42H34L36 24Z" fill="#16215B"/>
              <path d="M17 28L21 26L24 29" stroke="#16215B" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <div class="sn-hero-origin-copy">
              <strong>${escapeHtml(hp.region1Title || 'Kashmir')}</strong>
              <span>${escapeHtml(hp.region1Sub || 'Dry Fruits')}</span>
            </div>
          </div>

          <div class="sn-hero-origin-item">
            <svg class="sn-hero-origin-icon" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <circle cx="26" cy="26" r="20" stroke="#16215B" stroke-width="2"/>
              <path d="M11 39C16 37 22 37 28 39C33 40.5 38 40 41 38.5" stroke="#16215B" stroke-width="1.8" stroke-linecap="round"/>
              <path d="M24 38C24.5 30 26 24 28.5 18" stroke="#16215B" stroke-width="2.4" stroke-linecap="round"/>
              <path d="M28.5 18C22 15 16 17 14 21" stroke="#16215B" stroke-width="2" stroke-linecap="round"/>
              <path d="M28.5 18C21 19 17 23 16 27" stroke="#16215B" stroke-width="1.9" stroke-linecap="round"/>
              <path d="M28.5 18C34 15 39 17 41 21" stroke="#16215B" stroke-width="2" stroke-linecap="round"/>
              <path d="M28.5 18C35 19.5 38 23.5 38.5 27.5" stroke="#16215B" stroke-width="1.9" stroke-linecap="round"/>
              <path d="M28.5 18C27 13 30 10 34 11" stroke="#16215B" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
            <div class="sn-hero-origin-copy">
              <strong>${escapeHtml(hp.region2Title || 'Goa')}</strong>
              <span>${escapeHtml(hp.region2Sub || 'Natural Produce')}</span>
            </div>
          </div>

          <div class="sn-hero-origin-item">
            <svg class="sn-hero-origin-icon" viewBox="0 0 54 50" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M7 42V25C7 13.5 16 6 27 6C38 6 47 13.5 47 25V42" stroke="#16215B" stroke-width="2" stroke-linecap="round"/>
              <path d="M11 42H43" stroke="#16215B" stroke-width="2" stroke-linecap="round"/>
              <path d="M27 11V15" stroke="#16215B" stroke-width="1.8" stroke-linecap="round"/>
              <path d="M21 23C21 18.5 23.5 15.5 27 15.5C30.5 15.5 33 18.5 33 23H21Z" fill="#16215B" fill-opacity="0.18" stroke="#16215B" stroke-width="1.8"/>
              <rect x="17" y="23" width="20" height="7" stroke="#16215B" stroke-width="1.8"/>
              <rect x="14" y="30" width="26" height="12" stroke="#16215B" stroke-width="1.8"/>
              <path d="M20 42V34M27 42V34M34 42V34" stroke="#16215B" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
            <div class="sn-hero-origin-copy">
              <strong>${escapeHtml(hp.region3Title || 'Karnataka')}</strong>
              <span>${escapeHtml(hp.region3Sub || 'Native Millets')}</span>
            </div>
          </div>

          <div class="sn-hero-origin-item">
            <svg class="sn-hero-origin-icon" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <circle cx="26" cy="26" r="20" stroke="#16215B" stroke-width="2"/>
              <path d="M12 39C18 37.5 25 38 39 39.5" stroke="#16215B" stroke-width="1.8" stroke-linecap="round"/>
              <path d="M23 39C23.5 31 25.5 24 28 18" stroke="#16215B" stroke-width="2.4" stroke-linecap="round"/>
              <path d="M28 18C21 15 15.5 17.5 13.5 22" stroke="#16215B" stroke-width="2" stroke-linecap="round"/>
              <path d="M28 18C21.5 20 17.5 24 17 28.5" stroke="#16215B" stroke-width="1.9" stroke-linecap="round"/>
              <path d="M28 18C34 15.5 39.5 18 41 22.5" stroke="#16215B" stroke-width="2" stroke-linecap="round"/>
              <path d="M28 18C34 20 37.5 24.5 37.5 28.5" stroke="#16215B" stroke-width="1.9" stroke-linecap="round"/>
            </svg>
            <div class="sn-hero-origin-copy">
              <strong>${escapeHtml(hp.region4Title || 'Kerala')}</strong>
              <span>${escapeHtml(hp.region4Sub || 'Wholesome Ingredients')}</span>
            </div>
          </div>

          <div class="sn-hero-origin-item">
            <svg class="sn-hero-origin-icon" viewBox="0 0 54 50" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M6 39V25C6 13.5 15.5 6 27 6C38.5 6 48 13.5 48 25V39" stroke="#16215B" stroke-width="2" stroke-linecap="round"/>
              <path d="M6 38L19 23L29 33L38 22L48 38C42 42 35 44 27 44C19 44 12 42 6 38Z" fill="#16215B" stroke="#16215B" stroke-width="1.8" stroke-linejoin="round"/>
              <path d="M12 37C18 35 25 35 33 38" stroke="#FAF5E4" stroke-width="1.6" stroke-linecap="round"/>
              <path d="M20 40C27 38.5 35 38.5 42 40.5" stroke="#FAF5E4" stroke-width="1.5" stroke-linecap="round"/>
              <path d="M22 15C24 13.5 27 13.5 29 15C31 13.5 34 14 35 16" stroke="#16215B" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
            <div class="sn-hero-origin-copy">
              <strong>${escapeHtml(hp.region5Title || 'Meghalaya')}</strong>
              <span>${escapeHtml(hp.region5Sub || 'Aromatic Spices')}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="sn-section" id="pantry-categories">
      <div class="sn-container">
        ${renderSectionJumpBar(sectionBookmarks, 'Jump to Section:')}
        <div class="sn-section-head">
          <div>
            <span class="sn-eyebrow" id="home-categories-eyebrow">${escapeHtml(catSectionEyebrow)}</span>
            <h2>${escapeHtml(catSectionHeading)}${renderHeadingAnchor('pantry-categories', catSectionHeading)}</h2>
          </div>
          <a href="${basePath}/shop" class="sn-btn sn-btn-outline sn-btn-sm">View All ${products.length} Products</a>
        </div>
        <div class="sn-category-grid" id="home-categories-grid" data-category-count="${categories.length}">
          ${categories.map(cat => `
            <a href="${basePath}/category/${escapeHtml(cat.slug)}" rel="bookmark" class="sn-category-card" id="cat-tile-${escapeHtml(cat.slug)}">
              <div class="sn-category-img-wrap">
                <img src="${basePath}${escapeHtml(cat.image_url)}" alt="${escapeHtml(cat.name)}" data-category-img-id="${cat.id}" loading="lazy" />
              </div>
              <div class="sn-category-body">
                <div>
                  <span class="sn-eyebrow">${escapeHtml(cat.subtitle)}</span>
                  <h3>${escapeHtml(cat.name)}</h3>
                  <p>${escapeHtml(cat.description)}</p>
                </div>
                <span style="font-weight:700;color:var(--sn-accent-terracotta);font-size:0.875rem;">Browse ${escapeHtml(cat.name)} &rarr;</span>
              </div>
            </a>
          `).join('')}
        </div>
      </div>
    </section>

    <section class="sn-section sn-section-alt" id="featured-harvests">
      <div class="sn-container">
        <div class="sn-section-head">
          <div>
            <span class="sn-eyebrow">${escapeHtml(featuredSectionEyebrow)}</span>
            <h2>${escapeHtml(featuredSectionHeading)}${renderHeadingAnchor('featured-harvests', featuredSectionHeading)}</h2>
          </div>
          <a href="${basePath}/shop" class="sn-btn sn-btn-forest sn-btn-sm">Browse All Packs</a>
        </div>
        <div class="sn-product-grid">
          ${featured.map(p => renderProductCard(p, variants, basePath)).join('')}
        </div>
      </div>
    </section>

    <section class="sn-section" id="bestsellers">
      <div class="sn-container">
        <div class="sn-section-head">
          <div>
            <span class="sn-eyebrow">${escapeHtml(bestsellersSectionEyebrow)}</span>
            <h2>${escapeHtml(bestsellersSectionHeading)}${renderHeadingAnchor('bestsellers', bestsellersSectionHeading)}</h2>
          </div>
        </div>
        <div class="sn-product-grid">
          ${bestsellers.map(p => renderProductCard(p, variants, basePath, featuredIds.has(p.id) ? 'bestseller-' : '')).join('')}
        </div>
      </div>
    </section>
    ${showTestimonials ? `
    <section class="sn-section sn-section-alt" id="customer-testimonials">
      <div class="sn-container">
        <div class="sn-section-head">
          <div>
            <span class="sn-eyebrow" id="home-testimonials-eyebrow">${escapeHtml(testimonialsSectionEyebrow)}</span>
            <h2>${escapeHtml(testimonialsSectionHeading)}${renderHeadingAnchor('customer-testimonials', testimonialsSectionHeading)}</h2>
          </div>
          <div class="sn-testimonials-header-controls">
            <div class="sn-testimonials-summary-badge" aria-label="Average Customer Rating">
              <span class="sn-testimonial-stars" aria-hidden="true">★★★★★</span>
              <strong>${escapeHtml(avgTestimonialRating)} / 5</strong>
              <span class="sn-testimonials-summary-sep">•</span>
              <span>✓ 100% Batch-Verified Buyers (${testimonialItems.length} Reviews)</span>
            </div>
            ${testimonialSlides.length > 1 ? `
            <div class="sn-testimonials-slider-controls" id="sn-testimonials-slider-controls">
              <button type="button" class="sn-testimonials-nav-btn" id="sn-testimonials-prev" aria-label="Previous 3 testimonials" title="Previous 3 testimonials">&larr;</button>
              <span class="sn-testimonials-slide-counter" id="sn-testimonials-slide-counter">1 / ${testimonialSlides.length}</span>
              <button type="button" class="sn-testimonials-nav-btn" id="sn-testimonials-next" aria-label="Next 3 testimonials" title="Next 3 testimonials">&rarr;</button>
            </div>
            ` : ''}
          </div>
        </div>
        <div class="sn-testimonials-slider-viewport" id="home-testimonials-slider" data-total-slides="${testimonialSlides.length}" data-total-cards="${testimonialItems.length}">
          <div class="sn-testimonials-slider-track" id="home-testimonials-grid">
            ${testimonialSlides.map((slideCards, slideIdx) => `
            <div class="sn-testimonials-slide" data-testimonial-slide="${slideIdx}" aria-hidden="${slideIdx === 0 ? 'false' : 'true'}">
              ${slideCards.map(item => {
                const initials = String(item.name || 'SN')
                  .trim()
                  .split(/\s+/)
                  .filter(Boolean)
                  .slice(0, 2)
                  .map(part => part[0].toUpperCase())
                  .join('') || 'SN';
                const numRating = Number(item.rating) || 5.0;
                const formattedRating = numRating.toFixed(1);
                return `
                <article class="sn-testimonial-card" id="home-testimonial-card-${item.idx}">
                  <div class="sn-testimonial-top">
                    <div class="sn-testimonial-rating-pill" aria-label="Rated ${escapeHtml(formattedRating)} out of 5 stars">
                      <span class="sn-testimonial-stars" aria-hidden="true">★★★★★</span>
                      <span class="sn-testimonial-rating-num">${escapeHtml(formattedRating)}</span>
                    </div>
                    <span class="sn-testimonial-verified-badge">✓ Verified Buyer</span>
                  </div>
                  <div class="sn-testimonial-product-pill">
                    <span aria-hidden="true">📦</span>
                    <span>${escapeHtml(item.product)}</span>
                  </div>
                  <blockquote class="sn-testimonial-quote">
                    &ldquo;${escapeHtml(item.quote)}&rdquo;
                  </blockquote>
                  <div class="sn-testimonial-author">
                    <div class="sn-testimonial-avatar" aria-hidden="true">${escapeHtml(initials)}</div>
                    <div class="sn-testimonial-author-meta">
                      <strong class="sn-testimonial-author-name">${escapeHtml(item.name)}</strong>
                      <span class="sn-testimonial-author-loc">${escapeHtml(item.location)}</span>
                    </div>
                  </div>
                </article>
                `;
              }).join('')}
            </div>
            `).join('')}
          </div>
        </div>
        ${testimonialSlides.length > 1 ? `
        <div class="sn-testimonials-dots-bar" id="sn-testimonials-dots" role="tablist" aria-label="Testimonials Slider Pages (3 per slide)">
          ${testimonialSlides.map((_, slideIdx) => `
          <button
            type="button"
            class="sn-testimonials-dot ${slideIdx === 0 ? 'sn-active' : ''}"
            data-testimonial-dot="${slideIdx}"
            aria-label="Show testimonials ${slideIdx * 3 + 1} to ${Math.min((slideIdx + 1) * 3, testimonialItems.length)}"
          ></button>
          `).join('')}
        </div>
        ` : ''}
      </div>
    </section>
    ` : ''}
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
  const shopInfo = !activeCategory ? (getStorefrontContentAndSeo().infoPages.shop || {}) : null;
  const shopHeading = shopInfo && shopInfo.title ? shopInfo.title : 'All Sashya Naturals Products';
  const shopEyebrow = shopInfo && shopInfo.subtitle ? shopInfo.subtitle : 'Complete D2C Pantry Catalogue';
  const shopLeadParagraph =
    shopInfo && Array.isArray(shopInfo.paragraphs) && shopInfo.paragraphs[0]
      ? shopInfo.paragraphs[0]
      : 'Browse all Sashya Naturals dry fruits, unpolished millets, and single-origin spices with 100 g, 250 g, 500 g, and 1 kg pack variants.';

  const title = activeCategory
    ? `${activeCategory.name} (${activeCategory.subtitle}) | ${BRAND_NAME}`
    : `All Natural Products Catalogue | ${BRAND_NAME}`;
  const description = activeCategory
    ? activeCategory.description
    : shopLeadParagraph;

  const breadcrumbs = [{ name: 'Home', url: '/' }];
  if (activeCategory) {
    breadcrumbs.push({ name: 'Catalogue', url: '/shop' });
    breadcrumbs.push({ name: activeCategory.name, url: canonicalPath });
  } else {
    breadcrumbs.push({ name: 'Catalogue', url: '/shop' });
  }

  const sectionBookmarks = [
    { id: 'collection-overview', name: activeCategory ? activeCategory.name : shopHeading, shortLabel: 'Overview' },
    { id: 'catalogue-filters', name: 'Category & Pack-Size Filters', shortLabel: 'Filters' },
    { id: 'product-grid', name: 'Product Catalogue Grid', shortLabel: `Products (${products.length})` },
    { id: 'catalogue-pagination', name: 'Catalogue Pagination', shortLabel: 'Pagination' }
  ];

  const schemaGraph = buildMasterSchemaGraph({
    pageType: 'collection',
    canonicalPath,
    title,
    description,
    breadcrumbs,
    categoryProducts: products,
    sectionBookmarks
  });

  const totalCount = totalMatchingCount !== null ? totalMatchingCount : products.length;
  const hasActiveFilters = Boolean(searchQuery || tagFilter !== 'all' || maxPriceInr !== 'all' || packFilter !== 'all' || sortBy !== 'featured');

  const MAX_VISIBLE_CAT_PILLS = 6;
  const activeInOverflow =
    Boolean(activeCategory) &&
    categories.findIndex(c => c.slug === activeCategory.slug) >= MAX_VISIBLE_CAT_PILLS;
  const visibleCatThreshold = activeInOverflow ? MAX_VISIBLE_CAT_PILLS - 1 : MAX_VISIBLE_CAT_PILLS;
  const isCatOverflowItem = (c, idx) =>
    categories.length > MAX_VISIBLE_CAT_PILLS &&
    idx >= visibleCatThreshold &&
    (!activeCategory || activeCategory.slug !== c.slug);
  const overflowCatCount = categories.filter((c, idx) => isCatOverflowItem(c, idx)).length;

  const bodyHtml = `
    <section class="sn-section">
      <div class="sn-container">
        ${renderBreadcrumbNav(breadcrumbs, basePath)}
        ${renderSectionJumpBar(sectionBookmarks, 'On This Page:')}
        <div class="sn-section-head" id="collection-overview">
          <div>
            <span class="sn-eyebrow">${activeCategory ? escapeHtml(activeCategory.subtitle) : escapeHtml(shopEyebrow)}</span>
            <h1>${activeCategory ? escapeHtml(activeCategory.name) : escapeHtml(shopHeading)}</h1>
            <p style="color:var(--sn-text-secondary);max-width:68ch;margin:8px 0 0;">${escapeHtml(description)}</p>
          </div>
        </div>

        <div id="catalogue-filters">
          <form class="sn-filter-bar" method="GET" action="${basePath}${canonicalPath}" id="catalog-filter-form">
            <div class="sn-catalog-category-tier">
              <div class="sn-catalog-tier-head">
                <span class="sn-catalog-tier-label">Pantry Collections (${categories.length})</span>
                <span class="sn-catalog-harvest-badge">
                  Showing ${products.length} of ${totalCount} Harvests
                </span>
              </div>
              <div class="sn-catalog-pill-rail" id="sn-catalog-pill-rail" role="navigation" aria-label="Pantry Category Collections">
                <a href="${basePath}/shop" class="sn-btn ${!activeCategory ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm">All Catalogue</a>
                ${categories.map((c, idx) => {
                  const isOverflow = isCatOverflowItem(c, idx);
                  const isActive = Boolean(activeCategory && activeCategory.slug === c.slug);
                  return `
                  <a href="${basePath}/category/${escapeHtml(c.slug)}" class="sn-btn ${isActive ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm${isOverflow ? ' sn-catalog-cat-overflow-hidden' : ''}"${isOverflow ? ' data-catalog-cat-overflow="true"' : ''}>${escapeHtml(c.name)}</a>
                `;
                }).join('')}
                ${overflowCatCount > 0 ? `
                <button type="button" class="sn-btn sn-btn-outline sn-btn-sm sn-catalog-more-cats-btn" id="sn-catalog-more-cats-btn" data-overflow-count="${overflowCatCount}" aria-expanded="false">+${overflowCatCount} More ${overflowCatCount === 1 ? 'Collection' : 'Collections'} &#9662;</button>
                ` : ''}
              </div>
            </div>

            <div class="sn-catalog-quick-strip" role="navigation" aria-label="Quick Filter Presets">
              <span class="sn-catalog-quick-label">Quick Filters:</span>
              <div class="sn-catalog-quick-chips">
                <a href="${basePath}${canonicalPath}?tag=bestseller${searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : ''}${sortBy !== 'featured' ? `&sort=${encodeURIComponent(sortBy)}` : ''}${maxPriceInr !== 'all' ? `&maxPrice=${encodeURIComponent(maxPriceInr)}` : ''}${packFilter !== 'all' ? `&pack=${encodeURIComponent(packFilter)}` : ''}" class="sn-catalog-quick-chip ${tagFilter === 'bestseller' ? 'sn-active' : ''}">★ Bestsellers</a>
                <a href="${basePath}${canonicalPath}?tag=new_arrival${searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : ''}${sortBy !== 'featured' ? `&sort=${encodeURIComponent(sortBy)}` : ''}${maxPriceInr !== 'all' ? `&maxPrice=${encodeURIComponent(maxPriceInr)}` : ''}${packFilter !== 'all' ? `&pack=${encodeURIComponent(packFilter)}` : ''}" class="sn-catalog-quick-chip ${tagFilter === 'new_arrival' ? 'sn-active' : ''}">New Harvests</a>
                <a href="${basePath}${canonicalPath}?maxPrice=250${searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : ''}${sortBy !== 'featured' ? `&sort=${encodeURIComponent(sortBy)}` : ''}${tagFilter !== 'all' ? `&tag=${encodeURIComponent(tagFilter)}` : ''}${packFilter !== 'all' ? `&pack=${encodeURIComponent(packFilter)}` : ''}" class="sn-catalog-quick-chip ${String(maxPriceInr) === '250' ? 'sn-active' : ''}">Under ₹250</a>
                <a href="${basePath}${canonicalPath}?tag=in_stock${searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : ''}${sortBy !== 'featured' ? `&sort=${encodeURIComponent(sortBy)}` : ''}${maxPriceInr !== 'all' ? `&maxPrice=${encodeURIComponent(maxPriceInr)}` : ''}${packFilter !== 'all' ? `&pack=${encodeURIComponent(packFilter)}` : ''}" class="sn-catalog-quick-chip ${tagFilter === 'in_stock' ? 'sn-active' : ''}">✓ In Stock Only</a>
                ${hasActiveFilters ? `<a href="${basePath}${canonicalPath}" class="sn-catalog-quick-chip sn-quick-chip-reset">✕ Clear Filters</a>` : ''}
              </div>
            </div>

            <div class="sn-catalog-controls-grid">
              <div class="sn-catalog-search-row">
                <input type="search" name="q" value="${escapeHtml(searchQuery)}" placeholder="Search almonds, ragi, cloves..." class="sn-input" style="flex:1.5 1 190px;" id="catalog-search-input" />
                <button
                  type="button"
                  class="sn-btn ${hasActiveFilters ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm sn-mobile-filter-toggle"
                  id="sn-mobile-filter-toggle-btn"
                  data-toggle-catalog-filters
                  aria-expanded="${hasActiveFilters ? 'true' : 'false'}"
                >⚙️ Filters &amp; Sort${hasActiveFilters ? ' • Active' : ''}</button>
              </div>
              <div class="sn-catalog-advanced-selects ${hasActiveFilters ? 'sn-filters-open' : ''}" id="sn-catalog-advanced-selects">
                <select class="sn-select" style="flex:1 1 165px;" id="catalog-category-jump-select" aria-label="Jump to Category" data-category-jump-select>
                  <option value="${basePath}/shop" ${!activeCategory ? 'selected' : ''}>Category: All (${categories.length})</option>
                  ${categories.map(c => `
                    <option value="${basePath}/category/${escapeHtml(c.slug)}" ${activeCategory && activeCategory.slug === c.slug ? 'selected' : ''}>Category: ${escapeHtml(c.name)}</option>
                  `).join('')}
                </select>
                <select name="tag" class="sn-select" style="flex:1 1 145px;" id="catalog-tag-select">
                  <option value="all" ${tagFilter === 'all' ? 'selected' : ''}>Filter: All Items</option>
                  <option value="bestseller" ${tagFilter === 'bestseller' ? 'selected' : ''}>Bestsellers Only</option>
                  <option value="featured" ${tagFilter === 'featured' ? 'selected' : ''}>Featured Only</option>
                  <option value="new_arrival" ${tagFilter === 'new_arrival' ? 'selected' : ''}>New Harvests</option>
                  <option value="in_stock" ${tagFilter === 'in_stock' ? 'selected' : ''}>In Stock Only</option>
                </select>
                <select name="maxPrice" class="sn-select" style="flex:1 1 155px;" id="catalog-price-select">
                  <option value="all" ${maxPriceInr === 'all' ? 'selected' : ''}>Starting Price: Any</option>
                  <option value="150" ${String(maxPriceInr) === '150' ? 'selected' : ''}>Starts Under ₹150</option>
                  <option value="250" ${String(maxPriceInr) === '250' ? 'selected' : ''}>Starts Under ₹250</option>
                  <option value="500" ${String(maxPriceInr) === '500' ? 'selected' : ''}>Starts Under ₹500</option>
                </select>
                <select name="pack" class="sn-select" style="flex:0.9 1 130px;" id="catalog-pack-select">
                  <option value="all" ${packFilter === 'all' ? 'selected' : ''}>Pack: All Sizes</option>
                  <option value="100 g" ${packFilter === '100 g' ? 'selected' : ''}>100 g Pack</option>
                  <option value="250 g" ${packFilter === '250 g' ? 'selected' : ''}>250 g Pack</option>
                  <option value="500 g" ${packFilter === '500 g' ? 'selected' : ''}>500 g Pack</option>
                  <option value="1 kg" ${packFilter === '1 kg' ? 'selected' : ''}>1 kg Pack</option>
                </select>
                <select name="sort" class="sn-select" style="flex:1 1 150px;" id="catalog-sort-select">
                  <option value="featured" ${sortBy === 'featured' ? 'selected' : ''}>Sort: Featured</option>
                  <option value="price_asc" ${sortBy === 'price_asc' ? 'selected' : ''}>Price: Low to High</option>
                  <option value="price_desc" ${sortBy === 'price_desc' ? 'selected' : ''}>Price: High to Low</option>
                </select>
                <button type="submit" class="sn-btn sn-btn-primary sn-btn-sm" id="catalog-search-btn">Apply Filters</button>
                ${hasActiveFilters ? `<a href="${basePath}${canonicalPath}" class="sn-btn sn-btn-outline sn-btn-sm" id="catalog-reset-btn">Reset</a>` : ''}
              </div>
            </div>
          </form>
        </div>

        <div id="product-grid">
          <div class="sn-product-grid" id="sn-catalog-product-grid">
            ${products.length > 0
              ? products.map(p => renderProductCard(p, variants, basePath)).join('')
              : `<div class="sn-card"><p>No matching products found for your active filters. <a href="${basePath}${canonicalPath}" style="color:var(--sn-accent-terracotta);font-weight:600;">Reset filters</a></p></div>`
            }
          </div>
        </div>

        <div id="catalogue-pagination">
          <div class="sn-card" style="margin-top:24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;padding:14px 20px;" id="sn-catalog-pagination-bar">
            <div style="font-family:var(--sn-font-mono);font-size:0.8rem;color:var(--sn-text-secondary);" id="sn-catalog-count-label">
              Showing <strong>${products.length}</strong> of <strong>${totalCount}</strong> products${totalPages > 1 ? ` (Page ${currentPage} of ${totalPages})` : ''}
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              ${totalPages > 1 ? Array.from({ length: totalPages }, (_, i) => i + 1).map(pg => `
                <a
                  href="${basePath}${canonicalPath}?page=${pg}${searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : ''}${sortBy !== 'featured' ? `&sort=${encodeURIComponent(sortBy)}` : ''}${tagFilter !== 'all' ? `&tag=${encodeURIComponent(tagFilter)}` : ''}${maxPriceInr !== 'all' ? `&maxPrice=${encodeURIComponent(maxPriceInr)}` : ''}${packFilter !== 'all' ? `&pack=${encodeURIComponent(packFilter)}` : ''}"
                  class="sn-btn ${pg === currentPage ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm"
                >Page ${pg}</a>
              `).join('') : ''}
              ${totalPages > 1 ? `
                <a href="${basePath}${canonicalPath}?limit=all${searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : ''}${sortBy !== 'featured' ? `&sort=${encodeURIComponent(sortBy)}` : ''}${tagFilter !== 'all' ? `&tag=${encodeURIComponent(tagFilter)}` : ''}${maxPriceInr !== 'all' ? `&maxPrice=${encodeURIComponent(maxPriceInr)}` : ''}${packFilter !== 'all' ? `&pack=${encodeURIComponent(packFilter)}` : ''}" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-catalog-load-all-btn">View All (${totalCount})</a>
              ` : `
                <span style="font-family:var(--sn-font-mono);font-size:0.75rem;color:var(--sn-text-muted);">All matching packs displayed</span>
              `}
            </div>
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
  const pdpSavePct = defVar.mrp_paise > defVar.selling_price_paise
    ? Math.round(((defVar.mrp_paise - defVar.selling_price_paise) / defVar.mrp_paise) * 100)
    : 0;

  let extraGallery = [];
  try {
    extraGallery = JSON.parse(product.gallery_json || '[]');
    if (!Array.isArray(extraGallery)) extraGallery = [];
  } catch {
    extraGallery = [];
  }
  const allGalleryPhotos = [
    { url: product.image_url, caption: product.image_caption || `${product.name} (Primary Harvest Macro View)` },
    ...extraGallery.filter(g => g.url && g.url !== product.image_url)
  ];
  if (allGalleryPhotos.length < 2) {
    const fallbackSecondUrl = (category && category.image_url && category.image_url !== product.image_url)
      ? category.image_url
      : '/images/hero-pantry.jpg';
    allGalleryPhotos.push({
      url: fallbackSecondUrl,
      caption: `${category.name} Regional Harvest Spread & Nitrogen-Flushed Pouch Batch ${product.harvest_batch}`
    });
  }

  const breadcrumbs = [
    { name: 'Home', url: '/' },
    { name: category.name, url: `/category/${category.slug}` },
    { name: product.name, url: canonicalPath }
  ];

  const sectionBookmarks = [
    { id: 'pack-variants', name: 'Pack-Size Variants & Pricing', shortLabel: 'Pack Sizes & Price' },
    { id: 'delivery-checker', name: 'Delivery PIN Serviceability Checker', shortLabel: 'Delivery PIN Check' },
    { id: 'origin-compliance', name: 'Origin, Batch & FSSAI Compliance', shortLabel: 'Origin & FSSAI' },
    { id: 'nutrition-facts', name: 'Nutritional Value (Per 100 g)', shortLabel: 'Nutrition (Per 100g)' },
    { id: 'related-products', name: `More from ${category.name}`, shortLabel: 'Related Harvests' }
  ];

  const schemaGraph = buildMasterSchemaGraph({
    pageType: 'product',
    canonicalPath,
    title,
    description,
    breadcrumbs,
    product: { ...product, category_name: category.name },
    variants: activeVariants,
    sectionBookmarks
  });

  const pinRules = parseProductPincodeRules(product);
  const pinSummary = summarizePincodeRules(pinRules);

  const bodyHtml = `
    <section class="sn-section">
      <div class="sn-container">
        ${renderBreadcrumbNav(breadcrumbs, basePath)}
        ${renderSectionJumpBar(sectionBookmarks, 'Product Sections:')}

        <div class="sn-pdp-grid sn-pdp-main-layout" id="product" data-product-container="${product.id}" data-product-pincode-rules="${escapeHtml(JSON.stringify(pinRules))}">
          <div class="sn-pdp-gallery">
            <img src="${basePath}${escapeHtml(product.image_url)}" alt="${escapeHtml(product.name)}" id="sn-pdp-main-img" data-product-img-id="${product.id}" />
            <div id="sn-pdp-main-caption" style="padding:12px 18px;background-color:var(--sn-bg-mortar);font-family:var(--sn-font-mono);font-size:0.76rem;color:var(--sn-text-secondary);">
              ${escapeHtml(product.image_caption || product.name)} | Origin: ${escapeHtml(product.origin_region)}
            </div>
            ${allGalleryPhotos.length > 1 ? `
              <div style="display:flex;gap:10px;padding:12px 18px;background-color:var(--sn-bg-surface);border-top:1px solid var(--sn-border-warm);overflow-x:auto;align-items:center;">
                ${allGalleryPhotos.map((g, idx) => `
                  <button
                    type="button"
                    class="sn-btn sn-btn-outline sn-btn-sm"
                    data-pdp-thumb-url="${basePath}${escapeHtml(g.url)}"
                    data-pdp-thumb-caption="${escapeHtml(g.caption || product.name)}"
                    style="padding:3px 8px 3px 3px;border-radius:6px;gap:8px;"
                  >
                    <img src="${basePath}${escapeHtml(g.url)}" alt="${escapeHtml(g.caption || `View ${idx + 1}`)}" style="width:52px;height:52px;object-fit:cover;border-radius:4px;" />
                    <span style="font-family:var(--sn-font-mono);font-size:0.72rem;text-align:left;line-height:1.25;">
                      <strong>View ${idx + 1}</strong><br/>
                      <span style="color:var(--sn-text-muted);font-weight:400;">${idx === 0 ? 'Harvest Close-Up' : 'Pantry Spread'}</span>
                    </span>
                  </button>
                `).join('')}
              </div>
            ` : ''}
          </div>

          <div class="sn-pdp-info-col">
            <span class="sn-eyebrow sn-eyebrow-pill">${escapeHtml(category.name)} • ${escapeHtml(product.origin_region)} • Batch ${escapeHtml(product.harvest_batch)}</span>
            <h1 class="sn-pdp-title">${escapeHtml(product.name)}</h1>
            <div class="sn-pdp-meta-strip" style="display:flex;align-items:center;gap:16px;font-family:var(--sn-font-mono);font-size:0.8rem;color:var(--sn-text-muted);margin-bottom:16px;flex-wrap:wrap;">
              <span>SKU: <strong data-sku-display>${escapeHtml(defVar.sku)}</strong></span>
              <span>Rating: ★ ${Number(product.rating_value).toFixed(1)} (${product.review_count} verified buyers)</span>
              <span class="sn-status ${Number(defVar.stock_qty) > 0 ? 'sn-status-paid' : 'sn-status-danger'}" data-stock-display>${Number(defVar.stock_qty) > 0 ? `In Stock (${defVar.stock_qty} packs)` : 'Out of Stock'}</span>
            </div>

            <p class="sn-pdp-story-desc" style="font-size:1rem;color:var(--sn-text-primary);margin-bottom:20px;">${escapeHtml(product.description)}</p>

            <div class="sn-card" id="pack-variants" style="margin-bottom:24px;">
              <div style="font-family:var(--sn-font-mono);font-size:0.76rem;text-transform:uppercase;color:var(--sn-text-muted);margin-bottom:8px;">
                1. Choose Pack-Size Variant (Prices Inclusive of ${product.gst_percent}% GST)
              </div>
              <div class="sn-pack-selector">
                ${activeVariants.map(v => {
                  const vSavePct = v.mrp_paise > v.selling_price_paise
                    ? Math.round(((v.mrp_paise - v.selling_price_paise) / v.mrp_paise) * 100)
                    : 0;
                  return `
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
                    style="padding:8px 4px;"
                  >
                    <span>${escapeHtml(v.pack_label)}</span>
                    <span style="font-size:0.72rem;opacity:0.9;">${formatInr(v.selling_price_paise)}</span>
                    ${vSavePct > 0 ? `<span class="sn-pack-pill-save">Save ${vSavePct}%</span>` : ''}
                  </button>
                  `;
                }).join('')}
              </div>

              <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;padding-top:12px;border-top:1px solid var(--sn-border-warm);">
                <div>
                  <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
                    <span class="sn-price-current" style="font-size:1.65rem;" data-price-display>${formatInr(defVar.selling_price_paise)}</span>
                    <span class="sn-price-mrp" style="font-size:0.9rem;" data-mrp-display>MRP ${formatInr(defVar.mrp_paise)}</span>
                    <span class="sn-price-save" data-save-display style="${pdpSavePct > 0 ? '' : 'display:none;'}">Save ${pdpSavePct}%</span>
                  </div>
                  <span style="font-size:0.76rem;color:var(--sn-text-muted);">Inclusive of ${product.gst_percent}% GST | ${escapeHtml(shipCopy.pdpShortText)}</span>
                </div>

                <div class="sn-pdp-cta-row" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                  <div class="sn-qty-stepper" aria-label="Pack Quantity">
                    <button type="button" class="sn-qty-step-btn" data-pdp-qty-delta="-1" aria-label="Decrease quantity">&minus;</button>
                    <input type="number" id="sn-pdp-qty" value="1" min="1" max="20" class="sn-input" aria-label="Quantity" />
                    <button type="button" class="sn-qty-step-btn" data-pdp-qty-delta="1" aria-label="Increase quantity">+</button>
                  </div>
                  <button
                    type="button"
                    class="sn-btn sn-btn-primary"
                    id="pdp-add-to-cart-btn"
                    data-add-to-cart
                    data-variant-id="${defVar.id}"
                    data-product-name="${escapeHtml(product.name)}"
                    data-pack-label="${escapeHtml(defVar.pack_label)}"
                    ${Number(defVar.stock_qty) > 0 ? '' : 'disabled'}
                  >${Number(defVar.stock_qty) > 0 ? 'Add Pack to Basket' : 'Out of Stock'}</button>
                  <button
                    type="button"
                    class="sn-btn sn-btn-forest"
                    id="pdp-buy-now-btn"
                    data-buy-now
                    data-variant-id="${defVar.id}"
                    data-product-name="${escapeHtml(product.name)}"
                    data-pack-label="${escapeHtml(defVar.pack_label)}"
                    ${Number(defVar.stock_qty) > 0 ? '' : 'disabled'}
                  >Buy Now &rarr;</button>
                </div>
              </div>

              <!-- Instant 6-Digit PIN Delivery & Zone Freight Estimator (with Per-Product PIN Restriction Gate) -->
              <div id="delivery-checker" style="margin-top:14px;padding-top:12px;border-top:1px dashed var(--sn-border-warm);display:flex;flex-direction:column;gap:8px;">
                ${pinSummary.hasRestriction ? `
                  <div id="sn-pdp-pin-restriction-banner" style="padding:6px 10px;border-radius:6px;background-color:var(--sn-bg-parchment);border:1px solid var(--sn-border-strong);font-family:var(--sn-font-mono);font-size:0.73rem;color:var(--sn-bg-forest);">
                    <strong>${escapeHtml(pinSummary.shortBadge)}</strong> — ${escapeHtml(pinSummary.detailText)}
                  </div>
                ` : ''}
                <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
                  <div class="sn-pdp-pin-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <label for="sn-pdp-pin-input" style="font-family:var(--sn-font-mono);font-size:0.74rem;color:var(--sn-text-secondary);white-space:nowrap;">📍 Delivery PIN:</label>
                    <input
                      type="text"
                      id="sn-pdp-pin-input"
                      maxlength="6"
                      placeholder="560038"
                      value="560038"
                      data-product-id="${product.id}"
                      data-product-pincode-rules="${escapeHtml(JSON.stringify(pinRules))}"
                      class="sn-input"
                      style="width:104px;padding:5px 8px;min-height:32px;font-family:var(--sn-font-mono);font-size:0.78rem;"
                    />
                    <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-pdp-pin-check-btn" style="min-height:32px;padding:4px 10px;white-space:nowrap;flex-shrink:0;">Check PIN</button>
                  </div>
                  <span id="sn-pdp-pin-result" class="sn-status sn-status-paid" style="font-family:var(--sn-font-mono);font-size:0.73rem;">
                    ✓ Zone A (Local Bengaluru • 1-2 Days) • Prepaid &amp; COD Available
                  </span>
                </div>
              </div>
            </div>

            ${(() => {
              const nut = parseProductNutrition(product);
              return `
              <div class="sn-pdp-spec-card" data-pdp-spec-container>
                <div class="sn-admin-subnav-bar sn-pdp-spec-tabbar" role="tablist" aria-label="Product Specifications and Nutritional Information" style="margin-bottom:0;border-bottom-left-radius:0;border-bottom-right-radius:0;border-bottom:none;">
                  <button type="button" class="sn-admin-subtab-pill sn-active" id="tab-btn-origin-compliance" data-pdp-spec-tab="compliance" role="tab" aria-selected="true" aria-controls="origin-compliance">📋 Origin, Batch &amp; FSSAI Compliance</button>
                  <button type="button" class="sn-admin-subtab-pill" id="tab-btn-nutrition-facts" data-pdp-spec-tab="nutrition" role="tab" aria-selected="false" aria-controls="nutrition-facts">🥗 Nutritional Value (Per 100 g)</button>
                </div>

                <!-- Tab 1: Origin, Harvest Batch & FSSAI Labelling -->
                <div id="origin-compliance" data-pdp-spec-pane="compliance" role="tabpanel" aria-labelledby="tab-btn-origin-compliance">
                  <table class="sn-spec-table" aria-label="Product Origin and FSSAI Compliance" style="margin-top:0;border-top-left-radius:0;border-top-right-radius:0;">
                    <tbody>
                      <tr><th>Growing Region / Origin</th><td>${escapeHtml(product.origin_region)}</td></tr>
                      <tr><th>Harvest Batch &amp; Best Before</th><td>Batch ${escapeHtml(product.harvest_batch)} • Best before ${product.shelf_life_months} months from packing</td></tr>
                      <tr><th>Ingredients</th><td>${escapeHtml(product.ingredients)}</td></tr>
                      <tr><th>Allergen Information</th><td>${escapeHtml(product.allergen_info)}</td></tr>
                      <tr><th>Food Safety &amp; Storage Notes</th><td>${escapeHtml(product.fssai_notes)}</td></tr>
                      <tr><th>Key Phytonutrient Highlight</th><td><strong>${escapeHtml(nut.bioactive_label)}:</strong> ${escapeHtml(nut.bioactive_value)}</td></tr>
                      <tr><th>Available Pack Weights</th><td>100 g, 250 g, 500 g, and 1 kg nitrogen-flushed stand-up pouches</td></tr>
                    </tbody>
                  </table>
                </div>

                <!-- Tab 2: Structured FSSAI Per-100g Nutritional Profile (100% SSR Rendered for SEO & AEO) -->
                <div id="nutrition-facts" data-pdp-spec-pane="nutrition" role="tabpanel" aria-labelledby="tab-btn-nutrition-facts" style="display:none;background-color:var(--sn-bg-surface);border:1px solid var(--sn-border-warm);border-bottom-left-radius:var(--sn-radius-sm);border-bottom-right-radius:var(--sn-radius-sm);padding:14px 16px;">
                  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 12px;margin-bottom:12px;background-color:var(--sn-status-paid-bg);border:1px solid var(--sn-bg-forest);border-radius:var(--sn-radius-sm);">
                    <span style="font-family:var(--sn-font-mono);font-size:0.75rem;font-weight:700;color:var(--sn-bg-forest);">★ ${escapeHtml(nut.bioactive_label)}</span>
                    <span style="font-family:var(--sn-font-mono);font-size:0.78rem;font-weight:700;color:var(--sn-accent-terracotta);">${escapeHtml(nut.bioactive_value)}</span>
                  </div>

                  <div class="sn-pdp-macro-grid" style="margin-bottom:12px;">
                    <div class="sn-pdp-macro-tile">
                      <span class="sn-pdp-macro-label">Energy</span>
                      <strong class="sn-pdp-macro-val">${nut.energy_kcal} kcal</strong>
                    </div>
                    <div class="sn-pdp-macro-tile">
                      <span class="sn-pdp-macro-label">Protein</span>
                      <strong class="sn-pdp-macro-val">${nut.protein_g} g</strong>
                    </div>
                    <div class="sn-pdp-macro-tile">
                      <span class="sn-pdp-macro-label">Dietary Fiber</span>
                      <strong class="sn-pdp-macro-val">${nut.dietary_fiber_g} g</strong>
                    </div>
                    <div class="sn-pdp-macro-tile">
                      <span class="sn-pdp-macro-label">Total Fat</span>
                      <strong class="sn-pdp-macro-val">${nut.total_fat_g} g</strong>
                    </div>
                  </div>

                  <table class="sn-spec-table" aria-label="Nutritional Facts Per 100 Grams" style="margin-top:0;">
                    <tbody>
                      <tr><th>Serving Basis</th><td><strong>Per 100 g Edible Portion</strong> (FSSAI Standard)</td></tr>
                      <tr><th>Total Carbohydrates</th><td>${nut.carbs_g} g (of which Dietary Fiber: ${nut.dietary_fiber_g} g)</td></tr>
                      <tr><th>Total Sugars / Added Sugars</th><td>Total Sugars: ${nut.total_sugars_g} g • <strong>Added Sugars: ${nut.added_sugars_g} g</strong></td></tr>
                      <tr><th>Fat Breakdown</th><td>Total Fat: ${nut.total_fat_g} g • Saturated Fat: ${nut.saturated_fat_g} g • <strong>Trans Fat: ${nut.trans_fat_g} g</strong></td></tr>
                      <tr><th>Sodium</th><td>${nut.sodium_mg} mg</td></tr>
                    </tbody>
                  </table>
                  <div style="font-family:var(--sn-font-mono);font-size:0.71rem;color:var(--sn-text-muted);margin-top:8px;">
                    Reference: IFCT 2017 (ICMR-NIN Indian Food Composition Tables) &amp; Batch Lab Analysis. Natural unpolished agricultural produce exhibits minor seasonal variance.
                  </div>
                </div>
              </div>
              `;
            })()}
          </div>
        </div>
      </div>
    </section>

    <section class="sn-section sn-section-alt" id="related-products">
      <div class="sn-container">
        <div class="sn-section-head">
          <h2>More from ${escapeHtml(category.name)}${renderHeadingAnchor('related-products', `More from ${category.name}`)}</h2>
        </div>
        <div class="sn-product-grid">
          ${relatedProducts.map(rp => renderProductCard(rp, allVariants, basePath)).join('')}
        </div>
      </div>
    </section>

    <div class="sn-pdp-sticky-bar" id="sn-pdp-sticky-bar" data-product-container="${product.id}" aria-label="Quick Mobile Purchase Bar">
      <div class="sn-pdp-sticky-meta">
        <span class="sn-pdp-sticky-pack" data-sticky-pdp-pack>${escapeHtml(defVar.pack_label)} Pack</span>
        <div class="sn-pdp-sticky-price-row">
          <strong class="sn-pdp-sticky-price" data-sticky-pdp-price>${formatInr(defVar.selling_price_paise)}</strong>
          <span class="sn-pdp-sticky-tax">Incl. GST</span>
        </div>
      </div>
      <div class="sn-pdp-sticky-actions">
        <button
          type="button"
          class="sn-btn sn-btn-primary sn-btn-sm"
          id="pdp-sticky-add-btn"
          data-add-to-cart
          data-variant-id="${defVar.id}"
          data-product-name="${escapeHtml(product.name)}"
          data-pack-label="${escapeHtml(defVar.pack_label)}"
          ${Number(defVar.stock_qty) > 0 ? '' : 'disabled'}
        >${Number(defVar.stock_qty) > 0 ? 'Add to Basket' : 'Out of Stock'}</button>
        <button
          type="button"
          class="sn-btn sn-btn-forest sn-btn-sm"
          id="pdp-sticky-buy-btn"
          data-buy-now
          data-variant-id="${defVar.id}"
          data-product-name="${escapeHtml(product.name)}"
          data-pack-label="${escapeHtml(defVar.pack_label)}"
          ${Number(defVar.stock_qty) > 0 ? '' : 'disabled'}
        >Buy Now</button>
      </div>
    </div>
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

function renderCheckoutPage({
  coupons,
  customer = null,
  addresses = [],
  basePath = '',
  staticShowcaseScript = '',
  isNoIndex = false
}) {
  const title = `Secure Checkout (Razorpay UPI, Cards, NetBanking & COD) | ${BRAND_NAME}`;
  const description = 'Complete your Sashya Naturals order with server-verified Razorpay online payment or Cash on Delivery across India.';
  const breadcrumbs = [{ name: 'Home', url: '/' }, { name: 'Checkout', url: '/checkout' }];
  const sectionBookmarks = [
    { id: 'delivery-address', name: 'Contact & Indian Delivery Address', shortLabel: 'Delivery Address' },
    { id: 'payment-modes', name: 'Payment Modes (UPI, Cards, NetBanking & COD)', shortLabel: 'Payment Modes' },
    { id: 'promotional-coupons', name: 'Promotional Coupons', shortLabel: 'Coupons' },
    { id: 'order-summary', name: 'Order Summary & GST Breakdown', shortLabel: 'Order Summary' }
  ];
  const schemaGraph = buildMasterSchemaGraph({
    pageType: 'webpage',
    canonicalPath: '/checkout',
    title,
    description,
    breadcrumbs,
    sectionBookmarks
  });

  const isShowcase = Boolean(staticShowcaseScript);
  const defAddr = addresses.find(a => a.is_default) || addresses[0] || null;
  const initName = defAddr ? defAddr.recipient_name : (customer ? customer.full_name : (isShowcase ? 'Arjun Krishnamurthy' : ''));
  const initPhone = defAddr ? defAddr.phone : (customer ? customer.phone : (isShowcase ? '+91 98450 11223' : ''));
  const initEmail = customer ? customer.email : (isShowcase ? 'arjun.k@example.com' : '');
  const initLine1 = defAddr ? defAddr.line1 : (isShowcase ? 'No. 18, 4th Cross, Malleshwaram' : '');
  const initLine2 = defAddr ? defAddr.line2 : (isShowcase ? 'Near Sankey Tank' : '');
  const initCity = defAddr ? defAddr.city : (isShowcase ? 'Bengaluru' : '');
  const initState = defAddr ? defAddr.state : (isShowcase ? 'Karnataka' : '');
  const initPin = defAddr ? defAddr.pincode : (isShowcase ? '560003' : '');

  const chkInfo = getStorefrontContentAndSeo().infoPages.checkout || {};
  const chkEyebrow = chkInfo.subtitle || 'Secure Encrypted Checkout • Instant UPI, Cards, NetBanking & COD';
  const chkHeading = chkInfo.title || 'Checkout & Delivery Details';

  const bodyHtml = `
    <section class="sn-section">
      <div class="sn-container">
        ${renderBreadcrumbNav(breadcrumbs, basePath)}
        ${renderSectionJumpBar(sectionBookmarks, 'Checkout Steps:')}
        <div class="sn-section-head">
          <div>
            <span class="sn-eyebrow">${escapeHtml(chkEyebrow)}</span>
            <h1>${escapeHtml(chkHeading)}</h1>
          </div>
          <div>
            ${customer ? `
              <span class="sn-status sn-status-paid">Signed In as ${escapeHtml(customer.full_name)} (${escapeHtml(customer.email)})</span>
            ` : `
              <span class="sn-status sn-status-warn">Guest Checkout Active • <a href="${basePath}/account" style="color:var(--sn-bg-forest);text-decoration:underline;">Sign In for Saved Addresses</a></span>
            `}
          </div>
        </div>

        <div id="sn-checkout-result" style="display:none;margin-bottom:28px;"></div>

        <div class="sn-pdp-grid sn-checkout-layout">
          <form class="sn-card" id="sn-checkout-form">
            <input type="hidden" name="userId" id="chk-user-id" value="${customer ? customer.id : ''}" />
            <h3 id="delivery-address" style="font-family:var(--sn-font-serif);margin:0 0 12px;color:var(--sn-bg-forest);">1. Contact &amp; Indian Delivery Address${renderHeadingAnchor('delivery-address', 'Contact & Indian Delivery Address')}</h3>

            ${addresses.length > 0 ? `
              <div class="sn-card" style="background-color:var(--sn-bg-parchment);padding:12px 14px;margin-bottom:16px;" id="sn-checkout-saved-addresses-bar">
                <div style="font-family:var(--sn-font-mono);font-size:0.74rem;text-transform:uppercase;color:var(--sn-text-muted);margin-bottom:8px;">
                  📍 Autofill from Your Saved Delivery Addresses (${addresses.length})
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                  ${addresses.map((a, idx) => {
                    const cleanLabel = String(a.label || 'Home').replace(/\s*\([^)]*\)\s*/g, '').trim() || a.label;
                    return `
                    <button
                      type="button"
                      class="sn-btn ${idx === 0 ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm"
                      data-checkout-saved-addr="${escapeHtml(JSON.stringify(a))}"
                      data-addr-name="${escapeHtml(a.recipient_name)}"
                      data-addr-phone="${escapeHtml(a.phone)}"
                      data-addr-line1="${escapeHtml(a.line1)}"
                      data-addr-line2="${escapeHtml(a.line2 || '')}"
                      data-addr-city="${escapeHtml(a.city)}"
                      data-addr-state="${escapeHtml(a.state)}"
                      data-addr-pin="${escapeHtml(a.pincode)}"
                    >${escapeHtml(cleanLabel)} (${escapeHtml(a.city)} - ${escapeHtml(a.pincode)})${a.is_default ? ' ★' : ''}</button>
                  `;
                  }).join('')}
                </div>
              </div>
            ` : ''}

            <div class="sn-grid-2" style="margin-bottom:14px;">
              <div>
                <label for="chk-name" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">Full Name *</label>
                <input type="text" id="chk-name" name="customerName" required value="${escapeHtml(initName)}" placeholder="e.g. Ananya Iyer" class="sn-input" />
              </div>
              <div>
                <label for="chk-phone" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">Mobile Number (India) *</label>
                <input type="tel" id="chk-phone" name="customerPhone" required value="${escapeHtml(initPhone)}" placeholder="+91 98450 11223" class="sn-input" />
              </div>
            </div>
            <div style="margin-bottom:14px;">
              <label for="chk-email" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">Email Address (for Order &amp; Courier Notifications) *</label>
              <input type="email" id="chk-email" name="customerEmail" required value="${escapeHtml(initEmail)}" placeholder="you@example.com" class="sn-input" />
            </div>
            <div style="margin-bottom:14px;">
              <label for="chk-line1" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">House / Flat No., Building &amp; Street Address *</label>
              <input type="text" id="chk-line1" name="shippingLine1" required value="${escapeHtml(initLine1)}" placeholder="House / Flat No., Building &amp; Street" class="sn-input" />
            </div>
            <div style="margin-bottom:14px;">
              <label for="chk-line2" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">Landmark / Area (Optional)</label>
              <input type="text" id="chk-line2" name="shippingLine2" value="${escapeHtml(initLine2)}" placeholder="Locality / Landmark" class="sn-input" />
            </div>
            <div class="sn-grid-3" style="margin-bottom:14px;">
              <div>
                <label for="chk-city" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">City *</label>
                <input type="text" id="chk-city" name="shippingCity" required value="${escapeHtml(initCity)}" placeholder="e.g. Bengaluru" class="sn-input" />
              </div>
              <div>
                <label for="chk-state" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">State *</label>
                <input type="text" id="chk-state" name="shippingState" required value="${escapeHtml(initState)}" placeholder="e.g. Karnataka" class="sn-input" />
              </div>
              <div>
                <label for="chk-pin" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">6-Digit PIN Code *</label>
                <input type="text" id="chk-pin" name="shippingPincode" required pattern="\\d{6}" value="${escapeHtml(initPin)}" placeholder="560038" class="sn-input" />
              </div>
            </div>
            <div style="margin-bottom:20px;">
              <label for="chk-notes" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">Delivery Instructions</label>
              <input type="text" id="chk-notes" name="deliveryInstructions" placeholder="e.g. Call on arrival or leave at reception" class="sn-input" />
            </div>

            <h3 id="payment-modes" style="font-family:var(--sn-font-serif);margin:0 0 12px;color:var(--sn-bg-forest);">2. Select Payment Mode (Razorpay Gateway or COD)${renderHeadingAnchor('payment-modes', 'Select Payment Mode')}</h3>
            <div class="sn-grid-2" style="gap:10px;margin-bottom:22px;">
              <label class="sn-card sn-payment-option-card">
                <input type="radio" name="paymentMethod" value="ONLINE_UPI" checked style="margin-top:3px;" />
                <div>
                  <div><strong>UPI Instant Pay</strong> (GPay / PhonePe / BHIM)</div>
                  <div style="font-family:var(--sn-font-mono);font-size:0.71rem;color:var(--sn-status-paid);margin-top:2px;">✓ Instant Verification • Zero Gateway Fee</div>
                </div>
              </label>
              <label class="sn-card sn-payment-option-card">
                <input type="radio" name="paymentMethod" value="ONLINE_CARD" style="margin-top:3px;" />
                <div>
                  <div><strong>Credit / Debit Card</strong> (Visa / RuPay / MC)</div>
                  <div style="font-family:var(--sn-font-mono);font-size:0.71rem;color:var(--sn-status-paid);margin-top:2px;">✓ Instant Verification • Zero Gateway Fee</div>
                </div>
              </label>
              <label class="sn-card sn-payment-option-card">
                <input type="radio" name="paymentMethod" value="ONLINE_NETBANKING" style="margin-top:3px;" />
                <div>
                  <div><strong>Net Banking</strong> (All Indian Banks)</div>
                  <div style="font-family:var(--sn-font-mono);font-size:0.71rem;color:var(--sn-status-paid);margin-top:2px;">✓ Instant Verification • Zero Gateway Fee</div>
                </div>
              </label>
              <label class="sn-card sn-payment-option-card">
                <input type="radio" name="paymentMethod" value="COD" style="margin-top:3px;" />
                <div>
                  <div><strong>Cash on Delivery (COD)</strong> (Pay at Doorstep)</div>
                  <div style="font-family:var(--sn-font-mono);font-size:0.71rem;color:var(--sn-text-secondary);margin-top:2px;">Pay Cash / UPI on Delivery (OTP Verified)</div>
                </div>
              </label>
            </div>

            <button type="submit" class="sn-btn sn-btn-primary" style="width:100%;padding:14px;font-size:1rem;" id="place-order-submit-btn">
              Place Order &amp; Complete Payment &rarr;
            </button>
          </form>

          <div class="sn-checkout-sidebar">
            ${(() => {
              const enrichedList = listEnrichedCoupons();
              const activeCoupons = enrichedList.filter(c => c.computed_status === 'ACTIVE');
              const publicChipCoupons = activeCoupons.filter(
                c => c.visibility !== 'SECRET_CODE' && (c.code !== 'SASYA10' || !activeCoupons.some(x => x.code === 'SASHYA10'))
              );
              const autoApplyCoupon = activeCoupons.find(c => Number(c.is_auto_apply) === 1);
              const defaultCouponVal = autoApplyCoupon ? autoApplyCoupon.code : '';
              return `
            <div class="sn-card" id="promotional-coupons" style="margin-bottom:20px;">
              <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;color:var(--sn-bg-forest);">Apply Promotional Coupon${renderHeadingAnchor('promotional-coupons', 'Apply Promotional Coupon')}</h3>
              <div style="display:flex;gap:10px;margin-bottom:10px;">
                <input type="text" id="sn-checkout-coupon" placeholder="Enter coupon code" value="${escapeHtml(defaultCouponVal)}" class="sn-input" />
                <button type="button" class="sn-btn sn-btn-forest" id="sn-apply-coupon-btn">Apply</button>
              </div>
              ${publicChipCoupons.length > 0 ? `
              <div style="font-family:var(--sn-font-mono);font-size:0.72rem;color:var(--sn-text-muted);margin-bottom:6px;">
                Tap a coupon below to apply automatically:
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;" id="sn-checkout-public-coupon-chips">
                ${publicChipCoupons.map(c => `
                  <button
                    type="button"
                    class="sn-coupon-chip"
                    data-apply-coupon-chip="${escapeHtml(c.code)}"
                    title="${escapeHtml(c.description)}"
                  >🏷️ ${escapeHtml(c.code)} <span style="font-weight:400;opacity:0.85;">(${escapeHtml(c.description)})</span></button>
                `).join('')}
              </div>
              ` : ''}
            </div>
              `;
            })()}

            <div class="sn-card" id="order-summary">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="font-family:var(--sn-font-serif);margin:0;color:var(--sn-bg-forest);">Your Order Summary${renderHeadingAnchor('order-summary', 'Your Order Summary')}</h3>
                <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-open-cart>Edit Basket</button>
              </div>
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
    activeNav: 'checkout',
    schemaGraph,
    bodyHtml,
    isNoIndex,
    basePath,
    staticShowcaseScript
  });
}

function renderTrackOrderPage({
  order,
  orderItems = [],
  queryOrderNumber = '',
  contactQuery = '',
  lookupError = '',
  customer = null,
  customerOrders = [],
  basePath = '',
  staticShowcaseScript = '',
  isNoIndex = false
}) {
  const isShowcase = Boolean(staticShowcaseScript);
  const title = `Track Order & Manual Courier Status | ${BRAND_NAME}`;
  const description = 'Track your Sashya Naturals order status, separate payment and fulfilment states, and manual courier AWB tracking reference.';
  const breadcrumbs = [{ name: 'Home', url: '/' }, { name: 'Track Order', url: '/track-order' }];
  const sectionBookmarks = [
    { id: 'order-lookup', name: 'Order Status Lookup', shortLabel: 'Lookup Order' },
    ...(order ? [
      { id: 'order-status-timeline', name: `Order ${order.order_number} Status Timeline`, shortLabel: 'Status Timeline' },
      { id: 'courier-tracking', name: 'Courier & Dispatch AWB Tracking', shortLabel: 'Courier & AWB' },
      { id: 'ordered-items', name: 'Ordered Pack Items & HSN Breakdown', shortLabel: 'Ordered Items' }
    ] : [])
  ];
  const schemaGraph = buildMasterSchemaGraph({
    pageType: 'webpage',
    canonicalPath: '/track-order',
    title,
    description,
    breadcrumbs,
    sectionBookmarks
  });

  const steps = ['Pending Payment', 'Confirmed', 'Processing', 'Packed', 'Shipped', 'Delivered'];
  const taxRegimeLabel = order && order.tax_supply_type === 'IGST' ? 'Inter-State IGST' : 'Intra-State CGST + SGST';
  const invoiceHref = order
    ? `${basePath}/orders/${escapeHtml(order.order_number)}/invoice${contactQuery ? `?contact=${encodeURIComponent(contactQuery)}` : ''}`
    : '#';

  const trkInfo = getStorefrontContentAndSeo().infoPages['track-order'] || {};
  const trkEyebrow = trkInfo.subtitle || 'Dual Payment & Fulfilment Status + Manual Courier Reference';
  const trkHeading = trkInfo.title || 'Track Your Sashya Naturals Order';

  const bodyHtml = `
    <section class="sn-section">
      <div class="sn-container">
        ${renderBreadcrumbNav(breadcrumbs, basePath)}
        ${renderSectionJumpBar(sectionBookmarks, 'Tracking Sections:')}
        <div class="sn-section-head">
          <div>
            <span class="sn-eyebrow">${escapeHtml(trkEyebrow)}</span>
            <h1>${escapeHtml(trkHeading)}</h1>
          </div>
          ${customer ? `
            <div>
              <span class="sn-status sn-status-paid">Signed In: ${escapeHtml(customer.full_name)}</span>
            </div>
          ` : ''}
        </div>

        ${customer && customerOrders.length > 0 ? `
          <div class="sn-card" style="background-color:var(--sn-bg-parchment);padding:12px 16px;margin-bottom:16px;">
            <div style="font-family:var(--sn-font-mono);font-size:0.74rem;text-transform:uppercase;color:var(--sn-text-muted);margin-bottom:8px;">
              📦 Your Account Orders (${customerOrders.length}) — Select to View Live Status &amp; GST Invoice
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              ${customerOrders.map(co => `
                <a
                  href="${basePath}/track-order?order=${encodeURIComponent(co.order_number)}"
                  class="sn-btn ${order && order.order_number === co.order_number ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm"
                >${escapeHtml(co.order_number)} • ${escapeHtml(co.fulfilment_status)} (${formatInr(co.total_paise)})</a>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <div id="order-lookup">
          <form class="sn-filter-bar" method="GET" action="${basePath}/track-order" id="track-order-form">
            <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;width:100%;">
              <input
                type="text"
                name="order"
                required
                value="${escapeHtml(queryOrderNumber || (isShowcase && order ? order.order_number : ''))}"
                placeholder="Order Number (e.g. SN-2026-1001)"
                class="sn-input"
                style="flex:1 1 240px;max-width:320px;"
                id="track-order-input"
              />
              ${!isShowcase && (!customer || lookupError || contactQuery) ? `
                <input
                  type="text"
                  name="contact"
                  ${!customer ? 'required' : ''}
                  value="${escapeHtml(contactQuery)}"
                  placeholder="Registered Mobile No. or Email"
                  class="sn-input"
                  style="flex:1 1 260px;max-width:340px;"
                  id="track-order-contact-input"
                />
              ` : ''}
              <button type="submit" class="sn-btn sn-btn-forest" id="track-order-submit-btn">Lookup Order Status</button>
              ${isShowcase ? `
                <span style="font-family:var(--sn-font-mono);font-size:0.78rem;color:var(--sn-text-muted);">
                  Sample orders: <a href="${basePath}/track-order?order=SN-2026-1001" style="color:var(--sn-accent-terracotta);text-decoration:underline;">SN-2026-1001 (Shipped via Blue Dart)</a> or <a href="${basePath}/track-order?order=SN-2026-1002" style="color:var(--sn-accent-terracotta);text-decoration:underline;">SN-2026-1002 (COD Confirmed)</a>
                </span>
              ` : (!customer ? `
                <span style="font-size:0.8rem;color:var(--sn-text-muted);">
                  Have an account? <a href="${basePath}/account" style="color:var(--sn-accent-terracotta);font-weight:600;text-decoration:underline;">Sign in</a> for 1-click order tracking.
                </span>
              ` : '')}
            </div>
          </form>
        </div>

        ${order ? `
          <div class="sn-card" id="order-status-timeline" style="margin-bottom:24px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px;padding-bottom:18px;border-bottom:1px solid var(--sn-border-warm);">
              <div>
                <span class="sn-eyebrow">Order Number</span>
                <h2 style="font-family:var(--sn-font-serif);margin:0;color:var(--sn-bg-forest);">${escapeHtml(order.order_number)}${renderHeadingAnchor('order-status-timeline', `Order ${order.order_number}`)}</h2>
                <div style="font-size:0.86rem;color:var(--sn-text-secondary);margin-top:4px;">
                  Customer: <strong>${escapeHtml(order.customer_name)}</strong> | Destination: ${escapeHtml(order.shipping_city)}, ${escapeHtml(order.shipping_state)} - ${escapeHtml(order.shipping_pincode)}
                </div>
              </div>
              <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
                <div>
                  <div style="font-family:var(--sn-font-mono);font-size:0.7rem;color:var(--sn-text-muted);">PAYMENT STATUS</div>
                  <span class="sn-status ${order.payment_status === 'PAID' || order.payment_status === 'COD_COLLECTED' ? 'sn-status-paid' : (['FAILED', 'REFUNDED'].includes(order.payment_status) ? 'sn-status-danger' : 'sn-status-warn')}">${escapeHtml(order.payment_status)}</span>
                </div>
                <div>
                  <div style="font-family:var(--sn-font-mono);font-size:0.7rem;color:var(--sn-text-muted);">FULFILMENT STATUS</div>
                  <span class="sn-status ${['Cancelled', 'Refunded'].includes(order.fulfilment_status) ? 'sn-status-danger' : (order.fulfilment_status === 'Refund Initiated' ? 'sn-status-warn' : 'sn-status-paid')}">${escapeHtml(order.fulfilment_status)}</span>
                </div>
                <div>
                  <div style="font-family:var(--sn-font-mono);font-size:0.7rem;color:var(--sn-text-muted);">ORDER TOTAL</div>
                  <strong style="font-family:var(--sn-font-mono);font-size:1.1rem;color:var(--sn-bg-forest);">${formatInr(order.total_paise)}</strong>
                </div>
                <div>
                  <a href="${invoiceHref}" class="sn-btn sn-btn-outline sn-btn-sm" id="download-gst-invoice-btn">GST Tax Invoice &rarr;</a>
                </div>
              </div>
            </div>

            <div class="sn-stepper-grid" style="margin:22px 0;">
              ${steps.map((st, idx) => {
                const currentIdx = steps.indexOf(order.fulfilment_status);
                const isCurrent = currentIdx === idx;
                const isCompleted = currentIdx > idx;
                const bg = isCurrent
                  ? 'var(--sn-bg-forest)'
                  : (isCompleted ? 'var(--sn-status-paid-bg)' : 'var(--sn-bg-parchment)');
                const color = isCurrent
                  ? '#FFFFFF'
                  : (isCompleted ? 'var(--sn-bg-forest)' : 'var(--sn-text-muted)');
                const border = isCurrent || isCompleted
                  ? 'var(--sn-bg-forest)'
                  : 'var(--sn-border-warm)';
                return `
                  <div style="padding:10px 8px;border-radius:6px;border:${isCurrent ? '2px' : '1px'} solid ${border};background-color:${bg};text-align:center;font-family:var(--sn-font-mono);font-size:0.75rem;font-weight:${isCurrent ? '700' : '600'};color:${color};box-shadow:${isCurrent ? 'var(--sn-shadow-soft)' : 'none'};">
                    ${isCurrent ? '● ' : (isCompleted ? '✓ ' : `${idx + 1}. `)}${escapeHtml(st)}
                  </div>
                `;
              }).join('')}
            </div>

            <div class="sn-pdp-grid" style="margin-bottom:20px;">
              <div class="sn-card" style="background-color:var(--sn-bg-parchment);">
                <h3 style="font-family:var(--sn-font-serif);margin:0 0 8px;font-size:1.1rem;color:var(--sn-bg-forest);">Delivery Address &amp; Recipient Details</h3>
                <div style="font-size:0.88rem;line-height:1.5;color:var(--sn-text-primary);">
                  <strong>${escapeHtml(order.customer_name)}</strong> (${escapeHtml(order.customer_phone)} | ${escapeHtml(order.customer_email)})<br/>
                  ${escapeHtml(order.shipping_line1)}${order.shipping_line2 ? ', ' + escapeHtml(order.shipping_line2) : ''}<br/>
                  ${escapeHtml(order.shipping_city)}, ${escapeHtml(order.shipping_state)} - <strong style="font-family:var(--sn-font-mono);">${escapeHtml(order.shipping_pincode)}</strong>
                  ${order.delivery_instructions ? `
                    <div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--sn-border-strong);font-size:0.82rem;color:var(--sn-text-secondary);">
                      <strong>Delivery Instructions:</strong> ${escapeHtml(order.delivery_instructions)}
                    </div>
                  ` : ''}
                </div>
              </div>

              <div class="sn-card" id="courier-tracking" style="background-color:var(--sn-bg-mortar);">
                <h3 style="font-family:var(--sn-font-serif);margin:0 0 8px;font-size:1.1rem;color:var(--sn-bg-forest);">Courier &amp; Dispatch Tracking${renderHeadingAnchor('courier-tracking', 'Courier & Dispatch Tracking')}</h3>
                ${order.courier_name ? `
                  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;font-size:0.88rem;">
                    <div><span style="color:var(--sn-text-muted);">Courier Partner:</span><br/><strong>${escapeHtml(order.courier_name)}</strong></div>
                    <div>
                      <span style="color:var(--sn-text-muted);">Tracking / AWB Number:</span><br/>
                      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px;">
                        <strong style="font-family:var(--sn-font-mono);">${escapeHtml(order.tracking_number)}</strong>
                        <button
                          type="button"
                          class="sn-btn sn-btn-outline sn-btn-sm"
                          data-copy-shipping-label="${escapeHtml(order.tracking_number)}"
                          style="padding:6px 10px;min-height:36px;font-size:0.72rem;"
                        >📋 Copy AWB</button>
                      </div>
                    </div>
                    <div><span style="color:var(--sn-text-muted);">Dispatch Date:</span><br/><strong style="font-family:var(--sn-font-mono);">${escapeHtml(order.dispatch_date || 'Recorded')}</strong></div>
                    ${order.tracking_url ? `
                      <div><span style="color:var(--sn-text-muted);">Tracking Link:</span><br/><a href="${escapeHtml(order.tracking_url)}" target="_blank" rel="noopener" style="color:var(--sn-accent-terracotta);font-weight:600;">Open Courier Portal &rarr;</a></div>
                    ` : `
                      <div><span style="color:var(--sn-text-muted);">Tracking Portal:</span><br/><span style="font-size:0.82rem;color:var(--sn-text-secondary);">Use AWB on ${escapeHtml(order.courier_name)} website</span></div>
                    `}
                  </div>
                ` : (['Cancelled', 'Refunded', 'Refund Initiated'].includes(order.fulfilment_status) ? `
                  <p style="margin:0;font-size:0.88rem;color:var(--sn-status-danger);font-weight:600;">
                    This order has been marked as <strong>${escapeHtml(order.fulfilment_status)}</strong> (${escapeHtml(order.payment_status)}). No courier dispatch will take place for this order.
                  </p>
                ` : `
                  <p style="margin:0;font-size:0.88rem;color:var(--sn-text-secondary);">
                    Your order is currently in <strong>${escapeHtml(order.fulfilment_status)}</strong> stage. Once our packing team hands the parcel to the courier partner, the courier name and tracking AWB number will appear here automatically.
                  </p>
                `)}
              </div>
            </div>

            <div id="ordered-items">
              <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;font-size:1.1rem;color:var(--sn-bg-forest);">Ordered Pack Items &amp; HSN Tax Breakdown (${escapeHtml(taxRegimeLabel)})${renderHeadingAnchor('ordered-items', 'Ordered Pack Items')}</h3>
              <div style="display:flex;flex-direction:column;gap:10px;">
                ${orderItems.map(item => `
                  <div class="sn-card" style="padding:12px 16px;background-color:var(--sn-bg-parchment);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
                    <div style="flex:1;min-width:220px;">
                      <div style="font-weight:700;color:var(--sn-bg-forest);font-size:0.95rem;">
                        ${escapeHtml(item.product_name)} <span style="font-family:var(--sn-font-mono);font-size:0.84rem;">(${escapeHtml(item.pack_label)} &times; ${item.quantity})</span>
                      </div>
                      <div style="font-family:var(--sn-font-mono);font-size:0.76rem;color:var(--sn-text-muted);margin-top:3px;">
                        SKU: ${escapeHtml(item.sku)} &bull; HSN: ${escapeHtml(item.hsn_code || '080290')} &bull; Unit Price: ${formatInr(item.unit_price_paise)}
                      </div>
                    </div>
                    <div style="font-family:var(--sn-font-mono);font-weight:700;font-size:1rem;color:var(--sn-bg-forest);white-space:nowrap;">
                      ${formatInr(item.line_total_paise)}
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>
        ` : (lookupError ? `
          <div class="sn-card" style="border-left:4px solid var(--sn-status-warn);">
            <strong style="color:var(--sn-bg-forest);display:block;margin-bottom:4px;">Order Verification Required</strong>
            <p style="margin:0;color:var(--sn-text-secondary);font-size:0.9rem;">${escapeHtml(lookupError)}</p>
          </div>
        ` : `
          <div class="sn-card">
            <h3 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Track Your Shipment &amp; Download GST Tax Invoices</h3>
            <p style="margin:0;color:var(--sn-text-secondary);font-size:0.9rem;">
              Enter your <strong>Order Number</strong> and the <strong>Mobile Number or Email Address</strong> used at checkout above to view real-time fulfilment milestones, courier AWB tracking numbers, and your official GST Tax Invoice.
              ${!customer ? ` You can also <a href="${basePath}/account" style="color:var(--sn-accent-terracotta);font-weight:600;text-decoration:underline;">sign in to your customer account</a> to view all past orders automatically.` : ''}
            </p>
          </div>
        `)}
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

function renderGstInvoicePage({ order, orderItems = [], settingsMap = {}, verifiedContact = '', basePath = '' }) {
  const title = `GST Tax Invoice ${order.order_number} | ${BRAND_NAME}`;
  const isIntra = (order.tax_supply_type || 'CGST_SGST') === 'CGST_SGST';
  const cgst = order.cgst_paise || Math.floor(order.gst_paise / 2);
  const sgst = order.sgst_paise || (order.gst_paise - cgst);
  const igst = order.igst_paise || order.gst_paise;

  const legalName = (!settingsMap.business_legal_name || settingsMap.business_legal_name.includes('Configurable'))
    ? 'Sashya Naturals Foods Private Limited'
    : settingsMap.business_legal_name;
  const regAddr = (!settingsMap.registered_address || settingsMap.registered_address.includes('Configurable'))
    ? 'No. 48, 100 Feet Road, Indiranagar, Bengaluru, Karnataka - 560038'
    : settingsMap.registered_address;
  const gstinVal = (!settingsMap.gstin || settingsMap.gstin.includes('CONFIGURABLE'))
    ? '29AABCS1429B1Z5'
    : settingsMap.gstin;
  const fssaiVal = (!settingsMap.fssai_license || settingsMap.fssai_license.includes('CONFIGURABLE'))
    ? '11226332001482'
    : settingsMap.fssai_license;

  const schemaGraph = buildMasterSchemaGraph({
    pageType: 'webpage',
    canonicalPath: `/orders/${order.order_number}/invoice`,
    title,
    description: `GST Tax Invoice for Sashya Naturals Order ${order.order_number}`,
    breadcrumbs: [{ name: 'Home', url: '/' }, { name: 'Track Order', url: '/track-order' }, { name: `Invoice ${order.order_number}`, url: `/orders/${order.order_number}/invoice` }]
  });

  const backToTrackerHref = `${basePath}/track-order?order=${encodeURIComponent(order.order_number)}${verifiedContact ? `&contact=${encodeURIComponent(verifiedContact)}` : ''}`;

  const bodyHtml = `
    <section class="sn-section">
      <div class="sn-container" style="max-width:920px;">
        <div class="sn-no-print" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:20px;">
          <a href="${backToTrackerHref}" class="sn-btn sn-btn-outline sn-btn-sm">&larr; Back to Order Tracker</a>
          <button type="button" onclick="window.print()" class="sn-btn sn-btn-forest sn-btn-sm" id="print-invoice-btn">Print / Save GST Invoice PDF</button>
        </div>

        <div class="sn-card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px;padding-bottom:20px;border-bottom:2px solid var(--sn-bg-forest);">
            <div style="flex:1.3 1 320px;">
              <span class="sn-eyebrow">Tax Invoice (Original for Recipient)</span>
              <h1 class="sn-invoice-h1">${escapeHtml(legalName)}</h1>
              <div style="font-size:0.84rem;color:var(--sn-text-secondary);margin-top:4px;">
                ${escapeHtml(regAddr)}<br/>
                <strong>GSTIN:</strong> <span style="font-family:var(--sn-font-mono);">${escapeHtml(gstinVal)}</span> |
                <strong>FSSAI Lic. No.:</strong> <span style="font-family:var(--sn-font-mono);">${escapeHtml(fssaiVal)}</span>
              </div>
            </div>
            <div class="sn-invoice-meta-right" style="flex:0.9 1 240px;">
              <div><strong>Invoice No:</strong> INV-${escapeHtml(order.order_number)}</div>
              <div><strong>Order No:</strong> ${escapeHtml(order.order_number)}</div>
              <div><strong>Date:</strong> ${escapeHtml(order.created_at.slice(0, 10))}</div>
              <div><strong>Place of Supply:</strong> ${escapeHtml(order.shipping_state)} (${escapeHtml(order.shipping_pincode)})</div>
              <div><strong>Tax Regime:</strong> ${isIntra ? 'Intra-State (CGST + SGST)' : 'Inter-State (IGST)'}</div>
            </div>
          </div>

          <div class="sn-grid-2" style="gap:20px;padding:18px 0;border-bottom:1px solid var(--sn-border-warm);font-size:0.86rem;overflow-wrap:anywhere;">
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

          <div class="sn-mobile-table-hint sn-no-print">↔ Swipe table horizontally to inspect all 8 GST columns</div>
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
                    <td style="font-family:var(--sn-font-mono);white-space:nowrap;">${escapeHtml(it.hsn_code || '080290')}</td>
                    <td style="font-family:var(--sn-font-mono);white-space:nowrap;">${escapeHtml(it.pack_label)}</td>
                    <td style="font-family:var(--sn-font-mono);">${it.quantity}</td>
                    <td style="font-family:var(--sn-font-mono);white-space:nowrap;">${formatInr(it.unit_price_paise)}</td>
                    <td style="font-family:var(--sn-font-mono);white-space:nowrap;">${it.gst_percent}%</td>
                    <td style="font-family:var(--sn-font-mono);font-weight:600;white-space:nowrap;">${formatInr(it.line_total_paise)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>

          <div style="display:flex;justify-content:flex-end;">
            <div style="width:100%;max-width:340px;font-size:0.88rem;display:flex;flex-direction:column;gap:6px;">
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
  const description = 'Manage your Sashya Naturals customer profile, saved Indian delivery addresses, order history, and GST tax invoices.';
  const schemaGraph = buildMasterSchemaGraph({
    pageType: 'webpage',
    canonicalPath: '/account',
    title,
    description,
    breadcrumbs: [{ name: 'Home', url: '/' }, { name: 'Customer Account', url: '/account' }]
  });

  const isShowcase = Boolean(staticShowcaseScript);
  const isSignedIn = Boolean(customer && customer.id);
  const activeCustomer = customer || {
    id: 0,
    email: isShowcase ? 'ananya.iyer@example.com' : '',
    full_name: isShowcase ? 'Ananya Iyer' : '',
    phone: isShowcase ? '+91 98450 22334' : '',
    role: 'CUSTOMER'
  };

  const accInfo = getStorefrontContentAndSeo().infoPages.account || {};
  const accEyebrow = accInfo.subtitle || 'Customer Account • Saved Delivery Addresses, Order Tracking & Tax Invoices';
  const accHeading = accInfo.title || 'My Sashya Naturals Pantry Account';

  const bodyHtml = `
    <section class="sn-section" id="sn-customer-account-page" data-customer-signed-in="${isSignedIn ? '1' : '0'}">
      <div class="sn-container">
        <div class="sn-section-head">
          <div>
            <span class="sn-eyebrow">${escapeHtml(accEyebrow)}</span>
            <h1>${escapeHtml(accHeading)}</h1>
          </div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            <span class="sn-status ${isSignedIn ? 'sn-status-paid' : 'sn-status-warn'}" id="sn-account-active-badge">
              ${isSignedIn ? `Signed In: ${escapeHtml(activeCustomer.full_name)} (${escapeHtml(activeCustomer.email)})` : 'Not Signed In • Please Sign In or Register'}
            </span>
            <button
              type="button"
              class="sn-btn sn-btn-outline sn-btn-sm"
              id="sn-customer-toggle-auth-btn"
              style="display:${isSignedIn ? 'inline-flex' : 'none'};"
            >Switch Account</button>
            <button
              type="button"
              class="sn-btn sn-btn-outline sn-btn-sm"
              id="sn-customer-logout-btn"
              style="display:${isSignedIn ? 'inline-flex' : 'none'};"
            >Sign Out</button>
          </div>
        </div>

        <!-- Guest Sign-In, New Customer Registration & Forgot Password via 6-Digit OTP (Shown when Logged Out or Switching Account) -->
        <div class="sn-account-guest-tabs" id="sn-account-guest-tabs" role="tablist" aria-label="Customer Account Authentication" style="${isSignedIn ? 'display:none;' : ''}">
          <button type="button" class="sn-btn sn-btn-forest sn-btn-sm sn-active" data-account-auth-tab="signin" role="tab" aria-selected="true">Sign In</button>
          <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-account-auth-tab="register" role="tab" aria-selected="false">Create Account</button>
        </div>
        <div class="sn-pdp-grid sn-account-guest-grid" id="sn-customer-guest-auth-sections" data-active-auth-tab="signin" style="display:${isSignedIn ? 'none' : 'grid'};margin-bottom:24px;">
          <div class="sn-account-guest-pane-signin" style="display:flex;flex-direction:column;gap:16px;">
            <form class="sn-card" id="sn-customer-login-form" style="background-color:var(--sn-bg-parchment);">
              <h3 style="font-family:var(--sn-font-serif);margin:0 0 8px;color:var(--sn-bg-forest);">Customer Sign In</h3>
              <p style="font-size:0.82rem;color:var(--sn-text-secondary);margin:0 0 12px;">
                ${isShowcase
                  ? 'Demo customer account pre-filled (<strong>ananya.iyer@example.com</strong> / <strong>Sashya@2026</strong>).'
                  : 'Sign in with your registered email address and password to access your saved delivery addresses, order tracking, and GST tax invoices.'
                }
              </p>
              <div class="sn-form-row-2-action">
                <div>
                  <label for="cust-login-email" style="font-size:0.75rem;font-weight:600;">Email Address *</label>
                  <input type="email" name="email" id="cust-login-email" required value="${escapeHtml(isShowcase ? activeCustomer.email : '')}" placeholder="you@example.com" class="sn-input" />
                </div>
                <div>
                  <label for="cust-login-password" style="font-size:0.75rem;font-weight:600;">Password *</label>
                  <input type="password" name="password" id="cust-login-password" required value="${isShowcase ? 'Sashya@2026' : ''}" placeholder="Enter password" class="sn-input" />
                </div>
                <button type="submit" class="sn-btn sn-btn-forest">Sign In</button>
              </div>
            </form>

            <!-- Forgot Password / 6-Digit OTP Reset Card (Collapsible Disclosure on Mobile) -->
            <details class="sn-card sn-forgot-pwd-details" style="background-color:var(--sn-bg-mortar);">
              <summary style="font-family:var(--sn-font-serif);font-size:1.02rem;font-weight:700;color:var(--sn-bg-forest);cursor:pointer;">Forgot Password? Reset via 6-Digit OTP</summary>
              <div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--sn-border-warm);">
                <form id="sn-customer-reset-otp-request-form" class="sn-form-row-1-action" style="margin-bottom:10px;">
                  <div>
                    <label for="sn-reset-otp-email" style="font-size:0.74rem;font-weight:600;">Registered Email Address *</label>
                    <input type="email" name="email" id="sn-reset-otp-email" required value="${escapeHtml(isShowcase ? activeCustomer.email : '')}" placeholder="you@example.com" class="sn-input" />
                  </div>
                  <button type="submit" class="sn-btn sn-btn-outline sn-btn-sm">Send 6-Digit OTP</button>
                </form>

                <form id="sn-customer-reset-otp-confirm-form" class="sn-form-row-2-action">
                  <input type="hidden" name="email" id="sn-reset-confirm-email" value="${escapeHtml(isShowcase ? activeCustomer.email : '')}" />
                  <div>
                    <label for="sn-reset-otp-code" style="font-size:0.74rem;font-weight:600;">6-Digit OTP Code *</label>
                    <input type="text" name="otpCode" id="sn-reset-otp-code" required pattern="\\d{6}" placeholder="e.g. 482910" class="sn-input" style="font-family:var(--sn-font-mono);" />
                  </div>
                  <div>
                    <label for="sn-reset-new-password" style="font-size:0.74rem;font-weight:600;">New Password (min 8 chars) *</label>
                    <input type="password" name="newPassword" id="sn-reset-new-password" required minlength="8" placeholder="New password" class="sn-input" />
                  </div>
                  <button type="submit" class="sn-btn sn-btn-forest sn-btn-sm">Verify OTP &amp; Reset</button>
                </form>
              </div>
            </details>
          </div>

          <form class="sn-card sn-account-guest-pane-register" id="sn-customer-register-form" style="background-color:var(--sn-bg-parchment);">
            <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;color:var(--sn-bg-forest);">New Customer Registration</h3>
            <p style="font-size:0.82rem;color:var(--sn-text-secondary);margin:0 0 12px;">
              Create an account to save delivery addresses across India and link past guest checkout orders automatically.
            </p>
            <div class="sn-grid-2" style="gap:10px;margin-bottom:10px;">
              <div>
                <label for="cust-reg-fullname" style="font-size:0.75rem;font-weight:600;">Full Name *</label>
                <input type="text" name="fullName" id="cust-reg-fullname" required placeholder="e.g. Rohan Deshpande" class="sn-input" />
              </div>
              <div>
                <label for="cust-reg-phone" style="font-size:0.75rem;font-weight:600;">Mobile Number *</label>
                <input type="tel" name="phone" id="cust-reg-phone" required placeholder="+91 98200 11223" class="sn-input" />
              </div>
            </div>
            <div class="sn-grid-2" style="gap:10px;margin-bottom:12px;">
              <div>
                <label for="cust-reg-email" style="font-size:0.75rem;font-weight:600;">Email Address *</label>
                <input type="email" name="email" id="cust-reg-email" required placeholder="rohan.d@example.com" class="sn-input" />
              </div>
              <div>
                <label for="cust-reg-password" style="font-size:0.75rem;font-weight:600;">Create Password (min 8 chars) *</label>
                <input type="password" name="password" id="cust-reg-password" required minlength="8" placeholder="••••••••" class="sn-input" />
              </div>
            </div>
            <button type="submit" class="sn-btn sn-btn-primary" style="width:100%;">Create Customer Account &amp; Sign In &rarr;</button>
          </form>
        </div>

        <!-- Authenticated Customer Sections (Rendered only when Signed In or in Static Showcase) -->
        ${(isSignedIn || isShowcase) ? `
        <div id="sn-customer-authenticated-sections" class="sn-account-auth-layout" style="display:${isSignedIn ? 'flex' : 'none'};">
          <!-- Profile Management, Change Password & Saved Delivery Addresses -->
          <div class="sn-pdp-grid sn-account-profile-addr-grid" style="margin-bottom:28px;">
            <div style="display:flex;flex-direction:column;gap:16px;">
              <form class="sn-card" id="sn-customer-profile-form">
                <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;color:var(--sn-bg-forest);">1. Customer Profile &amp; Contact Preferences</h3>
                <input type="hidden" name="userId" value="${activeCustomer.id}" />
                <div style="margin-bottom:12px;">
                  <label for="cust-prof-name" style="font-size:0.76rem;font-weight:600;display:block;margin-bottom:4px;">Full Name *</label>
                  <input type="text" name="fullName" required value="${escapeHtml(activeCustomer.full_name)}" class="sn-input" id="cust-prof-name" />
                </div>
                <div style="margin-bottom:12px;">
                  <label for="cust-prof-email" style="font-size:0.76rem;font-weight:600;display:block;margin-bottom:4px;">Registered Email Address</label>
                  <input type="email" name="email" readonly value="${escapeHtml(activeCustomer.email)}" class="sn-input" style="background-color:var(--sn-bg-mortar);" id="cust-prof-email" />
                </div>
                <div style="margin-bottom:16px;">
                  <label for="cust-prof-phone" style="font-size:0.76rem;font-weight:600;display:block;margin-bottom:4px;">Mobile Number (for Courier &amp; COD OTP Updates) *</label>
                  <input type="tel" name="phone" required value="${escapeHtml(activeCustomer.phone)}" class="sn-input" id="cust-prof-phone" />
                </div>
                <button type="submit" class="sn-btn sn-btn-forest">Save Profile Changes</button>
              </form>

              <form class="sn-card" id="sn-customer-change-password-form">
                <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1.05rem;color:var(--sn-bg-forest);">Change Account Password</h3>
                <div class="sn-form-row-2-action">
                  <div>
                    <label for="cust-chg-current-password" style="font-size:0.74rem;font-weight:600;">Current Password *</label>
                    <input type="password" name="currentPassword" id="cust-chg-current-password" required placeholder="Current password" class="sn-input" />
                  </div>
                  <div>
                    <label for="cust-chg-new-password" style="font-size:0.74rem;font-weight:600;">New Password (min 8 chars) *</label>
                    <input type="password" name="newPassword" id="cust-chg-new-password" required minlength="8" placeholder="New password" class="sn-input" />
                  </div>
                  <button type="submit" class="sn-btn sn-btn-outline sn-btn-sm">Update Password</button>
                </div>
              </form>
            </div>

            <div class="sn-card">
              <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;color:var(--sn-bg-forest);">2. Saved Delivery Addresses (${addresses.length})</h3>
              <div id="sn-customer-addresses-list" style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px;">
                ${addresses.map(a => `
                  <div class="sn-card" style="padding:12px 16px;background-color:var(--sn-bg-parchment);" data-address-card="${a.id}">
                    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px;">
                      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <strong>${escapeHtml(a.label)}</strong>
                        <span style="color:var(--sn-text-secondary);font-size:0.85rem;">• ${escapeHtml(a.recipient_name)} (${escapeHtml(a.phone)})</span>
                        ${a.is_default ? `<span class="sn-status sn-status-paid">Default</span>` : ''}
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

              <div class="sn-card" style="background-color:var(--sn-bg-parchment);padding:12px 16px;">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
                  <strong style="font-family:var(--sn-font-serif);font-size:0.95rem;color:var(--sn-bg-forest);">Add New Delivery Address</strong>
                  <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-toggle-add-address-btn" data-toggle-add-address>+ Add Address</button>
                </div>
                <form id="sn-customer-add-address-form" style="display:none;padding-top:12px;margin-top:10px;border-top:1px dashed var(--sn-border-warm);">
                  <input type="hidden" name="userId" value="${activeCustomer.id}" />
                  <div class="sn-grid-3" style="gap:8px;margin-bottom:8px;">
                    <div>
                      <label for="cust-addr-label" style="font-size:0.72rem;font-weight:600;display:block;margin-bottom:2px;">Address Label *</label>
                      <input type="text" name="label" id="cust-addr-label" required placeholder="e.g. Office / Home" class="sn-input" />
                    </div>
                    <div>
                      <label for="cust-addr-recipient" style="font-size:0.72rem;font-weight:600;display:block;margin-bottom:2px;">Recipient Name *</label>
                      <input type="text" name="recipientName" id="cust-addr-recipient" required value="${escapeHtml(activeCustomer.full_name)}" placeholder="Recipient Name" class="sn-input" />
                    </div>
                    <div>
                      <label for="cust-addr-phone" style="font-size:0.72rem;font-weight:600;display:block;margin-bottom:2px;">Mobile No. *</label>
                      <input type="tel" name="phone" id="cust-addr-phone" required value="${escapeHtml(activeCustomer.phone)}" placeholder="Mobile No." class="sn-input" />
                    </div>
                  </div>
                  <div class="sn-grid-2" style="gap:8px;margin-bottom:8px;">
                    <div>
                      <label for="cust-addr-line1" style="font-size:0.72rem;font-weight:600;display:block;margin-bottom:2px;">House / Flat / Street Address *</label>
                      <input type="text" name="line1" id="cust-addr-line1" required placeholder="House / Flat / Street Address" class="sn-input" />
                    </div>
                    <div>
                      <label for="cust-addr-line2" style="font-size:0.72rem;font-weight:600;display:block;margin-bottom:2px;">Landmark / Area (Optional)</label>
                      <input type="text" name="line2" id="cust-addr-line2" placeholder="Landmark / Area (Optional)" class="sn-input" />
                    </div>
                  </div>
                  <div class="sn-form-row-3-action" style="align-items:end;">
                    <div>
                      <label for="cust-addr-city" style="font-size:0.72rem;font-weight:600;display:block;margin-bottom:2px;">City *</label>
                      <input type="text" name="city" id="cust-addr-city" required placeholder="e.g. Bengaluru" class="sn-input" />
                    </div>
                    <div>
                      <label for="cust-addr-state" style="font-size:0.72rem;font-weight:600;display:block;margin-bottom:2px;">State *</label>
                      <input type="text" name="state" id="cust-addr-state" required placeholder="e.g. Karnataka" class="sn-input" />
                    </div>
                    <div>
                      <label for="cust-addr-pincode" style="font-size:0.72rem;font-weight:600;display:block;margin-bottom:2px;">6-Digit PIN *</label>
                      <input type="text" name="pincode" id="cust-addr-pincode" required pattern="\\d{6}" placeholder="560038" class="sn-input" />
                    </div>
                    <button type="submit" class="sn-btn sn-btn-primary sn-btn-sm">Save Address</button>
                  </div>
                </form>
              </div>
            </div>
          </div>

          <!-- Customer Order History & GST Tax Invoices -->
          <div class="sn-card sn-account-orders-card">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:16px;">
              <div>
                <h2 style="font-family:var(--sn-font-serif);margin:0;font-size:1.35rem;color:var(--sn-bg-forest);">3. My Order History, Courier Tracking &amp; GST Invoices</h2>
                <p style="font-size:0.84rem;color:var(--sn-text-secondary);margin:4px 0 0;">View real-time dual payment &amp; fulfilment statuses and manual courier AWB numbers.</p>
              </div>
              <a href="${basePath}/checkout" class="sn-btn sn-btn-forest sn-btn-sm">Checkout with Saved Addresses &rarr;</a>
            </div>
            <div id="sn-customer-orders-list" style="display:flex;flex-direction:column;gap:14px;">
              ${orders.map(o => {
                const oItems = orderItems.filter(it => Number(it.order_id) === Number(o.id));
                return `
                  <div class="sn-card" style="background-color:var(--sn-bg-parchment);padding:14px 16px;" data-customer-order-card="${escapeHtml(o.order_number)}">
                    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;padding-bottom:10px;margin-bottom:12px;border-bottom:1px solid var(--sn-border-warm);">
                      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                        <strong style="font-family:var(--sn-font-mono);font-size:1rem;color:var(--sn-bg-forest);white-space:nowrap;">${escapeHtml(o.order_number)}</strong>
                        <span style="font-family:var(--sn-font-mono);font-size:0.78rem;color:var(--sn-text-muted);white-space:nowrap;">Placed: ${escapeHtml((o.created_at || '').slice(0, 10))}</span>
                      </div>
                      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <span class="sn-status ${o.payment_status === 'PAID' || o.payment_status === 'COD_COLLECTED' ? 'sn-status-paid' : (['FAILED', 'REFUNDED'].includes(o.payment_status) ? 'sn-status-danger' : 'sn-status-warn')}">${escapeHtml(o.payment_status)}</span>
                        <span class="sn-status ${['Cancelled', 'Refunded'].includes(o.fulfilment_status) ? 'sn-status-danger' : (o.fulfilment_status === 'Refund Initiated' ? 'sn-status-warn' : 'sn-status-paid')}">${escapeHtml(o.fulfilment_status)}</span>
                        <strong style="font-family:var(--sn-font-mono);font-size:1.02rem;color:var(--sn-bg-forest);white-space:nowrap;">${formatInr(o.total_paise)}</strong>
                      </div>
                    </div>

                    <div class="sn-grid-2" style="gap:12px;align-items:center;">
                      <div>
                        <div style="font-family:var(--sn-font-mono);font-size:0.71rem;text-transform:uppercase;color:var(--sn-text-muted);margin-bottom:3px;">
                          Ordered Pantry Packs (${oItems.length || 1})
                        </div>
                        <div style="font-size:0.86rem;line-height:1.45;color:var(--sn-text-primary);">
                          ${oItems.length > 0
                            ? oItems.map(it => `<strong>${escapeHtml(it.product_name)}</strong> (${escapeHtml(it.pack_label)} &times; ${it.quantity})`).join(', ')
                            : 'Pantry Order Packs'}
                        </div>
                      </div>

                      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;padding:10px 12px;border-radius:6px;background-color:var(--sn-bg-surface);border:1px solid var(--sn-border-warm);">
                        <div style="font-family:var(--sn-font-mono);font-size:0.76rem;line-height:1.4;">
                          <span style="color:var(--sn-text-muted);display:block;font-size:0.69rem;text-transform:uppercase;">Courier &amp; AWB</span>
                          ${o.courier_name ? `<strong>${escapeHtml(o.courier_name)}</strong><br/>AWB: ${escapeHtml(o.tracking_number)}` : (['Cancelled', 'Refunded', 'Refund Initiated'].includes(o.fulfilment_status) ? escapeHtml(o.fulfilment_status) : 'Awaiting Dispatch')}
                        </div>
                        <div style="display:flex;gap:8px;flex-wrap:wrap;">
                          <a href="${basePath}/track-order?order=${encodeURIComponent(o.order_number)}" class="sn-btn sn-btn-forest sn-btn-sm">Track Order</a>
                          <a href="${basePath}/orders/${encodeURIComponent(o.order_number)}/invoice" class="sn-btn sn-btn-outline sn-btn-sm">GST Invoice</a>
                        </div>
                      </div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        </div>
        ` : `<div id="sn-customer-authenticated-sections" style="display:none;"></div>`}
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
  const description = 'Sign in with your Sashya Naturals staff account to access the role-based administration portal.';
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
          <span class="sn-eyebrow sn-eyebrow-pill">Staff Operations &amp; Role-Based Administration</span>
          <h1 class="sn-admin-login-h1">Sashya Naturals Staff Sign In</h1>
          <p style="font-size:0.88rem;color:var(--sn-text-secondary);margin:0 0 20px;">
            Sign in with your authorized staff credentials to access your role-assigned administration modules.
          </p>
          <form id="sn-admin-login-form">
            <div style="margin-bottom:14px;">
              <label for="admin-login-email" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">Staff Email Address *</label>
              <input type="email" name="email" id="admin-login-email" required value="" placeholder="staff@sashyanaturals.com" class="sn-input" />
            </div>
            <div style="margin-bottom:18px;">
              <label for="admin-login-password" style="font-size:0.8rem;font-weight:600;display:block;margin-bottom:4px;">Password *</label>
              <input type="password" name="password" id="admin-login-password" required value="" placeholder="Enter staff password" class="sn-input" />
            </div>
            <button type="submit" class="sn-btn sn-btn-forest" style="width:100%;padding:12px;">Sign In to Admin Portal &rarr;</button>
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
  const description = 'Role-based administration portal for Sashya Naturals Super Admin, Product Manager, Order Manager, Accounts Manager, and Staff.';
  const schemaGraph = buildMasterSchemaGraph({
    pageType: 'webpage',
    canonicalPath: '/admin',
    title,
    description,
    breadcrumbs: [{ name: 'Home', url: '/' }, { name: 'Admin Portal', url: '/admin' }]
  });

  const itemsByOrderId = new Map();
  for (const it of orderItems) {
    const oid = Number(it.order_id);
    if (!itemsByOrderId.has(oid)) itemsByOrderId.set(oid, []);
    itemsByOrderId.get(oid).push(it);
  }
  const refundByOrderId = new Map();
  for (const p of payments) {
    if (p.order_id && Number(p.refund_amount_paise) > 0) {
      refundByOrderId.set(Number(p.order_id), Number(p.refund_amount_paise));
    }
  }

  const totalRevenuePaise = orders
    .filter(o => ['PAID', 'COD_COLLECTED', 'PARTIALLY_REFUNDED'].includes(o.payment_status) && o.fulfilment_status !== 'Cancelled' && o.fulfilment_status !== 'Refunded')
    .reduce((acc, o) => {
      const partialRef = o.payment_status === 'PARTIALLY_REFUNDED' ? (refundByOrderId.get(Number(o.id)) || 0) : 0;
      return acc + Math.max(0, Number(o.total_paise || 0) - partialRef);
    }, 0);
  const codPendingPaise = orders
    .filter(o => o.payment_status === 'COD_PENDING' && o.fulfilment_status !== 'Cancelled')
    .reduce((acc, o) => acc + o.total_paise, 0);
  const refundedPaise = orders
    .filter(o => ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(o.payment_status))
    .reduce((acc, o) => {
      const explicitRef = refundByOrderId.get(Number(o.id));
      return acc + (explicitRef > 0 ? Math.min(o.total_paise, explicitRef) : (o.payment_status === 'REFUNDED' ? o.total_paise : 0));
    }, 0);
  const totalGstPaise = orders
    .filter(o => o.payment_status !== 'REFUNDED' && o.payment_status !== 'FAILED' && o.fulfilment_status !== 'Cancelled')
    .reduce((acc, o) => acc + (o.gst_paise || 0), 0);
  const lowStockVariants = variants.filter(v => v.stock_qty <= v.low_stock_threshold);
  const configuredVaultCount = vaultStatus.filter(v => v.is_configured).length;
  const pendingFulfilmentOrders = orders.filter(o => o.fulfilment_status === 'Confirmed' || o.fulfilment_status === 'Pending Payment' || o.fulfilment_status === 'Processing');

  const reports = buildComprehensiveReports({
    orders,
    orderItems,
    payments,
    products,
    categories
  });

  const contentAndSeo = getStorefrontContentAndSeo();

  // Customer & Signed-Up User Purchase Intelligence Aggregation (Module 6 Users & Purchases)
  const customerDirectoryMap = new Map();
  for (const cu of customerUsers) {
    const userAddrs = customerAddresses.filter(a => Number(a.user_id) === Number(cu.id));
    const defAddr = userAddrs.find(a => Number(a.is_default) === 1) || userAddrs[0] || null;
    customerDirectoryMap.set(cu.email.toLowerCase(), {
      userId: cu.id,
      userIdLabel: `USR-${cu.id}`,
      joinedDate: (cu.created_at || '2026-11-20').slice(0, 10),
      fullName: cu.full_name,
      email: cu.email,
      phone: cu.phone,
      accountType: 'Registered Customer',
      isRegistered: true,
      addressCount: userAddrs.length,
      defaultCity: defAddr ? defAddr.city : 'Not Provided',
      defaultState: defAddr ? defAddr.state : 'Not Provided',
      defaultPincode: defAddr ? defAddr.pincode : 'Not Provided',
      orderNumbers: [],
      totalPacksBought: 0,
      settledSpendPaise: 0,
      codPendingPaise: 0,
      totalSpendPaise: 0,
      lastOrderDate: 'No orders yet',
      purchasedItemsList: [],
      detailedOrders: []
    });
  }
  for (const ord of orders) {
    const em = (ord.customer_email || '').toLowerCase();
    const existing = customerDirectoryMap.get(em) || {
      userId: ord.user_id || null,
      userIdLabel: ord.user_id ? `USR-${ord.user_id}` : 'GUEST',
      joinedDate: (ord.created_at || '2026-11-20').slice(0, 10),
      fullName: ord.customer_name,
      email: ord.customer_email,
      phone: ord.customer_phone,
      accountType: ord.user_id ? 'Registered Customer' : 'Guest Checkout',
      isRegistered: Boolean(ord.user_id),
      addressCount: 1,
      defaultCity: ord.shipping_city || 'Not Provided',
      defaultState: ord.shipping_state || 'Not Provided',
      defaultPincode: ord.shipping_pincode || 'Not Provided',
      orderNumbers: [],
      totalPacksBought: 0,
      settledSpendPaise: 0,
      codPendingPaise: 0,
      totalSpendPaise: 0,
      lastOrderDate: 'No orders yet',
      purchasedItemsList: [],
      detailedOrders: []
    };
    if (existing.defaultCity === 'Not Provided' && ord.shipping_city) {
      existing.defaultCity = ord.shipping_city;
      existing.defaultState = ord.shipping_state || 'Not Provided';
      existing.defaultPincode = ord.shipping_pincode || 'Not Provided';
    }
    const oItems = itemsByOrderId.get(Number(ord.id)) || [];
    const ordPacks = oItems.reduce((acc, it) => acc + Number(it.quantity || 0), 0);
    existing.orderNumbers.push(ord.order_number);
    const isCancelledOrReversed = ord.payment_status === 'REFUNDED' || ord.payment_status === 'FAILED' || ord.fulfilment_status === 'Cancelled' || ord.fulfilment_status === 'Refunded';
    if (!isCancelledOrReversed) {
      existing.totalPacksBought += ordPacks;
      existing.totalSpendPaise += Number(ord.total_paise || 0);
      if (ord.payment_status === 'PAID' || ord.payment_status === 'COD_COLLECTED') {
        existing.settledSpendPaise += Number(ord.total_paise || 0);
      } else if (ord.payment_status === 'COD_PENDING') {
        existing.codPendingPaise += Number(ord.total_paise || 0);
      }
    }
    const ordDate = (ord.created_at || '').slice(0, 10);
    if (existing.lastOrderDate === 'No orders yet' || ordDate > existing.lastOrderDate) {
      existing.lastOrderDate = ordDate;
    }
    for (const it of oItems) {
      existing.purchasedItemsList.push(`${it.product_name} (${it.pack_label} × ${it.quantity})`);
    }
    existing.detailedOrders.push({
      orderNumber: ord.order_number,
      orderDate: ordDate,
      paymentMethod: ord.payment_method,
      paymentStatus: ord.payment_status,
      fulfilmentStatus: ord.fulfilment_status,
      totalPaise: Number(ord.total_paise || 0),
      shippingCity: ord.shipping_city,
      shippingState: ord.shipping_state,
      shippingPincode: ord.shipping_pincode,
      items: oItems
    });
    customerDirectoryMap.set(em, existing);
  }
  const customerDirectoryRows = Array.from(customerDirectoryMap.values());

  // Build Customer Quick-Fill Presets for Admin Manual Order Creation
  const customerQuickFillMap = new Map();
  for (const cu of customerUsers) {
    const addr = customerAddresses.find(a => Number(a.user_id) === Number(cu.id) && Number(a.is_default) === 1)
      || customerAddresses.find(a => Number(a.user_id) === Number(cu.id));
    const latestOrd = orders.find(o => Number(o.user_id) === Number(cu.id) || (o.customer_email || '').toLowerCase() === cu.email.toLowerCase());
    customerQuickFillMap.set(cu.email.toLowerCase(), {
      userId: cu.id,
      customerName: (addr && addr.recipient_name) || cu.full_name,
      customerEmail: cu.email,
      customerPhone: (addr && addr.phone) || cu.phone || (latestOrd ? latestOrd.customer_phone : '9845011223'),
      shippingLine1: (addr && addr.line1) || (latestOrd ? latestOrd.shipping_line1 : 'No. 48, 100 Feet Road, Indiranagar'),
      shippingLine2: (addr && addr.line2) || (latestOrd ? latestOrd.shipping_line2 : ''),
      shippingCity: (addr && addr.city) || (latestOrd ? latestOrd.shipping_city : 'Bengaluru'),
      shippingState: (addr && addr.state) || (latestOrd ? latestOrd.shipping_state : 'Karnataka'),
      shippingPincode: (addr && addr.pincode) || (latestOrd ? latestOrd.shipping_pincode : '560038')
    });
  }
  for (const ord of orders) {
    const em = (ord.customer_email || '').toLowerCase();
    if (em && !customerQuickFillMap.has(em)) {
      customerQuickFillMap.set(em, {
        userId: ord.user_id || '',
        customerName: ord.customer_name,
        customerEmail: ord.customer_email,
        customerPhone: ord.customer_phone,
        shippingLine1: ord.shipping_line1,
        shippingLine2: ord.shipping_line2 || '',
        shippingCity: ord.shipping_city,
        shippingState: ord.shipping_state,
        shippingPincode: ord.shipping_pincode
      });
    }
  }
  const customerQuickFillPresets = Array.from(customerQuickFillMap.values());

  const activeVariantsForOrderOptionsHtml = variants
    .filter(v => Number(v.is_active) !== 0 && Number(v.stock_qty) > 0)
    .map(v => {
      const prod = products.find(p => Number(p.id) === Number(v.product_id));
      if (!prod || Number(prod.is_active) === 0) return '';
      const unitPricePaise = v.promo_price_paise && Number(v.promo_price_paise) > 0
        ? Number(v.promo_price_paise)
        : Number(v.selling_price_paise);
      return `<option
        value="${v.id}"
        data-unit-price-paise="${unitPricePaise}"
        data-gst-percent="${prod.gst_percent || 5}"
        data-weight-grams="${v.weight_grams || 250}"
        data-stock-qty="${v.stock_qty}"
        data-product-name="${escapeHtml(prod.name)}"
        data-pack-label="${escapeHtml(v.pack_label)}"
        data-sku="${escapeHtml(v.sku)}"
      >${escapeHtml(prod.name)} — ${escapeHtml(v.pack_label)} (${escapeHtml(v.sku)}) • ${formatInr(unitPricePaise)} • Stock: ${v.stock_qty}</option>`;
    })
    .filter(Boolean)
    .join('');

  const isShowcase = Boolean(staticShowcaseScript);
  const activeAdminRole = (!isShowcase && authenticatedAdmin && authenticatedAdmin.role)
    ? authenticatedAdmin.role
    : 'SUPER_ADMIN';
  const activeAdminEmail = (authenticatedAdmin && authenticatedAdmin.email) || 'superadmin@sashyanaturals.com';
  const activeAdminName = (authenticatedAdmin && authenticatedAdmin.full_name) || 'Super Administrator';
  const roleAllowedModulesMap = {
    SUPER_ADMIN: ['orders', 'vault', 'products', 'inventory', 'payments', 'customers', 'rbac', 'compliance', 'content'],
    PRODUCT_MANAGER: ['products', 'inventory'],
    ORDER_MANAGER: ['orders', 'inventory', 'customers'],
    ACCOUNTS_MANAGER: ['payments', 'orders', 'customers'],
    STAFF: ['orders', 'inventory']
  };
  const allowedModules = roleAllowedModulesMap[activeAdminRole] || roleAllowedModulesMap.SUPER_ADMIN;
  const modDisplayStyle = (modKey) => (isShowcase || allowedModules.includes(modKey)) ? '' : 'display:none;';
  const defaultAdminMod = isShowcase ? 'orders' : (allowedModules[0] || 'orders');
  const panelDisplayStyle = (modKey) => defaultAdminMod === modKey ? '' : 'display:none;';

  const bodyHtml = `
    <section class="sn-section" id="sn-admin-portal" data-active-admin-role="${escapeHtml(activeAdminRole)}">
      <div class="sn-container">
        <input type="hidden" id="sn-admin-active-email" value="${escapeHtml(activeAdminEmail)}" />
        <!-- Staff Authentication & RBAC Session Bar -->
        <div class="sn-filter-bar sn-admin-session-bar" style="background-color:var(--sn-bg-forest);color:#FAF5E4;border-color:var(--sn-bg-forest);margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;width:100%;gap:10px;flex-wrap:wrap;">
            <div>
              <span class="sn-eyebrow" style="color:var(--sn-accent-turmeric);margin-bottom:2px;">${isShowcase ? 'Interactive RBAC Showcase • 5 Staff Roles &amp; Write-Only API Vault' : 'Authenticated Staff Operations Portal'}</span>
              <h1 class="sn-admin-banner-h1">Sashya Naturals Operations &amp; Administration</h1>
            </div>
            ${isShowcase ? `
              <button
                type="button"
                class="sn-btn sn-btn-outline sn-btn-sm sn-admin-auth-toggle"
                id="sn-admin-auth-toggle-btn"
                data-toggle-admin-login
              >🔑 Staff Login / Sign Out</button>
            ` : `
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <span class="sn-status sn-status-paid" style="background-color:rgba(255,255,255,0.14);color:#FAF5E4;border:1px solid rgba(255,255,255,0.28);">
                  Signed In: ${escapeHtml(activeAdminName)} (${escapeHtml(activeAdminRole)})
                </span>
                <button type="button" id="sn-admin-logout-btn" class="sn-btn sn-btn-outline sn-btn-sm">Sign Out</button>
              </div>
            `}
          </div>
          ${isShowcase ? `
            <div class="sn-admin-session-controls" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;width:100%;">
              <form id="sn-admin-login-form" class="sn-admin-login-form" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                <input type="email" name="email" id="sn-admin-auth-email" value="${escapeHtml(activeAdminEmail)}" placeholder="Staff Email" class="sn-input sn-admin-email-input" style="padding:6px 10px;font-size:0.78rem;" />
                <input type="password" name="password" value="Sashya@2026" placeholder="Password" class="sn-input sn-admin-pass-input" style="padding:6px 10px;font-size:0.78rem;" />
                <button type="submit" class="sn-btn sn-btn-primary sn-btn-sm">Staff Sign In</button>
                <button type="button" id="sn-admin-logout-btn" class="sn-btn sn-btn-outline sn-btn-sm">Sign Out</button>
              </form>
              <div class="sn-admin-role-wrap" style="display:flex;align-items:center;gap:6px;flex:1;min-width:240px;">
                <label for="sn-admin-role-switcher" style="font-family:var(--sn-font-mono);font-size:0.74rem;white-space:nowrap;">Active Role:</label>
                <select id="sn-admin-role-switcher" class="sn-select sn-admin-role-select" style="font-weight:600;padding:6px 10px;font-size:0.78rem;flex:1;">
                  ${staffUsers.map(u => `
                    <option value="${escapeHtml(u.email)}">${escapeHtml(u.role)} - ${escapeHtml(u.full_name)}${u.is_active ? '' : ' (Inactive)'}</option>
                  `).join('')}
                </select>
              </div>
            </div>
          ` : ''}
        </div>

        <!-- Operational Admin Alerts Strip (New Orders, Low Stock, Payment/COD Exceptions) -->
        <div class="sn-card sn-admin-alerts-bar" style="background-color:var(--sn-bg-mortar);padding:10px 16px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div style="font-family:var(--sn-font-mono);font-size:0.76rem;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <strong>🔔 Alerts:</strong>
            <span class="sn-status sn-status-paid">Awaiting Dispatch: ${pendingFulfilmentOrders.length}</span>
            <span class="sn-status ${lowStockVariants.length > 0 ? 'sn-status-danger' : 'sn-status-paid'}">Low-Stock: ${lowStockVariants.length}</span>
            <span class="sn-status ${codPendingPaise > 0 ? 'sn-status-warn' : 'sn-status-paid'}">COD Pending: ${formatInr(codPendingPaise)}</span>
          </div>
          <span class="sn-admin-catalogue-meta" style="font-family:var(--sn-font-mono);font-size:0.73rem;color:var(--sn-text-muted);">Catalogue: ${categories.length} Categories • ${products.length} Products • ${variants.length} Variants</span>
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
            <div class="sn-admin-sidebar-label" style="font-family:var(--sn-font-mono);font-size:0.73rem;text-transform:uppercase;color:#DCE2F2;">${isShowcase ? 'Admin Modules (Section 5.1)' : `Assigned Modules (${escapeHtml(activeAdminRole)})`}</div>
            <ul class="sn-admin-menu">
              <li style="${modDisplayStyle('orders')}"><button type="button" class="${defaultAdminMod === 'orders' ? 'sn-active' : ''}" data-admin-tab-btn="orders" id="tab-btn-orders">1. Orders &amp; Manual Shipping</button></li>
              <li style="${modDisplayStyle('vault')}"><button type="button" class="${defaultAdminMod === 'vault' ? 'sn-active' : ''}" data-admin-tab-btn="vault" id="tab-btn-vault">2. API &amp; Razorpay Key Vault</button></li>
              <li style="${modDisplayStyle('products')}">
                <button type="button" class="${defaultAdminMod === 'products' ? 'sn-active' : ''}" data-admin-tab-btn="products" id="tab-btn-products">3. Categories, Products &amp; Media ▾</button>
                <ul class="sn-admin-submenu ${defaultAdminMod === 'products' ? 'sn-submenu-open' : ''}" data-admin-submenu-for="products">
                  <li><button type="button" class="sn-admin-subbtn sn-sub-active" data-admin-subtab-link="products:catalogue">3.1 Products Catalogue (${products.length})</button></li>
                  <li><button type="button" class="sn-admin-subbtn" data-admin-subtab-link="products:categories">3.2 Categories &amp; Banners (${categories.length})</button></li>
                </ul>
              </li>
              <li style="${modDisplayStyle('inventory')}">
                <button type="button" class="${defaultAdminMod === 'inventory' ? 'sn-active' : ''}" data-admin-tab-btn="inventory" id="tab-btn-inventory">4. Inventory &amp; Stock Ledger (${variants.length}) ▾</button>
                <ul class="sn-admin-submenu ${defaultAdminMod === 'inventory' ? 'sn-submenu-open' : ''}" data-admin-submenu-for="inventory">
                  <li><button type="button" class="sn-admin-subbtn sn-sub-active" data-admin-subtab-link="inventory:variants">4.1 Variant Stock (${variants.length} SKUs)</button></li>
                  <li><button type="button" class="sn-admin-subbtn" data-admin-subtab-link="inventory:movements">4.2 Stock Movement Ledger</button></li>
                </ul>
              </li>
              <li style="${modDisplayStyle('payments')}">
                <button type="button" class="${defaultAdminMod === 'payments' ? 'sn-active' : ''}" data-admin-tab-btn="payments" id="tab-btn-payments">5. Payments, COD &amp; Reports ▾</button>
                <ul class="sn-admin-submenu ${defaultAdminMod === 'payments' ? 'sn-submenu-open' : ''}" data-admin-submenu-for="payments">
                  <li><button type="button" class="sn-admin-subbtn sn-sub-active" data-admin-subtab-link="payments:reconciliation">5.1 Payments, COD &amp; Refunds</button></li>
                  <li><button type="button" class="sn-admin-subbtn" data-admin-subtab-link="payments:sales-timeseries">5.2 Daily / Weekly / Monthly Sales</button></li>
                  <li><button type="button" class="sn-admin-subbtn" data-admin-subtab-link="payments:product-sales">5.3 Product-Wise Sales (${reports.productSales.length})</button></li>
                  <li><button type="button" class="sn-admin-subbtn" data-admin-subtab-link="payments:gst-summaries">5.4 GST Tax &amp; Gateway Summaries</button></li>
                </ul>
              </li>
              <li style="${modDisplayStyle('customers')}">
                <button type="button" class="${defaultAdminMod === 'customers' ? 'sn-active' : ''}" data-admin-tab-btn="customers" id="tab-btn-customers">6. Users, Purchases &amp; Export ▾</button>
                <ul class="sn-admin-submenu" data-admin-submenu-for="customers">
                  <li><button type="button" class="sn-admin-subbtn sn-sub-active" data-admin-subtab-link="customers:users">6.1 Signed-Up Users &amp; Purchases (${customerDirectoryRows.length})</button></li>
                  <li><button type="button" class="sn-admin-subbtn" data-admin-subtab-link="customers:addresses">6.2 Saved Addresses Directory (${customerAddresses.length})</button></li>
                </ul>
              </li>
              <li style="${modDisplayStyle('rbac')}">
                <button type="button" class="${defaultAdminMod === 'rbac' ? 'sn-active' : ''}" data-admin-tab-btn="rbac" id="tab-btn-rbac">7. Staff RBAC &amp; Audit Logs ▾</button>
                <ul class="sn-admin-submenu" data-admin-submenu-for="rbac">
                  <li><button type="button" class="sn-admin-subbtn sn-sub-active" data-admin-subtab-link="rbac:staff">7.1 Staff Accounts &amp; RBAC (${staffUsers.length})</button></li>
                  <li><button type="button" class="sn-admin-subbtn" data-admin-subtab-link="rbac:audit-logs">7.2 Immutable Audit Logs (${auditLogs.length})</button></li>
                </ul>
              </li>
              <li style="${modDisplayStyle('compliance')}">
                <button type="button" class="${defaultAdminMod === 'compliance' ? 'sn-active' : ''}" data-admin-tab-btn="compliance" id="tab-btn-compliance">8. Shipping, GST, FSSAI &amp; Templates ▾</button>
                <ul class="sn-admin-submenu" data-admin-submenu-for="compliance">
                  <li><button type="button" class="sn-admin-subbtn sn-sub-active" data-admin-subtab-link="compliance:shipping">8.1 Delivery Pricing (4-Zone)</button></li>
                  <li><button type="button" class="sn-admin-subbtn" data-admin-subtab-link="compliance:legal-templates">8.2 GSTIN, FSSAI &amp; Templates</button></li>
                  <li><button type="button" class="sn-admin-subbtn" data-admin-subtab-link="compliance:notif-logs">8.3 Notification Logs (${notificationLogs.length})</button></li>
                </ul>
              </li>
              <li style="${modDisplayStyle('content')}">
                <button type="button" class="${defaultAdminMod === 'content' ? 'sn-active' : ''}" data-admin-tab-btn="content" id="tab-btn-content">9. Content, SEO, Coupons &amp; Hello Bar ▾</button>
                <ul class="sn-admin-submenu" data-admin-submenu-for="content">
                  <li><button type="button" class="sn-admin-subbtn sn-sub-active" data-admin-subtab-link="content:homepage">9.1 Homepage Hero, Topbar &amp; Footer</button></li>
                  <li><button type="button" class="sn-admin-subbtn" data-admin-subtab-link="content:pages">9.2 Info &amp; Policy Pages (6 Pages)</button></li>
                  <li><button type="button" class="sn-admin-subbtn" data-admin-subtab-link="content:seo">9.3 Route SEO Meta &amp; SERP Preview</button></li>
                  <li><button type="button" class="sn-admin-subbtn" data-admin-subtab-link="content:coupons">9.4 Coupons, Promotions &amp; Hello Bar</button></li>
                </ul>
              </li>
            </ul>
          </aside>

          <div>
            <!-- Panel 1: Orders & Manual Shipping (Full Delivery Address, Pick & Pack List, Copy Label & Manual Courier Dispatch) -->
            <div class="sn-card" data-admin-panel="orders" style="${panelDisplayStyle('orders')}">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:14px;">
                <div>
                  <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Orders, Delivery Addresses, Pick-and-Pack &amp; Manual Courier Dispatch</h2>
                  <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0;">
                    Authorized for <strong>SUPER_ADMIN</strong>, <strong>ORDER_MANAGER</strong>, and permitted <strong>STAFF</strong>. Actionable unshipped orders expand automatically; completed/shipped orders collapse into 1-line summary cards.
                  </p>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
                  <button type="button" class="sn-btn sn-btn-forest sn-btn-sm" id="sn-admin-open-create-order-btn" data-open-create-order-modal>+ Create Manual Order &amp; GST Invoice</button>
                  <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-admin-orders-expand-all-btn">▾ Expand All Orders</button>
                </div>
              </div>

              <!-- 1-Tap Triage Queue Pills + Live Multi-Field Order Search & Payment Filter -->
              <div class="sn-card" id="sn-admin-orders-toolbar" style="background-color:var(--sn-bg-mortar);padding:12px 14px;margin-bottom:16px;">
                <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
                  <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
                    <button type="button" class="sn-btn sn-btn-forest sn-btn-sm" data-order-queue-pill="all">All Orders (${orders.length})</button>
                    <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-order-queue-pill="needs_dispatch">⚡ Needs Dispatch (${orders.filter(o => ['Pending Payment', 'Confirmed', 'Processing', 'Packed'].includes(o.fulfilment_status)).length})</button>
                    <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-order-queue-pill="shipped">🚚 Shipped (${orders.filter(o => o.fulfilment_status === 'Shipped').length})</button>
                    <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-order-queue-pill="delivered">✓ Delivered (${orders.filter(o => o.fulfilment_status === 'Delivered').length})</button>
                    <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-order-queue-pill="cod_pending">💵 COD Pending (${orders.filter(o => o.payment_status === 'COD_PENDING' && o.fulfilment_status !== 'Cancelled').length})</button>
                  </div>
                  <span id="sn-admin-orders-count-badge" class="sn-status sn-status-paid" style="font-family:var(--sn-font-mono);">Showing ${orders.length} of ${orders.length} Orders</span>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
                  <input type="search" id="sn-admin-orders-search" placeholder="Search Order #, Customer Name, Phone, City, PIN, Courier, or AWB..." class="sn-input" style="flex:1;min-width:190px;" />
                  <select id="sn-admin-orders-payment-filter" class="sn-select" style="width:auto;min-width:165px;">
                    <option value="all">Payment: All Statuses</option>
                    <option value="PAID">PAID (Verified Prepaid)</option>
                    <option value="PENDING_PAYMENT">PENDING_PAYMENT (Awaiting Transfer)</option>
                    <option value="COD_PENDING">COD_PENDING (Uncollected)</option>
                    <option value="COD_COLLECTED">COD_COLLECTED</option>
                    <option value="REFUNDED">REFUNDED</option>
                    <option value="FAILED">FAILED</option>
                  </select>
                </div>
              </div>

              <div id="sn-admin-orders-cards-container">
              ${orders.map(o => {
                const oItems = itemsByOrderId.get(Number(o.id)) || [];
                const netGrams = oItems.reduce((acc, it) => acc + Number(it.weight_grams || 0) * Number(it.quantity || 0), 0);
                const grossGrams = netGrams > 0 ? netGrams + 150 : 650;
                const fullAddressSingleLine = `${o.customer_name} (${o.customer_phone}) | ${o.shipping_line1}${o.shipping_line2 ? ', ' + o.shipping_line2 : ''}, ${o.shipping_city}, ${o.shipping_state} - ${o.shipping_pincode} | Order: ${o.order_number} (${o.payment_method}: ${formatInr(o.total_paise)})`;
                const isActionable = ['Pending Payment', 'Confirmed', 'Processing', 'Packed'].includes(o.fulfilment_status);

                return `
                <div
                  class="sn-card"
                  style="margin-bottom:12px;background-color:var(--sn-bg-parchment);padding:12px 14px;"
                  data-order-card="${escapeHtml(o.order_number)}"
                  data-order-fulfilment="${escapeHtml(o.fulfilment_status)}"
                  data-order-payment="${escapeHtml(o.payment_status)}"
                  data-order-needs-dispatch="${isActionable ? '1' : '0'}"
                >
                  <!-- Always-Visible Rich 1-Line Summary Accordion Header -->
                  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1;min-width:210px;">
                      <strong style="font-family:var(--sn-font-mono);font-size:1rem;color:var(--sn-bg-forest);">${escapeHtml(o.order_number)}</strong>
                      <span style="font-size:0.84rem;font-weight:600;color:var(--sn-text-primary);">${escapeHtml(o.customer_name)}</span>
                      <span style="font-family:var(--sn-font-mono);font-size:0.75rem;color:var(--sn-text-secondary);">(${escapeHtml(o.shipping_city)} - ${escapeHtml(o.shipping_pincode)})</span>
                      <span style="font-family:var(--sn-font-mono);font-size:0.74rem;color:var(--sn-text-muted);">• ${oItems.length} SKUs (${grossGrams}g) • ${escapeHtml((o.created_at || '').slice(0, 10))}</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                      <span class="sn-status ${o.payment_status === 'PAID' || o.payment_status === 'COD_COLLECTED' ? 'sn-status-paid' : 'sn-status-warn'}">${escapeHtml(o.payment_status)}</span>
                      <span class="sn-status ${isActionable ? 'sn-status-warn' : 'sn-status-paid'}">${escapeHtml(o.fulfilment_status)}</span>
                      <strong style="font-family:var(--sn-font-mono);font-size:0.98rem;color:var(--sn-bg-forest);">${formatInr(o.total_paise)}</strong>
                      <button
                        type="button"
                        class="sn-btn ${isActionable ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm"
                        data-toggle-order-accordion="${escapeHtml(o.order_number)}"
                        aria-expanded="${isActionable ? 'true' : 'false'}"
                      >${isActionable ? '▴ Collapse' : '▾ Manage / Dispatch'}</button>
                    </div>
                  </div>

                  <!-- Collapsible Accordion Body (Expanded by default for Actionable Orders, Collapsed for Shipped/Delivered) -->
                  <div
                    data-order-accordion-body="${escapeHtml(o.order_number)}"
                    style="display:${isActionable ? 'block' : 'none'};margin-top:12px;padding-top:12px;border-top:1px solid var(--sn-border-warm);"
                  >
                    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
                      <button
                        type="button"
                        class="sn-btn sn-btn-outline sn-btn-sm"
                        data-copy-shipping-label="${escapeHtml(fullAddressSingleLine)}"
                      >📋 Copy Label</button>
                      <button
                        type="button"
                        class="sn-btn sn-btn-outline sn-btn-sm"
                        data-toggle-edit-addr="${escapeHtml(o.order_number)}"
                      >✏️ Edit Address</button>
                      <a href="${basePath}/orders/${escapeHtml(o.order_number)}/invoice" class="sn-btn sn-btn-outline sn-btn-sm">GST Invoice</a>
                    </div>

                    <!-- Ship-To Delivery Address & Pick-and-Pack Items Grid -->
                    <div class="sn-grid-2" style="gap:14px;margin-bottom:14px;">
                      <div class="sn-card" style="padding:12px 14px;background-color:var(--sn-bg-surface);">
                        <div style="font-family:var(--sn-font-mono);font-size:0.72rem;text-transform:uppercase;color:var(--sn-text-muted);margin-bottom:4px;">
                          📍 Ship-To Delivery Address &amp; Recipient Contact
                        </div>
                        <div style="font-size:0.86rem;line-height:1.45;color:var(--sn-text-primary);overflow-wrap:anywhere;" data-order-address-display="${escapeHtml(o.order_number)}">
                          <strong>${escapeHtml(o.customer_name)}</strong> • <span style="font-family:var(--sn-font-mono);">${escapeHtml(o.customer_phone)}</span> (${escapeHtml(o.customer_email)})<br/>
                          ${escapeHtml(o.shipping_line1)}${o.shipping_line2 ? ', ' + escapeHtml(o.shipping_line2) : ''}<br/>
                          <strong>${escapeHtml(o.shipping_city)}, ${escapeHtml(o.shipping_state)} - <span style="font-family:var(--sn-font-mono);color:var(--sn-bg-forest);">${escapeHtml(o.shipping_pincode)}</span></strong>
                        </div>
                        <div style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--sn-border-warm);font-size:0.78rem;color:var(--sn-text-secondary);">
                          <strong>Delivery Instructions:</strong> ${escapeHtml(o.delivery_instructions || 'Standard doorstep delivery (no special instructions)')}
                        </div>
                      </div>

                      <div class="sn-card" style="padding:12px 14px;background-color:var(--sn-bg-surface);">
                        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px;">
                          <span style="font-family:var(--sn-font-mono);font-size:0.72rem;text-transform:uppercase;color:var(--sn-text-muted);">
                            📦 Pick-and-Pack Items (${oItems.length} SKUs)
                          </span>
                          <span style="font-family:var(--sn-font-mono);font-size:0.73rem;font-weight:700;color:var(--sn-bg-forest);">
                            Net: ${netGrams}g | Gross Parcel: ${grossGrams}g
                          </span>
                        </div>
                        <div style="font-size:0.81rem;line-height:1.45;">
                          ${oItems.length > 0 ? oItems.map(it => `
                            <div style="display:flex;justify-content:space-between;gap:8px;padding:2px 0;border-bottom:1px dotted var(--sn-border-warm);">
                              <span><strong style="font-family:var(--sn-font-mono);font-size:0.74rem;">${escapeHtml(it.sku)}</strong> • ${escapeHtml(it.product_name)} (<strong>${escapeHtml(it.pack_label)} × ${it.quantity}</strong>)</span>
                              <span style="font-family:var(--sn-font-mono);white-space:nowrap;">${formatInr(it.line_total_paise)}</span>
                            </div>
                          `).join('') : '<span style="color:var(--sn-text-muted);">Order items recorded in ledger</span>'}
                        </div>
                      </div>
                    </div>

                    <!-- Collapsible Inline Pre-Dispatch Delivery Address Editor -->
                    <form
                      class="sn-admin-edit-address-form sn-card"
                      data-edit-addr-form="${escapeHtml(o.order_number)}"
                      style="display:none;background-color:var(--sn-bg-mortar);padding:12px 14px;margin-bottom:12px;"
                    >
                      <div style="font-family:var(--sn-font-mono);font-size:0.74rem;font-weight:700;color:var(--sn-bg-forest);margin-bottom:8px;">
                        Update Delivery Address &amp; Instructions for ${escapeHtml(o.order_number)}
                      </div>
                      <input type="hidden" name="orderNumber" value="${escapeHtml(o.order_number)}" />
                      <div class="sn-grid-4" style="gap:8px;margin-bottom:8px;">
                        <div>
                          <label style="font-size:0.72rem;font-weight:600;">Recipient Name *</label>
                          <input type="text" name="customerName" required value="${escapeHtml(o.customer_name)}" class="sn-input" style="padding:5px 8px;font-size:0.78rem;" />
                        </div>
                        <div>
                          <label style="font-size:0.72rem;font-weight:600;">Mobile Phone *</label>
                          <input type="text" name="customerPhone" required value="${escapeHtml(o.customer_phone)}" class="sn-input" style="padding:5px 8px;font-size:0.78rem;" />
                        </div>
                        <div>
                          <label style="font-size:0.72rem;font-weight:600;">Street Address (Line 1) *</label>
                          <input type="text" name="shippingLine1" required value="${escapeHtml(o.shipping_line1)}" class="sn-input" style="padding:5px 8px;font-size:0.78rem;" />
                        </div>
                        <div>
                          <label style="font-size:0.72rem;font-weight:600;">Landmark / Area (Line 2)</label>
                          <input type="text" name="shippingLine2" value="${escapeHtml(o.shipping_line2)}" class="sn-input" style="padding:5px 8px;font-size:0.78rem;" />
                        </div>
                      </div>
                      <div class="sn-grid-5" style="gap:8px;align-items:end;">
                        <div>
                          <label style="font-size:0.72rem;font-weight:600;">City *</label>
                          <input type="text" name="shippingCity" required value="${escapeHtml(o.shipping_city)}" class="sn-input" style="padding:5px 8px;font-size:0.78rem;" />
                        </div>
                        <div>
                          <label style="font-size:0.72rem;font-weight:600;">State *</label>
                          <input type="text" name="shippingState" required value="${escapeHtml(o.shipping_state)}" class="sn-input" style="padding:5px 8px;font-size:0.78rem;" />
                        </div>
                        <div>
                          <label style="font-size:0.72rem;font-weight:600;">6-Digit PIN *</label>
                          <input type="text" name="shippingPincode" required pattern="\\d{6}" value="${escapeHtml(o.shipping_pincode)}" class="sn-input" style="padding:5px 8px;font-size:0.78rem;font-family:var(--sn-font-mono);" />
                        </div>
                        <div>
                          <label style="font-size:0.72rem;font-weight:600;">Delivery Instructions</label>
                          <input type="text" name="deliveryInstructions" value="${escapeHtml(o.delivery_instructions)}" class="sn-input" style="padding:5px 8px;font-size:0.78rem;" />
                        </div>
                        <button type="submit" class="sn-btn sn-btn-primary sn-btn-sm">Save Address</button>
                      </div>
                    </form>

                    <!-- Manual Courier Dispatch Form -->
                    <form class="sn-admin-ship-form">
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
                </div>
                `;
              }).join('')}
              </div>
              <div id="sn-admin-orders-pagination" class="sn-admin-pagination-bar"></div>

              <!-- Admin Manual Order Creation & Auto-Generated GST Invoice Modal -->
              <div id="sn-admin-create-order-modal" class="sn-admin-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="sn-create-order-modal-heading" style="display:none;">
                <div class="sn-admin-modal-card" style="max-width:860px;">
                  <div class="sn-admin-modal-header">
                    <div>
                      <span style="font-family:var(--sn-font-mono);font-size:0.73rem;color:var(--sn-accent-turmeric);letter-spacing:0.05em;">RBAC: SUPER_ADMIN &amp; ORDER_MANAGER • RUST WASM GST + 4-ZONE SHIPPING ENGINE</span>
                      <h3 id="sn-create-order-modal-heading" style="font-family:var(--sn-font-serif);margin:2px 0 0;font-size:1.25rem;color:#FAF5E4;">Create Manual Order &amp; Auto-Generate GST Tax Invoice</h3>
                    </div>
                    <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-close-create-order-modal>✕ Close</button>
                  </div>

                  <div class="sn-admin-modal-body">
                    <!-- Instant Post-Creation Banner with 1-Click GST Tax Invoice Link -->
                    <div id="sn-admin-create-order-result" class="sn-card" style="display:none;background-color:var(--sn-status-paid-bg);border:2px solid var(--sn-bg-forest);padding:14px 16px;margin-bottom:16px;">
                      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
                        <div>
                          <div style="font-family:var(--sn-font-mono);font-size:0.74rem;font-weight:700;color:var(--sn-bg-forest);text-transform:uppercase;">✓ Order Created &amp; GST Tax Invoice Generated</div>
                          <div id="sn-admin-created-order-summary" style="font-size:0.92rem;font-weight:700;color:var(--sn-text-primary);margin-top:2px;">Order SN-2026-1003 confirmed.</div>
                        </div>
                        <div style="display:flex;gap:8px;flex-wrap:wrap;">
                          <a id="sn-admin-created-invoice-link" href="${basePath}/orders/SN-2026-1001/invoice" target="_blank" rel="noopener" class="sn-btn sn-btn-forest sn-btn-sm">🧾 Open &amp; Print GST Invoice &rarr;</a>
                          <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-admin-created-reload-btn">↻ Refresh Orders List</button>
                        </div>
                      </div>
                    </div>

                    <form id="sn-admin-create-order-form">
                      <!-- 1. Optional Existing Customer Quick-Fill -->
                      <div class="sn-card" style="background-color:var(--sn-bg-mortar);padding:10px 14px;margin-bottom:14px;">
                        <label for="sn-admin-order-customer-preset" style="font-size:0.75rem;font-weight:700;color:var(--sn-bg-forest);display:block;margin-bottom:4px;">⚡ Quick-Fill from Existing Customer / Saved Address (Optional)</label>
                        <select id="sn-admin-order-customer-preset" class="sn-select">
                          <option value="">— Enter New / Custom Customer Below —</option>
                          ${customerQuickFillPresets.map(cp => `
                            <option
                              value="${escapeHtml(cp.customerEmail)}"
                              data-user-id="${escapeHtml(String(cp.userId || ''))}"
                              data-name="${escapeHtml(cp.customerName)}"
                              data-email="${escapeHtml(cp.customerEmail)}"
                              data-phone="${escapeHtml(cp.customerPhone)}"
                              data-line1="${escapeHtml(cp.shippingLine1)}"
                              data-line2="${escapeHtml(cp.shippingLine2)}"
                              data-city="${escapeHtml(cp.shippingCity)}"
                              data-state="${escapeHtml(cp.shippingState)}"
                              data-pincode="${escapeHtml(cp.shippingPincode)}"
                            >${escapeHtml(cp.customerName)} (${escapeHtml(cp.customerEmail)} • ${escapeHtml(cp.customerPhone)} — ${escapeHtml(cp.shippingCity)}, ${escapeHtml(cp.shippingState)} - ${escapeHtml(cp.shippingPincode)})</option>
                          `).join('')}
                        </select>
                      </div>

                      <!-- 2. Customer Contact & Delivery Address (Place of Supply for CGST+SGST vs IGST) -->
                      <div style="font-family:var(--sn-font-serif);font-weight:700;font-size:0.98rem;color:var(--sn-bg-forest);margin-bottom:8px;">
                        1. Customer Contact &amp; Delivery Address (Determines GST Place of Supply &amp; 4-Zone Slab)
                      </div>
                      <input type="hidden" name="userId" id="sn-admin-ord-user-id" value="" />
                      <div class="sn-grid-3" style="gap:10px;margin-bottom:10px;">
                        <div>
                          <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Customer Full Name *</label>
                          <input type="text" name="customerName" id="sn-admin-ord-name" required placeholder="e.g. Meera Deshmukh" class="sn-input" />
                        </div>
                        <div>
                          <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Customer Email *</label>
                          <input type="email" name="customerEmail" id="sn-admin-ord-email" required placeholder="meera@example.in" class="sn-input" />
                        </div>
                        <div>
                          <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">10-Digit Mobile Phone *</label>
                          <input type="tel" name="customerPhone" id="sn-admin-ord-phone" required placeholder="9845012345" class="sn-input" />
                        </div>
                      </div>

                      <div class="sn-grid-2" style="gap:10px;margin-bottom:10px;">
                        <div>
                          <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Street Address (Line 1) *</label>
                          <input type="text" name="shippingLine1" id="sn-admin-ord-line1" required placeholder="House / Flat No., Building, Street" class="sn-input" />
                        </div>
                        <div>
                          <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Landmark / Area (Line 2)</label>
                          <input type="text" name="shippingLine2" id="sn-admin-ord-line2" placeholder="Optional Landmark or Locality" class="sn-input" />
                        </div>
                      </div>

                      <div class="sn-grid-4" style="gap:10px;margin-bottom:14px;">
                        <div>
                          <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">City *</label>
                          <input type="text" name="shippingCity" id="sn-admin-ord-city" required value="Bengaluru" class="sn-input" />
                        </div>
                        <div>
                          <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">State (GST Supply) *</label>
                          <input type="text" name="shippingState" id="sn-admin-ord-state" required value="Karnataka" class="sn-input" />
                        </div>
                        <div>
                          <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">6-Digit PIN Code *</label>
                          <input type="text" name="shippingPincode" id="sn-admin-ord-pincode" required pattern="\\d{6}" value="560038" class="sn-input" style="font-family:var(--sn-font-mono);" />
                        </div>
                        <div>
                          <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Delivery Notes</label>
                          <input type="text" name="deliveryInstructions" id="sn-admin-ord-notes" placeholder="Optional note" class="sn-input" />
                        </div>
                      </div>

                      <!-- 3. Multi-Item Pack Variant Builder -->
                      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
                        <div style="font-family:var(--sn-font-serif);font-weight:700;font-size:0.98rem;color:var(--sn-bg-forest);">
                          2. Ordered Product Packs &amp; Quantities
                        </div>
                        <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-admin-add-order-item-btn">+ Add Another Product Pack</button>
                      </div>

                      <template id="sn-admin-order-variant-options-tpl">${activeVariantsForOrderOptionsHtml}</template>

                      <div id="sn-admin-order-items-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">
                        <div class="sn-admin-order-item-row" style="display:grid;grid-template-columns:1fr 95px 115px 40px;gap:8px;align-items:center;">
                          <select class="sn-select sn-admin-order-variant-select" required aria-label="Product Pack Variant">
                            ${activeVariantsForOrderOptionsHtml}
                          </select>
                          <input type="number" class="sn-input sn-admin-order-qty-input" value="1" min="1" max="50" required aria-label="Pack Quantity" style="text-align:center;font-family:var(--sn-font-mono);" />
                          <span class="sn-admin-order-row-subtotal" style="font-family:var(--sn-font-mono);font-size:0.84rem;font-weight:700;color:var(--sn-bg-forest);text-align:right;">₹0.00</span>
                          <button type="button" class="sn-btn sn-btn-outline sn-btn-sm sn-admin-remove-order-item-btn" title="Remove Line Item" style="padding:0 8px;">✕</button>
                        </div>
                      </div>

                      <!-- 4. Payment Mode, Initial Payment Status, UTR Reference & Coupon -->
                      <div style="font-family:var(--sn-font-serif);font-weight:700;font-size:0.98rem;color:var(--sn-bg-forest);margin-bottom:8px;">
                        3. Payment Mode, Settlement Status &amp; Promotional Coupon
                      </div>
                      <div class="sn-grid-4" style="gap:10px;margin-bottom:14px;">
                        <div>
                          <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Payment Method *</label>
                          <select name="paymentMethod" id="sn-admin-ord-payment-method" class="sn-select">
                            <option value="ONLINE_UPI" selected>UPI / QR / Bank Transfer</option>
                            <option value="ONLINE_CARD">Credit / Debit Card</option>
                            <option value="ONLINE_NETBANKING">Net Banking / NEFT</option>
                            <option value="COD">Cash on Delivery (COD)</option>
                          </select>
                        </div>
                        <div>
                          <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Initial Payment Status *</label>
                          <select name="paymentStatus" id="sn-admin-ord-payment-status" class="sn-select">
                            <option value="PAID" selected>PAID (Verified • Deduct Stock)</option>
                            <option value="COD_PENDING">COD_PENDING (Collect on Delivery)</option>
                            <option value="COD_COLLECTED">COD_COLLECTED (Cash Received)</option>
                            <option value="PENDING_PAYMENT">PENDING_PAYMENT (Hold Stock)</option>
                          </select>
                        </div>
                        <div>
                          <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">UPI UTR / Payment Ref</label>
                          <input type="text" name="gatewayPaymentId" id="sn-admin-ord-utr" placeholder="Optional UTR / Ref ID" class="sn-input" style="font-family:var(--sn-font-mono);" />
                        </div>
                        <div>
                          <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Coupon Code</label>
                          <input type="text" name="couponCode" id="sn-admin-ord-coupon" placeholder="e.g. SASHYA10" class="sn-input" style="font-family:var(--sn-font-mono);" />
                        </div>
                      </div>

                      <!-- 5. Live Rust WASM GST & 4-Zone Shipping Invoice Preview -->
                      <div id="sn-admin-order-live-preview" class="sn-card" style="background-color:var(--sn-bg-parchment);padding:12px 14px;margin-bottom:16px;font-family:var(--sn-font-mono);font-size:0.8rem;">
                        Calculating live GST breakdown &amp; 4-Zone 500g slab shipping...
                      </div>

                      <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;">
                        <button type="button" class="sn-btn sn-btn-outline" data-close-create-order-modal>Cancel</button>
                        <button type="submit" class="sn-btn sn-btn-forest" id="sn-admin-create-order-submit-btn">🧾 Create Order &amp; Generate GST Invoice</button>
                      </div>
                    </form>
                  </div>
                </div>
              </div>
            </div>

            <!-- Panel 2: Write-Only API & Razorpay Credential Vault + Production Go-Live Guardrail -->
            <div class="sn-card" data-admin-panel="vault" style="display:none;">
              ${(() => {
                const lr = evaluateLaunchReadiness();
                return `
                  <div class="sn-card" id="sn-launch-readiness-guardrail-card" style="background-color:${lr.isReady ? 'var(--sn-status-paid-bg)' : 'var(--sn-status-warn-bg)'};border-left:4px solid ${lr.isReady ? 'var(--sn-status-paid)' : 'var(--sn-status-warn)'};padding:14px 18px;margin-bottom:18px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:8px;">
                      <div>
                        <span class="sn-eyebrow" style="margin:0;">Fail-Closed Production Go-Live Guardrail</span>
                        <h3 style="font-family:var(--sn-font-serif);margin:2px 0 0;font-size:1.1rem;color:var(--sn-bg-forest);">
                          ${lr.isReady
                            ? '✓ Live Launch Unlocked: Payment Gateway &amp; Email Verification Active'
                            : '🔒 Live Launch Blocked: Public Domain (sashyanaturals.com) Locked to "Launching Soon"'
                          }
                        </h3>
                      </div>
                      <span class="sn-status ${lr.isReady ? 'sn-status-paid' : 'sn-status-warn'}">
                        ${lr.isReady ? 'READY FOR LIVE TRAFFIC' : `${lr.blockers.length} LAUNCH BLOCKERS ACTIVE`}
                      </span>
                    </div>
                    <div class="sn-grid-3" style="gap:8px;font-family:var(--sn-font-mono);font-size:0.75rem;">
                      <div>${lr.checks.razorpayLiveKeyId && lr.checks.razorpayLiveSecret && lr.checks.razorpayWebhookSecret ? '✓' : '✕'} <strong>Razorpay Live Keys (rzp_live_*)</strong></div>
                      <div>${lr.checks.smtpApiKeySealed && lr.checks.emailVerificationConfirmed ? '✓' : '✕'} <strong>Live Email Notification &amp; OTP Verification</strong></div>
                      <div>${lr.checks.stagingSampleCategoriesPurged ? '✓' : '✕'} <strong>Staging Sample Categories Purged</strong></div>
                    </div>
                  </div>
                `;
              })()}
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

                    <form class="sn-admin-vault-form" data-vault-form="${escapeHtml(v.key_name)}" style="display:${v.is_configured ? 'none' : 'flex'};gap:10px;margin-top:12px;align-items:center;flex-wrap:wrap;">
                      <input type="hidden" name="keyName" value="${escapeHtml(v.key_name)}" />
                      <input type="password" name="secretValue" required minlength="6" placeholder="Paste live ${escapeHtml(v.key_name)} here (will be encrypted &amp; hidden immediately)" class="sn-input" style="font-family:var(--sn-font-mono);flex:1;min-width:220px;" />
                      <button type="submit" class="sn-btn sn-btn-primary sn-btn-sm" style="white-space:nowrap;">Seal &amp; Hide Key</button>
                    </form>
                  </div>
                `).join('')}
              </div>
            </div>

            <!-- Panel 3: Categories, Products, Contextual Edit Modal & Media Manager -->
            <div class="sn-card" data-admin-panel="products" style="${panelDisplayStyle('products')}">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:14px;">
                <div>
                  <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Categories, Products, Pack Variants &amp; Media Manager</h2>
                  <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0;">
                    Authorized for <strong>SUPER_ADMIN</strong> and <strong>PRODUCT_MANAGER</strong>. Click <strong>+ Add New Product</strong> or <strong>✏️ Edit</strong> on any product row to open the full 4-Tab Product Editor (Core Info &amp; Flags, 4-Pack Pricing/Discounts/Stock, FSSAI Nutrition, and Delivery PIN Rules).
                  </p>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                  <button type="button" class="sn-btn sn-btn-primary sn-btn-sm" data-open-create-prod-modal="true" data-force-subtab="products:catalogue">+ Add New Product</button>
                  <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-toggle-admin-form="sn-admin-create-category-form" data-force-subtab="products:categories" data-toggle-open-text="− Hide Category Form" data-toggle-closed-text="+ New Category">+ New Category</button>
                </div>
              </div>

              <!-- In-Panel Segmented Sub-Module Bar (Synced with Desktop Sidebar Accordion) -->
              <div class="sn-admin-subnav-bar" role="tablist">
                <button type="button" class="sn-admin-subtab-pill sn-active" data-admin-subtab-btn="products:catalogue">📦 3.1 Products Catalogue (${products.length} Products • ${variants.length} Variants)</button>
                <button type="button" class="sn-admin-subtab-pill" data-admin-subtab-btn="products:categories">🗂️ 3.2 Categories &amp; Banner Photos (${categories.length})</button>
              </div>

              <!-- Sub-Panel 3.1 (Default): Products Catalogue -->
              <div data-admin-subpanel="products:catalogue">
                <!-- Product Catalogue Filter, Search & Pagination Toolbar -->
                <div class="sn-card" id="sn-admin-products-filter-bar" style="background-color:var(--sn-bg-parchment);padding:12px 14px;margin-bottom:14px;">
                  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
                    <strong style="font-family:var(--sn-font-serif);font-size:1.05rem;color:var(--sn-bg-forest);">Storefront Product Catalogue (${products.length} Products • ${variants.length} Pack Variants)</strong>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                      <span id="sn-admin-prod-count-badge" class="sn-status sn-status-paid" style="font-family:var(--sn-font-mono);">Showing ${products.length} of ${products.length} Products</span>
                      <button type="button" class="sn-btn sn-btn-primary sn-btn-sm" data-open-create-prod-modal="true" data-force-subtab="products:catalogue">+ Add New Product</button>
                    </div>
                  </div>
                  <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
                    <input type="search" id="sn-admin-prod-search" placeholder="Search Product Name, SKU (SN-DF/ML/SP), HSN, or Region..." class="sn-input" style="flex:1;min-width:185px;" />
                    <select id="sn-admin-prod-cat-filter" class="sn-select" style="width:auto;min-width:150px;">
                      <option value="all">Category: All (${categories.length})</option>
                      ${categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
                    </select>
                    <select id="sn-admin-prod-flag-filter" class="sn-select" style="width:auto;min-width:150px;">
                      <option value="all">Filter: All Statuses</option>
                      <option value="active">Published (Active)</option>
                      <option value="inactive">Deactivated</option>
                      <option value="bestseller">★ Bestsellers</option>
                      <option value="featured">Featured</option>
                      <option value="new">New Harvests</option>
                      <option value="pin_restricted">📍 PIN Restricted</option>
                    </select>
                  </div>
                </div>

                <div class="sn-table-wrap" id="sn-admin-products-catalogue-table">
                  <table class="sn-table sn-table-cards" id="sn-admin-products-table">
                    <thead>
                      <tr><th>Photo</th><th>SKU, HSN &amp; Flags</th><th>Product Name &amp; Origin</th><th>Pack Variants (100g / 250g / 500g / 1kg)</th><th>Status &amp; Quick Edit</th><th>Quick Change Photo ${renderImageSpecTooltip('product')}</th></tr>
                    </thead>
                    <tbody>
                      ${products.map(p => {
                        const pVars = variants.filter(v => v.product_id === p.id).sort((a, b) => a.weight_grams - b.weight_grams);
                        const v100 = pVars.find(v => Number(v.weight_grams) === 100) || pVars[0] || { selling_price_paise: 14000, mrp_paise: 17000 };
                        const base100SellInr = Math.round(Number(v100.selling_price_paise || 14000) / 100);
                        const base100MrpInr = Math.round(Number(v100.mrp_paise || 17000) / 100);
                        const nut = parseProductNutrition(p);
                        const pinRules = parseProductPincodeRules(p);
                        const pinSummary = summarizePincodeRules(pinRules);
                        const variantsDataJson = JSON.stringify(pVars.map(v => ({
                          id: v.id,
                          sku: v.sku,
                          packLabel: v.pack_label,
                          weightGrams: v.weight_grams,
                          mrpInr: Math.round(v.mrp_paise / 100),
                          sellInr: Math.round(v.selling_price_paise / 100),
                          stockQty: v.stock_qty
                        })));
                        return `
                          <tr
                            data-admin-prod-row="${p.id}"
                            data-prod-id="${p.id}"
                            data-prod-sku="${escapeHtml(p.sku_base)}"
                            data-prod-name="${escapeHtml(p.name)}"
                            data-prod-cat-id="${p.category_id}"
                            data-prod-100g-sell="${base100SellInr}"
                            data-prod-100g-mrp="${base100MrpInr}"
                            data-prod-gst="${p.gst_percent}"
                            data-prod-hsn="${escapeHtml(p.hsn_code || '080290')}"
                            data-prod-origin="${escapeHtml(p.origin_region || '')}"
                            data-prod-batch="${escapeHtml(p.harvest_batch || 'SN-BATCH-2611')}"
                            data-prod-shelf-life="${Number(p.shelf_life_months || 9)}"
                            data-prod-desc="${escapeHtml(p.short_description || '')}"
                            data-prod-full-desc="${escapeHtml(p.description || p.short_description || '')}"
                            data-prod-ingredients="${escapeHtml(p.ingredients || '')}"
                            data-prod-allergen="${escapeHtml(p.allergen_info || '')}"
                            data-prod-fssai="${escapeHtml(p.fssai_notes || '')}"
                            data-prod-variants-json="${escapeHtml(variantsDataJson)}"
                            data-prod-nutrition-json="${escapeHtml(JSON.stringify(nut))}"
                            data-prod-pincode-json="${escapeHtml(JSON.stringify(pinRules))}"
                            data-prod-pin-restricted="${pinSummary.hasRestriction ? '1' : '0'}"
                            data-prod-img="${basePath}${escapeHtml(p.image_url)}"
                            data-prod-active="${p.is_active ? '1' : '0'}"
                            data-prod-bestseller="${p.is_bestseller ? '1' : '0'}"
                            data-prod-featured="${p.is_featured ? '1' : '0'}"
                            data-prod-new="${p.is_new_arrival ? '1' : '0'}"
                            data-prod-rating="${Number(p.rating_value || 4.8).toFixed(1)}"
                            data-prod-reviews="${Number(p.review_count || 24)}"
                          >
                            <td data-label="Photo">
                              <img src="${basePath}${escapeHtml(p.image_url)}" alt="${escapeHtml(p.name)}" data-product-img-id="${p.id}" style="width:52px;height:52px;object-fit:cover;border-radius:6px;border:1px solid var(--sn-border-strong);" />
                            </td>
                            <td data-label="SKU, HSN &amp; Flags" style="font-family:var(--sn-font-mono);font-size:0.75rem;">
                              <div>
                                <strong>${escapeHtml(p.sku_base)}</strong> • HSN: ${escapeHtml(p.hsn_code || '080290')} (${p.gst_percent}% GST)<br/>
                                ${p.is_featured ? '<span class="sn-status sn-status-paid" style="font-size:0.65rem;padding:1px 5px;">Featured</span> ' : ''}
                                ${p.is_bestseller ? '<span class="sn-status sn-status-warn" style="font-size:0.65rem;padding:1px 5px;">Bestseller</span> ' : ''}
                                ${p.is_new_arrival ? '<span class="sn-status sn-status-paid" style="font-size:0.65rem;padding:1px 5px;">New</span>' : ''}
                              </div>
                            </td>
                            <td data-label="Product &amp; Origin">
                              <div>
                                <strong><a href="${basePath}/product/${escapeHtml(p.slug)}" data-prod-name-display="${p.id}">${escapeHtml(p.name)}</a></strong><br/>
                                <span class="sn-status sn-status-paid" data-prod-cat-badge="${p.id}" style="font-size:0.65rem;padding:1px 6px;margin-top:2px;">${escapeHtml((categories.find(c => Number(c.id) === Number(p.category_id)) || { name: 'Category' }).name)}</span>
                                <span data-prod-origin-display="${p.id}" style="font-size:0.75rem;color:var(--sn-text-muted);">${escapeHtml(p.origin_region)} • ${escapeHtml(p.harvest_batch)}</span>
                                <div data-prod-nut-summary="${p.id}" style="font-family:var(--sn-font-mono);font-size:0.69rem;color:var(--sn-bg-forest);margin-top:2px;">
                                  🥗 ${nut.energy_kcal} kcal • ${nut.protein_g}g Prot • ${escapeHtml(nut.bioactive_value)}
                                </div>
                                <div data-prod-pin-summary="${p.id}" style="font-family:var(--sn-font-mono);font-size:0.69rem;color:${pinSummary.hasRestriction ? 'var(--sn-accent-terracotta)' : 'var(--sn-text-muted)'};font-weight:${pinSummary.hasRestriction ? '700' : '400'};margin-top:2px;">
                                  ${pinSummary.hasRestriction ? escapeHtml(pinSummary.shortBadge) : '📍 All Serviceable India PINs'}
                                </div>
                              </div>
                            </td>
                            <td data-label="Pack Variants" style="font-family:var(--sn-font-mono);font-size:0.72rem;">
                              <span data-prod-variants-cell="${p.id}">${pVars.map(v => {
                                const pct = v.mrp_paise > v.selling_price_paise
                                  ? Math.round(((v.mrp_paise - v.selling_price_paise) / v.mrp_paise) * 100)
                                  : 0;
                                return `${escapeHtml(v.pack_label)}: <strong>${formatInr(v.selling_price_paise)}</strong>${pct > 0 ? ` <span style="color:var(--sn-status-paid);">(-${pct}%)</span>` : ''} (${v.stock_qty})`;
                              }).join(' | ')}</span>
                            </td>
                            <td data-label="Status &amp; Edit">
                              <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
                                <button
                                  type="button"
                                  class="sn-btn ${p.is_active ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm"
                                  data-toggle-prod-id="${p.id}"
                                  data-toggle-prod-active="${p.is_active ? '1' : '0'}"
                                >${p.is_active ? 'Active' : 'Inactive'}</button>
                                <button
                                  type="button"
                                  class="sn-btn sn-btn-outline sn-btn-sm"
                                  data-load-prod-editor="${p.id}"
                                  data-open-modal-tab="core"
                                >✏️ Edit</button>
                                <button
                                  type="button"
                                  class="sn-btn sn-btn-outline sn-btn-sm"
                                  data-load-prod-editor="${p.id}"
                                  data-open-modal-tab="pricing"
                                  title="Edit Per-Weight Pack Discounts &amp; Prices"
                                >⚖️ Discounts</button>
                                <button
                                  type="button"
                                  class="sn-btn sn-btn-outline sn-btn-sm"
                                  data-load-prod-editor="${p.id}"
                                  data-open-modal-tab="nutrition"
                                  title="Edit FSSAI Per-100g Nutritional Value &amp; Labelling"
                                >🥗 Nutrition</button>
                                <button
                                  type="button"
                                  class="sn-btn sn-btn-outline sn-btn-sm"
                                  data-load-prod-editor="${p.id}"
                                  data-open-modal-tab="pincode"
                                  title="Configure Per-Product Delivery PIN &amp; Zone Restrictions"
                                >📍 PIN Rules</button>
                              </div>
                            </td>
                            <td data-label="Quick Change Photo">
                              <form class="sn-admin-inline-prod-img-form sn-admin-file-action-group" title="${escapeHtml(IMAGE_UPLOAD_SPECS.product.summary)}">
                                <input type="hidden" name="productId" value="${p.id}" />
                                <input type="file" name="imageFile" accept="image/jpeg,image/png,image/webp" required title="${escapeHtml(IMAGE_UPLOAD_SPECS.product.summary)}" class="sn-input sn-file-input sn-file-input-sm" />
                                <button type="submit" class="sn-btn sn-btn-outline sn-btn-sm">Change</button>
                                ${renderImageSpecTooltip('product')}
                              </form>
                            </td>
                          </tr>
                        `;
                      }).join('')}
                    </tbody>
                  </table>
                </div>
                <div id="sn-admin-products-pagination" class="sn-admin-pagination-bar"></div>
              </div>

              <!-- Sub-Panel 3.2: Product Categories & Category Banner Photos -->
              <div data-admin-subpanel="products:categories" style="display:none;">
                <div class="sn-card" style="background-color:var(--sn-bg-parchment);">
                  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px;">
                    <div>
                      <h3 style="font-family:var(--sn-font-serif);margin:0;font-size:1.08rem;color:var(--sn-bg-forest);">Product Categories &amp; Category Banner Photos (${categories.length})</h3>
                      <span style="font-size:0.78rem;color:var(--sn-text-secondary);">Click <strong>✏️ Edit</strong> on any category row to edit its name, subtitle, description, status, or banner image.</span>
                    </div>
                    <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-toggle-admin-form="sn-admin-create-category-form" data-force-subtab="products:categories" data-toggle-open-text="− Hide Category Form" data-toggle-closed-text="+ New Category">+ New Category</button>
                  </div>

                  <form id="sn-admin-create-category-form" class="sn-admin-collapsible-all" style="margin-bottom:18px;padding:14px;background-color:var(--sn-bg-surface);border:1px solid var(--sn-border-warm);border-radius:var(--sn-radius-sm);">
                    <div style="font-family:var(--sn-font-serif);font-weight:700;font-size:0.95rem;color:var(--sn-bg-forest);margin-bottom:10px;">Create New Storefront Category</div>
                    <div class="sn-grid-3" style="gap:12px;margin-bottom:12px;">
                      <div>
                        <label style="font-size:0.75rem;font-weight:600;">Category Name *</label>
                        <input type="text" name="name" required placeholder="e.g. Cold-Pressed Oils &amp; Ghee" class="sn-input" />
                      </div>
                      <div>
                        <label style="font-size:0.75rem;font-weight:600;">Subtitle / Eyebrow *</label>
                        <input type="text" name="subtitle" required placeholder="e.g. Wood-Pressed Wooden Ghani Oils &amp; A2 Ghee" class="sn-input" />
                      </div>
                      <div>
                        <label style="font-size:0.75rem;font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px;"><span>Category Banner Image (JPEG/PNG/WebP)</span> ${renderImageSpecTooltip('category')}</label>
                        <input type="file" name="categoryImageFile" accept="image/jpeg,image/png,image/webp" title="${escapeHtml(IMAGE_UPLOAD_SPECS.category.summary)}" class="sn-input sn-file-input" />
                      </div>
                    </div>
                    <div class="sn-form-row-1-action" style="gap:12px;">
                      <div>
                        <label style="font-size:0.75rem;font-weight:600;">Category Description (Humanizer-Checked) *</label>
                        <input type="text" name="description" required placeholder="e.g. Traditional wood-pressed groundnut, sesame, and coconut oils extracted at room temperature." class="sn-input" />
                      </div>
                      <button type="submit" class="sn-btn sn-btn-primary">Create Category</button>
                    </div>
                  </form>

                  <div class="sn-table-wrap">
                    <table class="sn-table sn-table-cards" id="sn-admin-categories-table">
                      <thead>
                        <tr><th>Photo</th><th>Category Name &amp; Slug</th><th>Subtitle &amp; Description</th><th>Status &amp; Edit</th><th>Change Category Image ${renderImageSpecTooltip('category')}</th></tr>
                      </thead>
                      <tbody>
                        ${categories.map(c => `
                          <tr
                            data-admin-cat-row="${c.id}"
                            data-cat-id="${c.id}"
                            data-cat-slug="${escapeHtml(c.slug)}"
                            data-cat-name="${escapeHtml(c.name)}"
                            data-cat-subtitle="${escapeHtml(c.subtitle || '')}"
                            data-cat-desc="${escapeHtml(c.description || '')}"
                            data-cat-img="${basePath}${escapeHtml(c.image_url)}"
                            data-cat-active="${c.is_active ? '1' : '0'}"
                          >
                            <td data-label="Photo">
                              <img src="${basePath}${escapeHtml(c.image_url)}" alt="${escapeHtml(c.name)}" data-category-img-id="${c.id}" style="width:68px;height:48px;object-fit:cover;border-radius:6px;border:1px solid var(--sn-border-strong);" />
                            </td>
                            <td data-label="Category &amp; Slug">
                              <div>
                                <strong><a href="${basePath}/category/${escapeHtml(c.slug)}" data-cat-name-display="${c.id}">${escapeHtml(c.name)}</a></strong><br/>
                                <span style="font-family:var(--sn-font-mono);font-size:0.73rem;color:var(--sn-text-muted);">/category/${escapeHtml(c.slug)}</span>
                              </div>
                            </td>
                            <td data-label="Subtitle &amp; Description" style="font-size:0.81rem;">
                              <div>
                                <strong data-cat-subtitle-display="${c.id}" style="color:var(--sn-bg-forest);">${escapeHtml(c.subtitle)}</strong><br/>
                                <span data-cat-desc-display="${c.id}" style="font-size:0.75rem;color:var(--sn-text-secondary);">${escapeHtml(c.description || '')}</span>
                              </div>
                            </td>
                            <td data-label="Status &amp; Edit">
                              <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
                                <button
                                  type="button"
                                  class="sn-btn ${c.is_active ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm"
                                  data-toggle-cat-id="${c.id}"
                                  data-toggle-cat-active="${c.is_active ? '1' : '0'}"
                                >${c.is_active ? 'Active' : 'Deactivated'}</button>
                                <button
                                  type="button"
                                  class="sn-btn sn-btn-outline sn-btn-sm"
                                  data-load-cat-editor="${c.id}"
                                >✏️ Edit</button>
                              </div>
                            </td>
                            <td data-label="Update Banner Photo">
                              <form class="sn-admin-cat-img-form sn-admin-file-action-group" title="${escapeHtml(IMAGE_UPLOAD_SPECS.category.summary)}">
                                <input type="hidden" name="categoryId" value="${c.id}" />
                                <input type="file" name="imageFile" accept="image/jpeg,image/png,image/webp" required title="${escapeHtml(IMAGE_UPLOAD_SPECS.category.summary)}" class="sn-input sn-file-input sn-file-input-sm" />
                                <button type="submit" class="sn-btn sn-btn-forest sn-btn-sm">Update Photo</button>
                                ${renderImageSpecTooltip('category')}
                              </form>
                            </td>
                          </tr>
                        `).join('')}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              <!-- Contextual Product Edit, Per-Weight Discount Matrix, FSSAI Nutrition & Delivery PIN Rules Modal -->
              <div id="sn-admin-edit-product-modal" class="sn-admin-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="sn-edit-modal-heading" style="display:none;">
                <div class="sn-admin-modal-card">
                  <div class="sn-admin-modal-header">
                    <div style="display:flex;align-items:center;gap:12px;">
                      <img id="sn-edit-modal-thumb" src="${basePath}/images/cat-dry-fruits.jpg" alt="Product Preview" style="width:48px;height:48px;object-fit:cover;border-radius:6px;border:1px solid rgba(255,255,255,0.25);" />
                      <div>
                        <span id="sn-edit-modal-sku" style="font-family:var(--sn-font-mono);font-size:0.73rem;color:var(--sn-accent-turmeric);letter-spacing:0.05em;">SN-DF-ALM</span>
                        <h3 id="sn-edit-modal-heading" style="font-family:var(--sn-font-serif);margin:0;font-size:1.15rem;color:#FAF5E4;">Edit Product Details, Per-Weight Discounts &amp; FSSAI Nutrition</h3>
                      </div>
                    </div>
                    <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-close-prod-modal>✕ Close</button>
                  </div>

                  <div class="sn-admin-modal-body">
                    <!-- Isolated Modal Sub-Navigation Bar (Does not touch background Admin Module sessionStorage) -->
                    <div class="sn-admin-subnav-bar" role="tablist" aria-label="Product Editor Sections" style="margin-bottom:14px;">
                      <button type="button" class="sn-admin-subtab-pill sn-active" data-prod-modal-tab="core">🏷️ 1. Core Info, Flags &amp; Photos</button>
                      <button type="button" class="sn-admin-subtab-pill" data-prod-modal-tab="pricing">⚖️ 2. Pack-Weight Pricing, Discounts &amp; Stock</button>
                      <button type="button" class="sn-admin-subtab-pill" data-prod-modal-tab="nutrition">🥗 3. FSSAI Nutrition (Per 100g) &amp; Labelling</button>
                      <button type="button" class="sn-admin-subtab-pill" data-prod-modal-tab="pincode">📍 4. Delivery PIN &amp; Zone Rules</button>
                    </div>

                    <form id="sn-admin-edit-product-form" style="margin-bottom:14px;">
                      <input type="hidden" name="modalMode" id="sn-edit-prod-mode" value="edit" />
                      <input type="hidden" name="productId" id="sn-edit-prod-select" value="${products[0] ? products[0].id : 1}" />

                      <!-- Modal Pane 1: Core Product Info, SKU Prefix, Batch, Descriptions, Flags & Primary Photo -->
                      <div data-prod-modal-pane="core">
                        <div class="sn-grid-4" style="gap:12px;margin-bottom:12px;">
                          <div>
                            <label style="font-size:0.75rem;font-weight:700;display:block;margin-bottom:4px;">Product Title *</label>
                            <input type="text" name="name" id="sn-edit-prod-name" required placeholder="e.g. Guntur Cold-Milled Cumin Powder" class="sn-input" />
                          </div>
                          <div>
                            <label style="font-size:0.75rem;font-weight:700;display:block;margin-bottom:4px;">SKU Prefix *</label>
                            <input type="text" name="skuBase" id="sn-edit-prod-sku-input" required placeholder="e.g. SN-SP-CMN" class="sn-input" style="font-family:var(--sn-font-mono);text-transform:uppercase;" />
                          </div>
                          <div>
                            <label style="font-size:0.75rem;font-weight:700;display:block;margin-bottom:4px;">Storefront Category *</label>
                            <select name="categoryId" id="sn-edit-prod-cat" class="sn-select">
                              ${categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
                            </select>
                          </div>
                          <div>
                            <label style="font-size:0.75rem;font-weight:700;display:block;margin-bottom:4px;">Growing Region / Origin *</label>
                            <input type="text" name="originRegion" id="sn-edit-prod-origin" required placeholder="e.g. Unjha &amp; Guntur Belt" class="sn-input" />
                          </div>
                        </div>

                        <div class="sn-grid-4" style="gap:12px;margin-bottom:12px;">
                          <div>
                            <label style="font-size:0.75rem;font-weight:700;display:block;margin-bottom:4px;">GST Slab (%)</label>
                            <select name="gstPercent" id="sn-edit-prod-gst" class="sn-select">
                              <option value="0">0% GST (Exempt / Unbranded Primary Produce)</option>
                              <option value="5">5% GST (Natural Staples)</option>
                              <option value="12">12% GST (Processed / Blended)</option>
                              <option value="18">18% GST (Standard Processed)</option>
                              <option value="28">28% GST (Premium / Luxury Slab)</option>
                            </select>
                          </div>
                          <div>
                            <label style="font-size:0.75rem;font-weight:700;display:block;margin-bottom:4px;">HSN Code *</label>
                            <input type="text" name="hsnCode" id="sn-edit-prod-hsn" required class="sn-input" style="font-family:var(--sn-font-mono);" />
                          </div>
                          <div>
                            <label style="font-size:0.75rem;font-weight:700;display:block;margin-bottom:4px;">Harvest Batch Code *</label>
                            <input type="text" name="harvestBatch" id="sn-edit-prod-batch" required class="sn-input" style="font-family:var(--sn-font-mono);" />
                          </div>
                          <div>
                            <label style="font-size:0.75rem;font-weight:700;display:block;margin-bottom:4px;">Shelf Life (Months) *</label>
                            <input type="number" name="shelfLifeMonths" id="sn-edit-prod-shelf-life" min="1" max="36" required class="sn-input" />
                          </div>
                        </div>

                        <div style="margin-bottom:10px;">
                          <label style="font-size:0.75rem;font-weight:700;display:block;margin-bottom:4px;">Short Description (Card Summary • Humanizer-Checked) *</label>
                          <input type="text" name="shortDescription" id="sn-edit-prod-desc" required class="sn-input" />
                        </div>

                        <div style="margin-bottom:12px;">
                          <label style="font-size:0.75rem;font-weight:700;display:block;margin-bottom:4px;">Full Product Story &amp; Harvest Description (PDP Body) *</label>
                          <textarea name="description" id="sn-edit-prod-full-desc" rows="2" required class="sn-textarea"></textarea>
                        </div>

                        <div class="sn-grid-4" style="gap:12px;margin-bottom:12px;">
                          <div>
                            <label style="font-size:0.74rem;font-weight:600;display:block;margin-bottom:4px;">Storefront Status</label>
                            <select name="isActive" id="sn-edit-prod-active" class="sn-select">
                              <option value="1">Published (Active)</option>
                              <option value="0">Deactivated (Hidden)</option>
                            </select>
                          </div>
                          <div>
                            <label style="font-size:0.74rem;font-weight:600;display:block;margin-bottom:4px;">Featured Flag</label>
                            <select name="isFeatured" id="sn-edit-prod-featured" class="sn-select">
                              <option value="1">Featured: Yes</option>
                              <option value="0">Featured: No</option>
                            </select>
                          </div>
                          <div>
                            <label style="font-size:0.74rem;font-weight:600;display:block;margin-bottom:4px;">Bestseller Flag</label>
                            <select name="isBestseller" id="sn-edit-prod-bestseller" class="sn-select">
                              <option value="1">Bestseller: Yes</option>
                              <option value="0">Bestseller: No</option>
                            </select>
                          </div>
                          <div>
                            <label style="font-size:0.74rem;font-weight:600;display:block;margin-bottom:4px;">New Harvest Flag</label>
                            <select name="isNewArrival" id="sn-edit-prod-new" class="sn-select">
                              <option value="1">New Harvest: Yes</option>
                              <option value="0">New Harvest: No</option>
                            </select>
                          </div>
                        </div>

                        <div class="sn-grid-2" style="gap:12px;margin-bottom:12px;">
                          <div>
                            <label style="font-size:0.74rem;font-weight:600;display:block;margin-bottom:4px;">Verified Rating Score (1.0 – 5.0 ★) *</label>
                            <input type="number" name="ratingValue" id="sn-edit-prod-rating" step="0.1" min="1.0" max="5.0" value="4.8" required class="sn-input" style="font-family:var(--sn-font-mono);" />
                          </div>
                          <div>
                            <label style="font-size:0.74rem;font-weight:600;display:block;margin-bottom:4px;">Verified Review Count *</label>
                            <input type="number" name="reviewCount" id="sn-edit-prod-reviews" step="1" min="1" max="50000" value="24" required class="sn-input" style="font-family:var(--sn-font-mono);" />
                          </div>
                        </div>

                        <div class="sn-card" style="background-color:var(--sn-bg-parchment);padding:10px 14px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
                          <div>
                            <strong style="font-size:0.8rem;color:var(--sn-bg-forest);display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;"><span>🖼️ Primary Storefront Product Photo (JPEG / PNG / WebP)</span> ${renderImageSpecTooltip('product')}</strong>
                            <div style="font-size:0.73rem;color:var(--sn-text-secondary);">Select an image file here to set or replace the primary product photo when you click Save below (or leave blank to keep current / category default).</div>
                          </div>
                          <input type="file" name="productImageFile" id="sn-edit-prod-photo-file" accept="image/jpeg,image/png,image/webp" title="${escapeHtml(IMAGE_UPLOAD_SPECS.product.summary)}" class="sn-input sn-file-input sn-file-input-sm" style="max-width:280px;" />
                        </div>
                      </div>

                      <!-- Modal Pane 2: Per-Weight Variant Pricing, Discount & Stock Control Matrix (100g, 250g, 500g, 1kg) -->
                      <div data-prod-modal-pane="pricing" style="display:none;">
                        <div class="sn-card" style="background-color:var(--sn-bg-mortar);padding:10px 14px;margin-bottom:12px;">
                          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
                            <div style="font-size:0.76rem;color:var(--sn-text-secondary);">
                              <strong style="color:var(--sn-bg-forest);">Quick 100g Base Curve Generator:</strong> Set 100g base prices and click Auto-Scale, or customize each weight's MRP, discount %, selling price, and stock independently below.
                            </div>
                            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                              <div style="display:flex;align-items:center;gap:4px;">
                                <label for="sn-edit-prod-mrp" style="font-family:var(--sn-font-mono);font-size:0.72rem;font-weight:700;">100g MRP ₹</label>
                                <input type="number" name="base100gMrpInr" id="sn-edit-prod-mrp" min="10" required class="sn-input" style="width:82px;padding:5px 8px;min-height:32px;" />
                              </div>
                              <div style="display:flex;align-items:center;gap:4px;">
                                <label for="sn-edit-prod-sell" style="font-family:var(--sn-font-mono);font-size:0.72rem;font-weight:700;">100g Sell ₹</label>
                                <input type="number" name="base100gSellInr" id="sn-edit-prod-sell" min="10" required class="sn-input" style="width:82px;padding:5px 8px;min-height:32px;" />
                              </div>
                              <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-edit-prod-autoscale-btn" style="min-height:32px;padding:4px 10px;">⚡ Auto-Scale 4 Packs</button>
                            </div>
                          </div>
                        </div>

                        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;">
                          ${[
                            { weight: 100, label: '100 g Pack', multLabel: '1.00× Base' },
                            { weight: 250, label: '250 g Pack', multLabel: '2.35× Curve' },
                            { weight: 500, label: '500 g Pack', multLabel: '4.45× Curve' },
                            { weight: 1000, label: '1 kg Pack', multLabel: '8.50× Curve' }
                          ].map(pk => `
                            <div class="sn-admin-variant-price-row" data-variant-price-row="${pk.weight}">
                              <div>
                                <strong style="font-family:var(--sn-font-mono);font-size:0.84rem;color:var(--sn-bg-forest);">${pk.label}</strong>
                                <div id="sn-edit-var-sku-${pk.weight}" style="font-family:var(--sn-font-mono);font-size:0.7rem;color:var(--sn-text-muted);">${pk.multLabel}</div>
                              </div>
                              <div>
                                <label style="font-size:0.7rem;font-weight:700;display:block;margin-bottom:2px;">Printed MRP (₹) *</label>
                                <input type="number" name="variant_mrp_${pk.weight}" id="sn-edit-var-mrp-${pk.weight}" data-var-mrp-input="${pk.weight}" min="10" required class="sn-input" style="font-family:var(--sn-font-mono);padding:6px 8px;" />
                              </div>
                              <div>
                                <label style="font-size:0.7rem;font-weight:700;display:block;margin-bottom:2px;">Discount (%)</label>
                                <input type="number" id="sn-edit-var-disc-${pk.weight}" data-var-disc-input="${pk.weight}" min="0" max="85" step="0.1" class="sn-input" style="font-family:var(--sn-font-mono);padding:6px 8px;color:var(--sn-status-paid);font-weight:700;" />
                              </div>
                              <div>
                                <label style="font-size:0.7rem;font-weight:700;display:block;margin-bottom:2px;">Selling Price (₹) *</label>
                                <input type="number" name="variant_sell_${pk.weight}" id="sn-edit-var-sell-${pk.weight}" data-var-sell-input="${pk.weight}" min="10" required class="sn-input" style="font-family:var(--sn-font-mono);padding:6px 8px;font-weight:700;" />
                              </div>
                              <div>
                                <label style="font-size:0.7rem;font-weight:700;display:block;margin-bottom:2px;">Stock (Units) *</label>
                                <input type="number" name="variant_stock_${pk.weight}" id="sn-edit-var-stock-${pk.weight}" data-var-stock-input="${pk.weight}" min="0" required value="40" class="sn-input" style="font-family:var(--sn-font-mono);padding:6px 8px;" />
                              </div>
                              <div id="sn-edit-var-rate-${pk.weight}" style="font-family:var(--sn-font-mono);font-size:0.72rem;text-align:right;">
                                <span class="sn-status sn-status-paid">₹320 / 100g</span>
                              </div>
                            </div>
                          `).join('')}
                        </div>

                        <div id="sn-edit-prod-pack-preview" style="padding:8px 12px;margin-bottom:12px;background-color:var(--sn-bg-parchment);border:1px solid var(--sn-border-warm);border-radius:var(--sn-radius-sm);font-family:var(--sn-font-mono);font-size:0.74rem;color:var(--sn-bg-forest);">
                          Per-Weight Pricing Summary: 100 g • 250 g • 500 g • 1 kg
                        </div>
                      </div>

                      <!-- Modal Pane 3: FSSAI Nutrition (Per 100 g) & Mandatory Food Labelling -->
                      <div data-prod-modal-pane="nutrition" style="display:none;">
                        <div class="sn-grid-3" style="gap:10px;margin-bottom:12px;">
                          <div>
                            <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Ingredients Declaration *</label>
                            <input type="text" name="ingredients" id="sn-edit-prod-ingredients" required class="sn-input" />
                          </div>
                          <div>
                            <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Allergen Declaration *</label>
                            <input type="text" name="allergenInfo" id="sn-edit-prod-allergen" required class="sn-input" />
                          </div>
                          <div>
                            <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">FSSAI Safety &amp; Storage Notes *</label>
                            <input type="text" name="fssaiNotes" id="sn-edit-prod-fssai" required class="sn-input" />
                          </div>
                        </div>

                        <div class="sn-card" style="background-color:var(--sn-bg-parchment);padding:12px 14px;margin-bottom:12px;">
                          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
                            <div>
                              <strong style="font-family:var(--sn-font-serif);font-size:0.95rem;color:var(--sn-bg-forest);">🥗 FSSAI Per-100g Nutritional Profile (IFCT 2017 / NABL Lab Reference)</strong>
                              <div style="font-family:var(--sn-font-mono);font-size:0.7rem;color:var(--sn-text-muted);">Synced to PDP Table, JSON-LD &amp; Markdown Twin</div>
                            </div>
                            <div style="display:flex;gap:6px;flex-wrap:wrap;">
                              <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-apply-nut-preset="1" style="padding:3px 8px;font-size:0.7rem;">🥜 Dry Fruits IFCT Preset</button>
                              <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-apply-nut-preset="2" style="padding:3px 8px;font-size:0.7rem;">🌾 Millets IFCT Preset</button>
                              <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-apply-nut-preset="3" style="padding:3px 8px;font-size:0.7rem;">🌶️ Spices IFCT Preset</button>
                            </div>
                          </div>

                          <div class="sn-admin-variant-price-grid" style="margin-bottom:10px;">
                            <div>
                              <label style="font-size:0.71rem;font-weight:700;display:block;margin-bottom:2px;">Energy (kcal / 100g) *</label>
                              <input type="number" name="energy_kcal" id="sn-edit-nut-kcal" step="0.1" min="0" required class="sn-input" style="font-family:var(--sn-font-mono);" />
                            </div>
                            <div>
                              <label style="font-size:0.71rem;font-weight:700;display:block;margin-bottom:2px;">Protein (g / 100g) *</label>
                              <input type="number" name="protein_g" id="sn-edit-nut-protein" step="0.1" min="0" required class="sn-input" style="font-family:var(--sn-font-mono);" />
                            </div>
                            <div>
                              <label style="font-size:0.71rem;font-weight:700;display:block;margin-bottom:2px;">Total Carbs (g / 100g) *</label>
                              <input type="number" name="carbs_g" id="sn-edit-nut-carbs" step="0.1" min="0" required class="sn-input" style="font-family:var(--sn-font-mono);" />
                            </div>
                            <div>
                              <label style="font-size:0.71rem;font-weight:700;display:block;margin-bottom:2px;">Dietary Fiber (g / 100g) *</label>
                              <input type="number" name="dietary_fiber_g" id="sn-edit-nut-fiber" step="0.1" min="0" required class="sn-input" style="font-family:var(--sn-font-mono);" />
                            </div>
                          </div>

                          <div class="sn-admin-variant-price-grid" style="margin-bottom:10px;">
                            <div>
                              <label style="font-size:0.71rem;font-weight:700;display:block;margin-bottom:2px;">Total Fat (g / 100g) *</label>
                              <input type="number" name="total_fat_g" id="sn-edit-nut-fat" step="0.1" min="0" required class="sn-input" style="font-family:var(--sn-font-mono);" />
                            </div>
                            <div>
                              <label style="font-size:0.71rem;font-weight:700;display:block;margin-bottom:2px;">Saturated Fat (g / 100g) *</label>
                              <input type="number" name="saturated_fat_g" id="sn-edit-nut-satfat" step="0.1" min="0" required class="sn-input" style="font-family:var(--sn-font-mono);" />
                            </div>
                            <div>
                              <label style="font-size:0.71rem;font-weight:700;display:block;margin-bottom:2px;">Total Sugars (g / 100g) *</label>
                              <input type="number" name="total_sugars_g" id="sn-edit-nut-sugars" step="0.1" min="0" required class="sn-input" style="font-family:var(--sn-font-mono);" />
                            </div>
                            <div>
                              <label style="font-size:0.71rem;font-weight:700;display:block;margin-bottom:2px;">Sodium (mg / 100g) *</label>
                              <input type="number" name="sodium_mg" id="sn-edit-nut-sodium" step="0.1" min="0" required class="sn-input" style="font-family:var(--sn-font-mono);" />
                            </div>
                          </div>

                          <div class="sn-admin-variant-price-grid">
                            <div>
                              <label style="font-size:0.71rem;font-weight:700;display:block;margin-bottom:2px;">Added Sugars (g)</label>
                              <input type="number" name="added_sugars_g" id="sn-edit-nut-addedsugars" step="0.1" min="0" value="0" class="sn-input" style="font-family:var(--sn-font-mono);" />
                            </div>
                            <div>
                              <label style="font-size:0.71rem;font-weight:700;display:block;margin-bottom:2px;">Trans Fat (g)</label>
                              <input type="number" name="trans_fat_g" id="sn-edit-nut-transfat" step="0.1" min="0" value="0" class="sn-input" style="font-family:var(--sn-font-mono);" />
                            </div>
                            <div>
                              <label style="font-size:0.71rem;font-weight:700;display:block;margin-bottom:2px;">Signature Bioactive Label *</label>
                              <input type="text" name="bioactive_label" id="sn-edit-nut-biolabel" required placeholder="e.g. Natural Plant Calcium" class="sn-input" />
                            </div>
                            <div>
                              <label style="font-size:0.71rem;font-weight:700;display:block;margin-bottom:2px;">Signature Bioactive Value *</label>
                              <input type="text" name="bioactive_value" id="sn-edit-nut-bioval" required placeholder="e.g. 344 mg Calcium (IFCT)" class="sn-input" />
                            </div>
                          </div>
                        </div>
                      </div>

                      <!-- Modal Pane 4: Per-Product Delivery PIN & Zone Restrictions -->
                      <div data-prod-modal-pane="pincode" style="display:none;">
                        <div class="sn-card" style="background-color:var(--sn-bg-parchment);padding:12px 14px;margin-bottom:12px;">
                          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
                            <div>
                              <strong style="font-family:var(--sn-font-serif);font-size:0.95rem;color:var(--sn-bg-forest);">📍 Per-Product Delivery PIN Code &amp; 4-Zone Serviceability Rules</strong>
                              <div style="font-size:0.75rem;color:var(--sn-text-secondary);">Restrict individual products to specific Shipping Zones, exact 6-digit PINs, 2-5 digit PIN prefixes (e.g. <code>560*</code>), or PIN ranges (e.g. <code>560001-560099</code>).</div>
                            </div>
                          </div>

                          <div class="sn-grid-2" style="gap:12px;margin-bottom:12px;">
                            <div>
                              <label for="sn-edit-pin-mode" style="font-size:0.74rem;font-weight:700;display:block;margin-bottom:4px;">Delivery Restriction Mode *</label>
                              <select name="pincode_restriction_mode" id="sn-edit-pin-mode" class="sn-select" style="font-weight:600;">
                                <option value="NONE">NONE — Deliverable to All Serviceable Indian PINs (Default)</option>
                                <option value="ALLOW_ONLY">ALLOW_ONLY (Allowlist) — Deliver ONLY to Selected Zones / PINs</option>
                                <option value="BLOCK_LIST">BLOCK_LIST (Blocklist) — Block Delivery to Selected Zones / PINs</option>
                              </select>
                            </div>
                            <div>
                              <label for="sn-edit-pin-scope" style="font-size:0.74rem;font-weight:700;display:block;margin-bottom:4px;">Enforcement Scope on Restricted PINs *</label>
                              <select name="pincode_restriction_scope" id="sn-edit-pin-scope" class="sn-select">
                                <option value="BLOCK_DELIVERY">BLOCK_DELIVERY — Block All Delivery (Prepaid &amp; COD)</option>
                                <option value="BLOCK_COD_ONLY">BLOCK_COD_ONLY — Allow Prepaid Only (Disable Cash on Delivery)</option>
                              </select>
                            </div>
                          </div>

                          <div style="margin-bottom:12px;">
                            <label style="font-size:0.74rem;font-weight:700;display:block;margin-bottom:6px;">1-Click Shipping Zone Shortcuts (Optional)</label>
                            <div class="sn-grid-2" style="gap:8px;">
                              <label class="sn-card" style="padding:8px 10px;display:flex;align-items:center;gap:8px;cursor:pointer;background-color:var(--sn-bg-surface);">
                                <input type="checkbox" name="pin_zone_ZONE_A" id="sn-edit-pin-zone-ZONE_A" value="ZONE_A" />
                                <span style="font-size:0.78rem;"><strong>Zone A</strong> — Local Bengaluru (<code>560xxx</code>)</span>
                              </label>
                              <label class="sn-card" style="padding:8px 10px;display:flex;align-items:center;gap:8px;cursor:pointer;background-color:var(--sn-bg-surface);">
                                <input type="checkbox" name="pin_zone_ZONE_B" id="sn-edit-pin-zone-ZONE_B" value="ZONE_B" />
                                <span style="font-size:0.78rem;"><strong>Zone B</strong> — South India Regional (KA, TN, KL, AP, TG)</span>
                              </label>
                              <label class="sn-card" style="padding:8px 10px;display:flex;align-items:center;gap:8px;cursor:pointer;background-color:var(--sn-bg-surface);">
                                <input type="checkbox" name="pin_zone_ZONE_C" id="sn-edit-pin-zone-ZONE_C" value="ZONE_C" />
                                <span style="font-size:0.78rem;"><strong>Zone C</strong> — Rest of India National</span>
                              </label>
                              <label class="sn-card" style="padding:8px 10px;display:flex;align-items:center;gap:8px;cursor:pointer;background-color:var(--sn-bg-surface);">
                                <input type="checkbox" name="pin_zone_ZONE_D" id="sn-edit-pin-zone-ZONE_D" value="ZONE_D" />
                                <span style="font-size:0.78rem;"><strong>Zone D</strong> — Special / NE / J&amp;K / Islands</span>
                              </label>
                            </div>
                          </div>

                          <div style="margin-bottom:12px;">
                            <label for="sn-edit-pin-tokens" style="font-size:0.74rem;font-weight:700;display:block;margin-bottom:4px;">Exact 6-Digit PINs, Prefixes (e.g. 560*) &amp; Ranges (e.g. 560001-560099)</label>
                            <input
                              type="text"
                              name="pincodeTokens"
                              id="sn-edit-pin-tokens"
                              placeholder="e.g. 560038, 560*, 400001-400099"
                              class="sn-input"
                              style="font-family:var(--sn-font-mono);"
                            />
                            <div style="font-family:var(--sn-font-mono);font-size:0.7rem;color:var(--sn-text-muted);margin-top:3px;">
                              Separate multiple rules with commas. Combine with Zone checkboxes above as needed.
                            </div>
                          </div>

                          <div style="margin-bottom:12px;">
                            <label for="sn-edit-pin-reason" style="font-size:0.74rem;font-weight:700;display:block;margin-bottom:4px;">Customer-Facing Restriction Note (Humanizer-Checked)</label>
                            <input
                              type="text"
                              name="pincodeReason"
                              id="sn-edit-pin-reason"
                              placeholder="e.g. Fresh harvest soft dates are deliverable only across Bengaluru and South India."
                              class="sn-input"
                            />
                          </div>

                          <!-- Instant Admin PIN Rule Simulator inside Modal -->
                          <div style="padding:10px 12px;border-radius:6px;background-color:var(--sn-bg-mortar);border:1px dashed var(--sn-border-strong);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
                            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                              <span style="font-family:var(--sn-font-mono);font-size:0.73rem;font-weight:700;color:var(--sn-bg-forest);">🧪 Live Rule Simulator:</span>
                              <input type="text" id="sn-edit-pin-test-input" maxlength="6" value="560038" placeholder="6-Digit PIN" class="sn-input" style="width:96px;padding:4px 8px;min-height:30px;font-family:var(--sn-font-mono);font-size:0.76rem;" />
                              <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-edit-pin-test-btn" style="min-height:30px;padding:4px 10px;">Test PIN</button>
                            </div>
                            <span id="sn-edit-pin-test-result" class="sn-status sn-status-paid" style="font-family:var(--sn-font-mono);font-size:0.72rem;">
                              ✓ Deliverable (Prepaid &amp; COD Allowed)
                            </span>
                          </div>
                        </div>
                      </div>

                      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding-top:10px;border-top:1px solid var(--sn-border-warm);">
                        <div style="font-family:var(--sn-font-mono);font-size:0.72rem;color:var(--sn-text-muted);">
                          Tip: Review all 4 tabs above (Core Info, 4-Pack Pricing/Stock, FSSAI Nutrition, and PIN Rules) before saving.
                        </div>
                        <div style="display:flex;gap:10px;flex-wrap:wrap;">
                          <button type="button" class="sn-btn sn-btn-outline" data-close-prod-modal>Cancel</button>
                          <button type="submit" id="sn-edit-prod-submit-btn" class="sn-btn sn-btn-forest">Save Product, Pricing, Nutrition &amp; PIN Rules</button>
                        </div>
                      </div>
                    </form>

                    <!-- Integrated Primary Photo & FSSAI Back-Label Gallery Uploader inside the Modal (Shown on Tab 1 Core Info) -->
                    <form id="sn-admin-image-upload-form" style="padding-top:14px;border-top:1px dashed var(--sn-border-strong);">
                      <input type="hidden" name="productId" id="sn-upload-prod-select" value="${products[0] ? products[0].id : 1}" />
                      <div style="font-family:var(--sn-font-serif);font-weight:700;font-size:0.95rem;color:var(--sn-bg-forest);margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <span>📸 Upload Primary Photo or Add FSSAI Nutrition Label to Gallery</span>
                        ${renderImageSpecTooltip('product')}
                      </div>
                      <div class="sn-grid-3" style="gap:10px;align-items:end;">
                        <div>
                          <label style="font-size:0.73rem;font-weight:600;display:block;margin-bottom:3px;">Photo Target Role</label>
                          <select name="setAsPrimary" class="sn-select">
                            <option value="true" selected>Replace Primary Storefront Photo</option>
                            <option value="false">Add to Secondary Gallery (Back Label)</option>
                          </select>
                        </div>
                        <div>
                          <label style="font-size:0.73rem;font-weight:600;display:block;margin-bottom:3px;">Image Caption</label>
                          <input type="text" name="caption" value="Front Pack / FSSAI Nutrition Label" class="sn-input" />
                        </div>
                        <div>
                          <label style="font-size:0.73rem;font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px;"><span>Image File (JPEG/PNG/WebP) *</span> ${renderImageSpecTooltip('product')}</label>
                          <div class="sn-admin-file-action-group">
                            <input type="file" name="imageFile" accept="image/jpeg,image/png,image/webp" required title="${escapeHtml(IMAGE_UPLOAD_SPECS.product.summary)}" class="sn-input sn-file-input sn-file-input-sm" />
                            <button type="submit" class="sn-btn sn-btn-primary sn-btn-sm">Upload</button>
                          </div>
                        </div>
                      </div>
                    </form>
                  </div>
                </div>
              </div>

              <!-- Contextual Category Edit Modal (Opens on Category ✏️ Edit Click) -->
              <div id="sn-admin-edit-category-modal" class="sn-admin-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="sn-edit-cat-modal-heading" style="display:none;">
                <div class="sn-admin-modal-card" style="max-width:660px;">
                  <div class="sn-admin-modal-header">
                    <div style="display:flex;align-items:center;gap:12px;">
                      <img id="sn-edit-cat-modal-thumb" src="${basePath}/images/cat-dry-fruits.jpg" alt="Category Banner Preview" style="width:60px;height:42px;object-fit:cover;border-radius:6px;border:1px solid rgba(255,255,255,0.25);" />
                      <div>
                        <span id="sn-edit-cat-modal-slug" style="font-family:var(--sn-font-mono);font-size:0.73rem;color:var(--sn-accent-turmeric);letter-spacing:0.05em;">/category/dry-fruits</span>
                        <h3 id="sn-edit-cat-modal-heading" style="font-family:var(--sn-font-serif);margin:0;font-size:1.15rem;color:#FAF5E4;">Edit Category Details &amp; Banner Photo</h3>
                      </div>
                    </div>
                    <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-close-cat-modal>✕ Close</button>
                  </div>

                  <div class="sn-admin-modal-body">
                    <form id="sn-admin-edit-category-form">
                      <input type="hidden" name="categoryId" id="sn-edit-cat-id" value="${categories[0] ? categories[0].id : 1}" />

                      <div class="sn-grid-2" style="gap:12px;margin-bottom:12px;">
                        <div>
                          <label style="font-size:0.75rem;font-weight:700;display:block;margin-bottom:4px;">Category Name *</label>
                          <input type="text" name="name" id="sn-edit-cat-name" required class="sn-input" />
                        </div>
                        <div>
                          <label style="font-size:0.75rem;font-weight:700;display:block;margin-bottom:4px;">Storefront Status</label>
                          <select name="isActive" id="sn-edit-cat-active" class="sn-select">
                            <option value="1">Published (Active)</option>
                            <option value="0">Deactivated (Hidden)</option>
                          </select>
                        </div>
                      </div>

                      <div style="margin-bottom:12px;">
                        <label style="font-size:0.75rem;font-weight:700;display:block;margin-bottom:4px;">Subtitle / Eyebrow *</label>
                        <input type="text" name="subtitle" id="sn-edit-cat-subtitle" required class="sn-input" />
                      </div>

                      <div style="margin-bottom:12px;">
                        <label style="font-size:0.75rem;font-weight:700;display:block;margin-bottom:4px;">Category Description (Humanizer-Checked) *</label>
                        <textarea name="description" id="sn-edit-cat-desc" rows="2" required class="sn-textarea"></textarea>
                      </div>

                      <div style="margin-bottom:16px;">
                        <label style="font-size:0.75rem;font-weight:700;display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px;"><span>Replace Category Banner Image (Optional JPEG/PNG/WebP)</span> ${renderImageSpecTooltip('category')}</label>
                        <input type="file" name="categoryImageFile" id="sn-edit-cat-file" accept="image/jpeg,image/png,image/webp" title="${escapeHtml(IMAGE_UPLOAD_SPECS.category.summary)}" class="sn-input sn-file-input" />
                      </div>

                      <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;">
                        <button type="button" class="sn-btn sn-btn-outline" data-close-cat-modal>Cancel</button>
                        <button type="submit" class="sn-btn sn-btn-forest">Save Category Edits</button>
                      </div>
                    </form>
                  </div>
                </div>
              </div>
            </div>

            <!-- Panel 4: Complete Inventory & Stock Movements (All 88 Pack Variants + Low-Stock Threshold Editor) -->
            <div class="sn-card" data-admin-panel="inventory" style="display:none;">
              <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
                <div>
                  <h2 style="font-family:var(--sn-font-serif);margin:0 0 4px;color:var(--sn-bg-forest);">Inventory Control &amp; Atomic Stock Movement Ledger (All ${variants.length} Pack Variants)</h2>
                  <p style="font-size:0.84rem;color:var(--sn-text-secondary);margin:0;">
                    Stock is automatically decremented on order confirmation and restored on order cancellation or refund.
                  </p>
                </div>
                <span id="sn-admin-inv-count-badge" class="sn-status sn-status-paid" style="font-family:var(--sn-font-mono);">Showing ${variants.length} of ${variants.length} Variants</span>
              </div>

              <!-- In-Panel Segmented Sub-Module Bar (Synced with Desktop Sidebar Accordion) -->
              <div class="sn-admin-subnav-bar" role="tablist">
                <button type="button" class="sn-admin-subtab-pill sn-active" data-admin-subtab-btn="inventory:variants">📊 4.1 Variant Stock Adjuster (${variants.length} SKUs)</button>
                <button type="button" class="sn-admin-subtab-pill" data-admin-subtab-btn="inventory:movements">📜 4.2 Stock Movement Ledger (${movements.length})</button>
              </div>

              <!-- Sub-Panel 4.1 (Default): 88-Variant Stock Adjuster -->
              <div data-admin-subpanel="inventory:variants">
                ${renderInventoryAnalyticsCharts({ variants, products, categories })}

                <div class="sn-card" id="sn-admin-inv-filter-bar" style="background-color:var(--sn-bg-parchment);padding:10px 14px;margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                  <input type="search" id="sn-admin-inv-search" placeholder="Search SKU, product, or pack size..." class="sn-input" style="flex:1;min-width:170px;" />
                  <select id="sn-admin-inv-cat-filter" class="sn-select" style="width:auto;min-width:145px;">
                    <option value="all">Category: All (${categories.length})</option>
                    ${categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
                  </select>
                  <select id="sn-admin-inv-pack-filter" class="sn-select" style="width:auto;min-width:135px;">
                    <option value="all">Pack: All Sizes (${variants.length})</option>
                    <option value="100 g">100 g Packs</option>
                    <option value="250 g">250 g Packs</option>
                    <option value="500 g">500 g Packs</option>
                    <option value="1 kg">1 kg Packs</option>
                  </select>
                  <select id="sn-admin-inv-health-filter" class="sn-select" style="width:auto;min-width:155px;">
                    <option value="all">Health: All Tiers</option>
                    <option value="HEALTHY">🟢 Healthy (&gt;1.5&times;)</option>
                    <option value="WATCH">🟡 Watchlist (1.0&times;–1.5&times;)</option>
                    <option value="LOW">🟠 Low Stock (&le;Min)</option>
                    <option value="OUT">🔴 Out of Stock (0)</option>
                  </select>
                  <label style="font-size:0.78rem;display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap;font-weight:600;">
                    <input type="checkbox" id="sn-admin-inv-low-only" /> Low-Stock Only
                  </label>
                  <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-admin-inv-reset-filters" style="padding:5px 10px;font-size:0.74rem;">↺ Reset</button>
                </div>

                <div class="sn-table-wrap">
                  <table class="sn-table sn-table-cards" id="sn-admin-inventory-table">
                    <thead>
                      <tr><th>Variant SKU</th><th>Product</th><th>Pack Size</th><th>Selling Price &amp; Discount</th><th>MRP</th><th>Current Stock</th><th>Alert Threshold</th><th>Update Stock &amp; Threshold</th></tr>
                    </thead>
                    <tbody>
                      ${variants.map(v => {
                        const parentProd = products.find(p => Number(p.id) === Number(v.product_id));
                        const prodName = parentProd ? parentProd.name : `Product #${v.product_id}`;
                        const catId = parentProd ? Number(parentProd.category_id) : 1;
                        const tier = classifyInventoryHealthTier(v.stock_qty, v.low_stock_threshold);
                        const vSavePct = v.mrp_paise > v.selling_price_paise
                          ? Math.round(((v.mrp_paise - v.selling_price_paise) / v.mrp_paise) * 100)
                          : 0;
                        return `
                        <tr
                          data-inv-variant-row="${v.id}"
                          data-inv-sku="${escapeHtml((v.sku + ' ' + prodName).toLowerCase())}"
                          data-inv-sku-code="${escapeHtml(v.sku)}"
                          data-inv-prod-name="${escapeHtml(prodName)}"
                          data-inv-cat-id="${catId}"
                          data-inv-pack="${escapeHtml(v.pack_label)}"
                          data-inv-weight-grams="${v.weight_grams}"
                          data-inv-sell-paise="${v.selling_price_paise}"
                          data-inv-stock-qty="${v.stock_qty}"
                          data-inv-threshold="${v.low_stock_threshold}"
                          data-inv-health-tier="${tier}"
                          data-inv-low="${v.stock_qty <= v.low_stock_threshold ? '1' : '0'}"
                        >
                          <td data-label="Variant SKU" style="font-family:var(--sn-font-mono);font-weight:700;color:var(--sn-bg-forest);">${escapeHtml(v.sku)}</td>
                          <td data-label="Product" style="font-size:0.82rem;font-weight:600;">${escapeHtml(prodName)}</td>
                          <td data-label="Pack Size" style="font-family:var(--sn-font-mono);">${escapeHtml(v.pack_label)}</td>
                          <td data-label="Selling Price &amp; Discount" style="font-family:var(--sn-font-mono);font-weight:600;">
                            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                              <span>${formatInr(v.selling_price_paise)}</span>
                              ${vSavePct > 0 ? `<span class="sn-price-save" style="margin-left:0;">-${vSavePct}%</span>` : ''}
                              <button
                                type="button"
                                class="sn-btn sn-btn-outline sn-btn-sm"
                                data-load-prod-editor="${v.product_id}"
                                data-open-modal-tab="pricing"
                                style="padding:2px 7px;min-height:24px;font-size:0.68rem;"
                                title="Edit ${escapeHtml(v.pack_label)} Discount &amp; Price"
                              >✏️ Price</button>
                            </div>
                          </td>
                          <td data-label="MRP" style="font-family:var(--sn-font-mono);color:var(--sn-text-muted);">${formatInr(v.mrp_paise)}</td>
                          <td data-label="Current Stock"><span class="sn-status ${v.stock_qty <= v.low_stock_threshold ? 'sn-status-danger' : 'sn-status-paid'}" data-inv-stock-badge="${v.id}">${v.stock_qty} packs</span></td>
                          <td data-label="Alert Threshold" style="font-family:var(--sn-font-mono);" data-inv-threshold-cell="${v.id}">&le; ${v.low_stock_threshold} packs</td>
                          <td data-label="Update Stock &amp; Min Alert">
                            <form class="sn-admin-stock-form" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                              <input type="hidden" name="variantId" value="${v.id}" />
                              <input type="number" name="newStockQty" value="${v.stock_qty}" min="0" title="New Stock Quantity" class="sn-input" style="width:78px;padding:6px;" />
                              <input type="number" name="lowStockThreshold" value="${v.low_stock_threshold}" min="1" title="Low-Stock Alert Threshold" class="sn-input" style="width:68px;padding:6px;" />
                              <button type="submit" class="sn-btn sn-btn-forest sn-btn-sm">Update</button>
                            </form>
                          </td>
                        </tr>
                      `;
                      }).join('')}
                    </tbody>
                  </table>
                </div>
                <div id="sn-admin-inventory-pagination" class="sn-admin-pagination-bar"></div>
              </div>

              <!-- Sub-Panel 4.2: Stock Movement Ledger -->
              <div data-admin-subpanel="inventory:movements" style="display:none;">
                <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1.1rem;">Recent Stock Movements Ledger</h3>
                <div class="sn-table-wrap">
                  <table class="sn-table" id="sn-admin-movements-table">
                    <thead>
                      <tr><th>Timestamp</th><th>Variant SKU &amp; ID</th><th>Delta</th><th>Prev -&gt; New</th><th>Reason</th><th>Reference</th></tr>
                    </thead>
                    <tbody>
                      ${movements.map(m => {
                        const mvVar = variants.find(v => Number(v.id) === Number(m.variant_id));
                        const skuLabel = mvVar ? `${mvVar.sku} (${mvVar.pack_label})` : `Variant #${m.variant_id}`;
                        return `
                        <tr>
                          <td style="font-family:var(--sn-font-mono);font-size:0.75rem;">${escapeHtml(m.created_at)}</td>
                          <td style="font-family:var(--sn-font-mono);"><strong>${escapeHtml(skuLabel)}</strong> <span style="color:var(--sn-text-muted);font-size:0.72rem;">#${m.variant_id}</span></td>
                          <td style="font-family:var(--sn-font-mono);color:${m.delta_qty < 0 ? 'var(--sn-status-danger)' : 'var(--sn-status-paid)'};">${m.delta_qty > 0 ? '+' + m.delta_qty : m.delta_qty}</td>
                          <td style="font-family:var(--sn-font-mono);">${m.previous_qty} -&gt; ${m.new_qty}</td>
                          <td>${escapeHtml(m.reason)}</td>
                          <td style="font-family:var(--sn-font-mono);">${escapeHtml(m.reference_id)}</td>
                        </tr>
                      `;
                      }).join('')}
                    </tbody>
                  </table>
                </div>
                <div id="sn-admin-movements-pagination" class="sn-admin-pagination-bar"></div>
              </div>
            </div>

            <!-- Panel 5: Payments, COD Settlement, Refunds & Sales/Product Reports (Section 5.1 & Section 6) -->
            <div class="sn-card" data-admin-panel="payments" style="${panelDisplayStyle('payments')}">
              <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Payment Gateway Reconciliation, COD Collections, Refunds &amp; Reports</h2>
              <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0 0 14px;">
                Authorized for <strong>SUPER_ADMIN</strong> and <strong>ACCOUNTS_MANAGER</strong>. Record COD collections, initiate/record refunds (with automatic stock restoration), and review sales reports.
              </p>

              <!-- In-Panel Segmented Sub-Module Bar (Synced with Desktop Sidebar Accordion) -->
              <div class="sn-admin-subnav-bar" role="tablist">
                <button type="button" class="sn-admin-subtab-pill sn-active" data-admin-subtab-btn="payments:reconciliation">💳 5.1 Payments, COD &amp; Refunds (${payments.length})</button>
                <button type="button" class="sn-admin-subtab-pill" data-admin-subtab-btn="payments:sales-timeseries">📈 5.2 Daily / Weekly / Monthly Sales</button>
                <button type="button" class="sn-admin-subtab-pill" data-admin-subtab-btn="payments:product-sales">📦 5.3 Product-Wise Sales (${reports.productSales.length})</button>
                <button type="button" class="sn-admin-subtab-pill" data-admin-subtab-btn="payments:gst-summaries">🧾 5.4 GST Tax &amp; Gateway Summaries</button>
              </div>

              <!-- Sub-Panel 5.1 (Default): Payments, COD Collections & Refunds -->
              <div data-admin-subpanel="payments:reconciliation">
                <div class="sn-table-wrap">
                  <table class="sn-table sn-table-cards">
                    <thead>
                      <tr><th>Order No.</th><th>Provider &amp; Method</th><th>Gateway Order / Payment ID</th><th>Amount</th><th>Status</th><th>Server Verified</th><th>Accounts Manager Actions</th></tr>
                    </thead>
                    <tbody>
                      ${payments.map(pay => `
                        <tr>
                          <td data-label="Order No." style="font-family:var(--sn-font-mono);font-weight:700;color:var(--sn-bg-forest);">${escapeHtml(pay.order_number)}</td>
                          <td data-label="Provider &amp; Method"><span>${escapeHtml(pay.gateway_provider)} (${escapeHtml(pay.method)})</span></td>
                          <td data-label="Gateway Reference" style="font-family:var(--sn-font-mono);font-size:0.74rem;">
                            <div>
                              Ord: ${escapeHtml(pay.gateway_order_id)}<br/>
                              Pay: ${escapeHtml(pay.gateway_payment_id || 'COD / Pending')}
                            </div>
                          </td>
                          <td data-label="Amount" style="font-family:var(--sn-font-mono);font-weight:700;">${formatInr(pay.amount_paise)}</td>
                          <td data-label="Status"><span class="sn-status ${pay.status === 'PAID' || pay.status === 'COD_COLLECTED' ? 'sn-status-paid' : 'sn-status-warn'}">${escapeHtml(pay.status)}</span></td>
                          <td data-label="Server Verified" style="font-family:var(--sn-font-mono);">${pay.verified_on_server ? '✓ Verified' : 'Pending'}</td>
                          <td data-label="Actions">
                            <div style="display:flex;gap:6px;flex-wrap:wrap;">
                              ${pay.status === 'COD_PENDING' ? `
                                <button type="button" class="sn-btn sn-btn-forest sn-btn-sm" data-payment-action="MARK_COD_COLLECTED" data-order-number="${escapeHtml(pay.order_number)}">Mark COD Collected</button>
                              ` : ''}
                              ${(pay.status === 'PAID' || pay.status === 'COD_COLLECTED') ? `
                                <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-payment-action="RECORD_REFUND" data-order-number="${escapeHtml(pay.order_number)}">Record Refund</button>
                              ` : ''}
                              ${pay.status === 'REFUNDED' ? `<span style="font-family:var(--sn-font-mono);font-size:0.72rem;color:var(--sn-text-muted);">Refunded (${formatInr(pay.refund_amount_paise || pay.amount_paise)})</span>` : ''}
                            </div>
                          </td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
              </div>

              <!-- Sub-Panel 5.2: Period Window Rollups & Daily / Weekly / Monthly Sales Time-Series -->
              <div data-admin-subpanel="payments:sales-timeseries" style="display:none;">
                <div class="sn-card" style="background-color:var(--sn-bg-parchment);margin-bottom:20px;padding:14px 18px;">
                  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
                    <div>
                      <span class="sn-eyebrow" style="margin:0;">Section 5.1 Reports Engine • Real Timestamp Bucketing &amp; Net-of-Refunds Accounting</span>
                      <h3 style="font-family:var(--sn-font-serif);margin:2px 0 0;font-size:1.15rem;color:var(--sn-bg-forest);">
                        Daily, Weekly &amp; Monthly Sales Time-Series Ledger
                      </h3>
                    </div>
                    <div style="display:flex;gap:6px;flex-wrap:wrap;">
                      <button type="button" class="sn-btn sn-btn-forest sn-btn-sm" data-export-csv="daily" data-export-table="sn-report-daily-table">⬇ Daily CSV</button>
                      <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-export-csv="weekly" data-export-table="sn-report-weekly-table">⬇ Weekly CSV</button>
                      <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-export-csv="monthly" data-export-table="sn-report-monthly-table">⬇ Monthly CSV</button>
                    </div>
                  </div>
                </div>

                <!-- 1. Period Window Rollups: Today vs. Last 7 Days (Weekly) vs. Current Month (Monthly) vs. All-Time -->
                <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1.1rem;color:var(--sn-bg-forest);">1. Period Window Rollups (Today vs. Last 7 Days vs. Current Month MTD)</h3>
                <div class="sn-table-wrap" style="margin-bottom:24px;">
                  <table class="sn-table" id="sn-report-period-rollups-table">
                    <thead>
                      <tr>
                        <th>Time Window</th>
                        <th>Orders (Valid / Total)</th>
                        <th>Packs Sold</th>
                        <th>Gross Subtotal</th>
                        <th>Discounts</th>
                        <th>Shipping</th>
                        <th>Included GST (CGST+SGST / IGST)</th>
                        <th>Settled Revenue</th>
                        <th>COD Pending</th>
                        <th>Refunded</th>
                        <th>Net Order Value</th>
                        <th>Avg Order Value (AOV)</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${reports.periodWindows.map(pw => `
                        <tr>
                          <td><strong>${escapeHtml(pw.label)}</strong></td>
                          <td style="font-family:var(--sn-font-mono);">${pw.validOrdersCount} / ${pw.ordersCount}</td>
                          <td style="font-family:var(--sn-font-mono);">${pw.unitsSold}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(pw.grossSubtotalPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);color:var(--sn-status-paid);">-${formatInr(pw.discountPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(pw.shippingPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);font-size:0.75rem;">
                            <strong>${formatInr(pw.totalGstPaise)}</strong><br/>
                            <span style="color:var(--sn-text-muted);">C+S: ${formatInr(pw.cgstPaise + pw.sgstPaise)} | I: ${formatInr(pw.igstPaise)}</span>
                          </td>
                          <td style="font-family:var(--sn-font-mono);font-weight:700;color:var(--sn-status-paid);">${formatInr(pw.settledRevenuePaise)}</td>
                          <td style="font-family:var(--sn-font-mono);color:var(--sn-status-warn);">${formatInr(pw.codPendingPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);color:var(--sn-status-danger);">${formatInr(pw.refundedPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);font-weight:700;">${formatInr(pw.netOrderValuePaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(pw.aovPaise)}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>

                <!-- 2. Granular Time-Series Breakdowns (Daily by Date | Weekly by ISO Week | Monthly by Month) -->
                <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:10px;">
                  <h3 style="font-family:var(--sn-font-serif);margin:0;font-size:1.1rem;color:var(--sn-bg-forest);">2. Granular Time-Series Sales Breakdown (Daily, Weekly &amp; Monthly Ledger)</h3>
                  <div style="display:flex;gap:6px;flex-wrap:wrap;">
                    <button type="button" class="sn-btn sn-btn-forest sn-btn-sm" data-report-period-btn="daily">Daily Breakdown (${reports.dailySales.length} Days)</button>
                    <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-report-period-btn="weekly">Weekly Breakdown (${reports.weeklySales.length} Weeks)</button>
                    <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-report-period-btn="monthly">Monthly Breakdown (${reports.monthlySales.length} Months)</button>
                  </div>
                </div>

                <!-- 2A. Daily Time-Series Table -->
                <div class="sn-table-wrap" data-report-period-panel="daily">
                  <table class="sn-table" id="sn-report-daily-table">
                    <thead>
                      <tr><th>Date (YYYY-MM-DD)</th><th>Orders</th><th>Packs Sold</th><th>Gross Subtotal</th><th>Discounts</th><th>Shipping</th><th>Total GST</th><th>Settled Revenue</th><th>COD Pending</th><th>Net Order Value</th><th>AOV</th></tr>
                    </thead>
                    <tbody>
                      ${reports.dailySales.map(r => `
                        <tr>
                          <td style="font-family:var(--sn-font-mono);font-weight:700;">${escapeHtml(r.label)}</td>
                          <td style="font-family:var(--sn-font-mono);">${r.ordersCount}</td>
                          <td style="font-family:var(--sn-font-mono);">${r.unitsSold}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(r.grossSubtotalPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">-${formatInr(r.discountPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(r.shippingPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(r.totalGstPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);font-weight:700;color:var(--sn-status-paid);">${formatInr(r.settledRevenuePaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(r.codPendingPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);font-weight:700;">${formatInr(r.netOrderValuePaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(r.aovPaise)}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>

                <!-- 2B. Weekly Time-Series Table -->
                <div class="sn-table-wrap" data-report-period-panel="weekly" style="display:none;">
                  <table class="sn-table" id="sn-report-weekly-table">
                    <thead>
                      <tr><th>ISO Week &amp; Date Range</th><th>Orders</th><th>Packs Sold</th><th>Gross Subtotal</th><th>Discounts</th><th>Shipping</th><th>Total GST</th><th>Settled Revenue</th><th>COD Pending</th><th>Net Order Value</th><th>AOV</th></tr>
                    </thead>
                    <tbody>
                      ${reports.weeklySales.map(r => `
                        <tr>
                          <td style="font-family:var(--sn-font-mono);font-weight:700;">${escapeHtml(r.label)}</td>
                          <td style="font-family:var(--sn-font-mono);">${r.ordersCount}</td>
                          <td style="font-family:var(--sn-font-mono);">${r.unitsSold}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(r.grossSubtotalPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">-${formatInr(r.discountPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(r.shippingPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(r.totalGstPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);font-weight:700;color:var(--sn-status-paid);">${formatInr(r.settledRevenuePaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(r.codPendingPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);font-weight:700;">${formatInr(r.netOrderValuePaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(r.aovPaise)}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>

                <!-- 2C. Monthly Time-Series Table -->
                <div class="sn-table-wrap" data-report-period-panel="monthly" style="display:none;">
                  <table class="sn-table" id="sn-report-monthly-table">
                    <thead>
                      <tr><th>Month (YYYY-MM)</th><th>Orders</th><th>Packs Sold</th><th>Gross Subtotal</th><th>Discounts</th><th>Shipping</th><th>Total GST</th><th>Settled Revenue</th><th>COD Pending</th><th>Net Order Value</th><th>AOV</th></tr>
                    </thead>
                    <tbody>
                      ${reports.monthlySales.map(r => `
                        <tr>
                          <td style="font-family:var(--sn-font-mono);font-weight:700;">${escapeHtml(r.label)}</td>
                          <td style="font-family:var(--sn-font-mono);">${r.ordersCount}</td>
                          <td style="font-family:var(--sn-font-mono);">${r.unitsSold}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(r.grossSubtotalPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">-${formatInr(r.discountPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(r.shippingPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(r.totalGstPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);font-weight:700;color:var(--sn-status-paid);">${formatInr(r.settledRevenuePaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(r.codPendingPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);font-weight:700;">${formatInr(r.netOrderValuePaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(r.aovPaise)}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
              </div>

              <!-- Sub-Panel 5.3: Product-Wise Sales & Volume Report (All 22 Products) -->
              <div data-admin-subpanel="payments:product-sales" style="display:none;">
                <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:10px;">
                  <h3 style="font-family:var(--sn-font-serif);margin:0;font-size:1.1rem;color:var(--sn-bg-forest);">Product-Wise Sales &amp; Volume Report (All ${reports.productSales.length} Products • Net of Cancelled/Refunded Orders)</h3>
                  <button type="button" class="sn-btn sn-btn-forest sn-btn-sm" data-export-csv="products" data-export-table="sn-report-products-table">⬇ Export Products Sales CSV</button>
                </div>
                <div class="sn-table-wrap" style="max-height:540px;overflow-y:auto;">
                  <table class="sn-table" id="sn-report-products-table">
                    <thead>
                      <tr>
                        <th>SKU &amp; HSN</th>
                        <th>Category</th>
                        <th>Product Name</th>
                        <th>Pack Variant Breakdown</th>
                        <th>Net Packs Sold</th>
                        <th>Net Weight Sold</th>
                        <th>Refunded Packs</th>
                        <th>Included GST</th>
                        <th>Net Revenue</th>
                        <th>Revenue Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${reports.productSales.map(r => `
                        <tr>
                          <td style="font-family:var(--sn-font-mono);font-size:0.75rem;">
                            <strong>${escapeHtml(r.skuBase)}</strong><br/>
                            HSN: ${escapeHtml(r.hsnCode)}
                          </td>
                          <td style="font-size:0.8rem;">${escapeHtml(r.categoryName)}</td>
                          <td><strong>${escapeHtml(r.name)}</strong></td>
                          <td style="font-family:var(--sn-font-mono);font-size:0.74rem;">${escapeHtml(r.packBreakdownText)}</td>
                          <td style="font-family:var(--sn-font-mono);font-weight:700;">${r.netPacksSold} packs</td>
                          <td style="font-family:var(--sn-font-mono);">${r.netWeightGrams} g</td>
                          <td style="font-family:var(--sn-font-mono);color:${r.refundedPacks > 0 ? 'var(--sn-status-danger)' : 'var(--sn-text-muted)'};">${r.refundedPacks}</td>
                          <td style="font-family:var(--sn-font-mono);">${formatInr(r.netGstPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);font-weight:700;color:${r.netRevenuePaise > 0 ? 'var(--sn-status-paid)' : 'var(--sn-text-muted)'};">${formatInr(r.netRevenuePaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">${r.revenueSharePercent}%</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
              </div>

              <!-- Sub-Panel 5.4: Order Summaries, GST Place-of-Supply Tax Summary & Gateway Reconciliation -->
              <div data-admin-subpanel="payments:gst-summaries" style="display:none;">
                <div style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
                  <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-export-csv="orders" data-export-table="sn-report-orders-table">⬇ Orders Summary CSV</button>
                  <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-export-csv="payments" data-export-table="sn-report-payments-table">⬇ Payments Summary CSV</button>
                </div>
                <div class="sn-pdp-grid" style="margin-bottom:26px;">
                  <div>
                    <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1.1rem;color:var(--sn-bg-forest);">4A. Order Fulfilment Status Summary</h3>
                    <div class="sn-table-wrap">
                      <table class="sn-table" id="sn-report-orders-table">
                        <thead>
                          <tr><th>Fulfilment Status</th><th>Orders</th><th>Share</th><th>Subtotal</th><th>Discounts</th><th>Shipping</th><th>Total Value</th></tr>
                        </thead>
                        <tbody>
                          ${reports.orderStatusSummary.map(os => `
                            <tr>
                              <td><strong>${escapeHtml(os.fulfilmentStatus)}</strong></td>
                              <td style="font-family:var(--sn-font-mono);font-weight:700;">${os.ordersCount}</td>
                              <td style="font-family:var(--sn-font-mono);">${os.sharePercent}%</td>
                              <td style="font-family:var(--sn-font-mono);">${formatInr(os.subtotalPaise)}</td>
                              <td style="font-family:var(--sn-font-mono);">-${formatInr(os.discountPaise)}</td>
                              <td style="font-family:var(--sn-font-mono);">${formatInr(os.shippingPaise)}</td>
                              <td style="font-family:var(--sn-font-mono);font-weight:700;">${formatInr(os.totalPaise)}</td>
                            </tr>
                          `).join('')}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div>
                    <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1.1rem;color:var(--sn-bg-forest);">4B. GST Place-of-Supply Tax Summary</h3>
                    <div class="sn-table-wrap" style="margin-bottom:18px;">
                      <table class="sn-table">
                        <thead>
                          <tr><th>Tax Regime</th><th>Valid Orders</th><th>CGST</th><th>SGST</th><th>IGST</th><th>Total GST</th><th>Invoice Total</th></tr>
                        </thead>
                        <tbody>
                          ${reports.orderTaxSummary.map(tr => `
                            <tr>
                              <td><strong>${escapeHtml(tr.regime)}</strong></td>
                              <td style="font-family:var(--sn-font-mono);">${tr.ordersCount}</td>
                              <td style="font-family:var(--sn-font-mono);">${formatInr(tr.cgstPaise)}</td>
                              <td style="font-family:var(--sn-font-mono);">${formatInr(tr.sgstPaise)}</td>
                              <td style="font-family:var(--sn-font-mono);">${formatInr(tr.igstPaise)}</td>
                              <td style="font-family:var(--sn-font-mono);font-weight:700;">${formatInr(tr.totalGstPaise)}</td>
                              <td style="font-family:var(--sn-font-mono);font-weight:700;">${formatInr(tr.totalOrderPaise)}</td>
                            </tr>
                          `).join('')}
                        </tbody>
                      </table>
                    </div>

                    <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1.1rem;color:var(--sn-bg-forest);">5B. Payment Settlement Status Summary</h3>
                    <div class="sn-table-wrap">
                      <table class="sn-table">
                        <thead>
                          <tr><th>Payment Status</th><th>Transactions Count</th><th>Total Amount (INR)</th></tr>
                        </thead>
                        <tbody>
                          ${reports.paymentStatusSummary.map(ps => `
                            <tr>
                              <td><span class="sn-status ${ps.status === 'PAID' || ps.status === 'COD_COLLECTED' ? 'sn-status-paid' : 'sn-status-warn'}">${escapeHtml(ps.status)}</span></td>
                              <td style="font-family:var(--sn-font-mono);font-weight:700;">${ps.transactionsCount}</td>
                              <td style="font-family:var(--sn-font-mono);font-weight:700;">${formatInr(ps.totalPaise)}</td>
                            </tr>
                          `).join('')}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                <!-- 5A. Payment Method Summary (UPI, Cards, NetBanking, COD) -->
                <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1.1rem;color:var(--sn-bg-forest);">5A. Payment Method &amp; Gateway Reconciliation Summary</h3>
                <div class="sn-table-wrap">
                  <table class="sn-table" id="sn-report-payments-table">
                    <thead>
                      <tr><th>Payment Mode</th><th>Description</th><th>Transactions</th><th>Gross Volume</th><th>Settled / Verified</th><th>Pending Collection</th><th>Refunded</th><th>Volume Share</th></tr>
                    </thead>
                    <tbody>
                      ${reports.paymentMethodSummary.map(pm => `
                        <tr>
                          <td style="font-family:var(--sn-font-mono);font-weight:700;">${escapeHtml(pm.method)}</td>
                          <td>${escapeHtml(pm.label)}</td>
                          <td style="font-family:var(--sn-font-mono);">${pm.transactionsCount}</td>
                          <td style="font-family:var(--sn-font-mono);font-weight:700;">${formatInr(pm.grossPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);color:var(--sn-status-paid);font-weight:700;">${formatInr(pm.settledPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);color:var(--sn-status-warn);">${formatInr(pm.pendingPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);color:var(--sn-status-danger);">${formatInr(pm.refundedPaise)}</td>
                          <td style="font-family:var(--sn-font-mono);">${pm.sharePercent}%</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <!-- Panel 6: Users, Purchases & Customer Export Module (Database-Connected Signed-Up Users & Purchase History) -->
            <div class="sn-card" data-admin-panel="customers" style="display:none;">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:14px;">
                <div>
                  <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Signed-Up Users, Purchase History &amp; Customer Data Export</h2>
                  <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0;">
                    Authorized for <strong>SUPER_ADMIN</strong> and <strong>ORDER_MANAGER</strong>. Inspect database-connected customer accounts, itemized pack purchases, lifetime spend, and export summary or line-item purchase ledgers to CSV.
                  </p>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
                  <button type="button" class="sn-btn sn-btn-forest sn-btn-sm" id="sn-export-users-summary-btn" data-export-users-csv="users_summary">⬇ Export Users Summary CSV</button>
                  <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-export-user-purchases-btn" data-export-users-csv="user_purchases">⬇ Export Detailed Purchases CSV</button>
                </div>
              </div>

              <!-- In-Panel Segmented Sub-Module Bar (Synced with Desktop Sidebar Accordion) -->
              <div class="sn-admin-subnav-bar" role="tablist">
                <button type="button" class="sn-admin-subtab-pill sn-active" data-admin-subtab-btn="customers:users">👤 6.1 Signed-Up Users &amp; Purchases (${customerDirectoryRows.length})</button>
                <button type="button" class="sn-admin-subtab-pill" data-admin-subtab-btn="customers:addresses">📍 6.2 Saved Addresses Directory (${customerAddresses.length})</button>
              </div>

              <!-- Sub-Panel 6.1 (Default): Signed-Up Users & Purchase Profiles -->
              <div data-admin-subpanel="customers:users">
                <div class="sn-grid-4" style="gap:12px;margin-bottom:14px;">
                  <div class="sn-card" style="padding:10px 14px;background-color:var(--sn-bg-parchment);">
                    <div style="font-family:var(--sn-font-mono);font-size:0.7rem;color:var(--sn-text-muted);text-transform:uppercase;">Signed-Up Users (DB)</div>
                    <strong style="font-family:var(--sn-font-mono);font-size:1.2rem;color:var(--sn-bg-forest);">${customerUsers.length}</strong>
                  </div>
                  <div class="sn-card" style="padding:10px 14px;background-color:var(--sn-bg-parchment);">
                    <div style="font-family:var(--sn-font-mono);font-size:0.7rem;color:var(--sn-text-muted);text-transform:uppercase;">Total Active Buyers</div>
                    <strong style="font-family:var(--sn-font-mono);font-size:1.2rem;color:var(--sn-bg-forest);">${customerDirectoryRows.length}</strong>
                  </div>
                  <div class="sn-card" style="padding:10px 14px;background-color:var(--sn-bg-parchment);">
                    <div style="font-family:var(--sn-font-mono);font-size:0.7rem;color:var(--sn-text-muted);text-transform:uppercase;">Total Packs Purchased</div>
                    <strong style="font-family:var(--sn-font-mono);font-size:1.2rem;color:var(--sn-bg-forest);">${customerDirectoryRows.reduce((acc, r) => acc + r.totalPacksBought, 0)} packs</strong>
                  </div>
                  <div class="sn-card" style="padding:10px 14px;background-color:var(--sn-bg-parchment);">
                    <div style="font-family:var(--sn-font-mono);font-size:0.7rem;color:var(--sn-text-muted);text-transform:uppercase;">Cumulative Buyer Spend</div>
                    <strong style="font-family:var(--sn-font-mono);font-size:1.2rem;color:var(--sn-bg-forest);">${formatInr(customerDirectoryRows.reduce((acc, r) => acc + r.totalSpendPaise, 0))}</strong>
                  </div>
                </div>

                <!-- Live Multi-Field User Search & Account Filter Toolbar -->
                <div class="sn-card" style="background-color:var(--sn-bg-mortar);padding:10px 14px;margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                  <input type="search" id="sn-admin-users-search" placeholder="Search User ID, Name, Email, Mobile Phone, City, PIN, Order #, or Purchased Product..." class="sn-input" style="flex:1;min-width:210px;" />
                  <select id="sn-admin-users-type-filter" class="sn-select" style="width:auto;min-width:175px;">
                    <option value="all">Account: All Buyers (${customerDirectoryRows.length})</option>
                    <option value="registered">Signed-Up Users Only (${customerDirectoryRows.filter(c => c.isRegistered).length})</option>
                    <option value="guest">Guest Checkout Buyers (${customerDirectoryRows.filter(c => !c.isRegistered).length})</option>
                    <option value="with_orders">Buyers With Purchases (${customerDirectoryRows.filter(c => c.orderNumbers.length > 0).length})</option>
                  </select>
                  <span id="sn-admin-users-count-badge" class="sn-status sn-status-paid" style="font-family:var(--sn-font-mono);">Showing ${customerDirectoryRows.length} of ${customerDirectoryRows.length} Users</span>
                </div>

                <div class="sn-table-wrap">
                  <table class="sn-table sn-table-cards" id="sn-admin-users-table">
                    <thead>
                      <tr>
                        <th>User ID &amp; Account</th>
                        <th>Customer Name &amp; Contact</th>
                        <th>Default Delivery Location</th>
                        <th>Orders &amp; Pack Volume</th>
                        <th>Purchased Products &amp; Invoices</th>
                        <th>Lifetime Spend</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${customerDirectoryRows.map(c => `
                        <tr
                          data-admin-user-row="${escapeHtml(c.email)}"
                          data-user-account-type="${c.isRegistered ? 'registered' : 'guest'}"
                          data-user-orders-count="${c.orderNumbers.length}"
                          data-user-details-json="${escapeHtml(JSON.stringify(c))}"
                        >
                          <td data-label="User ID &amp; Account">
                            <strong style="font-family:var(--sn-font-mono);color:var(--sn-bg-forest);">${escapeHtml(c.userIdLabel)}</strong><br/>
                            <span class="sn-status ${c.isRegistered ? 'sn-status-paid' : 'sn-status-warn'}" style="margin-top:3px;display:inline-block;">${escapeHtml(c.accountType)}</span>
                            <div style="font-family:var(--sn-font-mono);font-size:0.7rem;color:var(--sn-text-muted);margin-top:2px;">Joined: ${escapeHtml(c.joinedDate)}</div>
                          </td>
                          <td data-label="Customer &amp; Contact">
                            <strong>${escapeHtml(c.fullName)}</strong>
                            <div style="font-family:var(--sn-font-mono);font-size:0.75rem;color:var(--sn-text-secondary);margin-top:2px;">
                              ${escapeHtml(c.email)}<br/>
                              📞 ${escapeHtml(c.phone)}
                            </div>
                          </td>
                          <td data-label="Default Location" style="font-size:0.81rem;">
                            <strong>${escapeHtml(c.defaultCity)}, ${escapeHtml(c.defaultState)}</strong><br/>
                            <span style="font-family:var(--sn-font-mono);font-size:0.74rem;color:var(--sn-text-muted);">PIN: ${escapeHtml(c.defaultPincode)} • ${c.addressCount} saved addr</span>
                          </td>
                          <td data-label="Orders &amp; Volume" style="font-family:var(--sn-font-mono);font-size:0.78rem;">
                            <strong>${c.orderNumbers.length} orders</strong> (${c.totalPacksBought} packs)<br/>
                            <span style="font-size:0.71rem;color:var(--sn-text-muted);">Last: ${escapeHtml(c.lastOrderDate)}</span>
                          </td>
                          <td data-label="Purchases &amp; Invoices" style="font-size:0.79rem;">
                            ${c.purchasedItemsList.length > 0 ? `
                              <div style="margin-bottom:4px;line-height:1.35;">${escapeHtml(c.purchasedItemsList.slice(0, 2).join(', '))}${c.purchasedItemsList.length > 2 ? ` +${c.purchasedItemsList.length - 2} more` : ''}</div>
                            ` : '<div style="color:var(--sn-text-muted);margin-bottom:4px;">No pack purchases yet</div>'}
                            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
                              ${c.orderNumbers.map(on => `<a href="${basePath}/orders/${encodeURIComponent(on)}/invoice" class="sn-status sn-status-paid" style="text-decoration:none;font-family:var(--sn-font-mono);">🧾 ${escapeHtml(on)}</a>`).join('')}
                              ${c.detailedOrders.length > 0 ? `
                                <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-open-user-purchases="${escapeHtml(c.email)}" style="padding:2px 8px;min-height:24px;font-size:0.72rem;">🔍 View Purchases</button>
                              ` : ''}
                            </div>
                          </td>
                          <td data-label="Lifetime Spend" style="font-family:var(--sn-font-mono);">
                            <strong style="font-size:0.95rem;color:var(--sn-bg-forest);">${formatInr(c.totalSpendPaise)}</strong><br/>
                            <span style="font-size:0.7rem;color:var(--sn-status-paid);">Settled: ${formatInr(c.settledSpendPaise)}</span>
                            ${c.codPendingPaise > 0 ? `<br/><span style="font-size:0.7rem;color:var(--sn-status-warn);">COD: ${formatInr(c.codPendingPaise)}</span>` : ''}
                          </td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
                <div id="sn-admin-users-pagination" class="sn-admin-pagination-bar"></div>
              </div>

              <!-- Sub-Panel 6.2: Saved Delivery Addresses Directory -->
              <div data-admin-subpanel="customers:addresses" style="display:none;">
                <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1.1rem;color:var(--sn-bg-forest);">Saved Customer Delivery Addresses (${customerAddresses.length} Addresses in Database)</h3>
                <div class="sn-table-wrap">
                  <table class="sn-table sn-table-cards" id="sn-admin-addresses-table">
                    <thead>
                      <tr><th>Address ID</th><th>Linked User Account</th><th>Label</th><th>Recipient &amp; Mobile</th><th>Street Address</th><th>City, State &amp; PIN</th><th>Default</th></tr>
                    </thead>
                    <tbody>
                      ${customerAddresses.map(addr => {
                        const owner = customerUsers.find(u => Number(u.id) === Number(addr.user_id));
                        return `
                          <tr>
                            <td data-label="Address ID" style="font-family:var(--sn-font-mono);">#ADDR-${addr.id}</td>
                            <td data-label="Linked User" style="font-family:var(--sn-font-mono);font-size:0.76rem;">
                              <strong>${owner ? `USR-${owner.id}` : `USR-${addr.user_id}`}</strong><br/>
                              ${escapeHtml(owner ? owner.email : '')}
                            </td>
                            <td data-label="Label"><span class="sn-status sn-status-paid">${escapeHtml(addr.label || 'Home')}</span></td>
                            <td data-label="Recipient">
                              <strong>${escapeHtml(addr.recipient_name)}</strong><br/>
                              <span style="font-family:var(--sn-font-mono);font-size:0.75rem;">${escapeHtml(addr.phone)}</span>
                            </td>
                            <td data-label="Street Address" style="font-size:0.82rem;">
                              ${escapeHtml(addr.line1)}${addr.line2 ? ', ' + escapeHtml(addr.line2) : ''}
                            </td>
                            <td data-label="City, State &amp; PIN" style="font-family:var(--sn-font-mono);font-size:0.78rem;">
                              ${escapeHtml(addr.city)}, ${escapeHtml(addr.state)} - <strong>${escapeHtml(addr.pincode)}</strong>
                            </td>
                            <td data-label="Default">${addr.is_default ? '<span class="sn-status sn-status-paid">✓ Default</span>' : '<span style="color:var(--sn-text-muted);font-size:0.75rem;">Secondary</span>'}</td>
                          </tr>
                        `;
                      }).join('')}
                    </tbody>
                  </table>
                </div>
              </div>

              <!-- Contextual User Purchases & Invoices Modal -->
              <div id="sn-admin-user-purchases-modal" class="sn-admin-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="sn-user-purchases-modal-heading" style="display:none;">
                <div class="sn-admin-modal-card" style="max-width:780px;">
                  <div class="sn-admin-modal-header">
                    <div>
                      <span id="sn-user-purchases-modal-eyebrow" style="font-family:var(--sn-font-mono);font-size:0.73rem;color:var(--sn-accent-turmeric);letter-spacing:0.05em;">USER PURCHASE LEDGER</span>
                      <h3 id="sn-user-purchases-modal-heading" style="font-family:var(--sn-font-serif);margin:2px 0 0;font-size:1.2rem;color:#FAF5E4;">Customer Purchase History &amp; GST Invoices</h3>
                    </div>
                    <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-close-user-purchases-modal>✕ Close</button>
                  </div>
                  <div class="sn-admin-modal-body" id="sn-user-purchases-modal-body">
                  </div>
                </div>
              </div>
            </div>

            <!-- Panel 7: Staff RBAC Management (Invite/Create, Assign Roles/Permissions, Deactivate) & Audit Logs -->
            <div class="sn-card" data-admin-panel="rbac" style="display:none;">
              <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">5-Role Staff RBAC Management &amp; Immutable Audit Logs</h2>
              <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0 0 14px;">
                Restricted to <strong>SUPER_ADMIN</strong>. Invite new staff accounts, assign roles or granular <strong>STAFF</strong> action permissions, and deactivate/reactivate access.
              </p>

              <!-- In-Panel Segmented Sub-Module Bar (Synced with Desktop Sidebar Accordion) -->
              <div class="sn-admin-subnav-bar" role="tablist">
                <button type="button" class="sn-admin-subtab-pill sn-active" data-admin-subtab-btn="rbac:staff">👥 7.1 Staff Accounts &amp; RBAC Roles (${staffUsers.length})</button>
                <button type="button" class="sn-admin-subtab-pill" data-admin-subtab-btn="rbac:audit-logs">🛡️ 7.2 Immutable Admin Audit Logs (${auditLogs.length})</button>
              </div>

              <!-- Sub-Panel 7.1 (Default): Staff Accounts & RBAC Role Manager -->
              <div data-admin-subpanel="rbac:staff">
                <form id="sn-admin-create-staff-form" class="sn-card" style="background-color:var(--sn-bg-parchment);margin-bottom:24px;">
                  <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;font-size:1.05rem;color:var(--sn-bg-forest);">Invite / Create Individual Staff Account (Section 5 &amp; 5.1)</h3>
                  <div class="sn-grid-5" style="gap:10px;margin-bottom:10px;">
                    <div>
                      <label style="font-size:0.74rem;font-weight:600;">Full Name *</label>
                      <input type="text" name="fullName" required placeholder="e.g. Deepak Hegde" class="sn-input" />
                    </div>
                    <div>
                      <label style="font-size:0.74rem;font-weight:600;">Staff Email *</label>
                      <input type="email" name="email" required placeholder="deepak@sashyanaturals.com" class="sn-input" />
                    </div>
                    <div>
                      <label style="font-size:0.74rem;font-weight:600;">Phone *</label>
                      <input type="tel" name="phone" required placeholder="+91 98100 10009" class="sn-input" />
                    </div>
                    <div>
                      <label style="font-size:0.74rem;font-weight:600;">Temporary Password *</label>
                      <input type="password" name="password" required value="Sashya@2026" class="sn-input" />
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
                  <div class="sn-form-row-1-action" style="gap:12px;">
                    <div>
                      <label style="font-size:0.74rem;font-weight:600;">Explicit Action Permissions (Comma-separated for STAFF role)</label>
                      <input type="text" name="permissionsCsv" value="orders.view, shipping.update, inventory.view" class="sn-input" style="font-family:var(--sn-font-mono);font-size:0.78rem;" />
                    </div>
                    <button type="submit" class="sn-btn sn-btn-primary">Create Staff User</button>
                  </div>
                </form>

                <div class="sn-table-wrap">
                  <table class="sn-table sn-table-cards" id="sn-admin-staff-table">
                    <thead>
                      <tr><th>Staff Name &amp; Email</th><th>Current Role</th><th>Permitted Actions</th><th>Status</th><th>Update Role, Permissions &amp; Access</th></tr>
                    </thead>
                    <tbody>
                      ${staffUsers.map(u => `
                        <tr>
                          <td data-label="Staff Name &amp; Email">
                            <div>
                              <strong>${escapeHtml(u.full_name)}</strong><br/>
                              <span style="font-family:var(--sn-font-mono);font-size:0.75rem;color:var(--sn-text-muted);">${escapeHtml(u.email)}</span>
                            </div>
                          </td>
                          <td data-label="Current Role"><span class="sn-status sn-status-paid">${escapeHtml(u.role)}</span></td>
                          <td data-label="Permitted Actions" style="font-family:var(--sn-font-mono);font-size:0.74rem;overflow-wrap:anywhere;word-break:break-word;"><span>${escapeHtml(u.permissions_json)}</span></td>
                          <td data-label="Access Status"><span class="sn-status ${u.is_active ? 'sn-status-paid' : 'sn-status-danger'}">${u.is_active ? 'Active' : 'Deactivated'}</span></td>
                          <td data-label="Update Role &amp; Permissions">
                            <form class="sn-admin-staff-update-form" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;width:100%;">
                              <input type="hidden" name="userId" value="${u.id}" />
                              <select name="role" class="sn-select" style="flex:1;min-width:135px;padding:6px 8px;font-size:0.75rem;">
                                ${['SUPER_ADMIN', 'PRODUCT_MANAGER', 'ORDER_MANAGER', 'ACCOUNTS_MANAGER', 'STAFF'].map(r => `
                                  <option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>
                                `).join('')}
                              </select>
                              <input type="text" name="permissionsJson" value="${escapeHtml(u.permissions_json)}" class="sn-input" style="flex:1.2;min-width:140px;padding:6px 8px;font-family:var(--sn-font-mono);font-size:0.73rem;" />
                              <select name="isActive" class="sn-select" style="width:105px;padding:6px 8px;font-size:0.75rem;">
                                <option value="1" ${u.is_active ? 'selected' : ''}>Active</option>
                                <option value="0" ${!u.is_active ? 'selected' : ''}>Deactivate</option>
                              </select>
                              <button type="submit" class="sn-btn sn-btn-forest sn-btn-sm">Save</button>
                            </form>
                          </td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
              </div>

              <!-- Sub-Panel 7.2: Immutable Admin Audit Logs -->
              <div data-admin-subpanel="rbac:audit-logs" style="display:none;">
                <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin:0 0 10px;">
                  <h3 style="font-family:var(--sn-font-serif);margin:0;font-size:1.1rem;">Immutable Admin Audit Logs (Section 10)</h3>
                  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <input type="search" id="sn-admin-audit-search" placeholder="Search actor email, role, action, or entity..." class="sn-input" style="max-width:260px;padding:6px 10px;font-size:0.78rem;" />
                    <span id="sn-admin-audit-count-badge" class="sn-status sn-status-paid" style="font-family:var(--sn-font-mono);font-size:0.73rem;">Showing ${auditLogs.length} of ${auditLogs.length}</span>
                  </div>
                </div>
                <div class="sn-table-wrap">
                  <table class="sn-table" id="sn-admin-audit-logs-table">
                    <thead>
                      <tr><th>Timestamp</th><th>Actor Email</th><th>Role</th><th>Action</th><th>Entity</th><th>Details</th></tr>
                    </thead>
                    <tbody>
                      ${auditLogs.map(log => `
                        <tr>
                          <td style="font-family:var(--sn-font-mono);font-size:0.74rem;white-space:nowrap;">${escapeHtml(log.created_at)}</td>
                          <td style="font-family:var(--sn-font-mono);font-size:0.76rem;">${escapeHtml(log.actor_email)}</td>
                          <td><span class="sn-status sn-status-warn">${escapeHtml(log.actor_role)}</span></td>
                          <td style="font-family:var(--sn-font-mono);font-weight:600;font-size:0.76rem;">${escapeHtml(log.action)}</td>
                          <td style="font-family:var(--sn-font-mono);font-size:0.76rem;max-width:160px;overflow-wrap:anywhere;">${escapeHtml(log.entity_type)}:${escapeHtml(log.entity_id)}</td>
                          <td style="font-family:var(--sn-font-mono);font-size:0.73rem;max-width:310px;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(log.details_json)}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
                <div id="sn-admin-audit-pagination" class="sn-admin-pagination-bar"></div>
              </div>
            </div>

            <!-- Panel 8: Delivery Pricing, Editable GST/FSSAI Business Compliance & Editable Notification Templates -->
            <div class="sn-card" data-admin-panel="compliance" style="display:none;">
              <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Delivery Pricing Engine, GST/FSSAI Compliance &amp; Notification Templates</h2>
              <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0 0 14px;">
                Restricted to <strong>SUPER_ADMIN</strong>. Configure 4-Zone + 500g Weight-Slab shipping rules, update legal GSTIN/FSSAI business details (Section 11), and edit email/SMS notification templates (Section 8).
              </p>

              <!-- In-Panel Segmented Sub-Module Bar (Synced with Desktop Sidebar Accordion) -->
              <div class="sn-admin-subnav-bar" role="tablist">
                <button type="button" class="sn-admin-subtab-pill sn-active" data-admin-subtab-btn="compliance:shipping">🚚 8.1 Delivery Pricing Engine (4-Zone)</button>
                <button type="button" class="sn-admin-subtab-pill" data-admin-subtab-btn="compliance:legal-templates">🏛️ 8.2 GSTIN, FSSAI &amp; Email/SMS Templates</button>
                <button type="button" class="sn-admin-subtab-pill" data-admin-subtab-btn="compliance:notif-logs">📨 8.3 Notification Dispatch Logs (${notificationLogs.length})</button>
              </div>

              ${(() => {
                const sMap = Object.fromEntries(settings.map(s => [s.key, s.value]));
                const curMode = sMap.shipping_free_mode || 'THRESHOLD_WITH_WEIGHT_CAP';
                const threshVal = sMap.free_shipping_threshold_inr || '799';
                const maxWeightVal = sMap.free_shipping_max_weight_grams || '2000';
                const legalNameVal = (!sMap.business_legal_name || sMap.business_legal_name.includes('Configurable'))
                  ? 'Sashya Naturals Foods Private Limited'
                  : sMap.business_legal_name;
                const gstinVal = (!sMap.gstin || sMap.gstin.includes('CONFIGURABLE'))
                  ? '29AABCS1429B1Z5'
                  : sMap.gstin;
                const fssaiVal = (!sMap.fssai_license || sMap.fssai_license.includes('CONFIGURABLE'))
                  ? '11226332001482'
                  : sMap.fssai_license;
                const regAddrVal = (!sMap.registered_address || sMap.registered_address.includes('Configurable'))
                  ? 'No. 48, 100 Feet Road, Indiranagar, Bengaluru, Karnataka - 560038'
                  : sMap.registered_address;

                return `
                  <!-- Sub-Panel 8.1 (Default): Delivery Pricing Engine -->
                  <div data-admin-subpanel="compliance:shipping">
                    <form id="sn-admin-shipping-policy-form" class="sn-card" style="background-color:var(--sn-bg-parchment);">
                      <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;font-size:1.05rem;color:var(--sn-bg-forest);">1. Delivery Pricing Engine (4-Zone + 500g Weight Slabs + Free-Delivery Control)</h3>
                      <div class="sn-grid-3" style="gap:12px;margin-bottom:14px;">
                        <div>
                          <label style="font-size:0.76rem;font-weight:700;display:block;margin-bottom:4px;">Free-Delivery Policy Mode *</label>
                          <select name="shipping_free_mode" class="sn-select" style="font-weight:600;">
                            <option value="DISABLED" ${curMode === 'DISABLED' ? 'selected' : ''}>DISABLED (Always Charge Zone Freight)</option>
                            <option value="THRESHOLD_WITH_WEIGHT_CAP" ${curMode === 'THRESHOLD_WITH_WEIGHT_CAP' ? 'selected' : ''}>THRESHOLD + CAP (Free &ge; ₹${escapeHtml(threshVal)}, &le; ${escapeHtml(maxWeightVal)}g)</option>
                            <option value="UNCONDITIONAL_THRESHOLD" ${curMode === 'UNCONDITIONAL_THRESHOLD' ? 'selected' : ''}>UNCONDITIONAL (Free &ge; ₹${escapeHtml(threshVal)}, Any Weight)</option>
                          </select>
                        </div>
                        <div>
                          <label style="font-size:0.76rem;font-weight:700;display:block;margin-bottom:4px;">Free Delivery Above (INR ₹)</label>
                          <input type="number" name="free_shipping_threshold_inr" value="${escapeHtml(threshVal)}" min="0" class="sn-input" />
                        </div>
                        <div>
                          <label style="font-size:0.76rem;font-weight:700;display:block;margin-bottom:4px;">Free-Delivery Max Weight Cap (g)</label>
                          <input type="number" name="free_shipping_max_weight_grams" value="${escapeHtml(maxWeightVal)}" min="100" class="sn-input" />
                        </div>
                      </div>

                      <div class="sn-grid-4" style="gap:12px;margin-bottom:14px;">
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

                      <div class="sn-form-row-2-action" style="gap:12px;">
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
                  </div>

                  <!-- Sub-Panel 8.2: Editable Business Legal, GSTIN, FSSAI & Notification Templates Form -->
                  <div data-admin-subpanel="compliance:legal-templates" style="display:none;">
                    <form id="sn-admin-compliance-form" class="sn-card" style="background-color:var(--sn-bg-mortar);">
                      <h3 style="font-family:var(--sn-font-serif);margin:0 0 12px;font-size:1.05rem;color:var(--sn-bg-forest);">2. Business Legal, GSTIN, FSSAI &amp; Customer Notification Templates Editor (Sections 8 &amp; 11)</h3>
                      <div class="sn-grid-3" style="gap:12px;margin-bottom:12px;">
                        <div>
                          <label style="font-size:0.74rem;font-weight:600;display:block;">Business Legal Name *</label>
                          <input type="text" name="business_legal_name" required value="${escapeHtml(legalNameVal)}" class="sn-input" />
                        </div>
                        <div>
                          <label style="font-size:0.74rem;font-weight:600;display:block;">GSTIN Registration *</label>
                          <input type="text" name="gstin" required value="${escapeHtml(gstinVal)}" class="sn-input" style="font-family:var(--sn-font-mono);" />
                        </div>
                        <div>
                          <label style="font-size:0.74rem;font-weight:600;display:block;">FSSAI Licence / Registration *</label>
                          <input type="text" name="fssai_license" required value="${escapeHtml(fssaiVal)}" class="sn-input" style="font-family:var(--sn-font-mono);" />
                        </div>
                      </div>
                      <div class="sn-grid-3" style="gap:12px;margin-bottom:12px;">
                        <div>
                          <label style="font-size:0.74rem;font-weight:600;display:block;">Customer Support Email *</label>
                          <input type="email" name="support_email" required value="${escapeHtml(sMap.support_email || 'support@sashyanaturals.com')}" class="sn-input" />
                        </div>
                        <div>
                          <label style="font-size:0.74rem;font-weight:600;display:block;">Support Phone *</label>
                          <input type="text" name="support_phone" required value="${escapeHtml(sMap.support_phone || '+91 80 4568 2200')}" class="sn-input" />
                        </div>
                        <div>
                          <label style="font-size:0.74rem;font-weight:600;display:block;">Registered Office &amp; Dispatch Address *</label>
                          <input type="text" name="registered_address" required value="${escapeHtml(regAddrVal)}" class="sn-input" />
                        </div>
                      </div>
                      <div class="sn-grid-2" style="gap:12px;margin-bottom:12px;">
                        <div>
                          <label style="font-size:0.74rem;font-weight:600;display:block;margin-bottom:4px;">Order Confirmation Notification Template</label>
                          <textarea name="email_template_order_confirmed" rows="2" class="sn-textarea">${escapeHtml(sMap.email_template_order_confirmed || '')}</textarea>
                        </div>
                        <div>
                          <label style="font-size:0.74rem;font-weight:600;display:block;margin-bottom:4px;">Order Shipped / Dispatch Notification Template</label>
                          <textarea name="email_template_order_shipped" rows="2" class="sn-textarea">${escapeHtml(sMap.email_template_order_shipped || '')}</textarea>
                        </div>
                      </div>
                      <div class="sn-grid-3" style="gap:12px;margin-bottom:12px;">
                        <div>
                          <label style="font-size:0.74rem;font-weight:600;display:block;margin-bottom:4px;">Order Delivered Notification Template</label>
                          <textarea name="email_template_order_delivered" rows="2" class="sn-textarea">${escapeHtml(sMap.email_template_order_delivered || '')}</textarea>
                        </div>
                        <div>
                          <label style="font-size:0.74rem;font-weight:600;display:block;margin-bottom:4px;">Cancellation / Refund Notification Template</label>
                          <textarea name="email_template_order_cancelled" rows="2" class="sn-textarea">${escapeHtml(sMap.email_template_order_cancelled || '')}</textarea>
                        </div>
                        <div>
                          <label style="font-size:0.74rem;font-weight:600;display:block;margin-bottom:4px;">Live Email &amp; OTP Verification Status (Go-Live Gate)</label>
                          <select name="email_verification_live" class="sn-select" style="margin-bottom:8px;">
                            <option value="0" ${sMap.email_verification_live === '1' || sMap.email_verification_live === 'true' ? '' : 'selected'}>Sandbox / Pending Domain Verification (0)</option>
                            <option value="1" ${sMap.email_verification_live === '1' || sMap.email_verification_live === 'true' ? 'selected' : ''}>✓ Verified Live SMTP &amp; OTP Delivery Active (1)</option>
                          </select>
                          <button type="submit" class="sn-btn sn-btn-forest" style="width:100%;">Save Compliance &amp; Templates</button>
                        </div>
                      </div>
                    </form>
                  </div>
                `;
              })()}

              <!-- Sub-Panel 8.3: Recent Customer Notification Dispatch Logs -->
              <div data-admin-subpanel="compliance:notif-logs" style="display:none;">
                <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin:0 0 10px;">
                  <h3 style="font-family:var(--sn-font-serif);margin:0;font-size:1.1rem;color:var(--sn-bg-forest);">Recent Customer Notification Dispatch Logs (Section 8)</h3>
                  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <input type="search" id="sn-admin-notif-search" placeholder="Search order no., recipient, event, or subject..." class="sn-input" style="max-width:260px;padding:6px 10px;font-size:0.78rem;" />
                    <span id="sn-admin-notif-count-badge" class="sn-status sn-status-paid" style="font-family:var(--sn-font-mono);font-size:0.73rem;">Showing ${notificationLogs.length} of ${notificationLogs.length}</span>
                  </div>
                </div>
                <div class="sn-table-wrap">
                  <table class="sn-table" id="sn-admin-notif-logs-table">
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
                          <td style="font-size:0.8rem;"><strong>${escapeHtml(nl.subject)}</strong> - ${escapeHtml(nl.body_preview)}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
                <div id="sn-admin-notif-pagination" class="sn-admin-pagination-bar"></div>
              </div>
            </div>

            <!-- Panel 9: Storefront Content & SEO Manager (Homepage Hero/Footer, 6 Info Pages & Route SEO Meta + SERP Preview) -->
            <div class="sn-card" data-admin-panel="content" style="display:none;">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:14px;">
                <div>
                  <h2 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Storefront Non-Product Content, Policy Pages &amp; Route SEO Manager</h2>
                  <p style="font-size:0.86rem;color:var(--sn-text-secondary);margin:0;">
                    Authorized for <strong>SUPER_ADMIN</strong>. Edit homepage hero/topbar/footer copy, static info &amp; policy pages (<code>/about</code>, <code>/contact</code>, <code>/faq</code>, <code>/shipping-returns</code>, <code>/privacy</code>, <code>/terms</code>), and route-level SEO meta titles, descriptions &amp; OpenGraph cards. Every save is validated by the <code>humanizer-en</code> &amp; Wikidata Moratorium linter.
                  </p>
                </div>
                <a href="${basePath}/" target="_blank" rel="noopener" class="sn-btn sn-btn-outline sn-btn-sm">↗ Preview Live Storefront</a>
              </div>

              <!-- In-Panel Segmented Sub-Module Bar (Synced with Desktop Sidebar Accordion) -->
              <div class="sn-admin-subnav-bar" role="tablist">
                <button type="button" class="sn-admin-subtab-pill sn-active" data-admin-subtab-btn="content:homepage">🏠 9.1 Homepage Hero, Topbar &amp; Footer</button>
                <button type="button" class="sn-admin-subtab-pill" data-admin-subtab-btn="content:pages">📄 9.2 Info &amp; Policy Pages (6 Pages)</button>
                <button type="button" class="sn-admin-subtab-pill" data-admin-subtab-btn="content:seo">🔍 9.3 Route SEO Meta &amp; SERP Preview</button>
                <button type="button" class="sn-admin-subtab-pill" data-admin-subtab-btn="content:coupons" id="subtab-btn-content-coupons">🏷️ 9.4 Coupons, Promotions &amp; Hello Bar</button>
              </div>

              <!-- Sub-Panel 9.1 (Default): Homepage Hero, Regional Sourcing Bar, Topbar Badges & Footer Copy -->
              <div data-admin-subpanel="content:homepage">
                <form id="sn-admin-content-homepage-form" class="sn-card" style="background-color:var(--sn-bg-parchment);padding:16px 18px;">
                  <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1.1rem;color:var(--sn-bg-forest);">1. Topbar Announcement Badges &amp; Homepage Hero Copy</h3>

                  <div class="sn-grid-3" style="gap:10px;margin-bottom:12px;">
                    <div>
                      <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Topbar Badge 1 *</label>
                      <input type="text" name="topbarBadge1" required value="${escapeHtml(contentAndSeo.homepage.topbarBadge1)}" class="sn-input" />
                    </div>
                    <div>
                      <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Topbar Badge 2 *</label>
                      <input type="text" name="topbarBadge2" required value="${escapeHtml(contentAndSeo.homepage.topbarBadge2)}" class="sn-input" />
                    </div>
                    <div>
                      <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Topbar Badge 3 *</label>
                      <input type="text" name="topbarBadge3" required value="${escapeHtml(contentAndSeo.homepage.topbarBadge3)}" class="sn-input" />
                    </div>
                  </div>

                  <div class="sn-grid-2" style="gap:10px;margin-bottom:12px;">
                    <div>
                      <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Hero Pill Eyebrow Badge *</label>
                      <input type="text" name="heroEyebrow" required value="${escapeHtml(contentAndSeo.homepage.heroEyebrow)}" class="sn-input" />
                    </div>
                    <div>
                      <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Hero H1 Main Headline (Comma Splits Line 1 &amp; Line 2 Swoosh) *</label>
                      <input type="text" name="heroHeading" required value="${escapeHtml(contentAndSeo.homepage.heroHeading)}" class="sn-input" />
                    </div>
                  </div>

                  <div class="sn-grid-2" style="gap:10px;margin-bottom:12px;">
                    <div>
                      <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Hero Bold Lead Subheadline (Humanizer-Checked) *</label>
                      <textarea name="heroLead" rows="2" required class="sn-textarea">${escapeHtml(contentAndSeo.homepage.heroLead)}</textarea>
                    </div>
                    <div>
                      <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Hero Story Body Paragraph (Humanizer-Checked) *</label>
                      <textarea name="heroBodyText" rows="2" required class="sn-textarea">${escapeHtml(contentAndSeo.homepage.heroBodyText || '')}</textarea>
                    </div>
                  </div>

                  <div class="sn-grid-2" style="gap:10px;margin-bottom:12px;">
                    <div>
                      <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Golden Brush Ribbon Text *</label>
                      <input type="text" name="heroHighlightBanner" required value="${escapeHtml(contentAndSeo.homepage.heroHighlightBanner || 'Pure | Natural | Wholesome')}" class="sn-input" />
                    </div>
                    <div>
                      <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Pack Sizes Callout Line *</label>
                      <input type="text" name="heroPackSizesText" required value="${escapeHtml(contentAndSeo.homepage.heroPackSizesText || 'Available in convenient 100 g, 250 g, 500 g and 1 kg packs.')}" class="sn-input" />
                    </div>
                  </div>

                  <div class="sn-card" style="background-color:var(--sn-bg-surface);padding:12px 14px;margin-bottom:16px;border:1px solid var(--sn-border-strong);">
                    <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
                      <img
                        id="sn-admin-hero-img-preview"
                        src="${basePath}${escapeHtml(contentAndSeo.homepage.heroImageUrl || '/images/hero-pouch-spread.jpg')}"
                        alt="Homepage Hero Visual Preview"
                        style="width:128px;height:80px;object-fit:cover;border-radius:8px;border:1px solid var(--sn-border-strong);background-color:#F6EFE0;flex-shrink:0;"
                      />
                      <div style="flex:1;min-width:240px;">
                        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px;">
                          <strong style="font-size:0.84rem;color:var(--sn-bg-forest);display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;"><span>🖼️ Homepage Hero Right Visual Image (Upload New Photo or Edit Path)</span> ${renderImageSpecTooltip('hero')}</strong>
                          <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-admin-hero-img-reset-btn" style="padding:3px 10px;font-size:0.72rem;">↺ Reset to Default Pouch Spread</button>
                        </div>
                        <div class="sn-grid-2" style="gap:10px;align-items:end;">
                          <div>
                            <label for="sn-admin-hero-img-file" style="font-size:0.72rem;font-weight:700;display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px;"><span>Upload New Hero Image (JPEG / PNG / WebP)</span> ${renderImageSpecTooltip('hero')}</label>
                            <input type="file" name="heroImageFile" id="sn-admin-hero-img-file" accept="image/jpeg,image/png,image/webp" title="${escapeHtml(IMAGE_UPLOAD_SPECS.hero.summary)}" class="sn-input sn-file-input sn-file-input-sm" />
                          </div>
                          <div>
                            <label for="sn-admin-hero-img-url" style="font-size:0.72rem;font-weight:700;display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px;"><span>Active Hero Image Path *</span> ${renderImageSpecTooltip('hero')}</label>
                            <input type="text" name="heroImageUrl" id="sn-admin-hero-img-url" required value="${escapeHtml(contentAndSeo.homepage.heroImageUrl || '/images/hero-pouch-spread.jpg')}" title="${escapeHtml(IMAGE_UPLOAD_SPECS.hero.summary)}" class="sn-input" style="font-family:var(--sn-font-mono);font-size:0.78rem;" />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1.1rem;color:var(--sn-bg-forest);">2. Bottom 5-Region Sourcing Strip &amp; Global Footer Copy</h3>

                  <div class="sn-grid-3" style="gap:10px;margin-bottom:12px;">
                    <div class="sn-card" style="padding:10px 12px;background-color:var(--sn-bg-surface);">
                      <label style="font-size:0.72rem;font-weight:700;display:block;margin-bottom:3px;">Region 1 (Mountains Emblem) Title &amp; Specialty</label>
                      <input type="text" name="region1Title" required value="${escapeHtml(contentAndSeo.homepage.region1Title || 'Kashmir')}" class="sn-input" style="margin-bottom:6px;" />
                      <input type="text" name="region1Sub" required value="${escapeHtml(contentAndSeo.homepage.region1Sub || 'Dry Fruits')}" class="sn-input" />
                    </div>
                    <div class="sn-card" style="padding:10px 12px;background-color:var(--sn-bg-surface);">
                      <label style="font-size:0.72rem;font-weight:700;display:block;margin-bottom:3px;">Region 2 (Coastal Palm Emblem) Title &amp; Specialty</label>
                      <input type="text" name="region2Title" required value="${escapeHtml(contentAndSeo.homepage.region2Title || 'Goa')}" class="sn-input" style="margin-bottom:6px;" />
                      <input type="text" name="region2Sub" required value="${escapeHtml(contentAndSeo.homepage.region2Sub || 'Natural Produce')}" class="sn-input" />
                    </div>
                    <div class="sn-card" style="padding:10px 12px;background-color:var(--sn-bg-surface);">
                      <label style="font-size:0.72rem;font-weight:700;display:block;margin-bottom:3px;">Region 3 (Heritage Dome Emblem) Title &amp; Specialty</label>
                      <input type="text" name="region3Title" required value="${escapeHtml(contentAndSeo.homepage.region3Title || 'Karnataka')}" class="sn-input" style="margin-bottom:6px;" />
                      <input type="text" name="region3Sub" required value="${escapeHtml(contentAndSeo.homepage.region3Sub || 'Native Millets')}" class="sn-input" />
                    </div>
                    <div class="sn-card" style="padding:10px 12px;background-color:var(--sn-bg-surface);">
                      <label style="font-size:0.72rem;font-weight:700;display:block;margin-bottom:3px;">Region 4 (Coconut Palm Emblem) Title &amp; Specialty</label>
                      <input type="text" name="region4Title" required value="${escapeHtml(contentAndSeo.homepage.region4Title || 'Kerala')}" class="sn-input" style="margin-bottom:6px;" />
                      <input type="text" name="region4Sub" required value="${escapeHtml(contentAndSeo.homepage.region4Sub || 'Wholesome Ingredients')}" class="sn-input" />
                    </div>
                    <div class="sn-card" style="padding:10px 12px;background-color:var(--sn-bg-surface);">
                      <label style="font-size:0.72rem;font-weight:700;display:block;margin-bottom:3px;">Region 5 (Misty Hills Emblem) Title &amp; Specialty</label>
                      <input type="text" name="region5Title" required value="${escapeHtml(contentAndSeo.homepage.region5Title || 'Meghalaya')}" class="sn-input" style="margin-bottom:6px;" />
                      <input type="text" name="region5Sub" required value="${escapeHtml(contentAndSeo.homepage.region5Sub || 'Aromatic Spices')}" class="sn-input" />
                    </div>
                  </div>

                  <div class="sn-grid-3" style="gap:10px;margin-bottom:12px;">
                    <div class="sn-card" style="padding:10px 12px;background-color:var(--sn-bg-surface);">
                      <label style="font-size:0.72rem;font-weight:700;display:block;margin-bottom:3px;">Categories Section Eyebrow &amp; H2 *</label>
                      <input type="text" name="homeCategoriesEyebrow" required value="${escapeHtml(contentAndSeo.homepage.homeCategoriesEyebrow || 'The Sashya Pantry')}" class="sn-input" style="margin-bottom:6px;" />
                      <input type="text" name="homeCategoriesHeading" required value="${escapeHtml(contentAndSeo.homepage.homeCategoriesHeading || 'Explore Five Natural Collections')}" class="sn-input" />
                    </div>
                    <div class="sn-card" style="padding:10px 12px;background-color:var(--sn-bg-surface);">
                      <label style="font-size:0.72rem;font-weight:700;display:block;margin-bottom:3px;">Featured Section Eyebrow &amp; H2 *</label>
                      <input type="text" name="homeFeaturedEyebrow" required value="${escapeHtml(contentAndSeo.homepage.homeFeaturedEyebrow || 'Harvest Selection')}" class="sn-input" style="margin-bottom:6px;" />
                      <input type="text" name="homeFeaturedHeading" required value="${escapeHtml(contentAndSeo.homepage.homeFeaturedHeading || 'Featured Single-Origin Staples')}" class="sn-input" />
                    </div>
                    <div class="sn-card" style="padding:10px 12px;background-color:var(--sn-bg-surface);">
                      <label style="font-size:0.72rem;font-weight:700;display:block;margin-bottom:3px;">Bestsellers Section Eyebrow &amp; H2 *</label>
                      <input type="text" name="homeBestsellersEyebrow" required value="${escapeHtml(contentAndSeo.homepage.homeBestsellersEyebrow || 'Most Reordered')}" class="sn-input" style="margin-bottom:6px;" />
                      <input type="text" name="homeBestsellersHeading" required value="${escapeHtml(contentAndSeo.homepage.homeBestsellersHeading || 'Household Bestsellers')}" class="sn-input" />
                    </div>
                  </div>

                  <div class="sn-grid-3" style="gap:10px;margin-bottom:16px;">
                    <div>
                      <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Global Footer Brand Blurb *</label>
                      <input type="text" name="footerBlurb" required value="${escapeHtml(contentAndSeo.homepage.footerBlurb)}" class="sn-input" />
                    </div>
                    <div>
                      <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Global Footer Domain &amp; Support Line *</label>
                      <input type="text" name="footerSupportLine" required value="${escapeHtml(contentAndSeo.homepage.footerSupportLine)}" class="sn-input" />
                    </div>
                    <div>
                      <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Global Footer Copyright &amp; Compliance Line *</label>
                      <input type="text" name="footerCopyrightLine" required value="${escapeHtml(contentAndSeo.homepage.footerCopyrightLine || 'All prices in INR (₹) inclusive of GST • Verified India Pincode Delivery')}" class="sn-input" />
                    </div>
                  </div>

                  ${(() => {
                    const adminTestimonials =
                      Array.isArray(contentAndSeo.homepage.testimonialsList) && contentAndSeo.homepage.testimonialsList.length > 0
                        ? contentAndSeo.homepage.testimonialsList
                        : [
                            {
                              name: contentAndSeo.homepage.t1Name || 'Ananya Iyer',
                              location: contentAndSeo.homepage.t1Location || 'Indiranagar, Bengaluru',
                              rating: contentAndSeo.homepage.t1Rating || '5.0',
                              product: contentAndSeo.homepage.t1Product || 'Kashmiri Mamra Giri Almonds • 500 g Pack',
                              quote: contentAndSeo.homepage.t1Quote || ''
                            },
                            {
                              name: contentAndSeo.homepage.t2Name || 'Vikramaditya Rao',
                              location: contentAndSeo.homepage.t2Location || 'Bandra West, Mumbai',
                              rating: contentAndSeo.homepage.t2Rating || '5.0',
                              product: contentAndSeo.homepage.t2Product || 'Haveri Finger Millet (Ragi) • 1 kg Pack',
                              quote: contentAndSeo.homepage.t2Quote || ''
                            },
                            {
                              name: contentAndSeo.homepage.t3Name || 'Sneha Menon',
                              location: contentAndSeo.homepage.t3Location || 'Jubilee Hills, Hyderabad',
                              rating: contentAndSeo.homepage.t3Rating || '4.9',
                              product: contentAndSeo.homepage.t3Product || 'Meghalaya Lakadong Turmeric • 250 g Pack',
                              quote: contentAndSeo.homepage.t3Quote || ''
                            }
                          ];
                    const slidePagesCount = Math.max(1, Math.ceil(adminTestimonials.length / 3));
                    return `
                  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin:0 0 10px;">
                    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                      <h3 style="font-family:var(--sn-font-serif);margin:0;font-size:1.1rem;color:var(--sn-bg-forest);">3. Homepage Customer Testimonials Carousel (3-at-a-Time Slider Above Footer)</h3>
                      <span id="sn-admin-testimonials-count-badge" class="sn-status sn-status-paid" style="font-family:var(--sn-font-mono);font-size:0.72rem;">${adminTestimonials.length} Testimonials • ${slidePagesCount} Slider ${slidePagesCount === 1 ? 'Page' : 'Pages'} (3 per slide)</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                      <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-admin-add-testimonial-btn" style="font-weight:700;">+ Add Testimonial Card</button>
                      <label for="sn-admin-testimonials-enabled" style="font-size:0.74rem;font-weight:700;color:var(--sn-bg-forest);">Visibility:</label>
                      <select name="testimonialsEnabled" id="sn-admin-testimonials-enabled" class="sn-select" style="width:auto;min-width:215px;padding:5px 10px;font-size:0.78rem;">
                        <option value="1" ${contentAndSeo.homepage.testimonialsEnabled === '0' || contentAndSeo.homepage.testimonialsEnabled === false ? '' : 'selected'}>✓ Shown on Homepage Above Footer (1)</option>
                        <option value="0" ${contentAndSeo.homepage.testimonialsEnabled === '0' || contentAndSeo.homepage.testimonialsEnabled === false ? 'selected' : ''}>Hidden from Homepage (0)</option>
                      </select>
                    </div>
                  </div>

                  <div class="sn-grid-2" style="gap:10px;margin-bottom:12px;">
                    <div>
                      <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Testimonials Section Eyebrow *</label>
                      <input type="text" name="testimonialsEyebrow" required value="${escapeHtml(contentAndSeo.homepage.testimonialsEyebrow || 'Verified Indian Households • Repeat Pantry Orders')}" class="sn-input" />
                    </div>
                    <div>
                      <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Testimonials Section H2 Heading *</label>
                      <input type="text" name="testimonialsHeading" required value="${escapeHtml(contentAndSeo.homepage.testimonialsHeading || 'What Families Across India Say')}" class="sn-input" />
                    </div>
                  </div>

                  <div class="sn-grid-3" id="sn-admin-testimonials-list" style="gap:10px;margin-bottom:14px;">
                    ${adminTestimonials.map((tItem, idx) => {
                      const cardNum = idx + 1;
                      const slideNum = Math.floor(idx / 3) + 1;
                      return `
                    <div class="sn-card sn-admin-testimonial-editor-card" data-testimonial-editor-card="${cardNum}" style="padding:12px;background-color:var(--sn-bg-surface);">
                      <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:8px;">
                        <strong class="sn-admin-testimonial-card-title" style="font-size:0.79rem;color:var(--sn-bg-forest);">★ Testimonial #${cardNum} (Slide ${slideNum})</strong>
                        <button type="button" class="sn-btn sn-btn-outline sn-btn-sm sn-admin-remove-testimonial-btn" data-remove-testimonial-btn style="padding:2px 8px;font-size:0.68rem;color:#B42318;border-color:rgba(180,35,24,0.35);">✕ Remove</button>
                      </div>
                      <div class="sn-grid-2" style="gap:6px;margin-bottom:6px;">
                        <div>
                          <label style="font-size:0.7rem;font-weight:700;display:block;margin-bottom:2px;">Customer Name *</label>
                          <input type="text" name="t${cardNum}Name" data-t-field="name" required value="${escapeHtml(tItem.name || '')}" class="sn-input" />
                        </div>
                        <div>
                          <label style="font-size:0.7rem;font-weight:700;display:block;margin-bottom:2px;">Rating (1.0–5.0) *</label>
                          <input type="text" name="t${cardNum}Rating" data-t-field="rating" required value="${escapeHtml(tItem.rating || '5.0')}" class="sn-input" />
                        </div>
                      </div>
                      <label style="font-size:0.7rem;font-weight:700;display:block;margin-bottom:2px;">City &amp; Neighbourhood / State *</label>
                      <input type="text" name="t${cardNum}Location" data-t-field="location" required value="${escapeHtml(tItem.location || '')}" class="sn-input" style="margin-bottom:6px;" />
                      <label style="font-size:0.7rem;font-weight:700;display:block;margin-bottom:2px;">Purchased Product &amp; Pack Weight *</label>
                      <input type="text" name="t${cardNum}Product" data-t-field="product" required value="${escapeHtml(tItem.product || '')}" class="sn-input" style="margin-bottom:6px;" />
                      <label style="font-size:0.7rem;font-weight:700;display:block;margin-bottom:2px;">Customer Review Quote (Humanizer-Checked) *</label>
                      <textarea name="t${cardNum}Quote" data-t-field="quote" rows="3" required class="sn-textarea">${escapeHtml(tItem.quote || '')}</textarea>
                    </div>
                      `;
                    }).join('')}
                  </div>
                    `;
                  })()}

                  <div style="display:flex;justify-content:flex-end;">
                    <button type="submit" class="sn-btn sn-btn-forest" id="sn-save-homepage-content-btn">Save Homepage Hero, Testimonials &amp; Global Shell Copy</button>
                  </div>
                </form>
              </div>

              <!-- Sub-Panel 9.2: Static Info & Policy Pages Editor (About, Contact, FAQ, Shipping/Returns, Privacy, Terms, Shop, Checkout, Track Order, Account) -->
              <div data-admin-subpanel="content:pages" style="display:none;">
                <form id="sn-admin-content-page-form" class="sn-card" style="background-color:var(--sn-bg-parchment);padding:16px 18px;">
                  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px;">
                    <h3 style="font-family:var(--sn-font-serif);margin:0;font-size:1.1rem;color:var(--sn-bg-forest);">Edit Storefront Info, Functional &amp; Legal Policy Pages (HTML + Markdown Twin)</h3>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;">
                      <a id="sn-content-page-live-link" href="${basePath}/about" target="_blank" rel="noopener" class="sn-btn sn-btn-outline sn-btn-sm">↗ Open Live Page (/about)</a>
                      <a id="sn-content-page-md-link" href="${basePath}/about.md" target="_blank" rel="noopener" class="sn-btn sn-btn-outline sn-btn-sm">📄 View Markdown Twin (/about.md)</a>
                    </div>
                  </div>

                  <div class="sn-grid-3" style="gap:10px;margin-bottom:12px;">
                    <div>
                      <label for="sn-admin-content-page-select" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Select Storefront Page *</label>
                      <select name="slug" id="sn-admin-content-page-select" class="sn-select">
                        ${['about', 'contact', 'faq', 'shipping-returns', 'privacy', 'terms', 'shop', 'checkout', 'track-order', 'account'].map(slug => {
                          const pg = contentAndSeo.infoPages[slug] || { title: slug, subtitle: '', paragraphs: [] };
                          return `<option
                            value="${escapeHtml(slug)}"
                            data-page-title="${escapeHtml(pg.title)}"
                            data-page-subtitle="${escapeHtml(pg.subtitle)}"
                            data-page-paragraphs="${escapeHtml((pg.paragraphs || []).join('\n'))}"
                          >/${escapeHtml(slug)} — ${escapeHtml(pg.title)}</option>`;
                        }).join('')}
                      </select>
                    </div>
                    <div>
                      <label for="sn-content-page-title" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Page H1 Heading *</label>
                      <input type="text" name="title" id="sn-content-page-title" required value="${escapeHtml(contentAndSeo.infoPages.about.title)}" class="sn-input" />
                    </div>
                    <div>
                      <label for="sn-content-page-subtitle" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Subtitle / Eyebrow *</label>
                      <input type="text" name="subtitle" id="sn-content-page-subtitle" required value="${escapeHtml(contentAndSeo.infoPages.about.subtitle)}" class="sn-input" />
                    </div>
                  </div>

                  <div style="margin-bottom:14px;">
                    <label for="sn-content-page-paragraphs" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Page Body Paragraphs (One Paragraph per Line • For FAQ, include "?" to auto-render collapsible Q&amp;A accordions) *</label>
                    <textarea name="paragraphsText" id="sn-content-page-paragraphs" rows="5" required class="sn-textarea">${escapeHtml((contentAndSeo.infoPages.about.paragraphs || []).join('\n'))}</textarea>
                  </div>

                  <div style="display:flex;justify-content:flex-end;">
                    <button type="submit" class="sn-btn sn-btn-forest" id="sn-save-info-page-btn">Save Page Content &amp; Update Markdown Twin</button>
                  </div>
                </form>
              </div>

              <!-- Sub-Panel 9.3: Route SEO Meta Titles, Descriptions, OpenGraph & Live Google SERP Preview -->
              <div data-admin-subpanel="content:seo" style="display:none;">
                <form id="sn-admin-content-seo-form" class="sn-card" style="background-color:var(--sn-bg-parchment);padding:16px 18px;">
                  <h3 style="font-family:var(--sn-font-serif);margin:0 0 10px;font-size:1.1rem;color:var(--sn-bg-forest);">Route-Level SEO Meta Tags, OpenGraph &amp; Live Google SERP Preview</h3>

                  <div class="sn-grid-2" style="gap:10px;margin-bottom:12px;">
                    <div>
                      <label for="sn-admin-seo-route-select" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Target Storefront Route *</label>
                      <select name="routePath" id="sn-admin-seo-route-select" class="sn-select">
                        ${Object.entries(contentAndSeo.seoRoutes).map(([routePath, seoObj]) => `
                          <option
                            value="${escapeHtml(routePath)}"
                            data-seo-title="${escapeHtml(seoObj.metaTitle)}"
                            data-seo-desc="${escapeHtml(seoObj.metaDescription)}"
                            data-seo-og="${escapeHtml(seoObj.ogImagePath)}"
                          >${escapeHtml(seoObj.label)}</option>
                        `).join('')}
                      </select>
                    </div>
                    <div>
                      <label for="sn-seo-og-image" style="font-size:0.73rem;font-weight:700;display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px;"><span>OpenGraph Social Share Image Path (<code>og:image</code>) *</span> ${renderImageSpecTooltip('opengraph')}</label>
                      <input type="text" name="ogImagePath" id="sn-seo-og-image" required value="${escapeHtml(contentAndSeo.seoRoutes['/'].ogImagePath)}" title="${escapeHtml(IMAGE_UPLOAD_SPECS.opengraph.summary)}" class="sn-input" style="font-family:var(--sn-font-mono);" />
                    </div>
                  </div>

                  <div style="margin-bottom:12px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
                      <label for="sn-seo-meta-title" style="font-size:0.73rem;font-weight:700;">SEO Meta Title (<code>&lt;title&gt;</code> &amp; <code>og:title</code>) *</label>
                      <span id="sn-seo-title-char-count" style="font-family:var(--sn-font-mono);font-size:0.72rem;color:var(--sn-bg-forest);">${contentAndSeo.seoRoutes['/'].metaTitle.length} chars (Optimal: 50–65)</span>
                    </div>
                    <input type="text" name="metaTitle" id="sn-seo-meta-title" required value="${escapeHtml(contentAndSeo.seoRoutes['/'].metaTitle)}" class="sn-input" />
                  </div>

                  <div style="margin-bottom:14px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
                      <label for="sn-seo-meta-desc" style="font-size:0.73rem;font-weight:700;">SEO Meta Description (<code>&lt;meta name="description"&gt;</code> &amp; <code>og:description</code>) *</label>
                      <span id="sn-seo-desc-char-count" style="font-family:var(--sn-font-mono);font-size:0.72rem;color:var(--sn-bg-forest);">${contentAndSeo.seoRoutes['/'].metaDescription.length} chars (Optimal: 120–160)</span>
                    </div>
                    <textarea name="metaDescription" id="sn-seo-meta-desc" rows="2" required class="sn-textarea">${escapeHtml(contentAndSeo.seoRoutes['/'].metaDescription)}</textarea>
                  </div>

                  <!-- Live Google SERP Snippet Preview -->
                  <div class="sn-card" id="sn-admin-seo-serp-preview" style="background-color:#FFFFFF;border:1px solid var(--sn-border-strong);padding:14px 16px;margin-bottom:14px;">
                    <div style="font-family:var(--sn-font-mono);font-size:0.7rem;color:var(--sn-text-muted);text-transform:uppercase;margin-bottom:6px;">🔍 Live Google Search &amp; OpenGraph Snippet Preview</div>
                    <div id="sn-serp-preview-url" style="font-size:0.78rem;color:#202124;font-family:var(--sn-font-sans);margin-bottom:2px;">https://sashyanaturals.com/</div>
                    <div id="sn-serp-preview-title" style="font-size:1.12rem;color:#1a0dab;font-weight:600;line-height:1.3;margin-bottom:4px;">${escapeHtml(contentAndSeo.seoRoutes['/'].metaTitle)}</div>
                    <div id="sn-serp-preview-desc" style="font-size:0.84rem;color:#4d5156;line-height:1.45;">${escapeHtml(contentAndSeo.seoRoutes['/'].metaDescription)}</div>
                  </div>

                  <div style="display:flex;justify-content:flex-end;">
                    <button type="submit" class="sn-btn sn-btn-forest" id="sn-save-route-seo-btn">Save Route SEO Meta &amp; OpenGraph Tags</button>
                  </div>
                </form>
              </div>

              <!-- Sub-Panel 9.4: Promotional Coupons Engine (Universal, Once-Per-Customer, Single-Use, IST Time Window) & Hello Bar Controller -->
              ${(() => {
                const enrichedCoupons = listEnrichedCoupons();
                const hb = contentAndSeo.helloBar;
                const shipCopyAdmin = getDynamicShippingCopy();
                const hbPreview = resolveHelloBarForRender(hb, shipCopyAdmin);
                const statusBadgeMap = {
                  ACTIVE: { cls: 'sn-status-paid', label: '🟢 ACTIVE' },
                  SCHEDULED: { cls: 'sn-status-warn', label: '🕒 SCHEDULED' },
                  EXPIRED: { cls: 'sn-status-danger', label: '🔴 EXPIRED' },
                  LIMIT_REACHED: { cls: 'sn-status-danger', label: '🛑 LIMIT REACHED' },
                  PAUSED: { cls: 'sn-status-warn', label: '⚪ PAUSED' }
                };
                const usageTypeLabelMap = {
                  UNIVERSAL: 'Universal Campaign',
                  ONCE_PER_CUSTOMER: '1× Per Customer (Phone + Email)',
                  SINGLE_USE_GLOBAL: '1× Global Single-Use'
                };
                return `
              <div data-admin-subpanel="content:coupons" style="display:none;">
                <!-- 1. Storefront Hello Bar (.sn-topbar) Announcement & Auto-Disappear Controller -->
                <form id="sn-admin-hellobar-form" class="sn-card" style="background-color:var(--sn-bg-parchment);padding:16px 18px;margin-bottom:20px;">
                  <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;margin-bottom:12px;">
                    <div>
                      <span class="sn-eyebrow" style="margin:0;">Global Top Announcement Bar (.sn-topbar)</span>
                      <h3 style="font-family:var(--sn-font-serif);margin:2px 0 4px;font-size:1.12rem;color:var(--sn-bg-forest);">1. Storefront Hello Bar Content &amp; Auto-Disappear Controller</h3>
                      <p style="font-size:0.8rem;color:var(--sn-text-secondary);margin:0;">
                        Control the entire content of the top Hello Bar. Use <code>{{SHIPPING_POLICY}}</code> to inject the live 4-Zone shipping threshold automatically, or type any 100% custom message. <strong>If the announcement text is cleared (empty) or disabled, the entire Hello Bar disappears (<code>0px</code> height).</strong>
                      </p>
                    </div>
                    <label style="display:inline-flex;align-items:center;gap:8px;font-family:var(--sn-font-mono);font-size:0.78rem;font-weight:700;background-color:var(--sn-bg-surface);padding:8px 12px;border-radius:6px;border:1px solid var(--sn-border-strong);cursor:pointer;">
                      <input type="checkbox" name="enabled" id="sn-admin-hellobar-enabled" value="1" ${hb.enabled ? 'checked' : ''} />
                      <span>Hello Bar Enabled</span>
                    </label>
                  </div>

                  <div style="margin-bottom:12px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:4px;">
                      <label for="sn-admin-hellobar-text" style="font-size:0.74rem;font-weight:700;">Hello Bar Announcement Content (Leave blank to hide Hello Bar completely)</label>
                      <div style="display:flex;gap:6px;flex-wrap:wrap;">
                        <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-hellobar-insert-shipping-btn" style="padding:2px 8px;min-height:26px;font-size:0.71rem;">+ Insert {{SHIPPING_POLICY}}</button>
                        <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-hellobar-clear-text-btn" style="padding:2px 8px;min-height:26px;font-size:0.71rem;color:var(--sn-status-danger);">✕ Clear Text (Hide Hello Bar)</button>
                      </div>
                    </div>
                    <input
                      type="text"
                      name="templateText"
                      id="sn-admin-hellobar-text"
                      value="${escapeHtml(hb.templateText)}"
                      placeholder="e.g. {{SHIPPING_POLICY}} | Use code SASHYA10 for 10% off (or leave empty to hide Hello Bar)"
                      data-shipping-clause-preview="${escapeHtml(shipCopyAdmin.shippingPolicyClause)}"
                      class="sn-input"
                    />
                  </div>

                  <div class="sn-grid-2" style="gap:10px;margin-bottom:12px;">
                    <div>
                      <label for="sn-admin-hellobar-linked-coupon" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Linked Coupon Circuit-Breaker (Prevents advertising expired/exhausted codes)</label>
                      <select name="linkedCouponCode" id="sn-admin-hellobar-linked-coupon" class="sn-select">
                        <option value="" ${!hb.linkedCouponCode ? 'selected' : ''}>None (No Linked Coupon Check)</option>
                        ${enrichedCoupons.map(c => `
                          <option value="${escapeHtml(c.code)}" data-coupon-status="${escapeHtml(c.computed_status)}" ${hb.linkedCouponCode === c.code ? 'selected' : ''}>
                            ${escapeHtml(c.code)} (${escapeHtml(c.computed_status)} • ${escapeHtml(c.description)})
                          </option>
                        `).join('')}
                      </select>
                    </div>
                    <div>
                      <label for="sn-admin-hellobar-expired-behavior" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">If Linked Coupon Expires, Hits Limit, or Is Paused</label>
                      <select name="expiredCouponBehavior" id="sn-admin-hellobar-expired-behavior" class="sn-select">
                        <option value="STRIP_COUPON_CLAUSE" ${hb.expiredCouponBehavior === 'STRIP_COUPON_CLAUSE' ? 'selected' : ''}>Strip Coupon Clause ("| Use code ...") &amp; Keep Shipping Text</option>
                        <option value="HIDE_BAR" ${hb.expiredCouponBehavior === 'HIDE_BAR' ? 'selected' : ''}>Hide Entire Hello Bar Automatically</option>
                      </select>
                    </div>
                  </div>

                  <div class="sn-grid-3" style="gap:10px;margin-bottom:14px;">
                    <div>
                      <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Desktop Right Badge 1 (Optional)</label>
                      <input type="text" name="topbarBadge1" id="sn-admin-hellobar-badge1" value="${escapeHtml(hb.topbarBadge1)}" placeholder="Leave blank to hide badge" class="sn-input" />
                    </div>
                    <div>
                      <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Desktop Right Badge 2 (Optional)</label>
                      <input type="text" name="topbarBadge2" id="sn-admin-hellobar-badge2" value="${escapeHtml(hb.topbarBadge2)}" placeholder="Leave blank to hide badge" class="sn-input" />
                    </div>
                    <div>
                      <label style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Desktop Right Badge 3 (Optional)</label>
                      <input type="text" name="topbarBadge3" id="sn-admin-hellobar-badge3" value="${escapeHtml(hb.topbarBadge3)}" placeholder="Leave blank to hide badge" class="sn-input" />
                    </div>
                  </div>

                  <!-- Live Hello Bar Preview -->
                  <div style="margin-bottom:14px;">
                    <div style="font-family:var(--sn-font-mono);font-size:0.71rem;color:var(--sn-text-muted);text-transform:uppercase;margin-bottom:4px;">Live Storefront Hello Bar Preview</div>
                    <div
                      id="sn-admin-hellobar-live-preview"
                      style="border-radius:6px;padding:10px 14px;font-size:0.8rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;${hbPreview.visible ? 'background-color:var(--sn-bg-forest);color:#FAF5E4;' : 'background-color:var(--sn-bg-surface);color:var(--sn-text-muted);border:1px dashed var(--sn-border-strong);'}"
                    >
                      ${hbPreview.visible ? `
                        <span>${hbPreview.announcementHtml}</span>
                        <span style="font-family:var(--sn-font-mono);font-size:0.72rem;opacity:0.88;">${hbPreview.badges.map(b => escapeHtml(b)).join(' • ')}</span>
                      ` : `
                        <span>🚫 Hello Bar Hidden (0px height — disappears completely on storefront)</span>
                      `}
                    </div>
                  </div>

                  <div style="display:flex;justify-content:flex-end;">
                    <button type="submit" class="sn-btn sn-btn-forest" id="sn-save-hellobar-btn">Save Hello Bar Configuration</button>
                  </div>
                </form>

                <!-- 2. Create / Edit Coupon Code Form (Universal, Once-Per-Customer, Single-Use Global & IST Time Window) -->
                <form id="sn-admin-coupon-form" class="sn-card" style="background-color:var(--sn-bg-parchment);padding:16px 18px;margin-bottom:20px;">
                  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px;">
                    <div>
                      <span class="sn-eyebrow" style="margin:0;">Promotional Discount Engine • IST (UTC+05:30) Time Window &amp; Zero-Burn Order Tracking</span>
                      <h3 style="font-family:var(--sn-font-serif);margin:2px 0 0;font-size:1.12rem;color:var(--sn-bg-forest);" id="sn-admin-coupon-form-heading">2. Create or Edit Coupon Code</h3>
                    </div>
                    <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" id="sn-coupon-reset-btn">+ New Coupon / Reset Form</button>
                  </div>

                  <div class="sn-grid-4" style="gap:10px;margin-bottom:12px;">
                    <div>
                      <label for="sn-coupon-code" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Coupon Code (A-Z, 0-9) *</label>
                      <input type="text" name="code" id="sn-coupon-code" required maxlength="24" placeholder="e.g. DIWALI20" class="sn-input" style="font-family:var(--sn-font-mono);text-transform:uppercase;" />
                    </div>
                    <div style="grid-column:span 2;">
                      <label for="sn-coupon-description" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Customer-Facing Description *</label>
                      <input type="text" name="description" id="sn-coupon-description" required placeholder="e.g. 20% off festive harvest orders above Rs. 999" class="sn-input" />
                    </div>
                    <div>
                      <label for="sn-coupon-visibility" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Storefront Visibility *</label>
                      <select name="visibility" id="sn-coupon-visibility" class="sn-select">
                        <option value="PUBLIC_CHIP">Public Chip (Shown at Checkout &amp; Cart)</option>
                        <option value="SECRET_CODE">Secret Code (Hidden Chip • Works When Typed)</option>
                      </select>
                    </div>
                  </div>

                  <div class="sn-grid-4" style="gap:10px;margin-bottom:12px;">
                    <div>
                      <label for="sn-coupon-discount-type" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Discount Type *</label>
                      <select name="discountType" id="sn-coupon-discount-type" class="sn-select">
                        <option value="PERCENT">Percentage Off (%)</option>
                        <option value="FLAT_PAISE">Flat Rupee Discount (₹)</option>
                      </select>
                    </div>
                    <div>
                      <label for="sn-coupon-discount-val" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;" id="sn-coupon-discount-val-label">Discount Value (% or ₹) *</label>
                      <input type="number" name="discountValueInr" id="sn-coupon-discount-val" required min="1" max="5000" value="10" class="sn-input" style="font-family:var(--sn-font-mono);" />
                    </div>
                    <div>
                      <label for="sn-coupon-min-order" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Min Order Subtotal (₹) *</label>
                      <input type="number" name="minOrderInr" id="sn-coupon-min-order" required min="0" max="100000" value="499" class="sn-input" style="font-family:var(--sn-font-mono);" />
                    </div>
                    <div>
                      <label for="sn-coupon-max-discount" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Max Discount Cap (₹) *</label>
                      <input type="number" name="maxDiscountInr" id="sn-coupon-max-discount" required min="0" max="50000" value="500" class="sn-input" style="font-family:var(--sn-font-mono);" />
                    </div>
                  </div>

                  <div class="sn-grid-3" style="gap:10px;margin-bottom:12px;">
                    <div>
                      <label for="sn-coupon-usage-type" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Usage Limit Rule *</label>
                      <select name="usageType" id="sn-coupon-usage-type" class="sn-select">
                        <option value="UNIVERSAL">Universal Code (Unlimited or Total Campaign Cap)</option>
                        <option value="ONCE_PER_CUSTOMER">One-Time Per Customer (Validated by Phone + Email)</option>
                        <option value="SINGLE_USE_GLOBAL">Single-Use Global Code (1 Total Redemption Across Store)</option>
                      </select>
                    </div>
                    <div>
                      <label for="sn-coupon-max-total" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Total Store Redemptions Cap (0 = Unlimited)</label>
                      <input type="number" name="maxTotalUses" id="sn-coupon-max-total" min="0" max="1000000" value="0" class="sn-input" style="font-family:var(--sn-font-mono);" />
                    </div>
                    <div>
                      <label for="sn-coupon-max-per-customer" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Max Uses Per Customer (0 = Unlimited)</label>
                      <input type="number" name="maxUsesPerCustomer" id="sn-coupon-max-per-customer" min="0" max="100" value="0" class="sn-input" style="font-family:var(--sn-font-mono);" />
                    </div>
                  </div>

                  <div class="sn-grid-3" style="gap:10px;margin-bottom:14px;align-items:end;">
                    <div>
                      <label for="sn-coupon-starts-ist" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Valid From (IST • Optional Schedule Start)</label>
                      <input type="datetime-local" name="startsAtIst" id="sn-coupon-starts-ist" value="" class="sn-input" style="font-family:var(--sn-font-mono);" />
                    </div>
                    <div>
                      <label for="sn-coupon-expires-ist" style="font-size:0.73rem;font-weight:700;display:block;margin-bottom:3px;">Valid Until / Expiry (IST • Optional Auto-Expire)</label>
                      <input type="datetime-local" name="expiresAtIst" id="sn-coupon-expires-ist" value="" class="sn-input" style="font-family:var(--sn-font-mono);" />
                    </div>
                    <div style="display:flex;gap:14px;flex-wrap:wrap;padding-bottom:6px;">
                      <label style="display:inline-flex;align-items:center;gap:6px;font-size:0.78rem;font-weight:600;cursor:pointer;">
                        <input type="checkbox" name="isAutoApply" id="sn-coupon-auto-apply" value="1" />
                        <span>Auto-Prefill at Checkout</span>
                      </label>
                      <label style="display:inline-flex;align-items:center;gap:6px;font-size:0.78rem;font-weight:600;cursor:pointer;">
                        <input type="checkbox" name="isActive" id="sn-coupon-is-active" value="1" checked />
                        <span>Coupon Active</span>
                      </label>
                    </div>
                  </div>

                  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
                    <span style="font-family:var(--sn-font-mono);font-size:0.72rem;color:var(--sn-text-muted);">
                      Zero-Burn Protection: Abandoned Razorpay popups (<code>PENDING_PAYMENT</code>) &amp; Cancelled/Refunded orders never consume a customer's one-time coupon.
                    </span>
                    <button type="submit" class="sn-btn sn-btn-forest" id="sn-save-coupon-btn">Save Coupon Code</button>
                  </div>
                </form>

                <!-- 3. Active, Scheduled & Expired Coupons Ledger Table -->
                <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:10px;">
                  <h3 style="font-family:var(--sn-font-serif);margin:0;font-size:1.1rem;color:var(--sn-bg-forest);">3. Promotional Coupons Ledger (${enrichedCoupons.length} Codes)</h3>
                  <span style="font-family:var(--sn-font-mono);font-size:0.73rem;color:var(--sn-text-muted);">Evaluated in Indian Standard Time (IST • UTC+05:30)</span>
                </div>

                <div class="sn-table-wrap">
                  <table class="sn-table sn-table-cards" id="sn-admin-coupons-table">
                    <thead>
                      <tr>
                        <th>Code &amp; Description</th>
                        <th>Discount &amp; Min Order</th>
                        <th>Usage Rule &amp; Redemptions</th>
                        <th>IST Schedule Window</th>
                        <th>Visibility &amp; Status</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${enrichedCoupons.map(c => {
                        const badge = statusBadgeMap[c.computed_status] || { cls: 'sn-status-warn', label: c.computed_status };
                        const discLabel = c.discount_type === 'PERCENT'
                          ? `${c.discount_value}% OFF (Cap ${formatInr(c.max_discount_paise)})`
                          : `Flat ${formatInr(c.discount_value)} OFF`;
                        const totalCapLabel = c.effective_max_total_uses > 0 ? `${c.total_used} / ${c.effective_max_total_uses} used` : `${c.total_used} / ∞ used`;
                        const custCapLabel = c.effective_max_uses_per_customer > 0 ? `Max ${c.effective_max_uses_per_customer}/customer` : 'Unlimited/customer';
                        const windowLabel = (c.starts_at_ist || c.expires_at_ist)
                          ? `${c.starts_at_ist ? `From: ${c.starts_at_ist.replace('T', ' ')}` : 'From: Any'}${c.expires_at_ist ? `<br/>Until: ${c.expires_at_ist.replace('T', ' ')}` : ''}`
                          : 'Always Valid (No Expiry)';
                        return `
                          <tr data-admin-coupon-row="${escapeHtml(c.code)}">
                            <td data-label="Code &amp; Description">
                              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                                <strong style="font-family:var(--sn-font-mono);font-size:0.9rem;color:var(--sn-bg-forest);">${escapeHtml(c.code)}</strong>
                                ${c.is_auto_apply ? '<span class="sn-status sn-status-paid" style="font-size:0.66rem;padding:1px 6px;">★ Auto-Prefill</span>' : ''}
                              </div>
                              <div style="font-size:0.78rem;color:var(--sn-text-secondary);margin-top:2px;">${escapeHtml(c.description)}</div>
                            </td>
                            <td data-label="Discount &amp; Min Order" style="font-family:var(--sn-font-mono);font-size:0.77rem;">
                              <strong>${escapeHtml(discLabel)}</strong><br/>
                              <span style="color:var(--sn-text-muted);">Min Subtotal: ${formatInr(c.min_order_paise)}</span>
                            </td>
                            <td data-label="Usage Rule &amp; Redemptions" style="font-family:var(--sn-font-mono);font-size:0.76rem;">
                              <strong>${escapeHtml(usageTypeLabelMap[c.usage_type] || c.usage_type)}</strong><br/>
                              <span>${escapeHtml(totalCapLabel)} • ${escapeHtml(custCapLabel)}</span>
                            </td>
                            <td data-label="IST Time Window" style="font-family:var(--sn-font-mono);font-size:0.74rem;">
                              ${windowLabel}
                            </td>
                            <td data-label="Visibility &amp; Status">
                              <span class="sn-status ${badge.cls}">${escapeHtml(badge.label)}</span><br/>
                              <span style="font-family:var(--sn-font-mono);font-size:0.7rem;color:var(--sn-text-muted);margin-top:3px;display:inline-block;">
                                ${c.visibility === 'SECRET_CODE' ? '🔒 Secret Code' : '🏷️ Public Chip'}
                              </span>
                            </td>
                            <td data-label="Actions">
                              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                                <button
                                  type="button"
                                  class="sn-btn sn-btn-outline sn-btn-sm"
                                  data-edit-coupon="${escapeHtml(JSON.stringify(c))}"
                                >✏️ Edit</button>
                                <button
                                  type="button"
                                  class="sn-btn sn-btn-outline sn-btn-sm"
                                  data-toggle-coupon="${escapeHtml(c.code)}"
                                  data-next-active="${c.is_active ? '0' : '1'}"
                                >${c.is_active ? '⏸ Pause' : '▶ Activate'}</button>
                                <button
                                  type="button"
                                  class="sn-btn sn-btn-outline sn-btn-sm"
                                  style="color:var(--sn-status-danger);"
                                  data-delete-coupon="${escapeHtml(c.code)}"
                                >🗑 Delete</button>
                              </div>
                            </td>
                          </tr>
                        `;
                      }).join('')}
                    </tbody>
                  </table>
                </div>
              </div>
                `;
              })()}
            </div>
          </div>
        </div>
      </div>
      <script>(function(){try{var sub=sessionStorage.getItem('sn_admin_active_subtab'),mod=sessionStorage.getItem('sn_admin_active_module');if(sub&&sub.indexOf(':')>0)mod=sub.split(':')[0];if(!mod)return;var btn=document.querySelector('[data-admin-tab-btn="'+mod+'"]');if(!btn)return;var li=btn.closest('li');if(li&&li.style.display==='none')return;document.querySelectorAll('[data-admin-tab-btn]').forEach(function(b){b.classList.toggle('sn-active',b.getAttribute('data-admin-tab-btn')===mod)});document.querySelectorAll('[data-admin-submenu-for]').forEach(function(u){u.classList.toggle('sn-submenu-open',u.getAttribute('data-admin-submenu-for')===mod)});document.querySelectorAll('[data-admin-panel]').forEach(function(p){p.style.display=p.getAttribute('data-admin-panel')===mod?'block':'none'});if(sub&&document.querySelector('[data-admin-subpanel="'+sub+'"]')){document.querySelectorAll('[data-admin-subpanel^="'+mod+':"]').forEach(function(sp){sp.style.display=sp.getAttribute('data-admin-subpanel')===sub?'block':'none'});document.querySelectorAll('[data-admin-subtab-btn^="'+mod+':"]').forEach(function(pl){pl.classList.toggle('sn-active',pl.getAttribute('data-admin-subtab-btn')===sub)});document.querySelectorAll('[data-admin-subtab-link^="'+mod+':"]').forEach(function(sb){sb.classList.toggle('sn-sub-active',sb.getAttribute('data-admin-subtab-link')===sub)})}}catch(e){}})();</script>
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
  const breadcrumbs = [{ name: 'Home', url: '/' }, { name: title, url: canonicalPath }];
  const usedIds = new Set();

  let parsedFaqBlocks = [];
  let faqItems = [];
  let parsedPolicyBlocks = [];
  let sectionBookmarks = [];

  if (slug === 'faq') {
    parsedFaqBlocks = paragraphs.map((p, idx) => {
      if (p.includes('?')) {
        const qIdx = p.indexOf('?');
        const q = p.slice(0, qIdx + 1).trim();
        const a = p.slice(qIdx + 1).trim();
        const id = slugifyBookmarkId(q, 'faq', usedIds);
        return {
          isFaq: true,
          id,
          question: q,
          answer: a,
          shortLabel: q.length > 38 ? `${q.slice(0, 35)}...` : q
        };
      }
      const id = slugifyBookmarkId(`note-${idx + 1}`, 'faq', usedIds);
      return {
        isFaq: false,
        id,
        text: p,
        shortLabel: `FAQ Note ${idx + 1}`
      };
    });
    faqItems = parsedFaqBlocks.filter(b => b.isFaq);
    sectionBookmarks = [
      ...parsedFaqBlocks.map(b => ({
        id: b.id,
        name: b.isFaq ? b.question : b.shortLabel,
        shortLabel: b.shortLabel
      })),
      { id: 'faq-support-desk', name: 'Bengaluru Pantry Care Desk', shortLabel: 'Care Desk' }
    ];
  } else {
    parsedPolicyBlocks = paragraphs.map((p, idx) => {
      const id = `section-${idx + 1}`;
      usedIds.add(id);
      const firstClause = p.split('.')[0].trim();
      const shortLabel = firstClause.length > 32
        ? `Section ${idx + 1}: ${firstClause.slice(0, 26)}...`
        : `Section ${idx + 1}: ${firstClause}`;
      return {
        id,
        heading: `Section ${idx + 1}`,
        text: p,
        shortLabel
      };
    });
    sectionBookmarks = parsedPolicyBlocks.map(b => ({
      id: b.id,
      name: `${title} - ${b.heading}`,
      shortLabel: b.shortLabel
    }));
    if (slug === 'shipping-returns') {
      sectionBookmarks.push({
        id: 'zone-rate-card',
        name: '4-Zone + 500g Weight-Slab Courier Rate Card',
        shortLabel: '4-Zone Rate Card'
      });
    } else if (slug === 'contact') {
      sectionBookmarks.push({
        id: 'support-channels',
        name: 'Email Care & Bengaluru Dispatch Hub',
        shortLabel: 'Support Channels'
      });
    }
  }

  const schemaGraph = buildMasterSchemaGraph({
    pageType: slug === 'faq' && faqItems.length > 0 ? 'faq' : 'webpage',
    canonicalPath,
    title: `${title} | ${BRAND_NAME}`,
    description,
    breadcrumbs,
    faqItems,
    sectionBookmarks
  });

  let extraSectionHtml = '';
  if (slug === 'shipping-returns') {
    const pol = getShippingPolicyFromDb();
    const zA = pol.zones && pol.zones.A ? pol.zones.A : { base500gPaise: 4000, extra500gPaise: 1500 };
    const zB = pol.zones && pol.zones.B ? pol.zones.B : { base500gPaise: 5500, extra500gPaise: 2500 };
    const zC = pol.zones && pol.zones.C ? pol.zones.C : { base500gPaise: 7500, extra500gPaise: 3500 };
    const zD = pol.zones && pol.zones.D ? pol.zones.D : { base500gPaise: 11000, extra500gPaise: 5500 };
    extraSectionHtml = `
      <div class="sn-card" id="zone-rate-card" style="margin-top:20px;background-color:var(--sn-bg-parchment);">
        <h2 style="font-family:var(--sn-font-serif);font-size:1.3rem;margin:0 0 12px;color:var(--sn-bg-forest);">4-Zone + 500g Weight-Slab Courier Rate Card${renderHeadingAnchor('zone-rate-card', '4-Zone + 500g Weight-Slab Courier Rate Card')}</h2>
        <div class="sn-table-wrap">
          <table class="sn-table sn-table-cards">
            <thead>
              <tr><th>Delivery Zone</th><th>PIN Code Coverage</th><th>Base 500g Slab</th><th>Each Additional 500g</th><th>Estimated Transit</th></tr>
            </thead>
            <tbody>
              <tr><td data-label="Delivery Zone"><strong>Zone A (Local Bengaluru)</strong></td><td data-label="PIN Coverage" style="font-family:var(--sn-font-mono);">560xxx</td><td data-label="Base 500g Slab" style="font-family:var(--sn-font-mono);">${formatInr(zA.base500gPaise)}</td><td data-label="Each Addl. 500g" style="font-family:var(--sn-font-mono);">+${formatInr(zA.extra500gPaise)}</td><td data-label="Estimated Transit">1 to 2 Business Days</td></tr>
              <tr><td data-label="Delivery Zone"><strong>Zone B (South India)</strong></td><td data-label="PIN Coverage" style="font-family:var(--sn-font-mono);">Karnataka, TN, Kerala, AP, Telangana</td><td data-label="Base 500g Slab" style="font-family:var(--sn-font-mono);">${formatInr(zB.base500gPaise)}</td><td data-label="Each Addl. 500g" style="font-family:var(--sn-font-mono);">+${formatInr(zB.extra500gPaise)}</td><td data-label="Estimated Transit">2 to 4 Business Days</td></tr>
              <tr><td data-label="Delivery Zone"><strong>Zone C (Rest of India)</strong></td><td data-label="PIN Coverage" style="font-family:var(--sn-font-mono);">MH, DL, GJ, RJ, UP, WB, MP &amp; Metros</td><td data-label="Base 500g Slab" style="font-family:var(--sn-font-mono);">${formatInr(zC.base500gPaise)}</td><td data-label="Each Addl. 500g" style="font-family:var(--sn-font-mono);">+${formatInr(zC.extra500gPaise)}</td><td data-label="Estimated Transit">3 to 5 Business Days</td></tr>
              <tr><td data-label="Delivery Zone"><strong>Zone D (NE / J&amp;K / Remote)</strong></td><td data-label="PIN Coverage" style="font-family:var(--sn-font-mono);">18xxxx, 19xxxx, 78xxxx, 79xxxx</td><td data-label="Base 500g Slab" style="font-family:var(--sn-font-mono);">${formatInr(zD.base500gPaise)}</td><td data-label="Each Addl. 500g" style="font-family:var(--sn-font-mono);">+${formatInr(zD.extra500gPaise)}</td><td data-label="Estimated Transit">5 to 7 Business Days</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  } else if (slug === 'contact') {
    const db = getDb();
    const rawSettings = db.prepare(`
      SELECT key, value FROM store_settings
      WHERE key IN ('support_email', 'registered_address')
    `).all();
    const sMap = {};
    for (const r of rawSettings) sMap[r.key] = r.value;
    const supportEmail = sMap.support_email || 'support@sashyanaturals.com';
    const registeredAddress = sMap.registered_address || 'No. 48, 100 Feet Road, Indiranagar, Bengaluru, Karnataka - 560038';
    extraSectionHtml = `
      <div class="sn-grid-2" id="support-channels" style="margin-top:20px;gap:16px;">
        <div class="sn-card" id="contact-email-care" style="background-color:var(--sn-bg-parchment);">
          <span class="sn-eyebrow">Order &amp; Bulk Enquiries</span>
          <h3 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Email Customer Care${renderHeadingAnchor('contact-email-care', 'Email Customer Care')}</h3>
          <p style="font-size:0.88rem;color:var(--sn-text-secondary);margin:0;">${escapeHtml(supportEmail)}<br/>Responses within 4 business hours</p>
        </div>
        <div class="sn-card" id="contact-dispatch-hub" style="background-color:var(--sn-bg-parchment);">
          <span class="sn-eyebrow">Bengaluru Dispatch Hub</span>
          <h3 style="font-family:var(--sn-font-serif);margin:0 0 6px;color:var(--sn-bg-forest);">Registered Pantry Office${renderHeadingAnchor('contact-dispatch-hub', 'Registered Pantry Office')}</h3>
          <p style="font-size:0.88rem;color:var(--sn-text-secondary);margin:0;">${escapeHtml(registeredAddress)}</p>
        </div>
      </div>
    `;
  }

  const bodyHtml = `
    <section class="sn-section">
      <div class="sn-container" style="max-width:920px;">
        ${renderBreadcrumbNav(breadcrumbs, basePath)}
        ${renderSectionJumpBar(sectionBookmarks, slug === 'faq' ? 'Jump to Question:' : 'On This Page:')}
        <span class="sn-eyebrow sn-eyebrow-pill">${escapeHtml(subtitle)}</span>
        <h1 class="sn-page-h1">${escapeHtml(title)}</h1>
        ${slug === 'faq' ? `
          <div style="display:flex;flex-direction:column;gap:4px;">
            ${parsedFaqBlocks.map((b, idx) => {
              if (b.isFaq) {
                return `
                  <details class="sn-faq-item" id="${escapeHtml(b.id)}"${idx === 0 ? ' open' : ''}>
                    <summary>${escapeHtml(b.question)}${renderHeadingAnchor(b.id, b.question)}</summary>
                    <p>${escapeHtml(b.answer)}</p>
                  </details>
                `;
              }
              return `<div class="sn-card" id="${escapeHtml(b.id)}"><p style="margin:0;">${escapeHtml(b.text)}</p></div>`;
            }).join('')}
          </div>
          <div class="sn-card" id="faq-support-desk" style="margin-top:20px;background-color:var(--sn-bg-parchment);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
            <div>
              <strong style="font-family:var(--sn-font-serif);font-size:1.05rem;color:var(--sn-bg-forest);">Still have a question about a batch, bulk order, or shipment?${renderHeadingAnchor('faq-support-desk', 'Bengaluru Pantry Care Desk')}</strong>
              <div style="font-size:0.84rem;color:var(--sn-text-secondary);">Our Bengaluru pantry care desk responds within 4 business hours.</div>
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <a href="${basePath}/track-order" class="sn-btn sn-btn-outline sn-btn-sm">Track Order</a>
              <a href="${basePath}/contact" class="sn-btn sn-btn-primary sn-btn-sm">Contact Customer Care &rarr;</a>
            </div>
          </div>
        ` : `
          <div class="sn-card" style="display:flex;flex-direction:column;gap:16px;font-size:0.98rem;">
            ${parsedPolicyBlocks.map(b => `
              <div id="${escapeHtml(b.id)}" style="border-bottom:1px dashed var(--sn-border-warm);padding-bottom:12px;">
                <div style="font-family:var(--sn-font-mono);font-size:0.72rem;text-transform:uppercase;color:var(--sn-text-muted);margin-bottom:4px;">
                  ${escapeHtml(b.heading)}${renderHeadingAnchor(b.id, `${title} ${b.heading}`)}
                </div>
                <p style="margin:0;">${escapeHtml(b.text)}</p>
              </div>
            `).join('')}
          </div>
        `}
        ${extraSectionHtml}
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
    `platform: "${BRAND_NAME} (sashyanaturals.com)"`,
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
  resolveHelloBarForRender,
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
