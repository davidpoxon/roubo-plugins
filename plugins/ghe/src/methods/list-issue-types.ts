import type { IssueTypeOption, ListIssueTypesParams } from "@roubo/plugin-sdk";
import { requirePrimarySource } from "../sources.js";
import { fetchIssueTypes } from "../github-fetchers.js";

export async function listIssueTypes(params: ListIssueTypesParams): Promise<IssueTypeOption[]> {
  // Issue types cover the primary source only; multi-source (submodule) facet
  // coverage tracked in #369.
  const source = requirePrimarySource(params.sources);
  if (source.kind !== "repo") {
    // Issue types are repo-scoped in the GitHub data model; for a project
    // source we have no single repo to query, so return an empty list.
    return [];
  }
  const result = await fetchIssueTypes(source.externalId);
  return result.types.map((t) => ({ id: t.id, name: t.name }));
}
