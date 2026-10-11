#!/bin/sh
# Restores a backup made by backup.sh into the RUNNING stack. Destructive: it replaces the current data.
#
#   ./restore.sh backups/20261004-031000
#
# Do this on a scratch server first, to know it works and how long it takes.
set -eu
cd "$(dirname "$0")"
. ./.env.production

DIR="${1:?Usage: ./restore.sh backups/<timestamp>}"
[ -f "$DIR/combo_shop.dump" ] || { echo "$DIR/combo_shop.dump not found"; exit 1; }
COMPOSE="docker compose --env-file .env.production -f docker-compose.prod.yml"

printf "This REPLACES the live data with %s. Type YES to continue: " "$DIR"
read -r answer
[ "$answer" = "YES" ] || { echo "Cancelled."; exit 1; }

echo "==> Stopping the API and the worker"
$COMPOSE stop api worker web

for DB in combo_shop supertokens; do
  echo "==> Restoring $DB"
  $COMPOSE exec -T db psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
  $COMPOSE exec -T db pg_restore -U "$POSTGRES_USER" -d "$DB" --no-owner --role="$POSTGRES_USER" < "$DIR/$DB.dump"
done
# The app role needs its rights on the restored tables.
$COMPOSE exec -T db psql -U "$POSTGRES_USER" -d combo_shop -c "GRANT USAGE ON SCHEMA public TO combo_shop_app" \
  -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO combo_shop_app" \
  -c "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO combo_shop_app"

if [ -f "$DIR/minio-data.tar.gz" ]; then
  echo "==> Restoring the pictures"
  gunzip -c "$DIR/minio-data.tar.gz" | $COMPOSE exec -T minio sh -c 'cd /data && tar -xf -'
fi

echo "==> Starting again"
$COMPOSE up -d
echo "Restored from $DIR."
