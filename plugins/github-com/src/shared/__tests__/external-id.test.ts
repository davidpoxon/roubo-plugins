import { describe, expect, it } from "vitest";
import {
  ALERT_CATEGORIES,
  formatAlertExternalId,
  formatIssueExternalId,
  parseGithubExternalId,
  parseGithubIssueExternalId,
} from "../external-id.js";

describe("external-id", () => {
  it.each(ALERT_CATEGORIES)("formats and round-trips %s alerts", (category) => {
    const id = formatAlertExternalId("wday-planning/roubo", category, 17);
    expect(id).toBe(`wday-planning/roubo#${category}-17`);
    expect(parseGithubExternalId(id)).toEqual({
      kind: "alert",
      repoFullName: "wday-planning/roubo",
      category,
      alertNumber: 17,
    });
  });

  it("parses the legacy issue form", () => {
    expect(parseGithubExternalId("foo/bar#42")).toEqual({
      kind: "issue",
      repoFullName: "foo/bar",
      issueNumber: 42,
    });
  });

  it("keeps Issue #17 and code-scanning alert #17 on the same repo distinct (TC-090)", () => {
    const issueId = "wday-planning/roubo#17";
    const alertId = formatAlertExternalId("wday-planning/roubo", "code-scanning", 17);
    expect(issueId).not.toBe(alertId);
    const parsedIssue = parseGithubExternalId(issueId);
    const parsedAlert = parseGithubExternalId(alertId);
    expect(parsedIssue.kind).toBe("issue");
    expect(parsedAlert.kind).toBe("alert");
    expect(parsedIssue).not.toEqual(parsedAlert);
  });

  it("produces a stable id across repeated formatter calls (AC#7)", () => {
    const first = formatAlertExternalId("foo/bar", "secret-scanning", 3);
    const second = formatAlertExternalId("foo/bar", "secret-scanning", 3);
    expect(first).toBe(second);
  });

  it("rejects ids missing the # separator", () => {
    expect(() => parseGithubExternalId("foo/bar/42")).toThrow(/missing "#/);
  });

  it("rejects ids missing the owner/repo segment", () => {
    expect(() => parseGithubExternalId("bar#42")).toThrow(/missing "owner\/repo"/);
  });

  it("rejects non-positive issue numbers", () => {
    expect(() => parseGithubExternalId("foo/bar#0")).toThrow(/positive-int/);
    expect(() => parseGithubExternalId("foo/bar#-1")).toThrow(/positive-int/);
    expect(() => parseGithubExternalId("foo/bar#abc")).toThrow(/positive-int/);
  });

  it("rejects unknown category prefixes", () => {
    expect(() => parseGithubExternalId("foo/bar#bogus-7")).toThrow(/positive-int/);
  });

  it("rejects alert ids with non-positive numbers", () => {
    expect(() => parseGithubExternalId("foo/bar#code-scanning-0")).toThrow(/positive integer/);
  });

  it("round-trips the issue form through the issue formatter", () => {
    expect(formatIssueExternalId("foo/bar", 42)).toBe("foo/bar#42");
    expect(parseGithubIssueExternalId(formatIssueExternalId("foo/bar", 42))).toEqual({
      repoFullName: "foo/bar",
      issueNumber: 42,
    });
  });

  it("rejects the alert form where an issue number is expected", () => {
    expect(() => parseGithubIssueExternalId("foo/bar#code-scanning-5")).toThrow(
      /externalId .* alert, but an issue number was expected/,
    );
  });

  it("propagates the parser's rejections through the issue-only wrapper", () => {
    expect(() => parseGithubIssueExternalId("foo/bar/42")).toThrow(/missing "#/);
    expect(() => parseGithubIssueExternalId("bar#42")).toThrow(/missing "owner\/repo"/);
    expect(() => parseGithubIssueExternalId("foo/bar#0")).toThrow(/positive-int/);
  });
});
