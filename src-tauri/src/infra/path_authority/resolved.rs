#[cfg(unix)]
use crate::infra::fs::RegularFileAccess;
use crate::infra::inode_ownership::OwnedFile;
use crate::{
    error::Error,
    infra::fs::{AtomicFileOutcome, AtomicInstalledFile},
};
use sha2::Digest;
use std::{
    ffi::{OsStr, OsString},
    fs,
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    time::SystemTime,
};
use tokio_util::sync::CancellationToken;

use super::{is_write_operation, opened_file_identity, DatabaseFileTarget, PathOperation};

#[cfg(windows)]
fn windows_path_parts(path: &Path) -> Result<(PathBuf, Vec<OsString>), Error> {
    use std::path::Component;

    let mut components = path.components();
    let mut base = PathBuf::new();
    let mut names = Vec::new();
    match components.next() {
        None => base.push("."),
        Some(Component::Prefix(prefix)) => {
            base.push(prefix.as_os_str());
            match components.next() {
                Some(Component::RootDir) => base.push("\\"),
                Some(Component::Normal(_)) => {
                    return Err(Error::InvalidInput("Windows path must be absolute".into()));
                }
                Some(Component::ParentDir) | Some(Component::Prefix(_)) => {
                    return Err(Error::InvalidInput(
                        "Windows path contains traversal components".into(),
                    ));
                }
                Some(Component::CurDir) | None => {}
            }
        }
        Some(Component::RootDir) => base.push("\\"),
        Some(Component::CurDir) => base.push("."),
        Some(Component::Normal(name)) => {
            base.push(".");
            names.push(name.to_os_string());
        }
        Some(Component::ParentDir) => {
            return Err(Error::InvalidInput(
                "Windows path contains traversal components".into(),
            ));
        }
    }

    for component in components {
        match component {
            Component::Normal(name) => names.push(name.to_os_string()),
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err(Error::InvalidInput(
                    "Windows path contains traversal components".into(),
                ));
            }
        }
    }
    Ok((base, names))
}

#[cfg(windows)]
fn open_windows_directory_walk(path: &Path, writable: bool) -> Result<fs::File, Error> {
    open_windows_path_chain(path, writable, true, true)?
        .pop()
        .ok_or_else(|| Error::Conflict("Windows directory binding is unavailable".into()))
}

#[cfg(windows)]
fn open_windows_path_chain(
    path: &Path,
    writable: bool,
    allow_delete_share: bool,
    terminal_directory: bool,
) -> Result<Vec<fs::File>, Error> {
    use std::ptr::null;
    use windows_sys::{
        Wdk::Storage::FileSystem::FILE_OPEN,
        Win32::{
            Foundation::{GENERIC_READ, GENERIC_WRITE},
            Storage::FileSystem::SYNCHRONIZE,
        },
    };

    let (base, names) = windows_path_parts(path)?;
    let handle = super::open_windows_nofollow(&base, writable)?;
    let mut chain = vec![handle];
    let access = SYNCHRONIZE | GENERIC_READ | if writable { GENERIC_WRITE } else { 0 };
    for (index, name) in names.iter().enumerate() {
        let parent = chain
            .last()
            .ok_or_else(|| Error::Conflict("Windows parent binding is unavailable".into()))?;
        let handle = super::open_windows_child(
            parent,
            name,
            FILE_OPEN,
            access,
            null(),
            index + 1 != names.len() || terminal_directory,
            allow_delete_share,
        )?;
        chain.push(handle);
    }
    Ok(chain)
}

/// Result of a successful resolution. It retains the exact opened file when
/// present, the verified directory handle for directory targets, and the
/// parent handle plus authority-validated leaf needed for relative operations.
/// Those handles stay private and operate on that retained leaf. DownloadArchive
/// additionally permits creating a randomized private staging sibling through its
/// operation-checked door, without exposing the parent or accepting an arbitrary target.
pub struct ResolvedPath {
    operation: PathOperation,
    file: Option<OwnedFile>,
    #[cfg(unix)]
    regular_file_identity: Option<super::Identity>,
    directory: Option<fs::File>,
    parent: Option<fs::File>,
    leaf: Option<OsString>,
    target: Option<PathBuf>,
}

impl ResolvedPath {
    /// Seal the complete absolute resource pathname against ancestor replacement. A second
    /// walk is evidence only when its terminal identity matches the already-authorized object.
    #[cfg(windows)]
    pub(super) fn windows_resource_directory_seals(&self) -> Result<Vec<fs::File>, Error> {
        if self.operation != PathOperation::EngineResourceRead {
            return Err(Error::InvalidInput(
                "resolved capability is not an engine resource".into(),
            ));
        }
        let target = self
            .target()
            .filter(|path| path.is_absolute())
            .ok_or_else(|| {
                Error::Conflict("absolute engine resource target is unavailable".into())
            })?;
        let (expected, directory) = if let Some(file) = self.file() {
            (opened_file_identity(file)?, false)
        } else {
            let directory = self
                .directory()
                .ok_or_else(|| Error::Conflict("engine resource binding is unavailable".into()))?;
            (opened_file_identity(directory)?, true)
        };
        let mut chain = open_windows_path_chain(target, false, false, directory)?;
        let terminal = chain
            .last()
            .ok_or_else(|| Error::Conflict("engine resource binding is unavailable".into()))?;
        if opened_file_identity(terminal)? != expected {
            return Err(Error::Conflict(
                "engine resource changed after authorization".into(),
            ));
        }
        // The resolution already retains the same no-delete leaf. Keep every ancestor from
        // the absolute root, without retaining a redundant second terminal handle.
        chain.pop();
        Ok(chain)
    }

    pub(super) fn is_regular_file(&self) -> bool {
        #[cfg(unix)]
        if self.regular_file_identity.is_some() {
            return true;
        }
        self.file.is_some()
    }

    #[cfg(unix)]
    pub(super) fn observed_file_identity(&self) -> Option<(u64, u64)> {
        self.regular_file_identity.as_ref().map(|id| (id.a, id.b))
    }

    pub(super) fn file(&self) -> Option<&OwnedFile> {
        self.file.as_ref()
    }

    pub(super) fn take_file(&mut self) -> Option<OwnedFile> {
        self.file.take()
    }

    pub(super) fn directory(&self) -> Option<&fs::File> {
        self.directory.as_ref()
    }

