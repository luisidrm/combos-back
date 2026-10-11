import { config } from '../../config/index.js';
import { events } from '../../core/events.js';
import { logger } from '../../core/logger.js';
import type { NotificationKind } from './notifications.schema.js';
import { notificationsService, type OrderEmailKind } from './notifications.service.js';

interface OrderStatusChangedPayload extends Record<string, unknown> {
  tenantId: string;
  orderId: string;
  status: string;
  /** Which announcement this is (see notifications.event_key). */
  eventId?: string;
  /** Why it happened, when the buyer did not do it themselves (an unpaid order that timed out). */
  cause?: 'unpaid';
}

// The statuses a buyer hears about by email, and what each one is called in the templates. "Placed" is the order's
// first status (pending_payment); preparing is visible on the order page and not worth an inbox message.
const EMAIL_KIND: Record<string, OrderEmailKind | undefined> = {
  pending_payment: 'placed',
  paid: 'paid',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  cancelled: 'cancelled',
  refunded: 'refunded',
};

// What the email needs from an order, in the buyer's language.
async function buyerEmailFor(tenantId: string, orderId: string) {
  const { ordersService } = await import('../orders/index.js');
  const order = await ordersService.getOrderForAdmin(tenantId, orderId);
  return { order, buyer: order.buyer };
}

function orderData(order: Awaited<ReturnType<typeof buyerEmailFor>>['order'], locale: 'es' | 'en', buyerName: string | null) {
  return {
    buyerName,
    orderNumber: order.orderNumber,
    recipientName: order.recipientNameSnapshot,
    orderUrl: `${config.webBaseUrl}/${locale}/account/orders/${order.id}`,
    totalCents: order.totalCents,
    subtotalCents: order.subtotalCents,
    deliveryFeeCents: order.deliveryFeeCents,
    items: order.items.map((item) => ({
      name: locale === 'en' ? (item.productNameEn ?? item.productNameEs) : item.productNameEs,
      quantity: item.quantity,
      unitLabel: item.unitLabel,
      lineTotalCents: item.lineTotalCents,
    })),
  };
}

// orders emits `order.status_changed` after a status really changes; the buyer is told here.
// orders cannot import notifications (CLAUDE.md section 4), so this is the event's one subscriber.
// The orders service is loaded at call time: notifications is reachable from the auth setup that
// orders' own dependencies load, and a static import would close a cycle.
async function handleOrderStatusChanged({ tenantId, orderId, status, cause, eventId }: OrderStatusChangedPayload): Promise<void> {
  const kind = EMAIL_KIND[status];
  if (!kind) return;
  const { order, buyer } = await buyerEmailFor(tenantId, orderId);
  // In-app first, and not subject to the stale check below: it needs no email setup, and "it was paid" stays true after the order moved on.
  await notifyInApp(tenantId, order, status, cause, eventId);
  // The status may have moved on since the event was queued (paid -> preparing); say what is true now
  // only if it is still the status this message is about, so nobody gets a stale "on its way".
  if (order.status !== status) {
    logger.info({ orderId, wanted: status, actual: order.status }, 'Skipped a stale order status email');
    return;
  }
  if (!buyer?.email) return;
  await notificationsService.sendOrderEmail(buyer.email, {
    kind,
    locale: buyer.locale,
    tenantId,
    data: { ...orderData(order, buyer.locale, buyer.fullName), cause },
  });
}

// The people at the store: admins and the packer see the alerts in the bell; only admins are emailed.
async function storePeople(tenantId: string): Promise<{ bell: string[]; emails: string[] }> {
  const { identityService } = await import('../identity/index.js');
  const active = (await identityService.listTeam(tenantId)).filter((m) => m.active);
  return {
    bell: active.filter((m) => m.role === 'admin' || m.role === 'staff').map((m) => m.id),
    emails: [...new Set(active.filter((m) => m.role === 'admin').map((m) => m.email))],
  };
}

const adminOrderUrl = (orderId: string) => `${config.webBaseUrl}/es/admin/orders?order=${orderId}`;

// Sending one email must not stop the rest: each failure is logged and the others still go.
async function emailAdmins(emails: string[], send: (to: string) => Promise<void>): Promise<void> {
  for (const to of emails) {
    try {
      await send(to);
    } catch (err) {
      logger.warn({ err }, 'Could not email a store admin');
    }
  }
}

type AdminOrder = Awaited<ReturnType<typeof buyerEmailFor>>['order'];

// The bell for an order that really changed status: the buyer hears about their order, the store about new orders,
// payments, deliveries and timeouts. Admins are also emailed for a new order and a delivery.
async function notifyInApp(tenantId: string, order: AdminOrder, status: string, cause?: 'unpaid', eventKey?: string): Promise<void> {
  const base = { orderId: order.id, orderNumber: order.orderNumber, eventKey };
  const buyerKind: Record<string, NotificationKind | undefined> = {
    paid: 'buyer_paid',
    out_for_delivery: 'buyer_on_the_way',
    delivered: 'buyer_delivered',
    cancelled: 'buyer_cancelled',
    refunded: 'buyer_refunded',
  };
  const storeKind: Record<string, NotificationKind | undefined> = {
    pending_payment: 'new_order',
    paid: 'order_paid',
    delivered: 'order_delivered',
    cancelled: 'order_cancelled',
  };
  const mine = buyerKind[status];
  if (mine) await notificationsService.notifyUsers(tenantId, [order.buyerUserId], { kind: mine, ...base, data: cause ? { cause } : {} });
  const store = storeKind[status];
  if (!store) return;
  const people = await storePeople(tenantId);
  await notificationsService.notifyUsers(tenantId, people.bell, { kind: store, ...base, data: cause ? { cause } : {} });
  const alert = status === 'pending_payment' ? 'new_order' : status === 'delivered' ? 'delivered' : null;
  if (alert) {
    await emailAdmins(people.emails, (to) =>
      notificationsService.sendStaffAlertEmail(to, tenantId, alert, { orderNumber: order.orderNumber, adminUrl: adminOrderUrl(order.id) }),
    );
  }
}

