import { Resend } from 'resend';
import { config } from '../../config/index.js';
import { InternalError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

const resend = new Resend(config.resendApiKey);

// The "confirm your email" link sent once after a buyer signs up (and again on
// request). Called from the SuperTokens email-delivery hook in core/supertokens.ts.
//
// When sending is off (the default outside production, see SEND_EMAILS) nothing is emailed — the link goes to the log, so the flow
// works without a real Resend key or a verified domain. The address is
// deliberately not logged (CLAUDE.md section 13: no PII).
async function sendEmailVerificationLink(email: string, link: string): Promise<void> {
  if (!config.sendEmails) {
    logger.info({ link }, 'Email verification link (dev only, not emailed)');
    return;
  }

  const { error } = await resend.emails.send({
    from: config.emailFrom,
    to: email,
    subject: 'Confirma tu correo / Confirm your email',
    text: [
      'Confirma tu correo para poder hacer pedidos:',
      link,
      '',
      'Confirm your email so you can place orders:',
      link,
      '',
      'Si no creaste una cuenta, ignora este mensaje. / If you did not create an account, ignore this message.',
    ].join('\n'),
  });
  if (error) {
    throw new InternalError(`Could not send email verification message: ${error.message}`);
  }
}

// The password-reset link for accounts with a password. The link carries a
// single-use secret token that is valid for about an hour.
//
// Same rules as the login code: outside production nothing is emailed and the
// link goes to the log, so the flow can be tried without a Resend key. That is
// the one place a token is logged — never in production, and never the address.
async function sendPasswordResetLink(email: string, link: string): Promise<void> {
  if (!config.sendEmails) {
    logger.info({ link }, 'Password reset link (dev only, not emailed)');
    return;
  }

  const { error } = await resend.emails.send({
    from: config.emailFrom,
    to: email,
    subject: 'Restablecer tu contraseña / Reset your password',
    text: [
      'Recibimos una solicitud para restablecer tu contraseña. Usa este enlace (vale por aproximadamente una hora):',
      link,
      '',
      'We received a request to reset your password. Use this link (valid for about an hour):',
      link,
      '',
      'Si no lo pediste, ignora este mensaje: tu contraseña no cambia. / If you did not request it, ignore this message: your password stays the same.',
    ].join('\n'),
  });
  if (error) {
    throw new InternalError(`Could not send password reset email: ${error.message}`);
  }
}

export type OrderEmailStatus = 'paid' | 'out_for_delivery' | 'delivered';

export interface OrderEmail {
  buyerName: string | null;
  orderNumber: string;
  status: OrderEmailStatus;
  recipientName: string;
  orderUrl: string;
}

// Bilingual like the other messages: buyers in Miami read Spanish, their children often English.
// Delivered points to the order page, where the proof photo is shown (CLAUDE.md section 12).
function orderEmailContent(mail: OrderEmail): { subject: string; lines: string[] } {
  const hello = mail.buyerName ? `Hola ${mail.buyerName} / Hi ${mail.buyerName}` : 'Hola / Hi';
  const n = `#${mail.orderNumber}`;
  if (mail.status === 'paid') {
    return {
      subject: `Recibimos tu pago, pedido ${n} / We received your payment, order ${n}`,
      lines: [
        hello,
        '',
        `Recibimos tu pago. Estamos preparando el pedido ${n} para ${mail.recipientName}.`,
        `We received your payment. We are preparing order ${n} for ${mail.recipientName}.`,
        '',
        mail.orderUrl,
      ],
    };
  }
  if (mail.status === 'out_for_delivery') {
    return {
      subject: `Tu pedido ${n} va en camino / Your order ${n} is on its way`,
      lines: [
        hello,
        '',
        `El pedido ${n} ya salió hacia ${mail.recipientName}.`,
        `Order ${n} is on its way to ${mail.recipientName}.`,
        '',
        mail.orderUrl,
      ],
    };
  }
  return {
    subject: `Pedido ${n} entregado / Order ${n} delivered`,
    lines: [
      hello,
      '',
      `El pedido ${n} fue entregado a ${mail.recipientName}. Mira la confirmación de entrega aquí:`,
      `Order ${n} was delivered to ${mail.recipientName}. See the delivery confirmation here:`,
      '',
      mail.orderUrl,
    ],
  };
}

// A status update about an order. Outside production nothing is emailed and the event is logged
// without the address or names (CLAUDE.md section 13: no PII).
async function sendOrderStatusEmail(email: string, mail: OrderEmail): Promise<void> {
  if (!config.sendEmails) {
    logger.info({ orderNumber: mail.orderNumber, status: mail.status }, 'Order status email (dev only, not emailed)');
    return;
  }
  const { subject, lines } = orderEmailContent(mail);
  const { error } = await resend.emails.send({ from: config.emailFrom, to: email, subject, text: lines.join('\n') });
  if (error) {
    throw new InternalError(`Could not send order status email: ${error.message}`);
  }
}

// Business logic for Resend templates, wa.me deep link helpers.
// This is the ONLY public surface other modules may import (via index.ts).
export const notificationsService = { sendEmailVerificationLink, sendPasswordResetLink, sendOrderStatusEmail };
