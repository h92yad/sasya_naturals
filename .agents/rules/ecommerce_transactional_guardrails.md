---
description: Mandatory e-commerce transactional, checkout math, Razorpay verification, dual order-status, manual shipping, 5-role RBAC, and FSSAI/GST compliance guardrails for Sasya Naturals (sasynaturals.com).
globs: "**/*"
---

# E-Commerce Transactional, RBAC & Compliance Guardrails (`sasynaturals.com`)

## 1. Server-Side Deterministic Checkout Math
- **Never trust client-side price, tax, discount, or total payloads.** The checkout API must accept only variant IDs, quantities, coupon code, payment method, and delivery address, computing all totals strictly on the server from database records.
- **Pack-Size Variant Pricing & Integer Minor-Unit Arithmetic**:
  - Every product supports pack-size variants (e.g. `100 g`, `250 g`, `500 g`, `1 kg`) with distinct SKU, MRP, selling price, promotional price, tax configuration, weight, and stock quantity.
  - All cart subtotals, discounts, GST calculations, and shipping charges must be computed server-side in integer minor units (paise) or strict decimal arithmetic to prevent floating-point rounding errors.

## 2. Payment Security & Sandbox Guardrail (Section 6)
- **Server-Side Payment Order & Cryptographic Verification (Razorpay)**:
  - Supported modes: UPI, credit/debit cards, net banking, and Cash on Delivery (COD).
  - Online payment orders must be created on the server and verified via cryptographic gateway signatures/status on the server (HMAC-SHA256).
  - **Never treat a browser redirect or client-side message alone as proof of payment.**
  - Handle successful, pending, failed, cancelled, and duplicate payment events idempotently so replayed webhooks never double-deduct stock or duplicate orders.
- **Cash on Delivery (COD) Handling**:
  - Clearly mark COD orders as payment due on delivery (`COD_PENDING`) and allow authorized staff/Accounts Managers to record collection and settlement status separately.
- **Non-Production Sandbox Gate (`NODE_ENV !== 'production'`)**:
  - Localhost and staging must strictly use sandbox payment credentials (`rzp_test_...`) and mock/sandbox Email, SMS, and WhatsApp notification providers so local testing never triggers live customer communications or drains production API quotas.

## 3. Separate Payment Status vs. Fulfilment Status State Machine (Section 7)
- **Payment Status** and **Fulfilment Status** must be stored in separate database columns:
  - **Payment Statuses**: `Pending Payment`, `Paid`, `COD Pending`, `COD Collected`, `Failed`, `Refund Initiated`, `Refunded`.
  - **Fulfilment Statuses**: `Pending Payment`, `Confirmed`, `Processing`, `Packed`, `Shipped`, `Delivered`, `Cancelled`, `Refund Initiated`, `Refunded`.
- **Atomic Inventory Policy**:
  - Adjust inventory atomically inside a database transaction when orders are placed/confirmed, cancelled, or refunded according to the store stock policy, recording every stock movement for low-stock alerts and auditing.

## 4. Manual Shipping Workflow & Scope Boundary (Sections 7 & 16)
- **Manual Shipping Only in v1**: Authorized staff manually enter `courier_name`, `tracking_number`, `tracking_url`, `dispatch_date`, and `shipping_charge` when dispatching an order.
- **Explicit Exclusions**: Do not build or assume automatic courier booking, live courier rate calculation, or third-party courier API tracking in the initial release unless explicitly approved in a scope change.

## 5. Separate Admin Portal, 5-Role RBAC & Audit Logs (Sections 5 & 10)
- The admin portal must be separate from the customer storefront, protected by authentication (modern password hashing; never plaintext), with server-side role and action permission checks on every endpoint:
  1. **Super Admin**: Full access; create/deactivate users; assign roles and permissions; manage settings, catalogue, stock, orders, payments, and reports.
  2. **Product Manager**: Create/edit products, upload images (restricted file types/sizes), manage categories, variants, prices, and inventory. No access to staff management, payment settlement, or refunds.
  3. **Order Manager**: View and process orders, confirm orders, update fulfilment status, record manual dispatch/courier details, and manage permitted cancellations.
  4. **Accounts Manager**: View payment records, COD collections, refunds, and sales/settlement reports; **no access to product catalogue administration**.
  5. **Staff**: Access strictly limited to modules and actions explicitly assigned by the Super Admin.
- **Immutable Audit Logs**: Every sensitive admin mutation (product price/stock edit, role change, order status update, refund initiation, settings update) must record `user_id`, `role`, `action`, `target_entity`, and `timestamp` in an audit log.

## 6. Business, Tax (GST) & FSSAI Compliance Configuration (Section 11)
- **No Assumed or Fabricated Licences**: Never hardcode fake GSTINs, FSSAI licence numbers, or unverified legal policies as production defaults.
- Provide admin-configurable fields and product attributes for:
  - Business legal name, registered address, and customer support email/phone.
  - GST registration, tax slabs, and invoice configuration.
  - FSSAI licence/registration details and mandatory food labelling fields (ingredients, allergen declarations, net quantity, batch number, best-before date).
  - Configurable Shipping, Cancellation, Return, Refund, Privacy, and Terms policy pages.
