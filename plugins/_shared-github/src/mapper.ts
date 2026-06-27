import type { NormalizedIssue } from "@roubo/plugin-sdk";
import type { RawCodeScanningAlert } from "./alerts/code-scanning.js";
import type { RawDependabotAlert } from "./alerts/dependabot.js";
import type { RawSecretScanningAlert } from "./alerts/secret-scanning.js";
import { formatAlertExternalId } from "./external-id.js";
import { redactCodeScanningAlert, redactSecretScanningAlert } from "./redact.js";

// FR-043: issueType strings the host uses to route security alerts through
// the alert-only cut-list bucket and to gate UI controls per FR-048.
export const CODE_SCANNING_ISSUE_TYPE = "security-code-scanning";
export const SECRET_SCANNING_ISSUE_TYPE = "security-secret-scanning";
export const DEPENDABOT_ISSUE_TYPE = "security-dependabot";

/** Canonical alert lifecycle vocabulary the host uses for auto-clear (#289). */
export type NormalizedAlertState = "open" | "fixed" | "dismissed";

/**
 * Normalize a category-specific GitHub alert state into the canonical
 * `open | fixed | dismissed` vocabulary. The raw values differ per category
 * (code-scanning: open/dismissed/fixed; secret-scanning: open/resolved;
 * dependabot: open/dismissed/fixed/auto_dismissed), so we fold the terminal
 * variants together. Any missing or unrecognized value falls back to "open"
 * so an ambiguous state never triggers a teardown.
 */
export function normalizeAlertState(rawState: string | null | undefined): NormalizedAlertState {
  switch (rawState) {
    case "fixed":
      return "fixed";
    case "dismissed":
    case "auto_dismissed": // dependabot
    case "resolved": // secret-scanning
      return "dismissed";
    default:
      return "open";
  }
}

function commonAlertFields(
  currentState: NormalizedAlertState,
): Pick<
  NormalizedIssue,
  "body" | "currentState" | "allowedTransitions" | "assignees" | "labels" | "blocks" | "blockedBy"
> {
  return {
    body: null,
    currentState,
    // FR-048: alerts are read-only — no host-mediated state changes, no assignment.
    // currentState reflects the alert's lifecycle for read/auto-clear purposes only.
    allowedTransitions: [],
    assignees: [],
    labels: [],
    blocks: [],
    blockedBy: [],
  };
}

export function mapCodeScanningAlertToNormalizedIssue(
  integrationId: string,
  repoFullName: string,
  raw: RawCodeScanningAlert,
): NormalizedIssue {
  const redacted = redactCodeScanningAlert(raw);
  const title =
    redacted.rule?.description ??
    redacted.rule?.name ??
    redacted.rule?.id ??
    `Code scanning alert #${redacted.number}`;
  return {
    integrationId,
    externalId: formatAlertExternalId(repoFullName, "code-scanning", redacted.number),
    externalUrl: redacted.html_url,
    title,
    issueType: CODE_SCANNING_ISSUE_TYPE,
    updatedAt: redacted.updated_at ?? redacted.created_at,
    raw: redacted,
    ...commonAlertFields(normalizeAlertState(redacted.state)),
  };
}

export function mapSecretScanningAlertToNormalizedIssue(
  integrationId: string,
  repoFullName: string,
  raw: RawSecretScanningAlert,
): NormalizedIssue {
  const redacted = redactSecretScanningAlert(raw);
  const title =
    redacted.secret_type_display_name ??
    redacted.secret_type ??
    `Secret scanning alert #${redacted.number}`;
  return {
    integrationId,
    externalId: formatAlertExternalId(repoFullName, "secret-scanning", redacted.number),
    externalUrl: redacted.html_url,
    title,
    issueType: SECRET_SCANNING_ISSUE_TYPE,
    updatedAt: redacted.updated_at ?? redacted.created_at,
    raw: redacted,
    ...commonAlertFields(normalizeAlertState(redacted.state)),
  };
}

export function mapDependabotAlertToNormalizedIssue(
  integrationId: string,
  repoFullName: string,
  raw: RawDependabotAlert,
): NormalizedIssue {
  // Dependabot alerts carry no secret material or embedded snippets, so the
  // payload passes through unmodified; we still spread into a fresh object so
  // the mapper never hands the caller a reference into the API response.
  const cloned: RawDependabotAlert = { ...raw };
  const title =
    cloned.security_advisory?.summary ??
    `Dependabot alert #${cloned.number} (${cloned.dependency?.package?.name ?? "unknown package"})`;
  return {
    integrationId,
    externalId: formatAlertExternalId(repoFullName, "dependabot", cloned.number),
    externalUrl: cloned.html_url,
    title,
    issueType: DEPENDABOT_ISSUE_TYPE,
    updatedAt: cloned.updated_at ?? cloned.created_at,
    raw: cloned,
    ...commonAlertFields(normalizeAlertState(cloned.state)),
  };
}
