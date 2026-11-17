//! Native store for games that were never saved.
//!
//! The renderer keeps every open tab in `sessionStorage`, which the webview holds only in memory,
//! so a crash or quit loses an unsaved game. This store keeps one durable copy per protected tab in
//! the app-owned `unsaved-games` directory until the renderer saves or discards that game.
//!
//! The document is opaque UTF-8 text owned by the renderer (`src/state/unsavedGames.ts`); this
//! module only bounds its size and names it by the tab's UUID. Nothing here deletes a file on its
//! own: a leaf disappears only through `remove` of an id the renderer saved or discarded, or
//! through `clear` after the user confirmed "Clear saved data".

use crate::{
    error::{DurabilityStage, Error},
    infra::{
        blocking::BLOCKING_GATEWAY,
        fs::DirectoryEntryKind,
        path_authority::{AppDataDir, AppOwnedDefaultRoot, AuthorizedDir},
    },
};
use serde::Serialize;
use std::{ffi::OsStr, io::Write, path::Path};

/// Largest document accepted on write and returned by list.
pub(crate) const UNSAVED_GAME_MAX_BYTES: usize = 32 * 1024 * 1024;
/// Most entries (records plus skipped) one list returns; the rest are only counted.
pub(crate) const UNSAVED_GAME_LIST_MAX_ENTRIES: usize = 256;

const LEAF_SUFFIX: &str = ".json";
const SIZE_LIMIT_MESSAGE: &str = "unsaved game exceeds its size limit";

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

/// The canonical lowercase hyphenated UUID, or `None` for any other spelling.
fn canonical_id(id: &str) -> Option<String> {
    let parsed = uuid::Uuid::parse_str(id).ok()?;
    let canonical = parsed.hyphenated().to_string();
    (canonical == id).then_some(canonical)
}

fn leaf_for(id: &str) -> Result<String, Error> {
    canonical_id(id)
        .map(|id| format!("{id}{LEAF_SUFFIX}"))
        .ok_or_else(|| Error::InvalidInput("unsaved game id is not a UUID".into()))
}

/// The id a leaf name stands for, or `None` for a name this store does not own.
fn id_of_leaf(name: &OsStr) -> Option<String> {
    let name = name.to_str()?;
    canonical_id(name.strip_suffix(LEAF_SUFFIX)?)
}

fn io_error(operation: &str, id: &str, error: std::io::Error) -> Error {
    log::warn!("unsaved game {operation} failed for {id}: {error}");
    Error::Io(Box::new(crate::error::sanitized_io_error(
        &error,
        format!("unsaved game {operation} failed"),
    )))
}

fn operation_error(operation: &str, id: &str, error: Error) -> Error {
    match error {
        Error::Io(source) => io_error(operation, id, *source),
        other => other,
    }
}

pub(crate) fn write_in(directory: &AuthorizedDir, id: &str, document: &str) -> Result<(), Error> {
    let leaf = leaf_for(id)?;
    if document.len() > UNSAVED_GAME_MAX_BYTES {
        return Err(Error::ResourceLimit(SIZE_LIMIT_MESSAGE.into()));
    }
    let (outcome, _) = directory
        .atomic_replace_leaf_identified(OsStr::new(&leaf), |file| {
            file.write_all(document.as_bytes())
                .map_err(|error| io_error("write", id, error))
        })
        .map_err(|error| operation_error("write", id, error))?;
    crate::infra::fs::require_durable(outcome, DurabilityStage::UnsavedGame)
}

/// Every leaf this store owns, sorted by id so listing and clearing are deterministic.
fn owned_entries(
    directory: &AuthorizedDir,
) -> Result<Vec<(String, crate::infra::fs::DirectoryEntry)>, Error> {
    let mut entries: Vec<_> = directory
        .entries(&mut |name| id_of_leaf(name).is_some())?
        .into_iter()
        .filter_map(|entry| id_of_leaf(&entry.name).map(|id| (id, entry)))
        .collect();
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(entries)
}

