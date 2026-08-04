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
// Digest source: `--digest-source source` (the default, used by release.yml)
// derives each entry from the checkout that produced the tarball just packed
// into the build dir. `--digest-source asset` (used by pages.yml) derives it
// from INSIDE each downloaded release tarball instead, so the hosted catalog
// describes the artifact its `assetUrl` actually serves rather than whatever
// `main` currently holds (davidpoxon/roubo-development#738).
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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  unpackTarball,
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
 * Assemble one catalog entry from a plugin's metadata and its two digests.
 *
 * `source.sha256` pins the tarball BYTES a user downloads (seed-bundle.ts
 * verifies the fetched `.tgz` against it). `integrity` pins the
 * UNPACKED-ARTIFACT digest the host recomputes after install
 * (roubo/server/services/marketplace-integrity.ts computePackageDigest); the two
 * are derived differently and never agree. Both are supplied by the caller,
 * because where they come from is exactly what `--digest-source` selects.
 *
 * @param {{ meta: ReturnType<typeof readPluginMeta>, assetBase: string, sourceSha256: string, integrity: string, revokedIds: Set<string> }} opts
 * @returns {Record<string, unknown>}
 */
function buildEntry({ meta, assetBase, sourceSha256, integrity, revokedIds }) {
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
    // Display-only first-party curation flag (distinct from the ed25519
    // signature above). Every id in INSTALLABLE_PLUGIN_IDS is a curated
    // first-party plugin, so the whole first-party catalog is verified. The
    // app renders the green "Verified" trust pill only when this is true AND
    // the source is first-party; force-false'd for third parties app-side
    // (roubo/server/services/marketplace.ts annotate()), so a hostile source
    // cannot borrow it. Omitting it read falsy => "Unverified" on genuine
    // first-party cards.
    verified: true,
  };
  // The agent-CLI compatibility window an agent plugin declares in its manifest
  // (davidpoxon/roubo-development#722). Carried on the entry so a listing can
  // render the floor and tested ceiling BEFORE anything is installed: a
  // release-sourced entry has no manifest the host can read until then, and it
  // is the manifest that wins once the plugin is on disk. Only agent plugins
  // declare it and only agent listings render it, and, like `revoked` below,
  // the key is added only when set, so a non-agent entry's canonical bytes are
  // unchanged.
  if (meta.kind === "agent" && (meta.minVersion || meta.testedCeiling)) {
    entry.agentCompatibility = {
      ...(meta.minVersion !== undefined && { minVersion: meta.minVersion }),
      ...(meta.testedCeiling !== undefined && { testedCeiling: meta.testedCeiling }),
    };
  }
  // The host semver range the plugin's manifest declares
  // (davidpoxon/roubo-development#720). Carried on the entry so a host outside
  // it can mark the listing incompatible and refuse the install BEFORE any
  // artifact is downloaded, instead of discovering it from the manifest after
  // the package is already staged. Added only when declared, in the same style
  // as the two keys around it, so an entry without one is byte-identical to
  // what this build produced before.
  if (meta.roubo) entry.roubo = meta.roubo;
  // A revoked entry is delisted by the client and blocked from install/update
  // at the next refresh (CPHM-FR-007 / AC4). The flag is only added when set,
  // so a non-revoked entry's shape is byte-identical to before.
  if (revokedIds.has(meta.id)) entry.revoked = true;
  return entry;
}

/**
 * Build the (unsigned) catalog payload from the tarballs in a build dir. Only
 * plugins that have a `<id>-<version>.tgz` present are included, so a
 * single-plugin tag release produces a single-entry catalog and a full dispatch
 * produces the full set.
 *
 * `digestSource` selects what the entry DESCRIBES:
 *
 *   - `"source"` (default, used by release.yml): the tarball in `buildDir` was
 *     just packed from this checkout, so the entry's metadata and its
 *     unpacked-artifact digest are read from `plugins/<id>/`. Within a tag
 *     release the packed asset and the checkout are the same thing, so this
 *     pairing is correct by construction.
 *   - `"asset"` (used by pages.yml): the tarballs in `buildDir` were DOWNLOADED
 *     from the published Releases, so both digests and the display metadata are
 *     derived from inside each tarball rather than from the current tree. The
 *     hosted catalog therefore describes the artifact its `assetUrl` actually
 *     serves, even when `main` has moved on since the tag
 *     (davidpoxon/roubo-development#738).
 *
 * @param {{ buildDir: string, assetBase: string, keyId: string, revokedIds?: Set<string>, digestSource?: "source" | "asset" }} opts
 */
function buildCatalogPayload({
  buildDir,
  assetBase,
  keyId,
  revokedIds = new Set(),
  digestSource = "source",
}) {
  const present = readdirSync(buildDir)
    .filter((f) => f.endsWith(".tgz"))
    .sort();

  const entries = [];
  if (digestSource === "asset") {
    for (const fileName of present) {
      const tgzPath = path.join(buildDir, fileName);
      const unpackDir = mkdtempSync(path.join(tmpdir(), "catalog-asset-"));
      try {
        unpackTarball(tgzPath, unpackDir);
        const meta = readPluginMeta(unpackDir);
        // The curated first-party set still gates what may be listed; the
        // tarball only decides what a listed entry says about itself.
        if (!INSTALLABLE_PLUGIN_IDS.includes(meta.id)) continue;
        entries.push(
          buildEntry({
            meta,
            assetBase,
            sourceSha256: integrityOfFile(tgzPath).integrity,
            integrity: computeArtifactDigest(unpackDir),
            revokedIds,
          }),
        );
      } finally {
        rmSync(unpackDir, { recursive: true, force: true });
      }
    }
  } else {
    const presentSet = new Set(present);
    for (const id of INSTALLABLE_PLUGIN_IDS) {
      const meta = readPluginMeta(pluginDirFor(id));
      const fileName = `${meta.id}-${meta.version}.tgz`;
      if (!presentSet.has(fileName)) continue;
      entries.push(
        buildEntry({
          meta,
          assetBase,
          sourceSha256: integrityOfFile(path.join(buildDir, fileName)).integrity,
          integrity: computeArtifactDigest(pluginDirFor(meta.id)),
          revokedIds,
        }),
      );
    }
  }

  if (entries.length === 0) {
    throw new Error(
      digestSource === "asset"
        ? `No release tarballs found in ${buildDir}. Run fetch-release-assets.mjs first.`
        : `No packed tarballs found in ${buildDir}. Run pack.mjs first.`,
    );
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
  const digestSource = args["digest-source"] ?? "source";
  if (digestSource !== "source" && digestSource !== "asset") {
    throw new Error(`--digest-source must be 'source' or 'asset', got '${digestSource}'.`);
  }

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

  const payload = buildCatalogPayload({ buildDir, assetBase, keyId, revokedIds, digestSource });
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
