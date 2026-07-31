import type {
  AgentLaunchContext,
  AgentLaunchDescriptor,
  AgentPosture,
  NotificationWiring,
  PermissionsCapability,
  VersionProbeSpec,
  WaitingDetectionSpec,
} from "@roubo/plugin-sdk";
import { tokenize } from "./tokenize.js";

/** The command the host spawns. Resolved on the host PATH; never shell-interpreted. */
const COMMAND = "codex";

/**
 * The host truncates a positional prompt to this length before spawning, and
 * mirrors the Claude Code plugin's cap. Declaring `initialPrompt` at all is what
 * makes jig injection work for Codex: `argv-positional` is the only injection
 * mechanism the contract has, and the host appends the jig as the final
 * positional argument, after every generated flag (AP-FR-012, AP-TC-064).
 */
const MAX_PROMPT_LENGTH = 100_000;

/**
 * Model choices, emitted verbatim as `--model <value>` (AP-TC-086). `default` is
 * the "account default" sentinel: it emits no `--model` flag at all, so Codex
 * resolves the model from the user's own configuration.
 */
const MODELS = ["default", "gpt-5.2-codex", "gpt-5.1-codex", "gpt-5.1-codex-mini"] as const;

/** Reasoning-effort choices, emitted as `-c model_reasoning_effort=<value>` (AP-TC-108). */
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

/**
 * Approval-policy choices, emitted as `-c approval_policy=<value>` (AP-TC-107).
 * These are exactly the values Codex CLI 0.144.1 accepts on its
 * `-a/--ask-for-approval` enum (spike #502 section 2).
 */
const APPROVAL_POLICIES = ["untrusted", "on-request", "never"] as const;

/** Sandbox choices, emitted as `-c sandbox_mode=<value>` (AP-TC-107). */
const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const;

/**
 * The value each axis falls back on when the config omits it. These MUST equal
 * the manifest `configSchema` defaults, and a test asserts they do.
 *
 * The host does not seed `configSchema` defaults into the effective config: the
 * AI Agents form shows a schema default for an unsaved field, but only a saved
 * value reaches `translateLaunch`. Unlike the Claude Code plugin, whose defaults
 * are "send no flag" sentinels, the three Codex axes below default to concrete
 * values, so falling back here is what keeps the argv the form describes and the
 * argv that launches the same thing. It also keeps the approval and sandbox axes
 * off whatever `~/.codex/config.toml` happens to say, which is the safer failure
 * mode for a file Roubo does not manage.
 */
const DEFAULT_MODEL = "gpt-5.2-codex";
const DEFAULT_EFFORT = "medium";
const DEFAULT_APPROVAL_POLICY = "on-request";
const DEFAULT_SANDBOX = "workspace-write";

/**
 * Build the generated argv from the effective config: the `--model` flag, the
 * three `-c` config overrides, `--strict-config`, then the tokenized extra
 * arguments (AP-FR-017, AP-FR-020).
 *
 * Order matters and is part of the contract: the generated flags come first and
 * the user's extra tokens follow them (AP-TC-088), so an extra argument can
 * override a generated one rather than be overridden by it.
 *
 * Each flag and each value is a *separate* argv entry: `["--model",
 * "gpt-5.2-codex"]` and `["-c", "approval_policy=on-request"]`, never
 * `["--model=gpt-5.2-codex"]` and never one joined string (AP-TC-086).
 *
 * `-c` values are written unquoted (`approval_policy=on-request`, not
 * `approval_policy="on-request"`). Codex parses the value and falls back to the
 * raw string when it does not parse, so both forms reach the CLI as the same
 * string; unquoted is what AP-TC-086, AP-TC-107, and AP-TC-108 observe in the
 * assembled command line.
 *
 * `--strict-config` turns an unknown config key into a hard pre-launch error
 * rather than a silently ignored override, so a stale key map fails loudly
 * instead of launching a session with the wrong policy (spike #502 AC2). Codex's
 * *value* validation is lax by contrast (`-c model_reasoning_effort=bogus`
 * launches and echoes `bogus`), which is why every enum above is validated here.
 *
 * An absent key reads as that field's manifest default; `omitPolicyAxes` drops
 * the approval and sandbox overrides when a permission posture supplies them.
 */
