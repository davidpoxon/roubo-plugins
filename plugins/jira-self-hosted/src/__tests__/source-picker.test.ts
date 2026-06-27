import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceCandidatesResponse } from "@roubo/plugin-sdk";
import type { JiraRequestContext } from "../jira-client.js";
import { fetchEpicIssues } from "../source-picker.js";
import { createPluginContract } from "../plugin.js";
import { installHostHarness, type HostHarness } from "./helpers/host-stub.js";

const ctx: JiraRequestContext = { instance: "https://jira.acme.example", pat: "tok" };

describe("fetchEpicIssues (cut-list Epic facet loader)", () => {
  let harness: HostHarness;

  beforeEach(() => {
    harness = installHostHarness();
  });
  afterEach(() => harness.dispose());

  it("returns unresolved epics that carry a string key", async () => {
    harness.fetchStub.on("/rest/api/2/search", () => ({
      issues: [
        { key: "PROJ-100", fields: { summary: "Platform Q2" } },
        { fields: { summary: "missing key" } },
      ],
    }));
    const issues = await fetchEpicIssues(ctx);
    expect(issues).toEqual([{ key: "PROJ-100", fields: { summary: "Platform Q2" } }]);
  });

  it("returns [] on transport / auth failure", async () => {
    harness.fetchStub.on("/rest/api/2/search", () => {
      throw new Error("forbidden");
    });
    expect(await fetchEpicIssues(ctx)).toEqual([]);
  });

  it("excludes resolved epics by constraining the JQL to resolution = Unresolved (FR-015)", async () => {
    let capturedUrl = "";
    harness.fetchStub.on("/rest/api/2/search", (_init, url) => {
      capturedUrl = url;
      return { issues: [] };
    });
    await fetchEpicIssues(ctx);
    const jql = new URL(capturedUrl).searchParams.get("jql") ?? "";
    expect(jql).toContain("issuetype = Epic");
    expect(jql).toContain("resolution = Unresolved");
  });
});

describe("listSourceCandidates (searchable-categorized shape, WU-002)", () => {
  let harness: HostHarness;

  beforeEach(() => {
    harness = installHostHarness(createPluginContract());
  });
  afterEach(() => {
    harness.dispose();
  });

  it("declares the searchable categories and loads no items inline", async () => {
    const res = await harness.hostConnection.sendRequest<SourceCandidatesResponse>(
      "listSourceCandidates",
      { config: { instance: "https://jira.acme.example" } },
    );

    expect(res.shape).toBe("searchable-categorized");
    expect(res.items).toBeUndefined();
    expect(res.categories).toBeUndefined();
    expect(res.searchableCategories?.map((c) => c.id)).toEqual([
      "project",
      "board",
      "filter",
      "epic",
      "mine",
    ]);

    const board = res.searchableCategories?.find((c) => c.id === "board");
    expect(board?.scopedBy).toBe("project");

    const mine = res.searchableCategories?.find((c) => c.id === "mine");
    expect(mine?.scopedBy).toBeUndefined();
    expect(mine?.options?.map((o) => o.id)).toEqual(["in-project", "anywhere"]);
  });
});
