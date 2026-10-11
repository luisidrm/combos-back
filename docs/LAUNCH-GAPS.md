# What is still missing before launch

A review of the project as it stands (backend in `back/`, web app in `front/`), written after adding
the team screen, toasts and notifications, rate limits and error monitoring. Everything here was
checked against the code or the repository, not assumed. Ordered by how much it matters.

Legend: **Blocks launch** = do not take real money or real customers without it. **Before the soft launch**
= needed for the first ~20 customers. **Later** = worth doing, not urgent.

---

## Review of 2026-10-05 (read this first; the sections below are older and some items are now done)

**Checked and fine:** both production builds compile; backend suite 503 tests, web e2e (storefront, roles, WhatsApp, share) pass; typecheck and lint
clean in both; every main screen loads for a visitor, buyer, admin and courier with no errors and no horizontal overflow at phone width; Spanish and
English message files match key for key; the web dependencies have no known vulnerabilities; `.env` files are git-ignored.
**Now done (older sections still say otherwise):** Dockerfiles, Compose for production (Caddy, Redis persistence, `COOKIE_DOMAIN`, `TRUST_PROXY_HOPS`, restart
policies, health checks, deploy / rollback / backup / restore scripts), CI for both repos, courier dispatch, branded emails, in-app notifications,
share by link, Pa'Casa branding, a branded 404.

**Still open, in order:**
1. **Commit and push.** About 100 files in each repo are uncommitted (weeks of work). One bad disk and it is gone.
2. **Email cannot send yet:** the Resend key in `.env` is rejected ("API key is invalid"), the sender is the test address (delivers only to the account owner),
   and the demo store's contact email is a placeholder. Verify a domain in Resend; set a real contact email in Settings.
3. **Run the deploy once on a real server** (or a staging copy) with HTTPS and the real domain, and **do one restore test** of the backup. Neither has been
   exercised; cookies across `api.` and the site are the usual first failure.
4. **Terms of service and privacy policy.** The sign-up screen says "you accept the Terms and Privacy Policy" but there are no such pages to link to.
5. **Admin two-factor, and the RLS penetration test** (both planned for M5, neither built).
6. **Private images are still public-by-link** (delivery photos and payment screenshots): use short-lived signed URLs.
7. **API dependency advisories:** `npm audit` reports 6 (2 high) through `supertokens-node` -> `nodemailer` (plus two transitive moderates). The app never uses
   SuperTokens' own mailer (it has its own email delivery), so exposure is low; still, pin patched versions with `overrides` or upgrade.
8. **Card payments** stay off until TropiPay has credentials and a verified sandbox run (launching on manual transfers only is a decision already made).
9. **Placeholders on screen:** the landing page's picture collage still contains a handoff screenshot (a job listing) and generated product pictures;
   replace with real photos. Remove demo accounts (`packer@example.com`, test courier) and never run `db:seed:demo` on production.
10. **Watching it in production:** nothing alerts if the worker stops (`/ready` reports it; no one polls it), no uptime check, Sentry/GlitchTip DSN unset.
11. Smaller: the manual-transfer amount is compared by eye; a bounced email is retried like a temporary one; front types are hand-copied from the API.

---

## Blocks launch

### 1. Nothing is deployable yet
- There is **no Dockerfile** for the API, the worker or the web app. `docker-compose.yml` only starts the
  development services (Postgres, Redis, MinIO, SuperTokens, MailHog).
- No Caddy config, no Cloudflare setup, no deploy script, no rollback.
- No production environment/secrets handling: the `.env` files hold real keys (the Resend key, the
  admin password). They are correctly git-ignored in both repositories (checked), but there is no secrets
  store or documented way to put them on the server.
- **Cookies in production are untested.** Sessions are httpOnly cookies on `localhost` in development.
  In production `apiDomain` and `websiteDomain` (SuperTokens) must share a registrable domain
  (for example `api.example.com` and `example.com`), or the browser drops the cookies. This is the same
  family of problem as the `127.0.0.1` vs `localhost` bug we hit.

### 2. No backups
- No scheduled `pg_dump`, no off-server copy, **no restore test**. CLAUDE.md calls backups non-optional.
- The product and delivery photos in MinIO are not backed up at all.
- Until a restore has been done once, a backup is only a hope.

### 3. Card payments cannot go live
- **TropiPay has no credentials**, and its webhook signing scheme and endpoint paths are implemented from
  documentation but never verified against the sandbox (`providers/tropipay.provider.ts` says so).
- Until then the only real way to be paid is the manual transfer.

### 4. Email only reaches you
- Resend is using the test sender `onboarding@resend.dev`, which delivers **only to the account owner's
  address**. Buyers' confirmation emails, receipts and delivery notices will not arrive.
