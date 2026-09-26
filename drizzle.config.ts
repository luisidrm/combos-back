import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Deliberately DATABASE_ADMIN_URL, not DATABASE_URL — drizzle-kit needs DDL
// rights (CREATE TABLE, CREATE POLICY, ...) that the app's own runtime role
// (combo_shop_app) doesn't have and shouldn't have. See
// src/db/init/001-app-role.sql.
const databaseUrl = process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_ADMIN_URL must be set to run drizzle-kit');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/*/*.schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: databaseUrl,
  },
  verbose: true,
  strict: true,
});
