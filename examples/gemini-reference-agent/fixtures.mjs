/**
 * Deterministic fixtures for Shlita Gemini Reference Agent.
 * Used for CI, reproducible automated testing, and credential-free offline demos.
 */

export const SAMPLE_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // Bonk on Solana

export const FIXTURE_FUNCTION_CALL = {
  name: 'get_solana_token_metadata',
  args: {
    mint: SAMPLE_MINT,
  },
};

export const FIXTURE_GEMINI_TOOL_CALL_RESPONSE = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: FIXTURE_FUNCTION_CALL,
          },
        ],
      },
      finishReason: 'STOP',
    },
  ],
};

export const FIXTURE_GEMINI_FINAL_RESPONSE = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [
          {
            text: `Retrieved Solana token metadata for mint ${SAMPLE_MINT} via Helius RPC under Shlita spending policy protection.`,
          },
        ],
      },
      finishReason: 'STOP',
    },
  ],
};

export const FIXTURE_UPSTREAM_TOKEN_METADATA = {
  mint: SAMPLE_MINT,
  onChainMetadata: {
    metadata: {
      name: 'Bonk',
      symbol: 'BONK',
      uri: 'https://arweave.net/hptj89...json',
    },
  },
  legacyMetadata: {
    chainId: 101,
    name: 'Bonk',
    symbol: 'BONK',
    decimals: 5,
  },
};