- Needed: verify a sending domain in Resend (DKIM/SPF), then set `EMAIL_FROM`.
- Related: the demo store's contact email is a placeholder (`…@example.com`), which Resend rejects, so the
  "transfer to check" email to the store fails (the handler retries 5 times, then reports an error). Set a
  real contact email in Settings.

### 5. Admin accounts are password-only
- Admin two-factor (TOTP) is deliberately deferred to M5 in CLAUDE.md and **is not built**. The admin can
  mark orders paid and refund, so this is the highest-value account on the system.

### 6. No automated safety net
- **No CI**: nothing runs typecheck, lint and tests on a push (`.github` does not exist).
- The **RLS penetration test** (M5) has not been done. Each module has a cross-tenant read test, but nobody
  has tried to break isolation on purpose (SQL through every route, a pooled-connection leak, the
  `app.tenant_id` setting).
- The web app has **no automated tests**. The browser checks I ran during this work are throwaway scripts,
  not part of the repository.

---

## Before the soft launch

### 7. The courier experience (rest of M4)
- **Offline queue + Background Sync** is not built. A courier in a dead zone cannot finish a delivery. CLAUDE.md
  budgets a full extra week for it.
- **No PWA at all**: Serwist is not installed, there is no manifest and no service worker, so nothing is
  installable and nothing is cached.
- ~~No courier assignment~~ **Done**: the store gives each paid order to a courier (Dispatch board / order panel); the
  courier accepts or declines, picks up, and delivers with proof or reports why not; couriers only see and touch their own.
- No packing slips beyond the browser's print of the order panel.
- **Share an order by link: done** (`/orders/:id/share`, `/shared/:token`, the buyer's "Share this combo" card, the public list page, admin
  redirect). Not built: telling the buyer when someone used their link, per-link expiry.

### 8. Notifications are basic
- ~~Plain, unbranded, bilingual emails~~ **Done**: one branded HTML+text template, one language per buyer (`users.locale`), and emails for
  placed, paid, on the way, delivered, cancelled, refunded, a 48 h unpaid reminder, verification and reset.
