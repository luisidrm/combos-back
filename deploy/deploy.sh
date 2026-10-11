#!/bin/sh
# Deploys the current commit and keeps the previous release one command away.
#
#   ./deploy.sh            build, back up the databases, migrate, start
#   ./rollback.sh          go back to the previous release (see that file for the limits)
#
# Run it on the server, from back/deploy, with .env.production filled in. Migrations are forward-only, so every
# deploy takes a database backup first: that backup, not a "down" migration, is how a bad migration is undone.
set -eu
cd "$(dirname "$0")"

[ -f .env.production ] || { echo "Missing .env.production (copy .env.production.example)"; exit 1; }

RELEASE="$(git -C .. rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)"
export RELEASE
COMPOSE="docker compose --env-file .env.production -f docker-compose.prod.yml"

# Remember what was running, for rollback.sh
PREVIOUS="$(docker inspect --format '{{ index .Config.Image }}' combo-shop-api-1 2>/dev/null | sed 's/.*://' || true)"
[ -n "$PREVIOUS" ] && echo "$PREVIOUS" > .previous-release

echo "==> Building release $RELEASE"
$COMPOSE build

if docker ps --format '{{.Names}}' | grep -q '^combo-shop-db-1$'; then
  echo "==> Backing up the databases before migrating"
  ./backup.sh
fi

echo "==> Starting (migrations run first, the API waits for them)"
$COMPOSE up -d --remove-orphans

echo "==> Waiting for the API to be ready"
for i in $(seq 1 30); do
  if $COMPOSE exec -T api node -e "fetch('http://127.0.0.1:4000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo "Release $RELEASE is up."
    $COMPOSE exec -T api node -e "fetch('http://127.0.0.1:4000/ready').then(r=>r.json()).then(j=>console.log('ready:',JSON.stringify(j)))"
    exit 0
  fi
  sleep 3
done
echo "The API did not become ready. Run ./rollback.sh, then look at: docker compose logs api migrate"
exit 1
