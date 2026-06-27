import type { CodeScanningLocation, RawCodeScanningAlert } from "./alerts/code-scanning.js";
import type { RawSecretScanningAlert } from "./alerts/secret-scanning.js";

// Per FR-043 / NFR-012: Roubo never sees the leaked secret itself. We retain
// only enough of the literal to help a human recognise the alert in the UI
// (the first 4 characters of a token preserve the recognisable prefix like
// `ghp_`, `sk_l`, `xoxb`, etc.) and append a fixed marker so callers can
// detect at a glance that the value has been redacted.
export const SECRET_REDACTION_MARKER = "***REDACTED***";

function redactSecretLiteral(secret: string): string {
  if (secret.length <= 4) return secret + SECRET_REDACTION_MARKER;
  return secret.slice(0, 4) + SECRET_REDACTION_MARKER;
}

/**
 * Returns a redacted clone of a Secret Scanning alert suitable for placing in
 * `NormalizedIssue.raw`. The input object is not mutated.
 */
export function redactSecretScanningAlert(raw: RawSecretScanningAlert): RawSecretScanningAlert {
  const clone: RawSecretScanningAlert = { ...raw };
  if (typeof clone.secret === "string" && clone.secret.length > 0) {
    clone.secret = redactSecretLiteral(clone.secret);
  }
  // Defence in depth: scrub any other top-level string field that contains the
  // verbatim secret. The Secret Scanning API does not officially document any
  // such second copy today, but if one is ever added (or surfaced through an
  // experimental field) we still want to keep the literal out of `raw`.
  if (typeof raw.secret === "string" && raw.secret.length > 0) {
    const literal = raw.secret;
    const redacted = redactSecretLiteral(literal);
    for (const key of Object.keys(clone)) {
      const value = clone[key];
      if (typeof value === "string" && key !== "secret" && value.includes(literal)) {
        clone[key] = value.split(literal).join(redacted);
      }
    }
  }
  return clone;
}

function redactLocation(loc: CodeScanningLocation | undefined): CodeScanningLocation | undefined {
  if (!loc) return loc;
  if (!("snippet" in loc)) return loc;
  // Drop snippet (and similar embedded source). Path + line/column survive.
  const rest: CodeScanningLocation = { ...loc };
  delete rest.snippet;
  return rest;
}

/**
 * Returns a redacted clone of a Code Scanning alert suitable for placing in
 * `NormalizedIssue.raw`. Embedded code snippets are dropped from every
 * location; file path and line/column numbers are retained.
 */
export function redactCodeScanningAlert(raw: RawCodeScanningAlert): RawCodeScanningAlert {
  const clone: RawCodeScanningAlert = { ...raw };
  if (clone.most_recent_instance) {
    clone.most_recent_instance = {
      ...clone.most_recent_instance,
      location: redactLocation(clone.most_recent_instance.location),
    };
  }
  if (Array.isArray(clone.instances)) {
    clone.instances = clone.instances.map((inst) => ({
      ...inst,
      location: redactLocation(inst.location),
    }));
  }
  return clone;
}
