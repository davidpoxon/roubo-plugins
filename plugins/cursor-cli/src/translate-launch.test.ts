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
    });
  });

  // AgentLaunchDescriptorSchema is .strict() host-side, so a stray key is a
  // launch-time validation error rather than an ignored field.
  it("declares exactly the descriptor keys this slice owns", () => {
    const descriptor = translateLaunch({ config: {}, context: contextWith() });

    expect(Object.keys(descriptor).sort()).toEqual([
      "args",
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

describe("cursor-cli manifest (APCC-TC-059)", () => {
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
