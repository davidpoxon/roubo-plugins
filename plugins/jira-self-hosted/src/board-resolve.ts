import { host } from "@roubo/plugin-sdk";
import { jiraFetch, JiraApiError, type JiraRequestContext } from "./jira-client.js";
import { jqlNumericOrQuoted } from "./jql.js";

/**
 * Active-sprint resolution for `board` sources (FR-004).
 *
 * A board is a saved filter plus an agile overlay in Jira's data model, so a
 * board source resolves to JQL at list time (never while browsing, where the
 * old instance-wide fan-out used to live). Default = the board's active sprint
 * only; widened = the whole board's backing filter. Kanban boards have no
 * sprint, so an `active-sprint` request against one falls back to whole-board.
 */

export type BoardMode = "active-sprint" | "whole-board";

interface BoardConfigurationResponse {
  filter?: { id?: number | string };
}

interface SprintSearchResponse {
  values?: Array<{ id?: number | string; state?: string }>;
}

/**
 * Resolve a board id + mode to its issue JQL clause.
 *
 * - `whole-board` → `filter = <backingFilterId>`.
 * - `active-sprint` → `(sprint in openSprints() AND filter = <backingFilterId>)`
 *   when the board has at least one active sprint; otherwise (kanban / no active
 *   sprint) it falls back to whole-board with a logged note.
 *
 * Returns an empty string when the backing filter id cannot be resolved, so the
 * caller drops the source from the union rather than emitting a broken clause.
 */
export async function resolveBoardClause(
  ctx: JiraRequestContext,
  boardId: string,
  mode: BoardMode,
): Promise<string> {
  const backingFilterId = await getBackingFilterId(ctx, boardId);
  if (backingFilterId === null) {
    host.logger.warn({
      message: "Jira board could not be resolved to a backing filter; dropping source.",
      data: { boardId },
    });
    return "";
  }
  const filterClause = `filter = ${jqlNumericOrQuoted(backingFilterId)}`;

  if (mode === "whole-board") {
    return filterClause;
  }

  const hasActiveSprint = await boardHasActiveSprint(ctx, boardId);
  if (!hasActiveSprint) {
    // Kanban board (or a scrum board between sprints): there is no active
    // sprint to scope to, so widen to the whole board's backing filter.
    host.logger.info({
      message: "Jira board has no active sprint; resolving to whole board.",
      data: { boardId, mode, resolvedKind: "whole-board-fallback" },
    });
    return filterClause;
  }

  host.logger.info({
    message: "Resolved Jira board to its active sprint.",
    data: { boardId, mode, resolvedKind: "active-sprint" },
  });
  return `(sprint in openSprints() AND ${filterClause})`;
}

/** Read the board's backing saved-filter id from its configuration. */
async function getBackingFilterId(
  ctx: JiraRequestContext,
  boardId: string,
): Promise<string | null> {
  const config = await jiraFetch<BoardConfigurationResponse>(
    ctx,
    `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/configuration`,
  );
  const id = config.filter?.id;
  return id === undefined || id === null ? null : String(id);
}

/**
 * Whether the board has at least one active sprint. Kanban boards do not
 * support sprints; that endpoint answers with a 400 on Data Center, which we
 * treat as "no active sprint" (the whole-board fallback) rather than an error.
 */
async function boardHasActiveSprint(ctx: JiraRequestContext, boardId: string): Promise<boolean> {
  try {
    const data = await jiraFetch<SprintSearchResponse>(
      ctx,
      `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/sprint`,
      { query: { state: "active" } },
    );
    return (data.values ?? []).length > 0;
  } catch (err) {
    if (err instanceof JiraApiError && err.status === 400) {
      return false;
    }
    throw err;
  }
}
