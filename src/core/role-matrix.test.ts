import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UnauthorizedError } from './errors.js';

// Importing the routers pulls in modules that open a Redis connection on import; nothing here uses it.
vi.mock('./queue.js', () => ({ redisConnection: {} }));
// A caller who gets past the guards reaches a service and its database. There is none here, so make
// that fail at once instead of waiting for a connection: the test only cares about the guards.
vi.mock('../db/client.js', () => {
  const noDatabase = () => Promise.reject(new Error('no database in this test'));
  return { withTenant: noDatabase, sqlClient: {}, db: { transaction: noDatabase } };
});

// A session is a header: x-role says who is calling, no header means nobody is signed in. The role
// rules (requireRole, the per-route checks) are the real ones; only "who is this" is faked, so no
// database or SuperTokens is needed.
vi.mock('./middleware/tenant.middleware.js', () => ({
  resolveTenant: (req: Request, _res: Response, next: NextFunction) => {
    req.tenantId = '00000000-0000-4000-8000-000000000001';
    next();
  },
}));
vi.mock('./middleware/verified-email.middleware.js', () => ({
  requireVerifiedEmail: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('./middleware/auth.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const fakeSession = (req: Request) => {
    const role = req.header('x-role');
    if (role) req.authUser = { id: '00000000-0000-4000-8000-0000000000aa', role } as Request['authUser'];
    return role;
  };
  return {
    ...actual,
    requireAuth: (req: Request, _res: Response, next: NextFunction) =>
      next(fakeSession(req) ? undefined : new UnauthorizedError('No session')),
    optionalAuth: (req: Request, _res: Response, next: NextFunction) => {
      fakeSession(req);
      next();
    },
  };
});

const withoutQuery = (path: string): string => path.replace(/\?.*$/, '');

type Who = 'anon' | 'buyer' | 'courier' | 'staff' | 'admin';

const ID = '11111111-1111-4111-8111-111111111111';
const ADMIN: Who[] = ['admin'];
const STAFF_UP: Who[] = ['admin', 'staff'];
const FIELD: Who[] = ['admin', 'staff', 'courier'];
const COURIER: Who[] = ['courier'];
const SIGNED_IN: Who[] = ['admin', 'staff', 'courier', 'buyer'];
const EVERYONE: Who[] = ['anon', ...SIGNED_IN];
// An invalid body, so a caller who is let through stops at validation and nothing is ever written.
const BAD = { name: 123 };

// [method, path, body, who gets past the guards]. "Past the guards" means any answer other than
// 401/403 (400 from validation, 404 from a missing row, ...). What a route then does with a caller
// it let through is the module's own business and covered by its own tests.
const routes: Array<[string, string, unknown, Who[]]> = [
  ['GET', '/catalog/categories', undefined, EVERYONE],
  ['GET', '/catalog/admin/categories', undefined, STAFF_UP],
  ['POST', '/catalog/categories', BAD, ADMIN],
  ['PUT', '/catalog/categories/order', BAD, ADMIN],
  ['PATCH', `/catalog/categories/${ID}`, BAD, ADMIN],
  ['DELETE', `/catalog/categories/${ID}`, undefined, ADMIN],
  ['GET', '/catalog/admin/products', undefined, STAFF_UP],
  ['GET', '/catalog/admin/products-summary', undefined, STAFF_UP],
  ['GET', `/catalog/admin/products/${ID}`, undefined, STAFF_UP],
  ['POST', '/catalog/products', BAD, ADMIN],
  ['PUT', '/catalog/products/order', BAD, ADMIN],
  ['PATCH', `/catalog/products/${ID}`, BAD, STAFF_UP],
  ['POST', `/catalog/products/${ID}/activate`, undefined, STAFF_UP],
  ['POST', `/catalog/products/${ID}/deactivate`, undefined, STAFF_UP],
  ['DELETE', `/catalog/products/${ID}`, undefined, ADMIN],

  ['GET', '/geo/provinces', undefined, EVERYONE],
  ['GET', '/geo/delivery-zones', undefined, EVERYONE],
  ['GET', '/geo/admin/delivery-zones', undefined, ADMIN],
  ['POST', '/geo/delivery-zones', BAD, ADMIN],
  ['PATCH', `/geo/delivery-zones/${ID}`, BAD, ADMIN],

  ['GET', '/identity/me', undefined, SIGNED_IN],
  ['PATCH', '/identity/me', BAD, SIGNED_IN],
  // The in-app feed: everyone signed in has their own (every call is scoped to the caller).
  ['GET', '/notifications', undefined, SIGNED_IN],
  ['GET', '/notifications/unread-count', undefined, SIGNED_IN],
  ['POST', '/notifications/read', BAD, SIGNED_IN],
  ['GET', '/identity/team', undefined, ADMIN],
  ['POST', '/identity/team', BAD, ADMIN],
  ['PATCH', `/identity/team/${ID}`, { role: 'nope' }, ADMIN],
  ['POST', `/identity/team/${ID}/invite`, undefined, ADMIN],

  ['GET', '/tenancy/current', undefined, EVERYONE],
  ['GET', '/tenancy/admin/settings', undefined, ADMIN],
  ['PATCH', '/tenancy/current', BAD, ADMIN],

  ['GET', '/orders', undefined, SIGNED_IN],
  ['POST', '/orders/quote', BAD, SIGNED_IN],
  ['POST', '/orders/checkout', BAD, SIGNED_IN],
  ['GET', `/orders/${ID}`, undefined, SIGNED_IN],
  // Sharing an order's products: the buyer's own order (the service answers 404 for anyone else's); the public side
  // is open to whoever holds the link, and a malformed link stops at validation.
  ['GET', `/orders/${ID}/share`, undefined, SIGNED_IN],
  ['POST', `/orders/${ID}/share`, undefined, SIGNED_IN],
  ['DELETE', `/orders/${ID}/share`, undefined, SIGNED_IN],
  ['GET', '/shared/:token', undefined, EVERYONE],
  ['GET', `/orders/${ID}/payment-instructions`, undefined, SIGNED_IN],
  ['POST', `/orders/${ID}/transfer-report`, BAD, SIGNED_IN],
  ['POST', `/orders/${ID}/retry-payment`, undefined, SIGNED_IN],
  ['POST', `/orders/${ID}/cancel`, undefined, SIGNED_IN],
  ['GET', '/orders/admin/list', undefined, STAFF_UP],
  ['GET', '/orders/admin/counts', undefined, STAFF_UP],
  ['GET', '/orders/admin/stats?range=week', undefined, ADMIN],
  ['GET', `/orders/admin/${ID}`, undefined, STAFF_UP],
  // Money: only the owner. The packer moves an order along but never marks it paid, cancels or refunds.
  ['POST', `/orders/admin/${ID}/mark-paid`, undefined, ADMIN],
  ['POST', `/orders/admin/${ID}/preparing`, undefined, STAFF_UP],
  ['POST', `/orders/admin/${ID}/out-for-delivery`, undefined, STAFF_UP],
  ['POST', `/orders/admin/${ID}/delivered`, undefined, STAFF_UP],
  ['POST', `/orders/admin/${ID}/cancel`, undefined, ADMIN],
  ['POST', `/orders/admin/${ID}/refund`, undefined, ADMIN],

  ['GET', '/recipients', undefined, SIGNED_IN],
  ['POST', '/recipients', BAD, SIGNED_IN],
  ['GET', `/recipients/${ID}`, undefined, SIGNED_IN],
  ['DELETE', `/recipients/${ID}`, undefined, SIGNED_IN],

  ['PATCH', `/recipients/${ID}`, BAD, SIGNED_IN],
  ['POST', `/recipients/${ID}/addresses`, BAD, SIGNED_IN],
  ['PATCH', `/recipients/${ID}/addresses/${ID}`, BAD, SIGNED_IN],
  ['POST', `/recipients/${ID}/addresses/${ID}/default`, undefined, SIGNED_IN],
  ['DELETE', `/recipients/${ID}/addresses/${ID}`, undefined, SIGNED_IN],
  ['GET', `/geo/provinces/${ID}/municipalities`, undefined, EVERYONE],

  // The store's payment accounts: the public list shows names only; managing them is the owner's.
  ['GET', '/payments/methods', undefined, EVERYONE],
  ['GET', '/payments/admin/methods', undefined, ADMIN],
  ['POST', '/payments/methods', BAD, ADMIN],
  ['PUT', '/payments/methods/order', BAD, ADMIN],
  ['PATCH', `/payments/methods/${ID}`, BAD, ADMIN],
  ['DELETE', `/payments/methods/${ID}`, undefined, ADMIN],

  // Dispatch: the store gives orders out; a courier answers only for their own assignment (checked in the service).
  ['GET', '/fulfilment/couriers', undefined, STAFF_UP],
  ['GET', '/fulfilment/board?lane=nope', undefined, STAFF_UP],
  ['GET', `/fulfilment/orders/${ID}/assignment`, undefined, STAFF_UP],
  ['PUT', `/fulfilment/orders/${ID}/assignment`, BAD, STAFF_UP],
  ['DELETE', `/fulfilment/orders/${ID}/assignment`, undefined, STAFF_UP],
  ['GET', '/fulfilment/my-deliveries?limit=0', undefined, FIELD],
  ['POST', `/fulfilment/assignments/${ID}/accept`, undefined, COURIER],
  ['POST', `/fulfilment/assignments/${ID}/decline`, BAD, COURIER],
  ['POST', `/fulfilment/assignments/${ID}/pickup`, undefined, COURIER],
  ['POST', `/fulfilment/assignments/${ID}/failed`, BAD, COURIER],
  ['POST', `/fulfilment/orders/${ID}/deliver`, BAD, FIELD],
  ['GET', `/fulfilment/orders/${ID}/proof`, undefined, SIGNED_IN],

  // Media: the owner-type rules (a product's pictures are the admin's, a payment screenshot is not a
  // courier's, ...) run inside the handler after validation, so these need a well-formed body.
  ['POST', '/media/upload-url', undefined, SIGNED_IN],
];

describe('who may call what (role matrix over the real routers)', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const { errorHandler } = await import('./middleware/error.middleware.js');
    const [tenancy, identity, catalog, media, geo, orders, fulfilment, payments, notifications] = await Promise.all([
      import('../modules/tenancy/index.js'),
      import('../modules/identity/index.js'),
      import('../modules/catalog/index.js'),
      import('../modules/media/index.js'),
      import('../modules/geo/index.js'),
      import('../modules/orders/index.js'),
      import('../modules/fulfilment/index.js'),
      import('../modules/payments/index.js'),
      import('../modules/notifications/index.js'),
    ]);
    const app = express();
    app.use(express.json());
    app.use('/tenancy', tenancy.router);
    app.use('/identity', identity.router);
    app.use('/catalog', catalog.router);
    app.use('/media', media.router);
    app.use('/geo', geo.router);
    app.use('/orders', orders.router);
    app.use('/recipients', orders.recipientsRouter);
    app.use('/shared', orders.sharedRouter);
    app.use('/fulfilment', fulfilment.router);
    app.use('/payments', payments.router);
    app.use('/notifications', notifications.router);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => {
    server.close();
  });

  async function status(who: Who, method: string, path: string, body: unknown): Promise<number> {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(who === 'anon' ? {} : { 'x-role': who }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.status;
  }

  const everyone: Who[] = ['anon', 'buyer', 'courier', 'staff', 'admin'];

  for (const [method, path, body, allowed] of routes) {
    it(`${method} ${withoutQuery(path).replaceAll(ID, ':id')}: ${allowed.length === 5 ? 'everyone' : allowed.join(' + ')}`, async () => {
      for (const who of everyone) {
        const got = await status(who, method, path, body);
        if (allowed.includes(who)) {
          expect([401, 403], `${who} should get past the guards, got ${got}`).not.toContain(got);
        } else {
          // Signed-out callers are told to sign in (401); signed-in ones without the role are refused (403).
          expect(got, `${who} must be refused`).toBe(who === 'anon' ? 401 : 403);
        }
      }
    });
  }

  it("media: a picture's owner type decides who may touch it", async () => {
    const upload = (who: Who, ownerType: string, ownerId = ID) =>
      fetch(`${base}/media/upload-url`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-role': who },
        body: JSON.stringify({ ownerType, ownerId, contentType: 'image/webp' }),
      }).then((res) => res.status);
    // Product pictures and the store logo: the owner only.
    for (const who of ['buyer', 'courier', 'staff'] as const) {
      expect(await upload(who, 'product'), `${who} / product`).toBe(403);
      expect(await upload(who, 'tenant'), `${who} / tenant`).toBe(403);
    }
    // A delivery photo is for whoever hands the box over, never a buyer.
    expect(await upload('buyer', 'delivery')).toBe(403);
    // Payment screenshots are the store's and the buyer's own order's: never a courier's.
    expect(await upload('courier', 'payment_proof')).toBe(403);
    // A profile picture is its owner's alone (the fake caller's id is ...aa, not ID).
    expect(await upload('admin', 'user')).toBe(403);
    // No session at all.
    const anon = await fetch(`${base}/media/upload-url`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(anon.status).toBe(401);
  });

  it('lists every guarded route of the routers it mounts (a new route must be added to this matrix)', async () => {
    // Walks the real routers' layers and compares with the matrix, so adding an endpoint without
    // deciding who may call it fails here instead of going unnoticed.
    const [tenancy, identity, catalog, media, geo, orders, fulfilment, payments, notifications] = await Promise.all([
      import('../modules/tenancy/index.js'),
      import('../modules/identity/index.js'),
      import('../modules/catalog/index.js'),
      import('../modules/media/index.js'),
      import('../modules/geo/index.js'),
      import('../modules/orders/index.js'),
      import('../modules/fulfilment/index.js'),
      import('../modules/payments/index.js'),
      import('../modules/notifications/index.js'),
    ]);
    type Layer = { route?: { path: string; methods: Record<string, boolean> } };
    const mounted: Array<[string, express.Router]> = [
      ['/tenancy', tenancy.router],
      ['/identity', identity.router],
      ['/catalog', catalog.router],
      ['/media', media.router],
      ['/geo', geo.router],
      ['/orders', orders.router],
      ['/recipients', orders.recipientsRouter],
      ['/shared', orders.sharedRouter],
      ['/fulfilment', fulfilment.router],
      ['/payments', payments.router],
      ['/notifications', notifications.router],
    ];
    const shapeOf = (method: string, path: string) =>
      `${method} ${withoutQuery(path).replace(/:[A-Za-z]+/g, ':id').replaceAll(ID, ':id').replace(/(.)\/$/, '$1')}`;
    const covered = new Set(routes.map(([method, path]) => shapeOf(method, path)));
    const missing: string[] = [];
    for (const [prefix, router] of mounted) {
      for (const layer of (router as unknown as { stack: Layer[] }).stack) {
        if (!layer.route) continue;
        for (const method of Object.keys(layer.route.methods)) {
          const shape = shapeOf(method.toUpperCase(), prefix + layer.route.path);
          if (!covered.has(shape)) missing.push(shape);
        }
      }
    }
    // Left to other tests on purpose: store creation is gated by a platform key, not a role; the public
    // picture and product reads take no role at all; the by-id media routes load the picture from the
    // database before the owner rules run (covered by media's own tests and by the owner-type test above).
    expect(missing.sort()).toEqual(
      [
        'POST /tenancy',
        'POST /payments/webhooks/:id',
        'GET /media',
        'GET /media/:id',
        'PATCH /media/:id',
        'POST /media/:id/confirm',
        'POST /media/:id/cover',
        'PUT /media/order',
        'DELETE /media/:id',
        'GET /media/manage',
        'GET /catalog/products',
        'GET /catalog/products/:id',
      ].sort(),
    );
  });
});
