# PDF Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user highlight, draw, add text notes, erase and undo/redo on an open PDF, and save the result as a new PDF with real embedded annotations.

**Architecture:** Marks live in a pure data model (`annotations.js`) in page units (viewer scale 1, origin top-left, y down). A per-page overlay (SVG for drawing + a transparent input/text surface) is attached to each rendered page slot, so it inherits the viewer's single pan/zoom transform. On "Save as", `pdf-export.js` converts marks to PDF space with pdf.js's own `convertToPdfPoint` (so rotation and crop boxes are handled by pdf.js) and writes Highlight/Ink/FreeText annotations with appearance streams via pdf-lib. A new Rust command writes the bytes to a path chosen in the save dialog.

**Tech Stack:** Vanilla ES modules, pdf.js 6.3.289 (vendored `src/vendor/pdfjs`, includes `TextLayer`), pdf-lib 1.17.1 (to be vendored), Tauri 2 (Rust, `tauri-plugin-dialog`, `tauri-plugin-fs`), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-pdf-annotations-design.md`

## Global Constraints

- Tools in v1: highlight, ink, note, eraser, undo/redo. Nothing else.
- "Save as" only. The original file is never modified or overwritten.
- Word (.docx) viewer is untouched.
- Offline: no CDN. New libraries are vendored under `src/vendor/`.
- No change to how `viewer.js` computes pan/zoom (single transform on `#pdf-pages`); no native scrolling.
- With no tool active the viewer behaves exactly as today (pan, pinch, momentum fling).
- With a tool active: one finger marks, two fingers still pinch-zoom.
- Branch workflow (CLAUDE.md): work on `feature/pdf-annotations`; never commit to `main`; no worktrees; do not delete branches.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Tests: `npm test` (Vitest, `tests/*.test.js`). The existing 46 tests must stay green.

## Review Focus

Inputs/conditions the spec implies but no happy-path test covers; each is pinned by a test or an explicit manual check in the owning task:

1. Rotated pages (`/Rotate` 90/180/270) and CropBox with non-zero origin: marks must land where drawn (Task 3 test with a non-trivial `toPdf`; Task 9 manual check).
2. Note text with non-Latin-1 characters (Turkish `ğ ş ı İ`, emoji): must not throw and must survive in `/Contents` (Task 3 test); appearance drawn through canvas, not a Latin-only font.
3. Scanned PDFs with no text layer: highlight says "no selectable text on this page", does not crash (Task 6).
4. A second finger landing mid-stroke (pinch while a tool is active): the stroke is cancelled, no stray dot or line (Task 5).
5. Encrypted/corrupt input to export, empty model, and save cancelled by the user: status message / no-op, model retained (Tasks 3, 8).

---

## File Structure

- Create `src/annotations.js` — model: add/remove/undo/redo/dirty, per-page queries. No DOM.
- Create `src/page-geometry.js` — pure helpers: `clientToPage`, `mergeLineRects`, `simplifyPath`, `hitTestMark`.
- Create `src/pdf-export.js` — pdf-lib export (takes model, original bytes, per-page `toPdf`).
- Create `src/vendor/pdf-lib/pdf-lib.esm.min.js` — vendored copy.
- Create `src/annotation-layer.js` — per-page overlay: SVG rendering, input surface, tools, highlight text selection, text layer.
- Create `src/annotation-toolbar.js` — toolbar DOM wiring (tool, colour, undo/redo, save).
- Modify `src/viewer.js` — page-rendered hook, "pan enabled" gate, export of document access.
- Modify `src/index.html`, `src/styles.css`, `src/main.js` — toolbar markup, styles, wiring and unsaved-marks confirmation.
- Modify `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs` — `save_document_as`.
- Create tests: `tests/annotations.test.js`, `tests/page-geometry.test.js`, `tests/pdf-export.test.js`.

---

### Task 1: Annotation data model

**Files:**
- Create: `src/annotations.js`
- Test: `tests/annotations.test.js`

**Interfaces:**
- Produces:
  - `createAnnotationStore()` returns a store with:
    - `add(mark)` → returns the stored mark (with generated `id`). Mark shapes (all coordinates in page units, y down):
      - `{ type: "highlight", page, color, rects: [{x, y, w, h}] }`
      - `{ type: "ink", page, color, width, points: [{x, y}] }`
      - `{ type: "note", page, color, x, y, text }`
    - `remove(id)` → boolean
    - `undo()` / `redo()` → boolean (whether anything changed)
    - `canUndo()` / `canRedo()` / `isDirty()` → boolean
    - `marksOnPage(page)` → array (insertion order)
    - `all()` → array
    - `markSaved()` clears dirty
    - `clear()` empties marks and history, clears dirty
    - `subscribe(fn)` → unsubscribe; `fn({ pages })` is called after every change with the set of affected page numbers.

- [ ] **Step 1: Write the failing test**

```js
// tests/annotations.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/annotations.test.js`
Expected: FAIL (cannot resolve `../src/annotations.js`).

- [ ] **Step 3: Write minimal implementation**

```js
// src/annotations.js
// Pure annotation model. Coordinates are page units: the viewer's scale-1
// viewport, origin top-left, y down. No DOM access here.

export function createAnnotationStore() {
  let marks = [];
  let undoStack = []; // { kind: "add" | "remove", mark, index }
  let redoStack = [];
  let nextId = 1;
  let cleanDepth = 0; // undoStack.length when last saved; -1 = unreachable
  const listeners = new Set();

  function notify(pages) {
    for (const fn of listeners) fn({ pages: new Set(pages) });
  }

  function insertAt(mark, index) {
    marks.splice(Math.min(index, marks.length), 0, mark);
  }

  function apply(entry, reverse) {
    const adding = (entry.kind === "add") !== reverse;
    if (adding) {
      insertAt(entry.mark, entry.index);
    } else {
      marks = marks.filter((m) => m.id !== entry.mark.id);
    }
  }

  return {
    add(mark) {
      const stored = { ...mark, id: `m${nextId++}` };
      marks.push(stored);
      undoStack.push({ kind: "add", mark: stored, index: marks.length - 1 });
      redoStack = [];
      if (cleanDepth > undoStack.length - 1) cleanDepth = -1;
      notify([stored.page]);
      return stored;
    },
    remove(id) {
      const index = marks.findIndex((m) => m.id === id);
      if (index < 0) return false;
      const mark = marks[index];
      marks.splice(index, 1);
      undoStack.push({ kind: "remove", mark, index });
      redoStack = [];
      if (cleanDepth > undoStack.length - 1) cleanDepth = -1;
      notify([mark.page]);
      return true;
    },
    undo() {
      const entry = undoStack.pop();
      if (!entry) return false;
      apply(entry, true);
      redoStack.push(entry);
      notify([entry.mark.page]);
      return true;
    },
    redo() {
      const entry = redoStack.pop();
      if (!entry) return false;
      apply(entry, false);
      undoStack.push(entry);
      notify([entry.mark.page]);
      return true;
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    isDirty: () => undoStack.length !== cleanDepth,
    markSaved() {
      cleanDepth = undoStack.length;
    },
    clear() {
      const pages = marks.map((m) => m.page);
      marks = [];
      undoStack = [];
      redoStack = [];
      cleanDepth = 0;
      notify(pages);
    },
    marksOnPage: (page) => marks.filter((m) => m.page === page),
    all: () => [...marks],
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/annotations.test.js`
Expected: PASS (9 tests). If the dirty test fails, re-check the `cleanDepth` bookkeeping: after `markSaved()` then `undo()`, `undoStack.length` (0) differs from `cleanDepth` (1), so dirty is true.

- [ ] **Step 5: Commit**

```bash
git add src/annotations.js tests/annotations.test.js
git commit -m "feat: add annotation data model with undo/redo

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Page geometry helpers

**Files:**
- Create: `src/page-geometry.js`
- Test: `tests/page-geometry.test.js`

**Interfaces:**
- Produces:
  - `clientToPage(clientX, clientY, rect, pageWidth, pageHeight)` → `{x, y}` in page units. `rect` is `{left, top, width, height}` of the page's on-screen box (`getBoundingClientRect()`, which already includes pan/zoom transforms).
  - `mergeLineRects(rects, tolerance = 2)` → merged `[{x,y,w,h}]`: rects on the same line (vertical overlap > 50% of the smaller height) whose horizontal gap ≤ `tolerance` are merged; zero/negative-size rects are dropped.
  - `simplifyPath(points, epsilon = 0.5)` → points with near-collinear points dropped (Ramer-Douglas-Peucker); first and last point always kept.
  - `hitTestMark(mark, x, y, slop = 6)` → boolean: whether page-unit point `(x, y)` is on/near the mark (highlight: inside any rect; ink: within `slop + width/2` of any segment; note: inside a 24×24 box anchored at `(x, y)`).

- [ ] **Step 1: Write the failing test**

```js
// tests/page-geometry.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/page-geometry.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Write minimal implementation**

