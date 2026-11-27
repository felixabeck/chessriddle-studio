//! Durable native store for the renderer's workspace session keys.
//!
//! Keeps one UTF-8 leaf per mirrored session key inside `<app_data>/workspace-session/`:
//! `workspace.json`, `page-tabs.json`, and `<uuid>.json` for each tab tree. Nothing is deleted by
//! reads; corrupt or orphaned leaves are quarantined via handle-relative rename into
//! `quarantine-<uuid>/` buckets or explicitly removed once the durable workspace no longer owns
//! them.

use crate::{
    error::{DurabilityStage, Error},
    infra::{
        fs::{DirectoryEntry, DirectoryEntryKind},
        path_authority::{AppOwnedDefaultRoot, AuthorizedDir},
    },
    keyed_leaf_store::{
        self, canonical_uuid, clear_owned_leaves, owned_entries, read_entry_leaf,
        remove_owned_leaf, run_in_app_root, uuid_leaf_key, LeafReadOutcome, LeafStoreConfig,
        LEAF_SUFFIX, MAX_LEAF_BYTES,
    },
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    ffi::OsStr,
};

/// Largest session leaf payload accepted on write and returned on read (32 MiB).
pub(crate) const WORKSPACE_SESSION_MAX_BYTES: usize = MAX_LEAF_BYTES;
/// Maximum number of keys accepted in a single `read` or `quarantine` request.
pub(crate) const WORKSPACE_SESSION_READ_MAX_KEYS: usize = 256;
/// Maximum number of UUID leaf names returned by `names`; excess names are counted in `omitted`.
pub(crate) const WORKSPACE_SESSION_NAMES_MAX: usize = 1024;

