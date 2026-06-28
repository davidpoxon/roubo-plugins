import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JiraApiError,
  isStatusCategoryUnsupportedError,
  jiraFetch,
  type JiraRequestContext,
} from "../jira-client.js";
import { StubResponse, installHostHarness, type HostHarness } from "./helpers/host-stub.js";

const ctx: JiraRequestContext = { instance: "https://jira.acme.example", pat: "tok" };

describe("isStatusCategoryUnsupportedError", () => {
  it("matches only a 400 JQL error that names statusCategory", () => {
    expect(isStatusCategoryUnsupportedError(new Error("nope"))).toBe(false);
    expect(isStatusCategoryUnsupportedError(new JiraApiError("x", 500, "statusCategory"))).toBe(
      false,
    );
    expect(
      isStatusCategoryUnsupportedError(
        new JiraApiError("Field 'statusCategory' does not exist", 400, ""),
      ),
    ).toBe(true);
    expect(isStatusCategoryUnsupportedError(new JiraApiError("other", 400, "unrelated"))).toBe(
      false,
    );
  });
});

describe("jiraFetch", () => {
  let harness: HostHarness;
  beforeEach(() => {
    harness = installHostHarness();
  });
  afterEach(() => harness.dispose());

  it("returns undefined on a 204 No Content", async () => {
    harness.fetchStub.on("/rest/api/2/x", () => new StubResponse(204, ""));
    await expect(jiraFetch(ctx, "/rest/api/2/x")).resolves.toBeUndefined();
  });

  it("normalises a path with no leading slash and drops undefined query params", async () => {
    let seen = "";
    harness.fetchStub.on("/rest/api/2/x", (_init, url) => {
      seen = url;
      return { ok: true };
    });
    await jiraFetch(ctx, "rest/api/2/x", { query: { a: "1", b: undefined } });
    expect(seen).toBe("https://jira.acme.example/rest/api/2/x?a=1");
  });

  it("forwards the self-signed TLS opt-in on the request init", async () => {
    let allow: unknown;
    harness.fetchStub.on("/rest/api/2/x", (init) => {
      allow = (init as { allowSelfSignedTls?: boolean }).allowSelfSignedTls;
      return {};
    });
    await jiraFetch({ ...ctx, allowSelfSignedTls: true }, "/rest/api/2/x");
    expect(allow).toBe(true);
  });

  it("refuses an absolute URL that points off the configured instance", async () => {
    await expect(jiraFetch(ctx, "https://evil.example/x")).rejects.toThrow(
      /must stay on the configured Jira instance/,
    );
  });

  it("throws a structured error on a non-JSON 2xx body", async () => {
    harness.fetchStub.on("/rest/api/2/x", () => new StubResponse(200, "<html>"));
    await expect(jiraFetch(ctx, "/rest/api/2/x")).rejects.toThrow(/non-JSON response/);
  });

  describe("non-2xx error message formatting", () => {
    async function messageFor(body: string, status = 400): Promise<string> {
      harness.fetchStub.on("/rest/api/2/x", () => new StubResponse(status, body));
      try {
        await jiraFetch(ctx, "/rest/api/2/x");
      } catch (e) {
        return (e as JiraApiError).message;
      }
      throw new Error("expected jiraFetch to throw");
    }

    it("prefers errorMessages[0]", async () => {
      expect(await messageFor(JSON.stringify({ errorMessages: ["boom"] }))).toBe("boom");
    });

    it("falls back to the first string in the errors map", async () => {
      expect(await messageFor(JSON.stringify({ errors: { jql: "bad jql" } }))).toBe("bad jql");
    });

    it("ignores a non-string errors value and surfaces the raw body", async () => {
      const msg = await messageFor(JSON.stringify({ errorMessages: [], errors: { jql: 42 } }));
      expect(msg).toContain("HTTP 400");
    });

    it("uses the raw body for an HTML (non-JSON) error response", async () => {
      expect(await messageFor("<html>nope</html>")).toContain("HTTP 400");
    });

    it("uses a generic message for an empty error body", async () => {
      expect(await messageFor("")).toBe("Jira responded with HTTP 400");
    });
  });
});
