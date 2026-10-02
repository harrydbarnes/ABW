use serde::{de::DeserializeOwned, Serialize};
use std::{fs, io::Write, path::Path, sync::Mutex};

static DATA_LOCK: Mutex<()> = Mutex::new(());

pub fn read<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
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

pub fn update<T, R>(
    path: &Path,
    change: impl FnOnce(&mut T) -> Result<R, String>,
) -> Result<(T, R), String>
where
    T: DeserializeOwned + Serialize + Default,
{
    let _guard = DATA_LOCK
        .lock()
        .map_err(|_| "Application data lock failed.")?;
    let mut value = read(path)?;
    let result = change(&mut value)?;
    if let Ok(contents) = fs::read(path) {
        if serde_json::from_slice::<T>(&contents).is_ok() {
            write_bytes(&backup_path(path), &contents)?;
        } else {
            let archived = path.with_extension(format!("corrupt-{}.json", uuid::Uuid::new_v4()));
            write_bytes(&archived, &contents)?;
        }
    }
    write_atomic(path, &value)?;
    Ok((value, result))
}

fn write_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let contents = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Unable to serialise application data: {error}"))?;
    write_bytes(path, &contents)
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
