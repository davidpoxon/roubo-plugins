# roubo-plugins

Source for the Roubo integration, component, and agent plugins, built against
the published `@roubo` SDK packages.

## What it is

A Roubo plugin is a directory with a `roubo-plugin.yaml` manifest and a Node
entry script, discovered by the app under `~/.roubo/plugins/<id>/`. This
repository is where the first-party plugins are built: an npm workspace holding
one package per plugin.

Roubo has three plugin kinds, and the manifest's `kind` field picks one:

- **Integration** plugins connect an issue tracker or source of work.
  First-party: [`github-com`](./plugins/github-com/README.md).
- **Component** plugins provision what a bench runs. First-party:
  [`process`](./plugins/process/README.md) and
  [`database`](./plugins/database/README.md).
- **Agent** plugins launch an AI coding agent in a bench. First-party:
  [`claude-code`](./plugins/claude-code/README.md) and
  [`codex`](./plugins/codex/README.md).

Component and agent plugins are declarative: they return a descriptor the host
validates and executes, rather than driving the host themselves. Integration
plugins implement request methods the host calls, within the permissions their
manifest declares.

## Install

To use these plugins, install them from within Roubo rather than from this
repository: open **Settings > Marketplace**, pick the plugin, review its
declared permissions, and confirm. Each plugin's own README covers its
prerequisites and where its configuration lives.

To work on them, clone this repository. You need Node.js >= 24.14.0.

```bash
npm install
npm run build
```

`npm install` also wires the local git hooks, including the DCO sign-off hook.
`npm run build` compiles every plugin against the published SDK packages.

## Usage

Build and check every plugin with the same commands the `pr-check` workflow
runs:

```bash
npm run build
npm run lint
npm run typecheck
npm run format:check
npm run coverage
```

`npm run coverage` is the plugin test suite with coverage; `npm run test:plugins`
runs the same suite without it.

To build a single plugin, pass its npm workspace name, for example
`npm run build -w @roubo/plugin-codex`. The build script is a hand-maintained
chain of `-w` invocations rather than a glob, so a newly added plugin has to be
appended to it explicitly or it stays silently unbuilt.

## Reference

| Plugin                                                         | Kind        | Id            | What it does                                                                               |
| -------------------------------------------------------------- | ----------- | ------------- | ------------------------------------------------------------------------------------------ |
| [`@roubo/plugin-github-com`](./plugins/github-com/README.md)   | integration | `github-com`  | Issues, projects, and repositories on GitHub.com.                                          |
| [`@roubo/plugin-process`](./plugins/process/README.md)         | component   | `process`     | Supervises a long-running process for a bench.                                             |
| [`@roubo/plugin-database`](./plugins/database/README.md)       | component   | `database`    | Provisions a docker-backed database for a bench.                                           |
| [`@roubo/plugin-claude-code`](./plugins/claude-code/README.md) | agent       | `claude-code` | Launches Claude Code sessions with a configured model, effort, and permission mode.        |
| [`@roubo/plugin-codex`](./plugins/codex/README.md)             | agent       | `codex`       | Launches Codex CLI sessions with a configured model, effort, approval policy, and sandbox. |

## Links

- [Plugin author guide](https://github.com/davidpoxon/roubo/blob/main/docs/plugin-sdk.md):
  the manifest format, the integration and agent contracts, host helpers, and
  the trust model.
- [CONTRIBUTING.md](./CONTRIBUTING.md): how to contribute, including the
  Developer Certificate of Origin (DCO) sign-off required on every commit.
- [PUBLISHING.md](./PUBLISHING.md): how to run your own third-party Roubo
  marketplace, covering the catalog format, the build and publish pipeline,
  hosting expectations, and credential hygiene.
- [DISCLOSURES.md](./DISCLOSURES.md) and [PRIVACY.md](./PRIVACY.md): what the
  plugins reach over the network and how credentials are handled.

## Licence and trademark

Roubo Plugins is released under the [Apache License 2.0](./LICENSE). The name
"Roubo" and the Roubo logomark are trademarks of David Poxon, governed by
[TRADEMARK.md](./TRADEMARK.md), not by the Apache 2.0 licence.
