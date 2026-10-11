# Deployment plan (with Google sign-in)

How to get from "works on my machine" to real customers on one InterServer VPS, in the order that
reduces risk fastest. Written from a review of the code and infrastructure files as they are today
(see `LAUNCH-GAPS.md` for the full gap list; this file is the *plan*, that one is the *inventory*).
Prices are rough and change; confirm on each provider's page before paying.

---

## 0. Decisions to make first (they shape everything)

| # | Decision | Recommendation |
|---|---|---|
| 1 | Domain name | Buy one now. Cookies, Google sign-in and Resend email all need a real domain; none of them work properly on an IP or `localhost` in production. |
| 2 | Address layout | `pacasa.net` (web), `api.pacasa.net` (API), `media.pacasa.net` (pictures). They share one registrable domain, so the session cookie works (see 2.2). |
| 3 | Who may sign in with Google | **Buyers only.** Staff (admin, packer, courier) keep email + password, and later 2FA. See section 3.3. |
| 4 | Card payments at launch | Launch on **manual transfer only** unless TropiPay sandbox is verified before the date. Don't block the launch on it. |
| 5 | Error monitoring | Sentry's free plan (nothing to run), not self-hosted GlitchTip: it costs about 1 GB of RAM you would rather spend on the app. |

---

## 0b. The domain: pacasa.net

