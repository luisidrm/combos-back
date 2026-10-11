// Dispatch and proof of delivery (CLAUDE.md sections 5 and 12). The store gives a paid order to a courier; the courier
// accepts (or declines) it, picks it up (the order becomes "out for delivery"), and either hands it over (proof, the
// order becomes "delivered") or reports that they could not. Delivery photos are `media` rows with owner type
// "delivery" and the ORDER id as owner id, so a photo can be uploaded before the delivery row exists. This module calls
// orders, media, identity, audit and tenancy through their services; none of them import it, so there is no cycle.
import { randomUUID } from 'node:crypto';
import { ConflictError, ForbiddenError, NotFoundError } from '../../core/errors.js';
import { events } from '../../core/events.js';
import { logger } from '../../core/logger.js';
import type { Page, PageQuery } from '../../core/pagination.js';
import { withTenant } from '../../db/client.js';
import { auditService } from '../audit/index.js';
import { identityService } from '../identity/index.js';
import { mediaService } from '../media/index.js';
import { ordersService, type AdminOrderListItem, type OrderStatus } from '../orders/index.js';
import { tenancyService } from '../tenancy/index.js';
import * as fulfilmentRepo from './fulfilment.repo.js';
import type { BoardLane, ConfirmDeliveryInput, CourierAssignment, DeliveryFailureReason } from './fulfilment.schema.js';

export interface DeliveryProof {
  orderId: string;
  recipientName: string | null;
  notes: string | null;
  deliveredAt: Date;
  photos: Array<{ id: string; thumbUrl: string | null; cardUrl: string | null; fullUrl: string | null }>;
}

export interface CourierOption {
  /** The courier's id (what assigning takes), not the user id. */
  id: string;
  name: string;
  phone: string;
  /** Orders this courier has right now. */
  open: number;
  delivered: number;
}

export interface AssignmentView {
  id: string;
  orderId: string;
  courierId: string;
  courierName: string;
  courierPhone: string;
  status: CourierAssignment['status'];
  reason: string | null;
  note: string | null;
  createdAt: Date;
  acceptedAt: Date | null;
  pickedUpAt: Date | null;
  closedAt: Date | null;
}

export interface DispatchItem extends AdminOrderListItem {
  /** The latest assignment of the order (open, or the one that just ended), null when it never had a courier. */
  assignment: AssignmentView | null;
}

export interface OrderAssignments {
  current: AssignmentView | null;
  history: AssignmentView[];
}

// Orders a courier can be working on: paid (to prepare), being prepared, or already on the road.
const DISPATCHABLE: OrderStatus[] = ['paid', 'preparing', 'out_for_delivery'];

type DeliveryAction = 'assigned' | 'released' | 'accepted' | 'picked_up' | 'declined' | 'failed';

// Tells the rest of the system what happened to a delivery (the bell and the emails to the store are built from it by
// notifications). After the change is saved, never inside it, and never fails the request: a lost notification must not
// undo a dispatch step that already happened.
async function announceDelivery(
  tenantId: string,
  orderId: string,
  action: DeliveryAction,
  courierId: string,
  extra: { reason?: string; note?: string } = {},
): Promise<void> {
  try {
    const who = (await courierDirectory(tenantId)).get(courierId);
    if (!who) return;
    await events.emit('delivery.changed', { tenantId, orderId, action, courierUserId: who.userId, courierName: who.name, eventId: randomUUID(), ...extra });
  } catch (err) {
    logger.warn({ err, orderId, action }, 'Could not announce a delivery change');
  }
}

