use crate::finance::{MqsActionRequest, MqsActionResult, MqsSource, MqsTicket, MxBuyerEntry};
use crate::spreadsheet;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default)]
pub struct MedxInvoiceMeta {
    pub payee_name: String,
    pub client_code: String,
    pub issued_date: String,
    pub gross: Option<f64>,
    pub net_payable: Option<f64>,
    pub total_payable: Option<f64>,
    pub attachments: Vec<String>,
}

/// Cleans Mediaocean Azure attachment strings (separated by `#]`) into readable filenames.
pub fn parse_medx_attachments(raw: &str) -> Vec<String> {
    raw.split("#]")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|entry| {
            // Strip `Azure-<8chars>.<3chars>-` prefix if present while preserving order refs in filename
            if let Some(rest) = entry.strip_prefix("Azure-") {
                if let Some(idx) = rest.find('-') {
                    return rest[idx + 1..].trim().to_owned();
                }
            }
            entry.to_owned()
        })
        .collect()
}

/// Finds all `MedX.db3` files under `%APPDATA%\DDS\MediaExplorer\<ENV>\MedX.db3`, newest first.
pub fn discover_medx_databases() -> Vec<(String, PathBuf)> {
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return Vec::new();
    };
    let root = PathBuf::from(appdata).join("DDS").join("MediaExplorer");
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut found: Vec<(std::time::SystemTime, String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let db = entry.path().join("MedX.db3");
        if db.is_file() {
            let env_name = entry.file_name().to_string_lossy().into_owned();
            let modified = fs::metadata(&db)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            found.push((modified, env_name, db));
        }
    }
    found.sort_by_key(|a| std::cmp::Reverse(a.0));
    found
        .into_iter()
        .map(|(_, env, path)| (env, path))
        .collect()
}

pub fn active_mx_environment() -> Option<String> {
    discover_medx_databases()
        .into_iter()
        .next()
        .map(|(env, _)| env)
}

