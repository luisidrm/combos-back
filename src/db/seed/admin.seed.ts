import supertokens from 'supertokens-node';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import EmailVerification from 'supertokens-node/recipe/emailverification';
import Session from 'supertokens-node/recipe/session';
import { z } from 'zod';
import { NotFoundError } from '../../core/errors.js';
import { initSupertokens, SUPERTOKENS_TENANT, validatePassword } from '../../core/supertokens.js';
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
  // Optional details for the person (shown in the team list and on their orders' audit trail).
  SEED_ADMIN_NAME: z.string().trim().min(1).max(255).optional(),
  SEED_ADMIN_PHONE: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,20}$/)
    .optional(),
  // admin (default) or staff (the packer). Re-running with another role changes an existing user's role.
  SEED_ROLE: z.enum(['admin', 'staff', 'courier']).default('admin'),
  // The same policy the login endpoints enforce — signing up through the
  // recipe directly, as this script does, would otherwise skip it.
  SEED_ADMIN_PASSWORD: z.string().superRefine((value, ctx) => {
    const problem = validatePassword(value);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  }),
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

  const signUp = await EmailPassword.signUp(SUPERTOKENS_TENANT, env.SEED_ADMIN_EMAIL, env.SEED_ADMIN_PASSWORD);
  // An address may already have a login (this script is re-runnable): find the
  // email+password one, not e.g. a buyer's passwordless account with the same email.
  const existing = await supertokens.listUsersByAccountInfo(SUPERTOKENS_TENANT, { email: env.SEED_ADMIN_EMAIL });
  const authUser =
    signUp.status === 'OK'
      ? signUp.user
      : existing.find((candidate) => candidate.loginMethods.some((method) => method.recipeId === 'emailpassword'));
  if (!authUser) {
    throw new Error('Could not create or find the SuperTokens user');
  }
  console.log(
    signUp.status === 'OK'
      ? 'Created the login'
      : 'A login for this email already exists — its password was left unchanged',
  );

  // Staff are vouched for by whoever runs this script — no inbox round trip.
  const recipeUserId = authUser.loginMethods.find((method) => method.recipeId === 'emailpassword')?.recipeUserId;
  if (recipeUserId) {
    const token = await EmailVerification.createEmailVerificationToken(SUPERTOKENS_TENANT, recipeUserId, env.SEED_ADMIN_EMAIL);
    if (token.status === 'OK') {
      await EmailVerification.verifyEmailUsingToken(SUPERTOKENS_TENANT, token.token);
    }
  }

  const user = await identityService.findOrCreateFromSession(tenant.id, authUser.id, env.SEED_ADMIN_EMAIL, env.SEED_ROLE);
  if (env.SEED_ADMIN_NAME || env.SEED_ADMIN_PHONE) {
    await identityService.updateProfile(tenant.id, user.id, { fullName: env.SEED_ADMIN_NAME, phone: env.SEED_ADMIN_PHONE });
  }
  if (user.role !== env.SEED_ROLE) {
    await identityService.setRole(tenant.id, user.id, env.SEED_ROLE);
    // The role rides in the access token, so existing sessions would keep
    // the old one until the next login.
    await Session.revokeAllSessionsForUser(authUser.id);
    console.log(`Changed the user's role to ${env.SEED_ROLE}`);
  }

  console.log(`${env.SEED_ROLE} ready for tenant "${tenant.slug}"`);
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
