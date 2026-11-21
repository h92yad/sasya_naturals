---
description: Mandatory quality gate for minor changes, bug fixes, UI adjustments, and catalogue copy edits in Sasya Naturals (sasynaturals.com).
globs: "**/*"
---

# GATE 1: Minor Changes & Bug Fixes (`sasya-naturals` / `sasynaturals.com`)

### Gate 0 Exemption:
If the request does NOT modify files or databases in `sasya-naturals` or on the live VPS server (e.g. drafting product copy, creating standalone images, codebase research), bypass this gate completely.

### Gate 1 Rules:
Whenever executing a minor change or bug fix ($\le 15$ static/public/view files, zero DB schema changes, zero SSR router changes, zero payment/checkout math changes):

1. **Safety & Multi-Project Isolation Baseline**:
   - Ensure `http://localhost:5060` is running.
   - Never touch `D:\Ewithme` (`/var/www/ewithme`) or `D:\zeeml` (`/var/www/zeeml`).
   - Never overwrite `data/sasya_store.db`, customer/order records, uploaded product images, or `.env*` in `/var/www/sasya_naturals`.
   - **NEVER add Wikidata entity groundings (`wikidata.org` / Wikidata Q-IDs) on `sasynaturals.com` for at least 1 year (locked until at least `2027-11-20`).**
2. **Pre-Edit Bookmark**:
   - Run `git commit -m "bookmark: pre-minor-fix ..."` before editing any file.
3. **SSOT & Anti-Flashing Rule**:
   - Bump `APP_VERSION` in `src/config/appConfig.js` whenever frontend JS or CSS (`public/assets/sasya-core.css`, `public/assets/sasya-client.js`) changes.
   - Run `node tests/verify_content_guardian.js`, `node tests/verify_hydration.js`, `node tests/verify_schema_purity.js`, and `node tests/verify_footprint_and_cadence.js`.
4. **Hydration Non-Interference**:
   - Client hydration must respect SSR (`data-ssr-rendered="true"`) without overwriting `#app-mount` `innerHTML` on initial load. Bind event listeners cleanly for variant selectors (`100 g`, `250 g`, `500 g`, `1 kg`), cart drawer, checkout forms, and RBAC admin actions.
5. **Targeted Verification**:
   - Test the modified route against `http://localhost:5060` to confirm HTTP `200 OK`, zero CLS flash, and valid rendered HTML output.
