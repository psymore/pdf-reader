# PDF Reader v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a lightweight Windows desktop PDF viewer (Tauri + PDF.js) that opens a PDF via a native file dialog, displays it in continuous scroll, and zooms with Ctrl+scroll while plain scroll pans.

**Architecture:** Tauri 2.x Rust shell owns the native file-open dialog and file I/O; a vanilla JS/HTML frontend uses PDF.js to render every page to its own `<canvas>` inside a scrollable container. Zoom level is a single piece of JS state driven by a pure, unit-testable function that reads wheel events; the Rust side never touches PDF content, only bytes.

**Tech Stack:** Tauri 2.x, Rust, `tauri-plugin-dialog`, PDF.js (`pdfjs-dist` npm package), Vite (dev server/bundler that ships with Tauri's vanilla-JS template), Vitest (frontend unit tests), `cargo test` (Rust unit tests).

**Spec:** `docs/superpowers/specs/2026-09-22-pdf-reader-design.md`

## Global Constraints

- Windows only for v1 (per spec "Scope").
- No frontend framework (React/Vue/etc.) — vanilla JS only (per spec "Stack").
- No persistence/settings, no thumbnails, no search, no drag-and-drop, no file association in v1 (per spec "Scope" — explicitly out of scope).
- Zoom range clamps to 25%–400% (per spec "Frontend").
- Ctrl+scroll zooms and calls `preventDefault()`; plain scroll must pan natively, untouched (per spec "Frontend" wheel handling).
- File bytes are read on the Rust side and passed to the frontend over Tauri IPC — the frontend never touches the filesystem directly (per spec "Rust side").

---

## File Structure

```
pdf-reader/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs         # Tauri app entrypoint, registers commands
│   │   └── commands.rs     # open_file_dialog, read_pdf_bytes (unit-tested)
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/
│   ├── index.html          # App shell: Open button, status line, viewer container
│   ├── main.js             # Wiring: Open button -> invoke command -> viewer.render()
│   ├── viewer.js           # PDF.js loading/rendering + wheel zoom/pan logic
│   ├── zoom.js             # Pure computeZoom() function (unit-tested in isolation)
│   └── style.css
├── tests/
│   └── zoom.test.js        # Vitest tests for computeZoom
├── package.json
└── vite.config.js
```

Rationale: `zoom.js` is split out from `viewer.js` specifically so the
zoom-step/clamping math is a pure function with no DOM or PDF.js
dependency — that's the one piece of frontend logic worth unit testing
per the spec's "Testing" section (everything else is manual QA).

---

### Task 1: Scaffold the Tauri project

**Files:**
- Create: entire project scaffold via `create-tauri-app` (vanilla JS template) — produces `src-tauri/`, `src/`, `package.json`, `vite.config.js`, `tauri.conf.json`
- Modify: `src-tauri/tauri.conf.json` (app name/window title)

**Interfaces:**
- Produces: a running Tauri dev shell (`npm run tauri dev` opens an empty window) that later tasks build on.

- [ ] **Step 1: Run the scaffold command**

```bash
cd "D:\CodeSpace\pdf-reader"
npm create tauri-app@latest . -- --template vanilla --manager npm --yes
```

If prompted interactively instead of using flags, choose: project name `pdf-reader` (or accept current dir), package manager `npm`, template `vanilla` (JavaScript, not TypeScript).

- [ ] **Step 2: Install dependencies**

```bash
npm install
```

- [ ] **Step 3: Set the window title**

In `src-tauri/tauri.conf.json`, set:

```json
{
  "productName": "PDF Reader",
  "app": {
    "windows": [
      {
        "title": "PDF Reader",
        "width": 1000,
        "height": 800
      }
    ]
  }
}
```

(Merge these keys into the existing generated file rather than
replacing it wholesale — the scaffold generates other required keys
like `identifier` and `build`.)

- [ ] **Step 4: Verify the dev shell runs**

Run: `npm run tauri dev`
Expected: a native window titled "PDF Reader" opens showing the
scaffold's default placeholder page. Close the window when confirmed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold Tauri vanilla-JS project"
```

---

### Task 2: Rust command to open a file dialog and read PDF bytes

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs:` (register the command, add plugin)
- Modify: `src-tauri/Cargo.toml` (add `tauri-plugin-dialog` dependency)

**Interfaces:**
- Produces: Tauri command `open_pdf_file() -> Result<Vec<u8>, String>` — shows a native "*.pdf" file picker; returns the selected file's raw bytes, or an `Err(String)` message if the user cancels (returns a distinguishable `Err("cancelled")`) or the read fails.
- Produces: plain Rust function `read_pdf_bytes(path: &std::path::Path) -> Result<Vec<u8>, String>` — separated from the dialog so it can be unit-tested without a UI.

- [ ] **Step 1: Add the dialog plugin dependency**

```bash
cd "D:\CodeSpace\pdf-reader\src-tauri"
cargo add tauri-plugin-dialog
```

- [ ] **Step 2: Write `read_pdf_bytes` with its unit test**

Create `src-tauri/src/commands.rs`:

```rust
use std::fs;
use std::path::Path;

pub fn read_pdf_bytes(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("Failed to read file: {e}"))
}

#[tauri::command]
pub async fn open_pdf_file(app: tauri::AppHandle) -> Result<Vec<u8>, String> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .blocking_pick_file();

    match file_path {
        Some(path) => {
            let path = path
                .as_path()
                .ok_or_else(|| "Invalid file path".to_string())?;
            read_pdf_bytes(path)
        }
        None => Err("cancelled".to_string()),
    }
}

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

        let result = read_pdf_bytes(&tmp).unwrap();
        assert_eq!(result, b"%PDF-1.4 test bytes");

        fs::remove_file(&tmp).unwrap();
    }

    #[test]
    fn errors_on_missing_file() {
        let missing = Path::new("this_file_does_not_exist_pdf_reader.pdf");
        let result = read_pdf_bytes(missing);
        assert!(result.is_err());
    }
}
```

- [ ] **Step 3: Run the Rust tests to verify they pass**

Run: `cargo test` (from `src-tauri/`)
Expected: `reads_existing_file_bytes` and `errors_on_missing_file` both PASS.

- [ ] **Step 4: Register the plugin and command in `main.rs`**

Edit `src-tauri/src/main.rs` so it includes:

```rust
mod commands;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![commands::open_pdf_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

(Keep any other setup the scaffold already generated — only add the
`.plugin(...)` line and the `commands::open_pdf_file` entry in
`generate_handler!`.)

- [ ] **Step 5: Verify it builds**

Run: `cargo build` (from `src-tauri/`)
Expected: builds with no errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Rust command to open file dialog and read PDF bytes"
```

---

### Task 3: Wire the frontend Open button to the Rust command

**Files:**
- Modify: `src/index.html` (Open button, status line, viewer container)
- Create: `src/main.js`
- Modify: `src-tauri/tauri.conf.json` (allow the dialog plugin's permission)
- Modify: `src-tauri/capabilities/default.json` (add `dialog:default` permission if the scaffold generates this file — Tauri 2.x's permission system requires it)

**Interfaces:**
- Consumes: Rust command `open_pdf_file()` from Task 2, invoked as `await window.__TAURI__.core.invoke("open_pdf_file")` (or via the `@tauri-apps/api/core` `invoke` import).
- Produces: `handleOpenClick()` in `main.js`, called on button click, which on success calls `renderPdf(bytes)` (implemented in Task 4) and on failure (except `"cancelled"`) writes to a `#status` element.

- [ ] **Step 1: Replace `src/index.html` body**

```html
<body>
  <div id="toolbar">
    <button id="open-btn">Open PDF</button>
    <span id="status"></span>
  </div>
  <div id="viewer-container"></div>
  <script type="module" src="/main.js"></script>
</body>
```

- [ ] **Step 2: Add the dialog permission to Tauri capabilities**

In `src-tauri/capabilities/default.json`, ensure `"permissions"` includes:

```json
"dialog:default"
```

alongside whatever default permissions the scaffold already listed.

- [ ] **Step 3: Write `src/main.js`**

```javascript
import { invoke } from "@tauri-apps/api/core";
import { renderPdf } from "./viewer.js";

const openBtn = document.getElementById("open-btn");
const status = document.getElementById("status");

async function handleOpenClick() {
  status.textContent = "";
  try {
    const bytes = await invoke("open_pdf_file");
    await renderPdf(new Uint8Array(bytes));
  } catch (err) {
    if (err === "cancelled") return;
    status.textContent = `Error: ${err}`;
  }
}

openBtn.addEventListener("click", handleOpenClick);
```

- [ ] **Step 4: Stub `renderPdf` so the app runs end-to-end**

Create a temporary `src/viewer.js` with just:

```javascript
export async function renderPdf(bytes) {
  console.log("Received PDF bytes, length:", bytes.length);
}
```

(Task 4 replaces this with the real implementation.)

- [ ] **Step 5: Manual verification**

Run: `npm run tauri dev`
Click "Open PDF", pick any `.pdf` file. Open the webview devtools
(right-click → Inspect, if enabled) and confirm the console logs the
byte length. Click "Open PDF" and press Cancel — confirm no error
appears in `#status`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: wire Open button to Rust file dialog command"
```

---

### Task 4: Render PDF pages with PDF.js

**Files:**
- Modify: `src/viewer.js` (replace stub with real rendering)
- Modify: `src/style.css` (scroll container + canvas spacing)
- Modify: `package.json` (add `pdfjs-dist` dependency)

**Interfaces:**
- Consumes: `bytes: Uint8Array` passed into `renderPdf(bytes)`.
- Produces: module-level state `{ pdfDoc, zoomLevel }` in `viewer.js`, and exported `renderPdf(bytes)` which fully replaces `#viewer-container`'s contents with one `<canvas>` per page rendered at the current `zoomLevel`. Later tasks (zoom) call the internal `rerenderAllPages()` this task defines.

- [ ] **Step 1: Install pdfjs-dist**

```bash
npm install pdfjs-dist
```

- [ ] **Step 2: Write `src/viewer.js`**

```javascript
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const container = document.getElementById("viewer-container");

let pdfDoc = null;
let zoomLevel = 1.0;

export async function renderPdf(bytes) {
  pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
  zoomLevel = 1.0;
  await rerenderAllPages();
}

async function rerenderAllPages() {
  container.innerHTML = "";
  if (!pdfDoc) return;

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: zoomLevel });

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.className = "pdf-page";
    container.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
  }
}

export function getZoomLevel() {
  return zoomLevel;
}

export async function setZoomLevel(newZoom) {
  zoomLevel = newZoom;
  await rerenderAllPages();
}
```

- [ ] **Step 3: Add container/canvas styles to `src/style.css`**

```css
#viewer-container {
  overflow: auto;
  height: calc(100vh - 48px);
  background: #808080;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.pdf-page {
  margin: 8px 0;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.5);
  background: white;
}
```

- [ ] **Step 4: Manual verification**

Run: `npm run tauri dev`. Click "Open PDF", pick a multi-page PDF.
Expected: every page renders as a white canvas, stacked vertically,
scrollable with the mouse wheel (plain scroll, no ctrl).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: render PDF pages with PDF.js into scrollable canvases"
```

---

### Task 5: Pure zoom-calculation function with unit tests

**Files:**
- Create: `src/zoom.js`
- Create: `tests/zoom.test.js`
- Modify: `package.json` (add `vitest` dev dependency + `test` script)
- Create: `vite.config.js` (only if the scaffold didn't already create one — configure Vitest's `test` block)

**Interfaces:**
- Produces: `computeZoom(currentZoom, deltaY, { min = 0.25, max = 4.0, step = 0.001 } = {}) -> number` — a pure function with no DOM/PDF.js dependency. Positive `deltaY` (scrolling down/away) zooms out; negative `deltaY` (scrolling up/toward) zooms in. Result is clamped to `[min, max]`.

- [ ] **Step 1: Install Vitest**

```bash
npm install -D vitest
```

Add to `package.json` `"scripts"`:

```json
"test": "vitest run"
```

- [ ] **Step 2: Write the failing tests**

Create `tests/zoom.test.js`:

```javascript
import { describe, it, expect } from "vitest";
import { computeZoom } from "../src/zoom.js";

describe("computeZoom", () => {
  it("zooms in when deltaY is negative", () => {
    const result = computeZoom(1.0, -100);
    expect(result).toBeGreaterThan(1.0);
  });

  it("zooms out when deltaY is positive", () => {
    const result = computeZoom(1.0, 100);
    expect(result).toBeLessThan(1.0);
  });

  it("clamps to the maximum zoom", () => {
    const result = computeZoom(3.99, -10000, { max: 4.0 });
    expect(result).toBe(4.0);
  });

  it("clamps to the minimum zoom", () => {
    const result = computeZoom(0.26, 10000, { min: 0.25 });
    expect(result).toBe(0.25);
  });

  it("returns exactly the current zoom when deltaY is zero", () => {
    const result = computeZoom(1.5, 0);
    expect(result).toBe(1.5);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/zoom.js'` (file doesn't exist yet).

- [ ] **Step 4: Implement `src/zoom.js`**

```javascript
export function computeZoom(currentZoom, deltaY, options = {}) {
  const { min = 0.25, max = 4.0, step = 0.001 } = options;
  const proposed = currentZoom - deltaY * step;
  return Math.min(max, Math.max(min, proposed));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all 5 tests in `zoom.test.js` PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add pure computeZoom function with unit tests"
```

---

### Task 6: Wire Ctrl+scroll zoom into the viewer

**Files:**
- Modify: `src/viewer.js` (import `computeZoom`, add wheel listener)

**Interfaces:**
- Consumes: `computeZoom(currentZoom, deltaY)` from Task 5; `getZoomLevel()` / `setZoomLevel()` already exported from Task 4's `viewer.js`.
- Produces: a `wheel` listener attached to `#viewer-container` in `viewer.js`'s module init code (runs once on import).

- [ ] **Step 1: Add the import and listener to `src/viewer.js`**

Add near the top:

```javascript
import { computeZoom } from "./zoom.js";
```

Add after the `container` declaration (module-level, runs on load):

```javascript
container.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey) return; // plain scroll: let native pan happen
    event.preventDefault();
    const newZoom = computeZoom(zoomLevel, event.deltaY);
    setZoomLevel(newZoom);
  },
  { passive: false }
);
```

(`{ passive: false }` is required — `preventDefault()` on a wheel
event is silently ignored on a passive listener.)

- [ ] **Step 2: Manual verification**

Run: `npm run tauri dev`. Open a PDF.
- Hold Ctrl and scroll up: pages should visibly enlarge, no page
  scroll happens.
- Hold Ctrl and scroll down: pages should visibly shrink.
- Scroll without Ctrl: the view should pan/scroll through pages with
  no size change.
- Ctrl+scroll repeatedly toward the extreme: confirm zoom stops
  growing past a reasonable max and stops shrinking past a reasonable
  min (per the 0.25–4.0 clamp from Task 5).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: wire Ctrl+scroll to zoom, plain scroll to pan"
```

---

### Task 7: Error handling for parse failures

**Files:**
- Modify: `src/viewer.js` (`renderPdf` error handling)
- Modify: `src/main.js` (surface the error to `#status`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `renderPdf(bytes)` now rejects with a plain string message on PDF.js parse failure instead of an unhandled promise rejection; `main.js`'s existing `catch` block (Task 3) already displays whatever string it receives.

- [ ] **Step 1: Wrap the PDF.js load in `src/viewer.js`**

Change `renderPdf` to:

```javascript
export async function renderPdf(bytes) {
  try {
    pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
  } catch (err) {
    throw `Could not open PDF: ${err.message || err}`;
  }
  zoomLevel = 1.0;
  await rerenderAllPages();
}
```

- [ ] **Step 2: Manual verification**

Run: `npm run tauri dev`. Create a throwaway text file renamed to
`.pdf` (e.g. `echo "not a pdf" > fake.pdf`) and open it via the Open
button.
Expected: `#status` shows `Error: Could not open PDF: ...` and the app
does not crash or hang. Then open a real PDF and confirm it still
renders correctly afterward (no leftover broken state).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "fix: surface PDF parse failures as a status message instead of crashing"
```

---

## Self-Review Notes

- **Spec coverage:** Open dialog (Task 2/3), continuous scroll render
  (Task 4), Ctrl+scroll zoom / plain scroll pan (Task 5/6), dialog
  cancel no-op (Task 3 step 5), file read / parse error handling
  (Task 2 `Err`, Task 7), Windows-only + vanilla JS + no extra
  features — all satisfied by scope (no tasks add thumbnails, search,
  recents, or file association). Manual test matrix from the spec's
  "Testing" section is covered by Task 4 step 4, Task 6 step 2, and
  Task 7 step 2.
- **Placeholder scan:** no TBDs; every step has literal code or an
  exact command.
- **Type consistency:** `renderPdf(bytes: Uint8Array)` used
  consistently from Task 3 through Task 7; `computeZoom` signature
  matches between its Task 5 definition and Task 6 usage;
  `getZoomLevel`/`setZoomLevel` defined in Task 4 and consumed in
  Task 6 without renaming.
