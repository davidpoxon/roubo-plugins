import { describe, it, expect } from "vitest";
import { getSortFields } from "../methods/get-sort-fields.js";

describe("getSortFields", () => {
  it("declares created/updated/comments and no native key sort (CLI-FR-009/CLI-FR-014)", () => {
    expect(getSortFields()).toEqual([
      { id: "created", label: "Created", defaultDir: "desc" },
      { id: "updated", label: "Updated", defaultDir: "desc" },
      { id: "comments", label: "Comments", defaultDir: "desc" },
    ]);
  });

  it("offers no 'key' sort field (GitHub has no canonical issue key, CLI-FR-014)", () => {
    expect(getSortFields().some((f) => f.id === "key")).toBe(false);
  });
});
