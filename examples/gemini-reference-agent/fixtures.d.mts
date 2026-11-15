export const SAMPLE_MINT: string;

export const FIXTURE_FUNCTION_CALL: {
  name: string;
  args: {
    mint: string;
  };
};

export const FIXTURE_GEMINI_TOOL_CALL_RESPONSE: {
  candidates: Array<{
    content: {
      role: string;
      parts: Array<{
        functionCall?: {
          name: string;
          args: Record<string, unknown>;
        };
        text?: string;
      }>;
    };
    finishReason: string;
  }>;
};

export const FIXTURE_GEMINI_FINAL_RESPONSE: {
  candidates: Array<{
    content: {
      role: string;
      parts: Array<{
        text: string;
      }>;
    };
    finishReason: string;
  }>;
};

export const FIXTURE_UPSTREAM_TOKEN_METADATA: Record<string, unknown>;
