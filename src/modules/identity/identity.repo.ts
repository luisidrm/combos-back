import { and, asc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Transaction } from '../../db/client.js';
import { users, type NewUser, type Role, type User } from './identity.schema.js';

export async function findBySupertokensUserId(tx: Transaction, supertokensUserId: string): Promise<User | undefined> {
  const [user] = await tx.select().from(users).where(eq(users.supertokensUserId, supertokensUserId)).limit(1);
  return user;
}

export async function findById(tx: Transaction, id: string): Promise<User | undefined> {
  const [user] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
  return user;
}

export async function findByIds(tx: Transaction, ids: string[]): Promise<User[]> {
  if (ids.length === 0) {
    return [];
  }
  return tx.select().from(users).where(inArray(users.id, ids));
}

export async function updateRole(tx: Transaction, id: string, role: Role): Promise<User | undefined> {
  const [user] = await tx.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, id)).returning();
  return user;
}

export async function updateLocale(tx: Transaction, id: string, locale: string): Promise<User | undefined> {
  const [user] = await tx.update(users).set({ locale, updatedAt: new Date() }).where(eq(users.id, id)).returning();
  return user;
}

export async function updateProfile(tx: Transaction, id: string, values: { locale?: string; fullName?: string; phone?: string }): Promise<User | undefined> {
  const [user] = await tx
    .update(users)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
  return user;
}

export async function insert(tx: Transaction, values: NewUser): Promise<User> {
  const [user] = await tx.insert(users).values(values).returning();
  if (!user) {
    throw new Error('Insert into users returned no row');
  }
  return user;
}

// The people who work for the store (everyone but buyers), disabled ones included, so they can be turned back on.
export async function listByRoles(tx: Transaction, roleList: Role[]): Promise<User[]> {
  return tx.select().from(users).where(inArray(users.role, roleList)).orderBy(asc(users.role), asc(users.email));
}

export async function findByEmail(tx: Transaction, email: string): Promise<User | undefined> {
  const [user] = await tx.select().from(users).where(eq(sql`lower(${users.email})`, email.toLowerCase())).limit(1);
  return user;
}

export async function updateMember(
  tx: Transaction,
  id: string,
  changes: { role?: Role; fullName?: string | null; phone?: string | null; deletedAt?: Date | null },
): Promise<User | undefined> {
  const [user] = await tx.update(users).set({ ...changes, updatedAt: new Date() }).where(eq(users.id, id)).returning();
  return user;
}

export async function countActiveAdmins(tx: Transaction): Promise<number> {
  const rows = await tx.select({ id: users.id }).from(users).where(and(eq(users.role, 'admin'), isNull(users.deletedAt)));
  return rows.length;
}

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => '\\' + c)}%`;

// Ids of the people whose name or email contains `text` (case-insensitive), at most `limit`.
export async function findIdsMatching(tx: Transaction, text: string, limit = 200): Promise<string[]> {
  const pattern = likePattern(text);
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(or(ilike(users.fullName, pattern), ilike(users.email, pattern)))
    .limit(limit);
  return rows.map((row) => row.id);
}
