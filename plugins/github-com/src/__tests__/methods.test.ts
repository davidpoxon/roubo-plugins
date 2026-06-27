import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfiguredSource } from "@roubo/plugin-sdk";
import { getAvailableTransitions } from "../methods/get-available-transitions.js";
import { getComments } from "../methods/get-comments.js";
import { getCurrentUser } from "../methods/get-current-user.js";
import { getIssue } from "../methods/get-issue.js";
import { listIssueTypes } from "../methods/list-issue-types.js";
import { listLabels } from "../methods/list-labels.js";
import { resetAlertsRuntime } from "../alerts-runtime.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

let mocks: ReturnType<typeof installMocks>;

beforeEach(() => {
  mocks = installMocks();
});

afterEach(() => {
  teardownMocks();
});

describe("getIssue", () => {
  it("parses externalId, fetches detail, and formats blockedBy/blocks as fully-qualified IDs", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse({
        number: 42,
        title: "the answer",
        body: "body",
        state: "open",
        labels: [{ name: "bug" }],
        created_at: "x",
        updated_at: "x",
        comments: 0,
        html_url: "https://github.com/foo/bar/issues/42",
      }),
    );
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      repository: {
        issue_42: {
          blockedBy: { nodes: [{ number: 7, title: "blocker", state: "OPEN" }] },
          blocking: {
            nodes: [{ number: 99, title: "blocked", state: "OPEN" }],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    });

    const issue = await getIssue({ externalId: "foo/bar#42" });
    expect(issue.externalId).toBe("foo/bar#42");
    expect(issue.title).toBe("the answer");
    expect(issue.currentState).toBe("open");
    expect(issue.allowedTransitions).toEqual(["close"]);
    expect(issue.blockedBy).toEqual(["foo/bar#7"]);
    expect(issue.blocks).toEqual(["foo/bar#99"]);
  });

  it("throws on a malformed externalId without contacting GitHub", async () => {
    await expect(getIssue({ externalId: "no-slash-no-hash" })).rejects.toThrow(/externalId/);
    expect(mocks.mockOctokit.request).not.toHaveBeenCalled();
  });
});

describe("getIssue (security alerts)", () => {
  beforeEach(() => {
    resetAlertsRuntime();
  });

  it("fetches a code-scanning alert as a redacted NormalizedIssue", async () => {
    mocks.mockHost.fetch.mockImplementation(async (url: string) => {
      expect(url).toBe("https://api.github.com/repos/foo/bar/code-scanning/alerts/117");
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          number: 117,
          html_url: "https://github.com/foo/bar/security/code-scanning/117",
          state: "open",
          created_at: "t",
          rule: { id: "js/x", description: "Bad thing", security_severity_level: "high" },
        }),
      };
    });

    const issue = await getIssue({ externalId: "foo/bar#code-scanning-117" });
    expect(issue.externalId).toBe("foo/bar#code-scanning-117");
    expect(issue.issueType).toBe("security-code-scanning");
    expect(issue.title).toBe("Bad thing");
    expect(issue.allowedTransitions).toEqual([]);
    expect(mocks.mockOctokit.request).not.toHaveBeenCalled();
  });

  it("never exposes the literal secret for a secret-scanning alert", async () => {
    const literal = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    mocks.mockHost.fetch.mockImplementation(async (url: string) => {
      expect(url).toBe("https://api.github.com/repos/foo/bar/secret-scanning/alerts/42");
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          number: 42,
          html_url: "u",
          state: "open",
          created_at: "t",
          secret_type_display_name: "GitHub PAT",
          secret: literal,
        }),
      };
    });

    const issue = await getIssue({ externalId: "foo/bar#secret-scanning-42" });
    expect(issue.issueType).toBe("security-secret-scanning");
    expect(JSON.stringify(issue.raw)).not.toContain(literal);
  });

  it("propagates a status-bearing error when the alert fetch fails", async () => {
    mocks.mockHost.fetch.mockImplementation(async () => ({
      status: 403,
      headers: {},
      body: "",
    }));
    await expect(getIssue({ externalId: "foo/bar#dependabot-7" })).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("getComments", () => {
  it("maps raw GitHub comments to NormalizedComment shape", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse([
        {
          id: 1001,
          body: "hello",
          user: { login: "alice" },
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-02T00:00:00Z",
        },
        {
          id: 1002,
          body: null,
          user: null,
          created_at: "2024-01-03T00:00:00Z",
        },
      ]),
    );

    const comments = await getComments({ externalId: "foo/bar#10" });
    expect(comments).toHaveLength(2);
    expect(comments[0]).toEqual({
      externalId: "1001",
      author: { externalId: "alice", displayName: "alice" },
      body: "hello",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-02T00:00:00Z",
    });
    // Missing user defaults to "unknown"; missing updated_at falls back to createdAt.
    expect(comments[1].author.externalId).toBe("unknown");
    expect(comments[1].body).toBe("");
    expect(comments[1].updatedAt).toBe("2024-01-03T00:00:00Z");
  });
});

