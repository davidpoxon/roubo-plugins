import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateConfig } from "../methods/validate-config.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

describe("validateConfig", () => {
  let mocks: ReturnType<typeof installMocks>;

  beforeEach(() => {
    mocks = installMocks();
  });

  afterEach(() => {
    teardownMocks();
  });

  it("returns ok when the token + sources resolve", async () => {
    // GET /user
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse({ id: 1, login: "foo" }));
    // GET /repos/{owner}/{repo}
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse({ name: "bar", full_name: "foo/bar" }),
    );

    const result = await validateConfig({
      config: { sources: [{ kind: "repo", externalId: "foo/bar" }] },
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a malformed config without contacting GitHub", async () => {
    const result = await validateConfig({ config: { sources: "no" } });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toEqual({
      field: "sources",
      message: "sources must be an array",
    });
    expect(mocks.mockOctokit.request).not.toHaveBeenCalled();
  });

  it("returns a structured 'unauthorized' error when /user returns 401", async () => {
    mocks.mockOctokit.request.mockRejectedValueOnce({
      status: 401,
      message: "Bad credentials",
      response: { headers: {} },
    });

    const result = await validateConfig({
      config: { sources: [{ kind: "repo", externalId: "foo/bar" }] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toEqual({
      field: "github-token",
      message: "GitHub token is invalid or expired",
      code: "unauthorized",
    });
  });

  it("returns a generic auth-failure error when /user fails with a non-401 status", async () => {
    mocks.mockOctokit.request.mockRejectedValueOnce({
      status: 500,
      message: "Internal Server Error",
      response: { headers: {} },
    });

    const result = await validateConfig({
      config: { sources: [{ kind: "repo", externalId: "foo/bar" }] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0].message).toMatch(/authenticate/i);
    expect(result.errors?.[0].code).toBeUndefined();
  });

  it("accepts a token-only payload (no sources) and probes /user only", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse({ id: 1, login: "foo" }));

    const result = await validateConfig({ config: {} });
    expect(result).toEqual({ ok: true });
    expect(mocks.mockOctokit.request).toHaveBeenCalledTimes(1);
  });

  it("collects per-source errors", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse({ id: 1, login: "foo" }));
    mocks.mockOctokit.request.mockRejectedValueOnce({
      status: 404,
      message: "Not Found",
      response: { headers: {} },
    });

    const result = await validateConfig({
      config: { sources: [{ kind: "repo", externalId: "missing/repo" }] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0].field).toBe("sources[0].externalId");
  });
});
