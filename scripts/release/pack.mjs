// Per-plugin reproducible build artifact packer.
//
// Assembles a normalized, byte-stable tarball for one plugin (the ReleaseAsset:
// dist/ + roubo-plugin.yaml + package.json + README), computes its sha256, and
// prints `sha256-<hex>`. Running it twice on the same source yields an identical
// digest (CPHM-TC-066), so the digest the app verifies is reproducible rather
// than aspirational.
//
// Determinism recipe (every byte is pinned, nothing is read from the wall clock
// or the host environment):
//   - Fixed entry set, sorted by path (directory entries before their files).
//   - ustar (POSIX) headers with mtime=0, uid=0, gid=0, fixed mode
//     (0644 files / 0755 dirs), empty uname/gname, no device/pax/GNU extras.
//   - A hand-built gzip container over raw DEFLATE: the gzip MTIME field is
//     zeroed and the OS byte is fixed to 0xff (unknown), so neither the wall
//     clock nor the build host leaks into the bytes.
//   - The toolchain is pinned by .nvmrc (24.15.0) + `npm ci` against the
//     committed lockfile, so DEFLATE output is identical across runs.
//
// Uses node:crypto and node:zlib only; adds no crypto/supply-chain dependency
// (CPHM-NFR-006). Hand-rolling the ustar + gzip writer (rather than shelling out
// to `tar`/`gzip`) is what makes the output independent of the host's tar/gzip
// implementation.

import { createHash } from "node:crypto";
import { deflateRawSync, constants as zlibConstants } from "node:zlib";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..", "..");
export const PLUGINS_DIR = path.join(REPO_ROOT, "plugins");

/**
 * The installable plugins published to the marketplace. `_shared-github` is a
 * build-only internal package (no roubo-plugin.yaml) and is intentionally not
 * publishable.
 */
export const INSTALLABLE_PLUGIN_IDS = [
  "database",
  "ghe",
  "github-com",
  "jira-self-hosted",
  "process",
];

/** Files that always go into the tarball, in addition to the whole dist/ tree. */
const TOP_LEVEL_ENTRIES = ["package.json", "roubo-plugin.yaml", "README.md"];

/**
 * Read the small set of catalog-relevant scalars from a plugin's
 * roubo-plugin.yaml. These are all top-level single-line scalar keys in every
 * plugin manifest, so a minimal line reader is sufficient and avoids adding a
 * YAML dependency (CPHM-NFR-006). The version is cross-checked against
 * package.json so the two never silently diverge.
 *
 * @param {string} pluginDir
 * @returns {{ id: string, name: string, version: string, kind: string, summary: string }}
 */
export function readPluginMeta(pluginDir) {
  const yamlPath = path.join(pluginDir, "roubo-plugin.yaml");
  const yaml = readFileSync(yamlPath, "utf8");
  /** @type {Record<string, string>} */
  const scalars = {};
  for (const rawLine of yaml.split("\n")) {
    // Only top-level (column-0) `key: value` scalar lines; stop reading a key's
    // value at the line end. Nested/list lines start with whitespace or `-`.
    const m = /^([A-Za-z][A-Za-z0-9_]*):\s?(.*)$/.exec(rawLine);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in scalars)) scalars[key] = val;
  }

  for (const required of ["id", "name", "version", "kind"]) {
    if (!scalars[required]) {
      throw new Error(`roubo-plugin.yaml at ${yamlPath} is missing required key '${required}'`);
    }
  }

  const pkg = JSON.parse(readFileSync(path.join(pluginDir, "package.json"), "utf8"));
  if (pkg.version !== scalars.version) {
    throw new Error(
      `Version mismatch for plugin '${scalars.id}': roubo-plugin.yaml says ${scalars.version}, package.json says ${pkg.version}`,
    );
  }

  return {
    id: scalars.id,
    name: scalars.name,
    version: scalars.version,
    kind: scalars.kind,
    summary: scalars.description ?? "",
  };
}

/**
 * Resolve a plugin id to its source directory under plugins/.
 *
 * @param {string} pluginId
 * @returns {string}
 */
export function pluginDirFor(pluginId) {
  return path.join(PLUGINS_DIR, pluginId);
}

