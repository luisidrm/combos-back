// All SQL for the fulfilment module's tables lives here — nothing else touches
// them. Every function takes `tx: Transaction` as its first argument;
// repos never open connections (CLAUDE.md section 5).
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../../db/client.js';
import {
  courierAssignments,
  couriers,
  deliveries,
  openAssignmentStatuses,
  type AssignmentStatus,
  type Courier,
  type CourierAssignment,
  type Delivery,
  type NewCourierAssignment,
  type NewDelivery,
} from './fulfilment.schema.js';

export async function findByOrder(tx: Transaction, orderId: string): Promise<Delivery | undefined> {
  const [row] = await tx.select().from(deliveries).where(eq(deliveries.orderId, orderId)).limit(1);
  return row;
}

// One delivery per order (unique index). Confirming twice — a courier retrying after a dropped
// connection — updates the same row rather than failing or duplicating it.
export async function upsertDelivery(tx: Transaction, values: NewDelivery): Promise<Delivery> {
  const [row] = await tx
    .insert(deliveries)
    .values(values)
    .onConflictDoUpdate({
      target: [deliveries.tenantId, deliveries.orderId],
      set: {
        deliveredByUserId: values.deliveredByUserId,
        recipientNameConfirmed: values.recipientNameConfirmed,
        notes: values.notes,
        deliveredAt: values.deliveredAt,
      },
    })
    .returning();
  if (!row) throw new Error('Delivery upsert returned no row');
  return row;
}

// --- couriers ---------------------------------------------------------------------------------------------------

// A courier row is made the first time someone with the courier role is dispatched or listed (the Team screen owns
// the account itself); the unique index keeps one row per person even if two requests race.
export async function ensureCourier(tx: Transaction, tenantId: string, userId: string, phone: string): Promise<Courier> {
  await tx.insert(couriers).values({ tenantId, userId, phone }).onConflictDoNothing();
  const [row] = await tx.select().from(couriers).where(eq(couriers.userId, userId)).limit(1);
  if (!row) throw new Error('Courier upsert returned no row');
  return row;
}

export async function findCourier(tx: Transaction, courierId: string): Promise<Courier | undefined> {
  const [row] = await tx.select().from(couriers).where(eq(couriers.id, courierId)).limit(1);
  return row;
}

export async function findCourierByUser(tx: Transaction, userId: string): Promise<Courier | undefined> {
  const [row] = await tx.select().from(couriers).where(eq(couriers.userId, userId)).limit(1);
  return row;
}

// --- assignments ------------------------------------------------------------------------------------------------

export async function insertAssignment(tx: Transaction, values: NewCourierAssignment): Promise<CourierAssignment> {
  const [row] = await tx.insert(courierAssignments).values(values).returning();
  if (!row) throw new Error('Assignment insert returned no row');
  return row;
}

export async function findAssignment(tx: Transaction, id: string): Promise<CourierAssignment | undefined> {
  const [row] = await tx.select().from(courierAssignments).where(eq(courierAssignments.id, id)).limit(1);
  return row;
}

export async function findOpenAssignmentByOrder(tx: Transaction, orderId: string): Promise<CourierAssignment | undefined> {
  const [row] = await tx
    .select()
    .from(courierAssignments)
    .where(and(eq(courierAssignments.orderId, orderId), inArray(courierAssignments.status, [...openAssignmentStatuses])))
    .limit(1);
  return row;
}

// The order's attempts, newest first.
export async function listAssignmentsByOrder(tx: Transaction, orderId: string): Promise<CourierAssignment[]> {
  return tx.select().from(courierAssignments).where(eq(courierAssignments.orderId, orderId)).orderBy(desc(courierAssignments.createdAt));
}

export async function updateAssignment(
  tx: Transaction,
  id: string,
  values: Partial<Pick<CourierAssignment, 'status' | 'reason' | 'note' | 'acceptedAt' | 'pickedUpAt' | 'closedAt'>>,
): Promise<CourierAssignment | undefined> {
  const [row] = await tx
    .update(courierAssignments)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(courierAssignments.id, id))
    .returning();
  return row;
}

// Order ids that have an open assignment (optionally of one courier).
export async function listOpenOrderIds(tx: Transaction, courierId?: string): Promise<string[]> {
  const conditions = [inArray(courierAssignments.status, [...openAssignmentStatuses])];
  if (courierId) conditions.push(eq(courierAssignments.courierId, courierId));
  const rows = await tx.selectDistinct({ orderId: courierAssignments.orderId }).from(courierAssignments).where(and(...conditions));
  return rows.map((r) => r.orderId);
}

// The latest assignment per order, for the orders on screen.
export async function latestAssignmentsFor(tx: Transaction, orderIds: string[]): Promise<CourierAssignment[]> {
  if (orderIds.length === 0) return [];
  return tx
    .selectDistinctOn([courierAssignments.orderId])
    .from(courierAssignments)
    .where(inArray(courierAssignments.orderId, orderIds))
    .orderBy(courierAssignments.orderId, desc(courierAssignments.createdAt));
}

// Orders whose most recent assignment ended badly (declined or failed): the "problems" lane. The caller drops the ones
// that have since been given to someone else (they then have an open assignment).
export async function listProblemOrderIds(tx: Transaction): Promise<string[]> {
  const rows = await tx
    .selectDistinctOn([courierAssignments.orderId], { orderId: courierAssignments.orderId, status: courierAssignments.status })
    .from(courierAssignments)
    .orderBy(courierAssignments.orderId, desc(courierAssignments.createdAt));
  return rows.filter((r) => r.status === 'declined' || r.status === 'failed').map((r) => r.orderId);
}

// Open and delivered assignments per courier, for the dispatch picker.
export async function workloadByCourier(tx: Transaction): Promise<Map<string, { open: number; delivered: number }>> {
  const rows = await tx
    .select({ courierId: courierAssignments.courierId, status: courierAssignments.status, n: sql<number>`count(*)::int` })
    .from(courierAssignments)
    .groupBy(courierAssignments.courierId, courierAssignments.status);
  const map = new Map<string, { open: number; delivered: number }>();
  for (const r of rows) {
    const entry = map.get(r.courierId) ?? { open: 0, delivered: 0 };
    if ((openAssignmentStatuses as readonly string[]).includes(r.status)) entry.open += r.n;
    if ((r.status as AssignmentStatus) === 'delivered') entry.delivered += r.n;
    map.set(r.courierId, entry);
  }
  return map;
}

export async function listCouriers(tx: Transaction): Promise<Courier[]> {
  return tx.select().from(couriers);
}

export async function setDeliveryCourier(tx: Transaction, orderId: string, courierId: string): Promise<void> {
  await tx.update(deliveries).set({ courierId }).where(eq(deliveries.orderId, orderId));
}
