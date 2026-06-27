// Shared key helpers for the marketplace release signers.
//
// The catalog signer and the key-ring signer must agree, byte-for-byte, on how
// a key id is fingerprinted and on how the PKCS8 PEM private key reaches the
// process. Both live here so there is exactly ONE implementation: a catalog's
// `payload.keyId` and a key-ring entry's `keyId` are produced by the same
// `fingerprintKeyId`, so they match by construction and the app verifier can
// resolve one against the other (CPHM-FR-007 / AC3).
//
// node:crypto only; adds no crypto/supply-chain dependency (CPHM-NFR-006).

import { createPrivateKey, createPublicKey, createHash } from "node:crypto";

/**
 * Read the entire stdin stream as a UTF-8 string. Signing keys are piped in on
 * stdin only: never a filesystem path, never an env var written to disk, never
 * echoed or logged (CPHM-NFR-006 / AC3).
 *
 * @returns {Promise<string>}
 */
export async function readStdin() {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(/** @type {Buffer} */ (chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Stable key id: short fingerprint of the SPKI DER of the public key.
 *
 * This scheme is load-bearing for the app verifier: it recomputes the same
 * fingerprint over a key-ring entry's `publicKeyPem` to resolve the catalog's
 * `keyId`. Do not change it (the `ed25519-` prefix, sha256 over the SPKI DER,
 * first 16 hex chars) without a coordinated app-side change.
 *
 * @param {import("node:crypto").KeyObject} publicKey
 * @returns {string}
 */
export function fingerprintKeyId(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return `ed25519-${createHash("sha256").update(der).digest("hex").slice(0, 16)}`;
}

/**
 * Coerce a PEM string (public SPKI or private PKCS8) into a public KeyObject.
 * Accepting either form lets a gate be handed the root PUBLIC key directly, or
 * derive it from the root private key when only that is available (e.g. in CI,
 * where only the private key exists as a secret).
 *
 * @param {string} pem
 * @returns {import("node:crypto").KeyObject}
 */
export function loadPublicKey(pem) {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
    return createPublicKey(createPrivateKey(pem));
  }
  return createPublicKey(pem);
}

/**
 * Export a public KeyObject as a normalized SPKI PEM string. This is the exact
 * text stored as a key-ring entry's `publicKeyPem` and re-fingerprinted by the
 * app verifier, so it must round-trip through `loadPublicKey` /
 * `fingerprintKeyId` unchanged.
 *
 * @param {import("node:crypto").KeyObject} publicKey
 * @returns {string}
 */
export function publicKeyToPem(publicKey) {
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}
