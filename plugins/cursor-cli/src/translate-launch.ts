import type {
  AgentLaunchContext,
  AgentLaunchDescriptor,
  AgentPosture,
  NotificationWiring,
  PermissionsCapability,
  VersionProbeSpec,
  WaitingDetectionSpec,
  WorkspaceWriteSpec,
  WriteOp,
} from "@roubo/plugin-sdk";
import { tokenize } from "./tokenize.js";

/**
 * The command the host spawns. The Cursor CLI installs itself as `agent`. The
 * host resolves the bare name on its PATH first and then through the manifest's
 * `agentInstallLocations`; it is never shell-interpreted.
 */
const COMMAND = "agent";

/**
 * The bench-local file the Cursor CLI reads its project permission rules from.
 * It is relative, so the host resolves it inside the bench workspace and
 * rejects any escape. The user's global `~/.cursor/cli-config.json` is never a
 * write target (APCC-TC-044, APCC-TC-045).
 */
const RULES_REL_PATH = ".cursor/cli.json";

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
 * The pre-launch version gate (APCC-FR-018, APCC-NFR-003).
 *
 * Declarative only: the plugin says which arguments read the version and where
 * the supported window sits, and the host spawns the probe, parses the first
 * three integer groups out of `agent --version`, and decides. The Cursor CLI
 * reports a date-based build such as `2026.09.15-d2fe57e`, which `parse:
 * "semver"` reads as `2026.09.15` and orders numerically across day, month, and
 * year boundaries, so no contract change is needed (APCC-TC-053). The bounds
 * mirror the manifest's `agentCompatibility` block, which is what the AI Agents
 * screen renders without launching anything; these are what the launch gate
 * enforces.
 *
 * `minVersion` is inclusive and blocking: `2026.09.08` is the earliest build any
 * Roubo Cursor work touched. `testedCeiling` warns only: `2026.09.15` is the
 * build this plugin was verified against.
 */
const VERSION_PROBE: VersionProbeSpec = {
  args: ["--version"],
  parse: "semver",
  minVersion: "2026.09.08",
  testedCeiling: "2026.09.15",
};

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
 * string. The permission posture adds no flag here: its flags are declared on
 * the permissions capability and the host appends them (see
 * PERMISSIONS_CAPABILITY). When the selected posture carries its own `--mode`,
 * the mode axis emits nothing, so one command line never holds two `--mode`
 * flags (`omitMode`). The version axis adds no flag: it is the descriptor's
 * `capabilities.versionProbe` (see VERSION_PROBE). The notification wiring adds
 * no flag at all, because it rides a workspace file rather than argv (see
 * NOTIFICATION_WIRING).
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
export function buildArgs(
  config: Record<string, unknown>,
  opts: { omitMode?: boolean } = {},
): string[] {
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
  if (mode !== DEFAULT_MODE && !opts.omitMode) args.push("--mode", mode);

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
 * The host owns the PTY spawn, defaults `cwd` to the bench workspace, resolves
 * the notification templates and writes the hooks file, and appends the
 * initial prompt as the last positional. Because the host spawns
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
  const permissions = readPermissions(params.config.permissions);
  const rulesWrite = buildRulesWrite(permissions?.rules);

  return {
    schemaVersion: 1,
    kind: "agent-launch",
    command: COMMAND,
    // The posture flags are not pushed here: the host appends the selected
    // posture's declared args, as it does for every agent plugin.
    args: buildArgs(params.config, { omitMode: postureSetsMode(permissions?.posture) }),
    initialPrompt: { mode: "argv-positional", maxLength: MAX_PROMPT_LENGTH },
    capabilities: {
      ...(rulesWrite !== undefined && { workspaceWrites: [rulesWrite] }),
      notification: NOTIFICATION_WIRING,
      versionProbe: VERSION_PROBE,
      waitingDetection: WAITING_DETECTION,
      permissions: PERMISSIONS_CAPABILITY,
    },
  };
}

