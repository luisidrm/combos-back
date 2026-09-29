import { randomBytes } from 'node:crypto';
import { ConflictError, NotFoundError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { withTenant, type Transaction } from '../../db/client.js';
import { config } from '../../config/index.js';
import { auditService } from '../audit/index.js';
import { cartService, type CartLineView, type CartView } from '../cart/index.js';
import { geoService, type DeliveryZoneView } from '../geo/index.js';
import { identityService } from '../identity/index.js';
import { paymentsService, type ProviderName } from '../payments/index.js';
import * as ordersRepo from './orders.repo.js';
import { orderStatuses } from './orders.schema.js';
import type {
  Address,
  CheckoutInput,
  QuoteInput,
  CreateAddressInput,
  CreateRecipientInput,
  NewOrderItem,
  Order,
  OrderItem,
  OrderStatus,
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

// --- placing and reading orders --------------------------------------------

export interface OrderView {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  recipientNameSnapshot: string;
  recipientPhonesSnapshot: string;
  addressSnapshot: unknown;
  giftMessage: string | null;
  buyerNotes: string | null;
  currency: string;
  subtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  placedAt: Date | null;
  paidAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
}

export interface OrderItemView {
  productId: string | null;
  productNameEs: string;
  unitLabel: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface OrderDetailView extends OrderView {
  items: OrderItemView[];
}

function toOrderView(row: Order): OrderView {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status as OrderStatus,
    recipientNameSnapshot: row.recipientNameSnapshot,
    recipientPhonesSnapshot: row.recipientPhonesSnapshot,
    addressSnapshot: row.addressSnapshot,
    giftMessage: row.giftMessage,
    buyerNotes: row.buyerNotes,
    currency: row.currency,
    subtotalCents: row.subtotalCents,
    deliveryFeeCents: row.deliveryFeeCents,
    totalCents: row.totalCents,
    placedAt: row.placedAt,
    paidAt: row.paidAt,
    deliveredAt: row.deliveredAt,
    cancelledAt: row.cancelledAt,
  };
}

function toOrderItemView(row: OrderItem): OrderItemView {
  return {
    productId: row.productId,
    productNameEs: row.productNameSnapshot,
    unitLabel: row.unitLabelSnapshot,
    unitPriceCents: row.unitPriceCents,
    quantity: row.quantity,
    lineTotalCents: row.lineTotalCents,
  };
}

// "ORD-" + 8 chars from an alphabet with no 0/O/1/I/L — a human reading it
// back over the phone (a courier confirming an order with an admin) can't
// confuse similar-looking characters.
const ORDER_NUMBER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateOrderNumber(): string {
  const bytes = randomBytes(8);
  let code = '';
  for (const byte of bytes) {
    code += ORDER_NUMBER_ALPHABET[byte % ORDER_NUMBER_ALPHABET.length];
  }
  return `ORD-${code}`;
}

async function uniqueOrderNumber(tx: Transaction): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = generateOrderNumber();
    if (!(await ordersRepo.orderNumberExists(tx, candidate))) {
      return candidate;
    }
  }
  throw new ConflictError('Could not generate a free order number');
}

// Every product on a checkout-ready cart has a non-null `product` (cart.ts
// only ever leaves `issue: null` when one is present) — this just narrows
// the type instead of trusting that invariant silently.
function requireLineProduct(line: CartLineView): NonNullable<CartLineView['product']> {
  if (!line.product) {
    throw new ConflictError('A cart line has no product despite passing checkout validation');
  }
  return line.product;
}

async function requireOrderForBuyer(tx: Transaction, buyerUserId: string, orderId: string): Promise<Order> {
  const order = await ordersRepo.findForBuyer(tx, buyerUserId, orderId);
  if (!order) {
    throw new NotFoundError(`No order with id "${orderId}"`);
  }
  return order;
}

async function requireOrder(tx: Transaction, orderId: string): Promise<Order> {
  const order = await ordersRepo.findById(tx, orderId);
  if (!order) {
    throw new NotFoundError(`No order with id "${orderId}"`);
  }
  return order;
}

