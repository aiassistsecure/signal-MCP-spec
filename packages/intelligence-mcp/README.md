# @aiassist-secure/intelligence-mcp

Reference implementation of the **[Signal MCP spec](../../README.md)** — an opinionated MCP server for signal intelligence, built on top of [api.aiassist.net](https://api.aiassist.net).

> Status: **v0.1 scaffold.** Ships the full surface area (three tools, three resources, three prompts per spec §2) so MCP clients see the right tool list. `signal://lexicon` and the `sweep` prompt are live. `listen`, `inspect`, `dispatch`, `signal://catalog`, `signal://playbooks`, `triage`, and `brief` return structured `-32002` errors with `suggested_action` until v1.0.

Ship order follows spec **§13**: `listen` + `signal://lexicon` + `sweep` = v0.1 MVP.

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

| Surface | Type | v0.1 state |
|---|---|---|
| `listen` | tool | schema + description final; pipeline stubbed |
| `inspect` | tool | schema + description final; body ships v1.0 |
| `dispatch` | tool | schema + description final; body ships v1.0 |
| `signal://catalog` | resource | stubbed; awaiting authoritative source list |
| `signal://lexicon` | resource | **live** — all 10 intents drafted per §4.1 |
| `signal://playbooks` | resource | ships with v1.0 |
| `sweep` | prompt | **live** — audience + timeframe + depth → scoped listen call |
| `triage` | prompt | ships with v1.0 |
| `brief` | prompt | ships with v1.0 |

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
