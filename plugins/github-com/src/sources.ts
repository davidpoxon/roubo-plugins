import type { ConfiguredSource } from "@roubo/plugin-sdk";

// Optional per-source alert-category opt-ins (FR-074). Absent ⇒ false at the
// host layer. As of WU-030 the plugin SDK's `ConfiguredSource` carries these
// fields as optional booleans, so they ride into source-bound RPCs verbatim.
export interface GithubSourceAlertFlags {
  includeCodeQLAlerts?: boolean;
  includeSecretScanningAlerts?: boolean;
  includeDependabotAlerts?: boolean;
}

export type GithubSource =
  | ({ kind: "repo"; externalId: string } & GithubSourceAlertFlags)
  | ({ kind: "project"; externalId: string } & GithubSourceAlertFlags);

function isGithubSource(s: ConfiguredSource): s is GithubSource {
  return (s.kind === "repo" || s.kind === "project") && typeof s.externalId === "string";
}

/**
 * Return the first source from the host-supplied list, narrowed to the kinds
 * this plugin understands. Throws if the list is empty or shaped wrong; the
 * host is expected to only invoke source-bound methods when sources are
 * configured.
 */
export function requirePrimarySource(sources: ConfiguredSource[] | undefined): GithubSource {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error(
      "[github-com] sources is required for source-bound methods (listIssues, listIssueTypes, listLabels).",
    );
  }
  const first = sources[0];
  if (!isGithubSource(first)) {
    throw new Error(
      `[github-com] unsupported source kind "${first?.kind}"; expected "repo" or "project".`,
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
export function parseAllSources(sources: ConfiguredSource[] | undefined): GithubSource[] {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error(
      "[github-com] sources is required for source-bound methods (listIssues, listIssueTypes, listLabels).",
    );
  }
  return sources.map((s) => {
    if (!isGithubSource(s)) {
      throw new Error(
        `[github-com] unsupported source kind "${s?.kind}"; expected "repo" or "project".`,
      );
    }
    return s;
  });
}
