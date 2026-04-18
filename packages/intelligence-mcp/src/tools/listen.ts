import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FRESHNESS, INTENTS, type Freshness, type Intent } from "../constants.js";
import type { ApiClient, IntelSignal } from "../api-client.js";
import type { Cache } from "../cache.js";
import { missingApiKey, structuredError } from "../errors.js";
import { mintSignalId } from "../signal-id.js";
import {
  classifyIntent,
  deriveFreshnessBucket,
  deriveKarmaBucket,
  makeExcerpt,
  toIso,
} from "../signal-shape.js";

/**
 * `listen` — scan public sources, classify, shape, stream.
 *
 * Pipeline (REALITY.md §4 / inferred from §5.1 reference-sketch):
 *   1. POST /v1/intelligence/extract-keywords     — NL → keywords
 *   2. POST /v1/intelligence/scan                 — raw, unclassified signals
 *   3. POST /v1/chat/completions (per signal)     — intent + match_reason
 *   4. Shape per §4.1, write to mcp:signal:<id> cache for `inspect` reuse,
 *      emit progress notifications if the client sent a progressToken,
 *      return the final batch as the tool result.
 *
 * Archive/flag Redis sets are consulted — archived IDs are dropped, flagged
 * IDs are decorated with `flagged: true` + note.
 */

export const listenInputSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      "Natural-language description of what to listen for. Freeform; the server expands it into keywords automatically. Example: 'founders complaining about Clay being too expensive'.",
    ),
  scope: z
    .object({
      sources: z
        .array(z.string())
        .optional()
        .describe(
          "Specific source IDs from signal://catalog. Omit to let the server pick based on the query (defaults to all free sources).",
        ),
      freshness: z
        .enum(FRESHNESS)
        .default("this_week")
        .describe("How far back to scan. Default: this_week."),
      min_engagement: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Drop signals below this score (score + comment count). Default 0."),
    })
    .optional()
    .describe("Where and how far to listen. All fields optional with sensible defaults."),
  intent_filter: z
    .array(z.enum(INTENTS))
    .optional()
    .describe(
      "Only surface signals whose classified intent matches one of these. Omit for all 10.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .default(20)
    .describe("Maximum signals to return. Max 100, default 20."),
} as const;

export const LISTEN_DESCRIPTION = [
  "Scan public sources for signals matching a natural-language query.",
  "Returns ranked signals with intent classification, author karma bucket, engagement, and `match_reason` explaining why each signal was surfaced.",
  "The `query` is freeform natural language — the server expands it to keywords; do not pre-extract.",
  "Omit `scope.sources` to let the server pick intelligently from signal://catalog; specify them for precision.",
  "Freshness defaults to this_week. Intent labels come from signal://lexicon — read it if you're unsure what a label means.",
  "Signals carry deterministic `sig_<...>` IDs — the same source post always resolves the same way.",
].join(" ");

export interface ListenDeps {
  getClient: () => ApiClient | null;
  cache: Cache;
  getOrgId: () => string;
}

interface ListenArgs {
  query: string;
  scope?: {
    sources?: string[];
    freshness: Freshness;
    min_engagement?: number;
  };
  intent_filter?: Intent[];
  limit: number;
}

