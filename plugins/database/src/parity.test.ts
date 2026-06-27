import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ComponentStatus } from "@roubo/shared";
import { DockerProvisionDescriptorSchema } from "@roubo/shared/provision-descriptor-schema";
import {
  runDescriptor,
  type DockerLike,
  type LedgerLike,
  type LifecycleContext,
  type ProcessManagerLike,
} from "../../../server/services/lifecycle-engine.js";
import { translate } from "./translate.js";

// CP-US-002: a bench database component backed by this plugin must provision,
// migrate, and reconcile identically to the built-in docker database component.
// The proof here drives the descriptor `translate()` emits through the real host
// LifecycleEngine (the same engine the built-in docker descriptor runs through)
// and asserts the resulting docker-broker calls, the merged env + allocated port
// (AC1), the resolved connection string (AC2), and the external-container path
// (AC3). The engine is the single execution path, so identical descriptors yield
// identical lifecycles by construction.

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
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-database-parity-"));
  tmpDirs.push(workspacePath);
  const pm = makeProcessManager();
  const docker = makeDocker();
  const led = makeLedger();
  const statuses: ComponentStatus[] = [];
  const ctx: LifecycleContext = {
    pluginId: "database",
    projectId: "proj1",
    benchId: 3,
    componentName: "db",
    workspacePath,
    ports: { db: 5433 },
    reportStatus: (s: ComponentStatus) => {
      statuses.push(s);
    },
    ...overrides,
  };
  return { pm, docker, led, ctx, statuses, workspacePath };
}

function ctxFor(h: Harness) {
  return {
    projectId: h.ctx.projectId,
    benchId: h.ctx.benchId,
    componentName: h.ctx.componentName,
    workspacePath: h.workspacePath,
    ports: h.ctx.ports,
    env: {},
  };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("database plugin parity (CP-US-002)", () => {
  it("emits a descriptor that validates against the host DockerProvisionDescriptorSchema", () => {
    const descriptor = translate({
      config: {
        composeFile: "docker-compose.yml",
        service: "postgres",
        initService: "init",
        portEnvVar: "DB_PORT",
        migration: { command: "npm run migrate", args: ["--latest"] },
        connection: { template: "postgres://localhost:{{port}}/app" },
        env: { POSTGRES_PASSWORD: "secret" },
      },
      context: {
        projectId: "p",
        benchId: 1,
        componentName: "db",
        workspacePath: "/tmp",
        ports: {},
        env: {},
      },
    });

    expect(() => DockerProvisionDescriptorSchema.parse(descriptor)).not.toThrow();
  });

  it("runs the full docker phase machine and resolves the connection string with the allocated port (AC1, AC2)", async () => {
    const h = setup();
    const descriptor = translate({
      config: {
        composeFile: "docker-compose.yml",
        service: "postgres",
        initService: "init",
        portEnvVar: "DB_PORT",
        migration: { command: "npm run migrate", args: ["--latest"] },
        connection: { template: "postgres://localhost:{{port}}/app" },
        env: { POSTGRES_PASSWORD: "secret" },
      },
      context: ctxFor(h),
    });

    const result = await runDescriptor(descriptor, h.ctx, {
      processManager: h.pm,
      docker: h.docker,
      ledger: h.led,
    });

    expect(result.status).toBe("running");
    // AC2: the connection template is filled with the allocated host port.
    expect(result.connection).toBe("postgres://localhost:5433/app");

    // composeUp receives the env merged with the allocated port (AC1).
    expect(h.docker.composeUp).toHaveBeenCalledWith({
      composeFile: "docker-compose.yml",
      service: "postgres",
      projectName: "roubo-proj1-bench-3",
      portOverrides: { POSTGRES_PASSWORD: "secret", DB_PORT: "5433" },
      cwd: h.workspacePath,
    });
    expect(h.docker.waitForHealthy).toHaveBeenCalledWith("roubo-proj1-bench-3", "postgres");
    expect(h.docker.composeRunInit).toHaveBeenCalledTimes(1);
    // migration runs through the injected process-manager with the merged env.
    expect(h.pm.runProcess).toHaveBeenCalledWith(
      "database:3:db:migration",
      "npm",
      ["run", "migrate", "--latest"],
      { POSTGRES_PASSWORD: "secret", DB_PORT: "5433" },
      h.workspacePath,
      300_000,
    );
    // the compose project is recorded for orphan reaping.
    expect(h.led.recordComposeProject).toHaveBeenCalledWith("database", 3, "roubo-proj1-bench-3");

    const final = h.statuses.at(-1);
    expect(final?.status).toBe("running");
  });

  it("starts a database with no migration or initService (optional fields absent) (AC4, CP-TC-051)", async () => {
    const h = setup({ componentName: "cache", ports: { cache: 6400 } });
    const descriptor = translate({
      config: { composeFile: "compose.yml", service: "redis" },
      context: ctxFor(h),
    });

    const result = await runDescriptor(descriptor, h.ctx, {
      processManager: h.pm,
      docker: h.docker,
      ledger: h.led,
    });

    expect(result.status).toBe("running");
    // defaults to HOST_PORT for the allocated port.
    expect(h.docker.composeUp).toHaveBeenCalledWith(
      expect.objectContaining({ portOverrides: { HOST_PORT: "6400" } }),
    );
    // no init service, no migration.
    expect(h.docker.composeRunInit).not.toHaveBeenCalled();
    expect(h.pm.runProcess).not.toHaveBeenCalled();
  });

  it("uses an external assigned container: skips compose, only verifies it is running (AC3)", async () => {
    const h = setup();
    const descriptor = translate({
      config: {
        composeFile: "compose.yml",
        service: "postgres",
        assignedContainerId: "ext-container-123",
        connection: { template: "postgres://localhost:{{port}}/app" },
      },
      context: ctxFor(h),
    });

    const result = await runDescriptor(descriptor, h.ctx, {
      processManager: h.pm,
      docker: h.docker,
      ledger: h.led,
    });

    expect(result.status).toBe("running");
    expect(result.connection).toBe("postgres://localhost:5433/app");
    expect(h.docker.getContainerStatusById).toHaveBeenCalledWith("ext-container-123");
    // compose is skipped: the user owns the assigned container's lifecycle.
    expect(h.docker.composeUp).not.toHaveBeenCalled();
    expect(h.docker.waitForHealthy).not.toHaveBeenCalled();
  });

  it("drives the component to error with a clear message when composeFile is missing (AC5)", () => {
    const h = setup();
    // The host validates config against the manifest configSchema before calling
    // translate, but translate is the last line of defence: a missing composeFile
    // throws a clear error rather than emitting an invalid descriptor.
    expect(() => translate({ config: { service: "postgres" }, context: ctxFor(h) })).toThrow(
      /a non-empty "composeFile" is required/,
    );
  });
});
