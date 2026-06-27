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

The only user-facing rename is `directory` -> the descriptor's `cwd`; the host
engine resolves the relative path against the bench `workspacePath`, and merges
`env` / `envFile` (explicit `env` wins), preserving built-in env/envFile
injection.

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
