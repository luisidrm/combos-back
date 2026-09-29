import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Transaction } from '../../db/client.js';
import {
  addresses,
  orderItems,
  orders,
  recipients,
  type Address,
  type NewAddress,
  type NewOrder,
  type NewOrderItem,
  type NewRecipient,
  type Order,
  type OrderItem,
  type Recipient,
} from './orders.schema.js';

// All SQL for the orders module's tables lives here — nothing else touches
// them. Every function takes `tx: Transaction` as its first argument;
// repos never open connections (CLAUDE.md section 5). Recipient queries are
// always scoped to the owning buyer as well as the tenant (RLS): one buyer's
// address book is invisible to another buyer in the same store.

// --- recipients -----------------------------------------------------------

export async function listRecipients(tx: Transaction, buyerUserId: string): Promise<Recipient[]> {
  return tx
    .select()
    .from(recipients)
    .where(and(eq(recipients.buyerUserId, buyerUserId), isNull(recipients.deletedAt)))
    .orderBy(asc(recipients.fullName), asc(recipients.createdAt));
}

export async function findRecipient(tx: Transaction, buyerUserId: string, id: string): Promise<Recipient | undefined> {
  const [row] = await tx
    .select()
    .from(recipients)
    .where(and(eq(recipients.id, id), eq(recipients.buyerUserId, buyerUserId), isNull(recipients.deletedAt)))
    .limit(1);
  return row;
}

export async function insertRecipient(tx: Transaction, values: NewRecipient): Promise<Recipient> {
  const [row] = await tx.insert(recipients).values(values).returning();
  if (!row) {
    throw new Error('Insert into recipients returned no row');
  }
  return row;
}

export async function updateRecipient(
  tx: Transaction,
  buyerUserId: string,
  id: string,
  values: Partial<NewRecipient>,
): Promise<Recipient | undefined> {
  const [row] = await tx
    .update(recipients)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(recipients.id, id), eq(recipients.buyerUserId, buyerUserId), isNull(recipients.deletedAt)))
    .returning();
  return row;
}

export async function softDeleteRecipient(tx: Transaction, buyerUserId: string, id: string): Promise<boolean> {
  const rows = await tx
    .update(recipients)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(recipients.id, id), eq(recipients.buyerUserId, buyerUserId), isNull(recipients.deletedAt)))
    .returning({ id: recipients.id });
  return rows.length > 0;
}

// --- addresses ------------------------------------------------------------

// Default first, then oldest first, so the UI can pre-select index 0.
export async function listAddressesForRecipients(tx: Transaction, recipientIds: string[]): Promise<Address[]> {
  if (recipientIds.length === 0) {
    return [];
  }
  return tx
    .select()
    .from(addresses)
    .where(and(inArray(addresses.recipientId, recipientIds), isNull(addresses.deletedAt)))
    .orderBy(desc(addresses.isDefault), asc(addresses.createdAt));
}

export async function findAddress(tx: Transaction, recipientId: string, id: string): Promise<Address | undefined> {
  const [row] = await tx
    .select()
    .from(addresses)
    .where(and(eq(addresses.id, id), eq(addresses.recipientId, recipientId), isNull(addresses.deletedAt)))
    .limit(1);
  return row;
}

export async function countAddresses(tx: Transaction, recipientId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(addresses)
    .where(and(eq(addresses.recipientId, recipientId), isNull(addresses.deletedAt)));
  return row?.total ?? 0;
}

export async function insertAddress(tx: Transaction, values: NewAddress): Promise<Address> {
  const [row] = await tx.insert(addresses).values(values).returning();
  if (!row) {
    throw new Error('Insert into addresses returned no row');
  }
  return row;
}

export async function updateAddress(
  tx: Transaction,
  recipientId: string,
  id: string,
  values: Partial<NewAddress>,
): Promise<Address | undefined> {
  const [row] = await tx
    .update(addresses)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(addresses.id, id), eq(addresses.recipientId, recipientId), isNull(addresses.deletedAt)))
    .returning();
  return row;
}

