import { describe, it, expect } from "vitest";
import { autoscrollSpeed, AUTOSCROLL_DEAD_ZONE, AUTOSCROLL_MAX_SPEED } from "../src/autoscroll.js";

describe("autoscrollSpeed", () => {
  it("is zero inside the dead zone", () => {
    expect(autoscrollSpeed(0)).toBe(0);
    expect(autoscrollSpeed(AUTOSCROLL_DEAD_ZONE)).toBe(0);
    expect(autoscrollSpeed(-AUTOSCROLL_DEAD_ZONE)).toBe(0);
  });

  it("follows the direction of the offset", () => {
    expect(autoscrollSpeed(80)).toBeGreaterThan(0);
    expect(autoscrollSpeed(-80)).toBeLessThan(0);
    expect(autoscrollSpeed(-80)).toBe(-autoscrollSpeed(80));
  });

  it("grows with distance from the origin", () => {
    expect(autoscrollSpeed(40)).toBeLessThan(autoscrollSpeed(80));
    expect(autoscrollSpeed(80)).toBeLessThan(autoscrollSpeed(200));
  });

  it("starts gently just past the dead zone", () => {
    expect(autoscrollSpeed(AUTOSCROLL_DEAD_ZONE + 5)).toBeLessThan(0.1);
  });

  it("is capped far from the origin", () => {
    expect(autoscrollSpeed(5000)).toBe(AUTOSCROLL_MAX_SPEED);
    expect(autoscrollSpeed(-5000)).toBe(-AUTOSCROLL_MAX_SPEED);
  });
});
