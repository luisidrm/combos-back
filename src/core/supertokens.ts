import supertokens from 'supertokens-node';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import Passwordless from 'supertokens-node/recipe/passwordless';
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
// Codes asked for one address per hour (a real user needs one or two), and
// re-sends of one login attempt.
const OTP_PER_EMAIL: LimitRule = { name: 'otp-request-email', limit: 5, windowSeconds: 60 * 60 };
const OTP_RESEND_PER_DEVICE: LimitRule = { name: 'otp-resend-device', limit: 5, windowSeconds: 60 * 60 };
// Each reset request sends an email to a real inbox.
const RESET_PER_EMAIL: LimitRule = { name: 'password-reset-email', limit: 3, windowSeconds: 60 * 60 };

// Staff choose their own password, so the bar is above SuperTokens' default
// (8 characters): at least 10, with a letter and a digit. Applies at reset too.
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
      // Buyers: email OTP, no password to manage (CLAUDE.md section 7).
      // Signing in for the first time creates their `users` row.
      Passwordless.init({
        contactMethod: 'EMAIL',
        flowType: 'USER_INPUT_CODE',
        emailDelivery: {
          override: (original) => ({
            ...original,
            sendEmail: async (input) => {
              if (!input.userInputCode) {
                throw new InternalError('Login email requested without a code');
              }
              await notificationsService.sendLoginCode(input.email, input.userInputCode);
            },
          }),
        },
        override: {
          apis: (original) => ({
            ...original,
            // Would let anyone probe which emails have an account.
            emailExistsGET: undefined,
            phoneNumberExistsGET: undefined,
            // Each request here sends a real email, and the per-IP limit in
            // app.ts can be sidestepped by rotating IPs — so the address
            // itself is also limited, however the requests arrive.
            createCodePOST: async (input) => {
              if (!original.createCodePOST) {
                throw new InternalError('Passwordless createCodePOST is unavailable');
              }
              if ('email' in input) {
                await enforceLimit(rateLimitStore, OTP_PER_EMAIL, input.email.trim().toLowerCase());
              }
              return original.createCodePOST(input);
            },
            resendCodePOST: async (input) => {
              if (!original.resendCodePOST) {
                throw new InternalError('Passwordless resendCodePOST is unavailable');
              }
              await enforceLimit(rateLimitStore, OTP_RESEND_PER_DEVICE, input.deviceId);
              return original.resendCodePOST(input);
            },
            consumeCodePOST: async (input) => {
              if (!original.consumeCodePOST) {
                throw new InternalError('Passwordless consumeCodePOST is unavailable');
              }
              input.userContext[TENANT_ID_KEY] = await resolveTenantId(input.options.req);
              return original.consumeCodePOST(input);
            },
          }),
          functions: (original) => ({
            ...original,
            consumeCode: async (input) => {
              const result = await original.consumeCode(input);
              if (result.status !== 'OK') {
                return result;
              }
              const tenantId = requireContext<string>(input.userContext, TENANT_ID_KEY);
              // The address the code was sent to is the person's email.
              const email = result.consumedDevice.email ?? result.user.emails[0];
              if (!email) {
                throw new InternalError('Passwordless user has no email');
              }
              const user = await identityService.findOrCreateFromSession(tenantId, result.user.id, email);
              input.userContext[ROLE_KEY] = user.role;
              return result;
            },
          }),
        },
      }),

      // Staff (admin, courier): email + password. There is no public signup —
      // accounts are created by `npm run db:seed:admin`. Password reset is
      // on, delivered through our own mailer (never SuperTokens' default
      // sender). Admin 2FA (TOTP) is deliberately not built yet.
      EmailPassword.init({
        signUpFeature: {
          formFields: [{ id: 'password', validate: async (value) => validatePassword(value) }],
        },
        emailDelivery: {
          override: (original) => ({
            ...original,
            sendEmail: async (input) => {
              await notificationsService.sendPasswordResetLink(input.user.email, input.passwordResetLink);
            },
          }),
        },
        override: {
          apis: (original) => ({
            ...original,
            signUpPOST: undefined,
            emailExistsGET: undefined,
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
            signIn: async (input) => {
              const result = await original.signIn(input);
              if (result.status !== 'OK') {
                return result;
              }
              const tenantId = requireContext<string>(input.userContext, TENANT_ID_KEY);
              const user = await identityService.findBySupertokensUserId(tenantId, result.user.id);
              // Valid password, but no staff account in *this* store (or a
              // disabled one): indistinguishable from a wrong password.
              if (!user || user.deletedAt || user.role === 'buyer') {
                return { status: 'WRONG_CREDENTIALS_ERROR' };
              }
              input.userContext[ROLE_KEY] = user.role;
              return result;
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
