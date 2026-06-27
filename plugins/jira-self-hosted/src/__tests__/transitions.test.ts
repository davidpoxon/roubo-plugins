import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyTransition, getAvailableTransitions } from "../transitions.js";
import { installHostHarness, StubResponse, type HostHarness } from "./helpers/host-stub.js";

const ctx = { instance: "https://jira.acme.example", pat: "tok" };

describe("transitions (TC-063 permission error)", () => {
  let harness: HostHarness;

  beforeEach(() => {
    harness = installHostHarness();
  });
  afterEach(() => harness.dispose());

  it("returns the named transitions for an issue", async () => {
    harness.fetchStub.on("/rest/api/2/issue/PROJ-1/transitions", () => ({
      transitions: [
        { id: "21", name: "Done" },
        { id: "11", name: "In Progress" },
      ],
    }));
    const names = await getAvailableTransitions(ctx, "PROJ-1");
    expect(names).toEqual(["Done", "In Progress"]);
  });

  it("posts the transition id resolved from the display name", async () => {
    const posts: Array<{ url: string; body?: string }> = [];
    harness.fetchStub.on("/rest/api/2/issue/PROJ-1/transitions", (init, url) => {
      if (init.method === "POST") {
        posts.push({ url, body: init.body });
        return ""; // 204-style success
      }
      return { transitions: [{ id: "31", name: "Done" }] };
    });
    await applyTransition(ctx, "PROJ-1", "Done");
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0].body ?? "{}");
    expect(body).toEqual({ transition: { id: "31" } });
  });

  it("surfaces the Jira permission error verbatim (TC-063)", async () => {
    const message = "Your token lacks permission to transition this workflow.";
    harness.fetchStub.on("/rest/api/2/issue/PROJ-1/transitions", (init) => {
      if (init.method === "POST") {
        return StubResponse.jiraError(403, message);
      }
      return { transitions: [{ id: "31", name: "Done" }] };
    });

    let caught: unknown = null;
    try {
      await applyTransition(ctx, "PROJ-1", "Done");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(message);
  });

  it("rejects when the requested transition isn't available", async () => {
    harness.fetchStub.on("/rest/api/2/issue/PROJ-1/transitions", () => ({
      transitions: [{ id: "31", name: "Done" }],
    }));
    await expect(applyTransition(ctx, "PROJ-1", "Won't fix")).rejects.toThrow(/not available/);
  });
});
