import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPolicyEngine } from '../../packages/core/src/index.js';
import { createGatewayApp } from '../../packages/gateway/src/app.js';
import { ShlitaAgentClient, ShlitaOperatorClient } from '../../packages/sdk/src/index.js';
import {
  runGeminiAgent,
  validateToolCall,
  GEMINI_TOOL_DECLARATIONS,
} from '../../examples/gemini-reference-agent/agent.mjs';
import {
  SAMPLE_MINT,
  FIXTURE_UPSTREAM_TOKEN_METADATA,
} from '../../examples/gemini-reference-agent/fixtures.mjs';

const OPERATOR_KEY = 'o'.repeat(40);
const BASE_URL = 'http://127.0.0.1:4010';

function adapter(app: ReturnType<typeof createGatewayApp>): typeof fetch {
  return (input, init) => {
    const url = new URL(String(input));
    return Promise.resolve(app.request(`${url.pathname}${url.search}`, init));
  };
}

describe('Step 13 — Gemini Reference Agent & Spending Policy Verification', () => {
  let tmpDirs: string[] = [];
  let dbPath: string;
  let engine: ReturnType<typeof createPolicyEngine>;
  let app: ReturnType<typeof createGatewayApp>;
  let operatorClient: ShlitaOperatorClient;
  let mockProviderRequests: Array<{ url: string; method: string; body?: unknown }> = [];
  let allowedAgentKey: string;
  let deniedAgentKey: string;

  beforeEach(async () => {
    mockProviderRequests = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shlita-step13-test-'));
    tmpDirs.push(dir);
    dbPath = path.join(dir, 'ledger.db');
    engine = createPolicyEngine(dbPath);

    const mockProvider = async (exchange: { url: string; method: string; body?: unknown; timeoutMs: number }) => {
      mockProviderRequests.push({ url: exchange.url, method: exchange.method, body: exchange.body });
      return {
        status: 200,
        body: FIXTURE_UPSTREAM_TOKEN_METADATA,
      };
    };

    app = createGatewayApp(engine, undefined, {
      operators: [{ key: OPERATOR_KEY, ownerOrg: 'org-gemini-tests' }],
      allowSimulation: true,
      upstream: mockProvider,
    });

    operatorClient = new ShlitaOperatorClient({
      operatorKey: OPERATOR_KEY,
      baseUrl: BASE_URL,
      fetch: adapter(app),
    });

    // 1. Enroll Allowed Agent: Policy permits api.helius.xyz with 50,000 micro-USDC ($0.05) per-call limit
    const allowed = await operatorClient.enrollAgent({
      agentId: 'gemini-allowed-agent',
      allowedVendors: ['api.helius.xyz'],
      maxPerCallMicroUsdc: '50000',
      periodBudgetMicroUsdc: '1000000',
    });
    allowedAgentKey = allowed.apiKey;

    // 2. Enroll Denied Agent: Policy strictly restricts to api.tavily.com (prohibiting api.helius.xyz)
    const denied = await operatorClient.enrollAgent({
      agentId: 'gemini-denied-agent',
      allowedVendors: ['api.tavily.com'],
      maxPerCallMicroUsdc: '50000',
      periodBudgetMicroUsdc: '1000000',
    });
    deniedAgentKey = denied.apiKey;
  });

  afterEach(() => {
    try {
      engine?.close();
    } catch {}
    for (const d of tmpDirs.splice(0)) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('validates tool schema and arguments in application code before gateway dispatch', () => {
    expect(GEMINI_TOOL_DECLARATIONS).toHaveLength(1);
    expect(GEMINI_TOOL_DECLARATIONS[0].name).toBe('get_solana_token_metadata');

    // Valid call
    const valid = validateToolCall({
      name: 'get_solana_token_metadata',
      args: { mint: SAMPLE_MINT },
    });
    expect(valid.mint).toBe(SAMPLE_MINT);

    // Invalid function name
    expect(() =>
      validateToolCall({
        name: 'unauthorized_shell_exec',
        args: { mint: SAMPLE_MINT },
      })
    ).toThrowError(/Unsupported tool 'unauthorized_shell_exec'/);

    // Missing arguments
    expect(() =>
      validateToolCall({
        name: 'get_solana_token_metadata',
        args: {},
      })
    ).toThrowError(/Missing required string argument "mint"/);

    // Invalid Base58 address characters
    expect(() =>
      validateToolCall({
        name: 'get_solana_token_metadata',
        args: { mint: '0OIl-not-base58-solana-address!' },
      })
    ).toThrowError(/invalid base58 address bounds/);

    // Out-of-bounds length
    expect(() =>
      validateToolCall({
        name: 'get_solana_token_metadata',
        args: { mint: 'short' },
      })
    ).toThrowError(/invalid base58 address bounds/);
  });

  it('executes allowed call: provider receives exactly 1 request and ledger records operation with reserved tariff', async () => {
    const agentClient = new ShlitaAgentClient({
      apiKey: allowedAgentKey,
      baseUrl: BASE_URL,
      fetch: adapter(app),
    });

    const result = await runGeminiAgent({
      agentClient,
      agentId: 'gemini-allowed-agent',
      userPrompt: `What is the token metadata for ${SAMPLE_MINT}?`,
      mode: 'fixture',
      idempotencyKey: 'gemini-test-allowed-01',
      simulate: false,
    });

    // 1. Verify SDK return outcome
    expect(result.shlita.outcome).toBe('committed');
    expect(result.shlita.operationId).toMatch(/^op_/);
    expect(result.shlita.reservedAmountMicroUsdc).toBe('10000');
    expect(result.shlita.provider).toBe('api.helius.xyz');
    expect(result.shlita.endpoint).toBe('/v0/token-metadata');
    expect(result.providerData).toEqual(FIXTURE_UPSTREAM_TOKEN_METADATA);

    // 2. Verify downstream provider boundary (received exactly 1 request)
    expect(mockProviderRequests).toHaveLength(1);
    expect(mockProviderRequests[0].url).toContain('https://api.helius.xyz/v0/token-metadata');
    expect(mockProviderRequests[0].method).toBe('POST');
    expect(mockProviderRequests[0].body).toEqual({ mints: [SAMPLE_MINT] });

    // 3. Verify ledger boundary
    const ops = await operatorClient.listOperations();
    const recorded = ops.operations.find((op) => op.operationId === result.shlita.operationId);
    expect(recorded).toBeDefined();
    expect(recorded?.agentId).toBe('gemini-allowed-agent');
    expect(recorded?.state).toBe('ACCOUNTING_COMMITTED');
    expect(recorded?.reservedAmountMicroUsdc).toBe('10000');
    expect(recorded?.signature).toBeNull();
  });

  it('executes policy denial: stops at perimeter, provider receives 0 requests, and commits 0 billable reservations', async () => {
    const agentClient = new ShlitaAgentClient({
      apiKey: deniedAgentKey,
      baseUrl: BASE_URL,
      fetch: adapter(app),
    });

    const result = await runGeminiAgent({
      agentClient,
      agentId: 'gemini-denied-agent',
      userPrompt: `What is the token metadata for ${SAMPLE_MINT}?`,
      mode: 'fixture',
      idempotencyKey: 'gemini-test-denied-01',
      simulate: false,
    });

    // 1. Verify SDK return outcome is rejected with actual policy violation reason
    expect(result.shlita.outcome).toBe('rejected');
    expect(result.shlita.reason).toBe('UNAPPROVED_VENDOR');
    expect(result.shlita.operationId).toBeNull();
    expect(result.providerData).toBeNull();

    // 2. Verify downstream provider received zero requests
    expect(mockProviderRequests).toHaveLength(0);

    // 3. Verify ledger has 0 billable reservations committed for this agent
    const ops = await operatorClient.listOperations();
    const deniedOps = ops.operations.filter((op) => op.agentId === 'gemini-denied-agent');
    expect(deniedOps).toHaveLength(0);
  });

  it('rejects invalid model output: zero gateway calls and zero provider requests dispatched', async () => {
    const agentClient = new ShlitaAgentClient({
      apiKey: allowedAgentKey,
      baseUrl: BASE_URL,
      fetch: adapter(app),
    });

    // Model proposes an unknown function call
    const badFunctionCallResponse = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'unknown_vendor_query',
                  args: { query: 'test' },
                },
              },
            ],
          },
        },
      ],
    };

    await expect(
      runGeminiAgent({
        agentClient,
        agentId: 'gemini-allowed-agent',
        mode: 'fixture',
        customGeminiResponse: badFunctionCallResponse,
        simulate: false,
      })
    ).rejects.toThrowError(/Unsupported tool 'unknown_vendor_query'/);

    // Provider receives zero calls
    expect(mockProviderRequests).toHaveLength(0);

    // Ledger has zero recorded operations
    const ops = await operatorClient.listOperations();
    expect(ops.operations).toHaveLength(0);
  });

  it('handles idempotent replay: zero additional provider requests and zero additional reservations', async () => {
    const agentClient = new ShlitaAgentClient({
      apiKey: allowedAgentKey,
      baseUrl: BASE_URL,
      fetch: adapter(app),
    });

    const sharedKey = 'gemini-test-idempotency-key-01';

    // First call: initial execution
    const first = await runGeminiAgent({
      agentClient,
      agentId: 'gemini-allowed-agent',
      userPrompt: `What is the token metadata for ${SAMPLE_MINT}?`,
      mode: 'fixture',
      idempotencyKey: sharedKey,
      simulate: false,
    });
    expect(first.shlita.outcome).toBe('committed');
    expect(mockProviderRequests).toHaveLength(1);

    const opsAfterFirst = await operatorClient.listOperations();
    expect(opsAfterFirst.operations).toHaveLength(1);

    // Second call: exact same idempotency key and payload
    const second = await runGeminiAgent({
      agentClient,
      agentId: 'gemini-allowed-agent',
      userPrompt: `What is the token metadata for ${SAMPLE_MINT}?`,
      mode: 'fixture',
      idempotencyKey: sharedKey,
      simulate: false,
    });
    expect(second.shlita.outcome).toBe('committed');
    expect(second.shlita.operationId).toBe(first.shlita.operationId);

    // Critical assertion: provider received 0 additional requests (count stays 1)
    expect(mockProviderRequests).toHaveLength(1);

    // Critical assertion: ledger contains 0 additional reservations (count stays 1)
    const opsAfterSecond = await operatorClient.listOperations();
    expect(opsAfterSecond.operations).toHaveLength(1);
    expect(opsAfterSecond.operations[0].operationId).toBe(first.shlita.operationId);
  });
});