// Places the order: recipient/address/cart are re-validated, then the order,
// its line-item snapshots, a pending payment row, and the audit entry all
// commit in one transaction (CLAUDE.md section 6's "order + payment + audit
// log in one transaction"). The provider is only called AFTER that commits —
// a slow external HTTP call has no business holding the transaction open,
// and if it fails the order still exists in pending_payment for the buyer to
// retry (see retryPayment) rather than vanishing.
async function checkout(
  tenantId: string,
  buyerUserId: string,
  input: CheckoutInput,
): Promise<{ order: OrderDetailView; checkoutUrl: string | null }> {
  const priced = await quote(tenantId, buyerUserId, { recipientId: input.recipientId, addressId: input.addressId });
  if (!priced.canCheckout || !priced.delivery) {
    throw new ConflictError('This cart cannot be checked out yet', { reason: priced.blockers[0] ?? 'CART_HAS_ISSUES', blockers: priced.blockers });
  }

  const { order, items, paymentId } = await withTenant(tenantId, async (tx) => {
    // Re-checked here, not just by the quote() call above: a soft-deleted
    // address still satisfies orders.address_id's FK (the row isn't gone,
    // only flagged), so only an explicit check — not the database — catches
    // a delete that lands in the gap between pricing and this transaction.
    await requireRecipient(tx, buyerUserId, input.recipientId);
    const address = await ordersRepo.findAddress(tx, input.recipientId, input.addressId);
    if (!address) {
      throw new NotFoundError(`No address with id "${input.addressId}"`);
    }
    const recipient = await requireRecipient(tx, buyerUserId, input.recipientId);

    const orderNumber = await uniqueOrderNumber(tx);
    const insertedOrder = await ordersRepo.insertOrder(tx, {
      tenantId,
      orderNumber,
      buyerUserId,
      recipientId: recipient.id,
      addressId: address.id,
      recipientNameSnapshot: recipient.fullName,
      recipientPhonesSnapshot: [recipient.phone1, recipient.phone2].filter(Boolean).join(', '),
      addressSnapshot: toAddressView(address),
      deliveryZoneId: priced.delivery?.id as string,
      giftMessage: input.giftMessage,
      buyerNotes: input.buyerNotes,
      // The platform's base currency is USD end to end today (CLAUDE.md
      // section 1/5) — no conversion happens, so the rate is the identity
      // rate. currency_rates/rate_used exist in the schema for when a
      // non-USD price list is introduced; nothing populates them yet.
      currency: 'USD',
      rateUsed: '1.000000',
      subtotalCents: priced.subtotalCents,
      deliveryFeeCents: priced.deliveryFeeCents,
      totalCents: priced.totalCents,
      status: 'pending_payment',
      placedAt: new Date(),
    });

    const itemValues: NewOrderItem[] = priced.cart.items.map((line) => {
      const product = requireLineProduct(line);
      return {
        tenantId,
        orderId: insertedOrder.id,
        productId: line.productId,
        productNameSnapshot: product.nameEs,
        unitLabelSnapshot: product.unitLabel,
        unitPriceCents: product.unitPriceCents,
        quantity: line.quantity,
        lineTotalCents: line.lineTotalCents,
      };
    });
    const insertedItems = await ordersRepo.insertOrderItems(tx, itemValues);

    await auditService.record(tx, {
      tenantId,
      actorUserId: buyerUserId,
      entityType: 'order',
      entityId: insertedOrder.id,
      action: 'order.placed',
    });

    const payment = await paymentsService.createPendingPayment(tx, {
      tenantId,
      orderId: insertedOrder.id,
      provider: input.provider,
      amountCents: insertedOrder.totalCents,
      currency: insertedOrder.currency,
    });
    await auditService.record(tx, {
      tenantId,
      actorUserId: buyerUserId,
      entityType: 'payment',
      entityId: payment.id,
      action: 'payment.created',
      note: input.provider,
    });

    return { order: insertedOrder, items: insertedItems, paymentId: payment.id };
  });

  const checkoutUrl = await startProviderCheckout(tenantId, buyerUserId, order, input.provider, paymentId);

  // Best-effort: the order is already the source of truth regardless of
  // whether this succeeds (CLAUDE.md's cart module note on merge — the same
  // "server cart is authoritative" idea applies here in reverse: placing an
  // order need not wait on tidying up the cart that produced it).
  await cartService.clearCart(tenantId, { userId: buyerUserId }).catch((err: unknown) => {
    logger.warn({ err, orderId: order.id }, 'Order placed, but clearing the cart afterwards failed');
  });

  return { order: { ...toOrderView(order), items: items.map(toOrderItemView) }, checkoutUrl };
}

