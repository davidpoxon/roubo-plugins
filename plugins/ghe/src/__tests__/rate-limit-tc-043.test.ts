import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setSleepForTests, githubRequest } from "../github-request.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

// TC-043 — GitHub.com plugin honours Retry-After on secondary rate-limit.
//
// Preconditions:
//   - The bundled GHE plugin is enabled.
//   - A request elicits a 429 with Retry-After: 30.
// Expected:
//   - Plugin waits at least 30 seconds before retrying.
//   - On budget exceeded, the plugin surfaces a structured rate-limit error.

describe("TC-043: Retry-After backoff", () => {
  let mocks: ReturnType<typeof installMocks>;
  let sleepCalls: number[];

  beforeEach(() => {
    mocks = installMocks();
    sleepCalls = [];
    __setSleepForTests(async (ms) => {
      sleepCalls.push(ms);
    });
  });

  afterEach(() => {
    teardownMocks();
  });

  it("waits at least Retry-After seconds before retrying after a 429", async () => {
    const payload = [{ id: 1 }];
    mocks.mockOctokit.request
      .mockRejectedValueOnce({
        status: 429,
        message: "Too Many Requests",
        response: { headers: { "retry-after": "30" } },
      })
      .mockResolvedValueOnce(okResponse(payload));

    const result = await githubRequest<typeof payload>({
      kind: "rest",
      route: "GET /repos/{owner}/{repo}/issues",
      params: { owner: "foo", repo: "bar" },
    });
    if (result.kind !== "rest") throw new Error("unreachable");
    expect(result.data).toEqual(payload);
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBeGreaterThanOrEqual(30_000);
  });

  it("honours Retry-After on a secondary rate-limit 403", async () => {
    const payload = [{ ok: true }];
    mocks.mockOctokit.request
      .mockRejectedValueOnce({
        status: 403,
        message: "You have exceeded a secondary rate limit",
        response: { headers: { "retry-after": "15" } },
      })
      .mockResolvedValueOnce(okResponse(payload));

    const result = await githubRequest<typeof payload>({
      kind: "rest",
      route: "GET /repos/{owner}/{repo}/issues",
      params: { owner: "foo", repo: "bar" },
    });
    if (result.kind !== "rest") throw new Error("unreachable");
    expect(result.data).toEqual(payload);
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBeGreaterThanOrEqual(15_000);
  });

  it("uses x-ratelimit-reset for the primary rate-limit 403", async () => {
    const payload = [{ ok: true }];
    const resetSeconds = Math.floor(Date.now() / 1000) + 20;
    mocks.mockOctokit.request
      .mockRejectedValueOnce({
        status: 403,
        message: "API rate limit exceeded",
        response: {
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetSeconds),
          },
        },
      })
      .mockResolvedValueOnce(okResponse(payload));

    const result = await githubRequest<typeof payload>({
      kind: "rest",
      route: "GET /repos/{owner}/{repo}/issues",
      params: { owner: "foo", repo: "bar" },
    });
    if (result.kind !== "rest") throw new Error("unreachable");
    expect(result.data).toEqual(payload);
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBeGreaterThan(0);
    expect(sleepCalls[0]).toBeLessThanOrEqual(60_000);
  });

  it("re-throws the rate-limit error after exhausting the retry budget", async () => {
    for (let i = 0; i < 4; i++) {
      mocks.mockOctokit.request.mockRejectedValueOnce({
        status: 429,
        message: "Too Many Requests",
        response: { headers: { "retry-after": "1" } },
      });
    }

    await expect(
      githubRequest({
        kind: "rest",
        route: "GET /repos/{owner}/{repo}/issues",
        params: { owner: "foo", repo: "bar" },
      }),
    ).rejects.toMatchObject({ status: 429 });

    expect(sleepCalls.length).toBe(3);
  });
});
