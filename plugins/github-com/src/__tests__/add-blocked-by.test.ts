import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addBlockedBy } from "../methods/add-blocked-by.js";
import { installMocks, teardownMocks } from "./helpers.js";

let mocks: ReturnType<typeof installMocks>;

beforeEach(() => {
  mocks = installMocks();
});

afterEach(() => {
  teardownMocks();
});

describe("addBlockedBy", () => {
  it("resolves both node ids then issues the issue-dependencies mutation", async () => {
    mocks.mockOctokit.graphql
      .mockResolvedValueOnce({
        blocked: { issue: { id: "GATE_NODE" } },
        blocker: { issue: { id: "FIX_NODE" } },
      })
      .mockResolvedValueOnce({ addIssueDependency: { clientMutationId: null } });

    await addBlockedBy({ blockedRef: "foo/bar#10", blockerRef: "foo/bar#11" });

    expect(mocks.mockOctokit.graphql).toHaveBeenCalledTimes(2);
    const [resolveQuery, resolveVars] = mocks.mockOctokit.graphql.mock.calls[0];
    expect(resolveQuery).toContain("issue(number: $blockedNumber)");
    expect(resolveVars).toMatchObject({
      blockedOwner: "foo",
      blockedRepo: "bar",
      blockedNumber: 10,
      blockerOwner: "foo",
      blockerRepo: "bar",
      blockerNumber: 11,
    });
    const [mutationQuery, mutationVars] = mocks.mockOctokit.graphql.mock.calls[1];
    expect(mutationQuery).toContain("addIssueDependency");
    expect(mutationVars).toEqual({ blockedId: "GATE_NODE", blockerId: "FIX_NODE" });
  });

  it("throws when the blocked issue cannot be resolved, without mutating", async () => {
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      blocked: { issue: null },
      blocker: { issue: { id: "FIX_NODE" } },
    });

    await expect(
      addBlockedBy({ blockedRef: "foo/bar#10", blockerRef: "foo/bar#11" }),
    ).rejects.toThrow(/blocked issue .* not found/);
    // Only the resolution query ran; the mutation never fired.
    expect(mocks.mockOctokit.graphql).toHaveBeenCalledTimes(1);
  });

  it("throws when the blocker issue cannot be resolved, without mutating", async () => {
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      blocked: { issue: { id: "GATE_NODE" } },
      blocker: { issue: null },
    });

    await expect(
      addBlockedBy({ blockedRef: "foo/bar#10", blockerRef: "foo/bar#11" }),
    ).rejects.toThrow(/blocker issue .* not found/);
    expect(mocks.mockOctokit.graphql).toHaveBeenCalledTimes(1);
  });

  it("propagates a mutation rejection (e.g. the write is not GA on the instance)", async () => {
    mocks.mockOctokit.graphql
      .mockResolvedValueOnce({
        blocked: { issue: { id: "GATE_NODE" } },
        blocker: { issue: { id: "FIX_NODE" } },
      })
      .mockRejectedValueOnce(new Error("Field 'addIssueDependency' doesn't exist"));

    await expect(
      addBlockedBy({ blockedRef: "foo/bar#10", blockerRef: "foo/bar#11" }),
    ).rejects.toThrow(/addIssueDependency/);
  });

  it("throws on a malformed ref without contacting GitHub", async () => {
    await expect(addBlockedBy({ blockedRef: "no-hash", blockerRef: "foo/bar#11" })).rejects.toThrow(
      /externalId/,
    );
    expect(mocks.mockOctokit.graphql).not.toHaveBeenCalled();
  });
});
