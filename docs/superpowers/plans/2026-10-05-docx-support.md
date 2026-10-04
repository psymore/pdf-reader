# Word (.docx) Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open `.docx` Word files read-only in the app (desktop + Android) next to PDFs, without changing PDF behavior.

**Architecture:** The frontend sniffs each opened file's bytes and routes it to either the existing PDF.js viewer (`src/viewer.js`, `#viewer-container`) or a new docx-preview-based viewer (`src/docx-viewer.js`, `#docx-container`). Only one viewer is loaded at a time. The Rust side only changes which extensions are accepted and renames the two open commands.

**Tech Stack:** Tauri 2 (Rust), plain HTML/CSS/ES-module JS with no bundler, vendored PDF.js, vendored docx-preview 0.4.1 + JSZip 3.10.2 (UMD builds), Vitest for pure-function tests, `cargo test` for Rust.

**Spec:** `docs/superpowers/specs/2026-10-05-docx-support-design.md`

## Global Constraints

- Work on branch `feature/docx-support` (already created). Never commit to `main`. Never use git worktrees. Do not merge or push — the user does that (their "CMP" rule).
- No bundler: everything in `src/` is served as-is. Third-party code is vendored under `src/vendor/`.
- Exact versions: `docx-preview@0.4.1`, `jszip@3.10.2`. docx-preview's UMD build reads the global `JSZip`, so `jszip.min.js` must load **before** `docx-preview.min.js`, and both before `main.js`.
- Only `.docx` is supported. Legacy `.doc` shows exactly: `Old Word .doc files aren't supported. Open the file in Word, save it as .docx, and open that instead.`
- Do not change `productName`, `identifier`, the window title, `<title>`, or `#app-title` ("PDF Reader").
- PDF behavior (layouts, zoom, gestures, sidebar) must be unchanged.
- Run from repo root unless stated: `npm test` (Vitest). Rust: `cargo test` from `src-tauri/`. JS syntax check: `node --check <file>`.
- The app GUI can't be driven by an agent. Steps marked **Manual check (user)** must be listed in your report for the user to run with `npm run tauri dev`; do not claim them as done.

## Review Focus

