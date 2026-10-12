import 'dotenv/config';
import { parseEnv } from './env.js';

const env = parseEnv();

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  port: env.PORT,
  appBaseUrl: env.APP_BASE_URL,
  webBaseUrl: env.WEB_BASE_URL,

  databaseUrl: env.DATABASE_URL,
  databasePoolMax: env.DATABASE_POOL_MAX,

  redisUrl: env.REDIS_URL,

  minio: {
    endPoint: env.MINIO_ENDPOINT,
    port: env.MINIO_PORT,
    useSSL: env.MINIO_USE_SSL,
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
    bucket: env.MINIO_BUCKET,
    // The address browsers use to reach MinIO (presigned upload URLs).
    publicEndPoint: env.MINIO_PUBLIC_ENDPOINT ?? env.MINIO_ENDPOINT,
    publicPort: env.MINIO_PUBLIC_PORT ?? env.MINIO_PORT,
    publicUseSSL: env.MINIO_PUBLIC_USE_SSL ?? env.MINIO_USE_SSL,
  },

  // Where processed pictures are served from: <base>/<key>, no trailing slash.
  mediaPublicBaseUrl: (
    env.MEDIA_PUBLIC_BASE_URL ??
    `${(env.MINIO_PUBLIC_USE_SSL ?? env.MINIO_USE_SSL) ? 'https' : 'http'}://${env.MINIO_PUBLIC_ENDPOINT ?? env.MINIO_ENDPOINT}:${env.MINIO_PUBLIC_PORT ?? env.MINIO_PORT}/${env.MINIO_BUCKET}`
  ).replace(/\/+$/, ''),

  trustProxyHops: env.TRUST_PROXY_HOPS,
  metricsToken: env.METRICS_TOKEN,

  supertokens: {
    connectionUri: env.SUPERTOKENS_CONNECTION_URI,
    apiKey: env.SUPERTOKENS_API_KEY,
    cookieDomain: env.COOKIE_DOMAIN,
  },

  platformApiKey: env.PLATFORM_API_KEY,

  // Null unless both keys are set: the Google recipe is only registered then.
  google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : null,

  resendApiKey: env.RESEND_API_KEY,
  emailFrom: env.EMAIL_FROM,
  emailTemplates: env.EMAIL_TEMPLATES,
  sendEmails: env.SEND_EMAILS ? env.SEND_EMAILS === 'true' : env.NODE_ENV === 'production',

  sentryDsn: env.SENTRY_DSN,
  sentryEnvironment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,

  // Manual transfer accounts (Zelle / Cash App / PayPal). Per-store settings arrive with M7.
  manualPayments: {
    payeeName: env.MANUAL_PAYEE_NAME,
    zelleEmail: env.ZELLE_EMAIL,
    cashappEmail: env.CASHAPP_EMAIL,
    cashappCashtag: env.CASHAPP_CASHTAG?.replace(/^\$/, ''),
    paypalEmail: env.PAYPAL_EMAIL,
    paypalMeHandle: env.PAYPAL_ME_HANDLE?.replace(/^.*paypal\.me\//i, '').replace(/^@/, ''),
  },

  tropipay: {
    clientId: env.TROPIPAY_CLIENT_ID,
    clientSecret: env.TROPIPAY_CLIENT_SECRET,
    env: env.TROPIPAY_ENV,
  },
} as const;
