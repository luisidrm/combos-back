import { pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { tenantIsolationPolicy } from '../../db/rls.js';

// staff = the packer: sees and advances orders and flips stock/visibility, but cannot touch
// money, prices, deletions, analytics or settings (see the route guards in orders/catalog).
export const roles = ['buyer', 'admin', 'staff', 'courier'] as const;
export type Role = (typeof roles)[number];

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    supertokensUserId: varchar('supertokens_user_id', { length: 36 }).notNull(),
    email: varchar('email', { length: 255 }).notNull(),
    role: varchar('role', { length: 20 }).notNull().default('buyer'),
    // Collected at buyer signup (the design's form asks for both); null for
    // staff and for accounts created before these columns existed.
    fullName: varchar('full_name', { length: 255 }),
    phone: varchar('phone', { length: 20 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    tenantIsolationPolicy(table.tenantId),
    // SuperTokens users are global (one per email), so the same person can
    // buy from two shops: one `users` row per (tenant, supertokens user),
    // not one per supertokens user.
    uniqueIndex('users_tenant_supertokens_user_uq').on(table.tenantId, table.supertokensUserId),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
