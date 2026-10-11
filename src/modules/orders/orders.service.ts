import { randomBytes, randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { events } from '../../core/events.js';
import { logger } from '../../core/logger.js';
import { withTenant, type Transaction } from '../../db/client.js';
import { collectAll, decodeCursor, toPage, type Page, type PageQuery } from '../../core/pagination.js';
import { isUniqueViolation } from '../../db/errors.js';
import { config } from '../../config/index.js';
import { auditService } from '../audit/index.js';
import { catalogService } from '../catalog/index.js';
import { cartService, type CartLineView, type CartView } from '../cart/index.js';
import { geoService, type DeliveryZoneView } from '../geo/index.js';
import { identityService } from '../identity/index.js';
import { mediaService } from '../media/index.js';
import { paymentsService, type ManualMethodView, type ProviderName, type TransferReport } from '../payments/index.js';
import { tenancyService } from '../tenancy/index.js';
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
  neighborhood: string | null;
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
    neighborhood: row.neighborhood,
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
    neighborhood: input.neighborhood,
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
  const { freeDeliveryOverCents } = await tenancyService.getSettings(tenantId);

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
  // The store's "free delivery from $X" offer waives the zone fee.
  const freeDelivery = freeDeliveryOverCents !== null && cart.subtotalCents >= freeDeliveryOverCents;
  const deliveryFeeCents = freeDelivery ? 0 : (delivery?.feeCents ?? 0);
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
  // Both null on orders placed before they were recorded.
  productNameEn: string | null;
  productThumbUrl: string | null;
  unitLabel: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

// The admin queue shows who bought and how much was in the box, which a buyer's own view does not need.
export interface BuyerSummary {
  fullName: string | null;
  email: string;
  /** So the store can message the buyer on WhatsApp. */
  phone: string | null;
  /** The language their emails are written in. */
  locale: 'es' | 'en';
}
export interface AdminOrderListItem extends OrderView {
  buyer: BuyerSummary | null;
  itemCount: number;
  /** A manual transfer the buyer says they sent, still waiting for someone to check it. */
  transferReported: boolean;
}

// What an admin sees on one order beyond the buyer's own view: who bought, how it is being paid, and
// what the buyer reported for a manual transfer (the screenshots are read through /media/manage).
export type AdminOrderDetail = OrderDetailView & {
  /** The buyer's user id (for the notifications module to reach them). */
  buyerUserId: string;
  buyer: BuyerSummary | null;
  paymentProvider: string | null;
  paymentReport: TransferReport | null;
};

// How to pay a manual-transfer order: who to pay, exactly how much, and the reference to quote.
export interface PaymentInstructions {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  amountCents: number;
  currency: string;
  /** Goes in the transfer's note so the store can match the money to the order. */
  reference: string;
  methods: ManualMethodView[];
  /** The latest report the buyer sent, if any. */
  report: TransferReport | null;
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
    productNameEn: row.productNameEnSnapshot,
    productThumbUrl: row.productThumbUrlSnapshot,
    unitLabel: row.unitLabelSnapshot,
    unitPriceCents: row.unitPriceCents,
    quantity: row.quantity,
    lineTotalCents: row.lineTotalCents,
  };
}

