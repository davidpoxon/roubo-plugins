import { beforeEach, describe, expect, it } from "vitest";
import {
  getActiveConfig,
  parseConfig,
  setActiveConfig,
  tryGetActiveConfig,
} from "../active-config.js";
import { requirePrimarySource } from "../sources.js";

const VALID_INSTANCE = "https://ghe.example.com";

describe("active-config", () => {
  beforeEach(() => {
    setActiveConfig(null);
  });

  describe("parseConfig", () => {
    it("returns a typed plugin-wide config on the happy path", () => {
      const { config, errors } = parseConfig({ instance: VALID_INSTANCE });
      expect(errors).toEqual([]);
      expect(config).toEqual({ instance: VALID_INSTANCE, allowSelfSignedTls: false });
    });

    it("accepts allowSelfSignedTls=true and strips a trailing slash from instance", () => {
      const { config, errors } = parseConfig({
        instance: `${VALID_INSTANCE}/`,
        allowSelfSignedTls: true,
      });
      expect(errors).toEqual([]);
      expect(config).toEqual({ instance: VALID_INSTANCE, allowSelfSignedTls: true });
    });

    it("rejects missing instance", () => {
      const { config, errors } = parseConfig({});
      expect(config).toBeNull();
      expect(errors).toContainEqual({
        field: "instance",
        message: "instance must be a non-empty string",
      });
    });

    it("rejects non-http(s) instance", () => {
      const { config, errors } = parseConfig({ instance: "ftp://ghe.example.com" });
      expect(config).toBeNull();
      expect(errors).toContainEqual({
        field: "instance",
        message: "instance must be an http(s) URL",
      });
    });

    it("rejects a malformed instance URL", () => {
      const { config, errors } = parseConfig({ instance: "not a url" });
      expect(config).toBeNull();
      expect(errors).toContainEqual({
        field: "instance",
        message: "instance is not a valid URL",
      });
    });

    it("rejects a non-boolean allowSelfSignedTls", () => {
      const { config, errors } = parseConfig({
        instance: VALID_INSTANCE,
        allowSelfSignedTls: "yes",
      });
      expect(config).toBeNull();
      expect(errors).toContainEqual({
        field: "allowSelfSignedTls",
        message: "must be a boolean",
      });
    });

    it("ignores any host-supplied sources field (sources flow per-call now)", () => {
      const { config, errors } = parseConfig({
        instance: VALID_INSTANCE,
        sources: [{ kind: "repo", externalId: "foo/bar" }],
      });
      expect(errors).toEqual([]);
      expect(config).toEqual({ instance: VALID_INSTANCE, allowSelfSignedTls: false });
    });
  });

  it("getActiveConfig throws before setActiveConfig is called", () => {
    expect(() => getActiveConfig()).toThrow(/No active configuration/);
    expect(tryGetActiveConfig()).toBeNull();
  });

  describe("requirePrimarySource", () => {
    it("returns the first source", () => {
      expect(
        requirePrimarySource([
          { kind: "repo", externalId: "foo/bar" },
          { kind: "project", externalId: "foo/#1" },
        ]),
      ).toEqual({ kind: "repo", externalId: "foo/bar" });
    });

    it("throws when sources is empty", () => {
      expect(() => requirePrimarySource([])).toThrow(/sources is required/);
    });
  });
});
