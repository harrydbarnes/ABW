#[cfg(windows)]
const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
#[cfg(windows)]
const PREFERENCE_KEY: &str = "Software\\net.insidemedia.abw";

#[cfg(windows)]
pub fn enabled() -> Result<bool, String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    enabled_under(&RegKey::predef(HKEY_CURRENT_USER), RUN_KEY)
}

#[cfg(windows)]
fn enabled_under(root: &winreg::RegKey, run_key: &str) -> Result<bool, String> {
    let key = match root.open_subkey(run_key) {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Unable to read Windows startup: {error}")),
    };
    match key.get_value::<String, _>("ABW") {
        Ok(command) => Ok(!command.trim().is_empty()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Unable to read Windows startup: {error}")),
    }
}

#[cfg(windows)]
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    set_enabled_under(&root, RUN_KEY, PREFERENCE_KEY, enabled, &executable)
}

#[cfg(windows)]
fn set_enabled_under(
    root: &winreg::RegKey,
    run_key: &str,
    preference_key: &str,
    enabled: bool,
    executable: &std::path::Path,
) -> Result<(), String> {
    let (key, _) = root
        .create_subkey(run_key)
        .map_err(|error| format!("Unable to update Windows startup: {error}"))?;
    if enabled {
        key.set_value("ABW", &format!("\"{}\"", executable.display()))
            .map_err(|error| format!("Unable to enable Windows startup: {error}"))?;
    } else if let Err(error) = key.delete_value("ABW") {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(format!("Unable to disable Windows startup: {error}"));
        }
    }
    let (preference, _) = root
        .create_subkey(preference_key)
        .map_err(|error| error.to_string())?;
    preference
        .set_value("StartupEnabled", &u32::from(enabled))
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
pub fn enabled() -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(windows))]
pub fn set_enabled(_enabled: bool) -> Result<(), String> {
    Err("Windows startup is only available on Windows.".into())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    #[test]
    fn startup_changes_update_run_command_and_installer_preference() {
        let root = RegKey::predef(HKEY_CURRENT_USER);
        let sandbox = format!("Software\\ABW-Tests\\{}", uuid::Uuid::new_v4());
        let (test_root, _) = root.create_subkey(&sandbox).unwrap();
        let executable = std::path::Path::new("C:\\Users\\Test User\\ABW.exe");
        assert!(!enabled_under(&test_root, "Run").unwrap());
        for enabled in [true, false, false, true] {
            set_enabled_under(&test_root, "Run", "Preferences", enabled, executable).unwrap();
            assert_eq!(enabled_under(&test_root, "Run").unwrap(), enabled);
            let preference: u32 = test_root
                .open_subkey("Preferences")
                .unwrap()
                .get_value("StartupEnabled")
                .unwrap();
            assert_eq!(preference, u32::from(enabled));
        }
        let command: String = test_root
            .open_subkey("Run")
            .unwrap()
            .get_value("ABW")
            .unwrap();
        assert_eq!(command, "\"C:\\Users\\Test User\\ABW.exe\"");
        drop(test_root);
        assert!(sandbox.starts_with("Software\\ABW-Tests\\"));
        root.delete_subkey_all(sandbox).unwrap();
    }
}
