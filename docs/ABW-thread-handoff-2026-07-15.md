# ABW thread handoff - 2026-07-15

This note preserves the current ABW maintenance/security context before the local download/workspace location changes.

## Current repo

- Project: ABW, a Tauri 2 + React/Vite Windows desktop client for Wrike.
- Current path before move: `C:\Users\harry.barnes\OneDrive - insidemedia.net\Documents\GitHub\ABW`
- Branch seen in prior rollout memory: `main`.
- Working tree state immediately before creating this handoff: clean according to `git status --short`.

Prefer repo-relative paths below after the folder is moved.

## Recent completed work to preserve

The prior ABW task covered two areas:

1. Quick dependency / repo-health updates.
2. Codex Security review plus preview-resource hardening.

The durable memory entry for that work is:

- `C:\Users\harry.barnes\.codex\memories\rollout_summaries\2026-07-02T09-25-54-VXLt-abw_dependency_update_and_security_preview_hardening.md`

The memory registry also has an `ABW / dependency maintenance and preview security hardening` task group. Search memory for:

- `ABW`
- `previewCache.ts`
- `PdfPreview.tsx`
- `Open in Windows`
- `Codex Security`

## User preference that matters

Do not restrict automatic download opening for this internal tool unless the user explicitly changes their mind.

The user specifically said:

> For restrict automatic download opening, this doesn't matter as it is an internal tool. Work on the other features without limiting a users use of the app.

So future security or hardening work should preserve normal app use and keep `Open in Windows` available as the fallback for files that are too large or complex for in-app preview.

## Security scan outcome to preserve

The prior Codex Security scan found four reportable items:

- Medium/P2: automatic opening passes untrusted downloads to Windows handlers.
  - Do not fix this by default because the user accepted it for the internal-tool workflow.
- Low/P3: native Calamine workbook parsing lacked resource budgets.
- Low/P3: ExcelJS OOXML decompression lacked resource budgets.
- Low/P3: PDF.js/canvas preview resource exhaustion.

Remediation focused on the three preview/resource issues, not the automatic-open behavior.

## Important source paths

- `src-tauri/src/lib.rs`
  - Native download/read/open boundary.
  - Native spreadsheet preview and archive/resource preflight.
- `src/features/preview/previewCache.ts`
  - Frontend preview byte limits and ExcelJS ZIP preflight.
- `src/features/preview/PdfPreview.tsx`
  - PDF loading/render cleanup and canvas/pixel caps.
- `src/features/preview/PreviewPanel.tsx`
  - User-facing in-app preview size messaging.
- `package.json`
  - Current app dependency versions.
- `.github/workflows/`
  - GitHub Actions config if future CI/update work resumes.

## Verification known from the prior run

The prior run successfully verified:

- `npm.cmd run build`
- `npm.cmd audit --json` with zero vulnerabilities.
- `git diff --check`

Local Rust verification was not completed because `rustc` and `cargo` were not installed on this machine at the time.

If this is resumed after the move, rerun at least:

```powershell
git status --short
npm.cmd run build
npm.cmd audit --json
```

If Rust tooling is available in the new location, also run:

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

## Notes for a fresh session

- Treat any absolute paths in old scan artifacts as stale after the folder move.
- Re-check current dependency versions before making any new update claims.
- Re-check current scan artifacts before relying on old temp paths; temp scan directories may no longer exist.
- Preserve the user's workflow preference: preview safety limits are fine, but do not block ordinary download opening or external Windows opening unless explicitly asked.
