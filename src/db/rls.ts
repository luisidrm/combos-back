import { sql } from 'drizzle-orm';
import { pgPolicy, type AnyPgColumn } from 'drizzle-orm/pg-core';

// Every tenant-scoped table gets this exact policy on its tenant_id
// column. Centralized so isolation can't drift table to table — see the
// cross-tenant read test required by CLAUDE.md section 13.
export function tenantIsolationPolicy(tenantIdColumn: AnyPgColumn) {
  return pgPolicy('tenant_isolation', {
    for: 'all',
    using: sql`${tenantIdColumn} = current_setting('app.tenant_id')::uuid`,
    withCheck: sql`${tenantIdColumn} = current_setting('app.tenant_id')::uuid`,
  });
}
