import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { FetchInit, FetchResult } from "@roubo/plugin-sdk";
import {
  SECURITY_EVENTS_SCOPE,
  detectTokenScopes,
  hasScope,
  scopeStatus,
} from "../token-scopes.js";

type HeaderFixture = Record<string, string>;

function loadHeaderFixtures(): Record<string, HeaderFixture> {
  const path = fileURLToPath(new URL("./fixtures/user-response-headers.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, HeaderFixture>;
}

const fixtures = loadHeaderFixtures();

function fixtureResponse(name: keyof typeof fixtures, status = 200): FetchResult {
  return {
    status,
    headers: fixtures[name] as Record<string, string | string[]>,
    body: JSON.stringify({ login: "octocat", id: 1 }),
  };
}

describe("detectTokenScopes", () => {
  it("returns the parsed scope list when X-OAuth-Scopes is present (with security_events)", async () => {
    const transport = vi.fn(
      async (): Promise<FetchResult> => fixtureResponse("with-security-events"),
    );

    const result = await detectTokenScopes(transport, "https://api.github.com");
    expect(result).toEqual({
      kind: "scopes",
      scopes: ["repo", "gist", "read:org", "security_events"],
      login: "octocat",
    });
    expect(hasScope(result, SECURITY_EVENTS_SCOPE)).toBe(true);
    expect(scopeStatus(result, SECURITY_EVENTS_SCOPE)).toBe("granted");
  });

  it("reports lacking when scopes are present but security_events is not in the list", async () => {
    const transport = vi.fn(
      async (): Promise<FetchResult> => fixtureResponse("without-security-events"),
    );

    const result = await detectTokenScopes(transport, "https://api.github.com");
    expect(result).toEqual({
      kind: "scopes",
      scopes: ["repo", "gist", "read:org"],
      login: "octocat",
    });
    expect(hasScope(result, SECURITY_EVENTS_SCOPE)).toBe(false);
    expect(scopeStatus(result, SECURITY_EVENTS_SCOPE)).toBe("lacking");
  });

  it("returns kind:'unknown' when the X-OAuth-Scopes header is missing entirely (fine-grained PAT)", async () => {
    const transport = vi.fn(async (): Promise<FetchResult> => fixtureResponse("fine-grained-pat"));

    const result = await detectTokenScopes(transport, "https://api.github.com");
    expect(result).toEqual({ kind: "unknown", login: "octocat" });
    expect(hasScope(result, SECURITY_EVENTS_SCOPE)).toBe(false);
    expect(scopeStatus(result, SECURITY_EVENTS_SCOPE)).toBe("unknown");
  });

  it("returns kind:'scopes' with an empty list when X-OAuth-Scopes is present but empty", async () => {
    const transport = vi.fn(async (): Promise<FetchResult> => fixtureResponse("empty-scopes"));

    const result = await detectTokenScopes(transport, "https://api.github.com");
    expect(result).toEqual({ kind: "scopes", scopes: [], login: "octocat" });
    expect(scopeStatus(result, SECURITY_EVENTS_SCOPE)).toBe("lacking");
  });

  it("accepts a lowercase x-oauth-scopes header key", async () => {
    const transport = vi.fn(
      async (): Promise<FetchResult> => ({
        status: 200,
        headers: { "x-oauth-scopes": "repo,security_events" },
        body: "{}",
      }),
    );

    const result = await detectTokenScopes(transport, "https://api.github.com");
    expect(result).toEqual({ kind: "scopes", scopes: ["repo", "security_events"] });
  });

  it("accepts an array-valued header (joined with commas before parsing)", async () => {
    const transport = vi.fn(
      async (): Promise<FetchResult> => ({
        status: 200,
        headers: { "X-OAuth-Scopes": ["repo", "security_events,read:org"] },
        body: "{}",
      }),
    );

    const result = await detectTokenScopes(transport, "https://api.github.com");
    expect(result).toEqual({
      kind: "scopes",
      scopes: ["repo", "security_events", "read:org"],
    });
  });

  it("returns kind:'error' with the status when /user is non-2xx (e.g. 401)", async () => {
    const transport = vi.fn(
      async (): Promise<FetchResult> => ({
        status: 401,
        headers: { "Content-Type": "application/json" },
        body: '{"message":"Bad credentials"}',
      }),
    );

    const result = await detectTokenScopes(transport, "https://api.github.com");
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.status).toBe(401);
      expect(result.detail).toMatch(/status 401/);
    }
  });

  it("returns kind:'error' when the transport itself throws, and the detail does not include the bearer token", async () => {
    const secretToken = "ghp_supersecrettoken_must_not_leak";
    const transport = vi.fn(async (): Promise<FetchResult> => {
      throw new Error("network unreachable");
    });

    const result = await detectTokenScopes(transport, "https://api.github.com", {
      headers: { Authorization: `Bearer ${secretToken}` },
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.detail).toBe("network unreachable");
      expect(result.detail).not.toContain(secretToken);
    }
  });

  it("forwards allowSelfSignedTls to the transport (used by GHE plugin)", async () => {
    const transport = vi.fn(async (_url: string, init?: FetchInit): Promise<FetchResult> => {
      expect(init?.allowSelfSignedTls).toBe(true);
      return fixtureResponse("with-security-events");
    });

    await detectTokenScopes(transport, "https://ghe.example/api/v3", {
      allowSelfSignedTls: true,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("forwards caller-supplied headers (Authorization, etc.) merged with the GitHub defaults", async () => {
    const transport = vi.fn(async (_url: string, init?: FetchInit): Promise<FetchResult> => {
      expect(init?.headers).toMatchObject({
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: "Bearer test_token",
      });
      return fixtureResponse("with-security-events");
    });

    await detectTokenScopes(transport, "https://api.github.com", {
      headers: { Authorization: "Bearer test_token" },
    });
  });

  it("treats baseUrl with and without a trailing slash as equivalent", async () => {
    const seen: string[] = [];
    const transport = vi.fn(async (url: string): Promise<FetchResult> => {
      seen.push(url);
      return fixtureResponse("with-security-events");
    });

    await detectTokenScopes(transport, "https://api.github.com");
    await detectTokenScopes(transport, "https://api.github.com/");
    expect(seen).toEqual(["https://api.github.com/user", "https://api.github.com/user"]);
  });

  it("parses the authenticated login from the /user body (same request as the scopes probe)", async () => {
    const transport = vi.fn(
      async (): Promise<FetchResult> => ({
        status: 200,
        headers: { "X-OAuth-Scopes": "repo" },
        body: JSON.stringify({ login: "monalisa", id: 7 }),
      }),
    );

    const result = await detectTokenScopes(transport, "https://api.github.com");
    expect(result).toEqual({ kind: "scopes", scopes: ["repo"], login: "monalisa" });
  });

  it("omits login when the /user body is empty, login-less, or unparseable (never throws)", async () => {
    const bodies = ["{}", '{"id":7}', "not json", ""];
    for (const body of bodies) {
      const transport = vi.fn(
        async (): Promise<FetchResult> => ({
          status: 200,
          headers: { "X-OAuth-Scopes": "repo" },
          body,
        }),
      );

      const result = await detectTokenScopes(transport, "https://api.github.com");
      expect(result).toEqual({ kind: "scopes", scopes: ["repo"] });
      expect("login" in result && result.login).toBeFalsy();
    }
  });

  it("requests GET /user against the supplied baseUrl (GHE form)", async () => {
    const transport = vi.fn(async (url: string, init?: FetchInit): Promise<FetchResult> => {
      expect(url).toBe("https://ghe.example/api/v3/user");
      expect(init?.method).toBe("GET");
      return fixtureResponse("with-security-events");
    });

    await detectTokenScopes(transport, "https://ghe.example/api/v3");
  });
});

describe("hasScope and scopeStatus", () => {
  it("hasScope returns false for unknown and error results", () => {
    expect(hasScope({ kind: "unknown" }, "security_events")).toBe(false);
    expect(hasScope({ kind: "error", detail: "boom" }, "security_events")).toBe(false);
  });

  it("scopeStatus returns 'unknown' for unknown and error results", () => {
    expect(scopeStatus({ kind: "unknown" }, "security_events")).toBe("unknown");
    expect(scopeStatus({ kind: "error", detail: "boom" }, "security_events")).toBe("unknown");
  });
});
