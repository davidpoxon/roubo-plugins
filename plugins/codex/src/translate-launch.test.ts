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

function manifest(): string {
  return readFileSync(new URL("../roubo-plugin.yaml", import.meta.url), "utf-8");
}

describe("codex translateLaunch (AP-FR-020, AP-US-009)", () => {
  it("emits model, effort, approval policy, and sandbox from the effective config (AP-TC-086)", () => {
    const config = {
      model: "gpt-5.2-codex",
      effort: "medium",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    };

    const descriptor = translateLaunch({ config, context: contextWith(config) });

    expect(descriptor).toMatchObject({
      schemaVersion: 1,
      kind: "agent-launch",
      command: "codex",
      args: [
        "--model",
        "gpt-5.2-codex",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "approval_policy=on-request",
        "-c",
        "sandbox_mode=workspace-write",
        "--strict-config",
      ],
      initialPrompt: { mode: "argv-positional", maxLength: 100_000 },
    });
  });

  // Both AgentLaunchDescriptorSchema and AgentCapabilitiesSchema are .strict()
  // host-side, so a stray or misspelled key is a launch-time validation error
  // rather than an ignored field. Pin the exact key sets so one cannot slip in.
  it("declares exactly the descriptor and capability keys the host accepts", () => {
    const descriptor = translateLaunch({ config: {}, context: contextWith() });

    expect(Object.keys(descriptor).sort()).toEqual([
      "args",
      "capabilities",
      "command",
      "initialPrompt",
      "kind",
      "schemaVersion",
    ]);
    expect(Object.keys(descriptor.capabilities ?? {}).sort()).toEqual([
      "notification",
      "permissions",
      "versionProbe",
      "waitingDetection",
    ]);
    // Codex declares no workspace writes at all: every axis it maps binds
    // through argv, so nothing reaches a file in the bench workspace.
    expect(descriptor.capabilities?.workspaceWrites).toBeUndefined();
  });

  it("declares the positional jig-injection mechanism, and only that one (AP-TC-064)", () => {
    const descriptor = translateLaunch({ config: {}, context: contextWith() });

    // `argv-positional` is the only injection mechanism the contract has, and
    // declaring it is what makes the host append a bound jig to this session's
    // argv. Nothing Claude-specific (a settings-file write, a hook payload) is
    // declared, so no Claude path can carry the jig for a Codex session.
    expect(descriptor.initialPrompt).toEqual({ mode: "argv-positional", maxLength: 100_000 });
    expect(descriptor.capabilities?.workspaceWrites).toBeUndefined();
  });

  it("falls back on the manifest defaults when the config is empty (AP-TC-086)", () => {
    // The host does not seed configSchema defaults into the effective config, so
    // an unsaved form must still launch the argv the form shows. The model axis
    // defaults to the account-default sentinel, so an untouched config sends no
    // `--model` and stays launchable under either Codex auth mode.
    expect(buildArgs({})).toEqual([
      "-c",
      "model_reasoning_effort=medium",
      "-c",
      "approval_policy=on-request",
      "-c",
      "sandbox_mode=workspace-write",
      "--strict-config",
    ]);
    expect(
      buildArgs({ model: "", effort: "", approvalPolicy: "", sandbox: "", extraArgs: "" }),
    ).toEqual(buildArgs({}));
  });

  it("declares the same defaults the manifest does, so the form and the launch agree", () => {
    const yaml = manifest();

    // Anchored to the `model:` block rather than a bare substring: `default` is
    // a sentinel value another field could plausibly carry, so a loose
    // `toContain("default: default")` would not prove it is the model axis.
    expect(yaml).toMatch(/\n {4}model:\n(?: {6}\S.*\n)*? {6}default: default\n/);
    expect(yaml).toContain("default: medium");
    expect(yaml).toContain("default: on-request");
    expect(yaml).toContain("default: workspace-write");
  });

  it("omits --model entirely for the account default", () => {
    const args = buildArgs({ model: "default" });

    expect(args).not.toContain("--model");
    expect(args[0]).toBe("-c");
  });

  it.each([["minimal"], ["low"], ["medium"], ["high"], ["xhigh"]])(
    "maps reasoning effort %s to -c model_reasoning_effort=%s (AP-TC-108)",
    (effort) => {
      const args = buildArgs({ effort });

      expect(args).toContain("-c");
      expect(args).toContain(`model_reasoning_effort=${effort}`);
    },
  );

  it.each([
    ["untrusted", "read-only"],
    ["never", "danger-full-access"],
    ["on-request", "workspace-write"],
    ["untrusted", "workspace-write"],
    ["never", "read-only"],
  ])(
    "maps approval policy %s and sandbox %s to their -c overrides (AP-TC-107)",
    (approvalPolicy, sandbox) => {
      const args = buildArgs({ approvalPolicy, sandbox });

      expect(args).toContain(`approval_policy=${approvalPolicy}`);
      expect(args).toContain(`sandbox_mode=${sandbox}`);
    },
  );

  it.each([["gpt-5.2-codex"], ["gpt-5.1-codex"], ["gpt-5.1-codex-mini"]])(
    "maps model %s to --model %s (AP-TC-086, AP-TC-106)",
    (model) => {
      expect(buildArgs({ model }).slice(0, 2)).toEqual(["--model", model]);
    },
  );

  it("keeps every flag and value a separate argv entry (AP-TC-086)", () => {
    const args = buildArgs({});

    for (const arg of args) {
      expect(arg).not.toContain(" ");
    }
    expect(args.filter((a) => a === "-c")).toHaveLength(3);
  });

  it("always emits --strict-config, so an unknown config key fails before launch", () => {
    expect(buildArgs({})).toContain("--strict-config");
    expect(buildArgs({ model: "default", extraArgs: "--search" })).toContain("--strict-config");
  });

  it("appends extra args as discrete tokens after the generated flags (AP-TC-088)", () => {
    const args = buildArgs({ model: "gpt-5.1-codex", extraArgs: "--search --profile work" });

    expect(args).toEqual([
      "--model",
      "gpt-5.1-codex",
      "-c",
      "model_reasoning_effort=medium",
      "-c",
      "approval_policy=on-request",
      "-c",
      "sandbox_mode=workspace-write",
      "--strict-config",
      "--search",
      "--profile",
      "work",
    ]);
    // Position matters: every generated flag precedes the first extra token.
    expect(args.indexOf("--search")).toBeGreaterThan(args.indexOf("--strict-config"));
  });

  it("passes shell metacharacters through as literal argv tokens (AP-TC-089)", () => {
    const args = buildArgs({ model: "default", extraArgs: '--foo; rm -rf $HOME "$(whoami)"' });

    expect(args.slice(-5)).toEqual(["--foo;", "rm", "-rf", "$HOME", "$(whoami)"]);
  });

  it("appends nothing for an empty extra-args field (AP-TC-091)", () => {
    expect(buildArgs({ extraArgs: "   " })).toEqual(buildArgs({}));
  });

  it("rejects an unrecognised model, effort, approval policy, or sandbox", () => {
    expect(() => buildArgs({ model: "opus" })).toThrow(
      /"model" must be one of default, gpt-5\.2-codex, gpt-5\.1-codex, gpt-5\.1-codex-mini/,
    );
    expect(() => buildArgs({ effort: "max" })).toThrow(
      /"effort" must be one of minimal, low, medium, high, xhigh/,
    );
    expect(() => buildArgs({ approvalPolicy: "on-failure" })).toThrow(
      /"approvalPolicy" must be one of untrusted, on-request, never/,
    );
    expect(() => buildArgs({ sandbox: "full" })).toThrow(
      /"sandbox" must be one of read-only, workspace-write, danger-full-access/,
    );
  });

  it("rejects a non-string extraArgs rather than coercing it", () => {
    expect(() => buildArgs({ extraArgs: ["--search"] })).toThrow(/"extraArgs" must be a string/);
  });
});

