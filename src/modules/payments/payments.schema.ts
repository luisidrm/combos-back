import { boolean, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { tenantIsolationPolicy } from '../../db/rls.js';

export const paymentStatuses = ['pending', 'paid', 'failed', 'refunded'] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];

// The single source of truth for which providers exist — payments.service's
// registry, orders' checkout schema, and everything else all reference this
// one list rather than repeating the literal.
export const providerNames = ['tropipay', 'manual'] as const;
export type ProviderName = (typeof providerNames)[number];
export const providerNameSchema = z.enum(providerNames);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    orderId: uuid('order_id').notNull(), // soft ref -> orders.orders
    provider: varchar('provider', { length: 20 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    amountCents: integer('amount_cents').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    externalPaymentId: varchar('external_payment_id', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [tenantIsolationPolicy(table.tenantId)],
);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;

// provider_event_id is the idempotency key — webhooks arrive twice, out of
// order, and after timeouts (CLAUDE.md §6). Immutable once recorded, so no
// updated_at.
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    providerEventId: varchar('provider_event_id', { length: 255 }).notNull(),
    eventType: varchar('event_type', { length: 50 }).notNull(),
    payload: jsonb('payload').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    tenantIsolationPolicy(table.tenantId),
    uniqueIndex('payment_events_tenant_provider_event_unique').on(table.tenantId, table.providerEventId),
  ],
);

export type PaymentEvent = typeof paymentEvents.$inferSelect;
export type NewPaymentEvent = typeof paymentEvents.$inferInsert;

// Global — one market rate history for the whole platform. Orders copy the
// rate they used at purchase time into rate_used; never recomputed later.
export const currencyRates = pgTable('currency_rates', {
  id: uuid('id').defaultRandom().primaryKey(),
  currencyFrom: varchar('currency_from', { length: 3 }).notNull(),
  currencyTo: varchar('currency_to', { length: 3 }).notNull(),
  rate: numeric('rate', { precision: 14, scale: 6 }).notNull(),
  effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CurrencyRate = typeof currencyRates.$inferSelect;
export type NewCurrencyRate = typeof currencyRates.$inferInsert;

// --- manual transfer methods ----------------------------------------------------------------
//
// The accounts a buyer can send money to by hand (Zelle, Cash App, PayPal, ...). One row per account, per
// store, edited by the owner in Settings. Nothing here is an integration: it is only what to show the buyer
// (who to pay, how much, a link that opens their app); a person at the store confirms the money arrived.

// `kind` decides how a link that opens the app is built (and what the handle means); "other" is any app or bank
// the owner wants to add, with an optional link of their own.
export const manualMethodKinds = ['zelle', 'cashapp', 'paypal', 'other'] as const;
export type ManualMethodKind = (typeof manualMethodKinds)[number];

export const manualPaymentMethods = pgTable(
  'manual_payment_methods',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    kind: varchar('kind', { length: 20 }).notNull(),
    // What buyers see on the checkout ("Zelle", "Cash App", or a name the owner chose).
    label: varchar('label', { length: 60 }).notNull(),
    // What to type into the app as the recipient: an email, a phone, a $cashtag.
    recipient: varchar('recipient', { length: 255 }).notNull(),
    // Cash App cashtag (without the $) or paypal.me name: lets the link open with the amount already filled in.
    handle: varchar('handle', { length: 60 }),
    // For kind "other": an https link, where {amount} (like 55.50) and {recipient} are filled in per order.
    linkTemplate: varchar('link_template', { length: 500 }),
    payeeName: varchar('payee_name', { length: 120 }),
    instructionsEs: text('instructions_es'),
    instructionsEn: text('instructions_en'),
    sortOrder: integer('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Removed methods stay as rows: a reported transfer names the method it was sent with.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [tenantIsolationPolicy(table.tenantId)],
);

export type ManualPaymentMethod = typeof manualPaymentMethods.$inferSelect;
export type NewManualPaymentMethod = typeof manualPaymentMethods.$inferInsert;

// A form sends "" for a field left empty; for the optional texts that means "none".
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
// People type a cashtag as "$name" and a paypal.me link as a name; both are stored as the bare name.
const bareHandle = (v: unknown) => {
  const blank = blankToNull(v);
  return typeof blank === 'string' ? blank.trim().replace(/^\$/, '') : blank;
};

const optionalText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional());

export const createManualMethodSchema = z.object({
  kind: z.enum(manualMethodKinds),
  label: z.string().trim().min(1).max(60),
  recipient: z.string().trim().min(1).max(255),
  handle: z.preprocess(
    bareHandle,
    z
      .string()
      .max(60)
      .regex(/^[A-Za-z0-9._-]+$/, 'letters, numbers, dots, dashes and underscores only')
      .nullable()
      .optional(),
  ),
  // https only: this link is shown to buyers as a button, so it must never be a javascript: or data: address.
  linkTemplate: z.preprocess(
    blankToNull,
    z
      .string()
      .trim()
      .max(500)
      .refine((value) => /^https:\/\/[^\s]+$/i.test(value), 'must be a link starting with https://')
      .nullable()
      .optional(),
  ),
  payeeName: optionalText(120),
  instructionsEs: optionalText(1000),
  instructionsEn: optionalText(1000),
  active: z.boolean().optional(),
});
export type CreateManualMethodInput = z.infer<typeof createManualMethodSchema>;

export const updateManualMethodSchema = createManualMethodSchema.partial();
export type UpdateManualMethodInput = z.infer<typeof updateManualMethodSchema>;

export const methodIdParamSchema = z.object({ id: z.string().uuid() });
export const reorderMethodsSchema = z
  .object({ ids: z.array(z.string().uuid()).min(1).max(50) })
  .refine((value) => new Set(value.ids).size === value.ids.length, { message: 'ids must be unique' });
