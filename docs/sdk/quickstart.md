# Shlita Developer Quickstart & Pilot Integration Guide

Shlita is a spending policy gateway for autonomous AI agents. An agent presents its scoped API key. The gateway evaluates policies, reserves the server tariff in an SQLite WAL ledger, and either dispatches the call to an approved provider or halts at the perimeter with a rejection.

Shlita does not require a public API. It does not hold downstream provider secrets inside the client SDK. It does not move USDC on Solana simply because a proxy call returned HTTP 200. Every committed proxy row has `fundsMoved: false` and `settlement.status: "NOT_SUBMITTED"` until an operator executes on-chain settlement. Estimated holds are not vendor invoices.

---

## 1. Gateway Setup (Local Development)

Node.js 22 or newer is required.

### Clean Checkout & Build
```bash
npm ci
npm run build
```

### Start the Gateway
```bash
# Set credentials and enable local development simulation
export SHLITA_ENV=development
export SHLITA_OPERATOR_KEY="111111111111111111111111111111111111111111111111" # 32+ hex characters
export SHLITA_OPERATOR_ORG="org-local-pilot"
export SHLITA_ALLOW_SIMULATION=true
export PORT=4000 # Optional; defaults to 4000

npm start
```

Gateway health check:
```bash
curl -s http://127.0.0.1:4000/ready
# Expected: {"status":"ok"}
```

> **Note on Staging & Production**: Production rejects simulation (`SHLITA_ALLOW_SIMULATION=true`), demo enrollment (`SHLITA_SEED_DEMO=true`), and in-memory databases (`:memory:`). Hosted staging is tracked separately under Step 12.

---

## 2. Pack and Install the SDK

`shlita-sdk` is distributed as a self-contained tarball generated from the repository.

### Pack the SDK Archive (from Shlita repository root)
```bash
# 1. Build the SDK TypeScript bundle
npm run build:sdk

# 2. Ensure destination directory exists and pack
mkdir -p /tmp/shlita-sdk
npm pack --pack-destination /tmp/shlita-sdk ./packages/sdk
# Outputs: /tmp/shlita-sdk/shlita-sdk-0.1.0.tgz
```

The packaged archive contains `dist/*.js`, `dist/*.d.ts`, `README.md`, and `package.json`. It contains zero raw `.ts` source files, zero gateway files, and zero private credentials.

### Install in an External Project
```bash
mkdir my-agent && cd my-agent
npm init -y
npm pkg set type="module"
npm install /tmp/shlita-sdk/shlita-sdk-0.1.0.tgz
```

Verify that the package imports cleanly via public exports:
```typescript
import { ShlitaAgentClient, ShlitaOperatorClient } from 'shlita-sdk';
```

---

## 3. Operator Flow: Enroll an Agent

Run this on a trusted operator/backend environment to issue disposable credentials:

```typescript
import { ShlitaOperatorClient } from 'shlita-sdk';

const operator = new ShlitaOperatorClient({
  operatorKey: process.env.SHLITA_OPERATOR_KEY!,
  baseUrl: process.env.SHLITA_GATEWAY_URL || 'http://127.0.0.1:4000',
});

const issued = await operator.enrollAgent({
  agentId: 'pilot-agent-alpha',
  allowedVendors: ['api.helius.xyz'],
  maxPerCallMicroUsdc: '50000',      // $0.05 USDC per call
  periodBudgetMicroUsdc: '1000000',  // $1.00 USDC period limit
});

console.log('Enrolled Agent:', issued.agentId);
console.log('Agent API Key :', issued.apiKey); // Store securely; shown only once
```

---

## 4. Developer Flow: Making Calls

The agent application uses `ShlitaAgentClient` with the scoped agent API key.

### Scenario A: Permitted Request (Approved & Committed)
```typescript
import { ShlitaAgentClient } from 'shlita-sdk';

const agent = new ShlitaAgentClient({
  apiKey: process.env.SHLITA_API_KEY!,
  baseUrl: process.env.SHLITA_GATEWAY_URL || 'http://127.0.0.1:4000',
});

const result = await agent.proxy({
  agentId: 'pilot-agent-alpha',
  vendor: 'api.helius.xyz',
  path: '/v0/token-metadata',
  method: 'POST',
  body: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  idempotencyKey: 'rehearsal-key-001', // At least 8 characters
  simulate: true, // Requires SHLITA_ALLOW_SIMULATION=true on local gateway
});

if (result.outcome === 'committed') {
  console.log('Operation ID:', result.operationId);
  console.log('Reserved µUSDC:', result.cost.reservedAmountMicroUsdc); // "10000" ($0.0100 USDC)
  console.log('Settlement Status:', result.settlement.status);          // "NOT_SUBMITTED"
  console.log('Funds Moved:', result.fundsMoved);                      // false
  console.log('Provider Data:', result.upstream);
}
```

