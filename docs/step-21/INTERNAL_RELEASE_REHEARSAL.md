# Shlita — Step 21: Internal Release Rehearsal and Pilot Handoff Report

**Document Reference:** `docs/step-21/INTERNAL_RELEASE_REHEARSAL.md`  
**Parent Milestone:** Step 21 — Internal Release Rehearsal and Pilot Handoff  
**Candidate Commit SHA:** `4786841689041b8a09eef8be5d7d45ae24f59043` (`main`)<br/>
**Merged `main` Commit (PR #28):** `5c3a89523668f57994042718825de91fd29a87f3`<br/>
**Maintainer Author:** Arnav Patel (`@XiaoArnav`)<br/>
**Date:** 2026-11-15<br/>
**Candidate CI Run:** [Run #43740538852](https://github.com/XiaoArnav/Shlita/actions/runs/43740538852) (`conclusion: success`)<br/>
**Merged `main` CI Run:** [Run #43742757703](https://github.com/XiaoArnav/Shlita/actions/runs/43742757703) (`conclusion: success`)<br/>
**Supported Runtime:** Node.js `>=22.0.0` (Verified on Node.js `v24.22.1`)<br/>
**Packaged SDK Archive:** `shlita-sdk-0.1.0.tgz`  
**SDK Archive SHA-256:** `4abcee6076ae815ca286205f1bf430bdbce69d708ff8f73d2c97bfc0f5ca67d6`  
**Internal Release Verdict:** **`READY`**  
**External Controlled Pilot Verdict:** **`NO-GO` (Conditional on Cloud Host Provisioning & DNS Delegation)**  

---

## 1. Executive Summary & Objective

Step 21 proves that a clean checkout of one exact Shlita release candidate (`4786841`) produces an installable, self-contained `shlita-sdk` archive, reproduces the deterministic Gemini reference agent spending policy demo, and passes all developer and operator workflows without external credentials or shared services.

This document serves as the canonical handoff report for developers and operators to reproduce every verification result from scratch, audit the ledger and SRE invariants, and understand the exact remaining infrastructure actions required before opening an external developer pilot on live staging.

---

## 2. Release Candidate & Artifact Invariants

### 2.1 Release Candidate Metadata
- **Git Commit SHA:** `4786841689041b8a09eef8be5d7d45ae24f59043`
- **Git Tree State:** Clean working tree, fast-forward synchronized with `origin/main`.
- **Node.js Environment:** `v24.22.1` (satisfies `engines: { "node": ">=22" }` in root and SDK package definitions).
- **GitHub Actions Verification:** [Run #43740538852](https://github.com/XiaoArnav/Shlita/actions/runs/43740538852) executed unit/integration tests, dashboard browser verification, Compose backup worker isolation, Compose image rollback, and Compose scheduled recovery.

### 2.2 SDK Package Archive Invariants
- **Archive Filename:** `shlita-sdk-0.1.0.tgz`
- **Package Name & Version:** `shlita-sdk@0.1.0`
- **SHA-256 Checksum:** `4abcee6076ae815ca286205f1bf430bdbce69d708ff8f73d2c97bfc0f5ca67d6`
- **Archive Size:** 9.1 kB compressed (36.4 kB uncompressed).
- **Tarball File Manifest (17 files):**
  - `package/package.json`
  - `package/README.md`
  - `package/dist/index.js` & `index.d.ts` & `index.js.map`
  - `package/dist/client.js` & `client.d.ts` & `client.js.map`
  - `package/dist/errors.js` & `errors.d.ts` & `errors.js.map`
  - `package/dist/http.js` & `http.d.ts` & `http.js.map`
  - `package/dist/types.js` & `types.d.ts` & `types.js.map`
- **Zero Leakage Audit:**
  - Zero `.env` files or hardcoded credentials.
  - Zero SQLite database files (`*.db`, `*.db-wal`, `*.db-shm`).
  - Zero raw TypeScript files (`*.ts`).
  - Zero gateway implementation or server code (gateway remains strictly private in monorepo).

---

## 3. Step-by-Step Clean Checkout & Reproduction Guide

A developer starting from a clean machine can reproduce the SDK build, consumer installation, and reference agent execution with the following sequence:

### Step 3.1: Clean Clone and Monorepo Build
```bash
git clone https://github.com/XiaoArnav/Shlita.git
cd Shlita
git checkout 4786841689041b8a09eef8be5d7d45ae24f59043

npm ci
npm run build
npm run build:sdk
```

### Step 3.2: Package the SDK Archive
```bash
mkdir -p /tmp/shlita-sdk
npm pack --pack-destination /tmp/shlita-sdk ./packages/sdk
sha256sum /tmp/shlita-sdk/shlita-sdk-0.1.0.tgz
# Expected: 4abcee6076ae815ca286205f1bf430bdbce69d708ff8f73d2c97bfc0f5ca67d6
```

### Step 3.3: Install and Verify as an External Consumer
```bash
# Create an independent test project outside the repository tree
mkdir /tmp/test-consumer && cd /tmp/test-consumer
npm init -y
npm pkg set type="module"
npm install /tmp/shlita-sdk/shlita-sdk-0.1.0.tgz

# Verify public exports resolve cleanly:
node -e '
  import { ShlitaAgentClient, ShlitaOperatorClient, ShlitaApiError, ShlitaClientError, ShlitaUncertainError } from "shlita-sdk";
  console.log("All SDK public classes and error constructors loaded successfully.");
'
```

### Step 3.4: Automated Independent Consumer Check
From the repository root:
```bash
node scripts/sdk-consumer-check.mjs
```
**Observed Output:**
```json
{"example":"basic-agent","outcome":"committed","reservedAmountMicroUsdc":"10000","fundsMoved":false}
{"example":"policy","approved":"committed","blocked":"UNAPPROVED_VENDOR","overLimit":"PER_CALL_LIMIT_EXCEEDED"}
{"example":"idempotency","replay":true,"conflict":"IDEMPOTENCY_CONFLICT","timeout":"TIMEOUT","connections":1}
{"example":"tool-adapter","tool":"shlita_proxy","outcome":"committed","reservedAmountMicroUsdc":"10000"}
{"installed":true,"compiled":true,"examples":4,"restart":"preserved","operationId":"op_07d8d777-38b1-40ef-b86e-58cffaa692a3","reservedAmountMicroUsdc":"10000"}
```

### Step 3.5: Run Gemini Reference Agent Demo
The reference agent demonstrates the complete two-turn Gemini model flow under policy governance using an isolated, self-contained development gateway:
```bash
node examples/gemini-reference-agent/run.mjs
```

**Observed Scenarios:**
1. **Allowed Scenario (`gemini-allowed-agent`):**
   - **User Prompt:** `"What is the token metadata for DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263?"`
   - **Proposed Function Call:** `get_solana_token_metadata(mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")`
   - **Application Perimeter:** Validates argument format, constructs typed payload.
   - **Shlita Policy Outcome:** `committed` (Reserved Tariff: `10000` µUSDC = $0.0100 USDC).
   - **Ledger Invariant:** State is `ACCOUNTING_COMMITTED`, `settlementStatus: NOT_SUBMITTED`, `signature: null`.
   - **Gemini Follow-up:** Model synthesizes final text with provider data under spending protection.
2. **Denied Scenario (`gemini-denied-agent`):**
   - **Identical Tool Call & Mint Argument**.
   - **Shlita Policy Outcome:** `rejected` (`reason: UNAPPROVED_VENDOR`).
   - **Perimeter Invariant:** Exactly **0 downstream provider calls dispatched**, exactly **0 µUSDC reserved**.
   - **Gemini Follow-up:** Model receives structured rejection and explains policy boundary cleanly.

---

## 4. Developer and Operator Rehearsal Evidence Matrix

| Rehearsal Workflow | Test Command / Harness | Evidence & Key Observations | Verdict |
| :--- | :--- | :--- | :---: |
| **Full Unit & Integration Suite** | `npm test` | 177 tests passed across 28 test files in 3.9s. Verifies ACID state transitions, budget ceilings, SSRF firewalling, multi-tenant isolation, idempotency deduplication, Compose image rollback pre-pull guards, and backup worker integrity. | **PASS** |
| **Dashboard Browser Verification** | `npm run test:browser` | Headless Playwright Chromium E2E test verifying operator login, CSRF tokens, telemetry streaming, agent freeze, and session logout. | **PASS** |
| **Local Pilot Developer/Operator Drill** | `node scripts/pilot-rehearsal.mjs` | Verified all 6 scenarios: (s1) first allowed call committed with 10000 µUSDC; (s2) unapproved vendor rejected; (s3) idempotent replay returns matching ID; (s4) ledger records `ACCOUNTING_COMMITTED` with `NOT_SUBMITTED`; (s5) operator freeze blocks subsequent calls (`AGENT_FROZEN`); (s6) operation and freeze status persist across restart. | **PASS** |
| **Readiness Alert & Webhook Delivery** | `node scripts/alert-rehearsal.mjs` | Verified SRE probe lifecycle: healthy baseline, brief interruption suppression (flap damping), single outage webhook (`gateway_outage`, `inc_1794764035034`), duplicate suppression, single recovery webhook (`gateway_recovered`), and bounded retries on webhook failure. | **PASS** |
| **Compose Image Rollback Drill** | `scripts/verify-compose-rollback.sh`<br>(CI Run #43740538852) | Verified automated rollback in `scripts/rollback.sh`: pre-pull availability guard fails closed on missing image without stopping gateway; target rollback succeeds; persistent SQLite volume survives with 25000 µUSDC operation intact; backup worker coexists without restart. | **PASS** |
| **Compose Scheduled Backup & Recovery** | `scripts/verify-compose-recovery.sh`<br>(CI Run #43740538852) | Verified real worker loop interval injection (3s) snapshot production, file mode 0600, SHA-256 recording, independent `restore-cli.js` into fresh volume, `PRAGMA integrity_check: ok`, fresh recovered gateway HTTP 200 from `/ready`, matching ledger fields (35000 µUSDC, `ACCOUNTING_COMMITTED`), and source preservation. | **PASS** |

---

## 5. Internal Release vs External Pilot Verdicts

### 5.1 Internal Release Verdict: **`READY`**
- The repository codebase, SDK packaging, local execution scripts, and automated test suite are **100% complete and self-contained**.
- Internal developers can build the SDK archive, install it into external projects, run agent workflows against local or development gateways, and inspect ledger operations without external dependencies or cloud credentials.

### 5.2 External Controlled Developer Pilot Verdict: **`NO-GO`**
As documented in [`PILOT_GO_NO_GO.md`](../step-10/PILOT_GO_NO_GO.md) and [`STAGING_VERIFICATION.md`](../step-12/STAGING_VERIFICATION.md), onboarding external developer partners onto public staging (`https://gateway.staging.shlita.xyz`) is **NO-GO** pending maintainer infrastructure provisioning:

| Open External Prerequisite | Blocker ID | Impact on External Pilot | Maintainer Owner & Required Action |
| :--- | :---: | :--- | :--- |
| **Dedicated Linux Staging VM** | `BLOCKER-HOST-01` | No remote server running `compose.staging.yaml` | **Arnav Patel (`XiaoArnav`)**: Authorize and provision a cloud VM (e.g. Hetzner CX22 @ ~€3.79/mo or AWS EC2 `t4g.small` @ ~$15/mo). |
| **Public DNS & Caddy TLS** | `BLOCKER-DNS-01` | `gateway.staging.shlita.xyz` returns `NXDOMAIN` | **Arnav Patel (`XiaoArnav`)**: Add DNS A record pointing `gateway.staging.shlita.xyz` to VM public IPv4. Open ports 80/443. |
| **Staging Environment Secrets** | `BLOCKER-SECRET-01` | Staging operator key and webhook sink unconfigured | **Arnav Patel (`XiaoArnav`)**: Generate 32-hex `SHLITA_OPERATOR_KEY` and set `SHLITA_ALERT_WEBHOOK_URL` in host environment. |
| **Live Gemini Smoke Test** | `DEFERRED-01` | Live model two-turn interaction unverified | **Arnav Patel (`XiaoArnav`)**: *(Optional)* Supply `GEMINI_API_KEY` for live model smoke test. Non-Gemini partners can proceed without this. |

---

## 6. Maintenance & Operator Runbook Links

- **Quickstart Guide:** [`docs/sdk/quickstart.md`](../sdk/quickstart.md) — Developer onboarding, SDK usage, agent enrollment, emergency freeze.
- **Pilot Runbook:** [`docs/step-9/PILOT_RUNBOOK.md`](../step-9/PILOT_RUNBOOK.md) — Staging host deployment, rollback procedures, backup snapshot selection, offline restore.
- **Staging Verification Report:** [`docs/step-12/STAGING_VERIFICATION.md`](../step-12/STAGING_VERIFICATION.md) — Detailed 4-check audit and blocker logs.
- **Production Readiness Decision:** [`docs/step-10/PILOT_GO_NO_GO.md`](../step-10/PILOT_GO_NO_GO.md) — Four-tier launch decision matrix.
