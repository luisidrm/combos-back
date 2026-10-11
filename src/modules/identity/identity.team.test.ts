import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors.js';
import { startTestDatabase, type TestDatabase } from '../../db/testing/test-database.js';
import type { identityService as identityServiceType } from './index.js';

// SuperTokens itself is not under test here (it needs its own core running): the helpers that talk
// to it are replaced, so this checks the team rules — who may be added, changed or turned off.
const logins = vi.hoisted(() => ({
  ensureLogin: vi.fn(),
  sendPasswordLink: vi.fn().mockResolvedValue(undefined),
  endSessions: vi.fn().mockResolvedValue(undefined),
  randomPassword: vi.fn().mockReturnValue('Generated-pass-1'),
}));
vi.mock('../../core/staff-logins.js', () => logins);

describe('identity: the team', () => {
  let database: TestDatabase;
  let adminSql: postgres.Sql;
  let identity: typeof identityServiceType;

  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();
  let adminA: { id: string; supertokensUserId: string };

  async function insertUser(tenantId: string, role: string, email: string) {
    const id = crypto.randomUUID();
    const stId = crypto.randomUUID();
    await adminSql`INSERT INTO users (id, tenant_id, supertokens_user_id, email, role) VALUES (${id}, ${tenantId}, ${stId}, ${email}, ${role})`;
    return { id, supertokensUserId: stId };
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    adminSql = database.adminSql;
    for (const id of [tenantA, tenantB]) {
      await adminSql`INSERT INTO tenants (id, slug, name) VALUES (${id}, ${'t-' + id.slice(0, 8)}, 'Test store')`;
    }
    identity = (await import('./index.js')).identityService;
  });

  afterAll(async () => {
    await database?.stop();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    logins.ensureLogin.mockImplementation(async () => ({ userId: crypto.randomUUID(), created: true }));
    await adminSql`DELETE FROM users WHERE tenant_id IN (${tenantA}, ${tenantB})`;
    adminA = await insertUser(tenantA, 'admin', 'owner@example.com');
  });

  const invite = (overrides: Record<string, unknown> = {}) =>
    identity.inviteMember(tenantA, { email: 'packer@example.com', fullName: 'Pedro Packer', role: 'staff', ...overrides } as never);

  describe('adding someone', () => {
    it('creates the account and emails them a link to choose their own password', async () => {
      const { member, invited } = await invite();
      expect(member).toMatchObject({ email: 'packer@example.com', fullName: 'Pedro Packer', role: 'staff', active: true });
      expect(invited).toBe(true);
      expect(logins.sendPasswordLink).toHaveBeenCalledTimes(1);
      expect(logins.ensureLogin).toHaveBeenCalledWith('packer@example.com', 'Generated-pass-1');
    });

    it('keeps the account and says so when the invitation email cannot be sent', async () => {
      logins.sendPasswordLink.mockRejectedValueOnce(new Error('mail is down'));
      const result = await invite();
      expect(result).toMatchObject({ invited: false, emailFailed: true, member: { email: 'packer@example.com' } });
      expect((await identity.listTeam(tenantA)).map((m) => m.email)).toContain('packer@example.com');
    });

    it('lets the admin set the first password instead, with no email', async () => {
      const { invited, emailFailed } = await invite({ email: 'courier@example.com', role: 'courier', password: 'tempPass12345' });
      expect(invited).toBe(false);
      expect(emailFailed).toBe(false);
      expect(logins.sendPasswordLink).not.toHaveBeenCalled();
      expect(logins.ensureLogin).toHaveBeenCalledWith('courier@example.com', 'tempPass12345');
    });

    it('holds an admin-chosen password to the same rule as everyone else', async () => {
      await expect(invite({ password: 'short1' })).rejects.toBeInstanceOf(ValidationError);
      await expect(invite({ password: 'nodigitshere' })).rejects.toBeInstanceOf(ValidationError);
      expect(logins.ensureLogin).not.toHaveBeenCalled();
    });

    it('does not email someone who already has a login (the same email is one login across stores)', async () => {
      logins.ensureLogin.mockResolvedValue({ userId: crypto.randomUUID(), created: false });
      const { invited } = await invite();
      expect(invited).toBe(false);
      expect(logins.sendPasswordLink).not.toHaveBeenCalled();
    });

    it('refuses an email that is already on the team', async () => {
      await invite();
      const failed = await invite().catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(ConflictError);
      expect((failed as ConflictError).details).toMatchObject({ reason: 'ALREADY_A_MEMBER' });
    });

    it('promotes a buyer who joins the team, keeping their account, and ends their old session', async () => {
      const buyer = await insertUser(tenantA, 'buyer', 'buyer@example.com');
      logins.ensureLogin.mockResolvedValue({ userId: buyer.supertokensUserId, created: false });
      const { member } = await invite({ email: 'buyer@example.com', fullName: 'Ana', role: 'courier' });
      expect(member).toMatchObject({ id: buyer.id, role: 'courier' });
      expect(logins.endSessions).toHaveBeenCalledWith(buyer.supertokensUserId);
    });
  });

  describe('the list', () => {
    it('shows the team, disabled people included, and never buyers or another store', async () => {
      await invite();
      await insertUser(tenantA, 'buyer', 'customer@example.com');
      await insertUser(tenantB, 'staff', 'other-store@example.com');
      const team = await identity.listTeam(tenantA);
      expect(team.map((m) => m.email).sort()).toEqual(['owner@example.com', 'packer@example.com']);
      expect((await identity.listTeam(tenantB)).map((m) => m.email)).toEqual(['other-store@example.com']);
    });
  });

  describe('changing someone', () => {
    it('changes a role and ends their sessions so it takes effect at once', async () => {
      const { member } = await invite();
      const updated = await identity.updateMember(tenantA, adminA.id, member.id, { role: 'courier' });
      expect(updated.role).toBe('courier');
      expect(logins.endSessions).toHaveBeenCalledTimes(1);
    });

    it('turns an account off and back on', async () => {
      const { member } = await invite();
      expect((await identity.updateMember(tenantA, adminA.id, member.id, { active: false })).active).toBe(false);
      expect((await identity.listTeam(tenantA)).find((m) => m.id === member.id)?.active).toBe(false);
      expect((await identity.updateMember(tenantA, adminA.id, member.id, { active: true })).active).toBe(true);
    });

    it('does not let anyone change their own role or switch themselves off', async () => {
      const failed = await identity.updateMember(tenantA, adminA.id, adminA.id, { active: false }).catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(ForbiddenError);
      expect((failed as ForbiddenError).details).toMatchObject({ reason: 'SELF_CHANGE' });
    });

    it('always keeps one active admin', async () => {
      const second = await invite({ email: 'second@example.com', role: 'admin' });
      // two admins: one can be demoted...
      await identity.updateMember(tenantA, second.member.id, adminA.id, { role: 'staff' });
      // ...but then the remaining one cannot be turned off by anyone else
      const other = await insertUser(tenantA, 'admin', 'third@example.com');
      await identity.updateMember(tenantA, other.id, second.member.id, { active: false });
      const failed = await identity.updateMember(tenantA, adminA.id, other.id, { active: false }).catch((e: unknown) => e);
      expect((failed as ConflictError).details).toMatchObject({ reason: 'LAST_ADMIN' });
    });

    it('only touches the team: a buyer, or another store\'s person, is not found', async () => {
      const buyer = await insertUser(tenantA, 'buyer', 'customer@example.com');
      await expect(identity.updateMember(tenantA, adminA.id, buyer.id, { role: 'staff' })).rejects.toBeInstanceOf(NotFoundError);
      const foreign = await insertUser(tenantB, 'staff', 'other@example.com');
      await expect(identity.updateMember(tenantA, adminA.id, foreign.id, { active: false })).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('sending the link again', () => {
    it('emails an active member, and refuses a disabled one', async () => {
      const { member } = await invite();
      await identity.resendInvite(tenantA, member.id);
      expect(logins.sendPasswordLink).toHaveBeenCalledTimes(2);

      await identity.updateMember(tenantA, adminA.id, member.id, { active: false });
      await expect(identity.resendInvite(tenantA, member.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
