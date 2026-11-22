'use strict';

const path = require('node:path');

const APP_VERSION = '2.2.0';
const WIKIDATA_MORATORIUM_UNTIL = '2027-11-20';
const SESSION_SECRET = process.env.SESSION_SECRET || 'sasya_naturals_session_hmac_secret_2026_v1';
const SELLER_ORIGIN_STATE = 'Karnataka';
const SELLER_ORIGIN_PIN_PREFIX = '56';

const ENV = process.env.NODE_ENV || 'development';
const IS_PROD = ENV === 'production';

const DEFAULT_PORT = IS_PROD ? 3020 : 5060;
const PORT = Number(process.env.PORT || DEFAULT_PORT);
const STANDBY_PORT = 3021;

const CANONICAL_ORIGIN = (process.env.CANONICAL_ORIGIN || 'https://sasynaturals.com').replace(/\/+$/, '');
const BRAND_NAME = 'Sasya Naturals';
const BRAND_TAGLINE = 'Heirloom Dry Fruits, Unpolished Native Millets & Single-Origin Indian Spices';

const PROTECTED_PATTERNS = [
  'data/sasya_store.db',
  'data/sasya_store.db-wal',
  'data/sasya_store.db-shm',
  'public/uploads/**',
  '.env',
  '.env.production',
  '.bookmarks/**'
];

const BANNED_PORTFOLIO_DOMAINS = [
  ['ewith', 'me'].join('.'),
  ['zeeml', 'com'].join('.')
];

const PAYMENT_CONFIG = {
  provider: 'razorpay',
  keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_SasyaNaturals2026',
  keySecret: process.env.RAZORPAY_KEY_SECRET || 'sasya_rzp_sandbox_secret_key_2026_hmac',
  currency: 'INR',
  freeShippingThresholdPaise: 79900, // Rs. 799.00
  standardShippingPaise: 6000,       // Rs. 60.00
  codFeePaise: 0,                    // Rs. 0.00 configurable
  maxCodOrderPaise: 500000           // Rs. 5,000.00 max COD
};

const ORDER_PAYMENT_STATUSES = [
  'PENDING_PAYMENT',
  'PAID',
  'COD_PENDING',
  'COD_COLLECTED',
  'FAILED',
  'REFUND_INITIATED',
  'REFUNDED'
];

const ORDER_FULFILMENT_STATUSES = [
  'Pending Payment',
  'Confirmed',
  'Processing',
  'Packed',
  'Shipped',
  'Delivered',
  'Cancelled',
  'Refund Initiated',
  'Refunded'
];

const STAFF_ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  PRODUCT_MANAGER: 'PRODUCT_MANAGER',
  ORDER_MANAGER: 'ORDER_MANAGER',
  ACCOUNTS_MANAGER: 'ACCOUNTS_MANAGER',
  STAFF: 'STAFF'
};

module.exports = {
  APP_VERSION,
  WIKIDATA_MORATORIUM_UNTIL,
  SESSION_SECRET,
  SELLER_ORIGIN_STATE,
  SELLER_ORIGIN_PIN_PREFIX,
  ENV,
  IS_PROD,
  PORT,
  STANDBY_PORT,
  CANONICAL_ORIGIN,
  BRAND_NAME,
  BRAND_TAGLINE,
  PROTECTED_PATTERNS,
  BANNED_PORTFOLIO_DOMAINS,
  PAYMENT_CONFIG,
  ORDER_PAYMENT_STATUSES,
  ORDER_FULFILMENT_STATUSES,
  STAFF_ROLES,
  ROOT_DIR: path.resolve(__dirname, '../..'),
  DB_PATH: path.resolve(__dirname, '../..', process.env.DB_PATH || './data/sasya_store.db')
};
