import { describe, expect, it } from "vitest";
import { isStatusExcluded } from "../status-exclusion.js";

describe("isStatusExcluded (issue #399)", () => {
  const EXCLUDED = ["Closed", "Done", "Resolved", "In review", "PR open"];

  it("never excludes when the exclusion list is empty or undefined", () => {
    expect(isStatusExcluded("Done", [])).toBe(false);
    expect(isStatusExcluded("Done", undefined)).toBe(false);
  });

  it("never excludes a null, empty, or whitespace-only status name", () => {
    expect(isStatusExcluded(null, EXCLUDED)).toBe(false);
    expect(isStatusExcluded(undefined, EXCLUDED)).toBe(false);
    expect(isStatusExcluded("", EXCLUDED)).toBe(false);
    expect(isStatusExcluded("   ", EXCLUDED)).toBe(false);
  });

  it("excludes an exact match", () => {
    expect(isStatusExcluded("Done", EXCLUDED)).toBe(true);
    expect(isStatusExcluded("In review", EXCLUDED)).toBe(true);
  });

  it("matches case-insensitively and trims surrounding whitespace", () => {
    expect(isStatusExcluded(" in REVIEW ", EXCLUDED)).toBe(true);
    expect(isStatusExcluded("done", EXCLUDED)).toBe(true);
    expect(isStatusExcluded("PR OPEN", EXCLUDED)).toBe(true);
    expect(isStatusExcluded("Resolved", ["  resolved  "])).toBe(true);
  });

  it("does not exclude a status name absent from the list", () => {
    expect(isStatusExcluded("In progress", EXCLUDED)).toBe(false);
    expect(isStatusExcluded("Backlog", EXCLUDED)).toBe(false);
  });
});
