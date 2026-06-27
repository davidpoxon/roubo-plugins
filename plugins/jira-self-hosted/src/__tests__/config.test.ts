import { describe, expect, it } from "vitest";
import { parseFormConfig, parseIntegrationConfig } from "../config.js";

describe("parseFormConfig", () => {
  it("accepts the Configure-dialog form payload and applies defaults", () => {
    const result = parseFormConfig({
      instance: "https://jira.acme.example",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual({
      instance: "https://jira.acme.example",
      blocksLinkTypeName: "blocks",
      isBlockedByLinkTypeName: "is blocked by",
      allowSelfSignedTls: false,
    });
  });

  it("reads allowSelfSignedTls from the flat form payload", () => {
    const result = parseFormConfig({
      instance: "https://jira.acme.example",
      allowSelfSignedTls: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.allowSelfSignedTls).toBe(true);
  });

  it("treats a non-true allowSelfSignedTls as false", () => {
    const result = parseFormConfig({
      instance: "https://jira.acme.example",
      allowSelfSignedTls: "yes",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.allowSelfSignedTls).toBe(false);
  });

  it("strips a trailing slash from the instance URL", () => {
    const result = parseFormConfig({ instance: "https://jira.acme.example/" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.instance).toBe("https://jira.acme.example");
  });

  it("rejects an empty instance URL with a structured error", () => {
    const result = parseFormConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toEqual({
      field: "instance",
      message: "Jira instance URL is required.",
    });
  });

  it("rejects non-http(s) URLs", () => {
    const result = parseFormConfig({ instance: "ftp://jira.acme.example" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].field).toBe("instance");
  });

  it("rejects malformed URLs", () => {
    const result = parseFormConfig({ instance: "not-a-url" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].field).toBe("instance");
  });
});

describe("parseIntegrationConfig", () => {
  it("reads link-type overrides out of the advanced sub-object", () => {
    const result = parseIntegrationConfig({
      instance: "https://jira.acme.example",
      advanced: {
        blocksLinkTypeName: "depends on",
        isBlockedByLinkTypeName: "is depended on by",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.blocksLinkTypeName).toBe("depends on");
    expect(result.config.isBlockedByLinkTypeName).toBe("is depended on by");
  });

  it("falls back to defaults when advanced is absent", () => {
    const result = parseIntegrationConfig({ instance: "https://jira.acme.example" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.blocksLinkTypeName).toBe("blocks");
    expect(result.config.isBlockedByLinkTypeName).toBe("is blocked by");
    expect(result.config.allowSelfSignedTls).toBe(false);
  });

  it("reads allowSelfSignedTls from the advanced sub-object", () => {
    const result = parseIntegrationConfig({
      instance: "https://jira.acme.example",
      advanced: { allowSelfSignedTls: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.allowSelfSignedTls).toBe(true);
  });
});
