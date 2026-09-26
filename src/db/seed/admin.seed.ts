import EmailPassword from 'supertokens-node/recipe/emailpassword/index.js';
import Session from 'supertokens-node/recipe/session/index.js';
import { z } from 'zod';
import { NotFoundError } from '../../core/errors.js';
import { initSupertokens } from '../../core/supertokens.js';
import { identityService } from '../../modules/identity/index.js';
import { tenancyService } from '../../modules/tenancy/index.js';
import { sqlClient } from '../client.js';

// Creates the first staff login for a store. There is no public admin
// signup (see core/supertokens.ts), so this is how an admin comes to exist.
// Safe to re-run: it creates the tenant only if missing, leaves an existing
// password alone, and promotes the user to admin if they aren't already.
//
//   SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... npm run db:seed:admin
// (or set them in .env; SEED_TENANT_SLUG / SEED_TENANT_NAME default to "demo")
const seedEnv = z.object({
  SEED_TENANT_SLUG: z.string().min(1).default('demo'),
  SEED_TENANT_NAME: z.string().min(1).default('Demo Shop'),
  SEED_ADMIN_EMAIL: z.string().email(),
  SEED_ADMIN_PASSWORD: z.string().min(8),
});

async function main(): Promise<void> {
  const env = seedEnv.parse(process.env);
  initSupertokens();

  const tenant = await tenancyService.resolveBySlug(env.SEED_TENANT_SLUG).catch(async (err: unknown) => {
    if (!(err instanceof NotFoundError)) {
      throw err;
    }
    console.log(`Creating tenant "${env.SEED_TENANT_SLUG}"`);
    return tenancyService.createTenant({ slug: env.SEED_TENANT_SLUG, name: env.SEED_TENANT_NAME });
  });

  const signUp = await EmailPassword.signUp(env.SEED_ADMIN_EMAIL, env.SEED_ADMIN_PASSWORD);
  const authUser =
    signUp.status === 'OK' ? signUp.user : await EmailPassword.getUserByEmail(env.SEED_ADMIN_EMAIL);
  if (!authUser) {
    throw new Error('Could not create or find the SuperTokens user');
  }
  console.log(
    signUp.status === 'OK'
      ? 'Created the login'
      : 'A login for this email already exists — its password was left unchanged',
  );

  const user = await identityService.findOrCreateFromSession(tenant.id, authUser.id, env.SEED_ADMIN_EMAIL, 'admin');
  if (user.role !== 'admin') {
    await identityService.setRole(tenant.id, user.id, 'admin');
    // The role rides in the access token, so existing sessions would keep
    // the old one until the next login.
    await Session.revokeAllSessionsForUser(authUser.id);
    console.log('Promoted the user to admin');
  }

  console.log(`Admin ready for tenant "${tenant.slug}"`);
}

main()
  .then(async () => {
    await sqlClient.end();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error(err);
    await sqlClient.end();
    process.exit(1);
  });
