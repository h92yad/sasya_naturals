'use strict';

/**
 * Comprehensive Financial, Time-Series, Product-Wise, Order & Payment Reporting Engine
 * (src/core/reports/reportingEngine.js)
 *
 * Implements Section 5.1 Reports requirements:
 * - Daily, Weekly, and Monthly sales rollups & granular date/week/month time-series tables
 * - Product-wise sales across all products (net of cancelled/refunded orders, plus variant breakdown & revenue share %)
 * - Order summaries by Fulfilment Status and Intra-State (CGST+SGST) vs. Inter-State (IGST) tax regime
 * - Payment summaries by Payment Method (UPI, Card, NetBanking, COD) and Payment Settlement Status
 * - CSV export generator for accounting & GST reconciliation
 */

const {
  ORDER_FULFILMENT_STATUSES,
  ORDER_PAYMENT_STATUSES
} = require('../../config/appConfig');

function parseOrderDateStr(createdAt) {
  const raw = String(createdAt || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

function getIsoWeekInfo(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  const dayNum = dt.getUTCDay() || 7; // Monday=1 ... Sunday=7

  // Monday of this week
  const monday = new Date(dt);
  monday.setUTCDate(dt.getUTCDate() - dayNum + 1);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  // Thursday in current week decides the ISO year
  const thursday = new Date(dt);
  thursday.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);

  const weekCode = `${thursday.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  const startStr = monday.toISOString().slice(0, 10);
  const endStr = sunday.toISOString().slice(0, 10);

  return {
    weekCode,
    label: `${weekCode} (${startStr} to ${endStr})`,
    startStr,
    endStr
  };
}

function createEmptyBucket(key, label) {
  return {
    key,
    label,
    ordersCount: 0,
    validOrdersCount: 0,
    unitsSold: 0,
    grossSubtotalPaise: 0,
    discountPaise: 0,
    shippingPaise: 0,
    cgstPaise: 0,
    sgstPaise: 0,
    igstPaise: 0,
    totalGstPaise: 0,
    settledRevenuePaise: 0,
    codPendingPaise: 0,
    refundedPaise: 0,
    netOrderValuePaise: 0,
    aovPaise: 0
  };
}

function accumulateOrderIntoBucket(bucket, order, orderUnitsCount = 0) {
  const isCancelledOrRefunded =
    order.fulfilment_status === 'Cancelled' ||
    order.fulfilment_status === 'Refunded' ||
    order.payment_status === 'REFUNDED' ||
    order.payment_status === 'FAILED';

  const isSettled =
    (order.payment_status === 'PAID' || order.payment_status === 'COD_COLLECTED') &&
    !isCancelledOrRefunded;

  const isCodPending =
    order.payment_status === 'COD_PENDING' &&
    !isCancelledOrRefunded;

  const isRefunded =
    order.payment_status === 'REFUNDED' ||
    order.fulfilment_status === 'Refunded';

  bucket.ordersCount += 1;

  if (isRefunded) {
    bucket.refundedPaise += Number(order.total_paise || 0);
  }

  if (!isCancelledOrRefunded) {
    bucket.validOrdersCount += 1;
    bucket.unitsSold += Number(orderUnitsCount || 0);
    bucket.grossSubtotalPaise += Number(order.subtotal_paise || 0);
    bucket.discountPaise += Number(order.discount_paise || 0);
    bucket.shippingPaise += Number(order.shipping_paise || 0);
    bucket.cgstPaise += Number(order.cgst_paise || 0);
    bucket.sgstPaise += Number(order.sgst_paise || 0);
    bucket.igstPaise += Number(order.igst_paise || 0);
    bucket.totalGstPaise += Number(order.gst_paise || 0);
    bucket.netOrderValuePaise += Number(order.total_paise || 0);
  }

  if (isSettled) {
    bucket.settledRevenuePaise += Number(order.total_paise || 0);
  }
  if (isCodPending) {
    bucket.codPendingPaise += Number(order.total_paise || 0);
  }

  bucket.aovPaise = bucket.validOrdersCount > 0
    ? Math.round(bucket.netOrderValuePaise / bucket.validOrdersCount)
    : 0;
}

function diffDays(dateStrA, dateStrB) {
  const [y1, m1, d1] = dateStrA.split('-').map(Number);
  const [y2, m2, d2] = dateStrB.split('-').map(Number);
  const t1 = Date.UTC(y1, (m1 || 1) - 1, d1 || 1);
  const t2 = Date.UTC(y2, (m2 || 1) - 1, d2 || 1);
  return Math.round((t1 - t2) / 86400000);
}

function buildComprehensiveReports({
  orders = [],
  orderItems = [],
  payments = [],
  products = [],
  categories = [],
  referenceDateStr = null
}) {
  // Determine reference "today" date (either explicit or max order date so seeded + live orders bucket deterministically)
  const allDates = orders.map(o => parseOrderDateStr(o.created_at)).sort();
  const refDate = referenceDateStr || (allDates.length > 0 ? allDates[allDates.length - 1] : new Date().toISOString().slice(0, 10));
  const refMonth = refDate.slice(0, 7);
  const refWeek = getIsoWeekInfo(refDate);

  // Map order_id -> total units & items list
  const unitsByOrderId = new Map();
  const orderById = new Map();
  for (const o of orders) {
    orderById.set(Number(o.id), o);
    unitsByOrderId.set(Number(o.id), 0);
  }
  for (const it of orderItems) {
    const oid = Number(it.order_id);
    unitsByOrderId.set(oid, (unitsByOrderId.get(oid) || 0) + Number(it.quantity || 0));
  }

  // 1. Period Window Rollups: Today vs. Last 7 Days (Weekly) vs. Current Month (Monthly) vs. All-Time
  const todayBucket = createEmptyBucket('DAILY_TODAY', `Daily (${refDate})`);
  const weeklyBucket = createEmptyBucket('WEEKLY_7D', `Weekly (Last 7 Days ending ${refDate})`);
  const monthlyBucket = createEmptyBucket('MONTHLY_MTD', `Monthly (${refMonth} MTD)`);
  const allTimeBucket = createEmptyBucket('ALL_TIME', 'All-Time Cumulative');

  // 2. Time-series maps: byDay (YYYY-MM-DD), byWeek (YYYY-Www), byMonth (YYYY-MM)
  const dayMap = new Map();
  const weekMap = new Map();
  const monthMap = new Map();

  for (const ord of orders) {
    const dStr = parseOrderDateStr(ord.created_at);
    const mStr = dStr.slice(0, 7);
    const wInfo = getIsoWeekInfo(dStr);
    const units = unitsByOrderId.get(Number(ord.id)) || 0;
    const ageDays = diffDays(refDate, dStr);

    // Period Windows
    if (dStr === refDate) {
      accumulateOrderIntoBucket(todayBucket, ord, units);
    }
    if (ageDays >= 0 && ageDays <= 6) {
      accumulateOrderIntoBucket(weeklyBucket, ord, units);
    }
    if (mStr === refMonth) {
      accumulateOrderIntoBucket(monthlyBucket, ord, units);
    }
    accumulateOrderIntoBucket(allTimeBucket, ord, units);

    // Granular Daily Time-Series
    if (!dayMap.has(dStr)) {
      dayMap.set(dStr, createEmptyBucket(dStr, dStr));
    }
    accumulateOrderIntoBucket(dayMap.get(dStr), ord, units);

    // Granular Weekly Time-Series
    if (!weekMap.has(wInfo.weekCode)) {
      weekMap.set(wInfo.weekCode, createEmptyBucket(wInfo.weekCode, wInfo.label));
    }
    accumulateOrderIntoBucket(weekMap.get(wInfo.weekCode), ord, units);

    // Granular Monthly Time-Series
    if (!monthMap.has(mStr)) {
      monthMap.set(mStr, createEmptyBucket(mStr, mStr));
    }
    accumulateOrderIntoBucket(monthMap.get(mStr), ord, units);
  }

  const dailySales = Array.from(dayMap.values()).sort((a, b) => b.key.localeCompare(a.key));
  const weeklySales = Array.from(weekMap.values()).sort((a, b) => b.key.localeCompare(a.key));
  const monthlySales = Array.from(monthMap.values()).sort((a, b) => b.key.localeCompare(a.key));

  // 3. Complete Product-Wise Sales Report (All 22 Products, Net of Cancelled/Refunded Orders)
  const catNameById = new Map(categories.map(c => [Number(c.id), c.name]));
  const productMap = new Map();

  for (const p of products) {
    productMap.set(Number(p.id), {
      productId: p.id,
      skuBase: p.sku_base,
      hsnCode: p.hsn_code || '080290',
      name: p.name,
      categoryName: catNameById.get(Number(p.category_id)) || 'Pantry',
      isActive: Boolean(p.is_active),
      netOrdersCount: 0,
      netPacksSold: 0,
      netWeightGrams: 0,
      netRevenuePaise: 0,
      netGstPaise: 0,
      refundedPacks: 0,
      refundedRevenuePaise: 0,
      packCounts: { '100 g': 0, '250 g': 0, '500 g': 0, '1 kg': 0 },
      revenueSharePercent: 0
    });
  }

  let totalNetProductRevenuePaise = 0;

  for (const it of orderItems) {
    const parentOrder = orderById.get(Number(it.order_id));
    const isCancelledOrRefunded = parentOrder
      ? (parentOrder.fulfilment_status === 'Cancelled' ||
         parentOrder.fulfilment_status === 'Refunded' ||
         parentOrder.payment_status === 'REFUNDED' ||
         parentOrder.payment_status === 'FAILED')
      : false;

    let rec = productMap.get(Number(it.product_id));
    if (!rec) {
      rec = {
        productId: it.product_id,
        skuBase: it.sku,
        hsnCode: it.hsn_code || '080290',
        name: it.product_name,
        categoryName: 'Pantry',
        isActive: true,
        netOrdersCount: 0,
        netPacksSold: 0,
        netWeightGrams: 0,
        netRevenuePaise: 0,
        netGstPaise: 0,
        refundedPacks: 0,
        refundedRevenuePaise: 0,
        packCounts: { '100 g': 0, '250 g': 0, '500 g': 0, '1 kg': 0 },
        revenueSharePercent: 0
      };
      productMap.set(Number(it.product_id), rec);
    }

    const qty = Number(it.quantity || 0);
    const linePaise = Number(it.line_total_paise || 0);
    const grams = Number(it.weight_grams || 0) * qty;
    const gstPct = Number(it.gst_percent || 5);
    const lineGst = Math.round(linePaise - (linePaise * 100) / (100 + gstPct));

    if (isCancelledOrRefunded) {
      rec.refundedPacks += qty;
      rec.refundedRevenuePaise += linePaise;
    } else {
      rec.netOrdersCount += 1;
      rec.netPacksSold += qty;
      rec.netWeightGrams += grams;
      rec.netRevenuePaise += linePaise;
      rec.netGstPaise += lineGst;
      if (rec.packCounts[it.pack_label] !== undefined) {
        rec.packCounts[it.pack_label] += qty;
      }
      totalNetProductRevenuePaise += linePaise;
    }
  }

  const productSales = Array.from(productMap.values())
    .map(r => {
      const share = totalNetProductRevenuePaise > 0
        ? Number(((r.netRevenuePaise / totalNetProductRevenuePaise) * 100).toFixed(1))
        : 0;
      const packSummary = Object.entries(r.packCounts)
        .filter(([, cnt]) => cnt > 0)
        .map(([lbl, cnt]) => `${lbl} × ${cnt}`)
        .join(', ') || '0 packs';
      return {
        ...r,
        revenueSharePercent: share,
        packBreakdownText: packSummary
      };
    })
    .sort((a, b) => b.netRevenuePaise - a.netRevenuePaise || a.productId - b.productId);

  // 4. Order Summary Report (by Fulfilment Status + Tax Regime CGST/SGST vs IGST)
  const statusMap = new Map();
  for (const st of ORDER_FULFILMENT_STATUSES) {
    statusMap.set(st, {
      fulfilmentStatus: st,
      ordersCount: 0,
      sharePercent: 0,
      subtotalPaise: 0,
      discountPaise: 0,
      shippingPaise: 0,
      gstPaise: 0,
      totalPaise: 0
    });
  }

  const taxRegimeSummary = {
    CGST_SGST: { regime: 'Intra-State (Karnataka CGST + SGST)', ordersCount: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalGstPaise: 0, totalOrderPaise: 0 },
    IGST: { regime: 'Inter-State (All-India IGST)', ordersCount: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalGstPaise: 0, totalOrderPaise: 0 }
  };

  for (const ord of orders) {
    const st = ord.fulfilment_status || 'Pending Payment';
    if (!statusMap.has(st)) {
      statusMap.set(st, {
        fulfilmentStatus: st,
        ordersCount: 0,
        sharePercent: 0,
        subtotalPaise: 0,
        discountPaise: 0,
        shippingPaise: 0,
        gstPaise: 0,
        totalPaise: 0
      });
    }
    const row = statusMap.get(st);
    row.ordersCount += 1;
    row.subtotalPaise += Number(ord.subtotal_paise || 0);
    row.discountPaise += Number(ord.discount_paise || 0);
    row.shippingPaise += Number(ord.shipping_paise || 0);
    row.gstPaise += Number(ord.gst_paise || 0);
    row.totalPaise += Number(ord.total_paise || 0);

    const isCancelledOrRefunded =
      ord.fulfilment_status === 'Cancelled' ||
      ord.fulfilment_status === 'Refunded' ||
      ord.payment_status === 'REFUNDED';
    if (!isCancelledOrRefunded) {
      const regKey = (ord.tax_supply_type || 'CGST_SGST') === 'IGST' ? 'IGST' : 'CGST_SGST';
      const tRow = taxRegimeSummary[regKey];
      tRow.ordersCount += 1;
      tRow.cgstPaise += Number(ord.cgst_paise || 0);
      tRow.sgstPaise += Number(ord.sgst_paise || 0);
      tRow.igstPaise += Number(ord.igst_paise || 0);
      tRow.totalGstPaise += Number(ord.gst_paise || 0);
      tRow.totalOrderPaise += Number(ord.total_paise || 0);
    }
  }

  const orderStatusSummary = Array.from(statusMap.values()).map(r => ({
    ...r,
    sharePercent: orders.length > 0 ? Number(((r.ordersCount / orders.length) * 100).toFixed(1)) : 0
  }));

  // 5. Payment Summary Report (by Payment Method & by Payment Settlement Status)
  const methodLabels = {
    ONLINE_UPI: 'Razorpay UPI (GPay / PhonePe / BHIM)',
    ONLINE_CARD: 'Razorpay Credit / Debit Cards',
    ONLINE_NETBANKING: 'Razorpay Net Banking',
    COD: 'Cash on Delivery (Doorstep Collection)'
  };
  const methodMap = new Map();
  for (const [mKey, mLabel] of Object.entries(methodLabels)) {
    methodMap.set(mKey, {
      method: mKey,
      label: mLabel,
      transactionsCount: 0,
      grossPaise: 0,
      settledPaise: 0,
      pendingPaise: 0,
      refundedPaise: 0,
      sharePercent: 0
    });
  }

  const paymentStatusMap = new Map();
  for (const pst of ORDER_PAYMENT_STATUSES) {
    paymentStatusMap.set(pst, {
      status: pst,
      transactionsCount: 0,
      totalPaise: 0
    });
  }

  let totalPaymentGrossPaise = 0;
  for (const pay of payments) {
    const mKey = pay.method || 'ONLINE_UPI';
    if (!methodMap.has(mKey)) {
      methodMap.set(mKey, {
        method: mKey,
        label: mKey,
        transactionsCount: 0,
        grossPaise: 0,
        settledPaise: 0,
        pendingPaise: 0,
        refundedPaise: 0,
        sharePercent: 0
      });
    }
    const mRow = methodMap.get(mKey);
    const amt = Number(pay.amount_paise || 0);
    mRow.transactionsCount += 1;
    mRow.grossPaise += amt;
    totalPaymentGrossPaise += amt;

    if (pay.status === 'PAID' || pay.status === 'COD_COLLECTED') {
      mRow.settledPaise += amt;
    } else if (pay.status === 'REFUNDED' || pay.status === 'REFUND_INITIATED') {
      mRow.refundedPaise += Number(pay.refund_amount_paise || amt);
    } else {
      mRow.pendingPaise += amt;
    }

    const stKey = pay.status || 'PENDING_PAYMENT';
    if (!paymentStatusMap.has(stKey)) {
      paymentStatusMap.set(stKey, { status: stKey, transactionsCount: 0, totalPaise: 0 });
    }
    const sRow = paymentStatusMap.get(stKey);
    sRow.transactionsCount += 1;
    sRow.totalPaise += amt;
  }

  const paymentMethodSummary = Array.from(methodMap.values()).map(r => ({
    ...r,
    sharePercent: totalPaymentGrossPaise > 0
      ? Number(((r.grossPaise / totalPaymentGrossPaise) * 100).toFixed(1))
      : 0
  }));

  const paymentStatusSummary = Array.from(paymentStatusMap.values());

  return {
    referenceDate: refDate,
    referenceWeek: refWeek.weekCode,
    referenceMonth: refMonth,
    periodWindows: [todayBucket, weeklyBucket, monthlyBucket, allTimeBucket],
    dailySales,
    weeklySales,
    monthlySales,
    productSales,
    totalNetProductRevenuePaise,
    orderStatusSummary,
    orderTaxSummary: [taxRegimeSummary.CGST_SGST, taxRegimeSummary.IGST],
    paymentMethodSummary,
    paymentStatusSummary
  };
}

function toInrDecimal(paise) {
  return (Number(paise || 0) / 100).toFixed(2);
}

function escapeCsvCell(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function exportReportToCsv(reports, reportType = 'daily') {
  const type = String(reportType || 'daily').toLowerCase();
  const rows = [];

  if (type === 'daily' || type === 'weekly' || type === 'monthly') {
    const source = type === 'daily'
      ? reports.dailySales
      : (type === 'weekly' ? reports.weeklySales : reports.monthlySales);
    rows.push([
      'Period',
      'Total Orders',
      'Valid Orders',
      'Packs Sold',
      'Gross Subtotal (INR)',
      'Coupon Discounts (INR)',
      'Shipping Collected (INR)',
      'CGST (INR)',
      'SGST (INR)',
      'IGST (INR)',
      'Total GST (INR)',
      'Settled Revenue (INR)',
      'COD Pending (INR)',
      'Refunded (INR)',
      'Net Order Value (INR)',
      'Average Order Value (INR)'
    ]);
    for (const r of source) {
      rows.push([
        r.label,
        r.ordersCount,
        r.validOrdersCount,
        r.unitsSold,
        toInrDecimal(r.grossSubtotalPaise),
        toInrDecimal(r.discountPaise),
        toInrDecimal(r.shippingPaise),
        toInrDecimal(r.cgstPaise),
        toInrDecimal(r.sgstPaise),
        toInrDecimal(r.igstPaise),
        toInrDecimal(r.totalGstPaise),
        toInrDecimal(r.settledRevenuePaise),
        toInrDecimal(r.codPendingPaise),
        toInrDecimal(r.refundedPaise),
        toInrDecimal(r.netOrderValuePaise),
        toInrDecimal(r.aovPaise)
      ]);
    }
  } else if (type === 'products') {
    rows.push([
      'Product ID',
      'SKU Prefix',
      'HSN Code',
      'Category',
      'Product Name',
      'Status',
      'Net Packs Sold',
      'Pack Size Breakdown',
      'Net Weight Sold (g)',
      'Net Revenue (INR)',
      'Included GST (INR)',
      'Refunded/Cancelled Packs',
      'Revenue Share (%)'
    ]);
    for (const p of reports.productSales) {
      rows.push([
        p.productId,
        p.skuBase,
        p.hsnCode,
        p.categoryName,
        p.name,
        p.isActive ? 'Active' : 'Inactive',
        p.netPacksSold,
        p.packBreakdownText,
        p.netWeightGrams,
        toInrDecimal(p.netRevenuePaise),
        toInrDecimal(p.netGstPaise),
        p.refundedPacks,
        p.revenueSharePercent
      ]);
    }
  } else if (type === 'orders') {
    rows.push([
      'Fulfilment Status',
      'Orders Count',
      'Order Share (%)',
      'Gross Subtotal (INR)',
      'Discounts (INR)',
      'Shipping Charges (INR)',
      'Included GST (INR)',
      'Total Order Value (INR)'
    ]);
    for (const o of reports.orderStatusSummary) {
      rows.push([
        o.fulfilmentStatus,
        o.ordersCount,
        o.sharePercent,
        toInrDecimal(o.subtotalPaise),
        toInrDecimal(o.discountPaise),
        toInrDecimal(o.shippingPaise),
        toInrDecimal(o.gstPaise),
        toInrDecimal(o.totalPaise)
      ]);
    }
  } else if (type === 'payments') {
    rows.push([
      'Payment Method',
      'Description',
      'Transactions Count',
      'Gross Volume (INR)',
      'Settled / Verified (INR)',
      'Pending Collection (INR)',
      'Refunded (INR)',
      'Volume Share (%)'
    ]);
    for (const pm of reports.paymentMethodSummary) {
      rows.push([
        pm.method,
        pm.label,
        pm.transactionsCount,
        toInrDecimal(pm.grossPaise),
        toInrDecimal(pm.settledPaise),
        toInrDecimal(pm.pendingPaise),
        toInrDecimal(pm.refundedPaise),
        pm.sharePercent
      ]);
    }
  }

  return rows.map(r => r.map(escapeCsvCell).join(',')).join('\n') + '\n';
}

module.exports = {
  parseOrderDateStr,
  getIsoWeekInfo,
  buildComprehensiveReports,
  exportReportToCsv
};