#[cfg(windows)]
mod sqlite_ro {
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_int, c_void};
    use std::path::Path;

    const SQLITE_OK: c_int = 0;
    const SQLITE_ROW: c_int = 100;
    const SQLITE_OPEN_READONLY: c_int = 0x0000_0001;
    const SQLITE_OPEN_NOMUTEX: c_int = 0x0000_8000;

    type Sqlite3OpenV2 =
        unsafe extern "C" fn(*const c_char, *mut *mut c_void, c_int, *const c_char) -> c_int;
    type Sqlite3CloseV2 = unsafe extern "C" fn(*mut c_void) -> c_int;
    type Sqlite3PrepareV2 = unsafe extern "C" fn(
        *mut c_void,
        *const c_char,
        c_int,
        *mut *mut c_void,
        *mut *const c_char,
    ) -> c_int;
    type Sqlite3Step = unsafe extern "C" fn(*mut c_void) -> c_int;
    type Sqlite3Finalize = unsafe extern "C" fn(*mut c_void) -> c_int;
    type Sqlite3ColumnCount = unsafe extern "C" fn(*mut c_void) -> c_int;
    type Sqlite3ColumnText = unsafe extern "C" fn(*mut c_void, c_int) -> *const c_char;

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryA(lp_lib_file_name: *const c_char) -> *mut c_void;
        fn GetProcAddress(h_module: *mut c_void, lp_proc_name: *const c_char) -> *mut c_void;
        fn FreeLibrary(h_lib_module: *mut c_void) -> c_int;
    }

    pub fn query_rows(db_path: &Path, sql: &str) -> Result<Vec<Vec<String>>, String> {
        let lib_name = CString::new("winsqlite3.dll").unwrap();
        let module = unsafe { LoadLibraryA(lib_name.as_ptr()) };
        if module.is_null() {
            return Err("winsqlite3.dll is unavailable on this Windows system.".to_owned());
        }

        let result = (|| -> Result<Vec<Vec<String>>, String> {
            unsafe {
                let open_fn: Sqlite3OpenV2 =
                    std::mem::transmute(get_sym(module, "sqlite3_open_v2")?);
                let close_fn: Sqlite3CloseV2 =
                    std::mem::transmute(get_sym(module, "sqlite3_close_v2")?);
                let prepare_fn: Sqlite3PrepareV2 =
                    std::mem::transmute(get_sym(module, "sqlite3_prepare_v2")?);
                let step_fn: Sqlite3Step = std::mem::transmute(get_sym(module, "sqlite3_step")?);
                let finalize_fn: Sqlite3Finalize =
                    std::mem::transmute(get_sym(module, "sqlite3_finalize")?);
                let col_count_fn: Sqlite3ColumnCount =
                    std::mem::transmute(get_sym(module, "sqlite3_column_count")?);
                let col_text_fn: Sqlite3ColumnText =
                    std::mem::transmute(get_sym(module, "sqlite3_column_text")?);

                let c_path = CString::new(db_path.to_string_lossy().as_bytes())
                    .map_err(|_| "Invalid MedX.db3 path".to_owned())?;
                let mut db: *mut c_void = std::ptr::null_mut();
                let rc = open_fn(
                    c_path.as_ptr(),
                    &mut db,
                    SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX,
                    std::ptr::null(),
                );
                if rc != SQLITE_OK || db.is_null() {
                    if !db.is_null() {
                        close_fn(db);
                    }
                    return Err(format!(
                        "Could not open {} read-only (code {rc}).",
                        db_path.display()
                    ));
                }

                let c_sql = CString::new(sql).map_err(|_| "Invalid SQL query".to_owned())?;
                let mut stmt: *mut c_void = std::ptr::null_mut();
                let prep_rc = prepare_fn(db, c_sql.as_ptr(), -1, &mut stmt, std::ptr::null_mut());
                if prep_rc != SQLITE_OK || stmt.is_null() {
                    close_fn(db);
                    return Err(format!("SQLite prepare failed (code {prep_rc})."));
                }

                let cols = col_count_fn(stmt).max(0);
                let mut rows = Vec::new();
                while step_fn(stmt) == SQLITE_ROW {
                    let mut row = Vec::with_capacity(cols as usize);
                    for idx in 0..cols {
                        let ptr = col_text_fn(stmt, idx);
                        if ptr.is_null() {
                            row.push(String::new());
                        } else {
                            row.push(CStr::from_ptr(ptr).to_string_lossy().into_owned());
                        }
                    }
                    rows.push(row);
                }

                finalize_fn(stmt);
                close_fn(db);
                Ok(rows)
            }
        })();

        unsafe {
            FreeLibrary(module);
        }
        result
    }

    unsafe fn get_sym(module: *mut c_void, name: &str) -> Result<*mut c_void, String> {
        let c_name = CString::new(name).unwrap();
        let sym = GetProcAddress(module, c_name.as_ptr());
        if sym.is_null() {
            Err(format!("Missing symbol {name} in winsqlite3.dll"))
        } else {
            Ok(sym)
        }
    }
}

