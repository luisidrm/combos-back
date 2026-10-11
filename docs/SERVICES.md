# Every service the project uses, what it costs, and what you must provide

Prices are rough orders of magnitude and change, so confirm them on each provider's page. "Key" means a
secret that goes in the server's environment file, never in git.

Legend: **Free** = nothing to pay at this size. **Paid** = a recurring or per-use cost. **You do** = what only
you can do (accounts, identity checks, DNS).

---

## A. Needed to run in production

| Service | Used for | Cost | What you must provide |
|---|---|---|---|
| **Domain name** (any registrar, or Cloudflare Registrar) | The site, the API, the pictures; cookies, Google sign-in and email all depend on it | **Paid**, roughly $10–15 / year | Buy it; keep the account secure. |
| **InterServer VPS** (about 4 vCPU / 8 GB, KVM) | Runs everything (Docker Compose) | **Paid**, roughly €7–15 / month | Account + payment; SSH key; choose the EU region. Optional: Hetzner's own backups add about 20%. |
| **Cloudflare** | DNS, HTTPS proxy, caching of pictures, basic attack protection | **Free** plan is enough | Account; move the domain's nameservers to it. |
| **Caddy** | HTTPS certificates, reverse proxy | **Free**, open source | Nothing (needs ports 80/443 open). |
| **Postgres 16**, **Redis 7**, **MinIO** | Database, queues/rate limits, picture storage | **Free**, open source (run in Docker) | Generated passwords/keys (below). |
| **SuperTokens core** | Login, sessions, passwords | **Free** when self-hosted (what we do). Their cloud has a free tier but we don't use it | `SUPERTOKENS_API_KEY` (you invent it, 32+ chars; the core must not be reachable from outside). |
| **Resend** | All email (verification, receipts, delivery notices, password and team links) | **Free** tier is small (about 3,000 emails/month, about 100/day); paid plans start around $20/month | Account; add and **verify your domain** (DNS records in Cloudflare); an **API key** (`RESEND_API_KEY`); `EMAIL_FROM` on that domain. Without a verified domain, mail goes only to you. |
| **Sentry** (error reports) | Crash and error alerts from the API, worker and browser | **Free** developer plan (limited events/month); paid if you outgrow it | Account; a project per app and its **DSN** (`SENTRY_DSN` API/worker, `NEXT_PUBLIC_SENTRY_DSN` web, set at web build time). Optionally an auth token to upload source maps. |
| **Uptime monitor** (UptimeRobot or Better Stack) | Pages you when the site or `/ready` is down | **Free** tier | Account; the URLs to watch; where to send the alerts (email/phone). |
| **Off-server backup storage** (Backblaze B2, a different company from the server) | Copies of the databases and pictures | **Paid**, a few dollars/euros a month | Account; credentials for the backup job. Not AWS/GCP, per CLAUDE.md. |
| **GitHub** | Code hosting, CI (Actions), optionally container registry | **Free** (private repos and a monthly CI allowance included) | Account; push `back/` and `front/` (two repos today). |

### Secrets and generated values to prepare
`POSTGRES` superuser password · the restricted app-role password (replaces the dev `combo_shop_app`) ·
`MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` · `SUPERTOKENS_API_KEY` · `PLATFORM_API_KEY` (32+ chars, used once to
create the store; can be removed afterwards) · `METRICS_TOKEN` (16+ chars) · the admin account's email and a
strong password · `TRUST_PROXY_HOPS=2`.

---

## B. Needed for the features you asked for

| Service | Used for | Cost | What you must provide |
|---|---|---|---|
| **Google Cloud Console** (OAuth only) | "Continue with Google" | **Free** | Google account; a project; the **consent screen** (app name, logo, support email, **privacy-policy and terms URLs on your domain**, authorized domain); an **OAuth client** with the redirect URIs from `DEPLOY-PLAN.md` 3.1. You get `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Publishing status must be "In production". Verify the domain in Google Search Console to avoid a warning screen. |
| **TropiPay** (card payments) | Paying by card | **Paid per transaction** (their fee schedule; no fixed fee that we know of, confirm with them) | A **TropiPay business account** (identity/business verification takes time, and you must do it); **sandbox access** (ask their support); `TROPIPAY_CLIENT_ID`, `TROPIPAY_CLIENT_SECRET`, the **webhook signing secret**; set `TROPIPAY_ENV=production` only after the sandbox test. The code is written from their documentation and has **never been run against their sandbox**. |
| **Zelle** | Manual transfer | Usually free to receive through a bank | The email or phone registered to the **store's** Zelle (`ZELLE_EMAIL`). A business bank account is wise. |
| **Cash App** | Manual transfer | Fees apply to business accounts (confirm) | `CASHAPP_CASHTAG` (so the link pre-fills the amount) and `CASHAPP_EMAIL`. Use a business account. |
| **PayPal** | Manual transfer (not an integration: we only show your account and a `paypal.me` link) | Business receive fees apply (confirm) | `PAYPAL_EMAIL` and `PAYPAL_ME_HANDLE`. **A real risk, accepted by you:** PayPal can limit or freeze an account receiving Cuba-related payments. Use a business account and do not keep big balances. |

---

## C. Already in the project, no account needed

| Thing | Notes |
|---|---|
| **OpenStreetMap / Leaflet** (optional map pin) | Not built yet. The public OSM tile server is for light use only; real traffic needs a paid tile provider or self-hosted tiles. Decide when the map is built. |
| **WhatsApp `wa.me` links** | Free; opens the user's WhatsApp with a message. Not built into the admin yet. The paid WhatsApp Business API is a later option. |
| **Geist font, lucide icons** | Open source, self-hosted. |
| **MailHog** | Development only; never in production. |
| **Docker / Docker Desktop** | Free for personal and small-business use (check the licence terms if the company grows). |

---

## D. Things money or paperwork will ask of you (not software)

- **Legal pages** (terms of service, privacy policy, cookie notice): a template service or a lawyer. Required
  by Google to publish sign-in, and sensible regardless (you collect names, phones and addresses in two countries).
- **A real business contact email** on your domain for the store (Cloudflare Email Routing is free for
  receiving; a mailbox with sending is a paid plan elsewhere).
- **Business accounts** at your bank and in Cash App/PayPal for the transfers.
- **Sanctions awareness**: every provider above is a US or EU company. Their terms around Cuba differ. Stripe, Square and Braintree
  are excluded by CLAUDE.md for exactly this reason; read the terms of any new provider before signing up.

---

## E. Rough monthly running cost (soft launch)
VPS €7–15 · backups storage €3–5 · domain ≈ $1 · everything else on free tiers = **about $12–25 a month**,
before payment fees (which come out of each sale, not a fixed cost). Resend's paid plan or Sentry's paid
plan only if you outgrow their free tiers.
