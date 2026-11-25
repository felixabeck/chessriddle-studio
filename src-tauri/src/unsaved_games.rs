//! Legacy native store for 1.1.0 unsaved-game recovery copies.
//!
//! New writes go to [`crate::workspace_session`]; this module only lists, removes, and clears
//! existing `<app_data>/unsaved-games/<uuid>.json` records so games saved by 1.1.0 can be migrated
//! once and removed after confirmation.

use crate::{
    error::Error,
    infra::path_authority::{AppOwnedDefaultRoot, AuthorizedDir},
    keyed_leaf_store::{
        canonical_uuid, clear_owned_leaves, owned_entries, read_entry_leaf, remove_owned_leaf,
        run_in_app_root, uuid_leaf_key, LeafReadOutcome, LeafStoreConfig, LEAF_SUFFIX,
        MAX_LEAF_BYTES,
    },
};
use serde::Serialize;
use std::ffi::OsStr;

/// Largest document accepted on read.
pub(crate) const UNSAVED_GAME_MAX_BYTES: usize = MAX_LEAF_BYTES;
/// Most entries (records plus skipped) one list returns; the rest are only counted.
pub(crate) const UNSAVED_GAME_LIST_MAX_ENTRIES: usize = 256;

const STORE_LABEL: &str = "unsaved game";
const STORE_CONFIG: LeafStoreConfig = LeafStoreConfig {
    label: STORE_LABEL,
    max_bytes: UNSAVED_GAME_MAX_BYTES,
    size_limit_message: "unsaved game exceeds its size limit",
    durability_stage: crate::error::DurabilityStage::UnsavedGame,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UnsavedGameRecord {
    pub id: String,
    pub document: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UnsavedGameSkip {
    pub id: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UnsavedGameInventory {
    pub records: Vec<UnsavedGameRecord>,
    pub skipped: Vec<UnsavedGameSkip>,
    // Valid-named leaves beyond UNSAVED_GAME_LIST_MAX_ENTRIES, neither read nor returned. A
    // plain comment: a doc comment is exported into the generated bindings with a trailing space.
    pub omitted: u32,
}

fn leaf_for(id: &str) -> Result<String, Error> {
    canonical_uuid(id)
        .map(|id| format!("{id}{LEAF_SUFFIX}"))
        .ok_or_else(|| Error::InvalidInput("unsaved game id is not a UUID".into()))
}

#[cfg(test)]
pub(crate) fn write_in(directory: &AuthorizedDir, id: &str, document: &str) -> Result<(), Error> {
    let leaf = leaf_for(id)?;
    crate::keyed_leaf_store::write_leaf(directory, &STORE_CONFIG, id, OsStr::new(&leaf), document)
}

pub(crate) fn list_in(directory: &AuthorizedDir) -> Result<UnsavedGameInventory, Error> {
    let entries = owned_entries(directory, uuid_leaf_key)?;
    let mut inventory = UnsavedGameInventory {
        records: Vec::new(),
        skipped: Vec::new(),
        omitted: 0,
    };
    for (index, (id, entry)) in entries.into_iter().enumerate() {
        if index >= UNSAVED_GAME_LIST_MAX_ENTRIES {
            inventory.omitted = inventory.omitted.saturating_add(1);
            continue;
        }
        // One unreadable leaf must not hide the others; it is reported, never deleted.
        match read_entry_leaf(directory, &STORE_CONFIG, &id, &entry) {
            Ok(LeafReadOutcome::Content(document)) => {
                inventory.records.push(UnsavedGameRecord { id, document })
            }
            Ok(LeafReadOutcome::Absent) => inventory.skipped.push(UnsavedGameSkip {
                id,
                reason: "missing".into(),
            }),
            Ok(LeafReadOutcome::Skipped(reason)) => inventory.skipped.push(UnsavedGameSkip {
                id,
                reason: reason.into(),
            }),
            Err(error) => inventory.skipped.push(UnsavedGameSkip {
                id,
                reason: error.to_string(),
            }),
        }
    }
    Ok(inventory)
}

pub(crate) fn remove_in(directory: &AuthorizedDir, id: &str) -> Result<(), Error> {
    let leaf = leaf_for(id)?;
    remove_owned_leaf(directory, STORE_LABEL, id, OsStr::new(&leaf), uuid_leaf_key)
}

/// Removes every leaf this store owns. Returns the ids that could not be removed.
pub(crate) fn clear_in(directory: &AuthorizedDir) -> Result<Vec<String>, Error> {
    clear_owned_leaves(directory, STORE_LABEL, uuid_leaf_key)
}

#[tauri::command]
#[specta::specta]
pub async fn list_unsaved_games(app: tauri::AppHandle) -> Result<UnsavedGameInventory, Error> {
    run_in_app_root(app, AppOwnedDefaultRoot::UnsavedGames, list_in).await
}

#[tauri::command]
#[specta::specta]
pub async fn remove_unsaved_game(app: tauri::AppHandle, id: String) -> Result<(), Error> {
    run_in_app_root(app, AppOwnedDefaultRoot::UnsavedGames, move |directory| {
        remove_in(directory, &id)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn clear_unsaved_games(app: tauri::AppHandle) -> Result<Vec<String>, Error> {
    run_in_app_root(app, AppOwnedDefaultRoot::UnsavedGames, clear_in).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::path_authority::{ensure_app_owned_default_dir, AppDataDir};

    const ID_A: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const ID_B: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

    fn directory() -> (tempfile::TempDir, AuthorizedDir) {
        let temp = tempfile::tempdir().unwrap();
        let app_data = AppDataDir::for_test(temp.path());
        let directory =
            ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::UnsavedGames).unwrap();
        (temp, directory)
    }

    fn store_path(temp: &tempfile::TempDir) -> std::path::PathBuf {
        temp.path().join("unsaved-games")
    }

    #[test]
    fn unsaved_games_write_then_list_round_trips_the_document() {
        let (_temp, directory) = directory();
        write_in(&directory, ID_B, "{\"b\":1}").unwrap();
        write_in(&directory, ID_A, "{\"a\":\"Kommentar ä\"}").unwrap();
        write_in(&directory, ID_A, "{\"a\":2}").unwrap();

        let inventory = list_in(&directory).unwrap();
        assert_eq!(
            inventory.records,
            vec![
                UnsavedGameRecord {
                    id: ID_A.into(),
                    document: "{\"a\":2}".into()
                },
                UnsavedGameRecord {
                    id: ID_B.into(),
                    document: "{\"b\":1}".into()
                },
            ]
        );
        assert!(inventory.skipped.is_empty());
        assert_eq!(inventory.omitted, 0);
    }

    #[test]
    fn unsaved_games_write_refuses_non_uuid_ids_and_oversized_documents() {
        let (temp, directory) = directory();
        for id in ["../x", "not-a-uuid", &ID_A.to_uppercase(), ""] {
            assert!(matches!(
                write_in(&directory, id, "{}"),
                Err(Error::InvalidInput(_))
            ));
        }
        let oversized = "x".repeat(UNSAVED_GAME_MAX_BYTES + 1);
        assert!(matches!(
            write_in(&directory, ID_A, &oversized),
            Err(Error::ResourceLimit(_))
        ));
        assert_eq!(std::fs::read_dir(store_path(&temp)).unwrap().count(), 0);
    }

    #[test]
    fn unsaved_games_list_skips_bad_leaves_and_never_deletes_them() {
        let (temp, directory) = directory();
        let store = store_path(&temp);
        write_in(&directory, ID_A, "{}").unwrap();
        std::fs::write(store.join(format!("{ID_B}.json")), [0xff_u8, 0xfe, 0x00]).unwrap();
        std::fs::write(store.join("notes.txt"), "foreign").unwrap();
        let oversized_id = "11111111-1111-4111-8111-111111111111";
        let oversized = std::fs::File::create(store.join(format!("{oversized_id}.json"))).unwrap();
        oversized
            .set_len(UNSAVED_GAME_MAX_BYTES as u64 + 1)
            .unwrap();
        drop(oversized);

        let inventory = list_in(&directory).unwrap();
        assert_eq!(inventory.records.len(), 1);
        assert_eq!(inventory.records[0].id, ID_A);
        let skipped: Vec<_> = inventory
            .skipped
            .iter()
            .map(|skip| (skip.id.as_str(), skip.reason.as_str()))
            .collect();
        assert_eq!(
            skipped,
            vec![(oversized_id, "oversized"), (ID_B, "not UTF-8")]
        );
        assert!(store.join(format!("{ID_B}.json")).exists());
        assert!(store.join(format!("{oversized_id}.json")).exists());
        assert!(store.join("notes.txt").exists());
    }

    #[test]
    fn unsaved_games_list_counts_entries_beyond_the_cap() {
        let (_temp, directory) = directory();
        for index in 0..(UNSAVED_GAME_LIST_MAX_ENTRIES + 3) {
            let id = uuid::Uuid::from_u128(index as u128 + 1)
                .hyphenated()
                .to_string();
            write_in(&directory, &id, "{}").unwrap();
        }
        let inventory = list_in(&directory).unwrap();
        assert_eq!(inventory.records.len(), UNSAVED_GAME_LIST_MAX_ENTRIES);
        assert_eq!(inventory.omitted, 3);
    }

    #[test]
    fn unsaved_games_remove_deletes_one_record_and_accepts_a_missing_one() {
        let (_temp, directory) = directory();
        write_in(&directory, ID_A, "{}").unwrap();
        write_in(&directory, ID_B, "{}").unwrap();
        remove_in(&directory, ID_A).unwrap();
        remove_in(&directory, ID_A).unwrap();
        let ids: Vec<_> = list_in(&directory)
            .unwrap()
            .records
            .into_iter()
            .map(|record| record.id)
            .collect();
        assert_eq!(ids, vec![ID_B.to_string()]);
        assert!(matches!(
            remove_in(&directory, "../x"),
            Err(Error::InvalidInput(_))
        ));
    }

    #[test]
    fn unsaved_games_clear_removes_every_owned_leaf_and_keeps_foreign_names() {
        let (temp, directory) = directory();
        let store = store_path(&temp);
        write_in(&directory, ID_A, "{}").unwrap();
        std::fs::write(store.join(format!("{ID_B}.json")), [0xff_u8]).unwrap();
        std::fs::write(store.join("notes.txt"), "foreign").unwrap();

        assert!(clear_in(&directory).unwrap().is_empty());
        let inventory = list_in(&directory).unwrap();
        assert!(inventory.records.is_empty() && inventory.skipped.is_empty());
        assert!(store.join("notes.txt").exists());
    }
}
