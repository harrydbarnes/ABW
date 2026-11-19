use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};
use tauri::{
    ipc::Response,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{
        DownloadEvent, NewWindowResponse, PageLoadEvent, Webview, WebviewBuilder,
        WebviewWindowBuilder,
    },
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_notification::NotificationExt;
use url::Url;
use uuid::Uuid;

mod close_policy;
mod persistence;
mod spreadsheet;
mod startup;
mod updater;

#[tauri::command]
async fn storage_health(app: AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok([
            persistence::health::<Settings>(&settings_path(&app)?),
            persistence::health::<Vec<DownloadRecord>>(&records_path(&app)?),
            persistence::health::<Option<WrikeSession>>(&session_path(&app)?),
        ]
        .into_iter()
        .flatten()
        .collect())
    })
    .await
    .map_err(|error| format!("Storage health task failed: {error}"))?
}

const WRIKE_HOME: &str = "https://www.wrike.com/workspace.htm";
const MAX_PDF_PREVIEW_BYTES: u64 = 128 * 1024 * 1024;
const PDF_HEAD_CHUNK_BYTES: u64 = 65_536;
const PDF_INLINE_THRESHOLD_BYTES: u64 = 512 * 1024;
const MAX_PDF_RANGE_BYTES: u64 = 8 * 1024 * 1024;
const TASKBAR_HEIGHT: f64 = 50.0;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadRecord {
    id: String,
    file_name: String,
    extension: String,
    kind: String,
    downloaded_at: String,
    size_bytes: u64,
    source_url: Option<String>,
    source_label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    spell_check: bool,
    launch_wrike_on_start: bool,
    download_notifications: bool,
    open_abw_at_system_startup: bool,
    close_to_notification_area: bool,
    confirm_before_closing_tabs: bool,
    open_downloaded_files_automatically: bool,
    #[serde(default = "default_true")]
    auto_check_for_updates: bool,
    #[serde(default)]
    suspend_inactive_tabs_minutes: u32,
    #[serde(default = "default_theme")]
    theme: String,
    custom_dictionary: Vec<String>,
    #[serde(default = "default_startup_tab_urls")]
    startup_tab_urls: Vec<String>,
    #[serde(default)]
    pinned_download_ids: Vec<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LegacySettingsSession {
    last_wrike_session: Option<WrikeSession>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WrikeSessionTab {
    id: String,
    title: String,
    url: Option<String>,
    mode: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WrikeSessionSplit {
    left_tab_id: String,
    right_tab_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WrikeSession {
    tabs: Vec<WrikeSessionTab>,
    active_tab_id: String,
    split: Option<WrikeSessionSplit>,
    saved_at: String,
}

fn default_true() -> bool {
    true
}

fn default_theme() -> String {
    "default".to_owned()
}

fn default_startup_tab_urls() -> Vec<String> {
    vec![WRIKE_HOME.to_owned()]
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            spell_check: true,
            launch_wrike_on_start: true,
            download_notifications: true,
            open_abw_at_system_startup: false,
            close_to_notification_area: true,
            confirm_before_closing_tabs: false,
            open_downloaded_files_automatically: false,
            auto_check_for_updates: true,
            suspend_inactive_tabs_minutes: 0,
            theme: "default".to_owned(),
            custom_dictionary: Vec::new(),
            startup_tab_urls: default_startup_tab_urls(),
            pinned_download_ids: Vec::new(),
        }
    }
}

#[derive(Clone)]
struct PendingDownload {
    source_url: Option<String>,
    source_label: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WrikeTabUpdate {
    tab_id: String,
    title: String,
    url: Option<String>,
    can_go_back: bool,
    can_go_forward: bool,
    is_title_loading: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WrikeShortcutEvent {
    action: String,
    index: Option<usize>,
    url: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WrikeTabLayout {
    tab_id: String,
    pane: WrikePane,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum WrikePane {
    Full,
    Left,
    Right,
}

#[derive(Default)]
struct AppState {
    wrike_tabs: Mutex<HashMap<String, Arc<CaptureContext>>>,
    tracked_paths: Mutex<HashMap<String, PathBuf>>,
    quit_prompt_open: AtomicBool,
}

#[derive(Default)]
struct CaptureContext {
    tab_id: String,
    pending: Mutex<HashMap<PathBuf, PendingDownload>>,
    page_title: Mutex<String>,
    page_url: Mutex<Option<String>>,
    history: Mutex<NavigationHistory>,
    is_title_loading: Mutex<bool>,
}

impl CaptureContext {
    fn new(tab_id: &str, url: &str) -> Self {
        Self {
            tab_id: tab_id.to_owned(),
            pending: Mutex::new(HashMap::new()),
            page_title: Mutex::new(String::new()),
            page_url: Mutex::new(Some(url.to_owned())),
            history: Mutex::new(NavigationHistory::new(url)),
            is_title_loading: Mutex::new(true),
        }
    }
}

#[derive(Default)]
struct NavigationHistory {
    entries: Vec<String>,
    position: usize,
}

impl NavigationHistory {
    fn new(url: &str) -> Self {
        Self {
            entries: vec![url.to_owned()],
            position: 0,
        }
    }

    fn record(&mut self, url: &str) {
        if let Some(index) = self.entries.iter().rposition(|entry| entry == url) {
            self.position = index;
            return;
        }
        if !self.entries.is_empty() && self.position + 1 < self.entries.len() {
            self.entries.truncate(self.position + 1);
        }
        self.entries.push(url.to_owned());
        self.position = self.entries.len().saturating_sub(1);
    }

    fn can_go_back(&self) -> bool {
        self.position > 0
    }

    fn can_go_forward(&self) -> bool {
        !self.entries.is_empty() && self.position + 1 < self.entries.len()
    }
}

#[tauri::command]
async fn list_downloads(app: AppHandle) -> Result<Vec<DownloadRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || read_records(&app))
        .await
        .map_err(|error| format!("Unable to load downloads: {error}"))?
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadsStorageStats {
    total_files: usize,
    pinned_files: usize,
    total_bytes: u64,
    unpinned_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClearDownloadsResult {
    removed_count: usize,
    freed_bytes: u64,
}

fn open_tracked_file(app: &AppHandle, id: &str) -> Result<(PathBuf, fs::File), String> {
    let path = resolve_tracked_path(app, id)?;
    match fs::File::open(&path) {
        Ok(file) => Ok((path, file)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            invalidate_tracked_paths(app, Some(id));
            let refreshed = resolve_tracked_path(app, id)?;
            let file = fs::File::open(&refreshed)
                .map_err(|open_err| format!("Unable to open download: {open_err}"))?;
            Ok((refreshed, file))
        }
        Err(error) => Err(format!("Unable to open download: {error}")),
    }
}

#[tauri::command]
async fn read_download(app: AppHandle, id: String) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, mut file) = open_tracked_file(&app, &id)?;
        let size = file
            .metadata()
            .map_err(|error| format!("Unable to inspect download: {error}"))?
            .len();
        if size > MAX_PDF_PREVIEW_BYTES {
            return Err(format!(
                "This PDF is {} MB. In-app PDF preview currently supports files up to 128 MB; open it in Windows instead.",
                size.div_ceil(1024 * 1024)
            ));
        }
        let mut bytes = Vec::with_capacity(size as usize);
        file.read_to_end(&mut bytes)
            .map_err(|error| format!("Unable to read download: {error}"))?;
        Ok(Response::new(bytes))
    })
    .await
    .map_err(|error| format!("Unable to read download: {error}"))?
}

#[tauri::command]
async fn read_download_head(app: AppHandle, id: String) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, mut file) = open_tracked_file(&app, &id)?;
        let size = file
            .metadata()
            .map_err(|error| format!("Unable to inspect download: {error}"))?
            .len();
        if size > MAX_PDF_PREVIEW_BYTES {
            return Err(format!(
                "This PDF is {} MB. In-app PDF preview currently supports files up to 128 MB; open it in Windows instead.",
                size.div_ceil(1024 * 1024)
            ));
        }
        let head_len = if size <= PDF_INLINE_THRESHOLD_BYTES {
            size
        } else {
            size.min(PDF_HEAD_CHUNK_BYTES)
        } as usize;
        let mut out = Vec::with_capacity(8 + head_len);
        out.extend_from_slice(&size.to_le_bytes());
        out.resize(8 + head_len, 0);
        file.read_exact(&mut out[8..])
            .map_err(|error| format!("Unable to read PDF header: {error}"))?;
        Ok(Response::new(out))
    })
    .await
    .map_err(|error| format!("Unable to read download header: {error}"))?
}

