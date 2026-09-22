# PDF Reader — Sidebar, Recent Files & Drag-and-Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a left sidebar (pinned + recent files), whole-window drag-and-drop opening, and a redesigned empty state to the existing Tauri PDF reader.

**Architecture:** Rust gains a small `recent_files` module (pure list-manipulation functions + JSON persistence in the app config dir) and two new/extended Tauri commands. The frontend gains a tiny `EventTarget`-based event bus so the toolbar, sidebar, empty-state, and viewer can react to "a file was opened" / "open this file" without importing each other directly. Sidebar/empty-state are new DOM-rendering modules; `main.js` becomes the orchestrator that wires the event bus, the native Tauri drag-drop event, and toggles which main-area view (empty state vs. viewer) is visible.

**Tech Stack:** Tauri 2.11.6 (Rust backend), vanilla JS/HTML/CSS frontend (no framework), PDF.js for rendering, Vitest for JS unit tests, `cargo test` for Rust unit tests.

**Spec:** `docs/superpowers/specs/2026-09-22-pdf-reader-sidebar-dnd-design.md`

## Global Constraints

- No new frontend framework or bundler — stay vanilla JS/HTML/CSS (per both specs' explicit "no framework" decision).
- Sidebar is fixed-width (~220px), always visible — no collapse/toggle in this scope.
- Recent list capped at 20 non-pinned entries; pinned entries never count against the cap and never appear in the Recent section.
- Drag-and-drop must work anywhere in the window, both on the empty state and over an already-open viewer.
- Persist recent/pinned entries as JSON in the Tauri app config dir — no database dependency.
- `opened_at` is stored as **milliseconds since Unix epoch** (`u64`), not an ISO 8601 string as loosely mentioned in the design spec's data model — the spec's own UI description never displays this value (only the filename is shown per row), so a plain sortable integer avoids pulling in a date-formatting crate for zero user-visible benefit. This does not change any spec-visible behavior.
- Existing behavior must not regress: `tests/zoom.test.js` and the two existing Rust unit tests in `commands.rs` must keep passing untouched.
- The design spec mentions a standalone `record_opened_file` command; this plan folds that behavior into a shared internal `open_path_and_record` helper used by both `open_pdf_file` and the new `open_pdf_path` command instead of exposing it separately — every path that opens a file (dialog, drag-drop, sidebar reopen) still updates the recent list exactly as the spec's data-flow section describes, this just avoids a redundant extra IPC round-trip per open.

---

### Task 1: Rust — recent-files core logic (pure functions + tests)

**Files:**
- Create: `src-tauri/src/recent_files.rs`
- Modify: `src-tauri/src/lib.rs:2` (add `mod recent_files;`)

**Interfaces:**
- Produces: `RecentEntry { path: String, name: String, opened_at: u64, pinned: bool }` (public struct, `Serialize`/`Deserialize`/`Clone`/`PartialEq`/`Debug`), `pub const RECENT_CAP: usize = 20;`, `pub fn upsert_and_trim(entries: Vec<RecentEntry>, path: &str, name: &str, opened_at: u64, cap: usize) -> Vec<RecentEntry>`, `pub fn toggle_pin(entries: Vec<RecentEntry>, path: &str) -> Vec<RecentEntry>`, `pub fn remove_entry(entries: Vec<RecentEntry>, path: &str) -> Vec<RecentEntry>`.
- Consumes: nothing from other tasks (pure, in-memory `Vec<RecentEntry>` in and out — no filesystem, no `AppHandle`).

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/recent_files.rs` with just the struct and function signatures returning `unimplemented!()`, plus this test module:

```rust
use serde::{Deserialize, Serialize};

pub const RECENT_CAP: usize = 20;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecentEntry {
    pub path: String,
    pub name: String,
    pub opened_at: u64,
    pub pinned: bool,
}

pub fn upsert_and_trim(
    entries: Vec<RecentEntry>,
    path: &str,
    name: &str,
    opened_at: u64,
    cap: usize,
) -> Vec<RecentEntry> {
    unimplemented!()
}

pub fn toggle_pin(entries: Vec<RecentEntry>, path: &str) -> Vec<RecentEntry> {
    unimplemented!()
}

pub fn remove_entry(entries: Vec<RecentEntry>, path: &str) -> Vec<RecentEntry> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, opened_at: u64, pinned: bool) -> RecentEntry {
        RecentEntry {
            path: path.to_string(),
            name: path.to_string(),
            opened_at,
            pinned,
        }
    }

    #[test]
    fn upsert_adds_new_entry_to_front() {
        let entries = vec![entry("a.pdf", 100, false)];
        let result = upsert_and_trim(entries, "b.pdf", "b.pdf", 200, 20);
        assert_eq!(result[0].path, "b.pdf");
        assert_eq!(result[1].path, "a.pdf");
    }

    #[test]
    fn upsert_bumps_existing_entry_to_front_and_updates_timestamp() {
        let entries = vec![entry("a.pdf", 100, false), entry("b.pdf", 50, false)];
        let result = upsert_and_trim(entries, "b.pdf", "b.pdf", 999, 20);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].path, "b.pdf");
        assert_eq!(result[0].opened_at, 999);
        assert_eq!(result[1].path, "a.pdf");
    }

    #[test]
    fn upsert_trims_non_pinned_entries_to_cap() {
        let mut entries = Vec::new();
        for i in 0..5 {
            entries.push(entry(&format!("f{i}.pdf"), i as u64, false));
        }
        let result = upsert_and_trim(entries, "new.pdf", "new.pdf", 999, 3);
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].path, "new.pdf");
    }

    #[test]
    fn upsert_does_not_count_pinned_entries_against_cap() {
        let mut entries = vec![entry("pinned1.pdf", 1, true), entry("pinned2.pdf", 2, true)];
        for i in 0..5 {
            entries.push(entry(&format!("f{i}.pdf"), 10 + i as u64, false));
        }
        let result = upsert_and_trim(entries, "new.pdf", "new.pdf", 999, 3);
        let pinned_count = result.iter().filter(|e| e.pinned).count();
        let non_pinned_count = result.iter().filter(|e| !e.pinned).count();
        assert_eq!(pinned_count, 2);
        assert_eq!(non_pinned_count, 3);
    }

    #[test]
    fn toggle_pin_flips_pinned_flag() {
        let entries = vec![entry("a.pdf", 1, false)];
        let result = toggle_pin(entries, "a.pdf");
        assert!(result[0].pinned);
        let result = toggle_pin(result, "a.pdf");
        assert!(!result[0].pinned);
    }

    #[test]
    fn toggle_pin_on_unknown_path_is_a_noop() {
        let entries = vec![entry("a.pdf", 1, false)];
        let result = toggle_pin(entries.clone(), "missing.pdf");
        assert_eq!(result, entries);
    }

    #[test]
    fn remove_entry_filters_out_matching_path() {
        let entries = vec![entry("a.pdf", 1, false), entry("b.pdf", 2, false)];
        let result = remove_entry(entries, "a.pdf");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].path, "b.pdf");
    }
}
```

- [ ] **Step 2: Add `mod recent_files;` to `src-tauri/src/lib.rs`**

```rust
// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod commands;
mod recent_files;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![commands::open_pdf_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Run tests to verify they fail (panic on `unimplemented!()`)**

Run: `cd src-tauri && cargo test recent_files`
Expected: FAIL — tests panic with "not implemented"

- [ ] **Step 4: Implement the three functions**

Replace the `unimplemented!()` bodies:

```rust
pub fn upsert_and_trim(
    entries: Vec<RecentEntry>,
    path: &str,
    name: &str,
    opened_at: u64,
    cap: usize,
) -> Vec<RecentEntry> {
    let mut without_target: Vec<RecentEntry> =
        entries.into_iter().filter(|e| e.path != path).collect();

    without_target.push(RecentEntry {
        path: path.to_string(),
        name: name.to_string(),
        opened_at,
        pinned: false,
    });

    let (mut pinned, mut unpinned): (Vec<_>, Vec<_>) =
        without_target.into_iter().partition(|e| e.pinned);

    unpinned.sort_by(|a, b| b.opened_at.cmp(&a.opened_at));
    unpinned.truncate(cap);
    pinned.sort_by(|a, b| b.opened_at.cmp(&a.opened_at));

    // Newly-opened file goes first among non-pinned, unless it was already
    // pinned (in which case it stays in the pinned group, updated above).
    let mut result: Vec<RecentEntry> = Vec::new();
    result.extend(unpinned);
    result.extend(pinned);
    result.sort_by(|a, b| b.opened_at.cmp(&a.opened_at));
    result
}

pub fn toggle_pin(entries: Vec<RecentEntry>, path: &str) -> Vec<RecentEntry> {
    entries
        .into_iter()
        .map(|mut e| {
            if e.path == path {
                e.pinned = !e.pinned;
            }
            e
        })
        .collect()
}

pub fn remove_entry(entries: Vec<RecentEntry>, path: &str) -> Vec<RecentEntry> {
    entries.into_iter().filter(|e| e.path != path).collect()
}
```

Note: the re-sort at the end of `upsert_and_trim` means the returned list is
always ordered most-recent-first overall (pinned and unpinned interleaved by
timestamp) — the *pinned vs. recent grouping* for display happens in the
frontend (Task 4's `groupByPinned`), not here. The cap only ever applies to
the non-pinned subset before merging back in.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test recent_files`
Expected: PASS — all 7 tests green

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/recent_files.rs src-tauri/src/lib.rs
git commit -m "feat: add recent-files list logic (upsert, pin, remove)"
```

---

### Task 2: Rust — JSON persistence + Tauri commands

**Files:**
- Modify: `src-tauri/src/recent_files.rs` (add persistence functions)
- Modify: `src-tauri/src/commands.rs` (extend `open_pdf_file`, add `open_pdf_path`, `get_recent_files`, `toggle_pin_command`, `remove_recent_entry`)
- Modify: `src-tauri/src/lib.rs` (register new commands)

**Interfaces:**
- Consumes: `RecentEntry`, `upsert_and_trim`, `toggle_pin`, `remove_entry`, `RECENT_CAP` from Task 1.
- Produces: Tauri commands invokable from JS as `open_pdf_file`, `open_pdf_path(path: String)`, `get_recent_files()`, `toggle_pin(path: String)`, `remove_recent_entry(path: String)` — each (except `open_pdf_file`'s error case) returns `Result<Vec<RecentEntry>, String>` for the list-returning ones, or `Result<tauri::ipc::Response, String>` for the two open commands. Frontend tasks (5, 8) call these by exact name.

This task touches the filesystem and `AppHandle`, so it isn't unit-testable
the same way Task 1 was — this matches the existing pattern in this file,
where `open_pdf_file` itself has no unit test but the pure `read_pdf_bytes`
helper does. Verification here is a manual run at the end of the task.

- [ ] **Step 1: Add persistence helpers to `recent_files.rs`**

Append to `src-tauri/src/recent_files.rs`:

```rust
use std::fs;
use tauri::Manager;

fn store_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to resolve app config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app config dir: {e}"))?;
    Ok(dir.join("recent_files.json"))
}

pub fn load(app: &tauri::AppHandle) -> Vec<RecentEntry> {
    let path = match store_path(app) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let Ok(contents) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&contents).unwrap_or_default()
}

pub fn save(app: &tauri::AppHandle, entries: &[RecentEntry]) -> Result<(), String> {
    let path = store_path(app)?;
    let json = serde_json::to_string_pretty(entries)
        .map_err(|e| format!("Failed to serialize recent files: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write recent files: {e}"))
}

pub fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
```

- [ ] **Step 2: Rewrite `commands.rs` to add the shared open-and-record path and the new commands**

Replace the full contents of `src-tauri/src/commands.rs`:

```rust
use crate::recent_files::{self, RecentEntry};
use std::fs;
use std::path::Path;

pub fn read_pdf_bytes(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("Failed to read file: {e}"))
}

fn file_name_or_path(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// Reads a PDF's bytes, records it in the recent-files list, and returns
/// the bytes as an IPC response. Shared by both `open_pdf_file` (native
/// dialog) and `open_pdf_path` (drag-drop / sidebar reopen).
fn open_path_and_record(
    app: &tauri::AppHandle,
    path: &Path,
) -> Result<tauri::ipc::Response, String> {
    let bytes = read_pdf_bytes(path)?;

    let path_str = path.to_string_lossy().to_string();
    let name = file_name_or_path(path);
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
pub async fn open_pdf_file(app: tauri::AppHandle) -> Result<tauri::ipc::Response, String> {
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
            open_path_and_record(&app, path)
        }
        None => Err("cancelled".to_string()),
    }
}

#[tauri::command]
pub async fn open_pdf_path(
    app: tauri::AppHandle,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    open_path_and_record(&app, Path::new(&path))
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

Note: `toggle_pin` here is the Tauri command name exposed to JS (matches
the design spec's `toggle_pin(path)` command name exactly); it shadows
nothing since `recent_files::toggle_pin` is called via its module path.

- [ ] **Step 3: Register the new commands in `lib.rs`**

```rust
// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod commands;
mod recent_files;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::open_pdf_file,
            commands::open_pdf_path,
            commands::get_recent_files,
            commands::toggle_pin,
            commands::remove_recent_entry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 4: Run the full Rust test suite**

Run: `cd src-tauri && cargo test`
Expected: PASS — the 2 existing `commands` tests, 7 `recent_files` tests, all green.

- [ ] **Step 5: Compile-check the whole app**

Run: `cd src-tauri && cargo check`
Expected: no errors. If `tauri::Manager` import or `app.path()` doesn't
resolve, check the installed `tauri = "2"` version's `Manager` trait is in
scope (it's imported at the top of the `recent_files.rs` persistence
section added in Step 1) — this is the standard Tauri v2 path-resolution
API, no `Cargo.toml` changes should be needed since `tauri-plugin-dialog`
already pulled in `tauri` v2 with default path APIs.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/recent_files.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: persist recent files to disk and expose Tauri commands"
```

---

### Task 3: Frontend — event bus

**Files:**
- Create: `src/app-events.js`
- Test: `tests/app-events.test.js`

**Interfaces:**
- Produces: `export function emit(name, detail)`, `export function on(name, handler)`. Events used elsewhere in this plan: `"file-opened"` (detail: `{ path, name }` or `null` for the initial dialog-triggered open — see Task 8), `"open-requested"` (detail: `{ path }`), `"dialog-open-requested"` (no detail), `"drag-active"` (detail: `{ active: boolean }`).
- Consumes: nothing (leaf module).

- [ ] **Step 1: Write the failing test**

Create `tests/app-events.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { emit, on } from "../src/app-events.js";

describe("app-events", () => {
  it("calls a registered handler with the emitted detail", () => {
    const handler = vi.fn();
    on("test-event", handler);
    emit("test-event", { foo: "bar" });
    expect(handler).toHaveBeenCalledWith({ foo: "bar" });
  });

  it("does not call handlers registered for a different event name", () => {
    const handler = vi.fn();
    on("other-event", handler);
    emit("test-event-2", { foo: "bar" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("supports multiple handlers for the same event", () => {
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    on("multi-event", handlerA);
    on("multi-event", handlerB);
    emit("multi-event", 42);
    expect(handlerA).toHaveBeenCalledWith(42);
    expect(handlerB).toHaveBeenCalledWith(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- app-events`
Expected: FAIL — `../src/app-events.js` does not exist

- [ ] **Step 3: Write the implementation**

Create `src/app-events.js`:

```js
const bus = new EventTarget();

export function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on(name, handler) {
  bus.addEventListener(name, (event) => handler(event.detail));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- app-events`
Expected: PASS — all 3 tests green

- [ ] **Step 5: Commit**

```bash
git add src/app-events.js tests/app-events.test.js
git commit -m "feat: add tiny event bus for cross-module UI events"
```

---

### Task 4: Frontend — recent-list grouping logic

**Files:**
- Create: `src/recent-list.js`
- Test: `tests/recent-list.test.js`

**Interfaces:**
- Consumes: `RecentEntry`-shaped plain objects `{ path, name, opened_at, pinned }` (matches Task 1/2's Rust struct field names as serialized by `serde_json`, which uses the Rust field names verbatim — no camelCase conversion is configured, so JS reads `opened_at` not `openedAt`).
- Produces: `export function groupByPinned(entries) -> { pinned: RecentEntry[], recent: RecentEntry[] }`, both sub-arrays ordered most-recent-first. Consumed by `sidebar.js` (Task 5).

- [ ] **Step 1: Write the failing test**

Create `tests/recent-list.test.js`:

```js
import { describe, it, expect } from "vitest";
import { groupByPinned } from "../src/recent-list.js";

function entry(path, opened_at, pinned) {
  return { path, name: path, opened_at, pinned };
}

describe("groupByPinned", () => {
  it("splits entries into pinned and recent groups", () => {
    const entries = [
      entry("a.pdf", 300, true),
      entry("b.pdf", 200, false),
      entry("c.pdf", 100, false),
    ];
    const { pinned, recent } = groupByPinned(entries);
    expect(pinned.map((e) => e.path)).toEqual(["a.pdf"]);
    expect(recent.map((e) => e.path)).toEqual(["b.pdf", "c.pdf"]);
  });

  it("orders each group most-recent-first", () => {
    const entries = [
      entry("old.pdf", 100, false),
      entry("new.pdf", 999, false),
    ];
    const { recent } = groupByPinned(entries);
    expect(recent.map((e) => e.path)).toEqual(["new.pdf", "old.pdf"]);
  });

  it("returns empty arrays for an empty input", () => {
    const { pinned, recent } = groupByPinned([]);
    expect(pinned).toEqual([]);
    expect(recent).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- recent-list`
Expected: FAIL — `../src/recent-list.js` does not exist

- [ ] **Step 3: Write the implementation**

Create `src/recent-list.js`:

```js
export function groupByPinned(entries) {
  const pinned = entries
    .filter((e) => e.pinned)
    .slice()
    .sort((a, b) => b.opened_at - a.opened_at);
  const recent = entries
    .filter((e) => !e.pinned)
    .slice()
    .sort((a, b) => b.opened_at - a.opened_at);
  return { pinned, recent };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- recent-list`
Expected: PASS — all 3 tests green

- [ ] **Step 5: Commit**

```bash
git add src/recent-list.js tests/recent-list.test.js
git commit -m "feat: add pinned/recent grouping logic for the sidebar"
```

---

### Task 5: Frontend — sidebar rendering + wiring

**Files:**
- Create: `src/sidebar.js`

**Interfaces:**
- Consumes: `groupByPinned` (Task 4), `emit`/`on` (Task 3), `window.__TAURI__.core.invoke` (Tauri global, already used in `main.js`).
- Produces: `export function initSidebar()` — call once from `main.js` (Task 8). Emits `"open-requested"` with `{ path }` when a row is clicked. No return value consumed elsewhere.

This is DOM-rendering/wiring code, like the existing `viewer.js` and
`main.js` — not unit tested, consistent with this codebase's existing
pattern (only pure logic modules like `zoom.js` have tests). Verified
manually per Task 9's checklist.

- [ ] **Step 1: Add sidebar markup placeholders to `index.html`**

This step is completed as part of Task 7 (layout restructure) — `sidebar.js`
expects `#sidebar-pinned` and `#sidebar-recent` container elements to
already exist in the DOM by the time `initSidebar()` runs. Skip ahead to
Task 7 first if working strictly in order, or implement Tasks 5–7 together
since they're tightly coupled; either order works as long as Task 8 wires
everything after Tasks 5, 6, and 7 are all in place.

- [ ] **Step 2: Implement `sidebar.js`**

Create `src/sidebar.js`:

```js
import { groupByPinned } from "./recent-list.js";
import { emit, on } from "./app-events.js";

const { invoke } = window.__TAURI__.core;

let pinnedContainer = null;
let recentContainer = null;

export function initSidebar() {
  pinnedContainer = document.getElementById("sidebar-pinned");
  recentContainer = document.getElementById("sidebar-recent");

  refresh();
  on("file-opened", refresh);
}

async function refresh() {
  const entries = await invoke("get_recent_files");
  const { pinned, recent } = groupByPinned(entries);
  render(pinnedContainer, pinned);
  render(recentContainer, recent);
}

function render(container, entries) {
  container.innerHTML = "";
  for (const entry of entries) {
    container.appendChild(renderRow(entry));
  }
}

function renderRow(entry) {
  const row = document.createElement("div");
  row.className = "sidebar-row";

  const label = document.createElement("span");
  label.className = "sidebar-row-label";
  label.textContent = entry.name;
  label.title = entry.path;
  label.addEventListener("click", () => {
    emit("open-requested", { path: entry.path });
  });
  row.appendChild(label);

  const pinBtn = document.createElement("button");
  pinBtn.className = "sidebar-pin-btn";
  pinBtn.textContent = entry.pinned ? "★" : "☆"; // filled/outline star
  pinBtn.title = entry.pinned ? "Unpin" : "Pin";
  pinBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    await invoke("toggle_pin", { path: entry.path });
    await refresh();
  });
  row.appendChild(pinBtn);

  return row;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/sidebar.js
git commit -m "feat: render pinned/recent sidebar with pin toggle"
```

(This won't build/render correctly until Task 7 adds the DOM containers it
targets — that's expected; commit anyway to keep tasks independently
reviewable, matching the plan's file-by-file breakdown.)

---

### Task 6: Frontend — empty state

**Files:**
- Create: `src/empty-state.js`

**Interfaces:**
- Consumes: `emit` (Task 3).
- Produces: `export function initEmptyState()` — call once from `main.js` (Task 8). Emits `"dialog-open-requested"` on click.

- [ ] **Step 1: Implement `empty-state.js`**

Create `src/empty-state.js`:

```js
import { emit } from "./app-events.js";

export function initEmptyState() {
  const zone = document.getElementById("empty-state");
  zone.addEventListener("click", () => {
    emit("dialog-open-requested");
  });
}
```

The drag-over highlight is driven globally by `main.js` (Task 8) toggling a
`drag-active` class on `<body>`, since real drop handling needs Tauri's
native drag-drop event (for a filesystem path) rather than the DOM
`dragover`/`drop` events — see Task 8 and the design spec's "path
availability caveat".

- [ ] **Step 2: Commit**

```bash
git add src/empty-state.js
git commit -m "feat: add empty-state click-to-open handler"
```

---

### Task 7: Frontend — layout restructure (HTML + CSS)

**Files:**
- Modify: `src/index.html`
- Modify: `src/styles.css`

**Interfaces:**
- Produces the DOM elements every other frontend task depends on:
  `#sidebar-pinned`, `#sidebar-recent` (Task 5), `#empty-state` (Task 6),
  `#viewer-container` (already exists, used by `viewer.js`), plus a
  `#main-area` wrapper that `main.js` (Task 8) toggles between showing
  `#empty-state` and `#viewer-container`.

- [ ] **Step 1: Rewrite `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="styles.css" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>PDF Reader</title>
    <script type="module" src="/main.js" defer></script>
  </head>

  <body>
    <div id="toolbar">
      <button id="open-btn">Open PDF</button>
      <span id="status"></span>
    </div>
    <div id="app-shell">
      <aside id="sidebar">
        <div class="sidebar-section">
          <h3 class="sidebar-heading">Pinned</h3>
          <div id="sidebar-pinned"></div>
        </div>
        <div class="sidebar-section">
          <h3 class="sidebar-heading">Recent</h3>
          <div id="sidebar-recent"></div>
        </div>
      </aside>
      <div id="main-area">
        <div id="empty-state">
          <div id="empty-state-icon">+</div>
          <p id="empty-state-text">Drop a PDF here or click to open</p>
        </div>
        <div id="viewer-container" hidden></div>
      </div>
    </div>
  </body>
</html>
```

- [ ] **Step 2: Rewrite the layout portion of `styles.css`**

Replace the block from `#toolbar` to the end of the file (keep everything
above `#toolbar` — the `:root`, `body`, `a`, `input`/`button` rules —
unchanged):

```css
#toolbar {
  height: 48px;
  box-sizing: border-box;
  padding: 8px 12px;
  display: flex;
  align-items: center;
  gap: 12px;
}

#app-shell {
  display: flex;
  height: calc(100vh - 48px);
}

#sidebar {
  width: 220px;
  flex-shrink: 0;
  box-sizing: border-box;
  padding: 12px 8px;
  background: #202020;
  color: #e0e0e0;
  overflow-y: auto;
}

.sidebar-heading {
  font-size: 0.75em;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #888;
  margin: 12px 8px 4px;
}

.sidebar-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}

.sidebar-row:hover {
  background: #2f2f2f;
}

.sidebar-row-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.sidebar-pin-btn {
  background: transparent;
  border: none;
  box-shadow: none;
  color: #e0e0e0;
  padding: 0 4px;
  visibility: hidden;
}

.sidebar-row:hover .sidebar-pin-btn {
  visibility: visible;
}

#main-area {
  flex: 1;
  position: relative;
  overflow: hidden;
  background: #808080;
}

#empty-state {
  position: absolute;
  inset: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 2px dashed #aaa;
  border-radius: 12px;
  color: #f0f0f0;
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

#empty-state[hidden] {
  display: none;
}

#empty-state-icon {
  font-size: 3em;
  line-height: 1;
  margin-bottom: 8px;
}

body.drag-active #empty-state {
  border-color: #396cd8;
  background-color: rgba(57, 108, 216, 0.1);
}

#viewer-container {
  height: 100%;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
}

#viewer-container[hidden] {
  display: none;
}

.pdf-page {
  margin: 8px 0;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.5);
  background: white;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/index.html src/styles.css
git commit -m "feat: restructure layout with sidebar and empty-state drop zone"
```

---

### Task 8: Frontend — main.js orchestration (wiring everything together)

**Files:**
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `initSidebar` (Task 5), `initEmptyState` (Task 6), `emit`/`on` (Task 3), `renderPdf`/`setStatusCallback` (existing `viewer.js`), Tauri commands `open_pdf_file`, `open_pdf_path`, `remove_recent_entry` (Task 2), and the Tauri global `window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(...)`.
- Produces: nothing consumed by later tasks — this is the top-level entry point.

- [ ] **Step 1: Rewrite `main.js`**

```js
import { renderPdf, setStatusCallback } from "./viewer.js";
import { emit, on } from "./app-events.js";
import { initSidebar } from "./sidebar.js";
import { initEmptyState } from "./empty-state.js";

const { invoke } = window.__TAURI__.core;
const { getCurrentWebview } = window.__TAURI__.webview;

const openBtn = document.getElementById("open-btn");
const status = document.getElementById("status");
const emptyState = document.getElementById("empty-state");
const viewerContainer = document.getElementById("viewer-container");

setStatusCallback((message) => {
  status.textContent = message;
});

function showViewer() {
  emptyState.hidden = true;
  viewerContainer.hidden = false;
}

function showEmptyState() {
  emptyState.hidden = false;
  viewerContainer.hidden = true;
}

async function openViaBytesResult(invokePromise) {
  status.textContent = "";
  try {
    const bytes = await invokePromise;
    await renderPdf(new Uint8Array(bytes));
    showViewer();
    emit("file-opened", null);
  } catch (err) {
    if (err === "cancelled") return;
    status.textContent = `Error: ${err}`;
  }
}

async function handleOpenClick() {
  await openViaBytesResult(invoke("open_pdf_file"));
}

async function handleOpenRequested({ path }) {
  status.textContent = "";
  try {
    const bytes = await invoke("open_pdf_path", { path });
    await renderPdf(new Uint8Array(bytes));
    showViewer();
    emit("file-opened", { path });
  } catch (err) {
    status.textContent = `Error: ${err}`;
    try {
      await invoke("remove_recent_entry", { path });
    } finally {
      emit("file-opened", null); // refresh sidebar to drop the dead entry
    }
  }
}

openBtn.addEventListener("click", handleOpenClick);
on("dialog-open-requested", handleOpenClick);
on("open-requested", handleOpenRequested);

initSidebar();
initEmptyState();
showEmptyState();

getCurrentWebview().onDragDropEvent((event) => {
  const type = event.payload.type;
  if (type === "over") {
    document.body.classList.add("drag-active");
  } else if (type === "drop") {
    document.body.classList.remove("drag-active");
    const paths = event.payload.paths || [];
    const pdfPath = paths.find((p) => p.toLowerCase().endsWith(".pdf"));
    if (!pdfPath) {
      status.textContent = "Please drop a PDF file.";
      return;
    }
    handleOpenRequested({ path: pdfPath });
  } else {
    document.body.classList.remove("drag-active");
  }
});
```

- [ ] **Step 2: Verify the `onDragDropEvent` API name against the installed Tauri version**

Run: `grep -r "onDragDropEvent" src-tauri/target/release/build/ 2>/dev/null; echo "---"; find / -iname "*.d.ts" -path "*webview*" 2>/dev/null | head -5`

This project has no `@tauri-apps/api` npm package installed (it uses the
`withGlobalTauri: true` runtime global instead), so there are no local
type definitions to check against. `onDragDropEvent` on
`getCurrentWebview()` is the documented Tauri v2 API as of 2.x — if it
does not exist at runtime under this exact name/path, open the app with
dev tools (`npm run tauri dev`, then right-click → Inspect) and run
`window.__TAURI__.webview.getCurrentWebview()` in the console to see
what methods are actually available, and adjust the listener call in
Step 1 accordingly. This is a runtime-only check; there's no way to
verify it via `cargo check`/`vitest` since it's a JS-global API surface.

- [ ] **Step 3: Run the JS test suite to confirm no regression**

Run: `npm test`
Expected: PASS — `zoom.test.js`, `app-events.test.js`, `recent-list.test.js` all green (nothing in this task is itself unit-tested; this just guards against accidental breakage of the pure-logic modules).

- [ ] **Step 4: Commit**

```bash
git add src/main.js
git commit -m "feat: wire sidebar, empty-state, and drag-and-drop into main.js"
```

---

### Task 9: Manual verification pass

**Files:** none (verification only; may produce follow-up fix commits if issues are found)

- [ ] **Step 1: Run the full automated test suite one more time**

Run: `npm test && cd src-tauri && cargo test && cargo check`
Expected: all PASS, no compile errors.

- [ ] **Step 2: Run the app and walk through the manual test checklist from the design spec**

Run: `npm run tauri dev`

Walk through, in order:
1. App launches showing the redesigned empty state (not a flat grey box) with the sidebar visible alongside it.
2. Click the empty state → native file dialog opens → pick a PDF → it renders in the viewer, empty state hides.
3. Check the sidebar's Recent section now shows that file.
4. Pin it (star icon on hover) → confirm it moves to the Pinned section.
5. Unpin it → confirm it returns to Recent.
6. Drag a `.pdf` file from Windows Explorer onto the app while the empty state is showing → confirm it opens and the drop zone highlighted during the drag-over.
7. Drag a different `.pdf` onto the app while a PDF is already open (over the viewer, not the empty state) → confirm it replaces the current view.
8. Drag a non-PDF file (e.g. a `.txt`) onto the app → confirm a graceful inline status message, no crash.
9. Click a Recent entry in the sidebar → confirm it reopens that file.
10. Close and restart the app (`npm run tauri dev` again) → confirm Pinned/Recent entries persisted.
11. Move or delete one of the recent files on disk, then click its sidebar entry → confirm a graceful inline error and that the entry disappears from the sidebar afterward.
12. Confirm Ctrl+scroll zoom and plain-scroll pan (existing v1 behavior) still work inside the viewer.

- [ ] **Step 3: Fix any issues found, with their own focused commits**

If any checklist item fails, treat it as a normal bug fix: identify the
root cause in the relevant file from Tasks 1–8, fix it, re-run the
specific checklist item, then commit the fix separately (don't fold fixes
into earlier tasks' commits).

- [ ] **Step 4: Final commit marking the feature complete**

```bash
git add -A
git commit -m "chore: verify sidebar/recent-files/drag-and-drop feature end to end"
```

(Only run this if Step 3 produced no changes to commit — i.e., skip this
step if there's nothing staged, since an empty verification pass needs no
commit.)
