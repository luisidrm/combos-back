-- The Postgres container's POSTGRES_USER (combo_shop) is a superuser with
-- BYPASSRLS by default — fine for running migrations, fatal for the
-- running app to connect as, since RLS silently no-ops for that role
-- (CLAUDE.md section 5). This creates the role the app actually connects
-- as: no superuser, no BYPASSRLS, no DDL rights, just DML on the tables
-- migrations create.
--
-- Runs automatically on a fresh container via
-- /docker-entrypoint-initdb.d/ (see docker-compose.yml). For an
-- already-initialized volume, run it manually once:
--   docker exec -i <db-container> psql -U combo_shop -d combo_shop < src/db/init/001-app-role.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'combo_shop_app') THEN
    CREATE ROLE combo_shop_app WITH LOGIN PASSWORD 'combo_shop_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE combo_shop TO combo_shop_app;
GRANT USAGE ON SCHEMA public TO combo_shop_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO combo_shop_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO combo_shop_app;

-- Migrations run as combo_shop (superuser) and create future tables owned
-- by it — this makes sure combo_shop_app automatically gets DML rights on
-- tables that don't exist yet, without a manual GRANT per migration.
ALTER DEFAULT PRIVILEGES FOR ROLE combo_shop IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO combo_shop_app;
ALTER DEFAULT PRIVILEGES FOR ROLE combo_shop IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO combo_shop_app;