interface Actor {
  id: string;
  role: string;
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

// --- couriers -------------------------------------------------------------------------------------------------------

// Active team members with the courier role. The Team screen owns the accounts; this module only adds a `couriers` row
// (phone, workload) the first time someone is listed or dispatched.
async function teamCouriers(tenantId: string) {
  const team = await identityService.listTeam(tenantId);
  return team.filter((member) => member.role === 'courier' && member.active);
}

async function listCouriers(tenantId: string): Promise<CourierOption[]> {
  const members = await teamCouriers(tenantId);
  return withTenant(tenantId, async (tx) => {
    const workload = await fulfilmentRepo.workloadByCourier(tx);
    const options: CourierOption[] = [];
    for (const member of members) {
      const courier = await fulfilmentRepo.ensureCourier(tx, tenantId, member.id, member.phone ?? '');
      const load = workload.get(courier.id);
      options.push({
        id: courier.id,
        name: member.fullName ?? member.email,
        phone: courier.phone || member.phone || '',
        open: load?.open ?? 0,
        delivered: load?.delivered ?? 0,
      });
    }
    return options.sort((a, b) => a.name.localeCompare(b.name));
  });
}

// Who is behind each courier id, for showing names on assignments (including couriers turned off since).
async function courierDirectory(tenantId: string): Promise<Map<string, { name: string; phone: string; userId: string }>> {
  const [team, couriers] = await Promise.all([
    identityService.listTeam(tenantId),
    withTenant(tenantId, (tx) => fulfilmentRepo.listCouriers(tx)),
  ]);
  const byUser = new Map(team.map((member) => [member.id, member]));
  return new Map(
    couriers.map((courier) => {
      const member = byUser.get(courier.userId);
      return [courier.id, { name: member?.fullName ?? member?.email ?? '-', phone: courier.phone || member?.phone || '', userId: courier.userId }];
    }),
  );
}

function toView(row: CourierAssignment, directory: Map<string, { name: string; phone: string }>): AssignmentView {
  const who = directory.get(row.courierId);
  return {
    id: row.id,
    orderId: row.orderId,
    courierId: row.courierId,
    courierName: who?.name ?? '-',
    courierPhone: who?.phone ?? '',
    status: row.status as CourierAssignment['status'],
    reason: row.reason,
    note: row.note,
    createdAt: row.createdAt,
    acceptedAt: row.acceptedAt,
    pickedUpAt: row.pickedUpAt,
    closedAt: row.closedAt,
  };
}

// --- the store: dispatch ----------------------------------------------------------------------------------------------

// Gives the order to a courier. An order that already has one is taken from them (their assignment is closed as
// "released") — reassigning is how the store reacts to a courier who is not answering. Asking again for the courier who
// already has it changes nothing.
async function assignCourier(tenantId: string, actorUserId: string, orderId: string, courierId: string): Promise<AssignmentView> {
  const order = await ordersService.getOrderForAdmin(tenantId, orderId);
  if (!DISPATCHABLE.includes(order.status)) {
    throw new ConflictError(`A courier can only be given an order that is paid and not yet delivered (it is "${order.status}")`, {
      reason: 'ORDER_NOT_DISPATCHABLE',
      status: order.status,
    });
  }
  const members = await teamCouriers(tenantId);
  const created = await withTenant(tenantId, async (tx) => {
    const courier = await fulfilmentRepo.findCourier(tx, courierId);
    if (!courier || !courier.active || !members.some((m) => m.id === courier.userId)) {
      throw new NotFoundError('No active courier with that id');
    }
    const open = await fulfilmentRepo.findOpenAssignmentByOrder(tx, orderId);
    if (open?.courierId === courier.id) return { row: open, previous: undefined, isNew: false };
    if (open) {
      await fulfilmentRepo.updateAssignment(tx, open.id, { status: 'released', closedAt: new Date() });
    }
    const row = await fulfilmentRepo.insertAssignment(tx, { tenantId, orderId, courierId: courier.id, assignedByUserId: actorUserId });
    await auditService.record(tx, {
      tenantId,
      actorUserId,
      entityType: 'order',
      entityId: orderId,
      action: open ? 'delivery.reassigned' : 'delivery.assigned',
      note: courier.id,
    });
    return { row, previous: open?.courierId, isNew: true };
  });
  if (created.isNew) {
    if (created.previous) await announceDelivery(tenantId, orderId, 'released', created.previous);
    await announceDelivery(tenantId, orderId, 'assigned', courierId);
  }
  return toView(created.row, await courierDirectory(tenantId));
}

// The store takes the order back from its courier (it goes to the "without a courier" lane).
async function releaseAssignment(tenantId: string, actorUserId: string, orderId: string): Promise<void> {
  const courierId = await withTenant(tenantId, async (tx) => {
    const open = await fulfilmentRepo.findOpenAssignmentByOrder(tx, orderId);
    if (!open) throw new NotFoundError('This order has no courier assigned');
    await fulfilmentRepo.updateAssignment(tx, open.id, { status: 'released', closedAt: new Date() });
    await auditService.record(tx, { tenantId, actorUserId, entityType: 'order', entityId: orderId, action: 'delivery.released' });
    return open.courierId;
  });
  await announceDelivery(tenantId, orderId, 'released', courierId);
}

async function getOrderAssignments(tenantId: string, orderId: string): Promise<OrderAssignments> {
  const [rows, directory] = await Promise.all([
    withTenant(tenantId, (tx) => fulfilmentRepo.listAssignmentsByOrder(tx, orderId)),
    courierDirectory(tenantId),
  ]);
  const history = rows.map((row) => toView(row, directory));
  return { current: history.find((h) => ['assigned', 'accepted', 'picked_up'].includes(h.status)) ?? null, history };
}

// --- the courier's own actions --------------------------------------------------------------------------------------

// A courier can only touch an assignment that is theirs, whatever id they send.
async function requireOwnAssignment(tenantId: string, actor: Actor, assignmentId: string): Promise<CourierAssignment> {
  return withTenant(tenantId, async (tx) => {
    const row = await fulfilmentRepo.findAssignment(tx, assignmentId);
    if (!row) throw new NotFoundError('No such assignment');
    const courier = await fulfilmentRepo.findCourierByUser(tx, actor.id);
    if (!courier || courier.id !== row.courierId) {
      throw new ForbiddenError('This delivery was given to someone else', { reason: 'NOT_YOUR_DELIVERY' });
    }
    return row;
  });
}

async function accept(tenantId: string, actor: Actor, assignmentId: string): Promise<AssignmentView> {
  const row = await requireOwnAssignment(tenantId, actor, assignmentId);
  if (row.status === 'accepted') return toView(row, await courierDirectory(tenantId));
  if (row.status !== 'assigned') throw illegalAssignmentStep(row, 'accepted');
  const updated = await withTenant(tenantId, async (tx) => {
    const next = await fulfilmentRepo.updateAssignment(tx, row.id, { status: 'accepted', acceptedAt: new Date() });
    await auditService.record(tx, { tenantId, actorUserId: actor.id, entityType: 'order', entityId: row.orderId, action: 'delivery.accepted' });
    return next ?? row;
  });
  await announceDelivery(tenantId, row.orderId, 'accepted', row.courierId);
  return toView(updated, await courierDirectory(tenantId));
}

async function decline(tenantId: string, actor: Actor, assignmentId: string, note?: string): Promise<AssignmentView> {
  const row = await requireOwnAssignment(tenantId, actor, assignmentId);
  if (row.status === 'declined') return toView(row, await courierDirectory(tenantId));
  if (row.status !== 'assigned' && row.status !== 'accepted') throw illegalAssignmentStep(row, 'declined');
  const updated = await withTenant(tenantId, async (tx) => {
    const next = await fulfilmentRepo.updateAssignment(tx, row.id, { status: 'declined', note: note ?? null, closedAt: new Date() });
    await auditService.record(tx, { tenantId, actorUserId: actor.id, entityType: 'order', entityId: row.orderId, action: 'delivery.declined', note });
    return next ?? row;
  });
  await announceDelivery(tenantId, row.orderId, 'declined', row.courierId, { note });
  return toView(updated, await courierDirectory(tenantId));
}

// The courier has the box: the order moves to "out for delivery" (and the buyer is told). The order must already be
// prepared — a courier cannot take what the packer has not finished.
async function pickUp(tenantId: string, actor: Actor, assignmentId: string): Promise<AssignmentView> {
  const row = await requireOwnAssignment(tenantId, actor, assignmentId);
  if (row.status === 'picked_up') return toView(row, await courierDirectory(tenantId));
  if (row.status !== 'assigned' && row.status !== 'accepted') throw illegalAssignmentStep(row, 'picked_up');
  const order = await ordersService.getOrderForAdmin(tenantId, row.orderId);
  if (order.status !== 'preparing' && order.status !== 'out_for_delivery') {
    throw new ConflictError('This order is not ready to leave yet', { reason: 'ORDER_NOT_READY', status: order.status });
  }
  // The order first: if recording the pickup fails afterwards, a retry finds the order already on the road (a no-op).
  await ordersService.adminMarkOutForDelivery(tenantId, actor.id, row.orderId);
  const updated = await withTenant(tenantId, async (tx) => {
    const now = new Date();
    const next = await fulfilmentRepo.updateAssignment(tx, row.id, { status: 'picked_up', pickedUpAt: now, acceptedAt: row.acceptedAt ?? now });
    await auditService.record(tx, { tenantId, actorUserId: actor.id, entityType: 'order', entityId: row.orderId, action: 'delivery.picked_up' });
    return next ?? row;
  });
  await announceDelivery(tenantId, row.orderId, 'picked_up', row.courierId);
  return toView(updated, await courierDirectory(tenantId));
}

// The courier could not hand it over (nobody home, wrong address, ...). The order stays on the road; the store sees it
// in the "problems" lane and decides: give it to someone else, call the recipient, or cancel/refund.
async function fail(tenantId: string, actor: Actor, assignmentId: string, reason: DeliveryFailureReason, note?: string): Promise<AssignmentView> {
  const row = await requireOwnAssignment(tenantId, actor, assignmentId);
  if (row.status === 'failed') return toView(row, await courierDirectory(tenantId));
  if (row.status !== 'accepted' && row.status !== 'picked_up') throw illegalAssignmentStep(row, 'failed');
  const updated = await withTenant(tenantId, async (tx) => {
    const next = await fulfilmentRepo.updateAssignment(tx, row.id, { status: 'failed', reason, note: note ?? null, closedAt: new Date() });
    await auditService.record(tx, {
      tenantId,
      actorUserId: actor.id,
      entityType: 'order',
      entityId: row.orderId,
      action: 'delivery.failed',
      note: note ? `${reason}: ${note}` : reason,
    });
    return next ?? row;
  });
  await announceDelivery(tenantId, row.orderId, 'failed', row.courierId, { reason, note });
  return toView(updated, await courierDirectory(tenantId));
}

function illegalAssignmentStep(row: CourierAssignment, to: string): ConflictError {
  return new ConflictError(`This delivery is "${row.status}" and cannot become "${to}"`, {
    reason: 'ILLEGAL_ASSIGNMENT_STEP',
    from: row.status,
    to,
  });
}

// --- handing over ---------------------------------------------------------------------------------------------------

// Hand the order over: records who received it and moves the order to `delivered`. A store that requires a photo
// (settings.requireDeliveryPhoto) must have at least one ready photo first. Idempotent — a courier retrying after a
// dropped connection gets the recorded proof back. A courier can only deliver an order that was given to them; the
// owner and the packer can deliver any (the one-person shop that never dispatches).
async function confirmDelivery(
  tenantId: string,
  actorUserId: string,
  orderId: string,
  input: ConfirmDeliveryInput,
  actorRole?: string,
): Promise<DeliveryProof> {
  const order = await ordersService.getOrderForAdmin(tenantId, orderId);
  const isCourier = actorRole === 'courier';

  const own = await withTenant(tenantId, async (tx) => {
    const open = await fulfilmentRepo.findOpenAssignmentByOrder(tx, orderId);
    const courier = isCourier ? await fulfilmentRepo.findCourierByUser(tx, actorUserId) : undefined;
    return { open, courier };
  });
  if (isCourier && order.status !== 'delivered' && (!own.courier || own.open?.courierId !== own.courier.id)) {
    throw new ForbiddenError('This delivery was given to someone else', { reason: 'NOT_YOUR_DELIVERY' });
  }

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

  await withTenant(tenantId, async (tx) => {
    // The courier named on the delivery is whoever actually handed it over.
    const courierId = own.courier?.id ?? own.open?.courierId ?? null;
    await fulfilmentRepo.upsertDelivery(tx, {
      tenantId,
      orderId,
      deliveredByUserId: actorUserId,
      courierId: isCourier ? courierId : null,
      recipientNameConfirmed: input.recipientName || null,
      notes: input.notes ?? null,
      deliveredAt: new Date(),
    });
    if (own.open) {
      // Delivered by the assigned courier; if the store handed it over itself, the assignment just ends.
      const byAssignee = isCourier && own.courier?.id === own.open.courierId;
      await fulfilmentRepo.updateAssignment(tx, own.open.id, {
        status: byAssignee ? 'delivered' : 'released',
        closedAt: new Date(),
        pickedUpAt: own.open.pickedUpAt ?? new Date(),
      });
    }
  });
  await ordersService.adminMarkDelivered(tenantId, actorUserId, orderId, input.notes, { proofRecorded: true });

  const proof = await getProof(tenantId, orderId);
  if (!proof) throw new ConflictError('Delivery proof was not saved');
  return proof;
}

// --- lists ----------------------------------------------------------------------------------------------------------

// Latest assignment per order on screen, and (for a courier) none of the money or buyer details: a courier hands over a
// box; who paid and how the payment is going are not theirs to see.
async function decorate(tenantId: string, orders: AdminOrderListItem[], role: string): Promise<DispatchItem[]> {
  const [latest, directory] = await Promise.all([
    withTenant(tenantId, (tx) =>
      fulfilmentRepo.latestAssignmentsFor(
        tx,
        orders.map((o) => o.id),
      ),
    ),
    courierDirectory(tenantId),
  ]);
  const byOrder = new Map(latest.map((a) => [a.orderId, a]));
  return orders.map((order) => {
    const found = byOrder.get(order.id);
    const base = role === 'courier' ? { ...order, buyer: null, transferReported: false } : order;
    return { ...base, assignment: found ? toView(found, directory) : null };
  });
}

function emptyPage<T>(): Page<T> {
  return { items: [], nextCursor: null };
}

// A courier's own work (open assignments), or for the store everything that is out with someone.
async function pageMyDeliveries(tenantId: string, actor: Actor, page: PageQuery): Promise<Page<DispatchItem>> {
  const ids = await withTenant(tenantId, async (tx) => {
    if (actor.role !== 'courier') return fulfilmentRepo.listOpenOrderIds(tx);
    const courier = await fulfilmentRepo.findCourierByUser(tx, actor.id);
    return courier ? fulfilmentRepo.listOpenOrderIds(tx, courier.id) : [];
  });
  if (ids.length === 0) return emptyPage();
  const orders = await ordersService.pageOrdersForAdmin(tenantId, { statuses: DISPATCHABLE, onlyIds: ids }, page);
  return { items: await decorate(tenantId, orders.items, actor.role), nextCursor: orders.nextCursor };
}

// The dispatch board for the store: orders without a courier, orders with one, and orders whose last attempt went wrong.
async function pageBoard(tenantId: string, lane: BoardLane, page: PageQuery): Promise<Page<DispatchItem>> {
  const { open, problems } = await withTenant(tenantId, async (tx) => ({
    open: await fulfilmentRepo.listOpenOrderIds(tx),
    problems: await fulfilmentRepo.listProblemOrderIds(tx),
  }));
  let query: { statuses: OrderStatus[]; onlyIds?: string[]; excludeIds?: string[] };
  if (lane === 'assigned') {
    if (open.length === 0) return emptyPage();
    query = { statuses: DISPATCHABLE, onlyIds: open };
  } else if (lane === 'problems') {
    if (problems.length === 0) return emptyPage();
    query = { statuses: DISPATCHABLE, onlyIds: problems };
  } else {
    query = { statuses: DISPATCHABLE, excludeIds: [...open, ...problems] };
  }
  const orders = await ordersService.pageOrdersForAdmin(tenantId, query, page);
  return { items: await decorate(tenantId, orders.items, 'admin'), nextCursor: orders.nextCursor };
}

export const fulfilmentService = {
  getProof,
  confirmDelivery,
  listCouriers,
  assignCourier,
  releaseAssignment,
  getOrderAssignments,
  accept,
  decline,
  pickUp,
  fail,
  pageMyDeliveries,
  pageBoard,
};
