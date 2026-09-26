import { events } from '../../core/events.js';
import type { MediaDeletedPayload } from '../media/index.js';
import { catalogService } from './catalog.service.js';

// A product needs at least one ready picture to stay live, so when one is
// deleted catalog re-checks. Pictures of other owners (users, deliveries,
// the tenant logo) are none of catalog's business.
async function handleMediaDeleted({ tenantId, ownerType, ownerId }: MediaDeletedPayload): Promise<void> {
  if (ownerType !== 'product') {
    return;
  }
  await catalogService.deactivateIfNoReadyPicture(tenantId, ownerId);
}

export function registerCatalogWorker(): void {
  events.on<MediaDeletedPayload>('media.deleted', handleMediaDeleted);
}
