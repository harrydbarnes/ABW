use calamine::{open_workbook_auto, Reader};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{
    webview::{
        DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder, WebviewWindowBuilder,
    },
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl,
};
use tauri_plugin_notification::NotificationExt;
use url::Url;
use uuid::Uuid;

const WRIKE_HOME: &str = "https://www.wrike.com/workspace.htm";
const MAX_PDF_PREVIEW_BYTES: u64 = 512 * 1024 * 1024;
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
    custom_dictionary: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkbookSheet {
    name: String,
    rows: Vec<Vec<String>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkbookPreview {
    sheets: Vec<WorkbookSheet>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            spell_check: true,
            launch_wrike_on_start: true,
            download_notifications: true,
            custom_dictionary: Vec::new(),
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

#[derive(Default)]
struct AppState {
    wrike_tabs: Mutex<HashMap<String, Arc<CaptureContext>>>,
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
fn list_downloads(app: AppHandle) -> Result<Vec<DownloadRecord>, String> {
    read_records(&app)
}

#[tauri::command]
fn read_download(app: AppHandle, id: String) -> Result<Vec<u8>, String> {
    let path = tracked_path(&app, &id)?;
    let size = fs::metadata(&path)
        .map_err(|error| format!("Unable to inspect download: {error}"))?
        .len();
    if size > MAX_PDF_PREVIEW_BYTES {
        return Err(format!(
            "This PDF is {} MB. In-app PDF preview currently supports files up to 512 MB.",
            size.div_ceil(1024 * 1024)
        ));
    }
    fs::read(path).map_err(|error| format!("Unable to read download: {error}"))
}

#[tauri::command]
fn preview_spreadsheet(app: AppHandle, id: String) -> Result<WorkbookPreview, String> {
    let path = tracked_path(&app, &id)?;
    let mut workbook = open_workbook_auto(path)
        .map_err(|error| format!("Unable to open spreadsheet: {error}"))?;
    let sheets = workbook
        .sheet_names()
        .to_owned()
        .into_iter()
        .map(|name| {
            let rows = workbook
                .worksheet_range(&name)
                .map(|range| {
                    range
                        .rows()
                        .take(250)
                        .map(|row| row.iter().take(50).map(ToString::to_string).collect())
                        .collect()
                })
                .unwrap_or_default();
            WorkbookSheet { name, rows }
        })
        .collect();
    Ok(WorkbookPreview { sheets })
}

#[tauri::command]
fn open_download(app: AppHandle, id: String) -> Result<(), String> {
    let path = tracked_path(&app, &id)?;
    open::that(path).map_err(|error| format!("Unable to open file in Windows: {error}"))
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
    let previous = read_settings(&app).unwrap_or_default();
    settings.custom_dictionary = normalize_dictionary(settings.custom_dictionary);
    write_json(settings_path(&app)?, &settings)?;
    sync_windows_spelling_dictionary(&previous.custom_dictionary, &settings.custom_dictionary);
    let script = apply_spell_check_script(settings.spell_check);
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
    app.emit("settings-updated", settings.clone())
        .map_err(|error| format!("Unable to refresh settings: {error}"))?;
    Ok(settings)
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
async fn open_source_task(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "Invalid source task link.".to_owned())?;
    let allowed_host = parsed
        .host_str()
        .is_some_and(|host| host == "wrike.com" || host.ends_with(".wrike.com"));
    if parsed.scheme() != "https" || !allowed_host {
        return Err("Only HTTPS Wrike task links may be opened inside ABW.".into());
    }
    open_wrike_at(&app, state.inner(), "home", parsed.as_str(), true)
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
    let scale = host.scale_factor().map_err(|error| error.to_string())?;
    let host_size = host
        .inner_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    let content_size = LogicalSize::new(
        host_size.width,
        (host_size.height - TASKBAR_HEIGHT).max(1.0),
    );
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
        .initialization_script(&apply_spell_check_script(spell_check))
        .on_navigation(move |url| {
            if url.scheme() == "abw-dictionary" {
                let _ = add_custom_dictionary_word(&navigation_app, url);
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
                WebviewUrl::External(url),
            )
            .title("ABW - Wrike")
            .window_features(features)
            .skip_taskbar(true)
            .zoom_hotkeys_enabled(true)
            .initialization_script(&apply_spell_check_script(spell_check))
            .on_navigation(is_safe_remote_destination)
            .on_page_load(move |window, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished)
                    && is_wrike_workspace_destination(payload.url())
                {
                    if let Some(workspace) = completion_app.get_webview(&completion_workspace_label) {
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
        .on_download(download_handler(app.clone(), Arc::clone(&context), None, false));
    host.add_child(
        builder,
        LogicalPosition::new(0.0, TASKBAR_HEIGHT),
        content_size,
    )
        .map_err(|error| format!("Unable to open Wrike workspace: {error}"))?;
    emit_wrike_tab_update(app, &context);
    Ok(())
}

fn download_handler(
    app: AppHandle,
    context: Arc<CaptureContext>,
    provenance_override: Option<PendingDownload>,
    close_webview_on_finish: bool,
) -> impl Fn(tauri::Webview, DownloadEvent<'_>) -> bool + Send + Sync + 'static {
    move |webview, event| {
        match event {
            DownloadEvent::Requested { url: _, destination } => {
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
                let provenance = provenance_override.clone().unwrap_or_else(|| PendingDownload {
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
                            "Wrike completed a download without reporting its saved location.".into(),
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
    let size_bytes = fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0);
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
    let mut records = read_records(app)?;
    records.insert(0, record);
    write_json(records_path(app)?, &records)?;
    if read_settings(app)?.download_notifications {
        let _ = app
            .notification()
            .builder()
            .title("Download saved to ABW Files")
            .body(format!("{notification_file_name} is ready to preview."))
            .show();
    }
    app.emit("downloads-updated", ())
        .map_err(|error| format!("Unable to refresh Files view: {error}"))
}

fn read_records(app: &AppHandle) -> Result<Vec<DownloadRecord>, String> {
    read_json_or_default(records_path(app)?)
}

fn read_settings(app: &AppHandle) -> Result<Settings, String> {
    read_json_or_default(settings_path(app)?)
}

fn read_json_or_default<T>(path: PathBuf) -> Result<T, String>
where
    T: for<'a> Deserialize<'a> + Default,
{
    if !path.exists() {
        return Ok(T::default());
    }
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Unable to read application data: {error}"))?;
    serde_json::from_str(&contents).map_err(|error| format!("Invalid application data: {error}"))
}

fn write_json<T: Serialize>(path: PathBuf, value: &T) -> Result<(), String> {
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory)
            .map_err(|error| format!("Unable to create application directory: {error}"))?;
    }
    let contents = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Unable to serialise application data: {error}"))?;
    fs::write(path, contents).map_err(|error| format!("Unable to save application data: {error}"))
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
    let extension = original.extension().and_then(|extension| extension.to_str());
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

fn normalize_dictionary_word(word: &str) -> Option<String> {
    let trimmed = word
        .trim()
        .trim_matches(|character: char| !character.is_alphanumeric() && character != '-' && character != '\'');
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_owned())
}

fn add_custom_dictionary_word(app: &AppHandle, url: &Url) -> Result<(), String> {
    let word = url
        .query_pairs()
        .find_map(|(key, value)| (key == "word").then(|| value.into_owned()))
        .and_then(|word| normalize_dictionary_word(&word))
        .ok_or_else(|| "No dictionary word was provided.".to_owned())?;
    let mut settings = read_settings(app)?;
    let previous = settings.custom_dictionary.clone();
    settings.custom_dictionary.push(word);
    settings.custom_dictionary = normalize_dictionary(settings.custom_dictionary);
    write_json(settings_path(app)?, &settings)?;
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
            new_words.iter().any(|word| word.eq_ignore_ascii_case(entry))
                || !old_words.iter().any(|word| word.eq_ignore_ascii_case(entry))
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
    url.scheme() == "https" || url.as_str() == "about:blank"
}

fn is_wrike_workspace_destination(url: &Url) -> bool {
    let is_wrike = url
        .host_str()
        .is_some_and(|host| host == "wrike.com" || host.ends_with(".wrike.com"));
    url.scheme() == "https" && is_wrike && url.path().ends_with("/workspace.htm")
}

fn apply_spell_check_script(enabled: bool) -> String {
    let enabled_literal = if enabled { "true" } else { "false" };
    r##"
        (() => {
          const enabled = __ABW_SPELL_CHECK_ENABLED__;
          const apply = () => {
            document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]')
              .forEach((element) => element.spellcheck = enabled);
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
            return (text.match(/[\\p{L}\\p{N}][\\p{L}\\p{N}'-]*/u) || [])[0] || "";
          };
          const wordFromText = (text, offset) => {
            if (!text) return "";
            let start = Math.max(0, Math.min(offset, text.length));
            let end = start;
            while (start > 0 && /[\\p{L}\\p{N}'-]/u.test(text[start - 1])) start -= 1;
            while (end < text.length && /[\\p{L}\\p{N}'-]/u.test(text[end])) end += 1;
            return text.slice(start, end);
          };
          const nearestTextWord = (root, event) => {
            if (!root) return "";
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let best = "";
            while (walker.nextNode()) {
              const node = walker.currentNode;
              const text = node.textContent || "";
              if (!/[\\p{L}\\p{N}]/u.test(text)) continue;
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
          const start = () => {
            apply();
            new MutationObserver(apply).observe(document.body, { childList: true, subtree: true });
            if (!window.__abwContextMenuGuard) {
              document.addEventListener('contextmenu', keepWrikeEditorToolsVisible, true);
              window.__abwContextMenuGuard = true;
            }
          };
          if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
        })();
        "##
    .replace("__ABW_SPELL_CHECK_ENABLED__", enabled_literal)
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            close_wrike_tab,
            get_wrike_tab_state,
            get_settings,
            hide_wrike_tabs,
            launch_wrike,
            list_downloads,
            open_download,
            open_source_task,
            preview_spreadsheet,
            read_download,
            send_test_notification,
            update_settings,
            wrike_tab_action
        ])
        .run(tauri::generate_context!())
        .expect("error while running ABW");
}
