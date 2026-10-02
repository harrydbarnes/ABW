use serde::{de::DeserializeOwned, Serialize};
use std::{fs, io::Write, path::Path, sync::Mutex};

static DATA_LOCK: Mutex<()> = Mutex::new(());

pub fn read<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    match fs::read(path) {
        Ok(contents) => serde_json::from_slice(&contents)
            .map_err(|error| format!("Invalid application data: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(format!("Unable to read application data: {error}")),
    }
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
    write_atomic(path, &value)?;
    Ok((value, result))
}

fn write_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or("Application data path has no directory.")?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Unable to create application directory: {error}"))?;
    let contents = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Unable to serialise application data: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|error| format!("Unable to create application data file: {error}"))?;
    temporary
        .write_all(&contents)
        .map_err(|error| format!("Unable to save application data: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("Unable to flush application data: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("Unable to replace application data: {error}"))?;
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
}
