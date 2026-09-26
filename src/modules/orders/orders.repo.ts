import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Transaction } from '../../db/client.js';
import {
  addresses,
  recipients,
  type Address,
  type NewAddress,
  type NewRecipient,
  type Recipient,
} from './orders.schema.js';

// All SQL for the orders module's tables lives here — nothing else touches
// them. Every function takes `tx: Transaction` as its first argument;
// repos never open connections (CLAUDE.md section 5). Recipient queries are
// always scoped to the owning buyer as well as the tenant (RLS): one buyer's
// address book is invisible to another buyer in the same store.

// --- recipients -----------------------------------------------------------

export async function listRecipients(tx: Transaction, buyerUserId: string): Promise<Recipient[]> {
  return tx
    .select()
    .from(recipients)
    .where(and(eq(recipients.buyerUserId, buyerUserId), isNull(recipients.deletedAt)))
    .orderBy(asc(recipients.fullName), asc(recipients.createdAt));
}

export async function findRecipient(tx: Transaction, buyerUserId: string, id: string): Promise<Recipient | undefined> {
  const [row] = await tx
    .select()
    .from(recipients)
    .where(and(eq(recipients.id, id), eq(recipients.buyerUserId, buyerUserId), isNull(recipients.deletedAt)))
    .limit(1);
  return row;
}

export async function insertRecipient(tx: Transaction, values: NewRecipient): Promise<Recipient> {
  const [row] = await tx.insert(recipients).values(values).returning();
  if (!row) {
    throw new Error('Insert into recipients returned no row');
  }
  return row;
}

export async function updateRecipient(
  tx: Transaction,
  buyerUserId: string,
  id: string,
  values: Partial<NewRecipient>,
): Promise<Recipient | undefined> {
  const [row] = await tx
    .update(recipients)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(recipients.id, id), eq(recipients.buyerUserId, buyerUserId), isNull(recipients.deletedAt)))
    .returning();
  return row;
}

export async function softDeleteRecipient(tx: Transaction, buyerUserId: string, id: string): Promise<boolean> {
  const rows = await tx
    .update(recipients)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(recipients.id, id), eq(recipients.buyerUserId, buyerUserId), isNull(recipients.deletedAt)))
    .returning({ id: recipients.id });
  return rows.length > 0;
}

// --- addresses ------------------------------------------------------------

// Default first, then oldest first, so the UI can pre-select index 0.
export async function listAddressesForRecipients(tx: Transaction, recipientIds: string[]): Promise<Address[]> {
  if (recipientIds.length === 0) {
    return [];
  }
  return tx
    .select()
    .from(addresses)
    .where(and(inArray(addresses.recipientId, recipientIds), isNull(addresses.deletedAt)))
    .orderBy(desc(addresses.isDefault), asc(addresses.createdAt));
}

export async function findAddress(tx: Transaction, recipientId: string, id: string): Promise<Address | undefined> {
  const [row] = await tx
    .select()
    .from(addresses)
    .where(and(eq(addresses.id, id), eq(addresses.recipientId, recipientId), isNull(addresses.deletedAt)))
    .limit(1);
  return row;
}

export async function countAddresses(tx: Transaction, recipientId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(addresses)
    .where(and(eq(addresses.recipientId, recipientId), isNull(addresses.deletedAt)));
  return row?.total ?? 0;
}

export async function insertAddress(tx: Transaction, values: NewAddress): Promise<Address> {
  const [row] = await tx.insert(addresses).values(values).returning();
  if (!row) {
    throw new Error('Insert into addresses returned no row');
  }
  return row;
}

export async function updateAddress(
  tx: Transaction,
  recipientId: string,
  id: string,
  values: Partial<NewAddress>,
): Promise<Address | undefined> {
  const [row] = await tx
    .update(addresses)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(addresses.id, id), eq(addresses.recipientId, recipientId), isNull(addresses.deletedAt)))
    .returning();
  return row;
}

// The partial unique index allows one default per recipient, so the old
// default must be cleared before a new one is set — always in one tx.
export async function clearDefaultAddress(tx: Transaction, recipientId: string): Promise<void> {
  await tx
    .update(addresses)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(eq(addresses.recipientId, recipientId), eq(addresses.isDefault, true), isNull(addresses.deletedAt)));
}

export async function softDeleteAddress(tx: Transaction, recipientId: string, id: string): Promise<boolean> {
  const rows = await tx
    .update(addresses)
    .set({ deletedAt: new Date(), isDefault: false, updatedAt: new Date() })
    .where(and(eq(addresses.id, id), eq(addresses.recipientId, recipientId), isNull(addresses.deletedAt)))
    .returning({ id: addresses.id });
  return rows.length > 0;
}

export async function softDeleteAddressesOfRecipient(tx: Transaction, recipientId: string): Promise<void> {
  await tx
    .update(addresses)
    .set({ deletedAt: new Date(), isDefault: false, updatedAt: new Date() })
    .where(and(eq(addresses.recipientId, recipientId), isNull(addresses.deletedAt)));
}

export async function findOldestAddress(tx: Transaction, recipientId: string): Promise<Address | undefined> {
  const [row] = await tx
    .select()
    .from(addresses)
    .where(and(eq(addresses.recipientId, recipientId), isNull(addresses.deletedAt)))
    .orderBy(asc(addresses.createdAt))
    .limit(1);
  return row;
}