enum ReadOutcome {
    Document(String),
    Skipped(&'static str),
}

fn read_document(directory: &AuthorizedDir, id: &str, leaf: &OsStr) -> Result<ReadOutcome, Error> {
    let mut file = match directory.open_regular_relative(Path::new(leaf)) {
        Ok(file) => file,
        Err(error) if error.is_missing_entry() => return Ok(ReadOutcome::Skipped("missing")),
        Err(error) => return Err(operation_error("read", id, error)),
    };
    let declared = file
        .metadata()
        .map_err(|error| io_error("read", id, error))?
        .len();
    if declared > UNSAVED_GAME_MAX_BYTES as u64 {
        return Ok(ReadOutcome::Skipped("oversized"));
    }
    let bytes = match crate::infra::fs::read_bounded_bytes(
        &mut file,
        declared,
        UNSAVED_GAME_MAX_BYTES,
        SIZE_LIMIT_MESSAGE,
        || Ok(()),
    ) {
        Ok(bytes) => bytes,
        Err(Error::ResourceLimit(_)) => return Ok(ReadOutcome::Skipped("oversized")),
        Err(error) => return Err(operation_error("read", id, error)),
    };
    Ok(match String::from_utf8(bytes) {
        Ok(document) => ReadOutcome::Document(document),
        Err(_) => ReadOutcome::Skipped("not UTF-8"),
    })
}

pub(crate) fn list_in(directory: &AuthorizedDir) -> Result<UnsavedGameInventory, Error> {
    let entries = owned_entries(directory)?;
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
        if entry.kind != DirectoryEntryKind::RegularFile {
            inventory.skipped.push(UnsavedGameSkip {
                id,
                reason: "not a regular file".into(),
            });
            continue;
        }
        // One unreadable leaf must not hide the others; it is reported, never deleted.
        match read_document(directory, &id, &entry.name) {
            Ok(ReadOutcome::Document(document)) => {
                inventory.records.push(UnsavedGameRecord { id, document })
            }
            Ok(ReadOutcome::Skipped(reason)) => inventory.skipped.push(UnsavedGameSkip {
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
    let Some((_, entry)) = owned_entries(directory)?
        .into_iter()
        .find(|(entry_id, _)| entry_id == id)
    else {
        return Ok(());
    };
    match directory.remove_leaf_identified_pair(OsStr::new(&leaf), entry.identity) {
        Ok(()) => Ok(()),
        Err(error) if error.is_missing_entry() => Ok(()),
        Err(error) => Err(operation_error("remove", id, error)),
    }
}

/// Removes every leaf this store owns. Returns the ids that could not be removed.
pub(crate) fn clear_in(directory: &AuthorizedDir) -> Result<Vec<String>, Error> {
    let mut leftover = Vec::new();
    for (id, entry) in owned_entries(directory)? {
        match directory.remove_leaf_identified_pair(&entry.name, entry.identity) {
            Ok(()) => {}
            Err(error) if error.is_missing_entry() => {}
            Err(error) => {
                log::warn!("unsaved game clear could not remove {id}: {error}");
                leftover.push(id);
            }
        }
    }
    Ok(leftover)
}

fn unsaved_games_directory(app: &tauri::AppHandle) -> Result<AuthorizedDir, Error> {
    crate::infra::path_authority::ensure_app_owned_default_dir(
        &AppDataDir::for_app(app)?,
        AppOwnedDefaultRoot::UnsavedGames,
    )
}

async fn run<T, F>(app: tauri::AppHandle, operation: F) -> Result<T, Error>
where
    T: Send + 'static,
    F: FnOnce(&AuthorizedDir) -> Result<T, Error> + Send + 'static,
{
    BLOCKING_GATEWAY
        .spawn(move || {
            let directory = unsaved_games_directory(&app)?;
            operation(&directory)
        })
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn write_unsaved_game(
    app: tauri::AppHandle,
    id: String,
    document: String,
) -> Result<(), Error> {
    run(app, move |directory| write_in(directory, &id, &document)).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_unsaved_games(app: tauri::AppHandle) -> Result<UnsavedGameInventory, Error> {
    run(app, list_in).await
}

#[tauri::command]
#[specta::specta]
pub async fn remove_unsaved_game(app: tauri::AppHandle, id: String) -> Result<(), Error> {
    run(app, move |directory| remove_in(directory, &id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn clear_unsaved_games(app: tauri::AppHandle) -> Result<Vec<String>, Error> {
    run(app, clear_in).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::path_authority::ensure_app_owned_default_dir;

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
