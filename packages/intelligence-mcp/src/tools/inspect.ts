import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { INSPECT_DEPTHS } from "../constants.js";
import { notImplementedInV0_1 } from "../errors.js";

export const inspectInputSchema = {
  signal_id: z
    .string()
    .regex(/^sig_/, "signal_id must start with 'sig_'")
    .describe("The sig_... ID returned from a previous `listen` call."),
  depth: z
    .enum(INSPECT_DEPTHS)
    .default("thread")
    .describe(
      "surface = signal only (cache check). thread = include comments/replies (default). author = include author's recent posting history + likely_role_hint (lead qualification).",
    ),
} as const;

export const INSPECT_DESCRIPTION = [
  "Deep-dive on a single signal by ID.",
  "Use `thread` (default) for the common case of reading the full conversation.",
  "Use `surface` for a cheap existence check.",
  "Use `author` to qualify the poster — adds recent posts, domains, sentiment, and a likely_role_hint.",
  "Signal IDs come from `listen`.",
].join(" ");

export function registerInspect(server: McpServer): void {
  server.registerTool(
    "inspect",
    {
      title: "inspect",
      description: INSPECT_DESCRIPTION,
      inputSchema: inspectInputSchema,
    },
    async () => {
      throw notImplementedInV0_1("inspect");
    },
  );
}
