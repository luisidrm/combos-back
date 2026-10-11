import { boolean, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';

// The root table. Deliberately NOT tenant-scoped — it's what tenant_id on
// every other table points at — so it carries no tenant_id and no RLS
// policy. Every other tenant-scoped table's schema stays independent of
// this one: no cross-module FK to tenants(id), by design (CLAUDE.md
// section 4's module boundary rule extends to schema-level coupling, not
// just service calls — see modules/README notes in eslint.config.js).
export const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  slug: varchar('slug', { length: 63 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  // Marketing copy, not a proper noun like `name` — bilingual, and
  // nullable since a tenant can exist before this copy is written.
  taglineEs: varchar('tagline_es', { length: 255 }),
  taglineEn: varchar('tagline_en', { length: 255 }),
  descriptionEs: text('description_es'),
  descriptionEn: text('description_en'),
  settings: jsonb('settings').notNull().default({}),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

export const createTenantSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens only'),
  name: z.string().min(1).max(255),
  taglineEs: z.string().max(255).optional(),
  taglineEn: z.string().max(255).optional(),
  descriptionEs: z.string().optional(),
  descriptionEn: z.string().optional(),
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>;

// A form sends "" for a field left empty; for these optional texts that means "clear it".
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:MM (24 h)');

// Per-store switches an admin can flip. Stored in the jsonb `settings`
// column with snake_case keys (CLAUDE.md section 5). Kept to what exists;
// each new setting is added here deliberately, never accepted as free-form.
export const updateTenantSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  taglineEs: z.preprocess(blankToNull, z.string().trim().max(255).nullable().optional()),
  taglineEn: z.preprocess(blankToNull, z.string().trim().max(255).nullable().optional()),
  descriptionEs: z.preprocess(blankToNull, z.string().trim().max(5000).nullable().optional()),
  descriptionEn: z.preprocess(blankToNull, z.string().trim().max(5000).nullable().optional()),
  settings: z
    .object({
      // Whether a delivery needs a proof photo before it can be marked
      // delivered (CLAUDE.md section 5, couriers).
      requireDeliveryPhoto: z.boolean().optional(),
      // Orders whose subtotal reaches this amount ship free (the delivery
      // fee of the zone is waived). null switches the offer off.
      freeDeliveryOverCents: z.number().int().min(0).max(100_000_00).nullable().optional(),
      // Orders placed before this time (Cuba time, "HH:MM") are delivered the same day; later ones
      // the next day. Shown to buyers, not enforced.
      sameDayCutoff: hhmm.nullable().optional(),
      // How buyers can reach the shop.
      contact: z
        .object({
          phone: z.preprocess(blankToNull, z.string().trim().max(40).nullable().optional()),
          email: z.preprocess(blankToNull, z.string().trim().email().max(255).nullable().optional()),
          address: z.preprocess(blankToNull, z.string().trim().max(500).nullable().optional()),
        })
        .optional(),
    })
    .optional(),
});
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;

export interface StoreContact {
  phone: string | null;
  email: string | null;
  address: string | null;
}

export interface TenantSettings {
  requireDeliveryPhoto: boolean;
  freeDeliveryOverCents: number | null;
  sameDayCutoff: string | null;
  contact: StoreContact;
}
