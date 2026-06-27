import type { ProbeRepoAccessResult } from "@roubo/plugin-sdk";
import { fetchRepoSummary } from "../github-fetchers.js";

/**
 * Directly probes `GET /repos/{owner}/{repo}` on the configured GHE instance
 * for a single repo so the host can tell *why* a configured repo is missing
 * from `listSourceCandidates`. The user repo listing silently omits repos
 * blocked by an org's access restrictions (HTTP 200, repo simply absent), so
 * membership in that list can't distinguish "no such repo" from "org has not
 * approved access". A direct fetch surfaces the real 403/404, which
 * `classifyGitHubError` on the host turns into an actionable error code.
 *
 * Returns a structured result rather than throwing so the failing status and
 * message survive the RPC boundary intact (a thrown error would be flattened to
 * a generic transport error by the plugin host).
 */
export async function probeRepoAccess(params: {
  repoFullName: string;
}): Promise<ProbeRepoAccessResult> {
  try {
    await fetchRepoSummary(params.repoFullName);
    return { accessible: true };
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    return {
      accessible: false,
      ...(typeof status === "number" ? { status } : {}),
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
