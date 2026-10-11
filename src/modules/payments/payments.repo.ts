import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Transaction } from '../../db/client.js';
import {
  manualPaymentMethods,
  paymentEvents,
  payments,
  type ManualPaymentMethod,
  type NewManualPaymentMethod,
  type NewPayment,
  type NewPaymentEvent,
  type Payment,
  type PaymentEvent,
} from './payments.schema.js';

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

// --- manual transfer methods ----------------------------------------------------------------

export async function listMethods(tx: Transaction, options: { onlyActive?: boolean } = {}): Promise<ManualPaymentMethod[]> {
  const where = options.onlyActive
    ? and(isNull(manualPaymentMethods.deletedAt), eq(manualPaymentMethods.active, true))
    : isNull(manualPaymentMethods.deletedAt);
  return tx.select().from(manualPaymentMethods).where(where).orderBy(asc(manualPaymentMethods.sortOrder), asc(manualPaymentMethods.createdAt));
}

export async function findMethodById(tx: Transaction, id: string): Promise<ManualPaymentMethod | undefined> {
  const [row] = await tx
    .select()
    .from(manualPaymentMethods)
    .where(and(eq(manualPaymentMethods.id, id), isNull(manualPaymentMethods.deletedAt)))
    .limit(1);
  return row;
}

// Counts removed rows too: a store that deleted its methods on purpose must not get the old ones back.
export async function countMethodsEver(tx: Transaction): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(manualPaymentMethods);
  return row?.n ?? 0;
}

export async function nextMethodSortOrder(tx: Transaction): Promise<number> {
  const [row] = await tx.select({ max: sql<number | null>`max(${manualPaymentMethods.sortOrder})` }).from(manualPaymentMethods);
  return (row?.max ?? -1) + 1;
}

export async function insertMethod(tx: Transaction, values: NewManualPaymentMethod): Promise<ManualPaymentMethod> {
  const [row] = await tx.insert(manualPaymentMethods).values(values).returning();
  if (!row) {
    throw new Error('Insert into manual_payment_methods returned no row');
  }
  return row;
}

// Undefined fields are skipped; null clears a nullable column.
export async function updateMethod(tx: Transaction, id: string, values: Partial<NewManualPaymentMethod>): Promise<ManualPaymentMethod | undefined> {
  const [row] = await tx
    .update(manualPaymentMethods)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(manualPaymentMethods.id, id), isNull(manualPaymentMethods.deletedAt)))
    .returning();
  return row;
}

export async function softDeleteMethod(tx: Transaction, id: string): Promise<boolean> {
  const rows = await tx
    .update(manualPaymentMethods)
    .set({ deletedAt: new Date(), active: false, updatedAt: new Date() })
    .where(and(eq(manualPaymentMethods.id, id), isNull(manualPaymentMethods.deletedAt)))
    .returning({ id: manualPaymentMethods.id });
  return rows.length > 0;
}

export async function setMethodSortOrder(tx: Transaction, id: string, sortOrder: number): Promise<boolean> {
  const rows = await tx
    .update(manualPaymentMethods)
    .set({ sortOrder, updatedAt: new Date() })
    .where(and(eq(manualPaymentMethods.id, id), isNull(manualPaymentMethods.deletedAt)))
    .returning({ id: manualPaymentMethods.id });
  return rows.length > 0;
}

// Serialises "import the old environment accounts once" when two requests arrive together.
export async function lockMethodsImport(tx: Transaction, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'manual-methods-import:' + tenantId}))`);
}

// The orders that have at least one report of this type (for the admin's "transfers to check" filter).
export async function findOrderIdsWithEvent(tx: Transaction, eventType: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ orderId: payments.orderId })
    .from(paymentEvents)
    .innerJoin(payments, eq(paymentEvents.paymentId, payments.id))
    .where(eq(paymentEvents.eventType, eventType));
  return rows.map((row) => row.orderId);
}
