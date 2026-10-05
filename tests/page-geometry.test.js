import { describe, it, expect } from "vitest";
import { clientToPage, mergeLineRects, simplifyPath, hitTestMark } from "../src/page-geometry.js";

describe("clientToPage", () => {
  it("maps a point inside an unscaled box", () => {
    expect(clientToPage(110, 220, { left: 100, top: 200, width: 600, height: 800 }, 600, 800)).toEqual({ x: 10, y: 20 });
  });
  it("accounts for a zoomed on-screen box", () => {
    // page is 600x800 units shown at 2x
    expect(clientToPage(300, 500, { left: 100, top: 100, width: 1200, height: 1600 }, 600, 800)).toEqual({ x: 100, y: 200 });
  });
  it("returns finite numbers for a zero-sized box", () => {
    const p = clientToPage(5, 5, { left: 0, top: 0, width: 0, height: 0 }, 600, 800);
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });
});

describe("mergeLineRects", () => {
  it("merges adjacent rects on one line", () => {
    const out = mergeLineRects([{ x: 0, y: 0, w: 10, h: 10 }, { x: 11, y: 0, w: 10, h: 10 }]);
    expect(out).toEqual([{ x: 0, y: 0, w: 21, h: 10 }]);
  });
  it("keeps rects on different lines apart", () => {
    const out = mergeLineRects([{ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 20, w: 10, h: 10 }]);
    expect(out).toHaveLength(2);
  });
  it("drops empty rects", () => {
    expect(mergeLineRects([{ x: 0, y: 0, w: 0, h: 10 }])).toEqual([]);
  });
  it("does not merge rects separated by a wide gap", () => {
    expect(mergeLineRects([{ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: 0, w: 10, h: 10 }])).toHaveLength(2);
  });
});

describe("simplifyPath", () => {
  it("drops collinear middle points", () => {
    const out = simplifyPath([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }]);
    expect(out).toEqual([{ x: 0, y: 0 }, { x: 10, y: 10 }]);
  });
  it("keeps a real corner", () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    expect(simplifyPath(pts)).toEqual(pts);
  });
  it("returns short paths unchanged", () => {
    expect(simplifyPath([{ x: 1, y: 1 }])).toEqual([{ x: 1, y: 1 }]);
  });
});

describe("hitTestMark", () => {
  it("hits inside a highlight rect only", () => {
    const m = { type: "highlight", rects: [{ x: 10, y: 10, w: 50, h: 12 }] };
    expect(hitTestMark(m, 20, 15)).toBe(true);
    expect(hitTestMark(m, 200, 200)).toBe(false);
  });
  it("hits near an ink segment", () => {
    const m = { type: "ink", width: 2, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
    expect(hitTestMark(m, 50, 4)).toBe(true);
    expect(hitTestMark(m, 50, 40)).toBe(false);
  });
  it("hits a note's anchor box", () => {
    const m = { type: "note", x: 100, y: 100 };
    expect(hitTestMark(m, 110, 110)).toBe(true);
    expect(hitTestMark(m, 300, 300)).toBe(false);
  });
});