// The external call, kept out of the checkout transaction above. Failure
// here is not a checkout failure — the order and its pending payment already
// exist; the buyer sees a null checkoutUrl and can retry via retryPayment.
async function startProviderCheckout(
  tenantId: string,
  buyerUserId: string,
  order: Order,
  provider: ProviderName,
  paymentId: string,
): Promise<string | null> {
  try {
    const buyer = await identityService.getById(tenantId, buyerUserId);
    const session = await paymentsService.getProvider(provider).createCheckout({
      paymentId,
      tenantId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountCents: order.totalCents,
      currency: order.currency,
      description: `Order ${order.orderNumber}`,
      buyerEmail: buyer.email,
      returnUrl: `${config.webBaseUrl}/orders/${order.id}?payment=success`,
      cancelUrl: `${config.webBaseUrl}/orders/${order.id}?payment=cancelled`,
    });
    await withTenant(tenantId, (tx) => paymentsService.attachExternalId(tx, paymentId, session.externalPaymentId));
    return session.redirectUrl || null;
  } catch (err) {
    logger.error({ err, orderId: order.id, provider }, 'Could not start the payment provider checkout');
    return null;
  }
}

async function getOrderForBuyer(tenantId: string, buyerUserId: string, orderId: string): Promise<OrderDetailView> {
  return withTenant(tenantId, async (tx) => {
    const order = await requireOrderForBuyer(tx, buyerUserId, orderId);
    const items = await ordersRepo.listItems(tx, orderId);
    return { ...toOrderView(order), items: items.map(toOrderItemView) };
  });
}

async function listOrdersForBuyer(tenantId: string, buyerUserId: string): Promise<OrderView[]> {
  const rows = await withTenant(tenantId, (tx) => ordersRepo.listForBuyer(tx, buyerUserId));
  return rows.map(toOrderView);
}

async function getOrderForAdmin(tenantId: string, orderId: string): Promise<OrderDetailView> {
  return withTenant(tenantId, async (tx) => {
    const order = await requireOrder(tx, orderId);
    const items = await ordersRepo.listItems(tx, orderId);
    return { ...toOrderView(order), items: items.map(toOrderItemView) };
  });
}

async function listOrdersForAdmin(tenantId: string, filter: { status?: OrderStatus }): Promise<OrderView[]> {
  const rows = await withTenant(tenantId, (tx) => ordersRepo.listForAdmin(tx, filter));
  return rows.map(toOrderView);
}

// Re-attempts starting a checkout session for an order whose payment is
// still pending — the first attempt's external call can fail (network blip,
// provider outage) independently of the order itself, which is why it isn't
// rolled back when that happens.
async function retryPayment(tenantId: string, buyerUserId: string, orderId: string): Promise<{ checkoutUrl: string | null }> {
  const order = await withTenant(tenantId, (tx) => requireOrderForBuyer(tx, buyerUserId, orderId));
  if (order.status !== 'pending_payment') {
    throw new ConflictError('Only an order still waiting for payment can be retried', { reason: 'NOT_PENDING_PAYMENT' });
  }
  const payment = await withTenant(tenantId, (tx) => paymentsService.getLatestForOrder(tx, orderId));
  const checkoutUrl = await startProviderCheckout(tenantId, buyerUserId, order, payment.provider as ProviderName, payment.id);
  return { checkoutUrl };
}

// --- the state machine ------------------------------------------------------
//
// Legal transitions live here, in one module (CLAUDE.md section 6) — never
// scattered across routes. Every transition writes to audit_log with the
// actor and a timestamp; setting the right column is data, not policy, and
// stays entirely inside this table.
const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ['paid', 'cancelled'],
  paid: ['preparing', 'refunded'],
  preparing: ['out_for_delivery', 'refunded'],
  out_for_delivery: ['delivered', 'refunded'],
  delivered: ['refunded'],
  cancelled: [],
  refunded: [],
};