// Human-readable, per-store, sequential: FC-1001, FC-1002, ... The counter row is
// bumped inside the checkout transaction, so two concurrent checkouts serialize on
// it (never the same number) and a rolled-back checkout gives its number back.
async function nextOrderNumber(tx: Transaction, tenantId: string): Promise<string> {
  return `FC-${await ordersRepo.nextOrderNumber(tx, tenantId)}`;
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
  // The same attempt sent twice (a double click, a retry after a dropped connection) gets the order it already made.
  // Checked before pricing, because by then the first attempt has emptied the cart and pricing would refuse.
  const replay = async (): Promise<{ order: OrderDetailView; checkoutUrl: string | null } | null> => {
    if (!input.idempotencyKey) return null;
    const existing = await withTenant(tenantId, (tx) => ordersRepo.findByCheckoutKey(tx, buyerUserId, input.idempotencyKey as string));
    if (!existing) return null;
    // A payment link is not remade: the buyer is shown the order, where "pay" can be retried.
    return { order: await getOrderForBuyer(tenantId, buyerUserId, existing.id), checkoutUrl: null };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const priced = await quote(tenantId, buyerUserId, { recipientId: input.recipientId, addressId: input.addressId });
  if (!priced.canCheckout || !priced.delivery) {
    throw new ConflictError('This cart cannot be checked out yet', { reason: priced.blockers[0] ?? 'CART_HAS_ISSUES', blockers: priced.blockers });
  }

  let created: { order: Order; items: OrderItem[]; paymentId: string };
  try {
    created = await withTenant(tenantId, async (tx) => {
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

      const orderNumber = await nextOrderNumber(tx, tenantId);
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
        checkoutKey: input.idempotencyKey,
      });

      const itemValues: NewOrderItem[] = priced.cart.items.map((line) => {
        const product = requireLineProduct(line);
        return {
          tenantId,
          orderId: insertedOrder.id,
          productId: line.productId,
          productNameSnapshot: product.nameEs,
          productNameEnSnapshot: product.nameEn,
          productThumbUrlSnapshot: product.picture?.thumbUrl ?? null,
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
  } catch (err) {
    // Two requests with the same key arrived together: both passed the check above, the unique index let one
    // through. The loser returns what the winner made.
    if (input.idempotencyKey && isUniqueViolation(err)) {
      const winner = await replay();
      if (winner) return winner;
    }
    throw err;
  }
  const { order, items, paymentId } = created;
  // "We received your order": only for a checkout that really placed one (a replayed key returned above).
  await announceStatus(tenantId, order.id, 'pending_payment');

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
      returnUrl: `${config.webBaseUrl}/account/orders/${order.id}?payment=success`,
      cancelUrl: `${config.webBaseUrl}/account/orders/${order.id}?payment=cancelled`,
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

// A cursor from the client says where the last page ended: [created_at (text, microseconds), order id]. Checked here
// because both go straight into SQL casts, and a hand-edited cursor must be a 400, never a database error.
const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function orderCursor(cursor: string | undefined): [string, string] | undefined {
  if (!cursor) return undefined;
  const [at, id] = decodeCursor(cursor, 2).map(String) as [string, string];
  if (!ISO_MICROS.test(at) || !UUID.test(id)) {
    throw new ValidationError('That page cursor is not valid', { reason: 'BAD_CURSOR' });
  }
  return [at, id];
}
const orderCursorOf = (row: ordersRepo.OrderRow): string[] => [row.cursorAt, row.id];

// One page of a buyer's own orders, newest first.
async function pageOrdersForBuyer(
  tenantId: string,
  buyerUserId: string,
  page: PageQuery,
  scope?: 'active' | 'past',
): Promise<Page<OrderView>> {
  const after = orderCursor(page.cursor);
  const finished = ['delivered', 'cancelled', 'refunded'];
  const statuses = scope === 'active' ? { notIn: finished } : scope === 'past' ? { in: finished } : undefined;
  const rows = await withTenant(tenantId, (tx) => ordersRepo.pageForBuyer(tx, buyerUserId, { limit: page.limit + 1, after }, statuses));
  const result = toPage(rows, page.limit, orderCursorOf);
  return { items: result.items.map(toOrderView), nextCursor: result.nextCursor };
}

// Every order of a buyer (internal callers and tests; the API serves pages).
async function listOrdersForBuyer(tenantId: string, buyerUserId: string): Promise<OrderView[]> {
  return collectAll((cursor) => pageOrdersForBuyer(tenantId, buyerUserId, { limit: 100, cursor }));
}

async function getOrderForAdmin(tenantId: string, orderId: string): Promise<AdminOrderDetail> {
  const { order, items, payment, reports } = await withTenant(tenantId, async (tx) => {
    const found = await requireOrder(tx, orderId);
    return {
      order: found,
      items: await ordersRepo.listItems(tx, orderId),
      payment: await paymentsService.getLatestForOrder(tx, orderId).catch(() => null),
      reports: await paymentsService.getLatestTransferReports(tx, [orderId]),
    };
  });
  const buyers = await identityService.getSummaries(tenantId, [order.buyerUserId]);
  return {
    ...toOrderView(order),
    items: items.map(toOrderItemView),
    buyerUserId: order.buyerUserId,
    buyer: buyers.get(order.buyerUserId) ?? null,
    paymentProvider: payment?.provider ?? null,
    paymentReport: reports.get(orderId) ?? null,
  };
}

interface AdminOrderQuery {
  status?: OrderStatus;
  /** Any of these statuses. */
  statuses?: OrderStatus[];
  /** Only these orders. */
  onlyIds?: string[];
  /** Everything except these orders. */
  excludeIds?: string[];
  /** "transfer": unpaid orders whose buyer reported a transfer (the ones to check). */
  filter?: 'transfer';
  /** Searches the order number, the recipient's name and the buyer's name or email. */
  q?: string;
}

// How many orders each status has, for the queue's filter chips. Counted by the database: the screen only holds a page.
async function adminOrderCounts(tenantId: string): Promise<{ all: number; byStatus: Record<string, number>; transfer: number }> {
  const { rows, transfer } = await withTenant(tenantId, async (tx) => {
    const reported = await paymentsService.listOrderIdsWithTransferReport(tx);
    return { rows: await ordersRepo.countByStatus(tx), transfer: await ordersRepo.countPendingAmong(tx, reported) };
  });
  const byStatus = Object.fromEntries(rows.map((row) => [row.status, row.n]));
  return { all: rows.reduce((sum, row) => sum + row.n, 0), byStatus, transfer };
}

// One page of the admin queue, newest first, with the buyer, the item count and whether a transfer is waiting.
async function pageOrdersForAdmin(tenantId: string, query: AdminOrderQuery, page: PageQuery): Promise<Page<AdminOrderListItem>> {
  const after = orderCursor(page.cursor);
  const buyerIds = query.q ? await identityService.findUserIdsMatching(tenantId, query.q) : [];

  const { rows, items, reports } = await withTenant(tenantId, async (tx) => {
    const filter: ordersRepo.AdminOrderFilter = { status: query.status, statuses: query.statuses, onlyIds: query.onlyIds, excludeIds: query.excludeIds };
    if (query.filter === 'transfer') {
      filter.status = 'pending_payment';
      const reported = await paymentsService.listOrderIdsWithTransferReport(tx);
      filter.onlyIds = query.onlyIds ? reported.filter((id) => query.onlyIds?.includes(id)) : reported;
    }
    if (query.q) filter.search = { text: query.q, buyerIds };
    const found = await ordersRepo.pageForAdmin(tx, filter, { limit: page.limit + 1, after });
    const shown = found.slice(0, page.limit);
    const ids = shown.map((order) => order.id);
    return {
      rows: found,
      items: await ordersRepo.listItemsForOrders(tx, ids),
      reports: await paymentsService.getLatestTransferReports(tx, ids),
    };
  });
  const result = toPage(rows, page.limit, orderCursorOf);
  const buyers = await identityService.getSummaries(tenantId, result.items.map((order) => order.buyerUserId));
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.orderId, (counts.get(item.orderId) ?? 0) + item.quantity);
  }
  return {
    items: result.items.map((order) => ({
      ...toOrderView(order),
      buyer: buyers.get(order.buyerUserId) ?? null,
      itemCount: counts.get(order.id) ?? 0,
      transferReported: order.status === 'pending_payment' && reports.has(order.id),
    })),
    nextCursor: result.nextCursor,
  };
}

// Every order, optionally of one status (internal callers and tests; the API serves pages).
async function listOrdersForAdmin(tenantId: string, filter: { status?: OrderStatus }): Promise<AdminOrderListItem[]> {
  return collectAll((cursor) => pageOrdersForAdmin(tenantId, filter, { limit: 100, cursor }));
}

// --- manual transfer (Zelle / Cash App / PayPal) -------------------------------
//
// The buyer pays from their own app, then reports it: which app, the confirmation number it showed
// and a screenshot. Nobody confirms the money automatically — an admin looks at the store's account
// and uses mark-paid. The report is evidence for that person, not a payment.

// How to pay this order, or null when it is not a manual-transfer order.
async function getPaymentInstructions(tenantId: string, buyerUserId: string, orderId: string): Promise<PaymentInstructions | null> {
  const { order, payment, reports } = await withTenant(tenantId, async (tx) => {
    const found = await requireOrderForBuyer(tx, buyerUserId, orderId);
    return {
      order: found,
      payment: await paymentsService.getLatestForOrder(tx, orderId),
      reports: await paymentsService.getLatestTransferReports(tx, [orderId]),
    };
  });
  if (payment.provider !== 'manual') return null;
  return {
    orderId,
    orderNumber: order.orderNumber,
    status: order.status as OrderStatus,
    amountCents: order.totalCents,
    currency: order.currency,
    reference: order.orderNumber,
    methods: await paymentsService.listManualMethods(tenantId, order.totalCents),
    report: reports.get(orderId) ?? null,
  };
}

async function reportTransfer(
  tenantId: string,
  buyerUserId: string,
  orderId: string,
  input: { methodId: string; transferReference: string; notes?: string | null },
): Promise<PaymentInstructions> {
  const order = await withTenant(tenantId, (tx) => requireOrderForBuyer(tx, buyerUserId, orderId));
  if (order.status !== 'pending_payment') {
    throw new ConflictError('Only an order still waiting for payment can have a transfer reported', { reason: 'NOT_PENDING_PAYMENT' });
  }
  const methods = await paymentsService.listManualMethods(tenantId, order.totalCents);
  const method = methods.find((m) => m.id === input.methodId);
  if (!method) {
    throw new ValidationError('That is not a payment method this store accepts', { reason: 'UNKNOWN_PAYMENT_METHOD' });
  }
  // The admin decides from the screenshot, so one has to exist (a failed upload does not count).
  const shots = await mediaService.listForManagement(tenantId, 'payment_proof', orderId);
  if (!shots.some((s) => s.status !== 'failed')) {
    throw new ConflictError('Upload a screenshot of the transfer first', { reason: 'SCREENSHOT_REQUIRED' });
  }

  await withTenant(tenantId, async (tx) => {
    const payment = await paymentsService.getLatestForOrder(tx, orderId);
    if (payment.provider !== 'manual') {
      throw new ConflictError('This order is not paid by manual transfer', { reason: 'NOT_MANUAL_PAYMENT' });
    }
    await paymentsService.recordTransferReport(tx, {
      tenantId,
      paymentId: payment.id,
      methodId: method.id,
      label: method.label,
      transferReference: input.transferReference,
      notes: input.notes,
    });
    await auditService.record(tx, {
      tenantId,
      actorUserId: buyerUserId,
      entityType: 'order',
      entityId: orderId,
      action: 'order.transfer_reported',
      note: method.label,
    });
  });
  // Tell the store there is a transfer to check (an email). After the report is saved, never inside it, and
  // a failure to announce does not undo the report.
  try {
    await events.emit('order.transfer_reported', { orderId, tenantId, eventId: randomUUID() });
  } catch (err) {
    logger.warn({ err, orderId }, 'Could not announce a reported transfer');
  }
  const result = await getPaymentInstructions(tenantId, buyerUserId, orderId);
  if (!result) throw new ConflictError('This order is not paid by manual transfer', { reason: 'NOT_MANUAL_PAYMENT' });
  return result;
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

// A transition that also reports whether the order actually moved (an already-there order is
// returned unchanged, see transition), so callers announce real changes only.
async function transitionTracked(
  tx: Transaction,
  tenantId: string,
  orderId: string,
  toStatus: OrderStatus,
  actorUserId: string | undefined,
  note?: string,
): Promise<{ order: Order; changed: boolean }> {
  const before = await requireOrder(tx, orderId);
  const order = await transition(tx, tenantId, orderId, toStatus, actorUserId, note);
  return { order, changed: before.status !== order.status };
}

// Tells the rest of the system an order moved, for emails and the like. Called after the
// transaction has committed, never inside it, and never fails the request: a lost notification is
// worse than nothing only if the status change itself is lost, and that has already been saved.
async function announceStatus(tenantId: string, orderId: string, status: OrderStatus, cause?: 'unpaid'): Promise<void> {
  try {
    const eventId = randomUUID();
    await events.emit('order.status_changed', cause ? { orderId, tenantId, status, cause, eventId } : { orderId, tenantId, status, eventId });
  } catch (err) {
    logger.warn({ err, orderId }, 'Could not announce an order status change');
  }
}

// A buyer may only back out before paying — after that, cancelling money
// that has already changed hands is a refund, not a cancel (see the
// transition table above), and refunds are an admin action.
async function cancelByBuyer(tenantId: string, buyerUserId: string, orderId: string, note?: string): Promise<OrderView> {
  const { order, changed } = await withTenant(tenantId, async (tx) => {
    await requireOrderForBuyer(tx, buyerUserId, orderId);
    return transitionTracked(tx, tenantId, orderId, 'cancelled', buyerUserId, note);
  });
  if (changed) await announceStatus(tenantId, orderId, 'cancelled');
  return toOrderView(order);
}

async function adminCancel(tenantId: string, actorUserId: string, orderId: string, note?: string): Promise<OrderView> {
  const { order, changed } = await withTenant(tenantId, (tx) => transitionTracked(tx, tenantId, orderId, 'cancelled', actorUserId, note));
  if (changed) await announceStatus(tenantId, orderId, 'cancelled');
  return toOrderView(order);
}

// An operator's manual override for "I can see in my own banking/TropiPay
// dashboard that this was paid" — regardless of provider, not only manual
// transfer, since a missed webhook is exactly the kind of gap this exists to
// cover. Flips the payment row alongside the order, in one transaction.
async function adminMarkPaid(tenantId: string, actorUserId: string, orderId: string, note?: string): Promise<OrderView> {
  const { order, changed } = await withTenant(tenantId, async (tx) => {
    const result = await transitionTracked(tx, tenantId, orderId, 'paid', actorUserId, note ?? 'Confirmed by admin');
    const payment = await paymentsService.getLatestForOrder(tx, orderId);
    if (payment.status !== 'paid') {
      await paymentsService.markStatus(tx, payment.id, 'paid');
    }
    return result;
  });
  if (changed) await announceStatus(tenantId, orderId, 'paid');
  return toOrderView(order);
}

async function adminMarkPreparing(tenantId: string, actorUserId: string, orderId: string, note?: string): Promise<OrderView> {
  return withTenant(tenantId, async (tx) => toOrderView(await transition(tx, tenantId, orderId, 'preparing', actorUserId, note)));
}

async function adminMarkOutForDelivery(tenantId: string, actorUserId: string, orderId: string, note?: string): Promise<OrderView> {
  const { order, changed } = await withTenant(tenantId, (tx) => transitionTracked(tx, tenantId, orderId, 'out_for_delivery', actorUserId, note));
  if (changed) await announceStatus(tenantId, orderId, 'out_for_delivery');
  return toOrderView(order);
}

// A store that requires proof of delivery cannot mark an order delivered without it. The proof
// (photo + recipient name) is recorded by the fulfilment module, which calls this with
// proofRecorded after checking it; a bare call (the admin button) is refused for those stores
// rather than quietly skipping the rule.
async function adminMarkDelivered(
  tenantId: string,
  actorUserId: string,
  orderId: string,
  note?: string,
  opts: { proofRecorded?: boolean } = {},
): Promise<OrderView> {
  const settings = await tenancyService.getSettings(tenantId);
  const { order, changed } = await withTenant(tenantId, async (tx) => {
    const found = await requireOrder(tx, orderId);
    if (settings.requireDeliveryPhoto && !opts.proofRecorded && found.status !== 'delivered') {
      throw new ConflictError('This store requires a delivery photo before an order can be marked delivered', {
        reason: 'DELIVERY_PHOTO_REQUIRED',
      });
    }
    return transitionTracked(tx, tenantId, orderId, 'delivered', actorUserId, note);
  });
  if (changed) await announceStatus(tenantId, orderId, 'delivered');
  return toOrderView(order);
}

// --- analytics -------------------------------------------------------------

export type StatsRange = 'week' | 'month' | 'year';

export interface PeriodTotals {
  orders: number;
  totalCents: number;
  averageTicketCents: number;
  /** Share of the period's orders that shipped free, 0..1. */
  freeDeliveryShare: number;
}

export interface SalesStats {
  range: StatsRange;
  currency: 'USD';
  granularity: 'day' | 'month';
  current: PeriodTotals;
  /** The same-length period right before, for the "vs. last week" comparison. */
  previous: PeriodTotals;
  /** One entry per day (week, month) or per month (year), oldest first, empty buckets included. */
  series: Array<{ bucket: string; totalCents: number; orders: number }>;
  byMunicipality: Array<{ provinceId: string; municipalityId: string; orders: number }>;
  topProducts: Array<{ productId: string | null; nameEs: string; nameEn: string | null; quantity: number; totalCents: number }>;
}

const HAVANA = 'America/Havana';

// Dates are handled as plain "YYYY-MM-DD" strings so daylight-saving never shifts a bucket.
function havanaToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: HAVANA }).format(now);
}
function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function shiftMonths(month: string, months: number): string {
  const [year, mon] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(year, mon - 1 + months, 1));
  return d.toISOString().slice(0, 7);
}