/// Reads the Buyer directory from the most recently updated `MedX.db3` (read-only).
pub fn list_mx_buyers(limit: usize) -> Vec<MxBuyerEntry> {
    #[cfg(windows)]
    {
        let Some((_, db_path)) = discover_medx_databases().into_iter().next() else {
            return Vec::new();
        };
        let sql = format!(
            "SELECT DISTINCT TRIM(COALESCE(Code, '')), TRIM(COALESCE(Name, '')) \
             FROM Buyer WHERE TRIM(COALESCE(Name, '')) != '' ORDER BY Name ASC LIMIT {}",
            limit.clamp(1, 25_000)
        );
        let Ok(rows) = sqlite_ro::query_rows(&db_path, &sql) else {
            return Vec::new();
        };
        rows.into_iter()
            .filter_map(|row| {
                if row.len() >= 2 && !row[1].is_empty() {
                    Some(MxBuyerEntry {
                        code: row[0].clone(),
                        name: row[1].clone(),
                    })
                } else {
                    None
                }
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        let _ = limit;
        Vec::new()
    }
}

/// Loads `IQInvoice` + `Payee` metadata from `MedX.db3` keyed by `InvoiceNumber`.
pub fn load_medx_invoice_metadata() -> HashMap<String, MedxInvoiceMeta> {
    #[cfg(windows)]
    {
        let mut map = HashMap::new();
        for (_, db_path) in discover_medx_databases() {
            let payees: HashMap<String, String> = sqlite_ro::query_rows(
                &db_path,
                "SELECT CAST(PayeeSerial AS TEXT), COALESCE(PayeeName, '') FROM Payee",
            )
            .unwrap_or_default()
            .into_iter()
            .filter_map(|r| {
                if r.len() >= 2 {
                    Some((r[0].trim().to_owned(), r[1].trim().to_owned()))
                } else {
                    None
                }
            })
            .collect();

            let Ok(rows) = sqlite_ro::query_rows(
                &db_path,
                "SELECT COALESCE(InvoiceNumber, ''), CAST(COALESCE(Payee, '') AS TEXT), \
                 COALESCE(Advertiser, ''), COALESCE(ClientCode, ''), COALESCE(IssuedDate, ''), \
                 CAST(COALESCE(Gross, '') AS TEXT), CAST(COALESCE(NetPayable, '') AS TEXT), \
                 CAST(COALESCE(TotalPayable, '') AS TEXT), COALESCE(Attachment, '') \
                 FROM IQInvoice",
            ) else {
                continue;
            };
            for r in rows {
                if r.len() < 9 || r[0].trim().is_empty() {
                    continue;
                }
                let inv_no = r[0].trim().to_owned();
                let payee_name = payees.get(r[1].trim()).cloned().unwrap_or_default();
                map.entry(inv_no).or_insert_with(|| MedxInvoiceMeta {
                    payee_name,
                    client_code: r[3].trim().to_owned(),
                    issued_date: r[4].trim().to_owned(),
                    gross: r[5].trim().parse::<f64>().ok(),
                    net_payable: r[6].trim().parse::<f64>().ok(),
                    total_payable: r[7].trim().parse::<f64>().ok(),
                    attachments: parse_medx_attachments(&r[8]),
                });
            }
        }
        map
    }
    #[cfg(not(windows))]
    {
        HashMap::new()
    }
}

pub fn enrich_tickets_from_medx(tickets: &mut [MqsTicket]) {
    let meta_map = load_medx_invoice_metadata();
    if meta_map.is_empty() {
        return;
    }
    for t in tickets {
        if let Some(meta) = meta_map.get(t.invoice_no.trim()) {
            if t.client_code.is_empty() {
                t.client_code = meta.client_code.clone();
            }
            if t.issued_date.is_empty() {
                t.issued_date = meta.issued_date.clone();
            }
            if t.invoice_gross.is_none() {
                t.invoice_gross = meta.gross;
            }
            if t.invoice_net_payable.is_none() {
                t.invoice_net_payable = meta.net_payable;
            }
            if t.invoice_total_payable.is_none() {
                t.invoice_total_payable = meta.total_payable;
            }
            if t.payee.is_empty() && !meta.payee_name.is_empty() {
                t.payee = meta.payee_name.clone();
            }
            if t.attachments.is_empty() && !meta.attachments.is_empty() {
                t.attachments = meta.attachments.clone();
            }
        }
    }
}

pub fn is_mx_running() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq MedX2.exe", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|out| {
                String::from_utf8_lossy(&out.stdout)
                    .to_ascii_lowercase()
                    .contains("medx2.exe")
            })
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(windows)]
fn run_hidden_powershell(script: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed launching PowerShell helper: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            "MX helper exited with an error.".to_owned()
        } else {
            stderr
        });
    }
    Ok(stdout)
}

