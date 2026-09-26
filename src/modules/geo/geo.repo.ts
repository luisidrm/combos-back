import { and, asc, eq, ne } from 'drizzle-orm';
import type { db, Transaction } from '../../db/client.js';
import {
  deliveryZones,
  municipalities,
  provinces,
  type DeliveryZone,
  type Municipality,
  type NewDeliveryZone,
  type Province,
} from './geo.schema.js';

// All SQL for the geo module's tables lives here — nothing else touches
// them. Provinces and municipalities are global reference data, so those
// functions take the plain `db` handle (same deliberate exception as the
// tenancy repo); delivery_zones is tenant-scoped and takes `tx` first
// (CLAUDE.md section 5).

// --- global reference data ------------------------------------------------

export async function listProvinces(handle: typeof db): Promise<Province[]> {
  return handle.select().from(provinces).orderBy(asc(provinces.nameEs));
}

export async function findProvinceById(handle: typeof db, id: string): Promise<Province | undefined> {
  const [row] = await handle.select().from(provinces).where(eq(provinces.id, id)).limit(1);
  return row;
}

export async function listMunicipalitiesByProvince(handle: typeof db, provinceId: string): Promise<Municipality[]> {
  return handle
    .select()
    .from(municipalities)
    .where(eq(municipalities.provinceId, provinceId))
    .orderBy(asc(municipalities.nameEs));
}

export async function findMunicipalityById(handle: typeof db, id: string): Promise<Municipality | undefined> {
  const [row] = await handle.select().from(municipalities).where(eq(municipalities.id, id)).limit(1);
  return row;
}

// --- delivery zones (tenant-scoped) ---------------------------------------

// A zone joined to where it is, since every consumer (the storefront's
// "we deliver to..." list, the admin table) needs the names too.
export interface DeliveryZoneRow {
  id: string;
  municipalityId: string;
  feeCents: number;
  active: boolean;
  municipalityNameEs: string;
  municipalityNameEn: string;
  provinceId: string;
  provinceNameEs: string;
  provinceNameEn: string;
}

const zoneWithLocation = {
  id: deliveryZones.id,
  municipalityId: deliveryZones.municipalityId,
  feeCents: deliveryZones.feeCents,
  active: deliveryZones.active,
  municipalityNameEs: municipalities.nameEs,
  municipalityNameEn: municipalities.nameEn,
  provinceId: provinces.id,
  provinceNameEs: provinces.nameEs,
  provinceNameEn: provinces.nameEn,
};

export async function listZones(tx: Transaction, filter: { active?: boolean } = {}): Promise<DeliveryZoneRow[]> {
  return tx
    .select(zoneWithLocation)
    .from(deliveryZones)
    .innerJoin(municipalities, eq(municipalities.id, deliveryZones.municipalityId))
    .innerJoin(provinces, eq(provinces.id, municipalities.provinceId))
    .where(filter.active === undefined ? undefined : eq(deliveryZones.active, filter.active))
    .orderBy(asc(provinces.nameEs), asc(municipalities.nameEs));
}

export async function findZoneById(tx: Transaction, id: string): Promise<DeliveryZoneRow | undefined> {
  const [row] = await tx
    .select(zoneWithLocation)
    .from(deliveryZones)
    .innerJoin(municipalities, eq(municipalities.id, deliveryZones.municipalityId))
    .innerJoin(provinces, eq(provinces.id, municipalities.provinceId))
    .where(eq(deliveryZones.id, id))
    .limit(1);
  return row;
}

export async function findZoneByMunicipality(
  tx: Transaction,
  municipalityId: string,
  excludeId?: string,
): Promise<DeliveryZone | undefined> {
  const conditions = [eq(deliveryZones.municipalityId, municipalityId)];
  if (excludeId) {
    conditions.push(ne(deliveryZones.id, excludeId));
  }
  const [row] = await tx
    .select()
    .from(deliveryZones)
    .where(and(...conditions))
    .limit(1);
  return row;
}

export async function insertZone(tx: Transaction, values: NewDeliveryZone): Promise<DeliveryZone> {
  const [row] = await tx.insert(deliveryZones).values(values).returning();
  if (!row) {
    throw new Error('Insert into delivery_zones returned no row');
  }
  return row;
}

export async function updateZone(
  tx: Transaction,
  id: string,
  values: Partial<NewDeliveryZone>,
): Promise<DeliveryZone | undefined> {
  const [row] = await tx
    .update(deliveryZones)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(deliveryZones.id, id))
    .returning();
  return row;
}
