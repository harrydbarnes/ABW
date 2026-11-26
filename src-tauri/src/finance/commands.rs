use crate::finance::{
    build_snapshot, collect_new_alerts, export, merge_tickets, mx_bridge, normalize_order_ref,
    store, FinanceFavouriteFilter, FinanceSnapshot, MqsActionRequest, MqsActionResult, MqsSource,
    MxBuyerEntry, PrismaOrder, PrismaOrderActionRequest, PrismaOrderActionResult,
};
use crate::{persistence, po_bridge};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve ABW app data directory: {e}"))
}

fn dispatch_alerts(app: &AppHandle, alerts: Vec<(String, String)>) {
    for (title, body) in alerts.into_iter().take(4) {
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

fn parse_prisma_orders_from_json(rows: &[Value], now: &str) -> Vec<PrismaOrder> {
    let mut out = Vec::new();
    for item in rows {
        let str_field = |keys: &[&str]| -> String {
            for k in keys {
                if let Some(v) = item.get(*k) {
                    if let Some(s) = v.as_str() {
                        if !s.trim().is_empty() {
                            return s.trim().to_owned();
                        }
                    } else if v.is_number() {
                        return v.to_string();
                    }
                }
            }
            String::new()
        };
        let order_ver = str_field(&["orderVer", "orderId", "orderNumber", "order_ver"]);
        if order_ver.is_empty() {
            continue;
        }
        let order_total = item
            .get("orderTotal")
            .or_else(|| item.get("total"))
            .or_else(|| item.get("amount"))
            .and_then(|v| {
                v.as_f64().or_else(|| {
                    v.as_str().and_then(|s| {
                        let cleaned: String = s
                            .chars()
                            .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
                            .collect();
                        cleaned.parse::<f64>().ok()
                    })
                })
            })
            .unwrap_or(0.0);
        let due_in_days = item
            .get("dueInDays")
            .and_then(|v| v.as_i64())
            .map(|n| n as i32);

        out.push(PrismaOrder {
            order_base: normalize_order_ref(&order_ver),
            order_ver,
            status: str_field(&["status", "orderStatus"]),
            due_label: str_field(&["dueLabel", "dueStatus"]),
            due_in_days,
            media: str_field(&["media", "mediaName"]),
            order_type: str_field(&["orderType", "type"]),
            seller: str_field(&["seller", "supplier", "vendorName"]),
            media_id: str_field(&["mediaId", "mediaCode"]),
            client_id: str_field(&["clientId", "clientCode"]),
            product_id: str_field(&["productId", "productCode"]),
            estimate_id: str_field(&["estimateId", "estimateCode"]),
            order_total,
            currency: {
                let c = str_field(&["currency", "currencyCode"]);
                if c.is_empty() {
                    "GBP".to_owned()
                } else {
                    c
                }
            },
            campaign: str_field(&["campaign", "campaignName"]),
            campaign_id: str_field(&["campaignId", "campaignCode"]),
            dates: str_field(&["dates", "flightDates"]),
            start_date: str_field(&["startDate"]),
            end_date: str_field(&["endDate"]),
            buyer: str_field(&["buyer", "buyerName", "createdBy", "owner"]),
            agency: str_field(&["agency", "agencyCode"]),
            order_url: str_field(&["orderUrl", "url"]),
            last_seen_at: now.to_owned(),
        });
    }
    out
}

#[tauri::command]
pub async fn finance_load_state(app: AppHandle) -> Result<FinanceSnapshot, String> {
    let dir = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = store::load(&dir)?;
        state.sync_status.mx_running = mx_bridge::is_mx_running();
        state.sync_status.mx_environment = mx_bridge::active_mx_environment();
        state.sync_status.prisma_paired = po_bridge::is_paired();
        state.sync_status.digest_folder = state.digest_folder.clone();
        state.sync_status.last_error = None;
        Ok(build_snapshot(&state))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn finance_save_favourites(
    app: AppHandle,
    favourites: Vec<FinanceFavouriteFilter>,
    active_favourite_id: String,
    digest_folder: Option<String>,
) -> Result<FinanceSnapshot, String> {
    let dir = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (state, _) = store::update(&dir, |s| {
            if !favourites.is_empty() {
                s.favourites = favourites;
            }
            if !active_favourite_id.is_empty() {
                s.active_favourite_id = active_favourite_id;
            }
            if let Some(folder) = digest_folder {
                let trimmed = folder.trim().to_owned();
                s.digest_folder = if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                };
                s.sync_status.digest_folder = s.digest_folder.clone();
            }
            Ok(())
        })?;
        Ok(build_snapshot(&state))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn finance_update_ticket_note(
    app: AppHandle,
    ticket_no: String,
    notes: String,
) -> Result<FinanceSnapshot, String> {
    let dir = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (state, _) = store::update(&dir, |s| {
            if let Some(t) = s.tickets.iter_mut().find(|t| t.ticket_no == ticket_no) {
                t.local_notes = notes;
            }
            Ok(())
        })?;
        Ok(build_snapshot(&state))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn finance_list_mx_buyers(limit: Option<usize>) -> Result<Vec<MxBuyerEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(mx_bridge::list_mx_buyers(limit.unwrap_or(5000)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn finance_sync_mx(app: AppHandle) -> Result<FinanceSnapshot, String> {
    let dir = app_data_dir(&app)?;
    let app_for_notify = app.clone();
    let (snapshot, alerts) = tauri::async_runtime::spawn_blocking(move || {
        let now = persistence::now_rfc3339();
        let mx_running = mx_bridge::is_mx_running();
        let env = mx_bridge::active_mx_environment();

        let live_result = if mx_running {
            mx_bridge::sync_mx_live(&now)
        } else {
            Err("MX Media Explorer is not running.".to_owned())
        };

        let (state, alerts) = store::update(&dir, |s| {
            s.sync_status.mx_running = mx_running;
            s.sync_status.mx_environment = env.clone();
            s.sync_status.prisma_paired = po_bridge::is_paired();

            match live_result {
                Ok(tickets) => {
                    merge_tickets(&mut s.tickets, tickets, true);
                    s.sync_status.mx_last_sync_at = Some(now.clone());
                    s.sync_status.mx_last_source = Some(MqsSource::MxLive);
                    s.sync_status.last_error = None;
                }
                Err(err) => {
                    // Fallback to digest folder if configured
                    if let Some(folder) = s.digest_folder.clone() {
                        match mx_bridge::scan_digest_folder(std::path::Path::new(&folder), &now) {
                            Ok(digest_tickets) if !digest_tickets.is_empty() => {
                                merge_tickets(&mut s.tickets, digest_tickets, false);
                                s.sync_status.mx_last_sync_at = Some(now.clone());
                                s.sync_status.mx_last_source = Some(MqsSource::EmailDigest);
                                s.sync_status.last_error = Some(format!(
                                    "{err} Loaded tickets from digest folder instead."
                                ));
                            }
                            _ => {
                                s.sync_status.last_error = Some(err);
                            }
                        }
                    } else {
                        s.sync_status.last_error = Some(err);
                    }
                }
            }
            let alerts = collect_new_alerts(s);
            Ok(alerts)
        })?;
        Ok::<_, String>((build_snapshot(&state), alerts))
    })
    .await
    .map_err(|e| e.to_string())??;

    dispatch_alerts(&app_for_notify, alerts);
    Ok(snapshot)
}

#[tauri::command]
pub async fn finance_import_mqs_text(
    app: AppHandle,
    raw_text: String,
    source: Option<MqsSource>,
) -> Result<FinanceSnapshot, String> {
    let dir = app_data_dir(&app)?;
    let app_for_notify = app.clone();
    let (snapshot, alerts) = tauri::async_runtime::spawn_blocking(move || {
        let now = persistence::now_rfc3339();
        let src = source.unwrap_or(MqsSource::ManualImport);
        let mut tickets = mx_bridge::parse_mqs_text(&raw_text, src.clone(), &now);
        if tickets.is_empty() {
            return Err("No MQS ticket rows found in pasted text.".to_owned());
        }
        mx_bridge::enrich_tickets_from_medx(&mut tickets);
        let (state, alerts) = store::update(&dir, |s| {
            merge_tickets(&mut s.tickets, tickets, false);
            s.sync_status.mx_last_sync_at = Some(now.clone());
            s.sync_status.mx_last_source = Some(src);
            s.sync_status.last_error = None;
            let alerts = collect_new_alerts(s);
            Ok(alerts)
        })?;
        Ok::<_, String>((build_snapshot(&state), alerts))
    })
    .await
    .map_err(|e| e.to_string())??;

    dispatch_alerts(&app_for_notify, alerts);
    Ok(snapshot)
}

#[tauri::command]
pub async fn finance_import_mqs_file(
    app: AppHandle,
    file_path: Option<String>,
) -> Result<FinanceSnapshot, String> {
    let chosen: PathBuf = if let Some(p) = file_path {
        PathBuf::from(p)
    } else {
        let picked = app
            .dialog()
            .file()
            .add_filter(
                "MQS Export or Digest",
                &["xlsx", "xls", "csv", "tsv", "txt", "html", "htm", "eml"],
            )
            .blocking_pick_file();
        match picked {
            Some(f) => f
                .into_path()
                .map_err(|e| format!("Invalid selected file path: {e}"))?,
            None => return finance_load_state(app).await,
        }
    };

    let dir = app_data_dir(&app)?;
    let app_for_notify = app.clone();
    let (snapshot, alerts) = tauri::async_runtime::spawn_blocking(move || {
        let now = persistence::now_rfc3339();
        let tickets = mx_bridge::import_mqs_file(&chosen, MqsSource::EmailDigest, &now)?;
        if tickets.is_empty() {
            return Err("No MQS ticket rows were recognized in that file.".to_owned());
        }
        let (state, alerts) = store::update(&dir, |s| {
            merge_tickets(&mut s.tickets, tickets, false);
            s.sync_status.mx_last_sync_at = Some(now.clone());
            s.sync_status.mx_last_source = Some(MqsSource::EmailDigest);
            s.sync_status.last_error = None;
            let alerts = collect_new_alerts(s);
            Ok(alerts)
        })?;
        Ok::<_, String>((build_snapshot(&state), alerts))
    })
    .await
    .map_err(|e| e.to_string())??;

    dispatch_alerts(&app_for_notify, alerts);
    Ok(snapshot)
}

#[tauri::command]
pub async fn finance_pick_digest_folder(app: AppHandle) -> Result<FinanceSnapshot, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    let Some(folder) = picked else {
        return finance_load_state(app).await;
    };
    let folder_path = folder
        .into_path()
        .map_err(|e| format!("Invalid folder path: {e}"))?;
    let folder_str = folder_path.to_string_lossy().into_owned();
    let dir = app_data_dir(&app)?;
    let app_for_notify = app.clone();
    let (snapshot, alerts) = tauri::async_runtime::spawn_blocking(move || {
        let now = persistence::now_rfc3339();
        let tickets = mx_bridge::scan_digest_folder(&folder_path, &now).unwrap_or_default();
        let (state, alerts) = store::update(&dir, |s| {
            s.digest_folder = Some(folder_str.clone());
            s.sync_status.digest_folder = Some(folder_str);
            if !tickets.is_empty() {
                merge_tickets(&mut s.tickets, tickets, false);
                s.sync_status.mx_last_sync_at = Some(now.clone());
                s.sync_status.mx_last_source = Some(MqsSource::EmailDigest);
            }
            let alerts = collect_new_alerts(s);
            Ok(alerts)
        })?;
        Ok::<_, String>((build_snapshot(&state), alerts))
    })
    .await
    .map_err(|e| e.to_string())??;

    dispatch_alerts(&app_for_notify, alerts);
    Ok(snapshot)
}

#[tauri::command]
pub async fn finance_sync_prisma(app: AppHandle) -> Result<FinanceSnapshot, String> {
    let dir = app_data_dir(&app)?;
    let app_for_notify = app.clone();
    let (snapshot, alerts) = tauri::async_runtime::spawn_blocking(move || {
        let now = persistence::now_rfc3339();
        let response = po_bridge::run_finance_job(
            "prisma_orders_sync",
            json!({ "includeAccepted": true }),
            70,
        );
        let (state, alerts) = store::update(&dir, |s| {
            s.sync_status.prisma_paired = po_bridge::is_paired();
            match response {
                Ok(val) => {
                    if let Some(err) = val.get("error").and_then(|v| v.as_str()) {
                        s.sync_status.last_error = Some(err.to_owned());
                    } else if let Some(arr) = val.get("orders").and_then(|v| v.as_array()) {
                        s.orders = parse_prisma_orders_from_json(arr, &now);
                        s.sync_status.prisma_last_sync_at = Some(now.clone());
                        s.sync_status.last_error = None;
                    } else {
                        s.sync_status.last_error = Some(
                            "Ops Toolshed returned an unexpected Prisma Orders payload.".to_owned(),
                        );
                    }
                }
                Err(err) => {
                    s.sync_status.last_error = Some(err);
                }
            }
            let alerts = collect_new_alerts(s);
            Ok(alerts)
        })?;
        Ok::<_, String>((build_snapshot(&state), alerts))
    })
    .await
    .map_err(|e| e.to_string())??;

    dispatch_alerts(&app_for_notify, alerts);
    Ok(snapshot)
}

#[tauri::command]
pub async fn finance_focus_mx() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(mx_bridge::focus_mx_window)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn finance_run_mx_action(request: MqsActionRequest) -> Result<MqsActionResult, String> {
    tauri::async_runtime::spawn_blocking(move || mx_bridge::execute_mx_action(&request))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn finance_run_prisma_action(
    request: PrismaOrderActionRequest,
) -> Result<PrismaOrderActionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let val = po_bridge::run_finance_job(
            "prisma_order_action",
            json!({
                "orderVer": request.order_ver,
                "action": request.action,
                "reason": request.reason,
            }),
            45,
        )?;
        Ok(PrismaOrderActionResult {
            ok: val.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            status: val
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_owned(),
            message: val
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Completed.")
                .to_owned(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn finance_export_xlsx(
    app: AppHandle,
    favourite_id: String,
) -> Result<Option<String>, String> {
    let dir = app_data_dir(&app)?;
    let state = store::load(&dir)?;
    let snapshot = build_snapshot(&state);
    let fav = snapshot
        .favourites
        .iter()
        .find(|f| f.id == favourite_id)
        .cloned()
        .unwrap_or_else(|| snapshot.favourites[0].clone());

    let safe_name: String = fav
        .name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let default_file = format!("ABW_Finance_{safe_name}.xlsx");

    let picked = app
        .dialog()
        .file()
        .set_file_name(&default_file)
        .add_filter("Excel Workbook", &["xlsx"])
        .blocking_save_file();

    let Some(dest) = picked else {
        return Ok(None);
    };
    let dest_path = dest
        .into_path()
        .map_err(|e| format!("Invalid export path: {e}"))?;

    let now = persistence::now_rfc3339();
    tauri::async_runtime::spawn_blocking(move || {
        export::export_xlsx(&snapshot, &fav, &now, &dest_path)?;
        Ok(Some(dest_path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}
