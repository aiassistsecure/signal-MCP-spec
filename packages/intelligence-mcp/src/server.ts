import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiClient, type ApiClientOptions } from "./api-client.js";
import { Cache, type CacheBackend } from "./cache.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { registerListen } from "./tools/listen.js";
import { registerInspect } from "./tools/inspect.js";
import { registerDispatch } from "./tools/dispatch.js";
import { registerCatalogResource } from "./resources/catalog.js";
import { registerLexiconResource } from "./resources/lexicon.js";
import { registerPlaybooksResource } from "./resources/playbooks.js";
import { registerSweep } from "./prompts/sweep.js";
import { registerTriage } from "./prompts/triage.js";
import { registerBrief } from "./prompts/brief.js";

export interface CreateServerOptions {
  /** User's aiassist.net bearer token (format: aai_*). Leave unset to allow server boot without credentials — tools will error until configured. */
  apiKey?: string | undefined;
  /** Override api.aiassist.net base URL (for staging / self-hosted). */
  apiBaseUrl?: string | undefined;
  /** Override the ApiClient construction entirely (tests). */
  apiClient?: ApiClient | undefined;
  /** Extra options passed through to the ApiClient. */
  apiClientOptions?: Omit<ApiClientOptions, "apiKey" | "baseUrl"> | undefined;
  /** Override the cache backend (defaults to in-memory). */
  cacheBackend?: CacheBackend | undefined;
  /** Fallback org id used until a real one is resolved from the API. */
  orgId?: string | undefined;
}

export interface CreatedServer {
  server: McpServer;
  /** The active ApiClient, or null if no apiKey was provided. */
  apiClient: ApiClient | null;
  /** The cache instance used by listen/inspect/dispatch. */
  cache: Cache;
}

/**
 * Build a configured `signal` MCP server with all 9 surfaces registered.
 *
 * v0.1 ships the full surface area (so `tools/list`, `resources/list`,
 * `prompts/list` return the correct counts per §15 conformance), but only
 * `signal://lexicon` and the `sweep` prompt have real bodies. The other
 * surfaces register validated schemas + descriptions and return structured
 * `-32002` errors with `suggested_action` until v1.0.
 */
export function createServer(options: CreateServerOptions = {}): CreatedServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: true, listChanged: false },
        prompts: { listChanged: false },
        logging: {},
      },
    },
  );

  const apiClient = buildApiClient(options);
  const cache = new Cache(options.cacheBackend);
  // Org scoping: set via AIAS_ORG_ID (or options.orgId) for multi-tenant
  // deployments; "default" is fine for single-user stdio use. If we later
  // want live resolution, do it lazily from a tool call — we avoid firing
  // background requests from createServer so test boot stays offline.
  const orgIdValue = options.orgId ?? "default";
  const getOrgId = (): string => orgIdValue;

  const deps = { getClient: () => apiClient, cache, getOrgId };
  registerListen(server, deps);
  registerInspect(server, deps);
  registerDispatch(server, deps);

  registerCatalogResource(server, { getClient: () => apiClient });
  registerLexiconResource(server);
  registerPlaybooksResource(server);

  registerSweep(server);
  registerTriage(server);
  registerBrief(server);

  return { server, apiClient, cache };
}

function buildApiClient(options: CreateServerOptions): ApiClient | null {
  if (options.apiClient) return options.apiClient;
  if (!options.apiKey) return null;
  return new ApiClient({
    apiKey: options.apiKey,
    ...(options.apiBaseUrl ? { baseUrl: options.apiBaseUrl } : {}),
    ...(options.apiClientOptions ?? {}),
  });
}
