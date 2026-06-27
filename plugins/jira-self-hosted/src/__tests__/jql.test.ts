import { describe, expect, it } from "vitest";
import { assertProjectKey, buildIssueListJql, JIRA_SORT_FIELDS, jqlSearchTerm } from "../jql.js";

describe("buildIssueListJql", () => {
  it("never emits an 'updated >=' clause (point-in-time, no watermark)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "filter", externalId: "456" }],
    });
    expect(jql).not.toContain("updated >=");
  });

  it("orders by updated ASC for deterministic startAt pagination", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "filter", externalId: "456" }],
    });
    expect(jql.endsWith("ORDER BY updated ASC")).toBe(true);
  });

  it("joins multiple sources with OR", () => {
    const jql = buildIssueListJql({
      sources: [
        { kind: "filter", externalId: "456" },
        { kind: "epic", externalId: "PROJ-99" },
      ],
    });
    expect(jql).toContain('(filter = 456 OR "Epic Link" = "PROJ-99")');
  });

  it("quotes non-numeric filter ids defensively", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "filter", externalId: "my-saved" }],
    });
    expect(jql).toContain('filter = "my-saved"');
  });

  it("emits a bare ORDER BY when nothing constrains the search", () => {
    expect(buildIssueListJql({ sources: [] })).toBe("ORDER BY updated ASC");
  });

  it("emits the requested sort field as the ORDER BY tail (CLI-FR-010)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
      sortBy: "priority",
      sortDir: "desc",
    });
    expect(jql.endsWith("ORDER BY priority DESC")).toBe(true);
  });

  it("supports source-side key ordering (CLI-FR-014)", () => {
    const jql = buildIssueListJql({ sources: [], sortBy: "key", sortDir: "asc" });
    expect(jql).toBe("ORDER BY key ASC");
  });

  it("falls back to the deterministic updated ASC default for an unrecognised sort field", () => {
    const jql = buildIssueListJql({ sources: [], sortBy: "nonsense", sortDir: "desc" });
    expect(jql).toBe("ORDER BY updated ASC");
  });

  it("declares key/updated/created/priority sort fields (Spike 554)", () => {
    expect(JIRA_SORT_FIELDS.map((f) => f.id)).toEqual(["key", "updated", "created", "priority"]);
    expect(JIRA_SORT_FIELDS.find((f) => f.id === "key")?.defaultDir).toBe("asc");
  });

  it("builds a project clause (TC-008)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
    });
    expect(jql).toContain('(project = "PLAT")');
  });

  it("emits a board source's pre-resolved clause verbatim (TC-004)", () => {
    const jql = buildIssueListJql({
      sources: [
        {
          kind: "board",
          externalId: "board:482",
          boardMode: "active-sprint",
          resolvedClause: "(sprint in openSprints() AND filter = 10231)",
        },
      ],
    });
    expect(jql).toContain("(sprint in openSprints() AND filter = 10231)");
  });

  it("drops an unresolved board clause from the union", () => {
    const jql = buildIssueListJql({
      sources: [
        { kind: "project", externalId: "PLAT" },
        { kind: "board", externalId: "board:482", boardMode: "active-sprint", resolvedClause: "" },
      ],
    });
    // No dangling `( OR ...)`; only the project clause survives.
    expect(jql).toBe('(project = "PLAT") ORDER BY updated ASC');
  });

  it("scopes 'assigned to me' to the in-scope projects in in-project mode (TC-007)", () => {
    const jql = buildIssueListJql({
      sources: [
        {
          kind: "mine",
          externalId: "mine",
          mineScope: "in-project",
          scopeProjectKeys: ["PLAT", "PAY"],
        },
      ],
    });
    expect(jql).toContain('(assignee = currentUser() AND project in ("PLAT", "PAY"))');
  });

  it("matches 'assigned to me' anywhere when mineScope is anywhere (TC-007)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "mine", externalId: "mine", mineScope: "anywhere" }],
    });
    expect(jql).toContain("(assignee = currentUser())");
    expect(jql).not.toContain("project in");
  });

  it("falls back to currentUser() when in-project mode has no scoped projects", () => {
    const jql = buildIssueListJql({
      sources: [
        { kind: "mine", externalId: "mine", mineScope: "in-project", scopeProjectKeys: [] },
      ],
    });
    expect(jql).toContain("(assignee = currentUser())");
    expect(jql).not.toContain("project in");
  });

  it("ANDs a board source with 'assigned to me' rather than OR-ing them (TC-007)", () => {
    const jql = buildIssueListJql({
      sources: [
        {
          kind: "board",
          externalId: "board:482",
          boardMode: "active-sprint",
          resolvedClause: "(sprint in openSprints() AND filter = 10231)",
        },
        {
          kind: "mine",
          externalId: "mine",
          mineScope: "in-project",
          scopeProjectKeys: ["PLAT"],
        },
      ],
    });
    // The board union must be AND-ed with the assignee clause, not OR-ed.
    // Note: toClause wraps the in-project mine result; buildIssueListJql wraps
    // the mineClause again, so we get double parens around the assignee half.
    expect(jql).toBe(
      '((sprint in openSprints() AND filter = 10231)) AND ((assignee = currentUser() AND project in ("PLAT"))) ORDER BY updated ASC',
    );
    // Assert neither half is joined to the other with OR at the top level.
    expect(jql).not.toContain(") OR (");
  });

  it("ANDs a filter source with 'assigned to me' rather than OR-ing them", () => {
    const jql = buildIssueListJql({
      sources: [
        { kind: "filter", externalId: "456" },
        { kind: "mine", externalId: "mine", mineScope: "anywhere" },
      ],
    });
    expect(jql).toBe("(filter = 456) AND (assignee = currentUser()) ORDER BY updated ASC");
    // Assert neither half is joined to the other with OR at the top level.
    expect(jql).not.toContain(") OR (");
  });

  it("joins mixed-kind sources into a single de-duplicated OR union (TC-008)", () => {
    const jql = buildIssueListJql({
      sources: [
        { kind: "project", externalId: "PLAT" },
        {
          kind: "board",
          externalId: "board:482",
          boardMode: "active-sprint",
          resolvedClause: "(sprint in openSprints() AND filter = 10231)",
        },
        { kind: "filter", externalId: "555" },
      ],
    });
    expect(jql).toBe(
      '(project = "PLAT" OR (sprint in openSprints() AND filter = 10231) OR filter = 555) ' +
        "ORDER BY updated ASC",
    );
  });

  it("escapes both backslashes and double quotes in quoted identifiers", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "epic", externalId: 'PROJ\\"99' }],
    });
    // The backslash and the quote must both be escaped so the literal stays closed.
    expect(jql).toContain('"Epic Link" = "PROJ\\\\\\"99"');
  });
});

