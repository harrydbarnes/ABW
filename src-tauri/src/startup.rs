#[cfg(windows)]
const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
#[cfg(windows)]
const PREFERENCE_KEY: &str = "Software\\net.insidemedia.abw";

#[cfg(windows)]
fn startup_identity(executable: Option<&std::path::Path>) -> (&'static str, &'static str) {
    let is_preview = executable
        .and_then(|path| path.file_stem())
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem.eq_ignore_ascii_case("ABW Preview"));
    if is_preview {
        ("ABW Preview", "Software\\net.insidemedia.abw.preview")
    } else {
        ("ABW", PREFERENCE_KEY)
    }
}

#[cfg(windows)]
pub fn enabled() -> Result<bool, String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let executable = std::env::current_exe().ok();
    let (value_name, _) = startup_identity(executable.as_deref());
    enabled_under(&RegKey::predef(HKEY_CURRENT_USER), RUN_KEY, value_name)
}

#[cfg(windows)]
fn enabled_under(root: &winreg::RegKey, run_key: &str, value_name: &str) -> Result<bool, String> {
    let key = match root.open_subkey(run_key) {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Unable to read Windows startup: {error}")),
    };
    match key.get_value::<String, _>(value_name) {
        Ok(command) => Ok(!command.trim().is_empty()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Unable to read Windows startup: {error}")),
    }
}

#[cfg(windows)]
pub fn set_enabled(enabled: bool, minimized: bool) -> Result<(), String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let (value_name, preference_key) = startup_identity(Some(&executable));
    set_enabled_under(
        &root,
        RUN_KEY,
        value_name,
        preference_key,
        enabled,
        minimized,
        &executable,
    )
}

#[cfg(windows)]
fn set_enabled_under(
    root: &winreg::RegKey,
    run_key: &str,
    value_name: &str,
    preference_key: &str,
    enabled: bool,
    minimized: bool,
    executable: &std::path::Path,
) -> Result<(), String> {
    let (key, _) = root
        .create_subkey(run_key)
        .map_err(|error| format!("Unable to update Windows startup: {error}"))?;
    if enabled {
        let command = if minimized {
            format!("\"{}\" --minimized", executable.display())
        } else {
            format!("\"{}\"", executable.display())
        };
        key.set_value(value_name, &command)
            .map_err(|error| format!("Unable to enable Windows startup: {error}"))?;
    } else if let Err(error) = key.delete_value(value_name) {
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
pub fn set_enabled(_enabled: bool, _minimized: bool) -> Result<(), String> {
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
        assert_eq!(startup_identity(Some(executable)), ("ABW", PREFERENCE_KEY));
        assert_eq!(
            startup_identity(Some(std::path::Path::new("C:\\Apps\\ABW Preview.exe"))),
            ("ABW Preview", "Software\\net.insidemedia.abw.preview")
        );
        assert!(!enabled_under(&test_root, "Run", "ABW").unwrap());
        for enabled in [true, false, false, true] {
            set_enabled_under(
                &test_root,
                "Run",
                "ABW",
                "Preferences",
                enabled,
                false,
                executable,
            )
            .unwrap();
            assert_eq!(enabled_under(&test_root, "Run", "ABW").unwrap(), enabled);
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
        set_enabled_under(
            &test_root,
            "Run",
            "ABW",
            "Preferences",
            true,
            true,
            executable,
        )
        .unwrap();
        let minimized_command: String = test_root
            .open_subkey("Run")
            .unwrap()
            .get_value("ABW")
            .unwrap();
        assert_eq!(
            minimized_command,
            "\"C:\\Users\\Test User\\ABW.exe\" --minimized"
        );
        drop(test_root);
        assert!(sandbox.starts_with("Software\\ABW-Tests\\"));
        root.delete_subkey_all(sandbox).unwrap();
    }
}
