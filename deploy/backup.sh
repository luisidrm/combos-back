#!/bin/sh
# Dumps BOTH databases (the shop's and SuperTokens', which holds every password hash and session) and the pictures.
#
#   ./backup.sh                      writes to ./backups/<timestamp>/
#   BACKUP_REMOTE=user@host:/path ./backup.sh     also copies them off the server (rsync over ssh)
#
# A backup you have never restored is a hope, not a backup: run ./restore.sh against a scratch server once
# and write down how long it took. Schedule it with cron, e.g. every night at 03:10:
#   10 3 * * * cd /opt/combo-shop/back/deploy && ./backup.sh >> backups/backup.log 2>&1
set -eu
cd "$(dirname "$0")"
# Reads one value from .env.production without running it as a script (a value such as Pa'Casa <x@y> would break "source").
env_value() { grep -E "^$1=" .env.production | head -n 1 | cut -d= -f2-; }
POSTGRES_USER="$(env_value POSTGRES_USER)"

STAMP="$(date +%Y%m%d-%H%M%S)"
DIR="backups/$STAMP"
mkdir -p "$DIR"
COMPOSE="docker compose --env-file .env.production -f docker-compose.prod.yml"

for DB in combo_shop supertokens; do
  echo "==> Dumping $DB"
  $COMPOSE exec -T db pg_dump -U "$POSTGRES_USER" -d "$DB" --format=custom > "$DIR/$DB.dump"
done

echo "==> Copying the pictures"
$COMPOSE exec -T minio sh -c 'cd /data && tar -cf - .' | gzip > "$DIR/minio-data.tar.gz"

# Keep the last 14 local backups.
ls -1d backups/*/ 2>/dev/null | sort | head -n -14 | xargs -r rm -rf

if [ -n "${BACKUP_REMOTE:-}" ]; then
  echo "==> Copying off the server to $BACKUP_REMOTE"
  rsync -a "$DIR" "$BACKUP_REMOTE"/
fi
echo "Backup written to $DIR"