/**
 * Turn completion, carried by a Cursor `stop` hook (APCC-FR-017, spike 846).
 *
 * Cursor reads its hooks from `.cursor/hooks.json` in the workspace, so the
 * registration rides a workspace write into the bench worktree. The plugin
 * registers one entry in `hooks.stop[]`. `stop` fires once per model turn, and
 * it also fires with a `status` of `aborted` or `error`; spike 846 rejected
 * `sessionEnd` and `afterAgentResponse` as the completion signal.
 *
 * Cursor runs each hook `command` through `$SHELL -c` and writes the event JSON
 * to the command's standard input (`payload: "json-stdin"`). The plugin never
 * builds that string itself: it declares the notifier argv in `carrier.args`,
 * and the host resolves `{{notifier}}` to the agent-generic notifier program it
 * installs, resolves `{{sessionId}}` to the session id it mints, shell-quotes
 * each element, joins them, and substitutes the result for
 * `{{notifierCommand}}` in the write. The notifier then receives the Roubo
 * session id as its one argument and the payload on stdin, so correlation
 * needs no parsing of Cursor's own ids (APCC-TC-049). The session id is a
 * template, never a real value, so this mapping stays pure.
 *
 * One turn can send two `stop` events. The host reuses the bench's live
 * notification rather than raising a second one, so one idle period raises at
 * most one waiting notification (APCC-TC-051).
 *
 * The ops apply in order against the parsed existing file, so every other key
 * and every hook on another event survives (APCC-TC-048). One limit: `set`
 * replaces the whole `hooks.stop` array, so a `stop` entry the user registered
 * in this worktree's own hooks file is displaced for a Roubo-launched session.
 * The contract's only merge op, `unionArray`, takes strings, and a hook entry is
 * an object, so a per-entry merge needs a new host op
 * (davidpoxon/roubo-development#890). `version: 1` is the
 * hooks-file schema version Cursor requires.
 */
const NOTIFICATION_WIRING: NotificationWiring = {
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
};

/**
 * How the host decides a Cursor session is waiting on the user (APCC-FR-017,
 * APCC-NFR-003, APCC-TC-050).
 *
 * Hook-driven with a quiescence fallback that stays on for every session: no
 * hook fires while an approval prompt waits, and a hook that never fires must
 * still degrade to a waiting notification rather than raise nothing. The window
 * is measured against the Cursor CLI's own redraw behaviour, not inherited from
 * another agent (spike 846): a working turn redraws about every 250ms and the
 * worst gap measured inside a turn was 1.05s, so 3000ms leaves close to a 3x
 * margin and a working turn never expires the timer. It is shorter than the
 * host's 8000ms hook default, which would delay approval detection for no gain.
 *
 * The host owns the timer, the notification, and the dismissal; the plugin
 * supplies only the number.
 */
const WAITING_DETECTION: WaitingDetectionSpec = { kind: "hook-driven", quiescenceFallbackMs: 3000 };

/**
 * How the Cursor CLI realises each universal posture (APCC-FR-015).
 *
 * Every posture binds through argv alone, and each emits a distinct flag set
 * (APCC-TC-039). The mapping, checked against `agent --help`:
 *
 * - `read-only`: `--mode plan`, the read-only planning mode that makes no edits.
 * - `guarded`: `--sandbox enabled`, so every call that no rule allows prompts.
 * - `auto-edit`: `--auto-review --sandbox enabled`, where the Auto-review
 *   classifier runs the calls it judges safe and prompts for the rest.
 * - `full-auto`: `--force --sandbox disabled`, which runs everything that no
 *   rule denies.
 *
 * `--trust` is deliberately absent: it answers the workspace-trust prompt and is
 * not a permission tier. With no posture selected the host appends nothing.
 *
 * The fine-grained rules are the other axis and need a file, so `rules`
 * declares the workspace-write carrier and opts into resync: the host may
 * re-apply them to an already-created bench workspace.
 */
const PERMISSIONS_CAPABILITY: PermissionsCapability = {
  postures: {
    "read-only": { args: ["--mode", "plan"] },
    guarded: { args: ["--sandbox", "enabled"] },
    "auto-edit": { args: ["--auto-review", "--sandbox", "enabled"] },
    "full-auto": { args: ["--force", "--sandbox", "disabled"] },
  },
  rules: { carrier: "workspace-write", resync: true },
};

/**
 * Whether the selected posture carries its own `--mode` flag. The host appends
 * the posture's args after the generated argv, so the mode axis must stay silent
 * then, or the command line would hold two `--mode` flags and leave which one
 * wins to the CLI. Only `read-only` sets a mode today.
 */
