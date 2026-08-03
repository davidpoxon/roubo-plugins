// Download the PUBLISHED Release asset for every installable plugin.
//
// The hosted catalog (pages.yml) used to be regenerated from a fresh pack of
// `main` while each entry's `source.assetUrl` still pointed at a frozen tag
// asset, so the two drifted apart the moment `main` moved past a tag and a
// marketplace install failed its integrity check
// (davidpoxon/roubo-development#738). This script inverts the source of truth:
// it fetches the artifact a client would actually download, and sign-catalog.mjs
// `--digest-source asset` then describes THAT artifact.
//
// A plugin whose manifest version has no published release is SKIPPED with a
// loud warning and simply does not appear in the catalog, which is strictly more
// honest than advertising an entry whose assetUrl 404s. `--require-all` makes a
// missing release fatal instead.
//
// Uses the `gh` CLI (already available in Actions and authenticated via
// GH_TOKEN) rather than a new dependency (CPHM-NFR-006).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALLABLE_PLUGIN_IDS, integrityOfFile, pluginDirFor, readPluginMeta } from "./pack.mjs";

/**
 * Download one plugin's release asset with the `gh` CLI. Split out so tests and
 * callers can substitute a downloader without shelling out.
 *
 * @param {{ tag: string, fileName: string, outDir: string }} opts
 */
function ghDownload({ tag, fileName, outDir }) {
  execFileSync(
    "gh",
    ["release", "download", tag, "--pattern", fileName, "--dir", outDir, "--clobber"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

/**
 * Fetch the release asset for each requested plugin into `outDir`.
 *
 * @param {{ outDir: string, ids?: string[], requireAll?: boolean, download?: typeof ghDownload }} opts
 * @returns {{ fetched: Array<{ id: string, version: string, fileName: string, integrity: string }>, missing: Array<{ id: string, version: string, tag: string, reason: string }> }}
 */
export function fetchReleaseAssets({
  outDir,
  ids = INSTALLABLE_PLUGIN_IDS,
  requireAll = false,
  download = ghDownload,
}) {
  mkdirSync(outDir, { recursive: true });

  const fetched = [];
  const missing = [];
  for (const id of ids) {
    const meta = readPluginMeta(pluginDirFor(id));
    const tag = `${meta.id}-v${meta.version}`;
    const fileName = `${meta.id}-${meta.version}.tgz`;
    const assetPath = path.join(outDir, fileName);
    try {
      download({ tag, fileName, outDir });
      if (!existsSync(assetPath)) {
        throw new Error(`release ${tag} has no asset named ${fileName}`);
      }
    } catch (err) {
      missing.push({
        id: meta.id,
        version: meta.version,
        tag,
        reason: err instanceof Error ? err.message.trim() : String(err),
      });
      continue;
    }
    fetched.push({
      id: meta.id,
      version: meta.version,
      fileName,
      integrity: integrityOfFile(assetPath).integrity,
    });
  }

  if (requireAll && missing.length > 0) {
    throw new Error(
      `No published release asset for: ${missing.map((m) => `${m.id}@${m.version} (${m.tag})`).join(", ")}`,
    );
  }
  if (fetched.length === 0) {
    throw new Error(
      `No published release assets could be downloaded into ${outDir}; refusing to build an empty catalog.`,
    );
  }
  return { fetched, missing };
}

/** Parse `--flag value` / `--flag=value` / `--bool` argv into a map. */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
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
      out[token.slice(2)] = true;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(String(args["out-dir"] ?? "release-build"));
  const ids =
    typeof args.plugin === "string"
      ? args.plugin
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : INSTALLABLE_PLUGIN_IDS;

  const { fetched, missing } = fetchReleaseAssets({
    outDir,
    ids,
    requireAll: args["require-all"] === true || args["require-all"] === "true",
  });

  for (const entry of missing) {
    // Loud, but not fatal by default: the plugin drops out of the catalog rather
    // than being advertised with an assetUrl nothing serves.
    process.stderr.write(
      `WARNING: no published release asset for ${entry.id}@${entry.version} (expected tag ${entry.tag}); it will NOT appear in the catalog.\n  ${entry.reason}\n`,
    );
  }
  for (const entry of fetched) {
    process.stdout.write(`${entry.id} ${entry.integrity} ${entry.fileName}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