interface DeliveryChangedPayload extends Record<string, unknown> {
  tenantId: string;
  orderId: string;
  action: 'assigned' | 'released' | 'accepted' | 'picked_up' | 'declined' | 'failed';
  /** The courier the assignment is with (their user id), so the right person is told. */
  courierUserId: string;
  courierName: string;
  reason?: string;
  note?: string;
  eventId?: string;
}

// fulfilment emits `delivery.changed` after each dispatch step. A courier is told about their own assignments; the store
// about what the courier did with them (declined and could-not-deliver are also emailed to admins, they need a decision).
async function handleDeliveryChanged({ tenantId, orderId, action, courierUserId, courierName, reason, note, eventId }: DeliveryChangedPayload): Promise<void> {
  const { ordersService } = await import('../orders/index.js');
  const order = await ordersService.getOrderForAdmin(tenantId, orderId);
  const base = { orderId, orderNumber: order.orderNumber, eventKey: eventId };
  const facts: Record<string, string> = { courierName };
  if (reason) facts.reason = reason;
  if (note) facts.note = note;

  if (action === 'assigned' || action === 'released') {
    await notificationsService.notifyUsers(tenantId, [courierUserId], { kind: action === 'assigned' ? 'delivery_assigned' : 'delivery_released', ...base });
    return;
  }
  const kind = { accepted: 'delivery_accepted', picked_up: 'delivery_picked_up', declined: 'delivery_declined', failed: 'delivery_failed' } as const;
  const people = await storePeople(tenantId);
  await notificationsService.notifyUsers(tenantId, people.bell, { kind: kind[action], ...base, data: facts });
  if (action === 'declined' || action === 'failed') {
    await emailAdmins(people.emails, (to) =>
      notificationsService.sendStaffAlertEmail(to, tenantId, action === 'declined' ? 'delivery_declined' : 'delivery_failed', {
        orderNumber: order.orderNumber,
        courierName,
        reason,
        note,
        adminUrl: `${config.webBaseUrl}/es/admin/dispatch`,
      }),
    );
  }
}

interface PaymentReminderPayload extends Record<string, unknown> {
  tenantId: string;
  orderId: string;
}

// An unpaid order is about to time out: nudge the buyer once (orders decides when and marks it sent).
async function handlePaymentReminder({ tenantId, orderId }: PaymentReminderPayload): Promise<void> {
  const { order, buyer } = await buyerEmailFor(tenantId, orderId);
  if (order.status !== 'pending_payment' || !buyer?.email) return; // paid or cancelled in the meantime
  await notificationsService.sendOrderEmail(buyer.email, {
    kind: 'payment_reminder',
    locale: buyer.locale,
    tenantId,
    data: orderData(order, buyer.locale, buyer.fullName),
  });
}

interface TransferReportedPayload extends Record<string, unknown> {
  tenantId: string;
  orderId: string;
  eventId?: string;
}

// A buyer reported a manual transfer: tell the store. It goes to the store's contact email when one is
// set, and to every active admin otherwise. Loaded at call time for the same reason as above.
async function handleTransferReported({ tenantId, orderId, eventId }: TransferReportedPayload): Promise<void> {
  const [{ ordersService }, { identityService }, { tenancyService }] = await Promise.all([
    import('../orders/index.js'),
    import('../identity/index.js'),
    import('../tenancy/index.js'),
  ]);
  const order = await ordersService.getOrderForAdmin(tenantId, orderId);
  const report = order.paymentReport;
  if (!report || order.status !== 'pending_payment') return; // nothing left to check

  const settings = await tenancyService.getSettings(tenantId);
  const team = await identityService.listTeam(tenantId);
  await notificationsService.notifyUsers(
    tenantId,
    team.filter((m) => m.active && (m.role === 'admin' || m.role === 'staff')).map((m) => m.id),
    { kind: 'transfer_reported', orderId, orderNumber: order.orderNumber, data: { method: report.method }, eventKey: eventId },
  );
  const recipients = settings.contact?.email ? [settings.contact.email] : team.filter((m) => m.role === 'admin' && m.active).map((m) => m.email);
  for (const to of new Set(recipients)) {
    await notificationsService.sendTransferReportedEmail(to, tenantId, {
      orderNumber: order.orderNumber,
      amountCents: order.totalCents,
      method: report.method,
      transferReference: report.transferReference,
      adminUrl: `${config.webBaseUrl}/es/admin/orders`,
    });
  }
}

export function registerNotificationsWorker(): void {
  events.on<TransferReportedPayload>('order.transfer_reported', handleTransferReported);
  events.on<OrderStatusChangedPayload>('order.status_changed', handleOrderStatusChanged);
  events.on<PaymentReminderPayload>('order.payment_reminder', handlePaymentReminder);
  events.on<DeliveryChangedPayload>('delivery.changed', handleDeliveryChanged);
}
