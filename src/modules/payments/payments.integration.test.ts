import type { Request } from 'express';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../db/testing/test-database.js';
import type { withTenant as withTenantType } from '../../db/client.js';
import type { WebhookResult } from './payments.provider.js';
import type { paymentsService as paymentsServiceType } from './index.js';
import type { TropiPayProvider as TropiPayProviderType } from './providers/tropipay.provider.js';

// NOTE: every non-type import above this line must stay type-only.
// TropiPayProvider (like payments.service.ts, like anything that reaches
// config/index.ts) can only be imported dynamically, inside beforeAll,
// after startTestDatabase() has set the real env vars — config/index.ts
// reads process.env exactly once, synchronously, at the moment it is first
// imported, and every later import of it (even a dynamic one, even from a
// different file) gets that same frozen object back from the module cache.
// A static import here would bake in vitest.setup.ts's inert placeholders
// permanently, however many times db/client.ts is imported afterwards.

const events = vi.hoisted(() => ({ emit: vi.fn().mockResolvedValue(undefined), on: vi.fn(), close: vi.fn() }));
vi.mock('../../core/events.js', () => ({ events }));

// Covers CLAUDE.md section 13's required cross-tenant test for the payments
// tables, plus the webhook orchestration required by section 6: signature
// verification happens before anything is trusted (exercised by mocking only
// TropiPayProvider.verifyWebhook — the one piece that genuinely needs a real
// TropiPay sandbox to test, per that provider's own file header — while every
// downstream step (idempotency, the amount check, status updates, audit,
// emitting the order-facing event) runs for real against a real database).

function fakeWebhookResult(overrides: Partial<WebhookResult> = {}): WebhookResult {
  return {
    tenantId: 'placeholder',
    paymentId: 'placeholder',
    providerEventId: crypto.randomUUID(),
    eventType: 'tropipay.paid',
    status: 'paid',
    amountCents: 1000,
    rawPayload: { ok: true },
    ...overrides,
  };
}

