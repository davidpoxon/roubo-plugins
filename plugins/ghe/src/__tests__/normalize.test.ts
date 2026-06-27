import { describe, expect, it } from "vitest";
import {
  flattenBlockers,
  openBlocks,
  projectNodeToNormalizedIssue,
  rawToNormalizedComment,
  rawToNormalizedIssue,
} from "../normalize.js";
import type { BlockedByNode, BlockingNode, ProjectV2Data, RawIssue } from "../types.js";

describe("normalize", () => {
  describe("rawToNormalizedIssue", () => {
    it("maps a minimal open issue to NormalizedIssue with close transition", () => {
      const raw: RawIssue = {
        number: 42,
        title: "Bug: oops",
        body: "details",
        state: "open",
        labels: ["bug", { name: "p1" }],
        assignee: { login: "alice" },
        type: { name: "Bug" },
        created_at: "2026-05-01T00:00:00Z",
        updated_at: "2026-05-02T00:00:00Z",
        comments: 3,
        html_url: "https://github.com/foo/bar/issues/42",
      };
      const issue = rawToNormalizedIssue(raw);
      expect(issue.externalId).toBe("42");
      expect(issue.title).toBe("Bug: oops");
      expect(issue.body).toBe("details");
      expect(issue.currentState).toBe("open");
      expect(issue.allowedTransitions).toEqual(["close"]);
      expect(issue.labels).toEqual(["bug", "p1"]);
      expect(issue.assignees).toEqual([{ externalId: "alice", displayName: "alice" }]);
      expect(issue.issueType).toBe("Bug");
      expect(issue.blocks).toEqual([]);
      expect(issue.blockedBy).toEqual([]);
      expect(issue.externalUrl).toBe(raw.html_url);
      expect(issue.updatedAt).toBe("2026-05-02T00:00:00Z");
    });

    it("yields reopen as the only transition for a closed issue", () => {
      const raw: RawIssue = {
        number: 1,
        title: "Done",
        state: "closed",
        created_at: "x",
        updated_at: "x",
        html_url: "https://github.com/foo/bar/issues/1",
      };
      expect(rawToNormalizedIssue(raw).allowedTransitions).toEqual(["reopen"]);
    });

    it("passes through blockedBy / blocks supplied by the caller", () => {
      const raw: RawIssue = {
        number: 5,
        title: "t",
        state: "open",
        created_at: "x",
        updated_at: "x",
        html_url: "u",
      };
      const issue = rawToNormalizedIssue(raw, { blockedBy: ["foo/bar#1"], blocks: ["foo/bar#9"] });
      expect(issue.blockedBy).toEqual(["foo/bar#1"]);
      expect(issue.blocks).toEqual(["foo/bar#9"]);
    });
  });

  describe("rawToNormalizedComment", () => {
    it("falls back to created_at when updated_at is missing", () => {
      const c = rawToNormalizedComment({
        id: 7,
        body: "hi",
        user: { login: "bob" },
        created_at: "2026-05-01T00:00:00Z",
      });
      expect(c.externalId).toBe("7");
      expect(c.author).toEqual({ externalId: "bob", displayName: "bob" });
      expect(c.createdAt).toBe("2026-05-01T00:00:00Z");
      expect(c.updatedAt).toBe("2026-05-01T00:00:00Z");
    });
  });

  describe("flattenBlockers", () => {
    it("walks up to depth 3 and skips closed/cycles", () => {
      const cycleA: BlockedByNode = { number: 1, title: "A", state: "OPEN" };
      const cycleB: BlockedByNode = {
        number: 2,
        title: "B",
        state: "OPEN",
        blockedBy: { nodes: [cycleA] },
      };
      cycleA.blockedBy = { nodes: [cycleB] };
      const closed: BlockedByNode = { number: 3, title: "C", state: "CLOSED" };
      const result = flattenBlockers([cycleA, closed], 3, new Set());
      expect(result.map((r) => r.number)).toEqual([1, 2]);
    });
  });

  describe("openBlocks", () => {
    it("returns only OPEN nodes", () => {
      const nodes: BlockingNode[] = [
        { number: 1, title: "a", state: "OPEN" },
        { number: 2, title: "b", state: "CLOSED" },
        { number: 3, title: "c", state: "OPEN" },
      ];
      expect(openBlocks(nodes).map((n) => n.number)).toEqual([1, 3]);
    });
  });

  describe("projectNodeToNormalizedIssue", () => {
    it("returns null for non-issue content", () => {
      const node: ProjectV2Data["items"]["nodes"][number] = {
        content: { __typename: "PullRequest", number: 1 },
        fieldValueByName: null,
      };
      expect(projectNodeToNormalizedIssue(node, "foo/bar")).toBeNull();
    });

    it("falls back to the supplied repo when content omits one", () => {
      const node: ProjectV2Data["items"]["nodes"][number] = {
        content: {
          __typename: "Issue",
          number: 17,
          title: "T",
          body: "B",
          state: "OPEN",
          labels: { nodes: [{ name: "x" }] },
          assignees: { nodes: [{ login: "u" }] },
          milestone: null,
          issueType: { name: "Task" },
          createdAt: "2026-05-01T00:00:00Z",
          updatedAt: "2026-05-02T00:00:00Z",
          comments: { totalCount: 0 },
        },
        fieldValueByName: { name: "In progress" },
      };
      const result = projectNodeToNormalizedIssue(node, "foo/bar");
      if (!result) throw new Error("projectNodeToNormalizedIssue returned null");
      expect(result.externalId).toBe("17");
      expect(result.externalUrl).toBe("https://github.com/foo/bar/issues/17");
      expect(result.currentState).toBe("open");
      expect(result.issueType).toBe("Task");
    });
  });
});
