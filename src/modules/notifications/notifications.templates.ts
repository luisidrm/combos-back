// The look and the words of every email we send. Pure functions: no config, no database, no network — so the same code
// renders a real email, a test, and the preview files (`npm run emails:preview`).
//
// One language per email, never both: the buyer's own (users.locale). Buyers in Miami mostly read Spanish, their
// US-born children often English, and a message in both languages reads as noise in either.
//
// Everything that comes from a person (names, product names, notes) goes through `esc` before it reaches the HTML.
// Mail clients ignore most CSS, so the layout is a table with inline styles and nothing else.

export type EmailLocale = 'es' | 'en';

export interface EmailBrand {
  /** The store's name, shown as the wordmark and in the footer. */
  name: string;
  /** Where the store's site lives (the footer link). */
  webUrl: string;
  supportEmail?: string | null;
  supportPhone?: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

// Same teal as the web app (--accent). White on it is 4.9:1, enough for the button label.
const TEAL = '#007D8D';
const INK = '#1b2a2d';
const MUTED = '#5d6f73';
const LINE = '#dde6e8';
const PAGE_BG = '#eef3f4';

/** HTML-escapes text that came from a person. Exported because values sent to a Resend template must be escaped the same way. */
export const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** `$48.50` in both languages, like the site (money is whole cents, USD). */
export const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export interface Fact {
  label: string;
  value: string;
}

interface Layout {
  locale: EmailLocale;
  brand: EmailBrand;
  /** The grey line mail apps show next to the subject. */
  preheader: string;
  heading: string;
  paragraphs: string[];
  facts?: Fact[];
  /** Table rows already rendered as HTML (a Resend template receives them as one variable); replaces `facts`. */
  factsRaw?: string;
  button?: { label: string; url: string };
  /** Small print under the button. */
  small?: string;
}

const FOOTER = {
  es: {
    contact: 'Si necesitas ayuda, escríbenos',
    sentBy: (name: string) => `Este mensaje lo envía ${name}.`,
    linkTrouble: 'Si el botón no funciona, copia este enlace en tu navegador:',
  },
  en: {
    contact: 'If you need help, write to us',
    sentBy: (name: string) => `This message was sent by ${name}.`,
    linkTrouble: 'If the button does not work, copy this link into your browser:',
  },
} as const;

/** The rows of the label / value table (the receipt, a transfer's details), as HTML. */
export function factsRowsHtml(facts: Fact[]): string {
  return facts
    .map(
      (fact) =>
        `<tr><td style="padding:9px 0;border-bottom:1px solid ${LINE};color:${MUTED};font-size:14px">${esc(fact.label)}</td><td align="right" style="padding:9px 0 9px 12px;border-bottom:1px solid ${LINE};color:${INK};font-size:14px;font-weight:600">${esc(fact.value)}</td></tr>`,
    )
    .join('');
}

function renderLayout(l: Layout): { html: string; text: string } {
  const f = FOOTER[l.locale];
  const contactBits = [l.brand.supportEmail, l.brand.supportPhone].filter((v): v is string => Boolean(v));

  const rows = l.factsRaw ?? (l.facts?.length ? factsRowsHtml(l.facts) : '');
  const facts = rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 6px;border-top:1px solid ${LINE}">${rows}</table>` : '';

  const button = l.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px"><tr><td style="background:${TEAL};border-radius:12px"><a href="${esc(l.button.url)}" style="display:inline-block;padding:13px 22px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">${esc(l.button.label)}</a></td></tr></table>
<p style="margin:10px 0 0;color:${MUTED};font-size:12px;line-height:1.5">${esc(f.linkTrouble)}<br><a href="${esc(l.button.url)}" style="color:${TEAL};word-break:break-all">${esc(l.button.url)}</a></p>`
    : '';

  const html = `<!doctype html>
<html lang="${l.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(l.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${INK}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(l.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE_BG}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px">
<tr><td style="padding:0 4px 14px;font-size:20px;font-weight:700;color:${TEAL};letter-spacing:-0.01em">${esc(l.brand.name)}</td></tr>
<tr><td style="background:#ffffff;border-radius:16px;padding:28px 26px;border:1px solid ${LINE}">
<h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;color:${INK}">${esc(l.heading)}</h1>
${l.paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:${INK}">${esc(p)}</p>`).join('\n')}
${facts}
${button}
${l.small ? `<p style="margin:18px 0 0;color:${MUTED};font-size:13px;line-height:1.5">${esc(l.small)}</p>` : ''}
</td></tr>
<tr><td style="padding:16px 8px 0;color:${MUTED};font-size:12px;line-height:1.6">
${contactBits.length ? `${esc(f.contact)}: ${contactBits.map(esc).join(' · ')}<br>` : ''}${esc(f.sentBy(l.brand.name))}<br>
<a href="${esc(l.brand.webUrl)}" style="color:${MUTED}">${esc(l.brand.webUrl)}</a>
</td></tr>
</table>
</td></tr></table>
</body>
</html>`;

  const text = [
    l.heading,
    '',
    ...l.paragraphs.flatMap((p) => [p, '']),
    ...(l.facts?.length ? [...l.facts.map((fact) => `${fact.label}: ${fact.value}`), ''] : []),
    ...(l.button ? [`${l.button.label}: ${l.button.url}`, ''] : []),
    ...(l.small ? [l.small, ''] : []),
    '--',
    ...(contactBits.length ? [`${f.contact}: ${contactBits.join(' · ')}`] : []),
    f.sentBy(l.brand.name),
    l.brand.webUrl,
  ].join('\n');

  return { html, text };
}

// --- account emails ----------------------------------------------------------------------------------------------------

interface AccountCopy {
  subject: string;
  heading: string;
  body: string;
  button: string;
  small: string;
}

const VERIFY: Record<EmailLocale, AccountCopy> = {
  es: {
    subject: 'Confirma tu correo',
    heading: 'Confirma tu correo',
    body: 'Para poder hacer pedidos necesitamos confirmar que este correo es tuyo. Solo tienes que tocar el botón.',
    button: 'Confirmar mi correo',
    small: 'Si no creaste una cuenta, ignora este mensaje: no pasa nada.',
  },
  en: {
    subject: 'Confirm your email',
    heading: 'Confirm your email',
    body: 'To place orders we need to confirm this email is yours. Just tap the button.',
    button: 'Confirm my email',
    small: 'If you did not create an account, ignore this message: nothing happens.',
  },
};

const RESET: Record<EmailLocale, AccountCopy> = {
  es: {
    subject: 'Restablece tu contraseña',
    heading: 'Restablece tu contraseña',
    body: 'Recibimos una solicitud para cambiar tu contraseña. El enlace sirve una sola vez y vale por aproximadamente una hora.',
    button: 'Elegir una contraseña nueva',
    small: 'Si no lo pediste, ignora este mensaje: tu contraseña no cambia.',
  },
  en: {
    subject: 'Reset your password',
    heading: 'Reset your password',
    body: 'We received a request to change your password. The link works once and is valid for about an hour.',
    button: 'Choose a new password',
    small: 'If you did not ask for it, ignore this message: your password stays the same.',
  },
};

function accountEmail(copy: Record<EmailLocale, AccountCopy>, locale: EmailLocale, brand: EmailBrand, link: string): RenderedEmail {
  const c = copy[locale];
  const { html, text } = renderLayout({
    locale,
    brand,
    preheader: c.body,
    heading: c.heading,
    paragraphs: [c.body],
    button: { label: c.button, url: link },
    small: c.small,
  });
  return { subject: `${c.subject} · ${brand.name}`, html, text };
}

export const verificationEmail = (locale: EmailLocale, brand: EmailBrand, link: string): RenderedEmail => accountEmail(VERIFY, locale, brand, link);
export const passwordResetEmail = (locale: EmailLocale, brand: EmailBrand, link: string): RenderedEmail => accountEmail(RESET, locale, brand, link);

// --- order emails ------------------------------------------------------------------------------------------------------

export type OrderEmailKind = 'placed' | 'paid' | 'out_for_delivery' | 'delivered' | 'cancelled' | 'refunded' | 'payment_reminder';

export interface OrderEmailData {
  buyerName: string | null;
  orderNumber: string;
  recipientName: string;
  /** The order page (payment instructions while unpaid, the delivery proof once delivered). */
  orderUrl: string;
  totalCents: number;
  subtotalCents?: number;
  deliveryFeeCents?: number;
  /** Already in the buyer's language. */
  items?: Array<{ name: string; quantity: number; unitLabel: string; lineTotalCents: number }>;
  /** Why a cancellation happened, when it was not the buyer's own doing. */
  cause?: 'unpaid';
  // The three below are only used to render a Resend TEMPLATE, where these pieces arrive as ready-made variables (a
  // greeting, the formatted total, the receipt rows as HTML). Ordinary sending leaves them out.
  greeting?: string;
  total?: string;
  receiptRows?: string;
}

/** The total as shown in the text: the formatted override when rendering a template, else money. */
const totalText = (d: OrderEmailData): string => d.total ?? usd(d.totalCents);

interface OrderCopy {
  subject: (n: string) => string;
  heading: (n: string) => string;
  paragraphs: (d: OrderEmailData) => string[];
  button: string;
  small?: string;
}

const ORDER_COPY: Record<EmailLocale, Record<OrderEmailKind, OrderCopy>> = {
  es: {
    placed: {
      subject: (n) => `Recibimos tu pedido #${n}`,
      heading: (n) => `Pedido #${n} recibido`,
      paragraphs: (d) => [
        `Gracias por tu pedido para ${d.recipientName}. Lo preparamos en cuanto recibamos tu pago.`,
        'En la página del pedido ves cómo pagar y el estado en que va.',
      ],
      button: 'Ver cómo pagar',
      small: 'Si no pagas en 3 días, el pedido se cancela solo.',
    },
    paid: {
      subject: (n) => `Recibimos tu pago, pedido #${n}`,
      heading: () => 'Recibimos tu pago',
      paragraphs: (d) => [`Estamos preparando el pedido #${d.orderNumber} para ${d.recipientName}. Te avisamos cuando salga.`],
      button: 'Ver el pedido',
    },
    out_for_delivery: {
      subject: (n) => `Tu pedido #${n} va en camino`,
      heading: () => 'Tu pedido va en camino',
      paragraphs: (d) => [`El pedido #${d.orderNumber} ya salió hacia ${d.recipientName}. Hoy mismo debería estar en sus manos.`],
      button: 'Seguir el pedido',
    },
    delivered: {
      subject: (n) => `Pedido #${n} entregado`,
      heading: () => 'Tu pedido fue entregado',
      paragraphs: (d) => [`${d.recipientName} recibió el pedido #${d.orderNumber}. Aquí puedes ver la confirmación de entrega, con la foto.`],
      button: 'Ver la confirmación de entrega',
    },
    cancelled: {
      subject: (n) => `Pedido #${n} cancelado`,
      heading: (n) => `Pedido #${n} cancelado`,
      paragraphs: (d) =>
        d.cause === 'unpaid'
          ? [
              `Cancelamos el pedido #${d.orderNumber} porque no recibimos el pago a tiempo.`,
              'Si ya enviaste el dinero, escríbenos con tu comprobante y lo revisamos enseguida. Si todavía quieres enviarlo, puedes hacer un pedido nuevo.',
            ]
          : [`El pedido #${d.orderNumber} para ${d.recipientName} quedó cancelado.`, 'Si ya habías enviado el dinero, escríbenos y lo resolvemos.'],
      button: 'Ver el pedido',
    },
    refunded: {
      subject: (n) => `Te devolvimos el dinero del pedido #${n}`,
      heading: () => 'Te devolvimos tu dinero',
      paragraphs: (d) => [
        `Reembolsamos ${totalText(d)} del pedido #${d.orderNumber}.`,
        'Según el método que usaste, puede tardar unos días en aparecer en tu cuenta. Si pasa una semana y no lo ves, escríbenos.',
      ],
      button: 'Ver el pedido',
    },
    payment_reminder: {
      subject: (n) => `Tu pedido #${n} sigue esperando el pago`,
      heading: () => 'Tu pedido sigue esperando el pago',
      paragraphs: (d) => [
        `El pedido #${d.orderNumber} para ${d.recipientName} todavía no está pagado. Si no lo recibimos pronto, se cancelará solo (en aproximadamente un día).`,
        `Total a pagar: ${totalText(d)}. Si ya lo enviaste, avísanos en la página del pedido y lo revisamos.`,
      ],
      button: 'Ver cómo pagar',
    },
  },
  en: {
    placed: {
      subject: (n) => `We received your order #${n}`,
      heading: (n) => `Order #${n} received`,
      paragraphs: (d) => [
        `Thank you for your order for ${d.recipientName}. We prepare it as soon as we receive your payment.`,
        'The order page shows how to pay and where it stands.',
      ],
      button: 'See how to pay',
      small: 'If it is not paid within 3 days, the order cancels itself.',
    },
    paid: {
      subject: (n) => `We received your payment, order #${n}`,
      heading: () => 'We received your payment',
      paragraphs: (d) => [`We are preparing order #${d.orderNumber} for ${d.recipientName}. We will tell you when it leaves.`],
      button: 'View the order',
    },
    out_for_delivery: {
      subject: (n) => `Your order #${n} is on its way`,
      heading: () => 'Your order is on its way',
      paragraphs: (d) => [`Order #${d.orderNumber} just left for ${d.recipientName}. It should be in their hands today.`],
      button: 'Follow the order',
    },
    delivered: {
      subject: (n) => `Order #${n} delivered`,
      heading: () => 'Your order was delivered',
      paragraphs: (d) => [`${d.recipientName} received order #${d.orderNumber}. Here is the delivery confirmation, with the photo.`],
      button: 'See the delivery confirmation',
    },
    cancelled: {
      subject: (n) => `Order #${n} cancelled`,
      heading: (n) => `Order #${n} cancelled`,
      paragraphs: (d) =>
        d.cause === 'unpaid'
          ? [
              `We cancelled order #${d.orderNumber} because we did not receive the payment in time.`,
              'If you already sent the money, write to us with your receipt and we will check it right away. If you still want to send it, you can place a new order.',
            ]
          : [`Order #${d.orderNumber} for ${d.recipientName} was cancelled.`, 'If you had already sent money, write to us and we will sort it out.'],
      button: 'View the order',
    },
    refunded: {
      subject: (n) => `We refunded your order #${n}`,
      heading: () => 'We refunded your money',
      paragraphs: (d) => [
        `We refunded ${totalText(d)} for order #${d.orderNumber}.`,
        'Depending on the method you used, it can take a few days to show in your account. If a week passes and you do not see it, write to us.',
      ],
      button: 'View the order',
    },
    payment_reminder: {
      subject: (n) => `Your order #${n} is still waiting for payment`,
      heading: () => 'Your order is still waiting for payment',
      paragraphs: (d) => [
        `Order #${d.orderNumber} for ${d.recipientName} is not paid yet. If we do not receive it soon, it will cancel itself (in about a day).`,
        `Amount to pay: ${totalText(d)}. If you already sent it, tell us on the order page and we will check.`,
      ],
      button: 'See how to pay',
    },
  },
};

