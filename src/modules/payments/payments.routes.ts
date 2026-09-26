import { Router } from 'express';

export const paymentsRouter = Router();

// TODO(M3): webhook endpoints per provider. Every handler must verify the
// signature before parsing, be idempotent on the provider event ID, and
// never trust the webhook's amount over the order total (CLAUDE.md
// section 6).
