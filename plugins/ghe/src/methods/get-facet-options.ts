import type { FilterFacetOption, GetFacetOptionsParams } from "@roubo/plugin-sdk";
import { requirePrimarySource } from "../sources.js";
import {
  fetchAssignees,
  fetchIssueTypes,
  fetchLabels,
  fetchMilestones,
} from "../github-fetchers.js";

/**
 * Resolve the option values for one `enum-async` facet. Each value must match
 * what the host resolves for the issue (see `issueFacetValues` in the client):
 * labels = name, type = issueType name, assignee = login, milestone = title.
 */
async function fetchFacetValues(facetId: string, repoFullName: string): Promise<string[]> {
  switch (facetId) {
    case "milestone":
      return fetchMilestones(repoFullName);
    case "label":
      return fetchLabels(repoFullName);
    case "type": {
      const result = await fetchIssueTypes(repoFullName);
      return result.types.map((t) => t.name);
    }
    case "assignee":
      return fetchAssignees(repoFullName);
    default:
      return [];
  }
}

export async function getFacetOptions(params: GetFacetOptionsParams): Promise<FilterFacetOption[]> {
  // Facet options cover the primary source only; multi-source (submodule) facet
  // coverage tracked in #369.
  const source = requirePrimarySource(params.sources);
  if (source.kind !== "repo") return [];

  const values = await fetchFacetValues(params.facetId, source.externalId);
  const options: FilterFacetOption[] = values.map((value) => ({ value, label: value }));

  if (!params.search) return options;
  const needle = params.search.toLowerCase();
  return options.filter((o) => o.label.toLowerCase().includes(needle));
}
