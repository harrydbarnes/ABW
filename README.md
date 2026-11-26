# ABW

ABW (A Better Wrike client) is a lightweight Windows desktop client built designed to perform better and improve on key functionality for Wrike users.

## Why ABW

- Lightweight Tauri 2 desktop host (~3 MB NSIS installer, ~7.7 MB executable, ~10–12 MB private host process) using Windows' built-in WebView2 runtime rather than bundling a separate Electron/Chromium distribution.
- Lazy background tab creation on session restore plus automatic WebView2 `TrySuspend` for inactive tabs to keep multi-tab memory low.
- Native Rust workbook parsing and streaming PDF preview with byte-bounded caching, so attachments open quickly without stalling the Wrike workspace.

## Product Direction

A live Wrike surface below ABW's tab bar renders the real, current Wrike web application, while
the trusted local surfaces own functionality where the official desktop experience is weakest:

- Multi-tab Wrike workspace with split view, session restore, `Ctrl+T`/`Ctrl+W`/`Ctrl+Tab`/`Ctrl+1–9` shortcuts, `wrikeapp://` deep links, favourites, and visit history.
- Immediate visible-tab startup with lazy background tab initialization and automatic inactive-tab suspension.
- A persistent `Files` library for downloads made in the Wrike workspace, with search, pinning, keyboard navigation, and half-screen compact layout support (`>= 760 px` window width).
- Captured download date/time and the current Wrike task link for every downloaded file.
- Fast in-app preview or `Open in Windows` for each file (PDFs, spreadsheets, and images, with a setting to keep Wrike's native viewer for images).
- PDF rendering via `pdfjs-dist` loaded only when needed, range streaming for larger PDFs, zoom/fit/rotation controls, and a 48 MiB byte-bounded page bitmap cache.
- Native Rust spreadsheet preview (`zip` + `quick-xml` streaming OOXML for `.xlsx`/`.xlsm`, streaming RFC-4180 `.csv`/`.tsv`, and `calamine` fallback for `.xls`/`.xlsb`/`.ods`) with worksheets, theme/indexed styling, merges, on-demand embedded images, in-sheet find, cell copy (`Ctrl+C`), and zoom.
- A spell-check preference and custom dictionary applied to ABW controls and Wrike text fields without full-DOM observer scans during typing.
- Native download-complete notifications, taskbar unread/update badge, close-to-notification-area support, and signed GitHub Releases in-app updates.

Downloaded files are stored per-user below ABW's application data directory; they never require
administrator permissions or a shared machine-wide location.

## Current Status

| Desktop capability | Status |
| --- | --- |
| Multi-tab WebView2 Wrike workspace & split view | Implemented and shipped (`v0.1.60`) |
| Sign-in, SSO/MFA, `wrikeapp://` deep links & session restore | Implemented with lazy background tab creation |
| Inactive-tab suspension & low-memory targeting | Implemented using confirmed WebView2 `TrySuspend` / `Resume` |
| Download capture, `Files` library & source-task reopening | Implemented with compact half-screen (`>= 760 px`) layout |
| PDF, spreadsheet & image previews; `Open in Windows` | Implemented with byte/row/column budgets and fallback |
| Spell-check toggle & custom Windows dictionary | Implemented with subtree-scoped mutation observer |
| Taskbar unread inbox badge & in-app signed updates | Implemented via `abw-inbox://` detection and Tauri updater |
| Automatic PO checks via Chrome Ops Toolshed bridge | Implemented via `--register-po-host` native messaging |
| Background push while ABW is fully closed | Outside scope (use close-to-tray to keep alerts active) |

### Notification Constraint

Wrike documents browser notifications for comments, mentions and assignment events while its
workspace remains open. Microsoft documents that WebView2 displays unhandled, non-persistent web
notifications through its default UI; WebView2 push notifications are unavailable. ABW therefore
relies on the live Wrike surface for Wrike activity alerts, and supplies its own native Windows
notification when it captures a completed download. Notifications while ABW is fully closed are
outside this MVP.

## Architecture

- `src/`: React/Vite tab bar plus local Files and Settings surfaces. PDF.js and preview components
  are deferred chunks so the local tools remain quick to load.
- `src-tauri/src/lib.rs`: trusted native boundary. It creates the remote Wrike child webview below
  the tab bar, handles safe HTTPS authentication pop-ups, downloads and download notifications; it
  validates tracked paths, opens files with Windows, parses workbooks, and persists settings/history.
- `src-tauri/tauri.conf.json`: NSIS packaging in `currentUser` mode. Tauri documents this mode as
  installing under `%LOCALAPPDATA%` without administrator privileges.

The remote Wrike child webview is not granted ABW IPC capabilities. The trusted local `main`
webview is the only surface authorized for local app commands.

## Tech Stack

- Built with Tauri 2 instead of Electron for a dramatically smaller desktop footprint.
- Uses Windows WebView2 rather than bundling a private Chromium build.
- Renders the live Wrike web application in the evergreen Chromium-based runtime maintained on
  Windows.
- Uses a Rust backend for native downloads, notifications, workbook parsing, settings, and window
  control.
- Uses React and Vite for the local ABW interface.
- Keeps PDF.js and preview components as deferred frontend chunks so local tools remain quick to
  load.

## Development

Prerequisites for the full desktop build on Windows:

- Node.js 24 or newer.
- Rust stable with Cargo.
- Visual Studio Build Tools with the Microsoft C++ toolset and a Windows SDK.
- WebView2 Runtime (included on current Windows installations).

```powershell
npm.cmd install
npm.cmd run tauri -- dev
```

Frontend-only development and preview does not require Rust or Visual Studio:

```powershell
npm.cmd install
npm.cmd run dev
```

The browser-only screen uses representative download data so the Files and preview interactions can
be reviewed without signing in to Wrike or downloading files.

Full account workflow QA requires the native Windows build and a test Wrike account. The acceptance
pass is:

1. Launch ABW and confirm the Wrike login/workspace renders below its selected `Wrike` tab.
2. Sign in, including an organisation SSO or MFA pop-up path where available.
3. Use `Settings > Send test notification`, then leave download notifications enabled.
4. Download a PDF and an Excel workbook from a Wrike task.
5. Confirm each download notification, Files entry, timestamp, source-task link, in-app preview,
   and `Open in Windows` action.
6. Enable Wrike's own workspace notifications and confirm a comment, mention, or assignment alert
   while the Wrike tab remains open.

## Build

```powershell
npm.cmd run build
npm.cmd run tauri -- build
```

The Tauri build creates an NSIS installer configured for current-user installation, satisfying the
no-admin installation requirement. A GitHub Actions workflow is included to package the installer
on a Windows runner when local Rust/MSVC build tools are unavailable.

## Security Notes

- Task reopening accepts only HTTPS links on `wrike.com` or its subdomains.
- Workspace navigation and sign-in pop-ups permit HTTPS destinations (plus the blank pop-up
  bootstrap page needed by authentication flows); the remote webview has no local ABW command
  permissions.
- Preview/open commands resolve only files present in ABW's tracked download directory.
- PDF preview is capped at 128 MB, image preview at 32 MB, and spreadsheet preview at 64 MB
  (with a 500-row, 50-column, 128-sheet budget and ZIP compression-ratio checks) with a displayed
  explanation and `Open in Windows` fallback when exceeded.
- Workbooks are parsed in the trusted Rust process (streaming OOXML via `zip`/`quick-xml`,
  streaming CSV/TSV, and `calamine 0.38` for legacy formats) rather than executing a large
  JavaScript parser in the UI or Wrike webview.
- In-app updates download `latest.json` and the NSIS installer from HTTPS GitHub Releases and verify
  a cryptographic Tauri minisign signature against the embedded public key in `src-tauri/tauri.conf.json`
  before launching passive upgrades.

## Releases And Recovery

`npm run release:prepare -- patch` increments the app version and synchronizes
the npm package, npm lockfile, Tauri configuration and Cargo package/lockfile.
Use `minor` or `major` for larger releases. `npm run release:check` validates
versions, including the Git tag in CI. Settings displays the version automatically;
no manual UI version update is needed.

Commit the prepared version, then push its matching `vX.Y.Z` tag to publish.
Tag builds require the `TAURI_SIGNING_PRIVATE_KEY` repository secret and must pass
audits, native tests, and installer lifecycle tests before publication. Each
published release attaches the tested NSIS installer, `.sha256` checksum, `.sig`
updater signature, and generated `latest.json` manifest so installed copies can
update in-app (both automatically via a quiet launch check and on demand in
`Settings > App updates`). Main builds retain artifacts for 90 days and do not
publish releases or raise PRs. No local administrator tools or Windows code-signing
certificate are required.

Before replacing existing valid settings/download metadata, ABW atomically
saves a `.json.bak` last-known-good copy. A damaged primary file can be read
from that backup; a persistent warning identifies the affected file. The next
save archives the damaged original as `.corrupt-<id>.json`. If neither copy is
valid, ABW does not reset or overwrite it: restore a known-good file and restart.
Save failures remain visible until dismissed. These backups cover metadata, not
the downloaded documents themselves.

Windows CI runs installed-app checks for native close-to-tray, native window
quit, and second-instance reactivation without signing in to Wrike. Rust tests
cover tray Quit, multiple-tab confirmation/cancellation, and startup registry
updates in an isolated per-user test key. They do not replace a manual test of
the actual confirmation dialog with authenticated Wrike tabs. All installer
smoke scripts refuse to run outside disposable CI.

## Dependency Checks

Run `npm ci` followed by `npm run test:smoke` to check PDF worker loading,
rendering, teardown, and ExcelJS workbook round trips. The smoke suite uses
PDF.js's Node compatibility build; it does not replace testing previews in the
installed Windows app. CI runs these checks before building an installer.

Run `cargo audit --file src-tauri/Cargo.lock` with cargo-audit installed to check
Rust dependencies against the current RustSec database. CI installs a pinned
audit tool and fails on known vulnerabilities; informational warnings remain
visible without being suppressed.

`npm run dependencies:report` reports npm versions, compatible Cargo updates,
and newer stable GitHub Action releases without changing dependency files.
The weekly dependency-health workflow runs on Mondays at 08:23 UTC and also
audits npm and Rust dependencies. Results appear in the Actions job summary and
logs; it creates no PRs, issues, installers, or uploaded artifacts.

Dependabot's weekly schedules and compatible-update groups are configured with
`open-pull-requests-limit: 0`, which disables version-update PRs. Those groups
are dormant unless PRs are deliberately enabled later. Dependabot security
updates must also remain disabled in the repository's code-security settings;
the PR limit does not apply to security updates. Keep Dependabot alerts enabled
for visibility. The weekly workflow is the active report-only alternative.

### Automatic PO checks

ABW can check a complete booking while you view its Wrike task. Install the matching Ops Toolshed extension in Chrome and leave Chrome running with a signed-in Prisma Campaigns tab. Complete Okta in Chrome if ABW shows **Sign in to Prisma**. Select the PO status to open the full Check PO result.

Pair ABW with your installed extension once. In Chrome, open **Extensions**, enable **Developer mode**, and copy the ID displayed for **Ops Toolshed**. Run the following in PowerShell with that ID. The registration applies to your Windows user and allows only that extension ID.

```powershell
& "$env:LOCALAPPDATA\ABW\abw.exe" --register-po-host '<Ops Toolshed extension ID>'
```

If ABW was installed in a different folder, use the full path to its installed executable. The ordinary **Check PO** button remains available when the background connection is unavailable.
