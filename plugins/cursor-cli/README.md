# @roubo/plugin-cursor-cli

Roubo agent plugin that launches Cursor CLI sessions in a bench, with the jig
injected as the initial prompt.

## What it is

Roubo **agent** plugin that opens the Cursor CLI (`agent`) in a bench terminal.
The session runs in the bench worktree, the bound jig is delivered as the
initial prompt, the operating mode is passed as `--mode`, and a free-form
additional-CLI-arguments field is appended as separate argv tokens
(APCC-FR-008, APCC-FR-011, APCC-FR-012, APCC-FR-014). Cursor's own worktree
flags are refused, because Roubo owns the worktree (APCC-FR-013).

The model, permission, notification, and compatibility-window axes are added by
later releases of this plugin.

## Install

The plugin drives an agent CLI it does not ship. Install the Cursor CLI first
with its official installer, and check that `agent` resolves on the machine:

```bash
curl https://cursor.com/install -fsS | bash
agent --version
```

The installer puts `agent` in `~/.local/bin`. When that directory is not on the
PATH the Roubo server inherits, the host falls back to the manifest's
`agentInstallLocations` (see [Binary discovery](#binary-discovery)).

There is a Roubo prerequisite too: the host must report plugin API `1.6.0` or
newer, the release that the published `@roubo/plugin-sdk` 0.5.0 targets. That
is what the manifest's `roubo: ^1.6.0` pins, and an older Roubo does not install
this plugin, so update Roubo first.

To build it from source in this repository:

```bash
npm install
npm run build -w @roubo/plugin-cursor-cli
```

That writes `plugins/cursor-cli/dist/`, which the manifest's
`entry: ./dist/index.js` points at. Install the plugin directory
`plugins/cursor-cli/` itself, the one holding `roubo-plugin.yaml`, through
**Settings > Plugins > Install plugin** on the **Local directory** tab.

## Usage

Agent configuration is not part of `roubo.yaml`. Set the application-level
defaults on **Settings > AI Agents**, which renders this plugin's manifest
`configSchema` as a form, then pick Cursor CLI as the agent when you open a
terminal on a bench. The saved defaults live in
`~/.roubo/agents/_global/cursor-cli.yaml`:

```yaml
# ~/.roubo/agents/_global/cursor-cli.yaml
schemaVersion: 1
config:
  mode: plan
  extraArgs: --force
```

A project-scoped override is the same envelope at
`~/.roubo/agents/<projectId>/cursor-cli.yaml`, and preset and per-launch values
overlay both. The host merges all four layers before calling `translateLaunch`.

With a jig bound to the bench, that config launches:

```
agent --mode plan --force "<jig content>"
```

## Reference

### How it works

The plugin is **declarative**: it registers a single `translateLaunch({ config,
context })` method via `defineAgentPlugin()` and emits an `agent-launch`
descriptor:

```ts
{
  schemaVersion: 1,
  kind: "agent-launch",
  command: "agent",
  args: [/* --mode, then extra args */],
  initialPrompt: { mode: "argv-positional", maxLength: 100_000 },
}
```

The host validates that descriptor, spawns the PTY with the bench workspace as
its working directory, and appends the initial prompt as the last positional
argument. The plugin spawns nothing itself (`permissions.processes: false`) and
registers no host client, so it holds no privilege beyond an integration
plugin's (APCC-NFR-001).

The mapping is pure. The session identity is templated rather than read from
the launch context, so a given config always produces the same descriptor.

### Config

| Key         | Required | Maps to descriptor                | Notes                                                                                                  |
| ----------- | -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `mode`      | no       | `--mode <value>`                  | `agent` (default), `plan`, or `ask`. `agent` sends no flag. Any other value is rejected before launch. |
| `extraArgs` | no       | extra argv tokens after the flags | Free-form string, split into discrete argv entries. Empty or whitespace-only appends nothing.          |

`extraArgs` is split by a literal tokenizer, not a shell. Runs of unquoted
whitespace separate tokens; `'…'` and `"…"` keep a run together and are
stripped; a backslash escapes the next character (inside double quotes it
escapes only a quote or another backslash). Every other character is an
ordinary literal, so `;`, `&`, `|`, `$`, parentheses, and backticks carry no
meaning. An unbalanced quote or a dangling backslash is rejected with a clear
error.

The extra arguments come after every generated flag, so an extra argument can
override a generated one. For example, `mode: plan` with `extraArgs: --mode ask`
sends `--mode plan --mode ask`: the plugin keeps both entries, in that order,
and the CLI decides which one applies.

### Worktree guard

Roubo already runs every bench in its own git worktree, so the plugin refuses
Cursor's worktree flags wherever they appear in the argv, including inside
`extraArgs`: `-w` (also with an attached name, as in `-wfeature`),
`--worktree`, `--worktree-base`, and `--skip-worktree-setup`, each also in its
`--flag=value` form. The launch fails before any terminal opens, with a message
that names the flag and states that Roubo owns the worktree. Remove the flag and
launch again.

### Jig injection

The plugin declares `initialPrompt: { mode: "argv-positional", maxLength:
100_000 }`. The host appends the bound jig as the final positional argument,
after every argv entry the plugin emits, and truncates a longer jig to 100,000
characters so the session still starts (APCC-TC-033, APCC-TC-034).

### Binary discovery

The descriptor's `command` is the bare name `agent`, and the host resolves it
before the PTY spawn through the same login-shell PATH resolution every agent
command goes through. When that PATH does not hold it, the host falls back to
this plugin's manifest `agentInstallLocations`:

```yaml
agentInstallLocations:
  - ~/.local/bin/agent
```

A command found nowhere fails the launch before any terminal opens, with an
error naming every location tried. Install the CLI as described in
[Install](#install) to fix it.

### Permissions

The manifest declares `processes: false`, no credential slots, no filesystem
paths, no network hosts, no ports, and no docker access. You sign in to Cursor
directly; the plugin never handles a credential.

## Links

- [Plugin author guide](https://github.com/davidpoxon/roubo/blob/main/docs/plugin-sdk.md):
  the agent contract, `defineAgentPlugin`, the launch descriptor, and the
  `kind: agent` manifest.
- [`@roubo/plugin-codex`](../codex/README.md): the sibling agent plugin whose
  package shape this one follows.
- [PUBLISHING.md](../../PUBLISHING.md): the catalog format and publish pipeline
  for running your own marketplace.
