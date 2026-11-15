import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const operatorKey = crypto.randomBytes(24).toString('hex');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shlita-pilot-rehearsal-'));
const consumer = path.join(work, 'consumer');
const ledger = path.join(work, 'ledger.db');
fs.mkdirSync(consumer, { recursive: true });

function redact(text) {
  return String(text).split(operatorKey).join('[redacted]');
}

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

async function waitReady(url, child, logPath) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${url}/ready`);
      if (response.ok) return;
    } catch {
      // Gateway is starting up
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(redact(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : 'Gateway did not become ready'));
}

function startGateway(port, logPath) {
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  const child = spawn(process.execPath, ['--import', 'tsx', 'packages/gateway/src/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      SHLITA_ENV: 'development',
      SHLITA_OPERATOR_KEY: operatorKey,
      SHLITA_OPERATOR_ORG: 'org-pilot-rehearsal',
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

const logPath = path.join(work, 'gateway.log');
let gateway;

try {
  // 1. Build SDK & Pack Tarball
  await exec(process.execPath, ['node_modules/typescript/lib/tsc.js', '-p', 'packages/sdk/tsconfig.json'], { cwd: root });
  const { stdout: packedJson } = await exec('npm', ['pack', '--json', '--pack-destination', work], {
    cwd: path.join(root, 'packages/sdk'),
  });
  const packed = JSON.parse(packedJson);
  const tarballName = packed[0].filename;
  const tarballPath = path.join(work, tarballName);

  // Verify tarball contents hygiene
  const listing = (await exec('tar', ['-tzf', tarballPath])).stdout;
  const names = listing.split('\n').filter(Boolean);
  if (names.some((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))) {
    throw new Error('Packaged SDK archive contains raw TypeScript source files.');
  }
  if (names.some((name) => /gateway|ledger|\.db$|\.env|secret/i.test(name))) {
    throw new Error(`Packaged SDK archive contains private material: ${names.join(', ')}`);
  }

  // 2. Set up Clean Consumer Project
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
    name: 'pilot-consumer',
    private: true,
    type: 'module',
  }, null, 2));

  await exec('npm', ['install', '--no-fund', '--no-audit', '--omit=dev', tarballPath], { cwd: consumer });

  // 3. Start Isolated Gateway
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  gateway = startGateway(port, logPath);
  await waitReady(baseUrl, gateway, logPath);

  // 4. Consumer Script to run Developer & Operator Workflows
  const consumerScriptPath = path.join(consumer, 'run-scenarios.mjs');
  fs.writeFileSync(consumerScriptPath, `
import { ShlitaAgentClient, ShlitaOperatorClient } from 'shlita-sdk';

const baseUrl = process.env.SHLITA_GATEWAY_URL;
const operatorKey = process.env.SHLITA_OPERATOR_KEY;

// Step A: Operator Enrolls Agent
const operator = new ShlitaOperatorClient({ operatorKey, baseUrl });
const issued = await operator.enrollAgent({
  agentId: 'pilot-agent-alpha',
  allowedVendors: ['api.helius.xyz'],
  maxPerCallMicroUsdc: '50000',
  periodBudgetMicroUsdc: '1000000',
});

const agent = new ShlitaAgentClient({ apiKey: issued.apiKey, baseUrl });

// Scenario 1: First Allowed Request
const op1 = await agent.proxy({
  agentId: 'pilot-agent-alpha',
  vendor: 'api.helius.xyz',
  path: '/v0/token-metadata',
  method: 'POST',
  body: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  idempotencyKey: 'rehearsal-key-001',
  simulate: true,
});

if (op1.outcome !== 'committed') {
  throw new Error('Scenario 1 failed: Expected outcome "committed", got: ' + op1.outcome);
}
if (op1.cost.reservedAmountMicroUsdc !== '10000') {
  throw new Error('Scenario 1 failed: Expected 10000 micro-USDC reserved, got: ' + op1.cost.reservedAmountMicroUsdc);
}
if (op1.settlement.status !== 'NOT_SUBMITTED' || op1.fundsMoved !== false) {
  throw new Error('Scenario 1 failed: Settlement should be NOT_SUBMITTED with fundsMoved=false');
}

