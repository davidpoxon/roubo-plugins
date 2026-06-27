import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActiveConfig, tryGetActiveConfig } from "../active-config.js";
import { validateConfig } from "../methods/validate-config.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

const VALID_INSTANCE = "https://ghe.example.com";

describe("validateConfig", () => {
  let mocks: ReturnType<typeof installMocks>;

  beforeEach(() => {
    mocks = installMocks();
    // validateConfig tests assert active-config state explicitly; start each
    // test from a known-empty state rather than the helper's pre-seeded
    // instance config.
    setActiveConfig(null);
  });

  afterEach(() => {
    teardownMocks();
  });

  it("returns ok and caches the plugin-wide config when token + sources resolve", async () => {
    // GET /user
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse({ id: 1, login: "foo" }));
    // GET /repos/{owner}/{repo}
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse({ name: "bar", full_name: "foo/bar" }),
    );

    const result = await validateConfig({
      config: {
        instance: VALID_INSTANCE,
        sources: [{ kind: "repo", externalId: "foo/bar" }],
      },
    });
    expect(result).toEqual({ ok: true });
    expect(tryGetActiveConfig()).toEqual({
      instance: VALID_INSTANCE,
      allowSelfSignedTls: false,
    });
  });

  it("captures the allowSelfSignedTls flag in the active config", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse({ id: 1, login: "foo" }));
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse({ name: "bar", full_name: "foo/bar" }),
    );

    const result = await validateConfig({
      config: {
        instance: VALID_INSTANCE,
        allowSelfSignedTls: true,
        sources: [{ kind: "repo", externalId: "foo/bar" }],
      },
    });
    expect(result).toEqual({ ok: true });
    expect(tryGetActiveConfig()?.allowSelfSignedTls).toBe(true);
  });

  it("rejects a config missing the instance URL", async () => {
    const result = await validateConfig({
      config: { sources: [{ kind: "repo", externalId: "foo/bar" }] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toEqual({
      field: "instance",
      message: "instance must be a non-empty string",
    });
    expect(mocks.mockOctokit.request).not.toHaveBeenCalled();
    expect(tryGetActiveConfig()).toBeNull();
  });

  it("rejects a malformed instance URL", async () => {
    const result = await validateConfig({
      config: { instance: "ftp://ghe.example.com", sources: [] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toEqual({
      field: "instance",
      message: "instance must be an http(s) URL",
    });
    expect(tryGetActiveConfig()).toBeNull();
  });

  it("rejects a non-boolean allowSelfSignedTls", async () => {
    const result = await validateConfig({
      config: { instance: VALID_INSTANCE, allowSelfSignedTls: "yes", sources: [] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toEqual({
      field: "allowSelfSignedTls",
      message: "must be a boolean",
    });
  });

  it("rejects a malformed sources field without contacting GitHub", async () => {
    const result = await validateConfig({
      config: { instance: VALID_INSTANCE, sources: "no" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toEqual({
      field: "sources",
      message: "sources must be an array",
    });
    expect(mocks.mockOctokit.request).not.toHaveBeenCalled();
    expect(tryGetActiveConfig()).toBeNull();
  });

  it("returns the raw auth error when /user fails (auth case)", async () => {
    mocks.mockOctokit.request.mockRejectedValueOnce({
      status: 401,
      message: "Bad credentials",
      response: { headers: {} },
    });

    const result = await validateConfig({
      config: {
        instance: VALID_INSTANCE,
        sources: [{ kind: "repo", externalId: "foo/bar" }],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0].message).toBe("Bad credentials");
    expect(tryGetActiveConfig()).toBeNull();
  });

  it("preserves a self-signed certificate error verbatim so the host can classify it as TLS (TC-062)", async () => {
    mocks.mockOctokit.request.mockRejectedValueOnce(
      new Error("self-signed certificate in certificate chain"),
    );

    const result = await validateConfig({
      config: {
        instance: VALID_INSTANCE,
        sources: [{ kind: "repo", externalId: "foo/bar" }],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0].message).toMatch(/self-signed certificate/i);
    expect(tryGetActiveConfig()).toBeNull();
  });

  it("accepts a token-only payload (no sources) and probes /user only", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse({ id: 1, login: "foo" }));

    const result = await validateConfig({ config: { instance: VALID_INSTANCE } });
    expect(result).toEqual({ ok: true });
    expect(tryGetActiveConfig()).toEqual({
      instance: VALID_INSTANCE,
      allowSelfSignedTls: false,
    });
    expect(mocks.mockOctokit.request).toHaveBeenCalledTimes(1);
  });

  it("token-only re-test updates the active instance even when no sources are present", async () => {
    // First call: full config with real sources.
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse({ id: 1, login: "foo" }));
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse({ name: "bar", full_name: "foo/bar" }),
    );
    await validateConfig({
      config: {
        instance: VALID_INSTANCE,
        sources: [{ kind: "repo", externalId: "foo/bar" }],
      },
    });

    // Second call: token-only with a different instance URL. The probe
    // should run with and persist the new instance.
    const NEW_INSTANCE = "https://ghe.example.org";
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse({ id: 1, login: "foo" }));
    const result = await validateConfig({ config: { instance: NEW_INSTANCE } });
    expect(result).toEqual({ ok: true });
    expect(tryGetActiveConfig()).toEqual({
      instance: NEW_INSTANCE,
      allowSelfSignedTls: false,
    });
  });

  it("collects per-source errors and rolls active config back to the previous value", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse({ id: 1, login: "foo" }));
    mocks.mockOctokit.request.mockRejectedValueOnce({
      status: 404,
      message: "Not Found",
      response: { headers: {} },
    });

    const result = await validateConfig({
      config: {
        instance: VALID_INSTANCE,
        sources: [{ kind: "repo", externalId: "missing/repo" }],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0].field).toBe("sources[0].externalId");
    expect(tryGetActiveConfig()).toBeNull();
  });
});