    pub(super) fn take_directory(&mut self) -> Option<fs::File> {
        self.directory.take()
    }

    // The descriptor that observed a resolved file's leaf; registration doors record its identity
    // as the entry's authorized parent (`f-20260912-05`).
    pub(super) fn parent(&self) -> Option<&fs::File> {
        self.parent.as_ref()
    }

    /// Identity of the retained parent — the directory a registration door records as the
    /// entry's authorized parent (`f-20260912-05`). A resolution that retained no parent (a
    /// directory result) cannot bind a file entry, so it is refused rather than re-walked.
    pub(super) fn parent_identity(&self) -> Result<(u64, u64), Error> {
        let parent = self.parent.as_ref().ok_or_else(|| {
            Error::InvalidInput("resolved path has no retained parent boundary".into())
        })?;
        super::opened_file_identity(parent)
    }

    #[cfg_attr(not(unix), allow(dead_code))]
    pub(super) fn leaf(&self) -> Option<&OsStr> {
        self.leaf.as_deref()
    }

    #[cfg(windows)]
    pub(super) fn take_target(&mut self) -> Option<PathBuf> {
        self.target.take()
    }

    pub(crate) fn target(&self) -> Option<&Path> {
        self.target.as_deref()
    }

    #[cfg_attr(not(unix), allow(dead_code))]
    pub(super) fn operation(&self) -> PathOperation {
        self.operation
    }

    fn checked_archive_parent(&self) -> Result<&fs::File, Error> {
        if self.operation != PathOperation::DownloadArchive {
            return Err(Error::InvalidInput(
                "resolved capability is not an archive destination".into(),
            ));
        }
        self.parent()
            .ok_or_else(|| Error::InvalidInput("archive destination has no retained parent".into()))
    }

    /// Creates a private archive sibling through this operation's retained parent.
    pub(crate) fn create_archive_staging(
        &self,
    ) -> Result<crate::infra::fs::OwnedStagingDir, Error> {
        let parent = self.checked_archive_parent()?;
        crate::infra::fs::OwnedStagingDir::create_in(parent, ".archive")
    }

    /// Publishes through the same retained parent that created the staging owner.
    pub(crate) fn atomic_install_download_dir(
        &self,
        staging: &mut crate::infra::fs::OwnedStagingDir,
    ) -> Result<(), Error> {
        let parent = self.checked_archive_parent()?;
        let leaf = self.leaf().ok_or_else(|| {
            Error::InvalidInput("archive destination has no retained leaf".into())
        })?;
        crate::infra::fs::install_staging_dir_at(
            staging,
            parent,
            leaf,
            crate::infra::fs::DirectoryInstallPolicy::Absent,
        )
    }

    /// Transfers the already-opened, identity-checked regular file to a native
    /// streaming consumer.  This is intentionally not a path accessor.
    pub(crate) fn into_read_file(mut self) -> Result<OwnedFile, Error> {
        if !matches!(
            self.operation,
            PathOperation::ReadPgn | PathOperation::PuzzleRead
        ) {
            return Err(Error::InvalidInput(
                "resolved capability is not readable".into(),
            ));
        }
        self.file
            .take()
            .ok_or_else(|| Error::InvalidInput("resolved capability names a directory".into()))
    }

    fn fresh_pgn_snapshot(&self) -> Result<PgnSnapshot, Error> {
        let parent = self
            .parent
            .as_ref()
            .ok_or_else(|| Error::Conflict("PGN parent handle is unavailable".into()))?;
        let leaf = self
            .leaf
            .as_ref()
            .ok_or_else(|| Error::Conflict("PGN leaf handle is unavailable".into()))?;
        Self::pgn_snapshot_file(crate::infra::fs::open_regular_at(
            parent,
            leaf,
            crate::infra::fs::RegularFileAccess::ReadOnly,
        )?)
    }

    /// Snapshot of an already-opened regular file whose identity the caller has proved.
    /// A descriptor whose identity differs from `expected` is refused with `Conflict`.
    pub(crate) fn pgn_snapshot_from_identified_file(
        file: impl Into<OwnedFile>,
        expected: (u64, u64),
    ) -> Result<PgnSnapshot, Error> {
        let snapshot = Self::pgn_snapshot_file(file.into())?;
        if snapshot.identity.pair() != expected {
            return Err(Error::Conflict("workspace PGN changed concurrently".into()));
        }
        Ok(snapshot)
    }

    fn pgn_snapshot_file(file: impl Into<OwnedFile>) -> Result<PgnSnapshot, Error> {
        let file = file.into();
        let meta = file.metadata()?;
        let modified = signed_unix_nanos(meta.modified()?)?;
        #[cfg(unix)]
        let ctime_nanos = {
            use std::os::unix::fs::MetadataExt;
            i128::from(meta.ctime()).saturating_mul(1_000_000_000) + i128::from(meta.ctime_nsec())
        };
        #[cfg(windows)]
        let ctime_nanos = {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::{
                FileBasicInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO,
            };
            let mut info = std::mem::MaybeUninit::<FILE_BASIC_INFO>::zeroed();
            let ok = unsafe {
                GetFileInformationByHandleEx(
                    file.as_raw_handle() as _,
                    FileBasicInfo,
                    info.as_mut_ptr().cast(),
                    std::mem::size_of::<FILE_BASIC_INFO>() as u32,
                )
            };
            if ok == 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            i128::from(unsafe { info.assume_init() }.ChangeTime)
        };
        #[cfg(not(any(unix, windows)))]
        let ctime_nanos = 0;
        let (a, b) = opened_file_identity(&file)?;
        Ok(PgnSnapshot {
            file,
            identity: PgnSnapshotIdentity(super::Identity { a, b }),
            revision: PgnSnapshotRevision {
                size: meta.len(),
                mtime_nanos: modified,
                ctime_nanos,
            },
        })
    }

    #[cfg(all(test, unix))]
    pub(crate) fn atomic_replace_download<F>(&self, write: F) -> Result<AtomicFileOutcome, Error>
    where
        F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
    {
        self.atomic_replace_download_cancellable(&CancellationToken::new(), write)
    }

    /// Test-only ungated variant: production downloads publish through
    /// `atomic_replace_download_cancellable_with_commit_gate`, so that a cancellation
    /// acknowledged before the rename can never be followed by a publication.
    #[cfg(all(test, unix))]
    pub(crate) fn atomic_replace_download_cancellable<F>(
        &self,
        cancellation: &CancellationToken,
        write: F,
    ) -> Result<AtomicFileOutcome, Error>
    where
        F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
    {
        self.atomic_replace_download_cancellable_inner(cancellation, None, write)
    }

