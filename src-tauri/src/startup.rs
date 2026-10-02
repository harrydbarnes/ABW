#[cfg(windows)]
const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
#[cfg(windows)]
const PREFERENCE_KEY: &str = "Software\\net.insidemedia.abw";

#[cfg(windows)]
pub fn enabled() -> Result<bool, String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let key = match RegKey::predef(HKEY_CURRENT_USER).open_subkey(RUN_KEY) {
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
    let (key, _) = root
        .create_subkey(RUN_KEY)
        .map_err(|error| format!("Unable to update Windows startup: {error}"))?;
    if enabled {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        key.set_value("ABW", &format!("\"{}\"", executable.display()))
            .map_err(|error| format!("Unable to enable Windows startup: {error}"))?;
    } else if let Err(error) = key.delete_value("ABW") {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(format!("Unable to disable Windows startup: {error}"));
        }
    }
    let (preference, _) = root
        .create_subkey(PREFERENCE_KEY)
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
