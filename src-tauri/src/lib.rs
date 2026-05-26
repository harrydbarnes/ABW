use calamine::{open_workbook_auto, Reader};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, WebviewWindowBuilder},
    AppHandle, Emitter, Manager, WebviewUrl,
};
use tauri_plugin_notification::NotificationExt;
use url::Url;
use uuid::Uuid;

const WRIKE_HOME: &str = "https://www.wrike.com/workspace.htm";
const MAX_PDF_PREVIEW_BYTES: u64 = 512 * 1024 * 1024;

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
        }
    }
}

#[derive(Clone)]
struct PendingDownload {
    source_url: Option<String>,
    source_label: String,
}

#[derive(Default)]
struct CaptureContext {
    pending: Mutex<HashMap<PathBuf, PendingDownload>>,
    page_title: Mutex<String>,
    page_url: Mutex<Option<String>>,
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
fn update_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    write_json(settings_path(&app)?, &settings)?;
    if let Some(window) = app.get_webview_window("wrike") {
        window
            .eval(&apply_spell_check_script(settings.spell_check))
            .map_err(|error| format!("Unable to apply spell-check preference: {error}"))?;
    }
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
async fn launch_wrike(app: AppHandle) -> Result<(), String> {
    open_wrike_at(&app, WRIKE_HOME)
}

#[tauri::command]
async fn open_source_task(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "Invalid source task link.".to_owned())?;
    let allowed_host = parsed
        .host_str()
        .is_some_and(|host| host == "wrike.com" || host.ends_with(".wrike.com"));
    if parsed.scheme() != "https" || !allowed_host {
        return Err("Only HTTPS Wrike task links may be opened inside ABW.".into());
    }
    open_wrike_at(&app, parsed.as_str())
}

fn open_wrike_at(app: &AppHandle, destination: &str) -> Result<(), String> {
    let parsed = Url::parse(destination).map_err(|error| format!("Invalid Wrike URL: {error}"))?;
    if let Some(window) = app.get_webview_window("wrike") {
        window
            .navigate(parsed)
            .map_err(|error| format!("Unable to open the task in Wrike: {error}"))?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let spell_check = read_settings(app)?.spell_check;
    let context = Arc::new(CaptureContext::default());
    let title_context = Arc::clone(&context);
    let navigation_context = Arc::clone(&context);
    let popup_context = Arc::clone(&context);
    let popup_app = app.clone();
    if let Ok(mut latest) = context.page_url.lock() {
        *latest = Some(destination.to_owned());
    }

    WebviewWindowBuilder::new(app, "wrike", WebviewUrl::External(parsed))
        .title("ABW - Wrike workspace")
        .inner_size(1360.0, 860.0)
        .min_inner_size(840.0, 600.0)
        .zoom_hotkeys_enabled(true)
        .initialization_script(&apply_spell_check_script(spell_check))
        .on_navigation(move |url| {
            let allowed = is_safe_remote_destination(url);
            if allowed {
                if let Ok(mut latest) = navigation_context.page_url.lock() {
                    *latest = Some(url.to_string());
                }
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
            let blank = Url::parse("about:blank").expect("about:blank is a valid URL");
            let child = WebviewWindowBuilder::new(
                &popup_app,
                label,
                WebviewUrl::External(blank),
            )
            .title("ABW - Wrike")
            .window_features(features)
            .zoom_hotkeys_enabled(true)
            .on_navigation(is_safe_remote_destination)
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
            ))
            .build();
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
        .on_document_title_changed(move |window, title| {
            if let Ok(mut latest) = title_context.page_title.lock() {
                *latest = title.clone();
            }
            let _ = window.set_title(&format!("ABW - {title}"));
        })
        .on_download(download_handler(app.clone(), Arc::clone(&context), None))
        .build()
        .map_err(|error| format!("Unable to open Wrike workspace: {error}"))?;
    Ok(())
}

fn download_handler(
    app: AppHandle,
    context: Arc<CaptureContext>,
    provenance_override: Option<PendingDownload>,
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
                    let Some(path) = path else {
                        emit_download_capture_error(
                            &app,
                            "Wrike completed a download without reporting its saved location.".into(),
                        );
                        return true;
                    };
                    let provenance = context
                        .pending
                        .lock()
                        .ok()
                        .and_then(|mut entries| entries.remove(&path))
                        .unwrap_or_else(|| captured_provenance(&context));
                    if let Err(error) = record_completed_download(&app, &path, provenance) {
                        emit_download_capture_error(&app, error);
                    }
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

fn is_safe_remote_destination(url: &Url) -> bool {
    url.scheme() == "https" || url.as_str() == "about:blank"
}

fn apply_spell_check_script(enabled: bool) -> String {
    format!(
        r#"
        (() => {{
          const enabled = {enabled};
          const apply = () => {{
            document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]')
              .forEach((element) => element.spellcheck = enabled);
          }};
          const start = () => {{
            apply();
            new MutationObserver(apply).observe(document.body, {{ childList: true, subtree: true }});
          }};
          if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, {{ once: true }});
        }})();
        "#
    )
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let settings = read_settings(app.handle()).map_err(std::io::Error::other)?;
            if settings.launch_wrike_on_start {
                open_wrike_at(app.handle(), WRIKE_HOME).map_err(std::io::Error::other)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            launch_wrike,
            list_downloads,
            open_download,
            open_source_task,
            preview_spreadsheet,
            read_download,
            send_test_notification,
            update_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running ABW");
}
