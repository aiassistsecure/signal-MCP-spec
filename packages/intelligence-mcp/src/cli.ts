#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const apiKey = process.env["AIAS_API_KEY"];
  const apiBaseUrl = process.env["AIAS_API_BASE_URL"];

  const { server } = createServer({
    apiKey,
    apiBaseUrl,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdio stays open until the client closes it.
  // Log to stderr so we do not pollute the stdio JSON-RPC stream.
  if (!apiKey) {
    process.stderr.write(
      "[signal-mcp] AIAS_API_KEY is not set — tools that call api.aiassist.net will return -32001 errors until it's configured.\n",
    );
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[signal-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
