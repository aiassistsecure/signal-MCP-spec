# Signal MCP — Reality Report (wire against api.aiassist.net as-is)

**For:** Mark @ Interchained
**Branch:** `claude/implement-signal-mcp-X3Qc6`
**Backend snapshot:** `aias_production_april/` (current production code)
**Scope:** No stubs. No new backend endpoints. Use the existing `/v1/intelligence/*`, `/v1/chat/completions`, `/api/contacts`, `/api/leads`, `/api/web-extraction/extract` surfaces and the 22 sources they wrap. **Adjust the MCP layer to fit reality.** Spec gaps that cannot be filled honestly are flagged and either downgraded or moved out of v1.0.

---

## 0. Backend reality (verified)

Single source of truth lives in:

| File | Purpose |
|---|---|
| `aias_production_april/api/routes/public_api.py:1305` | `GET /v1/intelligence/sources` |
| `aias_production_april/api/routes/public_api.py:1320` | `POST /v1/intelligence/scan` |
| `aias_production_april/api/routes/public_api.py:1382` | `POST /v1/intelligence/extract-keywords` |
| `aias_production_april/api/routes/public_api.py:185` | `POST /v1/chat/completions` (BYOK + tool-call) |
| `aias_production_april/api/routes/web_extraction.py:114` | `POST /v1/web/extract` (also `/api/web-extraction/extract`) |
| `aias_production_april/api/routes/contacts.py:7` | `/api/contacts` CRUD + lifecycle |
| `aias_production_april/api/routes/leads.py:8` | `/api/leads/capture`, `/api/leads/{id}/workspace` |
| `aias_production_april/api/saas/sources.py:5` | 22-source registry (18 free + 4 premium) |
| `aias_production_april/api/saas/free_sources.py` / `netrows.py` | Source adapters |

**Critical facts the spec did not anticipate:**

1. **Signals are transient.** `signal_scan` returns a fresh array on every call. No `sig_*` ID. Each item carries the **source-native ID** (`reddit:abc123`, `hn:38291847`, `devto_456`, `hashnode_<id>`, `lobsters_<short>`, …) plus `url`, `author`, `title`, `body`/`content`, `score`, `num_comments`, `created_utc`, `source`, `subreddit`.
2. **No comment/thread endpoint.** The scan ships top-level posts only. Reddit/HN expose this publicly, but the AiAS backend does not — and per your direction we are not going around it.
3. **No author-history endpoint.** The scan yields the post's author handle, nothing else.
4. **No signal persistence.** Nothing on the backend remembers a signal after the scan response is returned. There is no `archive`, `flag`, `route_to`, `draft`, or `schedule` tied to a "signal" entity, because the entity does not exist server-side.
5. **`/api/contacts` and `/api/leads/capture` exist** and are the right home for a "signal turned into something a human will follow up on."
6. **`/v1/chat/completions` does BYOK across groq / openai / anthropic / gemini / mistral** and is the right home for `draft_reply` and for the per-signal `intent` + `match_reason` classification (which you already own in `listen`).

The MCP layer therefore has to do three honest things:

