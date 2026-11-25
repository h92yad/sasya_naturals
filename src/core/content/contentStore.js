'use strict';

const { getDb } = require('../../db/database');
const { BRAND_NAME, BRAND_TAGLINE } = require('../../config/appConfig');
const { lintContentText } = require('./contentLinter');

const DEFAULT_HOMEPAGE_CONTENT = {
  topbarBadge1: 'Unpolished Native Grains',
  topbarBadge2: 'Single-Origin Spices',
  topbarBadge3: 'Razorpay UPI / Cards & COD',
  heroEyebrow: 'Direct-To-Customer Indian Pantry • Batch Traceable',
  heroHeading: 'Single-Origin Dry Fruits, Unpolished Native Millets & Heirloom Spices',
  heroLead:
    'Every Sashya Naturals harvest is sourced directly from regional grower cooperatives in Kashmir, Goa, Karnataka, Kerala, and Meghalaya. Packed fresh in 100 g, 250 g, 500 g, and 1 kg pouches with transparent batch labels.',
  heroPrimaryCtaLabel: 'Explore Full Pantry',
  heroSecondaryCtaLabel: 'Track Your Order',
  heroBatchCaptionLeft: 'Harvest Batch: Nov 2026',
  heroBatchCaptionRight: 'India-Wide Dispatch from Bengaluru',
  trust1Title: '4 Pack Sizes',
  trust1Sub: '100 g, 250 g, 500 g & 1 kg options',
  trust2Title: 'Zero Chemical Polish',
  trust2Sub: 'Intact bran millets & unbleached nuts',
  trust3Title: 'Verified Payments',
  trust3Sub: 'Razorpay UPI, Cards, NetBanking & COD',
  footerBlurb:
    'Direct-to-customer Indian pantry delivering unbleached dry fruits, rain-fed unpolished millets, and cold-milled heirloom spices in 100 g, 250 g, 500 g, and 1 kg packs.',
  footerSupportLine: 'Domain: sashyanaturals.com | Support: care@sashyanaturals.com'
};

const DEFAULT_INFO_PAGES = {
  about: {
    title: 'About Sashya Naturals',
    subtitle: 'Direct-To-Customer Indian Pantry • Pure Dry Fruits, Native Millets & Heirloom Spices',
    paragraphs: [
      'Sashya Naturals connects Indian households directly with regional grower cooperatives harvesting unbleached dry fruits, unpolished rain-fed millets, and high-oil single-origin spices.',
      'Every product is offered in 100 g, 250 g, 500 g, and 1 kg nitrogen-flushed packs with full batch traceability, harvest origin disclosure, and clear allergen labelling.'
    ]
  },
  contact: {
    title: 'Contact Customer Support',
    subtitle: 'Order Assistance, Bulk Enquiries & Dispatch Support',
    paragraphs: [
      'Customer Support Email: care@sashyanaturals.com | Phone: +91 80 4568 2200 (Monday to Saturday, 9:30 AM to 6:30 PM IST).',
      'For order tracking queries, please keep your Order Number (for example SN-2026-1001) ready.'
    ]
  },
  faq: {
    title: 'Frequently Asked Questions',
    subtitle: 'Pack Sizes, Payments, Manual Courier Tracking & Storage',
    paragraphs: [
      'What pack sizes do you offer? All dry fruits, millets, and spices are available in 100 g, 250 g, 500 g, and 1 kg packs.',
      'What payment methods are accepted? We accept UPI, credit cards, debit cards, and net banking via Razorpay (verified server-side), as well as Cash on Delivery (COD) across India.',
      'How do I track my shipment? Once our dispatch staff hands your parcel to Blue Dart, Delhivery, or India Post, the courier name and tracking AWB number appear on the Track Order page.'
    ]
  },
  privacy: {
    title: 'Privacy Policy',
    subtitle: 'Customer Data Protection & Order Privacy',
    paragraphs: [
      'Sashya Naturals collects only the contact, delivery address, and payment reference details required to fulfil your order, issue GST tax invoices, and send shipment updates.',
      'Payment card and UPI credentials are processed directly by our PCI-DSS compliant gateway partner (Razorpay) and are never stored on Sashya Naturals servers.'
    ]
  },
  terms: {
    title: 'Terms of Service',
    subtitle: 'Ordering, Pricing, Tax & Fulfilment Terms',
    paragraphs: [
      'All prices listed on sashyanaturals.com are in Indian Rupees (INR) and indicate applicable GST percentages. Orders are confirmed only after server-side payment verification or COD confirmation.',
      'Pack weights (100 g, 250 g, 500 g, 1 kg) represent net product weight at the time of packing.'
    ]
  },
  'shipping-returns': {
    title: 'Shipping, Cancellation, Return & Refund Policy',
    subtitle: '4-Zone + 500g Weight-Slab Courier Dispatch, Damaged Parcel Replacement & Refund Timelines',
    paragraphs: [
      'Delivery charges are calculated transparently using our 4-Zone (Local Bengaluru, South India, National, and Remote/NE) + 500g billable weight-slab engine (including 150g protective carton tare weight). Orders meeting the active free-delivery threshold and weight cap qualify for complimentary shipping.',
      'Orders may be cancelled prior to dispatch. If a parcel arrives damaged or tampered, contact care@sashyanaturals.com within 48 hours of delivery for a verified replacement or refund to your original payment source.'
    ]
  },
  account: {
    title: 'Customer Account & Saved Addresses',
    subtitle: 'Manage Your Profile, Saved Delivery Addresses & Order History',
    paragraphs: [
      'Signed-in customers can view past orders, download tax invoices, and manage default delivery addresses across India. Guest checkout is also always available without mandatory registration.'
    ]
  }
};

