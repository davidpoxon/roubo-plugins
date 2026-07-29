# @roubo/plugin-claude-code

Bundled Roubo **agent** plugin that launches Claude Code sessions in a bench,
honouring the configured model, reasoning effort, and permission mode, plus a
free-form additional-CLI-arguments field appended as separate argv tokens
(AP-FR-017, AP-US-008). It is the first agent-kind plugin, built against the
published `@roubo/plugin-sdk` agent contract.

## How it works

The plugin is **declarative**: it registers a single `translateLaunch({ config,
context })` method via `defineAgentPlugin()` and emits an `agent-launch`
descriptor. The host validates that descriptor, resolves `{{sessionId}}` in the
argv, spawns the PTY, and appends the initial prompt as the last positional
argument. The plugin spawns nothing itself (`permissions.processes: false`), so
it holds no privilege beyond an integration plugin's (AP-NFR-001).

`config` is the host's already-merged effective config: app defaults, project
overrides, preset, and per-launch values, resolved before `translateLaunch` runs.
The mapping is pure, so a given config always produces the same argv.

Generated argv, in order:

```
--model <model>  --effort <effort>  --permission-mode <mode>  <extra args…>  --session-id {{sessionId}}  [prompt]
```

The generated flags come first and the user's extra tokens follow them, so an
extra argument can override a generated flag rather than be overridden by it.
`--session-id <uuid>` stays the stable argv tail the host correlates a session
on, and the positional prompt (capped at 100,000 characters) closes the line.

## Config

The plugin's `config` block (validated host-side against the manifest
`configSchema`) accepts:

| Key         | Required | Maps to descriptor                | Notes                                                                                                                                |
| ----------- | -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `model`     | no       | `--model <value>`                 | One of `default`, `opus`, `sonnet`, `haiku`. `default` is "Account default": it emits no `--model` at all and defers to the account. |
| `effort`    | no       | `--effort <value>`                | One of `default`, `low`, `medium`, `high`, `xhigh`, `max`. `default` is "CLI default": it emits no `--effort` at all.                |
| `mode`      | no       | `--permission-mode <value>`       | One of `default`, `plan`, `auto`, `acceptEdits`, `manual`. `default` emits no flag. `auto` emits `--permission-mode auto`.           |
| `extraArgs` | no       | extra argv tokens after the flags | Free-form string, split into discrete argv entries. Empty or whitespace-only appends nothing.                                        |

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
quote or another backslash). Every other character is an ordinary literal, so
`;`, `&`, `|`, `>`, `<`, `$`, parentheses, and backticks carry no meaning: there
is no command separation, no variable expansion, and no command substitution. The
host spawns `args` as an argv array and never through a shell, so
`--foo; rm -rf $HOME "$(whoami)"` becomes the five literal tokens `--foo;`, `rm`,
`-rf`, `$HOME`, `$(whoami)` and runs nothing. An unbalanced quote or a dangling
backslash is rejected with a clear error rather than guessed at.

## Example

Agent config is not part of `roubo.yaml`. Application-level defaults live in
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

## Lifecycle parity

Because the descriptor is executed by the same host launch pipeline the built-in
Claude Code integration runs through, a session launched by this plugin is
correlated identically to the built-in one: `--session-id <uuid>` remains the
stable tail and the initial prompt remains the final positional argument, which
is the shape the in-tree conformance suite pins. This slice covers the launch
flags only; jig injection, notification wiring, permissions writes, and version
gating land in their own slices.

One parity gap is deliberate and not yet closed. The descriptor's `command` is
the bare name `claude`, which the host spawns verbatim. The built-in path instead
resolves the binary through `getClaudeBinary()`, which falls back to the
well-known install locations (`~/.local/bin/claude`, `~/.claude/local/claude`,
`/opt/homebrew/bin/claude`, `/usr/local/bin/claude`) when `claude` is not on the
server process's PATH. The launch-descriptor contract exposes no equivalent hook,
so on an install that relies on one of those fallbacks (notably the
`~/.claude/local/claude` shim, or a fish login shell) a plugin-launched session
can fail to spawn where the built-in one succeeds. Closing it needs a host-side
change: resolving an agent descriptor's `command` through the same well-known-path
fallback before the PTY spawn. That is tracked as
[davidpoxon/roubo-development#645](https://github.com/davidpoxon/roubo-development/issues/645).
Until it lands, the parity claim above covers argv shape and session
correlation, not binary discovery.
