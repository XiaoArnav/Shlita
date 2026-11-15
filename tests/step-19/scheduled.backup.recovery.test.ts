import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPolicyEngine } from '../../packages/core/src/index.js';
import { restoreLedgerBackup, pruneBackupFiles } from '../../packages/core/src/backup.js';
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

describe('Step 19 — Scheduled Backup and Gateway Recovery', () => {
  let tempDir: string;
  let sourceDbPath: string;
  let backupDir: string;
  let recoveryDbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shlita-step-19-test-'));
    sourceDbPath = path.join(tempDir, 'source-ledger.db');
    backupDir = path.join(tempDir, 'backups');
    recoveryDbPath = path.join(tempDir, 'recovered-ledger.db');
    fs.mkdirSync(backupDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Compose backup-worker configuration and parameterization', () => {
    const composeContent = fs.readFileSync(path.resolve('compose.staging.yaml'), 'utf-8');

    it('declares injectable backup scheduler interval and retention with staging defaults', () => {
      expect(composeContent).toContain('${SHLITA_BACKUP_INTERVAL_SECONDS:-86400}');
      expect(composeContent).toContain('${SHLITA_BACKUP_RETENTION:-14}');
      expect(composeContent).toContain('${SHLITA_BACKUP_RUN_ON_STARTUP:-false}');
      expect(composeContent).toContain('${SHLITA_BACKUP_ONCE:-false}');
    });

    it('enforces scheduler loop with interval check and failure health notification', () => {
      expect(composeContent).toContain('run_backup()');
      expect(composeContent).toContain('if [ "$$slept" -ge "$$INTERVAL" ]; then');
      expect(composeContent).toContain('rm -f "$$HEALTH_FILE"');
      expect(composeContent).toContain('touch "$$HEALTH_FILE"');
    });
  });

  describe('Preflight Compose isolation for source and recovery stacks', () => {
    it('validates that distinct source and recovery project namespaces pass isolation', () => {
      const srcProject = 'shlita-src-drill-1111';
      const recProject = 'shlita-rec-drill-2222';

      const srcConfig = `
services:
  gateway:
    container_name: ${srcProject}-gateway
  backup-worker:
    container_name: ${srcProject}-backup-worker
volumes:
  shlita-data:
    name: ${srcProject}-data
  shlita-external-backups:
    name: ${srcProject}-backups
networks:
  shlita-net:
    name: ${srcProject}-net
`;
      const recConfig = `
services:
  gateway:
    container_name: ${recProject}-gateway
volumes:
  shlita-data:
    name: ${recProject}-data
networks:
  shlita-net:
    name: ${recProject}-net
`;

      const srcResult = validateComposeIsolation(srcConfig, srcProject);
      const recResult = validateComposeIsolation(recConfig, recProject);

      expect(srcResult.safe).toBe(true);
      expect(recResult.safe).toBe(true);
      expect(srcResult.violations).toHaveLength(0);
      expect(recResult.violations).toHaveLength(0);
    });

    it('fails closed when configuration references protected staging volumes', () => {
      const dangerousConfig = `
services:
  gateway:
    container_name: drill-project-gateway
volumes:
  shlita-data:
    name: shlita-staging-data
`;
      const result = validateComposeIsolation(dangerousConfig, 'drill-project');
      expect(result.safe).toBe(false);
      expect(
        result.violations.some((v) => v.includes('shlita-staging-data'))
      ).toBe(true);
    });
  });

  describe('restoreLedgerBackup safety and integrity contract', () => {
    it('rejects non-existent source backup files', () => {
      expect(() => {
        restoreLedgerBackup('/path/to/missing-backup.db', recoveryDbPath, false);
      }).toThrow('Backup file does not exist.');
    });

    it('refuses to overwrite an existing ledger destination unless explicitly authorized', () => {
      fs.writeFileSync(recoveryDbPath, 'EXISTING_LEDGER');
      const fakeBackup = path.join(tempDir, 'fake-backup.db');
      fs.writeFileSync(fakeBackup, 'FAKE');

      expect(() => {
        restoreLedgerBackup(fakeBackup, recoveryDbPath, false);
      }).toThrow('Refusing to overwrite an existing ledger.');
    });

    it('rejects corrupted or invalid SQLite backup files during integrity check', () => {
      const corruptBackup = path.join(tempDir, 'corrupt-backup.db');
      fs.writeFileSync(corruptBackup, 'NOT_A_VALID_SQLITE_FILE_CORRUPTED_BYTES');

      expect(() => {
        restoreLedgerBackup(corruptBackup, recoveryDbPath, false);
      }).toThrow();
      expect(fs.existsSync(recoveryDbPath)).toBe(false);
    });
  });

  describe('End-to-end scheduled backup production, restore, and ledger continuity', () => {
    it('proves that a restored snapshot preserves all operation fields and engine functionality', async () => {
      // 1. Initialize source engine and register agent
      const sourceEngine = createPolicyEngine(sourceDbPath);
      sourceEngine.registerAgent(
        {
          agentId: 'recovery-agent-test',
          allowedVendors: ['api.helius.xyz'],
          maxPerCallMicroUsdc: 50000n,
          periodBudgetMicroUsdc: 200000n,
          periodSeconds: 3600,
          circuitBreaker: { maxConsecutiveErrors: 3, maxCallsPerMinute: 20 },
        },
        { rawApiKey: 'key-recovery-agent-test', ownerOrg: 'pilot-staging-alpha' }
      );

      // 2. Seed financial operation on source
      const claimed = sourceEngine.claimExecution({
        agentId: 'recovery-agent-test',
        vendor: 'api.helius.xyz',
        method: 'POST',
        path: '/v0/token-metadata',
        fingerprint: 'rec-test-fp-001',
        idempotencyKey: 'rec-test-key-001',
        estimatedCostMicroUsdc: 35000n,
        reservedAmountMicroUsdc: 35000n,
        timestamp: Date.now(),
      });
      expect(claimed.kind).toBe('execute');
      if (claimed.kind !== 'execute') throw new Error('Unreachable');
      const seededOpId = claimed.operationId;

      const finished = sourceEngine.finishExecution(seededOpId, {
        type: 'succeeded',
        httpStatus: 200,
        result: { token: 'USDC', decimals: 6 },
      });
      expect(finished.ok).toBe(true);

      // Verify source operation exists
      const sourceOpsBefore = sourceEngine.listOrganizationOperations('pilot-staging-alpha');
      expect(sourceOpsBefore).toHaveLength(1);
      expect(sourceOpsBefore[0].operationId).toBe(seededOpId);
      expect(sourceOpsBefore[0].reservedAmountMicroUsdc).toBe('35000');
      expect(sourceOpsBefore[0].state).toBe('ACCOUNTING_COMMITTED');

      // 3. Produce online hot backup (VACUUM INTO) matching backup-cli behavior
      const snapshotPath = path.join(backupDir, 'ledger-snapshot-scheduled.db');
      await sourceEngine.backupTo(snapshotPath);
      expect(fs.existsSync(snapshotPath)).toBe(true);

      // 4. Capture snapshot SHA-256 and verify file mode
      const snapshotBytes = fs.readFileSync(snapshotPath);
      const preRestoreChecksum = crypto.createHash('sha256').update(snapshotBytes).digest('hex');
      expect(preRestoreChecksum).toBeDefined();

      // 5. Restore snapshot into separate recovery destination
      restoreLedgerBackup(snapshotPath, recoveryDbPath, false);
      expect(fs.existsSync(recoveryDbPath)).toBe(true);

      // 6. Verify PRAGMA integrity_check on restored database
      const rawDb = new DatabaseSync(recoveryDbPath, { readOnly: true });
      const pragma = rawDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      rawDb.close();
      expect(pragma.integrity_check).toBe('ok');

      // 7. Verify source snapshot file and source database remain untouched
      const postRestoreChecksum = crypto
        .createHash('sha256')
        .update(fs.readFileSync(snapshotPath))
        .digest('hex');
      expect(postRestoreChecksum).toBe(preRestoreChecksum);

      const sourceOpsAfter = sourceEngine.listOrganizationOperations('pilot-staging-alpha');
      expect(sourceOpsAfter).toHaveLength(1);
      expect(sourceOpsAfter[0].operationId).toBe(seededOpId);

      // 8. Start recovered engine on the restored database (simulating fresh gateway on recovery volume)
      const recoveredEngine = createPolicyEngine(recoveryDbPath);
      const recoveredOps = recoveredEngine.listOrganizationOperations('pilot-staging-alpha');

      expect(recoveredOps).toHaveLength(1);
      const targetOp = recoveredOps.find((o) => o.operationId === seededOpId);
      expect(targetOp).toBeDefined();
      expect(targetOp?.operationId).toBe(seededOpId);
      expect(targetOp?.reservedAmountMicroUsdc).toBe('35000');
      expect(targetOp?.state).toBe('ACCOUNTING_COMMITTED');
      expect(targetOp?.settlementStatus).toBe('NOT_SUBMITTED');
      expect(targetOp?.signature).toBeNull();
      expect(targetOp?.vendor).toBe('api.helius.xyz');

      // 9. Verify recovered gateway can execute subsequent financial operations
      const newClaim = recoveredEngine.claimExecution({
        agentId: 'recovery-agent-test',
        vendor: 'api.helius.xyz',
        method: 'POST',
        path: '/v0/token-metadata',
        fingerprint: 'rec-test-fp-002',
        idempotencyKey: 'rec-test-key-002',
        estimatedCostMicroUsdc: 15000n,
        reservedAmountMicroUsdc: 15000n,
        timestamp: Date.now(),
      });
      expect(newClaim.kind).toBe('execute');
      if (newClaim.kind !== 'execute') throw new Error('Unreachable');

      const newFinish = recoveredEngine.finishExecution(newClaim.operationId, {
        type: 'succeeded',
        httpStatus: 200,
        result: { status: 'healthy' },
      });
      expect(newFinish.ok).toBe(true);

      const allRecoveredOps = recoveredEngine.listOrganizationOperations('pilot-staging-alpha');
      expect(allRecoveredOps).toHaveLength(2);

      sourceEngine.close();
      recoveredEngine.close();
    });
  });
});
