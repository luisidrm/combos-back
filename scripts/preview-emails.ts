// Renders every email, in both languages, into `email-previews/` so they can be opened in a browser and judged by eye
// (`npm run emails:preview`). Nothing is sent. The sample data is invented; the templates are the real ones.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  orderEmail,
  passwordResetEmail,
  transferAlertEmail,
  verificationEmail,
  type EmailBrand,
  type EmailLocale,
  type OrderEmailData,
  type OrderEmailKind,
  type RenderedEmail,
} from '../src/modules/notifications/notifications.templates.js';

const brand: EmailBrand = {
  name: 'Combos Habana',
  webUrl: 'https://combos.example.com',
  supportEmail: 'hola@combos.example.com',
  supportPhone: '+53 5 123 4567',
};

const orderData = (locale: EmailLocale): OrderEmailData => ({
  buyerName: 'Carla Pérez',
  orderNumber: 'FC-1042',
  recipientName: 'María Gómez',
  orderUrl: `https://combos.example.com/${locale}/account/orders/00000000-0000-4000-8000-000000000042`,
  totalCents: 4850,
  subtotalCents: 4350,
  deliveryFeeCents: 500,
  items: [
    { name: locale === 'en' ? 'Smoked chicken' : 'Pollo ahumado', quantity: 2, unitLabel: '1 kg', lineTotalCents: 2400 },
    { name: locale === 'en' ? 'Rice' : 'Arroz', quantity: 3, unitLabel: '1 kg', lineTotalCents: 1950 },
  ],
});

const KINDS: OrderEmailKind[] = ['placed', 'paid', 'out_for_delivery', 'delivered', 'cancelled', 'refunded', 'payment_reminder'];

const outDir = join(process.cwd(), 'email-previews');
mkdirSync(outDir, { recursive: true });

const written: Array<{ file: string; subject: string }> = [];
function save(name: string, locale: EmailLocale, mail: RenderedEmail): void {
  const file = `${name}.${locale}.html`;
  writeFileSync(join(outDir, file), mail.html);
  writeFileSync(join(outDir, `${name}.${locale}.txt`), `${mail.subject}\n\n${mail.text}\n`);
  written.push({ file, subject: mail.subject });
}

for (const locale of ['es', 'en'] as const) {
  save('verify-email', locale, verificationEmail(locale, brand, 'https://combos.example.com/account/verify-email?token=demo'));
  save('reset-password', locale, passwordResetEmail(locale, brand, 'https://combos.example.com/admin/reset-password?token=demo'));
  for (const kind of KINDS) save(`order-${kind}`, locale, orderEmail(kind, locale, brand, orderData(locale)));
  save('order-cancelled-unpaid', locale, orderEmail('cancelled', locale, brand, { ...orderData(locale), cause: 'unpaid' }));
}
save(
  'store-transfer-alert',
  'es',
  transferAlertEmail('es', brand, { orderNumber: 'FC-1042', amountCents: 4850, method: 'Zelle', transferReference: 'ZL-84721', adminUrl: 'https://combos.example.com/es/admin/orders' }),
);

const rows = written.map((w) => `<tr><td><a href="${w.file}">${w.file}</a></td><td>${w.subject.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td></tr>`).join('\n');
writeFileSync(
  join(outDir, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Email previews</title><body style="font-family:system-ui;margin:32px"><h1>Email previews</h1><table cellpadding="6">${rows}</table></body>`,
);
console.log(`Wrote ${written.length} emails to ${outDir} - open email-previews/index.html`);
