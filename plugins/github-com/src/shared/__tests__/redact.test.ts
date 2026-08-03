import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  redactCodeScanningAlert,
  redactSecretScanningAlert,
  SECRET_REDACTION_MARKER,
} from "../redact.js";
import type { RawCodeScanningAlert } from "../alerts/code-scanning.js";
import type { RawSecretScanningAlert } from "../alerts/secret-scanning.js";

function loadFixture<T>(name: string): T {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const codeScanningPage1 = loadFixture<RawCodeScanningAlert[]>("code-scanning-page1.json");
const secretScanningPage1 = loadFixture<RawSecretScanningAlert[]>("secret-scanning-page1.json");

const SECRET_LITERAL = "ghp_AAAA1111BBBB2222CCCC3333";
const CODE_SNIPPET = "const q = `SELECT * FROM users WHERE id = ${userId}`;";

describe("redactSecretScanningAlert (TC-088)", () => {
  it("retains first 4 chars + marker and removes the literal secret", () => {
    const [raw] = secretScanningPage1;
    expect(raw.secret).toBe(SECRET_LITERAL);
    const redacted = redactSecretScanningAlert(raw);
    expect(redacted.secret).toBe(`ghp_${SECRET_REDACTION_MARKER}`);
    expect(JSON.stringify(redacted)).not.toContain(SECRET_LITERAL);
  });

  it("does not mutate the input alert", () => {
    const [raw] = secretScanningPage1;
    const before = JSON.stringify(raw);
    redactSecretScanningAlert(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("handles secrets shorter than the prefix length", () => {
    const redacted = redactSecretScanningAlert({
      number: 1,
      html_url: "u",
      state: "open",
      created_at: "t",
      secret: "abc",
    });
    expect(redacted.secret).toBe(`abc${SECRET_REDACTION_MARKER}`);
  });

  it("scrubs the literal from other top-level string fields", () => {
    const redacted = redactSecretScanningAlert({
      number: 1,
      html_url: "u",
      state: "open",
      created_at: "t",
      secret: SECRET_LITERAL,
      note: `leaked ${SECRET_LITERAL} please rotate`,
    } as unknown as RawSecretScanningAlert);
    expect(JSON.stringify(redacted)).not.toContain(SECRET_LITERAL);
  });
});

describe("redactCodeScanningAlert (TC-089)", () => {
  it("strips snippet from most_recent_instance.location and keeps path + line", () => {
    const [raw] = codeScanningPage1;
    expect(raw.most_recent_instance?.location?.snippet).toBe(CODE_SNIPPET);
    const redacted = redactCodeScanningAlert(raw);
    expect(redacted.most_recent_instance?.location?.snippet).toBeUndefined();
    expect(redacted.most_recent_instance?.location?.path).toBe("server/services/database.ts");
    expect(redacted.most_recent_instance?.location?.start_line).toBe(84);
    expect(redacted.most_recent_instance?.location?.end_line).toBe(84);
    expect(JSON.stringify(redacted)).not.toContain(CODE_SNIPPET);
  });

  it("strips snippet from every entry in instances[]", () => {
    const [raw] = codeScanningPage1;
    const redacted = redactCodeScanningAlert(raw);
    for (const inst of redacted.instances ?? []) {
      expect(inst.location?.snippet).toBeUndefined();
    }
  });

  it("does not mutate the input alert", () => {
    const [raw] = codeScanningPage1;
    const before = JSON.stringify(raw);
    redactCodeScanningAlert(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe("stdout / stderr cleanliness (AC#5)", () => {
  let stdoutSpy: MockInstance<typeof process.stdout.write>;
  let stderrSpy: MockInstance<typeof process.stderr.write>;
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;
  let warnSpy: MockInstance<typeof console.warn>;
  let infoSpy: MockInstance<typeof console.info>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function assertNoLeak(literal: string): void {
    for (const spy of [stdoutSpy, stderrSpy, logSpy, errSpy, warnSpy, infoSpy]) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          if (typeof arg === "string" && arg.includes(literal)) {
            throw new Error(`stdio call leaked literal: ${arg}`);
          }
          if (arg instanceof Uint8Array) {
            const text = Buffer.from(arg).toString("utf8");
            if (text.includes(literal)) {
              throw new Error(`stdio call leaked literal (binary)`);
            }
          }
        }
      }
    }
  }

  it("runs the secret-scanning redaction without leaking the secret to any stdio stream", () => {
    const [raw] = secretScanningPage1;
    redactSecretScanningAlert(raw);
    assertNoLeak(SECRET_LITERAL);
  });

  it("runs the code-scanning redaction without leaking the snippet to any stdio stream", () => {
    const [raw] = codeScanningPage1;
    redactCodeScanningAlert(raw);
    assertNoLeak(CODE_SNIPPET);
  });
});
