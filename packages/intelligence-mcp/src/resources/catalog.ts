import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api-client.js";
import { missingApiKey, structuredError } from "../errors.js";

/**
 * `signal://catalog` — source registry resource (spec §5.1).
 *
 * Implementation per REALITY.md §3 + §5.4:
 *   1. Pull live source list from `GET /v1/intelligence/sources` (authoritative
 *      for which sources are enabled + which are premium).
 *   2. Overlay MCP-side static strengths/weaknesses/kind/filters metadata.
 *      The backend does not emit these yet (BACKEND-GAPS §4.1 tracks the
 *      server-side version); they live here until it does.
 */

export interface CatalogSource {
  id: string;
  kind: string;
  regions: string[];
  update_cadence: string;
  strengths: string[];
  weaknesses: string[];
  filters: string[];
  premium: boolean;
  provider: string;
}

/**
 * Static metadata for every source in `aias_production_april/api/saas/sources.py`.
 * Keep keys aligned with the backend `SOURCE_REGISTRY`.
 */
export const SOURCE_METADATA: Record<string, Omit<CatalogSource, "id" | "premium" | "provider">> = {
  reddit: {
    kind: "forum",
    regions: ["en", "multilingual"],
    update_cadence: "realtime",
    strengths: [
      "product complaints and frustrations",
      "hiring and freelance signals",
      "technical discussions with raw detail",
      "subreddit-level topical sharpness",
    ],
    weaknesses: [
      "anonymized authors — low cross-post identity",
      "noisy for enterprise topics",
      "heavy karma-farming in some subs",
    ],
    filters: ["subreddit", "min_score", "flair"],
  },
  hackernews: {
    kind: "forum",
    regions: ["en"],
    update_cadence: "realtime",
    strengths: [
      "founder-grade launches and post-mortems",
      "deep technical threads",
      "early-stage build-in-public signals",
    ],
    weaknesses: [
      "single-community bias",
      "topical skew toward YC/SV priors",
      "comment threads can dominate signal",
    ],
    filters: ["min_score", "story_type"],
  },
  devto: {
    kind: "blog_platform",
    regions: ["en", "multilingual"],
    update_cadence: "hourly",
    strengths: [
      "long-form technical posts",
      "practitioner tutorials",
      "author-owned archives",
    ],
    weaknesses: [
      "content-marketing heavy",
      "lower real-time signal than forums",
    ],
    filters: ["tag", "username"],
  },
  lobsters: {
    kind: "forum",
    regions: ["en"],
    update_cadence: "realtime",
    strengths: ["curated low-noise tech discussion", "strong signal on infra/systems topics"],
    weaknesses: ["small community", "invite-only culture — fewer posts than HN"],
    filters: ["tag"],
  },
  hashnode: {
    kind: "blog_platform",
    regions: ["en"],
    update_cadence: "hourly",
    strengths: ["developer long-form", "web3/dev-tools focused authors"],
    weaknesses: ["self-promotional posts common", "less real-time than HN"],
    filters: ["tag"],
  },
  betalist: {
    kind: "launch_feed",
    regions: ["en"],
    update_cadence: "daily",
    strengths: ["early-stage SaaS launches before ProductHunt day"],
    weaknesses: ["submission-only — no organic discussion", "high spam ratio in some weeks"],
    filters: [],
  },
  echojs: {
    kind: "aggregator",
    regions: ["en"],
    update_cadence: "hourly",
    strengths: ["JS ecosystem-focused", "low-noise aggregation"],
    weaknesses: ["niche audience", "no discussion — link aggregator only"],
    filters: [],
  },
  wip: {
    kind: "community",
    regions: ["en"],
    update_cadence: "daily",
    strengths: ["indie maker daily updates", "build-in-public signal-to-noise is high"],
    weaknesses: ["small community", "self-selected founder cohort"],
    filters: [],
  },
  launchingnext: {
    kind: "launch_feed",
    regions: ["en"],
    update_cadence: "daily",
    strengths: ["upcoming launches before they hit PH"],
    weaknesses: ["submission-only", "lower traffic than BetaList"],
    filters: [],
  },
  hackernoon: {
    kind: "blog_platform",
    regions: ["en"],
    update_cadence: "hourly",
    strengths: ["long-form tech essays", "occasional industry-insider posts"],
    weaknesses: ["content-marketing dominant", "quality variance is high"],
    filters: ["tag"],
  },
  makerlog: {
    kind: "community",
    regions: ["en"],
    update_cadence: "daily",
    strengths: ["indie maker task streams", "daily build-in-public telemetry"],
    weaknesses: ["very small user base", "mostly tiny-task log entries"],
    filters: [],
  },
  alternativeto: {
    kind: "directory",
    regions: ["en"],
    update_cadence: "daily",
    strengths: ["comparison and substitute-seeking signals", "explicit category intent"],
    weaknesses: ["listings-heavy, low discussion", "SEO-oriented content"],
    filters: ["category"],
  },
  saashub: {
    kind: "directory",
    regions: ["en"],
    update_cadence: "daily",
    strengths: ["SaaS alternatives and reviews", "buyer-intent discovery"],
    weaknesses: ["listings-heavy, low first-hand signal"],
    filters: ["category"],
  },
  tldr: {
    kind: "newsletter_feed",
    regions: ["en"],
    update_cadence: "daily",
    strengths: ["editorially curated daily summary of tech news"],
    weaknesses: ["lossy — summaries not originals", "no discussion"],
    filters: [],
  },
  changelog: {
    kind: "podcast_feed",
    regions: ["en"],
    update_cadence: "weekly",
    strengths: ["interviewed operator voices", "backlinks to original launches"],
    weaknesses: ["audio-first — text extraction lossy", "weekly cadence"],
    filters: [],
  },
  indiehackers: {
    kind: "community",
    regions: ["en"],
    update_cadence: "hourly",
    strengths: [
      "bootstrapper revenue + churn signals",
      "long-form founder posts",
      "strong evaluation/comparing intent",
    ],
    weaknesses: ["community culture skews positive — complaints often softened"],
    filters: ["category"],
  },
  producthunt: {
    kind: "launch_feed",
    regions: ["en", "multilingual"],
    update_cadence: "daily",
    strengths: ["launch-day announcements", "hunter commentary occasionally substantive"],
    weaknesses: ["gamified — upvotes != signal quality", "polite-comment norm"],
    filters: ["topic"],
  },
  telegram: {
    kind: "chat",
    regions: ["multilingual"],
    update_cadence: "realtime",
    strengths: ["non-English and non-Western signal", "operator and trader channels"],
    weaknesses: ["channel-scoped — requires known channel list", "high spam in open channels"],
    filters: ["channel"],
  },
  twitter: {
    kind: "microblog",
    regions: ["multilingual"],
    update_cadence: "realtime",
    strengths: [
      "breaking signals minutes before forums",
      "strong evaluation/complaining intent from real accounts",
      "verified operator voices",
    ],
    weaknesses: ["rate-limited API", "noise-to-signal ratio low without keyword discipline"],
    filters: ["username", "hashtag", "min_followers"],
  },
  linkedin_jobs: {
    kind: "job_board",
    regions: ["multilingual"],
    update_cadence: "hourly",
    strengths: ["hiring-intent signals straight from the source", "company-level metadata"],
    weaknesses: ["structured JDs only — low freeform signal", "requires netrows credentials"],
    filters: ["title", "location", "seniority"],
  },
  linkedin_people: {
    kind: "professional_network",
    regions: ["multilingual"],
    update_cadence: "hourly",
    strengths: [
      "first-person announcing intent (new role, funding, launch)",
      "high-fidelity author identity",
    ],
    weaknesses: ["broadcast-style posts — low complaint signal", "engagement gamified"],
    filters: ["keyword", "industry"],
  },
  google_news: {
    kind: "news_aggregator",
    regions: ["multilingual"],
    update_cadence: "realtime",
    strengths: ["press-release and breaking-news coverage", "cross-source deduplication"],
    weaknesses: ["PR-heavy", "no original user voices"],
    filters: ["query", "region"],
  },
};

