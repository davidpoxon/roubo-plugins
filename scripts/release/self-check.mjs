// Publish-gate self-check.
//
// After the release assets are uploaded, this verifies each signed catalog entry
// against the bytes that will actually ship, on two independent axes, and FAILS
// the release (exit non-zero) on any mismatch (CPHM-TC-067):
//
//   1. `source.sha256` must equal the sha256 of the UPLOADED tarball bytes (the
//      download-integrity check seed-bundle.ts performs on the fetched `.tgz`).
//   2. `integrity` must equal the UNPACKED-ARTIFACT digest the host recomputes
//      over the installed file set (roubo/server/services/marketplace-integrity.ts
//      `computePackageDigest`). It is recomputed here from the checked-out
//      source's built artifact (`computeArtifactDigest`); that is sound because
//      check 1 pins the uploaded tarball to the local pack and the build is
//      reproducible (CPHM-TC-066), so a tarball byte-identical to source unpacks
//      to this same digest. `integrity` and `source.sha256` are derived two
//      different ways and are NOT expected to be equal.
//
// This is what makes the digests load-bearing: a catalog whose entry does not
// match the bytes a user would download (or the artifact they would run) is
// never allowed to ship.
//
// In CI, point `--asset-dir` at a directory freshly populated by
// `gh release download <tag>`, so the bytes hashed here are the ones GitHub will
// actually serve, not the local build output. The built `dist/` must be present
// (the release job runs `npm run build` before this) so the unpacked-artifact
// digest can be recomputed.
//
// node:crypto only; no new dependency (CPHM-NFR-006).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeArtifactDigest, integrityOfFile, pluginDirFor } from "./pack.mjs";

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

    // 1. source.sha256 must equal the sha256 of the UPLOADED tarball bytes. This
    //    pins the bytes a user downloads (the check seed-bundle.ts performs) to a
    //    known value.
    const expectedTarball = entry.source && entry.source.sha256;
    let actualTarball;
    try {
      actualTarball = integrityOfFile(assetPath).integrity;
    } catch {
      failures.push(`  ${entry.id}: uploaded asset not found at ${assetPath}`);
      continue;
    }
    if (actualTarball !== expectedTarball) {
      failures.push(
        `  ${entry.id}: source.sha256 mismatch\n    expected (catalog source.sha256): ${expectedTarball}\n    actual (uploaded tarball):        ${actualTarball}`,
      );
    }

    // 2. integrity must equal the UNPACKED-ARTIFACT digest the host recomputes
    //    after install (computePackageDigest). Recomputed from the checked-out
    //    source's built artifact; sound because check 1 pins the uploaded tarball
    //    to the local pack and the build is reproducible (CPHM-TC-066), so a
    //    tarball byte-identical to source unpacks to this same digest.
    let actualArtifact;
    try {
      actualArtifact = computeArtifactDigest(pluginDirFor(entry.id));
    } catch (err) {
      failures.push(
        `  ${entry.id}: could not recompute the unpacked-artifact digest: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (actualArtifact !== entry.integrity) {
      failures.push(
        `  ${entry.id}: integrity mismatch\n    expected (catalog integrity): ${entry.integrity}\n    actual (unpacked artifact):   ${actualArtifact}`,
      );
    } else {
      process.stdout.write(`OK ${entry.id} ${entry.integrity}\n`);
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
