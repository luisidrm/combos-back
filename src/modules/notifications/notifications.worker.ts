import { config } from '../../config/index.js';
import { events } from '../../core/events.js';
import { logger } from '../../core/logger.js';
import { notificationsService, type OrderEmailStatus } from './notifications.service.js';

interface OrderStatusChangedPayload extends Record<string, unknown> {
  tenantId: string;
  orderId: string;
  status: string;
}

// The statuses a buyer hears about by email. Everything else (preparing, cancelled, refunded) is
// visible on the order page and not worth an inbox message.
const EMAILED: readonly string[] = ['paid', 'out_for_delivery', 'delivered'] satisfies OrderEmailStatus[];

// orders emits `order.status_changed` after a status really changes; the buyer is told here.
// orders cannot import notifications (CLAUDE.md section 4), so this is the event's one subscriber.
// The orders service is loaded at call time: notifications is reachable from the auth setup that
// orders' own dependencies load, and a static import would close a cycle.
async function handleOrderStatusChanged({ tenantId, orderId, status }: OrderStatusChangedPayload): Promise<void> {
  if (!EMAILED.includes(status)) return;
  const { ordersService } = await import('../orders/index.js');
  const order = await ordersService.getOrderForAdmin(tenantId, orderId);
  // The status may have moved on since the event was queued (paid -> preparing); say what is true now
  // only if it is still the status this message is about, so nobody gets a stale "on its way".
  if (order.status !== status) {
    logger.info({ orderId, wanted: status, actual: order.status }, 'Skipped a stale order status email');
    return;
  }
  if (!order.buyer?.email) return;
  await notificationsService.sendOrderStatusEmail(order.buyer.email, {
    buyerName: order.buyer.fullName,
    orderNumber: order.orderNumber,
    status: status as OrderEmailStatus,
    recipientName: order.recipientNameSnapshot,
    orderUrl: `${config.webBaseUrl}/account/orders/${orderId}`,
  });
}

export function registerNotificationsWorker(): void {
  events.on<OrderStatusChangedPayload>('order.status_changed', handleOrderStatusChanged);
}
