import type { FilterFacet } from "@roubo/plugin-sdk";

export function filterFacets(): FilterFacet[] {
  // `enum-async` facets fetch a complete repo-wide option list via
  // `getFacetOptions`. `status` stays an eager `enum`: GitHub has no clean
  // repo-wide status vocabulary endpoint, so the host derives its options from
  // the loaded cut list, which is exactly the set of statuses that can match.
  return [
    { id: "type", label: "Type", type: "enum-async" },
    { id: "label", label: "Label", type: "enum-async" },
    { id: "status", label: "Status", type: "enum" },
    { id: "assignee", label: "Assignee", type: "enum-async" },
    { id: "milestone", label: "Milestone", type: "enum-async" },
  ];
}
