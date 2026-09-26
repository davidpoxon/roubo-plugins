# @roubo/plugin-claude-code

Roubo agent plugin that launches Claude Code sessions in a bench from a
configured model, effort, and permission mode.

## What it is

Bundled Roubo **agent** plugin that launches Claude Code sessions in a bench,
honouring the configured model, reasoning effort, and permission mode, plus a
free-form additional-CLI-arguments field appended as separate argv tokens
(AP-FR-017, AP-US-008). It is the first agent-kind plugin, built against the
published `@roubo/plugin-sdk` agent contract.

Without it, one specific agent CLI's argument map would have to live in Roubo
core. The plugin moves it out: everything Claude-Code-specific is a string this
plugin emits, so supporting an agent becomes a plugin release rather than a core
change.

## Install

The plugin drives an agent CLI it does not ship. Install the Claude Code CLI
first with its native installer, and check that `claude` resolves on the machine:

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude --version
```

The installed CLI must be 2.1.111 or newer. An older one blocks the launch before
any terminal opens; update it with `claude update` (see
[Compatibility window](#compatibility-window)). Homebrew, WinGet, npm, and Linux
package-manager installs work too, and Anthropic's
[setup page](https://code.claude.com/docs/en/setup) covers each of them.

There is a Roubo prerequisite too, from 0.6.0 on: the host must report plugin
API `1.9.0` or newer, the release that added the `agentInstallGuidance` manifest
key this plugin declares (see
[Install and update guidance](#install-and-update-guidance)). The
`agentInstallLocations` key it also declares needs `1.5.0` (see
[Lifecycle parity](#lifecycle-parity)). That is what the manifest's
`roubo: ^1.9.0` pins, and an older Roubo does not install this plugin, so update
Roubo first. 0.5.0 remains the last release that runs on a host below `1.9.0`,
and 0.3.0 the last that runs on a host below `1.5.0`.

Install the plugin itself from the first-party Roubo marketplace: open
**Settings > Marketplace**, pick Claude Code, review the declared permissions,
and confirm. The install stages the package into `~/.roubo/plugins/claude-code/`,
and the plugin then appears on **Settings > Plugins** as an agent. Consent is
checked before any launch, so an un-consented plugin stays inert.

To build it from source in this repository instead:

```bash
npm install
npm run build -w @roubo/plugin-claude-code
```

That writes `plugins/claude-code/dist/`, which the manifest's
`entry: ./dist/index.js` points at. Install the plugin directory
`plugins/claude-code/` itself, the one holding `roubo-plugin.yaml`, through
**Settings > Plugins > Install plugin** on the **Local directory** tab.

## Usage

Agent configuration is not part of `roubo.yaml`. Set the application-level
defaults on **Settings > AI Agents**, which renders this plugin's manifest
`configSchema` as a form, then pick Claude Code as the agent when you open a
terminal on a bench. The saved defaults live in
`~/.roubo/agents/_global/claude-code.yaml`:

```yaml
# ~/.roubo/agents/_global/claude-code.yaml
schemaVersion: 1
config:
  model: opus
  effort: high
  mode: plan
  extraArgs: --fallback-model sonnet --verbose
