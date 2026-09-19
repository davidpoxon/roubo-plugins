// Guard B: does the DEPLOYED catalog actually list every installable plugin?
// (davidpoxon/roubo-development#759)
//
// fetch-release-assets.mjs skips a plugin whose declared version has no published
// release, with a stderr warning and no failure, so an allow-listed plugin that
// was never tagged simply never appears in the catalog. `claude-code` sat in
// INSTALLABLE_PLUGIN_IDS and in release.yml's dispatch options while being absent
// from every shipped catalog, and nothing said so.
//
// This is deliberately NOT run in the publish path. `--require-all` on
// fetch-release-assets.mjs is version-pinned, so turning it on in pages.yml would
// fail every ordinary version bump in the legitimate window between the `main`
// push and the tag push.
//
// Be exact about what that window does to the catalog, because the obvious guess
// is wrong. The `main` push carrying the bump matches pages.yml's `plugins/**`
// filter, so the catalog is regenerated from the DECLARED versions' published
// assets: the bumped plugin has no release yet, fetch-release-assets.mjs skips it,
// and sign-catalog.mjs builds entries only from the tarballs that downloaded, so
// the entry is dropped outright rather than left at the previous version. A
// single-plugin bump therefore deploys a catalog short one id, and this guard is
// RED if the cron fires in that window. That is correct, not a false alarm: the
// plugin really is unlisted. The tag push alone does not end the window either; it
// triggers release.yml, and only the pages rerun that release.yml's completion
// fires redeploys a catalog carrying the id again. (davidpoxon/roubo-plugins#104
// did this to `claude-code` for about three minutes.) An all-plugins bump behaves
// differently again: nothing downloads, fetchReleaseAssets refuses to build an
// empty catalog, the deploy fails, and the previous catalog stays up.
//
// Comparing by plugin ID rather than by version is still the load-bearing choice,
// for that last reason: when a pages deploy fails or has not run, the last good
// catalog stays up describing OLDER versions than the tree declares, and a
// by-version check would call that a gap. A plugin that has never been released
// has no entry at any version and trips within one cycle, which is the failure
// this guard exists for.
//
// Node 24's global fetch covers the network call, so no new runtime dependency
// (CPHM-NFR-006).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG_OPT_OUT, INSTALLABLE_PLUGIN_IDS } from "./pack.mjs";

/** Where the pages.yml deploy serves the signed catalog. */
export const DEFAULT_CATALOG_URL = "https://davidpoxon.github.io/roubo-plugins/catalog.json";

/**
 * Fetch and parse a JSON document over HTTPS. Split out as an injection seam so
 * the comparison below is testable offline, mirroring the `download` seam in
 * fetch-release-assets.mjs.
 *
 * @param {string} url
 * @returns {Promise<unknown>}
 */
async function httpFetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`GET ${url} returned ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

/**
 * Pull the entry ids out of a signed catalog envelope.
 *
 * sign-catalog.mjs writes `{ payload: { ..., entries: [...] }, signature }`; a
 * bare payload (`{ entries: [...] }`) is accepted too so this reader is not
 * coupled to the envelope wrapper. Anything else is a malformed catalog and is an
 * error, not an empty result: silently reading zero ids out of a
 * served-but-unexpected document would report every plugin as missing for the
 * wrong reason.
 *
 * Revoked entries still count as present. Revocation is a deliberate, recorded
 * act in marketplace/key-ring.config.json; this guard is about entries that
 * vanished because nobody noticed.
 *
 * @param {unknown} catalog
 * @returns {string[]}
 */
export function catalogEntryIds(catalog) {
  const body =
    catalog && typeof catalog === "object" && "payload" in catalog
      ? /** @type {Record<string, unknown>} */ (catalog).payload
      : catalog;
  const entries =
    body && typeof body === "object"
      ? /** @type {Record<string, unknown>} */ (body).entries
      : undefined;
  if (!Array.isArray(entries)) {
    throw new Error("catalog has no `entries` array (checked both payload.entries and entries)");
  }
  return entries
    .map((entry) => (entry && typeof entry === "object" ? entry.id : undefined))
    .filter((id) => typeof id === "string" && id !== "");
}

/**
 * Compare the deployed catalog against INSTALLABLE_PLUGIN_IDS.
 *
 * Comparison is by id only. A deployed catalog can legitimately describe an older
 * version than the tree declares, because a pages deploy that failed or has not
 * run leaves the last good catalog up, and failing on that would recreate the
 * false alarm this guard exists to avoid. It does not make a bump window green: a
 * regeneration that succeeds mid-bump drops the bumped id entirely, and a missing
 * id is reported, as it should be.
 *
 * @param {{ url?: string, ids?: string[], fetchJson?: (url: string) => Promise<unknown> }} [opts]
 * @returns {Promise<{ url: string, present: string[], missing: string[], unexpected: string[] }>}
 */
export async function verifyCatalogCoverage({
  url = DEFAULT_CATALOG_URL,
  ids = INSTALLABLE_PLUGIN_IDS,
  fetchJson = httpFetchJson,
} = {}) {
  const catalogIds = catalogEntryIds(await fetchJson(url));
  return {
    url,
    present: ids.filter((id) => catalogIds.includes(id)),
    missing: ids.filter((id) => !catalogIds.includes(id)),
    // An id the catalog serves that nothing allow-lists: not a failure here (the
    // catalog can legitimately outlive an id's removal until the next publish),
    // but worth printing.
    unexpected: catalogIds.filter((id) => !ids.includes(id)),
  };
}

async function main() {
  const urlArg = process.argv.slice(2).find((a) => a.startsWith("--catalog-url="));
  const url = urlArg ? urlArg.slice("--catalog-url=".length) : DEFAULT_CATALOG_URL;

  const { present, missing, unexpected } = await verifyCatalogCoverage({ url });

  process.stdout.write(`Checked ${url}\n`);
  for (const id of present) process.stdout.write(`  ok      ${id}\n`);
  for (const id of unexpected) {
    process.stdout.write(`  extra   ${id} (in the catalog, not in INSTALLABLE_PLUGIN_IDS)\n`);
  }
  for (const id of Object.keys(CATALOG_OPT_OUT)) {
    process.stdout.write(`  opt-out ${id} (deliberately unpublished)\n`);
  }

  if (missing.length > 0) {
    for (const id of missing) process.stdout.write(`  MISSING ${id}\n`);
    throw new Error(
      `${missing.length} installable plugin(s) have no entry in the deployed catalog: ${missing.join(", ")}\n` +
        "Each is in INSTALLABLE_PLUGIN_IDS but nothing it links to was ever published, so it is invisible in the marketplace.\n" +
        "Fix by cutting an `<id>-v<version>` release tag for it (the release workflow then republishes the catalog), or,\n" +
        "if it is not meant to publish yet (a brand-new plugin awaiting its first tag), move it out of INSTALLABLE_PLUGIN_IDS\n" +
        "and record it in CATALOG_OPT_OUT in scripts/release/pack.mjs with the reason.",
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
