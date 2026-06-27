import { vi, type Mock } from "vitest";
import type { FetchInit, FetchResult, HostClient } from "@roubo/plugin-sdk";
import { bindHost, resetHostBinding } from "../host-binding.js";
import { __setOctokitForTests, resetOctokit, type OctokitLike } from "../octokit-factory.js";
import { __setSleepForTests, resetCaches } from "../github-request.js";
import { setActiveConfig } from "../active-config.js";

export interface MockHost {
  host: HostClient;
  fetch: Mock<(url: string, init?: FetchInit) => Promise<FetchResult>>;
  credentialsGet: Mock<(slot: string) => Promise<string | null>>;
  credentialsSet: Mock<(slot: string, value: string) => Promise<void>>;
  loggerInfo: Mock;
  loggerWarn: Mock;
  loggerError: Mock;
}

export function buildMockHost(initialToken: string | null = "ghp_test_token"): MockHost {
  const fetchMock = vi.fn<(url: string, init?: FetchInit) => Promise<FetchResult>>(async () => {
    throw new Error("[test] host.fetch invoked without a queued response");
  });
  const credentialsGet = vi.fn<(slot: string) => Promise<string | null>>(async () => initialToken);
  const credentialsSet = vi.fn<(slot: string, value: string) => Promise<void>>(
    async () => undefined,
  );
  const loggerInfo = vi.fn();
  const loggerWarn = vi.fn();
  const loggerError = vi.fn();

  const host: HostClient = {
    fetch: fetchMock as unknown as HostClient["fetch"],
    credentials: {
      get: credentialsGet as unknown as HostClient["credentials"]["get"],
      set: credentialsSet as unknown as HostClient["credentials"]["set"],
    },
    logger: {
      info: loggerInfo as unknown as HostClient["logger"]["info"],
      warn: loggerWarn as unknown as HostClient["logger"]["warn"],
      error: loggerError as unknown as HostClient["logger"]["error"],
    },
  };

  return {
    host,
    fetch: fetchMock,
    credentialsGet,
    credentialsSet,
    loggerInfo,
    loggerWarn,
    loggerError,
  };
}

export interface MockOctokit {
  request: Mock;
  graphql: Mock;
  client: OctokitLike;
}

export function buildMockOctokit(): MockOctokit {
  const request = vi.fn();
  const graphql = vi.fn();
  return {
    request,
    graphql,
    client: {
      request: request as unknown as OctokitLike["request"],
      graphql: graphql as unknown as OctokitLike["graphql"],
    },
  };
}

/**
 * Install a fresh mock host + mock Octokit and pre-seed a plugin-wide active
 * config (instance, TLS) so the Octokit factory can resolve a baseUrl when
 * source-bound methods run. Mock Octokit short-circuits the host-fetch
 * adapter so tests verify githubRequest behaviour directly without Octokit's
 * built-in retry / throttling plugins pre-empting the manual backoff layer.
 */
export function installMocks(): { mockHost: MockHost; mockOctokit: MockOctokit } {
  const mockHost = buildMockHost();
  const mockOctokit = buildMockOctokit();
  resetCaches();
  resetOctokit();
  resetHostBinding();
  setActiveConfig({ instance: "https://ghe.example.com", allowSelfSignedTls: false });
  bindHost(mockHost.host);
  __setOctokitForTests(mockOctokit.client);
  return { mockHost, mockOctokit };
}

export function teardownMocks(): void {
  resetCaches();
  resetOctokit();
  resetHostBinding();
  setActiveConfig(null);
  __setOctokitForTests(null);
  __setSleepForTests((ms) => new Promise((r) => setTimeout(r, ms)));
}

export function okResponse<T>(
  data: T,
  headers: Record<string, string> = {},
  status = 200,
): { data: T; headers: Record<string, string>; status: number } {
  return { data, headers, status };
}