async function loadCatalog(client: ApiClient): Promise<{ sources: CatalogSource[] }> {
  const env = await client.intelSources();
  const live = env.data.sources;

  const sources: CatalogSource[] = live.map((live) => {
    const meta = SOURCE_METADATA[live.name];
    if (!meta) {
      return {
        id: live.name,
        kind: "unknown",
        regions: [],
        update_cadence: "unknown",
        strengths: [],
        weaknesses: [`No MCP-side metadata for '${live.name}' yet — tracking at BACKEND-GAPS §4.1.`],
        filters: [],
        premium: live.premium,
        provider: live.provider,
      };
    }
    return {
      id: live.name,
      ...meta,
      premium: live.premium,
      provider: live.provider,
    };
  });

  return { sources };
}

export function registerCatalogResource(server: McpServer, deps: { getClient: () => ApiClient | null }): void {
  server.registerResource(
    "catalog",
    "signal://catalog",
    {
      title: "Source catalog",
      description:
        "Live source registry with strengths/weaknesses metadata. Sources + premium flags come from api.aiassist.net; the strengths/weaknesses/kind/filters are MCP-side static metadata (BACKEND-GAPS §4.1 tracks moving them server-side). Read this before calling `listen` with explicit `scope.sources` — it tells the agent which sources fit which queries.",
      mimeType: "application/json",
    },
    async () => {
      const client = deps.getClient();
      if (!client) throw missingApiKey();
      try {
        const catalog = await loadCatalog(client);
        return {
          contents: [
            {
              uri: "signal://catalog",
              mimeType: "application/json",
              text: JSON.stringify(catalog, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        throw structuredError({
          code: -32010,
          message: "Failed to load source catalog from api.aiassist.net",
          suggested_action:
            "Verify AIAS_API_KEY is valid and api.aiassist.net is reachable. The MCP-side static metadata is retained; only the live source list + premium flags are unavailable.",
          upstream: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}
