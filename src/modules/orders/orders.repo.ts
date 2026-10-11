import { and, asc, desc, eq, getTableColumns, gte, ilike, inArray, isNull, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../db/client.js';
import {
  addresses,
  orderCounters,
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

export async function setShareToken(tx: Transaction, id: string, token: string | null): Promise<Order | undefined> {
  const [row] = await tx.update(orders).set({ shareToken: token, updatedAt: new Date() }).where(eq(orders.id, id)).returning();
  return row;
}

export async function findByShareToken(tx: Transaction, token: string): Promise<Order | undefined> {
  const [row] = await tx.select().from(orders).where(eq(orders.shareToken, token)).limit(1);
  return row;
}

// The order a checkout attempt already made, if any (see orders.checkout_key).
export async function findByCheckoutKey(tx: Transaction, buyerUserId: string, key: string): Promise<Order | undefined> {
  const [row] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.buyerUserId, buyerUserId), eq(orders.checkoutKey, key)))
    .limit(1);
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

// --- paged lists ------------------------------------------------------------------------------------------
//
// Newest first, in pages. The position inside the list is (created_at, id); created_at keeps its microseconds
// (`cursorAt`, text), because a JavaScript Date only has milliseconds and two orders placed in the same millisecond
// would otherwise be skipped or repeated at a page boundary.

export type OrderRow = Order & { cursorAt: string };
export interface OrderPage {
  /** Fetch this many rows (the caller asks for one more than it shows, to learn whether a next page exists). */
  limit: number;
  /** The [cursorAt, id] of the last row already shown. */
  after?: [string, string];
}

