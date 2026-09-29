import type { Request } from 'express';
import { auditService } from '../audit/index.js';
import { events } from '../../core/events.js';
import { logger } from '../../core/logger.js';
import { ConflictError, NotFoundError } from '../../core/errors.js';
import { withTenant, type Transaction } from '../../db/client.js';
import * as paymentsRepo from './payments.repo.js';
import { ManualTransferProvider } from './providers/manual-transfer.provider.js';
import { TropiPayProvider } from './providers/tropipay.provider.js';
import type { Payment } from './payments.schema.js';
import type { PaymentProvider, WebhookResult } from './payments.provider.js';

const providers: Record<string, PaymentProvider> = {
  tropipay: new TropiPayProvider(),
  manual: new ManualTransferProvider(),
};

function getProvider(name: string): PaymentProvider {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unknown payment provider "${name}"`);
  }
  return provider;
}

// Takes the caller's own transaction, the same pattern as auditService.record
// — orders.service creates the order, its items, this payment row, and an
// audit entry all in one atomic write (CLAUDE.md section 6's "order +
// payment + audit log in one transaction"), before ever calling out to the
// provider itself (see orders.service.checkout for why that call happens
// after this transaction commits, not inside it).
async function createPendingPayment(
  tx: Transaction,
  input: { tenantId: string; orderId: string; provider: string; amountCents: number; currency: string },
): Promise<Payment> {
  return paymentsRepo.insert(tx, {
    tenantId: input.tenantId,
    orderId: input.orderId,
    provider: input.provider,
    status: 'pending',
    amountCents: input.amountCents,
    currency: input.currency,
  });
}

// Called once the provider's own checkout call (outside any transaction) has
// returned successfully. Best-effort by design — the payment row is
// meaningful even without this (its provider/amount/status already say
// enough for a human to sort out), so a transient failure here is logged by
// the caller, not raised as the checkout having failed.
async function attachExternalId(tx: Transaction, paymentId: string, externalPaymentId: string): Promise<void> {
  await paymentsRepo.setExternalId(tx, paymentId, externalPaymentId);
}

async function getLatestForOrder(tx: Transaction, orderId: string): Promise<Payment> {
  const row = await paymentsRepo.findLatestByOrderId(tx, orderId);
  if (!row) {
    throw new NotFoundError(`No payment for order "${orderId}"`);
  }
  return row;
}

async function markStatus(tx: Transaction, paymentId: string, status: string): Promise<Payment> {
  const row = await paymentsRepo.updateStatus(tx, paymentId, status);
  if (!row) {
    throw new NotFoundError(`No payment with id "${paymentId}"`);
  }
  return row;
}

// --- webhooks ---------------------------------------------------------------
//
// Verifies the request came from the named provider and is genuine, before
// anything about its content is trusted (CLAUDE.md section 6). Providers
// with no webhooks (manual transfer) simply have no route calling this.
async function verifyWebhook(providerName: string, req: Request): Promise<WebhookResult> {
  try {
    return await getProvider(providerName).verifyWebhook(req);
  } catch (err) {
    if (err instanceof ConflictError) {
      throw err;
    }
    throw new ConflictError('Could not verify webhook', { cause: err instanceof Error ? err.message : String(err) });
  }
}

// What orders.service's worker-registered subscriber should do once this
// commits, or undefined when nothing about the order needs to change (an
// already-processed duplicate, an amount mismatch, or a status the order
// doesn't react to).
export interface WebhookOutcome {
  tenantId: string;
  orderId: string;
  paymentId: string;
  reaction: 'paid' | 'refunded';
}

// The whole webhook, start to finish: idempotent recording, the "never trust
// the webhook's amount" check (against this payment's own amountCents, which
// is the order's total as it stood at checkout — CLAUDE.md section 6),
// updating the payment row, and an audit entry — all in one transaction, so
// a crash between recording the event and acting on it can never let the
// same delivery be acted on twice. Emitting the order-facing event happens
// AFTER that commits, from the returned outcome — never from inside the
// transaction, since a job enqueued from a transaction that then rolls back
// would fire for work that never actually happened.
async function processWebhook(providerName: string, req: Request): Promise<WebhookOutcome | undefined> {
  const result = await verifyWebhook(providerName, req);

  const outcome = await withTenant(result.tenantId, async (tx): Promise<WebhookOutcome | undefined> => {
    // Checked before recording the event, not after: payment_events.payment_id
    // is a real FK to payments.id (same-module reference, CLAUDE.md section
    // 5), so a webhook naming a payment that doesn't exist would otherwise
    // fail the INSERT itself with a constraint violation instead of being
    // logged and acknowledged gracefully.
    const payment = await paymentsRepo.findById(tx, result.paymentId);
    if (!payment) {
      logger.error({ paymentId: result.paymentId }, 'Webhook referenced a payment that does not exist');
      return undefined;
    }

    const recorded = await paymentsRepo.insertEventIfNew(tx, {
      tenantId: result.tenantId,
      paymentId: result.paymentId,
      providerEventId: result.providerEventId,
      eventType: result.eventType,
      payload: result.rawPayload as object,
    });
    if (!recorded) {
      // Already recorded and acted on by an earlier delivery of this exact
      // event — a no-op that still answers 200 (CLAUDE.md section 6).
      return undefined;
    }

    if (payment.amountCents !== result.amountCents) {
      await auditService.record(tx, {
        tenantId: result.tenantId,
        entityType: 'payment',
        entityId: payment.id,
        action: 'payment.amount_mismatch',
        note: `Webhook reported ${result.amountCents} cents; expected ${payment.amountCents}`,
      });
      await paymentsRepo.markEventProcessed(tx, recorded.id);
      logger.error({ paymentId: payment.id, reported: result.amountCents, expected: payment.amountCents }, 'Webhook amount mismatch — payment left unchanged');
      return undefined;
    }

    if (payment.status !== result.status) {
      await paymentsRepo.updateStatus(tx, payment.id, result.status);
      await auditService.record(tx, {
        tenantId: result.tenantId,
        entityType: 'payment',
        entityId: payment.id,
        action: `payment.${result.status}`,
        note: 'Reported by provider webhook',
      });
    }
    await paymentsRepo.markEventProcessed(tx, recorded.id);

    if (result.status === 'paid' || result.status === 'refunded') {
      return { tenantId: result.tenantId, orderId: payment.orderId, paymentId: payment.id, reaction: result.status };
    }
    return undefined;
  });

  if (outcome) {
    await events.emit(`payment.${outcome.reaction}`, {
      tenantId: outcome.tenantId,
      orderId: outcome.orderId,
      paymentId: outcome.paymentId,
    });
  }
  return outcome;
}

// The only public surface other modules may depend on (via index.ts).
export const paymentsService = {
  getProvider,
  createPendingPayment,
  attachExternalId,
  getLatestForOrder,
  markStatus,
  processWebhook,
};
