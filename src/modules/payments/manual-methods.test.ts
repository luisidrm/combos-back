import { beforeEach, describe, expect, it, vi } from 'vitest';

const manualPayments = vi.hoisted(() => ({
  payeeName: undefined as string | undefined,
  zelleEmail: undefined as string | undefined,
  cashappEmail: undefined as string | undefined,
  cashappCashtag: undefined as string | undefined,
  paypalEmail: undefined as string | undefined,
  paypalMeHandle: undefined as string | undefined,
}));
vi.mock('../../config/index.js', () => ({ config: { manualPayments } }));

describe('manual transfer methods', () => {
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

  async function methods(amountCents: number) {
    return (await import('./manual-methods.js')).listManualMethods(amountCents);
  }

  it('offers nothing until an account is configured', async () => {
    expect(await methods(5550)).toEqual([]);
  });

  it('offers only the methods that have an account', async () => {
    manualPayments.zelleEmail = 'pay@example.com';
    expect((await methods(5550)).map((m) => m.method)).toEqual(['zelle']);
  });

  it('Zelle has no link: it lives inside the bank app', async () => {
    manualPayments.zelleEmail = 'pay@example.com';
    expect(await methods(5550)).toEqual([
      expect.objectContaining({ method: 'zelle', recipient: 'pay@example.com', link: null, amountInLink: false }),
    ]);
  });

  it('puts the exact amount in the Cash App and PayPal links when a cashtag / handle is set', async () => {
    manualPayments.cashappCashtag = 'luis';
    manualPayments.paypalEmail = 'pay@example.com';
    manualPayments.paypalMeHandle = 'luisr';
    const [cash, paypal] = await methods(5550);
    expect(cash).toMatchObject({ method: 'cashapp', recipient: '$luis', link: 'https://cash.app/$luis/55.50', amountInLink: true });
    expect(paypal).toMatchObject({
      method: 'paypal',
      recipient: 'pay@example.com',
      link: 'https://www.paypal.com/paypalme/luisr/55.50USD',
      amountInLink: true,
    });
  });

  it('without a cashtag / handle the link only opens the app and the amount is typed by the buyer', async () => {
    manualPayments.cashappEmail = 'pay@example.com';
    manualPayments.paypalEmail = 'pay@example.com';
    const [cash, paypal] = await methods(1000);
    expect(cash).toMatchObject({ recipient: 'pay@example.com', link: 'https://cash.app/', amountInLink: false });
    expect(paypal).toMatchObject({ amountInLink: false });
    expect(paypal?.link).toMatch(/^https:\/\/www\.paypal\.com\//);
  });

  it('formats cents as dollars with two decimals', async () => {
    manualPayments.cashappCashtag = 'luis';
    expect((await methods(5))[0]?.link).toBe('https://cash.app/$luis/0.05');
    expect((await methods(100000))[0]?.link).toBe('https://cash.app/$luis/1000.00');
  });
});
