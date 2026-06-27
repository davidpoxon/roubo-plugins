import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyTransition } from "../methods/apply-transition.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

let mocks: ReturnType<typeof installMocks>;

beforeEach(() => {
  mocks = installMocks();
});

afterEach(() => {
  teardownMocks();
});

describe("applyTransition", () => {
  it("PATCHes state=closed for the 'close' transition", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse({ number: 42, state: "closed" }));

    await applyTransition({ externalId: "foo/bar#42", transition: "close" });

    expect(mocks.mockOctokit.request).toHaveBeenCalledTimes(1);
    const [route, options] = mocks.mockOctokit.request.mock.calls[0];
    expect(route).toBe("PATCH /repos/{owner}/{repo}/issues/{issue_number}");
    expect(options).toMatchObject({
      owner: "foo",
      repo: "bar",
      issue_number: 42,
      state: "closed",
    });
  });

  it("PATCHes state=open for the 'reopen' transition", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse({ number: 42, state: "open" }));

    await applyTransition({ externalId: "foo/bar#42", transition: "reopen" });

    const [, options] = mocks.mockOctokit.request.mock.calls[0];
    expect(options).toMatchObject({ state: "open" });
  });

  it("throws on an unknown transition without contacting GitHub", async () => {
    await expect(
      applyTransition({ externalId: "foo/bar#42", transition: "wontfix" }),
    ).rejects.toThrow(/Unknown transition/);
    expect(mocks.mockOctokit.request).not.toHaveBeenCalled();
  });

  it("throws on a malformed externalId without contacting GitHub", async () => {
    await expect(applyTransition({ externalId: "no-hash", transition: "close" })).rejects.toThrow(
      /externalId/,
    );
    expect(mocks.mockOctokit.request).not.toHaveBeenCalled();
  });
});