const DEFAULT_SEO_ROUTES = {
  '/': {
    label: 'Homepage (/)',
    metaTitle: `${BRAND_NAME} | ${BRAND_TAGLINE}`,
    metaDescription:
      'Shop farm-direct Kashmiri almonds, Goan W240 cashews, unpolished native millets, and cold-milled Lakadong turmeric across India in 100 g to 1 kg packs.',
    ogImagePath: '/images/hero-pantry.jpg'
  },
  '/shop': {
    label: 'All Catalogue (/shop)',
    metaTitle: `All Natural Products Catalogue | ${BRAND_NAME}`,
    metaDescription:
      'Browse all Sashya Naturals dry fruits, unpolished millets, and single-origin spices with 100 g, 250 g, 500 g, and 1 kg pack variants.',
    ogImagePath: '/images/hero-pantry.jpg'
  },
  '/checkout': {
    label: 'Checkout (/checkout)',
    metaTitle: `Secure Checkout — UPI, Cards, NetBanking & COD | ${BRAND_NAME}`,
    metaDescription:
      'Complete your Sashya Naturals order with instant UPI, credit/debit card, net banking, or Cash on Delivery across India.',
    ogImagePath: '/images/hero-pantry.jpg'
  },
  '/track-order': {
    label: 'Track Order (/track-order)',
    metaTitle: `Track Order & Manual Courier Status | ${BRAND_NAME}`,
    metaDescription:
      'Track your Sashya Naturals order status, separate payment and fulfilment states, and manual courier AWB tracking reference.',
    ogImagePath: '/images/hero-pantry.jpg'
  },
  '/about': {
    label: 'About Us (/about)',
    metaTitle: `About Sashya Naturals | ${BRAND_NAME}`,
    metaDescription: DEFAULT_INFO_PAGES.about.subtitle,
    ogImagePath: '/images/hero-pantry.jpg'
  },
  '/contact': {
    label: 'Contact Us (/contact)',
    metaTitle: `Contact Customer Support | ${BRAND_NAME}`,
    metaDescription: DEFAULT_INFO_PAGES.contact.subtitle,
    ogImagePath: '/images/hero-pantry.jpg'
  },
  '/faq': {
    label: 'FAQ (/faq)',
    metaTitle: `Frequently Asked Questions | ${BRAND_NAME}`,
    metaDescription: DEFAULT_INFO_PAGES.faq.subtitle,
    ogImagePath: '/images/hero-pantry.jpg'
  },
  '/shipping-returns': {
    label: 'Shipping & Returns (/shipping-returns)',
    metaTitle: `Shipping, Cancellation, Return & Refund Policy | ${BRAND_NAME}`,
    metaDescription: DEFAULT_INFO_PAGES['shipping-returns'].subtitle,
    ogImagePath: '/images/hero-pantry.jpg'
  },
  '/privacy': {
    label: 'Privacy Policy (/privacy)',
    metaTitle: `Privacy Policy | ${BRAND_NAME}`,
    metaDescription: DEFAULT_INFO_PAGES.privacy.subtitle,
    ogImagePath: '/images/hero-pantry.jpg'
  },
  '/terms': {
    label: 'Terms of Service (/terms)',
    metaTitle: `Terms of Service | ${BRAND_NAME}`,
    metaDescription: DEFAULT_INFO_PAGES.terms.subtitle,
    ogImagePath: '/images/hero-pantry.jpg'
  }
};

