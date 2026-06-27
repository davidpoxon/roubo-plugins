import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIssue } from "../methods/create-issue.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

let mocks: ReturnType<typeof installMocks>;

beforeEach(() => {
  mocks = installMocks();
});

afterEach(() => {
  teardownMocks();
});

describe("createIssue", () => {
  it("POSTs a new issue and returns ref, url, and nodeId", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse({
        number: 99,
        html_url: "https://github.com/foo/bar/issues/99",
        node_id: "I_node99",
      }),
    );

    const result = await createIssue({
      repoFullName: "foo/bar",
      title: "Fix the gate",
      body: "details",
      labels: ["bug"],
    });

    expect(mocks.mockOctokit.request).toHaveBeenCalledTimes(1);
    const [route, options] = mocks.mockOctokit.request.mock.calls[0];
    expect(route).toBe("POST /repos/{owner}/{repo}/issues");
    expect(options).toMatchObject({
      owner: "foo",
      repo: "bar",
      title: "Fix the gate",
      body: "details",
      labels: ["bug"],
    });
    expect(result).toEqual({
      ref: "foo/bar#99",
      url: "https://github.com/foo/bar/issues/99",
      nodeId: "I_node99",
    });
  });

  it("omits body and labels when not supplied", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse({ number: 1, html_url: "u", node_id: "n" }),
    );

    await createIssue({ repoFullName: "foo/bar", title: "Title only" });

    const [, options] = mocks.mockOctokit.request.mock.calls[0];
    expect(options).not.toHaveProperty("body");
    expect(options).not.toHaveProperty("labels");
  });

  it("throws on an empty title without contacting GitHub", async () => {
    await expect(createIssue({ repoFullName: "foo/bar", title: "   " })).rejects.toThrow(
      /non-empty title/,
    );
    expect(mocks.mockOctokit.request).not.toHaveBeenCalled();
  });

  it("throws on a malformed repo name without contacting GitHub", async () => {
    await expect(createIssue({ repoFullName: "no-slash", title: "x" })).rejects.toThrow(
      /Invalid repo name/,
    );
    expect(mocks.mockOctokit.request).not.toHaveBeenCalled();
  });
});