const ORDER_LABELS = {
  es: { hello: (name: string | null) => (name ? `Hola ${name}.` : 'Hola.'), subtotal: 'Productos', delivery: 'Entrega', total: 'Total', free: 'Gratis' },
  en: { hello: (name: string | null) => (name ? `Hi ${name}.` : 'Hi.'), subtotal: 'Products', delivery: 'Delivery', total: 'Total', free: 'Free' },
} as const;

/** "Hola Ana." / "Hi Ana." (or without the name). */
export const orderGreeting = (locale: EmailLocale, name: string | null): string => ORDER_LABELS[locale].hello(name);

/** The receipt lines of an order-placed email. */
export function orderFacts(locale: EmailLocale, data: OrderEmailData): Fact[] {
  const label = ORDER_LABELS[locale];
  const facts: Fact[] = [];
  for (const item of data.items ?? []) {
    facts.push({ label: `${item.name} × ${item.quantity} · ${item.unitLabel}`, value: usd(item.lineTotalCents) });
  }
  if (data.subtotalCents !== undefined) facts.push({ label: label.subtotal, value: usd(data.subtotalCents) });
  if (data.deliveryFeeCents !== undefined) facts.push({ label: label.delivery, value: data.deliveryFeeCents === 0 ? label.free : usd(data.deliveryFeeCents) });
  facts.push({ label: label.total, value: usd(data.totalCents) });
  return facts;
}

