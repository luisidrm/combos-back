import { ConflictError, NotFoundError } from '../../core/errors.js';
import { db } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import { mediaService, type PublicPicture } from '../media/index.js';
import * as tenancyRepo from './tenancy.repo.js';
import type { CreateTenantInput, OpeningHours, StoreContact, Tenant, TenantSettings, UpdateTenantInput } from './tenancy.schema.js';

// What a visitor needs to tell one shop from another (CLAUDE.md section 5):
// no id, no settings, no timestamps.
export interface PublicStore {
  slug: string;
  name: string;
  taglineEs: string | null;
  taglineEn: string | null;
  descriptionEs: string | null;
  descriptionEn: string | null;
  logo: PublicPicture | null;
  // The "free delivery from $X" offer the storefront advertises (null = none).
  // Public on purpose: it is a promise made to every visitor.
  freeDeliveryOverCents: number | null;
  sameDayCutoff: string | null;
  contact: StoreContact;
  openingHours: OpeningHours | null;
}

async function resolveBySlug(slug: string): Promise<Tenant> {
  const tenant = await tenancyRepo.findBySlug(db, slug);
  if (!tenant || !tenant.active) {
    throw new NotFoundError(`No active tenant for slug "${slug}"`);
  }
  return tenant;
}

async function getById(tenantId: string): Promise<Tenant> {
  const tenant = await tenancyRepo.findById(db, tenantId);
  if (!tenant) {
    throw new NotFoundError(`No tenant with id "${tenantId}"`);
  }
  return tenant;
}

async function createTenant(input: CreateTenantInput): Promise<Tenant> {
  try {
    return await tenancyRepo.insert(db, input);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`A store with slug "${input.slug}" already exists`);
    }
    throw err;
  }
}

// For maintenance jobs, which run outside any request and so have no tenant of
// their own: they walk the active tenants and do their work inside each.
async function listActiveTenantIds(): Promise<string[]> {
  return tenancyRepo.listActiveIds(db);
}

async function toPublicStore(tenant: Tenant): Promise<PublicStore> {
  // A store's logo is a media row owned by the tenant itself: owner_id is the
  // tenant's own id (see media.schema.ts).
  const logos = await mediaService.getPublicPictures(tenant.id, 'tenant', [tenant.id]);
  return {
    slug: tenant.slug,
    name: tenant.name,
    taglineEs: tenant.taglineEs,
    taglineEn: tenant.taglineEn,
    descriptionEs: tenant.descriptionEs,
    descriptionEn: tenant.descriptionEn,
    logo: logos.get(tenant.id)?.[0] ?? null,
    ...pickPublicSettings(readSettings(tenant)),
  };
}

async function getPublicStore(tenantId: string): Promise<PublicStore> {
  return toPublicStore(await getById(tenantId));
}

function pickPublicSettings(settings: TenantSettings) {
  return {
    freeDeliveryOverCents: settings.freeDeliveryOverCents,
    sameDayCutoff: settings.sameDayCutoff,
    contact: settings.contact,
    openingHours: settings.openingHours,
  };
}

function readSettings(tenant: Tenant): TenantSettings {
  const raw = (tenant.settings ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
  return {
    requireDeliveryPhoto: raw.require_delivery_photo === true,
    freeDeliveryOverCents: typeof raw.free_delivery_over_cents === 'number' ? raw.free_delivery_over_cents : null,
    sameDayCutoff: text(raw.same_day_cutoff),
    contact: { phone: text(raw.contact_phone), email: text(raw.contact_email), address: text(raw.contact_address) },
    openingHours: Array.isArray(raw.opening_hours) ? (raw.opening_hours as OpeningHours) : null,
  };
}

async function getSettings(tenantId: string): Promise<TenantSettings> {
  return readSettings(await getById(tenantId));
}

// Branding and switches an admin controls. Only the fields sent are changed;
// `null` clears a nullable one.
async function updateStore(
  tenantId: string,
  input: UpdateTenantInput,
): Promise<PublicStore & { settings: TenantSettings }> {
  const existing = await getById(tenantId);

  const changes: Record<string, unknown> = {};
  if (input.settings?.requireDeliveryPhoto !== undefined) {
    changes.require_delivery_photo = input.settings.requireDeliveryPhoto;
  }
  if (input.settings?.freeDeliveryOverCents !== undefined) {
    changes.free_delivery_over_cents = input.settings.freeDeliveryOverCents;
  }
  if (input.settings?.sameDayCutoff !== undefined) {
    changes.same_day_cutoff = input.settings.sameDayCutoff;
  }
  if (input.settings?.openingHours !== undefined) {
    changes.opening_hours = input.settings.openingHours;
  }
  for (const key of ['phone', 'email', 'address'] as const) {
    const value = input.settings?.contact?.[key];
    if (value !== undefined) {
      changes[`contact_${key}`] = value === '' ? null : value;
    }
  }
  const mergedSettings = Object.keys(changes).length === 0 ? undefined : { ...(existing.settings as Record<string, unknown>), ...changes };

  // Fields are picked one by one, never spread: this table holds the slug
  // (a store's identity) and the active flag (whether it is served at all),
  // which an admin editing branding must never be able to reach — even if a
  // caller hands this function more than the schema allows.
  const updated =
    (await tenancyRepo.update(db, tenantId, {
      name: input.name,
      taglineEs: input.taglineEs,
      taglineEn: input.taglineEn,
      descriptionEs: input.descriptionEs,
      descriptionEn: input.descriptionEn,
      ...(mergedSettings ? { settings: mergedSettings } : {}),
    })) ?? existing;
  return { ...(await toPublicStore(updated)), settings: readSettings(updated) };
}

// The only public surface other modules may depend on (via index.ts).
export const tenancyService = {
  resolveBySlug,
  getById,
  createTenant,
  listActiveTenantIds,
  getPublicStore,
  getSettings,
  updateStore,
};
