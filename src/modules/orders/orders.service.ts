import { NotFoundError } from '../../core/errors.js';
import { withTenant, type Transaction } from '../../db/client.js';
import { cartService, type CartView } from '../cart/index.js';
import { geoService, type DeliveryZoneView } from '../geo/index.js';
import * as ordersRepo from './orders.repo.js';
import type {
  Address,
  QuoteInput,
  CreateAddressInput,
  CreateRecipientInput,
  Recipient,
  UpdateAddressInput,
  UpdateRecipientInput,
} from './orders.schema.js';

// --- the address book (recipients + addresses) ----------------------------
//
// Owned by the buyer: every function takes their internal users.id and
// only ever touches rows carrying it. The order state machine will join
// this file later; today it is just the address book.

export interface AddressView {
  id: string;
  label: string | null;
  isDefault: boolean;
  provinceId: string;
  municipalityId: string;
  street: string;
  betweenStreets: string | null;
  buildingApartment: string | null;
  referencePoints: string | null;
  lat: number | null;
  lng: number | null;
}

export interface RecipientView {
  id: string;
  fullName: string;
  phone1: string;
  phone2: string | null;
  addresses: AddressView[];
}

function toAddressView(row: Address): AddressView {
  return {
    id: row.id,
    label: row.label,
    isDefault: row.isDefault,
    provinceId: row.provinceId,
    municipalityId: row.municipalityId,
    street: row.street,
    betweenStreets: row.betweenStreets,
    buildingApartment: row.buildingApartment,
    referencePoints: row.referencePoints,
    // numeric columns come back from the driver as strings.
    lat: row.lat === null ? null : Number(row.lat),
    lng: row.lng === null ? null : Number(row.lng),
  };
}

function toRecipientView(row: Recipient, addressRows: Address[]): RecipientView {
  return {
    id: row.id,
    fullName: row.fullName,
    phone1: row.phone1,
    phone2: row.phone2,
    addresses: addressRows.map(toAddressView),
  };
}

// The address columns an input may set. Explicit rather than spread so a
// stray field (isDefault, which has its own rules) can never leak into an
// insert or update. lat/lng are stored as numeric, which the driver takes
// as strings.
function addressColumns(input: UpdateAddressInput) {
  const { lat, lng } = input;
  return {
    label: input.label,
    provinceId: input.provinceId,
    municipalityId: input.municipalityId,
    street: input.street,
    betweenStreets: input.betweenStreets,
    buildingApartment: input.buildingApartment,
    referencePoints: input.referencePoints,
    lat: lat === undefined ? undefined : lat === null ? null : lat.toFixed(6),
    lng: lng === undefined ? undefined : lng === null ? null : lng.toFixed(6),
  };
}

async function requireRecipient(tx: Transaction, buyerUserId: string, recipientId: string): Promise<Recipient> {
  const recipient = await ordersRepo.findRecipient(tx, buyerUserId, recipientId);
  if (!recipient) {
    throw new NotFoundError(`No recipient with id "${recipientId}"`);
  }
  return recipient;
}

async function viewOf(tx: Transaction, recipient: Recipient): Promise<RecipientView> {
  return toRecipientView(recipient, await ordersRepo.listAddressesForRecipients(tx, [recipient.id]));
}

async function listRecipients(tenantId: string, buyerUserId: string): Promise<RecipientView[]> {
  return withTenant(tenantId, async (tx) => {
    const recipients = await ordersRepo.listRecipients(tx, buyerUserId);
    const addresses = await ordersRepo.listAddressesForRecipients(
      tx,
      recipients.map((recipient) => recipient.id),
    );
    return recipients.map((recipient) =>
      toRecipientView(
        recipient,
        addresses.filter((address) => address.recipientId === recipient.id),
      ),
    );
  });
}

async function getRecipient(tenantId: string, buyerUserId: string, recipientId: string): Promise<RecipientView> {
  return withTenant(tenantId, async (tx) => viewOf(tx, await requireRecipient(tx, buyerUserId, recipientId)));
}

async function createRecipient(
  tenantId: string,
  buyerUserId: string,
  input: CreateRecipientInput,
): Promise<RecipientView> {
  if (input.address) {
    await geoService.assertLocation(input.address.provinceId, input.address.municipalityId);
  }

  return withTenant(tenantId, async (tx) => {
    const recipient = await ordersRepo.insertRecipient(tx, {
      tenantId,
      buyerUserId,
      fullName: input.fullName,
      phone1: input.phone1,
      phone2: input.phone2,
    });

    if (input.address) {
      await ordersRepo.insertAddress(tx, {
        ...addressColumns(input.address),
        street: input.address.street,
        provinceId: input.address.provinceId,
        municipalityId: input.address.municipalityId,
        tenantId,
        recipientId: recipient.id,
        // A recipient's first address is always their default.
        isDefault: true,
      });
    }
    return viewOf(tx, recipient);
  });
}

async function updateRecipient(
  tenantId: string,
  buyerUserId: string,
  recipientId: string,
  input: UpdateRecipientInput,
): Promise<RecipientView> {
  return withTenant(tenantId, async (tx) => {
    const existing = await requireRecipient(tx, buyerUserId, recipientId);
    const updated = (await ordersRepo.updateRecipient(tx, buyerUserId, recipientId, input)) ?? existing;
    return viewOf(tx, updated);
  });
}

// Soft delete: past orders keep pointing at this recipient and address.
async function deleteRecipient(tenantId: string, buyerUserId: string, recipientId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    if (!(await ordersRepo.softDeleteRecipient(tx, buyerUserId, recipientId))) {
      throw new NotFoundError(`No recipient with id "${recipientId}"`);
    }
    await ordersRepo.softDeleteAddressesOfRecipient(tx, recipientId);
  });
}

