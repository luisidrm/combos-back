import { and, asc, eq, isNotNull, lt } from 'drizzle-orm';
import type { Transaction } from '../../db/client.js';
import { cartItems, carts, type Cart, type CartItem, type NewCart } from './cart.schema.js';

// All SQL for the cart module's tables lives here — nothing else touches
// them. Every function takes `tx: Transaction` as its first argument;
// repos never open connections (CLAUDE.md section 5).

export async function findCartByUser(tx: Transaction, userId: string): Promise<Cart | undefined> {
  const [row] = await tx.select().from(carts).where(eq(carts.userId, userId)).limit(1);
  return row;
}

export async function findCartByGuestToken(tx: Transaction, guestToken: string): Promise<Cart | undefined> {
  const [row] = await tx.select().from(carts).where(eq(carts.guestToken, guestToken)).limit(1);
  return row;
}

// Undefined when another request created the same buyer's cart first (the
// unique indexes make that a conflict, not a duplicate) — the caller then
// just re-reads. Plain ON CONFLICT DO NOTHING keeps the transaction usable,
// which catching a unique-violation error would not.
export async function insertCart(tx: Transaction, values: NewCart): Promise<Cart | undefined> {
  const [row] = await tx.insert(carts).values(values).onConflictDoNothing().returning();
  return row;
}

export async function touchCart(tx: Transaction, cartId: string): Promise<void> {
  await tx.update(carts).set({ updatedAt: new Date() }).where(eq(carts.id, cartId));
}

export async function deleteCart(tx: Transaction, cartId: string): Promise<void> {
  await tx.delete(cartItems).where(eq(cartItems.cartId, cartId));
  await tx.delete(carts).where(eq(carts.id, cartId));
}

export async function listItems(tx: Transaction, cartId: string): Promise<CartItem[]> {
  return tx.select().from(cartItems).where(eq(cartItems.cartId, cartId)).orderBy(asc(cartItems.createdAt));
}

export async function findItem(tx: Transaction, cartId: string, productId: string): Promise<CartItem | undefined> {
  const [row] = await tx
    .select()
    .from(cartItems)
    .where(and(eq(cartItems.cartId, cartId), eq(cartItems.productId, productId)))
    .limit(1);
  return row;
}

// One line per product per cart: a second add of the same product lands on
// the same row via the (cart_id, product_id) unique index.
export async function upsertItem(
  tx: Transaction,
  values: { tenantId: string; cartId: string; productId: string; quantity: number },
): Promise<void> {
  await tx
    .insert(cartItems)
    .values(values)
    .onConflictDoUpdate({
      target: [cartItems.cartId, cartItems.productId],
      set: { quantity: values.quantity, updatedAt: new Date() },
    });
}

// Guest carts nobody has touched since `olderThan`. A buyer's own cart is
// never stale in this sense — it is theirs until they empty it.
export async function findStaleGuestCartIds(tx: Transaction, olderThan: Date): Promise<string[]> {
  const rows = await tx
    .select({ id: carts.id })
    .from(carts)
    .where(and(isNotNull(carts.guestToken), lt(carts.updatedAt, olderThan)));
  return rows.map((row) => row.id);
}

export async function deleteItem(tx: Transaction, cartId: string, productId: string): Promise<void> {
  await tx.delete(cartItems).where(and(eq(cartItems.cartId, cartId), eq(cartItems.productId, productId)));
}

export async function deleteAllItems(tx: Transaction, cartId: string): Promise<void> {
  await tx.delete(cartItems).where(eq(cartItems.cartId, cartId));
}
