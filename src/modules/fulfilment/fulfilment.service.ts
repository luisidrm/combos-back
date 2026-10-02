// Proof of delivery and the courier queue (CLAUDE.md sections 5 and 12). Delivery photos are
// `media` rows with owner type "delivery" and the ORDER id as owner id, so a photo can be uploaded
// before the delivery row exists. This module calls orders, media and tenancy through their
// services; none of them import it, so there is no cycle.
import { ConflictError } from '../../core/errors.js';
import { withTenant } from '../../db/client.js';
import { mediaService } from '../media/index.js';
import { ordersService, type AdminOrderListItem } from '../orders/index.js';
import { tenancyService } from '../tenancy/index.js';
import * as fulfilmentRepo from './fulfilment.repo.js';
import type { ConfirmDeliveryInput } from './fulfilment.schema.js';

export interface DeliveryProof {
  orderId: string;
  recipientName: string | null;
  notes: string | null;
  deliveredAt: Date;
  photos: Array<{ id: string; thumbUrl: string | null; cardUrl: string | null; fullUrl: string | null }>;
}

async function readyPhotos(tenantId: string, orderId: string): Promise<DeliveryProof['photos']> {
  const rows = await mediaService.listForManagement(tenantId, 'delivery', orderId);
  return rows
    .filter((row) => row.status === 'ready')
    .map((row) => ({ id: row.id, thumbUrl: row.thumbUrl, cardUrl: row.cardUrl, fullUrl: row.fullUrl }));
}

// The proof for an order, or null when it was never recorded (delivered without one, or not yet).
async function getProof(tenantId: string, orderId: string): Promise<DeliveryProof | null> {
  const delivery = await withTenant(tenantId, (tx) => fulfilmentRepo.findByOrder(tx, orderId));
  if (!delivery) return null;
  return {
    orderId,
    recipientName: delivery.recipientNameConfirmed,
    notes: delivery.notes,
    deliveredAt: delivery.deliveredAt,
    photos: await readyPhotos(tenantId, orderId),
  };
}

// Hand the order over: records who received it and moves the order to `delivered`. A store that
// requires a photo (settings.requireDeliveryPhoto) must have at least one ready photo first.
// Idempotent — a courier retrying after a dropped connection gets the recorded proof back.
async function confirmDelivery(
  tenantId: string,
  actorUserId: string,
  orderId: string,
  input: ConfirmDeliveryInput,
): Promise<DeliveryProof> {
  const order = await ordersService.getOrderForAdmin(tenantId, orderId);
  if (order.status === 'delivered') {
    const existing = await getProof(tenantId, orderId);
    if (existing) return existing;
  } else if (order.status !== 'out_for_delivery') {
    throw new ConflictError(`Only an order that is out for delivery can be delivered (it is "${order.status}")`, {
      reason: 'ILLEGAL_TRANSITION',
      from: order.status,
      to: 'delivered',
    });
  }

  const photos = await readyPhotos(tenantId, orderId);
  const settings = await tenancyService.getSettings(tenantId);
  if (settings.requireDeliveryPhoto && photos.length === 0) {
    throw new ConflictError('This store requires a delivery photo before an order can be marked delivered', {
      reason: 'DELIVERY_PHOTO_REQUIRED',
    });
  }

  await withTenant(tenantId, (tx) =>
    fulfilmentRepo.upsertDelivery(tx, {
      tenantId,
      orderId,
      deliveredByUserId: actorUserId,
      recipientNameConfirmed: input.recipientName,
      notes: input.notes ?? null,
      deliveredAt: new Date(),
    }),
  );
  await ordersService.adminMarkDelivered(tenantId, actorUserId, orderId, input.notes, { proofRecorded: true });

  const proof = await getProof(tenantId, orderId);
  if (!proof) throw new ConflictError('Delivery proof was not saved');
  return proof;
}

// What a courier works from: the orders on their way out, with the recipient and address snapshots.
async function listQueue(tenantId: string): Promise<AdminOrderListItem[]> {
  return ordersService.listOrdersForAdmin(tenantId, { status: 'out_for_delivery' });
}

export const fulfilmentService = { getProof, confirmDelivery, listQueue };
