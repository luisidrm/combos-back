import type { Request } from 'express';
import { config } from '../../../config/index.js';
import type { CheckoutSession, Order, PaymentEvent, PaymentProvider, PaymentStatus, RefundResult } from '../payments.provider.js';

// TropiPay Business Open API v3 (EU-regulated). Sandbox available.
// TODO(M3): wire the actual TropiPay TS/JS SDK — this is a structural
// stub so PaymentProvider has a second real implementation to type-check
// against alongside ManualTransferProvider.
export class TropiPayProvider implements PaymentProvider {
  constructor(private readonly clientId = config.tropipay.clientId, private readonly clientSecret = config.tropipay.clientSecret) {}

  async createCheckout(_order: Order): Promise<CheckoutSession> {
    throw new Error('TropiPayProvider.createCheckout not implemented yet (M3)');
  }

  async verifyWebhook(_req: Request): Promise<PaymentEvent> {
    throw new Error('TropiPayProvider.verifyWebhook not implemented yet (M3)');
  }

  async getStatus(_paymentId: string): Promise<PaymentStatus> {
    throw new Error('TropiPayProvider.getStatus not implemented yet (M3)');
  }

  async refund(_paymentId: string, _amountCents: number): Promise<RefundResult> {
    throw new Error('TropiPayProvider.refund not implemented yet (M3)');
  }
}
