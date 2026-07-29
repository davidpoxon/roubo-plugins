import type {
  AgentLaunchContext,
  AgentLaunchDescriptor,
  AgentPosture,
  NotificationWiring,
  PermissionsCapability,
  VersionProbeSpec,
  WorkspaceWriteSpec,
  WriteOp,
} from "@roubo/plugin-sdk";
import { tokenize } from "./tokenize.js";

/** The command the host spawns. Resolved on the host PATH; never shell-interpreted. */
const COMMAND = "claude";

/** The workspace file Claude Code reads its per-project settings from. */
const SETTINGS_REL_PATH = ".claude/settings.local.json";

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

/**
 * Reasoning-effort choices, each emitted verbatim as `--effort <value>`
 * (AP-TC-093). As with `model` and `mode`, `default` is a sentinel rather than
 * a level: it emits no `--effort` flag and defers to the CLI's own default.
 */
const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"] as const;

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
export function buildArgs(
  config: Record<string, unknown>,
  opts: { omitMode?: boolean } = {},
): string[] {
  const args: string[] = [];

  const model = readChoice(config.model, MODELS, "model");
  if (model !== undefined && model !== "default") args.push("--model", model);

  const effort = readChoice(config.effort, EFFORTS, "effort");
  if (effort !== undefined && effort !== "default") args.push("--effort", effort);

  // The project's permission posture, when it sets one, IS the permission mode:
  // emitting the config's `mode` alongside it would put two --permission-mode
  // flags on one command line and leave which one wins to the CLI.
  const mode = opts.omitMode ? undefined : readChoice(config.mode, MODES, "mode");
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
  const permissions = readPermissions(params.config.permissions);
  const rulesWrite = buildRulesWrite(permissions?.rules);

  return {
    schemaVersion: 1,
    kind: "agent-launch",
    command: COMMAND,
    // The stable tail: `--session-id <uuid>` closes the generated argv, and the
    // host appends the initial prompt (if any) after it as the last positional.
    args: [
      ...buildArgs(params.config, { omitMode: permissions?.posture !== undefined }),
      "--session-id",
      "{{sessionId}}",
    ],
    initialPrompt: { mode: "argv-positional", maxLength: MAX_PROMPT_LENGTH },
    capabilities: {
      // The rules write comes first so a fresh settings file gets `permissions`
      // before `hooks`, byte-for-byte what the built-in integration produces
      // for the same inputs (AP-TC-097).
      ...(rulesWrite !== undefined && { workspaceWrites: [rulesWrite] }),
      notification: NOTIFICATION_WIRING,
      versionProbe: VERSION_PROBE,
      permissions: PERMISSIONS_CAPABILITY,
    },
  };
}

/**
 * Roubo's notification endpoint, registered on every session start (AP-TC-078
 * S002-O02, AP-TC-097 S002-O02).
 *
 * Catch-all with no matcher, so every Notification event Claude Code emits POSTs
 * back to the host, and correlated on the CLI's own `session_id` (which is the
 * uuid the host handed it as `--session-id`). `Notification` is SET rather than
 * unioned: the host's endpoint must be registered outright, so a stale
 * registration can never survive. The built-in writer replaces the whole `hooks`
 * object; this write touches only `Notification` and leaves other hook events in
 * place, which is what AP-TC-098 asks for (only Roubo-managed keys are touched).
 */
const NOTIFICATION_WIRING: NotificationWiring = {
  kind: "http-hook",
  event: "waiting",
  carrier: {
    workspaceWrite: {
      relPath: SETTINGS_REL_PATH,
      format: "json",
      ops: [
        {
          op: "set",
          path: "hooks.Notification",
          value: [
            {
              hooks: [
                { type: "http", url: "http://localhost:{{port}}/api/hooks/claude-notification" },
              ],
            },
          ],
        },
      ],
    },
  },
  correlation: { field: "session_id", source: "agent-native" },
};

