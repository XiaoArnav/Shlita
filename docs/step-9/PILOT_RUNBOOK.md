# Shlita — Step 9: Pilot Runbook

**Purpose:** Operational guide for launching, configuring, and managing a controlled Shlita pilot with external developer partners.

---

## Pre-Pilot Checklist

- [ ] All automated tests pass (24 test suites, 145+ tests across core, gateway, SDK, browser, and rehearsal tests)
- [ ] Container image tagged and pushed to GHCR (`ghcr.io/xiaoarnav/shlita-gateway:staging`)
- [ ] VM provisioned with persistent storage
- [ ] TLS certificate active (Caddy auto-renewal)
- [ ] Environment variables configured (see section 2.1)
- [ ] Backup schedule and volume verified
- [ ] Log forwarding active without credential leakage
- [ ] Alert webhooks verified
- [ ] Pilot partner list finalized (max 3 organizations)
- [ ] Emergency contacts documented

---

## 1. Infrastructure Provisioning

```bash
# 1.1 Provision VM (example: Fly.io or Hetzner)
# Minimum: 2 vCPU, 4GB RAM, 50GB NVMe SSD
# OS: Ubuntu 24.04 LTS with Docker CE installed

# 1.2 Pull the verified container image
docker pull ghcr.io/xiaoarnav/shlita-gateway:staging

# 1.3 Create persistent data directories
sudo mkdir -p /var/lib/shlita/data
sudo mkdir -p /var/lib/shlita/backups
sudo chown -R 1000:1000 /var/lib/shlita
```

---

## 2. Gateway Deployment

```bash
# 2.1 Create environment configuration
cat > /opt/shlita/.env <<'EOF'
NODE_ENV=production
SHLITA_ENV=production
PORT=4000
SHLITA_DB_PATH=/var/lib/shlita/data/ledger.db
SHLITA_STATE_DIR=/var/lib/shlita/data
SHLITA_BACKUP_DIR=/var/lib/shlita/backups
SHLITA_OPERATOR_KEY=<generated-operator-key-at-least-32-chars>
SHLITA_OPERATOR_ORG=org_pilot_alpha
SHLITA_ALLOW_SIMULATION=false
# Provider credentials:
# HELIUS_API_KEY=<key>
# TAVILY_API_KEY=<key>
EOF

# 2.2 Start with Docker Compose
cd /opt/shlita
docker compose up -d

# 2.3 Verify health
curl -s http://localhost:4000/ready
# Expected: HTTP 200, {"status":"ok"}
```

---

## 3. TLS Termination (Caddy)

```bash
# 3.1 Install Caddy
sudo apt install caddy

# 3.2 Configure reverse proxy
cat > /etc/caddy/Caddyfile <<'EOF'
gateway.pilot.shlita.xyz {
    reverse_proxy localhost:4000
    log {
        output file /var/log/caddy/shlita.log
    }
}
EOF

# 3.3 Start Caddy (auto-provisions TLS via Let's Encrypt)
sudo systemctl restart caddy

# 3.4 Verify HTTPS
curl -s -I https://gateway.pilot.shlita.xyz/ready
# Expected: HTTP/2 200 with valid TLS
```

---

## 4. Partner Onboarding

```bash
# 4.1 Enroll pilot partner agent via operator API
curl -X POST https://gateway.pilot.shlita.xyz/v1/agents \
  -H "x-shlita-operator-key: $OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "partner-alpha-agent-1",
    "periodBudgetMicroUsdc": "100000",
    "maxPerCallMicroUsdc": "25000",
    "allowedVendors": ["api.helius.xyz", "api.openai.com"]
  }'
# Response returns {"agentId":"partner-alpha-agent-1","apiKey":"shlt_live_...","credentialStatus":"issued"}

# 4.2 Distribute to partner:
# - Agent API key (secure channel only; never sent in plaintext emails)
# - Scoped gateway URL: https://gateway.pilot.shlita.xyz
# - Packaged SDK archive or installation instructions: docs/sdk/quickstart.md
```

---

## 5. Monitoring & Alerting

### 5.1 Local Alert Rehearsal Drill
Execute the automated local outage and recovery alert drill against an isolated gateway and local webhook receiver:

```bash
node scripts/alert-rehearsal.mjs
```

