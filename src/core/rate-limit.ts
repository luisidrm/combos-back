import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Redis } from 'ioredis';
import { TooManyRequestsError } from './errors.js';
import { logger } from './logger.js';

// Fixed-window rate limiting. The counting lives behind a tiny store so the
// real thing can be Redis (shared by every API instance) while tests use
// memory. Deliberately no extra dependency: this is a counter and a window.

export interface RateLimitStore {
  // Adds one hit to `key`'s current window and returns the hits so far. The
  // window starts at the first hit and lasts `windowSeconds`.
  increment(key: string, windowSeconds: number): Promise<{ count: number; retryAfterSeconds: number }>;
}

// Adding the hit and making sure the window has an expiry must be ONE step. The earlier version set the expiry with one
// command and counted with another: if the key expired in between, the count recreated it with no expiry at all, and
// that address was refused for ever (found when a dev machine stayed blocked for hours: the counter read 404 with a
// TTL of -1). Inside one script nothing can interleave. The expiry is set by the first hit only, so later hits cannot
// extend the window (which would let a steady trickle stay under the limit for ever); a counter that somehow has no
// expiry (TTL < 0, left by the old version) is repaired by the next hit.
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export function createRedisStore(redis: Redis): RateLimitStore {
  return {
    async increment(key, windowSeconds) {
      const [count, ttl] = (await redis.eval(HIT_SCRIPT, 1, key, windowSeconds)) as [number, number];
      return { count, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
    },
  };
}

export function createMemoryStore(now: () => number = Date.now): RateLimitStore {
  const windows = new Map<string, { count: number; resetsAt: number }>();
  return {
    async increment(key, windowSeconds) {
      const current = now();
      let entry = windows.get(key);
      if (!entry || entry.resetsAt <= current) {
        entry = { count: 0, resetsAt: current + windowSeconds * 1000 };
        windows.set(key, entry);
      }
      entry.count += 1;
      return { count: entry.count, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetsAt - current) / 1000)) };
    },
  };
}

export interface LimitRule {
  // Namespaces the counter, e.g. "otp-ip".
  name: string;
  limit: number;
  windowSeconds: number;
}

// How long a request will wait on the counter before giving up on it. Redis
// answers in a millisecond or two; anything near this is an outage. It matters
// because the shared Redis connection is configured to queue commands
// indefinitely while disconnected (BullMQ requires that), so without a limit a
// Redis stall would freeze every request rather than just the limiter.
const STORE_TIMEOUT_MS = 500;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rate limit store timed out after ${ms}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// Counts one hit and throws TooManyRequestsError past the limit. If the store
// itself fails or stalls (Redis down), it lets the request through and logs: a
// broken limiter must not take login and the storefront down with it.
export async function enforceLimit(
  store: RateLimitStore,
  rule: LimitRule,
  subject: string,
  timeoutMs: number = STORE_TIMEOUT_MS,
): Promise<void> {
  let result: { count: number; retryAfterSeconds: number };
  try {
    result = await withTimeout(store.increment(`rl:${rule.name}:${subject}`, rule.windowSeconds), timeoutMs);
  } catch (err) {
    logger.warn({ err, rule: rule.name }, 'Rate limit store unavailable; allowing the request');
    return;
  }
  if (result.count > rule.limit) {
    throw new TooManyRequestsError('Too many requests, please try again later', {
      retryAfterSeconds: result.retryAfterSeconds,
    });
  }
}

export interface RateLimiterOptions extends LimitRule {
  // What the counter is keyed on. Defaults to the client IP (correct behind a
  // proxy only if Express' `trust proxy` is set — see config TRUST_PROXY_HOPS).
  key?: (req: Request) => string;
  skip?: (req: Request) => boolean;
}

export function createRateLimiter(store: RateLimitStore) {
  return function rateLimit(options: RateLimiterOptions): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (options.skip?.(req)) {
        next();
        return;
      }
      const subject = options.key ? options.key(req) : (req.ip ?? 'unknown');
      enforceLimit(store, options, subject).then(
        () => next(),
        (err: unknown) => {
          if (err instanceof TooManyRequestsError) {
            const retryAfter = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
            if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
          }
          next(err);
        },
      );
    };
  };
}
