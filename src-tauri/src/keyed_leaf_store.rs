//! Shared primitives for app-owned keyed-leaf stores (`unsaved-games` and `workspace-session`).
//!
//! Each store keeps one UTF-8 file per validated key inside an [`AuthorizedDir`]. All I/O stays
//! relative to the retained directory descriptor, enforces a per-leaf byte bound, and uses durable
//! atomic replacement on write.

use crate::{
    error::{DurabilityStage, Error},
    infra::{
        blocking::BLOCKING_GATEWAY,
        fs::{DirectoryEntry, DirectoryEntryKind},
        path_authority::{AppDataDir, AppOwnedDefaultRoot, AuthorizedDir},
    },
};
use std::{ffi::OsStr, io::Write, path::Path};

/// Largest leaf payload accepted on write and returned on read (32 MiB).
pub(crate) const MAX_LEAF_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const LEAF_SUFFIX: &str = ".json";

/// The canonical lowercase hyphenated UUID, or `None` for any other spelling.
pub(crate) fn canonical_uuid(id: &str) -> Option<String> {
    let parsed = uuid::Uuid::parse_str(id).ok()?;
    let canonical = parsed.hyphenated().to_string();
    (canonical == id).then_some(canonical)
}

/// The canonical lowercase UUID a `<uuid>.json` leaf stands for, or `None` for any other name.
pub(crate) fn uuid_leaf_key(name: &OsStr) -> Option<String> {
    let name = name.to_str()?;
    canonical_uuid(name.strip_suffix(LEAF_SUFFIX)?)
}

/// Runs a blocking store operation against an app-owned default root off the Tokio worker pool.
pub(crate) async fn run_in_app_root<T, F>(
    app: tauri::AppHandle,
    root: AppOwnedDefaultRoot,
    operation: F,
) -> Result<T, Error>
where
    T: Send + 'static,
    F: FnOnce(&AuthorizedDir) -> Result<T, Error> + Send + 'static,
{
    BLOCKING_GATEWAY
        .spawn(move || {
            let directory = crate::infra::path_authority::ensure_app_owned_default_dir(
                &AppDataDir::for_app(&app)?,
                root,
            )?;
            operation(&directory)
        })
        .await
}

pub(crate) fn io_error(label: &str, operation: &str, id: &str, error: std::io::Error) -> Error {
    log::warn!("{label} {operation} failed for {id}: {error}");
    Error::Io(Box::new(crate::error::sanitized_io_error(
        &error,
        format!("{label} {operation} failed"),
    )))
}

pub(crate) fn operation_error(label: &str, operation: &str, id: &str, error: Error) -> Error {
    match error {
        Error::Io(source) => io_error(label, operation, id, *source),
        other => other,
    }
}

/// Per-store configuration shared across write and read primitives.
pub(crate) struct LeafStoreConfig {
    pub(crate) label: &'static str,
    pub(crate) max_bytes: usize,
    pub(crate) size_limit_message: &'static str,
    pub(crate) durability_stage: DurabilityStage,
}

pub(crate) fn write_leaf(
    directory: &AuthorizedDir,
    config: &LeafStoreConfig,
    id: &str,
    leaf: &OsStr,
    content: &str,
) -> Result<(), Error> {
    if content.len() > config.max_bytes {
        return Err(Error::ResourceLimit(config.size_limit_message.into()));
    }
    let (outcome, _) = directory
        .atomic_replace_leaf_identified(leaf, |file| {
            file.write_all(content.as_bytes())
                .map_err(|error| io_error(config.label, "write", id, error))
        })
        .map_err(|error| operation_error(config.label, "write", id, error))?;
    crate::infra::fs::require_durable(outcome, config.durability_stage)
}

