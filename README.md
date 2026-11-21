# Sasya Naturals (`sasynaturals.com`) — E-Commerce Storefront & 5-Role Admin Portal

Direct-to-customer Indian e-commerce platform for **Dry Fruits**, **Millets & Grains**, and **Spices** with `100 g`, `250 g`, `500 g`, and `1 kg` pack-size variants, server-side **Rust WebAssembly (`wasm_core.wasm`)** checkout/GST math, **Razorpay HMAC-SHA256** verification + **Cash on Delivery (COD)**, dual Payment/Fulfilment status tracking, manual courier dispatch, and a separate **5-Role RBAC Admin Portal**.

---

## 1. Architecture & Language Hub (Option A)

- **Storefront & SSR Micro-Kernel (`Node.js 22`)**: Zero-flash isomorphic SSR (`data-ssr-rendered="true"`), dedicated `sn-` Vanilla CSS design system, JSON-LD `@graph` builder (`src/core/content/schemaBuilder.js`), `.md` Markdown twins, `/sitemap.xml`, and `/llms.txt`.
- **Deterministic Commerce Core (`Rust -> WebAssembly`)**: `rust/sasya_commerce_core/` compiled to a 951-byte `wasm_core.wasm` binary executing `i64` integer-paise line totals, 5%/12% inclusive GST calculations, coupon caps (`SASYA10`, `WELCOME15`, `PANTRY100`), and free-shipping thresholds (`₹799`).
- **Database (`SQLite WAL` -> `PostgreSQL` ready)**: 13 transactional tables in `src/db/database.js` with PBKDF2-SHA512 salted password hashes and atomic stock movements.
- **Dual-Mode GitHub Pages Showcase (`/docs`)**: Pre-rendered static showcase powered in-browser by `wasm_core.wasm` + `localStorage` with `<meta name="robots" content="noindex, nofollow">` so search engines never index the `github.io` preview URL.

---

## 2. Quick Start (Localhost `:5060`)

```bash
# 1. Run all 7 automated guardrail verification suites
npm test

# 2. Start the SSR & REST API server on http://localhost:5060
npm start

# 3. Create a Gate 2 physical database + config bookmark in .bookmarks/
npm run bookmark

# 4. Re-compile the Rust WASM Commerce Core (optional)
npm run build:wasm

# 5. Export the static GitHub Pages interactive showcase into /docs
npm run export:gh-pages
```

---

## 3. Enabling the 24/7 GitHub Pages Interactive Showcase (\$0 Hosting)

1. Open **[github.com/h92yad/sasya_naturals/settings/pages](https://github.com/h92yad/sasya_naturals/settings/pages)**.
2. Under **Build and deployment** $\rightarrow$ **Source**, select **Deploy from a branch**.
3. Select branch **`main`** and folder **`/docs`**, then click **Save**.
4. Your interactive showcase will be live at **`https://h92yad.github.io/sasya_naturals/`**.