function toPeriodTotals(raw: ordersRepo.SalesTotals): PeriodTotals {
  return {
    orders: raw.orders,
    totalCents: raw.totalCents,
    averageTicketCents: raw.orders === 0 ? 0 : Math.round(raw.totalCents / raw.orders),
    freeDeliveryShare: raw.orders === 0 ? 0 : raw.freeDeliveryOrders / raw.orders,
  };
}

// Sales figures for the admin dashboard. week = the last 7 Cuba days (today included), month = the
// last 30, year = the last 12 calendar months; "previous" is the equal-length stretch before.
async function getSalesStats(tenantId: string, range: StatsRange, now: Date = new Date()): Promise<SalesStats> {
  const today = havanaToday(now);
  const granularity = range === 'year' ? 'month' : 'day';

  let from: string;
  let previousFrom: string;
  let buckets: string[];
  if (range === 'year') {
    const thisMonth = today.slice(0, 7);
    const first = shiftMonths(thisMonth, -11);
    from = `${first}-01`;
    previousFrom = `${shiftMonths(first, -12)}-01`;
    buckets = Array.from({ length: 12 }, (_, i) => shiftMonths(first, i));
  } else {
    const days = range === 'week' ? 7 : 30;
    const first = shiftDays(today, -(days - 1));
    from = first;
    previousFrom = shiftDays(first, -days);
    buckets = Array.from({ length: days }, (_, i) => shiftDays(first, i));
  }

  const data = await withTenant(tenantId, async (tx) => ({
    current: await ordersRepo.salesTotals(tx, from, null),
    previous: await ordersRepo.salesTotals(tx, previousFrom, from),
    series: await ordersRepo.salesByBucket(tx, from, null, granularity),
    byMunicipality: await ordersRepo.salesByMunicipality(tx, from, null),
    topProducts: await ordersRepo.topProducts(tx, from, null, 5),
  }));

  const byBucket = new Map(data.series.map((row) => [row.bucket, row]));
  return {
    range,
    currency: 'USD',
    granularity,
    current: toPeriodTotals(data.current),
    previous: toPeriodTotals(data.previous),
    series: buckets.map((bucket) => ({ bucket, totalCents: byBucket.get(bucket)?.totalCents ?? 0, orders: byBucket.get(bucket)?.orders ?? 0 })),
    byMunicipality: data.byMunicipality,
    topProducts: data.topProducts,
  };
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

  const { order: refunded, changed } = await withTenant(tenantId, async (tx) => {
    await paymentsService.markStatus(tx, payment.id, 'refunded');
    return transitionTracked(tx, tenantId, orderId, 'refunded', actorUserId, note);
  });
  if (changed) await announceStatus(tenantId, orderId, 'refunded');
  return toOrderView(refunded);
}