### Scenario B: Policy Rejection (Perimeter Block)
If the agent calls an unapproved vendor or exceeds its per-call or budget limits:
```typescript
const denied = await agent.proxy({
  agentId: 'pilot-agent-alpha',
  vendor: 'api.tavily.com', // NOT in allowedVendors
  path: '/search',
  method: 'POST',
  body: { query: 'solana ecosystem' },
  idempotencyKey: 'rehearsal-key-denied',
  simulate: true,
});

if (denied.outcome === 'rejected') {
  console.log('Decision:', denied.decision); // "BLOCKED"
  console.log('Reason  :', denied.reason);   // "UNAPPROVED_VENDOR"
  // Zero downstream requests were dispatched; zero micro-USDC reserved.
}
```

### Scenario C: Idempotent Replay
Replaying the same `idempotencyKey` and payload returns the original stored result:
```typescript
const replay = await agent.proxy({
  agentId: 'pilot-agent-alpha',
  vendor: 'api.helius.xyz',
  path: '/v0/token-metadata',
  method: 'POST',
  body: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  idempotencyKey: 'rehearsal-key-001', // Same key as Scenario A
  simulate: true,
});

console.log('Replay Flag:', replay.outcome === 'committed' && replay.replay); // true
console.log('Operation ID:', replay.operationId); // Identical to original op ID
```

---

## 5. Operator Inspection & Emergency Controls

### Inspecting Operations in the Ledger
```typescript
const { operations } = await operator.listOperations();
const record = operations.find((op) => op.operationId === result.operationId);

console.log('Ledger State    :', record.state);                   // "ACCOUNTING_COMMITTED"
console.log('Reserved Tariff :', record.reservedAmountMicroUsdc); // "10000"
console.log('Settlement      :', record.settlementStatus);        // "NOT_SUBMITTED"
console.log('Signature       :', record.signature);               // null (unsettled hold)
```

### Emergency Freeze
Halt all spending for an agent immediately:
```typescript
await operator.freezeAgent('pilot-agent-alpha', 'Operator emergency audit');

// Subsequent calls by this agent are blocked immediately:
const postFreeze = await agent.proxy({
  agentId: 'pilot-agent-alpha',
  vendor: 'api.helius.xyz',
  path: '/v0/token-metadata',
  idempotencyKey: 'rehearsal-key-post-freeze',
  simulate: true,
});

console.log(postFreeze.outcome); // "rejected"
console.log(postFreeze.reason);  // "AGENT_FROZEN"
```

### Restart & Persistence Guarantee
When the gateway process is restarted with the same SQLite database file:
- All committed operations remain visible with `state: "ACCOUNTING_COMMITTED"`.
- Agent freeze status remains active (`status: "AGENT_FROZEN"`).
- In-flight or expired operations are safely recovered during bootstrap.

---

## 6. Common Setup Errors & Troubleshooting

| Error / Symptom | Root Cause | Fix |
| :--- | :--- | :--- |
| `SHLITA_OPERATOR_ORG is required when SHLITA_OPERATOR_KEY is set.` | When providing `SHLITA_OPERATOR_KEY` in development, `SHLITA_OPERATOR_ORG` was omitted. | Export `SHLITA_OPERATOR_ORG="org-pilot"`. |
| `Budgets must be positive integer micro-USDC strings.` | Numeric integers or floats were passed in enrollment (e.g. `10000` or `"10.5"`). | Pass positive integer strings: `maxPerCallMicroUsdc: "50000"`. |
| `Simulation cannot be enabled in production.` | `NODE_ENV=production` or `SHLITA_ENV=production` was set alongside `SHLITA_ALLOW_SIMULATION=true`. | Set `SHLITA_ENV=development` for local testing. |
| HTTP 403 `SIMULATION_DISABLED` | Client passed `simulate: true`, but gateway was started with `SHLITA_ALLOW_SIMULATION=false`. | Start gateway with `export SHLITA_ALLOW_SIMULATION=true`. |
| `At least one allowed provider host is required.` | `allowedVendors` in `enrollAgent` was empty or missing. | Provide at least one valid host string, e.g. `['api.helius.xyz']`. |
| `A billable request requires an idempotency key` | `idempotencyKey` was omitted or shorter than 8 characters. | Provide an idempotency key with `>= 8` characters. |
| HTTP 409 `IDEMPOTENCY_CONFLICT` | An existing idempotency key was reused with a different request payload. | Use a fresh idempotency key for distinct calls, or preserve identical payload for replaying. |
| `ENOENT: no such file or directory, open '/tmp/shlita-sdk/...'` | Destination directory does not exist prior to `npm pack`. | Run `mkdir -p /tmp/shlita-sdk` before running `npm pack`. |

---

## 7. Pilot Readiness & Pending Verification

- **Local Pilot Rehearsal (Step 16)**: `VERIFIED`. Packaged SDK installs outside the monorepo, executes permitted calls, blocks unapproved calls, replays idempotency keys, records holds in WAL storage, and survives gateway restarts.
- **Hosted Staging Deployment (Step 12)**: Tracked separately in PR #19 pending approval of an accessible Linux staging host.
- **Live Google Gemini Smoke Test (Step 15)**: Verified deterministically; live smoke test is tracked separately and requires external `GEMINI_API_KEY`.
