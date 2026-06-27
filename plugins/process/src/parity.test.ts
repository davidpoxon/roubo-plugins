import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ComponentStatus } from "@roubo/shared";
import {
  runDescriptor,
  type DockerLike,
  type LedgerLike,
  type LifecycleContext,
  type ProcessManagerLike,
} from "../../../server/services/lifecycle-engine.js";
import { translate } from "./translate.js";

// CP-US-002: a bench process component backed by this plugin must start, run,
// stop, and reconcile identically to the built-in process component. The proof
// here drives the descriptor `translate()` emits through the real host
// LifecycleEngine (the same engine the built-in process descriptor runs through)
// and asserts the resulting process-manager calls, the merged env (AC3), and the
// canonical process id (the key stop/reconcile use). The engine is the single
// execution path, so identical descriptors yield identical lifecycles by
// construction.

function makeProcessManager(): ProcessManagerLike {
  return {
    startProcess: vi.fn(async () => ({ pid: 4242 })),
    runProcess: vi.fn(async () => ({ exitCode: 0 })),
  };
}

function makeDocker(): DockerLike {
  return {
    composeUp: vi.fn(async () => ({ success: true, stdout: "", stderr: "" })),
    waitForHealthy: vi.fn(async () => true),
    composeRunInit: vi.fn(async () => ({ success: true, stdout: "", stderr: "" })),
    getContainerId: vi.fn(async () => "container-abc123"),
    getContainerStatusById: vi.fn(async () => "running" as const),
    getComposeProjectName: vi.fn(
      (projectId: string, benchId: number) => `roubo-${projectId}-bench-${benchId}`,
    ),
  };
}

function makeLedger(): LedgerLike {
  return {
    recordProcess: vi.fn(),
    recordComposeProject: vi.fn(),
  };
}

interface Harness {
  pm: ProcessManagerLike;
  docker: DockerLike;
  led: LedgerLike;
  ctx: LifecycleContext;
  statuses: ComponentStatus[];
  workspacePath: string;
}

let tmpDirs: string[] = [];

function setup(overrides: Partial<LifecycleContext> = {}): Harness {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-process-parity-"));
  tmpDirs.push(workspacePath);
  const pm = makeProcessManager();
  const docker = makeDocker();
  const led = makeLedger();
  const statuses: ComponentStatus[] = [];
  const ctx: LifecycleContext = {
    pluginId: "process",
    projectId: "proj1",
    benchId: 3,
    componentName: "api",
    workspacePath,
    ports: {},
    reportStatus: (s: ComponentStatus) => {
      statuses.push(s);
    },
    ...overrides,
  };
  return { pm, docker, led, ctx, statuses, workspacePath };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("process plugin parity (CP-US-002)", () => {
  it("starts a long-running process via the engine using the descriptor translate emits", async () => {
    const h = setup();
    const descriptor = translate({
      config: { command: "node server.js", env: { NODE_ENV: "test" } },
      context: {
        projectId: h.ctx.projectId,
        benchId: h.ctx.benchId,
        componentName: h.ctx.componentName,
        workspacePath: h.workspacePath,
        ports: {},
        env: {},
      },
    });

    const result = await runDescriptor(descriptor, h.ctx, {
      processManager: h.pm,
      docker: h.docker,
      ledger: h.led,
    });

    expect(result.status).toBe("running");
    // Canonical process id `${pluginId}:${benchId}:${componentName}`: stop and
    // reconcile key off this same id, so identical to the built-in component.
    expect(h.pm.startProcess).toHaveBeenCalledWith(
      "process:3:api",
      "node",
      ["server.js"],
      { NODE_ENV: "test" },
      h.workspacePath,
    );
    expect(h.led.recordProcess).toHaveBeenCalledWith("process", 3, "process:3:api");
    const final = h.statuses.at(-1);
    expect(final?.status).toBe("running");
    expect(final?.pid).toBe(4242);
  });

  it("runs one-time setup before starting, and skips it on a Stop -> Start cycle (reconcile parity)", async () => {
    const first = setup();
    const config = { command: "node server.js", setup: "npm install" };

    await runDescriptor(translate({ config, context: ctxFor(first) }), first.ctx, {
      processManager: first.pm,
      docker: first.docker,
      ledger: first.led,
    });

    // First start runs setup to completion then starts the process.
    expect(first.pm.runProcess).toHaveBeenCalledWith(
      "process:3:api:setup",
      "npm",
      ["install"],
      {},
      first.workspacePath,
      0,
    );
    expect(first.pm.startProcess).toHaveBeenCalledTimes(1);

    // A Stop -> Start cycle (setupComplete already true) skips setup, exactly
    // like the built-in process component.
    const second = setup({ setupComplete: true });
    await runDescriptor(translate({ config, context: ctxFor(second) }), second.ctx, {
      processManager: second.pm,
      docker: second.docker,
      ledger: second.led,
    });
    expect(second.pm.runProcess).not.toHaveBeenCalled();
    expect(second.pm.startProcess).toHaveBeenCalledTimes(1);
  });

  it("injects env and envFile values into the spawned process environment (AC3)", async () => {
    const h = setup();
    fs.writeFileSync(
      path.join(h.workspacePath, ".env"),
      "FROM_FILE=file-value\nSHARED=from-file\n",
      "utf8",
    );

    const descriptor = translate({
      config: {
        command: "node app.js",
        env: { FROM_ENV: "env-value", SHARED: "from-env" },
        envFile: ".env",
      },
      context: ctxFor(h),
    });

    await runDescriptor(descriptor, h.ctx, {
      processManager: h.pm,
      docker: h.docker,
      ledger: h.led,
    });

    expect(h.pm.startProcess).toHaveBeenCalledWith(
      "process:3:api",
      "node",
      ["app.js"],
      // envFile is merged in; explicit env wins on the conflicting SHARED key.
      { FROM_FILE: "file-value", FROM_ENV: "env-value", SHARED: "from-env" },
      h.workspacePath,
    );
  });

  it("resolves the directory key against the workspace as the process cwd", async () => {
    const h = setup();
    const subdir = path.join(h.workspacePath, "services", "api");
    fs.mkdirSync(subdir, { recursive: true });

    const descriptor = translate({
      config: { command: "node app.js", directory: "services/api" },
      context: ctxFor(h),
    });

    await runDescriptor(descriptor, h.ctx, {
      processManager: h.pm,
      docker: h.docker,
      ledger: h.led,
    });

    expect(h.pm.startProcess).toHaveBeenCalledWith("process:3:api", "node", ["app.js"], {}, subdir);
  });

  it("drives the component to error with a clear message when command is empty (AC4)", async () => {
    const h = setup();
    // The host validates config against the manifest configSchema before
    // calling translate, but translate is the last line of defence: a missing
    // command throws a clear error rather than emitting an invalid descriptor.
    expect(() => translate({ config: {}, context: ctxFor(h) })).toThrow(
      /a non-empty "command" is required/,
    );
  });
});

function ctxFor(h: Harness) {
  return {
    projectId: h.ctx.projectId,
    benchId: h.ctx.benchId,
    componentName: h.ctx.componentName,
    workspacePath: h.workspacePath,
    ports: {},
    env: {},
  };
}