// --- sharing an order's products by link --------------------------------------------------------------------
//
// After placing an order the buyer can share a link: whoever opens it sees the LIST OF PRODUCTS (names, units,
// quantities, what is available now) and can put them in their own cart. It never carries the recipient, address,
// phones, photos or what was paid — the token is a capability, so it must show nothing worth stealing. The buyer
// can switch it off; the old link then answers 404 like any other unknown one.

async function getShare(tenantId: string, buyerUserId: string, orderId: string): Promise<{ token: string | null }> {
  const order = await withTenant(tenantId, (tx) => requireOrderForBuyer(tx, buyerUserId, orderId));
  return { token: order.shareToken };
}

// Idempotent: sharing again returns the same link.
async function enableShare(tenantId: string, buyerUserId: string, orderId: string): Promise<{ token: string }> {
  return withTenant(tenantId, async (tx) => {
    const order = await requireOrderForBuyer(tx, buyerUserId, orderId);
    if (order.shareToken) return { token: order.shareToken };
    const token = randomBytes(32).toString('base64url');
    await ordersRepo.setShareToken(tx, orderId, token);
    await auditService.record(tx, { tenantId, actorUserId: buyerUserId, entityType: 'order', entityId: orderId, action: 'order.share_enabled' });
    return { token };
  });
}

