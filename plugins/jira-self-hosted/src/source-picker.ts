import { jiraFetch, type JiraRequestContext } from "./jira-client.js";

/**
 * Epic fetcher for the cut-list Epic filter facet.
 *
 * Source selection no longer loads candidates instance-wide: the picker is the
 * `searchable-categorized` shape and items arrive through the scoped, paginated
 * `getSourceOptions` RPC (see `source-options.ts`). The only loader that
 * survives here is `fetchEpicIssues`, which still backs `getFacetOptions("epic")`
 * (the cut-list Epic facet, a filtering concern outside the source picker).
 */

interface IssueSearchResponse {
  issues?: Array<{
    key?: string;
    fields?: { summary?: string };
  }>;
}

/**
 * Fetch unresolved Epics for the `getFacetOptions("epic")` facet, mapped into
 * `FilterFacetOption[]` by the caller. Returns [] on transport / auth failure.
 */
export async function fetchEpicIssues(
  ctx: JiraRequestContext,
): Promise<Array<{ key: string; fields?: { summary?: string } }>> {
  try {
    const data = await jiraFetch<IssueSearchResponse>(ctx, "/rest/api/2/search", {
      query: {
        jql: "issuetype = Epic AND resolution = Unresolved ORDER BY updated DESC",
        fields: "summary",
        maxResults: 50,
      },
    });
    const issues = data.issues ?? [];
    return issues.filter(
      (issue): issue is { key: string; fields?: { summary?: string } } =>
        typeof issue.key === "string",
    );
  } catch {
    return [];
  }
}
