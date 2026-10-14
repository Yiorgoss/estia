# Estia + Polar payments: outline and roadmap

Date: 2026-10-14 (UTC).

This is an outline/roadmap for research and planning, not a final spec or an implementation contract.

## Assumption (state first, redirect if wrong)

This report assumes **Polar = polar.sh**, the open-source **Merchant-of-Record (MoR) payments/billing platform for developers and SaaS**, and that **estia is the rooms marketplace** (SpareRoom-style listing site) where paid features such as premium listing placement, listing boosts, or a recurring lister plan would need a payment rail.

If Polar means something else, or the paid surface is not the listing/lister side, stop and redirect; the Polar facts below are specific to polar.sh and the mapping in section 3 will not hold.

A second, load-bearing assumption is called out as a risk in section 8: estia should sell **its own premium placement / SaaS to listers**, and must **not** use Polar to route rent or deposits between tenants and listers. Polar's Acceptable Use Policy explicitly excludes "marketplaces" (see section 2.10 and 8.1), and that distinction is the difference between a routine integration and a rejected account.

---

## How this was researched (evidence and method)

**Estia source read directly** (real files, not guesses):
- Worker entry and bindings: `src/app.ts`
- API/router/service wiring: `src/api/index.ts`, `src/api/public.ts`, `src/api/private.ts`, `src/api/health.ts`
- Handlers: `src/handlers/public/auth-handler.ts`, `src/handlers/private/{user,room}.handler.ts`
- Middleware: `src/middleware/auth-mw.ts`
- Repositories: `src/repo/{user,lister,seeker,room,refresh-token,storage}.repo.ts`
- Services: `src/services/{auth,jwt,user,refresh-token,hasher}.service.ts`
- Schema + migrations: `src/db/migrations/0001_users.sql`, `0002_refresh-token.sql`, `0003_user_profiles.sql`, `src/db/schema/*`
- Config/tests: `wrangler.jsonc`, `test/support/{sql,services,seed}.ts`, `scripts/{test.sh,smoke.sh}`

**Polar facts read from Polar's own machine-readable docs** (fetched with `curl`, same content the docs site serves):
- `https://polar.sh/docs/llms.txt` (86 KB index) and `https://polar.sh/docs/llms-full.txt` (786 KB full text)
- `https://polar.sh/docs/openapi/2026-10.openapi.json` (2.5 MB OpenAPI, used for exact webhook and checkout schemas)
- Individual page Markdown, e.g. `https://polar.sh/docs/integrate/webhooks/delivery.md`
- Standard Webhooks spec: `https://raw.githubusercontent.com/standard-webhooks/standard-webhooks/main/spec/standard-webhooks.md`

**Browser note (honest):** `chrome-devtools-axi` would not launch on this box: the cached Chrome for Testing binary (`~/.cache/puppeteer/chrome/linux-154.0.8037.57/chrome-linux64/chrome`) fails with `error while loading shared libraries: libnspr4.so`. I worked around it by (a) fetching the docs above with `curl`, which is exactly the Markdown/OpenAPI source the site renders, and (b) confirming the docs host is reachable by running the cached Chrome directly with `LD_LIBRARY_PATH=/tmp/chromelibs/usr/lib/x86_64-linux-gnu ... --headless=new --dump-dom https://docs.polar.sh`. I did not need interactive browsing, so this did not reduce verification quality, but the browser tool is currently broken for this environment and should be fixed if a later task needs real clicking.

**Also noted:** the vendored `repos/effect` directory in this worktree contains a copy of the estia project, not the Effect source (`repos/effect/src/api`, `repos/effect/src/handlers`, ...). It is therefore useless as an Effect reference; I used the installed `node_modules/effect@4.0.4` type declarations (`node_modules/effect/dist/http/HttpRouter.d.ts`, `HttpServerRequest.d.ts`, `HttpIncomingMessage.d.ts`) instead. Worth fixing the subtree if the project relies on it.

No code was changed and no dev server was started; this is a scout.

---

## 1. Estia as it exists today (what the integration must fit)

Stack: Cloudflare Workers, TypeScript, Effect v4 (`effect@4.0.4`), `effect/http` + `effect/http-api`, D1/SQLite via `@effect/sql-d1`, R2 for storage, Vite dev server.

Key seams:

