# Signal MCP — Conformance Checklist

Mirrors **§15** of the [Signal MCP spec](../../../README.md). An implementation conforms if it passes every item below. Use this as the test plan or review gate.

v0.1 status annotations added in brackets: `[v0.1]` = shipped in this release, `[v1.0]` = not yet.

## Protocol layer

- [ ] Streamable HTTP endpoint at a single URL accepts POST and GET — **[v1.0]** (stdio-only in v0.1 per ship-order §13)
- [x] `initialize` returns `protocolVersion: "2025-11"` and the capabilities block from §8 — **[v0.1]**
- [x] `Mcp-Session-Id` header issued on `initialize`, echoed on every subsequent request — **[v0.1]** (handled by the SDK transport)
- [ ] `Origin` header validated on every request; rejects missing or disallowed origins — **[v1.0]** (Streamable HTTP concern)
- [x] `ping` method responds within 100ms — **[v0.1]** (SDK)
- [x] JSON-RPC errors follow the `-32xxx` code convention — **[v0.1]**
- [x] All errors include `data.suggested_action` where a recovery path exists — **[v0.1]**

## Tools

- [x] `tools/list` returns exactly three tools: `listen`, `inspect`, `dispatch` — **[v0.1]**
- [x] `listen` accepts a natural-language `query` string as required input — **[v0.1]** (schema validated)
- [ ] `listen` with only `query` (no other params) returns results — defaults work — **[v1.0]** (v0.1 stubs the pipeline)
- [ ] `listen` results include all fields from §4.1 output shape, including `match_reason` and `intent_confidence` — **[v1.0]**
- [ ] `listen` streams partial results (first result ≤ 500ms, or the implementation documents why not) — **[v1.0]** (MCP progress notifications per Mark's Q6)
- [ ] `inspect` supports all three depth levels: `surface`, `thread`, `author` — **[v1.0]** (schema validated; body stubbed)
- [ ] `dispatch` returns `status: "staged"` by default; only fires side effects when `params.commit: true` — **[v1.0]**
- [ ] `dispatch` returns a `handle` for every call — **[v1.0]**

## Resources

- [x] `resources/list` returns exactly three URIs: `signal://catalog`, `signal://lexicon`, `signal://playbooks` — **[v0.1]**
- [ ] `signal://catalog` includes `strengths` and `weaknesses` arrays for every source — **[v1.0]** (awaiting source list)
- [x] `signal://lexicon` covers every intent value returned by `listen` — **[v0.1]** (draft covers all 10 intents; awaiting Mark's edit)
- [ ] `signal://playbooks` entries use only tool/arg combinations valid under this spec — **[v1.0]**
- [ ] Resource subscriptions work for `catalog` and `playbooks` — **[v1.0]**
- [x] `resources/read` on any listed URI succeeds without authentication beyond the session bearer — **[v0.1]** (lexicon only in v0.1)

## Prompts

- [x] `prompts/list` returns exactly three prompts: `sweep`, `triage`, `brief` — **[v0.1]**
- [x] `sweep` with minimum arguments produces a runnable prompt — **[v0.1]**

## Observability

- [ ] Every tool call logs session ID, tool name, client name, client version, latency — **[v1.0]**
- [ ] Errors are logged with their structured `data` payload intact — **[v1.0]**

## Launch-blocking

- [ ] Passes `npx @modelcontextprotocol/inspector` without warnings — **[v0.1 gate]** (`npm run inspector`)
- [ ] Works in Claude Desktop with only a config entry — no additional setup — **[v0.1 gate]**
- [ ] Works in Cursor and Windsurf with the same config pattern — **[v0.1 gate]**

---

A partial implementation declares which items it fails. v0.1 is "Signal-compatible, conformance-level B" — full protocol, full surface coverage, `listen` / `sweep` / `lexicon` bodies functional; remaining bodies ship with v1.0.
