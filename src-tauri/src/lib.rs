use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    collections::HashMap,
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
fn storage_health(app: AppHandle) -> Result<Vec<String>, String> {
    Ok([
        persistence::health::<Settings>(&settings_path(&app)?),
        persistence::health::<Vec<DownloadRecord>>(&records_path(&app)?),
    ]
    .into_iter()
    .flatten()
    .collect())
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

#[derive(Clone, Debug, Serialize, Deserialize)]
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    spell_check: bool,
    #[serde(default)]
    show_spell_check_in_topbar: bool,
    launch_wrike_on_start: bool,
    download_notifications: bool,
    open_abw_at_system_startup: bool,
    close_to_notification_area: bool,
    confirm_before_closing_tabs: bool,
    open_downloaded_files_automatically: bool,
    #[serde(default = "default_true")]
    open_external_links_in_browser: bool,
    #[serde(default = "default_true")]
    auto_check_for_updates: bool,
    #[serde(default = "default_true")]
    auto_match_wrike_theme: bool,
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
            show_spell_check_in_topbar: false,
            launch_wrike_on_start: true,
            download_notifications: true,
            open_abw_at_system_startup: false,
            close_to_notification_area: true,
            confirm_before_closing_tabs: false,
            open_downloaded_files_automatically: false,
            open_external_links_in_browser: true,
            auto_check_for_updates: true,
            auto_match_wrike_theme: true,
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

struct AppState {
    wrike_tabs: Mutex<HashMap<String, Arc<CaptureContext>>>,
    tracked_paths: Mutex<HashMap<String, PathBuf>>,
    detected_wrike_theme: Mutex<Option<String>>,
    top_inset: Mutex<f64>,
    quit_prompt_open: AtomicBool,
    wrike_inbox_unread: AtomicBool,
    update_available_badge: AtomicBool,
    open_external_links_in_browser: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            wrike_tabs: Mutex::new(HashMap::new()),
            tracked_paths: Mutex::new(HashMap::new()),
            detected_wrike_theme: Mutex::new(None),
            top_inset: Mutex::new(0.0),
            quit_prompt_open: AtomicBool::new(false),
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
fn list_downloads(app: AppHandle) -> Result<Vec<DownloadRecord>, String> {
    read_records(&app)
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
fn get_settings(app: AppHandle, state: State<'_, AppState>) -> Result<Settings, String> {
    let settings = read_settings(&app)?;
    state
        .open_external_links_in_browser
        .store(settings.open_external_links_in_browser, Ordering::Relaxed);
    Ok(settings)
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
    let detected_theme = state
        .detected_wrike_theme
        .lock()
        .ok()
        .and_then(|theme| theme.clone());
    let (settings, previous) =
        persistence::update::<Settings, _>(&settings_path(&app)?, |stored| {
            let previous = stored.clone();
            settings.last_wrike_session = stored.last_wrike_session.clone();
            if settings.auto_match_wrike_theme && !previous.auto_match_wrike_theme {
                if let Some(detected) = detected_theme.as_ref() {
                    settings.theme = detected.clone();
                }
            }
            if settings.open_abw_at_system_startup != startup::enabled()? {
                startup::set_enabled(settings.open_abw_at_system_startup)?;
            }
            *stored = settings;
            Ok(previous)
        })?;
    state
        .open_external_links_in_browser
        .store(settings.open_external_links_in_browser, Ordering::Relaxed);
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
                    .eval(script)
                    .map_err(|error| format!("Unable to apply spell-check preference: {error}"))?;
            }
        }
    }
    if settings.auto_match_wrike_theme && !previous.auto_match_wrike_theme {
        let tab_ids = state
            .wrike_tabs
            .lock()
            .map(|tabs| tabs.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for tab_id in tab_ids {
            if let Some(webview) = app.get_webview(&wrike_tab_label(&tab_id)?) {
                let _ = webview.eval("window.__abwDetectWrikeTheme?.(true);");
            }
        }
    }
    app.emit("settings-updated", settings.clone())
        .map_err(|error| format!("Unable to refresh settings: {error}"))?;
    Ok(settings)
}

#[tauri::command]
fn update_last_wrike_session(app: AppHandle, session: WrikeSession) -> Result<(), String> {
    persistence::update::<Settings, _>(&settings_path(&app)?, |settings| {
        settings.last_wrike_session = Some(normalize_wrike_session(session));
        Ok(())
    })
    .map(|_| ())
}

#[tauri::command]
fn reset_app(app: AppHandle, state: State<'_, AppState>) -> Result<Settings, String> {
    let (defaults, previous) =
        persistence::update::<Settings, _>(&settings_path(&app)?, |stored| {
            let previous = stored.clone();
            let defaults = Settings::default();
            if startup::enabled()? != defaults.open_abw_at_system_startup {
                let _ = startup::set_enabled(defaults.open_abw_at_system_startup);
            }
            *stored = defaults;
            Ok(previous)
        })?;
    state
        .open_external_links_in_browser
        .store(defaults.open_external_links_in_browser, Ordering::Relaxed);
    if !previous.custom_dictionary.is_empty() {
        sync_windows_spelling_dictionary(&previous.custom_dictionary, &defaults.custom_dictionary);
    }
    let script = apply_spell_check_script(defaults.spell_check, false);
    let tab_ids = state
        .wrike_tabs
        .lock()
        .map(|tabs| tabs.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for tab_id in tab_ids {
        if let Some(webview) = app.get_webview(&wrike_tab_label(&tab_id)?) {
            let _ = webview.eval(script);
        }
    }
    app.emit("settings-updated", defaults.clone())
        .map_err(|error| format!("Unable to refresh settings: {error}"))?;
    Ok(defaults)
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
fn taskbar_badge_image() -> tauri::image::Image<'static> {
    const SIZE: u32 = 32;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    let center = (SIZE as f32 - 1.0) / 2.0;
    let outer_radius = 14.5_f32;
    let inner_radius = 11.0_f32;
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
                rgba[offset + 3] = 235;
            }
        }
    }
    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}