| Concern | Where | What it means for payments |
| - | - | - |
| Worker entry | `src/app.ts:140-143` (`fetch(request, env, executionContext)`) | `env` is the binding map; `executionContext` is currently discarded (`void executionContext;`). `waitUntil` is not yet available and would need threading. |
| Bindings / config | `src/app.ts:65-89` (`WorkerBindings`, `makeConfigProvider`) | Any string binding or `process.env` value becomes `Config.String(...)`. So `POLAR_ACCESS_TOKEN` / `POLAR_WEBHOOK_SECRET` just need to be bindings/secrets. `JWTService` already does this at `src/services/jwt.service.ts:60-61`. |
| Runtime is cached | `src/app.ts:113-136` (`makeOrGetRuntime`) | A single handler is built on first request; services are long-lived layers. |
| D1 client | `src/app.ts:124-128` | camelCase <-> snake_case transforms are applied, so DB columns are snake_case and Effect schemas are camelCase. |
| Service wiring | `src/api/index.ts:22-95` | Repositories, domain services, and `AppServicesLive` are merged layers. A new `PaymentsRepository` / `PaymentsService` plugs in here. |
| Public router | `src/api/public.ts:54-92` (`PublicRoutes`, `PublicApi` under `/api`) | **No auth middleware.** This is where the Polar webhook route belongs. |
| Private router | `src/api/private.ts:12-62`, `src/api/index.ts:91-95` | Wrapped in `AuthMiddleware`. Lister-initiated "buy" endpoints belong here. |
| Auth | `src/middleware/auth-mw.ts:10-77` | Cookie-based JWT + refresh rotation; resolves a `CurrentUser` (`{id, role}`). |
| Identity model | `src/db/migrations/0001_users.sql` + `0003_user_profiles.sql` | `users.id` is a TEXT UUID (the stable identity). `listers.id` and `rooms.id` are INTEGER autoincrement. |
| Existing rooms API | `src/api/private.ts:41-56`, `src/handlers/private/room.handler.ts` | Only `GET /api/rooms/:id` exists. There is **no room create/update/list-for-search handler yet**, so entitlement enforcement points are greenfield. |
| Repo pattern | `src/repo/room.repo.ts:14-100` | `Context.Service` + `Layer.effect` + tagged errors with `httpApiStatus`; SQL via `SqlClient`. New payment repos should copy this. |
| Migrations | `src/db/migrations/*.sql` | Applied by `wrangler d1 migrations apply` and auto-loaded in unit tests (`test/support/sql.ts:9-36`). Add `0004_*.sql` and it is picked up everywhere. |
| Tests | `test/support/{sql,services,seed}.ts` | In-memory SQLite with the real migrations and the same name transforms; a payment repo/service can be tested the same way. |

Practical consequence: payments is a **greenfield vertical** (new service, repo, routes, migration), but the layering, config, error, and test conventions are already established and should be followed exactly.

---

## 2. What Polar provides that matters here

All names below are from Polar's current docs (`docs.polar.sh` / `polar.sh/docs`) as of 2026-10-14. Current API version is **`2026-10`** (Next: `2027-01`, Deprecated: `2026-04`). Pin it.

### 2.1 Products and prices
- **Everything is a product.** One-time and recurring are the same object; the billing cycle (one-time vs daily/weekly/monthly/yearly + interval count) and the pricing type are **locked at creation**; create a new product to change them.
- Pricing models: **fixed**, **pay-what-you-want** (min/default), **free**, **metered** (usage), **seat-based** (tiers). Metered can stack on a base fee.
- **Multiple payment currencies** per product (130+ currencies); the organization has a default currency and a price in it is required, else the product is treated as free. Polar picks currency by customer geolocation at checkout.
- Arbitrary **product metadata** travels onto orders/subscriptions/webhooks (useful for internal IDs).
- **Ad-hoc prices** can be supplied per checkout session (`prices` map, `source: "ad_hoc"`) without touching the catalog.
- Docs: `features/products`, `features/checkout/session`.

### 2.2 Checkout
Three options:
1. **Checkout Links** (`features/checkout/links`): long-lived dashboard URLs; each visit creates a fresh short-lived Checkout Session. Presets: products, discount, success/return URL, trial, seats, metadata. Query params: `product_id`, `customer_email`, `customer_name`, `discount_code`, `amount`, `locale`, `theme`, plus UTM/`reference_id`.
2. **Checkout Session API** (`features/checkout/session`, `POST /v1/checkouts/`): programmatic, returns an object with `.url` to redirect to. Supports **ad-hoc prices**, and these request fields (from the OpenAPI `CheckoutProductsCreate` schema): `products`, `prices`, `external_customer_id`, `customer_id`, `customer_email`, `customer_name`, `customer_ip_address`, `customer_billing_address`, `customer_tax_id`, `customer_metadata`, `metadata`, `custom_field_data`, `discount_id`, `allow_discount_codes`, `require_billing_address`, `success_url`, `return_url`, `embed_origin`, `locale`, `currency`, `seats`, `units`, `subscription_id`.
3. **Embedded Checkout** (`features/checkout/embed`) and **Embedded Payment Method** (`features/checkout/embed-payment-method`): customer stays on estia's domain; wallets need domain validation.
- `external_customer_id` is the key reconciliation hook: Polar stores it as `customer.external_id` and returns it on webhooks. When set, the customer's email is prefilled and locked.
- **Server-created sessions must forward the customer IP** (`customer_ip_address`) because Polar otherwise sees the Worker's IP and gets currency/tax country wrong. Cloudflare header: `CF-Connecting-IP`.
- Payment methods (auto-selected): cards/wallets (Apple Pay, Google Pay, Link), Amazon Pay/Cash App (US, USD), WeChat Pay, iDEAL/Wero, Bancontact, EPS, UPI, Kakao/Naver/Samsung Pay. No PayPal.