pub(crate) const WORKSPACE_LEAF_KEY: &str = "workspace";
pub(crate) const PAGE_TABS_LEAF_KEY: &str = "page-tabs";
pub(crate) const QUARANTINE_PREFIX: &str = "quarantine-";
const STORE_LABEL: &str = "workspace session";
const STORE_CONFIG: LeafStoreConfig = LeafStoreConfig {
    label: STORE_LABEL,
    max_bytes: WORKSPACE_SESSION_MAX_BYTES,
    size_limit_message: "workspace session leaf exceeds its size limit",
    durability_stage: DurabilityStage::WorkspaceSession,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorkspaceSessionLeafState {
    Record { content: String },
    Skipped { reason: String },
    Absent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSessionFixedLeaves {
    pub workspace: WorkspaceSessionLeafState,
    pub page_tabs: WorkspaceSessionLeafState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSessionReadEntry {
    pub key: String,
    pub state: WorkspaceSessionLeafState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSessionNames {
    pub names: Vec<String>,
    // Valid UUID leaf names beyond WORKSPACE_SESSION_NAMES_MAX, neither read nor returned.
    pub omitted: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSessionQuarantineFailure {
    pub key: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSessionQuarantineResult {
    pub bucket: Option<String>,
    pub moved: Vec<String>,
    pub failed: Vec<WorkspaceSessionQuarantineFailure>,
}

fn validate_owned_key(key: &str) -> Result<String, Error> {
    if key == WORKSPACE_LEAF_KEY || key == PAGE_TABS_LEAF_KEY {
        return Ok(key.to_string());
    }
    canonical_uuid(key)
        .ok_or_else(|| Error::InvalidInput("workspace session key is not valid".into()))
}

fn validate_uuid_key(key: &str) -> Result<String, Error> {
    canonical_uuid(key)
        .ok_or_else(|| Error::InvalidInput("workspace session leaf key is not a UUID".into()))
}

fn leaf_for_key(key: &str) -> Result<String, Error> {
    let valid = validate_owned_key(key)?;
    Ok(format!("{valid}{LEAF_SUFFIX}"))
}

fn owned_leaf_key(name: &OsStr) -> Option<String> {
    let name = name.to_str()?;
    let stem = name.strip_suffix(LEAF_SUFFIX)?;
    if stem == WORKSPACE_LEAF_KEY || stem == PAGE_TABS_LEAF_KEY {
        return Some(stem.to_string());
    }
    canonical_uuid(stem)
}

fn quarantine_bucket_name(name: &OsStr) -> Option<String> {
    let name = name.to_str()?;
    let suffix = name.strip_prefix(QUARANTINE_PREFIX)?;
    canonical_uuid(suffix).map(|uuid| format!("{QUARANTINE_PREFIX}{uuid}"))
}

fn owned_or_quarantine_key(name: &OsStr) -> Option<String> {
    owned_leaf_key(name).or_else(|| quarantine_bucket_name(name))
}

fn state_for_entry(
    directory: &AuthorizedDir,
    key: &str,
    entry: Option<&DirectoryEntry>,
) -> WorkspaceSessionLeafState {
    let Some(entry) = entry else {
        return WorkspaceSessionLeafState::Absent;
    };
    match read_entry_leaf(directory, &STORE_CONFIG, key, entry) {
        Ok(LeafReadOutcome::Content(content)) => WorkspaceSessionLeafState::Record { content },
        Ok(LeafReadOutcome::Absent) => WorkspaceSessionLeafState::Absent,
        Ok(LeafReadOutcome::Skipped(reason)) => WorkspaceSessionLeafState::Skipped {
            reason: reason.into(),
        },
        Err(error) => WorkspaceSessionLeafState::Skipped {
            reason: error.to_string(),
        },
    }
}

pub(crate) fn write_in(directory: &AuthorizedDir, key: &str, content: &str) -> Result<(), Error> {
    let leaf = leaf_for_key(key)?;
    keyed_leaf_store::write_leaf(directory, &STORE_CONFIG, key, OsStr::new(&leaf), content)
}

pub(crate) fn read_fixed_in(
    directory: &AuthorizedDir,
) -> Result<WorkspaceSessionFixedLeaves, Error> {
    let entries: HashMap<String, DirectoryEntry> = owned_entries(directory, |name| {
        let key = owned_leaf_key(name)?;
        (key == WORKSPACE_LEAF_KEY || key == PAGE_TABS_LEAF_KEY).then_some(key)
    })?
    .into_iter()
    .collect();
    Ok(WorkspaceSessionFixedLeaves {
        workspace: state_for_entry(
            directory,
            WORKSPACE_LEAF_KEY,
            entries.get(WORKSPACE_LEAF_KEY),
        ),
        page_tabs: state_for_entry(
            directory,
            PAGE_TABS_LEAF_KEY,
            entries.get(PAGE_TABS_LEAF_KEY),
        ),
    })
}

pub(crate) fn read_keys_in(
    directory: &AuthorizedDir,
    keys: &[String],
) -> Result<Vec<WorkspaceSessionReadEntry>, Error> {
    if keys.len() > WORKSPACE_SESSION_READ_MAX_KEYS {
        return Err(Error::ResourceLimit(
            "workspace session read exceeds its key limit".into(),
        ));
    }
    let mut validated = Vec::with_capacity(keys.len());
    let mut wanted = HashSet::with_capacity(keys.len());
    for key in keys {
        let valid = validate_uuid_key(key)?;
        wanted.insert(valid.clone());
        validated.push(valid);
    }
    if validated.is_empty() {
        return Ok(Vec::new());
    }
    let entries: HashMap<String, DirectoryEntry> = owned_entries(directory, |name| {
        let key = uuid_leaf_key(name)?;
        wanted.contains(&key).then_some(key)
    })?
    .into_iter()
    .collect();
    Ok(validated
        .into_iter()
        .map(|key| {
            let state = state_for_entry(directory, &key, entries.get(&key));
            WorkspaceSessionReadEntry { key, state }
        })
        .collect())
}

pub(crate) fn list_names_in(directory: &AuthorizedDir) -> Result<WorkspaceSessionNames, Error> {
    let entries = owned_entries(directory, uuid_leaf_key)?;
    let mut names = Vec::with_capacity(entries.len().min(WORKSPACE_SESSION_NAMES_MAX));
    let mut omitted: u32 = 0;
    for (index, (key, _)) in entries.into_iter().enumerate() {
        if index >= WORKSPACE_SESSION_NAMES_MAX {
            omitted = omitted.saturating_add(1);
            continue;
        }
        names.push(key);
    }
    Ok(WorkspaceSessionNames { names, omitted })
}

pub(crate) fn remove_in(directory: &AuthorizedDir, key: &str) -> Result<(), Error> {
    let leaf = leaf_for_key(key)?;
    remove_owned_leaf(
        directory,
        STORE_LABEL,
        key,
        OsStr::new(&leaf),
        owned_leaf_key,
    )
}

fn quarantine_into_bucket_in(
    directory: &AuthorizedDir,
    bucket_name: &str,
    keys: Option<&[String]>,
) -> Result<WorkspaceSessionQuarantineResult, Error> {
    let selected: Vec<(String, DirectoryEntry)> = match keys {
        None => owned_entries(directory, owned_leaf_key)?,
        Some(list) => {
            if list.len() > WORKSPACE_SESSION_READ_MAX_KEYS {
                return Err(Error::ResourceLimit(
                    "workspace session quarantine exceeds its key limit".into(),
                ));
            }
            let mut wanted = HashSet::with_capacity(list.len());
            for key in list {
                wanted.insert(validate_owned_key(key)?);
            }
            if wanted.is_empty() {
                return Ok(WorkspaceSessionQuarantineResult {
                    bucket: None,
                    moved: Vec::new(),
                    failed: Vec::new(),
                });
            }
            owned_entries(directory, |name| {
                let key = owned_leaf_key(name)?;
                wanted.contains(&key).then_some(key)
            })?
        }
    };

    if selected.is_empty() {
        return Ok(WorkspaceSessionQuarantineResult {
            bucket: None,
            moved: Vec::new(),
            failed: Vec::new(),
        });
    }

    let bucket_dir = directory.ensure_child(OsStr::new(bucket_name))?;
    let mut moved = Vec::with_capacity(selected.len());
    let mut failed = Vec::new();
    for (key, entry) in selected {
        let is_dir = entry.kind == DirectoryEntryKind::Directory;
        let move_result = directory
            .rename_entry_into_child(
                &entry.name,
                entry.identity,
                is_dir,
                &bucket_dir,
                &entry.name,
            )
            .and_then(|outcome| {
                crate::infra::fs::require_durable(outcome, DurabilityStage::WorkspaceSession)
            });
        match move_result {
            Ok(()) => moved.push(key),
            Err(error) => {
                log::warn!("{STORE_LABEL} quarantine could not move {key}: {error}");
                failed.push(WorkspaceSessionQuarantineFailure {
                    key,
                    reason: error.to_string(),
                });
            }
        }
    }

    Ok(WorkspaceSessionQuarantineResult {
        bucket: Some(bucket_name.to_string()),
        moved,
        failed,
    })
}

pub(crate) fn quarantine_in(
    directory: &AuthorizedDir,
    keys: Option<&[String]>,
) -> Result<WorkspaceSessionQuarantineResult, Error> {
    let bucket_name = format!("{QUARANTINE_PREFIX}{}", uuid::Uuid::new_v4().hyphenated());
    quarantine_into_bucket_in(directory, &bucket_name, keys)
}

/// Removes every owned leaf and every quarantine bucket. Foreign entries stay untouched.
pub(crate) fn clear_in(directory: &AuthorizedDir) -> Result<Vec<String>, Error> {
    clear_owned_leaves(directory, STORE_LABEL, owned_or_quarantine_key)
}

#[tauri::command]
#[specta::specta]
pub async fn write_workspace_session_leaf(
    app: tauri::AppHandle,
    key: String,
    content: String,
) -> Result<(), Error> {
    run_in_app_root(
        app,
        AppOwnedDefaultRoot::WorkspaceSession,
        move |directory| write_in(directory, &key, &content),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn read_workspace_session_fixed(
    app: tauri::AppHandle,
) -> Result<WorkspaceSessionFixedLeaves, Error> {
    run_in_app_root(app, AppOwnedDefaultRoot::WorkspaceSession, read_fixed_in).await
}

#[tauri::command]
#[specta::specta]
pub async fn read_workspace_session_leaves(
    app: tauri::AppHandle,
    keys: Vec<String>,
) -> Result<Vec<WorkspaceSessionReadEntry>, Error> {
    run_in_app_root(
        app,
        AppOwnedDefaultRoot::WorkspaceSession,
        move |directory| read_keys_in(directory, &keys),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_workspace_session_names(
    app: tauri::AppHandle,
) -> Result<WorkspaceSessionNames, Error> {
    run_in_app_root(app, AppOwnedDefaultRoot::WorkspaceSession, list_names_in).await
}

#[tauri::command]
#[specta::specta]
pub async fn remove_workspace_session_leaf(
    app: tauri::AppHandle,
    key: String,
) -> Result<(), Error> {
    run_in_app_root(
        app,
        AppOwnedDefaultRoot::WorkspaceSession,
        move |directory| remove_in(directory, &key),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn quarantine_workspace_session_leaves(
    app: tauri::AppHandle,
    keys: Option<Vec<String>>,
) -> Result<WorkspaceSessionQuarantineResult, Error> {
    run_in_app_root(
        app,
        AppOwnedDefaultRoot::WorkspaceSession,
        move |directory| quarantine_in(directory, keys.as_deref()),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn clear_workspace_session(app: tauri::AppHandle) -> Result<Vec<String>, Error> {
    run_in_app_root(app, AppOwnedDefaultRoot::WorkspaceSession, clear_in).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::path_authority::{ensure_app_owned_default_dir, AppDataDir};

    const ID_A: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const ID_B: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const ID_C: &str = "11111111-1111-4111-8111-111111111111";

    fn directory() -> (tempfile::TempDir, AuthorizedDir) {
        let temp = tempfile::tempdir().unwrap();
        let app_data = AppDataDir::for_test(temp.path());
        let directory =
            ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::WorkspaceSession).unwrap();
        (temp, directory)
    }

    fn store_path(temp: &tempfile::TempDir) -> std::path::PathBuf {
        temp.path().join("workspace-session")
    }

    #[test]
    fn workspace_session_validates_names_and_rejects_case_variants_and_foreign_names() {
        let (temp, directory) = directory();
        for invalid in [
            "pageTabs",
            "WORKSPACE",
            "Page-Tabs",
            &ID_A.to_uppercase(),
            "../workspace",
            "not-a-uuid",
            "",
            "quarantine-0f8fad5b-d9cb-469f-a165-70867728950e",
        ] {
            assert!(matches!(
                write_in(&directory, invalid, "{}"),
                Err(Error::InvalidInput(_))
            ));
            assert!(matches!(
                remove_in(&directory, invalid),
                Err(Error::InvalidInput(_))
            ));
        }
        assert!(matches!(
            read_keys_in(&directory, &[WORKSPACE_LEAF_KEY.to_string()]),
            Err(Error::InvalidInput(_))
        ));
        assert!(matches!(
            read_keys_in(&directory, &[ID_A.to_uppercase()]),
            Err(Error::InvalidInput(_))
        ));
        let oversized = "x".repeat(WORKSPACE_SESSION_MAX_BYTES + 1);
        assert!(matches!(
            write_in(&directory, WORKSPACE_LEAF_KEY, &oversized),
            Err(Error::ResourceLimit(_))
        ));
        assert_eq!(std::fs::read_dir(store_path(&temp)).unwrap().count(), 0);
    }

    #[test]
    fn workspace_session_fixed_and_keyed_reads_distinguish_record_absent_and_skipped() {
        let (temp, directory) = directory();
        let store = store_path(&temp);
        let empty = read_fixed_in(&directory).unwrap();
        assert_eq!(empty.workspace, WorkspaceSessionLeafState::Absent);
        assert_eq!(empty.page_tabs, WorkspaceSessionLeafState::Absent);

        write_in(&directory, WORKSPACE_LEAF_KEY, "{\"v\":1}").unwrap();
        std::fs::write(store.join("page-tabs.json"), [0xff_u8, 0xfe]).unwrap();
        write_in(&directory, ID_A, "tree-a").unwrap();
        std::fs::create_dir(store.join(format!("{ID_B}.json"))).unwrap();
        let oversized = std::fs::File::create(store.join(format!("{ID_C}.json"))).unwrap();
        oversized
            .set_len(WORKSPACE_SESSION_MAX_BYTES as u64 + 1)
            .unwrap();
        drop(oversized);
        std::fs::write(store.join("notes.txt"), "foreign").unwrap();

        let fixed = read_fixed_in(&directory).unwrap();
        assert_eq!(
            fixed.workspace,
            WorkspaceSessionLeafState::Record {
                content: "{\"v\":1}".into()
            }
        );
        assert_eq!(
            fixed.page_tabs,
            WorkspaceSessionLeafState::Skipped {
                reason: "not UTF-8".into()
            }
        );

        let missing_id = "22222222-2222-4222-8222-222222222222";
        let read = read_keys_in(
            &directory,
            &[ID_A.into(), missing_id.into(), ID_B.into(), ID_C.into()],
        )
        .unwrap();
        assert_eq!(
            read,
            vec![
                WorkspaceSessionReadEntry {
                    key: ID_A.into(),
                    state: WorkspaceSessionLeafState::Record {
                        content: "tree-a".into()
                    },
                },
                WorkspaceSessionReadEntry {
                    key: missing_id.into(),
                    state: WorkspaceSessionLeafState::Absent,
                },
                WorkspaceSessionReadEntry {
                    key: ID_B.into(),
                    state: WorkspaceSessionLeafState::Skipped {
                        reason: "not a regular file".into()
                    },
                },
                WorkspaceSessionReadEntry {
                    key: ID_C.into(),
                    state: WorkspaceSessionLeafState::Skipped {
                        reason: "oversized".into()
                    },
                },
            ]
        );
        // Reads never delete skipped or foreign leaves.
        assert!(store.join("page-tabs.json").exists());
        assert!(store.join(format!("{ID_B}.json")).exists());
        assert!(store.join(format!("{ID_C}.json")).exists());
        assert!(store.join("notes.txt").exists());
    }

    #[test]
    fn workspace_session_read_enforces_key_bound_and_names_counts_leftovers() {
        let (_temp, directory) = directory();
        let too_many: Vec<String> = (0..=WORKSPACE_SESSION_READ_MAX_KEYS)
            .map(|i| {
                uuid::Uuid::from_u128(i as u128 + 1)
                    .hyphenated()
                    .to_string()
            })
            .collect();
        assert!(matches!(
            read_keys_in(&directory, &too_many),
            Err(Error::ResourceLimit(_))
        ));

        write_in(&directory, WORKSPACE_LEAF_KEY, "{}").unwrap();
        write_in(&directory, PAGE_TABS_LEAF_KEY, "[]").unwrap();
        for i in 0..(WORKSPACE_SESSION_NAMES_MAX + 4) {
            let id = uuid::Uuid::from_u128(i as u128 + 1)
                .hyphenated()
                .to_string();
            write_in(&directory, &id, "{}").unwrap();
        }
        let listing = list_names_in(&directory).unwrap();
        assert_eq!(listing.names.len(), WORKSPACE_SESSION_NAMES_MAX);
        assert_eq!(listing.omitted, 4);
        assert!(!listing.names.contains(&WORKSPACE_LEAF_KEY.to_string()));
        assert!(!listing.names.contains(&PAGE_TABS_LEAF_KEY.to_string()));
    }

    #[test]
    fn workspace_session_quarantine_moves_selected_or_all_and_reports_partial_failure() {
        let (temp, directory) = directory();
        let store = store_path(&temp);
        write_in(&directory, WORKSPACE_LEAF_KEY, "{\"v\":1}").unwrap();
        write_in(&directory, ID_A, "a").unwrap();
        write_in(&directory, ID_B, "b").unwrap();
        std::fs::write(store.join("notes.txt"), "foreign").unwrap();

        // Quarantining a single key leaves the rest in place.
        let one = quarantine_in(&directory, Some(&[ID_A.to_string()])).unwrap();
        let bucket_one = one.bucket.expect("bucket created");
        assert!(bucket_one.starts_with(QUARANTINE_PREFIX));
        assert_eq!(one.moved, vec![ID_A.to_string()]);
        assert!(one.failed.is_empty());
        assert!(!store.join(format!("{ID_A}.json")).exists());
        assert_eq!(
            std::fs::read_to_string(store.join(&bucket_one).join(format!("{ID_A}.json"))).unwrap(),
            "a"
        );
        assert!(store.join(format!("{ID_B}.json")).exists());

        // Pre-populate a collision in a bucket to force partial quarantine failure (rename refuses
        // an existing target on all platforms) while still moving the non-colliding leaf.
        let bucket_two = format!("{QUARANTINE_PREFIX}{ID_C}");
        std::fs::create_dir(store.join(&bucket_two)).unwrap();
        std::fs::write(
            store.join(&bucket_two).join(format!("{ID_B}.json")),
            "blocker",
        )
        .unwrap();
        let partial = quarantine_into_bucket_in(&directory, &bucket_two, None).unwrap();
        assert_eq!(partial.bucket.as_deref(), Some(bucket_two.as_str()));
        assert!(partial.moved.contains(&WORKSPACE_LEAF_KEY.to_string()));
        assert_eq!(partial.failed.len(), 1);
        assert_eq!(partial.failed[0].key, ID_B);
        assert!(store.join(format!("{ID_B}.json")).exists());
        assert!(store.join("notes.txt").exists());
    }

    #[test]
    fn workspace_session_clear_removes_leaves_and_quarantine_buckets_but_keeps_foreign() {
        let (temp, directory) = directory();
        let store = store_path(&temp);
        write_in(&directory, WORKSPACE_LEAF_KEY, "{}").unwrap();
        write_in(&directory, PAGE_TABS_LEAF_KEY, "[]").unwrap();
        write_in(&directory, ID_A, "a").unwrap();
        let quarantined = quarantine_in(&directory, Some(&[ID_A.to_string()])).unwrap();
        let bucket = quarantined.bucket.expect("bucket");
        write_in(&directory, ID_B, "b").unwrap();
        std::fs::write(store.join("notes.txt"), "foreign").unwrap();
        std::fs::create_dir(store.join("foreign-dir")).unwrap();

        assert!(clear_in(&directory).unwrap().is_empty());
        assert!(!store.join("workspace.json").exists());
        assert!(!store.join("page-tabs.json").exists());
        assert!(!store.join(format!("{ID_B}.json")).exists());
        assert!(!store.join(&bucket).exists());
        assert!(store.join("notes.txt").exists());
        assert!(store.join("foreign-dir").exists());
    }

    #[test]
    fn workspace_session_remove_is_idempotent_on_missing_key() {
        let (_temp, directory) = directory();
        write_in(&directory, ID_A, "a").unwrap();
        remove_in(&directory, ID_A).unwrap();
        remove_in(&directory, ID_A).unwrap();
        assert!(list_names_in(&directory).unwrap().names.is_empty());
    }
}
