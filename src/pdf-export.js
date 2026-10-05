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

const allFinite = (list) => list.every((n) => Number.isFinite(n));

function appendAnnot(doc, page, dict) {
  const ref = doc.context.register(doc.context.obj(dict));
  let existing;
  try {
    existing = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  } catch {
    existing = undefined; // malformed /Annots: start a fresh array
  }
  if (existing) {
    existing.push(ref);
  } else {
    page.node.set(PDFName.of("Annots"), doc.context.obj([ref]));
  }
}

function formStream(doc, content, box, resources = {}, matrix = null) {
  const dict = {
    Type: "XObject",
    Subtype: "Form",
    BBox: box.map(f),
    Resources: resources,
  };
  if (matrix) dict.Matrix = matrix.map(f);
  return doc.context.register(doc.context.stream(content, dict));
}

function highlightAnnot(doc, mark, toPdf) {
  if (!Array.isArray(mark.rects) || mark.rects.length === 0) return null;
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
  if (!allFinite(quads)) return null;
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
  if (!Array.isArray(mark.points) || mark.points.length === 0) return null;
  const color = hexToRgb(mark.color);
  const pts = mark.points.map((p) => toPdf(p.x, p.y));
  if (!allFinite(pts.flat()) || !Number.isFinite(mark.width)) return null;
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
  const corners = [
    toPdf(mark.x, mark.y),
    toPdf(mark.x + width, mark.y),
    toPdf(mark.x, mark.y + height),
    toPdf(mark.x + width, mark.y + height),
  ];
  if (!allFinite(corners.flat())) return null;
  const rect = bbox(corners);
  if (image) {
    const png = await doc.embedPng(image.png);
    // Form-local (u, v), y up, maps to view point (x + u, y + height - v).
    const p0 = toPdf(mark.x, mark.y + height);
    const pu = toPdf(mark.x + 1, mark.y + height);
    const pv = toPdf(mark.x, mark.y + height - 1);
    const matrix = [pu[0] - p0[0], pu[1] - p0[1], pv[0] - p0[0], pv[1] - p0[1], p0[0], p0[1]];
    if (!allFinite(matrix)) return null;
    const name = "Im0";
    apRef = formStream(
      doc,
      `q ${f(width)} 0 0 ${f(height)} 0 0 cm /${name} Do Q`,
      [0, 0, width, height],
      { XObject: { [name]: png.ref } },
      matrix
    );
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
