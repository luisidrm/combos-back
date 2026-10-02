import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { tenantIsolationPolicy } from '../../db/rls.js';

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    nameEs: varchar('name_es', { length: 255 }).notNull(),
    nameEn: varchar('name_en', { length: 255 }).notNull(),
    // A glyph name from categoryIcons below (the storefront draws it on the category chip).
    icon: varchar('icon', { length: 40 }),
    sortOrder: integer('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [tenantIsolationPolicy(table.tenantId)],
);

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;

// The glyphs a category may use. A fixed list, not free text: the web app maps each name to a
// bundled icon, so anything else could never be drawn.
export const categoryIcons = [
  'cup-soda',
  'beef',
  'milk',
  'apple',
  'candy',
  'fish',
  'wheat',
  'egg',
  'sandwich',
  'shopping-basket',
  'leaf',
  'utensils',
] as const;

export const stockStatuses = ['available', 'limited', 'out'] as const;
export type StockStatus = (typeof stockStatuses)[number];

// No combos table — the buyer assembles their own combo in the cart from
// these directly. price_cents, unit_label and stock_status live here
// because there's no separate sellable bundle to carry them.
export const products = pgTable(
  'products',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    categoryId: uuid('category_id').references(() => categories.id),
    // URL segment for /products/[slug] (CLAUDE.md sections 7-8). Unique per
    // tenant among live products, so a deleted product's slug can be reused.
    slug: varchar('slug', { length: 100 }).notNull(),
    nameEs: varchar('name_es', { length: 255 }).notNull(),
    nameEn: varchar('name_en', { length: 255 }).notNull(),
    descriptionEs: text('description_es'),
    descriptionEn: text('description_en'),
    priceCents: integer('price_cents').notNull(),
    unitLabel: varchar('unit_label', { length: 50 }).notNull(),
    stockStatus: varchar('stock_status', { length: 20 }).notNull().default('available'),
    maxPerOrder: integer('max_per_order'),
    sortOrder: integer('sort_order').notNull().default(0),
    // Defaults to false: catalogService is the only thing allowed to flip
    // this to true, and only once the product has at least one `ready`
    // media row (see modules/media). A freshly-created product is a draft.
    active: boolean('active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    tenantIsolationPolicy(table.tenantId),
    uniqueIndex('products_tenant_slug_uq')
      .on(table.tenantId, table.slug)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

// --- request DTOs ---------------------------------------------------------

const slugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase alphanumeric words separated by single hyphens');

const nameSchema = z.string().trim().min(1).max(255);

export const createCategorySchema = z.object({
  nameEs: nameSchema,
  // `es` is required and `en` falls back to it (CLAUDE.md section 5).
  nameEn: nameSchema.optional(),
  icon: z.enum(categoryIcons).nullable().optional(),
  active: z.boolean().optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = createCategorySchema.partial();
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

// Deliberately no `active` here: a product only becomes active through
// catalogService.activateProduct, which enforces the "needs a ready
// picture" rule. Every product starts life as a draft.
export const createProductSchema = z.object({
  nameEs: nameSchema,
  nameEn: nameSchema.optional(),
  descriptionEs: z.string().trim().max(5000).nullable().optional(),
  descriptionEn: z.string().trim().max(5000).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  // Money is integer cents, never a float (CLAUDE.md section 5).
  priceCents: z.number().int().positive().max(100_000_000),
  unitLabel: z.string().trim().min(1).max(50),
  stockStatus: z.enum(stockStatuses).optional(),
  maxPerOrder: z.number().int().positive().max(1000).nullable().optional(),
  // Generated from nameEs when omitted.
  slug: slugSchema.optional(),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = createProductSchema.partial();
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const reorderSchema = z
  .object({ ids: z.array(z.string().uuid()).min(1).max(500) })
  .refine((value) => new Set(value.ids).size === value.ids.length, { message: 'ids must be unique' });
export type ReorderInput = z.infer<typeof reorderSchema>;

export const idParamSchema = z.object({ id: z.string().uuid() });
export const slugParamSchema = z.object({ slug: slugSchema });

export const adminProductsQuerySchema = z.object({
  categoryId: z.string().uuid().optional(),
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
});

export const publicProductsQuerySchema = z.object({
  categoryId: z.string().uuid().optional(),
});
