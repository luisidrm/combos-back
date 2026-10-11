# Combo Shop API — endpoint reference

What every endpoint is for and what happens inside it. Reflects the code as of the M3 backend plus the
first half of M4: checkout, the order state machine, both payment providers, webhooks, reconciliation,
proof of delivery and the courier queue (section 9b), and order emails. A courier-assignment model and the
offline queue are still to come. `audit_log` is
written to internally by every state transition but has no read endpoint of its own yet.

## Conventions

**Base URL (dev):** `http://127.0.0.1:4000`

**Tenant.** Almost every route needs `x-tenant-slug: <store slug>`. `resolveTenant` turns it
into a tenant id; every query after that runs inside that tenant (Postgres RLS enforces it).
The header must look like a slug (`[a-z0-9-]`, ≤ 63) — anything else is a 400 before any lookup.
Exceptions (no header needed): `/geo/provinces*`, `POST /tenancy`, `/health`, `/ready`, `/metrics`,
and every `/auth/*` route except `POST /auth/signinup/code/consume` and `POST /auth/signin`
(marked below) — password reset included, since a password login is global, not per store.

**Who can call it** (the *Auth* column):

| Label | Meaning |
|---|---|
| Public | Tenant header only. |
| Guest or buyer | A session for *this* store is used if present; otherwise the caller is treated as a guest (cart only). |
| Buyer | Any logged-in user of this store. Works on their own data only. |
| Admin | Logged in with role `admin` **for this store**. |
| Staff or admin | Role `admin` **or** `staff` (the packer). Staff is the limited role: it works the order queue and flips product availability, and nothing that touches money, prices, deletions, analytics or settings. |

**Sessions.** Cookies (`sAccessToken`, `sRefreshToken`, `sIdRefreshToken`), httpOnly, set by
login. Send `credentials: 'include'`. The access token carries `tenantId` and `role`, but on every
authenticated request the server also **re-reads the caller's account** and rejects the request
(403, `details.reason`) if:

| `details.reason` | Meaning |
|---|---|
| `WRONG_STORE` | The session was issued for a different store than `x-tenant-slug`. |
| `NO_ACCOUNT` | No account for this session in this store. |
| `ACCOUNT_DISABLED` | The account was disabled after login — effective immediately. |
| `SESSION_STALE` | The role changed since login (promoted or demoted); log in again. |

Routes that also work for guests (the cart) treat any of these as "a guest" instead of failing.
Access tokens last about 1 hour; on a `401 {"message":"unauthorised"}` call
`POST /auth/session/refresh` and retry.

**Errors.** Always JSON: `{ "error": { "code", "message", "details"?, "requestId" } }`.

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | A field is wrong. `details.issues` is `[{ location: "body"\|"params"\|"query", path, code, message }]` — every problem at once. Some services add `details.reason` (e.g. `EXCEEDS_MAX_PER_ORDER` with `max`). |
| 400 | `BAD_REQUEST` | The body is not valid JSON. |
| 401 | `UNAUTHORIZED` | Missing tenant header or platform key. |
| 403 | `FORBIDDEN` | Not allowed (`details.reason` as above, or insufficient role). |
| 404 | `NOT_FOUND` | Also for an unknown route. |
| 409 | `CONFLICT` | Already exists / state conflict. `details.reason` may be e.g. `NO_READY_PICTURE`, `OUT_OF_STOCK`, `FILE_NOT_UPLOADED`. |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 100 KB. |
| 429 | `TOO_MANY_REQUESTS` | Rate limited; see the `Retry-After` header (seconds) and `details.retryAfterSeconds`. |
| 500 | `INTERNAL_ERROR` | Our fault. Quote `requestId` when reporting it. |

SuperTokens' own 401s use `{ "message": "unauthorised" }`. Every response has an `x-request-id`
header (a well-formed one you send is kept); the same id is in the server logs.

**Rate limits** (per client IP unless noted): 300 requests/min overall; cart writes 60/min; asking
signing up 10 per 15 min; login attempts 30 per 15 min; asking for another verification email 10 per 15 min **and** 5 per hour per account;
requesting a password reset link 5 per 15 min **and** 3 per address per hour; submitting one
20 per 15 min.