const cursorAt = sql<string>`to_char(${orders.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const pageColumns = { ...getTableColumns(orders), cursorAt };

const afterCondition = (after: OrderPage['after']) =>
  after ? sql`(${orders.createdAt}, ${orders.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : undefined;

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => '\\' + c)}%`;

export async function pageForBuyer(tx: Transaction, buyerUserId: string, page: OrderPage, statuses?: { in?: string[]; notIn?: string[] }): Promise<OrderRow[]> {
  return tx
    .select(pageColumns)
    .from(orders)
    .where(
      and(
        eq(orders.buyerUserId, buyerUserId),
        statuses?.in ? inArray(orders.status, statuses.in) : undefined,
        statuses?.notIn ? notInArray(orders.status, statuses.notIn) : undefined,
        afterCondition(page.after),
      ),
    )
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(page.limit);
}

export interface AdminOrderFilter {
  status?: string;
  /** Any of these statuses (the dispatch board looks at orders that are paid, preparing or out for delivery). */
  statuses?: string[];
  /** Only these orders (the ones with a transfer report waiting, or the ones a courier is assigned to). */
  onlyIds?: string[];
  /** Everything except these (the orders that already have a courier). */
  excludeIds?: string[];
  /** A search: the order number or the recipient's name contains the text, or the buyer is one of `buyerIds`. */
  search?: { text: string; buyerIds: string[] };
}

export async function pageForAdmin(tx: Transaction, filter: AdminOrderFilter, page: OrderPage): Promise<OrderRow[]> {
  const conditions = [afterCondition(page.after)];
  if (filter.status) conditions.push(eq(orders.status, filter.status));
  if (filter.statuses) conditions.push(inArray(orders.status, filter.statuses));
  if (filter.excludeIds && filter.excludeIds.length > 0) conditions.push(notInArray(orders.id, filter.excludeIds));
  if (filter.onlyIds) conditions.push(filter.onlyIds.length > 0 ? inArray(orders.id, filter.onlyIds) : sql`false`);
  if (filter.search) {
    const pattern = likePattern(filter.search.text);
    conditions.push(
      or(
        ilike(orders.orderNumber, pattern),
        ilike(orders.recipientNameSnapshot, pattern),
        filter.search.buyerIds.length > 0 ? inArray(orders.buyerUserId, filter.search.buyerIds) : undefined,
      ),
    );
  }
  return tx
    .select(pageColumns)
    .from(orders)
    .where(and(...conditions))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(page.limit);
}

// How many orders each status has, for the filter chips: counted by the database, not by whatever the screen has loaded.
export async function countByStatus(tx: Transaction): Promise<Array<{ status: string; n: number }>> {
  return tx.select({ status: orders.status, n: sql<number>`count(*)::int` }).from(orders).groupBy(orders.status);
}

export async function countPendingAmong(tx: Transaction, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(inArray(orders.id, ids), eq(orders.status, 'pending_payment')));
  return row?.n ?? 0;
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

// The first order of a store is FC-1001 (a shop whose first receipt says "#1"
// looks brand new to a buyer who is about to send money abroad).
const FIRST_ORDER_NUMBER = 1001;

// Atomic: the upsert takes a row lock on this store's counter until the
// surrounding transaction ends, so concurrent checkouts queue up behind each other.
export async function nextOrderNumber(tx: Transaction, tenantId: string): Promise<number> {
  const [row] = await tx
    .insert(orderCounters)
    .values({ tenantId, lastNumber: FIRST_ORDER_NUMBER })
    .onConflictDoUpdate({ target: orderCounters.tenantId, set: { lastNumber: sql`${orderCounters.lastNumber} + 1` } })
    .returning({ lastNumber: orderCounters.lastNumber });
  if (!row) {
    throw new Error('Order counter upsert returned no row');
  }
  return row.lastNumber;
}

// --- sales statistics (admin analytics) ----------------------------------------
//
// An order counts as a sale from the moment it is paid until it is refunded or cancelled, and is
// dated by when it was PAID, not placed. Days are Cuba days (the shop's), not UTC days.

const SALE_STATUSES = ['paid', 'preparing', 'out_for_delivery', 'delivered'];

// A period is [from, to) given as Cuba-local dates ("2026-09-24"); null "to" = open-ended.
function paidWithin(from: string, to: string | null): SQL {
  const start = sql`(${from}::timestamp at time zone 'America/Havana')`;
  const end = to ? sql`(${to}::timestamp at time zone 'America/Havana')` : undefined;
  return and(inArray(orders.status, SALE_STATUSES), gte(orders.paidAt, start), end ? lt(orders.paidAt, end) : undefined) as SQL;
}

export interface SalesTotals {
  orders: number;
  totalCents: number;
  freeDeliveryOrders: number;
}

export async function salesTotals(tx: Transaction, from: string, to: string | null): Promise<SalesTotals> {
  const [row] = await tx
    .select({
      orders: sql<number>`count(*)::int`,
      totalCents: sql<number>`coalesce(sum(${orders.totalCents}), 0)::int`,
      freeDeliveryOrders: sql<number>`(count(*) filter (where ${orders.deliveryFeeCents} = 0))::int`,
    })
    .from(orders)
    .where(paidWithin(from, to));
  return row ?? { orders: 0, totalCents: 0, freeDeliveryOrders: 0 };
}

export async function salesByBucket(
  tx: Transaction,
  from: string,
  to: string | null,
  granularity: 'day' | 'month',
): Promise<Array<{ bucket: string; totalCents: number; orders: number }>> {
  // The format is one of two constants and is written into the SQL as a literal on purpose: as a bound
  // parameter, Postgres would see the SELECT and GROUP BY expressions as different and refuse to group.
  const format = sql.raw(granularity === 'day' ? "'YYYY-MM-DD'" : "'YYYY-MM'");
  const bucket = sql<string>`to_char(${orders.paidAt} at time zone 'America/Havana', ${format})`;
  return tx
    .select({
      bucket,
      totalCents: sql<number>`sum(${orders.totalCents})::int`,
      orders: sql<number>`count(*)::int`,
    })
    .from(orders)
    .where(paidWithin(from, to))
    .groupBy(bucket)
    .orderBy(bucket);
}

export async function salesByMunicipality(
  tx: Transaction,
  from: string,
  to: string | null,
): Promise<Array<{ provinceId: string; municipalityId: string; orders: number }>> {
  const provinceId = sql<string>`${orders.addressSnapshot}->>'provinceId'`;
  const municipalityId = sql<string>`${orders.addressSnapshot}->>'municipalityId'`;
  return tx
    .select({ provinceId, municipalityId, orders: sql<number>`count(*)::int` })
    .from(orders)
    .where(paidWithin(from, to))
    .groupBy(provinceId, municipalityId)
    .orderBy(desc(sql`count(*)`));
}

export async function topProducts(
  tx: Transaction,
  from: string,
  to: string | null,
  limit: number,
): Promise<Array<{ productId: string | null; nameEs: string; nameEn: string | null; quantity: number; totalCents: number }>> {
  return tx
    .select({
      productId: orderItems.productId,
      nameEs: orderItems.productNameSnapshot,
      nameEn: orderItems.productNameEnSnapshot,
      quantity: sql<number>`sum(${orderItems.quantity})::int`,
      totalCents: sql<number>`sum(${orderItems.lineTotalCents})::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(paidWithin(from, to))
    .groupBy(orderItems.productId, orderItems.productNameSnapshot, orderItems.productNameEnSnapshot)
    .orderBy(desc(sql`sum(${orderItems.quantity})`), desc(sql`sum(${orderItems.lineTotalCents})`))
    .limit(limit);
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

// Claims the right to send the "still waiting for your payment" reminder: true for exactly one caller, once, and only
// while the order is still unpaid. A repeated run of the maintenance pass finds it already claimed.
export async function claimPaymentReminder(tx: Transaction, id: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(orders)
    .set({ paymentReminderSentAt: now })
    .where(and(eq(orders.id, id), eq(orders.status, 'pending_payment'), isNull(orders.paymentReminderSentAt)))
    .returning({ id: orders.id });
  return rows.length > 0;
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
