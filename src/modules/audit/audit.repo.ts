import type { Transaction } from '../../db/client.js';
import { auditLog, type NewAuditLogEntry } from './audit.schema.js';

export async function insert(tx: Transaction, values: NewAuditLogEntry): Promise<void> {
  await tx.insert(auditLog).values(values);
}