**Drill Lifecycle & Verified Scenarios:**
1. **Healthy Baseline**: Probes `/ready` on the isolated gateway; receiver receives 0 incident alerts while gateway is healthy.
2. **Brief Interruption**: A transient failure below the configured failure threshold (e.g., 1 failure when threshold is 2) transitions the monitor to `DEGRADED` without firing premature alerts.
3. **Sustained Outage**: The gateway process is stopped. Upon reaching the threshold (2 consecutive failures), the monitor dispatches exactly **one** `gateway_outage` notification to the webhook receiver. Repeated failures while the outage persists are suppressed (0 duplicate notifications).
4. **Recovery Notification**: The gateway process is restored. Upon returning to HTTP 200 `ready`, the monitor dispatches exactly **one** `gateway_recovered` notification referencing the matching `incidentId`.
5. **Delivery Failure Handling**: When the webhook sink returns non-2xx (e.g., HTTP 500) or times out, the monitor executes bounded retries (3 total attempts) with backoff and reports delivery failure without crashing.
6. **Graceful Cleanup**: All child processes, sockets, and temporary database files are purged.

### 5.2 Standalone Readiness Monitor Daemon
The standalone monitor (`scripts/readiness-monitor.mjs`) runs independently of the gateway process, using standard `fetch` with strict TLS verification for HTTPS targets.

**CLI Invocation:**
```bash
node scripts/readiness-monitor.mjs \
  --target-url https://gateway.pilot.shlita.xyz \
  --webhook-url https://alerts.internal.example/webhooks/shlita \
  --interval-ms 10000 \
  --failure-threshold 3
```

**Configuration Reference:**

| Parameter | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `--target-url` | `SHLITA_GATEWAY_URL` / `STAGING_GATEWAY_URL` | `http://127.0.0.1:4000` | Gateway base URL (monitors `/ready`). |
| `--webhook-url` | `SHLITA_ALERT_WEBHOOK_URL` | `null` | Alert destination URL (e.g. Slack/PagerDuty webhook). |
| `--interval-ms` | `SHLITA_MONITOR_INTERVAL_MS` | `5000` | Polling frequency in milliseconds (rehearsal: `100ms`). |
| `--failure-threshold` | `SHLITA_MONITOR_FAILURE_THRESHOLD` | `3` | Consecutive failed probes required to trigger outage alert. |
| `--recovery-threshold` | `SHLITA_MONITOR_RECOVERY_THRESHOLD` | `1` | Consecutive successful probes required to trigger recovery alert. |
| `--probe-timeout-ms` | `SHLITA_PROBE_TIMEOUT_MS` | `2500` | HTTP request deadline per `/ready` probe. |

### 5.3 Event Payloads & Recognition

**Outage Notification (`gateway_outage`):**
```json
{
  "event": "gateway_outage",
  "gatewayId": "gateway.pilot.shlita.xyz",
  "timestamp": "2026-11-15T16:14:15.644Z",
  "incidentId": "inc_1794759255644",
  "details": {
    "consecutiveFailures": 3,
    "failureThreshold": 3,
    "lastError": "HTTP 503: Service Unavailable"
  }
}
```

**Recovery Notification (`gateway_recovered`):**
```json
{
  "event": "gateway_recovered",
  "gatewayId": "gateway.pilot.shlita.xyz",
  "timestamp": "2026-11-15T16:14:25.960Z",
  "incidentId": "inc_1794759255644",
  "details": {
    "downtimeSeconds": 10.3,
    "lastProbeDurationMs": 1.2
  }
}
```

### 5.4 Applying to Staging Gateway (`LIVE-ALERT-01`)
To execute the live staging alert check once the cloud host and webhook sink are provisioned:
1. Export `SHLITA_ALERT_WEBHOOK_URL="https://hooks.slack.com/services/..."`.
2. Start the monitor targeting `https://gateway.staging.shlita.xyz`.
3. Induce a controlled outage: `docker compose -f compose.staging.yaml stop gateway`.
4. Verify receipt of `gateway_outage` in the webhook channel.
5. Restore the gateway: `docker compose -f compose.staging.yaml start gateway`.
6. Verify receipt of `gateway_recovered` in the webhook channel.

### 5.5 Prometheus Metrics & Logs

```bash
# Scrape endpoint: GET https://gateway.pilot.shlita.xyz/metrics
# Key metrics:
#   shlita_operations_total — total operation count
#   shlita_operations_approved — approved reservations
#   shlita_operations_rejected — policy rejections
#   shlita_circuit_breaker_trips — circuit breaker activations

# Tail structured JSON logs from Docker:
docker logs -f shlita-gateway --since 1h | jq .
```

