#!/bin/sh
# Shlita Staging Rollback Script
# Usage: ./scripts/rollback.sh <PREVIOUS_IMAGE_TAG_OR_DIGEST>
# Example: ./scripts/rollback.sh ghcr.io/xiaoarnav/shlita:bc7f2d2f8563d1d15329038d68ce872c48f454d0

set -eu

if [ $# -lt 1 ]; then
  echo "Error: Target image or digest is required for rollback."
  echo "Usage: $0 <IMAGE_TAG_OR_DIGEST>"
  exit 1
fi

TARGET_IMAGE="$1"
COMPOSE_FILE="${COMPOSE_FILE:-compose.staging.yaml}"
DATA_VOLUME="${SHLITA_DATA_VOLUME:-shlita-staging-data}"

docker_compose() {
  if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
    docker compose -p "${COMPOSE_PROJECT_NAME}" -f "${COMPOSE_FILE}" "$@"
  else
    docker compose -f "${COMPOSE_FILE}" "$@"
  fi
}

echo "=== Shlita Staging Rollback Initiated ==="
echo "Target Image: ${TARGET_IMAGE}"
echo "Persistent Volume: ${DATA_VOLUME} (PRESERVED)"

# 1. Pull target image to verify availability before stopping active instance
if [ "${SHLITA_SKIP_PULL:-false}" = "true" ]; then
  echo "[1/4] Verifying target image availability (SHLITA_SKIP_PULL=true)..."
  docker image inspect "${TARGET_IMAGE}" >/dev/null
else
  echo "[1/4] Pulling target image..."
  docker pull "${TARGET_IMAGE}"
fi

# 2. Stop running gateway container
echo "[2/4] Stopping gateway service..."
SHLITA_IMAGE="${TARGET_IMAGE}" docker_compose stop gateway

# 3. Restart gateway with target image pinned
echo "[3/4] Starting gateway service with rolled back image..."
SHLITA_IMAGE="${TARGET_IMAGE}" docker_compose up -d --no-deps gateway

# 4. Verify health and readiness
echo "[4/4] Verifying readiness on rolled back instance..."
for i in $(seq 1 15); do
  if docker_compose exec -T gateway node -e "fetch('http://127.0.0.1:4000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "=== Rollback Successful: Gateway is READY ==="
    exit 0
  fi
  sleep 2
done

echo "Error: Gateway failed readiness check after rollback."
docker_compose logs --tail 50 gateway
exit 1
