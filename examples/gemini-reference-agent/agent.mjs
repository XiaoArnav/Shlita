/**
 * Shlita Gemini Reference Agent
 *
 * Demonstrates financial governance and policy enforcement for Gemini function calling:
 * User Request -> Gemini proposes tool call -> Application validates -> Shlita SDK submits -> Gateway applies policy -> Outcome
 */

import {
  FIXTURE_GEMINI_TOOL_CALL_RESPONSE,
  FIXTURE_GEMINI_FINAL_RESPONSE,
  SAMPLE_MINT,
} from './fixtures.mjs';



/**
 * Tool declaration adhering to the official Google Gemini API specification.
 * @see https://ai.google.dev/gemini-api/docs/function-calling
 */
export const GEMINI_TOOL_DECLARATIONS = [
  {
    name: 'get_solana_token_metadata',
    description: 'Fetch on-chain token metadata for a Solana token mint address via Helius RPC.',
    parameters: {
      type: 'OBJECT',
      properties: {
        mint: {
          type: 'STRING',
          description: 'Base58-encoded Solana token mint address (e.g. DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263).',
        },
      },
      required: ['mint'],
    },
  },
];

/**
 * Validates the Gemini function call proposal before routing to the gateway.
 * Enforces strict perimeter boundaries: argument types, presence, and base58 bounds.
 */
export function validateToolCall(call) {
  if (!call || typeof call !== 'object') {
    throw new Error('INVALID_MODEL_OUTPUT: Expected functionCall object');
  }
  if (call.name !== 'get_solana_token_metadata') {
    throw new Error(`INVALID_MODEL_OUTPUT: Unsupported tool '${call.name}'. Expected 'get_solana_token_metadata'.`);
  }
  if (!call.args || typeof call.args !== 'object') {
    throw new Error('INVALID_MODEL_OUTPUT: Missing function arguments object');
  }
  const { mint } = call.args;
  if (typeof mint !== 'string' || mint.trim() === '') {
    throw new Error('INVALID_MODEL_OUTPUT: Missing required string argument "mint"');
  }
  const trimmed = mint.trim();
  // Solana Base58 public key check: 32-44 alphanumeric characters omitting 0, O, I, l
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
    throw new Error(`INVALID_MODEL_OUTPUT: Argument "mint" failed validation: invalid base58 address bounds ("${trimmed}")`);
  }
  return { mint: trimmed };
}

/**
 * Calls the live Google Gemini API or returns a deterministic fixture.
 */
export async function callGeminiApi({
  apiKey,
  model = 'gemini-2.5-flash',
  contents,
  tools,
  toolConfig,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = { contents };
  if (tools) body.tools = [{ functionDeclarations: tools }];
  if (toolConfig) body.toolConfig = toolConfig;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error (HTTP ${res.status}): ${errText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the Gemini Reference Agent loop:
 * 1. Solicits a tool call from Gemini (or fixture).
 * 2. Validates tool arguments in application code.
 * 3. Dispatches paid provider call strictly through ShlitaAgentClient.proxy().
 * 4. Grounds developer outcome in verified SDK result.
 * 5. Returns function response to Gemini and returns full summary.
 */
export async function runGeminiAgent({
  agentClient,
  agentId,
  userPrompt = `What is the token metadata for ${SAMPLE_MINT}?`,
  mode = 'fixture',
  geminiApiKey = process.env.GEMINI_API_KEY,
  geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  idempotencyKey = `gemini-op-${Date.now()}`,
  simulate = false,
  customGeminiResponse = null,
  fetchImpl = globalThis.fetch,
}) {
  const isLive = mode === 'live';
  if (isLive && !geminiApiKey) {
    throw new Error('GEMINI_API_KEY is required for live Gemini mode.');
  }

  // 1. Initial Prompt & Model Response
  let modelResponse;
  if (isLive) {
    modelResponse = await callGeminiApi({
      apiKey: geminiApiKey,
      model: geminiModel,
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      tools: GEMINI_TOOL_DECLARATIONS,
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      fetchImpl,
    });
  } else {
    modelResponse = customGeminiResponse || FIXTURE_GEMINI_TOOL_CALL_RESPONSE;
  }

  // 2. Parse Candidates
  const candidate = modelResponse.candidates?.[0];
  if (!candidate?.content?.parts) {
    throw new Error('INVALID_MODEL_OUTPUT: Gemini returned an empty or malformed response');
  }

  const parts = candidate.content.parts;
  const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

  // Handle text-only response (no function call proposed)
  if (functionCalls.length === 0) {
    const textPart = parts.find((p) => p.text);
    return {
      mode: isLive ? `live (${geminiModel})` : 'fixture',
      userPrompt,
      toolDispatched: false,
      textOnlyResponse: textPart?.text || 'No function call proposed by model.',
      outcome: 'skipped_no_tool',
    };
  }

  // Explicitly enforce single tool dispatch per turn
  const call = functionCalls[0];

  // 3. Application-layer Tool Call Validation
  const validated = validateToolCall(call);

  // 4. Submit to Shlita Financial Control Plane
  // Provider host, HTTP method, and path are fixed in code.
  // Model controls only the validated query arguments (mint).
  const proxyResult = await agentClient.proxy({
    agentId,
    vendor: 'api.helius.xyz',
    method: 'POST',
    path: '/v0/token-metadata',
    body: { mints: [validated.mint] },
    idempotencyKey,
    simulate,
  });

  // 5. Build Grounded Developer Outcome
  const developerOutcome = {
    mode: isLive ? `live (${geminiModel})` : 'fixture',
    userPrompt,
    toolCall: {
      name: call.name,
      arguments: validated,
    },
    shlita: {
      outcome: proxyResult.outcome, // 'committed' | 'rejected' | 'conflict' | 'uncertain'
      operationId: proxyResult.operationId || null,
      reason: proxyResult.outcome === 'rejected' ? (proxyResult.reason || proxyResult.error || null) : null,
      reservedAmountMicroUsdc: proxyResult.cost?.reservedAmountMicroUsdc || null,
      fundsMoved: proxyResult.fundsMoved || false,
      provider: 'api.helius.xyz',
      endpoint: '/v0/token-metadata',
    },
    providerData: proxyResult.outcome === 'committed' ? proxyResult.upstream : null,
  };

  // 6. Return Structured Function Result to Gemini (if in live mode)
  let finalModelText = null;
  if (isLive) {
    try {
      const functionResponse = {
        status: proxyResult.outcome === 'committed' ? 'SUCCESS' : 'POLICY_REJECTED',
        outcome: proxyResult.outcome,
        reason: proxyResult.outcome === 'rejected' ? proxyResult.reason : undefined,
        data: proxyResult.outcome === 'committed' ? proxyResult.upstream : undefined,
      };

      const followUp = await callGeminiApi({
        apiKey: geminiApiKey,
        model: geminiModel,
        contents: [
          { role: 'user', parts: [{ text: userPrompt }] },
          { role: 'model', parts: [{ functionCall: call }] },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: call.name,
                  response: functionResponse,
                },
              },
            ],
          },
        ],
        // Mode NONE or omitted tools prevents model from attempting a second tool call
        toolConfig: { functionCallingConfig: { mode: 'NONE' } },
        fetchImpl,
      });

      finalModelText = followUp.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text || null;
    } catch (err) {
      finalModelText = `[Follow-up Gemini synthesis omitted: ${err.message}]`;
    }
  } else {
    finalModelText = FIXTURE_GEMINI_FINAL_RESPONSE.candidates[0].content.parts[0].text;
  }

  developerOutcome.modelSummary = finalModelText;
  return developerOutcome;
}
