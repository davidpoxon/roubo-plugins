import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBoardClause } from "../board-resolve.js";
import { JiraApiError } from "../jira-client.js";
import { installHostHarness, StubResponse, type HostHarness } from "./helpers/host-stub.js";

const ctx = { instance: "https://jira.acme.example", pat: "tok" };

describe("resolveBoardClause", () => {
  let harness: HostHarness;

  beforeEach(() => {
    harness = installHostHarness();
  });
  afterEach(() => harness.dispose());

  it("resolves to the active sprint by default when the board has one (TC-004)", () => {
    harness.fetchStub.on("/rest/agile/1.0/board/482/configuration", () => ({
      filter: { id: 10231 },
    }));
    harness.fetchStub.on("/rest/agile/1.0/board/482/sprint", () => ({
      values: [{ id: 99, state: "active" }],
    }));

    return expect(resolveBoardClause(ctx, "482", "active-sprint")).resolves.toBe(
      "(sprint in openSprints() AND filter = 10231)",
    );
  });

  it("resolves to the whole board's backing filter in whole-board mode (TC-031)", async () => {
    harness.fetchStub.on("/rest/agile/1.0/board/482/configuration", () => ({
      filter: { id: 10231 },
    }));

    const clause = await resolveBoardClause(ctx, "482", "whole-board");
    expect(clause).toBe("filter = 10231");
  });

  it("falls back to whole board when an active-sprint board has no active sprint", async () => {
    harness.fetchStub.on("/rest/agile/1.0/board/700/configuration", () => ({
      filter: { id: 20055 },
    }));
    harness.fetchStub.on("/rest/agile/1.0/board/700/sprint", () => ({ values: [] }));

    const clause = await resolveBoardClause(ctx, "700", "active-sprint");
    expect(clause).toBe("filter = 20055");
  });

  it("treats a kanban board's 400 from the sprint endpoint as whole-board", async () => {
    harness.fetchStub.on("/rest/agile/1.0/board/15/configuration", () => ({
      filter: { id: 30077 },
    }));
    harness.fetchStub.on(
      "/rest/agile/1.0/board/15/sprint",
      () => new StubResponse(400, JSON.stringify({ errorMessages: ["does not support sprints"] })),
    );

    const clause = await resolveBoardClause(ctx, "15", "active-sprint");
    expect(clause).toBe("filter = 30077");
  });

  it("drops the source (empty clause) when the backing filter cannot be resolved", async () => {
    harness.fetchStub.on("/rest/agile/1.0/board/9/configuration", () => ({}));

    const clause = await resolveBoardClause(ctx, "9", "whole-board");
    expect(clause).toBe("");
  });

  it("propagates non-400 errors from the sprint probe", async () => {
    harness.fetchStub.on("/rest/agile/1.0/board/482/configuration", () => ({
      filter: { id: 10231 },
    }));
    harness.fetchStub.on("/rest/agile/1.0/board/482/sprint", () => new StubResponse(500, "boom"));

    await expect(resolveBoardClause(ctx, "482", "active-sprint")).rejects.toBeInstanceOf(
      JiraApiError,
    );
  });
});
