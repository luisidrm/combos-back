# Review against the original plan, and what to do before launch

Written 2026-10-04 after reading the code, `CLAUDE.md` (the roadmap in section 14), `LAUNCH-GAPS.md` and
`DEPLOY-PLAN.md`. Everything below was checked against the repository, not remembered. Effort is in working days
of one person with Claude's help; it is a rough guide, not a promise.

---

## 1. The original plan, milestone by milestone

Legend: **done** · **partly** · **missing** · **changed** (a decision moved away from the plan).

### M0 Foundation
| Item | Status |
|---|---|
| Docker Compose (dev), Drizzle + RLS + cross-tenant tests, SuperTokens, ESLint boundary rule, event bus, next-intl, Redux + persist | **done** |
| Monorepo (pnpm + Turborepo) and shared types package | **missing**, deliberately postponed in CLAUDE.md; types are copied by hand between `back/` and `front/` |

### M1 Catalog
Products, categories (with icons), the media pipeline, "needs a ready picture to go live", admin CRUD, resilient upload
with progress and retry: **done**. Since the plan: every product must have a category (your rule), a product page
gallery, covers in the admin list.

### M2 Storefront and cart
| Item | Status |
|---|---|
| RSC catalog, product detail, cart, cart merge, recipients/addresses, delivery zones | **done** |
| **Guest checkout** | **changed**: the cart works for guests, but checkout needs a signed-in buyer with a verified email. The plan said guest checkout. Decide which you want (see section 4). |
| Serwist storefront caching | **missing** (Serwist is not installed) |
| Optional Leaflet / OpenStreetMap pin | **missing** (optional) |

### M3 Orders and payments
State machine, snapshots, audit log writes, the `PaymentProvider` interface, manual transfer, idempotent webhooks,
reconciliation: **done**. Manual transfer accounts are now stored per store and edited by the owner (beyond the plan).
Still open: **TropiPay has never run against its sandbox**, and the **audit log has no screen** (its route file is an
empty TODO).

