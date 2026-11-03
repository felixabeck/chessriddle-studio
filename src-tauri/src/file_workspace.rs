//! Native PGN collection management.
//!
//! This is deliberately the only layer that knows collection filenames. The renderer receives
//! opaque [`FileWorkspaceHandle`] values plus safe display metadata; it never receives an OS
//! path or sends one back for a PGN operation.

use crate::{
    error::{CommittedRemoval, Error, ErrorCategory},
    infra::blocking::BLOCKING_GATEWAY,
    infra::cancellable_lock::lock_std_cancellable,
    infra::path_authority::{
        workspace_sidecar_leaf as sidecar_leaf, CommitDurability, FileWorkspaceDescriptor,
        FileWorkspaceHandle, IdentityBinding, PathAuthority, PathClass, PathOperation, PathRef,
        SharedPathAuthority, WorkspaceMutationTarget, WorkspaceRemovalStatus,
        PICKER_DIALOG_GRANT_TTL,
    },
    pgn, AppState,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

use crate::infra::fs::DirectoryEntryKind;
use crate::infra::fs::{
    check_directory_listing_bound, DirectoryEntry, RegularFileAccess, MAX_DIRECTORY_LISTING_ENTRIES,
};
use crate::infra::path_authority::{CapabilityDirectory, PreparedEntry};
use std::ffi::OsStr;

const TRASH_DIRECTORY: &str = ".en-croissant-trash";

pub(crate) fn is_trash_locator(locator: &[std::ffi::OsString]) -> bool {
    locator
        .first()
        .is_some_and(|part| part == OsStr::new(TRASH_DIRECTORY))
}

pub(crate) fn workspace_locator_exists(
    authority: &SharedPathAuthority,
    workspace: &FileWorkspaceHandle,
    locator: &[std::ffi::OsString],
) -> Result<bool, Error> {
    let root = mutation_target(authority, workspace)?;
    let Some((leaf, parents)) = locator.split_last() else {
        return Err(Error::StaleGame);
    };
    let result = (|| {
        let mut directory = root.directory()?.try_clone()?;
        for parent in parents {
            crate::infra::fs::single_leaf(parent)?;
            directory = crate::infra::fs::open_directory_at(&directory, parent, true)?;
        }
        crate::infra::fs::single_leaf(leaf)?;
        crate::infra::fs::entry_identity_at(&directory, leaf, false)?;
        Ok::<_, Error>(())
    })();
    match result {
        Ok(()) => Ok(true),
        Err(error) if error.is_missing_entry() => Ok(false),
        Err(error) => Err(error),
    }
}
const MAX_WORKSPACE_METADATA_BYTES: usize = 1024 * 1024;
const METADATA_LIMIT_MESSAGE: &str = "PGN metadata exceeds the supported size limit";

#[cfg(test)]
std::thread_local! {
    static ROOT_FAILURE_POST_WALK_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceEntryKind {
    File,
    Directory,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceFileType {
    Repertoire,
    Game,
    Tournament,
    Puzzle,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMetadata {
    #[serde(rename = "type")]
    pub file_type: WorkspaceFileType,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorkspaceFileContent {
    Text {
        pgn: String,
    },
    Copy {
        source: FileWorkspaceHandle,
        revision: String,
    },
}

impl Default for WorkspaceMetadata {
    fn default() -> Self {
        Self {
            file_type: WorkspaceFileType::Other,
            tags: vec![],
        }
    }
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub handle: FileWorkspaceHandle,
    pub kind: WorkspaceEntryKind,
    pub name: String,
    pub children: Vec<WorkspaceEntry>,
    pub metadata: Option<WorkspaceMetadata>,
    pub read_error: Option<ErrorCategory>,
    pub game_count: Option<i32>,
    pub last_modified: i64,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUnread {
    pub name: String,
    pub kind: Option<WorkspaceEntryKind>,
    pub category: ErrorCategory,
    pub parent: Option<FileWorkspaceHandle>,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceListing {
    pub entries: Vec<WorkspaceEntry>,
    pub unread: Vec<WorkspaceUnread>,
}

fn validate_name(name: &str) -> Result<&str, Error> {
    let name = name.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name == TRASH_DIRECTORY
        || name.contains(['/', '\\', '\0'])
        || name.ends_with(".info")
    {
        return Err(Error::InvalidInput("invalid workspace basename".into()));
    }
    // On NTFS a colon opens an alternate data stream on ANOTHER file: `existing.pgn:secret`
    // reaches the filesystem as a stream of `existing.pgn`, and `pgn_name` only appends `.pgn`
    // to it. The check is Windows-only because a colon is a legal filename byte on unix and
    // rejecting it unconditionally would change the Linux invoke contract; the same precedent
    // governs `validate_components`' `#[cfg(unix)]` separator-and-NUL check.
    #[cfg(windows)]
    if name.contains(':') {
        return Err(Error::InvalidInput("invalid workspace basename".into()));
    }
    Ok(name)
}

pub(crate) fn pgn_name(name: &str) -> Result<String, Error> {
    let name = validate_name(name)?;
    Ok(if name.to_ascii_lowercase().ends_with(".pgn") {
        name.to_string()
    } else {
        format!("{name}.pgn")
    })
}

#[cfg(all(test, unix))]
fn info_path(pgn: &Path) -> Result<PathBuf, Error> {
    let leaf = pgn
        .file_name()
        .ok_or_else(|| Error::InvalidInput("PGN has no filename".into()))?;
    Ok(pgn.with_file_name(sidecar_leaf(leaf)?))
}

fn serialize_metadata(metadata: &WorkspaceMetadata) -> Result<Vec<u8>, Error> {
    let bytes =
        serde_json::to_vec(metadata).map_err(|error| Error::InvalidInput(error.to_string()))?;
    if bytes.len() > MAX_WORKSPACE_METADATA_BYTES {
        return Err(Error::ResourceLimit(METADATA_LIMIT_MESSAGE.into()));
    }
    Ok(bytes)
}

pub(crate) fn metadata_from(
    directory: &CapabilityDirectory,
    pgn: &DirectoryEntry,
) -> Result<WorkspaceMetadata, Error> {
    let mut sidecar = directory.open_metadata_sidecar(pgn)?;
    let Some(sidecar) = sidecar.as_mut() else {
        return Ok(WorkspaceMetadata::default());
    };
    read_metadata(sidecar)
}

fn read_metadata(
    sidecar: &mut crate::infra::inode_ownership::OwnedFile,
) -> Result<WorkspaceMetadata, Error> {
    let declared = sidecar.metadata()?.len();
    let bytes = crate::infra::fs::read_bounded_bytes(
        sidecar,
        declared,
        MAX_WORKSPACE_METADATA_BYTES,
        METADATA_LIMIT_MESSAGE,
        || Ok(()),
    )?;
    serde_json::from_slice(&bytes).map_err(|error| {
        log::warn!("invalid PGN metadata: {error}");
        Error::InvalidInput("invalid PGN metadata".into())
    })
}

/// Complete an interrupted publication without replacing any existing sidecar.
/// The caller must establish its durable creation owner before invoking this primitive.
pub(crate) fn create_missing_workspace_file_metadata(
    authority: &SharedPathAuthority,
    workspace: &FileWorkspaceHandle,
    entry: &FileWorkspaceHandle,
    metadata: WorkspaceMetadata,
    cancellation: &CancellationToken,
) -> Result<WorkspaceMetadata, Error> {
    let root = mutation_target(authority, workspace)?;
    let source = mutation_target(authority, entry)?;
    ensure_registered_descendant(&root, &source)?;
    if source.is_dir {
        return Err(Error::InvalidInput("workspace entry must be a file".into()));
    }
    let confirm = || {
        crate::infra::fs::assert_entry_identity(
            &source.parent,
            &source.leaf,
            source.identity,
            false,
        )?;
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        Ok(())
    };
    confirm()?;
    let info_leaf = sidecar_leaf(&source.leaf)?;
    match crate::infra::fs::open_regular_at(&source.parent, &info_leaf, RegularFileAccess::ReadOnly)
    {
        Ok(mut sidecar) => {
            let metadata = read_metadata(&mut sidecar)?;
            confirm()?;
            return Ok(metadata);
        }
        Err(error) if error.is_missing_entry() => {}
        Err(error) => return Err(error),
    }
    let bytes = serialize_metadata(&metadata)?;
    let installed = crate::infra::fs::atomic_create_at_identified_with_precommit(
        &source.parent,
        &info_leaf,
        confirm,
        |file| {
            use std::io::Write;
            file.write_all(&bytes).map_err(Error::from)
        },
    )?;
    if let Some(stage) = durability_uncertainty(
        installed.outcome,
        crate::error::DurabilityStage::WorkspaceSidecarCreation,
    ) {
        return Err(Error::CommittedDurabilityUncertain(stage));
    }
    Ok(metadata)
}

/// The listed modification time, in Unix seconds, exactly as the enumerator reported it.
///
/// A pre-1970 timestamp is legitimately negative on both platforms: unix `st_mtime` is signed,
/// and the Windows `LastWriteTime` FILETIME converts below the epoch through
/// `filetime_to_unix_seconds`, which `windows_filetime_ticks_become_unix_seconds` asserts. The
/// renderer reads `WorkspaceEntry.lastModified` as a plain number of Unix seconds and renders a
/// negative one as the date it is, so rejecting it here failed the *whole* workspace listing over
/// one old file rather than listing it.
fn listed_mtime(entry: &DirectoryEntry) -> i64 {
    entry.modified_seconds
}

fn workspace_root(
    pgn_path_authority: &SharedPathAuthority,
    workspace: &FileWorkspaceHandle,
) -> Result<PathBuf, Error> {
    pgn_path_authority
        .with_mut(|authority| authority.workspace_root(workspace, PathOperation::ReadPgn))?
}

fn mutation_target(
    pgn_path_authority: &SharedPathAuthority,
    entry: &FileWorkspaceHandle,
) -> Result<WorkspaceMutationTarget, Error> {
    pgn_path_authority.with_mut(|authority| authority.workspace_mutation_target(entry))?
}

fn durability_uncertainty(
    outcome: crate::infra::fs::AtomicFileOutcome,
    stage: crate::error::DurabilityStage,
) -> Option<crate::error::DurabilityStage> {
    crate::infra::fs::map_atomic_file_outcome(outcome, stage, |error| {
        log::warn!("{stage} parent sync failed: {error}");
    })
}

fn replace_workspace_file_metadata(
    parent: &fs::File,
    pgn_leaf: &OsStr,
    pgn_identity: (u64, u64),
    metadata_bytes: &[u8],
    cancellation: &CancellationToken,
) -> Result<Option<crate::error::DurabilityStage>, Error> {
    let info_leaf = sidecar_leaf(pgn_leaf)?;
    let outcome = crate::infra::fs::atomic_replace_at_with_precommit(
        parent,
        &info_leaf,
        || {
            crate::infra::fs::assert_entry_identity(parent, pgn_leaf, pgn_identity, false)?;
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            Ok(())
        },
        |file| {
            use std::io::Write;
            file.write_all(metadata_bytes).map_err(Error::from)
        },
    )?;
    Ok(durability_uncertainty(
        outcome,
        crate::error::DurabilityStage::WorkspaceSidecarReplacement,
    ))
}

#[tauri::command]
#[specta::specta]
pub async fn write_workspace_file_metadata(
    workspace: FileWorkspaceHandle,
    entry: FileWorkspaceHandle,
    metadata: WorkspaceMetadata,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let operation = state.operations.accept("write_workspace_file_metadata")?;
    let cancellation = operation.token();
    let pgn_path_authority = state.pgn_path_authority.clone();
    let workspace_mutation = Arc::clone(&state.workspace_mutation);
    crate::infra::operations::run_native_operation(
        operation,
        "write_workspace_file_metadata",
        async move {
            BLOCKING_GATEWAY
                .spawn_cancellable(cancellation, move |token| {
                    write_workspace_file_metadata_blocking(
                        workspace.clone(),
                        entry,
                        metadata,
                        &pgn_path_authority,
                        &workspace_mutation,
                        token,
                    )?;
                    reconcile_workspace_collections(&pgn_path_authority, &workspace)
                })
                .await
        },
    )
    .await
}

fn reconcile_workspace_collections(
    authority: &SharedPathAuthority,
    workspace: &FileWorkspaceHandle,
) -> Result<(), Error> {
    let Some(collections) = authority.collections()? else {
        return Ok(());
    };
    let token = CancellationToken::new();
    let result = collections
        .discover(authority, workspace, &token)
        .map(|_| ());
    result.map_err(|error| {
        log::warn!(
            "collection reconciliation failed after workspace publication: {}",
            error.diagnostic()
        );
        Error::CommittedDurabilityUncertain(
            crate::error::DurabilityStage::WorkspaceSidecarReplacement,
        )
    })
}

/// A committed uncertainty must finish dependent work. Keep its stage unless a
/// later hard failure takes precedence, recording the other evidence natively.
fn finish_committed_workspace_step(
    result: Result<(), Error>,
    finish: impl FnOnce() -> Result<(), Error>,
) -> Result<(), Error> {
    let first = match result {
        Ok(()) => None,
        Err(Error::CommittedDurabilityUncertain(stage)) => Some(stage),
        Err(error) => return Err(error),
    };
    match (first, finish()) {
        (Some(stage), Ok(())) => Err(Error::CommittedDurabilityUncertain(stage)),
        (Some(stage), Err(Error::CommittedDurabilityUncertain(later))) => {
            log::warn!(
                "workspace completion also has uncertain durability at {later}, keeping {stage}"
            );
            Err(Error::CommittedDurabilityUncertain(stage))
        }
        (Some(stage), Err(error)) => {
            log::warn!(
                "workspace completion failed after uncertainty at {stage}: {}",
                error.diagnostic()
            );
            Err(error)
        }
        (None, result) => result,
    }
}

fn finish_workspace_rename(
    outcome: crate::infra::fs::AtomicFileOutcome,
    finish: impl FnOnce() -> Result<(), Error>,
) -> Result<(), Error> {
    finish_committed_workspace_step(
        crate::infra::fs::require_durable(outcome, crate::error::DurabilityStage::WorkspaceRename),
        finish,
    )
}

pub(crate) fn write_workspace_file_metadata_blocking(
    workspace: FileWorkspaceHandle,
    entry: FileWorkspaceHandle,
    metadata: WorkspaceMetadata,
    pgn_path_authority: &SharedPathAuthority,
    workspace_mutation: &Mutex<()>,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    let metadata_bytes = serialize_metadata(&metadata)?;
    let _guard = lock_std_cancellable(
        workspace_mutation,
        cancellation,
        "workspace mutation lock was poisoned",
    )?;
    let root = mutation_target(pgn_path_authority, &workspace)?;
    let source = mutation_target(pgn_path_authority, &entry)?;
    ensure_registered_descendant(&root, &source)?;
    if source.is_dir {
        return Err(Error::InvalidInput("workspace entry must be a file".into()));
    }
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    match replace_workspace_file_metadata(
        &source.parent,
        &source.leaf,
        source.identity,
        &metadata_bytes,
        cancellation,
    )? {
        Some(stage) => Err(Error::CommittedDurabilityUncertain(stage)),
        None => Ok(()),
    }
}

fn join_cleanup(left: Result<(), Error>, right: Result<(), Error>) -> Result<(), Error> {
    match (left, right) {
        (Ok(()), other) => other,
        (Err(first), Ok(())) => Err(first),
        (Err(first), Err(second)) => Err(Error::with_cleanup(first, Err(second))),
    }
}

/// Only objects this call created are removed, each checked against the identity it was created
/// with; a replaced leaf is left in place and reported as a failed cleanup; every removal is
/// attempted. `repository` is passed once a count was attempted, to invalidate any index the count
/// may have cached for this PGN identity; invalidating an absent entry is harmless.
fn rollback_created_workspace_file(
    parent: &fs::File,
    pgn_leaf: &OsStr,
    pgn_identity: (u64, u64),
    sidecar: Option<(&OsStr, (u64, u64))>,
    repository: Option<&pgn::PgnRepository>,
) -> Result<(), Error> {
    let sidecar_cleanup = match sidecar {
        Some((leaf, identity)) => crate::infra::fs::remove_entry_at(parent, leaf, identity, false),
        None => Ok(()),
    };
    let pgn_cleanup = crate::infra::fs::remove_entry_at(parent, pgn_leaf, pgn_identity, false);
    let cache_cleanup = match repository {
        Some(repository) => repository.invalidate(
            &crate::infra::path_authority::PgnSnapshotIdentity::from_pair(pgn_identity),
        ),
        None => Ok(()),
    };
    join_cleanup(join_cleanup(sidecar_cleanup, pgn_cleanup), cache_cleanup)
}

fn unidentified_directory_not_removed() -> Error {
    Error::Conflict("created directory could not be identified and was not removed".into())
}

pub(crate) fn count_installed_workspace_pgn(
    parent: &fs::File,
    leaf: &OsStr,
    identity: (u64, u64),
    repository: &pgn::PgnRepository,
    cancellation: &CancellationToken,
) -> Result<i32, Error> {
    let file = crate::infra::fs::open_regular_at(parent, leaf, RegularFileAccess::ReadOnly)?;
    let snapshot = crate::infra::path_authority::ResolvedPath::pgn_snapshot_from_identified_file(
        file, identity,
    )?;
    pgn::count_pgn_games_core_blocking(snapshot, cancellation, repository)
}

fn ensure_registered_descendant(
    root: &WorkspaceMutationTarget,
    entry: &WorkspaceMutationTarget,
) -> Result<(), Error> {
    entry
        .path()
        .strip_prefix(root.path())
        .map_err(|_| Error::InvalidInput("workspace entry escapes its root".into()))?;
    Ok(())
}

fn workspace_components(
    pgn_path_authority: &SharedPathAuthority,
    workspace: &FileWorkspaceHandle,
    path: &Path,
) -> Result<Vec<std::ffi::OsString>, Error> {
    let root = workspace_root(pgn_path_authority, workspace)?;
    let relative = path
        .strip_prefix(&root)
        .map_err(|_| Error::InvalidInput("workspace entry escapes its root".into()))?;
    Ok(relative
        .components()
        .map(|component| component.as_os_str().to_os_string())
        .collect())
}

fn register_created_entry(
    pgn_path_authority: &SharedPathAuthority,
    workspace: &FileWorkspaceHandle,
    path: &Path,
    display_name: String,
    identity: (u64, u64),
    parent_identity: (u64, u64),
    is_dir: bool,
) -> Result<FileWorkspaceHandle, Error> {
    let components = workspace_components(pgn_path_authority, workspace, path)?;
    #[cfg(test)]
    WORKSPACE_CREATED_CHILD_PRE_REGISTER_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
    pgn_path_authority.with_mut(|authority| {
        authority.register_workspace_child_observed_with_parent(
            workspace,
            &components,
            display_name,
            IdentityBinding::from_pairs(identity, parent_identity),
            is_dir,
            PathOperation::WritePgn,
        )
    })?
}

pub(crate) fn map_picker_join(error: tokio::task::JoinError) -> Error {
    if error.is_cancelled() {
        Error::Cancellation
    } else {
        Error::InvalidInput("native picker task failed".into())
    }
}

#[cfg(all(test, unix))]
type WorkspaceListingConfirmHook = Box<dyn FnMut(&DirectoryEntry)>;

#[cfg(test)]
std::thread_local! {
    static WORKSPACE_LISTING_PRE_REGISTER_HOOK: std::cell::RefCell<Option<Box<dyn FnMut()>>> =
        const { std::cell::RefCell::new(None) };
    static WORKSPACE_CREATED_CHILD_PRE_REGISTER_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static WORKSPACE_REBIND_PRE_REGISTER_HOOK: std::cell::RefCell<Option<WorkspaceRebindHook>> =
        const { std::cell::RefCell::new(None) };
    static WORKSPACE_CREATED_DIRECTORY_PRE_OBSERVE_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static WORKSPACE_CREATED_FILE_POST_WRITE_HOOK: std::cell::RefCell<Option<WorkspaceFileWriteHook>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
type WorkspaceFileWriteHook =
    Box<dyn FnOnce(&crate::infra::inode_ownership::OwnedFile) -> Result<(), Error>>;

#[cfg(test)]
type WorkspaceRebindHook = Box<dyn FnOnce() -> Result<(), Error>>;

#[cfg(all(test, unix))]
std::thread_local! {
    static WORKSPACE_LISTING_PRE_CONFIRM_HOOK: std::cell::RefCell<Option<WorkspaceListingConfirmHook>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_workspace_listing_pre_register_hook(hook: Option<Box<dyn FnMut()>>) {
    WORKSPACE_LISTING_PRE_REGISTER_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(test)]
fn set_workspace_created_child_pre_register_hook(hook: Option<Box<dyn FnOnce()>>) {
    WORKSPACE_CREATED_CHILD_PRE_REGISTER_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(all(test, unix))]
fn set_workspace_rebind_pre_register_hook(hook: Option<Box<dyn FnOnce()>>) {
    WORKSPACE_REBIND_PRE_REGISTER_HOOK.with(|slot| {
        *slot.borrow_mut() = hook.map(|hook| {
            Box::new(move || {
                hook();
                Ok(())
            }) as WorkspaceRebindHook
        });
    });
}

#[cfg(all(test, unix))]
pub(crate) fn set_workspace_listing_pre_confirm_hook(hook: Option<WorkspaceListingConfirmHook>) {
    WORKSPACE_LISTING_PRE_CONFIRM_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

const MAX_WORKSPACE_LISTING_DEPTH: usize = 64;

// A pre-existing synchronous helper is the blocking body and gets no pass-through
// wrapper, so the command holds the spawn. Same keep-name rule as puzzle.rs:
// `collect_tree_entries`, `create_workspace_directory_inner`, `trash_entry`,
// `restore_entry`.
pub(crate) fn collect_tree_entries(
    pgn_path_authority: &SharedPathAuthority,
    workspace: &FileWorkspaceHandle,
    token: &CancellationToken,
) -> Result<(WorkspaceListing, Vec<FileWorkspaceHandle>), Error> {
    struct Staged {
        components: Vec<std::ffi::OsString>,
        name: String,
        identity: Option<(u64, u64)>,
        parent_identity: (u64, u64),
        last_modified: i64,
        body: StagedBody,
    }

    enum StagedBody {
        Directory(Vec<Staged>),
        File(WorkspaceMetadata, Option<ErrorCategory>),
        Unread(Option<WorkspaceEntryKind>, ErrorCategory),
    }

    fn confirm_staged(dir: &CapabilityDirectory, entry: &DirectoryEntry) -> Result<(), Error> {
        #[cfg(all(test, unix))]
        WORKSPACE_LISTING_PRE_CONFIRM_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().as_mut() {
                hook(entry);
            }
        });
        dir.confirm_entry(entry)
    }

    fn walk(
        dir: &CapabilityDirectory,
        components: Vec<std::ffi::OsString>,
        depth: usize,
        token: &CancellationToken,
        staged_count: &mut usize,
    ) -> Result<Vec<Staged>, Error> {
        if depth > MAX_WORKSPACE_LISTING_DEPTH {
            return Err(Error::ResourceLimit(format!(
                "workspace listing exceeded {MAX_WORKSPACE_LISTING_DEPTH} levels"
            ))
            .with_root_failure(crate::error::RootFailure::TooLarge));
        }
        if token.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let parent_identity = dir.identity()?;
        let listing =
            dir.listing_entries(token, &mut |name| name != OsStr::new(TRASH_DIRECTORY))?;
        if token.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let mut entries: Vec<_> = listing
            .entries
            .into_iter()
            .map(|entry| (entry.name.clone(), Ok(entry)))
            .chain(
                listing
                    .unread
                    .into_iter()
                    .map(|(name, kind, error)| (name, Err((kind, error)))),
            )
            .collect();
        entries
            .sort_by(|(left, _), (right, _)| left.as_encoded_bytes().cmp(right.as_encoded_bytes()));
        let mut staged = Vec::new();
        for (leaf, observation) in entries {
            if token.is_cancelled() {
                return Err(Error::Cancellation);
            }
            let display = leaf.to_string_lossy().into_owned();
            let mut child_components = components.clone();
            child_components.push(leaf);
            let entry = match observation {
                Ok(entry) => entry,
                Err((kind, error)) => {
                    if let Some(category) =
                        crate::infra::path_authority::listing_child_outcome(error)?
                    {
                        let kind = match kind {
                            Some(DirectoryEntryKind::Directory) => {
                                Some(WorkspaceEntryKind::Directory)
                            }
                            Some(DirectoryEntryKind::RegularFile) => {
                                if !display.to_ascii_lowercase().ends_with(".pgn") {
                                    continue;
                                }
                                Some(WorkspaceEntryKind::File)
                            }
                            Some(DirectoryEntryKind::Other) => continue,
                            None => None,
                        };
                        check_directory_listing_bound(
                            *staged_count,
                            MAX_DIRECTORY_LISTING_ENTRIES,
                        )?;
                        *staged_count += 1;
                        staged.push(Staged {
                            components: child_components,
                            name: display.clone(),
                            identity: None,
                            parent_identity,
                            last_modified: 0,
                            body: StagedBody::Unread(kind, category),
                        });
                    }
                    continue;
                }
            };
            let is_directory = match entry.kind {
                DirectoryEntryKind::Directory => true,
                DirectoryEntryKind::RegularFile => false,
                DirectoryEntryKind::Other => continue,
            };
            if !is_directory && !display.to_ascii_lowercase().ends_with(".pgn") {
                continue;
            }
            if is_directory && depth + 1 > MAX_WORKSPACE_LISTING_DEPTH {
                return Err(Error::ResourceLimit(format!(
                    "workspace listing exceeded {MAX_WORKSPACE_LISTING_DEPTH} levels"
                ))
                .with_root_failure(crate::error::RootFailure::TooLarge));
            }
            check_directory_listing_bound(*staged_count, MAX_DIRECTORY_LISTING_ENTRIES)?;
            *staged_count += 1;
            let body = (|| {
                if is_directory {
                    let child = dir.open_child_directory(&entry)?;
                    let children = walk(
                        &child,
                        child_components.clone(),
                        depth + 1,
                        token,
                        staged_count,
                    )?;
                    if token.is_cancelled() {
                        return Err(Error::Cancellation);
                    }
                    confirm_staged(dir, &entry)?;
                    Ok(StagedBody::Directory(children))
                } else {
                    // A sidecar failure cannot hide a replacement of the PGN itself.
                    let metadata = metadata_from(dir, &entry);
                    if token.is_cancelled() {
                        return Err(Error::Cancellation);
                    }
                    confirm_staged(dir, &entry)?;
                    match metadata {
                        Ok(metadata) => Ok(StagedBody::File(metadata, None)),
                        Err(error)
                            if error.root_failure().is_none()
                                && (error.category() == ErrorCategory::Permission
                                    || matches!(error.unlabelled(), Error::InvalidInput(message) if message == "invalid PGN metadata")
                                    || matches!(error.unlabelled(), Error::ResourceLimit(message) if message == METADATA_LIMIT_MESSAGE)) =>
                        {
                            Ok(StagedBody::File(
                                WorkspaceMetadata::default(),
                                Some(error.category()),
                            ))
                        }
                        Err(error) => Err(error),
                    }
                }
            })();
            let body = match body {
                Ok(body) => body,
                Err(error) => match crate::infra::path_authority::listing_child_outcome(error)? {
                    None => continue,
                    Some(category) => StagedBody::Unread(
                        Some(if is_directory {
                            WorkspaceEntryKind::Directory
                        } else {
                            WorkspaceEntryKind::File
                        }),
                        category,
                    ),
                },
            };
            let name = if matches!(body, StagedBody::File(..)) {
                display.trim_end_matches(".pgn").to_string()
            } else {
                display
            };
            staged.push(Staged {
                components: child_components,
                name,
                identity: Some(entry.identity),
                parent_identity,
                last_modified: listed_mtime(&entry),
                body,
            });
        }
        Ok(staged)
    }

    struct Preparation {
        missing: Vec<FileWorkspaceHandle>,
        prepared: Vec<PreparedEntry>,
        unread: Vec<WorkspaceUnread>,
        retained_paths: Vec<(Vec<std::ffi::OsString>, bool)>,
    }

    impl Preparation {
        fn unread(
            &mut self,
            entry: &Staged,
            kind: Option<WorkspaceEntryKind>,
            category: ErrorCategory,
            parent: Option<FileWorkspaceHandle>,
        ) {
            // Unknown enumerated types retain descendants without guessing or publishing a handle.
            let recursive = kind != Some(WorkspaceEntryKind::File);
            self.retained_paths
                .push((entry.components.clone(), recursive));
            self.unread.push(WorkspaceUnread {
                name: entry.name.clone(),
                kind,
                category,
                parent,
            });
        }
    }

    fn prepare_staged(
        staged: Vec<Staged>,
        path_authority: &mut PathAuthority,
        workspace: &FileWorkspaceHandle,
        token: &CancellationToken,
        parent: Option<FileWorkspaceHandle>,
        preparation: &mut Preparation,
    ) -> Result<Vec<WorkspaceEntry>, Error> {
        let mut result = Vec::new();
        for entry in staged {
            if token.is_cancelled() {
                return Err(Error::Cancellation);
            }
            if let StagedBody::Unread(kind, category) = &entry.body {
                preparation.unread(&entry, kind.clone(), *category, parent.clone());
                continue;
            }
            #[cfg(test)]
            WORKSPACE_LISTING_PRE_REGISTER_HOOK.with(|slot| {
                if let Some(hook) = slot.borrow_mut().as_mut() {
                    hook();
                }
            });
            let is_dir = matches!(entry.body, StagedBody::Directory(_));
            let identity = entry
                .identity
                .ok_or_else(|| Error::InvalidInput("listing observation is missing".into()))?;
            let registration = match path_authority.prepare_workspace_listing_child(
                workspace,
                &entry.components,
                entry.name.clone(),
                IdentityBinding::from_pairs(identity, entry.parent_identity),
                is_dir,
                PathOperation::ReadPgn,
            ) {
                Ok(registration) => registration,
                Err(error) => {
                    if let Some(category) =
                        crate::infra::path_authority::listing_child_outcome(error)?
                    {
                        preparation.unread(
                            &entry,
                            Some(if is_dir {
                                WorkspaceEntryKind::Directory
                            } else {
                                WorkspaceEntryKind::File
                            }),
                            category,
                            parent.clone(),
                        );
                    }
                    continue;
                }
            };
            let handle = FileWorkspaceHandle::new(registration.id());
            preparation.prepared.push(registration);
            if !is_dir {
                preparation.missing.push(handle.clone());
            }
            let (metadata, read_error, nested) = match entry.body {
                StagedBody::Directory(children) => (
                    None,
                    None,
                    prepare_staged(
                        children,
                        path_authority,
                        workspace,
                        token,
                        Some(handle.clone()),
                        preparation,
                    )?,
                ),
                StagedBody::File(metadata, error) => (Some(metadata), error, Vec::new()),
                StagedBody::Unread(..) => continue,
            };
            result.push(WorkspaceEntry {
                handle,
                kind: if is_dir {
                    WorkspaceEntryKind::Directory
                } else {
                    WorkspaceEntryKind::File
                },
                name: entry.name,
                children: nested,
                metadata,
                read_error,
                game_count: None,
                last_modified: entry.last_modified,
            });
        }
        Ok(result)
    }

    let (root, snapshot) = pgn_path_authority.with_mut(|path_authority| {
        let root =
            path_authority.capability_directory(workspace.path_ref(), PathOperation::ReadPgn)?;
        let snapshot =
            path_authority.workspace_listing_snapshot(workspace, OsStr::new(TRASH_DIRECTORY))?;
        Ok::<_, Error>((root, snapshot))
    })??;
    let staged = walk(&root, Vec::new(), 0, token, &mut 0)?;
    let mut preparation = Preparation {
        missing: Vec::new(),
        prepared: Vec::new(),
        unread: Vec::new(),
        retained_paths: Vec::new(),
    };
    pgn_path_authority.with_mut(|path_authority| {
        let entries = prepare_staged(
            staged,
            path_authority,
            workspace,
            token,
            None,
            &mut preparation,
        )?;
        let retained = snapshot.retained_ids(&preparation.retained_paths)?;
        path_authority.commit_directory_listing(
            snapshot,
            preparation.prepared,
            &retained,
            token,
        )?;
        Ok((
            WorkspaceListing {
                entries,
                unread: preparation.unread,
            },
            preparation.missing,
        ))
    })?
}

pub(crate) fn workspace_entry_mut<'a>(
    entries: &'a mut [WorkspaceEntry],
    handle: &FileWorkspaceHandle,
) -> Option<&'a mut WorkspaceEntry> {
    for entry in entries {
        if &entry.handle == handle {
            return Some(entry);
        }
        if let Some(found) = workspace_entry_mut(&mut entry.children, handle) {
            return Some(found);
        }
    }
    None
}

fn set_workspace_game_count(
    entries: &mut [WorkspaceEntry],
    handle: &FileWorkspaceHandle,
    game_count: i32,
) {
    if let Some(entry) = workspace_entry_mut(entries, handle) {
        entry.game_count = Some(game_count);
    }
}

fn set_workspace_read_error(
    entries: &mut [WorkspaceEntry],
    handle: &FileWorkspaceHandle,
    category: ErrorCategory,
) {
    if let Some(entry) = workspace_entry_mut(entries, handle) {
        entry.read_error = Some(category);
    }
}

fn listing_count_error(error: Error) -> Result<ErrorCategory, Error> {
    if error.root_failure().is_none()
        && (matches!(
            error.category(),
            ErrorCategory::Permission | ErrorCategory::Parsing
        ) || matches!(error.unlabelled(), Error::Io(io) if io.kind() == std::io::ErrorKind::InvalidData)
            || matches!(error.unlabelled(), Error::ResourceLimit(message) if message == pgn::COUNT_LIMIT_MESSAGE))
    {
        Ok(error.category())
    } else {
        Err(error)
    }
}

#[tauri::command]
#[specta::specta]
pub async fn issue_file_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<FileWorkspaceDescriptor, Error> {
    use tauri_plugin_dialog::DialogExt;
    let path = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| {
                Error::native_folder_selection("invalid native folder selection", error)
            })
    })
    .await
    .map_err(map_picker_join)??;
    let pgn_path_authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_file_workspace",
        move || issue_file_workspace_blocking(&pgn_path_authority, path),
    )
    .await
}

fn issue_file_workspace_blocking(
    pgn_path_authority: &SharedPathAuthority,
    path: PathBuf,
) -> Result<FileWorkspaceDescriptor, Error> {
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "PGN collection".into());
    pgn_path_authority.with_mut(|authority| {
        let temporary = authority.grant_dialog_operations(
            &path,
            display_name.clone(),
            PathClass::BoundedDialogGrant,
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            PICKER_DIALOG_GRANT_TTL,
            1,
        )?;
        let committed = authority.promote_dialog(
            &temporary,
            PathClass::PersistentCustomRoot,
            display_name.clone(),
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
        )?;
        Ok(FileWorkspaceDescriptor {
            handle: FileWorkspaceHandle::new(committed.id),
            display_name,
            availability: crate::infra::path_authority::PathAvailability::Available,
        })
    })?
}

pub(crate) async fn list_file_workspace_core(
    workspace: &FileWorkspaceHandle,
    authority_arc: &SharedPathAuthority,
    repository: &crate::pgn::PgnRepository,
    cancellation: &CancellationToken,
) -> Result<WorkspaceListing, Error> {
    let result = async {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let pgn_path_authority = authority_arc.clone();
        let workspace_for_tree = workspace.clone();
        let (mut listing, missing) = BLOCKING_GATEWAY
            .spawn_cancellable(cancellation.clone(), move |token| {
                if let Some(collections) = pgn_path_authority.collections()? {
                    let (listing, missing, _) =
                        collections.discover(&pgn_path_authority, &workspace_for_tree, token)?;
                    Ok((listing, missing))
                } else {
                    collect_tree_entries(&pgn_path_authority, &workspace_for_tree, token)
                }
            })
            .await?;
        #[cfg(test)]
        ROOT_FAILURE_POST_WALK_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        for handle in missing {
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            let count = async {
                let resolved = {
                    authority_arc.with_mut(|authority| {
                        authority.resolve(handle.path_ref(), PathOperation::ReadPgn, &[])
                    })??
                };
                pgn::count_pgn_games_core(resolved, cancellation, repository).await
            }
            .await;
            match count {
                Ok(game_count) => {
                    set_workspace_game_count(&mut listing.entries, &handle, game_count)
                }
                Err(error) => {
                    let category = listing_count_error(error)?;
                    set_workspace_read_error(&mut listing.entries, &handle, category);
                }
            }
        }
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        Ok(listing)
    }
    .await;
    match result {
        Ok(entries) => Ok(entries),
        Err(error) => {
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            if matches!(error.unlabelled(), Error::Cancellation) || error.root_failure().is_some() {
                return Err(error);
            }
            let authority = authority_arc.clone();
            let root = workspace.path_ref().clone();
            BLOCKING_GATEWAY
                .spawn_cancellable(cancellation.clone(), move |token| {
                    Err(crate::infra::path_authority::probe_listing_root_failure(
                        &authority,
                        &root,
                        PathOperation::ReadPgn,
                        error,
                        token,
                    ))
                })
                .await
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn list_file_workspace(
    workspace: FileWorkspaceHandle,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceListing, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "list_file_workspace")?;
    let cancellation = operation.token();
    let authority_arc = state.pgn_path_authority.clone();
    let repository = state.pgn_repository.clone();
    crate::infra::operations::run_native_operation(operation, "list_file_workspace", async move {
        list_file_workspace_core(&workspace, &authority_arc, &repository, &cancellation).await
    })
    .await
}

#[cfg(test)]
std::thread_local! {
    static PAIRED_RENAME_POST_PRIMARY_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn paired_rename(
    source: &WorkspaceMutationTarget,
    target_parent: &fs::File,
    target_leaf: &std::ffi::OsStr,
) -> Result<crate::infra::fs::AtomicFileOutcome, Error> {
    paired_rename_inner(source, target_parent, target_leaf, None).map(|(outcome, _)| outcome)
}

#[derive(Debug)]
enum WorkspaceSidecarDisposition {
    Absent,
    Moved {
        identity: (u64, u64),
        saved_bytes: Option<Vec<u8>>,
    },
    Created((u64, u64)),
}

fn replace_owned_workspace_metadata(
    parent: &fs::File,
    leaf: &OsStr,
    identity: &mut (u64, u64),
    bytes: &[u8],
    precommit: impl FnOnce() -> Result<(), Error>,
) -> Result<(), Error> {
    let installed = crate::infra::fs::atomic_replace_at_identified_with_precommit(
        parent,
        leaf,
        || {
            crate::infra::fs::assert_entry_identity(parent, leaf, *identity, false)?;
            precommit()
        },
        |file| {
            use std::io::Write;
            file.write_all(bytes).map_err(Error::from)
        },
    )?;
    *identity = installed.identity;
    crate::infra::fs::require_durable(
        installed.outcome,
        crate::error::DurabilityStage::WorkspaceSidecarReplacement,
    )
}

fn rewrite_moved_workspace_metadata(
    source: &WorkspaceMutationTarget,
    target_leaf: &OsStr,
    disposition: &mut WorkspaceSidecarDisposition,
    bytes: &[u8],
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    let WorkspaceSidecarDisposition::Moved {
        identity,
        saved_bytes,
    } = disposition
    else {
        return Ok(());
    };
    let info = sidecar_leaf(target_leaf)?;
    let mut file =
        crate::infra::fs::open_regular_at(&source.parent, &info, RegularFileAccess::ReadOnly)?;
    if crate::infra::path_authority::opened_file_identity(&file)? != *identity {
        return Err(Error::Conflict(
            "workspace sidecar changed before metadata rewrite".into(),
        ));
    }
    let declared = file.metadata()?.len();
    let original = crate::infra::fs::read_bounded_bytes(
        &mut file,
        declared,
        MAX_WORKSPACE_METADATA_BYTES,
        METADATA_LIMIT_MESSAGE,
        || Ok(()),
    )?;
    let result = replace_owned_workspace_metadata(&source.parent, &info, identity, bytes, || {
        crate::infra::fs::assert_entry_identity(
            &source.parent,
            target_leaf,
            source.identity,
            false,
        )?;
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        Ok(())
    });
    if matches!(
        &result,
        Ok(()) | Err(Error::CommittedDurabilityUncertain(_))
    ) {
        *saved_bytes = Some(original);
    }
    result
}

fn reverse_workspace_primary_rename(
    source: &WorkspaceMutationTarget,
    target_parent: &fs::File,
    target_leaf: &OsStr,
) -> Result<(), Error> {
    crate::infra::fs::rename_entry_at(
        target_parent,
        target_leaf,
        source.identity,
        source.is_dir,
        &source.parent,
        &source.leaf,
    )
    .and_then(|outcome| {
        crate::infra::fs::require_durable(outcome, crate::error::DurabilityStage::WorkspaceRename)
    })
}

fn reverse_workspace_rename(
    source: &WorkspaceMutationTarget,
    target_parent: &fs::File,
    target_leaf: &OsStr,
    disposition: &mut WorkspaceSidecarDisposition,
    bucket: Option<(&fs::File, &OsStr, (u64, u64))>,
) -> Result<(), Error> {
    use crate::infra::fs::{
        remove_empty_directory_at, remove_entry_at, rename_entry_at, require_durable,
    };
    let target_info = sidecar_leaf(target_leaf)?;
    let restoration =
        match disposition {
            WorkspaceSidecarDisposition::Moved {
                identity,
                saved_bytes: Some(bytes),
            } => replace_owned_workspace_metadata(
                target_parent,
                &target_info,
                identity,
                bytes,
                || Ok(()),
            ),
            _ => Ok(()),
        };
    finish_committed_workspace_step(restoration, || {
        let sidecar = match disposition {
            WorkspaceSidecarDisposition::Moved { identity, .. } => rename_entry_at(
                target_parent,
                &target_info,
                *identity,
                false,
                &source.parent,
                &sidecar_leaf(&source.leaf)?,
            )
            .and_then(|outcome| {
                require_durable(outcome, crate::error::DurabilityStage::WorkspaceRename)
            }),
            WorkspaceSidecarDisposition::Created(identity) => {
                remove_entry_at(target_parent, &target_info, *identity, false)
            }
            _ => Ok(()),
        };
        finish_committed_workspace_step(sidecar, || {
            let primary = reverse_workspace_primary_rename(source, target_parent, target_leaf);
            finish_committed_workspace_step(primary, || match bucket {
                Some((parent, leaf, identity)) => remove_empty_directory_at(parent, leaf, identity),
                None => Ok(()),
            })
        })
    })
}

fn compensate_workspace_rename(
    result: Result<(), Error>,
    source: &WorkspaceMutationTarget,
    target_parent: &fs::File,
    target_leaf: &OsStr,
    disposition: &mut WorkspaceSidecarDisposition,
    bucket: Option<(&fs::File, &OsStr, (u64, u64))>,
) -> Result<(), Error> {
    match result {
        Err(error) if !matches!(error, Error::CommittedDurabilityUncertain(_)) => {
            Err(Error::with_cleanup(
                error,
                reverse_workspace_rename(source, target_parent, target_leaf, disposition, bucket),
            ))
        }
        result => result,
    }
}

/// Forward file mutations own the destination sidecar even when there was none to move.
/// Publication refusal belongs to the pair so only its retained primary object is reversed.
fn paired_workspace_rename(
    source: &WorkspaceMutationTarget,
    target_parent: &fs::File,
    target_leaf: &OsStr,
    metadata_bytes: &[u8],
    cancellation: &CancellationToken,
) -> Result<
    (
        crate::infra::fs::AtomicFileOutcome,
        WorkspaceSidecarDisposition,
    ),
    Error,
> {
    paired_rename_inner(
        source,
        target_parent,
        target_leaf,
        Some((metadata_bytes, cancellation)),
    )
}

fn paired_rename_inner(
    source: &WorkspaceMutationTarget,
    target_parent: &fs::File,
    target_leaf: &OsStr,
    forward_metadata: Option<(&[u8], &CancellationToken)>,
) -> Result<
    (
        crate::infra::fs::AtomicFileOutcome,
        WorkspaceSidecarDisposition,
    ),
    Error,
> {
    use crate::infra::fs::{
        assert_entry_identity, atomic_create_workspace_sidecar_at, entry_identity_at,
        rename_entry_at, rename_optional_regular_at, rename_workspace_entry_at,
        rename_workspace_sidecar_at, AtomicFileOutcome,
    };
    let rename_entry_at = if forward_metadata.is_some() {
        rename_workspace_entry_at
    } else {
        rename_entry_at
    };
    let rename_primary = || {
        let primary = rename_entry_at(
            &source.parent,
            &source.leaf,
            source.identity,
            source.is_dir,
            target_parent,
            target_leaf,
        )?;
        #[cfg(test)]
        PAIRED_RENAME_POST_PRIMARY_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        Ok::<_, Error>(primary)
    };
    // Directories never own metadata, including names shared with a sibling PGN.
    if source.is_dir {
        return Ok((rename_primary()?, WorkspaceSidecarDisposition::Absent));
    }
    let source_info = sidecar_leaf(&source.leaf)?;
    let target_info = sidecar_leaf(target_leaf)?;
    let rename_optional_regular_at = if forward_metadata.is_some() {
        rename_workspace_sidecar_at
    } else {
        rename_optional_regular_at
    };
    let primary = rename_primary()?;
    let mut disposition = WorkspaceSidecarDisposition::Absent;
    let sidecar_result: Result<Option<AtomicFileOutcome>, Error> = (|| {
        let identity = match entry_identity_at(&source.parent, &source_info, false) {
            Ok(identity) => Some(identity),
            Err(error) if error.is_missing_entry() => None,
            Err(error) => return Err(error),
        };
        if let Some(identity) = identity {
            assert_entry_identity(&source.parent, &source_info, identity, false)?;
            if let Some(sidecar) = rename_optional_regular_at(
                &source.parent,
                &source_info,
                target_parent,
                &target_info,
            )? {
                disposition = WorkspaceSidecarDisposition::Moved {
                    identity,
                    saved_bytes: None,
                };
                return Ok(Some(sidecar));
            }
        }
        let Some((bytes, cancellation)) = forward_metadata else {
            return Ok(None);
        };
        let precommit = || {
            assert_entry_identity(target_parent, target_leaf, source.identity, source.is_dir)?;
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            Ok(())
        };
        let installed =
            atomic_create_workspace_sidecar_at(target_parent, &target_info, precommit, |file| {
                use std::io::Write;
                file.write_all(bytes).map_err(Error::from)
            })?;
        disposition = WorkspaceSidecarDisposition::Created(installed.identity);
        Ok(Some(installed.outcome))
    })();
    let sidecar = match sidecar_result {
        Ok(sidecar) => sidecar,
        Err(error) => {
            if let AtomicFileOutcome::CommittedDurabilityUncertain(cause) = &primary {
                log::warn!("primary rename parent sync failed before sidecar refusal: {cause}");
            }
            // The same retained descriptors are used for rollback; never reopen a mutable pathname.
            let rollback = reverse_workspace_primary_rename(source, target_parent, target_leaf);
            if let Err(rollback) = &rollback {
                log::error!(
                    "paired rename failed: {}; rollback cleanup reported: {}",
                    error.diagnostic(),
                    rollback.diagnostic()
                );
            }
            return Err(Error::with_cleanup(error, rollback));
        }
    };
    let outcome = match (primary, sidecar) {
        (
            AtomicFileOutcome::CommittedDurabilityUncertain(first),
            Some(AtomicFileOutcome::CommittedDurabilityUncertain(later)),
        ) => {
            log::warn!("additional workspace sidecar rename parent sync failed: {later}");
            AtomicFileOutcome::CommittedDurabilityUncertain(first)
        }
        (AtomicFileOutcome::DurableCommit, Some(sidecar)) => sidecar,
        (primary, _) => primary,
    };
    Ok((outcome, disposition))
}

fn rebind_after_move(
    pgn_path_authority: &SharedPathAuthority,
    entry: &FileWorkspaceHandle,
    source: &WorkspaceMutationTarget,
    target: &Path,
    target_parent_identity: (u64, u64),
) -> Result<(), Error> {
    pgn_path_authority.with_mut(|authority| {
        #[cfg(test)]
        WORKSPACE_REBIND_PRE_REGISTER_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook()?;
            }
            Ok::<(), Error>(())
        })?;
        if source.is_dir {
            authority.rebase_workspace_entries(source.path(), target)
        } else {
            authority.rebind_workspace_entry(
                entry,
                target,
                target.file_stem().unwrap_or_default().to_string_lossy(),
                target_parent_identity,
            )
        }
    })?
}

#[tauri::command]
#[specta::specta]
pub async fn create_workspace_file(
    workspace: FileWorkspaceHandle,
    parent: FileWorkspaceHandle,
    name: String,
    metadata: WorkspaceMetadata,
    content: WorkspaceFileContent,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceEntry, Error> {
    let operation = state.operations.accept("create_workspace_file")?;
    let cancellation = operation.token();
    let state = state.inner().clone();
    crate::infra::operations::run_native_operation(operation, "create_workspace_file", async move {
        let pgn_path_authority = state.pgn_path_authority.clone();
        let workspace_mutation = Arc::clone(&state.workspace_mutation);
        let pgn_repository = state.pgn_repository.clone();
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                let result = create_workspace_file_blocking(
                    workspace.clone(),
                    parent,
                    name,
                    metadata,
                    content,
                    &pgn_path_authority,
                    &workspace_mutation,
                    &pgn_repository,
                    token,
                )?;
                reconcile_workspace_collections(&pgn_path_authority, &workspace)?;
                Ok(result)
            })
            .await
    })
    .await
}

// This core deliberately mirrors the flat command boundary plus its three shared owners (path
// authority, mutation lock, PGN repository). Grouping those values would introduce a one-off
// request type with no second consumer.
#[allow(clippy::too_many_arguments)]
pub(crate) fn create_workspace_file_blocking(
    workspace: FileWorkspaceHandle,
    parent: FileWorkspaceHandle,
    name: String,
    metadata: WorkspaceMetadata,
    content: WorkspaceFileContent,
    pgn_path_authority: &SharedPathAuthority,
    workspace_mutation: &Mutex<()>,
    pgn_repository: &pgn::PgnRepository,
    cancellation: &CancellationToken,
) -> Result<WorkspaceEntry, Error> {
    create_owned_workspace_file_blocking(
        workspace,
        parent,
        name,
        metadata,
        content,
        pgn_path_authority,
        workspace_mutation,
        pgn_repository,
        cancellation,
        None,
    )
}

type WorkspaceFileOwner<'a> = dyn FnMut((u64, u64)) -> Result<(), Error> + 'a;

#[allow(clippy::too_many_arguments)]
pub(crate) fn create_owned_workspace_file_blocking(
    workspace: FileWorkspaceHandle,
    parent: FileWorkspaceHandle,
    name: String,
    metadata: WorkspaceMetadata,
    content: WorkspaceFileContent,
    pgn_path_authority: &SharedPathAuthority,
    workspace_mutation: &Mutex<()>,
    pgn_repository: &pgn::PgnRepository,
    cancellation: &CancellationToken,
    mut owner: Option<&mut WorkspaceFileOwner<'_>>,
) -> Result<WorkspaceEntry, Error> {
    let metadata_bytes = serialize_metadata(&metadata)?;
    let _guard = lock_std_cancellable(
        workspace_mutation,
        cancellation,
        "workspace mutation lock was poisoned",
    )?;
    let root = mutation_target(pgn_path_authority, &workspace)?;
    let parent_target = mutation_target(pgn_path_authority, &parent)?;
    ensure_registered_descendant(&root, &parent_target)?;
    let parent_dir = parent_target.directory()?;
    let destination_identity = parent_target.identity;
    let filename = pgn_name(&name)?;
    let target_leaf = std::ffi::OsString::from(&filename);
    let target = parent_target.path().join(&filename);
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    let info_leaf = sidecar_leaf(&target_leaf)?;
    crate::infra::fs::ensure_atomic_create_available_at(parent_dir, &target_leaf)?;
    crate::infra::fs::ensure_atomic_create_available_at(parent_dir, &info_leaf)?;
    let source_snapshot = match &content {
        WorkspaceFileContent::Text { .. } => None,
        WorkspaceFileContent::Copy { source, revision } => {
            let resolved = {
                pgn_path_authority.with_mut(|authority| {
                    authority.resolve(source.path_ref(), PathOperation::ReadPgn, &[])
                })??
            };
            let snapshot = resolved.pgn_snapshot()?;
            if pgn::revision_string(&snapshot) != revision.as_str() {
                return Err(Error::Conflict(
                    "source PGN changed since it was opened".into(),
                ));
            }
            Some(snapshot)
        }
    };
    let mut source_file = source_snapshot
        .as_ref()
        .map(|snapshot| snapshot.file.try_clone())
        .transpose()?;
    let source_size = source_snapshot
        .as_ref()
        .map(|snapshot| snapshot.revision.size);
    let installed = crate::infra::fs::atomic_create_at_identified_with_precommit(
        parent_dir,
        &target_leaf,
        || {
            let current_root = mutation_target(pgn_path_authority, &workspace)?;
            let current_parent = mutation_target(pgn_path_authority, &parent)?;
            ensure_registered_descendant(&current_root, &current_parent)?;
            if current_parent.identity != destination_identity {
                return Err(Error::Conflict(
                    "workspace destination changed during file creation".into(),
                ));
            }
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            if let Some(snapshot) = &source_snapshot {
                if snapshot.current_revision()? != snapshot.revision {
                    return Err(Error::Conflict("source PGN changed during import".into()));
                }
            }
            Ok(())
        },
        |file| {
            use std::io::Write;
            match &content {
                WorkspaceFileContent::Text { pgn } => {
                    file.write_all(pgn.as_bytes()).map_err(Error::from)
                }
                WorkspaceFileContent::Copy { .. } => {
                    let source = source_file.as_mut().ok_or_else(|| {
                        Error::Conflict("source PGN snapshot is unavailable".into())
                    })?;
                    let end = source_size.ok_or_else(|| {
                        Error::Conflict("source PGN snapshot size is unavailable".into())
                    })?;
                    pgn::copy_range(source, file, 0, end, cancellation)
                }
            }?;
            if let Some(owner) = owner.as_mut() {
                owner(crate::infra::path_authority::opened_file_identity(file)?)?;
            }
            #[cfg(test)]
            WORKSPACE_CREATED_FILE_POST_WRITE_HOOK.with(|slot| {
                if let Some(hook) = slot.borrow_mut().take() {
                    hook(file)?;
                }
                Ok::<(), Error>(())
            })?;
            Ok(())
        },
    )?;
    let pgn_uncertainty = durability_uncertainty(
        installed.outcome,
        crate::error::DurabilityStage::WorkspacePgnCreation,
    );
    let sidecar =
        match crate::infra::fs::atomic_create_at_identified(parent_dir, &info_leaf, |file| {
            use std::io::Write;
            file.write_all(&metadata_bytes).map_err(Error::from)
        }) {
            Ok(sidecar) => sidecar,
            Err(error) => {
                let cleanup = rollback_created_workspace_file(
                    parent_dir,
                    &target_leaf,
                    installed.identity,
                    None,
                    None,
                );
                return Err(Error::with_cleanup(error, cleanup));
            }
        };
    let sidecar_uncertainty = durability_uncertainty(
        sidecar.outcome,
        crate::error::DurabilityStage::WorkspaceSidecarCreation,
    );
    let game_count = match count_installed_workspace_pgn(
        parent_dir,
        &target_leaf,
        installed.identity,
        pgn_repository,
        cancellation,
    ) {
        Ok(count) => count,
        Err(error) => {
            let cleanup = rollback_created_workspace_file(
                parent_dir,
                &target_leaf,
                installed.identity,
                Some((&info_leaf, sidecar.identity)),
                Some(pgn_repository),
            );
            return Err(Error::with_cleanup(error, cleanup));
        }
    };
    let handle = match register_created_entry(
        pgn_path_authority,
        &workspace,
        &target,
        name.clone(),
        installed.identity,
        parent_target.identity,
        false,
    ) {
        Ok(handle) => handle,
        Err(Error::CommittedDurabilityUncertain(stage)) => {
            return Err(Error::CommittedDurabilityUncertain(
                pgn_uncertainty.or(sidecar_uncertainty).unwrap_or(stage),
            ));
        }
        Err(error) => {
            let cleanup = rollback_created_workspace_file(
                parent_dir,
                &target_leaf,
                installed.identity,
                Some((&info_leaf, sidecar.identity)),
                Some(pgn_repository),
            );
            return Err(Error::with_cleanup(error, cleanup));
        }
    };
    #[cfg(test)]
    if let Some(hook) = pgn_repository.take_create_post_register_hook()? {
        hook();
    }
    let entry = WorkspaceEntry {
        handle,
        kind: WorkspaceEntryKind::File,
        name,
        children: vec![],
        metadata: Some(metadata),
        read_error: None,
        game_count: Some(game_count),
        last_modified: installed.modified_seconds,
    };
    if let Some(error) = pgn_uncertainty.or(sidecar_uncertainty) {
        return Err(Error::CommittedDurabilityUncertain(error));
    }
    Ok(entry)
}

#[tauri::command]
#[specta::specta]
pub async fn create_workspace_directory(
    workspace: FileWorkspaceHandle,
    parent: FileWorkspaceHandle,
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceEntry, Error> {
    let operation = state.operations.accept("create_workspace_directory")?;
    let cancellation = operation.token();
    let pgn_path_authority = state.pgn_path_authority.clone();
    let workspace_mutation = Arc::clone(&state.workspace_mutation);
    crate::infra::operations::run_native_operation(
        operation,
        "create_workspace_directory",
        async move {
            BLOCKING_GATEWAY
                .spawn_cancellable(cancellation, move |token| {
                    create_workspace_directory_inner(
                        workspace,
                        parent,
                        name,
                        &pgn_path_authority,
                        &workspace_mutation,
                        token,
                    )
                })
                .await
        },
    )
    .await
}

fn create_workspace_directory_inner(
    workspace: FileWorkspaceHandle,
    parent: FileWorkspaceHandle,
    name: String,
    pgn_path_authority: &SharedPathAuthority,
    workspace_mutation: &Mutex<()>,
    cancellation: &CancellationToken,
) -> Result<WorkspaceEntry, Error> {
    let _guard = lock_std_cancellable(
        workspace_mutation,
        cancellation,
        "workspace mutation lock was poisoned",
    )?;
    let root = mutation_target(pgn_path_authority, &workspace)?;
    let parent_target = mutation_target(pgn_path_authority, &parent)?;
    ensure_registered_descendant(&root, &parent_target)?;
    let parent_dir = parent_target.directory()?;
    let name = validate_name(&name)?.to_string();
    let target = parent_target.path().join(&name);
    let target_leaf = std::ffi::OsString::from(&name);
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    let directory_uncertainty = durability_uncertainty(
        crate::infra::fs::create_workspace_directory_at(parent_dir, &target_leaf)?,
        crate::error::DurabilityStage::WorkspaceDirectoryCreation,
    );
    #[cfg(test)]
    WORKSPACE_CREATED_DIRECTORY_PRE_OBSERVE_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
    let (identity, modified_seconds) =
        match crate::infra::fs::entry_observation_at(parent_dir, &target_leaf, true) {
            Ok(observed) => observed,
            Err(error) => {
                return Err(Error::with_cleanup(
                    error,
                    Err(unidentified_directory_not_removed()),
                ));
            }
        };
    let handle = match register_created_entry(
        pgn_path_authority,
        &workspace,
        &target,
        name.clone(),
        identity,
        parent_target.identity,
        true,
    ) {
        Ok(handle) => handle,
        Err(Error::CommittedDurabilityUncertain(stage)) => {
            return Err(Error::CommittedDurabilityUncertain(
                directory_uncertainty.unwrap_or(stage),
            ));
        }
        Err(error) => {
            let cleanup =
                crate::infra::fs::remove_empty_directory_at(parent_dir, &target_leaf, identity);
            return Err(Error::with_cleanup(error, cleanup));
        }
    };
    let entry = WorkspaceEntry {
        handle,
        kind: WorkspaceEntryKind::Directory,
        name,
        children: vec![],
        metadata: None,
        read_error: None,
        game_count: None,
        last_modified: modified_seconds,
    };
    if let Some(stage) = directory_uncertainty {
        return Err(Error::CommittedDurabilityUncertain(stage));
    }
    Ok(entry)
}

#[tauri::command]
#[specta::specta]
pub async fn move_workspace_entry(
    workspace: FileWorkspaceHandle,
    entry: FileWorkspaceHandle,
    target_directory: FileWorkspaceHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let operation = state.operations.accept("move_workspace_entry")?;
    let cancellation = operation.token();
    let pgn_path_authority = state.pgn_path_authority.clone();
    let workspace_mutation = Arc::clone(&state.workspace_mutation);
    crate::infra::operations::run_native_operation(operation, "move_workspace_entry", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                let result = move_workspace_entry_blocking(
                    workspace.clone(),
                    entry,
                    target_directory,
                    &pgn_path_authority,
                    &workspace_mutation,
                    token,
                );
                finish_committed_workspace_step(result, || {
                    reconcile_workspace_collections(&pgn_path_authority, &workspace)
                })
            })
            .await
    })
    .await
}

fn move_workspace_entry_blocking(
    workspace: FileWorkspaceHandle,
    entry: FileWorkspaceHandle,
    target_directory: FileWorkspaceHandle,
    pgn_path_authority: &SharedPathAuthority,
    workspace_mutation: &Mutex<()>,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    let _guard = lock_std_cancellable(
        workspace_mutation,
        cancellation,
        "workspace mutation lock was poisoned",
    )?;
    let root = mutation_target(pgn_path_authority, &workspace)?;
    let source = mutation_target(pgn_path_authority, &entry)?;
    let destination = mutation_target(pgn_path_authority, &target_directory)?;
    ensure_registered_descendant(&root, &source)?;
    ensure_registered_descendant(&root, &destination)?;
    let name = source.leaf.clone();
    let target = destination.path().join(&name);
    if source.path() == target {
        return Ok(());
    }
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    let metadata_bytes = serialize_metadata(&WorkspaceMetadata::default())?;
    let (outcome, mut disposition) = paired_workspace_rename(
        &source,
        destination.directory()?,
        &name,
        &metadata_bytes,
        cancellation,
    )?;
    let result = finish_workspace_rename(outcome, || {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        rebind_after_move(
            pgn_path_authority,
            &entry,
            &source,
            &target,
            destination.identity,
        )
    });
    compensate_workspace_rename(
        result,
        &source,
        destination.directory()?,
        &name,
        &mut disposition,
        None,
    )
}

#[tauri::command]
#[specta::specta]
pub async fn rename_workspace_file(
    workspace: FileWorkspaceHandle,
    entry: FileWorkspaceHandle,
    name: String,
    metadata: WorkspaceMetadata,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let operation = state.operations.accept("rename_workspace_file")?;
    let cancellation = operation.token();
    let pgn_path_authority = state.pgn_path_authority.clone();
    let workspace_mutation = Arc::clone(&state.workspace_mutation);
    crate::infra::operations::run_native_operation(operation, "rename_workspace_file", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                let result = rename_workspace_file_blocking(
                    workspace.clone(),
                    entry,
                    name,
                    metadata,
                    &pgn_path_authority,
                    &workspace_mutation,
                    token,
                );
                finish_committed_workspace_step(result, || {
                    reconcile_workspace_collections(&pgn_path_authority, &workspace)
                })
            })
            .await
    })
    .await
}

pub(crate) fn rename_workspace_file_blocking(
    workspace: FileWorkspaceHandle,
    entry: FileWorkspaceHandle,
    name: String,
    metadata: WorkspaceMetadata,
    pgn_path_authority: &SharedPathAuthority,
    workspace_mutation: &Mutex<()>,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    let metadata_bytes = serialize_metadata(&metadata)?;
    let _guard = lock_std_cancellable(
        workspace_mutation,
        cancellation,
        "workspace mutation lock was poisoned",
    )?;
    let root = mutation_target(pgn_path_authority, &workspace)?;
    let source = mutation_target(pgn_path_authority, &entry)?;
    ensure_registered_descendant(&root, &source)?;
    if source.is_dir {
        return Err(Error::InvalidInput("workspace entry must be a file".into()));
    }
    let filename = pgn_name(&name)?;
    let target = source
        .path()
        .parent()
        .ok_or_else(|| Error::InvalidInput("workspace file has no parent".into()))?
        .join(&filename);
    let target_leaf = std::ffi::OsString::from(&filename);
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    if target_leaf == source.leaf {
        return match replace_workspace_file_metadata(
            &source.parent,
            &source.leaf,
            source.identity,
            &metadata_bytes,
            cancellation,
        )? {
            Some(stage) => Err(Error::CommittedDurabilityUncertain(stage)),
            None => Ok(()),
        };
    }
    let target_parent_identity =
        crate::infra::path_authority::opened_file_identity(&source.parent)?;
    let (outcome, mut disposition) = paired_workspace_rename(
        &source,
        &source.parent,
        &target_leaf,
        &metadata_bytes,
        cancellation,
    )?;
    let result = finish_workspace_rename(outcome, || {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let sidecar = rewrite_moved_workspace_metadata(
            &source,
            &target_leaf,
            &mut disposition,
            &metadata_bytes,
            cancellation,
        );
        finish_committed_workspace_step(sidecar, || {
            rebind_after_move(
                pgn_path_authority,
                &entry,
                &source,
                &target,
                target_parent_identity,
            )
        })
    });
    compensate_workspace_rename(
        result,
        &source,
        &source.parent,
        &target_leaf,
        &mut disposition,
        None,
    )
}

#[tauri::command]
#[specta::specta]
pub async fn trash_workspace_entry(
    workspace: FileWorkspaceHandle,
    entry: FileWorkspaceHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let operation = state.operations.accept("trash_workspace_entry")?;
    let cancellation = operation.token();
    let pgn_path_authority = state.pgn_path_authority.clone();
    let workspace_mutation = Arc::clone(&state.workspace_mutation);
    crate::infra::operations::run_native_operation(operation, "trash_workspace_entry", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                let result = trash_entry(
                    &pgn_path_authority,
                    &workspace_mutation,
                    &workspace,
                    &entry,
                    token,
                );
                finish_committed_workspace_step(result, || {
                    reconcile_workspace_collections(&pgn_path_authority, &workspace)
                })
            })
            .await
    })
    .await
}

pub(crate) fn trash_entry(
    pgn_path_authority: &SharedPathAuthority,
    workspace_mutation: &Mutex<()>,
    workspace: &FileWorkspaceHandle,
    entry: &FileWorkspaceHandle,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    let _guard = lock_std_cancellable(
        workspace_mutation,
        cancellation,
        "workspace mutation lock was poisoned",
    )?;
    let root = mutation_target(pgn_path_authority, workspace)?;
    let source = mutation_target(pgn_path_authority, entry)?;
    ensure_registered_descendant(&root, &source)?;
    let root_dir = root.directory()?;
    let trash = std::ffi::OsString::from(TRASH_DIRECTORY);
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    // Both components are created through retained descriptors; no recursive pathname creation.
    let trash_dir = crate::infra::fs::ensure_directory_at(root_dir, &trash)?;
    let trash_path = root.path().join(TRASH_DIRECTORY);
    let bucket = std::ffi::OsString::from(uuid::Uuid::new_v4().to_string());
    crate::infra::fs::create_dir_at(&trash_dir, &bucket)?;
    let bucket_identity = crate::infra::fs::entry_identity_at(&trash_dir, &bucket, true)?;
    let bucket_path = trash_path.join(&bucket);
    let bucket_dir = crate::infra::fs::open_directory_at(&trash_dir, &bucket, true)?;
    let target = bucket_path.join(&source.leaf);
    let target_parent_identity = crate::infra::path_authority::opened_file_identity(&bucket_dir)?;
    let (outcome, mut disposition) = paired_rename_inner(&source, &bucket_dir, &source.leaf, None)?;
    let result = finish_workspace_rename(outcome, || {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        rebind_after_move(
            pgn_path_authority,
            entry,
            &source,
            &target,
            target_parent_identity,
        )
    });
    compensate_workspace_rename(
        result,
        &source,
        &bucket_dir,
        &source.leaf,
        &mut disposition,
        Some((&trash_dir, &bucket, bucket_identity)),
    )
}

#[tauri::command]
#[specta::specta]
pub async fn restore_workspace_entry(
    workspace: FileWorkspaceHandle,
    entry: FileWorkspaceHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let operation = state.operations.accept("restore_workspace_entry")?;
    let cancellation = operation.token();
    let pgn_path_authority = state.pgn_path_authority.clone();
    let workspace_mutation = Arc::clone(&state.workspace_mutation);
    crate::infra::operations::run_native_operation(
        operation,
        "restore_workspace_entry",
        async move {
            BLOCKING_GATEWAY
                .spawn_cancellable(cancellation, move |token| {
                    let result = restore_entry(
                        &pgn_path_authority,
                        &workspace_mutation,
                        &workspace,
                        &entry,
                        token,
                    );
                    finish_committed_workspace_step(result, || {
                        reconcile_workspace_collections(&pgn_path_authority, &workspace)
                    })
                })
                .await
        },
    )
    .await
}

pub(crate) fn restore_entry(
    pgn_path_authority: &SharedPathAuthority,
    workspace_mutation: &Mutex<()>,
    workspace: &FileWorkspaceHandle,
    entry: &FileWorkspaceHandle,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    let _guard = lock_std_cancellable(
        workspace_mutation,
        cancellation,
        "workspace mutation lock was poisoned",
    )?;
    let root = mutation_target(pgn_path_authority, workspace)?;
    let source = mutation_target(pgn_path_authority, entry)?;
    let trash_root = root.path().join(TRASH_DIRECTORY);
    source
        .path()
        .strip_prefix(&trash_root)
        .map_err(|_| Error::InvalidInput("workspace entry is not in trash".into()))?;
    let target = root.path().join(&source.leaf);
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    let (outcome, mut disposition) =
        paired_rename_inner(&source, root.directory()?, &source.leaf, None)?;
    let result = finish_workspace_rename(outcome, || {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        rebind_after_move(pgn_path_authority, entry, &source, &target, root.identity)
    });
    compensate_workspace_rename(
        result,
        &source,
        root.directory()?,
        &source.leaf,
        &mut disposition,
        None,
    )
}

#[tauri::command]
#[specta::specta]
pub async fn permanently_delete_workspace_entry(
    workspace: FileWorkspaceHandle,
    entry: FileWorkspaceHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let operation = state
        .operations
        .accept("permanently_delete_workspace_entry")?;
    let cancellation = operation.token();
    let state = state.inner().clone();
    crate::infra::operations::run_native_operation(
        operation,
        "permanently_delete_workspace_entry",
        async move { permanently_delete_entry(&state, &workspace, &entry, cancellation).await },
    )
    .await
}

async fn permanently_delete_entry(
    state: &AppState,
    workspace: &FileWorkspaceHandle,
    entry: &FileWorkspaceHandle,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<(), Error> {
    let pgn_path_authority = state.pgn_path_authority.clone();
    let workspace_mutation = Arc::clone(&state.workspace_mutation);
    let workspace = workspace.clone();
    let entry = entry.clone();
    let (dropped_engine_executables, result) = BLOCKING_GATEWAY
        .spawn_cancellable(cancellation, move |token| {
            Ok(permanently_delete_entry_blocking(
                &pgn_path_authority,
                &workspace_mutation,
                &workspace,
                &entry,
                token,
            ))
        })
        .await?;
    let retirement_result = state
        .engine_supervisor
        .retire_executables(dropped_engine_executables)
        .await;
    match (result, retirement_result) {
        (Ok(mut removal), retirement) => {
            removal.record(
                retirement,
                "workspace removal engine retirement",
                Path::new("workspace entry"),
            );
            removal.finish()
        }
        (Err(kept), Err(error)) => {
            log::warn!(
                "workspace removal engine retirement failed: {}",
                error.diagnostic()
            );
            Err(kept)
        }
        (Err(kept), Ok(())) => Err(kept),
    }
}

// Dropped executables must reach `retire_executables` on the error path as well
// as the success path, so they cannot travel through the `Result`. A plain
// `spawn(..).await?` would drop them on `Err` and leave a running engine holding
// an unlinked inode.
// A completed removal carries its physical target count and first failure through retirement.
// An incomplete walk retains its original error instead of entering the completed policy.
fn permanently_delete_entry_blocking(
    pgn_path_authority: &SharedPathAuthority,
    workspace_mutation: &Mutex<()>,
    workspace: &FileWorkspaceHandle,
    entry: &FileWorkspaceHandle,
    cancellation: &CancellationToken,
) -> (Vec<PathRef>, Result<CommittedRemoval, Error>) {
    let mut dropped_engine_executables = Vec::<PathRef>::new();
    let result = (|| {
        let _guard = lock_std_cancellable(
            workspace_mutation,
            cancellation,
            "workspace mutation lock was poisoned",
        )?;
        let root = mutation_target(pgn_path_authority, workspace)?;
        let source = mutation_target(pgn_path_authority, entry)?;
        ensure_registered_descendant(&root, &source)?;
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let mut removal = match crate::infra::fs::remove_entry_at_counted(
            &source.parent,
            &source.leaf,
            source.identity,
            source.is_dir,
        ) {
            Ok(removal) => Ok(removal),
            Err(error @ Error::PartialRemoval { .. }) => Err(error),
            Err(error) => return Err(error),
        };
        let sidecar_result = if source.is_dir {
            Ok(())
        } else {
            sidecar_leaf(&source.leaf).and_then(|sidecar| {
                crate::infra::fs::remove_optional_regular_at(&source.parent, &sidecar)
            })
        };
        if let Ok(removal) = &mut removal {
            removal.record(
                sidecar_result,
                "workspace sidecar cleanup",
                Path::new(&source.leaf),
            );
        }
        let removal_status = if removal.is_err() {
            WorkspaceRemovalStatus::Partial
        } else {
            WorkspaceRemovalStatus::Complete
        };
        let registry_result = (|| {
            pgn_path_authority.with_mut(|authority| {
                authority.remove_workspace_entry(
                    entry,
                    removal_status,
                    &mut dropped_engine_executables,
                )
            })?
        })();

        if let Err(error) = removal {
            match registry_result {
                Ok((CommitDurability::Durable, _)) => {}
                Ok((CommitDurability::DurabilityUncertain(stage), _)) => {
                    log::warn!("partial workspace removal registry durability uncertain: {stage}");
                }
                Err(registry_error) => {
                    log::warn!(
                        "partial workspace removal registry reconciliation failed: {}",
                        registry_error.diagnostic()
                    );
                }
            }
            return Err(error);
        }

        let mut removal = removal?;
        removal.record(
            registry_result.and_then(|(durability, _)| {
                crate::infra::path_authority::require_durable(durability)
            }),
            "workspace removal registry reconciliation",
            Path::new(&source.leaf),
        );
        Ok(removal)
    })();
    if result.is_ok() {
        if let Err(error) = reconcile_workspace_collections(pgn_path_authority, workspace) {
            log::warn!(
                "collection cleanup after permanent delete will retry: {}",
                error.diagnostic()
            );
        }
    }
    (dropped_engine_executables, result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn linked_collections_purging_trashed_directory_removes_descendant_records() {
        use crate::db::linked_collections::{tests::Fixture, CollectionStatus};
        let fixture = Fixture::new();
        let (_, folder) = registered_child_directory(&fixture.state, &fixture.workspace, "games");
        create_workspace_file_blocking(
            fixture.workspace.clone(),
            folder.clone(),
            "child".into(),
            WorkspaceMetadata {
                file_type: WorkspaceFileType::Game,
                tags: vec![],
            },
            WorkspaceFileContent::Text {
                pgn: "[Event \"Game\"]\n\n1. e4 e5 *".into(),
            },
            &fixture.state.pgn_path_authority,
            &fixture.state.workspace_mutation,
            &fixture.state.pgn_repository,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(fixture.list().len(), 1);
        trash_entry(
            &fixture.state.pgn_path_authority,
            &fixture.state.workspace_mutation,
            &fixture.workspace,
            &folder,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(fixture.list()[0].status, CollectionStatus::Trashed);
        let (_, result) = permanently_delete_entry_blocking(
            &fixture.state.pgn_path_authority,
            &fixture.state.workspace_mutation,
            &fixture.workspace,
            &folder,
            &CancellationToken::new(),
        );
        result.unwrap().finish().unwrap();
        assert!(fixture.list().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn linked_collections_permanent_delete_retries_cache_failure_without_failing_delete() {
        use crate::db::linked_collections::{tests::Fixture, CollectionStatus};
        #[derive(Default)]
        struct FailCache {
            source_removed: std::sync::atomic::AtomicBool,
            cleanup_failures: std::sync::atomic::AtomicUsize,
        }
        impl crate::infra::fs::RemovalInjector for FailCache {
            fn inject(&self, point: RemovalFaultPoint) -> std::io::Result<Option<u64>> {
                // The PGN's counted unlink syncs before collection cleanup starts. Sidecar
                // removal and SQLite retirement do not have a fixed number of unlink hooks.
                if point == RemovalFaultPoint::ParentSync {
                    self.source_removed
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                }
                if point == RemovalFaultPoint::BeforeTopOpen
                    && self
                        .source_removed
                        .load(std::sync::atomic::Ordering::SeqCst)
                {
                    self.cleanup_failures
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    return Err(std::io::Error::other("cache cleanup fault"));
                }
                Ok(None)
            }
        }
        let fixture = Fixture::new();
        let file = fixture.create(
            "games",
            "[Event \"Game\"]\n\n1. e4 e5 *",
            WorkspaceFileType::Game,
        );
        let original = fixture.list().remove(0);
        trash_entry(
            &fixture.state.pgn_path_authority,
            &fixture.state.workspace_mutation,
            &fixture.workspace,
            &file,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(fixture.list()[0].status, CollectionStatus::Trashed);
        let injector = Arc::new(FailCache::default());
        let fault = crate::infra::fs::scoped_test_removal_injector(injector.clone());
        let (_, result) = permanently_delete_entry_blocking(
            &fixture.state.pgn_path_authority,
            &fixture.state.workspace_mutation,
            &fixture.workspace,
            &file,
            &CancellationToken::new(),
        );
        result.unwrap().finish().unwrap();
        assert!(
            injector
                .cleanup_failures
                .load(std::sync::atomic::Ordering::SeqCst)
                > 0
        );
        assert_eq!(fixture.registered_ids(), vec![original.id.clone()]);
        assert_eq!(fixture.list()[0].status, CollectionStatus::Trashed);
        assert_eq!(fixture.registered_ids(), vec![original.id.clone()]);
        drop(fault);
        assert!(fixture.list().is_empty());
        assert!(fixture.registered_ids().is_empty());
        assert!(!fixture
            .directory
            .path()
            .join("app/collections")
            .join(format!("{}.db3", original.id))
            .exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn linked_collections_trashed_account_preparation_stays_non_ready() {
        use crate::db::linked_collections::{
            prepare_account_collection, tests::Fixture, AccountIdentity, CollectionStatus,
        };
        let fixture = Fixture::new();
        let file = fixture.create(
            "account",
            "[Event \"Game\"]\n\n1. e4 e5 *",
            WorkspaceFileType::Game,
        );
        let original = fixture.list().remove(0);
        fixture.account(&original.id, "lichess");
        trash_entry(
            &fixture.state.pgn_path_authority,
            &fixture.state.workspace_mutation,
            &fixture.workspace,
            &file,
            &CancellationToken::new(),
        )
        .unwrap();
        fixture.list();
        let app = tauri::test::mock_builder()
            .manage(fixture.state)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let prepared = prepare_account_collection(
            fixture.workspace,
            AccountIdentity {
                provider: "lichess".into(),
                account: "player".into(),
            },
            None,
            app.state::<AppState>(),
        )
        .await
        .unwrap()
        .unwrap();
        let collection = prepared.collection.unwrap();
        assert_eq!(collection.id, original.id);
        assert_eq!(collection.status, CollectionStatus::Trashed);
        assert_eq!(collection.database, original.database);
    }
    use crate::engine::EngineKey;
    use crate::infra::fs::AtomicFileFaultPoint;
    #[cfg(unix)]
    use crate::infra::fs::{set_test_removal_injector, RemovalFault, RemovalFaultPoint};
    #[cfg(unix)]
    use crate::infra::path_authority::{
        set_workspace_metadata_post_open_hook, set_workspace_metadata_pre_open_hook,
    };
    use crate::infra::{
        fs::{set_test_atomic_file_injector, AtomicWriterInjector},
        path_authority::PathAuthority,
    };
    #[cfg(unix)]
    use std::io::{Seek, Write};
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;
    use tauri::Manager;
    use tempfile::TempDir;

    #[test]
    fn listed_mtime_passes_a_pre_1970_timestamp_through() {
        // F2. `filetime_to_unix_seconds` legitimately returns a negative value for a Windows file
        // whose `LastWriteTime` predates 1970, and unix `st_mtime` is signed for the same reason.
        // Rejecting it here failed the whole workspace listing over one old file.
        let entry = DirectoryEntry {
            name: std::ffi::OsString::from("ancient.pgn"),
            kind: DirectoryEntryKind::RegularFile,
            identity: (1, 2),
            modified_seconds: -11_644_473_600,
        };
        assert_eq!(listed_mtime(&entry), -11_644_473_600);
        let epoch = DirectoryEntry {
            modified_seconds: 0,
            ..entry.clone()
        };
        assert_eq!(listed_mtime(&epoch), 0);
        let recent = DirectoryEntry {
            modified_seconds: 1_700_000_000,
            ..entry
        };
        assert_eq!(listed_mtime(&recent), 1_700_000_000);
    }

    #[derive(Clone, Copy, Debug)]
    enum QueuedWorkspaceCommand {
        CreateFile,
        CreateDirectory,
        Move,
        Rename,
        WriteMetadata,
        Trash,
        Restore,
        PermanentlyDelete,
    }

    /// Owns the contended standard mutex on a bounded worker thread so async tests never retain
    /// a `MutexGuard` across `.await`. Drop always releases and joins the holder.
    struct HeldWorkspaceMutation {
        release: Option<std::sync::mpsc::SyncSender<()>>,
        worker: Option<std::thread::JoinHandle<()>>,
    }

    impl HeldWorkspaceMutation {
        fn new(mutation: Arc<StdMutex<()>>) -> Self {
            let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
            let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
            let worker = std::thread::spawn(move || {
                let _guard = mutation.lock().expect("hold workspace mutation lock");
                entered_tx.send(()).expect("report held workspace lock");
                let _ = release_rx.recv_timeout(Duration::from_secs(5));
            });
            entered_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("workspace lock holder must start");
            Self {
                release: Some(release_tx),
                worker: Some(worker),
            }
        }

        fn release(&mut self) {
            if let Some(release) = self.release.take() {
                release.send(()).expect("release workspace lock");
            }
            if let Some(worker) = self.worker.take() {
                worker.join().expect("join workspace lock holder");
            }
        }
    }

    impl Drop for HeldWorkspaceMutation {
        fn drop(&mut self) {
            if let Some(release) = self.release.take() {
                let _ = release.send(());
            }
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    #[cfg(unix)]
    fn workspace_tree_snapshot(root: &Path) -> Vec<(PathBuf, Option<Vec<u8>>)> {
        fn visit(root: &Path, directory: &Path, entries: &mut Vec<(PathBuf, Option<Vec<u8>>)>) {
            let mut children = fs::read_dir(directory)
                .expect("read workspace")
                .map(|child| child.expect("workspace child").path())
                .collect::<Vec<_>>();
            children.sort();
            for child in children {
                let relative = child
                    .strip_prefix(root)
                    .expect("relative path")
                    .to_path_buf();
                if child.is_dir() {
                    entries.push((relative, None));
                    visit(root, &child, entries);
                } else {
                    entries.push((relative, Some(fs::read(&child).expect("read child"))));
                }
            }
        }
        let mut entries = Vec::new();
        visit(root, root, &mut entries);
        entries
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn shutdown_cancels_every_workspace_command_at_the_actual_mutation_lock() {
        for command in [
            QueuedWorkspaceCommand::CreateFile,
            QueuedWorkspaceCommand::CreateDirectory,
            QueuedWorkspaceCommand::Move,
            QueuedWorkspaceCommand::Rename,
            QueuedWorkspaceCommand::WriteMetadata,
            QueuedWorkspaceCommand::Trash,
            QueuedWorkspaceCommand::Restore,
            QueuedWorkspaceCommand::PermanentlyDelete,
        ] {
            let (_directory, state, workspace) = workspace_state();
            let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
            let source_path = root.join("source.pgn");
            fs::write(&source_path, b"[Event \"Source\"]\n\n1. e4 *\n").expect("source");
            let source = registered_child_file(&state, &workspace, &source_path);
            let (_destination_path, destination) =
                registered_child_directory(&state, &workspace, "destination");
            if matches!(command, QueuedWorkspaceCommand::Restore) {
                trash_entry(
                    &state.pgn_path_authority,
                    &state.workspace_mutation,
                    &workspace,
                    &source,
                    &CancellationToken::new(),
                )
                .expect("prepare trashed entry");
            }
            let source_before = mutation_target(&state.pgn_path_authority, &source)
                .expect("source target")
                .path()
                .to_path_buf();
            let descriptor_ids_before = {
                let mut authority = state
                    .pgn_path_authority
                    .raw_for_test()
                    .lock()
                    .expect("authority");
                authority
                    .as_mut()
                    .expect("initialized authority")
                    .descriptors()
                    .iter()
                    .map(|descriptor| descriptor.id.clone())
                    .collect::<Vec<_>>()
            };
            let tree_before = workspace_tree_snapshot(&root);
            let mutation = Arc::clone(&state.workspace_mutation);
            let _held = HeldWorkspaceMutation::new(Arc::clone(&mutation));
            let waiting = crate::infra::cancellable_lock::observe_std_lock_wait(mutation.as_ref());
            let app = tauri::test::mock_app();
            app.manage(state);
            let command_app = app.handle().clone();
            let command_workspace = workspace.clone();
            let command_source = source.clone();
            let command_destination = destination.clone();
            let task = tokio::spawn(async move {
                let state = command_app.state::<AppState>();
                match command {
                    QueuedWorkspaceCommand::CreateFile => create_workspace_file(
                        command_workspace.clone(),
                        command_workspace,
                        "created.pgn".into(),
                        WorkspaceMetadata::default(),
                        WorkspaceFileContent::Text {
                            pgn: "1. d4 *".into(),
                        },
                        state,
                    )
                    .await
                    .map(|_| ()),
                    QueuedWorkspaceCommand::CreateDirectory => create_workspace_directory(
                        command_workspace.clone(),
                        command_workspace,
                        "created".into(),
                        state,
                    )
                    .await
                    .map(|_| ()),
                    QueuedWorkspaceCommand::Move => {
                        move_workspace_entry(
                            command_workspace,
                            command_source.clone(),
                            command_destination.clone(),
                            state,
                        )
                        .await
                    }
                    QueuedWorkspaceCommand::Rename => {
                        rename_workspace_file(
                            command_workspace,
                            command_source.clone(),
                            "renamed.pgn".into(),
                            WorkspaceMetadata::default(),
                            state,
                        )
                        .await
                    }
                    QueuedWorkspaceCommand::WriteMetadata => {
                        write_workspace_file_metadata(
                            command_workspace,
                            command_source.clone(),
                            WorkspaceMetadata::default(),
                            state,
                        )
                        .await
                    }
                    QueuedWorkspaceCommand::Trash => {
                        trash_workspace_entry(command_workspace, command_source.clone(), state)
                            .await
                    }
                    QueuedWorkspaceCommand::Restore => {
                        restore_workspace_entry(command_workspace, command_source.clone(), state)
                            .await
                    }
                    QueuedWorkspaceCommand::PermanentlyDelete => {
                        permanently_delete_workspace_entry(
                            command_workspace,
                            command_source.clone(),
                            state,
                        )
                        .await
                    }
                }
            });
            waiting
                .recv_timeout(Duration::from_secs(5))
                .expect("command must contend on the exact held mutation lock");
            app.state::<AppState>()
                .operations
                .seal_and_request_cancellation()
                .expect("request shutdown cancellation");
            let error = tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .expect("queued command must stop while lock remains held")
                .expect("join queued command")
                .expect_err("queued command must cancel");
            assert!(
                matches!(error, Error::Cancellation),
                "{command:?}: {error:?}"
            );
            assert!(
                mutation.try_lock().is_err(),
                "{command:?}: cancellation must return while the exact lock remains held"
            );
            assert_eq!(workspace_tree_snapshot(&root), tree_before, "{command:?}");
            let state = app.state::<AppState>();
            assert_eq!(
                mutation_target(&state.pgn_path_authority, &source)
                    .expect("source authority remains")
                    .path(),
                source_before,
                "{command:?}"
            );
            let descriptor_ids_after = {
                let mut authority = state
                    .pgn_path_authority
                    .raw_for_test()
                    .lock()
                    .expect("authority");
                authority
                    .as_mut()
                    .expect("initialized authority")
                    .descriptors()
                    .iter()
                    .map(|descriptor| descriptor.id.clone())
                    .collect::<Vec<_>>()
            };
            assert_eq!(descriptor_ids_after, descriptor_ids_before, "{command:?}");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn every_workspace_command_finishes_its_tail_after_caller_abort() {
        for command in [
            QueuedWorkspaceCommand::CreateFile,
            QueuedWorkspaceCommand::CreateDirectory,
            QueuedWorkspaceCommand::Move,
            QueuedWorkspaceCommand::Rename,
            QueuedWorkspaceCommand::WriteMetadata,
            QueuedWorkspaceCommand::Trash,
            QueuedWorkspaceCommand::Restore,
            QueuedWorkspaceCommand::PermanentlyDelete,
        ] {
            let (_directory, state, workspace) = workspace_state();
            let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
            let source_path = root.join("source.pgn");
            fs::write(&source_path, b"[Event \"Source\"]\n\n1. e4 *\n").expect("source");
            let source = registered_child_file(&state, &workspace, &source_path);
            let (destination_path, destination) =
                registered_child_directory(&state, &workspace, "destination");
            if matches!(command, QueuedWorkspaceCommand::Restore) {
                trash_entry(
                    &state.pgn_path_authority,
                    &state.workspace_mutation,
                    &workspace,
                    &source,
                    &CancellationToken::new(),
                )
                .expect("prepare trashed entry");
            }
            let mutation = Arc::clone(&state.workspace_mutation);
            let mut held = HeldWorkspaceMutation::new(Arc::clone(&mutation));
            let waiting = crate::infra::cancellable_lock::observe_std_lock_wait(mutation.as_ref());
            let app = tauri::test::mock_app();
            app.manage(state);
            let command_app = app.handle().clone();
            let command_workspace = workspace.clone();
            let command_source = source.clone();
            let command_destination = destination.clone();
            let caller = tokio::spawn(async move {
                let state = command_app.state::<AppState>();
                match command {
                    QueuedWorkspaceCommand::CreateFile => create_workspace_file(
                        command_workspace.clone(),
                        command_workspace,
                        "created.pgn".into(),
                        WorkspaceMetadata::default(),
                        WorkspaceFileContent::Text {
                            pgn: "1. d4 *".into(),
                        },
                        state,
                    )
                    .await
                    .map(|_| ()),
                    QueuedWorkspaceCommand::CreateDirectory => create_workspace_directory(
                        command_workspace.clone(),
                        command_workspace,
                        "created".into(),
                        state,
                    )
                    .await
                    .map(|_| ()),
                    QueuedWorkspaceCommand::Move => {
                        move_workspace_entry(
                            command_workspace,
                            command_source.clone(),
                            command_destination,
                            state,
                        )
                        .await
                    }
                    QueuedWorkspaceCommand::Rename => {
                        rename_workspace_file(
                            command_workspace,
                            command_source.clone(),
                            "renamed.pgn".into(),
                            WorkspaceMetadata::default(),
                            state,
                        )
                        .await
                    }
                    QueuedWorkspaceCommand::WriteMetadata => {
                        write_workspace_file_metadata(
                            command_workspace,
                            command_source.clone(),
                            WorkspaceMetadata::default(),
                            state,
                        )
                        .await
                    }
                    QueuedWorkspaceCommand::Trash => {
                        trash_workspace_entry(command_workspace, command_source.clone(), state)
                            .await
                    }
                    QueuedWorkspaceCommand::Restore => {
                        restore_workspace_entry(command_workspace, command_source.clone(), state)
                            .await
                    }
                    QueuedWorkspaceCommand::PermanentlyDelete => {
                        permanently_delete_workspace_entry(
                            command_workspace,
                            command_source.clone(),
                            state,
                        )
                        .await
                    }
                }
            });
            waiting
                .recv_timeout(Duration::from_secs(5))
                .expect("command must contend on the exact held mutation lock");
            caller.abort();
            let _ = caller.await;
            held.release();
            let operations = app.state::<AppState>().operations.clone();
            let drained = tokio::task::spawn_blocking(move || {
                operations.wait_for_drain(Duration::from_secs(5)).unwrap()
            })
            .await
            .expect("join drain");
            assert!(drained, "{command:?} must retain its accepted owner");
            let state = app.state::<AppState>();
            match command {
                QueuedWorkspaceCommand::CreateFile => {
                    assert_eq!(
                        fs::read_to_string(root.join("created.pgn")).unwrap(),
                        "1. d4 *"
                    );
                    assert!(root.join("created.info").is_file());
                }
                QueuedWorkspaceCommand::CreateDirectory => {
                    assert!(root.join("created").is_dir());
                }
                QueuedWorkspaceCommand::Move => {
                    assert!(!source_path.exists());
                    assert!(destination_path.join("source.pgn").is_file());
                    assert_eq!(
                        mutation_target(&state.pgn_path_authority, &source)
                            .expect("moved authority")
                            .path(),
                        destination_path.join("source.pgn")
                    );
                }
                QueuedWorkspaceCommand::Rename => {
                    assert!(!source_path.exists());
                    assert!(root.join("renamed.pgn").is_file());
                    assert!(root.join("renamed.info").is_file());
                    assert_eq!(
                        mutation_target(&state.pgn_path_authority, &source)
                            .expect("renamed authority")
                            .path(),
                        root.join("renamed.pgn")
                    );
                }
                QueuedWorkspaceCommand::WriteMetadata => {
                    assert!(source_path.is_file());
                    assert!(root.join("source.info").is_file());
                    assert_eq!(
                        mutation_target(&state.pgn_path_authority, &source)
                            .expect("metadata authority")
                            .path(),
                        source_path
                    );
                }
                QueuedWorkspaceCommand::Trash => {
                    assert!(!source_path.exists());
                    let target = mutation_target(&state.pgn_path_authority, &source)
                        .expect("trash authority");
                    assert!(target.path().is_file());
                    assert!(target.path().starts_with(root.join(TRASH_DIRECTORY)));
                }
                QueuedWorkspaceCommand::Restore => {
                    assert!(source_path.is_file());
                    assert_eq!(
                        mutation_target(&state.pgn_path_authority, &source)
                            .expect("restored authority")
                            .path(),
                        source_path
                    );
                }
                QueuedWorkspaceCommand::PermanentlyDelete => {
                    assert!(!source_path.exists());
                    assert!(mutation_target(&state.pgn_path_authority, &source).is_err());
                }
            }
        }
    }

    #[tokio::test]
    async fn test_map_picker_join_panic_is_not_cancellation() {
        let error = tokio::task::spawn_blocking(|| panic!("folder picker panic"))
            .await
            .expect_err("panicking folder picker must return a join error");
        assert!(matches!(
            map_picker_join(error),
            Error::InvalidInput(message) if message == "native picker task failed"
        ));
    }

    #[tokio::test]
    async fn test_map_picker_join_cancelled() {
        let handle = tokio::spawn(std::future::pending::<()>());
        handle.abort();
        let error = handle
            .await
            .expect_err("an aborted task must return a join error");
        assert!(error.is_cancelled());
        assert!(matches!(map_picker_join(error), Error::Cancellation));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn production_workspace_file_tail_finishes_after_command_caller_drop() {
        let (directory, state, workspace) = workspace_state();
        let listed_workspace = workspace.clone();
        let (hook, entered, release) = crate::pgn::BoundedHook::new();
        state.pgn_repository.set_count_hook(Some(hook)).unwrap();
        let app = tauri::test::mock_app();
        app.manage(state);
        let handle = app.handle().clone();
        let caller = tokio::spawn(async move {
            let state = handle.state::<AppState>();
            create_workspace_file(
                workspace.clone(),
                workspace,
                "completed.pgn".into(),
                WorkspaceMetadata::default(),
                WorkspaceFileContent::Text {
                    pgn: "1. e4 *".into(),
                },
                state,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(1), entered)
            .await
            .unwrap()
            .unwrap();
        caller.abort();
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while !app
                .state::<AppState>()
                .operations
                .outstanding_labels()
                .unwrap()
                .is_empty()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let state = app.state::<AppState>();
        assert_eq!(
            fs::read_to_string(directory.path().join("workspace/completed.pgn")).unwrap(),
            "1. e4 *"
        );
        assert!(directory.path().join("workspace/completed.info").is_file());
        assert!(registry_has_display_name(&directory, "completed.pgn"));
        let (entries, _) = collect_tree_entries(
            &state.pgn_path_authority,
            &listed_workspace,
            &CancellationToken::new(),
        )
        .expect("list completed create");
        let created = entries
            .entries
            .iter()
            .find(|entry| entry.name == "completed")
            .expect("created entry is registered");
        let resolved = resolve_created_pgn(&state, &created.handle);
        let count =
            pgn::count_pgn_games_core(resolved, &CancellationToken::new(), &state.pgn_repository)
                .await
                .expect("count completed create");
        assert_eq!(count, 1);
    }

    /// Grants and promotes `selected` as a persistent PGN workspace in a fresh authority whose
    /// registry lives in `directory`.
    fn promoted_workspace_state(
        directory: &TempDir,
        selected: &Path,
        uses_left: u32,
    ) -> (AppState, FileWorkspaceHandle) {
        let mut path_authority =
            PathAuthority::open(directory.path().join("registry.json"), vec![]).expect("authority");
        let grant = path_authority
            .grant_dialog_operations(
                selected,
                "Workspace",
                PathClass::BoundedDialogGrant,
                vec![PathOperation::ReadPgn, PathOperation::WritePgn],
                Duration::from_secs(60),
                uses_left,
            )
            .expect("workspace grant");
        let workspace = FileWorkspaceHandle::new(
            path_authority
                .promote_dialog(
                    &grant,
                    PathClass::PersistentCustomRoot,
                    "Workspace",
                    vec![PathOperation::ReadPgn, PathOperation::WritePgn],
                )
                .expect("persistent workspace")
                .id,
        );
        let state = AppState::default();
        state
            .pgn_path_authority
            .install(path_authority)
            .expect("authority lock");
        (state, workspace)
    }

    fn workspace_state() -> (TempDir, AppState, FileWorkspaceHandle) {
        let directory = tempfile::tempdir().expect("temporary workspace parent");
        let root = directory.path().join("workspace");
        fs::create_dir(&root).expect("workspace root");
        let (state, workspace) = promoted_workspace_state(&directory, &root, 4);
        (directory, state, workspace)
    }

    fn enumerated_workspace_entry(root: &Path, leaf: &str) -> DirectoryEntry {
        let parent =
            crate::infra::fs::open_parent_no_follow(&root.join(leaf)).expect("enumeration parent");
        crate::infra::fs::enumerated_directory_entry_for_test(&parent, OsStr::new(leaf))
    }

    fn set_directory_modified(path: &Path, modified: std::time::SystemTime) {
        #[cfg(unix)]
        let directory = fs::File::open(path).expect("directory descriptor");
        #[cfg(windows)]
        let directory = crate::infra::fs::windows_test_parent(path);
        directory.set_modified(modified).expect("directory mtime");
    }

    fn create_test_workspace_entry(
        state: &AppState,
        workspace: &FileWorkspaceHandle,
        is_dir: bool,
    ) -> Result<WorkspaceEntry, Error> {
        if is_dir {
            create_named_directory(state, workspace, "created")
        } else {
            create_workspace_file_blocking(
                workspace.clone(),
                workspace.clone(),
                "created".into(),
                WorkspaceMetadata::default(),
                WorkspaceFileContent::Text { pgn: "*".into() },
                &state.pgn_path_authority,
                &state.workspace_mutation,
                &state.pgn_repository,
                &CancellationToken::new(),
            )
        }
    }

    fn registry_display_names(directory: &TempDir) -> Vec<String> {
        let json: serde_json::Value = serde_json::from_slice(
            &fs::read(directory.path().join("registry.json")).expect("read workspace registry"),
        )
        .expect("parse workspace registry");
        json["entries"]
            .as_array()
            .expect("registry entries")
            .iter()
            .filter_map(|entry| entry["display_name"].as_str().map(str::to_string))
            .collect()
    }

    fn registry_has_display_name(directory: &TempDir, name: &str) -> bool {
        registry_display_names(directory)
            .iter()
            .any(|entry| entry == name)
    }

    fn create_named_text(
        state: &AppState,
        workspace: &FileWorkspaceHandle,
        name: &str,
        pgn: &str,
    ) -> Result<WorkspaceEntry, Error> {
        create_workspace_file_blocking(
            workspace.clone(),
            workspace.clone(),
            name.into(),
            WorkspaceMetadata::default(),
            WorkspaceFileContent::Text { pgn: pgn.into() },
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &state.pgn_repository,
            &CancellationToken::new(),
        )
    }

    fn create_named_directory(
        state: &AppState,
        workspace: &FileWorkspaceHandle,
        name: &str,
    ) -> Result<WorkspaceEntry, Error> {
        create_workspace_directory_inner(
            workspace.clone(),
            workspace.clone(),
            name.into(),
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &CancellationToken::new(),
        )
    }

    fn resolve_created_pgn(
        state: &AppState,
        handle: &FileWorkspaceHandle,
    ) -> crate::infra::path_authority::ResolvedPath {
        state
            .pgn_path_authority
            .raw_for_test()
            .lock()
            .expect("authority lock")
            .as_mut()
            .expect("authority")
            .resolve(handle.path_ref(), PathOperation::ReadPgn, &[])
            .expect("resolve created PGN")
    }

    async fn assert_count_is_cache_hit(
        state: &AppState,
        handle: &FileWorkspaceHandle,
        expected: i32,
    ) {
        let resolved = resolve_created_pgn(state, handle);
        let (hook, mut entered, _release) = pgn::BoundedHook::new();
        state
            .pgn_repository
            .set_scan_line_hook(Some(hook))
            .expect("set scan-line hook");
        let count =
            pgn::count_pgn_games_core(resolved, &CancellationToken::new(), &state.pgn_repository)
                .await
                .expect("count after create");
        state
            .pgn_repository
            .set_scan_line_hook(None)
            .expect("clear scan-line hook");
        assert_eq!(count, expected);
        assert!(
            entered.try_recv().is_err(),
            "follow-up count must be a repository cache hit"
        );
    }

    /// Counting injector for one atomic-file fault point.
    ///
    /// `index` is the 0-based hit count of `point` only. On a workspace file create, Rename
    /// and ParentSync each hit 0 = PGN install, 1 = sidecar install, 2 = registry persist.
    /// On a directory create, Rename hit 0 = registry persist; ParentSync hits 0 = directory
    /// create, 1 = registry persist. On a same-parent file rename, Rename hits
    /// 0 = sidecar rewrite, 1 = registry rebind. ParentSync hits 0 = primary rename,
    /// 1 = sidecar rename, 2 = sidecar rewrite, 3 = registry rebind.
    /// A failed registry persistence attempt is retried, adding hits for the points it reaches.
    struct FailAtFaultPoint {
        point: AtomicFileFaultPoint,
        index: usize,
        only: bool,
        seen: AtomicUsize,
    }

    impl FailAtFaultPoint {
        fn fail_from(point: AtomicFileFaultPoint, skip: usize) -> Self {
            Self {
                point,
                index: skip,
                only: false,
                seen: AtomicUsize::new(0),
            }
        }

        fn fail_only(point: AtomicFileFaultPoint, index: usize) -> Self {
            Self {
                point,
                index,
                only: true,
                seen: AtomicUsize::new(0),
            }
        }

        fn and(self, other: Self) -> FailAtFaultPoints {
            FailAtFaultPoints {
                first: self,
                second: other,
            }
        }
    }

    impl AtomicWriterInjector for FailAtFaultPoint {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point != self.point {
                return Ok(());
            }
            let hit = self.seen.fetch_add(1, Ordering::SeqCst);
            let fail = if self.only {
                hit == self.index
            } else {
                hit >= self.index
            };
            if fail {
                Err(std::io::Error::other("injected atomic-file fault"))
            } else {
                Ok(())
            }
        }
    }

    struct FailAtFaultPoints {
        first: FailAtFaultPoint,
        second: FailAtFaultPoint,
    }

    impl AtomicWriterInjector for FailAtFaultPoints {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            self.first.inject(point)?;
            self.second.inject(point)
        }
    }

    #[test]
    fn workspace_create_responses_preserve_pre_epoch_seconds() {
        let old = std::time::SystemTime::UNIX_EPOCH - Duration::from_secs(1);
        for is_dir in [false, true] {
            let (_directory, state, workspace) = workspace_state();
            let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
            let leaf = if is_dir { "created" } else { "created.pgn" };
            if is_dir {
                let target = root.join(leaf);
                WORKSPACE_CREATED_DIRECTORY_PRE_OBSERVE_HOOK.with(|slot| {
                    *slot.borrow_mut() =
                        Some(Box::new(move || set_directory_modified(&target, old)));
                });
            } else {
                WORKSPACE_CREATED_FILE_POST_WRITE_HOOK.with(|slot| {
                    *slot.borrow_mut() = Some(Box::new(move |file| {
                        file.set_modified(old).map_err(Error::from)
                    }));
                });
            }
            let result = create_test_workspace_entry(&state, &workspace, is_dir);
            WORKSPACE_CREATED_DIRECTORY_PRE_OBSERVE_HOOK.with(|slot| slot.borrow_mut().take());
            WORKSPACE_CREATED_FILE_POST_WRITE_HOOK.with(|slot| slot.borrow_mut().take());
            let created = result.expect("pre-epoch create response");
            assert!(created.last_modified < 0);
            if !is_dir {
                assert_eq!(created.game_count, Some(1));
            }
            assert_eq!(
                created.last_modified,
                enumerated_workspace_entry(&root, leaf).modified_seconds
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_directory_create_seconds_equal_enumeration() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        let created = create_test_workspace_entry(&state, &workspace, true).expect("create");
        assert_eq!(
            created.last_modified,
            enumerated_workspace_entry(&root, "created").modified_seconds
        );
    }

    #[cfg(unix)]
    fn swap_created_entry(root: &Path, leaf: &str, is_dir: bool) -> DirectoryEntry {
        let installed = enumerated_workspace_entry(root, leaf);
        let target = root.join(leaf);
        fs::rename(&target, root.join("saved")).expect("save installed object");
        let replacement_time = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(777);
        if is_dir {
            fs::create_dir(&target).expect("replacement directory");
            set_directory_modified(&target, replacement_time);
        } else {
            fs::write(&target, b"replacement").expect("replacement file");
            fs::File::options()
                .write(true)
                .open(&target)
                .expect("replacement descriptor")
                .set_modified(replacement_time)
                .expect("replacement mtime");
        }
        installed
    }

    #[cfg(unix)]
    #[test]
    fn workspace_create_seconds_survive_the_pre_registration_swap() {
        for is_dir in [false, true] {
            let (_directory, state, workspace) = workspace_state();
            let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
            let leaf = if is_dir { "created" } else { "created.pgn" };
            let observed = Arc::new(StdMutex::new(None));
            let observed_in_hook = Arc::clone(&observed);
            let root_in_hook = root.clone();
            set_workspace_created_child_pre_register_hook(Some(Box::new(move || {
                *observed_in_hook.lock().expect("observed") =
                    Some(swap_created_entry(&root_in_hook, leaf, is_dir));
            })));
            let result = create_test_workspace_entry(&state, &workspace, is_dir);
            set_workspace_created_child_pre_register_hook(None);
            let created = result.expect("create response after swap");
            let installed = observed.lock().expect("observed").take().expect("hook ran");
            assert_eq!(created.last_modified, installed.modified_seconds);
            assert_ne!(
                created.last_modified,
                enumerated_workspace_entry(&root, leaf).modified_seconds
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn directory_create_identity_and_seconds_share_the_pre_swap_stat() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        let observed = Arc::new(StdMutex::new(None));
        let observed_in_hook = Arc::clone(&observed);
        let root_in_hook = root.clone();
        crate::infra::fs::set_entry_observation_post_stat_hook(Some(Box::new(move || {
            *observed_in_hook.lock().expect("observed") =
                Some(swap_created_entry(&root_in_hook, "created", true));
        })));
        let result = create_test_workspace_entry(&state, &workspace, true);
        crate::infra::fs::set_entry_observation_post_stat_hook(None);
        let created = result.expect("create response after observation swap");
        let installed = observed.lock().expect("observed").take().expect("hook ran");
        let replacement = enumerated_workspace_entry(&root, "created");
        assert_eq!(created.last_modified, installed.modified_seconds);
        assert_ne!(created.last_modified, replacement.modified_seconds);
        let registered = state
            .pgn_path_authority
            .raw_for_test()
            .lock()
            .expect("authority lock")
            .as_ref()
            .expect("authority")
            .persistent_snapshot_for_test();
        assert!(registered
            .iter()
            .any(|(name, identity, is_dir)| name == "created"
                && *identity == installed.identity
                && *is_dir));
        assert_ne!(installed.identity, replacement.identity);
    }

    #[cfg(unix)]
    fn symlinked_ancestor_workspace_state() -> (TempDir, PathBuf, AppState, FileWorkspaceHandle) {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("temporary workspace parent");
        let real = directory.path().join("real");
        let link = directory.path().join("link");
        let root = real.join("ws");
        fs::create_dir_all(&root).expect("workspace root");
        symlink(&real, &link).expect("workspace ancestor symlink");
        let (state, workspace) = promoted_workspace_state(&directory, &link.join("ws"), 1);
        (directory, root, state, workspace)
    }

    #[cfg(unix)]
    #[test]
    fn workspace_selected_through_symlinked_ancestor_accepts_a_real_write() {
        let (_directory, root, state, workspace) = symlinked_ancestor_workspace_state();

        create_workspace_file_blocking(
            workspace.clone(),
            workspace,
            "game.pgn".into(),
            WorkspaceMetadata::default(),
            WorkspaceFileContent::Text {
                pgn: "1. e4 *".into(),
            },
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &state.pgn_repository,
            &CancellationToken::new(),
        )
        .expect("write through the canonical workspace");
        assert_eq!(
            fs::read_to_string(root.join("game.pgn")).unwrap(),
            "1. e4 *"
        );
    }

    #[cfg(unix)]
    #[test]
    fn workspace_selected_through_symlinked_ancestor_refuses_an_ancestor_swap() {
        use std::os::unix::fs::symlink;

        let (directory, _root, state, workspace) = symlinked_ancestor_workspace_state();
        let real = directory.path().join("real");
        let moved = directory.path().join("moved");

        fs::rename(&real, &moved).expect("move real ancestor");
        symlink(&moved, &real).expect("replace real ancestor");

        let result = create_workspace_file_blocking(
            workspace.clone(),
            workspace,
            "game.pgn".into(),
            WorkspaceMetadata::default(),
            WorkspaceFileContent::Text {
                pgn: "1. e4 *".into(),
            },
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &state.pgn_repository,
            &CancellationToken::new(),
        );
        assert!(result.is_err());
        assert!(!moved.join("ws/game.pgn").exists());
    }

    fn registered_child_directory(
        state: &AppState,
        workspace: &FileWorkspaceHandle,
        name: &str,
    ) -> (PathBuf, FileWorkspaceHandle) {
        let root = mutation_target(&state.pgn_path_authority, workspace).expect("workspace target");
        let child = root.path().join(name);
        fs::create_dir(&child).expect("child directory");
        fs::write(child.join("removed"), b"content").expect("child content");
        let identity = crate::infra::fs::entry_identity_at(
            root.directory().expect("workspace directory"),
            Path::new(name).as_os_str(),
            true,
        )
        .expect("child identity");
        let entry = register_created_entry(
            &state.pgn_path_authority,
            workspace,
            &child,
            name.into(),
            identity,
            root.identity,
            true,
        )
        .expect("child handle");
        (child, entry)
    }

    #[cfg(unix)]
    fn metadata_from_path(
        pgn_path_authority: &SharedPathAuthority,
        workspace: &FileWorkspaceHandle,
        path: &Path,
    ) -> Result<WorkspaceMetadata, Error> {
        let components = workspace_components(pgn_path_authority, workspace, path)?;
        pgn_path_authority.with_mut(|authority| {
            let mut directory =
                authority.capability_directory(workspace.path_ref(), PathOperation::ReadPgn)?;
            let token = CancellationToken::new();
            for component in &components[..components.len().saturating_sub(1)] {
                let entries = directory.entries(&token, &mut |name| name == component)?;
                let entry = entries
                    .into_iter()
                    .find(|entry| entry.name == *component)
                    .ok_or_else(|| {
                        Error::Io(Box::new(std::io::Error::from(std::io::ErrorKind::NotFound)))
                    })?;
                directory = directory.open_child_directory(&entry)?;
            }
            let leaf = components
                .last()
                .ok_or_else(|| Error::InvalidInput("PGN has no filename".into()))?;
            let entry = directory
                .entries(&token, &mut |name| name == leaf)?
                .into_iter()
                .find(|entry| entry.name == *leaf)
                .ok_or_else(|| {
                    Error::Io(Box::new(std::io::Error::from(std::io::ErrorKind::NotFound)))
                })?;
            metadata_from(&directory, &entry)
        })?
    }

    /// Reads the identity from a retained, no-follow parent descriptor through
    /// `entry_identity_at` — the same call its `registered_child_directory` sibling makes —
    /// rather than through `MetadataExt::dev`/`ino`, which exist only on unix.
    fn registered_child_file(
        state: &AppState,
        workspace: &FileWorkspaceHandle,
        path: &Path,
    ) -> FileWorkspaceHandle {
        let parent = crate::infra::fs::open_parent_no_follow(path).expect("retained file parent");
        let identity = crate::infra::fs::entry_identity_at(
            &parent,
            path.file_name().expect("file leaf"),
            false,
        )
        .expect("file identity");
        let components = workspace_components(&state.pgn_path_authority, workspace, path)
            .expect("workspace components");
        state
            .pgn_path_authority
            .raw_for_test()
            .lock()
            .expect("authority lock")
            .as_mut()
            .expect("authority")
            .register_workspace_child_observed(
                workspace,
                &components,
                path.file_stem()
                    .expect("file stem")
                    .to_string_lossy()
                    .into_owned(),
                identity,
                false,
                PathOperation::ReadPgn,
            )
            .expect("registered file")
    }

    fn registered_engine_file(state: &AppState, path: &Path) -> PathRef {
        state
            .pgn_path_authority
            .raw_for_test()
            .lock()
            .expect("authority lock")
            .as_mut()
            .expect("authority")
            .register_engine_file(path, "engine")
            .expect("registered engine")
            .id
    }

    fn registered_engine_directory(
        state: &AppState,
        workspace: &FileWorkspaceHandle,
    ) -> (PathBuf, FileWorkspaceHandle, PathRef) {
        let (child, entry) = registered_child_directory(state, workspace, "victim");
        fs::remove_file(child.join("removed")).expect("remove default fixture content");
        let executable_path = child.join("engine");
        fs::write(&executable_path, b"engine").expect("engine executable");
        let executable = registered_engine_file(state, &executable_path);
        (child, entry, executable)
    }

    async fn supervise_test_actor(
        state: &AppState,
        key: &EngineKey,
        engine_id: &str,
        executable: PathRef,
        actor: Arc<crate::engine::EngineActor>,
    ) {
        state
            .engine_supervisor
            .replace_handle(key.clone(), actor, engine_id.into(), executable)
            .await
            .expect("registered supervised engine");
    }

    async fn assert_executable_retired(state: &AppState, executable: PathRef) {
        let (actor, _) = crate::engine::EngineActor::recording_test_actor(&[]);
        assert!(matches!(
            state
                .engine_supervisor
                .replace_handle(
                    EngineKey::new("tab".into(), "retired path".into()).expect("engine key"),
                    actor,
                    "different-application-engine".into(),
                    executable,
                )
                .await,
            Err(Error::Conflict(message)) if message == "engine executable is retired"
        ));
    }

    #[cfg(unix)]
    async fn supervise_test_engine(
        state: &AppState,
        key: &EngineKey,
        engine_id: &str,
        executable: PathRef,
    ) {
        let (actor, _) = crate::engine::EngineActor::recording_test_actor(&[]);
        supervise_test_actor(state, key, engine_id, executable, actor).await;
    }

    #[cfg(unix)]
    async fn delete_entry_with_fault(
        state: &AppState,
        workspace: &FileWorkspaceHandle,
        entry: &FileWorkspaceHandle,
        point: RemovalFaultPoint,
    ) -> Result<(), Error> {
        set_test_removal_injector(Some(Arc::new(RemovalFault(point))));
        let result = permanently_delete_entry(
            state,
            workspace,
            entry,
            tokio_util::sync::CancellationToken::new(),
        )
        .await;
        set_test_removal_injector(None);
        result
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn committed_delete_removes_authority_record_when_parent_sync_fails() {
        let (_directory, state, workspace) = workspace_state();
        let (child, entry) = registered_child_directory(&state, &workspace, "victim");
        let descendant = child.join("descendant.pgn");
        fs::write(&descendant, b"*").expect("descendant");
        let descendant_entry = registered_child_file(&state, &workspace, &descendant);

        let error =
            delete_entry_with_fault(&state, &workspace, &entry, RemovalFaultPoint::ParentSync)
                .await
                .expect_err("parent sync failure must preserve commit status");

        assert!(matches!(error, Error::CommittedDurabilityUncertain(_)));
        assert!(!child.exists(), "the directory was completely removed");
        assert!(matches!(
            mutation_target(&state.pgn_path_authority, &entry),
            Err(Error::InvalidInput(message)) if message == "workspace entry is not persistent"
        ));
        assert!(matches!(
            mutation_target(&state.pgn_path_authority, &descendant_entry),
            Err(Error::InvalidInput(message)) if message == "workspace entry is not persistent"
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn partial_delete_keeps_authority_record() {
        let (_directory, state, workspace) = workspace_state();
        let (child, entry) = registered_child_directory(&state, &workspace, "victim");
        let survivor = child.join("survivor.pgn");
        fs::write(&survivor, b"*").expect("survivor");
        let removed_entry = registered_child_file(&state, &workspace, &child.join("removed"));
        let survivor_entry = registered_child_file(&state, &workspace, &survivor);

        let error = delete_entry_with_fault(
            &state,
            &workspace,
            &entry,
            RemovalFaultPoint::AfterEntryRemoved,
        )
        .await
        .expect_err("post-removal failure must be reported");

        assert!(matches!(error, Error::PartialRemoval { .. }));
        assert!(child.exists(), "the top directory remains");
        mutation_target(&state.pgn_path_authority, &entry).expect("authority record remains");
        for (path, handle) in [
            (child.join("removed"), removed_entry),
            (survivor, survivor_entry),
        ] {
            if path.exists() {
                mutation_target(&state.pgn_path_authority, &handle)
                    .expect("surviving descendant remains registered");
            } else {
                assert!(matches!(
                    mutation_target(&state.pgn_path_authority, &handle),
                    Err(Error::InvalidInput(message))
                        if message == "workspace entry is not persistent"
                ));
            }
        }
    }

    struct RegistryWriteFailure;

    impl AtomicWriterInjector for RegistryWriteFailure {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == AtomicFileFaultPoint::Write {
                Err(std::io::Error::other(
                    r"/private/registry C:\private\registry: injected write failure",
                ))
            } else {
                Ok(())
            }
        }
    }

    #[tokio::test]
    async fn registry_failure_after_unlink_is_applied_despite_error_and_keeps_persisted_state() {
        let (_directory, state, workspace) = workspace_state();
        let (child, entry) = registered_child_directory(&state, &workspace, "victim");
        fs::create_dir(child.join("unregistered")).expect("unregistered directory");
        fs::write(child.join("unregistered/extra"), b"extra").expect("unregistered file");
        set_test_atomic_file_injector(Some(Arc::new(RegistryWriteFailure)));
        let error = permanently_delete_entry(
            &state,
            &workspace,
            &entry,
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .expect_err("registry failure after unlink must be applied-despite-error");
        set_test_atomic_file_injector(None);

        assert!(!child.exists());
        assert!(matches!(
            &error,
            Error::PartialRemoval { removed_entries: 4, cause }
                if matches!(cause.as_ref(), Error::Io(_))
                    && cause.diagnostic().contains("injected write failure")
        ));
        assert!(
            mutation_target(&state.pgn_path_authority, &entry).is_err(),
            "deleted object is retained as unavailable"
        );
        assert!(state
            .pgn_path_authority
            .raw_for_test()
            .lock()
            .expect("authority lock")
            .as_mut()
            .expect("authority")
            .descriptors()
            .iter()
            .any(|descriptor| descriptor.id == *entry.path_ref()));
        let serialized = serde_json::to_string(&error).expect("serialize registry failure");
        let payload: serde_json::Value =
            serde_json::from_str(&serialized).expect("serialized error is a JSON object");
        assert_eq!(payload["category"], "partial-removal");
        assert!(payload["message"]
            .as_str()
            .expect("message")
            .starts_with("Partially removed: 4 entries"));
        assert!(!serialized.contains("/private/registry"));
        assert!(!serialized.contains(r"C:\private\registry"));
    }

    #[tokio::test]
    async fn sidecar_failure_after_unlink_still_removes_authority_record() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("workspace root");
        let file = root.join("victim.pgn");
        fs::write(&file, b"*").expect("victim file");
        let entry = registered_child_file(&state, &workspace, &file);
        fs::create_dir(root.join("victim.info")).expect("invalid sidecar directory");

        let error = permanently_delete_entry(
            &state,
            &workspace,
            &entry,
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .expect_err("sidecar cleanup failure must be applied-despite-error");

        assert!(!file.exists());
        assert!(matches!(
            &error,
            Error::PartialRemoval { removed_entries: 1, cause }
                if matches!(cause.as_ref(), Error::InvalidInput(_) | Error::Io(_))
        ));
        assert!(matches!(
            mutation_target(&state.pgn_path_authority, &entry),
            Err(Error::InvalidInput(message)) if message == "workspace entry is not persistent"
        ));
        let serialized = serde_json::to_string(&error).expect("serialize sidecar failure");
        let payload: serde_json::Value =
            serde_json::from_str(&serialized).expect("serialized error is a JSON object");
        assert_eq!(payload["category"], "partial-removal");
        assert!(payload["message"]
            .as_str()
            .expect("message")
            .starts_with("Partially removed: 1 entries"));
        assert!(root.join("victim.info").is_dir());
        assert!(!serialized.contains(&root.to_string_lossy().to_string()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn partial_removal_wins_over_registry_reconciliation_failure() {
        let (_directory, state, workspace) = workspace_state();
        let (child, entry) = registered_child_directory(&state, &workspace, "victim");
        let removed_entry = registered_child_file(&state, &workspace, &child.join("removed"));
        set_test_atomic_file_injector(Some(Arc::new(RegistryWriteFailure)));
        let error = delete_entry_with_fault(
            &state,
            &workspace,
            &entry,
            RemovalFaultPoint::AfterEntryRemoved,
        )
        .await
        .expect_err("partial removal must remain the primary outcome");
        set_test_atomic_file_injector(None);

        assert!(matches!(error, Error::PartialRemoval { .. }));
        mutation_target(&state.pgn_path_authority, &entry)
            .expect("top record remains after partial removal");
        assert!(
            mutation_target(&state.pgn_path_authority, &removed_entry).is_err(),
            "failed registry save retains removed descendant as unavailable"
        );
        assert!(state
            .pgn_path_authority
            .raw_for_test()
            .lock()
            .expect("authority lock")
            .as_mut()
            .expect("authority")
            .descriptors()
            .iter()
            .any(|descriptor| descriptor.id == *removed_entry.path_ref()));
        let serialized = serde_json::to_string(&error).expect("serialize partial removal");
        let payload: serde_json::Value =
            serde_json::from_str(&serialized).expect("serialized error is a JSON object");
        assert_eq!(payload["category"], "partial-removal");
        assert!(payload["message"]
            .as_str()
            .expect("message")
            .starts_with("Partially removed:"));
        assert!(!serialized.contains("/private/registry"));
        assert!(!serialized.contains(r"C:\private\registry"));
    }

    #[tokio::test]
    async fn sidecar_failure_wins_over_registry_failure_or_uncertainty() {
        for uncertain in [false, true] {
            let (_directory, state, workspace) = workspace_state();
            let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
            let file = root.join("victim.pgn");
            fs::write(&file, b"*").expect("file");
            let entry = registered_child_file(&state, &workspace, &file);
            fs::create_dir(root.join("victim.info")).expect("invalid sidecar");
            let injector: Arc<dyn AtomicWriterInjector + Send + Sync> = if uncertain {
                Arc::new(crate::infra::fs::ParentSyncFault(
                    "later registry uncertainty",
                ))
            } else {
                Arc::new(RegistryWriteFailure)
            };
            set_test_atomic_file_injector(Some(injector));
            let result =
                permanently_delete_entry(&state, &workspace, &entry, CancellationToken::new())
                    .await;
            set_test_atomic_file_injector(None);
            let error = result.expect_err("sidecar failure must remain first");
            assert!(
                matches!(&error, Error::PartialRemoval { removed_entries: 1, cause }
                if matches!(cause.as_ref(), Error::InvalidInput(_) | Error::Io(_))
                    && !cause.diagnostic().contains("registry"))
            );
            assert!(!file.exists());
            assert!(root.join("victim.info").is_dir());
            assert!(mutation_target(&state.pgn_path_authority, &entry).is_err());
        }
    }

    #[test]
    fn completed_file_count_excludes_cleaned_sidecar() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        let file = root.join("victim.pgn");
        fs::write(&file, b"*").expect("file");
        let entry = registered_child_file(&state, &workspace, &file);
        fs::write(root.join("victim.info"), b"{}").expect("sidecar");
        let (dropped, result) = permanently_delete_entry_blocking(
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &workspace,
            &entry,
            &CancellationToken::new(),
        );
        let (count, failure) = result.expect("completed removal").into_parts();
        assert_eq!(count, 1);
        assert!(failure.is_none());
        assert!(dropped.is_empty());
        assert!(!file.exists());
        assert!(!root.join("victim.info").exists());
        assert!(mutation_target(&state.pgn_path_authority, &entry).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn removal_sync_uncertainty_wins_over_registry_and_retirement_failures() {
        let (_directory, state, workspace) = workspace_state();
        let (child, entry, executable) = registered_engine_directory(&state, &workspace);
        supervise_test_actor(
            &state,
            &EngineKey::new("tab".into(), "operation".into()).expect("key"),
            "application-engine",
            executable.clone(),
            crate::engine::EngineActor::failing_terminate_test_actor("later retirement failure"),
        )
        .await;
        set_test_atomic_file_injector(Some(Arc::new(RegistryWriteFailure)));
        let result =
            delete_entry_with_fault(&state, &workspace, &entry, RemovalFaultPoint::ParentSync)
                .await;
        set_test_atomic_file_injector(None);
        assert!(matches!(
            result,
            Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::WorkspaceRemoval
            ))
        ));
        assert!(!child.exists());
        assert!(mutation_target(&state.pgn_path_authority, &entry).is_err());
        assert_executable_retired(&state, executable).await;
    }

    #[tokio::test]
    async fn retirement_failure_after_committed_delete_is_partial_removal() {
        let (_directory, state, workspace) = workspace_state();
        let (child, entry, executable) = registered_engine_directory(&state, &workspace);
        fs::create_dir(child.join("unregistered")).expect("unregistered directory");
        fs::write(child.join("unregistered/extra"), b"extra").expect("unregistered file");
        supervise_test_actor(
            &state,
            &EngineKey::new("tab".into(), "operation".into()).expect("engine key"),
            "application-engine",
            executable.clone(),
            crate::engine::EngineActor::failing_terminate_test_actor("retirement failure"),
        )
        .await;

        let error = permanently_delete_entry(&state, &workspace, &entry, CancellationToken::new())
            .await
            .expect_err("retirement failure after committed delete must be reported");

        assert_eq!(
            error.category(),
            crate::error::ErrorCategory::PartialRemoval
        );
        let Error::PartialRemoval {
            removed_entries,
            cause,
        } = error
        else {
            panic!("expected partial removal");
        };
        assert_eq!(removed_entries, 4);
        assert_eq!(cause.category(), crate::error::ErrorCategory::Io);
        assert!(cause.diagnostic().contains("retirement failure"));
        assert!(!child.join("engine").exists());
        assert!(!child.exists());
        assert_executable_retired(&state, executable).await;
    }

    #[tokio::test]
    async fn registry_sync_uncertainty_survives_retirement_failure() {
        let (_directory, state, workspace) = workspace_state();
        let (child, entry, executable) = registered_engine_directory(&state, &workspace);
        supervise_test_actor(
            &state,
            &EngineKey::new("tab".into(), "operation".into()).expect("key"),
            "application-engine",
            executable.clone(),
            crate::engine::EngineActor::failing_terminate_test_actor("later retirement failure"),
        )
        .await;
        set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
            "registry uncertainty",
        ))));
        let result =
            permanently_delete_entry(&state, &workspace, &entry, CancellationToken::new()).await;
        set_test_atomic_file_injector(None);
        assert!(matches!(
            result,
            Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::RegistryReplacement
            ))
        ));
        assert!(!child.exists());
        assert!(mutation_target(&state.pgn_path_authority, &entry).is_err());
        assert_executable_retired(&state, executable).await;
    }

    #[tokio::test]
    async fn registry_and_retirement_failure_keeps_first_typed_cause() {
        let (_directory, state, workspace) = workspace_state();
        let (child, entry, executable) = registered_engine_directory(&state, &workspace);
        supervise_test_actor(
            &state,
            &EngineKey::new("tab".into(), "operation".into()).expect("engine key"),
            "application-engine",
            executable.clone(),
            crate::engine::EngineActor::failing_terminate_test_actor("retirement failure"),
        )
        .await;
        set_test_atomic_file_injector(Some(Arc::new(RegistryWriteFailure)));
        let result =
            permanently_delete_entry(&state, &workspace, &entry, CancellationToken::new()).await;
        set_test_atomic_file_injector(None);

        let error = result.expect_err("registry failure wins over retirement");
        assert!(matches!(
            &error,
            Error::PartialRemoval { removed_entries: 2, cause }
                if cause.diagnostic().contains("injected write failure")
                    && !cause.diagnostic().contains("retirement failure")
        ));
        let serialized = serde_json::to_string(&error).expect("safe wire error");
        assert!(!serialized.contains("/private/registry"));
        assert!(!serialized.contains(r"C:\private\registry"));
        assert!(!child.exists());
        assert_executable_retired(&state, executable).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn walk_partial_removal_survives_retirement_failure() {
        let mut counts = Vec::new();
        for fail_retirement in [false, true] {
            let (_directory, state, workspace) = workspace_state();
            let (child, entry, executable) = registered_engine_directory(&state, &workspace);
            let actor = if fail_retirement {
                crate::engine::EngineActor::failing_terminate_test_actor("retirement failure")
            } else {
                crate::engine::EngineActor::recording_test_actor(&[]).0
            };
            supervise_test_actor(
                &state,
                &EngineKey::new("tab".into(), "operation".into()).expect("engine key"),
                "application-engine",
                executable.clone(),
                actor,
            )
            .await;

            let error = delete_entry_with_fault(
                &state,
                &workspace,
                &entry,
                RemovalFaultPoint::AfterEntryRemoved,
            )
            .await
            .expect_err("walk failure must remain the primary outcome");
            let Error::PartialRemoval {
                removed_entries,
                cause,
            } = error
            else {
                panic!("expected partial removal");
            };
            counts.push(removed_entries);
            assert_eq!(cause.category(), crate::error::ErrorCategory::Io);
            assert!(cause.diagnostic().contains("injected removal failure"));
            assert!(!cause.diagnostic().contains("retirement failure"));
            assert!(child.exists());
            assert!(!child.join("engine").exists());
            assert_executable_retired(&state, executable).await;
        }
        assert_eq!(counts, vec![1, 1]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn permanent_directory_delete_retires_only_its_engine_executable() {
        let (_directory, state, workspace) = workspace_state();
        let (child, entry) = registered_child_directory(&state, &workspace, "victim");
        let executable_path = child.join("engine");
        fs::write(&executable_path, b"engine").expect("engine executable");
        let executable = registered_engine_file(&state, &executable_path);
        let key = EngineKey::new("tab".into(), "operation".into()).expect("engine key");
        supervise_test_engine(&state, &key, "application-engine", executable.clone()).await;

        permanently_delete_entry(
            &state,
            &workspace,
            &entry,
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .expect("permanent delete");

        assert!(state.engine_supervisor.get_exact(&key).is_none());
        assert_executable_retired(&state, executable).await;

        let replacement_key =
            EngineKey::new("tab".into(), "replacement path".into()).expect("engine key");
        supervise_test_engine(
            &state,
            &replacement_key,
            "application-engine",
            PathRef {
                id: "replacement-executable".into(),
            },
        )
        .await;
        assert!(state
            .engine_supervisor
            .get_exact(&replacement_key)
            .is_some());
        state.engine_supervisor.terminate_all().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn production_delete_retirement_tail_survives_command_caller_drop() {
        let (_directory, state, workspace) = workspace_state();
        let (child, entry) = registered_child_directory(&state, &workspace, "dropped-caller");
        let executable_path = child.join("engine");
        fs::write(&executable_path, b"engine").unwrap();
        let executable = registered_engine_file(&state, &executable_path);
        let key = EngineKey::new("tab".into(), "caller-drop".into()).unwrap();
        supervise_test_engine(&state, &key, "application-engine", executable.clone()).await;
        let mutation = Arc::clone(&state.workspace_mutation);
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let holder = std::thread::spawn(move || {
            let _guard = mutation.lock().unwrap();
            entered_tx.send(()).unwrap();
            let _ = release_rx.recv_timeout(Duration::from_secs(5));
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        let app = tauri::test::mock_app();
        app.manage(state);
        let command_app = app.handle().clone();
        let caller = tokio::spawn(async move {
            let state = command_app.state::<AppState>();
            permanently_delete_workspace_entry(workspace, entry, state).await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while app
                .state::<AppState>()
                .operations
                .outstanding_labels()
                .unwrap()
                .is_empty()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        caller.abort();
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while !app
                .state::<AppState>()
                .operations
                .outstanding_labels()
                .unwrap()
                .is_empty()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        let state = app.state::<AppState>();
        assert!(!child.exists());
        assert!(state.engine_supervisor.get_exact(&key).is_none());
        assert_executable_retired(&state, executable).await;
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn production_delete_error_retirement_tail_survives_command_caller_drop() {
        let (directory, state, workspace) = workspace_state();
        let (child, entry) = registered_child_directory(&state, &workspace, "dropped-error");
        let executable_path = child.join("engine");
        fs::write(&executable_path, b"engine").unwrap();
        let executable = registered_engine_file(&state, &executable_path);
        let key = EngineKey::new("tab".into(), "caller-drop-error".into()).unwrap();
        supervise_test_engine(&state, &key, "application-engine", executable.clone()).await;
        let mutation = Arc::clone(&state.workspace_mutation);
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let holder = std::thread::spawn(move || {
            let _guard = mutation.lock().unwrap();
            entered_tx.send(()).unwrap();
            let _ = release_rx.recv_timeout(Duration::from_secs(5));
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        let app = tauri::test::mock_app();
        app.manage(state);
        let command_app = app.handle().clone();
        let caller = tokio::spawn(async move {
            let state = command_app.state::<AppState>();
            permanently_delete_workspace_entry(workspace, entry, state).await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while app
                .state::<AppState>()
                .operations
                .outstanding_labels()
                .unwrap()
                .is_empty()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        caller.abort();
        let registry = directory.path().join("registry.json");
        fs::remove_file(&registry).unwrap();
        fs::create_dir(&registry).unwrap();
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while !app
                .state::<AppState>()
                .operations
                .outstanding_labels()
                .unwrap()
                .is_empty()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        let state = app.state::<AppState>();
        assert!(!child.exists(), "the workspace unlink completed");
        assert!(registry.is_dir(), "the registry replacement failed");
        assert!(state.engine_supervisor.get_exact(&key).is_none());
        assert_executable_retired(&state, executable).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn trash_directory_does_not_retire_its_engine_executable() {
        let (_directory, state, workspace) = workspace_state();
        let (child, entry) = registered_child_directory(&state, &workspace, "victim");
        let executable_path = child.join("engine");
        fs::write(&executable_path, b"engine").expect("engine executable");
        let executable = registered_engine_file(&state, &executable_path);
        let key = EngineKey::new("tab".into(), "operation".into()).expect("engine key");
        supervise_test_engine(&state, &key, "application-engine", executable).await;

        trash_entry(
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &workspace,
            &entry,
            &CancellationToken::new(),
        )
        .expect("trash directory");

        assert!(state.engine_supervisor.get_exact(&key).is_some());
        state.engine_supervisor.terminate_all().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn registry_failure_after_unlink_still_retires_engine_executable() {
        let (_directory, state, workspace) = workspace_state();
        let (child, entry) = registered_child_directory(&state, &workspace, "victim");
        let executable_path = child.join("engine");
        fs::write(&executable_path, b"engine").expect("engine executable");
        let executable = registered_engine_file(&state, &executable_path);
        let key = EngineKey::new("tab".into(), "operation".into()).expect("engine key");
        supervise_test_engine(&state, &key, "application-engine", executable).await;
        set_test_atomic_file_injector(Some(Arc::new(RegistryWriteFailure)));

        let result = permanently_delete_entry(
            &state,
            &workspace,
            &entry,
            tokio_util::sync::CancellationToken::new(),
        )
        .await;
        set_test_atomic_file_injector(None);

        assert!(matches!(
            result,
            Err(Error::PartialRemoval {
                removed_entries: 3,
                ..
            })
        ));
        assert!(state.engine_supervisor.get_exact(&key).is_none());
    }

    #[test]
    fn trash_and_restore_directory_keep_descendant_records() {
        let (_directory, state, workspace) = workspace_state();
        let (child, entry) = registered_child_directory(&state, &workspace, "victim");
        let descendant = child.join("descendant.pgn");
        fs::write(&descendant, b"*").expect("descendant");
        let descendant_entry = registered_child_file(&state, &workspace, &descendant);

        trash_entry(
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &workspace,
            &entry,
            &CancellationToken::new(),
        )
        .expect("trash directory");
        mutation_target(&state.pgn_path_authority, &descendant_entry)
            .expect("descendant survives trash rebase");
        restore_entry(
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &workspace,
            &entry,
            &CancellationToken::new(),
        )
        .expect("restore directory");
        mutation_target(&state.pgn_path_authority, &descendant_entry)
            .expect("descendant survives restore rebase");
    }

    /// The trash directory is created if missing and reused when it already exists; a symlink at
    /// the trash name is refused by the no-follow open, so nothing moves through it.
    #[cfg(unix)]
    #[test]
    fn trash_directory_is_created_if_missing_reused_and_refuses_a_symlink() {
        let (directory, state, workspace) = workspace_state();
        let root = directory.path().join("workspace");
        let (_, first) = registered_child_directory(&state, &workspace, "first");
        trash_entry(
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &workspace,
            &first,
            &CancellationToken::new(),
        )
        .expect("trash creates its directory");
        assert!(root.join(TRASH_DIRECTORY).is_dir());

        let (_, second) = registered_child_directory(&state, &workspace, "second");
        trash_entry(
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &workspace,
            &second,
            &CancellationToken::new(),
        )
        .expect("trash reuses its existing directory");
        assert_eq!(fs::read_dir(root.join(TRASH_DIRECTORY)).unwrap().count(), 2);

        let outside = directory.path().join("outside");
        fs::create_dir(&outside).expect("outside directory");
        fs::rename(
            root.join(TRASH_DIRECTORY),
            directory.path().join("old-trash"),
        )
        .expect("move trash aside");
        std::os::unix::fs::symlink(&outside, root.join(TRASH_DIRECTORY)).expect("trash symlink");
        let (third_path, third) = registered_child_directory(&state, &workspace, "third");
        let error = trash_entry(
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &workspace,
            &third,
            &CancellationToken::new(),
        )
        .expect_err("a symlinked trash directory must be refused");
        assert!(matches!(error, Error::Io(_)), "{error:?}");
        assert!(third_path.is_dir());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn workspace_names_reject_paths_reserved_sidecars_and_empty_values() {
        for invalid in [
            "",
            " ",
            ".",
            "..",
            ".en-croissant-trash",
            "a/b",
            "a\\b",
            "game.info",
        ] {
            assert!(
                validate_name(invalid).is_err(),
                "{invalid:?} must not be a basename"
            );
        }
        assert_eq!(validate_name("  Study  ").unwrap(), "Study");
        assert_eq!(pgn_name("Study").unwrap(), "Study.pgn");
        assert_eq!(pgn_name("Study.PGN").unwrap(), "Study.PGN");
        // On NTFS `existing.pgn:secret` is an alternate data stream on `existing.pgn`, and
        // `pgn_name` would hand NT `existing.pgn:secret.pgn`. A colon is a legal filename byte
        // on unix, so the rejection — and this case — are Windows-only.
        #[cfg(windows)]
        {
            assert!(validate_name("existing.pgn:secret").is_err());
            assert!(pgn_name("existing.pgn:secret").is_err());
        }
        #[cfg(unix)]
        assert_eq!(
            validate_name("existing.pgn:secret").unwrap(),
            "existing.pgn:secret"
        );
    }

    #[cfg(unix)]
    #[test]
    fn metadata_sidecars_default_parse_and_reject_invalid_json() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("workspace root");
        let pgn = root.join("game.pgn");
        fs::write(&pgn, "[Event \"test\"]\n").expect("PGN");
        assert_eq!(
            metadata_from_path(&state.pgn_path_authority, &workspace, &pgn).unwrap(),
            WorkspaceMetadata::default()
        );

        let sidecar = info_path(&pgn).unwrap();
        let metadata = WorkspaceMetadata {
            file_type: WorkspaceFileType::Tournament,
            tags: vec!["rapid".into(), "training".into()],
        };
        fs::write(&sidecar, serde_json::to_vec(&metadata).unwrap()).expect("metadata");
        assert_eq!(
            metadata_from_path(&state.pgn_path_authority, &workspace, &pgn).unwrap(),
            metadata
        );

        fs::write(&sidecar, "not json").expect("invalid metadata");
        assert!(matches!(
            metadata_from_path(&state.pgn_path_authority, &workspace, &pgn),
            Err(Error::InvalidInput(_))
        ));

        fs::write(&sidecar, r#"{"type":"secret-variant-value","tags":[]}"#)
            .expect("unknown metadata variant");
        let error = metadata_from_path(&state.pgn_path_authority, &workspace, &pgn).unwrap_err();
        assert_eq!(error.to_string(), "Invalid input: invalid PGN metadata");
        assert!(!error.to_string().contains("secret-variant-value"));
        let serialized = serde_json::to_value(&error).expect("serialize metadata error");
        assert_eq!(serialized["message"], "Invalid input: invalid PGN metadata");
        assert!(!serialized.to_string().contains("secret-variant-value"));
    }

    #[cfg(unix)]
    #[test]
    fn metadata_sidecars_refuse_links_directories_and_fifos() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        let pgn = root.join("game.pgn");
        let sidecar = root.join("game.info");
        fs::write(&pgn, "*").unwrap();
        fs::write(
            root.join("target"),
            serialize_metadata(&WorkspaceMetadata::default()).unwrap(),
        )
        .unwrap();

        std::os::unix::fs::symlink("target", &sidecar).unwrap();
        assert!(metadata_from_path(&state.pgn_path_authority, &workspace, &pgn).is_err());
        fs::remove_file(&sidecar).unwrap();
        std::os::unix::fs::symlink("missing", &sidecar).unwrap();
        assert!(metadata_from_path(&state.pgn_path_authority, &workspace, &pgn).is_err());
        fs::remove_file(&sidecar).unwrap();
        fs::create_dir(&sidecar).unwrap();
        assert!(metadata_from_path(&state.pgn_path_authority, &workspace, &pgn).is_err());
        fs::remove_dir(&sidecar).unwrap();
        let status = std::process::Command::new("mkfifo")
            .arg(&sidecar)
            .status()
            .unwrap();
        assert!(status.success());
        use std::os::unix::fs::OpenOptionsExt;
        let (completed_tx, completed_rx) = std::sync::mpsc::channel();
        let fifo = sidecar.clone();
        let watchdog = std::thread::spawn(move || {
            match completed_rx.recv_timeout(Duration::from_secs(1)) {
                Ok(()) => return false,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    panic!("FIFO completion channel disconnected")
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }
            let release_started = std::time::Instant::now();
            loop {
                match fs::OpenOptions::new()
                    .write(true)
                    .custom_flags(libc::O_NONBLOCK)
                    .open(&fifo)
                {
                    Ok(mut writer) => {
                        writer
                            .write_all(&serialize_metadata(&WorkspaceMetadata::default()).unwrap())
                            .unwrap();
                        return true;
                    }
                    Err(error)
                        if error.raw_os_error() == Some(libc::ENXIO)
                            && release_started.elapsed() < Duration::from_secs(1) =>
                    {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("FIFO watchdog failed: {error}"),
                }
            }
        });
        let result = metadata_from_path(&state.pgn_path_authority, &workspace, &pgn);
        let _ = completed_tx.send(());
        let released_regression = watchdog.join().unwrap();
        assert!(result.is_err());
        assert!(!released_regression, "metadata opener blocked on the FIFO");
    }

    // APFS cannot store non-UTF-8 file names; the non-UTF-8 name is the point of this test
    #[cfg(not(target_os = "macos"))]
    #[cfg(unix)]
    #[test]
    fn metadata_sidecar_keeps_lossy_non_utf8_naming() {
        use std::os::unix::ffi::OsStringExt;
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        let leaf = std::ffi::OsString::from_vec(b"game-\xff.pgn".to_vec());
        let pgn = root.join(&leaf);
        fs::write(&pgn, "*").unwrap();
        let sidecar = root.join(sidecar_leaf(&leaf).unwrap());
        let expected = WorkspaceMetadata {
            file_type: WorkspaceFileType::Game,
            tags: vec!["non-utf8".into()],
        };
        fs::write(sidecar, serialize_metadata(&expected).unwrap()).unwrap();
        assert_eq!(
            metadata_from_path(&state.pgn_path_authority, &workspace, &pgn).unwrap(),
            expected
        );
    }

    #[cfg(unix)]
    #[test]
    fn metadata_sidecar_reads_retained_parent_and_leaf_across_replacements() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        let pgn = root.join("game.pgn");
        let sidecar = root.join("game.info");
        let trusted = WorkspaceMetadata {
            file_type: WorkspaceFileType::Game,
            tags: vec!["trusted".into()],
        };
        let attacker = WorkspaceMetadata {
            file_type: WorkspaceFileType::Puzzle,
            tags: vec!["attacker".into()],
        };
        fs::write(&pgn, "*").unwrap();
        fs::write(&sidecar, serialize_metadata(&trusted).unwrap()).unwrap();
        let old_root = directory.path().join("old-workspace");
        let replacement_root = root.clone();
        set_workspace_metadata_pre_open_hook(Some(Box::new(move || {
            fs::rename(&replacement_root, &old_root).unwrap();
            fs::create_dir(&replacement_root).unwrap();
            fs::write(replacement_root.join("game.pgn"), "*").unwrap();
            fs::write(
                replacement_root.join("game.info"),
                serialize_metadata(&attacker).unwrap(),
            )
            .unwrap();
        })));
        assert_eq!(
            metadata_from_path(&state.pgn_path_authority, &workspace, &pgn).unwrap(),
            trusted
        );
        set_workspace_metadata_pre_open_hook(None);

        let (_second_directory, second_state, second_workspace) = workspace_state();
        let second_root =
            workspace_root(&second_state.pgn_path_authority, &second_workspace).unwrap();
        let second_pgn = second_root.join("game.pgn");
        let original_sidecar = second_root.join("game.info");
        let moved_sidecar = second_root.join("original.info");
        fs::write(&second_pgn, "*").unwrap();
        fs::write(&original_sidecar, serialize_metadata(&trusted).unwrap()).unwrap();
        let replacement_sidecar = original_sidecar.clone();
        set_workspace_metadata_post_open_hook(Some(Box::new(move |_| {
            fs::rename(&replacement_sidecar, moved_sidecar).unwrap();
            fs::write(
                replacement_sidecar,
                serialize_metadata(&WorkspaceMetadata {
                    file_type: WorkspaceFileType::Puzzle,
                    tags: vec!["replacement".into()],
                })
                .unwrap(),
            )
            .unwrap();
        })));
        assert_eq!(
            metadata_from_path(
                &second_state.pgn_path_authority,
                &second_workspace,
                &second_pgn,
            )
            .unwrap(),
            trusted
        );
        set_workspace_metadata_post_open_hook(None);
    }

    #[cfg(unix)]
    #[test]
    fn metadata_sidecar_exact_limit_succeeds_and_growth_consumes_only_cap_plus_one() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        let pgn = root.join("game.pgn");
        let sidecar = root.join("game.info");
        fs::write(&pgn, "*").unwrap();
        let expected = WorkspaceMetadata::default();
        let mut exact = serialize_metadata(&expected).unwrap();
        exact.resize(MAX_WORKSPACE_METADATA_BYTES, b' ');
        fs::write(&sidecar, &exact).unwrap();
        assert_eq!(
            metadata_from_path(&state.pgn_path_authority, &workspace, &pgn).unwrap(),
            expected
        );

        fs::write(&sidecar, serialize_metadata(&expected).unwrap()).unwrap();
        let observed = Arc::new(StdMutex::new(None));
        let retained = Arc::clone(&observed);
        let growing_sidecar = sidecar.clone();
        set_workspace_metadata_post_open_hook(Some(Box::new(move |opened| {
            *retained.lock().unwrap() = Some(opened.try_clone().unwrap());
            let mut writer = fs::OpenOptions::new()
                .append(true)
                .open(growing_sidecar)
                .unwrap();
            writer
                .write_all(&vec![b' '; MAX_WORKSPACE_METADATA_BYTES + 1])
                .unwrap();
        })));
        let error = metadata_from_path(&state.pgn_path_authority, &workspace, &pgn).unwrap_err();
        set_workspace_metadata_post_open_hook(None);
        assert!(matches!(error, Error::ResourceLimit(_)));
        let mut retained = observed.lock().unwrap().take().unwrap();
        assert_eq!(
            retained.stream_position().unwrap(),
            (MAX_WORKSPACE_METADATA_BYTES + 1) as u64
        );
    }

    #[cfg(unix)]
    #[test]
    fn oversized_metadata_refuses_create_and_rename_before_mutation() {
        let (_directory, state, workspace) = workspace_state();
        let oversized = WorkspaceMetadata {
            file_type: WorkspaceFileType::Game,
            tags: vec!["x".repeat(MAX_WORKSPACE_METADATA_BYTES)],
        };
        let create = create_workspace_file_blocking(
            workspace.clone(),
            workspace.clone(),
            "too-large".into(),
            oversized.clone(),
            WorkspaceFileContent::Text { pgn: "*".into() },
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &state.pgn_repository,
            &CancellationToken::new(),
        );
        assert!(matches!(create, Err(Error::ResourceLimit(_))));
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        assert!(!root.join("too-large.pgn").exists());
        assert!(!root.join("too-large.info").exists());

        let created = create_workspace_file_blocking(
            workspace.clone(),
            workspace.clone(),
            "before".into(),
            WorkspaceMetadata::default(),
            WorkspaceFileContent::Text { pgn: "*".into() },
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &state.pgn_repository,
            &CancellationToken::new(),
        )
        .unwrap();
        let rename = rename_workspace_file_blocking(
            workspace,
            created.handle,
            "after".into(),
            oversized,
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &CancellationToken::new(),
        );
        assert!(matches!(rename, Err(Error::ResourceLimit(_))));
        assert!(root.join("before.pgn").is_file());
        assert!(root.join("before.info").is_file());
        assert!(!root.join("after.pgn").exists());
        assert!(!root.join("after.info").exists());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_helpers_bind_only_registered_descendants_and_preserve_sidecar_names() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("workspace root");
        let game = root.join("round-one.pgn");
        fs::write(&game, "[Event \"Round one\"]\n\n1. e4 e5 *\n").expect("PGN");

        assert_eq!(
            workspace_components(&state.pgn_path_authority, &workspace, &game).unwrap(),
            vec!["round-one.pgn"]
        );
        assert!(workspace_components(
            &state.pgn_path_authority,
            &workspace,
            &directory.path().join("outside.pgn")
        )
        .is_err());
        assert_eq!(
            sidecar_leaf(Path::new("round-one.pgn").as_os_str()).unwrap(),
            "round-one.info"
        );
        assert!(sidecar_leaf(Path::new("/").as_os_str()).is_err());

        let metadata = fs::metadata(&game).expect("game metadata");
        let identity = (metadata.dev(), metadata.ino());
        let components = workspace_components(&state.pgn_path_authority, &workspace, &game)
            .expect("workspace components");
        let entry = state
            .pgn_path_authority
            .raw_for_test()
            .lock()
            .expect("authority lock")
            .as_mut()
            .expect("authority")
            .register_workspace_child_observed(
                &workspace,
                &components,
                "Round one",
                identity,
                false,
                PathOperation::ReadPgn,
            )
            .expect("entry handle");
        {
            let metadata = fs::metadata(&game).expect("game metadata");
            let expected = register_created_entry(
                &state.pgn_path_authority,
                &workspace,
                &game,
                "Round one expected".into(),
                (metadata.dev(), metadata.ino()),
                crate::infra::path_authority::opened_file_identity(
                    &crate::infra::fs::open_parent_no_follow(&game).expect("game parent"),
                )
                .expect("game parent identity"),
                false,
            )
            .expect("expected entry handle");
            let root_target =
                mutation_target(&state.pgn_path_authority, &workspace).expect("root target");
            let entry_target =
                mutation_target(&state.pgn_path_authority, &entry).expect("entry target");
            let expected_target =
                mutation_target(&state.pgn_path_authority, &expected).expect("expected target");
            ensure_registered_descendant(&root_target, &entry_target).expect("entry inside root");
            ensure_registered_descendant(&root_target, &expected_target)
                .expect("expected entry inside root");
        }
    }

    #[test]
    fn durability_outcomes_remain_renderer_safe() {
        assert_eq!(
            durability_uncertainty(
                crate::infra::fs::AtomicFileOutcome::DurableCommit,
                crate::error::DurabilityStage::WorkspacePgnCreation,
            ),
            None
        );
        assert_eq!(
            durability_uncertainty(
                crate::infra::fs::AtomicFileOutcome::CommittedDurabilityUncertain(
                    std::io::Error::other("/private/workspace: sync failed"),
                ),
                crate::error::DurabilityStage::WorkspaceSidecarCreation,
            ),
            Some(crate::error::DurabilityStage::WorkspaceSidecarCreation)
        );
    }

    #[derive(Clone, Copy, Debug)]
    enum MetadataEdit {
        Metadata,
        SameLeaf,
        Rename,
    }

    fn edit_metadata(
        mode: MetadataEdit,
        state: &AppState,
        workspace: &FileWorkspaceHandle,
        entry: &FileWorkspaceHandle,
        metadata: WorkspaceMetadata,
        cancellation: &CancellationToken,
    ) -> Result<(), Error> {
        match mode {
            MetadataEdit::Metadata => write_workspace_file_metadata_blocking(
                workspace.clone(),
                entry.clone(),
                metadata,
                &state.pgn_path_authority,
                &state.workspace_mutation,
                cancellation,
            ),
            MetadataEdit::SameLeaf | MetadataEdit::Rename => rename_workspace_file_blocking(
                workspace.clone(),
                entry.clone(),
                if matches!(mode, MetadataEdit::SameLeaf) {
                    "before.pgn"
                } else {
                    "after"
                }
                .into(),
                metadata,
                &state.pgn_path_authority,
                &state.workspace_mutation,
                cancellation,
            ),
        }
    }

    fn edited_metadata() -> WorkspaceMetadata {
        WorkspaceMetadata {
            file_type: WorkspaceFileType::Repertoire,
            tags: vec!["original".into()],
        }
    }

    struct MetadataPrecommitHook(StdMutex<Option<Box<dyn FnOnce() + Send>>>);

    impl AtomicWriterInjector for MetadataPrecommitHook {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == AtomicFileFaultPoint::PreCommitRevalidate {
                if let Some(hook) = self.0.lock().expect("hook lock").take() {
                    hook();
                }
            }
            Ok(())
        }
    }

    #[test]
    fn metadata_edits_write_the_sidecar_and_keep_pgn_bytes_and_identity() {
        for mode in [
            MetadataEdit::Metadata,
            MetadataEdit::SameLeaf,
            MetadataEdit::Rename,
        ] {
            for existing in [false, true] {
                let (directory, state, workspace) = workspace_state();
                let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
                let path = root.join("before.pgn");
                let pgn_bytes = b"[Event \"Keep\"]\n\n1. e4 *\n";
                fs::write(&path, pgn_bytes).unwrap();
                let entry = registered_child_file(&state, &workspace, &path);
                let original = WorkspaceMetadata {
                    file_type: WorkspaceFileType::Game,
                    tags: edited_metadata().tags,
                };
                if existing {
                    fs::write(
                        root.join("before.info"),
                        serialize_metadata(&original).unwrap(),
                    )
                    .unwrap();
                }
                let identity = mutation_target(&state.pgn_path_authority, &entry)
                    .unwrap()
                    .identity;
                let registry_before = fs::read(directory.path().join("registry.json")).unwrap();
                let metadata = edited_metadata();
                edit_metadata(
                    mode,
                    &state,
                    &workspace,
                    &entry,
                    metadata.clone(),
                    &CancellationToken::new(),
                )
                .unwrap();
                let leaf = if matches!(mode, MetadataEdit::Rename) {
                    "after"
                } else {
                    "before"
                };
                assert_eq!(
                    fs::read(root.join(format!("{leaf}.pgn"))).unwrap(),
                    pgn_bytes
                );
                assert_eq!(
                    serde_json::from_slice::<WorkspaceMetadata>(
                        &fs::read(root.join(format!("{leaf}.info"))).unwrap()
                    )
                    .unwrap(),
                    metadata
                );
                let resolved = mutation_target(&state.pgn_path_authority, &entry).unwrap();
                assert_eq!(resolved.identity, identity);
                assert_eq!(resolved.path(), root.join(format!("{leaf}.pgn")));
                if !matches!(mode, MetadataEdit::Rename) {
                    assert_eq!(
                        fs::read(directory.path().join("registry.json")).unwrap(),
                        registry_before
                    );
                } else {
                    assert!(!path.exists());
                    assert!(!root.join("before.info").exists());
                }
            }
        }
    }

    #[test]
    fn metadata_command_refuses_directory_unknown_foreign_and_oversized_inputs() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        let path = root.join("before.pgn");
        fs::write(&path, "*").unwrap();
        let entry = registered_child_file(&state, &workspace, &path);
        fs::write(root.join("before.info"), b"original").unwrap();
        let (_folder_path, folder) = registered_child_directory(&state, &workspace, "folder");
        let (_foreign_directory, foreign_state, foreign_workspace) = workspace_state();
        let foreign_root =
            workspace_root(&foreign_state.pgn_path_authority, &foreign_workspace).unwrap();
        let foreign_path = foreign_root.join("foreign.pgn");
        fs::write(&foreign_path, "*").unwrap();
        let foreign = registered_child_file(&foreign_state, &foreign_workspace, &foreign_path);
        let unknown = FileWorkspaceHandle::new(PathRef {
            id: "unregistered".into(),
        });
        let snapshot = fs::read(directory.path().join("registry.json")).unwrap();
        for refused in [&folder, &unknown, &foreign] {
            let error = edit_metadata(
                MetadataEdit::Metadata,
                &state,
                &workspace,
                refused,
                edited_metadata(),
                &CancellationToken::new(),
            )
            .unwrap_err();
            assert!(matches!(error, Error::InvalidInput(_)));
        }
        assert_eq!(
            fs::read(directory.path().join("registry.json")).unwrap(),
            snapshot
        );
        let outside_root = directory.path().join("outside");
        fs::create_dir(&outside_root).unwrap();
        let outside_workspace = {
            let mut guard = state.pgn_path_authority.raw_for_test().lock().unwrap();
            let authority = guard.as_mut().unwrap();
            let grant = authority
                .grant_dialog_operations(
                    &outside_root,
                    "Outside",
                    PathClass::BoundedDialogGrant,
                    vec![PathOperation::ReadPgn, PathOperation::WritePgn],
                    Duration::from_secs(60),
                    4,
                )
                .unwrap();
            FileWorkspaceHandle::new(
                authority
                    .promote_dialog(
                        &grant,
                        PathClass::PersistentCustomRoot,
                        "Outside",
                        vec![PathOperation::ReadPgn, PathOperation::WritePgn],
                    )
                    .unwrap()
                    .id,
            )
        };
        let outside_root_canonical =
            workspace_root(&state.pgn_path_authority, &outside_workspace).unwrap();
        let outside = outside_root_canonical.join("outside.pgn");
        fs::write(&outside, "*").unwrap();
        let outside_entry = registered_child_file(&state, &outside_workspace, &outside);
        let registry_with_outside = fs::read(directory.path().join("registry.json")).unwrap();
        // A registered file in another collection of the SAME authority is also refused.
        assert!(edit_metadata(
            MetadataEdit::Metadata,
            &state,
            &workspace,
            &outside_entry,
            edited_metadata(),
            &CancellationToken::new()
        )
        .is_err());
        assert_eq!(
            fs::read(directory.path().join("registry.json")).unwrap(),
            registry_with_outside
        );
        let oversized = WorkspaceMetadata {
            file_type: WorkspaceFileType::Game,
            tags: vec!["x".repeat(MAX_WORKSPACE_METADATA_BYTES)],
        };
        assert!(matches!(
            edit_metadata(
                MetadataEdit::Metadata,
                &state,
                &workspace,
                &entry,
                oversized,
                &CancellationToken::new()
            ),
            Err(Error::ResourceLimit(_))
        ));
        assert_eq!(fs::read(&path).unwrap(), b"*");
        assert_eq!(fs::read(root.join("before.info")).unwrap(), b"original");
        assert!(!root.join("folder.info").exists());
    }

    #[test]
    fn metadata_precommit_refuses_replaced_removed_and_nonregular_pgns_without_sidecar_commit() {
        for mode in [
            MetadataEdit::Metadata,
            MetadataEdit::SameLeaf,
            MetadataEdit::Rename,
        ] {
            for change in ["replace", "remove", "directory"] {
                for existing in [false, true] {
                    let (directory, state, workspace) = workspace_state();
                    let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
                    let source = root.join("before.pgn");
                    fs::write(&source, "*").unwrap();
                    let entry = registered_child_file(&state, &workspace, &source);
                    if existing {
                        fs::write(root.join("before.info"), b"original-sidecar").unwrap();
                    }
                    let registry_before = fs::read(directory.path().join("registry.json")).unwrap();
                    let leaf = if matches!(mode, MetadataEdit::Rename) {
                        "after"
                    } else {
                        "before"
                    };
                    let target = root.join(format!("{leaf}.pgn"));
                    let displaced = root.join("displaced.pgn");
                    let hook_target = target.clone();
                    let hook_displaced = displaced.clone();
                    set_test_atomic_file_injector(Some(Arc::new(MetadataPrecommitHook(
                        StdMutex::new(Some(Box::new(move || {
                            // Retain the original inode so replacement cannot reuse its identity.
                            fs::rename(&hook_target, hook_displaced).unwrap();
                            match change {
                                "replace" => fs::write(&hook_target, b"substitute").unwrap(),
                                "directory" => fs::create_dir(&hook_target).unwrap(),
                                _ => {}
                            }
                        }))),
                    ))));
                    let result = edit_metadata(
                        mode,
                        &state,
                        &workspace,
                        &entry,
                        edited_metadata(),
                        &CancellationToken::new(),
                    );
                    set_test_atomic_file_injector(None);
                    let error = result.unwrap_err();
                    if matches!(mode, MetadataEdit::Rename) {
                        let Error::OperationAndCleanup { primary, cleanup } = &error else {
                            panic!("{mode:?} {change}: {error}");
                        };
                        if change == "remove" {
                            assert!(primary.starts_with("I/O failure:"), "{primary}");
                            if existing {
                                assert!(primary.contains("(os error 2)"), "{primary}");
                            }
                        } else if existing {
                            assert!(
                                primary
                                    .starts_with("Conflict: workspace entry changed concurrently"),
                                "{primary}"
                            );
                        } else {
                            assert!(primary.starts_with("Conflict:"), "{primary}");
                        }
                        assert!(!cleanup.is_empty());
                        let payload = serde_json::to_value(&error).unwrap();
                        assert_eq!(payload["category"], "operation-and-cleanup");
                        assert!(payload.get("nameTaken").is_none());
                    } else if change == "remove" {
                        assert!(error.is_missing_entry(), "{mode:?}: {error}");
                    } else {
                        assert!(matches!(error, Error::Conflict(_)), "{mode:?}: {error}");
                    }
                    assert_eq!(fs::read(displaced).unwrap(), b"*");
                    if change == "replace" {
                        assert_eq!(fs::read(&target).unwrap(), b"substitute");
                    }
                    if change == "directory" {
                        assert!(target.is_dir());
                    }
                    if matches!(mode, MetadataEdit::Rename) && existing && change == "remove" {
                        assert!(!target.exists());
                    }
                    let sidecar = root.join(format!("{leaf}.info"));
                    if matches!(mode, MetadataEdit::Rename) && existing {
                        assert_eq!(
                            fs::read(root.join("before.info")).unwrap(),
                            b"original-sidecar"
                        );
                        assert!(!sidecar.exists());
                    } else if existing {
                        assert_eq!(fs::read(sidecar).unwrap(), b"original-sidecar");
                    } else {
                        assert!(!sidecar.exists());
                    }
                    assert_eq!(
                        fs::read(directory.path().join("registry.json")).unwrap(),
                        registry_before
                    );
                    // No failed metadata publication rebinds the registry or moves a substitute.
                    if matches!(mode, MetadataEdit::Rename) {
                        assert!(!source.exists());
                        if !existing {
                            assert!(!root.join("before.info").exists());
                        }
                        assert!(registry_has_display_name(&directory, "before"));
                    }
                    assert!(fs::read_dir(&root).unwrap().all(|entry| !entry
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".atomic-")));
                }
            }
        }
    }

    #[test]
    fn sidecar_only_edits_report_workspace_sidecar_durability_uncertainty() {
        for mode in [MetadataEdit::Metadata, MetadataEdit::SameLeaf] {
            let (directory, state, workspace) = workspace_state();
            let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
            let path = root.join("before.pgn");
            fs::write(&path, "*").unwrap();
            let entry = registered_child_file(&state, &workspace, &path);
            let registry_before = fs::read(directory.path().join("registry.json")).unwrap();
            set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
                "uncertain",
            ))));
            let result = edit_metadata(
                mode,
                &state,
                &workspace,
                &entry,
                edited_metadata(),
                &CancellationToken::new(),
            );
            set_test_atomic_file_injector(None);
            assert!(matches!(
                result,
                Err(Error::CommittedDurabilityUncertain(
                    crate::error::DurabilityStage::WorkspaceSidecarReplacement
                ))
            ));
            assert_eq!(
                serde_json::from_slice::<WorkspaceMetadata>(
                    &fs::read(root.join("before.info")).unwrap()
                )
                .unwrap(),
                edited_metadata()
            );
            assert_eq!(
                mutation_target(&state.pgn_path_authority, &entry)
                    .unwrap()
                    .path(),
                path
            );
            assert_eq!(
                fs::read(directory.path().join("registry.json")).unwrap(),
                registry_before
            );
        }
    }

    #[test]
    fn sidecar_only_edits_cancel_before_commit_without_changing_files_or_registry() {
        for mode in [MetadataEdit::Metadata, MetadataEdit::SameLeaf] {
            let (directory, state, workspace) = workspace_state();
            let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
            let path = root.join("before.pgn");
            fs::write(&path, "*").unwrap();
            let entry = registered_child_file(&state, &workspace, &path);
            fs::write(root.join("before.info"), b"original").unwrap();
            let registry_before = fs::read(directory.path().join("registry.json")).unwrap();
            let cancellation = CancellationToken::new();
            let cancel = cancellation.clone();
            set_test_atomic_file_injector(Some(Arc::new(MetadataPrecommitHook(StdMutex::new(
                Some(Box::new(move || cancel.cancel())),
            )))));
            let result = edit_metadata(
                mode,
                &state,
                &workspace,
                &entry,
                edited_metadata(),
                &cancellation,
            );
            set_test_atomic_file_injector(None);
            assert!(matches!(result, Err(Error::Cancellation)));
            assert_eq!(fs::read(&path).unwrap(), b"*");
            assert_eq!(fs::read(root.join("before.info")).unwrap(), b"original");
            assert_eq!(
                fs::read(directory.path().join("registry.json")).unwrap(),
                registry_before
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn sidecar_only_edits_refuse_symlinks_directories_and_fifos() {
        for mode in [MetadataEdit::Metadata, MetadataEdit::SameLeaf] {
            for kind in ["symlink", "directory", "fifo"] {
                let (directory, state, workspace) = workspace_state();
                let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
                let path = root.join("before.pgn");
                fs::write(&path, "*").unwrap();
                let entry = registered_child_file(&state, &workspace, &path);
                let info = root.join("before.info");
                let sentinel = root.join("sentinel");
                fs::write(&sentinel, b"untouched").unwrap();
                match kind {
                    "symlink" => std::os::unix::fs::symlink(&sentinel, &info).unwrap(),
                    "directory" => fs::create_dir(&info).unwrap(),
                    _ => {
                        assert!(std::process::Command::new("mkfifo")
                            .arg(&info)
                            .status()
                            .unwrap()
                            .success());
                    }
                }
                let before = fs::symlink_metadata(&info).unwrap();
                let registry_before = fs::read(directory.path().join("registry.json")).unwrap();
                assert!(edit_metadata(
                    mode,
                    &state,
                    &workspace,
                    &entry,
                    edited_metadata(),
                    &CancellationToken::new()
                )
                .is_err());
                let after = fs::symlink_metadata(&info).unwrap();
                assert_eq!(
                    (before.dev(), before.ino(), before.mode()),
                    (after.dev(), after.ino(), after.mode())
                );
                assert_eq!(fs::read(sentinel).unwrap(), b"untouched");
                assert_eq!(fs::read(&path).unwrap(), b"*");
                assert_eq!(
                    fs::read(directory.path().join("registry.json")).unwrap(),
                    registry_before
                );
            }
        }
    }

    /// Creates `before.pgn` with an empty tag list, renames it to `after.pgn` with the tag
    /// `renamed` under `injector`, and returns the workspace root, the entry handle and the
    /// rename result.
    fn rename_under_injector(
        injector: Option<Arc<dyn AtomicWriterInjector + Send + Sync>>,
    ) -> (
        TempDir,
        AppState,
        PathBuf,
        FileWorkspaceHandle,
        Result<(), Error>,
    ) {
        let (directory, state, workspace) = workspace_state();
        let created = create_workspace_file_blocking(
            workspace.clone(),
            workspace.clone(),
            "before".into(),
            WorkspaceMetadata {
                file_type: WorkspaceFileType::Game,
                tags: vec![],
            },
            WorkspaceFileContent::Text { pgn: "*".into() },
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &state.pgn_repository,
            &CancellationToken::new(),
        )
        .expect("created file");
        let root = mutation_target(&state.pgn_path_authority, &workspace)
            .expect("workspace target")
            .path()
            .to_path_buf();
        set_test_atomic_file_injector(injector);
        let result = rename_workspace_file_blocking(
            workspace,
            created.handle.clone(),
            "after".into(),
            WorkspaceMetadata {
                file_type: WorkspaceFileType::Game,
                tags: vec!["renamed".into()],
            },
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &CancellationToken::new(),
        );
        set_test_atomic_file_injector(None);
        (directory, state, root, created.handle, result)
    }

    /// The rename, the sidecar rewrite and the registry rebind all landed, whatever the result.
    fn assert_rename_landed(state: &AppState, root: &Path, handle: &FileWorkspaceHandle) {
        assert!(root.join("after.pgn").is_file());
        assert!(!root.join("before.pgn").exists());
        assert!(!root.join("before.info").exists());
        let sidecar: WorkspaceMetadata =
            serde_json::from_slice(&fs::read(root.join("after.info")).expect("renamed sidecar"))
                .expect("sidecar is the metadata JSON");
        assert_eq!(sidecar.tags, vec!["renamed".to_string()]);
        let rebound = mutation_target(&state.pgn_path_authority, handle)
            .expect("renamed entry stays registered");
        assert_eq!(rebound.path(), root.join("after.pgn"));
        let parent = crate::infra::fs::open_parent_no_follow(&root.join("after.pgn"))
            .expect("renamed file parent descriptor");
        let expected_parent = crate::infra::path_authority::opened_file_identity(&parent)
            .expect("renamed parent identity");
        let mut authority = state
            .pgn_path_authority
            .raw_for_test()
            .lock()
            .expect("authority lock");
        let authority = authority.as_mut().expect("path authority");
        assert_eq!(
            authority.parent_identity_for_test(handle.path_ref()),
            Some(expected_parent)
        );
        assert!(authority
            .resolve(handle.path_ref(), PathOperation::ReadPgn, &[])
            .is_ok());
    }

    /// The listing's shape, asserted on every platform. The existing shape assertion,
    /// `collect_tree_entries_matches_the_workspace_shape`, lives in a module that needs
    /// `symlink`, `mkfifo`, `OsStrExt` and `FileExt`, none of which Windows has; this one uses
    /// only ordinary file operations, so a Windows arm that returned `Ok(vec![])` fails here.
    #[test]
    fn collect_tree_entries_lists_the_workspace_shape_on_every_platform() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("workspace root");
        fs::write(root.join("b.pgn"), b"*").expect("b.pgn");
        fs::write(root.join("a.pgn"), b"*").expect("a.pgn");
        fs::write(
            root.join("a.info"),
            br#"{"type":"game","tags":["trusted"]}"#,
        )
        .expect("a.info");
        fs::write(root.join("notes.txt"), b"notes").expect("notes.txt");
        let nested = root.join("nested");
        fs::create_dir(&nested).expect("nested");
        fs::write(nested.join("inner.pgn"), b"*").expect("inner.pgn");
        fs::create_dir(root.join(TRASH_DIRECTORY)).expect("trash bucket");

        // Finish all contents before pinning whole seconds, with no modifying handle left open.
        const FILE_SECONDS: i64 = 1_600_000_000;
        const NESTED_SECONDS: i64 = 1_600_000_100;
        const LATER_NESTED_SECONDS: i64 = 1_600_000_200;
        fs::OpenOptions::new()
            .write(true)
            .open(root.join("a.pgn"))
            .expect("a.pgn timestamp handle")
            .set_modified(
                std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(FILE_SECONDS as u64),
            )
            .expect("a.pgn mtime");
        set_directory_modified(
            &nested,
            std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(NESTED_SECONDS as u64),
        );
        assert_eq!(
            enumerated_workspace_entry(&root, "a.pgn").modified_seconds,
            FILE_SECONDS,
            "file timestamp fixture"
        );
        assert_eq!(
            enumerated_workspace_entry(&root, "nested").modified_seconds,
            NESTED_SECONDS,
            "initial directory timestamp fixture"
        );

        struct ListingHookCleanup;
        impl Drop for ListingHookCleanup {
            fn drop(&mut self) {
                set_workspace_listing_pre_register_hook(None);
            }
        }
        let hook_cleanup = ListingHookCleanup;
        let transitioned = std::rc::Rc::new(std::cell::Cell::new(false));
        let hook_transitioned = std::rc::Rc::clone(&transitioned);
        let mut hook_nested = Some(nested);
        // This all-platform seam runs after the walk. Mutate our directory only once, so a
        // later observation differs from the captured snapshot without relying on NTFS timing.
        set_workspace_listing_pre_register_hook(Some(Box::new(move || {
            if let Some(nested) = hook_nested.take() {
                set_directory_modified(
                    &nested,
                    std::time::SystemTime::UNIX_EPOCH
                        + Duration::from_secs(LATER_NESTED_SECONDS as u64),
                );
                hook_transitioned.set(true);
            }
        })));
        let listing = collect_tree_entries(
            &state.pgn_path_authority,
            &workspace,
            &CancellationToken::new(),
        );
        drop(hook_cleanup);
        let (entries, missing) = listing.expect("workspace listing");
        assert!(transitioned.get(), "post-walk timestamp transition ran");
        assert_eq!(
            enumerated_workspace_entry(&root, "nested").modified_seconds,
            LATER_NESTED_SECONDS,
            "later directory timestamp fixture"
        );

        // Sorted by raw name bytes, sidecars and non-PGN files dropped, the trash bucket hidden.
        assert_eq!(
            entries
                .entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["a", "b", "nested"]
        );
        let a = &entries.entries[0];
        assert_eq!(a.kind, WorkspaceEntryKind::File);
        assert_eq!(a.metadata.as_ref().expect("a metadata").tags, ["trusted"]);
        assert_eq!(a.last_modified, FILE_SECONDS);
        let b = &entries.entries[1];
        assert_eq!(b.kind, WorkspaceEntryKind::File);
        assert_eq!(
            b.metadata.as_ref().expect("b metadata").tags,
            Vec::<String>::new()
        );
        let nested_entry = &entries.entries[2];
        assert_eq!(nested_entry.kind, WorkspaceEntryKind::Directory);
        assert_eq!(
            nested_entry
                .children
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["inner"]
        );
        assert_eq!(nested_entry.children[0].kind, WorkspaceEntryKind::File);
        assert_eq!(nested_entry.last_modified, NESTED_SECONDS);
        // One game-count handle per listed PGN, directories excluded.
        assert_eq!(missing.len(), 3);
        for handle in &missing {
            mutation_target(&state.pgn_path_authority, handle).expect("listed PGN is registered");
        }
    }

    /// A2b: a PGN that has no `.info` sidecar renames and deletes cleanly. The optional-sidecar
    /// helpers must report a missing leaf as success; mapping it to an error would report a
    /// fully successful delete to the user as an uncertain one.
    #[tokio::test]
    async fn sidecar_less_pgn_renames_and_deletes_cleanly() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("workspace root");
        let source_path = root.join("bare.pgn");
        fs::write(&source_path, b"*").expect("bare PGN");
        let bare = registered_child_file(&state, &workspace, &source_path);
        assert!(!root.join("bare.info").exists());

        rename_workspace_file_blocking(
            workspace.clone(),
            bare.clone(),
            "renamed".into(),
            WorkspaceMetadata::default(),
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &CancellationToken::new(),
        )
        .expect("rename a PGN that has no sidecar");
        assert!(!source_path.exists());
        assert!(root.join("renamed.pgn").is_file());

        // The rename writes the sidecar the caller supplied; remove it again so the delete also
        // runs against a PGN with no `.info` beside it.
        fs::remove_file(root.join("renamed.info")).expect("drop the written sidecar");
        permanently_delete_entry(&state, &workspace, &bare, CancellationToken::new())
            .await
            .expect("delete a PGN that has no sidecar");
        assert!(!root.join("renamed.pgn").exists());
        assert!(mutation_target(&state.pgn_path_authority, &bare).is_err());
    }

    #[test]
    fn rename_workspace_file_moves_pgn_sidecar_and_registry_entry() {
        let (_directory, state, root, handle, result) = rename_under_injector(None);
        result.expect("durable rename");
        assert_rename_landed(&state, &root, &handle);
    }

    fn assert_name_taken(error: &Error) {
        let payload = serde_json::to_value(error).unwrap();
        assert_eq!(payload["category"], "conflict", "{payload}");
        assert_eq!(payload["nameTaken"], true, "{payload}");
    }

    #[test]
    fn workspace_directory_collision_preserves_existing_objects_and_registry() {
        for directory in [false, true] {
            let (temporary, state, workspace) = workspace_state();
            let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
            let occupied = root.join("occupied");
            let bytes = if directory {
                fs::create_dir(&occupied).unwrap();
                occupied.join("child")
            } else {
                occupied.clone()
            };
            fs::write(&bytes, b"existing bytes").unwrap();
            let registry = fs::read(temporary.path().join("registry.json")).unwrap();
            let error = create_workspace_directory_inner(
                workspace.clone(),
                workspace.clone(),
                "occupied".into(),
                &state.pgn_path_authority,
                &state.workspace_mutation,
                &CancellationToken::new(),
            )
            .unwrap_err();
            assert_name_taken(&error);
            assert_eq!(fs::read(bytes).unwrap(), b"existing bytes");
            assert_eq!(
                fs::read(temporary.path().join("registry.json")).unwrap(),
                registry
            );
            mutation_target(&state.pgn_path_authority, &workspace).unwrap();
        }
    }

    struct PlantRenameSidecar {
        point: AtomicFileFaultPoint,
        path: PathBuf,
    }

    impl AtomicWriterInjector for PlantRenameSidecar {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == self.point {
                fs::write(&self.path, b"unrelated destination metadata")?;
            }
            Ok(())
        }
    }

    #[test]
    fn forward_workspace_collisions_preserve_source_destination_and_registry() {
        // Both commands use the same pair, but only rename subsequently edits metadata.
        for moving in [false, true] {
            for source_sidecar in [false, true] {
                for primary_collision in [false, true] {
                    let (temporary, state, workspace) = workspace_state();
                    let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
                    let created =
                        create_named_text(&state, &workspace, "before", "1. e4 *").unwrap();
                    let original_metadata = fs::read(root.join("before.info")).unwrap();
                    if !source_sidecar {
                        fs::remove_file(root.join("before.info")).unwrap();
                    }
                    let (destination, parent) = if moving {
                        registered_child_directory(&state, &workspace, "destination")
                    } else {
                        (root.clone(), workspace.clone())
                    };
                    let target = if moving { "before" } else { "after" };
                    let occupied = destination.join(format!(
                        "{target}.{}",
                        if primary_collision { "pgn" } else { "info" }
                    ));
                    fs::write(&occupied, b"unrelated destination bytes").unwrap();
                    let registry = fs::read(temporary.path().join("registry.json")).unwrap();
                    let source =
                        mutation_target(&state.pgn_path_authority, &created.handle).unwrap();
                    let result = if moving {
                        move_workspace_entry_blocking(
                            workspace.clone(),
                            created.handle.clone(),
                            parent,
                            &state.pgn_path_authority,
                            &state.workspace_mutation,
                            &CancellationToken::new(),
                        )
                    } else {
                        rename_workspace_file_blocking(
                            workspace.clone(),
                            created.handle.clone(),
                            target.into(),
                            WorkspaceMetadata::default(),
                            &state.pgn_path_authority,
                            &state.workspace_mutation,
                            &CancellationToken::new(),
                        )
                    };
                    assert_eq!(fs::read(&occupied).unwrap(), b"unrelated destination bytes");
                    assert_name_taken(&result.unwrap_err());
                    assert_eq!(fs::read(root.join("before.pgn")).unwrap(), b"1. e4 *");
                    if source_sidecar {
                        assert_eq!(
                            fs::read(root.join("before.info")).unwrap(),
                            original_metadata
                        );
                    } else {
                        assert!(!root.join("before.info").exists());
                    }
                    if !primary_collision {
                        assert!(!destination.join(format!("{target}.pgn")).exists());
                    }
                    let retained =
                        mutation_target(&state.pgn_path_authority, &created.handle).unwrap();
                    assert_eq!(retained.path(), source.path());
                    assert_eq!(retained.identity, source.identity);
                    assert_eq!(
                        fs::read(temporary.path().join("registry.json")).unwrap(),
                        registry
                    );
                }
            }
        }
    }

    #[test]
    fn absent_sidecar_publication_collision_compensates_inside_the_pair() {
        for moving in [false, true] {
            for point in [
                AtomicFileFaultPoint::PreCommitRevalidate,
                AtomicFileFaultPoint::Rename,
            ] {
                let (temporary, state, workspace) = workspace_state();
                let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
                let created = create_named_text(&state, &workspace, "before", "*").unwrap();
                fs::remove_file(root.join("before.info")).unwrap();
                let (destination, parent) = if moving {
                    registered_child_directory(&state, &workspace, "destination")
                } else {
                    (root.clone(), workspace.clone())
                };
                let name = if moving { "before" } else { "after" };
                let sidecar = destination.join(format!("{name}.info"));
                let registry = fs::read(temporary.path().join("registry.json")).unwrap();
                let _injector = crate::infra::fs::install_test_atomic_file_injector(Arc::new(
                    PlantRenameSidecar {
                        point,
                        path: sidecar.clone(),
                    },
                ));
                let result = if moving {
                    move_workspace_entry_blocking(
                        workspace.clone(),
                        created.handle.clone(),
                        parent,
                        &state.pgn_path_authority,
                        &state.workspace_mutation,
                        &CancellationToken::new(),
                    )
                } else {
                    rename_workspace_file_blocking(
                        workspace.clone(),
                        created.handle.clone(),
                        name.into(),
                        WorkspaceMetadata::default(),
                        &state.pgn_path_authority,
                        &state.workspace_mutation,
                        &CancellationToken::new(),
                    )
                };
                assert_eq!(
                    fs::read(&sidecar).unwrap(),
                    b"unrelated destination metadata"
                );
                assert_name_taken(&result.unwrap_err());
                assert_eq!(fs::read(root.join("before.pgn")).unwrap(), b"*");
                assert!(!root.join("before.info").exists());
                assert!(!destination.join(format!("{name}.pgn")).exists());
                assert_workspace_entry_names(
                    &destination,
                    if moving {
                        &["before.info", "removed"]
                    } else {
                        &["after.info", "before.pgn"]
                    },
                );
                assert_eq!(
                    mutation_target(&state.pgn_path_authority, &created.handle)
                        .unwrap()
                        .path(),
                    root.join("before.pgn")
                );
                assert_eq!(
                    fs::read(temporary.path().join("registry.json")).unwrap(),
                    registry
                );
            }
        }
    }

    #[test]
    fn absent_sidecar_cancellation_after_primary_rename_compensates_inside_the_pair() {
        for moving in [false, true] {
            let (temporary, state, workspace) = workspace_state();
            let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
            let created = create_named_text(&state, &workspace, "before", "1. e4 *").unwrap();
            fs::remove_file(root.join("before.info")).unwrap();
            let (destination, parent) = if moving {
                registered_child_directory(&state, &workspace, "destination")
            } else {
                (root.clone(), workspace.clone())
            };
            let name = if moving { "before" } else { "after" };
            let source = mutation_target(&state.pgn_path_authority, &created.handle).unwrap();
            let registry = fs::read(temporary.path().join("registry.json")).unwrap();
            let parent_identity =
                crate::infra::path_authority::opened_file_identity(&source.parent).unwrap();
            let cancellation = CancellationToken::new();
            let token = cancellation.clone();
            let observed_source = root.join("before.pgn");
            let observed_primary = destination.join(format!("{name}.pgn"));
            let observed_sidecar = destination.join(format!("{name}.info"));
            PAIRED_RENAME_POST_PRIMARY_HOOK.with(|slot| {
                assert!(slot
                    .replace(Some(Box::new(move || {
                        assert!(!observed_source.exists());
                        assert_eq!(fs::read(observed_primary).unwrap(), b"1. e4 *");
                        assert!(!observed_sidecar.exists());
                        token.cancel();
                    })))
                    .is_none());
            });
            let result = if moving {
                move_workspace_entry_blocking(
                    workspace.clone(),
                    created.handle.clone(),
                    parent,
                    &state.pgn_path_authority,
                    &state.workspace_mutation,
                    &cancellation,
                )
            } else {
                rename_workspace_file_blocking(
                    workspace.clone(),
                    created.handle.clone(),
                    name.into(),
                    WorkspaceMetadata::default(),
                    &state.pgn_path_authority,
                    &state.workspace_mutation,
                    &cancellation,
                )
            };
            assert!(cancellation.is_cancelled());
            assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
            assert_eq!(fs::read(root.join("before.pgn")).unwrap(), b"1. e4 *");
            assert!(!root.join("before.info").exists());
            assert!(!destination.join(format!("{name}.pgn")).exists());
            assert!(!destination.join(format!("{name}.info")).exists());
            let retained = mutation_target(&state.pgn_path_authority, &created.handle).unwrap();
            assert_eq!(retained.path(), source.path());
            assert_eq!(retained.identity, source.identity);
            {
                let mut authority = state.pgn_path_authority.raw_for_test().lock().unwrap();
                let authority = authority.as_mut().unwrap();
                assert_eq!(
                    authority.parent_identity_for_test(created.handle.path_ref()),
                    Some(parent_identity)
                );
                assert!(authority
                    .resolve(created.handle.path_ref(), PathOperation::ReadPgn, &[])
                    .is_ok());
            }
            assert_eq!(
                fs::read(temporary.path().join("registry.json")).unwrap(),
                registry
            );
            assert_workspace_entry_names(
                &root,
                if moving {
                    &["before.pgn", "destination"]
                } else {
                    &["before.pgn"]
                },
            );
            if moving {
                assert_workspace_entry_names(&destination, &["removed"]);
            }
        }
    }

    #[test]
    fn absent_sidecar_publication_finishes_committed_uncertainty_and_rebinds() {
        for moving in [false, true] {
            for sync in 0..=if moving { 2 } else { 1 } {
                let (_temporary, state, workspace) = workspace_state();
                let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
                let created = create_named_text(&state, &workspace, "before", "*").unwrap();
                fs::remove_file(root.join("before.info")).unwrap();
                let (destination, parent) = if moving {
                    registered_child_directory(&state, &workspace, "destination")
                } else {
                    (root.clone(), workspace.clone())
                };
                let name = if moving { "before" } else { "after" };
                let metadata = WorkspaceMetadata {
                    file_type: WorkspaceFileType::Puzzle,
                    tags: vec!["retained draft".into()],
                };
                let _injector = crate::infra::fs::install_test_atomic_file_injector(Arc::new(
                    FailAtFaultPoint::fail_only(AtomicFileFaultPoint::ParentSync, sync),
                ));
                let result = if moving {
                    move_workspace_entry_blocking(
                        workspace.clone(),
                        created.handle.clone(),
                        parent,
                        &state.pgn_path_authority,
                        &state.workspace_mutation,
                        &CancellationToken::new(),
                    )
                } else {
                    rename_workspace_file_blocking(
                        workspace.clone(),
                        created.handle.clone(),
                        name.into(),
                        metadata.clone(),
                        &state.pgn_path_authority,
                        &state.workspace_mutation,
                        &CancellationToken::new(),
                    )
                };
                assert_workspace_rename_uncertainty(&result.unwrap_err());
                assert!(!root.join("before.pgn").exists());
                assert_eq!(
                    fs::read(destination.join(format!("{name}.pgn"))).unwrap(),
                    b"*"
                );
                let actual: WorkspaceMetadata = serde_json::from_slice(
                    &fs::read(destination.join(format!("{name}.info"))).unwrap(),
                )
                .unwrap();
                assert_eq!(
                    actual,
                    if moving {
                        WorkspaceMetadata::default()
                    } else {
                        metadata
                    }
                );
                assert_eq!(
                    mutation_target(&state.pgn_path_authority, &created.handle)
                        .unwrap()
                        .path(),
                    destination.join(format!("{name}.pgn")),
                );
            }
        }
    }

    #[test]
    fn folder_move_foreign_destination_sidecar_is_untouched() {
        for directory in [false, true] {
            let (_temporary, state, workspace) = workspace_state();
            let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
            fs::create_dir(root.join("X")).unwrap();
            fs::write(root.join("X/child.pgn"), b"*").unwrap();
            fs::create_dir(root.join("Archive")).unwrap();
            let foreign = root.join("Archive/X.info");
            if directory {
                fs::create_dir(&foreign).unwrap();
                fs::write(foreign.join("retained"), b"foreign bytes").unwrap();
            } else {
                fs::write(&foreign, b"foreign bytes").unwrap();
            }
            let listing = listed_workspace(&state, &workspace);
            let source = listed_directory(&listing, "X");
            let target = listed_directory(&listing, "Archive");
            move_workspace_entry_blocking(
                workspace.clone(),
                source.handle.clone(),
                target.handle.clone(),
                &state.pgn_path_authority,
                &state.workspace_mutation,
                &CancellationToken::new(),
            )
            .unwrap();
            assert_eq!(
                fs::read(if directory {
                    foreign.join("retained")
                } else {
                    foreign
                })
                .unwrap(),
                b"foreign bytes"
            );
            assert_workspace_entry_names(&root.join("Archive"), &["X", "X.info"]);
            assert!(!root.join("X").exists());
            assert_eq!(
                mutation_target(&state.pgn_path_authority, &source.handle)
                    .unwrap()
                    .path(),
                root.join("Archive/X")
            );
        }
    }

    fn listed_workspace(state: &AppState, workspace: &FileWorkspaceHandle) -> WorkspaceListing {
        let (listing, _) = collect_tree_entries(
            &state.pgn_path_authority,
            workspace,
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(listing.unread.is_empty());
        listing
    }

    fn listed_directory<'a>(listing: &'a WorkspaceListing, name: &str) -> &'a WorkspaceEntry {
        listing
            .entries
            .iter()
            .find(|entry| entry.name == name && entry.kind == WorkspaceEntryKind::Directory)
            .unwrap()
    }

    #[test]
    fn folder_move_keeps_sibling_pgn_metadata_and_allows_destination_create() {
        let (_temporary, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        fs::create_dir(root.join("Sicilian")).unwrap();
        fs::write(root.join("Sicilian/child.pgn"), b"1. e4 *").unwrap();
        fs::create_dir(root.join("Archive")).unwrap();
        let metadata = WorkspaceMetadata {
            file_type: WorkspaceFileType::Repertoire,
            tags: vec!["opening".into(), "black".into()],
        };
        create_workspace_file_blocking(
            workspace.clone(),
            workspace.clone(),
            "Sicilian".into(),
            metadata.clone(),
            WorkspaceFileContent::Text {
                pgn: "1. e4 c5 *".into(),
            },
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &state.pgn_repository,
            &CancellationToken::new(),
        )
        .unwrap();
        let original = fs::read(root.join("Sicilian.info")).unwrap();
        let listing = listed_workspace(&state, &workspace);
        let source = listed_directory(&listing, "Sicilian");
        let target = listed_directory(&listing, "Archive");
        move_workspace_entry_blocking(
            workspace.clone(),
            source.handle.clone(),
            target.handle.clone(),
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(fs::read(root.join("Sicilian.info")).unwrap(), original);
        let listing = listed_workspace(&state, &workspace);
        let sibling = listing
            .entries
            .iter()
            .find(|entry| entry.name == "Sicilian" && entry.kind == WorkspaceEntryKind::File)
            .unwrap();
        assert_eq!(sibling.metadata.as_ref(), Some(&metadata));
        assert_workspace_entry_names(&root.join("Archive"), &["Sicilian"]);
        assert_eq!(
            fs::read(root.join("Archive/Sicilian/child.pgn")).unwrap(),
            b"1. e4 *"
        );
        create_workspace_file_blocking(
            workspace.clone(),
            target.handle.clone(),
            "Sicilian".into(),
            WorkspaceMetadata::default(),
            WorkspaceFileContent::Text { pgn: "*".into() },
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &state.pgn_repository,
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(root.join("Archive/Sicilian.pgn").is_file());
        assert_eq!(fs::read(root.join("Sicilian.info")).unwrap(), original);
    }

    #[test]
    fn folder_trash_restore_keeps_sibling_pgn_sidecar_in_place() {
        let (_temporary, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        fs::create_dir(root.join("Sicilian")).unwrap();
        fs::write(root.join("Sicilian/child.pgn"), b"*").unwrap();
        let metadata = WorkspaceMetadata {
            file_type: WorkspaceFileType::Repertoire,
            tags: vec!["retained".into()],
        };
        create_workspace_file_blocking(
            workspace.clone(),
            workspace.clone(),
            "Sicilian".into(),
            metadata.clone(),
            WorkspaceFileContent::Text { pgn: "*".into() },
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &state.pgn_repository,
            &CancellationToken::new(),
        )
        .unwrap();
        let original = fs::read(root.join("Sicilian.info")).unwrap();
        let listing = listed_workspace(&state, &workspace);
        let folder = listed_directory(&listing, "Sicilian");
        let child = folder.children[0].handle.clone();
        let identity = mutation_target(&state.pgn_path_authority, &folder.handle)
            .unwrap()
            .identity;
        trash_entry(
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &workspace,
            &folder.handle,
            &CancellationToken::new(),
        )
        .unwrap();
        let trashed = mutation_target(&state.pgn_path_authority, &folder.handle).unwrap();
        assert_workspace_entry_names(trashed.path().parent().unwrap(), &["Sicilian"]);
        assert_eq!(fs::read(root.join("Sicilian.info")).unwrap(), original);
        restore_entry(
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &workspace,
            &folder.handle,
            &CancellationToken::new(),
        )
        .unwrap();
        let restored = mutation_target(&state.pgn_path_authority, &folder.handle).unwrap();
        assert_eq!(restored.path(), root.join("Sicilian"));
        assert_eq!(restored.identity, identity);
        assert_eq!(
            mutation_target(&state.pgn_path_authority, &child)
                .unwrap()
                .path(),
            root.join("Sicilian/child.pgn")
        );
        assert_eq!(fs::read(root.join("Sicilian.info")).unwrap(), original);
        let listing = listed_workspace(&state, &workspace);
        assert_eq!(
            listing
                .entries
                .iter()
                .find(|entry| entry.kind == WorkspaceEntryKind::File && entry.name == "Sicilian")
                .unwrap()
                .metadata
                .as_ref(),
            Some(&metadata)
        );
    }

    #[test]
    fn folder_move_info_directory_preserves_listed_directory_and_child_handles() {
        for sync in [None, Some(0), Some(1)] {
            assert_folder_move_info_directory("games.info", sync);
        }
    }

    #[test]
    fn folder_move_uppercase_info_directory_creates_no_sidecar() {
        for sync in [None, Some(0), Some(1)] {
            assert_folder_move_info_directory("games.INFO", sync);
        }
    }

    fn assert_folder_move_info_directory(name: &str, sync: Option<usize>) {
        let (_temporary, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        let source_path = root.join(name);
        let child_path = source_path.join("child.pgn");
        let destination = root.join("destination");
        // Existing external directories reach move through listing, without validate_name.
        fs::create_dir(&source_path).unwrap();
        fs::write(&child_path, b"1. e4 *").unwrap();
        fs::write(source_path.join("notes.txt"), b"retained directory bytes").unwrap();
        fs::create_dir(&destination).unwrap();
        let (listing, missing) = collect_tree_entries(
            &state.pgn_path_authority,
            &workspace,
            &CancellationToken::new(),
        )
        .expect("list and register the existing games.info directory");
        assert!(listing.unread.is_empty());
        assert_eq!(missing.len(), 1);
        let source = listing
            .entries
            .iter()
            .find(|entry| entry.name == name)
            .expect("existing .info directory is listed");
        assert_eq!(source.kind, WorkspaceEntryKind::Directory);
        assert!(source.metadata.is_none());
        let child = source.children.first().expect("listed child PGN");
        assert_eq!(source.children.len(), 1);
        assert_eq!(child.name, "child");
        assert_eq!(child.kind, WorkspaceEntryKind::File);
        let parent = listing
            .entries
            .iter()
            .find(|entry| entry.name == "destination")
            .expect("listed destination directory");
        let source_handle = source.handle.clone();
        let child_handle = child.handle.clone();
        let source_identity = mutation_target(&state.pgn_path_authority, &source_handle)
            .unwrap()
            .identity;
        let child_identity = mutation_target(&state.pgn_path_authority, &child_handle)
            .unwrap()
            .identity;
        assert_workspace_entry_names(&destination, &[]);

        let _injector = sync.map(|sync| {
            crate::infra::fs::install_test_atomic_file_injector(Arc::new(
                FailAtFaultPoint::fail_only(AtomicFileFaultPoint::ParentSync, sync),
            ))
        });
        let result = move_workspace_entry_blocking(
            workspace.clone(),
            source_handle.clone(),
            parent.handle.clone(),
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &CancellationToken::new(),
        );
        let refusal = result
            .as_ref()
            .err()
            .map(|error| serde_json::to_value(error).unwrap());
        if sync.is_some() {
            assert_workspace_rename_uncertainty(&result.unwrap_err());
        } else {
            assert!(
                result.is_ok(),
                "moving the listed games.info directory to an empty target should succeed, refusal: {refusal:?}"
            );
        }

        let moved_path = destination.join(name);
        assert!(!source_path.exists());
        assert!(moved_path.is_dir());
        assert_eq!(fs::read(moved_path.join("child.pgn")).unwrap(), b"1. e4 *");
        assert_eq!(
            fs::read(moved_path.join("notes.txt")).unwrap(),
            b"retained directory bytes"
        );
        assert_workspace_entry_names(&destination, &[name]);
        assert_workspace_entry_names(&moved_path, &["child.pgn", "notes.txt"]);
        let rebound = mutation_target(&state.pgn_path_authority, &source_handle).unwrap();
        assert_eq!(rebound.path(), moved_path);
        assert_eq!(rebound.identity, source_identity);
        let rebound_child = mutation_target(&state.pgn_path_authority, &child_handle).unwrap();
        assert_eq!(rebound_child.path(), moved_path.join("child.pgn"));
        assert_eq!(rebound_child.identity, child_identity);
        let mut authority = state.pgn_path_authority.raw_for_test().lock().unwrap();
        let authority = authority.as_mut().unwrap();
        assert_eq!(
            authority.parent_identity_for_test(child_handle.path_ref()),
            Some(source_identity)
        );
        assert!(authority
            .resolve(child_handle.path_ref(), PathOperation::ReadPgn, &[])
            .is_ok());
    }

    #[test]
    fn folder_move_cancellation_after_primary_compensates_with_retained_handles() {
        let (temporary, state, workspace) = workspace_state();
        let (source_path, source) = registered_child_directory(&state, &workspace, "games.info");
        let child_path = source_path.join("child.pgn");
        fs::write(&child_path, b"1. e4 *").unwrap();
        let child = registered_child_file(&state, &workspace, &child_path);
        let original = mutation_target(&state.pgn_path_authority, &source).unwrap();
        let child_identity = mutation_target(&state.pgn_path_authority, &child)
            .unwrap()
            .identity;
        let (destination, _parent) = registered_child_directory(&state, &workspace, "destination");
        let listing = listed_workspace(&state, &workspace);
        let source = listed_directory(&listing, "games.info").handle.clone();
        let child = listed_directory(&listing, "games.info").children[0]
            .handle
            .clone();
        let parent = listed_directory(&listing, "destination").handle.clone();
        let registry = fs::read(temporary.path().join("registry.json")).unwrap();
        let cancellation = CancellationToken::new();
        let token = cancellation.clone();
        let moved_path = destination.join("games.info");
        PAIRED_RENAME_POST_PRIMARY_HOOK.with(|slot| {
            assert!(slot
                .replace(Some(Box::new(move || {
                    assert!(moved_path.is_dir());
                    assert_eq!(fs::read(moved_path.join("child.pgn")).unwrap(), b"1. e4 *");
                    token.cancel();
                })))
                .is_none());
        });
        let result = move_workspace_entry_blocking(
            workspace.clone(),
            source.clone(),
            parent,
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &cancellation,
        );
        assert!(cancellation.is_cancelled());
        assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
        assert_eq!(fs::read(&child_path).unwrap(), b"1. e4 *");
        assert_eq!(fs::read(source_path.join("removed")).unwrap(), b"content");
        assert_workspace_entry_names(&destination, &["removed"]);
        assert_workspace_entry_names(&source_path, &["child.pgn", "removed"]);
        let retained = mutation_target(&state.pgn_path_authority, &source).unwrap();
        assert_eq!(retained.path(), source_path);
        assert_eq!(retained.identity, original.identity);
        let retained_child = mutation_target(&state.pgn_path_authority, &child).unwrap();
        assert_eq!(retained_child.path(), child_path);
        assert_eq!(retained_child.identity, child_identity);
        assert_eq!(
            fs::read(temporary.path().join("registry.json")).unwrap(),
            registry
        );
    }

    #[test]
    fn folder_move_primary_collision_is_typed_and_preserves_source() {
        for directory in [false, true] {
            let (temporary, state, workspace) = workspace_state();
            let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
            fs::create_dir(root.join("X")).unwrap();
            fs::write(root.join("X/child.pgn"), b"*").unwrap();
            fs::create_dir(root.join("Archive")).unwrap();
            if directory {
                fs::create_dir(root.join("Archive/X")).unwrap();
            } else {
                fs::write(root.join("Archive/X"), b"foreign bytes").unwrap();
            }
            let listing = listed_workspace(&state, &workspace);
            let source = listed_directory(&listing, "X");
            let target = listed_directory(&listing, "Archive");
            let original = mutation_target(&state.pgn_path_authority, &source.handle).unwrap();
            let registry = fs::read(temporary.path().join("registry.json")).unwrap();
            let result = move_workspace_entry_blocking(
                workspace.clone(),
                source.handle.clone(),
                target.handle.clone(),
                &state.pgn_path_authority,
                &state.workspace_mutation,
                &CancellationToken::new(),
            );
            assert_name_taken(&result.unwrap_err());
            assert_eq!(fs::read(root.join("X/child.pgn")).unwrap(), b"*");
            let retained = mutation_target(&state.pgn_path_authority, &source.handle).unwrap();
            assert_eq!(retained.path(), original.path());
            assert_eq!(retained.identity, original.identity);
            assert_eq!(
                fs::read(temporary.path().join("registry.json")).unwrap(),
                registry
            );
            if !directory {
                assert_eq!(fs::read(root.join("Archive/X")).unwrap(), b"foreign bytes");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn folder_move_compensation_refuses_substituted_primary() {
        let (temporary, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        let (source_path, source) = registered_child_directory(&state, &workspace, "games.info");
        let (destination, parent) = registered_child_directory(&state, &workspace, "destination");
        let moved_path = destination.join("games.info");
        let parked = root.join("parked");
        let registry = fs::read(temporary.path().join("registry.json")).unwrap();
        let cancellation = CancellationToken::new();
        let token = cancellation.clone();
        let moved_hook = moved_path.clone();
        let parked_hook = parked.clone();
        PAIRED_RENAME_POST_PRIMARY_HOOK.with(|slot| {
            assert!(slot
                .replace(Some(Box::new(move || {
                    fs::rename(&moved_hook, &parked_hook).unwrap();
                    fs::create_dir(&moved_hook).unwrap();
                    fs::write(moved_hook.join("foreign"), b"replacement bytes").unwrap();
                    token.cancel();
                })))
                .is_none());
        });
        let error = move_workspace_entry_blocking(
            workspace.clone(),
            source,
            parent,
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &cancellation,
        )
        .unwrap_err();
        // Exact-object compensation cannot move the replacement back.
        assert_eq!(error.category(), ErrorCategory::OperationAndCleanup);
        let payload = serde_json::to_value(&error).unwrap();
        assert!(payload.get("nameTaken").is_none(), "{payload}");
        assert!(!source_path.exists());
        assert_eq!(fs::read(parked.join("removed")).unwrap(), b"content");
        assert_eq!(
            fs::read(moved_path.join("foreign")).unwrap(),
            b"replacement bytes"
        );
        assert_workspace_entry_names(&destination, &["games.info", "removed"]);
        assert_workspace_entry_names(&moved_path, &["foreign"]);
        assert_eq!(
            fs::read(temporary.path().join("registry.json")).unwrap(),
            registry
        );
    }

    #[test]
    fn folder_move_absent_sidecar_finishes_success_and_each_committed_uncertainty() {
        for sync in [None, Some(0), Some(1)] {
            let (_temporary, state, workspace) = workspace_state();
            let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
            let (source_path, source) = registered_child_directory(&state, &workspace, "before");
            let child_path = source_path.join("child.pgn");
            fs::write(&child_path, b"*").unwrap();
            let child = registered_child_file(&state, &workspace, &child_path);
            let original = mutation_target(&state.pgn_path_authority, &source).unwrap();
            let child_identity = mutation_target(&state.pgn_path_authority, &child)
                .unwrap()
                .identity;
            let (destination, _parent) =
                registered_child_directory(&state, &workspace, "destination");
            let listing = listed_workspace(&state, &workspace);
            let source = listed_directory(&listing, "before").handle.clone();
            let parent = listed_directory(&listing, "destination").handle.clone();
            assert!(!root.join("before.info").exists());
            let _injector = sync.map(|sync| {
                crate::infra::fs::install_test_atomic_file_injector(Arc::new(
                    FailAtFaultPoint::fail_only(AtomicFileFaultPoint::ParentSync, sync),
                ))
            });
            let result = move_workspace_entry_blocking(
                workspace.clone(),
                source.clone(),
                parent,
                &state.pgn_path_authority,
                &state.workspace_mutation,
                &CancellationToken::new(),
            );
            if sync.is_some() {
                assert_workspace_rename_uncertainty(&result.unwrap_err());
            } else {
                result.unwrap();
            }
            assert!(!source_path.exists());
            assert!(!root.join("before.info").exists());
            assert_eq!(
                fs::read(destination.join("before/removed")).unwrap(),
                b"content"
            );
            assert_eq!(
                fs::read(destination.join("before/child.pgn")).unwrap(),
                b"*"
            );
            assert!(!destination.join("before.info").exists());
            assert_workspace_entry_names(&destination, &["before", "removed"]);
            let rebound = mutation_target(&state.pgn_path_authority, &source).unwrap();
            assert_eq!(rebound.path(), destination.join("before"));
            assert_eq!(rebound.identity, original.identity);
            let rebound_child = mutation_target(&state.pgn_path_authority, &child).unwrap();
            assert_eq!(rebound_child.path(), destination.join("before/child.pgn"));
            assert_eq!(rebound_child.identity, child_identity);
        }
    }

    #[test]
    fn absent_sidecar_refusal_keeps_exact_object_cleanup_and_cleanup_payload_priority() {
        for replaced_target in [false, true] {
            let (temporary, state, workspace) = workspace_state();
            let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
            let created = create_named_text(&state, &workspace, "before", "*").unwrap();
            fs::remove_file(root.join("before.info")).unwrap();
            let registry = fs::read(temporary.path().join("registry.json")).unwrap();
            let observed = root.clone();
            PAIRED_RENAME_POST_PRIMARY_HOOK.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(move || {
                    fs::write(observed.join("after.info"), b"unrelated metadata").unwrap();
                    if replaced_target {
                        fs::rename(observed.join("after.pgn"), observed.join("parked.pgn"))
                            .unwrap();
                        fs::write(observed.join("after.pgn"), b"unrelated target").unwrap();
                    } else {
                        fs::write(observed.join("before.pgn"), b"unrelated source").unwrap();
                    }
                }));
            });
            let error = rename_workspace_file_blocking(
                workspace.clone(),
                created.handle.clone(),
                "after".into(),
                WorkspaceMetadata::default(),
                &state.pgn_path_authority,
                &state.workspace_mutation,
                &CancellationToken::new(),
            )
            .unwrap_err();
            let payload = serde_json::to_value(&error).unwrap();
            assert_eq!(payload["category"], "operation-and-cleanup");
            assert!(payload.get("nameTaken").is_none());
            assert_eq!(
                fs::read(root.join("after.info")).unwrap(),
                b"unrelated metadata"
            );
            if replaced_target {
                assert_eq!(
                    fs::read(root.join("after.pgn")).unwrap(),
                    b"unrelated target"
                );
                assert_eq!(fs::read(root.join("parked.pgn")).unwrap(), b"*");
                assert!(!root.join("before.pgn").exists());
            } else {
                assert_eq!(
                    fs::read(root.join("before.pgn")).unwrap(),
                    b"unrelated source"
                );
                assert_eq!(fs::read(root.join("after.pgn")).unwrap(), b"*");
            }
            assert_eq!(
                fs::read(temporary.path().join("registry.json")).unwrap(),
                registry
            );
        }
    }

    #[test]
    fn rename_workspace_file_completes_after_either_namespace_sync_is_uncertain() {
        for sync in [0, 1] {
            let (_directory, state, root, handle, result) = rename_under_injector(Some(Arc::new(
                FailAtFaultPoint::fail_only(AtomicFileFaultPoint::ParentSync, sync),
            )));
            let error = result.expect_err("committed rename uncertainty");
            assert_workspace_rename_uncertainty(&error);
            assert_rename_landed(&state, &root, &handle);
        }
    }

    fn assert_workspace_rename_uncertainty(error: &Error) {
        assert!(
            matches!(
                error,
                Error::CommittedDurabilityUncertain(crate::error::DurabilityStage::WorkspaceRename)
            ),
            "{error:?}"
        );
        let payload = serde_json::to_value(error).unwrap();
        assert_eq!(payload["category"], "durability");
        assert_eq!(
            payload["message"],
            "Committed but durability uncertain: workspace rename"
        );
        assert!(!payload.to_string().contains("injected"));
    }

    #[test]
    fn rename_namespace_uncertainty_keeps_first_stage_and_later_hard_failure_precedence() {
        let (_directory, state, root, handle, result) = rename_under_injector(Some(Arc::new(
            crate::infra::fs::ParentSyncFault("all parent syncs"),
        )));
        assert_workspace_rename_uncertainty(&result.unwrap_err());
        assert_rename_landed(&state, &root, &handle);

        // The sidecar rewrite and registry rebind remain the two atomic Rename points.
        for rename in [0, 1] {
            let capture = crate::error::LogCaptureScope::start();
            let (_directory, state, root, handle, result) = rename_under_injector(Some(Arc::new(
                FailAtFaultPoint::fail_only(AtomicFileFaultPoint::ParentSync, 0).and(
                    FailAtFaultPoint::fail_from(AtomicFileFaultPoint::Rename, rename),
                ),
            )));
            let error = result.unwrap_err();
            if rename == 0 {
                assert!(matches!(error, Error::Io(_)), "{error:?}");
                assert!(root.join("before.pgn").is_file());
                assert!(root.join("before.info").is_file());
                assert!(!root.join("after.pgn").exists());
                assert!(!root.join("after.info").exists());
                assert_eq!(
                    mutation_target(&state.pgn_path_authority, &handle)
                        .unwrap()
                        .path(),
                    root.join("before.pgn")
                );
            } else {
                let Error::OperationAndCleanup { primary, .. } = &error else {
                    panic!("{error:?}")
                };
                assert!(primary.contains("injected atomic-file fault"));
                // The same fault also refuses the byte restoration before publication.
                assert!(root.join("after.pgn").is_file());
                assert!(root.join("after.info").is_file());
            }
            assert!(capture.messages().iter().any(|line| line
                .contains("workspace completion failed after uncertainty at workspace rename")));
        }
    }

    #[test]
    fn durable_workspace_renames_compensate_rebind_failure() {
        for (operation, is_dir, missing_sidecar) in [
            ("rename", false, false),
            ("rename", false, true),
            ("move", false, false),
            ("move", false, true),
            ("move", true, false),
            ("move", true, true),
            ("trash", false, false),
            ("trash", false, true),
            ("trash", true, true),
            ("restore", false, false),
            ("restore", false, true),
            ("restore", true, true),
        ] {
            let (temporary, state, workspace) = workspace_state();
            let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
            let created = if is_dir {
                create_named_directory(&state, &workspace, "before").unwrap()
            } else {
                create_named_text(&state, &workspace, "before", "*").unwrap()
            };
            let child = if is_dir {
                let path = root.join("before/child.pgn");
                fs::write(&path, b"child bytes").unwrap();
                Some(registered_child_file(&state, &workspace, &path))
            } else {
                None
            };
            if !missing_sidecar {
                fs::write(root.join("before.info"), b"original metadata bytes").unwrap();
            } else if root.join("before.info").exists() {
                fs::remove_file(root.join("before.info")).unwrap();
            }
            let (destination, parent) =
                registered_child_directory(&state, &workspace, "destination");
            if operation == "restore" {
                trash_entry(
                    &state.pgn_path_authority,
                    &state.workspace_mutation,
                    &workspace,
                    &created.handle,
                    &CancellationToken::new(),
                )
                .unwrap();
            }
            let source = mutation_target(&state.pgn_path_authority, &created.handle).unwrap();
            let child_before = child
                .as_ref()
                .map(|handle| mutation_target(&state.pgn_path_authority, handle).unwrap());
            let source_info = source.path().with_extension("info");
            let registry = fs::read(temporary.path().join("registry.json")).unwrap();
            WORKSPACE_REBIND_PRE_REGISTER_HOOK.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(|| {
                    Err(Error::Io(Box::new(std::io::Error::other(
                        "ordinary rebind failure",
                    ))))
                }))
            });
            let result = match operation {
                "rename" => rename_workspace_file_blocking(
                    workspace.clone(),
                    created.handle.clone(),
                    "after".into(),
                    WorkspaceMetadata::default(),
                    &state.pgn_path_authority,
                    &state.workspace_mutation,
                    &CancellationToken::new(),
                ),
                "move" => move_workspace_entry_blocking(
                    workspace.clone(),
                    created.handle.clone(),
                    parent,
                    &state.pgn_path_authority,
                    &state.workspace_mutation,
                    &CancellationToken::new(),
                ),
                "trash" => trash_entry(
                    &state.pgn_path_authority,
                    &state.workspace_mutation,
                    &workspace,
                    &created.handle,
                    &CancellationToken::new(),
                ),
                "restore" => restore_entry(
                    &state.pgn_path_authority,
                    &state.workspace_mutation,
                    &workspace,
                    &created.handle,
                    &CancellationToken::new(),
                ),
                _ => unreachable!(),
            };
            let error = result.unwrap_err();
            assert!(
                matches!(error, Error::Io(_)),
                "{operation} {is_dir} {missing_sidecar}: {error:?}"
            );
            let retained = mutation_target(&state.pgn_path_authority, &created.handle).unwrap();
            assert_eq!(retained.path(), source.path());
            assert_eq!(retained.identity, source.identity);
            if let Some(child_before) = child_before {
                let retained =
                    mutation_target(&state.pgn_path_authority, child.as_ref().unwrap()).unwrap();
                assert_eq!(retained.path(), child_before.path());
                assert_eq!(retained.identity, child_before.identity);
                assert_eq!(fs::read(retained.path()).unwrap(), b"child bytes");
            } else {
                assert_eq!(fs::read(source.path()).unwrap(), b"*");
            }
            if missing_sidecar {
                assert!(!source_info.exists());
            } else {
                assert_eq!(fs::read(source_info).unwrap(), b"original metadata bytes");
            }
            assert!(!root.join("after.pgn").exists());
            assert!(!root.join("after.info").exists());
            assert!(!destination.join(&source.leaf).exists());
            assert!(!destination
                .join(sidecar_leaf(&source.leaf).unwrap())
                .exists());
            if operation == "trash" {
                assert!(root.join(TRASH_DIRECTORY).is_dir());
                assert_eq!(fs::read_dir(root.join(TRASH_DIRECTORY)).unwrap().count(), 0);
            }
            if operation == "restore" {
                assert!(!root.join(&source.leaf).exists());
            }
            assert_eq!(
                fs::read(temporary.path().join("registry.json")).unwrap(),
                registry
            );
        }
    }

    #[test]
    fn rename_metadata_compensation_tracks_each_installed_identity() {
        const METADATA_REWRITE_PARENT_SYNC: usize = 2;
        const BYTE_RESTORATION_PARENT_SYNC: usize = 3;
        for uncertain_sync in [
            None,
            Some(METADATA_REWRITE_PARENT_SYNC),
            Some(BYTE_RESTORATION_PARENT_SYNC),
        ] {
            let (temporary, state, workspace) = workspace_state();
            let created = create_named_text(&state, &workspace, "before", "*").unwrap();
            let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
            let original = b" { \"type\": \"game\", \"tags\": [\"saved\"] } \n";
            fs::write(root.join("before.info"), original).unwrap();
            let source = mutation_target(&state.pgn_path_authority, &created.handle).unwrap();
            let old_identity = crate::infra::fs::entry_identity_at(
                &source.parent,
                OsStr::new("before.info"),
                false,
            )
            .unwrap();
            let registry = fs::read(temporary.path().join("registry.json")).unwrap();
            let observed = root.clone();
            WORKSPACE_REBIND_PRE_REGISTER_HOOK.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(move || {
                    assert_ne!(fs::read(observed.join("after.info")).unwrap(), original);
                    let parent =
                        crate::infra::fs::open_parent_no_follow(&observed.join("after.info"))
                            .unwrap();
                    assert_ne!(
                        crate::infra::fs::entry_identity_at(
                            &parent,
                            OsStr::new("after.info"),
                            false
                        )
                        .unwrap(),
                        old_identity
                    );
                    Err(Error::Io(Box::new(std::io::Error::other(
                        "ordinary rebind failure",
                    ))))
                }))
            });
            let _injector = uncertain_sync.map(|index| {
                crate::infra::fs::install_test_atomic_file_injector(Arc::new(
                    FailAtFaultPoint::fail_only(AtomicFileFaultPoint::ParentSync, index),
                ))
            });
            let error = rename_workspace_file_blocking(
                workspace.clone(),
                created.handle.clone(),
                "after".into(),
                WorkspaceMetadata::default(),
                &state.pgn_path_authority,
                &state.workspace_mutation,
                &CancellationToken::new(),
            )
            .unwrap_err();
            if uncertain_sync == Some(BYTE_RESTORATION_PARENT_SYNC) {
                let Error::OperationAndCleanup { primary, cleanup } = &error else {
                    panic!("{error:?}")
                };
                assert!(primary.contains("ordinary rebind failure"));
                assert!(cleanup.contains("workspace sidecar replacement"));
            } else {
                assert!(matches!(error, Error::Io(_)), "{error:?}");
                assert!(error.diagnostic().contains("ordinary rebind failure"));
            }
            assert_eq!(fs::read(root.join("before.info")).unwrap(), original);
            assert_eq!(fs::read(root.join("before.pgn")).unwrap(), b"*");
            assert!(!root.join("after.info").exists());
            assert!(!root.join("after.pgn").exists());
            assert_eq!(
                mutation_target(&state.pgn_path_authority, &created.handle)
                    .unwrap()
                    .identity,
                source.identity
            );
            assert_eq!(
                fs::read(temporary.path().join("registry.json")).unwrap(),
                registry
            );
        }
    }

    #[test]
    fn workspace_rename_compensation_leaves_substituted_objects() {
        for object in ["primary", "moved", "created", "rewritten"] {
            let (temporary, state, workspace) = workspace_state();
            let created = create_named_text(&state, &workspace, "before", "*").unwrap();
            let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
            if object == "created" {
                fs::remove_file(root.join("before.info")).unwrap();
            }
            let source = mutation_target(&state.pgn_path_authority, &created.handle).unwrap();
            let (destination, parent) =
                registered_child_directory(&state, &workspace, "destination");
            let target = if object == "rewritten" {
                root.join("after.pgn")
            } else {
                destination.join("before.pgn")
            };
            let substituted = if object == "primary" {
                target.clone()
            } else {
                target.with_extension("info")
            };
            let parked = root.join("parked");
            let observed = substituted.clone();
            let parked_hook = parked.clone();
            let registry = fs::read(temporary.path().join("registry.json")).unwrap();
            WORKSPACE_REBIND_PRE_REGISTER_HOOK.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(move || {
                    fs::rename(&observed, &parked_hook).unwrap();
                    fs::write(&observed, b"substitute bytes").unwrap();
                    Err(Error::Io(Box::new(std::io::Error::other(
                        "ordinary rebind failure",
                    ))))
                }))
            });
            let result = if object == "rewritten" {
                rename_workspace_file_blocking(
                    workspace.clone(),
                    created.handle.clone(),
                    "after".into(),
                    WorkspaceMetadata::default(),
                    &state.pgn_path_authority,
                    &state.workspace_mutation,
                    &CancellationToken::new(),
                )
            } else {
                move_workspace_entry_blocking(
                    workspace.clone(),
                    created.handle.clone(),
                    parent,
                    &state.pgn_path_authority,
                    &state.workspace_mutation,
                    &CancellationToken::new(),
                )
            };
            let error = result.unwrap_err();
            assert_eq!(
                error.category(),
                ErrorCategory::OperationAndCleanup,
                "{object}: {error:?}"
            );
            let Error::OperationAndCleanup { primary, .. } = &error else {
                panic!("{error:?}")
            };
            assert!(primary.contains("ordinary rebind failure"));
            assert_eq!(fs::read(&substituted).unwrap(), b"substitute bytes");
            assert!(parked.is_file());
            assert!(!source.path().exists());
            if object != "primary" {
                assert_eq!(
                    crate::infra::fs::entry_identity_at(
                        &crate::infra::fs::open_parent_no_follow(&target).unwrap(),
                        target.file_name().unwrap(),
                        false
                    )
                    .unwrap(),
                    source.identity
                );
                assert!(!root.join("before.info").exists());
            } else {
                assert!(root.join("before.info").is_file());
                assert_eq!(fs::read(&parked).unwrap(), b"*");
            }
            assert_eq!(
                fs::read(temporary.path().join("registry.json")).unwrap(),
                registry
            );
        }
    }

    #[test]
    fn sidecar_reverse_uncertainty_continues_primary_but_precommit_failure_stops_it() {
        for precommit_failure in [false, true] {
            let (temporary, state, workspace) = workspace_state();
            let created = create_named_text(&state, &workspace, "before", "*").unwrap();
            let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
            let source = mutation_target(&state.pgn_path_authority, &created.handle).unwrap();
            let (destination, parent) =
                registered_child_directory(&state, &workspace, "destination");
            let sidecar_identity = crate::infra::fs::entry_identity_at(
                &source.parent,
                OsStr::new("before.info"),
                false,
            )
            .unwrap();
            let observed = root.clone();
            let registry = fs::read(temporary.path().join("registry.json")).unwrap();
            WORKSPACE_REBIND_PRE_REGISTER_HOOK.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(move || {
                    if precommit_failure {
                        fs::write(observed.join("before.info"), b"occupied source").unwrap();
                    }
                    Err(Error::Io(Box::new(std::io::Error::other(
                        "ordinary rebind failure",
                    ))))
                }))
            });
            // Each cross-directory forward rename syncs both parents. The fifth sync belongs to the sidecar reverse.
            let _injector = crate::infra::fs::install_test_atomic_file_injector(Arc::new(
                FailAtFaultPoint::fail_only(AtomicFileFaultPoint::ParentSync, 4),
            ));
            let error = move_workspace_entry_blocking(
                workspace.clone(),
                created.handle.clone(),
                parent,
                &state.pgn_path_authority,
                &state.workspace_mutation,
                &CancellationToken::new(),
            )
            .unwrap_err();
            assert_eq!(error.category(), ErrorCategory::OperationAndCleanup);
            let Error::OperationAndCleanup { primary, cleanup } = &error else {
                panic!("{error:?}")
            };
            assert!(primary.contains("ordinary rebind failure"));
            if precommit_failure {
                assert!(!source.path().exists());
                let destination_parent = crate::infra::fs::open_directory_at(
                    &source.parent,
                    OsStr::new("destination"),
                    true,
                )
                .unwrap();
                assert_eq!(
                    crate::infra::fs::entry_identity_at(&destination_parent, &source.leaf, false)
                        .unwrap(),
                    source.identity
                );
                assert_eq!(
                    crate::infra::fs::entry_identity_at(
                        &destination_parent,
                        OsStr::new("before.info"),
                        false
                    )
                    .unwrap(),
                    sidecar_identity
                );
                assert_eq!(
                    fs::read(root.join("before.info")).unwrap(),
                    b"occupied source"
                );
            } else {
                assert!(cleanup.contains("workspace rename"));
                assert_eq!(
                    crate::infra::fs::entry_identity_at(&source.parent, &source.leaf, false)
                        .unwrap(),
                    source.identity
                );
                assert_eq!(
                    crate::infra::fs::entry_identity_at(
                        &source.parent,
                        OsStr::new("before.info"),
                        false
                    )
                    .unwrap(),
                    sidecar_identity
                );
                assert!(!destination.join("before.pgn").exists());
                assert!(!destination.join("before.info").exists());
            }
            assert_eq!(
                fs::read(temporary.path().join("registry.json")).unwrap(),
                registry
            );
        }
    }

    #[test]
    fn cancellation_after_workspace_pair_compensates() {
        let (temporary, state, workspace) = workspace_state();
        let created = create_named_text(&state, &workspace, "before", "*").unwrap();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        let (destination, parent) = registered_child_directory(&state, &workspace, "destination");
        let registry = fs::read(temporary.path().join("registry.json")).unwrap();
        let token = CancellationToken::new();
        let cancel = token.clone();
        PAIRED_RENAME_POST_PRIMARY_HOOK
            .with(|slot| *slot.borrow_mut() = Some(Box::new(move || cancel.cancel())));
        let error = move_workspace_entry_blocking(
            workspace.clone(),
            created.handle.clone(),
            parent,
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &token,
        )
        .unwrap_err();
        assert!(matches!(error, Error::Cancellation), "{error:?}");
        assert_eq!(fs::read(root.join("before.pgn")).unwrap(), b"*");
        assert!(root.join("before.info").is_file());
        assert!(!destination.join("before.pgn").exists());
        assert!(!destination.join("before.info").exists());
        assert_eq!(
            mutation_target(&state.pgn_path_authority, &created.handle)
                .unwrap()
                .path(),
            root.join("before.pgn")
        );
        assert_eq!(
            fs::read(temporary.path().join("registry.json")).unwrap(),
            registry
        );
    }

    #[cfg(unix)]
    #[test]
    fn created_sidecar_removal_uncertainty_continues_primary() {
        for point in [
            RemovalFaultPoint::BeforeTopOpen,
            RemovalFaultPoint::ParentSync,
        ] {
            let (temporary, state, workspace) = workspace_state();
            let created = create_named_text(&state, &workspace, "before", "*").unwrap();
            let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
            fs::remove_file(root.join("before.info")).unwrap();
            let source = mutation_target(&state.pgn_path_authority, &created.handle).unwrap();
            let registry = fs::read(temporary.path().join("registry.json")).unwrap();
            WORKSPACE_REBIND_PRE_REGISTER_HOOK.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(|| {
                    Err(Error::Io(Box::new(std::io::Error::other(
                        "ordinary rebind failure",
                    ))))
                }))
            });
            set_test_removal_injector(Some(Arc::new(RemovalFault(point))));
            let result = rename_workspace_file_blocking(
                workspace.clone(),
                created.handle.clone(),
                "after".into(),
                WorkspaceMetadata::default(),
                &state.pgn_path_authority,
                &state.workspace_mutation,
                &CancellationToken::new(),
            );
            set_test_removal_injector(None);
            let error = result.unwrap_err();
            assert_eq!(error.category(), ErrorCategory::OperationAndCleanup);
            let Error::OperationAndCleanup { primary, cleanup } = &error else {
                panic!("{error:?}")
            };
            assert!(primary.contains("ordinary rebind failure"));
            assert!(!root.join("before.info").exists());
            if matches!(point, RemovalFaultPoint::ParentSync) {
                assert!(cleanup.contains("workspace removal"));
                assert!(!root.join("after.info").exists());
                assert!(!root.join("after.pgn").exists());
                assert_eq!(
                    mutation_target(&state.pgn_path_authority, &created.handle)
                        .unwrap()
                        .identity,
                    source.identity
                );
            } else {
                assert!(root.join("after.info").is_file());
                assert!(!source.path().exists());
                assert_eq!(
                    crate::infra::fs::entry_identity_at(
                        &source.parent,
                        OsStr::new("after.pgn"),
                        false
                    )
                    .unwrap(),
                    source.identity
                );
            }
            assert_eq!(
                fs::read(temporary.path().join("registry.json")).unwrap(),
                registry
            );
        }
    }

    #[test]
    fn directory_compensation_reverses_only_primary() {
        let (temporary, state, workspace) = workspace_state();
        let (source_path, created) = registered_child_directory(&state, &workspace, "games.info");
        fs::write(source_path.join("child.pgn"), b"child bytes").unwrap();
        let source = mutation_target(&state.pgn_path_authority, &created).unwrap();
        let (destination, parent) = registered_child_directory(&state, &workspace, "destination");
        let registry = fs::read(temporary.path().join("registry.json")).unwrap();
        WORKSPACE_REBIND_PRE_REGISTER_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(|| {
                Err(Error::Io(Box::new(std::io::Error::other(
                    "ordinary rebind failure",
                ))))
            }))
        });
        let error = move_workspace_entry_blocking(
            workspace.clone(),
            created.clone(),
            parent,
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &CancellationToken::new(),
        )
        .unwrap_err();
        assert!(matches!(error, Error::Io(_)), "{error:?}");
        assert_eq!(
            fs::read(source_path.join("child.pgn")).unwrap(),
            b"child bytes"
        );
        assert!(!destination.join("games.info").exists());
        assert_eq!(
            mutation_target(&state.pgn_path_authority, &created)
                .unwrap()
                .identity,
            source.identity
        );
        assert_eq!(
            fs::read(temporary.path().join("registry.json")).unwrap(),
            registry
        );
    }

    #[cfg(unix)]
    #[test]
    fn trash_compensation_bucket_removal_failure_preserves_restored_entry() {
        for point in [
            RemovalFaultPoint::BeforeTopOpen,
            RemovalFaultPoint::ParentSync,
        ] {
            let (temporary, state, workspace) = workspace_state();
            let created = create_named_text(&state, &workspace, "before", "*").unwrap();
            let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
            let registry = fs::read(temporary.path().join("registry.json")).unwrap();
            WORKSPACE_REBIND_PRE_REGISTER_HOOK.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(|| {
                    Err(Error::Io(Box::new(std::io::Error::other(
                        "ordinary rebind failure",
                    ))))
                }))
            });
            set_test_removal_injector(Some(Arc::new(RemovalFault(point))));
            let result = trash_entry(
                &state.pgn_path_authority,
                &state.workspace_mutation,
                &workspace,
                &created.handle,
                &CancellationToken::new(),
            );
            set_test_removal_injector(None);
            let error = result.unwrap_err();
            assert_eq!(error.category(), ErrorCategory::OperationAndCleanup);
            let Error::OperationAndCleanup { primary, cleanup } = &error else {
                panic!("{error:?}")
            };
            assert!(primary.contains("ordinary rebind failure"));
            if matches!(point, RemovalFaultPoint::ParentSync) {
                assert!(cleanup.contains("workspace removal"));
            }
            assert_eq!(fs::read(root.join("before.pgn")).unwrap(), b"*");
            assert!(root.join("before.info").is_file());
            assert!(root.join(TRASH_DIRECTORY).is_dir());
            assert_eq!(
                fs::read_dir(root.join(TRASH_DIRECTORY)).unwrap().count(),
                if matches!(point, RemovalFaultPoint::BeforeTopOpen) {
                    1
                } else {
                    0
                }
            );
            assert_eq!(
                mutation_target(&state.pgn_path_authority, &created.handle)
                    .unwrap()
                    .path(),
                root.join("before.pgn")
            );
            assert_eq!(
                fs::read(temporary.path().join("registry.json")).unwrap(),
                registry
            );
        }
    }

    #[test]
    fn paired_rename_compensates_only_sidecar_precommit_failure() {
        for uncertain_rollback in [false, true] {
            let (_directory, state, workspace) = workspace_state();
            let created = create_named_text(&state, &workspace, "before", "*").unwrap();
            let source = mutation_target(&state.pgn_path_authority, &created.handle).unwrap();
            let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
            fs::write(root.join("after.info"), b"occupied").unwrap();
            let _reset = crate::infra::fs::install_test_atomic_file_injector(Arc::new(
                FailAtFaultPoint::fail_only(
                    AtomicFileFaultPoint::ParentSync,
                    if uncertain_rollback { 1 } else { 0 },
                ),
            ));
            let error =
                paired_rename(&source, &source.parent, OsStr::new("after.pgn")).unwrap_err();
            if uncertain_rollback {
                let Error::OperationAndCleanup { cleanup, .. } = &error else {
                    panic!("{error:?}")
                };
                assert!(cleanup.contains("workspace rename"), "{cleanup}");
                assert_eq!(
                    serde_json::to_value(&error).unwrap()["category"],
                    "operation-and-cleanup"
                );
            } else {
                assert!(
                    !matches!(
                        error,
                        Error::OperationAndCleanup { .. } | Error::CommittedDurabilityUncertain(_)
                    ),
                    "{error:?}"
                );
            }
            assert_eq!(fs::read(root.join("before.pgn")).unwrap(), b"*");
            assert!(!root.join("after.pgn").exists());
            assert!(root.join("before.info").is_file());
            assert_eq!(fs::read(root.join("after.info")).unwrap(), b"occupied");
            let rebound = mutation_target(&state.pgn_path_authority, &created.handle).unwrap();
            assert_eq!(rebound.path(), root.join("before.pgn"));
            assert_eq!(rebound.identity, source.identity);
        }
    }

    #[test]
    fn paired_rename_absent_sidecar_preserves_primary_uncertainty() {
        let (_directory, state, workspace) = workspace_state();
        let created = create_named_text(&state, &workspace, "before", "*").unwrap();
        let source = mutation_target(&state.pgn_path_authority, &created.handle).unwrap();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        fs::remove_file(root.join("before.info")).unwrap();
        let _reset = crate::infra::fs::install_test_atomic_file_injector(Arc::new(
            crate::infra::fs::ParentSyncFault("primary only"),
        ));
        let outcome = paired_rename(&source, &source.parent, OsStr::new("after.pgn")).unwrap();
        assert!(matches!(
            outcome,
            crate::infra::fs::AtomicFileOutcome::CommittedDurabilityUncertain(_)
        ));
        assert_eq!(fs::read(root.join("after.pgn")).unwrap(), b"*");
        assert!(!root.join("before.pgn").exists());
        assert!(!root.join("before.info").exists());
        assert!(!root.join("after.info").exists());
    }

    #[test]
    fn paired_rename_retains_first_native_sync_cause_and_logs_the_next() {
        struct SyncCause(AtomicUsize);
        impl AtomicWriterInjector for SyncCause {
            fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
                if point == AtomicFileFaultPoint::ParentSync {
                    return Err(std::io::Error::other(format!(
                        "pair sync {}",
                        self.0.fetch_add(1, Ordering::SeqCst)
                    )));
                }
                Ok(())
            }
        }
        let (_directory, state, workspace) = workspace_state();
        let created = create_named_text(&state, &workspace, "before", "*").unwrap();
        let source = mutation_target(&state.pgn_path_authority, &created.handle).unwrap();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        let sidecar = fs::read(root.join("before.info")).unwrap();
        let _reset = crate::infra::fs::install_test_atomic_file_injector(Arc::new(SyncCause(
            AtomicUsize::new(0),
        )));
        let capture = crate::error::LogCaptureScope::start();
        let outcome = paired_rename(&source, &source.parent, OsStr::new("after.pgn")).unwrap();
        assert!(
            matches!(outcome, crate::infra::fs::AtomicFileOutcome::CommittedDurabilityUncertain(ref cause) if cause.to_string() == "pair sync 0")
        );
        assert!(capture
            .messages()
            .iter()
            .any(|line| line.contains("pair sync 1")));
        assert_eq!(fs::read(root.join("after.pgn")).unwrap(), b"*");
        assert_eq!(fs::read(root.join("after.info")).unwrap(), sidecar);
        assert!(!root.join("before.pgn").exists());
        assert!(!root.join("before.info").exists());
    }

    struct WorkspaceRenameScenario {
        command: QueuedWorkspaceCommand,
        directory: bool,
        root: PathBuf,
        entry: FileWorkspaceHandle,
        file: FileWorkspaceHandle,
        original_path: PathBuf,
        identity: (u64, u64),
        info_bytes: Vec<u8>,
    }

    impl WorkspaceRenameScenario {
        fn prepare(
            state: &AppState,
            workspace: &FileWorkspaceHandle,
            command: QueuedWorkspaceCommand,
            directory: bool,
        ) -> Self {
            let root = workspace_root(&state.pgn_path_authority, workspace).unwrap();
            let origin = create_named_directory(state, workspace, "origin").unwrap();
            let source_dir = create_workspace_directory_inner(
                workspace.clone(),
                origin.handle.clone(),
                "source".into(),
                &state.pgn_path_authority,
                &state.workspace_mutation,
                &CancellationToken::new(),
            )
            .unwrap();
            let parent = if directory {
                &source_dir.handle
            } else {
                &origin.handle
            };
            let created = create_workspace_file_blocking(
                workspace.clone(),
                parent.clone(),
                "before".into(),
                WorkspaceMetadata {
                    file_type: WorkspaceFileType::Game,
                    tags: vec!["preserved".into()],
                },
                WorkspaceFileContent::Text {
                    pgn: "1. e4 *".into(),
                },
                &state.pgn_path_authority,
                &state.workspace_mutation,
                &state.pgn_repository,
                &CancellationToken::new(),
            )
            .unwrap();
            let original = mutation_target(&state.pgn_path_authority, &created.handle).unwrap();
            let original_path = original.path().to_path_buf();
            let info_bytes = fs::read(original_path.with_extension("info")).unwrap();
            Self {
                command,
                directory,
                root,
                entry: if directory {
                    source_dir.handle
                } else {
                    created.handle.clone()
                },
                file: created.handle,
                original_path,
                identity: original.identity,
                info_bytes,
            }
        }

        fn prepare_invocation(&self, state: &AppState, workspace: &FileWorkspaceHandle) -> PathBuf {
            if matches!(self.command, QueuedWorkspaceCommand::Restore) {
                trash_entry(
                    &state.pgn_path_authority,
                    &state.workspace_mutation,
                    workspace,
                    &self.entry,
                    &CancellationToken::new(),
                )
                .unwrap();
            }
            mutation_target(&state.pgn_path_authority, &self.entry)
                .unwrap()
                .path()
                .to_path_buf()
        }

        fn sync_fault_indices(command: QueuedWorkspaceCommand, directory: bool) -> [usize; 2] {
            // Cross-parent file pairs sync both primary parents before the sidecar.
            // Directory renames instead exercise the source and target parent syncs.
            let later = if !directory && !matches!(command, QueuedWorkspaceCommand::Rename) {
                2
            } else {
                1
            };
            // A fresh trash operation syncs its hidden directory and bucket first.
            let setup = if matches!(command, QueuedWorkspaceCommand::Trash) {
                2
            } else {
                0
            };
            [setup, setup + later]
        }

        fn assert_landed(&self, state: &AppState, before: &Path, sync: usize) -> PathBuf {
            let rebound = mutation_target(&state.pgn_path_authority, &self.file).unwrap();
            assert_eq!(rebound.identity, self.identity);
            assert!(
                !before.exists(),
                "{:?} directory={} sync={sync}",
                self.command,
                self.directory
            );
            assert_eq!(fs::read(rebound.path()).unwrap(), b"1. e4 *");
            let expected = match self.command {
                QueuedWorkspaceCommand::Move | QueuedWorkspaceCommand::Restore => {
                    self.root.join(if self.directory {
                        "source/before.pgn"
                    } else {
                        "before.pgn"
                    })
                }
                QueuedWorkspaceCommand::Rename => self.original_path.with_file_name("after.pgn"),
                QueuedWorkspaceCommand::Trash => {
                    assert!(rebound.path().starts_with(self.root.join(TRASH_DIRECTORY)));
                    rebound.path().to_path_buf()
                }
                _ => unreachable!(),
            };
            assert_eq!(rebound.path(), expected);
            if matches!(self.command, QueuedWorkspaceCommand::Rename) {
                let metadata: WorkspaceMetadata =
                    serde_json::from_slice(&fs::read(expected.with_extension("info")).unwrap())
                        .unwrap();
                assert_eq!(metadata.tags, ["updated"]);
            } else {
                assert_eq!(
                    fs::read(expected.with_extension("info")).unwrap(),
                    self.info_bytes
                );
            }
            expected
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn committed_rename_commands_finish_real_collection_reconciliation() {
        use crate::db::linked_collections::tests::Fixture;
        for command in [
            QueuedWorkspaceCommand::Move,
            QueuedWorkspaceCommand::Rename,
            QueuedWorkspaceCommand::Trash,
            QueuedWorkspaceCommand::Restore,
        ] {
            for directory in [false, true] {
                if directory && matches!(command, QueuedWorkspaceCommand::Rename) {
                    continue;
                }
                for sync in WorkspaceRenameScenario::sync_fault_indices(command, directory) {
                    let fixture = Fixture::new();
                    let state = &fixture.state;
                    let workspace = &fixture.workspace;
                    let scenario =
                        WorkspaceRenameScenario::prepare(state, workspace, command, directory);
                    let collections = fixture.list();
                    assert_eq!(collections.len(), 1);
                    let collection_id = collections[0].id.clone();
                    let before = scenario.prepare_invocation(state, workspace);
                    // An external collection appears after the initial discovery. Its durable
                    // registration proves that the real command wrapper ran discovery.
                    fs::write(scenario.root.join("probe.pgn"), b"1. d4 *").unwrap();
                    fs::write(
                        scenario.root.join("probe.info"),
                        br#"{"type":"game","tags":[]}"#,
                    )
                    .unwrap();
                    let app = fixture.app();
                    let reset = crate::infra::fs::install_test_atomic_file_injector(Arc::new(
                        FailAtFaultPoint::fail_only(AtomicFileFaultPoint::ParentSync, sync),
                    ));
                    let entry = &scenario.entry;
                    let result = match command {
                        QueuedWorkspaceCommand::Move => {
                            move_workspace_entry(
                                workspace.clone(),
                                entry.clone(),
                                workspace.clone(),
                                app.state::<AppState>(),
                            )
                            .await
                        }
                        QueuedWorkspaceCommand::Rename => {
                            rename_workspace_file(
                                workspace.clone(),
                                entry.clone(),
                                "after".into(),
                                WorkspaceMetadata {
                                    file_type: WorkspaceFileType::Game,
                                    tags: vec!["updated".into()],
                                },
                                app.state::<AppState>(),
                            )
                            .await
                        }
                        QueuedWorkspaceCommand::Trash => {
                            trash_workspace_entry(
                                workspace.clone(),
                                entry.clone(),
                                app.state::<AppState>(),
                            )
                            .await
                        }
                        QueuedWorkspaceCommand::Restore => {
                            restore_workspace_entry(
                                workspace.clone(),
                                entry.clone(),
                                app.state::<AppState>(),
                            )
                            .await
                        }
                        _ => unreachable!(),
                    };
                    drop(reset);
                    assert_workspace_rename_uncertainty(&result.unwrap_err());
                    let expected = scenario.assert_landed(state, &before, sync);
                    let registry: serde_json::Value = serde_json::from_slice(
                        &fs::read(
                            fixture
                                .directory
                                .path()
                                .join("app/collections/registry.json"),
                        )
                        .unwrap(),
                    )
                    .unwrap();
                    let records = registry["records"].as_array().unwrap();
                    assert_eq!(records.len(), 2, "committed rename must complete collection reconciliation: {command:?} directory={directory} sync={sync}");
                    let record = records
                        .iter()
                        .find(|record| record["id"] == collection_id)
                        .unwrap();
                    let parts: Vec<crate::infra::path_authority::NativePath> =
                        serde_json::from_value(record["locator"].clone()).unwrap();
                    let locator = parts
                        .iter()
                        .map(|part| part.to_path().unwrap())
                        .collect::<PathBuf>();
                    let indexed_path = if matches!(command, QueuedWorkspaceCommand::Trash) {
                        &scenario.original_path
                    } else {
                        &expected
                    };
                    assert_eq!(scenario.root.join(locator), *indexed_path);
                    assert_eq!(
                        record["file"],
                        serde_json::to_value(&scenario.file).unwrap()
                    );
                }
            }
        }
    }

    #[test]
    fn committed_workspace_moves_finish_file_and_directory_authority() {
        for command in [
            QueuedWorkspaceCommand::Move,
            QueuedWorkspaceCommand::Trash,
            QueuedWorkspaceCommand::Restore,
        ] {
            for directory in [false, true] {
                for sync in WorkspaceRenameScenario::sync_fault_indices(command, directory) {
                    let (_directory, state, workspace) = workspace_state();
                    let scenario =
                        WorkspaceRenameScenario::prepare(&state, &workspace, command, directory);
                    let before = scenario.prepare_invocation(&state, &workspace);
                    let reset = crate::infra::fs::install_test_atomic_file_injector(Arc::new(
                        FailAtFaultPoint::fail_only(AtomicFileFaultPoint::ParentSync, sync),
                    ));
                    let entry = &scenario.entry;
                    let result = match command {
                        QueuedWorkspaceCommand::Move => move_workspace_entry_blocking(
                            workspace.clone(),
                            entry.clone(),
                            workspace.clone(),
                            &state.pgn_path_authority,
                            &state.workspace_mutation,
                            &CancellationToken::new(),
                        ),
                        QueuedWorkspaceCommand::Trash => trash_entry(
                            &state.pgn_path_authority,
                            &state.workspace_mutation,
                            &workspace,
                            entry,
                            &CancellationToken::new(),
                        ),
                        QueuedWorkspaceCommand::Restore => restore_entry(
                            &state.pgn_path_authority,
                            &state.workspace_mutation,
                            &workspace,
                            entry,
                            &CancellationToken::new(),
                        ),
                        _ => unreachable!(),
                    };
                    drop(reset);
                    assert_workspace_rename_uncertainty(&result.unwrap_err());
                    let expected = scenario.assert_landed(&state, &before, sync);
                    let parent = crate::infra::fs::open_parent_no_follow(&expected).unwrap();
                    let identity =
                        crate::infra::path_authority::opened_file_identity(&parent).unwrap();
                    state
                        .pgn_path_authority
                        .with_mut(|authority| {
                            assert_eq!(
                                authority.parent_identity_for_test(scenario.file.path_ref()),
                                Some(identity)
                            );
                        })
                        .unwrap();
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn rename_workspace_file_reports_uncertain_sidecar_after_a_durable_rebind() {
        // The paired renames sync durably. Fail only the sidecar rewrite's parent sync,
        // then allow the registry rebind to commit durably.
        let (_directory, state, root, handle, result) = rename_under_injector(Some(Arc::new(
            FailAtFaultPoint::fail_only(AtomicFileFaultPoint::ParentSync, 2),
        )));
        assert!(matches!(
            result,
            Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::WorkspaceSidecarReplacement
            ))
        ));
        assert_rename_landed(&state, &root, &handle);
    }

    #[cfg(unix)]
    #[test]
    fn rename_workspace_file_lets_a_failed_rebind_outrank_the_sidecar_uncertainty() {
        // The sidecar rewrite loses its parent sync, then the registry rebind rename fails.
        // The hard error stays primary and the faulted reverse is the cleanup failure.
        let (_directory, _state, root, _handle, result) = rename_under_injector(Some(Arc::new(
            FailAtFaultPoint::fail_only(AtomicFileFaultPoint::ParentSync, 2)
                .and(FailAtFaultPoint::fail_from(AtomicFileFaultPoint::Rename, 1)),
        )));
        assert!(
            matches!(&result, Err(Error::OperationAndCleanup { primary, cleanup })
                if primary.contains("injected atomic-file fault")
                    && cleanup.contains("injected atomic-file fault")),
            "the failed rebind must stay primary with its failed reverse as cleanup: {result:?}"
        );
        assert!(root.join("after.pgn").is_file());
        assert!(root.join("after.info").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn rename_workspace_file_reports_the_sidecar_stage_over_a_registry_uncertainty() {
        // The paired renames sync durably. The sidecar rewrite and registry rebind are
        // both uncertain, and the first stage is the one reported.
        let (_directory, state, root, handle, result) = rename_under_injector(Some(Arc::new(
            FailAtFaultPoint::fail_from(AtomicFileFaultPoint::ParentSync, 2),
        )));
        assert!(matches!(
            result,
            Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::WorkspaceSidecarReplacement
            ))
        ));
        assert_rename_landed(&state, &root, &handle);
    }

    #[test]
    fn create_workspace_directory_parent_sync_keeps_completed_directory() {
        let (directory, state, workspace) = workspace_state();
        let root =
            mutation_target(&state.pgn_path_authority, &workspace).expect("workspace target");
        set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
            "uncertain",
        ))));
        let error = create_named_directory(&state, &workspace, "created")
            .expect_err("directory parent-sync uncertainty must be surfaced");
        set_test_atomic_file_injector(None);
        assert!(matches!(
            error,
            Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::WorkspaceDirectoryCreation
            )
        ));
        assert!(root.path().join("created").is_dir());
        assert!(registry_has_display_name(&directory, "created"));
    }

    #[test]
    fn create_workspace_directory_create_parent_sync_uncertainty_is_reported_when_registry_is_durable(
    ) {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        set_test_atomic_file_injector(Some(Arc::new(FailAtFaultPoint::fail_only(
            AtomicFileFaultPoint::ParentSync,
            0,
        ))));
        let error = create_named_directory(&state, &workspace, "dir-sync")
            .expect_err("directory create parent-sync uncertainty must be surfaced");
        set_test_atomic_file_injector(None);
        assert!(matches!(
            error,
            Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::WorkspaceDirectoryCreation
            )
        ));
        assert!(root.join("dir-sync").is_dir());
        assert!(registry_has_display_name(&directory, "dir-sync"));
    }

    /// Fails atomic renames from the sidecar's onward, the second atomic rename of a workspace
    /// file creation; when `replace_pgn` is set it swaps the just-installed PGN for a different
    /// regular file before returning the injected error.
    struct SidecarRenameFault {
        fault: FailAtFaultPoint,
        replace_pgn: Option<PathBuf>,
    }

    impl AtomicWriterInjector for SidecarRenameFault {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            let Err(error) = self.fault.inject(point) else {
                return Ok(());
            };
            if let Some(pgn) = &self.replace_pgn {
                let replacement = pgn.with_extension("replacement");
                fs::write(&replacement, b"replacement")?;
                fs::rename(&replacement, pgn)?;
            }
            Err(error)
        }
    }

    fn create_game_under_sidecar_fault(
        replace_pgn: bool,
    ) -> (TempDir, PathBuf, Result<WorkspaceEntry, Error>) {
        let (directory, state, workspace) = workspace_state();
        let root = mutation_target(&state.pgn_path_authority, &workspace)
            .expect("workspace target")
            .path()
            .to_path_buf();
        set_test_atomic_file_injector(Some(Arc::new(SidecarRenameFault {
            fault: FailAtFaultPoint::fail_from(AtomicFileFaultPoint::Rename, 1),
            replace_pgn: replace_pgn.then(|| root.join("game.pgn")),
        })));
        let result = create_workspace_file_blocking(
            workspace.clone(),
            workspace,
            "game".into(),
            WorkspaceMetadata {
                file_type: WorkspaceFileType::Game,
                tags: vec![],
            },
            WorkspaceFileContent::Text {
                pgn: "1. e4 *".into(),
            },
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &state.pgn_repository,
            &CancellationToken::new(),
        );
        set_test_atomic_file_injector(None);
        (directory, root, result)
    }

    #[test]
    fn paired_rename_retains_native_rollback_cause_and_safe_payload() {
        let (_directory, state, workspace) = workspace_state();
        let created = create_workspace_file_blocking(
            workspace.clone(),
            workspace.clone(),
            "before".into(),
            WorkspaceMetadata {
                file_type: WorkspaceFileType::Game,
                tags: vec![],
            },
            WorkspaceFileContent::Text { pgn: "*".into() },
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &state.pgn_repository,
            &CancellationToken::new(),
        )
        .unwrap();
        let source = mutation_target(&state.pgn_path_authority, &created.handle).unwrap();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        fs::write(root.join("after.info"), b"existing sidecar").unwrap();
        let observed_root = root.clone();
        PAIRED_RENAME_POST_PRIMARY_HOOK.with(|slot| {
            assert!(slot
                .replace(Some(Box::new(move || {
                    fs::write(observed_root.join("before.pgn"), b"unrelated new source").unwrap();
                })))
                .is_none());
        });
        let capture = crate::error::LogCaptureScope::start();
        let error = paired_rename(&source, &source.parent, OsStr::new("after.pgn")).unwrap_err();
        let Error::OperationAndCleanup { primary, cleanup } = &error else {
            panic!("{error:?}")
        };
        #[cfg(unix)]
        {
            assert!(primary.starts_with("I/O failure:"), "{primary}");
            assert!(cleanup.starts_with("I/O failure:"), "{cleanup}");
        }
        #[cfg(windows)]
        {
            assert_eq!(primary, "Conflict: Windows object name collision");
            assert_eq!(cleanup, "Conflict: Windows object name collision");
        }
        let payload = serde_json::to_value(&error).unwrap();
        assert_eq!(payload["category"], "operation-and-cleanup");
        assert_eq!(
            payload["message"],
            "Operation failed; temporary cleanup also failed"
        );
        assert!(!payload.to_string().contains(primary));
        assert!(!payload.to_string().contains(cleanup));
        assert!(capture
            .messages()
            .iter()
            .any(|message| message.contains(primary) && message.contains(cleanup)));
        assert_eq!(
            fs::read(root.join("before.pgn")).unwrap(),
            b"unrelated new source"
        );
        assert!(root.join("after.pgn").is_file());
    }

    #[test]
    fn workspace_file_name_taken_text_and_copy_preserve_existing_registered_file() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        let existing = create_named_text(&state, &workspace, "existing", "1. d4 *")
            .expect("registered destination");
        let source_path = root.join("source.pgn");
        fs::write(&source_path, b"1. e4 *").expect("source");
        let source = registered_child_file(&state, &workspace, &source_path);
        let revision = source_revision(&state, &source);
        let registry_before = fs::read(directory.path().join("registry.json")).unwrap();
        let sidecar_before = fs::read(root.join("existing.info")).unwrap();
        for content in [
            WorkspaceFileContent::Text {
                pgn: "1. c4 *".into(),
            },
            WorkspaceFileContent::Copy {
                source: source.clone(),
                revision,
            },
        ] {
            let error = create_workspace_file_blocking(
                workspace.clone(),
                workspace.clone(),
                "existing".into(),
                WorkspaceMetadata::default(),
                content,
                &state.pgn_path_authority,
                &state.workspace_mutation,
                &state.pgn_repository,
                &CancellationToken::new(),
            )
            .expect_err("existing destination");
            assert_eq!(serde_json::to_value(error).unwrap()["nameTaken"], true);
            assert_eq!(fs::read(root.join("existing.pgn")).unwrap(), b"1. d4 *");
            assert_eq!(
                fs::read(root.join("existing.info")).unwrap(),
                sidecar_before
            );
            assert_eq!(fs::read(&source_path).unwrap(), b"1. e4 *");
            assert_eq!(
                fs::read(directory.path().join("registry.json")).unwrap(),
                registry_before
            );
            resolve_created_pgn(&state, &existing.handle);
        }
        assert_workspace_entry_names(&root, &["existing.info", "existing.pgn", "source.pgn"]);
    }

    #[test]
    fn workspace_file_name_taken_orphan_sidecar_refuses_before_pgn_publication() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        fs::write(root.join("game.info"), b"orphan sidecar").unwrap();
        let _injector = crate::infra::fs::install_test_atomic_file_injector(Arc::new(
            FailAtFaultPoint::fail_only(AtomicFileFaultPoint::TempfileCreate, 0),
        ));
        let error = create_named_text(&state, &workspace, "game", "*").unwrap_err();
        assert_eq!(serde_json::to_value(error).unwrap()["nameTaken"], true);
        assert_eq!(fs::read(root.join("game.info")).unwrap(), b"orphan sidecar");
        assert_workspace_entry_names(&root, &["game.info"]);
        assert!(!registry_has_display_name(&directory, "game"));
    }

    #[test]
    fn workspace_file_name_taken_directories_are_invalid_at_either_leaf() {
        for leaf in ["game.pgn", "game.info"] {
            let (directory, state, workspace) = workspace_state();
            let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
            fs::create_dir(root.join(leaf)).unwrap();
            fs::write(root.join(leaf).join("kept"), b"directory child").unwrap();
            let error = create_named_text(&state, &workspace, "game", "*").unwrap_err();
            assert!(matches!(error, Error::InvalidInput(_)), "{error:?}");
            assert_eq!(
                fs::read(root.join(leaf).join("kept")).unwrap(),
                b"directory child"
            );
            assert_workspace_entry_names(&root, &[leaf]);
            assert!(!registry_has_display_name(&directory, "game"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn workspace_file_name_taken_symlinks_are_invalid_at_either_leaf() {
        for leaf in ["game.pgn", "game.info"] {
            let (directory, state, workspace) = workspace_state();
            let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
            let outside = directory.path().join("outside");
            fs::write(&outside, b"outside bytes").unwrap();
            std::os::unix::fs::symlink(&outside, root.join(leaf)).unwrap();
            let error = create_named_text(&state, &workspace, "game", "*").unwrap_err();
            assert!(matches!(error, Error::InvalidInput(_)), "{error:?}");
            assert!(fs::symlink_metadata(root.join(leaf))
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(fs::read(outside).unwrap(), b"outside bytes");
            assert_workspace_entry_names(&root, &[leaf]);
            assert!(!registry_has_display_name(&directory, "game"));
        }
    }

    #[test]
    fn workspace_file_name_taken_hard_links_preserve_the_other_names_bytes() {
        for leaf in ["game.pgn", "game.info"] {
            let (directory, state, workspace) = workspace_state();
            let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
            let outside = directory.path().join("outside");
            fs::write(&outside, b"hard-linked bytes").unwrap();
            fs::hard_link(&outside, root.join(leaf)).unwrap();
            let error = create_named_text(&state, &workspace, "game", "*").unwrap_err();
            assert_eq!(serde_json::to_value(error).unwrap()["nameTaken"], true);
            assert_eq!(fs::read(outside).unwrap(), b"hard-linked bytes");
            assert_eq!(fs::read(root.join(leaf)).unwrap(), b"hard-linked bytes");
            assert_workspace_entry_names(&root, &[leaf]);
            assert!(!registry_has_display_name(&directory, "game"));
        }
    }

    #[test]
    fn workspace_file_name_taken_free_text_and_copy_succeed() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        let text = create_named_text(&state, &workspace, "text", "1. e4 *").unwrap();
        let revision = source_revision(&state, &text.handle);
        let copy = create_workspace_file_blocking(
            workspace.clone(),
            workspace.clone(),
            "copy".into(),
            WorkspaceMetadata::default(),
            WorkspaceFileContent::Copy {
                source: text.handle.clone(),
                revision,
            },
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &state.pgn_repository,
            &CancellationToken::new(),
        )
        .expect("free copy");
        for entry in [&text, &copy] {
            assert_eq!(entry.game_count, Some(1));
            assert!(registry_has_display_name(&directory, &entry.name));
            resolve_created_pgn(&state, &entry.handle);
        }
        assert_eq!(fs::read(root.join("text.pgn")).unwrap(), b"1. e4 *");
        assert_eq!(fs::read(root.join("copy.pgn")).unwrap(), b"1. e4 *");
        assert_workspace_entry_names(&root, &["copy.info", "copy.pgn", "text.info", "text.pgn"]);
    }

    #[test]
    fn workspace_file_name_taken_sidecar_after_pgn_install_rolls_back_only_new_pgn() {
        struct PlantSidecar(PathBuf);
        impl AtomicWriterInjector for PlantSidecar {
            fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
                if point == AtomicFileFaultPoint::PostRenameMetadata {
                    fs::write(&self.0, b"winning sidecar")?;
                }
                Ok(())
            }
        }
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        let _injector = crate::infra::fs::install_test_atomic_file_injector(Arc::new(
            PlantSidecar(root.join("game.info")),
        ));
        let error = create_named_text(&state, &workspace, "game", "1. e4 *").unwrap_err();
        assert_eq!(serde_json::to_value(error).unwrap()["nameTaken"], true);
        assert_eq!(
            fs::read(root.join("game.info")).unwrap(),
            b"winning sidecar"
        );
        assert_workspace_entry_names(&root, &["game.info"]);
        assert!(!registry_has_display_name(&directory, "game"));
    }

    #[test]
    fn create_workspace_file_rolls_back_its_pgn_when_the_sidecar_fails() {
        let (_directory, root, result) = create_game_under_sidecar_fault(false);
        assert!(matches!(result, Err(Error::Io(_))), "{result:?}");
        assert!(!root.join("game.pgn").exists());
        assert!(!root.join("game.info").exists());
    }

    #[test]
    fn create_workspace_file_rollback_leaves_a_replaced_pgn_in_place() {
        let (_directory, root, result) = create_game_under_sidecar_fault(true);
        assert!(
            matches!(result, Err(Error::OperationAndCleanup { .. })),
            "{result:?}"
        );
        assert_eq!(fs::read(root.join("game.pgn")).unwrap(), b"replacement");
    }

    #[test]
    fn create_workspace_file_rolls_back_an_ordinary_registration_failure() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        set_test_atomic_file_injector(Some(Arc::new(FailAtFaultPoint::fail_from(
            AtomicFileFaultPoint::Rename,
            2,
        ))));
        let error = create_named_text(&state, &workspace, "reg-fail", "1. e4 *")
            .expect_err("ordinary registration failure");
        set_test_atomic_file_injector(None);
        assert!(
            !matches!(error, Error::OperationAndCleanup { .. }),
            "{error:?}"
        );
        assert!(!root.join("reg-fail.pgn").exists());
        assert!(!root.join("reg-fail.info").exists());
        assert!(!registry_has_display_name(&directory, "reg-fail"));
        let retry = create_named_text(&state, &workspace, "reg-fail", "1. d4 *")
            .expect("retry after rolled-back create");
        assert_eq!(retry.game_count, Some(1));
        assert!(root.join("reg-fail.pgn").is_file());
    }

    #[test]
    fn create_workspace_file_registration_rollback_leaves_a_replaced_pgn() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        let pgn = root.join("keep-pgn.pgn");
        set_workspace_created_child_pre_register_hook(Some(Box::new(move || {
            let replacement = pgn.with_extension("swap");
            fs::write(&replacement, b"keep-pgn-bytes").expect("replacement PGN");
            fs::rename(&replacement, &pgn).expect("replace installed PGN");
        })));
        set_test_atomic_file_injector(Some(Arc::new(FailAtFaultPoint::fail_from(
            AtomicFileFaultPoint::Rename,
            2,
        ))));
        let error = create_named_text(&state, &workspace, "keep-pgn", "1. e4 *")
            .expect_err("replaced PGN cannot be rolled back");
        set_workspace_created_child_pre_register_hook(None);
        set_test_atomic_file_injector(None);
        assert!(
            matches!(error, Error::OperationAndCleanup { .. }),
            "{error:?}"
        );
        assert_eq!(
            fs::read(root.join("keep-pgn.pgn")).unwrap(),
            b"keep-pgn-bytes"
        );
        assert!(!root.join("keep-pgn.info").exists());
        assert!(!registry_has_display_name(&directory, "keep-pgn"));
    }

    #[test]
    fn create_workspace_file_registration_rollback_leaves_a_replaced_sidecar() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        let sidecar = root.join("keep-side.info");
        set_workspace_created_child_pre_register_hook(Some(Box::new(move || {
            let replacement = sidecar.with_extension("swap");
            fs::write(&replacement, b"keep-sidecar-bytes").expect("replacement sidecar");
            fs::rename(&replacement, &sidecar).expect("replace installed sidecar");
        })));
        set_test_atomic_file_injector(Some(Arc::new(FailAtFaultPoint::fail_from(
            AtomicFileFaultPoint::Rename,
            2,
        ))));
        let error = create_named_text(&state, &workspace, "keep-side", "1. e4 *")
            .expect_err("replaced sidecar cannot be rolled back");
        set_workspace_created_child_pre_register_hook(None);
        set_test_atomic_file_injector(None);
        assert!(
            matches!(error, Error::OperationAndCleanup { .. }),
            "{error:?}"
        );
        assert_eq!(
            fs::read(root.join("keep-side.info")).unwrap(),
            b"keep-sidecar-bytes"
        );
        assert!(!root.join("keep-side.pgn").exists());
        assert!(!registry_has_display_name(&directory, "keep-side"));
    }

    #[test]
    fn create_workspace_file_registry_parent_sync_uncertainty_keeps_the_entry() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        set_test_atomic_file_injector(Some(Arc::new(FailAtFaultPoint::fail_from(
            AtomicFileFaultPoint::ParentSync,
            2,
        ))));
        let error = create_named_text(&state, &workspace, "reg-sync", "*")
            .expect_err("registry parent-sync uncertainty");
        set_test_atomic_file_injector(None);
        assert!(matches!(
            error,
            Error::CommittedDurabilityUncertain(crate::error::DurabilityStage::RegistryReplacement)
        ));
        assert!(root.join("reg-sync.pgn").is_file());
        assert!(root.join("reg-sync.info").is_file());
        assert!(registry_has_display_name(&directory, "reg-sync"));
        let (entries, _) = collect_tree_entries(
            &state.pgn_path_authority,
            &workspace,
            &CancellationToken::new(),
        )
        .expect("list registered file");
        let created = entries
            .entries
            .iter()
            .find(|entry| entry.name == "reg-sync")
            .expect("registered");
        resolve_created_pgn(&state, &created.handle);
    }

    #[test]
    fn create_workspace_file_sidecar_parent_sync_uncertainty_is_reported() {
        let (directory, state, workspace) = workspace_state();
        set_test_atomic_file_injector(Some(Arc::new(FailAtFaultPoint::fail_only(
            AtomicFileFaultPoint::ParentSync,
            1,
        ))));
        let error = create_named_text(&state, &workspace, "side-sync", "*")
            .expect_err("sidecar parent-sync uncertainty");
        set_test_atomic_file_injector(None);
        assert!(matches!(
            error,
            Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::WorkspaceSidecarCreation
            )
        ));
        assert!(registry_has_display_name(&directory, "side-sync"));
    }

    #[test]
    fn create_workspace_file_sidecar_uncertainty_outranks_registry_uncertainty() {
        let (directory, state, workspace) = workspace_state();
        set_test_atomic_file_injector(Some(Arc::new(FailAtFaultPoint::fail_from(
            AtomicFileFaultPoint::ParentSync,
            1,
        ))));
        let error = create_named_text(&state, &workspace, "side-first", "*")
            .expect_err("sidecar outranks registry");
        set_test_atomic_file_injector(None);
        assert!(matches!(
            error,
            Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::WorkspaceSidecarCreation
            )
        ));
        assert!(registry_has_display_name(&directory, "side-first"));
    }

    #[test]
    fn create_workspace_file_pgn_uncertainty_is_reported_when_later_steps_complete() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        set_test_atomic_file_injector(Some(Arc::new(FailAtFaultPoint::fail_from(
            AtomicFileFaultPoint::ParentSync,
            0,
        ))));
        let error = create_named_text(&state, &workspace, "pgn-first", "*")
            .expect_err("PGN uncertainty is first");
        set_test_atomic_file_injector(None);
        assert!(matches!(
            error,
            Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::WorkspacePgnCreation
            )
        ));
        assert!(root.join("pgn-first.pgn").is_file());
        assert!(root.join("pgn-first.info").is_file());
        assert!(registry_has_display_name(&directory, "pgn-first"));
    }

    #[test]
    fn create_workspace_file_pgn_parent_sync_uncertainty_is_reported_when_later_steps_are_durable()
    {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        set_test_atomic_file_injector(Some(Arc::new(FailAtFaultPoint::fail_only(
            AtomicFileFaultPoint::ParentSync,
            0,
        ))));
        let error = create_named_text(&state, &workspace, "pgn-sync", "*")
            .expect_err("PGN parent-sync uncertainty");
        set_test_atomic_file_injector(None);
        assert!(matches!(
            error,
            Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::WorkspacePgnCreation
            )
        ));
        assert!(root.join("pgn-sync.pgn").is_file());
        assert!(root.join("pgn-sync.info").is_file());
        assert!(registry_has_display_name(&directory, "pgn-sync"));
    }

    #[test]
    fn create_workspace_file_ordinary_registration_error_outranks_pgn_uncertainty() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        set_test_atomic_file_injector(Some(Arc::new(
            FailAtFaultPoint::fail_only(AtomicFileFaultPoint::ParentSync, 0)
                .and(FailAtFaultPoint::fail_from(AtomicFileFaultPoint::Rename, 2)),
        )));
        let error = create_named_text(&state, &workspace, "combine", "*")
            .expect_err("ordinary error outranks uncertainty");
        set_test_atomic_file_injector(None);
        assert!(
            !matches!(error, Error::CommittedDurabilityUncertain(_)),
            "{error:?}"
        );
        assert!(!root.join("combine.pgn").exists());
        assert!(!root.join("combine.info").exists());
    }

    #[test]
    fn create_workspace_file_unclosed_brace_comment_rolls_back() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        let error = create_named_text(&state, &workspace, "unclosed", "{ unclosed comment")
            .expect_err("unclosed brace comment");
        assert!(
            !matches!(error, Error::OperationAndCleanup { .. }),
            "{error:?}"
        );
        assert_workspace_entry_names(&root, &[]);
        assert!(!registry_has_display_name(&directory, "unclosed"));
    }

    #[tokio::test]
    async fn create_workspace_file_text_two_games_is_a_cache_hit() {
        let (_directory, state, workspace) = workspace_state();
        let created = create_named_text(
            &state,
            &workspace,
            "two",
            "[Event \"A\"]\n\n1. e4 *\n\n[Event \"B\"]\n\n1. d4 *\n",
        )
        .expect("two-game create");
        assert_eq!(created.game_count, Some(2));
        assert_count_is_cache_hit(&state, &created.handle, 2).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_workspace_file_returns_the_core_result_after_post_register_faults() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        let pgn = root.join("o2.pgn");
        let operations = state.operations.clone();
        state
            .pgn_repository
            .set_create_post_register_hook(Some(Box::new(move || {
                operations
                    .seal_and_request_cancellation()
                    .expect("cancel accepted operation");
                let replacement = pgn.with_extension("swap");
                fs::write(&replacement, b"replaced-after-register").expect("replacement");
                fs::rename(&replacement, &pgn).expect("replace installed PGN");
            })))
            .expect("set post-register hook");
        let app = tauri::test::mock_app();
        app.manage(state);
        let created = create_workspace_file(
            workspace.clone(),
            workspace,
            "o2".into(),
            WorkspaceMetadata::default(),
            WorkspaceFileContent::Text { pgn: "*".into() },
            app.state::<AppState>(),
        )
        .await
        .expect("command returns the core result");
        assert_eq!(created.game_count, Some(1));
        assert_eq!(
            fs::read(directory.path().join("workspace/o2.pgn")).unwrap(),
            b"replaced-after-register"
        );
    }

    #[test]
    fn create_workspace_file_invalidates_the_count_cache_on_registration_rollback() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        let captured = Arc::new(StdMutex::new(None));
        let captured_in_hook = Arc::clone(&captured);
        let root_in_hook = root.clone();
        set_workspace_created_child_pre_register_hook(Some(Box::new(move || {
            *captured_in_hook.lock().expect("identity") =
                Some(enumerated_workspace_entry(&root_in_hook, "rolled.pgn").identity);
        })));
        set_test_atomic_file_injector(Some(Arc::new(FailAtFaultPoint::fail_from(
            AtomicFileFaultPoint::Rename,
            2,
        ))));
        create_named_text(&state, &workspace, "rolled", "1. e4 *")
            .expect_err("ordinary registration failure");
        set_workspace_created_child_pre_register_hook(None);
        set_test_atomic_file_injector(None);
        let identity = captured.lock().expect("identity").take().expect("hook ran");
        assert!(!state
            .pgn_repository
            .has_cached_identity(
                crate::infra::path_authority::PgnSnapshotIdentity::from_pair(identity)
            )
            .expect("cache lookup"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_workspace_file_listing_during_count_does_not_block_a_retry() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        let list_workspace = workspace.clone();
        let retry_workspace = workspace.clone();
        let (hook, entered, release) = pgn::BoundedHook::new();
        state
            .pgn_repository
            .set_count_hook(Some(hook))
            .expect("set count hook");
        let app = tauri::test::mock_app();
        app.manage(state);
        let app_handle = app.handle().clone();
        let caller = tokio::spawn(async move {
            let state = app_handle.state::<AppState>();
            create_workspace_file(
                workspace.clone(),
                workspace,
                "stale-limit".into(),
                WorkspaceMetadata::default(),
                WorkspaceFileContent::Text { pgn: "*".into() },
                state,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), entered)
            .await
            .expect("count starts")
            .expect("count hook");
        let listed = collect_tree_entries(
            &app.state::<AppState>().pgn_path_authority,
            &list_workspace,
            &CancellationToken::new(),
        )
        .expect("listing registers the installed PGN");
        assert!(listed
            .0
            .entries
            .iter()
            .any(|entry| entry.name == "stale-limit"));
        app.state::<AppState>()
            .operations
            .seal_and_request_cancellation()
            .expect("cancel accepted operation");
        release.send(()).expect("release count hook");
        let result = caller.await.expect("join create");
        assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
        assert!(!root.join("stale-limit.pgn").exists());
        assert!(!root.join("stale-limit.info").exists());
        app.state::<AppState>()
            .pgn_repository
            .set_count_hook(None)
            .expect("clear count hook");
        let second = create_named_text(
            app.state::<AppState>().inner(),
            &retry_workspace,
            "stale-limit",
            "1. d4 *",
        )
        .expect("retry before a further listing");
        let second_identity =
            mutation_target(&app.state::<AppState>().pgn_path_authority, &second.handle)
                .expect("second identity")
                .identity;
        let (entries, _) = collect_tree_entries(
            &app.state::<AppState>().pgn_path_authority,
            &retry_workspace,
            &CancellationToken::new(),
        )
        .expect("listing after retry");
        let matches: Vec<_> = entries
            .entries
            .iter()
            .filter(|entry| entry.name == "stale-limit")
            .collect();
        assert_eq!(matches.len(), 1);
        assert_eq!(
            mutation_target(
                &app.state::<AppState>().pgn_path_authority,
                &matches[0].handle
            )
            .expect("listed identity")
            .identity,
            second_identity
        );
        assert_eq!(
            registry_display_names(&directory)
                .iter()
                .filter(|name| *name == "stale-limit")
                .count(),
            1
        );
    }

    #[test]
    fn create_workspace_directory_rolls_back_an_ordinary_registration_failure() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        set_test_atomic_file_injector(Some(Arc::new(FailAtFaultPoint::fail_from(
            AtomicFileFaultPoint::Rename,
            0,
        ))));
        let error = create_named_directory(&state, &workspace, "dir-fail")
            .expect_err("ordinary directory registration failure");
        set_test_atomic_file_injector(None);
        assert!(
            !matches!(error, Error::OperationAndCleanup { .. }),
            "{error:?}"
        );
        assert!(!root.join("dir-fail").exists());
        assert!(!registry_has_display_name(&directory, "dir-fail"));
    }

    #[test]
    fn create_workspace_directory_keeps_a_non_empty_directory_on_rollback() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        let child = root.join("dir-filled/inside.txt");
        set_workspace_created_child_pre_register_hook(Some(Box::new(move || {
            fs::write(&child, b"keep").expect("external file");
        })));
        set_test_atomic_file_injector(Some(Arc::new(FailAtFaultPoint::fail_from(
            AtomicFileFaultPoint::Rename,
            0,
        ))));
        let error = create_named_directory(&state, &workspace, "dir-filled")
            .expect_err("non-empty directory is not removed");
        set_workspace_created_child_pre_register_hook(None);
        set_test_atomic_file_injector(None);
        assert!(
            matches!(error, Error::OperationAndCleanup { .. }),
            "{error:?}"
        );
        assert_eq!(
            fs::read(root.join("dir-filled/inside.txt")).unwrap(),
            b"keep"
        );
    }

    #[test]
    fn create_workspace_directory_rollback_leaves_a_replaced_empty_directory() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        let target = root.join("dir-swap");
        set_workspace_created_child_pre_register_hook(Some(Box::new(move || {
            fs::rename(&target, target.with_file_name("dir-swap-saved")).expect("save observed");
            fs::create_dir(&target).expect("replacement empty directory");
        })));
        set_test_atomic_file_injector(Some(Arc::new(FailAtFaultPoint::fail_from(
            AtomicFileFaultPoint::Rename,
            0,
        ))));
        let error = create_named_directory(&state, &workspace, "dir-swap")
            .expect_err("replacement directory is not ours");
        set_workspace_created_child_pre_register_hook(None);
        set_test_atomic_file_injector(None);
        assert!(
            matches!(error, Error::OperationAndCleanup { .. }),
            "{error:?}"
        );
        assert!(root.join("dir-swap").is_dir());
        assert!(root.join("dir-swap-saved").is_dir());
    }

    #[test]
    fn create_workspace_directory_rollback_leaves_a_replaced_file() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        let target = root.join("dir-file");
        set_workspace_created_child_pre_register_hook(Some(Box::new(move || {
            fs::rename(&target, target.with_file_name("dir-file-saved")).expect("save observed");
            fs::write(&target, b"replacement-file").expect("replacement file");
        })));
        set_test_atomic_file_injector(Some(Arc::new(FailAtFaultPoint::fail_from(
            AtomicFileFaultPoint::Rename,
            0,
        ))));
        let error = create_named_directory(&state, &workspace, "dir-file")
            .expect_err("replacement file is not ours");
        set_workspace_created_child_pre_register_hook(None);
        set_test_atomic_file_injector(None);
        assert!(
            matches!(error, Error::OperationAndCleanup { .. }),
            "{error:?}"
        );
        assert_eq!(
            fs::read(root.join("dir-file")).unwrap(),
            b"replacement-file"
        );
    }

    #[test]
    fn create_workspace_directory_observation_failure_does_not_remove_by_name() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");

        crate::infra::fs::set_entry_observation_fault(Some(Error::from(std::io::Error::other(
            "injected observation",
        ))));
        let injected = create_named_directory(&state, &workspace, "obs-fault")
            .expect_err("injected observation");
        crate::infra::fs::set_entry_observation_fault(None);
        assert!(
            matches!(injected, Error::OperationAndCleanup { .. }),
            "{injected:?}"
        );
        assert!(root.join("obs-fault").is_dir());
        assert_eq!(fs::read_dir(root.join("obs-fault")).unwrap().count(), 0);
        assert!(!registry_has_display_name(&directory, "obs-fault"));

        let removed_path = root.join("obs-gone");
        WORKSPACE_CREATED_DIRECTORY_PRE_OBSERVE_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                fs::remove_dir(&removed_path).expect("remove created directory");
            }));
        });
        let removed = create_named_directory(&state, &workspace, "obs-gone")
            .expect_err("missing directory observation");
        WORKSPACE_CREATED_DIRECTORY_PRE_OBSERVE_HOOK.with(|slot| slot.borrow_mut().take());
        assert!(
            matches!(removed, Error::OperationAndCleanup { .. }),
            "{removed:?}"
        );
        assert!(!root.join("obs-gone").exists());
        assert!(!registry_has_display_name(&directory, "obs-gone"));

        let replaced_path = root.join("obs-file");
        WORKSPACE_CREATED_DIRECTORY_PRE_OBSERVE_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                fs::remove_dir(&replaced_path).expect("remove created directory");
                fs::write(&replaced_path, b"obs-bytes").expect("replacement file");
            }));
        });
        let replaced = create_named_directory(&state, &workspace, "obs-file")
            .expect_err("replaced-by-file observation");
        WORKSPACE_CREATED_DIRECTORY_PRE_OBSERVE_HOOK.with(|slot| slot.borrow_mut().take());
        assert!(
            matches!(replaced, Error::OperationAndCleanup { .. }),
            "{replaced:?}"
        );
        assert_eq!(fs::read(root.join("obs-file")).unwrap(), b"obs-bytes");
        assert!(!registry_has_display_name(&directory, "obs-file"));
    }

    fn workspace_entry_names(root: &Path) -> Vec<String> {
        let mut names = fs::read_dir(root)
            .expect("read workspace entries")
            .map(|entry| {
                entry
                    .expect("workspace entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    fn assert_workspace_entry_names(root: &Path, expected: &[&str]) {
        let mut expected = expected
            .iter()
            .map(|name| name.to_string())
            .collect::<Vec<_>>();
        expected.sort();
        assert_eq!(workspace_entry_names(root), expected);
    }

    fn source_revision(state: &AppState, source: &FileWorkspaceHandle) -> String {
        let resolved = state
            .pgn_path_authority
            .raw_for_test()
            .lock()
            .expect("authority lock")
            .as_mut()
            .expect("authority")
            .resolve(source.path_ref(), PathOperation::ReadPgn, &[])
            .expect("resolve PGN source");
        pgn::revision_string(&resolved.pgn_snapshot().expect("PGN snapshot"))
    }

    type WorkspaceCopyTask = tokio::task::JoinHandle<(Result<WorkspaceEntry, Error>, usize)>;

    // Mirrors the flat argument list of `create_workspace_file_blocking` plus the hook it installs.
    #[allow(clippy::too_many_arguments)]
    fn create_copy_with_chunk_hook(
        state: &AppState,
        workspace: FileWorkspaceHandle,
        parent: FileWorkspaceHandle,
        source: FileWorkspaceHandle,
        name: &str,
        revision: String,
        cancellation: CancellationToken,
        hook: pgn::BoundedHook,
    ) -> WorkspaceCopyTask {
        let pgn_path_authority = state.pgn_path_authority.clone();
        let workspace_mutation = Arc::clone(&state.workspace_mutation);
        let pgn_repository = state.pgn_repository.clone();
        let name = name.to_string();
        tokio::task::spawn_blocking(move || {
            pgn::set_read_chunk_hook(Some(hook));
            let result = create_workspace_file_blocking(
                workspace.clone(),
                parent,
                name,
                WorkspaceMetadata::default(),
                WorkspaceFileContent::Copy { source, revision },
                &pgn_path_authority,
                &workspace_mutation,
                &pgn_repository,
                &cancellation,
            );
            let chunks = pgn::copy_chunk_count();
            pgn::set_read_chunk_hook(None);
            (result, chunks)
        })
    }

    async fn wait_for_copy_chunk(
        entered: tokio::sync::oneshot::Receiver<()>,
        copy: WorkspaceCopyTask,
        description: &str,
    ) -> WorkspaceCopyTask {
        match tokio::time::timeout(Duration::from_secs(2), entered).await {
            Ok(Ok(())) => copy,
            Ok(Err(signal_error)) => {
                let copy_result = copy.await;
                panic!("{description}: chunk signal closed ({signal_error}); copy task result: {copy_result:?}");
            }
            Err(timeout_error) => {
                let copy_result = copy.await;
                panic!(
                    "{description}: timed out ({timeout_error}); copy task result: {copy_result:?}"
                );
            }
        }
    }

    #[test]
    fn workspace_file_content_deserializes_the_renderer_wire_shapes() {
        let text: WorkspaceFileContent =
            serde_json::from_str(r#"{"kind":"text","pgn":"*"}"#).expect("text content");
        assert!(matches!(text, WorkspaceFileContent::Text { pgn } if pgn == "*"));

        let source = FileWorkspaceHandle::new(crate::infra::path_authority::PathRef {
            id: "source-handle".into(),
        });
        let source_json = serde_json::to_string(&source).expect("serialize source handle");
        let copy_json = format!(
            r#"{{"kind":"copy","source":{source_json},"revision":"device:inode:revision"}}"#
        );
        let copy: WorkspaceFileContent = serde_json::from_str(&copy_json).expect("copy content");
        match copy {
            WorkspaceFileContent::Copy {
                source: decoded,
                revision,
            } => {
                assert_eq!(decoded, source);
                assert_eq!(revision, "device:inode:revision");
            }
            WorkspaceFileContent::Text { .. } => panic!("copy JSON decoded as text"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_workspace_file_copies_more_than_one_page_verbatim() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("workspace root");
        let source_path = root.join("source.pgn");
        let mut corpus = String::from("; Corpus preface\r\n");
        for game in 0..1_001 {
            corpus.push_str(&format!(
                "[Event \"Game {game}\"]\r\n[White \"White\"]\r\n[Black \"Black\"]\r\n\r\n1. e4 e5 *\r\n"
            ));
        }
        corpus.push_str("Trailing bytes after the final game\r\n");
        fs::write(&source_path, corpus.as_bytes()).expect("write corpus");
        let source = registered_child_file(&state, &workspace, &source_path);
        let metadata = WorkspaceMetadata {
            file_type: WorkspaceFileType::Tournament,
            tags: vec!["imported".into()],
        };
        let revision = source_revision(&state, &source);
        let app = tauri::test::mock_app();
        app.manage(state);

        let created = create_workspace_file(
            workspace.clone(),
            workspace,
            "copy".into(),
            metadata.clone(),
            WorkspaceFileContent::Copy { source, revision },
            app.state::<AppState>(),
        )
        .await
        .expect("create copied file");

        assert_eq!(created.game_count, Some(1_001));
        assert_count_is_cache_hit(app.state::<AppState>().inner(), &created.handle, 1_001).await;
        assert_eq!(
            fs::read(root.join("copy.pgn")).expect("read copied corpus"),
            corpus.as_bytes()
        );
        assert_eq!(
            fs::read(source_path).expect("source stays unchanged"),
            corpus.as_bytes()
        );
        let sidecar: WorkspaceMetadata =
            serde_json::from_slice(&fs::read(root.join("copy.info")).expect("read sidecar"))
                .expect("metadata sidecar");
        assert_eq!(sidecar, metadata);
        assert_workspace_entry_names(&root, &["copy.info", "copy.pgn", "source.pgn"]);
        drop(directory);
    }

    #[test]
    fn copy_workspace_file_rejects_unknown_and_directory_handles_without_artifacts() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("workspace root");
        let (_directory_path, directory_handle) =
            registered_child_directory(&state, &workspace, "not-pgn");
        let unknown = FileWorkspaceHandle::new(crate::infra::path_authority::PathRef {
            id: "unknown-source".into(),
        });

        for (name, source) in [("unknown", unknown), ("directory", directory_handle)] {
            let result = create_workspace_file_blocking(
                workspace.clone(),
                workspace.clone(),
                name.into(),
                WorkspaceMetadata::default(),
                WorkspaceFileContent::Copy {
                    source,
                    revision: "revision".into(),
                },
                &state.pgn_path_authority,
                &state.workspace_mutation,
                &state.pgn_repository,
                &CancellationToken::new(),
            );
            assert!(matches!(result, Err(Error::InvalidInput(_))), "{result:?}");
            assert!(!root.join(format!("{name}.pgn")).exists());
            assert!(!root.join(format!("{name}.info")).exists());
            assert_workspace_entry_names(&root, &["not-pgn"]);
        }
    }

    #[test]
    fn copy_workspace_file_rejects_a_stale_preflight_revision_before_writing() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("workspace root");
        let source_path = root.join("source.pgn");
        fs::write(&source_path, b"[Event \"Source\"]\n\n1. e4 *").expect("write source");
        let source = registered_child_file(&state, &workspace, &source_path);

        let result = create_workspace_file_blocking(
            workspace.clone(),
            workspace,
            "stale".into(),
            WorkspaceMetadata::default(),
            WorkspaceFileContent::Copy {
                source,
                revision: "stale-revision".into(),
            },
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &state.pgn_repository,
            &CancellationToken::new(),
        );

        assert!(matches!(
            result,
            Err(Error::Conflict(message)) if message == "source PGN changed since it was opened"
        ));
        assert_workspace_entry_names(&root, &["source.pgn"]);
    }

    #[tokio::test]
    async fn copy_workspace_file_cancels_after_the_first_chunk() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("workspace root");
        let source_path = root.join("source.pgn");
        fs::write(&source_path, vec![b'x'; 3 * 64 * 1024]).expect("write multi-chunk source");
        let source = registered_child_file(&state, &workspace, &source_path);
        let revision = source_revision(&state, &source);
        let cancellation = CancellationToken::new();
        let (hook, entered, release) = pgn::BoundedHook::new();
        let copy = create_copy_with_chunk_hook(
            &state,
            workspace.clone(),
            workspace,
            source,
            "cancelled",
            revision,
            cancellation.clone(),
            hook,
        );
        let copy = wait_for_copy_chunk(entered, copy, "copy reaches first chunk").await;
        cancellation.cancel();
        release.send(()).expect("release first chunk");
        let (result, chunks) = copy.await.expect("join blocking workspace copy");

        assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
        assert_eq!(chunks, 1, "copy must stop after the first chunk");
        assert!(!root.join("cancelled.pgn").exists());
        assert!(!root.join("cancelled.info").exists());
        assert_workspace_entry_names(&root, &["source.pgn"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn copy_workspace_file_refuses_a_destination_parent_moved_outside_the_workspace() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("workspace root");
        let source_path = root.join("source.pgn");
        fs::write(&source_path, vec![b'x'; 3 * 64 * 1024]).expect("write multi-chunk source");
        let source = registered_child_file(&state, &workspace, &source_path);
        let (destination_path, destination_parent) =
            registered_child_directory(&state, &workspace, "destination");
        let moved_destination_path = directory.path().join("moved-destination");
        let revision = source_revision(&state, &source);
        let (hook, entered, release) = pgn::BoundedHook::new();
        let copy = create_copy_with_chunk_hook(
            &state,
            workspace,
            destination_parent,
            source,
            "escaped",
            revision,
            CancellationToken::new(),
            hook,
        );
        let copy = wait_for_copy_chunk(entered, copy, "copy reaches first chunk").await;

        fs::rename(&destination_path, &moved_destination_path).expect("move destination outside");
        release.send(()).expect("release first chunk");
        let (result, chunks) = copy.await.expect("join blocking workspace copy");

        assert!(result.is_err(), "copy unexpectedly committed: {result:?}");
        assert_eq!(
            chunks, 3,
            "copy must reach precommit after all source chunks"
        );
        for destination in [&destination_path, &moved_destination_path] {
            assert!(!destination.join("escaped.pgn").exists());
            assert!(!destination.join("escaped.info").exists());
        }
        assert_workspace_entry_names(&root, &["source.pgn"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn copy_workspace_file_conflicts_when_source_is_truncated_mid_copy() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("workspace root");
        let source_path = root.join("source.pgn");
        fs::write(&source_path, vec![b'x'; 3 * 64 * 1024]).expect("write multi-chunk source");
        let source = registered_child_file(&state, &workspace, &source_path);
        let revision = source_revision(&state, &source);
        let (hook, entered, release) = pgn::BoundedHook::new();
        let copy = create_copy_with_chunk_hook(
            &state,
            workspace.clone(),
            workspace,
            source,
            "truncated",
            revision,
            CancellationToken::new(),
            hook,
        );
        let copy = wait_for_copy_chunk(entered, copy, "copy reaches first chunk").await;
        fs::OpenOptions::new()
            .write(true)
            .open(&source_path)
            .expect("open source to truncate")
            .set_len(0)
            .expect("truncate source");
        release.send(()).expect("release first chunk");
        let (result, chunks) = copy.await.expect("join blocking workspace copy");

        assert!(matches!(
            result,
            Err(Error::Conflict(message)) if message == "PGN snapshot ended while copying"
        ));
        assert_eq!(chunks, 1);
        assert!(!root.join("truncated.pgn").exists());
        assert!(!root.join("truncated.info").exists());
        assert_workspace_entry_names(&root, &["source.pgn"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn copy_workspace_file_conflicts_when_source_changes_before_commit() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("workspace root");
        let source_path = root.join("source.pgn");
        fs::write(&source_path, vec![b'x'; 64 * 1024]).expect("write source");
        let source = registered_child_file(&state, &workspace, &source_path);
        let revision = source_revision(&state, &source);
        let (hook, entered, release) = pgn::BoundedHook::new();
        let copy = create_copy_with_chunk_hook(
            &state,
            workspace.clone(),
            workspace,
            source,
            "changed",
            revision,
            CancellationToken::new(),
            hook,
        );
        let copy = wait_for_copy_chunk(entered, copy, "copy reaches final chunk").await;
        fs::OpenOptions::new()
            .append(true)
            .open(&source_path)
            .expect("open source to change")
            .write_all(b"changed")
            .expect("change source size");
        release.send(()).expect("release final chunk");
        let (result, chunks) = copy.await.expect("join blocking workspace copy");

        assert!(matches!(
            result,
            Err(Error::Conflict(message)) if message == "source PGN changed during import"
        ));
        assert_eq!(chunks, 1);
        assert!(!root.join("changed.pgn").exists());
        assert!(!root.join("changed.info").exists());
        assert_workspace_entry_names(&root, &["source.pgn"]);
    }

    #[tokio::test]
    async fn copy_workspace_file_cancellation_after_last_chunk_workspace_file_name_taken_is_checked_first(
    ) {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("workspace root");
        let source_path = root.join("source.pgn");
        fs::write(&source_path, b"one final chunk").expect("write source");
        let source = registered_child_file(&state, &workspace, &source_path);
        let revision = source_revision(&state, &source);
        let existing_pgn = b"previous destination bytes";
        let existing_info = b"previous sidecar bytes";
        fs::write(root.join("existing.pgn"), existing_pgn).expect("write destination");
        fs::write(root.join("existing.info"), existing_info).expect("write sidecar");
        let registry_before = fs::read(directory.path().join("registry.json")).unwrap();
        let cancellation = CancellationToken::new();
        let (hook, _entered, _release) = pgn::BoundedHook::new();
        let copy = create_copy_with_chunk_hook(
            &state,
            workspace.clone(),
            workspace.clone(),
            source.clone(),
            "existing",
            revision.clone(),
            cancellation.clone(),
            hook,
        );
        let (result, chunks) = tokio::time::timeout(Duration::from_secs(2), copy)
            .await
            .expect("existing name refuses before chunk hook")
            .expect("join refused copy");
        let error = result.expect_err("name taken before copying");
        assert_eq!(serde_json::to_value(error).unwrap()["nameTaken"], true);
        assert_eq!(chunks, 0);
        assert_eq!(
            fs::read(directory.path().join("registry.json")).unwrap(),
            registry_before
        );

        let (hook, entered, release) = pgn::BoundedHook::new();
        let copy = create_copy_with_chunk_hook(
            &state,
            workspace.clone(),
            workspace,
            source,
            "free",
            revision,
            cancellation.clone(),
            hook,
        );
        let copy = wait_for_copy_chunk(entered, copy, "copy reaches final chunk").await;
        cancellation.cancel();
        release.send(()).expect("release final chunk");
        let (result, chunks) = copy.await.expect("join blocking workspace copy");

        assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
        assert_eq!(chunks, 1);
        assert_eq!(fs::read(root.join("existing.pgn")).unwrap(), existing_pgn);
        assert_eq!(fs::read(root.join("existing.info")).unwrap(), existing_info);
        assert_eq!(fs::read(source_path).unwrap(), b"one final chunk");
        assert!(!root.join("free.pgn").exists());
        assert!(!root.join("free.info").exists());
        assert_eq!(
            fs::read(directory.path().join("registry.json")).unwrap(),
            registry_before
        );
        assert_workspace_entry_names(&root, &["existing.info", "existing.pgn", "source.pgn"]);
    }

    #[cfg(unix)]
    #[test]
    fn copy_workspace_file_keeps_heap_peak_below_the_corpus_size() {
        const CORPUS_BYTES: usize = 4 * 1024 * 1024;
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("workspace root");
        let source_path = root.join("source.pgn");
        let mut corpus = b"[Event \"X\"]\n\n1. e4 {".to_vec();
        while corpus.len() + 4 < CORPUS_BYTES {
            corpus.extend_from_slice(b"x\n");
        }
        corpus.resize(CORPUS_BYTES - 4, b'x');
        corpus.extend_from_slice(b"} *\n");
        fs::write(&source_path, &corpus).expect("write multi-megabyte source");
        let source = registered_child_file(&state, &workspace, &source_path);
        let revision = source_revision(&state, &source);
        let probe_peak = crate::db::allocation_probe::assert_detects_owned_collection(
            CORPUS_BYTES,
            CORPUS_BYTES / 2,
        );
        let result = crate::db::allocation_probe::measure(|| {
            create_workspace_file_blocking(
                workspace.clone(),
                workspace.clone(),
                "copy".into(),
                WorkspaceMetadata::default(),
                WorkspaceFileContent::Copy { source, revision },
                &state.pgn_path_authority,
                &state.workspace_mutation,
                &state.pgn_repository,
                &CancellationToken::new(),
            )
        });
        let (created, peak) = result;

        println!(
            "workspace copy heap peak: {peak} bytes for a {CORPUS_BYTES}-byte corpus; whole-vector probe: {probe_peak} bytes"
        );
        assert!(created.is_ok(), "{created:?}");
        assert!(
            peak < CORPUS_BYTES / 10,
            "copy heap peak {peak} should stay below one tenth of {CORPUS_BYTES} bytes"
        );
        assert_eq!(
            fs::metadata(root.join("copy.pgn")).unwrap().len(),
            CORPUS_BYTES as u64
        );
        assert_eq!(
            fs::metadata(source_path).unwrap().len(),
            CORPUS_BYTES as u64
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_workspace_file_count_cancellation_rolls_back_the_installed_file_and_sidecar() {
        let (directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("workspace root");
        let (hook, entered, release) = pgn::BoundedHook::new();
        state
            .pgn_repository
            .set_count_hook(Some(hook))
            .expect("set count hook");
        let app = tauri::test::mock_app();
        app.manage(state);
        let app_handle = app.handle().clone();
        let caller = tokio::spawn(async move {
            let state = app_handle.state::<AppState>();
            create_workspace_file(
                workspace.clone(),
                workspace,
                "count-cancelled".into(),
                WorkspaceMetadata::default(),
                WorkspaceFileContent::Text {
                    pgn: "[Event \"Count cancellation\"]\n\n1. e4 *".into(),
                },
                state,
            )
            .await
        });

        tokio::time::timeout(Duration::from_secs(5), entered)
            .await
            .expect("post-install count starts")
            .expect("count hook signal");
        app.state::<AppState>()
            .operations
            .seal_and_request_cancellation()
            .expect("cancel accepted operation");
        release.send(()).expect("release count hook");
        let result = caller.await.expect("join create command");

        assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
        assert!(!root.join("count-cancelled.pgn").exists());
        assert!(!root.join("count-cancelled.info").exists());
        assert!(!registry_has_display_name(&directory, "count-cancelled"));
        drop(directory);
    }

    #[cfg(unix)]
    #[test]
    fn collect_tree_entries_stops_traversal_when_cancelled() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        fs::write(root.join("game1.pgn"), b"[Event \"Test 1\"]\n\n1. e4 e5 *").expect("write pgn");
        fs::write(root.join("game2.pgn"), b"[Event \"Test 2\"]\n\n1. d4 d5 *").expect("write pgn");
        let sub = root.join("subdir");
        fs::create_dir(&sub).expect("create subdir");
        fs::write(sub.join("game3.pgn"), b"[Event \"Test 3\"]\n\n1. c4 c5 *").expect("write pgn");

        let token = CancellationToken::new();
        token.cancel();
        let result = collect_tree_entries(&state.pgn_path_authority, &workspace, &token);
        assert!(matches!(result, Err(Error::Cancellation)));
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn multi_file_count_cancellation_stops_subsequent_counts() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        fs::write(root.join("a.pgn"), b"[Event \"A\"]\n\n1. e4 e5 *").expect("write a");
        fs::write(root.join("b.pgn"), b"[Event \"B\"]\n\n1. d4 d5 *").expect("write b");
        fs::write(root.join("c.pgn"), b"[Event \"C\"]\n\n1. c4 c5 *").expect("write c");

        let token = CancellationToken::new();
        let (hook, entered, release) = pgn::BoundedHook::new();
        state
            .pgn_repository
            .set_count_hook(Some(hook))
            .expect("set count hook");

        let listing_task = tokio::spawn({
            let workspace = workspace.clone();
            let authority = state.pgn_path_authority.clone();
            let repository = state.pgn_repository.clone();
            let token = token.clone();
            async move { list_file_workspace_core(&workspace, &authority, &repository, &token).await }
        });

        tokio::time::timeout(std::time::Duration::from_secs(5), entered)
            .await
            .expect("timeout waiting for count entry")
            .expect("entered count");

        token.cancel();
        let _ = release.send(());

        let result = listing_task.await.expect("join");
        assert!(matches!(result, Err(Error::Cancellation)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn parent_token_survives_child_reads() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).expect("root");
        fs::write(root.join("a.pgn"), b"[Event \"A\"]\n\n1. e4 e5 *").expect("write a");

        let parent = CancellationToken::new();
        let child_token = parent.child_token();

        child_token.cancel();
        assert!(child_token.is_cancelled());
        assert!(!parent.is_cancelled());

        let (entries, missing) =
            collect_tree_entries(&state.pgn_path_authority, &workspace, &parent).expect("collect");
        assert_eq!(missing.len(), 1);
        let _ = entries;

        let resolved = state
            .pgn_path_authority
            .raw_for_test()
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .resolve(missing[0].path_ref(), PathOperation::ReadPgn, &[])
            .unwrap();
        let count = pgn::count_pgn_games_core(resolved, &parent, &state.pgn_repository)
            .await
            .expect("count");
        assert_eq!(count, 1);
        assert!(!parent.is_cancelled());
    }

    fn workspace_child_parent_identity(
        state: &AppState,
        workspace: &FileWorkspaceHandle,
        directory_name: &str,
    ) -> (u64, u64) {
        let mut authority = state.pgn_path_authority.raw_for_test().lock().unwrap();
        let authority = authority.as_mut().unwrap();
        let root = authority
            .capability_directory(workspace.path_ref(), PathOperation::ReadPgn)
            .unwrap();
        let entry = root
            .entries(&CancellationToken::new(), &mut |name| {
                name == OsStr::new(directory_name)
            })
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        root.open_child_directory(&entry)
            .unwrap()
            .identity()
            .unwrap()
    }

    #[test]
    fn listed_and_created_workspace_files_bind_their_parent_descriptors() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("listed.pgn"), b"1. e4 *").unwrap();

        let (entries, _) = collect_tree_entries(
            &state.pgn_path_authority,
            &workspace,
            &CancellationToken::new(),
        )
        .unwrap();
        let sub_entry = entries
            .entries
            .iter()
            .find(|entry| entry.name == "sub")
            .unwrap();
        let listed = sub_entry
            .children
            .iter()
            .find(|entry| entry.name == "listed")
            .unwrap();
        let observed_parent = workspace_child_parent_identity(&state, &workspace, "sub");
        {
            let mut authority = state.pgn_path_authority.raw_for_test().lock().unwrap();
            let authority = authority.as_mut().unwrap();
            assert_eq!(
                authority.parent_identity_for_test(listed.handle.path_ref()),
                Some(observed_parent)
            );
            assert!(authority
                .resolve(listed.handle.path_ref(), PathOperation::ReadPgn, &[])
                .is_ok());
        }

        let created = create_workspace_file_blocking(
            workspace.clone(),
            sub_entry.handle.clone(),
            "created".into(),
            WorkspaceMetadata::default(),
            WorkspaceFileContent::Text {
                pgn: "1. d4 *".into(),
            },
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &state.pgn_repository,
            &CancellationToken::new(),
        )
        .unwrap();
        {
            let mut authority = state.pgn_path_authority.raw_for_test().lock().unwrap();
            let authority = authority.as_mut().unwrap();
            assert_eq!(
                authority.parent_identity_for_test(created.handle.path_ref()),
                Some(observed_parent)
            );
            assert!(authority
                .resolve(created.handle.path_ref(), PathOperation::ReadPgn, &[])
                .is_ok());
        }
    }

    #[test]
    fn workspace_mutation_target_refuses_a_listed_nested_file_after_parent_replacement() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("a.pgn"), b"1. e4 *").unwrap();
        let (entries, _) = collect_tree_entries(
            &state.pgn_path_authority,
            &workspace,
            &CancellationToken::new(),
        )
        .unwrap();
        let child = entries.entries[0].children[0].handle.clone();
        assert!(mutation_target(&state.pgn_path_authority, &child).is_ok());

        let old = root.join("sub.old");
        fs::rename(&sub, &old).unwrap();
        fs::create_dir(&sub).unwrap();
        fs::hard_link(old.join("a.pgn"), sub.join("a.pgn")).unwrap();

        assert!(matches!(
            mutation_target(&state.pgn_path_authority, &child),
            Err(Error::Conflict(_))
        ));
        assert_eq!(fs::read_dir(&sub).unwrap().count(), 1);
    }

    #[test]
    fn workspace_listing_parent_swap_between_enumeration_and_registration_is_refused() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("a.pgn"), b"1. e4 *").unwrap();
        let expected_parent = workspace_child_parent_identity(&state, &workspace, "sub");
        let old = root.join("sub.old");
        let sub_for_hook = sub.clone();
        let old_for_hook = old.clone();
        let mut registrations = 0usize;
        let swapped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let swapped_in_hook = Arc::clone(&swapped);
        set_workspace_listing_pre_register_hook(Some(Box::new(move || {
            if registrations == 1 {
                // On Windows open_child_directory reaches open_windows_child with
                // allow_delete_share=true; the staged descriptor has also been dropped before
                // this registration hook, so this rename is the reachable W57 outcome.
                fs::rename(&sub_for_hook, &old_for_hook).expect("rename enumerated parent");
                fs::create_dir(&sub_for_hook).expect("replacement parent");
                fs::hard_link(old_for_hook.join("a.pgn"), sub_for_hook.join("a.pgn"))
                    .expect("hard-link enumerated leaf");
                swapped_in_hook.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            registrations += 1;
        })));

        let result = collect_tree_entries(
            &state.pgn_path_authority,
            &workspace,
            &CancellationToken::new(),
        );
        set_workspace_listing_pre_register_hook(None);
        let (entries, _) = result.expect("registration stores the enumerated parent identity");
        assert!(swapped.load(std::sync::atomic::Ordering::SeqCst));
        let sub_entry = entries
            .entries
            .iter()
            .find(|entry| entry.name == "sub")
            .unwrap();
        let child = sub_entry
            .children
            .iter()
            .find(|entry| entry.name == "a")
            .unwrap();
        {
            let mut authority = state.pgn_path_authority.raw_for_test().lock().unwrap();
            let authority = authority.as_mut().unwrap();
            assert_eq!(
                authority.parent_identity_for_test(child.handle.path_ref()),
                Some(expected_parent)
            );
            assert!(matches!(
                authority.resolve(child.handle.path_ref(), PathOperation::ReadPgn, &[]),
                Err(Error::Conflict(_))
            ));
        }
        assert_eq!(fs::read_dir(&sub).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn created_workspace_child_keeps_its_parent_descriptor_across_registration_race() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        let (entries, _) = collect_tree_entries(
            &state.pgn_path_authority,
            &workspace,
            &CancellationToken::new(),
        )
        .unwrap();
        let sub_handle = entries.entries[0].handle.clone();
        let expected_parent = mutation_target(&state.pgn_path_authority, &sub_handle)
            .unwrap()
            .identity;
        let old = root.join("sub.old");
        let sub_for_hook = sub.clone();
        set_workspace_created_child_pre_register_hook(Some(Box::new(move || {
            fs::rename(&sub_for_hook, &old).unwrap();
            fs::create_dir(&sub_for_hook).unwrap();
            fs::hard_link(old.join("created.pgn"), sub_for_hook.join("created.pgn")).unwrap();
        })));

        let created = create_workspace_file_blocking(
            workspace.clone(),
            sub_handle,
            "created".into(),
            WorkspaceMetadata::default(),
            WorkspaceFileContent::Text {
                pgn: "1. e4 *".into(),
            },
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &state.pgn_repository,
            &CancellationToken::new(),
        )
        .unwrap();

        {
            let mut authority = state.pgn_path_authority.raw_for_test().lock().unwrap();
            let authority = authority.as_mut().unwrap();
            assert_eq!(
                authority.parent_identity_for_test(created.handle.path_ref()),
                Some(expected_parent)
            );
            assert!(matches!(
                authority.resolve(created.handle.path_ref(), PathOperation::ReadPgn, &[]),
                Err(Error::Conflict(_))
            ));
            assert!(matches!(
                authority.workspace_mutation_target(&created.handle),
                Err(Error::Conflict(_))
            ));
        }
        assert_eq!(fs::read_dir(&sub).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn workspace_rebind_keeps_the_target_parent_descriptor_across_registration_race() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(root.join("a.pgn"), b"1. e4 *").unwrap();
        let (entries, _) = collect_tree_entries(
            &state.pgn_path_authority,
            &workspace,
            &CancellationToken::new(),
        )
        .unwrap();
        let source = entries
            .entries
            .iter()
            .find(|entry| entry.name == "a")
            .unwrap();
        let destination = entries
            .entries
            .iter()
            .find(|entry| entry.name == "sub")
            .unwrap();
        let destination_target =
            mutation_target(&state.pgn_path_authority, &destination.handle).unwrap();
        let expected_parent = crate::infra::path_authority::opened_file_identity(
            destination_target.directory().unwrap(),
        )
        .unwrap();
        let old = root.join("sub.old");
        let sub_for_hook = sub.clone();
        set_workspace_rebind_pre_register_hook(Some(Box::new(move || {
            fs::rename(&sub_for_hook, &old).unwrap();
            fs::create_dir(&sub_for_hook).unwrap();
            fs::hard_link(old.join("a.pgn"), sub_for_hook.join("a.pgn")).unwrap();
        })));

        move_workspace_entry_blocking(
            workspace.clone(),
            source.handle.clone(),
            destination.handle.clone(),
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &CancellationToken::new(),
        )
        .unwrap();

        {
            let mut authority = state.pgn_path_authority.raw_for_test().lock().unwrap();
            let authority = authority.as_mut().unwrap();
            assert_eq!(
                authority.parent_identity_for_test(source.handle.path_ref()),
                Some(expected_parent)
            );
            assert!(matches!(
                authority.workspace_mutation_target(&source.handle),
                Err(Error::Conflict(_))
            ));
        }
        assert_eq!(fs::read_dir(&sub).unwrap().count(), 1);
    }

    #[test]
    fn workspace_file_move_rebinds_the_new_parent_and_directory_move_keeps_child_binding() {
        let (_directory, state, workspace) = workspace_state();
        let root = workspace_root(&state.pgn_path_authority, &workspace).unwrap();
        let destination_path = root.join("destination");
        let outer_path = root.join("outer");
        fs::create_dir(&destination_path).unwrap();
        fs::create_dir(&outer_path).unwrap();
        fs::write(root.join("move.pgn"), b"1. e4 *").unwrap();
        fs::write(outer_path.join("child.pgn"), b"1. d4 *").unwrap();
        let (entries, _) = collect_tree_entries(
            &state.pgn_path_authority,
            &workspace,
            &CancellationToken::new(),
        )
        .unwrap();
        let source = entries
            .entries
            .iter()
            .find(|entry| entry.name == "move")
            .unwrap();
        let destination = entries
            .entries
            .iter()
            .find(|entry| entry.name == "destination")
            .unwrap();
        let new_parent = mutation_target(&state.pgn_path_authority, &destination.handle)
            .unwrap()
            .identity;

        move_workspace_entry_blocking(
            workspace.clone(),
            source.handle.clone(),
            destination.handle.clone(),
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &CancellationToken::new(),
        )
        .unwrap();
        {
            let mut authority = state.pgn_path_authority.raw_for_test().lock().unwrap();
            let authority = authority.as_mut().unwrap();
            assert_eq!(
                authority.parent_identity_for_test(source.handle.path_ref()),
                Some(new_parent)
            );
            assert_eq!(
                authority
                    .workspace_mutation_target(&source.handle)
                    .unwrap()
                    .path(),
                destination_path.join("move.pgn")
            );
            assert!(authority
                .resolve(source.handle.path_ref(), PathOperation::ReadPgn, &[])
                .is_ok());
        }

        let (entries, _) = collect_tree_entries(
            &state.pgn_path_authority,
            &workspace,
            &CancellationToken::new(),
        )
        .unwrap();
        let outer = entries
            .entries
            .iter()
            .find(|entry| entry.name == "outer")
            .unwrap();
        let child = outer
            .children
            .iter()
            .find(|entry| entry.name == "child")
            .unwrap();
        let original_child_parent = workspace_child_parent_identity(&state, &workspace, "outer");
        let directory_destination = entries
            .entries
            .iter()
            .find(|entry| entry.name == "destination")
            .unwrap();
        move_workspace_entry_blocking(
            workspace.clone(),
            outer.handle.clone(),
            directory_destination.handle.clone(),
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &CancellationToken::new(),
        )
        .unwrap();
        {
            let mut authority = state.pgn_path_authority.raw_for_test().lock().unwrap();
            let authority = authority.as_mut().unwrap();
            assert_eq!(
                authority.parent_identity_for_test(child.handle.path_ref()),
                Some(original_child_parent)
            );
            assert_eq!(
                authority
                    .workspace_entry_path(&child.handle, PathOperation::ReadPgn)
                    .unwrap(),
                destination_path.join("outer/child.pgn")
            );
            assert!(authority
                .resolve(child.handle.path_ref(), PathOperation::ReadPgn, &[])
                .is_ok());
        }
    }
}

#[cfg(test)]
mod root_failure_tests {
    use super::*;
    use crate::error::{ErrorCategory, RootFailure};
    use crate::infra::path_authority::{probe_listing_root_failure, SystemClock};

    fn root_failure_fixture() -> (
        tempfile::TempDir,
        SharedPathAuthority,
        FileWorkspaceHandle,
        PathBuf,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("workspace");
        fs::create_dir(&root).unwrap();
        let mut registry = PathAuthority::open_with_clock(
            directory.path().join("registry.json"),
            vec![],
            Arc::new(SystemClock),
            2,
        )
        .unwrap();
        let id = registry
            .migrate_legacy_os_path(
                root.clone().into_os_string(),
                "workspace",
                PathClass::PersistentCustomRoot,
                vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            )
            .unwrap()
            .id;
        (
            directory,
            SharedPathAuthority::installed(registry),
            FileWorkspaceHandle::new(id),
            root,
        )
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn listing_child_root_stream_failure_labels_the_command_and_preserves_registry() {
        use crate::infra::fs::{scoped_test_removal_injector, RemovalFaultPoint, RemovalInjector};
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct StreamPermission(Arc<AtomicUsize>);
        impl RemovalInjector for StreamPermission {
            fn inject(&self, point: RemovalFaultPoint) -> std::io::Result<Option<u64>> {
                if point == RemovalFaultPoint::BeforeDirOpen {
                    self.0.fetch_add(1, Ordering::SeqCst);
                    return Err(std::io::ErrorKind::PermissionDenied.into());
                }
                Ok(None)
            }
        }

        let (directory, registry, workspace, root) = root_failure_fixture();
        fs::write(root.join("known.pgn"), b"*").unwrap();
        collect_tree_entries(&registry, &workspace, &CancellationToken::new()).unwrap();
        let before = fs::read(directory.path().join("registry.json")).unwrap();
        fs::write(root.join("new.pgn"), b"*").unwrap();
        let attempts = Arc::new(AtomicUsize::new(0));
        let _guard = scoped_test_removal_injector(Arc::new(StreamPermission(attempts.clone())));
        let result = list_file_workspace_core(
            &workspace,
            &registry,
            &pgn::PgnRepository::default(),
            &CancellationToken::new(),
        )
        .await;
        let error = result.unwrap_err();
        assert_eq!(error.category(), ErrorCategory::Permission);
        assert_eq!(error.root_failure(), Some(RootFailure::Permission));
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            2,
            "the listing and the root probe must both reach the directory stream"
        );
        assert_eq!(
            fs::read(directory.path().join("registry.json")).unwrap(),
            before
        );
    }

    #[tokio::test]
    async fn root_failure_files_failed_listing_cancels_at_probe_is_unlabelled() {
        use crate::infra::path_authority::{
            ListingRootFailureHookGuard, LISTING_ROOT_FAILURE_HOOKS,
        };

        let (_directory, registry, workspace, root) = root_failure_fixture();
        fs::remove_dir(&root).unwrap();
        let token = CancellationToken::new();
        let cancel = token.clone();
        let _hook = ListingRootFailureHookGuard(workspace.path_ref().id.clone());
        LISTING_ROOT_FAILURE_HOOKS.arm(
            workspace.path_ref().id.clone(),
            Box::new(move |original| {
                assert!(
                    matches!(original, Error::Io(error) if error.kind() == std::io::ErrorKind::NotFound)
                );
                assert_eq!(original.root_failure(), None);
                cancel.cancel();
            }),
        );
        let error = list_file_workspace_core(
            &workspace,
            &registry,
            &pgn::PgnRepository::default(),
            &token,
        )
        .await
        .unwrap_err();
        assert!(
            token.is_cancelled(),
            "the failed listing must reach its probe"
        );
        assert!(matches!(error, Error::Cancellation));
        assert_eq!(error.root_failure(), None);
    }

    #[tokio::test]
    async fn root_failure_files_root_removed_or_replaced_before_listing_keeps_original_error() {
        for reason in [
            RootFailure::Missing,
            RootFailure::Changed,
            RootFailure::Unusable,
        ] {
            let (directory, registry, workspace, root) = root_failure_fixture();
            fs::rename(&root, directory.path().join("old-root")).unwrap();
            match reason {
                RootFailure::Missing => {}
                RootFailure::Changed => fs::create_dir(&root).unwrap(),
                RootFailure::Unusable => fs::write(&root, b"not a directory").unwrap(),
                _ => unreachable!(),
            }
            let original =
                collect_tree_entries(&registry, &workspace, &CancellationToken::new()).unwrap_err();
            assert_eq!(original.root_failure(), None);
            if reason == RootFailure::Unusable {
                assert!(
                    matches!(&original, Error::InvalidInput(message) if message == "root authority must be a directory")
                );
                assert_eq!(original.category(), ErrorCategory::InvalidInput);
                assert_eq!(
                    original.to_string(),
                    "Invalid input: root authority must be a directory"
                );
            }
            let error = list_file_workspace_core(
                &workspace,
                &registry,
                &pgn::PgnRepository::default(),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
            assert_eq!(error.root_failure(), Some(reason));
            assert_eq!(error.category(), original.category());
            assert_eq!(error.to_string(), original.to_string());
            assert_eq!(error.diagnostic(), original.diagnostic());
            let before = serde_json::to_value(&original).unwrap();
            let after = serde_json::to_value(&error).unwrap();
            assert_eq!(after["category"], before["category"]);
            assert_eq!(after["message"], before["message"]);
            assert_eq!(after["rootFailure"], serde_json::to_value(reason).unwrap());
        }
    }

    #[tokio::test]
    async fn root_failure_child_pgn_removed_or_replaced_between_walk_and_count_is_unlabelled() {
        for replace in [false, true] {
            let (directory, registry, workspace, root) = root_failure_fixture();
            fs::write(root.join("child.pgn"), b"*").unwrap();
            let saved = directory.path().join("old.pgn");
            ROOT_FAILURE_POST_WALK_HOOK.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(move || {
                    fs::rename(root.join("child.pgn"), saved).unwrap();
                    if replace {
                        fs::write(root.join("child.pgn"), b"*").unwrap();
                    }
                }));
            });
            let error = list_file_workspace_core(
                &workspace,
                &registry,
                &pgn::PgnRepository::default(),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
            assert_eq!(error.root_failure(), None, "{error:?}");
            assert_eq!(
                error.category(),
                if replace {
                    ErrorCategory::Conflict
                } else {
                    ErrorCategory::MissingResource
                }
            );
            assert_eq!(
                error.to_string(),
                if replace {
                    "Conflict: path authority is unavailable because its object changed"
                } else {
                    "I/O failure"
                }
            );
        }
    }

    #[tokio::test]
    async fn root_failure_root_removed_or_replaced_during_files_listing_keeps_original_error() {
        for replace in [false, true] {
            let (directory, registry, workspace, root) = root_failure_fixture();
            fs::write(root.join("child.pgn"), b"*").unwrap();
            let saved = directory.path().join("old-root");
            ROOT_FAILURE_POST_WALK_HOOK.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(move || {
                    fs::rename(&root, saved).unwrap();
                    if replace {
                        fs::create_dir(&root).unwrap();
                    }
                }));
            });
            let error = list_file_workspace_core(
                &workspace,
                &registry,
                &pgn::PgnRepository::default(),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
            assert_eq!(
                error.root_failure(),
                Some(if replace {
                    RootFailure::Changed
                } else {
                    RootFailure::Missing
                }),
                "{error:?}"
            );
            // The missing child is the original failure, even when the probe finds a changed root.
            assert_eq!(error.category(), ErrorCategory::MissingResource);
            assert_eq!(error.to_string(), "I/O failure");
        }
    }

    #[tokio::test]
    async fn root_failure_files_listing_authority_poison_and_initialization_stay_unlabelled() {
        for poison in [false, true] {
            let (_directory, registry, workspace, _root) = root_failure_fixture();
            if poison {
                registry.poison();
            } else {
                registry.uninstall();
            }
            let error = list_file_workspace_core(
                &workspace,
                &registry,
                &pgn::PgnRepository::default(),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
            assert_eq!(error.root_failure(), None);
            assert_eq!(
                error.to_string(),
                if poison {
                    "Conflict: path authority lock was poisoned"
                } else {
                    "Conflict: path authority is not initialized"
                }
            );
            let original = Error::InvalidInput("original child failure".into());
            let probed = probe_listing_root_failure(
                &registry,
                workspace.path_ref(),
                PathOperation::ReadPgn,
                original,
                &CancellationToken::new(),
            );
            assert_eq!(probed.root_failure(), None);
            assert_eq!(probed.to_string(), "Invalid input: original child failure");
        }
    }

    #[tokio::test]
    async fn root_failure_files_bounds_keep_category_and_message() {
        for depth in [false, true] {
            let (_directory, registry, workspace, root) = root_failure_fixture();
            if depth {
                let mut child = root;
                for _ in 0..=MAX_WORKSPACE_LISTING_DEPTH {
                    child = child.join("d");
                    fs::create_dir(&child).unwrap();
                }
            } else {
                for index in 0..=MAX_DIRECTORY_LISTING_ENTRIES {
                    fs::write(root.join(index.to_string()), b"").unwrap();
                }
            }
            let error = list_file_workspace_core(
                &workspace,
                &registry,
                &pgn::PgnRepository::default(),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
            assert_eq!(error.root_failure(), Some(RootFailure::TooLarge));
            assert_eq!(error.category(), ErrorCategory::ResourceLimit);
            assert_eq!(
                error.to_string(),
                if depth {
                    format!("Resource limit: workspace listing exceeded {MAX_WORKSPACE_LISTING_DEPTH} levels")
                } else {
                    format!("Resource limit: directory listing exceeded {MAX_DIRECTORY_LISTING_ENTRIES} entries")
                }
            );
        }
    }

    #[test]
    fn root_failure_file_picker_same_path_refusal_is_changed() {
        let (directory, registry, _workspace, root) = root_failure_fixture();
        // The fixture already persisted this picker path.
        fs::rename(&root, directory.path().join("old-root")).unwrap();
        fs::create_dir(&root).unwrap();
        let error = issue_file_workspace_blocking(&registry, root).unwrap_err();
        assert_eq!(error.root_failure(), Some(RootFailure::Changed));
        assert_eq!(error.category(), ErrorCategory::Conflict);
        assert_eq!(
            error.to_string(),
            "Conflict: persistent target changed; acquire a new capability"
        );
    }

    #[cfg(unix)]
    #[test]
    fn root_failure_listing_child_stat_miss_is_omitted_without_a_root_failure() {
        let (_directory, registry, workspace, root) = root_failure_fixture();
        fs::write(root.join("child.pgn"), b"*").unwrap();
        fs::write(root.join("intact.pgn"), b"*").unwrap();
        collect_tree_entries(&registry, &workspace, &CancellationToken::new()).unwrap();
        let child = root.join("child.pgn");
        crate::infra::fs::set_read_directory_pre_stat_hook(Some(Box::new(move |name| {
            if name == OsStr::new("child.pgn") {
                fs::remove_file(&child).unwrap();
            }
        })));
        let listing = collect_tree_entries(&registry, &workspace, &CancellationToken::new());
        crate::infra::fs::set_read_directory_pre_stat_hook(None);
        let (listing, _) = listing.unwrap();
        assert!(listing.unread.is_empty());
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].name, "intact");
    }
}

#[cfg(unix)]
#[cfg(test)]
mod workspace_directory_enumeration_tests {
    use super::*;
    use crate::infra::path_authority::{
        set_capability_child_pre_open_hook, set_capability_directory_post_entries_hook,
        set_workspace_metadata_post_open_hook, set_workspace_metadata_pre_open_hook, PathAuthority,
        SystemClock,
    };
    use std::os::unix::fs::FileExt;
    use std::os::unix::fs::MetadataExt;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use tempfile::TempDir;

    fn workspace_fixture() -> (TempDir, SharedPathAuthority, FileWorkspaceHandle, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("workspace");
        fs::create_dir(&root).unwrap();
        let mut authority = PathAuthority::open_with_clock(
            directory.path().join("registry.json"),
            vec![],
            Arc::new(SystemClock),
            2,
        )
        .unwrap();
        let id = authority
            .migrate_legacy_os_path(
                root.clone().into_os_string(),
                "workspace",
                PathClass::PersistentCustomRoot,
                vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            )
            .unwrap()
            .id;
        (
            directory,
            SharedPathAuthority::installed(authority),
            FileWorkspaceHandle::new(id),
            root,
        )
    }

    #[test]
    fn listing_child_named_stat_permission_uses_enumerated_kind_and_retains_snapshot_ids() {
        for (directory_child, unknown_kind) in [(false, false), (true, false), (true, true)] {
            let (_directory, authority, workspace, root) = workspace_fixture();
            let child = root.join("blocked.pgn");
            if directory_child {
                fs::create_dir(&child).unwrap();
                fs::write(child.join("inner.pgn"), b"*").unwrap();
            } else {
                fs::write(&child, b"*").unwrap();
            }
            fs::write(root.join("healthy.pgn"), b"*").unwrap();
            let (before, _) =
                collect_tree_entries(&authority, &workspace, &CancellationToken::new()).unwrap();
            let healthy = before
                .entries
                .iter()
                .find(|entry| entry.name == "healthy")
                .unwrap()
                .handle
                .clone();
            let blocked = before
                .entries
                .iter()
                .find(|entry| {
                    entry.name
                        == if directory_child {
                            "blocked.pgn"
                        } else {
                            "blocked"
                        }
                })
                .unwrap();
            let mut retained = vec![blocked.handle.clone()];
            retained.extend(blocked.children.iter().map(|entry| entry.handle.clone()));
            crate::infra::fs::set_listing_child_stat_hook(Some(Box::new(move |name, kind| {
                (name == OsStr::new("blocked.pgn")).then(|| {
                    (
                        if unknown_kind { None } else { kind },
                        std::io::ErrorKind::PermissionDenied.into(),
                    )
                })
            })));
            let result = collect_tree_entries(&authority, &workspace, &CancellationToken::new());
            crate::infra::fs::set_listing_child_stat_hook(None);
            let (listing, missing) = result.unwrap();
            assert_eq!(listing.entries.len(), 1);
            assert_eq!(listing.entries[0].handle, healthy);
            assert_eq!(missing, vec![healthy]);
            assert_eq!(listing.unread.len(), 1);
            let unread = &listing.unread[0];
            assert_eq!(unread.name, "blocked.pgn");
            assert_eq!(unread.category, ErrorCategory::Permission);
            assert_eq!(
                unread.kind,
                if unknown_kind {
                    None
                } else {
                    Some(if directory_child {
                        WorkspaceEntryKind::Directory
                    } else {
                        WorkspaceEntryKind::File
                    })
                }
            );
            let payload = serde_json::to_value(&listing).unwrap();
            assert!(payload["unread"][0].get("handle").is_none());
            assert!(payload["unread"][0].get("path").is_none());
            authority
                .with_mut(|authority| {
                    for handle in retained {
                        authority
                            .resolve(handle.path_ref(), PathOperation::ReadPgn, &[])
                            .unwrap();
                    }
                })
                .unwrap();
        }
    }

    #[test]
    fn listing_child_named_stat_regular_file_retains_only_the_named_snapshot_id() {
        let (directory, authority, workspace, root) = workspace_fixture();
        let child = root.join("blocked.pgn");
        fs::create_dir(&child).unwrap();
        fs::write(child.join("inner.pgn"), b"*").unwrap();
        fs::write(root.join("healthy.pgn"), b"*").unwrap();
        collect_tree_entries(&authority, &workspace, &CancellationToken::new()).unwrap();
        let before = authority
            .raw_for_test()
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .persistent_snapshot_for_test();
        let blocked = before
            .iter()
            .find(|(name, _, _)| name == "blocked.pgn")
            .unwrap()
            .clone();
        fs::rename(&child, directory.path().join("old-directory")).unwrap();
        fs::write(&child, b"*").unwrap();
        crate::infra::fs::set_listing_child_stat_hook(Some(Box::new(|name, kind| {
            (name == OsStr::new("blocked.pgn")).then(|| {
                assert_eq!(kind, Some(DirectoryEntryKind::RegularFile));
                (kind, std::io::ErrorKind::PermissionDenied.into())
            })
        })));
        let result = collect_tree_entries(&authority, &workspace, &CancellationToken::new());
        crate::infra::fs::set_listing_child_stat_hook(None);
        let (listing, _) = result.unwrap();
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.unread.len(), 1);
        assert_eq!(listing.unread[0].kind, Some(WorkspaceEntryKind::File));
        let after = authority
            .raw_for_test()
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .persistent_snapshot_for_test();
        assert!(after.contains(&blocked));
        assert!(!after.iter().any(|(name, _, _)| name == "inner"));
    }

    #[tokio::test]
    async fn listing_child_permission_retains_file_and_directory_descendants_without_handles() {
        use std::os::unix::fs::PermissionsExt;
        for directory_child in [false, true] {
            let (_directory, authority, workspace, root) = workspace_fixture();
            let child = root.join(if directory_child {
                "blocked"
            } else {
                "blocked.pgn"
            });
            if directory_child {
                fs::create_dir(&child).unwrap();
                fs::write(child.join("inner.pgn"), b"*").unwrap();
            } else {
                fs::write(&child, b"*").unwrap();
            }
            fs::write(root.join("healthy.pgn"), b"*").unwrap();
            let (before, _) =
                collect_tree_entries(&authority, &workspace, &CancellationToken::new()).unwrap();
            let healthy = before
                .entries
                .iter()
                .find(|entry| entry.name == "healthy")
                .unwrap()
                .handle
                .clone();
            let blocked = before
                .entries
                .iter()
                .find(|entry| entry.name == "blocked")
                .unwrap();
            let mut retained = vec![blocked.handle.clone()];
            retained.extend(blocked.children.iter().map(|entry| entry.handle.clone()));
            fs::set_permissions(&child, fs::Permissions::from_mode(0o000)).unwrap();
            let listing = list_file_workspace_core(
                &workspace,
                &authority,
                &pgn::PgnRepository::default(),
                &CancellationToken::new(),
            )
            .await;
            fs::set_permissions(
                &child,
                fs::Permissions::from_mode(if directory_child { 0o700 } else { 0o600 }),
            )
            .unwrap();
            let listing = listing.unwrap();
            assert_eq!(
                listing
                    .entries
                    .iter()
                    .find(|entry| entry.name == "healthy")
                    .unwrap()
                    .handle,
                healthy
            );
            if directory_child {
                assert_eq!(listing.unread.len(), 1);
                assert_eq!(listing.unread[0].category, ErrorCategory::Permission);
                assert_eq!(listing.unread[0].parent, None);
            } else {
                let blocked = listing
                    .entries
                    .iter()
                    .find(|entry| entry.name == "blocked")
                    .unwrap();
                assert_eq!(blocked.read_error, Some(ErrorCategory::Permission));
                assert_eq!(blocked.game_count, None);
                assert_eq!(blocked.handle, retained[0]);
            }
            let payload = serde_json::to_value(&listing).unwrap();
            assert!(payload["unread"][0].get("handle").is_none());
            assert!(payload["unread"][0].get("path").is_none());
            assert!(!payload.to_string().contains(root.to_str().unwrap()));
            authority
                .with_mut(|authority| {
                    for handle in retained {
                        authority
                            .resolve(handle.path_ref(), PathOperation::ReadPgn, &[])
                            .unwrap();
                    }
                })
                .unwrap();
        }
    }

    #[cfg(not(target_os = "macos"))]
    #[tokio::test]
    async fn listing_child_file_lossy_names_keep_two_read_error_rows() {
        use std::os::unix::{ffi::OsStringExt, fs::PermissionsExt};
        let (_directory, authority, workspace, root) = workspace_fixture();
        let names = [
            std::ffi::OsString::from_vec(vec![0x80, b'.', b'p', b'g', b'n']),
            std::ffi::OsString::from_vec(vec![0x81, b'.', b'p', b'g', b'n']),
        ];
        for name in &names {
            fs::write(root.join(name), b"*").unwrap();
            fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o000)).unwrap();
        }
        let result = list_file_workspace_core(
            &workspace,
            &authority,
            &pgn::PgnRepository::default(),
            &CancellationToken::new(),
        )
        .await;
        for name in &names {
            fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o600)).unwrap();
        }
        let listing = result.unwrap();
        assert_eq!(listing.entries.len(), 2);
        assert_eq!(listing.entries[0].name, listing.entries[1].name);
        assert_ne!(listing.entries[0].handle, listing.entries[1].handle);
        assert!(listing
            .entries
            .iter()
            .all(|entry| entry.read_error == Some(ErrorCategory::Permission)
                && entry.game_count.is_none()));
        assert!(!serde_json::to_string(&listing)
            .unwrap()
            .contains(root.to_str().unwrap()));
    }

    #[tokio::test]
    async fn listing_child_sidecar_errors_keep_default_metadata_and_openable_games() {
        for (bytes, category) in [
            (b"not JSON".to_vec(), ErrorCategory::InvalidInput),
            (
                vec![b'x'; MAX_WORKSPACE_METADATA_BYTES + 1],
                ErrorCategory::ResourceLimit,
            ),
        ] {
            let (_directory, authority, workspace, root) = workspace_fixture();
            fs::write(root.join("a.pgn"), b"[Event \"A\"]\n\n*\n").unwrap();
            fs::write(root.join("a.info"), bytes).unwrap();
            let token = CancellationToken::new();
            let repository = pgn::PgnRepository::default();
            let listing = list_file_workspace_core(&workspace, &authority, &repository, &token)
                .await
                .unwrap();
            assert!(listing.unread.is_empty());
            let file = &listing.entries[0];
            assert_eq!(file.read_error, Some(category));
            assert_eq!(file.metadata, Some(WorkspaceMetadata::default()));
            assert_eq!(file.game_count, Some(1));
            let resolved = authority
                .with_mut(|authority| {
                    authority.resolve(file.handle.path_ref(), PathOperation::ReadPgn, &[])
                })
                .unwrap()
                .unwrap();
            assert_eq!(
                pgn::read_games_core(resolved, 0, 0, &token, &repository)
                    .await
                    .unwrap()
                    .len(),
                1
            );
        }
    }

    #[tokio::test]
    async fn listing_child_sidecar_permission_still_confirms_and_counts_the_pgn() {
        use std::os::unix::fs::PermissionsExt;
        let (_directory, authority, workspace, root) = workspace_fixture();
        fs::write(root.join("a.pgn"), b"*").unwrap();
        let sidecar = root.join("a.info");
        fs::write(&sidecar, b"unread").unwrap();
        fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o000)).unwrap();
        let result = list_file_workspace_core(
            &workspace,
            &authority,
            &pgn::PgnRepository::default(),
            &CancellationToken::new(),
        )
        .await;
        fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o600)).unwrap();
        let listing = result.unwrap();
        assert!(listing.unread.is_empty());
        assert_eq!(listing.entries[0].game_count, Some(1));
        assert_eq!(
            listing.entries[0].metadata,
            Some(WorkspaceMetadata::default())
        );
        assert_eq!(
            listing.entries[0].read_error,
            Some(ErrorCategory::Permission)
        );
    }

    #[tokio::test]
    async fn listing_child_invalid_scanner_data_keeps_handle_and_counts_siblings() {
        let (_directory, authority, workspace, root) = workspace_fixture();
        fs::write(root.join("bad.pgn"), b"[Event \"A\"]\n\n{ open\n").unwrap();
        fs::write(root.join("healthy.pgn"), b"*").unwrap();
        let listing = list_file_workspace_core(
            &workspace,
            &authority,
            &pgn::PgnRepository::default(),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert!(listing.unread.is_empty());
        let bad = listing
            .entries
            .iter()
            .find(|entry| entry.name == "bad")
            .unwrap();
        assert_eq!(bad.game_count, None);
        assert_eq!(bad.read_error, Some(ErrorCategory::Io));
        assert_eq!(
            listing
                .entries
                .iter()
                .find(|entry| entry.name == "healthy")
                .unwrap()
                .game_count,
            Some(1)
        );
        authority
            .with_mut(|authority| {
                authority.resolve(bad.handle.path_ref(), PathOperation::ReadPgn, &[])
            })
            .unwrap()
            .unwrap();
    }

    #[test]
    fn listing_child_listing_count_error_aborts_transient_and_unclassified_failures() {
        for error in [
            Error::Cancellation,
            Error::Conflict("replacement".into()),
            Error::from(std::io::Error::from(std::io::ErrorKind::NotFound)),
            Error::from(std::io::Error::from(std::io::ErrorKind::Other)),
            Error::ResourceLimit("directory bound".into())
                .with_root_failure(crate::error::RootFailure::TooLarge),
        ] {
            assert!(listing_count_error(error).is_err());
        }
        assert_eq!(
            listing_count_error(Error::ResourceLimit(pgn::COUNT_LIMIT_MESSAGE.into())).unwrap(),
            ErrorCategory::ResourceLimit
        );
    }

    #[test]
    fn collect_tree_entries_matches_the_workspace_shape() {
        use std::os::unix::fs::symlink;
        #[cfg(not(target_os = "macos"))]
        use std::{
            ffi::OsString,
            os::unix::ffi::{OsStrExt, OsStringExt},
        };

        let (directory, authority, workspace, root) = workspace_fixture();
        fs::write(root.join("a.pgn"), b"*").unwrap();
        fs::write(
            root.join("a.info"),
            br#"{"type":"game","tags":["trusted"]}"#,
        )
        .unwrap();
        fs::write(root.join("B.PGN"), b"*").unwrap();
        // APFS cannot store non-UTF-8 file names
        #[cfg(not(target_os = "macos"))]
        let raw_first = OsString::from_vec(b"\x81.pgn".to_vec());
        // APFS cannot store non-UTF-8 file names
        #[cfg(not(target_os = "macos"))]
        let raw_second = OsString::from_vec(b"\x80_.pgn".to_vec());
        // APFS cannot store non-UTF-8 file names
        #[cfg(not(target_os = "macos"))]
        {
            fs::write(root.join(&raw_first), b"*").unwrap();
            fs::write(root.join(&raw_second), b"*").unwrap();
            let raw_order = [&raw_first, &raw_second];
            let lossy_order = raw_order
                .iter()
                .map(|name| name.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            let raw_cmp = raw_order[0].as_bytes().cmp(raw_order[1].as_bytes());
            let lossy_cmp = lossy_order[0].cmp(&lossy_order[1]);
            assert_ne!(raw_cmp, lossy_cmp);
        }
        fs::write(root.join("notes.txt"), b"notes").unwrap();
        let nested = root.join("nested");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("inner.pgn"), b"*").unwrap();
        fs::create_dir(root.join(TRASH_DIRECTORY)).unwrap();
        fs::create_dir(nested.join(TRASH_DIRECTORY)).unwrap();
        let outside = directory.path().join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(root.join("a.pgn"), root.join("linked.pgn")).unwrap();
        symlink(&outside, root.join("linked-dir")).unwrap();
        let fifo = root.join("f.pgn");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(status.success());

        let (entries, missing) =
            collect_tree_entries(&authority, &workspace, &CancellationToken::new()).unwrap();
        let top_names = entries
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>();
        // APFS cannot store non-UTF-8 file names
        #[cfg(not(target_os = "macos"))]
        let expected_top_names = ["B.PGN", "a", "nested", "�_", "�"];
        // APFS cannot store non-UTF-8 file names
        #[cfg(target_os = "macos")]
        let expected_top_names = ["B.PGN", "a", "nested"];
        assert_eq!(top_names, expected_top_names);
        let a_entry = entries
            .entries
            .iter()
            .find(|entry| entry.name == "a")
            .unwrap();
        assert_eq!(a_entry.kind, WorkspaceEntryKind::File);
        assert_eq!(a_entry.metadata.as_ref().unwrap().tags, ["trusted"]);
        let nested_entry = entries
            .entries
            .iter()
            .find(|entry| entry.name == "nested")
            .unwrap();
        assert_eq!(nested_entry.kind, WorkspaceEntryKind::Directory);
        assert_eq!(nested_entry.children.len(), 1);
        assert_eq!(nested_entry.children[0].name, "inner");
        assert_eq!(nested_entry.children[0].kind, WorkspaceEntryKind::File);

        fn flatten<'a>(entries: &'a [WorkspaceEntry], out: &mut Vec<&'a WorkspaceEntry>) {
            for entry in entries {
                out.push(entry);
                flatten(&entry.children, out);
            }
        }
        let mut listed = Vec::new();
        flatten(&entries.entries, &mut listed);
        // APFS cannot store non-UTF-8 file names
        #[cfg(not(target_os = "macos"))]
        let expected_missing = 5;
        // APFS cannot store non-UTF-8 file names
        #[cfg(target_os = "macos")]
        let expected_missing = 3;
        assert_eq!(missing.len(), expected_missing);
        let listed_files = listed
            .iter()
            .filter(|entry| entry.kind == WorkspaceEntryKind::File)
            .collect::<Vec<_>>();
        assert_eq!(listed_files.len(), missing.len());
        assert!(listed_files
            .iter()
            .all(|entry| missing.iter().any(|handle| handle == &entry.handle)));
        assert!(missing
            .iter()
            .all(|handle| { missing.iter().filter(|other| *other == handle).count() == 1 }));
        let mut guard = authority.raw_for_test().lock().unwrap();
        let authority = guard.as_mut().unwrap();
        let snapshot = authority.persistent_snapshot_for_test();
        // APFS cannot store non-UTF-8 file names
        #[cfg(not(target_os = "macos"))]
        let expected_paths = [
            root.join("a.pgn"),
            root.join("B.PGN"),
            root.join(&raw_first),
            root.join(&raw_second),
            nested.join("inner.pgn"),
        ];
        // APFS cannot store non-UTF-8 file names
        #[cfg(target_os = "macos")]
        let expected_paths = [
            root.join("a.pgn"),
            root.join("B.PGN"),
            nested.join("inner.pgn"),
        ];
        // APFS cannot store non-UTF-8 file names
        #[cfg(not(target_os = "macos"))]
        let expected_entries = [
            (root.join("a.pgn"), "a".to_string()),
            (root.join("B.PGN"), "B.PGN".to_string()),
            (root.join(&raw_first), "�".to_string()),
            (root.join(&raw_second), "�_".to_string()),
            (nested.clone(), "nested".to_string()),
            (nested.join("inner.pgn"), "inner".to_string()),
        ];
        // APFS cannot store non-UTF-8 file names
        #[cfg(target_os = "macos")]
        let expected_entries = [
            (root.join("a.pgn"), "a".to_string()),
            (root.join("B.PGN"), "B.PGN".to_string()),
            (nested.clone(), "nested".to_string()),
            (nested.join("inner.pgn"), "inner".to_string()),
        ];
        for entry in &listed {
            let (path, _) = expected_entries
                .iter()
                .find(|(_, display)| display == &entry.name)
                .unwrap();
            assert_eq!(entry.last_modified, mtime_seconds(path));
        }
        for entry in &listed_files {
            let resolved = authority
                .resolve(entry.handle.path_ref(), PathOperation::ReadPgn, &[])
                .unwrap();
            let path = expected_paths
                .iter()
                .find(|path| {
                    let filename = path.file_name().unwrap().to_string_lossy();
                    let display = if filename.ends_with(".pgn") {
                        filename.trim_end_matches(".pgn").to_string()
                    } else {
                        filename.into_owned()
                    };
                    display == entry.name
                })
                .unwrap();
            use std::os::unix::fs::MetadataExt;
            let metadata = fs::symlink_metadata(path).unwrap();
            let identity = (metadata.dev(), metadata.ino());
            assert!(snapshot
                .iter()
                .any(|(_, observed, is_dir)| { !*is_dir && *observed == identity }));
            assert_eq!(entry.last_modified, mtime_seconds(path));
            let _ = resolved;
        }
        assert!(missing
            .iter()
            .all(|handle| { listed_files.iter().any(|entry| entry.handle == *handle) }));
    }

    #[test]
    fn directory_listing_bound_workspace_counts_dropped_names_without_registry_writes(
    ) -> Result<(), Error> {
        let (_directory, registry, workspace, root) = workspace_fixture();
        let before = registry
            .raw_for_test()
            .lock()
            .unwrap()
            .as_ref()
            .ok_or_else(|| Error::Conflict("test authority missing".into()))?
            .persistent_snapshot_for_test();
        for index in 0..MAX_DIRECTORY_LISTING_ENTRIES {
            fs::write(root.join(format!("{index}.txt")), b"")?;
        }
        assert!(
            collect_tree_entries(&registry, &workspace, &CancellationToken::new())?
                .0
                .entries
                .is_empty()
        );
        fs::write(root.join("overflow.pgn"), b"*")?;
        assert!(matches!(
            collect_tree_entries(&registry, &workspace, &CancellationToken::new()),
            Err(ref error) if matches!(error.unlabelled(), Error::ResourceLimit(_))
        ));
        assert_eq!(
            registry
                .raw_for_test()
                .lock()
                .unwrap()
                .as_ref()
                .ok_or_else(|| Error::Conflict("test authority missing".into()))?
                .persistent_snapshot_for_test(),
            before
        );
        Ok(())
    }

    #[test]
    fn directory_listing_bound_workspace_listing_child_staged_nodes_are_bounded_across_directories(
    ) -> Result<(), Error> {
        let (_directory, registry, workspace, root) = workspace_fixture();
        let before = registry
            .raw_for_test()
            .lock()
            .unwrap()
            .as_ref()
            .ok_or_else(|| Error::Conflict("test authority missing".into()))?
            .persistent_snapshot_for_test();
        for name in ["a", "b"] {
            let sub = root.join(name);
            fs::create_dir(&sub)?;
            for index in 0..MAX_DIRECTORY_LISTING_ENTRIES / 2 {
                fs::write(sub.join(format!("{index}.pgn")), b"*")?;
            }
        }
        assert!(matches!(
            collect_tree_entries(&registry, &workspace, &CancellationToken::new()),
            Err(ref error) if matches!(error.unlabelled(), Error::ResourceLimit(_))
        ));
        assert_eq!(
            registry
                .raw_for_test()
                .lock()
                .unwrap()
                .as_ref()
                .ok_or_else(|| Error::Conflict("test authority missing".into()))?
                .persistent_snapshot_for_test(),
            before
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn directory_listing_bound_workspace_listing_child_count_failure_and_late_cancellation_keep_snapshot(
    ) -> Result<(), Box<dyn std::error::Error>> {
        for cancel_count in [false, true] {
            let (_directory, registry, workspace, root) = workspace_fixture();
            let registry = Arc::new(registry);
            fs::write(root.join("old.pgn"), b"*")?;
            collect_tree_entries(&registry, &workspace, &CancellationToken::new())?;
            fs::remove_file(root.join("old.pgn"))?;
            fs::write(root.join("new.pgn"), b"*")?;
            let repository = pgn::PgnRepository::default();
            let (hook, entered, release) = pgn::BoundedHook::new();
            repository.set_count_hook(Some(hook))?;
            let token = CancellationToken::new();
            let task = tokio::spawn({
                let registry = registry.clone();
                let workspace = workspace.clone();
                let repository = repository.clone();
                let token = token.clone();
                async move { list_file_workspace_core(&workspace, &registry, &repository, &token).await }
            });
            tokio::time::timeout(Duration::from_secs(5), entered).await??;
            let snapshot = registry
                .raw_for_test()
                .lock()
                .unwrap()
                .as_ref()
                .ok_or_else(|| Error::Conflict("test authority missing".into()))?
                .persistent_snapshot_for_test();
            assert!(snapshot.iter().any(|(name, _, _)| name == "new"));
            assert!(!snapshot.iter().any(|(name, _, _)| name == "old"));
            if cancel_count {
                token.cancel();
            } else {
                fs::write(root.join("new.pgn"), [0xff, b'\n'])?;
            }
            release.send(())?;
            let result = task.await?;
            if cancel_count {
                assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
            } else {
                let listing = result?;
                assert_eq!(listing.entries[0].game_count, None);
                assert_eq!(listing.entries[0].read_error, Some(ErrorCategory::Io));
            }
            assert_eq!(
                registry
                    .raw_for_test()
                    .lock()
                    .unwrap()
                    .as_ref()
                    .ok_or_else(|| Error::Conflict("test authority missing".into()))?
                    .persistent_snapshot_for_test(),
                snapshot
            );
        }
        Ok(())
    }

    #[test]
    fn directory_listing_bound_workspace_snapshot_retires_missing_preserves_trash_and_concurrent_create(
    ) -> Result<(), Error> {
        let (_directory, registry, workspace, root) = workspace_fixture();
        let registry = Arc::new(registry);
        fs::write(root.join("removed.pgn"), b"*")?;
        collect_tree_entries(&registry, &workspace, &CancellationToken::new())?;
        fs::remove_file(root.join("removed.pgn"))?;
        fs::create_dir(root.join(TRASH_DIRECTORY))?;
        let trash_file = root.join(TRASH_DIRECTORY).join("hidden.pgn");
        fs::write(&trash_file, b"*")?;
        let file_stat = fs::metadata(&trash_file)?;
        let parent_stat = fs::metadata(root.join(TRASH_DIRECTORY))?;
        let trash_handle = registry
            .raw_for_test()
            .lock()
            .unwrap()
            .as_mut()
            .ok_or_else(|| Error::Conflict("test authority missing".into()))?
            .register_workspace_child_observed_with_parent(
                &workspace,
                &[TRASH_DIRECTORY.into(), "hidden.pgn".into()],
                "hidden",
                IdentityBinding::from_pairs(
                    (file_stat.dev(), file_stat.ino()),
                    (parent_stat.dev(), parent_stat.ino()),
                ),
                false,
                PathOperation::ReadPgn,
            )?;
        let registry_for_hook = registry.clone();
        let workspace_for_hook = workspace.clone();
        let root_for_hook = root.clone();
        set_capability_directory_post_entries_hook(Some(Box::new(move || {
            let created = (|| -> Result<(), Error> {
                fs::write(root_for_hook.join("late.pgn"), b"*")?;
                let stat = fs::metadata(root_for_hook.join("late.pgn"))?;
                let parent = fs::metadata(&root_for_hook)?;
                registry_for_hook
                    .raw_for_test()
                    .lock()
                    .unwrap()
                    .as_mut()
                    .ok_or_else(|| Error::Conflict("test authority missing".into()))?
                    .register_workspace_child_observed_with_parent(
                        &workspace_for_hook,
                        &["late.pgn".into()],
                        "late",
                        IdentityBinding::from_pairs(
                            (stat.dev(), stat.ino()),
                            (parent.dev(), parent.ino()),
                        ),
                        false,
                        PathOperation::ReadPgn,
                    )?;
                Ok(())
            })();
            assert!(created.is_ok(), "{created:?}");
        })));
        let result = collect_tree_entries(&registry, &workspace, &CancellationToken::new());
        set_capability_directory_post_entries_hook(None);
        assert!(result?.0.entries.is_empty());
        let mut lock = registry.raw_for_test().lock().unwrap();
        let authority = lock
            .as_mut()
            .ok_or_else(|| Error::Conflict("test authority missing".into()))?;
        let snapshot = authority.persistent_snapshot_for_test();
        assert!(!snapshot.iter().any(|(name, _, _)| name == "removed"));
        assert!(snapshot.iter().any(|(name, _, _)| name == "late"));
        assert!(authority
            .resolve(trash_handle.path_ref(), PathOperation::ReadPgn, &[])
            .is_ok());
        Ok(())
    }

    fn mtime_seconds(path: &Path) -> i64 {
        use std::os::unix::fs::MetadataExt;
        fs::symlink_metadata(path).unwrap().mtime()
    }

    #[test]
    fn collect_tree_entries_lists_a_workspace_under_a_symlinked_ancestor() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let real = directory.path().join("real");
        let link = directory.path().join("link");
        let root = real.join("workspace");
        fs::create_dir_all(&root).unwrap();
        symlink(&real, &link).unwrap();
        fs::write(root.join("a.pgn"), b"*").unwrap();
        let mut authority = PathAuthority::open_with_clock(
            directory.path().join("registry.json"),
            vec![],
            Arc::new(SystemClock),
            2,
        )
        .unwrap();
        let id = authority
            .migrate_legacy_os_path(
                link.join("workspace").into_os_string(),
                "workspace",
                PathClass::PersistentCustomRoot,
                vec![PathOperation::ReadPgn],
            )
            .unwrap()
            .id;
        let workspace = FileWorkspaceHandle::new(id);
        let authority = SharedPathAuthority::installed(authority);
        let (entries, _) =
            collect_tree_entries(&authority, &workspace, &CancellationToken::new()).unwrap();
        assert_eq!(entries.entries[0].name, "a");
    }

    #[test]
    fn collect_tree_entries_refuses_a_directory_swapped_mid_walk() {
        use std::os::unix::fs::symlink;
        let (_directory, authority, workspace, root) = workspace_fixture();
        let sub = root.join("sub");
        let outside = root.join("outside");
        fs::create_dir(&sub).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("leak.pgn"), b"*").unwrap();
        let old = root.join("sub-old");
        let sub_for_hook = sub.clone();
        let outside_for_hook = outside.clone();
        set_capability_child_pre_open_hook(Some(Box::new(move || {
            fs::rename(&sub_for_hook, &old).unwrap();
            symlink(&outside_for_hook, &sub_for_hook).unwrap();
        })));
        let result = collect_tree_entries(&authority, &workspace, &CancellationToken::new());
        set_capability_child_pre_open_hook(None);
        assert!(matches!(result, Err(Error::Conflict(_))), "{result:?}");
        use std::os::unix::fs::MetadataExt;
        let outside_identity = (
            fs::symlink_metadata(&outside).unwrap().dev(),
            fs::symlink_metadata(&outside).unwrap().ino(),
        );
        let leak_identity = (
            fs::symlink_metadata(outside.join("leak.pgn"))
                .unwrap()
                .dev(),
            fs::symlink_metadata(outside.join("leak.pgn"))
                .unwrap()
                .ino(),
        );
        let snapshot = authority
            .raw_for_test()
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .persistent_snapshot_for_test();
        assert!(!snapshot.iter().any(|(_, identity, _)| {
            *identity == outside_identity || *identity == leak_identity
        }));
    }

    #[test]
    fn collect_tree_entries_never_returns_metadata_from_a_replaced_parent() {
        let (directory, authority, workspace, root) = workspace_fixture();
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        let pgn = sub.join("a.pgn");
        fs::write(&pgn, b"*").unwrap();
        let trusted_sidecar = br#"{"type":"game","tags":["trusted"]}"#.to_vec();
        fs::write(sub.join("a.info"), &trusted_sidecar).unwrap();
        let opened_sidecar = Arc::new(Mutex::new(None::<Vec<u8>>));
        let opened_sidecar_for_hook = Arc::clone(&opened_sidecar);
        set_workspace_metadata_post_open_hook(Some(Box::new(move |file| {
            let length = file.metadata().unwrap().len() as usize;
            let mut bytes = vec![0; length];
            let mut offset = 0;
            while offset < bytes.len() {
                let read = file.read_at(&mut bytes[offset..], offset as u64).unwrap();
                if read == 0 {
                    bytes.truncate(offset);
                    break;
                }
                offset += read;
            }
            *opened_sidecar_for_hook.lock().unwrap() = Some(bytes);
        })));
        let replacement_ran = Arc::new(AtomicBool::new(false));
        let replacement_ran_for_hook = Arc::clone(&replacement_ran);
        let sub_for_hook = sub.clone();
        let moved = directory.path().join("sub-old");
        set_workspace_metadata_pre_open_hook(Some(Box::new(move || {
            replacement_ran_for_hook.store(true, Ordering::SeqCst);
            fs::rename(&sub_for_hook, &moved).unwrap();
            fs::create_dir(&sub_for_hook).unwrap();
            fs::hard_link(moved.join("a.pgn"), sub_for_hook.join("a.pgn")).unwrap();
            fs::write(
                sub_for_hook.join("a.info"),
                br#"{"type":"game","tags":["attacker"]}"#,
            )
            .unwrap();
        })));
        let result = collect_tree_entries(&authority, &workspace, &CancellationToken::new());
        set_workspace_metadata_pre_open_hook(None);
        set_workspace_metadata_post_open_hook(None);
        assert!(replacement_ran.load(Ordering::SeqCst));
        let recorded_sidecar = opened_sidecar.lock().unwrap().clone();
        assert!(
            recorded_sidecar.is_some(),
            "metadata sidecar post-open hook did not fire"
        );
        assert_eq!(
            recorded_sidecar.as_deref(),
            Some(trusted_sidecar.as_slice())
        );
        match result {
            Ok((entries, _)) => {
                let metadata = entries
                    .entries
                    .iter()
                    .find(|entry| entry.name == "sub")
                    .and_then(|entry| entry.children.iter().find(|child| child.name == "a"))
                    .and_then(|entry| entry.metadata.as_ref())
                    .unwrap();
                assert_eq!(metadata.tags, ["trusted"]);
            }
            Err(Error::Conflict(_)) => {}
            Err(error) => panic!("unexpected error: {error:?}"),
        }
    }

    #[test]
    fn collect_tree_entries_refuses_a_pgn_replaced_after_enumeration() {
        let (_directory, authority, workspace, root) = workspace_fixture();
        let pgn = root.join("a.pgn");
        fs::write(&pgn, b"*").unwrap();
        let pgn_for_hook = pgn.clone();
        set_capability_directory_post_entries_hook(Some(Box::new(move || {
            let replacement = pgn_for_hook.with_extension("replacement");
            fs::write(&replacement, b"replacement").unwrap();
            fs::rename(&replacement, &pgn_for_hook).unwrap();
        })));
        let result = collect_tree_entries(&authority, &workspace, &CancellationToken::new());
        set_capability_directory_post_entries_hook(None);
        assert!(matches!(result, Err(Error::Conflict(_))), "{result:?}");
        assert!(!authority
            .raw_for_test()
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .persistent_snapshot_for_test()
            .iter()
            .any(|(name, _, _)| name == "a"));
    }

    #[test]
    fn collect_tree_entries_refuses_an_entry_replaced_before_registration() {
        let (_directory, authority, workspace, root) = workspace_fixture();
        let pgn = root.join("a.pgn");
        fs::write(&pgn, b"*").unwrap();
        let before = authority
            .raw_for_test()
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .persistent_snapshot_for_test();
        let replacement = root.join("a.replacement");
        let pgn_for_hook = pgn.clone();
        set_workspace_listing_pre_confirm_hook(Some(Box::new(move |_| {
            fs::rename(&pgn_for_hook, &replacement).unwrap();
            fs::write(&pgn_for_hook, b"replacement").unwrap();
        })));
        let result = collect_tree_entries(&authority, &workspace, &CancellationToken::new());
        set_workspace_listing_pre_confirm_hook(None);
        assert!(matches!(result, Err(Error::Conflict(_))));
        assert_eq!(
            authority
                .raw_for_test()
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .persistent_snapshot_for_test(),
            before
        );

        let (_directory, authority, workspace, root) = workspace_fixture();
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("inner.pgn"), b"*").unwrap();
        let before = authority
            .raw_for_test()
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .persistent_snapshot_for_test();
        let sub_for_hook = sub.clone();
        set_workspace_listing_pre_confirm_hook(Some(Box::new(move |entry| {
            if entry.name == "sub" {
                fs::rename(&sub_for_hook, root.join("sub-old")).unwrap();
                fs::create_dir(&sub_for_hook).unwrap();
            }
        })));
        let result = collect_tree_entries(&authority, &workspace, &CancellationToken::new());
        set_workspace_listing_pre_confirm_hook(None);
        assert!(matches!(result, Err(Error::Conflict(_))));
        let after = authority
            .raw_for_test()
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .persistent_snapshot_for_test();
        assert_eq!(after, before);
        assert!(!after
            .iter()
            .any(|(name, _, is_dir)| name == "inner" && !*is_dir));
    }

    #[test]
    fn collect_tree_entries_listing_child_omits_vanished_names_and_retires_ids() {
        for nested in [false, true] {
            let (_directory, authority, workspace, root) = workspace_fixture();
            let parent = if nested {
                root.join("sub")
            } else {
                root.clone()
            };
            if nested {
                fs::create_dir(&parent).unwrap();
            }
            let pgn = parent.join("a.pgn");
            fs::write(&pgn, b"*").unwrap();
            fs::write(parent.join("sibling.pgn"), b"*").unwrap();
            collect_tree_entries(&authority, &workspace, &CancellationToken::new()).unwrap();
            let pgn_for_hook = pgn.clone();
            crate::infra::fs::set_read_directory_pre_stat_hook(Some(Box::new(move |name| {
                if name == OsStr::new("a.pgn") {
                    fs::remove_file(&pgn_for_hook).unwrap();
                }
            })));
            let result = collect_tree_entries(&authority, &workspace, &CancellationToken::new());
            crate::infra::fs::set_read_directory_pre_stat_hook(None);
            let (listing, _) = result.unwrap();
            assert!(listing.unread.is_empty());
            let children = if nested {
                &listing.entries[0].children
            } else {
                &listing.entries
            };
            assert_eq!(children.len(), 1);
            assert_eq!(children[0].name, "sibling");
            let after = authority
                .raw_for_test()
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .persistent_snapshot_for_test();
            assert!(!after.iter().any(|(name, _, _)| name == "a"));
            assert!(after.iter().any(|(name, _, _)| name == "sibling"));
            assert_eq!(after.iter().any(|(name, _, _)| name == "sub"), nested);
        }
    }
    #[test]
    fn collect_tree_entries_cancels_after_an_empty_snapshot() {
        let (_directory, authority, workspace, root) = workspace_fixture();
        fs::create_dir(root.join(TRASH_DIRECTORY)).unwrap();
        let token = CancellationToken::new();
        let cancel = token.clone();
        set_capability_directory_post_entries_hook(Some(Box::new(move || cancel.cancel())));
        let result = collect_tree_entries(&authority, &workspace, &token);
        set_capability_directory_post_entries_hook(None);
        assert!(matches!(result, Err(Error::Cancellation)));
    }

    #[test]
    fn collect_tree_entries_cancels_between_directories() {
        let (_directory, authority, workspace, root) = workspace_fixture();
        fs::create_dir(root.join("sub")).unwrap();
        let before = authority
            .raw_for_test()
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .persistent_snapshot_for_test();
        let token = CancellationToken::new();
        let cancel = token.clone();
        set_capability_directory_post_entries_hook(Some(Box::new(move || cancel.cancel())));
        let result = collect_tree_entries(&authority, &workspace, &token);
        set_capability_directory_post_entries_hook(None);
        assert!(matches!(result, Err(Error::Cancellation)));
        assert_eq!(
            authority
                .raw_for_test()
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .persistent_snapshot_for_test(),
            before
        );
    }

    #[test]
    fn collect_tree_entries_lists_a_pre_epoch_entry_with_its_negative_timestamp() {
        // F2. `listed_mtime` used to reject a negative `modified_seconds`, which failed the whole
        // workspace listing over one old file. Both platforms legitimately produce one: unix
        // `st_mtime` is signed, and the Windows `LastWriteTime` FILETIME converts below the epoch
        // through `filetime_to_unix_seconds`. The renderer reads `lastModified` as a plain number
        // of Unix seconds, so a negative value is renderable and must be listed, not refused.
        let old = std::time::SystemTime::UNIX_EPOCH - Duration::from_secs(1);

        let (_directory, authority, workspace, root) = workspace_fixture();
        let pgn = root.join("old.pgn");
        fs::write(&pgn, b"*").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&pgn)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let (entries, _) = collect_tree_entries(&authority, &workspace, &CancellationToken::new())
            .expect("a pre-1970 PGN must be listed, not refused");
        let listed = entries
            .entries
            .iter()
            .find(|entry| entry.name == "old")
            .expect("the pre-1970 PGN must appear in the tree");
        assert_eq!(listed.kind, WorkspaceEntryKind::File);
        assert_eq!(listed.last_modified, -1);

        let (_directory, authority, workspace, root) = workspace_fixture();
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("a.pgn"), b"*").unwrap();
        fs::File::open(&sub).unwrap().set_modified(old).unwrap();
        let (entries, _) = collect_tree_entries(&authority, &workspace, &CancellationToken::new())
            .expect("a pre-1970 directory must be listed, not refused");
        let listed = entries
            .entries
            .iter()
            .find(|entry| entry.name == "sub")
            .expect("the pre-1970 directory must appear in the tree");
        assert_eq!(listed.kind, WorkspaceEntryKind::Directory);
        assert_eq!(listed.last_modified, -1);
        assert_eq!(listed.children.len(), 1);
        assert_eq!(listed.children[0].name, "a");
        let after = authority
            .raw_for_test()
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .persistent_snapshot_for_test();
        assert!(after
            .iter()
            .any(|(name, _, _)| name == "sub" || name == "a"));

        // A non-PGN entry stays skipped regardless of its timestamp.
        let (_directory, authority, workspace, root) = workspace_fixture();
        let notes = root.join("notes.txt");
        fs::write(&notes, b"notes").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&notes)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let (entries, _) = collect_tree_entries(&authority, &workspace, &CancellationToken::new())
            .expect("a non-PGN entry is skipped, not refused");
        assert!(entries.entries.is_empty(), "{entries:?}");
    }

    #[test]
    fn directory_listing_bound_workspace_listing_child_depth_still_wins() {
        let (_directory, authority, workspace, root) = workspace_fixture();
        let mut current = root;
        for index in 0..MAX_WORKSPACE_LISTING_DEPTH {
            current = current.join(format!("d{index}"));
            fs::create_dir(&current).unwrap();
        }
        let result = collect_tree_entries(&authority, &workspace, &CancellationToken::new());
        let (entries, _) = result.unwrap();
        let mut cursor = &entries.entries[0];
        for index in 1..MAX_WORKSPACE_LISTING_DEPTH {
            cursor = &cursor.children[0];
            assert_eq!(cursor.name, format!("d{index}"));
        }
        assert_eq!(cursor.name, format!("d{}", MAX_WORKSPACE_LISTING_DEPTH - 1));
        let (_directory, authority, workspace, root) = workspace_fixture();
        let mut current = root;
        for index in 0..=MAX_WORKSPACE_LISTING_DEPTH {
            current = current.join(format!("d{index}"));
            fs::create_dir(&current).unwrap();
        }
        let before = authority
            .raw_for_test()
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .persistent_snapshot_for_test();
        assert!(matches!(
            collect_tree_entries(&authority, &workspace, &CancellationToken::new()),
            Err(ref error) if matches!(error.unlabelled(), Error::ResourceLimit(_))
        ));
        assert_eq!(
            authority
                .raw_for_test()
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .persistent_snapshot_for_test(),
            before
        );
    }

    #[test]
    fn collect_tree_entries_returns_refusing_handles_for_entries_replaced_after_confirmation() {
        use std::os::unix::fs::symlink;
        let (directory, authority, workspace, root) = workspace_fixture();
        let a = root.join("a.pgn");
        let b = root.join("b.pgn");
        let c = root.join("c.pgn");
        let deep = root.join("deep");
        let sub = root.join("sub");
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        fs::write(&c, b"c").unwrap();
        fs::create_dir(&deep).unwrap();
        fs::write(deep.join("d.pgn"), b"d").unwrap();
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("inner.pgn"), b"inner").unwrap();
        let outside = directory.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter_for_hook = Arc::clone(&counter);
        set_workspace_listing_pre_register_hook(Some(Box::new(move || {
            match counter_for_hook.fetch_add(1, std::sync::atomic::Ordering::SeqCst) {
                0 => {
                    fs::rename(&a, root.join("a-old.pgn")).unwrap();
                    fs::write(&a, b"replacement").unwrap();
                }
                1 => {
                    fs::rename(&b, root.join("b-old.pgn")).unwrap();
                    fs::create_dir(&b).unwrap();
                }
                2 => {
                    fs::remove_file(&c).unwrap();
                }
                3 => {
                    fs::rename(&deep, root.join("deep-old")).unwrap();
                    fs::hard_link(root.join("deep-old/d.pgn"), outside.join("d.pgn")).unwrap();
                    symlink(&outside, &deep).unwrap();
                }
                5 => {
                    fs::rename(&sub, root.join("sub-old")).unwrap();
                    fs::create_dir(&sub).unwrap();
                }
                _ => {}
            }
        })));
        let result = collect_tree_entries(&authority, &workspace, &CancellationToken::new());
        set_workspace_listing_pre_register_hook(None);
        let (entries, _) = result.unwrap();
        assert_eq!(entries.entries.len(), 5);
        assert_eq!(
            entries
                .entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["a", "b", "c", "deep", "sub"]
        );
        for name in ["a", "b", "c"] {
            let entry = entries
                .entries
                .iter()
                .find(|entry| entry.name == name)
                .unwrap();
            assert_eq!(entry.kind, WorkspaceEntryKind::File);
            assert!(entry.children.is_empty());
        }
        let deep_entry = entries
            .entries
            .iter()
            .find(|entry| entry.name == "deep")
            .unwrap();
        assert_eq!(deep_entry.kind, WorkspaceEntryKind::Directory);
        assert_eq!(
            deep_entry
                .children
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["d"]
        );
        let sub_entry = entries
            .entries
            .iter()
            .find(|entry| entry.name == "sub")
            .unwrap();
        assert_eq!(sub_entry.kind, WorkspaceEntryKind::Directory);
        assert_eq!(
            sub_entry
                .children
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["inner"]
        );
        let mut authority = authority.raw_for_test().lock().unwrap();
        fn assert_refusing(authority: &mut PathAuthority, entries: &[WorkspaceEntry]) {
            for entry in entries {
                assert!(
                    authority
                        .resolve(entry.handle.path_ref(), PathOperation::ReadPgn, &[])
                        .is_err(),
                    "{} should refuse after replacement",
                    entry.name
                );
                assert_refusing(authority, &entry.children);
            }
        }
        assert_refusing(authority.as_mut().unwrap(), &entries.entries);
    }

    #[test]
    fn directory_listing_bound_workspace_cancellation_does_not_publish_a_prefix() {
        let (_directory, authority, workspace, root) = workspace_fixture();
        fs::write(root.join("a.pgn"), b"*").unwrap();
        fs::write(root.join("b.pgn"), b"*").unwrap();
        let token = CancellationToken::new();
        let cancel = token.clone();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls_for_hook = Arc::clone(&calls);
        set_workspace_listing_pre_register_hook(Some(Box::new(move || {
            if calls_for_hook.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                cancel.cancel();
            }
        })));
        let result = collect_tree_entries(&authority, &workspace, &token);
        set_workspace_listing_pre_register_hook(None);
        assert!(matches!(result, Err(Error::Cancellation)));
        let snapshot = authority
            .raw_for_test()
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .persistent_snapshot_for_test();
        assert!(!snapshot
            .iter()
            .any(|(name, _, is_dir)| name == "a" && !*is_dir));
        assert!(!snapshot
            .iter()
            .any(|(name, _, is_dir)| name == "b" && !*is_dir));

        let (_directory, authority, workspace, root) = workspace_fixture();
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("inner.pgn"), b"*").unwrap();
        fs::write(sub.join("other.pgn"), b"*").unwrap();
        let token = CancellationToken::new();
        let cancel = token.clone();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls_for_hook = Arc::clone(&calls);
        set_workspace_listing_pre_register_hook(Some(Box::new(move || {
            if calls_for_hook.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                cancel.cancel();
            }
        })));
        let result = collect_tree_entries(&authority, &workspace, &token);
        set_workspace_listing_pre_register_hook(None);
        assert!(matches!(result, Err(Error::Cancellation)));
        let snapshot = authority
            .raw_for_test()
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .persistent_snapshot_for_test();
        assert!(!snapshot
            .iter()
            .any(|(name, _, is_dir)| name == "inner" && !*is_dir));
        assert!(!snapshot
            .iter()
            .any(|(name, _, is_dir)| name == "other" && !*is_dir));
    }

    #[test]
    fn directory_listing_bound_workspace_snapshot_is_one_commit() -> Result<(), Error> {
        use crate::infra::fs::{
            set_test_atomic_file_injector, AtomicFileFaultPoint, AtomicWriterInjector,
        };
        struct SnapshotFault {
            uncertain: bool,
            writes: std::sync::atomic::AtomicUsize,
        }
        impl AtomicWriterInjector for SnapshotFault {
            fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
                if point == AtomicFileFaultPoint::Write {
                    self.writes.fetch_add(1, Ordering::SeqCst);
                }
                if point
                    == if self.uncertain {
                        AtomicFileFaultPoint::ParentSync
                    } else {
                        AtomicFileFaultPoint::Write
                    }
                {
                    return Err(std::io::Error::other("snapshot persistence fault"));
                }
                Ok(())
            }
        }
        for uncertain in [false, true] {
            let (_directory, registry, workspace, root) = workspace_fixture();
            for name in ["a.pgn", "b.pgn", "c.pgn"] {
                fs::write(root.join(name), b"*")?;
            }
            let injector = Arc::new(SnapshotFault {
                uncertain,
                writes: std::sync::atomic::AtomicUsize::new(0),
            });
            set_test_atomic_file_injector(Some(injector.clone()));
            let result = collect_tree_entries(&registry, &workspace, &CancellationToken::new());
            set_test_atomic_file_injector(None);
            let snapshot = registry
                .raw_for_test()
                .lock()
                .unwrap()
                .as_ref()
                .ok_or_else(|| Error::Conflict("test authority missing".into()))?
                .persistent_snapshot_for_test();
            if uncertain {
                assert!(
                    matches!(result, Err(Error::CommittedDurabilityUncertain(_))),
                    "{result:?}"
                );
                for name in ["a", "b", "c"] {
                    assert!(snapshot.iter().any(|(display, _, _)| display == name));
                }
                assert_eq!(injector.writes.load(Ordering::SeqCst), 1);
            } else {
                assert!(matches!(result, Err(Error::Io(_))), "{result:?}");
                for name in ["a", "b", "c"] {
                    assert!(!snapshot.iter().any(|(display, _, _)| display == name));
                }
            }
        }
        Ok(())
    }
}
