import { describe, it, expect } from "vitest";
import {
  DOCX_MAX_ZOOM,
  DOCX_MIN_ZOOM,
  clampDocxZoom,
  fitDocxZoom,
  pinchDocxZoom,
  stepDocxZoom,
} from "../src/docx-zoom.js";

describe("clampDocxZoom", () => {
  it("keeps zoom within bounds", () => {
    expect(clampDocxZoom(10)).toBe(DOCX_MAX_ZOOM);
    expect(clampDocxZoom(0.01)).toBe(DOCX_MIN_ZOOM);
    expect(clampDocxZoom(1.5)).toBe(1.5);
  });
});

describe("stepDocxZoom", () => {
  it("zooms in and back out symmetrically", () => {
    expect(stepDocxZoom(1, 1)).toBeCloseTo(1.2);
    expect(stepDocxZoom(1.2, -1)).toBeCloseTo(1);
  });

  it("stops at the bounds", () => {
    expect(stepDocxZoom(DOCX_MAX_ZOOM, 1)).toBe(DOCX_MAX_ZOOM);
    expect(stepDocxZoom(DOCX_MIN_ZOOM, -1)).toBe(DOCX_MIN_ZOOM);
  });
});

describe("fitDocxZoom", () => {
  it("shrinks a page that is wider than the screen", () => {
    expect(fitDocxZoom(400, 800)).toBe(0.5);
  });

  it("never enlarges past 100%", () => {
    expect(fitDocxZoom(1600, 800)).toBe(1);
  });

  it("falls back to 100% for unmeasurable sizes", () => {
    expect(fitDocxZoom(0, 800)).toBe(1);
    expect(fitDocxZoom(400, 0)).toBe(1);
    expect(fitDocxZoom(Number.NaN, 800)).toBe(1);
  });

  it("does not go below the minimum zoom", () => {
    expect(fitDocxZoom(50, 1000)).toBe(DOCX_MIN_ZOOM);
  });
});

describe("pinchDocxZoom", () => {
  it("scales by the change in finger distance", () => {
    expect(pinchDocxZoom(1, 100, 200)).toBe(2);
  });

  it("clamps the result", () => {
    expect(pinchDocxZoom(2, 100, 10)).toBe(DOCX_MIN_ZOOM);
  });

  it("ignores a zero start distance", () => {
    expect(pinchDocxZoom(1, 0, 200)).toBe(1);
  });
});
