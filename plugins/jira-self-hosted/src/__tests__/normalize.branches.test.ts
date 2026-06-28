import { describe, expect, it } from "vitest";
import {
  normalizeComment,
  normalizeIssue,
  type JiraCommentResponse,
  type JiraIssueResponse,
} from "../normalize.js";
import type { JiraPluginConfig } from "../config.js";

const defaults: JiraPluginConfig = {
  instance: "https://jira.acme.example",
  blocksLinkTypeName: "blocks",
  isBlockedByLinkTypeName: "is blocked by",
  allowSelfSignedTls: false,
};

describe("normalizeIssue field fallbacks", () => {
  it("fills defaults when fields are entirely absent", () => {
    const normalized = normalizeIssue(defaults, { key: "K-1" }, defaults.instance);
    expect(normalized.title).toBe("K-1");
    expect(normalized.currentState).toBe("Unknown");
    expect(normalized.assignees).toEqual([]);
    expect(normalized.labels).toEqual([]);
    expect(normalized.issueType).toBeNull();
    expect(normalized.blocks).toEqual([]);
    expect(normalized.blockedBy).toEqual([]);
    expect(normalized.body).toBeNull();
    expect(normalized.updatedAt).toBe(new Date(0).toISOString());
  });

  it("derives the assignee externalId from key then name, with an empty displayName fallback", () => {
    const byKey = normalizeIssue(
      defaults,
      { key: "K-2", fields: { assignee: { key: "u-key" } } },
      defaults.instance,
    );
    expect(byKey.assignees).toEqual([{ externalId: "u-key", displayName: "" }]);

    const byName = normalizeIssue(
      defaults,
      { key: "K-3", fields: { assignee: { name: "u-name" } } },
      defaults.instance,
    );
    expect(byName.assignees).toEqual([{ externalId: "u-name", displayName: "" }]);
  });

  it("drops an assignee that carries no identifying field", () => {
    const issue: JiraIssueResponse = { key: "K-4", fields: { assignee: { displayName: "Ghost" } } };
    expect(normalizeIssue(defaults, issue, defaults.instance).assignees).toEqual([]);
  });

  it("treats an empty-string description as no body", () => {
    const issue: JiraIssueResponse = { key: "K-5", fields: { description: "" } };
    expect(normalizeIssue(defaults, issue, defaults.instance).body).toBeNull();
  });

  it("treats an ADF doc that flattens to nothing as no body", () => {
    const issue: JiraIssueResponse = {
      key: "K-6",
      fields: { description: { type: "doc", content: [] } as unknown },
    };
    expect(normalizeIssue(defaults, issue, defaults.instance).body).toBeNull();
  });
});

describe("normalizeComment", () => {
  it("normalizes a fully populated comment", () => {
    const comment: JiraCommentResponse = {
      id: "100",
      author: { accountId: "alice", displayName: "Alice" },
      body: "plain body",
      created: "2026-05-01T00:00:00Z",
      updated: "2026-05-02T00:00:00Z",
    };
    expect(normalizeComment(comment)).toEqual({
      externalId: "100",
      author: { externalId: "alice", displayName: "Alice" },
      body: "plain body",
      createdAt: "2026-05-01T00:00:00Z",
      updatedAt: "2026-05-02T00:00:00Z",
    });
  });

  it("falls back across every absent field for a bare comment", () => {
    const normalized = normalizeComment({});
    expect(normalized.externalId).toBe("");
    expect(normalized.author).toEqual({ externalId: "", displayName: "" });
    expect(normalized.body).toBe("");
    expect(normalized.createdAt).toBe(new Date(0).toISOString());
    expect(normalized.updatedAt).toBe(new Date(0).toISOString());
  });

  it("derives the author externalId from key and inherits updatedAt from created", () => {
    const normalized = normalizeComment({
      id: "7",
      author: { key: "bob" },
      created: "2026-06-01T00:00:00Z",
    });
    expect(normalized.author.externalId).toBe("bob");
    expect(normalized.updatedAt).toBe("2026-06-01T00:00:00Z");
  });
});
