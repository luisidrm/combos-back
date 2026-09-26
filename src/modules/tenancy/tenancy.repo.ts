import { eq } from 'drizzle-orm';
import type { db } from '../../db/client.js';
import { tenants, type NewTenant, type Tenant } from './tenancy.schema.js';

// tenants is global, so these take the plain db handle, not a tenant tx —
// the one deliberate exception to "every repo function takes tx first",
// because this table is the thing tenant context is resolved from.
export async function findBySlug(handle: typeof db, slug: string): Promise<Tenant | undefined> {
  const [tenant] = await handle.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  return tenant;
}

export async function findById(handle: typeof db, id: string): Promise<Tenant | undefined> {
  const [tenant] = await handle.select().from(tenants).where(eq(tenants.id, id)).limit(1);
  return tenant;
}

export async function insert(handle: typeof db, values: NewTenant): Promise<Tenant> {
  const [tenant] = await handle.insert(tenants).values(values).returning();
  if (!tenant) {
    throw new Error('Insert into tenants returned no row');
  }
  return tenant;
}

export async function listActiveIds(handle: typeof db): Promise<string[]> {
  const rows = await handle.select({ id: tenants.id }).from(tenants).where(eq(tenants.active, true));
  return rows.map((row) => row.id);
}

export async function update(handle: typeof db, id: string, values: Partial<NewTenant>): Promise<Tenant | undefined> {
  const [row] = await handle
    .update(tenants)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(tenants.id, id))
    .returning();
  return row;
}