**Pagination.** Every list that can grow answers a page: `{ items, nextCursor }`, with `?limit=` (1–100, default 30) and
`?cursor=` (the previous page's `nextCursor`; opaque, `null` on the last page). It is keyset paging, so a row inserted while
someone scrolls never repeats or skips one. A cursor that is not ours answers `400 BAD_CURSOR`. Paged lists: `GET
/catalog/products`, `GET /catalog/admin/products` (also `?q=` search), `GET /orders` (`?scope=active|past`), `GET /orders/admin/list`
(also `?q=`, `?filter=transfer`), and the fulfilment lists in section 9b. The numbers for filter chips come from their own
endpoints (`GET /orders/admin/counts`, `GET /catalog/admin/products-summary`), counted by the database, not from loaded pages.

**Data rules.** Money is integer **cents, USD**. Names are bilingual (`nameEs` required,
`nameEn` falls back to it). IDs are UUIDs. Soft-deleted rows never appear in responses.

---

## 1. Login — `/auth` (SuperTokens)

Everyone — buyers and staff — signs in with **email + password**. Add the header `rid: emailpassword`
(`rid: emailverification` for the verification calls) as the SuperTokens client does. Passwords:
at least 10 characters, one letter and one digit (a weak one is `400` with
`{status:"FIELD_ERROR", formFields:[{id:"password",error}]}`).

### POST `/auth/signup` — buyer: create an account (**needs `x-tenant-slug`**)
Body `{ formFields:[{id:"email",value},{id:"password",value},{id:"name",value},{id:"phone",value},{id:"locale",value}] }`.
`name` is required (≤255 chars); `phone` is optional (same loose format as a recipient phone); `locale` (`"es"` or `"en"`, optional, default `es`) is the language every email to this person is written in.
1. The tenant is resolved from the header (missing → 401, unknown/inactive → 404).
2. A login is created and a `users` row with role `buyer` **in this store**, holding `name`/`phone`.
3. A **verification email** is sent right away (logged instead, outside production — the log line
   `Email verification link (dev only, not emailed)` carries the link). A mail failure does not undo the signup.
4. A session is created (cookies set) — the new buyer is signed in.
Returns `{ status:"OK", user }`, or HTTP 200 `{ status:"FIELD_ERROR", formFields:[{id,error}] }` (e.g.
`email` "already exists"). Logins are global: an address that already has an account at another store
is "already exists" here too — that person signs in instead (next endpoint).

### POST `/auth/signin` — email + password (**needs `x-tenant-slug`**)
Body `{ formFields:[{id:"email",value},{id:"password",value}] }`. Checks the password. If the person
has no `users` row in *this* store yet (they signed up at another one) they become a **buyer** here.
A disabled (soft-deleted) account, like a wrong password, returns `{status:"WRONG_CREDENTIALS_ERROR"}`.
On success a session is created carrying `tenantId` and `role` (buyer, admin or courier); cookies are set.
Staff accounts (admin, courier) are created only by `npm run db:seed:admin` — there is no public staff
signup, and no 2FA yet (M5).

### Email verification — buyers confirm their address once
Verification is **not** needed to sign in, browse or fill a cart; it **is** needed to place an order
(`POST /orders/checkout` answers `403`, `details.reason: "EMAIL_NOT_VERIFIED"`). `GET /identity/me`
reports `emailVerified`.
- **POST `/auth/user/email/verify`** — body `{ method:"token", token, tenantId:"public" }` (the token is in
  the emailed link, which opens `<web>/account/verify-email?token=…&tenantId=public`). No session needed.
  `{status:"OK"}`, or HTTP 200 `{status:"EMAIL_VERIFICATION_INVALID_TOKEN_ERROR"}` for an expired/used token.
- **POST `/auth/user/email/verify/token`** — *needs the session.* Sends another link.
  `{status:"OK"}` or `{status:"EMAIL_ALREADY_VERIFIED_ERROR"}`. Rate-limited per account (5/hour).

### POST `/auth/user/password/reset/token` — request a reset link
*No tenant header* — a password login is global, and this only needs the address. Body
`{ formFields:[{id:"email",value}] }`. **Always answers `{status:"OK"}`**, whether or not that
address has an account — it cannot be used to discover who has one. If it does, an emailed link
(logged instead, outside production) carries a single-use token valid about an hour. Rate-limited
per address (5/hour) and per IP (5/15 min), since every call sends a real email.

### POST `/auth/user/password/reset` — submit the new password
Body `{ formFields:[{id:"password",value}], token }`. The password policy — at least 10
characters, one letter and one digit — is enforced here too (a weak one is `400` with
`{status:"FIELD_ERROR", formFields:[{id:"password",error}]}`, and the token is **not** consumed).
The token is single use; a reused or expired one is `{status:"RESET_PASSWORD_INVALID_TOKEN_ERROR"}`
(HTTP 200 — check `status`, not the HTTP code, same as every other SuperTokens flow status).
On success, **every existing session for that account is revoked** — a reset is exactly when
someone may be locking out a thief, so nothing survives it, including the session that requested
the reset if there was one. If revoking fails, this answers `500`: a password that changed while
old sessions might still work is treated as a failure, not a success with a footnote.

### POST `/auth/session/refresh` / POST `/auth/signout`
Standard SuperTokens: rotate the session tokens / end the session.

---

## 2. Tenancy — `/tenancy`

### POST `/tenancy` — create a store (platform operation)
*Auth: header `x-platform-key: <PLATFORM_API_KEY>`* — not a store admin. Until a platform-admin
role exists (M7) this is guarded by a shared secret compared in constant time; with
`PLATFORM_API_KEY` unset the endpoint is disabled (403). No tenant header. Body `{ slug (lowercase,
digits, hyphens), name, taglineEs?, taglineEn?, descriptionEs?, descriptionEn? }`. Returns the
new tenant (201); a slug already taken is **409**.

### GET `/tenancy/current` — the store's public page
*Public.* What the storefront header needs to tell one shop from another:
`{ slug, name, taglineEs, taglineEn, descriptionEs, descriptionEn, logo, freeDeliveryOverCents, sameDayCutoff, contact }` where
`logo` is a `PublicPicture` (see Media) or `null`, and `freeDeliveryOverCents` is the store's "free delivery
from $X" offer in cents (`null` = none). Nothing else internal (no id, other settings or timestamps).

### PATCH `/tenancy/current` — edit branding and switches (Admin)
Body, all optional: `{ name, taglineEs, taglineEn, descriptionEs, descriptionEn, settings:{
requireDeliveryPhoto, freeDeliveryOverCents, sameDayCutoff, contact:{ phone, email, address } } }`; `sameDayCutoff` is `"HH:MM"` Cuba time (shown to buyers, not enforced); There are no opening hours: orders can be placed at any time (the same-day cutoff only says which day delivery lands); `settings.freeDeliveryOverCents` is a whole number of cents (`null` switches the offer off). Orders whose subtotal reaches it ship free: `POST /orders/quote` and checkout waive the zone fee.
 `null` clears a nullable text field. Only the fields sent change, and
the fields are picked one by one — the slug and the active flag can never be edited here. Returns
the public page plus `settings`. The logo is set through Media (`ownerType:"tenant"`).

### GET `/tenancy/admin/settings` — read the switches (Admin)
`{ requireDeliveryPhoto: boolean, freeDeliveryOverCents: number | null }` (defaults `false` / `null`): whether a delivery needs a proof photo
before it can be marked delivered (used by fulfilment in M4).

## 3. Identity — `/identity`

### The team — `/identity/team` (admin only)

The people who work for the store: admin, staff (the packer) and courier. Buyers sign themselves up and never appear here.

**GET `/identity/team`** — everyone on the team, turned-off accounts included:
`[{ id, email, fullName, phone, role, active, createdAt }]`.

**POST `/identity/team`** — body `{ email, fullName, phone?, role: "admin"|"staff"|"courier", password? }`. Without
`password` a new person is emailed a link to choose their own (the SuperTokens password-reset link, valid about an
hour). With one (same rules as every password: 10+ characters, a letter and a digit) they can sign in at once and
no email is sent. Returns `201 { member, invited, emailFailed }`: `emailFailed` is true when the account was
created but the email could not be sent (use the endpoint below later). `409 ALREADY_A_MEMBER` if the email is
already on the team. An existing **buyer** of this store who is added keeps their account and history and is promoted;
anyone who already has a login (the same email is one login across stores) keeps their existing password and gets no
email. Rate limited to 20 per hour per IP.

**PATCH `/identity/team/:id`** — body `{ role?, active?, fullName?, phone? }` (at least one). Changing a role or
turning an account off or on **ends that person's sessions**, so it applies at once. `403 SELF_CHANGE` if you try to
change your own role or switch yourself off; `409 LAST_ADMIN` if it would leave the store with no active admin; a
buyer or someone from another store is a `404`.

**POST `/identity/team/:id/invite`** — sends the "choose your password" link again (`204`). 10 per hour per IP.

### GET `/identity/me` — who am I
*Auth: any logged-in user.* Returns `{ id, email, role, fullName, phone, locale, emailVerified }`: `id` is our internal user id (used by
every other module); `fullName`/`phone` are what the buyer gave at signup (null for staff and older accounts). Read fresh from the database on this request, so it reflects the account's
current role and disabled state, not the token's.

### PATCH `/identity/me` — change my own details
*Auth: any logged-in user.* Body: any of `{ locale: "es" | "en", fullName, phone }` (at least one) → `{ locale, fullName, phone, profileComplete }`. The web app calls it when a signed-in buyer switches the site's language (so the emails follow), and from the "one last step" screen after a Google sign-up, which brings a name but never a phone.
`GET /identity/me` also returns `profileComplete`: false for a buyer with no name or no phone (staff are always complete); the checkout sends such a buyer to complete it first.

### Sign in with Google — `/auth/authorisationurl`, `/auth/signinup` (only when the API has the Google keys)
SuperTokens' ThirdParty recipe. `GET /auth/authorisationurl?thirdPartyId=google&redirectURIOnProviderDashboard=<callback>` (headers `rid: thirdparty`, `x-tenant-slug`) → `{ status, urlWithQueryParams, pkceCodeVerifier }`;
the web app adds its own `state`, sends the person to Google, and Google returns to `/auth/callback/google`. `POST /auth/signinup` (same headers) with `{ thirdPartyId: "google", redirectURIInfo: { redirectURIOnProviderDashboard, redirectURIQueryParams, pkceCodeVerifier } }` opens the session cookie.
Refusals (HTTP 403, `details.reason`): `EMAIL_NOT_VERIFIED` (Google did not confirm the address), `STAFF_USE_PASSWORD` (admin / packer / courier never use Google), `EMAIL_HAS_PASSWORD_ACCOUNT` (that email already registered with a password: one email, one account per store); a disabled account is refused too.
The password signup, in turn, answers the usual "email already exists" field error for an email that signed up with Google.

---

## 4. Catalog — `/catalog`

### Storefront (public)

**GET `/catalog/categories`** — the store's active categories, in the admin's order:
`[{ id, nameEs, nameEn }]`.

**GET `/catalog/products?categoryId=`** — the shop window. Returns only **active** products (a
product is active only if it has a ready picture), ordered by the admin's sort order, optionally
filtered by category. Each item: `id, slug, categoryId, nameEs/En, descriptionEs/En,
priceCents, unitLabel, stockStatus (available|limited|out), maxPerOrder, cover`. `cover` is the
chosen cover picture, or the first ready one, as
`{ id, thumbUrl, cardUrl, fullUrl, width, height, altTextEs/En, isCover }` — URLs the browser can
load directly. Only the resized WebP versions are exposed, never the original file or storage keys. `out`-of-stock products are still listed (the UI
should show them as unavailable).

**GET `/catalog/products/:slug`** — product page. Same fields plus `pictures[]` (all ready
pictures, cover first). Drafts, deactivated, deleted or other-store products return 404.

### Admin — categories

**GET `/catalog/admin/categories`** *(Staff or admin)* — every non-deleted category, including inactive ones. Each has `icon`: a glyph name the storefront draws on the category chip, one of `cup-soda, beef, milk, apple, candy, fish, wheat, egg, sandwich, shopping-basket, leaf, utensils`, or `null`. The public `GET /catalog/categories` returns it too.

**POST `/catalog/categories`** — body `{ nameEs, nameEn?, icon?, active? }`. Appends to the end of the
order. `nameEn` defaults to `nameEs`.

**PATCH `/catalog/categories/:id`** — partial update of the same fields. `active:false` hides
the category from `GET /catalog/categories` (its products still appear in the unfiltered product
list).

**DELETE `/catalog/categories/:id`** — soft delete. Every product must have a category, so a category that still has
products is refused: `409 CONFLICT` with `details: { reason: "CATEGORY_IN_USE", productCount }`. Move or delete those
products first. 404 if already gone.

**PUT `/catalog/categories/order`** — body `{ ids:[…] }`. The i-th id gets position i. Every id
must exist (else 400 and nothing is applied). Send the **full** list — see the review notes.

### Admin — products

**GET `/catalog/admin/products?categoryId=&active=`** *(Staff or admin; `/admin/products/:id`, `PATCH /catalog/products/:id` and `…/activate|deactivate` too — but a `staff` PATCH may carry only `stockStatus`, anything else is `403 STAFF_FIELDS`)* — all non-deleted products, drafts
included; `active=true|false` filters.

**GET `/catalog/admin/products/:id`** — one product (any state).

**POST `/catalog/products`** — create a **draft**. Body `{ nameEs, nameEn?, descriptionEs?,
descriptionEn?, categoryId (required), priceCents (integer > 0), unitLabel, stockStatus?, maxPerOrder?,
slug? }`. Workflow: `categoryId` is required (every product has one) and must be a category **of this store** (a database
FK would accept another store's id, so the service looks it up first) → slug is taken from the
body or generated from `nameEs` (accents stripped, `-2`, `-3` on collision; an explicit duplicate
is a 409) → appended to the sort order → saved with `active=false`.

**PATCH `/catalog/products/:id`** — partial update of any of those fields (`null` clears a
nullable one). `active` cannot be set here. Changing `slug` re-checks uniqueness. An empty body
is a no-op.

**POST `/catalog/products/:id/activate`** — makes it visible. **Rule:** it must have at least
one `ready` picture; otherwise 409. Already active → returns it unchanged.

**POST `/catalog/products/:id/deactivate`** — back to draft (hidden, kept).

**DELETE `/catalog/products/:id`** — soft delete; forces it inactive and frees its slug.

**PUT `/catalog/products/order`** — same contract as the categories reorder.

**Background rule:** deleting a product's last ready picture (`DELETE /media/:id`) emits
`media.deleted`; the worker process then deactivates that product automatically.

---

## 5. Media — `/media`

Pictures for products, users (profile), deliveries (proof photos) and the store (logo). One
table, `owner_type` + `owner_id`. Uploads go **directly from the browser to MinIO**; the API
only issues the permission and does the processing.

**Two kinds of file.** The *original* the browser uploads stays private (never served). The
worker makes three *derivatives* — thumb 300 px, card 800 px, full 1600 px WebP (never
enlarged, orientation applied, metadata such as GPS stripped) — under the bucket's `public/`
prefix, which is anonymously readable and cached for a year. The API only ever hands out
derivative **URLs**, never storage keys or the original.

**Permissions by owner type** (used by every endpoint below except the public list): `product` →
admin; `tenant` (the store logo; `ownerId` must be the store's own id) → admin; `delivery` →
admin, staff or courier (the owner id is the **order** id); `payment_proof` (a buyer's screenshot of a manual transfer; owner id = the order id) → admin or staff, or the buyer of that order (404 for any other buyer), never a courier; `user` → only that user. The role is re-read from the database on each request.

**Shapes.** `PublicPicture = { id, thumbUrl, cardUrl, fullUrl, width, height, altTextEs,
altTextEn, isCover }` (ready pictures only). `MediaView = { id, ownerType, ownerId, status
("pending"|"ready"|"failed"), isCover, sortOrder, altTextEs, altTextEn, width, height, thumbUrl,
cardUrl, fullUrl, createdAt }` — the URLs are `null` until it is ready.

### POST `/media/upload-url` — step 1: get permission to upload
Body `{ ownerType, ownerId, contentType }`, `contentType` one of `image/jpeg`, `image/png`,
`image/webp`, `image/avif` (anything else is a 400). There is **no filename**: the storage key is
built only from ids and a fixed extension. Checks the permission above, then signs a presigned
**POST policy** valid 10 minutes that MinIO itself enforces: exactly that content type, and a size
between 1 byte and **10 MB**. Inserts a `pending` row. Returns
`{ mediaId, url, method:"POST", fields:{…}, maxBytes, expiresInSeconds }` (201).

### (client) POST the file to `url`
A `multipart/form-data` POST straight to MinIO, not through the API: append every entry of
`fields` first, in order, and the file **last** under the name `file`. Success is HTTP 204. A file
that is too big or of another type is refused by MinIO. If the connection drops, POST again with
the same form until it expires; then request a new permission. (Progress works with XHR upload
events.)

### POST `/media/:id/confirm` — step 2: "the file is uploaded"
Checks permission against the row's real owner and that the **file is actually in storage** (else
409 `{reason:"FILE_NOT_UPLOADED"}` — nothing is queued). Then queues processing and returns the
`MediaView` (`pending`). The **worker** decodes it and writes the three derivatives, then marks
the row `ready`. If the bytes are not a usable image (or vanished from storage) it marks `failed`
at once — retrying could not help. If storage or the database hiccups it retries with backoff
(5 attempts) and marks `failed` only when they are exhausted. Safe to call again: a `ready`
picture is returned untouched; a `failed` one gets another attempt.

### GET `/media/:id` — one picture's state
`MediaView`; what an upload screen polls after confirming.

### GET `/media/manage?ownerType=&ownerId=` — every picture of an owner, in every state
`MediaView[]` in `sortOrder`, including `pending` and `failed`. Permission as above. This is the
only way to see non-public pictures (profile photos, delivery proof).

### PATCH `/media/:id` — alt text
Body `{ altTextEs?, altTextEn? }` (≤ 255 chars; `null` clears). Returns the `MediaView`.

### PUT `/media/order` — reorder an owner's pictures
Body `{ ownerType, ownerId, ids:[…] }`. The i-th id gets position i; every id must be one of that
owner's pictures (else 400, nothing changes). Returns the new `MediaView[]`.

### POST `/media/:id/cover` — choose the cover picture
Body `{ ownerType, ownerId }`. The picture must belong to that owner and be `ready`. Clears the
owner's previous cover and sets this one in one transaction (a database index guarantees one
cover per owner). 204.

### DELETE `/media/:id` — remove a picture
Soft delete, emits `media.deleted` (see Catalog: may deactivate a product), and removes the
original and derivatives from storage (best-effort: a storage failure is logged, not returned).
204.

### GET `/media?ownerType=&ownerId=` — a picture set for the storefront
**Public**, and only for `ownerType` = `product` or `tenant` (`user` and `delivery` are 400 — those
are private). Ready pictures only, cover first, as `PublicPicture[]`.

### Background housekeeping (worker process, every 6 h)
Uploads that were requested but never completed (older than 24 h) are discarded with whatever
bytes arrived, and guest carts untouched for 30 days are deleted, store by store.

---

## 6. Geo — `/geo`

### Reference data (global, cacheable 24 h, no tenant header)

**GET `/geo/provinces`** — Cuba's 16 provinces (incl. Isla de la Juventud) A→Z.

**GET `/geo/provinces/:id/municipalities`** — that province's municipalities A→Z (168 in
total). 404 for an unknown province. Used by the address form's two dependent selects.

### Delivery zones (per store) — which municipalities it serves, at what flat fee

**GET `/geo/delivery-zones`** — public. Active zones:
`{ id, municipalityId, feeCents, active, municipality:{nameEs,nameEn}, province:{id,nameEs,nameEn} }`,
ordered province → municipality. The storefront shows "we deliver to…" from this.

**GET `/geo/admin/delivery-zones`** — admin. Same, including inactive zones.

**POST `/geo/delivery-zones`** — admin. Body `{ municipalityId, feeCents (≥0), active? }`. The
municipality must exist (404) and must not already have a zone in this store (409). `feeCents: 0`
means free delivery there.

**PATCH `/geo/delivery-zones/:id`** — admin. Change `feeCents` and/or `active`. Zones are
deactivated, never deleted, because orders keep pointing at the zone they were priced against.

---

## 7. Cart — `/cart`

The buyer builds their combo here. Works for guests and buyers. Identify a **guest** with the
header `x-cart-token` (a 64-char hex string the server hands out). A signed-in buyer's cart is
found by their session; if both are sent, the buyer's cart wins.

**Every response is the same `CartView`**, recomputed from live catalog data — the client's
copy of prices is never trusted:

```
{ guestToken?,            // only in the response that created a guest cart
  items:[{ productId, quantity, lineTotalCents,
           issue: null | "UNAVAILABLE" | "OUT_OF_STOCK" | "EXCEEDS_MAX_PER_ORDER",
           product: { slug, nameEs, nameEn, unitLabel, unitPriceCents,
                      stockStatus, maxPerOrder, picture:{thumbUrl,cardUrl}|null } | null }],
  itemCount, currency:"USD",
  subtotalCents,          // sum of lines that can be bought right now
  checkoutReady }         // items.length>0 and no line has an issue
```
`issue` is `UNAVAILABLE` when the product was hidden or deleted (`product` is `null` if deleted),
`OUT_OF_STOCK` when marked `out`, `EXCEEDS_MAX_PER_ORDER` when the admin later lowered the limit.
Flagged lines are kept, contribute 0 to the subtotal, and block `checkoutReady`.

**GET `/cart`** — current cart. Never creates one (a visitor who only browses leaves no rows).
Empty cart if there is none.

**POST `/cart/items`** — body `{ productId, quantity (1–99, default 1) }`. Product must be
active (404) and not out of stock (409). Adds to the existing line (quantity is **summed** on
re-add); the total for the line may not exceed `min(99, maxPerOrder)` (400). A guest with no
token, or an unrecognised/expired one, gets a **new** cart and a new `guestToken` in the
response (the server never accepts a client-chosen token) — store it and send it back as
`x-cart-token`. Returns 201.

**PATCH `/cart/items/:productId`** — body `{ quantity (1–99) }`. Sets (not adds) the quantity;
404 if the product isn't in the cart; limit-checked against `maxPerOrder` for live products.

**DELETE `/cart/items/:productId`** — removes the line. Idempotent (no error if absent).

**DELETE `/cart`** — removes all lines; the cart itself stays.

**POST `/cart/merge`** — body `{ items:[{ productId, quantity }] }` (max 100, no repeats). The
client sends its locally persisted cart on page load and after login (CLAUDE.md §7). For each
product the server keeps the **larger** of its own and the incoming quantity — not the sum — so
calling it repeatedly changes nothing. Items that are hidden, deleted, unknown or out of stock
are skipped; quantities are clamped to `maxPerOrder`. If the caller is a signed-in buyer who also
sends their old `x-cart-token`, that guest cart is folded in the same way and then deleted (its
token stops working). A guest with no cart gets one created (token returned). Always returns the
server's authoritative `CartView`.

---

## 8. Address book — `/recipients`

Recipients are the people in Cuba a buyer sends to; each has addresses. Everything here belongs
to the calling **buyer** — another buyer of the same store cannot see, edit or delete it (404),
and neither can another store. Lives in the `orders` module but is mounted at `/recipients`.

Shapes: `Recipient = { id, fullName, phone1, phone2|null, addresses:[Address] }`,
`Address = { id, label, isDefault, provinceId, municipalityId, street, betweenStreets,
buildingApartment, referencePoints, lat, lng }` (lat/lng are numbers or null). Phones: 7–20 chars
of digits, spaces, `()`, `-`, optional leading `+`. Addresses list the default first.

**GET `/recipients`** — the caller's recipients with addresses, A→Z by name.

**POST `/recipients`** — body `{ fullName, phone1, phone2?, address? }`. If `address` is included
it is created in the same transaction and becomes the recipient's default. Its province and
municipality must exist **and match** (a municipality from another province → 400). Returns 201.

**GET `/recipients/:id`** — one recipient.

**PATCH `/recipients/:id`** — `{ fullName?, phone1?, phone2? }`; `phone2: null` clears it.

**DELETE `/recipients/:id`** — soft delete of the recipient and all its addresses (past orders
keep pointing at them).

**POST `/recipients/:id/addresses`** — body: `provinceId, municipalityId, street` required;
`label, betweenStreets, buildingApartment, referencePoints, lat+lng` optional, `isDefault?`.
Location pair is validated. The first address is always the default; `isDefault:true` moves the
default (the previous default is cleared in the same transaction — one default per recipient is
also enforced by a database index). `lat` and `lng` must be given together (Leaflet/OSM pin).

**PATCH `/recipients/:id/addresses/:addressId`** — partial update. If either province or
municipality changes, the *resulting* pair is re-validated. `isDefault` cannot be changed here.

**POST `/recipients/:id/addresses/:addressId/default`** — make it the default; returns the
recipient.

**DELETE `/recipients/:id/addresses/:addressId`** — soft delete; if it was the default, the
oldest remaining address becomes the default.

---

## 9. Orders and checkout — `/orders`

### POST `/orders/quote` — price a checkout (Buyer)
Body `{ recipientId, addressId }` (both must be the caller's own). Read-only: nothing is reserved
or created. It takes the buyer's cart **as it is right now** and adds the flat fee of the delivery
zone that covers the address's municipality (CLAUDE.md §10: total = subtotal + zone fee). Returns:

```
{ cart: CartView,                     // the same authoritative cart as GET /cart
  delivery: { id, municipalityId, feeCents, active, municipality, province } | null,
  subtotalCents, deliveryFeeCents, totalCents, currency: "USD",
  canCheckout: boolean,
  blockers: ("EMPTY_CART" | "CART_HAS_ISSUES" | "NO_DELIVERY_ZONE")[] }
```
`blockers` is why a checkout cannot go ahead, so the UI can explain instead of only disabling a
button. 404 if the recipient or address is not the caller's.

**Shapes.** `Order = { id, orderNumber, status, recipientNameSnapshot, recipientPhonesSnapshot,
addressSnapshot, giftMessage, buyerNotes, currency, subtotalCents, deliveryFeeCents, totalCents,
placedAt, paidAt, deliveredAt, cancelledAt }`. `OrderDetail = Order & { items: [{ productId,
productNameEs, unitLabel, unitPriceCents, quantity, lineTotalCents }] }` — everything here is a
**frozen snapshot** taken at checkout; editing the product or the address book afterwards never
changes a past order (CLAUDE.md §5).

### POST `/orders/checkout` — place the order (Buyer, **email confirmed**)
An unconfirmed buyer gets `403` with `details.reason: "EMAIL_NOT_VERIFIED"`.
Body `{ recipientId, addressId, provider: "tropipay"|"manual", idempotencyKey?, giftMessage?, buyerNotes? }`. `idempotencyKey` (8–64 letters, digits, `-`, `_`; the web app sends a fresh one per attempt) makes a double click or a retry after a dropped connection return the order already created (same body, 200) instead of placing a second one. Re-runs
the same pricing as `/quote`; `409` with the same `blockers` shape if it still can't go ahead.
On success (201): creates the order in **`pending_payment`**, snapshots every cart line into
`order_items`, creates a matching `pending` payment row, and clears the buyer's cart — then calls
the chosen provider to start a checkout session. Returns
`{ order: OrderDetail, checkoutUrl: string | null }`. `checkoutUrl` is `null` for `manual` (there is
nothing to redirect to — show the buyer payment instructions instead) and also `null` if the
provider call itself failed (network blip, provider outage) — the order still exists either way;
retry with the endpoint below. The order number is `FC-1001`, `FC-1002`, … — generated by the server,
sequential **per store** (each store counts from 1001), unique, never reused. Show it as `#FC-1001`.

### GET `/orders?scope=active|past` — the buyer's own orders (Buyer)
A page of `Order`, newest first (`active` = still moving, `past` = delivered, cancelled or refunded).

### Sharing an order's products — `/orders/:id/share` and `/shared/:token`
After placing an order the buyer can hand someone a link; whoever opens it sees **the list of products only** (never the recipient, address,
phones, photos, order number or what was paid) and can put them in their own cart.

- **GET `/orders/:id/share`** *(the order's buyer; 404 for anyone else)* → `{ token: string | null }`.
- **POST `/orders/:id/share`** → `{ token }`. Idempotent: sharing again returns the same link. The token is 256 random bits (43 base64url
  characters); the web app builds the URL `/<locale>/shared/<token>`.
- **DELETE `/orders/:id/share`** → 204. The link dies at once; sharing again makes a *different* one.
- **GET `/shared/:token`** *(public, needs `x-tenant-slug`; a session is optional)* → `{ items: [{ productId, nameEs, nameEn, unitLabel, quantity,
  priceCents, available }], orderId, orderNumber }`. `priceCents`/`available` are **today's** (a deleted product has `productId: null`,
  `priceCents: null`, `available: false`); the cart reprices again anyway. `orderId`/`orderNumber` are non-null **only for a signed-in
  admin or staff**, so the web app can send them to that order in the admin (`/admin/orders?order=<id>`). An unknown, malformed or revoked
  token is `404`; a malformed one never reaches the database. Rate-limited per IP (60/min) on top of the global limit.
- To buy the products the visitor sends them to `POST /cart/merge` (a guest cart works).

### GET `/orders/:id` — one order, with its line items (Buyer)
`OrderDetail`. 404 for another buyer's order.

### POST `/orders/:id/retry-payment` — try starting the checkout session again (Buyer)
Only for an order still in `pending_payment`. Returns `{ checkoutUrl: string | null }`.

### POST `/orders/:id/cancel` — buyer cancels (Buyer)
Body `{ note? }` (or no body at all). **Only while `pending_payment`** — once money has moved,
undoing it is a refund (admin-only), not a cancel; `409 ILLEGAL_TRANSITION` otherwise.

### Admin
`GET /orders/admin/list?status=` · `GET /orders/admin/:id` *(Staff or admin)* — the order shapes above, any buyer's
order in the store, plus `buyer: { fullName, email } | null` on both and `itemCount` (units in the box) on the list.

`POST /orders/admin/:id/mark-paid` — body `{ note? }`. A manual override ("I can see in my
TropiPay dashboard/bank that this was paid") for **any** provider, not only `manual` — covers a
missed webhook. Flips the payment row alongside the order, in one transaction.

`POST /orders/admin/:id/preparing` *(Staff or admin)* — `paid` → `preparing`.

`POST /orders/admin/:id/out-for-delivery` *(Staff or admin)* — `preparing` → `out_for_delivery`.

`POST /orders/admin/:id/delivered` *(Staff or admin)* — `out_for_delivery` → `delivered`. If the store requires a
delivery photo (`settings.requireDeliveryPhoto`) this answers `409 DELIVERY_PHOTO_REQUIRED`; use
`POST /fulfilment/orders/:orderId/deliver` (section 9b), which records the proof. Without the setting this plain
endpoint still works but records no proof.

`GET /orders/admin/stats?range=week|month|year` *(Admin only)* — sales figures. A sale counts from the moment an
order is paid until it is refunded or cancelled, dated by when it was **paid**, in Cuba time. `week` = the last 7
days, `month` = 30, `year` = 12 calendar months (each including today / this month). Returns:
`{ range, currency, granularity: "day"|"month", current, previous, series, byMunicipality, topProducts }` where
`current`/`previous` (the equal-length period right before) are `{ orders, totalCents, averageTicketCents,
freeDeliveryShare }` (share 0–1); `series` is one `{ bucket, totalCents, orders }` per day (or month), oldest first,
empty buckets included; `byMunicipality` is `[{ provinceId, municipalityId, orders }]` busiest first; `topProducts`
is the best five by units: `[{ productId, nameEs, nameEn, quantity, totalCents }]`.

`POST /orders/admin/:id/cancel` — admin override of the buyer's own cancel rule (still only from
`pending_payment`).

`POST /orders/admin/:id/refund` — body `{ note? }`. Full refund only, always the order's own
total. Calls the provider **before** writing anything; a provider-side rejection leaves the order
untouched. On success: payment → `refunded`, order → `refunded` (from any state that allows it —
see CLAUDE.md §6's transition table).

**Every transition is illegal-transition-checked and idempotent.** An order already at the target
status is returned unchanged (200), not an error — a retried webhook or admin click is a no-op,
not a failure. An actually-illegal move (e.g. `preparing` an order still `pending_payment`) is
`409` with `details: { reason: "ILLEGAL_TRANSITION", from, to, allowed }`.

---

## 9b. Fulfilment — `/fulfilment` (dispatch, proof of delivery)

Delivery photos are ordinary media: `POST /media/upload-url` with `ownerType: "delivery"` and `ownerId` = the
**order id**, upload, confirm, as in section 5. Then record the hand-over:

**POST `/fulfilment/orders/:orderId/deliver`** *(Admin, staff or courier)* — body `{ recipientName, notes? }`
(`recipientName` required, up to 255 chars). The order must be `out_for_delivery` (else `409
ILLEGAL_TRANSITION`). If the store requires a photo and the order has no **ready** photo yet: `409
DELIVERY_PHOTO_REQUIRED`. On success it saves who received it, moves the order to `delivered` and returns the proof
(below). Idempotent: repeating it for an already-delivered order returns the recorded proof unchanged, so a courier
retrying after a dropped connection is safe.

**GET `/fulfilment/orders/:orderId/proof`** *(any signed-in user; a buyer only for their own order, else 404)* —
`{ orderId, recipientName, notes, deliveredAt, photos: [{ id, thumbUrl, cardUrl, fullUrl }] } | null` (null = none
recorded). Only photos that finished processing are listed.

### Dispatch (courier assignment)

An assignment gives one order to one courier. Its status moves `assigned` → `accepted` → `picked_up` → `delivered`; it can end
as `declined` (the courier says no), `failed` (could not hand it over) or `released` (the store took it back or gave the order
to someone else). **Open** = assigned, accepted or picked up; at most one open assignment per order (database-enforced), and
closed ones stay as the order's history. Only orders that are `paid`, `preparing` or `out_for_delivery` can be assigned
(else `409 ORDER_NOT_DISPATCHABLE`). Every step is written to the audit log (`delivery.assigned`, `.reassigned`, `.released`,
`.accepted`, `.declined`, `.picked_up`, `.failed`). Couriers are team members with the `courier` role; a `couriers` row (phone,
workload) is created the first time one is listed.

*The store (admin, staff):*

- **GET `/fulfilment/couriers`** — `[{ id, name, phone, open, delivered }]`; `id` is the courier id that assigning takes.
- **GET `/fulfilment/board?lane=unassigned|assigned|problems&cursor&limit`** — a page (`{ items, nextCursor }`, section 0) of orders in
  that lane, each in the admin list shape plus `assignment` (the latest one, or null). `problems` = the last attempt was declined or
  failed and nobody has the order now.
- **GET `/fulfilment/orders/:orderId/assignment`** — `{ current, history }` (newest first).
- **PUT `/fulfilment/orders/:orderId/assignment`** — body `{ courierId }`. Gives the order to that courier, or moves it (the previous
  assignment is closed as `released`). Asking again for the courier who already has it changes nothing. 404 for an unknown or
  inactive courier.
- **DELETE `/fulfilment/orders/:orderId/assignment`** — takes it back (204; 404 when nobody has it).

*The courier (role `courier`; each call is checked against the caller, so another courier's assignment answers `403 NOT_YOUR_DELIVERY`):*

- **GET `/fulfilment/my-deliveries?cursor&limit`** *(admin, staff or courier)* — a page of the caller's open deliveries; the owner and the
  packer see everything that is out. For a **courier** the payer's details are left out (`buyer` is `null`, `transferReported` is
  `false`): handing over a box needs the recipient, not who paid.
- **POST `/fulfilment/assignments/:id/accept`**, **`/decline`** (body `{ note? }`), **`/pickup`**, **`/failed`** (body
  `{ reason: recipient_absent|wrong_address|refused|unreachable|other, note? }`). Each is idempotent for its own target status and
  otherwise answers `409 ILLEGAL_ASSIGNMENT_STEP`. `pickup` needs the order to be `preparing` (a paid-only order answers `409
  ORDER_NOT_READY`) and moves it to `out_for_delivery`; `failed` leaves the order on the road for the store to decide.
- **POST `/fulfilment/orders/:orderId/deliver`** (above): a courier can only deliver an order whose open assignment is theirs;
  the assignment closes as `delivered` and `deliveries.courier_id` records who. The owner and the packer can still deliver any order.

The old `GET /fulfilment/queue` is gone; `my-deliveries` replaces it.

**Order emails.** Every email is branded (the store's name, one teal button, the store's contact in the footer), has an HTML and a plain-text
version, and is written in **one language: the buyer's own** (`users.locale`; Spanish unless they chose English at signup or later). The buyer
gets one when the order is **placed** (with the receipt), **paid**, **on its way**, **delivered** (links to the proof), **cancelled** (says so
when it timed out unpaid), **refunded**, and a **reminder** 48 h in if it is still unpaid and no transfer was reported (one only, a day before the
72 h auto-cancel). The email-verification and password-reset emails use the same template and language. All are sent by the worker from the
`order.status_changed` event (orders emits it only when the status really changed, with `cause: "unpaid"` for the timeout) and the `order.payment_reminder`
event. The store's own "transfer to check" alert is in Spanish. Outside production nothing is emailed and the event is logged instead.
`npm run emails:preview` renders every email in both languages into `email-previews/` for a look in the browser.

---

## 9c. Manual transfer — Zelle, Cash App, PayPal

A buyer can pay an order by sending money from their own Zelle / Cash App / PayPal app. There is **no integration**
with any of them (no SDK, no API, no webhook): we only show the instructions and a link that opens the app, and a
person at the store checks the store's own account and marks the order paid. Accounts come from the environment
(`ZELLE_EMAIL`, `CASHAPP_EMAIL` / `CASHAPP_CASHTAG`, `PAYPAL_EMAIL` / `PAYPAL_ME_HANDLE`, optional
`MANUAL_PAYEE_NAME`); a method is offered only when its account is set. With a Cash App cashtag or a paypal.me handle
the link opens the app **with the amount already filled in**; without one it only opens the app and the buyer types the
amount. Zelle has no public link at all (it lives inside the buyer's bank app), so it is instructions only.

**GET `/payments/methods`** — public. `{ card: true, manual: [{ id, kind: "zelle"|"cashapp"|"paypal"|"other", label }] }`:
the store's active payment methods, in the owner's order. The checkout offers the transfer choice only when `manual`
is not empty. No account details here.

**Payment methods, managed by the owner** *(admin only)*. A store with no methods yet gets the accounts from the old
environment variables once, as rows, the first time they are listed.
- **GET `/payments/admin/methods`** — every method that is not deleted, hidden ones included: `[{ id, kind, label,
  recipient, handle, linkTemplate, payeeName, instructionsEs, instructionsEn, sortOrder, active }]`.
- **POST `/payments/methods`** — `{ kind, label, recipient, handle?, linkTemplate?, payeeName?, instructionsEs?,
  instructionsEn?, active? }`. `handle` is a cashtag (a leading `$` is dropped) or paypal.me name: letters, digits, `. _ -`.
  `linkTemplate` (for `other`) must be an **https** link with no spaces; `{amount}` becomes `55.50` and `{recipient}` the
  URL-encoded account. Blank optional fields mean "none". 201.
- **PATCH `/payments/methods/:id`** — any of those fields; `null` clears an optional one. **PUT `/payments/methods/order`**
  `{ ids }` sets the order (every id must be the store's, else 400). **DELETE `/payments/methods/:id`** — soft delete (204);
  a transfer already reported keeps the method's name.

**POST `/orders/checkout`** with `provider: "manual"` creates the order as `pending_payment` with no redirect
(`checkoutUrl: null`).

**GET `/orders/:id/payment-instructions`** *(the buyer of the order)* — `null` for a card order, otherwise
`{ orderId, orderNumber, status, amountCents, currency, reference, methods: [{ id, kind, label, recipient, payeeName,
instructionsEs, instructionsEn, link, amountInLink }], report }`. `reference` is the order number, to be written in the transfer's note. `report` is
the latest thing the buyer reported (below) or `null`.

**POST `/orders/:id/transfer-report`** *(the buyer of the order)* — "I sent it". Body `{ methodId, transferReference
(3–100 chars), notes? }`. A screenshot must already exist: upload it through the media flow with `ownerType:
"payment_proof"` and `ownerId` = the order id (a failed upload does not count) or it answers `409
SCREENSHOT_REQUIRED`. `409 NOT_PENDING_PAYMENT` once the order is no longer waiting for payment; `400 UNKNOWN_PAYMENT_METHOD` for a method the
store does not accept (or has hidden or deleted). May be sent again to correct it: the latest report wins. Returns the instructions. It is
**evidence for the admin, not a payment**: the order stays `pending_payment`. (Stored as a `transfer_reported`
event on the payment, so there is no extra table.)

**Admin side.** `GET /orders/admin/list` rows carry `transferReported` (an unpaid order with a report waiting to be
checked); `GET /orders/admin/:id` carries `paymentProvider` and `paymentReport`
(`{ method, transferReference, notes, reportedAt }`). The screenshots are read with `GET
/media/manage?ownerType=payment_proof&ownerId=<orderId>`. After checking the store's account, an admin calls the
existing `POST /orders/admin/:id/mark-paid` (admins only; staff never touch money). An unpaid order is still
auto-cancelled after 72 h.

---

## 9d. Notifications — `/notifications` (the in-app bell)

Everyone signed in has their own feed; every call is scoped to the caller (there is no way to read or change someone else's). An entry says
**what happened** (`kind`, the order, a few facts in `data`); the web app writes the sentence in the reader's language.

- **GET `/notifications?cursor&limit&unread=true`** → a page (`{ items, nextCursor }`, newest first) of `{ id, kind, orderId, orderNumber, data, read, createdAt }`.
- **GET `/notifications/unread-count`** → `{ count }` (the number on the bell, polled every 30 s).
- **POST `/notifications/read`** → 204. Body `{ ids: [...] }` (1–100) or `{ all: true }`; only the caller's own entries change.

Who is told what (created by the worker from the events orders and fulfilment emit; the same announcement never tells a person twice, even if the
job is retried): the **store** (admins and the packer) hears `new_order`, `order_paid`, `transfer_reported`, `order_delivered`, `order_cancelled`
and what each courier does (`delivery_accepted`, `_picked_up`, `_declined`, `_failed`); a **courier** hears `delivery_assigned` / `delivery_released` for
their own orders; a **buyer** hears `buyer_paid`, `_on_the_way`, `_delivered`, `_cancelled`, `_refunded`. **Admins are also emailed** (Spanish) for a new order,
a delivery, a courier who declined and a delivery that failed. Entries older than 60 days are deleted by the worker's periodic pass. The bell works
without any email setup, and a stopped or misconfigured mail provider never costs anyone an entry — but the **worker process must be running** (it creates them).

## 10. Payment webhooks — `/payments`

### POST `/payments/webhooks/:provider`
**Not a client-facing endpoint** — called by the payment provider's own servers, not by the app.
No `x-tenant-slug` (a provider doesn't know it); the tenant is recovered from a reference embedded
in the checkout session instead (CLAUDE.md §6). Signature-verified before anything is trusted;
idempotent on the provider's own event id; never trusts the reported amount over what the order
was actually priced at. `:provider` must be `tropipay` or `manual` (404 otherwise) — `manual` has
no real webhook handler and always answers 409, since manual-transfer status only ever changes via
the admin `mark-paid`/`refund` actions above. Always 200 once verified, whatever happened next (a
duplicate or a mismatch is logged and acknowledged, not retried).

---

## 11. Ops

**GET `/health`** — `{status:"ok"}`; liveness only, touches nothing.

**GET `/ready`** — readiness: checks Postgres, Redis and MinIO (2 s each). 200
`{status:"ok", checks:{postgres,redis,minio}}` or **503** `{status:"unavailable", checks:{…}}`
naming what is down. Use this, not `/health`, before sending traffic to a new release.

**GET `/metrics`** — Prometheus metrics, labelled by route pattern (`/catalog/products/:slug`),
never by raw URL. Needs `Authorization: Bearer <METRICS_TOKEN>` when that is configured; in
production it is **off** unless a token is set; in development it is open.

---

## Typical journeys

**Buyer, first order.** `GET /tenancy/current` (store header) → `GET /catalog/products` →
`GET /catalog/products/:slug` → `POST /cart/items` (guest; keep `guestToken`) → keep shopping with
`x-cart-token` → `POST /auth/signinup/code` + `/consume` to log in → `POST /cart/merge` with the
old token (guest cart absorbed) → `GET /geo/provinces` → `…/municipalities` → `POST /recipients`
with an address → `POST /orders/quote` (total with delivery) → `POST /orders/checkout` → if
`checkoutUrl` is set, send the buyer there to pay; if `null` and the provider is `manual`, show
payment instructions; if `null` for any other reason, `POST /orders/:id/retry-payment` → the
provider's webhook (or an admin's `mark-paid`) moves the order to `paid` → `GET /orders/:id` to
show the buyer their receipt.

**Admin, fulfilling an order.** `GET /orders/admin/list?status=paid` → `POST
/orders/admin/:id/preparing` → give it to a courier (`PUT /fulfilment/orders/:orderId/assignment`) → the courier accepts, picks up (`…/out-for-delivery`) and hands over: upload the photo (media, owner type `delivery`, owner id = the order) → `POST /fulfilment/orders/:orderId/deliver`.
If a buyer asks for their money back: `POST /orders/admin/:id/refund`.

**Admin, adding a product.** `POST /auth/signin` → `POST /catalog/categories` → `POST
/catalog/products` (draft) → `POST /media/upload-url` → POST the file to MinIO with the returned
form → `POST /media/:id/confirm` → poll `GET /media/:id` until `ready` → optionally `PATCH
/media/:id` (alt text), `PUT /media/order`, `POST /media/:id/cover` → `POST
/catalog/products/:id/activate` → visible on the storefront.

**Admin, branding the store.** `PATCH /tenancy/current` (name, taglines, description) → logo:
`POST /media/upload-url` with `ownerType:"tenant"` and `ownerId` = the store id → upload → confirm
→ appears in `GET /tenancy/current`.

**Admin, setting up delivery.** `GET /geo/provinces` → `…/municipalities` → `POST
/geo/delivery-zones` per municipality served → adjust with `PATCH /geo/delivery-zones/:id`.
