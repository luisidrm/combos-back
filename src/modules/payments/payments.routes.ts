import { Router } from 'express';
import { z } from 'zod';
import { NotFoundError } from '../../core/errors.js';
import { resolveTenant } from '../../core/middleware/tenant.middleware.js';
import { providerNameSchema } from './payments.schema.js';
import { paymentsService } from './payments.service.js';

export const paymentsRouter = Router();

// Which ways of paying this store offers, for the checkout to draw its choices. Public. The account
// details themselves are not here: they are shown only to the buyer of an order (orders module).
paymentsRouter.get('/methods', resolveTenant, (_req, res) => {
  res.json({ card: true, manual: paymentsService.listManualMethods(0).map((m) => ({ method: m.method, label: m.label })) });
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
