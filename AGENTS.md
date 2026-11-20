# ABW Agent Guide

Internal engineering notes for coding agents working on ABW (a Tauri 2 + React/Vite Windows desktop client for Wrike). Keep end-user documentation in `README.md`.

## Architecture & Hot Paths

- **Frontend (`src/`)**: React 19 + TypeScript + Vite.
  - `src/App.tsx`: Tabbed Wrike workspace (`wrike_tabs`), split view, session persistence, and view switching between Wrike and Files.
  - `src/features/files/FilesLibrary.tsx`: Downloaded file list, search, pin/unpin, and keyboard navigation.
  - `src/features/preview/PdfPreview.tsx`: Lazy-loaded `pdfjs-dist` viewer. Small PDFs (`<= 512 KB`) load inline; larger PDFs stream on demand via `TauriPdfRangeTransport` (`read_download_head` + 64 KB `read_download_range` with in-flight request coalescing), idle next-page prefetch, Fit Width / Fit Page / manual zoom, and 90° rotation.
  - `src/features/preview/SpreadsheetPreview.tsx`: Renders native `WorkbookPreview` data with memoized `SheetRow`s, per-sheet scroll restoration, in-sheet search, cell selection (`Ctrl+C` copy), and zoom.
  - `src/features/preview/previewCache.ts` & `src/features/preview/previewUtils.ts`: In-memory LRU caches (16 MB PDF head cache, 24 MB / 6-entry spreadsheet cache) and pure scale/eviction/formatting helpers.
- **Native Backend (`src-tauri/src/`)**:
  - `lib.rs` & `wrike-injected.js`: Tauri app lifecycle, multi-tab child webviews, injected Wrike spell-check/dictionary/download-capture/shortcut/corner-curve script (`wrike-injected.js` included via `include_str!`), `AppState.tracked_paths` canonical path cache (`open_tracked_file` avoids re-parsing `files.json` & re-canonicalizing on every 64 KB PDF range read), and atomic persistence calls.
  - `spreadsheet.rs`: Native workbook preview engine. Streams OOXML (`.xlsx`/`.xlsm`) via `zip` + `quick-xml` with `<rPh>`/`<extLst>` skipping, theme/indexed color resolution, number/date formatting, and merges; includes a streaming RFC-4180 parser for `.csv`/`.tsv`; falls back to `calamine` for `.xls`/`.xlsb`/`.ods`. Enforces row/column/ZIP-ratio budgets.
  - `persistence.rs`, `close_policy.rs`, `startup.rs`, `updater.rs`: Atomic JSON persistence with `.bak` recovery, tray/quit close policy, Windows startup registry integration, and GitHub release updater.

## Non-Obvious Constraints & Invariants

1. **Preserve internal-tool download ergonomics**: Do not restrict automatic download opening or `Open in Windows` fallback unless explicitly requested by the user. Keep preview resource budgets (`MAX_PDF_PREVIEW_BYTES`, `MAX_SPREADSHEET_*`, ZIP compression ratio checks) intact, with `Open in Windows` available for oversized/unsupported files.
2. **Preserve `wrike-injected.js` test markers**: `scripts/desktop-regressions.test.mjs` slices helper functions directly out of `src-tauri/src/wrike-injected.js` using string markers (such as `const selectedWord = () => {`, `const nearestTextWord =`, `const abwSupportedFileName =`, and `abwLooksLikeDownloadUrl`). Keep those markers intact or update the regression test alongside any rename.
3. **Version synchronization**: `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` must share the exact same version (`npm run release:check`).
4. **CI path filtering**: `.github/workflows/windows-installer.yml` ignores `**/*.md` and `docs/**`, so updating `AGENTS.md` will not trigger Windows installer builds.

## Verification

Run these from the repo root:

```bash
npm run typecheck
npm run build
npm run release:check
npm run test:smoke
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
```

- **Windows / full Tauri environment**:
  ```bash
  cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings
  cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
  ```
- **Linux VM without `webkit2gtk-4.1`**: Full `lib.rs` Tauri linking is unavailable locally. Standalone Rust modules (`spreadsheet.rs`, `persistence.rs`, `close_policy.rs`) can be compiled, tested, and `clippy`-checked via a temporary offline crate in `/tmp` using `src-tauri/Cargo.lock` (clean up `/tmp` afterward).