export function orderEmail(kind: OrderEmailKind, locale: EmailLocale, brand: EmailBrand, data: OrderEmailData): RenderedEmail {
  const copy = ORDER_COPY[locale][kind];
  const label = ORDER_LABELS[locale];
  const { html, text } = renderLayout({
    locale,
    brand,
    preheader: copy.paragraphs(data)[0] ?? copy.heading(data.orderNumber),
    heading: copy.heading(data.orderNumber),
    paragraphs: [data.greeting ?? label.hello(data.buyerName), ...copy.paragraphs(data)],
    // A receipt is shown when the order is placed: what is in the box and what it costs.
    facts: kind === 'placed' && data.receiptRows === undefined ? orderFacts(locale, data) : undefined,
    factsRaw: kind === 'placed' ? data.receiptRows : undefined,
    button: { label: copy.button, url: data.orderUrl },
    small: copy.small,
  });
  return { subject: `${copy.subject(data.orderNumber)} · ${brand.name}`, html, text };
}

// --- the store's own alert ---------------------------------------------------------------------------------------------

export interface TransferAlertData {
  orderNumber: string;
  amountCents: number;
  /** The label of the method the buyer used (Zelle, Cash App, ...). */
  method: string;
  transferReference: string;
  adminUrl: string;
}

const ALERT: Record<EmailLocale, { subject: (n: string) => string; heading: string; body: (d: TransferAlertData) => string; check: string; button: string; method: string; amount: string; ref: string }> = {
  es: {
    subject: (n) => `Transferencia por revisar: pedido #${n}`,
    heading: 'Una transferencia espera tu revisión',
    body: (d) => `Un cliente avisó que envió ${usd(d.amountCents)} por ${d.method} para el pedido #${d.orderNumber}.`,
    check: 'Revisa tu cuenta; si ves el pago, marca el pedido como pagado.',
    button: 'Abrir los pedidos',
    method: 'Método',
    amount: 'Monto',
    ref: 'Confirmación',
  },
  en: {
    subject: (n) => `Transfer to check: order #${n}`,
    heading: 'A transfer is waiting for you to check',
    body: (d) => `A customer says they sent ${usd(d.amountCents)} with ${d.method} for order #${d.orderNumber}.`,
    check: 'Check your account; if you see the payment, mark the order as paid.',
    button: 'Open the orders',
    method: 'Method',
    amount: 'Amount',
    ref: 'Confirmation',
  },
};

