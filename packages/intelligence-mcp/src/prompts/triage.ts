import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * `triage` prompt (spec §6.2) — given a batch of signals, asks the user which
 * ones matter and emits a filter spec the agent can apply on future listens.
 *
 * The prompt body ships the workflow as a user-facing instruction; the actual
 * iteration happens in the client's conversation. We do not pre-render the
 * signals here because MCP prompts are static templates — the agent fills in
 * the `signal_ids` / `batch_ref` context by reading its own working memory.
 */

export function registerTriage(server: McpServer): void {
  server.registerPrompt(
    "triage",
    {
      title: "triage",
      description:
        "Walk the user through a batch of signals one-by-one, collect keep/drop decisions, and emit a reusable filter spec (sources + intent_filter + min_engagement) for future listens.",
      argsSchema: {
        batch_ref: z
          .string()
          .optional()
          .describe(
            "Reference to a previous listen result (e.g. a brief ID or session-local handle). Optional — the prompt can also ingest inline signal IDs.",
          ),
        signal_ids: z
          .string()
          .optional()
          .describe("Comma-separated sig_* IDs to triage. Use when there is no batch_ref."),
      },
    },
    (args) => {
      const batchRef = typeof args?.batch_ref === "string" ? args.batch_ref : "";
      const signalIds = typeof args?.signal_ids === "string" ? args.signal_ids : "";
      const scope = batchRef
        ? `batch ref: \`${batchRef}\``
        : signalIds
          ? `signal IDs: ${signalIds}`
          : "the most recent `listen` result in this conversation";

      return {
        description: "Triage a signal batch into a reusable filter spec.",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `You are triaging signals with the user. Source: ${scope}.`,
                "",
                "Procedure:",
                "1. If no batch is in scope, ask the user to rerun `listen` first. Do not invent signals.",
                "2. For each signal, present in this order: headline, source, intent, match_reason, 1-line excerpt. Keep it under 4 lines per signal.",
                "3. After each signal, ask the user exactly one of: keep / drop / needs-more (triggers `inspect depth=thread`).",
                "4. Do NOT batch questions. One signal, one decision.",
                "5. If the user says 'drop', ask in one follow-up: source, intent, or author — which dimension caused it? Record only their answer.",
                "",
                "When every signal is decided, emit a final JSON block, nothing else, in this exact shape:",
                "",
                "```json",
                "{",
                "  \"kept\": [\"sig_...\"],",
                "  \"dropped\": [{ \"id\": \"sig_...\", \"reason\": \"source|intent|author|other\" }],",
                "  \"filter_spec\": {",
                "    \"sources\": [\"source-ids-to-keep\"],",
                "    \"intent_filter\": [\"intent-labels-to-keep\"],",
                "    \"min_engagement\": 0",
                "  }",
                "}",
                "```",
                "",
                "Rules:",
                "- Derive `filter_spec` from the drop reasons. If >50% of drops are 'intent', tighten `intent_filter` to only kept intents.",
                "- If >50% of drops are 'source', drop those source IDs.",
                "- `min_engagement` defaults to the 25th-percentile (score+comments) of kept signals. Round to nearest 10.",
                "- Never invent sources or intents not present in this batch.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );
}