describe("codex permissions capability (AP-FR-016, AP-TC-079)", () => {
  it("binds every universal posture to approval policy and sandbox arguments", () => {
    const { capabilities } = translateLaunch({ config: {}, context: contextWith() });

    expect(capabilities?.permissions?.postures).toEqual({
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
    });
  });

  it("declares no rules capability, which hides the rules editor (AP-TC-079 S001-O02)", () => {
    const config = {
      permissions: {
        posture: "auto-edit",
        rules: { allow: ["Bash(npm run *)"], ask: ["WebFetch"], deny: ["Bash(rm -rf *)"] },
      },
    };

    const { capabilities, args } = translateLaunch({ config, context: contextWith(config) });

    expect(capabilities?.permissions?.rules).toBeUndefined();
    expect(Object.keys(capabilities?.permissions ?? {})).toEqual(["postures"]);
    // The rules never reach Codex configuration: no workspace write, and no rule
    // string anywhere in the argv.
    expect(capabilities?.workspaceWrites).toBeUndefined();
    expect(args.join(" ")).not.toContain("Bash");
    expect(args.join(" ")).not.toContain("WebFetch");
  });

  it("drops the config approval and sandbox overrides when a posture is set (AP-TC-079)", () => {
    const config = {
      model: "gpt-5.2-codex",
      effort: "high",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      permissions: { posture: "auto-edit" },
    };

    const { args } = translateLaunch({ config, context: contextWith(config) });

    // Exactly one approval policy and one sandbox mode reach the CLI, and they
    // come from the posture (which the host appends after these args), not from
    // the config fields the posture overrides.
    expect(args).toEqual([
      "--model",
      "gpt-5.2-codex",
      "-c",
      "model_reasoning_effort=high",
      "--strict-config",
    ]);
  });

  it("keeps the config overrides when the project selects no posture", () => {
    const config = { permissions: { rules: { allow: [], ask: [], deny: [] } } };

    const { args } = translateLaunch({ config, context: contextWith(config) });

    expect(args).toContain("approval_policy=on-request");
    expect(args).toContain("sandbox_mode=workspace-write");
  });

  it("rejects an unrecognised posture rather than passing it through", () => {
    const config = { permissions: { posture: "yolo" } };

    expect(() => translateLaunch({ config, context: contextWith(config) })).toThrow(
      /"permissions.posture" must be one of read-only, guarded, auto-edit, full-auto/,
    );
  });

  it("rejects a non-object permissions model rather than ignoring it", () => {
    const config = { permissions: ["auto-edit"] };

    expect(() => translateLaunch({ config, context: contextWith(config) })).toThrow(
      /"permissions" must be an object, but it was an array/,
    );
  });
});

