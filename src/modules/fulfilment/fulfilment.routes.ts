import { Router } from 'express';
import { requireAuth, requireRole } from '../../core/middleware/auth.middleware.js';
import { resolveTenant } from '../../core/middleware/tenant.middleware.js';
import { validate } from '../../core/middleware/validate.middleware.js';
import { currentUser, requireParam } from '../../core/request.js';
import { pageQuerySchema } from '../../core/pagination.js';
import { ordersService } from '../orders/index.js';
import {
  assignCourierSchema,
  assignmentParamSchema,
  boardQuerySchema,
  confirmDeliverySchema,
  declineAssignmentSchema,
  failDeliverySchema,
  orderParamSchema,
} from './fulfilment.schema.js';
import { fulfilmentService } from './fulfilment.service.js';

export const fulfilmentRouter = Router();

// Whoever hands the box over: the owner, the packer, or a courier.
const fieldStaff = [resolveTenant, requireAuth, requireRole('admin', 'staff', 'courier')];
// The store side of dispatch: who gets which order.
const dispatchers = [resolveTenant, requireAuth, requireRole('admin', 'staff')];
const couriersOnly = [resolveTenant, requireAuth, requireRole('courier')];
const signedIn = [resolveTenant, requireAuth];

// --- the store: dispatch ----------------------------------------------------------------------------------------------

// The team's couriers with how many orders each has right now (for the "give to" picker).
fulfilmentRouter.get('/couriers', ...dispatchers, async (req, res, next) => {
  try {
    res.json(await fulfilmentService.listCouriers(req.tenantId));
  } catch (err) {
    next(err);
  }
});

// The dispatch board: ?lane=unassigned|assigned|problems, paged.
fulfilmentRouter.get('/board', ...dispatchers, validate({ query: boardQuerySchema }), async (req, res, next) => {
  try {
    const { lane, ...page } = boardQuerySchema.parse(req.query);
    res.json(await fulfilmentService.pageBoard(req.tenantId, lane, page));
  } catch (err) {
    next(err);
  }
});

// The courier the order is with now, and every attempt before.
fulfilmentRouter.get('/orders/:orderId/assignment', ...dispatchers, validate({ params: orderParamSchema }), async (req, res, next) => {
  try {
    res.json(await fulfilmentService.getOrderAssignments(req.tenantId, requireParam(req, 'orderId')));
  } catch (err) {
    next(err);
  }
});

// Give the order to a courier (or move it to another one).
fulfilmentRouter.put(
  '/orders/:orderId/assignment',
  ...dispatchers,
  validate({ params: orderParamSchema, body: assignCourierSchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.json(await fulfilmentService.assignCourier(req.tenantId, user.id, requireParam(req, 'orderId'), req.body.courierId));
    } catch (err) {
      next(err);
    }
  },
);

// Take the order back from its courier.
fulfilmentRouter.delete('/orders/:orderId/assignment', ...dispatchers, validate({ params: orderParamSchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    await fulfilmentService.releaseAssignment(req.tenantId, user.id, requireParam(req, 'orderId'));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- the courier's day -------------------------------------------------------------------------------------------------

// A courier's own open deliveries; the owner and the packer see everything that is out. Paged.
fulfilmentRouter.get('/my-deliveries', ...fieldStaff, validate({ query: pageQuerySchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.json(await fulfilmentService.pageMyDeliveries(req.tenantId, user, pageQuerySchema.parse(req.query)));
  } catch (err) {
    next(err);
  }
});

// The courier's answers. Only a courier can send these, and only for an assignment that is theirs.
fulfilmentRouter.post('/assignments/:assignmentId/accept', ...couriersOnly, validate({ params: assignmentParamSchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.json(await fulfilmentService.accept(req.tenantId, user, requireParam(req, 'assignmentId')));
  } catch (err) {
    next(err);
  }
});

fulfilmentRouter.post(
  '/assignments/:assignmentId/decline',
  ...couriersOnly,
  validate({ params: assignmentParamSchema, body: declineAssignmentSchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.json(await fulfilmentService.decline(req.tenantId, user, requireParam(req, 'assignmentId'), req.body.note));
    } catch (err) {
      next(err);
    }
  },
);

fulfilmentRouter.post('/assignments/:assignmentId/pickup', ...couriersOnly, validate({ params: assignmentParamSchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.json(await fulfilmentService.pickUp(req.tenantId, user, requireParam(req, 'assignmentId')));
  } catch (err) {
    next(err);
  }
});

fulfilmentRouter.post(
  '/assignments/:assignmentId/failed',
  ...couriersOnly,
  validate({ params: assignmentParamSchema, body: failDeliverySchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.json(await fulfilmentService.fail(req.tenantId, user, requireParam(req, 'assignmentId'), req.body.reason, req.body.note));
    } catch (err) {
      next(err);
    }
  },
);

// Record who received the order (and the photo, uploaded beforehand through /media with owner type
// "delivery" and this order's id) and mark it delivered. A courier can only deliver what was given to them.
fulfilmentRouter.post(
  '/orders/:orderId/deliver',
  ...fieldStaff,
  validate({ params: orderParamSchema, body: confirmDeliverySchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.json(await fulfilmentService.confirmDelivery(req.tenantId, user.id, requireParam(req, 'orderId'), req.body, user.role));
    } catch (err) {
      next(err);
    }
  },
);

// The proof of delivery: the buyer reads it for their own order, store staff for any. `null` when
// none was recorded (yet).
fulfilmentRouter.get('/orders/:orderId/proof', ...signedIn, validate({ params: orderParamSchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const orderId = requireParam(req, 'orderId');
    if (user.role === 'buyer') {
      await ordersService.getOrderForBuyer(req.tenantId, user.id, orderId); // 404 unless it is theirs
    }
    res.json(await fulfilmentService.getProof(req.tenantId, orderId));
  } catch (err) {
    next(err);
  }
});
