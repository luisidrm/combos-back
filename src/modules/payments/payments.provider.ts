import type { Request } from 'express';

// TODO(M3): replace with the real type exported from modules/orders once
// orders.schema.ts lands — order snapshotting (CLAUDE.md section 5) means
// this is exactly what a provider needs to build a checkout session from.
export interface Order {
  id: string;
  tenantId: string;
  totalCents: number;
  currency: string;
}

export interface CheckoutSession {
  paymentId: string;
  redirectUrl: string;
}

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded';

export interface PaymentEvent {
  providerEventId: string;
  paymentId: string;
  status: PaymentStatus;
  amountCents: number;
}

export interface RefundResult {
  refundId: string;
  status: 'pending' | 'completed' | 'failed';
}

// Order logic (modules/orders) must never reference a specific provider —
// only this interface. Never Stripe/PayPal/Square/Braintree (CLAUDE.md
// section 2, hard constraint).
export interface PaymentProvider {
  createCheckout(order: Order): Promise<CheckoutSession>;
  verifyWebhook(req: Request): Promise<PaymentEvent>;
  getStatus(paymentId: string): Promise<PaymentStatus>;
  refund(paymentId: string, amountCents: number): Promise<RefundResult>;
}
