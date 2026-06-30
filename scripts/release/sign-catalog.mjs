// Build and sign the marketplace catalog for a release.
//
// Assembles the signed catalog envelope `{ payload, signature }` the Roubo app
// verifies, where `signature` is a detached base64 ed25519 signature over the
// canonical payload bytes (see ./canonical.mjs, mirrored verbatim from the app's
// marketplace-integrity verifier). Each entry carries two distinct digests
// (./pack.mjs): `integrity` is the UNPACKED-ARTIFACT digest the host recomputes
// over the installed file set (computePackageDigest), while `source.sha256` is
// the sha256 of the normalized release tarball BYTES the seed bundle verifies on
// download. They are derived differently and are not expected to be equal.
//
// The ed25519 PKCS8 PEM private key is read from STDIN only: never a filesystem
// path, never an env var written to disk, never echoed or logged
// (CPHM-NFR-006 / AC3). The produced signature is self-verified against the
// public key derived from that private key before anything is written, so a key
// mismatch fails loudly rather than emitting an unverifiable catalog (exactly as
// the app's sign-marketplace-catalog.ts does).
//
// Revocation: entries named by the revocation input (the `--revoked` flag or the
// `revokedEntryIds` list in marketplace/key-ring.config.json) are marked
// `revoked: true`; the rest of the CatalogEntry shape is unchanged. Revoking is
// therefore a DATA edit + re-sign + republish, with no app release (CPHM-FR-007
// / AC4).
//
// Scope: local catalog generation + signing (now with revocation). Hosting the
// catalog/key-ring on GitHub Pages and signing the key-ring with the root key
// are handled by sign-key-ring.mjs + the pages workflow.

import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPayloadBytes } from "./canonical.mjs";
import { fingerprintKeyId, readStdin } from "./keys.mjs";
import {
  INSTALLABLE_PLUGIN_IDS,
  computeArtifactDigest,
  integrityOfFile,
  pluginDirFor,
  readPluginMeta,
} from "./pack.mjs";

const CATALOG_SCHEMA_VERSION = 1;
const DEFAULT_ASSET_BASE = "https://github.com/davidpoxon/roubo-plugins/releases/download";
const DEFAULT_KEY_RING_CONFIG = path.resolve("marketplace/key-ring.config.json");

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
 * @param {{ buildDir: string, assetBase: string, keyId: string, revokedIds?: Set<string> }} opts
 */
function buildCatalogPayload({ buildDir, assetBase, keyId, revokedIds = new Set() }) {
  const present = new Set(readdirSync(buildDir).filter((f) => f.endsWith(".tgz")));

  const entries = [];
  for (const id of INSTALLABLE_PLUGIN_IDS) {
    const meta = readPluginMeta(pluginDirFor(id));
    const fileName = `${meta.id}-${meta.version}.tgz`;
    if (!present.has(fileName)) continue;
    // source.sha256 pins the tarball BYTES a user downloads (seed-bundle.ts
    // verifies the fetched .tgz against it). integrity pins the
    // UNPACKED-ARTIFACT digest the host recomputes after install
    // (roubo/server/services/marketplace-integrity.ts computePackageDigest); the
    // two are derived differently and never agree.
    const sourceSha256 = integrityOfFile(path.join(buildDir, fileName)).integrity;
    const integrity = computeArtifactDigest(pluginDirFor(meta.id));
    /** @type {Record<string, unknown>} */
    const entry = {
      id: meta.id,
      name: meta.name,
      kind: meta.kind,
      version: meta.version,
      summary: meta.summary,
      source: {
        type: "release",
        assetUrl: assetUrlFor(assetBase, meta.id, meta.version),
        sha256: sourceSha256,
      },
      integrity,
      provenance: `roubo-plugins/plugins/${meta.id}@${meta.version}`,
    };
    // A revoked entry is delisted by the client and blocked from install/update
    // at the next refresh (CPHM-FR-007 / AC4). The flag is only added when set,
    // so a non-revoked entry's shape is byte-identical to before.
    if (revokedIds.has(meta.id)) entry.revoked = true;
    entries.push(entry);
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

/**
 * Resolve the set of revoked entry ids from the CLI flag and/or the committed
 * key-ring config. `--revoked a,b` is unioned with `revokedEntryIds` from the
 * config file (if present), so revocation can be a one-off flag or a durable
 * data edit in marketplace/key-ring.config.json.
 *
 * @param {{ revoked?: string, revokedConfig?: string }} opts
 * @returns {Set<string>}
 */
function resolveRevokedIds({ revoked, revokedConfig }) {
  /** @type {Set<string>} */
  const ids = new Set();
  if (revoked) {
    for (const id of revoked
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean))
      ids.add(id);
  }
  const configPath = revokedConfig ? path.resolve(revokedConfig) : DEFAULT_KEY_RING_CONFIG;
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (Array.isArray(config.revokedEntryIds)) {
      for (const id of config.revokedEntryIds) {
        if (typeof id === "string" && id.trim()) ids.add(id.trim());
      }
    }
  }
  return ids;
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

  const revokedIds = resolveRevokedIds({
    revoked: args.revoked,
    revokedConfig: args["revoked-config"],
  });

  const payload = buildCatalogPayload({ buildDir, assetBase, keyId, revokedIds });
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
  // Report the catalog path, entry count, and how many entries are revoked.
  // The key, the PEM, and the signature inputs are never printed (AC3).
  const revokedCount = payload.entries.filter((e) => e.revoked).length;
  process.stdout.write(
    `Wrote signed catalog ${outPath} (keyId ${keyId}, ${payload.entries.length} entr${payload.entries.length === 1 ? "y" : "ies"}, ${revokedCount} revoked)\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}

export { buildCatalogPayload };
