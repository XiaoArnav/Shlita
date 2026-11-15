#!/usr/bin/env bash
# Step 18: Real Docker Compose Rollback and Ledger Continuity Verification Script
# Verifies:
# 1. Complete test isolation: Unique Compose project, disposable containers, volumes, networks
# 2. Preflight configuration check: Fails closed before startup or teardown if any staging resource is referenced
# 3. Healthy starting point: Gateway on current image answers /ready; records image ID, ledger volume, and seeded operation
# 4. Unavailable rollback image: Rollback exits nonzero before stopping gateway; gateway remains healthy on current image
# 5. Known-good image rollback: The actual rollback entry point (scripts/rollback.sh) starts target image; gateway answers /ready
# 6. Ledger continuity: Same ledger volume mounted after rollback; seeded operation ID, amount, and integrity survive intact
# 7. Worker coexistence: Backup worker container remains running and untouched by gateway rollback
# 8. Cleanup scoping: Only disposable drill resources are removed; canary volumes survive

set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not available on this host. Skipping Docker Compose rollback verification."
  exit 0
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is not available on this host. Skipping Docker Compose rollback verification."
  exit 0
fi

echo "============================================================"
echo " Starting Shlita Step 18 Isolated Compose Rollback Drill"
echo "============================================================"

# Global tracking of active disposable projects and canary volumes
DISPOSABLE_PROJECTS=()
CANARY_VOLUMES=()
DISPOSABLE_IMAGES=()