describe("buildIssueListJql status exclusion (FR-009/FR-010)", () => {
  it("ANDs a statusCategory exclusion clause across the whole union (TC-009)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
      excludedStatusCategories: ["Done"],
    });
    expect(jql).toBe('(project = "PLAT") AND statusCategory not in ("Done") ORDER BY updated ASC');
  });

  it("emits no exclusion clause when the category list is empty (TC-009)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
      excludedStatusCategories: [],
    });
    expect(jql).not.toContain("statusCategory");
    expect(jql).not.toContain("status not in");
  });

  it("excludes multiple categories, category-based not name-based (TC-010)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
      excludedStatusCategories: ["Done", "In Progress"],
    });
    expect(jql).toContain('statusCategory not in ("Done", "In Progress")');
    expect(jql).not.toContain("status not in");
  });

  it("ignores the status-name list on the supported path (names are fallback-only)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
      excludedStatusCategories: ["Done"],
      excludedStatuses: ["Closed", "Resolved"],
    });
    expect(jql).toContain('statusCategory not in ("Done")');
    expect(jql).not.toContain("status not in");
  });

  it("falls back to status-name enumeration when statusCategory is unsupported (TC-037)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
      excludedStatusCategories: ["Done"],
      excludedStatuses: ["Closed", "Done", "Resolved"],
      statusCategorySupported: false,
    });
    expect(jql).toBe(
      '(project = "PLAT") AND status not in ("Closed", "Done", "Resolved") ORDER BY updated ASC',
    );
  });

  it("emits no clause on the fallback path when no status names are configured (TC-037)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
      excludedStatusCategories: ["Done"],
      excludedStatuses: [],
      statusCategorySupported: false,
    });
    expect(jql).not.toContain("statusCategory");
    expect(jql).not.toContain("status not in");
  });

  it("escapes status names so a crafted category cannot inject a clause (NFR-003)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
      excludedStatusCategories: ['Done") OR (1=1'],
    });
    expect(jql).toContain('statusCategory not in ("Done\\") OR (1=1")');
  });
});

describe("jqlSearchTerm (NFR-003 injection hardening)", () => {
  it("returns a quoted literal for a plain term", () => {
    expect(jqlSearchTerm("platform")).toBe('"platform"');
  });

  it("escapes embedded quotes so a crafted term cannot break out of the literal", () => {
    expect(jqlSearchTerm('a" OR x')).toBe('"a\\" OR x"');
  });

  it("neutralizes JQL wildcard / operator hazards to spaces", () => {
    expect(jqlSearchTerm("a~*?b")).toBe('"a b"');
  });

  it("collapses to an empty quoted literal when only hazards are supplied", () => {
    expect(jqlSearchTerm("~*?")).toBe('""');
  });

  it("bounds the term length", () => {
    const inner = jqlSearchTerm("a".repeat(500)).slice(1, -1);
    expect(inner.length).toBe(100);
  });
});

describe("assertProjectKey", () => {
  it("returns a valid project key unchanged", () => {
    expect(assertProjectKey("PLAT")).toBe("PLAT");
    expect(assertProjectKey("PAY_2")).toBe("PAY_2");
  });

  it("rejects lowercase, hyphenated, single-char, or empty keys", () => {
    expect(() => assertProjectKey("plat")).toThrow(/Invalid Jira project key/);
    expect(() => assertProjectKey("bad-key")).toThrow(/Invalid Jira project key/);
    expect(() => assertProjectKey("X")).toThrow(/Invalid Jira project key/);
    expect(() => assertProjectKey("")).toThrow(/Invalid Jira project key/);
  });
});