// The partial unique index allows one default per recipient, so the old
// default must be cleared before a new one is set — always in one tx.
export async function clearDefaultAddress(tx: Transaction, recipientId: string): Promise<void> {
  await tx
    .update(addresses)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(eq(addresses.recipientId, recipientId), eq(addresses.isDefault, true), isNull(addresses.deletedAt)));
}

export async function softDeleteAddress(tx: Transaction, recipientId: string, id: string): Promise<boolean> {
  const rows = await tx
    .update(addresses)
    .set({ deletedAt: new Date(), isDefault: false, updatedAt: new Date() })
    .where(and(eq(addresses.id, id), eq(addresses.recipientId, recipientId), isNull(addresses.deletedAt)))
    .returning({ id: addresses.id });
  return rows.length > 0;
}

export async function softDeleteAddressesOfRecipient(tx: Transaction, recipientId: string): Promise<void> {
  await tx
    .update(addresses)
    .set({ deletedAt: new Date(), isDefault: false, updatedAt: new Date() })
    .where(and(eq(addresses.recipientId, recipientId), isNull(addresses.deletedAt)));
}

export async function findOldestAddress(tx: Transaction, recipientId: string): Promise<Address | undefined> {
  const [row] = await tx
    .select()
    .from(addresses)
    .where(and(eq(addresses.recipientId, recipientId), isNull(addresses.deletedAt)))
    .orderBy(asc(addresses.createdAt))
    .limit(1);
  return row;
}

// --- orders -----------------------------------------------------------------

export async function insertOrder(tx: Transaction, values: NewOrder): Promise<Order> {
  const [row] = await tx.insert(orders).values(values).returning();
  if (!row) {
    throw new Error('Insert into orders returned no row');
  }
  return row;
}

export async function insertOrderItems(tx: Transaction, values: NewOrderItem[]): Promise<OrderItem[]> {
  if (values.length === 0) {
    return [];
  }
  return tx.insert(orderItems).values(values).returning();
}

export async function findById(tx: Transaction, id: string): Promise<Order | undefined> {
  const [row] = await tx.select().from(orders).where(eq(orders.id, id)).limit(1);
  return row;
}

export async function findForBuyer(tx: Transaction, buyerUserId: string, id: string): Promise<Order | undefined> {
  const [row] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.id, id), eq(orders.buyerUserId, buyerUserId)))
    .limit(1);
  return row;
}

export async function listForBuyer(tx: Transaction, buyerUserId: string): Promise<Order[]> {
  return tx.select().from(orders).where(eq(orders.buyerUserId, buyerUserId)).orderBy(desc(orders.createdAt));
}

export async function listForAdmin(tx: Transaction, filter: { status?: string } = {}): Promise<Order[]> {
  return tx
    .select()
    .from(orders)
    .where(filter.status ? eq(orders.status, filter.status) : undefined)
    .orderBy(desc(orders.createdAt));
}

export async function listItems(tx: Transaction, orderId: string): Promise<OrderItem[]> {
  return tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.createdAt));
}

export async function listItemsForOrders(tx: Transaction, orderIds: string[]): Promise<OrderItem[]> {
  if (orderIds.length === 0) {
    return [];
  }
  return tx.select().from(orderItems).where(inArray(orderItems.orderId, orderIds));
}

export async function orderNumberExists(tx: Transaction, orderNumber: string): Promise<boolean> {
  const [row] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1);
  return row !== undefined;
}

interface StatusUpdate {
  status: string;
  placedAt?: Date;
  paidAt?: Date;
  deliveredAt?: Date;
  cancelledAt?: Date;
}

export async function updateStatus(tx: Transaction, id: string, values: StatusUpdate): Promise<Order | undefined> {
  const [row] = await tx
    .update(orders)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(orders.id, id))
    .returning();
  return row;
}

// Reconciliation: orders whose payment was never confirmed, old enough to
// act on. Age is measured from placed_at, not created_at — they're the same
// value at checkout today, but placed_at is the one that means "the clock a
// buyer would expect started when they placed the order".
export async function findStalePendingPayment(tx: Transaction, olderThan: Date): Promise<Order[]> {
  return tx
    .select()
    .from(orders)
    .where(and(eq(orders.status, 'pending_payment'), lt(orders.placedAt, olderThan)));
}
