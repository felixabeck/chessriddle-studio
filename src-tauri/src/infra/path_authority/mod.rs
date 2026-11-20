//! Capability-based authority for native paths.
//!
//! No physical path crosses the renderer boundary: every path is a [`PathRef`], an opaque
//! capability identifier, and every operation is checked at resolution time. Persistent entries retain
//! filesystem identity; replacement or disappearance makes them unavailable instead of granting
//! authority to the object that happened to appear at the old location. The exception is an
//! app-owned default root (`db` / `engines` / `puzzles`) recovered with a matching live
//! `VerifiedIdentity`: that path re-registers the new inode rather than staying wedged.

use crate::infra::fs::{
    assert_entry_identity, open_directory_at, open_regular_at, probe_regular_file_at,
    read_directory_entries_at, ParentAccess, RegularFileAccess, MAX_DIRECTORY_LISTING_ENTRIES,
};
use crate::infra::inode_ownership::{FileMetadata, OwnedFile};
use crate::{
    error::{Error, ErrorCategory},
    infra::fs::{
        atomic_replace, read_bounded_bytes, AtomicFileOutcome, DirectoryEntry, DirectoryEntryKind,
        VerifiedDir,
    },
};
#[cfg(unix)]
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    ffi::{OsStr, OsString},
    fs,
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, SystemTime},
};
use tauri::Manager as _;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

mod catalog_install;
mod shared;
pub use shared::{AuthorityUnavailable, SharedPathAuthority};

/// Re-check only the chosen root after a failed listing; retain the original failure text.
/// Callers run this on a blocking worker, after releasing their listing lock.
pub(crate) fn probe_listing_root_failure(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    root: &PathRef,
    operation: PathOperation,
    original: Error,
    cancellation: &CancellationToken,
) -> Error {
    probe_root_failure(authority, root, operation, original, cancellation, false)
}

pub(crate) fn probe_engine_root_failure(
    authority: &SharedPathAuthority,
    root: &PathRef,
    original: Error,
    cancellation: &CancellationToken,
) -> Error {
    probe_root_failure(
        authority,
        root,
        PathOperation::DownloadArchive,
        original,
        cancellation,
        true,
    )
}

fn probe_root_failure(
    authority: &SharedPathAuthority,
    root: &PathRef,
    operation: PathOperation,
    original: Error,
    cancellation: &CancellationToken,
    engine: bool,
) -> Error {
    #[cfg(test)]
    if let Some(hook) = LISTING_ROOT_FAILURE_HOOKS.take(&root.id) {
        hook(&original);
    }
    if cancellation.is_cancelled() {
        return Error::Cancellation;
    }
    if matches!(original.unlabelled(), Error::Cancellation) || original.root_failure().is_some() {
        return original;
    }
    let probe = (|| {
        let directory = match authority.with_mut_cancellable(cancellation, |authority| {
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            if engine {
                authority.engine_probe_directory(root, operation)
            } else {
                authority.capability_directory(root, operation).map(Some)
            }
        })? {
            Ok(directory) => match directory? {
                Some(directory) => directory,
                None => return Ok(()),
            },
            Err(_) => return Ok(()),
        };
        directory.entries(cancellation, &mut |_| false)?;
        Ok(())
    })();
    if cancellation.is_cancelled() {
        return Error::Cancellation;
    }
    match probe {
        Err(Error::Cancellation) => Error::Cancellation,
        Err(error) => match error.root_failure_reason() {
            Some(crate::error::RootFailure::TooLarge) if engine => original,
            Some(reason) => original.with_root_failure(reason),
            None => original,
        },
        Ok(()) => original,
    }
}

/// Marks only filesystem substeps that can depend on the selected engine root.
/// Transactions, inventory and capability admission never pass through this marker.
#[derive(Default)]
pub(crate) struct EngineRootProbe {
    failed: bool,
}

impl EngineRootProbe {
    pub(crate) fn filesystem<T>(&mut self, result: Result<T, Error>) -> Result<T, Error> {
        if result.as_ref().is_err_and(|error| {
            !matches!(error.unlabelled(), Error::CommittedDurabilityUncertain(_))
        }) {
            self.failed = true;
        }
        result
    }
}

/// Release the authority guard before rechecking a failed filesystem substep.
/// A successful committed outcome never gets replaced by a late cancellation.
pub(crate) fn with_engine_root_probe<T>(
    authority: &SharedPathAuthority,
    root: &PathRef,
    operation: PathOperation,
    cancellation: &CancellationToken,
    use_root: impl FnOnce(&mut PathAuthority, &mut EngineRootProbe) -> Result<T, Error>,
) -> Result<T, Error> {
    let mut probe = EngineRootProbe::default();
    let result = authority.with_mut(|authority| use_root(authority, &mut probe))?;
    result.map_err(|error| {
        if probe.failed {
            probe_root_failure(authority, root, operation, error, cancellation, true)
        } else {
            error
        }
    })
}

#[cfg(test)]
type ListingRootFailureHook = Box<dyn FnOnce(&Error) + Send>;

// Key by capability so parallel tests and Files' blocking worker cannot consume another hook.
#[cfg(test)]
pub(crate) static LISTING_ROOT_FAILURE_HOOKS: crate::infra::test_hooks::KeyedTestValues<
    String,
    ListingRootFailureHook,
> = crate::infra::test_hooks::KeyedTestValues::new();

#[cfg(test)]
pub(crate) struct ListingRootFailureHookGuard(pub(crate) String);

#[cfg(test)]
impl Drop for ListingRootFailureHookGuard {
    fn drop(&mut self) {
        LISTING_ROOT_FAILURE_HOOKS.clear(&self.0);
    }
}

#[cfg(all(test, unix))]
pub(crate) struct TestRootPermissionGuard {
    path: PathBuf,
    original: fs::Permissions,
}

#[cfg(all(test, unix))]
impl TestRootPermissionGuard {
    pub(crate) fn restrict(path: &Path, mode: u32) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let original = fs::metadata(path).unwrap().permissions();
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
        Self {
            path: path.to_path_buf(),
            original,
        }
    }
}

#[cfg(all(test, unix))]
impl Drop for TestRootPermissionGuard {
    fn drop(&mut self) {
        fs::set_permissions(&self.path, self.original.clone()).unwrap();
    }
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
compile_error!("ChessRiddle Studio supports Linux, macOS and Windows");

mod resolved;
pub use resolved::ResolvedPath;
pub(crate) use resolved::{PgnSnapshot, PgnSnapshotIdentity};
mod verified;
pub(crate) use crate::infra::fs::RegularFileMetadata;
pub(crate) use verified::VerifiedFile;

const SCHEMA_VERSION: u32 = 1;
/// Maximum number of distinct authority identifiers admitted in a normal registry.
/// Retained legacy registries may temporarily exceed it while they are being shrunk.
const MAX_AUTHORITY_IDS: usize = 4_096;
/// Room for a full authority registry plus orphaned images or atomic temps.
const MAX_ENGINE_IMAGE_SWEEP_ENTRIES: usize = MAX_DIRECTORY_LISTING_ENTRIES.saturating_mul(2);
const MAX_TRUSTED_OWNER_FAMILIES: usize = 32;
const MAX_PENDING_ARTIFACTS: usize = 256;
/// The bound on the dialog-grant table for a real application session. It lived as a literal in
/// `open` until the app-data context gained its own constructor; naming it keeps startup from
/// carrying the number at the call site.
const DEFAULT_DIALOG_CAPACITY: usize = 256;
/// Lifetime of a PGN-file dialog grant while it is available for resolution or promotion.
pub(crate) const PGN_FILE_DIALOG_GRANT_TTL: Duration = Duration::from_secs(30 * 60);
/// Maximum permitted-operation resolution attempts before a PGN-file dialog grant is consumed.
/// Promotion consumes the entire grant regardless of its remaining uses.
pub(crate) const PGN_FILE_DIALOG_GRANT_USES: u32 = 128;
/// Lifetime of a dialog grant that a native picker issues and consumes or
/// promotes within one command.
pub(crate) const PICKER_DIALOG_GRANT_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_REGISTRY_BYTES: usize = 16 * 1024 * 1024;
const MAX_LEGACY_REGISTRY_BYTES: u64 = 64 * 1024 * 1024;

/// Only absence and persistent permission failures can be isolated before the snapshot commit.
pub(crate) fn listing_child_outcome(error: Error) -> Result<Option<ErrorCategory>, Error> {
    if error.root_failure().is_some() {
        return Err(error);
    }
    if error.is_missing_entry() {
        return Ok(None);
    }
    if error.category() == ErrorCategory::Permission {
        return Ok(Some(ErrorCategory::Permission));
    }
    Err(error)
}

fn map_db3_children_cancellable<T>(
    root: &CapabilityDirectory,
    cancellation: &CancellationToken,
    mut map: impl FnMut(OsString, String, Result<(u64, u64), Error>) -> Result<Option<T>, Error>,
) -> Result<Vec<T>, Error> {
    let listing = root.listing_entries(cancellation, &mut |name| {
        Path::new(name).extension() == Some(OsStr::new("db3"))
    })?;
    let mut children: Vec<_> = listing
        .entries
        .into_iter()
        .filter(|entry| entry.kind == DirectoryEntryKind::RegularFile)
        .map(|entry| (entry.name, Ok(entry.identity)))
        .chain(
            listing
                .unread
                .into_iter()
                .map(|(name, _, error)| (name, Err(error))),
        )
        .collect();
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    children.sort_by(|(left, _), (right, _)| left.to_string_lossy().cmp(&right.to_string_lossy()));

    let mut mapped = Vec::with_capacity(children.len());
    for (name, identity) in children {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let display_name = name.to_string_lossy().into_owned();
        if let Some(child) = map(name, display_name, identity)? {
            mapped.push(child);
        }
    }
    Ok(mapped)
}

#[cfg(all(test, windows))]
mod windows_tests;

/// A directory reached through a `PathRef` capability. It carries no pathname.
pub(crate) struct CapabilityDirectory {
    directory: fs::File,
}

fn conflict_if_replaced(error: Error, message: &str) -> Error {
    #[cfg(unix)]
    {
        if let Error::Io(io_error) = &error {
            if error.is_missing_entry()
                || matches!(
                    io_error.raw_os_error(),
                    Some(code)
                        if code == rustix::io::Errno::LOOP.raw_os_error()
                            || code == rustix::io::Errno::NOTDIR.raw_os_error()
                )
            {
                return Error::Conflict(message.into());
            }
        }
        error
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::ERROR_DIRECTORY;

        if matches!(&error, Error::InvalidInput(message) if message == "reparse points cannot be authorized")
        {
            return Error::Conflict(message.into());
        }
        if let Error::Io(io_error) = &error {
            if error.is_missing_entry()
                || matches!(
                    io_error.raw_os_error(),
                    Some(code)
                        if code == ERROR_DIRECTORY as i32
                )
            {
                return Error::Conflict(message.into());
            }
        }
        error
    }
}

impl CapabilityDirectory {
    pub(crate) fn identity(&self) -> Result<(u64, u64), Error> {
        opened_file_identity(&self.directory)
    }

    /// One descriptor-relative read of this directory, on both platforms.
    ///
    /// `probe_listing_root_failure` uses this fail-fast reader to re-check the root.
    /// Listing walks use `listing_entries` to preserve named child stat failures.
    pub(crate) fn entries(
        &self,
        cancellation: &CancellationToken,
        keep: &mut dyn FnMut(&OsStr) -> bool,
    ) -> Result<Vec<DirectoryEntry>, Error> {
        let entries = read_directory_entries_at(
            &self.directory,
            cancellation,
            Some(crate::infra::fs::MAX_DIRECTORY_LISTING_ENTRIES),
            keep,
        )?;
        #[cfg(all(test, unix))]
        CAPABILITY_DIRECTORY_POST_ENTRIES_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        Ok(entries)
    }

    /// Listing-only reader. Other authority consumers retain the fail-fast `entries` contract.
    pub(crate) fn listing_entries(
        &self,
        cancellation: &CancellationToken,
        keep: &mut dyn FnMut(&OsStr) -> bool,
    ) -> Result<crate::infra::fs::ListingDirectoryEntries, Error> {
        let entries = crate::infra::fs::read_listing_directory_entries_at(
            &self.directory,
            cancellation,
            Some(crate::infra::fs::MAX_DIRECTORY_LISTING_ENTRIES),
            keep,
        )?;
        #[cfg(all(test, unix))]
        CAPABILITY_DIRECTORY_POST_ENTRIES_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        Ok(entries)
    }

    /// Remaps the errors a concurrent swap of the child produces into the one retryable
    /// `Conflict` the workspace listing reports, so a directory replaced between enumeration and
    /// open is a retry rather than a hard failure. Unix sees `LOOP`/`NOTDIR`/`NOENT`; Windows sees
    /// the NT counterparts, plus `open_windows_child`'s reparse refusal, because an entry that was
    /// a directory at enumeration time and is a junction when it is opened is the same swap.
    fn child_open_swap(error: Error) -> Error {
        conflict_if_replaced(error, "workspace directory changed concurrently")
    }

    pub(crate) fn open_child_directory(
        &self,
        entry: &DirectoryEntry,
    ) -> Result<CapabilityDirectory, Error> {
        if entry.kind != DirectoryEntryKind::Directory {
            return Err(Error::InvalidInput(
                "directory entry is not a directory".into(),
            ));
        }
        crate::infra::fs::single_leaf(&entry.name)?;
        #[cfg(all(test, unix))]
        CAPABILITY_CHILD_PRE_OPEN_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        let opened = open_directory_at(&self.directory, &entry.name, false)
            .map_err(Self::child_open_swap)?;
        Ok(CapabilityDirectory {
            directory: VerifiedDir::new(opened, entry.identity)?.into_file(),
        })
    }

    pub(crate) fn confirm_entry(&self, entry: &DirectoryEntry) -> Result<(), Error> {
        crate::infra::fs::single_leaf(&entry.name)?;
        assert_entry_identity(
            &self.directory,
            &entry.name,
            entry.identity,
            entry.kind == DirectoryEntryKind::Directory,
        )
    }

    pub(crate) fn open_metadata_sidecar(
        &self,
        pgn: &DirectoryEntry,
    ) -> Result<Option<OwnedFile>, Error> {
        crate::infra::fs::single_leaf(&pgn.name)?;
        let sidecar = workspace_sidecar_leaf(&pgn.name)?;
        #[cfg(all(test, unix))]
        WORKSPACE_METADATA_PRE_OPEN_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        let opened = match open_regular_at(&self.directory, &sidecar, RegularFileAccess::ReadOnly) {
            Ok(file) => {
                #[cfg(all(test, unix))]
                WORKSPACE_METADATA_POST_OPEN_HOOK.with(|slot| {
                    if let Some(hook) = slot.borrow_mut().take() {
                        hook(&file);
                    }
                });
                Some(file)
            }
            Err(error) if error.is_missing_entry() => None,
            Err(error) => return Err(error),
        };
        self.confirm_entry(pgn)?;
        Ok(opened)
    }
}

fn engine_file_operations() -> Vec<PathOperation> {
    vec![
        PathOperation::EngineExecute,
        PathOperation::EngineConfigure,
        PathOperation::EngineInstall,
        PathOperation::EngineBinaryInspect,
    ]
}

/// Opaque renderer-safe identifier. It deliberately has no path parsing API.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct PathRef {
    pub id: String,
}
impl PathRef {
    fn fresh() -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
        }
    }
}

/// Renderer-safe handle for one authority-managed file workspace. It cannot contain a native
/// path, and PGN commands accept this type rather than a generic capability id.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct FileWorkspaceHandle {
    pub id: PathRef,
    pub kind: FileWorkspaceHandleKind,
}

/// Backend-only sealed workspace entry. The native path is retained only for registry rebinding;
/// all namespace mutations use `parent`/`directory` file descriptors and the single leaf name.
pub(crate) struct WorkspaceMutationTarget {
    pub(crate) parent: fs::File,
    pub(crate) directory: Option<fs::File>,
    pub(crate) leaf: OsString,
    pub(crate) identity: (u64, u64),
    pub(crate) is_dir: bool,
    pub(crate) path: PathBuf,
}
/// The failure classes shared by database probes, search-index loading and sidecar cleanup.
/// Callers map the classes differently because absence, a wrong object kind and a malformed
/// archive have different meanings at each boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProbeErrorClass {
    NotFound,
    Reparse,
    WrongKind,
    Malformed,
    MappedFile,
    Other,
}

fn unix_probe_error_class(code: Option<i32>) -> Option<ProbeErrorClass> {
    #[cfg(unix)]
    {
        matches!(
            code,
            Some(code)
                if code == rustix::io::Errno::LOOP.raw_os_error()
                    || code == rustix::io::Errno::NOTDIR.raw_os_error()
        )
        .then(|| {
            if code == Some(rustix::io::Errno::LOOP.raw_os_error()) {
                ProbeErrorClass::Reparse
            } else {
                ProbeErrorClass::WrongKind
            }
        })
    }
    #[cfg(not(unix))]
    {
        let _ = code;
        None
    }
}

/// Classifies absence through the shared missing-entry predicate. Other Windows values are
/// stable DOS error codes; their numeric values let Linux execute those classifier rows in tests.
pub(crate) fn classify_probe_error_kind(error: &Error) -> ProbeErrorClass {
    match error {
        Error::Io(error) => {
            if crate::error::is_missing_entry_io(error) {
                ProbeErrorClass::NotFound
            } else if let Some(class) = unix_probe_error_class(error.raw_os_error()) {
                class
            } else if matches!(error.raw_os_error(), Some(1920 | 4393)) {
                ProbeErrorClass::Reparse
            } else if error.raw_os_error() == Some(267) {
                ProbeErrorClass::WrongKind
            } else if error.raw_os_error() == Some(1224) {
                ProbeErrorClass::MappedFile
            } else if error.kind() == std::io::ErrorKind::InvalidData {
                ProbeErrorClass::Malformed
            } else {
                ProbeErrorClass::Other
            }
        }
        Error::InvalidInput(message)
            if matches!(
                message.as_str(),
                "workspace sidecar must be a regular file"
                    | "workspace entry has an unexpected file type"
            ) =>
        {
            ProbeErrorClass::WrongKind
        }
        Error::InvalidInput(message) if message == "reparse points cannot be authorized" => {
            ProbeErrorClass::Reparse
        }
        Error::InvalidInput(message) if message == "target must be a regular file" => {
            ProbeErrorClass::WrongKind
        }
        _ => ProbeErrorClass::Other,
    }
}

/// Resolves Windows' ambiguous directory-open error without turning permission failures into
/// "missing". A directory probe succeeds only for a directory at the same parent/name; if it
/// fails, the original error remains `Other` and the caller propagates it.
pub(crate) fn classify_probe_error(
    error: &Error,
    parent: &fs::File,
    leaf: &OsStr,
) -> ProbeErrorClass {
    if matches!(
        error,
        Error::Io(error) if error.raw_os_error() == Some(5)
    ) && crate::infra::fs::entry_identity_at(parent, leaf, true).is_ok()
    {
        return ProbeErrorClass::WrongKind;
    }
    classify_probe_error_kind(error)
}

/// Retained no-follow parent descriptor for a database file. Callers must not
/// reopen `leaf` by pathname for create, unlink, or mmap; use this parent with
/// `openat` / `unlinkat` / `atomic_replace_at`.
pub(crate) struct DatabaseFileTarget {
    parent: fs::File,
    leaf: OsString,
    identity: (u64, u64),
    path: PathBuf,
    validation: DatabaseTargetValidation,
}

pub(crate) enum DatabaseDeleteRecovery {
    Absent(DatabaseFileTarget),
    Present,
}

enum DatabaseTargetValidation {
    Pathname,
    RetainedParent,
}

impl DatabaseFileTarget {
    fn assemble(parent: fs::File, leaf: OsString, identity: (u64, u64), path: PathBuf) -> Self {
        Self {
            parent,
            leaf,
            identity,
            path,
            validation: DatabaseTargetValidation::Pathname,
        }
    }

    pub(crate) fn parent(&self) -> &fs::File {
        &self.parent
    }

    pub(crate) fn leaf(&self) -> &OsStr {
        &self.leaf
    }

    pub(crate) fn identity(&self) -> (u64, u64) {
        self.identity
    }

    /// Returns the captured pathname for diagnostics and cache location. Ordinary producers
    /// validate its canonical binding, while resolved puzzle carriers retain their parent. In-memory keys and
    /// logging consume this value; SQLite opens go through `db::bound_sqlite`, and create, unlink
    /// and mmap use the retained parent descriptor and leaf instead of reopening the pathname.
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Probes the regular file and its identity. Ordinary carriers revalidate the pathname and
    /// parent binding, while puzzle carriers probe the retained parent and leaf after a rename.
    /// Unix must not open the leaf: closing any descriptor for an inode can release this process's
    /// POSIX locks held by a pooled SQLite connection (`f-20260929-11`). Validation stays beside
    /// the carrier so repository callers cannot substitute a path.
    pub(crate) fn probe_current(&self) -> Result<RegularFileMetadata, Error> {
        const CONFLICT: &str = "database changed after capability resolution";

        fn map_probe_error(class: ProbeErrorClass, error: Error) -> Error {
            if matches!(error, Error::Conflict(_)) {
                return Error::Conflict(CONFLICT.into());
            }
            match class {
                ProbeErrorClass::NotFound
                | ProbeErrorClass::Reparse
                | ProbeErrorClass::WrongKind => Error::Conflict(CONFLICT.into()),
                ProbeErrorClass::Malformed
                | ProbeErrorClass::MappedFile
                | ProbeErrorClass::Other => error,
            }
        }

        let pathname_parent;
        let (parent, leaf) = match self.validation {
            DatabaseTargetValidation::Pathname => {
                let (parent_now, leaf) = crate::infra::fs::open_verified_parent(
                    &self.path,
                    self.identity,
                    false,
                    ParentAccess::Readable,
                )
                .map_err(|error| map_probe_error(classify_probe_error_kind(&error), error))?;
                if opened_file_identity(&parent_now)? != opened_file_identity(&self.parent)? {
                    return Err(Error::Conflict(CONFLICT.into()));
                }
                pathname_parent = (parent_now, leaf);
                (&pathname_parent.0, pathname_parent.1.as_os_str())
            }
            DatabaseTargetValidation::RetainedParent => (&self.parent, self.leaf.as_os_str()),
        };
        let metadata = probe_regular_file_at(parent, leaf)
            .map_err(|error| map_probe_error(classify_probe_error(&error, parent, leaf), error))?;
        if metadata.identity != self.identity {
            return Err(Error::Conflict(CONFLICT.into()));
        }
        Ok(metadata)
    }

    #[cfg(test)]
    pub(crate) fn for_test_path(path: &Path) -> Result<Self, Error> {
        Self::for_test_with_parent_access(path, ParentAccess::Readable)
    }

    // Deletion tests need the writable parent retained by production DatabaseMutate:
    // Windows sync_all on a read-only directory handle is durability-uncertain.
    #[cfg(test)]
    pub(crate) fn for_test_deletion(path: &Path) -> Result<Self, Error> {
        Self::for_test_with_parent_access(path, ParentAccess::Writable)
    }

    #[cfg(test)]
    fn for_test_with_parent_access(
        path: &Path,
        parent_access: ParentAccess,
    ) -> Result<Self, Error> {
        path.file_name()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| Error::InvalidInput("database path needs a leaf name".into()))?;
        // Opening an existing inode here would release SQLite's process-wide POSIX locks.
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(_) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(error),
        }?;
        let acquired = acquire_target(path, AcquireShape::File { parent_access })?;
        let (parent, leaf) = acquired
            .parent_and_leaf
            .ok_or_else(|| Error::InvalidInput("database path needs a leaf name".into()))?;
        Ok(Self::assemble(
            parent,
            leaf,
            (acquired.identity.a, acquired.identity.b),
            acquired.path,
        ))
    }
}

/// Database fixtures shared by path-authority and repository witnesses.
#[cfg(test)]
pub(crate) mod database_test_support {
    use super::*;

    #[cfg(unix)]
    pub(crate) fn set_database_child_post_resolve_hook(hook: impl FnOnce() + 'static) {
        DATABASE_CHILD_POST_RESOLVE_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }

    /// Replaces `path`'s parent directory with a fresh one holding a hard link to the same
    /// inode: the leaf identity is unchanged, the parent identity is not. Returns the moved
    /// original parent.
    pub(crate) fn replace_parent_with_same_inode_hard_link(path: &Path) -> PathBuf {
        let parent = path.parent().expect("test file parent");
        let leaf = path.file_name().expect("test file leaf");
        let parent_name = parent
            .file_name()
            .expect("test parent name")
            .to_string_lossy();
        let old_parent = parent.with_file_name(format!("{parent_name}.old"));
        fs::rename(parent, &old_parent).expect("rename authorized parent");
        fs::create_dir(parent).expect("create replacement parent");
        fs::hard_link(old_parent.join(leaf), path).expect("hard link authorized inode");
        old_parent
    }
}

mod verified_identity {
    use crate::{
        error::Error,
        infra::{fs::AtomicFileOutcome, inode_ownership::OwnedFile},
    };
    use std::ffi::OsStr;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) struct VerifiedIdentity((u64, u64));

    impl VerifiedIdentity {
        pub(crate) fn from_pair(pair: (u64, u64)) -> Self {
            Self(pair)
        }

        pub(super) fn pair(self) -> (u64, u64) {
            self.0
        }

        pub(super) fn agrees_with(self, validated: &super::Identity) -> bool {
            self.pair() == (validated.a, validated.b)
        }
    }

    impl super::AuthorizedDir {
        pub(crate) fn identity(&self) -> VerifiedIdentity {
            VerifiedIdentity(self.identity)
        }

        pub(crate) fn atomic_replace_leaf_identified<F>(
            &self,
            leaf: &OsStr,
            write_fn: F,
        ) -> Result<(AtomicFileOutcome, VerifiedIdentity), Error>
        where
            F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
        {
            let installed = crate::infra::fs::atomic_replace_at_identified(
                self.directory.as_file(),
                leaf,
                write_fn,
            )?;
            Ok((installed.outcome, VerifiedIdentity(installed.identity)))
        }

        pub(crate) fn open_leaf_identified(&self, leaf: &OsStr) -> Result<VerifiedIdentity, Error> {
            crate::infra::fs::single_leaf(leaf).map_err(|_| {
                Error::InvalidInput("managed image leaf must be one component".into())
            })?;
            let file = self
                .open_regular_relative(std::path::Path::new(leaf))
                .map_err(|error| match error {
                    Error::InvalidInput(_) => {
                        Error::Conflict("managed image leaf changed before cleanup".into())
                    }
                    Error::Io(error)
                        if error.raw_os_error() == Some(rustix::io::Errno::LOOP.raw_os_error()) =>
                    {
                        Error::Conflict("managed image leaf changed before cleanup".into())
                    }
                    error => error,
                })?;
            super::opened_file_identity(&file).map(VerifiedIdentity)
        }
    }

    impl super::ResolvedPath {
        pub(crate) fn identity(&self) -> Result<VerifiedIdentity, Error> {
            if let Some(file) = self.file() {
                return super::opened_file_identity(file).map(VerifiedIdentity);
            }
            #[cfg(unix)]
            if let Some(identity) = self.observed_file_identity() {
                return Ok(VerifiedIdentity(identity));
            }
            if let Some(directory) = self.directory() {
                return super::opened_file_identity(directory).map(VerifiedIdentity);
            }
            Err(Error::Conflict(
                "resolved capability has no retained descriptor".into(),
            ))
        }
    }

    pub(super) fn database_child_identity(
        resolved: VerifiedIdentity,
        validated: &super::Identity,
    ) -> Result<VerifiedIdentity, Error> {
        let pair = (validated.a, validated.b);
        if !resolved.agrees_with(validated) {
            return Err(Error::Conflict(
                super::VERIFIED_REGISTRATION_CONFLICT.into(),
            ));
        }
        Ok(VerifiedIdentity(pair))
    }

    impl super::ResolvedPath {
        pub(super) fn create_database_file(&self) -> Result<(OwnedFile, VerifiedIdentity), Error> {
            if self.operation() != super::PathOperation::DatabaseCreate {
                return Err(Error::InvalidInput(
                    "resolved capability is not a database creation target".into(),
                ));
            }
            let parent = self.parent().ok_or_else(|| {
                Error::InvalidInput("database child has no retained parent".into())
            })?;
            let leaf = self
                .leaf()
                .ok_or_else(|| Error::InvalidInput("database child has no retained leaf".into()))?;
            let (file, observed) = crate::infra::fs::create_regular_at(parent, leaf)?;
            Ok((file, VerifiedIdentity(observed)))
        }
    }
}

pub(crate) use verified_identity::VerifiedIdentity;

const VERIFIED_REGISTRATION_CONFLICT: &str = "verified identity does not match registration target";

fn refuse_unobserved(
    resolved_identity: VerifiedIdentity,
    observed: (u64, u64),
) -> Result<VerifiedIdentity, Error> {
    if resolved_identity.pair() != observed {
        return Err(Error::Conflict(VERIFIED_REGISTRATION_CONFLICT.into()));
    }
    Ok(resolved_identity)
}

#[cfg(all(test, unix))]
type WorkspaceMetadataPostOpenHook = Box<dyn FnOnce(&OwnedFile)>;
#[cfg(test)]
type RefreshEntryHook = Box<dyn Fn(&str)>;

#[cfg(all(test, unix))]
std::thread_local! {
    // Remove with the database-create captured-identity regression.
    static DATABASE_CREATE_IDENTITY_FAILURE: std::cell::Cell<Option<(u64, u64)>> =
        const { std::cell::Cell::new(None) };
    static CAPABILITY_DIRECTORY_POST_ENTRIES_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static CAPABILITY_CHILD_PRE_OPEN_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static WORKSPACE_METADATA_POST_OPEN_HOOK: std::cell::RefCell<Option<WorkspaceMetadataPostOpenHook>> =
        const { std::cell::RefCell::new(None) };
    static WORKSPACE_METADATA_PRE_OPEN_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
std::thread_local! {
    static DATABASE_CHILD_POST_RESOLVE_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static ACQUIRE_TARGET_BEFORE_PROOF_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static PGN_EXPORT_POST_CREATE_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static ACQUIRE_TARGET_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static ACQUIRE_TARGET_MISSING_ONCE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static PUZZLE_CHILD_POST_RESOLVE_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static DATABASE_CHILD_POST_CREATE_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static INSTALLED_ENGINE_POST_RESOLVE_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static ENGINE_IMAGE_PRE_REGISTRATION_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static PROMOTE_DIALOG_POST_ACQUIRE_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static PERSISTENT_FILE_POST_TARGET_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static RESOLVE_PRE_REGULAR_OPEN_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static RESOLVE_PRE_DIRECTORY_OPEN_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static RESOLVE_PRE_ROOT_OPEN_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static REFRESH_ENTRY_HOOK: std::cell::RefCell<Option<RefreshEntryHook>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) struct AcquireTargetMissingReset;

#[cfg(test)]
impl Drop for AcquireTargetMissingReset {
    fn drop(&mut self) {
        ACQUIRE_TARGET_MISSING_ONCE.with(|slot| slot.set(false));
    }
}

#[cfg(test)]
pub(crate) fn install_acquire_target_missing_once() -> AcquireTargetMissingReset {
    ACQUIRE_TARGET_MISSING_ONCE.with(|slot| slot.set(true));
    AcquireTargetMissingReset
}

fn reject_disagreeing_expected_identity(
    validated: &Identity,
    expected: Option<VerifiedIdentity>,
) -> Result<(), Error> {
    if expected.is_some_and(|expected| !expected.agrees_with(validated)) {
        return Err(Error::Conflict(VERIFIED_REGISTRATION_CONFLICT.into()));
    }
    Ok(())
}

// Remove this accessor with its last cross-module consumer when existing refusal fixtures
// cover the staged PGN installer's resolution-before-reservation boundary.
#[cfg(test)]
pub(crate) fn set_resolve_pre_root_open_hook(hook: Option<Box<dyn FnOnce()>>) {
    RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(all(test, unix))]
pub(crate) fn set_puzzle_child_post_resolve_hook(hook: Option<Box<dyn FnOnce()>>) {
    PUZZLE_CHILD_POST_RESOLVE_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(all(test, unix))]
pub(crate) fn set_workspace_metadata_post_open_hook(hook: Option<WorkspaceMetadataPostOpenHook>) {
    WORKSPACE_METADATA_POST_OPEN_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(all(test, unix))]
pub(crate) fn set_capability_directory_post_entries_hook(hook: Option<Box<dyn FnOnce()>>) {
    CAPABILITY_DIRECTORY_POST_ENTRIES_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(all(test, unix))]
pub(crate) fn set_capability_child_pre_open_hook(hook: Option<Box<dyn FnOnce()>>) {
    CAPABILITY_CHILD_PRE_OPEN_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(all(test, unix))]
pub(crate) fn set_workspace_metadata_pre_open_hook(hook: Option<Box<dyn FnOnce()>>) {
    WORKSPACE_METADATA_PRE_OPEN_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[derive(Debug)]
pub(crate) struct AuthorizedDir {
    directory: VerifiedDir,
    identity: (u64, u64),
    path: PathBuf,
}

impl AuthorizedDir {
    pub(crate) fn ensure_child(&self, leaf: &OsStr) -> Result<Self, Error> {
        crate::infra::fs::single_leaf(leaf)?;
        let directory = crate::infra::fs::ensure_directory_at(self.directory.as_file(), leaf)?;
        let identity = opened_file_identity(&directory)?;
        Ok(Self {
            directory: VerifiedDir::new(directory, identity)?,
            identity,
            path: self.path.join(leaf),
        })
    }
    pub(crate) fn descriptor(&self) -> &fs::File {
        self.directory.as_file()
    }

    pub(crate) fn database_target(&self, leaf: &OsStr) -> Result<DatabaseFileTarget, Error> {
        crate::infra::fs::single_leaf(leaf)?;
        let metadata = crate::infra::fs::probe_regular_file_at(self.directory.as_file(), leaf)?;
        Ok(DatabaseFileTarget::assemble(
            self.directory.as_file().try_clone()?,
            leaf.to_os_string(),
            metadata.identity,
            self.path.join(leaf),
        ))
    }
    /// Whether startup's pathname still names this retained directory.
    pub(crate) fn resides_at(&self, location: &DefaultRootLocation) -> Result<bool, Error> {
        match identity(&location.path) {
            Ok(identity) => Ok((identity.a, identity.b) == self.identity),
            Err(error) if error.is_missing_entry() => Ok(false),
            // `identity` rejects symbolic links and other reparse points as invalid input.
            Err(Error::InvalidInput(_)) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Returns the native directory retained for registry rebinding and display only. Filesystem
    /// changes must use the retained descriptor and must never reopen this pathname.
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Snapshots this directory's entries through the retained descriptor, keeping the names
    /// `keep` accepts. No pathname is resolved, so a caller outside `infra` needs no fs reach.
    pub(crate) fn entries(
        &self,
        keep: &mut dyn FnMut(&OsStr) -> bool,
    ) -> Result<Vec<crate::infra::fs::DirectoryEntry>, Error> {
        crate::infra::fs::read_directory_entries_at(
            self.directory.as_file(),
            &CancellationToken::new(),
            None,
            keep,
        )
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn try_clone(&self) -> Result<fs::File, Error> {
        self.directory.as_file().try_clone().map_err(Error::from)
    }

    pub(crate) fn remove_leaf_identified(
        &self,
        leaf: &OsStr,
        identity: VerifiedIdentity,
    ) -> Result<(), Error> {
        crate::infra::fs::single_leaf(leaf)?;
        crate::infra::fs::remove_entry_at(self.directory.as_file(), leaf, identity.pair(), false)
    }

    pub(crate) fn remove_leaf_identified_pair(
        &self,
        leaf: &OsStr,
        identity: (u64, u64),
    ) -> Result<(), Error> {
        self.remove_leaf_identified(leaf, VerifiedIdentity::from_pair(identity))
    }

    pub(crate) fn open_regular_relative(&self, relative: &Path) -> Result<OwnedFile, Error> {
        let components = relative_components(relative);
        validate_components(&components)?;
        let (leaf, directories) = components
            .split_last()
            .ok_or_else(|| Error::InvalidInput("invalid relative path component".into()))?;
        let mut parent = self.directory.as_file().try_clone()?;
        for directory in directories {
            parent = crate::infra::fs::open_directory_at(&parent, directory, false)?;
        }
        crate::infra::fs::open_regular_at(&parent, leaf, RegularFileAccess::ReadOnly)
    }

    /// Opens or creates one regular lock leaf relative to this retained directory. The operation
    /// is non-exclusive because every process must obtain the same inode before taking its
    /// advisory lock; `NOFOLLOW` still prevents a planted link from becoming that inode.
    pub(crate) fn open_or_create_regular_relative(
        &self,
        relative: &Path,
    ) -> Result<OwnedFile, Error> {
        let components = relative_components(relative);
        validate_components(&components)?;
        let (leaf, directories) = components
            .split_last()
            .ok_or_else(|| Error::InvalidInput("invalid relative path component".into()))?;
        let mut parent = self.directory.as_file().try_clone()?;
        for directory in directories {
            parent = crate::infra::fs::open_directory_at(&parent, directory, false)?;
        }
        crate::infra::fs::open_or_create_regular_at(&parent, leaf)
    }
}

struct RetainedWorkspaceTarget {
    parent: fs::File,
    leaf: OsString,
    identity: (u64, u64),
    target_is_dir: bool,
    path: PathBuf,
}
impl WorkspaceMutationTarget {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn directory(&self) -> Result<&fs::File, Error> {
        self.directory
            .as_ref()
            .ok_or_else(|| Error::InvalidInput("workspace entry must be a directory".into()))
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FileWorkspaceHandleKind {
    FileWorkspace,
}
impl FileWorkspaceHandle {
    pub(crate) fn path_ref(&self) -> &PathRef {
        &self.id
    }
    pub(crate) fn new(id: PathRef) -> Self {
        Self {
            id,
            kind: FileWorkspaceHandleKind::FileWorkspace,
        }
    }
}

/// Opaque handle for a database root.  A root is the only capability that may
/// create or discover database children; the renderer never supplies a path or
/// a relative component.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct DatabaseRootHandle {
    pub id: PathRef,
    pub kind: DatabaseRootHandleKind,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRootDescriptor {
    pub root: DatabaseRootHandle,
    pub display_name: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseRootHandleKind {
    DatabaseRoot,
}

/// Opaque handle for the active puzzle-database directory. It is deliberately
/// distinct from the game-database root so puzzle commands cannot be routed to
/// a general database workspace by mistake.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct PuzzleRootHandle {
    pub id: PathRef,
    pub kind: PuzzleRootHandleKind,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PuzzleRootHandleKind {
    PuzzleRoot,
}
impl PuzzleRootHandle {
    pub(crate) fn new(id: PathRef) -> Self {
        Self {
            id,
            kind: PuzzleRootHandleKind::PuzzleRoot,
        }
    }
    pub(crate) fn path_ref(&self) -> &PathRef {
        &self.id
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PuzzleRootDescriptor {
    pub root: PuzzleRootHandle,
    pub display_name: String,
}

pub(crate) fn selected_root_display_name(path: &Path, fallback: &str) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| fallback.into())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PuzzleDatabaseDescriptor {
    pub file: PathRef,
    pub filename: String,
}
impl DatabaseRootHandle {
    pub(crate) fn new(id: PathRef) -> Self {
        Self {
            id,
            kind: DatabaseRootHandleKind::DatabaseRoot,
        }
    }
    pub(crate) fn path_ref(&self) -> &PathRef {
        &self.id
    }
}

/// Opaque handle for one exact database file.  It is deliberately a distinct
/// type from a generic path capability so a database command cannot accidentally
/// be called with a PGN, puzzle, or download destination capability.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct DatabaseHandle {
    pub id: PathRef,
    pub kind: DatabaseHandleKind,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseHandleKind {
    Database,
}
impl DatabaseHandle {
    pub(crate) fn new(id: PathRef) -> Self {
        Self {
            id,
            kind: DatabaseHandleKind::Database,
        }
    }
    pub(crate) fn path_ref(&self) -> &PathRef {
        &self.id
    }
}

/// Opaque authority-managed engine installation root.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct EngineRootHandle {
    pub id: PathRef,
    pub kind: EngineRootHandleKind,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineRootDescriptor {
    pub root: EngineRootHandle,
    pub display_name: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EngineRootHandleKind {
    EngineRoot,
}
impl EngineRootHandle {
    pub(crate) fn new(id: PathRef) -> Self {
        Self {
            id,
            kind: EngineRootHandleKind::EngineRoot,
        }
    }
    pub(crate) fn path_ref(&self) -> &PathRef {
        &self.id
    }
}

/// Opaque exact executable capability. It is distinct from its installation root.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct EngineHandle {
    pub id: PathRef,
    pub kind: EngineHandleKind,
}

/// Opaque, persistent native resource used as a UCI option value.  It is
/// intentionally distinct from executables and workspaces: a resource picker
/// can grant only a file or directory to an engine option, never authority to
/// execute it or inspect siblings.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineResourceHandle {
    pub id: PathRef,
    pub kind: EngineResourceHandleKind,
    pub display_name: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EngineResourceHandleKind {
    File,
    Directory,
}
impl EngineResourceHandle {
    pub(crate) fn new(id: PathRef, kind: EngineResourceHandleKind, display_name: String) -> Self {
        Self {
            id,
            kind,
            display_name,
        }
    }
    pub(crate) fn path_ref(&self) -> &PathRef {
        &self.id
    }
}

/// Lease for an authority-bound resource passed to an engine. Unix retains the opened
/// descriptor. Windows retains the no-delete leaf and complete absolute directory chain,
/// then duplicates those seals into the exact child before protocol service begins.
/// Backend leases remain held until confirmed reap, while child copies survive backend loss.
#[derive(Debug)]
pub(crate) struct EngineResourceLease {
    #[cfg(unix)]
    file: OwnedFile,
    #[cfg(target_os = "macos")]
    target: std::sync::OnceLock<PathBuf>,
    #[cfg(target_os = "macos")]
    pinned_target: std::sync::OnceLock<PathBuf>,
    #[cfg(target_os = "macos")]
    is_directory: bool,
    #[cfg(windows)]
    /// Holds the no-delete handle until the lease is dropped.
    _file: OwnedFile,
    #[cfg(windows)]
    _directories: Vec<fs::File>,
    #[cfg(windows)]
    target: PathBuf,
}

#[cfg(target_os = "macos")]
fn descriptor_path(file: &impl std::os::fd::AsFd) -> Result<PathBuf, Error> {
    use std::os::unix::ffi::OsStrExt;

    rustix::fs::getpath(file)
        .map(|path| PathBuf::from(OsStr::from_bytes(path.as_bytes())))
        .map_err(|error| Error::Io(Box::new(std::io::Error::from(error))))
}

impl EngineResourceLease {
    #[cfg(windows)]
    pub(crate) fn windows_seal_handles(
        &self,
    ) -> impl Iterator<Item = std::os::windows::io::RawHandle> + '_ {
        use std::os::windows::io::AsRawHandle;

        std::iter::once(self._file.as_raw_handle())
            .chain(self._directories.iter().map(AsRawHandle::as_raw_handle))
    }

    #[cfg(unix)]
    fn from_file(
        file: OwnedFile,
        is_directory: bool,
        target_override: Option<PathBuf>,
    ) -> Result<Self, Error> {
        #[cfg(target_os = "macos")]
        let target = match target_override {
            Some(target) => target,
            None => descriptor_path(&file)?,
        };
        #[cfg(not(target_os = "macos"))]
        let _ = is_directory;
        #[cfg(not(target_os = "macos"))]
        let _ = target_override;
        Ok(Self {
            file,
            #[cfg(target_os = "macos")]
            target: std::sync::OnceLock::from(target),
            #[cfg(target_os = "macos")]
            pinned_target: std::sync::OnceLock::new(),
            #[cfg(target_os = "macos")]
            is_directory,
        })
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn uci_value(&self) -> Result<String, Error> {
        use std::os::fd::AsRawFd;
        Ok(format!("/proc/self/fd/{}", self.file.as_raw_fd()))
    }
    #[cfg(target_os = "macos")]
    pub(crate) fn uci_value(&self) -> Result<String, Error> {
        let target = if self.is_directory {
            self.target
                .get()
                .ok_or_else(|| Error::Conflict("engine resource target is unavailable".into()))?
        } else {
            self.pinned_target.get().ok_or_else(|| {
                Error::Conflict(
                    "engine file resource was not pinned before value construction".into(),
                )
            })?
        };
        Ok(target.to_string_lossy().into_owned())
    }
    #[cfg(windows)]
    pub(crate) fn uci_value(&self) -> Result<String, Error> {
        Ok(self.target.to_string_lossy().into_owned())
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn file(&self) -> &OwnedFile {
        &self.file
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn verify_current(&self) -> Result<(), Error> {
        if !self.is_directory {
            return Ok(());
        }
        let path = self
            .target
            .get()
            .ok_or_else(|| Error::Conflict("engine resource target is unavailable".into()))?;
        if crate::infra::fs::held_matches_path(&self.file, path)? {
            Ok(())
        } else {
            Err(Error::Conflict(
                "engine resource changed after authorization".into(),
            ))
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub(crate) fn verify_current(&self) -> Result<(), Error> {
        Ok(())
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn set_pinned_target(&self, target: PathBuf) -> Result<(), Error> {
        self.pinned_target
            .set(target)
            .map_err(|_| Error::Conflict("engine file resource was pinned more than once".into()))
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn is_directory(&self) -> bool {
        self.is_directory
    }
}
#[cfg(all(test, unix))]
impl EngineResourceLease {
    #[cfg(target_os = "macos")]
    pub(crate) fn pin_test_target_to_original(&self) -> Result<(), Error> {
        let target = self
            .target
            .get()
            .cloned()
            .ok_or_else(|| Error::Conflict("engine resource target is unavailable".into()))?;
        self.set_pinned_target(target)
    }

    pub(crate) fn test_file(file: fs::File) -> Self {
        #[cfg(target_os = "macos")]
        let fallback_target = Some(descriptor_path(&file).unwrap_or_else(|_| PathBuf::new()));
        #[cfg(not(target_os = "macos"))]
        let fallback_target = None;
        Self::from_file(file.into(), false, fallback_target)
            .expect("test file lease must be constructible")
    }

    #[cfg(all(test, target_os = "macos"))]
    pub(crate) fn test_directory(file: fs::File) -> Self {
        let fallback_target = Some(descriptor_path(&file).unwrap_or_default());
        Self::from_file(file.into(), true, fallback_target)
            .expect("test directory lease must be constructible")
    }
}
#[cfg(all(test, unix))]
impl EngineExecutable {
    pub(crate) fn test_fixture(
        file: fs::File,
        working_directory: PathBuf,
        resource_leases: Vec<EngineResourceLease>,
    ) -> Self {
        #[cfg(target_os = "macos")]
        let command_path =
            descriptor_path(&file).unwrap_or_else(|_| working_directory.join("engine"));
        Self {
            file: file.into(),
            _working_directory: fs::File::open(&working_directory)
                .expect("test executable must retain a real cwd directory"),
            resource_leases: resource_leases.into_iter().map(Arc::new).collect(),
            #[cfg(target_os = "macos")]
            command_path,
            #[cfg(target_os = "macos")]
            launch_root: None,
            #[cfg(target_os = "macos")]
            materialized_files: Vec::new(),
        }
    }
}

/// Opaque app-owned engine-image asset. Native code alone knows the copied
/// image path; the renderer can safely persist only this handle.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct EngineImageHandle {
    pub id: PathRef,
    pub kind: EngineImageHandleKind,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EngineImageHandleKind {
    EngineImage,
}
impl EngineImageHandle {
    pub(crate) fn new(id: PathRef) -> Self {
        Self {
            id,
            kind: EngineImageHandleKind::EngineImage,
        }
    }
    pub(crate) fn path_ref(&self) -> &PathRef {
        &self.id
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ActivationObserverStage {
    BeforeRead,
    PostVerification,
    CommitBeforeRetainedDescriptorValidation,
}

#[cfg(test)]
pub(crate) trait ActivationObserver: Send + Sync {
    fn observe(&self, stage: ActivationObserverStage);
}

/// Prepared artifact activation evidence produced by [`PathAuthority::prepare_download_artifact`].
/// Retains the exact no-follow descriptor, pending intent, and root identity evidence.
/// Fields and constructors are private to this module so callers outside cannot manufacture
/// verified activation evidence.
struct PreparedArtifactActivation {
    descriptor: VerifiedFile,
    pending: PendingArtifact,
    root_id: PathRef,
    root_path: PathBuf,
    root_identity: Identity,
    prepared_identity: Identity,
    prepared_change_stamp: i128,
    #[cfg(test)]
    observer: Option<Arc<dyn ActivationObserver + Send + Sync>>,
}

/// Distinct content-verified activation evidence constructed solely by successful descriptor
/// hashing inside [`PreparedArtifactActivation::verify`]. Retains the descriptor until publication finishes.
struct ContentVerifiedArtifactActivation {
    descriptor: VerifiedFile,
    pending: PendingArtifact,
    root_id: PathRef,
    root_path: PathBuf,
    root_identity: Identity,
    verified_identity: Identity,
    verified_change_stamp: i128,
    #[cfg(test)]
    observer: Option<Arc<dyn ActivationObserver + Send + Sync>>,
}

impl PreparedArtifactActivation {
    /// Hashes the retained descriptor against the journalled size/digest without holding
    /// any authority reference or mutex lock, and verifies descriptor identity and change stamp after reading.
    fn verify(mut self) -> Result<ContentVerifiedArtifactActivation, Error> {
        #[cfg(test)]
        let (size, digest) = self.descriptor.sha256(self.observer.as_ref())?;
        #[cfg(not(test))]
        let (size, digest) = self.descriptor.sha256()?;

        if size != self.pending.payload_size || digest != self.pending.payload_sha256 {
            return Err(Error::Conflict(
                "download artifact payload differs from its durable reservation".into(),
            ));
        }
        let (a, b) = opened_file_identity(self.descriptor.as_file())?;
        let post_identity = Identity { a, b };
        let post_change_stamp = opened_file_change_stamp(self.descriptor.as_file())?;
        if post_identity != self.prepared_identity
            || post_change_stamp != self.prepared_change_stamp
        {
            return Err(Error::Conflict(
                "download artifact has no durable post-rename identity marker".into(),
            ));
        }
        #[cfg(test)]
        if let Some(observer) = &self.observer {
            observer.observe(ActivationObserverStage::PostVerification);
        }
        Ok(ContentVerifiedArtifactActivation {
            descriptor: self.descriptor,
            pending: self.pending,
            root_id: self.root_id,
            root_path: self.root_path,
            root_identity: self.root_identity,
            verified_identity: post_identity,
            verified_change_stamp: post_change_stamp,
            #[cfg(test)]
            observer: self.observer,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EngineHandleKind {
    Engine,
}

/// Opaque exact opening-book file. It cannot be used where an executable or generic file
/// capability is expected.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct OpeningBookHandle {
    pub id: PathRef,
    pub kind: OpeningBookHandleKind,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum OpeningBookHandleKind {
    OpeningBook,
}
/// Backend-only descriptor for the exact authority-validated opening-book file.
/// It intentionally retains an opened file instead of a path, so parsing cannot
/// be redirected by a replacement after capability resolution.
pub(crate) struct OpeningBookDescriptor {
    pub(crate) file_name: String,
    file: OwnedFile,
}

impl OpeningBookDescriptor {
    /// Hands the already-opened, authority-validated file to the opening-book parser; callers run it on a blocking worker.
    pub(crate) fn into_file(self) -> OwnedFile {
        self.file
    }
}
impl OpeningBookHandle {
    pub(crate) fn new(id: PathRef) -> Self {
        Self {
            id,
            kind: OpeningBookHandleKind::OpeningBook,
        }
    }
    pub(crate) fn path_ref(&self) -> &PathRef {
        &self.id
    }
}

/// Backend-only sealed executable object. Unix retains the revalidated opened
/// descriptor. Every platform retains the validated cwd directory object through child reaping.
/// Windows also retains the image's no-delete handle and launch path. Callers cannot obtain a
/// filesystem path from a renderer capability.
pub(crate) struct EngineExecutable {
    #[cfg(unix)]
    file: OwnedFile,
    _working_directory: fs::File,
    #[cfg(windows)]
    working_directory_path: PathBuf,
    resource_leases: Vec<Arc<EngineResourceLease>>,
    #[cfg(target_os = "macos")]
    command_path: PathBuf,
    #[cfg(target_os = "macos")]
    launch_root: Option<EngineLaunchRoot>,
    #[cfg(target_os = "macos")]
    materialized_files: Vec<MaterializedFile>,
    #[cfg(windows)]
    /// Holds the no-delete handle until the executable is dropped.
    _file: OwnedFile,
    #[cfg(windows)]
    command_path: PathBuf,
}
impl EngineExecutable {
    /// Linux executes the already-opened inode through its stable procfs descriptor. This avoids
    /// a second pathname lookup between authority validation and process creation.
    #[cfg(target_os = "linux")]
    pub(crate) fn command_target(&self) -> PathBuf {
        use std::os::fd::AsRawFd;
        PathBuf::from(format!("/proc/self/fd/{}", self.file.as_raw_fd()))
    }
    #[cfg(target_os = "macos")]
    pub(crate) fn command_target(&self) -> &Path {
        &self.command_path
    }
    /// Windows CreateProcess accepts a path, not an opened executable handle.
    /// The kept no-delete handle seals that exact file until spawn completes,
    /// so the path cannot be replaced between authority validation and launch.
    #[cfg(windows)]
    pub(crate) fn command_target(&self) -> &Path {
        &self.command_path
    }
    #[cfg(windows)]
    pub(crate) fn working_directory_path(&self) -> &Path {
        &self.working_directory_path
    }
    #[cfg(unix)]
    pub(crate) fn working_directory_fd(&self) -> std::os::fd::RawFd {
        use std::os::fd::AsRawFd;
        self._working_directory.as_raw_fd()
    }
    /// Descriptors the child must be able to reach after `exec`: every resource
    /// lease, plus the sealed engine image itself.
    ///
    /// The image descriptor is included because `command_target` launches the
    /// engine as `/proc/self/fd/N`. When that inode is an interpreter script the
    /// kernel re-executes the interpreter with `/proc/self/fd/N` as its argument,
    /// so the interpreter must still be able to open descriptor `N` to read the
    /// script. With the default close-on-exec flag it cannot: the failure is a
    /// hard `ENOENT` at launch for every script-wrapped engine, not a silent
    /// redirection to the visible path. Reading the script back through the
    /// descriptor keeps the already-established sealing property intact.
    ///
    /// Note that `pre_exec` clears close-on-exec once, in the forked child, and
    /// nothing re-sets it. Anything the engine itself spawns therefore inherits
    /// these descriptors too. That has always been true of resource leases; the
    /// engine image joins the same set, and it is no more sensitive than the
    /// leases, being the program the engine is already running.
    #[cfg(target_os = "linux")]
    pub(crate) fn inherited_fds(&self) -> Vec<std::os::fd::RawFd> {
        use std::os::fd::AsRawFd;
        self.resource_leases
            .iter()
            .map(|lease| lease.file.as_raw_fd())
            .chain(std::iter::once(self.file.as_raw_fd()))
            .collect()
    }
    pub(crate) fn with_resource_leases(
        mut self,
        resource_leases: Vec<Arc<EngineResourceLease>>,
    ) -> Self {
        self.resource_leases = resource_leases;
        self
    }

    pub(crate) fn resource_leases(&self) -> &[Arc<EngineResourceLease>] {
        &self.resource_leases
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn launch_root(&self) -> Option<&EngineLaunchRoot> {
        self.launch_root.as_ref()
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn image_file(&self) -> &OwnedFile {
        &self.file
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn set_launch_materialization(
        &mut self,
        command_path: PathBuf,
        materialized_files: Vec<MaterializedFile>,
    ) {
        self.command_path = command_path;
        self.materialized_files = materialized_files;
    }

    #[cfg(all(test, target_os = "macos"))]
    pub(crate) fn set_test_launch_root(&mut self, launch_root: EngineLaunchRoot) {
        self.launch_root = Some(launch_root);
    }
}
impl EngineHandle {
    pub(crate) fn new(id: PathRef) -> Self {
        Self {
            id,
            kind: EngineHandleKind::Engine,
        }
    }
    pub(crate) fn path_ref(&self) -> &PathRef {
        &self.id
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDescriptor {
    pub handle: DatabaseHandle,
    pub filename: String,
    pub availability: PathAvailability,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseUnread {
    pub filename: String,
    pub category: ErrorCategory,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseListing {
    pub entries: Vec<DatabaseDescriptor>,
    pub unread: Vec<DatabaseUnread>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileWorkspaceDescriptor {
    pub handle: FileWorkspaceHandle,
    pub display_name: String,
    pub availability: PathAvailability,
}

/// A completed native download with a usable opaque file capability. Durability uncertainty is
/// reported without asking callers to retry a mutation that may already have committed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPublication {
    pub handle: FileWorkspaceHandle,
    pub durability: CommitDurability,
}

#[derive(Clone)]
pub(crate) struct PendingArtifactReservation {
    id: PathRef,
    payload_size: u64,
    payload_sha256: String,
}

/// The lifetime and scope of a path capability.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PathClass {
    AppOwnedRoot,
    PersistentCustomRoot,
    PersistentFile,
    SingleDialogGrant,
    BoundedDialogGrant,
}

/// Exact least-privilege operation accepted by a capability.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PathOperation {
    ReadPgn,
    WritePgn,
    DatabaseRead,
    DatabaseMutate,
    DatabaseCreate,
    DatabaseExport,
    PuzzleRead,
    PuzzleDelete,
    EngineExecute,
    EngineConfigure,
    EngineBinaryInspect,
    EngineResourceRead,
    OpeningBookRead,
    ImageRead,
    DownloadFile,
    DownloadArchive,
    EngineInstall,
    SnapshotWrite,
    LogWrite,
    OpenShell,
}

fn is_database_file_operation(op: PathOperation) -> bool {
    match op {
        PathOperation::DatabaseRead
        | PathOperation::DatabaseMutate
        | PathOperation::DatabaseCreate
        | PathOperation::DatabaseExport => true,
        PathOperation::ReadPgn
        | PathOperation::WritePgn
        | PathOperation::PuzzleRead
        | PathOperation::PuzzleDelete
        | PathOperation::EngineExecute
        | PathOperation::EngineConfigure
        | PathOperation::EngineBinaryInspect
        | PathOperation::EngineResourceRead
        | PathOperation::OpeningBookRead
        | PathOperation::ImageRead
        | PathOperation::DownloadFile
        | PathOperation::DownloadArchive
        | PathOperation::EngineInstall
        | PathOperation::SnapshotWrite
        | PathOperation::LogWrite
        | PathOperation::OpenShell => false,
    }
}

/// Canonicalizes only the parent and appends the leaf name unchanged, so a leaf
/// symlink is never followed.
fn canonical_binding(path: &Path) -> Result<PathBuf, Error> {
    let file_name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| Error::InvalidInput("database path needs a leaf name".into()))?;
    Ok(fs::canonicalize(parent_of(path))?.join(file_name))
}

fn parent_of(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}

/// Returns the Windows namespace/path reason for a single component, independent of the host
/// platform. Callers apply this predicate only when the Windows path grammar is active; keeping
/// the policy itself cfg-free lets Linux tests execute every Windows-shaped case.
pub(crate) fn windows_component_refusal(name: &OsStr) -> Option<&'static str> {
    let text = name.to_string_lossy();
    if text
        .chars()
        .any(|character| matches!(character, ':' | '/' | '\\' | '\0'))
    {
        return Some("Windows path components may not contain a separator, colon, or NUL");
    }
    if text.encode_utf16().count() > 255 {
        return Some("Windows path component exceeds 255 UTF-16 units");
    }
    if matches!(text.chars().last(), Some('.' | ' ')) {
        return Some("Windows path components may not end with a dot or space");
    }
    let stem = text
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
            | "COM¹"
            | "COM²"
            | "COM³"
            | "LPT¹"
            | "LPT²"
            | "LPT³"
    ) {
        return Some("Windows path component uses a reserved DOS device name");
    }
    None
}

/// The database name leaves room for the appended `.ecsi` search-index sidecar. The shared
/// component predicate remains at the real filesystem limit of 255 units so derived sidecars
/// are valid for an accepted 250-unit database name.
pub(crate) fn windows_database_leaf_refusal(name: &OsStr) -> Option<&'static str> {
    (name.to_string_lossy().encode_utf16().count() > 250).then_some(
        "database filename exceeds the Windows search-index sidecar limit of 250 UTF-16 units",
    )
}

fn validate_windows_database_leaf(name: &OsStr) -> Result<(), Error> {
    if !cfg!(windows) {
        return Ok(());
    }
    if let Some(reason) = windows_database_leaf_refusal(name) {
        return Err(Error::InvalidInput(reason.into()));
    }
    let mut preferred = name.to_os_string();
    preferred.push(".ecsi");
    let legacy = Path::new(name).with_extension("ecsi").into_os_string();
    for sidecar in [preferred, legacy] {
        if let Some(reason) = windows_component_refusal(&sidecar) {
            return Err(Error::InvalidInput(format!(
                "database search-index sidecar is not a valid Windows component: {reason}"
            )));
        }
    }
    Ok(())
}

/// Converts a UTF-16 component length to the two byte lengths used by `UNICODE_STRING`.
/// Returning `None` prevents the lossy `usize` to `u16` cast from opening a different object.
///
/// Deliberately not `#[cfg(windows)]`: its only production caller is `open_windows_child`, but the
/// guard it carries is `f-20260916-03`'s subject and is unit-tested on every platform, which a
/// gated helper could not be. The non-test Linux build therefore has no caller.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn unicode_string_lengths(utf16_units: usize) -> Option<(u16, u16)> {
    let bytes = utf16_units.checked_mul(2)?;
    let length = u16::try_from(bytes).ok()?;
    Some((length, length))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum EntryPurpose {
    PgnWorkspace,
    PgnFile,
    PgnReadOnlyFile,
    DownloadDestination,
    DatabaseRoot,
    DatabaseFile,
    PuzzleRoot,
    PuzzleFile,
    EngineRoot,
    EngineExecutable,
    EngineResource,
    OpeningBook,
    EngineImage,
}

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Type,
)]
#[serde(rename_all = "camelCase")]
pub enum PathOwnerFamily {
    Engines,
    DownloadDestination,
    FileWorkspace,
    RecentFiles,
    ReferenceDatabase,
    PuzzleDatabase,
    OpeningBook,
    SessionWorkspace,
    ExpandedDirectories,
    DatabaseView,
    PracticeDeck,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StartupPathOwners {
    pub retained_ids: Vec<PathRef>,
    pub trusted_families: Vec<PathOwnerFamily>,
}

/// Floor on `authority_id_input_limit()` before retained-ID headroom is added.
/// `MAX_OWNER_UNKNOWN_IDS` headroom is added only to the raw retained-ID list.
const MAX_AUTHORITY_REQUEST_IDS: usize = MAX_AUTHORITY_IDS;

/// Stale-renderer allowance on a raw retained-ID list for startup path-owner reconciliation
/// and for engine attachment actions, added to the registry-dependent limit.
const MAX_OWNER_UNKNOWN_IDS: usize = 16 * MAX_AUTHORITY_IDS;

/// Prepare marks the supplied current-session attachments as prepared without retiring omitted
/// IDs; an empty list is an explicit prepare with no retained attachments.
/// Reconcile with `Some([])` is a trusted complete owner snapshot and permits retirement of
/// omitted IDs. `None` is abandon-only: only explicitly abandoned provisional IDs are retired.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum EngineAttachmentAction {
    Prepare {
        retained_ids: Vec<PathRef>,
    },
    Reconcile {
        retained_ids: Option<Vec<PathRef>>,
        abandoned_ids: Vec<PathRef>,
        startup: bool,
    },
}

fn same_operation_set(actual: &[PathOperation], expected: &[PathOperation]) -> bool {
    actual.len() == expected.len() && expected.iter().all(|operation| actual.contains(operation))
}

fn canonical_operations(purpose: EntryPurpose) -> Vec<PathOperation> {
    match purpose {
        EntryPurpose::PgnWorkspace | EntryPurpose::PgnFile => {
            vec![PathOperation::ReadPgn, PathOperation::WritePgn]
        }
        EntryPurpose::PgnReadOnlyFile => vec![PathOperation::ReadPgn],
        EntryPurpose::DownloadDestination => vec![PathOperation::DownloadFile],
        EntryPurpose::DatabaseRoot => vec![
            PathOperation::DatabaseRead,
            PathOperation::DatabaseMutate,
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseExport,
            PathOperation::DownloadFile,
        ],
        EntryPurpose::DatabaseFile => vec![
            PathOperation::DatabaseRead,
            PathOperation::DatabaseMutate,
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseExport,
        ],
        EntryPurpose::PuzzleRoot => vec![
            PathOperation::PuzzleRead,
            PathOperation::PuzzleDelete,
            PathOperation::DownloadFile,
        ],
        EntryPurpose::PuzzleFile => {
            vec![PathOperation::PuzzleRead, PathOperation::PuzzleDelete]
        }
        EntryPurpose::EngineRoot => vec![
            PathOperation::DownloadArchive,
            PathOperation::EngineInstall,
            PathOperation::EngineExecute,
            PathOperation::EngineConfigure,
        ],
        EntryPurpose::EngineExecutable => engine_file_operations(),
        EntryPurpose::EngineResource => vec![PathOperation::EngineResourceRead],
        EntryPurpose::OpeningBook => vec![PathOperation::OpeningBookRead],
        EntryPurpose::EngineImage => vec![PathOperation::ImageRead],
    }
}

fn purpose_matches_shape(purpose: EntryPurpose, class: PathClass, target_is_dir: bool) -> bool {
    let expected_dir = matches!(
        purpose,
        EntryPurpose::PgnWorkspace
            | EntryPurpose::DownloadDestination
            | EntryPurpose::DatabaseRoot
            | EntryPurpose::PuzzleRoot
            | EntryPurpose::EngineRoot
    ) || (purpose == EntryPurpose::EngineResource && target_is_dir);
    let expected_class = if expected_dir {
        PathClass::PersistentCustomRoot
    } else {
        PathClass::PersistentFile
    };
    class == expected_class && target_is_dir == expected_dir
}

fn purpose_for_shape(
    class: PathClass,
    target_is_dir: bool,
    operations: &[PathOperation],
) -> Option<EntryPurpose> {
    let candidates = [
        EntryPurpose::PgnWorkspace,
        EntryPurpose::PgnFile,
        EntryPurpose::PgnReadOnlyFile,
        EntryPurpose::DownloadDestination,
        EntryPurpose::DatabaseRoot,
        EntryPurpose::DatabaseFile,
        EntryPurpose::PuzzleRoot,
        EntryPurpose::PuzzleFile,
        EntryPurpose::EngineRoot,
        EntryPurpose::EngineExecutable,
        EntryPurpose::EngineResource,
        EntryPurpose::OpeningBook,
        EntryPurpose::EngineImage,
    ];
    candidates.into_iter().find(|purpose| {
        purpose_matches_shape(*purpose, class, target_is_dir)
            && same_operation_set(operations, &canonical_operations(*purpose))
    })
}

fn owner_families_for_purpose(purpose: EntryPurpose) -> Option<Vec<PathOwnerFamily>> {
    use PathOwnerFamily as Family;
    Some(match purpose {
        EntryPurpose::PgnWorkspace | EntryPurpose::PgnFile | EntryPurpose::PgnReadOnlyFile => vec![
            Family::FileWorkspace,
            Family::RecentFiles,
            Family::SessionWorkspace,
            Family::ExpandedDirectories,
            Family::PracticeDeck,
        ],
        EntryPurpose::DownloadDestination => vec![Family::DownloadDestination],
        EntryPurpose::DatabaseRoot | EntryPurpose::PuzzleRoot | EntryPurpose::EngineRoot => vec![],
        EntryPurpose::DatabaseFile => vec![
            Family::RecentFiles,
            Family::ReferenceDatabase,
            Family::SessionWorkspace,
            Family::DatabaseView,
        ],
        EntryPurpose::PuzzleFile => vec![Family::PuzzleDatabase],
        EntryPurpose::EngineExecutable => vec![Family::Engines],
        EntryPurpose::OpeningBook => vec![Family::OpeningBook],
        EntryPurpose::EngineResource | EntryPurpose::EngineImage => return None,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PathAvailability {
    Available,
    Unavailable,
}

/// Test-only snapshot of a path registry entry.
#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PathDescriptor {
    pub id: PathRef,
    pub display_name: String,
    pub class: PathClass,
    pub availability: PathAvailability,
}

/// Persistence result paired with a committed path identifier. `DurabilityUncertain` means the
/// replacement happened but syncing its parent directory failed; callers must not retry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
pub enum CommitDurability {
    Durable,
    DurabilityUncertain(crate::error::DurabilityStage),
}

const UNREGISTERED_ENGINE_IMAGE_DISPLAY_NAME: &str = "Unregistered engine image";

pub(crate) enum EngineImageCleanupIntent {
    Recorded,
    DurabilityUncertain,
    Retained(Error),
    NotRecorded(Error),
}

impl EngineImageCleanupIntent {
    pub(crate) fn diagnostic(&self) -> String {
        match self {
            Self::Recorded => "recorded".into(),
            Self::DurabilityUncertain => "recorded, durability uncertain".into(),
            Self::Retained(error) => {
                format!("not recorded, retained in memory: {}", error.diagnostic())
            }
            Self::NotRecorded(error) => format!("not recorded: {}", error.diagnostic()),
        }
    }
}

pub(crate) fn require_durable(durability: CommitDurability) -> Result<(), Error> {
    match durability {
        CommitDurability::Durable => Ok(()),
        CommitDurability::DurabilityUncertain(stage) => {
            Err(Error::CommittedDurabilityUncertain(stage))
        }
    }
}

fn pgn_export_error_after_cleanup(
    primary: Error,
    removal: Result<(), Error>,
    leaf: &OsStr,
) -> Error {
    crate::infra::fs::created_leaf_error_after_cleanup(primary, removal, "PGN export", leaf)
}

/// Engine and opening-book registration has no renderer-visible list to recover
/// from: picker paths never cross IPC, and copied images are UUID-named. Keep
/// the adopted handle after an uncertain parent sync, matching
/// `set_active_engine_root`. `require_durable` stays on create paths that have
/// a list-and-recover caller.
fn keep_adopted_handle<T: std::fmt::Debug>(durability: CommitDurability, value: T) -> T {
    if let CommitDurability::DurabilityUncertain(stage) = durability {
        log::warn!("registration committed with uncertain durability: {stage}; adopted {value:?}");
    }
    value
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceRemovalStatus {
    Complete,
    Partial,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
pub struct PathCommit {
    pub id: PathRef,
    pub durability: CommitDurability,
}
impl std::ops::Deref for PathCommit {
    type Target = PathRef;
    fn deref(&self) -> &Self::Target {
        &self.id
    }
}
impl PartialEq<PathCommit> for PathRef {
    fn eq(&self, other: &PathCommit) -> bool {
        self == &other.id
    }
}
impl PartialEq<PathRef> for PathCommit {
    fn eq(&self, other: &PathRef) -> bool {
        &self.id == other
    }
}

#[derive(Clone, Debug)]
pub struct AppOwnedRoot {
    pub id: PathRef,
    pub display_name: String,
    pub path: PathBuf,
    pub operations: Vec<PathOperation>,
}
impl AppOwnedRoot {
    #[cfg(test)]
    pub(crate) fn canonical_for_test(
        display_name: impl Into<String>,
        path: &Path,
        operations: Vec<PathOperation>,
    ) -> Self {
        let directory = AppDataDir::for_test(path);
        Self::new(display_name, directory.as_path().to_path_buf(), operations)
    }

    #[cfg(test)]
    pub fn new(
        display_name: impl Into<String>,
        path: PathBuf,
        operations: Vec<PathOperation>,
    ) -> Self {
        Self {
            id: PathRef::fresh(),
            display_name: display_name.into(),
            path,
            operations,
        }
    }
}

/// One of the application's own default root directories under its app-data directory.
/// The set is closed on purpose: the leaf is one half of the security property, so a caller
/// can name only a directory the application itself defines; the declared mode is the other half.
/// [`AppDataDir`] fixes the parent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AppOwnedDefaultRoot {
    Collections,
    Databases,
    Engines,
    EngineImages,
    Puzzles,
    Credentials,
    Practice,
    UnsavedGames,
    #[cfg(target_os = "macos")]
    EngineLaunch,
}

impl AppOwnedDefaultRoot {
    #[cfg(all(test, unix))]
    pub(crate) const ALL: &[Self] = &[
        Self::Collections,
        Self::Databases,
        Self::Engines,
        Self::EngineImages,
        Self::Puzzles,
        Self::Credentials,
        Self::Practice,
        Self::UnsavedGames,
        #[cfg(target_os = "macos")]
        Self::EngineLaunch,
    ];

    fn leaf(self) -> &'static str {
        match self {
            Self::Collections => "collections",
            Self::Databases => "db",
            Self::Engines => "engines",
            Self::EngineImages => "engine-images",
            Self::Puzzles => "puzzles",
            Self::Credentials => "credentials",
            Self::Practice => "practice",
            Self::UnsavedGames => "unsaved-games",
            #[cfg(target_os = "macos")]
            Self::EngineLaunch => "engine-launch",
        }
    }

    #[cfg(unix)]
    fn private_mode(self) -> Option<rustix::fs::RawMode> {
        match self {
            Self::Collections => Some(0o700),
            Self::Credentials => Some(0o700),
            Self::UnsavedGames => Some(0o700),
            #[cfg(target_os = "macos")]
            Self::EngineLaunch => Some(0o700),
            Self::Databases
            | Self::Engines
            | Self::EngineImages
            | Self::Puzzles
            | Self::Practice => None,
        }
    }
}

/// The application's own app-data directory: the only parent an [`AppOwnedDefaultRoot`] may
/// be materialised under. The type is opaque and its only production constructor derives the
/// path from the Tauri app handle, so no in-crate caller can produce one from a user-picked or
/// dialog-derived directory. Without it the leaf was fixed and the parent was an arbitrary
/// `&Path`, which left `<anywhere>/db` reachable — and `src-tauri/src/infra/**` is invisible to
/// `check-rust-release-surface.mjs`, so such a caller would cost no counted site.
///
/// Construction acquires the directory once: the longest existing prefix of the requested path is
/// canonicalised and opened against its identity, and every missing component below it is created
/// relative to that held descriptor. The canonical pathname and retained descriptor are used to
/// materialise registered paths. The requested spelling is retained only to name the location a
/// fresh startup resolves; it never derives a registered path.
pub(crate) struct AppDataDir {
    path: PathBuf,
    requested: PathBuf,
    directory: fs::File,
}

pub(crate) struct InstanceLockGuard {
    _files: Vec<OwnedFile>,
    app_data_locked: bool,
}

impl InstanceLockGuard {
    pub(crate) fn app_data_locked(&self) -> bool {
        self.app_data_locked
    }
}

pub(crate) enum InstanceAdmission {
    Owned(InstanceLockGuard),
    Unguarded,
    HeldElsewhere,
}

pub(crate) fn admit_instance<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    app_data: &AppDataDir,
) -> Result<InstanceAdmission, Error> {
    use tauri::Manager as _;
    let config = app
        .path()
        .app_config_dir()
        .map_err(|error| instance_lock_failure(error.into()))?;
    let local = app
        .path()
        .app_local_data_dir()
        .map_err(|error| instance_lock_failure(error.into()))?;
    admit_instance_with_lock(
        app_data,
        &[("configuration", &config), ("local data", &local)],
        |file| {
            crate::infra::fs::lock_advisory_file(
                file,
                crate::infra::fs::AdvisoryLockMode::NonBlocking,
            )
        },
    )
}

fn instance_lock_failure(error: Error) -> Error {
    startup_acquisition_failure(
        error,
        "application data directory instance lock failed",
        "application data directory instance lock could not be acquired",
    )
}

fn startup_acquisition_failure(error: Error, prefix: &str, message: &str) -> Error {
    log::error!("{prefix}: {}", error.diagnostic());
    match &error {
        Error::Io(error) => crate::error::sanitized_io_error(error, message.into()),
        _ => std::io::Error::other(message.to_owned()),
    }
    .into()
}

fn admit_instance_with_lock(
    app_data: &AppDataDir,
    extra_roots: &[(&'static str, &Path)],
    mut lock: impl FnMut(&OwnedFile) -> Result<(), crate::infra::fs::AdvisoryLockError>,
) -> Result<InstanceAdmission, Error> {
    use crate::infra::fs::{advisory_lock_is_unsupported, AdvisoryLockError, AdvisoryLockPlatform};
    #[cfg(target_os = "linux")]
    let platform = AdvisoryLockPlatform::Linux;
    #[cfg(target_os = "macos")]
    let platform = AdvisoryLockPlatform::MacOs;
    #[cfg(windows)]
    let platform = AdvisoryLockPlatform::Windows;
    let mut acquire = || -> Result<InstanceAdmission, Error> {
        let mut identities = Vec::new();
        let mut files = Vec::new();
        let mut app_data_locked = false;
        for (role, root) in std::iter::once(("application data", None))
            .chain(extra_roots.iter().map(|(role, path)| (*role, Some(*path))))
        {
            let acquired;
            let directory = match root {
                None => &app_data.directory,
                Some(path) => {
                    acquired = AppDataDir::acquire_canonical(path)?;
                    &acquired.directory
                }
            };
            let identity = opened_file_identity(directory)?;
            if identities.contains(&identity) {
                continue;
            }
            identities.push(identity);
            let file = crate::infra::fs::open_or_create_regular_at(
                directory,
                OsStr::new("instance.lock"),
            )?;
            match lock(&file) {
                Ok(()) => {
                    if root.is_none() {
                        app_data_locked = true;
                    }
                    files.push(file);
                }
                Err(AdvisoryLockError::HeldElsewhere(_)) => {
                    log::warn!("another ChessRiddle Studio process holds the application data directory; this launch exits");
                    return Ok(InstanceAdmission::HeldElsewhere);
                }
                Err(AdvisoryLockError::Io(error))
                    if error
                        .raw_os_error()
                        .is_some_and(|code| advisory_lock_is_unsupported(code, platform)) =>
                {
                    log::warn!("the {role} directory's filesystem does not support advisory locking. ChessRiddle Studio starts without an instance lock there: {error}");
                }
                Err(AdvisoryLockError::Io(error)) => return Err(error.into()),
            }
        }
        if files.is_empty() {
            Ok(InstanceAdmission::Unguarded)
        } else {
            Ok(InstanceAdmission::Owned(InstanceLockGuard {
                _files: files,
                app_data_locked,
            }))
        }
    };
    acquire().map_err(instance_lock_failure)
}

#[cfg(all(test, unix))]
std::thread_local! {
    static APP_DATA_PRE_OPEN_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

/// Runs once in the next [`AppDataDir`] construction, after the existing prefix was canonicalised
/// and its identity read and before that prefix is opened against the identity.
#[cfg(all(test, unix))]
pub(crate) fn set_app_data_pre_open_hook(hook: Option<Box<dyn FnOnce()>>) {
    APP_DATA_PRE_OPEN_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

fn app_data_acquisition_failure(error: Error) -> Error {
    startup_acquisition_failure(
        error,
        "application data directory acquisition failed",
        "application data directory could not be acquired",
    )
}

impl AppDataDir {
    /// The production constructor, and the only one outside tests. Generic over
    /// `R: tauri::Runtime`, matching how `puzzle.rs` and `db/mod.rs` spell that bound, so the
    /// workspace helpers stay reachable from `tauri::test::mock_app()`.
    pub(crate) fn for_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Self, Error> {
        use tauri::Manager as _;
        Self::acquire(&app.path().app_data_dir()?)
    }

    /// Test-only, and `#[cfg(test)]`-gated rather than merely private: a constructor from an
    /// arbitrary path is precisely the escape hatch this type exists to remove, so it must not
    /// compile into the shipped binary at all. The tests need it because a real
    /// `app_data_dir()` resolves against the user directory of the machine running them.
    #[cfg(test)]
    pub(crate) fn for_test(path: &Path) -> Self {
        Self::try_for_test(path).expect("test application data directory is acquirable")
    }

    /// The fallible form of [`AppDataDir::for_test`], for tests that drive a failing construction.
    #[cfg(test)]
    pub(crate) fn try_for_test(path: &Path) -> Result<Self, Error> {
        Self::acquire(path)
    }

    /// Every construction failure — including a `Conflict` from a prefix swapped between
    /// canonicalisation and open — becomes `Error::Io` with fixed text, so no native path reaches
    /// the renderer. The shared sanitising helper preserves missing-entry classification and
    /// other I/O kinds, including the Permission category.
    fn acquire(requested: &Path) -> Result<Self, Error> {
        Self::acquire_canonical(requested).map_err(app_data_acquisition_failure)
    }

    fn acquire_canonical(requested: &Path) -> Result<Self, Error> {
        let mut prefix = requested.to_path_buf();
        let mut missing = Vec::new();
        loop {
            match fs::symlink_metadata(&prefix) {
                Ok(_) => break,
                Err(error) if crate::error::is_missing_entry_io(&error) => {
                    if !has_normal_leaf(&prefix) {
                        return Err(error.into());
                    }
                    let (Some(name), Some(parent)) = (prefix.file_name(), prefix.parent()) else {
                        return Err(error.into());
                    };
                    missing.push(name.to_os_string());
                    prefix = parent.to_path_buf();
                }
                Err(error) => return Err(error.into()),
            }
        }
        // Ancestors of the requested path may legitimately be symlinks (`/var -> /private/var`);
        // they are followed exactly once, here, and never again after the descriptor is held.
        let mut path = fs::canonicalize(&prefix)?;
        let id = identity(&path)?;
        #[cfg(all(test, unix))]
        if let Some(hook) = APP_DATA_PRE_OPEN_HOOK.with(|slot| slot.borrow_mut().take()) {
            hook();
        }
        let mut directory =
            crate::infra::fs::open_verified_directory(&path, (id.a, id.b))?.into_file();
        for name in missing.iter().rev() {
            directory = crate::infra::fs::ensure_directory_at(&directory, name)?;
            path.push(name);
        }
        Ok(Self {
            path,
            requested: requested.to_path_buf(),
            directory,
        })
    }

    fn as_path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn startup_location(&self, root: AppOwnedDefaultRoot) -> DefaultRootLocation {
        DefaultRootLocation {
            path: self.requested.join(root.leaf()),
            requested_app_data: self.requested.clone(),
            root,
        }
    }
}

/// A sealed pathname naming where startup resolves one app-owned default root.
#[derive(Clone, Debug)]
pub(crate) struct DefaultRootLocation {
    path: PathBuf,
    requested_app_data: PathBuf,
    root: AppOwnedDefaultRoot,
}

impl DefaultRootLocation {
    /// Resolves this root through the same acquisition and materialisation path as startup.
    pub(crate) fn reacquire(&self) -> Result<AuthorizedDir, Error> {
        let app_data_dir = AppDataDir::acquire(&self.requested_app_data)?;
        ensure_app_owned_default_dir(&app_data_dir, self.root)
    }
}

/// Bundled resource directory whose production constructor fixes the parent directory.
pub(crate) struct ResourceDir(PathBuf);

impl ResourceDir {
    pub(crate) fn for_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Self, Error> {
        Ok(Self(app.path().resource_dir()?))
    }

    /// Test-only for the same reason as [`AppDataDir::for_test`]: arbitrary resource roots must
    /// not be constructible in the shipped binary.
    #[cfg(test)]
    pub(crate) fn for_test(path: &Path) -> Self {
        Self(path.to_path_buf())
    }

    fn as_path(&self) -> &Path {
        &self.0
    }
}

fn authorize_existing_dir(path: &Path) -> Result<AuthorizedDir, Error> {
    let metadata = fs::symlink_metadata(path)?;
    if is_link_like(&metadata) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "app-owned default root is a reparse point",
        )
        .into());
    }
    if !metadata.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "app-owned default root is not a directory",
        )
        .into());
    }
    let id = identity(path)?;
    let directory = crate::infra::fs::open_verified_directory(path, (id.a, id.b))?;
    Ok(AuthorizedDir {
        directory,
        identity: (id.a, id.b),
        path: path.to_path_buf(),
    })
}

/// Materialise one of the application's own default root directories under `app_data_dir`.
/// Both halves of the path are fixed by the types: the leaf per variant, the parent by
/// [`AppDataDir`]'s constructor. No caller can therefore name a directory the application does
/// not own, and in particular a user-picked path can never acquire create-if-missing semantics.
/// Refuses a leaf that is a symlink or not a directory.
///
/// The leaf is created if missing and opened no-follow relative to the descriptor [`AppDataDir`]
/// retains, so no pathname walk of the app-data spelling happens here and a swapped ancestor
/// cannot redirect it. The returned path is the canonical app-data path joined with the leaf.
/// Subsequent writes must use the returned descriptor rather than reopening the pathname.
///
/// The refusal is built as an `std::io::Error`, so it reaches the renderer as `Error::Io` —
/// fixed text plus the MissingResource/Permission/Io discrimination. `Error::InvalidInput`
/// would render its string verbatim and put a native path on the wire.
pub(crate) fn ensure_app_owned_default_dir(
    app_data_dir: &AppDataDir,
    root: AppOwnedDefaultRoot,
) -> Result<AuthorizedDir, Error> {
    let leaf = OsStr::new(root.leaf());
    let path = app_data_dir.as_path().join(leaf);
    let opened = crate::infra::fs::ensure_directory_at(&app_data_dir.directory, leaf)
        .map_err(|error| default_root_refusal(&path, error))?;
    let identity = opened_file_identity(&opened)?;
    let directory = VerifiedDir::new(opened, identity)?;
    #[cfg(unix)]
    if let Some(mode) = root.private_mode() {
        rustix::fs::fchmod(directory.as_file(), rustix::fs::Mode::from_raw_mode(mode))
            .map_err(|error| Error::Io(Box::new(error.into())))?;
    }
    Ok(AuthorizedDir {
        directory,
        identity,
        path,
    })
}

/// Names why a default-root leaf could not be opened as a directory. The descriptor open has
/// already failed, so the lookup below only chooses the fixed refusal text; nothing is authorised
/// from it. A link-like leaf (symlink, or a junction on Windows) and a non-directory keep the
/// refusals `authorize_existing_dir` reports; any other failure passes through unchanged.
fn default_root_refusal(path: &Path, error: Error) -> Error {
    let reason = match fs::symlink_metadata(path) {
        Ok(metadata) if is_link_like(&metadata) => "app-owned default root is a reparse point",
        Ok(metadata) if !metadata.is_dir() => "app-owned default root is not a directory",
        _ => return error,
    };
    std::io::Error::new(std::io::ErrorKind::InvalidInput, reason).into()
}

#[cfg(target_os = "macos")]
const MAX_ENGINE_LAUNCH_LEAVES: usize = 64;
#[cfg(target_os = "macos")]
pub(crate) const ENGINE_EXECUTABLE_LEAF_MODE: u32 = 0o700;
#[cfg(target_os = "macos")]
pub(crate) const ENGINE_RESOURCE_LEAF_MODE: u32 = 0o600;
#[cfg(target_os = "macos")]
pub(crate) const ENGINE_LAUNCH_LOCK_MODE: u32 = 0o600;

#[cfg(target_os = "macos")]
#[derive(Debug, Clone)]
pub(crate) struct EngineLaunchRoot {
    inner: Arc<EngineLaunchRootInner>,
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct EngineLaunchRootInner {
    _root: fs::File,
    _lock: OwnedFile,
    instance: fs::File,
    instance_path: PathBuf,
    registry: std::sync::Mutex<LaunchLeafRegistry>,
}

#[cfg(target_os = "macos")]
impl EngineLaunchRootInner {
    fn registry(&self) -> std::sync::MutexGuard<'_, LaunchLeafRegistry> {
        match self.registry.lock() {
            Ok(registry) => registry,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

#[cfg(target_os = "macos")]
#[derive(Debug, Default)]
struct LaunchLeafRegistry {
    live: usize,
    released: Vec<ReleasedLeaf>,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReleasedLeaf {
    pub(crate) leaf: OsString,
    pub(crate) engine_key: String,
    pub(crate) engine_id: String,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Default)]
pub(crate) struct ReclaimReport {
    pub(crate) removed: usize,
    pub(crate) failed: Vec<(ReleasedLeaf, Error)>,
}

#[cfg(target_os = "macos")]
pub(crate) struct MaterializedFile {
    root: Arc<EngineLaunchRootInner>,
    leaf: OsString,
    engine_key: String,
    engine_id: String,
    attempted: bool,
    active: bool,
}

#[cfg(target_os = "macos")]
impl Drop for MaterializedFile {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let mut registry = self.root.registry();
        if self.attempted {
            registry.released.push(ReleasedLeaf {
                leaf: self.leaf.clone(),
                engine_key: self.engine_key.clone(),
                engine_id: self.engine_id.clone(),
            });
        } else {
            registry.live = registry.live.saturating_sub(1);
        }
    }
}

#[cfg(target_os = "macos")]
impl MaterializedFile {
    pub(crate) fn path(&self) -> PathBuf {
        self.root.instance_path.join(&self.leaf)
    }

    pub(crate) fn create_from(
        &mut self,
        source: &impl crate::infra::inode_ownership::NativeFile,
        mode: u32,
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<(), Error> {
        self.attempted = true;
        #[cfg(all(test, unix))]
        observe_engine_resolution("leaf");
        if is_cancelled() {
            return Err(Error::Cancellation);
        }
        #[cfg(test)]
        ENGINE_LAUNCH_BEFORE_CLONE_HOOKS.run(&self.engine_key);

        use rustix::fs::{self as rfs, CloneFlags, Mode};
        use rustix::io::Errno;
        #[cfg(test)]
        let forced_failure = ENGINE_LAUNCH_FAILURES.take(&self.engine_key);
        #[cfg(test)]
        let cloned = match forced_failure {
            Some(EngineLaunchFailure::CloneExdev) => Err(Errno::XDEV),
            Some(EngineLaunchFailure::CloneEnotsup) => Err(Errno::NOTSUP),
            Some(EngineLaunchFailure::Copy) => Err(Errno::XDEV),
            _ => rfs::fclonefileat(source, &self.root.instance, &self.leaf, CloneFlags::empty()),
        };
        #[cfg(not(test))]
        let cloned =
            rfs::fclonefileat(source, &self.root.instance, &self.leaf, CloneFlags::empty());
        match cloned {
            Ok(()) => {}
            Err(error) if error == Errno::XDEV || error == Errno::NOTSUP => {
                let (mut target, _) =
                    crate::infra::fs::create_regular_at(&self.root.instance, &self.leaf)?;
                #[cfg(test)]
                if forced_failure == Some(EngineLaunchFailure::Copy) {
                    return Err(Error::Io(Box::new(std::io::Error::other(
                        "injected engine launch copy failure",
                    ))));
                }
                let stat = rfs::fstat(source)
                    .map_err(|error| Error::Io(Box::new(std::io::Error::from(error))))?;
                let size = u64::try_from(stat.st_size).map_err(|_| {
                    Error::InvalidInput("engine launch source has an invalid size".into())
                })?;
                let mut offset = 0_u64;
                let mut buffer = [0_u8; 64 * 1024];
                while offset < size {
                    if is_cancelled() {
                        return Err(Error::Cancellation);
                    }
                    let wanted = usize::try_from((size - offset).min(buffer.len() as u64))
                        .map_err(|_| {
                            Error::ResourceLimit("engine launch file is too large".into())
                        })?;
                    let read = rustix::io::pread(source, &mut buffer[..wanted], offset)
                        .map_err(|error| Error::Io(Box::new(std::io::Error::from(error))))?;
                    if read == 0 {
                        return Err(Error::Io(Box::new(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "engine launch source ended before its descriptor size",
                        ))));
                    }
                    target.write_all(&buffer[..read])?;
                    offset = offset.checked_add(read as u64).ok_or_else(|| {
                        Error::ResourceLimit("engine launch file is too large".into())
                    })?;
                }
            }
            Err(error) => return Err(Error::Io(Box::new(std::io::Error::from(error)))),
        }
        if is_cancelled() {
            return Err(Error::Cancellation);
        }
        let target = crate::infra::fs::open_regular_at(
            &self.root.instance,
            &self.leaf,
            crate::infra::fs::RegularFileAccess::ReadOnly,
        )?;
        let mode = u16::try_from(mode)
            .map_err(|_| Error::InvalidInput("engine launch mode is invalid".into()))?;
        #[cfg(test)]
        if forced_failure == Some(EngineLaunchFailure::Fchmod) {
            return Err(Error::Io(Box::new(std::io::Error::other(
                "injected engine launch fchmod failure",
            ))));
        }
        rfs::fchmod(&target, Mode::from_raw_mode(mode))
            .map_err(|error| Error::Io(Box::new(std::io::Error::from(error))))?;
        if is_cancelled() {
            return Err(Error::Cancellation);
        }
        Ok(())
    }

    pub(crate) fn remove(mut self) -> Result<(), Error> {
        if !self.active {
            return Ok(());
        }
        let result = remove_instance_leaf(&self.root.instance, &self.leaf);
        if result.is_ok() {
            self.active = false;
            let mut registry = self.root.registry();
            registry.live = registry.live.saturating_sub(1);
        }
        result
    }
}

#[cfg(target_os = "macos")]
fn remove_instance_leaf(instance: &fs::File, leaf: &OsStr) -> Result<(), Error> {
    match rustix::fs::statat(instance, leaf, rustix::fs::AtFlags::SYMLINK_NOFOLLOW) {
        Err(rustix::io::Errno::NOENT) => Ok(()),
        Err(error) => Err(Error::Io(Box::new(std::io::Error::from(error)))),
        Ok(stat) => crate::infra::fs::remove_entry_at(
            instance,
            leaf,
            crate::infra::fs::raw_stat_identity(&stat),
            false,
        ),
    }
}

#[cfg(target_os = "macos")]
impl EngineLaunchRoot {
    #[cfg(test)]
    pub(crate) fn instance_path(&self) -> PathBuf {
        self.inner.instance_path.clone()
    }

    pub(crate) fn reserve_leaves(
        &self,
        count: usize,
        engine_key: &str,
        engine_id: &str,
    ) -> Result<Vec<MaterializedFile>, Error> {
        let mut registry = self.inner.registry();
        if registry.live.saturating_add(count) > MAX_ENGINE_LAUNCH_LEAVES {
            return Err(Error::ResourceLimit(
                "engine launch leaf limit reached".into(),
            ));
        }
        registry.live += count;
        Ok((0..count)
            .map(|_| MaterializedFile {
                root: self.inner.clone(),
                leaf: OsString::from(format!("{}.leaf", Uuid::new_v4())),
                engine_key: engine_key.into(),
                engine_id: engine_id.into(),
                attempted: false,
                active: true,
            })
            .collect())
    }

    pub(crate) fn reclaim(&self) -> ReclaimReport {
        let released = {
            let mut registry = self.inner.registry();
            std::mem::take(&mut registry.released)
        };
        let mut report = ReclaimReport::default();
        for leaf in released {
            let result = remove_instance_leaf(&self.inner.instance, &leaf.leaf);
            let mut registry = self.inner.registry();
            match result {
                Ok(()) => {
                    report.removed += 1;
                    registry.live = registry.live.saturating_sub(1);
                }
                Err(error) => {
                    registry.released.push(leaf.clone());
                    report.failed.push((leaf, error));
                }
            }
        }
        report
    }

    #[cfg(test)]
    pub(crate) fn registry_snapshot_for_test(&self) -> (usize, Vec<ReleasedLeaf>) {
        let registry = self.inner.registry();
        (registry.live, registry.released.clone())
    }

    #[cfg(test)]
    pub(crate) fn for_test(temp_dir: &Path) -> Result<Self, Error> {
        initialize_engine_launch_root(&AppDataDir::for_test(temp_dir))
    }
}

#[cfg(target_os = "macos")]
fn sibling_id(name: &OsStr) -> Option<String> {
    name.to_str()
        .and_then(|name| name.strip_suffix(".lock"))
        .map(str::to_owned)
}

#[cfg(target_os = "macos")]
fn log_launch_sibling_failure(id: &str, error: &Error) {
    log::error!(
        "engine launch sibling cleanup failed for {id}: category={}",
        error.category()
    );
}

#[cfg(target_os = "macos")]
fn sweep_engine_launch_root(
    root: &AuthorizedDir,
    own_lock: &OsStr,
    own_instance: &OsStr,
) -> Result<(), Error> {
    use crate::infra::fs::{lock_advisory_file, AdvisoryLockError, AdvisoryLockMode};
    let entries = read_directory_entries_at(
        root.directory.as_file(),
        &CancellationToken::new(),
        None,
        &mut |_| true,
    )?;
    let lock_ids = entries
        .iter()
        .filter_map(|entry| sibling_id(&entry.name))
        .collect::<std::collections::HashSet<_>>();
    for entry in &entries {
        if entry.name == own_lock || entry.name == own_instance {
            continue;
        }
        let Some(id) = sibling_id(&entry.name) else {
            continue;
        };
        if entry.kind != DirectoryEntryKind::RegularFile {
            let error = root
                .open_regular_relative(Path::new(&entry.name))
                .err()
                .unwrap_or_else(|| Error::InvalidInput("engine launch lock is not a file".into()));
            log_launch_sibling_failure(&id, &error);
            continue;
        }
        let lock = match crate::infra::fs::open_regular_at(
            root.directory.as_file(),
            &entry.name,
            RegularFileAccess::ReadOnly,
        ) {
            Ok(lock) => lock,
            Err(error) => {
                log_launch_sibling_failure(&id, &error);
                continue;
            }
        };
        match lock_advisory_file(&lock, AdvisoryLockMode::NonBlocking) {
            Err(AdvisoryLockError::HeldElsewhere(_)) => continue,
            Err(error) => {
                log_launch_sibling_failure(&id, &Error::Io(Box::new(error.into_io_error())));
                continue;
            }
            Ok(()) => {}
        }
        let instance_name = OsStr::new(&id);
        if let Some(instance) = entries
            .iter()
            .find(|candidate| candidate.name == instance_name)
        {
            if instance.kind != DirectoryEntryKind::Directory {
                let error = Error::InvalidInput("engine launch instance is not a directory".into());
                log_launch_sibling_failure(&id, &error);
                continue;
            }
            if let Err(error) = crate::infra::fs::remove_entry_at(
                root.directory.as_file(),
                &instance.name,
                instance.identity,
                true,
            ) {
                log_launch_sibling_failure(&id, &error);
                continue;
            }
        }
        if let Err(error) = crate::infra::fs::remove_entry_at(
            root.directory.as_file(),
            &entry.name,
            entry.identity,
            false,
        ) {
            log_launch_sibling_failure(&id, &error);
        }
    }
    for entry in &entries {
        if entry.name == own_lock || entry.name == own_instance {
            continue;
        }
        if entry.kind == DirectoryEntryKind::Directory
            && entry
                .name
                .to_str()
                .is_none_or(|name| !lock_ids.contains(name))
        {
            if let Err(error) = crate::infra::fs::remove_entry_at(
                root.directory.as_file(),
                &entry.name,
                entry.identity,
                true,
            ) {
                log_launch_sibling_failure(&entry.name.to_string_lossy(), &error);
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn initialize_engine_launch_root(
    app_data: &AppDataDir,
) -> Result<EngineLaunchRoot, Error> {
    let root = ensure_app_owned_default_dir(app_data, AppOwnedDefaultRoot::EngineLaunch)?;
    let id = Uuid::new_v4().to_string();
    let lock_name = OsString::from(format!("{id}.lock"));
    let lock = crate::infra::inode_ownership::create_at_mode(
        root.directory.as_file(),
        &lock_name,
        rustix::fs::OFlags::from_bits_retain((libc::O_EXLOCK | libc::O_NONBLOCK) as _),
        rustix::fs::Mode::from_raw_mode(ENGINE_LAUNCH_LOCK_MODE as _),
    )?;
    #[cfg(test)]
    ENGINE_LAUNCH_LOCK_CREATED_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
    let instance_name = OsString::from(id.clone());
    crate::infra::fs::create_dir_at(root.directory.as_file(), &instance_name)?;
    let instance =
        crate::infra::fs::open_directory_at(root.directory.as_file(), &instance_name, false)?;
    sweep_engine_launch_root(&root, &lock_name, &instance_name)?;
    Ok(EngineLaunchRoot {
        inner: Arc::new(EngineLaunchRootInner {
            _root: root.try_clone()?,
            _lock: lock,
            instance,
            instance_path: root.path().join(instance_name),
            registry: std::sync::Mutex::new(LaunchLeafRegistry::default()),
        }),
    })
}

#[cfg(all(test, target_os = "macos"))]
std::thread_local! {
    static ENGINE_LAUNCH_LOCK_CREATED_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

/// Keyed by the engine key the leaf was reserved for; see `infra::test_hooks`.
#[cfg(all(test, target_os = "macos"))]
static ENGINE_LAUNCH_BEFORE_CLONE_HOOKS: crate::infra::test_hooks::KeyedTestHooks<String> =
    crate::infra::test_hooks::KeyedTestHooks::new();

#[cfg(all(test, target_os = "macos"))]
pub(crate) fn set_engine_launch_lock_created_hook(hook: Option<Box<dyn FnOnce()>>) {
    ENGINE_LAUNCH_LOCK_CREATED_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(all(test, target_os = "macos"))]
pub(crate) fn set_engine_launch_before_clone_hook(
    engine_key: &str,
    hook: Option<crate::infra::test_hooks::TestHook>,
) {
    match hook {
        Some(hook) => ENGINE_LAUNCH_BEFORE_CLONE_HOOKS.arm(engine_key.to_owned(), hook),
        None => ENGINE_LAUNCH_BEFORE_CLONE_HOOKS.clear(&engine_key.to_owned()),
    }
}

#[cfg(all(test, unix))]
pub(crate) type EngineResolutionTrace =
    Arc<std::sync::Mutex<Vec<(&'static str, std::thread::ThreadId)>>>;

#[cfg(all(test, unix))]
std::thread_local! {
    static ENGINE_RESOLUTION_TRACE_LOCAL: std::cell::RefCell<Option<EngineResolutionTrace>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(all(test, unix))]
pub(crate) fn set_engine_resolution_trace(trace: Option<EngineResolutionTrace>) {
    ENGINE_RESOLUTION_TRACE_LOCAL.with(|slot| *slot.borrow_mut() = trace);
}

#[cfg(all(test, unix))]
pub(crate) fn take_engine_resolution_trace_for_worker() -> Option<EngineResolutionTrace> {
    ENGINE_RESOLUTION_TRACE_LOCAL.with(|slot| slot.borrow_mut().take())
}

#[cfg(all(test, unix))]
pub(crate) struct EngineResolutionTraceGuard(Option<EngineResolutionTrace>);

#[cfg(all(test, unix))]
pub(crate) fn install_engine_resolution_trace_for_worker(
    trace: Option<EngineResolutionTrace>,
) -> EngineResolutionTraceGuard {
    let previous = ENGINE_RESOLUTION_TRACE_LOCAL.with(|slot| slot.replace(trace));
    EngineResolutionTraceGuard(previous)
}

#[cfg(all(test, unix))]
impl Drop for EngineResolutionTraceGuard {
    fn drop(&mut self) {
        ENGINE_RESOLUTION_TRACE_LOCAL.with(|slot| {
            slot.replace(self.0.take());
        });
    }
}

#[cfg(all(test, unix))]
fn observe_engine_resolution(kind: &'static str) {
    let trace = ENGINE_RESOLUTION_TRACE_LOCAL.with(|slot| slot.borrow().clone());
    if let Some(trace) = trace {
        trace
            .lock()
            .unwrap()
            .push((kind, std::thread::current().id()));
    }
}

#[cfg(all(test, target_os = "macos"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EngineLaunchFailure {
    CloneExdev,
    CloneEnotsup,
    Copy,
    Fchmod,
}

/// Keyed by the engine key the leaf was reserved for; see `infra::test_hooks`.
#[cfg(all(test, target_os = "macos"))]
static ENGINE_LAUNCH_FAILURES: crate::infra::test_hooks::KeyedTestValues<
    String,
    EngineLaunchFailure,
> = crate::infra::test_hooks::KeyedTestValues::new();

#[cfg(all(test, target_os = "macos"))]
pub(crate) fn set_engine_launch_failure(engine_key: &str, failure: Option<EngineLaunchFailure>) {
    match failure {
        Some(failure) => ENGINE_LAUNCH_FAILURES.arm(engine_key.to_owned(), failure),
        None => ENGINE_LAUNCH_FAILURES.clear(&engine_key.to_owned()),
    }
}

const SOUND_ROOT_LEAF: &str = "sound";

pub(crate) fn open_app_owned_resource_dir(
    resource_dir: &ResourceDir,
) -> Result<AuthorizedDir, Error> {
    let path = resource_dir.as_path().join(SOUND_ROOT_LEAF);
    authorize_existing_dir(&path)
}

pub trait Clock: Send + Sync {
    fn now(&self) -> SystemTime;
}
#[derive(Default)]
pub struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "platform", rename_all = "camelCase")]
pub(crate) enum NativePath {
    Unix { bytes: String },
    Windows { utf16: Vec<u16> },
}
impl NativePath {
    pub(crate) fn from_path(path: &Path) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            Self::Unix {
                bytes: STANDARD_NO_PAD.encode(path.as_os_str().as_bytes()),
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            Self::Windows {
                utf16: path.as_os_str().encode_wide().collect(),
            }
        }
        #[cfg(not(any(unix, windows)))]
        compile_error!("path authority needs a native path codec");
    }
    pub(crate) fn to_path(&self) -> Result<PathBuf, Error> {
        match self {
            #[cfg(unix)]
            Self::Unix { bytes } => {
                use std::os::unix::ffi::OsStringExt;
                Ok(PathBuf::from(OsString::from_vec(
                    STANDARD_NO_PAD
                        .decode(bytes)
                        .map_err(|_| Error::InvalidInput("invalid stored native path".into()))?,
                )))
            }
            #[cfg(windows)]
            Self::Windows { utf16 } => {
                use std::os::windows::ffi::OsStringExt;
                Ok(PathBuf::from(OsString::from_wide(utf16)))
            }
            #[allow(unreachable_patterns)]
            _ => Err(Error::InvalidInput(
                "registry path belongs to another platform".into(),
            )),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
// `windows_file_identity` is pub(crate) and returns this, so on the Windows target a private
// Identity is "more private than the item" that exposes it.
pub(crate) struct Identity {
    a: u64,
    b: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct IdentityBinding {
    identity: Identity,
    parent_identity: Option<Identity>,
}

impl IdentityBinding {
    fn new(identity: Identity, parent_identity: Option<Identity>) -> Self {
        Self {
            identity,
            parent_identity,
        }
    }

    pub(crate) fn from_pairs(identity: (u64, u64), parent_identity: (u64, u64)) -> Self {
        Self::new(
            Identity {
                a: identity.0,
                b: identity.1,
            },
            Some(Identity {
                a: parent_identity.0,
                b: parent_identity.1,
            }),
        )
    }
}

fn identity(path: &Path) -> Result<Identity, Error> {
    let meta = fs::symlink_metadata(path)?;
    if is_link_like(&meta) {
        return Err(Error::InvalidInput(
            "symbolic links are not path authorities".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(Identity {
            a: meta.dev(),
            b: meta.ino(),
        })
    }
    #[cfg(windows)]
    {
        windows_identity(path)
    }
}

pub(crate) async fn hash_staged_payload_cancellable(
    mut file: fs::File,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<(fs::File, (u64, String)), Error> {
    crate::infra::blocking::BLOCKING_GATEWAY
        .spawn_cancellable(cancellation, move |token| {
            file.rewind()?;
            let payload = sha256_reader_cancellable(&mut file, token)?;
            Ok((file, payload))
        })
        .await
}

#[cfg(all(test, unix))]
fn sha256_file(path: &Path) -> Result<(u64, String), Error> {
    let mut file = fs::File::open(path)?;
    sha256_open_file(&mut file, None)
}

fn sha256_reader_cancellable(
    reader: &mut impl Read,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<(u64, String), Error> {
    sha256_read_core(
        reader,
        &mut [0_u8; 64 * 1024],
        || {
            if cancellation.is_cancelled() {
                Err(Error::Cancellation)
            } else {
                Ok(())
            }
        },
        |_| Ok(()),
    )
}

fn sha256_read_core(
    reader: &mut impl Read,
    buffer: &mut [u8],
    mut before_read: impl FnMut() -> Result<(), Error>,
    mut account_read: impl FnMut(u64) -> Result<(), Error>,
) -> Result<(u64, String), Error> {
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    loop {
        before_read()?;
        let read = reader.read(buffer)?;
        if read == 0 {
            break;
        }
        size = size.checked_add(read as u64).ok_or_else(|| {
            Error::ResourceLimit("artifact payload exceeds supported size".into())
        })?;
        account_read(read as u64)?;
        hasher.update(&buffer[..read]);
    }
    Ok((size, format!("{:x}", hasher.finalize())))
}

/// Activates the download artifact through a single blocking worker where payload hashing
/// occurs outside the authority lock. Locks to persist the post-rename marker and prepare,
/// drops the lock to verify the descriptor, then reacquires the lock to commit.
pub(crate) async fn activate_download_artifact_runtime(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    reservation: &PendingArtifactReservation,
    installed_identity: (u64, u64),
    installed_ctime_nanos: i128,
) -> Result<ArtifactPublication, Error> {
    let authority = authority.clone();
    let reservation = reservation.clone();
    crate::infra::blocking::BLOCKING_GATEWAY
        .spawn(move || {
            let prepared = {
                authority.with_mut(|auth| {
                    auth.mark_download_artifact_committed(
                        &reservation,
                        installed_identity,
                        installed_ctime_nanos,
                    )?;
                    auth.prepare_download_artifact(&reservation)
                })??
            };
            let verified = prepared.verify()?;
            authority.with_mut(|auth| auth.commit_download_artifact(verified))?
        })
        .await
}

fn sha256_open_file(
    file: &mut impl Read,
    #[cfg(test)] observer: Option<&Arc<dyn ActivationObserver + Send + Sync>>,
) -> Result<(u64, String), Error> {
    sha256_read_core(
        file,
        &mut [0_u8; 64 * 1024],
        || {
            #[cfg(test)]
            if let Some(observer) = observer {
                observer.observe(ActivationObserverStage::BeforeRead);
            }
            Ok(())
        },
        |_| Ok(()),
    )
}

/// Change stamp paired with the opaque file identity. It is never a standalone authority check:
/// Unix uses inode ctime; Windows uses the handle's last-write FILETIME. Platforms without a
/// stable handle timestamp reject post-rename marker publication rather than making a claim.
fn opened_file_change_stamp(file: &impl FileMetadata) -> Result<i128, Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        return Ok(i128::from(metadata.ctime()) * 1_000_000_000 + i128::from(metadata.ctime_nsec()));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return Ok(i128::from(file.metadata()?.last_write_time()));
    }
    #[allow(unreachable_code)]
    Err(crate::infra::platform_support::unsupported_plural(
        "post-rename marker timestamps",
    ))
}
/// Stable identity for any already-opened object. This intentionally exposes no path and
/// uses the Windows handle index instead of lossy metadata fallbacks.
pub(crate) fn opened_file_identity(file: &impl FileMetadata) -> Result<(u64, u64), Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = file.metadata()?;
        let identity = (meta.dev(), meta.ino());
        #[cfg(test)]
        if DATABASE_CREATE_IDENTITY_FAILURE
            .with(|slot| slot.get() == Some(identity) && slot.take().is_some())
        {
            return Err(Error::from(std::io::Error::other(
                "injected database-create post-handoff identity failure",
            )));
        }
        Ok(identity)
    }
    #[cfg(windows)]
    {
        let identity = windows_file_identity(file)?;
        Ok((identity.a, identity.b))
    }
}

fn identity_from_open_file(file: &impl FileMetadata) -> Result<Identity, Error> {
    let (a, b) = opened_file_identity(file)?;
    Ok(Identity { a, b })
}

fn verify_parent_identity(parent: &fs::File, expected: Option<&Identity>) -> Result<(), Error> {
    let actual = identity_from_open_file(parent)?;
    if expected != Some(&actual) {
        return Err(Error::Conflict(
            "path authority is unavailable because its object changed".into(),
        ));
    }
    Ok(())
}
#[cfg(not(windows))]
pub(crate) fn is_reparse_point(_: &fs::Metadata) -> bool {
    false
}
#[cfg(windows)]
pub(crate) fn is_reparse_point(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
        != 0
}

fn is_link_like(meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink() || is_reparse_point(meta)
}

#[cfg(windows)]
fn windows_identity(path: &Path) -> Result<Identity, Error> {
    let file = open_windows_nofollow(path, false)?;
    windows_file_identity(&file)
}
#[cfg(windows)]
pub(crate) fn windows_file_identity(file: &impl FileMetadata) -> Result<Identity, Error> {
    use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle;
    let mut info = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.native_handle() as _, &mut info) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(Identity {
        a: info.dwVolumeSerialNumber as u64,
        b: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    })
}

#[cfg(windows)]
pub(crate) fn windows_open_status_error(status: i32) -> Error {
    use windows_sys::Win32::Foundation::{
        RtlNtStatusToDosError, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, STATUS_NO_SUCH_FILE,
        STATUS_OBJECT_NAME_COLLISION, STATUS_OBJECT_NAME_NOT_FOUND, STATUS_OBJECT_PATH_NOT_FOUND,
        STATUS_SHARING_VIOLATION,
    };

    match status {
        STATUS_OBJECT_NAME_NOT_FOUND | STATUS_NO_SUCH_FILE => Error::Io(Box::new(
            std::io::Error::from_raw_os_error(ERROR_FILE_NOT_FOUND as i32),
        )),
        STATUS_OBJECT_PATH_NOT_FOUND => Error::Io(Box::new(std::io::Error::from_raw_os_error(
            ERROR_PATH_NOT_FOUND as i32,
        ))),
        STATUS_OBJECT_NAME_COLLISION => Error::Conflict("Windows object name collision".into()),
        STATUS_SHARING_VIOLATION => Error::Conflict("Windows sharing violation".into()),
        _ => {
            let error = unsafe { RtlNtStatusToDosError(status) };
            Error::Io(Box::new(std::io::Error::from_raw_os_error(error as i32)))
        }
    }
}

/// Opens one child relative to an already-opened directory with `NtCreateFile`. The child name
/// is a single component and the OS resolves it below `RootDirectory`; mutable ancestor strings
/// are never concatenated or reopened during traversal.
#[cfg(windows)]
pub(crate) fn open_windows_child(
    dir: &fs::File,
    name: &OsStr,
    disposition: u32,
    access: u32,
    security_descriptor: *const windows_sys::Win32::Security::SECURITY_DESCRIPTOR,
    directory: bool,
    allow_delete_share: bool,
) -> Result<fs::File, Error> {
    open_windows_child_with_kind(
        dir,
        name,
        disposition,
        access,
        security_descriptor,
        if directory {
            WindowsChildKind::Directory
        } else {
            WindowsChildKind::NonDirectory
        },
        allow_delete_share,
    )
}

#[cfg(windows)]
pub(crate) fn open_windows_child_with_kind(
    dir: &fs::File,
    name: &OsStr,
    disposition: u32,
    access: u32,
    security_descriptor: *const windows_sys::Win32::Security::SECURITY_DESCRIPTOR,
    kind: WindowsChildKind,
    allow_delete_share: bool,
) -> Result<fs::File, Error> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    nt_create_windows_child(
        dir,
        name,
        WindowsChildRequest {
            disposition,
            access,
            security_descriptor,
            kind,
            share_access: FILE_SHARE_READ
                | FILE_SHARE_WRITE
                | if allow_delete_share {
                    FILE_SHARE_DELETE
                } else {
                    0
                },
        },
    )
}

#[cfg(windows)]
pub(crate) enum WindowsChildKind {
    Directory,
    NonDirectory,
    FileOrDirectory,
}

#[cfg(windows)]
pub(crate) struct WindowsChildRequest {
    pub(crate) disposition: u32,
    pub(crate) access: u32,
    pub(crate) security_descriptor: *const windows_sys::Win32::Security::SECURITY_DESCRIPTOR,
    pub(crate) kind: WindowsChildKind,
    pub(crate) share_access: u32,
}

/// Creates or opens one leaf below a retained directory handle without following reparse points.
#[cfg(windows)]
pub(crate) fn nt_create_windows_child(
    dir: &fs::File,
    name: &OsStr,
    request: WindowsChildRequest,
) -> Result<fs::File, Error> {
    use std::{
        mem::{size_of, zeroed},
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle, RawHandle},
        },
        ptr::null_mut,
    };
    use windows_sys::{
        Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem::NtCreateFile},
        Win32::{
            Foundation::{HANDLE, UNICODE_STRING},
            System::IO::IO_STATUS_BLOCK,
        },
    };
    const OBJ_CASE_INSENSITIVE: u32 = 0x40;
    const OBJ_DONT_REPARSE: u32 = 0x1000;
    const FILE_DIRECTORY_FILE: u32 = 0x1;
    const FILE_NON_DIRECTORY_FILE: u32 = 0x40;
    const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    // NtCreateFile IoStatusBlock->Information: windows-sys Win32::System::WindowsProgramming::FILE_CREATED = 2.
    const FILE_CREATED: usize = 2;
    // Without this the I/O manager keeps no `CurrentByteOffset` on the returned file object:
    // every `ReadFile`/`WriteFile` with a NULL `lpOverlapped` — which is what `File::read` and
    // `File::write` always issue — fails with `STATUS_INVALID_PARAMETER`, and
    // `NtQueryDirectoryFile` may complete asynchronously with `STATUS_PENDING`. `SYNCHRONIZE` in
    // the access mask does not imply it; only the create option does. Every call site's mask
    // carries `SYNCHRONIZE`, which this option requires.
    const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x20;
    crate::infra::fs::single_leaf(name)?;
    let mut wide: Vec<u16> = name.encode_wide().collect();
    let (length, maximum_length) = unicode_string_lengths(wide.len()).ok_or_else(|| {
        Error::InvalidInput("Windows path component exceeds the UNICODE_STRING limit".into())
    })?;
    let mut unicode = UNICODE_STRING {
        Length: length,
        MaximumLength: maximum_length,
        Buffer: wide.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: dir.as_raw_handle() as _,
        ObjectName: &mut unicode,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        SecurityDescriptor: request.security_descriptor,
        SecurityQualityOfService: null_mut(),
    };
    let mut handle: HANDLE = null_mut();
    let mut status: IO_STATUS_BLOCK = unsafe { zeroed() };
    let options = FILE_OPEN_REPARSE_POINT
        | FILE_SYNCHRONOUS_IO_NONALERT
        | match request.kind {
            WindowsChildKind::Directory => FILE_DIRECTORY_FILE,
            WindowsChildKind::NonDirectory => FILE_NON_DIRECTORY_FILE,
            WindowsChildKind::FileOrDirectory => 0,
        };
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            request.access,
            &attributes,
            &mut status,
            null_mut(),
            0,
            request.share_access,
            request.disposition,
            options,
            null_mut(),
            0,
        )
    };
    if result != 0 {
        return Err(windows_open_status_error(result));
    }
    let file = unsafe { fs::File::from_raw_handle(handle as RawHandle) };
    if status.Information != FILE_CREATED && is_reparse_point(&file.metadata()?) {
        return Err(Error::InvalidInput(
            "reparse points cannot be authorized".into(),
        ));
    }
    Ok(file)
}

#[cfg(any(windows, test))]
pub(crate) fn allows_delete_sharing_for_operation(
    operation: PathOperation,
    is_final_leaf: bool,
) -> bool {
    !is_final_leaf
        || !matches!(
            operation,
            PathOperation::EngineExecute
                | PathOperation::EngineConfigure
                | PathOperation::EngineResourceRead
        )
}
#[cfg(windows)]
fn open_windows_nofollow(path: &Path, writable: bool) -> Result<fs::File, Error> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let mut options = fs::OpenOptions::new();
    options
        .read(true)
        .write(writable)
        // Keep the opened authorized executable/file from being replaced until
        // a caller that relies on this descriptor has finished its operation.
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
    let file = options.open(path)?;
    if is_reparse_point(&file.metadata()?) {
        return Err(Error::InvalidInput(
            "reparse points cannot be authorized".into(),
        ));
    }
    Ok(file)
}
fn class_is_root(class: PathClass) -> bool {
    matches!(
        class,
        PathClass::AppOwnedRoot | PathClass::PersistentCustomRoot
    )
}
fn validate_target(path: &Path, class: PathClass) -> Result<Identity, Error> {
    #[cfg(test)]
    if ACQUIRE_TARGET_MISSING_ONCE.with(|slot| slot.replace(false)) {
        #[cfg(unix)]
        let code = libc::ENOENT;
        #[cfg(windows)]
        let code = windows_sys::Win32::Foundation::ERROR_FILE_NOT_FOUND as i32;
        return Err(std::io::Error::from_raw_os_error(code).into());
    }
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Err(Error::InvalidInput(
            "symbolic links cannot be authorized".into(),
        ));
    }
    if class_is_root(class) {
        if !meta.is_dir() {
            return Err(Error::InvalidInput(
                "root authority must be a directory".into(),
            ));
        }
    } else if !meta.is_file() {
        return Err(Error::InvalidInput(
            "file authority must be a regular file".into(),
        ));
    }
    identity(path)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AcquireShape {
    Dialog { parent_access: ParentAccess },
    File { parent_access: ParentAccess },
    Root { parent_access: ParentAccess },
}

impl AcquireShape {
    fn for_persistent_class(class: PathClass, parent_access: ParentAccess) -> Self {
        if class == PathClass::PersistentCustomRoot {
            Self::Root { parent_access }
        } else {
            Self::File { parent_access }
        }
    }

    fn parent_access(self) -> ParentAccess {
        match self {
            Self::Dialog { parent_access }
            | Self::File { parent_access }
            | Self::Root { parent_access } => parent_access,
        }
    }
}

/// A path with a normal leaf stores the proven canonical `(path, identity)` pair and its retained
/// parent/leaf descriptor. Leafless paths keep the caller's spelling and carry no descriptor.
/// `parent_identity` is captured from the already-open parent for persisted file entries.
/// `parent_and_leaf` is the proving descriptor consumed by `database_file_target`/`for_test_path`
/// and dropped by registration doors, whose later use re-walks the stored path no-follow.
struct AcquiredTarget {
    path: PathBuf,
    identity: Identity,
    parent_identity: Option<Identity>,
    target_is_dir: bool,
    parent_and_leaf: Option<(fs::File, OsString)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RegistrationDoor {
    ExplicitReauthorization,
    PassiveObservation,
    /// A path the user picked in a native dialog just now; a file replaced at that path receives a
    /// fresh capability instead of a Conflict.
    PickerSelection,
}

fn acquire_target(path: &Path, shape: AcquireShape) -> Result<AcquiredTarget, Error> {
    #[cfg(all(test, unix))]
    ACQUIRE_TARGET_CALLS.with(|calls| calls.set(calls.get().saturating_add(1)));

    let parent_access = shape.parent_access();
    let (identity, target_is_dir) = match shape {
        AcquireShape::Dialog { .. } => {
            let meta = fs::symlink_metadata(path)?;
            if meta.file_type().is_symlink() || (!meta.is_file() && !meta.is_dir()) {
                return Err(Error::InvalidInput(
                    "dialog selection must be a regular file or directory".into(),
                ));
            }
            (identity(path)?, meta.is_dir())
        }
        AcquireShape::File { .. } => (validate_target(path, PathClass::PersistentFile)?, false),
        AcquireShape::Root { .. } => (
            validate_target(path, PathClass::PersistentCustomRoot)?,
            true,
        ),
    };

    if !has_normal_leaf(path) {
        return Ok(AcquiredTarget {
            path: path.to_path_buf(),
            identity,
            parent_identity: None,
            target_is_dir,
            parent_and_leaf: None,
        });
    };

    #[cfg(unix)]
    {
        let canonical = canonical_binding(path)?;
        #[cfg(test)]
        ACQUIRE_TARGET_BEFORE_PROOF_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        let parent_and_leaf = crate::infra::fs::open_verified_parent(
            &canonical,
            (identity.a, identity.b),
            target_is_dir,
            parent_access,
        )?;
        let parent_identity = if target_is_dir {
            None
        } else {
            Some(identity_from_open_file(&parent_and_leaf.0)?)
        };
        Ok(AcquiredTarget {
            path: canonical,
            identity,
            parent_identity,
            target_is_dir,
            parent_and_leaf: Some(parent_and_leaf),
        })
    }

    #[cfg(windows)]
    {
        let canonical = canonical_binding(path)?;
        let parent_and_leaf = crate::infra::fs::open_verified_parent(
            &canonical,
            (identity.a, identity.b),
            target_is_dir,
            parent_access,
        )?;
        let parent_identity = if target_is_dir {
            None
        } else {
            Some(identity_from_open_file(&parent_and_leaf.0)?)
        };
        Ok(AcquiredTarget {
            path: canonical,
            identity,
            parent_identity,
            target_is_dir,
            parent_and_leaf: Some(parent_and_leaf),
        })
    }
}

/// Re-proves the stored object under its canonical spelling. Identity alone permits an
/// ancestor renamed and replaced by a symlink to the same object under a different path.
fn acquire_stored_target(
    stored: &StoredEntry,
    shape: AcquireShape,
    changed_message: &str,
) -> Result<AcquiredTarget, Error> {
    let path = stored.path.to_path()?;
    let acquired = acquire_target(&path, shape)?;
    if acquired.identity != stored.identity || acquired.path != path {
        return Err(Error::Conflict(changed_message.into()));
    }
    Ok(acquired)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct StoredEntry {
    id: PathRef,
    display_name: String,
    class: PathClass,
    operations: Vec<PathOperation>,
    path: NativePath,
    identity: Identity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_identity: Option<Identity>,
    #[serde(default)]
    target_is_dir: bool,
    #[serde(default)]
    purpose: Option<EntryPurpose>,
    /// Practice store addressing key. Absent means the entry's own id, so existing
    /// decks and registries keep working without a data migration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    practice_key: Option<String>,
}

fn practice_storage_key(stored: &StoredEntry) -> &str {
    stored
        .practice_key
        .as_deref()
        .unwrap_or(stored.id.id.as_str())
}

fn listing_practice_paths_match(left: &StoredEntry, right: &StoredEntry) -> Option<bool> {
    let left = left.path.to_path().ok()?;
    let right = right.path.to_path().ok()?;
    Some(listing_paths_match(&left, &right))
}

fn assign_unique_practice_key_matches(
    fresh: &[&StoredEntry],
    donors: &[&StoredEntry],
    matches: impl Fn(&StoredEntry, &StoredEntry) -> bool,
    claimed: &mut BTreeSet<String>,
    inherited: &mut BTreeMap<String, String>,
) {
    let mut fresh_hits: Vec<Vec<usize>> = vec![Vec::new(); fresh.len()];
    let mut donor_hits: Vec<Vec<usize>> = vec![Vec::new(); donors.len()];
    for (fi, fresh_entry) in fresh.iter().enumerate() {
        for (di, donor) in donors.iter().enumerate() {
            if matches(fresh_entry, donor) {
                fresh_hits[fi].push(di);
                donor_hits[di].push(fi);
            }
        }
    }
    for (fi, hits) in fresh_hits.iter().enumerate() {
        if hits.len() != 1 {
            continue;
        }
        let di = hits[0];
        if donor_hits[di].len() != 1 {
            continue;
        }
        let donor = donors[di];
        inherited.insert(
            fresh[fi].id.id.clone(),
            practice_storage_key(donor).to_owned(),
        );
        claimed.insert(donor.id.id.clone());
    }
}

/// Inherit a removed PgnFile's practice storage key onto a fresh PgnFile in the same
/// listing commit. Ambiguous or undecidable matches inherit nothing; this stays infallible.
fn inherit_listing_practice_keys(
    removed: &[StoredEntry],
    prepared: &[PreparedEntry],
) -> BTreeMap<String, String> {
    let donors: Vec<&StoredEntry> = removed
        .iter()
        .filter(|entry| entry.purpose == Some(EntryPurpose::PgnFile))
        .collect();
    let fresh: Vec<&StoredEntry> = prepared
        .iter()
        .filter(|entry| !entry.reused && entry.stored.purpose == Some(EntryPurpose::PgnFile))
        .map(|entry| &entry.stored)
        .collect();
    let mut inherited = BTreeMap::new();
    let mut claimed = BTreeSet::new();
    // Same-identity donors inherit when both stored paths convert. Path inequality is
    // not required: a removed same-identity donor is the same file object, including
    // an ASCII case-only outside rename that listing_paths_match folds as equal.
    assign_unique_practice_key_matches(
        &fresh,
        &donors,
        |fresh, donor| {
            donor.identity == fresh.identity && listing_practice_paths_match(donor, fresh).is_some()
        },
        &mut claimed,
        &mut inherited,
    );
    let remaining_fresh: Vec<&StoredEntry> = fresh
        .iter()
        .copied()
        .filter(|entry| !inherited.contains_key(&entry.id.id))
        .collect();
    let remaining_donors: Vec<&StoredEntry> = donors
        .iter()
        .copied()
        .filter(|entry| !claimed.contains(&entry.id.id))
        .collect();
    assign_unique_practice_key_matches(
        &remaining_fresh,
        &remaining_donors,
        |fresh, donor| {
            donor.identity != fresh.identity
                && listing_practice_paths_match(donor, fresh) == Some(true)
        },
        &mut claimed,
        &mut inherited,
    );
    inherited
}

fn is_engine_root_use(stored: &StoredEntry, operation: PathOperation) -> bool {
    stored.target_is_dir
        && stored.purpose == Some(EntryPurpose::EngineRoot)
        && stored.operations.contains(&operation)
        && matches!(
            operation,
            PathOperation::DownloadArchive | PathOperation::EngineInstall
        )
}

fn engine_read_search_directory(stored: &StoredEntry) -> Result<CapabilityDirectory, Error> {
    let acquired = acquire_stored_target(
        stored,
        AcquireShape::Root {
            parent_access: ParentAccess::Readable,
        },
        "workspace is unavailable because its root changed",
    )?;
    let directory = if let Some((parent, leaf)) = acquired.parent_and_leaf {
        open_directory_at(&parent, &leaf, false)?
    } else {
        #[cfg(unix)]
        {
            use rustix::fs::{self as rfs, Mode, OFlags};
            fs::File::from(
                rfs::openat(
                    rfs::CWD,
                    &acquired.path,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|error| Error::from(std::io::Error::from(error)))?,
            )
        }
        #[cfg(windows)]
        {
            open_windows_nofollow(&acquired.path, false)?
        }
    };
    if opened_file_identity(&directory)? != (stored.identity.a, stored.identity.b) {
        return Err(Error::Conflict("root changed concurrently".into()));
    }
    Ok(CapabilityDirectory { directory })
}

/// A writable open alone cannot establish read/search permission loss.
fn label_engine_root_open(error: Error, stored: Option<&StoredEntry>, writable: bool) -> Error {
    let Some(stored) = stored else { return error };
    if writable && error.root_failure_reason() == Some(crate::error::RootFailure::Permission) {
        let probe = engine_read_search_directory(stored).and_then(|directory| {
            directory
                .entries(&CancellationToken::new(), &mut |_| false)
                .map(|_| ())
        });
        return match probe.err().and_then(|error| error.root_failure_reason()) {
            Some(crate::error::RootFailure::Permission) => error.label_root_failure(),
            _ => error,
        };
    }
    error.label_root_failure()
}

fn engine_install_directory(stored: &StoredEntry) -> Result<fs::File, Error> {
    let path = stored.path.to_path().map_err(Error::label_root_failure)?;
    crate::infra::fs::open_verified_directory(&path, (stored.identity.a, stored.identity.b))
        .map(VerifiedDir::into_file)
        .map_err(|error| label_engine_root_open(error, Some(stored), true))
}
#[derive(Serialize, Deserialize)]
struct Registry {
    schema_version: u32,
    entries: Vec<StoredEntry>,
    #[serde(default)]
    active_database_root: Option<PathRef>,
    #[serde(default)]
    active_puzzle_root: Option<PathRef>,
    #[serde(default)]
    active_engine_root: Option<PathRef>,
    #[serde(default)]
    pending_artifacts: Vec<PendingArtifact>,
    /// Attachment IDs issued in this or a prior session but not yet durably adopted by renderer
    /// storage. Missing lifecycle metadata is deliberately interpreted as owned legacy state.
    #[serde(default)]
    provisional_attachments: BTreeSet<String>,
    /// Retired managed images remain here until identity-checked cleanup completes. These are not
    /// authority entries and therefore cannot resolve after restart.
    #[serde(default)]
    image_cleanup: Vec<StoredEntry>,
    #[serde(default)]
    catalog_installs: BTreeMap<String, catalog_install::CatalogInstall>,
    #[serde(default)]
    catalog_uses: Vec<catalog_install::CatalogUse>,
}
/// Durable intent recorded before an atomic download replacement. It lets a restarted authority
/// either activate the newly installed exact file or discard an intent whose replacement never
/// happened; neither state exposes a native path to the renderer.
#[derive(Clone, Serialize, Deserialize)]
struct PendingArtifact {
    id: PathRef,
    root: PathRef,
    filename: NativePath,
    display_name: String,
    operations: Vec<PathOperation>,
    baseline: Option<Identity>,
    /// The target root and exact staged bytes are part of the durable intent.
    /// Recovery never infers publication from an inode merely differing from baseline.
    #[serde(default)]
    root_identity: Option<Identity>,
    #[serde(default)]
    payload_size: u64,
    #[serde(default)]
    payload_sha256: String,
    #[serde(default)]
    payload_bound: bool,
    /// Written durably only after `renameat` and verified through a no-follow FD. This prevents
    /// a byte-identical outsider replacement from satisfying a merely content-based recovery.
    #[serde(default)]
    installed_identity: Option<Identity>,
    #[serde(default)]
    installed_ctime_nanos: Option<i128>,
}
#[derive(Clone, PartialEq, Eq)]
struct Entry {
    stored: StoredEntry,
    availability: PathAvailability,
}

/// Records only identities eligible for this listing before its unlocked walk.
pub(crate) struct DirectoryListingSnapshot {
    root: PathBuf,
    entries: Vec<StoredEntry>,
}

fn listing_paths_match(recorded: &Path, path: &Path) -> bool {
    #[cfg(not(windows))]
    {
        recorded == path
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use std::path::Component;

        let fold = |unit: u16| {
            if (u16::from(b'A')..=u16::from(b'Z')).contains(&unit) {
                unit + u16::from(b'a' - b'A')
            } else {
                unit
            }
        };
        let mut recorded = recorded.components();
        let mut path = path.components();
        loop {
            match (recorded.next(), path.next()) {
                (None, None) => return true,
                (Some(left), Some(right)) => {
                    let matches = match (left, right) {
                        (Component::Prefix(_), Component::Prefix(_))
                        | (Component::Normal(_), Component::Normal(_)) => left
                            .as_os_str()
                            .encode_wide()
                            .map(fold)
                            .eq(right.as_os_str().encode_wide().map(fold)),
                        _ => left == right,
                    };
                    if !matches {
                        return false;
                    }
                }
                _ => return false,
            }
        }
    }
}

impl DirectoryListingSnapshot {
    /// Match only the pre-walk paths, without observing the filesystem again.
    pub(crate) fn retained_ids(
        &self,
        unread: &[(Vec<OsString>, bool)],
    ) -> Result<BTreeSet<String>, Error> {
        let mut retained = BTreeSet::new();
        for (components, recursive) in unread {
            let path = components
                .iter()
                .fold(self.root.clone(), |path, leaf| path.join(leaf));
            for stored in &self.entries {
                let recorded = stored.path.to_path()?;
                let descendant = *recursive
                    && if cfg!(windows) {
                        recorded
                            .ancestors()
                            .any(|ancestor| listing_paths_match(ancestor, &path))
                    } else {
                        recorded.starts_with(&path)
                    };
                if listing_paths_match(&recorded, &path) || descendant {
                    retained.insert(stored.id.id.clone());
                }
            }
        }
        Ok(retained)
    }
}

#[derive(Clone)]
pub(crate) struct PreparedEntry {
    stored: StoredEntry,
    reused: bool,
}

impl PreparedEntry {
    pub(crate) fn id(&self) -> PathRef {
        self.stored.id.clone()
    }
}

type CompleteWorkspacePruneCandidate = (
    BTreeMap<String, Entry>,
    Vec<PendingArtifact>,
    BTreeSet<String>,
);
#[derive(Clone)]
struct DialogGrant {
    entry: Entry,
    expires_at: SystemTime,
    uses_left: u32,
    inserted_at: u64,
}

fn is_write_operation(op: PathOperation) -> bool {
    matches!(
        op,
        PathOperation::WritePgn
            | PathOperation::DatabaseMutate
            | PathOperation::DatabaseCreate
            | PathOperation::DatabaseExport
            | PathOperation::PuzzleDelete
            | PathOperation::EngineInstall
            | PathOperation::SnapshotWrite
            | PathOperation::LogWrite
    )
}

fn allows_missing_leaf(op: PathOperation) -> bool {
    match op {
        PathOperation::ReadPgn
        | PathOperation::WritePgn
        | PathOperation::DatabaseRead
        | PathOperation::DatabaseMutate
        | PathOperation::DatabaseCreate
        | PathOperation::DatabaseExport
        | PathOperation::PuzzleRead
        | PathOperation::PuzzleDelete
        | PathOperation::EngineExecute
        | PathOperation::EngineConfigure
        | PathOperation::EngineBinaryInspect
        | PathOperation::EngineResourceRead
        | PathOperation::OpeningBookRead
        | PathOperation::ImageRead
        | PathOperation::EngineInstall
        | PathOperation::SnapshotWrite
        | PathOperation::LogWrite
        | PathOperation::OpenShell => false,
        PathOperation::DownloadFile | PathOperation::DownloadArchive => true,
    }
}

pub(crate) fn parent_access_for_operations(operations: &[PathOperation]) -> ParentAccess {
    if operations
        .iter()
        .copied()
        .any(|operation| is_write_operation(operation) || allows_missing_leaf(operation))
    {
        ParentAccess::Writable
    } else {
        ParentAccess::Readable
    }
}

/// Counts complete blocking image issuances so shutdown cannot clean up before they settle.
pub(crate) struct ActiveImageIssuances {
    active: AtomicUsize,
    notify: Notify,
}

impl ActiveImageIssuances {
    fn new() -> Self {
        Self {
            active: AtomicUsize::new(0),
            notify: Notify::new(),
        }
    }

    pub(crate) async fn wait_for_zero(&self) {
        loop {
            // Arm the notification before observing the count. Otherwise a release between
            // the check and `notified().await` can leave shutdown asleep forever.
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.active.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }
}

pub(crate) struct ActiveImageIssuanceLease {
    tracker: Arc<ActiveImageIssuances>,
}

impl Drop for ActiveImageIssuanceLease {
    fn drop(&mut self) {
        self.tracker.active.fetch_sub(1, Ordering::AcqRel);
        self.tracker.notify.notify_waiters();
    }
}

#[derive(Clone)]
struct RegistryAdmissionSnapshot {
    bytes: usize,
    serialized: Vec<u8>,
    admission_units: usize,
    pending_count: usize,
}

/// Backend-only authority registry. Its public methods never parse renderer-provided raw paths.
pub struct PathAuthority {
    registry_path: PathBuf,
    persistent: BTreeMap<String, Entry>,
    dialogs: HashMap<String, DialogGrant>,
    clock: Arc<dyn Clock>,
    dialog_capacity: usize,
    next_insertion: u64,
    active_database_root: Option<PathRef>,
    active_puzzle_root: Option<PathRef>,
    active_engine_root: Option<PathRef>,
    pending_artifacts: Vec<PendingArtifact>,
    pending_unpersisted_removals: BTreeSet<String>,
    loaded_candidate_ids: BTreeSet<String>,
    session_protected_ids: BTreeSet<String>,
    completion_resources: BTreeMap<String, Vec<PathRef>>,
    completed_owner_families: BTreeSet<PathOwnerFamily>,
    startup_retained_ids: BTreeSet<String>,
    startup_unowned_roots_reconciled: bool,
    provisional_attachments: BTreeSet<String>,
    retired_attachments: BTreeMap<String, Entry>,
    image_cleanup: BTreeMap<String, StoredEntry>,
    catalog_installs: BTreeMap<String, catalog_install::CatalogInstall>,
    catalog_session: String,
    catalog_protected: BTreeSet<String>,
    /// Durable unresolved child uses, independent of authority or install existence. Keys retain
    /// each terminal binding. Each originating session owns its boolean, where true also reaches
    /// recursive contents. Uses survive reopen until that session's proven shutdown clears them.
    catalog_uses: catalog_install::CatalogUses,
    attachments_sealed: bool,
    registry_durability_pending: bool,
    active_image_issuances: Arc<ActiveImageIssuances>,
    engine_image_sweep_root: Option<AppDataDir>,
    #[cfg(test)]
    activation_observer: Option<Arc<dyn ActivationObserver + Send + Sync>>,
    #[cfg(target_os = "macos")]
    engine_launch_root: Option<EngineLaunchRoot>,
}
/// Splits a caller-supplied relative path into components without normalising it. `Path::components`
/// would drop interior `.` and empty segments, silently accepting `"a/./b"` and `"a//b"`; both
/// must instead reach [`validate_components`] and be refused. The separator differs per platform,
/// so the platform split lives here rather than in the ungated walk.
#[cfg(unix)]
fn relative_components(relative: &Path) -> Vec<OsString> {
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    relative
        .as_os_str()
        .as_bytes()
        .split(|byte| *byte == b'/')
        .map(|component| OsString::from_vec(component.to_vec()))
        .collect()
}

#[cfg(windows)]
fn relative_components(relative: &Path) -> Vec<OsString> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    let wide: Vec<u16> = relative.as_os_str().encode_wide().collect();
    wide.split(|&unit| unit == u16::from(b'\\') || unit == u16::from(b'/'))
        .map(OsString::from_wide)
        .collect()
}

fn engine_relative_components(relative_path: &str) -> Result<Vec<OsString>, Error> {
    let components: Vec<OsString> = Path::new(relative_path)
        .components()
        .map(|component| match component {
            std::path::Component::Normal(value) => Ok(value.to_os_string()),
            _ => Err(Error::InvalidInput(
                "engine path must be a relative file path".into(),
            )),
        })
        .collect::<Result<_, _>>()?;
    if components.is_empty() {
        return Err(Error::InvalidInput("engine path is required".into()));
    }
    validate_components(&components)?;
    Ok(components)
}

fn validate_components(components: &[OsString]) -> Result<(), Error> {
    for name in components {
        let component = name.as_os_str();
        if cfg!(windows) {
            if let Some(reason) = windows_component_refusal(component) {
                return Err(Error::InvalidInput(reason.into()));
            }
        }
        if component.is_empty()
            || component == OsStr::new(".")
            || component == OsStr::new("..")
            || Path::new(component).components().count() != 1
        {
            return Err(Error::InvalidInput(
                "invalid relative path component".into(),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            if component.as_bytes().contains(&b'/') || component.as_bytes().contains(&0) {
                return Err(Error::InvalidInput(
                    "path component contains a separator or NUL".into(),
                ));
            }
        }
    }
    Ok(())
}

/// Compare Unicode composition without changing case or merging invalid native encodings.
fn nfc_leaf_name(leaf: &OsStr) -> OsString {
    match leaf.to_str() {
        Some(name) => name.nfc().collect::<String>().into(),
        None => leaf.to_os_string(),
    }
}

pub(crate) fn equivalent_sibling_leaves(
    directory: &fs::File,
    leaf: &OsStr,
    cancellation: &CancellationToken,
) -> Result<Vec<DirectoryEntry>, Error> {
    let normalized = nfc_leaf_name(leaf);
    // The result holds only NFC-equivalent names, so the listing cap protects nothing here
    // (Windows still reads the names into a transient Vec before filtering).
    read_directory_entries_at(directory, cancellation, None, &mut |name| {
        nfc_leaf_name(name) == normalized
    })
}

/// Keep the selected native spelling and all later identity checks on the same existing file.
fn pgn_export_equivalent_path(parent: &fs::File, path: &Path) -> Result<PathBuf, Error> {
    let leaf = path
        .file_name()
        .ok_or_else(|| Error::InvalidInput("PGN export destination needs a filename".into()))?;
    let mut siblings = equivalent_sibling_leaves(parent, leaf, &CancellationToken::new())?;
    if siblings.len() > 1 {
        return Err(Error::Conflict(
            "PGN export filename already exists in multiple Unicode forms".into(),
        ));
    }
    Ok(match siblings.pop() {
        Some(entry) => path.with_file_name(entry.name),
        None => path.to_path_buf(),
    })
}

pub(crate) fn workspace_sidecar_leaf(leaf: &OsStr) -> Result<OsString, Error> {
    let stem = Path::new(leaf)
        .file_stem()
        .ok_or_else(|| Error::InvalidInput("PGN has no filename".into()))?;
    Ok(OsString::from(format!("{}.info", stem.to_string_lossy())))
}

#[cfg(target_os = "macos")]
type LaunchRootArgument = Option<EngineLaunchRoot>;
#[cfg(not(target_os = "macos"))]
type LaunchRootArgument = ();

impl PathAuthority {
    fn directory_listing_snapshot(
        &self,
        root: &PathRef,
        purposes: &[EntryPurpose],
        recursive: bool,
        excluded_prefix: Option<&OsStr>,
    ) -> Result<DirectoryListingSnapshot, Error> {
        let root_path = self
            .persistent
            .get(&root.id)
            .ok_or_else(|| Error::Conflict("listing root is not persistent".into()))?
            .stored
            .path
            .to_path()?;
        let excluded = excluded_prefix.map(|prefix| root_path.join(prefix));
        let mut entries = Vec::new();
        for entry in self.persistent.values() {
            if !entry
                .stored
                .purpose
                .is_some_and(|purpose| purposes.contains(&purpose))
            {
                continue;
            }
            let path = entry.stored.path.to_path()?;
            let child = if recursive {
                path != root_path && path.starts_with(&root_path)
            } else {
                path.parent() == Some(root_path.as_path())
            };
            if child
                && !excluded
                    .as_ref()
                    .is_some_and(|prefix| path.starts_with(prefix))
            {
                entries.push(entry.stored.clone());
            }
        }
        Ok(DirectoryListingSnapshot {
            root: root_path,
            entries,
        })
    }

    pub(crate) fn workspace_listing_snapshot(
        &self,
        workspace: &FileWorkspaceHandle,
        trash_prefix: &OsStr,
    ) -> Result<DirectoryListingSnapshot, Error> {
        self.directory_listing_snapshot(
            workspace.path_ref(),
            &[EntryPurpose::PgnFile, EntryPurpose::PgnWorkspace],
            true,
            Some(trash_prefix),
        )
    }

    pub(crate) fn trash_listing_snapshot(
        &self,
        workspace: &FileWorkspaceHandle,
        trash_prefix: &OsStr,
    ) -> Result<DirectoryListingSnapshot, Error> {
        let mut snapshot = self.directory_listing_snapshot(
            workspace.path_ref(),
            &[EntryPurpose::PgnFile, EntryPurpose::PgnWorkspace],
            true,
            None,
        )?;
        let prefix = snapshot.root.join(trash_prefix);
        snapshot.entries.retain(|entry| {
            entry
                .path
                .to_path()
                .is_ok_and(|path| path.starts_with(&prefix))
        });
        Ok(snapshot)
    }

    pub(crate) fn retained_listing_records(
        snapshot: &DirectoryListingSnapshot,
        cancellation: &CancellationToken,
    ) -> Result<BTreeSet<String>, Error> {
        let mut retained = BTreeSet::new();
        for recorded in &snapshot.entries {
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            let shape = if recorded.target_is_dir {
                AcquireShape::Root {
                    parent_access: ParentAccess::Readable,
                }
            } else {
                AcquireShape::File {
                    parent_access: ParentAccess::Readable,
                }
            };
            let retain = match acquire_stored_target(recorded, shape, "trash entry changed") {
                Ok(_) => true,
                Err(error) => {
                    !matches!(
                        classify_probe_error_kind(&error),
                        ProbeErrorClass::NotFound
                            | ProbeErrorClass::Reparse
                            | ProbeErrorClass::WrongKind
                    ) && !matches!(error, Error::Conflict(_) | Error::InvalidInput(_))
                }
            };
            if retain {
                retained.insert(recorded.id.id.clone());
            }
        }
        Ok(retained)
    }

    fn listing_candidate(
        &self,
        snapshot: &DirectoryListingSnapshot,
        prepared: &[PreparedEntry],
        retained: &BTreeSet<String>,
    ) -> BTreeMap<String, Entry> {
        let reused: BTreeSet<_> = prepared
            .iter()
            .filter(|entry| entry.reused)
            .map(|entry| entry.stored.id.id.as_str())
            .collect();
        // Clone at commit time, preserving registrations made during the unlocked walk.
        let mut candidate = self.persistent.clone();
        let mut removed = Vec::new();
        for recorded in &snapshot.entries {
            if !reused.contains(recorded.id.id.as_str())
                && !retained.contains(&recorded.id.id)
                && candidate.get(&recorded.id.id).is_some_and(|current| {
                    current.stored.path == recorded.path
                        && current.stored.identity == recorded.identity
                        && current.stored.purpose == recorded.purpose
                })
            {
                if let Some(entry) = candidate.remove(&recorded.id.id) {
                    removed.push(entry.stored);
                }
            }
        }
        let inherited = inherit_listing_practice_keys(&removed, prepared);
        for entry in prepared {
            let mut stored = entry.stored.clone();
            if let Some(key) = inherited.get(&stored.id.id) {
                stored.practice_key = Some(key.clone());
            }
            candidate.insert(
                stored.id.id.clone(),
                Entry {
                    stored,
                    availability: PathAvailability::Available,
                },
            );
        }
        candidate
    }

    pub(crate) fn commit_directory_listing(
        &mut self,
        snapshot: DirectoryListingSnapshot,
        prepared: Vec<PreparedEntry>,
        retained: &BTreeSet<String>,
        cancellation: &CancellationToken,
    ) -> Result<(), Error> {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let candidate = self.listing_candidate(&snapshot, &prepared, retained);
        let admission = |entries: &BTreeMap<String, Entry>| {
            self.registry_admission_snapshot(
                entries,
                &self.active_database_root,
                &self.active_puzzle_root,
                &self.active_engine_root,
                &self.pending_artifacts,
                &self.provisional_attachments,
                &self.retired_attachments,
                &self.image_cleanup,
            )
        };
        Self::check_registry_growth(&admission(&candidate)?, &admission(&self.persistent)?)?;
        // Only existing identities may publish canonical operations before the snapshot commit.
        for entry in prepared.iter().filter(|entry| entry.reused) {
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            let commit = self.publish_prepared_entry(PreparedEntry {
                stored: entry.stored.clone(),
                reused: true,
            })?;
            require_durable(commit.durability)?;
        }
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let candidate = self.listing_candidate(&snapshot, &prepared, retained);
        let durability = if candidate != self.persistent {
            self.commit_candidate(candidate, None)?
        } else {
            CommitDurability::Durable
        };
        for entry in prepared {
            self.session_protected_ids.insert(entry.stored.id.id);
        }
        require_durable(durability)
    }

    #[cfg(all(test, unix))]
    pub(crate) fn persistent_snapshot_for_test(&self) -> Vec<(String, (u64, u64), bool)> {
        let mut snapshot = self
            .persistent
            .values()
            .map(|entry| {
                (
                    entry.stored.display_name.clone(),
                    (entry.stored.identity.a, entry.stored.identity.b),
                    entry.stored.target_is_dir,
                )
            })
            .collect::<Vec<_>>();
        snapshot.sort();
        snapshot
    }

    /// Resolves an authorized directory for descriptor-relative enumeration. Database and puzzle
    /// listings share the same retained-directory walk as the PGN workspace listing.
    pub(crate) fn capability_directory(
        &mut self,
        id: &PathRef,
        operation: PathOperation,
    ) -> Result<CapabilityDirectory, Error> {
        let mut resolved = self.resolve(id, operation, &[])?;
        let directory = resolved
            .take_directory()
            .ok_or_else(|| Error::InvalidInput("path capability is not a directory".into()))?;
        Ok(CapabilityDirectory { directory })
    }

    /// Keep the install operation's admission, but request only read/search access.
    /// Unlike resolve, diagnosis neither records catalog use nor protects a session entry.
    fn engine_probe_directory(
        &self,
        id: &PathRef,
        operation: PathOperation,
    ) -> Result<Option<CapabilityDirectory>, Error> {
        if self.pending_unpersisted_removals.contains(&id.id) {
            return Ok(None);
        }
        let Some(entry) = self.persistent.get(&id.id) else {
            return Ok(None);
        };
        if !is_engine_root_use(&entry.stored, operation) {
            return Ok(None);
        }
        engine_read_search_directory(&entry.stored).map(Some)
    }

    /// Windows counterpart of the unix arm below, keeping its split exactly: an **existing**
    /// regular file is identity-checked and its bytes are left untouched, and only a **missing**
    /// one is created exclusively. It deliberately does not route through
    /// `atomic_replace_at_identified` — the unix arm does not either, and replacing here would
    /// destroy the very file the caller selected, before a single game had been written.
    #[cfg(windows)]
    pub(crate) fn create_pgn_export_destination(
        &mut self,
        path: &Path,
        display_name: impl Into<String>,
    ) -> Result<FileWorkspaceDescriptor, Error> {
        if matches!(
            path.as_os_str().as_encoded_bytes().last(),
            Some(b'/') | Some(b'\\')
        ) {
            return Err(Error::InvalidInput(
                "PGN export destination must have a .pgn filename".into(),
            ));
        }
        let extension_is_pgn = path
            .extension()
            .and_then(OsStr::to_str)
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pgn"));
        if !extension_is_pgn || path.file_stem().is_none_or(|stem| stem.is_empty()) {
            return Err(Error::InvalidInput(
                "PGN export destination must have a .pgn filename".into(),
            ));
        }

        // The parent observed here is the one the identity check below pins the canonicalized
        // open against, so a swap between the two is a `Conflict` rather than a create in a
        // directory the caller never chose. Canonicalization on its own is not that pin.
        let parent_probe = open_windows_nofollow(parent_of(path), false)?;
        if !parent_probe.metadata()?.is_dir() {
            return Err(Error::InvalidInput(
                "PGN export destination parent must be a directory".into(),
            ));
        }
        let parent_identity = opened_file_identity(&parent_probe)?;
        drop(parent_probe);
        #[cfg(test)]
        ACQUIRE_TARGET_BEFORE_PROOF_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        let canonical = canonical_binding(path)?;
        // A0: the parent is opened writable, because the create below flushes it.
        let parent = crate::infra::fs::open_parent_no_follow(&canonical)?;
        if opened_file_identity(&parent)? != parent_identity {
            return Err(Error::Conflict(
                "PGN export destination changed before creation".into(),
            ));
        }
        let canonical = pgn_export_equivalent_path(&parent, &canonical)?;
        let leaf = canonical
            .file_name()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                Error::InvalidInput("PGN export destination must have a .pgn filename".into())
            })?
            .to_os_string();

        let mut created_identity = None;
        let display_name = display_name.into();
        let operations = canonical_operations(EntryPurpose::PgnFile);
        let result = (|| {
            let identity = match crate::infra::fs::entry_identity_at(&parent, &leaf, false) {
                Ok(identity) => identity,
                Err(error) if error.is_missing_entry() => {
                    let (file, identity) = crate::infra::fs::create_regular_at(&parent, &leaf)?;
                    created_identity = Some(identity);
                    file.sync_all()?;
                    parent.sync_all()?;
                    #[cfg(test)]
                    PGN_EXPORT_POST_CREATE_HOOK.with(|slot| {
                        if let Some(hook) = slot.borrow_mut().take() {
                            hook();
                        }
                    });
                    identity
                }
                Err(Error::InvalidInput(_)) => {
                    return Err(Error::InvalidInput(
                        "PGN export destination must be a regular file".into(),
                    ))
                }
                Err(error) => return Err(error),
            };
            let grant = self.grant_acquired(
                AcquiredTarget {
                    path: canonical.clone(),
                    identity: Identity {
                        a: identity.0,
                        b: identity.1,
                    },
                    parent_identity: Some(Identity {
                        a: parent_identity.0,
                        b: parent_identity.1,
                    }),
                    target_is_dir: false,
                    parent_and_leaf: None,
                },
                display_name.clone(),
                PathClass::BoundedDialogGrant,
                operations.clone(),
                PGN_FILE_DIALOG_GRANT_TTL,
                PGN_FILE_DIALOG_GRANT_USES,
            )?;
            let commit = self.promote_dialog(
                &grant,
                PathClass::PersistentFile,
                display_name.clone(),
                operations,
            )?;
            require_durable(commit.durability)?;
            Ok(FileWorkspaceDescriptor {
                handle: FileWorkspaceHandle::new(commit.id),
                display_name,
                availability: PathAvailability::Available,
            })
        })();

        match result {
            Err(primary) if !matches!(primary, Error::CommittedDurabilityUncertain(_)) => {
                match created_identity {
                    Some(identity) => Err(pgn_export_error_after_cleanup(
                        primary,
                        crate::infra::fs::remove_entry_at(&parent, &leaf, identity, false),
                        &leaf,
                    )),
                    None => Err(primary),
                }
            }
            other => other,
        }
    }

    /// Turns a native save-dialog choice into one persistent, exact PGN destination. The renderer
    /// receives only the resulting workspace handle; the selected native path never leaves this
    /// authority boundary. A new target is materialized before the dialog grant is promoted so
    /// the persisted identity is the object the subsequent atomic PGN write must replace.
    #[cfg(unix)]
    pub(crate) fn create_pgn_export_destination(
        &mut self,
        path: &Path,
        display_name: impl Into<String>,
    ) -> Result<FileWorkspaceDescriptor, Error> {
        use rustix::fs::{self as rfs, AtFlags, FileType};
        use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};

        if path.as_os_str().as_bytes().last() == Some(&b'/') {
            return Err(Error::InvalidInput(
                "PGN export destination must have a .pgn filename".into(),
            ));
        }
        let extension_is_pgn = path
            .extension()
            .and_then(OsStr::to_str)
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pgn"));
        if !extension_is_pgn || path.file_stem().is_none_or(|stem| stem.is_empty()) {
            return Err(Error::InvalidInput(
                "PGN export destination must have a .pgn filename".into(),
            ));
        }

        let parent_path = parent_of(path);
        let parent_metadata = fs::metadata(parent_path)?;
        if !parent_metadata.is_dir() {
            return Err(Error::InvalidInput(
                "PGN export destination parent must be a directory".into(),
            ));
        }
        let parent_identity = (parent_metadata.dev(), parent_metadata.ino());
        #[cfg(test)]
        ACQUIRE_TARGET_BEFORE_PROOF_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        let canonical = canonical_binding(path)?;
        let parent = crate::infra::fs::open_parent_no_follow(&canonical)?;
        if opened_file_identity(&parent)? != parent_identity {
            return Err(Error::Conflict(
                "PGN export destination changed before creation".into(),
            ));
        }
        let canonical = pgn_export_equivalent_path(&parent, &canonical)?;
        let leaf = canonical
            .file_name()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                Error::InvalidInput("PGN export destination must have a .pgn filename".into())
            })?
            .to_os_string();

        let mut created_identity = None;
        let display_name = display_name.into();
        let operations = canonical_operations(EntryPurpose::PgnFile);
        let result = (|| {
            let identity = match rfs::statat(&parent, &leaf, AtFlags::SYMLINK_NOFOLLOW) {
                Ok(stat) => {
                    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
                        return Err(Error::InvalidInput(
                            "PGN export destination must be a regular file".into(),
                        ));
                    }
                    crate::infra::fs::raw_stat_identity(&stat)
                }
                Err(error) if error == rustix::io::Errno::NOENT => {
                    let (file, identity) = crate::infra::fs::create_regular_at(&parent, &leaf)?;
                    created_identity = Some(identity);
                    file.sync_all()?;
                    parent.sync_all()?;
                    #[cfg(test)]
                    PGN_EXPORT_POST_CREATE_HOOK.with(|slot| {
                        if let Some(hook) = slot.borrow_mut().take() {
                            hook();
                        }
                    });
                    identity
                }
                Err(error) => return Err(Error::Io(Box::new(error.into()))),
            };
            let grant = self.grant_acquired(
                AcquiredTarget {
                    path: canonical.clone(),
                    identity: Identity {
                        a: identity.0,
                        b: identity.1,
                    },
                    parent_identity: Some(Identity {
                        a: parent_identity.0,
                        b: parent_identity.1,
                    }),
                    target_is_dir: false,
                    parent_and_leaf: None,
                },
                display_name.clone(),
                PathClass::BoundedDialogGrant,
                operations.clone(),
                PGN_FILE_DIALOG_GRANT_TTL,
                PGN_FILE_DIALOG_GRANT_USES,
            )?;
            let commit = self.promote_dialog(
                &grant,
                PathClass::PersistentFile,
                display_name.clone(),
                operations,
            )?;
            require_durable(commit.durability)?;
            Ok(FileWorkspaceDescriptor {
                handle: FileWorkspaceHandle::new(commit.id),
                display_name,
                availability: PathAvailability::Available,
            })
        })();

        match result {
            Err(primary) if !matches!(primary, Error::CommittedDurabilityUncertain(_)) => {
                match created_identity {
                    Some(identity) => Err(pgn_export_error_after_cleanup(
                        primary,
                        crate::infra::fs::remove_entry_at(&parent, &leaf, identity, false),
                        &leaf,
                    )),
                    None => Err(primary),
                }
            }
            other => other,
        }
    }

    #[cfg(any(test, not(target_os = "macos")))]
    pub fn open(registry_path: PathBuf, app_roots: Vec<AppOwnedRoot>) -> Result<Self, Error> {
        Self::open_with_clock(
            registry_path,
            app_roots,
            Arc::new(SystemClock),
            DEFAULT_DIALOG_CAPACITY,
        )
    }

    /// Opens the engine-test authority with the platform's launch root.
    #[cfg(test)]
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn open_for_engine_test(directory: &Path) -> Result<Self, Error> {
        #[cfg(target_os = "macos")]
        {
            Self::open_with_launch_root(
                directory.join("registry.json"),
                Vec::new(),
                EngineLaunchRoot::for_test(directory)?,
            )
        }
        #[cfg(not(target_os = "macos"))]
        {
            Self::open(directory.join("registry.json"), Vec::new())
        }
    }

    /// The production entry point, so startup does not assemble a clock and a capacity at the
    /// call site.
    pub(crate) fn open_for_app(
        registry_path: PathBuf,
        app_roots: Vec<AppOwnedRoot>,
        launch_root: LaunchRootArgument,
    ) -> Result<Self, Error> {
        Self::open_with_launch_root_argument(
            registry_path,
            app_roots,
            Arc::new(SystemClock),
            DEFAULT_DIALOG_CAPACITY,
            launch_root,
        )
    }

    /// Test-only since the startup branches moved to `open_for_app`: its remaining callers
    /// are the macOS engine-launch tests, so it is gated on them rather than carrying
    /// `allow(dead_code)` into the shipped binary.
    #[cfg(all(test, target_os = "macos"))]
    pub(crate) fn open_with_launch_root(
        registry_path: PathBuf,
        app_roots: Vec<AppOwnedRoot>,
        launch_root: EngineLaunchRoot,
    ) -> Result<Self, Error> {
        Self::open_with_launch_root_argument(
            registry_path,
            app_roots,
            Arc::new(SystemClock),
            DEFAULT_DIALOG_CAPACITY,
            Some(launch_root),
        )
    }

    #[cfg(any(test, not(target_os = "macos")))]
    pub fn open_with_clock(
        registry_path: PathBuf,
        app_roots: Vec<AppOwnedRoot>,
        clock: Arc<dyn Clock>,
        dialog_capacity: usize,
    ) -> Result<Self, Error> {
        Self::open_with_launch_root_argument(
            registry_path,
            app_roots,
            clock,
            dialog_capacity,
            #[cfg(target_os = "macos")]
            None,
            #[cfg(not(target_os = "macos"))]
            (),
        )
    }

    pub(crate) fn open_with_launch_root_argument(
        registry_path: PathBuf,
        app_roots: Vec<AppOwnedRoot>,
        clock: Arc<dyn Clock>,
        dialog_capacity: usize,
        _launch_root: LaunchRootArgument,
    ) -> Result<Self, Error> {
        if dialog_capacity == 0 {
            return Err(Error::InvalidInput(
                "dialog capacity must be at least one".into(),
            ));
        }
        let (
            mut persistent,
            active_database_root,
            active_puzzle_root,
            active_engine_root,
            pending_artifacts,
            provisional_attachments,
            image_cleanup,
            catalog_installs,
            catalog_uses,
        ) = if registry_path.exists() {
            let file = fs::File::open(&registry_path)?;
            let bytes = read_registry_bytes(file)?;
            let registry: Registry = serde_json::from_slice(&bytes)
                .map_err(|e| Error::InvalidInput(format!("invalid path registry: {e}")))?;
            if registry.schema_version != SCHEMA_VERSION {
                return Err(Error::InvalidInput(format!(
                    "unsupported path registry schema {}",
                    registry.schema_version
                )));
            }
            let image_cleanup_records = registry.image_cleanup;
            catalog_install::validate_records(&registry.catalog_installs)?;
            let catalog_uses = catalog_install::decode_uses(registry.catalog_uses)?;
            let provisional_attachments = registry.provisional_attachments.clone();
            let mut loaded = BTreeMap::new();
            for mut stored in registry.entries {
                validate_persisted_shape(&stored)?;
                let needs_purpose_backfill = stored.purpose.is_none();
                let legacy_engine_file_operations = [
                    PathOperation::EngineExecute,
                    PathOperation::EngineConfigure,
                    PathOperation::EngineInstall,
                ];
                if stored.class == PathClass::PersistentFile
                    && same_operation_set(&stored.operations, &legacy_engine_file_operations)
                {
                    // This exact, class-restricted backfill is idempotent, so the registry schema
                    // does not need to change. Engine roots are PersistentCustomRoot and must keep
                    // their exact operation vector for stable reuse across restarts.
                    stored.operations.push(PathOperation::EngineBinaryInspect);
                }
                if needs_purpose_backfill {
                    stored.purpose =
                        purpose_for_shape(stored.class, stored.target_is_dir, &stored.operations);
                }
                if needs_purpose_backfill {
                    if let Some(purpose) = stored.purpose {
                        stored.operations = canonical_operations(purpose);
                    }
                } else if stored.purpose == Some(EntryPurpose::EngineExecutable)
                    && same_operation_set(
                        &stored.operations,
                        &[
                            PathOperation::EngineExecute,
                            PathOperation::EngineConfigure,
                            PathOperation::EngineInstall,
                            PathOperation::EngineBinaryInspect,
                        ],
                    )
                {
                    // Explicitly tagged registries written during the engine-inspection
                    // transition may contain the historical install bit. Treat it as recognized
                    // history, but leave other purpose-tagged subsets for their issuer to upgrade.
                    stored.operations = canonical_operations(EntryPurpose::EngineExecutable);
                }
                let mut entry = Entry {
                    stored,
                    availability: PathAvailability::Unavailable,
                };
                refresh_entry(&mut entry);
                if loaded.insert(entry.stored.id.id.clone(), entry).is_some() {
                    return Err(Error::InvalidInput(
                        "duplicate path registry identifier".into(),
                    ));
                }
            }
            validate_loaded_attachment_metadata(
                &loaded,
                &provisional_attachments,
                &image_cleanup_records,
            )?;
            let image_cleanup = image_cleanup_records
                .into_iter()
                .map(|stored| (stored.id.id.clone(), stored))
                .collect();
            let active = registry.active_database_root.filter(|id| {
                loaded.get(&id.id).is_some_and(|entry| {
                    entry.stored.target_is_dir
                        && entry
                            .stored
                            .operations
                            .contains(&PathOperation::DatabaseRead)
                })
            });
            let active_puzzle_root = registry.active_puzzle_root.filter(|id| {
                loaded.get(&id.id).is_some_and(|entry| {
                    entry.stored.target_is_dir
                        && entry.stored.operations.contains(&PathOperation::PuzzleRead)
                })
            });
            let active_engine_root = registry.active_engine_root.filter(|id| {
                loaded.get(&id.id).is_some_and(|entry| {
                    entry.stored.target_is_dir
                        && entry
                            .stored
                            .operations
                            .contains(&PathOperation::EngineInstall)
                })
            });
            (
                loaded,
                active,
                active_puzzle_root,
                active_engine_root,
                registry.pending_artifacts,
                provisional_attachments,
                image_cleanup,
                registry.catalog_installs,
                catalog_uses,
            )
        } else {
            (
                BTreeMap::new(),
                None,
                None,
                None,
                Vec::new(),
                BTreeSet::new(),
                BTreeMap::new(),
                BTreeMap::new(),
                BTreeMap::new(),
            )
        };
        let loaded_candidate_ids = persistent.keys().cloned().collect();
        for root in app_roots {
            fs::create_dir_all(&root.path)?;
            let stored = StoredEntry {
                id: root.id.clone(),
                display_name: root.display_name,
                class: PathClass::AppOwnedRoot,
                purpose: None,
                operations: root.operations,
                path: NativePath::from_path(&root.path),
                identity: validate_target(&root.path, PathClass::AppOwnedRoot)?,
                parent_identity: None,
                target_is_dir: true,
                practice_key: None,
            };
            persistent.insert(
                stored.id.id.clone(),
                Entry {
                    stored,
                    availability: PathAvailability::Available,
                },
            );
        }
        let mut authority = Self {
            registry_path,
            persistent,
            dialogs: HashMap::new(),
            clock,
            dialog_capacity,
            next_insertion: 0,
            active_database_root,
            active_puzzle_root,
            active_engine_root,
            pending_artifacts,
            pending_unpersisted_removals: BTreeSet::new(),
            loaded_candidate_ids,
            session_protected_ids: BTreeSet::new(),
            completion_resources: BTreeMap::new(),
            completed_owner_families: BTreeSet::new(),
            startup_retained_ids: BTreeSet::new(),
            startup_unowned_roots_reconciled: false,
            provisional_attachments,
            retired_attachments: BTreeMap::new(),
            image_cleanup,
            catalog_installs,
            catalog_session: Uuid::new_v4().to_string(),
            catalog_protected: BTreeSet::new(),
            catalog_uses,
            attachments_sealed: false,
            registry_durability_pending: false,
            active_image_issuances: Arc::new(ActiveImageIssuances::new()),
            engine_image_sweep_root: None,
            #[cfg(test)]
            activation_observer: None,
            #[cfg(target_os = "macos")]
            engine_launch_root: _launch_root,
        };
        // Recovery validates pending roots by their stored spelling; repair legacy spellings
        // before it runs so a recovered artifact sees the same canonical root as the registry.
        authority.rebind_legacy_spellings_and_parent_identities();
        authority.recover_pending_artifacts()?;
        Ok(authority)
    }

    fn rebind_legacy_spellings_and_parent_identities(&mut self) {
        let ids: Vec<_> = self.persistent.keys().cloned().collect();
        let mut rebound_ids = Vec::new();

        for id in ids {
            let Some(entry) = self.persistent.get_mut(&id) else {
                continue;
            };
            if entry.stored.class == PathClass::AppOwnedRoot {
                continue;
            }
            let path = match entry.stored.path.to_path() {
                Ok(path) => path,
                Err(error) => {
                    entry.availability = PathAvailability::Unavailable;
                    log::warn!(
                        "legacy path rebinding skipped for entry {}: {}",
                        entry.stored.id.id,
                        error.category()
                    );
                    continue;
                }
            };
            let needs_parent_upgrade = !entry.stored.target_is_dir
                && has_normal_leaf(&path)
                && entry.stored.parent_identity.is_none();
            let spelling_needs_rebinding = match classify_canonical_binding(&path) {
                CanonicalBindingStatus::Canonical if !needs_parent_upgrade => continue,
                CanonicalBindingStatus::Leafless => continue,
                CanonicalBindingStatus::Canonical => false,
                CanonicalBindingStatus::NeedsRebinding => true,
                CanonicalBindingStatus::Failed(error) => {
                    entry.availability = PathAvailability::Unavailable;
                    log::warn!(
                        "legacy path rebinding skipped for entry {} at {:?}: {}",
                        entry.stored.id.id,
                        path,
                        error.category()
                    );
                    continue;
                }
            };
            let shape = AcquireShape::for_persistent_class(
                entry.stored.class,
                parent_access_for_operations(&entry.stored.operations),
            );
            let acquired = match acquire_target(&path, shape) {
                Ok(acquired) => acquired,
                Err(error) => {
                    entry.availability = PathAvailability::Unavailable;
                    log::warn!(
                        "legacy {} skipped for entry {} at {:?}: {}",
                        if spelling_needs_rebinding {
                            "path rebinding"
                        } else {
                            "parent identity upgrade"
                        },
                        entry.stored.id.id,
                        path,
                        error.category()
                    );
                    continue;
                }
            };
            if acquired.identity != entry.stored.identity {
                entry.availability = PathAvailability::Unavailable;
                log::warn!(
                    "legacy path rebinding skipped for entry {} at {:?}: identity changed",
                    entry.stored.id.id,
                    path
                );
                continue;
            }
            if let Some(expected_parent) = entry.stored.parent_identity.as_ref() {
                if acquired.parent_identity.as_ref() != Some(expected_parent) {
                    entry.availability = PathAvailability::Unavailable;
                    log::warn!(
                        "legacy path rebinding skipped for entry {} at {:?}: parent identity changed",
                        entry.stored.id.id,
                        path
                    );
                    continue;
                }
            } else if needs_parent_upgrade {
                let Some(parent_identity) = acquired.parent_identity.clone() else {
                    entry.availability = PathAvailability::Unavailable;
                    log::warn!(
                        "legacy parent identity upgrade skipped for entry {} at {:?}: parent is unavailable",
                        entry.stored.id.id,
                        path
                    );
                    continue;
                };
                entry.stored.parent_identity = Some(parent_identity);
            }
            entry.stored.path = NativePath::from_path(&acquired.path);
            entry.availability = PathAvailability::Available;
            rebound_ids.push(id);
        }

        if rebound_ids.is_empty() {
            return;
        }
        let durability = self.commit_registry(
            self.persistent.clone(),
            self.active_database_root.clone(),
            self.active_puzzle_root.clone(),
            self.active_engine_root.clone(),
            self.pending_artifacts.clone(),
            None,
            true,
        );
        if let Err(error) = durability {
            log::warn!(
                "legacy path rebinding could not be persisted for entries {:?}: {}",
                rebound_ids,
                error.category()
            );
        }
    }

    #[cfg(test)]
    pub(crate) fn set_activation_observer(
        &mut self,
        observer: Option<Arc<dyn ActivationObserver + Send + Sync>>,
    ) {
        self.activation_observer = observer;
    }
    pub(crate) fn has_persistent_id(&self, id: &str) -> bool {
        self.persistent.contains_key(id)
    }
    /// Grants `path` through a one-use bounded dialog grant and promotes it to a persistent file,
    /// the two-step route a user's dialog selection takes.
    #[cfg(test)]
    pub(crate) fn grant_persistent_file_for_test(
        &mut self,
        path: &Path,
        display_name: &str,
        operations: Vec<PathOperation>,
    ) -> PathCommit {
        let grant = self
            .grant_dialog_operations(
                path,
                display_name,
                PathClass::BoundedDialogGrant,
                operations.clone(),
                Duration::from_secs(30),
                1,
            )
            .expect("test dialog grant");
        self.promote_dialog(&grant, PathClass::PersistentFile, display_name, operations)
            .expect("test grant promotion")
    }
    #[cfg(test)]
    pub(crate) fn parent_identity_for_test(&self, id: &PathRef) -> Option<(u64, u64)> {
        let parent = self
            .persistent
            .get(&id.id)?
            .stored
            .parent_identity
            .as_ref()?;
        Some((parent.a, parent.b))
    }
    #[cfg(test)]
    pub(crate) fn has_pending_artifact_filename(&self, filename: &std::path::Path) -> bool {
        self.pending_artifacts
            .iter()
            .any(|p| p.filename.to_path().is_ok_and(|path| path == filename))
    }
    #[cfg(test)]
    pub fn descriptors(&mut self) -> Vec<PathDescriptor> {
        self.evict_dialogs();
        self.refresh_persistent();
        for grant in self.dialogs.values_mut() {
            refresh_entry(&mut grant.entry);
        }
        self.persistent
            .values()
            .map(|e| descriptor(&e.stored, e.availability))
            .chain(
                self.dialogs
                    .values()
                    .map(|g| descriptor(&g.entry.stored, g.entry.availability)),
            )
            .collect()
    }

    /// Recovery authorizes only the exact content bound before publication. A missing, changed,
    /// legacy-unbound, or conflicting target remains quarantined as intent; it is never inferred
    /// from a baseline inode difference and commits are never retried.
    fn recover_pending_artifacts(&mut self) -> Result<(), Error> {
        let reservations: Vec<_> = self
            .pending_artifacts
            .iter()
            .map(|pending| PendingArtifactReservation {
                id: pending.id.clone(),
                payload_size: pending.payload_size,
                payload_sha256: pending.payload_sha256.clone(),
            })
            .collect();
        for reservation in reservations {
            let Some(pending) = self
                .pending_artifacts
                .iter()
                .find(|pending| pending.id == reservation.id)
                .cloned()
            else {
                continue;
            };
            let Some(root) = self.persistent.get(&pending.root.id) else {
                continue;
            };
            let root_path = match root.stored.path.to_path() {
                Ok(path) => path,
                Err(error) => {
                    log::warn!(
                        "pending artifact recovery skipped for root {}: {}",
                        root.stored.id.id,
                        error.category()
                    );
                    continue;
                }
            };
            let Ok(root_identity) = validate_target(&root_path, PathClass::PersistentCustomRoot)
            else {
                continue;
            };
            if !pending.payload_bound
                || pending.installed_identity.is_none()
                || pending.root_identity.as_ref() != Some(&root_identity)
            {
                continue;
            }
            // Activation resolves and hashes the no-follow opened file descriptor itself. A
            // mismatch is an expected quarantined state during restart, not an open failure.
            if let Err(error) = self.activate_download_artifact(&reservation) {
                let category = error.category();
                let reservation_id = &reservation.id.id;
                log::warn!(
                    "pending artifact recovery skipped for reservation {reservation_id}: {category}"
                );
            }
        }
        Ok(())
    }
    pub fn grant_dialog(
        &mut self,
        path: &Path,
        display_name: impl Into<String>,
        class: PathClass,
        operation: PathOperation,
        ttl: Duration,
        uses_left: u32,
    ) -> Result<PathRef, Error> {
        self.grant_dialog_operations(path, display_name, class, vec![operation], ttl, uses_left)
    }

    fn check_dialog_grant_shape(
        class: PathClass,
        operations: &[PathOperation],
        uses_left: u32,
    ) -> Result<(), Error> {
        if !matches!(
            class,
            PathClass::SingleDialogGrant | PathClass::BoundedDialogGrant
        ) || (class == PathClass::SingleDialogGrant && uses_left != 1)
            || (class == PathClass::BoundedDialogGrant && uses_left == 0)
            || operations.is_empty()
        {
            return Err(Error::InvalidInput("invalid dialog grant shape".into()));
        }
        Ok(())
    }

    fn grant_acquired(
        &mut self,
        acquired: AcquiredTarget,
        display_name: String,
        class: PathClass,
        operations: Vec<PathOperation>,
        ttl: Duration,
        uses_left: u32,
    ) -> Result<PathRef, Error> {
        Self::check_dialog_grant_shape(class, &operations, uses_left)?;
        // Validate before evicting: malformed dialog input must not affect live grants.
        self.evict_dialogs();
        if self.dialogs.len() >= self.dialog_capacity {
            if let Some(oldest) = self
                .dialogs
                .iter()
                .min_by_key(|(_, g)| g.inserted_at)
                .map(|(id, _)| id.clone())
            {
                self.dialogs.remove(&oldest);
            }
        }
        let id = PathRef::fresh();
        self.next_insertion += 1;
        let stored = StoredEntry {
            id: id.clone(),
            display_name,
            class,
            purpose: None,
            operations,
            path: NativePath::from_path(&acquired.path),
            identity: acquired.identity,
            parent_identity: acquired.parent_identity,
            target_is_dir: acquired.target_is_dir,
            practice_key: None,
        };
        self.dialogs.insert(
            id.id.clone(),
            DialogGrant {
                entry: Entry {
                    stored,
                    availability: PathAvailability::Available,
                },
                expires_at: self.clock.now() + ttl,
                uses_left,
                inserted_at: self.next_insertion,
            },
        );
        Ok(id)
    }

    pub fn grant_dialog_operations(
        &mut self,
        path: &Path,
        display_name: impl Into<String>,
        class: PathClass,
        operations: Vec<PathOperation>,
        ttl: Duration,
        uses_left: u32,
    ) -> Result<PathRef, Error> {
        Self::check_dialog_grant_shape(class, &operations, uses_left)?;
        let acquired = acquire_target(
            path,
            AcquireShape::Dialog {
                parent_access: parent_access_for_operations(&operations),
            },
        )?;
        self.grant_acquired(
            acquired,
            display_name.into(),
            class,
            operations,
            ttl,
            uses_left,
        )
    }
    /// Consumes an exact live dialog grant and persists the same native object as a root or file.
    pub fn promote_dialog(
        &mut self,
        dialog: &PathRef,
        persistent_class: PathClass,
        display_name: impl Into<String>,
        operations: Vec<PathOperation>,
    ) -> Result<PathCommit, Error> {
        if !matches!(
            persistent_class,
            PathClass::PersistentCustomRoot | PathClass::PersistentFile
        ) {
            return Err(Error::InvalidInput(
                "promotion target must be persistent".into(),
            ));
        }
        if operations.is_empty() {
            return Err(Error::InvalidInput(
                "persistent operations cannot be empty".into(),
            ));
        }
        let target_is_dir = persistent_class == PathClass::PersistentCustomRoot;
        let purpose = purpose_for_shape(persistent_class, target_is_dir, &operations);
        if self.attachments_sealed && is_attachment_purpose(purpose) {
            return Err(Error::Conflict(
                "engine attachment mutations are sealed".into(),
            ));
        }
        let grant = self.dialogs.get(&dialog.id).cloned().ok_or_else(|| {
            Error::InvalidInput("unknown, revoked, or expired dialog grant".into())
        })?;
        self.dialogs.remove(&dialog.id);
        if grant.expires_at <= self.clock.now() {
            return Err(Error::InvalidInput(
                "unknown, revoked, or expired dialog grant".into(),
            ));
        }
        if operations
            .iter()
            .any(|op| !grant.entry.stored.operations.contains(op))
        {
            return Err(Error::InvalidInput(
                "promotion cannot escalate dialog operation authority".into(),
            ));
        }
        let path = grant.entry.stored.path.to_path()?;
        let shape = AcquireShape::for_persistent_class(
            persistent_class,
            parent_access_for_operations(&operations),
        );
        let acquired = acquire_target(&path, shape)?;
        #[cfg(test)]
        PROMOTE_DIALOG_POST_ACQUIRE_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        if acquired.path != path
            || acquired.identity != grant.entry.stored.identity
            || acquired.parent_identity != grant.entry.stored.parent_identity
        {
            return Err(
                Error::Conflict("dialog target changed before promotion".into())
                    .with_root_failure(crate::error::RootFailure::Changed),
            );
        }
        let expected = acquired.identity.clone();
        if let Some(purpose) = purpose {
            let same_path = |entry: &Entry| {
                entry.stored.class == persistent_class
                    && entry.stored.purpose == Some(purpose)
                    && entry.stored.path.to_path().ok().as_ref() == Some(&path)
            };
            // Reuse is identity-first so a Library listing that already minted the current
            // object at this path is reused. A same-path PersistentFile whose identity no
            // longer matches is left in place for startup reconciliation (d-20261113-02);
            // the picker mints a fresh entry with no practice key (d-20261115-01). Custom
            // workspace roots still refuse with Changed.
            if let Some(existing) = self
                .persistent
                .values()
                .find(|entry| same_path(entry) && entry.stored.identity == expected)
            {
                let id = existing.stored.id.clone();
                let mut candidate = self.persistent.clone();
                if let Some(entry) = candidate.get_mut(&id.id) {
                    entry.stored.operations = canonical_operations(purpose);
                    entry.stored.parent_identity = acquired.parent_identity.clone();
                }
                let durability = self.commit_candidate(candidate, Some(dialog))?;
                self.session_protected_ids.insert(id.id.clone());
                return Ok(PathCommit { id, durability });
            } else if persistent_class == PathClass::PersistentCustomRoot
                && self.persistent.values().any(same_path)
            {
                return Err(Error::Conflict(
                    "persistent target changed; acquire a new capability".into(),
                )
                .with_root_failure(crate::error::RootFailure::Changed));
            }
        }
        let id = PathRef::fresh();
        let operations = purpose.map(canonical_operations).unwrap_or(operations);
        let stored = StoredEntry {
            id: id.clone(),
            display_name: display_name.into(),
            class: persistent_class,
            purpose,
            operations,
            path: NativePath::from_path(&acquired.path),
            identity: expected,
            parent_identity: acquired.parent_identity,
            target_is_dir,
            practice_key: None,
        };
        let mut candidate = self.persistent.clone();
        candidate.insert(
            id.id.clone(),
            Entry {
                stored,
                availability: PathAvailability::Available,
            },
        );
        let provisional = matches!(
            purpose,
            Some(EntryPurpose::EngineResource | EntryPurpose::EngineImage)
        );
        if provisional {
            self.provisional_attachments.insert(id.id.clone());
        }
        let durability = match self.commit_candidate(candidate, Some(dialog)) {
            Ok(durability) => durability,
            Err(error) => {
                if provisional {
                    self.provisional_attachments.remove(&id.id);
                }
                return Err(error);
            }
        };
        self.session_protected_ids.insert(id.id.clone());
        Ok(PathCommit { id, durability })
    }
    /// One-time backend migration escape hatch. New operational code must use dialog promotion.
    pub fn migrate_legacy_os_path(
        &mut self,
        path: OsString,
        display_name: impl Into<String>,
        class: PathClass,
        operations: Vec<PathOperation>,
    ) -> Result<PathCommit, Error> {
        self.migrate_legacy_os_path_inner(path, display_name.into(), class, operations, None, None)
    }

    fn fresh_stored_entry(
        path: &Path,
        binding: IdentityBinding,
        display_name: String,
        class: PathClass,
        purpose: Option<EntryPurpose>,
        operations: Vec<PathOperation>,
        target_is_dir: bool,
    ) -> StoredEntry {
        StoredEntry {
            id: PathRef::fresh(),
            display_name,
            class,
            purpose,
            operations,
            path: NativePath::from_path(path),
            identity: binding.identity,
            parent_identity: binding.parent_identity,
            target_is_dir,
            practice_key: None,
        }
    }

    fn persist_entry(
        &mut self,
        path: &Path,
        binding: IdentityBinding,
        display_name: String,
        class: PathClass,
        operations: Vec<PathOperation>,
    ) -> Result<PathCommit, Error> {
        let target_is_dir = class == PathClass::PersistentCustomRoot;
        let purpose = purpose_for_shape(class, target_is_dir, &operations);
        let operations = purpose.map(canonical_operations).unwrap_or(operations);
        let stored = Self::fresh_stored_entry(
            path,
            binding,
            display_name,
            class,
            purpose,
            operations,
            target_is_dir,
        );
        self.persist_new_entry(stored)
    }

    fn registration_target(
        path: &Path,
        class: PathClass,
        operations: &[PathOperation],
        expected_identity: Option<VerifiedIdentity>,
        expected_parent_identity: Option<VerifiedIdentity>,
    ) -> Result<(PathBuf, IdentityBinding), Error> {
        match expected_identity {
            None => {
                let shape = AcquireShape::for_persistent_class(
                    class,
                    parent_access_for_operations(operations),
                );
                let acquired = acquire_target(path, shape)?;
                Ok((
                    acquired.path,
                    IdentityBinding::new(acquired.identity, acquired.parent_identity),
                ))
            }
            Some(expected) => {
                let identity = validate_target(path, class)?;
                reject_disagreeing_expected_identity(&identity, Some(expected))?;
                let parent_identity = if class == PathClass::PersistentFile && has_normal_leaf(path)
                {
                    let parent = expected_parent_identity.ok_or_else(|| {
                        Error::InvalidInput("verified file has no parent identity".into())
                    })?;
                    let (a, b) = parent.pair();
                    Some(Identity { a, b })
                } else {
                    None
                };
                Ok((
                    path.to_path_buf(),
                    IdentityBinding::new(identity, parent_identity),
                ))
            }
        }
    }

    fn migrate_legacy_os_path_inner(
        &mut self,
        path: OsString,
        display_name: String,
        class: PathClass,
        operations: Vec<PathOperation>,
        expected_identity: Option<VerifiedIdentity>,
        expected_parent_identity: Option<VerifiedIdentity>,
    ) -> Result<PathCommit, Error> {
        if !matches!(
            class,
            PathClass::PersistentCustomRoot | PathClass::PersistentFile
        ) {
            return Err(Error::InvalidInput(
                "legacy migration must create persistent authority".into(),
            ));
        }
        if operations.is_empty() {
            return Err(Error::InvalidInput(
                "persistent operations cannot be empty".into(),
            ));
        }
        let path = PathBuf::from(path);
        let (path, binding) = Self::registration_target(
            &path,
            class,
            &operations,
            expected_identity,
            expected_parent_identity,
        )?;
        #[cfg(test)]
        PERSISTENT_FILE_POST_TARGET_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        self.persist_entry(&path, binding, display_name, class, operations)
    }
    /// Registers a bundled/app-owned or picker-selected persistent file. A call without an
    /// expected identity acquires through `acquire_target`; Unix paths with normal leaves are
    /// canonicalised, while leafless paths and non-Unix paths retain their input spelling.
    /// Existing persistent entries retain their opaque ID across restarts; a replaced object is
    /// rejected rather than silently reusing the old capability.
    pub fn get_or_create_persistent_file(
        &mut self,
        path: &Path,
        display_name: impl Into<String>,
        operations: Vec<PathOperation>,
    ) -> Result<PathCommit, Error> {
        self.get_or_create_persistent_file_inner(
            path,
            display_name.into(),
            operations,
            None,
            None,
            RegistrationDoor::ExplicitReauthorization,
        )
    }

    pub(crate) fn get_or_create_persistent_file_verified(
        &mut self,
        path: &Path,
        display_name: impl Into<String>,
        operations: Vec<PathOperation>,
        expected: VerifiedIdentity,
        expected_parent: VerifiedIdentity,
        door: RegistrationDoor,
    ) -> Result<PathCommit, Error> {
        self.get_or_create_persistent_file_inner(
            path,
            display_name.into(),
            operations,
            Some(expected),
            Some(expected_parent),
            door,
        )
    }

    fn get_or_create_persistent_file_inner(
        &mut self,
        path: &Path,
        display_name: String,
        operations: Vec<PathOperation>,
        expected_identity: Option<VerifiedIdentity>,
        expected_parent_identity: Option<VerifiedIdentity>,
        door: RegistrationDoor,
    ) -> Result<PathCommit, Error> {
        if operations.is_empty() {
            return Err(Error::InvalidInput(
                "persistent operations cannot be empty".into(),
            ));
        }
        let (path, binding) = Self::registration_target(
            path,
            PathClass::PersistentFile,
            &operations,
            expected_identity,
            expected_parent_identity,
        )?;
        #[cfg(test)]
        PERSISTENT_FILE_POST_TARGET_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        self.get_or_create_persistent_file_from_identity(
            &path,
            display_name,
            operations,
            binding,
            door,
        )
    }

    /// Common storage body for native paths whose file identity has already been established.
    /// Callers must acquire the binding from a checked pathname or retained descriptor boundary.
    fn get_or_create_persistent_file_from_identity(
        &mut self,
        path: &Path,
        display_name: String,
        operations: Vec<PathOperation>,
        binding: IdentityBinding,
        door: RegistrationDoor,
    ) -> Result<PathCommit, Error> {
        let prepared =
            self.prepare_persistent_file(path, display_name, operations, binding, door)?;
        self.publish_prepared_entry(prepared)
    }

    fn prepare_persistent_file(
        &self,
        path: &Path,
        display_name: String,
        operations: Vec<PathOperation>,
        binding: IdentityBinding,
        door: RegistrationDoor,
    ) -> Result<PreparedEntry, Error> {
        let purpose = purpose_for_shape(PathClass::PersistentFile, false, &operations);
        let desired_operations = purpose
            .map(canonical_operations)
            .unwrap_or_else(|| operations.clone());
        let same_path = |entry: &Entry| {
            entry.stored.class == PathClass::PersistentFile
                && match purpose {
                    Some(purpose) => entry.stored.purpose == Some(purpose),
                    None => entry.stored.purpose.is_none() && entry.stored.operations == operations,
                }
                && entry
                    .stored
                    .path
                    .to_path()
                    .is_ok_and(|stored_path| stored_path == path)
        };
        if let Some(entry) = self
            .persistent
            .values()
            .find(|entry| same_path(entry) && entry.stored.identity == binding.identity)
        {
            if entry.stored.parent_identity == binding.parent_identity
                || door != RegistrationDoor::PassiveObservation
            {
                let mut stored = entry.stored.clone();
                stored.operations = desired_operations;
                stored.parent_identity = binding.parent_identity;
                return Ok(PreparedEntry {
                    stored,
                    reused: true,
                });
            }
            // Passive discovery leaves the old binding refused and prepares a fresh ID.
        } else if self.persistent.values().any(same_path)
            && door == RegistrationDoor::ExplicitReauthorization
        {
            return Err(Error::Conflict(
                "persistent file changed; acquire a new capability".into(),
            ));
        }
        Ok(PreparedEntry {
            stored: Self::fresh_stored_entry(
                path,
                binding,
                display_name,
                PathClass::PersistentFile,
                purpose,
                desired_operations,
                false,
            ),
            reused: false,
        })
    }

    fn publish_prepared_entry(&mut self, prepared: PreparedEntry) -> Result<PathCommit, Error> {
        if !prepared.reused {
            return self.persist_new_entry(prepared.stored);
        }
        let id = prepared.id();
        let current = self
            .persistent
            .get(&id.id)
            .ok_or_else(|| Error::Conflict("prepared path capability disappeared".into()))?;
        let durability = if current.stored != prepared.stored {
            let mut candidate = self.persistent.clone();
            if let Some(entry) = candidate.get_mut(&id.id) {
                entry.stored = prepared.stored;
            }
            self.commit_candidate(candidate, None)?
        } else {
            CommitDurability::Durable
        };
        self.session_protected_ids.insert(id.id.clone());
        Ok(PathCommit { id, durability })
    }

    fn persist_new_entry(&mut self, stored: StoredEntry) -> Result<PathCommit, Error> {
        if self.attachments_sealed && is_attachment_purpose(stored.purpose) {
            return Err(Error::Conflict(
                "engine attachment mutations are sealed".into(),
            ));
        }
        let id = stored.id.clone();
        let provisional = matches!(
            stored.purpose,
            Some(EntryPurpose::EngineResource | EntryPurpose::EngineImage)
        );
        let mut candidate = self.persistent.clone();
        candidate.insert(
            id.id.clone(),
            Entry {
                stored,
                availability: PathAvailability::Available,
            },
        );
        if provisional {
            self.provisional_attachments.insert(id.id.clone());
        }
        let durability = match self.commit_candidate(candidate, None) {
            Ok(durability) => durability,
            Err(error) => {
                self.provisional_attachments.remove(&id.id);
                return Err(error);
            }
        };
        self.session_protected_ids.insert(id.id.clone());
        Ok(PathCommit { id, durability })
    }

    /// Creates a persistent database root from a native-only selected path.
    /// Re-opening the application or re-listing the root reuses its identifier
    /// rather than exposing the directory again to the renderer.
    pub(crate) fn get_or_create_database_root(
        &mut self,
        path: &Path,
        display_name: impl Into<String>,
        expected_identity: Option<VerifiedIdentity>,
    ) -> Result<DatabaseRootHandle, Error> {
        Ok(DatabaseRootHandle::new(self.get_or_create_root(
            path,
            display_name,
            canonical_operations(EntryPurpose::DatabaseRoot),
            "database",
            expected_identity,
        )?))
    }

    /// Creates or reuses a persisted directory that contains exact puzzle
    /// databases. Its ID is stable across restarts; only backend discovery
    /// derives child IDs from the directory.
    pub(crate) fn get_or_create_puzzle_root(
        &mut self,
        path: &Path,
        display_name: impl Into<String>,
        expected_identity: Option<VerifiedIdentity>,
    ) -> Result<PuzzleRootHandle, Error> {
        Ok(PuzzleRootHandle::new(self.get_or_create_root(
            path,
            display_name,
            canonical_operations(EntryPurpose::PuzzleRoot),
            "puzzle",
            expected_identity,
        )?))
    }

    pub(crate) fn get_or_create_engine_root(
        &mut self,
        path: &Path,
        display_name: impl Into<String>,
        expected_identity: Option<VerifiedIdentity>,
    ) -> Result<EngineRootHandle, Error> {
        Ok(EngineRootHandle::new(self.get_or_create_root(
            path,
            display_name,
            canonical_operations(EntryPurpose::EngineRoot),
            "engine",
            expected_identity,
        )?))
    }

    /// The one registration body behind the three root methods above: reuse the
    /// persisted entry for this directory when its operations match, recover a
    /// replaced app-owned default root when its verified expected identity is
    /// current, refuse every other replacement, and otherwise register it.
    /// `changed_noun` names the root in that refusal, so each caller keeps
    /// telling the renderer which root to select again. A `None` expected
    /// identity always refuses a replaced directory; recovery is limited to a
    /// default caller whose expected token matches the live directory.
    fn get_or_create_root(
        &mut self,
        path: &Path,
        display_name: impl Into<String>,
        operations: Vec<PathOperation>,
        changed_noun: &str,
        expected_identity: Option<VerifiedIdentity>,
    ) -> Result<PathRef, Error> {
        let display_name = display_name.into();
        let purpose = purpose_for_shape(PathClass::PersistentCustomRoot, true, &operations);
        let (path, binding) = Self::registration_target(
            path,
            PathClass::PersistentCustomRoot,
            &operations,
            expected_identity,
            None,
        )
        .map_err(|error| {
            if purpose == Some(EntryPurpose::DatabaseRoot) && expected_identity.is_some() {
                error.label_root_failure()
            } else {
                error
            }
        })?;
        if let Some(entry) = self
            .persistent
            .values()
            .find(|entry| {
                entry.stored.class == PathClass::PersistentCustomRoot
                    && entry.stored.target_is_dir
                    && match purpose {
                        Some(purpose) => entry.stored.purpose == Some(purpose),
                        None => {
                            entry.stored.purpose.is_none() && entry.stored.operations == operations
                        }
                    }
                    && entry
                        .stored
                        .path
                        .to_path()
                        .is_ok_and(|stored| stored == path)
            })
            .cloned()
        {
            if binding.identity != entry.stored.identity {
                if expected_identity.is_some() {
                    let stale_root = entry.stored.id.clone();
                    let new_root = PathRef::fresh();
                    let (mut candidate, filtered_pending, mut filtered_provisional) =
                        Self::complete_workspace_prune_candidate(
                            &self.persistent,
                            &self.pending_artifacts,
                            &self.provisional_attachments,
                            &stale_root.id,
                        )?;
                    filtered_provisional
                        .retain(|id| !self.pending_unpersisted_removals.contains(id));
                    let stored = StoredEntry {
                        id: new_root.clone(),
                        display_name,
                        class: PathClass::PersistentCustomRoot,
                        purpose,
                        operations: purpose.map(canonical_operations).unwrap_or(operations),
                        path: NativePath::from_path(&path),
                        identity: binding.identity.clone(),
                        parent_identity: None,
                        target_is_dir: true,
                        practice_key: None,
                    };
                    candidate.insert(
                        new_root.id.clone(),
                        Entry {
                            stored,
                            availability: PathAvailability::Available,
                        },
                    );

                    let old_provisional = self.provisional_attachments.clone();
                    self.provisional_attachments = filtered_provisional;
                    return match self.commit_candidate_with_pending(
                        candidate,
                        filtered_pending,
                        None,
                    ) {
                        Ok(_) => {
                            self.session_protected_ids.insert(new_root.id.clone());
                            Ok(new_root)
                        }
                        Err(error) => {
                            self.provisional_attachments = old_provisional;
                            Err(error)
                        }
                    };
                }
                let error =
                    Error::Conflict(format!("{changed_noun} root changed; select it again"));
                return Err(if purpose == Some(EntryPurpose::DatabaseRoot) {
                    error.with_root_failure(crate::error::RootFailure::Changed)
                } else {
                    error
                });
            }
            let id = entry.stored.id.clone();
            if let Some(purpose) = purpose {
                let canonical = canonical_operations(purpose);
                if entry.stored.operations != canonical {
                    let mut candidate = self.persistent.clone();
                    if let Some(candidate_entry) = candidate.get_mut(&id.id) {
                        candidate_entry.stored.operations = canonical;
                    }
                    require_durable(self.commit_candidate(candidate, None)?)?;
                }
            }
            self.session_protected_ids.insert(id.id.clone());
            return Ok(id);
        }
        if expected_identity.is_some() {
            if let Some(id) =
                self.adopt_unavailable_root(&path, &binding.identity, purpose, &operations)?
            {
                self.session_protected_ids.insert(id.id.clone());
                return Ok(id);
            }
        }
        let id = self
            .persist_entry(
                &path,
                binding,
                display_name,
                PathClass::PersistentCustomRoot,
                operations,
            )?
            .id;
        self.session_protected_ids.insert(id.id.clone());
        Ok(id)
    }

    /// A default root whose load-time rebinding failed stays `Unavailable` under its old spelling,
    /// so the lexical lookup above misses the caller's canonical path. When exactly one
    /// `Unavailable` root of the same purpose carries the verified identity, the canonical path is
    /// adopted onto that id instead of minting a second root. Component-wise descendants of the
    /// old spelling — including still-`Available` children — have that prefix rewritten, then
    /// `refresh_entry` re-checks them. A second `Available` root of the same identity is never
    /// adopted.
    fn adopt_unavailable_root(
        &mut self,
        path: &Path,
        identity: &Identity,
        purpose: Option<EntryPurpose>,
        operations: &[PathOperation],
    ) -> Result<Option<PathRef>, Error> {
        let mut matches = self.persistent.values().filter(|entry| {
            entry.availability == PathAvailability::Unavailable
                && entry.stored.class == PathClass::PersistentCustomRoot
                && entry.stored.target_is_dir
                && entry.stored.identity == *identity
                && match purpose {
                    Some(purpose) => entry.stored.purpose == Some(purpose),
                    None => entry.stored.purpose.is_none() && entry.stored.operations == operations,
                }
        });
        let (Some(entry), None) = (matches.next(), matches.next()) else {
            return Ok(None);
        };
        let root_id = entry.stored.id.clone();
        let Ok(old_root) = entry.stored.path.to_path() else {
            return Ok(None);
        };
        let mut candidate = self.persistent.clone();
        for (id, entry) in candidate.iter_mut() {
            if *id == root_id.id {
                entry.stored.path = NativePath::from_path(path);
                if let Some(purpose) = purpose {
                    entry.stored.operations = canonical_operations(purpose);
                }
                entry.availability = PathAvailability::Available;
                continue;
            }
            let Ok(stored) = entry.stored.path.to_path() else {
                continue;
            };
            if let Ok(rest) = stored.strip_prefix(&old_root) {
                let rebound = if rest.as_os_str().is_empty() {
                    path.to_path_buf()
                } else {
                    path.join(rest)
                };
                entry.stored.path = NativePath::from_path(&rebound);
                refresh_entry(entry);
            }
        }
        require_durable(self.commit_candidate(candidate, None)?)?;
        Ok(Some(root_id))
    }

    /// Builds the recovery-only Complete prune candidate for a replaced root. Explicit workspace
    /// removal keeps its own Complete/Partial semantics and pending-removal bookkeeping.
    fn complete_workspace_prune_candidate(
        persistent: &BTreeMap<String, Entry>,
        pending_artifacts: &[PendingArtifact],
        provisional_attachments: &BTreeSet<String>,
        root_id: &str,
    ) -> Result<CompleteWorkspacePruneCandidate, Error> {
        let removed = persistent
            .get(root_id)
            .ok_or_else(|| Error::InvalidInput("workspace entry is not persistent".into()))?;
        let removed_path = removed.stored.path.to_path()?;
        let mut candidate = persistent.clone();
        candidate.remove(root_id);
        if removed.stored.target_is_dir {
            candidate.retain(|id, entry| {
                if id == root_id {
                    return false;
                }
                let Ok(path) = entry.stored.path.to_path() else {
                    return true;
                };
                let is_descendant =
                    path != removed_path && path.strip_prefix(&removed_path).is_ok();
                !is_descendant
            });
        }

        let removed_ids: BTreeSet<_> = persistent
            .keys()
            .filter(|id| !candidate.contains_key(*id))
            .cloned()
            .collect();
        let mut filtered_pending = pending_artifacts.to_vec();
        filtered_pending.retain(|pending| !removed_ids.contains(&pending.root.id));
        let filtered_provisional = provisional_attachments
            .iter()
            .filter(|id| candidate.contains_key(*id))
            .cloned()
            .collect();
        Ok((candidate, filtered_pending, filtered_provisional))
    }

    pub(crate) fn active_engine_root(&mut self) -> Result<Option<EngineRootHandle>, Error> {
        self.resolve_active_root(
            self.active_engine_root.clone(),
            PathOperation::EngineInstall,
        )
        .map(|id| id.map(EngineRootHandle::new))
    }

    fn resolve_active_root(
        &mut self,
        active_id: Option<PathRef>,
        operation: PathOperation,
    ) -> Result<Option<PathRef>, Error> {
        let Some(id) = active_id else {
            return Ok(None);
        };
        self.refresh_persistent_id(&id);
        match self.persistent.get(&id.id) {
            Some(entry)
                if entry.availability == PathAvailability::Available
                    && entry.stored.target_is_dir
                    && entry.stored.operations.contains(&operation) =>
            {
                Ok(Some(id))
            }
            _ => {
                let error = match self
                    .workspace_root(&FileWorkspaceHandle::new(id.clone()), operation)
                {
                    Err(error) => error,
                    // A re-proof can disagree with refresh. Fail closed for this request;
                    // the next refresh can recover without changing the persisted selection.
                    Ok(_) => Error::Conflict("active workspace changed during resolution".into()),
                };
                Err(error.label_root_failure())
            }
        }
    }

    fn root_path(&mut self, id: &PathRef, operation: PathOperation) -> Result<PathBuf, Error> {
        self.workspace_root(&FileWorkspaceHandle::new(id.clone()), operation)
    }

    pub(crate) fn engine_root_path(&mut self, root: &EngineRootHandle) -> Result<PathBuf, Error> {
        self.root_path(root.path_ref(), PathOperation::EngineInstall)
    }

    pub(crate) fn set_active_engine_root(&mut self, root: &EngineRootHandle) -> Result<(), Error> {
        let _ = self.engine_root_path(root)?;
        let durability = self.commit_state(
            self.persistent.clone(),
            self.active_database_root.clone(),
            self.active_puzzle_root.clone(),
            Some(root.path_ref().clone()),
            self.pending_artifacts.clone(),
            None,
        )?;
        if let CommitDurability::DurabilityUncertain(stage) = durability {
            log::warn!("active engine root committed with uncertain durability: {stage}");
        }
        Ok(())
    }

    /// Registers one exact executable picked in a native dialog. The renderer receives only
    /// its opaque handle; every later execution and probe revalidates this identity. A file
    /// replaced at a stored path gets a fresh capability, and the stale entry is left for
    /// startup reconciliation once the renderer stops retaining it (d-20261113-02).
    pub(crate) fn register_engine_file(
        &mut self,
        path: &Path,
        display_name: impl Into<String>,
    ) -> Result<EngineHandle, Error> {
        let operations = engine_file_operations();
        let commit = self.get_or_create_persistent_file_inner(
            path,
            display_name.into(),
            operations,
            None,
            None,
            RegistrationDoor::PickerSelection,
        )?;
        let registered = self
            .persistent
            .get(&commit.id.id)
            .ok_or_else(|| Error::Conflict("registered engine authority disappeared".into()))?
            .stored
            .path
            .to_path()?;
        self.protect_catalog_path(&registered, false, false, None)?;
        Ok(keep_adopted_handle(
            commit.durability,
            EngineHandle::new(commit.id),
        ))
    }

    fn register_engine_file_from_resolved(
        &mut self,
        path: &Path,
        display_name: String,
        identity: VerifiedIdentity,
        parent_identity: VerifiedIdentity,
    ) -> Result<EngineHandle, Error> {
        let operations = engine_file_operations();
        let binding = IdentityBinding::from_pairs(identity.pair(), parent_identity.pair());
        let commit = self.get_or_create_persistent_file_from_identity(
            path,
            display_name,
            operations,
            binding,
            RegistrationDoor::ExplicitReauthorization,
        )?;
        Ok(keep_adopted_handle(
            commit.durability,
            EngineHandle::new(commit.id),
        ))
    }

    /// Persists a picker-selected UCI resource with only resource-read
    /// authority.  Callers must hand us the one-time dialog grant; raw paths
    /// never cross the IPC boundary.
    pub(crate) fn promote_engine_resource(
        &mut self,
        grant: &PathRef,
        kind: EngineResourceHandleKind,
        display_name: impl Into<String>,
    ) -> Result<EngineResourceHandle, Error> {
        let display_name = display_name.into();
        let class = match kind {
            EngineResourceHandleKind::File => PathClass::PersistentFile,
            EngineResourceHandleKind::Directory => PathClass::PersistentCustomRoot,
        };
        let commit = self.promote_dialog(
            grant,
            class,
            display_name.clone(),
            canonical_operations(EntryPurpose::EngineResource),
        )?;
        Ok(keep_adopted_handle(
            commit.durability,
            EngineResourceHandle::new(commit.id, kind, display_name),
        ))
    }

    /// Resolves a UCI resource through no-follow traversal and returns a
    /// descriptor lease. The caller owns this object until the engine exits.
    pub(crate) fn engine_resource(
        &mut self,
        resource: &EngineResourceHandle,
    ) -> Result<EngineResourceLease, Error> {
        #[cfg(all(test, unix))]
        observe_engine_resolution("resource");
        let mut resolved =
            self.resolve(resource.path_ref(), PathOperation::EngineResourceRead, &[])?;
        #[cfg(windows)]
        let directories = resolved.windows_resource_directory_seals()?;
        match resource.kind {
            EngineResourceHandleKind::File => {
                #[cfg(unix)]
                let file = resolved
                    .take_file()
                    .ok_or_else(|| Error::InvalidInput("engine resource must be a file".into()))?;
                #[cfg(windows)]
                let _file = resolved
                    .take_file()
                    .ok_or_else(|| Error::InvalidInput("engine resource must be a file".into()))?;
                #[cfg(unix)]
                return EngineResourceLease::from_file(file, false, None);
                #[cfg(windows)]
                Ok(EngineResourceLease {
                    _file,
                    _directories: directories,
                    target: resolved.take_target().ok_or_else(|| {
                        Error::Conflict("engine resource target is unavailable".into())
                    })?,
                })
            }
            EngineResourceHandleKind::Directory => {
                #[cfg(unix)]
                {
                    let file = resolved.take_directory().ok_or_else(|| {
                        Error::InvalidInput("engine resource must be a directory".into())
                    })?;
                    EngineResourceLease::from_file(OwnedFile::directory(file)?, true, None)
                }
                #[cfg(windows)]
                {
                    // The no-follow walk leaves the verified directory handle in the
                    // `directory` slot and its computed path in `target`, mirroring the File
                    // arm above. The handle is retained for the lease lifetime; the path is
                    // only the UCI/CreateProcess string.
                    Ok(EngineResourceLease {
                        _directories: directories,
                        _file: OwnedFile::directory(resolved.take_directory().ok_or_else(
                            || Error::InvalidInput("engine resource must be a directory".into()),
                        )?)?,
                        target: resolved.take_target().ok_or_else(|| {
                            Error::Conflict("engine resource target is unavailable".into())
                        })?,
                    })
                }
            }
        }
    }

    /// Registers an app-owned copied engine-image asset. The native picker is
    /// consumed before this point, so only the managed copy is persistent.
    pub(crate) fn register_engine_image(
        &mut self,
        dir: &AuthorizedDir,
        leaf: &OsStr,
        installed: VerifiedIdentity,
        display_name: String,
    ) -> Result<EngineImageHandle, Error> {
        if self.attachments_sealed {
            return Err(Error::Conflict(
                "engine attachment mutations are sealed".into(),
            ));
        }
        crate::infra::fs::single_leaf(leaf)
            .map_err(|_| Error::InvalidInput("engine image leaf must be one component".into()))?;
        let path = dir.path().join(leaf);
        #[cfg(test)]
        ENGINE_IMAGE_PRE_REGISTRATION_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        let commit = self.get_or_create_persistent_file_verified(
            &path,
            display_name,
            canonical_operations(EntryPurpose::EngineImage),
            installed,
            dir.identity(),
            RegistrationDoor::ExplicitReauthorization,
        )?;
        Ok(keep_adopted_handle(
            commit.durability,
            EngineImageHandle::new(commit.id),
        ))
    }

    /// Keeps an installed, unregistered UUID image reachable by startup and shutdown cleanup.
    /// Sealed attachments still admit cleanup intents while issuance leases drain.
    pub(crate) fn record_engine_image_cleanup(
        &mut self,
        dir: &AuthorizedDir,
        leaf: &OsStr,
        installed: VerifiedIdentity,
    ) -> EngineImageCleanupIntent {
        self.record_engine_image_cleanup_with(dir, leaf, installed, |target, write| {
            atomic_replace(target, write)
        })
    }

    fn record_engine_image_cleanup_with<F>(
        &mut self,
        dir: &AuthorizedDir,
        leaf: &OsStr,
        installed: VerifiedIdentity,
        mut replace: F,
    ) -> EngineImageCleanupIntent
    where
        F: FnMut(
            &Path,
            Box<dyn FnOnce(&mut OwnedFile) -> Result<(), Error>>,
        ) -> Result<AtomicFileOutcome, Error>,
    {
        if crate::infra::fs::single_leaf(leaf).is_err()
            || leaf
                .to_str()
                .is_none_or(|leaf| uuid::Uuid::parse_str(leaf).is_err())
        {
            return EngineImageCleanupIntent::NotRecorded(Error::InvalidInput(
                "engine image cleanup leaf must be one UUID component".into(),
            ));
        }
        let baseline = match self.registry_admission_snapshot(
            &self.persistent,
            &self.active_database_root,
            &self.active_puzzle_root,
            &self.active_engine_root,
            &self.pending_artifacts,
            &self.provisional_attachments,
            &self.retired_attachments,
            &self.image_cleanup,
        ) {
            Ok(baseline) => baseline,
            Err(error) => return EngineImageCleanupIntent::NotRecorded(error),
        };
        let id = loop {
            let id = uuid::Uuid::new_v4().to_string();
            if !self.persistent.contains_key(&id)
                && !self.retired_attachments.contains_key(&id)
                && !self.image_cleanup.contains_key(&id)
            {
                break id;
            }
        };
        self.image_cleanup.insert(
            id.clone(),
            StoredEntry {
                id: PathRef { id: id.clone() },
                display_name: UNREGISTERED_ENGINE_IMAGE_DISPLAY_NAME.into(),
                class: PathClass::PersistentFile,
                operations: canonical_operations(EntryPurpose::EngineImage),
                path: NativePath::from_path(&dir.path().join(leaf)),
                identity: Identity {
                    a: installed.pair().0,
                    b: installed.pair().1,
                },
                parent_identity: Some(Identity {
                    a: dir.identity().pair().0,
                    b: dir.identity().pair().1,
                }),
                target_is_dir: false,
                purpose: Some(EntryPurpose::EngineImage),
                practice_key: None,
            },
        );
        let mut write_started = false;
        let result = self.save_entries_with_baseline(
            &self.persistent,
            &self.active_database_root,
            &self.active_puzzle_root,
            &self.active_engine_root,
            &self.pending_artifacts,
            Some(baseline),
            |target, write| {
                write_started = true;
                replace(target, write)
            },
        );
        match result {
            Ok(CommitDurability::Durable) => {
                self.registry_durability_pending = false;
                EngineImageCleanupIntent::Recorded
            }
            Ok(CommitDurability::DurabilityUncertain(_)) => {
                self.registry_durability_pending = true;
                EngineImageCleanupIntent::DurabilityUncertain
            }
            Err(error) if write_started => {
                self.registry_durability_pending = true;
                EngineImageCleanupIntent::Retained(error)
            }
            Err(error) => {
                self.image_cleanup.remove(&id);
                EngineImageCleanupIntent::NotRecorded(error)
            }
        }
    }

    pub(crate) fn register_opening_book(
        &mut self,
        path: &Path,
        display_name: impl Into<String>,
    ) -> Result<OpeningBookHandle, Error> {
        let commit = self.get_or_create_persistent_file_inner(
            path,
            display_name.into(),
            canonical_operations(EntryPurpose::OpeningBook),
            None,
            None,
            RegistrationDoor::PickerSelection,
        )?;
        Ok(keep_adopted_handle(
            commit.durability,
            OpeningBookHandle::new(commit.id),
        ))
    }

    /// Resolves an exact opening-book descriptor without exposing a native path.
    /// The caller moves this already-opened file to its bounded blocking worker.
    pub(crate) fn opening_book_descriptor(
        &mut self,
        book: &OpeningBookHandle,
    ) -> Result<OpeningBookDescriptor, Error> {
        let mut resolved = self.resolve(book.path_ref(), PathOperation::OpeningBookRead, &[])?;
        let file_name = self.display_name(book.path_ref())?;
        let file = resolved.take_file().ok_or_else(|| {
            Error::InvalidInput("opening-book capability names a directory".into())
        })?;
        Ok(OpeningBookDescriptor { file_name, file })
    }

    #[cfg(test)]
    pub(crate) fn register_installed_engine_for_test(
        &mut self,
        root: &EngineRootHandle,
        relative_path: &str,
    ) -> Result<EngineHandle, Error> {
        self.register_installed_engine(root, relative_path, &mut EngineRootProbe::default())
    }

    pub(crate) fn register_installed_engine(
        &mut self,
        root: &EngineRootHandle,
        relative_path: &str,
        probe: &mut EngineRootProbe,
    ) -> Result<EngineHandle, Error> {
        let components = engine_relative_components(relative_path)?;
        let (catalog_root, catalog_path, root_directory) =
            self.prepare_catalog_engine_registration(root, &components, probe)?;
        let resolved = self.resolve_with_engine_probe(
            root.path_ref(),
            PathOperation::EngineInstall,
            &components,
            probe,
        )?;
        if resolved.file().is_none() {
            return Err(Error::InvalidInput(
                "installed engine must be a regular file".into(),
            ));
        }
        let identity = resolved.identity()?;
        let parent_identity = VerifiedIdentity::from_pair(resolved.parent_identity()?);
        let path = resolved
            .target()
            .ok_or_else(|| Error::InvalidInput("installed engine must be a regular file".into()))?
            .to_path_buf();
        #[cfg(test)]
        INSTALLED_ENGINE_POST_RESOLVE_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        self.confirm_catalog_engine_registration(
            &catalog_root,
            &catalog_path,
            &root_directory,
            Some((&path, identity)),
            probe,
        )?;
        resolved.mark_engine_executable()?;
        let display_name = components
            .last()
            .ok_or_else(|| Error::InvalidInput("engine path is required".into()))?
            .to_string_lossy()
            .into_owned();
        self.register_engine_file_from_resolved(&path, display_name, identity, parent_identity)
    }

    #[cfg(test)]
    pub(crate) fn engine_archive_destination(
        &mut self,
        root: &EngineRootHandle,
    ) -> Result<PathRef, Error> {
        self.engine_archive_destination_with_probe(root, &mut EngineRootProbe::default())
    }

    pub(crate) fn engine_archive_destination_with_probe(
        &mut self,
        root: &EngineRootHandle,
        probe: &mut EngineRootProbe,
    ) -> Result<PathRef, Error> {
        let _ = self.resolve_with_engine_probe(
            root.path_ref(),
            PathOperation::DownloadArchive,
            &[],
            probe,
        )?;
        Ok(root.path_ref().clone())
    }

    /// Resolves one exact engine object after capability and identity validation. The native
    /// path is for the backend actor only and is never serialized to the renderer.
    pub(crate) fn engine_executable(
        &mut self,
        engine: &EngineHandle,
        operation: PathOperation,
    ) -> Result<EngineExecutable, Error> {
        #[cfg(all(test, unix))]
        observe_engine_resolution("executable");
        if !matches!(
            operation,
            PathOperation::EngineExecute | PathOperation::EngineConfigure
        ) {
            return Err(Error::InvalidInput("invalid engine operation".into()));
        }
        let mut resolved = self.resolve(engine.path_ref(), operation, &[])?;
        let working_directory = resolved
            .parent()
            .ok_or_else(|| Error::Conflict("engine has no validated working directory".into()))?
            .try_clone()?;
        #[cfg(unix)]
        let file = resolved
            .take_file()
            .ok_or_else(|| Error::InvalidInput("engine capability is not a file".into()))?;
        #[cfg(windows)]
        let _file = resolved
            .take_file()
            .ok_or_else(|| Error::InvalidInput("engine capability is not a file".into()))?;
        let verified_path = self.workspace_entry_path(
            &FileWorkspaceHandle::new(engine.path_ref().clone()),
            operation,
        )?;
        let _working_directory_path = verified_path
            .parent()
            .ok_or_else(|| Error::InvalidInput("engine executable has no parent directory".into()))?
            .to_path_buf();
        #[cfg(target_os = "macos")]
        let command_path = descriptor_path(&file)?;
        Ok(EngineExecutable {
            #[cfg(unix)]
            file,
            _working_directory: working_directory,
            #[cfg(windows)]
            working_directory_path: _working_directory_path,
            resource_leases: Vec::new(),
            #[cfg(target_os = "macos")]
            command_path,
            #[cfg(target_os = "macos")]
            launch_root: self.engine_launch_root.clone(),
            #[cfg(target_os = "macos")]
            materialized_files: Vec::new(),
            #[cfg(windows)]
            _file,
            #[cfg(windows)]
            command_path: verified_path,
        })
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn engine_launch_root(&self) -> Result<EngineLaunchRoot, Error> {
        self.engine_launch_root
            .clone()
            .ok_or_else(|| Error::Conflict("engine launch root is not initialized".into()))
    }

    pub(crate) fn active_database_root(&mut self) -> Result<Option<DatabaseRootHandle>, Error> {
        self.resolve_active_root(
            self.active_database_root.clone(),
            PathOperation::DatabaseRead,
        )
        .map(|id| id.map(DatabaseRootHandle::new))
    }

    pub(crate) fn active_puzzle_root(&mut self) -> Result<Option<PuzzleRootDescriptor>, Error> {
        let Some(id) =
            self.resolve_active_root(self.active_puzzle_root.clone(), PathOperation::PuzzleRead)?
        else {
            return Ok(None);
        };
        let display_name = self.root_display_name(&id, "puzzle")?;
        Ok(Some(PuzzleRootDescriptor {
            root: PuzzleRootHandle::new(id),
            display_name,
        }))
    }

    fn root_display_name(&self, id: &PathRef, noun: &str) -> Result<String, Error> {
        Ok(self
            .persistent
            .get(&id.id)
            .ok_or_else(|| {
                Error::Conflict(format!("active {noun} workspace disappeared")).label_root_failure()
            })?
            .stored
            .display_name
            .clone())
    }

    pub(crate) fn database_root_descriptor(
        &self,
        root: DatabaseRootHandle,
    ) -> Result<DatabaseRootDescriptor, Error> {
        let display_name = self.root_display_name(root.path_ref(), "database")?;
        Ok(DatabaseRootDescriptor { root, display_name })
    }

    pub(crate) fn engine_root_descriptor(
        &self,
        root: EngineRootHandle,
    ) -> Result<EngineRootDescriptor, Error> {
        let display_name = self.root_display_name(root.path_ref(), "engine")?;
        Ok(EngineRootDescriptor { root, display_name })
    }

    fn live_practice_stored(&self, id: &PathRef) -> Result<&StoredEntry, Error> {
        if self.pending_unpersisted_removals.contains(&id.id) {
            return Err(Error::InvalidInput(
                "unknown or revoked practice deck".into(),
            ));
        }
        let Some(entry) = self.persistent.get(&id.id) else {
            return Err(Error::InvalidInput(
                "unknown or unauthorized practice deck".into(),
            ));
        };
        Ok(&entry.stored)
    }

    /// Checks a practice deck capability without making availability part of authorisation.
    /// Membership and the operation bit are inspected before refresh so a wrong-purpose id
    /// cannot cause filesystem validation of its target. Migration and repair intentionally pass
    /// `false`: membership is enough for those recovery operations.
    /// Returns the practice storage key callers must use for store addressing.
    pub(crate) fn authorize_practice_deck(
        &mut self,
        id: &PathRef,
        requires_read_pgn: bool,
    ) -> Result<String, Error> {
        let storage_key = {
            let stored = self.live_practice_stored(id)?;
            if requires_read_pgn && !stored.operations.contains(&PathOperation::ReadPgn) {
                return Err(Error::InvalidInput(
                    "unknown or unauthorized practice deck".into(),
                ));
            }
            practice_storage_key(stored).to_owned()
        };
        self.refresh_persistent_id(id);
        Ok(storage_key)
    }

    pub(crate) fn practice_storage_key(&self, id: &PathRef) -> Result<String, Error> {
        Ok(practice_storage_key(self.live_practice_stored(id)?).to_owned())
    }

    pub(crate) fn live_handle_for_practice_storage_key(
        &self,
        key: &str,
    ) -> Result<Option<PathRef>, Error> {
        let mut found = None;
        for entry in self.persistent.values() {
            if self
                .pending_unpersisted_removals
                .contains(&entry.stored.id.id)
            {
                continue;
            }
            if practice_storage_key(&entry.stored) == key {
                if found.is_some() {
                    return Err(Error::Conflict("practice storage key is ambiguous".into()));
                }
                found = Some(entry.stored.id.clone());
            }
        }
        Ok(found)
    }

    #[cfg(test)]
    pub(crate) fn set_practice_key_for_test(&mut self, id: &PathRef, key: impl Into<String>) {
        self.persistent
            .get_mut(&id.id)
            .expect("test registry entry")
            .stored
            .practice_key = Some(key.into());
    }

    pub(crate) fn set_active_database_root(
        &mut self,
        root: &DatabaseRootHandle,
    ) -> Result<(), Error> {
        self.set_active_database_root_core(root, false)
    }

    pub(crate) fn set_active_default_database_root(
        &mut self,
        root: &DatabaseRootHandle,
    ) -> Result<(), Error> {
        self.set_active_database_root_core(root, true)
    }

    fn set_active_database_root_core(
        &mut self,
        root: &DatabaseRootHandle,
        label_root_failure: bool,
    ) -> Result<(), Error> {
        let _ = self.database_root_path(root).map_err(|error| {
            if label_root_failure {
                error.label_root_failure()
            } else {
                error
            }
        })?;
        let active = Some(root.path_ref().clone());
        let durability = self.commit_state(
            self.persistent.clone(),
            active,
            self.active_puzzle_root.clone(),
            self.active_engine_root.clone(),
            self.pending_artifacts.clone(),
            None,
        )?;
        if let CommitDurability::DurabilityUncertain(stage) = durability {
            log::warn!("active database root committed with uncertain durability: {stage}");
        }
        Ok(())
    }

    pub(crate) fn set_active_puzzle_root(&mut self, root: &PuzzleRootHandle) -> Result<(), Error> {
        let _ = self.puzzle_root_path(root)?;
        let durability = self.commit_state(
            self.persistent.clone(),
            self.active_database_root.clone(),
            Some(root.path_ref().clone()),
            self.active_engine_root.clone(),
            self.pending_artifacts.clone(),
            None,
        )?;
        if let CommitDurability::DurabilityUncertain(stage) = durability {
            log::warn!("active puzzle root committed with uncertain durability: {stage}");
        }
        Ok(())
    }

    pub(crate) fn list_puzzle_children_cancellable(
        &mut self,
        root: &PuzzleRootHandle,
        cancellation: &CancellationToken,
    ) -> Result<Vec<PuzzleDatabaseDescriptor>, Error> {
        self.reconcile_db3_listing(
            root.path_ref(),
            EntryPurpose::PuzzleFile,
            PathOperation::PuzzleRead,
            cancellation,
            |authority, filename, display_name, identity| {
                let entry = authority.prepare_puzzle_listing_child(root, &filename, identity)?;
                let id = entry.id();
                Ok((
                    entry,
                    PuzzleDatabaseDescriptor {
                        file: id,
                        filename: display_name,
                    },
                ))
            },
        )
        .map(|(entries, _)| entries)
    }

    fn reconcile_db3_listing<T>(
        &mut self,
        root: &PathRef,
        purpose: EntryPurpose,
        operation: PathOperation,
        cancellation: &CancellationToken,
        mut adapt: impl FnMut(
            &mut Self,
            OsString,
            String,
            (u64, u64),
        ) -> Result<(PreparedEntry, T), Error>,
    ) -> Result<(Vec<T>, Vec<DatabaseUnread>), Error> {
        let snapshot = self.directory_listing_snapshot(root, &[purpose], false, None)?;
        let root_directory = self.capability_directory(root, operation)?;
        let mut prepared = Vec::new();
        let mut unread = Vec::new();
        let mut unread_paths = Vec::new();
        let mut database_names = BTreeMap::new();
        if purpose == EntryPurpose::DatabaseFile {
            for entry in &snapshot.entries {
                if let Some(leaf) = entry.path.to_path()?.file_name() {
                    database_names.insert(nfc_leaf_name(leaf), leaf.to_os_string());
                }
            }
        }
        let children = map_db3_children_cancellable(
            &root_directory,
            cancellation,
            |filename, display_name, identity| {
                if purpose == EntryPurpose::DatabaseFile {
                    let normalized = nfc_leaf_name(&filename);
                    if database_names
                        .get(&normalized)
                        .is_some_and(|name| name != &filename)
                    {
                        return Err(Error::Conflict("database filename already exists".into()));
                    }
                    database_names.insert(normalized, filename.clone());
                }
                let result = identity.and_then(|identity| {
                    let prepared = adapt(self, filename.clone(), display_name.clone(), identity)?;
                    // Probe read access without opening a Unix leaf held by SQLite.
                    let probed = probe_regular_file_at(&root_directory.directory, &filename)?;
                    refuse_unobserved(VerifiedIdentity::from_pair(probed.identity), identity)?;
                    Ok(prepared)
                });
                match result {
                    Ok((entry, child)) => {
                        prepared.push(entry);
                        Ok(Some(child))
                    }
                    Err(error) if purpose == EntryPurpose::PuzzleFile => Err(error),
                    Err(error) => {
                        if let Some(category) = listing_child_outcome(error)? {
                            unread_paths.push((vec![filename], false));
                            unread.push(DatabaseUnread {
                                filename: display_name,
                                category,
                            });
                        }
                        Ok(None)
                    }
                }
            },
        )?;
        let retained = snapshot.retained_ids(&unread_paths)?;
        self.commit_directory_listing(snapshot, prepared, &retained, cancellation)?;
        Ok((children, unread))
    }

    pub(crate) fn puzzle_download_destination(
        &mut self,
        root: &PuzzleRootHandle,
    ) -> Result<PathRef, Error> {
        let _ = self.resolve(root.path_ref(), PathOperation::DownloadFile, &[])?;
        Ok(root.path_ref().clone())
    }

    fn puzzle_root_path(&mut self, root: &PuzzleRootHandle) -> Result<PathBuf, Error> {
        self.root_path(root.path_ref(), PathOperation::PuzzleRead)
    }

    fn prepare_puzzle_listing_child(
        &mut self,
        root: &PuzzleRootHandle,
        filename: &OsStr,
        observed: (u64, u64),
    ) -> Result<PreparedEntry, Error> {
        validate_components(&[filename.to_os_string()])?;
        let resolved = self.resolve(
            root.path_ref(),
            PathOperation::PuzzleRead,
            &[filename.to_os_string()],
        )?;
        let resolved_identity = refuse_unobserved(resolved.identity()?, observed)?;
        let parent_identity = VerifiedIdentity::from_pair(resolved.parent_identity()?);
        #[cfg(test)]
        PUZZLE_CHILD_POST_RESOLVE_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        let path = self.puzzle_root_path(root)?.join(filename);
        let operations = canonical_operations(EntryPurpose::PuzzleFile);
        let (path, binding) = Self::registration_target(
            &path,
            PathClass::PersistentFile,
            &operations,
            Some(resolved_identity),
            Some(parent_identity),
        )?;
        #[cfg(test)]
        PERSISTENT_FILE_POST_TARGET_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        self.prepare_persistent_file(
            &path,
            filename.to_string_lossy().into_owned(),
            operations,
            binding,
            RegistrationDoor::PassiveObservation,
        )
    }

    /// Returns database children known below a root and reconciles newly
    /// discovered native files into persistent opaque handles.  File names are
    /// backend-derived display metadata only; callers cannot feed them back as
    /// paths.
    pub(crate) fn list_database_children_cancellable(
        &mut self,
        root: &DatabaseRootHandle,
        cancellation: &CancellationToken,
    ) -> Result<DatabaseListing, Error> {
        self.reconcile_db3_listing(
            root.path_ref(),
            EntryPurpose::DatabaseFile,
            PathOperation::DatabaseRead,
            cancellation,
            |authority, filename, display_name, identity| {
                let entry = authority.prepare_database_listing_child(
                    root,
                    &filename,
                    display_name.clone(),
                    identity,
                    true,
                )?;
                let id = entry.id();
                Ok((
                    entry,
                    DatabaseDescriptor {
                        handle: DatabaseHandle::new(id),
                        filename: display_name,
                        availability: PathAvailability::Available,
                    },
                ))
            },
        )
        .map(|(entries, unread)| DatabaseListing { entries, unread })
    }

    /// Registers an exact database child after validating it relative to the
    /// root.  This avoids a join-and-open race and preserves non-UTF8 names in
    /// the registry; only lossy display metadata leaves the backend.
    #[cfg(all(test, unix))]
    pub(crate) fn register_database_child(
        &mut self,
        root: &DatabaseRootHandle,
        filename: &OsStr,
        display_name: impl Into<String>,
        observed: (u64, u64),
    ) -> Result<DatabaseHandle, Error> {
        let prepared = self.prepare_database_listing_child(
            root,
            filename,
            display_name.into(),
            observed,
            false,
        )?;
        let commit = self.publish_prepared_entry(prepared)?;
        require_durable(commit.durability)?;
        Ok(DatabaseHandle::new(commit.id))
    }

    fn prepare_database_listing_child(
        &mut self,
        root: &DatabaseRootHandle,
        filename: &OsStr,
        display_name: impl Into<String>,
        observed: (u64, u64),
        // Listing labels a root-acquisition failure so the per-child classifier
        // cannot treat a removed root as a vanished child. Registration and create
        // keep the unlabelled error.
        label_root_acquisition: bool,
    ) -> Result<PreparedEntry, Error> {
        validate_windows_database_leaf(filename)?;
        let components = vec![filename.to_os_string()];
        let resolved = self.resolve(root.path_ref(), PathOperation::DatabaseRead, &components)?;
        let resolved_identity = refuse_unobserved(resolved.identity()?, observed)?;
        #[cfg(test)]
        DATABASE_CHILD_POST_RESOLVE_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        self.prepare_database_child_verified(
            root,
            filename,
            display_name.into(),
            &resolved,
            resolved_identity,
            label_root_acquisition,
        )
    }

    fn register_database_child_verified(
        &mut self,
        root: &DatabaseRootHandle,
        filename: &OsStr,
        display_name: String,
        resolved: &ResolvedPath,
        expected_identity: VerifiedIdentity,
    ) -> Result<DatabaseHandle, Error> {
        let prepared = self.prepare_database_child_verified(
            root,
            filename,
            display_name,
            resolved,
            expected_identity,
            false,
        )?;
        let commit = self.publish_prepared_entry(prepared)?;
        require_durable(commit.durability)?;
        Ok(DatabaseHandle::new(commit.id))
    }

    fn prepare_database_child_verified(
        &mut self,
        root: &DatabaseRootHandle,
        filename: &OsStr,
        display_name: String,
        resolved: &ResolvedPath,
        expected_identity: VerifiedIdentity,
        label_root_acquisition: bool,
    ) -> Result<PreparedEntry, Error> {
        if resolved.parent().is_none() || resolved.leaf().is_none() {
            return Err(Error::InvalidInput(
                "database child has no retained parent boundary".into(),
            ));
        }
        let (a, b) = resolved.parent_identity()?;
        let parent_identity = Identity { a, b };
        let root_path = self.database_root_path(root).map_err(|error| {
            if label_root_acquisition {
                error.label_root_failure()
            } else {
                error
            }
        })?;
        let path = root_path.join(filename);
        let validated_identity =
            validate_target(&path, PathClass::PersistentFile).map_err(|error| {
                if resolved.is_regular_file()
                    && (error.is_missing_entry()
                        || matches!(&error, Error::InvalidInput(message)
                        if message == "file authority must be a regular file"
                            || message == "symbolic links cannot be authorized"))
                {
                    Error::Conflict(VERIFIED_REGISTRATION_CONFLICT.into())
                } else {
                    error
                }
            })?;
        let verified_identity =
            verified_identity::database_child_identity(expected_identity, &validated_identity)?;
        if let Some(entry) = self.persistent.values().find(|entry| {
            entry.stored.class == PathClass::PersistentFile
                && entry.stored.path.to_path().ok().as_ref() == Some(&path)
                && entry.stored.identity == validated_identity
                && entry.stored.parent_identity.as_ref() == Some(&parent_identity)
                && !entry.stored.target_is_dir
                && entry.stored.purpose == Some(EntryPurpose::DatabaseFile)
                && entry
                    .stored
                    .operations
                    .contains(&PathOperation::DatabaseRead)
        }) {
            let mut stored = entry.stored.clone();
            stored.operations = canonical_operations(EntryPurpose::DatabaseFile);
            return Ok(PreparedEntry {
                stored,
                reused: true,
            });
        }
        let id = PathRef::fresh();
        let stored = StoredEntry {
            id: id.clone(),
            display_name,
            class: PathClass::PersistentFile,
            purpose: Some(EntryPurpose::DatabaseFile),
            operations: canonical_operations(EntryPurpose::DatabaseFile),
            path: NativePath::from_path(&path),
            identity: {
                let (a, b) = verified_identity.pair();
                Identity { a, b }
            },
            parent_identity: Some(parent_identity),
            target_is_dir: false,
            practice_key: None,
        };
        Ok(PreparedEntry {
            stored,
            reused: false,
        })
    }

    /// Creates an empty database leaf exactly once below a validated database
    /// root, then persists its opaque identity before returning it.  The
    /// filename is a single native component and cannot escape the root.
    pub(crate) fn create_database_child(
        &mut self,
        root: &DatabaseRootHandle,
        filename: &OsStr,
    ) -> Result<DatabaseHandle, Error> {
        validate_windows_database_leaf(filename)?;
        validate_components(&[filename.to_os_string()])?;
        if std::path::Path::new(filename).extension() != Some(OsStr::new("db3")) {
            return Err(Error::InvalidInput(
                "database filename must end in .db3".into(),
            ));
        }
        let components = vec![filename.to_os_string()];
        let resolved = self.resolve(root.path_ref(), PathOperation::DatabaseCreate, &components)?;
        #[cfg(test)]
        DATABASE_CHILD_POST_RESOLVE_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        let parent = resolved
            .parent()
            .ok_or_else(|| Error::InvalidInput("database child has no retained parent".into()))?;
        let leaf = resolved
            .leaf()
            .ok_or_else(|| Error::InvalidInput("database child has no retained leaf".into()))?;
        if !equivalent_sibling_leaves(parent, leaf, &CancellationToken::new())?.is_empty() {
            return Err(Error::Conflict("database filename already exists".into()));
        }
        let (file, verified_identity) = match resolved.create_database_file() {
            Ok(created) => created,
            Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(Error::Conflict("database filename already exists".into()));
            }
            Err(error) => return Err(error),
        };
        let sync_result = (|| {
            file.sync_all()?;
            parent.sync_all()?;
            Ok::<_, Error>(())
        })();
        if let Err(error) = sync_result {
            return Err(Self::cleanup_created_database_child(
                parent,
                leaf,
                verified_identity,
                error,
            ));
        }
        #[cfg(test)]
        DATABASE_CHILD_POST_CREATE_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        match self.register_database_child_verified(
            root,
            filename,
            filename.to_string_lossy().into_owned(),
            &resolved,
            verified_identity,
        ) {
            Ok(handle) => Ok(handle),
            Err(error @ Error::CommittedDurabilityUncertain(_)) => Err(error),
            Err(error) => Err(Self::cleanup_created_database_child(
                parent,
                leaf,
                verified_identity,
                error,
            )),
        }
    }

    fn cleanup_created_database_child(
        parent: &fs::File,
        leaf: &OsStr,
        identity: VerifiedIdentity,
        primary: Error,
    ) -> Error {
        Error::with_cleanup(
            primary,
            crate::infra::fs::remove_entry_at(parent, leaf, identity.pair(), false),
        )
    }

    pub(crate) fn database_file_target(
        &mut self,
        handle: &DatabaseHandle,
        operation: PathOperation,
    ) -> Result<DatabaseFileTarget, Error> {
        if !is_database_file_operation(operation) {
            return Err(Error::InvalidInput(
                "invalid database file operation".into(),
            ));
        }
        let workspace_handle = FileWorkspaceHandle::new(handle.path_ref().clone());
        let entry = self.persistent_entry_for(&workspace_handle, operation)?;
        if entry.stored.target_is_dir {
            return Err(Error::InvalidInput(
                "database handle must identify a regular file".into(),
            ));
        }
        let stored = entry.stored;
        let expected = (stored.identity.a, stored.identity.b);
        let acquired = acquire_stored_target(
            &stored,
            AcquireShape::File {
                parent_access: parent_access_for_operations(&[operation]),
            },
            "workspace entry is unavailable because its object changed",
        )?;
        let (parent, leaf) = acquired
            .parent_and_leaf
            .ok_or_else(|| Error::InvalidInput("database path needs a leaf name".into()))?;
        verify_parent_identity(&parent, stored.parent_identity.as_ref())?;
        self.session_protected_ids
            .insert(handle.path_ref().id.clone());
        Ok(DatabaseFileTarget::assemble(
            parent,
            leaf,
            expected,
            acquired.path,
        ))
    }

    /// Recovers deletion authority only for an absent leaf in its recorded parent.
    /// A present leaf must pass ordinary database resolution again before deletion.
    pub(crate) fn recover_database_deletion(
        &mut self,
        handle: &DatabaseHandle,
        original: Error,
        cancellation: &CancellationToken,
    ) -> Result<DatabaseDeleteRecovery, Error> {
        let workspace_handle = FileWorkspaceHandle::new(handle.path_ref().clone());
        let entry = self.persistent_entry_for(&workspace_handle, PathOperation::DatabaseMutate)?;
        if entry.stored.target_is_dir {
            return Err(Error::InvalidInput(
                "database handle must identify a regular file".into(),
            ));
        }
        let stored = entry.stored;
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        if stored.parent_identity.is_none() {
            return Err(original);
        }
        let path = stored.path.to_path()?;
        let parent = match crate::infra::fs::open_parent_no_follow(&path) {
            Ok(parent) => parent,
            Err(error) if error.is_missing_entry() => return Err(original),
            Err(error) => return Err(error),
        };
        verify_parent_identity(&parent, stored.parent_identity.as_ref())?;
        let leaf = path
            .file_name()
            .ok_or_else(|| Error::InvalidInput("database path needs a leaf name".into()))?
            .to_os_string();
        let expected = (stored.identity.a, stored.identity.b);
        match crate::infra::fs::entry_identity_at(&parent, &leaf, false) {
            Err(error) if error.is_missing_entry() => {
                self.session_protected_ids
                    .insert(handle.path_ref().id.clone());
                Ok(DatabaseDeleteRecovery::Absent(
                    DatabaseFileTarget::assemble(parent, leaf, expected, path),
                ))
            }
            Ok(identity) if identity == expected => Ok(DatabaseDeleteRecovery::Present),
            Ok(_) => Err(Error::Conflict(
                "workspace entry is unavailable because its object changed".into(),
            )),
            Err(error) => Err(error),
        }
    }

    pub(crate) fn remove_database(&mut self, handle: &DatabaseHandle) -> Result<(), Error> {
        let mut dropped_engine_executables = Vec::new();
        require_durable(
            self.remove_workspace_entry(
                &FileWorkspaceHandle::new(handle.path_ref().clone()),
                WorkspaceRemovalStatus::Complete,
                &mut dropped_engine_executables,
            )?
            .0,
        )
    }

    pub(crate) fn remove_puzzle_database(&mut self, handle: &PathRef) -> Result<(), Error> {
        let mut dropped_engine_executables = Vec::new();
        require_durable(
            self.remove_workspace_entry(
                &FileWorkspaceHandle::new(handle.clone()),
                WorkspaceRemovalStatus::Complete,
                &mut dropped_engine_executables,
            )?
            .0,
        )
    }

    fn database_root_path(&mut self, root: &DatabaseRootHandle) -> Result<PathBuf, Error> {
        self.root_path(root.path_ref(), PathOperation::DatabaseRead)
    }

    pub(crate) fn database_download_destination(
        &mut self,
        root: &DatabaseRootHandle,
    ) -> Result<PathRef, Error> {
        let _ = self.resolve(root.path_ref(), PathOperation::DownloadFile, &[])?;
        Ok(root.path_ref().clone())
    }

    pub(crate) fn collection_batch_destination(
        &mut self,
        directory: &AuthorizedDir,
    ) -> Result<PathRef, Error> {
        self.get_or_create_root(
            directory.path(),
            "Account download staging",
            canonical_operations(EntryPurpose::DownloadDestination),
            "download",
            Some(VerifiedIdentity::from_pair(directory.identity)),
        )
    }

    /// Copies the authority markers needed to classify a download before a single-use dialog
    /// grant is consumed by [`Self::resolve`].
    pub(crate) fn download_operations(
        &mut self,
        id: &PathRef,
    ) -> Result<Vec<PathOperation>, Error> {
        self.evict_dialogs();
        if self.pending_unpersisted_removals.contains(&id.id) {
            return Err(Error::InvalidInput(
                "workspace entry is not persistent".into(),
            ));
        }
        if let Some(operations) = self
            .persistent
            .get(&id.id)
            .map(|entry| entry.stored.operations.clone())
        {
            self.session_protected_ids.insert(id.id.clone());
            return Ok(operations);
        }
        self.dialogs
            .get(&id.id)
            .map(|grant| grant.entry.stored.operations.clone())
            .ok_or_else(|| Error::InvalidInput("unknown, revoked, or expired path grant".into()))
    }

    pub(crate) fn download_destination_is_known(&self, id: &PathRef) -> bool {
        !self.pending_unpersisted_removals.contains(&id.id)
            && self.persistent.get(&id.id).is_some_and(|entry| {
                entry.stored.purpose == Some(EntryPurpose::DownloadDestination)
            })
    }

    pub(crate) fn reconcile_startup_owners(
        &mut self,
        owners: StartupPathOwners,
    ) -> Result<CommitDurability, Error> {
        if owners.retained_ids.len()
            > self
                .authority_id_input_limit()
                .saturating_add(MAX_OWNER_UNKNOWN_IDS)
            || owners.trusted_families.len() > MAX_TRUSTED_OWNER_FAMILIES
        {
            return Err(Error::ResourceLimit(
                "startup path owner input exceeds its limit".into(),
            ));
        }
        let retained: BTreeSet<_> = owners
            .retained_ids
            .into_iter()
            .map(|path_ref| path_ref.id)
            .filter(|id| self.persistent.contains_key(id))
            .collect();
        let trusted: BTreeSet<_> = owners.trusted_families.into_iter().collect();
        let effective_trusted: BTreeSet<_> = trusted
            .union(&self.completed_owner_families)
            .copied()
            .collect();
        let active_roots = [
            self.active_database_root.as_ref(),
            self.active_puzzle_root.as_ref(),
            self.active_engine_root.as_ref(),
        ]
        .into_iter()
        .flatten()
        .map(|path_ref| path_ref.id.as_str())
        .collect::<BTreeSet<_>>();
        let pending_ids = self
            .pending_artifacts
            .iter()
            .flat_map(|pending| [pending.id.id.as_str(), pending.root.id.as_str()])
            .collect::<BTreeSet<_>>();
        let mut candidate = self.persistent.clone();
        candidate.retain(|id, entry| {
            if !self.loaded_candidate_ids.contains(id)
                || self.session_protected_ids.contains(id)
                || self
                    .completion_resources
                    .values()
                    .flatten()
                    .any(|resource| &resource.id == id)
                || retained.contains(id)
                || self.startup_retained_ids.contains(id)
                || active_roots.contains(id.as_str())
                || pending_ids.contains(id.as_str())
            {
                return true;
            }
            let Some(purpose) = entry.stored.purpose else {
                return true;
            };
            let Some(families) = owner_families_for_purpose(purpose) else {
                return true;
            };
            if families.is_empty() && self.startup_unowned_roots_reconciled {
                return true;
            }
            !families
                .iter()
                .all(|family| effective_trusted.contains(family))
        });
        let durability = if candidate.len() == self.persistent.len() {
            if self.registry_durability_pending {
                self.retry_registry_durability()?;
            }
            CommitDurability::Durable
        } else {
            self.commit_candidate(candidate, None)?
        };
        if durability == CommitDurability::Durable {
            self.completed_owner_families.extend(trusted);
            self.startup_retained_ids.extend(retained);
            self.startup_unowned_roots_reconciled = true;
        }
        Ok(durability)
    }

    fn attachment_entry(entry: &Entry) -> bool {
        is_attachment_purpose(entry.stored.purpose)
    }

    pub(crate) fn seal_engine_attachments(&mut self) {
        self.attachments_sealed = true;
    }

    pub(crate) fn begin_engine_image_issuance(
        &mut self,
    ) -> Result<ActiveImageIssuanceLease, Error> {
        if self.attachments_sealed {
            return Err(Error::Conflict(
                "engine attachment mutations are sealed".into(),
            ));
        }
        self.active_image_issuances
            .active
            .fetch_add(1, Ordering::AcqRel);
        Ok(ActiveImageIssuanceLease {
            tracker: Arc::clone(&self.active_image_issuances),
        })
    }

    pub(crate) fn active_image_issuances(&self) -> Arc<ActiveImageIssuances> {
        Arc::clone(&self.active_image_issuances)
    }

    #[cfg(test)]
    pub(crate) fn engine_attachments_are_sealed(&self) -> bool {
        self.attachments_sealed
    }

    fn authority_id_input_limit(&self) -> usize {
        self.registry_admission_units()
            .max(MAX_AUTHORITY_REQUEST_IDS)
    }

    fn retry_registry_durability(&mut self) -> Result<(), Error> {
        let durability = self.save_entries(
            &self.persistent,
            &self.active_database_root,
            &self.active_puzzle_root,
            &self.active_engine_root,
            &self.pending_artifacts,
        )?;
        match durability {
            CommitDurability::Durable => {
                self.registry_durability_pending = false;
                Ok(())
            }
            CommitDurability::DurabilityUncertain(stage) => {
                self.registry_durability_pending = true;
                Err(Error::CommittedDurabilityUncertain(stage))
            }
        }
    }

    /// Applies one validated whole attachment transaction. Retired entries remain resolvable only
    /// in this process; only the authority and cleanup intent are written to the registry.
    pub(crate) fn reconcile_engine_attachments(
        &mut self,
        action: EngineAttachmentAction,
    ) -> Result<(), Error> {
        if self.attachments_sealed {
            return Err(Error::Conflict(
                "engine attachment mutations are sealed".into(),
            ));
        }
        let (retained, abandoned, startup, reconcile) = match action {
            EngineAttachmentAction::Prepare { retained_ids } => {
                (Some(retained_ids), Vec::new(), false, false)
            }
            EngineAttachmentAction::Reconcile {
                retained_ids,
                abandoned_ids,
                startup,
            } => (retained_ids, abandoned_ids, startup, true),
        };
        if retained.as_ref().is_some_and(|ids| {
            ids.len()
                > self
                    .authority_id_input_limit()
                    .saturating_add(MAX_OWNER_UNKNOWN_IDS)
        }) || abandoned.len() > self.authority_id_input_limit()
            || (startup && retained.is_none())
        {
            return Err(Error::ResourceLimit(
                "engine attachment action exceeds its limit".into(),
            ));
        }
        let mut retained_ids = BTreeSet::new();
        for id in retained.as_ref().into_iter().flatten().map(|id| &id.id) {
            let Some(entry) = self
                .persistent
                .get(id)
                .or_else(|| self.retired_attachments.get(id))
            else {
                continue;
            };
            if !Self::attachment_entry(entry) {
                return Err(Error::InvalidInput(
                    "retained capability is not an engine attachment".into(),
                ));
            }
            retained_ids.insert(id.clone());
        }
        for id in abandoned.iter().map(|id| &id.id) {
            if let Some(entry) = self
                .persistent
                .get(id)
                .or_else(|| self.retired_attachments.get(id))
            {
                if !Self::attachment_entry(entry) {
                    return Err(Error::InvalidInput(
                        "abandoned capability is not an engine attachment".into(),
                    ));
                }
            }
        }

        let old_provisional = self.provisional_attachments.clone();
        let old_cleanup = self.image_cleanup.clone();
        let old_retired = self.retired_attachments.clone();
        let old_admission = self.registry_admission_snapshot(
            &self.persistent,
            &self.active_database_root,
            &self.active_puzzle_root,
            &self.active_engine_root,
            &self.pending_artifacts,
            &old_provisional,
            &old_retired,
            &old_cleanup,
        )?;
        let mut candidate = self.persistent.clone();
        let mut readopted_retired_ids = Vec::new();
        for id in &retained_ids {
            if let Some(entry) = self.retired_attachments.get(id).cloned() {
                candidate.insert(id.clone(), entry);
                readopted_retired_ids.push(id.clone());
            }
            self.provisional_attachments.remove(id);
            self.image_cleanup.remove(id);
        }
        if reconcile {
            let abandon_only = retained.is_none();
            let explicit_abandoned: BTreeSet<_> = abandoned.into_iter().map(|id| id.id).collect();
            let retire_ids = candidate
                .iter()
                .filter_map(|(id, entry)| {
                    if !Self::attachment_entry(entry) || retained_ids.contains(id) {
                        return None;
                    }
                    let provisional = self.provisional_attachments.contains(id);
                    let explicitly_abandoned = explicit_abandoned.contains(id);
                    let should_retire = if abandon_only {
                        explicitly_abandoned && provisional
                    } else {
                        explicitly_abandoned
                            || (!provisional
                                && !(startup && self.session_protected_ids.contains(id)))
                            || (startup
                                && self.loaded_candidate_ids.contains(id)
                                && !self.session_protected_ids.contains(id))
                    };
                    should_retire.then(|| id.clone())
                })
                .collect::<Vec<_>>();
            for id in retire_ids {
                if let Some(entry) = candidate.remove(&id) {
                    self.provisional_attachments.remove(&id);
                    if entry.stored.purpose == Some(EntryPurpose::EngineImage) {
                        self.image_cleanup.insert(id.clone(), entry.stored.clone());
                    }
                    self.retired_attachments.insert(id, entry);
                }
            }
        }
        if candidate == self.persistent
            && self.provisional_attachments == old_provisional
            && self.image_cleanup == old_cleanup
            && self.retired_attachments == old_retired
        {
            if self.registry_durability_pending {
                return self.retry_registry_durability();
            }
            return Ok(());
        }
        match self.commit_candidate_with_pending_baseline(
            candidate,
            self.pending_artifacts.clone(),
            None,
            Some(old_admission),
        ) {
            Ok(durability) => {
                for id in readopted_retired_ids {
                    self.retired_attachments.remove(&id);
                }
                match durability {
                    CommitDurability::Durable => {
                        self.registry_durability_pending = false;
                        Ok(())
                    }
                    CommitDurability::DurabilityUncertain(stage) => {
                        self.registry_durability_pending = true;
                        Err(Error::CommittedDurabilityUncertain(stage))
                    }
                }
            }
            Err(error) => {
                self.provisional_attachments = old_provisional;
                self.image_cleanup = old_cleanup;
                self.retired_attachments = old_retired;
                Err(error)
            }
        }
    }

    pub(crate) fn set_engine_image_sweep_root(&mut self, root: Option<AppDataDir>) {
        self.engine_image_sweep_root = root;
    }

    /// Seals attachment mutations before process teardown. Cleanup never follows a stored path:
    /// intents use the caller's directory, and the orphan sweep uses the retained admitted root.
    pub(crate) fn cleanup_engine_images(
        &mut self,
        image_dir: &AuthorizedDir,
        seal: bool,
    ) -> Result<(), Error> {
        if seal {
            self.seal_engine_attachments();
        }
        if self.image_cleanup.is_empty() {
            if self.registry_durability_pending {
                self.retry_registry_durability()?;
            }
            self.sweep_engine_image_orphans();
            return Ok(());
        }
        let ids = self.image_cleanup.keys().cloned().collect::<Vec<_>>();
        let original_cleanup = self.image_cleanup.clone();
        let mut next_cleanup = original_cleanup.clone();
        let mut failures = Vec::new();
        let mut registry_persistence_error = None;
        for id in ids {
            let Some(stored) = original_cleanup.get(&id).cloned() else {
                continue;
            };
            let Ok(path) = stored.path.to_path() else {
                next_cleanup.remove(&id);
                continue;
            };
            let Some(leaf) = path.file_name() else {
                next_cleanup.remove(&id);
                continue;
            };
            let valid_uuid = uuid::Uuid::parse_str(&leaf.to_string_lossy()).is_ok();
            if !valid_uuid || path.parent() != Some(image_dir.path()) {
                next_cleanup.remove(&id);
                continue;
            }
            let acquired = match image_dir.open_leaf_identified(leaf) {
                Ok(identity) if identity.agrees_with(&stored.identity) => identity,
                Ok(_) => {
                    next_cleanup.remove(&id);
                    continue;
                }
                Err(error) if error.is_missing_entry() => {
                    next_cleanup.remove(&id);
                    continue;
                }
                Err(Error::Conflict(_)) => {
                    next_cleanup.remove(&id);
                    continue;
                }
                Err(error) => {
                    failures.push(error);
                    continue;
                }
            };
            match image_dir.remove_leaf_identified(leaf, acquired) {
                Ok(()) => {
                    next_cleanup.remove(&id);
                }
                Err(error) if error.is_missing_entry() => {
                    next_cleanup.remove(&id);
                }
                Err(Error::Conflict(_)) => {
                    // A substituted leaf is not ours. Complete the obsolete intent without unlinking.
                    next_cleanup.remove(&id);
                }
                Err(error) => failures.push(error),
            }
        }
        if next_cleanup != original_cleanup {
            self.image_cleanup = next_cleanup;
            let durability = self.save_entries(
                &self.persistent,
                &self.active_database_root,
                &self.active_puzzle_root,
                &self.active_engine_root,
                &self.pending_artifacts,
            );
            match durability {
                Ok(CommitDurability::Durable) => {
                    self.registry_durability_pending = false;
                }
                Ok(CommitDurability::DurabilityUncertain(stage)) => {
                    log::warn!(
                        "engine image cleanup registry sync is uncertain at {stage}; completed intents are adopted"
                    );
                    self.registry_durability_pending = true;
                    registry_persistence_error = Some(Error::CommittedDurabilityUncertain(stage));
                }
                Err(error) => {
                    self.image_cleanup = original_cleanup;
                    return match failures.into_iter().next() {
                        Some(cleanup) => Err(Error::with_cleanup(error, Err(cleanup))),
                        None => Err(error),
                    };
                }
            }
        } else if self.registry_durability_pending {
            registry_persistence_error = self.retry_registry_durability().err();
        }
        if let Some(error) = registry_persistence_error {
            return match failures.into_iter().next() {
                Some(cleanup) => Err(Error::with_cleanup(error, Err(cleanup))),
                None => Err(error),
            };
        }
        if let Some(error) = failures.into_iter().next() {
            return Err(error);
        }
        self.sweep_engine_image_orphans();
        Ok(())
    }

    fn sweep_engine_image_orphans(&mut self) {
        let Some(root) = self.engine_image_sweep_root.as_ref() else {
            return;
        };
        if self.active_image_issuances.active.load(Ordering::Acquire) != 0 {
            return;
        }
        let image_dir = match ensure_app_owned_default_dir(root, AppOwnedDefaultRoot::EngineImages)
        {
            Ok(image_dir) => image_dir,
            Err(error) => {
                log::warn!(
                    "engine image orphan sweep directory derivation failed: {}",
                    error.category()
                );
                return;
            }
        };
        let mut protected = BTreeSet::new();
        for stored in self
            .persistent
            .values()
            .chain(self.retired_attachments.values())
            .map(|entry| &entry.stored)
            .chain(self.image_cleanup.values())
        {
            let path = match stored.path.to_path() {
                Ok(path) => path,
                Err(error) => {
                    log::warn!(
                        "engine image orphan sweep skipped for unreadable reference: {}",
                        error.category()
                    );
                    return;
                }
            };
            let Some(leaf) = path.file_name().filter(|_| has_normal_leaf(&path)) else {
                log::warn!(
                    "engine image orphan sweep skipped for leafless reference: {}",
                    ErrorCategory::InvalidInput
                );
                return;
            };
            protected.insert(leaf.to_ascii_lowercase());
        }
        let entries = match read_directory_entries_at(
            image_dir.directory.as_file(),
            &CancellationToken::new(),
            Some(MAX_ENGINE_IMAGE_SWEEP_ENTRIES),
            &mut |_| true,
        ) {
            Ok(entries) => entries,
            Err(error) => {
                log::warn!(
                    "engine image orphan sweep listing failed: {}",
                    error.category()
                );
                return;
            }
        };
        for entry in entries {
            Self::sweep_engine_image_candidate(&image_dir, &protected, &entry);
        }
    }

    fn sweep_engine_image_candidate(
        image_dir: &AuthorizedDir,
        protected: &BTreeSet<OsString>,
        entry: &DirectoryEntry,
    ) {
        if entry.kind != DirectoryEntryKind::RegularFile
            || protected.contains(&entry.name.to_ascii_lowercase())
        {
            return;
        }
        let Some(name) = entry.name.to_str() else {
            return;
        };
        if Uuid::parse_str(name).is_err()
            && !name
                .strip_prefix(".atomic-")
                .is_some_and(|suffix| Uuid::parse_str(suffix).is_ok())
        {
            return;
        }
        let identity = match image_dir.open_leaf_identified(&entry.name) {
            Ok(identity) if identity.pair() == entry.identity => identity,
            Ok(_) => return,
            Err(error) if error.is_missing_entry() => return,
            Err(Error::Conflict(_)) => return,
            Err(error) => {
                log::warn!(
                    "engine image orphan sweep open failed for {name}: {}",
                    error.category()
                );
                return;
            }
        };
        if let Err(error) = image_dir.remove_leaf_identified(&entry.name, identity) {
            log::warn!(
                "engine image orphan sweep removal failed for {name}: {}",
                error.category()
            );
        }
    }

    pub fn resolve(
        &mut self,
        id: &PathRef,
        operation: PathOperation,
        components: &[OsString],
    ) -> Result<ResolvedPath, Error> {
        self.resolve_with_engine_probe(id, operation, components, &mut EngineRootProbe::default())
    }

    pub(crate) fn resolve_with_engine_probe(
        &mut self,
        id: &PathRef,
        operation: PathOperation,
        components: &[OsString],
        probe: &mut EngineRootProbe,
    ) -> Result<ResolvedPath, Error> {
        validate_components(components)?;
        if self.pending_unpersisted_removals.contains(&id.id) {
            return Err(Error::InvalidInput(
                "workspace entry is not persistent".into(),
            ));
        }
        let stored_entry = self
            .persistent
            .get(&id.id)
            .or_else(|| self.retired_attachments.get(&id.id))
            .cloned();
        let parent_binding = stored_entry
            .as_ref()
            .map(|entry| &entry.stored.parent_identity);
        let entry = match stored_entry.as_ref() {
            Some(entry) => entry.clone(),
            None => self.take_dialog(id, Some(operation))?.entry,
        };
        if !entry.stored.operations.contains(&operation) {
            return Err(Error::InvalidInput(
                "path capability does not permit this operation".into(),
            ));
        }
        let engine_root = is_engine_root_use(&entry.stored, operation);
        let root_error = |error: Error| {
            if engine_root {
                error.label_root_failure()
            } else {
                error
            }
        };
        let root = entry.stored.path.to_path().map_err(root_error)?;
        let actual = validate_target(
            &root,
            if entry.stored.target_is_dir {
                PathClass::PersistentCustomRoot
            } else {
                PathClass::PersistentFile
            },
        )
        .map_err(root_error)?;
        if actual != entry.stored.identity {
            return Err(root_error(Error::Conflict(
                "path authority is unavailable because its object changed".into(),
            )));
        }
        #[cfg(test)]
        RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        #[cfg(unix)]
        let resolved = resolved::resolve_unix(
            &root,
            &entry.stored.identity,
            entry.stored.target_is_dir,
            parent_binding,
            components,
            operation,
            engine_root.then_some(&entry.stored),
        );
        #[cfg(windows)]
        let resolved = resolved::resolve_windows(
            &root,
            &entry.stored.identity,
            entry.stored.target_is_dir,
            parent_binding,
            components,
            operation,
            engine_root.then_some(&entry.stored),
        );
        let resolved = if engine_root {
            probe.filesystem(resolved)
        } else {
            resolved
        };
        if let Ok(resolved) = &resolved {
            if let Some(target) = resolved.target() {
                let recursive = operation == PathOperation::EngineResourceRead
                    && resolved.directory().is_some();
                let child_use = matches!(
                    operation,
                    PathOperation::EngineExecute
                        | PathOperation::EngineConfigure
                        | PathOperation::EngineResourceRead
                ) || (operation == PathOperation::EngineInstall
                    && resolved.is_regular_file());
                // Components may select a different object from the stored root. Capture
                // the validated terminal descriptor before any child handoff, never reopen
                // the pathname to recover this use's identity.
                let terminal = if let Some(file) = resolved.file() {
                    Some(opened_file_identity(file)?)
                } else if let Some(directory) = resolved.directory() {
                    Some(opened_file_identity(directory)?)
                } else {
                    #[cfg(unix)]
                    {
                        resolved.observed_file_identity()
                    }
                    #[cfg(not(unix))]
                    {
                        None
                    }
                }
                .map(|(a, b)| Identity { a, b });
                let mut contexts = vec![(target, recursive, terminal)];
                if child_use
                    && resolved.is_regular_file()
                    && operation != PathOperation::EngineResourceRead
                {
                    // Native execution uses the image's parent as cwd. Capture that validated
                    // held object separately as a node, without recursive ownership of siblings.
                    let (a, b) = resolved.parent_identity()?;
                    let cwd = target.parent().ok_or_else(|| {
                        Error::Conflict("resolved executable has no working directory".into())
                    })?;
                    contexts.push((cwd, false, Some(Identity { a, b })));
                }
                self.protect_catalog_contexts(&contexts, child_use)?;
            }
        }
        if resolved.is_ok() && self.persistent.contains_key(&id.id) {
            self.session_protected_ids.insert(id.id.clone());
        }
        resolved
    }

    /// Confirm a previously installed source through its current authority binding. A private
    /// registry or cache sync cannot establish durability of the source directory entry.
    pub(crate) fn confirm_collection_source_durability(
        &mut self,
        file: &FileWorkspaceHandle,
    ) -> Result<(), Error> {
        let resolved = self.resolve(file.path_ref(), PathOperation::ReadPgn, &[])?;
        let snapshot = resolved.pgn_snapshot()?;
        #[cfg(test)]
        crate::infra::fs::inject_atomic_file(crate::infra::fs::AtomicFileFaultPoint::FileSync)?;
        snapshot.file.sync_all()?;
        let parent = resolved.parent().ok_or(Error::StaleGame)?;
        #[cfg(test)]
        crate::infra::fs::inject_atomic_file(crate::infra::fs::AtomicFileFaultPoint::ParentSync)?;
        parent.sync_all()?;
        let current = self
            .resolve(file.path_ref(), PathOperation::ReadPgn, &[])?
            .pgn_snapshot()?;
        if current.identity != snapshot.identity || current.revision != snapshot.revision {
            return Err(Error::StaleGame);
        }
        Ok(())
    }

    pub(crate) fn rebind_pgn_file_after_replace(
        &mut self,
        id: &PathRef,
        expected_identity: (u64, u64),
        installed_identity: (u64, u64),
    ) -> Result<(), Error> {
        let Some(entry) = self.persistent.get(&id.id) else {
            return Ok(());
        };
        if entry.stored.class != PathClass::PersistentFile || entry.stored.target_is_dir {
            return Ok(());
        }
        if !entry.stored.operations.contains(&PathOperation::WritePgn) {
            return Err(Error::Conflict(
                "path capability no longer permits PGN writes".into(),
            ));
        }
        if entry.stored.identity
            != (Identity {
                a: expected_identity.0,
                b: expected_identity.1,
            })
        {
            return Err(Error::Conflict(
                "path capability changed before PGN authority rebind".into(),
            ));
        }
        if expected_identity == installed_identity {
            return Ok(());
        }

        let mut candidate = self.persistent.clone();
        let Some(entry) = candidate.get_mut(&id.id) else {
            return Err(Error::Conflict(
                "path capability disappeared before PGN authority rebind".into(),
            ));
        };
        entry.stored.identity = Identity {
            a: installed_identity.0,
            b: installed_identity.1,
        };
        entry.availability = PathAvailability::Available;
        require_durable(self.commit_candidate(candidate, None)?)
    }

    /// Active and pending collection owners recover only their UUID-derived disposable cache.
    /// A remembered capability must qualify against the retained private root before renewal.
    pub(crate) fn acquire_collection_cache(
        &mut self,
        root: &AuthorizedDir,
        collection: Uuid,
        handle: Option<&DatabaseHandle>,
        display_name: String,
    ) -> Result<DatabaseHandle, Error> {
        let leaf = format!("{collection}.db3");
        let target = root.database_target(OsStr::new(&leaf))?;
        let parent = opened_file_identity(root.descriptor())?;
        let remembered = if let Some(handle) = handle {
            Some(handle.clone())
        } else {
            let mut matching = self.persistent.values().filter(|entry| {
                entry
                    .stored
                    .path
                    .to_path()
                    .is_ok_and(|path| path == target.path())
            });
            let remembered = matching
                .next()
                .map(|entry| DatabaseHandle::new(entry.stored.id.clone()));
            if matching.next().is_some() {
                return Err(Error::Conflict(
                    "collection cache authority is ambiguous".into(),
                ));
            }
            remembered
        };
        let Some(handle) = remembered else {
            let commit = self.get_or_create_persistent_file_verified(
                target.path(),
                display_name,
                vec![PathOperation::DatabaseRead, PathOperation::DatabaseExport],
                VerifiedIdentity::from_pair(target.identity()),
                VerifiedIdentity::from_pair(parent),
                RegistrationDoor::ExplicitReauthorization,
            )?;
            require_durable(commit.durability)?;
            return Ok(DatabaseHandle::new(commit.id));
        };
        let entry = self
            .persistent
            .get(&handle.path_ref().id)
            .ok_or_else(|| Error::Conflict("collection cache authority is unavailable".into()))?;
        if entry.stored.class != PathClass::PersistentFile
            || entry.stored.target_is_dir
            || entry.stored.purpose.is_some()
            || !same_operation_set(
                &entry.stored.operations,
                &[PathOperation::DatabaseRead, PathOperation::DatabaseExport],
            )
            || entry.stored.path.to_path()? != target.path()
            || entry
                .stored
                .parent_identity
                .as_ref()
                .map(|identity| (identity.a, identity.b))
                != Some(parent)
        {
            return Err(Error::Conflict(
                "collection cache authority does not match its owned root".into(),
            ));
        }
        let identity = Identity {
            a: target.identity().0,
            b: target.identity().1,
        };
        if entry.stored.identity == identity {
            return Ok(handle);
        }
        let mut candidate = self.persistent.clone();
        let entry = candidate
            .get_mut(&handle.path_ref().id)
            .ok_or_else(|| Error::Conflict("collection cache authority is unavailable".into()))?;
        entry.stored.identity = identity;
        entry.availability = PathAvailability::Available;
        require_durable(self.commit_candidate(candidate, None)?)?;
        Ok(handle)
    }

    /// Releases a completed collection batch's read-only grant after its owned file is removed.
    pub(crate) fn forget_collection_batch(
        &mut self,
        handle: &FileWorkspaceHandle,
        root: &AuthorizedDir,
        leaf: &OsStr,
        expected: (u64, u64),
    ) -> Result<(), Error> {
        crate::infra::fs::single_leaf(leaf)?;
        let Some(entry) = self.persistent.get(&handle.path_ref().id) else {
            return Ok(());
        };
        if entry.stored.class != PathClass::PersistentFile
            || entry.stored.target_is_dir
            || !same_operation_set(&entry.stored.operations, &[PathOperation::ReadPgn])
            || entry.stored.path.to_path()? != root.path().join(leaf)
            || (entry.stored.identity.a, entry.stored.identity.b) != expected
            || entry
                .stored
                .parent_identity
                .as_ref()
                .map(|identity| (identity.a, identity.b))
                != Some(opened_file_identity(root.descriptor())?)
        {
            return Err(Error::Conflict(
                "collection batch authority does not match its owned root".into(),
            ));
        }
        let mut dropped = Vec::new();
        require_durable(
            self.remove_workspace_entry(handle, WorkspaceRemovalStatus::Complete, &mut dropped)?
                .0,
        )
    }

    /// Renderer-safe display metadata for a capability.  This is deliberately
    /// a label, not a path or component list.
    pub(crate) fn display_name(&mut self, id: &PathRef) -> Result<String, Error> {
        self.refresh_persistent_id(id);
        let display_name = self
            .persistent
            .get(&id.id)
            .filter(|entry| entry.availability == PathAvailability::Available)
            .map(|entry| entry.stored.display_name.clone())
            .ok_or_else(|| Error::InvalidInput("unknown or unavailable path capability".into()))?;
        self.session_protected_ids.insert(id.id.clone());
        Ok(display_name)
    }

    /// Returns the native root for a persistent, directory-backed workspace after checking its
    /// identity and required operation. This is intentionally crate-private: renderer code only
    /// ever receives [`FileWorkspaceHandle`], while native workspace commands use this one
    /// authority boundary for every filesystem operation.
    pub(crate) fn workspace_root(
        &mut self,
        workspace: &FileWorkspaceHandle,
        operation: PathOperation,
    ) -> Result<PathBuf, Error> {
        let entry = self
            .persistent
            .get(&workspace.path_ref().id)
            .cloned()
            .ok_or_else(|| Error::InvalidInput("workspace is not persistent".into()))?;
        if !entry.stored.target_is_dir || !entry.stored.operations.contains(&operation) {
            return Err(Error::InvalidInput(
                "workspace does not permit this operation".into(),
            ));
        }
        let acquired = acquire_stored_target(
            &entry.stored,
            AcquireShape::Root {
                parent_access: parent_access_for_operations(&[operation]),
            },
            "workspace is unavailable because its root changed",
        )?;
        self.session_protected_ids
            .insert(workspace.path_ref().id.clone());
        Ok(acquired.path)
    }

    /// Persists an opaque child handle for an entry observed through a retained directory
    /// descriptor. The supplied identity is the one captured during enumeration.
    pub(crate) fn register_workspace_child_observed_with_parent(
        &mut self,
        workspace: &FileWorkspaceHandle,
        components: &[OsString],
        display_name: impl Into<String>,
        binding: IdentityBinding,
        is_dir: bool,
        operation: PathOperation,
    ) -> Result<FileWorkspaceHandle, Error> {
        let prepared = self.prepare_workspace_listing_child(
            workspace,
            components,
            display_name,
            binding,
            is_dir,
            operation,
        )?;
        let commit = self.publish_prepared_entry(prepared)?;
        require_durable(commit.durability)?;
        Ok(FileWorkspaceHandle::new(commit.id))
    }

    pub(crate) fn prepare_workspace_listing_child(
        &mut self,
        workspace: &FileWorkspaceHandle,
        components: &[OsString],
        display_name: impl Into<String>,
        binding: IdentityBinding,
        is_dir: bool,
        operation: PathOperation,
    ) -> Result<PreparedEntry, Error> {
        validate_components(components)?;
        if components.is_empty() {
            return Err(Error::InvalidInput("workspace child is required".into()));
        }
        let root_entry = self
            .persistent
            .get(&workspace.path_ref().id)
            .cloned()
            .ok_or_else(|| Error::InvalidInput("workspace is not persistent".into()))?;
        if !root_entry.stored.target_is_dir || !root_entry.stored.operations.contains(&operation) {
            return Err(Error::InvalidInput("invalid PGN workspace root".into()));
        }
        let root = root_entry.stored.path.to_path()?;
        let path = components.iter().fold(root, |mut path, component| {
            path.push(component);
            path
        });
        let class = if is_dir {
            PathClass::PersistentCustomRoot
        } else {
            PathClass::PersistentFile
        };
        self.prepare_workspace_child(
            root_entry,
            path,
            display_name.into(),
            class,
            binding,
            is_dir,
        )
    }

    #[cfg(test)]
    pub(crate) fn register_workspace_child_observed(
        &mut self,
        workspace: &FileWorkspaceHandle,
        components: &[OsString],
        display_name: impl Into<String>,
        identity: (u64, u64),
        is_dir: bool,
        operation: PathOperation,
    ) -> Result<FileWorkspaceHandle, Error> {
        let root_entry = self
            .persistent
            .get(&workspace.path_ref().id)
            .expect("test workspace is persistent");
        let path =
            components
                .iter()
                .fold(root_entry.stored.path.to_path()?, |mut path, component| {
                    path.push(component);
                    path
                });
        let parent = crate::infra::fs::open_parent_no_follow(&path)?;
        self.register_workspace_child_observed_with_parent(
            workspace,
            components,
            display_name,
            IdentityBinding::from_pairs(identity, opened_file_identity(&parent)?),
            is_dir,
            operation,
        )
    }

    fn prepare_workspace_child(
        &self,
        root_entry: Entry,
        path: PathBuf,
        display_name: String,
        class: PathClass,
        binding: IdentityBinding,
        is_dir: bool,
    ) -> Result<PreparedEntry, Error> {
        let parent_identity = if is_dir {
            None
        } else {
            Some(binding.parent_identity.clone().ok_or_else(|| {
                Error::InvalidInput("workspace file has no observed parent identity".into())
            })?)
        };
        let purpose =
            (root_entry.stored.purpose == Some(EntryPurpose::PgnWorkspace)).then_some(if is_dir {
                EntryPurpose::PgnWorkspace
            } else {
                EntryPurpose::PgnFile
            });
        if let Some((id, entry)) = self.persistent.iter().find(|(_, entry)| {
            entry.stored.class == class
                && entry.stored.path.to_path().ok().as_ref() == Some(&path)
                && entry.stored.identity == binding.identity
                && entry.stored.parent_identity == parent_identity
                && entry.stored.target_is_dir == is_dir
                && entry.stored.purpose == purpose
                && (purpose.is_some()
                    || same_operation_set(&entry.stored.operations, &root_entry.stored.operations))
        }) {
            let mut stored = entry.stored.clone();
            stored.id = PathRef { id: id.clone() };
            if let Some(purpose) = purpose {
                stored.operations = canonical_operations(purpose);
            }
            return Ok(PreparedEntry {
                stored,
                reused: true,
            });
        }
        let id = PathRef::fresh();
        let stored = StoredEntry {
            id: id.clone(),
            display_name,
            class,
            purpose,
            operations: purpose
                .map(canonical_operations)
                .unwrap_or(root_entry.stored.operations),
            path: NativePath::from_path(&path),
            identity: binding.identity,
            parent_identity,
            target_is_dir: is_dir,
            practice_key: None,
        };
        Ok(PreparedEntry {
            stored,
            reused: false,
        })
    }

    /// Persists a recovery intent before the download target is mutated. It binds the root inode,
    /// single leaf, and the caller-supplied SHA-256/size of the already-complete staging payload.
    /// The reservation has no renderer-visible capability and cannot be used to access the target
    /// until activation.
    pub(crate) fn reserve_download_artifact(
        &mut self,
        root: &PathRef,
        filename: OsString,
        (payload_size, payload_sha256): (u64, String),
        display_name: impl Into<String>,
        operations: Vec<PathOperation>,
    ) -> Result<PendingArtifactReservation, Error> {
        validate_components(std::slice::from_ref(&filename))?;
        if operations.is_empty() {
            return Err(Error::InvalidInput(
                "download artifact requires operations".into(),
            ));
        }
        let root_entry = self
            .persistent
            .get(&root.id)
            .cloned()
            .ok_or_else(|| Error::InvalidInput("download root must be persistent".into()))?;
        if !root_entry.stored.target_is_dir
            || !root_entry
                .stored
                .operations
                .contains(&PathOperation::DownloadFile)
        {
            return Err(Error::InvalidInput(
                "capability is not a download root".into(),
            ));
        }
        let acquired = acquire_stored_target(
            &root_entry.stored,
            AcquireShape::Root {
                parent_access: parent_access_for_operations(&[PathOperation::DownloadFile]),
            },
            "download root changed before artifact reservation",
        )?;
        let root_path = acquired.path;
        let root_identity = acquired.identity;
        let path = root_path.join(&filename);
        let baseline = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(Error::InvalidInput(
                    "download artifact target must be a regular file".into(),
                ));
            }
            Ok(_) => Some(identity(&path)?),
            Err(error) if crate::error::is_missing_entry_io(&error) => None,
            Err(error) => return Err(Error::from(error)),
        };
        let pending = PendingArtifact {
            id: PathRef::fresh(),
            root: root.clone(),
            filename: NativePath::from_path(&PathBuf::from(&filename)),
            display_name: display_name.into(),
            operations,
            baseline,
            root_identity: Some(root_identity),
            payload_size,
            payload_sha256,
            payload_bound: true,
            installed_identity: None,
            installed_ctime_nanos: None,
        };
        let mut next_pending = self.pending_artifacts.clone();
        next_pending.push(pending.clone());
        let durability = self.commit_registry(
            self.persistent.clone(),
            self.active_database_root.clone(),
            self.active_puzzle_root.clone(),
            self.active_engine_root.clone(),
            next_pending,
            None,
            false,
        )?;
        match durability {
            CommitDurability::Durable => {}
            CommitDurability::DurabilityUncertain(_) => {
                // The stage the commit reports is the registry write; what the caller must not do
                // is act on the reservation, so name that instead.
                return Err(Error::CommittedDurabilityUncertain(
                    crate::error::DurabilityStage::ArchiveReservationJournal,
                ));
            }
        }
        Ok(PendingArtifactReservation {
            id: pending.id,
            payload_size: pending.payload_size,
            payload_sha256: pending.payload_sha256,
        })
    }

    fn commit_download_artifact(
        &mut self,
        verified: ContentVerifiedArtifactActivation,
    ) -> Result<ArtifactPublication, Error> {
        let current_pending = self
            .pending_artifacts
            .iter()
            .find(|pending| pending.id == verified.pending.id)
            .cloned()
            .ok_or_else(|| Error::InvalidInput("unknown download artifact reservation".into()))?;

        if current_pending.operations != verified.pending.operations
            || current_pending.root != verified.pending.root
            || current_pending.filename != verified.pending.filename
            || current_pending.root_identity != verified.pending.root_identity
            || current_pending.baseline != verified.pending.baseline
            || !current_pending.payload_bound
            || current_pending.payload_bound != verified.pending.payload_bound
            || current_pending.payload_size != verified.pending.payload_size
            || current_pending.payload_sha256 != verified.pending.payload_sha256
            || current_pending.installed_identity != verified.pending.installed_identity
            || current_pending.installed_ctime_nanos != verified.pending.installed_ctime_nanos
            || current_pending.display_name != verified.pending.display_name
        {
            return Err(Error::Conflict(
                "download artifact reservation changed before activation".into(),
            ));
        }

        let root = self
            .persistent
            .get(&verified.pending.root.id)
            .cloned()
            .ok_or_else(|| {
                Error::Conflict("download root disappeared before artifact activation".into())
            })?;
        if root.stored.id != verified.root_id {
            return Err(Error::Conflict(
                "download root changed before artifact activation".into(),
            ));
        }
        let acquired = acquire_stored_target(
            &root.stored,
            AcquireShape::Root {
                parent_access: parent_access_for_operations(&[PathOperation::DownloadFile]),
            },
            "download root changed before artifact activation",
        )?;
        let root_path = acquired.path;
        let root_identity = acquired.identity;
        if verified.pending.root_identity.as_ref() != Some(&root_identity)
            || root_identity != verified.root_identity
            || root_path != verified.root_path
        {
            return Err(Error::Conflict(
                "download root changed before artifact activation".into(),
            ));
        }

        let filename = verified.pending.filename.to_path()?;
        let leaf = filename
            .file_name()
            .ok_or_else(|| Error::InvalidInput("artifact reservation has no leaf".into()))?
            .to_os_string();
        let mut re_resolved =
            self.resolve(&verified.pending.root, PathOperation::DownloadFile, &[leaf])?;
        let (a, b) = re_resolved.parent_identity()?;
        let parent_identity = Identity { a, b };
        let current_file = re_resolved
            .take_file()
            .ok_or_else(|| Error::Conflict("artifact target is not a regular file".into()))?;
        let (cur_a, cur_b) = opened_file_identity(&current_file)?;
        let current_leaf_identity = Identity { a: cur_a, b: cur_b };
        let current_leaf_change_stamp = opened_file_change_stamp(&current_file)?;

        if current_leaf_identity != verified.verified_identity
            || current_leaf_change_stamp != verified.verified_change_stamp
        {
            return Err(Error::Conflict(
                "download artifact target changed before activation".into(),
            ));
        }

        #[cfg(test)]
        if let Some(observer) = &verified.observer {
            observer.observe(ActivationObserverStage::CommitBeforeRetainedDescriptorValidation);
        }

        let (ret_a, ret_b) = opened_file_identity(verified.descriptor.as_file())?;
        let retained_identity = Identity { a: ret_a, b: ret_b };
        let retained_change_stamp = opened_file_change_stamp(verified.descriptor.as_file())?;
        if retained_identity != verified.verified_identity
            || retained_change_stamp != verified.verified_change_stamp
        {
            return Err(Error::Conflict(
                "download artifact target changed before activation".into(),
            ));
        }

        let purpose = purpose_for_shape(
            PathClass::PersistentFile,
            false,
            &verified.pending.operations,
        );
        let operations = purpose
            .map(canonical_operations)
            .unwrap_or(verified.pending.operations);
        let stored = StoredEntry {
            id: verified.pending.id.clone(),
            display_name: verified.pending.display_name,
            class: PathClass::PersistentFile,
            purpose,
            operations,
            path: NativePath::from_path(&root_path.join(&filename)),
            identity: verified.verified_identity,
            parent_identity: Some(parent_identity),
            target_is_dir: false,
            practice_key: None,
        };
        let mut candidate = self.persistent.clone();
        candidate.insert(
            stored.id.id.clone(),
            Entry {
                stored,
                availability: PathAvailability::Available,
            },
        );
        let next_pending: Vec<_> = self
            .pending_artifacts
            .iter()
            .filter(|pending| pending.id != verified.pending.id)
            .cloned()
            .collect();
        // Verification and the retained-descriptor checkpoint can outlive the earlier proof.
        // Re-prove the stored spelling immediately before publishing the capability.
        acquire_stored_target(
            &root.stored,
            AcquireShape::Root {
                parent_access: parent_access_for_operations(&[PathOperation::DownloadFile]),
            },
            "download root changed before artifact activation",
        )?;
        let durability = self.commit_registry(
            candidate,
            self.active_database_root.clone(),
            self.active_puzzle_root.clone(),
            self.active_engine_root.clone(),
            next_pending,
            None,
            true,
        )?;
        Ok(ArtifactPublication {
            handle: FileWorkspaceHandle::new(verified.pending.id),
            durability,
        })
    }

    /// Activates exactly the artifact covered by a durable reservation after atomic replacement.
    /// Module-private synchronous adapter used only by recovery and tests.
    fn activate_download_artifact(
        &mut self,
        reservation: &PendingArtifactReservation,
    ) -> Result<ArtifactPublication, Error> {
        let prepared = self.prepare_download_artifact(reservation)?;
        let verified = prepared.verify()?;
        self.commit_download_artifact(verified)
    }

    /// Records the exact no-follow inode installed by an already-completed rename. Failure or
    /// uncertain durability deliberately leaves the intent quarantined; callers must not retry
    /// the install because the target may already have changed.
    pub(crate) fn mark_download_artifact_committed(
        &mut self,
        reservation: &PendingArtifactReservation,
        installed_identity: (u64, u64),
        installed_ctime_nanos: i128,
    ) -> Result<(), Error> {
        let pending = self
            .pending_artifacts
            .iter()
            .find(|item| item.id == reservation.id)
            .cloned()
            .ok_or_else(|| Error::InvalidInput("unknown download artifact reservation".into()))?;
        if !pending.payload_bound {
            return Err(Error::Conflict(
                "legacy artifact intent is quarantined".into(),
            ));
        }
        let mut next = self.pending_artifacts.clone();
        let item = next
            .iter_mut()
            .find(|item| item.id == reservation.id)
            .expect("reservation was cloned from pending artifacts");
        item.installed_identity = Some(Identity {
            a: installed_identity.0,
            b: installed_identity.1,
        });
        item.installed_ctime_nanos = Some(installed_ctime_nanos);
        match self.commit_registry(
            self.persistent.clone(),
            self.active_database_root.clone(),
            self.active_puzzle_root.clone(),
            self.active_engine_root.clone(),
            next,
            None,
            true,
        )? {
            CommitDurability::Durable => Ok(()),
            CommitDurability::DurabilityUncertain(_) => Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::ArchiveCommitMarker,
            )),
        }
    }

    pub(crate) fn abandon_download_artifact(&mut self, reservation: &PendingArtifactReservation) {
        let next_pending: Vec<_> = self
            .pending_artifacts
            .iter()
            .filter(|pending| pending.id != reservation.id)
            .cloned()
            .collect();
        if next_pending.len() == self.pending_artifacts.len() {
            return;
        }
        if let Err(error) = self.commit_registry(
            self.persistent.clone(),
            self.active_database_root.clone(),
            self.active_puzzle_root.clone(),
            self.active_engine_root.clone(),
            next_pending,
            None,
            true,
        ) {
            let category = error.category();
            let reservation_id = &reservation.id.id;
            log::warn!(
                "failed to abandon download artifact reservation {reservation_id}: {category}"
            );
        }
    }

    /// Rebinds a successfully renamed entry without reopening its mutable pathname. `renameat`
    /// preserves the object identity already stored on the capability; a later resolver either
    /// observes that exact object at the new path or fails closed.
    pub(crate) fn rebind_workspace_entry(
        &mut self,
        handle: &FileWorkspaceHandle,
        path: &Path,
        display_name: impl Into<String>,
        parent_identity: (u64, u64),
    ) -> Result<(), Error> {
        let mut candidate = self.persistent.clone();
        let entry = candidate
            .get_mut(&handle.path_ref().id)
            .ok_or_else(|| Error::Conflict("workspace entry disappeared".into()))?;
        entry.stored.path = NativePath::from_path(path);
        entry.stored.display_name = display_name.into();
        entry.stored.parent_identity = Some(Identity {
            a: parent_identity.0,
            b: parent_identity.1,
        });
        entry.availability = PathAvailability::Available;
        require_durable(self.commit_candidate(candidate, None)?)?;
        Ok(())
    }

    fn persistent_entry_for(
        &self,
        handle: &FileWorkspaceHandle,
        operation: PathOperation,
    ) -> Result<Entry, Error> {
        let entry = self
            .persistent
            .get(&handle.path_ref().id)
            .cloned()
            .ok_or_else(|| Error::InvalidInput("workspace entry is not persistent".into()))?;
        if !entry.stored.operations.contains(&operation) {
            return Err(Error::InvalidInput(
                "workspace entry does not permit this operation".into(),
            ));
        }
        Ok(entry)
    }

    /// Checks the current registry location without opening the file or consulting collections.
    /// Workspace membership is path-based, as it is for workspace moves and descendant removal.
    pub(crate) fn ensure_pgn_not_trashed(&self, handle: &FileWorkspaceHandle) -> Result<(), Error> {
        let Some(entry) = self.persistent.get(&handle.path_ref().id) else {
            return Ok(());
        };
        let path = entry.stored.path.to_path()?;
        for root in self.persistent.values().filter(|entry| {
            entry.stored.target_is_dir && entry.stored.operations.contains(&PathOperation::ReadPgn)
        }) {
            let root_path = root.stored.path.to_path()?;
            if let Ok(relative) = path.strip_prefix(root_path) {
                let locator: Vec<_> = relative
                    .components()
                    .map(|part| part.as_os_str().to_os_string())
                    .collect();
                if crate::file_workspace::is_trash_locator(&locator) {
                    return Err(Error::FileTrashed);
                }
            }
        }
        Ok(())
    }

    pub(crate) fn workspace_entry_path(
        &mut self,
        handle: &FileWorkspaceHandle,
        operation: PathOperation,
    ) -> Result<PathBuf, Error> {
        let entry = self.persistent_entry_for(handle, operation)?;
        let parent_access = parent_access_for_operations(&[operation]);
        let shape = if entry.stored.target_is_dir {
            AcquireShape::Root { parent_access }
        } else {
            AcquireShape::File { parent_access }
        };
        let acquired = acquire_stored_target(
            &entry.stored,
            shape,
            "workspace entry is unavailable because its object changed",
        )?;
        let (parent, _) = acquired
            .parent_and_leaf
            .ok_or_else(|| Error::InvalidInput("workspace entry needs a leaf name".into()))?;
        if !entry.stored.target_is_dir {
            verify_parent_identity(&parent, entry.stored.parent_identity.as_ref())?;
        }
        self.session_protected_ids
            .insert(handle.path_ref().id.clone());
        Ok(acquired.path)
    }

    /// Resolves an opaque workspace capability into retained no-follow descriptors.  This is the
    /// mutation boundary: callers must not reopen `path()` for filesystem changes.
    pub(crate) fn workspace_mutation_target(
        &mut self,
        handle: &FileWorkspaceHandle,
    ) -> Result<WorkspaceMutationTarget, Error> {
        let target = self.retained_workspace_target(handle, PathOperation::WritePgn)?;
        let directory = if target.target_is_dir {
            Some(
                crate::infra::fs::open_verified_directory(&target.path, target.identity)?
                    .into_file(),
            )
        } else {
            None
        };
        Ok(WorkspaceMutationTarget {
            parent: target.parent,
            directory,
            leaf: target.leaf,
            identity: target.identity,
            is_dir: target.target_is_dir,
            path: target.path,
        })
    }

    fn retained_workspace_target(
        &mut self,
        handle: &FileWorkspaceHandle,
        required_operation: PathOperation,
    ) -> Result<RetainedWorkspaceTarget, Error> {
        let entry = self.persistent_entry_for(handle, required_operation)?;
        let path = entry.stored.path.to_path()?;
        let expected = (entry.stored.identity.a, entry.stored.identity.b);
        let (parent, leaf) = crate::infra::fs::open_verified_parent(
            &path,
            expected,
            entry.stored.target_is_dir,
            ParentAccess::Writable,
        )?;
        if !entry.stored.target_is_dir {
            verify_parent_identity(&parent, entry.stored.parent_identity.as_ref())?;
        }
        self.session_protected_ids
            .insert(handle.path_ref().id.clone());
        Ok(RetainedWorkspaceTarget {
            parent,
            leaf,
            identity: expected,
            target_is_dir: entry.stored.target_is_dir,
            path,
        })
    }

    /// Remove workspace registry entries and return the save's durability and the number of
    /// registry ids this call removed that an earlier failed save had not already removed.
    /// The count is returned only with a committed save. Workspace deletion error counts instead
    /// come from physical target removal, including engine retirement errors. Pending ids are
    /// excluded because an earlier call removed them from its candidate map but failed to save it,
    /// so this directory's candidate or the commit prune would otherwise count them again.
    /// This is neither a count of filesystem entries nor the registry-size delta.
    pub(crate) fn remove_workspace_entry(
        &mut self,
        handle: &FileWorkspaceHandle,
        status: WorkspaceRemovalStatus,
        dropped_engine_executables: &mut Vec<PathRef>,
    ) -> Result<(CommitDurability, usize), Error> {
        let removed = self
            .persistent
            .get(&handle.path_ref().id)
            .cloned()
            .ok_or_else(|| Error::InvalidInput("workspace entry is not persistent".into()))?;
        let removed_path = removed.stored.path.to_path()?;
        self.remove_workspace_path(
            &removed_path,
            removed.stored.target_is_dir,
            status,
            dropped_engine_executables,
        )
    }

    pub(crate) fn remove_workspace_path(
        &mut self,
        removed_path: &Path,
        is_dir: bool,
        status: WorkspaceRemovalStatus,
        dropped_engine_executables: &mut Vec<PathRef>,
    ) -> Result<(CommitDurability, usize), Error> {
        let mut candidate = self.persistent.clone();
        candidate.retain(|id, entry| {
            let _ = id;
            let Ok(path) = entry.stored.path.to_path() else {
                return true;
            };
            if path == removed_path {
                return status == WorkspaceRemovalStatus::Partial;
            }
            let is_descendant = is_dir && path.strip_prefix(removed_path).is_ok();
            if !is_descendant {
                return true;
            }
            if status == WorkspaceRemovalStatus::Complete {
                return false;
            }
            refresh_entry(entry);
            entry.availability == PathAvailability::Available
        });

        let removed_ids: Vec<_> = self
            .persistent
            .keys()
            .filter(|id| !candidate.contains_key(*id))
            .cloned()
            .collect();
        dropped_engine_executables.extend(removed_ids.iter().filter_map(|id| {
            let entry = self.persistent.get(id)?;
            entry
                .stored
                .operations
                .iter()
                .any(|operation| {
                    matches!(
                        operation,
                        PathOperation::EngineExecute | PathOperation::EngineConfigure
                    )
                })
                .then(|| PathRef { id: id.clone() })
        }));
        let mut pending_artifacts = self.pending_artifacts.clone();
        pending_artifacts.retain(|pending| !removed_ids.contains(&pending.root.id));
        // An intent whose root was removed by this operation can never activate. This is scoped
        // here rather than made a general commit invariant because other commits do not establish
        // that a missing root was deliberately deleted.
        //
        // After a successful save, workspace records no longer outlive the objects they name. If
        // saving fails, however, this prune is not adopted: in-memory state must not diverge from
        // what was persisted, so the unavailable records remain until a later successful,
        // explicit reconciliation. Residual accumulation is therefore limited to registry-save
        // failures rather than ordinary workspace create-and-delete use.
        let newly_removed_ids = removed_ids
            .iter()
            .filter(|id| !self.pending_unpersisted_removals.contains(*id))
            .count();
        match self.commit_candidate_with_pending(candidate, pending_artifacts, None) {
            Ok(durability) => Ok((durability, newly_removed_ids)),
            Err(error) => {
                self.pending_unpersisted_removals.extend(removed_ids);
                Err(error)
            }
        }
    }

    /// Rebind every persistent child below a moved directory in one registry replacement. This
    /// keeps already-open tabs and recents attached to their original filesystem identities
    /// after a native directory move; paths never need to be reconstructed in the renderer.
    pub(crate) fn rebase_workspace_entries(
        &mut self,
        old_root: &Path,
        new_root: &Path,
    ) -> Result<(), Error> {
        self.rebase_workspace_records(old_root, new_root, None)
    }

    pub(crate) fn restore_workspace_records(
        &mut self,
        old_root: &Path,
        new_root: &Path,
        parent_identity: (u64, u64),
    ) -> Result<(), Error> {
        self.rebase_workspace_records(old_root, new_root, Some(parent_identity))
    }

    fn rebase_workspace_records(
        &mut self,
        old_root: &Path,
        new_root: &Path,
        parent_identity: Option<(u64, u64)>,
    ) -> Result<(), Error> {
        let mut candidate = self.persistent.clone();
        let mut changed = false;
        for entry in candidate.values_mut() {
            let path = entry.stored.path.to_path()?;
            if let Ok(suffix) = path.strip_prefix(old_root) {
                let target = if suffix.as_os_str().is_empty() {
                    new_root.to_path_buf()
                } else {
                    new_root.join(suffix)
                };
                entry.stored.path = NativePath::from_path(&target);
                if path == old_root && !entry.stored.target_is_dir {
                    if let Some((a, b)) = parent_identity {
                        entry.stored.parent_identity = Some(Identity { a, b });
                    }
                }
                entry.availability = PathAvailability::Available;
                changed = true;
            }
        }
        if changed {
            require_durable(self.commit_candidate(candidate, None)?)?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn fill_trash_registry_for_test(
        &mut self,
        workspace: &FileWorkspaceHandle,
    ) -> Result<usize, Error> {
        let template = self
            .persistent
            .get(&workspace.path_ref().id)
            .cloned()
            .ok_or_else(|| Error::InvalidInput("test workspace missing".into()))?;
        for index in 0..MAX_AUTHORITY_IDS {
            if self.persistent.len() == MAX_AUTHORITY_IDS {
                break;
            }
            let mut entry = template.clone();
            entry.stored.id.id = format!("trash-capacity-{index}");
            self.persistent
                .entry(entry.stored.id.id.clone())
                .or_insert(entry);
        }
        require_durable(self.save()?)?;
        Ok(self.persistent.len())
    }
    /// Consumes one use of a live dialog grant. A missing (never issued, consumed or
    /// evicted-as-expired) grant is `Error::UnknownPathCapability`, a missing resource: `resolve`
    /// reaches this only after the persistent lookup failed, so renderer owners such as recent
    /// files can drop the id.
    fn take_dialog(
        &mut self,
        id: &PathRef,
        required: Option<PathOperation>,
    ) -> Result<DialogGrant, Error> {
        self.evict_dialogs();
        let mut grant = self
            .dialogs
            .remove(&id.id)
            .ok_or(Error::UnknownPathCapability)?;
        if let Some(op) = required {
            if !grant.entry.stored.operations.contains(&op) {
                self.dialogs.insert(id.id.clone(), grant);
                return Err(Error::InvalidInput(
                    "dialog grant does not permit this operation".into(),
                ));
            }
        }
        grant.uses_left -= 1;
        if grant.uses_left > 0 {
            self.dialogs.insert(id.id.clone(), grant.clone());
        }
        Ok(grant)
    }
    fn evict_dialogs(&mut self) {
        let now = self.clock.now();
        self.dialogs.retain(|_, g| g.expires_at > now);
    }
    #[cfg(test)]
    fn refresh_persistent(&mut self) {
        for entry in self.persistent.values_mut() {
            refresh_entry(entry);
        }
    }
    fn refresh_persistent_id(&mut self, id: &PathRef) {
        if let Some(entry) = self.persistent.get_mut(&id.id) {
            refresh_entry(entry);
        }
    }
    #[cfg(test)]
    fn save(&mut self) -> Result<CommitDurability, Error> {
        self.commit_registry(
            self.persistent.clone(),
            self.active_database_root.clone(),
            self.active_puzzle_root.clone(),
            self.active_engine_root.clone(),
            self.pending_artifacts.clone(),
            None,
            true,
        )
    }
    fn save_entries(
        &self,
        entries: &BTreeMap<String, Entry>,
        active_database_root: &Option<PathRef>,
        active_puzzle_root: &Option<PathRef>,
        active_engine_root: &Option<PathRef>,
        pending_artifacts: &[PendingArtifact],
    ) -> Result<CommitDurability, Error> {
        self.save_entries_with(
            entries,
            active_database_root,
            active_puzzle_root,
            active_engine_root,
            pending_artifacts,
            |target, write| atomic_replace(target, write),
        )
    }

    #[allow(clippy::too_many_arguments)] // one complete persisted-state admission snapshot
    fn registry_admission_snapshot(
        &self,
        entries: &BTreeMap<String, Entry>,
        active_database_root: &Option<PathRef>,
        active_puzzle_root: &Option<PathRef>,
        active_engine_root: &Option<PathRef>,
        pending_artifacts: &[PendingArtifact],
        provisional: &BTreeSet<String>,
        retired: &BTreeMap<String, Entry>,
        cleanup: &BTreeMap<String, StoredEntry>,
    ) -> Result<RegistryAdmissionSnapshot, Error> {
        let bytes = serde_json::to_vec(&Registry {
            schema_version: SCHEMA_VERSION,
            entries: entries
                .values()
                .filter(|entry| entry.stored.class != PathClass::AppOwnedRoot)
                .map(|entry| entry.stored.clone())
                .collect(),
            active_database_root: active_database_root.clone(),
            active_puzzle_root: active_puzzle_root.clone(),
            active_engine_root: active_engine_root.clone(),
            pending_artifacts: pending_artifacts.to_vec(),
            provisional_attachments: provisional.clone(),
            image_cleanup: cleanup.values().cloned().collect(),
            catalog_installs: self.catalog_installs.clone(),
            catalog_uses: catalog_install::encode_uses(&self.catalog_uses),
        })
        .map_err(|error| Error::InvalidInput(error.to_string()))?;
        Ok(RegistryAdmissionSnapshot {
            bytes: bytes.len(),
            serialized: bytes,
            admission_units: self.catalog_admission_count()
                + unique_registry_id_count(
                    entries.keys().map(String::as_str).collect(),
                    retired.keys().map(String::as_str).collect(),
                    cleanup.keys().map(String::as_str).collect(),
                    pending_artifacts
                        .iter()
                        .map(|pending| pending.id.id.as_str())
                        .collect(),
                ),
            // This is deliberately a separate admission dimension. A pending artifact can
            // carry an already-counted ID; its number of recovery records is still bounded.
            pending_count: pending_artifacts.len(),
        })
    }

    fn commit_candidate(
        &mut self,
        candidate: BTreeMap<String, Entry>,
        consumed_dialog: Option<&PathRef>,
    ) -> Result<CommitDurability, Error> {
        self.commit_candidate_with_pending_baseline(
            candidate,
            self.pending_artifacts.clone(),
            consumed_dialog,
            None,
        )
    }
    fn commit_candidate_with_pending(
        &mut self,
        candidate: BTreeMap<String, Entry>,
        pending_artifacts: Vec<PendingArtifact>,
        consumed_dialog: Option<&PathRef>,
    ) -> Result<CommitDurability, Error> {
        self.commit_candidate_with_pending_baseline(
            candidate,
            pending_artifacts,
            consumed_dialog,
            None,
        )
    }

    fn commit_candidate_with_pending_baseline(
        &mut self,
        candidate: BTreeMap<String, Entry>,
        pending_artifacts: Vec<PendingArtifact>,
        consumed_dialog: Option<&PathRef>,
        baseline: Option<RegistryAdmissionSnapshot>,
    ) -> Result<CommitDurability, Error> {
        let active_database_root = self
            .active_database_root
            .clone()
            .filter(|id| candidate.contains_key(&id.id));
        let active_puzzle_root = self
            .active_puzzle_root
            .clone()
            .filter(|id| candidate.contains_key(&id.id));
        let active_engine_root = self
            .active_engine_root
            .clone()
            .filter(|id| candidate.contains_key(&id.id));
        let durability = self.commit_state_with_baseline(
            candidate,
            active_database_root,
            active_puzzle_root,
            active_engine_root,
            pending_artifacts,
            consumed_dialog,
            baseline,
        )?;
        Ok(durability)
    }
    fn commit_state(
        &mut self,
        candidate: BTreeMap<String, Entry>,
        active_database_root: Option<PathRef>,
        active_puzzle_root: Option<PathRef>,
        active_engine_root: Option<PathRef>,
        pending_artifacts: Vec<PendingArtifact>,
        consumed_dialog: Option<&PathRef>,
    ) -> Result<CommitDurability, Error> {
        self.commit_state_with_baseline(
            candidate,
            active_database_root,
            active_puzzle_root,
            active_engine_root,
            pending_artifacts,
            consumed_dialog,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)] // one complete registry commit plus its old baseline
    fn commit_state_with_baseline(
        &mut self,
        candidate: BTreeMap<String, Entry>,
        active_database_root: Option<PathRef>,
        active_puzzle_root: Option<PathRef>,
        active_engine_root: Option<PathRef>,
        pending_artifacts: Vec<PendingArtifact>,
        consumed_dialog: Option<&PathRef>,
        baseline: Option<RegistryAdmissionSnapshot>,
    ) -> Result<CommitDurability, Error> {
        self.commit_registry_with_baseline(
            candidate,
            active_database_root,
            active_puzzle_root,
            active_engine_root,
            pending_artifacts,
            consumed_dialog,
            true,
            baseline,
        )
    }
    #[allow(clippy::too_many_arguments)] // one registry snapshot plus adopt_uncertain
    fn commit_registry(
        &mut self,
        candidate: BTreeMap<String, Entry>,
        active_database_root: Option<PathRef>,
        active_puzzle_root: Option<PathRef>,
        active_engine_root: Option<PathRef>,
        pending_artifacts: Vec<PendingArtifact>,
        consumed_dialog: Option<&PathRef>,
        adopt_uncertain: bool,
    ) -> Result<CommitDurability, Error> {
        self.commit_registry_with_baseline(
            candidate,
            active_database_root,
            active_puzzle_root,
            active_engine_root,
            pending_artifacts,
            consumed_dialog,
            adopt_uncertain,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn commit_registry_with_baseline(
        &mut self,
        mut candidate: BTreeMap<String, Entry>,
        mut active_database_root: Option<PathRef>,
        mut active_puzzle_root: Option<PathRef>,
        mut active_engine_root: Option<PathRef>,
        mut pending_artifacts: Vec<PendingArtifact>,
        consumed_dialog: Option<&PathRef>,
        adopt_uncertain: bool,
        baseline: Option<RegistryAdmissionSnapshot>,
    ) -> Result<CommitDurability, Error> {
        candidate.retain(|id, _| !self.pending_unpersisted_removals.contains(id));
        pending_artifacts
            .retain(|pending| !self.pending_unpersisted_removals.contains(&pending.root.id));
        active_database_root = active_database_root.filter(|root| {
            !self.pending_unpersisted_removals.contains(&root.id)
                && candidate.contains_key(&root.id)
        });
        active_puzzle_root = active_puzzle_root.filter(|root| {
            !self.pending_unpersisted_removals.contains(&root.id)
                && candidate.contains_key(&root.id)
        });
        active_engine_root = active_engine_root.filter(|root| {
            !self.pending_unpersisted_removals.contains(&root.id)
                && candidate.contains_key(&root.id)
        });
        let durability = self.save_entries_with_baseline(
            &candidate,
            &active_database_root,
            &active_puzzle_root,
            &active_engine_root,
            &pending_artifacts,
            baseline,
            |target, write| atomic_replace(target, write),
        )?;
        self.registry_durability_pending = !matches!(durability, CommitDurability::Durable);
        if matches!(durability, CommitDurability::Durable) || adopt_uncertain {
            self.persistent = candidate;
            self.active_database_root = active_database_root;
            self.active_puzzle_root = active_puzzle_root;
            self.active_engine_root = active_engine_root;
            self.pending_artifacts = pending_artifacts;
            self.pending_unpersisted_removals.clear();
            self.loaded_candidate_ids
                .retain(|id| self.persistent.contains_key(id));
            self.session_protected_ids
                .retain(|id| self.persistent.contains_key(id));
            self.startup_retained_ids
                .retain(|id| self.persistent.contains_key(id));
            if let Some(dialog) = consumed_dialog {
                self.dialogs.remove(&dialog.id);
            }
        }
        Ok(durability)
    }
    fn check_registry_growth(
        candidate: &RegistryAdmissionSnapshot,
        current: &RegistryAdmissionSnapshot,
    ) -> Result<(), Error> {
        if candidate.admission_units > MAX_AUTHORITY_IDS
            && candidate.admission_units > current.admission_units
        {
            return Err(Error::ResourceLimit(
                "path registry identifier limit reached".into(),
            ));
        }
        if candidate.pending_count > MAX_PENDING_ARTIFACTS
            && candidate.pending_count > current.pending_count
        {
            return Err(Error::ResourceLimit(
                "pending path artifact limit reached".into(),
            ));
        }
        if candidate.bytes > MAX_REGISTRY_BYTES && candidate.bytes > current.bytes {
            return Err(Error::ResourceLimit(
                "path registry serialized size limit reached".into(),
            ));
        }
        Ok(())
    }

    fn save_entries_with<F>(
        &self,
        source: &BTreeMap<String, Entry>,
        active_database_root: &Option<PathRef>,
        active_puzzle_root: &Option<PathRef>,
        active_engine_root: &Option<PathRef>,
        pending_artifacts: &[PendingArtifact],
        replace: F,
    ) -> Result<CommitDurability, Error>
    where
        F: FnMut(
            &Path,
            Box<dyn FnOnce(&mut OwnedFile) -> Result<(), Error>>,
        ) -> Result<AtomicFileOutcome, Error>,
    {
        self.save_entries_with_baseline(
            source,
            active_database_root,
            active_puzzle_root,
            active_engine_root,
            pending_artifacts,
            None,
            replace,
        )
    }

    #[allow(clippy::too_many_arguments)] // one complete registry encoding plus its old baseline
    fn save_entries_with_baseline<F>(
        &self,
        source: &BTreeMap<String, Entry>,
        active_database_root: &Option<PathRef>,
        active_puzzle_root: &Option<PathRef>,
        active_engine_root: &Option<PathRef>,
        pending_artifacts: &[PendingArtifact],
        baseline: Option<RegistryAdmissionSnapshot>,
        mut replace: F,
    ) -> Result<CommitDurability, Error>
    where
        F: FnMut(
            &Path,
            Box<dyn FnOnce(&mut OwnedFile) -> Result<(), Error>>,
        ) -> Result<AtomicFileOutcome, Error>,
    {
        let candidate_snapshot = self.registry_admission_snapshot(
            source,
            active_database_root,
            active_puzzle_root,
            active_engine_root,
            pending_artifacts,
            &self.provisional_attachments,
            &self.retired_attachments,
            &self.image_cleanup,
        )?;
        let current_snapshot = if let Some(baseline) = baseline {
            baseline
        } else {
            self.registry_admission_snapshot(
                &self.persistent,
                &self.active_database_root,
                &self.active_puzzle_root,
                &self.active_engine_root,
                &self.pending_artifacts,
                &self.provisional_attachments,
                &self.retired_attachments,
                &self.image_cleanup,
            )?
        };
        Self::check_registry_growth(&candidate_snapshot, &current_snapshot)?;
        let bytes = candidate_snapshot.serialized;
        let mut attempt = || {
            let bytes = bytes.clone();
            replace(
                &self.registry_path,
                Box::new(move |f| f.write_all(&bytes).map_err(Error::from)),
            )
        };
        let outcome = match attempt() {
            Err(Error::Io(_)) => attempt()?,
            result => result?,
        };
        let stage = crate::infra::fs::map_atomic_file_outcome(
            outcome,
            crate::error::DurabilityStage::RegistryReplacement,
            |error| log::warn!("path authority registry replacement parent sync failed: {error}"),
        );
        Ok(match stage {
            Some(stage) => CommitDurability::DurabilityUncertain(stage),
            None => CommitDurability::Durable,
        })
    }
}

/// Takes the process-wide authority lock only long enough to open and bound the
/// image descriptor. The guard is dropped before this function returns.
pub(crate) fn engine_image_reader_for(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    image: &EngineImageHandle,
    max_bytes: usize,
) -> Result<(VerifiedFile, u64), Error> {
    authority.with_mut(|authority| authority.open_engine_image(image, max_bytes))?
}

/// Consumes the no-follow descriptor. `declared` is capped before it sizes the allocation, and
/// each read is limited to the remaining allowance plus one byte used to detect excess.
pub(crate) fn read_engine_image_bytes(
    file: VerifiedFile,
    declared: u64,
    max_bytes: usize,
) -> Result<Vec<u8>, Error> {
    let mut file = file.into_inner();
    read_bounded_bytes(
        &mut file,
        declared,
        max_bytes,
        "engine image exceeds the supported size limit",
        || Ok(()),
    )
}

fn validate_persisted_shape(entry: &StoredEntry) -> Result<(), Error> {
    if !matches!(
        entry.class,
        PathClass::PersistentCustomRoot | PathClass::PersistentFile
    ) || entry.operations.is_empty()
        || entry.id.id.is_empty()
        || entry.display_name.is_empty()
        || entry.target_is_dir != (entry.class == PathClass::PersistentCustomRoot)
    {
        return Err(Error::InvalidInput(
            "invalid persistent path registry entry".into(),
        ));
    }
    if let Some(purpose) = entry.purpose {
        let legacy_engine = purpose == EntryPurpose::EngineExecutable
            && same_operation_set(
                &entry.operations,
                &[
                    PathOperation::EngineExecute,
                    PathOperation::EngineConfigure,
                    PathOperation::EngineInstall,
                ],
            );
        let canonical = canonical_operations(purpose);
        let historical_subset = entry
            .operations
            .iter()
            .all(|operation| canonical.contains(operation));
        if !purpose_matches_shape(purpose, entry.class, entry.target_is_dir)
            || (!legacy_engine && !historical_subset)
        {
            return Err(Error::InvalidInput(
                "persistent path purpose does not match its authority shape".into(),
            ));
        }
    }
    Ok(())
}

fn validate_loaded_attachment_metadata(
    persistent: &BTreeMap<String, Entry>,
    provisional_ids: &BTreeSet<String>,
    image_cleanup: &[StoredEntry],
) -> Result<(), Error> {
    let is_attachment = |entry: &StoredEntry| {
        let Some(purpose) = entry.purpose else {
            return false;
        };
        matches!(
            purpose,
            EntryPurpose::EngineResource | EntryPurpose::EngineImage
        ) && purpose_matches_shape(purpose, entry.class, entry.target_is_dir)
            && entry.operations == canonical_operations(purpose)
    };

    for id in provisional_ids {
        let Some(entry) = persistent.get(id).map(|entry| &entry.stored) else {
            return Err(Error::InvalidInput(
                "provisional engine attachment is not a persistent entry".into(),
            ));
        };
        if !is_attachment(entry) {
            return Err(Error::InvalidInput(
                "provisional engine attachment has invalid authority shape".into(),
            ));
        }
    }

    let mut cleanup_ids = BTreeSet::new();
    for entry in image_cleanup {
        validate_persisted_shape(entry)?;
        if entry.class != PathClass::PersistentFile
            || entry.target_is_dir
            || entry.purpose != Some(EntryPurpose::EngineImage)
            || entry.operations != canonical_operations(EntryPurpose::EngineImage)
        {
            return Err(Error::InvalidInput(
                "engine image cleanup intent has invalid authority shape".into(),
            ));
        }
        if !cleanup_ids.insert(entry.id.id.clone()) || persistent.contains_key(&entry.id.id) {
            return Err(Error::InvalidInput(
                "duplicate or overlapping engine image cleanup intent".into(),
            ));
        }
        if provisional_ids.contains(&entry.id.id) {
            return Err(Error::InvalidInput(
                "engine attachment cannot be both provisional and cleanup-pending".into(),
            ));
        }
        let path = entry.path.to_path()?;
        let Some(leaf) = path.file_name() else {
            return Err(Error::InvalidInput(
                "engine image cleanup intent has no leaf".into(),
            ));
        };
        if uuid::Uuid::parse_str(&leaf.to_string_lossy()).is_err() {
            return Err(Error::InvalidInput(
                "engine image cleanup intent has an invalid leaf".into(),
            ));
        }
    }
    Ok(())
}

fn is_attachment_purpose(purpose: Option<EntryPurpose>) -> bool {
    matches!(
        purpose,
        Some(EntryPurpose::EngineResource | EntryPurpose::EngineImage)
    )
}

fn unique_registry_id_count(
    persistent: Vec<&str>,
    retired: Vec<&str>,
    cleanup: Vec<&str>,
    pending: Vec<&str>,
) -> usize {
    persistent
        .into_iter()
        .chain(retired)
        .chain(cleanup)
        .chain(pending)
        .collect::<BTreeSet<_>>()
        .len()
}

impl PathAuthority {
    fn registry_admission_units(&self) -> usize {
        self.catalog_admission_count()
            + unique_registry_id_count(
                self.persistent.keys().map(String::as_str).collect(),
                self.retired_attachments
                    .keys()
                    .map(String::as_str)
                    .collect(),
                self.image_cleanup.keys().map(String::as_str).collect(),
                self.pending_artifacts
                    .iter()
                    .map(|pending| pending.id.id.as_str())
                    .collect(),
            )
    }
}

fn read_registry_bytes(reader: impl Read) -> Result<Vec<u8>, Error> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_LEGACY_REGISTRY_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_LEGACY_REGISTRY_BYTES {
        return Err(Error::ResourceLimit(
            "path registry exceeds the legacy read limit".into(),
        ));
    }
    Ok(bytes)
}
enum CanonicalBindingStatus {
    Canonical,
    Leafless,
    NeedsRebinding,
    Failed(Error),
}

/// A leafless spelling — `/`, or one ending in `.` or `..` — has no name for a no-follow parent
/// walk to open, so acquisition and the load-time rebinding both leave it as the caller wrote it.
fn has_normal_leaf(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| !name.is_empty() && name != OsStr::new(".") && name != OsStr::new(".."))
}

fn classify_canonical_binding(path: &Path) -> CanonicalBindingStatus {
    if !has_normal_leaf(path) {
        return CanonicalBindingStatus::Leafless;
    }
    match canonical_binding(path) {
        Ok(canonical) if canonical == path => CanonicalBindingStatus::Canonical,
        Ok(_) => CanonicalBindingStatus::NeedsRebinding,
        Err(error) => CanonicalBindingStatus::Failed(error),
    }
}

/// Only an entry the application registered as an `AppOwnedRoot` keeps a raw spelling. The default
/// roots under [`AppDataDir`] and everything registered beneath them are stored canonical, because
/// [`AppDataDir`] itself holds the canonical app-data path, so they need no exemption.
fn entry_keeps_its_raw_spelling(class: PathClass) -> bool {
    class == PathClass::AppOwnedRoot
}

fn refresh_entry(entry: &mut Entry) {
    #[cfg(test)]
    REFRESH_ENTRY_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow().as_ref() {
            hook(&entry.stored.id.id);
        }
    });
    let path = match entry.stored.path.to_path() {
        Ok(path) => path,
        Err(_) => {
            entry.availability = PathAvailability::Unavailable;
            return;
        }
    };
    let class = if entry.stored.target_is_dir {
        PathClass::PersistentCustomRoot
    } else {
        PathClass::PersistentFile
    };
    entry.availability =
        validate_target(&path, class).map_or(PathAvailability::Unavailable, |id| {
            if id == entry.stored.identity {
                if entry_keeps_its_raw_spelling(entry.stored.class) {
                    PathAvailability::Available
                } else {
                    match classify_canonical_binding(&path) {
                        CanonicalBindingStatus::Canonical | CanonicalBindingStatus::Leafless => {
                            PathAvailability::Available
                        }
                        CanonicalBindingStatus::NeedsRebinding
                        | CanonicalBindingStatus::Failed(_) => PathAvailability::Unavailable,
                    }
                }
            } else {
                PathAvailability::Unavailable
            }
        });
}
#[cfg(test)]
fn descriptor(stored: &StoredEntry, availability: PathAvailability) -> PathDescriptor {
    PathDescriptor {
        id: stored.id.clone(),
        display_name: stored.display_name.clone(),
        class: stored.class,
        availability,
    }
}

/// The leaf each app-owned default root materialises under, written out verbatim rather than read
/// back from `AppOwnedDefaultRoot::leaf()`. A leaf is the identity of an existing user's app-data
/// directory, so a test that asked the enum for its own expectation would copy a mistyped leaf into
/// its assertion and stay green forever. `portable_tests` and the unix `mod tests` share this one
/// table.
#[cfg(test)]
const APP_OWNED_DEFAULT_ROOT_LEAVES: &[(AppOwnedDefaultRoot, &str)] = &[
    (AppOwnedDefaultRoot::Collections, "collections"),
    (AppOwnedDefaultRoot::Databases, "db"),
    (AppOwnedDefaultRoot::Engines, "engines"),
    (AppOwnedDefaultRoot::EngineImages, "engine-images"),
    (AppOwnedDefaultRoot::Puzzles, "puzzles"),
    (AppOwnedDefaultRoot::Credentials, "credentials"),
    (AppOwnedDefaultRoot::Practice, "practice"),
    (AppOwnedDefaultRoot::UnsavedGames, "unsaved-games"),
    #[cfg(target_os = "macos")]
    (AppOwnedDefaultRoot::EngineLaunch, "engine-launch"),
];

/// Assertions that hold on every target. `mod tests` below is `#[cfg(unix)]` as a whole, so a
/// platform-neutral property placed there would silently stop being proven off unix; these live
/// here instead, and the shared `PathAuthority` constructor lives here with them.
#[cfg(test)]
pub(crate) mod portable_tests;

#[cfg(unix)]
#[cfg(test)]
mod tests;

#[cfg(all(test, windows))]
mod windows_parent_identity_tests;

#[cfg(unix)]
#[cfg(test)]
mod workspace_directory_enumeration_tests;