/**
 * The pre-launch version gate (AP-FR-014, issue #519).
 *
 * Declarative only: the plugin says which arguments read the version and where
 * the supported window sits, and the host spawns the probe, parses the first
 * semver out of the output, and decides. The bounds mirror the manifest's
 * `agentCompatibility` block, which is what the AI Agents screen renders without
 * launching anything; these are what the launch gate itself enforces.
 *
 * `minVersion` is inclusive and blocking: below 2.1.111 the CLI predates
 * `--permission-mode auto`, so every posture this plugin declares would land on
 * a flag value the CLI rejects. `testedCeiling` never blocks, because the CLI
 * ships weekly and refusing to launch on an unrecognised newer version would age
 * worse than a warning does.
 */
const VERSION_PROBE: VersionProbeSpec = {
  args: ["--version"],
  parse: "semver",
  minVersion: "2.1.111",
  testedCeiling: "2.1.207",
};

/**
 * How Claude Code realises each universal posture (AP-FR-016).
 *
 * Every posture binds through argv alone: Claude Code's native mechanism for
 * this axis is `--permission-mode`, so nothing needs to reach a settings file.
 * The fine-grained rules are the other axis, and they DO need a file, which is
 * why `rules` declares the workspace-write carrier and opts into resync: the
 * host may re-inject them into an already-created bench workspace.
 */
const PERMISSIONS_CAPABILITY: PermissionsCapability = {
  postures: {
    "read-only": { args: ["--permission-mode", "plan"] },
    guarded: { args: ["--permission-mode", "manual"] },
    "auto-edit": { args: ["--permission-mode", "acceptEdits"] },
    "full-auto": { args: ["--permission-mode", "auto"] },
  },
  rules: { carrier: "workspace-write", resync: true },
};

/** The permissions model the host layers onto the effective config, if any. */
interface LaunchPermissions {
  posture?: AgentPosture;
  rules?: { allow: string[]; ask: string[]; deny: string[] };
}

const POSTURES: readonly AgentPosture[] = ["read-only", "guarded", "auto-edit", "full-auto"];

function readPermissions(value: unknown): LaunchPermissions | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      'claude-code agent plugin: "permissions" must be an object, but it was ' +
        `${Array.isArray(value) ? "an array" : typeof value}.`,
    );
  }
  const raw = value as { posture?: unknown; rules?: unknown };
  const posture =
    raw.posture === undefined || raw.posture === null
      ? undefined
      : readChoice(raw.posture, POSTURES, "permissions.posture");
  const rules = readRules(raw.rules);
  return {
    ...(posture !== undefined && { posture }),
    ...(rules !== undefined && { rules }),
  };
}

function readRules(value: unknown): { allow: string[]; ask: string[]; deny: string[] } | undefined {
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
 * The allow/deny/ask rules as one declarative settings write, or `undefined`
 * when there are none.
 *
 * `unionArray` rather than `set`, because the workspace file is shared with the
 * user: rules Claude Code itself persisted when the user granted something
 * in-session, and any hand-written entry, survive the merge (AP-TC-098). It also
 * means removing a project rule never rewrites a bench, which matches the
 * built-in behaviour: a removal takes effect when the bench is cleared.
 *
 * Array order is allow, deny, ask: the order the built-in writer emits, so a
 * fresh file is identical either way (AP-TC-097 S002-O03).
 */
function buildRulesWrite(
  rules: { allow: string[]; ask: string[]; deny: string[] } | undefined,
): WorkspaceWriteSpec | undefined {
  if (!rules) return undefined;
  const ops: WriteOp[] = [];
  if (rules.allow.length > 0) {
    ops.push({ op: "unionArray", path: "permissions.allow", values: rules.allow });
  }
  if (rules.deny.length > 0) {
    ops.push({ op: "unionArray", path: "permissions.deny", values: rules.deny });
  }
  if (rules.ask.length > 0) {
    ops.push({ op: "unionArray", path: "permissions.ask", values: rules.ask });
  }
  if (ops.length === 0) return undefined;
  return { relPath: SETTINGS_REL_PATH, format: "json", ops };
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
