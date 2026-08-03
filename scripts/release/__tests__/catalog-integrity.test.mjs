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
  readPluginMeta,
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

/**
 * Write a fixture plugin whose manifest carries a nested `agentCompatibility`
 * block shaped exactly like the real claude-code / codex manifests: a comment
 * above it, a comment INSIDE it, a deeper `probe:` sub-block, and a following
 * column-0 key. That shape is what constrains the line reader, so the fixture
 * reproduces it rather than a flattened simplification.
 *
 * @param {import("node:test").TestContext} t
 * @returns {string}
 */
function makeAgentFixturePlugin(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "catalog-agent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "fixture-agent", version: "0.1.0", private: true }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(dir, "roubo-plugin.yaml"),
    [
      "id: fixture-agent",
      "name: Fixture Agent",
      "version: 0.1.0",
      "kind: agent",
      "description: A fixture agent plugin for the declared-window contract",
      "# The agent-CLI compatibility window.",
      "agentCompatibility:",
      "  minVersion: 1.2.3",
      "  # An in-block comment, exactly as the real manifests carry one.",
      "  testedCeiling: 4.5.6",
      "  probe:",
      "    command: fixture-agent",
      "    args:",
      "      - --version",
      "    parse: semver",
      "permissions:",
      "  processes: false",
      "",
    ].join("\n"),
  );
  return dir;
}

test("readPluginMeta reads the nested agentCompatibility bounds and nothing else", (t) => {
  const dir = makeAgentFixturePlugin(t);
  const meta = readPluginMeta(dir);
  // Both bounds come off the real block, read past an in-block comment. The
  // `probe:` sub-block is a host instruction rather than catalog metadata, so its
  // deeper lines must not have been mistaken for a bound: `parse: semver` sits at
  // four spaces and would match a two-space reader that ignored indentation.
  assert.equal(meta.minVersion, "1.2.3");
  assert.equal(meta.testedCeiling, "4.5.6");
});

test("readPluginMeta stops at the key that ends the agentCompatibility block", (t) => {
  // The block-terminating guard, pinned where it can actually fail. A decoy that
  // merely repeats a bound the real block already set is inert, because the reader
  // takes the first value it sees for each key; so the real block here declares
  // ONLY `minVersion`, and a later column-0 block declares the `testedCeiling` it
  // left unset. A reader that ran past the terminator would pick 9.9.9 up.
  const dir = mkdtempSync(path.join(tmpdir(), "catalog-agent-decoy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "fixture-agent-decoy", version: "0.1.0", private: true }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(dir, "roubo-plugin.yaml"),
    [
      "id: fixture-agent-decoy",
      "name: Fixture Agent Decoy",
      "version: 0.1.0",
      "kind: agent",
      "description: A fixture agent plugin that declares only a floor",
      "agentCompatibility:",
      "  minVersion: 1.2.3",
      "decoyBlock:",
      "  testedCeiling: 9.9.9",
      "",
    ].join("\n"),
  );

  const meta = readPluginMeta(dir);
  assert.equal(meta.minVersion, "1.2.3");
  assert.equal(meta.testedCeiling, undefined);
});

test("readPluginMeta leaves a non-agent plugin's meta shape untouched", (t) => {
  const dir = makeFixturePlugin(t);
  const meta = readPluginMeta(dir);
  assert.deepEqual(Object.keys(meta).sort(), ["id", "kind", "name", "summary", "version"]);
});

test("buildCatalogPayload carries an agent entry's declared window (issue #722)", (t) => {
  // The host renders this on a not-yet-installed listing, which is the only route
  // a release-sourced entry has to its bounds before install.
  const agentId = INSTALLABLE_PLUGIN_IDS.find(
    (id) => readPluginMeta(pluginDirFor(id)).kind === "agent",
  );
  assert.ok(agentId, "expected at least one agent-kind plugin in INSTALLABLE_PLUGIN_IDS");
  const built = (() => {
    try {
      return statSync(path.join(pluginDirFor(agentId), "dist")).isDirectory();
    } catch {
      return false;
    }
  })();
  if (!built) {
    t.skip(`plugins/${agentId}/dist not built; run \`npm run build\` to exercise this test`);
    return;
  }

  const buildDir = mkdtempSync(path.join(tmpdir(), "catalog-compat-build-"));
  t.after(() => rmSync(buildDir, { recursive: true, force: true }));
  packPlugin({ pluginDir: pluginDirFor(agentId), outDir: buildDir });

  const payload = buildCatalogPayload({
    buildDir,
    assetBase: "https://example.invalid/releases/download",
    keyId: "ed25519-0000000000000000",
  });

  const meta = readPluginMeta(pluginDirFor(agentId));
  const entry = payload.entries.find((e) => e.id === agentId);
  assert.ok(entry, `expected a catalog entry for ${agentId}`);
  assert.deepEqual(entry.agentCompatibility, {
    minVersion: meta.minVersion,
    testedCeiling: meta.testedCeiling,
  });
});

test("buildCatalogPayload leaves a non-agent entry's shape unchanged (issue #722)", (t) => {
  // The key is added only for agent entries, so a component or integration
  // entry's canonical bytes are what they were before the field existed.
  const otherId = INSTALLABLE_PLUGIN_IDS.find(
    (id) => readPluginMeta(pluginDirFor(id)).kind !== "agent",
  );
  assert.ok(otherId, "expected at least one non-agent plugin in INSTALLABLE_PLUGIN_IDS");
  const built = (() => {
    try {
      return statSync(path.join(pluginDirFor(otherId), "dist")).isDirectory();
    } catch {
      return false;
    }
  })();
  if (!built) {
    t.skip(`plugins/${otherId}/dist not built; run \`npm run build\` to exercise this test`);
    return;
  }

  const buildDir = mkdtempSync(path.join(tmpdir(), "catalog-non-agent-build-"));
  t.after(() => rmSync(buildDir, { recursive: true, force: true }));
  packPlugin({ pluginDir: pluginDirFor(otherId), outDir: buildDir });

  const payload = buildCatalogPayload({
    buildDir,
    assetBase: "https://example.invalid/releases/download",
    keyId: "ed25519-0000000000000000",
  });

  const entry = payload.entries.find((e) => e.id === otherId);
  assert.ok(entry, `expected a catalog entry for ${otherId}`);
  assert.ok(
    !("agentCompatibility" in entry),
    `entry ${otherId} (${readPluginMeta(pluginDirFor(otherId)).kind}) must not carry agentCompatibility`,
  );
});

test("buildCatalogPayload marks every first-party entry verified", (t) => {
  // The display-only curation flag the app's "Verified" trust pill reads. Every
  // INSTALLABLE_PLUGIN_IDS entry is curated first-party, so all must carry
  // `verified: true`; omitting it read falsy app-side and rendered genuine
  // first-party plugins as "Unverified".
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

  const buildDir = mkdtempSync(path.join(tmpdir(), "catalog-verified-build-"));
  t.after(() => rmSync(buildDir, { recursive: true, force: true }));
  packPlugin({ pluginDir: pluginDirFor(id), outDir: buildDir });

  const payload = buildCatalogPayload({
    buildDir,
    assetBase: "https://example.invalid/releases/download",
    keyId: "ed25519-0000000000000000",
  });

  assert.ok(payload.entries.length >= 1, "expected at least one catalog entry");
  for (const entry of payload.entries) {
    assert.equal(entry.verified, true, `entry ${entry.id} must be verified: true`);
  }
});
