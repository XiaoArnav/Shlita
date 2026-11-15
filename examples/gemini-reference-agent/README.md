# Shlita — Gemini Reference Agent Example

This reference example demonstrates how autonomous AI agents built on **Google Gemini** execute paid provider operations under the governance of the **Shlita Spending Policy Gateway**.

```
┌──────────────┐     1. Prompt       ┌────────────────┐
│ User / Task  │ ──────────────────> │  Google Gemini │
└──────────────┘                     └────────────────┘
                                              │ 2. Proposes Function Call
                                              ▼
                                     ┌─────────────────────────┐
                                     │  Application Perimeter  │
                                     │  (Argument Validation)  │
                                     └─────────────────────────┘
                                              │ 3. ShlitaAgentClient.proxy()
                                              ▼
                                     ┌─────────────────────────┐
                                     │  Shlita Policy Gateway  │
                                     │  - Vendor Allowlist     │
                                     │  - Budget Enforcement   │
                                     │  - Idempotency & WAL    │
                                     └─────────────────────────┘
                                       /                     \
                      4a. Policy Passed /                       \ 4b. Policy Denied
                                       ▼                         ▼
                            ┌───────────────────┐       ┌─────────────────┐
                            │ Downstream Vendor │       │  Gateway Halts  │
                            │ (api.helius.xyz)  │       │  0 Dispatches   │
                            └───────────────────┘       └─────────────────┘
                                       │                         │
                                       ▼                         ▼
                            Ledger: 10,000 µUSDC        Ledger: 0 µUSDC
                            Outcome: COMMITTED          Outcome: REJECTED
```

---

## 1. Key Invariants & Architectural Guarantees

1. **Strict Application Perimeter**: Gemini only controls the function argument (the Solana `mint` address). Upstream provider URL, HTTP method, target path, API keys, and agent credentials are hardcoded and enforced on the server side.
2. **Deterministic Dual Outcomes**:
   - **Allowed Agent**: When an enrolled agent with `allowedVendors = ['api.helius.xyz']` issues a call, the request is approved, routed to Helius RPC (or mock upstream), and the exact server tariff (`10,000` micro-USDC = \$0.0100 USDC) is reserved in SQLite WAL storage.
   - **Denied Agent**: When an agent whose policy excludes Helius calls the same tool with the exact same input, Shlita's policy engine returns HTTP 403 `UNAPPROVED_VENDOR` instantly. Exactly **zero** downstream requests are dispatched, and **zero** billable reservations are created.
3. **Reproducible Default (Fixture Mode)**: Runs completely offline without requiring Google Gemini API keys or external paid provider credentials.
4. **Independent Model & Gateway Modes**:
   - **Gemini Input Mode**: `fixture` (default, deterministic function-calling fixture) or `live` (invokes Google Gemini API with `GEMINI_API_KEY`).
   - **Gateway Execution Mode**:
     - *Self-contained local demo*: Spawns an isolated development gateway with local simulation enabled.
     - *Configured gateway*: Connects to `SHLITA_GATEWAY_URL` with normal execution by default (`simulate: false`). Optional `--simulate` flag enables explicit simulation if supported by the remote dev environment.

---

## 2. Prerequisites & Clean Checkout Setup

Node.js 22 or newer is required.

From the repository root:
```bash
# 1. Install dependencies
npm ci

# 2. Build TypeScript project and SDK
npm run build
npm run build:sdk
```

---

## 3. Two Gateway Setup Paths

### Path A: Self-Contained Local Development Gateway (Credential-Free Demo)

Runs immediately with **zero setup** and **no credentials**. Spawns an ephemeral gateway process on a free local port, initializes an isolated SQLite database, enrolls test agents, and cleans up automatically upon exit:

```bash
# Run both allowed and denied scenarios:
node examples/gemini-reference-agent/run.mjs

# Run only the allowed scenario:
node examples/gemini-reference-agent/run.mjs --scenario allowed

# Run only the denied scenario:
node examples/gemini-reference-agent/run.mjs --scenario denied
```

### Path B: Configured Gateway Mode (External Local or Remote Gateway)

Connects to an existing Shlita gateway process (e.g. started via `npm start` or Docker Compose at `http://127.0.0.1:4000`).

