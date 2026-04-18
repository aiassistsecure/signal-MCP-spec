import type { IntelSignal } from "./api-client.js";

/**
 * MCP-side cache — the single persistence concession per REALITY.md §1.4 / §2.
 *
 * Two backings:
 *   - In-memory Map with TTL eviction (default; zero infra).
 *   - Redis, when REDIS_URL env var is set at construction (process-shared,
 *     survives restarts). We keep the Redis client optional so `npm install`
 *     stays dependency-light; it's loaded via dynamic import only when needed.
 *
 * Key schema (matches REALITY.md):
 *   mcp:signal:<sig_*>                           — listen-writes, inspect-reads (TTL 24h)
 *   mcp:intent:<sig_*>                           — intent classifier result    (TTL 24h)
 *   mcp:author:<source>:<handle>                 — derived author context       (TTL 6h)
 *   mcp:dispatch:<handle>                        — staged/committed dispatch    (TTL 7d)
 *   mcp:archived:<org_id>                        — SET of archived sig_*        (TTL 30d)
 *   mcp:flagged:<org_id>:<sig_*>                 — flag note                    (TTL 30d)
 */

export interface CachedSignal {
  source: string;
  native_id: string;
  query_keywords: string[];
  scanned_at: string; // ISO
  raw_result: IntelSignal;
}

export interface CachedIntent {
  intent: string;
  intent_confidence: number;
  match_reason: string;
  classifier_version: string;
  classified_at: string;
}

export interface CachedAuthor {
  recent_posts_bucket: string;
  domains_posted_in: string[];
  sentiment_7d: string;
  likely_role_hint: string;
  derived_at: string;
}

export interface StagedDispatch {
  signal_id: string;
  action: string;
  params: Record<string, unknown>;
  status: "staged" | "committed" | "cancelled" | "failed";
  created_at: string;
  committed_at?: string;
  preview?: string;
  side_effect_handle?: string;
}

const TTL = {
  signal: 24 * 60 * 60 * 1000,
  intent: 24 * 60 * 60 * 1000,
  author: 6 * 60 * 60 * 1000,
  dispatch: 7 * 24 * 60 * 60 * 1000,
  archived: 30 * 24 * 60 * 60 * 1000,
  flagged: 30 * 24 * 60 * 60 * 1000,
} as const;

export interface CacheBackend {
  getJSON<T>(key: string): Promise<T | null>;
  setJSON<T>(key: string, value: T, ttlMs: number): Promise<void>;
  sAdd(key: string, member: string, ttlMs: number): Promise<void>;
  sRem(key: string, member: string): Promise<void>;
  sHas(key: string, member: string): Promise<boolean>;
  sMembers(key: string): Promise<string[]>;
}

/** In-memory backend with per-key expiration. Plenty fast; not process-shared. */
export class InMemoryBackend implements CacheBackend {
  private readonly kv = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly sets = new Map<string, { members: Set<string>; expiresAt: number }>();

  async getJSON<T>(key: string): Promise<T | null> {
    const entry = this.kv.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.kv.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async setJSON<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.kv.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async sAdd(key: string, member: string, ttlMs: number): Promise<void> {
    const existing = this.sets.get(key);
    if (existing && Date.now() <= existing.expiresAt) {
      existing.members.add(member);
      existing.expiresAt = Date.now() + ttlMs;
      return;
    }
    this.sets.set(key, { members: new Set([member]), expiresAt: Date.now() + ttlMs });
  }

  async sRem(key: string, member: string): Promise<void> {
    const existing = this.sets.get(key);
    if (!existing) return;
    existing.members.delete(member);
  }

  async sHas(key: string, member: string): Promise<boolean> {
    const existing = this.sets.get(key);
    if (!existing) return false;
    if (Date.now() > existing.expiresAt) {
      this.sets.delete(key);
      return false;
    }
    return existing.members.has(member);
  }

  async sMembers(key: string): Promise<string[]> {
    const existing = this.sets.get(key);
    if (!existing) return [];
    if (Date.now() > existing.expiresAt) {
      this.sets.delete(key);
      return [];
    }
    return [...existing.members];
  }
}

/** High-level typed cache. Stays decoupled from the backend. */
export class Cache {
  constructor(private readonly backend: CacheBackend = new InMemoryBackend()) {}

  // ── Signals ─────────────────────────────────────────────────────────────
  signalKey(sig: string): string {
    return `mcp:signal:${sig}`;
  }
  getSignal(sig: string): Promise<CachedSignal | null> {
    return this.backend.getJSON<CachedSignal>(this.signalKey(sig));
  }
  putSignal(sig: string, value: CachedSignal): Promise<void> {
    return this.backend.setJSON(this.signalKey(sig), value, TTL.signal);
  }

  // ── Intent ──────────────────────────────────────────────────────────────
  intentKey(sig: string): string {
    return `mcp:intent:${sig}`;
  }
  getIntent(sig: string): Promise<CachedIntent | null> {
    return this.backend.getJSON<CachedIntent>(this.intentKey(sig));
  }
  putIntent(sig: string, value: CachedIntent): Promise<void> {
    return this.backend.setJSON(this.intentKey(sig), value, TTL.intent);
  }

  // ── Author ──────────────────────────────────────────────────────────────
  authorKey(source: string, handle: string): string {
    return `mcp:author:${source}:${handle}`;
  }
  getAuthor(source: string, handle: string): Promise<CachedAuthor | null> {
    return this.backend.getJSON<CachedAuthor>(this.authorKey(source, handle));
  }
  putAuthor(source: string, handle: string, value: CachedAuthor): Promise<void> {
    return this.backend.setJSON(this.authorKey(source, handle), value, TTL.author);
  }

  // ── Dispatch ────────────────────────────────────────────────────────────
  dispatchKey(handle: string): string {
    return `mcp:dispatch:${handle}`;
  }
  getDispatch(handle: string): Promise<StagedDispatch | null> {
    return this.backend.getJSON<StagedDispatch>(this.dispatchKey(handle));
  }
  putDispatch(handle: string, value: StagedDispatch): Promise<void> {
    return this.backend.setJSON(this.dispatchKey(handle), value, TTL.dispatch);
  }

  // ── Archive ─────────────────────────────────────────────────────────────
  archivedKey(orgId: string): string {
    return `mcp:archived:${orgId}`;
  }
  archiveSignal(orgId: string, sig: string): Promise<void> {
    return this.backend.sAdd(this.archivedKey(orgId), sig, TTL.archived);
  }
  isArchived(orgId: string, sig: string): Promise<boolean> {
    return this.backend.sHas(this.archivedKey(orgId), sig);
  }

  // ── Flag ────────────────────────────────────────────────────────────────
  flagKey(orgId: string, sig: string): string {
    return `mcp:flagged:${orgId}:${sig}`;
  }
  async flagSignal(orgId: string, sig: string, note?: string): Promise<void> {
    await this.backend.setJSON(
      this.flagKey(orgId, sig),
      { flagged: true, note: note ?? null, flagged_at: new Date().toISOString() },
      TTL.flagged,
    );
  }
  async getFlag(
    orgId: string,
    sig: string,
  ): Promise<{ flagged: boolean; note: string | null; flagged_at: string } | null> {
    return this.backend.getJSON(this.flagKey(orgId, sig));
  }
}
