import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FilterFacet, FilterFacetOption } from "@roubo/plugin-sdk";
import { createPluginContract } from "../plugin.js";
import { installHostHarness, type HostHarness } from "./helpers/host-stub.js";

describe("filterFacets + getFacetOptions (jira-self-hosted)", () => {
  let harness: HostHarness;

  beforeEach(() => {
    harness = installHostHarness(createPluginContract());
    harness.credentials.set("pat", "test-token");
  });
  afterEach(() => {
    harness.dispose();
  });

  async function adoptConfig(): Promise<void> {
    harness.fetchStub.on("/rest/api/2/myself", () => ({ displayName: "Anna" }));
    await harness.hostConnection.sendRequest("validateConfig", {
      config: { instance: "https://jira.acme.example", pat: "test-token" },
    });
  }

  it("filterFacets returns the Epic enum-async facet (FR-065)", async () => {
    const facets = await harness.hostConnection.sendRequest<FilterFacet[]>(
      "filterFacets",
      undefined,
    );
    expect(facets).toEqual([{ id: "epic", label: "Epic", type: "enum-async" }]);
  });

  it("getFacetOptions(epic) returns unresolved Epics as FilterFacetOption[]", async () => {
    await adoptConfig();
    harness.fetchStub.on("/rest/api/2/search", () => ({
      issues: [
        { key: "PROJ-100", fields: { summary: "Platform Q2" } },
        { key: "PROJ-101", fields: { summary: "Performance" } },
      ],
    }));

    const options = await harness.hostConnection.sendRequest<FilterFacetOption[]>(
      "getFacetOptions",
      { facetId: "epic", sources: [] },
    );
    expect(options).toEqual([
      { value: "PROJ-100", label: "Platform Q2" },
      { value: "PROJ-101", label: "Performance" },
    ]);
  });

  it("getFacetOptions(epic) applies a case-insensitive search across label and key", async () => {
    await adoptConfig();
    harness.fetchStub.on("/rest/api/2/search", () => ({
      issues: [
        { key: "PROJ-100", fields: { summary: "Platform Q2" } },
        { key: "PROJ-101", fields: { summary: "Performance" } },
        { key: "OTHER-7", fields: { summary: "Misc" } },
      ],
    }));

    const byLabel = await harness.hostConnection.sendRequest<FilterFacetOption[]>(
      "getFacetOptions",
      { facetId: "epic", sources: [], search: "perf" },
    );
    expect(byLabel).toEqual([{ value: "PROJ-101", label: "Performance" }]);

    const byKey = await harness.hostConnection.sendRequest<FilterFacetOption[]>("getFacetOptions", {
      facetId: "epic",
      sources: [],
      search: "proj-10",
    });
    expect(byKey).toEqual([
      { value: "PROJ-100", label: "Platform Q2" },
      { value: "PROJ-101", label: "Performance" },
    ]);
  });

  it("getFacetOptions returns [] for unknown facetIds", async () => {
    // No config adopted: unknown facet must short-circuit before touching the network.
    const options = await harness.hostConnection.sendRequest<FilterFacetOption[]>(
      "getFacetOptions",
      { facetId: "unknown", sources: [] },
    );
    expect(options).toEqual([]);
  });
});
