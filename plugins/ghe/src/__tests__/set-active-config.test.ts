import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfiguredSource, FetchInit } from "@roubo/plugin-sdk";
import { setActiveConfig, tryGetActiveConfig } from "../active-config.js";
import { setActiveConfigMethod } from "../methods/set-active-config.js";
import { listIssues } from "../methods/list-issues.js";
import { resetAlertsRuntime } from "../alerts-runtime.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

const VALID_INSTANCE = "https://ghe.example.com";

describe("setActiveConfig RPC", () => {
  beforeEach(() => {
    setActiveConfig(null);
  });

  it("sets the plugin-wide active config when instance is well-formed", () => {
    const result = setActiveConfigMethod({ config: { instance: VALID_INSTANCE } });
    expect(result).toEqual({ ok: true });
    expect(tryGetActiveConfig()).toEqual({
      instance: VALID_INSTANCE,
      allowSelfSignedTls: false,
    });
  });

  it("returns shape errors and leaves active config untouched", () => {
    setActiveConfig({ instance: VALID_INSTANCE, allowSelfSignedTls: false });
    const result = setActiveConfigMethod({ config: { instance: "" } });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toEqual({
      field: "instance",
      message: "instance must be a non-empty string",
    });
    expect(tryGetActiveConfig()).toEqual({
      instance: VALID_INSTANCE,
      allowSelfSignedTls: false,
    });
  });

  it("accepts allowSelfSignedTls=true", () => {
    const result = setActiveConfigMethod({
      config: { instance: VALID_INSTANCE, allowSelfSignedTls: true },
    });
    expect(result).toEqual({ ok: true });
    expect(tryGetActiveConfig()).toEqual({
      instance: VALID_INSTANCE,
      allowSelfSignedTls: true,
    });
  });
});

/**
 * WU-032 AC #7: cache invalidation. When the host pushes a fresh active
 * config (the canonical signal for a PAT regeneration), the next
 * source-bound RPC must re-read the credential from the host so a
 * regenerated PAT is picked up immediately.
 */
describe("setActiveConfig invalidates alerts-runtime cache (AC #7)", () => {
  let mocks: ReturnType<typeof installMocks>;

  beforeEach(() => {
    resetAlertsRuntime();
    mocks = installMocks();
  });

  afterEach(() => {
    teardownMocks();
    resetAlertsRuntime();
  });

  it("re-reads the GHE token on the next listIssues call after setActiveConfig fires", async () => {
    // Pre-warm the runtime cache by running listIssues once with the
    // initial token "old_pat".
    mocks.mockHost.credentialsGet.mockResolvedValueOnce("old_pat");
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([]));
    mocks.mockOctokit.graphql.mockResolvedValueOnce({ repository: {} });
    mocks.mockHost.fetch.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify([]),
    });

    const sources: ConfiguredSource[] = [
      { kind: "repo", externalId: "foo/bar", includeCodeQLAlerts: true },
    ];
    await listIssues({ sources, cursor: null, pageSize: 50 });

    const firstAlertCall = mocks.mockHost.fetch.mock.calls.at(-1);
    const firstHeaders = (firstAlertCall?.[1] as FetchInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(firstHeaders?.Authorization).toBe("Bearer old_pat");

    // Now the user pastes a regenerated PAT and saves. setActiveConfig fires;
    // the runtime cache should be cleared so the next call re-reads.
    mocks.mockHost.credentialsGet.mockResolvedValueOnce("new_pat");
    setActiveConfigMethod({ config: { instance: VALID_INSTANCE } });

    // Next listIssues pull must use "new_pat", not the stale "old_pat".
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([]));
    mocks.mockOctokit.graphql.mockResolvedValueOnce({ repository: {} });
    mocks.mockHost.fetch.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify([]),
    });

    await listIssues({ sources, cursor: null, pageSize: 50 });

    const secondAlertCall = mocks.mockHost.fetch.mock.calls.at(-1);
    const secondHeaders = (secondAlertCall?.[1] as FetchInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(secondHeaders?.Authorization).toBe("Bearer new_pat");
  });
});
