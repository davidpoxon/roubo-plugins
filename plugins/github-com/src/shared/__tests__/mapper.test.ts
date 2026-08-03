import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RawCodeScanningAlert } from "../alerts/code-scanning.js";
import type { RawDependabotAlert } from "../alerts/dependabot.js";
import type { RawSecretScanningAlert } from "../alerts/secret-scanning.js";
import {
  CODE_SCANNING_ISSUE_TYPE,
  DEPENDABOT_ISSUE_TYPE,
  SECRET_SCANNING_ISSUE_TYPE,
  mapCodeScanningAlertToNormalizedIssue,
  mapDependabotAlertToNormalizedIssue,
  mapSecretScanningAlertToNormalizedIssue,
  normalizeAlertState,
} from "../mapper.js";

function loadFixture<T>(name: string): T {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const SECRET_LITERAL = "ghp_AAAA1111BBBB2222CCCC3333";
const CODE_SNIPPET = "const q = `SELECT * FROM users WHERE id = ${userId}`;";

describe("mapCodeScanningAlertToNormalizedIssue", () => {
  it("produces the documented issueType, external-id, and empty transitions/assignees (FR-048)", () => {
    const [raw] = loadFixture<RawCodeScanningAlert[]>("code-scanning-page1.json");
    const out = mapCodeScanningAlertToNormalizedIssue("github-com", "wday-planning/roubo", raw);
    expect(out.integrationId).toBe("github-com");
    expect(out.issueType).toBe(CODE_SCANNING_ISSUE_TYPE);
    expect(out.externalId).toBe("wday-planning/roubo#code-scanning-42");
    expect(out.allowedTransitions).toEqual([]);
    expect(out.assignees).toEqual([]);
    expect(out.currentState).toBe("open");
    expect(out.body).toBeNull();
    expect(out.title).toBe("Database query built from user-controlled sources");
  });

  it("stores the redacted alert (snippet absent) in raw", () => {
    const [raw] = loadFixture<RawCodeScanningAlert[]>("code-scanning-page1.json");
    const out = mapCodeScanningAlertToNormalizedIssue("github-com", "wday-planning/roubo", raw);
    expect(JSON.stringify(out.raw)).not.toContain(CODE_SNIPPET);
  });

  it("uses updated_at when present, else created_at", () => {
    const raw: RawCodeScanningAlert = {
      number: 9,
      html_url: "u",
      state: "open",
      created_at: "2026-01-01T00:00:00Z",
    };
    expect(mapCodeScanningAlertToNormalizedIssue("github-com", "foo/bar", raw).updatedAt).toBe(
      "2026-01-01T00:00:00Z",
    );
  });
});

describe("mapSecretScanningAlertToNormalizedIssue", () => {
  it("produces the documented issueType, external-id, and empty transitions/assignees (FR-048)", () => {
    const [raw] = loadFixture<RawSecretScanningAlert[]>("secret-scanning-page1.json");
    const out = mapSecretScanningAlertToNormalizedIssue("ghe", "wday-planning/roubo", raw);
    expect(out.integrationId).toBe("ghe");
    expect(out.issueType).toBe(SECRET_SCANNING_ISSUE_TYPE);
    expect(out.externalId).toBe("wday-planning/roubo#secret-scanning-7");
    expect(out.allowedTransitions).toEqual([]);
    expect(out.assignees).toEqual([]);
    expect(out.title).toBe("GitHub Personal Access Token");
  });

  it("never lets the secret literal reach raw via the mapper", () => {
    const [raw] = loadFixture<RawSecretScanningAlert[]>("secret-scanning-page1.json");
    const out = mapSecretScanningAlertToNormalizedIssue("github-com", "wday-planning/roubo", raw);
    expect(JSON.stringify(out.raw)).not.toContain(SECRET_LITERAL);
  });
});

describe("mapDependabotAlertToNormalizedIssue", () => {
  it("produces the documented issueType, external-id, and empty transitions/assignees (FR-048)", () => {
    const [raw] = loadFixture<RawDependabotAlert[]>("dependabot-page1.json");
    const out = mapDependabotAlertToNormalizedIssue("github-com", "wday-planning/roubo", raw);
    expect(out.issueType).toBe(DEPENDABOT_ISSUE_TYPE);
    expect(out.externalId).toBe("wday-planning/roubo#dependabot-11");
    expect(out.allowedTransitions).toEqual([]);
    expect(out.assignees).toEqual([]);
    expect(out.title).toBe("Prototype pollution in left-pad");
  });
});

describe("stable external-id across repeated mapping (AC#7)", () => {
  it("returns the same external-id when the same alert is mapped twice", () => {
    const [raw] = loadFixture<RawCodeScanningAlert[]>("code-scanning-page1.json");
    const first = mapCodeScanningAlertToNormalizedIssue("github-com", "wday-planning/roubo", raw);
    const second = mapCodeScanningAlertToNormalizedIssue("github-com", "wday-planning/roubo", raw);
    expect(first.externalId).toBe(second.externalId);
  });
});

describe("normalizeAlertState (#289)", () => {
  it("passes open and fixed through unchanged", () => {
    expect(normalizeAlertState("open")).toBe("open");
    expect(normalizeAlertState("fixed")).toBe("fixed");
  });

  it("folds the terminal variants into dismissed", () => {
    expect(normalizeAlertState("dismissed")).toBe("dismissed");
    expect(normalizeAlertState("auto_dismissed")).toBe("dismissed"); // dependabot
    expect(normalizeAlertState("resolved")).toBe("dismissed"); // secret-scanning
  });

  it("falls back to open for missing or unknown values", () => {
    expect(normalizeAlertState(undefined)).toBe("open");
    expect(normalizeAlertState(null)).toBe("open");
    expect(normalizeAlertState("")).toBe("open");
    expect(normalizeAlertState("something-new")).toBe("open");
  });
});

describe("currentState reflects the alert lifecycle (#289)", () => {
  it("code-scanning: maps raw fixed/dismissed/open into currentState", () => {
    const base: RawCodeScanningAlert = {
      number: 1,
      html_url: "u",
      state: "open",
      created_at: "2026-01-01T00:00:00Z",
    };
    expect(
      mapCodeScanningAlertToNormalizedIssue("github-com", "foo/bar", { ...base, state: "open" })
        .currentState,
    ).toBe("open");
    expect(
      mapCodeScanningAlertToNormalizedIssue("github-com", "foo/bar", { ...base, state: "fixed" })
        .currentState,
    ).toBe("fixed");
    expect(
      mapCodeScanningAlertToNormalizedIssue("github-com", "foo/bar", {
        ...base,
        state: "dismissed",
      }).currentState,
    ).toBe("dismissed");
  });

  it("secret-scanning: maps raw resolved into dismissed", () => {
    const base: RawSecretScanningAlert = {
      number: 2,
      html_url: "u",
      state: "open",
      created_at: "2026-01-01T00:00:00Z",
    };
    expect(
      mapSecretScanningAlertToNormalizedIssue("github-com", "foo/bar", { ...base, state: "open" })
        .currentState,
    ).toBe("open");
    expect(
      mapSecretScanningAlertToNormalizedIssue("github-com", "foo/bar", {
        ...base,
        state: "resolved",
      }).currentState,
    ).toBe("dismissed");
  });

  it("dependabot: maps raw auto_dismissed/fixed into currentState", () => {
    const base: RawDependabotAlert = {
      number: 3,
      html_url: "u",
      state: "open",
      created_at: "2026-01-01T00:00:00Z",
    };
    expect(
      mapDependabotAlertToNormalizedIssue("github-com", "foo/bar", { ...base, state: "open" })
        .currentState,
    ).toBe("open");
    expect(
      mapDependabotAlertToNormalizedIssue("github-com", "foo/bar", { ...base, state: "fixed" })
        .currentState,
    ).toBe("fixed");
    expect(
      mapDependabotAlertToNormalizedIssue("github-com", "foo/bar", {
        ...base,
        state: "auto_dismissed",
      }).currentState,
    ).toBe("dismissed");
  });
});
