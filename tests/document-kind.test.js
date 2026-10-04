import { describe, it, expect } from "vitest";
import {
  LEGACY_DOC_MESSAGE,
  UNSUPPORTED_DROP_MESSAGE,
  detectDocumentKind,
  documentKindFromName,
  pickDroppedPath,
} from "../src/document-kind.js";

function bytesOf(text) {
  return new TextEncoder().encode(text);
}

describe("detectDocumentKind", () => {
  it("detects a PDF header at the start", () => {
    expect(detectDocumentKind(bytesOf("%PDF-1.7\n..."))).toBe("pdf");
  });

  it("detects a PDF header after leading junk bytes", () => {
    expect(detectDocumentKind(bytesOf("\n\r  garbage %PDF-1.4 rest"))).toBe("pdf");
  });

  it("does not look for a PDF header past the first 1024 bytes", () => {
    const padded = bytesOf(`${"x".repeat(1100)}%PDF-1.4`);
    expect(detectDocumentKind(padded)).toBe(null);
  });

  it("detects a .docx (ZIP package) header", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
    expect(detectDocumentKind(zip)).toBe("docx");
  });

  it("detects a legacy .doc (OLE compound file) header", () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);
    expect(detectDocumentKind(ole)).toBe("doc");
  });

  it("returns null for empty, truncated or unknown bytes", () => {
    expect(detectDocumentKind(new Uint8Array())).toBe(null);
    expect(detectDocumentKind(new Uint8Array([0x50, 0x4b]))).toBe(null);
    expect(detectDocumentKind(bytesOf("just some text"))).toBe(null);
  });
});

describe("documentKindFromName", () => {
  it("maps extensions case-insensitively", () => {
    expect(documentKindFromName("a.PDF")).toBe("pdf");
    expect(documentKindFromName("C:\\Docs\\Report.DOCX")).toBe("docx");
    expect(documentKindFromName("/home/me/old.doc")).toBe("doc");
  });

  it("returns null for other or missing names", () => {
    expect(documentKindFromName("backup.docx.bak")).toBe(null);
    expect(documentKindFromName("notes.txt")).toBe(null);
    expect(documentKindFromName("")).toBe(null);
    expect(documentKindFromName(undefined)).toBe(null);
  });
});

describe("pickDroppedPath", () => {
  it("returns the first supported path in drop order", () => {
    expect(pickDroppedPath(["notes.txt", "b.docx", "a.pdf"])).toEqual({ path: "b.docx" });
  });

  it("prefers a supported file over a legacy .doc", () => {
    expect(pickDroppedPath(["old.doc", "new.pdf"])).toEqual({ path: "new.pdf" });
  });

  it("explains legacy .doc files when only those were dropped", () => {
    expect(pickDroppedPath(["old.doc"])).toEqual({ error: LEGACY_DOC_MESSAGE });
  });

  it("asks for a supported file otherwise", () => {
    expect(pickDroppedPath(["image.png"])).toEqual({ error: UNSUPPORTED_DROP_MESSAGE });
    expect(pickDroppedPath([])).toEqual({ error: UNSUPPORTED_DROP_MESSAGE });
  });
});
