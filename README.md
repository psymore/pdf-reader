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

- `npm test` — frontend unit tests (zoom math) via Vitest.
- `cargo test` (from `src-tauri/`) — Rust unit tests for file reading.
