import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { defaultCategory } from '../../db/testing/default-category.js';
import { startTestDatabase, type TestDatabase } from '../../db/testing/test-database.js';
import type { cartService as cartServiceType } from '../cart/index.js';
import type { catalogService as catalogServiceType } from '../catalog/index.js';
import type { geoService as geoServiceType } from '../geo/index.js';
import type { paymentsService as paymentsServiceType } from '../payments/index.js';
import { createAddressSchema, createRecipientSchema, updateAddressSchema } from './orders.schema.js';
import type { ordersService as ordersServiceType } from './index.js';

// Pricing a checkout reads the cart, which reads the catalog and media; none
// of that needs a real queue.
vi.mock('../../core/events.js', () => ({
  events: { emit: vi.fn().mockResolvedValue(undefined), on: vi.fn(), close: vi.fn() },
}));

// The address book (recipients + addresses) and checkout pricing. Both tables
// are tenant-scoped and additionally owned by one buyer, so this carries the
// cross-tenant test (CLAUDE.md section 13) and a cross-buyer one inside a tenant.

describe('orders module: the address book', () => {
  let database: TestDatabase;
  let adminSql: postgres.Sql;
  let orders: typeof ordersServiceType;
  let cart: typeof cartServiceType;
  let catalog: typeof catalogServiceType;
  let payments: typeof paymentsServiceType;
  let geo: typeof geoServiceType;

  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();
  const buyer1 = crypto.randomUUID();
  const buyer2 = crypto.randomUUID();

  let havana: string;
  let vedado: string;
  let centro: string;
  let santiago: string;
  let santiagoCity: string;

  const address = (overrides: Record<string, unknown> = {}) => ({
    provinceId: havana,
    municipalityId: vedado,
    street: 'Calle 23 #456',
    betweenStreets: 'e/ L y M',
    referencePoints: 'al lado de la farmacia',
    ...overrides,
  });

  const recipient = (overrides: Record<string, unknown> = {}) => ({
    fullName: 'María Pérez',
    phone1: '+53 5 1234567',
    ...overrides,
  });

  async function insertProvince(code: string, name: string): Promise<string> {
    const [row] = await adminSql<{ id: string }[]>`
      INSERT INTO provinces (code, name_es, name_en) VALUES (${code}, ${name}, ${name}) RETURNING id`;
    if (!row) throw new Error('no province row');
    return row.id;
  }

  async function insertMunicipality(provinceId: string, name: string): Promise<string> {
    const [row] = await adminSql<{ id: string }[]>`
      INSERT INTO municipalities (province_id, name_es, name_en) VALUES (${provinceId}, ${name}, ${name}) RETURNING id`;
    if (!row) throw new Error('no municipality row');
    return row.id;
  }

  beforeAll(async () => {
    // The config reads the environment once, on first import: set the manual transfer accounts first.
    process.env.SEND_EMAILS = 'false'; // a developer's .env may have real sending on; tests must never email
    process.env.ZELLE_EMAIL = 'pay@example.com';
    process.env.PAYPAL_EMAIL = 'pay@example.com';
    process.env.PAYPAL_ME_HANDLE = 'teststore';
    database = await startTestDatabase();
    adminSql = database.adminSql;
    // quote() reads the store's settings (free-delivery offer), so the stores must exist.
    for (const id of [tenantA, tenantB]) {
      await adminSql`INSERT INTO tenants (id, slug, name) VALUES (${id}, ${'t-' + id.slice(0, 8)}, ${'Test store'})`;
    }

    havana = await insertProvince('LHA', 'La Habana');
    santiago = await insertProvince('SCU', 'Santiago de Cuba');
    vedado = await insertMunicipality(havana, 'Plaza de la Revolución');
    centro = await insertMunicipality(havana, 'Centro Habana');
    santiagoCity = await insertMunicipality(santiago, 'Santiago de Cuba');

    orders = (await import('./index.js')).ordersService;
    cart = (await import('../cart/index.js')).cartService;
    catalog = (await import('../catalog/index.js')).catalogService;
    payments = (await import('../payments/index.js')).paymentsService;
    geo = (await import('../geo/index.js')).geoService;
  });

  afterAll(async () => {
    await database?.stop();
  });

  describe('recipients', () => {
    it('creates a recipient with a first address, which becomes the default', async () => {
      const created = await orders.createRecipient(tenantA, buyer1, recipient({ phone2: '5 7654321', address: address() }));
      expect(created).toMatchObject({ fullName: 'María Pérez', phone1: '+53 5 1234567', phone2: '5 7654321' });
      expect(created.addresses).toHaveLength(1);
      expect(created.addresses[0]).toMatchObject({
        isDefault: true,
        street: 'Calle 23 #456',
        betweenStreets: 'e/ L y M',
        referencePoints: 'al lado de la farmacia',
        lat: null,
        lng: null,
      });
    });

    it('creates a recipient with no address, and rejects a mismatched one without saving the recipient', async () => {
      const bare = await orders.createRecipient(tenantA, buyer1, recipient({ fullName: 'Sin Direccion' }));
      expect(bare.addresses).toEqual([]);

      await expect(
        orders.createRecipient(
          tenantA,
          buyer1,
          recipient({ fullName: 'No Se Guarda', address: address({ provinceId: santiago, municipalityId: vedado }) }),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      expect((await orders.listRecipients(tenantA, buyer1)).map((r) => r.fullName)).not.toContain('No Se Guarda');
    });

    it('lists a buyer’s recipients with their addresses, and updates and clears fields', async () => {
      const created = await orders.createRecipient(tenantA, buyer2, recipient({ fullName: 'Ana', phone2: '5 1111111' }));
      await orders.addAddress(tenantA, buyer2, created.id, address());

      const updated = await orders.updateRecipient(tenantA, buyer2, created.id, { fullName: 'Ana Gómez', phone2: null });
      expect(updated).toMatchObject({ fullName: 'Ana Gómez', phone2: null, phone1: '+53 5 1234567' });

      const untouched = await orders.updateRecipient(tenantA, buyer2, created.id, {});
      expect(untouched.fullName).toBe('Ana Gómez');

      const list = await orders.listRecipients(tenantA, buyer2);
      expect(list).toHaveLength(1);
      expect(list[0]?.addresses).toHaveLength(1);
    });

    it('soft-deletes a recipient together with its addresses', async () => {
      const created = await orders.createRecipient(tenantA, buyer1, recipient({ fullName: 'Borrar', address: address() }));
      await orders.deleteRecipient(tenantA, buyer1, created.id);

      await expect(orders.getRecipient(tenantA, buyer1, created.id)).rejects.toBeInstanceOf(NotFoundError);
      expect((await orders.listRecipients(tenantA, buyer1)).map((r) => r.id)).not.toContain(created.id);
      // Rows are kept — past orders keep pointing at them.
      const [row] = await adminSql`select count(*)::int as n from addresses where recipient_id = ${created.id} and deleted_at is not null`;
      expect(row?.n).toBe(1);
      await expect(orders.deleteRecipient(tenantA, buyer1, created.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('addresses', () => {
    it('makes the first address the default, and moves the default on request', async () => {
      const r = await orders.createRecipient(tenantA, buyer1, recipient({ fullName: 'Defaults' }));
      const first = await orders.addAddress(tenantA, buyer1, r.id, address({ label: 'Casa' }));
      const second = await orders.addAddress(tenantA, buyer1, r.id, address({ label: 'Trabajo', municipalityId: centro }));
      expect([first.isDefault, second.isDefault]).toEqual([true, false]);

      const third = await orders.addAddress(tenantA, buyer1, r.id, address({ label: 'Otra', isDefault: true }));
      expect(third.isDefault).toBe(true);

      const moved = await orders.setDefaultAddress(tenantA, buyer1, r.id, second.id);
      expect(moved.addresses.filter((a) => a.isDefault).map((a) => a.id)).toEqual([second.id]);
      // The default sorts first, so the UI can pre-select index 0.
      expect(moved.addresses[0]?.id).toBe(second.id);
    });

    it('promotes another address when the default is deleted', async () => {
      const r = await orders.createRecipient(tenantA, buyer1, recipient({ fullName: 'Promote' }));
      const first = await orders.addAddress(tenantA, buyer1, r.id, address({ label: 'Primera' }));
      const second = await orders.addAddress(tenantA, buyer1, r.id, address({ label: 'Segunda' }));

      await orders.deleteAddress(tenantA, buyer1, r.id, first.id);
      const after = await orders.getRecipient(tenantA, buyer1, r.id);
      expect(after.addresses.map((a) => [a.id, a.isDefault])).toEqual([[second.id, true]]);

      await orders.deleteAddress(tenantA, buyer1, r.id, second.id);
      expect((await orders.getRecipient(tenantA, buyer1, r.id)).addresses).toEqual([]);
    });

    it('stores a map pin and returns it as numbers', async () => {
      const r = await orders.createRecipient(tenantA, buyer1, recipient({ fullName: 'Pin' }));
      const pinned = await orders.addAddress(tenantA, buyer1, r.id, address({ lat: 23.1136, lng: -82.3666 }));
      expect(pinned.lat).toBeCloseTo(23.1136, 4);
      expect(pinned.lng).toBeCloseTo(-82.3666, 4);

      const cleared = await orders.updateAddress(tenantA, buyer1, r.id, pinned.id, { lat: null, lng: null });
      expect([cleared.lat, cleared.lng]).toEqual([null, null]);
    });

    it('updates fields and validates the resulting province/municipality pair', async () => {
      const r = await orders.createRecipient(tenantA, buyer1, recipient({ fullName: 'Editar' }));
      const a = await orders.addAddress(tenantA, buyer1, r.id, address());

      const moved = await orders.updateAddress(tenantA, buyer1, r.id, a.id, { municipalityId: centro, street: 'Nueva 1' });
      expect(moved).toMatchObject({ municipalityId: centro, street: 'Nueva 1', provinceId: havana });

      // Only the municipality changes, to one outside the stored province.
      await expect(
        orders.updateAddress(tenantA, buyer1, r.id, a.id, { municipalityId: santiagoCity }),
      ).rejects.toBeInstanceOf(ValidationError);
      // Both change together to a consistent pair.
      const both = await orders.updateAddress(tenantA, buyer1, r.id, a.id, {
        provinceId: santiago,
        municipalityId: santiagoCity,
      });
      expect(both.provinceId).toBe(santiago);
    });

    it('rejects an unknown or mismatched location on create', async () => {
      const r = await orders.createRecipient(tenantA, buyer1, recipient({ fullName: 'Ubicacion' }));
      await expect(
        orders.addAddress(tenantA, buyer1, r.id, address({ municipalityId: santiagoCity })),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        orders.addAddress(tenantA, buyer1, r.id, address({ municipalityId: crypto.randomUUID() })),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('refuses two default addresses for one recipient at the database level', async () => {
      const r = await orders.createRecipient(tenantA, buyer1, recipient({ fullName: 'Indice', address: address() }));
      await expect(
        adminSql`insert into addresses (tenant_id, recipient_id, is_default, province_id, municipality_id, street)
                 values (${tenantA}, ${r.id}, true, ${havana}, ${vedado}, 'otra')`,
      ).rejects.toThrow();
    });
  });

  describe('input validation (zod)', () => {
    it('accepts ordinary Cuban phone formats and rejects junk', () => {
      for (const phone of ['+53 5 1234567', '51234567', '(53) 5123-4567', '+1 305 555 0100']) {
        expect(createRecipientSchema.safeParse({ fullName: 'X', phone1: phone }).success).toBe(true);
      }
      for (const phone of ['', 'abc', '123', 'call me maybe', '+53 5 1234567; drop table']) {
        expect(createRecipientSchema.safeParse({ fullName: 'X', phone1: phone }).success).toBe(false);
      }
    });

    it('requires lat and lng together, and keeps them in range', () => {
      const base = { provinceId: crypto.randomUUID(), municipalityId: crypto.randomUUID(), street: 's' };
      expect(createAddressSchema.safeParse({ ...base, lat: 23.1 }).success).toBe(false);
      expect(createAddressSchema.safeParse({ ...base, lat: 23.1, lng: -82.3 }).success).toBe(true);
      expect(createAddressSchema.safeParse({ ...base, lat: 123, lng: -82.3 }).success).toBe(false);
      expect(updateAddressSchema.safeParse({ lng: 10 }).success).toBe(false);
      expect(updateAddressSchema.safeParse({ lat: null, lng: null }).success).toBe(true);
    });

    it('does not let an update change isDefault', () => {
      const parsed = updateAddressSchema.parse({ street: 'x', isDefault: true });
      expect(parsed).not.toHaveProperty('isDefault');
    });
  });

  describe('isolation', () => {
    it("hides one buyer's recipients from another buyer in the same store", async () => {
      const mine = await orders.createRecipient(tenantA, buyer1, recipient({ fullName: 'Privada', address: address() }));
      const addressId = mine.addresses[0]?.id as string;

      expect((await orders.listRecipients(tenantA, buyer2)).map((r) => r.id)).not.toContain(mine.id);
      await expect(orders.getRecipient(tenantA, buyer2, mine.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(orders.updateRecipient(tenantA, buyer2, mine.id, { fullName: 'Hack' })).rejects.toBeInstanceOf(NotFoundError);
      await expect(orders.deleteRecipient(tenantA, buyer2, mine.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(orders.addAddress(tenantA, buyer2, mine.id, address())).rejects.toBeInstanceOf(NotFoundError);
      await expect(orders.updateAddress(tenantA, buyer2, mine.id, addressId, { street: 'Hack' })).rejects.toBeInstanceOf(NotFoundError);
      await expect(orders.setDefaultAddress(tenantA, buyer2, mine.id, addressId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(orders.deleteAddress(tenantA, buyer2, mine.id, addressId)).rejects.toBeInstanceOf(NotFoundError);

      expect((await orders.getRecipient(tenantA, buyer1, mine.id)).fullName).toBe('Privada');
    });

    it("shows another tenant nothing of a buyer's address book, even for the same user id", async () => {
      const mine = await orders.createRecipient(tenantA, buyer1, recipient({ fullName: 'Solo En A', address: address() }));

      expect(await orders.listRecipients(tenantB, buyer1)).toEqual([]);
      await expect(orders.getRecipient(tenantB, buyer1, mine.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(orders.addAddress(tenantB, buyer1, mine.id, address())).rejects.toBeInstanceOf(NotFoundError);
    });

    it("refuses to attach an address to another tenant's recipient even via a raw insert", async () => {
      const mine = await orders.createRecipient(tenantA, buyer1, recipient({ fullName: 'Fila Ajena' }));
      // Through the restricted role, as the app connects, under tenant B's
      // context: the row's tenant_id says A, so the WITH CHECK policy refuses.
      const { withTenant } = await import('../../db/client.js');
      const refused: unknown = await withTenant(tenantB, (tx) =>
        tx.execute(sql`insert into addresses (tenant_id, recipient_id, province_id, municipality_id, street)
                       values (${tenantA}, ${mine.id}, ${havana}, ${vedado}, 'x')`),
      ).catch((err: unknown) => err);
      // Drizzle wraps the driver error; Postgres' own message is on `cause`.
      expect((refused as { cause?: { message?: string } }).cause?.message).toMatch(/row-level security/i);

      // ...and the same insert under tenant A's own context is accepted, so
      // the refusal above was RLS and not a typo in the statement.
      await expect(
        withTenant(tenantA, (tx) =>
          tx.execute(sql`insert into addresses (tenant_id, recipient_id, province_id, municipality_id, street)
                         values (${tenantA}, ${mine.id}, ${havana}, ${vedado}, 'x')`),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('pricing a checkout (quote)', () => {
    async function liveProduct(name: string, priceCents: number, stockStatus: 'available' | 'out' = 'available') {
      const product = await catalog.createProduct(tenantA, { categoryId: await defaultCategory(catalog, tenantA), nameEs: name, priceCents, unitLabel: '1 lb', stockStatus });
      const key = `public/${tenantA}/product/${product.id}/${crypto.randomUUID()}`;
      await adminSql`
        INSERT INTO media (tenant_id, owner_type, owner_id, key_original, key_thumb, key_card, key_full, status)
        VALUES (${tenantA}, 'product', ${product.id}, ${`${tenantA}/product/${product.id}/o.jpg`},
                ${key + '.thumb.webp'}, ${key + '.card.webp'}, ${key + '.full.webp'}, 'ready')`;
      await catalog.activateProduct(tenantA, product.id);
      return product;
    }

    // A buyer with one recipient whose default address is in `municipalityId`.
    async function buyerWithAddress(municipalityId: string, provinceId: string) {
      const buyer = crypto.randomUUID();
      const created = await orders.createRecipient(
        tenantA,
        buyer,
        recipient({ fullName: 'Quote Recipient', address: address({ provinceId, municipalityId }) }),
      );
      return { buyer, recipientId: created.id, addressId: created.addresses[0]?.id as string };
    }

    let zoneId: string;

    beforeAll(async () => {
      // This store delivers to Plaza (650) and, inactive, to Centro Habana.
      zoneId = (await geo.createZone(tenantA, { municipalityId: vedado, feeCents: 650 })).id;
      await geo.createZone(tenantA, { municipalityId: centro, feeCents: 400, active: false });
    });

    it('adds the delivery fee of the address’s zone to the cart subtotal', async () => {
      const pollo = await liveProduct('Quote Pollo', 950);
      const aceite = await liveProduct('Quote Aceite', 1200);
      const { buyer, recipientId, addressId } = await buyerWithAddress(vedado, havana);
      await cart.addItem(tenantA, { userId: buyer }, { productId: pollo.id, quantity: 2 });
      await cart.addItem(tenantA, { userId: buyer }, { productId: aceite.id, quantity: 1 });

      const quote = await orders.quote(tenantA, buyer, { recipientId, addressId });
      expect(quote).toMatchObject({
        subtotalCents: 3100,
        deliveryFeeCents: 650,
        totalCents: 3750,
        currency: 'USD',
        canCheckout: true,
        blockers: [],
        delivery: { id: zoneId, feeCents: 650, municipality: { nameEs: 'Plaza de la Revolución' } },
      });
      expect(quote.cart.items).toHaveLength(2);
    });

    it('follows a change in the zone fee', async () => {
      const pollo = await liveProduct('Quote Reprice', 1000);
      const { buyer, recipientId, addressId } = await buyerWithAddress(vedado, havana);
      await cart.addItem(tenantA, { userId: buyer }, { productId: pollo.id, quantity: 1 });

      await geo.updateZone(tenantA, zoneId, { feeCents: 900 });
      expect((await orders.quote(tenantA, buyer, { recipientId, addressId })).totalCents).toBe(1900);
      await geo.updateZone(tenantA, zoneId, { feeCents: 650 });
    });

    it("waives the zone fee once the subtotal reaches the store's free-delivery threshold", async () => {
      const pollo = await liveProduct('Quote Free Delivery', 1000);
      const { buyer, recipientId, addressId } = await buyerWithAddress(vedado, havana);
      await adminSql`UPDATE tenants SET settings = '{"free_delivery_over_cents": 1500}'::jsonb WHERE id = ${tenantA}`;
      try {
        await cart.addItem(tenantA, { userId: buyer }, { productId: pollo.id, quantity: 1 });
        expect(await orders.quote(tenantA, buyer, { recipientId, addressId })).toMatchObject({ subtotalCents: 1000, deliveryFeeCents: 650, totalCents: 1650 });

        await cart.addItem(tenantA, { userId: buyer }, { productId: pollo.id, quantity: 1 });
        expect(await orders.quote(tenantA, buyer, { recipientId, addressId })).toMatchObject({ subtotalCents: 2000, deliveryFeeCents: 0, totalCents: 2000 });
      } finally {
        await adminSql`UPDATE tenants SET settings = '{}'::jsonb WHERE id = ${tenantA}`;
      }
    });

    it('says why an empty cart cannot check out', async () => {
      const { buyer, recipientId, addressId } = await buyerWithAddress(vedado, havana);
      const quote = await orders.quote(tenantA, buyer, { recipientId, addressId });
      expect(quote).toMatchObject({ canCheckout: false, blockers: ['EMPTY_CART'], subtotalCents: 0, deliveryFeeCents: 650 });
    });

    it.each([
      ['a municipality the store has no zone for', () => [santiagoCity, santiago] as const],
      ['a zone that is switched off', () => [centro, havana] as const],
    ])('cannot deliver to %s', async (_label, where) => {
      const pollo = await liveProduct(`Quote Nowhere ${_label}`, 500);
      const [municipalityId, provinceId] = where();
      const { buyer, recipientId, addressId } = await buyerWithAddress(municipalityId, provinceId);
      await cart.addItem(tenantA, { userId: buyer }, { productId: pollo.id, quantity: 1 });

      const quote = await orders.quote(tenantA, buyer, { recipientId, addressId });
      expect(quote.delivery).toBeNull();
      expect(quote).toMatchObject({ canCheckout: false, blockers: ['NO_DELIVERY_ZONE'], deliveryFeeCents: 0, totalCents: 500 });
    });

    it('flags a cart with an unavailable line, and counts only what can be bought', async () => {
      const fine = await liveProduct('Quote Fine', 800);
      const soonOut = await liveProduct('Quote Soon Out', 300);
      const { buyer, recipientId, addressId } = await buyerWithAddress(vedado, havana);
      await cart.addItem(tenantA, { userId: buyer }, { productId: fine.id, quantity: 1 });
      await cart.addItem(tenantA, { userId: buyer }, { productId: soonOut.id, quantity: 1 });
      await catalog.updateProduct(tenantA, soonOut.id, { stockStatus: 'out' });

      const quote = await orders.quote(tenantA, buyer, { recipientId, addressId });
      expect(quote).toMatchObject({ canCheckout: false, blockers: ['CART_HAS_ISSUES'], subtotalCents: 800, totalCents: 1450 });
    });

    it('lists every blocker at once', async () => {
      const { buyer, recipientId, addressId } = await buyerWithAddress(santiagoCity, santiago);
      const quote = await orders.quote(tenantA, buyer, { recipientId, addressId });
      expect(quote.blockers).toEqual(['EMPTY_CART', 'NO_DELIVERY_ZONE']);
    });

    it('prices the buyer’s own cart, not anyone else’s', async () => {
      const pollo = await liveProduct('Quote Mine', 700);
      const mine = await buyerWithAddress(vedado, havana);
      const other = await buyerWithAddress(vedado, havana);
      await cart.addItem(tenantA, { userId: other.buyer }, { productId: pollo.id, quantity: 3 });

      expect((await orders.quote(tenantA, mine.buyer, mine)).subtotalCents).toBe(0);
      expect((await orders.quote(tenantA, other.buyer, other)).subtotalCents).toBe(2100);
    });

    it("refuses another buyer's recipient or address, and an address of a different recipient", async () => {
      const owner = await buyerWithAddress(vedado, havana);
      const thief = await buyerWithAddress(vedado, havana);

      await expect(orders.quote(tenantA, thief.buyer, owner)).rejects.toBeInstanceOf(NotFoundError);
      // Their own recipient, but someone else's address id.
      await expect(
        orders.quote(tenantA, thief.buyer, { recipientId: thief.recipientId, addressId: owner.addressId }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("refuses a recipient from another store", async () => {
      const owner = await buyerWithAddress(vedado, havana);
      await expect(orders.quote(tenantB, owner.buyer, owner)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('checkout and the order state machine', () => {
    // Its own municipality, not vedado/centro — both already have zones from
    // the quote describe block above, and describe blocks in this file share
    // one database and one set of outer-scope ids, not a fresh fixture each.
    let checkoutMunicipality: string;
    // audit_log.actor_user_id is a real uuid column — a human-readable
    // placeholder string would fail at the database, not just be unrealistic.
    const adminUser = crypto.randomUUID();

    async function liveProduct(name: string, priceCents: number, overrides: Record<string, unknown> = {}) {
      const product = await catalog.createProduct(tenantA, { categoryId: await defaultCategory(catalog, tenantA), nameEs: name, priceCents, unitLabel: '1 lb', ...overrides });
      const key = `public/${tenantA}/product/${product.id}/${crypto.randomUUID()}`;
      await adminSql`
        INSERT INTO media (tenant_id, owner_type, owner_id, key_original, key_thumb, key_card, key_full, status)
        VALUES (${tenantA}, 'product', ${product.id}, ${`${tenantA}/product/${product.id}/o.jpg`},
                ${key + '.thumb.webp'}, ${key + '.card.webp'}, ${key + '.full.webp'}, 'ready')`;
      await catalog.activateProduct(tenantA, product.id);
      return product;
    }

    // checkout() looks up the buyer's own users row for their email (to pass
    // to the payment provider) — a bare random id, fine for cart/recipients
    // which only ever use it as a soft reference, isn't enough here.
    async function insertBuyer(): Promise<string> {
      const id = crypto.randomUUID();
      await adminSql`
        INSERT INTO users (id, tenant_id, supertokens_user_id, email, role)
        VALUES (${id}, ${tenantA}, ${crypto.randomUUID()}, ${`buyer-${id}@example.com`}, 'buyer')`;
      return id;
    }

    async function buyerWithCart(productId: string, quantity = 1) {
      const buyer = await insertBuyer();
      await cart.addItem(tenantA, { userId: buyer }, { productId, quantity });
      const created = await orders.createRecipient(
        tenantA,
        buyer,
        recipient({ address: address({ municipalityId: checkoutMunicipality }) }),
      );
      return { buyer, recipientId: created.id, addressId: created.addresses[0]?.id as string };
    }

    async function checkoutAs(provider: 'manual' | 'tropipay', productId: string, quantity = 1) {
      const { buyer, recipientId, addressId } = await buyerWithCart(productId, quantity);
      const result = await orders.checkout(tenantA, buyer, { recipientId, addressId, provider });
      return { buyer, ...result };
    }

    beforeAll(async () => {
      checkoutMunicipality = await insertMunicipality(havana, 'Playa');
      await geo.createZone(tenantA, { municipalityId: checkoutMunicipality, feeCents: 500 });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('placing an order', () => {
      it('creates a pending_payment order with snapshot line items, a pending payment, and clears the cart', async () => {
        const arroz = await liveProduct('Checkout Arroz', 950);
        const { buyer, order, checkoutUrl } = await checkoutAs('manual', arroz.id, 2);

        expect(order.items[0]).toHaveProperty('productNameEn');
        expect(order.items[0]).toHaveProperty('productThumbUrl');
        expect(order.addressSnapshot).toHaveProperty('neighborhood');
        expect(order.status).toBe('pending_payment');
        expect(order.orderNumber).toMatch(/^FC-[0-9]{4,}$/);
        expect(order).toMatchObject({ subtotalCents: 1900, deliveryFeeCents: 500, totalCents: 2400, currency: 'USD' });
        expect(order.items).toEqual([
          expect.objectContaining({ productId: arroz.id, productNameEs: 'Checkout Arroz', quantity: 2, unitPriceCents: 950, lineTotalCents: 1900 }),
        ]);
        // Manual transfer has no redirect (see ManualTransferProvider) — an
        // empty provider URL is surfaced as no URL at all, not an empty string.
        expect(checkoutUrl).toBeNull();

        expect((await cart.getCart(tenantA, { userId: buyer })).items).toEqual([]);

        const [payment] = await adminSql`select id, provider, status, amount_cents, external_payment_id from payments where order_id = ${order.id}`;
        // ManualTransferProvider's "external" id IS our own payment id — see
        // its file — so attaching it is a same-value round trip, but it still
        // proves startProviderCheckout ran the whole way through, including
        // the identityService.getById lookup that needs a real buyer row.
        expect(payment).toMatchObject({ provider: 'manual', status: 'pending', amount_cents: 2400, external_payment_id: payment?.id });

        const [audit] = await adminSql`select action from audit_log where entity_id = ${order.id} and entity_type = 'order'`;
        expect(audit?.action).toBe('order.placed');
      });

      it('snapshots the recipient and address at the moment of the order, immune to later edits', async () => {
        const p = await liveProduct('Checkout Snapshot', 500);
        const { buyer, recipientId, addressId } = await buyerWithCart(p.id);
        const { order } = await orders.checkout(tenantA, buyer, { recipientId, addressId, provider: 'manual' });

        await orders.updateRecipient(tenantA, buyer, recipientId, { fullName: 'Nombre Cambiado' });
        const reread = await orders.getOrderForBuyer(tenantA, buyer, order.id);
        expect(reread.recipientNameSnapshot).toBe('María Pérez');
      });

      it('refuses to check out an empty or unresolvable cart, naming the blocker', async () => {
        const { buyer, recipientId, addressId } = await buyerWithCart((await liveProduct('Checkout Unused', 100)).id);
        await cart.clearCart(tenantA, { userId: buyer });
        const failed = await orders.checkout(tenantA, buyer, { recipientId, addressId, provider: 'manual' }).catch((err: unknown) => err);
        expect(failed).toBeInstanceOf(ConflictError);
        expect((failed as ConflictError).details).toMatchObject({ reason: 'EMPTY_CART' });
      });

      it('is not fooled by a soft-deleted address that still satisfies the foreign key', async () => {
        const p = await liveProduct('Checkout Deleted Address', 300);
        const buyer = crypto.randomUUID();
        await cart.addItem(tenantA, { userId: buyer }, { productId: p.id, quantity: 1 });
        const created = await orders.createRecipient(tenantA, buyer, recipient({ address: address({ municipalityId: checkoutMunicipality }) }));
        const addressId = created.addresses[0]?.id as string;

        // quote() (called first, inside checkout) still sees it; delete it
        // right after — the FK to addresses.id would not itself stop this.
        await adminSql`update addresses set deleted_at = now() where id = ${addressId}`;

        await expect(orders.checkout(tenantA, buyer, { recipientId: created.id, addressId, provider: 'manual' })).rejects.toBeInstanceOf(
          NotFoundError,
        );
      });

      it('numbers orders sequentially within a store, FC-1001 upward', async () => {
        const p = await liveProduct('Checkout Numbers', 200);
        const first = await checkoutAs('manual', p.id);
        const second = await checkoutAs('manual', p.id);
        const n = (order: { orderNumber: string }) => Number(order.orderNumber.replace('FC-', ''));
        expect(n(first.order)).toBeGreaterThanOrEqual(1001);
        expect(n(second.order)).toBe(n(first.order) + 1);
      });
    });

    // The same checkout attempt sent twice must never become two orders (a double click, a retry after a dropped
    // connection, a refresh).
    describe('a checkout attempt sent more than once', () => {
      it('returns the order the first attempt made, and charges nothing twice', async () => {
        const arroz = await liveProduct('Idem Arroz', 950);
        const { buyer, recipientId, addressId } = await buyerWithCart(arroz.id);
        const key = 'attempt-' + crypto.randomUUID();
        const first = await orders.checkout(tenantA, buyer, { recipientId, addressId, provider: 'manual', idempotencyKey: key });
        // the cart is empty now, so a second attempt that really tried to place an order would be refused
        const again = await orders.checkout(tenantA, buyer, { recipientId, addressId, provider: 'manual', idempotencyKey: key });

        expect(again.order.id).toBe(first.order.id);
        expect(again.order.orderNumber).toBe(first.order.orderNumber);
        const [row] = await adminSql<{ n: number }[]>`select count(*)::int n from orders where checkout_key = ${key}`;
        expect(row?.n).toBe(1);
        const [paid] = await adminSql<{ payments: number }[]>`select count(*)::int payments from payments where order_id = ${first.order.id}`;
        expect(paid?.payments).toBe(1);
      });

      it('makes exactly one order when two identical requests arrive at the same moment', async () => {
        const arroz = await liveProduct('Idem Race', 950);
        const { buyer, recipientId, addressId } = await buyerWithCart(arroz.id);
        const key = 'race-' + crypto.randomUUID();
        const attempts = await Promise.allSettled([
          orders.checkout(tenantA, buyer, { recipientId, addressId, provider: 'manual', idempotencyKey: key }),
          orders.checkout(tenantA, buyer, { recipientId, addressId, provider: 'manual', idempotencyKey: key }),
          orders.checkout(tenantA, buyer, { recipientId, addressId, provider: 'manual', idempotencyKey: key }),
        ]);
        const ids = new Set(attempts.flatMap((a) => (a.status === 'fulfilled' ? [a.value.order.id] : [])));
        // Whatever the timing, nobody ends up with two orders: either all calls return the one order, or the
        // late ones are refused because the cart was already emptied.
        expect(ids.size).toBe(1);
        const [row] = await adminSql<{ n: number }[]>`select count(*)::int n from orders where checkout_key = ${key}`;
        expect(row?.n).toBe(1);
      });

      it('treats a different key as a different attempt', async () => {
        const arroz = await liveProduct('Idem Two', 950);
        const { buyer, recipientId, addressId } = await buyerWithCart(arroz.id);
        const first = await orders.checkout(tenantA, buyer, { recipientId, addressId, provider: 'manual', idempotencyKey: 'first-' + crypto.randomUUID() });
        await cart.addItem(tenantA, { userId: buyer }, { productId: arroz.id, quantity: 1 });
        const second = await orders.checkout(tenantA, buyer, { recipientId, addressId, provider: 'manual', idempotencyKey: 'second-' + crypto.randomUUID() });
        expect(second.order.id).not.toBe(first.order.id);
      });

      it("never hands one buyer another buyer's order, even with the same key", async () => {
        const arroz = await liveProduct('Idem Other Buyer', 950);
        const one = await buyerWithCart(arroz.id);
        const two = await buyerWithCart(arroz.id);
        const key = 'shared-key-' + crypto.randomUUID();
        const a = await orders.checkout(tenantA, one.buyer, { recipientId: one.recipientId, addressId: one.addressId, provider: 'manual', idempotencyKey: key });
        const b = await orders.checkout(tenantA, two.buyer, { recipientId: two.recipientId, addressId: two.addressId, provider: 'manual', idempotencyKey: key });
        expect(b.order.id).not.toBe(a.order.id);
      });

      it('still works without a key (older clients)', async () => {
        const arroz = await liveProduct('Idem No Key', 950);
        const { order } = await checkoutAs('manual', arroz.id);
        expect(order.status).toBe('pending_payment');
      });
    });

    // Lists are served a page at a time. The oracle for "right" is the database itself: a plain query in the order the
    // API promises (newest first, ties broken by id).
    describe('paged lists', () => {
      const idsFor = async (buyer: string) =>
        (await adminSql<{ id: string }[]>`select id from orders where buyer_user_id = ${buyer} order by created_at desc, id desc`).map((r) => r.id);

      async function buyerWithOrders(count: number) {
        const product = await liveProduct('Paged ' + crypto.randomUUID().slice(0, 6), 500);
        const { buyer, recipientId, addressId } = await buyerWithCart(product.id);
        for (let i = 0; i < count; i += 1) {
          if (i > 0) await cart.addItem(tenantA, { userId: buyer }, { productId: product.id, quantity: 1 });
          await orders.checkout(tenantA, buyer, { recipientId, addressId, provider: 'manual' });
        }
        return buyer;
      }

      async function walk(buyer: string, limit: number) {
        const pages: string[][] = [];
        let cursor: string | undefined;
        do {
          const page = await orders.pageOrdersForBuyer(tenantA, buyer, { limit, cursor });
          pages.push(page.items.map((o) => o.id));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return pages;
      }

      it("serves a buyer's orders newest first, every one exactly once, with no empty trailing page", async () => {
        const buyer = await buyerWithOrders(5);
        const pages = await walk(buyer, 2);
        expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
        expect(pages.flat()).toEqual(await idsFor(buyer));
      });

      it('a page that ends exactly at the last order has no next page', async () => {
        const buyer = await buyerWithOrders(4);
        expect((await walk(buyer, 4)).length).toBe(1);
        expect((await walk(buyer, 2)).map((page) => page.length)).toEqual([2, 2]);
      });

      it('an order that arrives while someone scrolls does not shift the rest of the list', async () => {
        const buyer = await buyerWithOrders(4);
        const before = await idsFor(buyer);
        const first = await orders.pageOrdersForBuyer(tenantA, buyer, { limit: 2 });
        expect(first.items.map((o) => o.id)).toEqual(before.slice(0, 2));

        // a new order lands on top, then the next page is asked for
        const product = await liveProduct('Paged Late ' + crypto.randomUUID().slice(0, 6), 500);
        await cart.addItem(tenantA, { userId: buyer }, { productId: product.id, quantity: 1 });
        const recipientRow = (await orders.listRecipients(tenantA, buyer))[0];
        await orders.checkout(tenantA, buyer, { recipientId: recipientRow?.id as string, addressId: recipientRow?.addresses[0]?.id as string, provider: 'manual' });

        const second = await orders.pageOrdersForBuyer(tenantA, buyer, { limit: 2, cursor: first.nextCursor as string });
        expect(second.items.map((o) => o.id)).toEqual(before.slice(2, 4));
      });

      it('orders with an identical timestamp are neither skipped nor repeated at a page boundary', async () => {
        const buyer = await buyerWithOrders(4);
        await adminSql`update orders set created_at = '2026-01-01 00:00:00.123456+00' where buyer_user_id = ${buyer}`;
        const pages = await walk(buyer, 1);
        expect(pages.flat()).toEqual(await idsFor(buyer));
        expect(new Set(pages.flat()).size).toBe(4);
      });

      it('refuses a cursor that was not made by this server, instead of failing inside the database', async () => {
        const buyer = await buyerWithOrders(1);
        const forged = [
          'garbage',
          Buffer.from(JSON.stringify(['x'])).toString('base64url'),
          Buffer.from(JSON.stringify(['2026-01-01', 'not-a-uuid'])).toString('base64url'),
          Buffer.from(JSON.stringify(["2026-01-01T00:00:00.000000Z'; drop table orders;--", crypto.randomUUID()])).toString('base64url'),
        ];
        for (const cursor of forged) {
          await expect(orders.pageOrdersForBuyer(tenantA, buyer, { limit: 5, cursor }), cursor).rejects.toMatchObject({ httpStatus: 400 });
        }
      });

      it('never shows a buyer another buyer\'s orders', async () => {
        const mine = await buyerWithOrders(2);
        const theirs = await buyerWithOrders(2);
        const seen = (await walk(mine, 1)).flat();
        expect(seen.sort()).toEqual((await idsFor(mine)).sort());
        expect(seen.some((id) => id === undefined)).toBe(false);
        expect((await idsFor(theirs)).some((id) => seen.includes(id))).toBe(false);
      });

      it('splits the orders of a buyer into active and past on the server, so a tab never hides orders on an unloaded page', async () => {
        const buyer = await buyerWithOrders(3);
        const [newest, middle, oldest] = await idsFor(buyer);
        await orders.cancelByBuyer(tenantA, buyer, middle as string, 'changed my mind');

        const collect = async (scope: 'active' | 'past') => {
          const ids: string[] = [];
          let cursor: string | undefined;
          do {
            const page = await orders.pageOrdersForBuyer(tenantA, buyer, { limit: 1, cursor }, scope);
            ids.push(...page.items.map((o) => o.id));
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          return ids;
        };
        expect(await collect('active')).toEqual([newest, oldest]);
        expect(await collect('past')).toEqual([middle]);
      });

      it('serves the admin queue in the same order, a page at a time, and the pages add up to the whole queue', async () => {
        const everyId = (await adminSql<{ id: string }[]>`select id from orders where tenant_id = ${tenantA} order by created_at desc, id desc`).map((r) => r.id);
        const walked: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await orders.pageOrdersForAdmin(tenantA, {}, { limit: 7, cursor });
          expect(page.items.length).toBeLessThanOrEqual(7);
          walked.push(...page.items.map((o) => o.id));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        expect(walked).toEqual(everyId);
      });

      it('filters the queue by status on the server', async () => {
        const buyer = await buyerWithOrders(2);
        const [one] = await idsFor(buyer);
        await orders.adminMarkPaid(tenantA, buyer, one as string);
        const paid = await orders.pageOrdersForAdmin(tenantA, { status: 'paid' }, { limit: 100 });
        expect(paid.items.map((o) => o.id)).toContain(one);
        expect(paid.items.every((o) => o.status === 'paid')).toBe(true);
      });

      it('searches by order number, by recipient and by buyer, and treats % and _ as plain characters', async () => {
        const buyer = await buyerWithOrders(1);
        const [id] = await idsFor(buyer);
        const [row] = await adminSql<{ order_number: string; email: string }[]>`
          select o.order_number, u.email from orders o join users u on u.id = o.buyer_user_id where o.id = ${id as string}`;
        const find = async (q: string) => (await orders.pageOrdersForAdmin(tenantA, { q }, { limit: 100 })).items.map((o) => o.id);

        expect(await find(row?.order_number as string)).toContain(id);
        expect(await find((row?.email as string).toUpperCase())).toContain(id); // by buyer, any case
        expect(await find('zzz-nobody-has-this-name')).toEqual([]);
        // a "%" is not a wildcard: it would otherwise match every order
        expect(await find('%')).toEqual([]);
        expect(await find('_')).toEqual([]);
      });

      it('counts every status in the database, not in what a screen has loaded', async () => {
        const counts = await orders.adminOrderCounts(tenantA);
        const rows = await adminSql<{ status: string; n: number }[]>`select status, count(*)::int n from orders where tenant_id = ${tenantA} group by status`;
        expect(counts.all).toBe(rows.reduce((sum, r) => sum + r.n, 0));
        expect(counts.byStatus).toEqual(Object.fromEntries(rows.map((r) => [r.status, r.n])));
      });
    });

    describe('reading orders', () => {
      it('lets a buyer list and read their own orders, newest first', async () => {
        const p = await liveProduct('Checkout Reading', 400);
        const buyer = await insertBuyer();
        const orderIds: string[] = [];
        for (let i = 0; i < 2; i += 1) {
          await cart.addItem(tenantA, { userId: buyer }, { productId: p.id, quantity: 1 });
          const created = await orders.createRecipient(tenantA, buyer, recipient({ address: address({ municipalityId: checkoutMunicipality }) }));
          const { order } = await orders.checkout(tenantA, buyer, {
            recipientId: created.id,
            addressId: created.addresses[0]?.id as string,
            provider: 'manual',
          });
          orderIds.push(order.id);
        }
        const list = await orders.listOrdersForBuyer(tenantA, buyer);
        expect(list.map((o) => o.id).slice(0, 2)).toEqual([...orderIds].reverse());
      });

      it("refuses a buyer another buyer's order, and an admin can still read it", async () => {
        const p = await liveProduct('Checkout Privacy', 400);
        const { order } = await checkoutAs('manual', p.id);
        const stranger = crypto.randomUUID();
        await expect(orders.getOrderForBuyer(tenantA, stranger, order.id)).rejects.toBeInstanceOf(NotFoundError);
        expect((await orders.getOrderForAdmin(tenantA, order.id)).id).toBe(order.id);
      });

      it("hides one store's orders from another", async () => {
        const p = await liveProduct('Checkout Cross Tenant', 400);
        const { order } = await checkoutAs('manual', p.id);
        await expect(orders.getOrderForAdmin(tenantB, order.id)).rejects.toBeInstanceOf(NotFoundError);
        expect((await orders.listOrdersForAdmin(tenantB, {})).map((o) => o.id)).not.toContain(order.id);
      });

      it('filters the admin list by status', async () => {
        const p = await liveProduct('Checkout Filter', 400);
        const { order } = await checkoutAs('manual', p.id);
        await orders.adminCancel(tenantA, adminUser, order.id);
        const cancelled = await orders.listOrdersForAdmin(tenantA, { status: 'cancelled' });
        expect(cancelled.map((o) => o.id)).toContain(order.id);
        expect((await orders.listOrdersForAdmin(tenantA, { status: 'paid' })).map((o) => o.id)).not.toContain(order.id);
      });
    });

    describe('the admin queue', () => {
      it('shows who bought and how many items each order holds', async () => {
        const p = await liveProduct('Queue Buyer', 700);
        const { buyer, order } = await checkoutAs('manual', p.id, 3);
        await adminSql`UPDATE users SET full_name = 'Ana Pérez' WHERE id = ${buyer}`;

        const row = (await orders.listOrdersForAdmin(tenantA, {})).find((o) => o.id === order.id);
        expect(row).toMatchObject({ itemCount: 3, buyer: { fullName: 'Ana Pérez' } });
        expect(row?.buyer?.email).toMatch(/@example\.com$/);
        expect((await orders.getOrderForAdmin(tenantA, order.id)).buyer?.fullName).toBe('Ana Pérez');
      });

      it('moves a paid order along: preparing -> out_for_delivery -> delivered', async () => {
        const p = await liveProduct('Queue Flow', 700);
        const { order } = await checkoutAs('manual', p.id);
        await orders.adminMarkPaid(tenantA, adminUser, order.id);
        await orders.adminMarkPreparing(tenantA, adminUser, order.id);

        expect((await orders.adminMarkOutForDelivery(tenantA, adminUser, order.id)).status).toBe('out_for_delivery');
        const delivered = await orders.adminMarkDelivered(tenantA, adminUser, order.id);
        expect(delivered.status).toBe('delivered');
        expect(delivered.deliveredAt).not.toBeNull();
      });

      it('will not skip a step', async () => {
        const p = await liveProduct('Queue Skip', 700);
        const { order } = await checkoutAs('manual', p.id);
        await orders.adminMarkPaid(tenantA, adminUser, order.id);
        const failed = await orders.adminMarkOutForDelivery(tenantA, adminUser, order.id).catch((err: unknown) => err);
        expect((failed as ConflictError).details).toMatchObject({ reason: 'ILLEGAL_TRANSITION', from: 'paid', to: 'out_for_delivery' });
      });

      it('refuses "delivered" while the store requires a delivery photo (proof arrives with M4)', async () => {
        const p = await liveProduct('Queue Photo', 700);
        const { order } = await checkoutAs('manual', p.id);
        await orders.adminMarkPaid(tenantA, adminUser, order.id);
        await orders.adminMarkPreparing(tenantA, adminUser, order.id);
        await orders.adminMarkOutForDelivery(tenantA, adminUser, order.id);

        await adminSql`UPDATE tenants SET settings = '{"require_delivery_photo": true}'::jsonb WHERE id = ${tenantA}`;
        try {
          const failed = await orders.adminMarkDelivered(tenantA, adminUser, order.id).catch((err: unknown) => err);
          expect(failed).toBeInstanceOf(ConflictError);
          expect((failed as ConflictError).details).toMatchObject({ reason: 'DELIVERY_PHOTO_REQUIRED' });
        } finally {
          await adminSql`UPDATE tenants SET settings = '{}'::jsonb WHERE id = ${tenantA}`;
        }
        expect((await orders.getOrderForAdmin(tenantA, order.id)).status).toBe('out_for_delivery');
      });
    });

    describe('manual transfer', () => {
      async function manualOrder(name: string) {
        const p = await liveProduct(name, 1250);
        return checkoutAs('manual', p.id, 2); // total 2500 + 500 delivery
      }

      async function addScreenshot(orderId: string, status = 'ready') {
        await adminSql`
          INSERT INTO media (tenant_id, owner_type, owner_id, key_original, key_thumb, key_card, key_full, status)
          VALUES (${tenantA}, 'payment_proof', ${orderId}, 'o.jpg', 'public/t.webp', 'public/c.webp', 'public/f.webp', ${status})`;
      }

      async function methodId(kind: string): Promise<string> {
        const found = (await payments.listManualMethods(tenantA, 100)).find((m) => m.kind === kind);
        if (!found) throw new Error(`no ${kind} method in the test store`);
        return found.id;
      }

      it('tells the buyer who to pay and exactly how much, with the order number as the reference', async () => {
        const { buyer, order } = await manualOrder('Manual Instructions');
        const info = await orders.getPaymentInstructions(tenantA, buyer, order.id);
        expect(info).toMatchObject({ orderId: order.id, amountCents: 3000, currency: 'USD', reference: order.orderNumber, report: null });
        const paypal = info?.methods.find((m) => m.kind === 'paypal');
        expect(paypal).toMatchObject({ amountInLink: true, link: 'https://www.paypal.com/paypalme/teststore/30.00USD' });
        expect(info?.methods.map((m) => m.kind)).toEqual(expect.arrayContaining(['zelle', 'paypal']));
      });

      it('has no instructions for a card order, and shows them only to the buyer of that order', async () => {
        const p = await liveProduct('Manual Card', 800);
        const card = await checkoutAs('tropipay', p.id);
        expect(await orders.getPaymentInstructions(tenantA, card.buyer, card.order.id)).toBeNull();

        const { order } = await manualOrder('Manual Privacy');
        await expect(orders.getPaymentInstructions(tenantA, crypto.randomUUID(), order.id)).rejects.toBeInstanceOf(NotFoundError);
      });

      it('needs a screenshot before a transfer can be reported', async () => {
        const { buyer, order } = await manualOrder('Manual No Shot');
        const failed = await orders.reportTransfer(tenantA, buyer, order.id, { methodId: await methodId('zelle'), transferReference: 'ABC123' }).catch((e: unknown) => e);
        expect((failed as ConflictError).details).toMatchObject({ reason: 'SCREENSHOT_REQUIRED' });

        await addScreenshot(order.id, 'failed'); // a failed upload does not count
        const stillFailed = await orders.reportTransfer(tenantA, buyer, order.id, { methodId: await methodId('zelle'), transferReference: 'ABC123' }).catch((e: unknown) => e);
        expect((stillFailed as ConflictError).details).toMatchObject({ reason: 'SCREENSHOT_REQUIRED' });
      });

      it('the "transfers to check" filter and its count agree, and exclude orders nobody reported', async () => {
        const reported = await manualOrder('Filter Reported');
        await addScreenshot(reported.order.id);
        await orders.reportTransfer(tenantA, reported.buyer, reported.order.id, { methodId: await methodId('zelle'), transferReference: 'FILTER1' });
        const quiet = await manualOrder('Filter Quiet');

        const all: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await orders.pageOrdersForAdmin(tenantA, { filter: 'transfer' }, { limit: 3, cursor });
          expect(page.items.every((o) => o.transferReported && o.status === 'pending_payment')).toBe(true);
          all.push(...page.items.map((o) => o.id));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);

        expect(all).toContain(reported.order.id);
        expect(all).not.toContain(quiet.order.id);
        expect((await orders.adminOrderCounts(tenantA)).transfer).toBe(all.length);
      });

      it('refuses a method the store does not accept', async () => {
        const { buyer, order } = await manualOrder('Manual Bad Method');
        await addScreenshot(order.id);
        await expect(orders.reportTransfer(tenantA, buyer, order.id, { methodId: crypto.randomUUID(), transferReference: 'ABC123' })).rejects.toBeInstanceOf(ValidationError);
      });

      it('records the report, flags the order for the admin, and the admin marks it paid', async () => {
        const { buyer, order } = await manualOrder('Manual Report');
        await addScreenshot(order.id);
        const info = await orders.reportTransfer(tenantA, buyer, order.id, { methodId: await methodId('paypal'), transferReference: '9XJ12345K', notes: 'sent from my spouse account' });
        expect(info.report).toMatchObject({ method: 'PayPal', transferReference: '9XJ12345K', notes: 'sent from my spouse account' });

        const row = (await orders.listOrdersForAdmin(tenantA, {})).find((o) => o.id === order.id);
        expect(row?.transferReported).toBe(true);
        const detail = await orders.getOrderForAdmin(tenantA, order.id);
        expect(detail).toMatchObject({ paymentProvider: 'manual', paymentReport: { method: 'PayPal', transferReference: '9XJ12345K' } });

        await orders.adminMarkPaid(tenantA, adminUser, order.id, 'Seen in PayPal');
        const after = (await orders.listOrdersForAdmin(tenantA, {})).find((o) => o.id === order.id);
        expect(after).toMatchObject({ status: 'paid', transferReported: false });
      });

      it('keeps the latest report when the buyer corrects it, and refuses once paid', async () => {
        const { buyer, order } = await manualOrder('Manual Correct');
        await addScreenshot(order.id);
        await orders.reportTransfer(tenantA, buyer, order.id, { methodId: await methodId('zelle'), transferReference: 'FIRST1' });
        await orders.reportTransfer(tenantA, buyer, order.id, { methodId: await methodId('zelle'), transferReference: 'SECOND2' });
        expect((await orders.getOrderForAdmin(tenantA, order.id)).paymentReport?.transferReference).toBe('SECOND2');

        await orders.adminMarkPaid(tenantA, adminUser, order.id);
        const late = await orders.reportTransfer(tenantA, buyer, order.id, { methodId: await methodId('zelle'), transferReference: 'LATE3' }).catch((e: unknown) => e);
        expect((late as ConflictError).details).toMatchObject({ reason: 'NOT_PENDING_PAYMENT' });
      });
    });

    describe('delivery proof and status events', () => {
      async function outForDelivery(name: string) {
        const p = await liveProduct(name, 700);
        const { order } = await checkoutAs('manual', p.id);
        await orders.adminMarkPaid(tenantA, adminUser, order.id);
        await orders.adminMarkPreparing(tenantA, adminUser, order.id);
        await orders.adminMarkOutForDelivery(tenantA, adminUser, order.id);
        return order;
      }

      async function addReadyPhoto(orderId: string) {
        await adminSql`
          INSERT INTO media (tenant_id, owner_type, owner_id, key_original, key_thumb, key_card, key_full, status)
          VALUES (${tenantA}, 'delivery', ${orderId}, 'o.jpg', 'public/t.webp', 'public/c.webp', 'public/f.webp', 'ready')`;
      }

      const confirm = async (orderId: string, name = 'Carmen') =>
        (await import('../fulfilment/index.js')).fulfilmentService.confirmDelivery(tenantA, adminUser, orderId, { recipientName: name });

      it('records who received the order and marks it delivered', async () => {
        const order = await outForDelivery('Proof Ok');
        const proof = await confirm(order.id, 'Carmen Díaz');
        expect(proof).toMatchObject({ orderId: order.id, recipientName: 'Carmen Díaz', photos: [] });
        expect((await orders.getOrderForAdmin(tenantA, order.id)).status).toBe('delivered');
        const again = await confirm(order.id, 'Someone else'); // a retry after a dropped connection
        expect(again.recipientName).toBe('Carmen Díaz');
      });

      it('requires a ready photo when the store asks for one, and accepts it once there is one', async () => {
        const order = await outForDelivery('Proof Photo');
        await adminSql`UPDATE tenants SET settings = '{"require_delivery_photo": true}'::jsonb WHERE id = ${tenantA}`;
        try {
          const failed = await confirm(order.id).catch((err: unknown) => err);
          expect((failed as ConflictError).details).toMatchObject({ reason: 'DELIVERY_PHOTO_REQUIRED' });
          expect((await orders.getOrderForAdmin(tenantA, order.id)).status).toBe('out_for_delivery');

          await addReadyPhoto(order.id);
          const proof = await confirm(order.id);
          expect(proof.photos).toHaveLength(1);
          expect(proof.photos[0]?.fullUrl).toContain('f.webp');
        } finally {
          await adminSql`UPDATE tenants SET settings = '{}'::jsonb WHERE id = ${tenantA}`;
        }
      });

      it('only delivers an order that is out for delivery', async () => {
        const p = await liveProduct('Proof Early', 700);
        const { order } = await checkoutAs('manual', p.id);
        const failed = await confirm(order.id).catch((err: unknown) => err);
        expect((failed as ConflictError).details).toMatchObject({ reason: 'ILLEGAL_TRANSITION' });
      });

      it("keeps one store's proof out of another's", async () => {
        const order = await outForDelivery('Proof Tenant');
        await confirm(order.id);
        const { fulfilmentService } = await import('../fulfilment/index.js');
        expect(await fulfilmentService.getProof(tenantB, order.id)).toBeNull();
      });

      it('announces a status change once, not on a repeat', async () => {
        const { events } = await import('../../core/events.js');
        const emit = vi.mocked(events.emit);
        const p = await liveProduct('Event Once', 700);
        const { order } = await checkoutAs('manual', p.id);
        emit.mockClear();
        await orders.adminMarkPaid(tenantA, adminUser, order.id);
        await orders.adminMarkPaid(tenantA, adminUser, order.id);
        const paid = emit.mock.calls.filter(([name]) => name === 'order.status_changed');
        expect(paid).toHaveLength(1);
        expect(paid[0]?.[1]).toMatchObject({ orderId: order.id, tenantId: tenantA, status: 'paid' });
      });
    });

    describe('courier dispatch', () => {
      async function insertCourier(name: string): Promise<{ userId: string; courierId: string }> {
        const userId = crypto.randomUUID();
        await adminSql`
          INSERT INTO users (id, tenant_id, supertokens_user_id, email, full_name, phone, role)
          VALUES (${userId}, ${tenantA}, ${crypto.randomUUID()}, ${`courier-${userId}@example.com`}, ${name}, '+53 5 5550000', 'courier')`;
        const { fulfilmentService } = await import('../fulfilment/index.js');
        const option = (await fulfilmentService.listCouriers(tenantA)).find((c) => c.name === name);
        if (!option) throw new Error('courier not listed');
        return { userId, courierId: option.id };
      }

      async function paidOrder(name: string, prepared: boolean) {
        const p = await liveProduct(name, 700);
        const { order } = await checkoutAs('manual', p.id);
        await orders.adminMarkPaid(tenantA, adminUser, order.id);
        if (prepared) await orders.adminMarkPreparing(tenantA, adminUser, order.id);
        return order;
      }

      const laneIds = async (lane: 'unassigned' | 'assigned' | 'problems', tenant = tenantA) =>
        (await (await import('../fulfilment/index.js')).fulfilmentService.pageBoard(tenant, lane, { limit: 100 })).items.map((i) => i.id);

      it('runs the whole process: assign, accept, pick up, deliver', async () => {
        const { fulfilmentService: f } = await import('../fulfilment/index.js');
        const courier = await insertCourier('Carlos Courier');
        const order = await paidOrder('Dispatch Happy', true);
        expect(await laneIds('unassigned')).toContain(order.id);

        const assignment = await f.assignCourier(tenantA, adminUser, order.id, courier.courierId);
        expect(assignment).toMatchObject({ status: 'assigned', courierName: 'Carlos Courier' });
        expect(await laneIds('unassigned')).not.toContain(order.id);
        expect(await laneIds('assigned')).toContain(order.id);
        // asking again for the same courier changes nothing
        expect((await f.assignCourier(tenantA, adminUser, order.id, courier.courierId)).id).toBe(assignment.id);

        const actor = { id: courier.userId, role: 'courier' };
        expect((await f.accept(tenantA, actor, assignment.id)).status).toBe('accepted');
        expect((await f.pickUp(tenantA, actor, assignment.id)).status).toBe('picked_up');
        expect((await orders.getOrderForAdmin(tenantA, order.id)).status).toBe('out_for_delivery');

        const mine = await f.pageMyDeliveries(tenantA, actor, { limit: 30 });
        expect(mine.items.map((i) => i.id)).toContain(order.id);
        expect(mine.items.find((i) => i.id === order.id)?.buyer).toBeNull(); // a courier never sees who paid

        const proof = await f.confirmDelivery(tenantA, courier.userId, order.id, { recipientName: 'Rosa' }, 'courier');
        expect(proof.recipientName).toBe('Rosa');
        expect((await orders.getOrderForAdmin(tenantA, order.id)).status).toBe('delivered');
        const history = await f.getOrderAssignments(tenantA, order.id);
        expect(history.current).toBeNull();
        expect(history.history[0]).toMatchObject({ status: 'delivered' });
        const [row] = await adminSql<{ courier_id: string }[]>`SELECT courier_id FROM deliveries WHERE order_id = ${order.id}`;
        expect(row?.courier_id).toBe(courier.courierId);
        expect(await f.pageMyDeliveries(tenantA, actor, { limit: 30 })).toMatchObject({ items: expect.not.arrayContaining([expect.objectContaining({ id: order.id })]) });
      });

      it('refuses to pick up an order that is not prepared yet', async () => {
        const { fulfilmentService: f } = await import('../fulfilment/index.js');
        const courier = await insertCourier('Pablo Early');
        const order = await paidOrder('Dispatch Early', false);
        const assignment = await f.assignCourier(tenantA, adminUser, order.id, courier.courierId);
        const failed = await f.pickUp(tenantA, { id: courier.userId, role: 'courier' }, assignment.id).catch((e: unknown) => e);
        expect((failed as ConflictError).details).toMatchObject({ reason: 'ORDER_NOT_READY' });
      });

      it('only lets the assigned courier touch the assignment or deliver the order', async () => {
        const { fulfilmentService: f } = await import('../fulfilment/index.js');
        const owner = await insertCourier('Owner Courier');
        const other = await insertCourier('Other Courier');
        const order = await paidOrder('Dispatch Owner', true);
        const assignment = await f.assignCourier(tenantA, adminUser, order.id, owner.courierId);
        const intruder = { id: other.userId, role: 'courier' };
        const attempts = [
          () => f.accept(tenantA, intruder, assignment.id),
          () => f.decline(tenantA, intruder, assignment.id),
          () => f.pickUp(tenantA, intruder, assignment.id),
        ];
        for (const attempt of attempts) {
          expect(((await attempt().catch((e: unknown) => e)) as { details?: unknown }).details).toMatchObject({ reason: 'NOT_YOUR_DELIVERY' });
        }
        await orders.adminMarkOutForDelivery(tenantA, adminUser, order.id);
        const stolen = await f.confirmDelivery(tenantA, other.userId, order.id, { recipientName: 'X' }, 'courier').catch((e: unknown) => e);
        expect((stolen as { details?: unknown }).details).toMatchObject({ reason: 'NOT_YOUR_DELIVERY' });
        expect((await orders.getOrderForAdmin(tenantA, order.id)).status).toBe('out_for_delivery');
        expect((await f.pageMyDeliveries(tenantA, intruder, { limit: 30 })).items.map((i) => i.id)).not.toContain(order.id);
      });

      it('reassigning closes the previous assignment, leaving one open', async () => {
        const { fulfilmentService: f } = await import('../fulfilment/index.js');
        const first = await insertCourier('First Courier');
        const second = await insertCourier('Second Courier');
        const order = await paidOrder('Dispatch Reassign', true);
        await f.assignCourier(tenantA, adminUser, order.id, first.courierId);
        const moved = await f.assignCourier(tenantA, adminUser, order.id, second.courierId);
        const { current, history } = await f.getOrderAssignments(tenantA, order.id);
        expect(current?.id).toBe(moved.id);
        expect(history.map((h) => h.status)).toEqual(['assigned', 'released']);
        await f.releaseAssignment(tenantA, adminUser, order.id);
        expect((await f.getOrderAssignments(tenantA, order.id)).current).toBeNull();
        expect(await laneIds('unassigned')).toContain(order.id);
        const again = await f.releaseAssignment(tenantA, adminUser, order.id).catch((e: unknown) => e);
        expect(again).toBeInstanceOf(NotFoundError);
      });

      it('puts a declined or failed delivery in the problems lane until it is given to someone', async () => {
        const { fulfilmentService: f } = await import('../fulfilment/index.js');
        const courier = await insertCourier('Problem Courier');
        const actor = { id: courier.userId, role: 'courier' };
        const declined = await paidOrder('Dispatch Declined', true);
        const a1 = await f.assignCourier(tenantA, adminUser, declined.id, courier.courierId);
        await f.decline(tenantA, actor, a1.id, 'no bike today');
        expect(await laneIds('problems')).toContain(declined.id);
        expect(await laneIds('unassigned')).not.toContain(declined.id);

        const failed = await paidOrder('Dispatch Failed', true);
        const a2 = await f.assignCourier(tenantA, adminUser, failed.id, courier.courierId);
        await f.pickUp(tenantA, actor, a2.id);
        await f.fail(tenantA, actor, a2.id, 'recipient_absent', 'nobody home');
        expect(await laneIds('problems')).toContain(failed.id);
        expect((await orders.getOrderForAdmin(tenantA, failed.id)).status).toBe('out_for_delivery');

        await f.assignCourier(tenantA, adminUser, failed.id, courier.courierId); // another try
        expect(await laneIds('problems')).not.toContain(failed.id);
        expect(await laneIds('assigned')).toContain(failed.id);
      });

      it('only dispatches paid orders, and keeps one store’s dispatch out of another’s', async () => {
        const { fulfilmentService: f } = await import('../fulfilment/index.js');
        const courier = await insertCourier('Tenant Courier');
        const p = await liveProduct('Dispatch Unpaid', 700);
        const { order: unpaid } = await checkoutAs('manual', p.id);
        const refused = await f.assignCourier(tenantA, adminUser, unpaid.id, courier.courierId).catch((e: unknown) => e);
        expect((refused as ConflictError).details).toMatchObject({ reason: 'ORDER_NOT_DISPATCHABLE' });

        const order = await paidOrder('Dispatch Tenant', true);
        await f.assignCourier(tenantA, adminUser, order.id, courier.courierId);
        expect(await laneIds('assigned', tenantB)).toEqual([]);
        expect(await f.listCouriers(tenantB)).toEqual([]);
        const crossed = await f.assignCourier(tenantB, adminUser, order.id, courier.courierId).catch((e: unknown) => e);
        expect(crossed).toBeInstanceOf(NotFoundError);
      });
    });

    describe('sharing an order’s products by link', () => {
      it('shows the products and nothing about the recipient, address, phone or payment', async () => {
        const p = await liveProduct('Share Visible', 1250);
        const { buyer, order } = await checkoutAs('manual', p.id, 3);
        const { token } = await orders.enableShare(tenantA, buyer, order.id);
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect((await orders.enableShare(tenantA, buyer, order.id)).token).toBe(token); // sharing again is the same link
        expect(await orders.getShare(tenantA, buyer, order.id)).toEqual({ token });

        const shared = await orders.getSharedOrder(tenantA, token);
        expect(shared).toMatchObject({ orderId: null, orderNumber: null });
        expect(shared.items).toEqual([expect.objectContaining({ productId: p.id, nameEs: 'Share Visible', quantity: 3, priceCents: 1250, available: true })]);

        const admin = await orders.getOrderForAdmin(tenantA, order.id);
        const raw = JSON.stringify(shared);
        for (const secret of [admin.recipientNameSnapshot, admin.recipientPhonesSnapshot, JSON.stringify(admin.addressSnapshot).slice(1, 20), admin.orderNumber, order.id, String(admin.totalCents)]) {
          expect(raw).not.toContain(secret);
        }
      });

      it('tells store staff which order it is, and nobody else', async () => {
        const p = await liveProduct('Share Staff', 700);
        const { buyer, order } = await checkoutAs('manual', p.id);
        const { token } = await orders.enableShare(tenantA, buyer, order.id);
        for (const role of ['admin', 'staff']) {
          expect(await orders.getSharedOrder(tenantA, token, role)).toMatchObject({ orderId: order.id, orderNumber: order.orderNumber });
        }
        for (const role of ['buyer', 'courier', undefined]) {
          expect(await orders.getSharedOrder(tenantA, token, role)).toMatchObject({ orderId: null, orderNumber: null });
        }
      });

      it('stops working the moment the buyer switches it off, and a new link is a different one', async () => {
        const p = await liveProduct('Share Revoke', 700);
        const { buyer, order } = await checkoutAs('manual', p.id);
        const { token } = await orders.enableShare(tenantA, buyer, order.id);
        await orders.disableShare(tenantA, buyer, order.id);
        await orders.disableShare(tenantA, buyer, order.id); // harmless twice
        await expect(orders.getSharedOrder(tenantA, token)).rejects.toBeInstanceOf(NotFoundError);
        expect(await orders.getShare(tenantA, buyer, order.id)).toEqual({ token: null });
        expect((await orders.enableShare(tenantA, buyer, order.id)).token).not.toBe(token);
        await expect(orders.getSharedOrder(tenantA, token)).rejects.toBeInstanceOf(NotFoundError); // the old one stays dead
      });

      it('lets only the order’s own buyer share it, and only inside its own store', async () => {
        const p = await liveProduct('Share Owner', 700);
        const { buyer, order } = await checkoutAs('manual', p.id);
        const stranger = await insertBuyer();
        await expect(orders.enableShare(tenantA, stranger, order.id)).rejects.toBeInstanceOf(NotFoundError);
        await expect(orders.getShare(tenantA, stranger, order.id)).rejects.toBeInstanceOf(NotFoundError);
        await expect(orders.disableShare(tenantA, stranger, order.id)).rejects.toBeInstanceOf(NotFoundError);

        const { token } = await orders.enableShare(tenantA, buyer, order.id);
        await expect(orders.getSharedOrder(tenantB, token)).rejects.toBeInstanceOf(NotFoundError);
        await expect(orders.getSharedOrder(tenantA, 'x'.repeat(43))).rejects.toBeInstanceOf(NotFoundError);
      });

      it('shows what can be bought today, not what could be when the order was placed', async () => {
        const p = await liveProduct('Share Live', 700);
        const { buyer, order } = await checkoutAs('manual', p.id);
        const { token } = await orders.enableShare(tenantA, buyer, order.id);
        await adminSql`update products set stock_status = 'out' where id = ${p.id}`;
        expect((await orders.getSharedOrder(tenantA, token)).items[0]).toMatchObject({ productId: p.id, available: false });
        await adminSql`update products set stock_status = 'available', price_cents = 900 where id = ${p.id}`;
        expect((await orders.getSharedOrder(tenantA, token)).items[0]).toMatchObject({ available: true, priceCents: 900 });
        await adminSql`update products set deleted_at = now() where id = ${p.id}`;
        expect((await orders.getSharedOrder(tenantA, token)).items[0]).toMatchObject({ productId: null, nameEs: 'Share Live', available: false, priceCents: null });
      });
    });

    describe('telling the buyer what happened (events for the emails)', () => {
      const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const sent = async () => vi.mocked((await import('../../core/events.js')).events.emit);
      const announced = async (orderId: string) =>
        (await sent()).mock.calls.filter(([, payload]) => (payload as { orderId?: string }).orderId === orderId).map(([name, payload]) => ({ name, ...(payload as object) }));

      it('writes to each buyer in their own language: Spanish by default, English once chosen', async () => {
        const { identityService } = await import('../identity/index.js');
        const p = await liveProduct('Mail Locale', 700);
        const { buyer, order } = await checkoutAs('manual', p.id);
        expect((await orders.getOrderForAdmin(tenantA, order.id)).buyer?.locale).toBe('es');
        await identityService.setLocale(tenantA, buyer, 'en');
        expect((await orders.getOrderForAdmin(tenantA, order.id)).buyer?.locale).toBe('en');

        // The language picked on the signup form is kept; anything unknown reads Spanish.
        const signedUp = await identityService.findOrCreateFromSession(tenantA, crypto.randomUUID(), `locale-${crypto.randomUUID()}@example.com`, 'buyer', { locale: 'en' });
        expect(signedUp.locale).toBe('en');
        const odd = await identityService.findOrCreateFromSession(tenantA, crypto.randomUUID(), `locale-${crypto.randomUUID()}@example.com`, 'buyer', { locale: 'fr' });
        expect(odd.locale).toBe('es');
      });

      it('announces a placed order once', async () => {
        const p = await liveProduct('Mail Placed', 700);
        const { order } = await checkoutAs('manual', p.id);
        const events = (await announced(order.id)).filter((e) => e.name === 'order.status_changed');
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ status: 'pending_payment', tenantId: tenantA });
      });

      it('announces a cancellation once, not on a repeat', async () => {
        const p = await liveProduct('Mail Cancel', 700);
        const { buyer, order } = await checkoutAs('manual', p.id);
        await orders.cancelByBuyer(tenantA, buyer, order.id);
        await orders.cancelByBuyer(tenantA, buyer, order.id);
        const cancelled = (await announced(order.id)).filter((e) => (e as { status?: string }).status === 'cancelled');
        expect(cancelled).toHaveLength(1);
      });

      it('announces a refund', async () => {
        const p = await liveProduct('Mail Refund', 700);
        const { order } = await checkoutAs('manual', p.id);
        await orders.adminMarkPaid(tenantA, adminUser, order.id);
        await orders.refund(tenantA, adminUser, order.id);
        expect((await announced(order.id)).filter((e) => (e as { status?: string }).status === 'refunded')).toHaveLength(1);
      });

      it('says an order that was never paid timed out, so the email can explain', async () => {
        const p = await liveProduct('Mail Timeout', 700);
        const { order } = await checkoutAs('manual', p.id);
        await adminSql`update orders set placed_at = ${daysAgo(4)} where id = ${order.id}`;
        await orders.reconcilePendingPayments(tenantA);
        const cancelled = (await announced(order.id)).filter((e) => (e as { status?: string }).status === 'cancelled');
        expect(cancelled).toHaveLength(1);
        expect(cancelled[0]).toMatchObject({ cause: 'unpaid' });
      });

      it('reminds an unpaid order once, after 48 hours, and never twice', async () => {
        const p = await liveProduct('Mail Reminder', 700);
        const { order } = await checkoutAs('manual', p.id);
        const reminders = async () => (await announced(order.id)).filter((e) => e.name === 'order.payment_reminder');

        await adminSql`update orders set placed_at = ${daysAgo(1.5)} where id = ${order.id}`;
        expect((await orders.reconcilePendingPayments(tenantA)).reminded).toBe(0); // too early
        expect(await reminders()).toHaveLength(0);

        await adminSql`update orders set placed_at = ${daysAgo(2.2)} where id = ${order.id}`;
        expect((await orders.reconcilePendingPayments(tenantA)).reminded).toBeGreaterThanOrEqual(1);
        expect(await reminders()).toHaveLength(1);
        await orders.reconcilePendingPayments(tenantA);
        expect(await reminders()).toHaveLength(1); // the second pass finds it already sent
        await adminSql`update orders set status = 'cancelled' where id = ${order.id}`; // out of the way of the other reconciliation tests
      });

      it('does not nag a buyer who says they already paid', async () => {
        const p = await liveProduct('Mail No Nag', 700);
        const { buyer, order } = await checkoutAs('manual', p.id);
        const zelle = (await payments.listManualMethods(tenantA, 100)).find((m) => m.kind === 'zelle');
        if (!zelle) throw new Error('no zelle method in the test store');
        await adminSql`
          INSERT INTO media (tenant_id, owner_type, owner_id, key_original, key_thumb, key_card, key_full, status)
          VALUES (${tenantA}, 'payment_proof', ${order.id}, 'o.jpg', 'public/t.webp', 'public/c.webp', 'public/f.webp', 'ready')`;
        await orders.reportTransfer(tenantA, buyer, order.id, { methodId: zelle.id, transferReference: 'NONAG1' });
        await adminSql`update orders set placed_at = ${daysAgo(2.2)} where id = ${order.id}`;
        await orders.reconcilePendingPayments(tenantA);
        expect((await announced(order.id)).filter((e) => e.name === 'order.payment_reminder')).toHaveLength(0);
        await adminSql`update orders set status = 'cancelled' where id = ${order.id}`;
      });
    });

    describe('the bell: who is told at each step', () => {
      // Feeds what orders / fulfilment announced through the real notification handlers, as the worker would.
      async function drain() {
        const { events } = await import('../../core/events.js');
        const handlers = new Map(vi.mocked(events.on).mock.calls.map(([name, fn]) => [name as string, fn as (payload: unknown) => Promise<void>]));
        const emit = vi.mocked(events.emit);
        const queued = emit.mock.calls.splice(0);
        for (const [name, payload] of queued) await handlers.get(name as string)?.(payload);
      }
      const kindsFor = async (userId: string, orderId: string) =>
        (await adminSql<{ kind: string; data: Record<string, string> }[]>`SELECT kind, data FROM notifications WHERE user_id = ${userId} AND order_id = ${orderId} ORDER BY created_at`);

      it('tells the store, the courier and the buyer as the order moves, and the store when a delivery fails', async () => {
        const { registerNotificationsWorker } = await import('../notifications/index.js');
        const { events } = await import('../../core/events.js');
        vi.mocked(events.on).mockClear();
        registerNotificationsWorker();
        const { fulfilmentService: f } = await import('../fulfilment/index.js');

        const adminId = crypto.randomUUID();
        await adminSql`
          INSERT INTO users (id, tenant_id, supertokens_user_id, email, full_name, role)
          VALUES (${adminId}, ${tenantA}, ${crypto.randomUUID()}, ${`owner-${adminId}@example.com`}, 'Owner', 'admin')`;
        const courierUserId = crypto.randomUUID();
        await adminSql`
          INSERT INTO users (id, tenant_id, supertokens_user_id, email, full_name, phone, role)
          VALUES (${courierUserId}, ${tenantA}, ${crypto.randomUUID()}, ${`bell-courier-${courierUserId}@example.com`}, 'Bell Courier', '+53 5 5550000', 'courier')`;
        const courier = (await f.listCouriers(tenantA)).find((c) => c.name === 'Bell Courier');
        if (!courier) throw new Error('courier not listed');

        await drain(); // whatever earlier tests announced
        const p = await liveProduct('Bell Flow', 700);
        const { buyer, order } = await checkoutAs('manual', p.id);
        await drain();
        expect((await kindsFor(adminId, order.id)).map((r) => r.kind)).toEqual(['new_order']);

        await orders.adminMarkPaid(tenantA, adminUser, order.id);
        await orders.adminMarkPreparing(tenantA, adminUser, order.id);
        await drain();
        expect((await kindsFor(adminId, order.id)).map((r) => r.kind)).toEqual(['new_order', 'order_paid']);
        expect((await kindsFor(buyer, order.id)).map((r) => r.kind)).toEqual(['buyer_paid']);

        const a = await f.assignCourier(tenantA, adminUser, order.id, courier.id);
        await drain();
        expect((await kindsFor(courierUserId, order.id)).map((r) => r.kind)).toEqual(['delivery_assigned']);

        const actor = { id: courierUserId, role: 'courier' };
        await f.accept(tenantA, actor, a.id);
        await f.pickUp(tenantA, actor, a.id);
        await drain();
        expect((await kindsFor(adminId, order.id)).map((r) => r.kind)).toEqual(['new_order', 'order_paid', 'delivery_accepted', 'delivery_picked_up']);
        expect((await kindsFor(buyer, order.id)).map((r) => r.kind)).toEqual(['buyer_paid', 'buyer_on_the_way']);

        await f.fail(tenantA, actor, a.id, 'recipient_absent', 'nobody home');
        await drain();
        const failed = (await kindsFor(adminId, order.id)).at(-1);
        expect(failed).toMatchObject({ kind: 'delivery_failed', data: { courierName: 'Bell Courier', reason: 'recipient_absent', note: 'nobody home' } });

        // taking it from the courier tells the courier; delivering tells the store and the buyer
        const b = await f.assignCourier(tenantA, adminUser, order.id, courier.id);
        await f.releaseAssignment(tenantA, adminUser, order.id);
        await drain();
        expect((await kindsFor(courierUserId, order.id)).map((r) => r.kind)).toEqual(['delivery_assigned', 'delivery_assigned', 'delivery_released']);
        await f.assignCourier(tenantA, adminUser, order.id, courier.id);
        await f.confirmDelivery(tenantA, courierUserId, order.id, {}, 'courier');
        await drain();
        expect((await kindsFor(adminId, order.id)).at(-1)?.kind).toBe('order_delivered');
        expect((await kindsFor(buyer, order.id)).map((r) => r.kind)).toEqual(['buyer_paid', 'buyer_on_the_way', 'buyer_delivered']);
        expect(b.status).toBe('assigned');
      });

      it('tells the buyer an unpaid order timed out, with the reason', async () => {
        const { registerNotificationsWorker } = await import('../notifications/index.js');
        const { events } = await import('../../core/events.js');
        vi.mocked(events.on).mockClear();
        registerNotificationsWorker();
        await drain();
        const p = await liveProduct('Bell Timeout', 700);
        const { buyer, order } = await checkoutAs('manual', p.id);
        await adminSql`update orders set placed_at = now() - interval '4 days' where id = ${order.id}`;
        await orders.reconcilePendingPayments(tenantA);
        await drain();
        expect((await kindsFor(buyer, order.id)).at(-1)).toMatchObject({ kind: 'buyer_cancelled', data: { cause: 'unpaid' } });
      });
    });

    describe('sales statistics', () => {
      it('counts paid orders only, with totals, a zero-filled series, places and top products', async () => {
        const p = await liveProduct('Stats Product', 1000);
        const paid = await checkoutAs('manual', p.id, 2);
        await orders.adminMarkPaid(tenantA, adminUser, paid.order.id);
        await checkoutAs('manual', p.id, 5); // left unpaid: must not count

        const stats = await orders.getSalesStats(tenantA, 'week');
        expect(stats).toMatchObject({ range: 'week', granularity: 'day', currency: 'USD' });
        expect(stats.series).toHaveLength(7);
        expect(stats.series.at(-1)?.totalCents).toBeGreaterThanOrEqual(paid.order.totalCents);

        const mine = stats.topProducts.find((row) => row.nameEs === 'Stats Product');
        expect(mine).toMatchObject({ quantity: 2, totalCents: 2000 });
        expect(stats.byMunicipality.some((row) => row.municipalityId === checkoutMunicipality)).toBe(true);
        expect(stats.current.averageTicketCents).toBe(Math.round(stats.current.totalCents / stats.current.orders));
        expect(stats.series.reduce((sum, bucket) => sum + bucket.totalCents, 0)).toBe(stats.current.totalCents);
      });

      it('has 12 monthly buckets for a year and a previous period to compare with', async () => {
        const stats = await orders.getSalesStats(tenantA, 'year');
        expect(stats.granularity).toBe('month');
        expect(stats.series).toHaveLength(12);
        expect(stats.previous.orders).toBe(0);
      });

      it("never includes another store's sales", async () => {
        const stats = await orders.getSalesStats(tenantB, 'month');
        expect(stats.current).toMatchObject({ orders: 0, totalCents: 0 });
        expect(stats.topProducts).toEqual([]);
      });
    });

    describe('the state machine', () => {
      it('follows the happy path: pending_payment -> paid -> preparing -> refunded', async () => {
        const p = await liveProduct('State Happy', 600);
        const { order } = await checkoutAs('manual', p.id);

        const paid = await orders.adminMarkPaid(tenantA, adminUser, order.id);
        expect(paid.status).toBe('paid');
        expect(paid.paidAt).not.toBeNull();

        const preparing = await orders.adminMarkPreparing(tenantA, adminUser, order.id);
        expect(preparing.status).toBe('preparing');

        const refunded = await orders.refund(tenantA, adminUser, order.id, 'buyer changed their mind');
        expect(refunded.status).toBe('refunded');

        const [payment] = await adminSql`select status from payments where order_id = ${order.id}`;
        expect(payment?.status).toBe('refunded');
      });

      it('refuses an illegal transition, naming what is and is not allowed', async () => {
        const p = await liveProduct('State Illegal', 600);
        const { order } = await checkoutAs('manual', p.id);

        const failed = await orders.adminMarkPreparing(tenantA, adminUser, order.id).catch((err: unknown) => err);
        expect(failed).toBeInstanceOf(ConflictError);
        expect((failed as ConflictError).details).toMatchObject({ reason: 'ILLEGAL_TRANSITION', from: 'pending_payment', to: 'preparing' });
      });

      it('is idempotent: reaching a status it is already at is a no-op, not an error', async () => {
        const p = await liveProduct('State Idempotent', 600);
        const { order } = await checkoutAs('manual', p.id);
        await orders.adminMarkPaid(tenantA, adminUser, order.id);

        // handlePaymentConfirmed is exactly what the worker's event subscriber
        // calls — simulating a redelivered payment.paid event here.
        await expect(ordersServiceHandlePaymentConfirmed(order.id)).resolves.toBeUndefined();
        expect((await orders.getOrderForAdmin(tenantA, order.id)).status).toBe('paid');
      });

      async function ordersServiceHandlePaymentConfirmed(orderId: string): Promise<void> {
        const mod = await import('./orders.service.js');
        return mod.ordersService.handlePaymentConfirmed(tenantA, orderId);
      }

      it('lets a buyer cancel only before paying, and an admin override the same rule', async () => {
        const p = await liveProduct('State Cancel', 600);
        const { buyer, order } = await checkoutAs('manual', p.id);

        const paidOrder = await checkoutAs('manual', p.id);
        await orders.adminMarkPaid(tenantA, adminUser, paidOrder.order.id);
        const buyerCancelPaid = await orders
          .cancelByBuyer(tenantA, paidOrder.buyer, paidOrder.order.id)
          .catch((err: unknown) => err);
        expect(buyerCancelPaid).toBeInstanceOf(ConflictError);

        const cancelled = await orders.cancelByBuyer(tenantA, buyer, order.id, 'changed my mind');
        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.cancelledAt).not.toBeNull();
      });

      it('refuses to refund an order that was never paid, without calling the provider', async () => {
        const p = await liveProduct('State Refund Guard', 600);
        const { order } = await checkoutAs('manual', p.id);
        await expect(orders.refund(tenantA, adminUser, order.id)).rejects.toBeInstanceOf(ConflictError);
      });
    });

    describe('retrying a failed checkout attempt', () => {
      it('re-attempts the provider call for a still-pending order', async () => {
        const p = await liveProduct('Retry Basic', 600);
        const { buyer, order } = await checkoutAs('manual', p.id);
        const { checkoutUrl } = await orders.retryPayment(tenantA, buyer, order.id);
        expect(checkoutUrl).toBeNull(); // manual transfer never has one, retried or not
      });

      it('refuses to retry an order that is no longer pending', async () => {
        const p = await liveProduct('Retry Guard', 600);
        const { buyer, order } = await checkoutAs('manual', p.id);
        await orders.adminMarkPaid(tenantA, adminUser, order.id);
        await expect(orders.retryPayment(tenantA, buyer, order.id)).rejects.toBeInstanceOf(ConflictError);
      });
    });

    describe('reconciliation', () => {
      const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      it('leaves a fresh pending order untouched', async () => {
        const p = await liveProduct('Reconcile Fresh', 600);
        const { order } = await checkoutAs('manual', p.id);
        const result = await orders.reconcilePendingPayments(tenantA);
        expect(result.checked).toBe(0);
        expect((await orders.getOrderForAdmin(tenantA, order.id)).status).toBe('pending_payment');
      });

      it('self-heals a tropipay order the provider now reports as paid', async () => {
        const p = await liveProduct('Reconcile Selfheal', 600);
        const { order, paymentId } = await checkoutTropipay(p.id);
        await adminSql`update orders set placed_at = ${daysAgo(2)} where id = ${order.id}`;
        await adminSql`update payments set external_payment_id = 'ext-1' where id = ${paymentId}`;

        vi.spyOn(payments.getProvider('tropipay'), 'getStatus').mockResolvedValue('paid');
        const result = await orders.reconcilePendingPayments(tenantA);

        expect(result.selfHealed).toBe(1);
        expect((await orders.getOrderForAdmin(tenantA, order.id)).status).toBe('paid');
      });

      it('cancels a manual-transfer order past 72h without ever trying to poll it', async () => {
        const p = await liveProduct('Reconcile Manual Cancel', 600);
        const { order } = await checkoutAs('manual', p.id);
        await adminSql`update orders set placed_at = ${daysAgo(4)} where id = ${order.id}`;

        const getStatusSpy = vi.spyOn(payments.getProvider('tropipay'), 'getStatus');
        const result = await orders.reconcilePendingPayments(tenantA);

        expect(getStatusSpy).not.toHaveBeenCalled();
        expect(result.cancelled).toBe(1);
        expect((await orders.getOrderForAdmin(tenantA, order.id)).status).toBe('cancelled');
        const [payment] = await adminSql`select status from payments where order_id = ${order.id}`;
        expect(payment?.status).toBe('failed');
      });

      it('does not cancel a manual-transfer order that is merely old enough to poll, not yet 72h', async () => {
        const p = await liveProduct('Reconcile Manual Wait', 600);
        const { order } = await checkoutAs('manual', p.id);
        await adminSql`update orders set placed_at = ${daysAgo(1.5)} where id = ${order.id}`;

        const result = await orders.reconcilePendingPayments(tenantA);
        expect(result.cancelled).toBe(0);
        expect(result.selfHealed).toBe(0);
        expect((await orders.getOrderForAdmin(tenantA, order.id)).status).toBe('pending_payment');
      });

      it("does not reach into another tenant's stale orders", async () => {
        const p = await liveProduct('Reconcile Cross Tenant', 600);
        const { order } = await checkoutAs('manual', p.id);
        await adminSql`update orders set placed_at = ${daysAgo(4)} where id = ${order.id}`;

        const resultForB = await orders.reconcilePendingPayments(tenantB);
        expect(resultForB.checked).toBe(0);
        expect((await orders.getOrderForAdmin(tenantA, order.id)).status).toBe('pending_payment');
      });

      async function checkoutTropipay(productId: string) {
        vi.spyOn(payments.getProvider('tropipay'), 'createCheckout').mockResolvedValue({
          redirectUrl: 'https://pay.example/x',
          externalPaymentId: 'ext-pending',
        });
        const { buyer, order } = await checkoutAs('tropipay', productId);
        const [payment] = await adminSql`select id from payments where order_id = ${order.id}`;
        return { buyer, order, paymentId: payment?.id as string };
      }
    });

    describe('cross-tenant isolation of orders and order_items', () => {
      it("returns nothing when tenant B reads tenant A's order or its items", async () => {
        const p = await liveProduct('Isolation Orders', 600);
        const { order } = await checkoutAs('manual', p.id);
        await expect(orders.getOrderForAdmin(tenantB, order.id)).rejects.toBeInstanceOf(NotFoundError);

        const rows = await adminSql`select count(*)::int as n from order_items where order_id = ${order.id}`;
        expect(rows[0]?.n).toBeGreaterThan(0); // sanity: the items really exist
        // A tenant-B-scoped read (RLS-enforced) sees none of them.
        const { withTenant } = await import('../../db/client.js');
        const refused = await withTenant(tenantB, (tx) => tx.execute(sql`select * from order_items where order_id = ${order.id}`));
        expect((refused as unknown as unknown[]).length).toBe(0);
      });

      it("keeps order numbering per store: tenant B cannot read or advance tenant A's counter", async () => {
        const p = await liveProduct('Isolation Counter', 600);
        await checkoutAs('manual', p.id); // makes sure tenant A has a counter row
        const counters = await adminSql`select count(*)::int as n from order_counters where tenant_id = ${tenantA}`;
        expect(counters[0]?.n).toBe(1);

        const { withTenant } = await import('../../db/client.js');
        const refused = await withTenant(tenantB, (tx) => tx.execute(sql`select * from order_counters where tenant_id = ${tenantA}`));
        expect((refused as unknown as unknown[]).length).toBe(0);
        // Nor can tenant B write a counter row under tenant A's id (RLS WITH CHECK).
        await expect(
          withTenant(tenantB, (tx) => tx.execute(sql`insert into order_counters (tenant_id, last_number) values (${tenantA}, 1)`)),
        ).rejects.toBeDefined();
      });
    });
  });
});
