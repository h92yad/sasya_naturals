---
description: Hard 1-Year Moratorium (until at least 2027-11-20) strictly forbidding Wikidata entity groundings, cross-domain footprint bleed, and GitHub Pages duplicate SEO indexing on sasynaturals.com.
globs: "**/*"
---

# 1-Year Wikidata Entity Grounding Ban & Portfolio Footprint Isolation (`2026-11-20` to `2027-11-20`)

## Inviolable Guardrail
**NEVER add Wikidata entity groundings (`wikidata.org` / Wikidata Q-IDs) or cross-domain references (`ewith.me`, `zeeml.com`) on `sasynaturals.com` (`h92yad/sasya_naturals`) for at least 1 full year (locked until at least `2027-11-20`).**

### Scope of Prohibition
1. **Zero `wikidata.org` URLs**: Never include `wikidata.org`, `www.wikidata.org/wiki/Q...`, or `www.wikidata.org/entity/Q...` in any JSON-LD `@graph`, HTML DOM attribute/link, Markdown twin (`.md`), `/llms.txt`, `/llms-full.txt`, or SQLite/JSON dataset.
2. **Zero Entity Grounding Arrays**: Never add `sameAs`, `about`, `mentions`, or `mainEntity` blocks pointing to Wikidata Q-IDs (`Q\d+`) or Wikipedia/DBpedia/Knowledge Graph entity URIs.
3. **Zero Portfolio Cross-Footprint Bleed**: Never reference `ewith.me`, `zeeml.com`, `zml-`, or `ew-` class prefixes, assets, or endpoints in `sasynaturals.com`. All CSS classes in Sasya Naturals use the dedicated `sn-` namespace.
4. **Google Search Central & Merchant Center Product Schema Isolation**:
   - `Product`, `Offer`, and `AggregateRating` JSON-LD schemas must render **exclusively** on single Product Detail Pages (`/product/:slug`).
   - Category pages (`/shop`, `/category/:slug`) must render `CollectionPage` + `ItemList` + `BreadcrumbList` only—never raw `Product` rich-snippet blocks on multi-product listing grids.
5. **GitHub Pages Showcase Anti-Index & Secret Guardrail (`h92yad.github.io/sasya_naturals`)**:
   - All static showcase builds exported to `/docs` for GitHub Pages (`*.github.io`) must include `<meta name="robots" content="noindex, nofollow">` so search engines never index the `github.io` preview URL as a duplicate of `sasynaturals.com`.
   - Never commit `.env*`, `data/*.db*`, or `.bookmarks/` into the GitHub repository.

### Programmatic Circuit Breakers
- `src/core/content/schemaBuilder.js` (`WIKIDATA_MORATORIUM_UNTIL = '2027-11-20'`, `assertZeroWikidataGrounding()`) throws a fatal `[WIKIDATA_MORATORIUM_VIOLATION]` error if any JSON-LD payload contains Wikidata references.
- `tests/verify_schema_purity.js` and `tests/verify_footprint_and_cadence.js` fail immediately if any route or source file violates schema isolation or cross-domain footprint rules.
