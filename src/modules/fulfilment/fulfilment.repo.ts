// All SQL for the fulfilment module's tables lives here — nothing else touches
// them. Every function takes `tx: Transaction` as its first argument;
// repos never open connections (CLAUDE.md section 5).
import { eq } from 'drizzle-orm';
import type { Transaction } from '../../db/client.js';
import { deliveries, type Delivery, type NewDelivery } from './fulfilment.schema.js';

export async function findByOrder(tx: Transaction, orderId: string): Promise<Delivery | undefined> {
  const [row] = await tx.select().from(deliveries).where(eq(deliveries.orderId, orderId)).limit(1);
  return row;
}

// One delivery per order (unique index). Confirming twice — a courier retrying after a dropped
// connection — updates the same row rather than failing or duplicating it.
export async function upsertDelivery(tx: Transaction, values: NewDelivery): Promise<Delivery> {
  const [row] = await tx
    .insert(deliveries)
    .values(values)
    .onConflictDoUpdate({
      target: [deliveries.tenantId, deliveries.orderId],
      set: {
        deliveredByUserId: values.deliveredByUserId,
        recipientNameConfirmed: values.recipientNameConfirmed,
        notes: values.notes,
        deliveredAt: values.deliveredAt,
      },
    })
    .returning();
  if (!row) throw new Error('Delivery upsert returned no row');
  return row;
}
