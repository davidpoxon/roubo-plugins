import { describe, expect, it } from "vitest";
import { buildIssueListJql, jqlSearchTerm } from "../jql.js";

describe("buildIssueListJql exclusion + board branches", () => {
  it("emits a status-name exclusion on the fallback path and ignores it when empty", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
      excludedStatusCategories: ["Done"],
      excludedStatuses: ["Closed", "Resolved"],
      statusCategorySupported: false,
    });
    expect(jql).toContain('status not in ("Closed", "Resolved")');
    expect(jql).not.toContain("statusCategory");

    const noExclusion = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
      excludedStatuses: [],
      statusCategorySupported: false,
    });
    expect(noExclusion).not.toContain("status not in");
  });

  it("drops an unresolved board from the union but keeps a resolved one", () => {
    const unresolved = buildIssueListJql({
      sources: [{ kind: "board", externalId: "b1" }],
    });
    // Board contributes nothing -> only the default ORDER BY tail remains.
    expect(unresolved).toBe("ORDER BY updated ASC");

    const resolved = buildIssueListJql({
      sources: [{ kind: "board", externalId: "b1", resolvedClause: "sprint in openSprints()" }],
    });
    expect(resolved).toContain("(sprint in openSprints())");
  });
});

describe("jqlSearchTerm hardening branches", () => {
  it("strips ASCII control characters and DEL before quoting", () => {
    // Construct control bytes via char codes to keep the source free of
    // literal control characters (mirrors stripControlChars' own rationale).
    const withControls = `a${String.fromCharCode(1)}b${String.fromCharCode(0x7f)}c`;
    expect(jqlSearchTerm(withControls)).toBe('"abc"');
  });

  it("coerces a null/undefined term to an empty quoted literal", () => {
    expect(jqlSearchTerm(null as unknown as string)).toBe('""');
    expect(jqlSearchTerm(undefined as unknown as string)).toBe('""');
  });
});
