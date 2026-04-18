import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { INSPECT_DEPTHS, type InspectDepth } from "../constants.js";
import type { ApiClient, IntelSignal } from "../api-client.js";
import type { Cache, CachedSignal } from "../cache.js";
import { missingApiKey, structuredError } from "../errors.js";
import { decodeSignalId } from "../signal-id.js";
import {
  classifyIntent,
  deriveFreshnessBucket,
  deriveKarmaBucket,
  makeExcerpt,
  toIso,
} from "../signal-shape.js";

/**
 * `inspect` — deep-dive on a single signal. Adjusted to what the current
 * backend supports per REALITY.md §1.
 *
 *   depth: "surface" — cache-first; rescan the originating source if missed
 *   depth: "thread"  — surface + full post body when scan truncated (no comments)
 *   depth: "author"  — surface + thread + single-source author context
 *
 * thread_completeness: "post_body_only" and author_context.scope: "single_source"
 * are MCP-emitted hints until the backend grows real endpoints
 * (BACKEND-GAPS §2).
 */

export const inspectInputSchema = {
  signal_id: z
    .string()
    .regex(/^sig_/, "signal_id must start with 'sig_'")
    .describe("The sig_... ID returned from a previous `listen` call."),
  depth: z
    .enum(INSPECT_DEPTHS)
    .default("thread")
    .describe(
      "surface = signal only (cache check). thread = include full post body when the scan truncated it (default). author = include single-source author context for qualification.",
    ),
} as const;

export const INSPECT_DESCRIPTION = [
  "Deep-dive on a single signal by ID.",
  "Use `thread` (default) to get the full post body beyond the listen excerpt.",
  "Use `surface` for a cheap existence check.",
  "Use `author` to qualify the poster — adds recent posts, domains, sentiment, and a likely_role_hint (scoped to the single source the signal came from).",
  "Note: in v1.0 the backend does not expose comment threads or cross-source author history, so `thread_completeness: \"post_body_only\"` and `author_context.scope: \"single_source\"` may appear on the response.",
].join(" ");

export interface InspectDeps {
  getClient: () => ApiClient | null;
  cache: Cache;
  getOrgId: () => string;
}

interface InspectArgs {
  signal_id: string;
  depth: InspectDepth;
}

export function registerInspect(server: McpServer, deps: InspectDeps): void {
  server.registerTool(
    "inspect",
    {
      title: "inspect",
      description: INSPECT_DESCRIPTION,
      inputSchema: inspectInputSchema,
    },
    async (rawArgs: unknown) => {
      const args = rawArgs as InspectArgs;
      const client = deps.getClient();
      if (!client) throw missingApiKey();

      const { signal_id, depth } = args;
      let decoded;
      try {
        decoded = decodeSignalId(signal_id);
      } catch (err) {
        throw structuredError({
          code: -32602,
          message: `Invalid signal_id: ${signal_id}`,
          reason: err instanceof Error ? err.message : String(err),
          suggested_action:
            "Use an ID emitted by a previous `listen` call. The format is sig_<base64url(source:native_id)>.",
        });
      }

      const cached = await deps.cache.getSignal(signal_id);
      const { raw, staleness } = cached
        ? { raw: cached.raw_result, staleness: null as null | string }
        : await findByRescan(client, decoded.source, decoded.nativeId, cached);

      if (!raw) {
        return textResult({
          signal: null,
          thread: [],
          author_context: null,
          staleness: staleness ?? "evicted_from_source_window",
        });
      }

      const shapedSignal = await shapeSignalForInspect(client, deps.cache, signal_id, raw, cached);

      if (depth === "surface") {
        return textResult({ signal: shapedSignal, thread: [], author_context: null });
      }

      const bodyFull = raw.body ?? raw.content ?? "";
      const excerpt = typeof shapedSignal["excerpt"] === "string" ? shapedSignal["excerpt"] : "";
      const thread =
        bodyFull.length > excerpt.length
          ? [
              {
                author: raw.author,
                body: bodyFull,
                score: raw.score,
                is_op_reply: true,
              },
            ]
          : [];

      if (depth === "thread") {
        return textResult({
          signal: shapedSignal,
          thread,
          author_context: null,
          thread_completeness: "post_body_only",
        });
      }

      // depth === "author"
      const author_context = await deriveAuthorContext(client, raw.author, raw.source);
      return textResult({
        signal: shapedSignal,
        thread,
        author_context: { ...author_context, scope: "single_source" },
        thread_completeness: "post_body_only",
      });
    },
  );
}

