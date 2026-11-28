//! Schema-versioned native sync state stored in the app-owned `library-sync` directory (S-2).

use crate::{
    error::Error,
    infra::path_authority::{AuthorizedDir, FileWorkspaceHandle},
    library_sync::{
        wire::{is_valid_studio_file_id, LibraryRejectionCode},
        LibrarySyncHandle,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    io::{Read, Write},
    path::Path,
};

pub(crate) const STATE_FILE_NAME: &str = "library-sync-state.json";
pub(crate) const STATE_VERSION: u32 = 1;
pub(crate) const MAX_STATE_ENTRIES: usize = 4096;
const MAX_STATE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SyncMode {
    #[default]
    Off,
    On,
    Removing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileRejection {
    pub content_sha256: String,
    pub code: LibraryRejectionCode,
    pub game_number: Option<u32>,
}

/// Relative locator persisted via the shared `linked_collections` helpers (CR-2).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct StoredLocator(
    #[serde(
        serialize_with = "crate::db::linked_collections::serialize_locator",
        deserialize_with = "crate::db::linked_collections::deserialize_locator"
    )]
    pub Vec<OsString>,
);

/// Origin of a synced item. Defaults to `File` so v1 state files without `source` keep loading.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SyncSource {
    #[default]
    File,
    Database,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncEntry {
    #[serde(default)]
    pub source: SyncSource,
    #[serde(
        serialize_with = "crate::db::linked_collections::serialize_locator",
        deserialize_with = "crate::db::linked_collections::deserialize_locator"
    )]
    pub locator: Vec<OsString>,
    /// Current-session handle; not persisted because file handles do not survive a restart (P16).
    #[serde(skip)]
    pub handle: Option<LibrarySyncHandle>,
    pub selected: bool,
    pub last_content_sha256: Option<String>,
    pub missed_scans: u32,
    pub last_rejection: Option<FileRejection>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncState {
    pub version: u32,
    pub account_id: Option<String>,
    pub mode: SyncMode,
    pub workspace: Option<FileWorkspaceHandle>,
    pub entries: BTreeMap<String, SyncEntry>,
    /// Initial deselections recorded at turn-on before the first server list runs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_deselected_locators: Vec<StoredLocator>,
    /// Gate-failing database candidates explicitly selected at turn-on or via `set_file_selected`
    /// before the first complete scan mints entries.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_selected_locators: Vec<StoredLocator>,
}

impl Default for SyncState {
    fn default() -> Self {
        Self::off()
    }
}

impl SyncState {
    pub(crate) fn off() -> Self {
        Self {
            version: STATE_VERSION,
            account_id: None,
            mode: SyncMode::Off,
            workspace: None,
            entries: BTreeMap::new(),
            pending_deselected_locators: Vec::new(),
            pending_selected_locators: Vec::new(),
        }
    }

    /// Reads the persisted state from `directory`. An absent, corrupt, oversized, or
    /// other-schema file reads as "sync off" and is replaced on the next write.
    pub(crate) fn load(directory: &AuthorizedDir) -> Self {
        let mut file = match directory.open_regular_relative(Path::new(STATE_FILE_NAME)) {
            Ok(file) => file,
            Err(error) if error.is_missing_entry() => return Self::off(),
            Err(error) => {
                log::warn!("library sync state could not be opened: {error}");
                return Self::off();
            }
        };
        let mut bytes = Vec::new();
        if let Err(error) = (&mut file)
            .take(MAX_STATE_BYTES.saturating_add(1))
            .read_to_end(&mut bytes)
        {
            log::warn!("library sync state could not be read: {error}");
            return Self::off();
        }
        if bytes.len() as u64 > MAX_STATE_BYTES {
            log::warn!("library sync state exceeded size limit; resetting to off");
            return Self::off();
        }
        match serde_json::from_slice::<Self>(&bytes) {
            Ok(mut state)
                if state.version == STATE_VERSION && state.entries.len() <= MAX_STATE_ENTRIES =>
            {
                let before = state.entries.len();
                state.entries.retain(|id, _| is_valid_studio_file_id(id));
                if state.entries.len() != before {
                    log::warn!(
                        "dropped {} library sync state entries with non-UUID keys",
                        before - state.entries.len()
                    );
                }
                state
            }
            Ok(state) => {
                log::warn!(
                    "library sync state schema version {} or entry count {} unsupported; resetting to off",
                    state.version,
                    state.entries.len()
                );
                Self::off()
            }
            Err(error) => {
                log::warn!("library sync state was corrupt: {error}");
                Self::off()
            }
        }
    }

