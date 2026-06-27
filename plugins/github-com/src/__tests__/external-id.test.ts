import { describe, expect, it } from "vitest";
import { formatExternalId, parseExternalId } from "../external-id.js";

describe("external-id", () => {
  it("round-trips owner/repo#number", () => {
    expect(parseExternalId(formatExternalId("foo/bar", 42))).toEqual({
      repoFullName: "foo/bar",
      issueNumber: 42,
    });
  });

  it("rejects missing hash separator", () => {
    expect(() => parseExternalId("foo/bar/42")).toThrow(/missing "#/);
  });

  it("rejects missing owner/repo segment", () => {
    expect(() => parseExternalId("bar#42")).toThrow(/expected "owner\/repo#/);
  });

  it("rejects non-positive issue numbers", () => {
    expect(() => parseExternalId("foo/bar#0")).toThrow(/positive-int/);
    expect(() => parseExternalId("foo/bar#-1")).toThrow(/positive-int/);
    expect(() => parseExternalId("foo/bar#abc")).toThrow(/positive-int/);
  });
});
