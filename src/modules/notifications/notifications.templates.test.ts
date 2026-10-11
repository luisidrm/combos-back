import { describe, expect, it } from 'vitest';
import {
  orderEmail,
  passwordResetEmail,
  transferAlertEmail,
  verificationEmail,
  type EmailBrand,
  type EmailLocale,
  type OrderEmailData,
  type OrderEmailKind,
} from './notifications.templates.js';

const brand: EmailBrand = { name: 'Combos Habana', webUrl: 'https://combos.example.com', supportEmail: 'hola@combos.example.com', supportPhone: '+53 5 123 4567' };

const data = (overrides: Partial<OrderEmailData> = {}): OrderEmailData => ({
  buyerName: 'Carla',
  orderNumber: 'FC-1042',
  recipientName: 'María Gómez',
  orderUrl: 'https://combos.example.com/es/account/orders/abc',
  totalCents: 4850,
  subtotalCents: 4350,
  deliveryFeeCents: 500,
  items: [{ name: 'Pollo ahumado', quantity: 2, unitLabel: '1 kg', lineTotalCents: 2400 }],
  ...overrides,
});

const KINDS: OrderEmailKind[] = ['placed', 'paid', 'out_for_delivery', 'delivered', 'cancelled', 'refunded', 'payment_reminder'];
const LOCALES: EmailLocale[] = ['es', 'en'];

describe('email templates', () => {
  it.each(LOCALES.flatMap((locale) => KINDS.map((kind) => [locale, kind] as const)))(
    '%s %s: a subject, the order number, a link, HTML and a text twin',
    (locale, kind) => {
      const mail = orderEmail(kind, locale, brand, data());
      expect(mail.subject).toContain('FC-1042');
      expect(mail.subject).toContain('Combos Habana');
      expect(mail.html).toContain('href="https://combos.example.com/es/account/orders/abc"');
      expect(mail.html).toContain(`<html lang="${locale}">`);
      expect(mail.text).toContain('https://combos.example.com/es/account/orders/abc');
      expect(mail.text).toContain('FC-1042');
      expect(mail.text).not.toContain('<'); // the plain version has no markup
    },
  );

  it('writes in one language only, never both', () => {
    for (const kind of KINDS) {
      const es = orderEmail(kind, 'es', brand, data());
      const en = orderEmail(kind, 'en', brand, data());
      expect(es.subject).not.toBe(en.subject);
      // Words that only one language uses
      expect(es.text).not.toMatch(/\b(your|payment|delivered|Thank)\b/i);
      expect(en.text).not.toMatch(/\b(tu|pedido|pago|entregado|Gracias)\b/i);
    }
    for (const make of [verificationEmail, passwordResetEmail]) {
      expect(make('es', brand, 'https://x.example/l').text).not.toMatch(/\b(your|email|password)\b/i);
      expect(make('en', brand, 'https://x.example/l').text).not.toMatch(/\b(tu|correo|contraseña)\b/i);
    }
  });

  it('shows the receipt only when the order is placed', () => {
    const placed = orderEmail('placed', 'es', brand, data());
    expect(placed.text).toContain('Pollo ahumado × 2 · 1 kg: $24.00');
    expect(placed.text).toContain('Total: $48.50');
    expect(orderEmail('paid', 'es', brand, data()).text).not.toContain('Pollo ahumado');
  });

  it('says free delivery as a word, not $0.00', () => {
    expect(orderEmail('placed', 'es', brand, data({ deliveryFeeCents: 0 })).text).toContain('Entrega: Gratis');
    expect(orderEmail('placed', 'en', brand, data({ deliveryFeeCents: 0 })).text).toContain('Delivery: Free');
  });

  it('explains why an unpaid order was cancelled, and the refund amount', () => {
    expect(orderEmail('cancelled', 'es', brand, data({ cause: 'unpaid' })).text).toContain('no recibimos el pago a tiempo');
    expect(orderEmail('cancelled', 'en', brand, data({ cause: 'unpaid' })).text).toContain('did not receive the payment in time');
    expect(orderEmail('cancelled', 'es', brand, data()).text).not.toContain('a tiempo');
    expect(orderEmail('refunded', 'en', brand, data()).text).toContain('$48.50');
  });

  it('escapes whatever a person typed before it reaches the HTML', () => {
    const evil = '<script>alert(1)</script> & "x"';
    const mail = orderEmail(
      'placed',
      'es',
      { ...brand, name: evil },
      data({ buyerName: evil, recipientName: evil, items: [{ name: evil, quantity: 1, unitLabel: evil, lineTotalCents: 100 }] }),
    );
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('&amp;');
    expect(mail.html).not.toContain('"x"'); // quotes too, since a value can land inside an attribute
  });

  it('says hello without a name when there is none, and shows the store contact in the footer', () => {
    const mail = orderEmail('paid', 'en', brand, data({ buyerName: null }));
    expect(mail.text.split('\n')).toContain('Hi.');
    expect(mail.text).toContain('hola@combos.example.com');
    expect(mail.text).toContain('+53 5 123 4567');
    const bare = orderEmail('paid', 'en', { name: 'Shop', webUrl: 'https://s.example' }, data());
    expect(bare.text).not.toContain('If you need help');
  });

  it('puts the link in both the button and a copy-able line, for the account emails too', () => {
    const link = 'https://combos.example.com/account/verify-email?token=abc&tenantId=public';
    const mail = verificationEmail('en', brand, link);
    expect(mail.html.split('tenantId=public').length - 1).toBeGreaterThanOrEqual(2);
    expect(mail.html).toContain('&amp;tenantId=public'); // the ampersand is escaped inside the attribute
    expect(mail.text).toContain(link);
    expect(passwordResetEmail('es', brand, link).subject).toContain('contraseña');
  });

  it('tells the store which transfer to check', () => {
    const mail = transferAlertEmail('es', brand, { orderNumber: 'FC-1042', amountCents: 4850, method: 'Zelle', transferReference: 'ZL-1', adminUrl: 'https://combos.example.com/es/admin/orders' });
    expect(mail.subject).toContain('FC-1042');
    expect(mail.text).toContain('$48.50');
    expect(mail.text).toContain('Zelle');
    expect(mail.text).toContain('ZL-1');
  });
});
