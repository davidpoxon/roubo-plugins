import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConfiguredSource } from "@roubo/plugin-sdk";

// Unit-test the facet -> fetcher routing in get-facet-options by mocking the
// fetchers directly. This keeps the test independent of the Octokit/GraphQL
// transport layer (covered separately) and of cross-test ordering.
vi.mock("../github-fetchers.js", () => ({
  fetchMilestones: vi.fn(),
  fetchLabels: vi.fn(),
  fetchIssueTypes: vi.fn(),
  fetchAssignees: vi.fn(),
}));

import { getFacetOptions } from "../methods/get-facet-options.js";
import {
  fetchMilestones,
  fetchLabels,
  fetchIssueTypes,
  fetchAssignees,
} from "../github-fetchers.js";

const REPO: ConfiguredSource[] = [{ kind: "repo", externalId: "foo/bar" }];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getFacetOptions facet routing", () => {
  it("routes milestone to fetchMilestones", async () => {
    vi.mocked(fetchMilestones).mockResolvedValue(["v1.0", "v2.0"]);
    expect(await getFacetOptions({ facetId: "milestone", sources: REPO })).toEqual([
      { value: "v1.0", label: "v1.0" },
      { value: "v2.0", label: "v2.0" },
    ]);
    expect(fetchMilestones).toHaveBeenCalledWith("foo/bar");
  });

  it("routes label to fetchLabels", async () => {
    vi.mocked(fetchLabels).mockResolvedValue(["bug", "chore"]);
    expect(await getFacetOptions({ facetId: "label", sources: REPO })).toEqual([
      { value: "bug", label: "bug" },
      { value: "chore", label: "chore" },
    ]);
  });

  it("routes type to fetchIssueTypes, mapping to type names", async () => {
    vi.mocked(fetchIssueTypes).mockResolvedValue({
      configured: true,
      types: [
        { id: "1", name: "Bug" },
        { id: "2", name: "Feature" },
      ],
    });
    expect(await getFacetOptions({ facetId: "type", sources: REPO })).toEqual([
      { value: "Bug", label: "Bug" },
      { value: "Feature", label: "Feature" },
    ]);
  });

  it("routes assignee to fetchAssignees", async () => {
    vi.mocked(fetchAssignees).mockResolvedValue(["octocat", "hubot"]);
    expect(await getFacetOptions({ facetId: "assignee", sources: REPO })).toEqual([
      { value: "octocat", label: "octocat" },
      { value: "hubot", label: "hubot" },
    ]);
  });

  it("applies a case-insensitive search filter to any facet", async () => {
    vi.mocked(fetchLabels).mockResolvedValue(["bug", "backend", "chore"]);
    expect(await getFacetOptions({ facetId: "label", sources: REPO, search: "B" })).toEqual([
      { value: "bug", label: "bug" },
      { value: "backend", label: "backend" },
    ]);
  });

  it("returns [] for an unknown facet without fetching", async () => {
    expect(await getFacetOptions({ facetId: "nope", sources: REPO })).toEqual([]);
    expect(fetchMilestones).not.toHaveBeenCalled();
    expect(fetchLabels).not.toHaveBeenCalled();
  });

  it("returns [] for a non-repo primary source without fetching", async () => {
    expect(
      await getFacetOptions({
        facetId: "label",
        sources: [{ kind: "project", externalId: "x/#1" }],
      }),
    ).toEqual([]);
    expect(fetchLabels).not.toHaveBeenCalled();
  });
});
