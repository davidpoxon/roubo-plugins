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

describe("getOctokit", () => {
  it("throws a clear error when the credential slot is empty", async () => {
    const mockHost = buildMockHost(null);
    bindHost(mockHost.host);
    await expect(getOctokit()).rejects.toThrow(/GitHub token missing/);
  });

  it("does not poison-cache a missing token: re-reads the keychain on the next call (regression: OAuth completed mid-session)", async () => {
    const mockHost = buildMockHost(null);
    bindHost(mockHost.host);

    // First call: token isn't in the keychain yet.
    await expect(getOctokit()).rejects.toThrow(/GitHub token missing/);
    expect(mockHost.credentialsGet).toHaveBeenCalledTimes(1);

    // Without any resetOctokit() in between, the next call must re-read the
    // keychain rather than reusing the previously-null lookup. If a missing
    // token were poison-cached, the call count would stay at 1 here.
    await expect(getOctokit()).rejects.toThrow(/GitHub token missing/);
    expect(mockHost.credentialsGet).toHaveBeenCalledTimes(2);
  });

  it("reuses the cached Octokit instance once a token has loaded successfully", async () => {
    const mockHost = buildMockHost("ghp_valid");
    bindHost(mockHost.host);

    const a = await getOctokit();
    const b = await getOctokit();
    expect(a).toBe(b);
    // Singleton cache: the keychain is read once, Octokit constructed once.
    expect(mockHost.credentialsGet).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Octokit)).toHaveBeenCalledTimes(1);
  });

  it("resetOctokit forces the next call to re-read the keychain", async () => {
    const mockHost = buildMockHost(null);
    bindHost(mockHost.host);

    await expect(getOctokit()).rejects.toThrow(/GitHub token missing/);
    expect(mockHost.credentialsGet).toHaveBeenCalledTimes(1);

    resetOctokit();
    // After reset, the next call should hit the keychain again rather than
    // reusing the previously-failed lookup.
    await expect(getOctokit()).rejects.toThrow(/GitHub token missing/);
    expect(mockHost.credentialsGet).toHaveBeenCalledTimes(2);
  });
});
