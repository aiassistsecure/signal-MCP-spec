# @aiassist-secure/intelligence-mcp

Reference implementation of the **[Signal MCP spec](../../README.md)** — an opinionated MCP server for signal intelligence, built on top of [api.aiassist.net](https://api.aiassist.net).

> Status: **v1.0.** All three tools, three resources, and three prompts are live and wired to `api.aiassist.net`. Scoped to what the current backend supports per [REALITY.md](../../REALITY.md); future backend endpoints are catalogued in [BACKEND-GAPS.md](../../BACKEND-GAPS.md).

Ship order follows spec **§13**: v0.1 MVP shipped `listen` + `signal://lexicon` + `sweep`; v1.0 fills out the remaining surfaces.

---

## Install

```sh
npm install -g @aiassist-secure/intelligence-mcp
```

or run ad-hoc:

```sh
npx @aiassist-secure/intelligence-mcp
```

## Configure

Set your aiassist.net bearer token in the environment:

```sh
export AIAS_API_KEY="aai_..."
```

Get a key at [aiassist.net](https://aiassist.net). BYOK for the underlying LLM providers (OpenAI, Anthropic, Gemini, Groq, Mistral) is handled upstream — the MCP server stays provider-agnostic and passes the token through.

Optional:

- `AIAS_API_BASE_URL` — override the API base (default `https://api.aiassist.net`).
- `AIAS_ORG_ID` — org scoping for `archive` / `flag` dispatch side effects. Defaults to `"default"` (fine for single-user stdio).

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "signal": {
      "command": "npx",
      "args": ["-y", "@aiassist-secure/intelligence-mcp"],
      "env": {
        "AIAS_API_KEY": "aai_..."
      }
    }
  }
}
```

Restart Claude Desktop. The `signal` server appears in the tool picker with `listen`, `inspect`, `dispatch`, plus the three resources and three prompts.

## Cursor / Windsurf

Same config shape under each editor's MCP settings. See the [MCP client docs](https://modelcontextprotocol.io/clients) for exact paths.

## Verify with MCP Inspector

```sh
npm run inspector
```

Launches the official inspector pointed at the local build. Every surface should list cleanly; calling `listen` (or any unshipped surface) returns a well-formed `-32002` error with a `suggested_action`.

---

## What's in the box

| Surface | Type | v1.0 state |
|---|---|---|
| `listen` | tool | **live** — keyword expansion → scan → LLM intent classification → streamed via MCP progress notifications |
| `inspect` | tool | **live** — cache-first lookup with rescan fallback; `depth: surface\|thread\|author` |
| `dispatch` | tool | **live** — two-phase commit; `archive`/`flag`/`route`/`draft_reply`; `schedule_followup` returns `-32004` (see caveats) |
| `signal://catalog` | resource | **live** — live source list from the API + 22 sources of MCP-side strengths/weaknesses |
| `signal://lexicon` | resource | **live** — all 10 intents + v1.0 response-shape notes |
| `signal://playbooks` | resource | **live** — 5 static recipes (competitor-churn, hiring-pulse, launch-watch, weekly-brief, buyer-triage) |
| `sweep` | prompt | **live** — audience + timeframe + depth → scoped listen call |
| `triage` | prompt | **live** — walks a listen batch → reusable filter spec |
| `brief` | prompt | **live** — daily/weekly brief grouped by intent |

### v1.0 response-shape caveats (REALITY.md §5)

Two fields decorate `inspect` responses and declare honestly what the current backend can and cannot deliver:

- `thread_completeness: "post_body_only"` on `depth=thread` / `depth=author` — the backend does not yet expose comment trees, so `thread` contains the OP body only. (BACKEND-GAPS §2.1)
- `author_context.scope: "single_source"` on `depth=author` — author history is derived by rescanning the originating source only; cross-source identity resolution is unavailable. (BACKEND-GAPS §2.2)

And one error return:

- `dispatch action="schedule_followup"` → JSON-RPC `-32004`. No scheduler backing in v1.0 (BACKEND-GAPS §3.5). Substitute `action="flag"` with a note or `action="route"` into CRM.

## Develop

```sh
git clone https://github.com/aiassistsecure/signal-MCP-spec.git
cd signal-MCP-spec/packages/intelligence-mcp
npm install
npm run build
npm test
```

- `npm run dev` — tsup watch mode
- `npm run typecheck` — strict `tsc --noEmit`
- `npm run inspector` — MCP Inspector against the built CLI

---

## License

MIT. See [LICENSE](../../LICENSE) at the repo root.

## Links

- **Spec:** [../../README.md](../../README.md)
- **Conformance checklist:** [tests/conformance.md](./tests/conformance.md)
- **Upstream API:** [api.aiassist.net](https://api.aiassist.net) · [OpenAPI](https://api.aiassist.net/openapi.json)
- **Issues:** https://github.com/aiassistsecure/signal-MCP-spec/issues
