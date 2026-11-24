# Sasya Naturals (`sashyanaturals.com`) - Pre-Launch & Staging Integration Checklist

This document tracks the server setup, staging environment, external provider integrations, and production cutover steps required before switching `sashyanaturals.com` from Staging/Sandbox mode to live customer traffic.

---

## 0. Infrastructure & Staging Server Status (Do NOT Publish Live Yet)

- **Domain Name (GoDaddy)**: `sashyanaturals.com`
- **Hostinger KVM2 VPS (Ubuntu 24.04)**: `189.72.179.46` (`ssh root@189.72.179.46`)
- **Primary / Staging Node Ports**: `:3021` (Staging instance at `/var/www/sasya_naturals_staging`) / `:3020` (Production instance at `/var/www/sasya_naturals`, held offline until launch)

### Infrastructure Progress:
- [x] **Step 1 — Hostinger KVM2 VPS & SSH Keys**: Provisioned Ubuntu 24.04 VPS at `189.72.179.46` and configured SSH key access (`ssh root@189.72.179.46`).
- [x] **Step 2 — Cloudflare DNS Setup**: Created Cloudflare account for `sashyanaturals.com` and pointed `A` records (`@`, `www`, `staging`) to `189.72.179.46`.
- [x] **Step 3 — GoDaddy Nameserver Update**: Updated GoDaddy nameservers to Cloudflare (`naomi.ns.cloudflare.com`, `ricardo.ns.cloudflare.com`).
- [x] **Step 4 — Staging-Only VPS Deployment (Keep Public Site Offline)**:
  - Deployed the app to `/var/www/sasya_naturals_staging` on port `3021` (`sasya-staging.service`).
  - Installed Cloudflare Origin SSL + Let's Encrypt Certbot SSL (`sashyanaturals.com`, `www.sashyanaturals.com`, `staging.sashyanaturals.com`).
  - Configured Nginx so `https://sashyanaturals.com` and `https://www.sashyanaturals.com` strictly serve the "Launching Soon" page only, while `https://staging.sashyanaturals.com` serves the staging storefront & `/admin` portal.
- [ ] **Step 5 — Final Production Cutover (Only After Sign-Off)**:
  - Point `sashyanaturals.com` and `www.sashyanaturals.com` in Nginx to primary port `3020` (with `:3021` as hot-standby) and remove the staging gate.

---

## 1. Transactional Email Provider (Email Verification, Password Reset & Order Alerts)

Currently, all 6-digit OTPs and order lifecycle emails are persisted to the SQLite `notification_logs` table and displayed via `sandboxOtpPreview` for testing, while `SMTP_API_KEY` is reserved in the Write-Only AES-256-GCM Credential Vault (`src/core/auth/credentialVault.js`).

### Before Launch:
- [ ] **Select & Verify Domain with Email Provider**:
  - Recommended Indian D2C options: **Zoho ZeptoMail**, **Resend**, **Amazon SES (Mumbai `ap-south-1`)**, or **SendGrid**.
  - Add `SPF`, `DKIM`, and `DMARC` DNS records for `sasynaturals.com` so emails from `care@sasynaturals.com` / `no-reply@sasynaturals.com` land in the Primary inbox.
- [ ] **Wire Outbound Email Dispatcher (`src/core/notifications/emailDispatcher.js`)**:
  - Read the live provider secret using `getVaultSecret('SMTP_API_KEY')` from `src/core/auth/credentialVault.js`.
  - Dispatch real transactional emails for:
    1. **New Customer Sign-Up Email Verification (6-Digit OTP)**: Verify email ownership (`email_verified = 1` on the `users` table) before activating new email/password registrations.
    2. **Forgot-Password 6-Digit OTP (`requestPasswordResetOtp` in `src/core/auth/sessionManager.js`)**: Email the 6-digit recovery code and suppress `sandboxOtpPreview` from JSON responses when `NODE_ENV=production`.
    3. **Order Lifecycle Emails (`src/core/checkout/checkoutEngine.js`)**: Send **Order Confirmed** (with GST tax invoice link), **Order Shipped** (with Courier name & AWB tracking link), **Order Delivered**, and **Order Cancelled / Refund** emails using the 4 editable templates in **Admin -> Settings -> Panel 6**.
- [ ] **Seal Live `SMTP_API_KEY` in Admin Credential Vault**:
  - Sign in to `/admin` as `SUPER_ADMIN`, open **Panel 6 (Settings & Compliance)**, and seal the production `SMTP_API_KEY`.

---

## 2. Google Login ("Continue with Google" / OAuth 2.0)

Adding 1-tap **Sign in with Google** removes password friction for D2C shoppers and automatically satisfies email verification (`email_verified: true` is cryptographically asserted in Google's signed ID token).

### Before Launch:
- [ ] **Create Google Cloud OAuth 2.0 Credentials**:
  - In Google Cloud Console -> **APIs & Services -> Credentials**, create an **OAuth 2.0 Client ID** (Web application).
  - Add authorized JavaScript origins: `https://sasynaturals.com` and `https://www.sasynaturals.com`.
  - Configure the OAuth Consent Screen with the Sasya Naturals logo, Privacy Policy (`https://sasynaturals.com/privacy`), and Terms of Service (`https://sasynaturals.com/terms`).
- [ ] **Add Google OAuth Keys to the Write-Only Credential Vault**:
  - Add `GOOGLE_OAUTH_CLIENT_ID` (and optional `GOOGLE_OAUTH_CLIENT_SECRET`) to `ALLOWED_VAULT_KEYS` in `src/core/auth/credentialVault.js` and seed the vault slot in `src/db/database.js`.
- [ ] **Add Server-Side Google ID Token Verification & Account Linking (`POST /api/account/google`)**:
  - Verify the Google Identity Services JWT (`credential`) signature and audience (`aud === GOOGLE_OAUTH_CLIENT_ID`).
  - Check `payload.email_verified === true`.
  - If a `CUSTOMER` row with that email already exists in `users`, link their `google_sub` ID and mark `email_verified = 1`; otherwise auto-create the `CUSTOMER` row and issue the `HttpOnly` `sn_customer_session` cookie.
- [ ] **Render "Continue with Google" Button on `/account` and `/checkout`**:
  - Add the Google Identity Services button to `renderCustomerAccountPage` and `renderCheckoutPage` in `src/views/renderViews.js`.

---

## 3. Live Razorpay & SMS/WhatsApp COD OTP Cutover

- [ ] **Razorpay Live Keys (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`)**:
  - Switch from Razorpay Test mode to Live mode in the Razorpay Dashboard and seal all three keys in **Admin -> Settings -> Credential Vault**.
- [ ] **SMS / WhatsApp COD OTP Provider (`WHATSAPP_OTP_API_KEY`)**:
  - Connect **MSG91**, **Fast2SMS (DLT route)**, or **Interakt / Gupshup WhatsApp OTP** to `requestCodOtp` in `src/core/checkout/codProtection.js` so Cash-on-Delivery orders verify the customer's mobile number via live SMS/WhatsApp and suppress `sandboxOtpPreview` in production.
- [ ] **Production Environment Flags**:
  - Set `NODE_ENV=production` and a strong 64-byte `SESSION_SECRET` on the production VPS (`:3020` primary / `:3021` hot-standby).
  - Rotate default seeded staff passwords (`superadmin@sasynaturals.com`, `catalog@sasynaturals.com`, `orders@sasynaturals.com`, `accounts@sasynaturals.com`, `dispatch@sasynaturals.com`) immediately after first production sign-in.
