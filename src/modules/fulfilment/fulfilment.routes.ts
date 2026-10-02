import { Router } from 'express';
import { requireAuth, requireRole } from '../../core/middleware/auth.middleware.js';
import { resolveTenant } from '../../core/middleware/tenant.middleware.js';
import { validate } from '../../core/middleware/validate.middleware.js';
import { currentUser, requireParam } from '../../core/request.js';
import { ordersService } from '../orders/index.js';
import { confirmDeliverySchema, orderParamSchema } from './fulfilment.schema.js';
import { fulfilmentService } from './fulfilment.service.js';

export const fulfilmentRouter = Router();

// Whoever hands the box over: the owner, the packer, or a courier.
const fieldStaff = [resolveTenant, requireAuth, requireRole('admin', 'staff', 'courier')];
const signedIn = [resolveTenant, requireAuth];

// The orders out for delivery, for the courier's day.
fulfilmentRouter.get('/queue', ...fieldStaff, async (req, res, next) => {
  try {
    res.json(await fulfilmentService.listQueue(req.tenantId));
  } catch (err) {
    next(err);
  }
});

// Record who received the order (and the photo, uploaded beforehand through /media with owner type
// "delivery" and this order's id) and mark it delivered.
fulfilmentRouter.post(
  '/orders/:orderId/deliver',
  ...fieldStaff,
  validate({ params: orderParamSchema, body: confirmDeliverySchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.json(await fulfilmentService.confirmDelivery(req.tenantId, user.id, requireParam(req, 'orderId'), req.body));
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
