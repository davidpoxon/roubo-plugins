# @roubo/plugin-process

Bundled Roubo **component** plugin that supervises a long-running process for a
bench (a backend server, a frontend dev server, a worker). It reproduces the
built-in process component at full parity, with no loss of fidelity, as the
process half of the component-plugin dogfood (CP-FR-005, CP-FR-007, CP-US-002).

## How it works

The plugin is **declarative**: it registers a single `translate({ config,
context })` method via `defineComponentPlugin()` and emits a `process`
ProvisionDescriptor. The host's `LifecycleEngine` executes that descriptor. The
plugin never drives the host process broker and so spawns nothing itself
(`permissions.processes: false`); the host owns starting the command, running
the one-time setup, merging the environment, and resolving the working
directory.

## Config

The component's opaque `config` block (validated host-side against the manifest
`configSchema`) accepts:

| Key         | Required | Maps to descriptor | Notes                                                                                                               |
| ----------- | -------- | ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `command`   | yes      | `command`          | The process command line. A missing or empty command is rejected (a clear error).                                   |
| `setup`     | no       | `setup`            | One-time setup command (e.g. `npm install`); skipped on a Stop -> Start cycle.                                      |
| `env`       | no       | `env`              | Environment variables injected into the process. Win over `envFile` on conflict.                                    |
| `envFile`   | no       | `envFile`          | Workspace-relative KEY=VALUE file merged into the process environment.                                              |
| `directory` | no       | `cwd`              | Workspace-relative working directory; the engine resolves it against the workspace. Defaults to the workspace root. |
| `shell`     | no       | `shell`            | Opt-in shell interpretation for `command` **and** `setup`. Omitted, both run as argv. See below.                    |

The only user-facing rename is `directory` -> the descriptor's `cwd`; the host
engine resolves the relative path against the bench `workspacePath`, and merges
`env` / `envFile` (explicit `env` wins), preserving built-in env/envFile
injection.

## `shell`

`command` and `setup` are **argv by default**: the host tokenizes the string and
spawns the first token, so `&&`, `;`, redirection, globs and `$VAR` are literal
arguments and a shell function such as `nvm` is invisible. `shell` is the opt-in
that changes that, and the plugin copies it onto the descriptor unchanged (the
host's `LifecycleEngine` owns the branch, so the plugin still spawns nothing).

- `shell: true` runs the command through `/bin/sh -c`. Operators, redirection,
  globs and `$VAR` work. That shell is neither interactive nor login, so it
  sources no rc file: **`shell: true` will not make `nvm use` work.**
- `shell: <string>` is the shell invocation the command is appended to as `-c`,
  so `zsh -i` spawns `zsh -i -c "<command>"`. This is the only form that reaches
  an interactive shell, and therefore the only one that sees an
  nvm-in-`.zshrc` setup. It accepts an absolute path (`/bin/zsh -ilc`) or a bare
  command name resolved through `PATH` (`zsh -i`).

An interactive shell sources the user's whole rc file on every start, so a heavy
prompt framework adds startup latency and any rc line that writes to stdout lands
in this component's logs. Prefer `shell: true` when that is enough.

```yaml
components:
  frontend:
    plugin:
      id: process
    config:
      command: nvm use && npm run dev
      shell: zsh -i
      directory: web
```

`dependsOn` is **not** a `config` key. It is declared at the component entry
level (a sibling of `plugin` and `config`, see the example below), where core
validates it and drives start/stop ordering, so it never reaches this plugin's
opaque `config`.

## Example

```yaml
components:
  api:
    plugin:
      id: process
    config:
      command: npm run dev
      setup: npm install
      directory: services/api
      envFile: .env.local
      env:
        NODE_ENV: development
    dependsOn:
      - db
```

## Lifecycle parity

Because the descriptor is executed by the same `LifecycleEngine` the built-in
process component runs through, a process component backed by this plugin
starts, runs, stops, and reconciles identically to the built-in one: the
canonical process id (`<pluginId>:<benchId>:<componentName>`) is the key stop and
reconcile use, and the one-time `setup` is skipped on a Stop -> Start cycle. See
`src/parity.test.ts`.
