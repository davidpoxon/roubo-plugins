import { describe, expect, it } from "vitest";
import type { BenchContext } from "@roubo/plugin-sdk";
import { translate } from "./translate.js";

const context: BenchContext = {
  projectId: "proj-1",
  benchId: 2,
  componentName: "api",
  workspacePath: "/tmp/ws",
  ports: {},
  env: {},
};

describe("process plugin translate (CP-FR-005, CP-FR-007)", () => {
  it("maps command, setup, env, envFile, and directory to a process descriptor (AC1)", () => {
    const descriptor = translate({
      config: {
        command: "node server.js",
        setup: "npm install",
        env: { NODE_ENV: "test", PORT: "3000" },
        envFile: ".env.local",
        directory: "packages/api",
      },
      context,
    });

    expect(descriptor).toEqual({
      schemaVersion: 1,
      kind: "process",
      command: "node server.js",
      setup: "npm install",
      env: { NODE_ENV: "test", PORT: "3000" },
      envFile: ".env.local",
      cwd: "packages/api",
    });
  });

  it("never carries dependsOn: core owns it at the component entry level, not in config", () => {
    const descriptor = translate({
      config: { command: "node app.js", dependsOn: ["db", "cache"] },
      context,
    });

    // `dependsOn` placed inside `config` is ignored by translate (core models it
    // at the entry level), so it never leaks onto the descriptor.
    expect("dependsOn" in descriptor).toBe(false);
  });

  it("emits only the required command for a minimal config", () => {
    const descriptor = translate({ config: { command: "npm start" }, context });

    expect(descriptor).toEqual({
      schemaVersion: 1,
      kind: "process",
      command: "npm start",
    });
  });

  it("renames the user-facing directory key to the descriptor cwd (engine resolves it vs workspacePath)", () => {
    const descriptor = translate({
      config: { command: "node app.js", directory: "sub/dir" },
      context,
    });

    expect(descriptor.cwd).toBe("sub/dir");
    expect("directory" in descriptor).toBe(false);
  });

  it("carries env and envFile so the host injects them into the spawned environment (AC3)", () => {
    const descriptor = translate({
      config: {
        command: "node app.js",
        env: { A: "1" },
        envFile: ".env",
      },
      context,
    });

    expect(descriptor.env).toEqual({ A: "1" });
    expect(descriptor.envFile).toBe(".env");
  });

  it("omits optional fields when absent (no empty cwd/env/setup leak)", () => {
    const descriptor = translate({ config: { command: "node app.js" }, context });

    expect("cwd" in descriptor).toBe(false);
    expect("env" in descriptor).toBe(false);
    expect("envFile" in descriptor).toBe(false);
    expect("setup" in descriptor).toBe(false);
    expect("dependsOn" in descriptor).toBe(false);
  });

  it("rejects a missing command with a clear error (AC4)", () => {
    expect(() => translate({ config: {}, context })).toThrow(/a non-empty "command" is required/);
  });

  it("rejects an empty/whitespace command with a clear error (AC4)", () => {
    expect(() => translate({ config: { command: "   " }, context })).toThrow(
      /a non-empty "command" is required/,
    );
  });

  it("rejects a non-string command with a clear error (AC4)", () => {
    expect(() => translate({ config: { command: 42 }, context })).toThrow(
      /a non-empty "command" is required/,
    );
  });
});

// #836: the plugin stays a pure mapping. It copies `shell` onto the descriptor
// and the host's LifecycleEngine owns the argv-vs-shell branch.
describe("process plugin translate: shell (#836)", () => {
  it("omits shell from the descriptor when the config omits it", () => {
    const descriptor = translate({ config: { command: "npm run dev" }, context });
    expect("shell" in descriptor).toBe(false);
  });

  it("copies shell: true onto the descriptor", () => {
    const descriptor = translate({
      config: { command: "cd web && npm run dev", shell: true },
      context,
    });
    expect(descriptor.shell).toBe(true);
  });

  it("copies a string shell onto the descriptor verbatim", () => {
    const descriptor = translate({
      config: { command: "nvm use && npm run dev", shell: "zsh -i" },
      context,
    });
    expect(descriptor.shell).toBe("zsh -i");
  });

  it("drops shell: false, which is exactly the default", () => {
    const descriptor = translate({ config: { command: "npm run dev", shell: false }, context });
    expect("shell" in descriptor).toBe(false);
  });

  it("drops an empty string shell", () => {
    const descriptor = translate({ config: { command: "npm run dev", shell: "" }, context });
    expect("shell" in descriptor).toBe(false);
  });
});
