import type { SetActiveConfigResult } from "@roubo/plugin-sdk";
import { parseConfig, setActiveConfig } from "../active-config.js";
import { resetAlertsRuntime } from "../alerts-runtime.js";
import { resetOctokit } from "../octokit-factory.js";

/**
 * Receive the plugin-wide config (instance URL, allowSelfSignedTls) from the
 * host. This conveys plugin-process-global state only; it is identical
 * across every project using the GHE plugin, so there is no cross-project
 * bleed risk.
 *
 * Source selection is supplied per-call via each source-bound method's
 * `sources` param and is never stored in the active config.
 *
 * After persisting the new config we clear the alerts-runtime token cache
 * and the Octokit factory cache (WU-032 AC #7): the host pushes a fresh
 * active config whenever the user saves the Configure dialog (including
 * PAT regeneration), so this is the canonical trigger for invalidating
 * any cached token / scope probe.
 */
export function setActiveConfigMethod(params: {
  config: Record<string, unknown>;
}): SetActiveConfigResult {
  const { config, errors } = parseConfig(params.config);
  if (!config) {
    return { ok: false, errors };
  }
  setActiveConfig(config);
  resetAlertsRuntime();
  resetOctokit();
  return { ok: true };
}
