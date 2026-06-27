import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeRepoAccess } from "../methods/probe-repo-access.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

describe("probeRepoAccess", () => {
  let mocks: ReturnType<typeof installMocks>;

  beforeEach(() => {
    mocks = installMocks();
  });

  afterEach(() => {
    teardownMocks();
  });

  it("returns accessible:true when the repo summary fetch succeeds", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse({ name: "bar", full_name: "foo/bar", private: true }),
    );

    expect(await probeRepoAccess({ repoFullName: "foo/bar" })).toEqual({ accessible: true });
  });

  it("returns accessible:false with status and message on a 403 OAuth-restriction", async () => {
    const message =
      "Although you appear to have the correct authorization credentials, the `int3nt` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.";
    mocks.mockOctokit.request.mockRejectedValueOnce(
      Object.assign(new Error(message), { status: 403, response: { headers: {} } }),
    );

    expect(await probeRepoAccess({ repoFullName: "int3nt/ai-agent-marketplace" })).toEqual({
      accessible: false,
      status: 403,
      message,
    });
  });

  it("returns accessible:false with status 404 when the repo is not found", async () => {
    mocks.mockOctokit.request.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404, response: { headers: {} } }),
    );

    expect(await probeRepoAccess({ repoFullName: "foo/missing" })).toEqual({
      accessible: false,
      status: 404,
      message: "Not Found",
    });
  });

  it("omits status when the error carries none", async () => {
    mocks.mockOctokit.request.mockRejectedValueOnce(new Error("boom"));

    expect(await probeRepoAccess({ repoFullName: "foo/bar" })).toEqual({
      accessible: false,
      message: "boom",
    });
  });
});
