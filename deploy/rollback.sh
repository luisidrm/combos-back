#!/bin/sh
# Starts the previous release again (the images are kept, tagged by commit).
#
# What this can and cannot undo: it swaps the CODE back. It does not undo a database migration (migrations are
# forward-only). A release whose migration changed the schema in a way the old code cannot read needs the backup that
# deploy.sh took first: ./restore.sh <file>. Most migrations only add columns or tables, which old code ignores.
set -eu
cd "$(dirname "$0")"

[ -f .previous-release ] || { echo "No previous release recorded (.previous-release is missing)"; exit 1; }
RELEASE="$(cat .previous-release)"
export RELEASE
echo "==> Rolling back to $RELEASE"
docker image inspect "combo-shop-api:$RELEASE" >/dev/null 2>&1 || { echo "The image combo-shop-api:$RELEASE no longer exists; rebuild that commit"; exit 1; }
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --no-build --remove-orphans
echo "Running $RELEASE again."