#[cfg(target_os = "windows")]
fn sync_taskbar_badge(app: &AppHandle, state: &AppState) {
    let active = state.wrike_inbox_unread.load(Ordering::Relaxed)
        || state.update_available_badge.load(Ordering::Relaxed);
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = app_handle.get_window("main") {
            let icon = if active {
                Some(taskbar_badge_image())
            } else {
                None
            };
            let _ = window.set_overlay_icon(icon);
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
) -> Result<(), String> {
    if let Some(inset) = top_inset {
        if let Ok(mut stored) = state.top_inset.lock() {
            *stored = inset.max(0.0);
        }
    }
    if let Some(layouts) = layouts.filter(|layouts| !layouts.is_empty()) {
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
        if let Some(theme) = context.detected_theme.lock().ok().and_then(|t| t.clone()) {
            let _ = sync_detected_wrike_theme(&app, state.inner(), &theme);
        }
        emit_wrike_tab_update(&app, &context);
    }
    let _ = webview.eval("window.__abwDetectWrikeTheme?.();");
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
) -> Result<(), String> {
    let label = wrike_tab_label(tab_id)?;
    let parsed = Url::parse(destination).map_err(|error| format!("Invalid Wrike URL: {error}"))?;
    if let Some(webview) = app.get_webview(&label) {
        sync_wrike_bounds(app, &webview, WrikePane::Full)?;
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
            if let Some(theme) = context.detected_theme.lock().ok().and_then(|t| t.clone()) {
                let _ = sync_detected_wrike_theme(app, state, &theme);
            }
            emit_wrike_tab_update(app, &context);
        }
        let _ = webview.eval("window.__abwDetectWrikeTheme?.();");
        return Ok(());
    }

    let host = app
        .get_window("main")
        .ok_or_else(|| "Unable to locate the ABW application window.".to_owned())?;
    let (content_position, content_size) = wrike_content_geometry(app, WrikePane::Full)?;
    let spell_check = settings_path(app)
        .and_then(|path| persistence::read::<Settings>(&path))
        .map(|stored| stored.spell_check)
        .unwrap_or(true);
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
            if is_po_handoff(url) {
                let from_wrike = navigation_context
                    .page_url
                    .lock()
                    .ok()
                    .and_then(|page| page.as_ref().and_then(|value| Url::parse(value).ok()))
                    .is_some_and(|source| is_wrike_workspace_destination(&source));
                let message = if !from_wrike || url.as_str().len() >= 8192 {
                    Some("Unable to read the task for Check PO. Reopen the Wrike task and try again.")
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
                let _ = add_custom_dictionary_word(&navigation_app, url);
                return false;
            }
            if url.scheme() == "abw-shortcut" {
                handle_wrike_shortcut(&navigation_app, url);
                return false;
            }
            if url.scheme() == "abw-theme" {
                let _ = apply_detected_wrike_theme(&navigation_app, &navigation_context, url);
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
                {
                    let _ = navigation_app.emit("wrike-open-in-new-tab", target_url);
                }
                return false;
            }
            if url.scheme() == "abw-share" {
                if let Some(target_url) = url
                    .query_pairs()
                    .find_map(|(key, value)| (key == "url").then(|| value.into_owned()))
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
    host.add_child(builder, content_position, content_size)
        .map_err(|error| format!("Unable to open Wrike workspace: {error}"))?;
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
    let top_offset = TASKBAR_HEIGHT + top_inset;
    let content_height = (host_size.height - top_offset).max(1.0);
    let half_width = (host_size.width / 2.0).max(1.0);
    let (x, width) = match pane {
        WrikePane::Full => (0.0, host_size.width),
        WrikePane::Left => (0.0, half_width),
        WrikePane::Right => (half_width, (host_size.width - half_width).max(1.0)),
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
    let settings = read_settings(app)?;
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
    let current = read_settings(app)?;
    if !current.auto_match_wrike_theme || current.theme == normalized {
        return Ok(());
    }
    let (settings, changed) =
        persistence::update::<Settings, _>(&settings_path(app)?, |settings| {
            if !settings.auto_match_wrike_theme || settings.theme == normalized {
                return Ok(false);
            }
            settings.theme = normalized.to_owned();
            settings.open_abw_at_system_startup = startup::enabled()?;
            Ok(true)
        })?;
    if changed {
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
    let is_wrike = url
        .host_str()
        .is_some_and(|host| host == "wrike.com" || host.ends_with(".wrike.com"));
    url.scheme() == "https" && is_wrike && url.path().ends_with("/workspace.htm")
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
            r##"
        (() => {
          __ABW_TASK_PO__
          window.__abwSpellCleanup?.();
          const enabled = __ABW_SPELL_CHECK_ENABLED__;
          const abwAutoDownload = __ABW_AUTO_DOWNLOAD__;
          let abwSpellApplyTimer = 0;
          let abwThemeDetectTimer = 0;
          const abwWrikeThemeCatalog = [
            { id: "default", rgb: [16, 29, 62], patterns: [/\bdark[\s_-]*blue\b/i] },
            { id: "midnight", rgb: [22, 33, 54], patterns: [/\bmidnight\b/i] },
            { id: "aquamarine", rgb: [0, 57, 64], patterns: [/\baquamarine\b/i] },
            { id: "blueberry-pie", rgb: [25, 48, 100], patterns: [/\bblueberry(?:[\s_-]*pie)?\b/i] },
            { id: "blue-steel", rgb: [40, 54, 82], patterns: [/\bblue[\s_-]*steel\b/i] },
            { id: "imperial-purple", rgb: [52, 37, 113], patterns: [/\bimperial[\s_-]*purple\b/i] },
            { id: "velvet-cosmos", rgb: [63, 13, 79], patterns: [/\bvelvet[\s_-]*cosmos\b/i] },
            { id: "cool-confetti", rgb: [63, 13, 79], patterns: [/\bcool[\s_-]*confetti\b/i] },
            { id: "merlot", rgb: [68, 2, 36], patterns: [/\bmerlot\b/i] },
            { id: "halloween", rgb: [68, 2, 36], patterns: [/\bhalloween\b/i] },
            { id: "pumpkin-spice", rgb: [121, 0, 0], patterns: [/\bpumpkin[\s_-]*spice\b/i] },
            { id: "woodland-grass", rgb: [3, 38, 0], patterns: [/\bwoodland[\s_-]*grass\b/i] },
            { id: "blue-skies", rgb: [215, 234, 255], patterns: [/\bblue[\s_-]*skies\b/i] },
            { id: "flamingo", rgb: [255, 223, 247], patterns: [/\bflamingo\b/i] },
            { id: "cappuccino", rgb: [237, 231, 229], patterns: [/\bcappuccino\b/i] },
            { id: "winter-white", rgb: [232, 232, 232], patterns: [/\bwinter[\s_-]*white\b/i] },
            { id: "monochrome", rgb: [232, 232, 232], patterns: [/\bmonochrome\b/i] },
            { id: "winter-holiday", rgb: [255, 254, 255], patterns: [/\bwinter[\s_-]*holiday\b/i] },
            { id: "legendary-leopard", rgb: [40, 54, 82], patterns: [/\blegendary[\s_-]*leopard\b/i] }
          ];
          const abwParseCssColor = (value) => {
            const text = String(value || "").trim();
            if (!text || text === "transparent" || text === "none") return null;
            const rgbMatch = text.match(
              /rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([0-9.]+%?))?\s*\)/i
            );
            if (rgbMatch) {
              let alpha = 1;
              if (rgbMatch[4] !== undefined) {
                alpha = rgbMatch[4].endsWith("%")
                  ? parseFloat(rgbMatch[4]) / 100
                  : parseFloat(rgbMatch[4]);
              }
              if (!(alpha >= 0.82)) return null;
              return {
                r: Number(rgbMatch[1]),
                g: Number(rgbMatch[2]),
                b: Number(rgbMatch[3]),
                a: alpha
              };
            }
            const hexMatch = text.match(/#([0-9a-f]{3,8})\b/i);
            if (hexMatch) {
              const raw = hexMatch[1];
              if (raw.length === 3) {
                return {
                  r: parseInt(raw[0] + raw[0], 16),
                  g: parseInt(raw[1] + raw[1], 16),
                  b: parseInt(raw[2] + raw[2], 16),
                  a: 1
                };
              }
              if (raw.length === 6 || raw.length === 8) {
                const alpha = raw.length === 8 ? parseInt(raw.slice(6, 8), 16) / 255 : 1;
                if (!(alpha >= 0.82)) return null;
                return {
                  r: parseInt(raw.slice(0, 2), 16),
                  g: parseInt(raw.slice(2, 4), 16),
                  b: parseInt(raw.slice(4, 6), 16),
                  a: alpha
                };
              }
            }
            return null;
          };
          const abwExtractCssColors = (value) => {
            const text = String(value || "");
            if (!text || text === "none" || text === "transparent") return [];
            const tokens =
              text.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}\b/gi) || [text];
            return tokens.map(abwParseCssColor).filter(Boolean);
          };
          const abwMatchWrikeThemeText = (value) => {
            const text = String(value || "");
            if (!text) return null;
            for (const entry of abwWrikeThemeCatalog) {
              if (entry.patterns.some((pattern) => pattern.test(text))) {
                return entry.id;
              }
            }
            return null;
          };
          const abwMatchWrikeThemeColor = (rgb, allowPureWhite = true) => {
            if (!rgb) return null;
            if (!allowPureWhite && rgb.r >= 253 && rgb.g >= 253 && rgb.b >= 253) {
              return null;
            }
            let bestId = null;
            let bestDistance = Infinity;
            for (const entry of abwWrikeThemeCatalog) {
              const dr = rgb.r - entry.rgb[0];
              const dg = rgb.g - entry.rgb[1];
              const db = rgb.b - entry.rgb[2];
              const distance = Math.hypot(dr, dg, db);
              if (distance < bestDistance) {
                bestDistance = distance;
                bestId = entry.id;
              }
            }
            return bestDistance <= 42 ? bestId : null;
          };
          const abwElementIdentityText = (element) => {
            if (!(element instanceof Element)) return "";
            const parts = [element.className, element.id];
            if (element.attributes) {
              for (let index = 0; index < element.attributes.length; index += 1) {
                const attr = element.attributes[index];
                if (attr && /theme|skin|palette|appearance|background/i.test(attr.name)) {
                  parts.push(`${attr.name}=${attr.value}`);
                }
              }
            }
            return parts.filter(Boolean).join(" ");
          };
          const abwDetectWrikeThemeFromDom = () => {
            if (!document.body) return null;
            for (const root of [document.documentElement, document.body]) {
              const directMatch = abwMatchWrikeThemeText(abwElementIdentityText(root));
              if (directMatch) return directMatch;
            }
            const samplePoints = [
              [14, 96],
              [18, 160],
              [24, 240],
              [28, 340],
              [18, 440],
              [72, 120]
            ];
            const candidates = [];
            const seen = new Set();
            const addCandidate = (element) => {
              if (!(element instanceof Element) || seen.has(element)) return;
              seen.add(element);
              candidates.push(element);
            };
            for (const [x, y] of samplePoints) {
              const stack =
                document.elementsFromPoint?.(x, y) ||
                [document.elementFromPoint?.(x, y)].filter(Boolean);
              for (const node of stack) {
                for (
                  let current = node;
                  current && current instanceof Element;
                  current = current.parentElement
                ) {
                  addCandidate(current);
                }
              }
            }
            document
              .querySelectorAll(
                'aside, nav, [role="navigation"], [class*="sidebar" i], [class*="navigation" i], [class*="left-panel" i], [class*="workspace" i], [data-theme]'
              )
              .forEach(addCandidate);
            addCandidate(document.body);
            addCandidate(document.documentElement);

            const sidebarCandidates = [];
            const layoutCandidates = [];
            for (const element of candidates) {
              if (element.closest?.('[role="dialog"], [aria-modal="true"]')) {
                continue;
              }
              const byText = abwMatchWrikeThemeText(abwElementIdentityText(element));
              if (byText) return byText;
              const rect = element.getBoundingClientRect?.();
              if (!rect || rect.width < 28 || rect.height < 110 || rect.left > 32) {
                continue;
              }
              if (rect.width <= 380) {
                sidebarCandidates.push(element);
              } else {
                layoutCandidates.push(element);
              }
            }

            const matchFromElements = (elements, allowPureWhite) => {
              for (const element of elements) {
                const style = window.getComputedStyle(element);
                if (style.visibility === "hidden" || style.display === "none") continue;
                const colors = [
                  ...abwExtractCssColors(style.backgroundColor),
                  ...abwExtractCssColors(style.backgroundImage)
                ];
                for (const color of colors) {
                  const matched = abwMatchWrikeThemeColor(color, allowPureWhite);
                  if (matched) return matched;
                }
              }
              return null;
            };

            return (
              matchFromElements(sidebarCandidates, true) ||
              matchFromElements(layoutCandidates, false)
            );
          };
          const abwSyncWrikeContentCorner = () => {
            if (abwAutoDownload || !document.body) return;
            const cornerId = "abw-wrike-corner";
            const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
            const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
            if (viewportHeight < 200 || viewportWidth < 300) return;

            const parseRgb = (color) => {
              const match = String(color || "").match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
              if (!match) return null;
              const alpha = match[4] === undefined ? 1 : Number(match[4]);
              if (alpha <= 0.05) return null;
              return [Number(match[1]), Number(match[2]), Number(match[3])];
            };

            const resolveBackgroundColor = (element) => {
              for (let node = element; node && node instanceof Element; node = node.parentElement) {
                const style = window.getComputedStyle(node);
                if (style.visibility === "hidden" || style.display === "none") continue;
                const bg = style.backgroundColor || "";
                if (parseRgb(bg)) {
                  return bg;
                }
                const extracted = abwExtractCssColors(style.backgroundImage);
                if (extracted.length > 0) {
                  const { r, g, b } = extracted[0];
                  return `rgb(${r}, ${g}, ${b})`;
                }
              }
              return "";
            };

            const isNearWhite = (color) => {
              const rgb = parseRgb(color);
              return Boolean(rgb && rgb[0] >= 235 && rgb[1] >= 235 && rgb[2] >= 235);
            };

            let cornerLeft = null;
            let cornerTop = 0;

            // 1. Primary: find the main white content container directly.
            const contentProbeX = Math.round(viewportWidth * 0.6);
            for (const py of [32, 80, 140]) {
              const stack =
                document.elementsFromPoint?.(contentProbeX, py) ||
                [document.elementFromPoint?.(contentProbeX, py)].filter(Boolean);
              for (const node of stack) {
                if (!(node instanceof Element) || node.id === cornerId) continue;
                if (node === document.body || node === document.documentElement) continue;
                if (node.closest?.('[role="dialog"], [aria-modal="true"]')) continue;
                const rect = node.getBoundingClientRect?.();
                if (
                  !rect ||
                  rect.left < 44 ||
                  rect.left > Math.min(420, viewportWidth * 0.48) ||
                  rect.top < 0 ||
                  rect.top > 48 ||
                  rect.width < viewportWidth * 0.45 ||
                  rect.height < viewportHeight * 0.6
                ) {
                  continue;
                }
                const style = window.getComputedStyle(node);
                if (style.visibility === "hidden" || style.display === "none") continue;
                if (isNearWhite(style.backgroundColor)) {
                  cornerLeft = rect.left;
                  cornerTop = Math.max(0, rect.top);
                  break;
                }
              }
              if (cornerLeft !== null) break;
            }

            // 2. Fallback: find the left sidebar column and use its right edge.
            let sidebarColor = "";
            for (const [px, py] of [[18, 24], [18, 140], [18, Math.round(viewportHeight * 0.45)], [56, 140]]) {
              const stack =
                document.elementsFromPoint?.(px, py) ||
                [document.elementFromPoint?.(px, py)].filter(Boolean);
              for (const node of stack) {
                for (
                  let current = node;
                  current && current instanceof Element && current !== document.body && current !== document.documentElement;
                  current = current.parentElement
                ) {
                  if (current.id === cornerId || current.closest?.('[role="dialog"], [aria-modal="true"]')) {
                    continue;
                  }
                  const rect = current.getBoundingClientRect?.();
                  if (
                    !rect ||
                    rect.left > 8 ||
                    rect.top > 60 ||
                    rect.width < 44 ||
                    rect.width > Math.min(420, viewportWidth * 0.48) ||
                    rect.height < viewportHeight * 0.6
                  ) {
                    continue;
                  }
                  const style = window.getComputedStyle(current);
                  if (style.visibility === "hidden" || style.display === "none") continue;
                  const bg = resolveBackgroundColor(current);
                  if (!bg || isNearWhite(bg)) continue;
                  sidebarColor = bg;
                  if (cornerLeft === null) {
                    cornerLeft = rect.right;
                    cornerTop = Math.max(0, rect.top);
                  }
                  break;
                }
                if (sidebarColor) break;
              }
              if (sidebarColor) break;
            }

            if (!sidebarColor) {
              const topLeftNode = document.elementFromPoint?.(16, 16);
              if (topLeftNode instanceof Element) {
                const bg = resolveBackgroundColor(topLeftNode);
                if (bg && !isNearWhite(bg)) {
                  sidebarColor = bg;
                }
              }
            }

            const existing = document.getElementById(cornerId);
            if (cornerLeft === null || !sidebarColor || cornerLeft <= 0 || cornerLeft >= viewportWidth - 60) {
              existing?.remove();
              return;
            }

            const corner = existing || document.createElement("div");
            if (!existing) {
              corner.id = cornerId;
              corner.setAttribute("aria-hidden", "true");
              Object.assign(corner.style, {
                position: "fixed",
                width: "13px",
                height: "13px",
                pointerEvents: "none",
                zIndex: "2147483646",
                lineHeight: "0"
              });
              corner.innerHTML = `<svg width="13" height="13" viewBox="-1 -1 13 13" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M-1 -1H12V0A12 12 0 0 0 0 12H-1Z" fill="currentColor"/></svg>`;
              document.body.append(corner);
            }
            corner.style.left = `${Math.floor(cornerLeft) - 1}px`;
            corner.style.top = `${Math.floor(cornerTop) - 1}px`;
            corner.style.color = sidebarColor;
          };
          const abwDetectWrikeInboxUnread = () => {
            if (abwAutoDownload || !document.body) return false;
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const node = walker.currentNode;
              const raw = (node.textContent || "").trim();
              if (!/^inbox$/i.test(raw)) continue;
              const parent = node.parentElement;
              if (!parent) continue;
              const rect = parent.getBoundingClientRect?.();
              if (!rect || rect.width === 0 || rect.height === 0 || rect.left > 380) continue;

              let row = parent;
              for (let depth = 0; depth < 6 && row.parentElement; depth += 1) {
                const next = row.parentElement;
                const nextRect = next.getBoundingClientRect?.();
                if (!nextRect || nextRect.height > 76 || nextRect.width > 420 || nextRect.left > 380) {
                  break;
                }
                row = next;
                const rowText = (row.textContent || "").replace(/\s+/g, " ").trim();
                const match = rowText.match(/\b(\d+)\+?(?:\s|$)/);
                if (match && Number.parseInt(match[1], 10) > 0) {
                  return true;
                }
              }
            }
            return false;
          };
          const abwReportWrikeTheme = (force = false) => {
            if (abwAutoDownload) return null;
            abwSyncWrikeContentCorner();
            const hasUnread = abwDetectWrikeInboxUnread();
            if (window.__abwLastInboxUnread !== hasUnread) {
              window.__abwLastInboxUnread = hasUnread;
              window.setTimeout(() => {
                window.location.href = `abw-inbox://unread?hasUnread=${hasUnread ? "true" : "false"}`;
              }, 40);
            }
            const detected = abwDetectWrikeThemeFromDom();
            if (!detected) return null;
            if (!force && window.__abwLastDetectedWrikeTheme === detected) {
              return detected;
            }
            if (document.readyState && document.readyState !== "complete") {
              window.addEventListener(
                "load",
                () => abwReportWrikeTheme(true),
                { once: true }
              );
              return detected;
            }
            window.__abwLastDetectedWrikeTheme = detected;
            window.location.href = `abw-theme://detected?theme=${encodeURIComponent(detected)}`;
            return detected;
          };
          const abwScheduleThemeDetect = (delay = 180) => {
            if (abwAutoDownload || abwThemeDetectTimer) return;
            abwThemeDetectTimer = window.setTimeout(() => {
              abwThemeDetectTimer = 0;
              abwReportWrikeTheme(false);
            }, delay);
          };
          window.__abwDetectWrikeTheme = (force = false) => abwReportWrikeTheme(Boolean(force));
          const apply = () => {
            document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]')
              .forEach((element) => {
                if (element.spellcheck !== enabled) element.spellcheck = enabled;
              });
            abwScheduleThemeDetect(150);
          };
          const scheduleApply = () => {
            if (abwSpellApplyTimer) return;
            abwSpellApplyTimer = window.setTimeout(() => {
              abwSpellApplyTimer = 0;
              apply();
            }, 50);
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
            while (walker.nextNode()) {
              const node = walker.currentNode;
              const text = node.textContent || "";
              if (!/[\p{L}\p{N}]/u.test(text)) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
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
          const closeDictionaryMenu = () => {
            document.getElementById("abw-dictionary-menu")?.remove();
            document.getElementById("abw-link-menu")?.remove();
          };
          const abwResolveLinkUrl = (target) => {
            if (!(target instanceof Element)) return null;
            const link = target.closest("a[href], [data-href], [data-url]");
            if (link) {
              const raw =
                link.getAttribute("href") ||
                link.getAttribute("data-href") ||
                link.getAttribute("data-url") ||
                "";
              if (raw && !raw.startsWith("javascript:") && !raw.startsWith("#")) {
                try {
                  const resolved = new URL(raw, window.location.href);
                  if (resolved.protocol === "https:" || resolved.protocol === "http:") {
                    return resolved.href;
                  }
                } catch {}
              }
            }
            const item = target.closest("[data-task-id], [data-id], [data-item-id]");
            if (item) {
              const id =
                item.getAttribute("data-task-id") ||
                item.getAttribute("data-item-id") ||
                item.getAttribute("data-id") ||
                "";
              if (/^\d{5,}$/.test(id.trim())) {
                return `https://www.wrike.com/open.htm?id=${id.trim()}`;
              }
            }
            return null;
          };
          const showLinkContextMenu = (url, event) => {
            closeDictionaryMenu();
            const menu = document.createElement("div");
            menu.id = "abw-link-menu";
            menu.setAttribute("role", "menu");
            Object.assign(menu.style, {
              position: "fixed",
              left: `${Math.min(window.innerWidth - 200, Math.max(8, event.clientX))}px`,
              top: `${Math.min(window.innerHeight - 150, Math.max(8, event.clientY))}px`,
              zIndex: "2147483647",
              minWidth: "184px",
              padding: "6px",
              border: "1px solid #d6dce8",
              borderRadius: "8px",
              background: "#fff",
              color: "#17233a",
              boxShadow: "0 12px 32px rgba(17, 29, 59, .18)",
              font: "13px Segoe UI, sans-serif",
              display: "flex",
              flexDirection: "column",
              gap: "2px"
            });
            const addMenuItem = (label, onClick) => {
              const btn = document.createElement("button");
              btn.type = "button";
              btn.textContent = label;
              Object.assign(btn.style, {
                textAlign: "left",
                padding: "7px 10px",
                border: "0",
                borderRadius: "6px",
                background: "transparent",
                color: "#17233a",
                font: "13px Segoe UI, sans-serif",
                cursor: "pointer"
              });
              btn.addEventListener("mouseenter", () => { btn.style.background = "#f1f5fb"; });
              btn.addEventListener("mouseleave", () => { btn.style.background = "transparent"; });
              btn.addEventListener("click", () => {
                closeDictionaryMenu();
                onClick();
              });
              menu.append(btn);
            };
            addMenuItem("Open in new tab", () => {
              window.location.href = `abw-new-tab://open?url=${encodeURIComponent(url)}`;
            });
            addMenuItem("Copy link", () => {
              navigator.clipboard?.writeText(url).catch(() => undefined);
            });
            const sep = document.createElement("div");
            Object.assign(sep.style, { height: "1px", background: "#e5ebf4", margin: "4px 6px" });
            menu.append(sep);
            addMenuItem("Share", () => {
              window.location.href = `abw-share://open?url=${encodeURIComponent(url)}`;
            });
            document.body.append(menu);
            window.setTimeout(() => document.addEventListener("click", closeDictionaryMenu, { once: true, capture: true }), 0);
          };
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
          const handleLinkContextMenu = (event) => {
            if (event.defaultPrevented || findEditable(event.target)) {
              return;
            }
            const linkUrl = abwResolveLinkUrl(event.target);
            if (linkUrl) {
              event.preventDefault();
              showLinkContextMenu(linkUrl, event);
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
            for (let current = element; current && current !== document.body; current = current.parentElement) {
              const text = (current.textContent || "").trim();
              if (text.length > 240) continue;
              const match = text.match(abwSupportedFileName);
              if (match) return match[0].trim();
            }
            return "";
          };
          const abwNormalizeFileName = (value) =>
            String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
          let abwPreviewDownloadTimer = 0;
          let abwPreviewDownloadRequest = 0;
          let abwExpectingDownloadUntil = 0;
          const abwQueuePreviewDownload = (fileName = "") => {
            window.clearInterval(abwPreviewDownloadTimer);
            const request = ++abwPreviewDownloadRequest;
            const expectedFileName = abwNormalizeFileName(fileName);
            const previousDialogs = new Map(
              Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
                .filter(abwIsVisible)
                .map((root) => [root, abwNormalizeFileName(root.textContent)])
            );
            let attempts = 0;
            abwPreviewDownloadTimer = window.setInterval(() => {
              if (request !== abwPreviewDownloadRequest) {
                window.clearInterval(abwPreviewDownloadTimer);
                return;
              }
              attempts += 1;
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
                  window.clearInterval(abwPreviewDownloadTimer);
                  abwExpectingDownloadUntil = Date.now() + 5000;
                  download.click();
                  return;
                }
              }
              if (attempts >= 60) window.clearInterval(abwPreviewDownloadTimer);
            }, 250);
          };
          const abwKeepDownloadsInWebview = (event) => {
            abwScheduleThemeDetect(220);
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
          const start = () => {
            apply();
            let observer = null;
            if (enabled && document.body) {
              observer = new MutationObserver(scheduleApply);
              observer.observe(document.body, {
                childList: true,
                subtree: true
              });
            }
            const themeObserver = new MutationObserver(() => abwScheduleThemeDetect(150));
            const themeObserverOptions = {
              attributes: true,
              attributeFilter: ["class", "style", "data-theme"]
            };
            if (document.documentElement) {
              themeObserver.observe(document.documentElement, themeObserverOptions);
            }
            themeObserver.observe(document.body, themeObserverOptions);
            window.__abwSpellCleanup = () => {
              window.clearTimeout(abwSpellApplyTimer);
              window.clearTimeout(abwThemeDetectTimer);
              observer?.disconnect();
              themeObserver.disconnect();
            };
            if (!window.__abwContextMenuGuard) {
              document.addEventListener('contextmenu', keepWrikeEditorToolsVisible, true);
              document.addEventListener('contextmenu', handleLinkContextMenu, false);
              document.addEventListener('mousedown', (event) => {
                if (event.button === 1 && abwResolveLinkUrl(event.target)) {
                  event.preventDefault();
                }
              }, true);
              document.addEventListener('auxclick', (event) => {
                if (event.button !== 1) return;
                const linkUrl = abwResolveLinkUrl(event.target);
                if (!linkUrl) return;
                event.preventDefault();
                event.stopPropagation();
                window.location.href = `abw-new-tab://open?url=${encodeURIComponent(linkUrl)}`;
              }, true);
              document.addEventListener('click', (event) => {
                if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || event.altKey) return;
                const linkUrl = abwResolveLinkUrl(event.target);
                if (!linkUrl) return;
                event.preventDefault();
                event.stopPropagation();
                window.location.href = `abw-new-tab://open?url=${encodeURIComponent(linkUrl)}`;
              }, true);
              window.__abwContextMenuGuard = true;
            }
            if (!window.__abwDownloadBridge) {
              document.addEventListener("click", abwKeepDownloadsInWebview, true);
              abwPatchWindowOpen();
              window.__abwDownloadBridge = true;
            }
            if (!window.__abwShortcutBridge) {
              document.addEventListener("keydown", abwHandleKeyboardShortcuts, true);
              window.__abwShortcutBridge = true;
            }
            window.addEventListener("load", () => abwScheduleThemeDetect(120), { once: true });
            window.addEventListener("resize", () => abwScheduleThemeDetect(80));
            document.addEventListener("click", () => abwScheduleThemeDetect(220), true);
            const inboxPollTimer = window.setInterval(() => {
              if (!document.hidden) abwScheduleThemeDetect(80);
            }, 8000);
            const prevCleanup = window.__abwSpellCleanup;
            window.__abwSpellCleanup = () => {
              window.clearInterval(inboxPollTimer);
              prevCleanup?.();
            };
            abwScheduleThemeDetect(350);
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
            .replace("__ABW_TASK_PO__", if auto_download { "" } else { include_str!("task-po.js") })
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
            close_wrike_tab,
            focus_wrike_tab,
            get_wrike_tab_state,
            get_settings,
            hide_wrike_tabs,
            updater::install_update,
            launch_wrike,
            list_downloads,
            notify_update_available,
            open_download,
            open_source_task,
            preview_spreadsheet,
            read_download,
            read_download_head,
            read_download_range,
            reset_app,
            resize_wrike_tabs,
            send_test_notification,
            set_update_badge,
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
}
