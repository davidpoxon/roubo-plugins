// Guard A: parity between the three hand-maintained publish lists
// (davidpoxon/roubo-development#759).
//
// Whether a plugin actually reaches users is decided by three lists that nothing
// previously compared:
//
//   1. INSTALLABLE_PLUGIN_IDS in scripts/release/pack.mjs, what the catalog is
//      packed and signed from (sign-catalog.mjs skips any meta.id not in it).
//   2. The workflow_dispatch choice list in .github/workflows/release.yml, what
//      can be released manually.
//   3. The serial build chain in package.json, what gets built at all.
//
// A plugin could sit in one, two, or none of them and still look healthy: `codex`
// was in the build chain only, so it was compiled and tested on every PR while
// being unreleasable by dispatch and invisible to the catalog.
//
// These assertions are deliberately offline and constrain the lists against each
// other rather than against the outside world, so there is no chicken-and-egg with
// a not-yet-tagged plugin; the published-catalog side is Guard B
// (verify-catalog-coverage.mjs). The readers below are line/regex readers rather
// than a YAML parser, matching the convention pack.mjs already follows to avoid a
// new dependency (CPHM-NFR-006), and each parse is asserted non-empty so a future
// reformat of release.yml fails loudly instead of passing vacuously.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CATALOG_OPT_OUT, INSTALLABLE_PLUGIN_IDS, PLUGINS_DIR, REPO_ROOT } from "../pack.mjs";

const RELEASE_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "release.yml");

/**
 * Read the `workflow_dispatch` plugin choice list out of release.yml.
 *
 * The block is exactly one `options:` key followed by a flat sequence of scalar
 * ids, so a line reader is sufficient. The sequence ends at the first line that is
 * neither a list item nor blank/comment, which for this file is the next key.
 *
 * @param {string} yaml
 * @returns {string[]}
 */
function readDispatchOptions(yaml) {
  /** @type {string[]} */
  const options = [];
  let indent = -1;
  for (const rawLine of yaml.split("\n")) {
    if (indent === -1) {
      const start = /^(\s*)options:\s*$/.exec(rawLine);
      if (start) indent = start[1].length;
      continue;
    }
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) continue;
    const item = /^(\s*)-\s+(\S+)\s*$/.exec(rawLine);
    if (!item || item[1].length <= indent) break;
    options.push(item[2]);
  }
  return options;
}

/**
 * Read the npm workspace names out of the serial build chain in package.json.
 *
 * `npm run build` is a hand-maintained chain of `-w <workspace>` invocations
 * rather than a glob over plugins/*, which is precisely why it can drift.
 *
 * @param {string} buildScript
 * @returns {string[]}
 */
function readBuildChainWorkspaces(buildScript) {
  return [...buildScript.matchAll(/-w\s+(\S+)/g)].map((m) => m[1]);
}

/**
 * Map every plugin workspace's npm package name to its plugin id, read from the
 * two files that actually declare them. Resolving through the real workspaces is
 * more robust than string-stripping an `@roubo/plugin-` prefix off the `-w`
 * targets, and it also catches a `-w` target that names no workspace at all.
 *
 * @returns {Map<string, string>}
 */
