#!/bin/sh
# Runs once, when the production Postgres volume is created (docker-entrypoint-initdb.d).
#
# Creates the role the API connects as: no superuser, no BYPASSRLS, no DDL rights, only DML on the tables migrations
# create (CLAUDE.md section 5: a superuser connection silently disables every row-level-security policy). This is the
# production twin of src/db/init/001-app-role.sql, except the password comes from APP_DB_PASSWORD instead of being
# written in the file.
set -eu
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set (the password of the combo_shop_app role)}"

psql -v ON_ERROR_STOP=1 \
  -v app_password="$APP_DB_PASSWORD" -v owner="$POSTGRES_USER" -v dbname="$POSTGRES_DB" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE combo_shop_app WITH LOGIN PASSWORD :'app_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE :"dbname" TO combo_shop_app;
GRANT USAGE ON SCHEMA public TO combo_shop_app;
-- Migrations run as the owner and create the tables; these make the app role able to use whatever they create.
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO combo_shop_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO combo_shop_app;
SQL
