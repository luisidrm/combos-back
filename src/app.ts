import cors from 'cors';
import express from 'express';
import promBundle from 'express-prom-bundle';
import helmet from 'helmet';
import supertokens from 'supertokens-node';
import {
  errorHandler as supertokensErrorHandler,
  middleware as supertokensMiddleware,
} from 'supertokens-node/framework/express/index.js';
import { config } from './config/index.js';
import { checkReadiness } from './core/health.js';
import { errorHandler, notFoundHandler } from './core/middleware/error.middleware.js';
import { metricsGuard, metricsRoute } from './core/middleware/metrics.middleware.js';
import { requestId } from './core/middleware/request-id.middleware.js';
import { redisConnection } from './core/queue.js';
import { createRateLimiter, createRedisStore, type RateLimitStore } from './core/rate-limit.js';

import { router as auditRouter } from './modules/audit/index.js';
import { router as cartRouter } from './modules/cart/index.js';
import { router as catalogRouter } from './modules/catalog/index.js';
import { router as fulfilmentRouter } from './modules/fulfilment/index.js';
import { router as geoRouter } from './modules/geo/index.js';
import { router as identityRouter } from './modules/identity/index.js';
import { router as mediaRouter } from './modules/media/index.js';
import { router as notificationsRouter } from './modules/notifications/index.js';
import { recipientsRouter, router as ordersRouter } from './modules/orders/index.js';
import { router as paymentsRouter } from './modules/payments/index.js';
import { router as tenancyRouter } from './modules/tenancy/index.js';

export interface AppOptions {
  // Where rate-limit counters live. Redis in production (shared across
  // instances); tests pass an in-memory store.
  rateLimitStore?: RateLimitStore;
}

// Builds the Express app without listening, so tests can drive the real
// thing over HTTP. SuperTokens must already be initialised (main.ts does it).
export function createApp({ rateLimitStore = createRedisStore(redisConnection) }: AppOptions = {}): express.Express {
  const app = express();

  // How many reverse proxies (Cloudflare, Caddy) sit in front. Without this
  // req.ip is the proxy's address, and every rate limit would count all
  // visitors as one.
  app.set('trust proxy', config.trustProxyHops);

  // First, so every later line — including SuperTokens' — carries a request id.
  app.use(requestId);
  // Standard security headers (nosniff, no framing, HSTS, no x-powered-by...).
  app.use(helmet());
  app.use(
    cors({
      origin: config.webBaseUrl,
      credentials: true,
      allowedHeaders: ['content-type', 'x-tenant-slug', 'x-cart-token', 'x-request-id', ...supertokens.getAllCORSHeaders()],
      exposedHeaders: ['x-request-id', 'retry-after'],
    }),
  );

  const rateLimit = createRateLimiter(rateLimitStore);
  // A generous ceiling for everything, per client.
  app.use(rateLimit({ name: 'global', limit: 300, windowSeconds: 60 }));
  // Login endpoints, before SuperTokens handles them. Asking for a code sends
  // an email, so it is the tightest; a per-address limit inside the
  // passwordless override (core/supertokens.ts) stops one inbox being flooded
  // from many IPs.
  app.post(
    ['/auth/signinup/code', '/auth/signinup/code/resend'],
    rateLimit({ name: 'otp-request-ip', limit: 10, windowSeconds: 15 * 60 }),
  );
  app.post(
    ['/auth/signinup/code/consume', '/auth/signin'],
    rateLimit({ name: 'login-ip', limit: 30, windowSeconds: 15 * 60 }),
  );

  // SuperTokens must sit before express.json() and before your own routes —
  // it handles /auth/* itself.
  app.use(supertokensMiddleware());
  app.use(express.json({ limit: '100kb' }));

  app.use('/metrics', metricsGuard);
  app.use(promBundle({ includeMethod: true, includePath: true, normalizePath: (req) => metricsRoute(req) }));

  // Liveness: the process is up. Readiness: it can actually serve.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/ready', async (_req, res, next) => {
    try {
      const readiness = await checkReadiness();
      res.status(readiness.ok ? 200 : 503).json({ status: readiness.ok ? 'ok' : 'unavailable', checks: readiness.checks });
    } catch (err) {
      next(err);
    }
  });

  // Anyone can create a guest cart, so cart writes get their own, tighter limit.
  app.use('/cart', rateLimit({ name: 'cart-write-ip', limit: 60, windowSeconds: 60, skip: (req) => req.method === 'GET' }));

  // Each router is entered through this so its mount path is remembered for
  // metrics and request logs (see routeLabel).
  const mount = (path: string, router: express.Router): void => {
    app.use(
      path,
      (_req, res, next) => {
        res.locals.mountPath = path;
        next();
      },
      router,
    );
  };

  mount('/tenancy', tenancyRouter);
  mount('/identity', identityRouter);
  mount('/catalog', catalogRouter);
  mount('/media', mediaRouter);
  mount('/geo', geoRouter);
  mount('/cart', cartRouter);
  mount('/orders', ordersRouter);
  mount('/recipients', recipientsRouter);
  mount('/payments', paymentsRouter);
  mount('/fulfilment', fulfilmentRouter);
  mount('/notifications', notificationsRouter);
  mount('/audit', auditRouter);

  app.use(notFoundHandler);
  // SuperTokens' error handler must come before the generic one, so its own
  // error types (e.g. session refresh required) get its response shape.
  app.use(supertokensErrorHandler());
  app.use(errorHandler);

  return app;
}