describe("getAvailableTransitions", () => {
  function mockIssueDetailWithState(state: string): void {
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse({
        number: 1,
        title: "t",
        body: null,
        state,
        labels: [],
        created_at: "x",
        updated_at: "x",
        comments: 0,
        html_url: "u",
      }),
    );
  }

  it("returns ['close'] for an open issue", async () => {
    mockIssueDetailWithState("open");
    expect(await getAvailableTransitions({ externalId: "foo/bar#1" })).toEqual(["close"]);
  });

  it("returns ['reopen'] for a closed issue", async () => {
    mockIssueDetailWithState("closed");
    expect(await getAvailableTransitions({ externalId: "foo/bar#1" })).toEqual(["reopen"]);
  });

  it("defaults to ['close'] when GitHub omits the state field", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse({
        number: 1,
        title: "t",
        body: null,
        labels: [],
        created_at: "x",
        updated_at: "x",
        comments: 0,
        html_url: "u",
      }),
    );
    expect(await getAvailableTransitions({ externalId: "foo/bar#1" })).toEqual(["close"]);
  });
});

describe("getCurrentUser", () => {
  it("uses GitHub `name` when present", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse({ id: 1, login: "alice", name: "Alice Example" }),
    );
    expect(await getCurrentUser()).toEqual({
      externalId: "alice",
      displayName: "Alice Example",
    });
  });

  it("falls back to login when name is null", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse({ id: 1, login: "alice", name: null }),
    );
    expect(await getCurrentUser()).toEqual({ externalId: "alice", displayName: "alice" });
  });

  it("falls back to login when name is the empty string", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse({ id: 1, login: "alice", name: "" }),
    );
    expect(await getCurrentUser()).toEqual({ externalId: "alice", displayName: "alice" });
  });
});

const REPO_SOURCES: ConfiguredSource[] = [{ kind: "repo", externalId: "foo/bar" }];
const PROJECT_SOURCES: ConfiguredSource[] = [{ kind: "project", externalId: "foo/#1" }];

describe("listLabels", () => {
  it("returns label names for a repo source", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([{ name: "bug" }, { name: "p1" }]));

    expect(await listLabels({ sources: REPO_SOURCES })).toEqual(["bug", "p1"]);
  });

  it("returns [] for a project source without contacting GitHub", async () => {
    expect(await listLabels({ sources: PROJECT_SOURCES })).toEqual([]);
    expect(mocks.mockOctokit.request).not.toHaveBeenCalled();
  });
});

describe("listIssueTypes", () => {
  it("returns enabled issue types mapped to {id, name} for a repo source", async () => {
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      repository: {
        issueTypes: {
          nodes: [
            { id: "T_1", name: "Bug", isEnabled: true },
            { id: "T_2", name: "Feature", isEnabled: true },
            { id: "T_3", name: "Disabled", isEnabled: false },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    });

    expect(await listIssueTypes({ sources: REPO_SOURCES })).toEqual([
      { id: "T_1", name: "Bug" },
      { id: "T_2", name: "Feature" },
    ]);
  });

  it("returns [] when the repo has no configured issue types", async () => {
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      repository: {
        issueTypes: { nodes: [], pageInfo: { hasNextPage: false } },
      },
    });

    expect(await listIssueTypes({ sources: REPO_SOURCES })).toEqual([]);
  });

  it("returns [] for a project source without contacting GitHub", async () => {
    expect(await listIssueTypes({ sources: PROJECT_SOURCES })).toEqual([]);
    expect(mocks.mockOctokit.graphql).not.toHaveBeenCalled();
  });
});