describe("codex waiting detection and notifications (AP-FR-013, AP-TC-067, AP-TC-068)", () => {
  it("declares quiescence-only detection with the spike-tuned per-agent debounce", () => {
    const { capabilities } = translateLaunch({ config: {}, context: contextWith() });

    expect(capabilities?.waitingDetection).toEqual({
      kind: "quiescence-only",
      debounceMs: 3000,
    });
  });

  it("declares the debounce regardless of config, so one idle period notifies once", () => {
    const config = { model: "gpt-5.1-codex", extraArgs: "--search" };

    const { capabilities } = translateLaunch({ config, context: contextWith(config) });

    expect(capabilities?.waitingDetection).toEqual({
      kind: "quiescence-only",
      debounceMs: 3000,
    });
  });

  it("wires turn completion through the spawned notifier with the session id in its argv", () => {
    const { capabilities } = translateLaunch({ config: {}, context: contextWith() });

    expect(capabilities?.notification).toEqual({
      kind: "spawned-notifier",
      event: "turn-complete",
      carrier: { args: ["-c", 'notify=["roubo-notify","{{sessionId}}"]'] },
      payload: "json-arg",
      correlation: { source: "template", template: "{{sessionId}}" },
    });
  });

  it("never declares the Claude http-hook wiring for a Codex session (AP-TC-064)", () => {
    const { capabilities } = translateLaunch({ config: {}, context: contextWith() });

    expect(capabilities?.notification?.kind).not.toBe("http-hook");
  });
});

describe("version probe (AP-FR-014)", () => {
  it("declares the probe args, the parse mode, and the supported window", () => {
    const { capabilities } = translateLaunch({ config: {}, context: contextWith() });

    expect(capabilities?.versionProbe).toEqual({
      args: ["--version"],
      parse: "semver",
      minVersion: "0.144.0",
      testedCeiling: "0.144.1",
    });
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

    // The manifest probe is what lets the AI Agents card show a detected version
    // on a bench that was never started. It must run the same binary and args as
    // the launch-time probe or the card and the gate would report on two
    // different CLIs.
    expect(yaml).toContain("probe:");
    expect(yaml).toContain(`command: ${command}`);
    for (const arg of capabilities?.versionProbe?.args ?? []) {
      expect(yaml).toContain(`- ${arg}`);
    }
    expect(yaml).toContain(`parse: ${capabilities?.versionProbe?.parse}`);
  });

  it("declares the probe regardless of config, so the gate is never opted out of", () => {
    const config = { model: "gpt-5.1-codex-mini", extraArgs: "--search" };

    const { capabilities } = translateLaunch({ config, context: contextWith(config) });

    expect(capabilities?.versionProbe?.minVersion).toBe("0.144.0");
  });
});
