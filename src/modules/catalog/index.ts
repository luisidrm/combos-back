export { catalogRouter as router } from './catalog.routes.js';
export { catalogService } from './catalog.service.js';
export { registerCatalogWorker } from './catalog.worker.js';
export type { PublicCategory, PublicProduct, PublicProductDetail, ProductSnapshot } from './catalog.service.js';
export type { StockStatus } from './catalog.schema.js';
