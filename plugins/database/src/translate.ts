import type { BenchContext, DockerProvisionDescriptor } from "@roubo/plugin-sdk";

/**
 * Pure mapping from the bundled `database` component's opaque config block to a
 * `docker` ProvisionDescriptor the host LifecycleEngine executes. The plugin is
 * declarative: it only emits this descriptor and never drives docker itself
 * (AC6). The host owns the full phase machine: composeUp -> waitForHealthy ->
 * initService -> migration -> connection templating, via the host-RPC broker.
 *
 * Config fields (validated host-side against the manifest configSchema):
 *
 * - `composeFile` (required): the docker-compose file (workspace-relative) that
 *   defines the database service. A missing or empty value is rejected here with
 *   a clear error (AC5), before any descriptor is emitted.
 * - `service` (required): the compose service to bring up. Missing or empty is
 *   likewise rejected with a clear error (AC5).
 * - `initService`: an optional compose service run once (`compose run --rm`)
 *   before the database is considered ready (a seed/init step).
 * - `portEnvVar`: the env var the allocated host port is interpolated into for
 *   compose. The engine defaults it to `HOST_PORT` when omitted.
 * - `migration`: an optional `{ command, args? }` run after the service is
 *   healthy (and after the init service, when present).
 * - `connection`: an optional `{ template }` connection string; the engine fills
 *   `{{port}}` / `{{ports.<component>}}` with the allocated host port.
 * - `env`: environment variables merged into the compose interpolation
 *   environment (and the migration process env) alongside the allocated port,
 *   mirroring the built-in database env injection (FR-004 / FR-007 parity).
 * - `assignedContainerId`: when an external container is assigned to this
 *   component, the engine skips compose entirely and only verifies it is running
 *   (AC3). It is carried through verbatim when present.
 *
 * `dependsOn` is deliberately NOT a plugin-config field: core models it at the
 * component entry level (sibling to `config`, see `ComponentConfigSchema`) and
 * drives start/stop ordering from there, so it never reaches the opaque `config`
 * this function receives.
 *
 * Every optional field is emitted only when present, so a minimal
 * compose-file/service config maps to a minimal descriptor (AC4).
 */
export function translate(params: {
  config: Record<string, unknown>;
  // `context` carries the bench's resolved ports/env/workspacePath. The engine
  // resolves the allocated port and templates the connection string, so
  // translate stays a pure mapping and does not read it; it is part of the
  // contract signature.
  context: BenchContext;
}): DockerProvisionDescriptor {
  const { config } = params;

  const composeFile = config.composeFile;
  if (typeof composeFile !== "string" || composeFile.trim().length === 0) {
    throw new Error(
      'database component plugin: a non-empty "composeFile" is required, but it was missing or empty.',
    );
  }

  const service = config.service;
  if (typeof service !== "string" || service.trim().length === 0) {
    throw new Error(
      'database component plugin: a non-empty "service" is required, but it was missing or empty.',
    );
  }

  const descriptor: DockerProvisionDescriptor = {
    schemaVersion: 1,
    kind: "docker",
    composeFile,
    service,
  };

  const initService = config.initService;
  if (typeof initService === "string" && initService.length > 0) {
    descriptor.initService = initService;
  }

  const portEnvVar = config.portEnvVar;
  if (typeof portEnvVar === "string" && portEnvVar.length > 0) {
    descriptor.portEnvVar = portEnvVar;
  }

  const migration = config.migration;
  if (migration !== undefined && migration !== null && typeof migration === "object") {
    const m = migration as { command?: unknown; args?: unknown };
    if (typeof m.command === "string" && m.command.length > 0) {
      descriptor.migration = Array.isArray(m.args)
        ? { command: m.command, args: m.args as string[] }
        : { command: m.command };
    }
  }

  const connection = config.connection;
  if (connection !== undefined && connection !== null && typeof connection === "object") {
    const c = connection as { template?: unknown };
    if (typeof c.template === "string" && c.template.length > 0) {
      descriptor.connection = { template: c.template };
    }
  }

  const env = config.env;
  if (env !== undefined && env !== null && typeof env === "object" && !Array.isArray(env)) {
    descriptor.env = env as Record<string, string>;
  }

  const assignedContainerId = config.assignedContainerId;
  if (typeof assignedContainerId === "string" && assignedContainerId.length > 0) {
    descriptor.assignedContainerId = assignedContainerId;
  }

  return descriptor;
}
