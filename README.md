# Signal MCP — A Specification

> An opinionated MCP server for signal intelligence.
> Written clean-sheet, not retrofitted.

---

**Author:** Claude (Opus 4.7)
**For:** Mark Allen Evans @ AiAssist / Interchained
**Date:** 2026-04-16
**Spec version:** 1.2 (reference implementation + conformance + the principle)
**License:** MIT

---

## Contents

- [Why this document exists](#why-this-document-exists)
- [1. Design principles](#1-design-principles)
- [2. The mental model](#2-the-mental-model)
- [3. The protocol envelope](#3-the-protocol-envelope)
- [4. Tools](#4-tools) — `listen` · `inspect` · `dispatch`
- [5. Resources](#5-resources) — `catalog` · `lexicon` · `playbooks`
- [6. Prompts](#6-prompts) — `sweep` · `triage` · `brief`
- [7. Error model](#7-error-model)
- [8. Capabilities declaration](#8-capabilities-declaration)
- [9. Non-goals](#9-non-goals)
- [10. Open design questions](#10-open-design-questions)
- [11. What this spec deliberately leaves to the implementation](#11-what-this-spec-deliberately-leaves-to-the-implementation)
- [12. What makes this different from "wrap the REST API"](#12-what-makes-this-different-from-wrap-the-rest-api)
- [13. What needs to be built](#13-what-needs-to-be-built)
- [14. Reference implementation sketch](#14-reference-implementation-sketch)
- [15. Conformance checklist](#15-conformance-checklist)
- [16. The one principle above all others](#16-the-one-principle-above-all-others)
- [17. Closing note](#17-closing-note)

---

## Why this document exists

Most MCP servers today are thin shims. Someone takes a REST API, wraps every endpoint as a tool, calls it an MCP server, ships it. It works. It's also boring, and it misses what MCP actually unlocks.

MCP is not a REST-to-tool transpiler. It's a protocol for giving agents **capabilities**, **context**, and **conversational structure** — tools, resources, and prompts — all under one roof. A good MCP server exposes a *mental model* an agent can reason with, not a flat tool menu.

This spec is a clean-sheet design for a signal intelligence MCP server. The core domain is the same one you'd expect — scanning public sources for mentions of topics, classifying intent, surfacing opportunities — but the design is shaped by the question: **what does this look like if an agent is the primary user, not a human?**

---

## 1. Design principles

These are the rules I'm holding myself to.

**1.1 Agents don't read docs. They read tool descriptions.**
Every tool description has to be a self-contained training signal. If the description is ambiguous, the agent will guess wrong. Long descriptions are cheaper than wrong tool calls.

**1.2 Shape tools to decisions, not endpoints.**
A REST API might have `GET /sources` and `POST /scan`. An MCP server should expose the *decisions* an agent makes: "what should I look at?", "scan it", "is this worth surfacing?". Sometimes one tool. Sometimes three. The REST shape is irrelevant.

**1.3 Fewer, richer tools beats more, thinner tools.**
Ten tools with overlapping purposes is worse than four tools with sharp boundaries. Agents make tool-selection errors in proportion to the number of plausible options.

**1.4 Resources are context. Tools are actions. Prompts are templates.**
Never put static data behind a tool. Never put an action behind a resource. MCP has three primitives for a reason.

**1.5 Progressive disclosure.**
An agent shouldn't need to pass every knob on every call. Sensible defaults. Optional depth. The common case should be a one-liner.

**1.6 Streaming over batching.**
Long-running work (scans, extractions) should stream partial results. An agent that gets its first result in 200ms can start reasoning while the rest arrives.

**1.7 Make the agent smarter, not louder.**
If a tool returns a wall of JSON, the agent will either drown in it or ignore most of it. Return shaped, summarized, *decision-ready* output. Full detail available via pagination or follow-up calls.

**1.8 Fail loudly, recover gracefully.**
Errors are data. Return them as structured JSON-RPC errors with machine codes, human messages, and — when possible — a suggested next action.

---

## 2. The mental model

The server exposes **one domain**: public signal intelligence. I'm naming it `signal` because the word "intelligence" is overloaded in the AI space and "signal" maps to what agents are actually doing — listening for signal in noise.

Three primitives shape the agent's mental model:

```
    ┌─────────────────────────────────────────────┐
    │                                             │
    │   RESOURCES          TOOLS         PROMPTS  │
    │   ─────────          ─────         ───────  │
    │                                             │
    │   signal://          listen        sweep    │
    │   catalog            inspect       triage   │
    │                      dispatch      brief    │
    │   signal://                                 │
    │   lexicon                                   │
    │                                             │
    │   signal://                                 │
    │   playbooks                                 │
    │                                             │
    └─────────────────────────────────────────────┘
```

- **Resources** give the agent the *lay of the land* (what sources exist, what intents mean, what plays have worked before).
- **Tools** let the agent *do things* (listen for signals, inspect a specific one deeply, dispatch a response).
- **Prompts** are *workflow templates* the agent can hand back to the user when it wants structured input.

That's the whole server. Three tools, three resources, three prompts. Nine surfaces.

---

## 3. The protocol envelope

**Transport:** Streamable HTTP (MCP `2025-11`). stdio for local bridges.
**Wire format:** JSON-RPC 2.0.
**Auth:** Bearer token in `Authorization` header for HTTP, env var for stdio.
**Session:** `Mcp-Session-Id` header issued on `initialize`, echoed on every subsequent request.
**Origin validation:** Required. Reject requests where `Origin` is missing or not in the allowlist.

**A note on SSE, for the SSE enjoyers:** Streamable HTTP did not kill Server-Sent Events. What it killed was the old *two-endpoint* pattern (`/sse` + separate `/messages` POST URL). The current design is a single MCP endpoint that accepts POST for client→server messages, and *optionally upgrades to SSE* when the server wants to stream. You still write `text/event-stream` responses. You still get unidirectional streaming with automatic reconnection. You just do it through one cleaner endpoint instead of two coupled ones. SSE as a technology is alive and well inside Streamable HTTP — it's just been promoted from "the whole transport" to "the streaming mode of the transport." Nothing to grieve.

Nothing else in this section is novel — it's the spec baseline. The interesting design is above this layer.

---

## 4. Tools

Three tools. Each has a sharp purpose.

### 4.1 `listen`

> **What it does:** Scans public sources for signals matching a query.
> **Why it exists:** The agent's primary action — "go listen for people talking about X."
> **Returns:** A stream of ranked signals, shaped for decision-making.

**Input schema**

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Natural-language description of what to listen for. Freeform. The server expands it into keywords automatically. Example: 'founders complaining about Clay being too expensive'."
    },
    "scope": {
      "type": "object",
      "description": "Where and how far to listen. All fields optional with sensible defaults.",
      "properties": {
        "sources": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Specific source IDs. Omit to let the server pick based on the query."
        },
        "freshness": {
          "type": "string",
          "enum": ["last_hour", "today", "this_week", "this_month", "any"],
          "default": "this_week"
        },
        "min_engagement": {
          "type": "integer",
          "description": "Drop signals below this score (upvotes, comments, etc.). Default 0."
        }
      }
    },
    "intent_filter": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": ["buying", "evaluating", "hiring", "complaining", "recommending", "learning", "building", "announcing", "asking", "comparing"]
      },
      "description": "Only surface signals with these intents. Omit for all."
    },
    "limit": {
      "type": "integer",
      "default": 20,
      "maximum": 100
    }
  },
  "required": ["query"]
}
```

**Why this shape**

- `query` is a **string, not a keyword array**. The agent thinks in natural language; making it pre-extract keywords is asking it to do the server's job.
- `scope` groups spatial/temporal filters so the flat namespace stays readable.
- `sources` is *optional* — the server picks intelligently by default. This is progressive disclosure: easy path is one parameter (`query`), power path is five.
- `intent_filter` uses the same enum as the resource (`signal://lexicon`), so an agent that's read the lexicon knows exactly what to pass.

**Output shape**

Streams results as they arrive. Each signal:

```json
{
  "id": "sig_01HXYZ...",
  "source": "reddit",
  "url": "https://reddit.com/r/SaaS/...",
  "headline": "Clay pricing is getting out of hand",
  "excerpt": "We were paying $149/mo and they just bumped us to $500...",
  "intent": "complaining",
  "intent_confidence": 0.87,
  "author": { "handle": "u/saas_frustrated", "karma_bucket": "medium" },
  "engagement": { "score": 234, "comments": 47 },
  "captured_at": "2026-04-16T18:42:11Z",
  "freshness_bucket": "today",
  "match_reason": "Explicit pricing complaint + direct product name match"
}
```

Key design choices:

- **`match_reason`** is the sleeper feature. Tells the agent *why* this signal was returned. Huge for debugging and for letting the agent decide whether to trust the result.
- **`karma_bucket`** is a categorical, not a raw number. `new | low | medium | high | established`. The agent doesn't care if someone has 12,847 vs 14,201 karma — it cares whether they're a credible voice.
- **`intent_confidence`** is a float so the agent can threshold. Below 0.6, treat the intent label as a guess.
- **`freshness_bucket`** duplicates info derivable from `captured_at`, but the bucket saves the agent a date-math step. Small kindness, big cumulative effect.

---

### 4.2 `inspect`

> **What it does:** Deep-dive on a single signal.
> **Why it exists:** `listen` returns summaries. Sometimes the agent needs the full conversation — comments, referenced links, author history.
> **Returns:** Expanded signal with threaded context.

**Input schema**

```json
{
  "type": "object",
  "properties": {
    "signal_id": {
      "type": "string",
      "description": "The sig_... ID from a previous listen result."
    },
    "depth": {
      "type": "string",
      "enum": ["surface", "thread", "author"],
      "default": "thread",
      "description": "surface = signal only. thread = include comments/replies. author = include author's recent posting history."
    }
  },
  "required": ["signal_id"]
}
```

**Why three depth levels, not a boolean**

`thread` is the common case. `surface` is for when the agent just wants to confirm a signal still exists (cache check). `author` is for qualification — is this person a real prospect or a drive-by commenter? Each depth has a clear use case. A boolean would've forced the agent to always pay the author-lookup cost.

**Output shape**

```json
{
  "signal": { /* full signal object */ },
  "thread": [
    { "author": "u/x", "body": "...", "score": 42, "is_op_reply": false }
  ],
  "author_context": {
    "recent_posts_bucket": "active",
    "domains_posted_in": ["r/SaaS", "r/startups", "HN"],
    "sentiment_7d": "frustrated",
    "likely_role_hint": "indie_founder"
  }
}
```

`likely_role_hint` is a soft classification — `indie_founder`, `enterprise_dev`, `student`, `enthusiast`, `unknown`. Always wrapped in "hint" language because it's probabilistic. Agents read that nuance.

---

### 4.3 `dispatch`

> **What it does:** Takes an action on a signal — mark it as handled, route it somewhere, draft a response.
> **Why it exists:** `listen` without `dispatch` is read-only. Agents need to close the loop, or they just produce reports nobody reads.
> **Returns:** The action taken and a handle for tracking.

**Input schema**

```json
{
  "type": "object",
  "properties": {
    "signal_id": { "type": "string" },
    "action": {
      "type": "string",
      "enum": ["archive", "flag", "route", "draft_reply", "schedule_followup"],
      "description": "What to do with this signal."
    },
    "params": {
      "type": "object",
      "description": "Action-specific params. See action docs."
    }
  },
  "required": ["signal_id", "action"]
}
```

**Why one dispatch tool, not five**

Five separate tools (`archive_signal`, `flag_signal`, `route_signal`, etc.) would clutter the tool picker and train agents to pattern-match on prefixes. One dispatch tool with an `action` enum keeps the surface small and groups mutations semantically. The agent reasons about *what to do*, then picks an action. Same number of choices, cleaner model.

This is a controversial call — MCP tool pickers often show better UX with flat tool lists. I'm betting the clarity of grouping wins. Reasonable people will disagree.

**Output shape**

```json
{
  "action": "draft_reply",
  "status": "staged",
  "handle": "disp_01HXYZ...",
  "preview": "Here's a draft response..."
}
```

Actions return `staged` by default — the agent is assumed to be proposing, not executing. A follow-up `dispatch` call with `params.commit: true` actually fires it. **Two-phase commit is the default** for anything with side effects. The agent proposes, the human (or a higher-level agent with approval authority) commits.

---

## 5. Resources

### 5.0 What resources are, exactly

Resources are the MCP primitive people skip, and that's a mistake. Let me be precise about what they are, because "resource" is an overloaded word.

**A resource is a readable document identified by a URI.** That's it. When the agent reads `signal://catalog`, it gets back a document (JSON, markdown, plaintext, whatever) with no parameters and no side effects. Identical to opening a file.

**How they differ from tools:**

| | Tools | Resources |
|---|---|---|
| Shape | Function with input schema | URI that returns content |
| Parameters | Yes, required by the tool | None — a URI is a URI |
| Side effects | Possible (dispatch, mutate, compute) | Never |
| Caching | Usually no | Yes — content can be fetched once, reused |
| UI surface | Invoked by the agent | Surfaced in the client UI as attachable context |
| Discovery | `tools/list` returns callable functions | `resources/list` returns URIs |
| Subscriptions | Not supported | Supported — agents can watch for updates |

**How they differ from RAG:**

Your instinct was right that resources are for retrieval, but the mechanism is different:

- **RAG:** agent phrases a semantic question, some system embeds it, does a similarity search over chunked content, returns relevant chunks. The agent doesn't know what documents exist.
- **Resources:** the server publishes a finite list of URIs (`resources/list`). The agent sees the full menu. When it wants one, it reads the whole thing by URI. No embeddings, no similarity search, no chunks.

Resources are the **table of contents** of the server. RAG is the **search engine** inside a document corpus. They coexist — a tool could wrap a RAG system, and resources could expose curated reference material alongside it.

**Why this matters for agent design:**

When a tool returns "here's a list of 847 sources with 40 fields each," the agent will either drown in the payload or throw away 95% of it. When that same data lives at `signal://catalog` as a resource, three things change:

1. The agent reads it **once** per session (or subscribes for updates), then reasons against it repeatedly.
2. The user can **manually attach** the resource to a conversation (in Claude Desktop, Cursor, Windsurf — all clients expose this). They can say "hey, use this catalog" and @-mention it.
3. The agent can **subscribe** to changes — when a new source gets added to the catalog, the server pushes a notification and the agent's context updates without another tool call.

Tools force the agent to ask. Resources let the agent know.

**Three resources. Each one answers a question the agent would otherwise burn tokens on.**

---

### 5.1 `signal://catalog`

**Answers:** "What sources can I scan, and which ones are good for my use case?"
**Mimetype:** `application/json`
**Subscribes:** Yes — catalog changes when sources are added, removed, or their capabilities shift.

```json
{
  "sources": [
    {
      "id": "reddit",
      "kind": "forum",
      "regions": ["en", "multilingual"],
      "update_cadence": "realtime",
      "strengths": ["product complaints", "hiring signals", "technical discussions"],
      "weaknesses": ["noisy for enterprise topics", "anonymized authors"],
      "filters": ["subreddit", "min_score", "flair"]
    }
  ]
}
```

`strengths` and `weaknesses` are the feature. When the agent is deciding which sources to pass to `listen`, it doesn't need to guess — it reads the catalog and reasons: "enterprise signals — skip Reddit, prioritize LinkedIn and industry forums." Most source registries don't give agents this context. They should.

---

### 5.2 `signal://lexicon`

**Answers:** "What do these intent labels actually mean?"
**Mimetype:** `text/markdown`
**Subscribes:** No — lexicon is stable.

Contains definitions for every intent in the classifier's vocabulary. Each entry has:

- **Definition** — one sentence
- **Canonical example** — a real-sounding post that exemplifies the intent
- **Common false positives** — "Someone announcing they built a Linear-clone — that's `building`, not `comparing`"
- **Recommended agent response** — what a good follow-up looks like

The lexicon exists so the agent and the classifier **share a vocabulary**. When `listen` returns `intent: "evaluating"`, the agent knows exactly what that means because it's read the same definition the classifier was trained against. This is how you eliminate the "agent guesses what the label means" failure mode.

---

### 5.3 `signal://playbooks`

**Answers:** "What are the common workflows for this domain, and how do they sequence?"
**Mimetype:** `application/json`
**Subscribes:** Yes — new playbooks get added over time.

```json
{
  "playbooks": [
    {
      "id": "competitor_churn",
      "title": "Find users frustrated with a competitor",
      "steps": [
        { "tool": "listen", "args": { "query": "<competitor> frustrations", "intent_filter": ["complaining"] } },
        { "tool": "inspect", "args": { "depth": "author" }, "for_each": "signal" },
        { "tool": "dispatch", "args": { "action": "draft_reply" }, "when": "author.likely_role_hint == 'indie_founder'" }
      ],
      "expected_outcome": "List of qualified prospects with drafted outreach."
    }
  ]
}
```

Playbooks are **executable recipes**. An agent that has to figure out a three-step workflow from scratch every session is wasting compute. A playbook gives it a starting point that it can follow, adapt, or recombine. This is the layer most MCP servers skip, and it's the difference between an agent that stumbles and one that executes.

---

## 6. Prompts

Prompts are templates the agent can offer back to the user when it wants structured input.

### 6.1 `sweep`

Asks the user for an audience + a goal, produces a scoped `listen` call.

Arguments: `audience` (required), `timeframe` (optional), `depth` (optional).

### 6.2 `triage`

Given a batch of signals, asks the user which ones matter. Outputs a filter spec the agent can use on future listens.

### 6.3 `brief`

Produces a daily/weekly brief template from accumulated signals. This is the "what happened this week in my space" report, generated conversationally.

---

## 7. Error model

Every error is structured:

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "error": {
    "code": -32002,
    "message": "Rate limit exceeded for source 'twitter'",
    "data": {
      "retry_after_seconds": 900,
      "affected_sources": ["twitter"],
      "suggested_action": "Retry with sources omitting 'twitter', or wait and retry all."
    }
  }
}
```

`suggested_action` is non-standard but invaluable. It turns errors into conversations. An agent that reads "Retry with sources omitting 'twitter'" will do exactly that. An agent that reads only "rate limit" will often give up.

Error codes follow JSON-RPC convention (`-32000` to `-32099` for server errors). Application-specific codes are documented per-tool.

---

## 8. Capabilities declaration

The `initialize` response:

```json
{
  "protocolVersion": "2025-11",
  "serverInfo": {
    "name": "signal",
    "version": "1.0.0",
    "vendor": "<your org>",
    "homepage": "https://<your domain>/mcp"
  },
  "capabilities": {
    "tools": { "listChanged": false },
    "resources": { "subscribe": true, "listChanged": false },
    "prompts": { "listChanged": false },
    "logging": {}
  }
}
```

**`resources.subscribe: true`** matters: the catalog changes (new sources added, old ones deprecated), and agents that subscribe will get notified. This is the one capability worth enabling on day one.

---

## 9. Non-goals

Things this spec deliberately does *not* do. Listing them so the scope stays tight.

- **No user management.** Auth is at the session level, not the tool level. Organizations handle user identity outside MCP.
- **No custom tool registration mid-session.** Tools are declared on `initialize`. Agents don't discover new tools during a session.
- **No vector search / embeddings.** The `listen` query is expanded server-side using whatever retrieval method the implementation chooses. The protocol doesn't dictate it.
- **No multi-modal I/O.** Text and JSON only. Images, audio, video are out of scope for v1.
- **No OAuth.** Bearer tokens for v1. Upgrade to OAuth 2.1 when enterprise demands it.
- **No on-prem deployment spec.** Implementation detail, not protocol.

---

## 10. Open design questions

Honest uncertainties. Some resolved in v1.0 from real-world feedback; others remain.

**Q1: Stream or paginate `listen` results?** → **Resolved: stream.**
Streamable HTTP preserves SSE under the hood as its streaming mode, so the "SSE is gone" worry was misplaced — streaming costs nothing extra and gets first-result latency down to ~200ms. Pagination remains available via the `limit` cap for deterministic batches when needed.

**Q2: Is `dispatch` trying to do too much?** → **Resolved: keep the grouped design.**
Real-world data from 30+ tool production deployments says agents pick the right tool reliably when boundaries are sharp, and the failure mode is picking *two* tools when one would do — which is a system prompt concern, not a schema concern. The grouped `dispatch` with an action enum is the right call.

**Q3: Should playbooks be resources or prompts?** → **Resolved: resources.**
Playbooks are read proactively — the agent needs to see them without being prompted by the user. That's the defining property of a resource. Subscribable so new playbooks surface automatically.

**Q4: Intent vocabulary — is 10 the right size?** → **Open, leaning toward expansion.**
Context windows are 1M tokens now. The old "minimize vocabulary to reduce classifier confusion" argument is weaker than it was when context was the bottleneck. Likely v1.1 work: expand to 15–20 intents with sharper sub-distinctions (e.g. split `complaining` into `complaining_price`, `complaining_reliability`, `complaining_ux`). Requires classifier training data and evaluation before committing.

**Q5: Streaming format inside Streamable HTTP — newline-delimited JSON, or full SSE `event:` / `data:` framing?** → **Open.**
The spec allows either. SSE framing gives better client-side tooling (every HTTP client library handles it); NDJSON is simpler. Implementation detail, but worth getting right early since it affects every consumer.

---

## 11. What this spec deliberately leaves to the implementation

- How `listen` expands a natural-language query into keywords (embedding search, LLM expansion, rules, hybrid — implementer's call)
- How intent classification works (zero-shot LLM? Fine-tuned model? Heuristics?)
- Which sources are supported at launch
- Storage backend for session state
- Rate limiting strategy
- Pricing and plan gating
- How the source catalog is curated

These are product and engineering decisions. The spec defines the contract.

---

## 12. What makes this different from "wrap the REST API"

If I'd just wrapped a signal-scanning REST API, I would have ended up with:

- `list_sources`, `scan_source`, `get_signal`, `get_author`, `mark_read`, `send_reply`
- Flat tool namespace, no resources, no prompts
- Keyword-based scan inputs
- Raw pagination cursors
- Generic error messages

What this spec does instead:

- **Natural-language queries** instead of keyword arrays
- **Three sharp tools** (`listen`, `inspect`, `dispatch`) instead of six thin ones
- **Decision-ready output** (`match_reason`, `karma_bucket`, `intent_confidence`) instead of raw fields
- **Resources as mental model** (`catalog`, `lexicon`, `playbooks`) instead of making the agent ask every time
- **Two-phase commit by default** on mutations
- **Structured errors with `suggested_action`**
- **Executable playbooks** the agent can follow

Same domain. Different level of care. This is the design I'd defend if someone asked me "what does a great MCP server look like in 2026?"

---

## 13. What needs to be built

This spec is the contract. Here's what an implementer actually has to build to satisfy it, ordered by dependency.

**Foundation (nothing runs without this):**

1. **Streamable HTTP server** at `POST /mcp` and `GET /mcp`, speaking JSON-RPC 2.0 per MCP `2025-11`. Origin validation, `Mcp-Session-Id` header, optional SSE upgrade for streaming.
2. **stdio transport wrapper** for local deployments (Claude Desktop, Cursor, Windsurf).
3. **`initialize` handler** returning the capabilities block from §8, including `resources.subscribe: true`.

**Core tools (the value layer):**

4. **`listen` tool** — natural-language query expansion (LLM call or hybrid retrieval), source dispatch, intent classification pipeline, streaming response shaping. This is the hard one. It's the whole product.
5. **`inspect` tool** — single-signal deep fetch, threaded comment retrieval, author history aggregation, `likely_role_hint` classifier.
6. **`dispatch` tool** — action router for five verbs, two-phase commit with `params.commit` flag, handle tracking.

**Context layer (the differentiator):**

7. **`signal://catalog` resource** — JSON document with source metadata including `strengths` and `weaknesses` (requires editorial work, not just engineering).
8. **`signal://lexicon` resource** — markdown document authored against the classifier's training data.
9. **`signal://playbooks` resource** — authored workflows; start with 3–5, grow over time.
10. **Resource subscription notifications** for catalog and playbook updates.

**Prompts:**

11. **`sweep`, `triage`, `brief` prompt templates.**

**Error handling & operational:**

12. **Structured error responses** with `suggested_action` field.
13. **Rate limiting** (per-session, per-source backoff).
14. **Observability** — session ID, tool name, client name/version logged on every call.

**Launch-blocking nice-to-haves:**

15. MCP Inspector compatibility pass (`npx @modelcontextprotocol/inspector`).
16. Submission to the public MCP server registry.

**Ship order if you want to be in users' hands fast:**

Ship `listen` + `signal://lexicon` + `sweep` prompt as v0.1. That's a usable MVP — the agent can ask "what do these labels mean" (lexicon), scope a query (sweep prompt), and run a scan (listen). Everything else is v1.0 work.

---

## 14. Reference implementation sketch

A minimal TypeScript skeleton that satisfies the spec. Not production code — a *shape* you can crib from. Uses the official MCP TypeScript SDK.

```ts
// server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const server = new McpServer(
  { name: "signal", version: "1.0.0" },
  { capabilities: { tools: {}, resources: { subscribe: true }, prompts: {} } }
);

// ─── TOOLS ─────────────────────────────────────────────────

server.tool(
  "listen",
  "Scan public sources for signals matching a query. The query is natural language — the server handles keyword expansion. Returns a stream of ranked signals with intent classification. Freshness defaults to this_week; omit `scope.sources` to let the server pick intelligently based on the query.",
  {
    query: z.string(),
    scope: z.object({
      sources: z.array(z.string()).optional(),
      freshness: z.enum(["last_hour", "today", "this_week", "this_month", "any"]).default("this_week"),
      min_engagement: z.number().int().optional(),
    }).optional(),
    intent_filter: z.array(z.enum([
      "buying", "evaluating", "hiring", "complaining", "recommending",
      "learning", "building", "announcing", "asking", "comparing"
    ])).optional(),
    limit: z.number().int().max(100).default(20),
  },
  async (args) => {
    // Implementation:
    // 1. Expand args.query into keywords (LLM or hybrid retrieval)
    // 2. If scope.sources omitted, pick sources from signal://catalog
    //    based on query characteristics
    // 3. Dispatch concurrent fetches, stream results as they arrive
    // 4. Classify intent per signal, attach match_reason
    // 5. Shape output per §4.1, return
    const signals = await runListen(args);
    return { content: [{ type: "text", text: JSON.stringify(signals) }] };
  }
);

server.tool(
  "inspect",
  "Deep-dive on a single signal by ID. depth='surface' returns signal only. depth='thread' (default) adds comments. depth='author' adds posting history and role hint. Use 'author' for lead qualification, 'surface' for cache checks.",
  {
    signal_id: z.string(),
    depth: z.enum(["surface", "thread", "author"]).default("thread"),
  },
  async ({ signal_id, depth }) => {
    const result = await runInspect(signal_id, depth);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "dispatch",
  "Take an action on a signal. Actions: archive, flag, route, draft_reply, schedule_followup. By default actions are STAGED — they don't fire. Set params.commit=true on a follow-up call with the returned handle to execute. Two-phase commit is the default for anything with side effects.",
  {
    signal_id: z.string(),
    action: z.enum(["archive", "flag", "route", "draft_reply", "schedule_followup"]),
    params: z.object({ commit: z.boolean().optional() }).passthrough().optional(),
  },
  async (args) => {
    const outcome = await runDispatch(args);
    return { content: [{ type: "text", text: JSON.stringify(outcome) }] };
  }
);

// ─── RESOURCES ─────────────────────────────────────────────

server.resource(
  "catalog",
  "signal://catalog",
  { mimeType: "application/json", description: "Source registry with strengths/weaknesses metadata." },
  async () => ({
    contents: [{ uri: "signal://catalog", mimeType: "application/json", text: JSON.stringify(await loadCatalog()) }]
  })
);

server.resource(
  "lexicon",
  "signal://lexicon",
  { mimeType: "text/markdown", description: "Intent vocabulary with definitions, examples, and false-positive guidance." },
  async () => ({
    contents: [{ uri: "signal://lexicon", mimeType: "text/markdown", text: await loadLexicon() }]
  })
);

server.resource(
  "playbooks",
  "signal://playbooks",
  { mimeType: "application/json", description: "Executable workflow recipes composed of listen/inspect/dispatch calls." },
  async () => ({
    contents: [{ uri: "signal://playbooks", mimeType: "application/json", text: JSON.stringify(await loadPlaybooks()) }]
  })
);

// ─── PROMPTS ───────────────────────────────────────────────

server.prompt(
  "sweep",
  "Scope a listen call by asking the user for an audience and timeframe.",
  { audience: z.string(), timeframe: z.string().optional(), depth: z.string().optional() },
  async ({ audience, timeframe, depth }) => ({
    messages: [{ role: "user", content: { type: "text", text: buildSweepPrompt(audience, timeframe, depth) } }]
  })
);

// (triage and brief follow the same pattern)

// ─── TRANSPORT ─────────────────────────────────────────────

// Streamable HTTP — single endpoint, POST + optional SSE upgrade on GET
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
  onsessioninitialized: (sid) => console.log(`session ${sid} opened`),
  // Required: validate Origin header per MCP spec
  // (SDK exposes this via middleware; validate against your allowlist)
});

await server.connect(transport);
```

**Errors — the structured shape:**

```ts
// When rate-limited, throw with structured data
throw {
  code: -32002,
  message: "Rate limit exceeded for source 'twitter'",
  data: {
    retry_after_seconds: 900,
    affected_sources: ["twitter"],
    suggested_action: "Retry with sources omitting 'twitter', or wait and retry all."
  }
};
```

That's the whole skeleton. ~80 lines for all nine surfaces (3 tools + 3 resources + 3 prompts), plus transport. The implementation work lives inside `runListen`, `runInspect`, `runDispatch`, `loadCatalog`, `loadLexicon`, `loadPlaybooks`, and the intent classifier. Those are where the product is. The protocol surface is boring, and it should be.

**Python equivalent** — same shape using the `mcp` Python SDK:

```python
from mcp.server import Server
from mcp.server.streamable_http import streamable_http_server
from mcp import types

server = Server("signal")

@server.call_tool()
async def listen(name, arguments):
    # Same logic as the TS version
    ...

# Resources and prompts follow the decorator pattern
```

---

## 15. Conformance checklist

An implementation conforms to this spec if it passes every item below. Use this as a test plan or a review gate.

**Protocol layer:**

- [ ] Streamable HTTP endpoint at a single URL accepts POST and GET
- [ ] `initialize` returns `protocolVersion: "2025-11"` and the capabilities block from §8
- [ ] `Mcp-Session-Id` header issued on `initialize`, echoed on every subsequent request
- [ ] `Origin` header validated on every request; rejects missing or disallowed origins
- [ ] `ping` method responds within 100ms
- [ ] JSON-RPC errors follow the `-32xxx` code convention
- [ ] All errors include `data.suggested_action` where a recovery path exists

**Tools:**

- [ ] `tools/list` returns exactly three tools: `listen`, `inspect`, `dispatch`
- [ ] `listen` accepts a natural-language `query` string as required input
- [ ] `listen` with only `query` (no other params) returns results — defaults work
- [ ] `listen` results include all fields from §4.1 output shape, including `match_reason` and `intent_confidence`
- [ ] `listen` streams partial results (first result ≤ 500ms, or the implementation documents why not)
- [ ] `inspect` supports all three depth levels: `surface`, `thread`, `author`
- [ ] `dispatch` returns `status: "staged"` by default; only fires side effects when `params.commit: true`
- [ ] `dispatch` returns a `handle` for every call

**Resources:**

- [ ] `resources/list` returns exactly three URIs: `signal://catalog`, `signal://lexicon`, `signal://playbooks`
- [ ] `signal://catalog` includes `strengths` and `weaknesses` arrays for every source
- [ ] `signal://lexicon` covers every intent value returned by `listen`
- [ ] `signal://playbooks` entries use only tool/arg combinations valid under this spec
- [ ] Resource subscriptions work for `catalog` and `playbooks`
- [ ] `resources/read` on any listed URI succeeds without authentication beyond the session bearer

**Prompts:**

- [ ] `prompts/list` returns exactly three prompts: `sweep`, `triage`, `brief`
- [ ] `sweep` with minimum arguments produces a runnable prompt

**Observability:**

- [ ] Every tool call logs session ID, tool name, client name, client version, latency
- [ ] Errors are logged with their structured `data` payload intact

**Launch-blocking:**

- [ ] Passes `npx @modelcontextprotocol/inspector` without warnings
- [ ] Works in Claude Desktop with only a config entry — no additional setup
- [ ] Works in Cursor and Windsurf with the same config pattern

A partial implementation is allowed to fail any item, but should declare which ones in its README. "Signal-compatible, conformance-level A/B/C" is a reasonable future versioning scheme.

---

## 16. The one principle above all others

If you only remember one thing from this document, remember this:

> **The best MCP server is invisible to the agent's reasoning.**

Meaning: a great server lets the agent think about *its user's goal*, not about the server's quirks. Bad servers force the agent to translate between "what the user wants" and "what weird shape this API expects." Good servers are shaped so the agent's natural reasoning compiles directly into correct tool calls.

You can measure this. Take a hundred real user requests. Feed them to an agent with your MCP server connected. Count how many complete without the agent having to *reshape* the request. That ratio is your design quality. Everything in this document is in service of getting that number close to 1.0.

The rest of the spec — the tool shapes, the resource structure, the two-phase commits — is just the application of this principle to the signal intelligence domain.

---

## 17. Closing note

The goal of this document wasn't to describe what exists. It was to describe what *should* exist. Whether you build this, something like it, or something entirely different, the principles in §1 are portable. Use them. Discard them. Argue with them.

The worst MCP server is a faithful wrapper of a REST API. The best MCP server is a carefully-designed conversation surface for agents. Most implementations land closer to the first than the second. This spec is an attempt to describe what the second actually looks like.

---

**Signed,**
**Claude (Opus 4.7), Anthropic**
**April 16, 2026**

*Written for Mark Allen Evans at AiAssist / Interchained. Published under MIT license. Fork it, build it, break it, improve it — the design is only as good as the implementations that refute or confirm it.*
