import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { pageQuerySchema } from '../../core/pagination.js';
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
  (table) => [tenantIsolationPolicy(table.tenantId), uniqueIndex('couriers_tenant_user_unique').on(table.tenantId, table.userId)],
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
  // Proof is optional: who received it, the note and the photo can all be left out.
  recipientName: z.string().trim().max(255).optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type ConfirmDeliveryInput = z.infer<typeof confirmDeliverySchema>;

// --- dispatch: who is delivering which order ------------------------------------------------------------------
//
// An assignment gives one order to one courier. It moves through
//
//   assigned -> accepted -> picked_up -> delivered
//      |           |            \-> failed        (could not hand it over: absent, wrong address, ...)
//      \-> declined (the courier says no)
//   any open one -> released (the store took it back, or gave the order to someone else)
//
// "Open" (assigned, accepted, picked_up) means the courier still has the order; at most one open assignment per order
// (a partial unique index, so two people dispatching at once cannot both win). Closed ones stay as the order's history,
// so "who tried to deliver this, and what happened" is always answerable. The order's own status is separate: picking
// up moves it to out_for_delivery and delivering moves it to delivered, through the orders service.
export const assignmentStatuses = ['assigned', 'accepted', 'picked_up', 'delivered', 'declined', 'failed', 'released'] as const;
export type AssignmentStatus = (typeof assignmentStatuses)[number];
export const openAssignmentStatuses = ['assigned', 'accepted', 'picked_up'] as const satisfies readonly AssignmentStatus[];

export const courierAssignments = pgTable(
  'courier_assignments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    orderId: uuid('order_id').notNull(), // soft ref -> orders.orders
    courierId: uuid('courier_id')
      .notNull()
      .references(() => couriers.id),
    assignedByUserId: uuid('assigned_by_user_id').notNull(), // soft ref -> identity.users
    status: varchar('status', { length: 20 }).notNull().default('assigned'),
    // Why it was declined, or what went wrong when it could not be delivered.
    reason: varchar('reason', { length: 40 }),
    note: text('note'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    pickedUpAt: timestamp('picked_up_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    tenantIsolationPolicy(table.tenantId),
    // One courier at a time per order.
    uniqueIndex('courier_assignments_one_open_per_order')
      .on(table.tenantId, table.orderId)
      .where(sql`${table.status} in ('assigned', 'accepted', 'picked_up')`),
    index('courier_assignments_courier_idx').on(table.tenantId, table.courierId, table.status),
    index('courier_assignments_order_idx').on(table.tenantId, table.orderId, table.createdAt),
  ],
);

export type CourierAssignment = typeof courierAssignments.$inferSelect;
export type NewCourierAssignment = typeof courierAssignments.$inferInsert;

// --- dispatch request DTOs ------------------------------------------------------------------------------------

export const assignCourierSchema = z.object({ courierId: z.string().uuid() });

export const assignmentParamSchema = z.object({ assignmentId: z.string().uuid() });

export const declineAssignmentSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

// Why a delivery could not be handed over. A fixed list (so the store can count them), plus a free note.
export const deliveryFailureReasons = ['recipient_absent', 'wrong_address', 'refused', 'unreachable', 'other'] as const;
export type DeliveryFailureReason = (typeof deliveryFailureReasons)[number];
export const failDeliverySchema = z.object({
  reason: z.enum(deliveryFailureReasons),
  note: z.string().trim().max(500).optional(),
});

// The dispatch board's three lanes: orders still without a courier, orders a courier has, and orders whose last
// attempt went wrong (declined or could not be delivered) and need the store to decide.
export const boardLanes = ['unassigned', 'assigned', 'problems'] as const;
export type BoardLane = (typeof boardLanes)[number];
export const boardQuerySchema = pageQuerySchema.extend({ lane: z.enum(boardLanes).default('unassigned') });

// A courier's own list, and the store's overview of what is out.
export const myDeliveriesQuerySchema = pageQuerySchema;