```js
// src/page-geometry.js
// Pure geometry helpers for annotations. Page units: viewer scale 1, y down.

export function clientToPage(clientX, clientY, rect, pageWidth, pageHeight) {
  const w = rect.width || 1;
  const h = rect.height || 1;
  return {
    x: ((clientX - rect.left) / w) * pageWidth,
    y: ((clientY - rect.top) / h) * pageHeight,
  };
}

export function mergeLineRects(rects, tolerance = 2) {
  const valid = rects.filter((r) => r.w > 0 && r.h > 0).map((r) => ({ ...r }));
  valid.sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const rect of valid) {
    const prev = out.find((o) => {
      const overlap = Math.min(o.y + o.h, rect.y + rect.h) - Math.max(o.y, rect.y);
      const sameLine = overlap > 0.5 * Math.min(o.h, rect.h);
      const gap = rect.x - (o.x + o.w);
      return sameLine && gap <= tolerance && rect.x + rect.w >= o.x - tolerance;
    });
    if (prev) {
      const left = Math.min(prev.x, rect.x);
      const top = Math.min(prev.y, rect.y);
      const right = Math.max(prev.x + prev.w, rect.x + rect.w);
      const bottom = Math.max(prev.y + prev.h, rect.y + rect.h);
      prev.x = left;
      prev.y = top;
      prev.w = right - left;
      prev.h = bottom - top;
    } else {
      out.push(rect);
    }
  }
  return out;
}

function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function simplifyPath(points, epsilon = 0.5) {
  if (points.length < 3) return points.slice();
  let maxDistance = 0;
  let index = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = pointSegmentDistance(points[i], first, last);
    if (d > maxDistance) {
      maxDistance = d;
      index = i;
    }
  }
  if (maxDistance <= epsilon) return [first, last];
  const left = simplifyPath(points.slice(0, index + 1), epsilon);
  const right = simplifyPath(points.slice(index), epsilon);
  return left.slice(0, -1).concat(right);
}

export const NOTE_ICON_SIZE = 24;

export function hitTestMark(mark, x, y, slop = 6) {
  if (mark.type === "highlight") {
    return mark.rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  }
  if (mark.type === "ink") {
    const reach = slop + mark.width / 2;
    const p = { x, y };
    if (mark.points.length === 1) return Math.hypot(x - mark.points[0].x, y - mark.points[0].y) <= reach;
    for (let i = 1; i < mark.points.length; i += 1) {
      if (pointSegmentDistance(p, mark.points[i - 1], mark.points[i]) <= reach) return true;
    }
    return false;
  }
  if (mark.type === "note") {
    return x >= mark.x && x <= mark.x + NOTE_ICON_SIZE && y >= mark.y && y <= mark.y + NOTE_ICON_SIZE;
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/page-geometry.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/page-geometry.js tests/page-geometry.test.js
git commit -m "feat: add annotation page-geometry helpers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: PDF export with pdf-lib

**Files:**
- Modify: `package.json` (devDependency `pdf-lib`)
- Create: `src/vendor/pdf-lib/pdf-lib.esm.min.js` (copied from `node_modules/pdf-lib/dist/pdf-lib.esm.min.js`)
- Create: `src/pdf-export.js`
- Test: `tests/pdf-export.test.js`

**Interfaces:**
- Consumes: mark shapes from Task 1.
- Produces:
  - `exportAnnotatedPdf({ bytes, marks, pages, renderNoteImage })` → `Promise<Uint8Array>`.
    - `bytes`: original PDF bytes (`Uint8Array`).
    - `marks`: array from `store.all()`.
    - `pages`: array indexed by `pageNumber - 1`, each `{ toPdf(x, y) → [pdfX, pdfY] }` mapping a page-unit point to PDF user space (in the app this wraps pdf.js `viewport.convertToPdfPoint`).
    - `renderNoteImage` (optional): `async (note) → { png: Uint8Array, width, height }` (width/height in page units) used for the note's appearance stream. If absent, notes are written with `/Contents` only.
  - Throws `Error` with a readable message if the PDF cannot be loaded (e.g. encrypted).

- [ ] **Step 1: Install and vendor pdf-lib**

Run:
```bash
npm install --save-dev pdf-lib@1.17.1
mkdir -p src/vendor/pdf-lib
cp node_modules/pdf-lib/dist/pdf-lib.esm.min.js src/vendor/pdf-lib/pdf-lib.esm.min.js
ls -l src/vendor/pdf-lib
```
Expected: the file exists (about 500 KB). Also copy `node_modules/pdf-lib/LICENSE.md` to `src/vendor/pdf-lib/LICENSE.md` (MIT requires it).

- [ ] **Step 2: Write the failing test**

```js
// tests/pdf-export.test.js
import { describe, it, expect } from "vitest";
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFHexString } from "../src/vendor/pdf-lib/pdf-lib.esm.min.js";
import { exportAnnotatedPdf } from "../src/pdf-export.js";

async function samplePdf(pageCount = 1) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) doc.addPage([600, 800]);
  return new Uint8Array(await doc.save());
}

// page units (y down) -> PDF user space (y up) for a 600x800 page
const flip = { toPdf: (x, y) => [x, 800 - y] };

async function annotsOf(bytes, pageIndex = 0) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(pageIndex);
  const arr = page.node.lookup(PDFName.of("Annots"), PDFArray);
  return arr.asArray().map((ref) => page.node.context.lookup(ref, PDFDict));
}

const num = (dict, key) => dict.lookup(PDFName.of(key), PDFArray).asArray().map((n) => n.asNumber());
const name = (dict, key) => dict.lookup(PDFName.of(key)).toString();

