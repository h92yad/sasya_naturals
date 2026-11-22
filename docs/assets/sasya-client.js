'use strict';

/**
 * Sasya Naturals - Zero-Deviation Client Hydration + Dual-Mode (Node SSR Server & GitHub Pages Static WASM Showcase)
 */
(function () {
  const CART_STORAGE_KEY = 'sn_cart_v1';
  const ADMIN_ROLE_STORAGE_KEY = 'sn_admin_email_v1';
  const STATIC_ORDERS_KEY = 'sn_static_orders_v1';

  const IS_STATIC_SHOWCASE = Boolean(window.__SN_STATIC_SHOWCASE__);
  const BASE_PATH = window.__SN_BASE_PATH__ || '';
  let wasmExports = null;

  async function initBrowserWasm() {
    if (wasmExports) return wasmExports;
    try {
      const res = await fetch(`${BASE_PATH}/assets/wasm_core.wasm`);
      const buf = await res.arrayBuffer();
      const mod = await WebAssembly.instantiate(buf, {});
      wasmExports = mod.instance.exports;
      return wasmExports;
    } catch {
      return null;
    }
  }

  function getCart() {
    try {
      const raw = localStorage.getItem(CART_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveCart(items) {
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(items));
    } catch {
      // ignore
    }
    updateCartBadges();
  }

  function showToast(msg, options = {}) {
    const toast = document.getElementById('sn-toast');
    if (!toast) return;
    toast.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = msg;
    toast.appendChild(span);

    if (options.showViewBasket) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sn-btn sn-btn-primary sn-btn-sm';
      btn.setAttribute('data-open-cart', 'true');
      btn.style.cssText = 'padding:4px 10px;min-height:28px;font-size:0.76rem;white-space:nowrap;';
      btn.innerHTML = 'View Basket &rarr;';
      toast.appendChild(btn);
    }

    toast.classList.add('sn-show');
    clearTimeout(window.__snToastTimer);
    window.__snToastTimer = setTimeout(() => {
      toast.classList.remove('sn-show');
    }, 3800);
  }

  function formatInr(paise) {
    return '₹' + (Number(paise || 0) / 100).toLocaleString('en-IN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    });
  }

  function updateCartBadges() {
    const cart = getCart();
    const count = cart.reduce((acc, item) => acc + Number(item.quantity || 1), 0);
    document.querySelectorAll('[data-cart-count]').forEach(el => {
      el.textContent = String(count);
    });
  }

  // Fallback in-browser Rust WASM calculator when running on static GitHub Pages showcase
  async function calculateCartClientSide(items, couponCode, paymentMethod = 'ONLINE_UPI', shippingState = 'Karnataka', shippingPincode = '560003') {
    await initBrowserWasm();
    const dbSnap = window.__SN_STATIC_DATA__ || { variants: [], coupons: [] };
    let subtotalPaise = 0;
    let mrpTotalPaise = 0;
    let rawGstPaise = 0;
    let totalWeightGrams = 0;
    const lineItems = [];

    for (const rawItem of items) {
      const v = dbSnap.variants.find(x => Number(x.variant_id) === Number(rawItem.variantId));
      if (!v) continue;
      const qty = Math.max(1, Number(rawItem.quantity || 1));
      const unitPricePaise = v.selling_price_paise;
      const lineTotalPaise = wasmExports
        ? Number(wasmExports.compute_line_total_paise(BigInt(unitPricePaise), BigInt(qty)))
        : unitPricePaise * qty;
      const lineGstPaise = wasmExports
        ? Number(wasmExports.compute_inclusive_gst_paise(BigInt(lineTotalPaise), BigInt(v.gst_percent)))
        : Math.round((lineTotalPaise * v.gst_percent) / (100 + v.gst_percent));

      subtotalPaise += lineTotalPaise;
      mrpTotalPaise += v.mrp_paise * qty;
      rawGstPaise += lineGstPaise;
      totalWeightGrams += v.weight_grams * qty;

      lineItems.push({
        productId: v.product_id,
        variantId: v.variant_id,
        productName: v.product_name,
        sku: v.sku,
        packLabel: v.pack_label,
        weightGrams: v.weight_grams,
        unitPricePaise,
        mrpPaise: v.mrp_paise,
        gstPercent: v.gst_percent,
        quantity: qty,
        lineTotalPaise,
        lineGstPaise,
        imageUrl: v.image_url || '/images/hero-pantry.jpg'
      });
    }

    let discountPaise = 0;
    let appliedCoupon = '';
    let couponMessage = '';
    const cleanCode = String(couponCode || '').trim().toUpperCase();
    if (cleanCode) {
      const c = (dbSnap.coupons || []).find(x => x.code === cleanCode);
      if (!c) {
        couponMessage = `Coupon "${cleanCode}" is invalid.`;
      } else if (subtotalPaise < c.min_order_paise) {
        couponMessage = `Coupon "${cleanCode}" requires min subtotal Rs. ${c.min_order_paise / 100}.`;
      } else {
        discountPaise = c.discount_type === 'PERCENT'
          ? Math.min(c.max_discount_paise, Math.round((subtotalPaise * c.discount_value) / 100))
          : Math.min(c.max_discount_paise, c.discount_value);
        appliedCoupon = c.code;
        couponMessage = `Coupon ${c.code} applied (-Rs. ${(discountPaise / 100).toFixed(2)}).`;
      }
    }

    const discountedSubtotalPaise = Math.max(0, subtotalPaise - discountPaise);
    const gstPaise = subtotalPaise > 0 ? Math.round(rawGstPaise * (discountedSubtotalPaise / subtotalPaise)) : 0;

    // Client-side 4-zone + 500g slab + free-delivery mode calculation for static GitHub Pages showcase
    const savedPolicy = JSON.parse(localStorage.getItem('sn_shipping_policy_v1') || '{}');
    const freeMode = savedPolicy.shipping_free_mode || 'THRESHOLD_WITH_WEIGHT_CAP';
    const freeModeCode = freeMode === 'DISABLED' ? 0 : (freeMode === 'UNCONDITIONAL_THRESHOLD' ? 2 : 1);
    const freeThresholdPaise = Math.round(Number(savedPolicy.free_shipping_threshold_inr ?? 799) * 100);
    const freeMaxWeightGrams = Math.round(Number(savedPolicy.free_shipping_max_weight_grams ?? 2000));
    const tareGrams = Math.round(Number(savedPolicy.shipping_packaging_tare_grams ?? 150));
    const codFeePaise = Math.round(Number(savedPolicy.shipping_cod_fee_inr ?? 40) * 100);

    const pin = String(shippingPincode || '560003').trim();
    const p3 = pin.slice(0, 3);
    const p2 = pin.slice(0, 2);
    let zoneLabel = 'Zone C (Rest of India National)';
    let basePaise = Math.round(Number(savedPolicy.zone_c_base_inr ?? 75) * 100);
    let extraPaise = Math.round(Number(savedPolicy.zone_c_extra_inr ?? 35) * 100);
    if (p3 === '560') {
      zoneLabel = 'Zone A (Local Bengaluru)';
      basePaise = Math.round(Number(savedPolicy.zone_a_base_inr ?? 40) * 100);
      extraPaise = Math.round(Number(savedPolicy.zone_a_extra_inr ?? 15) * 100);
    } else if (['18', '19', '78', '79'].includes(p2) || ['744', '682'].includes(p3)) {
      zoneLabel = 'Zone D (Special / North-East / J&K)';
      basePaise = Math.round(Number(savedPolicy.zone_d_base_inr ?? 110) * 100);
      extraPaise = Math.round(Number(savedPolicy.zone_d_extra_inr ?? 55) * 100);
    } else if (['50', '51', '52', '53', '56', '57', '58', '59', '60', '61', '62', '63', '64', '67', '68', '69'].includes(p2)) {
      zoneLabel = 'Zone B (South India Regional)';
      basePaise = Math.round(Number(savedPolicy.zone_b_base_inr ?? 55) * 100);
      extraPaise = Math.round(Number(savedPolicy.zone_b_extra_inr ?? 25) * 100);
    }

    const grossWeightGrams = totalWeightGrams + tareGrams;
    const billable500gSlabs = wasmExports && wasmExports.compute_billable_500g_slabs
      ? Number(wasmExports.compute_billable_500g_slabs(BigInt(totalWeightGrams), BigInt(tareGrams)))
      : Math.max(1, Math.ceil(grossWeightGrams / 500));
    const isCod = paymentMethod === 'COD' ? 1 : 0;

    const shippingPaise = wasmExports && wasmExports.compute_zone_weight_shipping_paise
      ? Number(wasmExports.compute_zone_weight_shipping_paise(
          BigInt(discountedSubtotalPaise),
          BigInt(totalWeightGrams),
          BigInt(tareGrams),
          BigInt(basePaise),
          BigInt(extraPaise),
          freeModeCode,
          BigInt(freeThresholdPaise),
          BigInt(freeMaxWeightGrams),
          isCod,
          BigInt(codFeePaise)
        ))
      : basePaise + Math.max(0, billable500gSlabs - 1) * extraPaise + (isCod ? codFeePaise : 0);

    const codFeeAppliedPaise = isCod ? codFeePaise : 0;
    const freightPaise = Math.max(0, shippingPaise - codFeeAppliedPaise);
    const totalPaise = discountedSubtotalPaise + shippingPaise;

    return {
      pricing: {
        engine: 'rust-wasm-v1.2-zone-slab',
        lineItems,
        mrpTotalPaise,
        subtotalPaise,
        discountPaise,
        discountedSubtotalPaise,
        gstPaise,
        shippingPaise,
        freightPaise,
        codFeePaise: codFeeAppliedPaise,
        shippingZoneLabel: zoneLabel,
        totalWeightGrams,
        packagingTareGrams: tareGrams,
        grossWeightGrams,
        billable500gSlabs,
        freeShippingMode: freeMode,
        freeShippingThresholdPaise: freeThresholdPaise,
        freeShippingMaxWeightGrams: freeMaxWeightGrams,
        totalPaise,
        appliedCoupon,
        couponMessage
      }
    };
  }

  async function requestCartPricing(items, couponCode, paymentMethod, shippingState = 'Karnataka', shippingPincode = '560003') {
    if (IS_STATIC_SHOWCASE) {
      return calculateCartClientSide(items, couponCode, paymentMethod, shippingState, shippingPincode);
    }
    const res = await fetch('/api/cart/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, couponCode, paymentMethod, shippingState, shippingPincode })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unable to calculate cart');
    return data;
  }

  async function refreshCartDrawer() {
    const bodyEl = document.getElementById('sn-cart-drawer-body');
    const footEl = document.getElementById('sn-cart-drawer-foot');
    if (!bodyEl || !footEl) return;

    const cart = getCart();
    if (cart.length === 0) {
      bodyEl.innerHTML = `
        <div style="text-align:center;padding:48px 16px;color:var(--sn-text-muted);">
          <p style="font-family:var(--sn-font-serif);font-size:1.2rem;color:var(--sn-bg-forest);margin-bottom:8px;">Your Pantry Basket is Empty</p>
          <p style="font-size:0.875rem;margin-bottom:20px;">Select pack sizes (100 g, 250 g, 500 g, or 1 kg) across Dry Fruits, Native Millets, and Single-Origin Spices.</p>
          <a href="${BASE_PATH}/shop" class="sn-btn sn-btn-forest">Browse Catalogue</a>
        </div>
      `;
      footEl.innerHTML = '';
      return;
    }

    try {
      const data = await requestCartPricing(cart, '', 'ONLINE_UPI');
      const p = data.pricing;
      const threshPaise = p.freeShippingThresholdPaise || 79900;
      const maxWeightGrams = p.freeShippingMaxWeightGrams || 2000;
      const grossGrams = p.grossWeightGrams || (p.totalWeightGrams + 150);
      const remainingForFreePaise = Math.max(0, threshPaise - p.subtotalPaise);
      const progressPct = Math.min(100, Math.round((p.subtotalPaise / threshPaise) * 100));

      let freeDeliveryBanner = '';
      if (p.freeShippingMode !== 'DISABLED') {
        if (grossGrams > maxWeightGrams && p.freeShippingMode === 'THRESHOLD_WITH_WEIGHT_CAP') {
          freeDeliveryBanner = `
            <div style="padding:8px 10px;border-radius:6px;background-color:var(--sn-bg-mortar);font-family:var(--sn-font-mono);font-size:0.73rem;color:var(--sn-text-secondary);margin-bottom:10px;">
              Parcel gross weight (${grossGrams}g) exceeds ${maxWeightGrams}g free-delivery cap • 4-Zone slab freight applies
            </div>
          `;
        } else if (remainingForFreePaise > 0) {
          freeDeliveryBanner = `
            <div style="padding:8px 10px;border-radius:6px;background-color:var(--sn-bg-parchment);border:1px solid var(--sn-border-warm);margin-bottom:10px;">
              <div style="font-family:var(--sn-font-mono);font-size:0.73rem;color:var(--sn-bg-forest);margin-bottom:4px;">
                Add <strong>${formatInr(remainingForFreePaise)}</strong> more for <strong>FREE India-Wide Delivery</strong> (up to ${(maxWeightGrams / 1000).toFixed(1)} kg)
              </div>
              <div style="height:5px;background-color:var(--sn-border-warm);border-radius:999px;overflow:hidden;">
                <div style="width:${progressPct}%;height:100%;background-color:var(--sn-bg-forest);"></div>
              </div>
            </div>
          `;
        } else {
          freeDeliveryBanner = `
            <div style="padding:8px 10px;border-radius:6px;background-color:var(--sn-status-paid-bg);font-family:var(--sn-font-mono);font-size:0.73rem;color:var(--sn-status-paid);font-weight:600;margin-bottom:10px;">
              ✓ Complimentary Delivery Unlocked (${grossGrams}g gross parcel &le; ${maxWeightGrams}g cap)
            </div>
          `;
        }
      }

      bodyEl.innerHTML = p.lineItems.map(item => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--sn-border-warm);gap:10px;">
          <img
            src="${BASE_PATH}${item.imageUrl || '/images/hero-pantry.jpg'}"
            alt="${item.productName}"
            style="width:48px;height:48px;object-fit:cover;border-radius:6px;border:1px solid var(--sn-border-strong);flex-shrink:0;"
          />
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;color:var(--sn-bg-forest);font-size:0.9rem;line-height:1.25;">${item.productName}</div>
            <div style="font-family:var(--sn-font-mono);font-size:0.72rem;color:var(--sn-text-muted);">Pack: ${item.packLabel} | SKU: ${item.sku}</div>
            <div style="font-family:var(--sn-font-mono);font-size:0.83rem;font-weight:600;margin-top:3px;">${formatInr(item.unitPricePaise)} &times; ${item.quantity} = ${formatInr(item.lineTotalPaise)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:5px;flex-shrink:0;">
            <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-cart-qty="${item.variantId}" data-delta="-1" aria-label="Decrease quantity">-</button>
            <span style="font-family:var(--sn-font-mono);font-size:0.84rem;min-width:18px;text-align:center;">${item.quantity}</span>
            <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-cart-qty="${item.variantId}" data-delta="1" aria-label="Increase quantity">+</button>
            <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-cart-remove="${item.variantId}" title="Remove item from basket" aria-label="Remove item" style="color:var(--sn-status-danger);padding:4px 7px;">&times;</button>
          </div>
        </div>
      `).join('');

      footEl.innerHTML = `
        ${freeDeliveryBanner}
        <div style="padding:7px 10px;border-radius:6px;background-color:var(--sn-bg-parchment);border:1px dashed var(--sn-border-strong);font-family:var(--sn-font-mono);font-size:0.71rem;color:var(--sn-bg-forest);margin-bottom:10px;">
          🏷️ Promo Codes at Checkout: <strong>SASYA10</strong> (10% off) • <strong>WELCOME15</strong> (15% off &ge; ₹999)
        </div>
        <div style="font-size:0.85rem;display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;"><span>Subtotal (incl. GST ${formatInr(p.gstPaise)})</span><strong style="font-family:var(--sn-font-mono);">${formatInr(p.subtotalPaise)}</strong></div>
          <div style="display:flex;justify-content:space-between;"><span>Est. Zone A Delivery (${grossGrams}g gross)</span><strong style="font-family:var(--sn-font-mono);">${p.shippingPaise === 0 ? 'FREE' : formatInr(p.shippingPaise)}</strong></div>
          <div style="display:flex;justify-content:space-between;font-size:1.05rem;padding-top:8px;border-top:1px solid var(--sn-border-warm);color:var(--sn-bg-forest);">
            <strong>Order Total</strong>
            <strong style="font-family:var(--sn-font-mono);">${formatInr(p.totalPaise)}</strong>
          </div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button type="button" class="sn-btn sn-btn-outline" id="sn-clear-cart-btn" style="flex:1;">Clear</button>
          <a href="${BASE_PATH}/checkout" class="sn-btn sn-btn-primary" style="flex:1.4;">Proceed to Checkout &rarr;</a>
        </div>
      `;
    } catch (err) {
      bodyEl.innerHTML = `<p style="color:var(--sn-status-danger);">${err.message}</p>`;
    }
  }

  function runPdpPinCheck() {
    const pinInput = document.getElementById('sn-pdp-pin-input');
    const resEl = document.getElementById('sn-pdp-pin-result');
    const pin = String(pinInput ? pinInput.value : '').trim();
    if (!resEl) return;
    if (!/^\d{6}$/.test(pin) || pin === '999999') {
      resEl.style.color = 'var(--sn-status-danger)';
      resEl.style.backgroundColor = 'var(--sn-status-danger-bg)';
      resEl.textContent = '✕ Unserviceable PIN Code • Please enter a valid 6-digit Indian PIN';
      return;
    }
    const p3 = pin.slice(0, 3);
    const p2 = pin.slice(0, 2);
    let zoneDesc = 'Zone C (Rest of India • ₹75/500g • 3-5 Days)';
    if (p3 === '560') {
      zoneDesc = 'Zone A (Local Bengaluru • ₹40/500g • 1-2 Days)';
    } else if (['18', '19', '78', '79'].includes(p2) || ['744', '682'].includes(p3)) {
      zoneDesc = 'Zone D (NE / J&K / Remote • ₹110/500g • 5-7 Days)';
    } else if (['50', '51', '52', '53', '56', '57', '58', '59', '60', '61', '62', '63', '64', '67', '68', '69'].includes(p2)) {
      zoneDesc = 'Zone B (South India • ₹55/500g • 2-4 Days)';
    }
    const codNote = pin === '800099' ? 'Prepaid Only (COD Disabled)' : 'Prepaid & COD Available';
    resEl.style.color = 'var(--sn-status-paid)';
    resEl.style.backgroundColor = 'var(--sn-status-paid-bg)';
    resEl.textContent = `✓ ${zoneDesc} • ${codNote}`;
  }

  function bindGlobalListeners() {
    const pdpPinInput = document.getElementById('sn-pdp-pin-input');
    if (pdpPinInput) {
      pdpPinInput.addEventListener('input', () => {
        if (/^\d{6}$/.test(pdpPinInput.value.trim())) {
          runPdpPinCheck();
        }
      });
    }

    document.addEventListener('click', async (e) => {
      const mobileMenuBtn = e.target.closest('[data-mobile-menu]');
      if (mobileMenuBtn) {
        const navEl = document.querySelector('.sn-nav');
        if (navEl) {
          const isOpen = navEl.classList.toggle('sn-nav-open');
          mobileMenuBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
          mobileMenuBtn.textContent = isOpen ? '✕' : '☰';
          mobileMenuBtn.classList.toggle('sn-btn-forest', isOpen);
          mobileMenuBtn.classList.toggle('sn-btn-outline', !isOpen);
        }
        return;
      }

      const toggleAddAddrBtn = e.target.closest('[data-toggle-add-address]');
      if (toggleAddAddrBtn) {
        const addrForm = document.getElementById('sn-customer-add-address-form');
        if (addrForm) {
          const isHidden = addrForm.style.display === 'none';
          addrForm.style.display = isHidden ? 'block' : 'none';
          toggleAddAddrBtn.textContent = isHidden ? '− Hide Form' : '+ Add Address';
        }
        return;
      }

      const pdpQtyBtn = e.target.closest('[data-pdp-qty-delta]');
      if (pdpQtyBtn) {
        const qtyInput = document.getElementById('sn-pdp-qty');
        if (qtyInput) {
          const delta = Number(pdpQtyBtn.getAttribute('data-pdp-qty-delta') || 0);
          const nextVal = Math.max(1, Math.min(20, Number(qtyInput.value || 1) + delta));
          qtyInput.value = String(nextVal);
        }
        return;
      }

      const couponChipBtn = e.target.closest('[data-apply-coupon-chip]');
      if (couponChipBtn) {
        const code = couponChipBtn.getAttribute('data-apply-coupon-chip') || '';
        const couponInput = document.getElementById('sn-checkout-coupon');
        if (couponInput && code) {
          couponInput.value = code;
          if (typeof window.__snRenderCheckoutSummary === 'function') {
            await window.__snRenderCheckoutSummary();
          }
          showToast(`Applied promo code ${code}`);
        }
        return;
      }

      const packPill = e.target.closest('[data-variant-pill]');
      if (packPill) {
        const container = packPill.closest('[data-product-container]');
        if (!container) return;
        container.querySelectorAll('[data-variant-pill]').forEach(btn => btn.classList.remove('sn-active'));
        packPill.classList.add('sn-active');

        const variantId = packPill.getAttribute('data-variant-id');
        const pricePaise = Number(packPill.getAttribute('data-price-paise'));
        const mrpPaise = Number(packPill.getAttribute('data-mrp-paise'));
        const sku = packPill.getAttribute('data-sku');
        const stock = Number(packPill.getAttribute('data-stock'));
        const packLabel = packPill.getAttribute('data-pack-label');

        const priceEl = container.querySelector('[data-price-display]');
        const mrpEl = container.querySelector('[data-mrp-display]');
        const saveEl = container.querySelector('[data-save-display]');
        const skuEl = container.querySelector('[data-sku-display]');
        const stockEl = container.querySelector('[data-stock-display]');
        const addBtn = container.querySelector('[data-add-to-cart]');
        const buyNowBtn = container.querySelector('[data-buy-now]');

        if (priceEl) priceEl.textContent = formatInr(pricePaise);
        if (mrpEl) mrpEl.textContent = 'MRP ' + formatInr(mrpPaise);
        if (saveEl) {
          const savePct = mrpPaise > pricePaise ? Math.round(((mrpPaise - pricePaise) / mrpPaise) * 100) : 0;
          saveEl.textContent = savePct > 0 ? `Save ${savePct}%` : '';
          saveEl.style.display = savePct > 0 ? 'inline-block' : 'none';
        }
        if (skuEl) skuEl.textContent = sku;
        if (stockEl) {
          stockEl.textContent = stock > 0 ? `In Stock (${stock} packs)` : 'Out of Stock';
        }
        if (addBtn) {
          addBtn.setAttribute('data-variant-id', variantId);
          addBtn.setAttribute('data-pack-label', packLabel);
        }
        if (buyNowBtn) {
          buyNowBtn.setAttribute('data-variant-id', variantId);
          buyNowBtn.setAttribute('data-pack-label', packLabel);
        }
        return;
      }

      const addBtn = e.target.closest('[data-add-to-cart]');
      if (addBtn) {
        const variantId = Number(addBtn.getAttribute('data-variant-id'));
        const productName = addBtn.getAttribute('data-product-name') || 'Product';
        const packLabel = addBtn.getAttribute('data-pack-label') || '250 g';
        const qtyInput = document.getElementById('sn-pdp-qty');
        const addQty = qtyInput ? Math.max(1, Number(qtyInput.value || 1)) : 1;

        const cart = getCart();
        const existing = cart.find(i => Number(i.variantId) === variantId);
        if (existing) {
          existing.quantity = Math.min(25, existing.quantity + addQty);
        } else {
          cart.push({ variantId, quantity: addQty });
        }
        saveCart(cart);

        const origLabel = addBtn.getAttribute('data-orig-label') || addBtn.textContent;
        addBtn.setAttribute('data-orig-label', origLabel);
        addBtn.textContent = '✓ Added';
        addBtn.classList.add('sn-btn-added');
        setTimeout(() => {
          addBtn.textContent = origLabel;
          addBtn.classList.remove('sn-btn-added');
        }, 1200);

        showToast(`Added ${productName} (${packLabel}) to your Pantry Basket`, { showViewBasket: true });
        await refreshCartDrawer();
        return;
      }

      const buyNowBtn = e.target.closest('[data-buy-now]');
      if (buyNowBtn) {
        const variantId = Number(buyNowBtn.getAttribute('data-variant-id'));
        const qtyInput = document.getElementById('sn-pdp-qty');
        const addQty = qtyInput ? Math.max(1, Number(qtyInput.value || 1)) : 1;

        const cart = getCart();
        const existing = cart.find(i => Number(i.variantId) === variantId);
        if (existing) {
          existing.quantity = Math.min(25, existing.quantity + addQty);
        } else {
          cart.push({ variantId, quantity: addQty });
        }
        saveCart(cart);
        window.location.href = `${BASE_PATH}/checkout`;
        return;
      }

      if (e.target.id === 'sn-pdp-pin-check-btn') {
        runPdpPinCheck();
        return;
      }

      const openCartBtn = e.target.closest('[data-open-cart]');
      if (openCartBtn) {
        e.preventDefault();
        const toast = document.getElementById('sn-toast');
        if (toast) toast.classList.remove('sn-show');
        const drawer = document.getElementById('sn-cart-backdrop');
        if (drawer) {
          drawer.classList.add('sn-open');
          await refreshCartDrawer();
        }
        return;
      }

      const closeCartBtn = e.target.closest('[data-close-cart]');
      if (closeCartBtn || e.target.id === 'sn-cart-backdrop') {
        const drawer = document.getElementById('sn-cart-backdrop');
        if (drawer) drawer.classList.remove('sn-open');
        return;
      }

      const removeBtn = e.target.closest('[data-cart-remove]');
      if (removeBtn) {
        const variantId = Number(removeBtn.getAttribute('data-cart-remove'));
        const cart = getCart().filter(i => Number(i.variantId) !== variantId);
        saveCart(cart);
        await refreshCartDrawer();
        if (typeof window.__snRenderCheckoutSummary === 'function') {
          window.__snRenderCheckoutSummary();
        }
        return;
      }

      const qtyBtn = e.target.closest('[data-cart-qty]');
      if (qtyBtn) {
        const variantId = Number(qtyBtn.getAttribute('data-cart-qty'));
        const delta = Number(qtyBtn.getAttribute('data-delta'));
        let cart = getCart();
        const item = cart.find(i => Number(i.variantId) === variantId);
        if (item) {
          item.quantity += delta;
          if (item.quantity <= 0) {
            cart = cart.filter(i => Number(i.variantId) !== variantId);
          }
          saveCart(cart);
          await refreshCartDrawer();
          if (typeof window.__snRenderCheckoutSummary === 'function') {
            window.__snRenderCheckoutSummary();
          }
        }
        return;
      }

      if (e.target.id === 'sn-clear-cart-btn') {
        saveCart([]);
        await refreshCartDrawer();
        if (typeof window.__snRenderCheckoutSummary === 'function') {
          window.__snRenderCheckoutSummary();
        }
        return;
      }
    });
  }

  function initCheckoutPage() {
    const checkoutForm = document.getElementById('sn-checkout-form');
    if (!checkoutForm) return;

    const summaryBox = document.getElementById('sn-checkout-summary-box');
    const couponInput = document.getElementById('sn-checkout-coupon');
    const applyCouponBtn = document.getElementById('sn-apply-coupon-btn');

    async function renderSummary() {
      const cart = getCart();
      if (cart.length === 0) {
        summaryBox.innerHTML = `<p style="color:var(--sn-text-muted);">Your basket is empty. <a href="${BASE_PATH}/shop" style="color:var(--sn-accent-terracotta);font-weight:600;">Add products from the shop &rarr;</a></p>`;
        return;
      }
      const couponCode = couponInput ? couponInput.value.trim() : '';
      const methodEl = checkoutForm.querySelector('input[name="paymentMethod"]:checked');
      const paymentMethod = methodEl ? methodEl.value : 'ONLINE_UPI';
      const pinEl = document.getElementById('chk-pin');
      const stateEl = document.getElementById('chk-state');
      const shippingPincode = pinEl ? pinEl.value.trim() : '560003';
      const shippingState = stateEl ? stateEl.value.trim() : 'Karnataka';

      try {
        const data = await requestCartPricing(cart, couponCode, paymentMethod, shippingState, shippingPincode);
        const p = data.pricing;
        const taxLabel = p.taxSupplyType === 'IGST' ? 'Inter-State IGST' : 'Intra-State (CGST + SGST)';
        summaryBox.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:10px;">
            ${p.lineItems.map(item => `
              <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.86rem;border-bottom:1px dashed var(--sn-border-warm);padding-bottom:8px;gap:8px;">
                <div style="flex:1;">
                  <strong>${item.productName}</strong> (${item.packLabel}) &times; ${item.quantity}
                  <div style="font-family:var(--sn-font-mono);font-size:0.72rem;color:var(--sn-text-muted);">SKU: ${item.sku} | GST ${item.gstPercent}%</div>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                  <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" style="min-height:26px;padding:2px 7px;" data-cart-qty="${item.variantId}" data-delta="-1">-</button>
                  <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" style="min-height:26px;padding:2px 7px;" data-cart-qty="${item.variantId}" data-delta="1">+</button>
                  <span style="font-family:var(--sn-font-mono);font-weight:600;min-width:54px;text-align:right;">${formatInr(item.lineTotalPaise)}</span>
                </div>
              </div>
            `).join('')}
            <div style="display:flex;justify-content:space-between;font-size:0.88rem;padding-top:4px;">
              <span>Subtotal</span><strong style="font-family:var(--sn-font-mono);">${formatInr(p.subtotalPaise)}</strong>
            </div>
            ${p.discountPaise > 0 ? `
              <div style="display:flex;justify-content:space-between;font-size:0.88rem;color:var(--sn-status-paid);">
                <span>Coupon Discount (${p.appliedCoupon})</span><strong style="font-family:var(--sn-font-mono);">-${formatInr(p.discountPaise)}</strong>
              </div>
            ` : ''}
            <div style="display:flex;justify-content:space-between;font-size:0.82rem;color:var(--sn-text-muted);">
              <span>Included GST (${taxLabel})</span><span style="font-family:var(--sn-font-mono);">${formatInr(p.gstPaise)}</span>
            </div>
            <div style="padding:10px;border-radius:6px;background-color:var(--sn-bg-parchment);border:1px solid var(--sn-border-warm);font-size:0.79rem;display:flex;flex-direction:column;gap:4px;">
              <div style="display:flex;justify-content:space-between;">
                <span>Delivery Zone (${shippingPincode}):</span>
                <strong style="font-family:var(--sn-font-mono);">${p.shippingZoneLabel || 'Zone A (Local Bengaluru)'}</strong>
              </div>
              <div style="display:flex;justify-content:space-between;color:var(--sn-text-secondary);">
                <span>Gross Weight (${p.totalWeightGrams}g net + ${p.packagingTareGrams || 150}g box):</span>
                <span style="font-family:var(--sn-font-mono);">${p.grossWeightGrams || (p.totalWeightGrams + 150)}g (${p.billable500gSlabs || 1} &times; 500g slabs)</span>
              </div>
              <div style="display:flex;justify-content:space-between;color:var(--sn-text-secondary);">
                <span>Free-Delivery Eligibility:</span>
                <span style="font-family:var(--sn-font-mono);">${p.freeShippingMode === 'DISABLED' ? 'Zone Freight Applies' : `Orders &ge; ${formatInr(p.freeShippingThresholdPaise)} (&le; ${p.freeShippingMaxWeightGrams || 2000}g)`}</span>
              </div>
              <div style="display:flex;justify-content:space-between;">
                <span>Zone Freight Charge:</span>
                <strong style="font-family:var(--sn-font-mono);">${(p.freightPaise ?? p.shippingPaise) === 0 ? 'FREE' : formatInr(p.freightPaise ?? p.shippingPaise)}</strong>
              </div>
              ${p.codFeePaise > 0 ? `
                <div style="display:flex;justify-content:space-between;color:var(--sn-status-warn);">
                  <span>COD Collection Fee:</span>
                  <strong style="font-family:var(--sn-font-mono);">+${formatInr(p.codFeePaise)}</strong>
                </div>
              ` : ''}
            </div>
            <div style="display:flex;justify-content:space-between;font-size:1.15rem;padding-top:10px;border-top:2px solid var(--sn-border-strong);color:var(--sn-bg-forest);">
              <strong>Total Payable</strong><strong style="font-family:var(--sn-font-mono);">${formatInr(p.totalPaise)}</strong>
            </div>
            ${p.couponMessage ? `<div style="font-size:0.78rem;color:var(--sn-accent-terracotta);font-family:var(--sn-font-mono);">${p.couponMessage}</div>` : ''}
          </div>
        `;
      } catch (err) {
        summaryBox.innerHTML = `<p style="color:var(--sn-status-danger);">${err.message}</p>`;
      }
    }

    window.__snRenderCheckoutSummary = renderSummary;
    renderSummary();

    if (applyCouponBtn) {
      applyCouponBtn.addEventListener('click', renderSummary);
    }
    const pinInputEl = document.getElementById('chk-pin');
    if (pinInputEl) pinInputEl.addEventListener('input', renderSummary);
    checkoutForm.querySelectorAll('input[name="paymentMethod"]').forEach(radio => {
      radio.addEventListener('change', renderSummary);
    });

    // Saved Delivery Address 1-Click Auto-Fill Selector
    document.querySelectorAll('[data-checkout-saved-addr]').forEach(btn => {
      btn.addEventListener('click', () => {
        try {
          const rawJson = btn.getAttribute('data-checkout-saved-addr');
          const addr = rawJson && rawJson.startsWith('{') ? JSON.parse(rawJson) : {
            recipient_name: btn.getAttribute('data-addr-name') || '',
            phone: btn.getAttribute('data-addr-phone') || '',
            line1: btn.getAttribute('data-addr-line1') || '',
            line2: btn.getAttribute('data-addr-line2') || '',
            city: btn.getAttribute('data-addr-city') || '',
            state: btn.getAttribute('data-addr-state') || '',
            pincode: btn.getAttribute('data-addr-pin') || ''
          };
          const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el && val !== undefined) el.value = val;
          };
          setVal('chk-name', addr.recipient_name || '');
          setVal('chk-phone', addr.phone || '');
          setVal('chk-line1', addr.line1 || '');
          setVal('chk-line2', addr.line2 || '');
          setVal('chk-city', addr.city || '');
          setVal('chk-state', addr.state || '');
          setVal('chk-pin', addr.pincode || '');

          document.querySelectorAll('[data-checkout-saved-addr]').forEach(b => {
            b.classList.remove('sn-btn-forest');
            b.classList.add('sn-btn-outline');
          });
          btn.classList.remove('sn-btn-outline');
          btn.classList.add('sn-btn-forest');

          renderSummary();
          showToast(`Auto-filled saved address: ${addr.label || addr.city} (PIN ${addr.pincode})`);
        } catch {
          // ignore malformed attribute
        }
      });
    });

    const codOtpBtn = document.getElementById('sn-request-cod-otp-btn');
    const codOtpInput = document.getElementById('sn-cod-otp-input');
    const codOtpHint = document.getElementById('sn-cod-otp-hint');
    if (codOtpBtn) {
      codOtpBtn.addEventListener('click', async () => {
        const phoneEl = document.getElementById('chk-phone');
        const phone = phoneEl ? phoneEl.value.trim() : '+91 98450 11223';
        try {
          if (IS_STATIC_SHOWCASE) {
            const simOtp = '482910';
            if (codOtpInput) codOtpInput.value = simOtp;
            if (codOtpHint) codOtpHint.textContent = `Sandbox OTP Dispatched: ${simOtp} (Auto-filled)`;
            showToast(`COD Verification OTP sent to ${phone}`);
            return;
          }
          const res = await fetch('/api/checkout/cod-otp/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'OTP dispatch failed');
          if (data.sandboxOtpPreview && codOtpInput) {
            codOtpInput.value = data.sandboxOtpPreview;
            if (codOtpHint) codOtpHint.textContent = `Sandbox OTP: ${data.sandboxOtpPreview} (Verified)`;
          }
          showToast(`6-digit COD OTP sent to ${data.phone}`);
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    checkoutForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cart = getCart();
      if (cart.length === 0) {
        showToast('Your pantry basket is empty.');
        return;
      }

      const formData = new FormData(checkoutForm);
      const rawUserId = formData.get('userId');
      const payload = {
        userId: rawUserId ? Number(rawUserId) : null,
        customerName: formData.get('customerName'),
        customerEmail: formData.get('customerEmail'),
        customerPhone: formData.get('customerPhone'),
        shippingLine1: formData.get('shippingLine1'),
        shippingLine2: formData.get('shippingLine2'),
        shippingCity: formData.get('shippingCity'),
        shippingState: formData.get('shippingState'),
        shippingPincode: formData.get('shippingPincode'),
        deliveryInstructions: formData.get('deliveryInstructions'),
        paymentMethod: formData.get('paymentMethod'),
        codOtpCode: formData.get('codOtpCode') || '',
        couponCode: couponInput ? couponInput.value.trim() : '',
        items: cart
      };

      const resultEl = document.getElementById('sn-checkout-result');
      try {
        let orderNumber = '';
        let paymentMethod = payload.paymentMethod;

        if (IS_STATIC_SHOWCASE) {
          const calc = await calculateCartClientSide(cart, payload.couponCode);
          const storedOrders = JSON.parse(localStorage.getItem(STATIC_ORDERS_KEY) || '[]');
          orderNumber = `SN-2026-${1003 + storedOrders.length}`;
          storedOrders.push({
            order_number: orderNumber,
            customer_name: payload.customerName,
            customer_phone: payload.customerPhone,
            payment_method: paymentMethod,
            payment_status: paymentMethod === 'COD' ? 'COD_PENDING' : 'PAID',
            fulfilment_status: 'Confirmed',
            total_paise: calc.pricing.totalPaise,
            courier_name: 'Pending Manual Dispatch',
            tracking_number: ''
          });
          localStorage.setItem(STATIC_ORDERS_KEY, JSON.stringify(storedOrders));
        } else {
          const res = await fetch('/api/orders/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Checkout failed');
          orderNumber = data.orderNumber;

          if (payload.paymentMethod !== 'COD') {
            const simPaymentId = `pay_rzp_${data.orderNumber.replace(/-/g, '')}`;
            const verifyRes = await fetch('/api/payments/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                orderNumber: data.orderNumber,
                gatewayOrderId: data.gatewayOrderId,
                gatewayPaymentId: simPaymentId,
                gatewaySignature: data.sandboxSignaturePreview
              })
            });
            const verifyData = await verifyRes.json();
            if (!verifyRes.ok) throw new Error(verifyData.error || 'Payment verification failed');
          }
        }

        saveCart([]);
        if (resultEl) {
          resultEl.style.display = 'block';
          resultEl.innerHTML = `
            <div class="sn-card" style="border-color:var(--sn-status-paid);background-color:var(--sn-status-paid-bg);">
              <h3 style="margin:0 0 8px;font-family:var(--sn-font-serif);color:var(--sn-bg-forest);">Order Confirmed: ${orderNumber}</h3>
              <p style="margin:0 0 12px;font-size:0.9rem;">
                Payment Method: <strong>${paymentMethod}</strong> |
                Payment Status: <strong>${paymentMethod === 'COD' ? 'COD_PENDING (Due on Delivery)' : 'PAID (Server HMAC Verified)'}</strong> |
                Fulfilment Status: <strong>Confirmed</strong>
              </p>
              <div style="display:flex;gap:10px;flex-wrap:wrap;">
                <a href="${BASE_PATH}/track-order?order=${encodeURIComponent(orderNumber)}" class="sn-btn sn-btn-forest">Track Order ${orderNumber} -></a>
                ${!IS_STATIC_SHOWCASE ? `<a href="${BASE_PATH}/orders/${encodeURIComponent(orderNumber)}/invoice" class="sn-btn sn-btn-outline">View GST Tax Invoice -></a>` : ''}
              </div>
            </div>
          `;
        }
        showToast(`Order ${orderNumber} placed successfully!`);
      } catch (err) {
        showToast(err.message);
      }
    });
  }

  function initAdminPortal() {
    const adminRoot = document.getElementById('sn-admin-portal');
    if (!adminRoot) return;

    const roleSelect = document.getElementById('sn-admin-role-switcher');
    const savedEmail = localStorage.getItem(ADMIN_ROLE_STORAGE_KEY);
    if (roleSelect && savedEmail) {
      roleSelect.value = savedEmail;
    }

    function getActiveAdminEmail() {
      return roleSelect ? roleSelect.value : 'superadmin@sasynaturals.com';
    }

    if (roleSelect) {
      roleSelect.addEventListener('change', () => {
        localStorage.setItem(ADMIN_ROLE_STORAGE_KEY, roleSelect.value);
        showToast(`Switched Admin RBAC Session to ${roleSelect.options[roleSelect.selectedIndex].text}`);
      });
    }

    const authToggleBtn = document.getElementById('sn-admin-auth-toggle-btn');
    const adminLoginForm = document.getElementById('sn-admin-login-form');
    if (authToggleBtn && adminLoginForm) {
      authToggleBtn.addEventListener('click', () => {
        const isOpen = adminLoginForm.classList.toggle('sn-open');
        authToggleBtn.textContent = isOpen ? '✕ Hide Login' : '🔑 Staff Login / Sign Out';
      });
    }

    function activateAdminModule(target) {
      document.querySelectorAll('[data-admin-tab-btn]').forEach(b => {
        const isMatch = b.getAttribute('data-admin-tab-btn') === target;
        b.classList.toggle('sn-active', isMatch);
        if (isMatch && typeof b.scrollIntoView === 'function') {
          b.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
      });
      document.querySelectorAll('[data-admin-submenu-for]').forEach(subUl => {
        const isMatch = subUl.getAttribute('data-admin-submenu-for') === target;
        subUl.classList.toggle('sn-submenu-open', isMatch);
      });
      let activePanelEl = null;
      document.querySelectorAll('[data-admin-panel]').forEach(panel => {
        const isMatch = panel.getAttribute('data-admin-panel') === target;
        panel.style.display = isMatch ? 'block' : 'none';
        if (isMatch) activePanelEl = panel;
      });
      if (activePanelEl && window.innerWidth <= 960) {
        const panelTop = activePanelEl.getBoundingClientRect().top + window.scrollY;
        if (window.scrollY > panelTop - 90) {
          window.scrollTo({ top: Math.max(0, panelTop - 115), behavior: 'smooth' });
        }
      }
    }

    function activateAdminSubTab(subtabKey) {
      if (!subtabKey || !subtabKey.includes(':')) return;
      const [moduleKey] = subtabKey.split(':');
      activateAdminModule(moduleKey);

      document.querySelectorAll(`[data-admin-subpanel^="${moduleKey}:"]`).forEach(subPanel => {
        subPanel.style.display = subPanel.getAttribute('data-admin-subpanel') === subtabKey ? 'block' : 'none';
      });
      document.querySelectorAll(`[data-admin-subtab-btn^="${moduleKey}:"]`).forEach(pill => {
        pill.classList.toggle('sn-active', pill.getAttribute('data-admin-subtab-btn') === subtabKey);
      });
      document.querySelectorAll(`[data-admin-subtab-link^="${moduleKey}:"]`).forEach(subBtn => {
        subBtn.classList.toggle('sn-sub-active', subBtn.getAttribute('data-admin-subtab-link') === subtabKey);
      });
    }

    document.querySelectorAll('[data-admin-tab-btn]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-admin-tab-btn');
        activateAdminModule(target);
      });
    });

    document.querySelectorAll('[data-admin-subtab-btn]').forEach(pill => {
      pill.addEventListener('click', () => {
        activateAdminSubTab(pill.getAttribute('data-admin-subtab-btn'));
      });
    });

    document.querySelectorAll('[data-admin-subtab-link]').forEach(subBtn => {
      subBtn.addEventListener('click', () => {
        activateAdminSubTab(subBtn.getAttribute('data-admin-subtab-link'));
      });
    });

    document.querySelectorAll('[data-toggle-admin-form]').forEach(btn => {
      btn.addEventListener('click', () => {
        const forcedSubtab = btn.getAttribute('data-force-subtab');
        if (forcedSubtab) {
          activateAdminSubTab(forcedSubtab);
        }
        const targetId = btn.getAttribute('data-toggle-admin-form');
        const targetEl = document.getElementById(targetId);
        if (targetEl) {
          const isOpen = targetEl.classList.toggle('sn-open');
          document.querySelectorAll(`[data-toggle-admin-form="${targetId}"]`).forEach(b => {
            if (b.textContent.trim() === '✕ Close') return;
            const openTxt = b.getAttribute('data-toggle-open-text') || '− Hide Form';
            const closedTxt = b.getAttribute('data-toggle-closed-text') || '+ Expand Form';
            b.textContent = isOpen ? openTxt : closedTxt;
          });
          if (isOpen && typeof targetEl.scrollIntoView === 'function') {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }
      });
    });

    // Write-Only API & Razorpay Credential Vault handlers
    document.querySelectorAll('[data-vault-rotate-btn]').forEach(btn => {
      btn.addEventListener('click', () => {
        const keyName = btn.getAttribute('data-vault-rotate-btn');
        const form = document.querySelector(`[data-vault-form="${keyName}"]`);
        if (form) {
          form.style.display = form.style.display === 'none' ? 'flex' : 'none';
        }
      });
    });

    document.querySelectorAll('.sn-admin-vault-form').forEach(form => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const keyName = fd.get('keyName');
        const secretValue = fd.get('secretValue');

        if (IS_STATIC_SHOWCASE) {
          const email = getActiveAdminEmail();
          if (email !== 'superadmin@sasynaturals.com') {
            showToast('403 RBAC Permission Denied: Only SUPER_ADMIN can access the Credential Vault.');
            return;
          }
          form.style.display = 'none';
          const card = form.closest('[data-vault-item]');
          if (card) {
            const badge = card.querySelector('.sn-status');
            if (badge) {
              badge.className = 'sn-status sn-status-paid';
              badge.textContent = `🔒 Sealed & Hidden: ${String(secretValue).slice(0, 3)}•••••••• (Hidden)`;
            }
          }
          showToast(`Sealed & encrypted ${keyName} in AES-256-GCM Vault!`);
          return;
        }

        const res = await fetch('/api/admin/vault/seal', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-email': getActiveAdminEmail()
          },
          body: JSON.stringify({ keyName, secretValue })
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Vault permission denied');
          return;
        }
        showToast(`Sealed & encrypted ${keyName} (${data.maskedHint})`);
        setTimeout(() => window.location.reload(), 600);
      });
    });

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        if (!file || !file.size) return resolve('');
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Failed to read image file'));
        reader.readAsDataURL(file);
      });
    }

    function updateDomProductImages(productId, imgSrc) {
      document.querySelectorAll(`[data-product-img-id="${productId}"]`).forEach(img => {
        img.src = imgSrc;
      });
      const tr = document.querySelector(`[data-admin-prod-row="${productId}"]`);
      if (tr) tr.setAttribute('data-prod-img', imgSrc);
      const modalThumb = document.getElementById('sn-edit-modal-thumb');
      const modalProdId = document.getElementById('sn-edit-prod-select')?.value;
      if (modalThumb && String(modalProdId) === String(productId)) {
        modalThumb.src = imgSrc;
      }
    }

    function updateDomCategoryImages(categoryId, imgSrc) {
      document.querySelectorAll(`[data-category-img-id="${categoryId}"]`).forEach(img => {
        img.src = imgSrc;
      });
    }

    // 1. Create New Category (with Category Banner Image)
    const createCatForm = document.getElementById('sn-admin-create-category-form');
    if (createCatForm) {
      createCatForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(createCatForm);
        const name = String(fd.get('name') || '').trim();
        const subtitle = String(fd.get('subtitle') || '').trim();
        const description = String(fd.get('description') || '').trim();
        const file = fd.get('categoryImageFile');

        try {
          const imageBase64 = await readFileAsDataUrl(file);

          if (IS_STATIC_SHOWCASE) {
            const email = getActiveAdminEmail();
            if (email !== 'superadmin@sasynaturals.com' && email !== 'catalog@sasynaturals.com') {
              showToast('403 RBAC Permission Denied: Only SUPER_ADMIN and PRODUCT_MANAGER can create categories.');
              return;
            }
            const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            const customCats = JSON.parse(localStorage.getItem('sn_custom_categories_v1') || '[]');
            const newId = 10 + customCats.length;
            const imgUrl = imageBase64 || `${BASE_PATH}/images/cat-spices.jpg`;
            const newCat = { id: newId, slug, name, subtitle, description, imageUrl: imgUrl };
            customCats.push(newCat);
            localStorage.setItem('sn_custom_categories_v1', JSON.stringify(customCats));
            appendCategoryToAdminDom(newCat);
            createCatForm.reset();
            showToast(`Created category "${name}" with banner image!`);
            return;
          }

          const res = await fetch('/api/admin/categories/create', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-admin-email': getActiveAdminEmail()
            },
            body: JSON.stringify({ name, subtitle, description, imageBase64 })
          });
          const data = await res.json();
          if (!res.ok) {
            showToast(data.error || 'Failed to create category');
            return;
          }
          showToast(`Created category "${data.category.name}"!`);
          setTimeout(() => window.location.reload(), 700);
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    // 2. Change Existing Category Image
    document.querySelectorAll('.sn-admin-cat-img-form').forEach(form => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const categoryId = Number(fd.get('categoryId'));
        const file = fd.get('imageFile');
        if (!file || !file.size) {
          showToast('Please select a category image file.');
          return;
        }

        try {
          const imageBase64 = await readFileAsDataUrl(file);
          if (IS_STATIC_SHOWCASE) {
            const email = getActiveAdminEmail();
            if (email !== 'superadmin@sasynaturals.com' && email !== 'catalog@sasynaturals.com') {
              showToast('403 RBAC Permission Denied: Only SUPER_ADMIN and PRODUCT_MANAGER can change category images.');
              return;
            }
            const map = JSON.parse(localStorage.getItem('sn_custom_cat_images_v1') || '{}');
            map[categoryId] = imageBase64;
            localStorage.setItem('sn_custom_cat_images_v1', JSON.stringify(map));
            updateDomCategoryImages(categoryId, imageBase64);
            showToast(`Updated category #${categoryId} banner photo!`);
            return;
          }

          const res = await fetch('/api/admin/categories/upload-image', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-admin-email': getActiveAdminEmail()
            },
            body: JSON.stringify({ categoryId, imageBase64 })
          });
          const data = await res.json();
          if (!res.ok) {
            showToast(data.error || 'Category image upload failed');
            return;
          }
          updateDomCategoryImages(categoryId, data.publicUrl);
          showToast(`Updated category photo (${data.publicUrl})`);
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    // 3. Dedicated Product Image Uploader (Primary Photo or Secondary Gallery)
    async function handleProductPhotoUpload({ productId, file, caption, setAsPrimary }) {
      if (!file || !file.size) {
        showToast('Please select an image file.');
        return;
      }
      const imageBase64 = await readFileAsDataUrl(file);

      if (IS_STATIC_SHOWCASE) {
        const email = getActiveAdminEmail();
        if (email !== 'superadmin@sasynaturals.com' && email !== 'catalog@sasynaturals.com') {
          showToast('403 RBAC Permission Denied: Only SUPER_ADMIN and PRODUCT_MANAGER can upload product images.');
          return;
        }
        if (setAsPrimary) {
          const map = JSON.parse(localStorage.getItem('sn_custom_prod_images_v1') || '{}');
          map[productId] = imageBase64;
          localStorage.setItem('sn_custom_prod_images_v1', JSON.stringify(map));
          updateDomProductImages(productId, imageBase64);
        }
        showToast(`Updated photo for product #${productId} (${setAsPrimary ? 'Primary Storefront Photo' : 'Added to Gallery'})`);
        return;
      }

      const res = await fetch('/api/admin/products/upload-image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-email': getActiveAdminEmail()
        },
        body: JSON.stringify({
          productId,
          imageBase64,
          caption,
          setAsPrimary
        })
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Image upload failed');
        return;
      }
      if (setAsPrimary) {
        updateDomProductImages(productId, data.publicUrl);
      }
      showToast(`Saved ${data.publicUrl} (${data.bytes} bytes verified)`);
    }

    const imgUploadForm = document.getElementById('sn-admin-image-upload-form');
    if (imgUploadForm) {
      imgUploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(imgUploadForm);
        const file = fd.get('imageFile');
        const productId = Number(fd.get('productId'));
        const caption = fd.get('caption');
        const setAsPrimary = fd.get('setAsPrimary') !== 'false';
        try {
          await handleProductPhotoUpload({ productId, file, caption, setAsPrimary });
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    // 4. Inline Quick Product Image Changer in Products Table
    document.querySelectorAll('.sn-admin-inline-prod-img-form').forEach(form => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const productId = Number(fd.get('productId'));
        const file = fd.get('imageFile');
        try {
          await handleProductPhotoUpload({
            productId,
            file,
            caption: 'Primary Pack Photo',
            setAsPrimary: true
          });
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    document.querySelectorAll('.sn-admin-ship-form').forEach(form => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const payload = {
          orderNumber: fd.get('orderNumber'),
          fulfilmentStatus: fd.get('fulfilmentStatus'),
          courierName: fd.get('courierName'),
          trackingNumber: fd.get('trackingNumber'),
          trackingUrl: fd.get('trackingUrl'),
          dispatchDate: fd.get('dispatchDate'),
          manualShippingChargeInr: fd.get('manualShippingChargeInr')
        };

        if (IS_STATIC_SHOWCASE) {
          const email = getActiveAdminEmail();
          if (email === 'catalog@sasynaturals.com' || email === 'accounts@sasynaturals.com') {
            showToast(`RBAC Permission Denied: ${email} cannot update shipping/fulfilment.`);
            return;
          }
          showToast(`[Showcase RBAC Verified] Updated ${payload.orderNumber} to "${payload.fulfilmentStatus}" (Shipping ₹${payload.manualShippingChargeInr || 0})`);
          return;
        }

        const res = await fetch('/api/admin/orders/fulfilment', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-email': getActiveAdminEmail()
          },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Permission denied');
          return;
        }
        showToast(`Updated ${payload.orderNumber} to "${payload.fulfilmentStatus}"`);
        setTimeout(() => window.location.reload(), 700);
      });
    });

    // 4B. 1-Click Copy Courier Address Label & Pre-Dispatch Delivery Address Editor
    document.querySelectorAll('[data-copy-shipping-label]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const labelText = btn.getAttribute('data-copy-shipping-label') || '';
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(labelText);
          }
          showToast(`Copied Courier Label: ${labelText}`);
        } catch {
          showToast(`Courier Label: ${labelText}`);
        }
      });
    });

    document.querySelectorAll('[data-toggle-edit-addr]').forEach(btn => {
      btn.addEventListener('click', () => {
        const ordNum = btn.getAttribute('data-toggle-edit-addr');
        const form = document.querySelector(`[data-edit-addr-form="${ordNum}"]`);
        if (form) {
          form.style.display = form.style.display === 'none' ? 'block' : 'none';
        }
      });
    });

    document.querySelectorAll('.sn-admin-edit-address-form').forEach(form => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const payload = Object.fromEntries(fd.entries());
        const email = getActiveAdminEmail();

        if (IS_STATIC_SHOWCASE) {
          if (email === 'catalog@sasynaturals.com' || email === 'accounts@sasynaturals.com') {
            showToast(`403 RBAC Permission Denied: ${email} cannot edit order delivery addresses.`);
            return;
          }
          const displayEl = document.querySelector(`[data-order-address-display="${payload.orderNumber}"]`);
          if (displayEl) {
            displayEl.innerHTML = `
              <strong>${payload.customerName}</strong> • <span style="font-family:var(--sn-font-mono);">${payload.customerPhone}</span><br/>
              ${payload.shippingLine1}${payload.shippingLine2 ? ', ' + payload.shippingLine2 : ''}<br/>
              <strong>${payload.shippingCity}, ${payload.shippingState} - <span style="font-family:var(--sn-font-mono);color:var(--sn-bg-forest);">${payload.shippingPincode}</span></strong>
            `;
          }
          form.style.display = 'none';
          showToast(`Updated delivery address for ${payload.orderNumber}!`);
          return;
        }

        const res = await fetch('/api/admin/orders/update-address', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-email': email
          },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Failed to update delivery address');
          return;
        }
        showToast(`Updated delivery address for ${payload.orderNumber}!`);
        setTimeout(() => window.location.reload(), 600);
      });
    });

    document.querySelectorAll('.sn-admin-stock-form').forEach(form => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        if (IS_STATIC_SHOWCASE) {
          const email = getActiveAdminEmail();
          if (email !== 'superadmin@sasynaturals.com' && email !== 'catalog@sasynaturals.com') {
            showToast(`RBAC Permission Denied: ${email} cannot modify inventory.`);
            return;
          }
          showToast(`[Showcase RBAC Verified] Updated stock & threshold for variant #${fd.get('variantId')}`);
          return;
        }

        const res = await fetch('/api/admin/inventory/adjust', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-email': getActiveAdminEmail()
          },
          body: JSON.stringify({
            variantId: Number(fd.get('variantId')),
            newStockQty: Number(fd.get('newStockQty')),
            lowStockThreshold: Number(fd.get('lowStockThreshold') || 10),
            reason: fd.get('reason') || 'ADMIN_STOCK_UPDATE'
          })
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'RBAC denied');
          return;
        }
        showToast(`Stock & threshold updated for variant #${fd.get('variantId')}`);
        setTimeout(() => window.location.reload(), 600);
      });
    });

    // 4C. Smart Collapsible Order Accordions (Individual & Expand/Collapse All)
    document.querySelectorAll('[data-toggle-order-accordion]').forEach(btn => {
      btn.addEventListener('click', () => {
        const ordNum = btn.getAttribute('data-toggle-order-accordion');
        const bodyEl = document.querySelector(`[data-order-accordion-body="${ordNum}"]`);
        if (!bodyEl) return;
        const isCurrentlyHidden = bodyEl.style.display === 'none';
        bodyEl.style.display = isCurrentlyHidden ? 'block' : 'none';
        btn.textContent = isCurrentlyHidden ? '▴ Collapse' : '▾ Manage / Dispatch';
        btn.className = `sn-btn ${isCurrentlyHidden ? 'sn-btn-outline' : 'sn-btn-forest'} sn-btn-sm`;
      });
    });

    const expandAllOrdersBtn = document.getElementById('sn-admin-orders-expand-all-btn');
    if (expandAllOrdersBtn) {
      expandAllOrdersBtn.addEventListener('click', () => {
        const visibleCards = Array.from(document.querySelectorAll('#sn-admin-orders-cards-container [data-order-card]:not(.sn-row-hidden)'));
        const anyCollapsed = visibleCards.some(card => {
          const body = card.querySelector('[data-order-accordion-body]');
          return body && body.style.display === 'none';
        });
        visibleCards.forEach(card => {
          const body = card.querySelector('[data-order-accordion-body]');
          const toggleBtn = card.querySelector('[data-toggle-order-accordion]');
          if (body) body.style.display = anyCollapsed ? 'block' : 'none';
          if (toggleBtn) {
            toggleBtn.textContent = anyCollapsed ? '▴ Collapse' : '▾ Manage / Dispatch';
            toggleBtn.className = `sn-btn ${anyCollapsed ? 'sn-btn-outline' : 'sn-btn-forest'} sn-btn-sm`;
          }
        });
        expandAllOrdersBtn.textContent = anyCollapsed ? '▴ Collapse All Orders' : '▾ Expand All Orders';
      });
    }

    // 4D. Contextual Product Edit & Media Modal Controller (Opens on "✏️ Edit" in Tab 3 Table)
    const editProdModal = document.getElementById('sn-admin-edit-product-modal');
    const editSellInput = document.getElementById('sn-edit-prod-sell');
    const editMrpInput = document.getElementById('sn-edit-prod-mrp');
    const editPackPreview = document.getElementById('sn-edit-prod-pack-preview');

    function updateEditModalPackPreview() {
      if (!editPackPreview) return;
      const baseSell = Math.max(10, Number(editSellInput ? editSellInput.value : 140) || 140);
      const baseMrp = Math.max(baseSell, Number(editMrpInput ? editMrpInput.value : baseSell + 30) || (baseSell + 30));
      const p100 = Math.round(baseSell);
      const p250 = Math.round(baseSell * 2.35);
      const p500 = Math.round(baseSell * 4.45);
      const p1000 = Math.round(baseSell * 8.5);
      editPackPreview.innerHTML = `<strong>Auto-Scaled 4-Pack Prices:</strong> 100 g: <strong>₹${p100}</strong> (MRP ₹${Math.round(baseMrp)}) &bull; 250 g: <strong>₹${p250}</strong> &bull; 500 g: <strong>₹${p500}</strong> &bull; 1 kg: <strong>₹${p1000}</strong>`;
    }

    if (editSellInput) editSellInput.addEventListener('input', updateEditModalPackPreview);
    if (editMrpInput) editMrpInput.addEventListener('input', updateEditModalPackPreview);

    function closeEditProductModal() {
      if (editProdModal) {
        editProdModal.style.display = 'none';
      }
    }

    document.querySelectorAll('[data-close-prod-modal]').forEach(btn => {
      btn.addEventListener('click', closeEditProductModal);
    });

    if (editProdModal) {
      editProdModal.addEventListener('click', (e) => {
        if (e.target === editProdModal) closeEditProductModal();
      });
    }

    const editCatModal = document.getElementById('sn-admin-edit-category-modal');

    function closeEditCategoryModal() {
      if (editCatModal) {
        editCatModal.style.display = 'none';
      }
    }

    document.querySelectorAll('[data-close-cat-modal]').forEach(btn => {
      btn.addEventListener('click', closeEditCategoryModal);
    });

    if (editCatModal) {
      editCatModal.addEventListener('click', (e) => {
        if (e.target === editCatModal) closeEditCategoryModal();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (editProdModal && editProdModal.style.display !== 'none') closeEditProductModal();
        if (editCatModal && editCatModal.style.display !== 'none') closeEditCategoryModal();
      }
    });

    document.querySelectorAll('[data-load-prod-editor]').forEach(btn => {
      btn.addEventListener('click', () => {
        const prodId = btn.getAttribute('data-load-prod-editor');
        const tr = document.querySelector(`[data-admin-prod-row="${prodId}"]`);

        const selectEl = document.getElementById('sn-edit-prod-select');
        if (selectEl && prodId) selectEl.value = prodId;
        const uploadSelectEl = document.getElementById('sn-upload-prod-select');
        if (uploadSelectEl && prodId) uploadSelectEl.value = prodId;

        if (tr) {
          const sku = tr.getAttribute('data-prod-sku') || '';
          const name = tr.getAttribute('data-prod-name') || '';
          const catId = tr.getAttribute('data-prod-cat-id') || '1';
          const origin = tr.getAttribute('data-prod-origin') || '';
          const sell100 = tr.getAttribute('data-prod-100g-sell') || '140';
          const mrp100 = tr.getAttribute('data-prod-100g-mrp') || '170';
          const gst = tr.getAttribute('data-prod-gst') || '5';
          const hsn = tr.getAttribute('data-prod-hsn') || '080290';
          const desc = tr.getAttribute('data-prod-desc') || '';
          const img = tr.getAttribute('data-prod-img') || '';
          const isActive = tr.getAttribute('data-prod-active') || '1';
          const isFeatured = tr.getAttribute('data-prod-featured') || '0';
          const isBestseller = tr.getAttribute('data-prod-bestseller') || '0';
          const isNew = tr.getAttribute('data-prod-new') || '0';

          const thumbEl = document.getElementById('sn-edit-modal-thumb');
          const skuEl = document.getElementById('sn-edit-modal-sku');
          const headingEl = document.getElementById('sn-edit-modal-heading');
          const nameInput = document.getElementById('sn-edit-prod-name');
          const catSelect = document.getElementById('sn-edit-prod-cat');
          const originInput = document.getElementById('sn-edit-prod-origin');
          const gstSelect = document.getElementById('sn-edit-prod-gst');
          const hsnInput = document.getElementById('sn-edit-prod-hsn');
          const descInput = document.getElementById('sn-edit-prod-desc');
          const activeSelect = document.getElementById('sn-edit-prod-active');
          const featSelect = document.getElementById('sn-edit-prod-featured');
          const bestSelect = document.getElementById('sn-edit-prod-bestseller');
          const newSelect = document.getElementById('sn-edit-prod-new');

          if (thumbEl && img) thumbEl.src = img;
          if (skuEl) skuEl.textContent = `${sku} • Product #${prodId} • HSN ${hsn}`;
          if (headingEl) headingEl.textContent = `Edit ${name}`;
          if (nameInput) nameInput.value = name;
          if (catSelect) catSelect.value = catId;
          if (originInput) originInput.value = origin;
          if (editSellInput) editSellInput.value = sell100;
          if (editMrpInput) editMrpInput.value = mrp100;
          if (gstSelect) gstSelect.value = gst;
          if (hsnInput) hsnInput.value = hsn;
          if (descInput) descInput.value = desc;
          if (activeSelect) activeSelect.value = isActive;
          if (featSelect) featSelect.value = isFeatured;
          if (bestSelect) bestSelect.value = isBestseller;
          if (newSelect) newSelect.value = isNew;
          updateEditModalPackPreview();
        }

        if (editProdModal) {
          editProdModal.style.display = 'flex';
        }
      });
    });

    // 4D-2. Contextual Category Edit Modal Controller (Opens on "✏️ Edit" in Tab 3.2 Categories Table)
    document.querySelectorAll('[data-load-cat-editor]').forEach(btn => {
      btn.addEventListener('click', () => {
        const catId = btn.getAttribute('data-load-cat-editor');
        const tr = document.querySelector(`[data-admin-cat-row="${catId}"]`);
        const idInput = document.getElementById('sn-edit-cat-id');
        if (idInput && catId) idInput.value = catId;

        if (tr) {
          const slug = tr.getAttribute('data-cat-slug') || '';
          const name = tr.getAttribute('data-cat-name') || '';
          const subtitle = tr.getAttribute('data-cat-subtitle') || '';
          const desc = tr.getAttribute('data-cat-desc') || '';
          const img = tr.getAttribute('data-cat-img') || '';
          const isActive = tr.getAttribute('data-cat-active') || '1';

          const thumbEl = document.getElementById('sn-edit-cat-modal-thumb');
          const slugEl = document.getElementById('sn-edit-cat-modal-slug');
          const headingEl = document.getElementById('sn-edit-cat-modal-heading');
          const nameInput = document.getElementById('sn-edit-cat-name');
          const subtitleInput = document.getElementById('sn-edit-cat-subtitle');
          const descInput = document.getElementById('sn-edit-cat-desc');
          const activeSelect = document.getElementById('sn-edit-cat-active');
          const fileInput = document.getElementById('sn-edit-cat-file');

          if (thumbEl && img) thumbEl.src = img;
          if (slugEl) slugEl.textContent = `/category/${slug} • Category #${catId}`;
          if (headingEl) headingEl.textContent = `Edit Category: ${name}`;
          if (nameInput) nameInput.value = name;
          if (subtitleInput) subtitleInput.value = subtitle;
          if (descInput) descInput.value = desc;
          if (activeSelect) activeSelect.value = isActive;
          if (fileInput) fileInput.value = '';
        }

        if (editCatModal) {
          editCatModal.style.display = 'flex';
        }
      });
    });

    // 4E. Unified Admin List Filter, Search & Global Pagination Controller (Tabs 1, 3, 4, 7, 8)
    function createAdminListController({
      getItems,
      matchItem,
      countBadgeEl,
      paginationEl,
      defaultPageSize = 10,
      unitLabel = 'items'
    }) {
      let currentPage = 1;
      let pageSize = defaultPageSize;

      function render(resetPage = false) {
        const allItems = Array.from(getItems() || []);
        if (allItems.length === 0) {
          if (paginationEl) paginationEl.innerHTML = '';
          return;
        }
        if (resetPage) currentPage = 1;

        const matchedItems = allItems.filter(item => matchItem(item));
        const totalAll = allItems.length;
        const totalMatched = matchedItems.length;

        const effectivePageSize = pageSize === 'ALL' ? Math.max(1, totalMatched) : (Number(pageSize) || defaultPageSize);
        const totalPages = Math.max(1, Math.ceil(totalMatched / effectivePageSize));
        if (currentPage > totalPages) currentPage = totalPages;
        if (currentPage < 1) currentPage = 1;

        const startIdx = (currentPage - 1) * effectivePageSize;
        const endIdx = startIdx + effectivePageSize;
        const visibleSet = new Set(matchedItems.slice(startIdx, endIdx));

        allItems.forEach(item => {
          const isVisible = visibleSet.has(item);
          item.classList.toggle('sn-row-hidden', !isVisible);
          item.style.display = isVisible ? '' : 'none';
        });

        if (countBadgeEl) {
          if (totalMatched === 0) {
            countBadgeEl.textContent = `Showing 0 of ${totalAll} ${unitLabel}`;
          } else if (totalMatched <= effectivePageSize) {
            countBadgeEl.textContent = `Showing ${totalMatched} of ${totalAll} ${unitLabel}`;
          } else {
            countBadgeEl.textContent = `Showing ${startIdx + 1}–${Math.min(endIdx, totalMatched)} of ${totalMatched} (Total ${totalAll})`;
          }
        }

        if (paginationEl) {
          paginationEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span>Rows per page:</span>
              <select data-page-size-select class="sn-select" style="width:auto;min-width:74px;padding:4px 8px;font-size:0.75rem;">
                ${[10, 15, 25, 'ALL'].map(sz => `
                  <option value="${sz}" ${String(pageSize) === String(sz) ? 'selected' : ''}>${sz === 'ALL' ? 'All (' + totalMatched + ')' : sz}</option>
                `).join('')}
              </select>
              <span>Page <strong>${currentPage}</strong> of <strong>${totalPages}</strong> (${totalMatched} matching)</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              <button type="button" data-page-prev class="sn-btn sn-btn-outline sn-btn-sm" style="min-height:30px;padding:4px 10px;font-size:0.74rem;" ${currentPage <= 1 ? 'disabled' : ''}>&larr; Prev</button>
              <button type="button" data-page-next class="sn-btn sn-btn-outline sn-btn-sm" style="min-height:30px;padding:4px 10px;font-size:0.74rem;" ${currentPage >= totalPages ? 'disabled' : ''}>Next &rarr;</button>
            </div>
          `;

          const sizeSelect = paginationEl.querySelector('[data-page-size-select]');
          if (sizeSelect) {
            sizeSelect.addEventListener('change', () => {
              pageSize = sizeSelect.value === 'ALL' ? 'ALL' : Number(sizeSelect.value);
              currentPage = 1;
              render(false);
            });
          }
          const prevBtn = paginationEl.querySelector('[data-page-prev]');
          if (prevBtn) {
            prevBtn.addEventListener('click', () => {
              if (currentPage > 1) {
                currentPage -= 1;
                render(false);
              }
            });
          }
          const nextBtn = paginationEl.querySelector('[data-page-next]');
          if (nextBtn) {
            nextBtn.addEventListener('click', () => {
              if (currentPage < totalPages) {
                currentPage += 1;
                render(false);
              }
            });
          }
        }
      }

      render(true);
      return { render };
    }

    // List 1: Tab 1 Orders (Triage Queue Pills + Search + Payment Filter + Pagination)
    let activeOrderQueue = 'ALL';
    const orderSearchEl = document.getElementById('sn-admin-orders-search');
    const orderPaymentFilterEl = document.getElementById('sn-admin-orders-payment-filter');
    const ordersController = createAdminListController({
      getItems: () => document.querySelectorAll('#sn-admin-orders-cards-container [data-order-card]'),
      matchItem: (card) => {
        const q = (orderSearchEl ? orderSearchEl.value : '').trim().toLowerCase();
        const payFilter = (orderPaymentFilterEl ? orderPaymentFilterEl.value : 'ALL').toUpperCase();
        const fStatus = card.getAttribute('data-order-fulfilment') || '';
        const pStatus = (card.getAttribute('data-order-payment') || '').toUpperCase();
        const needsDispatch = card.getAttribute('data-order-needs-dispatch') === '1';

        let matchQueue = true;
        if (activeOrderQueue === 'NEEDS_DISPATCH') matchQueue = needsDispatch;
        else if (activeOrderQueue === 'SHIPPED') matchQueue = fStatus === 'Shipped';
        else if (activeOrderQueue === 'DELIVERED') matchQueue = fStatus === 'Delivered';
        else if (activeOrderQueue === 'COD_PENDING') matchQueue = pStatus === 'COD_PENDING';

        const matchPay = payFilter === 'ALL' || pStatus === payFilter;
        const matchQ = !q || card.textContent.toLowerCase().includes(q);
        return matchQueue && matchPay && matchQ;
      },
      countBadgeEl: document.getElementById('sn-admin-orders-count-badge'),
      paginationEl: document.getElementById('sn-admin-orders-pagination'),
      defaultPageSize: 10,
      unitLabel: 'orders'
    });

    document.querySelectorAll('[data-order-queue-pill]').forEach(pill => {
      pill.addEventListener('click', () => {
        activeOrderQueue = (pill.getAttribute('data-order-queue-pill') || 'ALL').toUpperCase();
        document.querySelectorAll('[data-order-queue-pill]').forEach(p => {
          p.className = p === pill ? 'sn-btn sn-btn-forest sn-btn-sm' : 'sn-btn sn-btn-outline sn-btn-sm';
        });
        ordersController.render(true);
      });
    });
    if (orderSearchEl) orderSearchEl.addEventListener('input', () => ordersController.render(true));
    if (orderPaymentFilterEl) orderPaymentFilterEl.addEventListener('change', () => ordersController.render(true));

    // List 2: Tab 3 Products Catalogue (Search + Category Filter + Flag Filter + Pagination)
    const prodSearchEl = document.getElementById('sn-admin-prod-search');
    const prodCatFilterEl = document.getElementById('sn-admin-prod-cat-filter');
    const prodFlagFilterEl = document.getElementById('sn-admin-prod-flag-filter');
    const productsController = createAdminListController({
      getItems: () => document.querySelectorAll('#sn-admin-products-table tbody tr'),
      matchItem: (tr) => {
        const q = (prodSearchEl ? prodSearchEl.value : '').trim().toLowerCase();
        const catFilter = (prodCatFilterEl ? prodCatFilterEl.value : 'ALL').toUpperCase();
        const flagFilter = (prodFlagFilterEl ? prodFlagFilterEl.value : 'ALL').toUpperCase();

        const matchCat = catFilter === 'ALL' || tr.getAttribute('data-prod-cat-id') === catFilter;
        let matchFlag = true;
        if (flagFilter === 'ACTIVE') matchFlag = tr.getAttribute('data-prod-active') === '1';
        else if (flagFilter === 'INACTIVE') matchFlag = tr.getAttribute('data-prod-active') === '0';
        else if (flagFilter === 'BESTSELLER') matchFlag = tr.getAttribute('data-prod-bestseller') === '1';
        else if (flagFilter === 'FEATURED') matchFlag = tr.getAttribute('data-prod-featured') === '1';
        else if (flagFilter === 'NEW') matchFlag = tr.getAttribute('data-prod-new') === '1';

        const matchQ = !q || tr.textContent.toLowerCase().includes(q);
        return matchCat && matchFlag && matchQ;
      },
      countBadgeEl: document.getElementById('sn-admin-prod-count-badge'),
      paginationEl: document.getElementById('sn-admin-products-pagination'),
      defaultPageSize: 10,
      unitLabel: 'products'
    });
    if (prodSearchEl) prodSearchEl.addEventListener('input', () => productsController.render(true));
    if (prodCatFilterEl) prodCatFilterEl.addEventListener('change', () => productsController.render(true));
    if (prodFlagFilterEl) prodFlagFilterEl.addEventListener('change', () => productsController.render(true));

    // List 3: Tab 4 Inventory 88-Variant Stock Table (Search + Pack Size Filter + Low Stock Toggle + Pagination)
    const invSearch = document.getElementById('sn-admin-inv-search');
    const invPackFilter = document.getElementById('sn-admin-inv-pack-filter');
    const invLowOnly = document.getElementById('sn-admin-inv-low-only');
    const inventoryController = createAdminListController({
      getItems: () => document.querySelectorAll('#sn-admin-inventory-table tbody tr'),
      matchItem: (tr) => {
        const q = (invSearch ? invSearch.value : '').trim().toLowerCase();
        const packVal = invPackFilter ? invPackFilter.value : 'all';
        const lowOnly = invLowOnly ? invLowOnly.checked : false;
        const sku = tr.getAttribute('data-inv-sku') || '';
        const isLow = tr.getAttribute('data-inv-low') === '1';
        const pack = tr.getAttribute('data-inv-pack') || '';
        const matchQ = !q || sku.includes(q) || tr.textContent.toLowerCase().includes(q);
        const matchPack = packVal.toUpperCase() === 'ALL' || pack === packVal;
        const matchLow = !lowOnly || isLow;
        return matchQ && matchPack && matchLow;
      },
      countBadgeEl: document.getElementById('sn-admin-inv-count-badge'),
      paginationEl: document.getElementById('sn-admin-inventory-pagination'),
      defaultPageSize: 15,
      unitLabel: 'SKUs'
    });
    if (invSearch) invSearch.addEventListener('input', () => inventoryController.render(true));
    if (invPackFilter) invPackFilter.addEventListener('change', () => inventoryController.render(true));
    if (invLowOnly) invLowOnly.addEventListener('change', () => inventoryController.render(true));

    // List 4: Tab 4 Stock Movement Ledger (Pagination)
    createAdminListController({
      getItems: () => document.querySelectorAll('#sn-admin-movements-table tbody tr'),
      matchItem: () => true,
      countBadgeEl: null,
      paginationEl: document.getElementById('sn-admin-movements-pagination'),
      defaultPageSize: 10,
      unitLabel: 'movements'
    });

    // List 5: Tab 7 Immutable Admin Audit Logs (Search + Pagination)
    const auditSearchEl = document.getElementById('sn-admin-audit-search');
    const auditController = createAdminListController({
      getItems: () => document.querySelectorAll('#sn-admin-audit-logs-table tbody tr'),
      matchItem: (tr) => {
        const q = (auditSearchEl ? auditSearchEl.value : '').trim().toLowerCase();
        return !q || tr.textContent.toLowerCase().includes(q);
      },
      countBadgeEl: document.getElementById('sn-admin-audit-count-badge'),
      paginationEl: document.getElementById('sn-admin-audit-pagination'),
      defaultPageSize: 10,
      unitLabel: 'logs'
    });
    if (auditSearchEl) auditSearchEl.addEventListener('input', () => auditController.render(true));

    // List 6: Tab 8 Customer Notification Dispatch Logs (Search + Pagination)
    const notifSearchEl = document.getElementById('sn-admin-notif-search');
    const notifController = createAdminListController({
      getItems: () => document.querySelectorAll('#sn-admin-notif-logs-table tbody tr'),
      matchItem: (tr) => {
        const q = (notifSearchEl ? notifSearchEl.value : '').trim().toLowerCase();
        return !q || tr.textContent.toLowerCase().includes(q);
      },
      countBadgeEl: document.getElementById('sn-admin-notif-count-badge'),
      paginationEl: document.getElementById('sn-admin-notif-pagination'),
      defaultPageSize: 10,
      unitLabel: 'dispatches'
    });
    if (notifSearchEl) notifSearchEl.addEventListener('input', () => notifController.render(true));

    // 5. Create New Product (with Optional Product Photo)
    const newProdForm = document.getElementById('sn-admin-create-product-form');
    if (newProdForm) {
      newProdForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(newProdForm);
        const file = fd.get('productImageFile');
        const payload = {
          name: fd.get('name'),
          skuBase: fd.get('skuBase'),
          categoryId: fd.get('categoryId'),
          base100gInr: fd.get('base100gInr'),
          gstPercent: fd.get('gstPercent'),
          originRegion: fd.get('originRegion'),
          shortDescription: fd.get('shortDescription')
        };

        try {
          const imageBase64 = await readFileAsDataUrl(file);
          if (imageBase64) payload.imageBase64 = imageBase64;

          if (IS_STATIC_SHOWCASE) {
            const email = getActiveAdminEmail();
            if (email !== 'superadmin@sasynaturals.com' && email !== 'catalog@sasynaturals.com') {
              showToast(`RBAC Permission Denied: ${email} cannot create products.`);
              return;
            }
            showToast(`Created product "${payload.name}" with 4 pack variants${imageBase64 ? ' & custom photo' : ''}!`);
            newProdForm.reset();
            return;
          }

          const res = await fetch('/api/admin/products/create', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-admin-email': getActiveAdminEmail()
            },
            body: JSON.stringify(payload)
          });
          const data = await res.json();
          if (!res.ok) {
            showToast(data.error || 'Failed to create product');
            return;
          }
          showToast(`Created product "${data.product.name}" with 4 pack variants!`);
          setTimeout(() => window.location.reload(), 800);
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    // 6. Edit Existing Product, Category Assignment, Pack Prices, Flags & Publish/Deactivate
    const editProdForm = document.getElementById('sn-admin-edit-product-form');
    if (editProdForm) {
      editProdForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(editProdForm);
        const payload = Object.fromEntries(fd.entries());
        if (IS_STATIC_SHOWCASE) {
          const email = getActiveAdminEmail();
          if (email !== 'superadmin@sasynaturals.com' && email !== 'catalog@sasynaturals.com') {
            showToast('403 RBAC Permission Denied: Only SUPER_ADMIN and PRODUCT_MANAGER can edit products.');
            return;
          }
          const tr = document.querySelector(`[data-admin-prod-row="${payload.productId}"]`);
          if (tr) {
            if (payload.name) tr.setAttribute('data-prod-name', payload.name);
            if (payload.categoryId) tr.setAttribute('data-prod-cat-id', payload.categoryId);
            if (payload.originRegion) tr.setAttribute('data-prod-origin', payload.originRegion);
            const nameEl = tr.querySelector(`[data-prod-name-display="${payload.productId}"]`);
            if (nameEl && payload.name) nameEl.textContent = payload.name;
            const catBadge = tr.querySelector(`[data-prod-cat-badge="${payload.productId}"]`);
            const catSelect = document.getElementById('sn-edit-prod-cat');
            if (catBadge && catSelect && catSelect.selectedIndex >= 0) {
              catBadge.textContent = catSelect.options[catSelect.selectedIndex].text;
            }
          }
          closeEditProductModal();
          showToast(`[Showcase Verified] Updated product #${payload.productId} ("${payload.name}") & category!`);
          return;
        }
        const res = await fetch('/api/admin/products/update', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-email': getActiveAdminEmail()
          },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Product update failed');
          return;
        }
        closeEditProductModal();
        showToast(`Updated product "${data.name}"!`);
        setTimeout(() => window.location.reload(), 600);
      });
    }

    // 6B. Edit Existing Category (Name, Subtitle, Description, Status & Optional Banner Photo)
    const editCatForm = document.getElementById('sn-admin-edit-category-form');
    if (editCatForm) {
      editCatForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(editCatForm);
        const categoryId = Number(fd.get('categoryId'));
        const name = String(fd.get('name') || '').trim();
        const subtitle = String(fd.get('subtitle') || '').trim();
        const description = String(fd.get('description') || '').trim();
        const isActive = Number(fd.get('isActive') || 1);
        const file = fd.get('categoryImageFile');

        try {
          const imageBase64 = await readFileAsDataUrl(file);
          if (IS_STATIC_SHOWCASE) {
            const email = getActiveAdminEmail();
            if (email !== 'superadmin@sasynaturals.com' && email !== 'catalog@sasynaturals.com') {
              showToast('403 RBAC Permission Denied: Only SUPER_ADMIN and PRODUCT_MANAGER can edit categories.');
              return;
            }
            const tr = document.querySelector(`[data-admin-cat-row="${categoryId}"]`);
            if (tr) {
              tr.setAttribute('data-cat-name', name);
              tr.setAttribute('data-cat-subtitle', subtitle);
              tr.setAttribute('data-cat-desc', description);
              tr.setAttribute('data-cat-active', String(isActive));
              const nameEl = tr.querySelector(`[data-cat-name-display="${categoryId}"]`);
              const subEl = tr.querySelector(`[data-cat-subtitle-display="${categoryId}"]`);
              const descEl = tr.querySelector(`[data-cat-desc-display="${categoryId}"]`);
              if (nameEl) nameEl.textContent = name;
              if (subEl) subEl.textContent = subtitle;
              if (descEl) descEl.textContent = description;
            }
            if (imageBase64) updateDomCategoryImages(categoryId, imageBase64);
            closeEditCategoryModal();
            showToast(`[Showcase Verified] Updated category "${name}"!`);
            return;
          }

          const res = await fetch('/api/admin/categories/update', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-admin-email': getActiveAdminEmail()
            },
            body: JSON.stringify({
              categoryId,
              name,
              subtitle,
              description,
              isActive,
              imageBase64: imageBase64 || undefined
            })
          });
          const data = await res.json();
          if (!res.ok) {
            showToast(data.error || 'Failed to update category');
            return;
          }
          closeEditCategoryModal();
          showToast(`Updated category "${data.category.name}"!`);
          setTimeout(() => window.location.reload(), 600);
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    // Inline Product Publish/Deactivate Toggle Buttons
    document.querySelectorAll('[data-toggle-prod-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const productId = Number(btn.getAttribute('data-toggle-prod-id'));
        const curActive = btn.getAttribute('data-toggle-prod-active') === '1';
        const nextActive = curActive ? 0 : 1;
        if (IS_STATIC_SHOWCASE) {
          const email = getActiveAdminEmail();
          if (email !== 'superadmin@sasynaturals.com' && email !== 'catalog@sasynaturals.com') {
            showToast('403 RBAC Permission Denied: Only SUPER_ADMIN and PRODUCT_MANAGER can publish/deactivate products.');
            return;
          }
          btn.setAttribute('data-toggle-prod-active', String(nextActive));
          btn.textContent = nextActive ? 'Active' : 'Inactive';
          btn.className = `sn-btn ${nextActive ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm`;
          showToast(`Product #${productId} is now ${nextActive ? 'Published (Active)' : 'Deactivated'}`);
          return;
        }
        const res = await fetch('/api/admin/products/update', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-email': getActiveAdminEmail()
          },
          body: JSON.stringify({ productId, isActive: nextActive })
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Failed to toggle product status');
          return;
        }
        showToast(`Product "${data.name}" ${nextActive ? 'Published' : 'Deactivated'}!`);
        setTimeout(() => window.location.reload(), 500);
      });
    });

    // Inline Category Publish/Deactivate Toggle Buttons
    document.querySelectorAll('[data-toggle-cat-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const categoryId = Number(btn.getAttribute('data-toggle-cat-id'));
        const curActive = btn.getAttribute('data-toggle-cat-active') === '1';
        const nextActive = curActive ? 0 : 1;
        if (IS_STATIC_SHOWCASE) {
          const email = getActiveAdminEmail();
          if (email !== 'superadmin@sasynaturals.com' && email !== 'catalog@sasynaturals.com') {
            showToast('403 RBAC Permission Denied: Only SUPER_ADMIN and PRODUCT_MANAGER can toggle categories.');
            return;
          }
          btn.setAttribute('data-toggle-cat-active', String(nextActive));
          btn.textContent = nextActive ? 'Published (Active)' : 'Deactivated';
          btn.className = `sn-btn ${nextActive ? 'sn-btn-forest' : 'sn-btn-outline'} sn-btn-sm`;
          showToast(`Category #${categoryId} is now ${nextActive ? 'Published' : 'Deactivated'}`);
          return;
        }
        const res = await fetch('/api/admin/categories/toggle-status', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-email': getActiveAdminEmail()
          },
          body: JSON.stringify({ categoryId, isActive: nextActive })
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Failed to toggle category status');
          return;
        }
        showToast(`Category #${categoryId} ${nextActive ? 'Published' : 'Deactivated'}!`);
        setTimeout(() => window.location.reload(), 500);
      });
    });

    // 7. Accounts Manager Payment Actions (Mark COD Collected & Record Refund)
    document.querySelectorAll('[data-payment-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const actionType = btn.getAttribute('data-payment-action');
        const orderNumber = btn.getAttribute('data-order-number');
        if (IS_STATIC_SHOWCASE) {
          const email = getActiveAdminEmail();
          if (email !== 'superadmin@sasynaturals.com' && email !== 'accounts@sasynaturals.com') {
            showToast(`403 RBAC Permission Denied: Role for ${email} cannot perform ${actionType}.`);
            return;
          }
          showToast(`[Showcase Verified] Executed ${actionType} on order ${orderNumber}`);
          return;
        }
        const res = await fetch('/api/admin/payments/action', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-email': getActiveAdminEmail()
          },
          body: JSON.stringify({ orderNumber, actionType, refundReason: 'Approved Admin Refund' })
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Payment action failed');
          return;
        }
        showToast(`Order ${orderNumber} updated (${actionType})`);
        setTimeout(() => window.location.reload(), 600);
      });
    });

    // 7B. Granular Time-Series Report Switcher (Daily | Weekly | Monthly) & 1-Click CSV Export
    document.querySelectorAll('[data-report-period-btn]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-report-period-btn');
        document.querySelectorAll('[data-report-period-btn]').forEach(b => {
          b.className = b === btn ? 'sn-btn sn-btn-forest sn-btn-sm' : 'sn-btn sn-btn-outline sn-btn-sm';
        });
        document.querySelectorAll('[data-report-period-panel]').forEach(panel => {
          panel.style.display = panel.getAttribute('data-report-period-panel') === target ? 'block' : 'none';
        });
      });
    });

    function triggerCsvDownload(csvText, fileName) {
      const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    document.querySelectorAll('[data-export-csv]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const type = btn.getAttribute('data-export-csv');
        const tableId = btn.getAttribute('data-export-table');
        const email = getActiveAdminEmail();

        if (IS_STATIC_SHOWCASE) {
          if (email !== 'superadmin@sasynaturals.com' && email !== 'accounts@sasynaturals.com') {
            showToast('403 RBAC Permission Denied: Only SUPER_ADMIN and ACCOUNTS_MANAGER can export financial reports.');
            return;
          }
          const tableEl = document.getElementById(tableId);
          if (!tableEl) return;
          const rows = Array.from(tableEl.querySelectorAll('tr')).map(tr =>
            Array.from(tr.querySelectorAll('th, td')).map(cell => {
              const txt = cell.textContent.replace(/\s+/g, ' ').trim();
              return txt.includes(',') ? `"${txt.replace(/"/g, '""')}"` : txt;
            }).join(',')
          );
          triggerCsvDownload(rows.join('\n') + '\n', `sasya-naturals-report-${type}.csv`);
          showToast(`Exported sasya-naturals-report-${type}.csv`);
          return;
        }

        const res = await fetch(`/api/admin/reports/export.csv?type=${encodeURIComponent(type)}`, {
          headers: { 'x-admin-email': email }
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          showToast(errData.error || '403 RBAC Permission Denied for report export');
          return;
        }
        const csvText = await res.text();
        triggerCsvDownload(csvText, `sasya-naturals-report-${type}.csv`);
        showToast(`Downloaded sasya-naturals-report-${type}.csv`);
      });
    });

    // 8. Staff RBAC Create & Update Forms (Panel 7)
    const createStaffForm = document.getElementById('sn-admin-create-staff-form');
    if (createStaffForm) {
      createStaffForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(createStaffForm);
        const payload = Object.fromEntries(fd.entries());
        if (IS_STATIC_SHOWCASE) {
          if (getActiveAdminEmail() !== 'superadmin@sasynaturals.com') {
            showToast('403 RBAC Permission Denied: Only SUPER_ADMIN can create staff accounts.');
            return;
          }
          showToast(`[Showcase Verified] Created staff user ${payload.email} (${payload.role})`);
          createStaffForm.reset();
          return;
        }
        const res = await fetch('/api/admin/staff/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-email': getActiveAdminEmail()
          },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Failed to create staff user');
          return;
        }
        showToast(`Created staff account ${data.staff.email} (${data.staff.role})`);
        setTimeout(() => window.location.reload(), 700);
      });
    }

    document.querySelectorAll('.sn-admin-staff-update-form').forEach(form => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const payload = Object.fromEntries(fd.entries());
        if (IS_STATIC_SHOWCASE) {
          if (getActiveAdminEmail() !== 'superadmin@sasynaturals.com') {
            showToast('403 RBAC Permission Denied: Only SUPER_ADMIN can modify staff roles and permissions.');
            return;
          }
          showToast(`[Showcase Verified] Updated staff #${payload.userId} role/permissions!`);
          return;
        }
        const res = await fetch('/api/admin/staff/update', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-email': getActiveAdminEmail()
          },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Failed to update staff user');
          return;
        }
        showToast(`Updated staff #${data.userId} (${data.role})`);
        setTimeout(() => window.location.reload(), 600);
      });
    });

    // 9. Delivery Policy & Business Compliance / Notification Templates Forms (Panel 8)
    const shipPolicyForm = document.getElementById('sn-admin-shipping-policy-form');
    if (shipPolicyForm) {
      shipPolicyForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(shipPolicyForm);
        const payload = Object.fromEntries(fd.entries());
        if (IS_STATIC_SHOWCASE) {
          const email = getActiveAdminEmail();
          if (email !== 'superadmin@sasynaturals.com') {
            showToast('403 RBAC Permission Denied: Only SUPER_ADMIN can modify Delivery Policy.');
            return;
          }
          localStorage.setItem('sn_shipping_policy_v1', JSON.stringify(payload));
          showToast(`[Showcase Verified] Saved Delivery Policy (${payload.shipping_free_mode})`);
          return;
        }

        const res = await fetch('/api/admin/settings/shipping', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-email': getActiveAdminEmail()
          },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Failed to update shipping policy');
          return;
        }
        showToast(`Saved Delivery Policy (${data.policy.freeMode})`);
        setTimeout(() => window.location.reload(), 700);
      });
    }

    const complianceForm = document.getElementById('sn-admin-compliance-form');
    if (complianceForm) {
      complianceForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(complianceForm);
        const payload = Object.fromEntries(fd.entries());
        if (IS_STATIC_SHOWCASE) {
          if (getActiveAdminEmail() !== 'superadmin@sasynaturals.com') {
            showToast('403 RBAC Permission Denied: Only SUPER_ADMIN can update compliance & notification templates.');
            return;
          }
          showToast('[Showcase Verified] Saved Business Legal, GSTIN, FSSAI & Notification Templates!');
          return;
        }
        const res = await fetch('/api/admin/settings/compliance', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-email': getActiveAdminEmail()
          },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Failed to save compliance settings');
          return;
        }
        showToast('Saved Business Legal, GSTIN, FSSAI & Notification Templates!');
        setTimeout(() => window.location.reload(), 700);
      });
    }
  }

  function initAdminAuthForms() {
    const adminLoginForm = document.getElementById('sn-admin-login-form');
    if (adminLoginForm) {
      adminLoginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(adminLoginForm);
        const email = String(fd.get('email') || '').trim();
        const password = String(fd.get('password') || '');
        if (IS_STATIC_SHOWCASE) {
          localStorage.setItem(ADMIN_ROLE_STORAGE_KEY, email);
          const roleSelect = document.getElementById('sn-admin-role-switcher');
          if (roleSelect) roleSelect.value = email;
          showToast(`Signed in as staff ${email}`);
          return;
        }
        const res = await fetch('/api/admin/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Staff sign-in failed');
          return;
        }
        localStorage.setItem(ADMIN_ROLE_STORAGE_KEY, data.user.email);
        showToast(`Signed in as ${data.user.fullName} (${data.user.role})`);
        setTimeout(() => window.location.reload(), 500);
      });
    }

    const adminLogoutBtn = document.getElementById('sn-admin-logout-btn');
    if (adminLogoutBtn) {
      adminLogoutBtn.addEventListener('click', async () => {
        if (!IS_STATIC_SHOWCASE) {
          await fetch('/api/admin/auth/logout', { method: 'POST' });
        }
        showToast('Signed out of staff session');
        setTimeout(() => window.location.reload(), 500);
      });
    }
  }

  function initCustomerAccountPage() {
    const accRoot = document.getElementById('sn-customer-account-page');
    if (!accRoot) return;

    const guestAuthSections = document.getElementById('sn-customer-guest-auth-sections');
    const authSections = document.getElementById('sn-customer-authenticated-sections');
    const toggleAuthBtn = document.getElementById('sn-customer-toggle-auth-btn');
    const logoutBtn = document.getElementById('sn-customer-logout-btn');

    if (toggleAuthBtn && guestAuthSections) {
      toggleAuthBtn.addEventListener('click', () => {
        const isHidden = guestAuthSections.style.display === 'none';
        guestAuthSections.style.display = isHidden ? 'grid' : 'none';
        toggleAuthBtn.textContent = isHidden ? 'Hide Sign-In Forms' : 'Switch Account';
      });
    }

    const loginForm = document.getElementById('sn-customer-login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(loginForm);
        const email = String(fd.get('email') || '').trim();
        const password = String(fd.get('password') || '');
        if (IS_STATIC_SHOWCASE) {
          const badge = document.getElementById('sn-account-active-badge');
          if (badge) {
            badge.className = 'sn-status sn-status-paid';
            badge.textContent = `Signed In: ${email}`;
          }
          if (guestAuthSections) guestAuthSections.style.display = 'none';
          if (authSections) authSections.style.display = 'block';
          if (toggleAuthBtn) {
            toggleAuthBtn.style.display = 'inline-flex';
            toggleAuthBtn.textContent = 'Switch Account';
          }
          if (logoutBtn) logoutBtn.style.display = 'inline-flex';
          showToast(`Signed in to Customer Account (${email})`);
          return;
        }
        const res = await fetch('/api/account/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Sign-in failed');
          return;
        }
        showToast(`Welcome back, ${data.user.fullName}!`);
        setTimeout(() => window.location.reload(), 500);
      });
    }

    const regForm = document.getElementById('sn-customer-register-form');
    if (regForm) {
      regForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(regForm);
        const payload = Object.fromEntries(fd.entries());
        if (IS_STATIC_SHOWCASE) {
          const badge = document.getElementById('sn-account-active-badge');
          if (badge) {
            badge.className = 'sn-status sn-status-paid';
            badge.textContent = `Signed In: ${payload.email}`;
          }
          if (guestAuthSections) guestAuthSections.style.display = 'none';
          if (authSections) authSections.style.display = 'block';
          if (toggleAuthBtn) {
            toggleAuthBtn.style.display = 'inline-flex';
            toggleAuthBtn.textContent = 'Switch Account';
          }
          if (logoutBtn) logoutBtn.style.display = 'inline-flex';
          const nameInput = document.getElementById('cust-prof-name');
          const emailInput = document.getElementById('cust-prof-email');
          const phoneInput = document.getElementById('cust-prof-phone');
          if (nameInput) nameInput.value = payload.fullName;
          if (emailInput) emailInput.value = payload.email;
          if (phoneInput) phoneInput.value = payload.phone;
          showToast(`Registered & signed in as ${payload.fullName}!`);
          regForm.reset();
          return;
        }
        const res = await fetch('/api/account/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Registration failed');
          return;
        }
        showToast(`Account created for ${data.user.fullName}!`);
        setTimeout(() => window.location.reload(), 500);
      });
    }

    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        if (IS_STATIC_SHOWCASE) {
          const badge = document.getElementById('sn-account-active-badge');
          if (badge) {
            badge.className = 'sn-status sn-status-warn';
            badge.textContent = 'Logged Out • Please Sign In or Register';
          }
          if (guestAuthSections) guestAuthSections.style.display = 'grid';
          if (authSections) authSections.style.display = 'none';
          if (toggleAuthBtn) toggleAuthBtn.style.display = 'none';
          logoutBtn.style.display = 'none';
          showToast('Signed out of customer account');
          return;
        }
        await fetch('/api/account/logout', { method: 'POST' });
        showToast('Signed out of customer account');
        setTimeout(() => window.location.reload(), 500);
      });
    }

    // Forgot Password 6-Digit OTP Request & Confirm
    const resetReqForm = document.getElementById('sn-customer-reset-otp-request-form');
    if (resetReqForm) {
      resetReqForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(resetReqForm);
        const email = String(fd.get('email') || '').trim();
        const otpInput = document.getElementById('sn-reset-otp-code');
        const confirmEmailInput = document.getElementById('sn-reset-confirm-email');
        if (confirmEmailInput) confirmEmailInput.value = email;

        if (IS_STATIC_SHOWCASE) {
          const simOtp = '739204';
          if (otpInput) otpInput.value = simOtp;
          showToast(`Password Reset OTP sent to ${email} (Sandbox OTP: ${simOtp})`);
          return;
        }
        const res = await fetch('/api/account/password/reset-otp/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Failed to request password reset OTP');
          return;
        }
        if (data.sandboxOtpPreview && otpInput) {
          otpInput.value = data.sandboxOtpPreview;
        }
        showToast(`6-digit reset OTP sent to ${data.email}${data.sandboxOtpPreview ? ` (Sandbox: ${data.sandboxOtpPreview})` : ''}`);
      });
    }

    const resetConfirmForm = document.getElementById('sn-customer-reset-otp-confirm-form');
    if (resetConfirmForm) {
      resetConfirmForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(resetConfirmForm);
        const payload = Object.fromEntries(fd.entries());
        if (IS_STATIC_SHOWCASE) {
          const badge = document.getElementById('sn-account-active-badge');
          if (badge) {
            badge.className = 'sn-status sn-status-paid';
            badge.textContent = `Signed In: ${payload.email}`;
          }
          if (guestAuthSections) guestAuthSections.style.display = 'none';
          if (authSections) authSections.style.display = 'block';
          if (toggleAuthBtn) toggleAuthBtn.style.display = 'inline-flex';
          if (logoutBtn) logoutBtn.style.display = 'inline-flex';
          resetConfirmForm.reset();
          showToast(`Password reset & signed in as ${payload.email}!`);
          return;
        }
        const res = await fetch('/api/account/password/reset-otp/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Password reset failed');
          return;
        }
        showToast(`Password reset complete! Signed in as ${data.user.fullName}`);
        setTimeout(() => window.location.reload(), 500);
      });
    }

    // Change Password Form (Signed-In Customer)
    const changePassForm = document.getElementById('sn-customer-change-password-form');
    if (changePassForm) {
      changePassForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(changePassForm);
        const payload = Object.fromEntries(fd.entries());
        if (IS_STATIC_SHOWCASE) {
          changePassForm.reset();
          showToast('Updated account password (PBKDF2-SHA512 verified)!');
          return;
        }
        const res = await fetch('/api/account/password/change', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Failed to change password');
          return;
        }
        changePassForm.reset();
        showToast('Password updated successfully!');
      });
    }

    const profForm = document.getElementById('sn-customer-profile-form');
    if (profForm) {
      profForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(profForm);
        const payload = Object.fromEntries(fd.entries());
        if (IS_STATIC_SHOWCASE) {
          showToast(`Saved profile for ${payload.fullName}!`);
          return;
        }
        const res = await fetch('/api/account/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Profile update failed');
          return;
        }
        showToast(`Updated profile for ${data.user.fullName}!`);
      });
    }

    const addAddrForm = document.getElementById('sn-customer-add-address-form');
    if (addAddrForm) {
      addAddrForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(addAddrForm);
        const payload = Object.fromEntries(fd.entries());
        if (IS_STATIC_SHOWCASE) {
          const list = document.getElementById('sn-customer-addresses-list');
          if (list) {
            const div = document.createElement('div');
            div.className = 'sn-card';
            div.style.cssText = 'padding:12px 16px;background-color:var(--sn-bg-parchment);';
            div.innerHTML = `
              <div><strong>${payload.label}</strong> • ${payload.recipientName} (${payload.phone})</div>
              <div style="font-size:0.82rem;color:var(--sn-text-secondary);">${payload.line1}, ${payload.city}, ${payload.state} - <strong>${payload.pincode}</strong></div>
            `;
            list.appendChild(div);
          }
          addAddrForm.reset();
          showToast(`Saved delivery address "${payload.label}"!`);
          return;
        }
        const res = await fetch('/api/account/addresses/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Failed to save address');
          return;
        }
        showToast(`Saved delivery address "${data.address.label}"!`);
        setTimeout(() => window.location.reload(), 500);
      });
    }

    document.querySelectorAll('[data-set-default-addr]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const addressId = Number(btn.getAttribute('data-set-default-addr'));
        if (IS_STATIC_SHOWCASE) {
          showToast(`Set address #${addressId} as default delivery address`);
          return;
        }
        await fetch('/api/account/addresses/default', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ addressId })
        });
        showToast('Updated default delivery address');
        setTimeout(() => window.location.reload(), 400);
      });
    });

    document.querySelectorAll('[data-delete-addr]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const addressId = Number(btn.getAttribute('data-delete-addr'));
        if (IS_STATIC_SHOWCASE) {
          const card = btn.closest('[data-address-card]');
          if (card) card.remove();
          showToast('Removed saved address');
          return;
        }
        await fetch('/api/account/addresses/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ addressId })
        });
        showToast('Removed saved address');
        setTimeout(() => window.location.reload(), 400);
      });
    });
  }

  function initCatalogClientFilters() {
    const filterForm = document.getElementById('catalog-filter-form');
    const grid = document.getElementById('sn-catalog-product-grid');
    if (!filterForm || !grid) return;

    filterForm.querySelectorAll('select').forEach(sel => {
      sel.addEventListener('change', () => {
        if (typeof filterForm.requestSubmit === 'function') {
          filterForm.requestSubmit();
        } else {
          filterForm.submit();
        }
      });
    });

    if (!IS_STATIC_SHOWCASE) return;

    function applyStaticFilters() {
      const q = (document.getElementById('catalog-search-input')?.value || '').trim().toLowerCase();
      const tag = document.getElementById('catalog-tag-select')?.value || 'all';
      const maxPrice = document.getElementById('catalog-price-select')?.value || 'all';
      const cards = Array.from(grid.querySelectorAll('.sn-product-card'));
      let visibleCount = 0;

      for (const card of cards) {
        const text = card.textContent.toLowerCase();
        const isFeat = card.getAttribute('data-product-featured') === '1';
        const isBest = card.getAttribute('data-product-bestseller') === '1';
        const isNew = card.getAttribute('data-product-new') === '1';
        const isStock = card.getAttribute('data-product-instock') === '1';
        const minInr = Number(card.getAttribute('data-product-min-inr') || 0);

        let match = (!q || text.includes(q));
        if (tag === 'bestseller' && !isBest) match = false;
        if (tag === 'featured' && !isFeat) match = false;
        if (tag === 'new_arrival' && !isNew) match = false;
        if (tag === 'in_stock' && !isStock) match = false;
        if (maxPrice !== 'all' && minInr > Number(maxPrice)) match = false;

        card.style.display = match ? '' : 'none';
        if (match) visibleCount++;
      }

      const label = document.getElementById('sn-catalog-count-label');
      if (label) {
        label.innerHTML = `Showing <strong>${visibleCount}</strong> of <strong>${cards.length}</strong> Harvests`;
      }
    }

    filterForm.addEventListener('submit', (e) => {
      e.preventDefault();
      applyStaticFilters();
    });

    // Hydrate URL query parameters (?q=..., ?tag=..., ?maxPrice=...) on static showcase
    const params = new URLSearchParams(window.location.search);
    let hasParam = false;
    if (params.get('q') && document.getElementById('catalog-search-input')) {
      document.getElementById('catalog-search-input').value = params.get('q');
      hasParam = true;
    }
    if (params.get('tag') && document.getElementById('catalog-tag-select')) {
      document.getElementById('catalog-tag-select').value = params.get('tag');
      hasParam = true;
    }
    if (params.get('maxPrice') && document.getElementById('catalog-price-select')) {
      document.getElementById('catalog-price-select').value = params.get('maxPrice');
      hasParam = true;
    }
    if (hasParam) {
      applyStaticFilters();
    }
  }

  function appendCategoryToAdminDom(cat) {
    const tbody = document.querySelector('#sn-admin-categories-table tbody');
    if (tbody) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><img src="${cat.imageUrl}" alt="${cat.name}" data-category-img-id="${cat.id}" style="width:68px;height:48px;object-fit:cover;border-radius:6px;border:1px solid var(--sn-border-strong);" /></td>
        <td><strong>${cat.name}</strong><br/><span style="font-family:var(--sn-font-mono);font-size:0.73rem;color:var(--sn-text-muted);">/category/${cat.slug}</span></td>
        <td style="font-size:0.82rem;">${cat.subtitle}</td>
        <td><span class="sn-status sn-status-paid">Published (Active)</span></td>
        <td><span style="font-size:0.75rem;color:var(--sn-text-muted);">Custom Category</span></td>
      `;
      tbody.appendChild(tr);
    }
    const prodCatSelect = document.getElementById('sn-create-prod-cat-select');
    if (prodCatSelect) {
      const opt = document.createElement('option');
      opt.value = String(cat.id);
      opt.textContent = cat.name;
      prodCatSelect.appendChild(opt);
    }
    const homeGrid = document.getElementById('home-categories-grid');
    if (homeGrid) {
      const a = document.createElement('a');
      a.href = `${BASE_PATH}/shop`;
      a.className = 'sn-category-card';
      a.innerHTML = `
        <div class="sn-category-img-wrap"><img src="${cat.imageUrl}" alt="${cat.name}" data-category-img-id="${cat.id}" /></div>
        <div class="sn-category-body">
          <div><span class="sn-eyebrow">${cat.subtitle}</span><h3>${cat.name}</h3><p>${cat.description}</p></div>
          <span style="font-weight:700;color:var(--sn-accent-terracotta);font-size:0.875rem;">Browse ${cat.name} -></span>
        </div>
      `;
      homeGrid.appendChild(a);
    }
  }

  function initPdpGalleryAndShowcaseOverrides() {
    // PDP thumbnail switcher
    document.addEventListener('click', (e) => {
      const thumbBtn = e.target.closest('[data-pdp-thumb-url]');
      if (thumbBtn) {
        const mainImg = document.getElementById('sn-pdp-main-img');
        const mainCap = document.getElementById('sn-pdp-main-caption');
        if (mainImg) mainImg.src = thumbBtn.getAttribute('data-pdp-thumb-url');
        if (mainCap) mainCap.textContent = thumbBtn.getAttribute('data-pdp-thumb-caption');
        document.querySelectorAll('[data-pdp-thumb-url]').forEach(btn => {
          btn.style.border = btn === thumbBtn ? '2px solid var(--sn-accent-terracotta)' : '1px solid var(--sn-border-strong)';
        });
      }
    });

    if (IS_STATIC_SHOWCASE) {
      try {
        const prodImgs = JSON.parse(localStorage.getItem('sn_custom_prod_images_v1') || '{}');
        for (const [pid, dataUrl] of Object.entries(prodImgs)) {
          document.querySelectorAll(`[data-product-img-id="${pid}"]`).forEach(img => { img.src = dataUrl; });
        }
        const catImgs = JSON.parse(localStorage.getItem('sn_custom_cat_images_v1') || '{}');
        for (const [cid, dataUrl] of Object.entries(catImgs)) {
          document.querySelectorAll(`[data-category-img-id="${cid}"]`).forEach(img => { img.src = dataUrl; });
        }
        const customCats = JSON.parse(localStorage.getItem('sn_custom_categories_v1') || '[]');
        for (const cat of customCats) {
          appendCategoryToAdminDom(cat);
        }
      } catch {
        // ignore storage errors
      }
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    updateCartBadges();
    bindGlobalListeners();
    initPdpGalleryAndShowcaseOverrides();
    initCatalogClientFilters();
    initCheckoutPage();
    initCustomerAccountPage();
    initAdminAuthForms();
    initAdminPortal();
  });
})();