#[tauri::command]
async fn read_download_range(
    app: AppHandle,
    id: String,
    start: u64,
    end: u64,
) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, mut file) = open_tracked_file(&app, &id)?;
        let size = file
            .metadata()
            .map_err(|error| format!("Unable to inspect download: {error}"))?
            .len();
        if size > MAX_PDF_PREVIEW_BYTES {
            return Err(format!(
                "This PDF is {} MB. In-app PDF preview currently supports files up to 128 MB; open it in Windows instead.",
                size.div_ceil(1024 * 1024)
            ));
        }
        let clamped_start = start.min(size);
        let clamped_end = end.min(size);
        if clamped_end <= clamped_start {
            return Ok(Response::new(Vec::new()));
        }
        let len = clamped_end - clamped_start;
        if len > MAX_PDF_RANGE_BYTES {
            return Err("Requested PDF range exceeds the single-chunk transfer limit.".into());
        }
        file.seek(SeekFrom::Start(clamped_start))
            .map_err(|error| format!("Unable to seek download: {error}"))?;
        let mut buf = vec![0_u8; len as usize];
        file.read_exact(&mut buf)
            .map_err(|error| format!("Unable to read PDF range: {error}"))?;
        Ok(Response::new(buf))
    })
    .await
    .map_err(|error| format!("Unable to read PDF byte range: {error}"))?
}

#[tauri::command]
async fn downloads_storage_stats(app: AppHandle) -> Result<DownloadsStorageStats, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let records = read_records(&app)?;
        let stored_settings = settings_path(&app)
            .and_then(|path| persistence::read::<Settings>(&path))
            .unwrap_or_default();
        let pinned: HashSet<&str> = stored_settings
            .pinned_download_ids
            .iter()
            .map(String::as_str)
            .collect();
        let root = downloads_dir(&app)
            .ok()
            .and_then(|dir| dir.canonicalize().ok());
        let mut total_files = 0_usize;
        let mut pinned_files = 0_usize;
        let mut total_bytes = 0_u64;
        let mut unpinned_bytes = 0_u64;
        for record in &records {
            let disk_size = root.as_ref().and_then(|root_dir| {
                let resolved = root_dir.join(&record.file_name).canonicalize().ok()?;
                if !resolved.starts_with(root_dir) {
                    return None;
                }
                fs::metadata(resolved).ok().map(|meta| meta.len())
            });
            let Some(size) = disk_size else {
                continue;
            };
            total_files += 1;
            total_bytes = total_bytes.saturating_add(size);
            if pinned.contains(record.id.as_str()) {
                pinned_files += 1;
            } else {
                unpinned_bytes = unpinned_bytes.saturating_add(size);
            }
        }
        Ok(DownloadsStorageStats {
            total_files,
            pinned_files,
            total_bytes,
            unpinned_bytes,
        })
    })
    .await
    .map_err(|error| format!("Unable to inspect download storage: {error}"))?
}

#[tauri::command]
async fn clear_unpinned_downloads(app: AppHandle) -> Result<ClearDownloadsResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stored_settings = settings_path(&app)
            .and_then(|path| persistence::read::<Settings>(&path))
            .unwrap_or_default();
        let pinned: HashSet<String> = stored_settings.pinned_download_ids.into_iter().collect();
        let root = downloads_dir(&app)?
            .canonicalize()
            .map_err(|error| format!("Unable to validate downloads directory: {error}"))?;

        let (kept_records, removed_entries) =
            persistence::update::<Vec<DownloadRecord>, _>(&records_path(&app)?, |records| {
                let all_records = std::mem::take(records);
                let mut removed = Vec::new();
                for record in all_records {
                    let disk_path = root
                        .join(&record.file_name)
                        .canonicalize()
                        .ok()
                        .filter(|resolved| resolved.starts_with(&root));
                    if pinned.contains(&record.id) && disk_path.is_some() {
                        records.push(record);
                    } else {
                        removed.push((record.id, disk_path, record.size_bytes));
                    }
                }
                Ok(removed)
            })?;

        let mut freed_bytes = 0_u64;
        let mut removed_ids = Vec::with_capacity(removed_entries.len());
        for (id, disk_path, fallback_size) in removed_entries {
            invalidate_tracked_paths(&app, Some(&id));
            if let Some(resolved) = disk_path {
                let actual_size = fs::metadata(&resolved)
                    .map(|meta| meta.len())
                    .unwrap_or(fallback_size);
                match fs::remove_file(&resolved) {
                    Ok(()) => freed_bytes = freed_bytes.saturating_add(actual_size),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(format!("Unable to remove downloaded file: {error}"));
                    }
                }
            }
            removed_ids.push(id);
        }

        let kept_ids: HashSet<&str> = kept_records.iter().map(|r| r.id.as_str()).collect();
        let (updated_settings, settings_changed) =
            persistence::update::<Settings, _>(&settings_path(&app)?, |stored| {
                let before = stored.pinned_download_ids.len();
                stored
                    .pinned_download_ids
                    .retain(|pinned_id| kept_ids.contains(pinned_id.as_str()));
                stored.open_abw_at_system_startup = startup::enabled()?;
                Ok(stored.pinned_download_ids.len() != before)
            })?;
        if settings_changed {
            let _ = app.emit("settings-updated", updated_settings);
        }
        let removed_count = removed_ids.len();
        app.emit("downloads-updated", ())
            .map_err(|error| format!("Unable to refresh Files view: {error}"))?;
        for removed_id in removed_ids {
            let _ = app.emit("download-deleted", removed_id);
        }
        Ok(ClearDownloadsResult {
            removed_count,
            freed_bytes,
        })
    })
    .await
    .map_err(|error| format!("Unable to clear downloads: {error}"))?
}

#[tauri::command]
async fn preview_spreadsheet(
    app: AppHandle,
    id: String,
) -> Result<spreadsheet::WorkbookPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_tracked_path(&app, &id)?;
        match spreadsheet::preview_file(&path) {
            Err(_) if !path.exists() => {
                invalidate_tracked_paths(&app, Some(&id));
                let refreshed = resolve_tracked_path(&app, &id)?;
                spreadsheet::preview_file(&refreshed)
            }
            result => result,
        }
    })
    .await
    .map_err(|error| format!("Unable to preview spreadsheet: {error}"))?
}

#[tauri::command]
fn open_download(app: AppHandle, id: String) -> Result<(), String> {
    let path = resolve_tracked_path(&app, &id)?;
    open::that(path).map_err(|error| format!("Unable to open file in Windows: {error}"))
}

#[tauri::command]
async fn reveal_download(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_tracked_path(&app, &id)?;
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let raw = path.to_string_lossy();
            let display_path = raw.strip_prefix(r"\\?\").unwrap_or(raw.as_ref());
            std::process::Command::new("explorer.exe")
                .raw_arg(format!("/select,\"{display_path}\""))
                .spawn()
                .map_err(|error| format!("Unable to reveal file in Explorer: {error}"))?;
            Ok(())
        }
        #[cfg(not(target_os = "windows"))]
        {
            let parent = path.parent().unwrap_or(&path);
            open::that(parent).map_err(|error| format!("Unable to open folder: {error}"))
        }
    })
    .await
    .map_err(|error| format!("Unable to reveal file: {error}"))?
}

#[tauri::command]
async fn delete_download(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        invalidate_tracked_paths(&app, Some(&id));
        let removed =
            persistence::update::<Vec<DownloadRecord>, _>(&records_path(&app)?, |records| {
                let Some(index) = records.iter().position(|record| record.id == id) else {
                    return Ok(None);
                };
                Ok(Some(records.remove(index)))
            })?
            .1
            .ok_or_else(|| "This download is no longer in the Files library.".to_owned())?;

        if let Ok(root) = downloads_dir(&app)?.canonicalize() {
            if let Some(resolved) = root
                .join(&removed.file_name)
                .canonicalize()
                .ok()
                .filter(|resolved| resolved.starts_with(&root))
            {
                match fs::remove_file(&resolved) {
                    Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                        return Err(format!("Unable to remove downloaded file: {error}"));
                    }
                    _ => {}
                }
            }
        }

        let (settings, had_pin) =
            persistence::update::<Settings, _>(&settings_path(&app)?, |stored| {
                let before = stored.pinned_download_ids.len();
                stored
                    .pinned_download_ids
                    .retain(|pinned_id| pinned_id != &id);
                stored.open_abw_at_system_startup = startup::enabled()?;
                Ok(stored.pinned_download_ids.len() != before)
            })?;
        if had_pin {
            let _ = app.emit("settings-updated", settings);
        }
        app.emit("downloads-updated", ())
            .map_err(|error| format!("Unable to refresh Files view: {error}"))?;
        app.emit("download-deleted", id)
            .map_err(|error| format!("Unable to update deleted download state: {error}"))
    })
    .await
    .map_err(|error| format!("Unable to remove download: {error}"))?
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Result<Settings, String> {
    read_settings(&app)
}

