import { z } from 'zod';

// z.coerce.boolean() is a trap for env vars: Boolean("false") is `true` in
// JS, since it only checks for a non-empty string. This actually parses
// the literal words "true"/"false".
function booleanFromString(defaultValue: 'true' | 'false') {
  return z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((value) => value === 'true');
}

// An env var left blank (`NAME=`) means "not set".
const optionalText = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_BASE_URL: z.string().url(),
  WEB_BASE_URL: z.string().url(),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  REDIS_URL: z.string().min(1),

  MINIO_ENDPOINT: z.string().min(1),
  MINIO_PORT: z.coerce.number().int().positive().default(9000),
  MINIO_USE_SSL: booleanFromString('false'),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET: z.string().min(1),
  // Where a *browser* reaches MinIO, when that differs from where the API
  // does (in production the API talks to MinIO on the Docker network while
  // browsers go through Caddy/Cloudflare). Presigned upload URLs are built
  // against this host. Each defaults to its MINIO_* counterpart.
  MINIO_PUBLIC_ENDPOINT: z.string().min(1).optional(),
  MINIO_PUBLIC_PORT: z.coerce.number().int().positive().optional(),
  MINIO_PUBLIC_USE_SSL: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  // Base URL under which the bucket's public/ prefix is served to browsers
  // (through Cloudflare in production). Derived from the MinIO settings when
  // unset, which is right for local development.
  MEDIA_PUBLIC_BASE_URL: z.string().url().optional(),

  // How many reverse proxies sit in front of the API (Cloudflare + Caddy = 2).
  // Needed so req.ip, and therefore rate limiting, sees the real client rather
  // than the proxy. 0 means "connected directly", correct for local dev.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  // Bearer token for GET /metrics. In production the endpoint is off without one.
  METRICS_TOKEN: z.string().min(16).optional(),

  // The session cookie's domain. Leave unset in development (localhost). In production, when the web app is on
  // example.com and the API on api.example.com, set it to ".example.com": without it the browser keeps the cookie
  // on the API host only, sign-in answers OK, and every call after it is a 401.
  COOKIE_DOMAIN: optionalText,

  SUPERTOKENS_CONNECTION_URI: z.string().url(),
  SUPERTOKENS_API_KEY: z.string().optional(),

  // Guards POST /tenancy until a real platform-admin role exists (M7). Unset
  // means store creation over HTTP is disabled; the seed script needs no key.
  PLATFORM_API_KEY: z.string().min(32).optional(),

  // Sign in with Google. Both or neither: with neither, the feature is simply off (development, tests).
  GOOGLE_CLIENT_ID: optionalText,
  GOOGLE_CLIENT_SECRET: optionalText,

  RESEND_API_KEY: z.string().min(1),
  EMAIL_FROM: z.string().min(1).default('onboarding@resend.dev'),
  // Really send emails through Resend? Unset = only in production; elsewhere the message is just logged.
  // Set `true` to try the real emails in development (with the default sender, Resend only delivers
  // to the address your Resend account was registered with).
  SEND_EMAILS: z.enum(['true', 'false']).optional(),

  // Error monitoring (Sentry, or GlitchTip self-hosted: same protocol). Unset = nothing is sent.
  SENTRY_DSN: optionalText,
  SENTRY_ENVIRONMENT: optionalText,

  // Where buyers send money for the manual transfer option (Zelle / Cash App / PayPal). A method is
  // offered only when its account is set; blank counts as unset. See docs/API.md section 9b.
  MANUAL_PAYEE_NAME: optionalText,
  ZELLE_EMAIL: optionalText,
  CASHAPP_EMAIL: optionalText,
  // `$cashtag` or `cashtag`: with it the Cash App link opens with the amount already filled in.
  CASHAPP_CASHTAG: optionalText,
  PAYPAL_EMAIL: optionalText,
  // paypal.me handle: with it the PayPal link opens with the amount already filled in.
  PAYPAL_ME_HANDLE: optionalText,

  TROPIPAY_CLIENT_ID: z.string().optional(),
  TROPIPAY_CLIENT_SECRET: z.string().optional(),
  TROPIPAY_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    console.error('Invalid environment configuration:', result.error.flatten().fieldErrors);
    throw new Error('Invalid environment configuration');
  }
  return result.data;
}