    fn atomic_replace_download_cancellable_inner<F>(
        &self,
        cancellation: &CancellationToken,
        commit_gate: Option<&crate::infra::operations::OperationCommitGate>,
        write: F,
    ) -> Result<AtomicFileOutcome, Error>
    where
        F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
    {
        if self.operation != PathOperation::DownloadFile {
            return Err(Error::InvalidInput(
                "resolved capability is not a download destination".into(),
            ));
        }
        let parent = self
            .parent
            .as_ref()
            .ok_or_else(|| Error::Conflict("download parent descriptor is unavailable".into()))?;
        let leaf = self
            .leaf
            .as_ref()
            .ok_or_else(|| Error::Conflict("download leaf descriptor is unavailable".into()))?;
        let precommit_cancellation = cancellation.clone();
        let commit_gate = commit_gate.cloned();
        crate::infra::fs::atomic_replace_at_with_precommit(
            parent,
            leaf,
            move || {
                self.revalidate_logical_parent()?;
                if precommit_cancellation.is_cancelled() {
                    return Err(Error::Cancellation);
                }
                if let Some(commit_gate) = commit_gate.as_ref() {
                    commit_gate.begin_commit()?
                }
                Ok(())
            },
            write,
        )
    }

    pub(crate) fn atomic_replace_download_cancellable_with_commit_gate<F>(
        &self,
        cancellation: &CancellationToken,
        commit_gate: &crate::infra::operations::OperationCommitGate,
        write: F,
    ) -> Result<AtomicFileOutcome, Error>
    where
        F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
    {
        self.atomic_replace_download_cancellable_inner(cancellation, Some(commit_gate), write)
    }

    /// Streams a previously reserved staging file into the private atomic temporary inode and
    /// verifies its exact reservation digest before `renameat`. Changed staging bytes therefore
    /// fail before the visible target changes.
    #[cfg(all(test, unix))]
    pub(crate) fn atomic_install_reserved_download(
        &self,
        reservation: &super::PendingArtifactReservation,
        staged_payload: &mut fs::File,
    ) -> Result<AtomicInstalledFile, Error> {
        self.atomic_install_reserved_download_cancellable(
            reservation,
            staged_payload,
            &CancellationToken::new(),
            None,
        )
    }

    pub(crate) fn atomic_install_reserved_download_cancellable(
        &self,
        reservation: &super::PendingArtifactReservation,
        staged_payload: &mut fs::File,
        cancellation: &CancellationToken,
        commit_gate: Option<&crate::infra::operations::OperationCommitGate>,
    ) -> Result<AtomicInstalledFile, Error> {
        staged_payload.rewind()?;
        let expected_size = reservation.payload_size;
        let expected_hash = reservation.payload_sha256.clone();
        let parent = self
            .parent
            .as_ref()
            .ok_or_else(|| Error::Conflict("download parent descriptor is unavailable".into()))?;
        let leaf = self
            .leaf
            .as_ref()
            .ok_or_else(|| Error::Conflict("download leaf descriptor is unavailable".into()))?;
        let copy_cancellation = cancellation.clone();
        let precommit_cancellation = cancellation.clone();
        let commit_gate = commit_gate.cloned();
        crate::infra::fs::atomic_replace_at_identified_with_precommit(
            parent,
            leaf,
            || {
                self.revalidate_logical_parent()?;
                if precommit_cancellation.is_cancelled() {
                    return Err(Error::Cancellation);
                }
                if let Some(commit_gate) = commit_gate.as_ref() {
                    commit_gate.begin_commit()?;
                }
                Ok(())
            },
            move |target| {
                let mut hasher = sha2::Sha256::new();
                let mut copied = 0_u64;
                let mut buffer = [0_u8; 64 * 1024];
                loop {
                    if copy_cancellation.is_cancelled() {
                        return Err(Error::Cancellation);
                    }
                    let read = staged_payload.read(&mut buffer)?;
                    if read == 0 {
                        break;
                    }
                    copied = copied.checked_add(read as u64).ok_or_else(|| {
                        Error::ResourceLimit("artifact payload exceeds supported size".into())
                    })?;
                    hasher.update(&buffer[..read]);
                    target.write_all(&buffer[..read])?;
                }
                if copied != expected_size || format!("{:x}", hasher.finalize()) != expected_hash {
                    return Err(Error::Conflict(
                        "staging payload changed after artifact reservation".into(),
                    ));
                }
                Ok(())
            },
        )
    }

    fn revalidate_logical_parent(&self) -> Result<(), Error> {
        let retained = self
            .parent
            .as_ref()
            .ok_or_else(|| Error::Conflict("retained parent descriptor is unavailable".into()))?;
        let expected = opened_file_identity(retained)?;
        let logical_parent = self
            .target
            .as_deref()
            .and_then(Path::parent)
            .ok_or_else(|| Error::Conflict("logical parent path is unavailable".into()))?;
        #[cfg(windows)]
        let current = {
            let directory = open_windows_directory_walk(logical_parent, false)?;
            super::windows_file_identity(&directory)?
        };
        #[cfg(not(windows))]
        let current = super::identity(logical_parent)?;
        if (current.a, current.b) != expected {
            return Err(Error::Conflict(
                "logical parent changed after resolution".into(),
            ));
        }
        Ok(())
    }

    fn pgn_allowed(&self) -> Result<(), Error> {
        if matches!(
            self.operation,
            PathOperation::ReadPgn | PathOperation::WritePgn
        ) {
            Ok(())
        } else {
            Err(Error::InvalidInput(
                "resolved capability is not a PGN capability".into(),
            ))
        }
    }

    pub(crate) fn pgn_snapshot(&self) -> Result<PgnSnapshot, Error> {
        self.pgn_allowed()?;
        let file = self
            .file
            .as_ref()
            .ok_or_else(|| Error::InvalidInput("PGN capability names a directory".into()))?
            .try_clone()?;
        Self::pgn_snapshot_file(file)
    }

