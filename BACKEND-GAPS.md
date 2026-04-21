# Signal MCP — Backend Gaps Report (future state)

**For:** Mark @ Interchained
**Companion to:** `REALITY.md` (what ships now against current backend)
**Scope:** Every backend change on `api.aiassist.net` that would let the MCP satisfy `README.md` §4.2 / §4.3 verbatim — no MCP-side adjustments, no hints, no degraded shapes. Reality vs. Future.

---

## 0. The core mismatch

The spec treats a **signal** as a stable, addressable, server-side entity with a thread, an author profile, and an action log. The current backend treats it as a **transient row in a scan response** — minted on the fly from the source registry, discarded after the HTTP response is closed.

Every gap below traces to that one mismatch. They cluster in four buckets:

1. **Identity & persistence** — give signals a server-side ID and a TTL'd home.
2. **Depth** — add comments fetch and author profile aggregation.
3. **Action surface** — add a tiny verb set (archive, flag, route, draft, schedule) and a staged/commit lifecycle.
4. **Catalog metadata** — let `/v1/intelligence/sources` return `strengths`/`weaknesses`/`update_cadence` instead of the MCP layer hard-coding them.

---

## 1. Identity & persistence

### 1.1 Server-side `sig_*` IDs (S)

**File to touch:** `aias_production_april/api/saas/sources.py:51` (`signal_scan`) — emit a stable `id` field formatted `sig_<base64url(source:native_id)>` on every result, replacing or augmenting the current source-native `id`.

Once the backend mints the `sig_*` itself, the MCP can drop `signal-id.ts` and trust the wire.

**Effort:** S. No new endpoint. ~10 LOC change to each source adapter return shape (`free_sources.py`, `netrows.py`).

### 1.2 Signal store with TTL (M)

A keyed Redis hash (`intel:signal:<sig_id>` → full result blob, TTL 24h) written on every scan, read by the new endpoints below.

- Keeps the existing scan response shape.
- Lets `GET /v1/intelligence/signal/{id}` exist without re-scanning.
- TTL is the "freshness window" — past 24h, signals are considered evicted (matches reality of source rotation).

**Effort:** M. New module `api/saas/signal_store.py`, write hook in `signal_scan`, read helpers.

### 1.3 `GET /v1/intelligence/signal/{sig_id}` (S, depends on 1.2)

Single-signal lookup. Backs `inspect(depth="surface")` cleanly.

```
GET /v1/intelligence/signal/sig_xxx
→ { "data": { "signal": { ... } }, "meta": { ... } }
```

404 when evicted. **Effort:** S after 1.2 lands.

---

## 2. Depth — `inspect` thread + author

### 2.1 `GET /v1/intelligence/signal/{sig_id}/thread` (M)

Per-source thread fetcher. Implementation lives in the source adapters:

| Source | Backing |
|---|---|
| reddit | `https://www.reddit.com/comments/{id}.json` |
| hackernews | `https://hacker-news.firebaseio.com/v0/item/{id}.json` (recursive) or Algolia HN items API |
| lobsters | `https://lobste.rs/s/{short_id}.json` |
| devto / hashnode / indiehackers / producthunt | site-specific API or HTML scrape via existing `web_extraction` |
| twitter / linkedin_* / google_news | netrows API thread mode (paid tier) |
| betalist / wip / launchingnext / hackernoon / makerlog / echojs / tldr / changelog / saashub / alternativeto / telegram | feed-only — return `[]` honestly |

Each adapter returns `[{ author, body, score, is_op_reply }, …]` matching spec §4.2. Adapters that genuinely cannot return a thread return `[]` plus a `thread_completeness: "feed_only"` field.

**Effort:** M for the framework + reddit + hackernews adapters (covers ~80% of agent-relevant traffic). Subsequent adapters are S each.

### 2.2 `GET /v1/intelligence/author/{source}/{handle}` (M)

Per-source author profile. Returns the spec §4.2 `author_context` shape:

```json
{
  "data": {
    "author": {
      "handle": "u/saas_frustrated",
      "source": "reddit",
      "recent_posts_bucket": "active",
      "domains_posted_in": ["r/SaaS", "r/startups"],
      "sentiment_7d": "frustrated",
      "likely_role_hint": "indie_founder",
      "raw_post_count_30d": 12
    }
  }
}
```