```

A project-scoped override is the same envelope at
`~/.roubo/agents/<projectId>/claude-code.yaml`, and preset and per-launch values
overlay both. The host merges all four layers before calling `translateLaunch`.

That config launches:

```
claude --model opus --effort high --permission-mode plan --fallback-model sonnet --verbose --session-id <uuid>
```

## Reference

### How it works

The plugin is **declarative**: it registers a single `translateLaunch({ config,
context })` method via `defineAgentPlugin()` and emits an `agent-launch`
descriptor. The host validates that descriptor, resolves `{{sessionId}}` in the
argv, spawns the PTY, and appends the initial prompt as the last positional
argument. The plugin spawns nothing itself (`permissions.processes: false`), so
it holds no privilege beyond an integration plugin's (AP-NFR-001).

`config` is the host's already-merged effective config: app defaults, project
overrides, preset, and per-launch values, resolved before `translateLaunch` runs.
The mapping is pure, so a given config and app theme always produce the same
argv.

Generated argv, in order:

```
--model <model>  --effort <effort>  --permission-mode <mode>  --settings {"theme":…}  <extra args…>  --session-id {{sessionId}}  [prompt]
```

The generated flags come first and the user's extra tokens follow them, so an
extra argument can override a generated flag rather than be overridden by it.
`--session-id <uuid>` stays the stable argv tail the host correlates a session
on, and the positional prompt (capped at 100,000 characters) closes the line.

### Config

The plugin's `config` block (validated host-side against the manifest
`configSchema`) accepts:

| Key         | Required | Maps to descriptor                | Notes                                                                                                                                                                                                            |
| ----------- | -------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`     | no       | `--model <value>`                 | One of `default`, `opus`, `opusplan`, `sonnet`, `haiku`. `opusplan` runs Opus while planning and Sonnet while executing. `default` is "Account default": it emits no `--model` at all and defers to the account. |
| `effort`    | no       | `--effort <value>`                | One of `default`, `low`, `medium`, `high`, `xhigh`, `max`. `default` is "CLI default": it emits no `--effort` at all.                                                                                            |
| `mode`      | no       | `--permission-mode <value>`       | One of `default`, `plan`, `auto`, `acceptEdits`, `manual`. `default` emits no flag. `auto` emits `--permission-mode auto`.                                                                                       |
| `extraArgs` | no       | extra argv tokens after the flags | Free-form string, split into discrete argv entries. Empty or whitespace-only appends nothing.                                                                                                                    |

`default` is a sentinel rather than a literal value for all three closed-choice
fields: omitting the flag is how the CLI is told to fall back to its own or the
account's setting. An absent key behaves exactly like its sentinel. An
unrecognised value is rejected with an error naming the field and its allowed
values, rather than reaching the CLI as an opaque token.

`auto` maps to `--permission-mode auto`. The plugin never emits
`--enable-auto-mode`, the flag Claude Code removed in 2.1.111.

### Additional CLI arguments

`extraArgs` is split by a literal tokenizer, not a shell. Runs of unquoted
whitespace separate tokens; `'…'` and `"…"` keep a run together and are stripped;
a backslash escapes the next character (inside double quotes it escapes only a
quote or another backslash).

Every other character is an ordinary literal, so `;`, `&`, `|`, `>`, `<`, `$`,
parentheses, and backticks carry no meaning: there is no command separation, no
variable expansion, and no command substitution. The host spawns `args` as an
argv array and never through a shell, so `--foo; rm -rf $HOME "$(whoami)"`
becomes the five literal tokens `--foo;`, `rm`, `-rf`, `$HOME`, `$(whoami)` and
runs nothing. An unbalanced quote or a dangling backslash is rejected with a
clear error rather than guessed at.

### Theme

Claude Code starts in the theme the Roubo app shows when the session opens. The
host passes it as `context.appTheme`, `light` or `dark`, and the plugin emits
`--settings {"theme":"light"}` or `{"theme":"dark"}`. Claude Code has no theme
environment variable, and `--settings` applies the theme to this session only,
so nothing in your own Claude Code settings changes. For that session it does
override a daltonized, ANSI, or custom Claude Code theme.

The theme is a snapshot: switching the app theme later does not reach a running
session. A host that sends no theme (one older than the release that added
`appTheme`) gets no flag, and Claude Code picks its theme as it always has.

Repeated `--settings` flags do not merge in Claude Code: the last one replaces
the rest. So when your `extraArgs` carry their own `--settings`, the plugin
leaves the theme flag out, and your settings decide the theme.

### Permissions

The host layers the project's permissions model onto the effective config as
`config.permissions`, above all four configuration layers, and this plugin maps
both of its axes (AP-FR-016, AP-FR-018):

```ts
{ posture?: "read-only" | "guarded" | "auto-edit" | "full-auto",
  rules: { allow: string[]; ask: string[]; deny: string[] } }
```

