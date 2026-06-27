import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveConfig } from "../active-config.js";
import { bindHost, resetHostBinding } from "../host-binding.js";
import { __setOctokitForTests, getOctokit, resetOctokit } from "../octokit-factory.js";
import { buildMockHost } from "./helpers.js";

describe("octokit-factory", () => {
  beforeEach(() => {
    setActiveConfig(null);
    resetOctokit();
    resetHostBinding();
  });

  afterEach(() => {
    setActiveConfig(null);
    resetOctokit();
    resetHostBinding();
    __setOctokitForTests(null);
  });

  it("throws when no active configuration is set", async () => {
    const mock = buildMockHost("ghp_test_token");
    bindHost(mock.host);
    await expect(getOctokit()).rejects.toThrow(/No active configuration/);
  });

  it("throws when the credential store returns no token", async () => {
    const mock = buildMockHost(null);
    bindHost(mock.host);
    setActiveConfig({
      instance: "https://ghe.example.com",
      allowSelfSignedTls: false,
    });
    await expect(getOctokit()).rejects.toThrow(/GHE token missing/);
  });

  it("reads the PAT from the 'token' credential slot (not 'github-token')", async () => {
    const mock = buildMockHost("ghp_test_token");
    bindHost(mock.host);
    setActiveConfig({
      instance: "https://ghe.example.com",
      allowSelfSignedTls: false,
    });
    // Spy on credentials.get
    const getSpy = vi.spyOn(mock.host.credentials, "get");
    await getOctokit();
    expect(getSpy).toHaveBeenCalledWith("token");
    expect(getSpy).not.toHaveBeenCalledWith("github-token");
  });

  it("constructs Octokit with baseUrl set to <instance>/api/v3 (trailing slash stripped)", async () => {
    // We can't easily intercept the Octokit constructor without a heavier
    // injection seam. Instead, drive a request through the constructed
    // client and assert it routes through host.fetch with the GHE base
    // URL embedded in the request URL.
    const mock = buildMockHost("ghp_test_token");
    bindHost(mock.host);
    setActiveConfig({
      instance: "https://ghe.example.com/",
      allowSelfSignedTls: false,
    });
    mock.fetch.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, login: "foo" }),
    });
    const client = await getOctokit();
    await client.request("GET /user");
    expect(mock.fetch).toHaveBeenCalled();
    const [calledUrl] = mock.fetch.mock.calls[0];
    expect(calledUrl).toContain("https://ghe.example.com/api/v3/user");
  });

  it("rebuilds the client when the active instance URL changes", async () => {
    const mock = buildMockHost("ghp_test_token");
    bindHost(mock.host);
    setActiveConfig({
      instance: "https://ghe-a.example.com",
      allowSelfSignedTls: false,
    });
    const first = await getOctokit();

    setActiveConfig({
      instance: "https://ghe-b.example.com",
      allowSelfSignedTls: false,
    });
    const second = await getOctokit();
    expect(second).not.toBe(first);
  });

  it("forwards allowSelfSignedTls from the active config on each host.fetch call", async () => {
    const mock = buildMockHost("ghp_test_token");
    bindHost(mock.host);
    setActiveConfig({
      instance: "https://ghe.example.com",
      allowSelfSignedTls: true,
    });
    mock.fetch.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, login: "foo" }),
    });
    const client = await getOctokit();
    await client.request("GET /user");
    const [, init] = mock.fetch.mock.calls[0];
    expect(init?.allowSelfSignedTls).toBe(true);
  });

  it("omits allowSelfSignedTls when the active config has it disabled", async () => {
    const mock = buildMockHost("ghp_test_token");
    bindHost(mock.host);
    setActiveConfig({
      instance: "https://ghe.example.com",
      allowSelfSignedTls: false,
    });
    mock.fetch.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, login: "foo" }),
    });
    const client = await getOctokit();
    await client.request("GET /user");
    const [, init] = mock.fetch.mock.calls[0];
    expect(init?.allowSelfSignedTls).toBeUndefined();
  });

  it("returns the injected test client without consulting active config", async () => {
    const fakeClient = {
      request: vi.fn(),
      graphql: vi.fn(),
    };
    __setOctokitForTests(fakeClient);
    const got = await getOctokit();
    expect(got).toBe(fakeClient);
  });
});