// Scenario 2: Policy-Denied Request
const op2 = await agent.proxy({
  agentId: 'pilot-agent-alpha',
  vendor: 'api.tavily.com', // Not in allowedVendors
  path: '/search',
  method: 'POST',
  body: { query: 'solana price' },
  idempotencyKey: 'rehearsal-key-denied',
  simulate: true,
});

if (op2.outcome !== 'rejected') {
  throw new Error('Scenario 2 failed: Expected outcome "rejected", got: ' + op2.outcome);
}
if (op2.reason !== 'UNAPPROVED_VENDOR') {
  throw new Error('Scenario 2 failed: Expected reason "UNAPPROVED_VENDOR", got: ' + op2.reason);
}

// Scenario 3: Idempotent Replay
const op3 = await agent.proxy({
  agentId: 'pilot-agent-alpha',
  vendor: 'api.helius.xyz',
  path: '/v0/token-metadata',
  method: 'POST',
  body: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  idempotencyKey: 'rehearsal-key-001', // Exact same key and payload as Scenario 1
  simulate: true,
});

if (op3.outcome !== 'committed' || op3.replay !== true) {
  throw new Error('Scenario 3 failed: Expected outcome "committed" with replay=true');
}
if (op3.operationId !== op1.operationId) {
  throw new Error('Scenario 3 failed: Idempotent replay must return original operationId');
}

// Scenario 4: Operator Ledger Inspection
const ops = await operator.listOperations();
const ledgerRecord = ops.operations.find((r) => r.operationId === op1.operationId);
if (!ledgerRecord) {
  throw new Error('Scenario 4 failed: Operator could not find operation ' + op1.operationId + ' in ledger');
}
if (ledgerRecord.state !== 'ACCOUNTING_COMMITTED') {
  throw new Error('Scenario 4 failed: Expected state ACCOUNTING_COMMITTED, got: ' + ledgerRecord.state);
}
if (ledgerRecord.reservedAmountMicroUsdc !== '10000') {
  throw new Error('Scenario 4 failed: Expected reservedAmountMicroUsdc 10000, got: ' + ledgerRecord.reservedAmountMicroUsdc);
}
if (ledgerRecord.settlementStatus !== 'NOT_SUBMITTED' || ledgerRecord.signature !== null) {
  throw new Error('Scenario 4 failed: Expected settlementStatus NOT_SUBMITTED and signature null');
}

// Scenario 5: Freeze and Verify
await operator.freezeAgent('pilot-agent-alpha', 'rehearsal-emergency-freeze');
const op5 = await agent.proxy({
  agentId: 'pilot-agent-alpha',
  vendor: 'api.helius.xyz',
  path: '/v0/token-metadata',
  method: 'POST',
  body: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  idempotencyKey: 'rehearsal-key-post-freeze',
  simulate: true,
});

if (op5.outcome !== 'rejected' || op5.reason !== 'AGENT_FROZEN') {
  throw new Error('Scenario 5 failed: Expected outcome "rejected" with reason "AGENT_FROZEN", got: ' + op5.reason);
}

// Output summary for parent orchestrator
console.log(JSON.stringify({
  agentApiKey: issued.apiKey,
  operationId: op1.operationId,
  reservedAmountMicroUsdc: op1.cost.reservedAmountMicroUsdc,
  deniedReason: op2.reason,
  replayed: op3.replay,
  ledgerState: ledgerRecord.state,
  frozenReason: op5.reason,
}));
`);

  const { stdout: phase2Stdout } = await exec(process.execPath, ['run-scenarios.mjs'], {
    cwd: consumer,
    env: {
      ...process.env,
      SHLITA_GATEWAY_URL: baseUrl,
      SHLITA_OPERATOR_KEY: operatorKey,
    },
  });
  const phase2Result = JSON.parse(phase2Stdout.trim());

  // Scenario 6: Restart and Recover
  await stopGateway(gateway);
  gateway = startGateway(port, logPath);
  await waitReady(baseUrl, gateway, logPath);

  // Post-restart verification script
  const postRestartScriptPath = path.join(consumer, 'post-restart-check.mjs');
  fs.writeFileSync(postRestartScriptPath, `
import { ShlitaAgentClient, ShlitaOperatorClient } from 'shlita-sdk';

