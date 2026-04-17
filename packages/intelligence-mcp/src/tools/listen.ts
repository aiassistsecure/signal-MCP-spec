import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FRESHNESS, INTENTS } from "../constants.js";
import type { ApiClient } from "../api-client.js";
import { missingApiKey, structuredError } from "../errors.js";

/**
 * `listen` — Scans public sources for signals matching a natural-language query.
 * Spec §4.1. v0.1 ships the input contract; the query-expansion + classification
 * pipeline is stubbed pending the raw scanner response shape + source catalog.
 */

export const listenInputSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      "Natural-language description of what to listen for. Freeform; the server expands it into keywords automatically. Example: 'founders complaining about Clay being too expensive'.",
    ),
  scope: z
    .object({
      sources: z
        .array(z.string())
        .optional()
        .describe(
          "Specific source IDs from signal://catalog. Omit to let the server pick based on the query.",
        ),
      freshness: z
        .enum(FRESHNESS)
        .default("this_week")
        .describe("How far back to scan. Default: this_week."),
      min_engagement: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Drop signals below this score (upvotes, comments, etc.). Default 0."),
    })
    .optional()
    .describe("Where and how far to listen. All fields optional with sensible defaults."),
  intent_filter: z
    .array(z.enum(INTENTS))
    .optional()
    .describe(
      "Only surface signals whose classified intent matches one of these. Omit for all 10.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .default(20)
    .describe("Maximum signals to return. Max 100, default 20."),
} as const;

export const LISTEN_DESCRIPTION = [
  "Scan public sources for signals matching a natural-language query.",
  "Returns a stream of ranked signals with intent classification, author karma bucket, engagement, and `match_reason` explaining why each signal was surfaced.",
  "The `query` is freeform natural language — the server expands it to keywords; do not pre-extract.",
  "Omit `scope.sources` to let the server pick intelligently from signal://catalog; specify them for precision.",
  "Freshness defaults to this_week. Intent labels come from signal://lexicon — read it if you're unsure what a label means.",
].join(" ");

export interface ListenDeps {
  getClient: () => ApiClient | null;
}

export function registerListen(server: McpServer, deps: ListenDeps): void {
  server.registerTool(
    "listen",
    {
      title: "listen",
      description: LISTEN_DESCRIPTION,
      inputSchema: listenInputSchema,
    },
    async (_args) => {
      const client = deps.getClient();
      if (!client) throw missingApiKey();

      // v0.1 stub — pipeline lands once the raw scanner response shape +
      // source catalog are pinned. Implementation plan:
      //   1. POST /v1/intelligence/extract-keywords  (NL → keywords, per §4.1)
      //   2. POST /v1/intelligence/scan              (raw signals, no classification)
      //   3. POST /v1/chat/completions               (intent + match_reason per signal)
      //   4. Shape output per §4.1, stream via MCP progress notifications.
      throw structuredError({
        code: -32002,
        message: "`listen` pipeline not wired in v0.1 scaffold",
        reason:
          "Awaiting pinned raw scanner response shape and source catalog before implementing query expansion + intent classification.",
        suggested_action:
          "Track progress at https://github.com/aiassistsecure/signal-MCP-spec. The tool signature, validation, and description are final; only the pipeline body is stubbed.",
      });
    },
  );
}