### 2.3 One-time purchases and subscriptions
- **Order** = one paid transaction; `billing_reason` is `purchase` | `subscription_create` | `subscription_cycle` | `subscription_update`.
- **Subscription** = recurring relationship; statuses include `active`, `trialing`, `past_due`, `canceled`, `unpaid`, `paused`. By default a customer may have **only one active subscription per organization** (can be relaxed in settings).
- Cancel has two modes: **cancel at period end** (`cancel_at_period_end=true`; keeps access to `current_period_end`, reversible) and **revoke immediately** (`DELETE`, irreversible, revokes benefits). Pause/resume and reschedule-renewal also exist.
- Docs: `features/orders`, `features/subscriptions/introduction`, `features/subscriptions/manage`.

### 2.4 Customer portal
- Hosted at `polar.sh/<org-slug>/portal`, **cannot be disabled**. Customers view subscriptions/history, download/edit invoices, download receipts, access benefits, cancel at period end, and update their default payment method.
- Sign-in is email OTP by default, or you generate a **pre-authenticated link** / **customer session** (`POST /v1/customer-sessions/`). The Customer Portal API can back a custom portal, but **updating a payment method is only on the hosted portal** (keeps you PCI-compliant).
- Docs: `features/customer-portal/introduction`, `features/customer-portal/navigate-customers`, `features/customer-portal/settings`.

### 2.5 Webhooks (order/subscription lifecycle)
- Configure endpoints in the dashboard or API (`POST /v1/webhooks/endpoints`), choose `format: "raw"`, `events: [...]`, `secret`, and `api_version`.
- **Events that matter here** (exact names):
  - Checkout: `checkout.created`, `checkout.updated`, `checkout.expired`
  - Customers: `customer.created`, `customer.updated`, `customer.deleted`, `customer.state_changed`
  - Subscriptions: `subscription.created`, `subscription.active`, `subscription.updated` (catch-all), `subscription.canceled`, `subscription.uncanceled`, `subscription.cycled`, `subscription.revoked`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`, `subscription.migrated`
  - Orders: `order.created`, `order.paid`, `order.updated`, `order.refunded`
  - Refunds: `refund.created`, `refund.updated`
  - Benefits: `benefit_grant.created`, `benefit_grant.updated`, `benefit_grant.cycled`, `benefit_grant.revoked`
  - Products: `product.created`, `product.updated`
- Payload envelope (from OpenAPI): `{ type, timestamp, api_version, data }`. `data` is `Order` / `Subscription` / `CustomerState` / `Refund` / `BenefitGrantWebhook` / `Checkout` per event.
- Useful `Order` fields: `id`, `status`, `paid`, `subtotal_amount`, `discount_amount`, `tax_amount`, `total_amount`, `refunded_amount`, `currency`, `billing_reason`, `customer_id`, `product_id`, `subscription_id`, `checkout_id`, `metadata`, `customer`.
- Useful `Subscription` fields: `id`, `status`, `amount`, `currency`, `recurring_interval(_count)`, `current_period_start/end`, `cancel_at_period_end`, `canceled_at`, `ended_at`, `customer_id`, `product_id`, `checkout_id`, `metadata`, `customer`, `product`.
- Docs: `integrate/webhooks/endpoints`, `integrate/webhooks/events`, `integrate/webhooks/delivery`.

### 2.6 Signature verification
- Polar signs with **Standard Webhooks** for secrets generated on/after **2026-09-08 00:00 UTC**; older secrets use **Polar HMAC**.
- Headers: `webhook-id`, `webhook-timestamp` (unix seconds), `webhook-signature`.
- Signed content is `"{webhook-id}.{webhook-timestamp}.{raw_body}"`, HMAC-SHA256, base64, header format `v1,<base64>` (space-separated list for rotation).
- Standard Webhooks: pass the `whsec_...` secret as-is. Legacy Polar HMAC: **base64-encode the entire `whsec_...` string** first. Polar SDKs 1.0.0-alpha.19+ try both.
- Polar recommends a timestamp tolerance to prevent replay, and using `webhook-id` as an **idempotency key**.
- SDK helper: `webhooks.validateEvent(body, headers, secret)` in `@polar-sh/sdk/2026-10`, throwing `PolarWebhookVerificationError` / `PolarWebhookUnknownTypeError`.

### 2.7 License keys and entitlements (benefits)
- **Benefits** are what a customer gets: license keys, file downloads, Discord/GitHub access, **feature flags**, custom.
- **License Keys benefit**: brandable prefix, auto-expiry, activation limits, usage quotas, auto-revoke on subscription cancel; validate via `POST /v1/customer-portal/license-keys/validate`.
- **Feature Flag benefit**: the presence of the grant *is* the entitlement. Metadata can carry values (e.g. `tier`, `max_listings`). Granted per cycle for subscriptions, lifetime for one-time.
- **Customer State** is the recommended entitlement read model: `GET /v1/customers/state/external/{external_id}` (or by Polar id) returns customer + `active_subscriptions` + `granted_benefits` + `active_meters` in one call. `customer.state_changed` is the "one webhook to rule them all" and fires on customer change, subscription change, and benefit grant/revoke.
- Docs: `features/benefits/introduction`, `features/benefits/license-keys`, `features/benefits/feature-flags`, `integrate/customer-state`.

### 2.8 Merchant-of-Record tax/VAT
- Polar is the **reseller/legal seller**: it captures **and remits** VAT/GST/US sales tax worldwide (uses Stripe Tax + registrations + accounting firms). EU B2B reverse charge is handled.
- Tax behavior (inclusive/exclusive) is configurable; default matches the customer's country. Checkout collects the billing address; orders carry `tax_amount`, `taxability_reason`, `tax_rate`.
- **You remain responsible for your own income/revenue tax.** Reverse invoices for each payout are downloadable.
- Docs: `merchant-of-record/introduction`, `features/tax-inclusive-pricing`.

### 2.9 Payouts, refunds, chargebacks, fees
- **Payouts**: Stripe Connect Express account required **before Polar can accept money**. Manual withdrawal; minimum balance thresholds; **7-day settlement delay** for orgs created on/after 2026-05-12; Stripe fees ($2/mo with an active payout, 0.25% + $0.25 per payout, 0.25% to 1% cross-border); payouts typically 4-7 business days. Reverse invoice per payout; US 1099-K issued by Stripe.
- **Refunds**: net (ex-tax) amount refundable; tax refunded automatically/prorated. One-time purchase refunds **can revoke benefits** (default on); **refunding a subscription order does not revoke access** - you must cancel/revoke the subscription. Transaction fees are **not** returned.
- **Polar can refund proactively** within 60 days to prevent chargebacks, cancelling subscriptions and revoking benefits.
- **Chargebacks** cost **$15 per dispute** regardless of outcome. Polar targets a **0.4%** chargeback rate (networks flag ~0.7%). Account review/KYC before first payout; up to 14 days; continuous reviews at thresholds; 48-hour support response expectation.
- **Fees**: Starter free, **5% + 50c** per transaction; Pro/Growth/Scale lower the rate for monthly fees; **+1.5% international cards**; Early Member (orgs before 2026-05-27) 4% + 40c + 0.5% subscription.
- Docs: `features/finance/accounts`, `features/finance/payouts`, `features/finance/balance`, `features/refunds`, `merchant-of-record/fees`, `merchant-of-record/account-reviews`.

### 2.10 Acceptable Use (the gating risk)
- Polar's AUP covers **digital goods and services** (software/SaaS, templates, courses, premium content/access). It explicitly does **not** support "physical goods, human services, **marketplaces**, and high-risk or regulated categories".
- Every org is reviewed before first payout and monitored continuously.
- Docs: `merchant-of-record/acceptable-use/introduction`. Full binding policy: `https://polar.sh/legal/acceptable-use-policy`.

