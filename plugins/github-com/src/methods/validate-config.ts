import type { ValidateConfigResult } from "@roubo/plugin-sdk";
import { parseSourcesConfig } from "../parse-sources.js";
import { fetchCurrentUser, fetchProjects, fetchRepoSummary } from "../github-fetchers.js";
import { resetAlertsRuntime } from "../alerts-runtime.js";
import { resetOctokit } from "../octokit-factory.js";

/**
 * Validates the host-provided config:
 *   1. Shape-check the `sources` array.
 *   2. Probe `/user` so an invalid / missing token surfaces a single clear error.
 *   3. For each configured source, probe the corresponding GitHub resource.
 *
 * Errors are accumulated per source so the host can surface a complete picture
 * (rather than failing on the first bad entry). validateConfig is read-only:
 * it never persists state inside the plugin process. Source-bound RPCs receive
 * their sources per-call via params.
 */
export async function validateConfig(params: {
  config: Record<string, unknown>;
}): Promise<ValidateConfigResult> {
  const { config, errors: shapeErrors } = parseSourcesConfig(params.config);
  if (!config) {
    return { ok: false, errors: shapeErrors };
  }

  // WU-032 AC #7 parity: clear the alerts-runtime token cache and Octokit
  // cache so a freshly-rotated OAuth token (e.g. after a re-consent flow
  // that ended with another validateConfig call) is picked up immediately
  // by the next source-bound RPC. Same defensive reset on every save path.
  resetAlertsRuntime();
  resetOctokit();

  const errors: NonNullable<ValidateConfigResult["errors"]> = [];

  try {
    await fetchCurrentUser();
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (status === 401) {
      errors.push({
        field: "github-token",
        message: "GitHub token is invalid or expired",
        code: "unauthorized",
      });
    } else {
      errors.push({ message: `Failed to authenticate with GitHub: ${(err as Error).message}` });
    }
    return { ok: false, errors };
  }

  // Token-only validation: no sources to probe. The credential check above
  // already covered the only assertion we can make. Skip activating an empty
  // config because that would erase a previously-set one and re-break
  // source-bound calls (listIssues etc.) for downstream callers.
  if (config.sources.length === 0) {
    return { ok: true };
  }

  for (let i = 0; i < config.sources.length; i++) {
    const source = config.sources[i];
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
    return { ok: false, errors };
  }

  return { ok: true };
}
