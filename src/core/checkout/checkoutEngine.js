'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDb } = require('../../db/database');
const {
  PAYMENT_CONFIG,
  ORDER_PAYMENT_STATUSES,
  ORDER_FULFILMENT_STATUSES
} = require('../../config/appConfig');

// Load compiled Rust WebAssembly Commerce Core (wasm_core.wasm)
const wasmPath = path.join(__dirname, 'wasm_core.wasm');
const wasmBytes = fs.readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
const wasmInstance = new WebAssembly.Instance(wasmModule, {});
const rustWasm = wasmInstance.exports;

function wasmLineTotalPaise(unitPricePaise, quantity) {
  return Number(rustWasm.compute_line_total_paise(BigInt(unitPricePaise), BigInt(quantity)));
}

function wasmInclusiveGstPaise(lineTotalPaise, gstPercent) {
  return Number(rustWasm.compute_inclusive_gst_paise(BigInt(lineTotalPaise), BigInt(gstPercent)));
}

function wasmCouponDiscountPaise(subtotalPaise, discountType, discountValue, minOrderPaise, maxDiscountPaise) {
  const typeCode = discountType === 'PERCENT' ? 1 : (discountType === 'FLAT_PAISE' ? 2 : 0);
  return Number(
    rustWasm.compute_coupon_discount_paise(
      BigInt(subtotalPaise),
      typeCode,
      BigInt(discountValue),
      BigInt(minOrderPaise),
      BigInt(maxDiscountPaise)
    )
  );
}

function wasmShippingPaise(discountedSubtotalPaise, freeThresholdPaise, standardShippingPaise) {
  return Number(
    rustWasm.compute_shipping_paise(
      BigInt(discountedSubtotalPaise),
      BigInt(freeThresholdPaise),
      BigInt(standardShippingPaise)
    )
  );
}

function wasmOrderTotalPaise(subtotalPaise, discountPaise, shippingPaise) {
  return Number(
    rustWasm.compute_order_total_paise(
      BigInt(subtotalPaise),
      BigInt(discountPaise),
      BigInt(shippingPaise)
    )
  );
}