pub fn focus_mx_window() -> Result<String, String> {
    #[cfg(windows)]
    {
        let script = r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AbwWin {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$p = Get-Process -Name MedX2 -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Error "MX Media Explorer (MedX2.exe) is not open."; exit 1 }
[AbwWin]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
[AbwWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Write-Output $p.MainWindowTitle
"#;
        run_hidden_powershell(script)
    }
    #[cfg(not(windows))]
    {
        Err("MX Media Explorer focus is only supported on Windows.".to_owned())
    }
}

/// Probes and syncs open MQS grid rows from a running MX Media Explorer window.
pub fn sync_mx_live(now: &str) -> Result<Vec<MqsTicket>, String> {
    #[cfg(windows)]
    {
        if !is_mx_running() {
            return Err(
                "MX Media Explorer is not running. Open MX or import an MQS email digest instead."
                    .to_owned(),
            );
        }
        let script = r#"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
$p = Get-Process -Name MedX2 -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Error "MX Media Explorer window not found."; exit 1 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
$rowCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::DataItem
)
$rows = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $rowCond)
if ($rows.Count -gt 0) {
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($r in $rows) {
    $cells = $r.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    $vals = @()
    foreach ($c in $cells) {
      $val = $c.Current.Name
      try {
        $vp = $c.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if ($vp -and $vp.Current.Value) { $val = $vp.Current.Value }
      } catch {}
      $vals += ($val -replace "`r|`n|`t", " ")
    }
    if ($vals.Count -gt 0) { $lines.Add(($vals -join "`t")) }
  }
  if ($lines.Count -gt 0) {
    Write-Output ($lines -join "`n")
    exit 0
  }
}
# Fallback for legacy VB6 owner-drawn grid: focus MX, copy grid via Ctrl+A / Ctrl+C, restore clipboard
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AbwMxFocus {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$prevClip = $null
try { if ([System.Windows.Forms.Clipboard]::ContainsText()) { $prevClip = [System.Windows.Forms.Clipboard]::GetText() } } catch {}
try { [System.Windows.Forms.Clipboard]::Clear() } catch {}
[AbwMxFocus]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
[AbwMxFocus]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait('^c')
Start-Sleep -Milliseconds 350
$copied = ''
try { if ([System.Windows.Forms.Clipboard]::ContainsText()) { $copied = [System.Windows.Forms.Clipboard]::GetText() } } catch {}
try {
  if ($null -ne $prevClip) { [System.Windows.Forms.Clipboard]::SetText($prevClip) }
} catch {}
if ($copied -and $copied.Trim().Length -gt 0) {
  Write-Output $copied
  exit 0
}
Write-Error "UIA_NO_ROWS"
exit 2
"#;
        match run_hidden_powershell(script) {
            Ok(raw) => {
                let mut tickets = parse_mqs_text(&raw, MqsSource::MxLive, now);
                enrich_tickets_from_medx(&mut tickets);
                if tickets.is_empty() {
                    return Err("MX is open, but no MQS ticket rows were exposed directly to UI Automation. In MX, click inside the Invoice Query grid, press Ctrl+A then Ctrl+C, and click 'Paste from Clipboard' in ABW (or export to your watch folder).".to_owned());
                }
                Ok(tickets)
            }
            Err(_) => Err("MX is open, but its legacy grid did not expose rows to UI Automation directly. In MX, click inside the Invoice Query grid, press Ctrl+A then Ctrl+C, and click 'Paste from Clipboard' in ABW (or drop an MX export / email digest).".to_owned()),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = now;
        Err("MX Media Explorer live sync is only supported on Windows.".to_owned())
    }
}

/// Pre-fills (and optionally submits) the open `Invoice Query` dialog (`frmIQTicket`) in MX Media Explorer via UIA.
pub fn execute_mx_action(req: &MqsActionRequest) -> Result<MqsActionResult, String> {
    #[cfg(windows)]
    {
        if !is_mx_running() {
            return Err("MX Media Explorer is not running.".to_owned());
        }
        let action_esc = req.action.replace('\'', "''");
        let comments_esc = req.comments.replace('\'', "''");
        let serial_esc = req.serial.replace('\'', "''");
        let submit_flag = if req.submit { "$true" } else { "$false" };

        let script = format!(
            r#"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
$p = Get-Process -Name MedX2 -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) {{ Write-Error "MX Media Explorer is not running."; exit 1 }}
$pidCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$p.Id
)
$wins = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
  [System.Windows.Automation.TreeScope]::Children, $pidCond
)
$dlg = $null
foreach ($w in $wins) {{
  if ($w.Current.Name -like '*Invoice Query*') {{ $dlg = $w; break }}
}}
if (-not $dlg) {{
  Write-Error "Open the Invoice Query ticket dialog in MX Media Explorer first (double-click ticket #{ticket_no}), then retry."
  exit 1
}}
$dlg.SetFocus()
# Fill Action ComboBox if present
$comboCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::ComboBox
)
$combos = $dlg.FindAll([System.Windows.Automation.TreeScope]::Descendants, $comboCond)
foreach ($cb in $combos) {{
  try {{
    $vp = $cb.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($vp -and ($vp.Current.Value -like '*Select action*' -or $vp.Current.Value -eq '')) {{
      $vp.SetValue('{action_esc}')
      break
    }}
  }} catch {{}}
}}
# Fill Comments Edit box (largest multiline edit or named Comments)
$editCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit
)
$edits = $dlg.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
foreach ($ed in $edits) {{
  try {{
    $vp = $ed.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($vp -and -not $vp.Current.IsReadOnly) {{
      if ($ed.Current.Name -like '*Comment*') {{
        $vp.SetValue('{comments_esc}')
      }} elseif ('{serial_esc}' -ne '' -and $ed.Current.Name -like '*Serial*') {{
        $vp.SetValue('{serial_esc}')
      }}
    }}
  }} catch {{}}
}}
if ({submit_flag}) {{
  $btnCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, 'OK'
  )
  $okBtn = $dlg.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
  if ($okBtn) {{
    $inv = $okBtn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $inv.Invoke()
    Write-Output "SUBMITTED"
    exit 0
  }}
}}
Write-Output "PREFILLED"
"#,
            ticket_no = req.ticket_no.replace('\'', "''")
        );

        let outcome = run_hidden_powershell(&script)?;
        let submitted = outcome.contains("SUBMITTED");
        Ok(MqsActionResult {
            ok: true,
            submitted,
            message: if submitted {
                format!(
                    "Submitted '{}' on MQS ticket #{} in MX.",
                    req.action, req.ticket_no
                )
            } else {
                format!(
                    "Pre-filled '{}' on MQS ticket #{} in MX — review and click OK.",
                    req.action, req.ticket_no
                )
            },
        })
    }
    #[cfg(not(windows))]
    {
        let _ = req;
        Err("MX dialog automation is only supported on Windows.".to_owned())
    }
}

