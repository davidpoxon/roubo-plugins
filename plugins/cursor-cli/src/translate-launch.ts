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
 * Operating-mode choices, emitted as `--mode <value>` (APCC-FR-011,
 * APCC-TC-026). `agent` is the CLI's own default, so it emits no flag.
 */
const MODES = ["agent", "plan", "ask"] as const;

/**
 * The value the mode axis falls back on when the config omits it. It MUST equal
 * the manifest `configSchema` default, and a test asserts it does: the host
 * does not seed schema defaults into the effective config, so an unsaved field
 * reaches `translateLaunch` as absent.
 */
const DEFAULT_MODE = "agent";

/**
 * Cursor's own worktree flags (APCC-FR-013). Roubo already runs the bench in
 * its own git worktree, so a CLI that creates another one would split the
 * session from the bench. `-w` is the short form of `--worktree`.
 */
const WORKTREE_LONG_FLAGS = ["--worktree", "--worktree-base", "--skip-worktree-setup"] as const;
const WORKTREE_SHORT_FLAG = "-w";

/**
 * Build the generated argv from the effective config: the `--model` flag, the
 * `--mode` flag, then the tokenized extra arguments (APCC-FR-009,
 * APCC-FR-011, APCC-FR-012).
 *
 * Order matters and is part of the contract: the generated flags come first and
 * the user's extra tokens follow them (APCC-TC-027), so an extra argument can
 * override a generated one rather than be overridden by it. Each flag and each
 * value is a separate argv entry: `["--mode", "plan"]`, never one joined
 * string. The permission, notification, and version axes land in their own
 * slices, ahead of the extra arguments.
 *
 * The selected model id is emitted unchanged as one `["--model", id]` pair
 * (APCC-FR-009). The id comes from the host-run `agent --list-models` probe and
 * already fixes its effort and speed, so the plugin never adds bracketed
 * parameters and never derives a base name from it (spike 847). An unset,
 * null, or empty model emits no flag, which leaves the session on the account
 * default; a failed probe leaves the field unset, so a launch still succeeds
 * (APCC-TC-015, APCC-TC-017).
 *
 * The worktree guard runs over the assembled argv, so one check covers the
 * generated flags and the user's extra tokens alike (APCC-TC-029,
 * APCC-TC-030).
 */
export function buildArgs(config: Record<string, unknown>): string[] {
  const args: string[] = [];

  const model = config.model;
  if (model !== undefined && model !== null) {
    if (typeof model !== "string") {
      throw new Error(
        `cursor-cli agent plugin: "model" must be a string, but it was ${typeof model}.`,
      );
    }
    if (model !== "") {
      args.push("--model", model);
    }
  }

  const mode = readChoice(config.mode, MODES, "mode", DEFAULT_MODE);
  if (mode !== DEFAULT_MODE) args.push("--mode", mode);

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

  assertNoWorktreeFlag(args);

  return args;
}

/**
 * Refuse the launch when any argv entry is one of Cursor's worktree flags. It
 * matches the bare flag, the `--flag=value` form, and the short flag with an
 * attached value (`-wname`). The message names the canonical flag and states
 * that Roubo owns the worktree, so removing that flag is the clear fix.
 */
function assertNoWorktreeFlag(args: readonly string[]): void {
  for (const arg of args) {
    const flag = worktreeFlagOf(arg);
    if (flag !== undefined) {
      throw new Error(
        `cursor-cli agent plugin: the "${flag}" flag is not allowed, because Roubo owns ` +
          "the worktree. The session already runs in the bench's git worktree; remove " +
          `"${flag}" from the additional CLI arguments.`,
      );
    }
  }
}

function worktreeFlagOf(arg: string): string | undefined {
  for (const flag of WORKTREE_LONG_FLAGS) {
    if (arg === flag || arg.startsWith(`${flag}=`)) return flag;
  }
  if (arg.startsWith(WORKTREE_SHORT_FLAG)) return WORKTREE_SHORT_FLAG;
  return undefined;
}

/**
 * Read one closed-choice config field. An absent (or empty) field reads as that
 * field's manifest default; an unrecognised value is rejected with a message
 * naming the field and its allowed values, rather than passed through as an
 * opaque argv token.
 */
function readChoice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  fallback: T,
): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(
    `cursor-cli agent plugin: "${field}" must be one of ${allowed.join(", ")}, but it was ` +
      `${JSON.stringify(value)}.`,
  );
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
