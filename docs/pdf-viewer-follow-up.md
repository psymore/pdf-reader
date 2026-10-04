# PDF Viewer Follow-up

## Implemented

- PDF.js page dimensions are read in bounded batches before layout. Each page
  keeps a fixed-size slot, so rendering and unloading canvases does not change
  document geometry or pan bounds.
- `IntersectionObserver` renders pages in the viewer and a one-viewport
  buffer. Canvases outside that buffer are released; their slots remain.
- Zoom continues to use an immediate CSS transform followed by a debounced
  crisp render. The page under the zoom anchor is retained when the grid
  reflows, and only nearby pages need new canvases.
- Single-page mode is always one column. Dual-page mode uses an even-gap CSS
  grid, fitting two pages at normal zoom and adding columns as zoom decreases.
  The grid never creates columns beyond the document's page count.
- The viewer centers content that fits and clamps pan for content that
  overflows. Its flex parent can shrink alongside the desktop sidebar.
- Android recent-file names now come from Tauri's `PathResolver::file_name`,
  which reads the SAF display-name metadata for `content://` URIs. Names are
  no longer guessed from encoded URI segments. Desktop paths continue to use
  the real path basename.
- Sidebar hover, press, and active-document borders reuse the Drop Zone
  `--accent` theme token.

## Automated verification

- `npm test`: 20 tests passed, including page-column, gap, and fit-zoom cases.
- `cargo test` (from `src-tauri/`): 12 tests passed.
- JavaScript syntax checks, changed Rust file formatting check, and
  `git diff --check` passed.

## Manual verification still required

The desktop touchpad and Android device checks below require physical input
devices / a mobile runtime and have not been performed in this environment.
Use the checklist in [README.md](../README.md) to verify:

- Page counts from 1 through 50+, especially fast scrolling in long PDFs.
- Single, dual, and gallery layouts, including zoom extremes and an unpaired
  final page.
- Stable gaps, anchor retention, centering, and pan boundaries with the
  sidebar visible.
- Mobile touch pan and pinch, orientation changes, and Android SAF filenames.
- Mouse wheel, trackpad pan, trackpad pinch, and the absence of browser-native
  zoom conflicts.
