import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { startTestDatabase, type TestDatabase } from '../../db/testing/test-database.js';
import type { catalogService as catalogServiceType } from '../catalog/index.js';
import type { cartService as cartServiceType } from './index.js';

// The event bus is Redis-backed and nothing here needs a real queue.
vi.mock('../../core/events.js', () => ({
  events: { emit: vi.fn().mockResolvedValue(undefined), on: vi.fn() },
}));

// The cart prices and vets every line through catalogService, so these use
// the real catalog against the real schema. Also carries the module's
// cross-tenant test (CLAUDE.md section 13).

describe('cart module', () => {
  let database: TestDatabase;
  let adminSql: postgres.Sql;
  let cart: typeof cartServiceType;
  let catalog: typeof catalogServiceType;

  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();

  // A live product: created, given a ready picture, activated.
  async function liveProduct(
    tenantId: string,
    name: string,
    { priceCents = 1000, maxPerOrder, stockStatus }: { priceCents?: number; maxPerOrder?: number; stockStatus?: 'available' | 'limited' | 'out' } = {},
  ) {
    const product = await catalog.createProduct(tenantId, {
      nameEs: name,
      priceCents,
      unitLabel: '1 lb',
      maxPerOrder,
      stockStatus,
    });
    const key = `${tenantId}/product/${product.id}/${crypto.randomUUID()}`;
    await adminSql`
      INSERT INTO media (tenant_id, owner_type, owner_id, key_original, key_thumb, key_card, key_full, status)
      VALUES (${tenantId}, 'product', ${product.id}, ${key}, ${key + '.thumb.webp'}, ${key + '.card.webp'},
              ${key + '.full.webp'}, 'ready')`;
    await catalog.activateProduct(tenantId, product.id);
    return product;
  }

  const count = async (query: postgres.PendingQuery<postgres.Row[]>): Promise<number> => {
    const [row] = await query;
    return Number(row?.n);
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    adminSql = database.adminSql;
    catalog = (await import('../catalog/index.js')).catalogService;
    cart = (await import('./index.js')).cartService;
  });

  afterAll(async () => {
    await database?.stop();
  });

  describe('as a guest', () => {
    it('reading a cart never creates one', async () => {
      const before = await count(adminSql`select count(*) as n from carts`);
      const view = await cart.getCart(tenantA, {});
      expect(view).toMatchObject({ items: [], itemCount: 0, subtotalCents: 0, checkoutReady: false });
      expect(await cart.getCart(tenantA, { guestToken: 'a'.repeat(64) })).toMatchObject({ items: [] });
      expect(await count(adminSql`select count(*) as n from carts`)).toBe(before);
    });

    it('mints a token on first add, prices the line, and bumps quantity on re-add', async () => {
      const pollo = await liveProduct(tenantA, 'Pollo Guest', { priceCents: 1850 });

      const first = await cart.addItem(tenantA, {}, { productId: pollo.id, quantity: 2 });
      expect(first.guestToken).toMatch(/^[a-f0-9]{64}$/);
      expect(first.items).toHaveLength(1);
      expect(first.items[0]).toMatchObject({
        productId: pollo.id,
        quantity: 2,
        lineTotalCents: 3700,
        issue: null,
        product: { nameEs: 'Pollo Guest', unitPriceCents: 1850, unitLabel: '1 lb' },
      });
      expect(first.items[0]?.product?.picture?.cardUrl).toMatch(/^https?:\/\/.+\/.+\.card\.webp$/);
      expect(first).toMatchObject({ itemCount: 2, subtotalCents: 3700, currency: 'USD', checkoutReady: true });

      const token = first.guestToken as string;
      const second = await cart.addItem(tenantA, { guestToken: token }, { productId: pollo.id, quantity: 1 });
      expect(second.guestToken).toBeUndefined();
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.quantity).toBe(3);

      expect(await count(adminSql`select count(*) as n from carts where guest_token = ${token}`)).toBe(1);
      expect(await count(adminSql`select count(*) as n from cart_items ci join carts c on c.id = ci.cart_id where c.guest_token = ${token}`)).toBe(1);
    });

    it('gives an unrecognised token a fresh cart and a fresh token', async () => {
      const arroz = await liveProduct(tenantA, 'Arroz Guest');
      const stale = 'b'.repeat(64);
      const view = await cart.addItem(tenantA, { guestToken: stale }, { productId: arroz.id, quantity: 1 });
      expect(view.guestToken).toBeDefined();
      expect(view.guestToken).not.toBe(stale);
    });

    it('keeps two guests separate', async () => {
      const cafe = await liveProduct(tenantA, 'Cafe Guest');
      const one = await cart.addItem(tenantA, {}, { productId: cafe.id, quantity: 1 });
      const two = await cart.addItem(tenantA, {}, { productId: cafe.id, quantity: 4 });
      expect(one.guestToken).not.toBe(two.guestToken);
      expect((await cart.getCart(tenantA, { guestToken: one.guestToken })).items[0]?.quantity).toBe(1);
    });
  });

  describe('what may be added', () => {
    it('refuses a draft, an unknown product, and an out-of-stock one', async () => {
      const draft = await catalog.createProduct(tenantA, { nameEs: 'Borrador Cart', priceCents: 100, unitLabel: 'u' });
      await expect(cart.addItem(tenantA, {}, { productId: draft.id, quantity: 1 })).rejects.toBeInstanceOf(NotFoundError);
      await expect(cart.addItem(tenantA, {}, { productId: crypto.randomUUID(), quantity: 1 })).rejects.toBeInstanceOf(
        NotFoundError,
      );

      const agotado = await liveProduct(tenantA, 'Agotado', { stockStatus: 'out' });
      await expect(cart.addItem(tenantA, {}, { productId: agotado.id, quantity: 1 })).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it("enforces the product's max per order, across repeated adds", async () => {
      const limited = await liveProduct(tenantA, 'Limitado', { maxPerOrder: 3 });
      const view = await cart.addItem(tenantA, {}, { productId: limited.id, quantity: 2 });
      const actor = { guestToken: view.guestToken };

      await expect(cart.addItem(tenantA, actor, { productId: limited.id, quantity: 2 })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect((await cart.addItem(tenantA, actor, { productId: limited.id, quantity: 1 })).items[0]?.quantity).toBe(3);
    });

    it('does not offer a product from another tenant', async () => {
      const inB = await liveProduct(tenantB, 'Solo En B');
      await expect(cart.addItem(tenantA, {}, { productId: inB.id, quantity: 1 })).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('as a signed-in buyer', () => {
    it('has exactly one cart however many times they add', async () => {
      const userId = crypto.randomUUID();
      const frijoles = await liveProduct(tenantA, 'Frijoles User');
      const azucar = await liveProduct(tenantA, 'Azucar User');

      await cart.addItem(tenantA, { userId }, { productId: frijoles.id, quantity: 1 });
      const view = await cart.addItem(tenantA, { userId }, { productId: azucar.id, quantity: 2 });

      expect(view.guestToken).toBeUndefined();
      expect(view.items.map((line) => line.productId)).toEqual([frijoles.id, azucar.id]);
      expect(await count(adminSql`select count(*) as n from carts where user_id = ${userId}`)).toBe(1);
    });

    it('sets a quantity, removes a line idempotently, and clears the cart', async () => {
      const userId = crypto.randomUUID();
      const harina = await liveProduct(tenantA, 'Harina User', { maxPerOrder: 5 });
      const sal = await liveProduct(tenantA, 'Sal User');
      await cart.addItem(tenantA, { userId }, { productId: harina.id, quantity: 1 });
      await cart.addItem(tenantA, { userId }, { productId: sal.id, quantity: 1 });

      expect((await cart.setQuantity(tenantA, { userId }, harina.id, 4)).items[0]?.quantity).toBe(4);
      await expect(cart.setQuantity(tenantA, { userId }, harina.id, 6)).rejects.toBeInstanceOf(ValidationError);
      await expect(cart.setQuantity(tenantA, { userId }, crypto.randomUUID(), 1)).rejects.toBeInstanceOf(NotFoundError);

      const removed = await cart.removeItem(tenantA, { userId }, harina.id);
      expect(removed.items.map((line) => line.productId)).toEqual([sal.id]);
      expect((await cart.removeItem(tenantA, { userId }, harina.id)).items).toHaveLength(1);

      expect((await cart.clearCart(tenantA, { userId })).items).toEqual([]);
      expect((await cart.clearCart(tenantA, {})).items).toEqual([]);
    });
  });

  describe('the server is authoritative about prices and availability', () => {
    it('flags lines whose product went out of stock, was hidden, or was deleted', async () => {
      const userId = crypto.randomUUID();
      const ok = await liveProduct(tenantA, 'Sigue Bien', { priceCents: 500 });
      const goesOut = await liveProduct(tenantA, 'Se Agota', { priceCents: 700 });
      const hidden = await liveProduct(tenantA, 'Se Oculta', { priceCents: 900 });
      const removed = await liveProduct(tenantA, 'Se Borra', { priceCents: 1100 });
      for (const p of [ok, goesOut, hidden, removed]) {
        await cart.addItem(tenantA, { userId }, { productId: p.id, quantity: 1 });
      }
      expect((await cart.getCart(tenantA, { userId })).checkoutReady).toBe(true);

      await catalog.updateProduct(tenantA, goesOut.id, { stockStatus: 'out' });
      await catalog.deactivateProduct(tenantA, hidden.id);
      await catalog.deleteProduct(tenantA, removed.id);

      const view = await cart.getCart(tenantA, { userId });
      const byId = new Map(view.items.map((line) => [line.productId, line]));
      expect(byId.get(ok.id)).toMatchObject({ issue: null, lineTotalCents: 500 });
      expect(byId.get(goesOut.id)).toMatchObject({ issue: 'OUT_OF_STOCK', lineTotalCents: 0 });
      expect(byId.get(hidden.id)).toMatchObject({ issue: 'UNAVAILABLE', lineTotalCents: 0 });
      expect(byId.get(removed.id)).toMatchObject({ issue: 'UNAVAILABLE', product: null, lineTotalCents: 0 });
      expect(view.subtotalCents).toBe(500);
      expect(view.checkoutReady).toBe(false);
    });

    it('reprices a line when the product price changes', async () => {
      const userId = crypto.randomUUID();
      const p = await liveProduct(tenantA, 'Cambia Precio', { priceCents: 1000 });
      await cart.addItem(tenantA, { userId }, { productId: p.id, quantity: 2 });
      await catalog.updateProduct(tenantA, p.id, { priceCents: 1300 });
      expect((await cart.getCart(tenantA, { userId })).subtotalCents).toBe(2600);
    });

    it('flags a line that exceeds a max_per_order lowered after it was added', async () => {
      const userId = crypto.randomUUID();
      const p = await liveProduct(tenantA, 'Baja Maximo', { maxPerOrder: 10 });
      await cart.addItem(tenantA, { userId }, { productId: p.id, quantity: 6 });
      await catalog.updateProduct(tenantA, p.id, { maxPerOrder: 4 });
      const view = await cart.getCart(tenantA, { userId });
      expect(view.items[0]?.issue).toBe('EXCEEDS_MAX_PER_ORDER');
      expect(view.checkoutReady).toBe(false);
    });
  });

  describe('merge', () => {
    it('takes the larger quantity per product, so repeating it changes nothing', async () => {
      const userId = crypto.randomUUID();
      const p = await liveProduct(tenantA, 'Merge Max');
      await cart.addItem(tenantA, { userId }, { productId: p.id, quantity: 2 });

      const smaller = await cart.mergeCart(tenantA, { userId }, { items: [{ productId: p.id, quantity: 1 }] });
      expect(smaller.items[0]?.quantity).toBe(2);

      const larger = { items: [{ productId: p.id, quantity: 5 }] };
      expect((await cart.mergeCart(tenantA, { userId }, larger)).items[0]?.quantity).toBe(5);
      expect((await cart.mergeCart(tenantA, { userId }, larger)).items[0]?.quantity).toBe(5);
    });

    it('adds products the server cart lacks, clamps to max_per_order, and skips unavailable ones', async () => {
      const userId = crypto.randomUUID();
      const fresh = await liveProduct(tenantA, 'Merge Nuevo');
      const capped = await liveProduct(tenantA, 'Merge Tope', { maxPerOrder: 3 });
      const out = await liveProduct(tenantA, 'Merge Agotado', { stockStatus: 'out' });
      const draft = await catalog.createProduct(tenantA, { nameEs: 'Merge Borrador', priceCents: 100, unitLabel: 'u' });

      const view = await cart.mergeCart(
        tenantA,
        { userId },
        {
          items: [
            { productId: fresh.id, quantity: 2 },
            { productId: capped.id, quantity: 10 },
            { productId: out.id, quantity: 1 },
            { productId: draft.id, quantity: 1 },
            { productId: crypto.randomUUID(), quantity: 1 },
          ],
        },
      );
      const quantities = Object.fromEntries(view.items.map((line) => [line.productId, line.quantity]));
      expect(quantities).toEqual({ [fresh.id]: 2, [capped.id]: 3 });
    });

    it('creates a guest cart and token when a guest with a local cart merges', async () => {
      const p = await liveProduct(tenantA, 'Merge Guest');
      const view = await cart.mergeCart(tenantA, {}, { items: [{ productId: p.id, quantity: 2 }] });
      expect(view.guestToken).toBeDefined();
      expect(view.items[0]?.quantity).toBe(2);
    });

    it("folds a buyer's guest cart into their own on login, then retires the guest cart", async () => {
      const userId = crypto.randomUUID();
      const inGuest = await liveProduct(tenantA, 'Solo Invitado');
      const inBoth = await liveProduct(tenantA, 'En Ambos');
      const inUser = await liveProduct(tenantA, 'Solo Usuario');

      const guest = await cart.addItem(tenantA, {}, { productId: inGuest.id, quantity: 1 });
      const guestToken = guest.guestToken as string;
      await cart.addItem(tenantA, { guestToken }, { productId: inBoth.id, quantity: 4 });
      await cart.addItem(tenantA, { userId }, { productId: inBoth.id, quantity: 2 });
      await cart.addItem(tenantA, { userId }, { productId: inUser.id, quantity: 1 });

      const merged = await cart.mergeCart(tenantA, { userId, guestToken }, { items: [] });
      const quantities = Object.fromEntries(merged.items.map((line) => [line.productId, line.quantity]));
      expect(quantities).toEqual({ [inGuest.id]: 1, [inBoth.id]: 4, [inUser.id]: 1 });

      expect(await count(adminSql`select count(*) as n from carts where guest_token = ${guestToken}`)).toBe(0);
      expect(await count(adminSql`select count(*) as n from cart_items where cart_id not in (select id from carts)`)).toBe(0);
      expect((await cart.getCart(tenantA, { guestToken })).items).toEqual([]);
    });
  });

  describe('cross-tenant isolation', () => {
    it("shows tenant B nothing of tenant A's carts, by user or by token", async () => {
      const userId = crypto.randomUUID();
      const p = await liveProduct(tenantA, 'Aislado');
      const viaUser = await cart.addItem(tenantA, { userId }, { productId: p.id, quantity: 1 });
      const viaGuest = await cart.addItem(tenantA, {}, { productId: p.id, quantity: 1 });
      expect(viaUser.items).toHaveLength(1);

      expect((await cart.getCart(tenantB, { userId })).items).toEqual([]);
      expect((await cart.getCart(tenantB, { guestToken: viaGuest.guestToken })).items).toEqual([]);
    });

    it("does not let tenant A's guest token open a cart in tenant B", async () => {
      const inA = await liveProduct(tenantA, 'Token A');
      const inB = await liveProduct(tenantB, 'Token B');
      const tokenFromA = (await cart.addItem(tenantA, {}, { productId: inA.id, quantity: 1 })).guestToken;

      const atB = await cart.addItem(tenantB, { guestToken: tokenFromA }, { productId: inB.id, quantity: 1 });
      expect(atB.guestToken).toBeDefined();
      expect(atB.guestToken).not.toBe(tokenFromA);
      expect((await cart.getCart(tenantA, { guestToken: tokenFromA })).items.map((l) => l.productId)).toEqual([inA.id]);
    });
  });

  describe('housekeeping', () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    it('discards guest carts abandoned for over a month, with their items, and nothing else', async () => {
      const p = await liveProduct(tenantA, 'Purga');
      const stale = await cart.addItem(tenantA, {}, { productId: p.id, quantity: 1 });
      const recent = await cart.addItem(tenantA, {}, { productId: p.id, quantity: 1 });
      const buyer = crypto.randomUUID();
      await cart.addItem(tenantA, { userId: buyer }, { productId: p.id, quantity: 1 });
      const otherStore = await liveProduct(tenantB, 'Purga B');
      const staleElsewhere = await cart.addItem(tenantB, {}, { productId: otherStore.id, quantity: 1 });

      await adminSql`update carts set updated_at = ${daysAgo(45)} where guest_token = ${stale.guestToken as string}`;
      await adminSql`update carts set updated_at = ${daysAgo(10)} where guest_token = ${recent.guestToken as string}`;
      // A signed-in buyer's cart is theirs however long it sits.
      await adminSql`update carts set updated_at = ${daysAgo(400)} where user_id = ${buyer}`;
      await adminSql`update carts set updated_at = ${daysAgo(45)} where guest_token = ${staleElsewhere.guestToken as string}`;

      expect(await cart.purgeStaleGuestCarts(tenantA)).toBe(1);

      expect((await cart.getCart(tenantA, { guestToken: stale.guestToken })).items).toEqual([]);
      expect((await cart.getCart(tenantA, { guestToken: recent.guestToken })).items).toHaveLength(1);
      expect((await cart.getCart(tenantA, { userId: buyer })).items).toHaveLength(1);
      // The pass for one store never reaches into another.
      expect((await cart.getCart(tenantB, { guestToken: staleElsewhere.guestToken })).items).toHaveLength(1);
      // No orphaned lines left behind.
      expect(await count(adminSql`select count(*) as n from cart_items where cart_id not in (select id from carts)`)).toBe(0);
    });

    it('is safe to run when there is nothing to do', async () => {
      expect(await cart.purgeStaleGuestCarts(crypto.randomUUID())).toBe(0);
    });
  });

  describe('database constraints', () => {
    it('refuses a cart with no owner, or with two', async () => {
      await expect(adminSql`insert into carts (tenant_id) values (${tenantA})`).rejects.toThrow();
      await expect(
        adminSql`insert into carts (tenant_id, user_id, guest_token) values (${tenantA}, ${crypto.randomUUID()}, 'x')`,
      ).rejects.toThrow();
    });

    it('refuses a second cart for the same buyer or the same token', async () => {
      const userId = crypto.randomUUID();
      await adminSql`insert into carts (tenant_id, user_id) values (${tenantA}, ${userId})`;
      await expect(adminSql`insert into carts (tenant_id, user_id) values (${tenantA}, ${userId})`).rejects.toThrow();

      await adminSql`insert into carts (tenant_id, guest_token) values (${tenantA}, 'dup-token')`;
      await expect(adminSql`insert into carts (tenant_id, guest_token) values (${tenantA}, 'dup-token')`).rejects.toThrow();
    });
  });
});