In this mode:
- **Simulation is off by default (`simulate: false`)**: The gateway evaluates live policy and dispatches requests to its configured upstream vendor or mock upstream dispatcher.
- **Explicit Simulation (`--simulate`)**: For development gateways configured with `SHLITA_ALLOW_SIMULATION=true`, passing `--simulate` (or `SHLITA_SIMULATE=true`) enables simulation explicitly. It is never enabled silently.

#### Required Keys by Scenario:

| Scenario | Required Environment Variables | Notes |
| :--- | :--- | :--- |
| `--scenario both` | `SHLITA_GATEWAY_URL`<br>`SHLITA_ALLOWED_API_KEY` (or `SHLITA_API_KEY`)<br>`SHLITA_DENIED_API_KEY` | Distinct scoped keys are required for the allowed and denied agents. Missing keys fail early before dispatch. |
| `--scenario allowed` | `SHLITA_GATEWAY_URL`<br>`SHLITA_ALLOWED_API_KEY` (or `SHLITA_API_KEY`) | Requires an API key for the agent permitted to call `api.helius.xyz`. |
| `--scenario denied` | `SHLITA_GATEWAY_URL`<br>`SHLITA_DENIED_API_KEY` (or `SHLITA_API_KEY`) | Requires an API key for the agent prohibited from calling `api.helius.xyz`. |
| *(Any Scenario)* | `SHLITA_OPERATOR_KEY` *(Optional)* | If provided, queries the gateway and outputs the ledger audit trail table. |

#### Example Commands:

```bash
# 1. Run both scenarios against a configured gateway:
SHLITA_GATEWAY_URL="http://127.0.0.1:4000" \
SHLITA_ALLOWED_API_KEY="shlt_live_allowed_agent_key..." \
SHLITA_DENIED_API_KEY="shlt_live_denied_agent_key..." \
SHLITA_OPERATOR_KEY="op_master_operator_key..." \
node examples/gemini-reference-agent/run.mjs --scenario both

# 2. Run only the allowed scenario:
SHLITA_GATEWAY_URL="http://127.0.0.1:4000" \
SHLITA_API_KEY="shlt_live_allowed_agent_key..." \
node examples/gemini-reference-agent/run.mjs --scenario allowed

# 3. Run with explicit simulation on a development gateway:
SHLITA_GATEWAY_URL="http://127.0.0.1:4000" \
SHLITA_API_KEY="shlt_live_allowed_agent_key..." \
node examples/gemini-reference-agent/run.mjs --scenario allowed --simulate
```

---

## 4. Agent Enrollment & Policies

When enrolling agents on a configured gateway (via `ShlitaOperatorClient` or `POST /v1/agents`), use the following policies:

### Allowed Agent (`gemini-allowed-agent`)
```typescript
{
  agentId: 'gemini-allowed-agent',
  allowedVendors: ['api.helius.xyz'],
  maxPerCallMicroUsdc: '50000',     // $0.05 max per call
  periodBudgetMicroUsdc: '1000000', // $1.00 budget period
}
```
- **Helius Server Tariff**: 10,000 micro-USDC ($0.0100 USDC).
- **Policy Decision**: Approved (`10,000 <= 50,000` and vendor is allowlisted).

### Denied Agent (`gemini-denied-agent`)
```typescript
{
  agentId: 'gemini-denied-agent',
  allowedVendors: ['api.tavily.com'], // Prohibits api.helius.xyz
  maxPerCallMicroUsdc: '50000',
  periodBudgetMicroUsdc: '1000000',
}
```
- **Policy Decision**: Rejected (`UNAPPROVED_VENDOR` returned with HTTP 403; zero upstream requests dispatched).

---

## 5. Representative Output

