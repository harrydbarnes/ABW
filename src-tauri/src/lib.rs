pub mod po_bridge;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, RwLock},
};
use tauri::{
    ipc::Response,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{
        DownloadEvent, NewWindowResponse, PageLoadEvent, Webview, WebviewBuilder,
        WebviewWindowBuilder,
    },
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
    State, WebviewUrl, WindowEvent,
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
            persistence::health::<WorkspaceState>(&workspace_state_path(&app)?),
            persistence::health::<Vec<DownloadRecord>>(&records_path(&app)?),
        ]
        .into_iter()
        .flatten()
        .collect())
    })
    .await
    .map_err(|error| format!("Unable to inspect storage health: {error}"))?
}

const WRIKE_HOME: &str = "https://www.wrike.com/workspace.htm";
const MAX_PDF_PREVIEW_BYTES: u64 = 128 * 1024 * 1024;
const MAX_IMAGE_PREVIEW_BYTES: u64 = 32 * 1024 * 1024;
const PDF_HEAD_CHUNK_BYTES: u64 = 131_072;
const PDF_INLINE_THRESHOLD_BYTES: u64 = 512 * 1024;
const MAX_PDF_RANGE_BYTES: u64 = 8 * 1024 * 1024;
const TASKBAR_HEIGHT: f64 = 50.0;
const WRIKE_SPLIT_GAP: f64 = 8.0;
const TRAY_ICON_ID: &str = "abw-tray";

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
    #[serde(default)]
    previewed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FavoriteTicket {
    id: String,
    title: String,
    url: String,
    #[serde(default)]
    client: Option<String>,
    #[serde(default)]
    details: Option<String>,
    added_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct VisitHistoryEntry {
    id: String,
    title: String,
    url: String,
    #[serde(default)]
    client: Option<String>,
    #[serde(default)]
    details: Option<String>,
    last_visited_at: String,
    visit_count: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WindowBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct WorkspaceState {
    pinned_download_ids: Vec<String>,
    favorite_tickets: Vec<FavoriteTicket>,
    visit_history: Vec<VisitHistoryEntry>,
    last_wrike_session: Option<WrikeSession>,
    window_bounds: Option<WindowBounds>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    spell_check: bool,
    #[serde(default)]
    show_spell_check_in_topbar: bool,
    launch_wrike_on_start: bool,
    #[serde(default = "default_true")]
    show_launch_splash: bool,
    download_notifications: bool,
    open_abw_at_system_startup: bool,
    #[serde(default)]
    start_minimized_to_tray: bool,
    #[serde(default)]
    close_to_notification_area: bool,
    #[serde(default = "default_true")]
    suspend_tabs_on_tray_hide: bool,
    confirm_before_closing_tabs: bool,
    open_downloaded_files_automatically: bool,
    #[serde(default = "default_true")]
    open_external_links_in_browser: bool,
    #[serde(default = "default_true")]
    auto_check_for_updates: bool,
    #[serde(default = "default_true")]
    auto_match_wrike_theme: bool,
    #[serde(default)]
    suspend_inactive_tabs_minutes: u32,
    #[serde(default = "default_true")]
    custom_context_menu: bool,
    #[serde(default = "default_true")]
    use_native_wrike_image_viewer: bool,
    #[serde(default = "default_theme")]
    theme: String,
    custom_dictionary: Vec<String>,
    #[serde(default = "default_startup_tab_urls")]
    startup_tab_urls: Vec<String>,
    #[serde(default)]
    pinned_download_ids: Vec<String>,
    #[serde(default)]
    favorite_tickets: Vec<FavoriteTicket>,
    #[serde(default)]
    visit_history: Vec<VisitHistoryEntry>,
    #[serde(default)]
    last_wrike_session: Option<WrikeSession>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WrikeSessionTab {
    id: String,
    title: String,
    url: Option<String>,
    mode: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WrikeSessionSplit {
    left_tab_id: String,
    right_tab_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
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
            show_spell_check_in_topbar: false,
            launch_wrike_on_start: true,
            show_launch_splash: true,
            download_notifications: true,
            open_abw_at_system_startup: false,
            start_minimized_to_tray: false,
            close_to_notification_area: true,
            suspend_tabs_on_tray_hide: true,
            confirm_before_closing_tabs: false,
            open_downloaded_files_automatically: false,
            open_external_links_in_browser: true,
            auto_check_for_updates: true,
            auto_match_wrike_theme: true,
            suspend_inactive_tabs_minutes: 0,
            custom_context_menu: true,
            use_native_wrike_image_viewer: true,
            theme: "default".to_owned(),
            custom_dictionary: Vec::new(),
            startup_tab_urls: default_startup_tab_urls(),
            pinned_download_ids: Vec::new(),
            favorite_tickets: Vec::new(),
            visit_history: Vec::new(),
            last_wrike_session: None,
        }
    }
}

impl Settings {
    fn preferences_only(&self) -> Self {
        Self {
            pinned_download_ids: Vec::new(),
            favorite_tickets: Vec::new(),
            visit_history: Vec::new(),
            last_wrike_session: None,
            ..self.clone()
        }
    }

    fn preferences_equal(&self, other: &Self) -> bool {
        self.spell_check == other.spell_check
            && self.show_spell_check_in_topbar == other.show_spell_check_in_topbar
            && self.launch_wrike_on_start == other.launch_wrike_on_start
            && self.show_launch_splash == other.show_launch_splash
            && self.download_notifications == other.download_notifications
            && self.open_abw_at_system_startup == other.open_abw_at_system_startup
            && self.start_minimized_to_tray == other.start_minimized_to_tray
            && self.close_to_notification_area == other.close_to_notification_area
            && self.suspend_tabs_on_tray_hide == other.suspend_tabs_on_tray_hide
            && self.confirm_before_closing_tabs == other.confirm_before_closing_tabs
            && self.open_downloaded_files_automatically == other.open_downloaded_files_automatically
            && self.open_external_links_in_browser == other.open_external_links_in_browser
            && self.auto_check_for_updates == other.auto_check_for_updates
            && self.auto_match_wrike_theme == other.auto_match_wrike_theme
            && self.suspend_inactive_tabs_minutes == other.suspend_inactive_tabs_minutes
            && self.custom_context_menu == other.custom_context_menu
            && self.use_native_wrike_image_viewer == other.use_native_wrike_image_viewer
            && self.theme == other.theme
            && self.custom_dictionary == other.custom_dictionary
            && self.startup_tab_urls == other.startup_tab_urls
    }

    fn merge_workspace_state(&mut self, state: &WorkspaceState) {
        self.pinned_download_ids = state.pinned_download_ids.clone();
        self.favorite_tickets = state.favorite_tickets.clone();
        self.visit_history = state.visit_history.clone();
        self.last_wrike_session = state.last_wrike_session.clone();
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

#[derive(Clone, Copy, PartialEq, Eq)]
struct SettingsFileStamp {
    modified: Option<std::time::SystemTime>,
    len: u64,
}

struct AppState {
    wrike_tabs: Mutex<HashMap<String, Arc<CaptureContext>>>,
    suspended_tabs: Mutex<HashSet<String>>,
    visible_wrike_tabs: Mutex<HashSet<String>>,
    tracked_paths: Mutex<HashMap<String, PathBuf>>,
    detected_wrike_theme: Mutex<Option<String>>,
    preview_intent_until: Mutex<Option<std::time::Instant>>,
    pending_deep_link: Mutex<Option<String>>,
    cached_settings: RwLock<Option<(Settings, Option<SettingsFileStamp>)>>,
    top_inset: Mutex<f64>,
    wrike_split_ratio: Mutex<f64>,
    quit_prompt_open: AtomicBool,
    main_window_hidden: AtomicBool,
    wrike_inbox_unread: AtomicBool,
    update_available_badge: AtomicBool,
    open_external_links_in_browser: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            wrike_tabs: Mutex::new(HashMap::new()),
            suspended_tabs: Mutex::new(HashSet::new()),
            visible_wrike_tabs: Mutex::new(HashSet::new()),
            tracked_paths: Mutex::new(HashMap::new()),
            detected_wrike_theme: Mutex::new(None),
            preview_intent_until: Mutex::new(None),
            pending_deep_link: Mutex::new(None),
            cached_settings: RwLock::new(None),
            top_inset: Mutex::new(0.0),
            wrike_split_ratio: Mutex::new(0.5),
            quit_prompt_open: AtomicBool::new(false),
            main_window_hidden: AtomicBool::new(false),
            wrike_inbox_unread: AtomicBool::new(false),
            update_available_badge: AtomicBool::new(false),
            open_external_links_in_browser: AtomicBool::new(true),
        }
    }
}

#[derive(Default)]
struct CaptureContext {
    tab_id: String,
    pending: Mutex<HashMap<PathBuf, PendingDownload>>,
    page_title: Mutex<String>,
    active_task_title: Mutex<Option<String>>,
    page_url: Mutex<Option<String>>,
    detected_theme: Mutex<Option<String>>,
    history: Mutex<NavigationHistory>,
    is_title_loading: Mutex<bool>,
}

impl CaptureContext {
    fn new(tab_id: &str, url: &str) -> Self {
        Self {
            tab_id: tab_id.to_owned(),
            pending: Mutex::new(HashMap::new()),
            page_title: Mutex::new(String::new()),
            active_task_title: Mutex::new(None),
            page_url: Mutex::new(Some(url.to_owned())),
            detected_theme: Mutex::new(None),
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
        if self.entries.get(self.position).map(String::as_str) == Some(url) {
            return;
        }
        if self.position > 0 && self.entries.get(self.position - 1).map(String::as_str) == Some(url)
        {
            self.position -= 1;
            return;
        }
        if self.entries.get(self.position + 1).map(String::as_str) == Some(url) {
            self.position += 1;
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
        let tail_offset = if size <= PDF_INLINE_THRESHOLD_BYTES {
            size
        } else {
            size.saturating_sub(PDF_HEAD_CHUNK_BYTES)
                .max(head_len as u64)
        };
        let tail_len = size.saturating_sub(tail_offset) as usize;
        let mut out = Vec::with_capacity(20 + head_len + tail_len);
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&(head_len as u32).to_le_bytes());
        out.extend_from_slice(&tail_offset.to_le_bytes());
        out.resize(20 + head_len + tail_len, 0);
        file.read_exact(&mut out[20..20 + head_len])
            .map_err(|error| format!("Unable to read PDF header: {error}"))?;
        if tail_len > 0 {
            file.seek(SeekFrom::Start(tail_offset))
                .map_err(|error| format!("Unable to seek PDF trailer: {error}"))?;
            file.read_exact(&mut out[20 + head_len..])
                .map_err(|error| format!("Unable to read PDF trailer: {error}"))?;
        }
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
async fn read_download_image(app: AppHandle, id: String) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, mut file) = open_tracked_file(&app, &id)?;
        let size = file
            .metadata()
            .map_err(|error| format!("Unable to inspect download: {error}"))?
            .len();
        if size > MAX_IMAGE_PREVIEW_BYTES {
            return Err(format!(
                "This image is {} MB. In-app image preview currently supports files up to 32 MB; open it in Windows instead.",
                size.div_ceil(1024 * 1024)
            ));
        }
        let mut buf = Vec::with_capacity(size as usize);
        file.read_to_end(&mut buf)
            .map_err(|error| format!("Unable to read image file: {error}"))?;
        Ok(Response::new(buf))
    })
    .await
    .map_err(|error| format!("Unable to read image download: {error}"))?
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
async fn load_spreadsheet_sheet(
    app: AppHandle,
    id: String,
    sheet_index: usize,
) -> Result<spreadsheet::WorkbookSheet, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_tracked_path(&app, &id)?;
        match spreadsheet::load_sheet(&path, sheet_index) {
            Err(_) if !path.exists() => {
                invalidate_tracked_paths(&app, Some(&id));
                let refreshed = resolve_tracked_path(&app, &id)?;
                spreadsheet::load_sheet(&refreshed, sheet_index)
            }
            result => result,
        }
    })
    .await
    .map_err(|error| format!("Unable to load spreadsheet worksheet: {error}"))?
}

