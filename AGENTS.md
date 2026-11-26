# ABW Agent Guide

Internal engineering notes for coding agents working on ABW (a Tauri 2 + React/Vite Windows desktop client for Wrike). Keep end-user documentation in `README.md`.

## Architecture & Hot Paths

- **Frontend (`src/`)**: React 19 + TypeScript + Vite.
  - `src/App.tsx`: Tabbed Wrike workspace (`wrike_tabs`), adjustable split view (`wrikeSplitRatio`), session restore with immediate visible-tab startup (no 2.8s splash stall) and lazy background webview creation (`initializedTabIdsRef`), inactive-tab suspension tracking (`tabLastActiveAtRef`, `pendingSuspendTabIdsRef`), compact half-screen Files pane switching (`compactFilesPane`), and view switching between Wrike and Files.
  - `src/features/files/FilesLibrary.tsx`: Downloaded file list, search, pin/unpin, column resizing, and focus-aligned arrow-key navigation (moves focus to the newly selected `.file-select` button outside text inputs).
  - `src/features/preview/PdfPreview.tsx`: Lazy-loaded `pdfjs-dist` viewer. Small PDFs (`<= 512 KB`) load inline; larger PDFs stream on demand via `TauriPdfRangeTransport` (`read_download_head` with 128 KB head + 128 KB tail EOF prefetch, plus 128 KB `read_download_range` with in-flight request coalescing), idle next-page prefetch, Fit Width / Fit Page / manual zoom, 90° rotation, and a 3-entry / 48 MiB byte-bounded `ImageBitmap` cache (`evictPdfBitmapCache`).
  - `src/features/preview/SpreadsheetPreview.tsx`: Renders native `WorkbookPreview` data with row virtualization, memoized `SheetRow`s, on-demand embedded image toggle (`load_spreadsheet_images`), per-sheet scroll restoration, in-sheet search, cell selection (`Ctrl+C` copy), and zoom.
  - `src/features/preview/previewCache.ts` & `src/features/preview/previewUtils.ts`: In-memory LRU caches (16 MB PDF head cache, 24 MB / 6-entry spreadsheet cache) and pure scale/eviction/formatting helpers.
- **Native Backend (`src-tauri/src/`)**:
  - `lib.rs` & `wrike-injected.js`: Tauri app lifecycle, multi-tab child webviews with confirmed async `ICoreWebView2_3::TrySuspend` (`mpsc` completion + reselection race guard), `Resume`, and `ICoreWebView2_19::SetMemoryUsageTargetLevel`, half-screen window minimum (`minWidth: 760` in `tauri.conf.json`, `lib.rs`, `shell.css`), `wrikeapp://` deep-link handling, injected Wrike spell-check (subtree-scoped `MutationObserver` + initial/toggle full pass), dictionary, synchronous `abwMarkPreviewIntent()` download capture, `window.__abwHidePreviewLoading` cleanup on hide/show/close, shortcut/theme/inbox-unread/corner-curve script (`wrike-injected.js` included via `include_str!`), `AppState.tracked_paths` canonical path cache (`open_tracked_file`), and atomic persistence calls.
  - `src-tauri/src/spreadsheet.rs`: Native workbook preview engine. Streams OOXML (`.xlsx`/`.xlsm`) via `zip` + `quick-xml` with `<rPh>`/`<extLst>` skipping, on-demand sheet loading (`load_sheet` / `load_spreadsheet_sheet` for multi-sheet OOXML workbooks after parsing only the active sheet initially), SpreadsheetML theme slot mapping (`0=lt1, 1=dk1, 2=lt2, 3=dk2`) & indexed color resolution, number/date formatting, merges, and on-demand drawing image extraction (`load_sheet_images`); includes a streaming RFC-4180 parser for `.csv`/`.tsv`; falls back to `calamine` for `.xls`/`.xlsb`/`.ods`. Enforces row/column/sheet/ZIP-ratio budgets.
  - `persistence.rs`, `close_policy.rs`, `startup.rs`, `updater.rs`, `po_bridge.rs`: Atomic JSON persistence with `.bak` recovery, tray/quit close policy, Windows startup registry integration, GitHub release updater, and Chrome native-messaging PO check bridge.

## Deferred Performance Opportunities

- **Virtualized `FilesLibrary` rows (`FilesLibrary.tsx`)**: Row list mounts all matching rows; virtualize by index while preserving `.file-select` keyboard focus if large download histories become slow.

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
