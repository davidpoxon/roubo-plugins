import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfiguredSource } from "@roubo/plugin-sdk";
import { getFacetOptions } from "../methods/get-facet-options.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

const REPO_SOURCES: ConfiguredSource[] = [{ kind: "repo", externalId: "foo/bar" }];

describe("getFacetOptions", () => {
  let mocks: ReturnType<typeof installMocks>;

  beforeEach(() => {
    mocks = installMocks();
  });

  afterEach(() => {
    teardownMocks();
  });

  it("returns repo milestones as FilterFacetOption[] for facetId=milestone", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse([{ title: "v1.0" }, { title: "v1.1" }, { title: "v2.0" }]),
    );

    const result = await getFacetOptions({ facetId: "milestone", sources: REPO_SOURCES });

    expect(result).toEqual([
      { value: "v1.0", label: "v1.0" },
      { value: "v1.1", label: "v1.1" },
      { value: "v2.0", label: "v2.0" },
    ]);
    const route = mocks.mockOctokit.request.mock.calls[0][0] as string;
    expect(route).toBe("GET /repos/{owner}/{repo}/milestones");
    const params = mocks.mockOctokit.request.mock.calls[0][1] as Record<string, unknown>;
    expect(params).toMatchObject({ owner: "foo", repo: "bar", state: "open", per_page: 100 });
  });

  it("requests only open milestones so closed milestones are excluded at the source", async () => {
    // The source already restricts the response to open milestones, so a closed
    // milestone never reaches the facet options: the request never asks for it.
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([{ title: "v1.0" }]));

    const result = await getFacetOptions({ facetId: "milestone", sources: REPO_SOURCES });

    expect(result).toEqual([{ value: "v1.0", label: "v1.0" }]);
    const params = mocks.mockOctokit.request.mock.calls[0][1] as Record<string, unknown>;
    expect(params).toMatchObject({ state: "open" });
    expect(params).not.toMatchObject({ state: "all" });
  });

  it("applies a case-insensitive search filter on the option label", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse([{ title: "v1.0" }, { title: "v1.1" }, { title: "v2.0" }]),
    );

    const result = await getFacetOptions({
      facetId: "milestone",
      sources: REPO_SOURCES,
      search: "V1",
    });

    expect(result).toEqual([
      { value: "v1.0", label: "v1.0" },
      { value: "v1.1", label: "v1.1" },
    ]);
  });

  it("returns [] for unknown facetIds without calling the network", async () => {
    const result = await getFacetOptions({ facetId: "unknown", sources: REPO_SOURCES });
    expect(result).toEqual([]);
    expect(mocks.mockOctokit.request).not.toHaveBeenCalled();
  });

  it("returns [] when the active source is not a repo (e.g. project source)", async () => {
    const result = await getFacetOptions({
      facetId: "milestone",
      sources: [{ kind: "project", externalId: "foo/#1" }],
    });
    expect(result).toEqual([]);
    expect(mocks.mockOctokit.request).not.toHaveBeenCalled();
  });
});
