import { z } from 'zod';
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { tenantIsolationPolicy } from '../../db/rls.js';

// Couriers are optional — a one-person shop never creates one and marks
// its own orders delivered instead (see deliveries.deliveredByUserId).
export const couriers = pgTable(
  'couriers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(), // soft ref -> identity.users
    phone: varchar('phone', { length: 20 }).notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [tenantIsolationPolicy(table.tenantId)],
);

export type Courier = typeof couriers.$inferSelect;
export type NewCourier = typeof couriers.$inferInsert;

// One row per delivered order. courier_id is nullable; delivered_by_user_id
// always names who actually handed it over (the owner or a courier).
// Delivery photos are optional media rows (owner_type = 'delivery') unless
// tenants.settings.require_delivery_photo is true — enforced in
// fulfilmentService, not here.
export const deliveries = pgTable(
  'deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    orderId: uuid('order_id').notNull(), // soft ref -> orders.orders
    deliveredByUserId: uuid('delivered_by_user_id').notNull(), // soft ref -> identity.users
    courierId: uuid('courier_id').references(() => couriers.id),
    recipientNameConfirmed: varchar('recipient_name_confirmed', { length: 255 }),
    notes: text('notes'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    tenantIsolationPolicy(table.tenantId),
    uniqueIndex('deliveries_tenant_order_unique').on(table.tenantId, table.orderId),
  ],
);

export type Delivery = typeof deliveries.$inferSelect;
export type NewDelivery = typeof deliveries.$inferInsert;

// --- request DTOs ---------------------------------------------------------

export const orderParamSchema = z.object({ orderId: z.string().uuid() });

// Proof of delivery: who actually received it, plus an optional note. The photo is uploaded
// separately through /media (owner type "delivery", owner id = the order id) before this call.
export const confirmDeliverySchema = z.object({
  recipientName: z.string().trim().min(1).max(255),
  notes: z.string().trim().max(1000).optional(),
});
export type ConfirmDeliveryInput = z.infer<typeof confirmDeliverySchema>;
