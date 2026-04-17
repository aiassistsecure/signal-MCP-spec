import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * Structured error with a `suggested_action` field per spec §7.
 *
 * MCP SDK will surface `.data` back to the client on the JSON-RPC error envelope.
 */
export function structuredError(params: {
  code: number;
  message: string;
  suggested_action?: string;
  [key: string]: unknown;
}): McpError {
  const { code, message, ...rest } = params;
  return new McpError(code, message, rest);
}

/** -32002 — surface not available in this release. */
export function notImplementedInV0_1(surface: string, reason?: string): McpError {
  return structuredError({
    code: -32002,
    message: `\`${surface}\` is not available in v0.1`,
    reason: reason ?? "Shipping order per spec §13: listen + signal://lexicon + sweep as v0.1.",
    suggested_action:
      "Use `listen` for queries, read `signal://lexicon` for intent definitions, or use the `sweep` prompt to scope a search. Full surface coverage ships in v1.0.",
  });
}

/** -32001 — required configuration missing (typically AIAS_API_KEY). */
export function missingApiKey(): McpError {
  return structuredError({
    code: -32001,
    message: "AIAS_API_KEY is not configured",
    suggested_action:
      "Set AIAS_API_KEY in the MCP server environment to your aiassist.net bearer token (format: aai_*). In Claude Desktop: add it under `env` in the server config block.",
  });
}

export { ErrorCode };
