import { Router } from 'express';
import { optionalAuth, requireAuth, requireRole } from '../../core/middleware/auth.middleware.js';
import { resolveTenant } from '../../core/middleware/tenant.middleware.js';
import { requireVerifiedEmail } from '../../core/middleware/verified-email.middleware.js';
import { validate } from '../../core/middleware/validate.middleware.js';
import type { PageQuery } from '../../core/pagination.js';
import { currentUser, requireParam } from '../../core/request.js';
import {
  addressParamSchema,
  adminOrdersQuerySchema,
  buyerOrdersQuerySchema,
  checkoutSchema,
  createAddressSchema,
  createRecipientSchema,
  orderIdParamSchema,
  quoteSchema,
  recipientParamSchema,
  shareTokenParamSchema,
  statsQuerySchema,
  transferReportSchema,
  transitionNoteSchema,
  updateAddressSchema,
  updateRecipientSchema,
} from './orders.schema.js';
import { ordersService } from './orders.service.js';
import type { OrderStatus } from './orders.schema.js';

export const ordersRouter = Router();

const signedInBuyer = [resolveTenant, requireAuth];
// Money moves here: receipts and payment notices go to the buyer's email, so it
// has to be one they confirmed.
const verifiedBuyer = [resolveTenant, requireAuth, requireVerifiedEmail];
const adminOnly = [resolveTenant, requireAuth, requireRole('admin')];
// The packer (staff) works the queue — reads orders and moves them along — but never touches money.
const staffOrAdmin = [resolveTenant, requireAuth, requireRole('admin', 'staff')];

// Price a checkout for a chosen recipient address: cart + delivery fee, and
// the reasons (if any) it can't go ahead. Signed-in buyers only, since the
// address book is theirs. Read-only.
ordersRouter.post('/quote', ...signedInBuyer, validate({ body: quoteSchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.json(await ordersService.quote(req.tenantId, user.id, req.body));
  } catch (err) {
    next(err);
  }
});

// Places the order and, if the chosen provider's checkout call succeeds
// right away, returns where to send the buyer to pay. A null checkoutUrl
// means the order exists (pending_payment) but starting the payment session
// failed — POST /orders/:id/retry-payment tries again.
ordersRouter.post('/checkout', ...verifiedBuyer, validate({ body: checkoutSchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.status(201).json(await ordersService.checkout(req.tenantId, user.id, req.body));
  } catch (err) {
    next(err);
  }
});

// The buyer's own orders, newest first, one page at a time (?cursor=&limit=).
ordersRouter.get('/', ...signedInBuyer, validate({ query: buyerOrdersQuerySchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const { scope, cursor, limit } = req.query as unknown as { scope?: 'active' | 'past' } & PageQuery;
    res.json(await ordersService.pageOrdersForBuyer(req.tenantId, user.id, { cursor, limit }, scope));
  } catch (err) {
    next(err);
  }
});

// How to pay a manual-transfer order (the accounts, the exact amount, the reference). null for card orders.
ordersRouter.get('/:id/payment-instructions', ...signedInBuyer, validate({ params: orderIdParamSchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.json(await ordersService.getPaymentInstructions(req.tenantId, user.id, requireParam(req, 'id')));
  } catch (err) {
    next(err);
  }
});

// "I sent it": which app, the confirmation number, a note. A screenshot must already be uploaded
// (media owner type "payment_proof", owner id = the order). An admin then checks and marks it paid.
ordersRouter.post(
  '/:id/transfer-report',
  ...signedInBuyer,
  validate({ params: orderIdParamSchema, body: transferReportSchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.status(201).json(await ordersService.reportTransfer(req.tenantId, user.id, requireParam(req, 'id'), req.body));
    } catch (err) {
      next(err);
    }
  },
);

// Sharing the products of an order by link (the buyer's own order only; 404 for anyone else's).
ordersRouter.get('/:id/share', ...signedInBuyer, validate({ params: orderIdParamSchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.json(await ordersService.getShare(req.tenantId, user.id, requireParam(req, 'id')));
  } catch (err) {
    next(err);
  }
});

ordersRouter.post('/:id/share', ...signedInBuyer, validate({ params: orderIdParamSchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.json(await ordersService.enableShare(req.tenantId, user.id, requireParam(req, 'id')));
  } catch (err) {
    next(err);
  }
});

