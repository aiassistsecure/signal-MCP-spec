import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DISPATCH_ACTIONS } from "../constants.js";
import { notImplementedInV0_1 } from "../errors.js";

export const dispatchInputSchema = {
  signal_id: z
    .string()
    .regex(/^sig_/, "signal_id must start with 'sig_'")
    .describe("The sig_... ID to act on."),
  action: z
    .enum(DISPATCH_ACTIONS)
    .describe(
      "What to do with this signal. archive = mark handled. flag = highlight for review. route = forward to a destination. draft_reply = generate a response. schedule_followup = queue a later action.",
    ),
  params: z
    .object({
      commit: z
        .boolean()
        .optional()
        .describe(
          "Two-phase commit (spec §4.3). Default false. Actions return status='staged' unless commit=true; follow up with the returned handle to execute.",
        ),
    })
    .passthrough()
    .optional()
    .describe("Action-specific params. See each action's docs."),
} as const;

export const DISPATCH_DESCRIPTION = [
  "Take an action on a signal — archive, flag, route, draft_reply, or schedule_followup.",
  "By default actions are STAGED and DO NOT execute — the agent proposes, the caller commits.",
  "To actually fire the action, call `dispatch` again with the same signal_id/action and params.commit = true, referencing the returned handle.",
  "Two-phase commit is the default for anything with side effects.",
].join(" ");

export function registerDispatch(server: McpServer): void {
  server.registerTool(
    "dispatch",
    {
      title: "dispatch",
      description: DISPATCH_DESCRIPTION,
      inputSchema: dispatchInputSchema,
    },
    async () => {
      throw notImplementedInV0_1("dispatch");
    },
  );
}
