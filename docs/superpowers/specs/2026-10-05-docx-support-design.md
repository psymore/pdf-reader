# Word (.docx) Support — Design

## Goal

Let the app open Word `.docx` files read-only, on desktop (Windows) and
Android, alongside PDFs, without changing how PDFs behave.

## Decisions

- **Renderer:** [docx-preview](https://github.com/VolodymyrBaydalka/docxjs)
  0.4.1 (Apache-2.0) with its dependency JSZip 3.10.2 (MIT). Both are
  vendored into `src/vendor/docx-preview/` and loaded as classic `<script>`
  tags, matching how PDF.js is vendored (there is no bundler). docx-preview
  renders each Word page as a white `section.docx` with fonts, tables,
  images, headers/footers and page size/margins.
- **Separate viewer.** Word documents render into their own
  `#docx-container` (native scrolling) next to the existing
  `#viewer-container` (PDF, JS-driven pan/zoom). The PDF viewer swallows
  every wheel/touch event, so sharing its container is not an option.
  Only one viewer is visible and loaded at a time; switching documents
  releases the other one.
- **Type detection by content, not extension.** The frontend sniffs the
  file's first bytes: `%PDF-` → PDF, ZIP header → .docx, OLE header →
  legacy .doc (rejected with a clear message). Android `content://` URIs
  carry no extension, so the bytes are the only reliable signal.
  Unrecognized bytes fall through to PDF.js so existing error messages
  stay the same.
- **Entry points** (file picker, drag-and-drop, command-line / "Open with"
  launch, Windows file association) accept `.pdf` and `.docx`. Rust
  commands are renamed `open_document_file` / `open_document_path`.
- **Zoom for Word:** CSS `zoom` on the page wrapper. Opens at "fit width,
  never larger than 100%". Toolbar +/−/fit, Ctrl/⌘ + wheel,
  Ctrl/⌘ + `+`/`-`/`0`, and two-finger pinch on touch screens.
- **Toolbar:** the page-layout (side-by-side) button and menu options are
  hidden/disabled for Word documents. Zoom buttons are shown for both
  kinds and hidden when nothing is open.
- **Links inside a Word document never navigate the app window.**
  Internal bookmark links scroll within the document; other links are
  inert.
- **Sidebar** rows get a small `PDF` / `DOCX` badge derived from the file
  name.

## Non-goals (v1)

- Legacy binary `.doc`, `.rtf`, `.odt`.
- Editing, printing, text search, opening external links in a browser.
- Side-by-side layout for Word documents (page breaks are approximate).
- Renaming the app ("PDF Reader" product name and identifier stay).

## Known limitations

docx-preview approximates Word layout: text boxes, SmartArt, charts,
complex floating images and fonts missing on the device may look
different from Word. Page breaks are computed by docx-preview, not Word.
