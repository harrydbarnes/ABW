use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, Read, Write},
    path::PathBuf,
    time::{Duration, SystemTime},
};
use uuid::Uuid;

const HOST: &str = "net.insidemedia.abw.po_check";
const MAX_AGE: Duration = Duration::from_secs(120);

fn folder() -> io::Result<PathBuf> {
    env::var_os("LOCALAPPDATA")
        .map(|root| PathBuf::from(root).join("ABW").join("po-check"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA unavailable"))
}

fn manifest_path() -> io::Result<PathBuf> {
    Ok(folder()?.join("native-host.json"))
}

fn paired_origin() -> Option<String> {
    let config: Value = serde_json::from_slice(&fs::read(manifest_path().ok()?).ok()?).ok()?;
    Some(config.get("allowed_origins")?.get(0)?.as_str()?.to_owned())
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
    let path = manifest_path()?;
    fs::create_dir_all(folder()?)?;
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

pub fn run_job(booking: Value) -> &'static str {
    if paired_origin().is_none() {
        return "unavailable";
    }
    let Ok(root) = folder() else {
        return "unavailable";
    };
    let id = Uuid::new_v4().to_string();
    let pending = root.join(format!("{id}.job"));
    let completed = root.join(format!("{id}.result"));
    if write_new(&pending, &booking).is_err() {
        return "unavailable";
    }
    let mut verdict = "unavailable";
    for _ in 0..90 {
        if let Ok(result) = fs::read_to_string(&completed) {
            verdict = match result.as_str() {
                "\"checked\"" => "checked",
                "\"review\"" => "review",
                "\"signin\"" => "signin",
                _ => "unavailable",
            };
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    let _ = fs::remove_file(pending);
    let _ = fs::remove_file(completed);
    verdict
}

fn process(request: Value) -> io::Result<Value> {
    let root = folder()?;
    match request["action"].as_str() {
        Some("poll") => {
            let mut jobs = Vec::new();
            for entry in fs::read_dir(&root)?.flatten() {
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
