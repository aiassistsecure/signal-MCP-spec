import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { notImplementedInV0_1 } from "../errors.js";

export function registerCatalogResource(server: McpServer): void {
  server.registerResource(
    "catalog",
    "signal://catalog",
    {
      title: "Source catalog",
      description:
        "Source registry with strengths/weaknesses metadata. Read this before calling `listen` with `scope.sources` — the catalog tells the agent which sources suit which queries.",
      mimeType: "application/json",
    },
    async () => {
      // v0.1 stub — wired once the authoritative source list is provided.
      // Will be populated from GET /v1/intelligence/sources on api.aiassist.net.
      throw notImplementedInV0_1(
        "signal://catalog",
        "Awaiting authoritative source list + strengths/weaknesses copy.",
      );
    },
  );
}