async function disableShare(tenantId: string, buyerUserId: string, orderId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const order = await requireOrderForBuyer(tx, buyerUserId, orderId);
    if (!order.shareToken) return;
    await ordersRepo.setShareToken(tx, orderId, null);
    await auditService.record(tx, { tenantId, actorUserId: buyerUserId, entityType: 'order', entityId: orderId, action: 'order.share_disabled' });
  });
}

export interface SharedOrderItem {
  /** What to add to a cart; null for a product that no longer exists. */
  productId: string | null;
  nameEs: string;
  nameEn: string | null;
  unitLabel: string;
  quantity: number;
  /** Today's price and whether it can be bought now (the cart reprices again on its own). */
  priceCents: number | null;
  available: boolean;
}

export interface SharedOrder {
  items: SharedOrderItem[];
  /** Only for the store's own staff: which order this is, so they can open it in the admin. Null for everyone else. */
  orderId: string | null;
  orderNumber: string | null;
}

// What a visitor sees through a share link. `viewerRole` is the signed-in person's role, if any: store staff get the
// order's id (to be sent to it in the admin); nobody else learns anything about the order beyond its products.
async function getSharedOrder(tenantId: string, token: string, viewerRole?: string): Promise<SharedOrder> {
  const { order, items } = await withTenant(tenantId, async (tx) => {
    const found = await ordersRepo.findByShareToken(tx, token);
    if (!found) throw new NotFoundError('This link is not valid anymore');
    return { order: found, items: await ordersRepo.listItems(tx, found.id) };
  });
  const productIds = items.flatMap((item) => (item.productId ? [item.productId] : []));
  const snapshots = new Map((await catalogService.getProductSnapshots(tenantId, productIds)).map((p) => [p.id, p]));
  const isStaff = viewerRole === 'admin' || viewerRole === 'staff';
  return {
    items: items.map((item) => {
      const live = item.productId ? snapshots.get(item.productId) : undefined;
      return {
        productId: live ? live.id : null,
        nameEs: live?.nameEs ?? item.productNameSnapshot,
        nameEn: live ? live.nameEn : item.productNameEnSnapshot,
        unitLabel: live?.unitLabel ?? item.unitLabelSnapshot,
        quantity: item.quantity,
        priceCents: live ? live.priceCents : null,
        available: Boolean(live && live.active && live.stockStatus !== 'out'),
      };
    }),
    orderId: isStaff ? order.id : null,
    orderNumber: isStaff ? order.orderNumber : null,
  };
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
  const { changed } = await withTenant(tenantId, (tx) => transitionTracked(tx, tenantId, orderId, 'paid', undefined, 'Confirmed by payment provider'));
  if (changed) await announceStatus(tenantId, orderId, 'paid');
}

