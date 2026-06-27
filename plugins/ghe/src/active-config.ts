import type { PluginConfig } from "./types.js";

// The plugin caches the host-supplied plugin-wide config (instance URL and
// TLS toggle) so the Octokit factory can build the correct baseUrl on every
// source-bound RPC. The host pushes this via setActiveConfig whenever the
// global GHE integration config changes; it is naturally plugin-wide and
// identical across projects, so there is no cross-project bleed here.
//
// Source selection is no longer stored in active config: each source-bound
// method receives its sources via per-call params, so the host can hand the
// correct per-project list directly without racing against another project's
// snapshot.

let activeConfig: PluginConfig | null = null;

export function setActiveConfig(config: PluginConfig | null): void {
  activeConfig = config;
}

export function getActiveConfig(): PluginConfig {
  if (!activeConfig) {
    throw new Error(
      "[ghe] No active configuration. The host must call setActiveConfig (with at least { instance }) before invoking source-scoped methods.",
    );
  }
  return activeConfig;
}

export function tryGetActiveConfig(): PluginConfig | null {
  return activeConfig;
}

/**
 * Parses the host-provided plugin-wide config into the typed PluginConfig
 * shape used internally. Validates the `instance` URL and the optional
 * `allowSelfSignedTls` toggle. Source selection is supplied per-call via
 * each source-bound method's `sources` param, not via this config.
 */
export function parseConfig(raw: Record<string, unknown>): {
  config: PluginConfig | null;
  errors: Array<{ field?: string; message: string }>;
} {
  const errors: Array<{ field?: string; message: string }> = [];

  const rawInstance = (raw as { instance?: unknown }).instance;
  let instance = "";
  if (typeof rawInstance !== "string" || rawInstance.length === 0) {
    errors.push({ field: "instance", message: "instance must be a non-empty string" });
  } else {
    try {
      const parsed = new URL(rawInstance);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        errors.push({ field: "instance", message: "instance must be an http(s) URL" });
      } else {
        instance = rawInstance.replace(/\/$/, "");
      }
    } catch {
      errors.push({ field: "instance", message: "instance is not a valid URL" });
    }
  }

  const rawAllowSelfSignedTls = (raw as { allowSelfSignedTls?: unknown }).allowSelfSignedTls;
  let allowSelfSignedTls = false;
  if (rawAllowSelfSignedTls !== undefined) {
    if (typeof rawAllowSelfSignedTls !== "boolean") {
      errors.push({ field: "allowSelfSignedTls", message: "must be a boolean" });
    } else {
      allowSelfSignedTls = rawAllowSelfSignedTls;
    }
  }

  if (errors.length > 0) return { config: null, errors };
  return { config: { instance, allowSelfSignedTls }, errors: [] };
}
