import { describe, it, expect } from "vitest";
import { filterFacets } from "../methods/filter-facets.js";

describe("filterFacets", () => {
  it("returns the full cut-list facet set", () => {
    expect(filterFacets()).toEqual([
      { id: "type", label: "Type", type: "enum-async" },
      { id: "label", label: "Label", type: "enum-async" },
      { id: "status", label: "Status", type: "enum" },
      { id: "assignee", label: "Assignee", type: "enum-async" },
      { id: "milestone", label: "Milestone", type: "enum-async" },
    ]);
  });
});
