import supertokens from 'supertokens-node';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import EmailVerification from 'supertokens-node/recipe/emailverification';
import Session from 'supertokens-node/recipe/session';
import { config } from '../config/index.js';
import { InternalError, UnauthorizedError, ValidationError } from './errors.js';
import { logger } from './logger.js';
import { redisConnection } from './queue.js';
import { createRedisStore, enforceLimit, type LimitRule } from './rate-limit.js';
import { identityService } from '../modules/identity/index.js';
import { notificationsService } from '../modules/notifications/index.js';
import { tenancyService } from '../modules/tenancy/index.js';

// SuperTokens has its own notion of a tenant (multitenancy, added in later SDK
// versions). We don't use it: our stores are modelled in our own database, and
// every SuperTokens call runs in its built-in default tenant.
const SUPERTOKENS_TENANT = 'public';

const rateLimitStore = createRedisStore(redisConnection);
// Each verification email goes to a real inbox: limit re-sends per account.
const VERIFY_EMAIL_PER_USER: LimitRule = { name: 'verify-email-user', limit: 5, windowSeconds: 60 * 60 };
// Each reset request sends an email to a real inbox.
const RESET_PER_EMAIL: LimitRule = { name: 'password-reset-email', limit: 3, windowSeconds: 60 * 60 };

// Everyone with a password (buyers and staff) meets the same bar, above
// SuperTokens' default (8 characters): at least 10, with a letter and a digit.
// Applies at signup and at reset.
const MIN_PASSWORD_LENGTH = 10;

// SuperTokens users are global, but a login is always *for* one store. The
// tenant comes from the same x-tenant-slug header resolveTenant reads. A
// login API override resolves it and drops it into `userContext`, which
// SuperTokens threads through to every recipe function called for that
// request — so the function overrides below, and finally the Session's
// createNewSession, can read it without a second lookup.
const TENANT_ID_KEY = 'comboTenantId';
const ROLE_KEY = 'comboRole';

const SLUG_PATTERN = /^[a-z0-9-]{1,63}$/;
// Same looseness as the recipient phone in orders.schema.ts: rejects junk, not formatting.
const PHONE_PATTERN = /^\+?[0-9 ()-]{7,20}$/;
const PROFILE_KEY = 'comboSignUpProfile';

type HeaderReader = { getHeaderValue(name: string): string | undefined };

async function resolveTenantId(req: HeaderReader): Promise<string> {
  const slug = req.getHeaderValue('x-tenant-slug');
  if (!slug) {
    throw new UnauthorizedError('Missing tenant identifier');
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new ValidationError('Invalid tenant identifier');
  }
  return (await tenancyService.resolveBySlug(slug)).id;
}

function requireContext<T>(userContext: Record<string, unknown>, key: string): T {
  const value = userContext[key];
  if (value === undefined) {
    // Would mean a login path that skipped the API overrides below —
    // failing here beats issuing a session with no tenant/role claim.
    throw new InternalError(`Login context is missing "${key}"`);
  }
  return value as T;
}

