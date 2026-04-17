import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * `signal://lexicon` — intent vocabulary (spec §5.2).
 *
 * Authored against the 10 intents in §4.1. The classifier and the agent share
 * this vocabulary — when `listen` returns intent="evaluating", the agent knows
 * exactly what that label means because it read the same definition the
 * classifier was trained against.
 *
 * Draft v0 — refine in review.
 */
export const LEXICON_MARKDOWN = `# Signal Lexicon

Intent vocabulary for the \`signal\` MCP server, v0.1.

These are the ten labels the classifier applies to every signal surfaced by \`listen\`. Each entry has four parts: a one-sentence **definition**, a **canonical example** (a real-shaped post), **common false positives**, and a **recommended agent response** — what a good follow-up looks like when this intent is the strongest match.

Thresholding: treat \`intent_confidence < 0.6\` as "guess" and confirm with \`inspect\`.

---

## buying

**Definition.** The author is actively trying to purchase, sign up, or adopt a product or service right now.

**Canonical example.**
> "Looking for a CRM under $50/mo for a 3-person agency. Tried Pipedrive trial, didn't love it. What's everyone using? Ready to pull the trigger this week."

**Common false positives.**
- "I'm evaluating CRMs" — that's \`evaluating\`. Buying implies commitment; evaluating implies comparison without a decision window.
- "Does anyone know a good CRM?" — that's \`asking\`, unless there's an explicit purchase signal.

**Recommended agent response.** Surface one well-matched option with pricing, short-form social proof, and a low-friction call to action. Do not dump a list of ten.

---

## evaluating

**Definition.** The author is comparing options or kicking tires without an explicit purchase window.

**Canonical example.**
> "Started looking at Clay vs Apollo vs Clearbit for enrichment. Anyone run all three? Which one would you pick today?"

**Common false positives.**
- "Clay vs Apollo which is better" with a stated purchase intent — that's \`buying\`.
- "We just picked Clay" — that's \`recommending\` or \`announcing\`, not evaluating.

**Recommended agent response.** Offer a structured comparison (not marketing copy). Answer the specific comparison the author asked about.

---

## hiring

**Definition.** The author is looking to hire (full-time, contract, or freelance) or is advertising an open role.

**Canonical example.**
> "Hiring a senior Rails engineer, remote, $180–220k. DM if interested. We ship daily, no standups, async-first."

**Common false positives.**
- "I'm looking for work" — that's \`asking\` or \`announcing\`, not \`hiring\`. Hiring is about filling a role on the author's side.
- "Great team to work for" — that's \`recommending\`.

**Recommended agent response.** If the signal is a hiring call, extract role, comp, location, and application method. If the agent has a candidate match, draft a concise intro.

---

## complaining

**Definition.** The author is expressing frustration with a product, service, company, or category — including pricing, reliability, UX, or support.

**Canonical example.**
> "We were paying $149/mo for Clay and they just bumped us to $500 with no warning. Three emails to support, no reply. Rage-cancelling."

**Common false positives.**
- A question phrased with frustration ("Why is Postgres so slow?") — that's \`asking\` unless aimed at a specific product.
- Praise with mild criticism — that's \`recommending\` or \`evaluating\`, not \`complaining\`.

**Recommended agent response.** This is the richest prospecting intent. Route to \`dispatch\` with \`action: draft_reply\` for relevant alternatives, but stage — never auto-send. Sharp boundaries between empathy and pitch.

---

## recommending

**Definition.** The author is endorsing a product, service, or approach — unprompted advocacy.

**Canonical example.**
> "If you're doing B2B outbound and not using Instantly for deliverability, you're leaving money on the table. Went from 12% to 41% reply rates."

**Common false positives.**
- "Instantly works for me, I guess" — too weak, that's \`announcing\` or neutral.
- A hiring pitch disguised as advocacy — that's \`hiring\`.

**Recommended agent response.** Track the endorsement. Do not engage as a competitor in the thread unless explicitly invited.

---

## learning

**Definition.** The author is trying to understand something — asking how a concept works, seeking tutorials, or requesting an explainer.

**Canonical example.**
> "Can someone ELI5 how prompt caching actually works in Claude? Docs talk about cache breakpoints but I don't get when to set them."

**Common false positives.**
- "What CRM should I buy" — that's \`buying\` or \`asking\`, not learning. Learning is about concepts, not product selection.
- "How do you hire engineers" — that's \`asking\` if it's operational, \`learning\` if it's conceptual. Judgement call; the classifier picks the stronger signal.

**Recommended agent response.** Link to canonical docs or a short explanation. Do not pitch.

---

## building

**Definition.** The author is in the middle of building something and is talking about the process — including "I just built X," "working on Y," "launching Z soon."

**Canonical example.**
> "Spent the weekend building a Linear clone in Elixir. Kanban works, auth is next. Anyone else doing LiveView dashboards?"

**Common false positives.**
- "Clay vs Apollo" — that's \`comparing\`, not building.
- "We just shipped v2" — that's \`announcing\` if it's complete, \`building\` if it's in progress.

**Recommended agent response.** Engage as a peer if the agent has relevant craft knowledge. Offer tools or patterns, not sales.

---

## announcing

**Definition.** The author is sharing a launch, milestone, hire, funding round, or other discrete event — something that just happened.

**Canonical example.**
> "We just closed our Series A — $12M led by Benchmark. Hiring across eng, design, and GTM. What a ride."

**Common false positives.**
- "We're about to launch" — that's \`building\`, not announcing. Announcing is past-tense or present-tense of a completed event.
- Self-promoting a new product with a call-to-action — still \`announcing\`, not \`recommending\`.

**Recommended agent response.** Congratulate authentically if warranted; don't prospect into launch posts — bad form, poor conversion.

---

## asking

**Definition.** The author is seeking help with a specific operational or factual question — usually something answerable in a paragraph.

**Canonical example.**
> "How do you handle Stripe idempotency keys when a webhook retries after the original request already committed? Getting duplicate charges in edge cases."

**Common false positives.**
- Conceptual curiosity with no specific problem — that's \`learning\`.
- A question that's really a complaint in disguise — that's \`complaining\`.

**Recommended agent response.** If the agent can answer in ≤3 sentences with confidence, do. Otherwise, point to a resource or an expert.

---

## comparing

**Definition.** The author is side-by-side evaluating two or more specific options and asking which to pick.

**Canonical example.**
> "Temporal vs Inngest vs Trigger.dev — anyone run durable workflows in prod? TS shop, need good DX, scale is modest (10k runs/day)."

**Common false positives.**
- One-option kick-the-tires — that's \`evaluating\`.
- "Is X good?" with no alternatives mentioned — that's \`evaluating\` or \`asking\`.

**Recommended agent response.** Answer the specific comparison. Respect the author's constraints (stack, scale, budget). Do not expand the list.

---

## Notes on classification

- The classifier labels **single intent** per signal — the strongest match. Some posts legitimately carry two intents (e.g., \`complaining\` + \`evaluating\` — "fed up with Clay, what else is out there?"); the classifier picks the stronger signal and the \`match_reason\` field will usually explain the tie.
- Confidence below 0.6 is a flag to \`inspect\` before acting.
- The vocabulary is versioned with the spec. Future splits (e.g., \`complaining_price\` vs \`complaining_reliability\` — see §10 Q4) will be additive.
`;

export function registerLexiconResource(server: McpServer): void {
  server.registerResource(
    "lexicon",
    "signal://lexicon",
    {
      title: "Signal lexicon",
      description:
        "Intent vocabulary with definitions, canonical examples, false-positive guidance, and recommended agent responses. Read this once per session — the classifier labels are only useful when agent and classifier share the vocabulary.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "signal://lexicon",
          mimeType: "text/markdown",
          text: LEXICON_MARKDOWN,
        },
      ],
    }),
  );
}