function textResult(obj: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

async function findByRescan(
  client: ApiClient,
  source: string,
  nativeId: string,
  cached: CachedSignal | null,
): Promise<{ raw: IntelSignal | null; staleness: string | null }> {
  const keywords = cached?.query_keywords ?? [];
  if (keywords.length === 0) {
    return {
      raw: null,
      staleness: "no_cached_keywords",
    };
  }
  try {
    const scan = await client.intelScan({
      sources: [source],
      keywords,
      limit: 50,
      category: "recent",
    });
    const match = scan.data.results.find((r) => String(r.id) === nativeId);
    return { raw: match ?? null, staleness: match ? null : "evicted_from_source_window" };
  } catch {
    return { raw: null, staleness: "rescan_failed" };
  }
}

async function shapeSignalForInspect(
  client: ApiClient,
  cache: Cache,
  sigId: string,
  raw: IntelSignal,
  cached: CachedSignal | null,
): Promise<Record<string, unknown>> {
  const cachedIntent = await cache.getIntent(sigId);
  const classification = cachedIntent
    ? {
        intent: cachedIntent.intent,
        intent_confidence: cachedIntent.intent_confidence,
        match_reason: cachedIntent.match_reason,
      }
    : await classifyIntent(client, {
        query: cached?.query_keywords?.join(" ") ?? raw.title,
        keywords: cached?.query_keywords ?? [],
        source: raw.source,
        title: raw.title,
        body: raw.body ?? raw.content ?? "",
        url: raw.url,
        author: raw.author,
        score: raw.score,
        num_comments: raw.num_comments,
      });

  if (!cachedIntent) {
    await cache.putIntent(sigId, {
      intent: classification.intent,
      intent_confidence: classification.intent_confidence,
      match_reason: classification.match_reason,
      classifier_version: "v1",
      classified_at: new Date().toISOString(),
    });
  }

  return {
    id: sigId,
    source: raw.source,
    url: raw.url,
    headline: raw.title,
    excerpt: makeExcerpt(raw.body ?? raw.content ?? ""),
    intent: classification.intent,
    intent_confidence: classification.intent_confidence,
    author: {
      handle: raw.author,
      karma_bucket: deriveKarmaBucket(raw.score),
    },
    engagement: {
      score: raw.score,
      comments: raw.num_comments,
    },
    captured_at: toIso(raw.created_utc),
    freshness_bucket: deriveFreshnessBucket(raw.created_utc),
    match_reason: classification.match_reason,
  };
}

interface AuthorContext {
  recent_posts_bucket: "dormant" | "light" | "active" | "prolific";
  domains_posted_in: string[];
  sentiment_7d: "positive" | "neutral" | "frustrated" | "mixed" | "unknown";
  likely_role_hint: "indie_founder" | "enterprise_dev" | "student" | "enthusiast" | "unknown";
}

async function deriveAuthorContext(
  client: ApiClient,
  handle: string,
  source: string,
): Promise<AuthorContext> {
  let authorPosts: IntelSignal[] = [];
  try {
    const scan = await client.intelScan({
      sources: [source],
      keywords: [handle],
      limit: 25,
      category: "recent",
    });
    authorPosts = scan.data.results.filter((r) => r.author === handle);
  } catch {
    // Continue with empty — author context degrades honestly.
  }

  const count = authorPosts.length;
  const recent_posts_bucket: AuthorContext["recent_posts_bucket"] =
    count === 0 ? "dormant" : count <= 2 ? "light" : count <= 10 ? "active" : "prolific";

  const domains_posted_in = Array.from(
    new Set(authorPosts.map((p) => p.subreddit ?? p.source).filter(Boolean) as string[]),
  );

  if (count === 0) {
    return {
      recent_posts_bucket,
      domains_posted_in,
      sentiment_7d: "unknown",
      likely_role_hint: "unknown",
    };
  }

  const corpus = authorPosts
    .slice(0, 10)
    .map((p) => `- ${p.title}\n  ${(p.body ?? p.content ?? "").slice(0, 300)}`)
    .join("\n\n");

  const systemPrompt = `You classify a single author from a small corpus of their recent posts.

Output strict JSON: { "sentiment_7d": "...", "likely_role_hint": "..." }

sentiment_7d enum: positive | neutral | frustrated | mixed | unknown
likely_role_hint enum: indie_founder | enterprise_dev | student | enthusiast | unknown

Rules:
- Single label each, strongest match.
- likely_role_hint: use 'unknown' when the posts don't indicate a clear role.
- No commentary, no code fences.`;

  try {
    const res = await client.chatCompletion({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Author: ${handle}\nSource: ${source}\n\nRecent posts:\n${corpus}` },
      ],
      temperature: 0.2,
      max_tokens: 80,
      response_format: { type: "json_object" },
    });
    const raw = res.choices[0]?.message?.content ?? "";
    const parsed = tryParseAuthorJson(raw);
    return {
      recent_posts_bucket,
      domains_posted_in,
      sentiment_7d: parsed.sentiment_7d,
      likely_role_hint: parsed.likely_role_hint,
    };
  } catch {
    return {
      recent_posts_bucket,
      domains_posted_in,
      sentiment_7d: "unknown",
      likely_role_hint: "unknown",
    };
  }
}

function tryParseAuthorJson(raw: string): {
  sentiment_7d: AuthorContext["sentiment_7d"];
  likely_role_hint: AuthorContext["likely_role_hint"];
} {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const o = JSON.parse(stripped) as Record<string, unknown>;
    const s = typeof o["sentiment_7d"] === "string" ? o["sentiment_7d"] : "unknown";
    const r = typeof o["likely_role_hint"] === "string" ? o["likely_role_hint"] : "unknown";
    const sentiments: AuthorContext["sentiment_7d"][] = [
      "positive",
      "neutral",
      "frustrated",
      "mixed",
      "unknown",
    ];
    const roles: AuthorContext["likely_role_hint"][] = [
      "indie_founder",
      "enterprise_dev",
      "student",
      "enthusiast",
      "unknown",
    ];
    return {
      sentiment_7d: (sentiments as readonly string[]).includes(s)
        ? (s as AuthorContext["sentiment_7d"])
        : "unknown",
      likely_role_hint: (roles as readonly string[]).includes(r)
        ? (r as AuthorContext["likely_role_hint"])
        : "unknown",
    };
  } catch {
    return { sentiment_7d: "unknown", likely_role_hint: "unknown" };
  }
}
