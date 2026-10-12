import { describe, expect, it } from 'vitest';
import {
  MAX_VARIABLE_LENGTH,
  accountTemplateSend,
  buildResendTemplates,
  orderTemplateAlias,
  orderTemplateSend,
} from './notifications.resend-templates.js';
import { orderEmail, passwordResetEmail, verificationEmail, type EmailBrand, type EmailLocale, type OrderEmailData, type OrderEmailKind } from './notifications.templates.js';

// The Resend templates are built from the same code as the emails we send directly. These tests make sure that what
// is uploaded is valid for Resend, and that a template filled with its variables IS the email, byte for byte.

const brand: EmailBrand = { name: 'Combos <Habana>', webUrl: 'https://pacasa.net', supportEmail: 'hola@pacasa.net', supportPhone: '+53 5 123 4567' };
const order: OrderEmailData = {
  buyerName: 'Ana "la Mejor" <b>',
  orderNumber: 'FC-1042',
  recipientName: "María O'Neil & Co",
  orderUrl: 'https://pacasa.net/es/account/orders/abc?x=1&y=2',
  totalCents: 4850,
  subtotalCents: 4350,
  deliveryFeeCents: 500,
  items: [
    { name: 'Pollo <ahumado>', quantity: 2, unitLabel: '1 kg', lineTotalCents: 2400 },
    { name: 'Arroz', quantity: 3, unitLabel: '1 kg', lineTotalCents: 1950 },
  ],
};

const fill = (html: string, variables: Record<string, string>): string => html.replace(/\{\{\{([A-Z0-9_]+)\}\}\}/g, (_m, key: string) => variables[key] ?? `<<MISSING ${key}>>`);
const defs = buildResendTemplates();
const byAlias = new Map(defs.map((d) => [d.alias, d]));
const KINDS: OrderEmailKind[] = ['placed', 'paid', 'out_for_delivery', 'delivered', 'cancelled', 'refunded', 'payment_reminder'];
const LOCALES: EmailLocale[] = ['es', 'en'];

