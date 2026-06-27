// Key-resolution publish gate.
//
// Before the catalog + key-ring are published to Pages, this asserts the full
// trust chain the app verifier will walk, fail-closed:
//
//   1. The key-ring signature verifies against the bootstrap ROOT public key.
//   2. The catalog's payload.keyId resolves to a key in the ring whose status is
//      'active' (an unknown or revoked key is rejected, CPHM-FR-007 / AC3).
//   3. The catalog signature verifies against that resolved active key's
//      publicKeyPem (the operational key the ring vouches for actually signed
//      the catalog).
//   4. Every entry id in the revocation config (if supplied) is marked
//      revoked: true in the catalog (CPHM-NFR-004 / AC4).
//
// This is the producer-side guarantee behind "a catalog signed by an unknown
// key is rejected": the runtime rejection itself lives in the (out-of-scope)
// client. Any failure exits non-zero and FAILS the publish.
//
// The ROOT key is read from --root-key <pem-path> (public SPKI or private PKCS8;
// the public half is derived when a private key is given) or from stdin. Only
// the public half is ever used here.
//
// node:crypto only; no new dependency (CPHM-NFR-006).

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPayloadBytes } from "./canonical.mjs";
import { fingerprintKeyId, loadPublicKey, readStdin } from "./keys.mjs";

/** Parse `--flag value` / `--flag=value` argv into a map. */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
    } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
      out[token.slice(2)] = argv[i + 1];
      i++;
    } else {
      out[token.slice(2)] = "true";
    }
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.catalogPath
 * @param {string} opts.keyRingPath
 * @param {import("node:crypto").KeyObject} opts.rootPublicKey
 * @param {string | undefined} opts.revokedConfigPath
 * @returns {string[]} failures (empty = pass)
 */
function runGate({ catalogPath, keyRingPath, rootPublicKey, revokedConfigPath }) {
  /** @type {string[]} */
  const failures = [];

  const keyRing = JSON.parse(readFileSync(keyRingPath, "utf8"));
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

  // 1. Key-ring signature against the root public key.
  const ringPayload = keyRing?.payload;
  const ringSig = keyRing?.signature;
  if (!ringPayload || typeof ringSig !== "string") {
    failures.push(`Key-ring ${keyRingPath} is not a { payload, signature } envelope.`);
    return failures;
  }
  const ringOk = cryptoVerify(
    null,
    canonicalPayloadBytes(ringPayload),
    rootPublicKey,
    Buffer.from(ringSig, "base64"),
  );
  if (!ringOk) {
    failures.push(
      `Key-ring signature does not verify against the root public key (${fingerprintKeyId(rootPublicKey)}).`,
    );
    // Without a trusted ring there is nothing more to assert.
    return failures;
  }

  // Build the resolution map from the now-trusted ring.
  /** @type {Map<string, { status: string, publicKeyPem: string }>} */
  const ring = new Map();
  for (const k of Array.isArray(ringPayload.keys) ? ringPayload.keys : []) {
    if (k && typeof k.keyId === "string") {
      ring.set(k.keyId, { status: k.status, publicKeyPem: k.publicKeyPem });
    }
  }

  // 2. Catalog keyId resolves to an active ring key.
  const catalogPayload = catalog?.payload;
  const catalogSig = catalog?.signature;
  if (!catalogPayload || typeof catalogSig !== "string") {
    failures.push(`Catalog ${catalogPath} is not a { payload, signature } envelope.`);
    return failures;
  }
  const catalogKeyId = catalogPayload.keyId;
  const resolved = typeof catalogKeyId === "string" ? ring.get(catalogKeyId) : undefined;
  if (!resolved) {
    failures.push(
      `Catalog keyId '${catalogKeyId}' is not present in the key-ring (signed by an unknown key). Rejected.`,
    );
    return failures;
  }
  if (resolved.status !== "active") {
    failures.push(
      `Catalog keyId '${catalogKeyId}' resolves to a key with status '${resolved.status}', not 'active'. Rejected.`,
    );
    return failures;
  }

  // 3. Catalog signature against the resolved active key.
  const catalogOk = cryptoVerify(
    null,
    canonicalPayloadBytes(catalogPayload),
    createPublicKey(resolved.publicKeyPem),
    Buffer.from(catalogSig, "base64"),
  );
  if (!catalogOk) {
    failures.push(
      `Catalog signature does not verify against the active key '${catalogKeyId}' resolved from the ring.`,
    );
  }

  // 4. Every configured revoked entry id is marked revoked in the catalog.
  const configPath = revokedConfigPath
    ? path.resolve(revokedConfigPath)
    : path.resolve("marketplace/key-ring.config.json");
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const revokedIds = Array.isArray(config.revokedEntryIds) ? config.revokedEntryIds : [];
    const entries = Array.isArray(catalogPayload.entries) ? catalogPayload.entries : [];
    for (const id of revokedIds) {
      const entry = entries.find((e) => e.id === id);
      // A revoked id that is not in the catalog at all is fine (already
      // delisted); one that is present but not flagged is a gate failure.
      if (entry && entry.revoked !== true) {
        failures.push(`Catalog entry '${id}' is listed in revokedEntryIds but is not revoked.`);
      }
    }
  }

  return failures;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalogPath = path.resolve(args.catalog ?? "release-build/catalog.json");
  const keyRingPath = path.resolve(args["key-ring"] ?? "release-build/key-ring.json");

  let rootPem = args["root-key"]
    ? readFileSync(path.resolve(args["root-key"]), "utf8")
    : (await readStdin()).trim();
  if (!rootPem) {
    throw new Error(
      "No root key provided. Pass --root-key <pem-path> or pipe the root key PEM on stdin.",
    );
  }
  const rootPublicKey = loadPublicKey(rootPem);

  const failures = runGate({
    catalogPath,
    keyRingPath,
    rootPublicKey,
    revokedConfigPath: args["revoked-config"],
  });

  if (failures.length > 0) {
    process.stderr.write(
      `Key-resolution gate FAILED:\n${failures.map((f) => `  ${f}`).join("\n")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `Key-resolution gate passed: catalog signed by an active, ring-resolved key (${fingerprintKeyId(rootPublicKey)} root).\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}

export { runGate };
