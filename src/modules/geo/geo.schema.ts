import { boolean, integer, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { tenantIsolationPolicy } from '../../db/rls.js';
import { z } from 'zod';

// Global reference data — Cuba's real geography is the same for every
// tenant, so these carry no tenant_id and no RLS policy. Seeded once from
// src/db/seed/geo.seed.ts.
export const provinces = pgTable('provinces', {
  id: uuid('id').defaultRandom().primaryKey(),
  nameEs: varchar('name_es', { length: 100 }).notNull(),
  nameEn: varchar('name_en', { length: 100 }).notNull(),
  code: varchar('code', { length: 10 }).notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Province = typeof provinces.$inferSelect;
export type NewProvince = typeof provinces.$inferInsert;

export const municipalities = pgTable(
  'municipalities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    provinceId: uuid('province_id')
      .notNull()
      .references(() => provinces.id),
    nameEs: varchar('name_es', { length: 100 }).notNull(),
    nameEn: varchar('name_en', { length: 100 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Lets the seed script upsert on conflict instead of duplicating rows
    // on a re-run.
    uniqueIndex('municipalities_province_name_unique').on(table.provinceId, table.nameEs),
  ],
);

export type Municipality = typeof municipalities.$inferSelect;
export type NewMunicipality = typeof municipalities.$inferInsert;

// The tenant-scoped part of geo: which municipalities a shop delivers to,
// and at what flat fee.
export const deliveryZones = pgTable(
  'delivery_zones',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    municipalityId: uuid('municipality_id')
      .notNull()
      .references(() => municipalities.id),
    feeCents: integer('fee_cents').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    tenantIsolationPolicy(table.tenantId),
    // A tenant shouldn't end up with two zone rows for the same
    // municipality — ambiguous which fee applies.
    uniqueIndex('delivery_zones_tenant_municipality_unique').on(table.tenantId, table.municipalityId),
  ],
);

export type DeliveryZone = typeof deliveryZones.$inferSelect;
export type NewDeliveryZone = typeof deliveryZones.$inferInsert;

// --- request DTOs ---------------------------------------------------------

// Fees are flat per municipality, in integer cents (CLAUDE.md sections 5
// and 10). Zero is allowed: a shop may deliver some municipalities free.
const feeCentsSchema = z.number().int().min(0).max(10_000_000);

export const createDeliveryZoneSchema = z.object({
  municipalityId: z.string().uuid(),
  feeCents: feeCentsSchema,
  active: z.boolean().optional(),
});
export type CreateDeliveryZoneInput = z.infer<typeof createDeliveryZoneSchema>;

export const updateDeliveryZoneSchema = z.object({
  feeCents: feeCentsSchema.optional(),
  active: z.boolean().optional(),
});
export type UpdateDeliveryZoneInput = z.infer<typeof updateDeliveryZoneSchema>;

export const idParamSchema = z.object({ id: z.string().uuid() });
