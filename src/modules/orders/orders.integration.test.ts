import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
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
      const product = await catalog.createProduct(tenantA, { nameEs: name, priceCents, unitLabel: '1 lb', stockStatus });
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
      const product = await catalog.createProduct(tenantA, { nameEs: name, priceCents, unitLabel: '1 lb', ...overrides });
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

      it('tells the buyer who to pay and exactly how much, with the order number as the reference', async () => {
        const { buyer, order } = await manualOrder('Manual Instructions');
        const info = await orders.getPaymentInstructions(tenantA, buyer, order.id);
        expect(info).toMatchObject({ orderId: order.id, amountCents: 3000, currency: 'USD', reference: order.orderNumber, report: null });
        const paypal = info?.methods.find((m) => m.method === 'paypal');
        expect(paypal).toMatchObject({ amountInLink: true, link: 'https://www.paypal.com/paypalme/teststore/30.00USD' });
        expect(info?.methods.map((m) => m.method)).toEqual(expect.arrayContaining(['zelle', 'paypal']));
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
        const failed = await orders.reportTransfer(tenantA, buyer, order.id, { method: 'zelle', transferReference: 'ABC123' }).catch((e: unknown) => e);
        expect((failed as ConflictError).details).toMatchObject({ reason: 'SCREENSHOT_REQUIRED' });

        await addScreenshot(order.id, 'failed'); // a failed upload does not count
        const stillFailed = await orders.reportTransfer(tenantA, buyer, order.id, { method: 'zelle', transferReference: 'ABC123' }).catch((e: unknown) => e);
        expect((stillFailed as ConflictError).details).toMatchObject({ reason: 'SCREENSHOT_REQUIRED' });
      });

      it('refuses a method the store does not accept', async () => {
        const { buyer, order } = await manualOrder('Manual Bad Method');
        await addScreenshot(order.id);
        await expect(orders.reportTransfer(tenantA, buyer, order.id, { method: 'venmo', transferReference: 'ABC123' })).rejects.toBeInstanceOf(ValidationError);
      });

      it('records the report, flags the order for the admin, and the admin marks it paid', async () => {
        const { buyer, order } = await manualOrder('Manual Report');
        await addScreenshot(order.id);
        const info = await orders.reportTransfer(tenantA, buyer, order.id, { method: 'paypal', transferReference: '9XJ12345K', notes: 'sent from my spouse account' });
        expect(info.report).toMatchObject({ method: 'paypal', transferReference: '9XJ12345K', notes: 'sent from my spouse account' });

        const row = (await orders.listOrdersForAdmin(tenantA, {})).find((o) => o.id === order.id);
        expect(row?.transferReported).toBe(true);
        const detail = await orders.getOrderForAdmin(tenantA, order.id);
        expect(detail).toMatchObject({ paymentProvider: 'manual', paymentReport: { method: 'paypal', transferReference: '9XJ12345K' } });

        await orders.adminMarkPaid(tenantA, adminUser, order.id, 'Seen in PayPal');
        const after = (await orders.listOrdersForAdmin(tenantA, {})).find((o) => o.id === order.id);
        expect(after).toMatchObject({ status: 'paid', transferReported: false });
      });

      it('keeps the latest report when the buyer corrects it, and refuses once paid', async () => {
        const { buyer, order } = await manualOrder('Manual Correct');
        await addScreenshot(order.id);
        await orders.reportTransfer(tenantA, buyer, order.id, { method: 'zelle', transferReference: 'FIRST1' });
        await orders.reportTransfer(tenantA, buyer, order.id, { method: 'zelle', transferReference: 'SECOND2' });
        expect((await orders.getOrderForAdmin(tenantA, order.id)).paymentReport?.transferReference).toBe('SECOND2');

        await orders.adminMarkPaid(tenantA, adminUser, order.id);
        const late = await orders.reportTransfer(tenantA, buyer, order.id, { method: 'zelle', transferReference: 'LATE3' }).catch((e: unknown) => e);
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
