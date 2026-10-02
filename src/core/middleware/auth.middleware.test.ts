import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SessionRequest } from 'supertokens-node/framework/express/index.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { User } from '../../modules/identity/index.js';
import { UnauthorizedError } from '../errors.js';
import { createAuthMiddleware, requireRole } from './auth.middleware.js';
import { errorHandler } from './error.middleware.js';

// Importing the app's modules pulls in the event bus, which would open a Redis
// connection on import. Nothing here uses it.
vi.mock('../queue.js', () => ({ redisConnection: {} }));

// The rules that decide whether a session is good for THIS request, exercised
// with fake sessions so no SuperTokens core is needed. A real session is
// simulated by the x-fake-session header: {"userId","tenantId","role"}.

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function user(overrides: Partial<User> & Pick<User, 'supertokensUserId'>): User {
  return {
    id: `user-${overrides.supertokensUserId}`,
    tenantId: TENANT_A,
    email: 'someone@example.com',
    role: 'buyer',
    fullName: null,
    phone: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

// The "database": what loadUser finds for (tenant, supertokens id).
const users = new Map<string, User>([
  [`${TENANT_A}:buyer`, user({ supertokensUserId: 'buyer', role: 'buyer' })],
  [`${TENANT_A}:admin`, user({ supertokensUserId: 'admin', role: 'admin' })],
  [`${TENANT_A}:disabled`, user({ supertokensUserId: 'disabled', role: 'buyer', deletedAt: new Date() })],
  // The same person as `buyer`, but promoted since their token was issued.
  [`${TENANT_A}:promoted`, user({ supertokensUserId: 'promoted', role: 'admin' })],
  [`${TENANT_A}:demoted`, user({ supertokensUserId: 'demoted', role: 'buyer' })],
]);

function fakeSession(claims: { userId: string; tenantId?: string; role?: string }) {
  return {
    getUserId: () => claims.userId,
    getAccessTokenPayload: () => ({ tenantId: claims.tenantId, role: claims.role }),
  };
}

function parseFake(req: Request): ReturnType<typeof fakeSession> | undefined {
  const raw = req.header('x-fake-session');
  return raw ? fakeSession(JSON.parse(raw)) : undefined;
}

const verify: RequestHandler = (req, _res, next) => {
  const session = parseFake(req);
  if (!session) {
    next(new UnauthorizedError('unauthorised'));
    return;
  }
  (req as unknown as SessionRequest).session = session as unknown as SessionRequest['session'];
  next();
};

const verifyOptional: RequestHandler = (req, _res, next) => {
  const session = parseFake(req);
  if (session) (req as unknown as SessionRequest).session = session as unknown as SessionRequest['session'];
  next();
};

const auth = createAuthMiddleware({
  verify,
  verifyOptional,
  loadUser: async (tenantId, supertokensUserId) => users.get(`${tenantId}:${supertokensUserId}`),
});

describe('auth middleware', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.tenantId = req.header('x-tenant') ?? TENANT_A;
      next();
    });
    app.get('/private', auth.requireAuth, (req, res) => {
      res.json({ userId: req.authUser?.id });
    });
    app.get('/admin', auth.requireAuth, requireRole('admin'), (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/either', auth.optionalAuth, (req, res) => {
      res.json({ userId: req.authUser?.id ?? null, hasSession: Boolean((req as unknown as SessionRequest).session) });
    });
    app.use(errorHandler);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const call = (path: string, session?: object, tenant?: string) =>
    fetch(`${base}${path}`, {
      headers: {
        ...(session ? { 'x-fake-session': JSON.stringify(session) } : {}),
        ...(tenant ? { 'x-tenant': tenant } : {}),
      },
    });
  const reason = async (res: Response | globalThis.Response) =>
    ((await res.json()) as { error: { details?: { reason?: string } } }).error.details?.reason;

  describe('requireAuth', () => {
    it('lets a valid session through and exposes the freshly loaded user', async () => {
      const res = await call('/private', { userId: 'buyer', tenantId: TENANT_A, role: 'buyer' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ userId: 'user-buyer' });
    });

    it('passes a missing/invalid session on as the 401 the verifier raised', async () => {
      const res = await call('/private');
      expect(res.status).toBe(401);
    });

    it("refuses a session issued for another store, even with a real user and role", async () => {
      // An admin of store A calling store B's endpoints.
      const res = await call('/admin', { userId: 'admin', tenantId: TENANT_A, role: 'admin' }, TENANT_B);
      expect(res.status).toBe(403);
      expect(await reason(res)).toBe('WRONG_STORE');
    });

    it('refuses a token that carries no tenant at all', async () => {
      const res = await call('/private', { userId: 'buyer', role: 'buyer' });
      expect(res.status).toBe(403);
      expect(await reason(res)).toBe('WRONG_STORE');
    });

    it('refuses a session whose user has no account in this store', async () => {
      const res = await call('/private', { userId: 'stranger', tenantId: TENANT_A, role: 'buyer' });
      expect(res.status).toBe(403);
      expect(await reason(res)).toBe('NO_ACCOUNT');
    });

    it('refuses an account that was disabled after the session was issued', async () => {
      const res = await call('/private', { userId: 'disabled', tenantId: TENANT_A, role: 'buyer' });
      expect(res.status).toBe(403);
      expect(await reason(res)).toBe('ACCOUNT_DISABLED');
    });

    it('refuses a token whose role no longer matches the account (demotion takes effect at once)', async () => {
      // Token says admin; the account is a buyer now.
      const res = await call('/admin', { userId: 'demoted', tenantId: TENANT_A, role: 'admin' });
      expect(res.status).toBe(403);
      expect(await reason(res)).toBe('SESSION_STALE');
    });

    it('also refuses the reverse: a promoted user must log in again to act as admin', async () => {
      const res = await call('/admin', { userId: 'promoted', tenantId: TENANT_A, role: 'buyer' });
      expect(res.status).toBe(403);
      expect(await reason(res)).toBe('SESSION_STALE');
    });
  });

  describe('requireRole', () => {
    it('admits the right role and refuses the wrong one', async () => {
      const admin = await call('/admin', { userId: 'admin', tenantId: TENANT_A, role: 'admin' });
      expect(admin.status).toBe(200);
      const buyer = await call('/admin', { userId: 'buyer', tenantId: TENANT_A, role: 'buyer' });
      expect(buyer.status).toBe(403);
      expect(((await buyer.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    });
  });

  describe('optionalAuth', () => {
    it('treats no session as a guest', async () => {
      const res = await call('/either');
      expect(await res.json()).toEqual({ userId: null, hasSession: false });
    });

    it('uses a valid session', async () => {
      const res = await call('/either', { userId: 'buyer', tenantId: TENANT_A, role: 'buyer' });
      expect(await res.json()).toEqual({ userId: 'user-buyer', hasSession: true });
    });

    it.each([
      ['a session from another store', { userId: 'buyer', tenantId: TENANT_A, role: 'buyer' }, TENANT_B],
      ['a disabled account', { userId: 'disabled', tenantId: TENANT_A, role: 'buyer' }, undefined],
      ['an account with no row here', { userId: 'stranger', tenantId: TENANT_A, role: 'buyer' }, undefined],
      ['a stale role', { userId: 'demoted', tenantId: TENANT_A, role: 'admin' }, undefined],
    ])('falls back to guest, without an error, for %s', async (_label, session, tenant) => {
      const res = await call('/either', session, tenant);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ userId: null, hasSession: false });
    });
  });
});
