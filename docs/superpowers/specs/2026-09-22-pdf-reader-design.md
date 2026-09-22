# PDF Reader — Design Spec

Date: 2026-09-22

## Goal

A lightweight, fast Windows desktop PDF reader with mouse-wheel zoom,
built to stay modular so features can be added later without a rewrite.

## Scope (v1)

- Open a PDF via a native "Open File" dialog.
- View pages in a scrollable, continuous-scroll layout.
- Zoom with the mouse: **Ctrl+scroll to zoom**, plain scroll to pan/scroll
  through pages.
- Windows only for v1.

Explicitly out of scope for v1 (may come later, hence "modular"):
- Page thumbnails / sidebar navigation
- Text search
- Recent files list / drag-and-drop open
- Double-click a `.pdf` to launch the app (file association)
- Printing, annotations, form filling, dark mode, etc.

## Stack

- **Shell/backend:** Tauri 2.x (Rust). Keeps the packaged app small
  (no bundled Chromium like Electron — uses the OS's native WebView2 on
  Windows) and gives a real Rust layer for native OS integration.
- **PDF rendering:** [PDF.js](https://mozilla.github.io/pdf.js/)
  (Mozilla), running in the Tauri webview. Chosen over Rust-native
  bindings (pdfium-render, mupdf-rs) because it's the most
  battle-tested renderer for real-world PDF quirks (broken files,
  unusual encodings, forms) and avoids MuPDF's AGPL licensing concerns.
  Rendering itself runs in JS/WASM; the app shell, file I/O, and native
  dialog remain Rust.
- **Frontend:** vanilla HTML/CSS/JS. No framework (React/Vue/etc.) —
  the UI surface (a canvas viewer + open button) doesn't need one, and
  skipping it keeps the bundle and dependency count minimal.

## Architecture

```
pdf-reader/
├── src-tauri/              # Rust backend (Tauri app shell)
│   ├── src/
│   │   ├── main.rs         # Tauri app entrypoint, window setup
│   │   └── commands.rs     # Tauri commands (e.g. open_file_dialog)
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                    # Frontend (served into the webview)
│   ├── index.html
│   ├── main.js             # App wiring: open button, PDF.js init
│   ├── viewer.js           # Rendering + zoom/pan logic
│   └── style.css
├── docs/
│   └── superpowers/specs/  # Design specs (this file)
└── CLAUDE.md
```

### Rust side (`src-tauri/`)

- One Tauri command, `open_file_dialog`, using `tauri-plugin-dialog` to
  show a native Windows file picker filtered to `*.pdf`.
- Reads the selected file's bytes and returns them to the frontend
  (via Tauri's IPC, as a binary payload) rather than just a path — this
  keeps file I/O centralized on the Rust side and the frontend
  filesystem-agnostic.
- No other backend responsibilities in v1 (no persistence, no settings
  file yet).

### Frontend (`src/`)

- `main.js`: wires the "Open" button/menu to invoke the Rust command,
  hands the returned bytes to `viewer.js`.
- `viewer.js`: owns all PDF.js interaction —
  - Loads the document via `pdfjsLib.getDocument({ data: bytes })`.
  - Renders each page into its own `<canvas>` inside a scrollable
    container, in document order (continuous scroll).
  - Tracks a single `zoomLevel` (float, e.g. 1.0 = 100%). On re-render
    (open, or zoom change), each page canvas is redrawn at
    `viewport = page.getViewport({ scale: zoomLevel })`.
  - Wheel handling: a `wheel` event listener on the container checks
    `event.ctrlKey`:
    - If true: `preventDefault()`, adjust `zoomLevel` by a step
      proportional to `event.deltaY`, clamp to a sane min/max (e.g.
      25%–400%), re-render affected pages.
    - If false: let the browser's native scroll behavior handle
      panning (no interference).
- Kept as two small modules (`main.js` orchestration, `viewer.js`
  rendering) rather than one file, so PDF.js-specific logic stays
  isolated — a later feature (thumbnails, search) can read from
  `viewer.js`'s state without touching app wiring.

## Data flow

1. User clicks "Open".
2. Frontend invokes Rust `open_file_dialog` command.
3. Rust shows native dialog, reads chosen file, returns bytes.
4. Frontend passes bytes to `viewer.js`, which loads them into PDF.js.
5. PDF.js renders all pages into canvases in the scroll container.
6. Ctrl+scroll adjusts zoom and triggers re-render; plain scroll pans
   natively.

## Error handling

- Dialog cancelled → no-op, no error shown.
- File read fails (permissions, deleted mid-pick) → Rust command
  returns an error string; frontend shows a simple inline message
  (no toast library — a plain status line in the UI is enough for v1).
- PDF.js fails to parse (corrupt/unsupported file) → catch the promise
  rejection from `getDocument`, show the same inline status message.

## Testing

Manual verification for v1 (the UI surface is small enough that
automated UI tests would be overkill):
- Open a small (few-page) PDF and a large (100+ page) PDF — confirm
  render, scroll, and zoom performance stay acceptable.
- Confirm ctrl+scroll zooms without scrolling the page, and plain
  scroll pans without zooming.
- Confirm cancelling the open dialog and opening a corrupt file both
  fail gracefully.

## Modularity notes (for future features)

- Thumbnails/sidebar: would read page count + render low-res thumbnail
  canvases from the same PDF.js document instance already loaded in
  `viewer.js` — no architecture change needed.
- Search: PDF.js exposes text content extraction per page
  (`page.getTextContent()`); a `search.js` module could consume
  `viewer.js`'s loaded document without modifying it.
- Recent files / drag-and-drop / file association: would add a small
  persistence layer (e.g. a JSON file via Tauri's fs API) and
  additional Rust commands — additive, doesn't change the rendering
  path.
