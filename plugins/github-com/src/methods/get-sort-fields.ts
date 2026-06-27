import type { SortField } from "@roubo/plugin-sdk";

/**
 * The cut-list sort fields github.com declares (CLI-FR-009, resolved by Spike
 * 554 / #554). GitHub has no canonical issue "key" sort, so no key option is
 * offered (CLI-FR-014); the three offered fields all default to descending
 * (newest / most-discussed first), which is the conventional GitHub ordering.
 * `listIssues` applies the selected field source-side so the order is stable
 * across pages (CLI-FR-010).
 */
export function getSortFields(): SortField[] {
  return [
    { id: "created", label: "Created", defaultDir: "desc" },
    { id: "updated", label: "Updated", defaultDir: "desc" },
    { id: "comments", label: "Comments", defaultDir: "desc" },
  ];
}
