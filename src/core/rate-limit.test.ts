import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { TooManyRequestsError } from './errors.js';
import { errorHandler } from './middleware/error.middleware.js';
import { createMemoryStore, createRateLimiter, enforceLimit, type RateLimitStore } from './rate-limit.js';

const rule = { name: 'test', limit: 3, windowSeconds: 60 };

describe('enforceLimit', () => {
  it('allows up to the limit, then refuses, telling the caller how long to wait', async () => {
    const store = createMemoryStore();
    for (let i = 0; i < 3; i += 1) {
      await expect(enforceLimit(store, rule, 'a')).resolves.toBeUndefined();
    }
    const refused = await enforceLimit(store, rule, 'a').catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(TooManyRequestsError);
    expect((refused as TooManyRequestsError).details).toMatchObject({ retryAfterSeconds: expect.any(Number) });
  });

  it('counts each subject separately', async () => {
    const store = createMemoryStore();
    for (let i = 0; i < 3; i += 1) await enforceLimit(store, rule, 'a');
    await expect(enforceLimit(store, rule, 'b')).resolves.toBeUndefined();
  });

  it('counts each rule separately, even for the same subject', async () => {
    const store = createMemoryStore();
    for (let i = 0; i < 3; i += 1) await enforceLimit(store, rule, 'a');
    await expect(enforceLimit(store, { ...rule, name: 'other' }, 'a')).resolves.toBeUndefined();
  });

  it('starts a fresh window once the old one has passed', async () => {
    let now = 1_000_000;
    const store = createMemoryStore(() => now);
    for (let i = 0; i < 3; i += 1) await enforceLimit(store, rule, 'a');
    await expect(enforceLimit(store, rule, 'a')).rejects.toBeInstanceOf(TooManyRequestsError);

    now += 61_000;
    await expect(enforceLimit(store, rule, 'a')).resolves.toBeUndefined();
  });

  it('does not let a steady trickle stretch the window', async () => {
    let now = 0;
    const store = createMemoryStore(() => now);
    await enforceLimit(store, rule, 'a');
    now += 59_000;
    await enforceLimit(store, rule, 'a');
    now += 2_000; // 61s after the FIRST hit: the window is over
    const { count } = await store.increment('rl:test:a', 60);
    expect(count).toBe(1);
  });

  it('lets requests through when the store is down, rather than locking everyone out', async () => {
    const broken: RateLimitStore = {
      increment: () => Promise.reject(new Error('redis is down')),
    };
    await expect(enforceLimit(broken, rule, 'a')).resolves.toBeUndefined();
  });

  it('does not hang when the store stalls — Redis that never answers must not freeze every request', async () => {
    const stalled: RateLimitStore = { increment: () => new Promise(() => undefined) };
    const started = Date.now();
    await expect(enforceLimit(stalled, rule, 'a', 50)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('rateLimit middleware', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function start(app: express.Express): Promise<string> {
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('answers 429 with a JSON body and a Retry-After header past the limit', async () => {
    const rateLimit = createRateLimiter(createMemoryStore());
    const app = express();
    app.use(rateLimit({ name: 'http', limit: 2, windowSeconds: 30 }));
    app.get('/', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);
    const base = await start(app);

    expect((await fetch(base)).status).toBe(200);
    expect((await fetch(base)).status).toBe(200);
    const blocked = await fetch(base);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await blocked.json()).toMatchObject({ error: { code: 'TOO_MANY_REQUESTS' } });
  });

  it('can be keyed on something other than the IP, and can skip requests', async () => {
    const rateLimit = createRateLimiter(createMemoryStore());
    const app = express();
    app.use(
      rateLimit({
        name: 'keyed',
        limit: 1,
        windowSeconds: 30,
        key: (req) => req.header('x-user') ?? 'anon',
        skip: (req) => req.method === 'GET',
      }),
    );
    app.all('/', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);
    const base = await start(app);

    const post = (user: string) => fetch(base, { method: 'POST', headers: { 'x-user': user } });
    expect((await post('alice')).status).toBe(200);
    expect((await post('alice')).status).toBe(429);
    expect((await post('bob')).status).toBe(200);
    // GETs are skipped entirely, however many.
    for (let i = 0; i < 5; i += 1) expect((await fetch(base)).status).toBe(200);
  });
});