pub(crate) enum LeafReadOutcome {
    Content(String),
    Absent,
    Skipped(&'static str),
}

pub(crate) fn read_leaf_file(
    directory: &AuthorizedDir,
    config: &LeafStoreConfig,
    id: &str,
    leaf: &OsStr,
) -> Result<LeafReadOutcome, Error> {
    let mut file = match directory.open_regular_relative(Path::new(leaf)) {
        Ok(file) => file,
        Err(error) if error.is_missing_entry() => return Ok(LeafReadOutcome::Absent),
        Err(Error::InvalidInput(_)) => return Ok(LeafReadOutcome::Skipped("not a regular file")),
        Err(error) => return Err(operation_error(config.label, "read", id, error)),
    };
    let declared = file
        .metadata()
        .map_err(|error| io_error(config.label, "read", id, error))?
        .len();
    if declared > config.max_bytes as u64 {
        return Ok(LeafReadOutcome::Skipped("oversized"));
    }
    let bytes = match crate::infra::fs::read_bounded_bytes(
        &mut file,
        declared,
        config.max_bytes,
        config.size_limit_message,
        || Ok(()),
    ) {
        Ok(bytes) => bytes,
        Err(Error::ResourceLimit(_)) => return Ok(LeafReadOutcome::Skipped("oversized")),
        Err(error) => return Err(operation_error(config.label, "read", id, error)),
    };
    Ok(match String::from_utf8(bytes) {
        Ok(content) => LeafReadOutcome::Content(content),
        Err(_) => LeafReadOutcome::Skipped("not UTF-8"),
    })
}

/// Reads an already-enumerated leaf entry, distinguishing non-regular entries, absent, skipped, and
/// regular UTF-8 payloads.
pub(crate) fn read_entry_leaf(
    directory: &AuthorizedDir,
    config: &LeafStoreConfig,
    id: &str,
    entry: &DirectoryEntry,
) -> Result<LeafReadOutcome, Error> {
    if entry.kind != DirectoryEntryKind::RegularFile {
        return Ok(LeafReadOutcome::Skipped("not a regular file"));
    }
    read_leaf_file(directory, config, id, &entry.name)
}

/// Lists every entry `parse_id` accepts, sorted deterministically by parsed id.
pub(crate) fn owned_entries<F>(
    directory: &AuthorizedDir,
    mut parse_id: F,
) -> Result<Vec<(String, DirectoryEntry)>, Error>
where
    F: FnMut(&OsStr) -> Option<String>,
{
    let mut entries: Vec<_> = directory
        .entries(&mut |name| parse_id(name).is_some())?
        .into_iter()
        .filter_map(|entry| parse_id(&entry.name).map(|id| (id, entry)))
        .collect();
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(entries)
}

pub(crate) fn remove_owned_leaf<F>(
    directory: &AuthorizedDir,
    label: &str,
    id: &str,
    leaf: &OsStr,
    parse_id: F,
) -> Result<(), Error>
where
    F: FnMut(&OsStr) -> Option<String>,
{
    let Some((_, entry)) = owned_entries(directory, parse_id)?
        .into_iter()
        .find(|(entry_id, _)| entry_id == id)
    else {
        return Ok(());
    };
    match directory.remove_leaf_identified_pair(leaf, entry.identity) {
        Ok(()) => Ok(()),
        Err(error) if error.is_missing_entry() => Ok(()),
        Err(error) => Err(operation_error(label, "remove", id, error)),
    }
}

pub(crate) fn clear_owned_leaves<F>(
    directory: &AuthorizedDir,
    label: &str,
    parse_id: F,
) -> Result<Vec<String>, Error>
where
    F: FnMut(&OsStr) -> Option<String>,
{
    let mut leftover = Vec::new();
    for (id, entry) in owned_entries(directory, parse_id)? {
        let removed = if entry.kind == DirectoryEntryKind::Directory {
            directory.remove_dir_identified_pair(&entry.name, entry.identity)
        } else {
            directory.remove_leaf_identified_pair(&entry.name, entry.identity)
        };
        match removed {
            Ok(()) => {}
            Err(error) if error.is_missing_entry() => {}
            Err(error) => {
                log::warn!("{label} clear could not remove {id}: {error}");
                leftover.push(id);
            }
        }
    }
    Ok(leftover)
}
