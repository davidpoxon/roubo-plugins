// Tests for catalog-versus-asset agreement (davidpoxon/roubo-development#738).
//
// The hosted catalog used to be regenerated from a fresh pack of `main` while
// each entry's `source.assetUrl` still pointed at a frozen tag asset. Both halves
// were internally consistent, so the existing within-run publish gate passed,
// yet the advertised digest described a different artifact from the one a client
// downloads: a marketplace install of `process` fetched the release asset, hashed
// it, and failed its integrity check.
//
// These pin the fix on three axes: the tarball reader round-trips the writer, a
// catalog built with `--digest-source asset` describes the TARBALL rather than
// the current tree, and the new gate catches an entry whose digests came from a
// different tree than the bytes its assetUrl serves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  INSTALLABLE_PLUGIN_IDS,
  computeArtifactDigest,
  integrityOfFile,
  packPlugin,
  readPluginMeta,
  unpackTarball,
} from "../pack.mjs";
import { buildCatalogPayload } from "../sign-catalog.mjs";
import { verifyCatalogAssets } from "../verify-catalog-assets.mjs";

/**
 * Build a fixture plugin directory carrying exactly the file set pack.mjs ships
 * (the dist/ tree plus package.json, roubo-plugin.yaml, README.md), for the id
 * given. Borrowing a real installable id matters: the catalog builder only lists
 * curated first-party ids, so a made-up id would be filtered out.
 *
 * @param {import("node:test").TestContext} t
 * @param {{ id?: string, version?: string, marker?: string, summary?: string }} [opts]
 * @returns {string}
 */
