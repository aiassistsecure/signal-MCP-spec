import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { notImplementedInV0_1 } from "../errors.js";

/**
 * `brief` prompt (spec §6.3) — produces a daily/weekly brief template from
 * accumulated signals.
 *
 * v0.1: registered with the correct arg shape; body ships with v1.0.
 */

export function registerBrief(server: McpServer): void {
  server.registerPrompt(
    "brief",
    {
      title: "brief",
      description:
        "Produce a daily or weekly brief template from accumulated signals — 'what happened this week in my space', generated conversationally. Ships with v1.0.",
      argsSchema: {
        cadence: z
          .string()
          .optional()
          .describe("'daily' or 'weekly' (default 'weekly'). Controls the brief's time window and depth."),
        topic: z
          .string()
          .optional()
          .describe(
            "What's the brief about? e.g. 'Clay + enrichment competitors', 'Rails ecosystem hiring'. Optional — defaults to the user's recent listen queries.",
          ),
      },
    },
    () => {
      throw notImplementedInV0_1("brief prompt");
    },
  );
}
