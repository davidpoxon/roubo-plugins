import { describe, expect, it } from "vitest";
import { parseSourcesConfig } from "../parse-sources.js";

// Canonical input/output shared with the github-com counterpart test
// (`plugins/github-com/src/__tests__/parse-sources.test.ts`). Both plugins
// must return the same parsed shape so the host can treat their
// source-config payloads identically (WU-037 acceptance criterion 3).
const CANONICAL_ALERTS_INPUT = {
  sources: [
    {
      kind: "repo",
      externalId: "owner/repo",
      includeCodeQLAlerts: true,
      includeSecretScanningAlerts: false,
      includeDependabotAlerts: true,
    },
  ],
};

const CANONICAL_ALERTS_PARSED = {
  sources: [
    {
      kind: "repo",
      externalId: "owner/repo",
      includeCodeQLAlerts: true,
      includeSecretScanningAlerts: false,
      includeDependabotAlerts: true,
    },
  ],
};

describe("ghe parseSourcesConfig: per-source alert booleans (FR-074)", () => {
  it("parses a source with all three alert booleans set into the canonical shape", () => {
    const { config, errors } = parseSourcesConfig(CANONICAL_ALERTS_INPUT);
    expect(errors).toEqual([]);
    expect(config).toEqual(CANONICAL_ALERTS_PARSED);
  });

  it("omits the booleans on the parsed entry when the input omits them", () => {
    const { config, errors } = parseSourcesConfig({
      sources: [{ kind: "repo", externalId: "owner/repo" }],
    });
    expect(errors).toEqual([]);
    expect(config).toEqual({ sources: [{ kind: "repo", externalId: "owner/repo" }] });
  });

  it("preserves false values explicitly", () => {
    const { config, errors } = parseSourcesConfig({
      sources: [
        {
          kind: "repo",
          externalId: "owner/repo",
          includeCodeQLAlerts: false,
          includeSecretScanningAlerts: false,
          includeDependabotAlerts: false,
        },
      ],
    });
    expect(errors).toEqual([]);
    expect(config?.sources[0]).toEqual({
      kind: "repo",
      externalId: "owner/repo",
      includeCodeQLAlerts: false,
      includeSecretScanningAlerts: false,
      includeDependabotAlerts: false,
    });
  });

  it("emits a field-scoped error when includeCodeQLAlerts is not a boolean", () => {
    const { config, errors } = parseSourcesConfig({
      sources: [{ kind: "repo", externalId: "owner/repo", includeCodeQLAlerts: "yes" }],
    });
    expect(config).toBeNull();
    expect(errors).toContainEqual({
      field: "sources[0].includeCodeQLAlerts",
      message: "must be a boolean",
    });
  });

  it("emits a field-scoped error when includeSecretScanningAlerts is not a boolean", () => {
    const { config, errors } = parseSourcesConfig({
      sources: [{ kind: "repo", externalId: "owner/repo", includeSecretScanningAlerts: 1 }],
    });
    expect(config).toBeNull();
    expect(errors).toContainEqual({
      field: "sources[0].includeSecretScanningAlerts",
      message: "must be a boolean",
    });
  });

  it("emits a field-scoped error when includeDependabotAlerts is not a boolean", () => {
    const { config, errors } = parseSourcesConfig({
      sources: [{ kind: "repo", externalId: "owner/repo", includeDependabotAlerts: null }],
    });
    expect(config).toBeNull();
    expect(errors).toContainEqual({
      field: "sources[0].includeDependabotAlerts",
      message: "must be a boolean",
    });
  });
});