---

## 6. Daily Operations

### 6.1 Backup (Run Daily)
```bash
# Online hot backup using SQLite WAL backup API (does not stop server)
docker exec shlita-gateway node dist/backup-cli.js
# Output: {"event":"backup","integrity":"ok"}

# Copy backup to off-site storage
cp /var/lib/shlita/backups/latest.db /backup/shlita-$(date +%Y%m%d).db
```

### 6.2 Spend & Ledger Review
```bash
# Check aggregate spend across all pilot agents
curl -s https://gateway.pilot.shlita.xyz/v1/operations \
  -H "x-shlita-operator-key: $OPERATOR_KEY" | jq '.summary'
```

### 6.3 Freeze Agent (Emergency)
```bash
# Immediately halt all spending for a specific agent:
curl -X POST https://gateway.pilot.shlita.xyz/v1/agents/<agent-id>/freeze \
  -H "x-shlita-operator-key: $OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Emergency freeze"}'
# (Note: x-shlita-csrf is only required for browser cookie session auth, not operator key header auth)
```

---

## 7. Incident Response Quick Reference

| Severity | Trigger | Action |
|---|---|---|
| **SEV-1** | Overspend detected | Freeze all agents → backup database → investigate ledger |
| **SEV-1** | Gateway unreachable | Check VM, Docker status, disk space |
| **SEV-2** | Circuit breaker trips | Review agent behavior → reset circuit if false positive |
| **SEV-2** | Database lock timeout | Verify single-instance deployment (no duplicate writers) |
| **SEV-3** | Partner reports SDK error | Check agent enrollment, API key validity, policy allowlist |

**Full incident response playbook:** `docs/step-8/INCIDENT_RESPONSE.md`

---

## 8. Pilot Exit Criteria

The pilot is considered successful when:

- [ ] At least 2 external developers have connected agents via the SDK
- [ ] At least 100 financial operations have been processed without overspend
- [ ] Zero security incidents (unauthorized access, credential leaks)
- [ ] Uptime ≥ 99% over the pilot period
- [ ] Backup/restore cycle tested at least once
- [ ] All circuit breaker trips were genuine (no false positives)
- [ ] Partner feedback collected and documented

---

## 9. Pilot Shutdown Procedure

```bash
# 9.1 Notify all partners of shutdown window
# 9.2 Final backup
docker exec shlita-gateway node dist/backup-cli.js

# 9.3 Freeze all agents (prevent new operations)
# 9.4 Wait for in-flight operations to complete (30 seconds)
sleep 30

# 9.5 Stop gateway
docker compose down

# 9.6 Archive database and logs
tar czf shlita-pilot-archive-$(date +%Y%m%d).tar.gz /var/lib/shlita/
```

---

## 10. Rollback Procedures

### 10.1 Gateway Container Image Rollback (`scripts/rollback.sh`)

If a software defect or breaking change is deployed in a new container image, roll back the gateway to a previous known-good image while preserving the durable SQLite ledger volume.

#### Canonical Rollback Command:
```bash
# Syntax: ./scripts/rollback.sh <PREVIOUS_IMAGE_TAG_OR_DIGEST>
./scripts/rollback.sh ghcr.io/xiaoarnav/shlita:bc7f2d2f8563d1d15329038d68ce872c48f454d0
```

#### Selecting a Compatible Target Image:
- Always select an immutable commit SHA tag (e.g. `ghcr.io/xiaoarnav/shlita:<full-sha>`) or content digest (`ghcr.io/xiaoarnav/shlita@sha256:<digest>`).
- Consult GitHub Deployment records or `.github/workflows/deploy.yml` release history for verified staging/production SHAs.
- Never use mutable tags like `:latest` or `:staging` for production rollbacks.

#### Failure Safety (Pre-Pull Invariant):
- `scripts/rollback.sh` executes `docker pull <TARGET_IMAGE>` in Step 1 before stopping the running gateway.
- If the image reference cannot be pulled (due to typo, network partition, or missing registry credentials), the script aborts immediately with a non-zero exit code under `set -eu`.
- **The running gateway container is NOT stopped or modified**, preventing accidental downtime.

#### Service Scope & Worker Coexistence:
- `scripts/rollback.sh` intentionally isolates changes to the customer-facing `gateway` service using:
  `SHLITA_IMAGE="${TARGET_IMAGE}" docker compose -f "${COMPOSE_FILE}" up -d --no-deps gateway`
