# ABW

ABW (A Better Wrike client) is a lightweight Windows desktop client built around the live Wrike
workspace and a deliberately better document workflow.

## Why ABW

- Up to 375x lower observed RAM usage than Wrike Desktop in this test: 4 MB vs 1.5 GB.
- Up to 68x smaller installed size: 10 MB vs 684 MB.

## Product Direction

A live Wrike surface below ABW's tab bar renders the real, current Wrike web application, while
the trusted local surfaces own functionality where the official desktop experience is weakest:

- A persistent `Files` library for downloads made in the Wrike workspace.
- Captured download date/time and the current Wrike task link for every downloaded file.
- Fast in-app preview or `Open in Windows` for each file.
- PDF rendering with page and zoom controls, loaded only when a PDF is opened.
- Spreadsheet previews with worksheets, grid navigation, and zoom; workbook parsing happens in
  native Rust with `calamine`, not inside the remote webview.
- A spell-check preference applied to ABW controls and text editing fields in the Wrike webview.
- Native download-complete notifications, with a Settings test action and an opt-out toggle.

Downloaded files are stored per-user below ABW's application data directory; they never require
administrator permissions or a shared machine-wide location.

## Current Status

ABW now contains the minimum viable product workflow in code: a first-run Wrike workspace/login
surface below the ABW tab bar, taskbar-hidden HTTPS sign-in surfaces for SSO/MFA that fold back
into the workspace after a completed Wrike redirect, compact Files/Settings controls, and native
download-complete notifications. It still needs a built Windows smoke test with a real Wrike
account before it should be distributed as a validated desktop replacement.

| Desktop capability | Current status |
| --- | --- |
| Embedded WebView2 Wrike workspace tab | Implemented in code; login/account QA not run |
| Sign-in, SSO/MFA and session persistence | Taskbar-hidden HTTPS pop-up flow implemented; completed workspace redirects close into the embedded tab; live-account QA pending |
| Download tracking and enhanced local file library | Implemented in code; UI verified using representative data |
| PDF and spreadsheet preview; open in Windows | Implemented in code; UI verified using representative data |
| Spell-check toggle | Implemented in code; Wrike editor behaviour not validated against a live account |
| Open-Wrike-at-launch preference | Selects the live Wrike tab at startup by default; desktop build QA pending |
| Native ABW download-complete notifications | Implemented with opt-out and Settings test button; installed-app QA pending |
| Wrike comment/mention/assignment web notifications | WebView2 default notification UI is available while the Wrike tab remains open; account QA pending |
| Multiple native Wrike tabs/tab restoration | Tab-strip space reserved; additional tabs not implemented |
| Background push while ABW is closed; taskbar unread badge | Not implemented |

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
- PDF preview is capped at 512 MB with a displayed size explanation when exceeded; spreadsheet
  output is capped to 250 rows and 50 columns per sheet in the current viewer to keep the UI
  responsive.
- Workbooks are parsed in the trusted Rust process using `calamine 0.35`, rather than executing a
  large JavaScript parser in the UI or Wrike webview.
