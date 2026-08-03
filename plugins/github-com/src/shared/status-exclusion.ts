// Shared github-family server-side status exclusion (issue #399).
//
// After #354 the host no longer filters excluded statuses client-side, so each
// plugin must honor its resolved `excludedStatuses` itself. For the github
// family the only status beyond open/closed is a GitHub Projects v2 "Status"
// column value (e.g. "In review", "PR open", "Done"); github.com has no
// statusCategory concept, so only the status-name list is consulted.

/**
 * True when a board item's Projects v2 "Status" column name is in the
 * host-resolved `excludedStatuses` list. Comparison is trimmed and
 * case-insensitive so a manifest seed like "In review" still matches a board
 * column labelled "In Review". A null/empty status name or an empty exclusion
 * list never excludes.
 */
export function isStatusExcluded(
  statusName: string | null | undefined,
  excludedStatuses: readonly string[] | undefined,
): boolean {
  if (!statusName || !excludedStatuses || excludedStatuses.length === 0) return false;
  const target = statusName.trim().toLowerCase();
  if (!target) return false;
  return excludedStatuses.some((s) => s.trim().toLowerCase() === target);
}
