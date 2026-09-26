import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestDatabase, type TestDatabase } from './db/testing/test-database.js';
import type { catalogService as catalogServiceType } from './modules/catalog/index.js';

// Nothing here needs a real queue or Redis.
vi.mock('./core/queue.js', () => ({ redisConnection: {} }));
vi.mock('./core/events.js', () => ({
  events: { emit: vi.fn().mockResolvedValue(undefined), on: vi.fn(), close: vi.fn() },
}));

// The real app over real HTTP against a real Postgres (as the restricted app
// role), for every flow that needs no login: store setup, the public
// storefront, the guest cart. It also proves the earlier review findings are
// fixed as a client actually sees them.

describe('the app over HTTP, with a database', () => {
  let database: TestDatabase;
  let adminSql: postgres.Sql;
  let server: Server;
  let base: string;
  let catalog: typeof catalogServiceType;

  const PLATFORM_KEY = process.env.PLATFORM_API_KEY as string;
  const tenantIds: Record<string, string> = {};

  const api = (path: string, init: RequestInit & { tenant?: string; token?: string } = {}) => {
    const { tenant, token, headers, ...rest } = init;
    return fetch(`${base}${path}`, {
      ...rest,
      headers: {
        'content-type': 'application/json',
        ...(tenant ? { 'x-tenant-slug': tenant } : {}),
        ...(token ? { 'x-cart-token': token } : {}),
        ...(headers as Record<string, string> | undefined),
      },
    });
  };
  const json = async <T = Record<string, unknown>>(res: Response): Promise<T> => (await res.json()) as T;

  async function liveProduct(
    tenantSlug: string,
    name: string,
    options: { priceCents?: number; maxPerOrder?: number; stockStatus?: 'available' | 'limited' | 'out' } = {},
  ) {
    const tenantId = tenantIds[tenantSlug] as string;
    const product = await catalog.createProduct(tenantId, {
      nameEs: name,
      priceCents: options.priceCents ?? 1000,
      unitLabel: '1 lb',
      maxPerOrder: options.maxPerOrder,
      stockStatus: options.stockStatus,
    });
    const base_ = `public/${tenantId}/product/${product.id}/${crypto.randomUUID()}`;
    await adminSql`
      INSERT INTO media (tenant_id, owner_type, owner_id, key_original, key_thumb, key_card, key_full, status)
      VALUES (${tenantId}, 'product', ${product.id}, ${`${tenantId}/product/${product.id}/orig.jpg`},
              ${base_ + '.thumb.webp'}, ${base_ + '.card.webp'}, ${base_ + '.full.webp'}, 'ready')`;
    await catalog.activateProduct(tenantId, product.id);
    return product;
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    adminSql = database.adminSql;
    process.env.PLATFORM_API_KEY = PLATFORM_KEY;

    const { initSupertokens } = await import('./core/supertokens.js');
    const { createApp } = await import('./app.js');
    const { createMemoryStore } = await import('./core/rate-limit.js');
    catalog = (await import('./modules/catalog/index.js')).catalogService;

    initSupertokens();
    server = await new Promise<Server>((resolve) => {
      const s = createApp({ rateLimitStore: createMemoryStore() }).listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await database?.stop();
  });

  describe('creating stores', () => {
    const create = (slug: string, name: string) =>
      api('/tenancy', {
        method: 'POST',
        headers: { 'x-platform-key': PLATFORM_KEY },
        body: JSON.stringify({ slug, name, taglineEs: 'Entregas en Cuba', taglineEn: 'Deliveries in Cuba' }),
      });

    it('creates a store with the platform key', async () => {
      for (const [slug, name] of [
        ['shop-a', 'Shop A'],
        ['shop-b', 'Shop B'],
      ] as const) {
        const res = await create(slug, name);
        expect(res.status).toBe(201);
        tenantIds[slug] = (await json<{ id: string }>(res)).id;
      }
    });

    it('answers a duplicate slug with 409, not 500', async () => {
      const res = await create('shop-a', 'Again');
      expect(res.status).toBe(409);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('CONFLICT');
    });

    it('answers an unknown store with a JSON 404', async () => {
      const res = await api('/catalog/categories', { tenant: 'no-such-shop' });
      expect(res.status).toBe(404);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('NOT_FOUND');
    });
  });

  describe('the public store page', () => {
    it("shows a store's branding and nothing internal", async () => {
      const res = await api('/tenancy/current', { tenant: 'shop-a' });
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({
        slug: 'shop-a',
        name: 'Shop A',
        taglineEs: 'Entregas en Cuba',
        taglineEn: 'Deliveries in Cuba',
        descriptionEs: null,
        descriptionEn: null,
        logo: null,
      });
    });

    it('shows the logo once one is ready, as loadable URLs', async () => {
      const tenantId = tenantIds['shop-a'] as string;
      const key = `public/${tenantId}/tenant/${tenantId}/${crypto.randomUUID()}`;
      await adminSql`
        INSERT INTO media (tenant_id, owner_type, owner_id, key_original, key_thumb, key_card, key_full, status)
        VALUES (${tenantId}, 'tenant', ${tenantId}, ${`${tenantId}/tenant/${tenantId}/logo.png`},
                ${key + '.thumb.webp'}, ${key + '.card.webp'}, ${key + '.full.webp'}, 'ready')`;

      const { logo } = await json<{ logo: { thumbUrl: string; cardUrl: string } }>(await api('/tenancy/current', { tenant: 'shop-a' }));
      expect(logo.cardUrl).toMatch(/^https?:\/\/.+\.card\.webp$/);
      expect(JSON.stringify(logo)).not.toContain('key_original');
      expect(JSON.stringify(logo)).not.toContain('logo.png');
    });

    it("does not show one store's branding on another", async () => {
      const b = await json<{ name: string; logo: unknown }>(await api('/tenancy/current', { tenant: 'shop-b' }));
      expect(b.name).toBe('Shop B');
      expect(b.logo).toBeNull();
    });
  });

  describe('the storefront', () => {
    it('lists live products with picture URLs, never internals', async () => {
      const product = await liveProduct('shop-a', 'Pollo Ahumado', { priceCents: 1850 });
      const list = await json<Array<{ id: string; slug: string; cover: { cardUrl: string } }>>(
        await api('/catalog/products', { tenant: 'shop-a' }),
      );
      const listed = list.find((p) => p.id === product.id);
      expect(listed?.slug).toBe('pollo-ahumado');
      expect(listed?.cover.cardUrl).toMatch(/\/public\/.+\.card\.webp$/);

      const raw = JSON.stringify(list);
      for (const internal of ['keyOriginal', 'key_original', 'orig.jpg', 'tenantId', 'keyCard']) {
        expect(raw).not.toContain(internal);
      }
    });

    it('serves a product page by slug and 404s for an unknown one', async () => {
      const ok = await api('/catalog/products/pollo-ahumado', { tenant: 'shop-a' });
      expect(ok.status).toBe(200);
      expect((await json<{ pictures: unknown[] }>(ok)).pictures).toHaveLength(1);
      expect((await api('/catalog/products/no-such-thing', { tenant: 'shop-a' })).status).toBe(404);
    });

    it("does not show one store's products in another", async () => {
      expect(await json(await api('/catalog/products', { tenant: 'shop-b' }))).toEqual([]);
    });

    it('serves only public pictures, and refuses to list private ones', async () => {
      const product = await liveProduct('shop-a', 'Listable');
      const listed = await json<unknown[]>(await api(`/media?ownerType=product&ownerId=${product.id}`, { tenant: 'shop-a' }));
      expect(listed).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toMatch(/keyOriginal|tenantId|status/);

      // Profile and delivery-proof photos are not public.
      for (const ownerType of ['user', 'delivery']) {
        const res = await api(`/media?ownerType=${ownerType}&ownerId=${product.id}`, { tenant: 'shop-a' });
        expect(res.status).toBe(400);
      }
    });
  });

  describe('reference data', () => {
    it('serves provinces and municipalities with a cache header, no store needed', async () => {
      const [province] = await adminSql<{ id: string }[]>`
        INSERT INTO provinces (code, name_es, name_en) VALUES ('LHA', 'La Habana', 'Havana') RETURNING id`;
      await adminSql`INSERT INTO municipalities (province_id, name_es, name_en) VALUES (${province?.id as string}, 'Centro Habana', 'Centro Habana')`;

      const provinces = await api('/geo/provinces');
      expect(provinces.headers.get('cache-control')).toMatch(/public/);
      expect((await json<unknown[]>(provinces)).length).toBe(1);

      const municipalities = await json<unknown[]>(await api(`/geo/provinces/${province?.id as string}/municipalities`));
      expect(municipalities).toHaveLength(1);
    });
  });

  describe('the guest cart, as a client sees it', () => {
    // SuperTokens does its first handshake with its core on the first request
    // that passes through the optional-session check. Here the core is
    // unreachable, so that one request is very slow; absorb it in a hook
    // instead of letting it eat the first test's time budget.
    beforeAll(async () => {
      await api('/cart', { tenant: 'shop-a' });
    });

    it('adds, prices, and remembers a cart through the token', async () => {
      const arroz = await liveProduct('shop-a', 'Arroz', { priceCents: 950 });

      const added = await api('/cart/items', {
        method: 'POST',
        tenant: 'shop-a',
        body: JSON.stringify({ productId: arroz.id, quantity: 2 }),
      });
      expect(added.status).toBe(201);
      const first = await json<{ guestToken: string; subtotalCents: number; checkoutReady: boolean }>(added);
      expect(first.guestToken).toMatch(/^[a-f0-9]{64}$/);
      expect(first).toMatchObject({ subtotalCents: 1900, checkoutReady: true });

      const again = await json<{ itemCount: number; guestToken?: string }>(await api('/cart', { tenant: 'shop-a', token: first.guestToken }));
      expect(again.itemCount).toBe(2);
      expect(again.guestToken).toBeUndefined();
    });

    it("does not open one store's cart with another store's token", async () => {
      const arroz = await liveProduct('shop-a', 'Frijoles', { priceCents: 700 });
      const token = (
        await json<{ guestToken: string }>(
          await api('/cart/items', { method: 'POST', tenant: 'shop-a', body: JSON.stringify({ productId: arroz.id }) }),
        )
      ).guestToken;
      const atB = await json<{ items: unknown[] }>(await api('/cart', { tenant: 'shop-b', token }));
      expect(atB.items).toEqual([]);
    });

    it('tells the client WHICH field is wrong', async () => {
      const arroz = await liveProduct('shop-a', 'Validacion');
      const res = await api('/cart/items', {
        method: 'POST',
        tenant: 'shop-a',
        body: JSON.stringify({ productId: arroz.id, quantity: 0 }),
      });
      expect(res.status).toBe(400);
      const { error } = await json<{ error: { details: { issues: Array<{ location: string; path: string }> } } }>(res);
      expect(error.details.issues).toEqual([expect.objectContaining({ location: 'body', path: 'quantity' })]);
    });

    it('gives the client a machine-readable reason when a product is out of stock', async () => {
      const agotado = await liveProduct('shop-a', 'Agotado', { stockStatus: 'out' });
      const res = await api('/cart/items', {
        method: 'POST',
        tenant: 'shop-a',
        body: JSON.stringify({ productId: agotado.id, quantity: 1 }),
      });
      expect(res.status).toBe(409);
      expect((await json<{ error: { details: unknown } }>(res)).error.details).toEqual({ reason: 'OUT_OF_STOCK' });
    });

    it('says how many are allowed when the max per order is exceeded', async () => {
      const limitado = await liveProduct('shop-a', 'Limitado', { maxPerOrder: 3 });
      const res = await api('/cart/items', {
        method: 'POST',
        tenant: 'shop-a',
        body: JSON.stringify({ productId: limitado.id, quantity: 5 }),
      });
      expect(res.status).toBe(400);
      expect((await json<{ error: { details: unknown } }>(res)).error.details).toEqual({
        reason: 'EXCEEDS_MAX_PER_ORDER',
        max: 3,
      });
    });

    it('merges a local cart idempotently', async () => {
      const p = await liveProduct('shop-a', 'Merge Http');
      const merge = async (token?: string) =>
        json<{ guestToken?: string; itemCount: number }>(
          await api('/cart/merge', {
            method: 'POST',
            tenant: 'shop-a',
            token,
            body: JSON.stringify({ items: [{ productId: p.id, quantity: 4 }] }),
          }),
        );
      const first = await merge();
      expect(first.itemCount).toBe(4);
      const second = await merge(first.guestToken);
      expect(second.itemCount).toBe(4);
    });
  });

  describe('what needs a login refuses without one', () => {
    it.each([
      ['POST', '/catalog/products'],
      ['PATCH', '/tenancy/current'],
      ['POST', '/geo/delivery-zones'],
      ['GET', '/recipients'],
      ['POST', '/orders/quote'],
      ['GET', '/media/manage?ownerType=product&ownerId=11111111-1111-4111-8111-111111111111'],
    ])('%s %s -> 401', async (method, path) => {
      const res = await api(path, { method, tenant: 'shop-a', body: method === 'GET' ? undefined : '{}' });
      expect(res.status).toBe(401);
    });
  });
});
