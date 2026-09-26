import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { db, withTenant } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import * as geoRepo from './geo.repo.js';
import type { CreateDeliveryZoneInput, Municipality, Province, UpdateDeliveryZoneInput } from './geo.schema.js';

export interface DeliveryZoneView {
  id: string;
  municipalityId: string;
  feeCents: number;
  active: boolean;
  municipality: { nameEs: string; nameEn: string };
  province: { id: string; nameEs: string; nameEn: string };
}

function toZoneView(row: geoRepo.DeliveryZoneRow): DeliveryZoneView {
  return {
    id: row.id,
    municipalityId: row.municipalityId,
    feeCents: row.feeCents,
    active: row.active,
    municipality: { nameEs: row.municipalityNameEs, nameEn: row.municipalityNameEn },
    province: { id: row.provinceId, nameEs: row.provinceNameEs, nameEn: row.provinceNameEn },
  };
}

// --- reference data (global) ----------------------------------------------

async function listProvinces(): Promise<Province[]> {
  return geoRepo.listProvinces(db);
}

async function listMunicipalities(provinceId: string): Promise<Municipality[]> {
  if (!(await geoRepo.findProvinceById(db, provinceId))) {
    throw new NotFoundError(`No province with id "${provinceId}"`);
  }
  return geoRepo.listMunicipalitiesByProvince(db, provinceId);
}

// For modules that store a province/municipality pair (the address book):
// both must exist and the municipality must actually be in that province,
// since the two ids are soft references there and nothing else ties them.
async function assertLocation(provinceId: string, municipalityId: string): Promise<void> {
  const municipality = await geoRepo.findMunicipalityById(db, municipalityId);
  if (!municipality || municipality.provinceId !== provinceId) {
    throw new ValidationError('The municipality does not exist or does not belong to that province');
  }
}

// --- delivery zones (per tenant) ------------------------------------------

async function listPublicZones(tenantId: string): Promise<DeliveryZoneView[]> {
  const rows = await withTenant(tenantId, (tx) => geoRepo.listZones(tx, { active: true }));
  return rows.map(toZoneView);
}

async function listZonesForAdmin(tenantId: string): Promise<DeliveryZoneView[]> {
  const rows = await withTenant(tenantId, (tx) => geoRepo.listZones(tx));
  return rows.map(toZoneView);
}

async function createZone(tenantId: string, input: CreateDeliveryZoneInput): Promise<DeliveryZoneView> {
  if (!(await geoRepo.findMunicipalityById(db, input.municipalityId))) {
    throw new NotFoundError(`No municipality with id "${input.municipalityId}"`);
  }

  try {
    return await withTenant(tenantId, async (tx) => {
      if (await geoRepo.findZoneByMunicipality(tx, input.municipalityId)) {
        throw new ConflictError('This municipality already has a delivery zone — edit that one instead');
      }
      const zone = await geoRepo.insertZone(tx, {
        tenantId,
        municipalityId: input.municipalityId,
        feeCents: input.feeCents,
        active: input.active,
      });
      const view = await geoRepo.findZoneById(tx, zone.id);
      if (!view) {
        throw new Error('Delivery zone vanished right after insert');
      }
      return toZoneView(view);
    });
  } catch (err) {
    // Two admins adding the same municipality at once.
    if (isUniqueViolation(err)) {
      throw new ConflictError('This municipality already has a delivery zone — edit that one instead');
    }
    throw err;
  }
}

// Zones are deactivated, never deleted: orders keep pointing at the zone
// they were priced against.
async function updateZone(tenantId: string, id: string, input: UpdateDeliveryZoneInput): Promise<DeliveryZoneView> {
  return withTenant(tenantId, async (tx) => {
    if (!(await geoRepo.updateZone(tx, id, input))) {
      throw new NotFoundError(`No delivery zone with id "${id}"`);
    }
    const view = await geoRepo.findZoneById(tx, id);
    if (!view) {
      throw new NotFoundError(`No delivery zone with id "${id}"`);
    }
    return toZoneView(view);
  });
}

// What checkout prices a delivery with: the active zone covering this
// municipality, or undefined when the shop doesn't deliver there.
async function getActiveZoneForMunicipality(
  tenantId: string,
  municipalityId: string,
): Promise<DeliveryZoneView | undefined> {
  const zone = await withTenant(tenantId, async (tx) => {
    const found = await geoRepo.findZoneByMunicipality(tx, municipalityId);
    return found?.active ? geoRepo.findZoneById(tx, found.id) : undefined;
  });
  return zone ? toZoneView(zone) : undefined;
}

// The only public surface other modules may import (via index.ts).
export const geoService = {
  listProvinces,
  listMunicipalities,
  assertLocation,
  listPublicZones,
  listZonesForAdmin,
  createZone,
  updateZone,
  getActiveZoneForMunicipality,
};
