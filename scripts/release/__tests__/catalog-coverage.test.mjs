// Tests for Guard B's comparison (davidpoxon/roubo-development#759).
//
// verify-catalog-coverage.mjs runs on a schedule against the DEPLOYED catalog, so
// the branch that matters (an allow-listed id with no catalog entry) can never be
// exercised by the scheduled run itself until it has already gone wrong. The
// `fetchJson` injection seam, mirroring the `download` seam in
// fetch-release-assets.mjs, is what lets the decision be pinned here offline.
//
// The by-ID (not by-version) comparison is the load-bearing choice: during an
// ordinary version bump the deployed catalog still carries the PREVIOUS version's
// entry, and the guard must stay green for that whole window.

import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogEntryIds, verifyCatalogCoverage } from "../verify-catalog-coverage.mjs";

/** A signed-envelope catalog carrying exactly these entries. */
function envelope(entries) {
  return {
    payload: {
      schemaVersion: 1,
      generatedAt: "2026-08-04T00:00:00.000Z",
      keyId: "test-key",
      entries,
    },
    signature: "not-verified-here",
  };
}

/** A `fetchJson` stand-in that serves a fixed document, and records the URL. */
function stubFetch(doc, seen = []) {
  return async (url) => {
    seen.push(url);
    return doc;
  };
}

test("every installable id present in the deployed catalog reports no gap", async () => {
  const ids = ["claude-code", "database"];
  const doc = envelope([
    { id: "claude-code", version: "0.2.0" },
    { id: "database", version: "0.1.0" },
  ]);
  const result = await verifyCatalogCoverage({ ids, fetchJson: stubFetch(doc) });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.present, ids);
  assert.deepEqual(result.unexpected, []);
});

test("an installable id with no catalog entry is reported missing", async () => {
  // The claude-code mode: allow-listed, dispatchable, built, and yet never in a
  // shipped catalog because no tag was ever cut.
  const doc = envelope([{ id: "database", version: "0.1.0" }]);
  const result = await verifyCatalogCoverage({
    ids: ["claude-code", "database"],
    fetchJson: stubFetch(doc),
  });
  assert.deepEqual(result.missing, ["claude-code"]);
  assert.deepEqual(result.present, ["database"]);
});

test("a version bump window does not trip the guard", async () => {
  // The catalog still describes the PREVIOUS version between the `main` push and
  // the tag push. Comparing by id keeps that legitimate window green.
  const doc = envelope([{ id: "github-com", version: "0.3.0" }]);
  const result = await verifyCatalogCoverage({ ids: ["github-com"], fetchJson: stubFetch(doc) });
  assert.deepEqual(result.missing, []);
});

test("a catalog entry nobody allow-lists is surfaced but is not a gap", async () => {
  const doc = envelope([
    { id: "database", version: "0.1.0" },
    { id: "retired", version: "0.0.1" },
  ]);
  const result = await verifyCatalogCoverage({ ids: ["database"], fetchJson: stubFetch(doc) });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.unexpected, ["retired"]);
});

test("an empty catalog reports every installable id as missing", async () => {
  const result = await verifyCatalogCoverage({
    ids: ["claude-code", "database"],
    fetchJson: stubFetch(envelope([])),
  });
  assert.deepEqual(result.missing, ["claude-code", "database"]);
});

test("a malformed catalog throws rather than reporting a false full gap", async () => {
  await assert.rejects(
    verifyCatalogCoverage({ ids: ["database"], fetchJson: stubFetch({ nonsense: true }) }),
    /no `entries` array/,
  );
});

test("a transport failure propagates instead of being read as an empty catalog", async () => {
  await assert.rejects(
    verifyCatalogCoverage({
      ids: ["database"],
      fetchJson: async () => {
        throw new Error("GET https://example.invalid/catalog.json returned 404 Not Found");
      },
    }),
    /404 Not Found/,
  );
});

test("the catalog URL defaults to the deployed Pages location", async () => {
  const seen = [];
  await verifyCatalogCoverage({
    ids: [],
    fetchJson: stubFetch(envelope([{ id: "database", version: "0.1.0" }]), seen),
  });
  assert.deepEqual(seen, ["https://davidpoxon.github.io/roubo-plugins/catalog.json"]);
});

test("catalogEntryIds reads a bare payload as well as a signed envelope", () => {
  assert.deepEqual(catalogEntryIds({ entries: [{ id: "process" }] }), ["process"]);
  assert.deepEqual(catalogEntryIds(envelope([{ id: "process" }])), ["process"]);
});
