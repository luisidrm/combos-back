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

  // The accounts buyers send money to, edited by the owner (instead of environment variables).
  describe('manual transfer methods', () => {
    const zelle = { kind: 'zelle', label: 'Zelle', recipient: 'pay@example.com' } as const;

    it("keeps one store's methods out of another's (the cross-tenant read test)", async () => {
      const mine = await payments.createManualMethod(tenantA, zelle);
      expect((await payments.listMethodsForAdmin(tenantB)).map((m) => m.id)).not.toContain(mine.id);
      expect((await payments.listManualMethods(tenantB, 1000)).map((m) => m.id)).not.toContain(mine.id);
      // ...and the database itself refuses, not only the service: another store's row cannot be updated or removed.
      await expect(payments.updateManualMethod(tenantB, mine.id, { label: 'Hijacked' })).rejects.toMatchObject({ httpStatus: 404 });
      await expect(payments.deleteManualMethod(tenantB, mine.id)).rejects.toMatchObject({ httpStatus: 404 });
      expect((await payments.listMethodsForAdmin(tenantA)).find((m) => m.id === mine.id)?.label).toBe('Zelle');
    });

    it('creates, edits and orders methods, and the buyer sees only the active ones, in that order', async () => {
      const store = crypto.randomUUID();
      const first = await payments.createManualMethod(store, { ...zelle, instructionsEs: 'Usa el número de pedido' });
      const cashApp = { kind: 'cashapp', label: 'Cash App', recipient: '$luis', handle: 'luis' } as const;
      const second = await payments.createManualMethod(store, cashApp);
      const third = await payments.createManualMethod(store, { kind: 'other', label: 'Mi banco', recipient: '0123', linkTemplate: 'https://bank.example/pay?amount={amount}' });
      const mine = [first.id, second.id, third.id];
      const ownLabels = (list: Array<{ id: string; label: string }>) => list.filter((m) => mine.includes(m.id)).map((m) => m.label);
      expect(ownLabels(await payments.listManualMethods(store, 5550))).toEqual(['Zelle', 'Cash App', 'Mi banco']);

      // hide one: the owner still sees it, the buyer does not
      await payments.updateManualMethod(store, second.id, { active: false });
      expect(ownLabels(await payments.listManualMethods(store, 5550))).toEqual(['Zelle', 'Mi banco']);
      expect(ownLabels(await payments.listMethodsForAdmin(store))).toEqual(['Zelle', 'Cash App', 'Mi banco']);

      // reorder (the ids of the environment accounts imported into a new store go along)
      const everyId = (await payments.listMethodsForAdmin(store)).map((m) => m.id).filter((id) => !mine.includes(id));
      await payments.reorderManualMethods(store, [third.id, first.id, second.id, ...everyId]);
      expect(ownLabels(await payments.listMethodsForAdmin(store))).toEqual(['Mi banco', 'Zelle', 'Cash App']);
      const bank = (await payments.listManualMethods(store, 5550))[0];
      expect(bank).toMatchObject({ label: 'Mi banco', link: 'https://bank.example/pay?amount=55.50', amountInLink: true });

      // edit, and clear an optional field with null
      const edited = await payments.updateManualMethod(store, first.id, { recipient: 'new@example.com', instructionsEs: null });
      expect(edited).toMatchObject({ recipient: 'new@example.com', instructionsEs: null });
    });

    it('a store with no methods gets the accounts from the environment once, and deleting them keeps them gone', async () => {
      const store = crypto.randomUUID();
      const imported = await payments.listMethodsForAdmin(store);
      expect(imported.map((m) => m.label)).toEqual(['Zelle', 'Cash App', 'PayPal']);
      // asking again does not import a second copy
      expect(await payments.listMethodsForAdmin(store)).toHaveLength(3);

      for (const method of imported) await payments.deleteManualMethod(store, method.id);
      expect(await payments.listMethodsForAdmin(store)).toEqual([]);
      expect(await payments.listManualMethods(store, 1000)).toEqual([]);
    });

    it('refuses to reorder with an id that is not one of the store\'s methods', async () => {
      const store = crypto.randomUUID();
      const only = await payments.createManualMethod(store, zelle);
      await expect(payments.reorderManualMethods(store, [only.id, crypto.randomUUID()])).rejects.toMatchObject({ httpStatus: 400 });
    });

    it('deleting hides a method from everyone but keeps the row, so a past report can still name it', async () => {
      const store = crypto.randomUUID();
      const gone = await payments.createManualMethod(store, zelle);
      await payments.deleteManualMethod(store, gone.id);
      expect((await payments.listMethodsForAdmin(store)).map((m) => m.id)).not.toContain(gone.id);
      expect((await payments.listManualMethods(store, 1000)).map((m) => m.id)).not.toContain(gone.id);
      const [row] = await adminSql`select deleted_at, active from manual_payment_methods where id = ${gone.id}`;
      expect(row?.deleted_at).not.toBeNull();
      await expect(payments.deleteManualMethod(store, gone.id)).rejects.toMatchObject({ httpStatus: 404 });
    });

    it('a transfer report keeps the name of the method as the buyer saw it, even after it is renamed', async () => {
      const store = crypto.randomUUID();
      const method = await payments.createManualMethod(store, zelle);
      const payment = await withTenant(store, (tx) =>
        payments.createPendingPayment(tx, { tenantId: store, orderId: crypto.randomUUID(), provider: 'manual', amountCents: 1000, currency: 'USD' }),
      );
      await withTenant(store, (tx) =>
        payments.recordTransferReport(tx, { tenantId: store, paymentId: payment.id, methodId: method.id, label: 'Zelle', transferReference: 'ABC12345' }),
      );
      await payments.updateManualMethod(store, method.id, { label: 'Zelle (banco)' });
      const reports = await withTenant(store, (tx) => payments.getLatestTransferReports(tx, [payment.orderId]));
      expect(reports.get(payment.orderId)).toMatchObject({ method: 'Zelle', methodId: method.id, transferReference: 'ABC12345' });
    });

    it('reads a report saved before methods were stored (a bare "cashapp") as the app\'s name', async () => {
      const store = crypto.randomUUID();
      const payment = await withTenant(store, (tx) =>
        payments.createPendingPayment(tx, { tenantId: store, orderId: crypto.randomUUID(), provider: 'manual', amountCents: 1000, currency: 'USD' }),
      );
      await adminSql`
        INSERT INTO payment_events (tenant_id, payment_id, provider_event_id, event_type, payload)
        VALUES (${store}, ${payment.id}, ${'manual-report:' + crypto.randomUUID()}, 'transfer_reported',
                ${adminSql.json({ method: 'cashapp', transferReference: 'OLD12345', notes: null })})`;
      const reports = await withTenant(store, (tx) => payments.getLatestTransferReports(tx, [payment.orderId]));
      expect(reports.get(payment.orderId)).toMatchObject({ method: 'Cash App', methodId: null });
    });
  });
});
