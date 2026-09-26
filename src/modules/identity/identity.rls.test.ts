import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { withTenant } from '../../db/client.js';
import { startTestDatabase, type TestDatabase } from '../../db/testing/test-database.js';
import type * as IdentityRepoModule from './identity.repo.js';

// CLAUDE.md section 13: "Every tenant-scoped module needs a test that
// attempts a cross-tenant read and asserts zero rows." This is the
// identity module's — users is the first real tenant-scoped table.
//
// Deliberately connects to the DB as a restricted, non-BYPASSRLS role —
// the same role the app itself uses in production — because testing
// through a superuser connection would silently disable every RLS policy
// and let this test pass for the wrong reason (CLAUDE.md section 5). The
// schema and policies come from the real migrations (startTestDatabase),
// so this can't drift from what ships.

describe('identity module: cross-tenant isolation', () => {
  let database: TestDatabase;
  let tenantAId: string;
  let tenantBId: string;
  let userBId: string;

  let withTenantFn: typeof withTenant;
  let identityRepo: typeof IdentityRepoModule;

  beforeAll(async () => {
    database = await startTestDatabase();

    withTenantFn = (await import('../../db/client.js')).withTenant;
    identityRepo = await import('./identity.repo.js');

    tenantAId = crypto.randomUUID();
    tenantBId = crypto.randomUUID();

    const userB = await withTenantFn(tenantBId, (tx) =>
      identityRepo.insert(tx, {
        tenantId: tenantBId,
        supertokensUserId: crypto.randomUUID(),
        email: 'tenant-b-user@example.com',
      }),
    );
    userBId = userB.id;
  });

  afterAll(async () => {
    await database?.stop();
  });

  it('returns zero rows when tenant A reads a row that belongs to tenant B', async () => {
    const result = await withTenantFn(tenantAId, (tx) => identityRepo.findById(tx, userBId));
    expect(result).toBeUndefined();
  });

  it('returns the row when the owning tenant reads it', async () => {
    const result = await withTenantFn(tenantBId, (tx) => identityRepo.findById(tx, userBId));
    expect(result?.id).toBe(userBId);
  });

  it('updates zero rows when tenant A changes the role of a user in tenant B', async () => {
    const result = await withTenantFn(tenantAId, (tx) => identityRepo.updateRole(tx, userBId, 'admin'));
    expect(result).toBeUndefined();

    const stillBuyer = await withTenantFn(tenantBId, (tx) => identityRepo.findById(tx, userBId));
    expect(stillBuyer?.role).toBe('buyer');
  });

  it('lets one supertokens user have a separate row in each tenant', async () => {
    // SuperTokens users are global, so the same person can buy from two shops.
    const supertokensUserId = crypto.randomUUID();
    const inA = await withTenantFn(tenantAId, (tx) =>
      identityRepo.insert(tx, { tenantId: tenantAId, supertokensUserId, email: 'shared@example.com' }),
    );
    const inB = await withTenantFn(tenantBId, (tx) =>
      identityRepo.insert(tx, { tenantId: tenantBId, supertokensUserId, email: 'shared@example.com' }),
    );
    expect(inA.id).not.toBe(inB.id);

    // ...but only one row per tenant.
    await expect(
      withTenantFn(tenantAId, (tx) =>
        identityRepo.insert(tx, { tenantId: tenantAId, supertokensUserId, email: 'shared@example.com' }),
      ),
    ).rejects.toThrow();
  });
});
