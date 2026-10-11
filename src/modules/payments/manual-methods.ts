import { config } from '../../config/index.js';
import type { ManualMethodKind, ManualPaymentMethod } from './payments.schema.js';

// The manual transfer options (Zelle, Cash App, PayPal, anything the owner adds). There is no integration with any
// of them: the buyer sends the money from their own app, and someone at the store checks the account and marks the
// order paid. All we build is the instructions — who to pay, how much, and a link that opens the app (with the
// amount already typed in where the app supports it). The accounts themselves live in the database
// (manual_payment_methods) and are edited in Settings; this file only turns a row into what a buyer sees.

export interface ManualMethodView {
  id: string;
  kind: ManualMethodKind;
  label: string;
  /** What to type into the app as the recipient: an email, a phone, or a `$cashtag`. */
  recipient: string;
  payeeName: string | null;
  instructionsEs: string | null;
  instructionsEn: string | null;
  /** Opens the app or site; null when the method has no usable link (Zelle lives inside the bank's app). */
  link: string | null;
  /** True when `link` already carries the amount, so the buyer does not have to type it. */
  amountInLink: boolean;
}

const decimal = (cents: number): string => (cents / 100).toFixed(2);

// What a buyer sees for one account and exactly `amountCents`.
export function toMethodView(row: ManualPaymentMethod, amountCents: number): ManualMethodView {
  let link: string | null = null;
  let amountInLink = false;

  switch (row.kind) {
    case 'zelle':
      // Zelle has no public pay link: it exists only inside the buyer's bank app.
      break;
    case 'cashapp':
      link = row.handle ? `https://cash.app/$${encodeURIComponent(row.handle)}/${decimal(amountCents)}` : 'https://cash.app/';
      amountInLink = Boolean(row.handle);
      break;
    case 'paypal':
      link = row.handle
        ? `https://www.paypal.com/paypalme/${encodeURIComponent(row.handle)}/${decimal(amountCents)}USD`
        : 'https://www.paypal.com/myaccount/transfer/homepage';
      amountInLink = Boolean(row.handle);
      break;
    default:
      // "other": the owner's own https link. {amount} is 55.50, {recipient} is URL-encoded.
      if (row.linkTemplate) {
        amountInLink = row.linkTemplate.includes('{amount}');
        link = row.linkTemplate.split('{amount}').join(decimal(amountCents)).split('{recipient}').join(encodeURIComponent(row.recipient));
      }
  }

  return {
    id: row.id,
    kind: row.kind as ManualMethodKind,
    label: row.label,
    recipient: row.recipient,
    payeeName: row.payeeName,
    instructionsEs: row.instructionsEs,
    instructionsEn: row.instructionsEn,
    link,
    amountInLink,
  };
}

// Reports saved before methods lived in the database name the app by a bare key.
const LEGACY_LABELS: Record<string, string> = { zelle: 'Zelle', cashapp: 'Cash App', paypal: 'PayPal' };
export function legacyMethodLabel(name: string): string {
  return LEGACY_LABELS[name] ?? name;
}

type Seed = { kind: ManualMethodKind; label: string; recipient: string; handle: string | null; payeeName: string | null };

// The accounts that used to come from environment variables (ZELLE_EMAIL, CASHAPP_*, PAYPAL_*). A store with no
// methods yet gets them once, as rows, so a deployment keeps working; after that the database is the only source.
export function accountsFromEnvironment(): Seed[] {
  const { payeeName, zelleEmail, cashappEmail, cashappCashtag, paypalEmail, paypalMeHandle } = config.manualPayments;
  const payee = payeeName ?? null;
  const seeds: Seed[] = [];
  if (zelleEmail) {
    seeds.push({ kind: 'zelle', label: 'Zelle', recipient: zelleEmail, handle: null, payeeName: payee });
  }
  if (cashappCashtag || cashappEmail) {
    seeds.push({ kind: 'cashapp', label: 'Cash App', recipient: cashappCashtag ? `$${cashappCashtag}` : (cashappEmail as string), handle: cashappCashtag ?? null, payeeName: payee });
  }
  if (paypalEmail || paypalMeHandle) {
    seeds.push({ kind: 'paypal', label: 'PayPal', recipient: paypalEmail ?? (paypalMeHandle as string), handle: paypalMeHandle ?? null, payeeName: payee });
  }
  return seeds;
}
