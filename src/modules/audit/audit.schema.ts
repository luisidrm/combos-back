import { pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { tenantIsolationPolicy } from '../../db/rls.js';

// Cross-cutting: more than one module writes here (orders on every state
// transition, catalog/fulfilment later), which is why it's its own module
// rather than living under orders. entity_type + entity_id is polymorphic
// on purpose, same reasoning as media's owner_type/owner_id.
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    actorUserId: uuid('actor_user_id'), // nullable, soft ref -> identity.users
    entityType: varchar('entity_type', { length: 30 }).notNull(),
    entityId: uuid('entity_id').notNull(), // polymorphic, no FK
    action: varchar('action', { length: 50 }).notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [tenantIsolationPolicy(table.tenantId)],
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
