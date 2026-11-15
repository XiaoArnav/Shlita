import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ReadinessMonitor } from '../../scripts/readiness-monitor.mjs';

const exec = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');

describe('Step 17 — Local Outage and Recovery Alert Rehearsal', () => {
  describe('Full Subprocess Outage and Recovery Drill', () => {
    it('executes real gateway lifecycle, mock webhook receiver, outage detection, suppression, recovery, and cleanup', async () => {
      const { stdout } = await exec(process.execPath, ['scripts/alert-rehearsal.mjs'], {
        cwd: root,
        timeout: 60_000,
        maxBuffer: 2_000_000,
      });

      const report = JSON.parse(stdout.trim());
      expect(report.rehearsal).toBe('SUCCESS');
      expect(report.scenarios.healthyBaseline.status).toBe('PASS');
      expect(report.scenarios.healthyBaseline.notificationsReceived).toBe(0);

      expect(report.scenarios.briefInterruption.status).toBe('PASS');
      expect(report.scenarios.briefInterruption.state).toBe('DEGRADED');
      expect(report.scenarios.briefInterruption.notificationsReceived).toBe(0);

      expect(report.scenarios.sustainedOutage.status).toBe('PASS');
      expect(report.scenarios.sustainedOutage.outageAlertsReceived).toBe(1);
      expect(report.scenarios.sustainedOutage.suppressedAdditionalAlerts).toBeGreaterThanOrEqual(1);
      expect(report.scenarios.sustainedOutage.outagePayload.event).toBe('gateway_outage');

      expect(report.scenarios.recovery.status).toBe('PASS');
      expect(report.scenarios.recovery.recoveryAlertsReceived).toBe(1);
      expect(report.scenarios.recovery.gatewayStatusAfterRecovery).toBe('ready');
      expect(report.scenarios.recovery.recoveryPayload.event).toBe('gateway_recovered');
      expect(report.scenarios.recovery.recoveryPayload.incidentId).toBe(report.scenarios.sustainedOutage.outagePayload.incidentId);

      expect(report.scenarios.deliveryFailure.status).toBe('PASS');
      expect(report.scenarios.deliveryFailure.deliverySuccess).toBe(false);
      expect(report.scenarios.deliveryFailure.totalAttempts).toBe(3);

      expect(report.scenarios.cleanup.status).toBe('PASS');
    }, 60_000);
  });

  describe('Readiness Monitor State Machine & Delivery Invariants', () => {
    it('suppresses alerts on brief interruptions below threshold', async () => {
      const dispatched: any[] = [];
      let fail = true;

      const monitor = new ReadinessMonitor({
        targetUrl: 'http://127.0.0.1:9999',
        webhookUrl: 'http://127.0.0.1:8888/hook',
        failureThreshold: 3,
        fetchImpl: (async (input: any) => {
          const url = String(input);
          if (url.endsWith('/ready')) {
            if (fail) {
              fail = false;
              return new Response('503 Service Unavailable', { status: 503 });
            }
            return new Response(JSON.stringify({ status: 'ready' }), { status: 200 });
          }
          if (url.includes('/hook')) {
            dispatched.push(url);
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }
          return new Response('404 Not Found', { status: 404 });
        }) as typeof fetch,
        logger: () => {},
        errorLogger: () => {},
      });

      // Step 1: Failure 1 -> DEGRADED
      const s1 = await monitor.step();
      expect(s1.state).toBe('DEGRADED');
      expect(monitor.consecutiveFailures).toBe(1);
      expect(dispatched).toHaveLength(0);

      // Step 2: Recovers immediately on next probe -> HEALTHY
      const s2 = await monitor.step();
      expect(s2.state).toBe('HEALTHY');
      expect(monitor.consecutiveFailures).toBe(0);
      expect(dispatched).toHaveLength(0);
    });

    it('dispatches exactly one outage alert and suppresses duplicates during sustained outage', async () => {
      const dispatchedBodies: any[] = [];

      const monitor = new ReadinessMonitor({
        targetUrl: 'http://127.0.0.1:9999',
        webhookUrl: 'http://127.0.0.1:8888/hook',
        failureThreshold: 2,
        fetchImpl: (async (input: any, init?: any) => {
          const url = String(input);
          if (url.endsWith('/ready')) {
            return new Response('Connection Refused', { status: 503 });
          }
          if (url.includes('/hook')) {
            dispatchedBodies.push(JSON.parse(String(init?.body || '{}')));
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }
          return new Response('404 Not Found', { status: 404 });
        }) as typeof fetch,
        logger: () => {},
        errorLogger: () => {},
      });

      // Step 1: Failure 1 -> DEGRADED
      await monitor.step();
      expect(monitor.state).toBe('DEGRADED');
      expect(dispatchedBodies).toHaveLength(0);

      // Step 2: Failure 2 -> Threshold reached -> OUTAGE
      await monitor.step();
      expect(monitor.state).toBe('OUTAGE');
      expect(dispatchedBodies).toHaveLength(1);
      expect(dispatchedBodies[0].event).toBe('gateway_outage');

      // Steps 3, 4, 5: Sustained outage -> Zero duplicate outage alerts
      await monitor.step();
      await monitor.step();
      await monitor.step();
      expect(monitor.state).toBe('OUTAGE');
      expect(dispatchedBodies).toHaveLength(1); // Still strictly 1!
    });

    it('dispatches exactly one recovery alert and correlates with original incident ID', async () => {
      const dispatchedBodies: any[] = [];
      let isReady = false;

      const monitor = new ReadinessMonitor({
        targetUrl: 'http://127.0.0.1:9999',
        webhookUrl: 'http://127.0.0.1:8888/hook',
        failureThreshold: 1,
        recoveryThreshold: 1,
        fetchImpl: (async (input: any, init?: any) => {
          const url = String(input);
          if (url.endsWith('/ready')) {
            if (isReady) {
              return new Response(JSON.stringify({ status: 'ready' }), { status: 200 });
            }
            return new Response('503 Down', { status: 503 });
          }
          if (url.includes('/hook')) {
            dispatchedBodies.push(JSON.parse(String(init?.body || '{}')));
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }
          return new Response('404', { status: 404 });
        }) as typeof fetch,
        logger: () => {},
        errorLogger: () => {},
      });

      // Trigger outage
      await monitor.step();
      expect(monitor.state).toBe('OUTAGE');
      expect(dispatchedBodies).toHaveLength(1);
      expect(dispatchedBodies[0].event).toBe('gateway_outage');
      const incidentId = dispatchedBodies[0].incidentId;

      // Gateway recovers
      isReady = true;
      await monitor.step();
      expect(monitor.state).toBe('HEALTHY');
      expect(dispatchedBodies).toHaveLength(2);
      expect(dispatchedBodies[1].event).toBe('gateway_recovered');
      expect(dispatchedBodies[1].incidentId).toBe(incidentId);
      expect(dispatchedBodies[1].details.downtimeSeconds).toBeDefined();
    });

    it('performs bounded retry when webhook receiver returns 500 or times out', async () => {
      let attempts = 0;

      const monitor = new ReadinessMonitor({
        targetUrl: 'http://127.0.0.1:9999',
        webhookUrl: 'http://127.0.0.1:8888/hook-500',
        maxDeliveryRetries: 2,
        deliveryRetryBackoffMs: 20,
        fetchImpl: async () => {
          attempts += 1;
          return new Response('Internal Server Error', { status: 500 });
        },
        logger: () => {},
        errorLogger: () => {},
      });

      const result = await monitor.deliverNotification({
        event: 'gateway_outage',
        gatewayId: 'test-gateway',
        timestamp: new Date().toISOString(),
        incidentId: 'inc_test',
      });

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3); // 1 initial + 2 retries
      expect(attempts).toBe(3);
      expect(result.error).toContain('HTTP 500');
    });
  });
});