    /// Re-establish publication durability before resolving a pending practice remap.
    pub(crate) fn pgn_publication_sync(
        &self,
    ) -> Result<impl FnOnce() -> Result<(), Error> + Send + 'static, Error> {
        self.pgn_allowed()?;
        let parent = self
            .parent
            .as_ref()
            .ok_or_else(|| Error::Conflict("PGN parent descriptor is unavailable".into()))?
            .try_clone()?;
        Ok(move || {
            parent.sync_all().map_err(|_| {
                Error::CommittedDurabilityUncertain(crate::error::DurabilityStage::PgnEdit)
            })
        })
    }

    /// Returns the backend-only location for an already-opened puzzle database.
    /// The retained file handle pins the exact identity through the SQLite
    /// operation, so the renderer never gains a native path or sibling handle.
    pub(crate) fn puzzle_database_path(&self) -> Result<PathBuf, Error> {
        if !matches!(
            self.operation,
            PathOperation::PuzzleRead | PathOperation::PuzzleDelete
        ) {
            return Err(Error::InvalidInput(
                "resolved capability is not a puzzle database".into(),
            ));
        }
        self.file
            .as_ref()
            .ok_or_else(|| Error::InvalidInput("puzzle capability names a directory".into()))?;
        self.target
            .clone()
            .ok_or_else(|| Error::Conflict("puzzle database target is unavailable".into()))
    }

    pub(crate) fn puzzle_database_identity(&self) -> Result<(u64, u64), Error> {
        self.puzzle_database_path()?;
        opened_file_identity(
            self.file
                .as_ref()
                .ok_or_else(|| Error::InvalidInput("puzzle capability names a directory".into()))?,
        )
    }

    /// Mints the repository carrier from the retained puzzle capability. This is a blocking
    /// filesystem operation and callers must construct it inside their blocking closure.
    pub(crate) fn puzzle_database_target(&self) -> Result<DatabaseFileTarget, Error> {
        if !matches!(
            self.operation,
            PathOperation::PuzzleRead | PathOperation::PuzzleDelete
        ) {
            return Err(Error::InvalidInput(
                "resolved capability is not a puzzle database".into(),
            ));
        }
        let parent = self
            .parent()
            .ok_or_else(|| Error::InvalidInput("puzzle capability names a directory".into()))?
            .try_clone()?;
        let leaf = self
            .leaf()
            .ok_or_else(|| Error::InvalidInput("puzzle capability names a directory".into()))?
            .to_os_string();
        let identity =
            opened_file_identity(self.file.as_ref().ok_or_else(|| {
                Error::InvalidInput("puzzle capability names a directory".into())
            })?)?;
        let path = self
            .target()
            .ok_or_else(|| Error::Conflict("puzzle database target is unavailable".into()))?
            .to_path_buf();
        let mut target = DatabaseFileTarget::assemble(parent, leaf, identity, path);
        target.validation = super::DatabaseTargetValidation::RetainedParent;
        Ok(target)
    }

    /// Duplicate the already-authorized descriptor for SQLite. The caller owns
    /// this duplicate for the complete database connection lifetime, so a
    /// pathname swap cannot redirect SQLite after capability resolution.
    pub(crate) fn puzzle_database_file(&self) -> Result<OwnedFile, Error> {
        self.puzzle_database_path()?;
        self.file
            .as_ref()
            .ok_or_else(|| Error::InvalidInput("puzzle capability names a directory".into()))?
            .try_clone()
            .map_err(Error::from)
    }

    /// Deletes only the same regular file that was opened during capability resolution. The
    /// shared descriptor-relative primitive verifies the entry identity and performs the delete
    /// relative to the retained parent on every supported platform.
    pub(crate) fn delete_puzzle_database(&self) -> Result<(), Error> {
        if self.operation != PathOperation::PuzzleDelete {
            return Err(Error::InvalidInput(
                "resolved capability does not permit puzzle deletion".into(),
            ));
        }
        let expected =
            opened_file_identity(self.file.as_ref().ok_or_else(|| {
                Error::InvalidInput("puzzle capability names a directory".into())
            })?)?;
        let parent = self.parent.as_ref().ok_or_else(|| {
            Error::Conflict("puzzle database parent handle is unavailable".into())
        })?;
        let leaf = self
            .leaf
            .as_ref()
            .ok_or_else(|| Error::Conflict("puzzle database leaf handle is unavailable".into()))?;
        crate::infra::fs::remove_entry_at(parent, leaf, expected, false).map_err(
            |error| match error {
                Error::Conflict(_) => {
                    Error::Conflict("puzzle database changed before deletion".into())
                }
                error => error,
            },
        )
    }

    /// Marks exactly the authority-resolved engine file executable. Windows has no POSIX
    /// executable bit; its `#[cfg(not(unix))]` counterpart checks the same engine-install file
    /// shape and succeeds as a checked no-op.
    #[cfg(unix)]
    pub(crate) fn mark_engine_executable(&self) -> Result<(), Error> {
        if self.operation != PathOperation::EngineInstall {
            return Err(Error::InvalidInput(
                "resolved capability is not an engine install target".into(),
            ));
        }
        use rustix::fs::{fchmod, Mode};
        use std::os::unix::fs::MetadataExt;
        let file = self
            .file
            .as_ref()
            .ok_or_else(|| Error::InvalidInput("engine target is a directory".into()))?;
        let mode = file.metadata()?.mode() | 0o111;
        fchmod(
            file,
            Mode::from_raw_mode(crate::infra::fs::raw_mode_from(mode)?),
        )
        .map_err(|error| Error::from(std::io::Error::from(error)))
    }

    #[cfg(not(unix))]
    pub(crate) fn mark_engine_executable(&self) -> Result<(), Error> {
        if self.operation != PathOperation::EngineInstall {
            return Err(Error::InvalidInput(
                "resolved capability is not an engine install target".into(),
            ));
        }
        self.file
            .as_ref()
            .ok_or_else(|| Error::InvalidInput("engine target is a directory".into()))?;
        Ok(())
    }

    pub(crate) fn replace_pgn_atomic<F>(
        &self,
        expected: &PgnSnapshot,
        cancellation: &CancellationToken,
        write: F,
    ) -> Result<AtomicInstalledFile, Error>
    where
        F: FnOnce(&mut OwnedFile, &mut OwnedFile) -> Result<(), Error>,
    {
        crate::infra::platform_support::off_unix_refusal("PGN atomic replacement", cfg!(unix))?;
        if self.operation != PathOperation::WritePgn {
            return Err(Error::InvalidInput(
                "resolved capability is not writable PGN".into(),
            ));
        }
        let parent = self
            .parent
            .as_ref()
            .ok_or_else(|| Error::Conflict("PGN parent descriptor is unavailable".into()))?;
        let leaf = self
            .leaf
            .as_ref()
            .ok_or_else(|| Error::Conflict("PGN leaf descriptor is unavailable".into()))?;
        let mut source = expected.file.try_clone()?;
        crate::infra::fs::atomic_replace_at_identified_with_precommit(
            parent,
            leaf,
            || {
                if cancellation.is_cancelled() {
                    return Err(Error::Cancellation);
                }
                self.revalidate_logical_parent()?;
                let current = self.fresh_pgn_snapshot()?;
                if current.identity != expected.identity || current.revision != expected.revision {
                    return Err(Error::Conflict("PGN changed before atomic commit".into()));
                }
                Ok(())
            },
            |temporary| write(&mut source, temporary),
        )
    }

    /// Reads only the already-opened, identity-checked file; no directory or sibling handle is exposed.
    #[cfg(test)]
    pub fn read_bytes(&mut self) -> Result<Vec<u8>, Error> {
        if !matches!(
            self.operation,
            PathOperation::ReadPgn
                | PathOperation::PuzzleRead
                | PathOperation::OpeningBookRead
                | PathOperation::ImageRead
        ) {
            return Err(Error::InvalidInput(
                "resolved capability is not readable".into(),
            ));
        }
        let mut bytes = Vec::new();
        self.file_mut()?.read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    #[cfg(test)]
    fn file_mut(&mut self) -> Result<&mut OwnedFile, Error> {
        self.file.as_mut().ok_or_else(|| {
            Error::InvalidInput(
                "resolved capability names a directory; a file component is required".into(),
            )
        })
    }

    /// Builds a `ResolvedPath` directly for the Windows executable-no-op runtime test. Its fields
    /// are private to this module, and the Windows-only test cannot run on the Linux source-pin
    /// host, so this is the only way to exercise the counterpart body without a full resolve.
    #[cfg(all(test, windows))]
    fn windows_test(operation: PathOperation, file: Option<OwnedFile>) -> Self {
        Self {
            operation,
            file,
            directory: None,
            parent: None,
            leaf: None,
            target: None,
        }
    }

    /// Builds an archive destination without a retained parent for the Unix registration-boundary
    /// test, proving that parent identity cannot be inferred from the target pathname.
    #[cfg(all(test, unix))]
    pub(crate) fn download_archive_test(target: PathBuf) -> Self {
        Self {
            operation: PathOperation::DownloadArchive,
            file: None,
            #[cfg(unix)]
            regular_file_identity: None,
            directory: None,
            parent: None,
            leaf: None,
            target: Some(target),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct PgnSnapshotIdentity(super::Identity);
impl PgnSnapshotIdentity {
    pub(crate) fn pair(&self) -> (u64, u64) {
        (self.0.a, self.0.b)
    }

    pub(crate) fn from_pair(pair: (u64, u64)) -> Self {
        Self(super::Identity {
            a: pair.0,
            b: pair.1,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct PgnSnapshotRevision {
    pub size: u64,
    pub mtime_nanos: i128,
    pub ctime_nanos: i128,
}
pub(crate) struct PgnSnapshot {
    pub file: OwnedFile,
    pub identity: PgnSnapshotIdentity,
    pub revision: PgnSnapshotRevision,
}

impl PgnSnapshot {
    pub(crate) fn current_revision(&self) -> Result<PgnSnapshotRevision, Error> {
        Ok(ResolvedPath::pgn_snapshot_file(self.file.try_clone()?)?.revision)
    }
}

fn signed_unix_nanos(time: SystemTime) -> Result<i128, Error> {
    const MESSAGE: &str = "PGN modification time is out of range";
    match time.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(duration) => {
            i128::try_from(duration.as_nanos()).map_err(|_| Error::InvalidInput(MESSAGE.into()))
        }
        Err(error) => i128::try_from(error.duration().as_nanos())
            .map(|nanos| -nanos)
            .map_err(|_| Error::InvalidInput(MESSAGE.into())),
    }
}

#[cfg(unix)]
pub(super) fn file_identity(meta: &fs::Metadata) -> super::Identity {
    use std::os::unix::fs::MetadataExt;
    super::Identity {
        a: meta.dev(),
        b: meta.ino(),
    }
}

#[cfg(unix)]
/// `stored_parent_identity` is `None` for a transient dialog grant (not parent-checked here; its
/// parent is enforced at promotion), `Some(&None)` for a registry file entry without a recorded
/// parent (refused, fail closed), and `Some(&Some(id))` for one bound to directory `id`.
pub(super) fn resolve_unix(
    root: &Path,
    expected_root: &super::Identity,
    root_is_dir: bool,
    stored_parent_identity: Option<&Option<super::Identity>>,
    components: &[OsString],
    operation: PathOperation,
    engine_root: Option<&super::StoredEntry>,
) -> Result<ResolvedPath, Error> {
    use rustix::fs::{self as rfs, FileType, Mode, OFlags};
    let base = if root_is_dir {
        root
    } else {
        root.parent()
            .ok_or_else(|| Error::InvalidInput("file authority has no parent".into()))?
    };
    let mut handle = fs::File::from(
        rfs::openat(
            rfs::CWD,
            base,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|e| {
            let error = super::conflict_if_replaced(
                Error::from(std::io::Error::from(e)),
                "path authority is unavailable because its object changed",
            );
            super::label_engine_root_open(error, engine_root, false)
        })?,
    );
    if root_is_dir
        && file_identity(
            &handle
                .metadata()
                .map_err(|error| super::label_engine_root_open(error.into(), engine_root, false))?,
        ) != *expected_root
    {
        return Err(super::label_engine_root_open(
            Error::Conflict("root changed concurrently".into()),
            engine_root,
            false,
        ));
    }
    if !root_is_dir {
        if let Some(expected_parent) = stored_parent_identity {
            super::verify_parent_identity(&handle, expected_parent.as_ref())?;
        }
    }
    let names: Vec<OsString> = if root_is_dir {
        components.to_vec()
    } else {
        if !components.is_empty() {
            return Err(Error::InvalidInput(
                "file authority cannot have child components".into(),
            ));
        }
        vec![root
            .file_name()
            .ok_or_else(|| Error::InvalidInput("invalid file authority".into()))?
            .to_os_string()]
    };
    let mut exact_file = None;
    let mut regular_file_identity = None;
    for (index, name) in names.iter().enumerate() {
        let last = index + 1 == names.len();
        let stat = match rfs::statat(&handle, name, rfs::AtFlags::SYMLINK_NOFOLLOW) {
            Ok(stat) => stat,
            Err(error)
                if last
                    && matches!(
                        operation,
                        PathOperation::DownloadFile
                            | PathOperation::DownloadArchive
                            | PathOperation::DatabaseCreate
                    )
                    && error == rustix::io::Errno::NOENT =>
            {
                return Ok(ResolvedPath {
                    operation,
                    file: None,
                    regular_file_identity: None,
                    directory: None,
                    parent: Some(handle.try_clone()?),
                    leaf: Some(name.clone()),
                    target: Some(names.iter().fold(root.to_path_buf(), |mut path, name| {
                        path.push(name);
                        path
                    })),
                });
            }
            Err(error) => return Err(Error::from(std::io::Error::from(error))),
        };
        let ty = FileType::from_raw_mode(stat.st_mode);
        if ty == FileType::Symlink
            || (!last && ty != FileType::Directory)
            || (last && ty != FileType::Directory && ty != FileType::RegularFile)
        {
            return Err(Error::InvalidInput(
                "path contains a symlink or special file".into(),
            ));
        }
        if last && ty == FileType::RegularFile {
            let (a, b) = crate::infra::fs::raw_stat_identity(&stat);
            let leaf_identity = super::Identity { a, b };
            if !root_is_dir && leaf_identity != *expected_root {
                return Err(Error::Conflict(
                    "file authority changed concurrently".into(),
                ));
            }
            // SQLite consumes database bytes through its binding, never through this resolver.
            // Retain the no-follow observation without opening a lockable leaf descriptor.
            if !super::is_database_file_operation(operation) {
                #[cfg(test)]
                super::RESOLVE_PRE_REGULAR_OPEN_HOOK.with(|slot| {
                    if let Some(hook) = slot.borrow_mut().take() {
                        hook();
                    }
                });
                let access = if is_write_operation(operation) {
                    RegularFileAccess::ReadWrite
                } else {
                    RegularFileAccess::ReadOnly
                };
                let file = crate::infra::fs::open_regular_at(&handle, name, access)?;
                if file_identity(&file.metadata()?) != leaf_identity {
                    return Err(Error::Conflict("file changed while resolving".into()));
                }
                exact_file = Some(file);
            }
            regular_file_identity = Some(leaf_identity);
        }
        if ty == FileType::Directory {
            #[cfg(test)]
            super::RESOLVE_PRE_DIRECTORY_OPEN_HOOK.with(|slot| {
                if let Some(hook) = slot.borrow_mut().take() {
                    hook();
                }
            });
            handle = fs::File::from(
                rfs::openat(
                    &handle,
                    name,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|e| {
                    super::conflict_if_replaced(
                        Error::from(std::io::Error::from(e)),
                        "directory changed while resolving",
                    )
                })?,
            );
            let opened_identity = file_identity(&handle.metadata()?);
            let (a, b) = crate::infra::fs::raw_stat_identity(&stat);
            let stat_identity = super::Identity { a, b };
            if opened_identity != stat_identity {
                return Err(Error::Conflict("directory changed while resolving".into()));
            }
        }
    }
    let parent = regular_file_identity
        .as_ref()
        .map(|_| handle.try_clone())
        .transpose()?;
    let leaf = if regular_file_identity.is_some() {
        Some(
            names
                .last()
                .ok_or_else(|| Error::Conflict("resolved PGN has no leaf component".into()))?
                .clone(),
        )
    } else {
        None
    };
    let directory = if regular_file_identity.is_none() {
        Some(handle)
    } else {
        None
    };
    Ok(ResolvedPath {
        operation,
        file: exact_file,
        regular_file_identity,
        directory,
        parent,
        leaf,
        target: if root_is_dir {
            Some(names.iter().fold(root.to_path_buf(), |mut path, name| {
                path.push(name);
                path
            }))
        } else {
            Some(root.to_path_buf())
        },
    })
}

#[cfg(windows)]
/// `stored_parent_identity` is `None` for a transient dialog grant (not parent-checked here; its
/// parent is enforced at promotion), `Some(&None)` for a registry file entry without a recorded
/// parent (refused, fail closed), and `Some(&Some(id))` for one bound to directory `id`.
pub(super) fn resolve_windows(
    root: &Path,
    expected_root: &super::Identity,
    root_is_dir: bool,
    stored_parent_identity: Option<&Option<super::Identity>>,
    components: &[OsString],
    operation: PathOperation,
    engine_root: Option<&super::StoredEntry>,
) -> Result<ResolvedPath, Error> {
    use std::ptr::null;
    use windows_sys::{
        Wdk::Storage::FileSystem::FILE_OPEN,
        Win32::{
            Foundation::{GENERIC_READ, GENERIC_WRITE},
            Storage::FileSystem::SYNCHRONIZE,
        },
    };

    fn allows_missing_leaf(operation: PathOperation) -> bool {
        matches!(
            operation,
            PathOperation::DownloadFile
                | PathOperation::DownloadArchive
                | PathOperation::DatabaseCreate
        )
    }

    /// `NtCreateFile` answers a non-directory at a `FILE_DIRECTORY_FILE` leaf with
    /// `STATUS_NOT_A_DIRECTORY`, which `windows_open_status_error` maps to `ERROR_DIRECTORY`.
    fn is_not_a_directory_error(error: &Error) -> bool {
        matches!(
            error,
            Error::Io(error)
                if error.raw_os_error()
                    == Some(windows_sys::Win32::Foundation::ERROR_DIRECTORY as i32)
        )
    }

    // R1-03/R2-02 - two predicates, not one. The PARENT of the final component must carry
    // GENERIC_WRITE for any operation that creates or replaces the leaf, because the retained
    // parent descriptor also serves FILE_CREATE for the temporary and the RootDirectory rename,
    // and because FlushFileBuffers fails with os error 5 on a read-only directory handle (E2).
    // The CHILD's access keeps is_write_operation's membership unchanged: opening an existing
    // target writable would fail for a target whose DACL permits delete/replace but denies write.
    let child_writable = is_write_operation(operation);
    let parent_writable = child_writable || allows_missing_leaf(operation);
    let access = SYNCHRONIZE | GENERIC_READ | if child_writable { GENERIC_WRITE } else { 0 };
    let parent_access =
        SYNCHRONIZE | GENERIC_READ | if parent_writable { GENERIC_WRITE } else { 0 };
    let mut handle = if root_is_dir {
        let handle = super::open_windows_nofollow(root, parent_writable).map_err(|error| {
            let error = super::conflict_if_replaced(
                error,
                "path authority is unavailable because its object changed",
            );
            super::label_engine_root_open(error, engine_root, parent_writable)
        })?;
        if super::windows_file_identity(&handle)
            .map_err(|error| super::label_engine_root_open(error, engine_root, false))?
            != *expected_root
        {
            return Err(super::label_engine_root_open(
                Error::Conflict("root changed concurrently".into()),
                engine_root,
                false,
            ));
        }
        handle
    } else if !components.is_empty() {
        return Err(Error::InvalidInput(
            "file authority cannot have child components".into(),
        ));
    } else {
        super::open_windows_nofollow(
            root.parent()
                .ok_or_else(|| Error::InvalidInput("file authority has no parent".into()))?,
            parent_writable,
        )
        .map_err(|error| {
            super::conflict_if_replaced(
                error,
                "path authority is unavailable because its object changed",
            )
        })?
    };
    if !root_is_dir {
        if let Some(expected_parent) = stored_parent_identity {
            super::verify_parent_identity(&handle, expected_parent.as_ref())?;
        }
    }
    let names: Vec<OsString> = if root_is_dir {
        components.to_vec()
    } else {
        vec![root
            .file_name()
            .ok_or_else(|| Error::InvalidInput("invalid file authority".into()))?
            .to_os_string()]
    };
    let target = if root_is_dir {
        Some(names.iter().fold(root.to_path_buf(), |mut path, name| {
            path.push(name);
            path
        }))
    } else {
        Some(root.to_path_buf())
    };
    for (index, name) in names.iter().enumerate() {
        let last = index + 1 == names.len();
        // An archive destination names a directory the renderer never creates: the engine
        // download stages beside it and installs onto it, so the leaf is opened as a directory
        // even when it is the final component. That turns "an existing regular file sits at the
        // archive destination" into a typed refusal instead of an `Io` error from a
        // non-directory open.
        let download_dir_leaf = last && operation == PathOperation::DownloadArchive;
        let kind = if !last || download_dir_leaf {
            super::WindowsChildKind::Directory
        } else if root_is_dir && operation == PathOperation::EngineResourceRead {
            super::WindowsChildKind::FileOrDirectory
        } else {
            super::WindowsChildKind::NonDirectory
        };
        // Every operation that can yield an EngineExecutable is kept open
        // without FILE_SHARE_DELETE until CreateProcess has opened it. This
        // seals the authority-validated path against replacement in the
        // otherwise unavoidable Windows path-based launch API.
        let file = match super::open_windows_child_with_kind(
            &handle,
            name,
            FILE_OPEN,
            if last { access } else { parent_access },
            null(),
            kind,
            super::allows_delete_sharing_for_operation(operation, last),
        ) {
            Ok(file) => file,
            Err(error) if last && allows_missing_leaf(operation) && error.is_missing_entry() => {
                return Ok(ResolvedPath {
                    operation,
                    file: None,
                    directory: None,
                    parent: Some(handle.try_clone()?),
                    leaf: Some(name.clone()),
                    target: target.clone(),
                });
            }
            Err(error) if download_dir_leaf && is_not_a_directory_error(&error) => {
                return Err(Error::InvalidInput(
                    "archive destination must be a directory".into(),
                ));
            }
            Err(error) => return Err(error),
        };
        let meta = file.metadata()?;
        if download_dir_leaf {
            if super::is_reparse_point(&meta) || !meta.is_dir() {
                return Err(Error::InvalidInput(
                    "archive destination must be a directory".into(),
                ));
            }
            return Ok(ResolvedPath {
                operation,
                file: None,
                directory: Some(file),
                parent: Some(handle.try_clone()?),
                leaf: Some(name.clone()),
                target,
            });
        }
        if super::is_reparse_point(&meta)
            || (!last && !meta.is_dir())
            || (last && !meta.is_dir() && !meta.is_file())
        {
            return Err(Error::InvalidInput(
                "path contains a reparse point or special file".into(),
            ));
        }
        if last && meta.is_file() {
            if !root_is_dir && super::windows_file_identity(&file)? != *expected_root {
                return Err(Error::Conflict(
                    "file authority changed concurrently".into(),
                ));
            }
            return Ok(ResolvedPath {
                operation,
                file: Some(crate::infra::inode_ownership::own_windows(file)?),
                directory: None,
                parent: Some(handle.try_clone()?),
                leaf: Some(name.clone()),
                target,
            });
        }
        handle = file;
    }
    // The terminal component is a directory: the handle the walk opened and verified IS the
    // capability. Dropping it would leave `capability_directory` with no descriptor to hand out
    // and force a second, unpinned open by pathname. The computed `target` is carried on the
    // lease as the UCI/CreateProcess string, exactly as the file return above does.
    Ok(ResolvedPath {
        operation,
        file: None,
        directory: Some(handle),
        parent: None,
        leaf: None,
        target,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn anonymous_pgn(bytes: &[u8]) -> fs::File {
        let mut file = tempfile::tempfile().expect("anonymous PGN");
        file.write_all(bytes).expect("write PGN");
        file.seek(std::io::SeekFrom::Start(0)).expect("rewind");
        file
    }

    #[test]
    fn archive_staging_authority_requires_archive_operation_and_retained_parent() {
        let dir = tempfile::tempdir().unwrap();
        let staging_dir = tempfile::tempdir().unwrap();
        let mut staging = crate::infra::fs::OwnedStagingDir::adopt(&staging_dir).unwrap();
        let parent =
            crate::infra::fs::open_parent_no_follow(&dir.path().join("installed")).unwrap();
        let mut resolved = ResolvedPath {
            operation: PathOperation::ReadPgn,
            file: None,
            #[cfg(unix)]
            regular_file_identity: None,
            directory: None,
            parent: Some(parent),
            leaf: Some("installed".into()),
            target: Some(dir.path().join("installed")),
        };
        assert!(matches!(
            resolved.create_archive_staging(),
            Err(Error::InvalidInput(message))
                if message == "resolved capability is not an archive destination"
        ));
        assert!(matches!(
            resolved.atomic_install_download_dir(&mut staging),
            Err(Error::InvalidInput(message))
                if message == "resolved capability is not an archive destination"
        ));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        assert!(staging_dir.path().is_dir());
        resolved.operation = PathOperation::DownloadArchive;
        resolved.parent = None;
        assert!(matches!(
            resolved.create_archive_staging(),
            Err(Error::InvalidInput(message))
                if message == "archive destination has no retained parent"
        ));
        assert!(matches!(
            resolved.atomic_install_download_dir(&mut staging),
            Err(Error::InvalidInput(message))
                if message == "archive destination has no retained parent"
        ));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        assert!(staging_dir.path().is_dir());
        resolved.operation = PathOperation::ReadPgn;
        assert!(matches!(
            resolved.create_archive_staging(),
            Err(Error::InvalidInput(message))
                if message == "resolved capability is not an archive destination"
        ));
        assert!(matches!(
            resolved.atomic_install_download_dir(&mut staging),
            Err(Error::InvalidInput(message))
                if message == "resolved capability is not an archive destination"
        ));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        assert!(staging_dir.path().is_dir());
    }

    #[test]
    fn identified_snapshot_refuses_a_descriptor_with_a_different_identity() {
        let matching_file = anonymous_pgn(b"1. e4 *");
        let other_file = anonymous_pgn(b"1. d4 *");
        let expected = opened_file_identity(&matching_file).expect("matching identity");
        let snapshot = ResolvedPath::pgn_snapshot_from_identified_file(matching_file, expected)
            .expect("matching identity is accepted");
        assert_eq!(snapshot.identity.pair(), expected);
        let error = match ResolvedPath::pgn_snapshot_from_identified_file(other_file, expected) {
            Ok(_) => panic!("different identity is refused"),
            Err(error) => error,
        };
        assert!(matches!(error, Error::Conflict(_)), "{error:?}");
    }

    #[test]
    fn snapshot_mtime_accepts_pre_epoch_seconds_and_keeps_post_epoch_revision_digits() {
        let file = anonymous_pgn(b"1. e4 *");
        file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1))
            .expect("set post-epoch mtime");
        let post = ResolvedPath::pgn_snapshot_file(file.try_clone().expect("clone"))
            .expect("post-epoch snapshot");
        assert!(post.revision.mtime_nanos > 0);
        let post_revision = format!("{}", post.revision.mtime_nanos);
        assert!(
            !post_revision.starts_with('-'),
            "post-1970 revision digits must stay unsigned in form: {post_revision}"
        );
        file.set_modified(SystemTime::UNIX_EPOCH - Duration::from_secs(1))
            .expect("set pre-epoch mtime");
        let pre = ResolvedPath::pgn_snapshot_file(file).expect("pre-epoch snapshot");
        assert!(pre.revision.mtime_nanos < 0);
    }
}

/// Runtime half of the executable no-op pin (R1-07). The counterpart cannot be compiled on the
/// Linux proof host, so the source pin in `platform_support` and this `#[cfg(windows)]` test
/// together hold the contract: an engine-install regular file is accepted and a wrong operation
/// or a directory shape is `InvalidInput`.
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn windows_resource_sealing_refuses_a_different_terminal_identity() {
        use crate::infra::path_authority::{EngineResourceHandleKind, PathAuthority, PathClass};

        for kind in [
            EngineResourceHandleKind::File,
            EngineResourceHandleKind::Directory,
        ] {
            let temp = tempfile::tempdir().unwrap();
            let original = temp.path().join("original");
            let replacement = temp.path().join("replacement");
            if kind == EngineResourceHandleKind::Directory {
                fs::create_dir(&original).unwrap();
                fs::create_dir(&replacement).unwrap();
            } else {
                fs::write(&original, b"original").unwrap();
                fs::write(&replacement, b"replacement").unwrap();
            }
            let mut authority =
                PathAuthority::open(temp.path().join("registry.json"), vec![]).unwrap();
            let grant = authority
                .grant_dialog(
                    &original,
                    "resource",
                    PathClass::SingleDialogGrant,
                    PathOperation::EngineResourceRead,
                    std::time::Duration::from_secs(30),
                    1,
                )
                .unwrap();
            let resource = authority
                .promote_engine_resource(&grant, kind, "resource")
                .unwrap();
            let mut resolved = authority
                .resolve(resource.path_ref(), PathOperation::EngineResourceRead, &[])
                .unwrap();
            let seals = resolved.windows_resource_directory_seals().unwrap();
            assert!(
                !seals.is_empty(),
                "the absolute ancestor chain must remain held"
            );
            drop(seals);
            // Redirect only the separate pass's locator. Its otherwise valid new object must
            // never replace the identity captured by the original authority resolution.
            resolved.target = Some(fs::canonicalize(&replacement).unwrap());
            assert!(matches!(
                resolved.windows_resource_directory_seals(),
                Err(Error::Conflict(_))
            ));
        }
    }

    #[test]
    fn mark_engine_executable_windows_is_a_checked_noop() {
        let file = tempfile::tempfile().unwrap();
        ResolvedPath::windows_test(PathOperation::EngineInstall, Some(file.into()))
            .mark_engine_executable()
            .unwrap();
        assert!(matches!(
            ResolvedPath::windows_test(PathOperation::EngineInstall, None).mark_engine_executable(),
            Err(Error::InvalidInput(_))
        ));
        assert!(matches!(
            ResolvedPath::windows_test(PathOperation::ReadPgn, None).mark_engine_executable(),
            Err(Error::InvalidInput(_))
        ));
    }

    /// An archive destination is a directory leaf: a regular file already sitting there is a
    /// typed `InvalidInput`, not the `Io` error a non-directory open would produce.
    #[test]
    fn download_archive_leaf_file_is_invalid_input() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("archive"), b"not a directory").unwrap();
        let parent =
            crate::infra::path_authority::open_windows_nofollow(dir.path(), false).unwrap();
        let expected = crate::infra::path_authority::windows_file_identity(&parent).unwrap();
        let components = vec![OsString::from("archive")];

        let error = match resolve_windows(
            dir.path(),
            &expected,
            true,
            None,
            &components,
            PathOperation::DownloadArchive,
            None,
        ) {
            Ok(_) => panic!("a file at the archive destination must be refused"),
            Err(error) => error,
        };

        assert!(matches!(error, Error::InvalidInput(_)), "{error:?}");
    }
}