---

## 3. Mapping Polar primitives onto estia

| Estia paid feature (proposed) | Polar primitive | Attach purchase to | Grant/revoke |
| - | - | - | - |
| Premium listing placement (highlight/featured room) | **One-time product** per duration (e.g. 30 days), fixed price; or **recurring product** if it should auto-renew | `users.id` (buyer) + `listers.id` + `rooms.id` (the placed room) | `entitlements` row keyed by `room_id`, `kind='premium_listing'`, `expires_at`; revoke on `order.refunded` or expiry |
| Listing boost (temporary top-of-search ranking) | **One-time product** per boost window | `users.id` + `listers.id` + `rooms.id` | `entitlements` row `kind='boost'`, short `expires_at`; ordering query reads it |
| Recurring lister plan (e.g. N active listings, unlimited photos, badge) | **Recurring product** (monthly/yearly) + **subscription** | `users.id` + `listers.id` | `entitlements` row `kind='lister_plan'` tied to `source_subscription_id`; revoke on `subscription.revoked`/`past_due` grace expiry |
| Free tier / trial | **Free product** or product **trial period** | `users.id` | Entitlement with no expiry or a trial `expires_at` |
| Contact/lead credits (optional future) | **Metered product** + meter, or **ad-hoc price** | `users.id` | `active_meters` from Customer State |

**Where the purchase is attached.** The authenticated identity is `users.id` (TEXT UUID), which maps cleanly to Polar's `external_customer_id`. That makes `users.id` the primary join. `listers.id` and `rooms.id` are INTEGER and are the *scope* of the entitlement, injected into checkout `metadata` (and optionally `custom_field_data`) by the server when the session is created. Because Polar copies checkout metadata onto the resulting order/subscription, the webhook can rebuild the `(user, lister, room, kind)` tuple without a second lookup.

**Entitlement vs benefit.** Two viable models:
- **A. Mirror Polar benefits into estia** using the **Feature Flag benefit** (or a Custom benefit) and treat `granted_benefits` / `customer.state_changed` as the source of truth. Least custom logic; estia still stores a local mirror for fast reads.
- **B. Estia-owned entitlements** derived from `order.paid` / `subscription.*` webhooks and stored in D1. More control over per-room semantics and expiry; more code.