const baseUrl = process.env.SHLITA_GATEWAY_URL;
const operatorKey = process.env.SHLITA_OPERATOR_KEY;
const agentApiKey = process.env.SHLITA_AGENT_API_KEY;
const expectedOpId = process.env.EXPECTED_OP_ID;

const operator = new ShlitaOperatorClient({ operatorKey, baseUrl });
const ops = await operator.listOperations();
const record = ops.operations.find((r) => r.operationId === expectedOpId);

if (!record) {
  throw new Error('Scenario 6 failed: Operation did not survive gateway restart.');
}
if (record.state !== 'ACCOUNTING_COMMITTED' || record.reservedAmountMicroUsdc !== '10000') {
  throw new Error('Scenario 6 failed: Operation fields corrupted across restart.');
}

const agents = await operator.listAgents();
const agentRecord = agents.agents.find((a) => a.agentId === 'pilot-agent-alpha');
if (!agentRecord || agentRecord.status !== 'AGENT_FROZEN') {
  throw new Error('Scenario 6 failed: Agent freeze did not survive gateway restart. Got status: ' + agentRecord?.status);
}

const agent = new ShlitaAgentClient({ apiKey: agentApiKey, baseUrl });
const opRestart = await agent.proxy({
  agentId: 'pilot-agent-alpha',
  vendor: 'api.helius.xyz',
  path: '/v0/token-metadata',
  method: 'POST',
  body: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  idempotencyKey: 'rehearsal-key-after-restart',
  simulate: true,
});

if (opRestart.outcome !== 'rejected' || opRestart.reason !== 'AGENT_FROZEN') {
  throw new Error('Scenario 6 failed: Agent was not blocked after restart. Got: ' + opRestart.reason);
}

console.log(JSON.stringify({
  survivedRestart: true,
  persistedOpId: record.operationId,
  persistedState: record.state,
  persistedAgentStatus: agentRecord.status,
}));
`);

  const { stdout: phase2PostRestartStdout } = await exec(process.execPath, ['post-restart-check.mjs'], {
    cwd: consumer,
    env: {
      ...process.env,
      SHLITA_GATEWAY_URL: baseUrl,
      SHLITA_OPERATOR_KEY: operatorKey,
      SHLITA_AGENT_API_KEY: phase2Result.agentApiKey,
      EXPECTED_OP_ID: phase2Result.operationId,
    },
  });
  const postRestartResult = JSON.parse(phase2PostRestartStdout.trim());

  // Anonymous check
  const anon = await fetch(`${baseUrl}/v1/agents`);
  if (anon.status !== 401) {
    throw new Error('Security check failed: Anonymous access to /v1/agents did not return 401.');
  }

  // Credential leak check in logs
  const logs = fs.readFileSync(logPath, 'utf8');
  if (logs.includes(operatorKey) || logs.includes(phase2Result.agentApiKey)) {
    throw new Error('Security check failed: Gateway log file contains exposed credentials.');
  }

  console.log(JSON.stringify({
    rehearsal: 'SUCCESS',
    tarball: tarballName,
    port,
    mode: 'development_simulation',
    scenarios: {
      s1_firstAllowed: {
        outcome: 'committed',
        operationId: phase2Result.operationId,
        reservedAmountMicroUsdc: phase2Result.reservedAmountMicroUsdc,
      },
      s2_policyDenied: {
        outcome: 'rejected',
        reason: phase2Result.deniedReason,
      },
      s3_idempotentReplay: {
        outcome: 'committed',
        replay: phase2Result.replayed,
        operationId: phase2Result.operationId,
      },
      s4_operatorLedger: {
        operationId: phase2Result.operationId,
        state: phase2Result.ledgerState,
        settlementStatus: 'NOT_SUBMITTED',
        signature: null,
      },
      s5_freezeAndVerify: {
        outcome: 'rejected',
        reason: phase2Result.frozenReason,
      },
      s6_restartAndRecover: {
        survivedRestart: postRestartResult.survivedRestart,
        persistedOpId: postRestartResult.persistedOpId,
        persistedState: postRestartResult.persistedState,
        persistedAgentStatus: postRestartResult.persistedAgentStatus,
      },
    },
  }, null, 2));
} finally {
  await stopGateway(gateway);
  fs.rmSync(work, { recursive: true, force: true });
}