function postureSetsMode(posture: AgentPosture | undefined): boolean {
  if (posture === undefined) return false;
  const args = PERMISSIONS_CAPABILITY.postures?.[posture]?.args;
  return args?.includes("--mode") ?? false;
}

/** The permissions model the host layers onto the effective config, if any. */
interface LaunchPermissions {
  posture?: AgentPosture;
  rules?: PermissionRules;
}

interface PermissionRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

const POSTURES: readonly AgentPosture[] = ["read-only", "guarded", "auto-edit", "full-auto"];

function readPermissions(value: unknown): LaunchPermissions | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      'cursor-cli agent plugin: "permissions" must be an object, but it was ' +
        `${Array.isArray(value) ? "an array" : typeof value}.`,
    );
  }
  const raw = value as { posture?: unknown; rules?: unknown };
  const posture = readPosture(raw.posture);
  const rules = readRules(raw.rules);
  return {
    ...(posture !== undefined && { posture }),
    ...(rules !== undefined && { rules }),
  };
}

function readPosture(value: unknown): AgentPosture | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && (POSTURES as readonly string[]).includes(value)) {
    return value as AgentPosture;
  }
  throw new Error(
    `cursor-cli agent plugin: "permissions.posture" must be one of ${POSTURES.join(", ")}, ` +
      `but it was ${JSON.stringify(value)}.`,
  );
}

function readRules(value: unknown): PermissionRules | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    allow: readRuleList(raw.allow),
    ask: readRuleList(raw.ask),
    deny: readRuleList(raw.deny),
  };
}

function readRuleList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Roubo rule tool names mapped onto the typed tokens the Cursor CLI accepts.
 * A rule already in Cursor form passes through; the Claude-style names map onto
 * their nearest Cursor analogue. Any other tool name (for example `WebFetch`)
 * has no Cursor analogue here, so its rule is dropped rather than written as a
 * token Cursor would reject.
 */
const CURSOR_RULE_TYPES: Readonly<Record<string, "Shell" | "Read" | "Write">> = {
  Shell: "Shell",
  Read: "Read",
  Write: "Write",
  Bash: "Shell",
  Edit: "Write",
  MultiEdit: "Write",
};

/**
 * Normalise one rule string into Cursor's typed form, or `undefined` when it
 * has no Cursor analogue. `Tool(pattern)` keeps its pattern unchanged; a bare
 * `Tool` covers every use of that tool, so it becomes `Tool(*)`.
 */
function toCursorRule(rule: string): string | undefined {
  const match = /^([A-Za-z]+)(?:\((.*)\))?$/s.exec(rule.trim());
  if (!match) return undefined;
  const type = CURSOR_RULE_TYPES[match[1]];
  if (type === undefined) return undefined;
  const pattern = match[2] ?? "*";
  return `${type}(${pattern})`;
}

function toCursorRules(rules: string[]): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    const typed = toCursorRule(rule);
    if (typed !== undefined && !out.includes(typed)) out.push(typed);
  }
  return out;
}

/**
 * The allow and deny rules as one declarative write to the bench's
 * `.cursor/cli.json`, or `undefined` when there are none (APCC-FR-016).
 *
 * Cursor's rules carry allow and deny only, and deny beats allow. There is no
 * ask tier: Cursor already prompts for anything neither allowed nor denied, so
 * an ask rule maps onto that default and is never written (APCC-TC-042).
 *
 * `unionArray` rather than `set`, because the host applies the ops against the
 * parsed existing file: any unrelated key, and any rule already in the lists,
 * survives the write (APCC-TC-041, APCC-NFR-001).
 */
function buildRulesWrite(rules: PermissionRules | undefined): WorkspaceWriteSpec | undefined {
  if (!rules) return undefined;
  const ops: WriteOp[] = [];
  const allow = toCursorRules(rules.allow);
  if (allow.length > 0) {
    ops.push({ op: "unionArray", path: "permissions.allow", values: allow });
  }
  const deny = toCursorRules(rules.deny);
  if (deny.length > 0) {
    ops.push({ op: "unionArray", path: "permissions.deny", values: deny });
  }
  if (ops.length === 0) return undefined;
  return { relPath: RULES_REL_PATH, format: "json", ops };
}
