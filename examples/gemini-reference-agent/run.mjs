#!/usr/bin/env node
/**
 * Shlita Gemini Reference Agent — Runnable Demo CLI
 *
 * Demonstrates the end-to-end flow:
 * User Request -> Gemini proposes tool call -> Application validates -> Shlita SDK submits -> Gateway applies policy -> Outcome
 *
 * Scenarios demonstrated:
 * 1. Allowed: Gateway policy permits call -> Tariff reserved in ledger -> Outcome 'committed'
 * 2. Denied : Gateway policy rejects call  -> 0 billable reservations  -> Outcome 'rejected' ('UNAPPROVED_VENDOR')
 *
 * Usage:
 *   node examples/gemini-reference-agent/run.mjs [--mode fixture|live] [--scenario allowed|denied|both] [--simulate]
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGeminiAgent } from './agent.mjs';
import { SAMPLE_MINT } from './fixtures.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');

let ShlitaAgentClient;
let ShlitaOperatorClient;

try {
  const sdk = await import('shlita-sdk');
  ShlitaAgentClient = sdk.ShlitaAgentClient;
  ShlitaOperatorClient = sdk.ShlitaOperatorClient;
} catch {
  const sdkDist = path.resolve(root, 'packages/sdk/dist/index.js');
  if (!fs.existsSync(sdkDist)) {
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.execPath, [path.resolve(root, 'node_modules/typescript/lib/tsc.js'), '-p', path.resolve(root, 'packages/sdk/tsconfig.json')], { stdio: 'inherit' });
  }
  const { pathToFileURL } = await import('node:url');
  const sdk = await import(pathToFileURL(sdkDist).href);
  ShlitaAgentClient = sdk.ShlitaAgentClient;
  ShlitaOperatorClient = sdk.ShlitaOperatorClient;
}

const args = process.argv.slice(2);
function getArg(flag, defaultVal) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}
function hasFlag(flag) {
  return args.includes(flag);
}

const mode = getArg('--mode', process.env.GEMINI_MODE || 'fixture');
const scenario = getArg('--scenario', process.env.SCENARIO || 'both');
const explicitSimulateFlag = hasFlag('--simulate') || process.env.SHLITA_SIMULATE === 'true';

let gatewayUrl = getArg('--gateway-url', process.env.SHLITA_GATEWAY_URL);
let allowedApiKey = getArg('--allowed-api-key', process.env.SHLITA_ALLOWED_API_KEY || process.env.SHLITA_API_KEY);
let deniedApiKey = getArg('--denied-api-key', process.env.SHLITA_DENIED_API_KEY);
let operatorKey = getArg('--operator-key', process.env.SHLITA_OPERATOR_KEY);

const allowedAgentId = getArg('--allowed-agent-id', process.env.SHLITA_ALLOWED_AGENT_ID || process.env.SHLITA_AGENT_ID || 'gemini-allowed-agent');
const deniedAgentId = getArg('--denied-agent-id', process.env.SHLITA_DENIED_AGENT_ID || 'gemini-denied-agent');

const geminiApiKey = getArg('--gemini-api-key', process.env.GEMINI_API_KEY);
const geminiModel = getArg('--gemini-model', process.env.GEMINI_MODEL || 'gemini-2.5-flash');

const isConfiguredGateway = Boolean(gatewayUrl);
const simulate = isConfiguredGateway ? explicitSimulateFlag : true;

// Early validation for configured gateway mode
if (isConfiguredGateway) {
  if (scenario === 'both') {
    if (!allowedApiKey) {
      console.error('\nError: Configuration missing for scenario "both".');
      console.error('Missing SHLITA_ALLOWED_API_KEY or SHLITA_API_KEY (or --allowed-api-key).');
      console.error(`An agent API key is required to execute the allowed scenario against configured gateway at ${gatewayUrl}.`);
      process.exit(1);
    }
    if (!deniedApiKey) {
      console.error('\nError: Configuration missing for scenario "both".');
      console.error('Missing SHLITA_DENIED_API_KEY (or --denied-api-key).');
      console.error('When running "--scenario both" against a configured gateway, distinct scoped agent keys must be provided');
      console.error('for both the allowed agent (SHLITA_ALLOWED_API_KEY or SHLITA_API_KEY) and the denied agent (SHLITA_DENIED_API_KEY).');
      console.error('Alternatively, run with "--scenario allowed" or "--scenario denied".');
      process.exit(1);
    }
  } else if (scenario === 'allowed') {
    if (!allowedApiKey) {
      console.error('\nError: Missing SHLITA_ALLOWED_API_KEY or SHLITA_API_KEY (or --allowed-api-key).');
      console.error(`An agent API key is required to execute the allowed scenario against configured gateway at ${gatewayUrl}.`);
      process.exit(1);
    }
  } else if (scenario === 'denied') {
    if (!deniedApiKey && !allowedApiKey) {
      console.error('\nError: Missing SHLITA_DENIED_API_KEY or SHLITA_API_KEY (or --denied-api-key).');
      console.error(`An agent API key is required to execute the denied scenario against configured gateway at ${gatewayUrl}.`);
      process.exit(1);
    }
    if (!deniedApiKey && allowedApiKey) {
      deniedApiKey = allowedApiKey;
    }
  }
}

if (mode === 'live' && !geminiApiKey) {
  console.error('\nError: Missing GEMINI_API_KEY (or --gemini-api-key).');
  console.error('When running with "--mode live", a Google Gemini API key is required.');
  process.exit(1);
}

console.log('============================================================');
console.log(' Shlita — Gemini Reference Agent Spending Policy Demo');
console.log(` Gemini Model Mode : ${mode === 'live' ? `LIVE (${geminiModel})` : 'FIXTURE (Deterministic Function Calling)'}`);
console.log(` Gateway Target    : ${isConfiguredGateway ? `Configured Gateway (${gatewayUrl})` : 'Self-Contained Local Development Gateway'}`);
console.log(` Gateway Execution : ${simulate ? (isConfiguredGateway ? 'Explicit Simulation (--simulate)' : 'Local Simulation') : 'Live Policy & Upstream Dispatch (Simulation Off)'}`);
console.log(` Target Scenario(s): ${scenario}`);
console.log('============================================================\n');

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

async function waitReady(url, child, maxAttempts = 50) {
  for (let i = 0; i < maxAttempts; i++) {
    if (child.exitCode !== null) {
      throw new Error(`Gateway process exited prematurely with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${url}/ready`);
      if (res.ok) return;
    } catch {
      // connecting...
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Gateway failed to become ready within timeout.');
}

let spawnedChild = null;
let tmpDir = null;

try {
  if (!gatewayUrl) {
    // Spawn local isolated development gateway
    const port = await freePort();
    gatewayUrl = `http://127.0.0.1:${port}`;
    operatorKey = 'op_' + crypto.randomBytes(24).toString('hex');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shlita-gemini-demo-'));
    const dbPath = path.join(tmpDir, 'ledger.db');

    const tsxPath = path.join(root, 'node_modules/tsx/dist/cli.mjs');
    const gatewayEntry = path.join(root, 'packages/gateway/src/index.ts');

    spawnedChild = spawn(process.execPath, [tsxPath, gatewayEntry], {
      cwd: root,
      env: {
        ...process.env,
        SHLITA_ENV: 'development',
        SHLITA_OPERATOR_KEY: operatorKey,
        SHLITA_OPERATOR_ORG: 'org-gemini-demo',
        SHLITA_ALLOW_SIMULATION: 'true',
        SHLITA_SEED_DEMO: 'false',
        SHLITA_DB_PATH: dbPath,
        SHLITA_STATE_DIR: tmpDir,
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await waitReady(gatewayUrl, spawnedChild);

    const operator = new ShlitaOperatorClient({
      operatorKey,
      baseUrl: gatewayUrl,
    });

    // 1. Enroll Allowed Agent: Policy allows api.helius.xyz with 50,000 micro-USDC per-call limit
    const allowedCreds = await operator.enrollAgent({
      agentId: allowedAgentId,
      allowedVendors: ['api.helius.xyz'],
      maxPerCallMicroUsdc: '50000',
      periodBudgetMicroUsdc: '1000000',
    });
    allowedApiKey = allowedCreds.apiKey;

    // 2. Enroll Denied Agent: Policy restricts to api.tavily.com (blocks api.helius.xyz)
    const deniedCreds = await operator.enrollAgent({
      agentId: deniedAgentId,
      allowedVendors: ['api.tavily.com'],
      maxPerCallMicroUsdc: '50000',
      periodBudgetMicroUsdc: '1000000',
    });
    deniedApiKey = deniedCreds.apiKey;
  }

  // Execute Scenario 1: Allowed Call
  if (scenario === 'allowed' || scenario === 'both') {
    console.log('--- [SCENARIO 1: ALLOWED OPERATION] ---');
    console.log(`Agent ID   : ${allowedAgentId}`);
    console.log('Policy     : allowedVendors = ["api.helius.xyz"], maxPerCall = 50000 micro-USDC ($0.05 USDC)');
    console.log(`Tool Call  : get_solana_token_metadata(mint: "${SAMPLE_MINT}")`);
    console.log(`Execution  : simulate=${simulate}`);

    const allowedClient = new ShlitaAgentClient({
      apiKey: allowedApiKey,
      baseUrl: gatewayUrl,
    });

    const allowedResult = await runGeminiAgent({
      agentClient: allowedClient,
      agentId: allowedAgentId,
      userPrompt: `What is the token metadata for ${SAMPLE_MINT}?`,
      mode,
      geminiApiKey,
      geminiModel,
      idempotencyKey: `gemini-allowed-${Date.now()}`,
      simulate,
    });

    console.log('\nDeveloper Outcome:');
    console.log(JSON.stringify(allowedResult, null, 2));

    if (allowedResult.shlita.outcome !== 'committed') {
      throw new Error(`Scenario 1 failed: Expected outcome 'committed', got '${allowedResult.shlita.outcome}' (reason: ${allowedResult.shlita.reason})`);
    }
    const microUsdc = allowedResult.shlita.reservedAmountMicroUsdc;
    const usdc = microUsdc ? (Number(microUsdc) / 1_000_000).toFixed(4) : '0.0000';
    console.log(`\n✓ Verdict: Call APPROVED. Reserved ${microUsdc} micro-USDC ($${usdc} USDC) in Shlita ledger.\n`);
  }

  // Execute Scenario 2: Denied Call
  if (scenario === 'denied' || scenario === 'both') {
    console.log('--- [SCENARIO 2: POLICY-DENIED OPERATION] ---');
    console.log(`Agent ID   : ${deniedAgentId}`);
    console.log('Policy     : Prohibits api.helius.xyz');
    console.log(`Tool Call  : get_solana_token_metadata(mint: "${SAMPLE_MINT}")`);
    console.log(`Execution  : simulate=${simulate}`);

    const deniedClient = new ShlitaAgentClient({
      apiKey: deniedApiKey,
      baseUrl: gatewayUrl,
    });

    const deniedResult = await runGeminiAgent({
      agentClient: deniedClient,
      agentId: deniedAgentId,
      userPrompt: `What is the token metadata for ${SAMPLE_MINT}?`,
      mode,
      geminiApiKey,
      geminiModel,
      idempotencyKey: `gemini-denied-${Date.now()}`,
      simulate,
    });

    console.log('\nDeveloper Outcome:');
    console.log(JSON.stringify(deniedResult, null, 2));

    if (deniedResult.shlita.outcome !== 'rejected') {
      throw new Error(`Scenario 2 failed: Expected outcome 'rejected', got '${deniedResult.shlita.outcome}' (reason: ${deniedResult.shlita.reason})`);
    }
    console.log(`\n✓ Verdict: Call BLOCKED by Shlita policy perimeter (${deniedResult.shlita.reason}). 0 provider calls dispatched, 0 micro-USDC reserved in ledger.\n`);
  }

  // Print ledger audit state if operatorKey is present
  if (operatorKey) {
    const operator = new ShlitaOperatorClient({
      operatorKey,
      baseUrl: gatewayUrl,
    });
    const ops = await operator.listOperations();
    console.log('--- [LEDGER AUDIT RECORD] ---');
    console.log(`Total Operations Recorded in Ledger: ${ops.operations.length}`);
    for (const op of ops.operations) {
      console.log(` - Operation ID      : ${op.operationId}`);
      console.log(`   Agent ID          : ${op.agentId}`);
      console.log(`   Vendor            : ${op.vendor}`);
      console.log(`   Decision          : ${op.decision}`);
      console.log(`   State             : ${op.state}`);
      console.log(`   Reserved Tariff   : ${op.reservedAmountMicroUsdc} micro-USDC ($${(Number(op.reservedAmountMicroUsdc) / 1_000_000).toFixed(4)} USDC)`);
      console.log(`   Settlement Status : ${op.settlementStatus}`);
      console.log(`   Signature         : ${op.signature ?? 'null (unsettled hold)'}`);
    }
    console.log('');
  }

  console.log('============================================================');
  console.log(' DEMO SUMMARY: ALL CHECKS PASSED');
  console.log(' 1. Allowed call was routed and reserved in the Shlita ledger.');
  console.log(' 2. Denied call was stopped at perimeter with 0 provider calls.');
  console.log('============================================================');
} catch (err) {
  console.error('\nExecution Error:', err.message);
  process.exitCode = 1;
} finally {
  if (spawnedChild) {
    spawnedChild.kill('SIGTERM');
  }
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
