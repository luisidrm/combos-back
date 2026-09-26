import { sql } from 'drizzle-orm';
import { check, integer, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { tenantIsolationPolicy } from '../../db/rls.js';

export const carts = pgTable(
  'carts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id'), // soft ref -> identity.users, nullable for guest carts
    guestToken: varchar('guest_token', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    tenantIsolationPolicy(table.tenantId),
    // A cart belongs to exactly one of: a signed-in buyer or a guest token.
    check('carts_exactly_one_owner', sql`num_nonnulls(${table.userId}, ${table.guestToken}) = 1`),
    // One cart per buyer, and one per guest token, per tenant.
    uniqueIndex('carts_tenant_user_uq')
      .on(table.tenantId, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    uniqueIndex('carts_tenant_guest_token_uq')
      .on(table.tenantId, table.guestToken)
      .where(sql`${table.guestToken} IS NOT NULL`),
  ],
);

export type Cart = typeof carts.$inferSelect;
export type NewCart = typeof carts.$inferInsert;

// The cart is where the buyer builds their combo — one line per product,
// quantity bumps on re-add rather than duplicating the row.
export const cartItems = pgTable(
  'cart_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    cartId: uuid('cart_id')
      .notNull()
      .references(() => carts.id),
    productId: uuid('product_id').notNull(), // soft ref -> catalog.products
    quantity: integer('quantity').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    tenantIsolationPolicy(table.tenantId),
    uniqueIndex('cart_items_cart_product_unique').on(table.cartId, table.productId),
  ],
);

export type CartItem = typeof cartItems.$inferSelect;
export type NewCartItem = typeof cartItems.$inferInsert;

// --- request DTOs ---------------------------------------------------------

// Per-line ceiling, on top of each product's own max_per_order.
export const MAX_LINE_QUANTITY = 99;

const quantitySchema = z.number().int().min(1).max(MAX_LINE_QUANTITY);

export const addItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: quantitySchema.default(1),
});
export type AddItemInput = z.infer<typeof addItemSchema>;

export const setQuantitySchema = z.object({ quantity: quantitySchema });

// The client's locally persisted cart (CLAUDE.md section 7). Bounded so a
// hostile client can't make the server price thousands of lines.
export const mergeCartSchema = z
  .object({
    items: z
      .array(z.object({ productId: z.string().uuid(), quantity: quantitySchema }))
      .max(100),
  })
  .refine((value) => new Set(value.items.map((item) => item.productId)).size === value.items.length, {
    message: 'each product may appear once',
  });
export type MergeCartInput = z.infer<typeof mergeCartSchema>;

export const productParamSchema = z.object({ productId: z.string().uuid() });
