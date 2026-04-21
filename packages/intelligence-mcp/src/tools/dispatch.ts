import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DISPATCH_ACTIONS, type DispatchAction } from "../constants.js";
import type { ApiClient } from "../api-client.js";
import type { Cache, StagedDispatch } from "../cache.js";
import { missingApiKey, structuredError } from "../errors.js";
import { decodeSignalId } from "../signal-id.js";

/**
 * `dispatch` — take an action on a signal. Two-phase commit per spec §4.3.
 *
 * Backing per REALITY.md §2:
 *   archive        — MCP Redis set (org-scoped). Filters future listens.
 *   flag           — MCP Redis note (org+signal). Decorates future listens.
 *   route          — POST /api/contacts (default) or /api/leads/capture
 *   draft_reply    — POST /v1/chat/completions (artifact is the draft)
 *   schedule_followup — returns -32004 until backend scheduler ships (BACKEND-GAPS §3.5)
 *
 * All actions stage first; commit requires params.commit === true.
 */

export const dispatchInputSchema = {
  signal_id: z
    .string()
    .regex(/^sig_/, "signal_id must start with 'sig_'")
    .describe("The sig_... ID to act on."),
  action: z
    .enum(DISPATCH_ACTIONS)
    .describe(
      "What to do with this signal. archive = drop from future listens. flag = mark + optional note, still appears in listens with flagged:true. route = land in CRM (POST /api/contacts). draft_reply = produce a draft via BYOK chat/completions. schedule_followup = NOT AVAILABLE in v1.0 (see data.suggested_action).",
    ),
  params: z
    .object({
      commit: z
        .boolean()
        .optional()
        .describe(
          "Two-phase commit. Default false — call stages only. Re-call with commit=true and the returned handle to fire side effects.",
        ),
      note: z.string().optional().describe("For `flag`: a human-readable note stored alongside."),
      destination: z
        .enum(["contacts", "leads"])
        .optional()
        .describe("For `route`: which backend target. Default 'contacts'."),
      workspace_id: z.string().optional().describe("For `route`: target workspace id."),
      tone: z
        .enum(["warm", "direct", "matter_of_fact"])
        .optional()
        .describe("For `draft_reply`: reply tone. Default 'warm'."),
      max_chars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("For `draft_reply`: approx char budget. Default 600."),
    })
    .passthrough()
    .optional()
    .describe("Action-specific params. See each action's docs."),
} as const;

export const DISPATCH_DESCRIPTION = [
  "Take an action on a signal. By default STAGED — call again with params.commit=true to fire side effects.",
  "archive and flag are MCP-local; route lands the signal as a contact in the user's CRM via /api/contacts; draft_reply produces a reply draft via BYOK chat/completions.",
  "schedule_followup is not yet backed (returns -32004) — use flag with a note, or route, as fallbacks.",
  "Every call returns a handle (disp_*) — pass it back on the commit call.",
].join(" ");

export interface DispatchDeps {
  getClient: () => ApiClient | null;
  cache: Cache;
  getOrgId: () => string;
}

interface DispatchArgs {
  signal_id: string;
  action: DispatchAction;
  params?: {
    commit?: boolean;
    note?: string;
    destination?: "contacts" | "leads";
    workspace_id?: string;
    tone?: "warm" | "direct" | "matter_of_fact";
    max_chars?: number;
  } & Record<string, unknown>;
}

export function registerDispatch(server: McpServer, deps: DispatchDeps): void {
  server.registerTool(
    "dispatch",
    {
      title: "dispatch",
      description: DISPATCH_DESCRIPTION,
      inputSchema: dispatchInputSchema,
    },
    async (rawArgs: unknown) => {
      const args = rawArgs as DispatchArgs;
      const client = deps.getClient();
      if (!client) throw missingApiKey();

      // Validate signal_id early.
      try {
        decodeSignalId(args.signal_id);
      } catch (err) {
        throw structuredError({
          code: -32602,
          message: `Invalid signal_id: ${args.signal_id}`,
          reason: err instanceof Error ? err.message : String(err),
          suggested_action: "Use an ID emitted by a previous `listen` call.",
        });
      }

      const commit = args.params?.commit === true;
      const orgId = deps.getOrgId();
      const params = args.params ?? {};

      if (args.action === "schedule_followup") {
        throw structuredError({
          code: -32004,
          message: "schedule_followup is not available in v1.0",
          reason: "no scheduler backing on api.aiassist.net (tracked in BACKEND-GAPS.md §3.5)",
          suggested_action:
            "Use action='flag' with params.note to mark for manual follow-up, or action='route' to land it in CRM where the user's workflow can pick it up.",
        });
      }

      const handle = `disp_${randomUUID()}`;
      const staged: StagedDispatch = {
        signal_id: args.signal_id,
        action: args.action,
        params,
        status: "staged",
        created_at: new Date().toISOString(),
      };

      // Stage-time side effects (produce artifacts that are themselves the result,
      // not external mutations). draft_reply lives here.
      if (args.action === "draft_reply") {
        const preview = await draftReplyArtifact(client, deps.cache, args.signal_id, params);
        staged.preview = preview;
      }

      await deps.cache.putDispatch(handle, staged);

      if (!commit) {
        return textResult({
          action: args.action,
          status: "staged",
          handle,
          ...(staged.preview ? { preview: staged.preview } : {}),
          suggestion: stagePreviewSuggestion(args.action),
        });
      }

      // Commit phase — fire real side effects.
      try {
        switch (args.action) {
          case "archive":
            await deps.cache.archiveSignal(orgId, args.signal_id);
            break;
          case "flag":
            await deps.cache.flagSignal(orgId, args.signal_id, params.note);
            break;
          case "route": {
            const sideHandle = await commitRoute(client, deps.cache, args.signal_id, params);
            staged.side_effect_handle = sideHandle;
            break;
          }
          case "draft_reply":
            // Artifact is the preview. Commit just records human acceptance.
            break;
        }
      } catch (err) {
        staged.status = "failed";
        await deps.cache.putDispatch(handle, staged);
        throw err instanceof Error
          ? structuredError({
              code: -32012,
              message: `dispatch commit failed: ${err.message}`,
              handle,
              suggested_action:
                "Retry the commit call, or re-stage the dispatch to regenerate the handle.",
            })
          : err;
      }

      staged.status = "committed";
      staged.committed_at = new Date().toISOString();
      await deps.cache.putDispatch(handle, staged);

      return textResult({
        action: args.action,
        status: "committed",
        handle,
        ...(staged.preview ? { preview: staged.preview } : {}),
        ...(staged.side_effect_handle ? { side_effect_handle: staged.side_effect_handle } : {}),
      });
    },
  );
}

