import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Redis is only used by the event bus and rate limiting; here the limiter gets
// an in-memory store and nothing should try to connect.
vi.mock('./core/queue.js', () => ({ redisConnection: {} }));

const readiness = vi.hoisted(() => ({
  current: { ok: true, checks: { postgres: 'ok', redis: 'ok', minio: 'ok' } } as {
    ok: boolean;
    checks: Record<string, string>;
  },
}));
vi.mock('./core/health.js', () => ({ checkReadiness: async () => readiness.current }));

// The assembled app over real HTTP, for everything that doesn't need a
// database: error shapes, tenant-header rules, headers, CORS, rate limits,
// metrics protection. (Flows that touch data are in app.integration.test.ts.)

describe('the assembled app', () => {
  let server: Server;
  let base: string;

  const METRICS_TOKEN = process.env.METRICS_TOKEN as string;
  const PLATFORM_KEY = process.env.PLATFORM_API_KEY as string;

  beforeAll(async () => {
    const { initSupertokens } = await import('./core/supertokens.js');
    const { createApp } = await import('./app.js');
    const { createMemoryStore } = await import('./core/rate-limit.js');

    initSupertokens();
    const app = createApp({ rateLimitStore: createMemoryStore() });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const errorOf = async (res: Response) =>
    ((await res.json()) as { error: { code: string; message: string; details?: unknown; requestId?: string } }).error;

  describe('errors are always JSON, with a request id', () => {
    it('answers an unknown route with a JSON 404, not an HTML page', async () => {
      const res = await fetch(`${base}/no/such/route`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toMatch(/json/);
      const error = await errorOf(res);
      expect(error.code).toBe('NOT_FOUND');
      // The id in the body is the id in the header, so a user can quote it.
      expect(error.requestId).toBe(res.headers.get('x-request-id'));
    });

    it('keeps a well-formed request id from upstream and replaces a hostile one', async () => {
      const ok = await fetch(`${base}/health`, { headers: { 'x-request-id': 'abc-12345678' } });
      expect(ok.headers.get('x-request-id')).toBe('abc-12345678');

      // (A newline can't be sent by fetch at all, so use other characters that
      // would be trouble in a log line or a header: markup, spaces, quotes.)
      const hostile = await fetch(`${base}/health`, { headers: { 'x-request-id': '<script>alert("x")</script> id' } });
      expect(hostile.headers.get('x-request-id')).not.toContain('script');
      expect(hostile.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('answers malformed JSON with 400, not 500', async () => {
      const res = await fetch(`${base}/tenancy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-platform-key': PLATFORM_KEY },
        body: '{"slug": ',
      });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe('BAD_REQUEST');
    });

    it('answers an oversized body with 413, not 500', async () => {
      const res = await fetch(`${base}/tenancy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-platform-key': PLATFORM_KEY },
        body: JSON.stringify({ slug: 'x', name: 'y'.repeat(200_000) }),
      });
      expect(res.status).toBe(413);
      expect((await errorOf(res)).code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('validation tells the client which field is wrong', () => {
    it('reports every problem with its location and path', async () => {
      const res = await fetch(`${base}/geo/provinces/not-a-uuid/municipalities`);
      expect(res.status).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details).toMatchObject({ issues: [{ location: 'params', path: 'id' }] });
    });

    it('reports several fields at once, from the body', async () => {
      const res = await fetch(`${base}/tenancy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-platform-key': PLATFORM_KEY },
        body: JSON.stringify({ slug: 'Not Valid!', name: '' }),
      });
      expect(res.status).toBe(400);
      const { details } = await errorOf(res);
      const paths = (details as { issues: Array<{ path: string }> }).issues.map((issue) => issue.path).sort();
      expect(paths).toEqual(['name', 'slug']);
    });

    it('does not echo the submitted values back', async () => {
      const res = await fetch(`${base}/tenancy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-platform-key': PLATFORM_KEY },
        body: JSON.stringify({ slug: 'SECRET-VALUE-HERE!', name: 'n' }),
      });
      expect(JSON.stringify(await res.json())).not.toContain('SECRET-VALUE-HERE');
    });
  });

  describe('store creation is a platform operation', () => {
    const create = (headers: Record<string, string>) =>
      fetch(`${base}/tenancy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ slug: 'nope', name: 'Nope' }),
      });

    it('refuses without the platform key, or with a wrong one', async () => {
      expect((await create({})).status).toBe(401);
      expect((await create({ 'x-platform-key': 'not-the-key-not-the-key-not-the-key' })).status).toBe(401);
    });
  });

  describe('the tenant header', () => {
    it('is required on store routes', async () => {
      const res = await fetch(`${base}/catalog/categories`);
      expect(res.status).toBe(401);
      expect((await errorOf(res)).message).toMatch(/tenant/i);
    });

    it('must look like a slug, before it is ever used in a query', async () => {
      const res = await fetch(`${base}/catalog/categories`, { headers: { 'x-tenant-slug': "demo'; drop table tenants;--" } });
      expect(res.status).toBe(400);
    });

    it('is not needed for reference data', async () => {
      const res = await fetch(`${base}/geo/provinces/not-a-uuid/municipalities`);
      expect(res.status).toBe(400); // reached validation, so it got past tenant resolution
    });
  });

  describe('authenticated routes refuse an anonymous caller', () => {
    it.each([
      ['GET', '/identity/me'],
      ['GET', '/recipients'],
      ['POST', '/orders/quote'],
      ['POST', '/catalog/products'],
      ['POST', '/geo/delivery-zones'],
      ['PATCH', '/tenancy/current'],
      ['POST', '/media/upload-url'],
      ['GET', '/media/manage'],
    ])('%s %s', async (method, path) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-tenant-slug': 'demo' },
        body: method === 'GET' ? undefined : '{}',
      });
      // Tenant lookup happens first; with no database it can only fail there,
      // which is fine — the point is that nothing here is ever a 2xx.
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('security headers', () => {
    it('sets the standard hardening headers and hides the framework', async () => {
      const res = await fetch(`${base}/health`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-powered-by')).toBeNull();
      expect(res.headers.get('strict-transport-security')).toBeTruthy();
    });
  });

  describe('CORS', () => {
    it('allows the custom headers the frontend sends, with credentials, from the web origin only', async () => {
      const res = await fetch(`${base}/cart`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-tenant-slug,x-cart-token',
        },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
      for (const header of ['x-tenant-slug', 'x-cart-token', 'content-type']) {
        expect(allowed).toContain(header);
      }
    });

    it('does not grant another origin credentialed access', async () => {
      const res = await fetch(`${base}/cart`, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      });
      expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
    });
  });

  describe('rate limiting', () => {
    it('limits cart writes per client, telling the caller when to retry', async () => {
      const post = () =>
        fetch(`${base}/cart/items`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
      // 60 allowed per minute (they fail on the missing tenant, which still counts).
      for (let i = 0; i < 60; i += 1) {
        expect((await post()).status).not.toBe(429);
      }
      const blocked = await post();
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await errorOf(blocked)).code).toBe('TOO_MANY_REQUESTS');
    });

    it('sets Retry-After on a 429 raised anywhere, not only by the per-IP middleware', async () => {
      const { errorHandler } = await import('./core/middleware/error.middleware.js');
      const { TooManyRequestsError } = await import('./core/errors.js');
      const express = (await import('express')).default;
      const app = express();
      app.get('/', () => {
        throw new TooManyRequestsError('slow down', { retryAfterSeconds: 42 });
      });
      app.use(errorHandler);
      const local = await new Promise<Server>((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      try {
        const res = await fetch(`http://127.0.0.1:${(local.address() as AddressInfo).port}/`);
        expect(res.status).toBe(429);
        expect(res.headers.get('retry-after')).toBe('42');
      } finally {
        await new Promise<void>((resolve) => local.close(() => resolve()));
      }
    });

    it('does not limit reading the cart with that same budget', async () => {
      const res = await fetch(`${base}/cart`, { headers: { 'x-tenant-slug': 'demo' } });
      expect(res.status).not.toBe(429);
    });
  });

  describe('metrics', () => {
    it('are closed without the token and open with it', async () => {
      expect((await fetch(`${base}/metrics`)).status).toBe(401);
      expect((await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer wrong-wrong-wrong-wrong' } })).status).toBe(401);
      const ok = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
      expect(ok.status).toBe(200);
    });

    it('label requests by route pattern, so random URLs cannot create endless series', async () => {
      for (const slug of ['aaa111', 'bbb222', 'ccc333']) {
        await fetch(`${base}/catalog/products/${slug}`, { headers: { 'x-tenant-slug': 'demo' } });
      }
      await fetch(`${base}/random-scanner-probe-9f8e7d`);

      const text = await (await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })).text();
      expect(text).toContain('path="/catalog/products/:slug"');
      expect(text).toContain('path="unmatched"');
      for (const leaked of ['aaa111', 'bbb222', 'ccc333', 'random-scanner-probe']) {
        expect(text).not.toContain(leaked);
      }
    });
  });

  describe('health and readiness', () => {
    it('/health says the process is up, and touches nothing', async () => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    });

    it('/ready is 200 when every dependency answers', async () => {
      readiness.current = { ok: true, checks: { postgres: 'ok', redis: 'ok', minio: 'ok' } };
      const res = await fetch(`${base}/ready`);
      expect(res.status).toBe(200);
    });

    it('/ready is 503, naming what is down, when one does not', async () => {
      readiness.current = { ok: false, checks: { postgres: 'ok', redis: 'failed', minio: 'ok' } };
      const res = await fetch(`${base}/ready`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ status: 'unavailable', checks: { redis: 'failed' } });
    });
  });
});
