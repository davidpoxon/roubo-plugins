import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPluginContract, _resetForTests } from "../plugin.js";
import { installHostHarness, StubResponse, type HostHarness } from "./helpers/host-stub.js";

const INSTANCE = "https://jira.acme.example";

interface SearchResult {
  items: Array<{ externalId: string }>;
  nextCursor: string | null;
  excludedCount?: number;
}

describe("server-side status exclusion + statusCategory fallback (TC-037, TC-017)", () => {
  let harness: HostHarness;

  beforeEach(async () => {
    _resetForTests();
    harness = installHostHarness(createPluginContract());
    harness.credentials.set("pat", "test-token");
    // Bootstrap the in-process config cache so later source-bound calls recall
    // the instance, exactly as the host does on a real first call.
    harness.fetchStub.on("/rest/api/2/myself", () => ({ displayName: "Anna" }));
    await harness.hostConnection.sendRequest("validateConfig", {
      config: { instance: INSTANCE, pat: "test-token" },
    });
  });
  afterEach(() => {
    harness.dispose();
    _resetForTests();
  });

  // The count-only companion query (#434) hits the same `/rest/api/2/search`
  // path with `maxResults: 0`; route it to `countJqls` so the page-search
  // assertions below stay about the main query alone. The companion reports a
  // larger unfiltered total (5) than the filtered page total (1), so a
  // first-page call with an exclusion configured yields excludedCount 4.
  function onSearch(): { jqls: string[]; countJqls: string[]; statusCategory400Once: () => void } {
    const jqls: string[] = [];
    const countJqls: string[] = [];
    let reject400 = false;
    harness.fetchStub.on("/rest/api/2/search", (init) => {
      const body = JSON.parse(init.body ?? "{}");
      if (body.maxResults === 0) {
        countJqls.push(body.jql ?? "");
        return { issues: [], total: 5 };
      }
      jqls.push(body.jql ?? "");
      if (reject400) {
        reject400 = false;
        return StubResponse.jiraError(
          400,
          "Field 'statusCategory' does not exist or you do not have permission to view it.",
        );
      }
      return {
        issues: [
          {
            key: "PROJ-1",
            fields: { summary: "x", status: { name: "Open" }, updated: "2026-04-05T00:00:00Z" },
          },
        ],
        total: 1,
      };
    });
    return { jqls, countJqls, statusCategory400Once: () => (reject400 = true) };
  }

  const params = {
    sources: [{ kind: "project", externalId: "PLAT" }],
    cursor: null,
    pageSize: 50,
    excludedStatusCategories: ["Done"],
    excludedStatuses: ["Closed", "Done", "Resolved"],
  };

  it("uses statusCategory exclusion on a supporting instance (TC-009)", async () => {
    const { jqls } = onSearch();
    const result = await harness.hostConnection.sendRequest<SearchResult>("listIssues", params);
    expect(result.items.map((i) => i.externalId)).toEqual(["PROJ-1"]);
    expect(jqls).toHaveLength(1);
    expect(jqls[0]).toContain('statusCategory not in ("Done")');
    expect(jqls[0]).not.toContain("status not in");
  });

  it("retries with status-name exclusion when statusCategory is rejected (TC-037)", async () => {
    const { jqls, statusCategory400Once } = onSearch();
    statusCategory400Once();

    const result = await harness.hostConnection.sendRequest<SearchResult>("listIssues", params);
    expect(result.items.map((i) => i.externalId)).toEqual(["PROJ-1"]);
    // First attempt used the category form (and was rejected); the retry used names.
    expect(jqls).toHaveLength(2);
    expect(jqls[0]).toContain('statusCategory not in ("Done")');
    expect(jqls[1]).toContain('status not in ("Closed", "Done", "Resolved")');
    expect(jqls[1]).not.toContain("statusCategory");
  });

  it("caches the unsupported instance so later polls skip the 400 round-trip (TC-037)", async () => {
    const { jqls, statusCategory400Once } = onSearch();
    statusCategory400Once();

    await harness.hostConnection.sendRequest("listIssues", params);
    await harness.hostConnection.sendRequest("listIssues", params);

    // 2 calls for the first request (category → 400 → names), then exactly one
    // call for the second request (names form built directly, no extra 400).
    expect(jqls).toHaveLength(3);
    expect(jqls[2]).toContain('status not in ("Closed", "Done", "Resolved")');
    expect(jqls[2]).not.toContain("statusCategory");
  });

  it("logs the fallback with no JQL, search term, PAT, or issue content (TC-017, NFR-003)", async () => {
    const infoLogs: unknown[] = [];
    // Replace the harness no-op so we can inspect what the plugin logged.
    harness.hostConnection.onNotification("host.logger.info", (p) => infoLogs.push(p));

    const { statusCategory400Once } = onSearch();
    statusCategory400Once();
    await harness.hostConnection.sendRequest("listIssues", params);

    const serialized = JSON.stringify(infoLogs);
    // The fallback decision is logged, but only with the safe enum.
    expect(serialized).toContain("status-names-fallback");
    // Nothing sensitive leaks: no JQL fragments, no PAT, no issue summaries.
    expect(serialized).not.toContain("statusCategory not in");
    expect(serialized).not.toContain("status not in");
    expect(serialized).not.toContain("test-token");
    expect(serialized).not.toContain("PLAT");
    expect(serialized).not.toContain("PROJ-1");
  });

  it("reports excludedCount from a count-only companion query on the first page (#434)", async () => {
    const { countJqls } = onSearch();

    const result = await harness.hostConnection.sendRequest<SearchResult>("listIssues", params);

    // Unfiltered total 5 minus the filtered page total 1.
    expect(result.excludedCount).toBe(4);
    // Exactly one companion query, with no exclusion clause (it measures the
    // unfiltered set) but the same source scope.
    expect(countJqls).toHaveLength(1);
    expect(countJqls[0]).not.toContain("statusCategory not in");
    expect(countJqls[0]).not.toContain("status not in");
    expect(countJqls[0]).toContain("project = ");
  });

  it("omits excludedCount when no status exclusion is configured (#434)", async () => {
    const { countJqls } = onSearch();

    const result = await harness.hostConnection.sendRequest<SearchResult>("listIssues", {
      sources: [{ kind: "project", externalId: "PLAT" }],
      cursor: null,
      pageSize: 50,
    });

    expect(result.excludedCount).toBeUndefined();
    expect(countJqls).toHaveLength(0);
  });

  it("does not fire the companion query when only the inactive exclusion list is set (#434)", async () => {
    const { countJqls } = onSearch();

    // Category-supported instance excludes by category and ignores the name
    // list, so an empty category list means the main JQL drops nothing.
    const result = await harness.hostConnection.sendRequest<SearchResult>("listIssues", {
      sources: [{ kind: "project", externalId: "PLAT" }],
      cursor: null,
      pageSize: 50,
      excludedStatusCategories: [],
      excludedStatuses: ["Closed", "Done", "Resolved"],
    });

    expect(result.excludedCount).toBeUndefined();
    expect(countJqls).toHaveLength(0);
  });

  it("omits excludedCount on subsequent pages (#434)", async () => {
    const { countJqls } = onSearch();

    const result = await harness.hostConnection.sendRequest<SearchResult>("listIssues", {
      ...params,
      cursor: "50",
    });

    expect(result.excludedCount).toBeUndefined();
    expect(countJqls).toHaveLength(0);
  });

  it("omits excludedCount when the companion count query fails (#434)", async () => {
    // Main page search succeeds; the count-only companion (maxResults 0) errors.
    harness.fetchStub.on("/rest/api/2/search", (init) => {
      const body = JSON.parse(init.body ?? "{}");
      if (body.maxResults === 0) {
        return StubResponse.jiraError(500, "boom");
      }
      return {
        issues: [
          {
            key: "PROJ-1",
            fields: { summary: "x", status: { name: "Open" }, updated: "2026-04-05T00:00:00Z" },
          },
        ],
        total: 1,
      };
    });

    const result = await harness.hostConnection.sendRequest<SearchResult>("listIssues", params);

    expect(result.items.map((i) => i.externalId)).toEqual(["PROJ-1"]);
    expect(result.excludedCount).toBeUndefined();
  });
});
