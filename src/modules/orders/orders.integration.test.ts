import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { startTestDatabase, type TestDatabase } from '../../db/testing/test-database.js';
import type { cartService as cartServiceType } from '../cart/index.js';
import type { catalogService as catalogServiceType } from '../catalog/index.js';
import type { geoService as geoServiceType } from '../geo/index.js';
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
    database = await startTestDatabase();
    adminSql = database.adminSql;

    havana = await insertProvince('LHA', 'La Habana');
    santiago = await insertProvince('SCU', 'Santiago de Cuba');
    vedado = await insertMunicipality(havana, 'Plaza de la Revolución');
    centro = await insertMunicipality(havana, 'Centro Habana');
    santiagoCity = await insertMunicipality(santiago, 'Santiago de Cuba');

    orders = (await import('./index.js')).ordersService;
    cart = (await import('../cart/index.js')).cartService;
    catalog = (await import('../catalog/index.js')).catalogService;
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
});
