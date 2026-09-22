# PDF Reader — Sidebar, Recent Files & Drag-and-Drop — Design Spec

Date: 2026-09-22

## Goal

Extend the v1 PDF reader (see `2026-09-22-pdf-reader-design.md`) with three
previously out-of-scope features, now needed together:

1. A left sidebar for recent + pinned files ("library management").
2. Drag-and-drop opening of a PDF anywhere in the window.
3. A redesigned empty state (replacing the flat grey background) that
   doubles as the drop target.

## Scope

In scope:
- Left sidebar, always visible, fixed width. Two sections: **Pinned**
  and **Recent** (most-recent-first, capped at 20 entries; pinned
  entries don't count against the cap and don't appear in Recent).
- Click a sidebar entry to reopen that file.
- Pin/unpin toggle per entry.
- Persistence of recent/pinned entries across app restarts via a JSON
  file in the Tauri app config dir.
- Drag-and-drop of a `.pdf` file anywhere in the window (empty state
  or over an already-open viewer) opens it, replacing any current
  view.
- Redesigned empty state: centered drop zone with a "+" icon and
  "Drop a PDF here or click to open" text, replacing the flat grey
  `#808080` background. Click also opens the native file dialog.
- Drag-over visual feedback (CSS transition only, no canvas
  re-render).

Out of scope (unchanged from v1 spec, still deferred):
- Folders/collections beyond flat pinned + recent lists.
- Sidebar collapse/toggle (fixed width, always visible for now).
- Text search, thumbnails, file association, printing, annotations.

## Approach: event-based module communication

Adding a sidebar and an empty-state drop zone means three UI regions
(toolbar, sidebar, main area) all need to react to "a file was opened"
and the sidebar also needs to *trigger* opens. Rather than having
modules import and call each other directly (which tangles quickly
with 3+ regions), a small event bus is introduced:

- `src/app-events.js`: a single `EventTarget` instance exporting
  `emit(name, detail)` / `on(name, handler)`.
- Events: `file-opened` (detail: `{ path, name, bytes }`),
  `open-requested` (detail: `{ path }` — sidebar asking to reopen a
  recent file).

This is ~15 lines, not a framework — consistent with the original
spec's "no framework" decision. Each module only knows about events,
not about other modules' internals.

## Architecture

```
pdf-reader/
├── src-tauri/src/
│   ├── main.rs
│   ├── commands.rs          # existing: open_pdf_file (extended)
│   └── recent_files.rs      # new: recent/pinned persistence
├── src/
│   ├── index.html           # sidebar + main area markup added
│   ├── main.js               # wiring, now also drag-drop listeners
│   ├── app-events.js         # new: tiny event bus
│   ├── sidebar.js            # new: renders recent/pinned list
│   ├── empty-state.js        # new: empty-state drop zone + click-to-open
│   ├── viewer.js             # existing, unchanged rendering logic
│   └── styles.css
```

## Layout

```
┌─────────────────────────────────────────┐
│ toolbar (Open PDF button, status)         │
├──────────┬────────────────────────────────┤
│          │                                │
│ sidebar  │   main area:                   │
│ (Pinned  │   - empty state (drop zone +   │
│  + Recent)│    "+"/Open) when no PDF,     │
│          │   - OR viewer-container when   │
│          │     a PDF is loaded            │
│          │                                │
└──────────┴────────────────────────────────┘
```

- Sidebar: ~220px fixed width, dark-themed list. Each row shows
  filename, click to reopen, pin/unpin icon on hover.
- Empty state: centered dashed-border box with "+" icon and helper
  text, replacing the flat grey background. On drag-over, border/
  background shifts via CSS transition (GPU-composited, cheap — no
  canvas involved).

## Drag-and-drop

- A `dragover`/`drop` listener on `document.body`, calling
  `preventDefault()` on both so the WebView doesn't navigate away on
  drop.
- Works identically whether the empty state or an active viewer is
  showing — dropping while a PDF is open replaces the current view
  (emits `file-opened` same as the Open button path).
