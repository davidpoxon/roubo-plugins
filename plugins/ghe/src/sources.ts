import type { ConfiguredSource } from "@roubo/plugin-sdk";

// Optional per-source alert-category opt-ins (FR-074). Absent ⇒ false at the
// host layer. `ConfiguredSource` carries these fields across the plugin SDK
// boundary, and `listIssues` consumes them via alerts-runtime to dispatch the
// matching GHAS endpoints.
export interface GheSourceAlertFlags {
  includeCodeQLAlerts?: boolean;
  includeSecretScanningAlerts?: boolean;
  includeDependabotAlerts?: boolean;
}

export type GheSource =
  | ({ kind: "repo"; externalId: string } & GheSourceAlertFlags)
  | ({ kind: "project"; externalId: string } & GheSourceAlertFlags);

function isGheSource(s: ConfiguredSource): s is GheSource {
  return (s.kind === "repo" || s.kind === "project") && typeof s.externalId === "string";
}

/**
 * Return the first source from the host-supplied list, narrowed to the kinds
 * this plugin understands. Throws if the list is empty or shaped wrong; the
 * host is expected to only invoke source-bound methods when sources are
 * configured.
 */
export function requirePrimarySource(sources: ConfiguredSource[] | undefined): GheSource {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error(
      "[ghe] sources is required for source-bound methods (listIssues, listIssueTypes, listLabels).",
    );
  }
  const first = sources[0];
  if (!isGheSource(first)) {
    throw new Error(
      `[ghe] unsupported source kind "${first?.kind}"; expected "repo" or "project".`,
    );
  }
  return first;
}

/**
 * Narrow the entire host-supplied source list to the kinds this plugin
 * understands. Used by `listIssues`, which aggregates the cut list across every
 * configured source (a submodule project surfaces the root repo plus each
 * submodule), not just the primary one. Throws on an empty/missing list or any
 * unsupported source kind so a misconfigured source surfaces loudly rather than
 * silently dropping out of the cut list.
 */
export function parseAllSources(sources: ConfiguredSource[] | undefined): GheSource[] {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error(
      "[ghe] sources is required for source-bound methods (listIssues, listIssueTypes, listLabels).",
    );
  }
  return sources.map((s) => {
    if (!isGheSource(s)) {
      throw new Error(`[ghe] unsupported source kind "${s?.kind}"; expected "repo" or "project".`);
    }
    return s;
  });
}
