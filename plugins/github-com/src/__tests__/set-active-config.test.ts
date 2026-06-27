import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("octokit", () => ({
  Octokit: vi.fn(function MockOctokit(this: { request: unknown; graphql: unknown }) {
    this.request = vi.fn().mockResolvedValue({ data: null, status: 200, headers: {} });
    this.graphql = vi.fn().mockResolvedValue({});
  }),
}));

import { bindHost, resetHostBinding } from "../host-binding.js";
import { getOctokit, resetOctokit, __setOctokitForTests } from "../octokit-factory.js";
import { Octokit } from "octokit";
import { setActiveConfigMethod } from "../methods/set-active-config.js";
import { buildMockHost } from "./helpers.js";

beforeEach(() => {
  resetHostBinding();
  resetOctokit();
  vi.mocked(Octokit).mockClear();
});

afterEach(() => {
  resetHostBinding();
  resetOctokit();
  __setOctokitForTests(null);
});

describe("setActiveConfig", () => {
  it("returns ok for any config (github-com stores no plugin-wide config)", () => {
    expect(setActiveConfigMethod({ config: {} })).toEqual({ ok: true });
    expect(setActiveConfigMethod({ config: { ignored: "value" } })).toEqual({ ok: true });
  });

  it("clears the cached Octokit so the next call re-reads the rotated token", async () => {
    const mockHost = buildMockHost("ghp_old");
    bindHost(mockHost.host);

    // Warm the singleton with the original token.
    await getOctokit();
    expect(mockHost.credentialsGet).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Octokit)).toHaveBeenCalledTimes(1);

    // The host pushes setActiveConfig after an OAuth connect/disconnect. The
    // cache must drop so the next source-bound RPC re-reads the keychain rather
    // than reusing the pre-rotation client (the "Bad credentials" after
    // reconnect regression).
    expect(setActiveConfigMethod({ config: {} })).toEqual({ ok: true });

    await getOctokit();
    expect(mockHost.credentialsGet).toHaveBeenCalledTimes(2);
    expect(vi.mocked(Octokit)).toHaveBeenCalledTimes(2);
  });
});