- The `backup-worker` and `caddy` services continue operating uninterrupted.
- If the rollback includes a database schema rollback requiring the backup worker to be synchronized, execute:
  `SHLITA_IMAGE="<TARGET_IMAGE>" docker compose -f compose.staging.yaml up -d --no-deps backup-worker`

#### Post-Rollback Readiness and Ledger Continuity Verification:
1. **Readiness Probe**: The script automatically polls `/ready` inside the rolled-back container for up to 30 seconds until HTTP 200 is confirmed.
2. **Ledger Volume Verification**: Ensure the persistent volume (`shlita-staging-data`) remained mounted:
   ```bash
   docker inspect --format='{{range .Mounts}}{{if eq .Destination "/var/lib/shlita"}}{{.Name}}{{end}}{{end}}' shlita-staging-gateway
   ```
3. **Database Integrity Check**: Run PRAGMA integrity check inside the rolled-back container:
   ```bash
   docker compose -f compose.staging.yaml exec -T gateway node -e '
     const { DatabaseSync } = await import("node:sqlite");
     const db = new DatabaseSync("/var/lib/shlita/ledger.db", { readOnly: true });
     console.log(db.prepare("PRAGMA integrity_check").get());
     db.close();
   '
   ```
4. **Operation Audit**: Verify existing financial operations remain intact via operator API:
   ```bash
   curl -s http://127.0.0.1:4000/v1/operations \
     -H "x-shlita-operator-key: $SHLITA_OPERATOR_KEY" | jq '.operations | length'
   ```

#### Troubleshooting Image Pull Failures:
If rollback exits non-zero on `[1/4] Pulling target image...`:
1. Check registry authentication: `echo $GITHUB_TOKEN | docker login ghcr.io -u <username> --password-stdin`.
2. Inspect available local images: `docker images --format 'table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}' | grep shlita`.
3. If using an already-pulled or local image, set `SHLITA_SKIP_PULL=true ./scripts/rollback.sh <LOCAL_IMAGE_TAG>`.

---

### 10.2 Database Disaster Recovery (Ledger State Restore)

If database corruption or catastrophic operator error occurs:

1. **Freeze all agents** immediately via operator API or dashboard.
2. **Create emergency copy** of the current database file for forensic audit:
   ```bash
   cp /var/lib/shlita/ledger.db /var/lib/shlita/ledger-corrupt-$(date +%Y%m%d%H%M%S).db
   ```
3. **Stop the gateway** container (`docker compose stop gateway`).
4. **Restore from verified snapshot** using restore CLI:
   ```bash
   node dist/packages/gateway/src/restore-cli.js /var/backups/shlita-external/<snapshot-file>.db /var/lib/shlita/ledger.db
   ```
5. **Restart the gateway** (`docker compose up -d gateway`) and verify `/ready` returns HTTP 200.
6. **Notify partners** of the incident and resolution.

---

## 11. Staging & Pilot Status

- **Step 18 Local Rollback and Recovery Drill**: Verified. Standalone rollback script (`scripts/rollback.sh`), automated compose drill (`scripts/verify-compose-rollback.sh`), failure-before-stopping invariant on unavailable image, gateway image downgrade, ledger volume persistence, SQLite `PRAGMA integrity_check: ok`, financial operation survival (`ACCOUNTING_COMMITTED`), and worker coexistence verified locally and in CI.
- **Step 17 Local Alert Rehearsal**: Verified. Standalone readiness monitor (`scripts/readiness-monitor.mjs`), automated drill (`scripts/alert-rehearsal.mjs`), healthy baseline, brief interruption suppression, single outage event delivery, duplicate suppression, single recovery event delivery, bounded webhook retry on failure, and clean process teardown verified locally.
- **Step 16 Local Pilot Rehearsal**: Verified. Packaged SDK, external install, all 6 developer/operator scenarios pass with persistent SQLite storage and zero secret leaks.
- **Step 12 Hosted Staging**: Tracked in PR #19 pending approval of an accessible Linux host (`gateway.staging.shlita.xyz`) and webhook secret (`SHLITA_ALERT_WEBHOOK_URL`) for live cloud execution of `LIVE-ALERT-01`.
- **Step 15 Live Gemini Smoke Test**: Verified deterministically; live smoke test is tracked separately pending external `GEMINI_API_KEY`.