cleanup() {
  echo "Executing scoped cleanup handler..."
  for proj in "${DISPOSABLE_PROJECTS[@]:-}"; do
    if [ -n "$proj" ]; then
      echo "Tearing down disposable test stack: $proj..."
      docker compose -p "$proj" -f compose.staging.yaml down -v --remove-orphans >/dev/null 2>&1 || true
    fi
  done
  for c_vol in "${CANARY_VOLUMES[@]:-}"; do
    if [ -n "$c_vol" ]; then
      docker volume rm -f "$c_vol" >/dev/null 2>&1 || true
    fi
  done
  for d_img in "${DISPOSABLE_IMAGES[@]:-}"; do
    if [ -n "$d_img" ]; then
      docker rmi -f "$d_img" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# Build or reuse base staging image (Image 1 / Current)
IMAGE_CURRENT="${SHLITA_IMAGE:-shlita:staging-verify}"
if ! docker image inspect "$IMAGE_CURRENT" >/dev/null 2>&1; then
  echo "Building current container image $IMAGE_CURRENT..."
  docker build -t "$IMAGE_CURRENT" .
fi

# Build distinct compatible rollback target image (Image 2 / Target)
IMAGE_TARGET="shlita:rollback-target-$$-${RANDOM}"
DISPOSABLE_IMAGES+=("$IMAGE_TARGET")
echo "Building distinct rollback target container image $IMAGE_TARGET..."
docker build -t "$IMAGE_TARGET" --label "shlita.role=rollback-target-$$-${RANDOM}" .

IMAGE_CURRENT_ID="$(docker inspect --format='{{.Id}}' "$IMAGE_CURRENT")"
IMAGE_TARGET_ID="$(docker inspect --format='{{.Id}}' "$IMAGE_TARGET")"

echo "Current Image: $IMAGE_CURRENT (ID: $IMAGE_CURRENT_ID)"
echo "Target Image:  $IMAGE_TARGET (ID: $IMAGE_TARGET_ID)"

if [ "$IMAGE_CURRENT_ID" = "$IMAGE_TARGET_ID" ]; then
  echo "FATAL: Expected two distinct image IDs for rollback verification, got identical IDs." >&2
  exit 1
fi

export SHLITA_OPERATOR_KEY="0123456789abcdef0123456789abcdef0123456789abcdef"
export SHLITA_OPERATOR_ORG="pilot-staging-alpha"
export SHLITA_BACKUP_INTERVAL_SECONDS="86400"

# Preflight Isolation Validator
validate_compose_isolation() {
  local target_project="$1"
  local resolved_cfg
  if ! resolved_cfg="$(docker compose -p "$target_project" -f compose.staging.yaml config 2>&1)"; then
    echo "FATAL: Failed to resolve Compose configuration for project $target_project" >&2
    echo "$resolved_cfg" >&2
    return 1
  fi

  local protected_resources=(
    "shlita-staging-gateway"
    "shlita-staging-caddy"
    "shlita-staging-backup-worker"
    "shlita-staging-data"
    "shlita-staging-external-backups"
    "shlita-staging-caddy-data"
    "shlita-staging-caddy-config"
    "shlita-staging-net"
  )

  for res in "${protected_resources[@]}"; do
    if echo "$resolved_cfg" | grep -F -q "$res"; then
      echo "FATAL: Resolved Compose configuration references protected staging resource: $res" >&2
      return 1
    fi
  done

  return 0
}

# Setup canary volumes
CANARY_DATA_VOL="shlita-canary-ledger-$$-${RANDOM}"
CANARY_BACKUP_VOL="shlita-canary-backups-$$-${RANDOM}"
CANARY_VOLUMES+=("$CANARY_DATA_VOL" "$CANARY_BACKUP_VOL")

docker volume create "$CANARY_DATA_VOL" >/dev/null
docker volume create "$CANARY_BACKUP_VOL" >/dev/null

docker run --rm --entrypoint "" -v "${CANARY_DATA_VOL}:/data" "$IMAGE_CURRENT" sh -c 'echo "CANARY_LEDGER_DATA_UNTOUCHED" > /data/sentinel.txt'
docker run --rm --entrypoint "" -v "${CANARY_BACKUP_VOL}:/data" "$IMAGE_CURRENT" sh -c 'echo "CANARY_BACKUPS_DATA_UNTOUCHED" > /data/sentinel.txt'

assert_canaries_intact() {
  local context="$1"
  local d_val
  d_val="$(docker run --rm --entrypoint "" -v "${CANARY_DATA_VOL}:/data" "$IMAGE_CURRENT" cat /data/sentinel.txt 2>/dev/null || true)"
  d_val="${d_val//[$'\r\n ']/}"

  if [ "$d_val" != "CANARY_LEDGER_DATA_UNTOUCHED" ]; then
    echo "FAIL: Canary ledger volume was modified or deleted ($context)! Got: '$d_val'" >&2
    return 1
  fi

  local b_val
  b_val="$(docker run --rm --entrypoint "" -v "${CANARY_BACKUP_VOL}:/data" "$IMAGE_CURRENT" cat /data/sentinel.txt 2>/dev/null || true)"
  b_val="${b_val//[$'\r\n ']/}"

  if [ "$b_val" != "CANARY_BACKUPS_DATA_UNTOUCHED" ]; then
    echo "FAIL: Canary backup volume was modified or deleted ($context)! Got: '$b_val'" >&2
    return 1
  fi

  echo "PASS: Canary volumes confirmed intact ($context)."
  return 0
}

assert_canaries_intact "initial setup"

# Setup disposable rollback environment
PROJECT_NAME="shlita-rbdrill-$$-${RANDOM}"
DISPOSABLE_PROJECTS+=("$PROJECT_NAME")

export COMPOSE_PROJECT_NAME="$PROJECT_NAME"
export COMPOSE_FILE="compose.staging.yaml"
export SHLITA_IMAGE="$IMAGE_CURRENT"
export SHLITA_GATEWAY_CONTAINER="${PROJECT_NAME}-gateway"
export SHLITA_BACKUP_CONTAINER="${PROJECT_NAME}-backup-worker"
export SHLITA_CADDY_CONTAINER="${PROJECT_NAME}-caddy"
export SHLITA_DATA_VOLUME="${PROJECT_NAME}-data"
export SHLITA_BACKUPS_VOLUME="${PROJECT_NAME}-backups"
export SHLITA_CADDY_DATA_VOLUME="${PROJECT_NAME}-caddy-data"
export SHLITA_CADDY_CONFIG_VOLUME="${PROJECT_NAME}-caddy-config"
export SHLITA_NETWORK="${PROJECT_NAME}-net"
export PORT="4041"

echo "Validating resolved Compose configuration before startup..."
validate_compose_isolation "$PROJECT_NAME"
echo "Compose configuration verified safe and isolated for project: $PROJECT_NAME"

# ============================================================
# Check 1: Healthy Starting Point
# ============================================================
echo "Starting gateway and backup-worker on current image..."
docker compose -p "$PROJECT_NAME" -f compose.staging.yaml up -d gateway backup-worker

echo "Waiting for gateway service to become ready..."
GW_STATUS="starting"
for i in $(seq 1 30); do
  GW_STATUS="$(docker inspect --format='{{.State.Health.Status}}' "$SHLITA_GATEWAY_CONTAINER" 2>/dev/null || echo 'starting')"
  GW_STATUS="${GW_STATUS//[$'\r\n ']/}"
  if [ "$GW_STATUS" = "healthy" ]; then
    break
  fi
  sleep 1
done

if [ "$GW_STATUS" != "healthy" ]; then
  echo "FAIL: Gateway failed to become healthy (status: $GW_STATUS)" >&2
  docker compose -p "$PROJECT_NAME" -f compose.staging.yaml logs gateway >&2
  exit 1
fi

RUNNING_IMAGE_ID_1="$(docker inspect --format='{{.Image}}' "$SHLITA_GATEWAY_CONTAINER")"
RUNNING_IMAGE_ID_1="${RUNNING_IMAGE_ID_1//[$'\r\n ']/}"
MOUNTED_VOL_1="$(docker inspect --format='{{range .Mounts}}{{if eq .Destination "/var/lib/shlita"}}{{.Name}}{{end}}{{end}}' "$SHLITA_GATEWAY_CONTAINER")"
MOUNTED_VOL_1="${MOUNTED_VOL_1//[$'\r\n ']/}"

echo "Gateway is ready."
echo "Running Container Image ID: $RUNNING_IMAGE_ID_1"
echo "Mounted Ledger Volume: $MOUNTED_VOL_1"

if [ "$RUNNING_IMAGE_ID_1" != "$IMAGE_CURRENT_ID" ]; then
  echo "FAIL: Expected running image $IMAGE_CURRENT_ID, got $RUNNING_IMAGE_ID_1" >&2
  exit 1
fi

if [ "$MOUNTED_VOL_1" != "${PROJECT_NAME}-data" ]; then
  echo "FAIL: Expected mounted volume ${PROJECT_NAME}-data, got $MOUNTED_VOL_1" >&2
  exit 1
fi

# Seed a known ledger operation
echo "Seeding disposable ledger with committed financial operation..."
OP_ID="$(docker compose -p "$PROJECT_NAME" -f compose.staging.yaml exec -T -u shlita gateway node -e '
  const { createPolicyEngine } = await import("./dist/packages/core/src/index.js");
  const engine = createPolicyEngine("/var/lib/shlita/ledger.db");
  engine.registerAgent({
    agentId: "rollback-agent-01",
    allowedVendors: ["api.helius.xyz"],
    maxPerCallMicroUsdc: 50000n,
    periodBudgetMicroUsdc: 200000n,
    periodSeconds: 3600,
    circuitBreaker: { maxConsecutiveErrors: 3, maxCallsPerMinute: 20 },
  }, { rawApiKey: "key-rollback-agent-01", ownerOrg: "pilot-staging-alpha" });

  const claimed = engine.claimExecution({
    agentId: "rollback-agent-01",
    vendor: "api.helius.xyz",
    method: "POST",
    path: "/v0/token-metadata",
    fingerprint: "rb-fingerprint-001",
    idempotencyKey: "rb-drill-key-001",
    estimatedCostMicroUsdc: 25000n,
    reservedAmountMicroUsdc: 25000n,
    timestamp: Date.now(),
  });
  if (claimed.kind !== "execute") throw new Error("claimExecution failed: " + JSON.stringify(claimed));

  const finished = engine.finishExecution(claimed.operationId, {
    type: "succeeded",
    httpStatus: 200,
    result: { result: "ok" },
  });
  if (!finished.ok) throw new Error("finishExecution failed: " + JSON.stringify(finished));

  engine.close();
  process.stdout.write(claimed.operationId);
')"
OP_ID="${OP_ID//[$'\r\n ']/}"
echo "Seeded operation ID: $OP_ID"
if [ -z "$OP_ID" ]; then
  echo "FAIL: Operation ID was not returned during seeding" >&2
  exit 1
fi
echo "CHECK 1 PASS: Healthy starting point established."

# ============================================================
# Check 2: Unavailable Rollback Image
# ============================================================
echo "Testing unavailable rollback image (failure before stopping gateway)..."
UNAVAILABLE_IMAGE="ghcr.io/xiaoarnav/shlita:nonexistent-failure-drill-$$-${RANDOM}"

set +e
./scripts/rollback.sh "$UNAVAILABLE_IMAGE" >/tmp/rollback-fail.log 2>&1
RB_FAIL_STATUS=$?
set -e

if [ "$RB_FAIL_STATUS" -eq 0 ]; then
  echo "FAIL: Expected rollback to exit nonzero on unavailable image!" >&2
  cat /tmp/rollback-fail.log >&2
  exit 1
fi
echo "Rollback exited nonzero ($RB_FAIL_STATUS) as expected when target image cannot be pulled."

# Verify gateway was NOT stopped and remains healthy
GW_STILL_HEALTHY="$(docker inspect --format='{{.State.Health.Status}}' "$SHLITA_GATEWAY_CONTAINER" 2>/dev/null || echo 'down')"
GW_STILL_HEALTHY="${GW_STILL_HEALTHY//[$'\r\n ']/}"
echo "Gateway health after failed rollback: $GW_STILL_HEALTHY"

if [ "$GW_STILL_HEALTHY" != "healthy" ]; then
  echo "FAIL: Gateway was stopped or became unhealthy during failed rollback!" >&2
  exit 1
fi

RUNNING_IMAGE_ID_FAIL="$(docker inspect --format='{{.Image}}' "$SHLITA_GATEWAY_CONTAINER")"
RUNNING_IMAGE_ID_FAIL="${RUNNING_IMAGE_ID_FAIL//[$'\r\n ']/}"
if [ "$RUNNING_IMAGE_ID_FAIL" != "$IMAGE_CURRENT_ID" ]; then
  echo "FAIL: Gateway image unexpectedly changed during failed rollback!" >&2
  exit 1
fi
echo "CHECK 2 PASS: Unavailable rollback image failed before stopping the healthy gateway."

# ============================================================
# Check 3: Known-Good Image Rollback
# ============================================================
echo "Executing rollback to known-good target image $IMAGE_TARGET..."
SHLITA_SKIP_PULL=true ./scripts/rollback.sh "$IMAGE_TARGET"

echo "Waiting for gateway readiness after rollback..."
GW_POST_RB_STATUS="starting"
for i in $(seq 1 30); do
  GW_POST_RB_STATUS="$(docker inspect --format='{{.State.Health.Status}}' "$SHLITA_GATEWAY_CONTAINER" 2>/dev/null || echo 'starting')"
  GW_POST_RB_STATUS="${GW_POST_RB_STATUS//[$'\r\n ']/}"
  if [ "$GW_POST_RB_STATUS" = "healthy" ]; then
    break
  fi
  sleep 1
done

if [ "$GW_POST_RB_STATUS" != "healthy" ]; then
  echo "FAIL: Gateway failed to become healthy after rollback (status: $GW_POST_RB_STATUS)" >&2
  docker compose -p "$PROJECT_NAME" -f compose.staging.yaml logs gateway >&2
  exit 1
fi

RUNNING_IMAGE_ID_2="$(docker inspect --format='{{.Image}}' "$SHLITA_GATEWAY_CONTAINER")"
RUNNING_IMAGE_ID_2="${RUNNING_IMAGE_ID_2//[$'\r\n ']/}"
echo "Post-rollback Container Image ID: $RUNNING_IMAGE_ID_2"

if [ "$RUNNING_IMAGE_ID_2" != "$IMAGE_TARGET_ID" ]; then
  echo "FAIL: Expected gateway image to be rolled back to $IMAGE_TARGET_ID, got $RUNNING_IMAGE_ID_2" >&2
  exit 1
fi

# Worker coexistence check
WORKER_STATUS="$(docker inspect --format='{{.State.Status}}' "$SHLITA_BACKUP_CONTAINER" 2>/dev/null || echo 'down')"
WORKER_STATUS="${WORKER_STATUS//[$'\r\n ']/}"
WORKER_IMAGE="$(docker inspect --format='{{.Image}}' "$SHLITA_BACKUP_CONTAINER" 2>/dev/null || echo 'unknown')"
WORKER_IMAGE="${WORKER_IMAGE//[$'\r\n ']/}"
echo "backup-worker status after gateway rollback: $WORKER_STATUS (Image ID: $WORKER_IMAGE)"

if [ "$WORKER_STATUS" != "running" ]; then
  echo "FAIL: backup-worker container is not running after gateway rollback!" >&2
  exit 1
fi
echo "CHECK 3 PASS: Gateway rolled back to target image and verified ready; backup worker preserved."

# ============================================================
# Check 4: Ledger Continuity
# ============================================================
echo "Verifying ledger continuity on rolled-back instance..."
MOUNTED_VOL_2="$(docker inspect --format='{{range .Mounts}}{{if eq .Destination "/var/lib/shlita"}}{{.Name}}{{end}}{{end}}' "$SHLITA_GATEWAY_CONTAINER")"
MOUNTED_VOL_2="${MOUNTED_VOL_2//[$'\r\n ']/}"
echo "Mounted Volume after rollback: $MOUNTED_VOL_2"

if [ "$MOUNTED_VOL_2" != "$MOUNTED_VOL_1" ]; then
  echo "FAIL: Mounted volume changed across rollback: was $MOUNTED_VOL_1, now $MOUNTED_VOL_2" >&2
  exit 1
fi

docker compose -p "$PROJECT_NAME" -f compose.staging.yaml exec -T -u shlita -e EXPECTED_OP_ID="$OP_ID" gateway node -e '
  const { DatabaseSync } = await import("node:sqlite");
  const { createPolicyEngine } = await import("./dist/packages/core/src/index.js");

  const dbPath = "/var/lib/shlita/ledger.db";
  const rawDb = new DatabaseSync(dbPath, { readOnly: true });
  const row = rawDb.prepare("PRAGMA integrity_check").get();
  rawDb.close();
  if (!row || row.integrity_check !== "ok") {
    throw new Error("Integrity check failed: " + JSON.stringify(row));
  }
  console.log("Verified PRAGMA integrity_check: ok");

  const engine = createPolicyEngine(dbPath);
  const ops = engine.listOrganizationOperations("pilot-staging-alpha");
  const targetOp = ops.find(o => o.operationId === process.env.EXPECTED_OP_ID);
  if (!targetOp) {
    throw new Error("Operation " + process.env.EXPECTED_OP_ID + " not found after rollback");
  }
  if (targetOp.reservedAmountMicroUsdc !== "25000") {
    throw new Error("Recorded amount mismatch: expected 25000, got " + targetOp.reservedAmountMicroUsdc);
  }
  if (targetOp.state !== "ACCOUNTING_COMMITTED") {
    throw new Error("Recorded state mismatch: expected ACCOUNTING_COMMITTED, got " + targetOp.state);
  }
  engine.close();
  console.log("Verified restored operation after rollback: " + process.env.EXPECTED_OP_ID + " with 25000 micro-USDC (state: ACCOUNTING_COMMITTED)");
'
echo "CHECK 4 PASS: Ledger volume and seeded financial operation survived rollback intact."

# ============================================================
# Check 5: Cleanup
# ============================================================
echo "Tearing down disposable test stack..."
docker compose -p "$PROJECT_NAME" -f compose.staging.yaml down -v --remove-orphans >/dev/null 2>&1 || true

assert_canaries_intact "after rollback drill teardown"

if [ -n "$(docker volume ls -q -f name="${PROJECT_NAME}-data")" ]; then
  echo "FAIL: Disposable volume ${PROJECT_NAME}-data was not purged on teardown!" >&2
  exit 1
fi
if [ -n "$(docker ps -a -q -f name="${PROJECT_NAME}-gateway")" ]; then
  echo "FAIL: Disposable container ${PROJECT_NAME}-gateway was not purged on teardown!" >&2
  exit 1
fi

docker volume rm -f "$CANARY_DATA_VOL" "$CANARY_BACKUP_VOL" >/dev/null 2>&1 || true
CANARY_VOLUMES=()

echo "CHECK 5 PASS: Scoped cleanup confirmed. Disposable resources purged and canary volumes intact."

echo "============================================================"
echo " Compose Rollback Drill: ALL CHECKS PASSED"
echo " (Healthy start, failure pre-check, target rollback, ledger continuity, worker coexistence, clean teardown)"
echo "============================================================"
