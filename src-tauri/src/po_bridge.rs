use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};
use uuid::Uuid;

#[cfg(windows)]
const HOST: &str = "net.insidemedia.abw.po_check";
const MAX_AGE: Duration = Duration::from_secs(120);

fn folder() -> io::Result<PathBuf> {
    env::var_os("LOCALAPPDATA")
        .map(|root| PathBuf::from(root).join("ABW").join("po-check"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA unavailable"))
}

fn paired_origin_in(root: &Path) -> Option<String> {
    let config: Value =
        serde_json::from_slice(&fs::read(root.join("native-host.json")).ok()?).ok()?;
    Some(config.get("allowed_origins")?.get(0)?.as_str()?.to_owned())
}

fn paired_origin() -> Option<String> {
    paired_origin_in(&folder().ok()?)
}

fn parse_verdict(raw: &str) -> &'static str {
    match raw {
        "\"checked\"" => "checked",
        "\"review\"" => "review",
        "\"signin\"" => "signin",
        _ => "unavailable",
    }
}

#[cfg(windows)]
pub fn register(extension_id: &str) -> Result<(), Box<dyn std::error::Error>> {
    if extension_id.len() != 32
        || !extension_id
            .bytes()
            .all(|byte| (b'a'..=b'p').contains(&byte))
    {
        return Err("Expected a 32-character Chrome extension ID".into());
    }
    let root = folder()?;
    let path = root.join("native-host.json");
    fs::create_dir_all(&root)?;
    fs::write(
        &path,
        serde_json::to_vec(&json!({
            "name": HOST,
            "description": "ABW automatic PO checks for Ops Toolshed",
            "path": env::current_exe()?,
            "type": "stdio",
            "allowed_origins": [format!("chrome-extension://{extension_id}/")],
        }))?,
    )?;
    let (key, _) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).create_subkey(
        format!(r"Software\Google\Chrome\NativeMessagingHosts\{HOST}"),
    )?;
    key.set_value("", &path.to_string_lossy().to_string())?;
    Ok(())
}

fn fresh(path: &std::path::Path) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|time| SystemTime::now().duration_since(time).ok())
        .is_some_and(|age| age <= MAX_AGE)
}

fn write_new(path: &std::path::Path, value: &Value) -> io::Result<()> {
    let mut temp =
        tempfile::NamedTempFile::new_in(path.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
    serde_json::to_writer(&mut temp, value)?;
    temp.persist_noclobber(path).map_err(|error| error.error)?;
    Ok(())
}

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};

