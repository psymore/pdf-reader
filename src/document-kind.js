// Identifies what kind of document a file is — from its bytes (reliable even
// for Android content:// URIs, which carry no extension) or from its name
// (drag-and-drop paths and sidebar entries, before any bytes are read).

export const LEGACY_DOC_MESSAGE =
  "Old Word .doc files aren't supported. Open the file in Word, save it as .docx, and open that instead.";
export const UNSUPPORTED_DROP_MESSAGE = "Please drop a PDF or Word (.docx) file.";

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const ZIP_HEADER = [0x50, 0x4b, 0x03, 0x04]; // a .docx is a ZIP package
const OLE_HEADER = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // legacy .doc
// PDF readers tolerate junk before the header, within the first 1024 bytes.
const PDF_HEADER_SEARCH_LIMIT = 1024;

function matchesAt(bytes, signature, offset) {
  if (offset + signature.length > bytes.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

export function detectDocumentKind(bytes) {
  if (matchesAt(bytes, ZIP_HEADER, 0)) return "docx";
  if (matchesAt(bytes, OLE_HEADER, 0)) return "doc";
  const searchEnd = Math.min(bytes.length, PDF_HEADER_SEARCH_LIMIT);
  for (let offset = 0; offset < searchEnd; offset += 1) {
    if (matchesAt(bytes, PDF_HEADER, offset)) return "pdf";
  }
  return null;
}

export function documentKindFromName(name) {
  const lower = String(name ?? "").toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".doc")) return "doc";
  return null;
}

export function pickDroppedPath(paths) {
  const supported = paths.find((path) => {
    const kind = documentKindFromName(path);
    return kind === "pdf" || kind === "docx";
  });
  if (supported) return { path: supported };
  if (paths.some((path) => documentKindFromName(path) === "doc")) {
    return { error: LEGACY_DOC_MESSAGE };
  }
  return { error: UNSUPPORTED_DROP_MESSAGE };
}
