import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentLaunchContext } from "@roubo/plugin-sdk";
import { buildArgs, translateLaunch } from "./translate-launch.js";

function contextWith(effectiveConfig: Record<string, unknown> = {}): AgentLaunchContext {
  return {
    projectId: "proj-1",
    benchId: 2,
    workspacePath: "/tmp/ws",
    sessionId: "11111111-2222-3333-4444-555555555555",
    effectiveConfig,
  };
}

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf-8");
}

function manifest(): string {
  return read("../roubo-plugin.yaml");
}

describe("cursor-cli translateLaunch (APCC-FR-008)", () => {
  it("emits a launch descriptor that runs the Cursor CLI (APCC-TC-032)", () => {
    const descriptor = translateLaunch({ config: {}, context: contextWith() });

    expect(descriptor).toEqual({
      schemaVersion: 1,
      kind: "agent-launch",
      command: "agent",
      args: [],
      initialPrompt: { mode: "argv-positional", maxLength: 100_000 },
      capabilities: {
        notification: expect.objectContaining({ kind: "file-notifier" }),
        waitingDetection: expect.objectContaining({ kind: "hook-driven" }),
        versionProbe: {
          args: ["--version"],
          parse: "semver",
          minVersion: "2026.09.08",
          testedCeiling: "2026.09.15",
        },
      },
    });
  });

  // AgentLaunchDescriptorSchema is .strict() host-side, so a stray key is a
  // launch-time validation error rather than an ignored field.
  it("declares exactly the descriptor keys this slice owns", () => {
    const descriptor = translateLaunch({ config: {}, context: contextWith() });

    expect(Object.keys(descriptor).sort()).toEqual([
      "args",
      "capabilities",
      "command",
      "initialPrompt",
      "kind",
      "schemaVersion",
    ]);
  });

  it("leaves cwd to the host, so the session runs in the bench worktree (APCC-TC-032)", () => {
    const descriptor = translateLaunch({ config: {}, context: contextWith() });

    expect(descriptor.cwd).toBeUndefined();
  });

  it("declares the positional jig injection with a prompt cap (APCC-TC-033, APCC-TC-034)", () => {
    const descriptor = translateLaunch({ config: {}, context: contextWith() });

    // The host appends the jig after every argv entry the plugin emits and
    // truncates it to maxLength, so the prompt is always the final positional.
    expect(descriptor.initialPrompt).toEqual({ mode: "argv-positional", maxLength: 100_000 });
  });

  it("puts the extra arguments in args, never after the prompt (APCC-TC-033)", () => {
    const config = { extraArgs: '--force --model "gpt-5 high"' };

    const descriptor = translateLaunch({ config, context: contextWith(config) });

    expect(descriptor.args).toEqual(["--force", "--model", "gpt-5 high"]);
  });

  it("is a pure mapping: the same config gives the same descriptor", () => {
    const config = { extraArgs: "--force" };

    const first = translateLaunch({ config, context: contextWith(config) });
    const second = translateLaunch({
      config,
      context: { ...contextWith(config), sessionId: "other", workspacePath: "/elsewhere" },
    });

    expect(second).toEqual(first);
    expect(config).toEqual({ extraArgs: "--force" });
  });
});

describe("cursor-cli notification wiring (APCC-FR-017)", () => {
  function wiring() {
    const notification = translateLaunch({ config: {}, context: contextWith() }).capabilities
      ?.notification;
    if (notification?.kind !== "file-notifier") {
      throw new Error(`expected a file-notifier wiring, got ${notification?.kind}`);
    }
    return notification;
  }

  it("declares exactly the capabilities this slice owns", () => {
    const { capabilities } = translateLaunch({ config: {}, context: contextWith() });

    expect(Object.keys(capabilities ?? {}).sort()).toEqual([
      "notification",
      "versionProbe",
      "waitingDetection",
    ]);
  });

  it("registers the notifier in hooks.stop of the workspace hooks file (APCC-TC-047)", () => {
    const { event, carrier } = wiring();

    expect(event).toBe("turn-complete");
    expect(carrier.workspaceWrite).toEqual({
      relPath: ".cursor/hooks.json",
      format: "json",
      ops: [
        { op: "set", path: "version", value: 1 },
        { op: "set", path: "hooks.stop", value: [{ command: "{{notifierCommand}}" }] },
      ],
    });
  });

  it("writes only the stop hook, so the user's other hooks and keys survive (APCC-TC-048)", () => {
    const { ops } = wiring().carrier.workspaceWrite;

    // Ops apply against the parsed existing file, so any path they do not
    // touch is kept. Neither op may replace the whole `hooks` object.
    expect(ops.map((op) => op.path)).toEqual(["version", "hooks.stop"]);
    expect(ops.some((op) => op.op === "delete")).toBe(false);
  });

  it("templates the correlation value rather than declaring a real one (APCC-TC-049)", () => {
    const notification = wiring();

    expect(notification.carrier.args).toEqual(["{{notifier}}", "{{sessionId}}"]);
    expect(notification.correlation).toEqual({ source: "template", template: "{{sessionId}}" });
    // The host shell-quotes and joins the args itself; the plugin never
    // builds the command string or embeds a minted id.
    expect(JSON.stringify(notification)).not.toContain(contextWith().sessionId);
  });

  it("delivers the payload on the notifier's standard input (APCC-TC-049)", () => {
    const notification = wiring();

    expect(notification.payload).toBe("json-stdin");
    // One argument after the program is the host notifier's cue to read stdin.
    expect(notification.carrier.args).toHaveLength(2);
  });

  it("keeps the same wiring whatever session the host minted", () => {
    const first = translateLaunch({ config: {}, context: contextWith() });
    const second = translateLaunch({
      config: {},
      context: { ...contextWith(), sessionId: "99999999-8888-7777-6666-555555555555" },
    });

    expect(second.capabilities).toEqual(first.capabilities);
  });

  it("declares a 3000ms quiescence fallback for when the hook never fires (APCC-TC-050)", () => {
    const { capabilities } = translateLaunch({ config: {}, context: contextWith() });

    expect(capabilities?.waitingDetection).toEqual({
      kind: "hook-driven",
      quiescenceFallbackMs: 3000,
    });
  });
});

