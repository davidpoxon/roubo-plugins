import { describe, expect, it, vi } from "vitest";
import type { FetchInit, FetchResult } from "@roubo/plugin-sdk";
import { paginateAlerts, parseLinkHeader } from "../pagination.js";

describe("parseLinkHeader", () => {
  it("returns an empty map for undefined or empty input", () => {
    expect(parseLinkHeader(undefined)).toEqual({});
    expect(parseLinkHeader("")).toEqual({});
  });

  it("parses a single rel", () => {
    expect(parseLinkHeader('<https://api.example.com/x?page=2>; rel="next"')).toEqual({
      next: "https://api.example.com/x?page=2",
    });
  });

  it("parses multiple rels in one header value", () => {
    const header =
      '<https://api.example.com/x?page=2>; rel="next", <https://api.example.com/x?page=5>; rel="last"';
    expect(parseLinkHeader(header)).toEqual({
      next: "https://api.example.com/x?page=2",
      last: "https://api.example.com/x?page=5",
    });
  });

  it("joins repeated headers passed as an array", () => {
    expect(
      parseLinkHeader([
        '<https://api.example.com/x?page=2>; rel="next"',
        '<https://api.example.com/x?page=5>; rel="last"',
      ]),
    ).toEqual({
      next: "https://api.example.com/x?page=2",
      last: "https://api.example.com/x?page=5",
    });
  });
});

describe("paginateAlerts", () => {
  it("walks Link: rel=next until exhausted and concats pages", async () => {
    const calls: string[] = [];
    const transport = vi.fn(async (url: string, _init?: FetchInit): Promise<FetchResult> => {
      calls.push(url);
      if (url.endsWith("?state=open&per_page=2&page=1")) {
        return {
          status: 200,
          headers: {
            link: '<https://api.github.com/x?state=open&per_page=2&page=2>; rel="next"',
          },
          body: JSON.stringify([{ n: 1 }, { n: 2 }]),
        };
      }
      if (url.endsWith("page=2")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify([{ n: 3 }]),
        };
      }
      throw new Error(`unexpected url ${url}`);
    });

    const out = await paginateAlerts<{ n: number }>(
      transport,
      "https://api.github.com/x?state=open&per_page=2&page=1",
    );
    expect(out).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(calls).toHaveLength(2);
  });

  it("handles uppercase Link header keys", async () => {
    const transport = vi.fn(
      async (): Promise<FetchResult> => ({
        status: 200,
        headers: { Link: "" },
        body: "[]",
      }),
    );
    const out = await paginateAlerts<unknown>(transport, "https://api.github.com/x");
    expect(out).toEqual([]);
  });

  it("forwards allowSelfSignedTls when supplied", async () => {
    const transport = vi.fn(async (_url: string, init?: FetchInit): Promise<FetchResult> => {
      expect(init?.allowSelfSignedTls).toBe(true);
      return { status: 200, headers: {}, body: "[]" };
    });
    await paginateAlerts<unknown>(transport, "https://ghe.example/api/v3/x", {
      init: { allowSelfSignedTls: true },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("throws on non-2xx", async () => {
    const transport = vi.fn(
      async (): Promise<FetchResult> => ({
        status: 500,
        headers: {},
        body: "boom",
      }),
    );
    await expect(paginateAlerts<unknown>(transport, "https://api.github.com/x")).rejects.toThrow(
      /status 500/,
    );
  });

  it("throws when body is not a JSON array", async () => {
    const transport = vi.fn(
      async (): Promise<FetchResult> => ({
        status: 200,
        headers: {},
        body: JSON.stringify({ not: "array" }),
      }),
    );
    await expect(paginateAlerts<unknown>(transport, "https://api.github.com/x")).rejects.toThrow(
      /not a JSON array/,
    );
  });

  it("respects maxPages", async () => {
    const transport = vi.fn(
      async (url: string): Promise<FetchResult> => ({
        status: 200,
        headers: { link: `<${url}&next=1>; rel="next"` },
        body: "[]",
      }),
    );
    await paginateAlerts<unknown>(transport, "https://api.github.com/x?page=1", {
      maxPages: 3,
    });
    expect(transport).toHaveBeenCalledTimes(3);
  });
});
