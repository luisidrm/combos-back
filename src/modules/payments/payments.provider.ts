import type { Request } from 'express';

// What a provider needs to build a checkout session. Deliberately a small,
// provider-owned shape (not orders.Order) — orders builds one of these from
// its own data when it calls a provider; payments never imports orders'
// schema or service (CLAUDE.md section 4's boundary rule applies between
// sibling modules too).
export interface CheckoutOrder {
  paymentId: string;
  tenantId: string;
  orderId: string;
  orderNumber: string;
  amountCents: number;
  currency: string;
  description: string;
  buyerEmail: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  // Where the buyer is sent to pay.
  redirectUrl: string;
  // The provider's own id for this checkout/charge, stored on the payment
  // row so later webhooks and status checks can be matched back to it.
  externalPaymentId: string;
}

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded';

// What a verified webhook tells the caller. Named WebhookResult, not
// PaymentEvent, to keep it distinct from payments.schema.ts's PaymentEvent
// (the persisted DB row) — this is the parsed, verified shape a provider
// hands back before anything is written. Carries tenantId — a webhook
// request has no x-tenant-slug header (the provider doesn't know our
// convention), so this is how the route handler knows which tenant to run
// the rest of the work under, without ever bypassing RLS. See
// TropiPayProvider.verifyWebhook for how tenantId is recovered.
export interface WebhookResult {
  tenantId: string;
  paymentId: string;
  providerEventId: string;
  eventType: string;
  status: PaymentStatus;
  amountCents: number;
  // Stored on the payment_events row verbatim, for debugging a dispute
  // without needing to have kept the provider's own logs.
  rawPayload: unknown;
}

export interface RefundResult {
  refundId: string;
  status: 'pending' | 'completed' | 'failed';
}

// Order logic (modules/orders) must never reference a specific provider —
// only this interface. Never Stripe/PayPal/Square/Braintree (CLAUDE.md
// section 2, hard constraint).
export interface PaymentProvider {
  createCheckout(order: CheckoutOrder): Promise<CheckoutSession>;
  verifyWebhook(req: Request): Promise<WebhookResult>;
  getStatus(externalPaymentId: string): Promise<PaymentStatus>;
  refund(externalPaymentId: string, amountCents: number): Promise<RefundResult>;
}
