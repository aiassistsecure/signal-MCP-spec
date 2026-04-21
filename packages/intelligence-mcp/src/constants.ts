export const SERVER_NAME = "signal";
export const SERVER_VERSION = "0.1.0";
export const PROTOCOL_VERSION = "2025-11";

export const INTENTS = [
  "buying",
  "evaluating",
  "hiring",
  "complaining",
  "recommending",
  "learning",
  "building",
  "announcing",
  "asking",
  "comparing",
] as const;

export type Intent = (typeof INTENTS)[number];

export const FRESHNESS = [
  "last_hour",
  "today",
  "this_week",
  "this_month",
  "any",
] as const;

export type Freshness = (typeof FRESHNESS)[number];

export const DISPATCH_ACTIONS = [
  "archive",
  "flag",
  "route",
  "draft_reply",
  "schedule_followup",
] as const;

export type DispatchAction = (typeof DISPATCH_ACTIONS)[number];

export const INSPECT_DEPTHS = ["surface", "thread", "author"] as const;
export type InspectDepth = (typeof INSPECT_DEPTHS)[number];

export const DEFAULT_API_BASE_URL = "https://api.aiassist.net";
