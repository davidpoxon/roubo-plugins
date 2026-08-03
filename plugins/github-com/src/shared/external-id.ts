// External-id format used by the bundled GitHub plugins:
//   issue:  <owner>/<repo>#<positive-int>            (existing)
//   alert:  <owner>/<repo>#<category>-<positive-int> (added by WU-029 per FR-044)
//
// Both forms share the same `(integrationId, externalId)` keyspace, so the
// alert form must never collide with an issue number on the same repo. The
// category prefix is what guarantees that: an issue can never start with
// `code-scanning-`, `secret-scanning-`, or `dependabot-`.

export const ALERT_CATEGORIES = ["code-scanning", "secret-scanning", "dependabot"] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

export type ParsedGithubExternalId =
  | { kind: "issue"; repoFullName: string; issueNumber: number }
  | { kind: "alert"; repoFullName: string; category: AlertCategory; alertNumber: number };

export function formatAlertExternalId(
  repoFullName: string,
  category: AlertCategory,
  alertNumber: number,
): string {
  return `${repoFullName}#${category}-${alertNumber}`;
}

const ALERT_RIGHT_RE = /^(code-scanning|secret-scanning|dependabot)-(\d+)$/;

export function parseGithubExternalId(externalId: string): ParsedGithubExternalId {
  const hashIdx = externalId.lastIndexOf("#");
  if (hashIdx === -1) {
    throw new Error(
      `[shared-github] externalId "${externalId}" missing "#". Expected "owner/repo#<n>" or "owner/repo#<category>-<n>".`,
    );
  }
  const repoFullName = externalId.slice(0, hashIdx);
  const right = externalId.slice(hashIdx + 1);
  if (!repoFullName.includes("/")) {
    throw new Error(`[shared-github] externalId "${externalId}" missing "owner/repo" segment.`);
  }

  const alertMatch = ALERT_RIGHT_RE.exec(right);
  if (alertMatch) {
    const category = alertMatch[1] as AlertCategory;
    const alertNumber = Number(alertMatch[2]);
    if (!Number.isInteger(alertNumber) || alertNumber <= 0) {
      throw new Error(
        `[shared-github] externalId "${externalId}" alert number must be a positive integer.`,
      );
    }
    return { kind: "alert", repoFullName, category, alertNumber };
  }

  const issueNumber = Number(right);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(
      `[shared-github] externalId "${externalId}" not in expected "owner/repo#<positive-int>" or "owner/repo#<category>-<positive-int>" form.`,
    );
  }
  return { kind: "issue", repoFullName, issueNumber };
}