#[tauri::command]
async fn load_spreadsheet_images(
    app: AppHandle,
    id: String,
    sheet_index: usize,
) -> Result<Vec<spreadsheet::WorkbookImage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_tracked_path(&app, &id)?;
        match spreadsheet::load_sheet_images(&path, sheet_index) {
            Err(_) if !path.exists() => {
                invalidate_tracked_paths(&app, Some(&id));
                let refreshed = resolve_tracked_path(&app, &id)?;
                spreadsheet::load_sheet_images(&refreshed, sheet_index)
            }
            result => result,
        }
    })
    .await
    .map_err(|error| format!("Unable to load spreadsheet images: {error}"))?
}

#[tauri::command]
fn open_download(app: AppHandle, id: String) -> Result<(), String> {
    let path = resolve_tracked_path(&app, &id)?;
    open::that(path).map_err(|error| format!("Unable to open file in Windows: {error}"))
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

        let existing_records = read_records(&app)?;
        let mut freed_bytes = 0_u64;
        let mut removed_ids = HashSet::new();
        let mut locked_error: Option<String> = None;

        for record in &existing_records {
            let disk_path = root
                .join(&record.file_name)
                .canonicalize()
                .ok()
                .filter(|resolved| resolved.starts_with(&root));
            if pinned.contains(&record.id) && disk_path.is_some() {
                continue;
            }
            if let Some(resolved) = disk_path {
                let actual_size = fs::metadata(&resolved)
                    .map(|meta| meta.len())
                    .unwrap_or(record.size_bytes);
                match fs::remove_file(&resolved) {
                    Ok(()) => {
                        freed_bytes = freed_bytes.saturating_add(actual_size);
                        removed_ids.insert(record.id.clone());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        removed_ids.insert(record.id.clone());
                    }
                    Err(error) => {
                        if locked_error.is_none() {
                            locked_error =
                                Some(format!("Unable to remove {}: {error}", record.file_name));
                        }
                    }
                }
            } else {
                removed_ids.insert(record.id.clone());
            }
        }

        for id in &removed_ids {
            invalidate_tracked_paths(&app, Some(id));
        }

        let (kept_records, _) =
            persistence::update::<Vec<DownloadRecord>, _>(&records_path(&app)?, |records| {
                records.retain(|record| !removed_ids.contains(&record.id));
                Ok(())
            })?;

        let kept_ids: HashSet<&str> = kept_records.iter().map(|r| r.id.as_str()).collect();
        let (_, pins_changed) =
            persistence::update::<WorkspaceState, _>(&workspace_state_path(&app)?, |workspace| {
                let before = workspace.pinned_download_ids.len();
                workspace
                    .pinned_download_ids
                    .retain(|pinned_id| kept_ids.contains(pinned_id.as_str()));
                Ok(workspace.pinned_download_ids.len() != before)
            })?;
        if pins_changed {
            if let Ok(updated_settings) = refresh_cached_settings(&app) {
                let _ = app.emit("settings-updated", updated_settings);
            }
        }
        let removed_count = removed_ids.len();
        app.emit("downloads-updated", ())
            .map_err(|error| format!("Unable to refresh Files view: {error}"))?;
        for removed_id in removed_ids {
            let _ = app.emit("download-deleted", removed_id);
        }
        if let Some(error) = locked_error {
            if removed_count == 0 {
                return Err(error);
            }
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
async fn open_downloads_folder(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = downloads_dir(&app)?;
        open::that(dir).map_err(|error| format!("Unable to open downloads folder: {error}"))
    })
    .await
    .map_err(|error| format!("Unable to open downloads folder: {error}"))?
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
        let records = read_records(&app)?;
        let target = records
            .into_iter()
            .find(|record| record.id == id)
            .ok_or_else(|| "This download is no longer in the Files library.".to_owned())?;

        if let Ok(root) = downloads_dir(&app)?.canonicalize() {
            if let Some(resolved) = root
                .join(&target.file_name)
                .canonicalize()
                .ok()
                .filter(|resolved| resolved.starts_with(&root))
            {
                match fs::remove_file(&resolved) {
                    Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                        return Err(format!(
                            "Unable to remove downloaded file (close it if open in another app): {error}"
                        ));
                    }
                    _ => {}
                }
            }
        }

        invalidate_tracked_paths(&app, Some(&id));
        persistence::update::<Vec<DownloadRecord>, _>(&records_path(&app)?, |stored| {
            stored.retain(|record| record.id != id);
            Ok(())
        })?;

        let (_, had_pin) = persistence::update::<WorkspaceState, _>(
            &workspace_state_path(&app)?,
            |workspace| {
                let before = workspace.pinned_download_ids.len();
                workspace
                    .pinned_download_ids
                    .retain(|pinned_id| pinned_id != &id);
                Ok(workspace.pinned_download_ids.len() != before)
            },
        )?;
        if had_pin {
            if let Ok(settings) = refresh_cached_settings(&app) {
                let _ = app.emit("settings-updated", settings);
            }
        }
        app.emit("downloads-updated", ())
            .map_err(|error| format!("Unable to refresh Files view: {error}"))?;
        app.emit("download-deleted", id)
            .map_err(|error| format!("Unable to update deleted download state: {error}"))
    })
    .await
    .map_err(|error| format!("Unable to remove download: {error}"))?
}

fn broadcast_to_wrike_webviews(app: &AppHandle, state: &AppState, script: &str) {
    let tab_ids = state
        .wrike_tabs
        .lock()
        .map(|tabs| tabs.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_else(|_| vec!["home".to_owned()]);
    for tab_id in tab_ids {
        if let Ok(label) = wrike_tab_label(&tab_id) {
            if let Some(webview) = app.get_webview(&label) {
                let _ = webview.eval(script);
            }
        }
    }
    for (label, webview) in app.webviews() {
        if label.starts_with("wrike-popup-") {
            let _ = webview.eval(script);
        }
    }
}

#[tauri::command]
async fn get_settings(app: AppHandle) -> Result<Settings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = refresh_cached_settings(&app)?;
        if let Some(state) = app.try_state::<AppState>() {
            state
                .open_external_links_in_browser
                .store(settings.open_external_links_in_browser, Ordering::Relaxed);
        }
        Ok(settings)
    })
    .await
    .map_err(|error| format!("Unable to load settings: {error}"))?
}

