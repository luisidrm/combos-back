import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Transaction } from '../../db/client.js';
import { paymentEvents, payments, type NewPayment, type NewPaymentEvent, type Payment, type PaymentEvent } from './payments.schema.js';

// All SQL for the payments module's tables lives here — nothing else
// touches them. Every function takes `tx: Transaction` as its first
// argument; repos never open connections (CLAUDE.md section 5).

export async function insert(tx: Transaction, values: NewPayment): Promise<Payment> {
  const [row] = await tx.insert(payments).values(values).returning();
  if (!row) {
    throw new Error('Insert into payments returned no row');
  }
  return row;
}

export async function findById(tx: Transaction, id: string): Promise<Payment | undefined> {
  const [row] = await tx.select().from(payments).where(eq(payments.id, id)).limit(1);
  return row;
}

// One order may in principle get more than one payment row over time (a
// failed checkout followed by a retry with a different provider); the most
// recent is the one anything current cares about.
export async function findLatestByOrderId(tx: Transaction, orderId: string): Promise<Payment | undefined> {
  const [row] = await tx.select().from(payments).where(eq(payments.orderId, orderId)).orderBy(desc(payments.createdAt)).limit(1);
  return row;
}

export async function updateStatus(tx: Transaction, id: string, status: string): Promise<Payment | undefined> {
  const [row] = await tx.update(payments).set({ status, updatedAt: new Date() }).where(eq(payments.id, id)).returning();
  return row;
}

export async function setExternalId(tx: Transaction, id: string, externalPaymentId: string): Promise<void> {
  await tx.update(payments).set({ externalPaymentId, updatedAt: new Date() }).where(eq(payments.id, id));
}

// Reconciliation reads orders, not payments, directly (see orders.repo's
// findStuckPendingPayments) — this stays here for completeness and for any
// future admin "payment history" read.
export async function listByTenantAndStatus(tx: Transaction, status: string): Promise<Payment[]> {
  return tx.select().from(payments).where(eq(payments.status, status));
}

// Idempotency (CLAUDE.md section 6): a duplicate provider event is a no-op.
// ON CONFLICT DO NOTHING plus `.returning()` tells the caller which case
// happened — an empty result means this event_id was already recorded, so
// nothing here should run twice (marking a payment paid, sending a receipt).
export async function insertEventIfNew(tx: Transaction, values: NewPaymentEvent): Promise<PaymentEvent | undefined> {
  const [row] = await tx
    .insert(paymentEvents)
    .values(values)
    .onConflictDoNothing({ target: [paymentEvents.tenantId, paymentEvents.providerEventId] })
    .returning();
  return row;
}

export async function markEventProcessed(tx: Transaction, id: string): Promise<void> {
  await tx.update(paymentEvents).set({ processedAt: new Date() }).where(eq(paymentEvents.id, id));
}

// Manual transfers: what the buyer reported (method, confirmation number, note) is stored as an
// event on the payment, newest wins. Returns each order's latest report with its order id.
export async function findLatestReports(
  tx: Transaction,
  eventType: string,
  orderIds: string[],
): Promise<Array<{ orderId: string; payload: unknown; createdAt: Date }>> {
  if (orderIds.length === 0) return [];
  const rows = await tx
    .select({ orderId: payments.orderId, payload: paymentEvents.payload, createdAt: paymentEvents.createdAt })
    .from(paymentEvents)
    .innerJoin(payments, eq(paymentEvents.paymentId, payments.id))
    .where(and(eq(paymentEvents.eventType, eventType), inArray(payments.orderId, orderIds)))
    .orderBy(desc(paymentEvents.createdAt));
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.orderId) ? false : (seen.add(row.orderId), true)));
}
