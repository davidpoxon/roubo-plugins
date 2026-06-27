import { describe, expect, it, vi } from "vitest";
import type { FetchInit, FetchResult } from "@roubo/plugin-sdk";
import { fetchCodeScanningAlert } from "../alerts/code-scanning.js";
import { fetchDependabotAlert } from "../alerts/dependabot.js";
import { fetchSecretScanningAlert } from "../alerts/secret-scanning.js";
import { mapSecretScanningAlertToNormalizedIssue } from "../mapper.js";
import { AlertPaginationError } from "../pagination.js";

function makeTransport(map: Record<string, FetchResult>) {
  return vi.fn(async (url: string, _init?: FetchInit): Promise<FetchResult> => {
    const res = map[url];
    if (!res) throw new Error(`unexpected url ${url}`);
    return res;
  });
}

const BASE = "https://api.github.com";
const CODE_URL = `${BASE}/repos/foo/bar/code-scanning/alerts/117`;
const SECRET_URL = `${BASE}/repos/foo/bar/secret-scanning/alerts/42`;
const DEP_URL = `${BASE}/repos/foo/bar/dependabot/alerts/7`;

describe("single-alert fetchers", () => {
  it("fetches a single code-scanning alert by number", async () => {
    const transport = makeTransport({
      [CODE_URL]: {
        status: 200,
        headers: {},
        body: JSON.stringify({ number: 117, html_url: "u", state: "open", created_at: "t" }),
      },
    });
    const raw = await fetchCodeScanningAlert(transport, {
      baseUrl: BASE,
      owner: "foo",
      repo: "bar",
      alertNumber: 117,
    });
    expect(raw.number).toBe(117);
    expect(transport).toHaveBeenCalledWith(CODE_URL, expect.objectContaining({ method: "GET" }));
  });

  it("fetches a single dependabot alert by number", async () => {
    const transport = makeTransport({
      [DEP_URL]: {
        status: 200,
        headers: {},
        body: JSON.stringify({ number: 7, html_url: "u", state: "open", created_at: "t" }),
      },
    });
    const raw = await fetchDependabotAlert(transport, {
      baseUrl: BASE,
      owner: "foo",
      repo: "bar",
      alertNumber: 7,
    });
    expect(raw.number).toBe(7);
  });

  it("throws a status-bearing AlertPaginationError on 403 (missing scope)", async () => {
    const transport = makeTransport({
      [CODE_URL]: { status: 403, headers: {}, body: "" },
    });
    await expect(
      fetchCodeScanningAlert(transport, {
        baseUrl: BASE,
        owner: "foo",
        repo: "bar",
        alertNumber: 117,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("throws AlertPaginationError on 404 (deleted alert)", async () => {
    const transport = makeTransport({
      [DEP_URL]: { status: 404, headers: {}, body: "" },
    });
    await expect(
      fetchDependabotAlert(transport, {
        baseUrl: BASE,
        owner: "foo",
        repo: "bar",
        alertNumber: 7,
      }),
    ).rejects.toBeInstanceOf(AlertPaginationError);
  });

  it("rejects a non-object (array) JSON body", async () => {
    const transport = makeTransport({
      [CODE_URL]: { status: 200, headers: {}, body: "[]" },
    });
    await expect(
      fetchCodeScanningAlert(transport, {
        baseUrl: BASE,
        owner: "foo",
        repo: "bar",
        alertNumber: 117,
      }),
    ).rejects.toThrow(/not a JSON object/);
  });

  it("redacts the literal secret when a single secret-scanning alert is mapped", async () => {
    const literal = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const transport = makeTransport({
      [SECRET_URL]: {
        status: 200,
        headers: {},
        body: JSON.stringify({
          number: 42,
          html_url: "u",
          state: "open",
          created_at: "t",
          secret_type: "github_pat",
          secret_type_display_name: "GitHub Personal Access Token",
          secret: literal,
        }),
      },
    });
    const raw = await fetchSecretScanningAlert(transport, {
      baseUrl: BASE,
      owner: "foo",
      repo: "bar",
      alertNumber: 42,
    });
    const issue = mapSecretScanningAlertToNormalizedIssue("github-com", "foo/bar", raw);
    expect(JSON.stringify(issue.raw)).not.toContain(literal);
    expect(issue.externalId).toBe("foo/bar#secret-scanning-42");
  });
});
