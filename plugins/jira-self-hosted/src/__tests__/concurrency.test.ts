import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../concurrency.js";

describe("mapWithConcurrency", () => {
  it("never runs more than `limit` tasks at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await mapWithConcurrency(items, 5, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return item;
    });

    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
  });

  it("preserves input order in the result regardless of completion order", async () => {
    const items = [3, 1, 2];
    const result = await mapWithConcurrency(items, 2, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item));
      return item * 10;
    });
    expect(result).toEqual([30, 10, 20]);
  });

  it("handles an empty list without spawning workers", async () => {
    const result = await mapWithConcurrency<number, number>([], 5, async (item) => item);
    expect(result).toEqual([]);
  });
});