#[tauri::command]
fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    mut settings: Settings,
) -> Result<Settings, String> {
    settings.custom_dictionary = normalize_dictionary(settings.custom_dictionary);
    settings.startup_tab_urls = normalize_startup_tab_urls(settings.startup_tab_urls);
    settings.pinned_download_ids = normalize_string_ids(settings.pinned_download_ids);
    if settings.theme.trim().is_empty() {
        settings.theme = default_theme();
    }
    let (settings, previous) =
        persistence::update::<Settings, _>(&settings_path(&app)?, |stored| {
            let previous = stored.clone();
            if settings.open_abw_at_system_startup != startup::enabled()? {
                startup::set_enabled(settings.open_abw_at_system_startup)?;
            }
            *stored = settings;
            Ok(previous)
        })?;
    if previous.custom_dictionary != settings.custom_dictionary {
        sync_windows_spelling_dictionary(&previous.custom_dictionary, &settings.custom_dictionary);
    }
    if previous.spell_check != settings.spell_check {
        let script = apply_spell_check_script(settings.spell_check, false);
        let tab_ids = state
            .wrike_tabs
            .lock()
            .map(|tabs| tabs.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_else(|_| vec!["home".to_owned()]);
        for tab_id in tab_ids {
            if let Some(webview) = app.get_webview(&wrike_tab_label(&tab_id)?) {
                webview
                    .eval(&script)
                    .map_err(|error| format!("Unable to apply spell-check preference: {error}"))?;
            }
        }
    }
    app.emit("settings-updated", settings.clone())
        .map_err(|error| format!("Unable to refresh settings: {error}"))?;
    Ok(settings)
}

#[tauri::command]
async fn get_wrike_session(app: AppHandle) -> Result<Option<WrikeSession>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session_file = session_path(&app)?;
        if session_file.exists() {
            return persistence::read::<Option<WrikeSession>>(&session_file);
        }
        let legacy: LegacySettingsSession = persistence::read(&settings_path(&app)?)?;
        Ok(legacy.last_wrike_session)
    })
    .await
    .map_err(|error| format!("Unable to read saved tab session: {error}"))?
}

#[tauri::command]
async fn update_last_wrike_session(app: AppHandle, session: WrikeSession) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        persistence::update::<Option<WrikeSession>, _>(&session_path(&app)?, |stored| {
            *stored = Some(normalize_wrike_session(session));
            Ok(())
        })
        .map(|_| ())
    })
    .await
    .map_err(|error| format!("Unable to save tab session: {error}"))?
}

#[tauri::command]
fn send_test_notification(app: AppHandle) -> Result<(), String> {
    app.notification()
        .builder()
        .title("ABW notifications are working")
        .body("Files downloaded from Wrike will appear in your ABW Files library.")
        .show()
        .map_err(|error| format!("Unable to display a Windows notification: {error}"))
}

#[tauri::command]
async fn launch_wrike(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    url: Option<String>,
    pane: Option<WrikePane>,
) -> Result<(), String> {
    open_wrike_at(
        &app,
        state.inner(),
        &tab_id,
        url.as_deref().unwrap_or(WRIKE_HOME),
        false,
        pane.unwrap_or(WrikePane::Full),
    )
}