export function registerListen(server: McpServer, deps: ListenDeps): void {
  server.registerTool(
    "listen",
    {
      title: "listen",
      description: LISTEN_DESCRIPTION,
      inputSchema: listenInputSchema,
    },
    async (rawArgs: unknown, extra: unknown) => {
      const args = rawArgs as ListenArgs;
      const client = deps.getClient();
      if (!client) throw missingApiKey();

      const freshness: Freshness = args.scope?.freshness ?? "this_week";
      const minEngagement = args.scope?.min_engagement ?? 0;
      const limit = args.limit;
      const intentFilter = args.intent_filter;
      const orgId = deps.getOrgId();

      // 1. Keyword expansion
      let keywords: string[];
      try {
        const kwRes = await client.intelExtractKeywords({ prompt: args.query });
        keywords = (kwRes.data.keywords ?? []).filter((k) => typeof k === "string" && k.length > 0);
        if (keywords.length === 0) keywords = [args.query];
      } catch (err) {
        throw wrapUpstream(err, "extract-keywords", args.query);
      }

      // 2. Source selection
      let sources = args.scope?.sources;
      if (!sources || sources.length === 0) {
        try {
          const env = await client.intelSources();
          sources = env.data.sources.filter((s) => !s.premium).map((s) => s.name);
        } catch (err) {
          throw wrapUpstream(err, "sources", args.query);
        }
      }

      // 3. Raw scan (oversample — we filter client-side for freshness/engagement/archived)
      const scanLimit = Math.min(100, Math.max(limit * 3, 40));
      let signals: IntelSignal[];
      try {
        const scan = await client.intelScan({
          sources,
          keywords,
          limit: scanLimit,
          category: "recent",
        });
        signals = scan.data.results;
      } catch (err) {
        throw wrapUpstream(err, "scan", args.query);
      }

      // 4. Client-side filters: freshness, min_engagement, archived
      const cutoffSec = freshnessCutoffSec(freshness);
      const candidates: Array<{ raw: IntelSignal; sigId: string }> = [];
      for (const raw of signals) {
        if (cutoffSec !== null && raw.created_utc < cutoffSec) continue;
        if (raw.score + raw.num_comments < minEngagement) continue;
        const sigId = mintSignalId(raw.source, raw.id);
        if (await deps.cache.isArchived(orgId, sigId)) continue;
        candidates.push({ raw, sigId });
      }

      // Trim to limit BEFORE classification — spare the LLM calls.
      const trimmed = candidates.slice(0, limit);

      // 5. Classify intent + match_reason in parallel. Stream progress if the
      // client supplied a progressToken. Write cache entries along the way.
      const progressToken = extractProgressToken(extra);
      const sendProgress = makeProgressSender(extra, progressToken, trimmed.length);

      let completed = 0;
      const shaped = await Promise.all(
        trimmed.map(async ({ raw, sigId }) => {
          const cachedIntent = await deps.cache.getIntent(sigId);
          const classification =
            cachedIntent ??
            (await classifyIntent(client, {
              query: args.query,
              keywords,
              source: raw.source,
              title: raw.title,
              body: raw.body ?? raw.content ?? "",
              url: raw.url,
              author: raw.author,
              score: raw.score,
              num_comments: raw.num_comments,
            }));

          if (!cachedIntent) {
            await deps.cache.putIntent(sigId, {
              intent: classification.intent,
              intent_confidence: classification.intent_confidence,
              match_reason: classification.match_reason,
              classifier_version: "v1",
              classified_at: new Date().toISOString(),
            });
          }

          await deps.cache.putSignal(sigId, {
            source: raw.source,
            native_id: String(raw.id),
            query_keywords: keywords,
            scanned_at: new Date().toISOString(),
            raw_result: raw,
          });

          const flag = await deps.cache.getFlag(orgId, sigId);
          const shapedSignal = {
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
            ...(flag?.flagged
              ? { flagged: true, ...(flag.note ? { flag_note: flag.note } : {}) }
              : {}),
          };

          completed++;
          await sendProgress(completed, shapedSignal);
          return shapedSignal;
        }),
      );

      // 6. Intent filter (post-classification)
      const filtered = intentFilter
        ? shaped.filter((s) => intentFilter.includes(s.intent as Intent))
        : shaped;

      const payload = {
        query: args.query,
        query_keywords: keywords,
        sources_scanned: sources,
        signal_count: filtered.length,
        signals: filtered,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    },
  );
}

function freshnessCutoffSec(f: Freshness): number | null {
  const now = Math.floor(Date.now() / 1000);
  switch (f) {
    case "last_hour":
      return now - 60 * 60;
    case "today":
      return now - 24 * 60 * 60;
    case "this_week":
      return now - 7 * 24 * 60 * 60;
    case "this_month":
      return now - 30 * 24 * 60 * 60;
    case "any":
      return null;
  }
}

function extractProgressToken(extra: unknown): string | number | null {
  if (!extra || typeof extra !== "object") return null;
  const meta = (extra as { _meta?: { progressToken?: string | number } })._meta;
  return meta?.progressToken ?? null;
}

function makeProgressSender(
  extra: unknown,
  progressToken: string | number | null,
  total: number,
): (progress: number, signal: unknown) => Promise<void> {
  if (progressToken === null || !extra || typeof extra !== "object") {
    return async () => {
      /* no-op */
    };
  }
  const send = (extra as { sendNotification?: (n: unknown) => Promise<void> }).sendNotification;
  if (!send) {
    return async () => {
      /* no-op */
    };
  }
  return async (progress, signal) => {
    try {
      await send({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          total,
          message: `classified ${progress}/${total}`,
          data: signal,
        },
      });
    } catch {
      /* progress is best-effort */
    }
  };
}

function wrapUpstream(err: unknown, stage: string, query: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  return structuredError({
    code: -32011,
    message: `listen failed at ${stage}: ${message}`,
    stage,
    query,
    suggested_action:
      stage === "extract-keywords"
        ? "The NL→keywords call failed. Retry with a simpler query, or pass keywords implicitly via quoted terms."
        : stage === "scan"
          ? "The scanner call failed. Retry with `scope.sources` narrowed to one or two sources to isolate the failure."
          : "Verify AIAS_API_KEY is valid and api.aiassist.net is reachable.",
  });
}
