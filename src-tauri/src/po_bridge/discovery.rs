use super::{env, folder, fs, paired_origin, register, Path, PathBuf, Value};
use std::collections::BTreeMap;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

// Existing unpacked Ops Toolshed installation. Other IDs require confirmation.
const TRUSTED_ID: &str = "dbcdjeologmmlnpmgcidnhdpieebhopj";

pub(super) fn valid_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn toolshed_path(entry: &Value) -> Option<PathBuf> {
    if entry["state"].as_i64().is_some_and(|state| state != 1)
        || entry["disable_reasons"]
            .as_array()
            .is_some_and(|reasons| !reasons.is_empty())
        || entry["disable_reasons"]
            .as_u64()
            .is_some_and(|reasons| reasons != 0)
    {
        return None;
    }
    let path = PathBuf::from(entry["path"].as_str()?);
    let manifest = if entry["location"].as_u64() == Some(4) {
        // Chrome stores only the folder for unpacked extensions.
        if !path.is_absolute()
            || !matches!(path.components().next(),
            Some(std::path::Component::Prefix(prefix)) if matches!(prefix.kind(),
                std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)))
        {
            return None;
        }
        read_json(&path.join("manifest.json"))?
    } else {
        entry["manifest"].clone()
    };
    (manifest["name"].as_str() == Some("Ops Toolshed")
        && manifest["permissions"]
            .as_array()?
            .iter()
            .any(|permission| permission == "nativeMessaging"))
    .then_some(path)
}

fn installed_toolshed(chrome_data: &Path) -> BTreeMap<String, PathBuf> {
    let mut installs = BTreeMap::new();
    let Ok(profiles) = fs::read_dir(chrome_data) else {
        return installs;
    };
    for profile in profiles.flatten() {
        for name in ["Secure Preferences", "Preferences"] {
            let Some(prefs) = read_json(&profile.path().join(name)) else {
                continue;
            };
            let Some(entries) = prefs["extensions"]["settings"].as_object() else {
                continue;
            };
            for (id, entry) in entries {
                if valid_extension_id(id) {
                    if let Some(path) = toolshed_path(entry) {
                        installs.entry(id.clone()).or_insert(path);
                    }
                }
            }
        }
    }
    installs
}

pub(crate) fn pair_on_startup(app: &tauri::AppHandle) {
    if let Some(id) = paired_origin().as_deref().and_then(|origin| {
        origin
            .strip_prefix("chrome-extension://")?
            .strip_suffix('/')
    }) {
        // Keep an existing choice and repair the executable path after an upgrade.
        let _ = register(id);
        return;
    }
    let Some(local_app_data) = env::var_os("LOCALAPPDATA") else {
        return;
    };
    let chrome_data = PathBuf::from(local_app_data).join(r"Google\Chrome\User Data");
    let mut installs = installed_toolshed(&chrome_data);
    if installs.contains_key(TRUSTED_ID) {
        let _ = register(TRUSTED_ID);
        return;
    }
    if installs.len() != 1 {
        return;
    }
    let Some((id, path)) = installs.pop_first() else {
        return;
    };
    let Ok(root) = folder() else {
        return;
    };
    let declined = root.join("declined-chrome-extension");
    if fs::read_to_string(&declined).as_deref().ok() == Some(id.as_str()) {
        return;
    }
    app.dialog()
        .message(format!(
            "Allow this Ops Toolshed extension to receive booking details and return PO check results?\n\n{}\n{}",
            path.display(), id
        ))
        .title("Set up automatic PO checks")
        .buttons(MessageDialogButtons::OkCancelCustom("Pair".into(), "Skip".into()))
        .show(move |confirmed| {
            if confirmed {
                let _ = register(&id);
            } else if fs::create_dir_all(&root).is_ok() {
                let _ = fs::write(declined, id);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn discovers_the_enabled_toolshed_across_both_preference_files() {
        let temp = tempfile::tempdir().unwrap();
        let extension = temp.path().join("Ops Toolshed");
        fs::create_dir(&extension).unwrap();
        fs::write(
            extension.join("manifest.json"),
            br#"{"name":"Ops Toolshed","permissions":["nativeMessaging"]}"#,
        )
        .unwrap();
        let default = temp.path().join("Default");
        let second = temp.path().join("Profile 1");
        fs::create_dir(&default).unwrap();
        fs::create_dir(&second).unwrap();
        let disabled = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let unrelated = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let invalid = "invalid";
        let installed = json!({"location": 4, "path": extension});
        let prefs = json!({"extensions":{"settings":{
            (TRUSTED_ID): installed,
            (invalid): installed,
            (disabled): {"location": 4, "path": extension, "disable_reasons": [1]},
            (unrelated): {"path": "other", "manifest":{"name":"Other","permissions":["nativeMessaging"]}}
        }}});
        fs::write(default.join("Secure Preferences"), prefs.to_string()).unwrap();
        fs::write(second.join("Preferences"), prefs.to_string()).unwrap();
        assert_eq!(
            installed_toolshed(temp.path()),
            BTreeMap::from([(TRUSTED_ID.into(), extension)])
        );
    }
}
