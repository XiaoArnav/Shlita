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
 *   node examples/gemini-reference-agent/run.mjs [--mode fixture|live] [--scenario allowed|denied|both]
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runGeminiAgent,
  ShlitaAgentClient,
  ShlitaOperatorClient,
} from './agent.mjs';
import { SAMPLE_MINT } from './fixtures.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');

const args = process.argv.slice(2);
function getArg(flag, defaultVal) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const mode = getArg('--mode', process.env.GEMINI_MODE || 'fixture');
const scenario = getArg('--scenario', process.env.SCENARIO || 'both');

console.log('============================================================');
console.log(' Shlita — Gemini Reference Agent Spending Policy Demo');
console.log(` Mode: ${mode.toUpperCase()}`);
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
  let gatewayUrl = process.env.SHLITA_GATEWAY_URL;
  let allowedApiKey = process.env.SHLITA_API_KEY;
  let deniedApiKey = process.env.SHLITA_DENIED_API_KEY;
  let operatorKey = process.env.SHLITA_OPERATOR_KEY;

  if (!gatewayUrl) {
    // Spawn local isolated gateway
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
      agentId: 'gemini-allowed-agent',
      allowedVendors: ['api.helius.xyz'],
      maxPerCallMicroUsdc: '50000',
      periodBudgetMicroUsdc: '1000000',
    });
    allowedApiKey = allowedCreds.apiKey;

    // 2. Enroll Denied Agent: Policy restricts to api.tavily.com (blocks api.helius.xyz)
    const deniedCreds = await operator.enrollAgent({
      agentId: 'gemini-denied-agent',
      allowedVendors: ['api.tavily.com'],
      maxPerCallMicroUsdc: '50000',
      periodBudgetMicroUsdc: '1000000',
    });
    deniedApiKey = deniedCreds.apiKey;
  }

  // Execute Scenario 1: Allowed Call
  if (scenario === 'allowed' || scenario === 'both') {
    console.log('--- [SCENARIO 1: ALLOWED OPERATION] ---');
    console.log('Agent  : gemini-allowed-agent');
    console.log('Policy : allowedVendors = ["api.helius.xyz"], maxPerCall = 50000 micro-USDC ($0.05 USDC)');
    console.log(`Tool   : get_solana_token_metadata(mint: "${SAMPLE_MINT}")`);

    const allowedClient = new ShlitaAgentClient({
      apiKey: allowedApiKey,
      baseUrl: gatewayUrl,
    });

    const allowedResult = await runGeminiAgent({
      agentClient: allowedClient,
      agentId: 'gemini-allowed-agent',
      userPrompt: `What is the token metadata for ${SAMPLE_MINT}?`,
      mode,
      idempotencyKey: `gemini-allowed-${Date.now()}`,
      simulate: true,
    });

    console.log('\nDeveloper Outcome:');
    console.log(JSON.stringify(allowedResult, null, 2));

    if (allowedResult.shlita.outcome !== 'committed') {
      throw new Error(`Scenario 1 failed: Expected outcome 'committed', got '${allowedResult.shlita.outcome}'`);
    }
    console.log(`\n✓ Verdict: Call APPROVED. Reserved ${allowedResult.shlita.reservedAmountMicroUsdc} micro-USDC in ledger.\n`);
  }

  // Execute Scenario 2: Denied Call
  if (scenario === 'denied' || scenario === 'both') {
    console.log('--- [SCENARIO 2: POLICY-DENIED OPERATION] ---');
    console.log('Agent  : gemini-denied-agent');
    console.log('Policy : allowedVendors = ["api.tavily.com"] (api.helius.xyz is prohibited)');
    console.log(`Tool   : get_solana_token_metadata(mint: "${SAMPLE_MINT}")`);

    const deniedClient = new ShlitaAgentClient({
      apiKey: deniedApiKey,
      baseUrl: gatewayUrl,
    });

    const deniedResult = await runGeminiAgent({
      agentClient: deniedClient,
      agentId: 'gemini-denied-agent',
      userPrompt: `What is the token metadata for ${SAMPLE_MINT}?`,
      mode,
      idempotencyKey: `gemini-denied-${Date.now()}`,
      simulate: true,
    });

    console.log('\nDeveloper Outcome:');
    console.log(JSON.stringify(deniedResult, null, 2));

    if (deniedResult.shlita.outcome !== 'rejected' || deniedResult.shlita.reason !== 'UNAPPROVED_VENDOR') {
      throw new Error(`Scenario 2 failed: Expected outcome 'rejected' with 'UNAPPROVED_VENDOR', got '${deniedResult.shlita.outcome}' (${deniedResult.shlita.reason})`);
    }
    console.log(`\n✓ Verdict: Call BLOCKED by Shlita policy perimeter (${deniedResult.shlita.reason}). 0 provider calls dispatched.\n`);
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
      console.log(` - Operation ID : ${op.operationId}`);
      console.log(`   Agent ID     : ${op.agentId}`);
      console.log(`   Vendor       : ${op.vendor}`);
      console.log(`   State        : ${op.state}`);
      console.log(`   Reserved     : ${op.reservedAmountMicroUsdc} micro-USDC`);
      console.log(`   Funds Moved  : ${op.fundsMoved}`);
      console.log(`   Signature    : ${op.signature ?? 'null (unsettled hold)'}`);
    }
    console.log('');
  }

  console.log('============================================================');
  console.log(' DEMO SUMMARY: ALL CHECKS PASSED');
  console.log(' 1. Allowed call was routed and reserved in the Shlita ledger.');
  console.log(' 2. Denied call was stopped at perimeter with 0 provider calls.');
  console.log('============================================================');
} finally {
  if (spawnedChild) {
    spawnedChild.kill('SIGTERM');
  }
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