**Posture** binds through argv, because `--permission-mode` is Claude Code's own
mechanism for this axis:

| Posture     | Emits                           |
| ----------- | ------------------------------- |
| `read-only` | `--permission-mode plan`        |
| `guarded`   | `--permission-mode manual`      |
| `auto-edit` | `--permission-mode acceptEdits` |
| `full-auto` | `--permission-mode auto`        |

When the project selects a posture it wins outright: the `mode` config field's
flag is dropped, so exactly one `--permission-mode` ever reaches the CLI. With no
posture selected, `mode` behaves exactly as it always has.

**Rules** need a file, so the plugin declares
`rules: { carrier: "workspace-write", resync: true }` and emits a
`.claude/settings.local.json` write mapping `allow` / `deny` / `ask` onto the
matching `permissions.*` arrays. The ops are `unionArray`, never `set`: entries
the user wrote by hand, or that Claude Code itself persisted when a permission
was granted mid-session, survive untouched. `resync: true` tells the host those
writes are safe to re-apply to an already-created bench, which is what the
permissions screen's Re-sync benches control dispatches through. A project with
no rules produces no write at all, so no empty `permissions` key appears.

The host rejects path-escaping patterns in the access-granting groups, `allow`
and `ask`, before they are stored, and filters any survivors before handing the
model over, so no escaping grant reaches the plugin. `deny` is subtractive, so
the host deliberately leaves it unchecked and it arrives here exactly as the
user wrote it, absolute and home-rooted paths included; the plugin passes those
through to `permissions.deny` unchanged.

### Notifications

The plugin declares `http-hook` notification wiring, carried by the same
`.claude/settings.local.json` write: `hooks.Notification` is **set** (not
unioned) to the catch-all Roubo endpoint at
`http://localhost:{{port}}/api/hooks/claude-notification`, and correlation rides
Claude Code's own `session_id`, which is the uuid the host handed it as
`--session-id`. Setting rather than merging matches the built-in writer for the
`Notification` key: Roubo's endpoint must be registered outright on every session
start so a stale registration can never survive. Unlike the built-in writer,
which replaces the whole `hooks` object, this write leaves other hook events such
as `Stop` untouched.

### Compatibility window

The plugin declares its supported Claude Code CLI window in two places, and they
are asserted to agree (AP-FR-014). The manifest's `agentCompatibility` block is
what the **Settings > AI Agents** card renders, so a user sees the window without
launching anything; the descriptor's `capabilities.versionProbe` is what the host
enforces at launch:

```ts
versionProbe: {
  args: ["--version"],
  parse: "semver",
  minVersion: "2.1.111",
  testedCeiling: "2.1.207",
}
```

```yaml
agentCompatibility:
  minVersion: 2.1.111
  testedCeiling: 2.1.207
  probe:
    command: claude
    args:
      - --version
    parse: semver
```

The manifest `probe` is what lets the card show a **detected** version on a bench
that was never started: the descriptor only exists once a launch is translated,
so without it the card could report the declared window but never what is
actually installed. It must declare the same `command` and `args` as the
descriptor's `versionProbe`, or the card and the launch gate would report on two
different binaries. `src/translate-launch.test.ts` asserts both halves agree.

`minVersion` is the inclusive floor and it blocks: 2.1.111 is where
`--permission-mode auto` replaced the removed `--enable-auto-mode`, so on
anything older the `full-auto` posture binding above would emit a
`--permission-mode` value the CLI rejects. Below it, the host refuses the launch
before spawning anything and shows the detected version, the required floor, and
the update action.

`testedCeiling` is the highest CLI this plugin has been verified against and it
never blocks. Claude Code ships weekly, so refusing to run on an unrecognised
newer version would age far worse than a warning does; above the ceiling the
session launches with a non-blocking notice and an amber chip on the card, and a
launch failure at that version is attributed to a possibly-stale argument map.
Raise the ceiling as part of re-verifying against a newer CLI, and bump
`minVersion` only when a flag this plugin emits genuinely stops working.