// Internal — every public transition below goes through this, inside its own
// withTenant. Idempotent on purpose: an order already at `toStatus` is
// returned as-is rather than erroring, because both the payment webhook and
// the reconciliation job can observe "this is now paid" more than once
// (a retried webhook delivery, or a webhook arriving just after
// reconciliation's own poll already caught it) and neither should treat the
// second observation as a problem.
async function transition(
  tx: Transaction,
  tenantId: string,
  orderId: string,
  toStatus: OrderStatus,
  actorUserId: string | undefined,
  note?: string,
): Promise<Order> {
  const order = await requireOrder(tx, orderId);
  if (order.status === toStatus) {
    return order;
  }
  const allowed = ALLOWED_TRANSITIONS[order.status as OrderStatus];
  if (!allowed.includes(toStatus)) {
    throw new ConflictError(`Cannot move an order from "${order.status}" to "${toStatus}"`, {
      reason: 'ILLEGAL_TRANSITION',
      from: order.status,
      to: toStatus,
      allowed,
    });
  }

  const timestamps: Partial<Record<'paidAt' | 'deliveredAt' | 'cancelledAt', Date>> = {};
  if (toStatus === 'paid') timestamps.paidAt = new Date();
  if (toStatus === 'delivered') timestamps.deliveredAt = new Date();
  if (toStatus === 'cancelled') timestamps.cancelledAt = new Date();

  const updated = await ordersRepo.updateStatus(tx, orderId, { status: toStatus, ...timestamps });
  if (!updated) {
    throw new NotFoundError(`No order with id "${orderId}"`);
  }
  await auditService.record(tx, {
    tenantId,
    actorUserId,
    entityType: 'order',
    entityId: orderId,
    action: `order.${toStatus}`,
    note,
  });
  return updated;
}

// A buyer may only back out before paying — after that, cancelling money
// that has already changed hands is a refund, not a cancel (see the
// transition table above), and refunds are an admin action.
async function cancelByBuyer(tenantId: string, buyerUserId: string, orderId: string, note?: string): Promise<OrderView> {
  return withTenant(tenantId, async (tx) => {
    await requireOrderForBuyer(tx, buyerUserId, orderId);
    return toOrderView(await transition(tx, tenantId, orderId, 'cancelled', buyerUserId, note));
  });
}

async function adminCancel(tenantId: string, actorUserId: string, orderId: string, note?: string): Promise<OrderView> {
  return withTenant(tenantId, async (tx) => toOrderView(await transition(tx, tenantId, orderId, 'cancelled', actorUserId, note)));
}

// An operator's manual override for "I can see in my own banking/TropiPay
// dashboard that this was paid" — regardless of provider, not only manual
// transfer, since a missed webhook is exactly the kind of gap this exists to
// cover. Flips the payment row alongside the order, in one transaction.
async function adminMarkPaid(tenantId: string, actorUserId: string, orderId: string, note?: string): Promise<OrderView> {
  return withTenant(tenantId, async (tx) => {
    const order = await transition(tx, tenantId, orderId, 'paid', actorUserId, note ?? 'Confirmed by admin');
    const payment = await paymentsService.getLatestForOrder(tx, orderId);
    if (payment.status !== 'paid') {
      await paymentsService.markStatus(tx, payment.id, 'paid');
    }
    return toOrderView(order);
  });
}

async function adminMarkPreparing(tenantId: string, actorUserId: string, orderId: string, note?: string): Promise<OrderView> {
  return withTenant(tenantId, async (tx) => toOrderView(await transition(tx, tenantId, orderId, 'preparing', actorUserId, note)));
}

// Full refund only for M3 — the amount is always the order's own total.
// Calls the provider OUTSIDE the transaction (same reasoning as checkout's
// external call) and only writes anything once it confirms.
async function refund(tenantId: string, actorUserId: string, orderId: string, note?: string): Promise<OrderView> {
  const order = await withTenant(tenantId, (tx) => requireOrder(tx, orderId));
  if (!ALLOWED_TRANSITIONS[order.status as OrderStatus].includes('refunded')) {
    throw new ConflictError(`An order in status "${order.status}" cannot be refunded`, { reason: 'ILLEGAL_TRANSITION' });
  }
  const payment = await withTenant(tenantId, (tx) => paymentsService.getLatestForOrder(tx, orderId));

  const provider = paymentsService.getProvider(payment.provider);
  const result = await provider.refund(payment.externalPaymentId ?? payment.id, order.totalCents);
  if (result.status === 'failed') {
    throw new ConflictError('The payment provider refused the refund');
  }

  return withTenant(tenantId, async (tx) => {
    await paymentsService.markStatus(tx, payment.id, 'refunded');
    return toOrderView(await transition(tx, tenantId, orderId, 'refunded', actorUserId, note));
  });
}

