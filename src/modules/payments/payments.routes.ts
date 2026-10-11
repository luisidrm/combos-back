import { Router } from 'express';
import { z } from 'zod';
import { NotFoundError } from '../../core/errors.js';
import { requireAuth, requireRole } from '../../core/middleware/auth.middleware.js';
import { resolveTenant } from '../../core/middleware/tenant.middleware.js';
import { validate } from '../../core/middleware/validate.middleware.js';
import { requireParam } from '../../core/request.js';
import {
  createManualMethodSchema,
  methodIdParamSchema,
  providerNameSchema,
  reorderMethodsSchema,
  updateManualMethodSchema,
} from './payments.schema.js';
import { paymentsService } from './payments.service.js';

export const paymentsRouter = Router();

// Which ways of paying this store offers, for the checkout to draw its choices. Public. The account
// details themselves are not here: they are shown only to the buyer of an order (orders module).
paymentsRouter.get('/methods', resolveTenant, async (req, res, next) => {
  try {
    const manual = await paymentsService.listManualMethods(req.tenantId, 0);
    res.json({ card: paymentsService.isCardEnabled(), manual: manual.map((m) => ({ id: m.id, kind: m.kind, label: m.label })) });
  } catch (err) {
    next(err);
  }
});

// The owner's Settings → Payments: the accounts buyers can send money to. Admin only: these are the store's
// payment details, and what a buyer is told to pay.
const adminOnly = [resolveTenant, requireAuth, requireRole('admin')];

paymentsRouter.get('/admin/methods', ...adminOnly, async (req, res, next) => {
  try {
    res.json(await paymentsService.listMethodsForAdmin(req.tenantId));
  } catch (err) {
    next(err);
  }
});

paymentsRouter.post('/methods', ...adminOnly, validate({ body: createManualMethodSchema }), async (req, res, next) => {
  try {
    res.status(201).json(await paymentsService.createManualMethod(req.tenantId, req.body));
  } catch (err) {
    next(err);
  }
});

// Declared before '/methods/:id' so "order" is never read as an id.
paymentsRouter.put('/methods/order', ...adminOnly, validate({ body: reorderMethodsSchema }), async (req, res, next) => {
  try {
    await paymentsService.reorderManualMethods(req.tenantId, req.body.ids);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

paymentsRouter.patch('/methods/:id', ...adminOnly, validate({ params: methodIdParamSchema, body: updateManualMethodSchema }), async (req, res, next) => {
  try {
    res.json(await paymentsService.updateManualMethod(req.tenantId, requireParam(req, 'id'), req.body));
  } catch (err) {
    next(err);
  }
});

paymentsRouter.delete('/methods/:id', ...adminOnly, validate({ params: methodIdParamSchema }), async (req, res, next) => {
  try {
    await paymentsService.deleteManualMethod(req.tenantId, requireParam(req, 'id'));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

const providerParamSchema = z.object({ provider: providerNameSchema });

// One route for every provider that has webhooks (today: TropiPay only —
// manual transfer has none, see ManualTransferProvider.verifyWebhook).
// app.ts mounts express.raw() ahead of this path specifically, so req.body
// here is the exact bytes the provider sent, not JSON already parsed and
// re-serialised — signature verification needs the original bytes.
//
// Every handler: signature-verified before any parsing, idempotent on the
// provider's own event id, and never trusts the reported amount over what
// the order was actually priced at (CLAUDE.md section 6) — all inside
// paymentsService.processWebhook. Always 200 once verified, whatever the
// outcome (a duplicate or a mismatch is a no-op, not an error the provider
// should retry).
paymentsRouter.post('/webhooks/:provider', async (req, res, next) => {
  try {
    const { provider } = providerParamSchema.parse({ provider: req.params.provider });
    await paymentsService.processWebhook(provider, req);
    res.status(200).json({ received: true });
  } catch (err) {
    // A route param that isn't a known provider is a 404, not the 400 a
    // bare zod failure would otherwise produce — there's no validate()
    // middleware here (this route intentionally skips express.json()).
    next(err instanceof z.ZodError ? new NotFoundError(`No such payment provider "${req.params.provider}"`) : err);
  }
});
