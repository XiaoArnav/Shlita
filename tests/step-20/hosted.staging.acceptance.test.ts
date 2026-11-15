import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';

const execAsync = promisify(exec);

describe('Step 20 — Hosted Staging Acceptance and Pilot Readiness', () => {
  const composePath = path.resolve('compose.staging.yaml');
  const caddyfilePath = path.resolve('Caddyfile');
  const composeContent = fs.readFileSync(composePath, 'utf-8');
  const caddyfileContent = fs.readFileSync(caddyfilePath, 'utf-8');

  describe('Pinned staging image and Compose service resolution', () => {
    it('uses parameterized image default to ghcr.io/xiaoarnav/shlita:staging for both gateway and worker', () => {
      // Both gateway and backup-worker services must resolve to the same image parameter
      const imageDecl = '${SHLITA_IMAGE:-ghcr.io/xiaoarnav/shlita:staging}';
      expect(composeContent).toContain(`image: ${imageDecl}`);
      
      // Confirm backup-worker specifies image or inherits the same image parameter
      const workerSection = composeContent.split('backup-worker:')[1];
      expect(workerSection).toBeDefined();
      expect(workerSection).toContain(`image: ${imageDecl}`);
    });

    it('enforces single-writer SQLite storage and dedicated volume mounts', () => {
      // Gateway mounts persistent volume
      expect(composeContent).toContain('- shlita-data:/var/lib/shlita');
      expect(composeContent).toContain('- shlita-external-backups:/var/backups/shlita-external');

      // Database path is non-memory persistent SQLite file
      expect(composeContent).toContain('SHLITA_DB_PATH: /var/lib/shlita/ledger.db');
      expect(composeContent).toContain('SHLITA_STATE_DIR: /var/lib/shlita');
      expect(composeContent).toContain('SHLITA_BACKUP_DIR: /var/lib/shlita/backups');
    });

    it('pins public staging domain and trusted proxy network parameters', () => {
      expect(composeContent).toContain(
        'SHLITA_PUBLIC_ORIGIN: ${SHLITA_PUBLIC_ORIGIN:-https://gateway.staging.shlita.xyz}'
      );
      expect(composeContent).toContain(
        'SHLITA_TRUSTED_PROXIES: "127.0.0.1,::1,172.16.0.0/12,10.0.0.0/8"'
      );
      expect(composeContent).toContain(
        'SHLITA_STAGING_DOMAIN: ${SHLITA_STAGING_DOMAIN:-gateway.staging.shlita.xyz}'
      );
    });
  });

  describe('Caddy ingress reverse proxy configuration', () => {
    it('declares staging domain with public probe exception and forwarded headers', () => {
      expect(caddyfileContent).toContain('{$SHLITA_STAGING_DOMAIN:gateway.staging.shlita.xyz}');
      expect(caddyfileContent).toContain('@public_probe path /health /ready /metrics');
      expect(caddyfileContent).toContain('reverse_proxy gateway:4000');
      expect(caddyfileContent).toContain('header_up Host {host}');
      expect(caddyfileContent).toContain('header_up X-Real-IP {remote_host}');
      expect(caddyfileContent).toContain('header_up X-Forwarded-For {remote_host}');
      expect(caddyfileContent).toContain('header_up X-Forwarded-Proto {scheme}');
    });

    it('binds public ports 80 and 443 with read-only Caddyfile mount', () => {
      expect(composeContent).toContain('- "80:80"');
      expect(composeContent).toContain('- "443:443"');
      expect(composeContent).toContain('- ./Caddyfile:/etc/caddy/Caddyfile:ro');
    });
  });

  describe('Live acceptance probe execution and blocker classification', () => {
    it('executes verify-live-staging.sh and reports all 4 live checks as BLOCKED with specific blockers', async () => {
      const { stdout } = await execAsync(
        './scripts/verify-live-staging.sh --check-only --dns-status nxdomain',
        { timeout: 5000, encoding: 'utf-8' }
      );

      // Verify the 4 acceptance check IDs are reported
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

    it('executes bounded probe command against staging endpoint and captures host resolution failure', async () => {
      // Execute the exact probe specified in Phase 2 A
      const probeCmd = `curl --silent --show-error --fail --connect-timeout 2 --max-time 5 --write-out '\\nHTTP %{http_code}\\n' https://gateway.staging.shlita.xyz/ready || true`;
      const { stdout, stderr } = await execAsync(probeCmd, { timeout: 10000, encoding: 'utf-8' });
      const combined = stdout + stderr;

      // Unprovisioned host must return HTTP 000 and indicate host resolution or connection failure
      expect(combined).toMatch(/HTTP 000|Could not resolve host|Failed to connect/);
    });
  });

  describe('Controlled developer pilot criteria validation', () => {
    const runbookContent = fs.readFileSync(path.resolve('docs/step-9/PILOT_RUNBOOK.md'), 'utf-8');
    const goNoGoContent = fs.readFileSync(path.resolve('docs/step-10/PILOT_GO_NO_GO.md'), 'utf-8');

    it('documents pilot criteria and required staging environment variables', () => {
      expect(runbookContent).toContain('SHLITA_OPERATOR_KEY');
      expect(runbookContent).toContain('SHLITA_OPERATOR_ORG');
      expect(runbookContent).toContain('SHLITA_DB_PATH');
      expect(runbookContent).toContain('SHLITA_ALLOW_SIMULATION=false');
    });

    it('records Tier B pilot conditions in PILOT_GO_NO_GO.md', () => {
      expect(goNoGoContent).toContain('Tier B: Controlled Developer Pilot');
      expect(goNoGoContent).toContain('DECISION: CONDITIONAL GO');
      expect(goNoGoContent).toContain('Provision Single Staging VM');
      expect(goNoGoContent).toContain('Configure Public TLS Domain');
      expect(goNoGoContent).toContain('Enforce Single-Instance Constraint');
      expect(goNoGoContent).toContain('Deploy Telemetry Forwarder');
      expect(goNoGoContent).toContain('Issue Sandboxed Partner Credentials');
    });
  });
});
