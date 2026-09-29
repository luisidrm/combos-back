import type { Request } from 'express';
import { InternalError } from '../../../core/errors.js';
import type {
  CheckoutOrder,
  CheckoutSession,
  PaymentProvider,
  PaymentStatus,
  RefundResult,
  WebhookResult,
} from '../payments.provider.js';

// The buyer transfers directly (bank/remittance/WhatsApp-arranged cash) and
// an admin confirms receipt from the admin panel — there is no external
// payment gateway here, no redirect, and no webhook. Every method below is
// correspondingly a no-op or a stub: our own `payments.status` column, kept
// current by orders.service's admin-facing mark-paid/refund actions, IS the
// status. Nothing external to poll or verify, so nothing here touches the
// database (ordersService.reconciliation skips calling getStatus for this
// provider entirely, rather than forcing a tenant-less read through it —
// see its comment for why).
export class ManualTransferProvider implements PaymentProvider {
  // No redirect: the buyer stays on our own "how to pay" screen. Our own
  // payment id doubles as the reference to put in the transfer memo — there
  // is no separate provider-side id to have instead.
  async createCheckout(order: CheckoutOrder): Promise<CheckoutSession> {
    return { redirectUrl: '', externalPaymentId: order.paymentId };
  }

  // Never called in normal operation — no webhook route is registered for
  // this provider (see payments.routes.ts). Present only to satisfy the
  // interface.
  async verifyWebhook(_req: Request): Promise<WebhookResult> {
    throw new InternalError('ManualTransferProvider has no webhooks — status is set by an admin action');
  }

  // Never called — see the class comment.
  async getStatus(_externalPaymentId: string): Promise<PaymentStatus> {
    throw new InternalError('ManualTransferProvider has no external status to poll');
  }

  // A manual transfer is refunded manually too: the operator sends the
  // money back themselves and marks it in the admin panel, which updates
  // the order/payment directly (orders.service's refund()) — there is
  // nothing for a provider to call out to, so this immediately reports
  // done rather than pretending to start an asynchronous process.
  async refund(_externalPaymentId: string, _amountCents: number): Promise<RefundResult> {
    return { refundId: '', status: 'completed' };
  }
}
