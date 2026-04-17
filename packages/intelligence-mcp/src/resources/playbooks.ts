import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { notImplementedInV0_1 } from "../errors.js";

export function registerPlaybooksResource(server: McpServer): void {
  server.registerResource(
    "playbooks",
    "signal://playbooks",
    {
      title: "Playbooks",
      description:
        "Executable workflow recipes composed of listen/inspect/dispatch calls. Gives the agent a starting point for common tasks (competitor-churn mining, hiring-signal monitoring, weekly briefs) instead of re-deriving the sequence each session.",
      mimeType: "application/json",
    },
    async () => {
      throw notImplementedInV0_1(
        "signal://playbooks",
        "Playbooks land with v1.0 alongside `inspect` and `dispatch`.",
      );
    },
  );
}
