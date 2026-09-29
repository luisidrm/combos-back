import { events } from '../../core/events.js';
import { logger } from '../../core/logger.js';
import { ordersService } from './orders.service.js';

interface PaymentReactedPayload extends Record<string, unknown> {
  tenantId: string;
  orderId: string;
  paymentId: string;
}

// payments.service verifies and records a webhook itself (its own module's
// tables), then emits these — orders reacts here rather than payments.routes
// calling ordersService directly, which would make payments and orders
// import each other's service and create the exact cross-module cycle
// CLAUDE.md section 4 says to avoid with the event bus. Idempotent: the
// order's own transition() is a no-op if it's already in the target status,
// so a redelivered event (or one arriving just after reconciliation already
// caught the same payment) does nothing the second time.
async function handlePaymentPaid({ tenantId, orderId }: PaymentReactedPayload): Promise<void> {
  await ordersService.handlePaymentConfirmed(tenantId, orderId);
}

async function handlePaymentRefunded({ tenantId, orderId }: PaymentReactedPayload): Promise<void> {
  await ordersService.handlePaymentRefunded(tenantId, orderId);
}

export function registerOrdersWorker(): void {
  events.on<PaymentReactedPayload>('payment.paid', handlePaymentPaid);
  events.on<PaymentReactedPayload>('payment.refunded', handlePaymentRefunded);
}

// The 24h/72h reconciliation pass (CLAUDE.md section 6). Runs per tenant,
// same shape as the media/cart maintenance sweeps — a maintenance job has no
// request behind it, so no tenant context of its own; the worker's
// scheduler walks the active tenants and runs this inside each.
export async function runOrderReconciliation(tenantId: string): Promise<void> {
  const result = await ordersService.reconcilePendingPayments(tenantId);
  if (result.checked > 0) {
    logger.info({ tenantId, ...result }, 'Order reconciliation pass finished for a tenant');
  }
}