function makeFixturePlugin(t, opts = {}) {
  const id = opts.id ?? INSTALLABLE_PLUGIN_IDS[0];
  const version = opts.version ?? "9.9.9";
  const marker = opts.marker ?? "original";
  const summary = opts.summary ?? "A fixture plugin for catalog-asset agreement";

  const dir = mkdtempSync(path.join(tmpdir(), "catalog-asset-fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: `fixture-${id}`, version, private: true }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(dir, "roubo-plugin.yaml"),
    [
      `id: ${id}`,
      `name: Fixture ${id}`,
      `version: ${version}`,
      "kind: component",
      `description: ${summary}`,
      "roubo: ^1.0.0",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(dir, "README.md"), `# Fixture ${id}\n`);
  mkdirSync(path.join(dir, "dist", "sub"), { recursive: true });
  writeFileSync(path.join(dir, "dist", "index.js"), `export const marker = "${marker}";\n`);
  writeFileSync(path.join(dir, "dist", "sub", "helper.js"), "export const help = () => 42;\n");
  return dir;
}

/** A temp directory cleaned up when the test finishes. */
function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A `fetch` stand-in that serves a fixed byte map by URL, so the gate can be
 * exercised without network access.
 *
 * @param {Record<string, Buffer>} byUrl
 */
function stubFetch(byUrl) {
  return async (url) => {
    const bytes = byUrl[String(url)];
    if (!bytes) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
}

test("unpackTarball round-trips packPlugin: the unpacked artifact digest matches the source tree", (t) => {
  const dir = makeFixturePlugin(t);
  const outDir = tempDir(t, "catalog-asset-out-");
  const packed = packPlugin({ pluginDir: dir, outDir });

  const unpacked = path.join(tempDir(t, "catalog-asset-unpack-"), "extracted");
  unpackTarball(packed.tarballPath, unpacked);

  // The whole point of the reader: an extracted release asset can be fed to the
  // existing helpers unchanged, so there is only ever one digest implementation.
  assert.equal(computeArtifactDigest(unpacked), computeArtifactDigest(dir));
  assert.deepEqual(readPluginMeta(unpacked), readPluginMeta(dir));
  assert.equal(
    readFileSync(path.join(unpacked, "dist", "sub", "helper.js"), "utf8"),
    "export const help = () => 42;\n",
  );
});

test("buildCatalogPayload --digest-source asset describes the tarball, not the current tree", (t) => {
  const id = INSTALLABLE_PLUGIN_IDS[0];
  const buildDir = tempDir(t, "catalog-asset-build-");

  // Pack the frozen "released" tree, then move the source on, exactly as `main`
  // moves past a tag. The tarball in buildDir is now the only record of what was
  // actually published.
  const releasedTree = makeFixturePlugin(t, { id, marker: "released", summary: "As released" });
  const packed = packPlugin({ pluginDir: releasedTree, outDir: buildDir });
  const releasedArtifactDigest = computeArtifactDigest(releasedTree);

  writeFileSync(path.join(releasedTree, "dist", "index.js"), 'export const marker = "moved on";\n');
  assert.notEqual(computeArtifactDigest(releasedTree), releasedArtifactDigest);

  const payload = buildCatalogPayload({
    buildDir,
    assetBase: "https://example.invalid/releases/download",
    keyId: "ed25519-0000000000000000",
    digestSource: "asset",
  });

  const entry = payload.entries.find((e) => e.id === id);
  assert.ok(entry, `expected a catalog entry for ${id}`);
  assert.equal(entry.source.sha256, packed.integrity);
  assert.equal(entry.integrity, releasedArtifactDigest);
  // Display metadata is read from inside the tarball too, closing the secondary
  // drift vector (name / summary / roubo were read from HEAD before).
  assert.equal(entry.summary, "As released");
  assert.equal(entry.version, packed.version);
  assert.equal(
    entry.source.assetUrl,
    `https://example.invalid/releases/download/${id}-v${packed.version}/${packed.fileName}`,
  );
});

test("verifyCatalogAssets passes when the catalog describes the asset it links to", async (t) => {
  const id = INSTALLABLE_PLUGIN_IDS[0];
  const buildDir = tempDir(t, "catalog-asset-gate-ok-");
  const tree = makeFixturePlugin(t, { id });
  const packed = packPlugin({ pluginDir: tree, outDir: buildDir });

  const payload = buildCatalogPayload({
    buildDir,
    assetBase: "https://example.invalid/releases/download",
    keyId: "ed25519-0000000000000000",
    digestSource: "asset",
  });
  const entry = payload.entries.find((e) => e.id === id);

  const result = await verifyCatalogAssets({
    catalog: { payload },
    fetchImpl: stubFetch({ [entry.source.assetUrl]: readFileSync(packed.tarballPath) }),
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok.length, payload.entries.length);
});

test("verifyCatalogAssets fails when the catalog digest and the served asset disagree (the #738 shape)", async (t) => {
  const id = INSTALLABLE_PLUGIN_IDS[0];
  const id2 = INSTALLABLE_PLUGIN_IDS[1];

  // Catalog built from one tree ("HEAD"), asset served from another ("the frozen
  // tag"). That is precisely the drift the within-run self-check cannot see.
  const headDir = tempDir(t, "catalog-asset-head-");
  const headTree = makeFixturePlugin(t, { id, marker: "head" });
  packPlugin({ pluginDir: headTree, outDir: headDir });

  const taggedDir = tempDir(t, "catalog-asset-tagged-");
  const taggedTree = makeFixturePlugin(t, { id: id2, marker: "tagged" });
  const taggedPack = packPlugin({ pluginDir: taggedTree, outDir: taggedDir });

  const payload = buildCatalogPayload({
    buildDir: headDir,
    assetBase: "https://example.invalid/releases/download",
    keyId: "ed25519-0000000000000000",
    digestSource: "asset",
  });
  const entry = payload.entries.find((e) => e.id === id);
  assert.notEqual(
    integrityOfFile(taggedPack.tarballPath).integrity,
    entry.source.sha256,
    "fixture precondition: the two trees must pack to different bytes",
  );

  const result = await verifyCatalogAssets({
    catalog: { payload },
    fetchImpl: stubFetch({ [entry.source.assetUrl]: readFileSync(taggedPack.tarballPath) }),
  });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /source\.sha256 mismatch/);
  assert.match(result.failures[0], new RegExp(entry.source.sha256));
});

test("verifyCatalogAssets fails when an entry's assetUrl serves nothing", async (t) => {
  const id = INSTALLABLE_PLUGIN_IDS[0];
  const buildDir = tempDir(t, "catalog-asset-404-");
  packPlugin({ pluginDir: makeFixturePlugin(t, { id }), outDir: buildDir });

  const payload = buildCatalogPayload({
    buildDir,
    assetBase: "https://example.invalid/releases/download",
    keyId: "ed25519-0000000000000000",
    digestSource: "asset",
  });

  const result = await verifyCatalogAssets({ catalog: { payload }, fetchImpl: stubFetch({}) });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /HTTP 404/);
});

test("verifyCatalogAssets fails when the bytes hash right but unpack to a different artifact", async (t) => {
  // The second axis on its own: source.sha256 agrees (the gate is looking at the
  // bytes the catalog was built from) while `integrity` was recorded from
  // somewhere else, which is what a client recomputes after install.
  const id = INSTALLABLE_PLUGIN_IDS[0];
  const buildDir = tempDir(t, "catalog-asset-integrity-");
  const packed = packPlugin({ pluginDir: makeFixturePlugin(t, { id }), outDir: buildDir });

  const payload = buildCatalogPayload({
    buildDir,
    assetBase: "https://example.invalid/releases/download",
    keyId: "ed25519-0000000000000000",
    digestSource: "asset",
  });
  const entry = payload.entries.find((e) => e.id === id);
  entry.integrity = `sha256-${createHash("sha256").update("not the artifact").digest("hex")}`;

  const result = await verifyCatalogAssets({
    catalog: { payload },
    fetchImpl: stubFetch({ [entry.source.assetUrl]: readFileSync(packed.tarballPath) }),
  });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /integrity mismatch/);
});