Implementation:

- Reddit: `https://www.reddit.com/user/{handle}/submitted.json` + `/comments.json`
- HN: `https://hacker-news.firebaseio.com/v0/user/{handle}.json` → walk submitted items
- DevTo: `https://dev.to/api/articles?username={handle}`
- Twitter / LinkedIn: netrows author timeline endpoint
- Others: 404 with `error_code: "AUTHOR_PROFILE_UNSUPPORTED_FOR_SOURCE"`

`sentiment_7d` and `likely_role_hint` are LLM-derived (one BYOK chat completion per fetch, cached 6h in Redis). The classifier prompt and label set should be checked into `api/saas/author_classifier.py` so it stays consistent across calls.

**Effort:** M (framework + 2 adapters + classifier + cache). Each new source adapter is S.

### 2.3 Cross-source author identity (L — defer)

Gathering "this Reddit user is also this HN user" is identity work that needs OAuth / verified handles / explicit user linking. Recommend leaving this for a v2 identity service (`/v1/intelligence/identity/*`) and keeping `author_context.scope: "single_source"` for v1.

**Effort:** L. **Recommendation:** punt out of v1.

---

## 3. Action surface — `dispatch` lifecycle

The MCP-side handle store works (REALITY §2), but a backend home gives org-wide visibility, audit, and survives MCP restarts. Three new endpoints + one new model.

### 3.1 New model: `signal_action` (S)

```python
# api/models/schemas_v2.py
class SignalActionStatus(str, Enum):
    STAGED = "staged"
    COMMITTED = "committed"
    CANCELLED = "cancelled"
    FAILED = "failed"

class SignalActionType(str, Enum):
    ARCHIVE = "archive"
    FLAG = "flag"
    ROUTE = "route"
    DRAFT_REPLY = "draft_reply"
    SCHEDULE_FOLLOWUP = "schedule_followup"

class SignalAction(BaseModel):
    id: str           # disp_<uuid7>
    org_id: str
    user_id: str
    signal_id: str    # sig_*
    action: SignalActionType
    status: SignalActionStatus
    params: Dict[str, Any]
    preview: Optional[str] = None
    side_effect_handle: Optional[str] = None  # contact_<id>, schedule_<id>, etc.
    created_at: datetime
    committed_at: Optional[datetime]
```

Stored in Redis (`intel:dispatch:<handle>`, TTL 30d) with org/user secondary indexes.

**Effort:** S.

### 3.2 `POST /v1/intelligence/dispatch` — stage (S)

```
POST /v1/intelligence/dispatch
{
  "signal_id": "sig_xxx",
  "action": "draft_reply",
  "params": { "tone": "warm" }
}
→ { "data": { "handle": "disp_xxx", "status": "staged", "preview": "..." } }
```

Stages the action, runs preview side-effects (LLM draft for `draft_reply`), returns the handle. Idempotent on `(org_id, signal_id, action, params)` via a content hash so repeated stages don't pile up handles.

**Effort:** S.

### 3.3 `POST /v1/intelligence/dispatch/{handle}/commit` (S)

```
POST /v1/intelligence/dispatch/disp_xxx/commit
→ { "data": { "handle": "disp_xxx", "status": "committed", "side_effect_handle": "contact_42" } }
```

Reads the staged record, fires the real side effect:

| Action | Side effect |
|---|---|
| `archive` | Writes `intel:archived:<org_id>` set; future scans filter |
| `flag` | Writes `intel:flagged:<org_id>:<sig_id>` with `params.note` |
| `route` | Calls existing `POST /api/contacts` (or `/api/leads/capture`) internally; returns `contact_<id>` |
| `draft_reply` | No-op (artifact was the draft); marks committed for audit |
| `schedule_followup` | Enqueues to new scheduler (§3.5) |

**Effort:** S after 3.1.

### 3.4 `GET /v1/intelligence/dispatch/{handle}` (S)

Polling endpoint for agents that staged a dispatch and want to confirm it landed. Also supports `?include=audit` for the full transition log.

