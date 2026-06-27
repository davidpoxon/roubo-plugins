# Contributing to Roubo Plugins

Thanks for your interest in contributing to Roubo Plugins. This repository
holds the source for Roubo's integration and component plugins, built against
the published `@roubo` SDK packages. This document covers how to report issues,
set up your development environment, and submit changes.

## Code of conduct

Be respectful. Engage with the work, not the person. Disagreements about
direction are normal; treat them as a way to find the better answer, not a
contest to win.

## Reporting issues

Before opening an issue, search existing issues to avoid duplicates. When
filing a new issue, include:

- What you were trying to do.
- What happened instead.
- Your environment (OS, Node.js version, and which plugin and `@roubo` SDK
  version).
- Reproduction steps, if possible.

For security issues, do not open a public issue. Email <security@roubo.dev>
directly.

## Suggesting changes

Open an issue describing the change you'd like to make before starting
significant work. This avoids the situation where a PR arrives that
doesn't fit the project's direction and has to be turned away after you've
already done the work.

Small fixes (typos, obvious bugs, documentation polish) don't need a
prior issue. Just open the PR.

## Development setup

The plugins are an npm workspace. You need Node.js >= 24.14.0.

```bash
npm install
npm run build
```

`npm install` installs dependencies and wires up the local git hooks (see the
DCO section below). `npm run build` compiles every plugin under `plugins/*`
against the published `@roubo` SDK packages. Run the build before opening a PR;
a PR that does not build will fail review.

## Marketplace key rotation and revocation

The marketplace serves a signed `catalog.json` and a signed `key-ring.json` from
GitHub Pages. The catalog is signed by a rotating **operational** key; the
key-ring is signed by the long-lived **root** key the app embeds, and it
resolves which operational keys are `active`. Because the app trusts only the
root key and resolves everything else through the signed ring, both **rotating
an operational key** and **revoking a plugin entry** are data edits plus a
re-sign plus a republish: no app release, no code change.

`marketplace/key-ring.config.json` is the source of truth. Its `keys` array
lists operational public keys with a `status` of `active` or `revoked`; its
`revokedEntryIds` array lists catalog entry ids to delist. The `pages` workflow
re-signs and republishes on every push to `main` that touches `plugins/`,
`marketplace/`, or the release scripts, and can also be run by hand from the
Actions tab.

**Revoke a plugin entry.** Add its id to `revokedEntryIds`, commit, and let the
`pages` workflow republish. The entry is marked `revoked: true` in the signed
catalog and the client delists it and blocks install/update at the next refresh.

**Rotate the operational key.** Generate a new ed25519 keypair, update the
`MARKETPLACE_SIGNING_KEY` repo secret to the new private key, then add the
**old** key to `keys` with status `revoked` so catalogs it signed are rejected:

```bash
# public PEM of the rotated-out key, to paste into key-ring.config.json
node scripts/release/derive-public-key.mjs < old-operational-private.pem
```

The currently-active operational key is injected into the ring automatically
from the signing secret, so you do not commit it; you only ever add rotated-out
keys as `revoked`. The `pages` workflow re-signs the ring with the root key and
re-signs the catalog with the new operational key.

**Rotate the root key.** This is the one change that **does** require an app
release, because the app embeds the root public key. Update the
`MARKETPLACE_ROOT_SIGNING_KEY` secret and ship the new root public key in the
app.

The signing keys are read on stdin only and are never written to disk or logged.
The `pages` workflow runs `verify-keyring.mjs` before publishing, so a catalog
signed by a key the ring does not resolve to `active` fails the publish.

## Brand and vocabulary

Roubo uses a specific vocabulary: bench, project, component, tool, inspection,
jig, workspace. User-facing plugin text and documentation should use these
terms. The name "Roubo" and the Roubo logomark are trademarks; see
[TRADEMARK.md](TRADEMARK.md) for what you may and may not do with them.
Contributions that introduce competing vocabulary will be asked to align
before merging.

