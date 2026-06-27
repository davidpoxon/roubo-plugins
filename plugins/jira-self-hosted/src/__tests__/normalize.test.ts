import { describe, expect, it } from "vitest";
import { mapLinkType } from "../link-types.js";
import { normalizeIssue, type JiraIssueResponse } from "../normalize.js";
import type { JiraPluginConfig } from "../config.js";

const defaults: JiraPluginConfig = {
  instance: "https://jira.acme.example",
  blocksLinkTypeName: "blocks",
  isBlockedByLinkTypeName: "is blocked by",
};

describe("link-types (TC-029)", () => {
  it("maps a 'Blocks' outwardIssue to NormalizedIssue.blocks", () => {
    const mapped = mapLinkType(defaults, {
      type: { name: "Blocks", outward: "blocks", inward: "is blocked by" },
      outwardIssue: { key: "PROJ-201" },
    });
    expect(mapped).toEqual({ kind: "blocks", externalId: "PROJ-201" });
  });

  it("maps a 'Blocks' inwardIssue to NormalizedIssue.blockedBy", () => {
    const mapped = mapLinkType(defaults, {
      type: { name: "Blocks", outward: "blocks", inward: "is blocked by" },
      inwardIssue: { key: "PROJ-200" },
    });
    expect(mapped).toEqual({ kind: "blockedBy", externalId: "PROJ-200" });
  });

  it("ignores unrelated link types", () => {
    expect(
      mapLinkType(defaults, {
        type: { name: "Relates", outward: "relates to", inward: "relates to" },
        outwardIssue: { key: "PROJ-300" },
      }),
    ).toBeNull();
  });

  it("matches the real-world TEST 'Blocks' payload shape", () => {
    const mapped = mapLinkType(defaults, {
      type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
      outwardIssue: { key: "TEST-3800" },
    });
    expect(mapped).toEqual({ kind: "blocks", externalId: "TEST-3800" });
  });

  it("normalizes blocks/blockedBy across an issue payload", () => {
    const issue: JiraIssueResponse = {
      key: "PROJ-200",
      fields: {
        summary: "Test issue",
        issuelinks: [
          {
            type: { name: "Blocks", outward: "blocks", inward: "is blocked by" },
            outwardIssue: { key: "PROJ-201" },
          },
          {
            type: { name: "Blocks", outward: "blocks", inward: "is blocked by" },
            inwardIssue: { key: "PROJ-199" },
          },
          {
            type: { name: "Relates", outward: "relates to", inward: "relates to" },
            outwardIssue: { key: "PROJ-202" },
          },
        ],
        status: { name: "Open" },
        updated: "2026-04-01T00:00:00Z",
      },
    };
    const normalized = normalizeIssue(defaults, issue, defaults.instance);
    expect(normalized.blocks).toEqual(["PROJ-201"]);
    expect(normalized.blockedBy).toEqual(["PROJ-199"]);
    expect(normalized.externalUrl).toBe("https://jira.acme.example/browse/PROJ-200");
  });
});

describe("link-types (TC-072) honour configured rename", () => {
  it("treats a configured 'depends on' rename as the blocks relationship", () => {
    const renamed: JiraPluginConfig = {
      ...defaults,
      blocksLinkTypeName: "depends on",
      isBlockedByLinkTypeName: "is depended on by",
    };
    const blocks = mapLinkType(renamed, {
      type: { name: "Dependency", outward: "depends on", inward: "is depended on by" },
      outwardIssue: { key: "PROJ-500" },
    });
    expect(blocks).toEqual({ kind: "blocks", externalId: "PROJ-500" });

    const blockedBy = mapLinkType(renamed, {
      type: { name: "Dependency", outward: "depends on", inward: "is depended on by" },
      inwardIssue: { key: "PROJ-501" },
    });
    expect(blockedBy).toEqual({ kind: "blockedBy", externalId: "PROJ-501" });

    // The standard Blocks link type is no longer recognised once the user has
    // overridden the names to a different link type.
    expect(
      mapLinkType(renamed, {
        type: { name: "Blocks", outward: "blocks", inward: "is blocked by" },
        outwardIssue: { key: "X" },
      }),
    ).toBeNull();
  });
});

describe("normalizeIssue body + assignee", () => {
  it("flattens ADF descriptions and surfaces assignees", () => {
    const issue: JiraIssueResponse = {
      key: "PROJ-9",
      fields: {
        summary: "ADF body",
        description: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "hello world" }],
            },
          ],
        } as unknown as JiraIssueResponse["fields"] extends infer T ? T : never,
        status: { name: "In Progress" },
        assignee: { accountId: "alice", displayName: "Alice" },
        labels: ["a", "b"],
        issuetype: { name: "Story" },
        updated: "2026-05-01T12:00:00Z",
      },
      transitions: [
        { id: "21", name: "Done" },
        { id: "11", name: "Review" },
      ],
    };
    const normalized = normalizeIssue(defaults, issue, defaults.instance);
    expect(normalized.body).toBe("hello world");
    expect(normalized.assignees).toEqual([{ externalId: "alice", displayName: "Alice" }]);
    expect(normalized.allowedTransitions).toEqual(["Done", "Review"]);
    expect(normalized.labels).toEqual(["a", "b"]);
    expect(normalized.issueType).toBe("Story");
  });
});