export function buildArgs(
  config: Record<string, unknown>,
  opts: { omitPolicyAxes?: boolean } = {},
): string[] {
  const args: string[] = [];

  const model = readChoice(config.model, MODELS, "model", DEFAULT_MODEL);
  if (model !== "default") args.push("--model", model);

  const effort = readChoice(config.effort, EFFORTS, "effort", DEFAULT_EFFORT);
  args.push("-c", `model_reasoning_effort=${effort}`);

  // The project's permission posture, when it sets one, IS the approval policy
  // and the sandbox mode: emitting the config's values alongside it would put
  // two `approval_policy` overrides on one command line and leave which one wins
  // to the CLI (AP-TC-079).
  if (!opts.omitPolicyAxes) {
    const approvalPolicy = readChoice(
      config.approvalPolicy,
      APPROVAL_POLICIES,
      "approvalPolicy",
      DEFAULT_APPROVAL_POLICY,
    );
    args.push("-c", `approval_policy=${approvalPolicy}`);

    const sandbox = readChoice(config.sandbox, SANDBOXES, "sandbox", DEFAULT_SANDBOX);
    args.push("-c", `sandbox_mode=${sandbox}`);
  }

  args.push("--strict-config");

  const extraArgs = config.extraArgs;
  if (extraArgs !== undefined && extraArgs !== null) {
    if (typeof extraArgs !== "string") {
      throw new Error(
        'codex agent plugin: "extraArgs" must be a string, but it was ' + `${typeof extraArgs}.`,
      );
    }
    args.push(...tokenize(extraArgs));
  }

  return args;
}

/**
 * Map the effective Codex plugin config to the launch descriptor the host
 * validates and executes (AP-FR-017, AP-FR-020).
 *
 * The plugin is declarative: it emits argv and capability data, nothing else.
 * The host owns the PTY spawn, resolves `{{sessionId}}` / `{{port}}` in the argv
 * template, appends the selected posture's arguments and then the initial prompt
 * as the last positional, and defaults `cwd` to the bench workspace. Because the
 * host spawns `args` as an argv array and never through a shell, every token
 * here reaches the CLI literally (AP-TC-089).
 */
export function translateLaunch(params: {
  config: Record<string, unknown>;
  // `context` carries the host-minted `sessionId`, the bench workspace, and the
  // already-merged `effectiveConfig` (which is the same object as `config`). The
  // session id is templated rather than read, so translateLaunch stays a pure
  // mapping; `context` is part of the contract signature.
  context: AgentLaunchContext;
}): AgentLaunchDescriptor {
  const posture = readPosture(params.config.permissions);

  return {
    schemaVersion: 1,
    kind: "agent-launch",
    command: COMMAND,
    args: buildArgs(params.config, { omitPolicyAxes: posture !== undefined }),
    initialPrompt: { mode: "argv-positional", maxLength: MAX_PROMPT_LENGTH },
    capabilities: {
      notification: NOTIFICATION_WIRING,
      versionProbe: VERSION_PROBE,
      waitingDetection: WAITING_DETECTION,
      permissions: PERMISSIONS_CAPABILITY,
    },
  };
}

/**
 * Turn completion, carried by Codex's own `notify` program (AP-FR-013, spike
 * #505 recommendation 1).
 *
 * Codex has no `--session-id` analogue, so the Roubo session id cannot ride the
 * agent's own identity the way it does for Claude Code. It rides the notifier's
 * argv instead: Codex spawns the configured program on turn completion with its
 * configured arguments, then appends the event JSON as one final argument
 * (`payload: "json-arg"`), so the notifier receives the Roubo session id and the
 * payload together and correlation needs no parsing of Codex's own ids.
 *
 * Two limits worth stating plainly. `notify` fires on turn completion ONLY,
 * never on an approval prompt, which is why approval-waiting rides
 * `waitingDetection` below rather than this wiring. And the host does not
 * execute the `spawned-notifier` variant yet (nothing consumes `carrier.args`,
 * and the notifier program this names is core's to ship), so today this is a
 * forward-compatible declaration with no runtime effect: quiescence is the
 * mechanism that actually raises Codex notifications.
 *
 * A per-session `notify` override displaces any notifier the user configured in
 * their own `config.toml` for the duration of a Roubo-launched session, which
 * mirrors what the Claude Code path does to the `Notification` hook.
 */
const NOTIFICATION_WIRING: NotificationWiring = {
  kind: "spawned-notifier",
  event: "turn-complete",
  carrier: { args: ["-c", 'notify=["roubo-codex-notify","{{sessionId}}"]'] },
  payload: "json-arg",
  correlation: { source: "template", template: "{{sessionId}}" },
};