Recommendation: **B as the enforcement table, with Polar as the billing source of truth**, and use Customer State (`getStateExternal`) as a reconciliation backstop. Estia needs row-level (per-room) entitlements that Polar benefits model awkwardly; but a periodic reconcile against Customer State keeps D1 from drifting.

---

## 4. End-to-end flow to build

```
Lister (role=lister, authenticated)
   |
   | 1. picks plan/boost in UI
   v
POST /api/payments/checkout   (private API, AuthMiddleware)
   | 2. server resolves product_id + price
   |    creates Polar Checkout Session:
   |      external_customer_id = users.id
   |      customer_ip_address  = CF-Connecting-IP
   |      metadata = {estia_user_id, estia_lister_id, estia_room_id, kind}
   |      success_url = https://estia/.../success?checkout_id={CHECKOUT_ID}
   | 3. persist checkout_intents row (status=pending)
   v
Polar-hosted Checkout  <-- 4. 302 to checkout.url
   |
   | 5. customer pays (Polar is MoR: tax, invoice, receipt)
   v
POST /api/webhooks/polar   (public route, no AuthMiddleware)
   | 6. read RAW body (HttpServerRequest.arrayBuffer / .text)
   | 7. verify Standard Webhooks signature + timestamp tolerance
   | 8. idempotency: insert webhook-id into webhook_events; skip if seen
   | 9. persist order / subscription / customer
   | 10. grant or revoke entitlement
   v
D1: polar_customers, checkout_intents, orders, subscriptions, entitlements, webhook_events
   |
   | 11. entitlement checked in listing/search/API flows
   v
Premium listing shown / boost ordered / plan limits enforced
   |
   | 12. later: subscription.canceled / revoked / past_due,
   |     order.refunded, benefit_grant.revoked  ->  downgrade
   v
Entitlement revoked; feature reverts to free tier
```

