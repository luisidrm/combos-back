import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { pageQuerySchema } from '../../core/pagination.js';
import { tenantIsolationPolicy } from '../../db/rls.js';

// The in-app notification feed: one row per person told about something (the bell in the web app). Emails are the
// other channel; this one needs no email setup and survives a stopped mail provider. A row says WHAT happened (`kind`,
// the order, a few facts in `data`); the web app writes the sentence in the reader's language.
export const notificationKinds = [
  // the store (admin, staff)
  'new_order',
  'order_paid',
  'transfer_reported',
  'order_delivered',
  'order_cancelled',
  'delivery_accepted',
  'delivery_picked_up',
  'delivery_declined',
  'delivery_failed',
  // the courier
  'delivery_assigned',
  'delivery_released',
  // the buyer
  'buyer_paid',
  'buyer_on_the_way',
  'buyer_delivered',
  'buyer_cancelled',
  'buyer_refunded',
] as const;
export type NotificationKind = (typeof notificationKinds)[number];

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(), // soft ref -> identity.users: who is told
    kind: varchar('kind', { length: 40 }).notNull(),
    orderId: uuid('order_id'), // soft ref -> orders.orders
    orderNumber: varchar('order_number', { length: 20 }),
    // A few facts for the sentence ({ courierName, reason }). Never an address, phone or amount.
    data: jsonb('data').$type<Record<string, string>>().notNull().default({}),
    // Which announcement this came from. The queue can run a handler twice (a retry after a failed email): the same
    // announcement never tells the same person twice.
    eventKey: varchar('event_key', { length: 64 }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    tenantIsolationPolicy(table.tenantId),
    index('notifications_user_idx').on(table.tenantId, table.userId, table.createdAt),
    uniqueIndex('notifications_event_unique')
      .on(table.userId, table.kind, table.eventKey)
      .where(sql`${table.eventKey} is not null`),
  ],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

export const notificationsQuerySchema = pageQuerySchema.extend({ unread: z.enum(['true', 'false']).optional() });
// Either some ids, or `all: true` (the "mark everything read" button).
export const markReadSchema = z.union([z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }), z.object({ all: z.literal(true) })]);
