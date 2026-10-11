import { logger } from '../../core/logger.js';
import { withTenant } from '../../db/client.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors.js';
import { validatePassword } from '../../core/password-policy.js';
import { endSessions, ensureLogin, randomPassword, sendPasswordLink } from '../../core/staff-logins.js';
import * as identityRepo from './identity.repo.js';
import type { InviteMemberInput, Role, UpdateMemberInput, UpdateMeInput, User, UserLocale } from './identity.schema.js';

async function getById(tenantId: string, userId: string): Promise<User> {
  return withTenant(tenantId, async (tx) => {
    const user = await identityRepo.findById(tx, userId);
    if (!user) {
      throw new NotFoundError(`No user with id "${userId}"`);
    }
    return user;
  });
}

async function getBySupertokensUserId(tenantId: string, supertokensUserId: string): Promise<User> {
  return withTenant(tenantId, async (tx) => {
    const user = await identityRepo.findBySupertokensUserId(tx, supertokensUserId);
    if (!user) {
      throw new NotFoundError(`No user for supertokens id "${supertokensUserId}"`);
    }
    return user;
  });
}

// Unlike getBySupertokensUserId this returns undefined for "no such user in
// this tenant" — the login flow needs to tell that apart from a real error.
async function findBySupertokensUserId(tenantId: string, supertokensUserId: string): Promise<User | undefined> {
  return withTenant(tenantId, (tx) => identityRepo.findBySupertokensUserId(tx, supertokensUserId));
}

// Anything but "en" reads Spanish: the store's default language.
function toLocale(value: string | undefined): UserLocale {
  return value === 'en' ? 'en' : 'es';
}

// The person changes the language their emails come in.
async function setLocale(tenantId: string, userId: string, locale: UserLocale): Promise<User> {
  return withTenant(tenantId, async (tx) => {
    const user = await identityRepo.updateLocale(tx, userId, locale);
    if (!user) throw new NotFoundError(`No user with id "${userId}"`);
    return user;
  });
}

// A person completes or corrects their own details (language, name, phone).
async function updateProfile(tenantId: string, userId: string, input: UpdateMeInput): Promise<User> {
  return withTenant(tenantId, async (tx) => {
    const user = await identityRepo.updateProfile(tx, userId, input);
    if (!user) throw new NotFoundError(`No user with id "${userId}"`);
    return user;
  });
}

// Whether we have what we need from a buyer: a name and a phone (staff are vouched for by the team screen).
function isProfileComplete(user: Pick<User, 'role' | 'fullName' | 'phone'>): boolean {
  return user.role !== 'buyer' || Boolean(user.fullName && user.phone);
}

// Whether a verified Google login may go ahead, given who (if anyone) already owns that email in the store and which
// SuperTokens user this Google identity already is (undefined for a first-time Google login).
//   allowed              nobody has the email yet, or it is this very Google login coming back
//   staff                the email belongs to the team: staff sign in with email and password, never Google
//   has_password_account a buyer already registered this email with a password: no second account next to it
export type GoogleSignInVerdict = 'allowed' | 'staff' | 'has_password_account';
function googleSignInVerdict(existing: Pick<User, 'role' | 'supertokensUserId'> | undefined, knownSupertokensId: string | undefined): GoogleSignInVerdict {
  if (!existing) return 'allowed';
  if (existing.role !== 'buyer') return 'staff';
  return knownSupertokensId !== undefined && knownSupertokensId === existing.supertokensUserId ? 'allowed' : 'has_password_account';
}

// Whoever owns this email in this store (any role), if anyone: one email is one account per store.
async function findByEmail(tenantId: string, email: string): Promise<User | undefined> {
  return withTenant(tenantId, (tx) => identityRepo.findByEmail(tx, email));
}

// An existing row keeps its role — `role` only applies when creating one.
// A soft-deleted user can't sign back in, so a disabled account stays disabled.
async function findOrCreateFromSession(
  tenantId: string,
  supertokensUserId: string,
  email: string,
  role: Role = 'buyer',
  profile: { fullName?: string; phone?: string; locale?: string } = {},
): Promise<User> {
  return withTenant(tenantId, async (tx) => {
    const existing = await identityRepo.findBySupertokensUserId(tx, supertokensUserId);
    if (existing) {
      if (existing.deletedAt) {
        throw new ForbiddenError('This account has been disabled');
      }
      return existing;
    }
    return identityRepo.insert(tx, { tenantId, supertokensUserId, email, role, fullName: profile.fullName,
      phone: profile.phone,
      locale: toLocale(profile.locale),
    });
  });
}

// Name, email and phone of some users, for screens that list other people's orders (the admin queue).
// Missing ids are simply absent from the result.
async function getSummaries(
  tenantId: string,
  userIds: string[],
): Promise<Map<string, { fullName: string | null; email: string; phone: string | null; locale: UserLocale }>> {
  const rows = await withTenant(tenantId, (tx) => identityRepo.findByIds(tx, [...new Set(userIds)]));
  return new Map(rows.map((row) => [row.id, { fullName: row.fullName, email: row.email, phone: row.phone, locale: toLocale(row.locale) }]));
}

// Ids of the people whose name or email contains `text`: lets another module search "by buyer" without reading users.
async function findUserIdsMatching(tenantId: string, text: string): Promise<string[]> {
  return withTenant(tenantId, (tx) => identityRepo.findIdsMatching(tx, text));
}

async function setRole(tenantId: string, userId: string, role: Role): Promise<User> {
  return withTenant(tenantId, async (tx) => {
    const user = await identityRepo.updateRole(tx, userId, role);
    if (!user) {
      throw new NotFoundError(`No user with id "${userId}"`);
    }
    return user;
  });
}

