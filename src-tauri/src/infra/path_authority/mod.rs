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
#[cfg(test)]
use crate::infra::fs::{atomic_replace, AtomicFileOutcome};
use crate::infra::inode_ownership::{FileMetadata, OwnedFile};
use crate::{
    error::{Error, ErrorCategory},
    infra::fs::{DirectoryEntry, DirectoryEntryKind, VerifiedDir},
};
#[cfg(unix)]
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
#[cfg(test)]
use std::io::Write;
#[cfg(all(test, unix))]
use std::sync::atomic::AtomicUsize;
#[cfg(test)]
use std::sync::atomic::Ordering;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    ffi::{OsStr, OsString},
    fs,
    io::{Read, Seek},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime},
};
use tauri::Manager as _;
use tokio_util::sync::CancellationToken;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

mod catalog_install;
mod databases;
mod dialogs;
mod engine_attachments;
mod handoff_endpoint;
mod listing;
mod registry;
mod shared;
mod workspace;
use dialogs::DialogGrant;
use engine_attachments::ActiveImageIssuances;
pub(crate) use engine_attachments::{
    engine_image_reader_for, image_reader_for, read_engine_image_bytes, read_verified_image_bytes,
};
#[cfg(target_os = "macos")]
pub(crate) use engine_attachments::{
    initialize_engine_launch_root, EngineLaunchRoot, MaterializedFile, ENGINE_EXECUTABLE_LEAF_MODE,
    ENGINE_RESOURCE_LEAF_MODE,
};
#[cfg(all(test, target_os = "macos"))]
use engine_attachments::{
    set_engine_launch_before_clone_hook, set_engine_launch_lock_created_hook,
    sweep_engine_launch_root, ENGINE_LAUNCH_FAILURES, ENGINE_LAUNCH_LOCK_MODE,
};
#[cfg(all(test, target_os = "macos"))]
pub(crate) use engine_attachments::{set_engine_launch_failure, EngineLaunchFailure};
pub(crate) use handoff_endpoint::{HandoffDirectory, HandoffEndpoint, PublishedEndpoint};
pub(crate) use listing::CapabilityDirectory;
#[cfg(test)]
use listing::DirectoryListingSnapshot;
#[cfg(all(test, unix))]
use registry::read_registry_bytes;
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

    pub(crate) fn remove_dir_identified_pair(
        &self,
        leaf: &OsStr,
        identity: (u64, u64),
    ) -> Result<(), Error> {
        crate::infra::fs::single_leaf(leaf)?;
        crate::infra::fs::remove_entry_at(self.directory.as_file(), leaf, identity, true)
    }

    pub(crate) fn rename_entry_into_child(
        &self,
        source: &OsStr,
        expected: (u64, u64),
        source_is_dir: bool,
        target_dir: &AuthorizedDir,
        target: &OsStr,
    ) -> Result<crate::infra::fs::AtomicFileOutcome, Error> {
        crate::infra::fs::single_leaf(source)?;
        crate::infra::fs::single_leaf(target)?;
        crate::infra::fs::rename_entry_at(
            self.directory.as_file(),
            source,
            expected,
            source_is_dir,
            target_dir.directory.as_file(),
            target,
        )
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
    WorkspaceSession,
    LibrarySync,
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
        Self::WorkspaceSession,
        Self::LibrarySync,
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
            Self::WorkspaceSession => "workspace-session",
            Self::LibrarySync => "library-sync",
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
            Self::WorkspaceSession => Some(0o700),
            Self::LibrarySync => Some(0o700),
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

fn is_attachment_purpose(purpose: Option<EntryPurpose>) -> bool {
    matches!(
        purpose,
        Some(EntryPurpose::EngineResource | EntryPurpose::EngineImage)
    )
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
    (AppOwnedDefaultRoot::WorkspaceSession, "workspace-session"),
    (AppOwnedDefaultRoot::LibrarySync, "library-sync"),
    #[cfg(target_os = "macos")]
    (AppOwnedDefaultRoot::EngineLaunch, "engine-launch"),
];

/// Assertions that hold on every target. `mod tests` below is `#[cfg(unix)]` as a whole, so a
/// platform-neutral property placed there would silently stop being proven off unix; these live
/// here instead, and the shared `PathAuthority` constructor lives here with them.
#[cfg(test)]
pub(crate) mod portable_tests;

#[cfg(test)]
pub(crate) mod test_source_files;

#[cfg(unix)]
#[cfg(test)]
mod tests;

#[cfg(all(test, windows))]
mod windows_parent_identity_tests;

#[cfg(unix)]
#[cfg(test)]
mod workspace_directory_enumeration_tests;
