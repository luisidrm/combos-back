import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { startTestDatabase, type TestDatabase } from '../../db/testing/test-database.js';
import type { geoService as geoServiceType } from './index.js';

// Delivery zones are the tenant-scoped part of geo, so this carries the
// module's required cross-tenant test (CLAUDE.md section 13). Provinces and
// municipalities are global reference data and need no isolation test.

describe('geo module', () => {
  let database: TestDatabase;
  let adminSql: postgres.Sql;
  let geo: typeof geoServiceType;

  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();

  let havana: string;
  let vedado: string;
  let centroHabana: string;
  let santiago: string;
  let santiagoCity: string;

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
    centroHabana = await insertMunicipality(havana, 'Centro Habana');
    santiagoCity = await insertMunicipality(santiago, 'Santiago de Cuba');

    geo = (await import('./index.js')).geoService;
  });

  afterAll(async () => {
    await database?.stop();
  });

  describe('reference data', () => {
    it('lists provinces alphabetically and municipalities per province', async () => {
      const provinces = await geo.listProvinces();
      expect(provinces.map((p) => p.nameEs)).toEqual(['La Habana', 'Santiago de Cuba']);

      const municipalities = await geo.listMunicipalities(havana);
      expect(municipalities.map((m) => m.nameEs)).toEqual(['Centro Habana', 'Plaza de la Revolución']);
    });

    it('404s for an unknown province', async () => {
      await expect(geo.listMunicipalities(crypto.randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    });

    it('accepts a matching province/municipality pair and rejects a mismatched or unknown one', async () => {
      await expect(geo.assertLocation(havana, vedado)).resolves.toBeUndefined();
      await expect(geo.assertLocation(santiago, vedado)).rejects.toBeInstanceOf(ValidationError);
      await expect(geo.assertLocation(havana, crypto.randomUUID())).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('delivery zones', () => {
    it('creates a zone with names attached, and refuses a second zone for the same municipality', async () => {
      const zone = await geo.createZone(tenantA, { municipalityId: vedado, feeCents: 500 });
      expect(zone).toMatchObject({
        municipalityId: vedado,
        feeCents: 500,
        active: true,
        municipality: { nameEs: 'Plaza de la Revolución' },
        province: { id: havana, nameEs: 'La Habana' },
      });

      await expect(geo.createZone(tenantA, { municipalityId: vedado, feeCents: 900 })).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it('rejects a municipality that does not exist', async () => {
      await expect(geo.createZone(tenantA, { municipalityId: crypto.randomUUID(), feeCents: 100 })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('allows a free (0-cent) zone', async () => {
      const zone = await geo.createZone(tenantA, { municipalityId: santiagoCity, feeCents: 0 });
      expect(zone.feeCents).toBe(0);
    });

    it('updates the fee and can deactivate a zone; the public list then hides it', async () => {
      const zone = await geo.createZone(tenantA, { municipalityId: centroHabana, feeCents: 700 });

      const repriced = await geo.updateZone(tenantA, zone.id, { feeCents: 650 });
      expect(repriced.feeCents).toBe(650);

      await geo.updateZone(tenantA, zone.id, { active: false });
      expect((await geo.listPublicZones(tenantA)).map((z) => z.id)).not.toContain(zone.id);
      expect((await geo.listZonesForAdmin(tenantA)).map((z) => z.id)).toContain(zone.id);
      expect(await geo.getActiveZoneForMunicipality(tenantA, centroHabana)).toBeUndefined();

      await geo.updateZone(tenantA, zone.id, { active: true });
      expect((await geo.getActiveZoneForMunicipality(tenantA, centroHabana))?.feeCents).toBe(650);
    });

    it('orders the list by province then municipality', async () => {
      const names = (await geo.listZonesForAdmin(tenantA)).map((z) => z.municipality.nameEs);
      expect(names).toEqual(['Centro Habana', 'Plaza de la Revolución', 'Santiago de Cuba']);
    });
  });

  describe('cross-tenant isolation', () => {
    it("returns nothing when tenant B reads tenant A's zones", async () => {
      expect((await geo.listZonesForAdmin(tenantA)).length).toBeGreaterThan(0);
      expect(await geo.listZonesForAdmin(tenantB)).toEqual([]);
      expect(await geo.listPublicZones(tenantB)).toEqual([]);
      expect(await geo.getActiveZoneForMunicipality(tenantB, vedado)).toBeUndefined();
    });

    it("cannot edit tenant A's zone", async () => {
      const [zone] = await geo.listZonesForAdmin(tenantA);
      if (!zone) throw new Error('expected a zone');
      await expect(geo.updateZone(tenantB, zone.id, { feeCents: 1 })).rejects.toBeInstanceOf(NotFoundError);
      expect((await geo.listZonesForAdmin(tenantA)).find((z) => z.id === zone.id)?.feeCents).toBe(zone.feeCents);
    });

    it('lets both tenants have a zone for the same municipality, at their own fee', async () => {
      const inB = await geo.createZone(tenantB, { municipalityId: vedado, feeCents: 1200 });
      expect(inB.feeCents).toBe(1200);
      expect((await geo.getActiveZoneForMunicipality(tenantA, vedado))?.feeCents).toBe(500);
    });
  });
});
