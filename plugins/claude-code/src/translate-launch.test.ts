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

describe("claude-code translateLaunch (AP-FR-017, AP-US-008)", () => {
  it("emits model, effort, and mode as separate argv tokens from the effective config (AP-TC-085)", () => {
    const config = { model: "opus", effort: "high", mode: "plan" };

    const descriptor = translateLaunch({ config, context: contextWith(config) });

    expect(descriptor).toMatchObject({
      schemaVersion: 1,
      kind: "agent-launch",
      command: "claude",
      args: [
        "--model",
        "opus",
        "--effort",
        "high",
        "--permission-mode",
        "plan",
        "--session-id",
        "{{sessionId}}",
      ],
      initialPrompt: { mode: "argv-positional", maxLength: 100_000 },
    });
  });

  // Both AgentLaunchDescriptorSchema and AgentCapabilitiesSchema are .strict()
  // host-side, so a stray or misspelled key is a launch-time validation error
  // rather than an ignored field. Pin the exact key sets so one cannot slip in.
  it("declares exactly the descriptor and capability keys the host accepts", () => {
    const withoutRules = translateLaunch({ config: {}, context: contextWith() });
    expect(Object.keys(withoutRules).sort()).toEqual([
      "args",
      "capabilities",
      "command",
      "initialPrompt",
      "kind",
      "schemaVersion",
    ]);
    expect(Object.keys(withoutRules.capabilities ?? {}).sort()).toEqual([
      "notification",
      "permissions",
      "versionProbe",
    ]);
    // PermissionsCapabilitySchema is .strict() too, so pin its keys as well.
    expect(Object.keys(withoutRules.capabilities?.permissions ?? {}).sort()).toEqual([
      "postures",
      "rules",
    ]);

    const config = { permissions: { rules: { allow: ["Bash(*)"], ask: [], deny: [] } } };
    const withRules = translateLaunch({ config, context: contextWith(config) });
    expect(Object.keys(withRules.capabilities ?? {}).sort()).toEqual([
      "notification",
      "permissions",
      "versionProbe",
      "workspaceWrites",
    ]);
  });

  it("closes argv with the stable --session-id tail the host templates (AP-TC-085)", () => {
    const { args } = translateLaunch({ config: {}, context: contextWith() });

    expect(args.slice(-2)).toEqual(["--session-id", "{{sessionId}}"]);
  });

  it("never emits the removed --enable-auto-mode: auto maps to --permission-mode auto (AP-TC-092)", () => {
    const args = buildArgs({ mode: "auto" });

    expect(args).toEqual(["--permission-mode", "auto"]);
    expect(args).not.toContain("--enable-auto-mode");
  });

  it("omits --model entirely for the account default (AP-TC-090)", () => {
    const args = buildArgs({ model: "default", effort: "high", mode: "plan" });

    expect(args).not.toContain("--model");
    expect(args).toEqual(["--effort", "high", "--permission-mode", "plan"]);
  });

  it("treats an absent field exactly like its sentinel default (AP-TC-090, AP-TC-091)", () => {
    expect(buildArgs({})).toEqual([]);
    expect(buildArgs({ model: "", mode: "", effort: "", extraArgs: "" })).toEqual([]);
  });

  it("appends extra args as discrete tokens after the generated flags (AP-TC-088)", () => {
    const args = buildArgs({
      model: "opus",
      effort: "high",
      mode: "plan",
      extraArgs: "--fallback-model sonnet --verbose",
    });

    expect(args).toEqual([
      "--model",
      "opus",
      "--effort",
      "high",
      "--permission-mode",
      "plan",
      "--fallback-model",
      "sonnet",
      "--verbose",
    ]);
    // Position matters: every generated flag precedes the first extra token.
    expect(args.indexOf("--fallback-model")).toBeGreaterThan(args.indexOf("--permission-mode"));
  });

  it("passes shell metacharacters through as literal argv tokens (AP-TC-089)", () => {
    const args = buildArgs({ extraArgs: '--foo; rm -rf $HOME "$(whoami)"' });

    expect(args).toEqual(["--foo;", "rm", "-rf", "$HOME", "$(whoami)"]);
  });

  it("appends nothing for an empty extra-args field (AP-TC-091)", () => {
    const args = buildArgs({ model: "opus", effort: "high", mode: "plan", extraArgs: "   " });

    expect(args).toEqual(["--model", "opus", "--effort", "high", "--permission-mode", "plan"]);
  });

  it.each([["low"], ["medium"], ["high"], ["xhigh"], ["max"]])(
    "maps effort %s to --effort %s (AP-TC-093)",
    (effort) => {
      expect(buildArgs({ effort })).toEqual(["--effort", effort]);
    },
  );

  it.each([["plan"], ["auto"], ["acceptEdits"], ["manual"]])(
    "maps mode %s to --permission-mode %s (AP-TC-094)",
    (mode) => {
      expect(buildArgs({ mode })).toEqual(["--permission-mode", mode]);
    },
  );

  it("omits --permission-mode for mode default, deferring to the account setting (AP-TC-094)", () => {
    expect(buildArgs({ mode: "default" })).toEqual([]);
  });

  it("omits --effort for the CLI-default sentinel, like model and mode (AP-TC-093)", () => {
    expect(buildArgs({ effort: "default" })).toEqual([]);
    expect(buildArgs({ model: "opus", effort: "default", mode: "plan" })).toEqual([
      "--model",
      "opus",
      "--permission-mode",
      "plan",
    ]);
  });

  it.each([["opus"], ["sonnet"], ["haiku"]])("maps model %s to --model %s (AP-TC-085)", (model) => {
    expect(buildArgs({ model })).toEqual(["--model", model]);
  });

  it("rejects an unrecognised model, effort, or mode with a message naming the allowed values", () => {
    expect(() => buildArgs({ model: "gpt-4" })).toThrow(
      /"model" must be one of default, opus, sonnet, haiku/,
    );
    expect(() => buildArgs({ effort: "extreme" })).toThrow(
      /"effort" must be one of default, low, medium, high, xhigh, max/,
    );
    expect(() => buildArgs({ mode: "yolo" })).toThrow(
      /"mode" must be one of default, plan, auto, acceptEdits, manual/,
    );
  });

  it("rejects a non-string extraArgs rather than coercing it", () => {
    expect(() => buildArgs({ extraArgs: ["--verbose"] })).toThrow(/"extraArgs" must be a string/);
  });
});

