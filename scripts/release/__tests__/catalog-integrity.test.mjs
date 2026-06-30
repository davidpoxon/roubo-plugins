// Tests for the marketplace catalog's two-digest contract (issue #382).
//
// The published catalog binds each plugin two different ways: `source.sha256` is
// the sha256 of the release TARBALL bytes (the download-integrity check the seed
// bundle performs on the fetched `.tgz`), while `integrity` is the
// UNPACKED-ARTIFACT digest the host recomputes after install
// (roubo/server/services/marketplace-integrity.ts `computePackageDigest`).
// Before #382 both fields carried the tarball-bytes sha256, so every install and
// first-run seed failed `422 integrity-failed`: the host's unpacked-directory
// digest never matched the tarball-bytes value. These tests pin the fix: that
// `computeArtifactDigest` reproduces the host algorithm byte for byte, that it
// differs from the tarball-bytes sha256, and that the signed catalog now emits
// the two distinct digests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  INSTALLABLE_PLUGIN_IDS,
  computeArtifactDigest,
  integrityOfFile,
  packPlugin,
  pluginDirFor,
} from "../pack.mjs";
import { buildCatalogPayload } from "../sign-catalog.mjs";

/**
 * Build a minimal but realistic UNPACKED artifact directory for a fixture
 * plugin: exactly the file set pack.mjs ships (the dist/ tree plus package.json,
 * roubo-plugin.yaml, README.md) and nothing else, so the directory is itself a
 * faithful stand-in for an unpacked tarball.
 *
 * @param {import("node:test").TestContext} t
 * @returns {string}
 */
function makeFixturePlugin(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "catalog-integrity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "fixture-plugin", version: "0.1.0", private: true }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(dir, "roubo-plugin.yaml"),
    [
      "id: fixture-plugin",
      "name: Fixture Plugin",
      "version: 0.1.0",
      "kind: component",
      "description: A fixture plugin for digest-contract tests",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(dir, "README.md"), "# Fixture Plugin\n");
  mkdirSync(path.join(dir, "dist", "sub"), { recursive: true });
  writeFileSync(path.join(dir, "dist", "index.js"), "export const id = 'fixture-plugin';\n");
  writeFileSync(path.join(dir, "dist", "sub", "helper.js"), "export const help = () => 42;\n");
  return dir;
}

/**
 * Reference reimplementation of the host's computePackageDigest
 * (roubo/server/services/marketplace-integrity.ts), inlined so the test pins the
 * cross-repo contract independently of the producer's own helper. Walks the
 * directory (files only, skipping .git), sorts by `/`-joined relative path, then
 * hashes rel(utf8) + NUL + bytes + NUL over a single sha256.
 *
 * @param {string} dir
 * @returns {string}
 */
function hostPackageDigest(dir) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} current */
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      if (name === ".git") continue;
      const abs = path.join(current, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) files.push(abs);
    }
  };
  walk(dir);

  const rels = files
    .map((abs) => ({ abs, rel: path.relative(dir, abs).split(path.sep).join("/") }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const hash = createHash("sha256");
  for (const { abs, rel } of rels) {
    hash.update(rel, "utf8");
    hash.update("\0");
    hash.update(readFileSync(abs));
    hash.update("\0");
  }
  return `sha256-${hash.digest("hex")}`;
}

test("computeArtifactDigest reproduces the host computePackageDigest byte for byte", (t) => {
  const dir = makeFixturePlugin(t);
  assert.equal(computeArtifactDigest(dir), hostPackageDigest(dir));
});

test("computeArtifactDigest differs from the tarball-bytes sha256 (the #382 root cause)", (t) => {
  const dir = makeFixturePlugin(t);
  const outDir = mkdtempSync(path.join(tmpdir(), "catalog-integrity-out-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));

  const packed = packPlugin({ pluginDir: dir, outDir });
  const artifactDigest = computeArtifactDigest(dir);

  // packPlugin().integrity and integrityOfFile() both hash the compressed .tgz;
  // the artifact digest hashes the unpacked file set. These are the two schemes
  // that disagreed in #382 and must not be equal.
  assert.equal(integrityOfFile(packed.tarballPath).integrity, packed.integrity);
  assert.notEqual(artifactDigest, packed.integrity);
  assert.match(artifactDigest, /^sha256-[0-9a-f]{64}$/);
});

test("computeArtifactDigest is reproducible across runs", (t) => {
  const dir = makeFixturePlugin(t);
  assert.equal(computeArtifactDigest(dir), computeArtifactDigest(dir));
});

test("buildCatalogPayload emits integrity (artifact digest) distinct from source.sha256 (tarball bytes)", (t) => {
  // buildCatalogPayload reads the real plugin sources and needs their built
  // dist/ to recompute the artifact digest. Skip cleanly when the workspace has
  // not been built (the release job and the documented verification run
  // `npm run build` first); the synthetic tests above cover the property
  // unconditionally.
  const id = INSTALLABLE_PLUGIN_IDS[0];
  const built = (() => {
    try {
      return statSync(path.join(pluginDirFor(id), "dist")).isDirectory();
    } catch {
      return false;
    }
  })();
  if (!built) {
    t.skip(`plugins/${id}/dist not built; run \`npm run build\` to exercise this test`);
    return;
  }

  const buildDir = mkdtempSync(path.join(tmpdir(), "catalog-integrity-build-"));
  t.after(() => rmSync(buildDir, { recursive: true, force: true }));
  const packed = packPlugin({ pluginDir: pluginDirFor(id), outDir: buildDir });

  const payload = buildCatalogPayload({
    buildDir,
    assetBase: "https://example.invalid/releases/download",
    keyId: "ed25519-0000000000000000",
  });

  const entry = payload.entries.find((e) => e.id === id);
  assert.ok(entry, `expected a catalog entry for ${id}`);
  // source.sha256 is the tarball bytes; integrity is the unpacked-artifact
  // digest; the two are derived differently and must not be equal.
  assert.equal(entry.source.sha256, packed.integrity);
  assert.equal(entry.integrity, computeArtifactDigest(pluginDirFor(id)));
  assert.notEqual(entry.integrity, entry.source.sha256);
});
