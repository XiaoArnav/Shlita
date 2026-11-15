# Shlita — Step 12, Step 20 & Step 23: Live Staging Acceptance Verification Report & Pilot Readiness

**Document Reference:** `docs/step-12/STAGING_VERIFICATION.md`<br/>
**Parent Milestone:** Step 12 (Persistent HTTPS Staging Deployment), Step 20 (Hosted Staging Acceptance), & Step 23 (Live Staging Acceptance and Pilot Go/No-Go)<br/>
**Upstream Target:** `XiaoArnav/Shlita:main`<br/>
**Base Commit (PR #26 Merged):** `8ed5d4b4a1b0d74268e217c46b5dc43372f5cb3c`<br/>
**Step 20 Merged Commit:** `f6cec275248289623f6f8b8cf3371765307ff2ab`<br/>
**Current Merged `main` Commit (PR #29 Merged):** `2e97bba81084b6ce65803e2d5fcc7662220d5cac`<br/>
**Baseline CI Run:** [Run #43744429092](https://github.com/XiaoArnav/Shlita/actions/runs/43744429092)<br/>
**Maintainer Author:** `Arnav Patel (@XiaoArnav)`<br/>
**Date:** 2026-11-15<br/>
**Target Staging URL:** `https://gateway.staging.shlita.xyz`<br/>
**Target Staging Endpoint:** `https://gateway.staging.shlita.xyz/ready`<br/>
**Target Container Image:** `ghcr.io/xiaoarnav/shlita:2e97bba81084b6ce65803e2d5fcc7662220d5cac` (`ghcr.io/xiaoarnav/shlita:staging`)<br/>
**Published Image Digest (GHCR):** `ghcr.io/xiaoarnav/shlita@sha256:ab7c7f83e80a5aeac79c33fe602d805adc43f139cd64dfbeea94bdfa4f15c175`<br/>
**Host-Observed Image Digest:** None (`BLOCKED` — Cloud VM host unprovisioned; pending live deployment)<br/>
**GitHub Deployment Record:** `#7806731531` (Environment: `staging` — records GHCR publication, not live host execution)

---

## 1. Executive Summary & Verification Verdict

Steps 12, 20, and 23 establish the complete container infrastructure, locked staging validation, automated backup/restore flow, SRE monitoring probes, rollback procedures, local developer and operator rehearsals, scheduled backup recovery, and pilot readiness criteria for Shlita's single-instance persistent HTTPS staging deployment.

### Overall Status: SPEC, LOCAL & CI VERIFICATION PASS — LIVE HOSTED ACCEPTANCE BLOCKED
- **Engineering & Specification:** **PASS** (100% complete)
- **Local & Container Invariant Tests:** **PASS** (186/186 unit/integration tests pass across 30 test files)
- **Chromium Dashboard E2E Browser Test:** **PASS** (Playwright headless Chromium verified)
- **SDK Consumer Archive Test:** **PASS** (Independent installation outside repository verified)
- **Gemini Reference Agent Integration:** **PASS** (Steps 13 & 14 verified tool call validation, proxying, and policy denial)
- **Local Pilot Rehearsal:** **PASS** (Step 16 verified clean developer onboarding, scoped keys, and freeze survival)
- **Readiness Alert Rehearsal:** **PASS** (Step 17 verified flap-damped outage and recovery webhook delivery)
- **Image Rollback Procedure:** **PASS** (Step 18 verified pre-pull availability guard, volume continuity, and worker coexistence)
- **Scheduled Backup & Recovery Drill:** **PASS** (Step 19 verified worker loop snapshot production, `restore-cli.js`, integrity check, and recovered gateway readiness)
- **Caddy Reverse Proxy & Operator Access Isolation:** **PASS** (Verified CIDR trusted-proxy support, client IP distinction behind proxy, and HTTPS secure cookies)
- **Live Acceptance Check Automation:** **PASS** (Verified asynchronous execution in `tests/step-12/live.acceptance.test.ts`, `tests/step-20/hosted.staging.acceptance.test.ts`, and `scripts/verify-live-staging.sh`)
- **Live Cloud VM & Public DNS/TLS (4 Acceptance Checks):** **BLOCKED** (Requires maintainer cloud hosting credentials, public DNS delegation, and staging secrets)
- **Controlled Developer Pilot Launch Recommendation:** **NO-GO for immediate live external partner traffic / CONDITIONAL GO pending cloud host provisioning & DNS delegation**

### 1.1 Evidence Reconciliation: What Each Record Actually Proves

A rigorous analysis of repository records separates CI artifact publication from live infrastructure execution:

1. **GitHub Actions CI Run #43738296658 (Commit `f6cec27`):**
   - **What it proves:**
     - Vitest test suite passes completely (168/168 tests across 27 files on base `main`).
     - Dashboard Playwright Chromium headless E2E flow passes (login, enrollment, live telemetry, freeze persistence, logout).
     - SDK external consumer test passes from an isolated project outside the repository.
     - Production security fails closed inside the built container when secrets are omitted.
     - Compose backup worker isolation drill passes (unique project namespace, non-root user, volume survival across failure/success, SQLite restore).
     - Compose image rollback drill passes (pre-pull availability guard, zero disruption to healthy gateway on missing image, persistent volume continuity, worker coexistence).
     - Compose scheduled backup and gateway recovery drill passes (real worker loop snapshot production with 3s interval injection, independent CLI restore, `PRAGMA integrity_check: ok`, fresh recovered gateway HTTP 200, matching operation fields).
     - Multi-architecture container image was built and successfully pushed to GHCR (`ghcr.io/xiaoarnav/shlita:staging` and `ghcr.io/xiaoarnav/shlita:f6cec275248289623f6f8b8cf3371765307ff2ab`).
   - **What it does NOT prove:**
     - Does NOT prove that a live staging server is running or reachable over the internet.

2. **GitHub Deployment Record #7806731531 (Environment: `staging`):**
   - **What it proves:**
     - The GitHub environment `staging` received an automated deployment event triggered by the GHCR publication step in `.github/workflows/deploy.yml`.
   - **What it does NOT prove:**
     - Does NOT prove that a cloud VM host exists or that containers are running. As documented in `.github/workflows/deploy.yml`: *"Staging gateway runs via Docker Compose on a persistent cloud host. Image publication to GHCR is automated here; live HTTPS deployment requires host provisioning."*

3. **Published Image Digest (`sha256:ab6ff49dd7b991142af86923e7a30ae50c74a2e44efaa721583bc143b686d6f1`):**
   - **What it proves:**
     - The container manifest is stored immutably in GHCR and ready to pull.
   - **What it does NOT prove:**
     - It is NOT a host-observed digest. A host-observed digest can only be captured once `docker inspect` is executed on an active Linux staging host.

4. **External Public HTTPS & DNS Probe (`curl -Iv https://gateway.staging.shlita.xyz/ready`):**
   - **What it proves:**
     - Domain `gateway.staging.shlita.xyz` returns `NXDOMAIN` (no DNS record).
     - Proves objectively that no live staging gateway is currently operational.

---

## 2. Requirement Verification Matrix

| Requirement | Specification & Artifact | Status | Evidence |
| :--- | :--- | :---: | :--- |
| **1. Single-Instance Gateway Container** | `compose.staging.yaml` service `gateway`, single container mounting `/var/lib/shlita` | ✅ PASS | Verified single-writer SQLite WAL constraint in Docker compose spec |
| **2. Persistent Host Storage** | Named Docker volume `shlita-staging-data` mounted at `/var/lib/shlita` | ✅ PASS | Preserved across restarts; non-root user `shlita` UID 10001 |
| **3. Edge TLS & Reverse Proxy** | Caddy 2 reverse proxy (`Caddyfile`, `compose.staging.yaml`), auto-TLS for `gateway.staging.shlita.xyz` | ⚠️ SPEC READY / HOST BLOCKED | Specification complete; requires live public DNS delegation |
| **4. Locked Staging Security** | `packages/gateway/src/security-config.ts` fails closed on `SHLITA_ALLOW_SIMULATION=true` or missing secrets | ✅ PASS | `tests/step-12/staging.deployment.test.ts` (test 1) |
| **5. Safe Fork PR CI** | `.github/workflows/deploy.yml` runs build/image jobs on untrusted PRs with local fixtures | ✅ PASS | Tested locally; zero production secrets exposed to fork PRs |
| **6. Image Rollback Procedure** | `scripts/rollback.sh` automated image pinning script without volume data loss | ✅ PASS | Verified via `scripts/verify-compose-rollback.sh` & `tests/step-18/compose.rollback.test.ts` (pre-pull safety, ledger continuity, worker coexistence) |
| **7. Health & Readiness Monitoring** | Public uncredentialed `GET /health`, `GET /ready`, `GET /metrics` | ✅ PASS | Verified in `tests/step-12/staging.deployment.test.ts` |
| **8. Smoke Test & Latency Probe** | `scripts/staging-smoke-test.mjs` measuring latency and HTTP statuses | ✅ PASS | Probes `/health` and `/ready` with automated summary output |
| **9. Automated Backup Worker** | `compose.staging.yaml` sidecar running `node dist/packages/gateway/src/backup-cli.js` with direct volume mount | ✅ PASS | Verified writable external backup mount, `VACUUM INTO`, retention pruning |
| **10. Backup Restoration Drill** | `packages/core/src/backup.ts` `restoreLedgerBackup()` into independent database | ✅ PASS | Verified CLI and API restore in `tests/step-12/staging.deployment.test.ts` & `tests/step-19/scheduled.backup.recovery.test.ts` |
| **11. Circuit Breaker Alert Drill** | Gateway returns 502 on upstream error, trips breaker on threshold, returns 403 `CIRCUIT_BREAKER_TRIPPED` | ✅ PASS | Verified in `tests/step-12/staging.deployment.test.ts` (test 4) |
| **12. Unit & Integration Suite** | 177 tests across 28 test files | ✅ PASS | `npm test` exit code 0 |
| **13. Browser Dashboard E2E** | Playwright Chromium headless test | ✅ PASS | `npm run test:browser` exit code 0 |
| **14. SDK External Consumer** | External package unpack and run test | ✅ PASS | `node scripts/sdk-consumer-check.mjs` exit code 0 |
| **15. Compose Backup Isolation** | `scripts/verify-compose-backup-worker.sh` unique namespace & fail-closed preflight | ✅ PASS | Verified in CI; volume survival across success/failure |
| **16. Live Acceptance Automation** | `scripts/verify-live-staging.sh` & `tests/step-12/live.acceptance.test.ts` | ✅ PASS | Non-blocking asynchronous probe runner |
| **17. Gemini Reference Agent Flow** | `examples/gemini-reference-agent/` deterministic tool call validation and policy rejection | ✅ PASS | Verified in `tests/step-13/gemini.agent.test.ts` & `tests/step-14/gemini.onboarding.test.ts` |
| **18. Local Pilot Rehearsal** | `scripts/pilot-rehearsal.mjs` SDK consumer project, scoped key, policy rejection, freeze survival | ✅ PASS | Verified in `tests/step-16/local-pilot-rehearsal.test.ts` |
| **19. Outage & Recovery Alert Rehearsal** | `scripts/alert-rehearsal.mjs` & `scripts/readiness-monitor.mjs` | ✅ PASS | Verified in `tests/step-17/readiness-alert.test.ts` |
| **20. Scheduled Backup & Gateway Recovery** | `scripts/verify-compose-recovery.sh` worker scheduler loop, `restore-cli.js`, integrity check, readiness | ✅ PASS | Verified in `tests/step-19/scheduled.backup.recovery.test.ts` & CI Run #43737983114 |

---

## 3. Detailed Verification Results

### A. Locked Staging Security Rules
`packages/gateway/src/security-config.ts` treats both `production` and `staging` as locked modes:
1. Rejects missing `SHLITA_OPERATOR_KEY` or `SHLITA_OPERATOR_ORG`.
2. Rejects `SHLITA_ALLOW_SIMULATION=true` (staging requires real sandbox provider keys or mocked upstream).
3. Rejects `SHLITA_SEED_DEMO=true` (no hardcoded test agents).
4. Rejects in-memory database (`SHLITA_DB_PATH=:memory:`).
5. Rejects non-HTTPS `SHLITA_PUBLIC_ORIGIN`.

### B. SQLite Backup Snapshot & Independent Restore
Implemented WAL-safe backup implementation in `packages/core/src/db.ts`, automated worker in `compose.staging.yaml`, and end-to-end Compose verification script in `scripts/verify-compose-backup-worker.sh` and `scripts/verify-compose-recovery.sh`:
1. Performs consistent online snapshot of active WAL-mode database using SQLite native `VACUUM INTO` to a temporary snapshot file.
2. Runs `PRAGMA integrity_check` on the temporary file before atomically renaming to destination (`fs.renameSync`).
3. Restricts backup file permissions to `0600` (`chmodSync`).
4. Preserves last known-good snapshot intact if a subsequent backup fails or destination is unwritable.
5. Replicates snapshots to off-volume destination (`/var/backups/shlita-external`) owned by container user `shlita` (UID 10001).
6. Unwritable destination causes `backup-cli.ts` to surface non-zero exit code.
7. Successfully restored backup into independent databases using `restoreLedgerBackup()` and `restore-cli.js`.
8. Verified `PRAGMA integrity_check` returned `ok`.
9. Verified all agents, operations, and audit logs were present and identical in the restored database.

### C. Single-Instance Persistence Across Restart
1. Initialized gateway on durable SQLite file.
2. Registered agent and committed an outbound operation.
3. Completely shut down process/engine (`engineA.close()`).
4. Re-opened exact same database file with new gateway process (`engineB`).
5. Verified `/ready` returned HTTP 200 without authentication.
6. Verified registered agent and committed financial operations persisted without data loss.

### D. Reverse Proxy Ingress & Rate Limit Isolation Behind Caddy
1. Verified CIDR trusted-proxy support (`172.16.0.0/12`, `10.0.0.0/8`, `127.0.0.1`, `::1`) in `packages/gateway/src/client-address.ts`.
2. Validated Caddy reverse proxy header pipeline: `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Proto: https`, `Host: gateway.staging.shlita.xyz`.
3. Proved that client IP addresses are isolated: an attacker at `198.51.100.10` making 8 failed operator sign-in attempts is rate limited (HTTP 429), while a legitimate operator at `198.51.100.20` connecting through the exact same Caddy proxy (`172.20.0.2`) signs in with HTTP 200 and is unaffected by the lockout.
4. Enforced HTTPS secure session cookies (`Secure; HttpOnly; SameSite=Lax`).
5. Confirmed that direct untrusted clients attempting to forge forwarded headers are identified by their direct peer IP.

---

## 4. Live Staging Deployment: Blocker Inventory & Action Plan

Live public HTTPS staging requires infrastructure inputs outside repository code:

| Blocker ID | Description | Impact | Required Maintainer Action |
| :--- | :--- | :--- | :--- |
| **BLOCKER-HOST-01** | Cloud VM Provisioning | No remote server to run `compose.staging.yaml` | Maintainer provisions Linux host (e.g. AWS EC2, Fly.io, Railway, or Hetzner VPS) |
| **BLOCKER-DNS-01** | Public DNS Delegation | `gateway.staging.shlita.xyz` does not resolve | Add DNS A/AAAA record pointing `gateway.staging.shlita.xyz` to VM public IP |
| **BLOCKER-SECRET-01** | Stable Staging Operator Key & Webhook Sink | Staging secret store unpopulated | Add GitHub Actions secret `SHLITA_STAGING_OPERATOR_KEY` (>= 32 random hex characters) and `SHLITA_ALERT_WEBHOOK_URL` |

### 4.1 Live Staging Acceptance Criteria & Status (Step 20 Execution):

| Live Check ID | Verification Requirement | Status | Required Input / Blocker | Owner |
| :--- | :--- | :---: | :--- | :--- |
| **LIVE-HTTPS-01** | Verify public TLS and `/ready` returning HTTP 200 from outside the host | ⚠️ **BLOCKED** | `BLOCKER-HOST-01` (Cloud VM) & `BLOCKER-DNS-01` (DNS A/AAAA record) | Maintainer (`XiaoArnav`) |
| **LIVE-PERSIST-01** | Create sandbox ledger record, redeploy, and verify same operation ID and amount survive | ⚠️ **BLOCKED** | `BLOCKER-HOST-01` (Cloud VM with persistent SQLite mount) | Maintainer (`XiaoArnav`) |
| **LIVE-ALERT-01** | Run controlled staging outage and confirm outage alert and recovery notification reach configured destination | ⚠️ **BLOCKED** | `BLOCKER-SECRET-01` (`SHLITA_ALERT_WEBHOOK_URL` / alert sink) & `BLOCKER-HOST-01` | Maintainer (`XiaoArnav`) |
| **LIVE-RESTORE-01** | Restore snapshot produced by scheduled worker on staging host into separate database; verify integrity and operation ID/amount | ⚠️ **BLOCKED** | `BLOCKER-HOST-01` (Host scheduled backup worker execution) | Maintainer (`XiaoArnav`) |

### 4.2 Detailed Probe Output & Evidence:

```text
============================================================
 Shlita Step 12, Step 20 & Step 23: Live Staging Acceptance Checks
 Target: https://gateway.staging.shlita.xyz (Host: gateway.staging.shlita.xyz)
 Timestamp: 2026-11-15T18:16:49Z
 Deployed Commit: 2e97bba81084b6ce65803e2d5fcc7662220d5cac
 Published Image Digest: sha256:ab7c7f83e80a5aeac79c33fe602d805adc43f139cd64dfbeea94bdfa4f15c175
============================================================

[LIVE-HTTPS-01] Checking public HTTPS reachability and TLS certificate...
  Probe Command:
    curl --silent --show-error --fail \
      --connect-timeout 5 --max-time 15 \
      --write-out '\nHTTP %{http_code}\n' \
      https://gateway.staging.shlita.xyz/ready
  Result: BLOCKED (DNS NXDOMAIN for gateway.staging.shlita.xyz; curl exit code 6, HTTP 000)
  Blocker: BLOCKER-DNS-01 (Public DNS delegation missing) & BLOCKER-HOST-01 (Cloud host unprovisioned)
  Required Owner: Maintainer (XiaoArnav)

[LIVE-PERSIST-01] Checking ledger persistence across container redeploy...
  Result: BLOCKED (Requires live host and operational HTTPS gateway)
  Blocker: BLOCKER-HOST-01 (Cloud host unprovisioned)
  Local Rehearsal Proof: Verified in Step 16 (scripts/pilot-rehearsal.mjs) & Step 18 (scripts/verify-compose-rollback.sh)
  Required Owner: Maintainer (XiaoArnav)

[LIVE-ALERT-01] Checking outage alert & recovery notifications...
  Result: BLOCKED (SHLITA_ALERT_WEBHOOK_URL is not set)
  Blocker: BLOCKER-SECRET-01 (Staging alert destination webhook not configured) & BLOCKER-HOST-01
  Local Rehearsal Proof: Verified in Step 17 (scripts/alert-rehearsal.mjs and tests/step-17/readiness-alert.test.ts)
  Required Owner: Maintainer (XiaoArnav)

[LIVE-RESTORE-01] Checking scheduled backup worker snapshot restore on host...
  Result: BLOCKED (Requires live host with scheduled backup worker service)
  Blocker: BLOCKER-HOST-01 (Cloud host unprovisioned)
  Local & CI Rehearsal Proof: Verified in Step 19 (scripts/verify-compose-recovery.sh, tests/step-19/scheduled.backup.recovery.test.ts, CI Run #43737983114)
  Required Owner: Maintainer (XiaoArnav)

============================================================
 Live Staging Acceptance Status Summary
============================================================
LIVE-HTTPS-01 (Public TLS & /ready HTTP 200)       : BLOCKED
LIVE-PERSIST-01 (Ledger Persistence Post-Redeploy) : BLOCKED
LIVE-ALERT-01 (Outage & Recovery Notifications)    : BLOCKED
LIVE-RESTORE-01 (Worker Snapshot Restore on Host)  : BLOCKED
============================================================
VERDICT: Step 12 / Step 20 / Step 23 Live Acceptance is BLOCKED pending maintainer infrastructure provisioning.
```

---

## 5. Rollback Runbook & Step 18 Verification Evidence

If a newly deployed image exhibits anomalies or fails health checks on the staging host:
```bash
# Roll back to the previous known-good image digest/tag:
./scripts/rollback.sh ghcr.io/xiaoarnav/shlita:2e97bba81084b6ce65803e2d5fcc7662220d5cac
```
The rollback script executes the following safety invariants verified in Step 18:
1. **Pre-Pull Availability Guard**: Verifies `docker pull <TARGET_IMAGE>` succeeds before modifying or stopping the running gateway. If an unavailable image is provided, the script fails closed immediately without stopping the healthy gateway.
2. **Service Mutation Scope**: Strictly isolates service restart to `gateway` via `docker compose up -d --no-deps gateway`, preserving the `backup-worker` and edge proxy without disruption.
3. **Durable Ledger Continuity**: Preserves the named SQLite volume `shlita-staging-data` across container replacement. Existing financial operations, agent configurations, and `PRAGMA integrity_check` pass intact.
4. **Automated Bounded Verification**: Polls `/ready` until HTTP 200 is confirmed (up to 30s) before reporting success.
5. **Automated Drill**: The full workflow is verified automatically via `scripts/verify-compose-rollback.sh` and `tests/step-18/compose.rollback.test.ts`.

---

## 6. Controlled Developer Pilot Readiness & Go/No-Go Decision (Step 23 Review)

Based on the criteria defined in [`PILOT_GO_NO_GO.md`](../step-10/PILOT_GO_NO_GO.md) (Tier B — Controlled External Developer Pilot), the evaluation of readiness for external partners is detailed below:

### 6.1 Audit of Tier B Criteria

| Tier B Pilot Criterion | Requirement | Observed Status | Evidence & Reference | Owner & Next Action |
| :--- | :--- | :---: | :--- | :--- |
| **1. Dedicated Staging VM** | Single cloud VM running [`compose.staging.yaml`](../../compose.staging.yaml) with persistent volume | ❌ **UNMET** | No remote server provisioned. Active blocker: `BLOCKER-HOST-01`. | **Maintainer (`XiaoArnav`)**: Authorize and provision a cloud Linux host (e.g. Hetzner CX22, AWS EC2 `t4g.small`, or Fly.io) with Docker & Docker Compose and public IPv4. |
| **2. Public TLS Domain** | Public DNS A/AAAA record pointing `gateway.staging.shlita.xyz` to host with Caddy auto-TLS | ❌ **UNMET** | DNS lookup returns `NXDOMAIN`. Active blocker: `BLOCKER-DNS-01`. | **Maintainer (`XiaoArnav`)**: Add DNS A record pointing `gateway.staging.shlita.xyz` to VM public IP. Open ports 80/443 for Caddy ACME challenge. Refer to [`Caddyfile`](../../Caddyfile). |
| **3. Single-Instance Constraint** | Single writer on SQLite WAL database file (`replicas: 1`) | ✅ **READY** | Hardened in [`compose.staging.yaml`](../../compose.staging.yaml); verified across restarts and image rollbacks in Step 18. | Fully satisfied in configuration. |
| **4. Off-Host Telemetry & Alerts** | Readiness monitoring with delivery of outage and recovery notifications | ⚠️ **PARTIAL** | Monitor script `scripts/readiness-monitor.mjs` and flap damping verified in Step 17 rehearsal; destination webhook unconfigured. Active blocker: `BLOCKER-SECRET-01`. | **Maintainer (`XiaoArnav`)**: Provide webhook destination URL (`SHLITA_ALERT_WEBHOOK_URL`) and generate 32-hex `SHLITA_OPERATOR_KEY`. |
| **5. Sandboxed Partner Credentials & SDK** | Packaged SDK archive (`shlita-sdk-0.1.0.tgz`), quickstart documentation, and scoped agent keys | ✅ **READY** | Step 16 local pilot rehearsal verified clean-checkout developer onboarding in [`PILOT_RUNBOOK.md`](../step-9/PILOT_RUNBOOK.md), installation outside repo, policy rejection, and operator freeze survival. | Fully satisfied in repository. |
| **6. Live Gemini Smoke Test** | Verified two-turn Gemini model execution through gateway proxy | ⏸️ **DEFERRED** | Deterministic Gemini fixture verified in Step 13/14; live API smoke test deferred until live key is supplied. | **Maintainer (`XiaoArnav`)**: *(Optional)* Supply `GEMINI_API_KEY` for live smoke test. Non-Gemini partners can proceed without this. |

### 6.2 Formal Pilot Decision Verdict

### **DECISION: NO-GO FOR IMMEDIATE LIVE TRAFFIC**<br/>
### **(CONDITIONAL GO PENDING HOST PROVISIONING & DNS DELEGATION)**

#### Supporting Rationale:
1. **Engineering Foundation is 100% Complete**: All software packages, gateway logic, rate limiting, security rules, SDK packaging, and CLI tooling are fully built and passing 186 automated tests across 30 files.
2. **Operations & Recovery Drills Proven in CI**: Rollback (`scripts/verify-compose-rollback.sh`), scheduled backup recovery (`scripts/verify-compose-recovery.sh`), alert notifications (`scripts/alert-rehearsal.mjs`), clean-checkout developer onboarding (`scripts/pilot-rehearsal.mjs`), and release handoffs ([`INTERNAL_RELEASE_HANDOFF.md`](../step-22/INTERNAL_RELEASE_HANDOFF.md)) have all succeeded with reproducible evidence.
3. **Live External Pilot Requires Live Infrastructure**: Distributing partner credentials for a public gateway (`https://gateway.staging.shlita.xyz`) cannot proceed until `gateway.staging.shlita.xyz` resolves to an active, TLS-secured host. Attempting partner onboarding prior to resolving `BLOCKER-HOST-01` and `BLOCKER-DNS-01` would result in connection errors.
4. **Internal Testing (Tier A)** remains **GO**: Developers can continue testing locally and executing end-to-end flows with mock providers and deterministic fixtures.
