// Build the PLAIN (unsigned) workplace marketplace catalog for a release.
//
// The workplace marketplace mirrors the first-party publish pipeline shape
// (build -> pack -> publish release asset -> regenerate catalog -> digest
// self-check) but DROPS the signing / verify-keyring gate entirely
// (CPHMTP-FR-011). It emits a PLAIN catalog.json with the same entries[] shape
// the app already consumes (id, name, kind, version, summary,
// source{type,assetUrl,sha256}, integrity, provenance), but with NO `keyId`, NO
// `{payload, signature}` envelope, and NO key ring.
//
// Because there is no signature, trust rests entirely on the per-entry sha256
// `integrity` digest, which is therefore MANDATORY: this build FAILS (exits
// non-zero, naming the offending entry) if any generated entry would lack a
// non-empty integrity digest (CPHMTP-NFR-004). The published catalog is later
// re-checked by the same publish-gate self-check (self-check.mjs), which now
// reads both the signed-envelope and this plain shape.
//
// It reuses `buildCatalogPayload` from sign-catalog.mjs verbatim to produce the
// entry shape (so the workplace entries are byte-identical to the first-party
// ones the app consumes), then strips the signing `keyId` the signed path adds.
// A placeholder keyId is passed and deleted before writing, so sign-catalog.mjs
// is not modified and the signed first-party path stays byte-identical
// (CPHMTP-NFR-001).
//
// This script imports NO crypto-signing / stdin-key logic of its own: there is
// no key material anywhere in this path.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalogPayload } from "./sign-catalog.mjs";

// A sensible default for the GHE instance releases URL. Override per environment
// with `--asset-base` or the MARKETPLACE_ASSET_BASE env var (the workplace
// workflow points this at the GHE instance's own releases download URL).
const DEFAULT_ASSET_BASE = "https://ghe.example.com/roubo-plugins/releases/download";

// Placeholder keyId handed to the reused buildCatalogPayload. The workplace
// catalog carries NO key identity, so the field is deleted from the payload
// before anything is written. Passing-and-deleting keeps the signed first-party
// path (which passes a real keyId) byte-identical: sign-catalog.mjs is untouched.
const KEY_ID_PLACEHOLDER = "unsigned-workplace";

/**
 * Enforce the mandatory-integrity floor (CPHMTP-NFR-004 / CPHMTP-TC-099): every
 * workplace entry, whose trust rests solely on its digest, MUST carry a
 * non-empty `integrity`. Throws (naming the offending entries) if any does not.
 *
 * @param {Array<Record<string, unknown>>} entries
 */
export function enforceMandatoryIntegrity(entries) {
  const missing = entries.filter(
    (e) => typeof e.integrity !== "string" || e.integrity.trim() === "",
  );
  if (missing.length > 0) {
    const ids = missing.map((e) => (typeof e.id === "string" && e.id ? e.id : "<unknown>"));
    throw new Error(
      `Workplace catalog entr${missing.length === 1 ? "y" : "ies"} missing a required integrity digest: ${ids.join(", ")}`,
    );
  }
}

/**
 * Build the plain workplace catalog: the reused first-party entry shape with the
 * signing key identity stripped, gated by the mandatory-integrity floor.
 *
 * @param {{ buildDir: string, assetBase: string }} opts
 * @returns {{ schemaVersion: number, generatedAt: string, entries: Array<Record<string, unknown>> }}
 */
export function buildWorkplaceCatalog({ buildDir, assetBase }) {
  const payload = buildCatalogPayload({ buildDir, assetBase, keyId: KEY_ID_PLACEHOLDER });
  // The workplace catalog is UNSIGNED: no key identity travels with it.
  delete payload.keyId;

  enforceMandatoryIntegrity(payload.entries);

  return payload;
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const buildDir = path.resolve(args["build-dir"] ?? "release-build");
  const assetBase = args["asset-base"] ?? process.env.MARKETPLACE_ASSET_BASE ?? DEFAULT_ASSET_BASE;
  const outPath = path.resolve(args.out ?? path.join(buildDir, "catalog.json"));

  const catalog = buildWorkplaceCatalog({ buildDir, assetBase });

  writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Wrote workplace catalog ${outPath} (${catalog.entries.length} entr${catalog.entries.length === 1 ? "y" : "ies"}, unsigned)\n`,
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
