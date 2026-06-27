/**
 * Plugin config plumbing.
 *
 * Two call shapes:
 * - Flat: `validateConfig({ config })` and `setActiveConfig({ config })`
 *   both receive a flattened payload `{ instance, [pat], blocksLinkTypeName,
 *   isBlockedByLinkTypeName }`. validateConfig sees the raw Configure-dialog
 *   form values; setActiveConfig sees the host's `buildPluginConfig` output,
 *   which flattens IntegrationConfig.advanced.* onto the top level.
 * - Nested: `listSourceCandidates({ config })` receives the project's
 *   IntegrationConfig wrapper: `{ plugin, instance, advanced: { blocksLinkTypeName, ... } }`.
 *
 * `parseFormConfig` handles the flat shape; `parseIntegrationConfig`
 * pulls fields out of the IntegrationConfig wrapper.
 *
 * Methods like `listIssues`, `getIssue`, `applyTransition` etc. don't
 * receive config at all; they read from the in-process cache populated
 * by an earlier call. See `index.ts`.
 */

export interface JiraPluginConfig {
  instance: string;
  blocksLinkTypeName: string;
  isBlockedByLinkTypeName: string;
  allowSelfSignedTls: boolean;
}

export interface ConfigParseFailure {
  field: string;
  message: string;
}

export type ConfigParseResult =
  | { ok: true; config: JiraPluginConfig }
  | { ok: false; errors: ConfigParseFailure[] };

const DEFAULT_BLOCKS_LINK = "blocks";
const DEFAULT_IS_BLOCKED_BY_LINK = "is blocked by";

export function parseFormConfig(raw: Record<string, unknown>): ConfigParseResult {
  return finalize(
    raw.instance,
    raw.blocksLinkTypeName,
    raw.isBlockedByLinkTypeName,
    raw.allowSelfSignedTls,
  );
}

export function parseIntegrationConfig(raw: Record<string, unknown>): ConfigParseResult {
  const advanced =
    raw.advanced && typeof raw.advanced === "object" && !Array.isArray(raw.advanced)
      ? (raw.advanced as Record<string, unknown>)
      : {};
  return finalize(
    raw.instance,
    advanced.blocksLinkTypeName,
    advanced.isBlockedByLinkTypeName,
    advanced.allowSelfSignedTls,
  );
}

function finalize(
  rawInstance: unknown,
  rawBlocks: unknown,
  rawIsBlockedBy: unknown,
  rawAllowSelfSignedTls: unknown,
): ConfigParseResult {
  const errors: ConfigParseFailure[] = [];

  let instance = "";
  if (typeof rawInstance !== "string" || rawInstance.trim() === "") {
    errors.push({ field: "instance", message: "Jira instance URL is required." });
  } else {
    try {
      const parsed = new URL(rawInstance);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        errors.push({ field: "instance", message: "Jira instance URL must use http or https." });
      } else {
        instance = stripTrailingSlash(parsed.toString());
      }
    } catch {
      errors.push({ field: "instance", message: "Jira instance URL is not a valid URL." });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    config: {
      instance,
      blocksLinkTypeName: optionalString(rawBlocks, DEFAULT_BLOCKS_LINK),
      isBlockedByLinkTypeName: optionalString(rawIsBlockedBy, DEFAULT_IS_BLOCKED_BY_LINK),
      allowSelfSignedTls: rawAllowSelfSignedTls === true,
    },
  };
}

function optionalString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed === "" ? fallback : trimmed;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
