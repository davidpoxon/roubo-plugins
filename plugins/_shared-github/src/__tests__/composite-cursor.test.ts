import { describe, expect, it } from "vitest";
import {
  encodeCompositeCursor,
  decodeCompositeCursor,
  type CompositeCursor,
} from "../composite-cursor.js";

describe("composite-cursor codec", () => {
  it("round-trips a per-source cursor map", () => {
    const map: CompositeCursor = { "acme/web": "2", "acme/api": "3" };
    const encoded = encodeCompositeCursor(map);
    expect(typeof encoded).toBe("string");
    expect(decodeCompositeCursor(encoded)).toEqual(map);
  });

  it("round-trips an empty map", () => {
    expect(decodeCompositeCursor(encodeCompositeCursor({}))).toEqual({});
  });

  it("decodes malformed (non-base64 / non-JSON) input to an empty map", () => {
    expect(decodeCompositeCursor("not-a-cursor!!!")).toEqual({});
  });

  it("decodes a legacy bare-numeric cursor to an empty map", () => {
    // Pre-aggregation cursors were plain page numbers like "2". They must not
    // crash; they degrade to "no active sources" so the client ends the list.
    expect(decodeCompositeCursor("2")).toEqual({});
  });

  it("decodes a base64 JSON array to an empty map (wrong shape)", () => {
    const encoded = encodeCompositeCursor({} as CompositeCursor);
    // Sanity: a real array payload is rejected.
    const arrayPayload = Buffer.from(JSON.stringify(["a", "b"]), "utf-8").toString("base64");
    expect(decodeCompositeCursor(arrayPayload)).toEqual({});
    expect(decodeCompositeCursor(encoded)).toEqual({});
  });

  it("drops non-string values while keeping string entries", () => {
    const payload = Buffer.from(
      JSON.stringify({ "acme/web": "2", "acme/api": 5, "acme/db": null }),
      "utf-8",
    ).toString("base64");
    expect(decodeCompositeCursor(payload)).toEqual({ "acme/web": "2" });
  });
});
