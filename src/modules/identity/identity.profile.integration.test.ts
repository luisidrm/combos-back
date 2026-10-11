import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../db/testing/test-database.js';
import type { identityService as identityServiceType } from './index.js';

vi.mock('../../core/events.js', () => ({
  events: { emit: vi.fn().mockResolvedValue(undefined), on: vi.fn(), close: vi.fn() },
}));

// The details we keep for a buyer (a Google sign-up brings a name but never a phone), and the rules that decide whether a
// Google login may go ahead for an email that already has an account.
describe('identity: profile and Google sign-in rules', () => {
  let database: TestDatabase;
  let identity: typeof identityServiceType;
  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();

  beforeAll(async () => {
    database = await startTestDatabase();
    for (const id of [tenantA, tenantB]) {
      await database.adminSql`INSERT INTO tenants (id, slug, name) VALUES (${id}, ${`t-${id.slice(0, 8)}`}, 'Test store')`;
    }
    identity = (await import('./index.js')).identityService;
  });

  afterAll(async () => {
    await database?.stop();
  });

  it('a Google sign-up has the name but not the phone, so the profile is incomplete until the phone is given', async () => {
    const user = await identity.findOrCreateFromSession(tenantA, crypto.randomUUID(), 'ana@gmail.example', 'buyer', { fullName: 'Ana Pérez' });
    expect(user).toMatchObject({ fullName: 'Ana Pérez', phone: null, role: 'buyer' });
    expect(identity.isProfileComplete(user)).toBe(false);

    const done = await identity.updateProfile(tenantA, user.id, { phone: '+53 5 4588141' });
    expect(done.phone).toBe('+53 5 4588141');
    expect(identity.isProfileComplete(done)).toBe(true);
    // fields not sent are left alone
    expect(done.fullName).toBe('Ana Pérez');
  });

  it('can fix the name and the language too, and staff are never asked for a phone', async () => {
    const user = await identity.findOrCreateFromSession(tenantA, crypto.randomUUID(), 'b@gmail.example', 'buyer', {});
    expect(identity.isProfileComplete(user)).toBe(false);
    const updated = await identity.updateProfile(tenantA, user.id, { fullName: 'Beto', locale: 'en', phone: '5 1234567' });
    expect(updated).toMatchObject({ fullName: 'Beto', locale: 'en' });
    expect(identity.isProfileComplete({ role: 'admin', fullName: null, phone: null })).toBe(true);
    expect(identity.isProfileComplete({ role: 'courier', fullName: null, phone: null })).toBe(true);
  });

  it('finds whoever owns an email, in this store only and ignoring the case', async () => {
    const stId = crypto.randomUUID();
    await identity.findOrCreateFromSession(tenantA, stId, 'Mixed.Case@gmail.example', 'buyer', {});
    expect((await identity.findByEmail(tenantA, 'mixed.case@GMAIL.example'))?.supertokensUserId).toBe(stId);
    expect(await identity.findByEmail(tenantB, 'mixed.case@gmail.example')).toBeUndefined();
  });

  describe('may a Google login go ahead?', () => {
    const buyer = { role: 'buyer', supertokensUserId: 'st-buyer' };
    it('yes when nobody has the email yet', () => {
      expect(identity.googleSignInVerdict(undefined, undefined)).toBe('allowed');
    });
    it('yes for the same Google login coming back', () => {
      expect(identity.googleSignInVerdict(buyer, 'st-buyer')).toBe('allowed');
    });
    it('no when a buyer registered this email with a password (no second account next to it)', () => {
      expect(identity.googleSignInVerdict(buyer, undefined)).toBe('has_password_account');
      expect(identity.googleSignInVerdict(buyer, 'st-other-google')).toBe('has_password_account');
    });
    it('never for the team, whatever the Google identity', () => {
      for (const role of ['admin', 'staff', 'courier']) {
        expect(identity.googleSignInVerdict({ role, supertokensUserId: 'st-x' }, 'st-x')).toBe('staff');
        expect(identity.googleSignInVerdict({ role, supertokensUserId: 'st-x' }, undefined)).toBe('staff');
      }
    });
  });
});
