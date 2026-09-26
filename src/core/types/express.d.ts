// Augments Express's Request type with the fields our middleware attaches.
import type { User } from '../../modules/identity/index.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by resolveTenant. Every handler downstream can rely on this being present. */
      tenantId: string;
      /**
       * Set by requireAuth (always) and optionalAuth (when there is a valid
       * session): the caller's own `users` row for this store, read fresh from
       * the database on this request — so role and disabled-state are current,
       * not whatever the session token was minted with.
       */
      authUser?: User;
    }
  }
}