- **Mint and resolve `sig_*` IDs itself**, by encoding `source + native_id` (+ scan epoch) deterministically.
- **Hold a Redis-backed handle store** for two-phase `dispatch` — the backend offers no staged mode, so MCP owns it. (This is not a stub; it's the only place the staged/commit semantics can live without touching the backend.)
- **Downgrade `inspect.thread` and `inspect.author` to what the scan already provides**, plus an opportunistic re-scan when more data is reachable through the existing APIs.

---

## 1. `inspect`

### 1.0 `sig_*` ID format (MCP-owned, no backend change)

```
sig_<base64url(source ":" native_id)>
```

- `source` — `SOURCE_REGISTRY` key (`reddit`, `hackernews`, `devto`, …)
- `native_id` — the `id` field from the scan result (already source-unique)
- Encoder/decoder lives in `packages/intelligence-mcp/src/signal-id.ts`
- IDs are **stateless and stable** — the same Reddit post always yields the same `sig_*`. No DB needed.
- `listen.ts` mints the ID at emit time. `inspect` decodes it.

### 1.1 `depth: "surface"` — single signal, no thread, no author

**Backing endpoint:** `POST /v1/intelligence/scan` re-run scoped to the originating source, filtered down to the one we want.

Reasoning: the backend has no "get one signal" endpoint. The cheapest honest reconstruction is to re-scan the *one* source the signal came from with the original keywords (cached on the MCP side from the `listen` call that produced the ID) and pluck the matching `id`. If the signal has fallen out of the source's recent window, return `signal: null` plus `staleness: "evicted_from_source_window"`.

Request:
```
POST /v1/intelligence/scan
Authorization: Bearer aai_***
{
  "sources": ["<decoded_source>"],
  "keywords": ["<cached_query_keywords>"],
  "limit": 50,
  "category": "recent"
}
```

Response: standard envelope (`data.results[]`).

Mapping → spec §4.2 output:

| Spec field | Source |
|---|---|
| `signal.id` | the inbound `signal_id` |
| `signal.source` | decoded from `sig_*` |
| `signal.url` | result.`url` |
| `signal.headline` | result.`title` |
| `signal.excerpt` | first 280 chars of `content`/`body` |
| `signal.intent` | re-run intent classifier via `/v1/chat/completions` (same call you already use in `listen`); cache 24h in Redis keyed by `sig_*` |
| `signal.intent_confidence` | from same classifier |
| `signal.author.handle` | result.`author` |
| `signal.author.karma_bucket` | derived bucket from `score` (`new`/`low`/`medium`/`high`/`established`) — `score < 5` / `< 50` / `< 250` / `< 1k` / `>=1k` |
| `signal.engagement.score` | result.`score` |
| `signal.engagement.comments` | result.`num_comments` |
| `signal.captured_at` | `result.created_utc` → ISO |
| `signal.freshness_bucket` | bucket of `now - created_utc` (`last_hour`/`today`/`this_week`/`this_month`/`older`) |
| `signal.match_reason` | string from same classifier pass; for surface depth, the original `match_reason` is reused if cached |
| `thread` | `[]` (depth is `surface`) |
| `author_context` | `null` |

### 1.2 `depth: "thread"` — adjusted, honest version

The backend has no comments fetch. We do not invent one. Instead we **adjust the contract** for v1.0: `thread` is returned as a single-element array containing the full post body when the scan only returned a truncated excerpt. That's the only "deeper" content the existing API can return for a signal without going around it.

Behavior:
1. Run the surface flow above.
2. If the matched result has a `content`/`body` longer than the excerpt, attach it as `thread[0]`.

Response:
```json
{
  "signal": { /* §1.1 */ },
  "thread": [
    {
      "author": "<post author>",
      "body": "<full post body>",
      "score": <post score>,
      "is_op_reply": true
    }
  ],
  "author_context": null,
  "thread_completeness": "post_body_only"
}
```

`thread_completeness: "post_body_only"` is a new MCP-side hint that tells the agent it did not get the comment chain. The spec §4.2 example shape is preserved. The lexicon entry for `thread` should call this out.

### 1.3 `depth: "author"` — adjusted, honest version

No author-history endpoint exists. We do **one** legitimate thing with the existing API: re-scan the **same source** with `keywords = [author_handle]` and harvest that author's other recent posts that the source surfaced. Then derive the spec's soft fields from that small corpus.

Request (per-signal, after surface):
```
POST /v1/intelligence/scan
{
  "sources": ["<decoded_source>"],
  "keywords": ["<author_handle>"],
  "limit": 25,
  "category": "recent"
}
```

Mapping → `author_context`:

| Spec field | Derivation |
|---|---|
| `recent_posts_bucket` | count of returned posts → `dormant` (0) / `light` (1–2) / `active` (3–10) / `prolific` (>10) |
| `domains_posted_in` | unique `subreddit` (or the source name when `subreddit` is absent) values |
| `sentiment_7d` | one-shot `/v1/chat/completions` over the joined titles/bodies — labels: `positive` / `neutral` / `frustrated` / `mixed` (cache 24h per author per source) |
| `likely_role_hint` | same chat call returns `indie_founder` / `enterprise_dev` / `student` / `enthusiast` / `unknown` |

This is a degraded version of the spec. It only sees the author within the **one source** the signal came from, because cross-source author identity is not solvable without OAuth/identity that does not exist server-side. We expose this honestly through a new sibling field:

```json
"author_context": {
  "recent_posts_bucket": "active",
  "domains_posted_in": ["r/SaaS", "r/startups"],
  "sentiment_7d": "frustrated",
  "likely_role_hint": "indie_founder",
  "scope": "single_source"
}
```

### 1.4 Caching plan (MCP-side Redis, key `mcp:signal:*`)

- `listen` writes each emitted signal as `mcp:signal:<sig_*>` → `{source, native_id, query_keywords, scanned_at, raw_result}` with TTL 24h.
- `inspect` reads that cache first; if hit, surface depth needs **zero** network calls.
- Intent classification result cached at `mcp:intent:<sig_*>` for 24h.
- Author context cached at `mcp:author:<source>:<handle>` for 6h.

This is the single MCP-side persistence concession. It is not a backend change.

---

## 2. `dispatch`

The backend has no signal-action surface. It does have `contacts`, `leads`, and `chat/completions`. We map the actions that genuinely fit those, and **drop the ones that don't from v1.0**, rather than fake them.

`handle` format (MCP-owned, Redis-backed):
```
disp_<uuid7>
```
Stored at `mcp:dispatch:<handle>` → `{signal_id, action, params, status, created_at, committed_at, side_effect_handle}` with TTL 7d.

Two-phase commit lives entirely in this Redis key. `commit: false` → write `status: "staged"`. `commit: true` → look up handle, run side effect, update `status: "committed"` and `side_effect_handle`. No backend change required.

### 2.1 `archive` — **MCP-local only**

There is no signal store on the backend, so "archive" cannot mean anything to api.aiassist.net. We make it mean exactly what the agent expects: this `sig_*` will be filtered out of future `listen` results for this org.

- Maintain `mcp:archived:<org_id>` as a Redis SET of `sig_*` IDs (TTL 30d).
- `listen` filters the SET before emitting.
- `dispatch(action="archive", commit=true)` adds to the set. `commit=false` returns staged with a preview of "would archive sig_…".
- `handle` source: `disp_<uuid7>`, no backend ID.

### 2.2 `flag` — **MCP-local only**

Same shape as `archive`, different Redis SET (`mcp:flagged:<org_id>`), and `listen` decorates returned signals with `flagged: true` for items in the set rather than filtering them.

- Optional `params.note` is stored alongside the entry (`mcp:flagged:<org_id>:<sig_*>` → note string).
- No backend write.

### 2.3 `route` — **backed by `POST /api/contacts` (and optionally `POST /api/leads/capture`)**

This is the action with a real backend home: turn a signal into a contact in the user's CRM workspace.

Existing endpoint:
```
POST /api/contacts
Cookie / Bearer auth
{
  "name": "<author handle>",
  "email": null,
  "source": "signal:<source>:<native_id>",
  "notes": "<headline>\n<excerpt>\n<url>",
  "lifecycle_stage": "new"
}
```

Returns: `{ "id": "<contact_id>", … }` (per `aias_production_april/api/routes/contacts.py:16`).

`dispatch(action="route", params={destination: "contacts"|"leads", workspace_id?: "..."})`:

- `destination: "contacts"` (default) → `POST /api/contacts` with the body above.
  - `handle = disp_<uuid7>`; staged record stores the planned body; commit fires the POST and stores `side_effect_handle = "contact_<id>"`.
- `destination: "leads"` → `POST /api/leads/capture` with the email-capture shape (only valid when the signal carries an email — Reddit/HN don't, so this path is rare; we still expose it for sources that do).

If `params.workspace_id` is present and `destination == "contacts"`, follow up with `PATCH /api/contacts/{id}` to set workspace. If absent, the user's default workspace is used by the backend.

### 2.4 `draft_reply` — **backed by `POST /v1/chat/completions`**

Existing endpoint, BYOK, same shape you already use everywhere.

Request body the MCP composes:
```json
{
  "model": "<user default>",
  "messages": [
    { "role": "system", "content": "<DRAFT_REPLY_SYSTEM_PROMPT>" },
    { "role": "user", "content": "<formatted signal context: headline, excerpt, intent, source, url, author handle>" }
  ],
  "temperature": 0.6,
  "max_tokens": 400
}
```

`DRAFT_REPLY_SYSTEM_PROMPT` lives in `packages/intelligence-mcp/src/prompts/draft-reply.ts` and is tone-tunable through `params.tone` (`"warm"` / `"direct"` / `"matter_of_fact"`, default `"warm"`) and `params.max_chars` (default 600).

- `commit: false` → run the chat call, return `status: "staged"`, store the draft at `mcp:dispatch:<handle>.preview`. The agent shows it to the user.
- `commit: true` → no extra side effect (the draft is the artifact). Status flips to `committed`. The agent/user is responsible for actually posting it; we do not post to Reddit/HN/etc.

`handle = disp_<uuid7>`. `preview` field is populated with the draft text.

### 2.5 `schedule_followup` — **dropped from v1.0 (honest)**

There is no scheduler/queue on the backend. We refuse to fake a scheduler in MCP-side Redis because:

- A schedule that lives only in MCP process memory dies with the process and silently drops follow-ups.
- A Redis-only schedule needs a worker that is not part of this repo.

Behavior in v1.0: tool call returns a structured error per spec §7:

```json
{
  "code": -32004,
  "message": "schedule_followup is not available in v1.0",
  "data": {
    "reason": "no scheduler backing",
    "suggested_action": "Use action='flag' with params.note to mark for manual follow-up, or call dispatch(action='route', destination='contacts') to land it in CRM where the user's workflow can pick it up."
  }
}
```

This is documented in the action enum description and in the `lexicon`. Spec §4.3 enum stays unchanged so it's a future-compatible upgrade.

### 2.6 Dispatch summary table

| Action | Backed by | Side-effect ID | v1.0 status |
|---|---|---|---|
| `archive` | MCP Redis only | none | live |
| `flag` | MCP Redis only | none | live |
| `route` | `POST /api/contacts` (or `/api/leads/capture`) | `contact_<id>` / `lead_<id>` | live |
| `draft_reply` | `POST /v1/chat/completions` | none (artifact is the draft) | live |
| `schedule_followup` | — | — | error -32004 |

---

## 3. Source coverage (no MCP-side filtering, all 22 sources used as-is)

The MCP exposes every entry in `SOURCE_REGISTRY` verbatim through `signal://catalog`. The `strengths`/`weaknesses` annotations are written by us (MCP-side static metadata in `packages/intelligence-mcp/src/resources/catalog.ts`) — the backend does not yet supply them and we do not need it to.

Authoritative list pulled from `aias_production_april/api/saas/sources.py:5` (current build):

`reddit, hackernews, devto, lobsters, hashnode, betalist, echojs, wip, launchingnext, hackernoon, makerlog, alternativeto, saashub, tldr, changelog, indiehackers, producthunt, telegram, twitter, linkedin_jobs, linkedin_people, google_news`

`twitter`, `linkedin_jobs`, `linkedin_people`, `google_news` are the `PREMIUM_SOURCES` set (netrows-backed). The MCP marks them `premium: true` from the `/v1/intelligence/sources` response and does no other gating — the backend already enforces `_require_pro`.

---

## 4. Ready-to-implement code

### 4.1 `packages/intelligence-mcp/src/api-client.ts` — methods to add

```ts
// Already exists: get<T>(path), post<T>(path, body)
// Add the following typed methods:

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

export interface IntelEnvelope<T> {
  data: T;
  meta: { request_id?: string; timestamp: string; version: string; org_id: string; processing_ms: number };
}

export interface IntelScanData {
  results: IntelSignal[];
  total: number;
  sources_scanned: string[];
  sources_failed: { source: string; error: string }[];
}

export interface ChatCompletionRequest {
  model?: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" };
}

export interface ChatCompletionResponse {
  choices: { message: { role: string; content: string } }[];
  model: string;
}

export interface ContactCreateBody {
  name: string;
  email?: string | null;
  source?: string;
  notes?: string;
  lifecycle_stage?: string;
  workspace_id?: string;
}

export interface ContactCreateResponse { id: string; [k: string]: unknown }

// --- methods ---

intelSources(opts?: RequestOptions): Promise<IntelEnvelope<{ sources: IntelSource[] }>> {
  return this.get("/v1/intelligence/sources", opts);
}

intelScan(body: IntelScanRequest, opts?: RequestOptions): Promise<IntelEnvelope<IntelScanData>> {
  return this.post("/v1/intelligence/scan", body, opts);
}

intelExtractKeywords(body: { prompt: string; existing_keywords?: string[]; model?: string; provider?: string }, opts?: RequestOptions) {
  return this.post("/v1/intelligence/extract-keywords", body, opts);
}

chatCompletion(body: ChatCompletionRequest, opts?: RequestOptions): Promise<ChatCompletionResponse> {
  return this.post("/v1/chat/completions", body, opts);
}

createContact(body: ContactCreateBody, opts?: RequestOptions): Promise<ContactCreateResponse> {
  return this.post("/api/contacts", body, opts);
}
```

### 4.2 `packages/intelligence-mcp/src/signal-id.ts` (new)

```ts
const PREFIX = "sig_";

export function mintSignalId(source: string, nativeId: string | number): string {
  const raw = `${source}:${nativeId}`;
  const b64 = Buffer.from(raw, "utf8").toString("base64url");
  return `${PREFIX}${b64}`;
}

export function decodeSignalId(id: string): { source: string; nativeId: string } {
  if (!id.startsWith(PREFIX)) throw new Error(`Invalid signal_id: ${id}`);
  const raw = Buffer.from(id.slice(PREFIX.length), "base64url").toString("utf8");
  const idx = raw.indexOf(":");
  if (idx < 0) throw new Error(`Malformed signal_id payload: ${id}`);
  return { source: raw.slice(0, idx), nativeId: raw.slice(idx + 1) };
}
```

### 4.3 `packages/intelligence-mcp/src/tools/inspect.ts` — handler body

Replaces the `notImplementedInV0_1` throw.

```ts
async ({ signal_id, depth }) => {
  const { source, nativeId } = decodeSignalId(signal_id);
  const cached = await ctx.cache.getSignal(signal_id); // mcp:signal:<id>

  const baseSignal =
    cached?.raw_result ??
    (await findSignalByRescan(ctx, source, nativeId, cached?.query_keywords ?? []));

  if (!baseSignal) {
    return { signal: null, thread: [], author_context: null, staleness: "evicted_from_source_window" };
  }

  const signal = await shapeSignal(ctx, baseSignal, source, signal_id);

  if (depth === "surface") {
    return { signal, thread: [], author_context: null };
  }

  const thread =
    baseSignal.body && baseSignal.body.length > (signal.excerpt?.length ?? 0)
      ? [{ author: baseSignal.author, body: baseSignal.body, score: baseSignal.score, is_op_reply: true }]
      : [];

  if (depth === "thread") {
    return { signal, thread, author_context: null, thread_completeness: "post_body_only" };
  }

  // depth === "author"
  const authorScan = await ctx.api.intelScan({
    sources: [source],
    keywords: [baseSignal.author],
    limit: 25,
    category: "recent",
  });
  const author_context = await deriveAuthorContext(ctx, baseSignal.author, source, authorScan.data.results);
  return { signal, thread, author_context: { ...author_context, scope: "single_source" }, thread_completeness: "post_body_only" };
};
```

`findSignalByRescan`, `shapeSignal`, `deriveAuthorContext` live next to the handler. `shapeSignal` derives `karma_bucket`, `freshness_bucket`, and runs the cached intent classifier over `/v1/chat/completions`.

### 4.4 `packages/intelligence-mcp/src/tools/dispatch.ts` — handler body

```ts
async ({ signal_id, action, params }) => {
  const commit = params?.commit === true;

  if (action === "schedule_followup") {
    throw mcpError(-32004, "schedule_followup is not available in v1.0", {
      reason: "no scheduler backing",
      suggested_action: "Use action='flag' with params.note, or action='route' to land it in CRM.",
    });
  }

  // Stage every action first.
  const handle = `disp_${randomUUID7()}`;
  const staged: StagedDispatch = { signal_id, action, params: params ?? {}, status: "staged", created_at: nowIso() };

  if (action === "draft_reply") {
    const ctxStr = await ctx.cache.formatSignalForLLM(signal_id, params);
    const completion = await ctx.api.chatCompletion({
      messages: [
        { role: "system", content: DRAFT_REPLY_SYSTEM_PROMPT(params?.tone, params?.max_chars) },
        { role: "user", content: ctxStr },
      ],
      temperature: 0.6,
      max_tokens: 400,
    });
    staged.preview = completion.choices[0]?.message.content ?? "";
  }

  await ctx.cache.putDispatch(handle, staged);

  if (!commit) {
    return { action, status: "staged", handle, ...(staged.preview ? { preview: staged.preview } : {}) };
  }

  // Commit phase
  switch (action) {
    case "archive":
      await ctx.cache.archiveSignal(ctx.orgId, signal_id);
      break;
    case "flag":
      await ctx.cache.flagSignal(ctx.orgId, signal_id, params?.note);
      break;
    case "route": {
      const dest = params?.destination ?? "contacts";
      if (dest === "contacts") {
        const sig = await ctx.cache.getSignal(signal_id);
        if (!sig) throw mcpError(-32005, "signal expired before commit", { signal_id });
        const contact = await ctx.api.createContact({
          name: sig.raw_result.author,
          source: `signal:${sig.raw_result.source}:${sig.raw_result.id}`,
          notes: `${sig.raw_result.title}\n\n${(sig.raw_result.content ?? "").slice(0, 1000)}\n\n${sig.raw_result.url}`,
          lifecycle_stage: "new",
          workspace_id: params?.workspace_id,
        });
        staged.side_effect_handle = `contact_${contact.id}`;
      } else {
        throw mcpError(-32006, `route destination '${dest}' not supported in v1.0`, { supported: ["contacts"] });
      }
      break;
    }
    case "draft_reply":
      // Artifact already produced in stage; commit just records human acceptance.
      break;
  }

  staged.status = "committed";
  staged.committed_at = nowIso();
  await ctx.cache.putDispatch(handle, staged);

  return {
    action,
    status: "committed",
    handle,
    ...(staged.preview ? { preview: staged.preview } : {}),
    ...(staged.side_effect_handle ? { side_effect_handle: staged.side_effect_handle } : {}),
  };
};
```

`ctx.cache` is a tiny Redis (or in-memory) wrapper at `packages/intelligence-mcp/src/cache.ts` exposing `getSignal`, `archiveSignal`, `flagSignal`, `putDispatch`, `getDispatch`, `formatSignalForLLM`. Backed by `REDIS_URL` if set, in-memory otherwise — your call which to require.

---

## 5. Spec deltas (what the README needs to acknowledge in v1.0)

These are the only non-additive changes. None of them alters the wire shape; they document what the agent will actually see.

1. **§4.2 `inspect`**: add `thread_completeness` and `author_context.scope` as optional, MCP-emitted hints. Note that thread is `post_body_only` and author is `single_source` against the current backend.
2. **§4.3 `dispatch`**: keep the enum unchanged; add a footnote that `schedule_followup` returns error `-32004` until a scheduler endpoint exists. Add a note that `route` defaults to `destination: "contacts"`.
3. **§4.1 `listen`**: add note that the MCP layer mints `sig_*` deterministically from `source + native_id`, so the same post always resolves the same way across sessions.
4. **§5.1 `signal://catalog`**: `strengths`/`weaknesses` are MCP-side static metadata in v1.0; subscriptions still work for source list changes (driven by polling `/v1/intelligence/sources`).

---

## 6. Ship list (v0.1 → v1.0 against current backend)

- [x] `listen` — Mark
- [ ] `signal-id.ts` — new file
- [ ] `cache.ts` — Redis/in-memory dispatch + signal cache
- [ ] `api-client.ts` — typed methods in §4.1
- [ ] `tools/inspect.ts` — body in §4.3
- [ ] `tools/dispatch.ts` — body in §4.4
- [ ] `resources/catalog.ts` — wraps `/v1/intelligence/sources` + static strengths/weaknesses
- [ ] `resources/lexicon.ts` — markdown the agent reads
- [ ] `resources/playbooks.ts` — JSON
- [ ] `prompts/sweep.ts`, `triage.ts`, `brief.ts`
- [ ] README footnotes for the §5 deltas

Zero backend changes required to ship v1.0. The companion `BACKEND-GAPS.md` documents what would need to land on api.aiassist.net to lift the §5 deltas.

— *Reality, end of report.*