**Effort:** S.

### 3.5 Scheduler for `schedule_followup` (L)

This is the only **new subsystem** the spec needs.

Minimum viable scheduler:
- Redis sorted set `intel:schedule:<org_id>` keyed by epoch run-at.
- Worker process (`workers/intel_scheduler.py`) ticking every 60s, popping due items, executing the staged action's side effect.
- New endpoint `POST /v1/intelligence/dispatch` accepts `action: "schedule_followup"` with `params.run_at` (ISO) and `params.then_action` (one of the other action enums) + that action's params.
- On run-at: pulls the staged then-action, fires it, writes a new `signal_action` row with `side_effect_handle` pointing at the original schedule handle.

**Why L:** new long-running worker, new failure modes (worker crash, retry policy, dead-letter), org-level rate limits on scheduled fires, audit log of fired schedules. Not tiny.

**Recommendation:** ship 3.1–3.4 in v1.0 backend; let the scheduler land in v1.1 and continue returning the documented `-32004` from MCP until then.

---

## 4. Catalog metadata

### 4.1 `GET /v1/intelligence/sources` returns rich entries (S)

Today `list_sources()` (`aias_production_april/api/saas/sources.py:40`) returns `{name, premium, provider}`. The MCP fills in `strengths`, `weaknesses`, `regions`, `update_cadence`, `kind`, `filters` as static metadata.

Move that metadata into the registry so the catalog resource is server-driven and stays in sync with backend changes:

```python
SOURCE_REGISTRY: Dict[str, SourceMeta] = {
    "reddit": SourceMeta(
        adapter="api.saas.free_sources",
        kind="forum",
        regions=["en", "multilingual"],
        update_cadence="realtime",
        strengths=["product complaints", "hiring signals", "technical discussions"],
        weaknesses=["noisy for enterprise topics", "anonymized authors"],
        filters=["subreddit", "min_score", "flair"],
    ),
    ...
}
```

`list_sources()` returns the full struct. The MCP `signal://catalog` resource passes it through unchanged.

**Effort:** S.

### 4.2 Catalog change events (M)

Spec §5.1 declares `subscribes: true` on `signal://catalog`. To honor that without polling, expose a SSE/websocket stream:

```
GET /v1/intelligence/sources/events
Accept: text/event-stream
→ event: source_added | source_removed | source_updated
```

Backend fires when `SOURCE_REGISTRY` changes (currently a Python constant — would also need a hot-reload mechanism or a Redis-backed dynamic registry).

**Effort:** M. **Recommendation:** v1.1 — for v1.0 the MCP polls `/v1/intelligence/sources` every 5 minutes and emits notifications when the diff is non-empty.

---

## 5. Listen-side niceties (so the MCP can stop translating)

These are not strictly required but would let the MCP `listen` handler shrink to a passthrough.

### 5.1 Server-side intent classification per signal (M)

