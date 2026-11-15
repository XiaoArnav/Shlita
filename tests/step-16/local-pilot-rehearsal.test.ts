import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPolicyEngine } from '../../packages/core/src/index.js';
import { createGatewayApp } from '../../packages/gateway/src/app.js';
import { ShlitaAgentClient, ShlitaOperatorClient } from '../../packages/sdk/src/index.js';

const exec = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');

const OPERATOR_KEY = 'o'.repeat(48);
const BASE_URL = 'http://127.0.0.1:4010';

function adapter(app: ReturnType<typeof createGatewayApp>): typeof fetch {
  return (input, init) => {
    const url = new URL(String(input));
    return Promise.resolve(app.request(`${url.pathname}${url.search}`, init));
  };
}

describe('Step 16 — Local Pilot Rehearsal and Developer Handoff', () => {
  describe('Full Packaged SDK & Subprocess Rehearsal', () => {
    it('executes clean-checkout npm pack, external consumer install, and all 6 developer/operator scenarios', async () => {
      const { stdout } = await exec(process.execPath, ['scripts/pilot-rehearsal.mjs'], {
        cwd: root,
        timeout: 120_000,
        maxBuffer: 2_000_000,
      });

      const result = JSON.parse(stdout.trim());
      expect(result.rehearsal).toBe('SUCCESS');
      expect(result.tarball).toBe('shlita-sdk-0.1.0.tgz');
      expect(result.scenarios.s1_firstAllowed.outcome).toBe('committed');
      expect(result.scenarios.s1_firstAllowed.reservedAmountMicroUsdc).toBe('10000');
      expect(result.scenarios.s2_policyDenied.outcome).toBe('rejected');
      expect(result.scenarios.s2_policyDenied.reason).toBe('UNAPPROVED_VENDOR');
      expect(result.scenarios.s3_idempotentReplay.outcome).toBe('committed');
      expect(result.scenarios.s3_idempotentReplay.replay).toBe(true);
      expect(result.scenarios.s3_idempotentReplay.operationId).toBe(result.scenarios.s1_firstAllowed.operationId);
      expect(result.scenarios.s4_operatorLedger.state).toBe('ACCOUNTING_COMMITTED');
      expect(result.scenarios.s4_operatorLedger.settlementStatus).toBe('NOT_SUBMITTED');
      expect(result.scenarios.s4_operatorLedger.signature).toBeNull();
      expect(result.scenarios.s5_freezeAndVerify.outcome).toBe('rejected');
      expect(result.scenarios.s5_freezeAndVerify.reason).toBe('AGENT_FROZEN');
      expect(result.scenarios.s6_restartAndRecover.survivedRestart).toBe(true);
      expect(result.scenarios.s6_restartAndRecover.persistedState).toBe('ACCOUNTING_COMMITTED');
      expect(result.scenarios.s6_restartAndRecover.persistedAgentStatus).toBe('AGENT_FROZEN');
    }, 120_000);
  });

  describe('Counted Mock Upstream Provider Invariants', () => {
    let tmpDirs: string[] = [];
    let dbPath: string;
    let engine: ReturnType<typeof createPolicyEngine>;
    let app: ReturnType<typeof createGatewayApp>;
    let operatorClient: ShlitaOperatorClient;
    let agentClient: ShlitaAgentClient;
    let agentApiKey: string;
    let mockRequests: Array<{ url: string; method: string; body?: unknown }> = [];

    beforeEach(async () => {
      mockRequests = [];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shlita-step16-mock-'));
      tmpDirs.push(dir);
      dbPath = path.join(dir, 'ledger.db');
      engine = createPolicyEngine(dbPath);

      const mockUpstream = async (exchange: { url: string; method: string; body?: unknown; timeoutMs: number }) => {
        mockRequests.push({ url: exchange.url, method: exchange.method, body: exchange.body });
        return {
          status: 200,
          body: {
            network: 'solana-devnet',
            result: { account: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', balanceMicroUsdc: 25000000 },
          },
        };
      };

      app = createGatewayApp(engine, undefined, {
        operators: [{ key: OPERATOR_KEY, ownerOrg: 'org-pilot-step16' }],
        allowSimulation: false,
        upstream: mockUpstream,
      });

      operatorClient = new ShlitaOperatorClient({
        operatorKey: OPERATOR_KEY,
        baseUrl: BASE_URL,
        fetch: adapter(app),
      });

      const enrolled = await operatorClient.enrollAgent({
        agentId: 'pilot-agent-mock',
        allowedVendors: ['api.helius.xyz'],
        maxPerCallMicroUsdc: '50000',
        periodBudgetMicroUsdc: '1000000',
      });
      agentApiKey = enrolled.apiKey;

      agentClient = new ShlitaAgentClient({
        apiKey: agentApiKey,
        baseUrl: BASE_URL,
        fetch: adapter(app),
      });
    });

    afterEach(() => {
      try {
        engine?.close();
      } catch {}
      for (const d of tmpDirs.splice(0)) {
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
      }
    });

    it('proves exactly one dispatch for allowed call, zero for replay, zero for denied, and zero after freeze', async () => {
      // 1. Scenario 1: First Allowed Request -> Dispatches exactly 1 upstream call
      const allowedRes = await agentClient.proxy({
        agentId: 'pilot-agent-mock',
        vendor: 'api.helius.xyz',
        path: '/v0/token-metadata',
        method: 'POST',
        body: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
        idempotencyKey: 'counted-mock-key-01',
      });

      expect(allowedRes.outcome).toBe('committed');
      if (allowedRes.outcome === 'committed') {
        expect(allowedRes.cost.reservedAmountMicroUsdc).toBe('10000');
        expect(allowedRes.settlement.status).toBe('NOT_SUBMITTED');
        expect(allowedRes.fundsMoved).toBe(false);
      }
      expect(mockRequests).toHaveLength(1);
      expect(mockRequests[0].url).toContain('api.helius.xyz');

      // 2. Scenario 2: Policy-Denied Request -> 0 additional dispatches
      const deniedRes = await agentClient.proxy({
        agentId: 'pilot-agent-mock',
        vendor: 'api.tavily.com', // Not in allowedVendors
        path: '/search',
        method: 'POST',
        body: { query: 'test' },
        idempotencyKey: 'counted-mock-key-denied',
      });

      expect(deniedRes.outcome).toBe('rejected');
      if (deniedRes.outcome === 'rejected') {
        expect(deniedRes.reason).toBe('UNAPPROVED_VENDOR');
      }
      expect(mockRequests).toHaveLength(1); // Still 1! Zero dispatches for denied

      // 3. Scenario 3: Idempotent Replay -> 0 additional dispatches
      const replayRes = await agentClient.proxy({
        agentId: 'pilot-agent-mock',
        vendor: 'api.helius.xyz',
        path: '/v0/token-metadata',
        method: 'POST',
        body: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
        idempotencyKey: 'counted-mock-key-01', // Identical key and payload
      });

      expect(replayRes.outcome).toBe('committed');
      if (replayRes.outcome === 'committed') {
        expect(replayRes.replay).toBe(true);
        if (allowedRes.outcome === 'committed') {
          expect(replayRes.operationId).toBe(allowedRes.operationId);
        }
      }
      expect(mockRequests).toHaveLength(1); // Still 1! Zero dispatches for idempotent replay

      // 4. Scenario 4: Operator Ledger Inspection
      const ops = await operatorClient.listOperations();
      if (allowedRes.outcome === 'committed') {
        const found = ops.operations.find((o) => o.operationId === allowedRes.operationId);
        expect(found).toBeDefined();
        expect(found?.state).toBe('ACCOUNTING_COMMITTED');
        expect(found?.reservedAmountMicroUsdc).toBe('10000');
        expect(found?.settlementStatus).toBe('NOT_SUBMITTED');
        expect(found?.signature).toBeNull();
      }

      // 5. Scenario 5: Freeze and Verify -> 0 additional dispatches
      await operatorClient.freezeAgent('pilot-agent-mock', 'emergency-freeze-audit');
      const frozenRes = await agentClient.proxy({
        agentId: 'pilot-agent-mock',
        vendor: 'api.helius.xyz',
        path: '/v0/token-metadata',
        method: 'POST',
        body: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
        idempotencyKey: 'counted-mock-key-post-freeze',
      });

      expect(frozenRes.outcome).toBe('rejected');
      if (frozenRes.outcome === 'rejected') {
        expect(frozenRes.reason).toBe('AGENT_FROZEN');
      }
      expect(mockRequests).toHaveLength(1); // Still 1! Zero dispatches for frozen agent

      // 6. Scenario 6: Restart and Recover
      engine.close();
      const reopenedEngine = createPolicyEngine(dbPath);
      const reopenedApp = createGatewayApp(reopenedEngine, undefined, {
        operators: [{ key: OPERATOR_KEY, ownerOrg: 'org-pilot-step16' }],
        allowSimulation: false,
        upstream: async () => ({ status: 200, body: {} }),
      });
      const reopenedOperator = new ShlitaOperatorClient({
        operatorKey: OPERATOR_KEY,
        baseUrl: BASE_URL,
        fetch: adapter(reopenedApp),
      });

      const reopenedOps = await reopenedOperator.listOperations();
      if (allowedRes.outcome === 'committed') {
        const persisted = reopenedOps.operations.find((o) => o.operationId === allowedRes.operationId);
        expect(persisted).toBeDefined();
        expect(persisted?.state).toBe('ACCOUNTING_COMMITTED');
        expect(persisted?.reservedAmountMicroUsdc).toBe('10000');
      }

      const reopenedAgents = await reopenedOperator.listAgents();
      const persistedAgent = reopenedAgents.agents.find((a) => a.agentId === 'pilot-agent-mock');
      expect(persistedAgent?.status).toBe('AGENT_FROZEN');

      reopenedEngine.close();
    });
  });
});
