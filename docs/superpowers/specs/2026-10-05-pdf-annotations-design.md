# PDF annotations (mark-up) design

Date: 2026-10-05
Status: draft, awaiting review

## Goal

Let a user mark up an open PDF on desktop and Android: highlight text, draw
freehand, add text notes, erase, and undo/redo. Marks are saved into a copy of
the PDF as real PDF annotations. Editing the PDF's own content is out of scope.
Word (.docx) viewing is unchanged.

## Decisions (agreed)

- Tools in v1: highlight, freehand ink, text note, eraser, undo/redo.
- Saving: "Save as" writes a new PDF with the marks embedded. The original file
  is never modified.
- Approach: our own SVG overlay per page plus pdf-lib for export. We do not use
  pdf.js's built-in annotation editor (it is tied to `PDFViewer`'s own
  scroll/zoom and would conflict with our single-transform viewer and
  `touch-action: none`).

## Current state that shapes the design

- `src/viewer.js` renders pages to canvases inside `#pdf-pages`; pan and zoom
  are one JS transform on that element. There is no text layer.
- `src/vendor/pdfjs` holds only the core (`pdf.mjs`, worker). No pdf-lib.
- The app must work offline, so new libraries are vendored under `src/vendor/`.
- File I/O goes through Rust commands (`open_document_*`); `dialog:default` is
  already granted.

## Units

Each unit has one purpose and is testable on its own.

- `src/annotations.js` - data model, pure logic, no DOM. Marks are stored per
  page in **PDF page coordinates** (zoom independent): `highlight` (list of
  rects + colour), `ink` (point paths + colour + width), `note` (position +
  text). Add, remove, undo/redo stack, dirty flag.
- `src/text-layer.js` - renders pdf.js `TextLayer` per page; converts a text
  selection into page-coordinate rects. The one missing piece for highlight.
- `src/annotation-layer.js` - one SVG overlay per page slot. Draws marks from
  the model, captures tool input, converts screen to page coordinates using the
  current pan/zoom/render scale. The overlay lives inside `#pdf-pages`, so it
  inherits the existing transform; `viewer.js` transform logic is unchanged.
- `src/annotation-toolbar.js` - tool selection, colour, undo/redo, Save as.
  With no tool active the viewer behaves exactly as today (pan, pinch,
  momentum). With a tool active, one finger marks and two fingers still pinch.
- `src/pdf-export.js` - takes the original PDF bytes and the model, uses
  pdf-lib to write Highlight, Ink and FreeText annotations, returns new bytes.
- `viewer.js` additions only: a hook to attach layers to page slots, and an
  "annotation tool active" signal that routes one-finger touches to the tool.

## Data flow

1. User picks a tool. The overlay converts input to page coordinates and issues
   a command to the model (undo/redo stack).
2. A model change redraws only the affected page's SVG.
3. After a zoom re-render (`rerenderPages`), layers redraw from the model;
   marks do not drift because they live in page coordinates.
4. Highlight: selection to rects via the text layer. Ink: collect points along
   the touch and lightly simplify. Note: tap places a text box.
5. Save as: `pdf-export.js` gets the original bytes (already held by the
   viewer) plus the model, then a new Rust command (`save_document_as`) writes
   the result to the path chosen in the dialog plugin's save dialog.
6. Closing or opening another document with unsaved marks asks one
   confirmation, hooked into the existing "new open supersedes the old" flow.

## Android

Saving uses the SAF create-document picker, which gives write access to a new
`content://` URI. We never overwrite the source. This path needs verification
on a real phone and is called out explicitly in the plan.

## Errors

- pdf-lib failure (encrypted or corrupt PDF): report through the existing
  `reportError` status channel; the model is kept so the user can retry.
- Scanned PDFs with no selectable text: the highlight tool reports "no
  selectable text on this page"; ink and note still work.

## Testing

- Vitest, pure logic: model (add, remove, undo/redo, dirty), screen to page
  coordinate conversion, rect merging.
- Vitest, export: write annotations into a small sample PDF, read them back
  with pdf.js and assert type, page and position.
- Manual on device: touch drawing feel, pinch while a tool is active, Android
  save flow.

## Out of scope

Editing existing PDF text or images, overwriting the original file, form
filling, page operations (merge, split, rotate), Word editing.
