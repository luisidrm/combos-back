import { readdirSync, readFileSync } from 'node:fs';
import type postgres from 'postgres';

// Runs the real generated migrations (src/db/migrations/*.sql) against a
// test database, so an integration test exercises the schema and RLS
// policies that actually ship rather than a hand-copied approximation that
// can silently drift from them. Must be given a superuser connection.
export async function applyMigrations(adminSql: postgres.Sql): Promise<void> {
  const dir = new URL('../migrations/', import.meta.url);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const statements = readFileSync(new URL(file, dir), 'utf8').split('--> statement-breakpoint');
    for (const statement of statements) {
      if (statement.trim()) {
        await adminSql.unsafe(statement);
      }
    }
  }
}