#[tauri::command]
fn resize_wrike_tabs(
    app: AppHandle,
    state: State<'_, AppState>,
    layouts: Option<Vec<WrikeTabLayout>>,
) -> Result<(), String> {
    let host_size = host_logical_size(&app)?;
    if let Some(layouts) = layouts.filter(|layouts| !layouts.is_empty()) {
        for layout in layouts {
            if let Some(webview) = app.get_webview(&wrike_tab_label(&layout.tab_id)?) {
                sync_wrike_bounds_for_size(host_size, &webview, layout.pane)?;
            }
        }
        return Ok(());
    }

    let tab_ids = state
        .wrike_tabs
        .lock()
        .map(|tabs| tabs.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for tab_id in tab_ids {
        if let Some(webview) = app.get_webview(&wrike_tab_label(&tab_id)?) {
            sync_wrike_bounds_for_size(host_size, &webview, WrikePane::Full)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn hide_wrike_tabs(app: AppHandle, tab_ids: Vec<String>) -> Result<(), String> {
    for tab_id in tab_ids {
        let label = wrike_tab_label(&tab_id)?;
        if let Some(webview) = app.get_webview(&label) {
            webview
                .hide()
                .map_err(|error| format!("Unable to hide the Wrike workspace: {error}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn focus_wrike_tab(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), String> {
    let label = wrike_tab_label(&tab_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "This Wrike tab is not open yet.".to_owned())?;
    webview
        .show()
        .map_err(|error| format!("Unable to display the Wrike workspace: {error}"))?;
    webview.set_focus().map_err(|error| error.to_string())?;
    if let Some(context) = find_wrike_context(state.inner(), &tab_id) {
        emit_wrike_tab_update(&app, &context);
    }
    Ok(())
}

#[tauri::command]
async fn open_source_task(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    tab_id: Option<String>,
) -> Result<String, String> {
    let parsed = Url::parse(&url).map_err(|_| "Invalid source task link.".to_owned())?;
    let allowed_host = parsed
        .host_str()
        .is_some_and(|host| host == "wrike.com" || host.ends_with(".wrike.com"));
    if parsed.scheme() != "https" || !allowed_host {
        return Err("Only HTTPS Wrike task links may be opened inside ABW.".into());
    }
    let requested = tab_id
        .map(|candidate| candidate.trim().to_owned())
        .filter(|candidate| !candidate.is_empty());
    let target_tab_id = if let Some(candidate) = requested {
        wrike_tab_label(&candidate)?;
        candidate
    } else {
        let open_ids = state
            .wrike_tabs
            .lock()
            .ok()
            .map(|tabs| tabs.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        if open_ids.iter().any(|id| id == "home") {
            "home".to_owned()
        } else {
            open_ids
                .into_iter()
                .next()
                .unwrap_or_else(|| "home".to_owned())
        }
    };
    open_wrike_at(
        &app,
        state.inner(),
        &target_tab_id,
        parsed.as_str(),
        true,
        WrikePane::Full,
    )?;
    Ok(target_tab_id)
}

#[tauri::command]
fn close_wrike_tab(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), String> {
    let label = wrike_tab_label(&tab_id)?;
    if let Some(webview) = app.get_webview(&label) {
        webview
            .close()
            .map_err(|error| format!("Unable to close the Wrike tab: {error}"))?;
    }
    if let Ok(mut tabs) = state.wrike_tabs.lock() {
        tabs.remove(&tab_id);
    }
    Ok(())
}

#[tauri::command]
fn wrike_tab_action(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    action: String,
) -> Result<(), String> {
    let label = wrike_tab_label(&tab_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "This Wrike tab is not open yet.".to_owned())?;
    match action.as_str() {
        "back" => {
            if tab_can_go(state.inner(), &tab_id, true) {
                webview
                    .eval("window.history.back();")
                    .map_err(|error| format!("Unable to go back in Wrike: {error}"))?;
            }
        }
        "forward" => {
            if tab_can_go(state.inner(), &tab_id, false) {
                webview
                    .eval("window.history.forward();")
                    .map_err(|error| format!("Unable to go forward in Wrike: {error}"))?;
            }
        }
        "reload" => {
            webview
                .reload()
                .map_err(|error| format!("Unable to refresh Wrike: {error}"))?;
        }
        _ => return Err("Unsupported Wrike tab action.".into()),
    }
    if let Some(context) = find_wrike_context(state.inner(), &tab_id) {
        emit_wrike_tab_update(&app, &context);
    }
    Ok(())
}

#[tauri::command]
fn get_wrike_tab_state(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Option<WrikeTabUpdate>, String> {
    wrike_tab_label(&tab_id)?;
    Ok(find_wrike_context(state.inner(), &tab_id).map(|context| wrike_tab_update(&context)))
}

fn open_wrike_at(
    app: &AppHandle,
    state: &AppState,
    tab_id: &str,
    destination: &str,
    navigate_existing: bool,
    pane: WrikePane,
) -> Result<(), String> {
    let label = wrike_tab_label(tab_id)?;
    let parsed = Url::parse(destination).map_err(|error| format!("Invalid Wrike URL: {error}"))?;
    if let Some(webview) = app.get_webview(&label) {
        sync_wrike_bounds(app, &webview, pane)?;
        if navigate_existing {
            webview
                .navigate(parsed)
                .map_err(|error| format!("Unable to open the task in Wrike: {error}"))?;
            if let Some(context) = find_wrike_context(state, tab_id) {
                record_wrike_navigation(&context, destination);
                emit_wrike_tab_update(app, &context);
            }
        }
        webview
            .show()
            .map_err(|error| format!("Unable to display the Wrike workspace: {error}"))?;
        webview.set_focus().map_err(|error| error.to_string())?;
        if let Some(context) = find_wrike_context(state, tab_id) {
            emit_wrike_tab_update(app, &context);
        }
        return Ok(());
    }

    let host = app
        .get_window("main")
        .ok_or_else(|| "Unable to locate the ABW application window.".to_owned())?;
    let host_size = host_logical_size(app)?;
    let (content_position, content_size) = wrike_pane_geometry(host_size, pane);
    let spell_check = read_settings(app)?.spell_check;
    let context = Arc::new(CaptureContext::new(tab_id, destination));
    let title_context = Arc::clone(&context);
    let title_app = app.clone();
    let navigation_context = Arc::clone(&context);
    let navigation_app = app.clone();
    let load_context = Arc::clone(&context);
    let load_app = app.clone();
    let popup_context = Arc::clone(&context);
    let popup_app = app.clone();
    let popup_workspace_label = label.clone();
    if let Ok(mut tabs) = state.wrike_tabs.lock() {
        tabs.insert(tab_id.to_owned(), Arc::clone(&context));
    }
    if let Ok(mut latest) = context.page_url.lock() {
        *latest = Some(destination.to_owned());
    }

    let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed))
        .auto_resize()
        .zoom_hotkeys_enabled(true)
        .initialization_script(apply_spell_check_script(spell_check, false))
        .on_navigation(move |url| {
            if url.scheme() == "abw-dictionary" {
                let _ = add_custom_dictionary_word(&navigation_app, url);
                return false;
            }
            if url.scheme() == "abw-shortcut" {
                handle_wrike_shortcut(&navigation_app, url);
                return false;
            }
            let allowed = is_safe_remote_destination(url);
            if allowed {
                set_title_loading(&navigation_context, true);
                record_wrike_navigation(&navigation_context, url.as_str());
                emit_wrike_tab_update(&navigation_app, &navigation_context);
            }
            allowed
        })
        .on_new_window(move |url, features| {
            if !is_safe_remote_destination(&url) {
                return NewWindowResponse::Deny;
            }
            let parent_provenance = captured_provenance(&popup_context);
            let child_title_context = Arc::clone(&popup_context);
            let child_download_context = Arc::clone(&popup_context);
            let label = format!("wrike-popup-{}", Uuid::new_v4());
            let completion_app = popup_app.clone();
            let completion_workspace_label = popup_workspace_label.clone();
            let child_builder = WebviewWindowBuilder::new(
                &popup_app,
                label,
                WebviewUrl::External(
                    Url::parse("about:blank").expect("about:blank is a valid URL"),
                ),
            )
            .title("ABW - Wrike")
            .window_features(features)
            .skip_taskbar(true)
            .zoom_hotkeys_enabled(true)
            .initialization_script(apply_spell_check_script(spell_check, true))
            .on_navigation(is_safe_remote_destination)
            .on_page_load(move |window, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished)
                    && is_wrike_workspace_destination(payload.url())
                {
                    if let Some(workspace) = completion_app.get_webview(&completion_workspace_label)
                    {
                        let _ = workspace.navigate(payload.url().clone());
                        let _ = workspace.show();
                        let _ = workspace.set_focus();
                    }
                    let _ = window.close();
                }
            })
            .on_document_title_changed(move |window, title| {
                if let Ok(mut latest) = child_title_context.page_title.lock() {
                    *latest = title.clone();
                }
                let _ = window.set_title(&format!("ABW - {title}"));
            })
            .on_download(download_handler(
                popup_app.clone(),
                child_download_context,
                Some(parent_provenance),
                true,
            ));
            let child = child_builder.build();
            match child {
                Ok(window) => NewWindowResponse::Create { window },
                Err(error) => {
                    emit_download_capture_error(
                        &popup_app,
                        format!("Unable to open the Wrike file window: {error}"),
                    );
                    NewWindowResponse::Deny
                }
            }
        })
        .on_page_load(move |_webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Started) {
                set_title_loading(&load_context, true);
            } else if matches!(payload.event(), PageLoadEvent::Finished) {
                set_title_loading(&load_context, false);
            }
            emit_wrike_tab_update(&load_app, &load_context);
        })
        .on_document_title_changed(move |webview, title| {
            if !clean_wrike_title(&title).is_empty() {
                if let Ok(mut latest) = title_context.page_title.lock() {
                    *latest = title.clone();
                }
                set_title_loading(&title_context, false);
            } else {
                set_title_loading(&title_context, true);
            }
            if let Ok(url) = webview.url() {
                record_wrike_navigation(&title_context, url.as_str());
            }
            emit_wrike_tab_update(&title_app, &title_context);
        })
        .on_download(download_handler(
            app.clone(),
            Arc::clone(&context),
            None,
            false,
        ));
    host.add_child(builder, content_position, content_size)
        .map_err(|error| format!("Unable to open Wrike workspace: {error}"))?;
    emit_wrike_tab_update(app, &context);
    Ok(())
}

fn host_logical_size(app: &AppHandle) -> Result<LogicalSize<f64>, String> {
    let host = app
        .get_window("main")
        .ok_or_else(|| "Unable to locate the ABW application window.".to_owned())?;
    let scale = host.scale_factor().map_err(|error| error.to_string())?;
    let size = host
        .inner_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    Ok(size)
}

fn wrike_pane_geometry(
    host_size: LogicalSize<f64>,
    pane: WrikePane,
) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let content_height = (host_size.height - TASKBAR_HEIGHT).max(1.0);
    let half_width = (host_size.width / 2.0).max(1.0);
    let (x, width) = match pane {
        WrikePane::Full => (0.0, host_size.width),
        WrikePane::Left => (0.0, half_width),
        WrikePane::Right => (half_width, (host_size.width - half_width).max(1.0)),
    };
    (
        LogicalPosition::new(x, TASKBAR_HEIGHT),
        LogicalSize::new(width, content_height),
    )
}

fn sync_wrike_bounds_for_size(
    host_size: LogicalSize<f64>,
    webview: &Webview,
    pane: WrikePane,
) -> Result<(), String> {
    let (position, size) = wrike_pane_geometry(host_size, pane);
    webview
        .set_position(position)
        .map_err(|error| format!("Unable to move the Wrike workspace: {error}"))?;
    webview
        .set_size(size)
        .map_err(|error| format!("Unable to resize the Wrike workspace: {error}"))
}

fn sync_wrike_bounds(app: &AppHandle, webview: &Webview, pane: WrikePane) -> Result<(), String> {
    sync_wrike_bounds_for_size(host_logical_size(app)?, webview, pane)
}

fn download_handler(
    app: AppHandle,
    context: Arc<CaptureContext>,
    provenance_override: Option<PendingDownload>,
    close_webview_on_finish: bool,
) -> impl Fn(tauri::Webview, DownloadEvent<'_>) -> bool + Send + Sync + 'static {
    move |webview, event| {
        match event {
            DownloadEvent::Requested {
                url: _,
                destination,
            } => {
                if close_webview_on_finish {
                    let _ = webview.hide();
                }
                let suggested_name = destination
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("wrike-download");
                let path = match unique_download_path(&app, suggested_name) {
                    Ok(path) => path,
                    Err(error) => {
                        emit_download_capture_error(&app, error);
                        return false;
                    }
                };
                let provenance = provenance_override
                    .clone()
                    .unwrap_or_else(|| PendingDownload {
                        source_url: webview.url().ok().map(|current| current.to_string()),
                        source_label: captured_provenance(&context).source_label,
                    });
                if let Ok(mut pending) = context.pending.lock() {
                    pending.insert(path.clone(), provenance);
                }
                *destination = path;
            }
            DownloadEvent::Finished {
                url: _,
                path,
                success,
            } => {
                if success {
                    if let Some(path) = path {
                        let provenance = context
                            .pending
                            .lock()
                            .ok()
                            .and_then(|mut entries| entries.remove(&path))
                            .unwrap_or_else(|| captured_provenance(&context));
                        if let Err(error) = record_completed_download(&app, &path, provenance) {
                            emit_download_capture_error(&app, error);
                        }
                    } else {
                        emit_download_capture_error(
                            &app,
                            "Wrike completed a download without reporting its saved location."
                                .into(),
                        );
                    }
                }
                if close_webview_on_finish {
                    let _ = webview.close();
                }
            }
            _ => {}
        }
        true
    }
}

fn captured_provenance(context: &CaptureContext) -> PendingDownload {
    PendingDownload {
        source_url: context.page_url.lock().ok().and_then(|url| url.clone()),
        source_label: context
            .page_title
            .lock()
            .ok()
            .map(|title| clean_wrike_title(&title))
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| "Wrike task".to_owned()),
    }
}

fn emit_download_capture_error(app: &AppHandle, message: String) {
    let _ = app.emit("download-capture-error", message);
}

fn record_completed_download(
    app: &AppHandle,
    path: &Path,
    provenance: PendingDownload,
) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download")
        .to_owned();
    let notification_file_name = file_name.clone();
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_lowercase();
    let size_bytes = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let record = DownloadRecord {
        id: Uuid::new_v4().to_string(),
        file_name,
        kind: file_kind(&extension).into(),
        extension,
        downloaded_at: Utc::now().to_rfc3339(),
        size_bytes,
        source_url: provenance.source_url,
        source_label: provenance.source_label,
    };
    persistence::update::<Vec<DownloadRecord>, _>(&records_path(app)?, |records| {
        records.insert(0, record.clone());
        Ok(())
    })?;
    if let Ok(canonical) = path.canonicalize() {
        if let Ok(mut paths) = app.state::<AppState>().tracked_paths.lock() {
            paths.insert(record.id.clone(), canonical);
        }
    }
    let settings = settings_path(app)
        .and_then(|path| persistence::read::<Settings>(&path))
        .unwrap_or_default();
    if settings.download_notifications {
        let _ = app
            .notification()
            .builder()
            .title("Download saved to ABW Files")
            .body(format!("{notification_file_name} is ready to preview."))
            .show();
    }
    if settings.open_downloaded_files_automatically {
        let _ = open::that(path);
    }
    app.emit("downloads-updated", ())
        .map_err(|error| format!("Unable to refresh Files view: {error}"))?;
    app.emit("download-completed", record)
        .map_err(|error| format!("Unable to open the completed download in Files: {error}"))
}

fn read_records(app: &AppHandle) -> Result<Vec<DownloadRecord>, String> {
    persistence::read(&records_path(app)?)
}

fn read_settings(app: &AppHandle) -> Result<Settings, String> {
    let mut settings: Settings = persistence::read(&settings_path(app)?)?;
    settings.open_abw_at_system_startup = startup::enabled()?;
    Ok(settings)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn request_quit(app: &AppHandle, explicit: bool) {
    // Corrupt preferences must not make the application impossible to quit.
    let settings = read_settings(app).unwrap_or_default();
    let state = app.state::<AppState>();
    let tab_count = state.wrike_tabs.lock().map(|tabs| tabs.len()).unwrap_or(2);
    let action = close_policy::action(
        explicit,
        settings.close_to_notification_area,
        settings.confirm_before_closing_tabs,
        tab_count,
    );
    trace_native_event(
        app,
        &format!(
            "close explicit={explicit} tray={} confirm={} tabs={tab_count} action={action:?}",
            settings.close_to_notification_area, settings.confirm_before_closing_tabs
        ),
    );
    if action == close_policy::CloseAction::Hide {
        if let Some(window) = app.get_window("main") {
            let _ = window.hide();
        }
        return;
    }
    if action == close_policy::CloseAction::Quit {
        app.exit(0);
        return;
    }
    if state.quit_prompt_open.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    app.clone()
        .dialog()
        .message("Close all open Wrike tabs and quit ABW?")
        .title("Quit ABW")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit".into(),
            "Cancel".into(),
        ))
        .show(move |confirmed| {
            app.state::<AppState>()
                .quit_prompt_open
                .store(false, Ordering::SeqCst);
            if close_policy::finish_confirmation(confirmed).is_some() {
                app.exit(0);
            }
        });
}

fn trace_native_event(app: &AppHandle, event: &str) {
    if env::var("ABW_CI_TRACE").as_deref() != Ok("1") {
        return;
    }
    use std::io::Write;
    if let Ok(directory) = application_dir(app) {
        let _ = fs::create_dir_all(&directory);
        if let Ok(mut file) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("native-ci.log"))
        {
            let _ = writeln!(
                file,
                "pid={} version={} data={} {event}",
                std::process::id(),
                env!("CARGO_PKG_VERSION"),
                directory.display()
            );
        }
    }
}