Once it is bought, in this order:
1. **Put it on Cloudflare** (add the site, change the registrar's nameservers to the two Cloudflare gives you). Turn on "Always use HTTPS".
2. **DNS records** (proxied, orange cloud): `@` (pacasa.net), `api`, `media` -> the InterServer VPS's public IPv4. `www` -> a redirect to `pacasa.net`.
3. **Email (Resend)**: add `pacasa.net` in Resend, then copy the DKIM and SPF records it shows into Cloudflare DNS (these ones **not proxied**). When Resend says
   "verified", set `EMAIL_FROM=Pa'Casa <pedidos@pacasa.net>` (already in the env template). Add a DMARC record (`_dmarc`, `v=DMARC1; p=none; rua=mailto:you@pacasa.net`)
   so mailbox providers trust the mail. This is what lets buyers' emails actually arrive.
4. **A mailbox that receives mail** at `pedidos@pacasa.net` / `hola@pacasa.net` (Cloudflare Email Routing forwards it to your own inbox for free). The store's contact
   email in Settings should be one of these.
5. **Cloudflare SSL mode "Full (strict)"** once Caddy has its certificate (Caddy gets it from Let's Encrypt on first start; the DNS records must point at the server first).
6. **Google sign-in** (if you build it) uses `https://pacasa.net/auth/callback/google` as the redirect URI.

---

## 1. The target server

**InterServer notes** (check their current plans and prices; the numbers move):
- Their VPS is sold in "slices" (each a share of CPU, RAM and disk). Take about **4 slices (≈4 vCPU / 8 GB)**, a **KVM** VPS (Docker needs real virtualization, not a container-based VPS), **Ubuntu LTS**, with a **public IPv4**.
- Only ports **80 and 443** should be reachable (plus SSH, ideally limited to your IP or key-only). Use the OS firewall (`ufw`) as well as InterServer's, and keep Postgres, Redis, MinIO and SuperTokens on the internal Docker network (the production compose already does).
- Point the domain at Cloudflare and let Cloudflare proxy the web and API names, so the server's real IP is not the public address.
- **Memory while building:** the web image (a Next.js production build) needs about **2 GB free**, on top of what the running stack uses. With 8 GB this is fine; add a 2 GB swap file anyway so a build can never take the server down. (On a laptop with Docker limited to 1 GB the build crashes the Docker VM: that is what happened in the local rehearsal.)
- Provider backups/snapshots are a convenience, not the plan: keep the `backup.sh` copy off their network, and do one restore test.
- Read their acceptable-use / terms of service for the kind of business you run before paying: a suspended server takes the whole store down with it.

One InterServer VPS, about 4 vCPU / 8 GB RAM (the SuperTokens core is a Java process and wants ~0.5 GB by
itself), Ubuntu LTS, Docker Compose, Caddy for HTTPS, Cloudflare in front. CLAUDE.md fixes this choice
(no AWS / GCP for hosting).

```
Cloudflare (DNS, proxy, TLS, caches media)
   |
Caddy :80/:443  ──  pacasa.net            -> web      (Next.js)
                ──  api.pacasa.net        -> api      (Express)
                ──  media.pacasa.net      -> minio    (public/ prefix only)
internal network only (never published): db, redis, supertokens, minio console, worker
```

Containers: `web`, `api`, `worker`, `db` (Postgres 16), `redis`, `minio`, `supertokens`, `caddy`.
No MailHog in production.

---

## 2. Phase plan

### Phase A — Make it deployable (about 2–3 days)
This is the missing foundation; nothing below works without it.

1. **Dockerfiles** for `api`, `worker` and `web` (multi-stage; `npm ci`, build, run as a non-root user).
   - The API and worker are the same image with a different command: `node dist/main.js` and
     `node dist/worker.js`. **There is no `worker:start` script yet**, only `worker:dev`. Add it.
   - Next.js: set `output: 'standalone'` in `next.config.ts` for a small image.
   - **`NEXT_PUBLIC_*` values are baked in at build time**, not read at run time. The web image must be
     built *with* the production API URL, tenant slug, media hostname and Sentry DSN. One build per environment.
2. **`docker-compose.prod.yml`**: the services above, `restart: unless-stopped`, healthchecks (`/ready` for
   the API), internal-only networking. The development file publishes the database, Redis and MinIO to the
   host with default passwords; the production one must publish nothing except Caddy.
3. **Migrations at deploy time.** `drizzle-kit` is a dev dependency, so a production image would not have it.
   Either keep it in the image used for migrations only, or switch to drizzle's own runtime migrator. Also,
   `src/db/init/001-app-role.sql` creates the restricted app role with the **hardcoded password
   `combo_shop_app`**: in production run it once by hand with a generated password, and keep the superuser
   URL out of the running API (CLAUDE.md section 5).
4. **Secrets**: a `.env.production` on the server (mode 600, not in git), generated passwords for Postgres, the
   app role, MinIO and the SuperTokens API key. Document the list in one place (`SERVICES.md` has it).
5. **Caddy** with the three hostnames, automatic certificates, and security headers. Set
   `TRUST_PROXY_HOPS=2` (Cloudflare + Caddy) or every visitor shares one IP and the rate limits misfire.
6. **First-run data**: migrations run by themselves on every deploy. Then, once, on the server: `docker compose --env-file .env.production -f docker-compose.prod.yml --profile seed run --rm seed-geo`
   (provinces and municipalities) and `... run --rm seed-admin` (creates the store `pacasa` and its first admin from `deploy/.env.production.seed`: Luis Daniel Rios, riosluisdaniel195@gmail.com).
   **Change that password the first time you sign in, then delete `.env.production.seed` from the server** (the password was shared in a chat, so treat it as already exposed). **Never run `db:seed:demo` in production.**

### Phase B — Cookies, domain and mail (about 1 day)
- **Cookie domain.** With the web on `pacasa.net` and the API on `api.pacasa.net`, SuperTokens
  needs `cookieDomain: '.pacasa.net'` in `Session.init` (add a `COOKIE_DOMAIN` env var; unset in dev).
  Without it the browser keeps the cookie on the API host only and every call after login is a 401, the same
  class of bug as the `127.0.0.1` one. Cookies are `Secure` automatically over HTTPS.
- **CORS**: `WEB_BASE_URL` must be exactly `https://pacasa.net` (a single origin is allowed).
- **Resend**: add the domain, copy the DKIM/SPF records into Cloudflare DNS, wait for "verified", set
  `EMAIL_FROM` to an address on that domain. Until then email reaches only the account owner.
- **Store contact email**: set a real one in Settings (the demo placeholder makes the transfer-notice email fail).
- **Media**: `MEDIA_PUBLIC_BASE_URL=https://media.pacasa.net/<bucket>` and the `MINIO_PUBLIC_*` values;
  `NEXT_PUBLIC_MEDIA_HOSTNAME=media.pacasa.net` at web build time.

### Phase C — Safety before real users (about 3–4 days)
1. **Backups with a tested restore.** Nightly `pg_dump` of **both** `combo_shop` **and `supertokens`** (the
   second one holds every password hash and session; losing it logs everyone out and loses all logins).
   Plus the MinIO bucket (`mc mirror`). Copy off the server to a **different provider** (Backblaze B2 is the simple choice) — never keep the only backup on the same VPS or even the same company.
   Then actually restore into a scratch server once and write down how long it took.
2. **CI** (GitHub Actions): typecheck, lint and tests for `back/` and `front/` on every push. The backend
   tests need Postgres; a service container does it.
3. **Uptime and alerts**: an external check on `/ready` and on the home page; a check that the **worker** is
   alive (it has no health endpoint today: if it dies, emails and picture processing stop silently, which is
   exactly what happened on this machine).
4. **Sentry DSNs** for API, worker and web (the code is wired and off until set); upload source maps.
5. **Redis persistence**: enable AOF (`--appendonly yes`) so queued jobs (emails, thumbnails) survive a restart.
6. **Admin 2FA (TOTP)** and the **RLS penetration test** (CLAUDE.md M5).
7. **Legal pages** (terms, privacy). **Google requires a privacy-policy URL to publish the sign-in** (3.1), so
   this moves from "later" to "before Google login goes live".

### Phase D — Soft launch (about 20 customers)
- Manual transfer accounts (a **business** account for PayPal / Cash App), `PAYPAL_ME_HANDLE` and
  `CASHAPP_CASHTAG` set so the links pre-fill the amount.
- Remove demo accounts (`packer@example.com`, test courier) from the production database; there are none if
  `db:seed:demo` was never run.
- Rehearse a full order end to end on production, with a real $1 transfer: order, transfer report, mark paid,
  courier delivery with photo, emails received.
- Rollback plan: keep the previous image tags; a deploy is `docker compose pull && up -d`, a rollback is
  pointing at the old tag. Migrations are forward-only, so take a database dump immediately before each deploy.

### Phase E — After launch
Courier offline queue + PWA, signed URLs for private photos, TropiPay once verified, designed email
templates, per-user rate limits. See `LAUNCH-GAPS.md`.

---

## 3. Google sign-in

**Status: built and switched off until you add the keys.** With no `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` the Google routes do not exist at all and sign-in is exactly as before.
To turn it on in production: do 3.1 below, put the two keys in `deploy/.env.production`, set `WEB_GOOGLE_SIGNIN=true` (it is baked into the web build, so rebuild the web image), redeploy.
What it does: a "Continuar con Google" button on sign-in and sign-up; a callback page at `/auth/callback/google` (outside the language segment); and a "Un último paso" screen
that asks for the **phone** (Google brings the name, never the phone) before the person can place an order. Buyers only: team accounts (admin, packer, courier) are refused with a clear message.

**Design change from the plan below:** SuperTokens' *AccountLinking* recipe is a **licensed** feature of the core (it answers 402 without a license, and merely registering it breaks password login),
so it is **not used**. The rule is enforced by us instead: **one email = one account per store.** A Google sign-in is refused if that email already has a password account
("sign in with your password; you can reset it"), and a password signup is refused if the email already signed up with Google. No duplicate accounts, no license.

### 3.1 What you need from Google (free)
1. A Google account, then **Google Cloud Console → a new project** (this is only an identity provider;
   it does not conflict with CLAUDE.md's "no AWS/GCP for hosting", nothing is hosted there).
2. **OAuth consent screen**: app name, support email, logo, **privacy-policy URL and terms URL** (they must
   be on your verified domain), authorized domain. Scopes: only `openid`, `email`, `profile` (non-sensitive,
   so no security review is needed). Set the publishing status to **In production**; left on "Testing" only
   listed test users can sign in, and tokens expire after 7 days.
3. **Credentials → OAuth client ID → Web application**. Authorized JavaScript origins: `https://pacasa.net` (and `http://localhost:3000` for development). Authorized redirect URIs:
   - production: `https://pacasa.net/auth/callback/google`
   - development: `http://localhost:3000/auth/callback/google`
4. Copy the **Client ID** and **Client secret** into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` on the API.

### 3.2 How it was built (the original plan; read the design change above where it differs)
**Backend** (`core/supertokens.ts`)
- Add SuperTokens' `ThirdParty` recipe with Google, **enabled only when both env vars are set** (so
  development and tests without them behave exactly as today).
- Add the **`AccountLinking`** recipe. Reason: someone who signed up with email + password and later clicks
  "Continue with Google" with the same address must end up as the *same* person (same orders), not a second
  account. Link automatically **only when both emails are verified**. This also stops the classic takeover where
  an attacker pre-registers a victim's address with a password they chose and never verified.
- Override the third-party sign-in the same way the email/password one is overridden today: resolve the
  store from `x-tenant-slug`, create the `users` row with role **buyer** and the name from Google's profile,
  and issue the session with the tenant and role claims. `requireVerifiedEmail` already passes, because
  Google reports the address as verified.
- Tests: new account, linked account, a disabled account still blocked, and the **staff rule** below.

**Frontend**
- A "Continue with Google" button on sign-in and sign-up (and on checkout's sign-in prompt).
- A callback page at `/auth/callback/google`. It must sit **outside** the `/es` `/en` locale segment (Google
  needs one fixed redirect URI), so the middleware matcher needs an exclusion for it. It exchanges the code
  with the API (sending the tenant header, like every other call), merges the guest cart, and returns the
  person to where they were.
- Spanish and English strings; the error states (user closed the window, email not verified, account disabled).

### 3.3 Decision: staff cannot use Google (recommended)
If Google could log into an admin account, the admin's security would be only as strong as that Google account,
and it would sidestep the planned 2FA. The rule: a Google sign-in is refused (with a clear message) if the
matching `users` row has a role other than buyer. Admins and couriers keep email + password (+ 2FA later).
Say so if you would rather allow it for the admin.

### 3.4 Things Google login does *not* fix
Buyers still need to verify an email only for email + password accounts. Phone numbers are still collected by our
own form (Google does not provide them). Unverified-domain apps show a scary warning screen, so verify the
domain in Search Console before announcing it.

---

## 4. Order of work (summary)

1. Buy the domain; point it at Cloudflare. Open the InterServer, Resend, Google Cloud and Sentry accounts.
2. Phase A (Dockerfiles, prod compose, Caddy, migrations, secrets).
3. Phase B (cookie domain, Resend domain, media URLs).
4. Put it on the VPS with a test store; run the full order flow.
5. Phase C (backups + restore test, CI, uptime, Sentry, 2FA, legal pages).
6. Google sign-in (3.2), once the legal pages exist.
7. Soft launch to ~20 people on manual transfer.
8. TropiPay and the courier offline queue as they become ready.
