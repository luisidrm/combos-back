// The same emails as notifications.templates.ts, as Resend TEMPLATES: the HTML has {{{VARIABLES}}} where the order's own
// details go, and Resend fills them in when we send with `template: { id, variables }`.
//
// Pure (no config, no network), like the file it builds on, so the dashboard import files, the upload command and the
// tests all use exactly this. The point of a template is that the words and the look can then be edited in Resend's
// editor without a deploy; the point of building them from the code is that the two can never start out different.
//
// What goes in a variable is ALREADY HTML-ESCAPED here (names, products and addresses come from people). Resend's own
// escaping is not documented for triple braces, so nothing relies on it. The receipt rows are the one variable that is
// HTML on purpose (a repeating list cannot be a plain variable).

import {
  esc,
  factsRowsHtml,
  orderEmail,
  orderFacts,
  orderGreeting,
  passwordResetEmail,
  usd,
  verificationEmail,
  type EmailBrand,
  type EmailLocale,
  type OrderEmailData,
  type OrderEmailKind,
} from './notifications.templates.js';

export interface TemplateVariable {
  key: string;
  type: 'string';
  fallback_value?: string;
}

export interface ResendTemplateDef {
  alias: string;
  name: string;
  /** A default only: the app sets the real subject (with the order number) when it sends. */
  subject: string;
  html: string;
  variables: TemplateVariable[];
}

/** Resend refuses a variable value longer than this. */
export const MAX_VARIABLE_LENGTH = 2000;

// A variable with a fallback never has to be supplied; everything else must be.
const FALLBACKS: Record<string, string> = { BRAND_NAME: "Pa'Casa", BRAND_URL: 'https://pacasa.net', SUPPORT: 'pedidos@pacasa.net' };

const ORDER_SLUG: Record<OrderEmailKind, string> = {
  placed: 'order-placed',
  paid: 'order-paid',
  out_for_delivery: 'order-on-the-way',
  delivered: 'order-delivered',
  cancelled: 'order-cancelled',
  refunded: 'order-refunded',
  payment_reminder: 'order-payment-reminder',
};

export type AccountTemplate = 'verify-email' | 'reset-password';

/** The stable name a template is sent by (an alias works wherever an id does). */
export function orderTemplateAlias(kind: OrderEmailKind, locale: EmailLocale, cause?: 'unpaid'): string {
  const slug = kind === 'cancelled' && cause === 'unpaid' ? 'order-cancelled-unpaid' : ORDER_SLUG[kind];
  return `pacasa-${slug}-${locale}`;
}
export const accountTemplateAlias = (which: AccountTemplate, locale: EmailLocale): string => `pacasa-${which}-${locale}`;

// What the HTML is rendered with: every changing detail is a variable.
const BRAND_VARS: EmailBrand = { name: '{{{BRAND_NAME}}}', webUrl: '{{{BRAND_URL}}}', supportEmail: '{{{SUPPORT}}}', supportPhone: null };
const ORDER_VARS: OrderEmailData = {
  buyerName: null,
  greeting: '{{{GREETING}}}',
  orderNumber: '{{{ORDER_NUMBER}}}',
  recipientName: '{{{RECIPIENT_NAME}}}',
  orderUrl: '{{{ORDER_URL}}}',
  totalCents: 0,
  total: '{{{TOTAL}}}',
  receiptRows: '{{{RECEIPT_ROWS}}}',
};

// A sample, only used to give each template a readable default subject and name in Resend's list.
const SAMPLE_BRAND: EmailBrand = { name: "Pa'Casa", webUrl: 'https://pacasa.net', supportEmail: 'pedidos@pacasa.net', supportPhone: null };
const SAMPLE_ORDER: OrderEmailData = { buyerName: 'Ana', orderNumber: 'FC-1001', recipientName: 'María', orderUrl: 'https://pacasa.net', totalCents: 5000 };

const ORDER_TITLES: Record<EmailLocale, Record<OrderEmailKind | 'cancelled_unpaid', string>> = {
  es: {
    placed: 'Pedido recibido',
    paid: 'Pago recibido',
    out_for_delivery: 'Pedido en camino',
    delivered: 'Pedido entregado',
    cancelled: 'Pedido cancelado',
    cancelled_unpaid: 'Pedido cancelado por falta de pago',
    refunded: 'Reembolso',
    payment_reminder: 'Recordatorio de pago',
  },
  en: {
    placed: 'Order received',
    paid: 'Payment received',
    out_for_delivery: 'Order on its way',
    delivered: 'Order delivered',
    cancelled: 'Order cancelled',
    cancelled_unpaid: 'Order cancelled: not paid',
    refunded: 'Refund',
    payment_reminder: 'Payment reminder',
  },
};

