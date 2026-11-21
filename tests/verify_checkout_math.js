'use strict';

const assert = require('node:assert');
const { getDb } = require('../src/db/database');
const {
  wasmLineTotalPaise,
  wasmInclusiveGstPaise,
  wasmCouponDiscountPaise,
  calculateCartPricing,
  createOrder,
  verifyAndCaptureOnlinePayment,
  updateOrderFulfilmentAndShipping
} = require('../src/core/checkout/checkoutEngine');

function runVerifyCheckoutMath() {
  const db = getDb();

  // 1. Direct Rust WASM arithmetic check
  assert.strictEqual(wasmLineTotalPaise(75000, 2), 150000, 'Rust WASM line total mismatch');
  assert.strictEqual(wasmInclusiveGstPaise(105000, 5), 5000, 'Rust WASM 5% inclusive GST mismatch');
  assert.strictEqual(wasmCouponDiscountPaise(100000, 'PERCENT', 10, 49900, 50000), 10000, 'Rust WASM 10% coupon mismatch');

  // 2. Cart Pricing with SASYA10 coupon & free shipping threshold
  const cartCalc = calculateCartPricing([{ variantId: 2, quantity: 2 }], 'SASYA10', 'ONLINE_UPI');
  assert.strictEqual(cartCalc.engine, 'rust-wasm-v1');
  assert.strictEqual(cartCalc.subtotalPaise, 150000); // 2 x Rs 750 = Rs 1500
  assert.strictEqual(cartCalc.discountPaise, 15000);  // 10% off = Rs 150
  assert.strictEqual(cartCalc.shippingPaise, 0);      // >= Rs 799 -> FREE
  assert.strictEqual(cartCalc.totalPaise, 135000);    // Rs 1350.00

  // 3. Test Online Order Creation -> Server HMAC-SHA256 Verification -> Atomic Stock Decrement -> Cancellation Stock Restoration
  const beforeStock = db.prepare('SELECT stock_qty FROM product_variants WHERE id = 3').get().stock_qty;

  const created = createOrder({
    customerName: 'Test Buyer',
    customerEmail: 'buyer@example.com',
    customerPhone: '+91 98111 22333',
    shippingLine1: '12 MG Road',
    shippingCity: 'Bengaluru',
    shippingState: 'Karnataka',
    shippingPincode: '560001',
    items: [{ variantId: 3, quantity: 2 }],
    couponCode: 'SASYA10',
    paymentMethod: 'ONLINE_UPI'
  });

  assert.strictEqual(created.paymentStatus, 'PENDING_PAYMENT');
  assert.strictEqual(created.fulfilmentStatus, 'Pending Payment');

  // Stock must NOT be deducted before online payment verification
  const midStock = db.prepare('SELECT stock_qty FROM product_variants WHERE id = 3').get().stock_qty;
  assert.strictEqual(midStock, beforeStock, 'Stock must not decrement before online payment HMAC verification');

  // Spoofed signature must fail
  assert.throws(() => {
    verifyAndCaptureOnlinePayment({
      orderNumber: created.orderNumber,
      gatewayOrderId: created.gatewayOrderId,
      gatewayPaymentId: 'pay_fake',
      gatewaySignature: 'deadbeef00000000000000000000000000000000000000000000000000000000'
    });
  }, /HMAC-SHA256 mismatch/);

  // Valid server HMAC signature must succeed and atomically deduct stock
  const simPayId = `pay_rzp_${created.orderNumber.replace(/-/g, '')}`;
  const verified = verifyAndCaptureOnlinePayment({
    orderNumber: created.orderNumber,
    gatewayOrderId: created.gatewayOrderId,
    gatewayPaymentId: simPayId,
    gatewaySignature: created.sandboxSignaturePreview
  });
  assert.strictEqual(verified.paymentStatus, 'PAID');
  assert.strictEqual(verified.fulfilmentStatus, 'Confirmed');

  const afterPaidStock = db.prepare('SELECT stock_qty FROM product_variants WHERE id = 3').get().stock_qty;
  assert.strictEqual(afterPaidStock, beforeStock - 2, 'Stock must decrement by 2 after verified payment');

  // Idempotent duplicate webhook check (must not double-deduct stock)
  const dupVerified = verifyAndCaptureOnlinePayment({
    orderNumber: created.orderNumber,
    gatewayOrderId: created.gatewayOrderId,
    gatewayPaymentId: simPayId,
    gatewaySignature: created.sandboxSignaturePreview
  });
  assert.strictEqual(dupVerified.alreadyPaid, true);
  assert.strictEqual(
    db.prepare('SELECT stock_qty FROM product_variants WHERE id = 3').get().stock_qty,
    beforeStock - 2,
    'Duplicate payment callback must not double-deduct stock'
  );

  // Manual Shipping update -> Shipped requires courier name & tracking number
  assert.throws(() => {
    updateOrderFulfilmentAndShipping({
      orderNumber: created.orderNumber,
      fulfilmentStatus: 'Shipped',
      courierName: '',
      trackingNumber: ''
    });
  }, /require Courier Name and Tracking Number/);

  const shipped = updateOrderFulfilmentAndShipping({
    orderNumber: created.orderNumber,
    fulfilmentStatus: 'Shipped',
    courierName: 'Delhivery Surface',
    trackingNumber: 'DLV99281726IN',
    trackingUrl: 'https://www.delhivery.com/track/package/DLV99281726IN',
    dispatchDate: '2026-11-21'
  });
  assert.strictEqual(shipped.fulfilment_status, 'Shipped');
  assert.strictEqual(shipped.courier_name, 'Delhivery Surface');

  // Refund / Cancellation must atomically restore stock
  const refunded = updateOrderFulfilmentAndShipping({
    orderNumber: created.orderNumber,
    fulfilmentStatus: 'Refunded'
  });
  assert.strictEqual(refunded.fulfilment_status, 'Refunded');
  assert.strictEqual(refunded.payment_status, 'REFUNDED');
  const restoredStock = db.prepare('SELECT stock_qty FROM product_variants WHERE id = 3').get().stock_qty;
  assert.strictEqual(restoredStock, beforeStock, 'Stock must be restored to original count on Refund/Cancellation');

  console.log('✓ [Suite 3/7: verify_checkout_math] Verified Rust WASM paise math, Razorpay HMAC-SHA256, idempotency, manual shipping & atomic stock lifecycle');
}

if (require.main === module) {
  runVerifyCheckoutMath();
}

module.exports = { runVerifyCheckoutMath };
