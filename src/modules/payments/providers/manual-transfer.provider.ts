import type { Request } from 'express';
import type { CheckoutSession, Order, PaymentEvent, PaymentProvider, PaymentStatus, RefundResult } from '../payments.provider.js';

// Buyer transfers directly (bank/remittance) and an admin confirms receipt
// manually from the admin panel. No webhook to verify — status transitions
// are admin-driven, so verifyWebhook is unreachable in normal operation.
// TODO(M3): implement against the payments/payment_events tables once they
// land.
export class ManualTransferProvider implements PaymentProvider {
  async createCheckout(_order: Order): Promise<CheckoutSession> {
    throw new Error('ManualTransferProvider.createCheckout not implemented yet (M3)');
  }

  async verifyWebhook(_req: Request): Promise<PaymentEvent> {
    throw new Error('ManualTransferProvider has no webhooks — status is set by an admin action');
  }

  async getStatus(_paymentId: string): Promise<PaymentStatus> {
    throw new Error('ManualTransferProvider.getStatus not implemented yet (M3)');
  }

  async refund(_paymentId: string, _amountCents: number): Promise<RefundResult> {
    throw new Error('ManualTransferProvider.refund not implemented yet (M3)');
  }
}