- **Path availability caveat:** a browser `File` object from a raw
  DOM drop doesn't reliably expose a filesystem path in a sandboxed
  WebView. Tauri 2 provides a native webview drag-drop API
  (`onFileDropEvent` / the `dragDropEnabled` window option) specifically
  to surface real paths for dropped files — implementation should use
  that native event instead of relying on the DOM `File` object, so
  dropped files can be recorded into Recent like any other open. This
  is an implementation detail to verify against the installed Tauri
  version, not a design gap: if for some reason a path truly isn't
  available, the file still opens, it just won't gain a recent entry.

## Rust persistence layer

New module `src-tauri/src/recent_files.rs`:

```rust
struct RecentEntry {
    path: String,
    name: String,
    opened_at: String, // ISO 8601
    pinned: bool,
}
```

- Stored as a JSON array at `<app_config_dir>/recent_files.json`.
- New Tauri commands:
  - `get_recent_files() -> Vec<RecentEntry>`
  - `record_opened_file(path: String)` — adds or bumps an entry to
    the top, trims the *non-pinned* portion of the list to 20 entries.
  - `toggle_pin(path: String)` — flips `pinned` on an existing entry.
- The existing `open_pdf_file` command is extended to call
  `record_opened_file` internally after a successful pick, so every
  open (toolbar button or sidebar click) updates recency. The
  drag-drop path calls `record_opened_file` explicitly once it has a
  native path from Tauri's drag-drop event.

## Data flow

1. **Open via button** (unchanged path) → `open_pdf_file` shows
   dialog, reads bytes, calls `record_opened_file`, returns bytes →
   frontend emits `file-opened` → viewer renders, sidebar refreshes
   its list from `get_recent_files`.
2. **Open via drag-drop** → Tauri drag-drop event gives a path →
   frontend reads the file's bytes (via a small Rust command reusing
   the same read logic as `open_pdf_file`, or Tauri's fs plugin) →
   calls `record_opened_file` → emits `file-opened` → same rendering
   path.
3. **Open via sidebar click** → sidebar emits `open-requested` with a
   path → same read-bytes-then-`file-opened` path as drag-drop (no
   native dialog needed, path is already known).
4. **Pin/unpin** → sidebar calls `toggle_pin`, then re-fetches and
   re-renders its list.

## Error handling

- Dropped file isn't a `.pdf` → inline status message (existing
  status line), no crash, no recent-entry recorded.
- Recent/pinned file clicked but has since moved or been deleted →
  read fails, show inline error, and remove that entry from the
  persisted list (auto-cleanup rather than leaving dead entries).
- `recent_files.json` missing or corrupt on startup → treated as an
  empty list; app doesn't error.
- Dialog cancelled, PDF.js parse failure → unchanged from v1 spec
  (no-op / inline status message respectively).

## Testing

Manual, consistent with the v1 spec's stance (UI surface too small for
automated UI tests to be worth it):

- Drag a PDF onto the empty state, onto an already-open viewer, and
  confirm it opens both times without navigating the window away.
- Drop a non-PDF file — confirm graceful inline error, no crash.
- Open via toolbar button, confirm it appears in Recent; pin it,
  confirm it moves to Pinned; unpin, confirm it returns to Recent in
  correct order.
- Restart the app, confirm Recent/Pinned persisted from
  `recent_files.json`.
- Delete a file on disk, click its recent entry, confirm graceful
  error and that the entry is removed from the list.
- Confirm the existing `tests/zoom.test.js` still passes unmodified.

## Modularity notes

- This design keeps `viewer.js`'s rendering logic untouched — all new
  code is additive (`app-events.js`, `sidebar.js`, `empty-state.js`,
  `recent_files.rs`) or extends `open_pdf_file`'s existing success
  path with one extra call.
- Future folders/collections could extend `RecentEntry` with a
  `collection: Option<String>` field and a `sidebar.js` grouping
  change, without touching the event bus or rendering path.
