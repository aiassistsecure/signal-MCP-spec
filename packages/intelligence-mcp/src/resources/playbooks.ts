import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * `signal://playbooks` — executable workflow recipes (spec §5.3).
 *
 * Static v1.0 JSON shipped with the package. Each playbook is a sequence of
 * tool calls the agent can follow, adapt, or recombine. Net-new playbooks get
 * added in later releases; subscribers pick up changes when the catalog
 * version bumps.
 *
 * Every playbook uses ONLY tool/arg combinations valid under this spec
 * (conformance §15). No invented surfaces.
 */

export interface Playbook {
  id: string;
  title: string;
  when_to_use: string;
  steps: PlaybookStep[];
  expected_outcome: string;
  caveats?: string[];
}

export interface PlaybookStep {
  tool?: "listen" | "inspect" | "dispatch";
  resource?: string;
  args?: Record<string, unknown>;
  for_each?: "signal";
  when?: string;
  note?: string;
}

export const PLAYBOOKS: { version: string; playbooks: Playbook[] } = {
  version: "2026-04-v1",
  playbooks: [
    {
      id: "competitor_churn",
      title: "Find users frustrated with a competitor",
      when_to_use:
        "Prospecting into a category where a dominant competitor has pricing / reliability / UX pain. Works best when the competitor's name is distinctive.",
      steps: [
        {
          resource: "signal://lexicon",
          note: "Read once. Confirms `complaining` label boundaries — critical because this playbook thresholds on it.",
        },
        {
          tool: "listen",
          args: {
            query: "<competitor name> pricing OR support OR reliability complaints",
            intent_filter: ["complaining"],
            scope: { freshness: "this_week" },
          },
        },
        {
          tool: "inspect",
          args: { depth: "author" },
          for_each: "signal",
          when: "intent_confidence >= 0.7",
          note: "Qualify the poster — are they an actual buyer or a drive-by commenter?",
        },
        {
          tool: "dispatch",
          args: { action: "draft_reply" },
          when: "author_context.likely_role_hint == 'indie_founder'",
          note: "Staged only. Human reviews + posts.",
        },
      ],
      expected_outcome:
        "List of qualified prospects with drafted outreach. Handles for every dispatch live in the agent's working memory for a commit call.",
      caveats: [
        "Reddit and HN authors do not have cross-source identity — `author_context.scope` is `single_source`.",
        "Posting replies is always out of scope for `dispatch`; the draft is the artifact.",
      ],
    },
    {
      id: "hiring_pulse",
      title: "Monitor hiring-signal spikes in a role or stack",
      when_to_use:
        "Candidate outreach, market mapping, or sales-intel when a role pattern (e.g. 'senior Rails contractor') signals buying intent for adjacent products.",
      steps: [
        {
          tool: "listen",
          args: {
            query: "<role + stack>, hiring or contract",
            intent_filter: ["hiring"],
            scope: { freshness: "this_week", sources: ["reddit", "hackernews", "linkedin_jobs"] },
          },
        },
        {
          tool: "inspect",
          args: { depth: "thread" },
          for_each: "signal",
          note: "Thread depth surfaces comp/location/stack detail the summary excerpt drops.",
        },
        {
          tool: "dispatch",
          args: { action: "route", params: { destination: "contacts" } },
          when: "commit is approved",
          note: "Lands the hiring manager as a contact in CRM.",
        },
      ],
      expected_outcome:
        "Active hiring signals segmented by role + stack, with CRM contact handles for follow-up.",
    },
    {
      id: "launch_watch",
      title: "Track launches and announcements in a category",
      when_to_use:
        "Competitive intel, partnership scouting, or content-generation triggers when new products ship in your space.",
      steps: [
        {
          tool: "listen",
          args: {
            query: "<category> launched OR announced OR shipped",
            intent_filter: ["announcing", "building"],
            scope: {
              freshness: "this_week",
              sources: ["hackernews", "producthunt", "betalist", "launchingnext", "indiehackers"],
            },
          },
        },
        {
          tool: "dispatch",
          args: { action: "flag", params: { note: "launch-watch" } },
          for_each: "signal",
          when: "intent_confidence >= 0.7",
          note: "Stash high-confidence launches under the 'launch-watch' flag for weekly review.",
        },
      ],
      expected_outcome:
        "A running set of flagged signals ready for the `brief` prompt to produce a weekly launches summary.",
    },
    {
      id: "weekly_brief",
      title: "Produce a weekly signal brief for a topic",
      when_to_use:
        "End-of-week writeup for a watched topic — combine fresh listens with previously-flagged material into a single report.",
      steps: [
        {
          tool: "listen",
          args: { query: "<topic>", scope: { freshness: "this_week" }, limit: 40 },
        },
        {
          tool: "inspect",
          args: { depth: "thread" },
          for_each: "signal",
          when: "intent_confidence < 0.6",
          note: "Confirm low-confidence signals before they land in the brief.",
        },
        {
          resource: "signal://lexicon",
          note: "Cross-reference any surprising intent labels.",
        },
      ],
      expected_outcome:
        "A 10–20 item brief grouped by intent, with confidence-gated dips into thread depth only where needed.",
    },
    {
      id: "buyer_triage",
      title: "Triage a batch of listen results into a reusable filter",
      when_to_use:
        "After a broad first pass, to extract what worked and reuse it as scoped filters for the next session.",
      steps: [
        {
          tool: "listen",
          args: { query: "<broad query>", limit: 60 },
        },
        {
          note: "Hand the result batch to the user via the `triage` prompt; they mark which signals matter.",
        },
        {
          note: "Apply the resulting filter spec (sources + intent + min_engagement) to the next `listen`.",
        },
      ],
      expected_outcome:
        "A tightened query scope that the agent can reuse on subsequent sessions without re-asking the user.",
    },
  ],
};

export function registerPlaybooksResource(server: McpServer): void {
  server.registerResource(
    "playbooks",
    "signal://playbooks",
    {
      title: "Playbooks",
      description:
        "Executable workflow recipes composed of listen/inspect/dispatch calls plus resource reads. Gives the agent a starting point for common tasks (competitor-churn, hiring-pulse, launch-watch, weekly-brief, buyer-triage) instead of re-deriving the sequence each session.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "signal://playbooks",
          mimeType: "application/json",
          text: JSON.stringify(PLAYBOOKS, null, 2),
        },
      ],
    }),
  );
}