Notes that make or break this flow:
- The webhook **must read the raw body before any JSON parse**. `effect/http` exposes `HttpServerRequest.text` / `.arrayBuffer` (`node_modules/effect/dist/http/HttpIncomingMessage.d.ts:60-64`). Do **not** use `schemaBodyJson` for this route, because parsing and re-serializing changes bytes and breaks the HMAC.
- The webhook route must sit in `PublicRoutes` (`src/api/public.ts:54`), which is not wrapped in `AuthMiddleware`. Adding it under `PrivateRouterLive` would 401 Polar.
- Polar retries up to 10 times with exponential backoff, times out after 10s, and recommends responding **under 2 seconds**. Persist the event, return 202/200 fast, and do heavy work in the background. On Cloudflare this is `executionContext.waitUntil(...)` or a Queue - but `src/app.ts:141` currently discards `executionContext`, so that needs threading through `makeOrGetRuntime` first.
- Endpoints are auto-disabled after **10 consecutive non-2xx** deliveries, so error handling must not 500 on events estia does not recognize; acknowledge unknown types (the SDK's `PolarWebhookUnknownTypeError` path returns 202).
- Idempotency key: the `webhook-id` header, unique-indexed in D1. Standard Webhooks itself recommends this.

---

## 5. What estia must add

### 5.1 Modules (follow existing patterns)
- `src/services/payments.service.ts` - wraps the Polar API (create checkout session, fetch customer state, maybe refunds), exposes `Context.Service` + `Layer.effect`, tagged errors with `httpApiStatus`. Uses `Config.String("POLAR_ACCESS_TOKEN")`, `Config.Literals(["sandbox","production"], "POLAR_ENVIRONMENT")`.
- `src/repo/payments.repo.ts` (or split into `order.repo.ts` / `subscription.repo.ts` / `entitlement.repo.ts`) - D1 access via `SqlClient`, same shape as `src/repo/room.repo.ts`.
- `src/handlers/private/payments.handler.ts` - `HttpApiBuilder.group` for the "create checkout" endpoint, wired in `src/api/private.ts` and `src/api/index.ts`.
- Webhook route - either a plain `HttpRouter.route("POST", "/api/webhooks/polar", handler)` in `src/api/public.ts`, or a small `src/api/webhooks.ts` merged into `PublicRouterLive`. Plain route is simpler and matches `HealthRouter` (`src/api/health.ts`).
- Entitlement enforcement - new methods on `RoomRepository` (e.g. `findWithFilters` joins entitlements) and/or a new `EntitlementRepository`; enforce in the (future) listing create/update and search handlers.

### 5.2 Webhook endpoint specifics
- Read raw bytes: `const raw = yield* request.arrayBuffer` (or `.text`).
- Verify with WebCrypto (`crypto.subtle.importKey("raw", key, {name:"HMAC", hash:"SHA-256"}, false, ["verify"])`) over `id.timestamp.body`, constant-time compare against each `v1,...` entry, and reject timestamps outside a tolerance (e.g. 5 minutes). Alternatively `import { webhooks } from "@polar-sh/sdk/2026-10"` and call `webhooks.validateEvent(...)` - **verify this SDK runs in a Cloudflare Worker** before committing to it (it is fetch-based, but may pull Node-oriented deps; the WebCrypto path is dependency-free and is the safe default).
- Support both key derivations during the transition: Standard Webhooks (secret as-is) and legacy Polar HMAC (base64-encode the whole `whsec_...` string first).
- Return 202 for handled and unknown-but-valid events; 403 for invalid signatures; never 500 for an event type you do not model.

### 5.3 Proposed D1 schema (`src/db/migrations/0004_payments.sql`)
Columns snake_case (D1 transform), Effect schemas camelCase. Illustrative, not final:

```sql
-- Polar customer mirror, keyed by estia user
CREATE TABLE polar_customers (
             id TEXT PRIMARY KEY,                 -- Polar customer id
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL UNIQUE,             -- = users.id
          email TEXT,
     created_at DATETIME NOT NULL DEFAULT (CAST(unixepoch('now','subsec')*1000 AS INTEGER)),
     updated_at DATETIME NOT NULL DEFAULT (CAST(unixepoch('now','subsec')*1000 AS INTEGER))
);

-- Server-created checkout sessions, for reconciliation + success-page lookup
CREATE TABLE checkout_intents (
             id TEXT PRIMARY KEY,                 -- Polar checkout session id
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lister_id INTEGER REFERENCES listers(id) ON DELETE SET NULL,
        room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
     product_id TEXT NOT NULL,
           kind TEXT NOT NULL,                    -- premium_listing | boost | lister_plan
         status TEXT NOT NULL DEFAULT 'pending',  -- pending | completed | expired
            url TEXT,
       metadata TEXT,
     created_at DATETIME NOT NULL DEFAULT (CAST(unixepoch('now','subsec')*1000 AS INTEGER))
);

CREATE TABLE orders (
             id TEXT PRIMARY KEY,                 -- Polar order id
  customer_id TEXT REFERENCES polar_customers(id) ON DELETE SET NULL,
subscription_id TEXT,
     product_id TEXT,
         status TEXT NOT NULL,                    -- pending | paid | refunded | partially_refunded | void
 billing_reason TEXT,
         amount INTEGER,
     tax_amount INTEGER,
       currency TEXT,
    checkout_id TEXT,
       metadata TEXT,
     created_at DATETIME NOT NULL
);

CREATE TABLE subscriptions (
             id TEXT PRIMARY KEY,                 -- Polar subscription id
  customer_id TEXT REFERENCES polar_customers(id) ON DELETE SET NULL,
     product_id TEXT,
         status TEXT NOT NULL,                    -- active | trialing | past_due | canceled | unpaid | paused
current_period_end DATETIME,
cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0,1)),
        ended_at DATETIME,
       metadata TEXT,
     updated_at DATETIME NOT NULL
);

-- The enforcement table: what a user/lister/room is currently allowed to do
CREATE TABLE entitlements (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lister_id INTEGER REFERENCES listers(id) ON DELETE CASCADE,
        room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
           kind TEXT NOT NULL,                    -- premium_listing | boost | lister_plan
 source_order_id TEXT,
source_subscription_id TEXT,
      granted_at DATETIME NOT NULL,
      expires_at DATETIME,                        -- null = open-ended / tied to subscription
      revoked_at DATETIME,
        metadata TEXT
);
CREATE INDEX idx_entitlements_user ON entitlements(user_id);
CREATE INDEX idx_entitlements_room ON entitlements(room_id);
CREATE INDEX idx_entitlements_lister ON entitlements(lister_id);

-- Webhook idempotency + audit
CREATE TABLE webhook_events (
             id TEXT PRIMARY KEY,                 -- webhook-id header
           type TEXT NOT NULL,
    api_version TEXT,
    received_at DATETIME NOT NULL,
   processed_at DATETIME,
         status TEXT NOT NULL DEFAULT 'received'  -- received | processed | failed
);
```

If estia instead adopts Polar's Feature Flag benefit as the source of truth, `entitlements` becomes a local mirror and `webhook_events` still stands.

### 5.4 Secrets / config
- `POLAR_ACCESS_TOKEN` (organization access token; server-only), `POLAR_WEBHOOK_SECRET`, `POLAR_ENVIRONMENT` (`sandbox` | `production`), and per-product IDs (`POLAR_PRODUCT_PREMIUM_30D`, `POLAR_PRODUCT_BOOST`, `POLAR_PRODUCT_LISTER_MONTHLY`, ...).
- Local: `.dev.vars` (already gitignored). Prod: `wrangler secret put` for secrets; `vars` for non-secrets. `makeConfigProvider` (`src/app.ts:73-89`) already turns string bindings into `Config` values, so no plumbing changes beyond adding the values.
- Add `POLAR_*` to `WorkerBindings` (`src/app.ts:65-72`) for type safety.

### 5.5 Retry / idempotency / robustness
- Unique `webhook_events.id` insert is the idempotency gate; process only the first delivery.
- Keep the handler idempotent anyway (upsert orders/subscriptions, idempotent entitlement grant keyed by `(kind, room_id, source_order_id)`), because retries and redeliveries happen.
- Persist before granting; grant before returning 2xx. If granting fails, return non-2xx so Polar retries, but make the write idempotent so the retry is safe.
- Add a reconciliation job (Cron Trigger) that calls `GET /v1/customers/state/external/{users.id}` for active customers and repairs entitlement drift.
- Consider Cloudflare Queues for background processing if handler work risks the 2s guidance; that requires threading `executionContext` (or a queue binding) into the runtime.

---

## 6. Merchant-of-record consequences for estia

- **Tax/VAT**: Polar calculates, collects, and remits VAT/GST/US sales tax as the seller. Estia should not compute tax and should store `tax_amount`/`currency` from orders for display only. Prices may be tax-inclusive or exclusive per Polar settings; decide the presentation. Estia remains liable for its own income/revenue tax.
- **Refunds**: estia can refund from the dashboard or `POST /v1/refunds/`. Refund of a **one-time** premium placement should revoke the entitlement (Polar can do it, and estia should mirror it on `order.refunded`). Refund of a **subscription** order does **not** end access; estia must cancel/revoke the subscription to downgrade. Polar may refund proactively within 60 days and revoke benefits.
- **Chargebacks**: $15/dispute, Polar targets 0.4%. Sustained disputes can pause payments, hold payouts, or offboard. Premium-placement disputes are a business risk, not just a code path.
- **Failed renewals**: Polar dunning retries at +2, +5, +7, +7 days. Configure the org **benefit revocation grace period** (Immediately / 2 / 7 / 14 / 21 days) so a lister does not lose a paid placement on a single expired card. On `subscription.revoked` (or `status` `unpaid`/`canceled`), downgrade the entitlement. Branch on `subscription.updated` `status === "past_due"` for a "fix your payment" banner linking to the Customer Portal.
- **Payouts**: connect a Stripe Connect Express payout account **before** accepting money; 7-day settlement (new orgs); manual withdrawals; reverse invoice per payout; US 1099-K. Payout account country must match the business's tax-residency country and use its local currency (virtual accounts like Wise/Payoneer/Revolut usually fail Stripe verification).
- **One active subscription per customer by default**; enable "Allow multiple subscriptions" only if estia genuinely needs parallel plans per lister.
- **Portal is mandatory**: customers can always cancel and update cards there. Estia should deep-link to it rather than build card handling.

---

## 7. Open product decisions the captain must make

1. **What exactly is paid?** Premium listing placement, time-boxed boosts, a recurring lister plan, contact/lead credits, or a combination. This drives one-time vs recurring and the entitlement model.
2. **Pricing model and tiers.** Fixed one-time price per duration vs monthly/yearly subscription vs tiered (e.g. 1 / 5 / 20 listings). Polar tiers are separate products shown together; decide the ladder.
3. **Free tier.** What a free lister gets (listing count, photos, search placement) and how entitlement checks degrade to it.
4. **Unit of purchase: per-lister, per-listing, or per-tenant?** Per-listing needs `room_id` in metadata and row-level entitlements; per-lister is a single plan entitlement; per-tenant implies a team/seat model (Polar seat-based pricing + `type: "team"` customers), which is heavier.
5. **Currencies.** Default payment currency and whether to enable multiple currencies. Note the Worker-IP/geolocation caveat: forward `CF-Connecting-IP`.
6. **Who hosts the purchase UI?** Checkout Links (zero code, fastest validation), Checkout Session API + redirect (fits the authenticated flow), or Embedded Checkout (on-domain, needs domain validation). This is a UX/branding call.
7. **AUP / legal posture (highest stakes).** Confirm with Polar that estia sells its **own** premium placement/SaaS and is not a "marketplace" routing payments between listers and tenants. Decide explicitly that rent/deposits are **out of scope** for Polar. If Polar rejects the model, the fallback is a PSP (Stripe) where estia owns tax liability.
8. **Refund policy** for placements (prorated? none? first-period?) and the **benefit revocation grace period** on failed renewals.
9. **Multiple subscriptions per lister** allowed or not.
10. **Invoice/receipt/company details** and the reverse-invoice/billing identity for payouts.

These are genuine captain calls; they are registered as a captain-held task (see "Completion gate" below) rather than decided here.

---

## 8. Build order, quick wins, risks

### 8.1 Risks (ordered by severity)
1. **Acceptable Use / marketplace exclusion.** Polar's AUP names marketplaces as unsupported. If estia is judged a marketplace rather than a SaaS selling premium placement, the account is rejected before first payout. **Resolve this before writing code.** Mitigation: scope Polar strictly to estia's own premium features; keep rent/deposit flows out; ask Polar support early.
2. **Webhook raw-body/signature handling.** Parsing JSON before verification silently breaks all signatures. Must use the raw body and the correct key derivation (Standard Webhooks vs legacy Polar HMAC).
3. **Cloudflare Bot Fight Mode / WAF** can 403 Polar's webhook IPs; Polar documents this explicitly. Allowlist Polar IPs and/or disable Bot Fight Mode for the endpoint. Also note Polar does not follow redirects, so the endpoint URL must be final (no `www` redirect).
4. **Handler latency > 2s** risks retries; endpoint disabled after 10 consecutive failures. Return fast, process in background, never 500 on unmodeled events.
5. **Entitlement drift** between D1 and Polar (missed/duplicated webhooks). Mitigate with idempotency + periodic Customer State reconciliation.
6. **Server-created checkout geolocation** wrong currency/tax country. Forward `CF-Connecting-IP`.
7. **Payout/account review delays** (up to 14 days) and KYC; payout account required before accepting money. Plan go-live around it.
8. **API version churn**: `2026-10` is Current now and becomes Deprecated after the next quarterly release. Pin `Polar-Version` on requests and `api_version` on the webhook endpoint, and schedule upgrades.
9. **SDK runtime uncertainty** on Cloudflare Workers (unverified). Prefer dependency-free WebCrypto verification.
10. **Secret rotation**: support the space-separated multi-signature header so a secret can rotate without downtime.

### 8.2 Quick wins
- Create a Polar **sandbox** org and a **Checkout Link** for one premium-placement product. This validates pricing, tax, and the purchase UX with **zero estia code** and can be shared for captain review.
- Wire the **webhook endpoint + signature verification** early and test with `polar webhook listen http://localhost:...` and `polar webhook trigger order.created --seed 42`; this de-risks the highest-uncertainty code path before any UI exists.
- Use the existing `test/support/sql.ts` in-memory migration harness to test the new repo/service exactly like the current suites.

### 8.3 Suggested build order (dependencies)
1. **Phase 0 - validate eligibility and model** (blocking): confirm AUP fit with Polar; create sandbox org, payout account plan, products, and one Feature Flag / Custom benefit; pin API `2026-10`. *Depends on: captain decisions 1, 2, 7.*
2. **Phase 1 - schema + config + repos**: `0004_payments.sql`, `payments.repo.ts`, Effect schemas, `POLAR_*` config, `WorkerBindings`. *Depends on: Phase 0 product IDs.*
3. **Phase 2 - checkout creation**: `payments.service.ts` + private `POST /api/payments/checkout`; persist `checkout_intents`; redirect; success page. *Depends on: Phase 1.*
4. **Phase 3 - webhook ingestion**: public `POST /api/webhooks/polar`; raw-body signature verify; `webhook_events` idempotency; upsert orders/subscriptions/customers. *Depends on: Phase 1; can start in parallel with Phase 2.*
5. **Phase 4 - entitlements + enforcement**: grant on `order.paid`/`subscription.active`; revoke on `order.refunded`/`subscription.revoked`/grace expiry; enforce in listing create/update and search ordering; deep-link Customer Portal. *Depends on: Phase 3, and on the listing flows existing (they do not yet).*
6. **Phase 5 - harden + go live**: reconciliation cron, observability, sandbox end-to-end purchase/refund/cancel, then production account review, KYC, payout account, live products. *Depends on: Phases 0-4.*

### 8.4 First concrete PR (if promoted to ship)
The lowest-risk shippable slice is **Phase 1 + Phase 3**: the D1 payment schema, the payments repository, and the verified, idempotent webhook endpoint with tests. It has no UI dependency, exercises the riskiest code (signature verification), and gives later phases a durable ledger. Phase 2 (checkout creation) is the natural second PR.

---

## 9. Things I could not verify / assumptions to confirm

- **AUP classification** of estia (marketplace vs SaaS premium placement) - only Polar can confirm. Highest-impact unknown.
- **`@polar-sh/sdk` on Cloudflare Workers** - not installed or executed; the WebCrypto path avoids the question.
- **Exact Polar org/product/benefit IDs and dashboard settings** - must be created by the captain; not knowable from the repo.
- **Current API version at go-live** - `2026-10` as of 2026-10-14; Polar rotates quarterly.
- **Estia listing/search flows** - they do not exist yet (only `GET /api/rooms/:id`), so enforcement points are proposed, not located in existing code.
- **Cloudflare plan features** used in the plan (Queues, Cron Triggers, `waitUntil`) - assumed available; `executionContext` is currently discarded at `src/app.ts:141` and would need wiring.
- **Polar webhook source IP allowlist** changes over time; re-check before go-live.

## 10. Recommendation

Proceed, but gate on section 8.1 risk 1: get Polar to confirm estia's premium-placement model is inside the AUP before building. If confirmed, the integration is a clean greenfield vertical that fits estia's existing Effect service/repo/route conventions. Build the **webhook + ledger first** (Phase 1 + 3) because signature verification and idempotency are the real engineering risk, then checkout (Phase 2), then entitlements (Phase 4). Validate the product/pricing/UX with a sandbox Checkout Link while that code is written, and treat the captain decisions in section 7 as the inputs to Phase 0.