function computeRazorpaySignature(gatewayOrderId, gatewayPaymentId, secret = PAYMENT_CONFIG.keySecret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${gatewayOrderId}|${gatewayPaymentId}`)
    .digest('hex');
}

function verifyRazorpaySignature(gatewayOrderId, gatewayPaymentId, providedSignature, secret = PAYMENT_CONFIG.keySecret) {
  if (!gatewayOrderId || !gatewayPaymentId || !providedSignature) return false;
  const expected = computeRazorpaySignature(gatewayOrderId, gatewayPaymentId, secret);
  if (expected.length !== providedSignature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(providedSignature, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Deterministically calculates cart totals in integer paise via Rust WASM Core + database variant prices.
 */
function calculateCartPricing(items = [], couponCode = '', paymentMethod = 'ONLINE_UPI') {
  const db = getDb();
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Cart is empty. Please add at least one product pack.');
  }

  const variantStmt = db.prepare(`
    SELECT
      v.id AS variant_id,
      v.product_id,
      v.sku,
      v.pack_label,
      v.weight_grams,
      v.mrp_paise,
      v.selling_price_paise,
      v.promo_price_paise,
      v.stock_qty,
      v.is_active AS variant_active,
      p.name AS product_name,
      p.slug AS product_slug,
      p.gst_percent,
      p.image_url,
      p.is_active AS product_active
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    WHERE v.id = ?
  `);

  let subtotalPaise = 0;
  let mrpTotalPaise = 0;
  let rawGstPaise = 0;
  let totalWeightGrams = 0;
  const lineItems = [];

  for (const rawItem of items) {
    const variantId = Number(rawItem.variantId);
    const quantity = Math.max(1, Math.min(50, Math.floor(Number(rawItem.quantity || 1))));
    if (!Number.isFinite(variantId) || variantId <= 0) {
      throw new Error('Invalid product variant selection.');
    }
    const row = variantStmt.get(variantId);
    if (!row || !row.variant_active || !row.product_active) {
      throw new Error(`Product variant #${variantId} is unavailable.`);
    }
    if (row.stock_qty < quantity) {
      throw new Error(`Insufficient stock for ${row.product_name} (${row.pack_label}). Available: ${row.stock_qty}.`);
    }

    const unitPricePaise = row.promo_price_paise && row.promo_price_paise > 0
      ? row.promo_price_paise
      : row.selling_price_paise;
    const lineTotalPaise = wasmLineTotalPaise(unitPricePaise, quantity);
    const lineMrpPaise = wasmLineTotalPaise(row.mrp_paise, quantity);
    const lineGstPaise = wasmInclusiveGstPaise(lineTotalPaise, row.gst_percent);

    subtotalPaise += lineTotalPaise;
    mrpTotalPaise += lineMrpPaise;
    rawGstPaise += lineGstPaise;
    totalWeightGrams += row.weight_grams * quantity;

    lineItems.push({
      productId: row.product_id,
      variantId: row.variant_id,
      productName: row.product_name,
      productSlug: row.product_slug,
      imageUrl: row.image_url,
      sku: row.sku,
      packLabel: row.pack_label,
      weightGrams: row.weight_grams,
      unitPricePaise,
      mrpPaise: row.mrp_paise,
      gstPercent: row.gst_percent,
      quantity,
      stockQty: row.stock_qty,
      lineTotalPaise,
      lineGstPaise
    });
  }

  let discountPaise = 0;
  let appliedCoupon = '';
  let couponMessage = '';
  const cleanCode = String(couponCode || '').trim().toUpperCase();

  if (cleanCode) {
    const coupon = db.prepare('SELECT * FROM coupons WHERE code = ? AND is_active = 1').get(cleanCode);
    if (!coupon) {
      couponMessage = `Coupon "${cleanCode}" is invalid or expired.`;
    } else if (subtotalPaise < coupon.min_order_paise) {
      couponMessage = `Coupon "${cleanCode}" requires a minimum subtotal of Rs. ${(coupon.min_order_paise / 100).toFixed(0)}.`;
    } else {
      discountPaise = wasmCouponDiscountPaise(
        subtotalPaise,
        coupon.discount_type,
        coupon.discount_value,
        coupon.min_order_paise,
        coupon.max_discount_paise
      );
      appliedCoupon = coupon.code;
      couponMessage = `Coupon ${coupon.code} applied (-Rs. ${(discountPaise / 100).toFixed(2)}).`;
    }
  }

  const discountedSubtotalPaise = Math.max(0, subtotalPaise - discountPaise);
  const gstPaise = subtotalPaise > 0
    ? Math.round(rawGstPaise * (discountedSubtotalPaise / subtotalPaise))
    : 0;

  const shippingPaise = wasmShippingPaise(
    discountedSubtotalPaise,
    PAYMENT_CONFIG.freeShippingThresholdPaise,
    PAYMENT_CONFIG.standardShippingPaise
  );

  const totalPaise = wasmOrderTotalPaise(subtotalPaise, discountPaise, shippingPaise);
  const codAllowed = totalPaise <= PAYMENT_CONFIG.maxCodOrderPaise;

  if (paymentMethod === 'COD' && !codAllowed) {
    throw new Error(`Cash on Delivery is available for orders up to Rs. ${(PAYMENT_CONFIG.maxCodOrderPaise / 100).toFixed(0)}.`);
  }

  return {
    engine: 'rust-wasm-v1',
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
    couponMessage,
    codAllowed,
    freeShippingThresholdPaise: PAYMENT_CONFIG.freeShippingThresholdPaise,
    amountForFreeShippingPaise: Math.max(0, PAYMENT_CONFIG.freeShippingThresholdPaise - discountedSubtotalPaise)
  };
}

