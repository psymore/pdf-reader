import { describe, it, expect, vi } from "vitest";
import { createAnnotationStore } from "../src/annotations.js";

const ink = (page = 1) => ({ type: "ink", page, color: "#ff0", width: 2, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] });

describe("annotation store", () => {
  it("adds marks with unique ids and groups them by page", () => {
    const s = createAnnotationStore();
    const a = s.add(ink(1));
    const b = s.add(ink(2));
    expect(a.id).not.toBe(b.id);
    expect(s.marksOnPage(1)).toEqual([a]);
    expect(s.marksOnPage(2)).toEqual([b]);
    expect(s.all()).toHaveLength(2);
  });

  it("undo removes the last add and redo restores it", () => {
    const s = createAnnotationStore();
    const a = s.add(ink());
    expect(s.undo()).toBe(true);
    expect(s.all()).toEqual([]);
    expect(s.redo()).toBe(true);
    expect(s.all()).toEqual([a]);
  });

  it("undo of an erase brings the mark back in its original position", () => {
    const s = createAnnotationStore();
    const a = s.add(ink());
    const b = s.add(ink());
    s.remove(a.id);
    expect(s.all()).toEqual([b]);
    s.undo();
    expect(s.all()).toEqual([a, b]);
  });

  it("a new action clears the redo stack", () => {
    const s = createAnnotationStore();
    s.add(ink());
    s.undo();
    s.add(ink());
    expect(s.canRedo()).toBe(false);
  });

  it("undo/redo on empty history return false and change nothing", () => {
    const s = createAnnotationStore();
    expect(s.undo()).toBe(false);
    expect(s.redo()).toBe(false);
  });

  it("remove of an unknown id is a no-op", () => {
    const s = createAnnotationStore();
    expect(s.remove("nope")).toBe(false);
    expect(s.canUndo()).toBe(false);
  });

  it("tracks dirty state and clears it on markSaved", () => {
    const s = createAnnotationStore();
    expect(s.isDirty()).toBe(false);
    s.add(ink());
    expect(s.isDirty()).toBe(true);
    s.markSaved();
    expect(s.isDirty()).toBe(false);
    s.undo();
    expect(s.isDirty()).toBe(true);
  });

  it("clear empties everything", () => {
    const s = createAnnotationStore();
    s.add(ink());
    s.clear();
    expect(s.all()).toEqual([]);
    expect(s.canUndo()).toBe(false);
    expect(s.isDirty()).toBe(false);
  });

  it("notifies subscribers with the affected pages, and unsubscribes", () => {
    const s = createAnnotationStore();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.add(ink(3));
    expect(fn).toHaveBeenLastCalledWith({ pages: new Set([3]) });
    off();
    s.add(ink(3));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
