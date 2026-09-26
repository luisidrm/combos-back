import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError, ValidationError } from '../errors.js';

// Same shape the tenants.slug column enforces at creation.
const SLUG_PATTERN = /^[a-z0-9-]{1,63}$/;

// Resolves the current tenant and attaches req.tenantId, which every
// tenant-scoped service call then passes into withTenant(). CLAUDE.md
// section 14 defers subdomain-based resolution to M7 (multi-tenant SaaS);
// until there's a paying second tenant, resolve from a header instead.
export async function resolveTenant(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    // TODO(M7): resolve from the request's subdomain once tenant-facing
    // branding/subdomains ship. For now, single-tenant callers (the web
    // app, admin, courier PWA) pass this explicitly.
    const slug = req.header('x-tenant-slug');
    if (!slug) {
      throw new UnauthorizedError('Missing tenant identifier');
    }
    if (!SLUG_PATTERN.test(slug)) {
      throw new ValidationError('Invalid tenant identifier');
    }

    // Loaded at call time: the tenancy module's own routes import this file,
    // so a static import back would be a cycle (see auth.middleware.ts).
    const { tenancyService } = await import('../../modules/tenancy/index.js');
    const tenant = await tenancyService.resolveBySlug(slug);
    req.tenantId = tenant.id;
    next();
  } catch (err) {
    next(err);
  }
}