async function addAddress(
  tenantId: string,
  buyerUserId: string,
  recipientId: string,
  input: CreateAddressInput,
): Promise<AddressView> {
  await geoService.assertLocation(input.provinceId, input.municipalityId);

  return withTenant(tenantId, async (tx) => {
    await requireRecipient(tx, buyerUserId, recipientId);

    const isFirst = (await ordersRepo.countAddresses(tx, recipientId)) === 0;
    const makeDefault = isFirst || input.isDefault === true;
    if (makeDefault) {
      await ordersRepo.clearDefaultAddress(tx, recipientId);
    }

    const row = await ordersRepo.insertAddress(tx, {
      ...addressColumns(input),
      street: input.street,
      provinceId: input.provinceId,
      municipalityId: input.municipalityId,
      tenantId,
      recipientId,
      isDefault: makeDefault,
    });
    return toAddressView(row);
  });
}

async function updateAddress(
  tenantId: string,
  buyerUserId: string,
  recipientId: string,
  addressId: string,
  input: UpdateAddressInput,
): Promise<AddressView> {
  return withTenant(tenantId, async (tx) => {
    await requireRecipient(tx, buyerUserId, recipientId);
    const existing = await ordersRepo.findAddress(tx, recipientId, addressId);
    if (!existing) {
      throw new NotFoundError(`No address with id "${addressId}"`);
    }

    // Changing either half of the province/municipality pair must leave a
    // pair that still matches — check the result, not just the input.
    if (input.provinceId !== undefined || input.municipalityId !== undefined) {
      await geoService.assertLocation(
        input.provinceId ?? existing.provinceId,
        input.municipalityId ?? existing.municipalityId,
      );
    }

    const updated = await ordersRepo.updateAddress(tx, recipientId, addressId, addressColumns(input));
    return toAddressView(updated ?? existing);
  });
}

async function setDefaultAddress(
  tenantId: string,
  buyerUserId: string,
  recipientId: string,
  addressId: string,
): Promise<RecipientView> {
  return withTenant(tenantId, async (tx) => {
    const recipient = await requireRecipient(tx, buyerUserId, recipientId);
    if (!(await ordersRepo.findAddress(tx, recipientId, addressId))) {
      throw new NotFoundError(`No address with id "${addressId}"`);
    }
    await ordersRepo.clearDefaultAddress(tx, recipientId);
    await ordersRepo.updateAddress(tx, recipientId, addressId, { isDefault: true });
    return viewOf(tx, recipient);
  });
}

async function deleteAddress(
  tenantId: string,
  buyerUserId: string,
  recipientId: string,
  addressId: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await requireRecipient(tx, buyerUserId, recipientId);
    const existing = await ordersRepo.findAddress(tx, recipientId, addressId);
    if (!existing) {
      throw new NotFoundError(`No address with id "${addressId}"`);
    }
    await ordersRepo.softDeleteAddress(tx, recipientId, addressId);

    // Never leave a recipient with addresses but no default.
    if (existing.isDefault) {
      const next = await ordersRepo.findOldestAddress(tx, recipientId);
      if (next) {
        await ordersRepo.updateAddress(tx, recipientId, next.id, { isDefault: true });
      }
    }
  });
}

// --- pricing a checkout before it is placed -------------------------------

export type QuoteBlocker = 'EMPTY_CART' | 'CART_HAS_ISSUES' | 'NO_DELIVERY_ZONE';

export interface Quote {
  cart: CartView;
  // The zone this address falls in, or null when the store doesn't deliver there.
  delivery: DeliveryZoneView | null;
  subtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  currency: 'USD';
  // True only when nothing stands in the way of placing the order.
  canCheckout: boolean;
  blockers: QuoteBlocker[];
}

// "Cart total = subtotal + zone fee" (CLAUDE.md section 10): the cart as it
// stands right now, plus the flat fee of the zone covering the chosen
// address. Read-only — nothing is reserved or created; the order itself (and
// its frozen snapshot) is M3. Also the single place that says WHY a checkout
// can't go ahead, so the UI can explain instead of just disabling a button.
async function quote(tenantId: string, buyerUserId: string, input: QuoteInput): Promise<Quote> {
  const municipalityId = await withTenant(tenantId, async (tx) => {
    await requireRecipient(tx, buyerUserId, input.recipientId);
    const address = await ordersRepo.findAddress(tx, input.recipientId, input.addressId);
    if (!address) {
      throw new NotFoundError(`No address with id "${input.addressId}"`);
    }
    return address.municipalityId;
  });

  const cart = await cartService.getCart(tenantId, { userId: buyerUserId });
  const delivery = (await geoService.getActiveZoneForMunicipality(tenantId, municipalityId)) ?? null;

  const blockers: QuoteBlocker[] = [];
  if (cart.items.length === 0) {
    blockers.push('EMPTY_CART');
  } else if (!cart.checkoutReady) {
    blockers.push('CART_HAS_ISSUES');
  }
  if (!delivery) {
    blockers.push('NO_DELIVERY_ZONE');
  }

  // Without a zone there is no fee to charge, so the total is just the
  // subtotal — but canCheckout is false, so it is never charged.
  const deliveryFeeCents = delivery?.feeCents ?? 0;
  return {
    cart,
    delivery,
    subtotalCents: cart.subtotalCents,
    deliveryFeeCents,
    totalCents: cart.subtotalCents + deliveryFeeCents,
    currency: 'USD',
    canCheckout: blockers.length === 0,
    blockers,
  };
}

// The only public surface other modules may import (via index.ts).
export const ordersService = {
  quote,
  listRecipients,
  getRecipient,
  createRecipient,
  updateRecipient,
  deleteRecipient,
  addAddress,
  updateAddress,
  setDefaultAddress,
  deleteAddress,
};
