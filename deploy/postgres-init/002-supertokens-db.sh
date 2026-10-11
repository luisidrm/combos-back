#!/bin/sh
# The SuperTokens core keeps users, password hashes and sessions in its own database on the same server.
# Back it up together with the main one (see deploy/backup.sh): losing it logs everyone out and loses every login.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
SELECT 'CREATE DATABASE supertokens' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'supertokens')\gexec
SQL
