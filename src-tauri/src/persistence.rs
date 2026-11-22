use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs,
    io::Write,
    path::Path,
    sync::RwLock,
    time::{SystemTime, UNIX_EPOCH},
};

static DATA_LOCK: RwLock<()> = RwLock::new(());

pub fn format_unix_timestamp_rfc3339(seconds: i64) -> Option<String> {
    let days = seconds.div_euclid(86_400);
    let secs_of_day = seconds.rem_euclid(86_400);
    let hour = secs_of_day / 3_600;
    let minute = (secs_of_day % 3_600) / 60;
    let second = secs_of_day % 60;
    let (year, month, day) = civil_from_unix_days(days)?;
    if !(0..=9_999).contains(&year) {
        return None;
    }
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}+00:00"
    ))
}

pub fn now_rfc3339() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    format_unix_timestamp_rfc3339(seconds).unwrap_or_else(|| "1970-01-01T00:00:00+00:00".to_owned())
}

fn civil_from_unix_days(days: i64) -> Option<(i64, u32, u32)> {
    let z = days.checked_add(719_468)?;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + i64::from(m <= 2);
    Some((year, m as u32, d as u32))
}

pub fn read<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    let _guard = DATA_LOCK
        .read()
        .map_err(|_| "Application data lock failed.")?;
    match fs::read(path) {
        Ok(contents) => match serde_json::from_slice(&contents) {
            Ok(value) => Ok(value),
            Err(_) => fs::read(backup_path(path))
                .ok()
                .and_then(|backup| serde_json::from_slice(&backup).ok())
                .ok_or_else(|| format!("{} is corrupt and has no valid backup. Restore this file from a backup before saving; the original has not been changed.", path.display())),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(format!("Unable to read {}: {error}. Check the file's permissions and restart ABW.", path.display())),
    }
}

fn backup_path(path: &Path) -> std::path::PathBuf {
    path.with_extension("json.bak")
}

pub fn health<T: DeserializeOwned>(path: &Path) -> Option<String> {
    let _guard = DATA_LOCK.read().ok()?;
    let contents = fs::read(path).ok()?;
    if serde_json::from_slice::<T>(&contents).is_ok() {
        return None;
    }
    let recovered = fs::read(backup_path(path))
        .ok()
        .is_some_and(|backup| serde_json::from_slice::<T>(&backup).is_ok());
    Some(if recovered {
        format!("Recovered {} from its last-known-good backup. The damaged original will be archived when you next save.", path.display())
    } else {
        format!("{} is corrupt. Restore it from a backup and restart ABW. Your original file has not been changed.", path.display())
    })
}

enum BackupAction {
    None,
    WriteBackup(Vec<u8>),
    ArchiveCorrupt(Vec<u8>),
}

pub fn update<T, R>(
    path: &Path,
    change: impl FnOnce(&mut T) -> Result<R, String>,
) -> Result<(T, R), String>
where
    T: DeserializeOwned + Serialize + Default,
{
    let _guard = DATA_LOCK
        .write()
        .map_err(|_| "Application data lock failed.")?;
    let (mut value, backup_action) = match fs::read(path) {
        Ok(contents) => match serde_json::from_slice::<T>(&contents) {
            Ok(parsed) => (parsed, BackupAction::WriteBackup(contents)),
            Err(_) => {
                let recovered = fs::read(backup_path(path))
                    .ok()
                    .and_then(|backup| serde_json::from_slice::<T>(&backup).ok())
                    .ok_or_else(|| format!("{} is corrupt and has no valid backup. Restore this file from a backup before saving; the original has not been changed.", path.display()))?;
                (recovered, BackupAction::ArchiveCorrupt(contents))
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            (T::default(), BackupAction::None)
        }
        Err(error) => {
            return Err(format!(
                "Unable to read {}: {error}. Check the file's permissions and restart ABW.",
                path.display()
            ))
        }
    };
    let result = change(&mut value)?;
    let new_contents = serde_json::to_vec_pretty(&value)
        .map_err(|error| format!("Unable to serialise application data: {error}"))?;
    match backup_action {
        BackupAction::WriteBackup(previous_contents) => {
            if previous_contents == new_contents {
                return Ok((value, result));
            }
            write_bytes(&backup_path(path), &previous_contents)?;
        }
        BackupAction::ArchiveCorrupt(corrupt_contents) => {
            let archived = path.with_extension(format!("corrupt-{}.json", uuid::Uuid::new_v4()));
            write_bytes(&archived, &corrupt_contents)?;
        }
        BackupAction::None => {}
    }
    write_bytes(path, &new_contents)?;
    Ok((value, result))
}

fn write_bytes(path: &Path, contents: &[u8]) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or("Application data path has no directory.")?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Unable to create application directory: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|error| format!("Unable to create application data file: {error}"))?;
    temporary
        .write_all(contents)
        .map_err(|error| format!("Unable to save application data: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("Unable to flush application data: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("Unable to save {}: {error}. Check available disk space and file permissions; the previous file has not been replaced.", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn concurrent_updates_preserve_every_record() {
        let directory = tempfile::tempdir().unwrap();
        let path = Arc::new(directory.path().join("records.json"));
        let workers: Vec<_> = (0..16)
            .map(|id| {
                let path = Arc::clone(&path);
                std::thread::spawn(move || {
                    update::<Vec<usize>, _>(&path, |records| {
                        records.push(id);
                        Ok(())
                    })
                    .unwrap();
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        let mut records: Vec<usize> = read(&path).unwrap();
        records.sort();
        assert_eq!(records, (0..16).collect::<Vec<_>>());
    }

    #[test]
    fn failed_update_keeps_previous_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("records.json");
        update::<Vec<usize>, _>(&path, |records| {
            records.push(1);
            Ok(())
        })
        .unwrap();
        assert!(update::<Vec<usize>, ()>(&path, |records| {
            records.clear();
            Err("cancelled".into())
        })
        .is_err());
        assert_eq!(read::<Vec<usize>>(&path).unwrap(), vec![1]);
        fs::write(&path, "invalid JSON").unwrap();
        assert!(update::<Vec<usize>, _>(&path, |_| Ok(())).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "invalid JSON");
    }

    #[test]
    fn corrupt_primary_recovers_and_preserves_backup_and_original() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        for id in [1, 2] {
            update::<Vec<usize>, _>(&path, |value| {
                value.push(id);
                Ok(())
            })
            .unwrap();
        }
        fs::write(&path, "damaged").unwrap();
        assert_eq!(read::<Vec<usize>>(&path).unwrap(), vec![1]);
        assert!(health::<Vec<usize>>(&path).unwrap().contains("Recovered"));
        update::<Vec<usize>, _>(&path, |value| {
            value.push(3);
            Ok(())
        })
        .unwrap();
        assert_eq!(read::<Vec<usize>>(&path).unwrap(), vec![1, 3]);
        assert_eq!(read::<Vec<usize>>(&backup_path(&path)).unwrap(), vec![1]);
        let archived = fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| entry.file_name().to_string_lossy().contains("corrupt-"))
            .unwrap();
        assert_eq!(fs::read_to_string(archived.path()).unwrap(), "damaged");
    }
}
