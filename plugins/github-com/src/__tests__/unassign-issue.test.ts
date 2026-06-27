import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unassignIssue } from "../methods/unassign-issue.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

let mocks: ReturnType<typeof installMocks>;

function mockIssueDetail(assignees: Array<{ login: string } | null> | null | undefined): void {
  mocks.mockOctokit.request.mockResolvedValueOnce(
    okResponse({
      number: 42,
      title: "t",
      body: null,
      state: "open",
      labels: [],
      assignees,
      created_at: "x",
      updated_at: "x",
      comments: 0,
      html_url: "u",
    }),
  );
}

beforeEach(() => {
  mocks = installMocks();
});

afterEach(() => {
  teardownMocks();
});

describe("unassignIssue", () => {
  it("removes the assignee from the issue's existing assignees array via PATCH", async () => {
    mockIssueDetail([{ login: "alice" }, { login: "bob" }]);
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse({ number: 42 }));

    await unassignIssue({ externalId: "foo/bar#42", assigneeExternalId: "bob" });

    expect(mocks.mockOctokit.request).toHaveBeenCalledTimes(2);
    const [route, options] = mocks.mockOctokit.request.mock.calls[1];
    expect(route).toBe("PATCH /repos/{owner}/{repo}/issues/{issue_number}");
    expect(options).toMatchObject({
      owner: "foo",
      repo: "bar",
      issue_number: 42,
      assignees: ["alice"],
    });
  });

  it("is idempotent when the assignee is not present", async () => {
    mockIssueDetail([{ login: "alice" }]);
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse({ number: 42 }));

    await unassignIssue({ externalId: "foo/bar#42", assigneeExternalId: "bob" });

    const [, options] = mocks.mockOctokit.request.mock.calls[1];
    expect(options).toMatchObject({ assignees: ["alice"] });
  });

  it("handles an empty / missing existing-assignees field", async () => {
    mockIssueDetail(null);
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse({ number: 42 }));

    await unassignIssue({ externalId: "foo/bar#42", assigneeExternalId: "bob" });

    const [, options] = mocks.mockOctokit.request.mock.calls[1];
    expect(options).toMatchObject({ assignees: [] });
  });

  it("throws on a malformed externalId without contacting GitHub", async () => {
    await expect(
      unassignIssue({ externalId: "no-hash", assigneeExternalId: "bob" }),
    ).rejects.toThrow(/externalId/);
    expect(mocks.mockOctokit.request).not.toHaveBeenCalled();
  });
});
