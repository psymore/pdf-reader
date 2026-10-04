import { describe, expect, it } from "vitest";
import { computeFitZoom, computePageColumns, resolveDualPageMode } from "../src/page-layout.js";

describe("computePageColumns", () => {
  it("always keeps a dual-page pair, even when it must overflow", () => {
    expect(computePageColumns(300, 400, 16, true)).toBe(2);
  });

  it("adds gallery columns only when their page and gap fit", () => {
    expect(computePageColumns(1000, 300, 16, true)).toBe(3);
    expect(computePageColumns(931, 300, 16, true)).toBe(2);
  });

  it("keeps single-page mode to one column", () => {
    expect(computePageColumns(2000, 100, 16, false)).toBe(1);
  });

  it("does not create unused columns beyond the document page count", () => {
    expect(computePageColumns(2000, 100, 16, true, 3)).toBe(3);
  });
});

describe("computeFitZoom", () => {
  it("fits one page across the available width", () => {
    expect(computeFitZoom(800, 400, 16, false)).toBe(2);
  });

  it("fits a dual-page row including its gap", () => {
    expect(computeFitZoom(816, 400, 16, true)).toBe(1);
  });

  it("falls back to 1 for unavailable dimensions", () => {
    expect(computeFitZoom(0, 400, 16, true)).toBe(1);
  });
});

describe("resolveDualPageMode", () => {
  it("defaults mobile and tablet widths to vertical scrolling", () => {
    expect(resolveDualPageMode(390, 8)).toBe(false);
    expect(resolveDualPageMode(1200, 8)).toBe(false);
  });

  it("defaults wide desktop windows to side-by-side pages", () => {
    expect(resolveDualPageMode(1201, 8)).toBe(true);
  });

  it("respects an explicit layout choice", () => {
    expect(resolveDualPageMode(390, 8, "dual")).toBe(true);
    expect(resolveDualPageMode(1600, 8, "single")).toBe(false);
  });

  it("keeps a one-page document in vertical mode", () => {
    expect(resolveDualPageMode(1600, 1, "dual")).toBe(false);
  });
});