function safeParseJson(str, fallback = {}) {
  if (!str) return fallback;
  try {
    const parsed = JSON.parse(str);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function getStorefrontContentAndSeo() {
  const db = getDb();
  const rows = db
    .prepare("SELECT key, value FROM store_settings WHERE key IN ('content_homepage_json', 'content_pages_json', 'content_seo_json')")
    .all();
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));

  const savedHomepage = safeParseJson(map.content_homepage_json, {});
  const homepage = {
    ...DEFAULT_HOMEPAGE_CONTENT,
    ...savedHomepage
  };

  const savedPages = safeParseJson(map.content_pages_json, {});
  const infoPages = {};
  for (const [slug, defPage] of Object.entries(DEFAULT_INFO_PAGES)) {
    const custom = savedPages[slug];
    if (custom && typeof custom === 'object') {
      infoPages[slug] = {
        title: String(custom.title || defPage.title).trim(),
        subtitle: String(custom.subtitle || defPage.subtitle).trim(),
        paragraphs:
          Array.isArray(custom.paragraphs) && custom.paragraphs.length > 0
            ? custom.paragraphs.map(p => String(p).trim()).filter(Boolean)
            : defPage.paragraphs
      };
    } else {
      infoPages[slug] = {
        title: defPage.title,
        subtitle: defPage.subtitle,
        paragraphs: [...defPage.paragraphs]
      };
    }
  }

  const savedSeo = safeParseJson(map.content_seo_json, {});
  const seoRoutes = {};
  for (const [routePath, defSeo] of Object.entries(DEFAULT_SEO_ROUTES)) {
    const custom = savedSeo[routePath];
    const slugKey = routePath.replace(/^\/+/, '');
    const linkedInfoPage = slugKey && infoPages[slugKey] ? infoPages[slugKey] : null;
    const baseMetaTitle = linkedInfoPage ? `${linkedInfoPage.title} | ${BRAND_NAME}` : defSeo.metaTitle;
    const baseMetaDesc = linkedInfoPage ? linkedInfoPage.subtitle : defSeo.metaDescription;

    if (custom && typeof custom === 'object') {
      seoRoutes[routePath] = {
        label: defSeo.label,
        metaTitle: String(custom.metaTitle || baseMetaTitle).trim(),
        metaDescription: String(custom.metaDescription || baseMetaDesc).trim(),
        ogImagePath: String(custom.ogImagePath || defSeo.ogImagePath).trim()
      };
    } else {
      seoRoutes[routePath] = {
        ...defSeo,
        metaTitle: baseMetaTitle,
        metaDescription: baseMetaDesc
      };
    }
  }

  return {
    homepage,
    infoPages,
    seoRoutes
  };
}

function updateHomepageContent(payload = {}, actor = {}) {
  const current = getStorefrontContentAndSeo().homepage;
  const next = { ...current };

  for (const key of Object.keys(DEFAULT_HOMEPAGE_CONTENT)) {
    if (payload[key] !== undefined && String(payload[key]).trim() !== '') {
      next[key] = String(payload[key]).trim();
    }
  }

  const combinedText = Object.values(next).join(' ');
  const lintCheck = lintContentText(combinedText, 'homepage_content');
  if (!lintCheck.valid) {
    throw new Error(lintCheck.issues.join(' '));
  }

  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO store_settings (key, value, updated_at) VALUES ('content_homepage_json', ?, datetime('now'))"
  ).run(JSON.stringify(next));

  db.prepare(`
    INSERT INTO audit_logs (actor_id, actor_email, actor_role, action, entity_type, entity_id, details_json)
    VALUES (?, ?, ?, 'HOMEPAGE_CONTENT_UPDATED', 'CONTENT', 'HOMEPAGE_HERO_FOOTER', ?)
  `).run(
    actor.actorId || null,
    actor.actorEmail || 'superadmin@sashyanaturals.com',
    actor.actorRole || 'SUPER_ADMIN',
    JSON.stringify({ heroHeading: next.heroHeading, heroEyebrow: next.heroEyebrow })
  );

  return next;
}

