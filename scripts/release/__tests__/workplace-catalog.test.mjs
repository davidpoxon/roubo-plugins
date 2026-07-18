// Tests for the PLAIN (unsigned) workplace marketplace catalog (issue #567).
//
// The workplace marketplace reuses the first-party publish pipeline shape
// (build -> pack -> publish -> regenerate catalog -> digest self-check) but
// DROPS the signing / verify-keyring gate. It emits a plain catalog.json with
// the same entries[] shape the app consumes (id, name, kind, version, summary,
// source{type,assetUrl,sha256}, integrity, provenance) but with NO signature,
// NO {payload} envelope, NO keyId, and NO key ring. Trust rests entirely on the
// per-entry sha256 integrity digest, which is therefore MANDATORY.
//
// These tests pin that contract:
//   - the catalog is plain JSON with top-level entries[] and none of the signed
//     path's signature / payload / keyId / key-ring artifacts (CPHMTP-TC-089 /
//     CPHMTP-TC-094);
//   - every entry carries a well-formed `sha256-...` integrity (CPHMTP-TC-089);
//   - the entries keep format parity with the first-party fields the app
//     consumes: id, version, source(type/assetUrl/sha256), integrity
//     (CPHMTP-TC-093);
//   - an input with a missing/empty integrity fails the build, naming the entry
//     (CPHMTP-NFR-004 / CPHMTP-TC-099);
//   - regeneration is deterministic for identical inputs and re-digests changed
//     bytes (CPHMTP-TC-103).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { INSTALLABLE_PLUGIN_IDS, integrityOfFile, packPlugin, pluginDirFor } from "../pack.mjs";
import { buildCatalogPayload } from "../sign-catalog.mjs";
import { buildWorkplaceCatalog, enforceMandatoryIntegrity } from "../build-workplace-catalog.mjs";

const ASSET_BASE = "https://ghe.example.invalid/roubo-plugins/releases/download";

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
  const dir = mkdtempSync(path.join(tmpdir(), "workplace-catalog-"));
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
      "description: A fixture plugin for the workplace-catalog tests",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(dir, "README.md"), "# Fixture Plugin\n");
  mkdirSync(path.join(dir, "dist"), { recursive: true });
  writeFileSync(path.join(dir, "dist", "index.js"), "export const id = 'fixture-plugin';\n");
  return dir;
}

/**
 * Pack a real installable plugin into a fresh temp build dir. Returns the build
 * dir and the plugin id, or null when the workspace has not been built (the
 * release job and documented verification run `npm run build` first). Tests that
 * need real entries skip cleanly in that case; the synthetic tests below cover
 * the integrity-floor and re-digest properties unconditionally.
 *
 * @param {import("node:test").TestContext} t
 * @returns {{ buildDir: string, id: string } | null}
 */
function packedRealPlugin(t) {
  const id = INSTALLABLE_PLUGIN_IDS[0];
  const built = (() => {
    try {
      return statSync(path.join(pluginDirFor(id), "dist")).isDirectory();
    } catch {
      return false;
    }
  })();
  if (!built) return null;

  const buildDir = mkdtempSync(path.join(tmpdir(), "workplace-catalog-build-"));
  t.after(() => rmSync(buildDir, { recursive: true, force: true }));
  packPlugin({ pluginDir: pluginDirFor(id), outDir: buildDir });
  return { buildDir, id };
}

test("workplace catalog is plain JSON with entries[] and no signature/payload/keyId/key-ring (TC-089/094)", (t) => {
  const real = packedRealPlugin(t);
  if (!real) {
    t.skip(`plugins/${INSTALLABLE_PLUGIN_IDS[0]}/dist not built; run \`npm run build\` first`);
    return;
  }

  const catalog = buildWorkplaceCatalog({ buildDir: real.buildDir, assetBase: ASSET_BASE });

  // Top-level plain shape: schemaVersion + generatedAt + entries[], nothing else
  // the signed path adds.
  assert.equal(typeof catalog.schemaVersion, "number");
  assert.equal(typeof catalog.generatedAt, "string");
  assert.ok(Array.isArray(catalog.entries) && catalog.entries.length > 0);
  assert.ok(!("keyId" in catalog), "workplace catalog must not carry a signing keyId");
  assert.ok(!("signature" in catalog), "workplace catalog must not be a signed envelope");
  assert.ok(!("payload" in catalog), "workplace catalog must not wrap a {payload} envelope");

  // The catalog must round-trip as plain JSON, and its serialized bytes must
  // reference none of the signed path's artifacts (no key-ring reference either).
  const serialized = JSON.stringify(catalog);
  assert.deepEqual(JSON.parse(serialized), catalog);
  assert.doesNotMatch(serialized, /signature|keyId|keyRing|key-ring/i);

  // Every entry carries a well-formed sha256-... integrity digest.
  for (const entry of catalog.entries) {
    assert.match(entry.integrity, /^sha256-[0-9a-f]{64}$/, `entry ${entry.id} integrity`);
  }
});

