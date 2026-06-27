// Build and sign the marketplace key-ring for a release.
//
// Assembles the SignedKeyRing envelope `{ payload, signature }` the Roubo app
// verifies, where `payload` is `{ keys: [{ keyId, publicKeyPem, status }],
// generatedAt }` and `signature` is a detached base64 ed25519 signature over the
// canonical payload bytes (see ./canonical.mjs, the same serialization the
// catalog signature uses). The ring is signed by the long-lived bootstrap ROOT
// key; the app embeds only the root public key and resolves every operational
// signing key through this ring, so operational keys rotate and revoke without
// an app release (CPHM-FR-007 / CPHM-NFR-004 / AC2 / AC3).
//
// The ROOT PKCS8 PEM is read from STDIN only: never a filesystem path, never an
// env var written to disk, never echoed or logged (CPHM-NFR-006 / AC3), exactly
// as sign-catalog.mjs reads the operational key. The produced ring signature is
// self-verified against the root public key before anything is written, so a
// bad key fails loudly rather than emitting an unverifiable ring.
//
// Operational keys come from the committed source of truth
// (marketplace/key-ring.config.json: `keys: [{ publicKeyPem, status, keyId? }]`)
// and/or an injected active key (`--active-key-file`, used in CI to add the
// public half of the operational signing secret so the ring's active key always
// matches the catalog's keyId). Each entry's keyId is derived from its public
// key via the shared fingerprintKeyId, so a ring entry's keyId matches the
// catalog's keyId by construction.
//
// node:crypto only; adds no crypto/supply-chain dependency (CPHM-NFR-006).

import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPayloadBytes } from "./canonical.mjs";
import { fingerprintKeyId, publicKeyToPem, readStdin } from "./keys.mjs";

const VALID_STATUSES = new Set(["active", "revoked"]);

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
 * Normalize one raw operational key into a ring entry. Derives the canonical
 * keyId from the public key and, if the source also carried a keyId, asserts the
 * two agree (a typo in the committed config must fail loudly, not silently sign
 * a mislabelled key).
 *
 * @param {{ publicKeyPem: string, status: string, keyId?: string }} raw
 * @param {string} where  source description for error messages
 * @returns {{ keyId: string, publicKeyPem: string, status: string }}
 */
function toRingEntry(raw, where) {
  if (!raw || typeof raw.publicKeyPem !== "string" || !raw.publicKeyPem.trim()) {
    throw new Error(`Key in ${where} is missing a publicKeyPem.`);
  }
  if (!VALID_STATUSES.has(raw.status)) {
    throw new Error(
      `Key in ${where} has invalid status '${raw.status}'. Expected one of: ${[...VALID_STATUSES].join(", ")}.`,
    );
  }
  // Re-export through a KeyObject so the stored PEM is the exact form the app
  // verifier re-fingerprints (no stray whitespace / header drift).
  const publicKey = createPublicKey(raw.publicKeyPem);
  const keyId = fingerprintKeyId(publicKey);
  if (raw.keyId && raw.keyId !== keyId) {
    throw new Error(
      `Key in ${where} declares keyId '${raw.keyId}' but its public key fingerprints to '${keyId}'. Fix or remove the declared keyId.`,
    );
  }
  return { keyId, publicKeyPem: publicKeyToPem(publicKey), status: raw.status };
}

/**
 * Build the (unsigned) key-ring payload from the config file and an optional
 * injected active key. Entries are de-duplicated by keyId (a later source wins,
 * so an injected active key overrides a config entry for the same key) and
 * sorted by keyId for deterministic canonicalization.
 *
 * @param {{ configPath?: string, activeKeyPem?: string }} opts
 * @returns {{ keys: Array<{ keyId: string, publicKeyPem: string, status: string }>, generatedAt: string }}
 */
function buildKeyRingPayload({ configPath, activeKeyPem }) {
  /** @type {Map<string, { keyId: string, publicKeyPem: string, status: string }>} */
  const byKeyId = new Map();

  if (configPath && existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const keys = Array.isArray(config.keys) ? config.keys : [];
    for (const raw of keys) {
      const entry = toRingEntry(raw, configPath);
      byKeyId.set(entry.keyId, entry);
    }
  }

  if (activeKeyPem && activeKeyPem.trim()) {
    const entry = toRingEntry(
      { publicKeyPem: activeKeyPem, status: "active" },
      "--active-key-file",
    );
    byKeyId.set(entry.keyId, entry);
  }

  const keys = [...byKeyId.values()].sort((a, b) =>
    a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0,
  );

  if (keys.length === 0) {
    throw new Error(
      "Key-ring would be empty. Add at least one operational key to the config (marketplace/key-ring.config.json) or pass --active-key-file.",
    );
  }
  if (!keys.some((k) => k.status === "active")) {
    throw new Error(
      "Key-ring has no 'active' key. The catalog's signing key must resolve to an active ring entry; add or inject an active operational key.",
    );
  }

  return {
    keys,
    // generatedAt is release-time metadata, regenerated each publish (mirrors
    // the catalog's generatedAt).
    generatedAt: new Date().toISOString(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(args.config ?? "marketplace/key-ring.config.json");
  const outPath = path.resolve(args.out ?? "release-build/key-ring.json");
  const activeKeyPem = args["active-key-file"]
    ? readFileSync(path.resolve(args["active-key-file"]), "utf8")
    : undefined;

  const pem = (await readStdin()).trim();
  if (!pem) {
    throw new Error(
      "No root private key on stdin. Pipe the ed25519 PKCS8 PEM in, e.g. `node scripts/release/sign-key-ring.mjs < root-priv.pem`.",
    );
  }
  const rootPrivateKey = createPrivateKey(pem);
  const rootPublicKey = createPublicKey(rootPrivateKey);

  const payload = buildKeyRingPayload({ configPath, activeKeyPem });
  const bytes = canonicalPayloadBytes(payload);
  const signature = cryptoSign(null, bytes, rootPrivateKey).toString("base64");

  // Loud failure on key mismatch: verify before writing. Never emit an
  // unverifiable key-ring.
  const ok = cryptoVerify(null, bytes, rootPublicKey, Buffer.from(signature, "base64"));
  if (!ok) {
    throw new Error(
      "Produced ring signature does not verify against the public key derived from the root private key. Refusing to write an unverifiable key-ring.",
    );
  }

  writeFileSync(outPath, `${JSON.stringify({ payload, signature }, null, 2)}\n`, "utf8");
  // Report counts only. The root key, the PEM, and the signature inputs are
  // never printed (AC3).
  const activeCount = payload.keys.filter((k) => k.status === "active").length;
  const revokedCount = payload.keys.length - activeCount;
  process.stdout.write(
    `Wrote signed key-ring ${outPath} (${payload.keys.length} key${payload.keys.length === 1 ? "" : "s"}: ${activeCount} active, ${revokedCount} revoked, rooted by ${fingerprintKeyId(rootPublicKey)})\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}

export { buildKeyRingPayload };