#[tauri::command]
async fn update_settings(app: AppHandle, mut settings: Settings) -> Result<Settings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        settings.custom_dictionary = normalize_dictionary(settings.custom_dictionary);
        settings.startup_tab_urls = normalize_startup_tab_urls(settings.startup_tab_urls);
        settings.pinned_download_ids = normalize_string_ids(settings.pinned_download_ids);
        if settings.theme.trim().is_empty() {
            settings.theme = default_theme();
        }
        let state = app.state::<AppState>();
        let detected_theme = state
            .detected_wrike_theme
            .lock()
            .ok()
            .and_then(|theme| theme.clone());
        let previous = get_cached_settings(&app)?;
        if settings.auto_match_wrike_theme && !previous.auto_match_wrike_theme {
            if let Some(detected) = detected_theme.as_ref() {
                settings.theme = detected.clone();
            }
        }
        settings.last_wrike_session = previous.last_wrike_session.clone();

        let startup_changed = settings.open_abw_at_system_startup != startup::enabled()?
            || (settings.open_abw_at_system_startup
                && settings.start_minimized_to_tray != previous.start_minimized_to_tray);
        if startup_changed {
            startup::set_enabled(
                settings.open_abw_at_system_startup,
                settings.start_minimized_to_tray,
            )?;
        }

        if !settings.preferences_equal(&previous) || !settings_path(&app)?.exists() {
            let prefs_only = settings.preferences_only();
            persistence::update::<Settings, _>(&settings_path(&app)?, |stored| {
                *stored = prefs_only;
                Ok(())
            })?;
        }

        let workspace_changed = settings.pinned_download_ids != previous.pinned_download_ids
            || settings.favorite_tickets != previous.favorite_tickets
            || settings.visit_history != previous.visit_history;
        if workspace_changed {
            let pins = settings.pinned_download_ids.clone();
            let favorites = settings.favorite_tickets.clone();
            let history = settings.visit_history.clone();
            persistence::update::<WorkspaceState, _>(&workspace_state_path(&app)?, |workspace| {
                workspace.pinned_download_ids = pins;
                workspace.favorite_tickets = favorites;
                workspace.visit_history = history;
                Ok(())
            })?;
        }

        store_cached_settings(&app, &settings);
        state
            .open_external_links_in_browser
            .store(settings.open_external_links_in_browser, Ordering::Relaxed);
        if previous.custom_dictionary != settings.custom_dictionary {
            sync_windows_spelling_dictionary(
                &previous.custom_dictionary,
                &settings.custom_dictionary,
            );
        }
        if previous.spell_check != settings.spell_check {
            let toggle_script = if settings.spell_check {
                "window.__abwSetSpellCheck?.(true);"
            } else {
                "window.__abwSetSpellCheck?.(false);"
            };
            broadcast_to_wrike_webviews(&app, state.inner(), toggle_script);
        }
        if previous.custom_context_menu != settings.custom_context_menu {
            let context_script = if settings.custom_context_menu {
                "window.__abwCustomContextMenuEnabled = true;"
            } else {
                "window.__abwCustomContextMenuEnabled = false;"
            };
            broadcast_to_wrike_webviews(&app, state.inner(), context_script);
        }
        if previous.use_native_wrike_image_viewer != settings.use_native_wrike_image_viewer {
            let image_viewer_script = if settings.use_native_wrike_image_viewer {
                "window.__abwUseNativeWrikeImageViewer = true;"
            } else {
                "window.__abwUseNativeWrikeImageViewer = false;"
            };
            broadcast_to_wrike_webviews(&app, state.inner(), image_viewer_script);
        }
        if settings.auto_match_wrike_theme && !previous.auto_match_wrike_theme {
            broadcast_to_wrike_webviews(
                &app,
                state.inner(),
                "window.__abwDetectWrikeTheme?.(true);",
            );
        }
        app.emit("settings-updated", settings.clone())
            .map_err(|error| format!("Unable to refresh settings: {error}"))?;
        Ok(settings)
    })
    .await
    .map_err(|error| format!("Unable to save settings: {error}"))?
}

#[tauri::command]
async fn update_last_wrike_session(app: AppHandle, session: WrikeSession) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let normalized = normalize_wrike_session(session);
        persistence::update::<WorkspaceState, _>(&workspace_state_path(&app)?, |workspace| {
            workspace.last_wrike_session = Some(normalized.clone());
            Ok(())
        })?;
        if let Some(state) = app.try_state::<AppState>() {
            if let Ok(mut cached) = state.cached_settings.write() {
                if let Some((settings, _)) = cached.as_mut() {
                    settings.last_wrike_session = Some(normalized);
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("Unable to save Wrike session: {error}"))?
}

#[tauri::command]
async fn reset_app(app: AppHandle) -> Result<Settings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let previous = get_cached_settings(&app).unwrap_or_default();
        let defaults = Settings::default();
        if startup::enabled()? != defaults.open_abw_at_system_startup {
            let _ = startup::set_enabled(
                defaults.open_abw_at_system_startup,
                defaults.start_minimized_to_tray,
            );
        }
        let prefs_only = defaults.preferences_only();
        persistence::update::<Settings, _>(&settings_path(&app)?, |stored| {
            *stored = prefs_only;
            Ok(())
        })?;
        persistence::update::<WorkspaceState, _>(&workspace_state_path(&app)?, |workspace| {
            *workspace = WorkspaceState::default();
            Ok(())
        })?;
        store_cached_settings(&app, &defaults);
        let state = app.state::<AppState>();
        state
            .open_external_links_in_browser
            .store(defaults.open_external_links_in_browser, Ordering::Relaxed);
        if !previous.custom_dictionary.is_empty() {
            sync_windows_spelling_dictionary(
                &previous.custom_dictionary,
                &defaults.custom_dictionary,
            );
        }
        let spell_script = if defaults.spell_check {
            "window.__abwSetSpellCheck?.(true);"
        } else {
            "window.__abwSetSpellCheck?.(false);"
        };
        let context_script = if defaults.custom_context_menu {
            "window.__abwCustomContextMenuEnabled = true;"
        } else {
            "window.__abwCustomContextMenuEnabled = false;"
        };
        let image_viewer_script = if defaults.use_native_wrike_image_viewer {
            "window.__abwUseNativeWrikeImageViewer = true;"
        } else {
            "window.__abwUseNativeWrikeImageViewer = false;"
        };
        broadcast_to_wrike_webviews(&app, state.inner(), spell_script);
        broadcast_to_wrike_webviews(&app, state.inner(), context_script);
        broadcast_to_wrike_webviews(&app, state.inner(), image_viewer_script);
        app.emit("settings-updated", defaults.clone())
            .map_err(|error| format!("Unable to refresh settings: {error}"))?;
        Ok(defaults)
    })
    .await
    .map_err(|error| format!("Unable to reset ABW: {error}"))?
}

fn parse_wrike_deep_link(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = match trimmed.split_once("://") {
        Some((scheme, destination)) if scheme.eq_ignore_ascii_case("wrikeapp") => {
            format!("https://{destination}")
        }
        _ => trimmed.to_owned(),
    };
    let parsed = Url::parse(&normalized).ok()?;
    (is_https_wrike_url(&parsed)
        && (parsed.path() == "/open.htm" || parsed.path().ends_with("/workspace.htm")))
    .then(|| parsed.to_string())
}

#[tauri::command]
fn take_pending_deep_link(state: State<'_, AppState>) -> Option<String> {
    state
        .pending_deep_link
        .lock()
        .ok()
        .and_then(|mut guard| guard.take())
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
fn notify_update_available(app: AppHandle, version: String) -> Result<(), String> {
    let clean_version = version.trim().trim_start_matches('v');
    let body = if clean_version.is_empty() {
        "A new version of ABW is ready to install.".to_owned()
    } else {
        format!("ABW v{clean_version} is ready to install. Open ABW to update.")
    };
    app.notification()
        .builder()
        .title("ABW update available")
        .body(&body)
        .show()
        .map_err(|error| format!("Unable to display a Windows notification: {error}"))
}

#[cfg(target_os = "windows")]
fn badged_window_icon(base: &tauri::image::Image<'_>) -> tauri::image::Image<'static> {
    let width = base.width();
    let height = base.height();
    let mut rgba = base.rgba().to_vec();
    let min_dim = width.min(height) as f32;
    let outer_radius = (min_dim * 0.21).max(3.5);
    let inner_radius = (min_dim * 0.16).max(2.5);
    let cx = width as f32 - outer_radius - (min_dim * 0.03);
    let cy = outer_radius + (min_dim * 0.03);
    for y in 0..height {
        for x in 0..width {
            let dist = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
            let offset = ((y * width + x) * 4) as usize;
            if dist <= inner_radius {
                rgba[offset] = 34;
                rgba[offset + 1] = 211;
                rgba[offset + 2] = 238;
                rgba[offset + 3] = 255;
            } else if dist <= outer_radius {
                rgba[offset] = 8;
                rgba[offset + 1] = 47;
                rgba[offset + 2] = 73;
                rgba[offset + 3] = 245;
            }
        }
    }
    tauri::image::Image::new_owned(rgba, width, height)
}

#[cfg(target_os = "windows")]
fn taskbar_overlay_badge_icon() -> tauri::image::Image<'static> {
    const SIZE: u32 = 16;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    let center = (SIZE as f32 - 1.0) / 2.0;
    let outer_radius = 7.2_f32;
    let inner_radius = 5.4_f32;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dist = ((x as f32 - center).powi(2) + (y as f32 - center).powi(2)).sqrt();
            let offset = ((y * SIZE + x) * 4) as usize;
            if dist <= inner_radius {
                rgba[offset] = 34;
                rgba[offset + 1] = 211;
                rgba[offset + 2] = 238;
                rgba[offset + 3] = 255;
            } else if dist <= outer_radius {
                rgba[offset] = 8;
                rgba[offset + 1] = 47;
                rgba[offset + 2] = 73;
                rgba[offset + 3] = 255;
            }
        }
    }
    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}