export function validatePassword(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`;
  }
  if (value.length > 100) {
    return 'Password must be at most 100 characters long';
  }
  if (!/[a-zA-Z]/.test(value) || !/[0-9]/.test(value)) {
    return 'Password must contain at least one letter and one number';
  }
  return undefined;
}

export function initSupertokens(): void {
  supertokens.init({
    framework: 'express',
    supertokens: {
      connectionURI: config.supertokens.connectionUri,
      apiKey: config.supertokens.apiKey,
    },
    appInfo: {
      appName: 'Combo Shop',
      apiDomain: config.appBaseUrl,
      websiteDomain: config.webBaseUrl,
      apiBasePath: '/auth',
      websiteBasePath: '/auth',
    },
    recipeList: [
      // Everyone signs in with email + password. Buyers sign themselves up (a
      // `users` row with role buyer is created for the store they sign up at);
      // staff (admin, courier) have no public signup — `npm run db:seed:admin`
      // creates them. Password reset and email verification go through our own
      // mailer, never SuperTokens' default sender. Admin 2FA (TOTP) is
      // deliberately not built yet.
      EmailPassword.init({
        signUpFeature: {
          formFields: [
            { id: 'password', validate: async (value) => validatePassword(value) },
            {
              id: 'name',
              validate: async (value) =>
                typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 255
                  ? undefined
                  : 'Name is required (up to 255 characters)',
            },
            {
              id: 'phone',
              optional: true,
              validate: async (value) =>
                value === '' || (typeof value === 'string' && PHONE_PATTERN.test(value.trim())) ? undefined : 'Not a valid phone number',
            },
          ],
        },
        emailDelivery: {
          override: (original) => ({
            ...original,
            sendEmail: async (input) => {
              // Same idea as the verification link: land on our own page
              // (/admin/reset-password serves everyone with a password), keeping
              // SuperTokens' token query.
              const link = `${config.webBaseUrl}/admin/reset-password${new URL(input.passwordResetLink).search}`;
              await notificationsService.sendPasswordResetLink(input.user.email, link);
            },
          }),
        },
        override: {
          apis: (original) => ({
            ...original,
            emailExistsGET: undefined,
            // Buyer signup. Like sign-in it is always *for* one store; the
            // name/phone the form collected ride along in the context to the
            // signUp function below, which writes them on the new `users` row.
            signUpPOST: async (input) => {
              if (!original.signUpPOST) {
                throw new InternalError('EmailPassword signUpPOST is unavailable');
              }
              input.userContext[TENANT_ID_KEY] = await resolveTenantId(input.options.req);
              const field = (id: string) => {
                const value = input.formFields.find((f) => f.id === id)?.value;
                return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
              };
              input.userContext[PROFILE_KEY] = { fullName: field('name'), phone: field('phone') };
              return original.signUpPOST(input);
            },
            signInPOST: async (input) => {
              if (!original.signInPOST) {
                throw new InternalError('EmailPassword signInPOST is unavailable');
              }
              input.userContext[TENANT_ID_KEY] = await resolveTenantId(input.options.req);
              return original.signInPOST(input);
            },
            // "Send me a reset link". SuperTokens answers OK whether or not the
            // address has an account, so this cannot be used to discover
            // accounts; the per-address limit stops it being used to flood one
            // inbox. (The per-IP limit is in app.ts.)
            generatePasswordResetTokenPOST: async (input) => {
              if (!original.generatePasswordResetTokenPOST) {
                throw new InternalError('EmailPassword generatePasswordResetTokenPOST is unavailable');
              }
              const email = input.formFields.find((field) => field.id === 'email')?.value;
              if (typeof email === 'string') {
                await enforceLimit(rateLimitStore, RESET_PER_EMAIL, email.trim().toLowerCase());
              }
              return original.generatePasswordResetTokenPOST(input);
            },
            // "Here is my token and new password". SuperTokens changes the
            // password but leaves every existing session alive, and a reset is
            // exactly when someone may be locking out a thief — so end them all.
            passwordResetPOST: async (input) => {
              if (!original.passwordResetPOST) {
                throw new InternalError('EmailPassword passwordResetPOST is unavailable');
              }
              const result = await original.passwordResetPOST(input);
              if (result.status === 'OK') {
                try {
                  await Session.revokeAllSessionsForUser(result.user.id);
                } catch (err) {
                  // The password HAS changed; failing loudly is better than
                  // reporting success while old sessions survive.
                  logger.error({ err }, 'Password was reset but revoking existing sessions failed');
                  throw new InternalError('Password reset, but ending existing sessions failed');
                }
              }
              return result;
            },
          }),
          functions: (original) => ({
            ...original,
            signUp: async (input) => {
              const result = await original.signUp(input);
              // Only the public signup API sets a tenant; a server-side call
              // (the admin seed script) creates the login and its own `users` row.
              const tenantId = input.userContext[TENANT_ID_KEY] as string | undefined;
              if (result.status !== 'OK' || tenantId === undefined) {
                return result;
              }
              const profile = (input.userContext[PROFILE_KEY] ?? {}) as { fullName?: string; phone?: string };
              const user = await identityService.findOrCreateFromSession(tenantId, result.user.id, input.email, 'buyer', profile);
              input.userContext[ROLE_KEY] = user.role;
              // Ask them to confirm the address, once, right after creating the
              // account. A mail failure must not undo a signup that worked — they
              // can ask for another from the verify screen.
              try {
                await EmailVerification.sendEmailVerificationEmail(
                  SUPERTOKENS_TENANT,
                  result.user.id,
                  result.recipeUserId,
                  input.email,
                  input.userContext,
                );
              } catch (err) {
                logger.error({ err }, 'Could not send the email verification message after signup');
              }
              return result;
            },
            signIn: async (input) => {
              const result = await original.signIn(input);
              if (result.status !== 'OK') {
                return result;
              }
              const tenantId = requireContext<string>(input.userContext, TENANT_ID_KEY);
              // SuperTokens logins are global, so a person who signed up at one
              // store has a valid password at every store. Signing in at another
              // store makes them a buyer there (one `users` row per store) —
              // staff rows are only ever created by the seed script, so this
              // cannot grant anyone elevated rights.
              const user =
                (await identityService.findBySupertokensUserId(tenantId, result.user.id)) ??
                (await identityService.findOrCreateFromSession(tenantId, result.user.id, input.email));
              // A disabled account is indistinguishable from a wrong password.
              if (user.deletedAt) {
                return { status: 'WRONG_CREDENTIALS_ERROR' };
              }
              input.userContext[ROLE_KEY] = user.role;
              return result;
            },
          }),
        },
      }),

      // Buyers confirm their email once after signing up. OPTIONAL: an
      // unconfirmed buyer can browse, fill a cart and sign in; what needs a
      // confirmed address (placing an order — receipts and payment notices go
      // there) is enforced where it matters, by requireVerifiedEmail.
      EmailVerification.init({
        mode: 'OPTIONAL',
        emailDelivery: {
          override: (original) => ({
            ...original,
            sendEmail: async (input) => {
              // Point the link at our own web app (/account/verify-email; the
              // locale is added by the web app's middleware) instead of
              // SuperTokens' default route, keeping its token/tenantId query.
              const link = `${config.webBaseUrl}/account/verify-email${new URL(input.emailVerifyLink).search}`;
              await notificationsService.sendEmailVerificationLink(input.user.email, link);
            },
          }),
        },
        override: {
          apis: (original) => ({
            ...original,
            // "Send me another link" — each call sends a real email.
            generateEmailVerifyTokenPOST: async (input) => {
              if (!original.generateEmailVerifyTokenPOST) {
                throw new InternalError('EmailVerification generateEmailVerifyTokenPOST is unavailable');
              }
              await enforceLimit(rateLimitStore, VERIFY_EMAIL_PER_USER, input.session.getUserId());
              return original.generateEmailVerifyTokenPOST(input);
            },
          }),
        },
      }),

      // tenantId and role go in the access token (CLAUDE.md section 7), read
      // back by requireAuth / requireRole without a DB round trip. A
      // refresh keeps the payload, so a role change only takes effect on the
      // next login (or after revoking the user's sessions).
      Session.init({
        // Sessions are httpOnly cookies, full stop (CLAUDE.md section 2: "Do
        // not add localStorage-based auth"). Newer SDK versions can also hand
        // the tokens back as plain response headers for the caller to store
        // itself, and choose that by default unless the client sends an
        // `st-auth-mode: cookie` hint — which supertokens-web-js does, but
        // nothing here should depend on a client behaving. Pinning it removes
        // the choice entirely, for every client, always.
        getTokenTransferMethod: () => 'cookie',
        override: {
          functions: (original) => ({
            ...original,
            createNewSession: async (input) => {
              const tenantId = requireContext<string>(input.userContext, TENANT_ID_KEY);
              const role = requireContext<string>(input.userContext, ROLE_KEY);
              input.accessTokenPayload = { ...input.accessTokenPayload, tenantId, role };
              return original.createNewSession(input);
            },
          }),
        },
      }),
    ],
  });
}

// Used by the seed script and tests; everything runs in SuperTokens' one tenant.
export { SUPERTOKENS_TENANT };
