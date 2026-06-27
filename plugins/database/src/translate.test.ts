import { describe, expect, it } from "vitest";
import type { BenchContext } from "@roubo/plugin-sdk";
import { translate } from "./translate.js";

const context: BenchContext = {
  projectId: "proj-1",
  benchId: 2,
  componentName: "db",
  workspacePath: "/tmp/ws",
  ports: { db: 5433 },
  env: {},
};

describe("database plugin translate (CP-FR-004, CP-FR-007)", () => {
  it("maps composeFile, service, initService, portEnvVar, migration, connection, and env to a docker descriptor (AC1, CP-TC-035)", () => {
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
      context,
    });

    expect(descriptor).toEqual({
      schemaVersion: 1,
      kind: "docker",
      composeFile: "docker-compose.yml",
      service: "postgres",
      initService: "init",
      portEnvVar: "DB_PORT",
      migration: { command: "npm run migrate", args: ["--latest"] },
      connection: { template: "postgres://localhost:{{port}}/app" },
      env: { POSTGRES_PASSWORD: "secret" },
    });
  });

  it("maps a migration with no args to a command-only migration", () => {
    const descriptor = translate({
      config: {
        composeFile: "compose.yml",
        service: "postgres",
        migration: { command: "npm run migrate" },
      },
      context,
    });

    expect(descriptor.migration).toEqual({ command: "npm run migrate" });
  });

  it("carries assignedContainerId verbatim when an external container is assigned (AC3)", () => {
    const descriptor = translate({
      config: {
        composeFile: "compose.yml",
        service: "postgres",
        assignedContainerId: "ext-container-123",
      },
      context,
    });

    expect(descriptor.assignedContainerId).toBe("ext-container-123");
  });

  it("emits only the required fields for a minimal config (AC4, CP-TC-035 S002)", () => {
    const descriptor = translate({
      config: { composeFile: "compose.yml", service: "redis" },
      context,
    });

    expect(descriptor).toEqual({
      schemaVersion: 1,
      kind: "docker",
      composeFile: "compose.yml",
      service: "redis",
    });
  });

  it("omits optional fields when absent (no migration / initService / env / connection leak) (AC4)", () => {
    const descriptor = translate({
      config: { composeFile: "compose.yml", service: "redis" },
      context,
    });

    expect("initService" in descriptor).toBe(false);
    expect("portEnvVar" in descriptor).toBe(false);
    expect("migration" in descriptor).toBe(false);
    expect("connection" in descriptor).toBe(false);
    expect("env" in descriptor).toBe(false);
    expect("assignedContainerId" in descriptor).toBe(false);
  });

  it("ignores a migration object missing a command (treated as absent)", () => {
    const descriptor = translate({
      config: { composeFile: "compose.yml", service: "postgres", migration: { args: ["x"] } },
      context,
    });

    expect("migration" in descriptor).toBe(false);
  });

  it("never carries dependsOn: core owns it at the component entry level, not in config", () => {
    const descriptor = translate({
      config: { composeFile: "compose.yml", service: "postgres", dependsOn: ["cache"] },
      context,
    });

    expect("dependsOn" in descriptor).toBe(false);
  });

  it("rejects a missing composeFile with a clear error (AC5)", () => {
    expect(() => translate({ config: { service: "postgres" }, context })).toThrow(
      /a non-empty "composeFile" is required/,
    );
  });

  it("rejects an empty/whitespace composeFile with a clear error (AC5)", () => {
    expect(() =>
      translate({ config: { composeFile: "   ", service: "postgres" }, context }),
    ).toThrow(/a non-empty "composeFile" is required/);
  });

  it("rejects a non-string composeFile with a clear error (AC5)", () => {
    expect(() => translate({ config: { composeFile: 42, service: "postgres" }, context })).toThrow(
      /a non-empty "composeFile" is required/,
    );
  });

  it("rejects a missing service with a clear error (AC5)", () => {
    expect(() => translate({ config: { composeFile: "compose.yml" }, context })).toThrow(
      /a non-empty "service" is required/,
    );
  });

  it("rejects an empty service with a clear error (AC5)", () => {
    expect(() =>
      translate({ config: { composeFile: "compose.yml", service: "" }, context }),
    ).toThrow(/a non-empty "service" is required/);
  });
});
