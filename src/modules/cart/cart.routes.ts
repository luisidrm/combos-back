import { Router, type Request } from 'express';
import { optionalAuth } from '../../core/middleware/auth.middleware.js';
import { resolveTenant } from '../../core/middleware/tenant.middleware.js';
import { validate } from '../../core/middleware/validate.middleware.js';
import { currentUserOrUndefined, requireParam } from '../../core/request.js';
import { addItemSchema, mergeCartSchema, productParamSchema, setQuantitySchema } from './cart.schema.js';
import { cartService, type CartActor } from './cart.service.js';

export const cartRouter = Router();

// Every cart route works for guests and buyers alike: resolveTenant, then
// optionalAuth (a session is used if there is one for this store, and a
// guest is fine otherwise).
const cartAccess = [resolveTenant, optionalAuth];

// Guest tokens are 32 random bytes as hex; anything else can't be one of
// ours, so it's ignored rather than looked up.
const GUEST_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

async function actorOf(req: Request): Promise<CartActor> {
  const user = await currentUserOrUndefined(req);
  const token = req.header('x-cart-token');
  return {
    userId: user?.id,
    guestToken: token && GUEST_TOKEN_PATTERN.test(token) ? token : undefined,
  };
}

cartRouter.get('/', ...cartAccess, async (req, res, next) => {
  try {
    res.json(await cartService.getCart(req.tenantId, await actorOf(req)));
  } catch (err) {
    next(err);
  }
});

cartRouter.post('/items', ...cartAccess, validate({ body: addItemSchema }), async (req, res, next) => {
  try {
    res.status(201).json(await cartService.addItem(req.tenantId, await actorOf(req), req.body));
  } catch (err) {
    next(err);
  }
});

// Idempotent: the client's locally persisted cart, sent on mount and after
// login. See cartService.mergeCart for the rule.
cartRouter.post('/merge', ...cartAccess, validate({ body: mergeCartSchema }), async (req, res, next) => {
  try {
    res.json(await cartService.mergeCart(req.tenantId, await actorOf(req), req.body));
  } catch (err) {
    next(err);
  }
});

cartRouter.patch(
  '/items/:productId',
  ...cartAccess,
  validate({ params: productParamSchema, body: setQuantitySchema }),
  async (req, res, next) => {
    try {
      const { quantity } = req.body;
      res.json(await cartService.setQuantity(req.tenantId, await actorOf(req), requireParam(req, 'productId'), quantity));
    } catch (err) {
      next(err);
    }
  },
);

cartRouter.delete('/items/:productId', ...cartAccess, validate({ params: productParamSchema }), async (req, res, next) => {
  try {
    res.json(await cartService.removeItem(req.tenantId, await actorOf(req), requireParam(req, 'productId')));
  } catch (err) {
    next(err);
  }
});

cartRouter.delete('/', ...cartAccess, async (req, res, next) => {
  try {
    res.json(await cartService.clearCart(req.tenantId, await actorOf(req)));
  } catch (err) {
    next(err);
  }
});