test("workplace entries keep format parity with the first-party fields the app consumes (TC-093)", (t) => {
  const real = packedRealPlugin(t);
  if (!real) {
    t.skip(`plugins/${INSTALLABLE_PLUGIN_IDS[0]}/dist not built; run \`npm run build\` first`);
    return;
  }

  const workplace = buildWorkplaceCatalog({ buildDir: real.buildDir, assetBase: ASSET_BASE });
  // The first-party (signed-path) payload for the same inputs. Its per-entry
  // shape is exactly what the app consumes; the workplace entries must match it.
  const firstParty = buildCatalogPayload({
    buildDir: real.buildDir,
    assetBase: ASSET_BASE,
    keyId: "ed25519-0000000000000000",
  });

  const entry = workplace.entries.find((e) => e.id === real.id);
  const reference = firstParty.entries.find((e) => e.id === real.id);
  assert.ok(entry, `expected a workplace entry for ${real.id}`);
  assert.ok(reference, `expected a first-party entry for ${real.id}`);

  // The fields the app installs from must be present and well-formed.
  assert.equal(typeof entry.id, "string");
  assert.equal(typeof entry.version, "string");
  assert.equal(entry.source.type, "release");
  assert.equal(typeof entry.source.assetUrl, "string");
  assert.match(entry.source.sha256, /^sha256-[0-9a-f]{64}$/);
  assert.match(entry.integrity, /^sha256-[0-9a-f]{64}$/);

  // Format parity: the workplace entry is byte-identical to the first-party
  // entry (only the top-level keyId is dropped, never a per-entry field).
  assert.deepEqual(entry, reference);
});

test("a missing/empty integrity fails the build, naming the entry (TC-099)", () => {
  const good = { id: "alpha", integrity: "sha256-abc" };
  const empty = { id: "beta", integrity: "   " };
  const missing = { id: "gamma" };

  // Passing entries are accepted.
  assert.doesNotThrow(() => enforceMandatoryIntegrity([good]));

  // An empty integrity is rejected and the offending entry is named.
  assert.throws(() => enforceMandatoryIntegrity([good, empty]), /beta/);
  // A missing integrity is rejected and the offending entry is named.
  assert.throws(() => enforceMandatoryIntegrity([good, missing]), /gamma/);
  // The error explicitly explains the integrity floor.
  assert.throws(() => enforceMandatoryIntegrity([missing]), /integrity digest/);
});

test("regeneration is deterministic for identical inputs (TC-103)", (t) => {
  const real = packedRealPlugin(t);
  if (!real) {
    t.skip(`plugins/${INSTALLABLE_PLUGIN_IDS[0]}/dist not built; run \`npm run build\` first`);
    return;
  }

  const first = buildWorkplaceCatalog({ buildDir: real.buildDir, assetBase: ASSET_BASE });
  const second = buildWorkplaceCatalog({ buildDir: real.buildDir, assetBase: ASSET_BASE });

  // generatedAt is release-time metadata and intentionally NOT part of the
  // reproducible contract; the digests and entry set are.
  assert.deepEqual(first.entries, second.entries);
});

test("regeneration re-digests changed bytes (TC-103)", (t) => {
  const dir = makeFixturePlugin(t);

  const outA = mkdtempSync(path.join(tmpdir(), "workplace-catalog-a-"));
  t.after(() => rmSync(outA, { recursive: true, force: true }));
  const before = packPlugin({ pluginDir: dir, outDir: outA });
  // Same inputs reproduce the same digest.
  assert.equal(integrityOfFile(before.tarballPath).integrity, before.integrity);

  // Change the artifact's bytes and repack: the digest must change to reflect the
  // new bytes (republishing regenerates the digest, AC4 / CPHMTP-TC-103).
  writeFileSync(path.join(dir, "dist", "index.js"), "export const id = 'fixture-plugin-v2';\n");
  const outB = mkdtempSync(path.join(tmpdir(), "workplace-catalog-b-"));
  t.after(() => rmSync(outB, { recursive: true, force: true }));
  const after = packPlugin({ pluginDir: dir, outDir: outB });

  assert.notEqual(after.integrity, before.integrity);
  assert.match(after.integrity, /^sha256-[0-9a-f]{64}$/);
});