#[cfg(target_os = "windows")]
fn sync_taskbar_badge(app: &AppHandle, state: &AppState) {
    let unread = state.wrike_inbox_unread.load(Ordering::Relaxed);
    let update = state.update_available_badge.load(Ordering::Relaxed);
    let active = unread || update;
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let next_icon = app_handle.default_window_icon().map(|default_icon| {
            if active {
                badged_window_icon(default_icon)
            } else {
                default_icon.to_owned()
            }
        });
        if let Some(window) = app_handle.get_window("main") {
            if let Some(icon) = next_icon.clone() {
                let _ = window.set_icon(icon);
            }
            let overlay = active.then(taskbar_overlay_badge_icon);
            let _ = window.set_overlay_icon(overlay);
        }
        if let Some(tray) = app_handle.tray_by_id(TRAY_ICON_ID) {
            if let Some(icon) = next_icon {
                let _ = tray.set_icon(Some(icon));
            }
            let tooltip = match (unread, update) {
                (true, true) => "ABW - Unread inbox & update available",
                (true, false) => "ABW - Unread Wrike inbox",
                (false, true) => "ABW - Update available",
                (false, false) => "ABW",
            };
            let _ = tray.set_tooltip(Some(tooltip));
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn sync_taskbar_badge(_app: &AppHandle, _state: &AppState) {}

#[tauri::command]
fn set_update_badge(app: AppHandle, state: State<'_, AppState>, available: bool) {
    state
        .update_available_badge
        .store(available, Ordering::Relaxed);
    sync_taskbar_badge(&app, state.inner());
}

#[cfg(windows)]
fn suspend_native_webview(
    webview: &Webview,
) -> Result<std::sync::mpsc::Receiver<Result<bool, String>>, String> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::ICoreWebView2_3, TrySuspendCompletedHandler,
    };
    use windows_core::Interface;

    let _ = webview.hide();
    let (tx, rx) = std::sync::mpsc::channel();
    webview
        .with_webview(move |platform_webview| unsafe {
            let result = (|| -> Result<(), String> {
                let core = platform_webview
                    .controller()
                    .CoreWebView2()
                    .map_err(|error| format!("Unable to access CoreWebView2: {error}"))?;
                let webview3 = core
                    .cast::<ICoreWebView2_3>()
                    .map_err(|error| format!("ICoreWebView2_3 unavailable: {error}"))?;
                let callback_tx = tx.clone();
                let handler = TrySuspendCompletedHandler::create(Box::new(
                    move |res: windows_core::Result<()>, is_successful: bool| {
                        let outcome = res
                            .map(|()| is_successful)
                            .map_err(|error| format!("TrySuspend failed: {error}"));
                        let _ = callback_tx.send(outcome);
                        Ok(())
                    },
                ));
                webview3
                    .TrySuspend(&handler)
                    .map_err(|error| format!("Unable to start TrySuspend: {error}"))
            })();
            if let Err(error) = result {
                let _ = tx.send(Err(error));
            }
        })
        .map_err(|error| format!("Unable to suspend Wrike tab: {error}"))?;
    Ok(rx)
}

#[cfg(not(windows))]
fn suspend_native_webview(
    webview: &Webview,
) -> Result<std::sync::mpsc::Receiver<Result<bool, String>>, String> {
    webview
        .hide()
        .map_err(|error| format!("Unable to hide Wrike tab: {error}"))?;
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = tx.send(Ok(true));
    Ok(rx)
}

#[cfg(windows)]
fn resume_native_webview(webview: &Webview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_3;
    use windows_core::Interface;

    let _ = webview.with_webview(|platform_webview| unsafe {
        if let Ok(core) = platform_webview.controller().CoreWebView2() {
            if let Ok(webview3) = core.cast::<ICoreWebView2_3>() {
                let _ = webview3.Resume();
            }
        }
    });
}

#[cfg(not(windows))]
fn resume_native_webview(_webview: &Webview) {}

#[cfg(windows)]
fn set_native_memory_target_level(webview: &Webview, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;

    let level = if low {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    };
    let _ = webview.with_webview(move |platform_webview| unsafe {
        if let Ok(core) = platform_webview.controller().CoreWebView2() {
            if let Ok(webview19) = core.cast::<ICoreWebView2_19>() {
                let _ = webview19.SetMemoryUsageTargetLevel(level);
            }
        }
    });
}

#[cfg(not(windows))]
fn set_native_memory_target_level(_webview: &Webview, _low: bool) {}

#[tauri::command]
async fn suspend_wrike_tab(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<bool, String> {
    let label = wrike_tab_label(&tab_id)?;
    let Some(webview) = app.get_webview(&label) else {
        return Ok(false);
    };
    if state
        .visible_wrike_tabs
        .lock()
        .is_ok_and(|visible| visible.contains(&tab_id))
    {
        return Ok(false);
    }
    let rx = suspend_native_webview(&webview)?;
    let suspended = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(5))
    })
    .await
    .map_err(|error| format!("Suspend task failed: {error}"))?;

    let is_successful = match suspended {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => return Err(error),
        Err(_) => return Ok(false),
    };
    if !is_successful {
        return Ok(false);
    }

    let became_visible = state
        .visible_wrike_tabs
        .lock()
        .is_ok_and(|visible| visible.contains(&tab_id));
    if became_visible {
        resume_native_webview(&webview);
        set_native_memory_target_level(&webview, false);
        let _ = webview.show();
        return Ok(false);
    }

    if let Ok(mut suspended_tabs) = state.suspended_tabs.lock() {
        suspended_tabs.insert(tab_id.clone());
    }
    if let Ok(mut visible) = state.visible_wrike_tabs.lock() {
        visible.remove(&tab_id);
    }
    Ok(true)
}

