import { describe, it, expect } from "vitest";
import { computeZoom } from "../src/zoom.js";

describe("computeZoom", () => {
  it("zooms in when deltaY is negative", () => {
    const result = computeZoom(1.0, -100);
    expect(result).toBeGreaterThan(1.0);
  });

  it("zooms out when deltaY is positive", () => {
    const result = computeZoom(1.0, 100);
    expect(result).toBeLessThan(1.0);
  });

  it("clamps to the maximum zoom", () => {
    const result = computeZoom(3.99, -10000, { max: 4.0 });
    expect(result).toBe(4.0);
  });

  it("clamps to the minimum zoom", () => {
    const result = computeZoom(0.26, 10000, { min: 0.25 });
    expect(result).toBe(0.25);
  });

  it("returns exactly the current zoom when deltaY is zero", () => {
    const result = computeZoom(1.5, 0);
    expect(result).toBe(1.5);
  });
});
