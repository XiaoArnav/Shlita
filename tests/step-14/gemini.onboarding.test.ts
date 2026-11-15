import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPolicyEngine } from '../../packages/core/src/index.js';
import { createGatewayApp } from '../../packages/gateway/src/app.js';
import { ShlitaOperatorClient } from '../../packages/sdk/src/index.js';
import { FIXTURE_UPSTREAM_TOKEN_METADATA } from '../../examples/gemini-reference-agent/fixtures.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');

const OPERATOR_KEY = 'o'.repeat(40);

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

describe('Step 14 — Gemini Reference Agent Developer Onboarding & Gateway Configuration', () => {
  let tmpDirs: string[] = [];
  let dbPath: string;
  let engine: ReturnType<typeof createPolicyEngine>;
  let server: http.Server;
  let gatewayUrl: string;
  let mockProviderRequests: Array<{ url: string; method: string; body?: unknown }> = [];
  let simulationReceived: boolean = false;
  let allowedAgentKey: string;
  let deniedAgentKey: string;

  beforeEach(async () => {
    mockProviderRequests = [];
    simulationReceived = false;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shlita-step14-test-'));
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

    // Standard configured gateway with allowSimulation: false
    const app = createGatewayApp(engine, undefined, {
      operators: [{ key: OPERATOR_KEY, ownerOrg: 'org-step14-tests' }],
      allowSimulation: false,
      upstream: mockProvider,
    });

    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined) {
          if (Array.isArray(v)) {
            v.forEach((val) => headers.append(k, val));
          } else {
            headers.set(k, v);
          }
        }
      }

      if (req.headers['x-shlita-simulation'] === 'true') {
        simulationReceived = true;
      }

      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', async () => {
        const body = ['GET', 'HEAD'].includes(req.method || '') ? undefined : Buffer.concat(chunks);
        if (body && body.toString().includes('"simulate":true')) {
          simulationReceived = true;
        }
        const webReq = new Request(url.href, {
          method: req.method,
          headers,
          body,
          // @ts-expect-error duplex required in Node 18+ for streaming bodies
          duplex: 'half',
        });

        const webRes = await app.fetch(webReq);
        res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
        const resBuf = await webRes.arrayBuffer();
        res.end(Buffer.from(resBuf));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        gatewayUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    const operatorClient = new ShlitaOperatorClient({
      operatorKey: OPERATOR_KEY,
      baseUrl: gatewayUrl,
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

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  it('regression: executes successfully against a configured gateway with simulation disabled by defaulting simulate to false', async () => {
    const res = await runCli({
      SHLITA_GATEWAY_URL: gatewayUrl,
      SHLITA_ALLOWED_API_KEY: allowedAgentKey,
      SHLITA_DENIED_API_KEY: deniedAgentKey,
      SHLITA_OPERATOR_KEY: OPERATOR_KEY,
      SCENARIO: 'both',
    });

    expect(res.code, `CLI failed with stderr: ${res.stderr} and stdout: ${res.stdout}`).toBe(0);
    expect(res.stdout).toContain('Call APPROVED');
    expect(res.stdout).toContain('Call BLOCKED by Shlita policy perimeter (UNAPPROVED_VENDOR)');
    expect(res.stdout).not.toContain('SIMULATION_DISABLED');
    expect(simulationReceived).toBe(false);
    expect(mockProviderRequests).toHaveLength(1);
    expect(mockProviderRequests[0].url).toContain('api.helius.xyz');
  });

  it('fails early with actionable error when running scenario both without distinct denied key', async () => {
    const res = await runCli({
      SHLITA_GATEWAY_URL: gatewayUrl,
      SHLITA_ALLOWED_API_KEY: allowedAgentKey,
      SHLITA_DENIED_API_KEY: '',
      SHLITA_API_KEY: '',
      SCENARIO: 'both',
    });

    expect(res.code).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/SHLITA_DENIED_API_KEY/i);
    expect(res.stderr + res.stdout).toMatch(/distinct.*agent key/i);
    expect(mockProviderRequests).toHaveLength(0);
  });

  it('fails early with actionable error when running scenario allowed without an API key', async () => {
    const res = await runCli({
      SHLITA_GATEWAY_URL: gatewayUrl,
      SHLITA_ALLOWED_API_KEY: '',
      SHLITA_API_KEY: '',
      SCENARIO: 'allowed',
    });

    expect(res.code).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/SHLITA_ALLOWED_API_KEY|SHLITA_API_KEY/i);
    expect(mockProviderRequests).toHaveLength(0);
  });

  it('fails early with actionable error when running scenario denied without an API key', async () => {
    const res = await runCli({
      SHLITA_GATEWAY_URL: gatewayUrl,
      SHLITA_DENIED_API_KEY: '',
      SHLITA_API_KEY: '',
      SCENARIO: 'denied',
    });

    expect(res.code).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/SHLITA_DENIED_API_KEY|SHLITA_API_KEY/i);
    expect(mockProviderRequests).toHaveLength(0);
  });

  it('allows explicit simulation on configured gateway when --simulate is passed', async () => {
    // Against allowSimulation: false, explicit simulation request should be rejected by gateway with SIMULATION_DISABLED
    const res = await runCli({
      SHLITA_GATEWAY_URL: gatewayUrl,
      SHLITA_ALLOWED_API_KEY: allowedAgentKey,
      SHLITA_DENIED_API_KEY: deniedAgentKey,
      SCENARIO: 'allowed',
    }, ['--simulate']);

    // Should receive simulation error from the gateway since simulation was explicitly requested
    expect(simulationReceived).toBe(true);
    expect(res.stdout + res.stderr).toContain('SIMULATION_DISABLED');
  });

  it('executes self-contained fixture demo without external credentials', async () => {
    const res = await runCli({
      SHLITA_GATEWAY_URL: '',
      SHLITA_API_KEY: '',
      SHLITA_ALLOWED_API_KEY: '',
      SHLITA_DENIED_API_KEY: '',
      SHLITA_OPERATOR_KEY: '',
      SCENARIO: 'both',
    });

    expect(res.code, `CLI failed with stderr: ${res.stderr} and stdout: ${res.stdout}`).toBe(0);
    expect(res.stdout).toContain('Call APPROVED');
    expect(res.stdout).toContain('Call BLOCKED by Shlita policy perimeter (UNAPPROVED_VENDOR)');
    expect(res.stdout).toContain('DEMO SUMMARY: ALL CHECKS PASSED');
  });
});
