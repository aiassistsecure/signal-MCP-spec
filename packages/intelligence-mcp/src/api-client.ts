import { DEFAULT_API_BASE_URL } from "./constants.js";

export interface ApiClientOptions {
  /** Bearer token for api.aiassist.net — user's `aai_*` key. */
  apiKey: string;
  /** Override base URL (default: https://api.aiassist.net). */
  baseUrl?: string;
  /** Optional fetch implementation (for tests). */
  fetchImpl?: typeof fetch;
  /** Per-request default timeout in ms (default: 30_000). */
  timeoutMs?: number;
  /** User-Agent suffix; the package identifier is always included. */
  userAgentSuffix?: string;
}

// ─── Wire types (api.aiassist.net shapes per REALITY.md §0 / §4.1) ─────────

export interface IntelEnvelopeMeta {
  request_id?: string;
  timestamp: string;
  version: string;
  org_id: string;
  processing_ms: number;
}

export interface IntelEnvelope<T> {
  data: T;
  meta: IntelEnvelopeMeta;
}

export interface IntelSource {
  name: string;
  premium: boolean;
  provider: "free" | "netrows";
}

export interface IntelScanRequest {
  sources: string[];
  keywords?: string[];
  limit?: number;
  category?: string;
  subreddits?: string[];
}

export interface IntelSignal {
  id: string;
  source: string;
  subreddit?: string;
  title: string;
  body?: string;
  content?: string;
  url: string;
  author: string;
  score: number;
  num_comments: number;
  created_utc: number;
}

export interface IntelScanData {
  results: IntelSignal[];
  total: number;
  sources_scanned: string[];
  sources_failed: { source: string; error: string }[];
}

export interface ExtractKeywordsRequest {
  prompt: string;
  existing_keywords?: string[];
  model?: string;
  provider?: string;
}

export interface ExtractKeywordsData {
  keywords: string[];
  [k: string]: unknown;
}

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatCompletionMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" };
}

export interface ChatCompletionResponse {
  choices: { message: { role: string; content: string } }[];
  model: string;
  [k: string]: unknown;
}

export interface ContactCreateBody {
  name: string;
  email?: string | null;
  source?: string;
  notes?: string;
  lifecycle_stage?: string;
  workspace_id?: string;
}

export interface ContactCreateResponse {
  id: string;
  [k: string]: unknown;
}

export interface LeadCaptureBody {
  email: string;
  name?: string;
  source?: string;
  notes?: string;
  workspace_id?: string;
}

export interface LeadCaptureResponse {
  id: string;
  [k: string]: unknown;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly endpoint: string;

  constructor(params: { status: number; body: unknown; endpoint: string; message: string }) {
    super(params.message);
    this.name = "ApiClientError";
    this.status = params.status;
    this.body = params.body;
    this.endpoint = params.endpoint;
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/**
 * Thin wrapper around api.aiassist.net.
 *
 * Auth: single Bearer `aai_*` token (user's account key) passed through on every
 * request. BYOK is handled upstream — api.aiassist.net federates openai /
 * anthropic / gemini / groq / mistral via X-AiAssist-Provider header + stored
 * per-account provider keys. The MCP server stays provider-agnostic.
 */
export class ApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: ApiClientOptions) {
    if (!options.apiKey) {
      throw new Error("ApiClient requires an apiKey (AIAS_API_KEY).");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    const base = `@aiassist-secure/intelligence-mcp/0.1.0`;
    this.userAgent = options.userAgentSuffix ? `${base} ${options.userAgentSuffix}` : base;
  }

  async get<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, undefined, opts);
  }

  async post<T>(path: string, body: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, body, opts);
  }

  async patch<T>(path: string, body: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("PATCH", path, body, opts);
  }

  // ─── Typed endpoint helpers ──────────────────────────────────────────────

  intelSources(opts?: RequestOptions): Promise<IntelEnvelope<{ sources: IntelSource[] }>> {
    return this.get("/v1/intelligence/sources", opts ?? {});
  }

  intelScan(body: IntelScanRequest, opts?: RequestOptions): Promise<IntelEnvelope<IntelScanData>> {
    return this.post("/v1/intelligence/scan", body, opts ?? {});
  }

  intelExtractKeywords(
    body: ExtractKeywordsRequest,
    opts?: RequestOptions,
  ): Promise<IntelEnvelope<ExtractKeywordsData>> {
    return this.post("/v1/intelligence/extract-keywords", body, opts ?? {});
  }

  chatCompletion(body: ChatCompletionRequest, opts?: RequestOptions): Promise<ChatCompletionResponse> {
    return this.post("/v1/chat/completions", body, opts ?? {});
  }

  createContact(body: ContactCreateBody, opts?: RequestOptions): Promise<ContactCreateResponse> {
    return this.post("/api/contacts", body, opts ?? {});
  }

  captureLead(body: LeadCaptureBody, opts?: RequestOptions): Promise<LeadCaptureResponse> {
    return this.post("/api/leads/capture", body, opts ?? {});
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body: unknown,
    opts: RequestOptions,
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const signal = opts.signal
      ? anySignal([opts.signal, controller.signal])
      : controller.signal;

    try {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": this.userAgent,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...opts.headers,
        },
        signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await this.fetchImpl(url, init);

      const text = await res.text();
      const parsed: unknown = text ? safeJson(text) : undefined;

      if (!res.ok) {
        throw new ApiClientError({
          status: res.status,
          body: parsed ?? text,
          endpoint: path,
          message: `api.aiassist.net ${method} ${path} failed: ${res.status} ${res.statusText}`,
        });
      }

      return parsed as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}
