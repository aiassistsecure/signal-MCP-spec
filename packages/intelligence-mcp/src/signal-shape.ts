import type { ApiClient, ChatCompletionResponse } from "./api-client.js";
import { INTENTS, type Intent } from "./constants.js";

/**
 * Shared signal-shaping helpers used by `listen` and `inspect`.
 * All derivation logic per REALITY.md §1.1.
 */

export function deriveKarmaBucket(
  score: number,
): "new" | "low" | "medium" | "high" | "established" {
  if (score < 5) return "new";
  if (score < 50) return "low";
  if (score < 250) return "medium";
  if (score < 1000) return "high";
  return "established";
}

export function deriveFreshnessBucket(
  createdUtcSec: number,
): "last_hour" | "today" | "this_week" | "this_month" | "older" {
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - createdUtcSec);
  if (ageSec < 60 * 60) return "last_hour";
  if (ageSec < 24 * 60 * 60) return "today";
  if (ageSec < 7 * 24 * 60 * 60) return "this_week";
  if (ageSec < 30 * 24 * 60 * 60) return "this_month";
  return "older";
}

export function toIso(createdUtcSec: number): string {
  return new Date(createdUtcSec * 1000).toISOString();
}

export function makeExcerpt(body: string, maxChars = 280): string {
  const text = body.trim().replace(/\s+/g, " ");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

// ─── Intent classification ────────────────────────────────────────────────

export interface ClassificationInput {
  query: string;
  keywords: string[];
  source: string;
  title: string;
  body: string;
  url: string;
  author: string;
  score: number;
  num_comments: number;
}

export interface ClassificationResult {
  intent: Intent;
  intent_confidence: number;
  match_reason: string;
}

const INTENT_ENUM = INTENTS.join(" | ");

const CLASSIFIER_SYSTEM_PROMPT = `You classify public-forum posts into a fixed intent vocabulary.

Valid intents: ${INTENT_ENUM}

Rules:
- Pick the single strongest intent label. Not a list.
- "intent_confidence" is a float between 0 and 1. Use 0.9+ only when the post is explicit and unambiguous. Use <0.6 when you're guessing.
- "match_reason" is ONE short English sentence (<= 25 words) explaining WHY this post matches the user's query and why you chose this intent. Reference the specific words in the post where possible. No marketing language.
- Output MUST be a single JSON object: { "intent": "...", "intent_confidence": 0.0, "match_reason": "..." }
- Do not wrap in code fences. Do not add commentary.`;

const MAX_BODY_CHARS = 1500;

export async function classifyIntent(
  client: ApiClient,
  input: ClassificationInput,
): Promise<ClassificationResult> {
  const bodyTrimmed = input.body.length > MAX_BODY_CHARS
    ? `${input.body.slice(0, MAX_BODY_CHARS)}… [truncated]`
    : input.body;

  const userMessage = [
    `User query: ${input.query}`,
    `Expanded keywords: ${input.keywords.join(", ")}`,
    "",
    `Source: ${input.source}`,
    `Author: ${input.author}  Score: ${input.score}  Comments: ${input.num_comments}`,
    `URL: ${input.url}`,
    "",
    `Title: ${input.title}`,
    "",
    `Body:`,
    bodyTrimmed || "(no body)",
  ].join("\n");

  let res: ChatCompletionResponse;
  try {
    res = await client.chatCompletion({
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      temperature: 0.1,
      max_tokens: 200,
      response_format: { type: "json_object" },
    });
  } catch {
    return {
      intent: "asking",
      intent_confidence: 0.3,
      match_reason: "Classifier call failed — defaulted to low-confidence asking.",
    };
  }

  const content = res.choices[0]?.message?.content ?? "";
  return parseClassifierOutput(content);
}

export function parseClassifierOutput(raw: string): ClassificationResult {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return fallback("Classifier returned non-JSON output.");
  }
  if (!parsed || typeof parsed !== "object") {
    return fallback("Classifier returned non-object.");
  }

  const o = parsed as Record<string, unknown>;
  const intentRaw = typeof o["intent"] === "string" ? o["intent"].toLowerCase() : "";
  const intent = (INTENTS as readonly string[]).includes(intentRaw) ? (intentRaw as Intent) : null;
  const confRaw = o["intent_confidence"];
  const conf = typeof confRaw === "number" ? clamp01(confRaw) : 0.5;
  const reason =
    typeof o["match_reason"] === "string" && (o["match_reason"] as string).trim().length > 0
      ? (o["match_reason"] as string).trim()
      : "No reason provided by classifier.";

  if (!intent) {
    return {
      intent: "asking",
      intent_confidence: Math.min(conf, 0.4),
      match_reason: `Classifier emitted an unrecognized intent '${String(intentRaw)}'. Defaulted to 'asking'.`,
    };
  }
  return { intent, intent_confidence: conf, match_reason: reason };
}

function fallback(note: string): ClassificationResult {
  return { intent: "asking", intent_confidence: 0.3, match_reason: note };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}
