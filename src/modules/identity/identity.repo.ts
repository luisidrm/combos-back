import { eq, inArray } from 'drizzle-orm';
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

export async function insert(tx: Transaction, values: NewUser): Promise<User> {
  const [user] = await tx.insert(users).values(values).returning();
  if (!user) {
    throw new Error('Insert into users returned no row');
  }
  return user;
}