describe('payments module', () => {
  let database: TestDatabase;
  let adminSql: postgres.Sql;
  let payments: typeof paymentsServiceType;
  let withTenant: typeof withTenantType;
  let TropiPayProvider: typeof TropiPayProviderType;
  let verifyWebhookSpy: ReturnType<typeof spyOnVerifyWebhook>;

  // Closes over the `TropiPayProvider` binding above, not a module-level
  // one — it must only be called after beforeAll has assigned it.
  function spyOnVerifyWebhook() {
    return vi.spyOn(TropiPayProvider.prototype, 'verifyWebhook');
  }

  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();

  async function insertPayment(
    tenantId: string,
    overrides: { amountCents?: number; provider?: string; status?: string } = {},
  ) {
    const orderId = crypto.randomUUID();
    const payment = await withTenant(tenantId, (tx) =>
      payments.createPendingPayment(tx, {
        tenantId,
        orderId,
        provider: overrides.provider ?? 'tropipay',
        amountCents: overrides.amountCents ?? 1000,
        currency: 'USD',
      }),
    );
    if (overrides.status) {
      await adminSql`update payments set status = ${overrides.status} where id = ${payment.id}`;
    }
    return { orderId, payment };
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    adminSql = database.adminSql;
    payments = (await import('./index.js')).paymentsService;
    withTenant = (await import('../../db/client.js')).withTenant;
    TropiPayProvider = (await import('./providers/tropipay.provider.js')).TropiPayProvider;
  });

  afterAll(async () => {
    await database?.stop();
  });

  afterEach(() => {
    verifyWebhookSpy?.mockRestore();
    events.emit.mockClear();
  });

  describe('cross-tenant isolation', () => {
    it("returns nothing when tenant A reads tenant B's payment", async () => {
      const { orderId } = await insertPayment(tenantB);
      await expect(withTenant(tenantA, (tx) => payments.getLatestForOrder(tx, orderId))).rejects.toBeDefined();
    });

    it("lets tenant B read its own payment (so the check above isn't vacuous)", async () => {
      const { orderId, payment } = await insertPayment(tenantB);
      const found = await withTenant(tenantB, (tx) => payments.getLatestForOrder(tx, orderId));
      expect(found.id).toBe(payment.id);
    });
  });

  describe('basic lifecycle', () => {
    it('creates a pending payment and reads it back as the latest for that order', async () => {
      const { orderId, payment } = await insertPayment(tenantA, { amountCents: 4200 });
      expect(payment).toMatchObject({ orderId, status: 'pending', amountCents: 4200, currency: 'USD' });
    });

    it('marks a status change and records it', async () => {
      const { payment } = await insertPayment(tenantA);
      const updated = await withTenant(tenantA, (tx) => payments.markStatus(tx, payment.id, 'paid'));
      expect(updated.status).toBe('paid');
    });
  });

  describe('ManualTransferProvider', () => {
    const provider = () => payments.getProvider('manual');

    it('has no redirect and uses our own payment id as the reference', async () => {
      const session = await provider().createCheckout({
        paymentId: 'pay-1',
        tenantId: tenantA,
        orderId: 'order-1',
        orderNumber: 'ORD-TEST',
        amountCents: 1000,
        currency: 'USD',
        description: 'x',
        buyerEmail: 'buyer@example.com',
        returnUrl: 'http://x',
        cancelUrl: 'http://x',
      });
      expect(session).toEqual({ redirectUrl: '', externalPaymentId: 'pay-1' });
    });

    it('has no webhooks and nothing external to poll', async () => {
      await expect(provider().verifyWebhook({} as Request)).rejects.toThrow(/no webhooks/);
      await expect(provider().getStatus('pay-1')).rejects.toThrow(/no external/);
    });

    it('reports a refund as immediately completed — there is no external system to wait on', async () => {
      await expect(provider().refund('pay-1', 1000)).resolves.toEqual({ refundId: '', status: 'completed' });
    });
  });

  describe('processWebhook', () => {
    // beforeEach, not beforeAll: the outer afterEach below calls
    // mockRestore() after every test, which detaches the spy from
    // TropiPayProvider.prototype entirely (not just resetting its return
    // value) — a spy set up once in beforeAll would only work for the first
    // test in this block and silently fall through to the real
    // implementation (which fails: no TropiPay credentials in tests) for
    // every test after it.
    beforeEach(() => {
      verifyWebhookSpy = spyOnVerifyWebhook();
    });

    it('marks the payment paid, audits it, and emits payment.paid for orders to react to', async () => {
      const { orderId, payment } = await insertPayment(tenantA, { amountCents: 1000 });
      verifyWebhookSpy.mockResolvedValue(fakeWebhookResult({ tenantId: tenantA, paymentId: payment.id, amountCents: 1000 }));

      const outcome = await payments.processWebhook('tropipay', {} as Request);

      expect(outcome).toEqual({ tenantId: tenantA, orderId, paymentId: payment.id, reaction: 'paid' });
      const [row] = await adminSql`select status from payments where id = ${payment.id}`;
      expect(row?.status).toBe('paid');
      const [audit] = await adminSql`select action from audit_log where entity_id = ${payment.id} order by created_at desc limit 1`;
      expect(audit?.action).toBe('payment.paid');
      expect(events.emit).toHaveBeenCalledWith('payment.paid', { tenantId: tenantA, orderId, paymentId: payment.id });
    });

    it('is idempotent: a redelivered event is a no-op, not a second audit entry or a second emit', async () => {
      const { payment } = await insertPayment(tenantA, { amountCents: 1000 });
      const eventId = crypto.randomUUID();
      verifyWebhookSpy.mockResolvedValue(
        fakeWebhookResult({ tenantId: tenantA, paymentId: payment.id, amountCents: 1000, providerEventId: eventId }),
      );

      const first = await payments.processWebhook('tropipay', {} as Request);
      expect(first).toBeDefined();
      events.emit.mockClear();

      const second = await payments.processWebhook('tropipay', {} as Request);
      expect(second).toBeUndefined();
      expect(events.emit).not.toHaveBeenCalled();

      const auditRows = await adminSql`select count(*)::int as n from audit_log where entity_id = ${payment.id}`;
      expect(auditRows[0]?.n).toBe(1);
    });

    it('never trusts the webhook amount: a mismatch leaves the payment unchanged and does not fire the order event', async () => {
      const { payment } = await insertPayment(tenantA, { amountCents: 5000 });
      verifyWebhookSpy.mockResolvedValue(fakeWebhookResult({ tenantId: tenantA, paymentId: payment.id, amountCents: 1 }));

      const outcome = await payments.processWebhook('tropipay', {} as Request);

      expect(outcome).toBeUndefined();
      const [row] = await adminSql`select status from payments where id = ${payment.id}`;
      expect(row?.status).toBe('pending');
      const [audit] = await adminSql`select action from audit_log where entity_id = ${payment.id} order by created_at desc limit 1`;
      expect(audit?.action).toBe('payment.amount_mismatch');
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('does not crash and does not emit when the webhook names a payment that does not exist', async () => {
      verifyWebhookSpy.mockResolvedValue(fakeWebhookResult({ tenantId: tenantA, paymentId: crypto.randomUUID() }));
      await expect(payments.processWebhook('tropipay', {} as Request)).resolves.toBeUndefined();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it("cannot be tricked into acting on another tenant's payment by a mismatched tenantId", async () => {
      const { payment } = await insertPayment(tenantB, { amountCents: 1000 });
      // Claims tenant A, but the payment id actually belongs to tenant B —
      // withTenant(tenantA, ...) means RLS simply finds no such row.
      verifyWebhookSpy.mockResolvedValue(fakeWebhookResult({ tenantId: tenantA, paymentId: payment.id, amountCents: 1000 }));
      const outcome = await payments.processWebhook('tropipay', {} as Request);
      expect(outcome).toBeUndefined();
      const [row] = await adminSql`select status from payments where id = ${payment.id}`;
      expect(row?.status).toBe('pending');
    });

    it('leaves a failed or still-pending status without emitting an order-facing event', async () => {
      const { payment } = await insertPayment(tenantA, { amountCents: 1000 });
      verifyWebhookSpy.mockResolvedValue(
        fakeWebhookResult({ tenantId: tenantA, paymentId: payment.id, amountCents: 1000, status: 'failed', eventType: 'tropipay.failed' }),
      );
      const outcome = await payments.processWebhook('tropipay', {} as Request);
      expect(outcome).toBeUndefined();
      const [row] = await adminSql`select status from payments where id = ${payment.id}`;
      expect(row?.status).toBe('failed');
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('propagates a genuine signature failure as an error, not a silent 200', async () => {
      const { ConflictError } = await import('../../core/errors.js');
      verifyWebhookSpy.mockRejectedValue(new ConflictError('Invalid webhook signature'));
      await expect(payments.processWebhook('tropipay', {} as Request)).rejects.toBeInstanceOf(ConflictError);
    });
  });
});