fn tab_po_generations() -> &'static Mutex<HashMap<String, Arc<AtomicU64>>> {
    static GENERATIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicU64>>>> = OnceLock::new();
    GENERATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn run_job_for_tab(tab_id: &str, booking: Value) -> Option<&'static str> {
    let counter = {
        let mut map = tab_po_generations().lock().ok()?;
        map.entry(tab_id.to_owned())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)))
            .clone()
    };
    let generation = counter.fetch_add(1, Ordering::SeqCst) + 1;

    if paired_origin().is_none() {
        return Some("unavailable");
    }
    let Ok(root) = folder() else {
        return Some("unavailable");
    };
    let id = Uuid::new_v4().to_string();
    let pending = root.join(format!("{id}.job"));
    let completed = root.join(format!("{id}.result"));
    if write_new(&pending, &booking).is_err() {
        return Some("unavailable");
    }
    let mut verdict = Some("unavailable");
    for _ in 0..90 {
        if counter.load(Ordering::SeqCst) != generation {
            verdict = None;
            break;
        }
        if let Ok(result) = fs::read_to_string(&completed) {
            verdict = Some(parse_verdict(&result));
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    let _ = fs::remove_file(pending);
    let _ = fs::remove_file(completed);
    verdict
}

fn process_in(root: &Path, request: Value) -> io::Result<Value> {
    match request["action"].as_str() {
        Some("poll") => {
            let mut jobs = Vec::new();
            for entry in fs::read_dir(root)?.flatten() {
                let path = entry.path();
                if !matches!(
                    path.extension().and_then(|part| part.to_str()),
                    Some("job" | "result")
                ) {
                    continue;
                }
                let Some(id) = path
                    .file_stem()
                    .and_then(|part| part.to_str())
                    .and_then(|id| Uuid::parse_str(id).ok())
                else {
                    continue;
                };
                if !fresh(&path) {
                    let _ = fs::remove_file(&path);
                    continue;
                }
                if path.extension().and_then(|part| part.to_str()) != Some("job")
                    || root.join(format!("{id}.result")).exists()
                    || jobs.len() >= 8
                {
                    continue;
                }
                let Ok(bytes) = fs::read(path) else {
                    continue;
                };
                if let Ok(booking) = serde_json::from_slice::<Value>(&bytes) {
                    jobs.push(json!({ "id": id.to_string(), "booking": booking }));
                }
            }
            Ok(json!({ "jobs": jobs }))
        }
        Some("complete") => {
            let id = request["id"]
                .as_str()
                .and_then(|id| Uuid::parse_str(id).ok())
                .ok_or(io::ErrorKind::InvalidInput)?;
            let status = request["status"]
                .as_str()
                .filter(|status| matches!(*status, "checked" | "review" | "signin" | "unavailable"))
                .ok_or(io::ErrorKind::InvalidInput)?;
            if fresh(&root.join(format!("{id}.job"))) {
                let _ = write_new(&root.join(format!("{id}.result")), &json!(status));
            }
            Ok(json!({ "ok": true }))
        }
        _ => Err(io::ErrorKind::InvalidInput.into()),
    }
}

fn process(request: Value) -> io::Result<Value> {
    process_in(&folder()?, request)
}

pub fn serve(origin: &str) -> io::Result<()> {
    if paired_origin().as_deref() != Some(origin) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let mut input = io::stdin().lock();
    let mut length = [0; 4];
    input.read_exact(&mut length)?;
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > 8192 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes)?;
    let reply = serde_json::from_slice(&bytes)
        .ok()
        .and_then(|request| process(request).ok())
        .unwrap_or_else(|| json!({ "ok": false }));
    let bytes = serde_json::to_vec(&reply)?;
    let mut output = io::stdout().lock();
    output.write_all(&(bytes.len() as u32).to_le_bytes())?;
    output.write_all(&bytes)?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paired_origin_in_reads_first_allowed_origin() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(paired_origin_in(dir.path()), None);

        fs::write(
            dir.path().join("native-host.json"),
            br#"{"allowed_origins":["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"]}"#,
        )
        .unwrap();
        assert_eq!(
            paired_origin_in(dir.path()).as_deref(),
            Some("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/")
        );
    }

    #[test]
    fn parse_verdict_maps_known_and_unknown_values() {
        assert_eq!(parse_verdict("\"checked\""), "checked");
        assert_eq!(parse_verdict("\"review\""), "review");
        assert_eq!(parse_verdict("\"signin\""), "signin");
        assert_eq!(parse_verdict("\"other\""), "unavailable");
        assert_eq!(parse_verdict(""), "unavailable");
    }

    #[test]
    fn process_in_polls_and_completes_jobs_and_rejects_invalid_inputs() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4().to_string();
        let job_path = dir.path().join(format!("{id}.job"));
        write_new(&job_path, &json!({ "po": "61507" })).unwrap();
        fs::write(dir.path().join("ignored.txt"), b"ignore").unwrap();

        let polled = process_in(dir.path(), json!({ "action": "poll" })).unwrap();
        assert_eq!(
            polled,
            json!({ "jobs": [{ "id": id, "booking": { "po": "61507" } }] })
        );

        let completed = process_in(
            dir.path(),
            json!({ "action": "complete", "id": id, "status": "checked" }),
        )
        .unwrap();
        assert_eq!(completed, json!({ "ok": true }));
        assert_eq!(
            fs::read_to_string(dir.path().join(format!("{id}.result"))).unwrap(),
            "\"checked\""
        );

        let polled_after = process_in(dir.path(), json!({ "action": "poll" })).unwrap();
        assert_eq!(polled_after, json!({ "jobs": [] }));

        assert!(process_in(dir.path(), json!({ "action": "unknown" })).is_err());
        assert!(process_in(
            dir.path(),
            json!({ "action": "complete", "id": "not-a-uuid", "status": "checked" })
        )
        .is_err());
        assert!(process_in(
            dir.path(),
            json!({ "action": "complete", "id": id, "status": "bogus" })
        )
        .is_err());
    }
}