/** Pad an octal number into a fixed-width NUL-terminated ustar field. */
function octalField(value, width) {
  // ustar numeric fields: `width-1` octal digits, zero-padded, then a NUL.
  const str = value.toString(8).padStart(width - 1, "0");
  return Buffer.from(`${str}\0`, "ascii");
}

/**
 * Build one 512-byte ustar header block.
 *
 * @param {{ name: string, size: number, mode: number, typeflag: "0" | "5" }} entry
 * @returns {Buffer}
 */
function ustarHeader(entry) {
  if (Buffer.byteLength(entry.name, "utf8") > 100) {
    // The fixed entry set is short (dist/index.js, package.json, ...), so long
    // names never occur. Fail loudly rather than silently emit a malformed or
    // non-portable header.
    throw new Error(`Entry name too long for ustar (>100 bytes): ${entry.name}`);
  }
  const header = Buffer.alloc(512, 0);
  header.write(entry.name, 0, "utf8"); // name[100]
  octalField(entry.mode & 0o7777, 8).copy(header, 100); // mode[8]
  octalField(0, 8).copy(header, 108); // uid[8]
  octalField(0, 8).copy(header, 116); // gid[8]
  octalField(entry.size, 12).copy(header, 124); // size[12]
  octalField(0, 12).copy(header, 136); // mtime[12] (fixed epoch 0)
  header.write("        ", 148, "ascii"); // chksum[8] placeholder = spaces
  header.write(entry.typeflag, 156, "ascii"); // typeflag[1]
  // linkname[100] stays zero.
  header.write("ustar\0", 257, "ascii"); // magic[6]
  header.write("00", 263, "ascii"); // version[2]
  // uname[32], gname[32], devmajor[8], devminor[8], prefix[155] stay zero.

  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  // chksum stored as 6 octal digits, a NUL, then a space.
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

/**
 * Collect the fixed entry set for a plugin's built package, sorted so a
 * directory always precedes its contents. dist/ must already be built.
 *
 * @param {string} pluginDir
 * @returns {Array<{ name: string, isDir: boolean, content: Buffer }>}
 */
function collectEntries(pluginDir) {
  /** @type {Array<{ name: string, isDir: boolean, content: Buffer }>} */
  const entries = [];

  const distDir = path.join(pluginDir, "dist");
  let distStat;
  try {
    distStat = statSync(distDir);
  } catch {
    distStat = undefined;
  }
  if (!distStat || !distStat.isDirectory()) {
    throw new Error(
      `dist/ not found for ${pluginDir}. Run \`npm run build\` before packing (the artifact must be built).`,
    );
  }

  /** @param {string} dirAbs @param {string} relPrefix */
  const walk = (dirAbs, relPrefix) => {
    entries.push({ name: `${relPrefix}/`, isDir: true, content: Buffer.alloc(0) });
    const names = readdirSync(dirAbs).sort();
    for (const childName of names) {
      const childAbs = path.join(dirAbs, childName);
      const childRel = `${relPrefix}/${childName}`;
      const st = statSync(childAbs);
      if (st.isDirectory()) {
        walk(childAbs, childRel);
      } else if (st.isFile()) {
        entries.push({ name: childRel, isDir: false, content: readFileSync(childAbs) });
      }
      // Symlinks / other types are intentionally skipped: a built artifact is
      // plain files and directories only.
    }
  };

  walk(distDir, "dist");

  for (const topName of TOP_LEVEL_ENTRIES) {
    const abs = path.join(pluginDir, topName);
    entries.push({ name: topName, isDir: false, content: readFileSync(abs) });
  }

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

/**
 * Assemble the uncompressed ustar archive bytes for a plugin.
 *
 * @param {string} pluginDir
 * @returns {Buffer}
 */
function buildTar(pluginDir) {
  const entries = collectEntries(pluginDir);
  /** @type {Buffer[]} */
  const blocks = [];
  for (const entry of entries) {
    if (entry.isDir) {
      blocks.push(ustarHeader({ name: entry.name, size: 0, mode: 0o755, typeflag: "5" }));
    } else {
      blocks.push(
        ustarHeader({ name: entry.name, size: entry.content.length, mode: 0o644, typeflag: "0" }),
      );
      blocks.push(entry.content);
      const remainder = entry.content.length % 512;
      if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  // Two zero blocks terminate the archive, then pad to a 10240-byte (20-record)
  // boundary as conventional tar implementations do. Deterministic either way.
  blocks.push(Buffer.alloc(1024, 0));
  let tar = Buffer.concat(blocks);
  const blockingFactor = 10240;
  const pad = (blockingFactor - (tar.length % blockingFactor)) % blockingFactor;
  if (pad !== 0) tar = Buffer.concat([tar, Buffer.alloc(pad, 0)]);
  return tar;
}

/** CRC32 (IEEE) over a buffer, dependency-free. */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Wrap raw DEFLATE output in a fully-pinned gzip container. Unlike
 * `zlib.gzipSync`, every header byte is controlled here: MTIME is zeroed and the
 * OS byte is fixed, so the wall clock and build host never leak into the digest.
 *
 * @param {Buffer} raw
 * @returns {Buffer}
 */
function gzip(raw) {
  const deflated = deflateRawSync(raw, { level: zlibConstants.Z_BEST_COMPRESSION });
  const header = Buffer.from([
    0x1f,
    0x8b, // gzip magic
    0x08, // CM = DEFLATE
    0x00, // FLG = 0
    0x00,
    0x00,
    0x00,
    0x00, // MTIME = 0 (no embedded timestamp)
    0x02, // XFL = best compression
    0xff, // OS = unknown (fixed, not host-dependent)
  ]);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(raw), 0);
  trailer.writeUInt32LE(raw.length >>> 0, 4);
  return Buffer.concat([header, deflated, trailer]);
}

/**
 * Build the normalized tarball for one plugin and return its digest. When
 * `outDir` is provided the `.tgz` is written there as `<id>-<version>.tgz`.
 *
 * @param {{ pluginDir: string, outDir?: string }} opts
 * @returns {{ id: string, name: string, kind: string, version: string, summary: string, tarballPath: string | null, fileName: string, sha256Hex: string, integrity: string }}
 */
export function packPlugin({ pluginDir, outDir }) {
  const meta = readPluginMeta(pluginDir);
  const tar = buildTar(pluginDir);
  const tgz = gzip(tar);
  const sha256Hex = createHash("sha256").update(tgz).digest("hex");
  const fileName = `${meta.id}-${meta.version}.tgz`;

  let tarballPath = null;
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    tarballPath = path.join(outDir, fileName);
    writeFileSync(tarballPath, tgz);
  }

  return {
    id: meta.id,
    name: meta.name,
    kind: meta.kind,
    version: meta.version,
    summary: meta.summary,
    tarballPath,
    fileName,
    sha256Hex,
    integrity: `sha256-${sha256Hex}`,
  };
}

/** Compute the `sha256-<hex>` integrity string of an existing file. */
export function integrityOfFile(filePath) {
  const sha256Hex = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  return { sha256Hex, integrity: `sha256-${sha256Hex}` };
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
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[token.slice(2)] = next;
        i++;
      } else {
        out[token.slice(2)] = true;
      }
    }
  }
  return out;
}

function resolvePluginIds(args) {
  if (args.all) return INSTALLABLE_PLUGIN_IDS;
  if (typeof args.plugin === "string") {
    const ids = args.plugin
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const id of ids) {
      if (!INSTALLABLE_PLUGIN_IDS.includes(id)) {
        throw new Error(`Unknown plugin id '${id}'. Known: ${INSTALLABLE_PLUGIN_IDS.join(", ")}`);
      }
    }
    return ids;
  }
  throw new Error("Specify --plugin <id[,id...]> or --all");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir =
    typeof args["out-dir"] === "string" ? path.resolve(String(args["out-dir"])) : undefined;
  const ids = resolvePluginIds(args);
  for (const id of ids) {
    const result = packPlugin({ pluginDir: pluginDirFor(id), outDir });
    // Only the digest, file name, and path are printed: no key material, no
    // file contents (CPHM-NFR-006 / AC3 hygiene).
    process.stdout.write(`${result.id} ${result.integrity} ${result.fileName}\n`);
  }
}

// Run as a CLI only when invoked directly, not when imported by sign/self-check.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
