import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPolicyEngine } from '../../packages/core/src/index.js';
import { createGatewayApp } from '../../packages/gateway/src/app.js';
import { ShlitaAgentClient, ShlitaOperatorClient } from '../../packages/sdk/src/index.js';
import { runGeminiAgent, GEMINI_TOOL_DECLARATIONS } from '../../examples/gemini-reference-agent/agent.mjs';
import { SAMPLE_MINT, FIXTURE_UPSTREAM_TOKEN_METADATA } from '../../examples/gemini-reference-agent/fixtures.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');

const OPERATOR_KEY = 'o'.repeat(40);
const BASE_URL = 'http://127.0.0.1:4010';

function runCli(env: Record<string, string>, args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'examples/gemini-reference-agent/run.mjs'), ...args], {
      cwd: root,
      env: {
        ...process.env,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

function adapter(app: ReturnType<typeof createGatewayApp>): typeof fetch {
  return (input, init) => {
    const url = new URL(String(input));
    return Promise.resolve(app.request(`${url.pathname}${url.search}`, init));
  };
}

describe('Step 15 — Live Gemini Verification & Two-Turn Protocol', () => {
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shlita-step15-test-'));
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
      operators: [{ key: OPERATOR_KEY, ownerOrg: 'org-step15-tests' }],
      allowSimulation: true,
      upstream: mockProvider,
    });

    operatorClient = new ShlitaOperatorClient({
      operatorKey: OPERATOR_KEY,
      baseUrl: BASE_URL,
      fetch: adapter(app),
    });

    const allowed = await operatorClient.enrollAgent({
      agentId: 'gemini-allowed-agent',
      allowedVendors: ['api.helius.xyz'],
      maxPerCallMicroUsdc: '50000',
      periodBudgetMicroUsdc: '1000000',
    });
    allowedAgentKey = allowed.apiKey;

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

  it('completes full two-turn protocol for allowed call and verifies follow-up payload preserves model content and tool declarations', async () => {
    const geminiCalls: Array<{ url: string; body: any }> = [];

    const mockGeminiFetch: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body || '{}'));
      geminiCalls.push({ url: String(input), body });

      if (geminiCalls.length === 1) {
        // Turn 1: Model proposes function call
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        name: 'get_solana_token_metadata',
                        args: { mint: SAMPLE_MINT },
                      },
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      } else {
        // Turn 2: Model returns synthesized answer based on tool output
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      text: `Token metadata retrieved for mint ${SAMPLE_MINT}: balance 25 USDC.`,
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    };

    const agentClient = new ShlitaAgentClient({
      apiKey: allowedAgentKey,
      baseUrl: BASE_URL,
      fetch: adapter(app),
    });

    const result = await runGeminiAgent({
      agentClient,
      agentId: 'gemini-allowed-agent',
      mode: 'live',
      geminiApiKey: 'test-api-key',
      geminiModel: 'gemini-2.5-flash',
      simulate: false,
      fetchImpl: mockGeminiFetch,
    });

    // 1. Shlita gateway committed outcome
    expect(result.shlita.outcome).toBe('committed');
    expect(result.shlita.reservedAmountMicroUsdc).toBe('10000');
    expect(result.shlita.operationId).toMatch(/^op_/);

    // 2. Downstream provider received 1 request
    expect(mockProviderRequests).toHaveLength(1);

    // 3. Gemini two-turn interaction verified
    expect(geminiCalls).toHaveLength(2);

    // Verify Turn 2 follow-up payload sent to Gemini
    const followUpBody = geminiCalls[1].body;
    expect(followUpBody.contents).toHaveLength(3);
    expect(followUpBody.contents[0].role).toBe('user');
    expect(followUpBody.contents[1].role).toBe('model');
    expect(followUpBody.contents[1].parts[0].functionCall.name).toBe('get_solana_token_metadata');
    expect(followUpBody.contents[2].role).toBe('user');
    expect(followUpBody.contents[2].parts[0].functionResponse).toBeDefined();
    expect(followUpBody.contents[2].parts[0].functionResponse.name).toBe('get_solana_token_metadata');
    expect(followUpBody.contents[2].parts[0].functionResponse.response.status).toBe('SUCCESS');
    expect(followUpBody.contents[2].parts[0].functionResponse.response.outcome).toBe('committed');

    // Crucial: tools must be passed so Gemini API does not return 400 Bad Request
    expect(followUpBody.tools).toBeDefined();
    expect(followUpBody.tools[0].functionDeclarations).toHaveLength(1);

    // 4. Follow-up status must be explicitly exposed
    expect(result.geminiFollowUp).toBeDefined();
    expect(result.geminiFollowUp?.status).toBe('success');
    expect(result.geminiFollowUp?.text).toContain(`Token metadata retrieved for mint ${SAMPLE_MINT}`);
    expect(result.geminiFollowUp?.error).toBeNull();
  });

  it('completes two-turn protocol for policy denial: gateway halts call, provider receives 0 requests, and Gemini receives structured rejection', async () => {
    const geminiCalls: Array<{ url: string; body: any }> = [];

    const mockGeminiFetch: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body || '{}'));
      geminiCalls.push({ url: String(input), body });

      if (geminiCalls.length === 1) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        name: 'get_solana_token_metadata',
                        args: { mint: SAMPLE_MINT },
                      },
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      } else {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      text: 'The request to fetch token metadata was blocked by policy: unapproved vendor.',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    };

    const agentClient = new ShlitaAgentClient({
      apiKey: deniedAgentKey,
      baseUrl: BASE_URL,
      fetch: adapter(app),
    });

    const result = await runGeminiAgent({
      agentClient,
      agentId: 'gemini-denied-agent',
      mode: 'live',
      geminiApiKey: 'test-api-key',
      geminiModel: 'gemini-2.5-flash',
      simulate: true,
      fetchImpl: mockGeminiFetch,
    });

    // 1. Shlita gateway outcome is rejected with UNAPPROVED_VENDOR
    expect(result.shlita.outcome).toBe('rejected');
    expect(result.shlita.reason).toBe('UNAPPROVED_VENDOR');
    expect(result.shlita.operationId).toBeNull();

    // 2. Downstream provider receives 0 requests
    expect(mockProviderRequests).toHaveLength(0);

    // 3. Gemini two-turn interaction
    expect(geminiCalls).toHaveLength(2);
    const followUpBody = geminiCalls[1].body;
    expect(followUpBody.contents[2].parts[0].functionResponse.response.status).toBe('POLICY_REJECTED');
    expect(followUpBody.contents[2].parts[0].functionResponse.response.reason).toBe('UNAPPROVED_VENDOR');

    // 4. Follow-up status
    expect(result.geminiFollowUp).toBeDefined();
    expect(result.geminiFollowUp?.status).toBe('success');
    expect(result.geminiFollowUp?.text).toContain('blocked by policy');
    expect(result.geminiFollowUp?.error).toBeNull();
  });

  it('exposes follow-up failure explicitly when Gemini continuation fails while preserving gateway commit and zero extra dispatches', async () => {
    let turn = 0;
    const mockGeminiFetch: typeof fetch = async () => {
      turn++;
      if (turn === 1) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        name: 'get_solana_token_metadata',
                        args: { mint: SAMPLE_MINT },
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      } else {
        // Follow-up fails (e.g. HTTP 500 or timeout)
        return new Response('Internal Server Error in Gemini Synthesis', { status: 500 });
      }
    };

    const agentClient = new ShlitaAgentClient({
      apiKey: allowedAgentKey,
      baseUrl: BASE_URL,
      fetch: adapter(app),
    });

    const result = await runGeminiAgent({
      agentClient,
      agentId: 'gemini-allowed-agent',
      mode: 'live',
      geminiApiKey: 'test-api-key',
      geminiModel: 'gemini-2.5-flash',
      simulate: false,
      fetchImpl: mockGeminiFetch,
    });

    // 1. Shlita gateway outcome is STILL committed and preserved
    expect(result.shlita.outcome).toBe('committed');
    expect(result.shlita.reservedAmountMicroUsdc).toBe('10000');
    expect(result.shlita.operationId).toMatch(/^op_/);

    // 2. Gateway was dispatched exactly once
    expect(mockProviderRequests).toHaveLength(1);

    // 3. Ledger record is preserved
    const ops = await operatorClient.listOperations();
    const recorded = ops.operations.find((op) => op.operationId === result.shlita.operationId);
    expect(recorded).toBeDefined();
    expect(recorded?.state).toBe('ACCOUNTING_COMMITTED');

    // 4. Follow-up failure is explicitly exposed
    expect(result.geminiFollowUp).toBeDefined();
    expect(result.geminiFollowUp?.status).toBe('failed');
    expect(result.geminiFollowUp?.error).toContain('Gemini API error (HTTP 500)');
    expect(result.geminiFollowUp?.text).toBeNull();
  });

  it('guarantees isolated local gateway when --isolated is passed even if SHLITA_GATEWAY_URL is in environment', async () => {
    const res = await runCli({
      SHLITA_GATEWAY_URL: 'http://127.0.0.1:9999', // Non-existent external gateway
      SHLITA_API_KEY: '',
      SHLITA_ALLOWED_API_KEY: '',
      SHLITA_DENIED_API_KEY: '',
      SHLITA_OPERATOR_KEY: '',
    }, ['--isolated', '--scenario', 'both']);

    // Should succeed because --isolated ignored the broken SHLITA_GATEWAY_URL and spawned an isolated local gateway
    expect(res.code, `CLI failed with stderr: ${res.stderr} and stdout: ${res.stdout}`).toBe(0);
    expect(res.stdout).toContain('Self-Contained Local Development Gateway');
    expect(res.stdout).toContain('Call APPROVED');
    expect(res.stdout).toContain('Call BLOCKED by Shlita policy perimeter (UNAPPROVED_VENDOR)');
  });
});
