# Running a third-party Roubo marketplace

This document is for publishers who want to stand up their **own** Roubo
marketplace: a catalog of Roubo plugins (component, integration, or agent
plugins) that a Roubo user can register as an additional source and install
from. It is written against this repository, which is the reference
implementation: the build and publish scripts under `scripts/release/`, the
per-plugin release assets, and the `.github/workflows/release.yml` pipeline are
the shape you mirror.

The one deliberate difference: a third-party source is **unsigned**. The
first-party marketplace wraps its catalog in a signed envelope and verifies it
against an embedded root key through a signed key-ring (see
[CONTRIBUTING.md](./CONTRIBUTING.md), "Marketplace key rotation and
revocation"). A third-party source has no such chain, so wherever this doc
describes the first-party pipeline, the **signing and verify-keyring steps are
omitted** and a per-entry `sha256` digest carries the integrity guarantee
instead. Everything in this doc reflects that unsigned shape.

The Roubo app consumes what you publish through a small, fixed contract. The
authoritative app-side definitions, referenced throughout, live in
[`davidpoxon/roubo`](https://github.com/davidpoxon/roubo):

- `shared/types.ts`: the `MarketplaceCatalogEntry` and catalog payload types.
- `server/services/marketplace-integrity.ts`: `computePackageDigest`, the
  function the host recomputes your `integrity` digest with.
- `server/services/catalog-client.ts` (`createThirdPartyCatalogClient`) and
  `server/services/guarded-fetch.ts`: the auth-gated fetch and the
  `Authorization` header rule the app applies to your source.

## 1. Catalog format

A source is **any URL that serves the catalog format**. The catalog is a single
JSON document whose core is an `entries[]` array, one entry per publishable
plugin version.

A third-party (unsigned) catalog is served as **plain JSON** carrying just the
payload: no signature envelope and no key-ring. The minimum shape is:

```json
{
  "entries": [
    {
      "id": "github-com",
      "name": "GitHub.com",
      "kind": "integration",
      "version": "0.1.0",
      "summary": "Bundled integration for issues, projects, and repositories on GitHub.com.",
      "source": {
        "type": "release",
        "assetUrl": "https://github.example/OWNER/REPO/releases/download/github-com-v0.1.0/github-com-0.1.0.tgz",
        "sha256": "sha256-<hex of the tarball bytes>"
      },
      "integrity": "sha256-<hex of the unpacked artifact>",
      "provenance": "your-marketplace/plugins/github-com@0.1.0"
    }
  ]
}
```

Each entry (the app's `MarketplaceCatalogEntry`, `shared/types.ts`) carries:

- `id`: the plugin id, from its `roubo-plugin.yaml`.
- `name`: the display name.
- `kind`: one of `component`, `integration`, or `agent`.
- `version`: the plugin version. It must match the plugin's `roubo-plugin.yaml`
  and `package.json` (the reference packer cross-checks the two and fails on a
  mismatch).
- `summary`: a one-line description.
- `source`: how the app stages the plugin. Either a built-artifact source,
  `{ "type": "release", "assetUrl": "...", "sha256": "sha256-<hex>" }` (the
  tarball is downloaded from `assetUrl` and unpacked), or a git source,
  `{ "type": "git", "url": "...", "directory"?: "..." }` (the repo is cloned,
  optionally from a subdirectory). Release sources are the recommended and
  reference shape.
- `integrity`: the expected content digest of the **unpacked** plugin package,
  as `sha256-<hex>` (see below).
- `provenance`: a human-readable origin string (the reference pipeline uses
  `<repo>/plugins/<id>@<version>`).
- `revoked` (optional): set `true` to delist an entry; the client blocks install
  and update for a revoked entry at the next refresh.
- `agentCompatibility` (optional, `kind: agent` only): the author-declared
  agent-CLI window, `{ "minVersion": "2.1.111", "testedCeiling": "2.1.207" }`
  (either bound may be omitted). It is what lets a not-yet-installed listing
  render its floor and tested ceiling at all, since the app cannot read a
  release-sourced plugin's manifest until it is installed. Display-only: nothing
  gates on it, and the plugin's own manifest wins once the plugin is on disk, so
  the card can never contradict what is installed. The reference pipeline reads
  it from the `agentCompatibility:` block of the plugin's `roubo-plugin.yaml`, so
  the manifest stays the single place you declare it.
- `roubo` (optional): the author-declared host semver range the plugin supports,
  e.g. `"^1.5.0"`. Carried on the entry so a host outside the range marks the
  listing incompatible, names the range you require, and offers no install or
  update action, all before any artifact is downloaded. Unlike
  `agentCompatibility` this one does gate: the install API refuses the same entry
  with `incompatible-host` for a caller that skips the UI. It is not a trust
  boundary, only an earlier refusal, and the app still re-reads the range off the
  real manifest after staging, so an entry that omits the key behaves exactly as
  it does today and is still caught post-download. The reference pipeline reads it
  from the top-level `roubo:` key of the plugin's `roubo-plugin.yaml`, so the
  manifest stays the single place you declare it.

The first-party catalog additionally wraps these `entries` in
`{ payload: { schemaVersion, generatedAt, keyId, entries }, signature }`. A
third-party source omits the envelope, `keyId`, and `signature` entirely; those
fields belong to the signed chain you are not standing up.

### The per-entry sha256 integrity digest is required

For an unsigned source, the per-entry `integrity` digest is **mandatory**. It is
the only integrity anchor you have: there is no signature chain behind it, so the
digest is what proves the artifact the user installs is the artifact you
published.

There are two distinct digests, and they are **not** the same value:

- `integrity` (top-level, required): the digest of the **unpacked artifact**,
  the installed file set. The host recomputes it with `computePackageDigest`
  (`server/services/marketplace-integrity.ts`) after staging the package and
  before commit, and rejects any mismatch fail-closed. The digest is over files
  only, sorted by `/`-joined relative path, hashing each file's relative path,
  a NUL, its bytes, and a NUL.
- `source.sha256` (release source): the sha256 of the **tarball bytes** a user
  downloads. It pins the transport artifact, not the unpacked tree.

Because the two are derived differently, they never agree; publish both.

The app treats a missing digest as a hard failure specific to unsigned sources.
An entry whose `integrity` is absent, empty, or malformed is rejected with
`missing-integrity` **before** the artifact is fetched: nothing is downloaded,
written, or executed. Publishing every entry with a well-formed `integrity`
digest is therefore not optional.

## 2. Build, digest, catalog, publish pipeline

The reference pipeline (`.github/workflows/release.yml`, driven by
`scripts/release/`) is:

1. **Build** each plugin with `tsup` (`npm run build`), producing its `dist/`
   tree. The artifact must be built before it can be packed.
2. **Pack and compute the tarball sha256.**
   `node scripts/release/pack.mjs --plugin <id> --out-dir release-build`
   assembles a normalized, byte-stable `.tgz` and derives the tarball-bytes
   sha256 (the entry's `source.sha256`) from pinned inputs, printing it as
   `sha256-<hex>` alongside the file name. The unpacked-artifact digest (the
   entry's top-level `integrity`) is a distinct value computed from the same
   source during catalog regeneration (step 4), not by the pack command.
3. **Publish the artifact** as a **per-plugin release asset.** The reference
   pipeline tags each release `<id>-v<version>` and uploads
   `<id>-<version>.tgz` as the asset named by the entry's `source.assetUrl`.
   This per-plugin-release shape is exactly what the app fetches (see section 3).
4. **Regenerate the catalog.** Rebuild `catalog.json` from the packed tarballs so
   its entries carry the freshly computed `source.sha256` and `integrity` for
   every published plugin.
5. **Serve the catalog** at your source URL.

**Reproducibility.** The packer pins every byte (fixed entry order, ustar
headers with zeroed mtime/uid/gid, a hand-built gzip container with a zeroed
timestamp) and runs against a pinned toolchain (`.nvmrc` plus `npm ci` against
the committed lockfile), so packing the same source twice yields an identical
digest. That is what lets the digest the app verifies be reproducible rather
than aspirational.

### The signing gate is omitted

The first-party pipeline has two further steps this doc deliberately drops for a
third-party source:

- **Catalog signing** (`scripts/release/sign-catalog.mjs`): wraps the payload in
  a detached ed25519 signature. **Omitted.** You serve the bare
  `{ "entries": [...] }` payload as plain JSON.
- **The verify-keyring publish gate** (`scripts/release/verify-keyring.mjs`, run
  by the first-party `pages` workflow): refuses to publish a catalog signed by a
  key the ring does not resolve to `active`. **Omitted**, because there is no
  key-ring and nothing is signed.

A third-party source is, by design, the reference pipeline **minus** signing and
the verify-keyring gate. In place of the signature chain, the per-entry `sha256`
`integrity` digest (section 1) is the integrity guarantee, and the app marks
every third-party listing with a non-dismissible "unverified" badge so the user
knows the trust level.

### Keep the catalog and the asset in step

Step 4 says "rebuild from the packed tarballs", and the emphasis matters: an
entry must describe the artifact its `source.assetUrl` actually serves. If your
catalog is regenerated continuously from your default branch while `assetUrl`
points at a frozen tag asset, the advertised digest tracks your branch and drifts
away from the download the moment the branch moves, and every install then fails
its integrity check against a digest nothing can satisfy.

Two habits keep them in step, and the first-party pipeline uses both:

- Derive each entry from the **published asset**, not from the current tree
  (`scripts/release/fetch-release-assets.mjs` downloads them;
  `scripts/release/sign-catalog.mjs --digest-source asset` reads both digests and
  the display metadata from inside the downloaded tarball).
- Gate the publish on agreement: `scripts/release/verify-catalog-assets.mjs`
  re-fetches every entry's `assetUrl` and fails the build, with expected versus
  actual, when either digest disagrees with the bytes served.

## 3. Hosting and the Authorization header

**Any URL that serves the catalog format is a valid source**, including
credentialed and intranet hosts. The app fetches your catalog and your artifacts
through one guarded transport (`server/services/guarded-fetch.ts`), attaching a
per-source credential only as an `Authorization` header and only while the
request origin equals your source's origin.

### The Authorization header rule (hybrid)

The app forms the `Authorization` header from the credential the user stored for
your source using a hybrid rule (`formAuthorization`,
`server/services/guarded-fetch.ts`):

- A credential with **no scheme prefix** is sent as
  `Authorization: Bearer <value>`.
- A credential that **already starts with a recognised scheme token**
  (`Bearer `, `Basic `, or `token `, exact case, trailing space) is sent
  **verbatim** as the header value, never double-prefixed.

So a user pasting a bare token gets `Bearer <token>`; a host that needs Basic
auth works if the user pastes `Basic <base64>`; a host that insists on the
legacy `token` scheme works if the user pastes `token <value>`. No extra
configuration surface is needed for the common cases.

### GitHub Enterprise (the reference credentialed host)

The workplace reference source is a private repository on a GitHub Enterprise
(GHE) instance. The verified endpoint shapes (Spike 550, live workplace-instance
capture) are:

- **Catalog:**
  `GET /api/v3/repos/OWNER/REPO/contents/catalog.json?ref=REF`
  with `Accept: application/vnd.github.raw+json` (fall back to
  `application/vnd.github.v3.raw` on an older GHES; the workplace instance
  honours both).
- **Artifacts:**
  `GET /api/v3/repos/OWNER/REPO/releases/assets/ASSET_ID`
  with `Accept: application/octet-stream`, publishing artifacts as **per-plugin
  release assets** (the same shape the reference pipeline already uses in
  section 2).

Guidance for GHE publishers:

- **PAT:** paste the **bare** PAT. It is sent as a `Bearer` token; the instance
  accepts `token` equally, so no prefix is needed.
- **Asset download redirect:** the asset download redirects **once, same-origin**,
  onto the appliance storage route, so a credentialed download stays on the
  instance origin and the credential remains attached for the whole download.
- **GHES raw path route** (`https://HOST/raw/OWNER/REPO/REF/PATH`): a working
  **convenience alias only.** It is an undocumented surface, and its subdomain
  form (`https://raw.HOST/...`) exists only when the instance has subdomain
  isolation enabled. Prefer the `/api/v3` pair above as the primary shape.
- **GHE Pages is not a credentialed hosting option.** GHE Pages is reachable only
  through a browser sign-on session and ignores `Authorization` headers (it
  answers a login redirect regardless of the header). Do not host an auth-gated
  catalog on GHE Pages. It is at most a hosting option for a non-gated (or
  network-gated, not credential-gated) catalog.

### http (plaintext) sources need a per-source opt-in

`https` sources need nothing extra. A plaintext `http://` source URL requires the
per-source **"allow http (intranet)"** opt-in, captured at registration and
**off by default** (Spike 551). This keeps a typo'd `http://` public URL from
silently downgrading and exposing a credential in cleartext, while letting an
intranet operator who genuinely serves plaintext behind a firewall opt in
knowingly. If your source is an intranet host on plain http, tell your users to
enable that opt-in when they register it.

## 4. Credential hygiene: read-only, repo-scoped PATs

When your source is credentialed, the credential a user supplies should follow
least privilege:

- **Read-only.** The app only ever reads your catalog and downloads artifacts.
  A read-only token is sufficient; never ask users for a write-scoped token.
- **Repo-scoped.** Scope the token to the single repository that hosts the
  marketplace, not to an org or a user's whole account. On GitHub a
  fine-grained PAT scoped to that one repo with read-only Contents (and, for
  release-asset downloads, read access to releases) is the target shape.

How the app handles it, which shapes the guidance you give users:

- **Captured at consent time.** The credential is entered in the registration
  consent dialog and captured **at that moment**, alongside the source URL and
  the explicit unsigned-source consent. It is stored in the OS keyring under a
  per-source account (`source:<sourceId>/token`), never in app settings or logs.
- **Never declared in `roubo.yaml`.** A project may declare a source in
  `roubo.yaml` so teammates are offered consent-gated registration on project
  open, but that declaration is a **URL only**:
  `marketplaces: [{ url: "https://..." }]`. Credentials are **never** written to
  `roubo.yaml` or any repo file. Each user supplies their own credential at
  consent time. Do not document, template, or suggest putting a token in
  `roubo.yaml`.

## 5. Caveat: the catalog format is not a frozen contract

The catalog format **may change with the Roubo app version.** It is the app's
internal consumption contract, not a versioned, frozen public API, and this v1
third-party path deliberately treats a documented "format may change" caveat as
sufficient rather than committing to long-term format stability.

Practical guidance for publishers:

- **Track the Roubo app version** your users run when you stand up and when you
  maintain a source. A field the app added or changed can require regenerating
  your `catalog.json`.
- **Mirror this repository's shape** at the app version you target: the reference
  `scripts/release/` pipeline and the app-side `MarketplaceCatalogEntry` in
  `shared/types.ts` are the source of truth for the exact fields at any given
  version.
- **Expect to regenerate, not hand-maintain.** Because the digests are
  reproducible and the catalog is regenerated from the packed artifacts, moving
  to a new format version is a re-run of the pipeline, not a hand edit.
