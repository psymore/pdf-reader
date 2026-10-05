# PDF Reader — Current State

## Completed

- Added distinct vertical-scroll and side-by-side layout icons.
- Fixed layout selection colors and state handling.
- Mobile defaults to vertical free-swiping mode.
- Replaced the mobile title with a view-options menu.
- Added sidebar actions to copy filenames, pin files, and remove entries from the reader list.
- Kept the original PDF safe when removing a sidebar entry.
- Added read-only Word (`.docx`) support (see the "Word viewer" section of the
  README, the design in `docs/superpowers/specs/2026-10-05-docx-support-design.md`
  and the plan in `docs/superpowers/plans/2026-10-05-docx-support.md`):
  - Files are routed to the PDF or Word viewer by their first bytes, so
    Android `content://` files and misnamed files open correctly. Legacy
    `.doc` files show a "save it as .docx" message and leave the current
    document open.
  - The file picker, drag-and-drop, "Open with" launch and the Windows file
    association accept `.pdf` and `.docx`. The Rust commands are now
    `open_document_file` / `open_document_path`.
  - Word documents render with vendored docx-preview 0.4.1 + JSZip 3.10.2 in
    their own scrolling pane. Zoom with the toolbar, Ctrl/⌘ + wheel,
    Ctrl/⌘ + `+`/`-`/`0`, and two-finger pinch. The side-by-side layout is
    PDF-only.
  - Links inside a Word document never navigate the app, and embedded HTML
    (altChunk) is not rendered.
  - Sidebar rows show a `PDF` / `DOCX` badge.

## Verification

- Frontend: 46 tests passed.
- Tauri/Rust: 14 tests passed.
- JavaScript syntax and Git whitespace checks passed.
- A release APK (arm64) builds successfully.

## Open Decision

No Content Security Policy is configured (`csp: null`), so a crafted `.docx`
can make the app request remote URLs and restyle the app UI through
docx-preview's unescaped CSS (no script execution). The proposed fix and its
trade-off are in the README's "Word viewer" known limitations. It requires
`dangerousDisableAssetCspModification` and a smoke test of both viewers.

## Remaining Check

Test on a physical Android device and on desktop: the toolbar, gestures,
layouts and sidebar actions, plus the README's "Word documents" checklist.
That includes opening `.docx` files from the Android picker, pinch zoom, links,
and switching between PDF and Word. No device was connected during the latest
verification. Use `npx tauri android dev --host` after the phone appears in
`adb devices`.
