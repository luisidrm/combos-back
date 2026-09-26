-- SuperTokens core keeps its own tables (users, sessions, ...) in a
-- separate database on the same Postgres server, so a single pg_dump of
-- the server covers app data AND auth data (CLAUDE.md section 2: backups
-- are not optional). Without POSTGRESQL_CONNECTION_URI the supertokens
-- image silently falls back to in-memory storage and loses everything on
-- restart.
--
-- CREATE DATABASE can't run inside a DO block, so this uses psql's \gexec
-- to make it idempotent. Runs automatically on a fresh volume; for an
-- existing one:
--   docker exec -i <db-container> psql -U combo_shop -d combo_shop < src/db/init/002-supertokens-db.sql

SELECT 'CREATE DATABASE supertokens'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'supertokens')\gexec
