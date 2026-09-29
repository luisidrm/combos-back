# Combo Shop API — endpoint reference

What every endpoint is for and what happens inside it. Reflects the code as of the M3 backend:
checkout, the order state machine, both payment providers, webhooks, reconciliation. Fulfilment
(couriers, delivery marking) and notifications have no endpoints yet — that's M4. `audit_log` is
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
for a login code 10 per 15 min **and** 5 per address per hour; login attempts 30 per 15 min;
requesting a password reset link 5 per 15 min **and** 3 per address per hour; submitting one
20 per 15 min.

**Data rules.** Money is integer **cents, USD**. Names are bilingual (`nameEs` required,
`nameEn` falls back to it). IDs are UUIDs. Soft-deleted rows never appear in responses.

---

## 1. Login — `/auth` (SuperTokens)

Two audiences, two methods. Add the header `rid: passwordless` or `rid: emailpassword` as the
SuperTokens client does.

### POST `/auth/signinup/code` — buyer: ask for a login code
Body `{ "email" }`. Creates a one-time code (6 digits, valid ~15 min, max 5 wrong attempts) and
sends it. In production it is emailed through Resend (bilingual text); outside production it is
written to the API log (`Login code (dev only, not emailed)`) and nothing is sent. Returns
`{ status:"OK", deviceId, preAuthSessionId, flowType }` — keep both ids for the next step. No
user is created yet, and no tenant is involved at this stage.

### POST `/auth/signinup/code/resend` — buyer: send a fresh code
Body `{ deviceId, preAuthSessionId }`. Same delivery as above for the same login attempt.

### POST `/auth/signinup/code/consume` — buyer: submit the code (**needs `x-tenant-slug`**)
Body `{ userInputCode, deviceId, preAuthSessionId }`.
1. The tenant is resolved from the header (missing → 401, unknown/inactive → 404).
2. SuperTokens checks the code. A wrong/expired code returns HTTP 200 with
   `status: "INCORRECT_USER_INPUT_CODE_ERROR"` / `"EXPIRED_USER_INPUT_CODE_ERROR"` / `"RESTART_FLOW_ERROR"`.
3. On success we find or create this person's `users` row **in this store** (role `buyer`). A
   disabled (soft-deleted) account gets 403.
4. A session is created carrying `tenantId` and `role`; cookies are set.
Returns `{ status:"OK", createdNewUser, user:{ id, email, timeJoined } }`. One email can be a
buyer at several stores — each store gets its own `users` row.

### POST `/auth/signin` — staff: email + password (**needs `x-tenant-slug`**)
Body `{ formFields:[{id:"email",value},{id:"password",value}] }`. Checks the password, then
requires a **staff** account (admin or courier, not buyer) for *this* store, otherwise returns
`WRONG_CREDENTIALS_ERROR` — a valid password with no staff row here looks like a wrong
password. On success, same session as above with the staff role. Staff accounts are created only
by `npm run db:seed:admin`; there is no public signup, and no 2FA yet (M5).

### POST `/auth/user/password/reset/token` — staff: request a reset link
*No tenant header* — a password login is global, and this only needs the address. Body
`{ formFields:[{id:"email",value}] }`. **Always answers `{status:"OK"}`**, whether or not that
address has an account — it cannot be used to discover who has one. If it does, an emailed link
(logged instead, outside production) carries a single-use token valid about an hour. Rate-limited
per address (5/hour) and per IP (5/15 min), since every call sends a real email.

### POST `/auth/user/password/reset` — staff: submit the new password
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
`{ slug, name, taglineEs, taglineEn, descriptionEs, descriptionEn, logo }` where `logo` is a
`PublicPicture` (see Media) or `null`. Nothing internal (no id, settings or timestamps).

### PATCH `/tenancy/current` — edit branding and switches (Admin)
Body, all optional: `{ name, taglineEs, taglineEn, descriptionEs, descriptionEn, settings:{
requireDeliveryPhoto } }`; `null` clears a nullable text field. Only the fields sent change, and
the fields are picked one by one — the slug and the active flag can never be edited here. Returns
the public page plus `settings`. The logo is set through Media (`ownerType:"tenant"`).

