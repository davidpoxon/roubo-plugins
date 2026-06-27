import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FetchInit } from "@roubo/plugin-sdk";
import { jiraFetch, JiraApiError } from "../jira-client.js";
import { installHostHarness, type HostHarness } from "./helpers/host-stub.js";

describe("jiraFetch", () => {
  let harness: HostHarness;

  beforeEach(() => {
    harness = installHostHarness();
  });
  afterEach(() => harness.dispose());

  it("threads allowSelfSignedTls onto the host.fetch init when set", async () => {
    let seen: FetchInit | null = null;
    harness.fetchStub.on("/rest/api/2/myself", (init) => {
      seen = init;
      return { name: "alice" };
    });

    await jiraFetch(
      { instance: "https://jira.acme.example", pat: "tok", allowSelfSignedTls: true },
      "/rest/api/2/myself",
    );

    expect(seen).not.toBeNull();
    expect((seen as unknown as FetchInit).allowSelfSignedTls).toBe(true);
  });

  it("omits allowSelfSignedTls from the init when not opted in", async () => {
    let seen: FetchInit | null = null;
    harness.fetchStub.on("/rest/api/2/myself", (init) => {
      seen = init;
      return { name: "alice" };
    });

    await jiraFetch({ instance: "https://jira.acme.example", pat: "tok" }, "/rest/api/2/myself");

    expect(seen).not.toBeNull();
    expect((seen as unknown as FetchInit).allowSelfSignedTls).toBeUndefined();
  });

  it("refuses a path that would resolve to a host other than the instance", async () => {
    await expect(
      jiraFetch(
        { instance: "https://jira.acme.example", pat: "tok" },
        "https://evil.example/steal",
      ),
    ).rejects.toBeInstanceOf(JiraApiError);
  });
});