#[tauri::command]
fn resume_wrike_tab(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<bool, String> {
    let label = wrike_tab_label(&tab_id)?;
    let Some(webview) = app.get_webview(&label) else {
        return Ok(false);
    };
    if let Ok(mut suspended) = state.suspended_tabs.lock() {
        suspended.remove(&tab_id);
    }
    resume_native_webview(&webview);
    set_native_memory_target_level(&webview, false);
    Ok(true)
}

#[tauri::command]
async fn launch_wrike(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    url: Option<String>,
) -> Result<(), String> {
    open_wrike_at(
        &app,
        state.inner(),
        &tab_id,
        url.as_deref().unwrap_or(WRIKE_HOME),
        false,
    )
}

#[tauri::command]
fn resize_wrike_tabs(
    app: AppHandle,
    state: State<'_, AppState>,
    layouts: Option<Vec<WrikeTabLayout>>,
    top_inset: Option<f64>,
    split_ratio: Option<f64>,
) -> Result<(), String> {
    if let Some(inset) = top_inset {
        if let Ok(mut stored) = state.top_inset.lock() {
            *stored = inset.max(0.0);
        }
    }
    if let Some(ratio) = split_ratio.filter(|value| value.is_finite()) {
        if let Ok(mut stored) = state.wrike_split_ratio.lock() {
            *stored = ratio.clamp(0.25, 0.75);
        }
    }
    if let Some(layouts) = layouts.filter(|layouts| !layouts.is_empty()) {
        if let Ok(mut visible) = state.visible_wrike_tabs.lock() {
            visible.clear();
            for layout in &layouts {
                visible.insert(layout.tab_id.clone());
            }
        }
        for layout in layouts {
            if let Some(webview) = app.get_webview(&wrike_tab_label(&layout.tab_id)?) {
                sync_wrike_bounds(&app, &webview, layout.pane)?;
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
            sync_wrike_bounds(&app, &webview, WrikePane::Full)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn hide_wrike_tabs(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_ids: Vec<String>,
) -> Result<(), String> {
    let suspended_snapshot = state
        .suspended_tabs
        .lock()
        .map(|tabs| tabs.clone())
        .unwrap_or_default();
    if let Ok(mut visible) = state.visible_wrike_tabs.lock() {
        for tab_id in &tab_ids {
            visible.remove(tab_id);
        }
    }
    for tab_id in tab_ids {
        let label = wrike_tab_label(&tab_id)?;
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.eval("window.__abwHidePreviewLoading?.();");
            webview
                .hide()
                .map_err(|error| format!("Unable to hide the Wrike workspace: {error}"))?;
            if !suspended_snapshot.contains(&tab_id) {
                set_native_memory_target_level(&webview, true);
            }
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
    if let Ok(mut suspended) = state.suspended_tabs.lock() {
        suspended.remove(&tab_id);
    }
    if let Ok(mut visible) = state.visible_wrike_tabs.lock() {
        visible.insert(tab_id.clone());
    }
    resume_native_webview(&webview);
    set_native_memory_target_level(&webview, false);
    webview
        .show()
        .map_err(|error| format!("Unable to display the Wrike workspace: {error}"))?;
    webview.set_focus().map_err(|error| error.to_string())?;
    if let Some(context) = find_wrike_context(state.inner(), &tab_id) {
        if let Some(theme) = context.detected_theme.lock().ok().and_then(|t| t.clone()) {
            let app_clone = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = app_clone.state::<AppState>();
                let _ = sync_detected_wrike_theme(&app_clone, state.inner(), &theme);
            });
        }
        emit_wrike_tab_update(&app, &context);
    }
    let _ = webview.eval("window.__abwHidePreviewLoading?.(); window.__abwDetectWrikeTheme?.();");
    Ok(())
}

#[tauri::command]
async fn open_source_task(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    tab_id: Option<String>,
) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "Invalid source task link.".to_owned())?;
    let allowed_host = parsed
        .host_str()
        .is_some_and(|host| host == "wrike.com" || host.ends_with(".wrike.com"));
    if parsed.scheme() != "https" || !allowed_host {
        return Err("Only HTTPS Wrike task links may be opened inside ABW.".into());
    }
    let target_tab_id = tab_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or("home");
    wrike_tab_label(target_tab_id)?;
    open_wrike_at(&app, state.inner(), target_tab_id, parsed.as_str(), true)
}

#[tauri::command]
fn close_wrike_tab(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), String> {
    let label = wrike_tab_label(&tab_id)?;
    let close_result = if let Some(webview) = app.get_webview(&label) {
        webview
            .close()
            .map_err(|error| format!("Unable to close the Wrike tab: {error}"))
    } else {
        Ok(())
    };
    if let Ok(mut tabs) = state.wrike_tabs.lock() {
        tabs.remove(&tab_id);
    }
    if let Ok(mut suspended) = state.suspended_tabs.lock() {
        suspended.remove(&tab_id);
    }
    if let Ok(mut visible) = state.visible_wrike_tabs.lock() {
        visible.remove(&tab_id);
    }
    close_result
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
) -> Result<(), String> {
    let label = wrike_tab_label(tab_id)?;
    let parsed = Url::parse(destination).map_err(|error| format!("Invalid Wrike URL: {error}"))?;
    if !is_safe_remote_destination(&parsed) {
        return Err("Only HTTPS or about:blank URLs may be opened inside ABW.".into());
    }
    if let Some(webview) = app.get_webview(&label) {
        if let Ok(mut suspended) = state.suspended_tabs.lock() {
            suspended.remove(tab_id);
        }
        resume_native_webview(&webview);
        if navigate_existing {
            webview
                .navigate(parsed)
                .map_err(|error| format!("Unable to open the task in Wrike: {error}"))?;
            if let Some(context) = find_wrike_context(state, tab_id) {
                record_wrike_navigation(&context, destination);
                emit_wrike_tab_update(app, &context);
            }
        }
        set_native_memory_target_level(&webview, false);
        if let Ok(mut visible) = state.visible_wrike_tabs.lock() {
            visible.insert(tab_id.to_owned());
        }
        webview
            .show()
            .map_err(|error| format!("Unable to display the Wrike workspace: {error}"))?;
        webview.set_focus().map_err(|error| error.to_string())?;
        if let Some(context) = find_wrike_context(state, tab_id) {
            if let Some(theme) = context.detected_theme.lock().ok().and_then(|t| t.clone()) {
                let app_clone = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let state = app_clone.state::<AppState>();
                    let _ = sync_detected_wrike_theme(&app_clone, state.inner(), &theme);
                });
            }
            emit_wrike_tab_update(app, &context);
        }
        let _ =
            webview.eval("window.__abwHidePreviewLoading?.(); window.__abwDetectWrikeTheme?.();");
        return Ok(());
    }

    let host = app
        .get_window("main")
        .ok_or_else(|| "Unable to locate the ABW application window.".to_owned())?;
    let (content_position, content_size) = wrike_content_geometry(app, WrikePane::Full)?;
    let (spell_check, custom_context_menu, use_native_wrike_image_viewer) =
        get_cached_settings(app)
            .map(|stored| {
                (
                    stored.spell_check,
                    stored.custom_context_menu,
                    stored.use_native_wrike_image_viewer,
                )
            })
            .unwrap_or((true, true, true));
    let context = Arc::new(CaptureContext::new(tab_id, destination));
    let title_context = Arc::clone(&context);
    let title_app = app.clone();
    let navigation_context = Arc::clone(&context);
    let navigation_app = app.clone();
    let po_webview_label = label.clone();
    let po_tab_id = tab_id.to_owned();
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
        .zoom_hotkeys_enabled(true)
        .initialization_script(if custom_context_menu {
            "window.__abwCustomContextMenuEnabled = true;"
        } else {
            "window.__abwCustomContextMenuEnabled = false;"
        })
        .initialization_script(if use_native_wrike_image_viewer {
            "window.__abwUseNativeWrikeImageViewer = true;"
        } else {
            "window.__abwUseNativeWrikeImageViewer = false;"
        })
        .initialization_script(apply_spell_check_script(spell_check, false))
        .on_navigation(move |url| {
            if is_po_handoff(url) {
                let from_wrike = navigation_context
                    .page_url
                    .lock()
                    .ok()
                    .and_then(|page| page.as_ref().and_then(|value| Url::parse(value).ok()))
                    .is_some_and(|source| is_wrike_workspace_destination(&source));
                if let Some(params) = url
                    .fragment()
                    .and_then(|value| value.strip_prefix("abw-check-po?"))
                {
                    let mut booking = serde_json::Map::new();
                    let mut automatic_id = None;
                    for (key, value) in url::form_urlencoded::parse(params.as_bytes()) {
                        if key == "automatic" {
                            automatic_id = Uuid::parse_str(&value).ok();
                        } else if matches!(
                            key.as_ref(),
                            "media" | "client" | "product" | "po" | "start" | "end" | "total" | "plan"
                        ) && value.len() <= 100
                        {
                            booking.insert(
                                key.into_owned(),
                                serde_json::Value::String(value.into_owned()),
                            );
                        }
                    }
                    if let Some(id) = automatic_id {
                        if from_wrike && url.as_str().len() < 8192 {
                            let app = navigation_app.clone();
                            let label = po_webview_label.clone();
                            let tab_id = po_tab_id.clone();
                            tauri::async_runtime::spawn_blocking(move || {
                                if let Some(status) =
                                    po_bridge::run_job_for_tab(&tab_id, booking.into())
                                {
                                    if let Some(webview) = app.get_webview(&label) {
                                        let _ = webview.eval(format!(
                                            "window.__abwReceivePoStatus?.('{id}', '{status}');"
                                        ));
                                    }
                                }
                            });
                        }
                        return false;
                    }
                }
                let message = if !from_wrike || url.as_str().len() >= 8192 {
                    Some(
                        "Unable to read the task for Check PO. Reopen the Wrike task and try again.",
                    )
                } else if open_po_in_chrome(url).is_err() {
                    Some("Unable to open Chrome for the PO check.")
                } else {
                    None
                };
                if let Some(message) = message {
                    navigation_app.dialog().message(message).show(|_| {});
                }
                return false;
            }
            if url.scheme() == "abw-dictionary" {
                let app_clone = navigation_app.clone();
                let url_clone = url.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = add_custom_dictionary_word(&app_clone, &url_clone);
                });
                return false;
            }
            if url.scheme() == "abw-shortcut" {
                handle_wrike_shortcut(&navigation_app, url);
                return false;
            }
            if url.scheme() == "abw-theme" {
                let app_clone = navigation_app.clone();
                let context_clone = Arc::clone(&navigation_context);
                let url_clone = url.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = apply_detected_wrike_theme(&app_clone, &context_clone, &url_clone);
                });
                return false;
            }
            if url.scheme() == "abw-preview-intent" {
                if let Some(state) = navigation_app.try_state::<AppState>() {
                    if let Ok(mut guard) = state.preview_intent_until.lock() {
                        *guard = Some(std::time::Instant::now() + std::time::Duration::from_secs(12));
                    }
                }
                return false;
            }
            if url.scheme() == "abw-task" {
                let title = url
                    .query_pairs()
                    .find_map(|(key, value)| (key == "title").then(|| value.trim().to_owned()))
                    .filter(|value| !value.is_empty());
                if let Ok(mut active) = navigation_context.active_task_title.lock() {
                    *active = title;
                }
                return false;
            }
            if url.scheme() == "abw-inbox" {
                let has_unread = url
                    .query_pairs()
                    .find_map(|(key, value)| (key == "hasUnread").then(|| value == "true"))
                    .unwrap_or(false);
                if let Some(state) = navigation_app.try_state::<AppState>() {
                    state
                        .wrike_inbox_unread
                        .store(has_unread, Ordering::Relaxed);
                    sync_taskbar_badge(&navigation_app, state.inner());
                }
                return false;
            }
            if url.scheme() == "abw-new-tab" {
                if let Some(target_url) = url
                    .query_pairs()
                    .find_map(|(key, value)| (key == "url").then(|| value.into_owned()))
                    .filter(|raw| {
                        Url::parse(raw)
                            .ok()
                            .is_some_and(|parsed| is_safe_remote_destination(&parsed))
                    })
                {
                    let _ = navigation_app.emit("wrike-open-in-new-tab", target_url);
                }
                return false;
            }
            if url.scheme() == "abw-share" {
                if let Some(target_url) = url
                    .query_pairs()
                    .find_map(|(key, value)| (key == "url").then(|| value.into_owned()))
                    .filter(|raw| {
                        Url::parse(raw)
                            .ok()
                            .is_some_and(|parsed| is_safe_remote_destination(&parsed))
                    })
                {
                    let _ = navigation_app.emit("wrike-share-url", target_url);
                }
                return false;
            }
            let allowed = is_safe_remote_destination(url);
            if allowed {
                if should_open_link_externally(&navigation_app, url) {
                    let _ = open::that(url.as_str());
                    return false;
                }
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
            if should_open_link_externally(&popup_app, &url) {
                let _ = open::that(url.as_str());
                return NewWindowResponse::Deny;
            }
            if is_wrike_workspace_destination(&url) {
                let _ = popup_app.emit("wrike-open-in-new-tab", url.to_string());
                return NewWindowResponse::Deny;
            }
            let parent_provenance = captured_provenance(&popup_context);
            let child_context = Arc::new(CaptureContext::new("popup", url.as_str()));
            let child_title_context = Arc::clone(&child_context);
            let child_download_context = Arc::clone(&child_context);
            let label = format!("wrike-popup-{}", Uuid::new_v4());
            let completion_app = popup_app.clone();
            let completion_workspace_label = popup_workspace_label.clone();
            let (popup_spell_check, popup_custom_menu, popup_native_image_viewer) =
                get_cached_settings(&popup_app)
                    .map(|stored| {
                        (
                            stored.spell_check,
                            stored.custom_context_menu,
                            stored.use_native_wrike_image_viewer,
                        )
                    })
                    .unwrap_or((true, true, true));
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
            .initialization_script(if popup_custom_menu {
                "window.__abwCustomContextMenuEnabled = true;"
            } else {
                "window.__abwCustomContextMenuEnabled = false;"
            })
            .initialization_script(if popup_native_image_viewer {
                "window.__abwUseNativeWrikeImageViewer = true;"
            } else {
                "window.__abwUseNativeWrikeImageViewer = false;"
            })
            .initialization_script(apply_spell_check_script(popup_spell_check, true))
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
                let has_title = load_context
                    .page_title
                    .lock()
                    .ok()
                    .map(|title| !clean_wrike_title(&title).is_empty())
                    .unwrap_or(false);
                if has_title {
                    set_title_loading(&load_context, false);
                }
                let _ = _webview.eval("window.__abwDetectWrikeTheme?.();");
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
    if let Err(error) = host.add_child(builder, content_position, content_size) {
        if let Ok(mut tabs) = state.wrike_tabs.lock() {
            tabs.remove(tab_id);
        }
        return Err(format!("Unable to open Wrike workspace: {error}"));
    }
    if let Ok(mut visible) = state.visible_wrike_tabs.lock() {
        visible.insert(tab_id.to_owned());
    }
    emit_wrike_tab_update(app, &context);
    Ok(())
}

