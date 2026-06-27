import type { SourceCandidateItem, SourceCandidatesResponse } from "@roubo/plugin-sdk";
import { fetchCurrentUser, fetchProjects, fetchUserRepos } from "../github-fetchers.js";

/**
 * Returns the repos the current user can see plus all GitHub Projects v2
 * owned by the authenticated user OR by any org/user that owns a repo the
 * user has access to. Project enumeration is best-effort per owner: a single
 * failing owner (e.g. one without projects enabled, or one the token can't
 * read) does not poison the wider candidate list.
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

    const owners = new Set<string>();
    owners.add(user.login);
    for (const repo of repos) {
      const ownerLogin = repo.full_name.split("/")[0];
      if (ownerLogin) owners.add(ownerLogin);
    }

    const ownerList = Array.from(owners);
    const results = await Promise.all(
      ownerList.map((owner) =>
        fetchProjects(owner).catch((err: unknown) => {
          // Per-owner isolation: a missing read:project scope, an org that
          // hasn't enabled projects, or a transient failure should not drop
          // the other owners' projects from the list.
          console.warn(
            `[github-com] listSourceCandidates: failed to enumerate projects for "${owner}":`,
            (err as Error).message,
          );
          return [];
        }),
      ),
    );

    ownerList.forEach((owner, i) => {
      for (const project of results[i] ?? []) {
        projectItems.push({
          externalId: `${owner}/#${project.number}`,
          label: `${project.title} (#${project.number})`,
          sublabel: `GitHub Project v2 owned by ${owner}`,
          icon: "project",
        });
      }
    });
  } catch (err) {
    // fetchCurrentUser failed: without an authenticated user we can't even
    // start project enumeration. Keep the repo list rather than failing.
    console.warn(
      "[github-com] listSourceCandidates: failed to resolve current user for project enumeration:",
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
