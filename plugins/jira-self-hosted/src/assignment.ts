import { jiraFetch, JiraApiError, type JiraRequestContext } from "./jira-client.js";

/**
 * Jira Data Center accepts `{ name }` on the assignee endpoint; Cloud
 * accepts `{ accountId }`. We try the DC-flavoured field first since
 * this plugin targets DC 8.14+, and fall back to accountId on a 400 so
 * the plugin still works against Cloud-flavoured instances some
 * customers run via Data Center bridges.
 */

export async function assignIssue(
  ctx: JiraRequestContext,
  externalId: string,
  assigneeExternalId: string,
): Promise<void> {
  await putAssignee(ctx, externalId, assigneeExternalId);
}

export async function unassignIssue(ctx: JiraRequestContext, externalId: string): Promise<void> {
  await putAssignee(ctx, externalId, null);
}

async function putAssignee(
  ctx: JiraRequestContext,
  externalId: string,
  assignee: string | null,
): Promise<void> {
  const path = `/rest/api/2/issue/${encodeURIComponent(externalId)}/assignee`;
  try {
    await jiraFetch<unknown>(ctx, path, {
      method: "PUT",
      body: { name: assignee },
    });
    return;
  } catch (err) {
    if (!(err instanceof JiraApiError) || err.status !== 400) throw err;
    await jiraFetch<unknown>(ctx, path, {
      method: "PUT",
      body: { accountId: assignee },
    });
  }
}