fn wrike_content_geometry(
    app: &AppHandle,
    pane: WrikePane,
) -> Result<(LogicalPosition<f64>, LogicalSize<f64>), String> {
    let host = app
        .get_window("main")
        .ok_or_else(|| "Unable to locate the ABW application window.".to_owned())?;
    let scale = host.scale_factor().map_err(|error| error.to_string())?;
    let host_size = host
        .inner_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    let top_inset = app
        .try_state::<AppState>()
        .and_then(|state| state.top_inset.lock().ok().map(|value| *value))
        .unwrap_or(0.0)
        .max(0.0);
    let split_ratio = app
        .try_state::<AppState>()
        .and_then(|state| state.wrike_split_ratio.lock().ok().map(|value| *value))
        .filter(|value| value.is_finite())
        .unwrap_or(0.5)
        .clamp(0.25, 0.75);
    let top_offset = TASKBAR_HEIGHT + top_inset;
    let content_height = (host_size.height - top_offset).max(1.0);
    let usable_width = (host_size.width - WRIKE_SPLIT_GAP).max(2.0);
    let left_width = (usable_width * split_ratio)
        .round()
        .clamp(1.0, (usable_width - 1.0).max(1.0));
    let right_x = left_width + WRIKE_SPLIT_GAP;
    let right_width = (host_size.width - right_x).max(1.0);
    let (x, width) = match pane {
        WrikePane::Full => (0.0, host_size.width),
        WrikePane::Left => (0.0, left_width),
        WrikePane::Right => (right_x, right_width),
    };
    Ok((
        LogicalPosition::new(x, top_offset),
        LogicalSize::new(width, content_height),
    ))
}

fn sync_wrike_bounds(app: &AppHandle, webview: &Webview, pane: WrikePane) -> Result<(), String> {
    let (position, size) = wrike_content_geometry(app, pane)?;
    webview
        .set_position(position)
        .map_err(|error| format!("Unable to move the Wrike workspace: {error}"))?;
    webview
        .set_size(size)
        .map_err(|error| format!("Unable to resize the Wrike workspace: {error}"))
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
                        let app_clone = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            if let Err(error) =
                                record_completed_download(&app_clone, &path, provenance)
                            {
                                emit_download_capture_error(&app_clone, error);
                            }
                        });
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
    let active_task = context
        .active_task_title
        .lock()
        .ok()
        .and_then(|title| title.as_ref().map(|t| clean_wrike_title(t)))
        .filter(|title| !title.is_empty());
    let source_label = active_task
        .or_else(|| {
            context
                .page_title
                .lock()
                .ok()
                .map(|title| clean_wrike_title(&title))
                .filter(|title| !title.is_empty())
        })
        .unwrap_or_else(|| "Wrike task".to_owned());
    PendingDownload {
        source_url: context.page_url.lock().ok().and_then(|url| url.clone()),
        source_label,
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
    let previewed = app
        .try_state::<AppState>()
        .and_then(|state| {
            state
                .preview_intent_until
                .lock()
                .ok()
                .and_then(|mut guard| guard.take())
        })
        .is_some_and(|deadline| std::time::Instant::now() <= deadline);
    let record = DownloadRecord {
        id: Uuid::new_v4().to_string(),
        file_name,
        kind: file_kind(&extension).into(),
        extension,
        downloaded_at: persistence::now_rfc3339(),
        size_bytes,
        source_url: provenance.source_url,
        source_label: provenance.source_label,
        previewed,
    };
    persistence::update::<Vec<DownloadRecord>, _>(&records_path(app)?, |records| {
        records.insert(0, record.clone());
        Ok(())
    })?;
    let settings = get_cached_settings(app)?;
    if settings.download_notifications {
        let _ = app
            .notification()
            .builder()
            .title("Download saved to ABW Files")
            .body(format!("{notification_file_name} is ready to preview."))
            .show();
    }
    if settings.open_downloaded_files_automatically
        && !(previewed && matches!(record.kind.as_str(), "pdf" | "spreadsheet" | "image"))
    {
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

    let ws_path = workspace_state_path(app)?;
    let workspace = if ws_path.exists() {
        persistence::read::<WorkspaceState>(&ws_path)?
    } else {
        let has_legacy = !settings.pinned_download_ids.is_empty()
            || !settings.favorite_tickets.is_empty()
            || !settings.visit_history.is_empty()
            || settings.last_wrike_session.is_some();
        if has_legacy {
            let migrated = WorkspaceState {
                pinned_download_ids: settings.pinned_download_ids.clone(),
                favorite_tickets: settings.favorite_tickets.clone(),
                visit_history: settings.visit_history.clone(),
                last_wrike_session: settings.last_wrike_session.clone(),
                window_bounds: None,
            };
            let _ = persistence::update::<WorkspaceState, _>(&ws_path, |stored| {
                *stored = migrated.clone();
                Ok(())
            });
            migrated
        } else {
            WorkspaceState::default()
        }
    };
    settings.merge_workspace_state(&workspace);
    Ok(settings)
}

fn current_settings_file_stamp(app: &AppHandle) -> Option<SettingsFileStamp> {
    let path = settings_path(app).ok()?;
    let metadata = fs::metadata(path).ok()?;
    Some(SettingsFileStamp {
        modified: metadata.modified().ok(),
        len: metadata.len(),
    })
}

fn store_cached_settings(app: &AppHandle, settings: &Settings) {
    let stamp = current_settings_file_stamp(app);
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut cached) = state.cached_settings.write() {
            *cached = Some((settings.clone(), stamp));
        }
    }
}

fn refresh_cached_settings(app: &AppHandle) -> Result<Settings, String> {
    let settings = read_settings(app)?;
    store_cached_settings(app, &settings);
    Ok(settings)
}

