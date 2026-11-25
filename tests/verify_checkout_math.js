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

  // 9. Verify v3.3.0 Promotional Coupons Engine (UNIVERSAL, IST Time-Window, ONCE_PER_CUSTOMER Zero-Burn, SINGLE_USE_GLOBAL & Hello Bar Auto-Disappear)
  const {
    upsertAdminCoupon,
    toggleAdminCouponActive,
    deleteAdminCoupon,
    listEnrichedCoupons
  } = require('../src/core/checkout/checkoutEngine');
  const {
    updateHelloBarConfig,
    getHelloBarConfig
  } = require('../src/core/content/contentStore');
  const {
    resolveHelloBarForRender,
    renderHomePage,
    renderCheckoutPage
  } = require('../src/views/renderViews');

  // 9a. Time-Dependent Coupon (IST Schedule Window: SCHEDULED -> ACTIVE -> EXPIRED)
  upsertAdminCoupon({
    code: 'FLASH20',
    description: '20% off harvest flash sale above Rs. 500',
    discountType: 'PERCENT',
    discountValueInr: 20,
    minOrderInr: 500,
    maxDiscountInr: 400,
    usageType: 'UNIVERSAL',
    startsAtIst: '2026-12-01T10:00',
    expiresAtIst: '2026-12-05T22:00',
    visibility: 'PUBLIC_CHIP',
    isActive: 1
  });

  // Before window (2026-11-30T09:00 IST) -> SCHEDULED
  const scheduledCalc = calculateCartPricing([{ variantId: 2, quantity: 1 }], 'FLASH20', 'ONLINE_UPI', 'Karnataka', '560038', {
    nowIst: '2026-11-30T09:00'
  });
  assert.strictEqual(scheduledCalc.couponStatus, 'SCHEDULED');
  assert.strictEqual(scheduledCalc.discountPaise, 0);

  // Inside window (2026-12-02T14:30 IST) -> ACTIVE (20% of Rs 750 = Rs 150 = 15000 paise)
  const activeWindowCalc = calculateCartPricing([{ variantId: 2, quantity: 1 }], 'FLASH20', 'ONLINE_UPI', 'Karnataka', '560038', {
    nowIst: '2026-12-02T14:30'
  });
  assert.strictEqual(activeWindowCalc.couponStatus, 'ACTIVE');
  assert.strictEqual(activeWindowCalc.discountPaise, 15000);

  // After window (2026-12-06T00:01 IST) -> EXPIRED
  const expiredWindowCalc = calculateCartPricing([{ variantId: 2, quantity: 1 }], 'FLASH20', 'ONLINE_UPI', 'Karnataka', '560038', {
    nowIst: '2026-12-06T00:01'
  });
  assert.strictEqual(expiredWindowCalc.couponStatus, 'EXPIRED');
  assert.strictEqual(expiredWindowCalc.discountPaise, 0);

  // 9b. One-Time Per Customer Coupon (ONCE_PER_CUSTOMER: Phone + Email enforcement & Zero-Burn on PENDING_PAYMENT)
  upsertAdminCoupon({
    code: 'FIRSTBUY150',
    description: 'Flat Rs. 150 off once per customer above Rs. 500',
    discountType: 'FLAT_PAISE',
    discountValueInr: 150,
    minOrderInr: 500,
    usageType: 'ONCE_PER_CUSTOMER',
    visibility: 'PUBLIC_CHIP',
    isActive: 1
  });

  // Unpaid PENDING_PAYMENT order must NOT burn the customer's one-time coupon if they retry checkout
  const pendingOrd = createOrder({
    customerName: 'Rohan Kulkarni',
    customerEmail: 'rohan.once@example.com',
    customerPhone: '+91 98450 55667',
    shippingLine1: '22 Residency Road',
    shippingCity: 'Bengaluru',
    shippingState: 'Karnataka',
    shippingPincode: '560025',
    items: [{ variantId: 2, quantity: 1 }],
    couponCode: 'FIRSTBUY150',
    paymentMethod: 'ONLINE_UPI'
  });
  assert.strictEqual(pendingOrd.paymentStatus, 'PENDING_PAYMENT');
  assert.strictEqual(pendingOrd.pricing.discountPaise, 15000);

  // Customer retries while first order is still PENDING_PAYMENT -> must still be ACTIVE (Zero-Burn!)
  const retryCalc = calculateCartPricing([{ variantId: 2, quantity: 1 }], 'FIRSTBUY150', 'ONLINE_UPI', 'Karnataka', '560025', {
    customerEmail: 'rohan.once@example.com',
    customerPhone: '9845055667'
  });
  assert.strictEqual(retryCalc.couponStatus, 'ACTIVE', 'Unpaid PENDING_PAYMENT order must not burn ONCE_PER_CUSTOMER coupon');
  assert.strictEqual(retryCalc.discountPaise, 15000);

  // Now capture the online payment -> order becomes PAID
  verifyAndCaptureOnlinePayment({
    orderNumber: pendingOrd.orderNumber,
    gatewayOrderId: pendingOrd.gatewayOrderId,
    gatewayPaymentId: `pay_rzp_${pendingOrd.orderNumber.replace(/-/g, '')}`,
    gatewaySignature: pendingOrd.sandboxSignaturePreview
  });

  // Same customer attempts reuse with DIFFERENT email but SAME 10-digit phone (9845055667) -> CUSTOMER_LIMIT_REACHED
  const samePhoneCalc = calculateCartPricing([{ variantId: 2, quantity: 1 }], 'FIRSTBUY150', 'ONLINE_UPI', 'Karnataka', '560025', {
    customerEmail: 'rohan.alias2@example.com',
    customerPhone: '098450-55667'
  });
  assert.strictEqual(samePhoneCalc.couponStatus, 'CUSTOMER_LIMIT_REACHED', 'Normalized 10-digit phone match must block second ONCE_PER_CUSTOMER redemption');
  assert.strictEqual(samePhoneCalc.discountPaise, 0);

  assert.throws(() => {
    createOrder({
      customerName: 'Rohan Alias',
      customerEmail: 'rohan.alias2@example.com',
      customerPhone: '9845055667',
      shippingLine1: '22 Residency Road',
      shippingCity: 'Bengaluru',
      shippingState: 'Karnataka',
      shippingPincode: '560025',
      items: [{ variantId: 2, quantity: 1 }],
      couponCode: 'FIRSTBUY150',
      paymentMethod: 'ONLINE_UPI'
    });
  }, /already been used on a previous order/);

  // Different customer (different email + different phone) CAN redeem FIRSTBUY150
  const otherCustCalc = calculateCartPricing([{ variantId: 2, quantity: 1 }], 'FIRSTBUY150', 'ONLINE_UPI', 'Karnataka', '560025', {
    customerEmail: 'meera.fresh@example.com',
    customerPhone: '9845099887'
  });
  assert.strictEqual(otherCustCalc.couponStatus, 'ACTIVE');
  assert.strictEqual(otherCustCalc.discountPaise, 15000);

  // 9c. Single-Use Global Coupon (SINGLE_USE_GLOBAL: 1 total redemption across store + automatic restoration on Cancel/Refund)
  upsertAdminCoupon({
    code: 'VIPGIFT200',
    description: 'Single-use Rs. 200 VIP voucher',
    discountType: 'FLAT_PAISE',
    discountValueInr: 200,
    minOrderInr: 500,
    usageType: 'SINGLE_USE_GLOBAL',
    visibility: 'SECRET_CODE',
    isActive: 1
  });

  // Secret code must NOT appear in public checkout coupon chips
  const checkoutHtml = renderCheckoutPage({
    coupons: listEnrichedCoupons(),
    customer: null,
    addresses: []
  });
  assert(!checkoutHtml.includes('data-apply-coupon-chip="VIPGIFT200"'), 'SECRET_CODE coupon must never leak into public checkout chips');

  // First customer redeems VIPGIFT200 via COD (finalized COD_PENDING order)
  const vipOrd = createOrder({
    customerName: 'VIP Buyer 1',
    customerEmail: 'vip1@example.com',
    customerPhone: '9845011122',
    shippingLine1: '10 Lavelle Road',
    shippingCity: 'Bengaluru',
    shippingState: 'Karnataka',
    shippingPincode: '560001',
    items: [{ variantId: 2, quantity: 1 }],
    couponCode: 'VIPGIFT200',
    paymentMethod: 'COD'
  });
  assert.strictEqual(vipOrd.pricing.discountPaise, 20000);

  // Second customer tries VIPGIFT200 -> LIMIT_REACHED (1/1 used)
  const secondVipTry = calculateCartPricing([{ variantId: 2, quantity: 1 }], 'VIPGIFT200', 'ONLINE_UPI', 'Karnataka', '560001', {
    customerEmail: 'vip2@example.com',
    customerPhone: '9845033344'
  });
  assert.strictEqual(secondVipTry.couponStatus, 'LIMIT_REACHED');
  assert.strictEqual(secondVipTry.discountPaise, 0);

  // Cancel first VIP order -> slot is automatically restored (0/1 used)!
  updateOrderFulfilmentAndShipping({
    orderNumber: vipOrd.orderNumber,
    fulfilmentStatus: 'Cancelled'
  });
  const restoredVipTry = calculateCartPricing([{ variantId: 2, quantity: 1 }], 'VIPGIFT200', 'ONLINE_UPI', 'Karnataka', '560001', {
    customerEmail: 'vip2@example.com',
    customerPhone: '9845033344'
  });
  assert.strictEqual(restoredVipTry.couponStatus, 'ACTIVE', 'Cancelling order must restore SINGLE_USE_GLOBAL coupon slot');
  assert.strictEqual(restoredVipTry.discountPaise, 20000);

  // 9d. Hello Bar (.sn-topbar) Content Controller, Linked Coupon Circuit-Breaker & Auto-Disappear Rule
  // Custom text + linked coupon paused -> STRIP_COUPON_CLAUSE strips the dead coupon clause
  toggleAdminCouponActive('FLASH20', 0);
  updateHelloBarConfig({
    enabled: true,
    templateText: '{{SHIPPING_POLICY}} | Use code FLASH20 for 20% off',
    linkedCouponCode: 'FLASH20',
    expiredCouponBehavior: 'STRIP_COUPON_CLAUSE'
  });
  const strippedHb = resolveHelloBarForRender(getHelloBarConfig());
  assert.strictEqual(strippedHb.visible, true);
  assert(!strippedHb.announcementHtml.includes('FLASH20'), 'Paused/expired linked coupon clause must be stripped from Hello Bar');
  assert(strippedHb.announcementHtml.includes('Complimentary India-Wide Delivery'), 'Shipping policy clause must remain visible when coupon clause is stripped');

  // Empty templateText -> Hello Bar disappears completely (visible: false, 0 .sn-topbar in rendered HTML)
  updateHelloBarConfig({
    enabled: true,
    templateText: '   '
  });
  const emptyHb = resolveHelloBarForRender(getHelloBarConfig());
  assert.strictEqual(emptyHb.visible, false, 'Hello Bar must disappear when templateText is empty');
  const homeHtmlWithoutHelloBar = renderHomePage({
    categories: db.prepare('SELECT * FROM categories WHERE is_active = 1').all(),
    products: db.prepare('SELECT * FROM products WHERE is_active = 1 LIMIT 2').all(),
    variants: db.prepare('SELECT * FROM product_variants WHERE is_active = 1').all()
  });
  assert(!homeHtmlWithoutHelloBar.includes('<div class="sn-topbar"'), 'SSR page must completely omit .sn-topbar when Hello Bar has no content');

  // Clean up test coupons, orders, and Hello Bar settings back to canonical baseline
  deleteAdminCoupon('FLASH20');
  deleteAdminCoupon('FIRSTBUY150');
  deleteAdminCoupon('VIPGIFT200');
  updateOrderFulfilmentAndShipping({
    orderNumber: pendingOrd.orderNumber,
    fulfilmentStatus: 'Refunded'
  });
  db.prepare('DELETE FROM orders WHERE order_number IN (?, ?, ?)').run(created.orderNumber, pendingOrd.orderNumber, vipOrd.orderNumber);
  db.prepare("DELETE FROM orders WHERE customer_email IN ('buyer@example.com', 'rohan.once@example.com', 'vip1@example.com')").run();
  db.prepare("DELETE FROM store_settings WHERE key = 'content_hellobar_json'").run();
  db.prepare("DELETE FROM audit_logs WHERE action IN ('COUPON_CREATED', 'COUPON_UPDATED', 'COUPON_STATUS_TOGGLED', 'COUPON_DELETED', 'HELLOBAR_CONTENT_UPDATED')").run();

  console.log('✓ [Suite 3/7: verify_checkout_math] Verified Rust WASM 4-Zone + 500g Weight-Slab Shipping, Free-Delivery Modes, Per-Product PIN Restrictions, Universal/IST-Window/Once-Per-Customer/Single-Use Coupons, Hello Bar Auto-Disappear, CGST/SGST vs IGST, COD OTP & Razorpay HMAC');
}

if (require.main === module) {
  runVerifyCheckoutMath();
}

module.exports = { runVerifyCheckoutMath };
