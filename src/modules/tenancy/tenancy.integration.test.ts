import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError } from '../../core/errors.js';
import { startTestDatabase, type TestDatabase } from '../../db/testing/test-database.js';
import type { tenancyService as tenancyServiceType } from './index.js';

// The store's public page reads its logo through the media module.
vi.mock('../../core/events.js', () => ({
  events: { emit: vi.fn().mockResolvedValue(undefined), on: vi.fn(), close: vi.fn() },
}));

describe('tenancy module', () => {
  let database: TestDatabase;
  let adminSql: postgres.Sql;
  let tenancy: typeof tenancyServiceType;

  const create = (slug: string, extra: Record<string, unknown> = {}) =>
    tenancy.createTenant({ slug, name: `Shop ${slug}`, ...extra });

  beforeAll(async () => {
    database = await startTestDatabase();
    adminSql = database.adminSql;
    tenancy = (await import('./index.js')).tenancyService;
  });

  afterAll(async () => {
    await database?.stop();
  });

  describe('creating and finding stores', () => {
    it('refuses a duplicate slug with a Conflict, not a raw database error', async () => {
      await create('dup');
      await expect(create('dup')).rejects.toBeInstanceOf(ConflictError);
    });

    it('resolves an active store by slug, and not an inactive or unknown one', async () => {
      const shop = await create('resolvable');
      expect((await tenancy.resolveBySlug('resolvable')).id).toBe(shop.id);

      await adminSql`update tenants set active = false where id = ${shop.id}`;
      await expect(tenancy.resolveBySlug('resolvable')).rejects.toBeInstanceOf(NotFoundError);
      await expect(tenancy.resolveBySlug('never-existed')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('lists only active stores, for maintenance jobs', async () => {
      const on = await create('listed-on');
      const off = await create('listed-off');
      await adminSql`update tenants set active = false where id = ${off.id}`;

      const ids = await tenancy.listActiveTenantIds();
      expect(ids).toContain(on.id);
      expect(ids).not.toContain(off.id);
    });
  });

  describe('the public store page', () => {
    it('exposes name, taglines, descriptions and the logo — and nothing internal', async () => {
      const shop = await create('public-page', {
        taglineEs: 'Entregas en Cuba',
        taglineEn: 'Deliveries in Cuba',
        descriptionEs: 'Combos para la familia',
      });
      const view = await tenancy.getPublicStore(shop.id);
      expect(view).toEqual({
        slug: 'public-page',
        name: 'Shop public-page',
        taglineEs: 'Entregas en Cuba',
        taglineEn: 'Deliveries in Cuba',
        descriptionEs: 'Combos para la familia',
        descriptionEn: null,
        logo: null,
      });
      expect(Object.keys(view).sort()).toEqual(
        ['descriptionEn', 'descriptionEs', 'logo', 'name', 'slug', 'taglineEn', 'taglineEs'],
      );
    });

    it("shows the store's own logo, and never another store's", async () => {
      const withLogo = await create('has-logo');
      const without = await create('no-logo');
      const key = `public/${withLogo.id}/tenant/${withLogo.id}/${crypto.randomUUID()}`;
      await adminSql`
        INSERT INTO media (tenant_id, owner_type, owner_id, key_original, key_thumb, key_card, key_full, status)
        VALUES (${withLogo.id}, 'tenant', ${withLogo.id}, ${`${withLogo.id}/tenant/${withLogo.id}/logo.png`},
                ${key + '.thumb.webp'}, ${key + '.card.webp'}, ${key + '.full.webp'}, 'ready')`;

      expect((await tenancy.getPublicStore(withLogo.id)).logo?.cardUrl).toMatch(/\.card\.webp$/);
      expect((await tenancy.getPublicStore(without.id)).logo).toBeNull();
    });

    it("ignores a logo that is still processing", async () => {
      const shop = await create('logo-pending');
      await adminSql`
        INSERT INTO media (tenant_id, owner_type, owner_id, key_original, status)
        VALUES (${shop.id}, 'tenant', ${shop.id}, ${`${shop.id}/tenant/${shop.id}/logo.png`}, 'pending')`;
      expect((await tenancy.getPublicStore(shop.id)).logo).toBeNull();
    });
  });

  describe('editing a store', () => {
    it('changes only what is sent, and clears a field with null', async () => {
      const shop = await create('editable', { taglineEs: 'Antes', descriptionEs: 'Descripción' });

      const renamed = await tenancy.updateStore(shop.id, { name: 'Nuevo Nombre', taglineEn: 'After' });
      expect(renamed).toMatchObject({
        name: 'Nuevo Nombre',
        taglineEs: 'Antes',
        taglineEn: 'After',
        descriptionEs: 'Descripción',
      });

      const cleared = await tenancy.updateStore(shop.id, { descriptionEs: null });
      expect(cleared.descriptionEs).toBeNull();
      expect(cleared.name).toBe('Nuevo Nombre');
    });

    it('treats an empty edit as a no-op', async () => {
      const shop = await create('no-op');
      const before = await tenancy.getPublicStore(shop.id);
      expect(await tenancy.updateStore(shop.id, {})).toMatchObject(before);
    });

    it('never lets an edit change the slug or the active flag', async () => {
      const shop = await create('locked');
      // The schema has no such fields; even a smuggled one is not written.
      await tenancy.updateStore(shop.id, { name: 'X', slug: 'hijacked', active: false } as never);
      const [row] = await adminSql<{ slug: string; active: boolean }[]>`select slug, active from tenants where id = ${shop.id}`;
      expect(row).toEqual({ slug: 'locked', active: true });
    });

    it('404s for a store that does not exist', async () => {
      await expect(tenancy.updateStore(crypto.randomUUID(), { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('store settings', () => {
    it('defaults to off, and can be switched on and off', async () => {
      const shop = await create('settings');
      expect(await tenancy.getSettings(shop.id)).toEqual({ requireDeliveryPhoto: false });

      const on = await tenancy.updateStore(shop.id, { settings: { requireDeliveryPhoto: true } });
      expect(on.settings).toEqual({ requireDeliveryPhoto: true });
      expect(await tenancy.getSettings(shop.id)).toEqual({ requireDeliveryPhoto: true });

      expect((await tenancy.updateStore(shop.id, { settings: { requireDeliveryPhoto: false } })).settings).toEqual({
        requireDeliveryPhoto: false,
      });
    });

    it('is stored under the snake_case key CLAUDE.md names, keeping any other settings', async () => {
      const shop = await create('settings-merge');
      await adminSql`update tenants set settings = ${adminSql.json({ some_future_setting: 42 })} where id = ${shop.id}`;

      await tenancy.updateStore(shop.id, { settings: { requireDeliveryPhoto: true } });
      const [row] = await adminSql<{ settings: Record<string, unknown> }[]>`select settings from tenants where id = ${shop.id}`;
      expect(row?.settings).toEqual({ some_future_setting: 42, require_delivery_photo: true });
    });

    it('leaves settings alone when an edit only touches branding', async () => {
      const shop = await create('settings-untouched');
      await tenancy.updateStore(shop.id, { settings: { requireDeliveryPhoto: true } });
      await tenancy.updateStore(shop.id, { name: 'Renamed' });
      expect(await tenancy.getSettings(shop.id)).toEqual({ requireDeliveryPhoto: true });
    });
  });
});