fn parse_money(raw: &str) -> f64 {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect();
    cleaned.parse::<f64>().unwrap_or(0.0)
}

fn strip_html_to_tsv(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if !lower.contains("<tr") && !lower.contains("<td") {
        return html.to_owned();
    }
    let mut out = String::new();
    let mut in_tag = false;
    let mut tag_buf = String::new();
    for ch in html.chars() {
        if ch == '<' {
            in_tag = true;
            tag_buf.clear();
        } else if ch == '>' && in_tag {
            in_tag = false;
            let tag = tag_buf.trim().to_ascii_lowercase();
            if tag.starts_with("/tr") || tag.starts_with("tr") {
                out.push('\n');
            } else if tag.starts_with("/td") || tag.starts_with("/th") {
                out.push('\t');
            }
        } else if in_tag {
            tag_buf.push(ch);
        } else {
            out.push(ch);
        }
    }
    out.replace("&amp;", "&")
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

/// Parses MQS tickets from TSV/CSV text or HTML email digest tables.
pub fn parse_mqs_text(raw: &str, source: MqsSource, now: &str) -> Vec<MqsTicket> {
    let normalized = strip_html_to_tsv(raw);
    let mut rows: Vec<Vec<String>> = Vec::new();
    for line in normalized.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let cols: Vec<String> = if trimmed.contains('\t') {
            trimmed.split('\t').map(|s| s.trim().to_owned()).collect()
        } else if trimmed.contains(',') {
            parse_csv_line(trimmed)
        } else {
            continue;
        };
        if cols.len() >= 5 {
            rows.push(cols);
        }
    }
    parse_mqs_rows(&rows, source, now)
}

fn parse_csv_line(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                if in_quotes && chars.peek() == Some(&'"') {
                    cur.push('"');
                    chars.next();
                } else {
                    in_quotes = !in_quotes;
                }
            }
            ',' if !in_quotes => {
                out.push(cur.trim().to_owned());
                cur.clear();
            }
            c => cur.push(c),
        }
    }
    out.push(cur.trim().to_owned());
    out
}

