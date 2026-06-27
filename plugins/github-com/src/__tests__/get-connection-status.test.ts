import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FetchInit, FetchResult } from "@roubo/plugin-sdk";
import {
  __resetHasAlertCategoryEnabled,
  __setHasAlertCategoryEnabledForTests,
  getConnectionStatus,
} from "../methods/get-connection-status.js";
import { installMocks, teardownMocks } from "./helpers.js";

function queueUserResponse(
  mocks: ReturnType<typeof installMocks>,
  headers: Record<string, string | string[]>,
  status = 200,
): void {
  mocks.mockHost.fetch.mockImplementationOnce(
    async (_url: string, _init?: FetchInit): Promise<FetchResult> => ({
      status,
      headers,
      body: JSON.stringify({ login: "octocat", id: 1 }),
    }),
  );
}

describe("getConnectionStatus (github-com)", () => {
  let mocks: ReturnType<typeof installMocks>;

  beforeEach(() => {
    mocks = installMocks();
    __resetHasAlertCategoryEnabled();
  });

  afterEach(() => {
    teardownMocks();
    __resetHasAlertCategoryEnabled();
  });

  it("returns connected when /user succeeds and no alert categories are enabled (today's default)", async () => {
    queueUserResponse(mocks, { "X-OAuth-Scopes": "repo, read:org" });

    const result = await getConnectionStatus();
    expect(result.state).toBe("connected");
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("surfaces the authenticated login as account on the connected result", async () => {
    queueUserResponse(mocks, { "X-OAuth-Scopes": "repo, read:org" });

    const result = await getConnectionStatus();
    expect(result.state).toBe("connected");
    expect(result.account).toEqual({ login: "octocat" });
  });

  it("omits account when the /user body carries no login", async () => {
    mocks.mockHost.fetch.mockImplementationOnce(async () => ({
      status: 200,
      headers: { "X-OAuth-Scopes": "repo" },
      body: "{}",
    }));

    const result = await getConnectionStatus();
    expect(result.state).toBe("connected");
    expect(result.account).toBeUndefined();
  });

  it("requests https://api.github.com/user with a Bearer Authorization header", async () => {
    mocks.mockHost.fetch.mockImplementationOnce(async (url, init) => {
      expect(url).toBe("https://api.github.com/user");
      expect(init?.headers?.Authorization).toBe("Bearer ghp_test_token");
      return {
        status: 200,
        headers: { "X-OAuth-Scopes": "repo" },
        body: "{}",
      };
    });

    const result = await getConnectionStatus();
    expect(result.state).toBe("connected");
    expect(mocks.mockHost.credentialsGet).toHaveBeenCalledWith("github-token");
  });

  it("returns auth-problem when /user returns 401", async () => {
    queueUserResponse(mocks, {}, 401);

    const result = await getConnectionStatus();
    expect(result.state).toBe("auth-problem");
    expect(result.detail).toMatch(/invalid or expired/);
    expect(result.account).toBeUndefined();
  });

  it("returns auth-problem when /user returns 403", async () => {
    queueUserResponse(mocks, {}, 403);

    const result = await getConnectionStatus();
    expect(result.state).toBe("auth-problem");
  });

  it("returns errored when /user returns a non-auth 5xx", async () => {
    queueUserResponse(mocks, {}, 503);

    const result = await getConnectionStatus();
    expect(result.state).toBe("errored");
    expect(result.detail).toMatch(/Failed to reach GitHub/);
  });

  it("returns auth-problem when the credential slot is empty", async () => {
    teardownMocks();
    mocks = installMocks();
    mocks.mockHost.credentialsGet.mockResolvedValueOnce(null);

    const result = await getConnectionStatus();
    expect(result.state).toBe("auth-problem");
    expect(result.detail).toMatch(/token not set/);
    expect(mocks.mockHost.fetch).not.toHaveBeenCalled();
  });

  it("returns errored when host.fetch throws", async () => {
    mocks.mockHost.fetch.mockRejectedValueOnce(new Error("network unreachable"));

    const result = await getConnectionStatus();
    expect(result.state).toBe("errored");
    expect(result.detail).toMatch(/network unreachable/);
  });

  it("returns auth-problem when alert categories are enabled AND security_events is missing", async () => {
    __setHasAlertCategoryEnabledForTests(() => true);
    queueUserResponse(mocks, { "X-OAuth-Scopes": "repo, read:org" });

    const result = await getConnectionStatus();
    expect(result.state).toBe("auth-problem");
    expect(result.detail).toMatch(/security_events scope/);
  });

  it("returns connected when alert categories are enabled AND security_events IS present", async () => {
    __setHasAlertCategoryEnabledForTests(() => true);
    queueUserResponse(mocks, { "X-OAuth-Scopes": "repo, security_events" });

    const result = await getConnectionStatus();
    expect(result.state).toBe("connected");
  });

  it("returns connected when alert categories are enabled but the X-OAuth-Scopes header is absent (fine-grained / GitHub App)", async () => {
    __setHasAlertCategoryEnabledForTests(() => true);
    queueUserResponse(mocks, {});

    const result = await getConnectionStatus();
    expect(result.state).toBe("connected");
  });
});
