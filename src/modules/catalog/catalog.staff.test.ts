import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../../core/middleware/error.middleware.js';

// Importing the routes pulls in modules that open a Redis connection on import; nothing here uses it.
vi.mock('../../core/queue.js', () => ({ redisConnection: {} }));

// The packer (role "staff") may flip a product's stock status and nothing else.
describe('catalog: what staff may edit', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const { staffMayOnlyChangeStock } = await import('./catalog.routes.js');
    const app = express();
    app.use(express.json());
    app.patch(
      '/products/:id',
      (req: Request, _res: Response, next: NextFunction) => {
        req.authUser = { role: req.header('x-role') } as Request['authUser'];
        next();
      },
      staffMayOnlyChangeStock,
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => {
    server.close();
  });

  async function patch(role: 'admin' | 'staff', body: unknown) {
    const res = await fetch(`${base}/products/1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-role': role },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as { error?: { details?: { reason?: string } } } };
  }

  it('lets staff change the stock status', async () => {
    expect((await patch('staff', { stockStatus: 'out' })).status).toBe(200);
  });

  it.each([{ priceCents: 1 }, { nameEs: 'x' }, { categoryId: null }, { stockStatus: 'out', priceCents: 5 }])(
    'refuses staff changing anything else: %j',
    async (body) => {
      const res = await patch('staff', body);
      expect(res.status).toBe(403);
      expect(res.json.error?.details?.reason).toBe('STAFF_FIELDS');
    },
  );

  it('does not restrict an admin', async () => {
    expect((await patch('admin', { priceCents: 500, nameEs: 'x' })).status).toBe(200);
  });
});