### GET `/tenancy/admin/settings` — read the switches (Admin)
`{ requireDeliveryPhoto: boolean }` (default `false`): whether a delivery needs a proof photo
before it can be marked delivered (used by fulfilment in M4).

## 3. Identity — `/identity`

### GET `/identity/me` — who am I
*Auth: any logged-in user.* Returns `{ id, email, role }`: `id` is our internal user id (used by
every other module). Read fresh from the database on this request, so it reflects the account's
current role and disabled state, not the token's.

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

**GET `/catalog/admin/categories`** — every non-deleted category, including inactive ones.

**POST `/catalog/categories`** — body `{ nameEs, nameEn?, active? }`. Appends to the end of the
order. `nameEn` defaults to `nameEs`.

**PATCH `/catalog/categories/:id`** — partial update of the same fields. `active:false` hides
the category from `GET /catalog/categories` (its products still appear in the unfiltered product
list).

**DELETE `/catalog/categories/:id`** — soft delete; in the same transaction its products become
uncategorised. 404 if already gone.

**PUT `/catalog/categories/order`** — body `{ ids:[…] }`. The i-th id gets position i. Every id
must exist (else 400 and nothing is applied). Send the **full** list — see the review notes.

### Admin — products

**GET `/catalog/admin/products?categoryId=&active=`** — all non-deleted products, drafts
included; `active=true|false` filters.

**GET `/catalog/admin/products/:id`** — one product (any state).

**POST `/catalog/products`** — create a **draft**. Body `{ nameEs, nameEn?, descriptionEs?,
descriptionEn?, categoryId?, priceCents (integer > 0), unitLabel, stockStatus?, maxPerOrder?,
slug? }`. Workflow: if `categoryId` is given it must be a category **of this store** (a database
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
admin or courier; `user` → only that user. The role is re-read from the database on each request.

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

### POST `/orders/checkout` — place the order (Buyer)
Body `{ recipientId, addressId, provider: "tropipay"|"manual", giftMessage?, buyerNotes? }`. Re-runs
the same pricing as `/quote`; `409` with the same `blockers` shape if it still can't go ahead.
On success (201): creates the order in **`pending_payment`**, snapshots every cart line into
`order_items`, creates a matching `pending` payment row, and clears the buyer's cart — then calls
the chosen provider to start a checkout session. Returns
`{ order: OrderDetail, checkoutUrl: string | null }`. `checkoutUrl` is `null` for `manual` (there is
nothing to redirect to — show the buyer payment instructions instead) and also `null` if the
provider call itself failed (network blip, provider outage) — the order still exists either way;
retry with the endpoint below. The order number looks like `ORD-8FQXH2KM` (no `0/O/1/I/L`, so it
reads back over the phone without ambiguity).

### GET `/orders` — the buyer's own orders (Buyer)
`Order[]`, newest first.

### GET `/orders/:id` — one order, with its line items (Buyer)
`OrderDetail`. 404 for another buyer's order.

### POST `/orders/:id/retry-payment` — try starting the checkout session again (Buyer)
Only for an order still in `pending_payment`. Returns `{ checkoutUrl: string | null }`.

### POST `/orders/:id/cancel` — buyer cancels (Buyer)
Body `{ note? }` (or no body at all). **Only while `pending_payment`** — once money has moved,
undoing it is a refund (admin-only), not a cancel; `409 ILLEGAL_TRANSITION` otherwise.

### Admin
`GET /orders/admin/list?status=` · `GET /orders/admin/:id` — same shapes as above, any buyer's
order in the store.

`POST /orders/admin/:id/mark-paid` — body `{ note? }`. A manual override ("I can see in my
TropiPay dashboard/bank that this was paid") for **any** provider, not only `manual` — covers a
missed webhook. Flips the payment row alongside the order, in one transaction.

`POST /orders/admin/:id/preparing` — `paid` → `preparing`.

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
/orders/admin/:id/preparing` → *(M4: mark out for delivery / delivered, once fulfilment ships)*.
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
