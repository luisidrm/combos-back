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

// Per-store switches an admin can flip. Stored in the jsonb `settings`
// column with snake_case keys (CLAUDE.md section 5). Kept to what exists;
// each new setting is added here deliberately, never accepted as free-form.
export const updateTenantSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  taglineEs: z.string().trim().max(255).nullable().optional(),
  taglineEn: z.string().trim().max(255).nullable().optional(),
  descriptionEs: z.string().trim().max(5000).nullable().optional(),
  descriptionEn: z.string().trim().max(5000).nullable().optional(),
  settings: z
    .object({
      // Whether a delivery needs a proof photo before it can be marked
      // delivered (CLAUDE.md section 5, couriers).
      requireDeliveryPhoto: z.boolean().optional(),
    })
    .optional(),
});
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;

export interface TenantSettings {
  requireDeliveryPhoto: boolean;
}
