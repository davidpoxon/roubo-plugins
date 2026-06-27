import { parseExternalId } from "../external-id.js";
import { githubRequest, parseRepo } from "../github-request.js";

// Response of the node-id resolution query: one issue node id per aliased issue.
interface ResolveNodeIdsResponse {
  blocked: { issue: { id: string } | null } | null;
  blocker: { issue: { id: string } | null } | null;
}

// GitHub's issue-dependencies write mutation (the WRITE neighbour of the
// `blockedBy`/`blocking` READ graph in github-fetchers.ts). Given the gate
// (blocked) issue and the fix (blocker) issue, it records "blocked is blocked by
// blocker". The mutation's GA status is instance- and date-dependent (spike
// #704), so a schema/availability rejection is surfaced as a legible error the
// gateway can degrade on, never swallowed.
const ADD_BLOCKED_BY_MUTATION = `mutation($blockedId: ID!, $blockerId: ID!) {
  addIssueDependency(input: { issueId: $blockedId, blockedByIssueId: $blockerId }) {
    clientMutationId
  }
}`;

function buildResolveQuery(): string {
  return `query($blockedOwner: String!, $blockedRepo: String!, $blockedNumber: Int!, $blockerOwner: String!, $blockerRepo: String!, $blockerNumber: Int!) {
    blocked: repository(owner: $blockedOwner, name: $blockedRepo) {
      issue(number: $blockedNumber) { id }
    }
    blocker: repository(owner: $blockerOwner, name: $blockerRepo) {
      issue(number: $blockerNumber) { id }
    }
  }`;
}

/**
 * Register an "is blocked by" relationship on GitHub (verify-gate FR-010/FR-011,
 * spike #704): `blockedRef` becomes blocked by `blockerRef`. Resolves both
 * issues' GraphQL node ids, then issues the issue-dependencies write mutation,
 * the WRITE neighbour of the `blockedBy`/`blocking` READ already shipping in
 * `github-fetchers.ts`.
 *
 * This plugin method is only reached through the host's TrackerActionGateway,
 * which gates the call on the `supportsBlockingLinks` manifest capability and the
 * plugin's consent before invoking it. The mutation's GA status is instance- and
 * date-dependent, so an availability rejection propagates as a clear error for
 * the gateway to surface; it is never a silent no-op.
 */
export async function addBlockedBy(params: {
  blockedRef: string;
  blockerRef: string;
}): Promise<void> {
  const blocked = parseExternalId(params.blockedRef);
  const blocker = parseExternalId(params.blockerRef);
  const blockedRepo = parseRepo(blocked.repoFullName);
  const blockerRepo = parseRepo(blocker.repoFullName);

  const resolved = await githubRequest<ResolveNodeIdsResponse>({
    kind: "graphql",
    query: buildResolveQuery(),
    variables: {
      blockedOwner: blockedRepo.owner,
      blockedRepo: blockedRepo.repo,
      blockedNumber: blocked.issueNumber,
      blockerOwner: blockerRepo.owner,
      blockerRepo: blockerRepo.repo,
      blockerNumber: blocker.issueNumber,
    },
    opName: "resolveBlockingNodeIds",
  });

  const blockedId = resolved.data.blocked?.issue?.id;
  const blockerId = resolved.data.blocker?.issue?.id;
  if (!blockedId) {
    throw new Error(`[github-com] addBlockedBy: blocked issue "${params.blockedRef}" not found.`);
  }
  if (!blockerId) {
    throw new Error(`[github-com] addBlockedBy: blocker issue "${params.blockerRef}" not found.`);
  }

  await githubRequest<{ addIssueDependency: { clientMutationId: string | null } }>({
    kind: "graphql",
    query: ADD_BLOCKED_BY_MUTATION,
    variables: { blockedId, blockerId },
    opName: "addBlockedBy",
  });
}
