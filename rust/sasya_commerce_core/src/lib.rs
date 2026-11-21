//! Sasya Naturals — Deterministic Integer-Paise E-Commerce Math Engine (Rust -> WASM)
//! Eliminates IEEE-754 floating-point drift across line totals, GST slabs, coupons, and 4-Zone weight-slab shipping.

#[no_mangle]
pub extern "C" fn compute_line_total_paise(unit_price_paise: i64, quantity: i64) -> i64 {
    if unit_price_paise <= 0 || quantity <= 0 {
        return 0;
    }
    unit_price_paise.saturating_mul(quantity)
}

#[no_mangle]
pub extern "C" fn compute_inclusive_gst_paise(line_total_paise: i64, gst_percent: i64) -> i64 {
    if line_total_paise <= 0 || gst_percent <= 0 {
        return 0;
    }
    let denom = 100_i64.saturating_add(gst_percent);
    let numer = line_total_paise
        .saturating_mul(gst_percent)
        .saturating_add(denom / 2);
    numer / denom
}

/// discount_type: 1 = PERCENT (e.g. 10 for 10%), 2 = FLAT_PAISE (e.g. 10000 for Rs. 100)
#[no_mangle]
pub extern "C" fn compute_coupon_discount_paise(
    subtotal_paise: i64,
    discount_type: i32,
    discount_value: i64,
    min_order_paise: i64,
    max_discount_paise: i64,
) -> i64 {
    if subtotal_paise <= 0 || discount_value <= 0 || subtotal_paise < min_order_paise {
        return 0;
    }
    let raw_discount = match discount_type {
        1 => subtotal_paise
            .saturating_mul(discount_value)
            .saturating_add(50)
            / 100,
        2 => discount_value,
        _ => 0,
    };
    let capped = if max_discount_paise > 0 && raw_discount > max_discount_paise {
        max_discount_paise
    } else {
        raw_discount
    };
    if capped > subtotal_paise {
        subtotal_paise
    } else {
        capped
    }
}

#[no_mangle]
pub extern "C" fn compute_billable_500g_slabs(
    total_product_grams: i64,
    packaging_tare_grams: i64,
) -> i64 {
    if total_product_grams <= 0 {
        return 0;
    }
    let gross = total_product_grams.saturating_add(packaging_tare_grams.max(0));
    let slabs = gross.saturating_add(499) / 500;
    slabs.max(1)
}

/// Computes deterministic delivery charge in paise based on:
/// - total_product_grams + packaging_tare_grams -> 500g slabs
/// - base_500g_paise + (slabs - 1) * extra_500g_paise
/// - free_mode:
///     0 = DISABLED (never free)
///     1 = THRESHOLD_WITH_WEIGHT_CAP (free only if discounted_subtotal >= free_threshold AND total_product_grams <= free_max_weight_grams)
///     2 = UNCONDITIONAL_THRESHOLD (free if discounted_subtotal >= free_threshold regardless of weight)
/// - cod_fee_paise (added when is_cod == 1)
#[no_mangle]
pub extern "C" fn compute_zone_weight_shipping_paise(
    discounted_subtotal_paise: i64,
    total_product_grams: i64,
    packaging_tare_grams: i64,
    base_500g_paise: i64,
    extra_500g_paise: i64,
    free_mode: i32,
    free_threshold_paise: i64,
    free_max_weight_grams: i64,
    is_cod: i32,
    cod_fee_paise: i64,
) -> i64 {
    if discounted_subtotal_paise <= 0 || total_product_grams <= 0 {
        return 0;
    }
    let slabs = compute_billable_500g_slabs(total_product_grams, packaging_tare_grams);
    let extra_slabs = (slabs - 1).max(0);
    let raw_freight = base_500g_paise
        .max(0)
        .saturating_add(extra_slabs.saturating_mul(extra_500g_paise.max(0)));

    let qualifies_free = match free_mode {
        1 => {
            free_threshold_paise > 0
                && discounted_subtotal_paise >= free_threshold_paise
                && total_product_grams <= free_max_weight_grams.max(0)
        }
        2 => free_threshold_paise > 0 && discounted_subtotal_paise >= free_threshold_paise,
        _ => false, // 0 = DISABLED
    };

    let freight = if qualifies_free { 0 } else { raw_freight };
    let cod_surcharge = if is_cod == 1 { cod_fee_paise.max(0) } else { 0 };
    freight.saturating_add(cod_surcharge)
}

#[no_mangle]
pub extern "C" fn compute_shipping_paise(
    discounted_subtotal_paise: i64,
    free_threshold_paise: i64,
    standard_shipping_paise: i64,
) -> i64 {
    if discounted_subtotal_paise <= 0 {
        return 0;
    }
    if free_threshold_paise > 0 && discounted_subtotal_paise >= free_threshold_paise {
        0
    } else {
        standard_shipping_paise.max(0)
    }
}

#[no_mangle]
pub extern "C" fn compute_order_total_paise(
    subtotal_paise: i64,
    discount_paise: i64,
    shipping_paise: i64,
) -> i64 {
    let discounted = subtotal_paise.saturating_sub(discount_paise).max(0);
    discounted.saturating_add(shipping_paise.max(0))
}
