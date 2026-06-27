// Canonical JSON serialization for the marketplace catalog signature.
//
// This is a verbatim re-implementation of the app-side `canonicalize` /
// `canonicalPayloadBytes` in roubo's server/services/marketplace-integrity.ts.
// The catalog signature is computed over exactly these bytes, so the publish CI
// here and the app's verifier MUST agree on this serialization byte-for-byte.
// Do not "improve" it (no pretty-printing, no key reordering changes): any drift
// makes the app fail the signature closed.

/**
 * Deterministically canonicalize a JSON value: object keys are sorted
 * recursively and there is no insignificant whitespace.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const obj = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Canonical payload bytes that the catalog signature covers.
 *
 * @param {unknown} payload
 * @returns {Buffer}
 */
export function canonicalPayloadBytes(payload) {
  return Buffer.from(canonicalize(payload), "utf8");
}
