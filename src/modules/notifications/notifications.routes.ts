import { Router } from 'express';
import { requireAuth } from '../../core/middleware/auth.middleware.js';
import { resolveTenant } from '../../core/middleware/tenant.middleware.js';
import { validate } from '../../core/middleware/validate.middleware.js';
import { currentUser } from '../../core/request.js';
import { markReadSchema, notificationsQuerySchema } from './notifications.schema.js';
import { notificationsService } from './notifications.service.js';

export const notificationsRouter = Router();

// Everyone signed in has their own feed (a buyer's order updates, the store's alerts, a courier's new deliveries).
// Every call is scoped to the caller: there is no way to read or change someone else's.
const signedIn = [resolveTenant, requireAuth];

notificationsRouter.get('/', ...signedIn, validate({ query: notificationsQuerySchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const { cursor, limit, unread } = req.query as unknown as { cursor?: string; limit: number; unread?: 'true' | 'false' };
    res.json(await notificationsService.pageForUser(req.tenantId, user.id, { cursor, limit }, unread === 'true'));
  } catch (err) {
    next(err);
  }
});

notificationsRouter.get('/unread-count', ...signedIn, async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.json({ count: await notificationsService.unreadCount(req.tenantId, user.id) });
  } catch (err) {
    next(err);
  }
});

// Body `{ ids: [...] }` or `{ all: true }`.
notificationsRouter.post('/read', ...signedIn, validate({ body: markReadSchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const body = req.body as { ids?: string[]; all?: true };
    await notificationsService.markRead(req.tenantId, user.id, body.all ? 'all' : (body.ids ?? []));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