fn get_cached_settings(app: &AppHandle) -> Result<Settings, String> {
    let current_stamp = current_settings_file_stamp(app);
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(cached) = state.cached_settings.read() {
            if let Some((settings, cached_stamp)) = cached.as_ref() {
                if *cached_stamp == current_stamp {
                    return Ok(settings.clone());
                }
            }
        }
    }
    refresh_cached_settings(app)
}

fn save_main_window_bounds(app: &AppHandle) {
    let Some(window) = app.get_window("main") else {
        return;
    };
    let maximized = window.is_maximized().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    if minimized {
        return;
    }
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    if size.width < 600 || size.height < 400 {
        return;
    }
    let bounds = WindowBounds {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized,
    };
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(path) = workspace_state_path(&app_clone) {
            let _ = persistence::update::<WorkspaceState, _>(&path, |workspace| {
                if maximized {
                    if let Some(existing) = workspace.window_bounds.as_mut() {
                        existing.maximized = true;
                    } else {
                        workspace.window_bounds = Some(bounds.clone());
                    }
                } else {
                    workspace.window_bounds = Some(bounds.clone());
                }
                Ok(())
            });
        }
    });
}

fn show_main_window(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.main_window_hidden.store(false, Ordering::SeqCst);
        let suspended = state
            .suspended_tabs
            .lock()
            .map(|tabs| tabs.clone())
            .unwrap_or_default();
        let visible = state
            .visible_wrike_tabs
            .lock()
            .map(|tabs| tabs.clone())
            .unwrap_or_default();
        for tab_id in visible {
            if let Ok(label) = wrike_tab_label(&tab_id) {
                if let Some(webview) = app.get_webview(&label) {
                    if suspended.contains(&tab_id) {
                        if let Ok(mut guard) = state.suspended_tabs.lock() {
                            guard.remove(&tab_id);
                        }
                        resume_native_webview(&webview);
                    }
                    set_native_memory_target_level(&webview, false);
                    let _ = webview.show();
                }
            }
        }
    }
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn request_quit(app: &AppHandle, explicit: bool) {
    save_main_window_bounds(app);
    // Corrupt preferences must not make the application impossible to quit.
    let settings = get_cached_settings(app).unwrap_or_default();
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
        state.main_window_hidden.store(true, Ordering::SeqCst);
        if let Some(window) = app.get_window("main") {
            let _ = window.hide();
        }
        let suspended = state
            .suspended_tabs
            .lock()
            .map(|tabs| tabs.clone())
            .unwrap_or_default();
        let tab_ids = state
            .wrike_tabs
            .lock()
            .map(|tabs| tabs.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for tab_id in tab_ids {
            if let Ok(label) = wrike_tab_label(&tab_id) {
                if let Some(webview) = app.get_webview(&label) {
                    let _ = webview.eval("window.__abwHidePreviewLoading?.();");
                    if suspended.contains(&tab_id) {
                        continue;
                    }
                    set_native_memory_target_level(&webview, true);
                    if settings.suspend_tabs_on_tray_hide {
                        if let Ok(rx) = suspend_native_webview(&webview) {
                            let app_clone = app.clone();
                            let tab_id_clone = tab_id.clone();
                            tauri::async_runtime::spawn(async move {
                                let suspended_ok =
                                    tauri::async_runtime::spawn_blocking(move || {
                                        rx.recv_timeout(std::time::Duration::from_secs(5))
                                    })
                                    .await
                                    .ok()
                                    .and_then(|res| res.ok())
                                    .and_then(|res| res.ok())
                                    .unwrap_or(false);
                                if !suspended_ok {
                                    return;
                                }
                                let state = app_clone.state::<AppState>();
                                if !state.main_window_hidden.load(Ordering::SeqCst) {
                                    if let Ok(label) = wrike_tab_label(&tab_id_clone) {
                                        if let Some(wv) = app_clone.get_webview(&label) {
                                            resume_native_webview(&wv);
                                            set_native_memory_target_level(&wv, false);
                                            if state
                                                .visible_wrike_tabs
                                                .lock()
                                                .is_ok_and(|v| v.contains(&tab_id_clone))
                                            {
                                                let _ = wv.show();
                                            }
                                        }
                                    }
                                    return;
                                }
                                if let Ok(mut guard) = state.suspended_tabs.lock() {
                                    guard.insert(tab_id_clone);
                                };
                            });
                        }
                    }
                }
            }
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

fn workspace_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(application_dir(app)?.join("workspace-state.json"))
}

fn downloads_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = application_dir(app)?.join("downloads");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Unable to create download directory: {error}"))?;
    Ok(directory)
}

fn sanitize_download_filename(suggested_name: &str) -> String {
    let raw = Path::new(suggested_name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("wrike-download");
    let cleaned: String = raw
        .chars()
        .map(|ch| {
            if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch.is_control()
            {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        return "wrike-download".to_owned();
    }
    let path = Path::new(trimmed);
    let mut stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("wrike-download")
        .to_owned();
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .filter(|ext| ext.len() <= 16);
    let upper_stem = stem.to_ascii_uppercase();
    if matches!(
        upper_stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        stem.insert(0, '_');
    }
    if stem.chars().count() > 140 {
        stem = stem.chars().take(140).collect();
    }
    match extension {
        Some(ext) => format!("{stem}.{ext}"),
        None => stem,
    }
}

fn unique_download_path(app: &AppHandle, suggested_name: &str) -> Result<PathBuf, String> {
    let directory = downloads_dir(app)?;
    let sanitized = sanitize_download_filename(suggested_name);
    let original = Path::new(&sanitized);
    let stem = original
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("wrike-download");
    let extension = original
        .extension()
        .and_then(|extension| extension.to_str());
    let mut candidate = directory.join(&sanitized);
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

fn resolve_tracked_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let state = app.state::<AppState>();
    if let Ok(paths) = state.tracked_paths.lock() {
        if let Some(cached) = paths.get(id) {
            return Ok(cached.clone());
        }
    }
    let resolved = tracked_path(app, id)?;
    if let Ok(mut paths) = state.tracked_paths.lock() {
        paths.insert(id.to_owned(), resolved.clone());
    }
    Ok(resolved)
}

fn invalidate_tracked_paths(app: &AppHandle, id: Option<&str>) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut paths) = state.tracked_paths.lock() {
            if let Some(target_id) = id {
                paths.remove(target_id);
            } else {
                paths.clear();
            }
        }
    }
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
        "xls" | "xlsx" | "xlsm" | "xlsb" | "ods" | "csv" | "tsv" => "spreadsheet",
        "doc" | "docx" | "rtf" | "txt" => "document",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" => "image",
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
        .filter(|word| word.chars().count() <= 64)
        .ok_or_else(|| "No dictionary word was provided.".to_owned())?;
    let (_, previous) = persistence::update::<Settings, _>(&settings_path(app)?, |settings| {
        let previous = settings.custom_dictionary.clone();
        settings.custom_dictionary.push(word);
        settings.custom_dictionary =
            normalize_dictionary(std::mem::take(&mut settings.custom_dictionary));
        Ok(previous)
    })?;
    let settings = refresh_cached_settings(app)?;
    sync_windows_spelling_dictionary(&previous, &settings.custom_dictionary);
    app.emit("settings-updated", settings)
        .map_err(|error| format!("Unable to refresh settings: {error}"))
}

const VALID_APP_THEMES: &[&str] = &[
    "default",
    "midnight",
    "aquamarine",
    "blueberry-pie",
    "blue-steel",
    "imperial-purple",
    "velvet-cosmos",
    "cool-confetti",
    "merlot",
    "halloween",
    "pumpkin-spice",
    "woodland-grass",
    "blue-skies",
    "flamingo",
    "cappuccino",
    "winter-white",
    "monochrome",
    "winter-holiday",
    "legendary-leopard",
];

fn normalize_detected_theme(value: &str) -> Option<&'static str> {
    let trimmed = value.trim();
    VALID_APP_THEMES
        .iter()
        .copied()
        .find(|candidate| candidate.eq_ignore_ascii_case(trimmed))
}

fn sync_detected_wrike_theme(app: &AppHandle, state: &AppState, theme: &str) -> Result<(), String> {
    let Some(normalized) = normalize_detected_theme(theme) else {
        return Ok(());
    };
    if let Ok(mut latest) = state.detected_wrike_theme.lock() {
        *latest = Some(normalized.to_owned());
    }
    let current = get_cached_settings(app)?;
    if !current.auto_match_wrike_theme || current.theme == normalized {
        return Ok(());
    }
    let (_, changed) = persistence::update::<Settings, _>(&settings_path(app)?, |settings| {
        if !settings.auto_match_wrike_theme || settings.theme == normalized {
            return Ok(false);
        }
        settings.theme = normalized.to_owned();
        Ok(true)
    })?;
    if changed {
        let settings = refresh_cached_settings(app)?;
        app.emit("settings-updated", settings)
            .map_err(|error| format!("Unable to refresh settings: {error}"))?;
    }
    Ok(())
}

