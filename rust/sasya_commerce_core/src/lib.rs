//! Sasya Naturals — Deterministic Integer-Paise E-Commerce Math Engine (Rust -> WASM)
//! Eliminates IEEE-754 floating-point drift across line totals, GST slabs, coupons, and shipping.

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
pub extern "C" fn compute_shipping_paise(
    discounted_subtotal_paise: i64,
    free_threshold_paise: i64,
    standard_shipping_paise: i64,
) -> i64 {
    if discounted_subtotal_paise <= 0 {
        return 0;
    }
    if discounted_subtotal_paise >= free_threshold_paise {
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
