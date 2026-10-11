import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Applies the SQL migrations, for a deploy. In development `npm run db:migrate` (drizzle-kit) does the same job,
// but drizzle-kit is a dev dependency and does not exist in the production image; drizzle-orm's own migrator reads the
// same folder and the same journal. It connects as the superuser (DATABASE_ADMIN_URL), because migrations create tables
// and policies, which the app's restricted role may not do (CLAUDE.md section 5). Forward-only: it never rolls back.
//
//   node dist/db/migrate.js
// MIGRATIONS_DIR defaults to ./src/db/migrations (the image copies the folder there).
const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error('DATABASE_ADMIN_URL must be set to run migrations');
  process.exit(1);
}

const folder = path.resolve(process.env.MIGRATIONS_DIR ?? 'src/db/migrations');
const sql = postgres(url, { max: 1, connect_timeout: 30 });

try {
  await migrate(drizzle(sql), { migrationsFolder: folder });
  console.log(`Migrations applied from ${folder}`);
} catch (err) {
  console.error('Migration failed', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
