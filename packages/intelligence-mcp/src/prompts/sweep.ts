import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * `sweep` prompt (spec §6.1) — asks the user for an audience + a goal, then
 * emits a message that a downstream agent can turn into a scoped `listen` call.
 *
 * Arguments: `audience` required; `timeframe` and `depth` optional.
 */

export const SWEEP_DESCRIPTION =
  "Scope a listen call by asking the user for an audience, an optional timeframe, and an optional depth. The returned message is ready to hand to an agent with `listen` in its toolbox.";

export function registerSweep(server: McpServer): void {
  server.registerPrompt(
    "sweep",
    {
      title: "sweep",
      description: SWEEP_DESCRIPTION,
      argsSchema: {
        audience: z
          .string()
          .min(1)
          .describe(
            "Who are we listening for? e.g. 'indie SaaS founders frustrated with Clay', 'senior Rails engineers open to contract work', 'teams evaluating durable workflow engines'.",
          ),
        timeframe: z
          .string()
          .optional()
          .describe(
            "How recent? e.g. 'last 24 hours', 'this week' (default), 'this month'. Maps to the `listen` freshness enum.",
          ),
        depth: z
          .string()
          .optional()
          .describe(
            "Shallow ('just headlines'), standard (default — shaped summaries), or deep ('include author context'). Hints how aggressively the agent should follow up with `inspect`.",
          ),
      },
    },
    (args) => {
      const audience = args.audience;
      const timeframe = args.timeframe?.trim() || "this week";
      const depth = args.depth?.trim() || "standard";

      const freshnessHint = freshnessFor(timeframe);
      const depthHint = depthFor(depth);

      const text = [
        `Run a signal sweep.`,
        ``,
        `**Audience:** ${audience}`,
        `**Timeframe:** ${timeframe}${freshnessHint ? `  (freshness enum: \`${freshnessHint}\`)` : ""}`,
        `**Depth:** ${depth}`,
        ``,
        `Steps:`,
        `1. Call \`listen\` with a natural-language \`query\` describing the audience above. Do NOT pre-extract keywords — the server handles expansion.`,
        freshnessHint
          ? `2. Pass \`scope.freshness: "${freshnessHint}"\`.`
          : `2. Pick a \`scope.freshness\` value from the allowed enum (last_hour | today | this_week | this_month | any).`,
        `3. Leave \`scope.sources\` unset on the first pass — let the server route based on the query. Read \`signal://catalog\` only if the first pass misses.`,
        `4. If you're unsure what an intent label means in the results, read \`signal://lexicon\` before drawing conclusions.`,
        depthHint,
        `6. Return a concise brief: top ${depth === "shallow" ? "5" : "10"} signals with headline, intent (+ confidence), and your one-line take on each.`,
        `7. Do NOT call \`dispatch\` without explicit user approval — mutations are two-phase.`,
      ].join("\n");

      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text },
          },
        ],
      };
    },
  );
}

function freshnessFor(timeframe: string): string | null {
  const t = timeframe.toLowerCase();
  if (/\blast[\s_-]?hour\b|past hour|1h|hour\b/.test(t)) return "last_hour";
  if (/\btoday\b|24h|last day/.test(t)) return "today";
  if (/\bthis week\b|week\b|7d|last 7/.test(t)) return "this_week";
  if (/\bthis month\b|month\b|30d|last 30/.test(t)) return "this_month";
  if (/\bany\b|all time|ever/.test(t)) return "any";
  return null;
}

function depthFor(depth: string): string {
  const d = depth.toLowerCase();
  if (d.startsWith("shallow")) return `5. Do not call \`inspect\`. Headlines + match_reason are enough.`;
  if (d.startsWith("deep"))
    return `5. For each of the top 3 signals, call \`inspect\` with \`depth: "author"\` to qualify the poster before reporting.`;
  return `5. For anything with \`intent_confidence < 0.6\` or a surprising \`match_reason\`, call \`inspect\` with the default \`thread\` depth to confirm before including.`;
}
