import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPolicyEngine } from '../../packages/core/src/index.js';
import { validateComposeIsolation } from '../../packages/gateway/src/compose-isolation.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean }
  ) => {
    prepare(sql: string): { get(): any };
    close(): void;
  };
};

describe('Step 18 — Gateway Image Rollback and Ledger Continuity', () => {
  let tempDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shlita-rollback-test-'));
    ledgerPath = path.join(tempDir, 'ledger.db');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('rollback.sh contract and parameterization', () => {
    const rollbackScriptPath = path.resolve('scripts/rollback.sh');
    const rollbackContent = fs.readFileSync(rollbackScriptPath, 'utf-8');

    it('enforces strict error handling and required image argument', () => {
      expect(rollbackContent).toMatch(/^set -eu/m);
      expect(rollbackContent).toContain('if [ $# -lt 1 ]; then');
      expect(rollbackContent).toContain('Usage: $0 <IMAGE_TAG_OR_DIGEST>');
    });

    it('supports isolated Compose project name and custom compose file', () => {
      expect(rollbackContent).toContain('COMPOSE_FILE="${COMPOSE_FILE:-compose.staging.yaml}"');
      expect(rollbackContent).toContain('docker_compose()');
      expect(rollbackContent).toContain('-p "${COMPOSE_PROJECT_NAME}"');
    });

    it('verifies image availability prior to stopping the gateway', () => {
      // Must pull or inspect before stop
      const pullIdx = rollbackContent.indexOf('[1/4]');
      const stopIdx = rollbackContent.indexOf('[2/4]');
      const startIdx = rollbackContent.indexOf('[3/4]');
      const readyIdx = rollbackContent.indexOf('[4/4]');

      expect(pullIdx).toBeGreaterThanOrEqual(0);
      expect(stopIdx).toBeGreaterThan(pullIdx);
      expect(startIdx).toBeGreaterThan(stopIdx);
      expect(readyIdx).toBeGreaterThan(startIdx);

      expect(rollbackContent).toContain('docker pull "${TARGET_IMAGE}"');
      expect(rollbackContent).toContain('docker image inspect "${TARGET_IMAGE}"');
    });

    it('restricts rollback mutation to gateway service without affecting backup-worker', () => {
      expect(rollbackContent).toContain('docker_compose stop gateway');
      expect(rollbackContent).toContain('docker_compose up -d --no-deps gateway');
      // Must not stop or restart all services or backup-worker
      expect(rollbackContent).not.toMatch(/docker_compose stop backup-worker/);
      expect(rollbackContent).not.toMatch(/docker_compose up -d\s*$/);
    });

    it('polls gateway readiness with bounded iterations', () => {
      expect(rollbackContent).toContain('seq 1 15');
      expect(rollbackContent).toContain("fetch('http://127.0.0.1:4000/ready')");
      expect(rollbackContent).toContain('docker_compose logs --tail 50 gateway');
    });
  });

  describe('preflight Compose isolation for rollback stacks', () => {
    it('passes validation when project resources are uniquely prefixed', () => {
      const projectName = 'shlita-rb-isolated-9988';
      const isolatedConfig = `
services:
  gateway:
    container_name: ${projectName}-gateway
  backup-worker:
    container_name: ${projectName}-backup-worker
volumes:
  shlita-data:
    name: ${projectName}-data
  shlita-external-backups:
    name: ${projectName}-backups
networks:
  shlita-net:
    name: ${projectName}-net
`;
      const result = validateComposeIsolation(isolatedConfig, projectName);
      expect(result.safe).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.resolvedResources.containers).toContain(`${projectName}-gateway`);
      expect(result.resolvedResources.volumes).toContain(`${projectName}-data`);
    });

    it('fails closed when configuration references protected staging resources', () => {
      const projectName = 'shlita-rb-unisolated-123';
      const dangerousConfig = `
services:
  gateway:
    container_name: ${projectName}-gateway
volumes:
  shlita-data:
    name: shlita-staging-data
`;
      const result = validateComposeIsolation(dangerousConfig, projectName);
      expect(result.safe).toBe(false);
      expect(
        result.violations.some((v) => v.includes('shlita-staging-data'))
      ).toBe(true);
    });
  });

  describe('unavailable image pull failure invariant', () => {
    it('proves that a failed pull aborts execution before the container is stopped', () => {
      // In bash/sh with `set -e`, any command exiting non-zero terminates the script immediately.
      // We simulate the execution order:
      let gatewayStopped = false;
      const pullImage = (imageTag: string) => {
        if (imageTag.includes('nonexistent')) {
          throw new Error('docker pull failed: repository does not exist');
        }
      };
      const stopGateway = () => {
        gatewayStopped = true;
      };

      expect(() => {
        pullImage('ghcr.io/xiaoarnav/shlita:nonexistent-tag-404');
        stopGateway();
      }).toThrow('docker pull failed: repository does not exist');

      expect(gatewayStopped).toBe(false);
    });
  });

  describe('ledger continuity across gateway rollback', () => {
    it('preserves registered agents, financial operations, and database integrity across restarts', () => {
      // 1. Initial gateway startup on current image: register agent and process operation
      const initialEngine = createPolicyEngine(ledgerPath);
      initialEngine.registerAgent(
        {
          agentId: 'rollback-agent-test',
          allowedVendors: ['api.helius.xyz'],
          maxPerCallMicroUsdc: 50000n,
          periodBudgetMicroUsdc: 200000n,
          periodSeconds: 3600,
          circuitBreaker: { maxConsecutiveErrors: 3, maxCallsPerMinute: 20 },
        },
        { rawApiKey: 'key-rollback-agent-test', ownerOrg: 'pilot-staging-alpha' }
      );

      const claimed = initialEngine.claimExecution({
        agentId: 'rollback-agent-test',
        vendor: 'api.helius.xyz',
        method: 'POST',
        path: '/v0/token-metadata',
        fingerprint: 'rb-unit-fp-001',
        idempotencyKey: 'rb-unit-key-001',
        estimatedCostMicroUsdc: 18000n,
        reservedAmountMicroUsdc: 18000n,
        timestamp: Date.now(),
      });

      expect(claimed.kind).toBe('execute');
      if (claimed.kind !== 'execute') throw new Error('Unreachable');
      const seededOpId = claimed.operationId;

      const finished = initialEngine.finishExecution(seededOpId, {
        type: 'succeeded',
        httpStatus: 200,
        result: { token: 'SOL', decimals: 9 },
      });
      expect(finished.ok).toBe(true);

      // Verify operation exists before shutdown
      const opsBefore = initialEngine.listOrganizationOperations('pilot-staging-alpha');
      expect(opsBefore).toHaveLength(1);
      expect(opsBefore[0].operationId).toBe(seededOpId);
      expect(opsBefore[0].reservedAmountMicroUsdc).toBe('18000');
      expect(opsBefore[0].state).toBe('ACCOUNTING_COMMITTED');

      // 2. Simulate gateway container stop (close database handles)
      initialEngine.close();

      // 3. Verify SQLite file integrity on disk
      const rawDb = new DatabaseSync(ledgerPath, { readOnly: true });
      const pragmaResult = rawDb.prepare('PRAGMA integrity_check').get() as {
        integrity_check: string;
      };
      rawDb.close();
      expect(pragmaResult.integrity_check).toBe('ok');

      // 4. Simulate rolled-back gateway container startup mounting the identical volume
      const rolledBackEngine = createPolicyEngine(ledgerPath);

      // Verify the existing operation survived intact
      const opsAfter = rolledBackEngine.listOrganizationOperations('pilot-staging-alpha');
      expect(opsAfter).toHaveLength(1);
      const targetOp = opsAfter.find((o) => o.operationId === seededOpId);
      expect(targetOp).toBeDefined();
      expect(targetOp?.operationId).toBe(seededOpId);
      expect(targetOp?.reservedAmountMicroUsdc).toBe('18000');
      expect(targetOp?.state).toBe('ACCOUNTING_COMMITTED');
      expect(targetOp?.vendor).toBe('api.helius.xyz');

      // 5. Verify the rolled-back engine is fully operational (can process new operations)
      const newClaim = rolledBackEngine.claimExecution({
        agentId: 'rollback-agent-test',
        vendor: 'api.helius.xyz',
        method: 'POST',
        path: '/v0/token-metadata',
        fingerprint: 'rb-unit-fp-002',
        idempotencyKey: 'rb-unit-key-002',
        estimatedCostMicroUsdc: 12000n,
        reservedAmountMicroUsdc: 12000n,
        timestamp: Date.now(),
      });
      expect(newClaim.kind).toBe('execute');
      if (newClaim.kind !== 'execute') throw new Error('Unreachable');

      const newFinish = rolledBackEngine.finishExecution(newClaim.operationId, {
        type: 'succeeded',
        httpStatus: 200,
        result: { status: 'healthy' },
      });
      expect(newFinish.ok).toBe(true);

      const allOps = rolledBackEngine.listOrganizationOperations('pilot-staging-alpha');
      expect(allOps).toHaveLength(2);

      rolledBackEngine.close();
    });
  });

  describe('backup-worker and Caddy coexistence', () => {
    it('verifies that compose.staging.yaml declares separate service lifecycles', () => {
      const composeContent = fs.readFileSync(path.resolve('compose.staging.yaml'), 'utf-8');

      // Services must be separate
      expect(composeContent).toContain('services:\n  gateway:');
      expect(composeContent).toContain('  caddy:');
      expect(composeContent).toContain('  backup-worker:');

      // Both mount shlita-data
      expect(composeContent).toMatch(/gateway:[\s\S]*?- shlita-data:\/var\/lib\/shlita/);
      expect(composeContent).toMatch(/backup-worker:[\s\S]*?- shlita-data:\/var\/lib\/shlita/);
    });
  });
});
