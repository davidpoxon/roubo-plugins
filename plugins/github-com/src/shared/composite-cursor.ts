/**
 * Composite pagination cursor for multi-source `listIssues`.
 *
 * A submodule project surfaces several GitHub sources at once (the root repo
 * plus every resolvable submodule, and any GitHub Projects). The host paginates
 * the cut list with a single opaque cursor, so the plugin stitches each source's
 * own per-source cursor into one string here. Each per-source cursor stays
 * opaque to this codec (repo cursors are page numbers, project cursors are
 * offset-based); we only carry and replay them, keyed by `source.externalId`.
 *
 * The wire form is base64-encoded JSON: `{ "<externalId>": "<perSourceCursor>" }`.
 * Only sources that still have a next page appear in the map; a source absent
 * from the map is exhausted and skipped on the next request.
 */

export type CompositeCursor = Record<string, string>;

/** Encode the per-source next-cursor map into a single opaque cursor string. */
export function encodeCompositeCursor(map: CompositeCursor): string {
  return Buffer.from(JSON.stringify(map), "utf-8").toString("base64");
}

/**
 * Decode an opaque composite cursor back into the per-source map. Any malformed
 * or legacy (e.g. bare-numeric) input decodes to `{}` so a stale cursor degrades
 * to "no active sources" (an empty tail page the client treats as end-of-list)
 * rather than throwing.
 */
export function decodeCompositeCursor(cursor: string): CompositeCursor {
  let json: string;
  try {
    json = Buffer.from(cursor, "base64").toString("utf-8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const out: CompositeCursor = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
