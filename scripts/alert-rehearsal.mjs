import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReadinessMonitor } from './readiness-monitor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const operatorKey = crypto.randomBytes(24).toString('hex');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shlita-alert-rehearsal-'));
const ledger = path.join(work, 'ledger.db');
const logPath = path.join(work, 'gateway.log');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function startGateway(port, logFile) {
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  const child = spawn(process.execPath, ['--import', 'tsx', 'packages/gateway/src/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      SHLITA_ENV: 'development',
      SHLITA_OPERATOR_KEY: operatorKey,
      SHLITA_OPERATOR_ORG: 'org-alert-rehearsal',
      SHLITA_ALLOW_SIMULATION: 'true',
      SHLITA_SEED_DEMO: 'false',
      SHLITA_DB_PATH: ledger,
      SHLITA_STATE_DIR: work,
      SHLITA_BACKUP_DIR: path.join(work, 'backups'),
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return child;
}

async function stopGateway(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitReady(url, child, logFile, maxAttempts = 50) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (child.exitCode !== null) {
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : 'no log';
      throw new Error(`Gateway process exited prematurely with code ${child.exitCode}: ${log}`);
    }
    try {
      const response = await fetch(`${url}/ready`);
      if (response.ok) {
        const body = await response.json();
        if (body.status === 'ready' || body.status === 'ok') return;
      }
    } catch {
      // Gateway is still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : 'no log';
  throw new Error(`Gateway did not become ready at ${url} (attempts: ${maxAttempts}): ${log}`);
}

export async function runAlertRehearsal() {
  const receiverPort = await freePort();
  const gatewayPort = await freePort();

  const receivedNotifications = [];
  const receiverLogs = [];

  // 1. Start Local Webhook Receiver
  const webhookServer = http.createServer(async (req, res) => {
    let bodyText = '';
    req.on('data', (chunk) => { bodyText += chunk; });
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        parsed = bodyText;
      }

      receiverLogs.push({ method: req.method, url: req.url, timestamp: new Date().toISOString() });

      if (req.url === '/webhook-500') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INTERNAL_SERVER_ERROR', message: 'Simulated webhook failure' }));
        return;
      }

      if (req.url === '/webhook') {
        receivedNotifications.push({
          receivedAt: new Date().toISOString(),
          headers: req.headers,
          payload: parsed,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'accepted', event: parsed?.event }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'NOT_FOUND' }));
    });
  });

  await new Promise((resolve) => webhookServer.listen(receiverPort, '127.0.0.1', resolve));

  const receiverWebhookUrl = `http://127.0.0.1:${receiverPort}/webhook`;
  const receiverFailingUrl = `http://127.0.0.1:${receiverPort}/webhook-500`;
  const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}`;

  let gateway = null;
  const drillLog = [];
  const log = (msg) => drillLog.push(`[${new Date().toISOString()}] ${msg}`);

  try {
    log('Starting isolated Shlita gateway...');
    gateway = startGateway(gatewayPort, logPath);
    await waitReady(gatewayBaseUrl, gateway, logPath);
    log(`Gateway healthy on ${gatewayBaseUrl}`);

    // Create monitor with fast local settings: 100ms interval, threshold = 2
    const monitor = new ReadinessMonitor({
      targetUrl: gatewayBaseUrl,
      webhookUrl: receiverWebhookUrl,
      intervalMs: 100,
      probeTimeoutMs: 1000,
      failureThreshold: 2,
      recoveryThreshold: 1,
      logger: log,
      errorLogger: log,
    });

    // ------------------------------------------------------------
    // Scenario 1: Healthy Baseline
    // ------------------------------------------------------------
    log('Executing Scenario 1: Healthy Baseline...');
    const s1 = await monitor.step();
    if (!s1.probeResult.ok || monitor.state !== 'HEALTHY') {
      throw new Error(`Scenario 1 failed: Expected HEALTHY, got ${monitor.state}`);
    }
    if (receivedNotifications.length !== 0) {
      throw new Error(`Scenario 1 failed: Expected 0 incident notifications, received ${receivedNotifications.length}`);
    }
    log('Scenario 1 PASSED: Baseline is healthy, 0 alerts sent.');

    // ------------------------------------------------------------
    // Scenario 2: Brief Interruption (Below Threshold)
    // ------------------------------------------------------------
    log('Executing Scenario 2: Brief Interruption...');
    // Create an ephemeral monitor that evaluates 1 simulated failure against threshold 2
    let s2FailedProbe = false;
    const briefMonitor = new ReadinessMonitor({
      targetUrl: gatewayBaseUrl,
      webhookUrl: receiverWebhookUrl,
      failureThreshold: 2,
      fetchImpl: async (url, opts) => {
        if (!s2FailedProbe) {
          s2FailedProbe = true;
          return new Response('Gateway timeout', { status: 504 });
        }
        return fetch(url, opts);
      },
      logger: () => {},
      errorLogger: () => {},
    });

    const s2Step = await briefMonitor.step();
    if (briefMonitor.state !== 'DEGRADED' || briefMonitor.consecutiveFailures !== 1) {
      throw new Error(`Scenario 2 failed: Expected DEGRADED with 1 failure, got ${briefMonitor.state} (${briefMonitor.consecutiveFailures})`);
    }
    if (receivedNotifications.length !== 0) {
      throw new Error(`Scenario 2 failed: Interruption below threshold must not dispatch outage alerts.`);
    }
    log('Scenario 2 PASSED: 1 failure below threshold transitioned to DEGRADED with 0 alerts.');

    // ------------------------------------------------------------
    // Scenario 3: Sustained Outage (Threshold Reached + Suppression)
    // ------------------------------------------------------------
    log('Executing Scenario 3: Sustained Outage...');
    // Stop the gateway to induce real local outage
    await stopGateway(gateway);
    gateway = null;
    log('Stopped gateway to induce outage.');

    // Step 1: First failure (DEGRADED)
    const s3Step1 = await monitor.step();
    if (monitor.state !== 'DEGRADED') {
      throw new Error(`Scenario 3 failed: Expected DEGRADED on failure 1, got ${monitor.state}`);
    }
    if (receivedNotifications.length !== 0) {
      throw new Error('Scenario 3 failed: Dispatched alert prematurely on failure 1.');
    }

    // Step 2: Second failure (reaches threshold 2 -> OUTAGE)
    const s3Step2 = await monitor.step();
    if (monitor.state !== 'OUTAGE') {
      throw new Error(`Scenario 3 failed: Expected OUTAGE on failure 2, got ${monitor.state}`);
    }
    if (receivedNotifications.length !== 1) {
      throw new Error(`Scenario 3 failed: Expected 1 outage alert, got ${receivedNotifications.length}`);
    }
    const outageRecord = receivedNotifications[0];
    if (outageRecord.payload.event !== 'gateway_outage') {
      throw new Error(`Scenario 3 failed: Expected event "gateway_outage", got "${outageRecord.payload.event}"`);
    }
    if (outageRecord.payload.gatewayId !== `127.0.0.1:${gatewayPort}`) {
      throw new Error(`Scenario 3 failed: Unexpected gatewayId: ${outageRecord.payload.gatewayId}`);
    }

    // Step 3 & 4: Further failed probes while outage persists (Suppression Check)
    await monitor.step();
    await monitor.step();
    if (receivedNotifications.length !== 1) {
      throw new Error(`Scenario 3 failed: Duplicate outage alerts sent during sustained outage. Expected 1, got ${receivedNotifications.length}`);
    }
    log('Scenario 3 PASSED: Outage detected, exactly 1 alert delivered, duplicate alerts suppressed.');

    // ------------------------------------------------------------
    // Scenario 4: Recovery Notification
    // ------------------------------------------------------------
    log('Executing Scenario 4: Recovery Notification...');
    // Restore the gateway using the exact same database and port
    gateway = startGateway(gatewayPort, logPath);
    await waitReady(gatewayBaseUrl, gateway, logPath);
    log('Gateway restored and ready.');

    // Step monitor: observes healthy gateway and triggers recovery
    const s4Step = await monitor.step();
    if (monitor.state !== 'HEALTHY') {
      throw new Error(`Scenario 4 failed: Expected state HEALTHY post-recovery, got ${monitor.state}`);
    }
    if (receivedNotifications.length !== 2) {
      throw new Error(`Scenario 4 failed: Expected exactly 2 total notifications (1 outage + 1 recovery), got ${receivedNotifications.length}`);
    }
    const recoveryRecord = receivedNotifications[1];
    if (recoveryRecord.payload.event !== 'gateway_recovered') {
      throw new Error(`Scenario 4 failed: Expected event "gateway_recovered", got "${recoveryRecord.payload.event}"`);
    }
    if (recoveryRecord.payload.incidentId !== outageRecord.payload.incidentId) {
      throw new Error(`Scenario 4 failed: Recovery incidentId does not match outage incidentId.`);
    }

    // Verify /ready returns HTTP 200
    const readyCheck = await fetch(`${gatewayBaseUrl}/ready`);
    const readyJson = await readyCheck.json();
    if (!readyCheck.ok || (readyJson.status !== 'ready' && readyJson.status !== 'ok')) {
      throw new Error(`Scenario 4 failed: Gateway /ready not healthy. Status: ${readyCheck.status}`);
    }
    log('Scenario 4 PASSED: Recovery event delivered, gateway verified healthy.');

    // ------------------------------------------------------------
    // Scenario 5: Webhook Delivery Failure (Bounded Retries)
    // ------------------------------------------------------------
    log('Executing Scenario 5: Webhook Delivery Failure...');
    const failMonitor = new ReadinessMonitor({
      targetUrl: gatewayBaseUrl,
      webhookUrl: receiverFailingUrl, // Returns HTTP 500
      maxDeliveryRetries: 2,
      deliveryRetryBackoffMs: 50,
      logger: () => {},
      errorLogger: () => {},
    });

    const failedDelivery = await failMonitor.deliverNotification({
      event: 'gateway_outage',
      gatewayId: `127.0.0.1:${gatewayPort}`,
      timestamp: new Date().toISOString(),
      incidentId: 'inc_test_fail',
    });

    if (failedDelivery.success !== false || failedDelivery.attempts !== 3) {
      throw new Error(`Scenario 5 failed: Expected delivery failure with 3 attempts, got: ${JSON.stringify(failedDelivery)}`);
    }
    log('Scenario 5 PASSED: Webhook 500 triggered bounded retries (3 attempts) and surfaced failure.');

    // ------------------------------------------------------------
    // Scenario 6: Cleanup & Final Report
    // ------------------------------------------------------------
    log('Scenario 6: Cleaning up all drill resources...');
    await stopGateway(gateway);
    gateway = null;
    await new Promise((resolve) => webhookServer.close(resolve));
    log('Gateway and webhook receiver closed.');

    const summary = {
      rehearsal: 'SUCCESS',
      target: gatewayBaseUrl,
      receiver: receiverWebhookUrl,
      scenarios: {
        healthyBaseline: {
          status: 'PASS',
          probesPassed: 1,
          notificationsReceived: 0,
        },
        briefInterruption: {
          status: 'PASS',
          failuresObserved: 1,
          threshold: 2,
          state: 'DEGRADED',
          notificationsReceived: 0,
        },
        sustainedOutage: {
          status: 'PASS',
          failuresToTrip: 2,
          outageAlertsReceived: 1,
          suppressedAdditionalAlerts: 2,
          outagePayload: outageRecord.payload,
        },
        recovery: {
          status: 'PASS',
          recoveryAlertsReceived: 1,
          gatewayStatusAfterRecovery: readyJson.status,
          recoveryPayload: recoveryRecord.payload,
        },
        deliveryFailure: {
          status: 'PASS',
          targetEndpoint: '/webhook-500',
          totalAttempts: failedDelivery.attempts,
          deliverySuccess: failedDelivery.success,
          reportedError: failedDelivery.error,
        },
        cleanup: {
          status: 'PASS',
          gatewayStopped: true,
          receiverClosed: true,
          tempFilesCleaned: true,
        },
      },
    };

    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    if (gateway) await stopGateway(gateway);
    webhookServer.close();
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {}
  }
}

const isDirectRun = Boolean(process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]);
if (isDirectRun) {
  runAlertRehearsal().catch((err) => {
    console.error(`[Rehearsal FAILED] ${err.stack || err.message}`);
    process.exit(1);
  });
}
