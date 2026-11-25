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

  // 2. Cart Pricing with SASHYA10 (and backward-compatible SASYA10 alias) coupon & free shipping threshold
  const cartCalc = calculateCartPricing([{ variantId: 2, quantity: 2 }], 'SASHYA10', 'ONLINE_UPI');
  assert.strictEqual(cartCalc.engine, 'rust-wasm-v1.2-zone-slab');
  assert.strictEqual(cartCalc.appliedCoupon, 'SASHYA10');
  assert.strictEqual(cartCalc.subtotalPaise, 150000); // 2 x Rs 750 = Rs 1500
  assert.strictEqual(cartCalc.discountPaise, 15000);  // 10% off = Rs 150
  assert.strictEqual(cartCalc.shippingPaise, 0);      // >= Rs 799 -> FREE
  assert.strictEqual(cartCalc.totalPaise, 135000);    // Rs 1350.00
  const legacyCouponCalc = calculateCartPricing([{ variantId: 2, quantity: 2 }], 'SASYA10', 'ONLINE_UPI');
  assert.strictEqual(legacyCouponCalc.discountPaise, 15000, 'Backward-compatible SASYA10 coupon must also apply 10% discount');

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

  // Pre-dispatch Delivery Address & Instructions update
  const { updateOrderDeliveryAddress } = require('../src/core/checkout/checkoutEngine');
  const addrUpdated = updateOrderDeliveryAddress({
    orderNumber: created.orderNumber,
    customerName: 'Test Buyer Updated',
    customerPhone: '+91 98111 22333',
    shippingLine1: '88 Residency Road, 3rd Floor',
    shippingLine2: 'Near Richmond Circle',
    shippingCity: 'Bengaluru',
    shippingState: 'Karnataka',
    shippingPincode: '560025',
    deliveryInstructions: 'Call on arrival at gate'
  });
  assert.strictEqual(addrUpdated.shipping_line1, '88 Residency Road, 3rd Floor');
  assert.strictEqual(addrUpdated.shipping_pincode, '560025');
  assert.strictEqual(addrUpdated.delivery_instructions, 'Call on arrival at gate');

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

  // 4. Verify Intra-State (CGST + SGST) vs Inter-State (IGST) Tax Split
  const intraCalc = calculateCartPricing([{ variantId: 2, quantity: 1 }], '', 'ONLINE_UPI', 'Karnataka', '560038');
  assert.strictEqual(intraCalc.taxSupplyType, 'CGST_SGST');
  assert(intraCalc.cgstPaise > 0 && intraCalc.sgstPaise > 0 && intraCalc.igstPaise === 0, 'Karnataka order must split CGST + SGST');

  const interCalc = calculateCartPricing([{ variantId: 2, quantity: 1 }], '', 'ONLINE_UPI', 'Maharashtra', '411004');
  assert.strictEqual(interCalc.taxSupplyType, 'IGST');
  assert(interCalc.igstPaise > 0 && interCalc.cgstPaise === 0 && interCalc.sgstPaise === 0, 'Inter-state order must bill IGST');

  // 5. Verify PIN-Code Serviceability & COD Mobile OTP Anti-RTO Gate
  const { validatePincodeServiceability, requestCodOtp, verifyCodOtp } = require('../src/core/checkout/codProtection');
  assert.throws(() => validatePincodeServiceability('999999', 'ONLINE_UPI'), /not a valid serviceable/);
  assert.throws(() => validatePincodeServiceability('800099', 'COD'), /Cash on Delivery is unavailable for PIN code 800099/);
  assert.strictEqual(validatePincodeServiceability('800099', 'ONLINE_UPI').serviceable, true);

  const otpDispatch = requestCodOtp('+91 98450 77889');
  assert(otpDispatch.sent && otpDispatch.sandboxOtpPreview, 'COD OTP must be generated');
  assert.throws(() => verifyCodOtp('+91 98450 77889', '000000'), /Incorrect 6-digit COD OTP/);
  const otpValid = verifyCodOtp('+91 98450 77889', otpDispatch.sandboxOtpPreview);
  assert.strictEqual(otpValid.verified, true);

  // 6. Verify Magic-Byte Validated Product & Category Image Upload Pipeline
  const { uploadProductImage, uploadCategoryImage } = require('../src/core/checkout/imageUploader');
  const fakeScriptBase64 = Buffer.from('<?php echo "hack"; ?>', 'utf8').toString('base64');
  assert.throws(() => {
    uploadProductImage({ productId: 1, imageBase64: fakeScriptBase64, caption: 'Malicious payload' });
  }, /Security Violation: File magic bytes/);

  // Minimal valid 1x1 PNG magic bytes
  const validPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const uploaded = uploadProductImage({ productId: 1, imageBase64: validPngBase64, caption: 'Back FSSAI Label', setAsPrimary: false });
  assert(uploaded.publicUrl.startsWith('/uploads/') && uploaded.mime === 'image/png', 'Valid PNG magic-byte product upload must succeed');

  const uploadedCat = uploadCategoryImage({ categoryId: 1, imageBase64: validPngBase64 });
  assert(uploadedCat.publicUrl.startsWith('/uploads/') && uploadedCat.mime === 'image/png', 'Valid PNG magic-byte category upload must succeed');

  // Restore canonical studio image on Category #1 and Product #1 for clean GitHub Pages export
  db.prepare("UPDATE categories SET image_url = '/images/cat-dry-fruits.jpg' WHERE id = 1").run();
  db.prepare("UPDATE products SET image_url = '/images/cat-dry-fruits.jpg', gallery_json = '[]' WHERE id = 1").run();

  // 7. Verify 4-Zone + 500g Weight-Slab + Free-Delivery Mode Switch (DISABLED vs THRESHOLD_WITH_WEIGHT_CAP) + COD Fee
  const { updateShippingPolicySettings } = require('../src/core/checkout/checkoutEngine');

  // 7a. Heavy order (> 2,000g weight cap, e.g. 3 x 1kg Almonds variant #4 = 3,000g + 150g tare = 3,150g = 7 slabs of 500g)
  // Even though subtotal > Rs 799, THRESHOLD_WITH_WEIGHT_CAP must charge full Zone C freight (Rs 75 + 6 * Rs 35 = Rs 285 = 28500 paise)
  const heavyZoneC = calculateCartPricing([{ variantId: 4, quantity: 1 }, { variantId: 8, quantity: 2 }], '', 'ONLINE_UPI', 'Delhi', '110001');
  assert.strictEqual(heavyZoneC.shippingZone, 'ZONE_C');
  assert.strictEqual(heavyZoneC.totalWeightGrams, 3000);
  assert.strictEqual(heavyZoneC.billable500gSlabs, 7); // ceil(3150 / 500) = 7
  assert.strictEqual(heavyZoneC.freeShippingApplied, false, 'Orders exceeding 2000g cap must not get free shipping');
  assert.strictEqual(heavyZoneC.shippingPaise, 28500);

  // 7b. Switch Free-Delivery Mode to DISABLED (Never Free) and verify light order above Rs 799 pays Zone A + COD Fee
  updateShippingPolicySettings({ shipping_free_mode: 'DISABLED' });
  const noFreeDeliveryCalc = calculateCartPricing([{ variantId: 2, quantity: 2 }], '', 'COD', 'Karnataka', '560038');
  // 2 x 250g = 500g + 150g tare = 650g -> 2 slabs in Zone A (Rs 40 base + Rs 15 extra = Rs 55 freight) + Rs 40 COD fee = Rs 95 (9500 paise)
  assert.strictEqual(noFreeDeliveryCalc.freeShippingMode, 'DISABLED');
  assert.strictEqual(noFreeDeliveryCalc.freightPaise, 5500);
  assert.strictEqual(noFreeDeliveryCalc.codFeePaise, 4000);
  assert.strictEqual(noFreeDeliveryCalc.shippingPaise, 9500);

  // Restore default policy
  updateShippingPolicySettings({ shipping_free_mode: 'THRESHOLD_WITH_WEIGHT_CAP' });

  // 8. Verify Per-Product PIN Code Delivery Restrictions (ALLOW_ONLY, BLOCK_LIST, BLOCK_COD_ONLY & Mixed-Cart Enforcement)
  const { normalizePincodeRulesPayload, getDefaultPincodeRules } = require('../src/db/database');
  assert.throws(
    () => normalizePincodeRulesPayload({ mode: 'ALLOW_ONLY', zones: [], rawTokens: '' }, getDefaultPincodeRules(), { strict: true }),
    /Please select at least one Shipping Zone or enter at least one PIN code/
  );
  assert.throws(
    () => normalizePincodeRulesPayload({ mode: 'BLOCK_LIST', rawTokens: '560099-560001' }, getDefaultPincodeRules(), { strict: true }),
    /start PIN \(560099\) must be <= end PIN/
  );
  assert.throws(
    () => normalizePincodeRulesPayload({ mode: 'ALLOW_ONLY', rawTokens: '000123' }, getDefaultPincodeRules(), { strict: true }),
    /Invalid PIN code token/
  );

  // 8a. Configure Product #2 (Goan W240 Cashews, variant #5) as ALLOW_ONLY for Zone A, prefix 400*, and range 110001-110010
  const allowRule = normalizePincodeRulesPayload({
    mode: 'ALLOW_ONLY',
    scope: 'BLOCK_DELIVERY',
    zones: ['ZONE_A'],
    rawTokens: '400*, 110001-110010, 600001',
    reason: 'Special batch deliverable only in Bengaluru (Zone A), Mumbai (400*), New Delhi (110001-110010), and Chennai (600001).'
  }, getDefaultPincodeRules(), { strict: true });

  db.prepare('UPDATE products SET pincode_restriction_mode = ?, pincode_rules_json = ? WHERE id = 2')
    .run(allowRule.mode, JSON.stringify(allowRule));

  // Verify allowed PINs (Zone A 560038, Prefix 400050, Range 110005, Exact 600001)
  assert.strictEqual(validatePincodeServiceability('560038', 'ONLINE_UPI', { productId: 2 }).serviceable, true);
  assert.strictEqual(validatePincodeServiceability('400050', 'ONLINE_UPI', { productId: 2 }).serviceable, true);
  assert.strictEqual(validatePincodeServiceability('110005', 'ONLINE_UPI', { productId: 2 }).serviceable, true);
  assert.strictEqual(validatePincodeServiceability('600001', 'ONLINE_UPI', { productId: 2 }).serviceable, true);

  // Verify restricted PIN (700001 Kolkata)
  assert.throws(
    () => validatePincodeServiceability('700001', 'ONLINE_UPI', { productId: 2 }),
    /is unavailable at PIN code 700001/
  );
  const nonThrowCheck = validatePincodeServiceability('700001', 'ONLINE_UPI', { productId: 2, throwOnProductBlock: false });
  assert.strictEqual(nonThrowCheck.serviceable, false);
  assert.strictEqual(nonThrowCheck.deliverablePrepaid, false);

  // Mixed-cart pricing calculation at restricted PIN 700001 (Variant #2 unrestricted + Variant #5 restricted)
  const mixedCartCalc = calculateCartPricing(
    [{ variantId: 2, quantity: 1 }, { variantId: 5, quantity: 1 }],
    '',
    'ONLINE_UPI',
    'West Bengal',
    '700001'
  );
  assert.strictEqual(mixedCartCalc.allItemsServiceable, false, 'Mixed cart with restricted product must flag allItemsServiceable=false');
  assert.strictEqual(mixedCartCalc.unserviceableItems.length, 1, 'Mixed cart must identify exactly 1 unserviceable item');
  assert.strictEqual(mixedCartCalc.unserviceableItems[0].variantId, 5);

  // Hard server gate on createOrder must block order creation for mixed cart at restricted PIN 700001
  assert.throws(() => {
    createOrder({
      customerName: 'Mixed Cart Buyer',
      customerEmail: 'buyer@example.com',
      customerPhone: '+91 98111 22333',
      shippingLine1: '14 Park Street',
      shippingCity: 'Kolkata',
      shippingState: 'West Bengal',
      shippingPincode: '700001',
      items: [{ variantId: 2, quantity: 1 }, { variantId: 5, quantity: 1 }],
      paymentMethod: 'ONLINE_UPI'
    });
  }, /Delivery to PIN code 700001 is restricted for/);

  // 8b. Configure Product #2 as BLOCK_LIST with scope BLOCK_COD_ONLY for Zone D (e.g. 781001 Guwahati)
  const blockCodRule = normalizePincodeRulesPayload({
    mode: 'BLOCK_LIST',
    scope: 'BLOCK_COD_ONLY',
    zones: ['ZONE_D'],
    rawTokens: '500001',
    reason: 'Prepaid only for this product in remote Zone D and PIN 500001.'
  }, getDefaultPincodeRules(), { strict: true });

  db.prepare('UPDATE products SET pincode_restriction_mode = ?, pincode_rules_json = ? WHERE id = 2')
    .run(blockCodRule.mode, JSON.stringify(blockCodRule));

  const prepaidZoneD = calculateCartPricing([{ variantId: 5, quantity: 1 }], '', 'ONLINE_UPI', 'Assam', '781001');
  assert.strictEqual(prepaidZoneD.allItemsServiceable, true, 'Prepaid order must be serviceable when scope is BLOCK_COD_ONLY');
  assert.strictEqual(prepaidZoneD.codRestrictedItems.length, 1);
  assert.strictEqual(prepaidZoneD.codAllowed, false);

  assert.throws(() => {
    createOrder({
      customerName: 'COD Zone D Buyer',
      customerEmail: 'buyer@example.com',
      customerPhone: '+91 98111 22333',
      shippingLine1: 'GS Road',
      shippingCity: 'Guwahati',
      shippingState: 'Assam',
      shippingPincode: '781001',
      items: [{ variantId: 5, quantity: 1 }],
      paymentMethod: 'COD'
    });
  }, /Cash on Delivery at PIN code 781001 is unavailable for/);

  // Reset Product #2 back to unrestricted baseline
  db.prepare("UPDATE products SET pincode_restriction_mode = 'NONE', pincode_rules_json = '{}' WHERE id = 2").run();

  // Clean up test order so showcase export stays canonical
  db.prepare('DELETE FROM orders WHERE order_number = ?').run(created.orderNumber);
  db.prepare("DELETE FROM orders WHERE customer_email = 'buyer@example.com'").run();

  console.log('✓ [Suite 3/7: verify_checkout_math] Verified Rust WASM 4-Zone + 500g Weight-Slab Shipping, Free-Delivery Modes, Per-Product PIN Restrictions, CGST/SGST vs IGST, COD OTP & Razorpay HMAC');
}

if (require.main === module) {
  runVerifyCheckoutMath();
}

module.exports = { runVerifyCheckoutMath };