describe("claude-code permissions capability (AP-FR-016, AP-FR-018, AP-US-007)", () => {
  const rules = {
    allow: ["Bash(npm run *)", "Read(**)"],
    ask: ["WebFetch"],
    deny: ["Bash(rm -rf *)"],
  };

  it("declares the rules capability with the workspace-write carrier and resync (AP-TC-101)", () => {
    const { capabilities } = translateLaunch({ config: {}, context: contextWith() });

    expect(capabilities?.permissions?.rules).toEqual({
      carrier: "workspace-write",
      resync: true,
    });
  });

  it("binds every universal posture to a --permission-mode flag (AP-FR-016)", () => {
    const { capabilities } = translateLaunch({ config: {}, context: contextWith() });

    expect(capabilities?.permissions?.postures).toEqual({
      "read-only": { args: ["--permission-mode", "plan"] },
      guarded: { args: ["--permission-mode", "manual"] },
      "auto-edit": { args: ["--permission-mode", "acceptEdits"] },
      "full-auto": { args: ["--permission-mode", "auto"] },
    });
  });

  it("maps allow, deny, and ask rules onto settings.local.json arrays (AP-TC-078, AP-TC-097)", () => {
    const config = { permissions: { rules } };

    const { capabilities } = translateLaunch({ config, context: contextWith(config) });

    expect(capabilities?.workspaceWrites).toEqual([
      {
        relPath: ".claude/settings.local.json",
        format: "json",
        ops: [
          { op: "unionArray", path: "permissions.allow", values: rules.allow },
          { op: "unionArray", path: "permissions.deny", values: rules.deny },
          { op: "unionArray", path: "permissions.ask", values: rules.ask },
        ],
      },
    ]);
  });

  it("unions rather than replaces, so user-authored entries survive (AP-TC-098)", () => {
    const config = { permissions: { rules } };

    const { capabilities } = translateLaunch({ config, context: contextWith(config) });

    for (const op of capabilities?.workspaceWrites?.[0]?.ops ?? []) {
      expect(op.op).toBe("unionArray");
    }
  });

  it("declares no rules write at all when the project has no rules (AP-TC-097)", () => {
    const config = { permissions: { rules: { allow: [], ask: [], deny: [] } } };

    const { capabilities } = translateLaunch({ config, context: contextWith(config) });

    expect(capabilities?.workspaceWrites).toBeUndefined();
  });

  it("wires the notification hook into the same settings file (AP-TC-078, AP-TC-097)", () => {
    const { capabilities } = translateLaunch({ config: {}, context: contextWith() });

    expect(capabilities?.notification).toEqual({
      kind: "http-hook",
      event: "waiting",
      carrier: {
        workspaceWrite: {
          relPath: ".claude/settings.local.json",
          format: "json",
          ops: [
            {
              op: "set",
              path: "hooks.Notification",
              value: [
                {
                  hooks: [
                    {
                      type: "http",
                      url: "http://localhost:{{port}}/api/hooks/claude-notification",
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      correlation: { field: "session_id", source: "agent-native" },
    });
  });

  it("drops the config mode flag when a posture is set, so only one mode is emitted", () => {
    const config = { mode: "plan", permissions: { posture: "full-auto" } };

    const { args } = translateLaunch({ config, context: contextWith(config) });

    expect(args).toEqual(["--session-id", "{{sessionId}}"]);
  });

  it("keeps the config mode flag when the project selects no posture", () => {
    const config = { mode: "plan", permissions: { rules } };

    const { args } = translateLaunch({ config, context: contextWith(config) });

    expect(args).toEqual(["--permission-mode", "plan", "--session-id", "{{sessionId}}"]);
  });

  it("rejects an unrecognised posture rather than passing it through", () => {
    const config = { permissions: { posture: "yolo" } };

    expect(() => translateLaunch({ config, context: contextWith(config) })).toThrow(
      /"permissions.posture" must be one of read-only, guarded, auto-edit, full-auto/,
    );
  });
});

describe("version probe (AP-FR-014, AP-TC-100)", () => {
  it("declares the probe args, the parse mode, and the supported window", () => {
    const { capabilities } = translateLaunch({ config: {}, context: contextWith() });

    expect(capabilities?.versionProbe).toEqual({
      args: ["--version"],
      parse: "semver",
      minVersion: "2.1.111",
      testedCeiling: "2.1.207",
    });
  });

  it("declares the same window the manifest does, so the card and the gate agree", () => {
    const manifest = readFileSync(new URL("../roubo-plugin.yaml", import.meta.url), "utf-8");
    const { capabilities } = translateLaunch({ config: {}, context: contextWith() });

    expect(manifest).toContain(`minVersion: ${capabilities?.versionProbe?.minVersion}`);
    expect(manifest).toContain(`testedCeiling: ${capabilities?.versionProbe?.testedCeiling}`);
  });

  it("declares a manifest probe matching the descriptor's, so the card detects without launching", () => {
    const manifest = readFileSync(new URL("../roubo-plugin.yaml", import.meta.url), "utf-8");
    const { command, capabilities } = translateLaunch({ config: {}, context: contextWith() });

    // The manifest probe is what lets the AI Agents card show a detected version
    // on a bench that was never started (AP-TC-113, AP-TC-114). It must run the
    // same binary and args as the launch-time probe or the card and the gate
    // would report on two different CLIs.
    expect(manifest).toContain("probe:");
    expect(manifest).toContain(`command: ${command}`);
    for (const arg of capabilities?.versionProbe?.args ?? []) {
      expect(manifest).toContain(`- ${arg}`);
    }
    expect(manifest).toContain(`parse: ${capabilities?.versionProbe?.parse}`);
  });

  it("declares the host's whole legacy claude table, in order, so no working install regresses", () => {
    const manifest = readFileSync(new URL("../roubo-plugin.yaml", import.meta.url), "utf-8");

    // A declared list REPLACES the host's frozen `wellKnownPathsFor("claude")`
    // table rather than merging with it, so this manifest owes that table every
    // entry in its order: drop one and an install the host resolves today is
    // stranded, reorder one and a different binary wins where two are present.
    // Nothing on the host side cross-checks the two lists, so the pin lives here.
    const block = manifest.split(/^agentInstallLocations:\n/m)[1] ?? "";
    const declared: string[] = [];
    for (const line of block.split("\n")) {
      if (!line.startsWith("  - ")) break;
      declared.push(line.slice("  - ".length).trim());
    }

    expect(declared).toEqual([
      "~/.local/bin/claude",
      "~/.claude/local/claude",
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]);
  });

  it("declares the probe regardless of config, so the gate is never opted out of", () => {
    const config = { model: "opus", extraArgs: "--verbose" };
    const { capabilities } = translateLaunch({ config, context: contextWith(config) });

    expect(capabilities?.versionProbe?.minVersion).toBe("2.1.111");
  });
});
