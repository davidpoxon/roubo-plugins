// Tests for the release-asset downloader (davidpoxon/roubo-development#738).
//
// `fetchReleaseAssets` decides which plugins appear in the published catalog:
// sign-catalog.mjs only ever lists the tarballs it finds in the build dir, so a
// plugin this skips silently vanishes from the marketplace. That makes its
// skip-on-missing-release, `requireAll`, and empty-result branches load-bearing
// rather than incidental, and worth pinning here.
//
// The `download` injection seam is what keeps these tests off the network: a
// stub stands in for the `gh release download` shell-out and writes (or refuses
// to write) the asset the real CLI would have fetched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { integrityOfFile, pluginDirFor, readPluginMeta } from "../pack.mjs";
import { fetchReleaseAssets } from "../fetch-release-assets.mjs";

/** A temp directory cleaned up when the test finishes. */
function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A `download` stand-in that writes fixed bytes for the ids named in `serve`,
 * and behaves like a missing release for anything else. `fetchReleaseAssets`
 * only ever hashes the file it lands, so the bytes need not be a real tarball.
 *
 * @param {Record<string, Buffer>} serve keyed by asset file name
 * @param {{ silentIds?: string[] }} [opts] ids whose download "succeeds" but
 *   writes nothing, exercising the asset-not-in-the-release branch
 */
function stubDownload(serve, opts = {}) {
  const silent = new Set(opts.silentIds ?? []);
  return ({ tag, fileName, outDir }) => {
    if (silent.has(fileName)) return; // release exists, asset does not
    const bytes = serve[fileName];
    if (!bytes) throw new Error(`release not found: ${tag}`);
    writeFileSync(path.join(outDir, fileName), bytes);
  };
}

/** The real manifest coordinates for an installable id (never hardcoded). */
function coordsFor(id) {
  const meta = readPluginMeta(pluginDirFor(id));
  return {
    id,
    version: meta.version,
    fileName: `${id}-${meta.version}.tgz`,
    tag: `${id}-v${meta.version}`,
  };
}

test("fetchReleaseAssets lands the published asset and reports its digest", (t) => {
  const outDir = tempDir(t, "fetch-assets-ok-");
  const one = coordsFor("process");
  const bytes = Buffer.from("frozen release asset bytes");

  const { fetched, missing } = fetchReleaseAssets({
    outDir,
    ids: [one.id],
    download: stubDownload({ [one.fileName]: bytes }),
  });

  assert.deepEqual(missing, []);
  assert.equal(fetched.length, 1);
  assert.deepEqual(
    { id: fetched[0].id, version: fetched[0].version, fileName: fetched[0].fileName },
    { id: one.id, version: one.version, fileName: one.fileName },
  );
  // The digest is taken from the bytes that actually landed on disk, which is
  // the whole point: the catalog must describe the artifact, not the tree.
  assert.equal(fetched[0].integrity, integrityOfFile(path.join(outDir, one.fileName)).integrity);
  assert.deepEqual(readdirSync(outDir), [one.fileName]);
});

test("fetchReleaseAssets skips a plugin whose version has no release, keeping the rest", (t) => {
  const outDir = tempDir(t, "fetch-assets-skip-");
  const present = coordsFor("process");
  const absent = coordsFor("claude-code");

  const { fetched, missing } = fetchReleaseAssets({
    outDir,
    ids: [present.id, absent.id],
    download: stubDownload({ [present.fileName]: Buffer.from("present") }),
  });

  assert.deepEqual(
    fetched.map((f) => f.id),
    [present.id],
  );
  assert.equal(missing.length, 1);
  assert.deepEqual(
    { id: missing[0].id, version: missing[0].version, tag: missing[0].tag },
    { id: absent.id, version: absent.version, tag: absent.tag },
  );
  assert.match(missing[0].reason, /release not found/);
});

test("fetchReleaseAssets treats a release with no matching asset as missing", (t) => {
  const outDir = tempDir(t, "fetch-assets-silent-");
  const present = coordsFor("process");
  const silent = coordsFor("database");

  const { fetched, missing } = fetchReleaseAssets({
    outDir,
    ids: [present.id, silent.id],
    download: stubDownload(
      { [present.fileName]: Buffer.from("present") },
      {
        silentIds: [silent.fileName],
      },
    ),
  });

  assert.deepEqual(
    fetched.map((f) => f.id),
    [present.id],
  );
  assert.equal(missing.length, 1);
  assert.equal(missing[0].id, silent.id);
  assert.match(missing[0].reason, new RegExp(`has no asset named ${silent.fileName}`));
});

test("fetchReleaseAssets --require-all turns a skipped plugin into a hard failure", (t) => {
  const outDir = tempDir(t, "fetch-assets-require-");
  const present = coordsFor("process");
  const absent = coordsFor("claude-code");

  assert.throws(
    () =>
      fetchReleaseAssets({
        outDir,
        ids: [present.id, absent.id],
        requireAll: true,
        download: stubDownload({ [present.fileName]: Buffer.from("present") }),
      }),
    new RegExp(
      `No published release asset for: ${absent.id}@${absent.version} \\(${absent.tag}\\)`,
    ),
  );
});

test("fetchReleaseAssets refuses to build an empty catalog when nothing downloads", (t) => {
  const outDir = tempDir(t, "fetch-assets-empty-");

  assert.throws(
    () =>
      fetchReleaseAssets({
        outDir,
        ids: ["process", "database"],
        download: stubDownload({}),
      }),
    /refusing to build an empty catalog/,
  );
});