fn apply_detected_wrike_theme(
    app: &AppHandle,
    context: &CaptureContext,
    url: &Url,
) -> Result<(), String> {
    let theme = url
        .query_pairs()
        .find_map(|(key, value)| (key == "theme").then(|| value.into_owned()))
        .and_then(|value| normalize_detected_theme(&value))
        .ok_or_else(|| "No valid Wrike theme was provided.".to_owned())?;
    if let Ok(mut detected) = context.detected_theme.lock() {
        *detected = Some(theme.to_owned());
    }
    let state = app.state::<AppState>();
    sync_detected_wrike_theme(app, state.inner(), theme)
}

fn decode_windows_dictionary_bytes(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&chunk| u16::from_le_bytes(chunk))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&chunk| u16::from_be_bytes(chunk))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    let stripped = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    String::from_utf8_lossy(stripped).into_owned()
}

fn encode_windows_dictionary_utf16le(entries: &[String]) -> Vec<u8> {
    let text = entries.join("\r\n");
    let mut bytes = Vec::with_capacity(2 + text.len() * 2);
    bytes.extend_from_slice(&[0xFF, 0xFE]);
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
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
        let existing_text = fs::read(&dictionary)
            .map(|bytes| decode_windows_dictionary_bytes(&bytes))
            .unwrap_or_default();
        let mut entries = existing_text
            .lines()
            .map(|line| line.trim().trim_start_matches('\u{feff}'))
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
            if fs::create_dir_all(parent).is_err() {
                continue;
            }
            let encoded = encode_windows_dictionary_utf16le(&entries);
            if let Ok(mut temp) = tempfile::NamedTempFile::new_in(parent) {
                if temp.write_all(&encoded).is_ok() {
                    let _ = temp.persist(&dictionary);
                }
            }
        }
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

fn is_po_handoff(url: &Url) -> bool {
    url.origin().ascii_serialization() == "https://go.mediaocean.com"
        && url.path() == "/robots.txt"
        && url.query().is_none()
        && url
            .fragment()
            .is_some_and(|value| value.starts_with("abw-check-po?"))
}

fn open_po_in_chrome(url: &Url) -> std::io::Result<()> {
    #[cfg(windows)]
    for directory in [
        "LOCALAPPDATA",
        "ProgramFiles",
        "ProgramW6432",
        "ProgramFiles(x86)",
    ] {
        if let Some(root) = env::var_os(directory) {
            let chrome = PathBuf::from(root).join(r"Google\Chrome\Application\chrome.exe");
            if chrome.is_file() {
                if let Some(executable) = chrome.to_str() {
                    if open::with_detached(url.as_str(), executable).is_ok() {
                        return Ok(());
                    }
                }
            }
        }
    }
    open::with_detached(url.as_str(), "chrome.exe")
}

fn is_wrike_workspace_destination(url: &Url) -> bool {
    is_https_wrike_url(url) && url.path().ends_with("/workspace.htm")
}

fn is_https_wrike_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| host == "wrike.com" || host.ends_with(".wrike.com"))
}

fn is_internal_wrike_or_auth_host(host: &str) -> bool {
    host == "wrike.com"
        || host.ends_with(".wrike.com")
        || host == "login.microsoftonline.com"
        || host == "login.live.com"
        || host == "accounts.google.com"
        || host.ends_with(".okta.com")
        || host.ends_with(".onelogin.com")
        || host.ends_with(".pingidentity.com")
        || host.ends_with(".duosecurity.com")
}

fn should_open_link_externally(app: &AppHandle, url: &Url) -> bool {
    if url.as_str() == "about:blank" || url.scheme() == "blob" {
        return false;
    }
    let open_externally = app
        .try_state::<AppState>()
        .map(|state| state.open_external_links_in_browser.load(Ordering::Relaxed))
        .unwrap_or(true);
    if !open_externally {
        return false;
    }
    url.host_str()
        .is_some_and(|host| !is_internal_wrike_or_auth_host(host))
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
            include_str!("wrike-injected.js")
                .replace(
                    "__ABW_TASK_PO__",
                    if auto_download {
                        ""
                    } else {
                        include_str!("task-po.js")
                    },
                )
                .replace("__ABW_SPELL_CHECK_ENABLED__", enabled_literal)
                .replace("__ABW_AUTO_DOWNLOAD__", auto_download_literal)
        })
        .as_str()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            show_main_window(app);
            if let Some(target_url) = args
                .iter()
                .skip(1)
                .find_map(|arg| parse_wrike_deep_link(arg))
            {
                let _ = app.emit("wrike-open-in-new-tab", target_url);
            }
        }))
        .manage(AppState::default())
        .manage(updater::PendingUpdateState::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            trace_native_event(app.handle(), "setup");
            if let Some(target_url) = std::env::args()
                .skip(1)
                .find_map(|arg| parse_wrike_deep_link(&arg))
            {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut guard) = state.pending_deep_link.lock() {
                        *guard = Some(target_url);
                    }
                }
            }
            #[cfg(windows)]
            if app.config().identifier == "net.insidemedia.abw" {
                let handle = app.handle().clone();
                std::thread::spawn(move || po_bridge::discovery::pair_on_startup(&handle));
            }
            let show_item = MenuItem::with_id(app, "show", "Show ABW", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit ABW", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let mut tray = TrayIconBuilder::with_id(TRAY_ICON_ID)
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

            if let Some(window) = app.get_window("main") {
                if let Ok(path) = workspace_state_path(app.handle()) {
                    if let Ok(workspace) = persistence::read::<WorkspaceState>(&path) {
                        if let Some(bounds) = workspace.window_bounds {
                            if bounds.width >= 760 && bounds.height >= 620 {
                                let _ =
                                    window.set_size(PhysicalSize::new(bounds.width, bounds.height));
                                let _ =
                                    window.set_position(PhysicalPosition::new(bounds.x, bounds.y));
                            }
                            if bounds.maximized {
                                let _ = window.maximize();
                            }
                        }
                    }
                }
                let start_minimized = env::args().any(|arg| arg == "--minimized")
                    && get_cached_settings(app.handle())
                        .map(|settings| settings.close_to_notification_area)
                        .unwrap_or(true);
                if start_minimized {
                    let _ = window.hide();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            updater::check_for_update,
            close_wrike_tab,
            focus_wrike_tab,
            clear_unpinned_downloads,
            delete_download,
            downloads_storage_stats,
            get_wrike_tab_state,
            get_settings,
            hide_wrike_tabs,
            updater::install_update,
            launch_wrike,
            list_downloads,
            load_spreadsheet_images,
            load_spreadsheet_sheet,
            notify_update_available,
            open_download,
            open_downloads_folder,
            open_source_task,
            preview_spreadsheet,
            read_download_head,
            read_download_image,
            read_download_range,
            reset_app,
            resize_wrike_tabs,
            resume_wrike_tab,
            reveal_download,
            send_test_notification,
            set_update_badge,
            storage_health,
            suspend_wrike_tab,
            take_pending_deep_link,
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
        for ext in ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] {
            assert_eq!(file_kind(ext), "image", "expected image for {ext}");
        }
        assert_eq!(file_kind("zip"), "other");
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

        // Revisiting an older URL directly pushes a new entry instead of rewinding to index 0.
        history.record("https://www.wrike.com/workspace.htm");
        assert!(history.can_go_back());
        assert!(!history.can_go_forward());
        assert_eq!(history.entries.len(), 4);
    }

    #[test]
    fn windows_dictionary_utf16le_round_trips_and_reads_utf8() {
        let words = vec!["café".to_owned(), "Wrike".to_owned()];
        let encoded = encode_windows_dictionary_utf16le(&words);
        assert!(encoded.starts_with(&[0xFF, 0xFE]));
        let decoded = decode_windows_dictionary_bytes(&encoded);
        assert_eq!(decoded, "café\r\nWrike");
        assert_eq!(
            decode_windows_dictionary_bytes(b"\xEF\xBB\xBFhello\nworld"),
            "hello\nworld"
        );
    }

    #[test]
    fn sanitize_download_filename_handles_windows_reserved_chars_and_names() {
        assert_eq!(
            sanitize_download_filename("Q3: Budget <Final>?.xlsx"),
            "Q3_ Budget _Final__.xlsx"
        );
        assert_eq!(sanitize_download_filename("CON.txt"), "_CON.txt");
        assert_eq!(sanitize_download_filename("   "), "wrike-download");
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
    fn parse_wrike_deep_link_accepts_wrikeapp_and_https_wrike_urls_only() {
        assert_eq!(
            parse_wrike_deep_link("wrikeapp://app-eu.wrike.com/open.htm?id=4527006164").as_deref(),
            Some("https://app-eu.wrike.com/open.htm?id=4527006164")
        );
        assert_eq!(
            parse_wrike_deep_link("https://www.wrike.com/workspace.htm").as_deref(),
            Some("https://www.wrike.com/workspace.htm")
        );
        assert_eq!(
            parse_wrike_deep_link("wrikeapp://evil.example/open.htm"),
            None
        );
        assert_eq!(parse_wrike_deep_link("http://www.wrike.com/open.htm"), None);
        assert_eq!(
            parse_wrike_deep_link("https://www.wrike.com/other.htm"),
            None
        );
        assert_eq!(parse_wrike_deep_link("abcdefghijé"), None);
        assert_eq!(parse_wrike_deep_link("javascript:alert(1)"), None);
    }
}
