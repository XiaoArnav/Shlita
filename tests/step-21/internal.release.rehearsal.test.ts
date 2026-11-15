import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';

const execAsync = promisify(exec);

describe('Step 21 — Internal Release Rehearsal and Pilot Handoff', () => {
  const sdkPkgPath = path.resolve('packages/sdk/package.json');
  const sdkPkg = JSON.parse(fs.readFileSync(sdkPkgPath, 'utf-8'));
  const reportPath = path.resolve('docs/step-21/INTERNAL_RELEASE_REHEARSAL.md');

  describe('SDK archive packaging invariants', () => {
    it('declares exact package version, node engine constraint, and exported entrypoints', () => {
      expect(sdkPkg.name).toBe('shlita-sdk');
      expect(sdkPkg.version).toBe('0.1.0');
      expect(sdkPkg.engines?.node).toBe('>=22');
      expect(sdkPkg.main).toBe('./dist/index.js');
      expect(sdkPkg.types).toBe('./dist/index.d.ts');
      expect(sdkPkg.exports?.['.']?.import).toBe('./dist/index.js');
      expect(sdkPkg.exports?.['.']?.types).toBe('./dist/index.d.ts');
      expect(sdkPkg.files).toEqual(['dist', 'README.md']);
    });

    it('builds SDK TypeScript bundle with all required distribution artifacts', () => {
      const distDir = path.resolve('packages/sdk/dist');
      expect(fs.existsSync(path.join(distDir, 'index.js'))).toBe(true);
      expect(fs.existsSync(path.join(distDir, 'index.d.ts'))).toBe(true);
      expect(fs.existsSync(path.join(distDir, 'client.js'))).toBe(true);
      expect(fs.existsSync(path.join(distDir, 'client.d.ts'))).toBe(true);
      expect(fs.existsSync(path.join(distDir, 'errors.js'))).toBe(true);
      expect(fs.existsSync(path.join(distDir, 'errors.d.ts'))).toBe(true);
      expect(fs.existsSync(path.join(distDir, 'types.js'))).toBe(true);
      expect(fs.existsSync(path.join(distDir, 'types.d.ts'))).toBe(true);
    });

    it('exports all public client and error classes from index.js', async () => {
      const sdkIndex = await import('../../packages/sdk/dist/index.js');
      expect(typeof sdkIndex.ShlitaAgentClient).toBe('function');
      expect(typeof sdkIndex.ShlitaOperatorClient).toBe('function');
      expect(typeof sdkIndex.ShlitaApiError).toBe('function');
      expect(typeof sdkIndex.ShlitaClientError).toBe('function');
      expect(typeof sdkIndex.ShlitaUncertainError).toBe('function');
    });
  });

  describe('Gemini reference agent reproduction', () => {
    it('executes run.mjs in fixture mode and reproduces both allowed and denied outcomes', async () => {
      const { stdout } = await execAsync('node examples/gemini-reference-agent/run.mjs', {
        timeout: 10000,
        encoding: 'utf-8',
      });

      // Allowed scenario
      expect(stdout).toContain('--- [SCENARIO 1: ALLOWED OPERATION] ---');
      expect(stdout).toContain('"outcome": "committed"');
      expect(stdout).toContain('"reservedAmountMicroUsdc": "10000"');
      expect(stdout).toContain('Call APPROVED. Reserved 10000 micro-USDC');

      // Denied scenario
      expect(stdout).toContain('--- [SCENARIO 2: POLICY-DENIED OPERATION] ---');
      expect(stdout).toContain('"outcome": "rejected"');
      expect(stdout).toContain('"reason": "UNAPPROVED_VENDOR"');
      expect(stdout).toContain('Call BLOCKED by Shlita policy perimeter (UNAPPROVED_VENDOR)');

      // Ledger audit
      expect(stdout).toContain('Total Operations Recorded in Ledger: 1');
      expect(stdout).toContain('State             : ACCOUNTING_COMMITTED');
      expect(stdout).toContain('Settlement Status : NOT_SUBMITTED');
      expect(stdout).toContain('Signature         : null (unsettled hold)');
      expect(stdout).toContain('DEMO SUMMARY: ALL CHECKS PASSED');
    });
  });

  describe('Step 21 handoff report verification', () => {
    it('contains all required release candidate, reproduction, and verdict sections', () => {
      expect(fs.existsSync(reportPath)).toBe(true);
      const report = fs.readFileSync(reportPath, 'utf-8');

      // Candidate metadata
      expect(report).toContain('Candidate Commit SHA:');
      expect(report).toContain('Node.js `>=22.0.0`');
      expect(report).toContain('shlita-sdk-0.1.0.tgz');
      expect(report).toContain('4abcee6076ae815ca286205f1bf430bdbce69d708ff8f73d2c97bfc0f5ca67d6');

      // Verdict separation
      expect(report).toContain('Internal Release Verdict: **`READY`**');
      expect(report).toContain('External Controlled Pilot Verdict:');
      expect(report).toContain('NO-GO');

      // Reproduction guide
      expect(report).toContain('git clone https://github.com/XiaoArnav/Shlita.git');
      expect(report).toContain('npm pack --pack-destination');
      expect(report).toContain('node scripts/sdk-consumer-check.mjs');
      expect(report).toContain('node examples/gemini-reference-agent/run.mjs');

      // External pilot blockers
      expect(report).toContain('BLOCKER-HOST-01');
      expect(report).toContain('BLOCKER-DNS-01');
      expect(report).toContain('BLOCKER-SECRET-01');
      expect(report).toContain('Arnav Patel (`XiaoArnav`)');
    });
  });
});
