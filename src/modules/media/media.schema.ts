import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { tenantIsolationPolicy } from '../../db/rls.js';

// 'tenant' is the one case where owner_id equals tenant_id — a store's
// logo belongs to the tenant itself, not a separately-owned entity.
export const mediaOwnerTypes = ['product', 'user', 'delivery', 'tenant'] as const;
export type MediaOwnerType = (typeof mediaOwnerTypes)[number];

export const mediaStatuses = ['pending', 'ready', 'failed'] as const;
export type MediaStatus = (typeof mediaStatuses)[number];

// One table for every picture in the system. owner_type + owner_id is
// polymorphic and deliberately carries no FK — media can't import
// catalog's, identity's, or fulfilment's schema.ts, and a join table per
// owner wouldn't buy back any real safety under that same rule.
export const media = pgTable(
  'media',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    ownerType: varchar('owner_type', { length: 20 }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isCover: boolean('is_cover').notNull().default(false),
    altTextEs: varchar('alt_text_es', { length: 255 }),
    altTextEn: varchar('alt_text_en', { length: 255 }),
    keyOriginal: varchar('key_original', { length: 500 }).notNull(),
    // Derivatives are filled in by the async MinIO worker (CLAUDE.md §11)
    // — null until status moves to 'ready'.
    keyThumb: varchar('key_thumb', { length: 500 }),
    keyCard: varchar('key_card', { length: 500 }),
    keyFull: varchar('key_full', { length: 500 }),
    width: integer('width'),
    height: integer('height'),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    tenantIsolationPolicy(table.tenantId),
    // At most one is_cover row per owner. Excludes soft-deleted rows so a
    // new cover can be set after the old one is removed.
    uniqueIndex('media_one_cover_per_owner')
      .on(table.tenantId, table.ownerType, table.ownerId)
      .where(sql`${table.isCover} = true AND ${table.deletedAt} IS NULL`),
  ],
);

export type Media = typeof media.$inferSelect;
export type NewMedia = typeof media.$inferInsert;

// Only formats sharp decodes everywhere. The admin client re-encodes photos
// to WebP before uploading (CLAUDE.md section 9), so this is generous.
// Each maps to the extension its stored object gets — the client's own
// filename is never used in a storage key.
export const uploadContentTypes = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
} as const;
export type UploadContentType = keyof typeof uploadContentTypes;

// Enforced by MinIO itself through the presigned POST policy, not just by
// the API: a presigned URL alone can't limit size, a POST policy can.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const requestUploadSchema = z.object({
  ownerType: z.enum(mediaOwnerTypes),
  ownerId: z.string().uuid(),
  contentType: z.enum(Object.keys(uploadContentTypes) as [UploadContentType, ...UploadContentType[]]),
});
export type RequestUploadInput = z.infer<typeof requestUploadSchema>;

export const ownerRefSchema = z.object({
  ownerType: z.enum(mediaOwnerTypes),
  ownerId: z.string().uuid(),
});
export type OwnerRefInput = z.infer<typeof ownerRefSchema>;

// The public storefront can only ask about pictures that are meant to be
// public. Profile and delivery-proof photos are private: they are read
// through the authenticated /media/manage instead.
export const publicOwnerTypes = ['product', 'tenant'] as const;
export const publicListQuerySchema = z.object({
  ownerType: z.enum(publicOwnerTypes),
  ownerId: z.string().uuid(),
});

export const updateMediaSchema = z.object({
  altTextEs: z.string().trim().max(255).nullable().optional(),
  altTextEn: z.string().trim().max(255).nullable().optional(),
});
export type UpdateMediaInput = z.infer<typeof updateMediaSchema>;

export const reorderMediaSchema = ownerRefSchema.extend({
  ids: z.array(z.string().uuid()).min(1).max(100),
});
export type ReorderMediaInput = z.infer<typeof reorderMediaSchema>;

export const mediaIdParamSchema = z.object({ id: z.string().uuid() });

