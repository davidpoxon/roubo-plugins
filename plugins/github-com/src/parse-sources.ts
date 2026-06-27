import type { GithubSource, GithubSourceAlertFlags } from "./sources.js";

const ALERT_FLAG_KEYS = [
  "includeCodeQLAlerts",
  "includeSecretScanningAlerts",
  "includeDependabotAlerts",
] as const satisfies ReadonlyArray<keyof GithubSourceAlertFlags>;

type ShapeError = { field?: string; message: string };

function parseAlertFlags(
  entry: Record<string, unknown>,
  idx: number,
  errors: ShapeError[],
): GithubSourceAlertFlags | null {
  const flags: GithubSourceAlertFlags = {};
  let ok = true;
  for (const key of ALERT_FLAG_KEYS) {
    const value = entry[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      errors.push({
        field: `sources[${idx}].${key}`,
        message: `must be a boolean`,
      });
      ok = false;
      continue;
    }
    flags[key] = value;
  }
  return ok ? flags : null;
}

/**
 * Shape-check a host-supplied config payload during validateConfig. The host
 * now passes `sources` per-call to source-bound methods, so the plugin only
 * needs to parse the sources array when validateConfig probes each source
 * for existence. Returns the parsed sources plus field-scoped shape errors.
 *
 * Per-source alert-category booleans (FR-074) are accepted, validated as
 * booleans, and surfaced on the parsed source. They are not yet consumed by
 * source-bound RPCs (the plugin SDK boundary is unchanged for WU-037).
 */
export function parseSourcesConfig(raw: Record<string, unknown>): {
  config: { sources: GithubSource[] } | null;
  errors: ShapeError[];
} {
  const errors: ShapeError[] = [];
  const rawSources = (raw as { sources?: unknown }).sources;

  // Token-only validation (e.g. the global "Test connection" flow before any
  // sources have been picked) sends a config without a `sources` key. Accept
  // that as an empty selection so the credential probe can still run.
  if (rawSources === undefined) {
    return { config: { sources: [] }, errors };
  }
  if (!Array.isArray(rawSources)) {
    errors.push({ field: "sources", message: "sources must be an array" });
    return { config: null, errors };
  }

  const sources: GithubSource[] = [];
  rawSources.forEach((entry, idx) => {
    if (!entry || typeof entry !== "object") {
      errors.push({ field: `sources[${idx}]`, message: "must be an object" });
      return;
    }
    const e = entry as Record<string, unknown>;
    if (e.kind !== "repo" && e.kind !== "project") {
      errors.push({ field: `sources[${idx}].kind`, message: 'must be "repo" or "project"' });
      return;
    }
    if (typeof e.externalId !== "string" || e.externalId.length === 0) {
      errors.push({
        field: `sources[${idx}].externalId`,
        message: "must be a non-empty string",
      });
      return;
    }
    const flags = parseAlertFlags(e, idx, errors);
    if (flags === null) return;
    sources.push({ kind: e.kind, externalId: e.externalId, ...flags });
  });

  if (errors.length > 0) return { config: null, errors };
  return { config: { sources }, errors: [] };
}