describe("exportAnnotatedPdf", () => {
  it("returns the document unchanged in content when there are no marks", async () => {
    const bytes = await samplePdf();
    const out = await exportAnnotatedPdf({ bytes, marks: [], pages: [flip] });
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
  });

  it("writes a Highlight annotation with Rect, QuadPoints, colour and an appearance stream", async () => {
    const bytes = await samplePdf();
    const marks = [{ id: "m1", type: "highlight", page: 1, color: "#ffeb3b", rects: [{ x: 10, y: 20, w: 100, h: 12 }] }];
    const out = await exportAnnotatedPdf({ bytes, marks, pages: [flip] });
    const [annot] = await annotsOf(out);
    expect(name(annot, "Subtype")).toBe("/Highlight");
    expect(num(annot, "Rect")).toEqual([10, 768, 110, 780]);
    expect(num(annot, "QuadPoints")).toHaveLength(8);
    expect(num(annot, "C")[0]).toBeCloseTo(1, 2);
    expect(annot.has(PDFName.of("AP"))).toBe(true);
  });

  it("writes an Ink annotation with InkList, border width and appearance", async () => {
    const bytes = await samplePdf();
    const marks = [{ id: "m2", type: "ink", page: 1, color: "#e53935", width: 3, points: [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }] }];
    const out = await exportAnnotatedPdf({ bytes, marks, pages: [flip] });
    const [annot] = await annotsOf(out);
    expect(name(annot, "Subtype")).toBe("/Ink");
    const inkList = annot.lookup(PDFName.of("InkList"), PDFArray);
    expect(inkList.asArray()).toHaveLength(1);
    expect(inkList.lookup(0, PDFArray).asArray()).toHaveLength(6);
    expect(annot.has(PDFName.of("AP"))).toBe(true);
  });

  it("writes a FreeText note whose /Contents keeps non-Latin text", async () => {
    const bytes = await samplePdf();
    const text = "Önemli: ğüşiı İ 🙂";
    const marks = [{ id: "m3", type: "note", page: 1, color: "#1e88e5", x: 30, y: 40, text }];
    const out = await exportAnnotatedPdf({ bytes, marks, pages: [flip] });
    const [annot] = await annotsOf(out);
    expect(name(annot, "Subtype")).toBe("/FreeText");
    const contents = annot.lookup(PDFName.of("Contents"));
    expect(contents).toBeInstanceOf(PDFHexString);
    expect(contents.decodeText()).toBe(text);
  });

  it("uses renderNoteImage for the note appearance when provided", async () => {
    const bytes = await samplePdf();
    // 1x1 transparent PNG
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const marks = [{ id: "m4", type: "note", page: 1, color: "#000000", x: 30, y: 40, text: "hi" }];
    const out = await exportAnnotatedPdf({
      bytes, marks, pages: [flip],
      renderNoteImage: async () => ({ png, width: 80, height: 20 }),
    });
    const [annot] = await annotsOf(out);
    expect(annot.has(PDFName.of("AP"))).toBe(true);
  });

  it("applies each page's own toPdf (rotated page / offset crop box)", async () => {
    const bytes = await samplePdf();
    const rotated = { toPdf: (x, y) => [y + 5, x + 7] }; // like a 90° page with a cropbox offset
    const marks = [{ id: "m5", type: "highlight", page: 1, color: "#ffeb3b", rects: [{ x: 10, y: 20, w: 30, h: 10 }] }];
    const out = await exportAnnotatedPdf({ bytes, marks, pages: [rotated] });
    const [annot] = await annotsOf(out);
    expect(num(annot, "Rect")).toEqual([25, 17, 35, 47]);
  });

  it("keeps existing annotations and appends to the same page", async () => {
    const bytes = await samplePdf();
    const mid = await exportAnnotatedPdf({ bytes, marks: [{ id: "a", type: "ink", page: 1, color: "#000000", width: 2, points: [{ x: 0, y: 0 }, { x: 9, y: 9 }] }], pages: [flip] });
    const out = await exportAnnotatedPdf({ bytes: mid, marks: [{ id: "b", type: "ink", page: 1, color: "#000000", width: 2, points: [{ x: 1, y: 1 }, { x: 8, y: 8 }] }], pages: [flip] });
    expect(await annotsOf(out)).toHaveLength(2);
  });

  it("rejects with a readable message for non-PDF bytes", async () => {
    await expect(exportAnnotatedPdf({ bytes: new Uint8Array([1, 2, 3]), marks: [], pages: [] })).rejects.toThrow(/PDF/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/pdf-export.test.js`
Expected: FAIL (`../src/pdf-export.js` missing).

- [ ] **Step 4: Write the implementation**

```js
// src/pdf-export.js
// Writes annotation marks into a copy of a PDF using pdf-lib. Marks are in
// page units; each page's `toPdf` (pdf.js convertToPdfPoint in the app)
// converts them to PDF user space, so /Rotate and CropBox are pdf.js's job.
import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFHexString,
} from "./vendor/pdf-lib/pdf-lib.esm.min.js";

function hexToRgb(hex) {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1] ?? "000000";
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
}

const f = (n) => Number(n.toFixed(3));

function bbox(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function appendAnnot(doc, page, dict) {
  const ref = doc.context.register(doc.context.obj(dict));
  const existing = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (existing) {
    existing.push(ref);
  } else {
    page.node.set(PDFName.of("Annots"), doc.context.obj([ref]));
  }
}

function formStream(doc, content, box, resources = {}) {
  return doc.context.register(
    doc.context.stream(content, {
      Type: "XObject",
      Subtype: "Form",
      BBox: box.map(f),
      Resources: resources,
    })
  );
}

function highlightAnnot(doc, mark, toPdf) {
  const color = hexToRgb(mark.color);
  const quads = [];
  const corners = [];
  const content = [];
  for (const r of mark.rects) {
    const tl = toPdf(r.x, r.y);
    const tr = toPdf(r.x + r.w, r.y);
    const bl = toPdf(r.x, r.y + r.h);
    const br = toPdf(r.x + r.w, r.y + r.h);
    // QuadPoints order used by viewers: top-left, top-right, bottom-left, bottom-right
    quads.push(...tl, ...tr, ...bl, ...br);
    corners.push(tl, tr, bl, br);
    content.push(`${f(bl[0])} ${f(bl[1])} m ${f(br[0])} ${f(br[1])} l ${f(tr[0])} ${f(tr[1])} l ${f(tl[0])} ${f(tl[1])} l h f`);
  }
  const rect = bbox(corners);
  const ap = formStream(
    doc,
    `/GS gs ${color.map(f).join(" ")} rg ${content.join(" ")}`,
    rect,
    { ExtGState: { GS: { Type: "ExtGState", ca: 0.4, CA: 0.4, BM: "Multiply" } } }
  );
  return {
    Type: "Annot",
    Subtype: "Highlight",
    Rect: rect.map(f),
    QuadPoints: quads.map(f),
    C: color.map(f),
    CA: 0.4,
    F: 4,
    AP: { N: ap },
  };
}

function inkAnnot(doc, mark, toPdf) {
  const color = hexToRgb(mark.color);
  const pts = mark.points.map((p) => toPdf(p.x, p.y));
  const half = mark.width / 2;
  const [x0, y0, x1, y1] = bbox(pts);
  const rect = [x0 - half, y0 - half, x1 + half, y1 + half];
  const path = pts.map((p, i) => `${f(p[0])} ${f(p[1])} ${i === 0 ? "m" : "l"}`).join(" ");
  const single = pts.length === 1 ? ` ${f(pts[0][0])} ${f(pts[0][1])} l` : "";
  const ap = formStream(
    doc,
    `${color.map(f).join(" ")} RG ${f(mark.width)} w 1 J 1 j ${path}${single} S`,
    rect
  );
  return {
    Type: "Annot",
    Subtype: "Ink",
    Rect: rect.map(f),
    InkList: [pts.flatMap((p) => [f(p[0]), f(p[1])])],
    C: color.map(f),
    BS: { W: mark.width },
    F: 4,
    AP: { N: ap },
  };
}

async function noteAnnot(doc, mark, toPdf, renderNoteImage) {
  const color = hexToRgb(mark.color);
  let width = 160;
  let height = 40;
  let apRef = null;
  let image = null;
  if (renderNoteImage) {
    image = await renderNoteImage(mark);
    width = image.width;
    height = image.height;
  }
  const a = toPdf(mark.x, mark.y);
  const b = toPdf(mark.x + width, mark.y + height);
  const rect = bbox([a, b]);
  if (image) {
    const png = await doc.embedPng(image.png);
    const w = rect[2] - rect[0];
    const h = rect[3] - rect[1];
    const name = "Im0";
    apRef = formStream(doc, `q ${f(w)} 0 0 ${f(h)} 0 0 cm /${name} Do Q`, [0, 0, w, h], {
      XObject: { [name]: png.ref },
    });
    // BBox is local; Rect places it on the page
  }
  const dict = {
    Type: "Annot",
    Subtype: "FreeText",
    Rect: rect.map(f),
    Contents: PDFHexString.fromText(mark.text ?? ""),
    DA: `${color.map(f).join(" ")} rg /Helv 12 Tf`,
    C: color.map(f),
    F: 4,
  };
  if (apRef) dict.AP = { N: apRef };
  return dict;
}

export async function exportAnnotatedPdf({ bytes, marks, pages, renderNoteImage }) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes);
  } catch (err) {
    throw new Error(`Could not read the PDF to save annotations: ${err.message || err}`);
  }
  const docPages = doc.getPages();
  for (const mark of marks) {
    const page = docPages[mark.page - 1];
    const info = pages[mark.page - 1];
    if (!page || !info) continue;
    let dict;
    if (mark.type === "highlight") dict = highlightAnnot(doc, mark, info.toPdf);
    else if (mark.type === "ink") dict = inkAnnot(doc, mark, info.toPdf);
    else if (mark.type === "note") dict = await noteAnnot(doc, mark, info.toPdf, renderNoteImage);
    if (dict) appendAnnot(doc, page, dict);
  }
  return new Uint8Array(await doc.save());
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/pdf-export.test.js`
Expected: PASS (8 tests). Likely snags:
- `PDFDocument.load` accepting garbage bytes without throwing: pass `{ ignoreEncryption: false }` and check the failing-bytes test; if it does not reject, add `if (!PDFDocument...)` guard by checking the `%PDF` header (`bytes[0]===0x25 && bytes[1]===0x50`) and throw the same message.
- `doc.context.obj` converting the `Rect` array of numbers: it accepts number arrays. Nested plain objects become dicts, and strings become names, which is why `Subtype: "Highlight"` works.
- `Contents` must stay a `PDFHexString` (the test asserts it) so Unicode round-trips.

- [ ] **Step 6: Run the whole suite and commit**

Run: `npm test`
Expected: all green.

```bash
git add package.json package-lock.json src/vendor/pdf-lib src/pdf-export.js tests/pdf-export.test.js
git commit -m "feat: export marks as PDF annotations with pdf-lib

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Viewer hooks

**Files:**
- Modify: `src/viewer.js`
- Modify: `src/styles.css` (slot positioning)

**Interfaces:**
- Produces (exports from `viewer.js`):
  - `setPageRenderedHook(fn)`: `fn({ pageNumber, width, height, slot, viewport, pageProxy, renderedZoom })` is called after a page's canvas finished rendering and was appended to its slot. `width`/`height` are the page's scale-1 size; `viewport` is the pdf.js viewport used at `renderedZoom`.
  - `setPageUnloadedHook(fn)`: `fn(pageNumber)` is called when a page slot is emptied by `unloadPage`.
  - `setPanEnabled(enabled)`: when `false`, one-finger touch no longer pans (and no fling starts); pinch still works.
  - `getOpenPdf()` → `{ doc, numPages } | null` where `doc` is the pdf.js `PDFDocumentProxy` (use `doc.getData()` for the original bytes and `doc.getPage(n)`).
  - `setDocumentChangeHook(fn)`: `fn(event)` with `event` `"opened"` (after `renderPdf` succeeded) or `"closed"` (in `closePdf`).

- [ ] **Step 1: Add the hooks to `viewer.js`**

Add near the other module state (after `let panVelocity = null;`):

```js
let pageRenderedHook = null;
let pageUnloadedHook = null;
let documentChangeHook = null;
let panEnabled = true;
```

Add exports (e.g. below `setStatusCallback`):

```js
export function setPageRenderedHook(fn) {
  pageRenderedHook = fn;
}

export function setPageUnloadedHook(fn) {
  pageUnloadedHook = fn;
}

export function setDocumentChangeHook(fn) {
  documentChangeHook = fn;
}

export function setPanEnabled(enabled) {
  panEnabled = enabled;
  if (!enabled) stopFling();
}

export function getOpenPdf() {
  return pdfDoc ? { doc: pdfDoc, numPages: pdfDoc.numPages } : null;
}
```

In `unloadPage`, after `page.canvas = null;` add `pageUnloadedHook?.(page.pageNumber);`.

In `renderPage`, after the `try { await task.promise; } catch ... finally ...` block succeeds and the page is still current, call the hook. Replace the end of the inner `try` so that after the `finally` block (still inside the outer `try`) there is:

```js
    if (generation === renderGeneration && token === page.renderToken && page.canvas === canvas) {
      pageRenderedHook?.({
        pageNumber: page.pageNumber,
        width: page.width,
        height: page.height,
        slot: page.slot,
        viewport,
        pageProxy,
        renderedZoom,
      });
    }
```

(`canvas`, `viewport`, `pageProxy` are the locals already in `renderPage`. Note the existing `finally` nulls `page.canvas` when superseded, so the `page.canvas === canvas` check also covers that.)

In `closePdf`, after `pdfDoc = null;` add `documentChangeHook?.("closed");`. In `renderPdf`, right after `await rerenderPages({ animate: true });` add `if (token === loadToken) documentChangeHook?.("opened");`.

Gate one-finger panning. In `beginGesture`, change the single-touch branch to:

```js
  if (touches.length === 1) {
    gesture = panEnabled
      ? { kind: "pan", start: touchPoint(touches[0]), startPanX: panX, startPanY: panY }
      : { kind: "idle" };
  } else if (touches.length === 2) {
```

`touchmove` already does `event.preventDefault()` whenever `gesture` is set; with `kind: "idle"` the move branches fall through to the final `else { beginGesture(event.touches); }`, which would re-create idle each move: acceptable (cheap), but avoid it by changing the final `else` to `else if (gesture.kind !== "idle") { beginGesture(event.touches); }`. In `touchend`, `wasPanning` is false for idle, so no fling starts.

- [ ] **Step 2: Make slots positioning contexts**

In `src/styles.css`, in the `.pdf-page-slot` rule add `position: relative;`.

- [ ] **Step 3: Verify nothing regressed**

Run: `npm test`
Expected: all green (no tests touch `viewer.js`).
Manual (desktop build or `npx tauri dev`): open a PDF, scroll, zoom, pinch with a touch device or devtools touch emulation. Behavior must be identical to before. State the result in the commit message body.

- [ ] **Step 4: Commit**

```bash
git add src/viewer.js src/styles.css
git commit -m "feat: add viewer hooks for annotation layers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Annotation layer: drawing, ink, note, eraser

**Files:**
- Create: `src/annotation-layer.js`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `createAnnotationStore` (Task 1), `clientToPage`, `simplifyPath`, `hitTestMark` (Task 2), viewer hooks (Task 4).
- Produces:
  - `createAnnotationLayerController({ store, onStatus })` returns:
    - `handlePageRendered(info)` / `handlePageUnloaded(pageNumber)` (pass directly to the viewer hooks)
    - `setTool(tool)` where `tool` is `null | "highlight" | "ink" | "note" | "eraser"`
    - `setColor(hex)`; `getColor()`
    - `redrawAll()`
    - `dispose()`
  - Page overlay DOM per rendered page slot (class names are used by CSS):
    - `<svg class="annot-svg" viewBox="0 0 W H">` drawn from the store (pointer-events none)
    - `<div class="annot-surface">` input surface (pointer events), `touch-action: none`.

- [ ] **Step 1: Write `annotation-layer.js` (ink, note, eraser; highlight added in Task 6)**

```js
// src/annotation-layer.js
import { clientToPage, simplifyPath, hitTestMark, NOTE_ICON_SIZE } from "./page-geometry.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const INK_WIDTH = 2.5;

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function renderMark(mark) {
  if (mark.type === "highlight") {
    const g = svgEl("g", { fill: mark.color, "fill-opacity": 0.4, "data-mark": mark.id });
    g.style.mixBlendMode = "multiply";
    for (const r of mark.rects) g.append(svgEl("rect", { x: r.x, y: r.y, width: r.w, height: r.h }));
    return g;
  }
  if (mark.type === "ink") {
    const d = mark.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
    const single = mark.points.length === 1 ? ` L${mark.points[0].x} ${mark.points[0].y}` : "";
    return svgEl("path", {
      d: d + single, fill: "none", stroke: mark.color, "stroke-width": mark.width,
      "stroke-linecap": "round", "stroke-linejoin": "round", "data-mark": mark.id,
    });
  }
  if (mark.type === "note") {
    const g = svgEl("g", { "data-mark": mark.id });
    g.append(
      svgEl("rect", { x: mark.x, y: mark.y, width: NOTE_ICON_SIZE, height: NOTE_ICON_SIZE, rx: 4, fill: mark.color }),
      svgEl("path", { d: `M${mark.x + 6} ${mark.y + 9}h12M${mark.x + 6} ${mark.y + 14}h8`, stroke: "#fff", "stroke-width": 2, "stroke-linecap": "round" })
    );
    const title = svgEl("title");
    title.textContent = mark.text;
    g.append(title);
    return g;
  }
  return null;
}

export function createAnnotationLayerController({ store, onStatus = () => {} }) {
  const pagesInfo = new Map(); // pageNumber -> { width, height, slot, svg, surface, preview }
  let tool = null;
  let color = "#ffeb3b";

  function drawPage(pageNumber) {
    const info = pagesInfo.get(pageNumber);
    if (!info) return;
    info.svg.replaceChildren(...store.marksOnPage(pageNumber).map(renderMark).filter(Boolean));
    if (info.preview) info.svg.append(info.preview);
  }

  store.subscribe(({ pages }) => {
    for (const p of pages) drawPage(p);
  });

  function toPage(info, event) {
    return clientToPage(event.clientX, event.clientY, info.svg.getBoundingClientRect(), info.width, info.height);
  }

  function attachInput(info, pageNumber) {
    const { surface } = info;
    const active = new Set(); // pointer ids currently down on this surface
    let stroke = null; // { points }
    let moveHandler = null; // set by tool-specific logic (Task 6 adds highlight)

    const cancel = () => {
      stroke = null;
      moveHandler = null;
      if (info.preview) { info.preview.remove(); info.preview = null; }
    };

    surface.addEventListener("pointerdown", (event) => {
      if (!tool) return;
      active.add(event.pointerId);
      // A second finger means pinch-zoom: abandon the mark in progress.
      if (active.size > 1) { cancel(); return; }
      event.preventDefault();
      const point = toPage(info, event);

      if (tool === "ink") {
        stroke = { points: [point] };
        info.preview = svgEl("path", { fill: "none", stroke: color, "stroke-width": INK_WIDTH, "stroke-linecap": "round", "stroke-linejoin": "round" });
        info.svg.append(info.preview);
        surface.setPointerCapture?.(event.pointerId);
      } else if (tool === "note") {
        placeNote(info, pageNumber, point);
      } else if (tool === "eraser") {
        eraseAt(pageNumber, point);
        stroke = { points: [point] };
        surface.setPointerCapture?.(event.pointerId);
      } else if (tool === "highlight") {
        info.beginHighlight?.(event, point, (fn) => { moveHandler = fn; });
      }
    });

    surface.addEventListener("pointermove", (event) => {
      if (!tool || !active.has(event.pointerId) || active.size > 1) return;
      const point = toPage(info, event);
      if (tool === "ink" && stroke) {
        stroke.points.push(point);
        info.preview.setAttribute("d", stroke.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" "));
      } else if (tool === "eraser" && stroke) {
        eraseAt(pageNumber, point);
      } else if (moveHandler) {
        moveHandler(event, point);
      }
    });

    const end = (event, commit) => {
      const wasActive = active.delete(event.pointerId);
      if (!wasActive) return;
      if (commit && tool === "ink" && stroke) {
        const points = simplifyPath(stroke.points);
        store.add({ type: "ink", page: pageNumber, color, width: INK_WIDTH, points });
      } else if (commit && moveHandler) {
        info.endHighlight?.();
      }
      cancel();
    };
    surface.addEventListener("pointerup", (event) => end(event, active.size === 1));
    surface.addEventListener("pointercancel", (event) => end(event, false));
  }

  function eraseAt(pageNumber, point) {
    const hit = [...store.marksOnPage(pageNumber)].reverse().find((m) => hitTestMark(m, point.x, point.y));
    if (hit) store.remove(hit.id);
  }

  function placeNote(info, pageNumber, point) {
    const input = document.createElement("textarea");
    input.className = "annot-note-input";
    input.placeholder = "Note";
    input.rows = 2;
    const rect = info.svg.getBoundingClientRect();
    const left = ((point.x / info.width) * rect.width) || 0;
    const top = ((point.y / info.height) * rect.height) || 0;
    input.style.left = `${(left / rect.width) * 100}%`;
    input.style.top = `${(top / rect.height) * 100}%`;
    info.slot.append(input);
    input.focus();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      input.remove();
      if (save && text) store.add({ type: "note", page: pageNumber, color, x: point.x, y: point.y, text });
    };
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") finish(false);
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) finish(true);
    });
  }

  function syncSurfaces() {
    for (const info of pagesInfo.values()) {
      info.surface.style.pointerEvents = tool ? "auto" : "none";
      info.surface.dataset.tool = tool ?? "";
    }
  }

  return {
    handlePageRendered({ pageNumber, width, height, slot, viewport, pageProxy, renderedZoom }) {
      const svg = svgEl("svg", { class: "annot-svg", viewBox: `0 0 ${width} ${height}` });
      const surface = document.createElement("div");
      surface.className = "annot-surface";
      slot.append(svg, surface);
      const info = { width, height, slot, svg, surface, preview: null, viewport, pageProxy, renderedZoom };
      pagesInfo.set(pageNumber, info);
      attachInput(info, pageNumber);
      drawPage(pageNumber);
      syncSurfaces();
      controller.onPageReady?.(info, pageNumber); // Task 6 hook: text layer
    },
    handlePageUnloaded(pageNumber) {
      pagesInfo.delete(pageNumber);
    },
    setTool(next) {
      tool = next;
      syncSurfaces();
      controller.onToolChanged?.(next); // Task 6 hook
    },
    getTool: () => tool,
    setColor(hex) { color = hex; },
    getColor: () => color,
    redrawAll() { for (const n of pagesInfo.keys()) drawPage(n); },
    pageInfo: (n) => pagesInfo.get(n),
    pagesInfo,
    dispose() { pagesInfo.clear(); },
  };
}
```

Important: write the end of the function as `const controller = { ... }; return controller;` (not a bare `return { ... }`), because `handlePageRendered` and `setTool` reference `controller.onPageReady` / `controller.onToolChanged`. Those two are plain optional properties that Task 6 fills in.

- [ ] **Step 2: Add CSS**

Append to `src/styles.css`:

```css
/* ---------- annotation overlay ---------- */

