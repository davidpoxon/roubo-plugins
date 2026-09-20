# @roubo/plugin-cursor-cli

Roubo agent plugin that launches Cursor CLI sessions in a bench, with the jig
injected as the initial prompt.

## What it is

Roubo **agent** plugin that opens the Cursor CLI (`agent`) in a bench terminal.
The session runs in the bench worktree, the bound jig is delivered as the
initial prompt, the selected model is passed as one `--model` flag, the
operating mode is passed as `--mode`, and a free-form additional-CLI-arguments
field is appended as separate argv tokens (APCC-FR-008, APCC-FR-009,
APCC-FR-011, APCC-FR-012, APCC-FR-014). Cursor's own worktree flags are
refused, because Roubo owns the worktree (APCC-FR-013). A completed turn raises
a notification for the bench that ran it, and an idle session falls back to a
waiting notification when no hook fires (APCC-FR-017).

The plugin also declares its supported Cursor CLI version window
(APCC-FR-018). It maps Roubo's four permission postures onto Cursor CLI flags
and writes the project's allow and deny rules into the bench's own
`.cursor/cli.json` (APCC-FR-015, APCC-FR-016).

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

The installed build must be `2026.09.08` or newer. An older build blocks the
launch before any terminal opens; update it with `agent update` or by running
the installer again (see [Compatibility window](#compatibility-window)).

There is a Roubo prerequisite too: the host must report plugin API `1.7.0` or
newer, the release that added the `agentPermissionRuleTiers` manifest key this
plugin declares. That is what the manifest's `roubo: ^1.7.0` pins, and an older
Roubo does not install this plugin, so update Roubo first. Everything else the
plugin uses comes from the published `@roubo/plugin-sdk` 0.5.0, which targets
plugin API `1.6.0`.

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
  model: gpt-5.3-codex-high-fast
  mode: plan
  extraArgs: --force
```

A project-scoped override is the same envelope at
`~/.roubo/agents/<projectId>/cursor-cli.yaml`, and preset and per-launch values
overlay both. The host merges all four layers before calling `translateLaunch`.

With a jig bound to the bench, that config launches:

```
agent --model gpt-5.3-codex-high-fast --mode plan --force "<jig content>"
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
  args: [/* --model <id>, --mode, then extra args */],
  initialPrompt: { mode: "argv-positional", maxLength: 100_000 },
  capabilities: {
    workspaceWrites: [/* the .cursor/cli.json rules write, when there are rules */],
    notification: { kind: "file-notifier", /* see below */ },
    waitingDetection: { kind: "hook-driven", quiescenceFallbackMs: 3000 },
    versionProbe: {/* see Compatibility window */},
    permissions: { postures: {/* see Permissions */}, rules: { carrier: "workspace-write", resync: true } },
  },
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
| `model`     | no       | `--model <id>`                    | A model id from `agent --list-models`, passed unchanged. Unset or empty emits no flag.                 |
| `mode`      | no       | `--mode <value>`                  | `agent` (default), `plan`, or `ask`. `agent` sends no flag. Any other value is rejected before launch. |
| `extraArgs` | no       | extra argv tokens after the flags | Free-form string, split into discrete argv entries. Empty or whitespace-only appends nothing.          |

`model` has no static choice list. The manifest binds it to a `choiceProbes`
entry, so the host runs `agent --list-models` and fills the field's choices
from each `<id> - <label>` line of the listing. The heading and the trailing
tip line are not choices. Each listed id already fixes its effort and speed,
so the plugin passes the selected id as the value of one `--model` flag,
unchanged, with no bracketed parameters and no derived base name. The flag and
the id are separate argv entries, so an id is never shell-interpreted.

An unset `model` emits no `--model` flag, and the session runs on your Cursor
account default. When the probe fails (for example, the CLI is not installed or
you are not signed in), the field stays unset and a launch still succeeds with
no model flag. The `--model` flag comes before the extra arguments, so a
`--model` in `extraArgs` overrides it. That is also the route for a bracketed
model value.

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

### Turn-completion notifications

Turn completion rides a Cursor `stop` hook. Cursor reads its hooks from
`.cursor/hooks.json` in the workspace, so the plugin declares a write into that
file in the bench worktree and the host carries it out at launch:

```ts
notification: {
  kind: "file-notifier",
  event: "turn-complete",
  carrier: {
    workspaceWrite: {
      relPath: ".cursor/hooks.json",
      format: "json",
      ops: [
        { op: "set", path: "version", value: 1 },
        { op: "set", path: "hooks.stop", value: [{ command: "{{notifierCommand}}" }] },
      ],
    },
    args: ["{{notifier}}", "{{sessionId}}"],
  },
  payload: "json-stdin",
  correlation: { source: "template", template: "{{sessionId}}" },
}
```

`stop` fires once per model turn, and also when a turn ends with a `status` of
`aborted` or `error`. Cursor runs each hook `command` through `$SHELL -c` and
writes the event JSON to its standard input. The host resolves `{{notifier}}` to
the notifier program it ships and `{{sessionId}}` to the session id it mints,
shell-quotes both, and joins them into the command string it writes in place of
`{{notifierCommand}}`. The notifier gets the Roubo session id as its argument and
the payload on stdin, so the notification goes to the bench that ran the turn
(APCC-TC-046, APCC-TC-049). The plugin only declares templates; it never sees a
real session id.

One turn can send two `stop` events. The host reuses the bench's live
notification, so one idle period raises at most one waiting notification, and a
later idle period raises another (APCC-TC-051).

The write keeps every other key in the file and every hook on another event
(APCC-TC-048). One limit: it sets the whole `hooks.stop` array, so a `stop`
entry of your own in the worktree's `.cursor/hooks.json` is replaced for a
Roubo-launched session. The contract has no per-entry merge for hook objects
yet; davidpoxon/roubo-development#890 tracks it.

### Waiting notifications

No hook fires while an approval prompt waits, so quiescence detection stays on
for every session as the fallback:

```ts
waitingDetection: { kind: "hook-driven", quiescenceFallbackMs: 3000 }
```

When the session produces no output for 3000ms and no hook has fired, the host
raises a waiting notification (APCC-TC-050). The window is measured against the
Cursor CLI's own redraw behaviour: a working turn redraws about every 250ms, and
the worst gap measured inside a turn was 1.05s, so a working turn never expires
the timer. The host owns the timer, the notification, and the dismissal; the
plugin supplies only the number.

### Compatibility window

The plugin declares its supported Cursor CLI window in two places, and they are
asserted to agree (APCC-FR-018). The manifest's `agentCompatibility` block is
what the **Settings > AI Agents** card renders, so a user sees the window
without launching anything; the descriptor's `capabilities.versionProbe` is what
the host enforces at launch:

```ts
versionProbe: {
  args: ["--version"],
  parse: "semver",
  minVersion: "2026.09.08",
  testedCeiling: "2026.09.15",
}
```

```yaml
agentCompatibility:
  minVersion: 2026.09.08
  testedCeiling: 2026.09.15
  probe:
    command: agent
    args:
      - --version
    parse: semver
```

The manifest `probe` is what lets the card show a **detected** version on a
bench that was never started: the descriptor only exists once a launch is
translated. It declares the same `command` and `args` as the descriptor's
`versionProbe`, or the card and the launch gate would report on two different
binaries; `src/translate-launch.test.ts` asserts both halves agree.

The Cursor CLI reports a date-based build: `agent --version` prints, for
example, `2026.09.15-d2fe57e`. `parse: semver` reads the first three integer
groups, `2026.09.15`, and compares them numerically, so a build orders
correctly across day, month, and year boundaries (APCC-TC-053). The leading
zeros are valid in an exact version, so no contract change is needed.

`minVersion` is the inclusive floor and it blocks (APCC-TC-054). `2026.09.08`
is the earliest build any Roubo Cursor work touched, so the floor brackets the
verified builds without claiming anything about older ones. A build below it
fails the launch before any terminal opens, with a message that names the
detected version, the required version, and how to update.

`testedCeiling` is the build this plugin was verified against, and it never
blocks (APCC-TC-055). The Cursor CLI ships on a date-based cadence, so
refusing an unrecognised newer build would age far worse than a warning does.
Above the ceiling the session launches with a non-blocking notice that names
the ceiling, and an amber chip on the card. Raise the ceiling as part of
re-verifying against a newer CLI, and raise `minVersion` only when something
this plugin emits genuinely stops working.

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

The host layers the project's permissions model onto the effective config as
`config.permissions`, above all four configuration layers, and this plugin maps
both of its axes (APCC-FR-015, APCC-FR-016):

```ts
{ posture?: "read-only" | "guarded" | "auto-edit" | "full-auto",
  rules: { allow: string[]; ask: string[]; deny: string[] } }
```

**Posture** binds through argv. The plugin declares each posture's flags on its
permissions capability and the host appends the selected set; no two postures
emit the same set, and with no posture selected no posture flag is emitted
(APCC-TC-039):

| Posture     | Emits                             | Effect                                                               |
| ----------- | --------------------------------- | -------------------------------------------------------------------- |
| `read-only` | `--mode plan`                     | Read-only planning mode: the session makes no edits.                 |
| `guarded`   | `--sandbox enabled`               | Prompts for every call that no rule allows.                          |
| `auto-edit` | `--auto-review --sandbox enabled` | The Auto-review classifier runs safe calls and prompts for the rest. |
| `full-auto` | `--force --sandbox disabled`      | Runs everything that no rule denies.                                 |

`--trust` is never emitted for a posture: it answers Cursor's workspace-trust
prompt and is not a permission tier. When the selected posture sets its own
`--mode` (only `read-only` does), the configured mode emits no flag, so a
command line never carries two `--mode` flags.

**Rules** need a file, so the plugin declares
`rules: { carrier: "workspace-write", resync: true }` and emits a write to the
bench's `.cursor/cli.json`. Cursor's rules carry allow and deny only, and deny
beats allow:

- `allow` and `deny` map onto `permissions.allow` and `permissions.deny`
  (APCC-TC-040).
- `ask` is never written. Cursor already prompts for anything neither allowed
  nor denied, so an ask rule maps onto that default (APCC-TC-042). The manifest
  says so too, with `agentPermissionRuleTiers: [allow, deny]`, so the
  permissions screen offers no way to create an ask rule for a Cursor project
  and marks any the project already saved as not applied (APCC-TC-043). That
  key is what makes the 1.7.0 host floor in `roubo: ^1.7.0` necessary.
- Each rule is normalised into Cursor's typed form. `Shell(...)`, `Read(...)`,
  and `Write(...)` pass through; `Bash(...)` becomes `Shell(...)`, and
  `Edit(...)` and `MultiEdit(...)` become `Write(...)`. A bare tool name covers
  every use, so `Bash` becomes `Shell(*)`. A rule with no Cursor analogue, for
  example `WebFetch(...)`, is dropped rather than written as a token Cursor
  rejects.

The ops are `unionArray`, never `set`, and the host applies them against the
parsed existing file, so an unrelated key in it and any rule already in the
lists survive the write (APCC-TC-041). A project with no allow or deny rules
produces no write at all. The path is relative, and the host resolves it inside
the bench workspace and refuses and reports any write that escapes it
(APCC-TC-045). The user's global `~/.cursor/cli-config.json` is never written
(APCC-TC-044).

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
