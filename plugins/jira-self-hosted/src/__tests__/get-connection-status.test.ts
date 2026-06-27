import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionStatus } from "@roubo/plugin-sdk";
import { createPluginContract } from "../plugin.js";
import { installHostHarness, StubResponse, type HostHarness } from "./helpers/host-stub.js";

describe("getConnectionStatus", () => {
  let harness: HostHarness;

  beforeEach(() => {
    harness = installHostHarness(createPluginContract());
    harness.credentials.set("pat", "test-token");
  });
  afterEach(() => {
    harness.dispose();
  });

  // The host primes setActiveConfig with the instance URL before calling
  // getConnectionStatus on a cold process; mirror that ordering here.
  async function primeConfig(): Promise<void> {
    await harness.hostConnection.sendRequest("setActiveConfig", {
      config: { instance: "https://jira.acme.example" },
    });
  }

  it("reports connected and surfaces the resolved login", async () => {
    await primeConfig();
    harness.fetchStub.on("/rest/api/2/myself", () => ({ name: "alice", displayName: "Anna" }));

    const status = await harness.hostConnection.sendRequest<ConnectionStatus>(
      "getConnectionStatus",
      {},
    );
    expect(status.state).toBe("connected");
    expect(status.account).toEqual({ login: "alice" });
    expect(typeof status.checkedAt).toBe("string");
  });

  it("reports auth-problem on a 401 from /myself", async () => {
    await primeConfig();
    harness.fetchStub.on("/rest/api/2/myself", () => new StubResponse(401, ""));

    const status = await harness.hostConnection.sendRequest<ConnectionStatus>(
      "getConnectionStatus",
      {},
    );
    expect(status.state).toBe("auth-problem");
  });

  it("reports errored on a transport failure", async () => {
    await primeConfig();
    harness.fetchStub.on("/rest/api/2/myself", () => {
      throw new Error("ECONNREFUSED");
    });

    const status = await harness.hostConnection.sendRequest<ConnectionStatus>(
      "getConnectionStatus",
      {},
    );
    expect(status.state).toBe("errored");
  });

  it("reports auth-problem when the PAT is missing", async () => {
    await primeConfig();
    harness.credentials.set("pat", "");

    const status = await harness.hostConnection.sendRequest<ConnectionStatus>(
      "getConnectionStatus",
      {},
    );
    expect(status.state).toBe("auth-problem");
  });
});