pub fn parse_mqs_rows(rows: &[Vec<String>], source: MqsSource, now: &str) -> Vec<MqsTicket> {
    if rows.is_empty() {
        return Vec::new();
    }

    // Detect header row
    let mut header_idx: Option<usize> = None;
    for (idx, row) in rows.iter().enumerate().take(10) {
        let joined = row.join(" ").to_ascii_lowercase();
        if joined.contains("ticket")
            && (joined.contains("invoice") || joined.contains("payee") || joined.contains("reason"))
        {
            header_idx = Some(idx);
            break;
        }
    }

    let mut col_map: HashMap<&str, usize> = HashMap::new();
    let start_row = if let Some(h_idx) = header_idx {
        for (c_idx, h) in rows[h_idx].iter().enumerate() {
            let key = h.trim().to_ascii_lowercase();
            if key.contains("ticket") {
                col_map.entry("ticket").or_insert(c_idx);
            } else if key.contains("buyer") {
                col_map.entry("buyer").or_insert(c_idx);
            } else if key.contains("advertiser") || key.contains("client") {
                col_map.entry("advertiser").or_insert(c_idx);
            } else if key.contains("payee") || key.contains("supplier") {
                col_map.entry("payee").or_insert(c_idx);
            } else if key.contains("invoice") {
                col_map.entry("invoice").or_insert(c_idx);
            } else if key.contains("created") || key.contains("date") {
                col_map.entry("created").or_insert(c_idx);
            } else if key.contains("line") {
                col_map.entry("line").or_insert(c_idx);
            } else if key.contains("curr") {
                col_map.entry("currency").or_insert(c_idx);
            } else if key.contains("payable") {
                col_map.entry("payable").or_insert(c_idx);
            } else if key.contains("gross") {
                col_map.entry("gross").or_insert(c_idx);
            } else if key.contains("booking") || key.contains("order") || key.contains("ref") {
                col_map.entry("booking_ref").or_insert(c_idx);
            } else if key.contains("reason") {
                col_map.entry("reason").or_insert(c_idx);
            } else if key.contains("status") {
                col_map.entry("status").or_insert(c_idx);
            }
        }
        h_idx + 1
    } else {
        // Default MX Invoice Query grid column order from screenshot:
        // 0:Ticket No, 1:To Buyer, 2:Advertiser, 3:Payee, 4:Invoice No, 5:Created,
        // 6:Line No, 7:Currency, 8:Payable, 9:Gross, 10:Booking Reference, 11:Reason
        col_map.insert("ticket", 0);
        col_map.insert("buyer", 1);
        col_map.insert("advertiser", 2);
        col_map.insert("payee", 3);
        col_map.insert("invoice", 4);
        col_map.insert("created", 5);
        col_map.insert("line", 6);
        col_map.insert("currency", 7);
        col_map.insert("payable", 8);
        col_map.insert("gross", 9);
        col_map.insert("booking_ref", 10);
        col_map.insert("reason", 11);
        0
    };

    let get = |row: &[String], name: &str| -> String {
        col_map
            .get(name)
            .and_then(|&i| row.get(i))
            .map(|s| s.trim().to_owned())
            .unwrap_or_default()
    };

    let mut out = Vec::new();
    for row in rows.iter().skip(start_row) {
        let ticket_no = get(row, "ticket");
        if ticket_no.is_empty() || !ticket_no.chars().any(|c| c.is_ascii_digit()) {
            continue;
        }
        let currency = {
            let c = get(row, "currency");
            if c.is_empty() {
                "GBP".to_owned()
            } else {
                c
            }
        };
        let payable = parse_money(&get(row, "payable"));
        let gross_raw = parse_money(&get(row, "gross"));
        let gross = if gross_raw == 0.0 { payable } else { gross_raw };
        let status = {
            let s = get(row, "status");
            if s.is_empty() {
                "With Buyer".to_owned()
            } else {
                s
            }
        };
        out.push(MqsTicket {
            ticket_no,
            to_buyer: get(row, "buyer"),
            advertiser: get(row, "advertiser"),
            payee: get(row, "payee"),
            invoice_no: get(row, "invoice"),
            created: get(row, "created"),
            line_no: get(row, "line"),
            currency,
            queried_payable: payable,
            queried_gross: gross,
            booking_reference: get(row, "booking_ref"),
            reason: get(row, "reason"),
            status,
            priority: String::new(),
            owner: String::new(),
            operating_co: String::new(),
            buying_agency: String::new(),
            client_code: String::new(),
            issued_date: String::new(),
            invoice_gross: None,
            invoice_net_payable: None,
            invoice_total_payable: None,
            attachments: Vec::new(),
            local_notes: String::new(),
            source: source.clone(),
            last_seen_at: now.to_owned(),
        });
    }
    out
}