describe('Resend templates', () => {
  it('has one template per email and language, with unique aliases', () => {
    expect(defs).toHaveLength(20); // (7 order emails + the unpaid cancellation + 2 account emails) x 2 languages
    expect(new Set(defs.map((d) => d.alias)).size).toBe(defs.length);
    for (const d of defs) expect(d.alias).toMatch(/^pacasa-[a-z-]+-(es|en)$/);
  });

  it.each(defs.map((d) => [d.alias, d] as const))('%s: valid for Resend (variables, braces, size)', (_alias, d) => {
    expect(d.variables.length).toBeGreaterThan(0);
    expect(d.variables.length).toBeLessThanOrEqual(50);
    for (const v of d.variables) {
      expect(v.key).toMatch(/^[A-Z][A-Z0-9_]{0,49}$/);
      expect(['FIRST_NAME', 'LAST_NAME', 'EMAIL', 'UNSUBSCRIBE_URL', 'RESEND_UNSUBSCRIBE_URL', 'contact', 'this']).not.toContain(v.key);
    }
    // every {{{KEY}}} in the HTML is declared, and nothing is declared that the HTML does not use
    const used = [...new Set([...d.html.matchAll(/\{\{\{([A-Z0-9_]+)\}\}\}/g)].map((m) => m[1]))].sort();
    expect(d.variables.map((v) => v.key).sort()).toEqual(used);
    // no other kind of brace (a stray {{x}} could be read as a variable)
    expect(d.html.replace(/\{\{\{[A-Z0-9_]+\}\}\}/g, '')).not.toMatch(/\{\{|\}\}/);
    expect(d.html.startsWith('<!doctype html>')).toBe(true);
    expect(d.subject.length).toBeGreaterThan(5);
    expect(d.subject).not.toContain('{{');
  });

  it('only the order-placed template carries the receipt', () => {
    for (const d of defs) expect(d.variables.some((v) => v.key === 'RECEIPT_ROWS')).toBe(d.alias.startsWith('pacasa-order-placed-'));
  });

  it.each(LOCALES.flatMap((locale) => KINDS.map((kind) => [locale, kind] as const)))('%s %s: a filled template is exactly the email we would send', (locale, kind) => {
    const send = orderTemplateSend(kind, locale, brand, order);
    expect(send).not.toBeNull();
    if (!send) return;
    const template = byAlias.get(send.alias);
    expect(template).toBeDefined();
    expect(fill(template?.html ?? '', send.variables)).toBe(orderEmail(kind, locale, brand, order).html);
  });

  it.each(LOCALES)('%s: the unpaid cancellation has its own template and matches too', (locale) => {
    const data = { ...order, cause: 'unpaid' as const };
    const send = orderTemplateSend('cancelled', locale, brand, data);
    expect(send?.alias).toBe(orderTemplateAlias('cancelled', locale, 'unpaid'));
    expect(fill(byAlias.get(send?.alias ?? '')?.html ?? '', send?.variables ?? {})).toBe(orderEmail('cancelled', locale, brand, data).html);
    // and the ordinary cancellation is a different template
    expect(orderTemplateSend('cancelled', locale, brand, order)?.alias).not.toBe(send?.alias);
  });

  it.each(LOCALES)('%s: the account emails match too', (locale) => {
    const link = 'https://pacasa.net/account/verify-email?token=a&tenantId=public';
    const verify = accountTemplateSend('verify-email', locale, brand, link);
    expect(fill(byAlias.get(verify?.alias ?? '')?.html ?? '', verify?.variables ?? {})).toBe(verificationEmail(locale, brand, link).html);
    const reset = accountTemplateSend('reset-password', locale, brand, link);
    expect(fill(byAlias.get(reset?.alias ?? '')?.html ?? '', reset?.variables ?? {})).toBe(passwordResetEmail(locale, brand, link).html);
  });

  it('what people typed arrives escaped, so it cannot inject markup whichever way Resend treats the braces', () => {
    const send = orderTemplateSend('paid', 'es', brand, order);
    const joined = Object.values(send?.variables ?? {}).join(' ');
    expect(joined).not.toContain('<b>');
    expect(joined).not.toContain('<Habana>');
    expect(send?.variables.GREETING).toContain('&lt;b&gt;');
    expect(send?.variables.RECIPIENT_NAME).toBe('María O&#39;Neil &amp; Co');
  });

  it('sends only the variables the template uses, and each within Resend\'s size limit', () => {
    const paid = orderTemplateSend('paid', 'en', brand, order);
    expect(Object.keys(paid?.variables ?? {}).sort()).toEqual(byAlias.get(paid?.alias ?? '')?.variables.map((v) => v.key).sort());
    expect(paid?.variables.RECEIPT_ROWS).toBeUndefined();
    for (const value of Object.values(orderTemplateSend('placed', 'es', brand, order)?.variables ?? {})) expect(value.length).toBeLessThanOrEqual(MAX_VARIABLE_LENGTH);
  });

  it('gives up on the template (so the email goes out the ordinary way) when the receipt is too long for a variable', () => {
    const many = { ...order, items: Array.from({ length: 40 }, (_v, i) => ({ name: `Producto número ${i}`, quantity: 1, unitLabel: '1 kg', lineTotalCents: 100 })) };
    expect(orderTemplateSend('placed', 'es', brand, many)).toBeNull();
    // the other kinds do not carry the receipt, so a long order still uses their templates
    expect(orderTemplateSend('paid', 'es', brand, many)).not.toBeNull();
  });

  it('shows the site address in the footer when the store has no contact on file', () => {
    const bare: EmailBrand = { name: 'Shop', webUrl: 'https://s.example' };
    expect(orderTemplateSend('paid', 'es', bare, order)?.variables.SUPPORT).toBe('https://s.example');
  });
});