function workspaceNameToPluginId() {
  /** @type {Map<string, string>} */
  const byName = new Map();
  for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = path.join(PLUGINS_DIR, entry.name, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const yaml = readFileSync(path.join(PLUGINS_DIR, entry.name, "roubo-plugin.yaml"), "utf8");
    const idLine = /^id:\s*(\S+)\s*$/m.exec(yaml);
    assert.ok(idLine, `plugins/${entry.name}/roubo-plugin.yaml declares no top-level id`);
    byName.set(pkg.name, idLine[1].replace(/^["']|["']$/g, ""));
  }
  return byName;
}

const dispatchOptions = readDispatchOptions(readFileSync(RELEASE_WORKFLOW, "utf8"));
const rootPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
const buildChainWorkspaces = readBuildChainWorkspaces(rootPkg.scripts.build);
const idByWorkspace = workspaceNameToPluginId();

test("the release.yml dispatch options and the build chain both parse", () => {
  // Without these, every assertion below would pass vacuously against an empty
  // set if release.yml's options block or the build script were ever reshaped.
  assert.ok(
    dispatchOptions.length > 0,
    "parsed no workflow_dispatch plugin options out of .github/workflows/release.yml; the reader needs updating for its current shape",
  );
  assert.ok(
    buildChainWorkspaces.length > 0,
    'parsed no `-w` targets out of the "build" script in package.json; the reader needs updating for its current shape',
  );
  assert.ok(INSTALLABLE_PLUGIN_IDS.length > 0, "INSTALLABLE_PLUGIN_IDS is empty");
});

test("every `-w` target in the build chain names a real plugin workspace", () => {
  const unknown = buildChainWorkspaces.filter((name) => !idByWorkspace.has(name));
  assert.deepEqual(
    unknown,
    [],
    `the "build" script targets workspaces that do not exist under plugins/: ${unknown.join(", ")}`,
  );
});

test("every plugin workspace is in the build chain", () => {
  // The reverse direction, and the one that closes the last way a plugin can be
  // in NO list at all: `workspaces: ["plugins/*"]` picks a new directory up
  // automatically, so a plugin nobody adds to the hand-maintained `-w` chain is
  // absent from the build chain, from INSTALLABLE_PLUGIN_IDS, and from
  // CATALOG_OPT_OUT, and every other assertion here iterates one of those three.
  const unbuilt = [...idByWorkspace.keys()].filter((name) => !buildChainWorkspaces.includes(name));
  assert.deepEqual(
    unbuilt,
    [],
    `these workspaces exist under plugins/ but are absent from the "build" chain in package.json, so they are never built: ${unbuilt.join(", ")}`,
  );
});

const buildChainIds = buildChainWorkspaces
  .map((name) => idByWorkspace.get(name))
  .filter((id) => id !== undefined);

test("every installable plugin can be released by manual dispatch", () => {
  const missing = INSTALLABLE_PLUGIN_IDS.filter((id) => !dispatchOptions.includes(id));
  assert.deepEqual(
    missing,
    [],
    `these ids are in INSTALLABLE_PLUGIN_IDS but not in the workflow_dispatch options of .github/workflows/release.yml, so they cannot be released manually: ${missing.join(", ")}`,
  );
});

test("every installable plugin is actually built", () => {
  const missing = INSTALLABLE_PLUGIN_IDS.filter((id) => !buildChainIds.includes(id));
  assert.deepEqual(
    missing,
    [],
    `these ids are in INSTALLABLE_PLUGIN_IDS but absent from the "build" chain in package.json, so nothing packs them: ${missing.join(", ")}`,
  );
});

test("every dispatchable plugin is installable", () => {
  const extra = dispatchOptions.filter((id) => !INSTALLABLE_PLUGIN_IDS.includes(id));
  assert.deepEqual(
    extra,
    [],
    `these ids are offered by the release workflow's dispatch options but are not in INSTALLABLE_PLUGIN_IDS, so releasing them would still leave them out of the catalog: ${extra.join(", ")}`,
  );
});

test("every built plugin is either installable or explicitly opted out of the catalog", () => {
  const unaccounted = buildChainIds.filter(
    (id) => !INSTALLABLE_PLUGIN_IDS.includes(id) && !(id in CATALOG_OPT_OUT),
  );
  assert.deepEqual(
    unaccounted,
    [],
    `these ids are built but neither in INSTALLABLE_PLUGIN_IDS nor recorded in CATALOG_OPT_OUT; add them to one or the other so the exclusion is a stated decision: ${unaccounted.join(", ")}`,
  );
});

test("no CATALOG_OPT_OUT entry is stale", () => {
  const optedOut = Object.keys(CATALOG_OPT_OUT);

  const alsoInstallable = optedOut.filter((id) => INSTALLABLE_PLUGIN_IDS.includes(id));
  assert.deepEqual(
    alsoInstallable,
    [],
    `these ids are in CATALOG_OPT_OUT and in INSTALLABLE_PLUGIN_IDS at once; drop the opt-out now that they publish: ${alsoInstallable.join(", ")}`,
  );

  const notBuilt = optedOut.filter((id) => !buildChainIds.includes(id));
  assert.deepEqual(
    notBuilt,
    [],
    `these ids are in CATALOG_OPT_OUT but are not in the "build" chain, so the opt-out no longer describes anything: ${notBuilt.join(", ")}`,
  );

  const reasonless = optedOut.filter((id) => String(CATALOG_OPT_OUT[id] ?? "").trim() === "");
  assert.deepEqual(
    reasonless,
    [],
    `these CATALOG_OPT_OUT entries carry no reason; the point of the list is that the exclusion is stated: ${reasonless.join(", ")}`,
  );
});
