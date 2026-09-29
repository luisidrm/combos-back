import { describe, expect, it } from 'vitest';
import { validatePassword } from './supertokens.js';

// The password policy for staff accounts (admin, courier) — enforced both at
// login-time signup (there is none) and at reset, since SuperTokens' own
// default (8 chars, no composition rule) is below what CLAUDE.md implies for
// accounts with real permissions over a store.

describe('validatePassword', () => {
  it('accepts a password that meets the policy', () => {
    expect(validatePassword('correcthorse7')).toBeUndefined();
  });

  it('rejects anything under 10 characters, with a message naming the rule', () => {
    expect(validatePassword('short1')).toMatch(/at least 10/);
    expect(validatePassword('9chars12')).toMatch(/at least 10/);
  });

  it('rejects over 100 characters', () => {
    expect(validatePassword(`${'a1'.repeat(51)}`)).toMatch(/at most 100/);
  });

  it('requires at least one letter and one digit', () => {
    expect(validatePassword('nodigitshere')).toMatch(/letter and one number/);
    expect(validatePassword('1234567890')).toMatch(/letter and one number/);
    expect(validatePassword('has1letter')).toBeUndefined();
  });

  it('rejects a non-string value rather than throwing', () => {
    expect(validatePassword(12345678901)).toBeDefined();
    expect(validatePassword(undefined)).toBeDefined();
    expect(validatePassword(null)).toBeDefined();
  });
});
