import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManualPaymentMethod } from './payments.schema.js';

const manualPayments = vi.hoisted(() => ({
  payeeName: undefined as string | undefined,
  zelleEmail: undefined as string | undefined,
  cashappEmail: undefined as string | undefined,
  cashappCashtag: undefined as string | undefined,
  paypalEmail: undefined as string | undefined,
  paypalMeHandle: undefined as string | undefined,
}));
vi.mock('../../config/index.js', () => ({ config: { manualPayments } }));

// A stored method as the database hands it back; each test overrides what it cares about.
function row(overrides: Partial<ManualPaymentMethod>): ManualPaymentMethod {
  return {
    id: crypto.randomUUID(),
    tenantId: crypto.randomUUID(),
    kind: 'other',
    label: 'Method',
    recipient: 'pay@example.com',
    handle: null,
    linkTemplate: null,
    payeeName: null,
    instructionsEs: null,
    instructionsEn: null,
    sortOrder: 0,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

async function view(r: ManualPaymentMethod, amountCents: number) {
  return (await import('./manual-methods.js')).toMethodView(r, amountCents);
}

describe('what a buyer sees for a manual transfer method', () => {
  it('Zelle has no link: it lives inside the bank app', async () => {
    expect(await view(row({ kind: 'zelle', label: 'Zelle' }), 5550)).toMatchObject({ label: 'Zelle', recipient: 'pay@example.com', link: null, amountInLink: false });
  });

  it('puts the exact amount in the Cash App and PayPal links when a cashtag / handle is set', async () => {
    expect(await view(row({ kind: 'cashapp', recipient: '$luis', handle: 'luis' }), 5550)).toMatchObject({
      recipient: '$luis',
      link: 'https://cash.app/$luis/55.50',
      amountInLink: true,
    });
    expect(await view(row({ kind: 'paypal', handle: 'luisr' }), 5550)).toMatchObject({
      link: 'https://www.paypal.com/paypalme/luisr/55.50USD',
      amountInLink: true,
    });
  });

  it('without a cashtag / handle the link only opens the app and the amount is typed by the buyer', async () => {
    expect(await view(row({ kind: 'cashapp' }), 1000)).toMatchObject({ link: 'https://cash.app/', amountInLink: false });
    const paypal = await view(row({ kind: 'paypal' }), 1000);
    expect(paypal.amountInLink).toBe(false);
    expect(paypal.link).toMatch(/^https:\/\/www\.paypal\.com\//);
  });

  it('formats cents as dollars with two decimals', async () => {
    const cash = row({ kind: 'cashapp', handle: 'luis' });
    expect((await view(cash, 5)).link).toBe('https://cash.app/$luis/0.05');
    expect((await view(cash, 100000)).link).toBe('https://cash.app/$luis/1000.00');
  });

  it('an "other" method uses the owner\'s own link, filling in the amount and the recipient', async () => {
    const other = row({ kind: 'other', recipient: 'pay me@bank.com', linkTemplate: 'https://bank.example/pay?to={recipient}&amount={amount}' });
    expect(await view(other, 5550)).toMatchObject({
      link: 'https://bank.example/pay?to=pay%20me%40bank.com&amount=55.50',
      amountInLink: true,
    });
  });

  it('an "other" method without a link, or whose link has no {amount}, says so', async () => {
    expect(await view(row({ kind: 'other' }), 5550)).toMatchObject({ link: null, amountInLink: false });
    expect(await view(row({ kind: 'other', linkTemplate: 'https://bank.example/pay' }), 5550)).toMatchObject({
      link: 'https://bank.example/pay',
      amountInLink: false,
    });
  });

  it('carries the owner\'s instructions in both languages', async () => {
    expect(await view(row({ instructionsEs: 'Escribe el número de pedido', instructionsEn: 'Write the order number' }), 100)).toMatchObject({
      instructionsEs: 'Escribe el número de pedido',
      instructionsEn: 'Write the order number',
    });
  });
});

describe('the accounts that used to come from the environment', () => {
  beforeEach(() => {
    Object.assign(manualPayments, {
      payeeName: undefined,
      zelleEmail: undefined,
      cashappEmail: undefined,
      cashappCashtag: undefined,
      paypalEmail: undefined,
      paypalMeHandle: undefined,
    });
  });

  async function seeds() {
    return (await import('./manual-methods.js')).accountsFromEnvironment();
  }

  it('offers nothing until an account is configured', async () => {
    expect(await seeds()).toEqual([]);
  });

  it('turns each configured account into a method, with the cashtag / handle for the amount link', async () => {
    manualPayments.payeeName = 'Los Medinas';
    manualPayments.zelleEmail = 'pay@example.com';
    manualPayments.cashappCashtag = 'luis';
    manualPayments.paypalEmail = 'pay@example.com';
    manualPayments.paypalMeHandle = 'luisr';
    expect(await seeds()).toEqual([
      { kind: 'zelle', label: 'Zelle', recipient: 'pay@example.com', handle: null, payeeName: 'Los Medinas' },
      { kind: 'cashapp', label: 'Cash App', recipient: '$luis', handle: 'luis', payeeName: 'Los Medinas' },
      { kind: 'paypal', label: 'PayPal', recipient: 'pay@example.com', handle: 'luisr', payeeName: 'Los Medinas' },
    ]);
  });

  it('names old transfer reports (saved with a bare key) the way a buyer saw them', async () => {
    const { legacyMethodLabel } = await import('./manual-methods.js');
    expect(legacyMethodLabel('cashapp')).toBe('Cash App');
    expect(legacyMethodLabel('Wise')).toBe('Wise');
  });
});
