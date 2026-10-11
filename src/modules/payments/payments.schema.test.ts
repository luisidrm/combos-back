import { describe, expect, it } from 'vitest';
import { createManualMethodSchema, updateManualMethodSchema } from './payments.schema.js';

const base = { kind: 'zelle', label: 'Zelle', recipient: 'pay@example.com' };

describe('manual payment method input', () => {
  it('accepts the minimum: a kind, a name and who to pay', () => {
    expect(createManualMethodSchema.safeParse(base).success).toBe(true);
  });

  it('refuses an unknown kind, a missing name or a missing account', () => {
    expect(createManualMethodSchema.safeParse({ ...base, kind: 'bitcoin' }).success).toBe(false);
    expect(createManualMethodSchema.safeParse({ ...base, label: '  ' }).success).toBe(false);
    expect(createManualMethodSchema.safeParse({ ...base, recipient: '' }).success).toBe(false);
  });

  it('reads a blank optional field as "none" (a form sends empty strings)', () => {
    const parsed = createManualMethodSchema.parse({ ...base, handle: '', linkTemplate: ' ', payeeName: '', instructionsEs: '', instructionsEn: '' });
    expect(parsed).toMatchObject({ handle: null, linkTemplate: null, payeeName: null, instructionsEs: null, instructionsEn: null });
  });

  it('stores a cashtag without its $', () => {
    expect(createManualMethodSchema.parse({ ...base, kind: 'cashapp', handle: '$luis' }).handle).toBe('luis');
  });

  it('refuses a handle with characters that could break out of a link', () => {
    expect(createManualMethodSchema.safeParse({ ...base, handle: 'luis/../evil' }).success).toBe(false);
    expect(createManualMethodSchema.safeParse({ ...base, handle: 'a b' }).success).toBe(false);
  });

  it('only takes an https link for "other": never javascript:, data: or plain http', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'http://bank.example/pay', 'ftp://x', 'https://', 'https://a b']) {
      expect(createManualMethodSchema.safeParse({ ...base, kind: 'other', linkTemplate: bad }).success, bad).toBe(false);
    }
    expect(createManualMethodSchema.safeParse({ ...base, kind: 'other', linkTemplate: 'https://bank.example/pay?amount={amount}' }).success).toBe(true);
  });

  it('an edit may send only what changed, and null clears an optional field', () => {
    expect(updateManualMethodSchema.parse({ active: false })).toEqual({ active: false });
    expect(updateManualMethodSchema.parse({ payeeName: null })).toEqual({ payeeName: null });
  });
});
