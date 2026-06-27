// The plugin uses fully-qualified external IDs of the form `owner/repo#number`
// so issue-scoped contract methods (getIssue, getComments, etc.) can recover
// the repo context without a separate configuration round-trip from the host.

export interface ParsedExternalId {
  repoFullName: string;
  issueNumber: number;
}

export function parseExternalId(externalId: string): ParsedExternalId {
  const hashIdx = externalId.lastIndexOf("#");
  if (hashIdx === -1) {
    throw new Error(
      `[github-com] externalId "${externalId}" missing "#<issue-number>". Expected "owner/repo#123".`,
    );
  }
  const repoFullName = externalId.slice(0, hashIdx);
  const numberStr = externalId.slice(hashIdx + 1);
  const issueNumber = Number(numberStr);
  if (!repoFullName.includes("/") || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(
      `[github-com] externalId "${externalId}" not in the expected "owner/repo#<positive-int>" form.`,
    );
  }
  return { repoFullName, issueNumber };
}

export function formatExternalId(repoFullName: string, issueNumber: number): string {
  return `${repoFullName}#${issueNumber}`;
}
