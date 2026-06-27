# @roubo/plugin-database

Bundled Roubo **component** plugin that provisions a docker-backed database for a
bench (Postgres, MySQL, Redis, and the like). It reproduces the built-in docker
database component at full parity, with no loss of fidelity, as the database half
of the component-plugin dogfood (CP-FR-004, CP-FR-007, CP-US-002).

## How it works

The plugin is **declarative**: it registers a single `translate({ config,
context })` method via `defineComponentPlugin()` and emits a `docker`
ProvisionDescriptor. The host's `LifecycleEngine` runs the full phase machine
(composeUp -> waitForHealthy -> initService -> migration -> connection
templating) over the host-RPC broker. The plugin never drives docker itself
(`permissions.docker: true` only declares the capability the host exercises on
its behalf; the plugin starts no container).

## Config

The component's opaque `config` block (validated host-side against the manifest
`configSchema`) accepts:

| Key           | Required | Maps to descriptor | Notes                                                                                               |
| ------------- | -------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| `composeFile` | yes      | `composeFile`      | Workspace-relative docker-compose file. A missing or empty value is rejected (a clear error).       |
| `service`     | yes      | `service`          | The compose service brought up. A missing or empty value is rejected (a clear error).               |
| `initService` | no       | `initService`      | Compose service run once (`compose run --rm`) before the database is ready (e.g. a seed/init step). |
| `portEnvVar`  | no       | `portEnvVar`       | Env var the allocated host port is interpolated into for compose. Defaults to `HOST_PORT`.          |
| `migration`   | no       | `migration`        | `{ command, args? }` run once the service is healthy (and after the init service, when present).    |
| `connection`  | no       | `connection`       | `{ template }`; the engine fills `{{port}}` / `{{ports.<component>}}` with the allocated host port. |
| `env`         | no       | `env`              | Variables merged into the compose interpolation env (and the migration env) alongside the port.     |

`dependsOn` is **not** a `config` key. It is declared at the component entry
level (a sibling of `plugin` and `config`, see the example below), where core
validates it and drives start/stop ordering, so it never reaches this plugin's
opaque `config`.

`assignedContainerId` is likewise **not** a user-authored `config` key (the
manifest `configSchema` intentionally omits it). Core injects it from the
bench's external-container assignment (`bench.assignedContainers`), and
`translate` forwards it onto the descriptor: when present, the engine skips
compose and only verifies the external container is running.

## Example

```yaml
components:
  db:
    plugin:
      id: database
    config:
      composeFile: docker-compose.yml
      service: postgres
      initService: init
      portEnvVar: DB_PORT
      migration:
        command: npm run migrate
        args:
          - --latest
      connection:
        template: postgres://localhost:{{port}}/app
      env:
        POSTGRES_PASSWORD: secret
```

## Lifecycle parity

Because the descriptor is executed by the same `LifecycleEngine` the built-in
docker database component runs through, a database component backed by this
plugin provisions, migrates, and reconciles identically to the built-in one: the
allocated host port is interpolated into the compose environment and the
connection string, the optional init service and migration run in the same
order, and an externally assigned container short-circuits compose. See
`src/parity.test.ts`.
