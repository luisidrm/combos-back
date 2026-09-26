import { sql } from 'drizzle-orm';
import { boolean, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { tenantIsolationPolicy } from '../../db/rls.js';

// The buyer's address book: people in Cuba they send to, saved once and
// reused for one-tap reorder.
export const recipients = pgTable(
  'recipients',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    buyerUserId: uuid('buyer_user_id').notNull(), // soft ref -> identity.users
    fullName: varchar('full_name', { length: 255 }).notNull(),
    phone1: varchar('phone_1', { length: 20 }).notNull(),
    phone2: varchar('phone_2', { length: 20 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [tenantIsolationPolicy(table.tenantId)],
);

export type Recipient = typeof recipients.$inferSelect;
export type NewRecipient = typeof recipients.$inferInsert;

export const addresses = pgTable(
  'addresses',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => recipients.id),
    label: varchar('label', { length: 50 }),
    isDefault: boolean('is_default').notNull().default(false),
    provinceId: uuid('province_id').notNull(), // soft ref -> geo.provinces
    municipalityId: uuid('municipality_id').notNull(), // soft ref -> geo.municipalities
    street: varchar('street', { length: 255 }).notNull(),
    betweenStreets: varchar('between_streets', { length: 255 }),
    buildingApartment: varchar('building_apartment', { length: 255 }),
    referencePoints: text('reference_points'),
    lat: numeric('lat', { precision: 9, scale: 6 }),
    lng: numeric('lng', { precision: 9, scale: 6 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Soft-deleted, not hard-deleted: orders.address_id keeps pointing here
    // even after a buyer removes an address from their book. The order
    // never needs to read it back though — it has its own frozen snapshot.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    tenantIsolationPolicy(table.tenantId),
    // At most one default address per recipient (deleted ones don't count).
    uniqueIndex('addresses_one_default_per_recipient')
      .on(table.recipientId)
      .where(sql`${table.isDefault} = true AND ${table.deletedAt} IS NULL`),
  ],
);

export type Address = typeof addresses.$inferSelect;
export type NewAddress = typeof addresses.$inferInsert;

export const orderStatuses = [
  'pending_payment',
  'paid',
  'preparing',
  'out_for_delivery',
  'delivered',
  'cancelled',
  'refunded',
] as const;
export type OrderStatus = (typeof orderStatuses)[number];

// The receipt: a frozen record of what was bought, for whom, where, and at
// what price. recipient_id/address_id link back to the address book (same
// module, real FK) so the shop can say "this recipient has received 12
// orders" and reorder can pre-fill — but the order screen always reads
// from the snapshot columns, never by following those links live.
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    orderNumber: varchar('order_number', { length: 20 }).notNull(),
    buyerUserId: uuid('buyer_user_id').notNull(), // soft ref -> identity.users
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => recipients.id),
    addressId: uuid('address_id')
      .notNull()
      .references(() => addresses.id),
    recipientNameSnapshot: varchar('recipient_name_snapshot', { length: 255 }).notNull(),
    recipientPhonesSnapshot: varchar('recipient_phones_snapshot', { length: 64 }).notNull(),
    addressSnapshot: jsonb('address_snapshot').notNull(),
    deliveryZoneId: uuid('delivery_zone_id').notNull(), // soft ref -> geo.delivery_zones
    status: varchar('status', { length: 20 }).notNull().default('pending_payment'),
    giftMessage: text('gift_message'),
    buyerNotes: text('buyer_notes'),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    rateUsed: numeric('rate_used', { precision: 14, scale: 6 }).notNull(),
    subtotalCents: integer('subtotal_cents').notNull(),
    deliveryFeeCents: integer('delivery_fee_cents').notNull(),
    totalCents: integer('total_cents').notNull(),
    placedAt: timestamp('placed_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    tenantIsolationPolicy(table.tenantId),
    uniqueIndex('orders_tenant_order_number_unique').on(table.tenantId, table.orderNumber),
  ],
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

// One line per product the buyer picked. Immutable once written — no
// updated_at — because this is a receipt line, not a live record.
export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    productId: uuid('product_id'), // nullable, soft ref -> catalog.products
    productNameSnapshot: varchar('product_name_snapshot', { length: 255 }).notNull(),
    unitLabelSnapshot: varchar('unit_label_snapshot', { length: 50 }).notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    quantity: integer('quantity').notNull(),
    lineTotalCents: integer('line_total_cents').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [tenantIsolationPolicy(table.tenantId)],
);

export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;

// --- request DTOs (address book) ------------------------------------------

// Loose on purpose: Cuban numbers arrive as +53 5xxxxxxx, 5xxxxxxx, with
// spaces or dashes. This only rejects obvious junk, not unusual formatting.
const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{7,20}$/, 'not a valid phone number');

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const addressFields = z.object({
  label: optionalText(50),
  provinceId: z.string().uuid(),
  municipalityId: z.string().uuid(),
  street: z.string().trim().min(1).max(255),
  betweenStreets: optionalText(255),
  buildingApartment: optionalText(255),
  referencePoints: optionalText(1000),
  // The optional Leaflet/OSM pin (CLAUDE.md section 10) — both or neither.
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
});

const latLngTogether = (value: { lat?: number | null; lng?: number | null }) =>
  (value.lat === undefined) === (value.lng === undefined);
const latLngMessage = { message: 'lat and lng must be given together' };

export const createAddressSchema = addressFields
  .extend({ isDefault: z.boolean().optional() })
  .refine(latLngTogether, latLngMessage);
export type CreateAddressInput = z.infer<typeof createAddressSchema>;

// isDefault is deliberately not editable here — the dedicated
// /default endpoint is the one way to move it, so there is always one.
export const updateAddressSchema = addressFields.partial().refine(latLngTogether, latLngMessage);
export type UpdateAddressInput = z.infer<typeof updateAddressSchema>;

export const createRecipientSchema = z.object({
  fullName: z.string().trim().min(1).max(255),
  phone1: phoneSchema,
  phone2: phoneSchema.nullable().optional(),
  // Optional first address, so one form can create both in one call.
  address: createAddressSchema.optional(),
});
export type CreateRecipientInput = z.infer<typeof createRecipientSchema>;

export const updateRecipientSchema = z.object({
  fullName: z.string().trim().min(1).max(255).optional(),
  phone1: phoneSchema.optional(),
  phone2: phoneSchema.nullable().optional(),
});
export type UpdateRecipientInput = z.infer<typeof updateRecipientSchema>;

export const quoteSchema = z.object({
  recipientId: z.string().uuid(),
  addressId: z.string().uuid(),
});
export type QuoteInput = z.infer<typeof quoteSchema>;

export const recipientParamSchema =z.object({ id: z.string().uuid() });
export const addressParamSchema = z.object({ id: z.string().uuid(), addressId: z.string().uuid() });
