import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { notImplementedInV0_1 } from "../errors.js";

/**
 * `triage` prompt (spec §6.2) — given a batch of signals, asks the user which
 * ones matter and emits a filter spec the agent can apply on future listens.
 *
 * v0.1: registered with the correct arg shape; body ships with v1.0.
 */

export function registerTriage(server: McpServer): void {
  server.registerPrompt(
    "triage",
    {
      title: "triage",
      description:
        "Given a batch of signals, ask the user which ones matter and produce a reusable filter spec for future listens. Ships with v1.0.",
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
    () => {
      throw notImplementedInV0_1("triage prompt");
    },
  );
}