function updateInfoPageContent({ slug, title, subtitle, paragraphsText }, actor = {}) {
  const cleanSlug = String(slug || '').trim();
  if (!DEFAULT_INFO_PAGES[cleanSlug]) {
    throw new Error(`Unsupported info page slug: ${cleanSlug}`);
  }

  const cleanTitle = String(title || '').trim();
  const cleanSubtitle = String(subtitle || '').trim();
  const paragraphs = Array.isArray(paragraphsText)
    ? paragraphsText.map(p => String(p).trim()).filter(Boolean)
    : String(paragraphsText || '')
        .split(/\n+/)
        .map(p => p.trim())
        .filter(Boolean);

  if (!cleanTitle || !cleanSubtitle || paragraphs.length === 0) {
    throw new Error('Page title, subtitle, and at least one body paragraph are required.');
  }

  const combinedText = `${cleanTitle} ${cleanSubtitle} ${paragraphs.join(' ')}`;
  const lintCheck = lintContentText(combinedText, `info_page_${cleanSlug}`);
  if (!lintCheck.valid) {
    throw new Error(lintCheck.issues.join(' '));
  }

  const db = getDb();
  const existingRow = db.prepare("SELECT value FROM store_settings WHERE key = 'content_pages_json'").get();
  const savedPages = safeParseJson(existingRow ? existingRow.value : '', {});
  savedPages[cleanSlug] = {
    title: cleanTitle,
    subtitle: cleanSubtitle,
    paragraphs
  };

  db.prepare(
    "INSERT OR REPLACE INTO store_settings (key, value, updated_at) VALUES ('content_pages_json', ?, datetime('now'))"
  ).run(JSON.stringify(savedPages));

  db.prepare(`
    INSERT INTO audit_logs (actor_id, actor_email, actor_role, action, entity_type, entity_id, details_json)
    VALUES (?, ?, ?, 'INFO_PAGE_CONTENT_UPDATED', 'CONTENT_PAGE', ?, ?)
  `).run(
    actor.actorId || null,
    actor.actorEmail || 'superadmin@sashyanaturals.com',
    actor.actorRole || 'SUPER_ADMIN',
    cleanSlug,
    JSON.stringify({ slug: cleanSlug, title: cleanTitle, paragraphCount: paragraphs.length })
  );

  return savedPages[cleanSlug];
}

function updateRouteSeoMeta({ routePath, metaTitle, metaDescription, ogImagePath }, actor = {}) {
  const cleanRoute = String(routePath || '').trim();
  if (!DEFAULT_SEO_ROUTES[cleanRoute]) {
    throw new Error(`Unsupported SEO route path: ${cleanRoute}`);
  }

  const cleanTitle = String(metaTitle || '').trim();
  const cleanDesc = String(metaDescription || '').trim();
  const rawOg = String(ogImagePath || '/images/hero-pantry.jpg').trim() || '/images/hero-pantry.jpg';
  if (/^https?:\/\//i.test(rawOg)) {
    throw new Error('OpenGraph image path must be a local storefront path starting with "/" (e.g. /images/hero-pantry.jpg).');
  }
  const cleanOgImage = rawOg.startsWith('/') ? rawOg : `/${rawOg}`;

  if (!cleanTitle || !cleanDesc) {
    throw new Error('SEO Meta Title and Meta Description are required.');
  }

  const lintCheck = lintContentText(`${cleanTitle} ${cleanDesc}`, `seo_route_${cleanRoute}`);
  if (!lintCheck.valid) {
    throw new Error(lintCheck.issues.join(' '));
  }

  const db = getDb();
  const existingRow = db.prepare("SELECT value FROM store_settings WHERE key = 'content_seo_json'").get();
  const savedSeo = safeParseJson(existingRow ? existingRow.value : '', {});
  savedSeo[cleanRoute] = {
    label: DEFAULT_SEO_ROUTES[cleanRoute].label,
    metaTitle: cleanTitle,
    metaDescription: cleanDesc,
    ogImagePath: cleanOgImage
  };

  db.prepare(
    "INSERT OR REPLACE INTO store_settings (key, value, updated_at) VALUES ('content_seo_json', ?, datetime('now'))"
  ).run(JSON.stringify(savedSeo));

  db.prepare(`
    INSERT INTO audit_logs (actor_id, actor_email, actor_role, action, entity_type, entity_id, details_json)
    VALUES (?, ?, ?, 'ROUTE_SEO_META_UPDATED', 'SEO_META', ?, ?)
  `).run(
    actor.actorId || null,
    actor.actorEmail || 'superadmin@sashyanaturals.com',
    actor.actorRole || 'SUPER_ADMIN',
    cleanRoute,
    JSON.stringify(savedSeo[cleanRoute])
  );

  return savedSeo[cleanRoute];
}

