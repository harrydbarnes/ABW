use chrono::DateTime;
use serde::Serialize;
use std::{sync::Mutex, time::Duration};
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};

const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Default)]
pub struct PendingUpdateState(pub Mutex<Option<Update>>);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateCheckStatus {
    Available,
    UpToDate,
    NoRelease,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub status: UpdateCheckStatus,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum UpdateDownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
        downloaded: u64,
        content_length: Option<u64>,
    },
    Finished,
}

#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    pending: State<'_, PendingUpdateState>,
) -> Result<UpdateCheckResult, String> {
    let current_version = app.package_info().version.to_string();
    let updater = app
        .updater_builder()
        .timeout(UPDATE_CHECK_TIMEOUT)
        .build()
        .map_err(|error| friendly_check_error(&error))?;

    match updater.check().await {
        Ok(Some(update)) => {
            let result = UpdateCheckResult {
                status: UpdateCheckStatus::Available,
                current_version: update.current_version.clone(),
                latest_version: Some(update.version.clone()),
                notes: clean_release_notes(update.body.as_deref()),
                pub_date: update
                    .date
                    .and_then(|date| format_unix_timestamp(date.unix_timestamp())),
            };
            let mut guard = pending
                .0
                .lock()
                .map_err(|_| "Updater state lock failed.".to_owned())?;
            *guard = Some(update);
            Ok(result)
        }
        Ok(None) => {
            if let Ok(mut guard) = pending.0.lock() {
                *guard = None;
            }
            Ok(UpdateCheckResult {
                status: UpdateCheckStatus::UpToDate,
                current_version,
                latest_version: None,
                notes: None,
                pub_date: None,
            })
        }
        Err(error) if is_no_release_error(&error) => {
            if let Ok(mut guard) = pending.0.lock() {
                *guard = None;
            }
            Ok(UpdateCheckResult {
                status: UpdateCheckStatus::NoRelease,
                current_version,
                latest_version: None,
                notes: None,
                pub_date: None,
            })
        }
        Err(error) => Err(friendly_check_error(&error)),
    }
}

#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    pending: State<'_, PendingUpdateState>,
    on_event: Channel<UpdateDownloadEvent>,
) -> Result<(), String> {
    let mut update = {
        let mut guard = pending
            .0
            .lock()
            .map_err(|_| "Updater state lock failed.".to_owned())?;
        guard.take()
    };

    if update.is_none() {
        let updater = app
            .updater_builder()
            .timeout(UPDATE_CHECK_TIMEOUT)
            .build()
            .map_err(|error| friendly_check_error(&error))?;
        update = updater
            .check()
            .await
            .map_err(|error| friendly_check_error(&error))?;
    }

    let mut update =
        update.ok_or_else(|| "No update is currently available to install.".to_owned())?;
    update.timeout = Some(UPDATE_DOWNLOAD_TIMEOUT);

    let mut downloaded: u64 = 0;
    let mut started = false;
    let chunk_channel = on_event.clone();
    let finish_channel = on_event;

    let result = update
        .download_and_install(
            move |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = chunk_channel.send(UpdateDownloadEvent::Started { content_length });
                }
                downloaded = downloaded.saturating_add(chunk_length as u64);
                let _ = chunk_channel.send(UpdateDownloadEvent::Progress {
                    chunk_length,
                    downloaded,
                    content_length,
                });
            },
            move || {
                let _ = finish_channel.send(UpdateDownloadEvent::Finished);
            },
        )
        .await;

    if let Err(error) = result {
        if let Ok(mut guard) = pending.0.lock() {
            *guard = Some(update);
        }
        return Err(friendly_install_error(&error));
    }

    #[cfg(not(windows))]
    app.restart();

    Ok(())
}

fn is_no_release_error(error: &UpdaterError) -> bool {
    matches!(error, UpdaterError::ReleaseNotFound)
}

fn clean_release_notes(notes: Option<&str>) -> Option<String> {
    let trimmed = notes?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn format_unix_timestamp(seconds: i64) -> Option<String> {
    DateTime::from_timestamp(seconds, 0).map(|date_time| date_time.to_rfc3339())
}

fn friendly_check_error(error: &UpdaterError) -> String {
    match error {
        UpdaterError::Reqwest(inner) if inner.is_timeout() => {
            "Update check timed out. Check your internet connection and try again.".to_owned()
        }
        UpdaterError::Reqwest(_) | UpdaterError::Network(_) => {
            "Unable to reach GitHub Releases to check for updates. Check your connection and try again.".to_owned()
        }
        UpdaterError::TargetsNotFound(_) | UpdaterError::TargetNotFound(_) => {
            "This update does not include a Windows installer package yet.".to_owned()
        }
        _ => format!("Unable to check for updates: {error}"),
    }
}

fn friendly_install_error(error: &UpdaterError) -> String {
    match error {
        UpdaterError::Minisign(_)
        | UpdaterError::Base64(_)
        | UpdaterError::SignatureUtf8(_)
        | UpdaterError::SignedVersionMismatch { .. }
        | UpdaterError::MissingSignedVersion => {
            "The downloaded update failed signature verification and was not installed.".to_owned()
        }
        UpdaterError::Reqwest(inner) if inner.is_timeout() => {
            "Downloading the update timed out. Please try again.".to_owned()
        }
        UpdaterError::Reqwest(_) | UpdaterError::Network(_) => {
            "Unable to download the update package from GitHub Releases.".to_owned()
        }
        _ => format!("Unable to install the update: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_not_found_is_treated_as_no_release() {
        assert!(is_no_release_error(&UpdaterError::ReleaseNotFound));
        assert!(!is_no_release_error(&UpdaterError::EmptyEndpoints));
    }

    #[test]
    fn clean_release_notes_trims_and_skips_empty_notes() {
        assert_eq!(clean_release_notes(None), None);
        assert_eq!(clean_release_notes(Some("   \n\t ")), None);
        assert_eq!(
            clean_release_notes(Some("  Bug fixes and faster startup. \n")),
            Some("Bug fixes and faster startup.".to_owned())
        );
    }

    #[test]
    fn format_unix_timestamp_returns_rfc3339() {
        assert_eq!(
            format_unix_timestamp(1_763_112_600).as_deref(),
            Some("2025-11-14T09:30:00+00:00")
        );
    }

    #[test]
    fn update_check_result_serializes_with_expected_casing() {
        let json = serde_json::to_value(UpdateCheckResult {
            status: UpdateCheckStatus::Available,
            current_version: "0.1.2".to_owned(),
            latest_version: Some("0.1.3".to_owned()),
            notes: Some("In-app updates".to_owned()),
            pub_date: Some("2026-11-14T10:00:00+00:00".to_owned()),
        })
        .unwrap();

        assert_eq!(json["status"], "available");
        assert_eq!(json["currentVersion"], "0.1.2");
        assert_eq!(json["latestVersion"], "0.1.3");
        assert_eq!(json["notes"], "In-app updates");
        assert_eq!(json["pubDate"], "2026-11-14T10:00:00+00:00");
    }
}
