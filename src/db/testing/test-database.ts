import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type postgres from 'postgres';
import { applyMigrations } from './apply-migrations.js';
import { connectWithRetry } from './connect-with-retry.js';

export interface TestDatabase {
  // Superuser connection, for arranging data that bypasses RLS and for
  // asserting on raw rows. Never used to test application behaviour.
  adminSql: postgres.Sql;
  stop: () => Promise<void>;
}

function withDatabase(connectionUri: string, database: string): string {
  const url = new URL(connectionUri);
  url.pathname = `/${database}`;
  return url.toString();
}

function withCredentials(connectionUri: string, username: string, password: string): string {
  const url = new URL(connectionUri);
  url.username = username;
  url.password = password;
  return url.toString();
}

// Stands up a database with the real migrations applied and the restricted
// non-BYPASSRLS role the app runs as (see identity.rls.test.ts for why a
// superuser connection would make every isolation test pass vacuously),
// then points process.env.DATABASE_URL at it as that role.
//
// Sets process.env for config/index.ts — so a test file must import
// application code dynamically, after this returns, never before.
//
// By default that database lives in a disposable testcontainers Postgres.
// Docker Desktop on Windows sometimes wedges on creating *new* containers
// (they sit in "Created" forever) while existing ones keep working; setting
// TEST_DATABASE_ADMIN_URL to a superuser URL of an already-running Postgres
// makes this create and drop a throwaway database there instead.
export async function startTestDatabase(): Promise<TestDatabase> {
  process.env.NODE_ENV = 'test';
  process.env.APP_BASE_URL = 'http://localhost:4000';
  process.env.WEB_BASE_URL = 'http://localhost:3000';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.MINIO_ENDPOINT = 'localhost';
  process.env.MINIO_ACCESS_KEY = 'test';
  process.env.MINIO_SECRET_KEY = 'test';
  process.env.MINIO_BUCKET = 'test';
  process.env.SUPERTOKENS_CONNECTION_URI = 'http://localhost:3567';
  process.env.RESEND_API_KEY = 'test';

  const externalAdminUrl = process.env.TEST_DATABASE_ADMIN_URL;

  let adminUri: string;
  let teardown: () => Promise<void>;

  if (externalAdminUrl) {
    const databaseName = `test_${crypto.randomUUID().replaceAll('-', '')}`;
    const maintenance = await connectWithRetry(externalAdminUrl);
    await maintenance.unsafe(`CREATE DATABASE ${databaseName}`);
    adminUri = withDatabase(externalAdminUrl, databaseName);
    teardown = async () => {
      // FORCE also drops the app's own pooled connections to it.
      await maintenance.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await maintenance.end();
    };
  } else {
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    adminUri = container.getConnectionUri();
    teardown = async () => {
      await container.stop();
    };
  }

  const adminSql = await connectWithRetry(adminUri);
  await applyMigrations(adminSql);

  // Roles are cluster-wide, so on a shared server this may already exist.
  await adminSql.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_role') THEN
        CREATE ROLE app_role LOGIN PASSWORD 'app_role' NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$
  `);
  await adminSql`GRANT USAGE ON SCHEMA public TO app_role`;
  await adminSql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_role`;

  process.env.DATABASE_URL = withCredentials(adminUri, 'app_role', 'app_role');

  return {
    adminSql,
    stop: async () => {
      await adminSql.end();
      await teardown();
    },
  };
}
