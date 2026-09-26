import supertokens from 'supertokens-node';
import EmailPassword from 'supertokens-node/recipe/emailpassword/index.js';
import Passwordless from 'supertokens-node/recipe/passwordless/index.js';
import Session from 'supertokens-node/recipe/session/index.js';
import { config } from '../config/index.js';
import { InternalError, UnauthorizedError } from './errors.js';
import { redisConnection } from './queue.js';
import { createRedisStore, enforceLimit, type LimitRule } from './rate-limit.js';
import { identityService } from '../modules/identity/index.js';
import { notificationsService } from '../modules/notifications/index.js';
import { tenancyService } from '../modules/tenancy/index.js';

// SuperTokens users are global, but a login is always *for* one store. The
// tenant comes from the same x-tenant-slug header resolveTenant reads. A
// login API override resolves it and drops it into `userContext`, which
// SuperTokens threads through to every recipe function called for that
// request — so the function overrides below, and finally the Session's
// createNewSession, can read it without a second lookup.
const rateLimitStore = createRedisStore(redisConnection);
// Codes asked for one address per hour (a real user needs one or two), and
// re-sends of one login attempt.
const OTP_PER_EMAIL: LimitRule = { name: 'otp-request-email', limit: 5, windowSeconds: 60 * 60 };
const OTP_RESEND_PER_DEVICE: LimitRule = { name: 'otp-resend-device', limit: 5, windowSeconds: 60 * 60 };

const TENANT_ID_KEY = 'comboTenantId';
const ROLE_KEY = 'comboRole';

type HeaderReader = { getHeaderValue(name: string): string | undefined };

async function resolveTenantId(req: HeaderReader): Promise<string> {
  const slug = req.getHeaderValue('x-tenant-slug');
  if (!slug) {
    throw new UnauthorizedError('Missing tenant identifier');
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
              if (!result.user.email) {
                throw new InternalError('Passwordless user has no email');
              }
              const user = await identityService.findOrCreateFromSession(tenantId, result.user.id, result.user.email);
              input.userContext[ROLE_KEY] = user.role;
              return result;
            },
          }),
        },
      }),

      // Staff (admin, courier): email + password. There is no public
      // signup — accounts are created by `npm run db:seed:admin` — and no
      // password-reset flow yet, whose emails would otherwise go out through
      // SuperTokens' own default sender. Admin 2FA and reset land in M5.
      EmailPassword.init({
        override: {
          apis: (original) => ({
            ...original,
            signUpPOST: undefined,
            emailExistsGET: undefined,
            generatePasswordResetTokenPOST: undefined,
            passwordResetPOST: undefined,
            signInPOST: async (input) => {
              if (!original.signInPOST) {
                throw new InternalError('EmailPassword signInPOST is unavailable');
              }
              input.userContext[TENANT_ID_KEY] = await resolveTenantId(input.options.req);
              return original.signInPOST(input);
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
