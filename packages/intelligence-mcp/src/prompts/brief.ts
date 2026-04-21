import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * `brief` prompt (spec §6.3) — produces a daily/weekly brief template from
 * accumulated signals.
 *
 * Like `triage`, this is a static prompt template. The agent is expected to
 * call `listen` (and optionally read flagged signals) to gather material,
 * then follow the template to synthesize the brief in-conversation.
 */

export function registerBrief(server: McpServer): void {
  server.registerPrompt(
    "brief",
    {
      title: "brief",
      description:
        "Produce a daily or weekly brief from accumulated signals — grouped by intent, one crisp paragraph per group, with direct links back to sig_* IDs.",
      argsSchema: {
        cadence: z
          .string()
          .optional()
          .describe(
            "'daily' or 'weekly' (default 'weekly'). Controls the brief's time window and depth.",
          ),
        topic: z
          .string()
          .optional()
          .describe(
            "What's the brief about? e.g. 'Clay + enrichment competitors', 'Rails ecosystem hiring'. Required unless the agent has a recent `listen` query it can reuse.",
          ),
      },
    },
    (args) => {
      const cadence = (typeof args?.cadence === "string" ? args.cadence : "weekly").toLowerCase();
      const topic = typeof args?.topic === "string" && args.topic.length > 0 ? args.topic : null;
      const freshness = cadence === "daily" ? "today" : "this_week";

      return {
        description: `Synthesize a ${cadence} brief.`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Produce a ${cadence} brief${topic ? ` on "${topic}"` : ""}.`,
                "",
                "Procedure:",
                `1. If signals are not already in scope, call \`listen\` with ${topic ? `query="${topic}"` : "the most recent user-supplied query"}, scope.freshness="${freshness}", limit=40.`,
                "2. Group signals by `intent`. Skip intents with zero signals.",
                "3. For each group, write ONE paragraph (<= 90 words) in this shape:",
                "   - Open with the intent label in bold and a one-line theme sentence ('What's happening:').",
                "   - Follow with 2–4 specific signals cited by headline + author, each tagged with its sig_* id in parentheses so the user can re-open with `inspect`.",
                "   - Close with a one-sentence 'Why it matters' line. Plain English. No marketing voice.",
                "4. Do not include signals with `intent_confidence < 0.5` unless you first called `inspect depth=thread` to verify.",
                "5. Flag any signal where `flagged: true` appears — prefix the bullet with `★` and surface the flag_note.",
                "",
                "Output:",
                "",
                "```markdown",
                `# ${cadence.charAt(0).toUpperCase()}${cadence.slice(1)} brief${topic ? ` — ${topic}` : ""}`,
                "_Window: <freshness bucket>_ · _Signals reviewed: <n>_",
                "",
                "## <intent-label>",
                "**What's happening:** ...",
                "- <headline> — <author> (<sig_...>)",
                "**Why it matters:** ...",
                "",
                "## <next intent-label>",
                "...",
                "```",
                "",
                "Rules:",
                "- No emoji except ★ for flagged items.",
                "- Never fabricate a source or a sig_* id. Every citation must come from this conversation's listen results.",
                "- End with a one-line footer: `Next step: <the single most useful follow-up call>` (e.g. `dispatch action=route` for a specific sig_*).",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );
}