.annot-svg,
.annot-surface {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.annot-svg {
  pointer-events: none;
}

.annot-surface {
  touch-action: none;
  pointer-events: none; /* enabled by JS while a tool is active */
  z-index: 2;
}

.annot-surface[data-tool="ink"] { cursor: crosshair; }
.annot-surface[data-tool="note"] { cursor: text; }
.annot-surface[data-tool="eraser"] { cursor: cell; }
.annot-surface[data-tool="highlight"] { cursor: text; }

.annot-note-input {
  position: absolute;
  z-index: 3;
  min-width: 160px;
  max-width: 60%;
  font: 14px/1.3 system-ui, sans-serif;
  color: #201d1a;
  background: #fffbe6;
  border: 1px solid #c9b458;
  border-radius: 4px;
  padding: 4px 6px;
}
```

- [ ] **Step 3: Manual verification (needs a wired toolbar from Task 7; for now verify via devtools)**

Run `npx tauri dev`, open a PDF, then in the devtools console:

```js
// temporary check: dynamic import mirrors what main.js will do in Task 7
const m = await import("./annotation-layer.js");
```

If console wiring is awkward, defer the manual check to Task 7 Step 5 and only confirm here that `npm test` is still green and the app still opens PDFs normally.

- [ ] **Step 4: Commit**

```bash
git add src/annotation-layer.js src/styles.css
git commit -m "feat: add per-page annotation overlay with ink, note and eraser

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Highlight with a text layer

**Files:**
- Modify: `src/annotation-layer.js`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `pdfjsLib.TextLayer` from `./vendor/pdfjs/pdf.mjs` (constructor `{ textContentSource, container, viewport }`, method `render()`), `mergeLineRects`, `clientToPage`.
- Produces: highlight tool behavior. On drag over text, a live preview follows the finger; on release the highlight is stored via `store.add({ type: "highlight", page, color, rects })`. `onStatus("No selectable text on this page")` when the page has no text.

Design notes (read before implementing):
- Native touch text selection is unavailable (`touch-action: none`, touchmove is cancelled), so the selection is computed from points: `document.caretPositionFromPoint(x, y)` (fallback `document.caretRangeFromPoint`) at drag start and at the current point gives a `Range`; `range.getClientRects()` gives line boxes; convert to page units and `mergeLineRects`.
- The text layer must sit **under** the input surface for display but must be hit-testable. Because `.annot-surface` covers the page, hit-test by temporarily setting `surface.style.pointerEvents = "none"` around the `caretPositionFromPoint` call, or use `document.elementsFromPoint` and pick the text layer. Use the temporary-toggle approach.
- The text layer is only rendered while the highlight tool is active (cost control), and for any page rendered while it is active.

- [ ] **Step 1: Add the text layer and selection logic**

In `annotation-layer.js` add the import at the top:

```js
import { TextLayer } from "./vendor/pdfjs/pdf.mjs";
import { mergeLineRects } from "./page-geometry.js";
```

Add helper functions inside `createAnnotationLayerController` (before the `controller` object):

```js
  async function ensureTextLayer(info) {
    if (info.textLayer || info.textLayerPending) return;
    info.textLayerPending = true;
    try {
      const container = document.createElement("div");
      container.className = "annot-textlayer";
      info.slot.style.setProperty("--total-scale-factor", String(info.renderedZoom));
      info.slot.style.setProperty("--scale-round-x", "1px");
      info.slot.style.setProperty("--scale-round-y", "1px");
      info.slot.insertBefore(container, info.surface);
      const textLayer = new TextLayer({
        textContentSource: info.pageProxy.streamTextContent(),
        container,
        viewport: info.viewport,
      });
      await textLayer.render();
      info.textLayer = container;
      info.hasText = container.querySelector("span") !== null;
    } catch (err) {
      onStatus(`Could not prepare text selection: ${err.message || err}`);
    } finally {
      info.textLayerPending = false;
    }
  }

  function removeTextLayer(info) {
    info.textLayer?.remove();
    info.textLayer = null;
    info.hasText = false;
  }

  function caretAt(info, x, y) {
    const surface = info.surface;
    const previous = surface.style.pointerEvents;
    surface.style.pointerEvents = "none";
    try {
      if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
      }
      const range = document.caretRangeFromPoint?.(x, y);
      return range ? { node: range.startContainer, offset: range.startOffset } : null;
    } finally {
      surface.style.pointerEvents = previous;
    }
  }

  function selectionRects(info, startCaret, endCaret) {
    if (!startCaret || !endCaret || !info.textLayer?.contains(startCaret.node) || !info.textLayer?.contains(endCaret.node)) return [];
    const range = document.createRange();
    const forward = startCaret.node.compareDocumentPosition(endCaret.node) & Node.DOCUMENT_POSITION_FOLLOWING
      || (startCaret.node === endCaret.node && startCaret.offset <= endCaret.offset);
    const [a, b] = forward ? [startCaret, endCaret] : [endCaret, startCaret];
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    const box = info.svg.getBoundingClientRect();
    const sx = info.width / (box.width || 1);
    const sy = info.height / (box.height || 1);
    const rects = [...range.getClientRects()].map((r) => ({
      x: (r.left - box.left) * sx,
      y: (r.top - box.top) * sy,
      w: r.width * sx,
      h: r.height * sy,
    }));
    return mergeLineRects(rects);
  }
```

Define the per-page highlight handlers inside `handlePageRendered`, before `attachInput`:

```js
      info.beginHighlight = (event, point, setMove) => {
        if (info.textLayerPending || !info.textLayer) return;
        if (!info.hasText) { onStatus("No selectable text on this page"); return; }
        const startCaret = caretAt(info, event.clientX, event.clientY);
        if (!startCaret) return;
        info.surface.setPointerCapture?.(event.pointerId);
        info.highlightRects = [];
        info.preview = svgEl("g", { fill: color, "fill-opacity": 0.4 });
        info.svg.append(info.preview);
        setMove((moveEvent) => {
          const endCaret = caretAt(info, moveEvent.clientX, moveEvent.clientY);
          info.highlightRects = selectionRects(info, startCaret, endCaret);
          info.preview.replaceChildren(...info.highlightRects.map((r) => svgEl("rect", { x: r.x, y: r.y, width: r.w, height: r.h })));
        });
      };
      info.endHighlight = () => {
        if (info.highlightRects?.length) {
          store.add({ type: "highlight", page: pageNumber, color, rects: info.highlightRects });
        }
        info.highlightRects = [];
      };
```

Wire the controller hooks (replace the optional-property placeholders):

```js
  controller.onPageReady = (info) => {
    if (tool === "highlight") ensureTextLayer(info);
  };
  controller.onToolChanged = (next) => {
    for (const info of pagesInfo.values()) {
      if (next === "highlight") ensureTextLayer(info);
      else removeTextLayer(info);
    }
  };
```

(Place these assignments right after `const controller = { ... };`, before `return controller;`.)

- [ ] **Step 2: CSS for the text layer**

Append to `src/styles.css` (values mirror `pdf_viewer.css` `.textLayer`):

```css
.annot-textlayer {
  position: absolute;
  inset: 0;
  overflow: clip;
  line-height: 1;
  text-size-adjust: none;
  -webkit-text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  z-index: 1;
  user-select: none;
}

.annot-textlayer :is(span, br) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
}
```

- [ ] **Step 3: Manual verification**

Run `npx tauri dev`, open a text PDF, activate the highlight tool via the toolbar (Task 7) or temporarily via the console. Drag across a sentence: a yellow band follows the text, release keeps it; zoom in/out: highlight stays aligned (it is in page units, redrawn after re-render). Open a scanned/image-only PDF: dragging shows "No selectable text on this page" and nothing breaks. If `caretPositionFromPoint` returns the surface instead of a text node (selection empty), confirm `pointerEvents` is toggled off in `caretAt`.
If the text layer misaligns with the canvas, check that `--total-scale-factor` equals `renderedZoom` on the slot (devtools computed style).

- [ ] **Step 4: Commit**

```bash
git add src/annotation-layer.js src/styles.css
git commit -m "feat: add highlight tool backed by a pdf.js text layer

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Toolbar UI and wiring

**Files:**
- Modify: `src/index.html`
- Modify: `src/styles.css`
- Create: `src/annotation-toolbar.js`
- Modify: `src/main.js`

**Interfaces:**
- Consumes: store (Task 1), controller (Tasks 5-6), viewer hooks (Task 4).
- Produces:
  - `initAnnotationToolbar({ store, controller, onSave })` returns `{ show(), hide(), sync() }`. `onSave` is `async () => void` called by the Save button.
  - DOM ids: `#annotate-btn` (in the main toolbar, PDF only), `#annotation-bar` (second row) containing buttons `#tool-highlight`, `#tool-ink`, `#tool-note`, `#tool-eraser`, `#undo-btn`, `#redo-btn`, `#save-annotated-btn`, and colour swatches `.annot-swatch[data-color]`.

- [ ] **Step 1: Markup**

In `src/index.html`, inside the toolbar after `#page-mode-btn` add the toggle (hidden until a PDF is open, like the other PDF-only buttons):

```html
      <button id="annotate-btn" class="icon-btn" title="Mark up" aria-label="Mark up this PDF" aria-pressed="false" hidden>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 20l4-1 11-11a2.1 2.1 0 0 0-3-3L5 16z" />
          <path d="M14 7l3 3" />
        </svg>
      </button>
```

Directly after the closing `</header>`/toolbar element (read `index.html` around the toolbar's end to place it as a sibling that sits below the toolbar), add:

```html
    <div id="annotation-bar" hidden>
      <button id="tool-highlight" class="icon-btn" data-tool="highlight" title="Highlight" aria-label="Highlight text" aria-pressed="false">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l4 4M4 20h6l9-9-6-6-9 9z" /></svg>
      </button>
      <button id="tool-ink" class="icon-btn" data-tool="ink" title="Draw" aria-label="Draw" aria-pressed="false">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17c3-6 5-6 6-3s3 3 6-3 4-2 6 0" /></svg>
      </button>
      <button id="tool-note" class="icon-btn" data-tool="note" title="Note" aria-label="Add a text note" aria-pressed="false">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h14v12H9l-4 4zM9 9h6M9 12h4" /></svg>
      </button>
      <button id="tool-eraser" class="icon-btn" data-tool="eraser" title="Eraser" aria-label="Erase marks" aria-pressed="false">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 20h11M5 14l8-9 6 6-6 7H9z" /></svg>
      </button>
      <span class="annot-sep" aria-hidden="true"></span>
      <button class="annot-swatch" data-color="#ffeb3b" style="--swatch:#ffeb3b" aria-label="Yellow"></button>
      <button class="annot-swatch" data-color="#66bb6a" style="--swatch:#66bb6a" aria-label="Green"></button>
      <button class="annot-swatch" data-color="#42a5f5" style="--swatch:#42a5f5" aria-label="Blue"></button>
      <button class="annot-swatch" data-color="#ef5350" style="--swatch:#ef5350" aria-label="Red"></button>
      <span class="annot-sep" aria-hidden="true"></span>
      <button id="undo-btn" class="icon-btn" title="Undo" aria-label="Undo" disabled>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 7L4 12l5 5M4 12h10a6 6 0 0 1 0 12" transform="translate(0 -3)" /></svg>
      </button>
      <button id="redo-btn" class="icon-btn" title="Redo" aria-label="Redo" disabled>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 7l5 5-5 5M20 12H10a6 6 0 0 0 0 12" transform="translate(0 -3)" /></svg>
      </button>
      <button id="save-annotated-btn" class="icon-btn" title="Save a copy with marks" aria-label="Save a copy with marks" disabled>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6" /></svg>
      </button>
    </div>
```

(The undo/redo icon paths are simple placeholders-free curves; adjust visually if they look off.)

- [ ] **Step 2: Styles**

Append to `src/styles.css` (reuse the existing CSS variables used by `#toolbar`; check `:root` for names such as `--surface`, `--border`, `--accent` and use those, falling back to the literal values below only if a variable does not exist):

```css
#annotation-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  overflow-x: auto;
  background: var(--surface, #24211e);
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
}

#annotation-bar[hidden] {
  display: none;
}

#annotation-bar .icon-btn[aria-pressed="true"] {
  background: var(--accent-soft, rgba(240, 180, 70, 0.18));
  color: var(--accent, #f0b446);
}

#annotation-bar .icon-btn:disabled {
  opacity: 0.35;
}

.annot-sep {
  width: 1px;
  height: 20px;
  margin: 0 4px;
  background: var(--border, rgba(255, 255, 255, 0.12));
  flex: none;
}

.annot-swatch {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  background: var(--swatch);
  cursor: pointer;
}

.annot-swatch[aria-pressed="true"] {
  border-color: var(--text-hi, #fff);
}

#annotate-btn[aria-pressed="true"] {
  color: var(--accent, #f0b446);
}
```

On coarse pointers the existing `@media (pointer: coarse)` block already enlarges `.icon-btn`; add `.annot-swatch { width: 30px; height: 30px; }` inside that block.

- [ ] **Step 3: `annotation-toolbar.js`**

```js
// src/annotation-toolbar.js
const TOOLS = ["highlight", "ink", "note", "eraser"];

export function initAnnotationToolbar({ store, controller, onSave }) {
  const bar = document.getElementById("annotation-bar");
  const toggle = document.getElementById("annotate-btn");
  const undoBtn = document.getElementById("undo-btn");
  const redoBtn = document.getElementById("redo-btn");
  const saveBtn = document.getElementById("save-annotated-btn");
  const toolButtons = TOOLS.map((t) => document.getElementById(`tool-${t}`));
  const swatches = [...bar.querySelectorAll(".annot-swatch")];
  let onToolActive = () => {};

  function selectTool(tool) {
    controller.setTool(tool);
    for (const b of toolButtons) b.setAttribute("aria-pressed", String(b.dataset.tool === tool));
    onToolActive(tool !== null);
  }

  function selectColor(hex) {
    controller.setColor(hex);
    for (const s of swatches) s.setAttribute("aria-pressed", String(s.dataset.color === hex));
  }

  function sync() {
    undoBtn.disabled = !store.canUndo();
    redoBtn.disabled = !store.canRedo();
    saveBtn.disabled = store.all().length === 0;
  }

  function show() {
    bar.hidden = false;
    toggle.setAttribute("aria-pressed", "true");
    if (!controller.getTool()) selectTool("highlight");
  }

  function hide() {
    selectTool(null);
    bar.hidden = true;
    toggle.setAttribute("aria-pressed", "false");
  }

  toggle.addEventListener("click", () => (bar.hidden ? show() : hide()));
  for (const b of toolButtons) {
    b.addEventListener("click", () => selectTool(controller.getTool() === b.dataset.tool ? null : b.dataset.tool));
  }
  for (const s of swatches) s.addEventListener("click", () => selectColor(s.dataset.color));
  undoBtn.addEventListener("click", () => store.undo());
  redoBtn.addEventListener("click", () => store.redo());
  saveBtn.addEventListener("click", () => onSave());
  window.addEventListener("keydown", (event) => {
    if (bar.hidden || !(event.ctrlKey || event.metaKey) || event.target instanceof HTMLTextAreaElement) return;
    if (event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) store.redo(); else store.undo();
    } else if (event.key.toLowerCase() === "y") {
      event.preventDefault();
      store.redo();
    }
  });

  store.subscribe(sync);
  selectColor(controller.getColor());
  sync();

  return {
    show,
    hide,
    sync,
    setToolActiveListener(fn) { onToolActive = fn; },
  };
}
```

- [ ] **Step 4: Wire into `main.js`**

Add imports near the top of `src/main.js`:

```js
import { createAnnotationStore } from "./annotations.js";
import { createAnnotationLayerController } from "./annotation-layer.js";
import { initAnnotationToolbar } from "./annotation-toolbar.js";
```

and extend the `./viewer.js` import with `setPageRenderedHook, setPageUnloadedHook, setDocumentChangeHook, setPanEnabled, getOpenPdf`.

After the other `init*()` calls (`initSidebar(); initEmptyState();`) add:

```js
const annotationStore = createAnnotationStore();
const annotationLayers = createAnnotationLayerController({ store: annotationStore, onStatus: setStatus });
const annotationToolbar = initAnnotationToolbar({
  store: annotationStore,
  controller: annotationLayers,
  onSave: () => saveAnnotatedCopy(),
});
annotationToolbar.setToolActiveListener((active) => setPanEnabled(!active));
setPageRenderedHook((info) => annotationLayers.handlePageRendered(info));
setPageUnloadedHook((n) => annotationLayers.handlePageUnloaded(n));
setDocumentChangeHook((event) => {
  // a new or closed document starts with a clean mark set and the bar closed
  annotationStore.clear();
  annotationToolbar.hide();
  setPanEnabled(true);
});
```

(`saveAnnotatedCopy` is defined in Task 8; until then define a stub `async function saveAnnotatedCopy() { setStatus("Saving is not implemented yet"); }` so the app runs, and replace it in Task 8.)

In `syncToolbarForKind`, add `document.getElementById("annotate-btn").hidden = kind !== "pdf";` and, when `kind !== "pdf"`, call `annotationToolbar.hide()`. (`annotationToolbar` is declared later in the file than `syncToolbarForKind`; function bodies run after module init, so this is fine as long as `syncToolbarForKind` is not called before the `const` is initialised: `showEmptyState()` is called after the init block, so keep the init block above `showEmptyState();`.)

- [ ] **Step 5: Manual verification**

Run `npx tauri dev`. Open a PDF: the pen button appears. Click it: the bar opens with Highlight selected. Verify each:
1. Highlight: drag over text, band appears and stays; zoom in/out keeps it aligned.
2. Ink: draw; zoom; the stroke scales with the page.
3. Note: click, type, click elsewhere; a coloured note icon appears; hover shows the text.
4. Eraser: drag over a mark; it disappears. Undo brings it back.
5. Undo/Redo buttons and Ctrl+Z / Ctrl+Y.
6. Tool active and two-finger pinch (devtools touch emulation or a phone): pinch zooms, no stray mark, one finger draws instead of panning. Close the bar: one-finger pan and the momentum fling work again.
7. Open a different file: the bar closes, marks are gone.
8. Open a `.docx`: the pen button is hidden.

- [ ] **Step 6: Commit**

```bash
git add src/index.html src/styles.css src/annotation-toolbar.js src/main.js
git commit -m "feat: add annotation toolbar and wire the overlay into the app

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Save a copy (Rust command and frontend)

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/main.js`

**Interfaces:**
- Produces:
  - Rust command `save_document_as(request: tauri::ipc::Request) -> Result<String, String>`: body is the raw PDF bytes; the suggested file name comes in the `x-file-name` header (URI-encoded). Shows the save dialog; returns the saved path/URI as a string. Returns `Err("cancelled")` when the user cancels.
  - JS `saveAnnotatedCopy()` in `main.js`: exports and saves; on success `annotationStore.markSaved()` and a status message.

- [ ] **Step 1: Write the Rust command with a unit test for the filename helper**

In `src-tauri/src/commands.rs` add (below `open_document_path`):

```rust
/// Turns the suggested save name from the frontend into a safe `.pdf` file
/// name: URI-decoded by the caller, path separators stripped, falling back to
/// "document.pdf".
pub fn suggested_pdf_name(raw: &str) -> String {
    let base = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim();
    if base.is_empty() {
        return "document.pdf".to_string();
    }
    if base.to_lowercase().ends_with(".pdf") {
        base.to_string()
    } else {
        format!("{base}.pdf")
    }
}

fn write_bytes(
    app: &tauri::AppHandle,
    file_path: &FilePath,
    bytes: &[u8],
) -> Result<(), String> {
    use std::io::Write as _;
    if let Some(path) = file_path.as_path() {
        return fs::write(path, bytes).map_err(|e| format!("Failed to write file: {e}"));
    }
    let mut file = app
        .fs()
        .open(
            file_path.clone(),
            OpenOptions::new().write(true).create(true).truncate(true).clone(),
        )
        .map_err(|e| format!("Failed to open file for writing: {e}"))?;
    file.write_all(bytes)
        .map_err(|e| format!("Failed to write file: {e}"))
}

/// Saves PDF bytes (raw request body) to a location the user picks. The name
/// suggestion arrives URI-encoded in the `x-file-name` header.
#[tauri::command]
pub async fn save_document_as(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw PDF bytes".to_string());
    };
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(|v| percent_decode(v))
        .unwrap_or_default();

    let target = app
        .dialog()
        .file()
        .add_filter("PDF document", ["pdf"])
        .set_file_name(suggested_pdf_name(&name))
        .blocking_save_file();

    let Some(file_path) = target else {
        return Err("cancelled".to_string());
    };
    write_bytes(&app, &file_path, bytes)?;
    Ok(file_path.to_string())
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            if let Ok(v) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
```

Add tests in the existing `#[cfg(test)] mod tests` of `commands.rs`:

```rust
    #[test]
    fn suggested_name_strips_directories_and_adds_extension() {
        assert_eq!(suggested_pdf_name("C:\\docs\\report.pdf"), "report.pdf");
        assert_eq!(suggested_pdf_name("notes"), "notes.pdf");
        assert_eq!(suggested_pdf_name("   "), "document.pdf");
    }

    #[test]
    fn percent_decode_handles_unicode_and_bad_escapes() {
        assert_eq!(percent_decode("%C3%96nemli%20belge.pdf"), "Önemli belge.pdf");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
```

`percent_decode` only decodes `%` when two more bytes follow (`i + 3 <= bytes.len()`); `str` slicing at `i + 1..i + 3` can still panic if those bytes split a multi-byte character, so guard it by using `input.get(i + 1..i + 3)` instead of indexing: replace `u8::from_str_radix(&input[i + 1..i + 3], 16)` with `input.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())` and adapt the `if let Ok(v)` to `if let Some(v)`.

Register in `src-tauri/src/lib.rs`: add `commands::save_document_as,` to `generate_handler![...]`.

- [ ] **Step 2: Run the Rust tests**

Run: `cd src-tauri && cargo test --lib`
Expected: the new tests plus the existing ones pass. (If `set_file_name` or `blocking_save_file` are not found, check the dialog crate version's `FileDialogBuilder` API in `~/.cargo/registry/src/*/tauri-plugin-dialog-2.7.3/src/lib.rs` and adjust names.)

- [ ] **Step 3: Frontend `saveAnnotatedCopy`**

Replace the Task 7 stub in `src/main.js`:

```js
import { exportAnnotatedPdf } from "./pdf-export.js";

// Draws a note's text to a canvas so the saved PDF shows it in any script
// (Turkish letters, emoji) without embedding a font.
async function renderNoteImage(note) {
  const scale = 2;
  const padding = 6;
  const font = '14px system-ui, "Segoe UI", sans-serif';
  const lines = note.text.split("\n");
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = font;
  const textWidth = Math.max(...lines.map((l) => probe.measureText(l).width), 40);
  const width = Math.ceil(textWidth + padding * 2);
  const height = Math.ceil(lines.length * 18 + padding * 2);
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = "#fffbe6";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = note.color;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, width - 2, height - 2);
  ctx.fillStyle = "#201d1a";
  ctx.font = font;
  ctx.textBaseline = "top";
  lines.forEach((line, i) => ctx.fillText(line, padding, padding + i * 18));
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  return { png: new Uint8Array(await blob.arrayBuffer()), width, height };
}

async function saveAnnotatedCopy() {
  const open = getOpenPdf();
  if (!open || annotationStore.all().length === 0) return;
  setStatus("Saving…");
  try {
    const bytes = await open.doc.getData();
    const pages = [];
    for (let n = 1; n <= open.numPages; n += 1) {
      const page = await open.doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      pages.push({ toPdf: (x, y) => viewport.convertToPdfPoint(x, y) });
    }
    const out = await exportAnnotatedPdf({
      bytes,
      marks: annotationStore.all(),
      pages,
      renderNoteImage,
    });
    const name = currentDocumentName || "document.pdf";
    await invoke("save_document_as", out, {
      headers: { "x-file-name": encodeURIComponent(name.replace(/\.pdf$/i, "") + "-annotated.pdf") },
    });
    annotationStore.markSaved();
    setStatus("Saved a copy with your marks");
  } catch (err) {
    if (err === "cancelled") { setStatus(""); return; }
    setStatus(`Error: ${err.message || err}`);
  }
}
```

`currentDocumentName`: add `let currentDocumentName = "";` in `main.js`; `handleOpenRequested({ path })` sets it from the path's last segment (`path.split(/[\\/]/).pop()`); `openViaBytesResult` (dialog open, no path) leaves it as the default. If a clean display name already exists in the sidebar/recent state, reuse it instead.

Ensure `pdf-export.js`'s unsaved flag semantics: `annotationStore.markSaved()` is only called after a successful write.

- [ ] **Step 4: Unsaved-marks confirmation**

In `main.js`, guard the two places that discard marks: `showDocument()` (opening another file) and the close path (`showEmptyState`/close handler). Before replacing the document:

```js
function confirmDiscardMarks() {
  if (!annotationStore.isDirty()) return true;
  return window.confirm("You have unsaved marks on this PDF. Discard them?");
}
```

Call it at the top of `showDocument(bytes)` (return `false` when declined) and wherever the app closes the current document. `setDocumentChangeHook` clears the store afterwards (Task 7). Note: `showDocument` is entered after the bytes are already read; declining leaves the open document untouched because nothing has been closed yet.

- [ ] **Step 5: Manual verification**

Run `npx tauri dev`:
1. Add a highlight, an ink stroke, and a note with `Önemli ğüşiı`; click Save; choose a path; status says saved. Open the saved copy in the app: marks render. Open it in a second viewer (Edge/Chrome PDF viewer and Acrobat if available): marks visible; the note shows its text.
2. Cancel the save dialog: status clears, marks remain, no error.
3. Open another file with unsaved marks: confirmation appears; Cancel keeps the current document and marks.
4. Rotated PDF (use a landscape-rotated sample): a highlight drawn over a word lands on that word in the saved copy.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/main.js
git commit -m "feat: save an annotated copy of the PDF

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Android verification, docs, final checks

**Files:**
- Modify: `README.md` (feature and manual checklist lines)
- Modify: `docs/current-state-follow-up.md` (only if it tracks feature state; read it first)

- [ ] **Step 1: Run the full automated suite**

Run: `npm test` then `cd src-tauri && cargo test --lib`
Expected: all green.

- [ ] **Step 2: Desktop release build**

Run: `npm run tauri build`
Expected: builds `PDF Reader_0.2.1_x64-setup.exe`. Smoke-test the installed/portable exe with a PDF: annotate and save once.

- [ ] **Step 3: Android checks (needs a phone; cannot be verified by tests)**

Run: `npx tauri android dev` (USB or wireless adb). On the phone:
1. Open a PDF, enable the pen, draw with one finger: the page does not pan while a tool is active; two fingers pinch-zoom without a stray mark.
2. Disable the tool: one-finger pan and the momentum fling work as before.
3. Highlight by dragging over text; the band follows the finger.
4. Save: the system "create document" picker appears (the dialog plugin uses `ACTION_CREATE_DOCUMENT`); save to Downloads; confirm the file opens with marks in another app.
5. If the write to the returned `content://` URI fails in `write_bytes` (fs plugin write mode), STOP and report the exact error to the user before changing approach; candidates are enabling the fs plugin's write permission in `capabilities/default.json` (`fs:allow-write-file` scoped appropriately) or writing through a different plugin API. Do not weaken the capability scope without asking.

- [ ] **Step 4: Update docs**

In `README.md`, add a short "Mark up PDFs" feature line (tools, "Save a copy", marks are not re-editable after saving) and add the Task 9 Android items to the manual checklist section (same checkbox style as the existing entries).

- [ ] **Step 5: Commit**

```bash
git add README.md docs
git commit -m "docs: document PDF mark-up and its manual checks

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Tools (highlight, ink, note, eraser, undo/redo): Tasks 1, 5, 6, 7.
- Model in page units, overlay inherits transform: Tasks 1, 4, 5.
- Text layer for highlight, scanned-PDF message: Task 6.
- Toolbar; no tool = unchanged viewer; tool active = one finger marks, two fingers pinch: Tasks 4, 5, 7.
- pdf-lib export with Highlight/Ink/FreeText: Task 3. Spec said "PDF page coordinates"; the plan stores page units (scale 1, y down) and converts with pdf.js `convertToPdfPoint` at export. This is a deliberate refinement: rotation and CropBox become pdf.js's responsibility.
- Save as via Rust command and dialog; original never modified: Task 8.
- Unsaved-marks confirmation: Task 8 Step 4.
- Android SAF create-document: Tasks 8 and 9.
- Errors via `reportError`/status channel; model kept on failure: Tasks 3, 8.
- Tests: model, geometry, export round-trip (pdf-lib reload instead of pdf.js, to avoid needing the pdf.js legacy build in Node), manual device checks.

**Placeholder scan:** The only deferrals are explicit verification checkpoints (Android write permission, API-name checks) with concrete fallback instructions.

**Type consistency:** `store` methods (`add/remove/undo/redo/all/marksOnPage/subscribe/markSaved/isDirty/clear/canUndo/canRedo`), mark shapes, controller methods (`handlePageRendered/handlePageUnloaded/setTool/getTool/setColor/getColor`), hook names (`setPageRenderedHook/setPageUnloadedHook/setDocumentChangeHook/setPanEnabled/getOpenPdf`) and `exportAnnotatedPdf({ bytes, marks, pages, renderNoteImage })` are used identically across tasks.

**Known risk to flag when executing:** Task 6 (text-layer alignment and caret hit-testing) and Task 9 (Android write) cannot be fully proven by unit tests; they are checked by hand.
