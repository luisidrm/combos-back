import { Router } from 'express';

export const auditRouter = Router();

// TODO: an admin activity-feed read endpoint eventually. Writes happen
// through auditService.record(tx, ...), called from other modules'
// service methods — never through HTTP.
