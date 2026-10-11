import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedisStore } from './rate-limit.js';

// The Redis counter, against a real Redis (the Lua script cannot be checked with a fake). Skipped unless TEST_REDIS_URL
// is set; CI sets it. Locally:  TEST_REDIS_URL=redis://127.0.0.1:6380 npm test
const url = process.env.TEST_REDIS_URL;

describe.skipIf(!url)('the Redis rate-limit counter', () => {
  let redis: Redis;
  const prefix = `rl-test:${crypto.randomUUID()}:`;

  beforeAll(() => {
    redis = new Redis(url as string, { maxRetriesPerRequest: 2 });
  });
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it('counts hits and starts the window with the first one', async () => {
    const store = createRedisStore(redis);
    const first = await store.increment(`${prefix}a`, 60);
    expect(first.count).toBe(1);
    expect(first.retryAfterSeconds).toBeGreaterThan(55);
    expect((await store.increment(`${prefix}a`, 60)).count).toBe(2);
    expect(await redis.ttl(`${prefix}a`)).toBeGreaterThan(0);
  });

  it('never extends the window with later hits (a trickle must not stay under the limit for ever)', async () => {
    const store = createRedisStore(redis);
    await store.increment(`${prefix}b`, 60);
    await redis.expire(`${prefix}b`, 5);
    await store.increment(`${prefix}b`, 60);
    expect(await redis.ttl(`${prefix}b`)).toBeLessThanOrEqual(5);
  });

  it('counts simultaneous hits exactly, and every counter ends up with an expiry', async () => {
    const store = createRedisStore(redis);
    const hits = await Promise.all(Array.from({ length: 50 }, () => store.increment(`${prefix}c`, 60)));
    expect(Math.max(...hits.map((h) => h.count))).toBe(50);
    expect(new Set(hits.map((h) => h.count)).size).toBe(50);
    expect(await redis.ttl(`${prefix}c`)).toBeGreaterThan(0);
  });

  it('repairs a counter that has no expiry (the state that once locked an address out for ever)', async () => {
    const store = createRedisStore(redis);
    await redis.set(`${prefix}stuck`, 404); // no EX: a counter that would never reset
    expect(await redis.ttl(`${prefix}stuck`)).toBe(-1);
    const hit = await store.increment(`${prefix}stuck`, 60);
    expect(hit.count).toBe(405);
    expect(await redis.ttl(`${prefix}stuck`)).toBeGreaterThan(0);
  });

  it('a window that has expired starts again from one', async () => {
    const store = createRedisStore(redis);
    await store.increment(`${prefix}d`, 1);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect((await store.increment(`${prefix}d`, 60)).count).toBe(1);
  });
});