export function transferAlertEmail(locale: EmailLocale, brand: EmailBrand, data: TransferAlertData): RenderedEmail {
  const c = ALERT[locale];
  const { html, text } = renderLayout({
    locale,
    brand,
    preheader: c.body(data),
    heading: c.heading,
    paragraphs: [c.body(data), c.check],
    facts: [
      { label: c.method, value: data.method },
      { label: c.amount, value: usd(data.amountCents) },
      { label: c.ref, value: data.transferReference },
    ],
    button: { label: c.button, url: data.adminUrl },
  });
  return { subject: `${c.subject(data.orderNumber)} · ${brand.name}`, html, text };
}

// --- the store's alerts about deliveries --------------------------------------------------------------------------------
//
// To the store's admins, in Spanish like the transfer alert: a new order came in, an order was delivered, or a courier
// could not (or would not) deliver. The same events also appear in the in-app bell.

export type StaffAlertKind = 'new_order' | 'delivered' | 'delivery_declined' | 'delivery_failed';

export interface StaffAlertData {
  orderNumber: string;
  courierName?: string;
  /** A delivery failure reason code (recipient_absent, ...), shown as words. */
  reason?: string;
  note?: string;
  adminUrl: string;
}

const FAILURE_REASON_ES: Record<string, string> = {
  recipient_absent: 'No había nadie',
  wrong_address: 'Dirección equivocada',
  refused: 'Rechazó el pedido',
  unreachable: 'No se pudo contactar',
  other: 'Otro motivo',
};

