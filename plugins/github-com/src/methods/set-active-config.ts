import type { SetActiveConfigResult } from "@roubo/plugin-sdk";
import { resetAlertsRuntime } from "../alerts-runtime.js";
import { resetOctokit } from "../octokit-factory.js";

/**
 * github-com has no plugin-wide active config: source selection is supplied
 * per-call via each source-bound method's `sources` param, so there is no
 * instance URL or TLS flag to persist (unlike the GHE plugin). This method
 * therefore stores nothing and exists purely as the canonical cache-invalidation
 * signal.
 *
 * The host invokes it on config activation and, critically, after an OAuth
 * connect or disconnect (server/routes/plugins-github-oauth.ts). We clear the
 * Octokit factory and alerts-runtime token caches so the next source-bound RPC
 * (listSourceCandidates, listIssues, getCurrentUser, ...) re-reads the freshly
 * saved (or cleared) credential from the host instead of a token cached in this
 * process before the token rotated. Without this, a reconnect would keep using
 * the pre-disconnect client until a `validateConfig` happened to run.
 */
export function setActiveConfigMethod(_params: {
  config: Record<string, unknown>;
}): SetActiveConfigResult {
  void _params;
  resetAlertsRuntime();
  resetOctokit();
  return { ok: true };
}
