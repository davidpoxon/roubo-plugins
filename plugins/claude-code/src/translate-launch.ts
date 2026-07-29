import type { AgentLaunchContext, AgentLaunchDescriptor } from "@roubo/plugin-sdk";
import { tokenize } from "./tokenize.js";

/** The command the host spawns. Resolved on the host PATH; never shell-interpreted. */
const COMMAND = "claude";

/**
 * The host truncates a positional prompt to this length before spawning, and
 * mirrors the built-in Claude Code integration's cap.
 */
const MAX_PROMPT_LENGTH = 100_000;

/**
 * Model choices. `default` is the "account default" sentinel: it emits no
 * `--model` flag at all so the CLI falls back to the account setting
 * (AP-TC-090).
 */
const MODELS = ["default", "opus", "sonnet", "haiku"] as const;

/** Reasoning-effort choices, each emitted verbatim as `--effort <value>` (AP-TC-093). */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Permission-mode choices (AP-TC-094). `default` is the sentinel that emits no
 * `--permission-mode` flag. `auto` maps to `--permission-mode auto`: the removed
 * `--enable-auto-mode` flag is never emitted (AP-TC-092).
 */
const MODES = ["default", "plan", "auto", "acceptEdits", "manual"] as const;

/**
 * Build the generated argv prefix from the effective config: the `--model`,
 * `--effort` and `--permission-mode` flags, then the tokenized extra arguments
 * (AP-FR-017).
 *
 * Order matters and is part of the contract: the generated flags come first and
 * the user's extra tokens follow them (AP-TC-088), so an extra argument can
 * override a generated flag rather than be overridden by it. The caller appends
 * the session id after this prefix, keeping `--session-id <uuid>` as the stable
 * argv tail the host correlates a session on.
 *
 * Each value is a *separate* argv entry: `["--model", "opus"]`, never
 * `["--model=opus"]` and never one joined string (AP-TC-085).
 *
 * An absent key is treated as the sentinel default, so a config that omits a
 * field behaves exactly like one that sets it to `default` (and, for
 * `extraArgs`, appends nothing: AP-TC-091).
 */
export function buildArgs(config: Record<string, unknown>): string[] {
  const args: string[] = [];

  const model = readChoice(config.model, MODELS, "model");
  if (model !== undefined && model !== "default") args.push("--model", model);

  const effort = readChoice(config.effort, EFFORTS, "effort");
  if (effort !== undefined) args.push("--effort", effort);

  const mode = readChoice(config.mode, MODES, "mode");
  if (mode !== undefined && mode !== "default") args.push("--permission-mode", mode);

  const extraArgs = config.extraArgs;
  if (extraArgs !== undefined && extraArgs !== null) {
    if (typeof extraArgs !== "string") {
      throw new Error(
        'claude-code agent plugin: "extraArgs" must be a string, but it was ' +
          `${typeof extraArgs}.`,
      );
    }
    args.push(...tokenize(extraArgs));
  }

  return args;
}

/**
 * Map the effective Claude Code plugin config to the launch descriptor the host
 * validates and executes (AP-FR-017).
 *
 * The plugin is declarative: it emits argv and nothing else. The host owns the
 * PTY spawn, resolves `{{sessionId}}` in the argv template, appends the initial
 * prompt as a positional argument, and defaults `cwd` to the bench workspace.
 * Because the host spawns `args` as an argv array and never through a shell,
 * every token here reaches the CLI literally (AP-TC-089).
 */
export function translateLaunch(params: {
  config: Record<string, unknown>;
  // `context` carries the host-minted `sessionId`, the bench workspace, and the
  // already-merged `effectiveConfig` (which is the same object as `config`). The
  // session id is templated rather than read, so translateLaunch stays a pure
  // mapping; `context` is part of the contract signature.
  context: AgentLaunchContext;
}): AgentLaunchDescriptor {
  return {
    schemaVersion: 1,
    kind: "agent-launch",
    command: COMMAND,
    // The stable tail: `--session-id <uuid>` closes the generated argv, and the
    // host appends the initial prompt (if any) after it as the last positional.
    args: [...buildArgs(params.config), "--session-id", "{{sessionId}}"],
    initialPrompt: { mode: "argv-positional", maxLength: MAX_PROMPT_LENGTH },
  };
}

/**
 * Read one closed-choice config field. An absent (or empty) field reads as
 * `undefined`, which every caller treats as that field's sentinel default; an
 * unrecognised one is rejected with a message naming the field and its allowed
 * values, rather than being passed through as an opaque argv token.
 */
function readChoice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(
    `claude-code agent plugin: "${field}" must be one of ${allowed.join(", ")}, but it was ` +
      `${JSON.stringify(value)}.`,
  );
}
