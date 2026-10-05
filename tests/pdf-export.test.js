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

  it("skips marks with empty or non-finite geometry and marks on missing pages", async () => {
    const bytes = await samplePdf();
    const marks = [
      { id: "e1", type: "highlight", page: 1, color: "#ffeb3b", rects: [] },
      { id: "e2", type: "ink", page: 1, color: "#000000", width: 2, points: [] },
      { id: "e3", type: "ink", page: 1, color: "#000000", width: NaN, points: [{ x: 0, y: 0 }] },
      { id: "e4", type: "ink", page: 1, color: "#000000", width: 2, points: [{ x: NaN, y: 0 }] },
      { id: "e5", type: "highlight", page: 9, color: "#ffeb3b", rects: [{ x: 1, y: 1, w: 5, h: 5 }] },
    ];
    const out = await exportAnnotatedPdf({ bytes, marks, pages: [flip] });
    const doc = await PDFDocument.load(out);
    expect(doc.getPage(0).node.has(PDFName.of("Annots"))).toBe(false);
  });

  it("gives a rotated note's appearance a Matrix and a swapped Rect", async () => {
    const bytes = await samplePdf();
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const rotated = { toPdf: (x, y) => [y + 5, x + 7] };
    const marks = [{ id: "r1", type: "note", page: 1, color: "#000000", x: 30, y: 40, text: "hi" }];
    const out = await exportAnnotatedPdf({
      bytes, marks, pages: [rotated],
      renderNoteImage: async () => ({ png, width: 80, height: 20 }),
    });
    const [annot] = await annotsOf(out);
    // view corners x 30..110, y 40..60 -> pdf x = y + 5 (45..65), y = x + 7 (37..117)
    expect(num(annot, "Rect")).toEqual([45, 37, 65, 117]);
    const ap = annot.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"));
    // P0 = toPdf(30, 60) = [65, 37]; dU = toPdf(31, 60) - P0 = [0, 1]; dV = toPdf(30, 59) - P0 = [-1, 0]
    expect(num(ap.dict, "Matrix")).toEqual([0, 1, -1, 0, 65, 37]);
    expect(num(ap.dict, "BBox")).toEqual([0, 0, 80, 20]);
  });

  it("appends to an /Annots that is an indirect reference to an array", async () => {
    const src = await PDFDocument.load(await samplePdf());
    const page = src.getPage(0);
    const existing = src.context.register(src.context.obj({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 5, 5] }));
    const arrRef = src.context.register(src.context.obj([existing]));
    page.node.set(PDFName.of("Annots"), arrRef);
    const bytes = new Uint8Array(await src.save());
    const marks = [{ id: "i1", type: "ink", page: 1, color: "#000000", width: 2, points: [{ x: 0, y: 0 }, { x: 9, y: 9 }] }];
    const out = await exportAnnotatedPdf({ bytes, marks, pages: [flip] });
    const annots = await annotsOf(out);
    expect(annots).toHaveLength(2);
    expect(name(annots[0], "Subtype")).toBe("/Text");
    expect(name(annots[1], "Subtype")).toBe("/Ink");
  });

  it("still exports when a page's /Annots is not an array", async () => {
    const src = await PDFDocument.load(await samplePdf());
    src.getPage(0).node.set(PDFName.of("Annots"), PDFName.of("Broken"));
    const bytes = new Uint8Array(await src.save());
    const marks = [{ id: "i2", type: "ink", page: 1, color: "#000000", width: 2, points: [{ x: 0, y: 0 }, { x: 9, y: 9 }] }];
    const out = await exportAnnotatedPdf({ bytes, marks, pages: [flip] });
    expect(await annotsOf(out)).toHaveLength(1);
  });
});
