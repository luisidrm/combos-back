import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config/index.js';

// Exported so one-off scripts (seeds) can close the pool cleanly when
// they're done — the long-running server process never needs to call this.
// connect_timeout is generous (default is lower) because this machine's
// Docker Desktop port-forwarding is intermittently slow enough to blow
// past the default — confirmed via pg_isready succeeding inside the
// container at the same moment a host connection was timing out.
export const sqlClient = postgres(config.databaseUrl, { max: config.databasePoolMax, connect_timeout: 30 });
const client = sqlClient;

// Only for queries against tables that are genuinely global (e.g. looking
// up a tenant by slug before a tenant context exists). Every tenant-scoped
// query goes through withTenant() below instead.
export const db = drizzle(client);

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// The application connects as a role WITHOUT BYPASSRLS. A superuser
// connection silently disables every RLS policy — check this first if
// isolation tests ever pass suspiciously (CLAUDE.md section 5).
export async function withTenant<T>(tenantId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // The `true` third argument makes this transaction-scoped (SET LOCAL
    // semantics), so a pooled connection can never leak it into the next
    // request. Do not change this to session-scoped.
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