fn application_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Unable to locate app data directory: {error}"))
}

fn records_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(application_dir(app)?.join("files.json"))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(application_dir(app)?.join("settings.json"))
}

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(application_dir(app)?.join("session.json"))
}

fn downloads_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = application_dir(app)?.join("downloads");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Unable to create download directory: {error}"))?;
    Ok(directory)
}

fn unique_download_path(app: &AppHandle, suggested_name: &str) -> Result<PathBuf, String> {
    let directory = downloads_dir(app)?;
    let sanitized = Path::new(suggested_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("wrike-download");
    let original = Path::new(sanitized);
    let stem = original
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("wrike-download");
    let extension = original
        .extension()
        .and_then(|extension| extension.to_str());
    let mut candidate = directory.join(sanitized);
    let mut suffix = 1;
    while candidate.exists() {
        let name = extension.map_or_else(
            || format!("{stem} ({suffix})"),
            |extension| format!("{stem} ({suffix}).{extension}"),
        );
        candidate = directory.join(name);
        suffix += 1;
    }
    Ok(candidate)
}

fn tracked_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let record = read_records(app)?
        .into_iter()
        .find(|record| record.id == id)
        .ok_or_else(|| "This download is no longer in the Files library.".to_owned())?;
    let root = downloads_dir(app)?
        .canonicalize()
        .map_err(|error| format!("Unable to validate downloads directory: {error}"))?;
    let candidate = root.join(&record.file_name);
    let resolved = candidate
        .canonicalize()
        .map_err(|error| format!("Downloaded file is unavailable: {error}"))?;
    if !resolved.starts_with(root) {
        return Err("Refusing to open a file outside the ABW downloads directory.".into());
    }
    Ok(resolved)
}

fn file_kind(extension: &str) -> &'static str {
    match extension {
        "pdf" => "pdf",
        "xls" | "xlsx" | "xlsm" | "xlsb" | "ods" => "spreadsheet",
        "doc" | "docx" | "rtf" | "txt" => "document",
        _ => "other",
    }
}

fn clean_wrike_title(title: &str) -> String {
    title
        .trim_end_matches(" - Wrike")
        .trim_end_matches(" | Wrike")
        .trim()
        .to_owned()
}

fn normalize_dictionary(words: Vec<String>) -> Vec<String> {
    let mut normalized = words
        .into_iter()
        .filter_map(|word| normalize_dictionary_word(&word))
        .collect::<Vec<_>>();
    normalized.sort_by_key(|word| word.to_lowercase());
    normalized.dedup_by(|first, second| first.eq_ignore_ascii_case(second));
    normalized
}

fn normalize_startup_tab_urls(urls: Vec<String>) -> Vec<String> {
    let mut normalized = urls
        .into_iter()
        .filter_map(|url| normalize_startup_tab_url(&url))
        .collect::<Vec<_>>();
    normalized.dedup_by(|first, second| first.eq_ignore_ascii_case(second));
    if normalized.is_empty() {
        normalized.push(WRIKE_HOME.to_owned());
    }
    normalized
}

fn normalize_startup_tab_url(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = if trimmed.contains("://") || trimmed == "about:blank" {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    };
    Url::parse(&candidate)
        .ok()
        .filter(|parsed| {
            matches!(parsed.scheme(), "http" | "https") || parsed.as_str() == "about:blank"
        })
        .map(|parsed| parsed.to_string())
}

fn normalize_string_ids(ids: Vec<String>) -> Vec<String> {
    let mut normalized = ids
        .into_iter()
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    normalized.dedup();
    normalized
}

fn normalize_wrike_session(session: WrikeSession) -> WrikeSession {
    let tabs = session
        .tabs
        .into_iter()
        .filter(|tab| !tab.id.trim().is_empty())
        .map(|tab| WrikeSessionTab {
            id: tab.id.trim().to_owned(),
            title: tab.title.trim().to_owned(),
            url: tab
                .url
                .as_deref()
                .and_then(normalize_startup_tab_url)
                .or_else(|| Some(WRIKE_HOME.to_owned())),
            mode: if tab.mode == "readOnly" {
                "readOnly".to_owned()
            } else {
                "standard".to_owned()
            },
        })
        .collect::<Vec<_>>();
    let tab_ids = tabs.iter().map(|tab| tab.id.clone()).collect::<Vec<_>>();
    let active_tab_id = if tab_ids.iter().any(|id| id == &session.active_tab_id) {
        session.active_tab_id
    } else {
        tab_ids
            .first()
            .cloned()
            .unwrap_or_else(|| "home".to_owned())
    };
    let split = session.split.filter(|split| {
        tab_ids.iter().any(|id| id == &split.left_tab_id)
            && tab_ids.iter().any(|id| id == &split.right_tab_id)
            && split.left_tab_id != split.right_tab_id
    });
    WrikeSession {
        tabs,
        active_tab_id,
        split,
        saved_at: session.saved_at,
    }
}

fn normalize_dictionary_word(word: &str) -> Option<String> {
    let trimmed = word.trim().trim_matches(|character: char| {
        !character.is_alphanumeric() && character != '-' && character != '\''
    });
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_owned())
}