// --- reacting to confirmed payments (event bus subscriber) ------------------
//
// payments.service verifies and records the webhook itself, then emits
// payment.paid/payment.refunded — orders reacts here, in the worker process
// (registerOrdersWorker), rather than payments.routes calling into orders
// directly: the two modules would otherwise import each other's service
// (orders needs paymentsService for checkout/refund; payments would need
// ordersService here), which is exactly the cross-module cycle CLAUDE.md
// section 4 says to avoid with the event bus instead of a direct call.
async function handlePaymentConfirmed(tenantId: string, orderId: string): Promise<void> {
  await withTenant(tenantId, (tx) => transition(tx, tenantId, orderId, 'paid', undefined, 'Confirmed by payment provider'));
}

async function handlePaymentRefunded(tenantId: string, orderId: string): Promise<void> {
  await withTenant(tenantId, (tx) => transition(tx, tenantId, orderId, 'refunded', undefined, 'Refunded by payment provider'));
}

// --- reconciliation (CLAUDE.md section 6) -----------------------------------
//
// Run periodically per tenant by the worker process. Orders past 24h still
// pending_payment get a status poll (self-healing a missed webhook); ones
// past 72h are auto-cancelled. Manual transfer has nothing to poll — its
// status only ever changes via an admin action — so it skips straight to
// the age check.
const RECONCILE_POLL_AFTER_HOURS = 24;
const RECONCILE_CANCEL_AFTER_HOURS = 72;

export interface ReconciliationResult {
  checked: number;
  selfHealed: number;
  cancelled: number;
}

async function reconcilePendingPayments(tenantId: string, now: Date = new Date()): Promise<ReconciliationResult> {
  const pollCutoff = new Date(now.getTime() - RECONCILE_POLL_AFTER_HOURS * 60 * 60 * 1000);
  const cancelCutoff = new Date(now.getTime() - RECONCILE_CANCEL_AFTER_HOURS * 60 * 60 * 1000);

  const stale = await withTenant(tenantId, (tx) => ordersRepo.findStalePendingPayment(tx, pollCutoff));
  let selfHealed = 0;
  let cancelled = 0;

  for (const order of stale) {
    try {
      const payment = await withTenant(tenantId, (tx) => paymentsService.getLatestForOrder(tx, order.id));

      if (payment.provider !== 'manual' && payment.externalPaymentId) {
        try {
          const status = await paymentsService.getProvider(payment.provider).getStatus(payment.externalPaymentId);
          if (status === 'paid') {
            await withTenant(tenantId, async (tx) => {
              await paymentsService.markStatus(tx, payment.id, 'paid');
              await transition(tx, tenantId, order.id, 'paid', undefined, 'Self-healed by reconciliation');
            });
            selfHealed += 1;
            continue;
          }
        } catch (err) {
          logger.warn({ err, orderId: order.id, provider: payment.provider }, 'Reconciliation could not poll provider status');
        }
      }

      if (order.placedAt && order.placedAt < cancelCutoff) {
        await withTenant(tenantId, async (tx) => {
          await paymentsService.markStatus(tx, payment.id, 'failed');
          await transition(tx, tenantId, order.id, 'cancelled', undefined, 'Auto-cancelled: never paid within 72h');
        });
        cancelled += 1;
      }
    } catch (err) {
      // One order's failure must not stop the rest of the tenant's batch.
      logger.error({ err, orderId: order.id }, 'Reconciliation failed for an order');
    }
  }

  return { checked: stale.length, selfHealed, cancelled };
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
  checkout,
  getOrderForBuyer,
  listOrdersForBuyer,
  getOrderForAdmin,
  listOrdersForAdmin,
  retryPayment,
  cancelByBuyer,
  adminCancel,
  adminMarkPaid,
  adminMarkPreparing,
  refund,
  handlePaymentConfirmed,
  handlePaymentRefunded,
  reconcilePendingPayments,
};

// Exported for the worker's registration and for tests that need the full
// status list without importing orders.schema directly.
export { orderStatuses };