```text
============================================================
 Shlita — Gemini Reference Agent Spending Policy Demo
 Gemini Model Mode : FIXTURE (Deterministic Function Calling)
 Gateway Target    : Self-Contained Local Development Gateway
 Gateway Execution : Local Simulation
 Target Scenario(s): both
============================================================

--- [SCENARIO 1: ALLOWED OPERATION] ---
Agent ID   : gemini-allowed-agent
Policy     : allowedVendors = ["api.helius.xyz"], maxPerCall = 50000 micro-USDC ($0.05 USDC)
Tool Call  : get_solana_token_metadata(mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")
Execution  : simulate=true

Developer Outcome:
{
  "mode": "fixture",
  "userPrompt": "What is the token metadata for DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263?",
  "toolCall": {
    "name": "get_solana_token_metadata",
    "arguments": {
      "mint": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
    }
  },
  "shlita": {
    "outcome": "committed",
    "operationId": "op_983d58ef-3bdf-4a6c-9419-48fe2d5794db",
    "reason": null,
    "reservedAmountMicroUsdc": "10000",
    "fundsMoved": false,
    "provider": "api.helius.xyz",
    "endpoint": "/v0/token-metadata"
  },
  "providerData": {
    "network": "solana-devnet",
    "slot": 318492048,
    "result": {
      "account": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      "balanceMicroUsdc": 25000000,
      "activeDelegations": 2,
      "program": "De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44"
    }
  },
  "modelSummary": "Retrieved Solana token metadata for mint DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 via Helius RPC under Shlita spending policy protection."
}

✓ Verdict: Call APPROVED. Reserved 10000 micro-USDC ($0.0100 USDC) in Shlita ledger.

--- [SCENARIO 2: POLICY-DENIED OPERATION] ---
Agent ID   : gemini-denied-agent
Policy     : Prohibits api.helius.xyz
Tool Call  : get_solana_token_metadata(mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")
Execution  : simulate=true

Developer Outcome:
{
  "mode": "fixture",
  "userPrompt": "What is the token metadata for DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263?",
  "toolCall": {
    "name": "get_solana_token_metadata",
    "arguments": {
      "mint": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
    }
  },
  "shlita": {
    "outcome": "rejected",
    "operationId": null,
    "reason": "UNAPPROVED_VENDOR",
    "reservedAmountMicroUsdc": null,
    "fundsMoved": false,
    "provider": "api.helius.xyz",
    "endpoint": "/v0/token-metadata"
  },
  "providerData": null,
  "modelSummary": "Retrieved Solana token metadata for mint DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 via Helius RPC under Shlita spending policy protection."
}

✓ Verdict: Call BLOCKED by Shlita policy perimeter (UNAPPROVED_VENDOR). 0 provider calls dispatched, 0 micro-USDC reserved in ledger.

--- [LEDGER AUDIT RECORD] ---
Total Operations Recorded in Ledger: 1
 - Operation ID      : op_983d58ef-3bdf-4a6c-9419-48fe2d5794db
   Agent ID          : gemini-allowed-agent
   Vendor            : api.helius.xyz
   Decision          : ALLOWED
   State             : ACCOUNTING_COMMITTED
   Reserved Tariff   : 10000 micro-USDC ($0.0100 USDC)
   Settlement Status : NOT_SUBMITTED
   Signature         : null (unsettled hold)

============================================================
 DEMO SUMMARY: ALL CHECKS PASSED
 1. Allowed call was routed and reserved in the Shlita ledger.
 2. Denied call was stopped at perimeter with 0 provider calls.
============================================================
```

---

## 6. Live Google Gemini Smoke Test

To execute a live model reasoning call using Google Gemini:

```bash
export GEMINI_API_KEY="<your-google-ai-studio-api-key>"
node examples/gemini-reference-agent/run.mjs --mode live --scenario allowed --isolated
```

### Component Breakdown in Live Mode:
- **Google Gemini Model**: Dispatches a live function-calling request to `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`. Gemini analyzes the prompt and proposes `get_solana_token_metadata(mint: "...")`.
- **Application Perimeter**: Application validates the proposed function arguments (verifying strict Base58 encoding and address bounds).
- **Shlita Policy Gateway**: Checks agent policy limits and approves the call.
- **Downstream Provider**: By default, uses local simulation or mock upstream provider unless the gateway itself has a live Helius RPC credential configured.
- **Isolated Gateway Option**: Passing `--isolated` or `--self-contained` ensures the smoke test spawns an isolated local gateway, ignoring any shell-inherited `SHLITA_GATEWAY_URL`.

*(If `GEMINI_API_KEY` is not exported, live execution is marked `BLOCKED (pending external API key)`).*

---

## 7. How to Inspect the Ledger & Interpret Reserved Amounts

When an operation passes policy checks, the Shlita Gateway reserves funds atomically in the SQLite WAL ledger:

```typescript
import { ShlitaOperatorClient } from 'shlita-sdk';

const operator = new ShlitaOperatorClient({
  operatorKey: process.env.SHLITA_OPERATOR_KEY!,
  baseUrl: process.env.SHLITA_GATEWAY_URL!,
});

const { operations } = await operator.listOperations();
console.log(operations);
```