/**
 * Order two dotted versions by their first three integer groups, which is how
 * the host's `parse: "semver"` compares them. A string compare would get
 * `2026.10.01` against `2026.9.30` wrong, so the check is numeric.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

describe("cursor-cli version probe (APCC-FR-018, APCC-NFR-003)", () => {
  it("declares the probe args, the parse mode, and the supported window (APCC-TC-052)", () => {
    const { capabilities } = translateLaunch({ config: {}, context: contextWith() });

    expect(capabilities?.versionProbe).toEqual({
      args: ["--version"],
      parse: "semver",
      minVersion: "2026.09.08",
      testedCeiling: "2026.09.15",
    });
  });

  it("declares bounds the host accepts as exact versions, with the floor below the ceiling (APCC-TC-053)", () => {
    const { capabilities } = translateLaunch({ config: {}, context: contextWith() });
    const { minVersion, testedCeiling } = capabilities?.versionProbe ?? {};

    // The host's manifest schema accepts `\d+.\d+.\d+`, leading zeros included.
    expect(minVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(testedCeiling).toMatch(/^\d+\.\d+\.\d+$/);
    expect(compareVersions(minVersion ?? "", testedCeiling ?? "")).toBeLessThan(0);
  });

  it("declares the same window the manifest does, so the card and the gate agree", () => {
    const yaml = manifest();
    const { capabilities } = translateLaunch({ config: {}, context: contextWith() });

    expect(yaml).toContain(`minVersion: ${capabilities?.versionProbe?.minVersion}`);
    expect(yaml).toContain(`testedCeiling: ${capabilities?.versionProbe?.testedCeiling}`);
  });

  it("declares a manifest probe matching the descriptor's, so the card detects without launching", () => {
    const yaml = manifest();
    const { command, capabilities } = translateLaunch({ config: {}, context: contextWith() });

    // The manifest probe lets the AI Agents card show a detected version on a
    // bench that was never started. It must run the same binary and args as the
    // launch-time probe, or the card and the gate would report on two
    // different CLIs.
    expect(yaml).toMatch(/^ {2}probe:\n {4}command: agent$/m);
    expect(yaml).toContain(`command: ${command}`);
    for (const arg of capabilities?.versionProbe?.args ?? []) {
      expect(yaml).toContain(`- ${arg}`);
    }
    expect(yaml).toContain(`parse: ${capabilities?.versionProbe?.parse}`);
  });

  it("declares the probe regardless of config, so the gate is never opted out of", () => {
    const config = { extraArgs: "--force" };

    const { capabilities } = translateLaunch({ config, context: contextWith(config) });

    expect(capabilities?.versionProbe?.minVersion).toBe("2026.09.08");
  });
});

describe("cursor-cli buildArgs", () => {
  it("appends nothing for an absent, null, or empty extra-arguments field", () => {
    expect(buildArgs({})).toEqual([]);
    expect(buildArgs({ extraArgs: null })).toEqual([]);
    expect(buildArgs({ extraArgs: "   " })).toEqual([]);
  });

  it("keeps shell metacharacters as literal tokens (APCC-NFR-001)", () => {
    expect(buildArgs({ extraArgs: '--foo; rm -rf $HOME "$(whoami)"' })).toEqual([
      "--foo;",
      "rm",
      "-rf",
      "$HOME",
      "$(whoami)",
    ]);
  });

  it("rejects a non-string extra-arguments field", () => {
    expect(() => buildArgs({ extraArgs: ["--force"] })).toThrow(
      /"extraArgs" must be a string, but it was object/,
    );
  });
});

describe("cursor-cli mode axis (APCC-FR-011)", () => {
  it("emits the mode flag for plan and ask as two separate entries (APCC-TC-026)", () => {
    expect(buildArgs({ mode: "plan" })).toEqual(["--mode", "plan"]);
    expect(buildArgs({ mode: "ask" })).toEqual(["--mode", "ask"]);
  });

  it("emits no mode flag for the agent default or an absent field (APCC-TC-026)", () => {
    expect(buildArgs({ mode: "agent" })).toEqual([]);
    expect(buildArgs({})).toEqual([]);
    expect(buildArgs({ mode: null })).toEqual([]);
    expect(buildArgs({ mode: "" })).toEqual([]);
  });

  it("rejects an unrecognised mode, naming the field and its allowed values", () => {
    expect(() => buildArgs({ mode: "print" })).toThrow(
      /"mode" must be one of agent, plan, ask, but it was "print"/,
    );
    expect(() => buildArgs({ mode: 1 })).toThrow(/"mode" must be one of agent, plan, ask/);
  });

  it("declares the same default the manifest does, so the form and the launch agree", () => {
    expect(manifest()).toMatch(/\n {4}mode:\n(?: {6}\S.*\n)*? {6}default: agent\n/);
    expect(buildArgs({})).toEqual(buildArgs({ mode: "agent" }));
  });
});

describe("cursor-cli extra arguments (APCC-FR-012)", () => {
  it("splits two space-separated arguments into two entries (APCC-TC-027)", () => {
    expect(buildArgs({ extraArgs: "--force --output-format" })).toEqual([
      "--force",
      "--output-format",
    ]);
  });

  it("keeps a quoted value with a space as one entry without its quotes (APCC-TC-027)", () => {
    expect(buildArgs({ extraArgs: '--model "gpt-5 high"' })).toEqual(["--model", "gpt-5 high"]);
    expect(buildArgs({ extraArgs: "--model 'gpt-5 high'" })).toEqual(["--model", "gpt-5 high"]);
  });

  it("puts the extra arguments after every generated flag (APCC-TC-027)", () => {
    expect(buildArgs({ mode: "plan", extraArgs: "--force" })).toEqual([
      "--mode",
      "plan",
      "--force",
    ]);
  });

  it("keeps a duplicate of a generated flag after it, so the extra one can override (APCC-TC-062)", () => {
    expect(buildArgs({ mode: "plan", extraArgs: "--mode ask" })).toEqual([
      "--mode",
      "plan",
      "--mode",
      "ask",
    ]);
  });

  it("passes a command separator through as literal entries (APCC-TC-028)", () => {
    expect(buildArgs({ extraArgs: "--force; rm -rf /" })).toEqual(["--force;", "rm", "-rf", "/"]);
    expect(buildArgs({ extraArgs: "--force && touch pwned | cat" })).toEqual([
      "--force",
      "&&",
      "touch",
      "pwned",
      "|",
      "cat",
    ]);
  });

  it("passes a shell expansion through unexpanded (APCC-TC-028)", () => {
    expect(buildArgs({ extraArgs: '--label $HOME "$(whoami)" `id`' })).toEqual([
      "--label",
      "$HOME",
      "$(whoami)",
      "`id`",
    ]);
  });
});

describe("cursor-cli worktree guard (APCC-FR-013)", () => {
  it.each([
    ["-w", "-w"],
    ["-wfeature", "-w"],
    ["--worktree", "--worktree"],
    ["--worktree feature", "--worktree"],
    ["--worktree=feature", "--worktree"],
    ["--worktree-base main", "--worktree-base"],
    ["--worktree-base=main", "--worktree-base"],
    ["--skip-worktree-setup", "--skip-worktree-setup"],
  ])(
    "refuses %j in the extra arguments, naming %s and Roubo's ownership (APCC-TC-029, APCC-TC-030)",
    (extraArgs, flag) => {
      const run = () => buildArgs({ mode: "plan", extraArgs: `--force ${extraArgs}` });

      expect(run).toThrow(`"${flag}" flag is not allowed`);
      expect(run).toThrow(/Roubo owns the worktree/);
    },
  );

  it("refuses the launch through translateLaunch too (APCC-TC-030)", () => {
    const config = { extraArgs: "-w" };

    expect(() => translateLaunch({ config, context: contextWith(config) })).toThrow(
      /"-w" flag is not allowed, because Roubo owns the worktree/,
    );
  });

  it("launches once the rejected flag is removed (APCC-TC-030)", () => {
    const config = { mode: "ask", extraArgs: "--force" };

    expect(translateLaunch({ config, context: contextWith(config) }).args).toEqual([
      "--mode",
      "ask",
      "--force",
    ]);
  });

  it("leaves flags that only resemble a worktree flag alone", () => {
    expect(buildArgs({ extraArgs: "--worktrees --no-worktree -v worktree" })).toEqual([
      "--worktrees",
      "--no-worktree",
      "-v",
      "worktree",
    ]);
  });
});

describe("cursor-cli model (APCC-FR-009)", () => {
  it("emits a selected id unchanged as one --model pair, with no brackets (APCC-TC-011)", () => {
    const config = { model: "gpt-5.3-codex-high-fast" };

    const { args } = translateLaunch({ config, context: contextWith(config) });

    expect(args).toEqual(["--model", "gpt-5.3-codex-high-fast"]);
    expect(args.filter((arg) => arg === "--model")).toHaveLength(1);
    expect(args.join(" ")).not.toMatch(/[[\]]/);
  });

  it("emits no model flag for an unset, null, or empty model (APCC-TC-015, APCC-TC-017)", () => {
    expect(buildArgs({})).toEqual([]);
    expect(buildArgs({ model: null })).toEqual([]);
    expect(buildArgs({ model: "" })).toEqual([]);
  });

  it("keeps an id with spaces or shell metacharacters as one argv entry (APCC-NFR-001)", () => {
    const model = 'odd id; rm -rf $HOME "$(whoami)"';

    expect(buildArgs({ model })).toEqual(["--model", model]);
  });

  it("puts --model ahead of the extra arguments, so an extra argument can override it", () => {
    expect(buildArgs({ model: "sonnet-4.5", extraArgs: "--model gpt-5 --force" })).toEqual([
      "--model",
      "sonnet-4.5",
      "--model",
      "gpt-5",
      "--force",
    ]);
  });

  it("rejects a non-string model", () => {
    expect(() => buildArgs({ model: 42 })).toThrow(/"model" must be a string, but it was number/);
  });

  it("orders --model ahead of --mode and both ahead of the extra arguments", () => {
    expect(buildArgs({ model: "sonnet-4.5", mode: "plan", extraArgs: "--force" })).toEqual([
      "--model",
      "sonnet-4.5",
      "--mode",
      "plan",
      "--force",
    ]);
  });
});

describe("cursor-cli manifest (APCC-TC-059)", () => {
  it("declares model as a plain string populated by the list-models probe (APCC-TC-012)", () => {
    const yaml = manifest();

    expect(yaml).toMatch(/^ {4}model:\n {6}title: Model\n {6}type: string\n {6}description: /m);
    expect(yaml).toMatch(
      /^choiceProbes:\n {2}model:\n {4}command: agent\n {4}args:\n {6}- --list-models\n {4}parse: dash-line-pairs$/m,
    );
  });

  it("declares the same version in the manifest and the package", () => {
    const pkg = JSON.parse(read("../package.json")) as { version: string };

    expect(manifest()).toMatch(new RegExp(`^version: ${pkg.version.replaceAll(".", "\\.")}$`, "m"));
  });

  it("declares an agent plugin on contract version 1 with the built entry", () => {
    const yaml = manifest();

    expect(yaml).toMatch(/^id: cursor-cli$/m);
    expect(yaml).toMatch(/^kind: agent$/m);
    expect(yaml).toMatch(/^contractVersion: 1$/m);
    expect(yaml).toMatch(/^entry: \.\/dist\/index\.js$/m);
  });

  it("declares the install location the descriptor command resolves at", () => {
    const yaml = manifest();
    const { command } = translateLaunch({ config: {}, context: contextWith() });

    expect(yaml).toMatch(/^agentInstallLocations:\n {2}- ~\/\.local\/bin\/agent$/m);
    expect(yaml).toContain(`/${command}\n`);
  });

  it("declares the process capability false", () => {
    expect(manifest()).toMatch(/^ {2}processes: false$/m);
  });

  it("declares no credential slot and no filesystem path", () => {
    const yaml = manifest();

    expect(yaml).toMatch(/^ {2}credentials:\n {4}slots: \[\]$/m);
    expect(yaml).toMatch(/^ {2}filesystem:\n {4}paths: \[\]$/m);
    expect(yaml).toMatch(/^ {2}network:\n {4}hosts: \[\]$/m);
  });

  it("registers no host client: the entry imports only defineAgentPlugin", () => {
    const entry = read("./index.ts");

    expect(entry).toContain('import { defineAgentPlugin } from "@roubo/plugin-sdk";');
    expect(entry).not.toMatch(/\bhost\b.*from "@roubo\/plugin-sdk"/);
    expect(entry).not.toMatch(/definePlugin\(|defineComponentPlugin\(/);
  });
});
