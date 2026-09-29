import { integer, jsonb, numeric, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
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
