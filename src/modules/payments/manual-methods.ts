import { config } from '../../config/index.js';

// The manual transfer options (Zelle / Cash App / PayPal). There is no integration with any of
// them: the buyer sends the money from their own app, and someone at the store checks the account
// and marks the order paid. All we build is the instructions — who to pay, how much, and a link that
// opens the app (with the amount already typed in where the app supports it).
export const manualMethodNames = ['zelle', 'cashapp', 'paypal'] as const;
export type ManualMethodName = (typeof manualMethodNames)[number];

export interface ManualMethodView {
  method: ManualMethodName;
  label: string;
  /** What to type into the app as the recipient: an email, or a `$cashtag`. */
  recipient: string;
  payeeName: string | null;
  /** Opens the app or site; null when the method has no usable link (Zelle lives inside the bank's app). */
  link: string | null;
  /** True when `link` already carries the amount, so the buyer does not have to type it. */
  amountInLink: boolean;
}

const decimal = (cents: number): string => (cents / 100).toFixed(2);

// Which methods this store accepts right now, with links for exactly `amountCents`.
export function listManualMethods(amountCents: number): ManualMethodView[] {
  const { payeeName, zelleEmail, cashappEmail, cashappCashtag, paypalEmail, paypalMeHandle } = config.manualPayments;
  const payee = payeeName ?? null;
  const methods: ManualMethodView[] = [];

  if (zelleEmail) {
    // Zelle has no public pay link: it exists only inside the buyer's bank app.
    methods.push({ method: 'zelle', label: 'Zelle', recipient: zelleEmail, payeeName: payee, link: null, amountInLink: false });
  }
  if (cashappCashtag || cashappEmail) {
    methods.push({
      method: 'cashapp',
      label: 'Cash App',
      recipient: cashappCashtag ? `$${cashappCashtag}` : (cashappEmail as string),
      payeeName: payee,
      link: cashappCashtag ? `https://cash.app/$${encodeURIComponent(cashappCashtag)}/${decimal(amountCents)}` : 'https://cash.app/',
      amountInLink: Boolean(cashappCashtag),
    });
  }
  if (paypalEmail || paypalMeHandle) {
    methods.push({
      method: 'paypal',
      label: 'PayPal',
      recipient: paypalEmail ?? (paypalMeHandle as string),
      payeeName: payee,
      link: paypalMeHandle
        ? `https://www.paypal.com/paypalme/${encodeURIComponent(paypalMeHandle)}/${decimal(amountCents)}USD`
        : 'https://www.paypal.com/myaccount/transfer/homepage',
      amountInLink: Boolean(paypalMeHandle),
    });
  }
  return methods;
}
