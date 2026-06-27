// Publish-gate self-check.
//
// After the release assets are uploaded, this recomputes the sha256 of each
// uploaded asset and asserts it equals the digest recorded in the signed catalog
// entry. On any mismatch it exits non-zero, reporting the expected (catalog)
// digest versus the actual (uploaded asset) digest, which FAILS the release
// (CPHM-TC-067). This is what makes the reproducible digest load-bearing: a
// catalog whose entry does not match the bytes a user would actually download is
// never allowed to ship.
//
// In CI, point `--asset-dir` at a directory freshly populated by
// `gh release download <tag>`, so the bytes hashed here are the ones GitHub will
// actually serve, not the local build output.
//
// node:crypto only; no new dependency (CPHM-NFR-006).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { integrityOfFile } from "./pack.mjs";

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalogPath = path.resolve(args.catalog ?? "release-build/catalog.json");
  const assetDir = path.resolve(args["asset-dir"] ?? args["build-dir"] ?? "release-build");

  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const entries = catalog?.payload?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`Catalog ${catalogPath} has no payload.entries to check.`);
  }

  /** @type {string[]} */
  const failures = [];
  for (const entry of entries) {
    const fileName = `${entry.id}-${entry.version}.tgz`;
    const assetPath = path.join(assetDir, fileName);
    const expected = entry.integrity;
    let actual;
    try {
      actual = integrityOfFile(assetPath).integrity;
    } catch {
      failures.push(`  ${entry.id}: uploaded asset not found at ${assetPath}`);
      continue;
    }
    if (actual !== expected) {
      failures.push(
        `  ${entry.id}: digest mismatch\n    expected (catalog): ${expected}\n    actual (uploaded):  ${actual}`,
      );
    } else {
      process.stdout.write(`OK ${entry.id} ${expected}\n`);
    }
    // Also assert source.sha256 agrees with the top-level integrity so the two
    // fields can never silently disagree.
    if (entry.source && entry.source.sha256 && entry.source.sha256 !== expected) {
      failures.push(
        `  ${entry.id}: catalog source.sha256 (${entry.source.sha256}) != integrity (${expected})`,
      );
    }
  }

  if (failures.length > 0) {
    process.stderr.write(
      `Publish-gate self-check FAILED: uploaded asset digest does not match the catalog entry.\n${failures.join("\n")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `Publish-gate self-check passed for ${entries.length} entr${entries.length === 1 ? "y" : "ies"}.\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
