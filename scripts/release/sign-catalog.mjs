// Build and sign the marketplace catalog for a release.
//
// Assembles the signed catalog envelope `{ payload, signature }` the Roubo app
// verifies, where `signature` is a detached base64 ed25519 signature over the
// canonical payload bytes (see ./canonical.mjs, mirrored verbatim from the app's
// marketplace-integrity verifier). Each entry's `integrity` / `source.sha256` is
// the sha256 of the plugin's normalized release tarball (./pack.mjs).
//
// The ed25519 PKCS8 PEM private key is read from STDIN only: never a filesystem
// path, never an env var written to disk, never echoed or logged
// (CPHM-NFR-006 / AC3). The produced signature is self-verified against the
// public key derived from that private key before anything is written, so a key
// mismatch fails loudly rather than emitting an unverifiable catalog (exactly as
// the app's sign-marketplace-catalog.ts does).
//
// Scope: local catalog generation + signing. Hosting the catalog/key-ring on
// GitHub Pages and key-ring/root-key rotation are a sibling issue and are not
// done here.

import {
  createPrivateKey,
  createPublicKey,
  createHash,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPayloadBytes } from "./canonical.mjs";
import { INSTALLABLE_PLUGIN_IDS, integrityOfFile, pluginDirFor, readPluginMeta } from "./pack.mjs";

const CATALOG_SCHEMA_VERSION = 1;
const DEFAULT_ASSET_BASE = "https://github.com/davidpoxon/roubo-plugins/releases/download";

/** Read the entire stdin stream as a UTF-8 string. */
async function readStdin() {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(/** @type {Buffer} */ (chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * GitHub Release asset download URL for a plugin version. Tag = `<id>-v<version>`,
 * asset name = `<id>-<version>.tgz`.
 *
 * @param {string} assetBase @param {string} id @param {string} version
 */
function assetUrlFor(assetBase, id, version) {
  return `${assetBase.replace(/\/+$/, "")}/${id}-v${version}/${id}-${version}.tgz`;
}

/**
 * Build the (unsigned) catalog payload from the tarballs in a build dir. Only
 * plugins that have a packed `<id>-<version>.tgz` present are included, so a
 * single-plugin tag release produces a single-entry catalog and a `--all`
 * dispatch produces the full set.
 *
 * @param {{ buildDir: string, assetBase: string, keyId: string }} opts
 */
function buildCatalogPayload({ buildDir, assetBase, keyId }) {
  const present = new Set(readdirSync(buildDir).filter((f) => f.endsWith(".tgz")));

  const entries = [];
  for (const id of INSTALLABLE_PLUGIN_IDS) {
    const meta = readPluginMeta(pluginDirFor(id));
    const fileName = `${meta.id}-${meta.version}.tgz`;
    if (!present.has(fileName)) continue;
    const { integrity } = integrityOfFile(path.join(buildDir, fileName));
    entries.push({
      id: meta.id,
      name: meta.name,
      kind: meta.kind,
      version: meta.version,
      summary: meta.summary,
      source: {
        type: "release",
        assetUrl: assetUrlFor(assetBase, meta.id, meta.version),
        sha256: integrity,
      },
      integrity,
      provenance: `roubo-plugins/plugins/${meta.id}@${meta.version}`,
    });
  }

  if (entries.length === 0) {
    throw new Error(`No packed tarballs found in ${buildDir}. Run pack.mjs first.`);
  }

  // Deterministic entry order so the same release inputs canonicalize the same.
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    // generatedAt is release-time metadata. It is intentionally NOT part of the
    // reproducible-tarball contract (only the per-artifact sha256 must be
    // byte-stable, CPHM-TC-066); the catalog is regenerated each release.
    generatedAt: new Date().toISOString(),
    keyId,
    entries,
  };
}

/** Stable key id: short fingerprint of the SPKI DER of the public key. */
function fingerprintKeyId(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return `ed25519-${createHash("sha256").update(der).digest("hex").slice(0, 16)}`;
}

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const buildDir = path.resolve(args["build-dir"] ?? "release-build");
  const assetBase = args["asset-base"] ?? process.env.MARKETPLACE_ASSET_BASE ?? DEFAULT_ASSET_BASE;
  const outPath = path.resolve(args.out ?? path.join(buildDir, "catalog.json"));

  const pem = (await readStdin()).trim();
  if (!pem) {
    throw new Error(
      "No private key on stdin. Pipe the ed25519 PKCS8 PEM in, e.g. `node scripts/release/sign-catalog.mjs < ed25519-priv.pem`.",
    );
  }
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);
  const keyId = args["key-id"] ?? process.env.MARKETPLACE_KEY_ID ?? fingerprintKeyId(publicKey);

  const payload = buildCatalogPayload({ buildDir, assetBase, keyId });
  const bytes = canonicalPayloadBytes(payload);
  const signature = cryptoSign(null, bytes, privateKey).toString("base64");

  // Loud failure on key mismatch: verify before writing, exactly as the app
  // signer does. Never emit an unverifiable catalog.
  const ok = cryptoVerify(null, bytes, publicKey, Buffer.from(signature, "base64"));
  if (!ok) {
    throw new Error(
      "Produced signature does not verify against the public key derived from the private key. Refusing to write an unverifiable catalog.",
    );
  }

  writeFileSync(outPath, `${JSON.stringify({ payload, signature }, null, 2)}\n`, "utf8");
  // Report the catalog path and entry count only. The key, the PEM, and the
  // signature inputs are never printed (AC3).
  process.stdout.write(
    `Wrote signed catalog ${outPath} (keyId ${keyId}, ${payload.entries.length} entr${payload.entries.length === 1 ? "y" : "ies"})\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}

export { buildCatalogPayload };
