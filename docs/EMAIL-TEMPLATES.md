# Emails as Resend templates — how to make it work

Pa'Casa can send its emails two ways. You choose with one setting, `EMAIL_TEMPLATES` in `/pacasa/.env`:

| Setting | What happens | Edit the words/look |
|---|---|---|
| `inline` (default) | Our code renders the email's HTML and sends it. | In the code (needs a deploy). |
| `resend` | Our code sends only the **variables** (order number, name, link…) to a **template stored in Resend**. | In Resend's editor, no deploy. |

Both look the same: the templates are generated from the very same code as the inline emails, and a test proves that a template filled with its variables is **byte for byte** the email we would have sent. If a template is missing or Resend refuses it, the app **automatically sends the same email inline**, so an email is never lost over how it is dressed.

There are **20 templates**: for each language (`es`, `en`) the order emails (placed, paid, on the way, delivered, cancelled, cancelled because unpaid, refunded, payment reminder) and the two account emails (confirm email, reset password).

---

## Before you start
1. A Resend account, with **`pacasa.net` verified** (Domains → Add domain → copy the DNS records into Cloudflare, "DNS only") and `EMAIL_FROM=Pa'Casa <pedidos@pacasa.net>`.
2. An API key to **upload** templates: Resend → API Keys → create one with **Full access** (a "sending access" key cannot manage templates). Use it only on your own computer for the upload; the server keeps its normal key.

## Step 1 — Upload the templates (the easy way, one command)
On **your computer**, in the `back/` folder:

```
npm run emails:push -- --dry-run          # shows what it would do; sends nothing
RESEND_API_KEY=re_your_full_access_key npm run emails:push
```
(On Windows PowerShell: `$env:RESEND_API_KEY="re_..."; npm run emails:push`.)

It takes about 40 seconds (Resend allows two requests a second). You should see 20 lines starting with `ok` and `Created 20, updated 0, failed 0.` Then open Resend → **Templates**: 20 templates named `Pa'Casa · … (es/en)`, all **Published**.
You can run it again any time: it **updates** the existing ones and publishes the new version.
To try just one: `npm run emails:push -- --only=order-paid`.

### Or by hand in the dashboard (Step 1, alternative)
`npm run emails:export` writes the files to `back/email-templates/`: one `.html` per template, a `templates.json` with every template's variables, and an `index.html` table. In Resend → Templates → **Create template**, import/paste the HTML of one file, then add its variables (the exact names are in the table), and **Publish**. Use the template's **alias** exactly as the file name without `.html` (for example `pacasa-order-paid-es`): the app finds templates by alias. Repeat for all 20. (The command above does exactly this for you, which is why it is the recommended way.)

## Step 2 — Turn it on
On the server:

```
cd /pacasa
nano .env              # add or change:   EMAIL_TEMPLATES=resend
docker compose up -d api worker
```
(The **worker** sends the order emails and the **api** sends the confirm-email and reset-password ones, so restart both.)

## Step 3 — Test it
1. Sign up a new buyer with a real email you own (a Gmail): you must receive "Confirma tu correo" in your language.
2. Place a test order and mark it paid from the admin: you receive "Recibimos tu pedido" (with the **receipt table**) and "Recibimos tu pago".
3. In Resend → **Emails** you should see those emails, and open one to see the template it used.
4. **Look at the "order received" email closely.** The receipt (the list of products and prices) must appear as a neat table. If you instead see raw `<tr><td>` text, Resend is escaping that variable: set `EMAIL_TEMPLATES=inline` again (nothing is lost) and tell me, I will change how the receipt is passed.

If something goes wrong, the worker log has a line like
`order email: the Resend template was not used; sending it directly` with the template's alias and Resend's error name: the email still went out inline.
(`docker compose logs worker | grep "template was not used"`)

---

## Editing the emails later — choose ONE place
- **Edit in Resend's editor** (words, colours, layout): fine, publish it. **But do not run `emails:push` again afterwards**: it would overwrite your edits with the code's version. Keep every `{{{VARIABLE}}}` in the template; if you delete one, the app simply does not send it, and if you add a new one that the app doesn't know, Resend will refuse the email and the app will send it inline instead.
- **Edit in the code** (`back/src/modules/notifications/notifications.templates.ts`): then run `npm run emails:push` to update Resend. This is the safe route if you want the code and the dashboard to stay identical.

## Reference
**Variables** (all text; what people typed is already escaped by the app):

| Variable | What it is | In which emails |
|---|---|---|
| `BRAND_NAME` | The store's name (default Pa'Casa) | all |
| `BRAND_URL` | The site address (default https://pacasa.net) | all |
| `SUPPORT` | The contact line in the footer: the store's email and phone, or the site address (default pedidos@pacasa.net) | all |
| `GREETING` | "Hola Ana." / "Hi Ana." | order emails |
| `ORDER_NUMBER` | `FC-1042` | order emails |
| `RECIPIENT_NAME` | Who receives the order | order emails |
| `ORDER_URL` | The order's page | order emails |
| `TOTAL` | `$48.50` | refunded, payment reminder |
| `RECEIPT_ROWS` | The receipt's table rows, as HTML | order received only |
| `LINK` | The confirm / reset link | confirm email, reset password |

**Aliases**: `pacasa-<email>-<es|en>`, where `<email>` is `order-placed`, `order-paid`, `order-on-the-way`, `order-delivered`, `order-cancelled`, `order-cancelled-unpaid`, `order-refunded`, `order-payment-reminder`, `verify-email`, `reset-password`.

**Limits to know** (Resend's): a template has at most 50 variables (ours have 4–9); a variable's value is at most 2,000 characters. A very long order (more than about 5–6 products) has a receipt that does not fit in one variable, so **that one email is sent inline** automatically; every other email is unaffected.

**Not templates**: the store's own alerts (new order, transfer to check, courier problems) are always sent inline; only the owner reads them.

## If it does not work
| You see | Meaning | Fix |
|---|---|---|
| `emails:push` says `Set RESEND_API_KEY` | No key | Add it on the command line as shown above |
| `FAIL … 401` / `restricted_api_key` | The key is "sending only" | Create a **Full access** key |
| `FAIL … 429` | Too fast (the tool retries by itself) | Run it again |
| Emails arrive but look different | The template was edited in Resend or is an old version | Run `npm run emails:push` (overwrites) or republish in Resend |
| The log says "template was not used" | Template missing, unpublished, or its variables changed | Publish it, or run `emails:push`; the email already went out inline |
| Receipt shows raw tags | Resend escapes that variable | Use `EMAIL_TEMPLATES=inline` and tell me |
