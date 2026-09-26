// Runs before every test file. Forces a known, inert environment so that
// importing application code:
//  - never depends on a developer's .env (CI has none), and
//  - can never reach a real database by accident — DATABASE_URL points at a
//    closed port until a test that wants a database (startTestDatabase)
//    deliberately replaces it.
// Assigned (not defaulted) on purpose: dotenv would otherwise fill in the
// developer's real values for anything left unset.
const inert: Record<string, string> = {
  NODE_ENV: 'test',
  APP_BASE_URL: 'http://localhost:4000',
  WEB_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://invalid:invalid@127.0.0.1:1/none',
  REDIS_URL: 'redis://127.0.0.1:1',
  MINIO_ENDPOINT: '127.0.0.1',
  MINIO_PORT: '1',
  MINIO_USE_SSL: 'false',
  MINIO_ACCESS_KEY: 'test',
  MINIO_SECRET_KEY: 'test',
  MINIO_BUCKET: 'test-media',
  SUPERTOKENS_CONNECTION_URI: 'http://127.0.0.1:1',
  RESEND_API_KEY: 'test',
  PLATFORM_API_KEY: 'test-platform-key-0123456789abcdef0123',
  METRICS_TOKEN: 'test-metrics-token-0123456789',
  TRUST_PROXY_HOPS: '0',
};

for (const [key, value] of Object.entries(inert)) {
  process.env[key] = value;
}
