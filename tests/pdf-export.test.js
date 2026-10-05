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
