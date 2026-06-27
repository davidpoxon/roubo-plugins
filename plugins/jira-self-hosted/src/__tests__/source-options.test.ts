import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JiraRequestContext } from "../jira-client.js";
import {
  SOURCE_OPTIONS_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  getSourceOptions,
} from "../source-options.js";
import { installHostHarness, type HostHarness } from "./helpers/host-stub.js";

const ctx: JiraRequestContext = { instance: "https://jira.acme.example", pat: "tok" };

describe("getSourceOptions (jira-self-hosted, WU-002)", () => {
  let harness: HostHarness;

  beforeEach(() => {
    harness = installHostHarness();
  });
  afterEach(() => harness.dispose());

  describe("cursor encode/decode", () => {
    it("round-trips a single-stream cursor", () => {
      expect(decodeCursor(encodeCursor({ startAt: 50 }))).toEqual({ startAt: 50 });
    });

    it("round-trips a per-project board cursor", () => {
      const state = { perProject: { AAA: 25, BBB: 0 } };
      expect(decodeCursor(encodeCursor(state))).toEqual(state);
    });

    it("decodes null / empty / malformed cursors to an empty state (no unbounded scan)", () => {
      expect(decodeCursor(null)).toEqual({});
      expect(decodeCursor("")).toEqual({});
      expect(decodeCursor("!!!not-base64-json")).toEqual({});
    });
  });

  describe("project category", () => {
    it("lists projects via /rest/api/2/project (not the Cloud /search resource) and filters client-side", async () => {
      // Jira Data Center 404s on `/project/search` (it parses `search` as a
      // project key, #468). The loader must hit the plain `/rest/api/2/project`
      // list endpoint with no server-side query/pagination params, then filter
      // and sort client-side. Match is case-insensitive over key OR name.
      let seenPath = "";
      let seenSearch = "";
      harness.fetchStub.on("/rest/api/2/project", (_init, url) => {
        const u = new URL(url);
        seenPath = u.pathname;
        seenSearch = u.search;
        // Returned unsorted to prove the loader sorts by name.
        return [
          { key: "PLAT", name: "Platform" },
          { key: "ZED", name: "Payroll" }, // matches "pay" by name only
          { key: "PAY", name: "Payments" }, // matches "pay" by key
          { key: "BILL", name: "Billing" }, // no match
        ];
      });

      const page = await getSourceOptions(ctx, { category: "project", search: "pay" });

      expect(seenPath).toBe("/rest/api/2/project");
      expect(seenSearch).toBe("");
      // Only the two matches, sorted by name ("Payments" < "Payroll").
      expect(page.items).toEqual([
        { externalId: "PAY", label: "Payments", sublabel: "PAY", icon: "project" },
        { externalId: "ZED", label: "Payroll", sublabel: "ZED", icon: "project" },
      ]);
      expect(page.nextCursor).toBeNull();
    });

    it("paginates client-side with no dropped or duplicated rows (NFR-004)", async () => {
      const projects = Array.from({ length: SOURCE_OPTIONS_PAGE_SIZE + 5 }, (_, i) => ({
        key: `P${String(i).padStart(2, "0")}`,
        name: `Project ${String(i).padStart(2, "0")}`,
      }));
      harness.fetchStub.on("/rest/api/2/project", () => projects);

      const page1 = await getSourceOptions(ctx, { category: "project" });
      expect(page1.items).toHaveLength(SOURCE_OPTIONS_PAGE_SIZE);
      expect(page1.items[0].externalId).toBe("P00");
      expect(decodeCursor(page1.nextCursor)).toEqual({ startAt: SOURCE_OPTIONS_PAGE_SIZE });

      const page2 = await getSourceOptions(ctx, {
        category: "project",
        cursor: page1.nextCursor,
      });
      expect(page2.items).toHaveLength(5);
      expect(page2.nextCursor).toBeNull();

      const all = [...page1.items, ...page2.items].map((i) => i.externalId);
      expect(new Set(all).size).toBe(all.length); // no duplicates
      expect(all).toHaveLength(SOURCE_OPTIONS_PAGE_SIZE + 5); // no drops
    });

    it("returns an empty page when nothing matches the search term", async () => {
      harness.fetchStub.on("/rest/api/2/project", () => [{ key: "PLAT", name: "Platform" }]);
      const page = await getSourceOptions(ctx, { category: "project", search: "zzz" });
      expect(page).toEqual({ items: [], nextCursor: null });
    });

    it("skips entries without a string key", async () => {
      harness.fetchStub.on("/rest/api/2/project", () => [
        { name: "No key" },
        { key: "OK", name: "Okay" },
      ]);
      const page = await getSourceOptions(ctx, { category: "project" });
      expect(page.items).toEqual([
        { externalId: "OK", label: "Okay", sublabel: "OK", icon: "project" },
      ]);
    });
  });

  describe("filter category", () => {
    it("lists the user's favourite filters via /filter/favourite (not the Cloud /filter/search resource) and maps owner into the sublabel", async () => {
      // Jira Data Center 404s on `/rest/api/2/filter/search` (Cloud-only, #469).
      // The loader must hit `/rest/api/2/filter/favourite` (a bare array, no
      // server query/pagination) and filter + sort by name client-side.
      let seenPath = "";
      let seenSearch = "";
      let searchCalled = false;
      harness.fetchStub.on("/rest/api/2/filter/search", () => {
        searchCalled = true;
        return { values: [] };
      });
      harness.fetchStub.on("/rest/api/2/filter/favourite", (_init, url) => {
        const u = new URL(url);
        seenPath = u.pathname;
        seenSearch = u.search;
        // Returned unsorted to prove the loader sorts by name; "My team" is
        // filtered out by the "open" search term.
        return [
          { id: 10232, name: "My team" },
          { id: 10231, name: "Open bugs", owner: { displayName: "Anna" } },
        ];
      });

      const page = await getSourceOptions(ctx, {
        category: "filter",
        scope: { project: ["PLAT"] },
        search: "open",
      });

      expect(searchCalled).toBe(false);
      expect(seenPath).toBe("/rest/api/2/filter/favourite");
      expect(seenSearch).toBe("");
      expect(page.items).toEqual([
        {
          externalId: "10231",
          label: "Open bugs",
          sublabel: "Anna · filter #10231",
          icon: "filter",
        },
      ]);
      expect(page.nextCursor).toBeNull();
    });

    it("paginates favourites client-side with no dropped or duplicated rows (NFR-004)", async () => {
      const favourites = Array.from({ length: SOURCE_OPTIONS_PAGE_SIZE + 3 }, (_, i) => ({
        id: 20000 + i,
        name: `Filter ${String(i).padStart(2, "0")}`,
      }));
      harness.fetchStub.on("/rest/api/2/filter/favourite", () => favourites);

      const page1 = await getSourceOptions(ctx, {
        category: "filter",
        scope: { project: ["PLAT"] },
      });
      expect(page1.items).toHaveLength(SOURCE_OPTIONS_PAGE_SIZE);
      expect(decodeCursor(page1.nextCursor)).toEqual({ startAt: SOURCE_OPTIONS_PAGE_SIZE });

      const page2 = await getSourceOptions(ctx, {
        category: "filter",
        scope: { project: ["PLAT"] },
        cursor: page1.nextCursor,
      });
      expect(page2.items).toHaveLength(3);
      expect(page2.nextCursor).toBeNull();

      const all = [...page1.items, ...page2.items].map((i) => i.externalId);
      expect(new Set(all).size).toBe(all.length); // no duplicates
      expect(all).toHaveLength(SOURCE_OPTIONS_PAGE_SIZE + 3); // no drops
    });

    it("returns an empty page when no project scope is selected (cascade gate)", async () => {
      const page = await getSourceOptions(ctx, { category: "filter", search: "x" });
      expect(page).toEqual({ items: [], nextCursor: null });
    });
  });

  describe("epic category", () => {
    it("builds a scoped, escaped, uncapped epic search and paginates past the first page", async () => {
      const bodies: Array<Record<string, unknown>> = [];
      harness.fetchStub.on("/rest/api/2/search", (init) => {
        const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        bodies.push(body);
        const startAt = Number(body.startAt ?? 0);
        if (startAt === 0) {
          return {
            issues: [
              { key: "PLAT-1", fields: { summary: "Alpha" } },
              { key: "PLAT-2", fields: { summary: "Beta" } },
            ],
            total: 4,
          };
        }
        return {
          issues: [
            { key: "PLAT-3", fields: { summary: "Gamma" } },
            { key: "PLAT-4", fields: { summary: "Delta" } },
          ],
          total: 4,
        };
      });

      const page1 = await getSourceOptions(ctx, {
        category: "epic",
        scope: { project: ["PLAT"] },
        search: 'a" OR x~*',
      });

      const jql = String(bodies[0].jql);
      expect(jql).toContain("project in (PLAT)");
      expect(jql).toContain("issuetype = Epic");
      expect(jql).toContain("resolution = Unresolved");
      // The crafted term is neutralized: the quote is escaped and the ~ / *
      // operators are stripped, so it cannot break out of the quoted literal.
      expect(jql).toContain('summary ~ "a\\" OR x"');
      expect(jql).not.toContain("~*");
      // No 50-item cap: the page requests the WU-002 page size.
      expect(bodies[0].maxResults).toBe(SOURCE_OPTIONS_PAGE_SIZE);
      expect(page1.items.map((i) => i.externalId)).toEqual(["PLAT-1", "PLAT-2"]);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await getSourceOptions(ctx, {
        category: "epic",
        scope: { project: ["PLAT"] },
        search: 'a" OR x~*',
        cursor: page1.nextCursor,
      });
      // Later page returns distinct epics; the union of pages is the full set
      // with no duplicates (TC-034 / NFR-004).
      expect(page2.items.map((i) => i.externalId)).toEqual(["PLAT-3", "PLAT-4"]);
      expect(page2.nextCursor).toBeNull();
      const all = [...page1.items, ...page2.items].map((i) => i.externalId);
      expect(new Set(all).size).toBe(all.length);
    });

    it("omits the summary clause when the term cleans down to nothing", async () => {
      let jql = "";
      harness.fetchStub.on("/rest/api/2/search", (init) => {
        jql = String((JSON.parse(init.body ?? "{}") as { jql?: string }).jql);
        return { issues: [], total: 0 };
      });
      await getSourceOptions(ctx, {
        category: "epic",
        scope: { project: ["PLAT"] },
        search: "~*?",
      });
      expect(jql).not.toContain("summary ~");
    });

    it("a crafted term cannot inject a JQL clause (TC-033, NFR-003)", async () => {
      let jql = "";
      harness.fetchStub.on("/rest/api/2/search", (init) => {
        jql = String((JSON.parse(init.body ?? "{}") as { jql?: string }).jql);
        return { issues: [], total: 0 };
      });
      await getSourceOptions(ctx, {
        category: "epic",
        scope: { project: ["PLAT"] },
        search: '" OR project = ADMIN --',
      });
      // The scope is unchanged: still bound to PLAT, never widened to ADMIN.
      expect(jql).toContain("project in (PLAT)");
      // The whole crafted term stays inside one quoted summary literal: the
      // leading quote is escaped to `\"` so it cannot close the literal early,
      // and the `--` comment hazard is stripped. The `OR project = ADMIN` text
      // survives only as harmless search content, never as its own clause.
      expect(jql).toContain('summary ~ "\\" OR project = ADMIN"');
      expect(jql).not.toContain("--");
    });
  });

  describe("board category", () => {
    it("fans out per scoped project and pages each stream without dropping or duplicating", async () => {
      const requested: Array<{ key: string | null; startAt: string | null }> = [];
      harness.fetchStub.on("/rest/agile/1.0/board", (_init, url) => {
        const u = new URL(url);
        const key = u.searchParams.get("projectKeyOrId");
        const startAt = u.searchParams.get("startAt");
        requested.push({ key, startAt });
        if (key === "AAA" && startAt === "0") {
          return { values: [{ id: 1, name: "Alpha", type: "scrum" }], total: 2, isLast: false };
        }
        if (key === "AAA") {
          return { values: [{ id: 2, name: "Beta", type: "scrum" }], total: 2, isLast: true };
        }
        return { values: [{ id: 9, name: "Gamma", type: "kanban" }], total: 1, isLast: true };
      });

      const page1 = await getSourceOptions(ctx, {
        category: "board",
        scope: { project: ["AAA", "BBB"] },
      });
      expect(page1.items).toEqual([
        {
          externalId: "board:1",
          label: "Alpha",
          sublabel: "AAA · board #1 · scrum",
          icon: "board",
        },
        {
          externalId: "board:9",
          label: "Gamma",
          sublabel: "BBB · board #9 · kanban",
          icon: "board",
        },
      ]);
      // Only AAA has more; the cursor continues just that stream.
      expect(decodeCursor(page1.nextCursor)).toEqual({ perProject: { AAA: 1 } });

      const page2 = await getSourceOptions(ctx, {
        category: "board",
        scope: { project: ["AAA", "BBB"] },
        cursor: page1.nextCursor,
      });
      expect(page2.items).toEqual([
        { externalId: "board:2", label: "Beta", sublabel: "AAA · board #2 · scrum", icon: "board" },
      ]);
      expect(page2.nextCursor).toBeNull();

      // BBB was exhausted on page 1 and never re-requested on page 2.
      const bbbRequests = requested.filter((r) => r.key === "BBB");
      expect(bbbRequests).toHaveLength(1);
      const all = [...page1.items, ...page2.items].map((i) => i.externalId);
      expect(new Set(all)).toEqual(new Set(["board:1", "board:9", "board:2"]));
    });

    it("returns an empty page when no project scope is selected", async () => {
      const page = await getSourceOptions(ctx, { category: "board" });
      expect(page).toEqual({ items: [], nextCursor: null });
    });
  });

  it("rejects a malformed project key rather than escaping it", async () => {
    await expect(
      getSourceOptions(ctx, { category: "board", scope: { project: ["bad-key"] } }),
    ).rejects.toThrow(/Invalid Jira project key/);
  });
});
