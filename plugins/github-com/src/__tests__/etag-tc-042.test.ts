import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { githubRequest } from "../github-request.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

// TC-042 — GitHub.com plugin preserves ETag short-circuiting.
//
// Preconditions:
//   - The bundled github-com plugin is enabled.
//   - A prior request stored an ETag for /repos/foo/bar/issues.
// Expected:
//   - Plugin sends If-None-Match with the stored ETag on the next request.
//   - On 304 the plugin returns the cached payload.

describe("TC-042: ETag short-circuit", () => {
  let mocks: ReturnType<typeof installMocks>;

  beforeEach(() => {
    mocks = installMocks();
  });

  afterEach(() => {
    teardownMocks();
  });

  it("sends If-None-Match on the second request and returns cached payload on 304 (thrown)", async () => {
    const issues = [
      { number: 1, title: "First", html_url: "u", created_at: "x", updated_at: "x" },
      { number: 2, title: "Second", html_url: "u", created_at: "x", updated_at: "x" },
    ];
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse(issues, { etag: 'W/"abc"' }));
    // Octokit throws on 304 by default.
    mocks.mockOctokit.request.mockRejectedValueOnce({ status: 304, response: { headers: {} } });

    const first = await githubRequest<typeof issues>({
      kind: "rest",
      route: "GET /repos/{owner}/{repo}/issues",
      params: { owner: "foo", repo: "bar", state: "open", per_page: 50 },
    });
    if (first.kind !== "rest") throw new Error("unreachable");
    expect(first.notModified).toBe(false);
    expect(first.data).toEqual(issues);

    const firstCallHeaders = (
      mocks.mockOctokit.request.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers;
    expect(firstCallHeaders["if-none-match"]).toBeUndefined();

    const second = await githubRequest<typeof issues>({
      kind: "rest",
      route: "GET /repos/{owner}/{repo}/issues",
      params: { owner: "foo", repo: "bar", state: "open", per_page: 50 },
    });
    if (second.kind !== "rest") throw new Error("unreachable");
    expect(second.notModified).toBe(true);
    expect(second.data).toEqual(issues);

    const secondCallHeaders = (
      mocks.mockOctokit.request.mock.calls[1][1] as { headers: Record<string, string> }
    ).headers;
    expect(secondCallHeaders["if-none-match"]).toBe('W/"abc"');
  });

  it("returns cached payload on 304 surfaced as a normal response", async () => {
    const issues = [{ number: 7, title: "x", html_url: "u", created_at: "x", updated_at: "x" }];
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse(issues, { etag: 'W/"v2"' }));
    mocks.mockOctokit.request.mockResolvedValueOnce({ data: undefined, headers: {}, status: 304 });

    await githubRequest({
      kind: "rest",
      route: "GET /repos/{owner}/{repo}/issues",
      params: { owner: "foo", repo: "bar" },
    });
    const second = await githubRequest<typeof issues>({
      kind: "rest",
      route: "GET /repos/{owner}/{repo}/issues",
      params: { owner: "foo", repo: "bar" },
    });
    if (second.kind !== "rest") throw new Error("unreachable");
    expect(second.notModified).toBe(true);
    expect(second.data).toEqual(issues);
  });

  it("keys ETags by route + path params so different repos do not collide", async () => {
    const fooIssues = [
      { number: 1, title: "foo", html_url: "u", created_at: "x", updated_at: "x" },
    ];
    const bazIssues = [
      { number: 9, title: "baz", html_url: "u", created_at: "x", updated_at: "x" },
    ];

    mocks.mockOctokit.request
      .mockResolvedValueOnce(okResponse(fooIssues, { etag: 'W/"foo-etag"' }))
      .mockResolvedValueOnce(okResponse(bazIssues, { etag: 'W/"baz-etag"' }))
      .mockRejectedValueOnce({ status: 304, response: { headers: {} } });

    await githubRequest({
      kind: "rest",
      route: "GET /repos/{owner}/{repo}/issues",
      params: { owner: "foo", repo: "bar" },
    });
    await githubRequest({
      kind: "rest",
      route: "GET /repos/{owner}/{repo}/issues",
      params: { owner: "baz", repo: "qux" },
    });
    const refresh = await githubRequest<typeof fooIssues>({
      kind: "rest",
      route: "GET /repos/{owner}/{repo}/issues",
      params: { owner: "foo", repo: "bar" },
    });
    if (refresh.kind !== "rest") throw new Error("unreachable");
    expect(refresh.notModified).toBe(true);
    expect(refresh.data).toEqual(fooIssues);

    const thirdHeaders = (
      mocks.mockOctokit.request.mock.calls[2][1] as { headers: Record<string, string> }
    ).headers;
    expect(thirdHeaders["if-none-match"]).toBe('W/"foo-etag"');
  });
});
