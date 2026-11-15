import type { ShlitaAgentClient, ShlitaOperatorClient } from '../../packages/sdk/src/index.js';

export { ShlitaAgentClient, ShlitaOperatorClient };

export const GEMINI_TOOL_DECLARATIONS: Array<{
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}>;

export function validateToolCall(call: unknown): { mint: string };

export function callGeminiApi(options: {
  apiKey: string;
  model?: string;
  contents: unknown[];
  tools?: unknown[];
  toolConfig?: unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<any>;

export interface RunGeminiAgentParams {
  agentClient: ShlitaAgentClient;
  agentId: string;
  userPrompt?: string;
  mode?: 'fixture' | 'live' | string;
  geminiApiKey?: string;
  geminiModel?: string;
  idempotencyKey?: string;
  simulate?: boolean;
  customGeminiResponse?: unknown;
  fetchImpl?: typeof fetch;
}

export interface RunGeminiAgentResult {
  mode: string;
  userPrompt: string;
  toolCall?: {
    name: string;
    arguments: { mint: string };
  };
  shlita: {
    outcome: 'committed' | 'rejected' | 'conflict' | 'uncertain';
    operationId: string | null;
    reason: string | null;
    reservedAmountMicroUsdc: string | null;
    fundsMoved: boolean;
    provider: string;
    endpoint: string;
  };
  providerData?: unknown;
  modelSummary?: string | null;
  toolDispatched?: boolean;
  textOnlyResponse?: string;
}

export function runGeminiAgent(params: RunGeminiAgentParams): Promise<RunGeminiAgentResult>;