fn handle_wrike_shortcut(app: &AppHandle, url: &Url) {
    let mut action: Option<String> = None;
    let mut index: Option<usize> = None;
    let mut target_url: Option<String> = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "action" => {
                if matches!(
                    value.as_ref(),
                    "new-tab"
                        | "close-tab"
                        | "next-tab"
                        | "prev-tab"
                        | "select-tab"
                        | "toggle-split"
                        | "open-url"
                ) {
                    action = Some(value.into_owned());
                }
            }
            "index" => {
                if let Some(parsed) = value
                    .parse::<usize>()
                    .ok()
                    .filter(|parsed| (1..=9).contains(parsed))
                {
                    index = Some(parsed);
                }
            }
            "url" => {
                if let Ok(parsed) = Url::parse(value.as_ref()) {
                    let is_wrike = parsed
                        .host_str()
                        .is_some_and(|host| host == "wrike.com" || host.ends_with(".wrike.com"));
                    if parsed.scheme() == "https" && is_wrike {
                        target_url = Some(parsed.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(action) = action {
        if action == "open-url" && target_url.is_none() {
            return;
        }
        let _ = app.emit(
            "wrike-shortcut",
            WrikeShortcutEvent {
                action,
                index,
                url: target_url,
            },
        );
    }
}

fn add_custom_dictionary_word(app: &AppHandle, url: &Url) -> Result<(), String> {
    let word = url
        .query_pairs()
        .find_map(|(key, value)| (key == "word").then(|| value.into_owned()))
        .and_then(|word| normalize_dictionary_word(&word))
        .ok_or_else(|| "No dictionary word was provided.".to_owned())?;
    let (settings, previous) =
        persistence::update::<Settings, _>(&settings_path(app)?, |settings| {
            let previous = settings.custom_dictionary.clone();
            settings.custom_dictionary.push(word);
            settings.custom_dictionary =
                normalize_dictionary(std::mem::take(&mut settings.custom_dictionary));
            settings.open_abw_at_system_startup = startup::enabled()?;
            Ok(previous)
        })?;
    sync_windows_spelling_dictionary(&previous, &settings.custom_dictionary);
    app.emit("settings-updated", settings)
        .map_err(|error| format!("Unable to refresh settings: {error}"))
}

#[cfg(target_os = "windows")]
fn sync_windows_spelling_dictionary(old_words: &[String], new_words: &[String]) {
    let Some(app_data) = env::var_os("APPDATA") else {
        return;
    };
    let spelling_root = PathBuf::from(app_data).join("Microsoft").join("Spelling");
    if fs::create_dir_all(spelling_root.join("en-US")).is_err() {
        return;
    }
    let mut dictionaries = fs::read_dir(&spelling_root)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_dir())
                .map(|_| entry.path().join("default.dic"))
        })
        .collect::<Vec<_>>();
    if dictionaries.is_empty() {
        dictionaries.push(spelling_root.join("en-US").join("default.dic"));
    }
    for dictionary in dictionaries {
        let mut entries = fs::read_to_string(&dictionary)
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        entries.retain(|entry| {
            new_words
                .iter()
                .any(|word| word.eq_ignore_ascii_case(entry))
                || !old_words
                    .iter()
                    .any(|word| word.eq_ignore_ascii_case(entry))
        });
        entries.extend(new_words.iter().cloned());
        entries = normalize_dictionary(entries);
        if let Some(parent) = dictionary.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(dictionary, entries.join("\r\n"));
    }
}

#[cfg(not(target_os = "windows"))]
fn sync_windows_spelling_dictionary(_old_words: &[String], _new_words: &[String]) {}

fn find_wrike_context(state: &AppState, tab_id: &str) -> Option<Arc<CaptureContext>> {
    state
        .wrike_tabs
        .lock()
        .ok()
        .and_then(|tabs| tabs.get(tab_id).cloned())
}

fn record_wrike_navigation(context: &CaptureContext, url: &str) {
    if let Ok(mut latest) = context.page_url.lock() {
        *latest = Some(url.to_owned());
    }
    if let Ok(mut history) = context.history.lock() {
        history.record(url);
    }
}

fn tab_can_go(state: &AppState, tab_id: &str, backwards: bool) -> bool {
    find_wrike_context(state, tab_id)
        .and_then(|context| {
            context.history.lock().ok().map(|history| {
                if backwards {
                    history.can_go_back()
                } else {
                    history.can_go_forward()
                }
            })
        })
        .unwrap_or(false)
}

fn set_title_loading(context: &CaptureContext, is_loading: bool) {
    if let Ok(mut loading) = context.is_title_loading.lock() {
        *loading = is_loading;
    }
}

fn wrike_tab_update(context: &CaptureContext) -> WrikeTabUpdate {
    let title = context
        .page_title
        .lock()
        .ok()
        .map(|title| clean_wrike_title(&title))
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| "Wrike".to_owned());
    let url = context.page_url.lock().ok().and_then(|url| url.clone());
    let (can_go_back, can_go_forward) = context
        .history
        .lock()
        .ok()
        .map(|history| (history.can_go_back(), history.can_go_forward()))
        .unwrap_or((false, false));
    let is_title_loading = context
        .is_title_loading
        .lock()
        .map(|loading| *loading)
        .unwrap_or(false);
    WrikeTabUpdate {
        tab_id: context.tab_id.clone(),
        title,
        url,
        can_go_back,
        can_go_forward,
        is_title_loading,
    }
}

fn emit_wrike_tab_update(app: &AppHandle, context: &CaptureContext) {
    let _ = app.emit("wrike-tab-updated", wrike_tab_update(context));
}

fn wrike_tab_label(tab_id: &str) -> Result<String, String> {
    if tab_id.is_empty()
        || !tab_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("Invalid Wrike tab identifier.".into());
    }
    Ok(format!("wrike-{tab_id}"))
}

fn is_safe_remote_destination(url: &Url) -> bool {
    url.scheme() == "https" || url.as_str() == "about:blank" || is_safe_blob_destination(url)
}

fn is_safe_blob_destination(url: &Url) -> bool {
    if url.scheme() != "blob" {
        return false;
    }
    url.as_str()
        .strip_prefix("blob:")
        .and_then(|inner| Url::parse(inner).ok())
        .is_some_and(|inner| inner.scheme() == "https")
}

fn is_wrike_workspace_destination(url: &Url) -> bool {
    let is_wrike = url
        .host_str()
        .is_some_and(|host| host == "wrike.com" || host.ends_with(".wrike.com"));
    url.scheme() == "https" && is_wrike && url.path().ends_with("/workspace.htm")
}

