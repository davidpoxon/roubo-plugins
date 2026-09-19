import type { AgentLaunchContext, AgentLaunchDescriptor } from "@roubo/plugin-sdk";
import { tokenize } from "./tokenize.js";

/**
 * The command the host spawns. The Cursor CLI installs itself as `agent`. The
 * host resolves the bare name on its PATH first and then through the manifest's
 * `agentInstallLocations`; it is never shell-interpreted.
 */
const COMMAND = "agent";

/**
 * The host truncates a positional prompt to this length before spawning, which
 * mirrors the Codex and Claude Code plugins' cap and so preserves the
 * truncation behaviour the parent spec fixed (APCC-FR-014, APCC-TC-034).
 * Declaring `initialPrompt` at all is what makes jig injection work: the host
 * appends the jig as the final positional argument, after every generated flag
 * (APCC-TC-033). `agent "<prompt>"` starts an interactive session with that
 * prompt as its first message.
 */
const MAX_PROMPT_LENGTH = 100_000;

/**
 * Build the generated argv from the effective config.
 *
 * This slice generates no flag of its own: the model, mode, permission,
 * notification, and version axes each land in their own slice and put their
 * flags ahead of the extra arguments. The tokenized extra arguments come last,
 * so an extra argument can override a generated one rather than be overridden
 * by it.
 */
export function buildArgs(config: Record<string, unknown>): string[] {
  const args: string[] = [];

  const extraArgs = config.extraArgs;
  if (extraArgs !== undefined && extraArgs !== null) {
    if (typeof extraArgs !== "string") {
      throw new Error(
        'cursor-cli agent plugin: "extraArgs" must be a string, but it was ' +
          `${typeof extraArgs}.`,
      );
    }
    args.push(...tokenize(extraArgs));
  }

  return args;
}

/**
 * Map the effective Cursor CLI plugin config to the launch descriptor the host
 * validates and executes (APCC-FR-008).
 *
 * The plugin is declarative: it emits argv and capability data, nothing else.
 * The host owns the PTY spawn, defaults `cwd` to the bench workspace, and
 * appends the initial prompt as the last positional. Because the host spawns
 * `args` as an argv array and never through a shell, every token here reaches
 * the CLI literally (APCC-NFR-001).
 */
export function translateLaunch(params: {
  config: Record<string, unknown>;
  // `context` carries the host-minted `sessionId`, the bench workspace, and the
  // already-merged `effectiveConfig` (the same object as `config`). The session
  // identity is templated rather than read, so translateLaunch stays a pure
  // mapping; `context` is part of the contract signature.
  context: AgentLaunchContext;
}): AgentLaunchDescriptor {
  return {
    schemaVersion: 1,
    kind: "agent-launch",
    command: COMMAND,
    args: buildArgs(params.config),
    initialPrompt: { mode: "argv-positional", maxLength: MAX_PROMPT_LENGTH },
  };
}
