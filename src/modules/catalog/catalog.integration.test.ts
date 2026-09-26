import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { startTestDatabase, type TestDatabase } from '../../db/testing/test-database.js';
import type { mediaService as mediaServiceType } from '../media/index.js';
import type { catalogService as catalogServiceType } from './index.js';

// The event bus is Redis-backed; nothing here needs a real queue, and the
// real one would try to connect to Redis on import.
vi.mock('../../core/events.js', () => ({
  events: { emit: vi.fn().mockResolvedValue(undefined), on: vi.fn() },
}));

// Covers CLAUDE.md section 13's required cross-tenant test for the catalog
// tables, plus the business rules that live in catalogService. Like the
// other integration tests it connects as a restricted, non-BYPASSRLS role
// (see identity.rls.test.ts for why), but builds the schema from the real
// migrations. Requires Docker.

describe('catalog module', () => {
  let database: TestDatabase;
  let adminSql: postgres.Sql;
  let catalog: typeof catalogServiceType;
  let mediaService: typeof mediaServiceType;
  let emitMock: ReturnType<typeof vi.fn>;

  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();

  // Inserts a picture as the superuser, bypassing the upload pipeline —
  // what matters here is only its status and cover flag.
  async function insertPicture(
    tenantId: string,
    productId: string,
    { status = 'ready', isCover = false }: { status?: string; isCover?: boolean } = {},
  ): Promise<string> {
    const key = `${tenantId}/product/${productId}/${crypto.randomUUID()}`;
    const [row] = await adminSql<{ id: string }[]>`
      INSERT INTO media (tenant_id, owner_type, owner_id, key_original, key_thumb, key_card, key_full, status, is_cover)
      VALUES (${tenantId}, 'product', ${productId}, ${key}, ${key + '.thumb.webp'}, ${key + '.card.webp'},
              ${key + '.full.webp'}, ${status}, ${isCover})
      RETURNING id
    `;
    if (!row) {
      throw new Error('insert into media returned no row');
    }
    return row.id;
  }

  const product = (name: string, overrides: Record<string, unknown> = {}) => ({
    nameEs: name,
    priceCents: 1250,
    unitLabel: '1 lb',
    ...overrides,
  });

  beforeAll(async () => {
    database = await startTestDatabase();
    adminSql = database.adminSql;

    catalog = (await import('./index.js')).catalogService;
    mediaService = (await import('../media/index.js')).mediaService;
    emitMock = vi.mocked((await import('../../core/events.js')).events.emit);
  });

  afterAll(async () => {
    await database?.stop();
  });

  describe('cross-tenant isolation', () => {
    let productBId: string;
    let categoryBId: string;

    beforeAll(async () => {
      categoryBId = (await catalog.createCategory(tenantB, { nameEs: 'Carnes' })).id;
      productBId = (await catalog.createProduct(tenantB, product('Pollo Ahumado', { categoryId: categoryBId }))).id;
    });

    it('returns nothing when tenant A reads a product that belongs to tenant B', async () => {
      await expect(catalog.getProductForAdmin(tenantA, productBId)).rejects.toBeInstanceOf(NotFoundError);
      expect(await catalog.listProductsForAdmin(tenantA, {})).toEqual([]);
      expect(await catalog.getProductSnapshots(tenantA, [productBId])).toEqual([]);
    });

    it('returns nothing when tenant A reads a category that belongs to tenant B', async () => {
      expect(await catalog.listCategoriesForAdmin(tenantA)).toEqual([]);
      expect(await catalog.listPublicCategories(tenantA)).toEqual([]);
    });

    it("lets tenant B read its own rows (so the checks above aren't vacuous)", async () => {
      expect((await catalog.getProductForAdmin(tenantB, productBId)).id).toBe(productBId);
      expect(await catalog.listCategoriesForAdmin(tenantB)).toHaveLength(1);
    });

    it("refuses to file tenant A's product under tenant B's category", async () => {
      // The FK alone would accept this — FK checks bypass RLS — so the
      // service's own look-up is the only thing standing in the way.
      await expect(catalog.createProduct(tenantA, product('Arroz', { categoryId: categoryBId }))).rejects.toBeInstanceOf(
        NotFoundError,
      );

      const own = await catalog.createProduct(tenantA, product('Arroz'));
      await expect(catalog.updateProduct(tenantA, own.id, { categoryId: categoryBId })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("cannot change or delete tenant B's product", async () => {
      await expect(catalog.updateProduct(tenantA, productBId, { priceCents: 1 })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(catalog.deleteProduct(tenantA, productBId)).rejects.toBeInstanceOf(NotFoundError);
      expect((await catalog.getProductForAdmin(tenantB, productBId)).priceCents).toBe(1250);
    });
  });

  describe('products', () => {
    it('creates a draft with a slug generated from the name, and en falling back to es', async () => {
      const created = await catalog.createProduct(tenantA, product('Frijoles Negros'));
      expect(created.active).toBe(false);
      expect(created.slug).toBe('frijoles-negros');
      expect(created.nameEn).toBe('Frijoles Negros');
      expect(created.stockStatus).toBe('available');
    });

    it('suffixes the slug when the name collides, and rejects an explicit duplicate', async () => {
      const first = await catalog.createProduct(tenantA, product('Café Molido'));
      const second = await catalog.createProduct(tenantA, product('Café Molido'));
      expect(first.slug).toBe('cafe-molido');
      expect(second.slug).toBe('cafe-molido-2');

      await expect(catalog.createProduct(tenantA, product('Otro', { slug: 'cafe-molido' }))).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it('lets the same slug exist in two tenants', async () => {
      const inA = await catalog.createProduct(tenantA, product('Aceite'));
      const inB = await catalog.createProduct(tenantB, product('Aceite'));
      expect(inA.slug).toBe('aceite');
      expect(inB.slug).toBe('aceite');
    });

    it('frees a slug when its product is deleted', async () => {
      const first = await catalog.createProduct(tenantA, product('Leche en Polvo'));
      await catalog.deleteProduct(tenantA, first.id);
      const again = await catalog.createProduct(tenantA, product('Leche en Polvo'));
      expect(again.slug).toBe('leche-en-polvo');
    });

    it('applies a partial update and treats an empty patch as a no-op', async () => {
      const created = await catalog.createProduct(tenantA, product('Azúcar'));
      const updated = await catalog.updateProduct(tenantA, created.id, { stockStatus: 'limited', priceCents: 999 });
      expect(updated.stockStatus).toBe('limited');
      expect(updated.priceCents).toBe(999);
      expect(updated.nameEs).toBe('Azúcar');

      const untouched = await catalog.updateProduct(tenantA, created.id, {});
      expect(untouched.priceCents).toBe(999);
    });

    it('reorders products, and applies nothing when an id is unknown', async () => {
      const a = await catalog.createProduct(tenantA, product('Orden A'));
      const b = await catalog.createProduct(tenantA, product('Orden B'));
      const c = await catalog.createProduct(tenantA, product('Orden C'));
      const ours = [a.id, b.id, c.id];
      const currentOrder = async () =>
        (await catalog.listProductsForAdmin(tenantA, {})).filter((p) => ours.includes(p.id)).map((p) => p.id);

      await catalog.reorderProducts(tenantA, [c.id, a.id, b.id]);
      expect(await currentOrder()).toEqual([c.id, a.id, b.id]);

      await expect(catalog.reorderProducts(tenantA, [b.id, a.id, crypto.randomUUID()])).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(await currentOrder()).toEqual([c.id, a.id, b.id]);
    });
  });

  describe('activation gate', () => {
    it('refuses to activate a product with no picture', async () => {
      const draft = await catalog.createProduct(tenantA, product('Sin Foto'));
      await expect(catalog.activateProduct(tenantA, draft.id)).rejects.toBeInstanceOf(ConflictError);
      expect((await catalog.getProductForAdmin(tenantA, draft.id)).active).toBe(false);
    });

    it('refuses while the only pictures are still pending or failed', async () => {
      const draft = await catalog.createProduct(tenantA, product('Foto Pendiente'));
      await insertPicture(tenantA, draft.id, { status: 'pending' });
      await insertPicture(tenantA, draft.id, { status: 'failed' });
      await expect(catalog.activateProduct(tenantA, draft.id)).rejects.toBeInstanceOf(ConflictError);
    });

    it('activates once a picture is ready, and is idempotent', async () => {
      const draft = await catalog.createProduct(tenantA, product('Con Foto'));
      await insertPicture(tenantA, draft.id);
      expect((await catalog.activateProduct(tenantA, draft.id)).active).toBe(true);
      expect((await catalog.activateProduct(tenantA, draft.id)).active).toBe(true);
    });

    it('does not let a picture from another tenant satisfy the gate', async () => {
      const draft = await catalog.createProduct(tenantA, product('Foto Ajena'));
      await insertPicture(tenantB, draft.id);
      await expect(catalog.activateProduct(tenantA, draft.id)).rejects.toBeInstanceOf(ConflictError);
    });

    it('pulls a product back to draft when its last ready picture is deleted', async () => {
      const live = await catalog.createProduct(tenantA, product('Se Queda Sin Foto'));
      const pictureId = await insertPicture(tenantA, live.id);
      await catalog.activateProduct(tenantA, live.id);

      emitMock.mockClear();
      await mediaService.deleteMedia(tenantA, pictureId);
      expect(emitMock).toHaveBeenCalledWith('media.deleted', {
        mediaId: pictureId,
        tenantId: tenantA,
        ownerType: 'product',
        ownerId: live.id,
      });

      // What the worker does on receiving that event.
      await catalog.deactivateIfNoReadyPicture(tenantA, live.id);
      expect((await catalog.getProductForAdmin(tenantA, live.id)).active).toBe(false);
    });

    it('keeps a product live while another ready picture remains', async () => {
      const live = await catalog.createProduct(tenantA, product('Dos Fotos'));
      const first = await insertPicture(tenantA, live.id);
      await insertPicture(tenantA, live.id);
      await catalog.activateProduct(tenantA, live.id);

      await mediaService.deleteMedia(tenantA, first);
      await catalog.deactivateIfNoReadyPicture(tenantA, live.id);
      expect((await catalog.getProductForAdmin(tenantA, live.id)).active).toBe(true);
    });
  });

  describe('storefront reads', () => {
    it('lists only active products, cover picture first, with derivative keys and no originals', async () => {
      const draft = await catalog.createProduct(tenantA, product('Borrador Publico'));
      const live = await catalog.createProduct(tenantA, product('Publicado'));
      await insertPicture(tenantA, live.id);
      const coverId = await insertPicture(tenantA, live.id, { isCover: true });
      await catalog.activateProduct(tenantA, live.id);

      const list = await catalog.listPublicProducts(tenantA, {});
      expect(list.map((p) => p.id)).toContain(live.id);
      expect(list.map((p) => p.id)).not.toContain(draft.id);

      const listed = list.find((p) => p.id === live.id);
      expect(listed?.cover?.id).toBe(coverId);
      expect(listed?.cover?.cardUrl).toMatch(/^https?:\/\/.+\/.+\.card\.webp$/);
      // Only loadable URLs are exposed: no storage keys, no original, no tenant.
      for (const internal of ['keyOriginal', 'keyCard', 'keyThumb', 'keyFull', 'tenantId']) {
        expect(JSON.stringify(list)).not.toContain(internal);
      }
    });

    it('returns a product by slug with all its pictures, and 404s for a draft', async () => {
      const draft = await catalog.createProduct(tenantA, product('Borrador Detalle'));
      await expect(catalog.getPublicProductBySlug(tenantA, draft.slug)).rejects.toBeInstanceOf(NotFoundError);

      const live = await catalog.createProduct(tenantA, product('Detalle Publicado'));
      await insertPicture(tenantA, live.id);
      await insertPicture(tenantA, live.id);
      await catalog.activateProduct(tenantA, live.id);

      const detail = await catalog.getPublicProductBySlug(tenantA, live.slug);
      expect(detail.pictures).toHaveLength(2);
      expect(detail.cover?.id).toBe(detail.pictures[0]?.id);
    });

    it('does not resolve a slug across tenants', async () => {
      const live = await catalog.createProduct(tenantA, product('Solo En A'));
      await insertPicture(tenantA, live.id);
      await catalog.activateProduct(tenantA, live.id);
      await expect(catalog.getPublicProductBySlug(tenantB, live.slug)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('filters by category and hides inactive categories', async () => {
      const category = await catalog.createCategory(tenantA, { nameEs: 'Bebidas' });
      const inCategory = await catalog.createProduct(tenantA, product('Refresco', { categoryId: category.id }));
      const outside = await catalog.createProduct(tenantA, product('Galletas'));
      for (const p of [inCategory, outside]) {
        await insertPicture(tenantA, p.id);
        await catalog.activateProduct(tenantA, p.id);
      }

      const filtered = await catalog.listPublicProducts(tenantA, { categoryId: category.id });
      expect(filtered.map((p) => p.id)).toEqual([inCategory.id]);

      await catalog.updateCategory(tenantA, category.id, { active: false });
      expect((await catalog.listPublicCategories(tenantA)).map((c) => c.id)).not.toContain(category.id);
    });
  });

  describe('categories', () => {
    it('detaches its products when deleted', async () => {
      const category = await catalog.createCategory(tenantA, { nameEs: 'Temporal', nameEn: 'Temporary' });
      const filed = await catalog.createProduct(tenantA, product('Archivado', { categoryId: category.id }));

      await catalog.deleteCategory(tenantA, category.id);
      expect((await catalog.getProductForAdmin(tenantA, filed.id)).categoryId).toBeNull();
      expect((await catalog.listCategoriesForAdmin(tenantA)).map((c) => c.id)).not.toContain(category.id);
    });

    it('reorders categories', async () => {
      const x = await catalog.createCategory(tenantA, { nameEs: 'Cat X' });
      const y = await catalog.createCategory(tenantA, { nameEs: 'Cat Y' });
      await catalog.reorderCategories(tenantA, [y.id, x.id]);
      const order = (await catalog.listCategoriesForAdmin(tenantA))
        .filter((c) => [x.id, y.id].includes(c.id))
        .map((c) => c.id);
      expect(order).toEqual([y.id, x.id]);
    });
  });

  describe('snapshots for other modules', () => {
    it('returns pricing data for the requested ids only', async () => {
      const wanted = await catalog.createProduct(tenantA, product('Snapshot Uno', { priceCents: 4321 }));
      await catalog.createProduct(tenantA, product('Snapshot Dos'));

      const snapshots = await catalog.getProductSnapshots(tenantA, [wanted.id, crypto.randomUUID()]);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({ id: wanted.id, priceCents: 4321, unitLabel: '1 lb', active: false });
    });
  });
});