fn apply_spell_check_script(enabled: bool, auto_download: bool) -> &'static str {
    static SCRIPTS: [OnceLock<String>; 4] = [
        OnceLock::new(),
        OnceLock::new(),
        OnceLock::new(),
        OnceLock::new(),
    ];
    let slot = (usize::from(enabled) << 1) | usize::from(auto_download);
    SCRIPTS[slot]
        .get_or_init(|| {
            let enabled_literal = if enabled { "true" } else { "false" };
            let auto_download_literal = if auto_download { "true" } else { "false" };
            r##"
        (() => {
          window.__abwSpellCleanup?.();
          const enabled = __ABW_SPELL_CHECK_ENABLED__;
          const abwAutoDownload = __ABW_AUTO_DOWNLOAD__;
          let abwSpellApplyTimer = 0;
          let abwSpellApplyIdle = false;
          const editableSelector = 'textarea, input[type="text"], [contenteditable="true"], [role="textbox"]';
          const applyToElement = (element) => {
            if (element instanceof Element && element.spellcheck !== enabled) {
              element.spellcheck = enabled;
            }
          };
          const applyToTree = (root) => {
            if (!(root instanceof Element)) return;
            if (root.matches(editableSelector)) applyToElement(root);
            root.querySelectorAll(editableSelector).forEach(applyToElement);
          };
          const applyAll = () => {
            document.querySelectorAll(editableSelector).forEach(applyToElement);
          };
          const pendingSpellRoots = new Set();
          const flushSpellRoots = () => {
            abwSpellApplyTimer = 0;
            abwSpellApplyIdle = false;
            if (!pendingSpellRoots.size) return;
            const roots = Array.from(pendingSpellRoots);
            pendingSpellRoots.clear();
            for (const root of roots) applyToTree(root);
          };
          const scheduleApply = (mutations) => {
            for (const mutation of mutations) {
              if (mutation.type === "attributes" && mutation.target instanceof Element) {
                pendingSpellRoots.add(mutation.target);
              } else if (mutation.addedNodes) {
                for (const node of mutation.addedNodes) {
                  if (node instanceof Element) pendingSpellRoots.add(node);
                }
              }
            }
            if (!pendingSpellRoots.size || abwSpellApplyTimer) return;
            if (typeof window.requestIdleCallback === "function") {
              abwSpellApplyIdle = true;
              abwSpellApplyTimer = window.requestIdleCallback(flushSpellRoots, { timeout: 150 });
            } else {
              abwSpellApplyIdle = false;
              abwSpellApplyTimer = window.setTimeout(flushSpellRoots, 80);
            }
          };
          const applyEditableFocus = (event) => {
            if (event.target instanceof Element && event.target.matches(editableSelector)) {
              applyToElement(event.target);
            }
          };
          const findEditable = (element) => {
            const active = document.activeElement;
            for (let current = element; current; current = current.parentElement) {
              if (
                current instanceof HTMLTextAreaElement ||
                current instanceof HTMLInputElement ||
                current.isContentEditable ||
                current.getAttribute('role') === 'textbox'
              ) {
                return current;
              }
            }
            if (
              active instanceof HTMLTextAreaElement ||
              active instanceof HTMLInputElement ||
              active?.isContentEditable ||
              active?.getAttribute?.('role') === 'textbox'
            ) {
              return active;
            }
            return null;
          };
          const selectionIsActive = () => {
            const selection = window.getSelection();
            return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
          };
          const selectedWord = () => {
            const selection = window.getSelection();
            const text = selection && !selection.isCollapsed ? selection.toString() : "";
            return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/u) || [])[0] || "";
          };
          const wordFromText = (text, offset) => {
            if (!text) return "";
            let start = Math.max(0, Math.min(offset, text.length));
            let end = start;
            while (start > 0 && /[\p{L}\p{N}'-]/u.test(text[start - 1])) start -= 1;
            while (end < text.length && /[\p{L}\p{N}'-]/u.test(text[end])) end += 1;
            return text.slice(start, end);
          };
          const nearestTextWord = (root, event) => {
            if (!root) return "";
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let best = "";
            let inspected = 0;
            while (walker.nextNode() && inspected < 300) {
              inspected += 1;
              const node = walker.currentNode;
              const text = node.textContent || "";
              if (!/[\p{L}\p{N}]/u.test(text)) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              const bounds = range.getBoundingClientRect();
              if (
                event.clientX < bounds.left - 6 ||
                event.clientX > bounds.right + 6 ||
                event.clientY < bounds.top - 6 ||
                event.clientY > bounds.bottom + 6
              ) {
                range.detach?.();
                continue;
              }
              const rects = Array.from(range.getClientRects());
              range.detach?.();
              const rect = rects.find((candidate) =>
                event.clientX >= candidate.left - 6 &&
                event.clientX <= candidate.right + 6 &&
                event.clientY >= candidate.top - 6 &&
                event.clientY <= candidate.bottom + 6
              );
              if (!rect) continue;
              const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
              best = wordFromText(text, Math.round(Math.max(0, Math.min(1, ratio)) * text.length));
              if (best) break;
            }
            return best;
          };
          const wordFromPoint = (event, editable) => {
            const selected = selectedWord();
            if (selected) return selected;
            if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
              return wordFromText(editable.value || "", editable.selectionStart || 0);
            }
            const range =
              document.caretRangeFromPoint?.(event.clientX, event.clientY) ||
              (() => {
                const position = document.caretPositionFromPoint?.(event.clientX, event.clientY);
                if (!position) return null;
                const next = document.createRange();
                next.setStart(position.offsetNode, position.offset);
                return next;
              })();
            if (!range || !range.startContainer || range.startContainer.nodeType !== Node.TEXT_NODE) {
              return nearestTextWord(editable || event.target, event);
            }
            const text = range.startContainer.textContent || "";
            return wordFromText(text, range.startOffset) || nearestTextWord(editable || event.target, event);
          };
          const closeDictionaryMenu = () => document.getElementById("abw-dictionary-menu")?.remove();
          const showDictionaryMenu = (word, event) => {
            closeDictionaryMenu();
            const menu = document.createElement("button");
            menu.id = "abw-dictionary-menu";
            menu.type = "button";
            menu.textContent = `Add "${word}" to dictionary`;
            Object.assign(menu.style, {
              position: "fixed",
              left: `${Math.max(8, event.clientX)}px`,
              top: `${Math.max(8, event.clientY)}px`,
              zIndex: "2147483647",
              padding: "9px 12px",
              border: "1px solid #d6dce8",
              borderRadius: "8px",
              background: "#fff",
              color: "#17233a",
              boxShadow: "0 12px 32px rgba(17, 29, 59, .18)",
              font: "13px Segoe UI, sans-serif",
              cursor: "pointer"
            });
            menu.addEventListener("click", () => {
              window.location.href = `abw-dictionary://add?word=${encodeURIComponent(word)}`;
              closeDictionaryMenu();
            });
            document.body.append(menu);
            window.setTimeout(() => document.addEventListener("click", closeDictionaryMenu, { once: true, capture: true }), 0);
          };
          const keepWrikeEditorToolsVisible = (event) => {
            const editable = findEditable(event.target);
            if (!editable) {
              closeDictionaryMenu();
              return;
            }
            const word = wordFromPoint(event, editable);
            if (word || selectionIsActive()) {
              event.preventDefault();
              if (word) showDictionaryMenu(word, event);
            }
          };
          const abwSupportedFileName = /[^\\r\\n]{1,180}[.](pdf|doc|docx|xls|xlsx|xlsm|xlsb|ods|csv|tsv|rtf|txt)/i;
          const abwDownloadWord = /download/i;
          const abwIsVisible = (element) => {
            if (!(element instanceof Element)) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          };
          const abwControlLabel = (element) =>
            [
              element?.getAttribute?.("aria-label"),
              element?.getAttribute?.("title"),
              element?.textContent
            ].filter(Boolean).join(" ").trim();
          const abwLooksLikeDownloadUrl = (value) => {
            let text = String(value || "");
            try { text = decodeURIComponent(text); } catch {}
            return /download|attachment|filename|disposition/i.test(text) || abwSupportedFileName.test(text);
          };
          const abwFindSupportedFileName = (element) => {
            for (
              let current = element, depth = 0;
              current && current !== document.body && depth < 6;
              current = current.parentElement, depth += 1
            ) {
              if (current.childElementCount > 16) continue;
              const text = (current.textContent || "").trim();
              if (text.length > 240) continue;
              const match = text.match(abwSupportedFileName);
              if (match) return match[0].trim();
            }
            return "";
          };
          const abwNormalizeFileName = (value) =>
            String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
          let abwPreviewDownloadObserver = null;
          let abwPreviewDownloadTimeout = 0;
          let abwPreviewDownloadCheckScheduled = 0;
          let abwPreviewDownloadRequest = 0;
          let abwExpectingDownloadUntil = 0;
          const abwStopPreviewDownloadObserver = () => {
            abwPreviewDownloadObserver?.disconnect();
            abwPreviewDownloadObserver = null;
            window.clearTimeout(abwPreviewDownloadTimeout);
            abwPreviewDownloadTimeout = 0;
            window.clearTimeout(abwPreviewDownloadCheckScheduled);
            abwPreviewDownloadCheckScheduled = 0;
          };
          const abwQueuePreviewDownload = (fileName = "") => {
            abwStopPreviewDownloadObserver();
            const request = ++abwPreviewDownloadRequest;
            const expectedFileName = abwNormalizeFileName(fileName);
            const previousDialogs = new Map(
              Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
                .filter(abwIsVisible)
                .map((root) => [root, abwNormalizeFileName(root.textContent)])
            );
            const inspectDialogs = () => {
              abwPreviewDownloadCheckScheduled = 0;
              if (request !== abwPreviewDownloadRequest) {
                abwStopPreviewDownloadObserver();
                return false;
              }
              const roots = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
                .filter(abwIsVisible)
                .reverse();
              if (abwAutoDownload) roots.push(document);
              for (const root of roots) {
                const rootText = abwNormalizeFileName(root.textContent);
                const matchesExpectedFile = expectedFileName && rootText.includes(expectedFileName);
                const isNewOrChangedDialog =
                  !previousDialogs.has(root) || previousDialogs.get(root) !== rootText;
                if (expectedFileName && !matchesExpectedFile && !isNewOrChangedDialog) {
                  continue;
                }
                const download = Array.from(root.querySelectorAll('button, a, [role="button"], [role="link"]'))
                  .find((control) => {
                    if (!abwIsVisible(control) || !abwDownloadWord.test(abwControlLabel(control))) {
                      return false;
                    }
                    if (!expectedFileName || isNewOrChangedDialog) return true;
                    for (
                      let current = control;
                      current && current !== root.parentElement;
                      current = current.parentElement
                    ) {
                      if (abwNormalizeFileName(current.textContent).includes(expectedFileName)) {
                        return true;
                      }
                      if (current === root) break;
                    }
                    return false;
                  });
                if (download) {
                  abwStopPreviewDownloadObserver();
                  abwExpectingDownloadUntil = Date.now() + 5000;
                  download.click();
                  return true;
                }
              }
              return false;
            };
            if (inspectDialogs() || !document.body) return;
            abwPreviewDownloadObserver = new MutationObserver(() => {
              if (abwPreviewDownloadCheckScheduled) return;
              abwPreviewDownloadCheckScheduled = window.setTimeout(() => {
                inspectDialogs();
              }, 80);
            });
            abwPreviewDownloadObserver.observe(document.body, { childList: true, subtree: true });
            abwPreviewDownloadTimeout = window.setTimeout(abwStopPreviewDownloadObserver, 15000);
          };
          const abwKeepDownloadsInWebview = (event) => {
            const target = event.target instanceof Element ? event.target : null;
            const control = target?.closest?.('a, button, [role="button"], [role="link"]');
            if (!control) return;
            const label = abwControlLabel(control);
            const link = control.closest?.('a') || control.querySelector?.('a');
            if (abwDownloadWord.test(label) || abwLooksLikeDownloadUrl(link?.href)) {
              abwExpectingDownloadUntil = Date.now() + 5000;
              if (link) {
                link.removeAttribute("target");
                link.setAttribute("download", "");
              }
              return;
            }
            const fileName = abwFindSupportedFileName(target) || abwFindSupportedFileName(control);
            if (fileName) {
              abwQueuePreviewDownload(fileName);
            }
          };
          const abwPatchWindowOpen = () => {
            if (window.__abwNativeOpen) return;
            window.__abwNativeOpen = window.open.bind(window);
            window.open = (url, target, features) => {
              if (Date.now() < abwExpectingDownloadUntil || abwLooksLikeDownloadUrl(url)) {
                abwExpectingDownloadUntil = 0;
                const link = document.createElement("a");
                link.href = String(url);
                link.download = "";
                link.style.display = "none";
                document.body.append(link);
                link.click();
                link.remove();
                return null;
              }
              return window.__abwNativeOpen(url, target, features);
            };
          };
          const abwSendShortcut = (action, index = null) => {
            const query = index !== null ? `&index=${index}` : "";
            window.location.href = `abw-shortcut://trigger?action=${encodeURIComponent(action)}${query}`;
          };
          const abwHandleKeyboardShortcuts = (event) => {
            if (event.isComposing || event.metaKey || event.altKey || !event.ctrlKey) {
              return;
            }
            const key = event.key.toLowerCase();
            if (key === "t" && !event.shiftKey) {
              event.preventDefault();
              abwSendShortcut("new-tab");
            } else if (key === "w" && !event.shiftKey) {
              event.preventDefault();
              abwSendShortcut("close-tab");
            } else if (event.key === "Tab") {
              event.preventDefault();
              abwSendShortcut(event.shiftKey ? "prev-tab" : "next-tab");
            } else if (event.key === "\\" && !event.shiftKey) {
              event.preventDefault();
              abwSendShortcut("toggle-split");
            } else if (!event.shiftKey && /^[1-9]$/.test(event.key)) {
              event.preventDefault();
              abwSendShortcut("select-tab", Number(event.key));
            }
          };
          const abwOpenLinkInNewTab = (event) => {
            const isMiddleClick = event.type === "auxclick" && event.button === 1;
            const isModifiedPrimary =
              event.type === "click" &&
              event.button === 0 &&
              (event.ctrlKey || event.metaKey) &&
              !event.altKey;
            if (!isMiddleClick && !isModifiedPrimary) return;
            const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
            const rawHref = anchor?.getAttribute("href");
            if (!anchor || !rawHref || rawHref.startsWith("#")) return;
            let resolved;
            try {
              resolved = new URL(anchor.href, window.location.href);
            } catch {
              return;
            }
            const isWrikeHost =
              resolved.protocol === "https:" &&
              (resolved.hostname === "wrike.com" || resolved.hostname.endsWith(".wrike.com"));
            if (!isWrikeHost || anchor.hasAttribute("download") || abwLooksLikeDownloadUrl(resolved.href)) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            window.location.href = `abw-shortcut://trigger?action=open-url&url=${encodeURIComponent(resolved.href)}`;
          };
          const start = () => {
            applyAll();
            let observer = null;
            if (enabled && document.body) {
              observer = new MutationObserver(scheduleApply);
              observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['contenteditable', 'role'],
              });
            }
            document.addEventListener('focusin', applyEditableFocus, true);
            window.__abwSpellCleanup = () => {
              if (abwSpellApplyTimer) {
                if (abwSpellApplyIdle && typeof window.cancelIdleCallback === "function") {
                  window.cancelIdleCallback(abwSpellApplyTimer);
                } else {
                  window.clearTimeout(abwSpellApplyTimer);
                }
                abwSpellApplyTimer = 0;
                abwSpellApplyIdle = false;
              }
              pendingSpellRoots.clear();
              observer?.disconnect();
              document.removeEventListener('focusin', applyEditableFocus, true);
              abwStopPreviewDownloadObserver();
            };
            if (!window.__abwContextMenuGuard) {
              document.addEventListener('contextmenu', keepWrikeEditorToolsVisible, true);
              window.__abwContextMenuGuard = true;
            }
            if (!window.__abwDownloadBridge) {
              document.addEventListener("click", abwKeepDownloadsInWebview, true);
              document.addEventListener("click", abwOpenLinkInNewTab, true);
              document.addEventListener("auxclick", abwOpenLinkInNewTab, true);
              abwPatchWindowOpen();
              window.__abwDownloadBridge = true;
            }
            if (!window.__abwShortcutBridge) {
              document.addEventListener("keydown", abwHandleKeyboardShortcuts, true);
              window.__abwShortcutBridge = true;
            }
            if (abwAutoDownload) {
              window.setTimeout(() => {
                const pageIdentity = `${document.title} ${window.location.href}`;
                if (abwLooksLikeDownloadUrl(pageIdentity) || abwSupportedFileName.test(pageIdentity)) {
                  const match = pageIdentity.match(abwSupportedFileName);
                  abwQueuePreviewDownload(match?.[0] || "");
                }
              }, 400);
            }
          };
          if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
        })();
        "##
            .replace("__ABW_SPELL_CHECK_ENABLED__", enabled_literal)
            .replace("__ABW_AUTO_DOWNLOAD__", auto_download_literal)
        })
        .as_str()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main_window(app)
        }))
        .manage(AppState::default())
        .manage(updater::PendingUpdateState::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            trace_native_event(app.handle(), "setup");
            let show_item = MenuItem::with_id(app, "show", "Show ABW", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit ABW", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("ABW")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => request_quit(app, true),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            updater::check_for_update,
            clear_unpinned_downloads,
            close_wrike_tab,
            delete_download,
            downloads_storage_stats,
            focus_wrike_tab,
            get_wrike_session,
            get_wrike_tab_state,
            get_settings,
            hide_wrike_tabs,
            updater::install_update,
            launch_wrike,
            list_downloads,
            open_download,
            open_source_task,
            preview_spreadsheet,
            read_download,
            read_download_head,
            read_download_range,
            resize_wrike_tabs,
            reveal_download,
            send_test_notification,
            storage_health,
            update_last_wrike_session,
            update_settings,
            wrike_tab_action
        ])
        .build(tauri::generate_context!())
        .expect("error while building ABW")
        .run(|app, event| {
            if let tauri::RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } = event
            {
                trace_native_event(app, &format!("native close label={label}"));
                if label == "main" {
                    api.prevent_close();
                    request_quit(app, false);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_kind_classifies_supported_extensions() {
        assert_eq!(file_kind("pdf"), "pdf");
        for ext in ["xls", "xlsx", "xlsm", "xlsb", "ods", "csv", "tsv"] {
            assert_eq!(
                file_kind(ext),
                "spreadsheet",
                "expected spreadsheet for {ext}"
            );
        }
        for ext in ["doc", "docx", "rtf", "txt"] {
            assert_eq!(file_kind(ext), "document", "expected document for {ext}");
        }
        assert_eq!(file_kind("png"), "other");
        assert_eq!(file_kind(""), "other");
    }

    #[test]
    fn navigation_history_tracks_back_forward_and_truncates_on_branch() {
        let mut history = NavigationHistory::new("https://www.wrike.com/workspace.htm");
        assert!(!history.can_go_back());
        assert!(!history.can_go_forward());

        history.record("https://www.wrike.com/workspace.htm#a");
        history.record("https://www.wrike.com/workspace.htm#b");
        assert!(history.can_go_back());
        assert!(!history.can_go_forward());

        history.record("https://www.wrike.com/workspace.htm#a");
        assert!(history.can_go_back());
        assert!(history.can_go_forward());

        history.record("https://www.wrike.com/workspace.htm#c");
        assert!(history.can_go_back());
        assert!(!history.can_go_forward());
        assert_eq!(
            history.entries,
            vec![
                "https://www.wrike.com/workspace.htm",
                "https://www.wrike.com/workspace.htm#a",
                "https://www.wrike.com/workspace.htm#c",
            ]
        );
    }

    #[test]
    fn clean_wrike_title_strips_wrike_suffixes() {
        assert_eq!(clean_wrike_title("Q3 Budget - Wrike"), "Q3 Budget");
        assert_eq!(clean_wrike_title("Inbox | Wrike"), "Inbox");
        assert_eq!(clean_wrike_title("  My Task  "), "My Task");
    }

    #[test]
    fn normalize_dictionary_deduplicates_case_insensitively_and_trims() {
        let normalized = normalize_dictionary(vec![
            "  Wrike ".into(),
            "wrike".into(),
            "\"O'Neill\"".into(),
            "follow-up!".into(),
            "   ".into(),
        ]);
        assert_eq!(normalized, vec!["follow-up", "O'Neill", "Wrike"]);
    }

    #[test]
    fn normalize_startup_tab_urls_filters_unsafe_schemes_and_falls_back() {
        assert_eq!(
            normalize_startup_tab_urls(vec![
                "wrike.com".into(),
                "https://wrike.com/".into(),
                "javascript:alert(1)".into(),
                "file:///C:/secret.txt".into(),
            ]),
            vec!["https://wrike.com/"]
        );
        assert_eq!(
            normalize_startup_tab_urls(vec!["   ".into(), "javascript:void(0)".into()]),
            vec![WRIKE_HOME]
        );
    }

    #[test]
    fn normalize_wrike_session_validates_tabs_active_id_and_split() {
        let normalized = normalize_wrike_session(WrikeSession {
            tabs: vec![
                WrikeSessionTab {
                    id: "  ".into(),
                    title: "Empty".into(),
                    url: Some("https://www.wrike.com/".into()),
                    mode: "standard".into(),
                },
                WrikeSessionTab {
                    id: " t1 ".into(),
                    title: " Home ".into(),
                    url: Some("javascript:bad".into()),
                    mode: "readOnly".into(),
                },
                WrikeSessionTab {
                    id: "t2".into(),
                    title: "Tasks".into(),
                    url: Some("wrike.com/tasks".into()),
                    mode: "other".into(),
                },
            ],
            active_tab_id: "missing".into(),
            split: Some(WrikeSessionSplit {
                left_tab_id: "t1".into(),
                right_tab_id: "t1".into(),
            }),
            saved_at: "2026-11-14T00:00:00Z".into(),
        });

        assert_eq!(normalized.tabs.len(), 2);
        assert_eq!(normalized.tabs[0].id, "t1");
        assert_eq!(normalized.tabs[0].url.as_deref(), Some(WRIKE_HOME));
        assert_eq!(normalized.tabs[0].mode, "readOnly");
        assert_eq!(
            normalized.tabs[1].url.as_deref(),
            Some("https://wrike.com/tasks")
        );
        assert_eq!(normalized.tabs[1].mode, "standard");
        assert_eq!(normalized.active_tab_id, "t1");
        assert!(normalized.split.is_none());
    }
}