Today the MCP calls `/v1/chat/completions` once per scan to classify intent + match_reason for each signal (Mark's job). Move this to the backend so every consumer of `/v1/intelligence/scan` benefits and the BYOK call lives in one place.

Add to `intel_scan` (`public_api.py:1320`):
- Optional `classify: true` query/body param (default `true` for MCP traffic, `false` for raw consumers).
- For each result: call user's BYOK provider with the existing classifier prompt; attach `intent`, `intent_confidence`, `match_reason`.
- Cache per `(sig_id, classifier_version)` in Redis 24h.

**Effort:** M. **Win:** MCP `listen` becomes a thin passthrough.

### 5.2 Server-side karma + freshness buckets (S)

`engagement.score` is already returned. Add:
- `karma_bucket` derived from `score` (cutoffs in `api/saas/buckets.py`)
- `freshness_bucket` derived from `created_utc`

Lets the agent skip the date-math step the spec calls out as "small kindness, big cumulative effect".

**Effort:** S.

### 5.3 Server-side excerpt trimming (S)

Return `excerpt` (first ~280 chars of `content`/`body`) alongside `body`/`content` so MCP doesn't truncate.

**Effort:** S.

### 5.4 Streamable scan endpoint (M)

Spec §1.6 / §10 Q1 resolved on streaming. Adding `POST /v1/intelligence/scan/stream` (SSE) would let the MCP forward `text/event-stream` directly through Streamable HTTP, dropping the per-source `asyncio.gather` buffer in `intel_scan` and getting first-result latency under 200ms.

**Effort:** M (refactor `signal_scan` to async generator + SSE wrapper).

---

## 6. Effort & priority matrix

Sorted by **MCP-surface unlock per unit of work**.

| # | Change | Effort | Unlocks |
|---|---|---|---|
| 1.1 | Server-mints `sig_*` IDs | S | All `inspect` depths, dispatch handles |
| 1.2 | Signal store (Redis, TTL 24h) | M | `inspect.surface`, removes MCP cache |
| 1.3 | `GET /v1/intelligence/signal/{id}` | S | `inspect.surface` clean |
| 4.1 | Rich `/v1/intelligence/sources` | S | `signal://catalog` becomes server-driven |
| 5.2 | Karma + freshness buckets | S | All `listen` consumers |
| 5.3 | Excerpt field | S | All `listen` consumers |
| 3.1 | `signal_action` model | S | Foundation for 3.2–3.4 |
| 3.2 | `POST /v1/intelligence/dispatch` | S | All `dispatch` actions, server-side audit |
| 3.3 | Commit endpoint | S | Two-phase commit lives server-side |
| 3.4 | Get-handle endpoint | S | Async dispatch tracking |
| 5.1 | Server-side intent classification | M | MCP `listen` becomes passthrough |
| 2.1 | Thread fetcher | M | `inspect.thread` real comments |
| 2.2 | Author profile fetcher | M | `inspect.author` cross-post sentiment |
| 5.4 | Streamable scan | M | First-result <200ms across all consumers |
| 4.2 | Catalog SSE | M | True `signal://catalog` subscriptions |
| 3.5 | Scheduler subsystem | L | `schedule_followup` action |
| 2.3 | Cross-source identity | L | Identity-aware author context |

**Top 5 wins per dollar (recommended v1.0 backend ship):**

1. **1.1 + 1.2 + 1.3** — server-mints IDs, persists for 24h, lookup endpoint. Clean foundation.
2. **3.1–3.4** — full dispatch lifecycle on the server. MCP becomes stateless.
3. **4.1** — rich source registry. Catalog resource truthful.
4. **5.2 + 5.3** — bucket fields + excerpt. One-day change, every consumer benefits.
5. **2.1 (reddit + hackernews adapters)** — real comments for the two highest-traffic sources.

That set lifts the entire `inspect`/`dispatch` surface to the spec wire shape and removes every MCP-side hint field except `author_context.scope` (which stays until 2.3).

**Defer to v1.1:** 5.1, 5.4, 4.2, 3.5, 2.2 (other adapters).
**Defer to v2:** 2.3.

---

## 7. Migration path (no breaking changes for `listen`)

All proposed additions are additive on the wire. Existing `listen` callers (Keystone, SDKs, raw API consumers) keep working because:

- `id` field stays present; only the value format changes from native to `sig_*` (string in both cases — consumers should already be opaque).
- New fields (`excerpt`, `karma_bucket`, `freshness_bucket`, `intent`, `match_reason`) are added, never removed.
- New endpoints are net new.
- `SignalAction` model is new; nothing depends on its absence.

The one consideration: if `id` value format changes, any consumer that parsed the native ID for source-side cross-reference (e.g. a Reddit-aware consumer reconstructing the URL from the `id`) breaks. Mitigation: keep `native_id` as a sibling field for one release, then drop.

---

## 8. Bottom line

- **Reality (today, no backend changes):** ship REALITY.md as written. v1.0 MCP works against the current backend with documented hints.
- **Future (top-priority backend additions):** §1.1–1.3, §3.1–3.4, §4.1, §5.2–5.3, §2.1 (reddit+hn). Roughly **2–3 weeks** of one engineer's time. Lifts the MCP to the spec wire shape and removes every documented hint except cross-source identity.
- **Long tail:** scheduler (§3.5) and identity (§2.3) — gated on real demand.

— *Future, end of report.*