function textResult(obj: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function stagePreviewSuggestion(action: DispatchAction): string {
  switch (action) {
    case "archive":
      return "Re-call dispatch with the same signal_id, action='archive', params.commit=true to exclude this signal from future listens.";
    case "flag":
      return "Re-call dispatch with the same signal_id, action='flag', params.commit=true (and an optional params.note) to tag this signal.";
    case "route":
      return "Review the preview; re-call with params.commit=true to POST /api/contacts (default) or /api/leads/capture.";
    case "draft_reply":
      return "Draft above is ready. Re-call with params.commit=true to mark it accepted. Posting the reply to the source platform is out of scope.";
    case "schedule_followup":
      return "(unreachable — schedule_followup returns -32004)";
  }
}

// ─── Action implementations ───────────────────────────────────────────────

async function draftReplyArtifact(
  client: ApiClient,
  cache: Cache,
  signalId: string,
  params: DispatchArgs["params"] & object,
): Promise<string> {
  const cached = await cache.getSignal(signalId);
  if (!cached) {
    throw structuredError({
      code: -32005,
      message: "signal expired before dispatch — cache miss",
      signal_id: signalId,
      suggested_action:
        "Re-run `listen` with the same query to repopulate the cache, then retry dispatch.",
    });
  }
  const raw = cached.raw_result;
  const tone = params.tone ?? "warm";
  const maxChars = params.max_chars ?? 600;

  const systemPrompt = buildDraftSystemPrompt(tone, maxChars);
  const userPrompt = [
    `Source: ${raw.source}`,
    `URL: ${raw.url}`,
    `Author: ${raw.author}`,
    `Headline: ${raw.title}`,
    `Body: ${(raw.body ?? raw.content ?? "").slice(0, 1500)}`,
  ].join("\n");

  const res = await client.chatCompletion({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.6,
    max_tokens: 400,
  });

  return res.choices[0]?.message?.content?.trim() ?? "";
}

function buildDraftSystemPrompt(tone: string, maxChars: number): string {
  const toneGuide: Record<string, string> = {
    warm: "Warm, empathetic, first-person. Acknowledge the author's point before offering anything.",
    direct: "Direct, no preamble. Get to the helpful thing in the first sentence.",
    matter_of_fact: "Neutral, factual, professional. No emotional language.",
  };
  return [
    "You draft a reply to a public forum post.",
    "",
    `Tone: ${toneGuide[tone] ?? toneGuide["warm"]}`,
    `Target length: under ${maxChars} characters.`,
    "",
    "Rules:",
    "- Do not identify as an AI.",
    "- Do not pitch a product in the first message unless the author explicitly asked for recommendations.",
    "- One concrete suggestion max. No lists.",
    "- Match the author's register — forum-casual, not LinkedIn-polished.",
    "- Output only the reply text. No preamble, no signature, no formatting commentary.",
  ].join("\n");
}

async function commitRoute(
  client: ApiClient,
  cache: Cache,
  signalId: string,
  params: DispatchArgs["params"] & object,
): Promise<string> {
  const cached = await cache.getSignal(signalId);
  if (!cached) {
    throw structuredError({
      code: -32005,
      message: "signal expired before dispatch commit",
      signal_id: signalId,
      suggested_action: "Re-run `listen` to repopulate the cache, then retry the dispatch.",
    });
  }
  const raw = cached.raw_result;
  const destination = params.destination ?? "contacts";
  const notes = [raw.title, "", (raw.body ?? raw.content ?? "").slice(0, 800), "", raw.url]
    .filter(Boolean)
    .join("\n");

  if (destination === "contacts") {
    const contact = await client.createContact({
      name: raw.author,
      source: `signal:${raw.source}:${raw.id}`,
      notes,
      lifecycle_stage: "new",
      ...(params.workspace_id ? { workspace_id: params.workspace_id } : {}),
    });
    return `contact_${contact.id}`;
  }

  if (destination === "leads") {
    throw structuredError({
      code: -32006,
      message: "route destination 'leads' requires an email on the signal; current sources do not surface one",
      supported_in_v1: ["contacts"],
      suggested_action: "Use destination='contacts' to land the author as a contact instead.",
    });
  }

  throw structuredError({
    code: -32006,
    message: `unsupported route destination '${String(destination)}'`,
    supported: ["contacts"],
    suggested_action: "Use destination='contacts' (default).",
  });
}
