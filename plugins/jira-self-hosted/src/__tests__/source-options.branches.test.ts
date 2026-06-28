import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JiraRequestContext } from "../jira-client.js";
import { SOURCE_OPTIONS_PAGE_SIZE, decodeCursor, getSourceOptions } from "../source-options.js";
import { installHostHarness, type HostHarness } from "./helpers/host-stub.js";

const ctx: JiraRequestContext = { instance: "https://jira.acme.example", pat: "tok" };

describe("getSourceOptions fallback branches", () => {
  let harness: HostHarness;
  beforeEach(() => {
    harness = installHostHarness();
  });
  afterEach(() => harness.dispose());

  it("returns an empty page for an unrecognised category", async () => {
    const page = await getSourceOptions(ctx, {
      category: "bogus" as never,
    });
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  describe("project category fallbacks", () => {
    it("treats a non-array project response as empty", async () => {
      harness.fetchStub.on("/rest/api/2/project", () => ({ unexpected: "shape" }));
      const page = await getSourceOptions(ctx, { category: "project" });
      expect(page).toEqual({ items: [], nextCursor: null });
    });

    it("labels and sorts nameless projects by key", async () => {
      harness.fetchStub.on("/rest/api/2/project", () => [{ key: "BBB" }, { key: "AAA" }]);
      const page = await getSourceOptions(ctx, { category: "project" });
      expect(page.items).toEqual([
        { externalId: "AAA", label: "AAA", sublabel: "AAA", icon: "project" },
        { externalId: "BBB", label: "BBB", sublabel: "BBB", icon: "project" },
      ]);
    });
  });

  describe("board category fallbacks", () => {
    it("skips boards with no id and fills name/type defaults; omits an empty search term", async () => {
      let seenName: string | null = "unset";
      harness.fetchStub.on("/rest/agile/1.0/board", (_init, url) => {
        seenName = new URL(url).searchParams.get("name");
        return {
          values: [
            { name: "no id" }, // dropped: no id
            { id: 7 }, // no name, no type
          ],
          isLast: true,
        };
      });
      const page = await getSourceOptions(ctx, {
        category: "board",
        scope: { project: ["AAA"] },
      });
      // No `name` query param is sent when the search term is empty/undefined.
      expect(seenName).toBeNull();
      expect(page.items).toEqual([
        { externalId: "board:7", label: "Board 7", sublabel: "AAA · board #7", icon: "board" },
      ]);
      expect(page.nextCursor).toBeNull();
    });

    it("treats a board response with no values array as an empty stream", async () => {
      harness.fetchStub.on("/rest/agile/1.0/board", () => ({ isLast: true }));
      const page = await getSourceOptions(ctx, {
        category: "board",
        scope: { project: ["AAA"] },
      });
      expect(page).toEqual({ items: [], nextCursor: null });
    });

    it("uses the short-page heuristic to continue when neither total nor isLast is present", async () => {
      const full = Array.from({ length: SOURCE_OPTIONS_PAGE_SIZE }, (_, i) => ({
        id: i + 1,
        name: `B${i}`,
      }));
      let calls = 0;
      harness.fetchStub.on("/rest/agile/1.0/board", () => {
        calls += 1;
        // First page is exactly full (no total/isLast) -> heuristic continues.
        // Second page is short -> heuristic stops.
        return calls === 1 ? { values: full } : { values: [{ id: 99, name: "last" }] };
      });
      const page1 = await getSourceOptions(ctx, {
        category: "board",
        scope: { project: ["AAA"] },
      });
      expect(page1.items).toHaveLength(SOURCE_OPTIONS_PAGE_SIZE);
      expect(decodeCursor(page1.nextCursor)).toEqual({
        perProject: { AAA: SOURCE_OPTIONS_PAGE_SIZE },
      });

      const page2 = await getSourceOptions(ctx, {
        category: "board",
        scope: { project: ["AAA"] },
        cursor: page1.nextCursor,
      });
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();
    });
  });

  describe("filter category fallbacks", () => {
    it("treats a non-array favourites response as empty", async () => {
      harness.fetchStub.on("/rest/api/2/filter/favourite", () => ({ nope: true }));
      const page = await getSourceOptions(ctx, {
        category: "filter",
        scope: { project: ["PLAT"] },
      });
      expect(page).toEqual({ items: [], nextCursor: null });
    });

    it("labels nameless / ownerless favourites with id-based defaults", async () => {
      harness.fetchStub.on("/rest/api/2/filter/favourite", () => [{ id: 42 }]);
      const page = await getSourceOptions(ctx, {
        category: "filter",
        scope: { project: ["PLAT"] },
      });
      expect(page.items).toEqual([
        { externalId: "42", label: "Filter 42", sublabel: "filter #42", icon: "filter" },
      ]);
    });
  });

  describe("epic category fallbacks", () => {
    it("returns an empty page when no project scope is selected", async () => {
      const page = await getSourceOptions(ctx, { category: "epic" });
      expect(page).toEqual({ items: [], nextCursor: null });
    });

    it("handles a missing search term, a missing issues array, and summaryless issues", async () => {
      const seen: Array<Record<string, unknown>> = [];
      let calls = 0;
      harness.fetchStub.on("/rest/api/2/search", (init) => {
        seen.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
        calls += 1;
        // First call: no `issues` key at all -> treated as empty.
        if (calls === 1) return { total: 0 };
        return { issues: [{ key: "PLAT-5" }] }; // summaryless issue
      });

      const empty = await getSourceOptions(ctx, {
        category: "epic",
        scope: { project: ["PLAT"] },
      });
      // No search term provided -> no `summary ~` clause.
      expect(String(seen[0].jql)).not.toContain("summary ~");
      expect(empty).toEqual({ items: [], nextCursor: null });

      const withIssue = await getSourceOptions(ctx, {
        category: "epic",
        scope: { project: ["PLAT"] },
      });
      expect(withIssue.items).toEqual([
        { externalId: "PLAT-5", label: "PLAT-5", sublabel: "PLAT-5", icon: "epic" },
      ]);
    });
  });
});
