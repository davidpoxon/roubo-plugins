import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FetchResult } from "@roubo/plugin-sdk";
import { setActiveConfig } from "../active-config.js";
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
    async (): Promise<FetchResult> => ({
      status,
      headers,
      body: JSON.stringify({ login: "octocat", id: 1 }),
    }),
  );
}

describe("getConnectionStatus (ghe)", () => {
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

  it("requests {instance}/api/v3/user with a Bearer Authorization header", async () => {
    mocks.mockHost.fetch.mockImplementationOnce(async (url, init) => {
      expect(url).toBe("https://ghe.example.com/api/v3/user");
      expect(init?.headers?.Authorization).toBe("Bearer ghp_test_token");
      return {
        status: 200,
        headers: { "X-OAuth-Scopes": "repo" },
        body: "{}",
      };
    });

    const result = await getConnectionStatus();
    expect(result.state).toBe("connected");
    expect(mocks.mockHost.credentialsGet).toHaveBeenCalledWith("token");
  });

  it("forwards allowSelfSignedTls to host.fetch when the active config has it on", async () => {
    setActiveConfig({ instance: "https://ghe.example.com", allowSelfSignedTls: true });

    mocks.mockHost.fetch.mockImplementationOnce(async (_url, init) => {
      expect(init?.allowSelfSignedTls).toBe(true);
      return { status: 200, headers: { "X-OAuth-Scopes": "repo" }, body: "{}" };
    });

    const result = await getConnectionStatus();
    expect(result.state).toBe("connected");
  });

  it("strips a trailing slash from the configured instance URL", async () => {
    setActiveConfig({ instance: "https://ghe.example.com/", allowSelfSignedTls: false });

    mocks.mockHost.fetch.mockImplementationOnce(async (url) => {
      expect(url).toBe("https://ghe.example.com/api/v3/user");
      return { status: 200, headers: { "X-OAuth-Scopes": "repo" }, body: "{}" };
    });

    const result = await getConnectionStatus();
    expect(result.state).toBe("connected");
  });

  it("returns auth-problem when /user returns 401", async () => {
    queueUserResponse(mocks, {}, 401);

    const result = await getConnectionStatus();
    expect(result.state).toBe("auth-problem");
    expect(result.detail).toMatch(/invalid or expired/);
  });

  it("returns errored when /user returns a non-auth 5xx", async () => {
    queueUserResponse(mocks, {}, 503);

    const result = await getConnectionStatus();
    expect(result.state).toBe("errored");
    expect(result.detail).toMatch(/Failed to reach GHE/);
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

  it("returns errored when there is no active config", async () => {
    setActiveConfig(null);

    const result = await getConnectionStatus();
    expect(result.state).toBe("errored");
    expect(result.detail).toMatch(/No active GHE configuration/);
    expect(mocks.mockHost.fetch).not.toHaveBeenCalled();
  });

  it("returns errored when host.fetch throws", async () => {
    mocks.mockHost.fetch.mockRejectedValueOnce(new Error("self-signed cert"));

    const result = await getConnectionStatus();
    expect(result.state).toBe("errored");
    expect(result.detail).toMatch(/self-signed cert/);
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

  it("keeps state:'connected' for a fine-grained PAT (no X-OAuth-Scopes header) even with alert categories enabled (NFR-015)", async () => {
    __setHasAlertCategoryEnabledForTests(() => true);
    queueUserResponse(mocks, {});

    const result = await getConnectionStatus();
    expect(result.state).toBe("connected");
  });
});
