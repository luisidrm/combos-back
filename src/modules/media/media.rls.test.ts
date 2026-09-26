import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../db/testing/test-database.js';
import type { withTenant } from '../../db/client.js';
import type * as MediaRepoModule from './media.repo.js';

// CLAUDE.md section 13: "Every tenant-scoped module needs a test that
// attempts a cross-tenant read and asserts zero rows." Builds the schema
// from the real migrations and connects as the restricted, non-BYPASSRLS
// role — see startTestDatabase and identity.rls.test.ts for why.

describe('media module: cross-tenant isolation', () => {
  let database: TestDatabase;
  let tenantAId: string;
  let tenantBId: string;
  let mediaBId: string;

  let withTenantFn: typeof withTenant;
  let mediaRepo: typeof MediaRepoModule;

  beforeAll(async () => {
    database = await startTestDatabase();

    withTenantFn = (await import('../../db/client.js')).withTenant;
    mediaRepo = await import('./media.repo.js');

    tenantAId = crypto.randomUUID();
    tenantBId = crypto.randomUUID();

    const mediaB = await withTenantFn(tenantBId, (tx) =>
      mediaRepo.insert(tx, {
        tenantId: tenantBId,
        ownerType: 'product',
        ownerId: crypto.randomUUID(),
        keyOriginal: `${tenantBId}/product/test/original.jpg`,
        status: 'pending',
      }),
    );
    mediaBId = mediaB.id;
  });

  afterAll(async () => {
    await database?.stop();
  });

  it('returns zero rows when tenant A reads a row that belongs to tenant B', async () => {
    const result = await withTenantFn(tenantAId, (tx) => mediaRepo.findById(tx, mediaBId));
    expect(result).toBeUndefined();
  });

  it('returns the row when the owning tenant reads it', async () => {
    const result = await withTenantFn(tenantBId, (tx) => mediaRepo.findById(tx, mediaBId));
    expect(result?.id).toBe(mediaBId);
  });

  it("returns none of tenant B's pictures when tenant A lists by owner", async () => {
    const [row] = await database.adminSql<{ owner_id: string }[]>`select owner_id from media where id = ${mediaBId}`;
    const ownerId = row?.owner_id as string;
    expect(await withTenantFn(tenantAId, (tx) => mediaRepo.findByOwner(tx, 'product', ownerId))).toEqual([]);
    expect(await withTenantFn(tenantAId, (tx) => mediaRepo.findReadyByOwners(tx, 'product', [ownerId]))).toEqual([]);
  });

  it('enforces at most one cover per owner, at the database level', async () => {
    const ownerId = crypto.randomUUID();
    const insertCover = () =>
      withTenantFn(tenantBId, (tx) =>
        mediaRepo.insert(tx, {
          tenantId: tenantBId,
          ownerType: 'product',
          ownerId,
          keyOriginal: `${tenantBId}/product/${ownerId}/${crypto.randomUUID()}.jpg`,
          status: 'ready',
          isCover: true,
        }),
      );
    await insertCover();
    await expect(insertCover()).rejects.toThrow();
  });
});