// --- the team (admin, staff, couriers) --------------------------------------------
//
// An admin adds the people who work for the store. Buyers sign themselves up, so this screen never
// lists or edits them (promoting a buyer to staff is the one exception, below).

const TEAM_ROLES: Role[] = ['admin', 'staff', 'courier'];

export interface TeamMember {
  id: string;
  email: string;
  fullName: string | null;
  phone: string | null;
  role: Role;
  /** False once an admin has turned the account off: it can no longer sign in. */
  active: boolean;
  createdAt: Date;
}

function toMember(user: User): TeamMember {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    phone: user.phone,
    role: user.role as Role,
    active: user.deletedAt === null,
    createdAt: user.createdAt,
  };
}

async function listTeam(tenantId: string): Promise<TeamMember[]> {
  const rows = await withTenant(tenantId, (tx) => identityRepo.listByRoles(tx, TEAM_ROLES));
  return rows.map(toMember);
}

// Adds a person to the team. With no password they get an email with a link to choose their own
// (valid for about an hour: use "send the link again" if it lapses); with one they can sign in right
// away. Someone who already has a login (the same email is one login across stores, and a buyer here
// may become staff) simply keeps their existing password.
async function inviteMember(
  tenantId: string,
  input: InviteMemberInput,
): Promise<{ member: TeamMember; invited: boolean; emailFailed: boolean }> {
  if (input.password !== undefined) {
    const problem = validatePassword(input.password);
    if (problem) throw new ValidationError(problem);
  }
  const email = input.email.toLowerCase();

  const existing = await withTenant(tenantId, (tx) => identityRepo.findByEmail(tx, email));
  if (existing && existing.role !== 'buyer') {
    throw new ConflictError('That email already belongs to someone on the team', { reason: 'ALREADY_A_MEMBER' });
  }

  const login = await ensureLogin(email, input.password ?? randomPassword());
  const member = await withTenant(tenantId, async (tx) => {
    if (existing) {
      // A buyer who is joining the team keeps their account and history.
      const promoted = await identityRepo.updateMember(tx, existing.id, {
        role: input.role,
        fullName: existing.fullName ?? input.fullName,
        phone: existing.phone ?? input.phone ?? null,
        deletedAt: null,
      });
      if (!promoted) throw new NotFoundError('That account no longer exists');
      return promoted;
    }
    return identityRepo.insert(tx, {
      tenantId,
      supertokensUserId: login.userId,
      email,
      role: input.role,
      fullName: input.fullName,
      phone: input.phone,
    });
  });
  if (existing) {
    await endSessions(login.userId); // the old session still says "buyer"
  }

  // A brand-new login with no password chosen by the admin needs the link to set one.
  // The account exists by now, so an email that cannot be sent (a mail outage, a sender that only
  // delivers to certain addresses) is reported, not raised: the admin can send the link again.
  const needsLink = login.created && input.password === undefined;
  let invited = needsLink;
  if (needsLink) {
    try {
      await sendPasswordLink(login.userId, email);
    } catch (err) {
      logger.error({ err }, 'Could not send the invitation email to a new team member');
      invited = false;
    }
  }
  return { member: toMember(member), invited, emailFailed: needsLink && !invited };
}

// Change someone's role or turn their account on or off. Guards: nobody changes their own access
// (so an admin cannot lock themselves out), and the store always keeps at least one active admin.
async function updateMember(tenantId: string, actorId: string, memberId: string, input: UpdateMemberInput): Promise<TeamMember> {
  const target = await getById(tenantId, memberId);
  if (!TEAM_ROLES.includes(target.role as Role)) {
    throw new NotFoundError('That person is not on the team');
  }
  const changesAccess = input.role !== undefined || input.active !== undefined;
  if (memberId === actorId && changesAccess) {
    throw new ForbiddenError('You cannot change your own role or turn your own account off', { reason: 'SELF_CHANGE' });
  }

  const losesAdmin =
    target.role === 'admin' && target.deletedAt === null && ((input.role !== undefined && input.role !== 'admin') || input.active === false);
  const updated = await withTenant(tenantId, async (tx) => {
    if (losesAdmin && (await identityRepo.countActiveAdmins(tx)) <= 1) {
      throw new ConflictError('The store needs at least one active admin', { reason: 'LAST_ADMIN' });
    }
    const row = await identityRepo.updateMember(tx, memberId, {
      role: input.role,
      fullName: input.fullName,
      phone: input.phone,
      deletedAt: input.active === undefined ? undefined : input.active ? null : new Date(),
    });
    if (!row) throw new NotFoundError('That person is not on the team');
    return row;
  });
  if (changesAccess) {
    await endSessions(target.supertokensUserId);
  }
  return toMember(updated);
}

// Sends the "choose your password" link again (the first one lapses after about an hour).
async function resendInvite(tenantId: string, memberId: string): Promise<void> {
  const target = await getById(tenantId, memberId);
  if (!TEAM_ROLES.includes(target.role as Role) || target.deletedAt !== null) {
    throw new NotFoundError('That person is not an active member of the team');
  }
  await sendPasswordLink(target.supertokensUserId, target.email);
}

// The only public surface other modules may depend on (via index.ts).
export const identityService = {
  getById,
  getBySupertokensUserId,
  findBySupertokensUserId,
  findOrCreateFromSession,
  setLocale,
  updateProfile,
  isProfileComplete,
  findByEmail,
  googleSignInVerdict,
  getSummaries,
  findUserIdsMatching,
  setRole,
  listTeam,
  inviteMember,
  updateMember,
  resendInvite,
};