/**
 * How the host decides a Codex session is waiting on the user (AP-FR-013,
 * AP-TC-067, AP-TC-068).
 *
 * Quiescence-only, because Codex has no signal for the case that matters: an
 * approval prompt paints once and then schedules no further frames, so the PTY
 * simply goes silent (spike #505 AC2). The debounce is the plugin's to declare
 * precisely because the right number is per-agent: 3000ms leaves more than a 20x
 * margin over the worst output gap measured against Codex's animated TUI
 * (126ms over 40s at 0.144.1), so a redraw storm can never expire the timer and
 * at most one waiting notification is raised per idle period, while keeping
 * approval detection at 3s rather than inheriting Claude Code's 8000ms hook
 * fallback, which exists for a hook Codex does not have.
 *
 * Core owns the timer, the notification, and the dismissal; the plugin supplies
 * only the number.
 */
const WAITING_DETECTION: WaitingDetectionSpec = { kind: "quiescence-only", debounceMs: 3000 };

/**
 * The pre-launch version gate (AP-FR-014).
 *
 * Declarative only: the plugin says which arguments read the version and where
 * the supported window sits, and the host spawns the probe, parses the first
 * semver out of `codex-cli <version>`, and decides. The bounds mirror the
 * manifest's `agentCompatibility` block, which is what the AI Agents screen
 * renders without launching anything; these are what the launch gate enforces.
 *
 * `minVersion` is inclusive and blocking, `testedCeiling` warns only. Both
 * bracket 0.144.1, the single version spikes #502 and #505 validated.
 */
const VERSION_PROBE: VersionProbeSpec = {
  args: ["--version"],
  parse: "semver",
  minVersion: "0.144.0",
  testedCeiling: "0.144.1",
};

/**
 * How Codex realises each universal posture (AP-FR-016, AP-TC-079).
 *
 * Codex's native permission surface is two coarse axes, `approval_policy` x
 * `sandbox_mode`, so every posture binds through argv alone and nothing needs to
 * reach a settings file. The bindings are spike #502 section 5's table.
 *
 * There is deliberately NO `rules` key. Codex has no stable per-command rule
 * surface (0.144.1's `permissions.<name>` profiles and execpolicy `.rules` files
 * are undocumented and churning), and absence is first-class in the contract: it
 * hides the fine-grained rules editor for this agent and injects nothing, so a
 * project's allow/ask/deny rules are never serialized into Codex configuration
 * (AP-TC-079 S001-O02).
 */
const PERMISSIONS_CAPABILITY: PermissionsCapability = {
  postures: {
    "read-only": {
      args: ["-c", "approval_policy=untrusted", "-c", "sandbox_mode=read-only"],
    },
    guarded: {
      args: ["-c", "approval_policy=untrusted", "-c", "sandbox_mode=workspace-write"],
    },
    "auto-edit": {
      args: ["-c", "approval_policy=on-request", "-c", "sandbox_mode=workspace-write"],
    },
    "full-auto": {
      args: ["-c", "approval_policy=never", "-c", "sandbox_mode=workspace-write"],
    },
  },
};

const POSTURES: readonly AgentPosture[] = ["read-only", "guarded", "auto-edit", "full-auto"];

/**
 * The posture the host layered onto the effective config, if any.
 *
 * Only the posture axis is read. The host sends the project's fine-grained rules
 * on the same object, but this plugin declares no rules capability, so they are
 * ignored rather than mapped onto anything Codex-side.
 */
function readPosture(value: unknown): AgentPosture | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      'codex agent plugin: "permissions" must be an object, but it was ' +
        `${Array.isArray(value) ? "an array" : typeof value}.`,
    );
  }
  const raw = value as { posture?: unknown };
  if (raw.posture === undefined || raw.posture === null || raw.posture === "") return undefined;
  return parseChoice(raw.posture, POSTURES, "permissions.posture");
}

/**
 * Read one closed-choice config field. An absent (or empty) field reads as that
 * field's manifest default.
 */
function readChoice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  fallback: T,
): T {
  if (value === undefined || value === null || value === "") return fallback;
  return parseChoice(value, allowed, field);
}

/**
 * Validate one present closed-choice value. An unrecognised one is rejected with
 * a message naming the field and its allowed values, rather than being passed
 * through as an opaque argv token that Codex's lax value validation (spike #502
 * AC2) would happily accept and echo back.
 */
function parseChoice<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(
    `codex agent plugin: "${field}" must be one of ${allowed.join(", ")}, but it was ` +
      `${JSON.stringify(value)}.`,
  );
}