The probe itself is declarative: the host spawns `claude --version`, scans the
output for the first semver, and caches the result per resolved binary. The
plugin spawns nothing.

### Install and update guidance

The host has no Claude-specific text of its own, so the manifest declares how to
install and update the Claude Code CLI (APCC-NFR-003):

```yaml
agentInstallGuidance:
  install:
    command: curl -fsSL https://claude.ai/install.sh | bash
    url: https://code.claude.com/docs/en/setup#install-claude-code
  update:
    command: claude update
    url: https://code.claude.com/docs/en/setup#update-claude-code
```

When `claude` is not found, the launch-failure message names the install
command, and the error panel shows it with a button to copy it and a link to the
install section of Anthropic's setup page. When the detected version is below
`minVersion`, the message and the panel name `claude update` in the same way,
with a link to the update section. The **Settings > AI Agents** card shows the
install step when it cannot detect the CLI, and the update step when the
detected version is below the floor.

Each command is display text. The host shows it for you to copy and never runs
it. Both commands and both links come from Anthropic's own setup page. The
installer shown is the macOS, Linux, and WSL one, and it puts `claude` in
`~/.local/bin`, the first of the install locations below. A native install also
updates itself in the background; `claude update` applies an update at once. On
native Windows, or for a Homebrew, WinGet, or Linux package-manager install,
follow the link: those installs update through their own package manager.

### Lifecycle parity

Because the descriptor is executed by the same host launch pipeline the built-in
Claude Code integration runs through, a session launched by this plugin is
correlated identically to the built-in one: `--session-id <uuid>` remains the
stable tail and the initial prompt remains the final positional argument, which
is the shape the in-tree conformance suite pins. The settings write is pinned the
same way: the conformance suite asserts that executing this plugin's descriptor
produces a byte-identical `.claude/settings.local.json` to the built-in writer
for the same inputs. Jig injection lands in its own slice.

Binary discovery is part of that parity too. The descriptor's `command` is the
bare name `claude`, and when it is not on the server process's PATH the host
resolves it before the PTY spawn through this plugin's manifest
`agentInstallLocations`:

```yaml
agentInstallLocations:
  - ~/.local/bin/claude
  - ~/.claude/local/claude
  - /opt/homebrew/bin/claude
  - /usr/local/bin/claude
```

So an install that relies on one of those fallbacks, notably the
`~/.claude/local/claude` shim or a fish login shell whose PATH the server never
inherits, launches exactly as it did under the built-in integration, and a
command that resolves nowhere fails with an error naming every location tried.
The host-side fallback is
[davidpoxon/roubo-development#645](https://github.com/davidpoxon/roubo-development/issues/645);
moving the list onto the manifest is
[davidpoxon/roubo-development#712](https://github.com/davidpoxon/roubo-development/issues/712).

That list is an exact superset of the host's own legacy table for the `claude`
base name, in the same order, and deliberately so: a declared list **replaces**
that table for this CLI rather than merging with it, so dropping an entry would
strand an install the host resolves today, and reordering one would change which
binary wins where two are present. Append when a new install location appears;
never remove or reorder. Declaring the list needs a host reporting API `1.5.0` or
newer, which this plugin's `roubo: ^1.9.0` range covers.

Owning the list here rather than in the host is the point: a declarative,
host-agnostic descriptor should not hardcode absolute install paths for the
machine it happens to run on, and Roubo's core should not accrue per-agent
knowledge. Install locations are manifest metadata about where a CLI puts itself,
so this plugin keeps declaring the bare `claude` on the descriptor and answers
the "where does it live" question from the manifest instead.

## Links

- [Plugin author guide](https://github.com/davidpoxon/roubo/blob/main/docs/plugin-sdk.md):
  the agent contract, `defineAgentPlugin`, the launch descriptor, and the
  `kind: agent` manifest.
- [`@roubo/plugin-codex`](../codex/README.md): the sibling agent plugin, and the
  worked example of the same contract carrying a different CLI.
- [PUBLISHING.md](../../PUBLISHING.md): the catalog format and publish pipeline
  for running your own marketplace.
