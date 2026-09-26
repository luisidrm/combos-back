import { Router } from 'express';
import { requireAuth } from '../../core/middleware/auth.middleware.js';
import { resolveTenant } from '../../core/middleware/tenant.middleware.js';
import { validate } from '../../core/middleware/validate.middleware.js';
import { currentUser, requireParam } from '../../core/request.js';
import {
  addressParamSchema,
  createAddressSchema,
  createRecipientSchema,
  quoteSchema,
  recipientParamSchema,
  updateAddressSchema,
  updateRecipientSchema,
} from './orders.schema.js';
import { ordersService } from './orders.service.js';

export const ordersRouter = Router();

// TODO: mount the order endpoints (checkout, the state machine) here in M3.

// Price a checkout for a chosen recipient address: cart + delivery fee, and
// the reasons (if any) it can't go ahead. Signed-in buyers only, since the
// address book is theirs. Read-only.
ordersRouter.post('/quote', resolveTenant, requireAuth, validate({ body: quoteSchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.json(await ordersService.quote(req.tenantId, user.id, req.body));
  } catch (err) {
    next(err);
  }
});

// The buyer's address book. It lives in the orders module (CLAUDE.md
// section 4) but is mounted at /recipients, which reads better than
// /orders/recipients. Signed-in buyers only — each sees just their own.
export const recipientsRouter = Router();

const signedIn = [resolveTenant, requireAuth];

recipientsRouter.get('/', ...signedIn, async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.json(await ordersService.listRecipients(req.tenantId, user.id));
  } catch (err) {
    next(err);
  }
});

recipientsRouter.post('/', ...signedIn, validate({ body: createRecipientSchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.status(201).json(await ordersService.createRecipient(req.tenantId, user.id, req.body));
  } catch (err) {
    next(err);
  }
});

recipientsRouter.get('/:id', ...signedIn, validate({ params: recipientParamSchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.json(await ordersService.getRecipient(req.tenantId, user.id, requireParam(req, 'id')));
  } catch (err) {
    next(err);
  }
});

recipientsRouter.patch(
  '/:id',
  ...signedIn,
  validate({ params: recipientParamSchema, body: updateRecipientSchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.json(await ordersService.updateRecipient(req.tenantId, user.id, requireParam(req, 'id'), req.body));
    } catch (err) {
      next(err);
    }
  },
);

recipientsRouter.delete('/:id', ...signedIn, validate({ params: recipientParamSchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    await ordersService.deleteRecipient(req.tenantId, user.id, requireParam(req, 'id'));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

recipientsRouter.post(
  '/:id/addresses',
  ...signedIn,
  validate({ params: recipientParamSchema, body: createAddressSchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.status(201).json(await ordersService.addAddress(req.tenantId, user.id, requireParam(req, 'id'), req.body));
    } catch (err) {
      next(err);
    }
  },
);

recipientsRouter.patch(
  '/:id/addresses/:addressId',
  ...signedIn,
  validate({ params: addressParamSchema, body: updateAddressSchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.json(
        await ordersService.updateAddress(
          req.tenantId,
          user.id,
          requireParam(req, 'id'),
          requireParam(req, 'addressId'),
          req.body,
        ),
      );
    } catch (err) {
      next(err);
    }
  },
);

recipientsRouter.post(
  '/:id/addresses/:addressId/default',
  ...signedIn,
  validate({ params: addressParamSchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.json(
        await ordersService.setDefaultAddress(req.tenantId, user.id, requireParam(req, 'id'), requireParam(req, 'addressId')),
      );
    } catch (err) {
      next(err);
    }
  },
);

recipientsRouter.delete(
  '/:id/addresses/:addressId',
  ...signedIn,
  validate({ params: addressParamSchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      await ordersService.deleteAddress(req.tenantId, user.id, requireParam(req, 'id'), requireParam(req, 'addressId'));
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);