pub fn import_mqs_file(
    path: &Path,
    source: MqsSource,
    now: &str,
) -> Result<Vec<MqsTicket>, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    let mut tickets = match ext.as_str() {
        "xlsx" | "xlsm" | "xls" | "xlsb" | "ods" | "csv" | "tsv" => {
            let wb = spreadsheet::preview_file(path)?;
            let mut rows = Vec::new();
            if let Some(sheet) = wb.sheets.first() {
                for row in &sheet.rows {
                    rows.push(row.cells.iter().map(|c| c.value.clone()).collect());
                }
            }
            parse_mqs_rows(&rows, source, now)
        }
        _ => {
            let raw = fs::read_to_string(path)
                .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
            parse_mqs_text(&raw, source, now)
        }
    };
    enrich_tickets_from_medx(&mut tickets);
    Ok(tickets)
}

pub fn scan_digest_folder(folder: &Path, now: &str) -> Result<Vec<MqsTicket>, String> {
    if !folder.is_dir() {
        return Err(format!(
            "Digest folder does not exist: {}",
            folder.display()
        ));
    }
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in fs::read_dir(folder)
        .map_err(|e| format!("Could not read digest folder: {e}"))?
        .flatten()
    {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if matches!(
            ext.as_str(),
            "xlsx" | "xlsm" | "xls" | "csv" | "tsv" | "txt" | "html" | "htm" | "eml"
        ) {
            let modified = fs::metadata(&p)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            files.push((modified, p));
        }
    }
    files.sort_by_key(|(m, _)| *m);
    let mut all = Vec::new();
    for (_, path) in files {
        if let Ok(mut parsed) = import_mqs_file(&path, MqsSource::EmailDigest, now) {
            all.append(&mut parsed);
        }
    }
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_medx_azure_attachments() {
        let raw = "Azure-bgxwyd0o.c1a-2064766_1.pdf#]Azure-ea1ks44e.eoh-O-D2P0GCL-R1 (4).pdf";
        assert_eq!(
            parse_medx_attachments(raw),
            vec!["2064766_1.pdf", "O-D2P0GCL-R1 (4).pdf"]
        );
    }

    #[test]
    fn parses_tsv_and_html_email_digest_tables() {
        let tsv = "Ticket No.\tTo Buyer\tAdvertiser\tPayee\tInvoice No.\tCreated\tLine No.\tCurrency\tPayable\tGross\tBooking Reference\tReason\n\
                   137033\tHARRY BARNES\tCANCER RESEARCH UK\tGUARDIAN\t2064766\t23/04/2026\t\tGBP\t4,697.06\t4,697.06\t\tGROSS COST DISCREPANCY\n\
                   145674\tHARRY BARNES\tJ.P MORGAN\tTIME OUT\t389833\t26/10/2026\t1\tGBP\t23,151.15\t23,151.15\tO-D35356S\tBOOKING NOT ADDED TO MX";
        let tickets = parse_mqs_text(tsv, MqsSource::ManualImport, "2026-11-26T12:00:00+00:00");
        assert_eq!(tickets.len(), 2);
        assert_eq!(tickets[0].ticket_no, "137033");
        assert!((tickets[0].queried_gross - 4697.06).abs() < 0.01);
        assert_eq!(tickets[1].booking_reference, "O-D35356S");

        let html = "<table><tr><th>Ticket No</th><th>To Buyer</th><th>Advertiser</th><th>Payee</th><th>Invoice No</th><th>Gross</th><th>Booking Reference</th><th>Reason</th></tr>\
                    <tr><td>121296</td><td>HARRY BARNES</td><td>Cancer Research Inc</td><td>CHANNEL FACTORY</td><td>INVCFN40628</td><td>1,168.84</td><td>O-5JG80</td><td>ACTIVITY DATE DOES NOT MATCH</td></tr></table>";
        let from_html = parse_mqs_text(html, MqsSource::EmailDigest, "2026-11-26T12:00:00+00:00");
        assert_eq!(from_html.len(), 1);
        assert_eq!(from_html[0].ticket_no, "121296");
        assert_eq!(from_html[0].booking_reference, "O-5JG80");
    }
}
