import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';

const execAsync = promisify(exec);

describe('Step 23 — Live Staging Acceptance and Pilot Go/No-Go Decision', () => {
  const stagingReportPath = path.resolve('docs/step-12/STAGING_VERIFICATION.md');
  const composePath = path.resolve('compose.staging.yaml');
  const caddyPath = path.resolve('Caddyfile');

  describe('Staging image and Compose configuration invariants', () => {
    it('verifies compose.staging.yaml pins single-instance persistent volume and parameterized staging image', () => {
      const compose = fs.readFileSync(composePath, 'utf-8');

      // Image declaration
      expect(compose).toContain('image: ${SHLITA_IMAGE:-ghcr.io/xiaoarnav/shlita:staging}');

      // Single-instance SQLite volumes
      expect(compose).toContain('- shlita-data:/var/lib/shlita');
      expect(compose).toContain('- shlita-external-backups:/var/backups/shlita-external');
      expect(compose).toContain('SHLITA_DB_PATH: /var/lib/shlita/ledger.db');
      expect(compose).toContain('SHLITA_STATE_DIR: /var/lib/shlita');

      // Port bindings and origin
      expect(compose).toContain('SHLITA_PUBLIC_ORIGIN: ${SHLITA_PUBLIC_ORIGIN:-https://gateway.staging.shlita.xyz}');
      expect(compose).toContain('SHLITA_STAGING_DOMAIN: ${SHLITA_STAGING_DOMAIN:-gateway.staging.shlita.xyz}');
    });

    it('verifies Caddyfile configures public health/ready/metrics exceptions and forwarded proxy headers', () => {
      const caddy = fs.readFileSync(caddyPath, 'utf-8');
      expect(caddy).toContain('{$SHLITA_STAGING_DOMAIN:gateway.staging.shlita.xyz}');
      expect(caddy).toContain('@public_probe path /health /ready /metrics');
      expect(caddy).toContain('reverse_proxy gateway:4000');
      expect(caddy).toContain('header_up Host {host}');
      expect(caddy).toContain('header_up X-Real-IP {remote_host}');
      expect(caddy).toContain('header_up X-Forwarded-For {remote_host}');
      expect(caddy).toContain('header_up X-Forwarded-Proto {scheme}');
    });
  });

  describe('Independent preflight check and live probe execution', () => {
    it('executes verify-live-staging.sh and reports all 4 live checks as BLOCKED with specific blocker IDs', async () => {
      const { stdout } = await execAsync(
        './scripts/verify-live-staging.sh --check-only',
        { timeout: 10000, encoding: 'utf-8' }
      );

      // Verify the 4 acceptance check IDs are reported as BLOCKED
      expect(stdout).toContain('LIVE-HTTPS-01 (Public TLS & /ready HTTP 200)       : BLOCKED');
      expect(stdout).toContain('LIVE-PERSIST-01 (Ledger Persistence Post-Redeploy) : BLOCKED');
      expect(stdout).toContain('LIVE-ALERT-01 (Outage & Recovery Notifications)    : BLOCKED');
      expect(stdout).toContain('LIVE-RESTORE-01 (Worker Snapshot Restore on Host)  : BLOCKED');

      // Verify specific blockers and owners are attributed
      expect(stdout).toContain('Blocker: BLOCKER-DNS-01 (Public DNS delegation missing)');
      expect(stdout).toContain('Blocker: BLOCKER-HOST-01 (Cloud host unprovisioned)');
      expect(stdout).toContain('Blocker: BLOCKER-SECRET-01 (Staging alert destination webhook not configured)');
      expect(stdout).toContain('Required Owner: Maintainer (XiaoArnav)');
    });

    it('probes live staging endpoint from outside and observes host resolution failure (NXDOMAIN / HTTP 000)', async () => {
      const probeCmd = `curl --silent --show-error --fail --connect-timeout 2 --max-time 5 --write-out '\\nHTTP %{http_code}\\n' https://gateway.staging.shlita.xyz/ready || true`;
      const { stdout, stderr } = await execAsync(probeCmd, { timeout: 10000, encoding: 'utf-8' });
      const combined = stdout + stderr;

      expect(combined).toMatch(/HTTP 000|Could not resolve host|Failed to connect/);
    });
  });

  describe('Staging verification report audit (STAGING_VERIFICATION.md)', () => {
    it('documents Step 23 execution, candidate metadata, and four live check statuses', () => {
      expect(fs.existsSync(stagingReportPath)).toBe(true);
      const report = fs.readFileSync(stagingReportPath, 'utf-8');

      // Milestone and commits
      expect(report).toContain('Step 23 (Live Staging Acceptance and Pilot Go/No-Go)');
      expect(report).toContain('2e97bba81084b6ce65803e2d5fcc7662220d5cac');
      expect(report).toContain('ghcr.io/xiaoarnav/shlita@sha256:ab7c7f83e80a5aeac79c33fe602d805adc43f139cd64dfbeea94bdfa4f15c175');

      // Four checks
      expect(report).toContain('LIVE-HTTPS-01');
      expect(report).toContain('LIVE-PERSIST-01');
      expect(report).toContain('LIVE-ALERT-01');
      expect(report).toContain('LIVE-RESTORE-01');

      // Blocker references
      expect(report).toContain('BLOCKER-HOST-01');
      expect(report).toContain('BLOCKER-DNS-01');
      expect(report).toContain('BLOCKER-SECRET-01');

      // Pilot decision
      expect(report).toContain('DECISION: NO-GO FOR IMMEDIATE LIVE TRAFFIC');
      expect(report).toContain('CONDITIONAL GO PENDING HOST PROVISIONING & DNS DELEGATION');
    });

    it('verifies all internal relative markdown links in STAGING_VERIFICATION.md resolve to existing files', () => {
      const report = fs.readFileSync(stagingReportPath, 'utf-8');
      const docDir = path.dirname(stagingReportPath);

      // Match all [text](path) where path does not start with http or #
      const linkRegex = /\[([^\]]+)\]\(([^)#]+)(?:#[^)]*)?\)/g;
      let match: RegExpExecArray | null;
      const checkedLinks: string[] = [];

      while ((match = linkRegex.exec(report)) !== null) {
        const linkTarget = match[2];
        if (linkTarget.startsWith('http://') || linkTarget.startsWith('https://')) {
          continue;
        }
        const resolvedTarget = path.resolve(docDir, linkTarget);
        expect(fs.existsSync(resolvedTarget), `Target does not exist: ${linkTarget} -> ${resolvedTarget}`).toBe(true);
        checkedLinks.push(linkTarget);
      }

      expect(checkedLinks.length).toBeGreaterThan(0);
    });
  });
});
