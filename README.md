# PDF Reader

A lightweight Windows PDF reader built with Tauri 2 and vendored PDF.js. There
is no frontend bundler — `src/` is plain HTML/CSS/JS served as-is, and
`src/vendor/pdfjs/` contains the pre-built PDF.js library files copied in
directly.

See `docs/superpowers/specs/` for the design and task breakdown.

## Development

```
npm install
npm run tauri dev
```

## Tests

- `npm test` — frontend unit tests (zoom and page layout math) via Vitest.
- `cargo test` (from `src-tauri/`) — Rust unit tests for file reading.

## PDF viewer

PDF.js page dimensions are collected up front to reserve stable layout slots.
Canvas rendering is lazy: visible pages and pages within one viewport are
rendered, while distant canvases are released without changing the page slots.
Single-page mode uses one column; dual-page mode uses two columns at normal
zoom and adds gallery columns when more pages fit at lower zoom levels.
Desktop and mobile page spacing is 16px and 12px, respectively.

## Manual viewer checks

### Mobile

- [ ] Touch scroll/pan, pinch zoom, and toolbar zoom in/out
- [ ] Single-page and dual-page modes; verify the dual-page pair fits
- [ ] 2-page, 3–5-page, 10+-page, and long documents
- [ ] Slow and fast scrolling while pages load and unload
- [ ] Rotate the device and resize the viewport in both page modes

### Laptop / desktop

- [ ] Mouse wheel and vertical trackpad scrolling
- [ ] Trackpad pinch and Ctrl/Meta+wheel zoom in/out
- [ ] Single-page, dual-page, and gallery layouts; last unpaired page
- [ ] 10+-page and long documents; verify fast-scroll rendering
- [ ] Confirm native browser zoom does not compete with viewer gestures

### Shared layout cases

- [ ] 1, 2, 3, 4, 6, 10+, and 50+ page documents
- [ ] Extreme zoom in/out, gallery layout, and consistent page gaps
- [ ] Small-content centering and large-content pan bounds with the sidebar
- [ ] Hover/tap/active document border matches the Drop Zone accent
- [ ] Android SAF filenames show the real display name, not a URI document ID
