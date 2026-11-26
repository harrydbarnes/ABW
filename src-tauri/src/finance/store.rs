use crate::finance::{default_favourites, FinanceState};
use crate::persistence;
use std::path::{Path, PathBuf};

pub fn state_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("finance-state.json")
}

pub fn load(app_data_dir: &Path) -> Result<FinanceState, String> {
    let mut state: FinanceState = persistence::read(&state_path(app_data_dir))?;
    if state.favourites.is_empty() {
        state.favourites = default_favourites();
    }
    if state.active_favourite_id.is_empty() {
        state.active_favourite_id = "all".to_owned();
    }
    Ok(state)
}

pub fn update<R>(
    app_data_dir: &Path,
    change: impl FnOnce(&mut FinanceState) -> Result<R, String>,
) -> Result<(FinanceState, R), String> {
    persistence::update(&state_path(app_data_dir), |state: &mut FinanceState| {
        if state.favourites.is_empty() {
            state.favourites = default_favourites();
        }
        change(state)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_finance_state_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded.favourites.len(), 3);
        assert_eq!(loaded.active_favourite_id, "all");

        let (updated, _) = update(dir.path(), |state| {
            state.active_favourite_id = "my-team".to_owned();
            state.favourites[2].buyers = vec!["ALICE".to_owned(), "BOB".to_owned()];
            Ok(())
        })
        .unwrap();
        assert_eq!(updated.active_favourite_id, "my-team");

        let reloaded = load(dir.path()).unwrap();
        assert_eq!(reloaded.active_favourite_id, "my-team");
        assert_eq!(reloaded.favourites[2].buyers, vec!["ALICE", "BOB"]);
    }
}
