import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../db/testing/test-database.js';
import type { notificationsService as notificationsServiceType } from './index.js';

vi.mock('../../core/events.js', () => ({
  events: { emit: vi.fn().mockResolvedValue(undefined), on: vi.fn(), close: vi.fn() },
}));

// The in-app feed: each person has their own, a store never sees another's, and "read" only ever touches the caller's rows.
describe('notifications module: the in-app feed', () => {
  let database: TestDatabase;
  let service: typeof notificationsServiceType;
  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();
  const alice = crypto.randomUUID();
  const bob = crypto.randomUUID();

  beforeAll(async () => {
    database = await startTestDatabase();
    for (const id of [tenantA, tenantB]) {
      await database.adminSql`INSERT INTO tenants (id, slug, name) VALUES (${id}, ${`t-${id.slice(0, 8)}`}, 'Test store')`;
    }
    service = (await import('./index.js')).notificationsService;
  });

  afterAll(async () => {
    await database?.stop();
  });

  it('tells each person, and only that person, with the facts for the sentence', async () => {
    await service.notifyUsers(tenantA, [alice, alice, bob], { kind: 'new_order', orderId: crypto.randomUUID(), orderNumber: 'FC-1', data: { courierName: 'Carlos' } });
    const mine = await service.pageForUser(tenantA, alice, { limit: 30 });
    expect(mine.items).toHaveLength(1); // the duplicate id is told once
    expect(mine.items[0]).toMatchObject({ kind: 'new_order', orderNumber: 'FC-1', read: false, data: { courierName: 'Carlos' } });
    expect(await service.unreadCount(tenantA, alice)).toBe(1);
    expect(await service.unreadCount(tenantA, bob)).toBe(1);
  });

  it('marks read: some ids, or everything, and never another person’s', async () => {
    await service.notifyUsers(tenantA, [alice], { kind: 'order_paid', orderNumber: 'FC-2' });
    await service.notifyUsers(tenantA, [alice], { kind: 'order_delivered', orderNumber: 'FC-3' });
    const before = await service.pageForUser(tenantA, alice, { limit: 30 });
    const first = before.items[0];
    if (!first) throw new Error('no notification');

    await service.markRead(tenantA, bob, [first.id]); // bob cannot touch alice's
    expect((await service.pageForUser(tenantA, alice, { limit: 30 })).items.find((i) => i.id === first.id)?.read).toBe(false);

    await service.markRead(tenantA, alice, [first.id]);
    expect(await service.unreadCount(tenantA, alice)).toBe(before.items.length - 1);
    await service.markRead(tenantA, alice, 'all');
    expect(await service.unreadCount(tenantA, alice)).toBe(0);
    expect(await service.unreadCount(tenantA, bob)).toBe(1); // untouched
    expect((await service.pageForUser(tenantA, alice, { limit: 30 }, true)).items).toHaveLength(0);
  });

  it('pages newest first through a cursor, without repeats', async () => {
    const carol = crypto.randomUUID();
    for (let i = 1; i <= 5; i += 1) await service.notifyUsers(tenantA, [carol], { kind: 'order_paid', orderNumber: `FC-${i}` });
    const one = await service.pageForUser(tenantA, carol, { limit: 2 });
    expect(one.items.map((i) => i.orderNumber)).toEqual(['FC-5', 'FC-4']);
    const two = await service.pageForUser(tenantA, carol, { limit: 2, cursor: one.nextCursor ?? undefined });
    expect(two.items.map((i) => i.orderNumber)).toEqual(['FC-3', 'FC-2']);
    const three = await service.pageForUser(tenantA, carol, { limit: 2, cursor: two.nextCursor ?? undefined });
    expect(three.items.map((i) => i.orderNumber)).toEqual(['FC-1']);
    expect(three.nextCursor).toBeNull();
    await expect(service.pageForUser(tenantA, carol, { limit: 2, cursor: 'garbage' })).rejects.toMatchObject({ details: { reason: 'BAD_CURSOR' } });
  });

  it("keeps one store's feed out of another's", async () => {
    expect((await service.pageForUser(tenantB, alice, { limit: 30 })).items).toHaveLength(0);
    expect(await service.unreadCount(tenantB, alice)).toBe(0);
    const rows = await database.adminSql`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = ${tenantA}`;
    expect(rows[0]?.n).toBeGreaterThan(0); // sanity: the rows really exist
  });

  it('forgets what is older than 60 days', async () => {
    const dave = crypto.randomUUID();
    await service.notifyUsers(tenantA, [dave], { kind: 'order_paid', orderNumber: 'FC-OLD' });
    await database.adminSql`UPDATE notifications SET created_at = now() - interval '61 days' WHERE user_id = ${dave}`;
    expect(await service.pruneOld(tenantA)).toBeGreaterThanOrEqual(1);
    expect((await service.pageForUser(tenantA, dave, { limit: 30 })).items).toHaveLength(0);
  });
});