## Developer Certificate of Origin (DCO)

Every commit in a pull request must be signed off under the [Developer
Certificate of Origin](https://developercertificate.org/) (DCO). This is a
lightweight declaration that you wrote the change, or have the right to
contribute it under this project's licence (Apache 2.0). The full text is
below.

The DCO is enforced automatically. A pull request with any unsigned commits
will be blocked from merging until every commit is signed off. The check runs
via the `dco` workflow, which calls the shared, reusable DCO workflow
maintained in [davidpoxon/roubo](https://github.com/davidpoxon/roubo) so the
sign-off rules stay identical across the Roubo repositories.

When you run `npm install` in your clone, the `prepare` script configures a
local `commit-msg` git hook that rejects commits missing a `Signed-off-by:`
line matching your configured git email. If a commit is rejected, re-commit
with `git commit -s` or amend with `git commit --amend --signoff`. The
hook is the same check the PR-time workflow runs, just earlier.

### How to sign off

Add the `-s` flag to your commit command. Git will append a
`Signed-off-by:` line to the commit message using your configured name and
email:

```bash
git commit -s -m "Brief description of the change"
```

The line looks like:

```
Signed-off-by: Your Name <you@example.com>
```

If you commit through an IDE or tool that doesn't surface the `-s` flag,
the equivalent is to append a `Signed-off-by:` line to the commit message
yourself, matching the email on the commit. The git CLI does this for you
when you pass `-s`.

### Maintainer setup (one-time)

The DCO workflow is the gate, but it only matters if GitHub treats it as
required. On the `main` branch protection rule, add the `DCO sign-off` check
(surfaced as `dco / DCO sign-off`, from `.github/workflows/dco.yml`) to the list
of required status checks. Without this, the check can go red and a maintainer
can still click merge; with it, the merge button stays disabled until every
commit is signed off.

### Bot exemption

Automated dependency-update bots (currently Dependabot) are exempt from the
per-commit sign-off requirement. The DCO is an attestation of human authorship;
a bot cannot meaningfully attest to that. The allowlist of exempt author emails
lives in the shared reusable workflow in
[davidpoxon/roubo](https://github.com/davidpoxon/roubo/blob/main/.github/workflows/dco-reusable.yml).

### If you forgot to sign off

The DCO check on your pull request will fail with the specific commits
that are missing sign-off. Fix it with one of the following.

**For the most recent commit only:**

```bash
git commit --amend --no-edit --signoff
git push --force-with-lease
```

**For multiple commits in the pull request:**

```bash
git rebase --signoff origin/main
git push --force-with-lease
```

Replace `origin/main` with whatever the base branch of your pull request
is, if different.

Force-pushing to a pull request branch is expected and safe. It
re-triggers CI and the DCO check.

### Full DCO text

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project and the open source license(s) involved.
```

## Pull request process

1. Fork the repository and create a feature branch from `main`.
2. Make your changes. `npm run build` must pass.
3. Sign off each commit (see DCO above).
4. Open a pull request against `main`. Fill in the PR template.
5. Address review feedback. Force-pushes to update the PR branch are
   expected.
6. A maintainer will merge once CI passes and the change has been
   approved.

This project follows a "main is always green" policy: every commit on
`main` must pass CI. PRs are merged via squash by default, with the PR
title as the squash commit message.

## Licensing of contributions

By submitting a contribution, you agree that it is licensed under the
[Apache License, Version 2.0](LICENSE), the same licence that covers this
repository's existing source. You retain copyright in your contribution. The
DCO sign-off is your assertion that you have the right to make this
licensing grant.

The name "Roubo" and the Roubo logomark are trademarks and are governed
by [TRADEMARK.md](TRADEMARK.md), not by the Apache 2.0 licence.

## Questions

For anything not covered here, open an issue or email
<contributing@roubo.dev>.
