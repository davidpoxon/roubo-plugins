// Publish gate: every catalog entry must agree with the asset it links to.
//
// self-check.mjs answers "does this entry match the tarball sitting in a local
// directory?", which is enough within a single tag release because the asset was
// just uploaded from that same directory. It cannot catch the failure in
// davidpoxon/roubo-development#738, where the hosted catalog was regenerated from
// `main` while `source.assetUrl` still pointed at a frozen tag asset: both halves
// were internally consistent, they just described different artifacts.
//
// This gate closes that by generalizing the check from "a local asset dir" to
// "the URL the catalog actually points a client at". For every entry it fetches
// `source.assetUrl` over HTTPS and asserts BOTH digests against the bytes served:
//
//   1. `source.sha256` vs the sha256 of the fetched `.tgz` bytes (the
//      download-integrity check seed-bundle.ts performs).
//   2. `integrity` vs the UNPACKED-ARTIFACT digest of those same bytes (the
//      digest the host recomputes after install, computePackageDigest).
//
// A non-200, a missing asset, or either mismatch fails the build with expected
// versus actual, so drift becomes a red build instead of a broken install.
//
// Uses the global fetch (Node 24) plus node:crypto/node:zlib; no new dependency
// (CPHM-NFR-006).

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeArtifactDigest, unpackTarball } from "./pack.mjs";

/**
 * Check every entry of a signed catalog against the bytes its `assetUrl` serves.
 *
 * @param {{ catalog: unknown, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<{ checked: number, ok: string[], failures: string[] }>}
 */
export async function verifyCatalogAssets({ catalog, fetchImpl = fetch }) {
  const entries = catalog?.payload?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Catalog has no payload.entries to check.");
  }

  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const ok = [];

  for (const entry of entries) {
    const url = entry?.source?.assetUrl;
    if (typeof url !== "string" || url === "") {
      failures.push(`  ${entry?.id}: entry has no source.assetUrl`);
      continue;
    }

    /** @type {Buffer} */
    let bytes;
    try {
      const response = await fetchImpl(url, { redirect: "follow" });
      if (!response.ok) {
        failures.push(`  ${entry.id}: GET ${url} returned HTTP ${response.status}`);
        continue;
      }
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      failures.push(
        `  ${entry.id}: could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    // 1. source.sha256 must equal the sha256 of the bytes actually served.
    const actualTarball = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
    if (actualTarball !== entry?.source?.sha256) {
      failures.push(
        `  ${entry.id}: source.sha256 mismatch against ${url}\n    expected (catalog source.sha256): ${entry?.source?.sha256}\n    actual (published asset):         ${actualTarball}`,
      );
      continue;
    }

    // 2. integrity must equal the unpacked-artifact digest of those same bytes.
    const work = mkdtempSync(path.join(tmpdir(), "verify-catalog-asset-"));
    try {
      const tgzPath = path.join(work, `${entry.id}-${entry.version}.tgz`);
      writeFileSync(tgzPath, bytes);
      const unpacked = path.join(work, "unpacked");
      unpackTarball(tgzPath, unpacked);
      const actualArtifact = computeArtifactDigest(unpacked);
      if (actualArtifact !== entry.integrity) {
        failures.push(
          `  ${entry.id}: integrity mismatch against ${url}\n    expected (catalog integrity):   ${entry.integrity}\n    actual (unpacked published asset): ${actualArtifact}`,
        );
      } else {
        ok.push(`${entry.id}@${entry.version}`);
      }
    } catch (err) {
      failures.push(
        `  ${entry.id}: could not unpack the published asset from ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  return { checked: entries.length, ok, failures };
}

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalogPath = path.resolve(args.catalog ?? "pages-build/catalog.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

  const { checked, ok, failures } = await verifyCatalogAssets({ catalog });
  for (const id of ok) process.stdout.write(`OK ${id}\n`);

  if (failures.length > 0) {
    process.stderr.write(
      `Catalog-versus-asset gate FAILED: a catalog entry does not match the asset it links to.\n${failures.join("\n")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `Catalog-versus-asset gate passed for ${checked} entr${checked === 1 ? "y" : "ies"}.\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