const keysUsed = (html: string): string[] => [...new Set([...html.matchAll(/\{\{\{([A-Z0-9_]+)\}\}\}/g)].map((m) => m[1] ?? ''))];
const variablesFor = (html: string): TemplateVariable[] =>
  keysUsed(html).map((key) => (FALLBACKS[key] !== undefined ? { key, type: 'string', fallback_value: FALLBACKS[key] } : { key, type: 'string' }));

const LOCALES: EmailLocale[] = ['es', 'en'];
const ORDER_KINDS = Object.keys(ORDER_SLUG) as OrderEmailKind[];

/** Every template the app can send through, for both languages. */
export function buildResendTemplates(): ResendTemplateDef[] {
  const defs: ResendTemplateDef[] = [];
  for (const locale of LOCALES) {
    const orderVariants: Array<{ kind: OrderEmailKind; cause?: 'unpaid'; title: string }> = [
      ...ORDER_KINDS.map((kind) => ({ kind, title: ORDER_TITLES[locale][kind] })),
      { kind: 'cancelled' as const, cause: 'unpaid' as const, title: ORDER_TITLES[locale].cancelled_unpaid },
    ];
    for (const { kind, cause, title } of orderVariants) {
      const html = orderEmail(kind, locale, BRAND_VARS, { ...ORDER_VARS, cause }).html;
      defs.push({
        alias: orderTemplateAlias(kind, locale, cause),
        name: `Pa'Casa · ${title} (${locale})`,
        subject: orderEmail(kind, locale, SAMPLE_BRAND, { ...SAMPLE_ORDER, cause }).subject,
        html,
        variables: variablesFor(html),
      });
    }
    for (const [which, make, title] of [
      ['verify-email', verificationEmail, locale === 'es' ? 'Confirmar correo' : 'Confirm email'],
      ['reset-password', passwordResetEmail, locale === 'es' ? 'Restablecer contraseña' : 'Reset password'],
    ] as const) {
      const html = make(locale, BRAND_VARS, '{{{LINK}}}').html;
      defs.push({
        alias: accountTemplateAlias(which, locale),
        name: `Pa'Casa · ${title} (${locale})`,
        subject: make(locale, SAMPLE_BRAND, 'https://pacasa.net').subject,
        html,
        variables: variablesFor(html),
      });
    }
  }
  return defs;
}

// --- sending through a template ---------------------------------------------------------------------------------------

export interface TemplateSend {
  alias: string;
  variables: Record<string, string>;
}

const brandVariables = (brand: EmailBrand): Record<string, string> => {
  const bits = [brand.supportEmail, brand.supportPhone].filter((v): v is string => Boolean(v));
  return {
    BRAND_NAME: esc(brand.name),
    BRAND_URL: esc(brand.webUrl),
    // The footer's contact line; without any contact on file it shows the site address.
    SUPPORT: bits.length > 0 ? bits.map(esc).join(' · ') : esc(brand.webUrl),
  };
};

// Only the variables a template actually uses are sent, and null means "do not use the template": a value too long for
// Resend would make the whole send fail, and an email must never be lost over how it is dressed.
function finish(alias: string, all: Record<string, string>): TemplateSend | null {
  const wanted = TEMPLATE_KEYS.get(alias);
  if (!wanted) return null;
  const variables: Record<string, string> = {};
  for (const key of wanted) {
    const value = all[key];
    if (value === undefined || value.length > MAX_VARIABLE_LENGTH) return null;
    variables[key] = value;
  }
  return { alias, variables };
}

// alias -> the variable names that template uses (built once from the same code as the templates themselves)
const TEMPLATE_KEYS: Map<string, string[]> = new Map(buildResendTemplates().map((def) => [def.alias, def.variables.map((v) => v.key)]));

export function orderTemplateSend(kind: OrderEmailKind, locale: EmailLocale, brand: EmailBrand, data: OrderEmailData): TemplateSend | null {
  const all: Record<string, string> = {
    ...brandVariables(brand),
    GREETING: esc(orderGreeting(locale, data.buyerName)),
    ORDER_NUMBER: esc(data.orderNumber),
    RECIPIENT_NAME: esc(data.recipientName),
    ORDER_URL: esc(data.orderUrl),
    TOTAL: usd(data.totalCents),
  };
  if (kind === 'placed') all.RECEIPT_ROWS = factsRowsHtml(orderFacts(locale, data));
  return finish(orderTemplateAlias(kind, locale, data.cause), all);
}

export function accountTemplateSend(which: AccountTemplate, locale: EmailLocale, brand: EmailBrand, link: string): TemplateSend | null {
  return finish(accountTemplateAlias(which, locale), { ...brandVariables(brand), LINK: esc(link) });
}