ordersRouter.delete('/:id/share', ...signedInBuyer, validate({ params: orderIdParamSchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    await ordersService.disableShare(req.tenantId, user.id, requireParam(req, 'id'));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

ordersRouter.get('/:id', ...signedInBuyer, validate({ params: orderIdParamSchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.json(await ordersService.getOrderForBuyer(req.tenantId, user.id, requireParam(req, 'id')));
  } catch (err) {
    next(err);
  }
});

ordersRouter.post(
  '/:id/retry-payment',
  ...signedInBuyer,
  validate({ params: orderIdParamSchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.json(await ordersService.retryPayment(req.tenantId, user.id, requireParam(req, 'id')));
    } catch (err) {
      next(err);
    }
  },
);

// A buyer may only back out before paying (see the transition table in
// orders.service) — cancelling money that already changed hands is a refund,
// an admin action.
ordersRouter.post(
  '/:id/cancel',
  ...signedInBuyer,
  validate({ params: orderIdParamSchema, body: transitionNoteSchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.json(await ordersService.cancelByBuyer(req.tenantId, user.id, requireParam(req, 'id'), req.body.note));
    } catch (err) {
      next(err);
    }
  },
);

// --- admin ------------------------------------------------------------------

// The queue, newest first, one page at a time. Filters and search run on the server: `?status=`, `?filter=transfer`,
// `?q=` (order number, recipient, buyer), `?cursor=&limit=`. Declared before /admin/:id so these names are never read as ids.
ordersRouter.get('/admin/list', ...staffOrAdmin, validate({ query: adminOrdersQuerySchema }), async (req, res, next) => {
  try {
    const { status, filter, q, cursor, limit } = req.query as unknown as { status?: OrderStatus; filter?: 'transfer'; q?: string } & PageQuery;
    res.json(await ordersService.pageOrdersForAdmin(req.tenantId, { status, filter, q }, { cursor, limit }));
  } catch (err) {
    next(err);
  }
});

// How many orders each status has (and how many transfers wait to be checked): the numbers on the queue's chips.
ordersRouter.get('/admin/counts', ...staffOrAdmin, async (req, res, next) => {
  try {
    res.json(await ordersService.adminOrderCounts(req.tenantId));
  } catch (err) {
    next(err);
  }
});

// Sales figures (admin only). Declared before /admin/:id so "stats" is not read as an order id.
ordersRouter.get('/admin/stats', ...adminOnly, validate({ query: statsQuerySchema }), async (req, res, next) => {
  try {
    const { range } = req.query as unknown as { range: 'week' | 'month' | 'year' };
    res.json(await ordersService.getSalesStats(req.tenantId, range));
  } catch (err) {
    next(err);
  }
});

ordersRouter.get('/admin/:id', ...staffOrAdmin, validate({ params: orderIdParamSchema }), async (req, res, next) => {
  try {
    res.json(await ordersService.getOrderForAdmin(req.tenantId, requireParam(req, 'id')));
  } catch (err) {
    next(err);
  }
});

// An operator's manual override — "I can see in my TropiPay dashboard (or my
// bank) that this was paid" — for any provider, not only manual transfer,
// since a missed webhook is exactly the kind of gap this exists to cover.
ordersRouter.post(
  '/admin/:id/mark-paid',
  ...adminOnly,
  validate({ params: orderIdParamSchema, body: transitionNoteSchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.json(await ordersService.adminMarkPaid(req.tenantId, user.id, requireParam(req, 'id'), req.body.note));
    } catch (err) {
      next(err);
    }
  },
);

ordersRouter.post(
  '/admin/:id/preparing',
  ...staffOrAdmin,
  validate({ params: orderIdParamSchema, body: transitionNoteSchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.json(await ordersService.adminMarkPreparing(req.tenantId, user.id, requireParam(req, 'id'), req.body.note));
    } catch (err) {
      next(err);
    }
  },
);

ordersRouter.post(
  '/admin/:id/out-for-delivery',
  ...staffOrAdmin,
  validate({ params: orderIdParamSchema, body: transitionNoteSchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.json(await ordersService.adminMarkOutForDelivery(req.tenantId, user.id, requireParam(req, 'id'), req.body.note));
    } catch (err) {
      next(err);
    }
  },
);

ordersRouter.post(
  '/admin/:id/delivered',
  ...staffOrAdmin,
  validate({ params: orderIdParamSchema, body: transitionNoteSchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.json(await ordersService.adminMarkDelivered(req.tenantId, user.id, requireParam(req, 'id'), req.body.note));
    } catch (err) {
      next(err);
    }
  },
);

ordersRouter.post(
  '/admin/:id/cancel',
  ...adminOnly,
  validate({ params: orderIdParamSchema, body: transitionNoteSchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.json(await ordersService.adminCancel(req.tenantId, user.id, requireParam(req, 'id'), req.body.note));
    } catch (err) {
      next(err);
    }
  },
);

// Full refund only for M3 — always the order's own total (see
// ordersService.refund). Calls out to the payment provider before writing
// anything, so a provider-side rejection leaves the order untouched.
ordersRouter.post(
  '/admin/:id/refund',
  ...adminOnly,
  validate({ params: orderIdParamSchema, body: transitionNoteSchema }),
  async (req, res, next) => {
    try {
      const user = await currentUser(req);
      res.json(await ordersService.refund(req.tenantId, user.id, requireParam(req, 'id'), req.body.note));
    } catch (err) {
      next(err);
    }
  },
);

// The buyer's address book. It lives in the orders module (CLAUDE.md
// section 4) but is mounted at /recipients, which reads better than
// /orders/recipients. Signed-in buyers only — each sees just their own.
export const recipientsRouter = Router();

// --- the public side of a share link (mounted at /shared) ---------------------------------------------------------
//
// Open to anyone who holds the link, signed in or not (a session, if there is one, only decides whether the visitor
// is store staff, who also learn which order it is so the web app can send them to it in the admin).
export const sharedRouter = Router();

sharedRouter.get('/:token', resolveTenant, optionalAuth, validate({ params: shareTokenParamSchema }), async (req, res, next) => {
  try {
    res.json(await ordersService.getSharedOrder(req.tenantId, requireParam(req, 'token'), req.authUser?.role));
  } catch (err) {
    next(err);
  }
});

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