    /// Atomically persists `self` into `directory`. On failure nothing in memory changes.
    pub(crate) fn save(&self, directory: &AuthorizedDir) -> Result<(), Error> {
        let bytes = serde_json::to_vec(self)
            .map_err(|_| Error::InvalidInput("library sync state serialization failed".into()))?;
        let (_outcome, _) =
            directory.atomic_replace_leaf_identified(OsStr::new(STATE_FILE_NAME), |file| {
                file.write_all(&bytes)?;
                Ok(())
            })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::path_authority::{
        ensure_app_owned_default_dir, AppDataDir, AppOwnedDefaultRoot, PathRef,
    };

    fn test_dir() -> (tempfile::TempDir, AuthorizedDir) {
        let temp = tempfile::tempdir().unwrap();
        let dir = ensure_app_owned_default_dir(
            &AppDataDir::for_test(temp.path()),
            AppOwnedDefaultRoot::LibrarySync,
        )
        .unwrap();
        (temp, dir)
    }

    #[test]
    fn absent_corrupt_and_other_schema_read_as_off() {
        let (_temp, dir) = test_dir();
        assert_eq!(SyncState::load(&dir), SyncState::off());

        std::fs::write(dir.path().join(STATE_FILE_NAME), b"{not valid json").unwrap();
        assert_eq!(SyncState::load(&dir), SyncState::off());

        let future = serde_json::json!({
            "version": STATE_VERSION + 1,
            "accountId": "u1",
            "mode": "on",
            "workspace": null,
            "entries": {}
        });
        std::fs::write(
            dir.path().join(STATE_FILE_NAME),
            serde_json::to_vec(&future).unwrap(),
        )
        .unwrap();
        assert_eq!(SyncState::load(&dir), SyncState::off());
    }

    #[test]
    fn load_drops_non_uuid_entry_keys() {
        let (_temp, dir) = test_dir();
        let mut state = SyncState::off();
        state.mode = SyncMode::On;
        state.entries.insert(
            "11111111-1111-4111-8111-111111111111".into(),
            SyncEntry {
                source: SyncSource::File,
                locator: vec![OsString::from("ok.pgn")],
                handle: None,
                selected: true,
                last_content_sha256: None,
                missed_scans: 0,
                last_rejection: None,
            },
        );
        state.entries.insert(
            "../evil".into(),
            SyncEntry {
                source: SyncSource::File,
                locator: vec![OsString::from("bad.pgn")],
                handle: None,
                selected: true,
                last_content_sha256: None,
                missed_scans: 0,
                last_rejection: None,
            },
        );
        state.save(&dir).unwrap();
        let loaded = SyncState::load(&dir);
        assert_eq!(loaded.entries.len(), 1);
        assert!(loaded
            .entries
            .contains_key("11111111-1111-4111-8111-111111111111"));
    }

    #[test]
    fn save_and_load_round_trip_preserves_state_and_drops_session_handles() {
        let (_temp, dir) = test_dir();
        let workspace = FileWorkspaceHandle::new(PathRef {
            id: "ws-1".to_owned(),
        });
        let file_handle = LibrarySyncHandle::File(FileWorkspaceHandle::new(PathRef {
            id: "file-1".to_owned(),
        }));

        let mut state = SyncState {
            version: STATE_VERSION,
            account_id: Some("acct-1".into()),
            mode: SyncMode::On,
            workspace: Some(workspace.clone()),
            entries: BTreeMap::new(),
            pending_deselected_locators: vec![StoredLocator(vec![OsString::from("skip.pgn")])],
            pending_selected_locators: vec![StoredLocator(vec![OsString::from("mega.db3")])],
        };
        state.entries.insert(
            "11111111-1111-4111-8111-111111111111".into(),
            SyncEntry {
                source: SyncSource::File,
                locator: vec![OsString::from("Openings"), OsString::from("Sicilian.pgn")],
                handle: Some(file_handle),
                selected: false,
                last_content_sha256: Some("deadbeef".into()),
                missed_scans: 1,
                last_rejection: Some(FileRejection {
                    content_sha256: "deadbeef".into(),
                    code: LibraryRejectionCode::InvalidPgn,
                    game_number: Some(2),
                }),
            },
        );
        state.entries.insert(
            "33333333-3333-4333-8333-333333333333".into(),
            SyncEntry {
                source: SyncSource::Database,
                locator: vec![OsString::from("personal.db3")],
                handle: None,
                selected: true,
                last_content_sha256: Some("cafebabe".into()),
                missed_scans: 0,
                last_rejection: None,
            },
        );

        state.save(&dir).unwrap();
        let loaded = SyncState::load(&dir);
        assert_eq!(loaded.account_id.as_deref(), Some("acct-1"));
        assert_eq!(loaded.mode, SyncMode::On);
        assert_eq!(loaded.workspace, Some(workspace));
        assert_eq!(
            loaded.pending_deselected_locators,
            vec![StoredLocator(vec![OsString::from("skip.pgn")])]
        );
        assert_eq!(
            loaded.pending_selected_locators,
            vec![StoredLocator(vec![OsString::from("mega.db3")])]
        );
        let entry = loaded
            .entries
            .get("11111111-1111-4111-8111-111111111111")
            .unwrap();
        assert_eq!(entry.source, SyncSource::File);
        assert_eq!(entry.handle, None);
        assert_eq!(
            entry.locator,
            vec![OsString::from("Openings"), OsString::from("Sicilian.pgn")]
        );
        assert!(!entry.selected);
        assert_eq!(entry.missed_scans, 1);
        assert_eq!(
            entry.last_rejection,
            Some(FileRejection {
                content_sha256: "deadbeef".into(),
                code: LibraryRejectionCode::InvalidPgn,
                game_number: Some(2),
            })
        );
        let db_entry = loaded
            .entries
            .get("33333333-3333-4333-8333-333333333333")
            .unwrap();
        assert_eq!(db_entry.source, SyncSource::Database);
        assert_eq!(db_entry.locator, vec![OsString::from("personal.db3")]);
    }

    #[test]
    fn v1_state_without_source_loads_as_file_entries_and_stays_on() {
        let (_temp, dir) = test_dir();
        let workspace = FileWorkspaceHandle::new(PathRef {
            id: "ws-1".to_owned(),
        });
        let mut original = SyncState {
            version: STATE_VERSION,
            account_id: Some("acct-v1".into()),
            mode: SyncMode::On,
            workspace: Some(workspace),
            entries: BTreeMap::new(),
            pending_deselected_locators: Vec::new(),
            pending_selected_locators: Vec::new(),
        };
        original.entries.insert(
            "11111111-1111-4111-8111-111111111111".into(),
            SyncEntry {
                source: SyncSource::File,
                locator: vec![OsString::from("Repertoire.pgn")],
                handle: None,
                selected: true,
                last_content_sha256: Some("abc123".into()),
                missed_scans: 0,
                last_rejection: None,
            },
        );
        // Strip the additive `source` field to match a pre-database v1 persisted file.
        let mut v1_json = serde_json::to_value(&original).unwrap();
        v1_json["entries"]["11111111-1111-4111-8111-111111111111"]
            .as_object_mut()
            .unwrap()
            .remove("source");
        assert!(v1_json["entries"]["11111111-1111-4111-8111-111111111111"]
            .get("source")
            .is_none());
        std::fs::write(
            dir.path().join(STATE_FILE_NAME),
            serde_json::to_vec(&v1_json).unwrap(),
        )
        .unwrap();

        let loaded = SyncState::load(&dir);
        assert_eq!(loaded.version, STATE_VERSION);
        assert_eq!(loaded.mode, SyncMode::On);
        assert_eq!(loaded.account_id.as_deref(), Some("acct-v1"));
        assert!(loaded.pending_selected_locators.is_empty());
        let entry = loaded
            .entries
            .get("11111111-1111-4111-8111-111111111111")
            .expect("v1 entry must load");
        assert_eq!(entry.source, SyncSource::File);
        assert_eq!(entry.locator, vec![OsString::from("Repertoire.pgn")]);
        assert!(entry.selected);
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_locator_round_trips_through_shared_helpers() {
        use std::os::unix::ffi::OsStringExt;

        let (_temp, dir) = test_dir();
        let mut state = SyncState::off();
        state.mode = SyncMode::On;
        let weird = OsString::from_vec(vec![b'a', 0xff, b'.', b'p', b'g', b'n']);
        state.entries.insert(
            "22222222-2222-4222-8222-222222222222".into(),
            SyncEntry {
                source: SyncSource::File,
                locator: vec![weird.clone()],
                handle: None,
                selected: true,
                last_content_sha256: None,
                missed_scans: 0,
                last_rejection: None,
            },
        );
        state.save(&dir).unwrap();
        let loaded = SyncState::load(&dir);
        assert_eq!(
            loaded
                .entries
                .get("22222222-2222-4222-8222-222222222222")
                .unwrap()
                .locator,
            vec![weird]
        );
    }

    #[cfg(unix)]
    #[test]
    fn unwritable_directory_returns_error() {
        use std::os::unix::fs::PermissionsExt;

        let (_temp, dir) = test_dir();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = SyncState::off().save(&dir);
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
    }
}