export function staffAlertEmail(kind: StaffAlertKind, brand: EmailBrand, data: StaffAlertData): RenderedEmail {
  const n = data.orderNumber;
  const who = data.courierName ?? 'El mensajero';
  const reason = data.reason ? (FAILURE_REASON_ES[data.reason] ?? data.reason) : null;
  const copy: Record<StaffAlertKind, { subject: string; heading: string; body: string[]; button: string }> = {
    new_order: {
      subject: `Pedido nuevo #${n}`,
      heading: `Pedido nuevo #${n}`,
      body: [`Entró el pedido #${n}. Todavía falta que el cliente pague.`],
      button: 'Abrir el pedido',
    },
    delivered: {
      subject: `Pedido #${n} entregado`,
      heading: `Pedido #${n} entregado`,
      body: [data.courierName ? `${data.courierName} entregó el pedido #${n}.` : `Se entregó el pedido #${n}.`],
      button: 'Ver el pedido',
    },
    delivery_declined: {
      subject: `${who} rechazó el pedido #${n}`,
      heading: `Un mensajero rechazó el pedido #${n}`,
      body: [`${who} no puede llevar el pedido #${n}.`, 'Dáselo a otro mensajero desde Reparto.'],
      button: 'Abrir Reparto',
    },
    delivery_failed: {
      subject: `No se pudo entregar el pedido #${n}`,
      heading: `No se pudo entregar el pedido #${n}`,
      body: [`${who} no pudo entregar el pedido #${n}.`, 'Decide: dárselo a otro mensajero, llamar al destinatario, o cancelar y reembolsar.'],
      button: 'Abrir Reparto',
    },
  };
  const c = copy[kind];
  const facts: Fact[] = [];
  if (reason) facts.push({ label: 'Motivo', value: reason });
  if (data.note) facts.push({ label: 'Nota', value: data.note });
  const { html, text } = renderLayout({
    locale: 'es',
    brand,
    preheader: c.body[0] ?? c.heading,
    heading: c.heading,
    paragraphs: c.body,
    facts,
    button: { label: c.button, url: data.adminUrl },
  });
  return { subject: `${c.subject} · ${brand.name}`, html, text };
}