1. **A hyperlink inside a Word document is clicked** → the app window must not navigate away; bookmark links scroll within the document. (Task 5, manual check.)
2. **Switching kinds: PDF → DOCX → PDF and DOCX → DOCX** → the previous document is fully cleared, the side-by-side button is hidden only for DOCX, and toolbar/keyboard zoom affect the visible document. (Task 5, manual check.)
3. **A file whose name lies** (PDF renamed `.docx`, DOCX renamed `.pdf`, Android `content://` with no extension) → opens in the viewer matching its bytes. (Task 1 unit tests pin the sniffing; Task 5 manual check pins the wiring.)
4. **Phone-width screens and landscape/wide pages** → the page fits the width on open, and when zoomed in nothing is clipped on the left (horizontal scroll reaches the page's left edge). (Task 2 unit tests pin fit math; Task 5 manual check.)
5. **Opening a second file while the first is still rendering** → only the second one ends up shown, with matching toolbar. (Task 5 sequence guard + manual check.)

---

### Task 1: Document-kind detection module

Pure functions that decide what a file is, from bytes or from a name.

**Files:**
- Create: `src/document-kind.js`
- Test: `tests/document-kind.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (all named exports of `src/document-kind.js`):
  - `LEGACY_DOC_MESSAGE: string`
  - `UNSUPPORTED_DROP_MESSAGE: string`
  - `detectDocumentKind(bytes: Uint8Array): "pdf" | "docx" | "doc" | null`
  - `documentKindFromName(name: string | null | undefined): "pdf" | "docx" | "doc" | null`
  - `pickDroppedPath(paths: string[]): { path: string } | { error: string }`

- [ ] **Step 1: Write the failing test**

Create `tests/document-kind.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/document-kind.test.js`
Expected: FAIL — cannot resolve `../src/document-kind.js`.

- [ ] **Step 3: Write the implementation**

Create `src/document-kind.js`:

```js
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
```

Note the "first 1024 bytes" test: the header `%PDF-` must *start* before offset 1024; at offset 1100 it is ignored.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all test files PASS (the existing 24 tests plus the new ones).

- [ ] **Step 5: Commit** (includes the spec and this plan)

```bash
git add src/document-kind.js tests/document-kind.test.js docs/superpowers/specs/2026-10-05-docx-support-design.md docs/superpowers/plans/2026-10-05-docx-support.md
git commit -m "feat: add document kind detection for PDF and Word files"
```

---

### Task 2: Word zoom math

Pure zoom helpers for the Word viewer, kept separate so they're unit-testable without a DOM.

**Files:**
- Create: `src/docx-zoom.js`
- Test: `tests/docx-zoom.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (named exports of `src/docx-zoom.js`):
  - `DOCX_MIN_ZOOM = 0.25`, `DOCX_MAX_ZOOM = 4`, `DOCX_ZOOM_STEP = 0.2`
  - `clampDocxZoom(zoom: number): number`
  - `stepDocxZoom(current: number, direction: number): number` — `direction > 0` zooms in.
  - `fitDocxZoom(availableWidth: number, pageWidth: number): number` — fit width, never above 1.
  - `pinchDocxZoom(startZoom: number, startDistance: number, currentDistance: number): number`
  - `scrollForZoom(scroll: number, anchor: number, previousZoom: number, nextZoom: number): number` — new scroll offset that keeps the content under `anchor` (px from the container's edge) in place; never negative.

- [ ] **Step 1: Write the failing test**

Create `tests/docx-zoom.test.js`:

```js
import { describe, it, expect } from "vitest";
import {
  DOCX_MAX_ZOOM,
  DOCX_MIN_ZOOM,
  clampDocxZoom,
  fitDocxZoom,
  pinchDocxZoom,
  scrollForZoom,
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

describe("scrollForZoom", () => {
  it("keeps the anchored content point under the anchor", () => {
    // content at scroll 100 + anchor 200 = 300 doubles to 600; minus anchor 200
    expect(scrollForZoom(100, 200, 1, 2)).toBe(400);
  });

  it("never returns a negative scroll offset", () => {
    expect(scrollForZoom(0, 200, 2, 1)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/docx-zoom.test.js`
Expected: FAIL — cannot resolve `../src/docx-zoom.js`.

- [ ] **Step 3: Write the implementation**

Create `src/docx-zoom.js`:

```js
export const DOCX_MIN_ZOOM = 0.25;
export const DOCX_MAX_ZOOM = 4;
export const DOCX_ZOOM_STEP = 0.2;

export function clampDocxZoom(zoom) {
  return Math.min(DOCX_MAX_ZOOM, Math.max(DOCX_MIN_ZOOM, zoom));
}

export function stepDocxZoom(current, direction) {
  const factor = direction > 0 ? 1 + DOCX_ZOOM_STEP : 1 / (1 + DOCX_ZOOM_STEP);
  return clampDocxZoom(current * factor);
}

// Word pages open at their real size when they fit, and shrink to the
// screen width when they don't (phones, narrow windows) — never enlarged.
export function fitDocxZoom(availableWidth, pageWidth) {
  if (!(availableWidth > 0) || !(pageWidth > 0)) return 1;
  return clampDocxZoom(Math.min(1, availableWidth / pageWidth));
}

export function pinchDocxZoom(startZoom, startDistance, currentDistance) {
  if (!(startDistance > 0)) return clampDocxZoom(startZoom);
  return clampDocxZoom((startZoom * currentDistance) / startDistance);
}

export function scrollForZoom(scroll, anchor, previousZoom, nextZoom) {
  return Math.max(0, ((scroll + anchor) * nextZoom) / previousZoom - anchor);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/docx-zoom.js tests/docx-zoom.test.js
git commit -m "feat: add zoom math for the Word document viewer"
```

---

### Task 3: Rust — accept .docx at every entry point

**Files:**
- Modify: `src-tauri/src/commands.rs` (whole file shown below)
- Modify: `src-tauri/src/lib.rs` (handler list)
- Modify: `src-tauri/tauri.conf.json` (`bundle.fileAssociations`)
- Modify: `src/main.js` (two `invoke` command names only)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Tauri commands `open_document_file()` and `open_document_path({ path })` — same behavior and return value (raw file bytes as an `ArrayBuffer`) as the old `open_pdf_file` / `open_pdf_path`, which are removed.
  - `get_launch_path()` now also returns `.docx` paths.
  - Rust: `pub const SUPPORTED_EXTENSIONS: &[&str]`, `pub fn is_supported_document(path: &str) -> bool`, `pub fn read_file_bytes(path: &Path) -> Result<Vec<u8>, String>` (renamed from `read_pdf_bytes`).

- [ ] **Step 1: Write the failing Rust tests**

In `src-tauri/src/commands.rs`, replace the whole `#[cfg(test)] mod tests { ... }` block at the bottom with:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_existing_file_bytes() {
        let mut tmp = std::env::temp_dir();
        tmp.push("pdf_reader_test_read.bin");
        let mut f = fs::File::create(&tmp).unwrap();
        f.write_all(b"%PDF-1.4 test bytes").unwrap();

        let result = read_file_bytes(&tmp).unwrap();
        assert_eq!(result, b"%PDF-1.4 test bytes");

        fs::remove_file(&tmp).unwrap();
    }

    #[test]
    fn errors_on_missing_file() {
        let missing = Path::new("this_file_does_not_exist_pdf_reader.pdf");
        let result = read_file_bytes(missing);
        assert!(result.is_err());
    }

    #[test]
    fn accepts_pdf_and_docx_in_any_case() {
        assert!(is_supported_document("a.pdf"));
        assert!(is_supported_document("C:\\Docs\\Report.PDF"));
        assert!(is_supported_document("/home/me/notes.docx"));
        assert!(is_supported_document("Notes.DocX"));
    }

    #[test]
    fn rejects_other_files() {
        assert!(!is_supported_document("old.doc"));
        assert!(!is_supported_document("archive.docx.zip"));
        assert!(!is_supported_document("docx"));
        assert!(!is_supported_document("--flag"));
        assert!(!is_supported_document(""));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `src-tauri/`): `cargo test`
Expected: compile error — `read_file_bytes` / `is_supported_document` not found.

- [ ] **Step 3: Implement**

In `src-tauri/src/commands.rs`, replace everything **above** the test module with:

```rust
use crate::recent_files::{self, RecentEntry};
use std::fs;
use std::io::Read as _;
use std::path::Path;
use tauri::Manager;
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

/// File extensions the app can open (lowercase, no dot).
pub const SUPPORTED_EXTENSIONS: &[&str] = &["pdf", "docx"];

/// True when `path` ends in one of `SUPPORTED_EXTENSIONS`, ignoring case.
pub fn is_supported_document(path: &str) -> bool {
    let lower = path.to_lowercase();
    SUPPORTED_EXTENSIONS
        .iter()
        .any(|ext| lower.ends_with(&format!(".{ext}")))
}

pub fn read_file_bytes(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("Failed to read file: {e}"))
}

fn file_name_or_path(app: &tauri::AppHandle, file_path: &FilePath) -> Result<String, String> {
    let path = file_path.to_string();
    app.path()
        .file_name(&path)
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "Could not retrieve the document name from file metadata".to_string())
}

/// Reads a document's bytes — via a direct filesystem read for a regular
/// path, or via the fs plugin's Android content-resolver bridge for a
/// `content://` URI (what the native file picker returns on Android/scoped
/// storage).
fn read_bytes(app: &tauri::AppHandle, file_path: &FilePath) -> Result<Vec<u8>, String> {
    if let Some(path) = file_path.as_path() {
        return read_file_bytes(path);
    }

    let mut file = app
        .fs()
        .open(file_path.clone(), OpenOptions::new().read(true).clone())
        .map_err(|e| format!("Failed to open file: {e}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read file: {e}"))?;
    Ok(bytes)
}

/// Reads a document's bytes, records it in the recent-files list, and
/// returns the bytes as an IPC response. Shared by both
/// `open_document_file` (native dialog) and `open_document_path`
/// (drag-drop / sidebar reopen / launch path). The frontend decides from
/// the bytes whether it is a PDF or a Word file.
fn open_filepath_and_record(
    app: &tauri::AppHandle,
    file_path: FilePath,
) -> Result<tauri::ipc::Response, String> {
    let path_str = file_path.to_string();
    let name = file_name_or_path(app, &file_path)?;
    let bytes = read_bytes(app, &file_path)?;

    let entries = recent_files::load(app);
    let entries = recent_files::upsert_and_trim(
        entries,
        &path_str,
        &name,
        recent_files::now_millis(),
        recent_files::RECENT_CAP,
    );
    recent_files::save(app, &entries)?;

    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn open_document_file(app: tauri::AppHandle) -> Result<tauri::ipc::Response, String> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app
        .dialog()
        .file()
        .add_filter("PDF or Word document", SUPPORTED_EXTENSIONS)
        .blocking_pick_file();

    match file_path {
        Some(path) => open_filepath_and_record(&app, path),
        None => Err("cancelled".to_string()),
    }
}

#[tauri::command]
pub async fn open_document_path(
    app: tauri::AppHandle,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let file_path: FilePath = path.parse().expect("FilePath parsing is infallible");
    open_filepath_and_record(&app, file_path)
}

/// Returns the document path passed on the command line, if any — this is
/// how Windows launches the app for "Open with" / file-association
/// double-click.
#[tauri::command]
pub fn get_launch_path() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| is_supported_document(arg))
}

