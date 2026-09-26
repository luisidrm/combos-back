import { withTenant } from '../../db/client.js';
import { ForbiddenError, NotFoundError } from '../../core/errors.js';
import * as identityRepo from './identity.repo.js';
import type { Role, User } from './identity.schema.js';

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

// An existing row keeps its role — `role` only applies when creating one.
// A soft-deleted user can't sign back in, so a disabled account stays disabled.
async function findOrCreateFromSession(
  tenantId: string,
  supertokensUserId: string,
  email: string,
  role: Role = 'buyer',
): Promise<User> {
  return withTenant(tenantId, async (tx) => {
    const existing = await identityRepo.findBySupertokensUserId(tx, supertokensUserId);
    if (existing) {
      if (existing.deletedAt) {
        throw new ForbiddenError('This account has been disabled');
      }
      return existing;
    }
    return identityRepo.insert(tx, { tenantId, supertokensUserId, email, role });
  });
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

// The only public surface other modules may depend on (via index.ts).
export const identityService = {
  getById,
  getBySupertokensUserId,
  findBySupertokensUserId,
  findOrCreateFromSession,
  setRole,
};
