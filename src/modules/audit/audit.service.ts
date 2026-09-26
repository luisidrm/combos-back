import type { Transaction } from '../../db/client.js';
import * as auditRepo from './audit.repo.js';

interface RecordInput {
  tenantId: string;
  actorUserId?: string;
  entityType: string;
  entityId: string;
  action: string;
  note?: string;
}

// Takes the caller's own transaction rather than opening one with
// withTenant — the whole point of audit_log is that it commits atomically
// with whatever it's recording (e.g. an order state transition). Every
// other module's service opens its own transaction; this one deliberately
// doesn't.
async function record(tx: Transaction, input: RecordInput): Promise<void> {
  await auditRepo.insert(tx, input);
}

// The only public surface other modules may depend on (via index.ts).
export const auditService = { record };
