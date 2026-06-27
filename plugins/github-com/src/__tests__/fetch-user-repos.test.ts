import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawRepo } from "../types.js";
import { fetchUserRepos } from "../github-fetchers.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

function repoPage(count: number, prefix: string): RawRepo[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}-${i}`,
    full_name: `acme/${prefix}-${i}`,
  }));
}

describe("fetchUserRepos pagination", () => {
  let mocks: ReturnType<typeof installMocks>;

  beforeEach(() => {
    mocks = installMocks();
  });

  afterEach(() => {
    teardownMocks();
  });

  it("returns a single short page without requesting a second", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse(repoPage(2, "p1")));

    const repos = await fetchUserRepos();

    expect(repos).toHaveLength(2);
    expect(mocks.mockOctokit.request).toHaveBeenCalledTimes(1);
  });

  it("walks pages until a short page and concatenates the results", async () => {
    mocks.mockOctokit.request
      .mockResolvedValueOnce(okResponse(repoPage(100, "p1")))
      .mockResolvedValueOnce(okResponse(repoPage(100, "p2")))
      .mockResolvedValueOnce(okResponse(repoPage(7, "p3")));

    const repos = await fetchUserRepos();

    expect(repos).toHaveLength(207);
    expect(mocks.mockOctokit.request).toHaveBeenCalledTimes(3);
    // Second request asks for page 2 (request(route, options) — options is arg 1).
    expect(mocks.mockOctokit.request.mock.calls[1][0]).toBe("GET /user/repos");
    expect(mocks.mockOctokit.request.mock.calls[1][1]).toMatchObject({ page: 2 });
  });

  it("stops at the page cap and warns when every page is full", async () => {
    mocks.mockOctokit.request.mockResolvedValue(okResponse(repoPage(100, "full")));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const repos = await fetchUserRepos();

    expect(mocks.mockOctokit.request).toHaveBeenCalledTimes(10);
    expect(repos).toHaveLength(1000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("stopped after 10 pages"));
    warnSpy.mockRestore();
  });
});
