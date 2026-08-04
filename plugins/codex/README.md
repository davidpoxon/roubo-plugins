# @roubo/plugin-codex

Roubo agent plugin that launches Codex CLI sessions in a bench from a configured
model, reasoning effort, approval policy, and sandbox mode.

## What it is

Bundled Roubo **agent** plugin that launches Codex CLI sessions in a bench,
honouring the configured model, reasoning effort, approval policy, and sandbox
mode, plus a free-form additional-CLI-arguments field appended as separate argv
tokens (AP-FR-020, AP-US-009).

It is the second agent-kind plugin, and the one that proves the contract is not
Claude-shaped: everything Codex-specific lives in the argv strings below, and no
Codex-specific code exists in Roubo core. Where the two agents differ (concrete
config defaults instead of send-no-flag sentinels, no fine-grained rules
surface, quiescence rather than a hook), the difference is declared by this
plugin rather than special-cased by the host.

## Install

The plugin drives an agent CLI it does not ship. Install the Codex CLI first, at
0.144.0 or newer (see [Compatibility window](#compatibility-window)), and check
that `codex` resolves on the machine.

There is a Roubo prerequisite too, from 0.2.0 on: the host must report plugin API
`1.5.0` or newer, the release that carries the `agentInstallLocations` this
plugin now declares (see [Lifecycle parity](#lifecycle-parity)). That is what the
manifest's `roubo: ^1.5.0` pins, and an older Roubo does not install this
version, so update Roubo first.

Install the plugin itself from the first-party Roubo marketplace: open
**Settings > Marketplace**, pick Codex CLI, review the declared permissions, and
confirm. The install stages the package into `~/.roubo/plugins/codex/`, and the
plugin then appears on **Settings > Plugins** as an agent. Consent is checked
before any launch, so an un-consented plugin stays inert.

To build it from source in this repository instead:

```bash
npm install
npm run build -w @roubo/plugin-codex
```

That writes `plugins/codex/dist/`, which the manifest's
`entry: ./dist/index.js` points at. Install the plugin directory
`plugins/codex/` itself, the one holding `roubo-plugin.yaml`, through
**Settings > Plugins > Install plugin** on the **Local directory** tab.

## Usage

Agent configuration is not part of `roubo.yaml`. Set the application-level
defaults on **Settings > AI Agents**, which renders this plugin's manifest
`configSchema` as a form, then pick Codex CLI as the agent when you open a
terminal on a bench. The saved defaults live in
`~/.roubo/agents/_global/codex.yaml`:

```yaml
# ~/.roubo/agents/_global/codex.yaml
schemaVersion: 1
config:
  model: gpt-5.1-codex
  effort: high
  approvalPolicy: never
  sandbox: read-only
  extraArgs: --search
```

A project-scoped override is the same envelope at
`~/.roubo/agents/<projectId>/codex.yaml`, and preset and per-launch values overlay
both. The host merges all four layers before calling `translateLaunch`.

That config launches:

```
codex --model gpt-5.1-codex -c model_reasoning_effort=high -c approval_policy=never -c sandbox_mode=read-only --strict-config --search
```

## Reference

### How it works

The plugin is **declarative**: it registers a single `translateLaunch({ config,
context })` method via `defineAgentPlugin()` and emits an `agent-launch`
descriptor. The host validates that descriptor, resolves `{{sessionId}}` and
`{{port}}` in the argv, spawns the PTY, appends the selected permission posture's
arguments, and appends the initial prompt as the last positional argument. The
plugin spawns nothing itself (`permissions.processes: false`), so it holds no
privilege beyond an integration plugin's (AP-NFR-001).

`config` is the host's already-merged effective config: app defaults, project
overrides, preset, and per-launch values, resolved before `translateLaunch` runs.
The mapping is pure, so a given config always produces the same argv.

Generated argv, in order:

```
--model <model>  -c model_reasoning_effort=<effort>  -c approval_policy=<policy>  -c sandbox_mode=<sandbox>  --strict-config  <extra args…>  [posture args]  [prompt]
```

Each flag and each value is a separate argv entry (`["-c",
"approval_policy=on-request"]`, never one joined string), and the generated flags
come first so an extra argument can override a generated one rather than be
overridden by it. The posture's arguments are appended by the host after
everything the plugin emits, and the positional prompt (capped at 100,000
characters) closes the line.

`-c` values are written unquoted (`approval_policy=on-request`). Codex parses a
`-c` value and falls back to the raw string when it does not parse, so the
unquoted and TOML-quoted forms reach the CLI as the same string; unquoted is what
the assembled command line shows.

`--strict-config` is always emitted. It turns an unknown configuration key into a
hard pre-launch error rather than a silently ignored override, so a key map that
has gone stale against a newer Codex fails loudly instead of launching a session
with the wrong policy. Codex's _value_ validation is lax by contrast
(`-c model_reasoning_effort=bogus` launches and echoes `bogus`), which is why
every enum below is validated in the plugin rather than left to the CLI.

### Config

The plugin's `config` block (validated host-side against the manifest
`configSchema`) accepts:

| Key              | Required | Maps to descriptor                  | Notes                                                                                                                                                                |
| ---------------- | -------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`          | no       | `--model <value>`                   | One of `default`, `gpt-5.2-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-mini`. `default` is "Account default": it emits no `--model` at all. Defaults to `gpt-5.2-codex`. |
| `effort`         | no       | `-c model_reasoning_effort=<value>` | One of `minimal`, `low`, `medium`, `high`, `xhigh`. Defaults to `medium`.                                                                                            |
| `approvalPolicy` | no       | `-c approval_policy=<value>`        | One of `untrusted`, `on-request`, `never`. Defaults to `on-request`. A project permission posture overrides it.                                                      |
| `sandbox`        | no       | `-c sandbox_mode=<value>`           | One of `read-only`, `workspace-write`, `danger-full-access`. Defaults to `workspace-write`. A project permission posture overrides it.                               |
| `extraArgs`      | no       | extra argv tokens after the flags   | Free-form string, split into discrete argv entries. Empty or whitespace-only appends nothing.                                                                        |

Unlike the Claude Code plugin, whose closed-choice fields default to a "send no
flag" sentinel, three of the four axes here default to **concrete values**, and
an absent key falls back on exactly the default the form displays. Codex resolves
an unset axis from the user's own `~/.codex/config.toml`, so a sentinel would
make the launch depend on a file Roubo does not manage: for the approval and
sandbox axes that is a safety footgun, and for effort it would make the argv the
form describes differ from the argv that launches. `model` keeps an explicit
`Account default` choice because deferring the model to the user's Codex
configuration is a legitimate, and harmless, thing to want.

An unrecognised value is rejected with an error naming the field and its allowed
values, rather than reaching the CLI as an opaque token.

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

Because `--strict-config` is on, an `extraArgs` token such as `-c bogus_key=1`
fails the launch before anything spawns, naming the unknown key.

### Permissions

The host layers the project's permissions model onto the effective config as
`config.permissions`, above all four configuration layers. Codex maps **only the
posture axis** (AP-FR-016):

```ts
{ posture?: "read-only" | "guarded" | "auto-edit" | "full-auto",
  rules: { allow: string[]; ask: string[]; deny: string[] } }
```

**Posture** binds through argv, because `approval_policy` and `sandbox_mode` are
Codex's own mechanism for this axis:

| Posture     | Emits                                                           |
| ----------- | --------------------------------------------------------------- |
| `read-only` | `-c approval_policy=untrusted -c sandbox_mode=read-only`        |
| `guarded`   | `-c approval_policy=untrusted -c sandbox_mode=workspace-write`  |
| `auto-edit` | `-c approval_policy=on-request -c sandbox_mode=workspace-write` |
| `full-auto` | `-c approval_policy=never -c sandbox_mode=workspace-write`      |

When the project selects a posture it wins outright: the `approvalPolicy` and
`sandbox` config fields emit nothing, so exactly one `approval_policy` and one
`sandbox_mode` override ever reach the CLI. `model` and `effort` are unaffected,
because they sit on a different axis. With no posture selected, both fields
behave exactly as the table above describes.

**Rules are deliberately not declared.** Codex has no stable per-command rule
surface: 0.144.1's `permissions.<name>` profiles and execpolicy `.rules` files
are undocumented and churning, and synthesising them would reintroduce the
Claude-shaped-contract failure mode in reverse. Absence is first-class in the
contract, so omitting the `rules` capability **hides the fine-grained rules
editor** for this agent and injects nothing: a project's allow/ask/deny rules are
never serialized into Codex configuration, and this plugin writes no bench
workspace file at all.

### Waiting notifications

Codex's waiting signals split per signal, because its two mechanisms cover
different events. **Approval waiting rides quiescence**. The plugin declares:

```ts
waitingDetection: { kind: "quiescence-only", debounceMs: 3000 }
```

Codex's approval overlay paints once and then schedules no further frames, so the
PTY goes silent and the host's quiescence timer runs to completion: a true
positive, with latency equal to the debounce. 3000ms is the plugin's declared
per-agent number rather than a core constant, and it leaves more than a 20x
margin over the worst output gap measured against Codex's animated TUI (126ms
across 40s at 0.144.1). A redraw storm therefore cannot expire the timer, and at
most one waiting notification is raised per idle period. It is deliberately
shorter than Claude Code's 8000ms hook fallback, which exists to paper over a
hook Codex does not have.

Two caveats worth knowing:

- A user-level `tui.animations = false` (reduced motion) removes the 32ms
  repaint, so a working session can fall quiet between content updates and a long
  silent model stall may read as "waiting". Such a notification self-dismisses on
  the next output.
- The opt-in Codex "pets" companion animates in the waiting state, so the PTY
  never goes quiet and quiescence starves. With a pet enabled, waiting
  notifications will not fire.

### Turn-completion notifications

**Turn completion rides Codex's own `notify` program.** Codex has no
`--session-id` analogue, so the Roubo session id cannot ride the agent's own
identity the way it does for Claude Code; it rides the notifier's argv instead:

```ts
notification: {
  kind: "spawned-notifier",
  event: "turn-complete",
  carrier: { args: ["-c", 'notify=["roubo-notify","{{sessionId}}"]'] },
  payload: "json-arg",
  correlation: { source: "template", template: "{{sessionId}}" },
}
```

Codex spawns the configured program on turn completion with its configured
arguments and appends the event JSON as one final argument, so the notifier
receives the Roubo session id and the payload together and correlation needs no
parsing of Codex's own thread and turn ids. `notify` fires on turn completion
**only**, never on an approval prompt, which is why approval waiting rides
quiescence above rather than this wiring.

The host executes the `spawned-notifier` variant: it consumes `carrier.args`,
and `roubo-notify` is the agent-generic notifier program core ships alongside
the receiving endpoint. Core prepends that program's install directory to the
agent's PATH, so the bare name above resolves without an absolute path. A
per-session `notify` override displaces any notifier the user configured in
their own `config.toml` for the duration of a Roubo-launched session, which
mirrors what the Claude Code path does to the `Notification` hook.

### Compatibility window

The plugin declares its supported Codex CLI window in two places, and they are
asserted to agree (AP-FR-014). The manifest's `agentCompatibility` block is what
the **Settings > AI Agents** card renders, so a user sees the window without
launching anything; the descriptor's `capabilities.versionProbe` is what the host
enforces at launch:

```ts
versionProbe: {
  args: ["--version"],
  parse: "semver",
  minVersion: "0.144.0",
  testedCeiling: "0.144.1",
}
```

```yaml
agentCompatibility:
  minVersion: 0.144.0
  testedCeiling: 0.144.1
  probe:
    command: codex
    args:
      - --version
    parse: semver
```

The manifest `probe` is what lets the card show a **detected** version on a bench
that was never started: the descriptor only exists once a launch is translated.
It declares the same `command` and `args` as the descriptor's `versionProbe`, or
the card and the launch gate would report on two different binaries;
`src/translate-launch.test.ts` asserts both halves agree. `codex --version`
prints `codex-cli 0.144.1`, which `parse: semver` reads.

**The window is narrow on purpose, and the ceiling reflects exactly one
parse-level-validated version.** 0.144.1 is the only Codex release any Roubo work
has touched: its whole launch surface was surveyed against the real binary (every
flag and configuration key this plugin emits was accepted, and an unknown key
rejected, under `--strict-config`), and its TUI redraw behaviour was read from the
pinned source. That validation stopped at the authentication boundary, so no
completed model turn has been driven through this argv.

`minVersion` is the inclusive floor and it blocks; 0.144.0 is the first release
of that line, so the floor brackets the verified version without claiming
anything about earlier releases. `testedCeiling` never blocks: Codex ships
weekly, so refusing an unrecognised newer version would age far worse than a
warning does.

Above the ceiling the session launches with a non-blocking notice and an amber
chip on the card, and a launch failure at that version is attributed to a
possibly-stale argument map. Raise the ceiling as part of re-verifying against a
newer CLI, and raise `minVersion` only when something this plugin emits genuinely
stops working.

### Lifecycle parity

Because the descriptor is executed by the same host launch pipeline every other
agent runs through, a Codex session behaves like any other in a bench. Jig
injection is the clearest case: the plugin declares
`initialPrompt: { mode: "argv-positional", maxLength: 100_000 }`, which is the
only injection mechanism the contract has, and the host appends the bound jig as
the final positional argument after every generated flag and every posture
argument. Nothing Claude-specific carries it, because this plugin declares no
settings-file write and no hook payload.

Binary discovery is part of that parity too. The descriptor's `command` is the
bare name `codex`, and the host resolves it before the PTY spawn through the same
login-shell PATH resolution every agent command goes through. When that PATH does
not hold it, notably on a Finder or Dock launch or a fish login whose environment
the server never inherits, the host falls back to this plugin's manifest
`agentInstallLocations`:

```yaml
agentInstallLocations:
  - ~/.local/bin/codex
  - /opt/homebrew/bin/codex
  - /usr/local/bin/codex
```

Those are the CLI's own installers' targets, not guesses. The official shell
installer symlinks its versioned store under `$CODEX_INSTALL_DIR`, defaulting to
`~/.local/bin`, and `brew install --cask codex` and `npm install -g @openai/codex`
both land on their prefix's `bin`. They are ordered most specific first, because
the host takes the first candidate that is a regular executable file, so a
per-user install wins over a machine-wide one. A version-scoped Node prefix (nvm,
volta) is absent by design: its path embeds the Node version, which this field
cannot template, and such an install already resolves through PATH, which is
probed first.

Every entry is a candidate rather than an instruction. The host does the probing,
skips anything that is not an executable regular file, and a command found
nowhere still fails the launch with an error naming every location tried. So the
plugin keeps declaring the bare `codex` rather than an absolute path for the
machine it happens to run on: the install locations are manifest metadata, and
the descriptor stays host-agnostic. Declaring them needs a host reporting API
`1.5.0` or newer, which is what this plugin's `roubo: ^1.5.0` range pins.

## Links

- [Plugin author guide](https://github.com/davidpoxon/roubo/blob/main/docs/plugin-sdk.md):
  the agent contract, `defineAgentPlugin`, the launch descriptor, and the
  `kind: agent` manifest.
- [`@roubo/plugin-claude-code`](../claude-code/README.md): the sibling agent
  plugin, and the one that exercises the fine-grained rules capability this one
  omits.
- [PUBLISHING.md](../../PUBLISHING.md): the catalog format and publish pipeline
  for running your own marketplace.
