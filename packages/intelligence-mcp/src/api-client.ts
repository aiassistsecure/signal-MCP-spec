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

  private async request<T>(
    method: "GET" | "POST",
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