async function handlePaymentRefunded(tenantId: string, orderId: string): Promise<void> {
  const { changed } = await withTenant(tenantId, (tx) => transitionTracked(tx, tenantId, orderId, 'refunded', undefined, 'Refunded by payment provider'));
  if (changed) await announceStatus(tenantId, orderId, 'refunded');
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
// One reminder, a day before the cancellation, to orders nobody has reported paying for.
const REMIND_AFTER_HOURS = 48;

export interface ReconciliationResult {
  checked: number;
  selfHealed: number;
  cancelled: number;
  reminded: number;
}

async function reconcilePendingPayments(tenantId: string, now: Date = new Date()): Promise<ReconciliationResult> {
  const pollCutoff = new Date(now.getTime() - RECONCILE_POLL_AFTER_HOURS * 60 * 60 * 1000);
  const cancelCutoff = new Date(now.getTime() - RECONCILE_CANCEL_AFTER_HOURS * 60 * 60 * 1000);
  const remindCutoff = new Date(now.getTime() - REMIND_AFTER_HOURS * 60 * 60 * 1000);

  const { stale, reported } = await withTenant(tenantId, async (tx) => ({
    stale: await ordersRepo.findStalePendingPayment(tx, pollCutoff),
    // Someone who says they paid is waiting on us, not the other way round: no reminder for them.
    reported: new Set(await paymentsService.listOrderIdsWithTransferReport(tx)),
  }));
  let selfHealed = 0;
  let cancelled = 0;
  let reminded = 0;

  for (const order of stale) {
    try {
      const payment = await withTenant(tenantId, (tx) => paymentsService.getLatestForOrder(tx, order.id));

      if (payment.provider !== 'manual' && payment.externalPaymentId) {
        try {
          const status = await paymentsService.getProvider(payment.provider).getStatus(payment.externalPaymentId);
          if (status === 'paid') {
            const { changed } = await withTenant(tenantId, async (tx) => {
              await paymentsService.markStatus(tx, payment.id, 'paid');
              return transitionTracked(tx, tenantId, order.id, 'paid', undefined, 'Self-healed by reconciliation');
            });
            if (changed) await announceStatus(tenantId, order.id, 'paid');
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
        await announceStatus(tenantId, order.id, 'cancelled', 'unpaid');
        cancelled += 1;
      } else if (order.placedAt && order.placedAt < remindCutoff && !reported.has(order.id)) {
        const claimed = await withTenant(tenantId, (tx) => ordersRepo.claimPaymentReminder(tx, order.id, now));
        if (claimed) {
          await events.emit('order.payment_reminder', { orderId: order.id, tenantId });
          reminded += 1;
        }
      }
    } catch (err) {
      // One order's failure must not stop the rest of the tenant's batch.
      logger.error({ err, orderId: order.id }, 'Reconciliation failed for an order');
    }
  }

  return { checked: stale.length, selfHealed, cancelled, reminded };
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
  pageOrdersForAdmin,
  pageOrdersForBuyer,
  adminOrderCounts,
  retryPayment,
  getPaymentInstructions,
  reportTransfer,
  cancelByBuyer,
  adminCancel,
  adminMarkPaid,
  adminMarkPreparing,
  adminMarkOutForDelivery,
  adminMarkDelivered,
  getSalesStats,
  refund,
  handlePaymentConfirmed,
  handlePaymentRefunded,
  reconcilePendingPayments,
  getShare,
  enableShare,
  disableShare,
  getSharedOrder,
};

// Exported for the worker's registration and for tests that need the full
// status list without importing orders.schema directly.
export { orderStatuses };
