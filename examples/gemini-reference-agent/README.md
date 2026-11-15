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
   - **Allowed Agent**: When an enrolled agent with `allowedVendors = ['api.helius.xyz']` issues a call, the request is approved, routed to Helius RPC, and the exact server tariff (`10,000` micro-USDC = \$0.01 USDC) is reserved in SQLite WAL storage.
   - **Denied Agent**: When an agent whose policy excludes Helius calls the same tool with the exact same input, Shlita's policy engine returns HTTP 403 `UNAPPROVED_VENDOR` instantly. Exactly **zero** downstream requests are dispatched, and **zero** billable reservations are created.
3. **Reproducible Default (Fixture Mode)**: Runs completely offline without requiring Google Gemini API keys or external paid provider credentials.
4. **Live Model Mode**: Supports connecting to live Gemini models (`gemini-2.5-flash`, `gemini-1.5-flash`) with strict single-dispatch bounding per turn.

---

## 2. Prerequisites & Environment Setup

Node.js 22 or newer is required.

From the repository root:
```bash
# Install dependencies and build project
npm ci
npm run build
npm run build:sdk
```

### Environment Variables

| Variable | Description | Default / Mode |
| :--- | :--- | :--- |
| `SHLITA_GATEWAY_URL` | Local or staging Shlita gateway URL | Auto-spawns local gateway if omitted |
| `SHLITA_API_KEY` | Custom agent API key for testing | Auto-enrolled if omitted |
| `GEMINI_MODE` | Execution mode: `fixture` or `live` | `fixture` |
| `GEMINI_API_KEY` | Google AI Studio / Gemini API key | Required only when `mode=live` |
| `GEMINI_MODEL` | Gemini model identifier | `gemini-2.5-flash` |
| `SCENARIO` | Scenario filter: `allowed`, `denied`, or `both` | `both` |

---

## 3. Agent Enrollment & Policies

In this example, two agents are enrolled with distinct spending policies to demonstrate deterministic gateway enforcement:

### Allowed Agent (`gemini-allowed-agent`)
```typescript
{
  agentId: 'gemini-allowed-agent',
  allowedVendors: ['api.helius.xyz'],
  maxPerCallMicroUsdc: '50000', // $0.05 max per call
  periodBudgetMicroUsdc: '1000000', // $1.00 daily budget
}
```
- **Helius Tariff**: 10,000 micro-USDC.
- **Evaluation**: Permitted because `api.helius.xyz` is in `allowedVendors` and `10,000 <= 50,000`.

### Denied Agent (`gemini-denied-agent`)
```typescript
{
  agentId: 'gemini-denied-agent',
  allowedVendors: ['api.tavily.com'], // Helius is prohibited
  maxPerCallMicroUsdc: '50000',
  periodBudgetMicroUsdc: '1000000',
}
```
- **Evaluation**: Blocked because `api.helius.xyz` is not in `allowedVendors`.

---

## 4. Running the Example

### A. Default Fixture Mode (Reproducible & Credential-Free)

Runs both scenarios using deterministic Gemini function-calling fixtures against an ephemeral local gateway:

```bash
node examples/gemini-reference-agent/run.mjs
```

#### Run Specific Scenarios:
```bash
# Run only the allowed scenario:
node examples/gemini-reference-agent/run.mjs --scenario allowed

# Run only the denied scenario:
node examples/gemini-reference-agent/run.mjs --scenario denied
```

#### Expected Output (Truncated Summary):
```json
--- [SCENARIO 1: ALLOWED OPERATION] ---
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
    "operationId": "op_2da9ef1a-19da-4c9a-a427-5168baba4367",
    "reason": null,
    "reservedAmountMicroUsdc": "10000",
    "fundsMoved": false,
    "provider": "api.helius.xyz",
    "endpoint": "/v0/token-metadata"
  }
}
✓ Verdict: Call APPROVED. Reserved 10000 micro-USDC in ledger.

--- [SCENARIO 2: POLICY-DENIED OPERATION] ---
Developer Outcome:
{
  "mode": "fixture",
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
    "fundsMoved": false
  }
}
✓ Verdict: Call BLOCKED by Shlita policy perimeter (UNAPPROVED_VENDOR). 0 provider calls dispatched.
```

---

## 5. Live Google Gemini Mode

To exercise live Gemini model reasoning with function calling:

```bash
export GEMINI_API_KEY="<your-google-ai-studio-api-key>"
node examples/gemini-reference-agent/run.mjs --mode live
```

### Distinguishing Live vs Mocked Components:
- **Gemini Model**: When `mode === 'live'`, requests are made to `https://generativelanguage.googleapis.com/v1beta/models/...`. The developer outcome outputs `"mode": "live (gemini-2.5-flash)"`.
- **Downstream Provider**: By default, the local demo gateway uses Shlita's development simulation perimeter or a mock upstream dispatcher. Real upstream network calls to Helius only occur if a real `HELIUS_API_KEY` is provided on an unsimulated gateway.

---

## 6. How to Inspect the Ledger

When an operation is committed through Shlita, it is recorded in the SQLite WAL ledger.

Using the `ShlitaOperatorClient`:
```typescript
import { ShlitaOperatorClient } from 'shlita-sdk';

const operator = new ShlitaOperatorClient({
  operatorKey: process.env.SHLITA_OPERATOR_KEY!,
  baseUrl: process.env.SHLITA_GATEWAY_URL!,
});

const { operations } = await operator.listOperations();
console.log(operations);
```

### Ledger Terminology:
- `operationId`: Unique UUID (`op_...`) assigned to each committed call.
- `state`: `ACCOUNTING_COMMITTED` indicates that the policy engine verified limits and reserved the server tariff.
- `reservedAmountMicroUsdc`: Amount held in micro-USDC (`10000` = \$0.010000 USDC).
- `fundsMoved`: `false`. Shlita proxy execution holds reservations; tokens are only moved during subsequent settlement.
