import type { BenchContext, ProcessProvisionDescriptor } from "@roubo/plugin-sdk";

/**
 * Pure mapping from the bundled `process` component's opaque config block to a
 * `process` ProvisionDescriptor the host LifecycleEngine executes. The plugin is
 * declarative: it only emits this descriptor and never spawns a process itself
 * (AC5). The host owns starting `command`, running the one-time `setup`, merging
 * `env` / `envFile`, and resolving the working directory.
 *
 * Config fields (validated host-side against the manifest configSchema):
 *
 * - `command` (required): the process command line. A missing or empty command
 *   is rejected here with a clear error (AC4), before any descriptor is emitted.
 * - `setup`: optional one-time setup command (e.g. `npm install`). The engine
 *   runs it once and skips it on a Stop -> Start cycle (FR-007 parity).
 * - `env`: environment variables injected into the spawned process. They win
 *   over `envFile` entries on conflict (the engine performs the merge).
 * - `envFile`: a workspace-relative KEY=VALUE file merged into the process env.
 * - `directory`: a workspace-relative working directory. It maps to the
 *   descriptor's `cwd`, which the engine resolves against the bench
 *   `workspacePath`. Omitted means the workspace root.
 *
 * `dependsOn` is deliberately NOT a plugin-config field: core models it at the
 * component entry level (sibling to `config`, see `ComponentConfigSchema`) and
 * drives start/stop ordering from there, so it never reaches the opaque `config`
 * this function receives.
 *
 * The user-facing key is `directory`; the descriptor key is `cwd`. The rename is
 * the only transform (the engine resolves the relative path against the bench
 * `workspacePath`), preserving built-in process-component fidelity.
 */
export function translate(params: {
  config: Record<string, unknown>;
  // `context` carries the bench's resolved workspacePath/ports/env. The engine
  // resolves `cwd` against `workspacePath`, so translate stays a pure mapping
  // and does not read it; it is part of the contract signature.
  context: BenchContext;
}): ProcessProvisionDescriptor {
  const { config } = params;

  const command = config.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error(
      'process component plugin: a non-empty "command" is required, but it was missing or empty.',
    );
  }

  const descriptor: ProcessProvisionDescriptor = {
    schemaVersion: 1,
    kind: "process",
    command,
  };

  const env = config.env;
  if (env !== undefined) {
    descriptor.env = env as Record<string, string>;
  }

  const envFile = config.envFile;
  if (typeof envFile === "string" && envFile.length > 0) {
    descriptor.envFile = envFile;
  }

  // The user-facing `directory` key maps to the descriptor's `cwd`. The engine
  // resolves a relative cwd against the bench workspacePath; omitting it lets the
  // engine default to the workspace root.
  const directory = config.directory;
  if (typeof directory === "string" && directory.length > 0) {
    descriptor.cwd = directory;
  }

  const setup = config.setup;
  if (typeof setup === "string" && setup.length > 0) {
    descriptor.setup = setup;
  }

  return descriptor;
}