- Not sent: new paid order to the packer.
- **Google sign-in: built, off until you create the Google client** (DEPLOY-PLAN section 3.1) and set the keys. Google will not publish the sign-in without a **privacy-policy page on your domain**, which is still the open legal-pages item.
- A permanent failure (an invalid address) is retried 5 times like a temporary one.
- No WhatsApp `wa.me` helpers in the admin (CLAUDE.md section 12 names this as the channel people read).
- The invite link for a new team member expires after about an hour (SuperTokens' reset-link lifetime); there is
  a "send link again" button, but a longer-lived invite link would be kinder.

### 9. Money handling around manual transfers
- It is manual by design, and the risk is real: screenshots can be faked and Zelle / Cash App / PayPal personal
  accounts used for Cuba-related business can be limited. Use a business account.
- The Cash App cashtag and the paypal.me name are empty, so those links open the app but do **not** pre-fill the amount. Set them in Settings → Payments.
- Nothing checks the reported amount against the money that arrived. An admin has to compare by eye.
- Refunds of manual payments are a status change only; there is no record of how the money was returned.
- Payment accounts are now stored per store and edited in Settings → Payments (the old environment variables are only a one-time import).

### 10. Privacy of uploaded images
- Delivery photos and payment screenshots are served from the public `public/` prefix of the bucket. The
  addresses are unguessable but **anyone with the link can open them**, and a screenshot of a transfer or a photo
  of a door is personal data. Originals are private; the derivatives are not. Consider short-lived signed URLs for
  these two owner types.
- No retention policy: payment screenshots and delivery photos are kept forever.

### 11. Rate limiting is by IP only
- Added this round: checkout, quote, transfer report, upload URL, team add and invite. All are per client IP,
  because they run before the session is read.
- **Behind Cloudflare and Caddy every visitor can look like one IP** unless `TRUST_PROXY_HOPS` is set correctly.
  Check this on the first deploy.
- **Cuban mobile networks put many users behind one address (carrier NAT)**, so a team of couriers could share the
  global 300 requests/minute budget. There are no per-user limits yet.
- The limiter fails open if Redis is down (a deliberate choice, but it means no protection during an outage).

### 12. Monitoring is wired but switched off
- Added this round: error reporting in the API, the worker and the browser, with personal data stripped. It sends
  nothing until `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` are set (Sentry, or self-hosted GlitchTip on the same VPS).
- Not done: no uptime check or alert on `/ready`, no dashboard on the existing `/metrics`, no log shipping, **no
  alert on the worker** (`/ready` now reports `worker: ok|down` from a heartbeat the worker writes to Redis, but nothing watches it yet),
  no browser source maps (stack traces will be minified).

### 13. Legal and account basics
- No terms of service, privacy policy or cookie notice, on a site that collects names, phones and addresses of
  people in two countries.
- No way for a buyer to export or delete their data.
- `audit_log` is written to by every state change but there is **no screen or endpoint to read it**.

---

## Later

### 14. Admin tooling
- No customer list, no order export (CSV), no date-range filter on orders, no search beyond the loaded page.
- No discount codes or gift cards (M6). No one-tap reorder from the order list (it exists inside an order).
- Delivery fees are per municipality only; a per-reparto fee would be a separate decision.
- Removing a team member is "turn off", never delete (by design, orders reference people).

### 15. Frontend polish
- Lighthouse pass not done. No `sitemap.xml`, `robots.txt` or structured data for the landing page.
- Image compression runs on the main thread, not in a worker as CLAUDE.md describes.
- No accessibility audit beyond semantic markup (dialogs, live regions, labels).
- A dev-only console warning appears on the admin index redirect page (`Performance.measure … negative time
  stamp`); it comes from the framework's dev tooling and does not occur in production builds.

### 16. Structure
- `back/` and `front/` are two separate git repositories, and `CLAUDE.md` and the design handoff sit outside both.
- Types are still hand-copied between the API and the web app (CLAUDE.md says to fix this as its own step).
- Demo data and test accounts exist in the development database: `db:seed:demo` must never be run against
  production, and accounts such as `packer@example.com` and the test courier should be removed before launch.

---

## Suggested order
1. CI and a first Docker/Compose deploy to the VPS, with real cookies, HTTPS and `TRUST_PROXY_HOPS`.
2. Backups with a tested restore.
3. Verified Resend domain and a real store contact email.
4. Admin 2FA and the RLS penetration test.
5. TropiPay sandbox verification (or launch on manual transfers only, knowingly).
6. The courier offline queue and PWA.
7. Legal pages, signed URLs for private images, monitoring alerts.

---

## Added in the second review (deployment, Google sign-in, things we hit while building)

The plan for all of this is in `DEPLOY-PLAN.md`; every outside account and key is in `SERVICES.md`.

### Deployment specifics found in the code
- **No `worker:start` script**: only `worker:dev` exists, so a production worker has no command.
- **`NEXT_PUBLIC_*` values are baked into the web build**, so the production image must be built with the
  production API URL, tenant slug, media hostname and Sentry DSN (one build per environment).
- **`drizzle-kit` is a dev dependency**, so migrations cannot run inside a production image as it stands.
- **`src/db/init/001-app-role.sql` hardcodes the app role's password** (`combo_shop_app`). Production must create
  that role by hand with a generated password. The compose file also publishes Postgres, Redis and MinIO to the host.
- **No `COOKIE_DOMAIN` setting.** With the web on `yourdomain.com` and the API on `api.yourdomain.com`,
  SuperTokens needs `cookieDomain: '.yourdomain.com'` or login looks successful and every next call is a 401.
- **Back up the `supertokens` database too**, not only `combo_shop`: it holds every password hash and session.
- **Redis has no persistence configured**, so queued emails and picture jobs are lost if it restarts (enable AOF).
- `next.config.ts` has no `output: 'standalone'`, so the web image would be large.

### Google sign-in (requested, not built)
- Needs the SuperTokens ThirdParty and AccountLinking recipes, a callback route outside the locale segment, a
  Google OAuth client, and **a privacy-policy page** (Google will not publish the sign-in without it), which
  makes the legal pages a prerequisite. Decision pending: whether staff may use Google (recommended: no).

### Behaviour that surprised us in use
- **The worker dying was invisible** (a new picture stayed on "Processing" for ever). Now: `npm run dev` starts the API and
  the worker together, `/ready` reports `worker: ok|down`, and a picture still processing after 45 s says "taking longer
  than usual" with a retry. Still to do: an external alert on `worker: down`, and a worker container in production.
- **Failed or abandoned uploads stay "Processing"** until the 24-hour sweep marks them. Several such rows existed.
- **Deleting a picture is final**: the database row is only marked deleted, but the files are removed from storage at
  once, so there is no undo (one deletion cost two real uploads during testing).
- **Any signed-in role can use the buyer endpoints** (a courier or the packer can place an order or keep an
  address book as if they were a buyer). It only touches their own data, so it is harmless, but it is not a decision
  anyone made. (Every other role boundary was checked end to end and is enforced; `core/role-matrix.test.ts` now keeps it that way.)
- Product and delivery photos in lists depend on public derivative URLs; if `MEDIA_PUBLIC_BASE_URL` is wrong in
  production, every image silently falls back to the striped placeholder.

---

**Later review (2026-10-04):** a milestone-by-milestone comparison with the original plan, ten new gaps (double-submitted checkout, unpaginated order lists, an unexercised production build, a seed with no production guard, no web security headers, no per-product share metadata, no "order placed" email, ...) and a prioritised pre-launch work plan are in `PRELAUNCH-REVIEW.md`.