### Understanding Ledger Fields:
- `operationId`: Immutable UUID (`op_...`) assigned to each committed call.
- `state`: `ACCOUNTING_COMMITTED` confirms the policy engine committed the tariff hold in WAL storage.
- `reservedAmountMicroUsdc`: Amount held in micro-USDC. `10000` equals \$0.010000 USDC.
- `settlementStatus`: `NOT_SUBMITTED`. Proxy execution creates an estimated hold; tokens are only moved during subsequent batch settlement.
- `signature`: `null` until on-chain settlement is performed.

---

## 8. Step 15 Live Gemini Verification Checkpoints & Evidence

### Verification Status
- **Live Gemini API Smoke Test**: `BLOCKED (pending external GEMINI_API_KEY)`. When running without `GEMINI_API_KEY`, `node examples/gemini-reference-agent/run.mjs --mode live --scenario allowed --isolated` exits `1` with:
  ```text
  Error: Missing GEMINI_API_KEY (or --gemini-api-key).
  When running with "--mode live", a Google Gemini API key is required.
  ```
- **Deterministic Two-Turn Protocol Verification**: `PASS` (4/4 integration tests in `tests/step-15/gemini.live-verification.test.ts`).

### Step 15 Checkpoint Matrix

| Checkpoint | Allowed Scenario (`--scenario allowed`) | Denied Scenario (`--scenario denied`) |
| :--- | :--- | :--- |
| **Gemini Tool Proposal** | Gemini proposes `get_solana_token_metadata` with valid argument `mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"`. | Gemini proposes identical tool call `get_solana_token_metadata` with valid argument `mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"`. |
| **Shlita Policy Decision** | Shlita SDK returns `outcome: "committed"`, immutable `operationId: "op_..."`, and reserves `10,000` µUSDC ($0.0100 USDC) in SQLite WAL storage. | Shlita SDK returns `outcome: "rejected"`, `reason: "UNAPPROVED_VENDOR"`, `operationId: null`, and reserves `0` µUSDC. |
| **Gemini Follow-up Synthesis** | Gemini accepts the structured function response (`status: 'SUCCESS'`), receives preserved model history + tool declarations, and returns synthesized text. `geminiFollowUp.status === 'success'`. | Gemini accepts structured rejection (`status: 'POLICY_REJECTED'`, `reason: 'UNAPPROVED_VENDOR'`) and synthesizes an advisory. Shlita's policy rejection remains the authoritative developer verdict. `geminiFollowUp.status === 'success'`. |
| **Execution Evidence** | - Model: Live (pending key) / Fixture (`gemini-2.5-flash`)<br>- Gateway: Isolated local SQLite instance (`--isolated`)<br>- Downstream: Simulated / Mock upstream received **exactly 1 dispatch**. | - Model: Live (pending key) / Fixture (`gemini-2.5-flash`)<br>- Gateway: Isolated local SQLite instance (`--isolated`)<br>- Downstream: **0 dispatches** verified by test instrumentation. |

### Dual Outcome Independence Invariant
In earlier versions, a failure in Gemini's follow-up synthesis could be silenced or replaced by fallback text while reporting a successful overall exit code. Step 15 establishes strict independence:
1. **Explicit Follow-up Status**: The result object exposes `geminiFollowUp: { status: 'success' | 'failed' | 'omitted', text, error }`.
2. **Strict Smoke Test Failure**: In `--mode live`, if Gemini fails to synthesize a response (e.g., HTTP 500 or timeout), `run.mjs` exits non-zero (`code 1`) even if the gateway committed the hold.
3. **Single Gateway Dispatch Invariant**: The gateway is dispatched **strictly once** per scenario. Even if the model follow-up fails or is retried, the initial hold is preserved for operator auditing and zero additional gateway reservations are created.

### Isolated Local Gateway Guarantee
To prevent shell-inherited variables (`SHLITA_GATEWAY_URL`) from inadvertently pointing the test at an external or staging gateway, `run.mjs` supports the `--isolated` (or `--self-contained`) flag. When passed, `run.mjs` forces the gateway target to an ephemeral local server with local SQLite storage.

### Commands to Rerun Live Verification (Once Key is Configured)
```bash
# 1. Export your Gemini API key
export GEMINI_API_KEY="AIzaSy..."

# 2. Run the allowed scenario smoke test through an isolated local gateway
node examples/gemini-reference-agent/run.mjs --mode live --scenario allowed --isolated

# 3. Run the policy-denied scenario smoke test
node examples/gemini-reference-agent/run.mjs --mode live --scenario denied --isolated
```
