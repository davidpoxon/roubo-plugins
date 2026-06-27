import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPluginContract, _resetForTests } from "../plugin.js";
import { installHostHarness, type HostHarness } from "./helpers/host-stub.js";

const INSTANCE = "https://jira.acme.example";

describe("listStatusCategories discovery (issue #453)", () => {
  let harness: HostHarness;

  beforeEach(async () => {
    _resetForTests();
    harness = installHostHarness(createPluginContract());
    harness.credentials.set("pat", "test-token");
    harness.fetchStub.on("/rest/api/2/myself", () => ({ displayName: "Anna" }));
    await harness.hostConnection.sendRequest("validateConfig", {
      config: { instance: INSTANCE, pat: "test-token" },
    });
  });
  afterEach(() => {
    harness.dispose();
    _resetForTests();
  });

  it("returns the instance's status-category names", async () => {
    harness.fetchStub.on("/rest/api/2/statuscategory", () => [
      { id: 1, key: "undefined", name: "No Category" },
      { id: 2, key: "new", name: "To Do" },
      { id: 4, key: "indeterminate", name: "In Progress" },
      { id: 3, key: "done", name: "Done" },
    ]);

    const result = await harness.hostConnection.sendRequest<string[]>("listStatusCategories", {});

    expect(result).toEqual(["No Category", "To Do", "In Progress", "Done"]);
  });

  it("drops empty/whitespace names and dedupes", async () => {
    harness.fetchStub.on("/rest/api/2/statuscategory", () => [
      { id: 2, key: "new", name: "To Do" },
      { id: 9, key: "blank", name: "  " },
      { id: 10, key: "noname" },
      { id: 3, key: "done", name: "Done" },
      { id: 11, key: "dupe", name: "Done" },
    ]);

    const result = await harness.hostConnection.sendRequest<string[]>("listStatusCategories", {});

    expect(result).toEqual(["To Do", "Done"]);
  });
});
