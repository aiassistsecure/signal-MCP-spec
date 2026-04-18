/**
 * `sig_*` ID format — MCP-owned, stateless, deterministic.
 * Spec §4.1 shape; encoding per REALITY.md §1.0.
 *
 *   sig_<base64url(source ":" native_id)>
 *
 * The same (source, native_id) pair always yields the same `sig_*`. No DB.
 */

const PREFIX = "sig_";

export function mintSignalId(source: string, nativeId: string | number): string {
  if (!source) throw new Error("mintSignalId: source is required");
  const id = String(nativeId);
  if (!id) throw new Error("mintSignalId: nativeId is required");
  const raw = `${source}:${id}`;
  const b64 = Buffer.from(raw, "utf8").toString("base64url");
  return `${PREFIX}${b64}`;
}

export interface DecodedSignalId {
  source: string;
  nativeId: string;
}

export function decodeSignalId(id: string): DecodedSignalId {
  if (!id.startsWith(PREFIX)) {
    throw new Error(`Invalid signal_id (missing 'sig_' prefix): ${id}`);
  }
  const raw = Buffer.from(id.slice(PREFIX.length), "base64url").toString("utf8");
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) {
    throw new Error(`Malformed signal_id payload: ${id}`);
  }
  return { source: raw.slice(0, idx), nativeId: raw.slice(idx + 1) };
}

/** `true` if the string parses as a well-formed signal_id. */
export function isSignalId(id: string): boolean {
  try {
    decodeSignalId(id);
    return true;
  } catch {
    return false;
  }
}
