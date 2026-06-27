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

  it("enumerates projects across every owner the user has visibility into", async () => {
    // GET /user/repos — repos spanning two owners (the user + an org)
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse([
        { name: "roubo", full_name: "davidpoxon/roubo" },
        { name: "responda", full_name: "intentional-au/responda" },
      ]),
    );
    // GET /user
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse({ id: 1, login: "davidpoxon" }));
    // Owners are fanned out via Promise.all in insertion order:
    // davidpoxon first (user), then intentional-au (org). Each call's org
    // query fires synchronously, then any user-query fallbacks run after
    // the rejections settle.
    //   call 1: davidpoxon org query  → reject
    //   call 2: intentional-au org    → resolve (success)
    //   call 3: davidpoxon user query → resolve (fallback success)
    mocks.mockOctokit.graphql
      .mockRejectedValueOnce(new Error("not an organization"))
      .mockResolvedValueOnce({
        organization: { projectsV2: { nodes: [{ number: 2, title: "Team" }] } },
      })
      .mockResolvedValueOnce({
        user: { projectsV2: { nodes: [{ number: 1, title: "Personal" }] } },
      });

    const result = await listSourceCandidates();
    const projectCategory = result.categories.find((c) => c.id === "Project");
    if (!projectCategory) throw new Error("expected Project category");
    const externalIds = projectCategory.items.map((i) => i.externalId).sort();
    expect(externalIds).toEqual(["davidpoxon/#1", "intentional-au/#2"]);
    const davidpoxonProject = projectCategory.items.find((i) => i.externalId === "davidpoxon/#1");
    const intentionalProject = projectCategory.items.find(
      (i) => i.externalId === "intentional-au/#2",
    );
    expect(davidpoxonProject?.sublabel).toBe("GitHub Project v2 owned by davidpoxon");
    expect(intentionalProject?.sublabel).toBe("GitHub Project v2 owned by intentional-au");
  });

  it("isolates per-owner project failures so other owners still appear", async () => {
    mocks.mockOctokit.request
      .mockResolvedValueOnce(
        okResponse([
          { name: "roubo", full_name: "davidpoxon/roubo" },
          { name: "responda", full_name: "intentional-au/responda" },
        ]),
      )
      .mockResolvedValueOnce(okResponse({ id: 1, login: "davidpoxon" }));
    // Dispatch order (see notes above):
    //   call 1: davidpoxon org  → reject
    //   call 2: intentional-au org → reject (first failure for this owner)
    //   call 3: davidpoxon user → resolve (fallback success)
    //   call 4: intentional-au user → reject (final failure, owner dropped)
    mocks.mockOctokit.graphql
      .mockRejectedValueOnce(new Error("not an organization"))
      .mockRejectedValueOnce(new Error("forbidden"))
      .mockResolvedValueOnce({
        user: { projectsV2: { nodes: [{ number: 1, title: "Personal" }] } },
      })
      .mockRejectedValueOnce(new Error("forbidden"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await listSourceCandidates();

    const projectCategory = result.categories.find((c) => c.id === "Project");
    if (!projectCategory) throw new Error("expected Project category");
    const externalIds = projectCategory.items.map((i) => i.externalId);
    expect(externalIds).toEqual(["davidpoxon/#1"]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to enumerate projects for "intentional-au"'),
      expect.any(String),
    );
    warnSpy.mockRestore();
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
