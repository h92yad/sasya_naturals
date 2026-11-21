---
description: Mandatory quality gate for major updates, DB schema changes, checkout/payment changes, sitemaps, refactors, and live VPS deployments in Sasya Naturals (sasynaturals.com).
globs: "**/*"
---

# GATE 2: Major Updates, Schema Migrations & Live VPS Deployments (`sasya-naturals` / `sasynaturals.com`)

### Gate 0 Exemption:
If the request does NOT modify code, databases, or configs in `sasya-naturals` or on the live VPS server (e.g. content drafting, standalone images, research), bypass this gate completely.

### Gate 2 Rules:
Whenever executing a major update, database schema migration, checkout/payment/RBAC change, sitemap modification, core router update, or production deployment to `/var/www/sasya_naturals` (`127.0.0.1:3020`):

1. **Adversarial Pre-Audit**: Specifically evaluate the 8 E-Commerce failure vectors:
   - **Hydration desync & DOM flashing on PDPs/Cart** (`APP_VERSION` bump + `verify_hydration.js` so prices, variant pills, and stock badges never flash).
   - **Cloudflare negative 404 caching (4 hours)** on newly added product routes or sitemaps (verify `200 OK` on Standby `:3021` before primary `:3020` cutover).
   - **502 Bad Gateway during PM2 restart mid-checkout** (Hot-Standby `:3021` failover upstream with Nginx `proxy_next_upstream error timeout http_502;`).
   - **Silent port hunting in `server.js`** (strict port binding to `3020` in production mode and `5060` on localhost).
   - **Live order, customer & inventory data loss** (`PROTECTED_PATTERNS` for `data/sasya_store.db*`, `public/uploads/**`, `.env*` + pre-deploy snapshot to `/var/backups/sasya_naturals/`).
   - **Cross-domain footprint, Wikidata entity grounding, or Merchant Schema bleed** (`verify_schema_purity.js` & `verify_footprint_and_cadence.js`: `0` `ewith.me` or `zeeml.com` leaks, **0 Wikidata entity groundings until `2027-11-20`**, `Product` + `Offer` + `AggregateRating` JSON-LD rendered strictly on single `/product/:slug` pages).
   - **Client-side price/coupon manipulation or unverified payment callbacks** (`verify_checkout_math.js`: 100% server-side paise calculation, GST computation, Razorpay HMAC-SHA256 signature verification, and idempotent payment webhook handling).
   - **Non-production payment/messaging/indexing leak** (`NODE_ENV === 'production'` gate on live Razorpay capture, SMS/WhatsApp/Email dispatchers, and GSC/Indexing crons).
2. **Deterministic Multi-Layer Bookmark**:
   - Git tag: `git tag -a bookmark_YYYYMMDD_<name> -m "Restore point"` and pre-edit `git commit -m "bookmark: ..."`.
   - Physical snapshot via `node scripts/create_bookmark.js` in `.bookmarks/` (gitignored) containing `data/sasya_store.db`, `.env`, and executable `restore.js`.
3. **SSOT Stabilization**:
   - **Asset SSOT**: `src/config/appConfig.js` (`APP_VERSION`).
   - **Route SSOT**: Server router, client router, `/sitemap.xml`, `/llms.txt`, and `.md` Markdown twins in 100% parity.
   - **Schema SSOT**: `src/core/content/schemaBuilder.js` delivers master JSON-LD `@graph`.
4. **Automated 7-Suite Verification Gate (`npm test`)**:
   - `tests/verify_hydration.js`
   - `tests/verify_database.js`
   - `tests/verify_checkout_math.js`
   - `tests/verify_rbac_and_audit.js`
   - `tests/verify_content_guardian.js`
   - `tests/verify_schema_purity.js`
   - `tests/verify_footprint_and_cadence.js`
5. **Zero-502 Production Cutover**:
   - Execute strictly via `node scripts/deploy_live_hardened.js` targeting `/var/www/sasya_naturals` (Primary `:3020`) and `/var/www/sasya_naturals_staging` (Standby `:3021`).
