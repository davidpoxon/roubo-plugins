import type { ValidateConfigResult } from "@roubo/plugin-sdk";
import { parseConfig, setActiveConfig, tryGetActiveConfig } from "../active-config.js";
import { parseSourcesConfig } from "../parse-sources.js";
import { fetchCurrentUser, fetchProjects, fetchRepoSummary } from "../github-fetchers.js";
import { resetAlertsRuntime } from "../alerts-runtime.js";
import { resetOctokit } from "../octokit-factory.js";

/**
 * Validates the host-provided config and, on credential success, caches the
 * plugin-wide bits (instance URL, TLS toggle) so the Octokit factory can
 * build the correct baseUrl on subsequent calls.
 *
 * Validation steps:
 *   1. Shape-check `instance` and `allowSelfSignedTls` (plugin-wide).
 *   2. Shape-check the `sources` array (used here for probing only; source
 *      selection now flows per-call via params on source-bound RPCs).
 *   3. Probe `/user` so an invalid / missing token surfaces a single clear error.
 *   4. For each configured source, probe the corresponding GitHub resource.
 *
 * Errors are accumulated per source so the host can surface a complete picture
 * (rather than failing on the first bad entry).
 */
export async function validateConfig(params: {
  config: Record<string, unknown>;
}): Promise<ValidateConfigResult> {
  const { config, errors: shapeErrors } = parseConfig(params.config);
  if (!config) {
    return { ok: false, errors: shapeErrors };
  }

  const { config: sourcesConfig, errors: sourcesErrors } = parseSourcesConfig(params.config);
  if (!sourcesConfig) {
    return { ok: false, errors: sourcesErrors };
  }

  // Set the plugin-wide active config (instance, TLS) before any network probe
  // so the Octokit factory can build the correct baseUrl. If a probe fails
  // downstream we roll back to the previous active config so existing
  // source-bound calls keep working.
  //
  // WU-032 AC #7: also clear the alerts-runtime token cache and Octokit
  // cache so the pre-flight probe (and any subsequent source-bound RPC)
  // picks up a regenerated PAT immediately. Same reset on rollback below
  // so the previous config's cached token doesn't leak back in.
  const prevConfig = tryGetActiveConfig();
  setActiveConfig(config);
  resetAlertsRuntime();
  resetOctokit();

  const errors: Array<{ field?: string; message: string }> = [];

  try {
    await fetchCurrentUser();
  } catch (err) {
    // Preserve the raw error message so the host-side classifier in
    // server/routes/integration.ts can detect TLS errors (TC-062) and
    // surface the inline self-signed-TLS opt-in affordance.
    const rawMessage = (err as Error).message;
    setActiveConfig(prevConfig);
    resetAlertsRuntime();
    resetOctokit();
    errors.push({ message: rawMessage });
    return { ok: false, errors };
  }

  // Token-only validation: empty sources means the caller is just verifying
  // the credential + instance URL (e.g. the global "Test connection" before
  // any sources have been picked). The plugin-wide active config remains set
  // to the just-tested values so source-bound calls use the right instance.
  if (sourcesConfig.sources.length === 0) {
    return { ok: true };
  }

  for (let i = 0; i < sourcesConfig.sources.length; i++) {
    const source = sourcesConfig.sources[i];
    try {
      if (source.kind === "repo") {
        await fetchRepoSummary(source.externalId);
      } else {
        const hashIdx = source.externalId.lastIndexOf("#");
        if (hashIdx === -1) {
          errors.push({
            field: `sources[${i}].externalId`,
            message: `Project externalId "${source.externalId}" missing "#<number>"`,
          });
          continue;
        }
        const owner = source.externalId.slice(0, hashIdx).replace(/\/$/, "");
        const projectNumber = Number(source.externalId.slice(hashIdx + 1));
        if (!owner || !Number.isInteger(projectNumber) || projectNumber <= 0) {
          errors.push({
            field: `sources[${i}].externalId`,
            message: `Project externalId "${source.externalId}" not in "owner/#<positive-int>" form`,
          });
          continue;
        }
        const projects = await fetchProjects(owner);
        if (!projects.find((p) => p.number === projectNumber)) {
          errors.push({
            field: `sources[${i}].externalId`,
            message: `Project #${projectNumber} not found for ${owner}`,
          });
        }
      }
    } catch (err) {
      errors.push({
        field: `sources[${i}].externalId`,
        message: `Failed to resolve ${source.kind} "${source.externalId}": ${(err as Error).message}`,
      });
    }
  }

  if (errors.length > 0) {
    setActiveConfig(prevConfig);
    resetAlertsRuntime();
    resetOctokit();
    return { ok: false, errors };
  }

  return { ok: true };
}