function createOrder({
  userId = null,
  customerName,
  customerEmail,
  customerPhone,
  shippingLine1,
  shippingLine2 = '',
  shippingCity,
  shippingState,
  shippingPincode,
  deliveryInstructions = '',
  items,
  couponCode = '',
  paymentMethod = 'ONLINE_UPI'
}) {
  if (!customerName || !customerEmail || !customerPhone || !shippingLine1 || !shippingCity || !shippingState || !shippingPincode) {
    throw new Error('Please complete all required customer contact and Indian delivery address fields.');
  }
  if (!/^\d{6}$/.test(String(shippingPincode).trim())) {
    throw new Error('Please enter a valid 6-digit Indian PIN code.');
  }

  const validMethods = ['ONLINE_UPI', 'ONLINE_CARD', 'ONLINE_NETBANKING', 'COD'];
  if (!validMethods.includes(paymentMethod)) {
    throw new Error(`Unsupported payment method: ${paymentMethod}`);
  }

  const pricing = calculateCartPricing(items, couponCode, paymentMethod);
  const db = getDb();

  const seqRow = db.prepare('SELECT COUNT(*) AS cnt FROM orders').get();
  const nextSeq = 1001 + Number(seqRow ? seqRow.cnt : 0);
  const orderNumber = `SN-2026-${nextSeq}`;
  const isCod = paymentMethod === 'COD';
  const gatewayOrderId = isCod
    ? `cod_${orderNumber.replace(/-/g, '')}`
    : `order_rzp_${orderNumber.replace(/-/g, '')}_${crypto.randomBytes(3).toString('hex')}`;

  const paymentStatus = isCod ? 'COD_PENDING' : 'PENDING_PAYMENT';
  const fulfilmentStatus = isCod ? 'Confirmed' : 'Pending Payment';

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    const insertOrderStmt = db.prepare(`
      INSERT INTO orders (
        order_number, user_id, customer_name, customer_email, customer_phone,
        shipping_line1, shipping_line2, shipping_city, shipping_state, shipping_pincode,
        delivery_instructions, subtotal_paise, discount_paise, gst_paise, shipping_paise,
        total_paise, coupon_code, payment_method, payment_status, fulfilment_status,
        gateway_order_id, stock_deducted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const ordResult = insertOrderStmt.run(
      orderNumber,
      userId,
      String(customerName).trim(),
      String(customerEmail).trim(),
      String(customerPhone).trim(),
      String(shippingLine1).trim(),
      String(shippingLine2 || '').trim(),
      String(shippingCity).trim(),
      String(shippingState).trim(),
      String(shippingPincode).trim(),
      String(deliveryInstructions || '').trim(),
      pricing.subtotalPaise,
      pricing.discountPaise,
      pricing.gstPaise,
      pricing.shippingPaise,
      pricing.totalPaise,
      pricing.appliedCoupon,
      paymentMethod,
      paymentStatus,
      fulfilmentStatus,
      gatewayOrderId,
      isCod ? 1 : 0
    );
    const orderId = Number(ordResult.lastInsertRowid);

    const insertItemStmt = db.prepare(`
      INSERT INTO order_items (
        order_id, product_id, variant_id, product_name, sku, pack_label,
        weight_grams, unit_price_paise, mrp_paise, gst_percent, quantity, line_total_paise
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const deductStockStmt = db.prepare(`
      UPDATE product_variants
      SET stock_qty = stock_qty - ?
      WHERE id = ? AND stock_qty >= ?
    `);

    const insertMovementStmt = db.prepare(`
      INSERT INTO inventory_movements (
        variant_id, delta_qty, previous_qty, new_qty, reason, reference_id, actor_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of pricing.lineItems) {
      insertItemStmt.run(
        orderId,
        item.productId,
        item.variantId,
        item.productName,
        item.sku,
        item.packLabel,
        item.weightGrams,
        item.unitPricePaise,
        item.mrpPaise,
        item.gstPercent,
        item.quantity,
        item.lineTotalPaise
      );

      if (isCod) {
        const res = deductStockStmt.run(item.quantity, item.variantId, item.quantity);
        if (res.changes !== 1) {
          throw new Error(`Stock race condition detected for ${item.productName} (${item.packLabel}).`);
        }
        insertMovementStmt.run(
          item.variantId,
          -item.quantity,
          item.stockQty,
          item.stockQty - item.quantity,
          'ORDER_PLACED_COD',
          orderNumber,
          customerName
        );
      }
    }

    db.prepare(`
      INSERT INTO payments (
        order_id, order_number, gateway_provider, gateway_order_id, method, amount_paise, status, verified_on_server
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      orderNumber,
      isCod ? 'cod_manual' : PAYMENT_CONFIG.provider,
      gatewayOrderId,
      paymentMethod,
      pricing.totalPaise,
      paymentStatus,
      isCod ? 1 : 0
    );

    db.prepare(`
      INSERT INTO notification_logs (order_number, channel, recipient, event_type, subject, body_preview)
      VALUES (?, 'EMAIL', ?, ?, ?, ?)
    `).run(
      orderNumber,
      String(customerEmail).trim(),
      isCod ? 'ORDER_CONFIRMED_COD' : 'ORDER_CREATED_AWAITING_PAYMENT',
      `Sasya Naturals Order ${orderNumber} (${fulfilmentStatus})`,
      `Order total Rs. ${(pricing.totalPaise / 100).toFixed(2)} via ${paymentMethod}.`
    );

    db.exec('COMMIT;');

    return {
      orderId,
      orderNumber,
      paymentMethod,
      paymentStatus,
      fulfilmentStatus,
      gatewayOrderId,
      razorpayKeyId: PAYMENT_CONFIG.keyId,
      pricing,
      sandboxSignaturePreview: !isCod
        ? computeRazorpaySignature(gatewayOrderId, `pay_rzp_${orderNumber.replace(/-/g, '')}`)
        : null
    };
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function verifyAndCaptureOnlinePayment({
  orderNumber,
  gatewayOrderId,
  gatewayPaymentId,
  gatewaySignature
}) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber);
  if (!order) {
    throw new Error(`Order ${orderNumber} not found.`);
  }

  if (order.payment_status === 'PAID') {
    return {
      alreadyPaid: true,
      orderNumber: order.order_number,
      paymentStatus: order.payment_status,
      fulfilmentStatus: order.fulfilment_status
    };
  }

  if (order.gateway_order_id !== gatewayOrderId) {
    throw new Error('Gateway order ID mismatch.');
  }

  const isValid = verifyRazorpaySignature(gatewayOrderId, gatewayPaymentId, gatewaySignature);
  if (!isValid) {
    db.prepare(`
      UPDATE orders SET payment_status = 'FAILED', updated_at = datetime('now') WHERE id = ?
    `).run(order.id);
    db.prepare(`
      UPDATE payments SET status = 'FAILED', updated_at = datetime('now') WHERE order_id = ?
    `).run(order.id);
    throw new Error('Cryptographic payment signature verification failed (HMAC-SHA256 mismatch).');
  }

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    if (!order.stock_deducted) {
      const getVarStmt = db.prepare('SELECT stock_qty FROM product_variants WHERE id = ?');
      const deductStmt = db.prepare('UPDATE product_variants SET stock_qty = stock_qty - ? WHERE id = ? AND stock_qty >= ?');
      const moveStmt = db.prepare(`
        INSERT INTO inventory_movements (variant_id, delta_qty, previous_qty, new_qty, reason, reference_id, actor_name)
        VALUES (?, ?, ?, ?, 'ONLINE_PAYMENT_VERIFIED', ?, 'Razorpay Server Verification')
      `);

      for (const item of items) {
        const vRow = getVarStmt.get(item.variant_id);
        const prevQty = vRow ? vRow.stock_qty : 0;
        const res = deductStmt.run(item.quantity, item.variant_id, item.quantity);
        if (res.changes !== 1) {
          throw new Error(`Insufficient stock while capturing order ${orderNumber} for SKU ${item.sku}.`);
        }
        moveStmt.run(item.variant_id, -item.quantity, prevQty, prevQty - item.quantity, orderNumber);
      }
    }

    db.prepare(`
      UPDATE orders
      SET payment_status = 'PAID',
          fulfilment_status = 'Confirmed',
          gateway_payment_id = ?,
          gateway_signature = ?,
          stock_deducted = 1,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(gatewayPaymentId, gatewaySignature, order.id);

    db.prepare(`
      UPDATE payments
      SET gateway_payment_id = ?,
          status = 'PAID',
          verified_on_server = 1,
          updated_at = datetime('now')
      WHERE order_id = ?
    `).run(gatewayPaymentId, order.id);

    db.prepare(`
      INSERT INTO notification_logs (order_number, channel, recipient, event_type, subject, body_preview)
      VALUES (?, 'EMAIL', ?, 'PAYMENT_CONFIRMED', ?, ?)
    `).run(
      orderNumber,
      order.customer_email,
      `Payment Confirmed for Sasya Naturals Order ${orderNumber}`,
      `Server-verified payment ${gatewayPaymentId} of Rs. ${(order.total_paise / 100).toFixed(2)}.`
    );

    db.exec('COMMIT;');

    return {
      alreadyPaid: false,
      orderNumber,
      paymentStatus: 'PAID',
      fulfilmentStatus: 'Confirmed',
      gatewayPaymentId
    };
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function updateOrderFulfilmentAndShipping({
  orderNumber,
  fulfilmentStatus,
  courierName = '',
  trackingNumber = '',
  trackingUrl = '',
  dispatchDate = '',
  manualShippingChargePaise = 0,
  actorEmail = 'admin@sasynaturals.com',
  actorRole = 'ORDER_MANAGER'
}) {
  if (!ORDER_FULFILMENT_STATUSES.includes(fulfilmentStatus)) {
    throw new Error(`Invalid fulfilment status: ${fulfilmentStatus}`);
  }
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber);
  if (!order) throw new Error(`Order ${orderNumber} not found.`);

  if (fulfilmentStatus === 'Shipped' && (!courierName || !trackingNumber)) {
    throw new Error('Dispatched orders require Courier Name and Tracking Number (Manual Shipping Workflow Section 7).');
  }

  const shouldRestoreStock =
    (fulfilmentStatus === 'Cancelled' || fulfilmentStatus === 'Refunded') &&
    order.stock_deducted === 1;

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    if (shouldRestoreStock) {
      const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
      const getVarStmt = db.prepare('SELECT stock_qty FROM product_variants WHERE id = ?');
      const restoreStmt = db.prepare('UPDATE product_variants SET stock_qty = stock_qty + ? WHERE id = ?');
      const moveStmt = db.prepare(`
        INSERT INTO inventory_movements (variant_id, delta_qty, previous_qty, new_qty, reason, reference_id, actor_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        const vRow = getVarStmt.get(item.variant_id);
        const prevQty = vRow ? vRow.stock_qty : 0;
        restoreStmt.run(item.quantity, item.variant_id);
        moveStmt.run(
          item.variant_id,
          item.quantity,
          prevQty,
          prevQty + item.quantity,
          `ORDER_${fulfilmentStatus.toUpperCase()}_RESTOCK`,
          orderNumber,
          actorEmail
        );
      }
    }

    const nextStockDeducted = shouldRestoreStock ? 0 : order.stock_deducted;
    const nextPaymentStatus =
      fulfilmentStatus === 'Delivered' && order.payment_status === 'COD_PENDING'
        ? 'COD_COLLECTED'
        : (fulfilmentStatus === 'Refunded' ? 'REFUNDED' : order.payment_status);

    db.prepare(`
      UPDATE orders
      SET fulfilment_status = ?,
          payment_status = ?,
          courier_name = COALESCE(NULLIF(?, ''), courier_name),
          tracking_number = COALESCE(NULLIF(?, ''), tracking_number),
          tracking_url = COALESCE(NULLIF(?, ''), tracking_url),
          dispatch_date = COALESCE(NULLIF(?, ''), dispatch_date),
          manual_shipping_charge_paise = CASE WHEN ? > 0 THEN ? ELSE manual_shipping_charge_paise END,
          stock_deducted = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      fulfilmentStatus,
      nextPaymentStatus,
      courierName,
      trackingNumber,
      trackingUrl,
      dispatchDate,
      Number(manualShippingChargePaise || 0),
      Number(manualShippingChargePaise || 0),
      nextStockDeducted,
      order.id
    );

    if (nextPaymentStatus === 'COD_COLLECTED') {
      db.prepare(`
        UPDATE payments SET status = 'COD_COLLECTED', cod_collected_at = datetime('now'), updated_at = datetime('now')
        WHERE order_id = ?
      `).run(order.id);
    } else if (nextPaymentStatus === 'REFUNDED') {
      db.prepare(`
        UPDATE payments SET status = 'REFUNDED', refund_amount_paise = amount_paise, refunded_by = ?, updated_at = datetime('now')
        WHERE order_id = ?
      `).run(actorEmail, order.id);
    }

    db.prepare(`
      INSERT INTO audit_logs (actor_email, actor_role, action, entity_type, entity_id, details_json)
      VALUES (?, ?, 'ORDER_FULFILMENT_UPDATED', 'ORDER', ?, ?)
    `).run(
      actorEmail,
      actorRole,
      orderNumber,
      JSON.stringify({
        previousFulfilment: order.fulfilment_status,
        newFulfilment: fulfilmentStatus,
        courierName,
        trackingNumber,
        stockRestored: shouldRestoreStock
      })
    );

    db.prepare(`
      INSERT INTO notification_logs (order_number, channel, recipient, event_type, subject, body_preview)
      VALUES (?, 'EMAIL', ?, ?, ?, ?)
    `).run(
      orderNumber,
      order.customer_email,
      `ORDER_${fulfilmentStatus.toUpperCase().replace(/\s+/g, '_')}`,
      `Order ${orderNumber} status updated to ${fulfilmentStatus}`,
      courierName ? `Courier: ${courierName}, Tracking: ${trackingNumber}` : `Status: ${fulfilmentStatus}`
    );

    db.exec('COMMIT;');
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

module.exports = {
  rustWasm,
  wasmLineTotalPaise,
  wasmInclusiveGstPaise,
  wasmCouponDiscountPaise,
  wasmShippingPaise,
  wasmOrderTotalPaise,
  ORDER_PAYMENT_STATUSES,
  ORDER_FULFILMENT_STATUSES,
  computeRazorpaySignature,
  verifyRazorpaySignature,
  calculateCartPricing,
  createOrder,
  verifyAndCaptureOnlinePayment,
  updateOrderFulfilmentAndShipping
};
