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
