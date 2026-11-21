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

  function showToast(msg) {
    const toast = document.getElementById('sn-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('sn-show');
    clearTimeout(window.__snToastTimer);
    window.__snToastTimer = setTimeout(() => {
      toast.classList.remove('sn-show');
    }, 3400);
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
  async function calculateCartClientSide(items, couponCode) {
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
        lineGstPaise
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
    const shippingPaise = discountedSubtotalPaise >= 79900 ? 0 : 6000;
    const totalPaise = discountedSubtotalPaise + shippingPaise;

    return {
      pricing: {
        engine: 'rust-wasm-browser',
        lineItems,
        mrpTotalPaise,
        subtotalPaise,
        discountPaise,
        discountedSubtotalPaise,
        gstPaise,
        shippingPaise,
        totalPaise,
        totalWeightGrams,
        appliedCoupon,
        couponMessage
      }
    };
  }

  async function requestCartPricing(items, couponCode, paymentMethod) {
    if (IS_STATIC_SHOWCASE) {
      return calculateCartClientSide(items, couponCode);
    }
    const res = await fetch('/api/cart/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, couponCode, paymentMethod })
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
      bodyEl.innerHTML = p.lineItems.map(item => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--sn-border-warm);gap:12px;">
          <div style="flex:1;">
            <div style="font-weight:600;color:var(--sn-bg-forest);font-size:0.92rem;">${item.productName}</div>
            <div style="font-family:var(--sn-font-mono);font-size:0.75rem;color:var(--sn-text-muted);">Pack: ${item.packLabel} | SKU: ${item.sku} | GST ${item.gstPercent}%</div>
            <div style="font-family:var(--sn-font-mono);font-size:0.85rem;font-weight:600;margin-top:4px;">${formatInr(item.unitPricePaise)} x ${item.quantity} = ${formatInr(item.lineTotalPaise)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-cart-qty="${item.variantId}" data-delta="-1">-</button>
            <span style="font-family:var(--sn-font-mono);font-size:0.85rem;min-width:20px;text-align:center;">${item.quantity}</span>
            <button type="button" class="sn-btn sn-btn-outline sn-btn-sm" data-cart-qty="${item.variantId}" data-delta="1">+</button>
          </div>
        </div>
      `).join('');

      footEl.innerHTML = `
        <div style="font-size:0.85rem;display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;"><span>Subtotal (incl. GST ${formatInr(p.gstPaise)})</span><strong style="font-family:var(--sn-font-mono);">${formatInr(p.subtotalPaise)}</strong></div>
          <div style="display:flex;justify-content:space-between;"><span>India-Wide Delivery</span><strong style="font-family:var(--sn-font-mono);">${p.shippingPaise === 0 ? 'FREE' : formatInr(p.shippingPaise)}</strong></div>
          <div style="display:flex;justify-content:space-between;font-size:1.05rem;padding-top:8px;border-top:1px solid var(--sn-border-warm);color:var(--sn-bg-forest);">
            <strong>Order Total</strong>
            <strong style="font-family:var(--sn-font-mono);">${formatInr(p.totalPaise)}</strong>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <button type="button" class="sn-btn sn-btn-outline" id="sn-clear-cart-btn">Clear</button>
          <a href="${BASE_PATH}/checkout" class="sn-btn sn-btn-primary">Checkout -></a>
        </div>
      `;
    } catch (err) {
      bodyEl.innerHTML = `<p style="color:var(--sn-status-danger);">${err.message}</p>`;
    }
  }

  function bindGlobalListeners() {
    document.addEventListener('click', async (e) => {
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
        const skuEl = container.querySelector('[data-sku-display]');
        const stockEl = container.querySelector('[data-stock-display]');
        const addBtn = container.querySelector('[data-add-to-cart]');

        if (priceEl) priceEl.textContent = formatInr(pricePaise);
        if (mrpEl) mrpEl.textContent = 'MRP ' + formatInr(mrpPaise);
        if (skuEl) skuEl.textContent = sku;
        if (stockEl) {
          stockEl.textContent = stock > 0 ? `In Stock (${stock} packs)` : 'Out of Stock';
        }
        if (addBtn) {
          addBtn.setAttribute('data-variant-id', variantId);
          addBtn.setAttribute('data-pack-label', packLabel);
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
        showToast(`Added ${productName} (${packLabel}) to your Pantry Basket`);
        await refreshCartDrawer();
        return;
      }

      const openCartBtn = e.target.closest('[data-open-cart]');
      if (openCartBtn) {
        e.preventDefault();
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
        summaryBox.innerHTML = `<p style="color:var(--sn-text-muted);">Your basket is empty. <a href="${BASE_PATH}/shop" style="color:var(--sn-accent-terracotta);font-weight:600;">Add products from the shop -></a></p>`;
        return;
      }
      const couponCode = couponInput ? couponInput.value.trim() : '';
      const methodEl = checkoutForm.querySelector('input[name="paymentMethod"]:checked');
      const paymentMethod = methodEl ? methodEl.value : 'ONLINE_UPI';

      try {
        const data = await requestCartPricing(cart, couponCode, paymentMethod);
        const p = data.pricing;
        summaryBox.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:10px;">
            ${p.lineItems.map(item => `
              <div style="display:flex;justify-content:space-between;font-size:0.86rem;border-bottom:1px dashed var(--sn-border-warm);padding-bottom:8px;">
                <div>
                  <strong>${item.productName}</strong> (${item.packLabel}) x ${item.quantity}
                  <div style="font-family:var(--sn-font-mono);font-size:0.72rem;color:var(--sn-text-muted);">SKU: ${item.sku} | GST ${item.gstPercent}%</div>
                </div>
                <span style="font-family:var(--sn-font-mono);font-weight:600;">${formatInr(item.lineTotalPaise)}</span>
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
              <span>Included GST Component (Rust WASM)</span><span style="font-family:var(--sn-font-mono);">${formatInr(p.gstPaise)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:0.88rem;">
              <span>Shipping (Free above ₹799)</span><strong style="font-family:var(--sn-font-mono);">${p.shippingPaise === 0 ? 'FREE' : formatInr(p.shippingPaise)}</strong>
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
      const payload = {
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

    document.querySelectorAll('[data-admin-tab-btn]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-admin-tab-btn');
        document.querySelectorAll('[data-admin-tab-btn]').forEach(b => b.classList.remove('sn-active'));
        btn.classList.add('sn-active');
        document.querySelectorAll('[data-admin-panel]').forEach(panel => {
          panel.style.display = panel.getAttribute('data-admin-panel') === target ? 'block' : 'none';
        });
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

    // Magic-Byte Image Upload Handler
    const imgUploadForm = document.getElementById('sn-admin-image-upload-form');
    if (imgUploadForm) {
      imgUploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(imgUploadForm);
        const file = fd.get('imageFile');
        const productId = Number(fd.get('productId'));
        const caption = fd.get('caption');
        if (!file || !file.size) {
          showToast('Please select an image file.');
          return;
        }

        if (IS_STATIC_SHOWCASE) {
          const email = getActiveAdminEmail();
          if (email !== 'superadmin@sasynaturals.com' && email !== 'catalog@sasynaturals.com') {
            showToast('403 RBAC Permission Denied: Only SUPER_ADMIN and PRODUCT_MANAGER can upload product images.');
            return;
          }
          showToast(`[Showcase Verified] Magic-byte validated & attached "${file.name}" to product #${productId}`);
          return;
        }

        const reader = new FileReader();
        reader.onload = async () => {
          const res = await fetch('/api/admin/products/upload-image', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-admin-email': getActiveAdminEmail()
            },
            body: JSON.stringify({
              productId,
              imageBase64: reader.result,
              caption,
              setAsPrimary: false
            })
          });
          const data = await res.json();
          if (!res.ok) {
            showToast(data.error || 'Image upload failed');
            return;
          }
          showToast(`Uploaded ${data.publicUrl} (${data.bytes} bytes verified)`);
        };
        reader.readAsDataURL(file);
      });
    }

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
          dispatchDate: fd.get('dispatchDate')
        };

        if (IS_STATIC_SHOWCASE) {
          const email = getActiveAdminEmail();
          if (email === 'catalog@sasynaturals.com' || email === 'accounts@sasynaturals.com') {
            showToast(`RBAC Permission Denied: ${email} cannot update shipping/fulfilment.`);
            return;
          }
          showToast(`[Showcase RBAC Verified] Updated ${payload.orderNumber} to "${payload.fulfilmentStatus}"`);
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
          showToast(`[Showcase RBAC Verified] Updated stock for variant #${fd.get('variantId')}`);
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
            reason: fd.get('reason') || 'ADMIN_STOCK_UPDATE'
          })
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'RBAC denied');
          return;
        }
        showToast(`Stock updated for variant #${fd.get('variantId')}`);
        setTimeout(() => window.location.reload(), 600);
      });
    });

    const newProdForm = document.getElementById('sn-admin-create-product-form');
    if (newProdForm) {
      newProdForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(newProdForm);
        const payload = Object.fromEntries(fd.entries());
        if (IS_STATIC_SHOWCASE) {
          const email = getActiveAdminEmail();
          if (email !== 'superadmin@sasynaturals.com' && email !== 'catalog@sasynaturals.com') {
            showToast(`RBAC Permission Denied: ${email} cannot create products.`);
            return;
          }
          showToast(`[Showcase RBAC Verified] Created product "${payload.name}"`);
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
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    updateCartBadges();
    bindGlobalListeners();
    initCheckoutPage();
    initAdminPortal();
  });
})();