#[tauri::command]
pub fn get_recent_files(app: tauri::AppHandle) -> Vec<RecentEntry> {
    recent_files::load(&app)
}

#[tauri::command]
pub fn toggle_pin(app: tauri::AppHandle, path: String) -> Result<Vec<RecentEntry>, String> {
    let entries = recent_files::load(&app);
    let entries = recent_files::toggle_pin(entries, &path);
    recent_files::save(&app, &entries)?;
    Ok(entries)
}

#[tauri::command]
pub fn remove_recent_entry(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<RecentEntry>, String> {
    let entries = recent_files::load(&app);
    let entries = recent_files::remove_entry(entries, &path);
    recent_files::save(&app, &entries)?;
    Ok(entries)
}
```

If `add_filter` rejects `SUPPORTED_EXTENSIONS` with a type error, pass `&["pdf", "docx"]` instead (same values) — don't change anything else.

In `src-tauri/src/lib.rs`, replace these two lines:

```rust
            commands::open_pdf_file,
            commands::open_pdf_path,
```

with:

```rust
            commands::open_document_file,
            commands::open_document_path,
```

In `src-tauri/tauri.conf.json`, replace the `fileAssociations` array with:

```json
    "fileAssociations": [
      {
        "ext": ["pdf"],
        "name": "PDF Document",
        "description": "PDF Document",
        "role": "Viewer",
        "mimeType": "application/pdf"
      },
      {
        "ext": ["docx"],
        "name": "Word Document",
        "description": "Word Document",
        "role": "Viewer",
        "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      }
    ]
```

In `src/main.js`, change exactly these two strings (nothing else in this task):
- `invoke("open_pdf_file")` → `invoke("open_document_file")`
- `invoke("open_pdf_path", { path })` → `invoke("open_document_path", { path })`

- [ ] **Step 4: Run tests and checks**

Run (from `src-tauri/`): `cargo test`
Expected: all Rust tests PASS (12 existing + 2 new = 14).

Run (repo root): `node --check src/main.js && npm test`
Expected: no syntax errors; all Vitest tests PASS.

Run: `grep -rn "open_pdf_" src src-tauri/src`
Expected: no matches.

- [ ] **Step 5: Manual check (user)**

`npm run tauri dev` → open a PDF via the toolbar button, via drag-and-drop, and via the sidebar. It must behave exactly as before. (The picker now also lists `.docx`; opening one shows a PDF error until Task 5 — expected at this point.)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/tauri.conf.json src/main.js
git commit -m "feat: accept .docx files in the picker, launch path and file associations"
```

---

### Task 4: Let the PDF viewer release its document

The Word viewer must be able to unload the PDF viewer completely (no hidden PDF re-rendering on resize, no stale zoom timers). Extract the reset that `renderPdf` already does into an exported `closePdf()`.

**Files:**
- Modify: `src/viewer.js` (the start of `renderPdf`, around lines 520–535)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export async function closePdf(): Promise<void>` in `src/viewer.js` — safe to call when no PDF is open; afterwards `zoomByStep`/`resetZoom`/`setPageMode` are no-ops until the next `renderPdf`.

- [ ] **Step 1: Implement**

In `src/viewer.js`, find this exact block:

```js
export async function renderPdf(bytes) {
  pageObserver?.disconnect();
  cancelAllPageRenders();
  pagesWrapper.replaceChildren();
  const previousLoadingTask = pdfLoadingTask;
  pdfLoadingTask = null;
  pdfDoc = null;
  pages = [];
  pageModePreference = null;
  renderGeneration += 1;
  if (previousLoadingTask) {
    await previousLoadingTask.destroy();
  }
  try {
```

and replace it with:

```js
// Releases the open PDF (page renders, observer, pending timers, the PDF.js
// document) and clears the page area. Safe to call when nothing is open.
export async function closePdf() {
  clearTimeout(zoomDebounceTimer);
  clearTimeout(resizeDebounceTimer);
  pageObserver?.disconnect();
  pageObserver = null;
  cancelAllPageRenders();
  pagesWrapper.replaceChildren();
  const previousLoadingTask = pdfLoadingTask;
  pdfLoadingTask = null;
  pdfDoc = null;
  pages = [];
  gesture = null;
  pendingZoomAnchor = null;
  renderedContentWidth = 0;
  renderedContentHeight = 0;
  renderGeneration += 1;
  if (previousLoadingTask) {
    await previousLoadingTask.destroy();
  }
}

export async function renderPdf(bytes) {
  await closePdf();
  pageModePreference = null;
  try {
```

Everything after `try {` stays unchanged.

- [ ] **Step 2: Run checks**

Run: `node --check src/viewer.js && npm test`
Expected: no syntax errors; all tests PASS.

- [ ] **Step 3: Manual check (user)**

`npm run tauri dev`: open a PDF, zoom in, open a different PDF, resize the window, toggle side-by-side. Behavior is unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/viewer.js
git commit -m "refactor: expose closePdf so the PDF viewer can be unloaded"
```

---

### Task 5: Word viewer and wiring

Vendor docx-preview, add the Word viewer, and route opened files by their bytes. After this task, `.docx` files open end-to-end.

**Files:**
- Modify: `package.json`, `package-lock.json` (via npm)
- Create: `src/vendor/docx-preview/jszip.min.js`, `src/vendor/docx-preview/docx-preview.min.js`, `src/vendor/docx-preview/LICENSE-jszip.md`, `src/vendor/docx-preview/LICENSE-docx-preview`
- Create: `src/docx-viewer.js`
- Modify: `src/index.html`
- Modify: `src/styles.css` (append)
- Modify: `src/main.js` (full replacement below)

**Interfaces:**
- Consumes:
  - From Task 1: `detectDocumentKind`, `pickDroppedPath`, `LEGACY_DOC_MESSAGE` (`src/document-kind.js`).
  - From Task 2: `DOCX_MIN_ZOOM`, `DOCX_MAX_ZOOM`, `clampDocxZoom`, `fitDocxZoom`, `scrollForZoom`, `stepDocxZoom` (`src/docx-zoom.js`).
  - From Task 3: commands `open_document_file`, `open_document_path`.
  - From Task 4: `closePdf()` (`src/viewer.js`).
  - From `src/zoom.js` (existing): `computeZoom(currentZoom, deltaY, { min, max })`.
  - Global `window.docx.renderAsync(data, bodyContainer, styleContainer, options)` from the vendored docx-preview UMD build.
- Produces (named exports of `src/docx-viewer.js`; Task 6 adds to this file):
  - `renderDocx(bytes: Uint8Array): Promise<void>` — throws a string starting `Could not open Word document:` on failure; resolves without showing anything if superseded by `closeDocx()`/another `renderDocx()` mid-render.
  - `closeDocx(): void`
  - `zoomDocxByStep(direction: number): void`
  - `resetDocxZoom(): void`
  - Module-level state Task 6 uses: `container`, `loaded`, `zoomLevel`, `setZoom(nextZoom, anchorX, anchorY)`, `containerPoint(clientX, clientY)`, and `let pinch = null` (reset in `closeDocx`).

- [ ] **Step 1: Vendor the libraries**

Run (Git Bash, repo root):

```bash
npm install --save-exact docx-preview@0.4.1 jszip@3.10.2
mkdir -p src/vendor/docx-preview
cp node_modules/jszip/dist/jszip.min.js src/vendor/docx-preview/jszip.min.js
cp node_modules/jszip/LICENSE.markdown src/vendor/docx-preview/LICENSE-jszip.md
cp node_modules/docx-preview/dist/docx-preview.min.js src/vendor/docx-preview/docx-preview.min.js
cp node_modules/docx-preview/LICENSE src/vendor/docx-preview/LICENSE-docx-preview
ls src/vendor/docx-preview
```

Expected: the four files listed. `package.json` `dependencies` now contains `"docx-preview": "0.4.1"` and `"jszip": "3.10.2"`.

- [ ] **Step 2: Update `src/index.html`**

a) Directly **above** `<script type="module" src="/main.js" defer></script>`, add:

```html
    <!-- docx-preview's UMD build reads the global JSZip, so JSZip loads first -->
    <script src="/vendor/docx-preview/jszip.min.js"></script>
    <script src="/vendor/docx-preview/docx-preview.min.js"></script>
```

b) Replace the open button's opening tag:

```html
      <button id="open-btn" class="icon-btn" title="Open a PDF" aria-label="Open a PDF file">
```

with:

```html
      <button id="open-btn" class="icon-btn" title="Open a PDF or Word file" aria-label="Open a PDF or Word file">
```

c) Replace `<span>Loading PDF...</span>` with `<span>Loading document...</span>`.

d) Replace `<p id="empty-state-text">Drop a PDF here or click to open</p>` with `<p id="empty-state-text">Drop a PDF or Word file here or click to open</p>`.

e) Replace:

```html
        <div id="viewer-container" hidden><div id="pdf-pages"></div></div>
```

with:

```html
        <div id="viewer-container" hidden><div id="pdf-pages"></div></div>
        <div id="docx-container" hidden><div id="docx-pages"></div></div>
```

- [ ] **Step 3: Append the Word viewer styles to `src/styles.css`**

Append at the end of the file:

```css
/* Word documents: native scrolling (unlike #viewer-container, which drives
   pan/zoom itself). Zoom is CSS `zoom` on #docx-pages, set in
   docx-viewer.js, so scroll extents follow the zoomed size automatically. */
#docx-container {
  height: 100%;
  overflow: auto;
  padding: 24px 16px 64px;
  overscroll-behavior: contain;
  /* browser scrolls; two-finger pinch is handled in docx-viewer.js */
  touch-action: pan-x pan-y;
}

#docx-container[hidden] {
  display: none;
}

/* max-content + auto margins centers narrow pages but lets wide (zoomed)
   pages overflow to the right, so the left edge is always reachable by
   scrolling — flex centering would clip it. */
#docx-pages {
  width: max-content;
  margin: 0 auto;
}

/* Override docx-preview's own grey wrapper so pages sit on the app canvas. */
#docx-pages .docx-wrapper {
  background: transparent;
  padding: 0;
}

#docx-pages .docx-wrapper > section.docx {
  margin-bottom: 16px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
}

@media (max-width: 640px) {
  #docx-container {
    padding: 12px 12px 64px;
  }

  #docx-pages .docx-wrapper > section.docx {
    margin-bottom: 12px;
  }
}
```

- [ ] **Step 4: Create `src/docx-viewer.js`**

```js
import { computeZoom } from "./zoom.js";
import {
  DOCX_MAX_ZOOM,
  DOCX_MIN_ZOOM,
  clampDocxZoom,
  fitDocxZoom,
  scrollForZoom,
  stepDocxZoom,
} from "./docx-zoom.js";

const container = document.getElementById("docx-container");
const pagesEl = document.getElementById("docx-pages");

// Keep Word's page boundaries, headers/footers and notes. Images are
// embedded as data URLs so no blob: URLs leak across documents.
const RENDER_OPTIONS = {
  className: "docx",
  inWrapper: true,
  breakPages: true,
  ignoreLastRenderedPageBreak: true,
  renderHeaders: true,
  renderFooters: true,
  renderFootnotes: true,
  renderEndnotes: true,
  useBase64URL: true,
};
const RESIZE_SETTLE_DELAY = 150;

let loaded = false;
let zoomLevel = 1;
let fitZoom = 1;
let naturalPageWidth = 0;
let renderGeneration = 0;
let resizeTimer = null;
let pinch = null;

function availableWidth() {
  const style = getComputedStyle(container);
  const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  return container.clientWidth - padding;
}

// Measured once per document at zoom 1, so later zoom changes don't skew it.
function measureWidestPage() {
  let widest = 0;
  for (const section of pagesEl.querySelectorAll("section.docx")) {
    widest = Math.max(widest, section.offsetWidth);
  }
  return widest;
}

function containerPoint(clientX, clientY) {
  const rect = container.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

// Applies a new zoom while keeping the content under (anchorX, anchorY) —
// container-relative px, default the center — where it was.
function setZoom(nextZoom, anchorX = container.clientWidth / 2, anchorY = container.clientHeight / 2) {
  const previous = zoomLevel;
  zoomLevel = clampDocxZoom(nextZoom);
  if (zoomLevel === previous) return;
  const left = scrollForZoom(container.scrollLeft, anchorX, previous, zoomLevel);
  const top = scrollForZoom(container.scrollTop, anchorY, previous, zoomLevel);
  pagesEl.style.zoom = String(zoomLevel);
  container.scrollLeft = left;
  container.scrollTop = top;
}

export async function renderDocx(bytes) {
  closeDocx();
  const generation = renderGeneration;
  const renderer = window.docx;
  if (!renderer?.renderAsync) {
    throw "Could not open Word document: the Word renderer failed to load";
  }
  // Render off-screen, then swap in: a render that a newer open superseded
  // must not overwrite what that newer open shows.
  const staging = document.createElement("div");
  try {
    await renderer.renderAsync(bytes, staging, staging, RENDER_OPTIONS);
  } catch (err) {
    throw `Could not open Word document: ${err?.message || err}`;
  }
  if (generation !== renderGeneration) return;

  pagesEl.style.zoom = "1";
  pagesEl.replaceChildren(...staging.childNodes);
  loaded = true;
  naturalPageWidth = measureWidestPage();
  fitZoom = fitDocxZoom(availableWidth(), naturalPageWidth);
  zoomLevel = fitZoom;
  pagesEl.style.zoom = String(zoomLevel);
  container.scrollTop = 0;
  container.scrollLeft = 0;
}

export function closeDocx() {
  renderGeneration += 1;
  clearTimeout(resizeTimer);
  loaded = false;
  pinch = null;
  zoomLevel = 1;
  fitZoom = 1;
  naturalPageWidth = 0;
  pagesEl.style.zoom = "1";
  pagesEl.replaceChildren();
}

export function zoomDocxByStep(direction) {
  if (!loaded) return;
  setZoom(stepDocxZoom(zoomLevel, direction));
}

export function resetDocxZoom() {
  if (!loaded) return;
  fitZoom = fitDocxZoom(availableWidth(), naturalPageWidth);
  setZoom(fitZoom);
  container.scrollLeft = 0;
}

container.addEventListener(
  "wheel",
  (event) => {
    // plain wheel/trackpad scrolling stays native
    if (!loaded || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const point = containerPoint(event.clientX, event.clientY);
    setZoom(
      computeZoom(zoomLevel, event.deltaY, { min: DOCX_MIN_ZOOM, max: DOCX_MAX_ZOOM }),
      point.x,
      point.y
    );
  },
  { passive: false }
);

// A link inside the document must never navigate the app's own webview
// away. Bookmark links ("#name") jump within the document; others are inert.
container.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute("href") ?? "";
  if (!href.startsWith("#") || href.length < 2) return;
  const target = document.getElementById(decodeURIComponent(href.slice(1)));
  if (target && pagesEl.contains(target)) target.scrollIntoView({ block: "start" });
});

window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!loaded) return;
    const wasFit = Math.abs(zoomLevel - fitZoom) < 0.001;
    fitZoom = fitDocxZoom(availableWidth(), naturalPageWidth);
    if (wasFit) setZoom(fitZoom);
  }, RESIZE_SETTLE_DELAY);
});
```

(`pinch` is declared now and wired in Task 6; an unused variable is fine for one commit.)

- [ ] **Step 5: Replace `src/main.js`**

Replace the whole file with:

```js
import {
  renderPdf,
  closePdf,
  setStatusCallback,
  togglePageMode,
  setPageMode,
  isSinglePageMode,
  zoomByStep,
  resetZoom,
} from "./viewer.js";
import { renderDocx, closeDocx, zoomDocxByStep, resetDocxZoom } from "./docx-viewer.js";
import { detectDocumentKind, pickDroppedPath, LEGACY_DOC_MESSAGE } from "./document-kind.js";
import { emit, on } from "./app-events.js";
import { initSidebar } from "./sidebar.js";
import { initEmptyState } from "./empty-state.js";

const { invoke } = window.__TAURI__.core;
const { getCurrentWebview } = window.__TAURI__.webview;

const openBtn = document.getElementById("open-btn");
const pageModeBtn = document.getElementById("page-mode-btn");
const toolbarMenuWrap = document.getElementById("toolbar-menu-wrap");
const toolbarMenuBtn = document.getElementById("toolbar-menu-btn");
const toolbarMenu = document.getElementById("toolbar-menu");
const layoutMenuOptions = [...document.querySelectorAll("[data-page-layout]")];
const zoomInBtn = document.getElementById("zoom-in-btn");
const zoomOutBtn = document.getElementById("zoom-out-btn");
const zoomResetBtn = document.getElementById("zoom-reset-btn");
const status = document.getElementById("status");
const loadingIndicator = document.getElementById("loading-indicator");
const emptyState = document.getElementById("empty-state");
const viewerContainer = document.getElementById("viewer-container");
const docxContainer = document.getElementById("docx-container");

// "pdf" | "docx" | null — which viewer currently shows a document.
let activeKind = null;
// Bumped on every open, so a slow render that finishes after a newer open
// started can tell it was superseded and leave the UI alone.
let openSequence = 0;

function setStatus(message) {
  status.textContent = message;
  status.classList.toggle("status-error", message.startsWith("Error"));
}

setStatusCallback(setStatus);

function showViewer(kind) {
  emptyState.hidden = true;
  viewerContainer.hidden = kind !== "pdf";
  docxContainer.hidden = kind !== "docx";
}

function showEmptyState() {
  emptyState.hidden = false;
  viewerContainer.hidden = true;
  docxContainer.hidden = true;
  activeKind = null;
  syncToolbarForKind(null);
  closeDocx();
  closePdf().catch(() => {
    // best-effort release; nothing is shown either way
  });
}

function syncPageModeButton() {
  const single = isSinglePageMode();
  pageModeBtn.classList.toggle("layout-active", !single);
  pageModeBtn.setAttribute("aria-pressed", String(!single));
  pageModeBtn.setAttribute("aria-label", single ? "Switch to side-by-side pages" : "Switch to vertical scrolling");
  pageModeBtn.title = single ? "Switch to side-by-side pages" : "Switch to vertical scrolling";
  for (const option of layoutMenuOptions) {
    const selected = option.dataset.pageLayout === (single ? "single" : "dual");
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-checked", String(selected));
  }
}

function setLayoutControlsEnabled(enabled) {
  for (const option of layoutMenuOptions) option.disabled = !enabled;
}

// Page layout (side-by-side) only applies to PDFs; zoom applies to both.
function syncToolbarForKind(kind) {
  pageModeBtn.hidden = kind !== "pdf";
  setLayoutControlsEnabled(kind === "pdf");
  zoomInBtn.hidden = kind === null;
  zoomOutBtn.hidden = kind === null;
  zoomResetBtn.hidden = kind === null;
  if (kind === "pdf") syncPageModeButton();
}

function closeToolbarMenu() {
  toolbarMenu.hidden = true;
  toolbarMenuBtn.setAttribute("aria-expanded", "false");
}

// Renders a file's bytes in the viewer that matches its contents (not its
// name — Android content:// URIs have none). Returns false when a newer open
// superseded this one mid-render; the caller must then leave the UI alone.
async function showDocument(bytes) {
  const sequence = ++openSequence;
  const data = new Uint8Array(bytes);
  // Unrecognized bytes go to PDF.js, which reports its own precise error.
  const kind = detectDocumentKind(data) ?? "pdf";
  if (kind === "doc") throw LEGACY_DOC_MESSAGE;
  activeKind = null;
  try {
    if (kind === "docx") {
      await closePdf();
      showViewer("docx");
      await renderDocx(data);
    } else {
      closeDocx();
      showViewer("pdf");
      await renderPdf(data);
    }
  } catch (err) {
    if (sequence !== openSequence) return false;
    throw err;
  }
  if (sequence !== openSequence) return false;
  activeKind = kind;
  syncToolbarForKind(kind);
  return true;
}

async function openViaBytesResult(invokePromise) {
  setStatus("");
  loadingIndicator.hidden = false;
  try {
    const bytes = await invokePromise;
    if (await showDocument(bytes)) emit("file-opened", null);
  } catch (err) {
    if (err === "cancelled") return;
    setStatus(`Error: ${err}`);
    showEmptyState();
  } finally {
    loadingIndicator.hidden = true;
  }
}

async function handleOpenClick() {
  await openViaBytesResult(invoke("open_document_file"));
}

async function handleOpenRequested({ path }) {
  setStatus("");
  loadingIndicator.hidden = false;
  let bytes;
  try {
    bytes = await invoke("open_document_path", { path });
  } catch (err) {
    setStatus(`Error: ${err}`);
    loadingIndicator.hidden = true;
    try {
      await invoke("remove_recent_entry", { path });
    } catch {
      // best-effort cleanup; the read already failed, nothing more to do
    }
    emit("file-opened", null); // refresh sidebar to drop the dead entry
    return;
  }
  try {
    if (await showDocument(bytes)) emit("file-opened", { path });
  } catch (err) {
    setStatus(`Error: ${err}`);
    showEmptyState(); // don't strand the UI on a blank viewer pane
  } finally {
    loadingIndicator.hidden = true;
  }
}

function zoomActiveByStep(direction) {
  if (activeKind === "docx") zoomDocxByStep(direction);
  else zoomByStep(direction);
}

function resetActiveZoom() {
  if (activeKind === "docx") resetDocxZoom();
  else resetZoom();
}

openBtn.addEventListener("click", handleOpenClick);
pageModeBtn.addEventListener("click", () => {
  togglePageMode();
  syncPageModeButton();
});
toolbarMenuBtn.addEventListener("click", () => {
  const opening = toolbarMenu.hidden;
  toolbarMenu.hidden = !opening;
  toolbarMenuBtn.setAttribute("aria-expanded", String(opening));
});
for (const option of layoutMenuOptions) {
  option.addEventListener("click", () => {
    setPageMode(option.dataset.pageLayout);
    syncPageModeButton();
    closeToolbarMenu();
  });
}
document.addEventListener("pointerdown", (event) => {
  if (!toolbarMenu.hidden && !toolbarMenuWrap.contains(event.target)) closeToolbarMenu();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeToolbarMenu();
});
zoomInBtn.addEventListener("click", () => zoomActiveByStep(1));
zoomOutBtn.addEventListener("click", () => zoomActiveByStep(-1));
zoomResetBtn.addEventListener("click", () => resetActiveZoom());

window.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    zoomActiveByStep(1);
  } else if (event.key === "-" || event.key === "_") {
    event.preventDefault();
    zoomActiveByStep(-1);
  } else if (event.key === "0") {
    event.preventDefault();
    resetActiveZoom();
  }
});

let pageModeSyncTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(pageModeSyncTimer);
  pageModeSyncTimer = setTimeout(syncPageModeButton, 220);
});
on("dialog-open-requested", handleOpenClick);
on("open-requested", handleOpenRequested);

initSidebar();
initEmptyState();
showEmptyState();

invoke("get_launch_path").then((path) => {
  if (path) handleOpenRequested({ path });
});

getCurrentWebview().onDragDropEvent((event) => {
  const type = event.payload.type;
  if (type === "over") {
    document.body.classList.add("drag-active");
  } else if (type === "drop") {
    document.body.classList.remove("drag-active");
    const dropped = pickDroppedPath(event.payload.paths || []);
    if (dropped.error) {
      setStatus(dropped.error);
      return;
    }
    handleOpenRequested({ path: dropped.path });
  } else {
    document.body.classList.remove("drag-active");
  }
}).catch(() => {
  setStatus("Drag-and-drop unavailable.");
});
```

Differences from the old file, for review: `docxContainer`, `activeKind`, `openSequence`, `showViewer(kind)`, `showEmptyState()` now also closes both viewers and hides zoom buttons, new `syncToolbarForKind`, new `showDocument` (replaces the duplicated render-and-show-toolbar code in both open paths), zoom routed through `zoomActiveByStep` / `resetActiveZoom`, and drop handling via `pickDroppedPath`.

- [ ] **Step 6: Run checks**

Run: `node --check src/main.js && node --check src/docx-viewer.js && npm test`
Expected: no syntax errors; all tests PASS.

Run (from `src-tauri/`): `cargo test`
Expected: PASS.

- [ ] **Step 7: Manual check (user)** — `npm run tauri dev`, then:

1. Open a simple `.docx` via the toolbar button → pages render as white sheets on the dark canvas; no side-by-side button; zoom +/−/fit, Ctrl+wheel and Ctrl+`+`/`-`/`0` work; plain wheel scrolls.
2. Open a `.docx` with tables, images and a header/footer → they appear.
3. Click a web link inside a `.docx` → the app does **not** navigate away. Click a table-of-contents link (if the doc has one) → it scrolls to the heading.
4. PDF → DOCX → PDF → DOCX → DOCX: each switch shows only the new document; the side-by-side button appears only for PDFs; zoom acts on what's visible.
5. Drag-and-drop a `.docx` → opens. Drop an old `.doc` → the legacy message. Drop a `.png` → "Please drop a PDF or Word (.docx) file."
6. Rename a PDF to `x.docx` and open it → it opens as a PDF. Rename a docx to `y.pdf` → opens as Word.
7. Narrow the window to phone width → a Word page shrinks to fit the width; zoom in → scrolling horizontally reaches the page's left edge.
8. Reopen a Word file from the sidebar; pin/unpin/remove it.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/vendor/docx-preview src/docx-viewer.js src/index.html src/styles.css src/main.js
git commit -m "feat: open Word .docx files in a dedicated viewer"
```

---

### Task 6: Pinch-to-zoom for Word documents on touch screens

**Files:**
- Modify: `src/docx-viewer.js`

**Interfaces:**
- Consumes: from Task 2, `pinchDocxZoom(startZoom, startDistance, currentDistance)`; from Task 5, the module's `container`, `loaded`, `zoomLevel`, `pinch`, `setZoom`, `containerPoint`.
- Produces: no new exports.

- [ ] **Step 1: Implement**

In `src/docx-viewer.js`, add `pinchDocxZoom` to the import from `./docx-zoom.js` (keep the names alphabetical):

```js
import {
  DOCX_MAX_ZOOM,
  DOCX_MIN_ZOOM,
  clampDocxZoom,
  fitDocxZoom,
  pinchDocxZoom,
  scrollForZoom,
  stepDocxZoom,
} from "./docx-zoom.js";
```

Below `let pinch = null;` add:

```js
let pinchFrame = 0;
```

In `closeDocx()`, directly after `pinch = null;`, add:

```js
  cancelAnimationFrame(pinchFrame);
  pinchFrame = 0;
```

Append to the end of the file:

```js
function touchDistance(touches) {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}

// Two-finger pinch zooms around the fingers' midpoint. CSS zoom re-lays out
// the document, so at most one zoom is applied per animation frame.
container.addEventListener(
  "touchstart",
  (event) => {
    if (!loaded || event.touches.length !== 2) return;
    pinch = { startDistance: touchDistance(event.touches), startZoom: zoomLevel, next: null };
  },
  { passive: true }
);

container.addEventListener(
  "touchmove",
  (event) => {
    if (!pinch || event.touches.length !== 2) return;
    event.preventDefault();
    const [first, second] = event.touches;
    const mid = containerPoint((first.clientX + second.clientX) / 2, (first.clientY + second.clientY) / 2);
    pinch.next = {
      zoom: pinchDocxZoom(pinch.startZoom, pinch.startDistance, touchDistance(event.touches)),
      x: mid.x,
      y: mid.y,
    };
    if (pinchFrame) return;
    pinchFrame = requestAnimationFrame(() => {
      pinchFrame = 0;
      if (pinch?.next) setZoom(pinch.next.zoom, pinch.next.x, pinch.next.y);
    });
  },
  { passive: false }
);

function endPinch(event) {
  if (event.touches.length < 2) pinch = null;
}

container.addEventListener("touchend", endPinch);
container.addEventListener("touchcancel", endPinch);
```

- [ ] **Step 2: Run checks**

Run: `node --check src/docx-viewer.js && npm test`
Expected: no syntax errors; all tests PASS.

- [ ] **Step 3: Manual check (user)** — on Android (`npx tauri android dev --host`) or a touchscreen laptop:

Open a `.docx`; one-finger swipe scrolls; two-finger pinch zooms around the fingers; lifting one finger mid-pinch and continuing to swipe scrolls normally; PDF pinch still works after switching back to a PDF.

- [ ] **Step 4: Commit**

```bash
git add src/docx-viewer.js
git commit -m "feat: pinch-to-zoom for Word documents on touch screens"
```

---

### Task 7: File-type badge in the sidebar

**Files:**
- Modify: `src/sidebar.js` (`renderRow`)
- Modify: `src/styles.css` (append)

**Interfaces:**
- Consumes: from Task 1, `documentKindFromName(name)`.
- Produces: nothing used elsewhere.

- [ ] **Step 1: Implement**

In `src/sidebar.js`, change the first import block to:

```js
import { groupByPinned } from "./recent-list.js";
import { emit, on } from "./app-events.js";
import { documentKindFromName } from "./document-kind.js";
```

In `renderRow`, find:

```js
  const label = document.createElement("span");
  label.className = "sidebar-row-label";
```

and insert **above** it:

```js
  const kind = documentKindFromName(entry.name);
  if (kind === "pdf" || kind === "docx") {
    const badge = document.createElement("span");
    badge.className = `sidebar-row-kind sidebar-row-kind-${kind}`;
    badge.textContent = kind === "docx" ? "DOCX" : "PDF";
    badge.setAttribute("aria-hidden", "true");
    badge.addEventListener("click", () => {
      emit("open-requested", { path: entry.path });
    });
    row.appendChild(badge);
  }

```

Append to `src/styles.css`:

```css
.sidebar-row-kind {
  flex-shrink: 0;
  margin-right: 7px;
  padding: 0 4px;
  border: 1px solid var(--border-idle);
  border-radius: 3px;
  font-size: 0.62em;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1.5;
  color: var(--text-lo);
}

.sidebar-row-kind-pdf {
  color: #e0796b;
  border-color: rgba(224, 121, 107, 0.45);
}

.sidebar-row-kind-docx {
  color: #7aa7e8;
  border-color: rgba(122, 167, 232, 0.45);
}
```

- [ ] **Step 2: Run checks**

Run: `node --check src/sidebar.js && npm test`
Expected: PASS.

- [ ] **Step 3: Manual check (user)**

Sidebar rows show a red `PDF` or blue `DOCX` badge before the name; long names still ellipsize; tapping the badge opens the file; on Android, files opened through the system picker still get the right badge (their display name keeps the extension).

- [ ] **Step 4: Commit**

```bash
git add src/sidebar.js src/styles.css
git commit -m "feat: show a PDF/DOCX badge on sidebar entries"
```

---

### Task 8: Docs and final verification

**Files:**
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Update `README.md`**

a) Replace the first paragraph (starting `A lightweight Windows PDF reader`) with:

```markdown
A lightweight PDF and Word (.docx) reader for Windows and Android, built with
Tauri 2, vendored PDF.js and vendored docx-preview. There is no frontend
bundler — `src/` is plain HTML/CSS/JS served as-is, and `src/vendor/`
contains the pre-built library files copied in directly (`pdfjs/`, and
`docx-preview/` with its JSZip dependency).
```

b) In `## Tests`, change the first bullet to:

```markdown
- `npm test` — frontend unit tests (zoom, page layout, document-type detection) via Vitest.
```

c) After the `## PDF viewer` section (before `## Manual viewer checks`), add:

```markdown
## Word viewer

`.docx` files are rendered by docx-preview into `#docx-container`, a
natively scrolling pane separate from the PDF viewer. Files are routed by
their first bytes, not their extension (Android `content://` URIs have
none); legacy `.doc` files are rejected with a message. Pages open at 100%,
shrunk to fit narrow screens; zoom uses CSS `zoom`. Links inside a document
never navigate the app; bookmark links scroll within it. Layout is an
approximation of Word's — complex text boxes, SmartArt and missing fonts may
differ.

To update the vendored Word libraries:

    npm install --save-exact docx-preview@<version> jszip@<version>
    cp node_modules/jszip/dist/jszip.min.js src/vendor/docx-preview/
    cp node_modules/docx-preview/dist/docx-preview.min.js src/vendor/docx-preview/
```

d) At the end of the file, add:

```markdown
### Word documents

- [ ] Simple, table/image-heavy, header/footer, and landscape `.docx` files
- [ ] Toolbar zoom, Ctrl+wheel, Ctrl+`+`/`-`/`0`, and pinch on touch
- [ ] Phone width: page fits on open; zoomed-in left edge reachable
- [ ] Web links do nothing; table-of-contents links scroll in the document
- [ ] PDF ↔ DOCX switching; side-by-side control only shown for PDFs
- [ ] Drop `.doc` (legacy message) and unsupported files (prompt)
- [ ] Android picker lists `.docx` files and opens them
```

- [ ] **Step 2: Full verification**

Run: `npm test`
Expected: all Vitest tests PASS — report the count.

Run (from `src-tauri/`): `cargo test`
Expected: all PASS — report the count (14).

Run: `node --check src/main.js && node --check src/viewer.js && node --check src/docx-viewer.js && node --check src/sidebar.js && node --check src/document-kind.js && node --check src/docx-zoom.js`
Expected: no output.

Run: `git diff --check main...HEAD`
Expected: no whitespace errors.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe Word document support"
```

- [ ] **Step 4: Report to the user**

List the test counts, and hand over every **Manual check (user)** item from Tasks 3–7 plus the README "Word documents" checklist as not yet verified. Do not merge or push.
