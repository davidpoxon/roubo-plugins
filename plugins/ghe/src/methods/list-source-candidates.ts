import type { SourceCandidateItem, SourceCandidatesResponse } from "@roubo/plugin-sdk";
import { fetchCurrentUser, fetchProjects, fetchUserRepos } from "../github-fetchers.js";

/**
 * Returns the repos the current user can see plus all GitHub Projects v2
 * for the user's own login (projects scoped to organizations the user
 * belongs to are deferred to a follow-up: the legacy module only ever
 * looked up projects for the explicit owner of the configured repo).
 *
 * Category ids ("Repository", "Project") are load-bearing: the host's
 * `plugin-source-translation` module keys off them to round-trip the
 * persisted selection back into per-source RPC calls.
 */
export async function listSourceCandidates(): Promise<SourceCandidatesResponse> {
  const repoItems: SourceCandidateItem[] = [];
  const projectItems: SourceCandidateItem[] = [];

  const repos = await fetchUserRepos();
  for (const repo of repos) {
    repoItems.push({
      externalId: repo.full_name,
      label: repo.full_name,
      ...(repo.description ? { sublabel: repo.description } : {}),
      icon: "repo",
    });
  }

  try {
    const user = await fetchCurrentUser();
    const projects = await fetchProjects(user.login);
    for (const project of projects) {
      projectItems.push({
        externalId: `${user.login}/#${project.number}`,
        label: `${project.title} (#${project.number})`,
        sublabel: `GitHub Project v2 owned by ${user.login}`,
        icon: "project",
      });
    }
  } catch (err) {
    // Listing projects is best-effort: a missing read:project scope or no
    // projects at all should not break the broader candidate list.
    console.warn(
      "[ghe] listSourceCandidates: failed to enumerate user projects:",
      (err as Error).message,
    );
  }

  return {
    shape: "categorized-multi-list",
    categories: [
      { id: "Repository", label: "Repositories", items: repoItems },
      { id: "Project", label: "Projects", items: projectItems },
    ],
  };
}