### M4 Fulfilment
| Item | Status |
|---|---|
| Admin order queue, mobile courier view (online), delivery proof photo, order emails | **done** |
| Couriers (optional) | **partly**: the `couriers` table exists but nothing ever writes to it; there is no assignment, every courier sees every order |
| **Offline queue + Background Sync** | **missing** (CLAUDE.md budgets a full extra week) |
| Packing slips | **missing** (only the browser's print) |
| Resend templates | **partly**: plain text, bilingual, unbranded. No "order placed", "cancelled" or "refunded" emails |
| WhatsApp `wa.me` links from the admin | **missing** (only mentioned in code comments) |

### M5 Hardening and launch
Nothing here is finished: verified restorable backups, RLS penetration test, Lighthouse pass, Caddy + Cloudflare, deploy
script with rollback, soft launch. **Done in part:** Sentry is wired (off until a DSN is set), per-IP rate limits, a
worker heartbeat on `/ready`.

### M6 Post-launch
One-tap reorder **done** (the order screen's "Repetir combo"). Reporting **done** (analytics screen). Recipient tracking
page, discount codes, gift cards **missing** (a gift message exists). These are meant to follow real orders, so they can wait.

### M7 SaaS
Not started, on purpose. Per-store settings already exist for payments, categories, delivery zones and store profile.

### Things built that were not in the plan
Landing page, Team screen (staff and couriers), toasts and live admin alerts, demo-data seed, role-matrix tests, rate
limits, error monitoring, payment methods CRUD, custom dropdowns, teal palette, product gallery, upload recovery.

---

## 2. Gaps found in this review that were not in `LAUNCH-GAPS.md`

1. **No protection against a double-submitted checkout.** There is no idempotency key; only a per-IP rate limit. A
   double click, a retry on a bad connection, or a refresh can create two orders and two payments for one cart.
   *Costs real trust and refunds.*
2. **Order lists are not paginated.** The admin queue loads every order with its items and reports each time, and the
   buyer's order list likewise. Fine for 20 customers, slow within months.
3. **The production build was never exercised.** `npm run build` in `back/` compiles, but it also compiles all 24 test
   files into `dist/`, and does not carry the migrations. There is no `tsconfig.build.json`, no worker start command, and
   `next build` (the web app) has not been run in this review (it would overwrite the running dev server's output), so
   it is unverified.
4. **`db:seed:demo` has no production guard.** Nothing stops someone running it against a live database and creating
   admin/courier/buyer accounts with a known password. It should refuse when `NODE_ENV=production`.
5. **No security headers on the web app** (no CSP, frame or referrer policy). The API has helmet; Next.js has none.
6. **Product pages have no per-product metadata** (title, description, share image) and there is no `sitemap.xml` or
   `robots.txt`. Links shared on WhatsApp will look generic, which matters for a product sold by sharing.
7. **No "order placed" email to the buyer** (only paid / on the way / delivered). A buyer who just paid by Zelle hears
   nothing until the store confirms.
8. **`wa.me` is not built**, although CLAUDE.md calls it the channel people actually read.
9. **The courier table is an orphan** (see M4).
10. **Frontend has no tests at all**, and there is no end-to-end test of the order flow. The browser checks done during
    development were throwaway scripts.

Already known and still true (see `LAUNCH-GAPS.md`): no Dockerfiles / deploy, no backups, no CI, email domain not
verified, admin has no 2FA, legal pages missing, signed URLs for private photos, rate limits only per IP, no Google login.

---

## 3. What can be done before launch, in a sensible order

### Track A: code that needs no outside account (start immediately)

| # | Work | Why it matters | Days |
|---|---|---|---|
| A1 | **Deployability**: `tsconfig.build.json` (no tests), `worker:start`, Dockerfiles for api / worker / web (Next `standalone`), `docker-compose.prod.yml`, Caddyfile, `.env.production.example`, migrate-on-deploy step, deploy and rollback scripts | Nothing can ship without it; surfaces real build problems early | 3 |
| A2 | **CI** (GitHub Actions): typecheck, lint, tests for both repos; Postgres service container | Catches regressions before the server does | 0.5 |
| A3 | **Checkout idempotency** (a key per attempt, one order per key) | Stops duplicate orders and payments | 0.5 |
| A4 | **Seed guard** (refuse `db:seed:demo` in production) | Prevents known-password accounts on a live system | 0.1 |
| A5 | **Pagination and search** for the admin queue and buyer orders | Keeps the admin usable as orders grow | 1 |
| A6 | **Legal pages** (terms, privacy, cookies, refund policy) as editable templates, footer links | Required by Google sign-in and basic trust; a lawyer reviews the text | 1 |
| A7 | **Security headers** and **SEO**: CSP and friends on the web app, per-product metadata and share image, sitemap, robots | Safer, and shared links look right | 1 |
| A8 | **Emails**: order placed, cancelled, refunded, "your transfer is still unpaid" warning at 48 h, designed HTML templates | Fills the silence that makes buyers anxious | 2 |
| A9 | **Admin 2FA (TOTP)** | The admin can mark paid and refund; password alone is too weak | 2 |
| A10 | **Signed URLs** for delivery photos and payment screenshots, plus a retention rule | Those images are personal data | 1.5 |
| A11 | **RLS penetration test** (script that tries to break isolation through every route) | Tenant isolation is the foundation of the SaaS plan | 1.5 |
| A12 | **Backup and restore scripts** (both databases + pictures) | Written now, proven on the real server later | 1 |
| A13 | **Playwright smoke tests**: sign up, order with transfer, admin marks paid, courier delivers | First automated net for the web app | 2 |
| A14 | **Courier assignment** + packing slip print view | One courier per order; the `couriers` table finally used | 2 |
| A15 | **`wa.me` buttons** in the admin order panel | The channel people read | 0.5 |
| A16 | **Audit log screen** | "Who marked this paid?" needs an answer | 1 |
| A17 | **Courier offline queue + PWA** (Serwist, IndexedDB, Background Sync, manifest) | The biggest item; a courier in a dead zone must still finish a delivery | 5+ |
| A18 | **Google sign-in** (after A6) | Requested; see `DEPLOY-PLAN.md` section 3 | 2 |

### Track B: things only you can start (they have the longest lead times, so begin now, in parallel)
1. **Domain name** and Cloudflare account.
2. **TropiPay**: business account verification and a sandbox request. This is the slowest item and decides whether
   card payments are in the soft launch.
3. **Resend**: verify the sending domain; set a real store contact email.
4. **Google Cloud** OAuth client and consent screen (needs A6 first).
5. **Business accounts** for Zelle, Cash App and PayPal; fill the cashtag and paypal.me handle in Settings → Payments.
6. **InterServer** server and (separate provider) backup storage.
7. **Legal review** of the terms and privacy text from A6.

### Track C: running the business (not software, but a launch fails without it)
- Real catalog: photos, prices and stock for the actual products; real delivery zones and fees; the real free-delivery amount.
- **Couriers**: who they are, accounts created in Team, a short training (photo of the box, recipient name).
- **Who checks transfers** and how fast (a promise like "within 2 hours"), and what happens when the money is not found.
- **Support channel** (a WhatsApp number or email that someone reads) and a refund / complaint policy.
- A **rehearsal**: 3 to 5 friends or relatives in Miami place real orders for real families in Santa Clara, end to end,
  before anything is announced.

---

## 4. Decisions needed from you
1. **Guest checkout**: keep "account required to pay" (safer, simpler emails and tracking), or build guest checkout as the
   plan said? Diaspora buyers are often older; an extra step costs orders, but guests complicate refunds and receipts.
2. **Card payments at launch**: launch on manual transfer only (recommended) or wait for TropiPay?
3. **Staff and Google sign-in**: buyers only (recommended).
4. **Courier offline queue**: before the soft launch, or launch with couriers online-only and a phone-call fallback, then
   build it? It is the single biggest piece of work.

## 5. Suggested sequence

| Week | Focus | Items |
|---|---|---|
| 1 | Make it shippable and safe | A1, A2, A3, A4, A12; you start all of Track B |
| 2 | Trust | A6, A7, A9, A10, A8; first deploy to the server with a test store |
| 3 | Operations | A5, A14, A15, A16, A13; Track C catalog and couriers; backup restore test on the server |
| 4 | Rehearsal and soft launch | A11, A18, fix what the rehearsal finds; soft launch to about 20 customers |
| After | Courier offline queue (A17) if not earlier, TropiPay, discount codes, tracking page | |

If the offline queue (A17) is required for launch, add about a week and move the soft launch to week 5.