function escapeCsvCell(val) {
  let str = String(val ?? '').replace(/\r?\n/g, ' ');
  if (/^[=+\-@]/.test(str) && !/^-[0-9]+(\.[0-9]+)?$/.test(str)) {
    str = `'${str}`;
  }
  if (str.includes(',') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildUsersAndPurchasesExportCsv({
  customerUsers = [],
  customerAddresses = [],
  orders = [],
  orderItems = [],
  exportType = 'users_summary'
}) {
  if (exportType === 'user_purchases') {
    const header = [
      'User ID',
      'Account Type',
      'Customer Name',
      'Customer Email',
      'Customer Phone',
      'Order Number',
      'Order Date',
      'Payment Method',
      'Payment Status',
      'Fulfilment Status',
      'SKU',
      'HSN Code',
      'Product Name',
      'Pack Size',
      'Quantity',
      'Unit Price (INR)',
      'Line Total (INR)',
      'Order Total (INR)',
      'Shipping City',
      'Shipping State',
      'Shipping PIN',
      'GST Invoice URL'
    ];
    const rows = [header.join(',')];
    const userByEmail = new Map(customerUsers.map(u => [String(u.email || '').toLowerCase(), u]));

    for (const ord of orders) {
      const matchedUser =
        customerUsers.find(u => Number(u.id) === Number(ord.user_id)) ||
        userByEmail.get(String(ord.customer_email || '').toLowerCase());
      const userIdLabel = matchedUser ? `USR-${matchedUser.id}` : 'GUEST';
      const accountType = matchedUser ? 'Signed-Up User' : 'Guest Checkout';
      const items = orderItems.filter(it => Number(it.order_id) === Number(ord.id));

      if (items.length === 0) {
        rows.push(
          [
            userIdLabel,
            accountType,
            ord.customer_name,
            ord.customer_email,
            ord.customer_phone,
            ord.order_number,
            (ord.created_at || '').slice(0, 10),
            ord.payment_method,
            ord.payment_status,
            ord.fulfilment_status,
            'N/A',
            '080290',
            'Pantry Order',
            'Standard Pack',
            1,
            (Number(ord.total_paise || 0) / 100).toFixed(2),
            (Number(ord.total_paise || 0) / 100).toFixed(2),
            (Number(ord.total_paise || 0) / 100).toFixed(2),
            ord.shipping_city,
            ord.shipping_state,
            ord.shipping_pincode,
            `/orders/${ord.order_number}/invoice`
          ]
            .map(escapeCsvCell)
            .join(',')
        );
      } else {
        for (const it of items) {
          rows.push(
            [
              userIdLabel,
              accountType,
              ord.customer_name,
              ord.customer_email,
              ord.customer_phone,
              ord.order_number,
              (ord.created_at || '').slice(0, 10),
              ord.payment_method,
              ord.payment_status,
              ord.fulfilment_status,
              it.sku,
              it.hsn_code || '080290',
              it.product_name,
              it.pack_label,
              it.quantity,
              (Number(it.unit_price_paise || 0) / 100).toFixed(2),
              (Number(it.line_total_paise || 0) / 100).toFixed(2),
              (Number(ord.total_paise || 0) / 100).toFixed(2),
              ord.shipping_city,
              ord.shipping_state,
              ord.shipping_pincode,
              `/orders/${ord.order_number}/invoice`
            ]
              .map(escapeCsvCell)
              .join(',')
          );
        }
      }
    }
    return rows.join('\n') + '\n';
  }

  // Default: users_summary
  const header = [
    'User ID',
    'Account Type',
    'Full Name',
    'Email',
    'Mobile Phone',
    'Joined Date',
    'Saved Addresses',
    'Default City',
    'Default State',
    'Default PIN',
    'Total Orders',
    'Total Packs Purchased',
    'Settled Spend (INR)',
    'COD Pending (INR)',
    'Lifetime Order Value (INR)',
    'Last Order Date',
    'Order Numbers'
  ];
  const rows = [header.join(',')];
  const profilesMap = new Map();

  for (const cu of customerUsers) {
    const addrs = customerAddresses.filter(a => Number(a.user_id) === Number(cu.id));
    const defAddr = addrs.find(a => Number(a.is_default) === 1) || addrs[0] || null;
    profilesMap.set(String(cu.email || '').toLowerCase(), {
      userIdLabel: `USR-${cu.id}`,
      accountType: 'Signed-Up User',
      fullName: cu.full_name,
      email: cu.email,
      phone: cu.phone,
      joinedDate: (cu.created_at || '2026-11-20').slice(0, 10),
      addressCount: addrs.length,
      city: defAddr ? defAddr.city : 'Bengaluru',
      state: defAddr ? defAddr.state : 'Karnataka',
      pincode: defAddr ? defAddr.pincode : '560038',
      totalOrders: 0,
      totalPacks: 0,
      settledPaise: 0,
      codPendingPaise: 0,
      lifetimePaise: 0,
      lastOrderDate: 'None',
      orderNumbers: []
    });
  }

  for (const ord of orders) {
    const em = String(ord.customer_email || '').toLowerCase();
    const existing = profilesMap.get(em) || {
      userIdLabel: ord.user_id ? `USR-${ord.user_id}` : 'GUEST',
      accountType: ord.user_id ? 'Signed-Up User' : 'Guest Checkout',
      fullName: ord.customer_name,
      email: ord.customer_email,
      phone: ord.customer_phone,
      joinedDate: (ord.created_at || '2026-11-20').slice(0, 10),
      addressCount: 1,
      city: ord.shipping_city,
      state: ord.shipping_state,
      pincode: ord.shipping_pincode,
      totalOrders: 0,
      totalPacks: 0,
      settledPaise: 0,
      codPendingPaise: 0,
      lifetimePaise: 0,
      lastOrderDate: 'None',
      orderNumbers: []
    };

    const items = orderItems.filter(it => Number(it.order_id) === Number(ord.id));
    const packs = items.reduce((acc, it) => acc + Number(it.quantity || 0), 0);
    existing.totalOrders += 1;
    existing.totalPacks += packs;
    if (ord.payment_status === 'PAID' || ord.payment_status === 'COD_COLLECTED') {
      existing.settledPaise += Number(ord.total_paise || 0);
    } else if (ord.payment_status === 'COD_PENDING') {
      existing.codPendingPaise += Number(ord.total_paise || 0);
    }
    if (ord.payment_status !== 'REFUNDED' && ord.payment_status !== 'FAILED') {
      existing.lifetimePaise += Number(ord.total_paise || 0);
    }
    const ordDate = (ord.created_at || '').slice(0, 10);
    if (existing.lastOrderDate === 'None' || ordDate > existing.lastOrderDate) {
      existing.lastOrderDate = ordDate;
    }
    existing.orderNumbers.push(ord.order_number);
    profilesMap.set(em, existing);
  }

  for (const p of profilesMap.values()) {
    rows.push(
      [
        p.userIdLabel,
        p.accountType,
        p.fullName,
        p.email,
        p.phone,
        p.joinedDate,
        p.addressCount,
        p.city,
        p.state,
        p.pincode,
        p.totalOrders,
        p.totalPacks,
        (p.settledPaise / 100).toFixed(2),
        (p.codPendingPaise / 100).toFixed(2),
        (p.lifetimePaise / 100).toFixed(2),
        p.lastOrderDate,
        p.orderNumbers.join(' | ')
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  }

  return rows.join('\n') + '\n';
}

module.exports = {
  DEFAULT_HOMEPAGE_CONTENT,
  DEFAULT_INFO_PAGES,
  DEFAULT_SEO_ROUTES,
  getStorefrontContentAndSeo,
  updateHomepageContent,
  updateInfoPageContent,
  updateRouteSeoMeta,
  buildUsersAndPurchasesExportCsv
};
