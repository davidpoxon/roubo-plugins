import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listSourceCandidates } from "../methods/list-source-candidates.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

describe("listSourceCandidates", () => {
  let mocks: ReturnType<typeof installMocks>;

  beforeEach(() => {
    mocks = installMocks();
  });

  afterEach(() => {
    teardownMocks();
  });

  it("returns a categorized envelope of repos and projects for the current user", async () => {
    // GET /user/repos
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse([
        { name: "bar", full_name: "foo/bar", description: "A repo" },
        { name: "qux", full_name: "foo/qux", description: null },
      ]),
    );
    // GET /user
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse({ id: 1, login: "foo", name: "Foo User" }),
    );
    // organization projectsV2 query succeeds
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      organization: { projectsV2: { nodes: [{ number: 7, title: "Roadmap" }] } },
    });

    const result = await listSourceCandidates();
    expect(result).toEqual({
      shape: "categorized-multi-list",
      categories: [
        {
          id: "Repository",
          label: "Repositories",
          items: [
            {
              externalId: "foo/bar",
              label: "foo/bar",
              sublabel: "A repo",
              icon: "repo",
            },
            {
              externalId: "foo/qux",
              label: "foo/qux",
              icon: "repo",
            },
          ],
        },
        {
          id: "Project",
          label: "Projects",
          items: [
            {
              externalId: "foo/#7",
              label: "Roadmap (#7)",
              sublabel: "GitHub Project v2 owned by foo",
              icon: "project",
            },
          ],
        },
      ],
    });
  });

  it("returns repos with an empty Project category if project listing fails", async () => {
    mocks.mockOctokit.request
      .mockResolvedValueOnce(okResponse([{ name: "bar", full_name: "foo/bar" }]))
      .mockResolvedValueOnce(okResponse({ id: 1, login: "foo" }));
    // organization + user queries both fail
    mocks.mockOctokit.graphql
      .mockRejectedValueOnce(new Error("org not found"))
      .mockRejectedValueOnce(new Error("user not found"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await listSourceCandidates();
    warnSpy.mockRestore();

    expect(result.shape).toBe("categorized-multi-list");
    expect(result.categories).toHaveLength(2);
    const [repoCategory, projectCategory] = result.categories ?? [];
    expect(repoCategory.id).toBe("Repository");
    expect(repoCategory.items).toHaveLength(1);
    expect(repoCategory.items[0].externalId).toBe("foo/bar");
    expect(projectCategory.id).toBe("Project");
    expect(projectCategory.items).toEqual([]);
  });
});
