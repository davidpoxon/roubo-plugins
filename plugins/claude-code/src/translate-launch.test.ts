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

    expect(descriptor).toEqual({
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
