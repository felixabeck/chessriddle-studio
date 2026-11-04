//! Crash consistency note: a successful `DurableCommit` means the replacement and its parent
//! directory entry were synced. A process or power failure before that point may leave either
//! version present. Existing file replacement and recursive removal are optimistic: on Linux, no
//! available syscall conditionally renames or unlinks only a previously checked inode, so an
//! uncooperative writer can still win the final revalidation-to-syscall window.
//! Parent-descriptor-relative operations keep pathname resolution confined, but neither identity
//! guards nor private rename staging revoke already-open writer descriptors. Staging and target
//! parents must not be externally mutated through commit and cleanup. The injected tests prove
//! detection before that window, not compare-and-swap semantics. Commits never follow a target
//! link or leave the opened parent directory.

use crate::{
    error::{Error, WORKSPACE_FILE_NAME_TAKEN},
    infra::inode_ownership::OwnedFile,
};
#[cfg(unix)]
use std::time::Duration;
// `temp.flush()` in replace_at_driver is platform-neutral, so this trait must be in scope on
// every target, not only unix.
use std::io::Write;
#[cfg(test)]
use std::sync::Arc;
use std::{
    ffi::{OsStr, OsString},
    fs::File,
    io::Read,
    path::Path,
    time::SystemTime,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug)]
pub(crate) enum AdvisoryLockMode {
    Blocking,
    NonBlocking,
}

#[derive(Debug)]
pub(crate) enum AdvisoryLockError {
    HeldElsewhere(std::io::Error),
    Io(std::io::Error),
}

impl AdvisoryLockError {
    pub(crate) fn into_io_error(self) -> std::io::Error {
        match self {
            Self::HeldElsewhere(error) | Self::Io(error) => error,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum AdvisoryLockPlatform {
    #[cfg(any(test, target_os = "linux"))]
    Linux,
    #[cfg(any(test, target_os = "macos"))]
    MacOs,
    #[cfg(any(test, windows))]
    Windows,
}

pub(crate) fn advisory_lock_is_unsupported(
    raw_os_error: i32,
    platform: AdvisoryLockPlatform,
) -> bool {
    // Native errno values differ between Linux and Darwin. Literal tables keep every platform
    // testable on every host, including Windows errors without a windows-sys dependency on unix.
    match platform {
        #[cfg(any(test, target_os = "linux"))]
        AdvisoryLockPlatform::Linux => matches!(raw_os_error, 95 | 38), // EOPNOTSUPP/ENOTSUP, ENOSYS
        #[cfg(any(test, target_os = "macos"))]
        AdvisoryLockPlatform::MacOs => matches!(raw_os_error, 102 | 45 | 78), // EOPNOTSUPP, ENOTSUP, ENOSYS
        #[cfg(any(test, windows))]
        AdvisoryLockPlatform::Windows => matches!(raw_os_error, 50 | 1), // ERROR_NOT_SUPPORTED, ERROR_INVALID_FUNCTION
    }
}

/// Exclusively locks an already open regular file until its handle is dropped.
pub(crate) fn lock_advisory_file(
    file: &impl crate::infra::inode_ownership::NativeFile,
    mode: AdvisoryLockMode,
) -> Result<(), AdvisoryLockError> {
    #[cfg(unix)]
    {
        use rustix::{fs::FlockOperation, io::Errno};
        let operation = match mode {
            AdvisoryLockMode::Blocking => FlockOperation::LockExclusive,
            AdvisoryLockMode::NonBlocking => FlockOperation::NonBlockingLockExclusive,
        };
        rustix::fs::flock(file, operation).map_err(|error| {
            if error == Errno::AGAIN || error == Errno::WOULDBLOCK {
                AdvisoryLockError::HeldElsewhere(error.into())
            } else {
                AdvisoryLockError::Io(error.into())
            }
        })
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{ERROR_LOCK_VIOLATION, HANDLE},
            Storage::FileSystem::{LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY},
            System::IO::OVERLAPPED,
        };
        let flags = LOCKFILE_EXCLUSIVE_LOCK
            | match mode {
                AdvisoryLockMode::Blocking => 0,
                AdvisoryLockMode::NonBlocking => LOCKFILE_FAIL_IMMEDIATELY,
            };
        // SAFETY: an all-zero OVERLAPPED is valid and specifies file offset zero.
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        let result = unsafe {
            // SAFETY: the handle is a live regular file and the OVERLAPPED value is exclusively owned.
            LockFileEx(
                file.as_raw_handle() as HANDLE,
                flags,
                0,
                u32::MAX,
                u32::MAX,
                &mut overlapped,
            )
        };
        if result == 0 {
            let error = std::io::Error::last_os_error();
            return Err(
                if error.raw_os_error() == Some(ERROR_LOCK_VIOLATION as i32) {
                    AdvisoryLockError::HeldElsewhere(error)
                } else {
                    AdvisoryLockError::Io(error)
                },
            );
        }
        Ok(())
    }
}

/// A forked child can retain a dropped holder's flock until exec closes its inherited descriptor.
/// Allow that transient retention while bounding the wait for release in tests.
#[cfg(test)]
pub(crate) fn retry_until_lock_released<T>(mut attempt: impl FnMut() -> Option<T>) -> Option<T> {
    use std::time::{Duration, Instant};

    const RELEASE_DEADLINE: Duration = Duration::from_secs(5);
    const RETRY_INTERVAL: Duration = Duration::from_millis(5);
    let started = Instant::now();
    while started.elapsed() < RELEASE_DEADLINE {
        if let Some(value) = attempt() {
            return Some(value);
        }
        let remaining = RELEASE_DEADLINE.saturating_sub(started.elapsed());
        std::thread::sleep(RETRY_INTERVAL.min(remaining));
    }
    None
}

pub(crate) const MAX_DIRECTORY_LISTING_ENTRIES: usize = 4_096;

/// Check before materialising the next name or staged workspace node.
pub(crate) fn check_directory_listing_bound(count: usize, limit: usize) -> Result<(), Error> {
    if count >= limit {
        return Err(
            Error::ResourceLimit(format!("directory listing exceeded {limit} entries"))
                .with_root_failure(crate::error::RootFailure::TooLarge),
        );
    }
    Ok(())
}

#[cfg(all(test, windows))]
pub(crate) fn windows_test_parent(path: &Path) -> File {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, WRITE_DAC,
    };

    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .write(true)
        // The fixture changes the parent DACL itself, so its handle must carry WRITE_DAC rather
        // than relying on the generic write right used for ordinary directory contents.
        .access_mode(GENERIC_READ | GENERIC_WRITE | WRITE_DAC)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
    options.open(path).expect("writable parent descriptor")
}

/// A directory junction, not a symlink: `mklink /J` needs neither elevation nor Developer
/// Mode, so the fixture runs on a stock `windows-latest` runner. A failure to create it fails
/// the test rather than skipping the assertion the fixture exists to drive.
#[cfg(all(test, windows))]
pub(crate) fn windows_test_junction(link: &Path, target: &Path) {
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .status()
        .expect("mklink must run");
    assert!(status.success(), "mklink /J failed with {status}");
}

/// The file kind observed by descriptor-relative directory enumeration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DirectoryEntryKind {
    Directory,
    RegularFile,
    Other,
}

/// Metadata for a verified regular file without retaining a readable leaf descriptor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RegularFileMetadata {
    pub(crate) identity: (u64, u64),
    pub(crate) length: u64,
    pub(crate) modified: SystemTime,
}

#[cfg(all(test, unix))]
std::thread_local! {
    static REGULAR_FILE_PROBE_AFTER_ACCESS_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(all(test, unix))]
pub(crate) fn set_regular_file_probe_after_access_hook(hook: Option<Box<dyn FnOnce()>>) {
    REGULAR_FILE_PROBE_AFTER_ACCESS_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(all(test, unix))]
fn run_regular_file_probe_after_access_hook() {
    REGULAR_FILE_PROBE_AFTER_ACCESS_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

/// A directory entry snapshot carrying no pathname.
#[derive(Clone, Debug)]
pub(crate) struct DirectoryEntry {
    pub(crate) name: OsString,
    pub(crate) kind: DirectoryEntryKind,
    pub(crate) identity: (u64, u64),
    /// Seconds since the Unix epoch. On Windows the enumerated `LastWriteTime` is a FILETIME —
    /// 100-nanosecond ticks since 1601-01-01 — and is converted here, because the renderer reads
    /// `WorkspaceEntry.lastModified` as Unix seconds.
    pub(crate) modified_seconds: i64,
}

#[cfg(test)]
pub(crate) fn enumerated_directory_entry_for_test(parent: &File, leaf: &OsStr) -> DirectoryEntry {
    read_directory_entries_at(parent, &CancellationToken::new(), None, &mut |name| {
        name == leaf
    })
    .expect("enumeration")
    .into_iter()
    .find(|entry| entry.name == leaf)
    .expect("installed entry")
}

#[cfg(all(test, unix))]
type ReadDirectoryPreStatHook = Box<dyn FnMut(&OsStr)>;

#[cfg(all(test, unix))]
type ListingChildStatHook = Box<
    dyn FnMut(
        &OsStr,
        Option<DirectoryEntryKind>,
    ) -> Option<(Option<DirectoryEntryKind>, std::io::Error)>,
>;

#[cfg(all(test, unix))]
std::thread_local! {
    static READ_DIRECTORY_PRE_STAT_HOOK: std::cell::RefCell<Option<ReadDirectoryPreStatHook>> =
        const { std::cell::RefCell::new(None) };
    static LISTING_CHILD_STAT_HOOK: std::cell::RefCell<Option<ListingChildStatHook>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(all(test, unix))]
pub(crate) fn set_read_directory_pre_stat_hook(hook: Option<ReadDirectoryPreStatHook>) {
    READ_DIRECTORY_PRE_STAT_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(all(test, unix))]
pub(crate) fn set_listing_child_stat_hook(hook: Option<ListingChildStatHook>) {
    LISTING_CHILD_STAT_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(unix)]
pub(crate) fn read_directory_entries_at(
    dir: &File,
    cancellation: &CancellationToken,
    limit: Option<usize>,
    keep: &mut dyn FnMut(&OsStr) -> bool,
) -> Result<Vec<DirectoryEntry>, Error> {
    read_directory_entries_with_stat_errors(
        dir,
        cancellation,
        limit,
        keep,
        None,
        &mut |_, _, error| Err(error),
    )
}

/// Named stat failures belong to children. Stream, bound and cancellation failures remain fatal.
#[derive(Debug, Default)]
pub(crate) struct ListingDirectoryEntries {
    pub(crate) entries: Vec<DirectoryEntry>,
    pub(crate) unread: Vec<(OsString, Option<DirectoryEntryKind>, Error)>,
}

#[cfg(unix)]
pub(crate) fn read_listing_directory_entries_at(
    dir: &File,
    cancellation: &CancellationToken,
    limit: Option<usize>,
    keep: &mut dyn FnMut(&OsStr) -> bool,
) -> Result<ListingDirectoryEntries, Error> {
    let mut unread = Vec::new();
    let entries = read_directory_entries_with_stat_errors(
        dir,
        cancellation,
        limit,
        keep,
        None,
        &mut |name, kind, error| {
            unread.push((name, kind, error));
            Ok(())
        },
    )?;
    Ok(ListingDirectoryEntries { entries, unread })
}

#[cfg(unix)]
fn read_directory_entries_with_stat_errors(
    dir: &File,
    cancellation: &CancellationToken,
    limit: Option<usize>,
    keep: &mut dyn FnMut(&OsStr) -> bool,
    mut visit: Option<&mut dyn FnMut(DirectoryEntry) -> Result<(), Error>>,
    stat_error: &mut dyn FnMut(OsString, Option<DirectoryEntryKind>, Error) -> Result<(), Error>,
) -> Result<Vec<DirectoryEntry>, Error> {
    use rustix::fs::{self as rfs, AtFlags, FileType};
    use std::os::unix::ffi::OsStringExt;

    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    let mut result = Vec::new();
    let mut observed = 0;
    unix::walk_directory(dir, |bytes, _ino, file_type| {
        let name = OsString::from_vec(bytes.to_vec());
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        if let Some(limit) = limit {
            check_directory_listing_bound(observed, limit)?;
            observed += 1;
        }
        if !keep(&name) {
            return Ok(());
        }
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        #[cfg(all(test, unix))]
        READ_DIRECTORY_PRE_STAT_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().as_mut() {
                hook(&name);
            }
        });
        let listed_kind = match file_type {
            FileType::Directory => Some(DirectoryEntryKind::Directory),
            FileType::RegularFile => Some(DirectoryEntryKind::RegularFile),
            FileType::Unknown => None,
            _ => Some(DirectoryEntryKind::Other),
        };
        #[cfg(all(test, unix))]
        if let Some((kind, error)) = LISTING_CHILD_STAT_HOOK.with(|slot| {
            slot.borrow_mut()
                .as_mut()
                .and_then(|hook| hook(&name, listed_kind))
        }) {
            return stat_error(name, kind, error.into());
        }
        let stat = match rfs::statat(dir, &name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(stat) => stat,
            Err(error) => return stat_error(name, listed_kind, Error::Io(Box::new(error.into()))),
        };
        let kind = match FileType::from_raw_mode(stat.st_mode) {
            FileType::Directory => DirectoryEntryKind::Directory,
            FileType::RegularFile => DirectoryEntryKind::RegularFile,
            _ => DirectoryEntryKind::Other,
        };
        let entry = DirectoryEntry {
            name,
            kind,
            identity: unix::raw_stat_identity(&stat),
            modified_seconds: stat.st_mtime,
        };
        if let Some(visit) = visit.as_mut() {
            visit(entry)?;
        } else {
            result.push(entry);
        }
        Ok(())
    })?;
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    unix::ensure_directory_not_removed(dir)?;
    Ok(result)
}

/// Visits a directory without retaining its contents or imposing a total-entry bound.
pub(crate) fn visit_directory_entries_at(
    dir: &File,
    cancellation: &CancellationToken,
    visit: &mut dyn FnMut(DirectoryEntry) -> Result<(), Error>,
) -> Result<(), Error> {
    #[cfg(unix)]
    {
        read_directory_entries_with_stat_errors(
            dir,
            cancellation,
            None,
            &mut |_| true,
            Some(visit),
            &mut |_, _, error| {
                if error.is_missing_entry() {
                    Ok(())
                } else {
                    Err(error)
                }
            },
        )?;
        Ok(())
    }
    #[cfg(windows)]
    {
        win::visit_directory(dir, cancellation, &mut |entry| {
            visit(DirectoryEntry {
                name: entry.name,
                kind: entry.kind,
                identity: entry.identity,
                modified_seconds: win::filetime_to_unix_seconds(entry.last_write_time),
            })
        })
    }
}

/// Windows counterpart of the unix descriptor-relative read.
#[cfg(windows)]
pub(crate) fn read_directory_entries_at(
    dir: &File,
    cancellation: &CancellationToken,
    limit: Option<usize>,
    keep: &mut dyn FnMut(&OsStr) -> bool,
) -> Result<Vec<DirectoryEntry>, Error> {
    win::read_directory_entries(dir, cancellation, limit, keep)
}

#[cfg(windows)]
pub(crate) fn read_listing_directory_entries_at(
    dir: &File,
    cancellation: &CancellationToken,
    limit: Option<usize>,
    keep: &mut dyn FnMut(&OsStr) -> bool,
) -> Result<ListingDirectoryEntries, Error> {
    Ok(ListingDirectoryEntries {
        entries: win::read_directory_entries(dir, cancellation, limit, keep)?,
        unread: Vec::new(),
    })
}

#[cfg(any(target_os = "macos", all(test, unix)))]
pub(crate) fn held_matches_path(held: &impl std::os::fd::AsFd, path: &Path) -> Result<bool, Error> {
    use rustix::{fs, io::Errno};

    let held_stat = match fs::fstat(held) {
        Ok(stat) => stat,
        Err(Errno::NOENT | Errno::NOTDIR) => return Ok(false),
        Err(error) => return Err(Error::Io(Box::new(error.into()))),
    };
    let path_stat = match fs::lstat(path) {
        Ok(stat) => stat,
        Err(Errno::NOENT | Errno::NOTDIR) => return Ok(false),
        Err(error) => return Err(Error::Io(Box::new(error.into()))),
    };
    Ok(unix::raw_stat_identity(&held_stat) == unix::raw_stat_identity(&path_stat))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RegularFileAccess {
    ReadOnly,
    ReadWrite,
}

/// Access required for a retained parent directory. Read-only probes need no write permission;
/// namespace mutations and missing-leaf operations need `GENERIC_WRITE` on Windows so their
/// parent can be flushed after the mutation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ParentAccess {
    Readable,
    Writable,
}

pub(crate) fn read_bounded_bytes<R: Read>(
    reader: &mut R,
    declared: u64,
    max_bytes: usize,
    limit_message: &'static str,
    mut checkpoint: impl FnMut() -> Result<(), Error>,
) -> Result<Vec<u8>, Error> {
    checkpoint()?;
    let capacity = usize::try_from(declared)
        .unwrap_or(max_bytes)
        .min(max_bytes);
    let mut bytes = Vec::with_capacity(capacity);
    let mut chunk = [0_u8; 16 * 1024];
    loop {
        checkpoint()?;
        let remaining = max_bytes - bytes.len();
        let requested = chunk.len().min(remaining.saturating_add(1));
        let read = loop {
            match reader.read(&mut chunk[..requested]) {
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                    checkpoint()?;
                    continue;
                }
                result => break result?,
            }
        };
        if read == 0 {
            checkpoint()?;
            return Ok(bytes);
        }
        if read > remaining {
            return Err(Error::ResourceLimit(limit_message.into()));
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
}

mod verified_directory {
    use crate::error::Error;
    use std::fs::File;

    #[derive(Debug)]
    pub(crate) struct VerifiedDir(File);

    impl VerifiedDir {
        #[cfg(unix)]
        pub(crate) fn new(opened: File, expected: (u64, u64)) -> Result<Self, Error> {
            use std::os::unix::fs::MetadataExt;
            let verified = Self(opened);
            let metadata = verified.as_file().metadata()?;
            if (metadata.dev(), metadata.ino()) != expected {
                return Err(Error::Conflict(
                    "workspace directory changed concurrently".into(),
                ));
            }
            Ok(verified)
        }

        #[cfg(windows)]
        pub(crate) fn new(opened: File, expected: (u64, u64)) -> Result<Self, Error> {
            let verified = Self(opened);
            if crate::infra::path_authority::opened_file_identity(verified.as_file())? != expected {
                return Err(Error::Conflict(
                    "workspace directory changed concurrently".into(),
                ));
            }
            Ok(verified)
        }

        pub(crate) fn as_file(&self) -> &File {
            &self.0
        }

        pub(crate) fn into_file(self) -> File {
            self.0
        }
    }
}

pub(crate) use verified_directory::VerifiedDir;

#[derive(Debug)]
#[must_use = "the rename may have landed without a durable parent; decide what CommittedDurabilityUncertain means at this site"]
pub enum AtomicFileOutcome {
    DurableCommit,
    CommittedDurabilityUncertain(std::io::Error),
}

/// Both retained parents must be offered a sync after a namespace commit. Identity
/// comparison is supplied by the caller before the rename, while failure is still precommit.
fn sync_rename_parents(
    source_parent: &File,
    target_parent: &File,
    distinct_parents: bool,
) -> AtomicFileOutcome {
    let mut first = None;
    for parent in std::iter::once(source_parent).chain(distinct_parents.then_some(target_parent)) {
        if let AtomicFileOutcome::CommittedDurabilityUncertain(error) =
            parent_sync_as_atomic_outcome(parent)
        {
            if first.is_some() {
                log::warn!("additional workspace rename parent sync failed: {error}");
            } else {
                first = Some(error);
            }
        }
    }
    match first {
        Some(error) => AtomicFileOutcome::CommittedDurabilityUncertain(error),
        None => AtomicFileOutcome::DurableCommit,
    }
}

impl AtomicFileOutcome {
    /// Test assertion: a replacement inside a fresh temporary directory has no reason to lose
    /// its parent sync, so a test that only needs the file placed asserts that rather than
    /// discarding the outcome.
    #[cfg(test)]
    #[track_caller]
    pub(crate) fn expect_durable(self) {
        if let Self::CommittedDurabilityUncertain(error) = self {
            panic!("atomic replacement lost its parent sync: {error}");
        }
    }
}

pub(crate) fn map_atomic_file_outcome(
    outcome: AtomicFileOutcome,
    stage: crate::error::DurabilityStage,
    on_uncertain: impl FnOnce(&std::io::Error),
) -> Option<crate::error::DurabilityStage> {
    match outcome {
        AtomicFileOutcome::DurableCommit => None,
        AtomicFileOutcome::CommittedDurabilityUncertain(error) => {
            on_uncertain(&error);
            Some(stage)
        }
    }
}

/// Maps a committed outcome to a result, logging the cause and reporting uncertain durability
/// as `Error::CommittedDurabilityUncertain(stage)`. A terminal caller propagates the result.
/// An intermediate caller must retain uncertainty and complete dependent work before reporting it.
pub(crate) fn require_durable(
    outcome: AtomicFileOutcome,
    stage: crate::error::DurabilityStage,
) -> Result<(), Error> {
    match map_atomic_file_outcome(outcome, stage, |error| {
        log::warn!("{stage} parent sync failed: {error}");
    }) {
        None => Ok(()),
        Some(stage) => Err(Error::CommittedDurabilityUncertain(stage)),
    }
}

#[derive(Debug)]
pub struct AtomicInstalledFile {
    pub outcome: AtomicFileOutcome,
    pub identity: (u64, u64),
    pub ctime_nanos: i128,
    pub modified_seconds: i64,
}

#[cfg(test)]
// The fault points are one cross-platform vocabulary, but no single target constructs all of
// them: `DaclCapture` and `DaclApply` are injected only inside `mod win`, so a unix test build
// never constructs them, and the Windows adapter likewise skips the unix-only permission path.
// The allow covers that platform asymmetry; it is not a licence for a fault point nothing injects.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AtomicFileFaultPoint {
    ParentOpen,
    TempfileCreate,
    Write,
    Flush,
    FileSync,
    PermissionCopy,
    PreCommitRevalidate,
    Rename,
    PostRenameMetadata,
    TargetStat,
    TempMetadata,
    DaclCapture,
    DaclApply,
    ParentSync,
    Cleanup,
}

#[cfg(test)]
pub(crate) trait AtomicWriterInjector {
    fn inject(&self, _: AtomicFileFaultPoint) -> std::io::Result<()> {
        Ok(())
    }

    #[cfg(windows)]
    fn inspect_temp(&self, _: &OwnedFile) -> std::io::Result<()> {
        Ok(())
    }

    #[cfg(windows)]
    fn parent_revalidation_identity(&self, actual: (u64, u64)) -> (u64, u64) {
        actual
    }
}

/// Test injector that fails only the parent-directory sync, producing
/// `AtomicFileOutcome::CommittedDurabilityUncertain` with the given cause.
#[cfg(test)]
pub(crate) struct ParentSyncFault(pub(crate) &'static str);

#[cfg(test)]
impl AtomicWriterInjector for ParentSyncFault {
    fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
        if point == AtomicFileFaultPoint::ParentSync {
            Err(std::io::Error::other(self.0))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
std::thread_local! {
    static TEST_ATOMIC_FILE_INJECTOR: std::cell::RefCell<
        Option<Arc<dyn AtomicWriterInjector + Send + Sync>>,
    > = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_test_atomic_file_injector(
    injector: Option<Arc<dyn AtomicWriterInjector + Send + Sync>>,
) {
    TEST_ATOMIC_FILE_INJECTOR.with(|current| *current.borrow_mut() = injector);
}

#[cfg(test)]
pub(crate) struct AtomicInjectorReset;

#[cfg(test)]
impl Drop for AtomicInjectorReset {
    fn drop(&mut self) {
        set_test_atomic_file_injector(None);
    }
}

#[cfg(test)]
pub(crate) fn install_test_atomic_file_injector(
    injector: Arc<dyn AtomicWriterInjector + Send + Sync>,
) -> AtomicInjectorReset {
    set_test_atomic_file_injector(Some(injector));
    AtomicInjectorReset
}

#[cfg(all(test, unix))]
pub(crate) struct CancelAtomicFileAt {
    pub(crate) cancel_at: AtomicFileFaultPoint,
    pub(crate) fail_at: Option<AtomicFileFaultPoint>,
    pub(crate) cancellation: CancellationToken,
}

#[cfg(all(test, unix))]
impl AtomicWriterInjector for CancelAtomicFileAt {
    fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
        if point == self.cancel_at {
            self.cancellation.cancel();
        }
        if Some(point) == self.fail_at {
            Err(std::io::Error::other(format!("injected {point:?} failure")))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
pub(crate) fn current_test_atomic_file_injector(
) -> Option<Arc<dyn AtomicWriterInjector + Send + Sync>> {
    TEST_ATOMIC_FILE_INJECTOR.with(|current| current.borrow().clone())
}

#[cfg(any(test, unix, windows))]
fn io(err: std::io::Error) -> Error {
    Error::Io(Box::new(err))
}

#[cfg(any(unix, windows))]
fn operation_and_cleanup_error(temp_name: &OsStr, primary: Error, cleanup: Error) -> Error {
    log::error!(
        "atomic replacement failed: {}; temporary {temp_name:?} cleanup failed: {}",
        primary.diagnostic(),
        cleanup.diagnostic()
    );
    Error::with_cleanup(primary, Err(cleanup))
}

#[cfg(test)]
pub(crate) fn inject_atomic_file(point: AtomicFileFaultPoint) -> Result<(), Error> {
    current_test_atomic_file_injector()
        .map_or(Ok(()), |injector| injector.inject(point).map_err(io))
}

#[cfg(test)]
std::thread_local! {
    static DURABILITY_LOG: std::cell::RefCell<Vec<&'static str>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(test)]
fn record_durability(label: &'static str) {
    DURABILITY_LOG.with(|log| log.borrow_mut().push(label));
}

#[cfg(not(test))]
fn record_durability(_: &'static str) {}

#[cfg(all(test, windows))]
fn inspect_test_atomic_temp(temp: &OwnedFile) -> Result<(), Error> {
    current_test_atomic_file_injector()
        .map_or(Ok(()), |injector| injector.inspect_temp(temp).map_err(io))
}

#[cfg(test)]
#[allow(dead_code)]
fn durability_log() -> Vec<&'static str> {
    DURABILITY_LOG.with(|log| log.borrow().clone())
}

#[cfg(test)]
#[allow(dead_code)]
fn clear_durability_log() {
    DURABILITY_LOG.with(|log| log.borrow_mut().clear());
}

#[derive(Debug, Clone, Copy)]
struct TempMetadata {
    identity: (u64, u64),
    ctime_nanos: i128,
    modified_seconds: i64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AtomicFileMode {
    Replace,
    Create,
    CreateWorkspaceSidecar,
}

#[cfg_attr(not(windows), allow(dead_code))]
enum RenameOutcome {
    Committed,
    RetryWithoutDestinationPin,
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn dos_error_means_ex_unsupported(error: u32) -> bool {
    matches!(error, 87 | 50 | 1) // ERROR_INVALID_PARAMETER, ERROR_NOT_SUPPORTED, ERROR_INVALID_FUNCTION
}

#[test]
fn windows_ex_fallback_dos_predicate() {
    for error in [87, 50, 1] {
        assert!(dos_error_means_ex_unsupported(error), "{error}");
    }
    for error in [0, 5, 32, 183, 1224] {
        assert!(!dos_error_means_ex_unsupported(error), "{error}");
    }
}

trait AtomicReplaceAdapter {
    type Target;

    fn target_stat(
        &self,
        dir: &File,
        target: &OsStr,
        mode: AtomicFileMode,
    ) -> Result<Option<Self::Target>, Error>;
    fn is_regular(&self, target: &Self::Target) -> bool;
    fn target_identity(&self, target: &Self::Target) -> (u64, u64);
    fn create_temp(
        &self,
        dir: &File,
        original: Option<&Self::Target>,
    ) -> Result<(OsString, OwnedFile), Error>;
    fn before_write(
        &self,
        dir: &File,
        temp: &OwnedFile,
        original: Option<&Self::Target>,
    ) -> Result<(), Error>;
    fn finalize_metadata(
        &self,
        temp: &mut OwnedFile,
        original: Option<&Self::Target>,
    ) -> Result<(), Error>;
    fn rename(
        &self,
        dir: &File,
        temp: &mut OwnedFile,
        temp_name: &OsStr,
        target: &OsStr,
        replace: bool,
        mode: AtomicFileMode,
    ) -> Result<RenameOutcome, Error>;
    fn rename_classic(
        &self,
        dir: &File,
        temp: &mut OwnedFile,
        temp_name: &OsStr,
        target: &OsStr,
        mode: AtomicFileMode,
    ) -> Result<(), Error>;
    fn metadata(&self, temp: &OwnedFile) -> Result<TempMetadata, std::io::Error>;
    fn cleanup(&self, dir: &File, temp_name: &OsStr, temp: &mut OwnedFile, primary: Error)
        -> Error;
}

/// Leaf-name prefix for the one sibling backup a Windows existing-target install takes before it
/// renames the staged tree onto the destination name. The constant is cfg-free so the creation
/// site and the failed-rollback log text share one spelling; only Windows ever creates one.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const INSTALL_BACKUP_PREFIX: &str = ".install-backup-";

fn cleanup_with_adapter<A: AtomicReplaceAdapter>(
    adapter: &A,
    dir: &File,
    temp_name: &OsStr,
    temp: &mut OwnedFile,
    primary: Error,
) -> Error {
    adapter.cleanup(dir, temp_name, temp, primary)
}

/// Platform seam for `install_dir_driver`, matching `AtomicReplaceAdapter`. Every method is
/// descriptor-relative: the driver never reopens a mutable parent pathname after the first
/// identity check. `Entry` is the platform's directory-entry observation (unix `Stat`, the
/// Windows retained-handle target).
trait DirInstallAdapter {
    type Entry;

    /// Open the parent directory of `path` with the access the commit needs.
    #[cfg(test)]
    fn open_parent(&self, path: &Path) -> Result<File, Error>;
    /// The `(volume, index)` / `(dev, ino)` identity of an open parent handle.
    #[cfg(test)]
    fn parent_identity(&self, dir: &File) -> Result<(u64, u64), Error>;
    /// Observe one child leaf without following it. `None` means absent.
    fn target_stat(&self, dir: &File, name: &OsStr) -> Result<Option<Self::Entry>, Error>;
    fn is_directory(&self, entry: &Self::Entry) -> bool;
    fn entry_identity(&self, entry: &Self::Entry) -> (u64, u64);
    /// No-follow open of a leaf as a real directory; refuses reparse points/special files.
    fn open_source_directory(&self, parent: &File, name: &OsStr) -> Result<File, Error>;
    /// Durably flush the staged tree rooted at `dir`, bounded and reparse-refusing.
    fn flush_tree(&self, dir: &File) -> Result<(), Error>;
    /// Commit the swap. `original` is the verified existing target entry, if any. Returns the
    /// sibling leaf that now holds the displaced tree, if the platform displaced one there.
    fn commit(
        &self,
        parent: &File,
        source_name: &OsStr,
        target_name: &OsStr,
        source: &mut Self::Entry,
        original: Option<&Self::Entry>,
    ) -> Result<Option<OsString>, Error>;
    /// Identity-bound removal of the displaced tree at `name`.
    fn cleanup_displaced(
        &self,
        parent: &File,
        name: &OsStr,
        expected: &Self::Entry,
    ) -> Result<(), Error>;
}

/// The one directory-install body for every OS (d-20260918-10). It owns the parent/source
/// identity check, the no-follow source/target kind checks, the durable flush, the immediate
/// pre-commit revalidation, the platform commit, the durable parent syncs, and the old-tree
/// cleanup. Windows has no directory `EXCHANGE`, so its adapter's commit takes a sibling backup
/// and rolls it back if the install rename fails; that difference lives entirely in the adapter.
#[cfg(test)]
fn install_dir_driver<A: DirInstallAdapter>(
    adapter: &A,
    source: &Path,
    target: &Path,
) -> Result<(), Error> {
    #[cfg(test)]
    inject_atomic_dir(AtomicDirFaultPoint::SyncEntry)?;
    let parent = adapter.open_parent(target)?;
    let source_parent = adapter.open_parent(source)?;
    let parent_identity = adapter.parent_identity(&parent)?;
    if adapter.parent_identity(&source_parent)? != parent_identity {
        return Err(Error::InvalidInput(
            "directory staging source must be in the target's real parent directory".into(),
        ));
    }
    let source_name = install_leaf(source)?;
    let target_name = install_leaf(target)?;
    // The pathname entry keeps its reopen of the target parent immediately before commit.
    let revalidate_parent = || {
        if adapter.parent_identity(&adapter.open_parent(target)?)? != parent_identity {
            return Err(Error::Conflict(
                "directory parent changed concurrently".into(),
            ));
        }
        Ok(())
    };
    install_dir_at_driver(
        adapter,
        DirectoryInstall {
            parent: &parent,
            source_name,
            expected_source: None,
            target_name,
            policy: DirectoryInstallPolicy::Replace,
        },
        &revalidate_parent,
        &mut false,
    )
}

#[derive(Clone, Copy)]
pub(crate) enum DirectoryInstallPolicy {
    #[cfg(test)]
    Replace,
    Absent,
}

struct DirectoryInstall<'a> {
    parent: &'a File,
    source_name: &'a OsStr,
    expected_source: Option<(u64, u64)>,
    target_name: &'a OsStr,
    policy: DirectoryInstallPolicy,
}

/// The held-parent body of [`install_dir_driver`]: both leaves are names under the one open
/// `parent`, so same-parent is structural. `expected_source` pins the staged leaf to an identity
/// captured earlier. `revalidate_parent` runs immediately before the commit revalidation.
/// `committed` records actual physical mutation independently of trusted acceptance. It can
/// remain true for a hard postcommit `Conflict`, and drives disarming of source-owner cleanup.
fn install_dir_at_driver<A: DirInstallAdapter>(
    adapter: &A,
    install: DirectoryInstall<'_>,
    revalidate_parent: &dyn Fn() -> Result<(), Error>,
    committed: &mut bool,
) -> Result<(), Error> {
    let DirectoryInstall {
        parent,
        source_name,
        expected_source,
        target_name,
        policy,
    } = install;
    let mut source_entry = adapter
        .target_stat(parent, source_name)?
        .ok_or_else(|| Error::InvalidInput("directory staging source does not exist".into()))?;
    if expected_source.is_some_and(|expected| adapter.entry_identity(&source_entry) != expected) {
        return Err(Error::Conflict(
            "directory staging source changed concurrently".into(),
        ));
    }
    if !adapter.is_directory(&source_entry) {
        return Err(Error::InvalidInput(
            "directory staging source must be a real directory".into(),
        ));
    }
    let source_dir = adapter.open_source_directory(parent, source_name)?;
    adapter.flush_tree(&source_dir)?;
    let original = match adapter.target_stat(parent, target_name)? {
        Some(_) if matches!(policy, DirectoryInstallPolicy::Absent) => {
            return Err(Error::Conflict(
                "directory target was created concurrently".into(),
            ));
        }
        Some(entry) if adapter.is_directory(&entry) => Some(entry),
        Some(_) => {
            return Err(Error::InvalidInput(
                "directory target must be a real directory".into(),
            ))
        }
        None => None,
    };
    #[cfg(test)]
    inject_atomic_dir(AtomicDirFaultPoint::PreCommit)?;
    revalidate_parent()?;
    match adapter.target_stat(parent, source_name)? {
        Some(entry) if adapter.entry_identity(&entry) == adapter.entry_identity(&source_entry) => {}
        _ => {
            return Err(Error::Conflict(
                "directory staging source changed concurrently".into(),
            ))
        }
    }
    match (original.as_ref(), adapter.target_stat(parent, target_name)?) {
        (None, None) => {}
        (None, Some(_)) => {
            return Err(Error::Conflict(
                "directory target was created concurrently".into(),
            ))
        }
        (Some(_), None) => {
            return Err(Error::Conflict(
                "directory target was deleted concurrently".into(),
            ))
        }
        (Some(expected), Some(actual))
            if adapter.is_directory(&actual)
                && adapter.entry_identity(expected) == adapter.entry_identity(&actual) => {}
        _ => {
            return Err(Error::Conflict(
                "directory target changed concurrently".into(),
            ))
        }
    }
    let displaced = adapter
        .commit(
            parent,
            source_name,
            target_name,
            &mut source_entry,
            original.as_ref(),
        )
        .map_err(|error| match error {
            Error::Io(ref cause)
                if matches!(policy, DirectoryInstallPolicy::Absent)
                    && cause.kind() == std::io::ErrorKind::AlreadyExists =>
            {
                Error::Conflict("directory target was created concurrently".into())
            }
            other => other,
        })?;
    *committed = true;
    if !matches!(entry_identity_at(parent, target_name, true),
        Ok(actual) if actual == adapter.entry_identity(&source_entry))
    {
        return Err(Error::Conflict(
            "directory publication could not be confirmed".into(),
        ));
    }
    #[cfg(test)]
    if let Err(error) = inject_atomic_dir(AtomicDirFaultPoint::ParentSync) {
        log::warn!("directory installation parent sync failed: {error}");
        return Err(Error::CommittedDurabilityUncertain(
            crate::error::DurabilityStage::DirectoryInstall,
        ));
    }
    if let Err(error) = parent.sync_all() {
        log::warn!("directory installation parent sync failed: {error}");
        return Err(Error::CommittedDurabilityUncertain(
            crate::error::DurabilityStage::DirectoryInstall,
        ));
    }
    if let (Some(original), Some(displaced)) = (original.as_ref(), displaced.as_deref()) {
        #[cfg(test)]
        if let Err(error) = inject_atomic_dir(AtomicDirFaultPoint::BackupCleanup) {
            log::error!(
                "directory installed but old tree cleanup at {} failed: {error}",
                displaced.to_string_lossy()
            );
            return Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::OldDirectoryCleanup,
            ));
        }
        if let Err(error) = adapter.cleanup_displaced(parent, displaced, original) {
            log::error!(
                "directory installed but old tree cleanup at {} failed: {error}",
                displaced.to_string_lossy()
            );
            return Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::OldDirectoryCleanup,
            ));
        }
        if let Err(error) = parent.sync_all() {
            log::warn!("old directory cleanup parent sync failed: {error}");
            return Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::OldDirectoryCleanupSync,
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
fn install_leaf(path: &Path) -> Result<&OsStr, Error> {
    path.file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| Error::InvalidInput("directory install needs a leaf name".into()))
}

fn atomic_create_collision_error(is_regular: bool) -> Error {
    if is_regular {
        Error::Conflict(WORKSPACE_FILE_NAME_TAKEN.into())
    } else {
        Error::InvalidInput("target must be a regular file, not a link or special file".into())
    }
}

/// Only the forward workspace mutation boundary opts into name-taken guidance.
fn workspace_collision(error: Error) -> Error {
    match error {
        Error::Io(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Error::Conflict(WORKSPACE_FILE_NAME_TAKEN.into())
        }
        other => other,
    }
}

pub(crate) fn create_workspace_directory_at(
    parent: &File,
    name: &OsStr,
) -> Result<AtomicFileOutcome, Error> {
    create_dir_at_committed(parent, name).map_err(workspace_collision)
}

fn initial_atomic_target<A: AtomicReplaceAdapter>(
    adapter: &A,
    dir: &File,
    target: &OsStr,
    mode: AtomicFileMode,
) -> Result<Option<A::Target>, Error> {
    // Forward pairs refuse every occupied sidecar name through the no-replace publication.
    // Never open an unrelated destination object, including a directory or reparse point.
    if mode == AtomicFileMode::CreateWorkspaceSidecar {
        return Ok(None);
    }
    let result = adapter.target_stat(dir, target, mode);
    record_durability("target_stat:initial");
    match result? {
        Some(target) if !adapter.is_regular(&target) => Err(Error::InvalidInput(
            "target must be a regular file, not a link or special file".into(),
        )),
        Some(_) if mode == AtomicFileMode::Create => {
            Err(Error::Conflict(WORKSPACE_FILE_NAME_TAKEN.into()))
        }
        target => Ok(target),
    }
}

/// Early refusal only. The create driver's no-replace rename is the publication boundary.
pub(crate) fn ensure_atomic_create_available_at(parent: &File, leaf: &OsStr) -> Result<(), Error> {
    single_leaf(leaf)?;
    #[cfg(unix)]
    let adapter = unix::UnixAdapter;
    #[cfg(windows)]
    let adapter = win::WindowsAdapter;
    initial_atomic_target(&adapter, parent, leaf, AtomicFileMode::Create).map(|_| ())
}

fn replace_at_driver<A, F, P>(
    adapter: A,
    dir: File,
    target_name: OsString,
    mode: AtomicFileMode,
    precommit: P,
    write_fn: F,
) -> Result<AtomicInstalledFile, Error>
where
    A: AtomicReplaceAdapter,
    F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
    P: FnOnce() -> Result<(), Error>,
{
    let target_name_ref = target_name.as_os_str();
    let original = initial_atomic_target(&adapter, &dir, target_name_ref, mode)?;

    #[cfg(test)]
    inject_atomic_file(AtomicFileFaultPoint::TempfileCreate)?;
    let (temp_name, mut temp) = adapter.create_temp(&dir, original.as_ref())?;

    if let Err(error) = adapter.before_write(&dir, &temp, original.as_ref()) {
        return Err(cleanup_with_adapter(
            &adapter, &dir, &temp_name, &mut temp, error,
        ));
    }
    #[cfg(test)]
    if let Err(error) = inject_atomic_file(AtomicFileFaultPoint::Write) {
        return Err(cleanup_with_adapter(
            &adapter, &dir, &temp_name, &mut temp, error,
        ));
    }
    #[cfg(all(test, windows))]
    if let Err(error) = inspect_test_atomic_temp(&temp) {
        return Err(cleanup_with_adapter(
            &adapter, &dir, &temp_name, &mut temp, error,
        ));
    }
    if let Err(error) = write_fn(&mut temp) {
        return Err(cleanup_with_adapter(
            &adapter, &dir, &temp_name, &mut temp, error,
        ));
    }
    #[cfg(test)]
    if let Err(error) = inject_atomic_file(AtomicFileFaultPoint::Flush) {
        return Err(cleanup_with_adapter(
            &adapter, &dir, &temp_name, &mut temp, error,
        ));
    }
    let result = temp.flush().map_err(io);
    record_durability("temp.flush");
    if let Err(error) = result {
        return Err(cleanup_with_adapter(
            &adapter, &dir, &temp_name, &mut temp, error,
        ));
    }
    #[cfg(test)]
    if let Err(error) = inject_atomic_file(AtomicFileFaultPoint::FileSync) {
        return Err(cleanup_with_adapter(
            &adapter, &dir, &temp_name, &mut temp, error,
        ));
    }
    let result = temp.sync_all().map_err(io);
    record_durability("temp.sync_all:content");
    if let Err(error) = result {
        return Err(cleanup_with_adapter(
            &adapter, &dir, &temp_name, &mut temp, error,
        ));
    }
    #[cfg(test)]
    if let Err(error) = inject_atomic_file(AtomicFileFaultPoint::PermissionCopy) {
        return Err(cleanup_with_adapter(
            &adapter, &dir, &temp_name, &mut temp, error,
        ));
    }
    if let Err(error) = adapter.finalize_metadata(&mut temp, original.as_ref()) {
        return Err(cleanup_with_adapter(
            &adapter, &dir, &temp_name, &mut temp, error,
        ));
    }

    #[cfg(test)]
    if let Err(error) = inject_atomic_file(AtomicFileFaultPoint::PreCommitRevalidate) {
        return Err(cleanup_with_adapter(
            &adapter, &dir, &temp_name, &mut temp, error,
        ));
    }
    #[cfg(test)]
    if let Err(error) = inject_atomic_file(AtomicFileFaultPoint::TargetStat) {
        return Err(cleanup_with_adapter(
            &adapter, &dir, &temp_name, &mut temp, error,
        ));
    }
    let current = if mode == AtomicFileMode::CreateWorkspaceSidecar {
        Ok(None)
    } else {
        adapter.target_stat(&dir, target_name_ref, mode)
    };
    record_durability("target_stat:revalidation");
    let current = match current {
        Ok(current) => current,
        Err(error) => {
            return Err(cleanup_with_adapter(
                &adapter, &dir, &temp_name, &mut temp, error,
            ))
        }
    };
    match (original.as_ref(), current) {
        (None, None) => {}
        (None, Some(actual)) => {
            return Err(cleanup_with_adapter(
                &adapter,
                &dir,
                &temp_name,
                &mut temp,
                if mode == AtomicFileMode::Create {
                    atomic_create_collision_error(adapter.is_regular(&actual))
                } else {
                    Error::Conflict("target was created concurrently".into())
                },
            ))
        }
        (Some(_), None) => {
            return Err(cleanup_with_adapter(
                &adapter,
                &dir,
                &temp_name,
                &mut temp,
                Error::Conflict("target was deleted concurrently".into()),
            ))
        }
        (Some(expected), Some(actual))
            if adapter.is_regular(&actual)
                && target_identity(&adapter, expected) == target_identity(&adapter, &actual) => {}
        (Some(_), Some(_)) => {
            return Err(cleanup_with_adapter(
                &adapter,
                &dir,
                &temp_name,
                &mut temp,
                Error::Conflict("target changed concurrently".into()),
            ))
        }
    }
    if let Err(error) = precommit() {
        return Err(cleanup_with_adapter(
            &adapter, &dir, &temp_name, &mut temp, error,
        ));
    }

    #[cfg(test)]
    if let Err(error) = inject_atomic_file(AtomicFileFaultPoint::TempMetadata) {
        return Err(cleanup_with_adapter(
            &adapter, &dir, &temp_name, &mut temp, error,
        ));
    }
    let fallback_metadata = match adapter.metadata(&temp) {
        Ok(metadata) => metadata,
        Err(error) => {
            return Err(cleanup_with_adapter(
                &adapter,
                &dir,
                &temp_name,
                &mut temp,
                io(error),
            ))
        }
    };
    #[cfg(test)]
    if let Err(error) = inject_atomic_file(AtomicFileFaultPoint::Rename) {
        return Err(cleanup_with_adapter(
            &adapter, &dir, &temp_name, &mut temp, error,
        ));
    }
    let replacing = mode == AtomicFileMode::Replace && original.is_some();
    let rename = adapter.rename(
        &dir,
        &mut temp,
        &temp_name,
        target_name_ref,
        replacing,
        mode,
    );
    let rename = match rename {
        Ok(RenameOutcome::Committed) => Ok(()),
        Ok(RenameOutcome::RetryWithoutDestinationPin) => {
            if replacing {
                drop(original);
                adapter.rename_classic(&dir, &mut temp, &temp_name, target_name_ref, mode)
            } else {
                Err(Error::Conflict(
                    "rename retry requires a destination pin".into(),
                ))
            }
        }
        Err(error) => Err(error),
    };
    if let Err(error) = rename {
        return Err(cleanup_with_adapter(
            &adapter, &dir, &temp_name, &mut temp, error,
        ));
    }

    #[cfg(test)]
    let metadata = match inject_atomic_file(AtomicFileFaultPoint::PostRenameMetadata) {
        Ok(()) => adapter.metadata(&temp),
        Err(Error::Io(error)) => Err(*error),
        Err(_) => unreachable!("atomic file injectors only produce I/O errors"),
    };
    #[cfg(not(test))]
    let metadata = adapter.metadata(&temp);
    let metadata = match metadata {
        Ok(metadata) => metadata,
        Err(error) => {
            drop(temp);
            return Ok(AtomicInstalledFile {
                outcome: AtomicFileOutcome::CommittedDurabilityUncertain(error),
                identity: fallback_metadata.identity,
                ctime_nanos: fallback_metadata.ctime_nanos,
                modified_seconds: fallback_metadata.modified_seconds,
            });
        }
    };
    drop(temp);
    #[cfg(test)]
    if let Err(error) = inject_atomic_file(AtomicFileFaultPoint::ParentSync) {
        let Error::Io(error) = error else {
            unreachable!("atomic file injectors only produce I/O errors")
        };
        return Ok(AtomicInstalledFile {
            outcome: AtomicFileOutcome::CommittedDurabilityUncertain(*error),
            identity: metadata.identity,
            ctime_nanos: metadata.ctime_nanos,
            modified_seconds: metadata.modified_seconds,
        });
    }
    let parent_sync = dir.sync_all();
    record_durability("dir.sync_all");
    let outcome = match parent_sync {
        Ok(()) => AtomicFileOutcome::DurableCommit,
        Err(error) => AtomicFileOutcome::CommittedDurabilityUncertain(error),
    };
    Ok(AtomicInstalledFile {
        outcome,
        identity: metadata.identity,
        ctime_nanos: metadata.ctime_nanos,
        modified_seconds: metadata.modified_seconds,
    })
}

fn target_identity<A: AtomicReplaceAdapter>(adapter: &A, target: &A::Target) -> (u64, u64) {
    adapter.target_identity(target)
}

fn ensure_remove_tree_depth(depth: usize, maximum: usize) -> Result<(), Error> {
    if depth >= maximum {
        return Err(Error::ResourceLimit(format!(
            "directory cleanup exceeded {maximum} levels"
        )));
    }
    Ok(())
}

#[cfg(unix)]
mod unix {
    use super::*;
    use rustix::{
        fs::{self, AtFlags, Dir, FileType, Mode, OFlags, RenameFlags},
        io::Errno,
    };
    #[cfg(target_os = "linux")]
    use std::io::Read;
    #[cfg(any(test, target_os = "linux"))]
    use std::os::unix::io::AsRawFd;
    use std::{
        ffi::OsStr,
        os::unix::{
            ffi::{OsStrExt, OsStringExt},
            fs::MetadataExt,
        },
        path::Component,
    };
    /// Directory levels `remove_tree_at` and `sync_tree` will descend before refusing.
    ///
    /// Each open level holds two descriptors (the level's `File` and the one `Dir` owns), so one
    /// walk keeps at most `2 * MAX_REMOVE_TREE_DEPTH + 1` descriptors. Directory buffers are
    /// heap-owned by `Dir`: rustix caps its Linux `getdents` buffer growth, and macOS libc grows
    /// its `DIR` buffer once to 8 KiB, except on union mounts, which the walker refuses.
    pub(crate) const MAX_REMOVE_TREE_DEPTH: usize = 64;
    /// Maximum accepted size of one `/proc/self/fdinfo` record.
    #[cfg(target_os = "linux")]
    const MAX_FDINFO_RECORD_BYTES: u64 = 4096;

    #[cfg(test)]
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum RemovalFaultPoint {
        BeforeTopOpen,
        BeforeChildStat,
        BeforeChildOpen,
        BeforeDirOpen,
        AfterDirectoryWalk,
        AfterEntryRemoved,
        ParentSync,
    }

    #[cfg(test)]
    pub(crate) trait RemovalInjector {
        fn inject(&self, _: RemovalFaultPoint) -> std::io::Result<Option<u64>> {
            Ok(None)
        }

        /// Supplies raw `statx` attribute-mask and attribute bits to the production decision.
        #[cfg(target_os = "linux")]
        fn statx_mount_attributes(
            &self,
            _: std::os::fd::RawFd,
        ) -> Option<std::io::Result<(u64, u64)>> {
            None
        }

        /// Supplies a raw fdinfo record to the production bounded parser.
        #[cfg(target_os = "linux")]
        fn fdinfo_record(&self, _: std::os::fd::RawFd) -> Option<std::io::Result<Vec<u8>>> {
            None
        }

        /// Supplies the raw mount-point buffer used by non-Linux mount evidence.
        #[cfg(not(target_os = "linux"))]
        fn mount_path_buffer(
            &self,
            _: std::os::fd::RawFd,
        ) -> Option<std::io::Result<Vec<libc::c_char>>> {
            None
        }

        /// Supplies the filesystem flags used by the non-Linux directory-walk bound.
        #[cfg(not(target_os = "linux"))]
        fn mount_flags(&self, _: std::os::fd::RawFd) -> Option<std::io::Result<u32>> {
            None
        }
    }

    #[cfg(test)]
    pub(crate) struct RemovalFault(pub(crate) RemovalFaultPoint);

    #[cfg(test)]
    impl RemovalInjector for RemovalFault {
        fn inject(&self, point: RemovalFaultPoint) -> std::io::Result<Option<u64>> {
            if point == self.0 {
                return Err(std::io::Error::other(
                    r"/private/removal C:\private\removal: injected removal failure",
                ));
            }
            Ok(None)
        }
    }

    #[cfg(test)]
    std::thread_local! {
        static TEST_REMOVAL_INJECTOR: std::cell::RefCell<
            Option<Arc<dyn RemovalInjector + Send + Sync>>,
        > = const { std::cell::RefCell::new(None) };
    }

    #[cfg(test)]
    pub(crate) fn set_test_removal_injector(
        injector: Option<Arc<dyn RemovalInjector + Send + Sync>>,
    ) {
        TEST_REMOVAL_INJECTOR.with(|current| *current.borrow_mut() = injector);
    }

    #[cfg(test)]
    pub(crate) fn current_test_removal_injector() -> Option<Arc<dyn RemovalInjector + Send + Sync>>
    {
        TEST_REMOVAL_INJECTOR.with(|current| current.borrow().clone())
    }

    #[cfg(test)]
    pub(crate) struct TestRemovalInjectorGuard(Option<Arc<dyn RemovalInjector + Send + Sync>>);

    #[cfg(test)]
    impl Drop for TestRemovalInjectorGuard {
        fn drop(&mut self) {
            let previous = self.0.take();
            set_test_removal_injector(previous);
        }
    }

    #[cfg(test)]
    pub(crate) fn scoped_test_removal_injector(
        injector: Arc<dyn RemovalInjector + Send + Sync>,
    ) -> TestRemovalInjectorGuard {
        let previous = current_test_removal_injector();
        set_test_removal_injector(Some(injector));
        TestRemovalInjectorGuard(previous)
    }

    #[cfg(test)]
    pub(super) fn inject_removal(point: RemovalFaultPoint) -> Result<Option<u64>, Error> {
        current_test_removal_injector()
            .map_or(Ok(None), |injector| injector.inject(point).map_err(io))
    }

    trait RawDevice {
        fn canonical(self) -> u64;
    }

    impl RawDevice for i32 {
        fn canonical(self) -> u64 {
            self as u64
        }
    }

    impl RawDevice for u64 {
        fn canonical(self) -> u64 {
            self
        }
    }

    fn identity_from_parts<D: RawDevice>(dev: D, ino: u64) -> (u64, u64) {
        (dev.canonical(), ino)
    }

    pub(crate) fn raw_stat_identity(stat: &rustix::fs::Stat) -> (u64, u64) {
        identity_from_parts(stat.st_dev, stat.st_ino)
    }

    pub(crate) fn raw_libc_stat_identity(stat: &libc::stat) -> (u64, u64) {
        identity_from_parts(stat.st_dev, stat.st_ino)
    }

    fn directory_removed_error() -> Error {
        Error::Io(Box::new(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "directory was removed during enumeration",
        )))
    }

    pub(super) fn ensure_directory_not_removed(dir: &File) -> Result<(), Error> {
        #[cfg(not(target_os = "macos"))]
        {
            let directory_stat = fs::fstat(dir).map_err(|error| io(error.into()))?;
            if directory_stat.st_nlink == 0 {
                return Err(directory_removed_error());
            }
        }
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::ffi::OsStrExt;

            let path = fs::getpath(dir).map_err(|error| {
                if matches!(error, Errno::NOENT | Errno::NOTDIR) {
                    directory_removed_error()
                } else {
                    io(error.into())
                }
            })?;
            if !super::held_matches_path(dir, Path::new(OsStr::from_bytes(path.as_bytes())))? {
                return Err(directory_removed_error());
            }
        }
        Ok(())
    }

    pub(crate) fn raw_mode_from(mode: u32) -> Result<rustix::fs::RawMode, Error> {
        rustix::fs::RawMode::try_from(mode)
            .map_err(|_| Error::InvalidInput("file mode does not fit this platform".into()))
    }

    #[cfg(any(test, not(target_os = "linux")))]
    pub(super) fn mount_path_from_buffer(buffer: &[libc::c_char]) -> Result<Vec<u8>, Error> {
        let end = buffer.iter().position(|byte| *byte == 0).ok_or_else(|| {
            Error::InvalidInput("directory cleanup cannot establish mount path".into())
        })?;
        if end == 0 {
            return Err(Error::InvalidInput(
                "directory cleanup cannot establish mount path".into(),
            ));
        }
        Ok(buffer[..end].iter().map(|byte| *byte as u8).collect())
    }

    #[cfg(any(test, not(target_os = "linux")))]
    pub(super) fn mount_crossing_from(
        parent: Result<Vec<u8>, Error>,
        child: Result<Vec<u8>, Error>,
    ) -> Result<bool, Error> {
        let parent = parent?;
        let child = child?;
        Ok(parent != child)
    }

    #[cfg(any(test, not(target_os = "linux")))]
    pub(super) fn union_mount_refusal(f_flags: u32, union_flag: u32) -> Result<(), Error> {
        if f_flags & union_flag != 0 {
            return Err(Error::InvalidInput(
                "directory walks refuse union mounts".into(),
            ));
        }
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    fn mount_path_evidence(file: &File) -> Result<Vec<u8>, Error> {
        #[cfg(test)]
        if let Some(buffer) = current_test_removal_injector()
            .and_then(|injector| injector.mount_path_buffer(file.as_raw_fd()))
        {
            return mount_path_from_buffer(&buffer.map_err(io)?);
        }
        let stat = fs::fstatfs(file).map_err(|error| io(error.into()))?;
        mount_path_from_buffer(&stat.f_mntonname)
    }

    #[cfg(not(target_os = "linux"))]
    fn mount_flags(file: &File) -> Result<u32, Error> {
        #[cfg(test)]
        if let Some(flags) = current_test_removal_injector()
            .and_then(|injector| injector.mount_flags(file.as_raw_fd()))
        {
            return flags.map_err(io);
        }
        let stat = fs::fstatfs(file).map_err(|error| io(error.into()))?;
        Ok(stat.f_flags)
    }

    #[cfg(not(target_os = "linux"))]
    fn refuse_union_mount(file: &File) -> Result<(), Error> {
        union_mount_refusal(mount_flags(file)?, libc::MNT_UNION as u32)
    }

    pub(super) fn walk_directory(
        dir: &File,
        mut visit: impl FnMut(&[u8], u64, fs::FileType) -> Result<(), Error>,
    ) -> Result<(), Error> {
        #[cfg(not(target_os = "linux"))]
        refuse_union_mount(dir)?;
        #[cfg(test)]
        inject_removal(RemovalFaultPoint::BeforeDirOpen)?;
        let opened = fs::openat(
            dir,
            ".",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| io(error.into()))?;
        let mut entries = Dir::new(opened).map_err(|error| io(error.into()))?;
        while let Some(entry) = entries.read() {
            let entry = entry.map_err(|error| io(error.into()))?;
            let bytes = entry.file_name().to_bytes();
            if bytes != b"." && bytes != b".." {
                visit(bytes, entry.ino(), entry.file_type())?;
            }
        }
        #[cfg(test)]
        inject_removal(RemovalFaultPoint::AfterDirectoryWalk)?;
        Ok(())
    }

    #[cfg(test)]
    mod identity_tests {
        use super::{
            identity_from_parts, raw_libc_stat_identity, raw_mode_from, raw_stat_identity,
        };
        use crate::infra::blocking::source_scan::{braced_body, normalise, Literals};

        #[cfg(target_os = "macos")]
        use crate::error::Error;
        use rustix::fs::fstat;

        #[test]
        fn identity_from_parts_canonicalises_signed_and_unsigned_devices() {
            assert_eq!(identity_from_parts(-1_i32, 7), (u64::MAX, 7));
            assert_eq!(identity_from_parts(i32::MIN, 7), (i32::MIN as u64, 7));
            assert_eq!(identity_from_parts(u64::MAX, 7), (u64::MAX, 7));
        }

        #[test]
        fn raw_stat_identity_matches_file_metadata() {
            use std::os::unix::fs::MetadataExt;
            let temp = tempfile::tempdir().expect("tempdir");
            let path = temp.path().join("file");
            std::fs::write(&path, b"file").expect("file");
            let file = std::fs::File::open(&path).expect("open file");
            let stat = fstat(&file).expect("fstat");
            let metadata = file.metadata().expect("metadata");
            assert_eq!(raw_stat_identity(&stat), (metadata.dev(), metadata.ino()));
        }

        #[test]
        fn raw_libc_stat_identity_matches_file_metadata() {
            use std::os::fd::AsRawFd;
            use std::os::unix::fs::MetadataExt;

            let temp = tempfile::tempdir().expect("tempdir");
            let path = temp.path().join("libc-stat-file");
            std::fs::write(&path, b"file").expect("file");
            let file = std::fs::File::open(&path).expect("open file");
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            assert_eq!(
                unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) },
                0
            );
            let stat = unsafe { stat.assume_init() };
            let metadata = file.metadata().expect("metadata");
            assert_eq!(
                raw_libc_stat_identity(&stat),
                (metadata.dev(), metadata.ino())
            );
        }

        #[test]
        fn raw_stat_identity_body_is_the_plain_call() {
            let source = include_str!("fs.rs");
            let body = braced_body(source, "pub(crate) fn raw_stat_identity(");
            let compact: String = normalise(&source[body], Literals::Blank)
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect();
            let expected = ["{identity_from_parts(stat.st", "_dev,stat.st_ino)}"].concat();
            assert_eq!(compact, expected);
        }

        #[test]
        fn raw_libc_stat_identity_body_is_the_plain_call() {
            let source = include_str!("fs.rs");
            let body = braced_body(source, "pub(crate) fn raw_libc_stat_identity(");
            let compact: String = normalise(&source[body], Literals::Blank)
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect();
            let expected = ["{identity_from_parts(stat.st", "_dev,stat.st_ino)}"].concat();
            assert_eq!(compact, expected);
        }

        #[test]
        fn raw_mode_from_accepts_platform_mode() {
            assert_eq!(raw_mode_from(0o100_644).expect("mode"), 0o100_644);
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn macos_port_raw_mode_rejects_wide_mode() {
            for mode in [0x1_0000, u32::MAX] {
                assert!(matches!(raw_mode_from(mode), Err(Error::InvalidInput(_))));
            }
        }

        #[test]
        fn raw_device_is_read_once() {
            fn rust_sources(path: &std::path::Path, files: &mut Vec<std::path::PathBuf>) {
                for entry in std::fs::read_dir(path).expect("source directory") {
                    let entry = entry.expect("source entry");
                    let path = entry.path();
                    if path.is_dir() {
                        rust_sources(&path, files);
                    } else if path.extension().and_then(std::ffi::OsStr::to_str) == Some("rs") {
                        files.push(path);
                    }
                }
            }

            let source_root = std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/src"));
            let mut files = Vec::new();
            rust_sources(&source_root, &mut files);
            let needle = ["st", "_dev"].concat();
            let mut occurrences = Vec::new();
            for file in files {
                let source = std::fs::read_to_string(&file).expect("Rust source");
                let normalised = normalise(&source, Literals::Blank);
                for (offset, _) in normalised.match_indices(&needle) {
                    let line = source[..offset]
                        .bytes()
                        .filter(|byte| *byte == b'\n')
                        .count()
                        + 1;
                    occurrences.push(format!("{}:{line}", file.display()));
                }
            }
            assert_eq!(
                occurrences.len(),
                2,
                "raw device occurrences: {occurrences:?}"
            );
            let fs_source = include_str!("fs.rs");
            let normalised = normalise(fs_source, Literals::Blank);
            let offsets: Vec<_> = normalised
                .match_indices(&needle)
                .map(|(offset, _)| offset)
                .collect();
            for helper in ["raw_stat_identity", "raw_libc_stat_identity"] {
                let body = braced_body(fs_source, &format!("pub(crate) fn {helper}("));
                let in_body: Vec<_> = offsets
                    .iter()
                    .copied()
                    .filter(|offset| body.contains(offset))
                    .collect();
                assert_eq!(
                    in_body.len(),
                    1,
                    "raw device access must occur exactly once inside {helper}"
                );
            }
            assert_eq!(
                offsets.len(),
                offsets
                    .iter()
                    .filter(|offset| {
                        ["raw_stat_identity", "raw_libc_stat_identity"]
                            .iter()
                            .any(|helper| {
                                braced_body(fs_source, &format!("pub(crate) fn {helper}("))
                                    .contains(offset)
                            })
                    })
                    .count(),
                "raw device access is outside the identity helpers"
            );
        }
    }

    #[cfg(target_os = "linux")]
    pub(super) fn parse_fdinfo_mount_id(record: &[u8]) -> Result<u64, Error> {
        if record.len() > MAX_FDINFO_RECORD_BYTES as usize {
            return Err(Error::InvalidInput(
                "directory cleanup cannot establish mount identity: fdinfo record is oversized"
                    .into(),
            ));
        }
        let mut mount_id = None;
        for line in record.split(|byte| *byte == b'\n') {
            let Some(value) = line.strip_prefix(b"mnt_id:") else {
                continue;
            };
            if mount_id.is_some() {
                return Err(Error::InvalidInput(
                    "directory cleanup cannot establish mount identity: duplicate fdinfo mnt_id"
                        .into(),
                ));
            }
            let value = value
                .strip_prefix(b"\t")
                .or_else(|| value.strip_prefix(b" "))
                .ok_or_else(|| {
                    Error::InvalidInput(
                        "directory cleanup cannot establish mount identity: malformed fdinfo mnt_id"
                            .into(),
                    )
                })?;
            if value.is_empty() || !value.iter().all(u8::is_ascii_digit) {
                return Err(Error::InvalidInput(
                    "directory cleanup cannot establish mount identity: malformed fdinfo mnt_id"
                        .into(),
                ));
            }
            let parsed = std::str::from_utf8(value)
                .ok()
                .and_then(|digits| digits.parse::<u64>().ok())
                .ok_or_else(|| {
                    Error::InvalidInput(
                        "directory cleanup cannot establish mount identity: malformed fdinfo mnt_id"
                            .into(),
                    )
                })?;
            mount_id = Some(parsed);
        }
        mount_id.ok_or_else(|| {
            Error::InvalidInput(
                "directory cleanup cannot establish mount identity: fdinfo mnt_id is missing"
                    .into(),
            )
        })
    }

    #[cfg(target_os = "linux")]
    pub(super) fn read_fdinfo_mount_id(file: &File) -> Result<u64, Error> {
        #[cfg(test)]
        if let Some(record) = current_test_removal_injector()
            .and_then(|injector| injector.fdinfo_record(file.as_raw_fd()))
        {
            return parse_fdinfo_mount_id(&record.map_err(io)?);
        }
        let path = format!("/proc/self/fdinfo/{}", file.as_raw_fd());
        let mut record = Vec::with_capacity(MAX_FDINFO_RECORD_BYTES as usize + 1);
        File::open(path)
            .map_err(io)?
            .take(MAX_FDINFO_RECORD_BYTES + 1)
            .read_to_end(&mut record)
            .map_err(io)?;
        parse_fdinfo_mount_id(&record)
    }

    #[cfg(target_os = "linux")]
    fn statx_mount_attributes(file: &File) -> Result<(u64, u64), Error> {
        #[cfg(test)]
        if let Some(attributes) = current_test_removal_injector()
            .and_then(|injector| injector.statx_mount_attributes(file.as_raw_fd()))
        {
            return attributes.map_err(io);
        }
        fs::statx(
            file,
            "",
            AtFlags::EMPTY_PATH | AtFlags::NO_AUTOMOUNT,
            fs::StatxFlags::empty(),
        )
        .map(|statx| {
            (
                statx.stx_attributes_mask.bits(),
                statx.stx_attributes.bits(),
            )
        })
        .map_err(|error| io(error.into()))
    }

    #[cfg(target_os = "linux")]
    pub(super) fn mount_crossing(parent: &File, child: &File) -> Result<bool, Error> {
        let mount_root = fs::StatxAttributes::MOUNT_ROOT.bits();
        match statx_mount_attributes(child) {
            Ok((mask, attributes)) if mask & mount_root != 0 => {
                return Ok(attributes & mount_root != 0);
            }
            Ok(_) => {}
            Err(Error::Io(error)) if error.raw_os_error() == Some(Errno::NOSYS.raw_os_error()) => {}
            Err(error) => return Err(error),
        }
        Ok(read_fdinfo_mount_id(parent)? != read_fdinfo_mount_id(child)?)
    }

    #[cfg(not(target_os = "linux"))]
    pub(super) fn mount_crossing(parent: &File, child: &File) -> Result<bool, Error> {
        mount_crossing_from(mount_path_evidence(parent), mount_path_evidence(child))
    }

    fn name(path: &Path) -> Result<&OsStr, Error> {
        path.file_name()
            .filter(|n| !n.as_bytes().is_empty())
            .ok_or_else(|| Error::InvalidInput("target must name a file".into()))
    }
    fn parent(path: &Path) -> &Path {
        path.parent().unwrap_or_else(|| Path::new("."))
    }
    pub(super) fn open_dir_no_follow(path: &Path) -> Result<File, Error> {
        let initial = if path.is_absolute() {
            Path::new("/")
        } else {
            Path::new(".")
        };
        let mut dir = fs::openat(
            fs::CWD,
            initial,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map(File::from)
        .map_err(|e| io(e.into()))?;
        for component in path.components() {
            match component {
                Component::RootDir | Component::CurDir => {}
                Component::Normal(component) => {
                    dir = fs::openat(
                        &dir,
                        component,
                        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                        Mode::empty(),
                    )
                    .map(File::from)
                    .map_err(|e| io(e.into()))?
                }
                Component::ParentDir | Component::Prefix(_) => {
                    return Err(Error::InvalidInput(
                        "parent path may not contain traversal components".into(),
                    ))
                }
            }
        }
        Ok(dir)
    }
    pub(super) fn open_parent(path: &Path) -> Result<File, Error> {
        open_dir_no_follow(parent(path))
    }
    fn missing(error: &rustix::io::Errno) -> bool {
        *error == Errno::NOENT
    }
    fn target_stat(dir: &File, target: &OsStr) -> Result<Option<fs::Stat>, Error> {
        match fs::statat(dir, target, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(stat) => Ok(Some(stat)),
            Err(error) if missing(&error) => Ok(None),
            Err(error) => Err(io(error.into())),
        }
    }
    fn regular(stat: &fs::Stat) -> bool {
        FileType::from_raw_mode(stat.st_mode) == FileType::RegularFile
    }
    fn same_inode(left: &fs::Stat, right: &fs::Stat) -> bool {
        raw_stat_identity(left) == raw_stat_identity(right)
    }
    fn temp_name() -> std::ffi::OsString {
        #[cfg(test)]
        if let Some(name) = TEST_TEMP_NAMES.with(|names| names.borrow_mut().pop()) {
            return name;
        }
        format!(".atomic-{}", uuid::Uuid::new_v4()).into()
    }
    #[cfg(test)]
    std::thread_local! {
        static TEST_TEMP_NAMES: std::cell::RefCell<Vec<std::ffi::OsString>> =
            const { std::cell::RefCell::new(Vec::new()) };
    }
    #[cfg(test)]
    pub(super) struct TestTempNamesGuard(Vec<std::ffi::OsString>);
    #[cfg(test)]
    impl Drop for TestTempNamesGuard {
        fn drop(&mut self) {
            let previous = std::mem::take(&mut self.0);
            TEST_TEMP_NAMES.with(|names| *names.borrow_mut() = previous);
        }
    }
    #[cfg(test)]
    pub(super) fn scoped_test_temp_names(names: Vec<std::ffi::OsString>) -> TestTempNamesGuard {
        let previous = TEST_TEMP_NAMES.with(|current| current.replace(names));
        TestTempNamesGuard(previous)
    }
    fn cleanup(dir: &File, temp: &OsStr, primary: Error) -> Error {
        #[cfg(test)]
        let injected = inject_atomic_file(AtomicFileFaultPoint::Cleanup).err();
        #[cfg(not(test))]
        let injected: Option<Error> = None;
        let unlink = fs::unlinkat(dir, temp, AtFlags::empty())
            .err()
            .map(|error| io(error.into()));
        match injected.or(unlink) {
            None => primary,
            Some(cleanup) => operation_and_cleanup_error(temp, primary, cleanup),
        }
    }

    pub(super) struct UnixAdapter;

    impl AtomicReplaceAdapter for UnixAdapter {
        type Target = fs::Stat;

        fn target_stat(
            &self,
            dir: &File,
            target: &OsStr,
            _mode: AtomicFileMode,
        ) -> Result<Option<Self::Target>, Error> {
            target_stat(dir, target)
        }

        fn is_regular(&self, target: &Self::Target) -> bool {
            regular(target)
        }

        fn target_identity(&self, target: &Self::Target) -> (u64, u64) {
            raw_stat_identity(target)
        }

        fn create_temp(
            &self,
            dir: &File,
            _original: Option<&Self::Target>,
        ) -> Result<(OsString, OwnedFile), Error> {
            let created = (0..16)
                .find_map(|_| {
                    let candidate = temp_name();
                    match crate::infra::inode_ownership::create_at(dir, &candidate, OFlags::WRONLY)
                    {
                        Ok(file) => Some(Ok((candidate, file))),
                        Err(Error::Io(error)) if error.raw_os_error() == Some(libc::EEXIST) => None,
                        Err(error) => Some(Err(error)),
                    }
                })
                .transpose()?
                .ok_or_else(|| {
                    Error::Conflict(
                        "could not allocate a unique private temporary file after 16 attempts"
                            .into(),
                    )
                })?;
            Ok(created)
        }

        fn before_write(
            &self,
            _dir: &File,
            _temp: &OwnedFile,
            _original: Option<&Self::Target>,
        ) -> Result<(), Error> {
            Ok(())
        }

        fn finalize_metadata(
            &self,
            temp: &mut OwnedFile,
            original: Option<&Self::Target>,
        ) -> Result<(), Error> {
            let final_mode = original.map_or(0o600, |stat| stat.st_mode & 0o7777);
            fs::fchmod(&mut *temp, Mode::from_raw_mode(final_mode))
                .map_err(|error| io(error.into()))?;
            let result = temp.sync_all().map_err(io);
            record_durability("temp.sync_all:metadata");
            result
        }

        fn rename(
            &self,
            dir: &File,
            _temp: &mut OwnedFile,
            temp_name: &OsStr,
            target: &OsStr,
            replace: bool,
            mode: AtomicFileMode,
        ) -> Result<RenameOutcome, Error> {
            if replace {
                fs::renameat(dir, temp_name, dir, target).map_err(|error| io(error.into()))
            } else {
                fs::renameat_with(dir, temp_name, dir, target, RenameFlags::NOREPLACE).map_err(
                    |error| {
                        if mode == AtomicFileMode::CreateWorkspaceSidecar {
                            return workspace_collision(io(error.into()));
                        }
                        if mode == AtomicFileMode::Create && error == rustix::io::Errno::EXIST {
                            match self.target_stat(dir, target, mode) {
                                Ok(Some(actual)) => {
                                    atomic_create_collision_error(self.is_regular(&actual))
                                }
                                Ok(None) => io(error.into()),
                                Err(error) => error,
                            }
                        } else {
                            io(error.into())
                        }
                    },
                )
            }
            .map(|()| RenameOutcome::Committed)
        }

        fn rename_classic(
            &self,
            dir: &File,
            temp: &mut OwnedFile,
            temp_name: &OsStr,
            target: &OsStr,
            mode: AtomicFileMode,
        ) -> Result<(), Error> {
            self.rename(dir, temp, temp_name, target, true, mode)
                .map(|_| ())
        }

        fn metadata(&self, temp: &OwnedFile) -> Result<TempMetadata, std::io::Error> {
            let stat = fs::fstat(temp)
                .map_err(|error| std::io::Error::from_raw_os_error(error.raw_os_error()))?;
            record_durability("temp.metadata");
            Ok(TempMetadata {
                identity: raw_stat_identity(&stat),
                ctime_nanos: i128::from(stat.st_ctime) * 1_000_000_000
                    + i128::from(stat.st_ctime_nsec),
                modified_seconds: stat.st_mtime,
            })
        }

        fn cleanup(
            &self,
            dir: &File,
            temp_name: &OsStr,
            _temp: &mut OwnedFile,
            primary: Error,
        ) -> Error {
            cleanup(dir, temp_name, primary)
        }
    }

    pub(super) fn replace<F, P>(
        target: &Path,
        precommit: P,
        write_fn: F,
    ) -> Result<AtomicInstalledFile, Error>
    where
        F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
        P: FnOnce() -> Result<(), Error>,
    {
        #[cfg(test)]
        inject_atomic_file(AtomicFileFaultPoint::ParentOpen)?;
        let dir = open_parent(target)?;
        let dir_identity = dir.metadata().map_err(io)?;
        let logical_parent = parent(target).to_path_buf();
        let target_name = name(target)?.to_os_string();
        replace_at_driver(
            UnixAdapter,
            dir,
            target_name,
            AtomicFileMode::Replace,
            move || {
                let current = open_dir_no_follow(&logical_parent)?;
                let metadata = current.metadata().map_err(io)?;
                if metadata.dev() != dir_identity.dev() || metadata.ino() != dir_identity.ino() {
                    return Err(Error::Conflict(
                        "parent directory changed concurrently".into(),
                    ));
                }
                precommit()
            },
            write_fn,
        )
    }

    pub(super) fn replace_at<F, P>(
        dir: File,
        target_name: OsString,
        mode: AtomicFileMode,
        precommit: P,
        write_fn: F,
    ) -> Result<AtomicInstalledFile, Error>
    where
        F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
        P: FnOnce() -> Result<(), Error>,
    {
        replace_at_driver(UnixAdapter, dir, target_name, mode, precommit, write_fn)
    }

    fn sync_tree(dir: &File, depth: usize) -> Result<(), Error> {
        walk_directory(dir, |bytes, _ino, _kind| {
            let name = std::ffi::OsString::from_vec(bytes.to_vec());
            let stat =
                fs::statat(dir, &name, AtFlags::SYMLINK_NOFOLLOW).map_err(|e| io(e.into()))?;
            if depth.saturating_add(1) >= MAX_REMOVE_TREE_DEPTH {
                return Err(Error::ResourceLimit(format!(
                    "directory install exceeded {MAX_REMOVE_TREE_DEPTH} levels"
                )));
            }
            match FileType::from_raw_mode(stat.st_mode) {
                FileType::RegularFile => {
                    super::open_regular_at(dir, &name, RegularFileAccess::ReadOnly)?
                        .sync_all()
                        .map_err(io)?
                }
                FileType::Directory => {
                    let child = File::from(
                        fs::openat(
                            dir,
                            &name,
                            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                            Mode::empty(),
                        )
                        .map_err(|e| io(e.into()))?,
                    );
                    sync_tree(&child, depth + 1)?;
                }
                _ => {
                    return Err(Error::InvalidInput(
                        "directory install rejects links and special files".into(),
                    ))
                }
            }
            Ok(())
        })?;
        ensure_directory_not_removed(dir)?;
        dir.sync_all().map_err(io)
    }

    pub(super) fn remove_tree_at(
        parent: &File,
        name: &OsStr,
        expected: (u64, u64),
        depth: usize,
        parent_dev: u64,
        removed_entries: &mut usize,
    ) -> Result<(), Error> {
        ensure_remove_tree_depth(depth, MAX_REMOVE_TREE_DEPTH)?;
        let stat = fs::statat(parent, name, AtFlags::SYMLINK_NOFOLLOW).map_err(|e| io(e.into()))?;
        // The identity check lives in each arm rather than here, because the directory arm must
        // let the mount check answer first: a cross-device mount differs from `expected` in
        // `st_dev`, and "refuses to cross a mount" is the true reason, not "changed concurrently".
        match FileType::from_raw_mode(stat.st_mode) {
            FileType::RegularFile => {
                if raw_stat_identity(&stat) != expected {
                    return Err(Error::Conflict(
                        "directory cleanup entry changed concurrently".into(),
                    ));
                }
                // There is no inode-conditional unlink here: a final name substitution can only
                // reach the kernel's type-confined `unlinkat` behavior, never an outside target.
                fs::unlinkat(parent, name, AtFlags::empty()).map_err(|e| io(e.into()))?;
                *removed_entries += 1;
                #[cfg(test)]
                inject_removal(RemovalFaultPoint::AfterEntryRemoved)?;
                Ok(())
            }
            FileType::Directory => {
                #[cfg(test)]
                let compared_parent_dev = if depth == 0 {
                    parent_dev
                } else {
                    inject_removal(RemovalFaultPoint::BeforeChildOpen)?.unwrap_or(parent_dev)
                };
                #[cfg(not(test))]
                let compared_parent_dev = parent_dev;
                let child = File::from(
                    fs::openat(
                        parent,
                        name,
                        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                        Mode::empty(),
                    )
                    .map_err(|e| io(e.into()))?,
                );
                let opened = fs::fstat(&child).map_err(|e| io(e.into()))?;
                if !same_inode(&opened, &stat) {
                    return Err(Error::Conflict(
                        "directory cleanup entry changed concurrently".into(),
                    ));
                }
                // `MOUNT_ROOT` requires Linux 5.8. When the bit is unavailable, or `statx`
                // returns `NOSYS`, descriptor mount IDs provide the required evidence. Failure to
                // read or strictly parse either bounded fdinfo record refuses destructive descent.
                let opened_identity = raw_stat_identity(&opened);
                let is_mount = if opened_identity.0 != compared_parent_dev {
                    true
                } else {
                    match mount_crossing(parent, &child) {
                        Ok(is_mount) => is_mount,
                        Err(error) => {
                            log::warn!("recursive delete cannot establish mount identity: {error}");
                            return Err(error);
                        }
                    }
                };
                if is_mount {
                    log::warn!("recursive delete stopped at a mount point");
                    return Err(Error::InvalidInput(
                        "directory cleanup refuses to cross a mount".into(),
                    ));
                }
                if raw_stat_identity(&stat) != expected {
                    return Err(Error::Conflict(
                        "directory cleanup entry changed concurrently".into(),
                    ));
                }
                walk_directory(&child, |bytes, ino, _kind| {
                    #[cfg(test)]
                    inject_removal(RemovalFaultPoint::BeforeChildStat)?;
                    remove_tree_at(
                        &child,
                        OsStr::from_bytes(bytes),
                        (opened_identity.0, ino),
                        depth + 1,
                        opened_identity.0,
                        removed_entries,
                    )
                })?;
                ensure_directory_not_removed(&child)?;
                // The descriptor pins the traversed directory, but this walk has no
                // inode-conditional unlink. The parent-relative terminal lookup remains
                // type-confined by `REMOVEDIR`; it can still name a concurrently substituted
                // directory.
                fs::unlinkat(parent, name, AtFlags::REMOVEDIR).map_err(|e| io(e.into()))?;
                *removed_entries += 1;
                #[cfg(test)]
                inject_removal(RemovalFaultPoint::AfterEntryRemoved)?;
                Ok(())
            }
            _ => Err(Error::InvalidInput(
                "directory cleanup rejects links and special files".into(),
            )),
        }
    }

    struct UnixDirInstallAdapter;

    impl DirInstallAdapter for UnixDirInstallAdapter {
        type Entry = fs::Stat;

        #[cfg(test)]
        fn open_parent(&self, path: &Path) -> Result<File, Error> {
            open_parent(path)
        }

        #[cfg(test)]
        fn parent_identity(&self, dir: &File) -> Result<(u64, u64), Error> {
            use std::os::unix::fs::MetadataExt;
            let metadata = dir.metadata().map_err(io)?;
            Ok((metadata.dev(), metadata.ino()))
        }

        fn target_stat(&self, dir: &File, name: &OsStr) -> Result<Option<Self::Entry>, Error> {
            target_stat(dir, name)
        }

        fn is_directory(&self, entry: &Self::Entry) -> bool {
            FileType::from_raw_mode(entry.st_mode) == FileType::Directory
        }

        fn entry_identity(&self, entry: &Self::Entry) -> (u64, u64) {
            raw_stat_identity(entry)
        }

        fn open_source_directory(&self, parent: &File, name: &OsStr) -> Result<File, Error> {
            Ok(File::from(
                fs::openat(
                    parent,
                    name,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|e| io(e.into()))?,
            ))
        }

        fn flush_tree(&self, dir: &File) -> Result<(), Error> {
            sync_tree(dir, 0)
        }

        fn commit(
            &self,
            parent: &File,
            source_name: &OsStr,
            target_name: &OsStr,
            _source: &mut Self::Entry,
            original: Option<&Self::Entry>,
        ) -> Result<Option<OsString>, Error> {
            // Unix `BackupRename` names the point immediately before the single `EXCHANGE`; no
            // backup leaf is created, because `EXCHANGE` swaps both names in one call.
            #[cfg(test)]
            inject_atomic_dir(AtomicDirFaultPoint::BackupRename)?;
            #[cfg(test)]
            inject_atomic_dir(AtomicDirFaultPoint::InstallRename)?;
            let flags = if original.is_some() {
                RenameFlags::EXCHANGE
            } else {
                RenameFlags::NOREPLACE
            };
            fs::renameat_with(parent, source_name, parent, target_name, flags)
                .map_err(|e| io(e.into()))?;
            // After `EXCHANGE` the displaced old target sits at the source name.
            Ok(original.map(|_| source_name.to_os_string()))
        }

        fn cleanup_displaced(
            &self,
            parent: &File,
            name: &OsStr,
            expected: &Self::Entry,
        ) -> Result<(), Error> {
            let parent_dev = parent.metadata().map_err(io)?.dev();
            let mut removed_entries = 0;
            remove_tree_at(
                parent,
                name,
                raw_stat_identity(expected),
                0,
                parent_dev,
                &mut removed_entries,
            )
        }
    }

    #[cfg(test)]
    pub(super) fn install_dir(source: &Path, target: &Path) -> Result<(), Error> {
        install_dir_driver(&UnixDirInstallAdapter, source, target)
    }

    pub(super) fn install_dir_at(
        parent: &File,
        source_name: &OsStr,
        expected_source: (u64, u64),
        target_name: &OsStr,
        policy: DirectoryInstallPolicy,
        committed: &mut bool,
    ) -> Result<(), Error> {
        install_dir_at_driver(
            &UnixDirInstallAdapter,
            DirectoryInstall {
                parent,
                source_name,
                expected_source: Some(expected_source),
                target_name,
                policy,
            },
            &|| Ok(()),
            committed,
        )
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use crate::infra::path_authority::{
        is_reparse_point, nt_create_windows_child, open_windows_child, opened_file_identity,
        windows_open_status_error, WindowsChildKind, WindowsChildRequest,
    };
    use std::{
        ffi::OsStr,
        fs::{File, OpenOptions},
        os::windows::{
            ffi::{OsStrExt, OsStringExt},
            fs::OpenOptionsExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
        },
        path::{Component, Path, PathBuf},
        ptr::{null, null_mut},
    };
    use windows_sys::{
        Wdk::Storage::FileSystem::{
            FileDispositionInformation, FileDispositionInformationEx,
            FileIdBothDirectoryInformation, FileRenameInformation, FileRenameInformationEx,
            NtQueryDirectoryFile, NtSetInformationFile, FILE_CREATE, FILE_DISPOSITION_DELETE,
            FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE, FILE_DISPOSITION_INFORMATION,
            FILE_DISPOSITION_INFORMATION_EX, FILE_DISPOSITION_POSIX_SEMANTICS,
            FILE_ID_BOTH_DIR_INFORMATION, FILE_OPEN, FILE_RENAME_IGNORE_READONLY_ATTRIBUTE,
            FILE_RENAME_INFORMATION, FILE_RENAME_POSIX_SEMANTICS, FILE_RENAME_REPLACE_IF_EXISTS,
        },
        Win32::{
            Foundation::{
                RtlNtStatusToDosError, ERROR_DIRECTORY, HANDLE, INVALID_HANDLE_VALUE,
                STATUS_BUFFER_OVERFLOW, STATUS_NO_MORE_FILES,
            },
            Security::{
                AddAccessAllowedAce, CopySid, GetAce, GetKernelObjectSecurity, GetLengthSid,
                GetTokenInformation, InitializeAcl, InitializeSecurityDescriptor,
                SetKernelObjectSecurity, SetSecurityDescriptorControl, SetSecurityDescriptorDacl,
                TokenUser, ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, DACL_SECURITY_INFORMATION,
                PSECURITY_DESCRIPTOR, PSID, SECURITY_DESCRIPTOR, SE_DACL_PROTECTED, TOKEN_QUERY,
                TOKEN_USER,
            },
            Storage::FileSystem::{
                GetFileType, ReOpenFile, DELETE, FILE_ALL_ACCESS, FILE_ATTRIBUTE_DIRECTORY,
                FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
                FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
                FILE_TYPE_DISK, READ_CONTROL, SYNCHRONIZE, WRITE_DAC,
            },
            System::{
                SystemServices::SECURITY_DESCRIPTOR_REVISION,
                Threading::{GetCurrentProcess, OpenProcessToken},
                IO::IO_STATUS_BLOCK,
            },
        },
    };
    // Only `test_security_descriptor_is_creator_only` reads a DACL back, so importing these
    // unconditionally makes them unused imports in a release build.
    #[cfg(test)]
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, EqualSid, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
        WinAuthenticatedUserSid, WinBuiltinAdministratorsSid, WinCreatorOwnerSid, WinWorldSid,
        CONTAINER_INHERIT_ACE, OBJECT_INHERIT_ACE,
    };
    // `ACE_HEADER::AceType` is a `u8` while the crate declares the constant as `u32`, so the
    // comparison casts rather than re-declaring the value here: a local copy of a crate constant
    // is a value that can silently drift away from the one the API actually uses.
    #[cfg(test)]
    use windows_sys::Win32::System::SystemServices::ACCESS_ALLOWED_ACE_TYPE;

    #[cfg(test)]
    std::thread_local! {
        static TEST_EX_STATUS: std::cell::Cell<(u64, i32)> = const { std::cell::Cell::new((0, 0)) };
        static TEST_NT_SET_INFORMATION_STATUS: std::cell::Cell<Option<i32>> = const { std::cell::Cell::new(None) };
        static TEST_CLASSIC_NT_STATUS: std::cell::Cell<Option<i32>> = const { std::cell::Cell::new(None) };
        static TEST_POSIX_EX_FALLBACK_COUNT: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    }

    #[cfg(test)]
    fn set_test_nt_set_information_status(status: Option<i32>) {
        TEST_NT_SET_INFORMATION_STATUS.with(|slot| slot.set(status));
    }

    #[cfg(test)]
    fn set_test_classic_nt_status(status: Option<i32>) {
        TEST_CLASSIC_NT_STATUS.with(|slot| slot.set(status));
    }

    #[cfg(test)]
    struct NtStatusReset;

    #[cfg(test)]
    impl Drop for NtStatusReset {
        fn drop(&mut self) {
            set_test_nt_set_information_status(None);
            set_test_classic_nt_status(None);
        }
    }

    #[cfg(test)]
    fn posix_ex_fallback_count() -> u64 {
        TEST_POSIX_EX_FALLBACK_COUNT.with(|slot| slot.get())
    }

    fn ex_nt_status(call: impl FnOnce() -> i32) -> i32 {
        #[cfg(test)]
        if let Some(status) = TEST_NT_SET_INFORMATION_STATUS.with(|slot| slot.take()) {
            return status;
        }
        call()
    }

    fn classic_nt_status(call: impl FnOnce() -> i32) -> i32 {
        #[cfg(test)]
        {
            TEST_POSIX_EX_FALLBACK_COUNT.with(|slot| slot.set(slot.get() + 1));
            if let Some(status) = TEST_CLASSIC_NT_STATUS.with(|slot| slot.take()) {
                return status;
            }
        }
        call()
    }

    fn ex_status_is_unsupported(status: i32) -> bool {
        dos_error_means_ex_unsupported(unsafe { RtlNtStatusToDosError(status) })
    }

    #[cfg(test)]
    mod ex_fallback_tests {
        use super::*;
        use windows_sys::Win32::Foundation::{
            STATUS_ACCESS_DENIED, STATUS_INVALID_DEVICE_REQUEST, STATUS_INVALID_PARAMETER,
            STATUS_NOT_SUPPORTED, STATUS_OBJECT_NAME_COLLISION, STATUS_SHARING_VIOLATION,
        };

        const OLD: &[u8] = b"previous generation";
        const NEW: &[u8] = b"replacement generation";

        fn fixture() -> (NtStatusReset, tempfile::TempDir, File) {
            let reset = NtStatusReset;
            TEST_POSIX_EX_FALLBACK_COUNT.with(|slot| slot.set(0));
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("target"), OLD).unwrap();
            let parent = super::super::windows_test_parent(dir.path());
            (reset, dir, parent)
        }

        fn replace(parent: &File) -> Result<AtomicFileOutcome, Error> {
            super::super::atomic_replace_at(parent, OsStr::new("target"), |temp| {
                temp.write_all(NEW).map_err(io)
            })
        }

        fn identity(dir: &Path) -> (u64, u64) {
            let file = File::open(dir.join("target")).unwrap();
            opened_file_identity(&file).unwrap()
        }

        fn unlink(parent: &File, expected: (u64, u64)) -> Result<(), Error> {
            super::super::remove_entry_at(parent, OsStr::new("target"), expected, false)
        }

        fn rename(parent: &File, expected: (u64, u64)) -> Result<AtomicFileOutcome, Error> {
            super::super::rename_entry_at(
                parent,
                OsStr::new("target"),
                expected,
                false,
                parent,
                OsStr::new("renamed"),
            )
        }

        fn assert_unlinked(result: Result<(), Error>, path: &Path) {
            assert!(
                matches!(result, Ok(()) | Err(Error::CommittedDurabilityUncertain(_))),
                "{result:?}"
            );
            assert_eq!(
                std::fs::symlink_metadata(path).unwrap_err().kind(),
                std::io::ErrorKind::NotFound
            );
        }

        #[test]
        fn windows_ex_fallback_ntfs_replace_does_not_fall_back() {
            let (_reset, dir, parent) = fixture();
            replace(&parent).unwrap().expect_durable();
            assert_eq!(std::fs::read(dir.path().join("target")).unwrap(), NEW);
            assert_eq!(posix_ex_fallback_count(), 0);
        }

        #[test]
        fn windows_ex_fallback_injected_invalid_parameter_replace_commits() {
            let (_reset, dir, parent) = fixture();
            set_test_nt_set_information_status(Some(STATUS_INVALID_PARAMETER));
            replace(&parent).unwrap().expect_durable();
            assert_eq!(std::fs::read(dir.path().join("target")).unwrap(), NEW);
            assert_eq!(posix_ex_fallback_count(), 1);
        }

        #[test]
        fn windows_ex_fallback_injected_not_supported_replace_commits() {
            let (_reset, dir, parent) = fixture();
            set_test_nt_set_information_status(Some(STATUS_NOT_SUPPORTED));
            replace(&parent).unwrap().expect_durable();
            assert_eq!(std::fs::read(dir.path().join("target")).unwrap(), NEW);
            assert_eq!(posix_ex_fallback_count(), 1);
        }

        #[test]
        fn windows_ex_fallback_injected_invalid_device_request_replace_commits() {
            let (_reset, dir, parent) = fixture();
            set_test_nt_set_information_status(Some(STATUS_INVALID_DEVICE_REQUEST));
            replace(&parent).unwrap().expect_durable();
            assert_eq!(std::fs::read(dir.path().join("target")).unwrap(), NEW);
            assert_eq!(posix_ex_fallback_count(), 1);
        }

        #[test]
        fn windows_ex_fallback_injected_collision_does_not_fall_back() {
            let (_reset, dir, parent) = fixture();
            set_test_nt_set_information_status(Some(STATUS_OBJECT_NAME_COLLISION));
            assert!(
                matches!(replace(&parent), Err(Error::Conflict(message)) if message == "Windows object name collision")
            );
            assert_eq!(std::fs::read(dir.path().join("target")).unwrap(), OLD);
            assert_eq!(posix_ex_fallback_count(), 0);
        }

        #[test]
        fn windows_ex_fallback_injected_invalid_parameter_unlink_commits() {
            let (_reset, dir, parent) = fixture();
            let expected = identity(dir.path());
            set_test_nt_set_information_status(Some(STATUS_INVALID_PARAMETER));
            assert_unlinked(unlink(&parent, expected), &dir.path().join("target"));
            assert_eq!(posix_ex_fallback_count(), 1);
        }

        #[test]
        fn windows_ex_fallback_injected_sharing_unlink_keeps_name() {
            let (_reset, dir, parent) = fixture();
            let expected = identity(dir.path());
            set_test_nt_set_information_status(Some(STATUS_SHARING_VIOLATION));
            assert!(
                matches!(unlink(&parent, expected), Err(Error::Conflict(message)) if message == "Windows sharing violation")
            );
            assert_eq!(std::fs::read(dir.path().join("target")).unwrap(), OLD);
            assert_eq!(posix_ex_fallback_count(), 0);
        }

        #[test]
        fn windows_ex_fallback_injected_invalid_parameter_noreplace_commits() {
            let (_reset, dir, parent) = fixture();
            let expected = identity(dir.path());
            set_test_nt_set_information_status(Some(STATUS_INVALID_PARAMETER));
            rename(&parent, expected).unwrap().expect_durable();
            assert_eq!(std::fs::read(dir.path().join("renamed")).unwrap(), OLD);
            assert_eq!(
                std::fs::symlink_metadata(dir.path().join("target"))
                    .unwrap_err()
                    .kind(),
                std::io::ErrorKind::NotFound
            );
            assert_eq!(posix_ex_fallback_count(), 1);
        }

        #[test]
        fn windows_ex_fallback_injected_invalid_parameter_noreplace_keeps_occupied() {
            let (_reset, dir, parent) = fixture();
            std::fs::write(dir.path().join("renamed"), NEW).unwrap();
            let expected = identity(dir.path());
            set_test_nt_set_information_status(Some(STATUS_INVALID_PARAMETER));
            assert!(
                matches!(rename(&parent, expected), Err(Error::Conflict(message)) if message == "Windows object name collision")
            );
            assert_eq!(std::fs::read(dir.path().join("target")).unwrap(), OLD);
            assert_eq!(std::fs::read(dir.path().join("renamed")).unwrap(), NEW);
            assert_eq!(posix_ex_fallback_count(), 1);
        }

        #[test]
        fn windows_ex_fallback_injected_classic_replace_failure_cleans_up() {
            let (_reset, dir, parent) = fixture();
            set_test_nt_set_information_status(Some(STATUS_INVALID_PARAMETER));
            set_test_classic_nt_status(Some(STATUS_SHARING_VIOLATION));
            assert!(
                matches!(replace(&parent), Err(Error::Conflict(message)) if message == "Windows sharing violation")
            );
            assert_eq!(std::fs::read(dir.path().join("target")).unwrap(), OLD);
            let entries: Vec<_> = std::fs::read_dir(dir.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            assert_eq!(entries, vec![OsString::from("target")]);
            assert_eq!(posix_ex_fallback_count(), 1);
        }

        #[test]
        fn windows_ex_fallback_injected_classic_unlink_failure_keeps_name() {
            let (_reset, dir, parent) = fixture();
            let expected = identity(dir.path());
            set_test_nt_set_information_status(Some(STATUS_INVALID_PARAMETER));
            set_test_classic_nt_status(Some(STATUS_ACCESS_DENIED));
            assert!(
                matches!(unlink(&parent, expected), Err(Error::Io(error)) if error.raw_os_error() == Some(5))
            );
            assert_eq!(std::fs::read(dir.path().join("target")).unwrap(), OLD);
            assert_eq!(posix_ex_fallback_count(), 1);
        }
    }

    #[cfg(test)]
    fn note_test_ex_status(status: i32) {
        TEST_EX_STATUS.with(|slot| slot.set((slot.get().0 + 1, status)));
    }

    #[cfg(test)]
    fn test_ex_generation() -> u64 {
        TEST_EX_STATUS.with(|slot| slot.get().0)
    }

    #[cfg(test)]
    fn last_ex_ntstatus() -> i32 {
        TEST_EX_STATUS.with(|slot| slot.get().1)
    }

    #[cfg(all(test, windows))]
    #[test]
    fn windows_non_ntfs_volume_records_ex_status() {
        const OLD: &[u8] = b"previous volume generation";
        const NEW: &[u8] = b"replacement volume generation";

        fn measured_status(before: u64) -> i32 {
            assert_eq!(
                test_ex_generation(),
                before + 1,
                "measured operation must reach exactly one Ex call"
            );
            last_ex_ntstatus()
        }

        fn measure_replace(
            parent: &File,
            path: &Path,
            mapped: Option<&memmap2::Mmap>,
        ) -> (i32, &'static str) {
            let before = test_ex_generation();
            let result = super::atomic_replace_at(parent, path.file_name().unwrap(), |temp| {
                temp.write_all(NEW).map_err(io)
            });
            let status = measured_status(before);
            let outcome = match result {
                Ok(_) => {
                    assert_eq!(std::fs::read(path).unwrap(), NEW);
                    "committed"
                }
                Err(_) => {
                    assert_eq!(std::fs::read(path).unwrap(), OLD);
                    "error"
                }
            };
            if let Some(mapped) = mapped {
                assert_eq!(&mapped[..], OLD);
            }
            (status, outcome)
        }

        let roots = [
            ("fat32", std::env::var_os("CHESSFABLE_FAT32_ROOT")),
            ("exfat", std::env::var_os("CHESSFABLE_EXFAT_ROOT")),
        ];
        let missing_root = roots
            .iter()
            .any(|(_, root)| root.as_ref().is_none_or(|root| root.is_empty()));
        if std::env::var_os("GITHUB_ACTIONS").is_none() && missing_root {
            return;
        }
        assert!(!missing_root, "both volume roots are required in CI");
        let measurement = std::env::var_os("CHESSFABLE_VOLUME_MEASUREMENT")
            .filter(|path| !path.is_empty())
            .expect("volume measurement path is required");
        let mut record = OpenOptions::new()
            .create(true)
            .append(true)
            .open(measurement)
            .expect("writable volume measurement file");

        for (filesystem, root) in roots {
            let root = PathBuf::from(root.unwrap());
            let metadata = std::fs::symlink_metadata(&root).expect("usable volume root");
            assert!(metadata.is_dir() && !is_reparse_point(&metadata));
            let dir = tempfile::tempdir_in(root).expect("writable directory on volume");
            let parent = super::windows_test_parent(dir.path());

            let replace = dir.path().join("replace");
            std::fs::write(&replace, OLD).unwrap();
            let (status, outcome) = measure_replace(&parent, &replace, None);
            writeln!(record, "{filesystem} replace {status} {outcome}").unwrap();
            assert_eq!(outcome, "committed");

            let unlink = dir.path().join("unlink");
            std::fs::write(&unlink, OLD).unwrap();
            let identity = {
                let file = File::open(&unlink).unwrap();
                opened_file_identity(&file).unwrap()
            };
            let before = test_ex_generation();
            let result =
                super::remove_entry_at(&parent, unlink.file_name().unwrap(), identity, false);
            let status = measured_status(before);
            let outcome = match result {
                Ok(()) | Err(Error::CommittedDurabilityUncertain(_)) => {
                    assert_eq!(
                        std::fs::symlink_metadata(&unlink).unwrap_err().kind(),
                        std::io::ErrorKind::NotFound
                    );
                    "committed"
                }
                Err(_) => {
                    assert!(std::fs::symlink_metadata(&unlink).unwrap().is_file());
                    "error"
                }
            };
            writeln!(record, "{filesystem} unlink {status} {outcome}").unwrap();
            assert_eq!(outcome, "committed");

            let mapped_path = dir.path().join("mapped-replace");
            std::fs::write(&mapped_path, OLD).unwrap();
            let external = File::open(&mapped_path).unwrap();
            // The fixture never writes through the mapped file. Replacement changes only its name.
            match unsafe { memmap2::Mmap::map(&external) } {
                Ok(mapped) => {
                    let (status, outcome) = measure_replace(&parent, &mapped_path, Some(&mapped));
                    writeln!(record, "{filesystem} mapped-replace {status} {outcome}").unwrap();
                }
                Err(_) => {
                    writeln!(record, "{filesystem} mapped-replace - unavailable").unwrap();
                }
            }
        }
    }

    const FILE_SHARE_PRIVATE_TEMP: u32 = FILE_SHARE_WRITE;
    const TEMP_ACCESS: u32 = DELETE
        | SYNCHRONIZE
        | windows_sys::Win32::Foundation::GENERIC_READ
        | windows_sys::Win32::Foundation::GENERIC_WRITE
        | READ_CONTROL
        | WRITE_DAC;
    pub(super) const TARGET_ACCESS: u32 =
        DELETE | SYNCHRONIZE | windows_sys::Win32::Foundation::GENERIC_READ | READ_CONTROL;
    /// Read-only access to an already-existing object of either kind. `SYNCHRONIZE` is what
    /// `FILE_SYNCHRONOUS_IO_NONALERT` requires of every mask this module opens with.
    const READ_ONLY_ACCESS: u32 =
        SYNCHRONIZE | windows_sys::Win32::Foundation::GENERIC_READ | READ_CONTROL;
    const DIRECTORY_ACCESS: u32 = READ_ONLY_ACCESS | windows_sys::Win32::Foundation::GENERIC_WRITE;
    pub(crate) const MAX_REMOVE_TREE_DEPTH: usize = 64;
    const DIRECTORY_ENUMERATION_START_BYTES: usize = 8192;
    const DIRECTORY_ENUMERATION_MAX_BYTES: usize = 1024 * 1024;
    const DIRECTORY_ENUMERATION_OVERFLOW_RETRIES: u8 = 8;
    const PRIVATE_TEMP_RETRIES: u8 = 16;
    pub(super) const OPEN_OR_CREATE_RETRIES: usize = 16;

    // Exposed through `type Target = Target` in the pub(super) AtomicReplaceAdapter impl below,
    // so it may not be more private than that impl (E0446 on the Windows target).
    pub(super) struct Target {
        handle: File,
        identity: (u64, u64),
        regular: bool,
    }

    struct PrivateSecurityDescriptor {
        descriptor: SECURITY_DESCRIPTOR,
        _acl: AlignedBuffer,
    }

    struct AlignedBuffer {
        storage: Vec<u64>,
        length: usize,
    }

    impl AlignedBuffer {
        fn new<const ALIGNMENT: usize>(length: usize) -> Self {
            const {
                assert!(ALIGNMENT <= std::mem::align_of::<u64>());
            }
            Self {
                storage: vec![0; length.div_ceil(std::mem::size_of::<u64>())],
                length,
            }
        }

        fn as_ptr(&self) -> *const u8 {
            self.storage.as_ptr().cast()
        }

        fn as_mut_ptr(&mut self) -> *mut u8 {
            self.storage.as_mut_ptr().cast()
        }

        fn len(&self) -> usize {
            self.length
        }
    }

    fn open_current_process_token() -> Result<OwnedHandle, Error> {
        let mut token: HANDLE = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(unsafe { OwnedHandle::from_raw_handle(token as RawHandle) })
    }

    // Keep these typed buffer boundaries: `AlignedBuffer` is the compile-time anchor for the
    // alignment required by each API, so unsafe code never accepts a caller-owned `*mut u8`.
    fn get_token_information(token: &OwnedHandle, buffer: &mut AlignedBuffer) -> Result<(), Error> {
        let mut returned = 0_u32;
        if unsafe {
            GetTokenInformation(
                token.as_raw_handle() as HANDLE,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                &mut returned,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }

    fn process_user_sid_uncached() -> Result<Vec<u8>, Error> {
        let token = open_current_process_token()?;
        let mut required = 0_u32;
        let _ = unsafe {
            GetTokenInformation(
                token.as_raw_handle() as HANDLE,
                TokenUser,
                null_mut(),
                0,
                &mut required,
            )
        };
        let error = std::io::Error::last_os_error();
        if required == 0 {
            return Err(error.into());
        }
        let mut token_user =
            AlignedBuffer::new::<{ std::mem::align_of::<TOKEN_USER>() }>(required as usize);
        get_token_information(&token, &mut token_user)?;
        let token_user = unsafe { &*token_user.as_ptr().cast::<TOKEN_USER>() };
        if token_user.User.Sid.is_null() {
            return Err(std::io::Error::other("process token has no user SID").into());
        }
        let sid_length = unsafe { GetLengthSid(token_user.User.Sid) };
        if sid_length == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut sid = vec![0_u8; sid_length as usize];
        if unsafe { CopySid(sid_length, sid.as_mut_ptr() as PSID, token_user.User.Sid) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(sid)
    }

    fn process_user_sid() -> Result<&'static [u8], Error> {
        static PROCESS_USER_SID: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
        if let Some(sid) = PROCESS_USER_SID.get() {
            return Ok(sid);
        }
        let sid = process_user_sid_uncached()?;
        Ok(PROCESS_USER_SID.get_or_init(|| sid).as_slice())
    }

    fn get_kernel_object_security(
        file: &impl crate::infra::inode_ownership::NativeFile,
        descriptor: &mut AlignedBuffer,
    ) -> Result<(), Error> {
        let mut returned = 0_u32;
        if unsafe {
            GetKernelObjectSecurity(
                file.as_raw_handle() as HANDLE,
                DACL_SECURITY_INFORMATION,
                descriptor.as_mut_ptr().cast(),
                descriptor.len() as u32,
                &mut returned,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }

    trait AsSecurityDescriptor {
        fn as_security_descriptor(&self) -> PSECURITY_DESCRIPTOR;
    }

    impl AsSecurityDescriptor for AlignedBuffer {
        fn as_security_descriptor(&self) -> PSECURITY_DESCRIPTOR {
            self.as_ptr().cast_mut().cast()
        }
    }

    impl AsSecurityDescriptor for SECURITY_DESCRIPTOR {
        fn as_security_descriptor(&self) -> PSECURITY_DESCRIPTOR {
            (self as *const SECURITY_DESCRIPTOR).cast_mut().cast()
        }
    }

    fn set_kernel_object_security(
        file: &impl crate::infra::inode_ownership::NativeFile,
        descriptor: &impl AsSecurityDescriptor,
    ) -> Result<(), Error> {
        if unsafe {
            SetKernelObjectSecurity(
                file.as_raw_handle() as HANDLE,
                DACL_SECURITY_INFORMATION,
                descriptor.as_security_descriptor(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }

    fn initialize_acl(acl: &mut AlignedBuffer, length: u32) -> Result<(), Error> {
        if unsafe { InitializeAcl(acl.as_mut_ptr().cast(), length, ACL_REVISION) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }

    fn add_access_allowed_ace(
        acl: &mut AlignedBuffer,
        access: u32,
        sid: &[u8],
    ) -> Result<(), Error> {
        if unsafe {
            AddAccessAllowedAce(
                acl.as_mut_ptr().cast(),
                ACL_REVISION,
                access,
                sid.as_ptr().cast_mut().cast(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }

    fn set_security_descriptor_dacl(
        descriptor: &mut SECURITY_DESCRIPTOR,
        acl: &AlignedBuffer,
    ) -> Result<(), Error> {
        if unsafe {
            SetSecurityDescriptorDacl(
                (descriptor as *mut SECURITY_DESCRIPTOR).cast(),
                1,
                acl.as_ptr().cast(),
                0,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }

    impl PrivateSecurityDescriptor {
        fn new(access: u32) -> Result<Self, Error> {
            Self::new_with_options(access, 0, true)
        }

        fn new_with_options(access: u32, ace_flags: u8, protect_dacl: bool) -> Result<Self, Error> {
            let sid = process_user_sid()?;

            let acl_length = std::mem::size_of::<ACL>() + std::mem::size_of::<ACCESS_ALLOWED_ACE>()
                - std::mem::size_of::<u32>()
                + sid.len();
            let mut acl = AlignedBuffer::new::<{ std::mem::align_of::<ACL>() }>(acl_length);
            initialize_acl(&mut acl, acl_length as u32)?;
            add_access_allowed_ace(&mut acl, access, sid)?;
            set_acl_ace_flags(&mut acl, ace_flags)?;

            let mut descriptor = SECURITY_DESCRIPTOR::default();
            // PSECURITY_DESCRIPTOR is `*mut c_void`, so `&mut SECURITY_DESCRIPTOR` does not
            // coerce; every descriptor argument in this module is cast explicitly.
            let descriptor_ptr =
                (&mut descriptor as *mut SECURITY_DESCRIPTOR) as PSECURITY_DESCRIPTOR;
            if unsafe { InitializeSecurityDescriptor(descriptor_ptr, SECURITY_DESCRIPTOR_REVISION) }
                == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            set_security_descriptor_dacl(&mut descriptor, &acl)?;
            // A supplied DACL does not keep the parent directory's inheritable ACEs out of a new
            // object: Windows merges them in unless the descriptor is marked protected. Production
            // temporaries therefore pass `protect_dacl = true`; the inheritable test fixture
            // deliberately passes false so it can exercise that Windows behaviour.
            if protect_dacl
                && unsafe {
                    SetSecurityDescriptorControl(
                        descriptor_ptr,
                        SE_DACL_PROTECTED,
                        SE_DACL_PROTECTED,
                    )
                } == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(Self {
                descriptor,
                _acl: acl,
            })
        }

        fn as_ptr(&self) -> *const SECURITY_DESCRIPTOR {
            &self.descriptor
        }
    }

    pub(super) struct WindowsAdapter;

    fn as_io(error: Error) -> std::io::Error {
        match error {
            Error::Io(error) => *error,
            other => std::io::Error::other(other.to_string()),
        }
    }

    fn target_stat(
        dir: &File,
        name: &OsStr,
        mode: AtomicFileMode,
    ) -> Result<Option<Target>, Error> {
        // Exclusive create observes directories too, so the driver's regular-file guard can
        // reject them as InvalidInput before allocating a temporary. Replacement keeps its
        // existing non-directory open and access requirements.
        let handle = match crate::infra::path_authority::open_windows_child_with_kind(
            dir,
            name,
            FILE_OPEN,
            if mode == AtomicFileMode::Create {
                READ_ONLY_ACCESS
            } else {
                TARGET_ACCESS
            },
            null(),
            if mode == AtomicFileMode::Create {
                WindowsChildKind::FileOrDirectory
            } else {
                WindowsChildKind::NonDirectory
            },
            true,
        ) {
            Ok(handle) => handle,
            Err(error) if error.is_missing_entry() => return Ok(None),
            Err(error) => return Err(error),
        };
        let identity = opened_file_identity(&handle)?;
        let regular = unsafe { GetFileType(handle.as_raw_handle() as HANDLE) == FILE_TYPE_DISK }
            && (mode == AtomicFileMode::Replace || handle.metadata().map_err(io)?.is_file());
        Ok(Some(Target {
            handle,
            identity,
            regular,
        }))
    }

    fn target_regular(target: &Target) -> bool {
        // FILE_NON_DIRECTORY_FILE only excludes directories: devices, volumes, pipes and mailslots
        // are all "non-directory" objects and were accepted here, so the driver's "target must be
        // a regular file, not a link or special file" guard was vacuous on Windows while the unix
        // arm really checked. FILE_TYPE_DISK is what separates a file on disk from those.
        // Create-mode opens may be directories. `target.regular` is false for those, so a
        // directory stays InvalidInput rather than a name-taken conflict.
        target.regular
            && unsafe { GetFileType(target.handle.as_raw_handle() as HANDLE) == FILE_TYPE_DISK }
    }

    fn temp_name() -> OsString {
        #[cfg(test)]
        if let Some(name) = TEST_TEMP_NAMES.with(|names| names.borrow_mut().pop()) {
            return name;
        }
        format!(".atomic-{}", uuid::Uuid::new_v4()).into()
    }

    #[cfg(test)]
    std::thread_local! {
        static TEST_TEMP_NAMES: std::cell::RefCell<Vec<OsString>> =
            const { std::cell::RefCell::new(Vec::new()) };
    }

    #[cfg(test)]
    pub(super) struct TestTempNamesGuard(Vec<OsString>);

    #[cfg(test)]
    impl Drop for TestTempNamesGuard {
        fn drop(&mut self) {
            let previous = std::mem::take(&mut self.0);
            TEST_TEMP_NAMES.with(|names| *names.borrow_mut() = previous);
        }
    }

    #[cfg(test)]
    pub(super) fn scoped_test_temp_names(names: Vec<OsString>) -> TestTempNamesGuard {
        let previous = TEST_TEMP_NAMES.with(|current| current.replace(names));
        TestTempNamesGuard(previous)
    }

    fn capture_security_descriptor(
        file: &impl crate::infra::inode_ownership::NativeFile,
    ) -> Result<AlignedBuffer, Error> {
        let mut required = 0_u32;
        let _ = unsafe {
            GetKernelObjectSecurity(
                file.as_raw_handle() as HANDLE,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                0,
                &mut required,
            )
        };
        let error = std::io::Error::last_os_error();
        if required == 0 {
            return Err(error.into());
        }
        let mut descriptor = AlignedBuffer::new::<
            { std::mem::align_of::<windows_sys::Win32::Security::SECURITY_DESCRIPTOR_RELATIVE>() },
        >(required as usize);
        get_kernel_object_security(file, &mut descriptor)?;
        Ok(descriptor)
    }

    fn open_temp_child(
        dir: &File,
        name: &OsStr,
        security_descriptor: &PrivateSecurityDescriptor,
    ) -> Result<File, Error> {
        nt_create_windows_child(
            dir,
            name,
            WindowsChildRequest {
                disposition: FILE_CREATE,
                access: TEMP_ACCESS,
                security_descriptor: security_descriptor.as_ptr(),
                kind: WindowsChildKind::NonDirectory,
                share_access: FILE_SHARE_PRIVATE_TEMP,
            },
        )
    }

    pub(super) fn create_temp(
        dir: &File,
        _original: Option<&Target>,
    ) -> Result<(OsString, OwnedFile), Error> {
        let security_descriptor = PrivateSecurityDescriptor::new(FILE_ALL_ACCESS)?;
        (0..PRIVATE_TEMP_RETRIES)
            .find_map(|_| {
                let candidate = temp_name();
                match open_temp_child(dir, &candidate, &security_descriptor) {
                    Ok(file) => Some(
                        admit_created(file, &candidate, CreatedFileMode::PrivateTemp)
                            .map(|file| (candidate, file)),
                    ),
                    Err(Error::Conflict(message)) if message == "Windows object name collision" => {
                        None
                    }
                    Err(error) => Some(Err(error)),
                }
            })
            .transpose()?
            .ok_or_else(|| {
                Error::Conflict(
                    format!(
                        "could not allocate a unique private temporary file after {PRIVATE_TEMP_RETRIES} attempts"
                    ),
                )
            })
    }

    pub(super) fn rename_child(
        dir: &File,
        temp: &mut impl crate::infra::inode_ownership::NativeFile,
        _temp_name: &OsStr,
        target: &OsStr,
        replace: bool,
    ) -> Result<(), Error> {
        rename_child_with_mode(
            dir,
            temp,
            _temp_name,
            target,
            replace,
            AtomicFileMode::Replace,
            false,
        )
        .map(|_| ())
    }

    fn rename_child_with_mode(
        dir: &File,
        temp: &mut impl crate::infra::inode_ownership::NativeFile,
        _temp_name: &OsStr,
        target: &OsStr,
        replace: bool,
        mode: AtomicFileMode,
        workspace_name: bool,
    ) -> Result<RenameOutcome, Error> {
        super::single_leaf(target)?;
        let flags = if replace {
            FILE_RENAME_REPLACE_IF_EXISTS
                | FILE_RENAME_POSIX_SEMANTICS
                | FILE_RENAME_IGNORE_READONLY_ATTRIBUTE
        } else {
            FILE_RENAME_POSIX_SEMANTICS
        };
        let buffer = rename_information_buffer(dir, target, flags);
        let status =
            ex_nt_status(|| set_rename_information(temp, &buffer, FileRenameInformationEx));
        #[cfg(test)]
        note_test_ex_status(status);
        classify_rename_status(status, dir, target, mode, workspace_name).or_else(|error| {
            if ex_status_is_unsupported(status) {
                Ok(())
            } else {
                Err(error)
            }
        })?;
        if status == 0 {
            return Ok(RenameOutcome::Committed);
        }
        if replace {
            return Ok(RenameOutcome::RetryWithoutDestinationPin);
        }
        let buffer = classic_rename_information_buffer(dir, target, replace);
        let status =
            classic_nt_status(|| set_rename_information(temp, &buffer, FileRenameInformation));
        classify_rename_status(status, dir, target, mode, workspace_name)?;
        Ok(RenameOutcome::Committed)
    }

    fn classic_rename_information_buffer(dir: &File, target: &OsStr, replace: bool) -> Vec<u8> {
        let replace_if_exists = if replace { 1_u32 } else { 0_u32 };
        rename_information_buffer(dir, target, replace_if_exists)
    }

    fn rename_information_buffer(dir: &File, target: &OsStr, flags: u32) -> Vec<u8> {
        // FILE_RENAME_INFORMATION is a variable-length structure: FileName is declared [u16; 1]
        // but carries the whole leaf, so it cannot be written as a plain value and the buffer is
        // laid out by hand. The offsets are taken from the crate's own struct rather than spelled
        // as literals, so the compiler derives them and a layout change cannot silently desync.
        // NtSetInformationFile requires at least the padded struct size, even when a short leaf
        // ends before its trailing padding.
        const ROOT_DIRECTORY_OFFSET: usize =
            std::mem::offset_of!(FILE_RENAME_INFORMATION, RootDirectory);
        const FILE_NAME_LENGTH_OFFSET: usize =
            std::mem::offset_of!(FILE_RENAME_INFORMATION, FileNameLength);
        const FILE_NAME_OFFSET: usize = std::mem::offset_of!(FILE_RENAME_INFORMATION, FileName);

        let wide: Vec<u16> = target.encode_wide().collect();
        let name_bytes = wide.len() * std::mem::size_of::<u16>();
        let buffer_len =
            (FILE_NAME_OFFSET + name_bytes).max(std::mem::size_of::<FILE_RENAME_INFORMATION>());
        let mut buffer = vec![0_u8; buffer_len];
        unsafe {
            std::ptr::write_unaligned(buffer.as_mut_ptr().cast::<u32>(), flags);
            std::ptr::write_unaligned(
                buffer
                    .as_mut_ptr()
                    .add(ROOT_DIRECTORY_OFFSET)
                    .cast::<HANDLE>(),
                dir.as_raw_handle() as HANDLE,
            );
            std::ptr::write_unaligned(
                buffer
                    .as_mut_ptr()
                    .add(FILE_NAME_LENGTH_OFFSET)
                    .cast::<u32>(),
                name_bytes as u32,
            );
            std::ptr::copy_nonoverlapping(
                wide.as_ptr().cast::<u8>(),
                buffer.as_mut_ptr().add(FILE_NAME_OFFSET),
                name_bytes,
            );
        }
        buffer
    }

    fn set_rename_information(
        temp: &impl crate::infra::inode_ownership::NativeFile,
        buffer: &[u8],
        information_class: windows_sys::Wdk::Storage::FileSystem::FILE_INFORMATION_CLASS,
    ) -> i32 {
        let mut status_block: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
        unsafe {
            NtSetInformationFile(
                temp.as_raw_handle() as HANDLE,
                &mut status_block,
                buffer.as_ptr().cast(),
                buffer.len() as u32,
                information_class,
            )
        }
    }

    fn classify_rename_status(
        status: i32,
        dir: &File,
        target: &OsStr,
        mode: AtomicFileMode,
        workspace_name: bool,
    ) -> Result<(), Error> {
        if status != 0 {
            if (workspace_name || mode == AtomicFileMode::CreateWorkspaceSidecar)
                && status == windows_sys::Win32::Foundation::STATUS_OBJECT_NAME_COLLISION
            {
                return Err(Error::Conflict(WORKSPACE_FILE_NAME_TAKEN.into()));
            }
            if mode == AtomicFileMode::Create
                && status == windows_sys::Win32::Foundation::STATUS_OBJECT_NAME_COLLISION
            {
                if let Some(actual) = target_stat(dir, target, mode)? {
                    return Err(atomic_create_collision_error(target_regular(&actual)));
                }
            }
            return Err(windows_open_status_error(status));
        }
        Ok(())
    }

    fn delete_temp(temp: &impl std::os::windows::io::AsRawHandle) -> Result<(), Error> {
        #[cfg(test)]
        if CREATED_TEST_CONTROLS.with(|slot| std::mem::take(&mut slot.borrow_mut().cleanup_failure))
        {
            return Err(Error::Io(Box::new(std::io::Error::other(
                "injected created-file disposition failure",
            ))));
        }
        let status = classic_disposition(temp);
        if status != 0 {
            return Err(windows_open_status_error(status));
        }
        Ok(())
    }

    fn classic_disposition(temp: &impl std::os::windows::io::AsRawHandle) -> i32 {
        // FILE_DISPOSITION_INFORMATION is a single BOOLEAN DeleteFile; the struct says that,
        // where a bare [1_u8] left the reader to infer both the layout and the meaning.
        let disposition = FILE_DISPOSITION_INFORMATION { DeleteFile: true };
        let mut status_block: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
        unsafe {
            NtSetInformationFile(
                temp.as_raw_handle() as HANDLE,
                &mut status_block,
                std::ptr::addr_of!(disposition).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFORMATION>() as u32,
                FileDispositionInformation,
            )
        }
    }

    fn map_create_collision(error: Error) -> Error {
        match error {
            Error::Conflict(message) if message == "Windows object name collision" => Error::Io(
                Box::new(std::io::Error::from(std::io::ErrorKind::AlreadyExists)),
            ),
            other => other,
        }
    }

    fn is_reparse_refusal(error: &Error) -> bool {
        matches!(
            error,
            Error::InvalidInput(message) if message == "reparse points cannot be authorized"
        )
    }

    fn child_delete_access(directory: bool) -> u32 {
        if directory {
            DIRECTORY_ACCESS | DELETE
        } else {
            TARGET_ACCESS
        }
    }

    fn directory_open_access(writable: bool) -> u32 {
        if writable {
            DIRECTORY_ACCESS
        } else {
            READ_ONLY_ACCESS
        }
    }

    fn regular_file_access(access: RegularFileAccess) -> u32 {
        match access {
            RegularFileAccess::ReadOnly => READ_ONLY_ACCESS,
            RegularFileAccess::ReadWrite => {
                READ_ONLY_ACCESS | windows_sys::Win32::Foundation::GENERIC_WRITE
            }
        }
    }

    fn type_mismatch(conflict: bool) -> Error {
        if conflict {
            Error::Conflict("workspace entry changed concurrently".into())
        } else {
            Error::InvalidInput("workspace entry has an unexpected file type".into())
        }
    }

    fn opened_is_disk(file: &File) -> bool {
        unsafe { GetFileType(file.as_raw_handle() as HANDLE) == FILE_TYPE_DISK }
    }

    fn open_expected_child(
        parent: &File,
        name: &OsStr,
        directory: bool,
        conflict: bool,
    ) -> Result<File, Error> {
        // `NtCreateFile` takes the expected object kind from `CreateOptions`
        // (`FILE_DIRECTORY_FILE` / `FILE_NON_DIRECTORY_FILE`), never from the access mask, so
        // both kinds are probed with the identical read-only mask.
        match open_windows_child(
            parent,
            name,
            FILE_OPEN,
            READ_ONLY_ACCESS,
            null(),
            directory,
            true,
        ) {
            Ok(file) => {
                if !directory && !opened_is_disk(&file) {
                    return Err(type_mismatch(conflict));
                }
                Ok(file)
            }
            // A directory that was identity-checked at capability issue and is a junction by the
            // time the mutation opens it is a concurrent swap, not a bad argument: callers that
            // asked for the conflict form (`open_verified_parent`, `assert_entry_identity`) get a
            // retryable `Conflict`, matching the unix arm's non-directory leaf mapping. Identity
            // probing keeps the `InvalidInput` form, as unix `entry_identity_at` does for a symlink.
            Err(error) if is_reparse_refusal(&error) => {
                if conflict {
                    Err(type_mismatch(true))
                } else {
                    Err(error)
                }
            }
            // Re-probe with the opposite `CreateOptions` kind: succeeding there means the leaf
            // exists but is the other kind, which is a type mismatch rather than the open error.
            Err(error) => match open_windows_child(
                parent,
                name,
                FILE_OPEN,
                READ_ONLY_ACCESS,
                null(),
                !directory,
                true,
            ) {
                Ok(_) => Err(type_mismatch(conflict)),
                Err(_) => Err(error),
            },
        }
    }

    fn unlink_posix(file: &File) -> Result<(), Error> {
        let disposition = FILE_DISPOSITION_INFORMATION_EX {
            Flags: FILE_DISPOSITION_DELETE
                | FILE_DISPOSITION_POSIX_SEMANTICS
                | FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE,
        };
        let mut status_block: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
        let status = ex_nt_status(|| unsafe {
            NtSetInformationFile(
                file.as_raw_handle() as HANDLE,
                &mut status_block,
                std::ptr::addr_of!(disposition).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFORMATION_EX>() as u32,
                FileDispositionInformationEx,
            )
        });
        #[cfg(test)]
        note_test_ex_status(status);
        let status = if status != 0 && ex_status_is_unsupported(status) {
            classic_nt_status(|| classic_disposition(file))
        } else {
            status
        };
        if status != 0 {
            return Err(windows_open_status_error(status));
        }
        Ok(())
    }

    pub(super) struct EnumeratedEntry {
        pub name: OsString,
        pub identity: (u64, u64),
        /// The one kind enum: the enumerator and the platform-neutral `DirectoryEntry` classify
        /// exactly the same three cases, so there is no second type to keep in step.
        pub kind: DirectoryEntryKind,
        /// Raw `FILE_ID_BOTH_DIR_INFORMATION.LastWriteTime`: a FILETIME, i.e. 100-nanosecond
        /// ticks since 1601-01-01 UTC. Converted by `filetime_to_unix_seconds` before it
        /// reaches a `DirectoryEntry`; the renderer reads that value as Unix seconds.
        pub last_write_time: i64,
    }

    /// Seconds between the FILETIME epoch (1601-01-01) and the Unix epoch (1970-01-01).
    const FILETIME_EPOCH_OFFSET_SECONDS: i64 = 11_644_473_600;
    const FILETIME_TICKS_PER_SECOND: i64 = 10_000_000;

    /// Converts a FILETIME tick count to Unix epoch seconds. A tick count handed to the
    /// renderer unconverted renders as a date centuries in the future, so this is the only
    /// path from `LastWriteTime` into `DirectoryEntry::modified_seconds`. Nothing here can
    /// panic: NT may report any `i64`, including a zero or negative timestamp.
    pub(super) fn filetime_to_unix_seconds(ticks: i64) -> i64 {
        ticks
            .div_euclid(FILETIME_TICKS_PER_SECOND)
            .saturating_sub(FILETIME_EPOCH_OFFSET_SECONDS)
    }

    pub(super) fn filetime_bits_to_unix_seconds(ticks: u64) -> i64 {
        filetime_to_unix_seconds(ticks as i64)
    }

    fn enumerated_kind(attributes: u32) -> DirectoryEntryKind {
        if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            DirectoryEntryKind::Other
        } else if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
            DirectoryEntryKind::Directory
        } else {
            DirectoryEntryKind::RegularFile
        }
    }

    fn nt_query_directory_file(
        dir: &File,
        status_block: &mut IO_STATUS_BLOCK,
        buffer: &mut AlignedBuffer,
        restart_scan: bool,
    ) -> i32 {
        unsafe {
            NtQueryDirectoryFile(
                dir.as_raw_handle() as HANDLE,
                null_mut(),
                None,
                null(),
                status_block,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                FileIdBothDirectoryInformation,
                false,
                null(),
                restart_scan,
            )
        }
    }

    /// Parses one `NtQueryDirectoryFile` page. `AlignedBuffer` carries the alignment required by
    /// the headers, which are read as references to `FILE_ID_BOTH_DIR_INFORMATION`.
    fn parse_directory_page(
        buffer: &AlignedBuffer,
        used: usize,
        volume: u64,
        entries: &mut Vec<EnumeratedEntry>,
        limit: Option<usize>,
    ) -> Result<(), Error> {
        const FILE_NAME_OFFSET: usize =
            std::mem::offset_of!(FILE_ID_BOTH_DIR_INFORMATION, FileName);
        let buffer_ptr = buffer.as_ptr();
        let mut offset = 0usize;
        if used == 0 {
            return Ok(());
        }
        loop {
            if offset
                .checked_add(FILE_NAME_OFFSET)
                .is_none_or(|end| end > used)
            {
                return Err(Error::Io(Box::new(std::io::Error::other(
                    "directory enumeration entry is truncated",
                ))));
            }
            let header =
                unsafe { &*(buffer_ptr.add(offset) as *const FILE_ID_BOTH_DIR_INFORMATION) };
            let name_bytes = header.FileNameLength as usize;
            if !name_bytes.is_multiple_of(2)
                || offset
                    .checked_add(FILE_NAME_OFFSET)
                    .and_then(|start| start.checked_add(name_bytes))
                    .is_none_or(|end| end > used)
            {
                return Err(Error::Io(Box::new(std::io::Error::other(
                    "directory enumeration file name is truncated",
                ))));
            }
            let name_units = name_bytes / 2;
            let name = OsString::from_wide(unsafe {
                std::slice::from_raw_parts(
                    buffer_ptr.add(offset + FILE_NAME_OFFSET).cast::<u16>(),
                    name_units,
                )
            });
            if name != OsStr::new(".") && name != OsStr::new("..") {
                if let Some(limit) = limit {
                    super::check_directory_listing_bound(entries.len(), limit)?;
                }
                entries.push(EnumeratedEntry {
                    name,
                    identity: (volume, header.FileId as u64),
                    kind: enumerated_kind(header.FileAttributes),
                    last_write_time: header.LastWriteTime,
                });
            }
            if header.NextEntryOffset == 0 {
                return Ok(());
            }
            let next = match offset.checked_add(header.NextEntryOffset as usize) {
                Some(next)
                    if next > offset
                        && next <= used
                        && next.is_multiple_of(std::mem::align_of::<
                            FILE_ID_BOTH_DIR_INFORMATION,
                        >()) =>
                {
                    next
                }
                _ => {
                    return Err(Error::Io(Box::new(std::io::Error::other(
                        "directory enumeration next-entry offset is invalid",
                    ))));
                }
            };
            offset = next;
        }
    }

    /// Reads one directory to exhaustion through `NtQueryDirectoryFile`. `cancellation` is
    /// observed once per page, before the kernel is asked for the next one, so a cancelled
    /// listing stops after at most one outstanding page instead of after the whole directory.
    /// User listings pass an entry limit; removal and install sync pass no limit.
    /// This never recurses; the caller owns the depth bound.
    pub(super) fn enumerate_directory(
        dir: &File,
        cancellation: &CancellationToken,
        limit: Option<usize>,
    ) -> Result<Vec<EnumeratedEntry>, Error> {
        let mut entries = Vec::new();
        visit_directory(dir, cancellation, &mut |entry| {
            if let Some(limit) = limit {
                super::check_directory_listing_bound(entries.len(), limit)?;
            }
            entries.push(entry);
            Ok(())
        })?;
        Ok(entries)
    }

    pub(super) fn visit_directory(
        dir: &File,
        cancellation: &CancellationToken,
        visit: &mut dyn FnMut(EnumeratedEntry) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let volume = opened_file_identity(dir)?.0;
        let mut restart_scan = true;
        let mut buffer_len = DIRECTORY_ENUMERATION_START_BYTES;
        let mut overflow_retries = 0_u8;
        loop {
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            // `FILE_ID_BOTH_DIR_INFORMATION` has 8-byte alignment and NT lays every entry out
            // 8-aligned relative to the buffer start, which `AlignedBuffer` guarantees.
            let mut buffer = AlignedBuffer::new::<
                { std::mem::align_of::<FILE_ID_BOTH_DIR_INFORMATION>() },
            >(buffer_len);
            let buffer_bytes = buffer.len();
            let mut status_block: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
            let status = nt_query_directory_file(dir, &mut status_block, &mut buffer, restart_scan);
            if status == STATUS_NO_MORE_FILES {
                break;
            }
            if status == STATUS_BUFFER_OVERFLOW {
                overflow_retries = overflow_retries.saturating_add(1);
                if overflow_retries > DIRECTORY_ENUMERATION_OVERFLOW_RETRIES
                    || buffer_len >= DIRECTORY_ENUMERATION_MAX_BYTES
                {
                    return Err(Error::Io(Box::new(std::io::Error::other(
                        "directory enumeration buffer was exhausted",
                    ))));
                }
                buffer_len = buffer_len
                    .saturating_mul(2)
                    .min(DIRECTORY_ENUMERATION_MAX_BYTES);
                continue;
            }
            if status != 0 {
                return Err(windows_open_status_error(status));
            }
            overflow_retries = 0;
            let used = status_block.Information.min(buffer_bytes);
            let mut page = Vec::new();
            parse_directory_page(&buffer, used, volume, &mut page, None)?;
            for entry in page {
                if cancellation.is_cancelled() {
                    return Err(Error::Cancellation);
                }
                visit(entry)?;
            }
            restart_scan = false;
        }
        Ok(())
    }

    /// One directory read against a retained handle. The NT enumeration itself is
    /// `enumerate_directory`, which recursive removal shares; this only applies `keep`,
    /// observes cancellation between entries, and converts each entry into the
    /// platform-neutral snapshot. The recursive depth bound belongs to the caller.
    pub(super) fn read_directory_entries(
        dir: &File,
        cancellation: &CancellationToken,
        limit: Option<usize>,
        keep: &mut dyn FnMut(&OsStr) -> bool,
    ) -> Result<Vec<DirectoryEntry>, Error> {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let enumerated = enumerate_directory(dir, cancellation, limit)?;
        let mut result = Vec::with_capacity(enumerated.len());
        for entry in enumerated {
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            if !keep(&entry.name) {
                continue;
            }
            result.push(DirectoryEntry {
                name: entry.name,
                // A junction carries FILE_ATTRIBUTE_DIRECTORY as well; `enumerated_kind`
                // reads the reparse bit first, so it arrives here as `Other` and the listing
                // skips it exactly as unix skips a symlink.
                kind: entry.kind,
                // The composed (volume serial, FileId) tuple, not a raw FileId: it has to equal
                // `opened_file_identity` on the same child or every later confirmation fails.
                identity: entry.identity,
                modified_seconds: filetime_to_unix_seconds(entry.last_write_time),
            });
        }
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        Ok(result)
    }

    pub(super) fn open_writable_parent(path: &Path) -> Result<File, Error> {
        open_directory_path(path.parent().unwrap_or_else(|| Path::new(".")), true)
    }

    pub(super) fn open_writable_leaf_directory(parent: &File, name: &OsStr) -> Result<File, Error> {
        open_windows_child(
            parent,
            name,
            FILE_OPEN,
            DIRECTORY_ACCESS,
            null(),
            true,
            true,
        )
    }

    pub(super) fn open_directory_child(
        parent: &File,
        name: &OsStr,
        writable: bool,
    ) -> Result<File, Error> {
        open_windows_child(
            parent,
            name,
            FILE_OPEN,
            directory_open_access(writable),
            null(),
            true,
            true,
        )
    }

    pub(super) fn create_dir_at_committed(
        parent: &File,
        name: &OsStr,
    ) -> Result<AtomicFileOutcome, Error> {
        drop(create_directory_child(parent, name)?);
        Ok(super::parent_sync_as_atomic_outcome(parent))
    }

    pub(super) fn create_directory_child(parent: &File, name: &OsStr) -> Result<File, Error> {
        open_windows_child(
            parent,
            name,
            FILE_CREATE,
            DIRECTORY_ACCESS,
            null(),
            true,
            true,
        )
        .map_err(map_create_collision)
    }

    fn unlink_windows_child_at(
        parent: &File,
        name: &OsStr,
        expected: (u64, u64),
        is_dir: bool,
        access: u32,
        before_unlink: impl FnOnce(&File) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let opened = open_windows_child(parent, name, FILE_OPEN, access, null(), is_dir, true)?;
        if opened_file_identity(&opened)? != expected {
            return Err(Error::Conflict(
                "workspace entry changed concurrently".into(),
            ));
        }
        before_unlink(&opened)?;
        unlink_posix(&opened)
    }

    pub(super) fn remove_empty_directory_at(
        parent: &File,
        name: &OsStr,
        expected: (u64, u64),
    ) -> Result<(), Error> {
        super::single_leaf(name)?;
        assert_entry_identity(parent, name, expected, true)?;
        unlink_windows_child_at(
            parent,
            name,
            expected,
            true,
            child_delete_access(true),
            |opened| {
                if !enumerate_directory(opened, &CancellationToken::new(), None)?.is_empty() {
                    return Err(Error::Conflict("workspace directory is not empty".into()));
                }
                Ok(())
            },
        )?;
        super::sync_parent_after_workspace_removal(parent)
    }

    pub(super) fn entry_observation_at(
        parent: &File,
        name: &OsStr,
        dir: bool,
    ) -> Result<((u64, u64), i64), Error> {
        use std::os::windows::fs::MetadataExt;
        let opened = open_expected_child(parent, name, dir, false)?;
        let identity = opened_file_identity(&opened)?;
        let modified_seconds = filetime_bits_to_unix_seconds(opened.metadata()?.last_write_time());
        Ok((identity, modified_seconds))
    }

    pub(super) fn assert_entry_identity(
        parent: &File,
        name: &OsStr,
        expected: (u64, u64),
        dir: bool,
    ) -> Result<(), Error> {
        let opened = open_expected_child(parent, name, dir, true)?;
        if opened_file_identity(&opened)? != expected {
            return Err(Error::Conflict(
                "workspace entry changed concurrently".into(),
            ));
        }
        Ok(())
    }

    pub(super) fn open_regular_at(
        parent: &File,
        name: &OsStr,
        access: RegularFileAccess,
    ) -> Result<File, Error> {
        let opened = open_windows_child(
            parent,
            name,
            FILE_OPEN,
            regular_file_access(access),
            null(),
            false,
            true,
        )?;
        if !opened_is_disk(&opened) {
            return Err(Error::InvalidInput("target must be a regular file".into()));
        }
        Ok(opened)
    }

    pub(super) fn open_or_create_regular_at(
        parent: &File,
        name: &OsStr,
    ) -> Result<OwnedFile, Error> {
        for _ in 0..OPEN_OR_CREATE_RETRIES {
            #[cfg(test)]
            CREATED_TEST_CONTROLS.with(|slot| {
                if let Some(hook) = slot.borrow_mut().before_existing_open.as_mut() {
                    hook();
                }
            });
            match open_regular_at(parent, name, RegularFileAccess::ReadWrite) {
                Ok(file) => return crate::infra::inode_ownership::own_windows(file),
                Err(error) if error.is_missing_entry() => {}
                Err(error) => return Err(error),
            }
            #[cfg(test)]
            run_created_hook(true);
            match create_regular_at(parent, name) {
                Ok((file, _)) => return Ok(file),
                Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
        Err(Error::Conflict("file kept changing while opening".into()))
    }

    pub(super) fn create_regular_at(
        parent: &File,
        name: &OsStr,
    ) -> Result<(OwnedFile, (u64, u64)), Error> {
        let created = open_windows_child(
            parent,
            name,
            FILE_CREATE,
            regular_file_access(RegularFileAccess::ReadWrite) | DELETE,
            null(),
            false,
            true,
        )
        .map_err(map_create_collision)?;
        let created = admit_created(created, name, CreatedFileMode::Regular)?;
        let identity = created.identity();
        Ok((created, identity))
    }

    enum CreatedFileMode {
        Regular,
        PrivateTemp,
    }

    fn reopen_created_regular(created: &File) -> Result<File, Error> {
        #[cfg(test)]
        if CREATED_TEST_CONTROLS.with(|slot| std::mem::take(&mut slot.borrow_mut().reopen_failure))
        {
            return Err(Error::Conflict(
                "injected created-file reopen failure".into(),
            ));
        }
        // Reopen the held object without a pathname lookup. Share DELETE while its cleanup
        // owner is live, but omit DELETE access so the returned owner permits strict probes.
        // Omitting FILE_FLAG_OVERLAPPED preserves ordinary synchronous reads and writes.
        let handle = unsafe {
            ReOpenFile(
                created.as_raw_handle() as HANDLE,
                regular_file_access(RegularFileAccess::ReadWrite),
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                FILE_FLAG_OPEN_REPARSE_POINT,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: ReOpenFile returned a new owned handle, distinct from the cleanup owner.
        Ok(unsafe { File::from_raw_handle(handle as RawHandle) })
    }

    fn admit_created(
        mut created: File,
        name: &OsStr,
        mode: CreatedFileMode,
    ) -> Result<OwnedFile, Error> {
        let mut cleanup_owner = None;
        let validation = (|| {
            #[cfg(test)]
            run_created_hook(false);
            if let CreatedFileMode::Regular = mode {
                let ordinary = reopen_created_regular(&created)?;
                cleanup_owner = Some(std::mem::replace(&mut created, ordinary));
            }
            if !opened_is_disk(&created) {
                return Err(Error::InvalidInput(
                    "created file must be a regular file".into(),
                ));
            }
            #[cfg(test)]
            created_identity_fault()?;
            let identity = opened_file_identity(&created)?;
            Ok(identity)
        })();
        let (primary, created) = match validation {
            Ok(identity) => {
                match crate::infra::inode_ownership::own_windows_created(created, identity) {
                    Ok(owner) => {
                        // Admission succeeded. Release the DELETE-capable creator before handoff.
                        drop(cleanup_owner);
                        return Ok(owner);
                    }
                    Err(failure) => failure,
                }
            }
            Err(error) => (error, created),
        };
        let created = if let Some(original) = cleanup_owner {
            // Close the secondary handle before disposing the original created object.
            drop(created);
            original
        } else {
            created
        };
        let removal = delete_temp(&created);
        drop(created);
        Err(super::created_leaf_error_after_cleanup(
            primary,
            removal,
            "exclusive create",
            name,
        ))
    }

    #[cfg(test)]
    #[derive(Default)]
    pub(super) struct CreatedTestControls {
        pub(super) reopen_failure: bool,
        pub(super) identity_failure: bool,
        pub(super) cleanup_failure: bool,
        pub(super) after_create: Option<Box<dyn FnOnce()>>,
        pub(super) before_create: Option<Box<dyn FnMut()>>,
        pub(super) before_existing_open: Option<Box<dyn FnMut()>>,
    }
    #[cfg(test)]
    thread_local! {
        pub(super) static CREATED_TEST_CONTROLS: std::cell::RefCell<CreatedTestControls> = std::cell::RefCell::new(CreatedTestControls::default());
    }
    #[cfg(test)]
    fn run_created_hook(before: bool) {
        if before {
            CREATED_TEST_CONTROLS.with(|slot| {
                if let Some(hook) = slot.borrow_mut().before_create.as_mut() {
                    hook();
                }
            });
            return;
        }
        let hook = CREATED_TEST_CONTROLS.with(|slot| slot.borrow_mut().after_create.take());
        if let Some(hook) = hook {
            hook();
        }
    }
    #[cfg(test)]
    fn created_identity_fault() -> Result<(), Error> {
        let fail = CREATED_TEST_CONTROLS
            .with(|slot| std::mem::take(&mut slot.borrow_mut().identity_failure));
        if fail {
            Err(Error::Conflict(
                "injected created-file identity failure".into(),
            ))
        } else {
            Ok(())
        }
    }

    pub(super) fn open_verified_parent(
        path: &Path,
        expected: (u64, u64),
        directory: bool,
        access: ParentAccess,
    ) -> Result<(File, OsString), Error> {
        let writable = match access {
            ParentAccess::Readable => false,
            ParentAccess::Writable => true,
        };
        let parent =
            open_directory_path(path.parent().unwrap_or_else(|| Path::new(".")), writable)?;
        let leaf = path
            .file_name()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| Error::InvalidInput("workspace entry needs a leaf name".into()))?
            .to_os_string();
        let opened = open_expected_child(&parent, &leaf, directory, true)?;
        if opened_file_identity(&opened)? != expected {
            return Err(Error::Conflict(
                "workspace entry changed concurrently".into(),
            ));
        }
        Ok((parent, leaf))
    }

    pub(super) fn open_writable_verified_directory(
        path: &Path,
        expected: (u64, u64),
    ) -> Result<VerifiedDir, Error> {
        let (parent, leaf) = open_verified_parent(path, expected, true, ParentAccess::Writable)?;
        let opened = open_writable_leaf_directory(&parent, &leaf)?;
        VerifiedDir::new(opened, expected)
    }

    pub(super) fn rename_entry_at(
        source_parent: &File,
        source: &OsStr,
        expected: (u64, u64),
        source_is_dir: bool,
        target_parent: &File,
        target: &OsStr,
        workspace_name: bool,
    ) -> Result<AtomicFileOutcome, Error> {
        let distinct_parents =
            opened_file_identity(source_parent)? != opened_file_identity(target_parent)?;
        assert_entry_identity(source_parent, source, expected, source_is_dir)?;
        let mut opened = open_windows_child(
            source_parent,
            source,
            FILE_OPEN,
            child_delete_access(source_is_dir),
            null(),
            source_is_dir,
            true,
        )?;
        if opened_file_identity(&opened)? != expected {
            return Err(Error::Conflict(
                "workspace entry changed concurrently".into(),
            ));
        }
        rename_child_with_mode(
            target_parent,
            &mut opened,
            source,
            target,
            false,
            AtomicFileMode::Replace,
            workspace_name,
        )?;
        Ok(super::sync_rename_parents(
            source_parent,
            target_parent,
            distinct_parents,
        ))
    }

    pub(super) fn rename_optional_regular_at(
        source_parent: &File,
        source: &OsStr,
        target_parent: &File,
        target: &OsStr,
        workspace_name: bool,
    ) -> Result<Option<AtomicFileOutcome>, Error> {
        let mut opened = match open_windows_child(
            source_parent,
            source,
            FILE_OPEN,
            child_delete_access(false),
            null(),
            false,
            true,
        ) {
            Ok(opened) => opened,
            Err(error) if error.is_missing_entry() => return Ok(None),
            Err(error) => return Err(error),
        };
        if !opened_is_disk(&opened) {
            return Err(Error::InvalidInput(
                "workspace sidecar must be a regular file".into(),
            ));
        }
        let distinct_parents =
            opened_file_identity(source_parent)? != opened_file_identity(target_parent)?;
        rename_child_with_mode(
            target_parent,
            &mut opened,
            source,
            target,
            false,
            AtomicFileMode::Replace,
            workspace_name,
        )?;
        Ok(Some(super::sync_rename_parents(
            source_parent,
            target_parent,
            distinct_parents,
        )))
    }

    fn remove_regular_child(
        parent: &File,
        entry: &EnumeratedEntry,
        removed_entries: &mut usize,
    ) -> Result<(), Error> {
        let opened = open_windows_child(
            parent,
            &entry.name,
            FILE_OPEN,
            child_delete_access(false),
            null(),
            false,
            true,
        )?;
        if opened_file_identity(&opened)? != entry.identity {
            return Err(Error::Conflict(
                "directory cleanup entry changed concurrently".into(),
            ));
        }
        if !opened_is_disk(&opened) {
            return Err(Error::InvalidInput(
                "directory cleanup rejects links and special files".into(),
            ));
        }
        unlink_posix(&opened)?;
        *removed_entries += 1;
        Ok(())
    }

    fn remove_windows_tree_at(
        parent: &File,
        name: &OsStr,
        expected: (u64, u64),
        depth: usize,
        parent_volume: u64,
        removed_entries: &mut usize,
    ) -> Result<(), Error> {
        ensure_remove_tree_depth(depth, MAX_REMOVE_TREE_DEPTH)?;
        let child = open_windows_child(
            parent,
            name,
            FILE_OPEN,
            child_delete_access(true),
            null(),
            true,
            true,
        )?;
        let opened_identity = opened_file_identity(&child)?;
        if opened_identity.0 != parent_volume {
            log::warn!("recursive delete stopped at a mount point");
            return Err(Error::InvalidInput(
                "directory cleanup refuses to cross a mount".into(),
            ));
        }
        if opened_identity != expected {
            return Err(Error::Conflict(
                "directory cleanup entry changed concurrently".into(),
            ));
        }
        // B4 scopes cancellation to the single-directory listing read: a half-cancelled
        // recursive unlink would leave a partially removed tree behind, so the removal walk
        // enumerates with a token that is never cancelled.
        for entry in enumerate_directory(&child, &CancellationToken::new(), None)? {
            // Unix checks this at the recursive entry point for both files and directories. A
            // Windows file was previously removed directly from this loop, allowing a file at
            // the boundary depth to evade the shared traversal bound.
            ensure_remove_tree_depth(depth.saturating_add(1), MAX_REMOVE_TREE_DEPTH)?;
            match entry.kind {
                DirectoryEntryKind::Other => {
                    return Err(Error::InvalidInput(
                        "directory cleanup rejects links and special files".into(),
                    ));
                }
                DirectoryEntryKind::RegularFile => {
                    remove_regular_child(&child, &entry, removed_entries)?;
                }
                DirectoryEntryKind::Directory => {
                    remove_windows_tree_at(
                        &child,
                        &entry.name,
                        entry.identity,
                        depth + 1,
                        opened_identity.0,
                        removed_entries,
                    )?;
                }
            }
        }
        unlink_posix(&child)?;
        *removed_entries += 1;
        Ok(())
    }

    /// A directory-entry observation the install driver keeps alive: the retained handle pins the
    /// observed object so its identity cannot be recycled between the observation and the commit.
    /// A non-directory leaf is observed only so the driver can refuse it, so its identity is
    /// carried but never read.
    pub(super) struct WindowsDirEntry {
        _pin: File,
        identity: (u64, u64),
        is_directory: bool,
    }

    /// `NtCreateFile` reports a non-directory at a directory-only leaf as
    /// `STATUS_NOT_A_DIRECTORY`, which the single classifier maps to `ERROR_DIRECTORY`.
    fn not_a_directory(error: &Error) -> bool {
        matches!(
            error,
            Error::Io(error) if error.raw_os_error() == Some(ERROR_DIRECTORY as i32)
        )
    }

    /// Observe one leaf for the install driver. A directory opens with delete access so the
    /// commit can rename it; any other kind opens non-directory just far enough to confirm it is
    /// not a directory, which is what the driver refuses; an absent leaf is `None`. A reparse
    /// point is refused in place, like every other no-follow walk in this module.
    fn directory_entry_at(dir: &File, name: &OsStr) -> Result<Option<WindowsDirEntry>, Error> {
        match open_windows_child(
            dir,
            name,
            FILE_OPEN,
            child_delete_access(true),
            null(),
            true,
            true,
        ) {
            Ok(handle) => {
                if is_reparse_point(&handle.metadata().map_err(io)?) {
                    return Err(Error::InvalidInput(
                        "reparse points cannot be authorized".into(),
                    ));
                }
                Ok(Some(WindowsDirEntry {
                    identity: opened_file_identity(&handle)?,
                    _pin: handle,
                    is_directory: true,
                }))
            }
            Err(error) if error.is_missing_entry() => Ok(None),
            Err(error) if not_a_directory(&error) => {
                let handle =
                    open_windows_child(dir, name, FILE_OPEN, TARGET_ACCESS, null(), false, true)?;
                Ok(Some(WindowsDirEntry {
                    identity: opened_file_identity(&handle)?,
                    _pin: handle,
                    is_directory: false,
                }))
            }
            Err(error) => Err(error),
        }
    }

    /// Durably flush a staged tree before it becomes the live destination. The walk refuses links
    /// and special files and is depth-bounded exactly like the cleanup walk, so a planted reparse
    /// point cannot smuggle in a tree the later cleanup would then have to remove.
    fn sync_windows_tree(dir: &File, depth: usize) -> Result<(), Error> {
        for entry in enumerate_directory(dir, &CancellationToken::new(), None)? {
            ensure_remove_tree_depth(depth.saturating_add(1), MAX_REMOVE_TREE_DEPTH)?;
            match entry.kind {
                DirectoryEntryKind::Other => {
                    return Err(Error::InvalidInput(
                        "directory install rejects links and special files".into(),
                    ));
                }
                DirectoryEntryKind::RegularFile => {
                    let file = open_windows_child(
                        dir,
                        &entry.name,
                        FILE_OPEN,
                        regular_file_access(RegularFileAccess::ReadWrite),
                        null(),
                        false,
                        true,
                    )?;
                    if opened_file_identity(&file)? != entry.identity {
                        return Err(Error::Conflict(
                            "directory install entry changed concurrently".into(),
                        ));
                    }
                    file.sync_all().map_err(io)?;
                }
                DirectoryEntryKind::Directory => {
                    let child = open_windows_child(
                        dir,
                        &entry.name,
                        FILE_OPEN,
                        DIRECTORY_ACCESS,
                        null(),
                        true,
                        true,
                    )?;
                    if opened_file_identity(&child)? != entry.identity {
                        return Err(Error::Conflict(
                            "directory install entry changed concurrently".into(),
                        ));
                    }
                    sync_windows_tree(&child, depth + 1)?;
                    child.sync_all().map_err(io)?;
                }
            }
        }
        dir.sync_all().map_err(io)
    }

    /// Rename the parked old tree back onto the destination name after a failed install rename.
    /// If this itself fails the destination name is still absent — nothing committed — so the
    /// error is a path-free `Conflict`, not `CommittedDurabilityUncertain` (the renderer maps
    /// durability to "applied-despite-error"). The backup leaf is named in the log. Nothing
    /// here reaps `INSTALL_BACKUP_PREFIX` leftovers.
    fn rollback_backup(
        parent: &File,
        backup: &mut File,
        backup_name: &OsStr,
        target_name: &OsStr,
    ) -> Result<(), Error> {
        let incomplete = |error: &Error| {
            log::error!(
                "directory install rollback failed; old tree left at {}: {error}",
                backup_name.to_string_lossy()
            );
            Error::Conflict(
                "directory installation did not complete; the previous tree was not restored"
                    .into(),
            )
        };
        #[cfg(test)]
        if let Err(error) = inject_atomic_dir(AtomicDirFaultPoint::RollbackRename) {
            return Err(incomplete(&error));
        }
        rename_child(parent, backup, backup_name, target_name, false)
            .map_err(|error| incomplete(&error))
    }

    struct WindowsDirInstallAdapter;

    impl DirInstallAdapter for WindowsDirInstallAdapter {
        type Entry = WindowsDirEntry;

        #[cfg(test)]
        fn open_parent(&self, path: &Path) -> Result<File, Error> {
            open_directory_path(path.parent().unwrap_or_else(|| Path::new(".")), true)
        }

        #[cfg(test)]
        fn parent_identity(&self, dir: &File) -> Result<(u64, u64), Error> {
            opened_file_identity(dir)
        }

        fn target_stat(&self, dir: &File, name: &OsStr) -> Result<Option<Self::Entry>, Error> {
            directory_entry_at(dir, name)
        }

        fn is_directory(&self, entry: &Self::Entry) -> bool {
            entry.is_directory
        }

        fn entry_identity(&self, entry: &Self::Entry) -> (u64, u64) {
            entry.identity
        }

        fn open_source_directory(&self, parent: &File, name: &OsStr) -> Result<File, Error> {
            open_windows_child(
                parent,
                name,
                FILE_OPEN,
                DIRECTORY_ACCESS,
                null(),
                true,
                true,
            )
        }

        fn flush_tree(&self, dir: &File) -> Result<(), Error> {
            sync_windows_tree(dir, 0)
        }

        fn commit(
            &self,
            parent: &File,
            source_name: &OsStr,
            target_name: &OsStr,
            source: &mut Self::Entry,
            original: Option<&Self::Entry>,
        ) -> Result<Option<OsString>, Error> {
            #[cfg(test)]
            inject_atomic_dir(AtomicDirFaultPoint::CommitEntry)?;
            let Some(original) = original else {
                // No existing target: one no-replace rename suffices, so there is nothing to
                // roll back and nothing for the caller to clean up.
                #[cfg(test)]
                inject_atomic_dir(AtomicDirFaultPoint::InstallRename)?;
                rename_child(parent, &mut source._pin, source_name, target_name, false)?;
                return Ok(None);
            };
            let backup_name: OsString =
                format!("{INSTALL_BACKUP_PREFIX}{}", uuid::Uuid::new_v4()).into();
            let mut target = open_windows_child(
                parent,
                target_name,
                FILE_OPEN,
                child_delete_access(true),
                null(),
                true,
                true,
            )?;
            if opened_file_identity(&target)? != original.identity {
                return Err(Error::Conflict(
                    "directory target changed concurrently".into(),
                ));
            }
            // Windows has no directory `EXCHANGE` (d-20260918-10): the live target is parked at a
            // `{INSTALL_BACKUP_PREFIX}` sibling, the staged tree takes the name with no replace,
            // and a failed install rename moves the parked tree back.
            rename_child(parent, &mut target, target_name, &backup_name, false)?;
            #[cfg(test)]
            if let Err(error) = inject_atomic_dir(AtomicDirFaultPoint::BackupRename) {
                rollback_backup(parent, &mut target, &backup_name, target_name)?;
                return Err(error);
            }
            #[cfg(test)]
            if let Err(error) = inject_atomic_dir(AtomicDirFaultPoint::InstallRename) {
                rollback_backup(parent, &mut target, &backup_name, target_name)?;
                return Err(error);
            }
            match rename_child(parent, &mut source._pin, source_name, target_name, false) {
                Ok(()) => Ok(Some(backup_name)),
                Err(install_error) => {
                    rollback_backup(parent, &mut target, &backup_name, target_name)?;
                    Err(install_error)
                }
            }
        }

        fn cleanup_displaced(
            &self,
            parent: &File,
            name: &OsStr,
            expected: &Self::Entry,
        ) -> Result<(), Error> {
            let parent_volume = opened_file_identity(parent)?.0;
            let mut removed_entries = 0;
            remove_windows_tree_at(
                parent,
                name,
                expected.identity,
                0,
                parent_volume,
                &mut removed_entries,
            )
        }
    }

    #[cfg(test)]
    pub(super) fn install_dir(source: &Path, target: &Path) -> Result<(), Error> {
        install_dir_driver(&WindowsDirInstallAdapter, source, target)
    }

    pub(super) fn install_dir_at(
        parent: &File,
        source_name: &OsStr,
        expected_source: (u64, u64),
        target_name: &OsStr,
        policy: DirectoryInstallPolicy,
        committed: &mut bool,
    ) -> Result<(), Error> {
        install_dir_at_driver(
            &WindowsDirInstallAdapter,
            DirectoryInstall {
                parent,
                source_name,
                expected_source: Some(expected_source),
                target_name,
                policy,
            },
            &|| Ok(()),
            committed,
        )
    }

    pub(super) fn remove_entry_at_counted(
        parent: &File,
        name: &OsStr,
        expected: (u64, u64),
        is_dir: bool,
    ) -> Result<crate::error::CommittedRemoval, Error> {
        assert_entry_identity(parent, name, expected, is_dir)?;
        let mut removed_entries = 0;
        if is_dir {
            let parent_volume = opened_file_identity(parent)?.0;
            if let Err(cause) = remove_windows_tree_at(
                parent,
                name,
                expected,
                0,
                parent_volume,
                &mut removed_entries,
            ) {
                return if removed_entries == 0 {
                    Err(cause)
                } else {
                    Err(Error::PartialRemoval {
                        removed_entries,
                        cause: Box::new(cause),
                    })
                };
            }
        } else {
            unlink_windows_child_at(
                parent,
                name,
                expected,
                false,
                child_delete_access(false),
                |_| Ok(()),
            )?;
            removed_entries = 1;
        }
        Ok(crate::error::CommittedRemoval::new(
            removed_entries,
            super::sync_parent_after_workspace_removal(parent).err(),
        ))
    }

    pub(super) fn remove_optional_regular_at(parent: &File, name: &OsStr) -> Result<(), Error> {
        let opened = match open_windows_child(
            parent,
            name,
            FILE_OPEN,
            child_delete_access(false),
            null(),
            false,
            true,
        ) {
            Ok(opened) => opened,
            Err(error) if error.is_missing_entry() => return Ok(()),
            Err(error) => return Err(error),
        };
        if !opened_is_disk(&opened) {
            return Err(Error::InvalidInput(
                "workspace sidecar must be a regular file".into(),
            ));
        }
        unlink_posix(&opened)
    }

    fn cleanup(temp: &mut OwnedFile, temp_name: &OsStr, primary: Error) -> Error {
        #[cfg(test)]
        let injected = inject_atomic_file(AtomicFileFaultPoint::Cleanup).err();
        #[cfg(not(test))]
        let injected: Option<Error> = None;
        let removal = injected.or_else(|| delete_temp(temp).err());
        match removal {
            None => primary,
            Some(cleanup) => operation_and_cleanup_error(temp_name, primary, cleanup),
        }
    }

    fn metadata(temp: &OwnedFile) -> Result<TempMetadata, std::io::Error> {
        use std::os::windows::fs::MetadataExt;
        let identity = opened_file_identity(temp).map_err(as_io)?;
        let stamp = temp.metadata()?.last_write_time();
        record_durability("temp.metadata");
        Ok(TempMetadata {
            identity,
            ctime_nanos: i128::from(stamp),
            modified_seconds: filetime_bits_to_unix_seconds(stamp),
        })
    }

    #[cfg(test)]
    pub(super) fn test_security_descriptor(
        file: &impl crate::infra::inode_ownership::NativeFile,
    ) -> Result<Vec<u8>, Error> {
        let descriptor = capture_security_descriptor(file)?;
        Ok(unsafe { std::slice::from_raw_parts(descriptor.as_ptr(), descriptor.len()).to_vec() })
    }

    #[cfg(test)]
    fn get_security_descriptor_dacl(
        descriptor: &AlignedBuffer,
        dacl_present: &mut windows_sys::core::BOOL,
        dacl: &mut *mut ACL,
        dacl_defaulted: &mut windows_sys::core::BOOL,
    ) -> windows_sys::core::BOOL {
        unsafe {
            GetSecurityDescriptorDacl(
                descriptor.as_ptr().cast_mut().cast(),
                dacl_present,
                dacl,
                dacl_defaulted,
            )
        }
    }

    #[cfg(test)]
    fn get_security_descriptor_control(
        descriptor: &AlignedBuffer,
        control: &mut u16,
        revision: &mut u32,
    ) -> windows_sys::core::BOOL {
        unsafe {
            GetSecurityDescriptorControl(descriptor.as_ptr().cast_mut().cast(), control, revision)
        }
    }

    fn get_aligned_acl_ace(acl: &mut AlignedBuffer) -> Result<*mut std::ffi::c_void, Error> {
        let mut ace: *mut std::ffi::c_void = null_mut();
        if unsafe { GetAce(acl.as_mut_ptr().cast(), 0, &mut ace) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if ace.is_null() {
            return Err(std::io::Error::other("ACL has no ACE").into());
        }
        Ok(ace)
    }

    fn set_acl_ace_flags(acl: &mut AlignedBuffer, flags: u8) -> Result<(), Error> {
        if flags == 0 {
            return Ok(());
        }
        let ace = get_aligned_acl_ace(acl)?;
        unsafe {
            (*(ace as *mut windows_sys::Win32::Security::ACCESS_ALLOWED_ACE))
                .Header
                .AceFlags = flags;
        }
        Ok(())
    }

    /// The oracle the DACL assertion compares against. It deliberately goes around
    /// `process_user_sid`'s `OnceLock` rather than reading it, so a wrong cache, a wrong lifetime
    /// or a wrong hand-off between the cache and the ACE is caught; a byte-for-byte copy of the
    /// derivation would add no independence over this and would be a second copy of one concept.
    /// What neither form can catch is a defect *inside* the derivation itself — that is what the
    /// by-name refusal of the well-known wide SIDs below is for.
    #[cfg(test)]
    fn test_process_user_sid() -> Result<Vec<u8>, Error> {
        process_user_sid_uncached()
    }

    #[cfg(test)]
    fn test_well_known_sid(
        sid_type: windows_sys::Win32::Security::WELL_KNOWN_SID_TYPE,
    ) -> Result<Vec<u8>, Error> {
        let mut sid = vec![0_u8; windows_sys::Win32::Security::SECURITY_MAX_SID_SIZE as usize];
        let mut sid_length = sid.len() as u32;
        if unsafe {
            CreateWellKnownSid(
                sid_type,
                null_mut(),
                sid.as_mut_ptr() as PSID,
                &mut sid_length,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        sid.truncate(sid_length as usize);
        Ok(sid)
    }

    #[cfg(test)]
    pub(super) fn test_security_descriptor_is_creator_only(
        file: &impl crate::infra::inode_ownership::NativeFile,
    ) -> Result<bool, Error> {
        let descriptor = capture_security_descriptor(file)?;
        let mut control = 0_u16;
        let mut revision = 0_u32;
        if get_security_descriptor_control(&descriptor, &mut control, &mut revision) == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if control & SE_DACL_PROTECTED == 0 {
            return Ok(false);
        }
        let mut dacl_present = 0;
        let mut dacl: *mut ACL = null_mut();
        let mut dacl_defaulted = 0;
        let mut ace: *mut std::ffi::c_void = null_mut();
        if get_security_descriptor_dacl(
            &descriptor,
            &mut dacl_present,
            &mut dacl,
            &mut dacl_defaulted,
        ) == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        if dacl_present == 0 || dacl.is_null() || unsafe { (*dacl).AceCount } != 1 {
            return Ok(false);
        }
        if unsafe { GetAce(dacl, 0, &mut ace) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if ace.is_null() {
            return Ok(false);
        }
        let ace_header = unsafe { &*(ace as *const windows_sys::Win32::Security::ACE_HEADER) };
        if u32::from(ace_header.AceType) != ACCESS_ALLOWED_ACE_TYPE {
            return Ok(false);
        }
        let ace = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
        let ace_sid = &ace.SidStart as *const u32 as *mut std::ffi::c_void;
        let expected_sid = test_process_user_sid()?;
        if ace.Mask != FILE_ALL_ACCESS
            || unsafe { EqualSid(ace_sid, expected_sid.as_ptr() as PSID) } == 0
        {
            return Ok(false);
        }
        for (name, sid_type) in [
            ("CREATOR OWNER", WinCreatorOwnerSid),
            ("World", WinWorldSid),
            ("Authenticated Users", WinAuthenticatedUserSid),
            ("Builtin Administrators", WinBuiltinAdministratorsSid),
        ] {
            let sid = test_well_known_sid(sid_type)?;
            if unsafe { EqualSid(ace_sid, sid.as_ptr() as PSID) } != 0 {
                return Err(std::io::Error::other(format!(
                    "private DACL unexpectedly grants {name}"
                ))
                .into());
            }
        }
        Ok(true)
    }

    #[cfg(test)]
    pub(super) fn set_test_parent_inheritable_dacl(parent: &File) -> Result<(), Error> {
        let descriptor = PrivateSecurityDescriptor::new_with_options(
            FILE_ALL_ACCESS,
            (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8,
            false,
        )?;
        set_kernel_object_security(parent, &descriptor.descriptor)
    }

    #[cfg(test)]
    fn open_test_security_target(path: &Path) -> Result<File, Error> {
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .access_mode(
                windows_sys::Win32::Foundation::GENERIC_READ
                    | windows_sys::Win32::Foundation::GENERIC_WRITE
                    | READ_CONTROL
                    | WRITE_DAC,
            )
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
        options.open(path).map_err(io)
    }

    #[cfg(test)]
    fn apply_test_target_security(file: &File, access: u32) -> Result<(), Error> {
        let descriptor = PrivateSecurityDescriptor::new(access)?;
        set_kernel_object_security(file, &descriptor.descriptor)
    }

    #[cfg(test)]
    pub(super) fn set_test_target_security_descriptor(
        path: &Path,
        access: u32,
    ) -> Result<(), Error> {
        apply_test_target_security(&open_test_security_target(path)?, access)
    }

    /// Holds WRITE_DAC before restricting access so restoration never needs to reopen the target.
    #[cfg(test)]
    pub(crate) struct TestTargetSecurityGuard {
        file: File,
        original: Option<AlignedBuffer>,
    }

    #[cfg(test)]
    impl TestTargetSecurityGuard {
        pub(crate) fn restrict(path: &Path, access: u32) -> Result<Self, Error> {
            let file = open_test_security_target(path)?;
            let original = Some(capture_security_descriptor(&file)?);
            let guard = Self { file, original };
            apply_test_target_security(&guard.file, access)?;
            Ok(guard)
        }

        pub(crate) fn restore(&mut self) -> Result<(), Error> {
            if let Some(original) = &self.original {
                set_kernel_object_security(&self.file, original)?;
                self.original = None;
            }
            Ok(())
        }
    }

    #[cfg(test)]
    impl Drop for TestTargetSecurityGuard {
        fn drop(&mut self) {
            let _ = self.restore();
        }
    }

    impl AtomicReplaceAdapter for WindowsAdapter {
        type Target = Target;

        fn target_stat(
            &self,
            dir: &File,
            target: &OsStr,
            mode: AtomicFileMode,
        ) -> Result<Option<Self::Target>, Error> {
            target_stat(dir, target, mode)
        }

        fn is_regular(&self, target: &Self::Target) -> bool {
            target_regular(target)
        }

        fn target_identity(&self, target: &Self::Target) -> (u64, u64) {
            target.identity
        }

        fn create_temp(
            &self,
            dir: &File,
            original: Option<&Self::Target>,
        ) -> Result<(OsString, OwnedFile), Error> {
            create_temp(dir, original)
        }

        fn before_write(
            &self,
            _dir: &File,
            temp: &OwnedFile,
            original: Option<&Self::Target>,
        ) -> Result<(), Error> {
            let Some(original) = original else {
                return Ok(());
            };
            #[cfg(test)]
            inject_atomic_file(AtomicFileFaultPoint::DaclCapture)?;
            let descriptor = capture_security_descriptor(&original.handle)?;
            #[cfg(test)]
            inject_atomic_file(AtomicFileFaultPoint::DaclApply)?;
            set_kernel_object_security(temp, &descriptor)
        }

        fn finalize_metadata(
            &self,
            _temp: &mut OwnedFile,
            _original: Option<&Self::Target>,
        ) -> Result<(), Error> {
            Ok(())
        }

        fn rename(
            &self,
            dir: &File,
            temp: &mut OwnedFile,
            temp_name: &OsStr,
            target: &OsStr,
            replace: bool,
            mode: AtomicFileMode,
        ) -> Result<RenameOutcome, Error> {
            rename_child_with_mode(dir, temp, temp_name, target, replace, mode, false)
        }

        fn rename_classic(
            &self,
            dir: &File,
            temp: &mut OwnedFile,
            _temp_name: &OsStr,
            target: &OsStr,
            mode: AtomicFileMode,
        ) -> Result<(), Error> {
            super::single_leaf(target)?;
            let buffer = classic_rename_information_buffer(dir, target, true);
            let status =
                classic_nt_status(|| set_rename_information(temp, &buffer, FileRenameInformation));
            classify_rename_status(status, dir, target, mode, false)
        }

        fn metadata(&self, temp: &OwnedFile) -> Result<TempMetadata, std::io::Error> {
            metadata(temp)
        }

        fn cleanup(
            &self,
            _dir: &File,
            temp_name: &OsStr,
            temp: &mut OwnedFile,
            primary: Error,
        ) -> Error {
            cleanup(temp, temp_name, primary)
        }
    }

    pub(super) fn open_directory_path(path: &Path, writable: bool) -> Result<File, Error> {
        let mut base = PathBuf::new();
        let mut components = path.components().peekable();
        if path.is_absolute() {
            while let Some(component) = components.peek().copied() {
                match component {
                    Component::Prefix(_) | Component::RootDir => {
                        base.push(component.as_os_str());
                        components.next();
                    }
                    _ => break,
                }
            }
        } else {
            base.push(".");
            while matches!(components.peek(), Some(Component::CurDir)) {
                components.next();
            }
        }
        let base_is_final = components.peek().is_none();
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(writable && base_is_final)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
        let mut dir = options.open(&base).map_err(io)?;
        // FILE_FLAG_OPEN_REPARSE_POINT yields a handle to the link itself instead of following
        // it, but opening a reparse point is not the same as refusing one. open_windows_nofollow
        // refuses it at exactly this step; without the same refusal here a reparse point planted
        // at the base prefix is traversed rather than rejected.
        if is_reparse_point(&dir.metadata().map_err(io)?) {
            return Err(Error::InvalidInput(
                "reparse points cannot be authorized".into(),
            ));
        }
        // DIRECTORY_ACCESS carries GENERIC_WRITE, so a read-only walk must not use it for the
        // intermediate components: demanding write on every ancestor fails under a directory the
        // caller may only read. Only the LAST component is the directory the caller writes into,
        // and the decision is therefore per component -- computing it once before the loop makes
        // every component read-only as soon as the path has any, which denies the final parent the
        // write access its `sync_all` needs. The base open uses the same two-predicate split;
        // this is the same policy as resolve_windows in path_authority/resolved.rs.
        while let Some(component) = components.next() {
            let Component::Normal(name) = component else {
                return Err(Error::InvalidInput(
                    "parent path may not contain traversal components".into(),
                ));
            };
            let last = components.peek().is_none();
            let child_access = if writable && last {
                DIRECTORY_ACCESS
            } else {
                READ_ONLY_ACCESS
            };
            dir = open_windows_child(&dir, name, FILE_OPEN, child_access, null(), true, true)?;
        }
        Ok(dir)
    }

    pub(super) fn replace<F, P>(
        target: &Path,
        precommit: P,
        write_fn: F,
    ) -> Result<AtomicInstalledFile, Error>
    where
        F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
        P: FnOnce() -> Result<(), Error>,
    {
        #[cfg(test)]
        inject_atomic_file(AtomicFileFaultPoint::ParentOpen)?;
        let logical_parent = target.parent().unwrap_or_else(|| Path::new("."));
        let dir = open_directory_path(logical_parent, true)?;
        let parent_identity = opened_file_identity(&dir)?;
        let target_name = target
            .file_name()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| Error::InvalidInput("target must name a file".into()))?
            .to_os_string();
        replace_at_driver(
            WindowsAdapter,
            dir,
            target_name,
            AtomicFileMode::Replace,
            move || {
                let current = open_directory_path(logical_parent, false)?;
                let current_identity = opened_file_identity(&current)?;
                #[cfg(test)]
                let current_identity = current_test_atomic_file_injector()
                    .map(|injector| injector.parent_revalidation_identity(current_identity))
                    .unwrap_or(current_identity);
                if current_identity != parent_identity {
                    return Err(Error::Conflict(
                        "parent directory changed concurrently".into(),
                    ));
                }
                precommit()
            },
            write_fn,
        )
    }

    pub(super) fn replace_at<F, P>(
        dir: File,
        target_name: OsString,
        mode: AtomicFileMode,
        precommit: P,
        write_fn: F,
    ) -> Result<AtomicInstalledFile, Error>
    where
        F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
        P: FnOnce() -> Result<(), Error>,
    {
        replace_at_driver(WindowsAdapter, dir, target_name, mode, precommit, write_fn)
    }
}

#[cfg(all(test, unix))]
pub(crate) use unix::scoped_test_removal_injector;
#[cfg(all(test, unix))]
pub(crate) use unix::{
    current_test_removal_injector, set_test_removal_injector, RemovalFault, RemovalFaultPoint,
    RemovalInjector,
};
#[cfg(unix)]
pub(crate) use unix::{
    raw_libc_stat_identity, raw_mode_from, raw_stat_identity, MAX_REMOVE_TREE_DEPTH,
};
#[cfg(all(test, windows))]
pub(crate) use win::TestTargetSecurityGuard;
#[cfg(windows)]
pub(crate) use win::MAX_REMOVE_TREE_DEPTH;

pub fn atomic_replace_with_precommit<F, P>(
    target: &Path,
    precommit: P,
    write_fn: F,
) -> Result<AtomicFileOutcome, Error>
where
    F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
    P: FnOnce() -> Result<(), Error>,
{
    #[cfg(unix)]
    {
        unix::replace(target, precommit, write_fn).map(|installed| installed.outcome)
    }
    #[cfg(windows)]
    {
        win::replace(target, precommit, write_fn).map(|installed| installed.outcome)
    }
}
pub fn atomic_replace<F>(target: &Path, write_fn: F) -> Result<AtomicFileOutcome, Error>
where
    F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
{
    atomic_replace_with_precommit(target, || Ok(()), write_fn)
}

/// Replaces `target` with `contents` only when the bytes on disk differ. The Specta binding
/// export runs on every debug start and inside `pnpm bindings:check`; an unconditional rewrite
/// gives the tracked file a new mtime, which refuses any gate receipt measured beside it
/// (`f-20260906-06`). An uncertain commit is an error that says the file may already be
/// replaced: the caller is a check that must not pass on an uncertain write.
/// Rebuilt durability errors preserve missing-entry classification and other I/O kinds.
#[cfg(any(debug_assertions, test))]
pub(crate) fn write_if_changed(target: &Path, contents: &str) -> Result<(), Error> {
    match std::fs::read(target) {
        Ok(existing) if existing == contents.as_bytes() => return Ok(()),
        Ok(_) => {}
        Err(error) if crate::error::is_missing_entry_io(&error) => {}
        Err(error) => return Err(error.into()),
    }
    match atomic_replace(target, |file| {
        file.write_all(contents.as_bytes()).map_err(Error::from)
    })? {
        AtomicFileOutcome::DurableCommit => Ok(()),
        AtomicFileOutcome::CommittedDurabilityUncertain(error) => {
            Err(crate::error::sanitized_io_error(
                &error,
                format!("replaced, but durability is uncertain: {error}"),
            )
            .into())
        }
    }
}

pub(crate) fn single_leaf(leaf: &OsStr) -> Result<(), Error> {
    if cfg!(windows) {
        if let Some(reason) = crate::infra::path_authority::windows_component_refusal(leaf) {
            return Err(Error::InvalidInput(reason.into()));
        }
    }
    if leaf.is_empty() || Path::new(leaf).file_name() != Some(leaf) {
        return Err(Error::InvalidInput(
            "leaf name must be one component".into(),
        ));
    }
    Ok(())
}

/// One-shot native save-dialog destination: the no-follow parent descriptor opened when the
/// dialog choice arrived, plus its single-component leaf. No pathname is retained for the write,
/// so a later swap of the parent spelling cannot redirect it.
#[derive(Debug)]
pub(crate) struct NativeExportDest {
    parent: File,
    leaf: OsString,
}

impl NativeExportDest {
    /// Checks the extension before opening anything, then pins the parent without following a
    /// final link.
    pub(crate) fn from_save_path(
        path: std::path::PathBuf,
        expected_extension: &str,
    ) -> Result<Self, Error> {
        if path.extension().and_then(|value| value.to_str()) != Some(expected_extension) {
            return Err(Error::InvalidInput(format!(
                "export must use .{expected_extension} extension"
            )));
        }
        let leaf = path
            .file_name()
            .ok_or_else(|| Error::InvalidInput("leaf name must be one component".into()))?
            .to_os_string();
        single_leaf(&leaf)?;
        let parent = open_parent_no_follow(&path)?;
        Ok(Self { parent, leaf })
    }

    pub(crate) fn replace<F>(&self, write_fn: F) -> Result<AtomicFileOutcome, Error>
    where
        F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
    {
        atomic_replace_at(&self.parent, &self.leaf, write_fn)
    }
}

/// Replaces one leaf below a directory descriptor the caller already opened (authority-validated,
/// or a one-shot native-dialog parent). No mutable parent pathname is reopened between that open
/// and the final `renameat`.
pub fn atomic_replace_at<F>(
    parent: &File,
    leaf: &OsStr,
    write_fn: F,
) -> Result<AtomicFileOutcome, Error>
where
    F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
{
    atomic_replace_at_with_precommit(parent, leaf, || Ok(()), write_fn)
}

/// Mutating workspace primitives.  Each one accepts an already-opened parent directory and
/// performs the final lookup relative to that descriptor with `NOFOLLOW`.  `expected`, when
/// supplied, is checked immediately before the namespace mutation; it is the identity captured
/// by the path authority when the opaque workspace capability was issued.
#[cfg(windows)]
pub(crate) fn open_verified_parent(
    path: &Path,
    expected: (u64, u64),
    directory: bool,
    access: ParentAccess,
) -> Result<(File, std::ffi::OsString), Error> {
    win::open_verified_parent(path, expected, directory, access)
}

#[cfg(unix)]
pub(crate) fn open_verified_parent(
    path: &Path,
    expected: (u64, u64),
    directory: bool,
    _access: ParentAccess,
) -> Result<(File, std::ffi::OsString), Error> {
    use rustix::fs::{self as rfs, AtFlags, FileType, Mode, OFlags};
    use std::os::unix::ffi::OsStrExt;
    let parent = open_parent_no_follow(path)?;
    let leaf = path
        .file_name()
        .filter(|name| !name.as_bytes().is_empty())
        .ok_or_else(|| Error::InvalidInput("workspace entry needs a leaf name".into()))?
        .to_os_string();
    let stat = rfs::statat(&parent, &leaf, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| Error::Io(Box::new(error.into())))?;
    let kind = FileType::from_raw_mode(stat.st_mode);
    if unix::raw_stat_identity(&stat) != expected
        || (directory && kind != FileType::Directory)
        || (!directory && kind != FileType::RegularFile)
    {
        return Err(Error::Conflict(
            "workspace entry changed concurrently".into(),
        ));
    }
    // Opening a directory here pins the destination parent before its children are mutated.
    if directory {
        let opened = File::from(
            rfs::openat(
                &parent,
                &leaf,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|error| Error::Io(Box::new(error.into())))?,
        );
        if unix::raw_stat_identity(
            &rfs::fstat(&opened).map_err(|error| Error::Io(Box::new(error.into())))?,
        ) != expected
        {
            return Err(Error::Conflict(
                "workspace directory changed concurrently".into(),
            ));
        }
    }
    Ok((parent, leaf))
}

#[cfg(unix)]
pub(crate) fn open_parent_no_follow(path: &Path) -> Result<File, Error> {
    unix::open_parent(path)
}

#[cfg(windows)]
pub(crate) fn open_parent_no_follow(path: &Path) -> Result<File, Error> {
    win::open_writable_parent(path)
}

#[cfg(unix)]
pub(crate) fn open_verified_directory(
    path: &Path,
    expected: (u64, u64),
) -> Result<VerifiedDir, Error> {
    use rustix::fs::{self as rfs, Mode, OFlags};
    let (parent, leaf) = open_verified_parent(path, expected, true, ParentAccess::Writable)?;
    let opened = File::from(
        rfs::openat(
            &parent,
            &leaf,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| Error::Io(Box::new(error.into())))?,
    );
    VerifiedDir::new(opened, expected)
}

#[cfg(windows)]
pub(crate) fn open_verified_directory(
    path: &Path,
    expected: (u64, u64),
) -> Result<VerifiedDir, Error> {
    win::open_writable_verified_directory(path, expected)
}

#[cfg(unix)]
pub(crate) fn assert_entry_identity(
    parent: &File,
    name: &OsStr,
    expected: (u64, u64),
    dir: bool,
) -> Result<(), Error> {
    use rustix::fs::{self as rfs, AtFlags, FileType};
    let stat = rfs::statat(parent, name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| Error::Io(Box::new(error.into())))?;
    let kind = FileType::from_raw_mode(stat.st_mode);
    if unix::raw_stat_identity(&stat) != expected
        || (dir && kind != FileType::Directory)
        || (!dir && kind != FileType::RegularFile)
    {
        return Err(Error::Conflict(
            "workspace entry changed concurrently".into(),
        ));
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn assert_entry_identity(
    parent: &File,
    name: &OsStr,
    expected: (u64, u64),
    dir: bool,
) -> Result<(), Error> {
    win::assert_entry_identity(parent, name, expected, dir)
}

#[cfg(unix)]
pub(crate) fn entry_observation_at(
    parent: &File,
    name: &OsStr,
    dir: bool,
) -> Result<((u64, u64), i64), Error> {
    #[cfg(test)]
    take_entry_observation_fault()?;
    use rustix::fs::{self as rfs, AtFlags, FileType};
    let stat = rfs::statat(parent, name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| Error::Io(Box::new(error.into())))?;
    #[cfg(all(test, unix))]
    ENTRY_OBSERVATION_POST_STAT_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
    let kind = FileType::from_raw_mode(stat.st_mode);
    if (dir && kind != FileType::Directory) || (!dir && kind != FileType::RegularFile) {
        return Err(Error::InvalidInput(
            "workspace entry has an unexpected file type".into(),
        ));
    }
    Ok((unix::raw_stat_identity(&stat), stat.st_mtime))
}

#[cfg(windows)]
pub(crate) fn entry_observation_at(
    parent: &File,
    name: &OsStr,
    dir: bool,
) -> Result<((u64, u64), i64), Error> {
    #[cfg(test)]
    take_entry_observation_fault()?;
    win::entry_observation_at(parent, name, dir)
}

#[cfg(any(unix, windows))]
pub(crate) fn entry_identity_at(
    parent: &File,
    name: &OsStr,
    dir: bool,
) -> Result<(u64, u64), Error> {
    entry_observation_at(parent, name, dir).map(|(identity, _)| identity)
}

#[cfg(all(test, unix))]
std::thread_local! {
    static ENTRY_OBSERVATION_POST_STAT_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(all(test, unix))]
pub(crate) fn set_entry_observation_post_stat_hook(hook: Option<Box<dyn FnOnce()>>) {
    ENTRY_OBSERVATION_POST_STAT_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(test)]
std::thread_local! {
    static ENTRY_OBSERVATION_FAULT: std::cell::RefCell<Option<Error>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_entry_observation_fault(error: Option<Error>) {
    ENTRY_OBSERVATION_FAULT.with(|slot| *slot.borrow_mut() = error);
}

#[cfg(test)]
fn take_entry_observation_fault() -> Result<(), Error> {
    match ENTRY_OBSERVATION_FAULT.with(|slot| slot.borrow_mut().take()) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn parent_sync_as_atomic_outcome(parent: &File) -> AtomicFileOutcome {
    #[cfg(test)]
    let sync_result = match inject_atomic_file(AtomicFileFaultPoint::ParentSync) {
        Ok(()) => parent.sync_all(),
        Err(Error::Io(error)) => Err(*error),
        Err(_) => unreachable!("atomic file injectors only produce I/O errors"),
    };
    #[cfg(not(test))]
    let sync_result = parent.sync_all();
    match sync_result {
        Ok(()) => AtomicFileOutcome::DurableCommit,
        Err(error) => AtomicFileOutcome::CommittedDurabilityUncertain(error),
    }
}

/// Exclusive create-then-parent-sync. A successful create whose parent sync fails is a
/// committed-uncertain outcome; a failed create is an ordinary error.
#[must_use = "the directory may exist without a durable parent; decide what CommittedDurabilityUncertain means at this site"]
pub(crate) fn create_dir_at_committed(
    parent: &File,
    name: &OsStr,
) -> Result<AtomicFileOutcome, Error> {
    single_leaf(name)?;
    #[cfg(unix)]
    {
        use rustix::fs::{self as rfs, Mode};
        rfs::mkdirat(parent, name, Mode::from_raw_mode(0o700))
            .map_err(|error| Error::Io(Box::new(error.into())))?;
        Ok(parent_sync_as_atomic_outcome(parent))
    }
    #[cfg(windows)]
    {
        win::create_dir_at_committed(parent, name)
    }
}

pub(crate) fn create_dir_at(parent: &File, name: &OsStr) -> Result<(), Error> {
    match create_dir_at_committed(parent, name) {
        Ok(AtomicFileOutcome::DurableCommit) => Ok(()),
        Ok(AtomicFileOutcome::CommittedDurabilityUncertain(error)) => {
            Err(Error::Io(Box::new(error)))
        }
        Err(error) => Err(error),
    }
}

#[cfg(all(test, unix))]
std::thread_local! {
    static ENSURE_DIRECTORY_PRE_CREATE_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static ENSURE_DIRECTORY_POST_COLLISION_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

/// Runs once, immediately before the next [`ensure_directory_at`] issues its exclusive create.
#[cfg(all(test, unix))]
pub(crate) fn set_ensure_directory_pre_create_hook(hook: Option<Box<dyn FnOnce()>>) {
    ENSURE_DIRECTORY_PRE_CREATE_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

/// Runs once, after the next [`ensure_directory_at`]'s exclusive create reports `AlreadyExists`
/// and before the existing name is opened.
#[cfg(all(test, unix))]
pub(crate) fn set_ensure_directory_post_collision_hook(hook: Option<Box<dyn FnOnce()>>) {
    ENSURE_DIRECTORY_POST_COLLISION_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

/// The crate's one descriptor-relative create-if-missing: an exclusive [`create_dir_at`] whose
/// `AlreadyExists` is the success path, followed by a no-follow [`open_directory_at`] of `name`
/// under the same held `parent`. A symlink or reparse point at `name` — including one planted
/// after the create collided — fails the open rather than being followed. A freshly created
/// directory gets `create_dir_at`'s mode.
pub(crate) fn ensure_directory_at(parent: &File, name: &OsStr) -> Result<File, Error> {
    single_leaf(name)?;
    #[cfg(all(test, unix))]
    if let Some(hook) = ENSURE_DIRECTORY_PRE_CREATE_HOOK.with(|slot| slot.borrow_mut().take()) {
        hook();
    }
    match create_dir_at(parent, name) {
        Ok(()) => {}
        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            #[cfg(all(test, unix))]
            if let Some(hook) =
                ENSURE_DIRECTORY_POST_COLLISION_HOOK.with(|slot| slot.borrow_mut().take())
            {
                hook();
            }
        }
        Err(error) => return Err(error),
    }
    open_directory_at(parent, name, true)
}

#[cfg(unix)]
pub(crate) fn open_directory_at(
    parent: &File,
    name: &OsStr,
    _writable: bool,
) -> Result<File, Error> {
    use rustix::fs::{self as rfs, Mode, OFlags};
    Ok(File::from(
        rfs::openat(
            parent,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| Error::Io(Box::new(error.into())))?,
    ))
}

#[cfg(windows)]
pub(crate) fn open_directory_at(
    parent: &File,
    name: &OsStr,
    writable: bool,
) -> Result<File, Error> {
    win::open_directory_child(parent, name, writable)
}

/// On Unix this uses stat → access → stat and creates no descriptor for the leaf, because
/// closing any descriptor of its inode would release this process's POSIX locks
/// (f-20260929-11). On Windows, the corresponding probe opens and closes a read handle, whose
/// byte-range locks are handle-scoped.
#[cfg(unix)]
pub(crate) fn probe_regular_file_at(
    parent: &File,
    name: &OsStr,
) -> Result<RegularFileMetadata, Error> {
    use rustix::fs::{self as rfs, Access, AtFlags, FileType};

    single_leaf(name)?;
    let first = rfs::statat(parent, name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| Error::Io(Box::new(error.into())))?;
    if FileType::from_raw_mode(first.st_mode) != FileType::RegularFile {
        return Err(Error::InvalidInput("target must be a regular file".into()));
    }

    // Adding AT_SYMLINK_NOFOLLOW (or any flag besides AT_EACCESS) needs faccessat2, which Linux
    // < 5.8 lacks and rustix then reports ENOSYS; the exact flags are pinned by
    // `platform_support::tests::unix_regular_file_probe_uses_only_eaccess_for_access_check`.
    // The no-follow stat sandwich, not this check, decides the entry's kind and identity.
    let access = rfs::accessat(parent, name, Access::READ_OK, AtFlags::EACCESS)
        .map_err(|error| Error::Io(Box::new(error.into())));
    #[cfg(test)]
    run_regular_file_probe_after_access_hook();

    let second = rfs::statat(parent, name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| Error::Io(Box::new(error.into())))?;
    if FileType::from_raw_mode(second.st_mode) != FileType::RegularFile {
        return Err(Error::InvalidInput("target must be a regular file".into()));
    }
    let identity = unix::raw_stat_identity(&second);
    if identity != unix::raw_stat_identity(&first) {
        return Err(Error::Conflict(
            "workspace entry changed concurrently".into(),
        ));
    }
    access?;

    let invalid_length = || {
        Error::Io(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "regular file has an out-of-range length",
        )))
    };
    let invalid_mtime = || {
        Error::Io(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "regular file has an out-of-range modification time",
        )))
    };
    let length = u64::try_from(second.st_size).map_err(|_| invalid_length())?;
    let nanoseconds = u32::try_from(second.st_mtime_nsec).map_err(|_| invalid_mtime())?;
    if nanoseconds >= 1_000_000_000 {
        return Err(invalid_mtime());
    }
    let modified = if second.st_mtime >= 0 {
        let seconds = u64::try_from(second.st_mtime).map_err(|_| invalid_mtime())?;
        SystemTime::UNIX_EPOCH.checked_add(Duration::new(seconds, nanoseconds))
    } else {
        let seconds = second.st_mtime.unsigned_abs();
        SystemTime::UNIX_EPOCH
            .checked_sub(Duration::from_secs(seconds))
            .and_then(|time| time.checked_add(Duration::from_nanos(u64::from(nanoseconds))))
    }
    .ok_or_else(invalid_mtime)?;

    Ok(RegularFileMetadata {
        identity,
        length,
        modified,
    })
}

#[cfg(windows)]
pub(crate) fn probe_regular_file_at(
    parent: &File,
    name: &OsStr,
) -> Result<RegularFileMetadata, Error> {
    let file = open_regular_at(parent, name, RegularFileAccess::ReadOnly)?;
    let metadata = file.metadata()?;
    Ok(RegularFileMetadata {
        identity: crate::infra::path_authority::opened_file_identity(&file)?,
        length: metadata.len(),
        modified: metadata.modified()?,
    })
}

#[cfg(unix)]
pub(crate) fn open_regular_at(
    parent: &File,
    name: &OsStr,
    access: RegularFileAccess,
) -> Result<crate::infra::inode_ownership::OwnedFile, Error> {
    single_leaf(name)?;
    let flags = match access {
        RegularFileAccess::ReadOnly => rustix::fs::OFlags::RDONLY,
        RegularFileAccess::ReadWrite => rustix::fs::OFlags::RDWR,
    };
    crate::infra::inode_ownership::open_at(parent, name, flags, false)
}

#[cfg(windows)]
pub(crate) fn open_regular_at(
    parent: &File,
    name: &OsStr,
    access: RegularFileAccess,
) -> Result<crate::infra::inode_ownership::OwnedFile, Error> {
    crate::infra::inode_ownership::own_windows(win::open_regular_at(parent, name, access)?)
}

/// Shared advisory lock leaves use open-or-create while preserving regular-file admission.
#[cfg(unix)]
pub(crate) fn open_or_create_regular_at(
    parent: &File,
    name: &OsStr,
) -> Result<crate::infra::inode_ownership::OwnedFile, Error> {
    single_leaf(name)?;
    crate::infra::inode_ownership::open_at(parent, name, rustix::fs::OFlags::RDWR, true)
}

#[cfg(windows)]
pub(crate) fn open_or_create_regular_at(
    parent: &File,
    name: &OsStr,
) -> Result<crate::infra::inode_ownership::OwnedFile, Error> {
    win::open_or_create_regular_at(parent, name)
}

/// Exclusive creates retain ownership even after the new leaf becomes reachable by SQLite.
#[cfg(unix)]
pub(crate) fn create_regular_at(
    parent: &File,
    name: &OsStr,
) -> Result<(crate::infra::inode_ownership::OwnedFile, (u64, u64)), Error> {
    single_leaf(name)?;
    let created =
        crate::infra::inode_ownership::create_at(parent, name, rustix::fs::OFlags::WRONLY)?;
    let identity = created.identity();
    Ok((created, identity))
}

#[cfg(windows)]
pub(crate) fn create_regular_at(
    parent: &File,
    name: &OsStr,
) -> Result<(crate::infra::inode_ownership::OwnedFile, (u64, u64)), Error> {
    win::create_regular_at(parent, name)
}

/// A committed unlink is complete even when its parent sync cannot be confirmed.
/// Keep native context here while preserving the existing renderer-safe combined error.
pub(crate) fn created_leaf_error_after_cleanup(
    primary: Error,
    removal: Result<(), Error>,
    operation: &str,
    leaf: &OsStr,
) -> Error {
    match removal {
        Ok(()) => primary,
        Err(error) if error.is_missing_entry() => primary,
        Err(Error::CommittedDurabilityUncertain(stage)) => {
            log::warn!(
                "{operation} leaf {leaf:?} was removed but parent sync is uncertain at {stage}"
            );
            primary
        }
        Err(removal) => Error::with_cleanup(primary, Err(removal)),
    }
}

pub(crate) fn rename_entry_at(
    source_parent: &File,
    source: &OsStr,
    expected: (u64, u64),
    source_is_dir: bool,
    target_parent: &File,
    target: &OsStr,
) -> Result<AtomicFileOutcome, Error> {
    rename_entry_at_with_collision(
        source_parent,
        source,
        expected,
        source_is_dir,
        target_parent,
        target,
        false,
    )
}

pub(crate) fn rename_workspace_entry_at(
    source_parent: &File,
    source: &OsStr,
    expected: (u64, u64),
    source_is_dir: bool,
    target_parent: &File,
    target: &OsStr,
) -> Result<AtomicFileOutcome, Error> {
    rename_entry_at_with_collision(
        source_parent,
        source,
        expected,
        source_is_dir,
        target_parent,
        target,
        true,
    )
}

#[cfg(unix)]
fn rename_entry_at_with_collision(
    source_parent: &File,
    source: &OsStr,
    expected: (u64, u64),
    source_is_dir: bool,
    target_parent: &File,
    target: &OsStr,
    workspace_name: bool,
) -> Result<AtomicFileOutcome, Error> {
    use rustix::fs::{self as rfs, RenameFlags};
    let distinct_parents = crate::infra::path_authority::opened_file_identity(source_parent)?
        != crate::infra::path_authority::opened_file_identity(target_parent)?;
    assert_entry_identity(source_parent, source, expected, source_is_dir)?;
    rfs::renameat_with(
        source_parent,
        source,
        target_parent,
        target,
        RenameFlags::NOREPLACE,
    )
    .map_err(|error| {
        let error = Error::Io(Box::new(error.into()));
        if workspace_name {
            workspace_collision(error)
        } else {
            error
        }
    })?;
    Ok(sync_rename_parents(
        source_parent,
        target_parent,
        distinct_parents,
    ))
}

#[cfg(windows)]
fn rename_entry_at_with_collision(
    source_parent: &File,
    source: &OsStr,
    expected: (u64, u64),
    source_is_dir: bool,
    target_parent: &File,
    target: &OsStr,
    workspace_name: bool,
) -> Result<AtomicFileOutcome, Error> {
    win::rename_entry_at(
        source_parent,
        source,
        expected,
        source_is_dir,
        target_parent,
        target,
        workspace_name,
    )
}

pub(crate) fn rename_optional_regular_at(
    source_parent: &File,
    source: &OsStr,
    target_parent: &File,
    target: &OsStr,
) -> Result<Option<AtomicFileOutcome>, Error> {
    rename_optional_regular_at_with_collision(source_parent, source, target_parent, target, false)
}

pub(crate) fn rename_workspace_sidecar_at(
    source_parent: &File,
    source: &OsStr,
    target_parent: &File,
    target: &OsStr,
) -> Result<Option<AtomicFileOutcome>, Error> {
    rename_optional_regular_at_with_collision(source_parent, source, target_parent, target, true)
}

#[cfg(unix)]
fn rename_optional_regular_at_with_collision(
    source_parent: &File,
    source: &OsStr,
    target_parent: &File,
    target: &OsStr,
    workspace_name: bool,
) -> Result<Option<AtomicFileOutcome>, Error> {
    use rustix::{
        fs::{self as rfs, AtFlags, FileType, RenameFlags},
        io::Errno,
    };
    match rfs::statat(source_parent, source, AtFlags::SYMLINK_NOFOLLOW) {
        Err(error) if error == Errno::NOENT => return Ok(None),
        Err(error) => return Err(Error::Io(Box::new(error.into()))),
        Ok(stat) if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile => {
            return Err(Error::InvalidInput(
                "workspace sidecar must be a regular file".into(),
            ))
        }
        Ok(_) => {}
    }
    let distinct_parents = crate::infra::path_authority::opened_file_identity(source_parent)?
        != crate::infra::path_authority::opened_file_identity(target_parent)?;
    rfs::renameat_with(
        source_parent,
        source,
        target_parent,
        target,
        RenameFlags::NOREPLACE,
    )
    .map_err(|error| {
        let error = Error::Io(Box::new(error.into()));
        if workspace_name {
            workspace_collision(error)
        } else {
            error
        }
    })?;
    Ok(Some(sync_rename_parents(
        source_parent,
        target_parent,
        distinct_parents,
    )))
}

#[cfg(windows)]
fn rename_optional_regular_at_with_collision(
    source_parent: &File,
    source: &OsStr,
    target_parent: &File,
    target: &OsStr,
    workspace_name: bool,
) -> Result<Option<AtomicFileOutcome>, Error> {
    win::rename_optional_regular_at(source_parent, source, target_parent, target, workspace_name)
}

/// The catalog authority validates its complete inventory before invoking recursive removal.
/// Use the remover's mount proof during that validation, before any entry can be unlinked.
pub(crate) fn open_removal_directory_at(
    parent: &File,
    name: &OsStr,
    expected: (u64, u64),
) -> Result<VerifiedDir, Error> {
    open_removal_directory_at_with_access(parent, name, expected, false)
}

/// Mutation parents need write access on Windows for namespace changes and parent sync.
pub(crate) fn open_removal_directory_at_with_access(
    parent: &File,
    name: &OsStr,
    expected: (u64, u64),
    writable: bool,
) -> Result<VerifiedDir, Error> {
    let child = VerifiedDir::new(open_directory_at(parent, name, writable)?, expected)?;
    #[cfg(unix)]
    if unix::mount_crossing(parent, child.as_file())? {
        return Err(Error::InvalidInput(
            "directory cleanup refuses to cross a mount".into(),
        ));
    }
    Ok(child)
}

pub(crate) fn remove_entry_at(
    parent: &File,
    name: &OsStr,
    expected: (u64, u64),
    is_dir: bool,
) -> Result<(), Error> {
    remove_entry_at_counted(parent, name, expected, is_dir)?.finish()
}

/// Own the physical target count before syncing its parent. A recursive failure keeps its
/// original partial progress error and never enters the completed-removal policy.
#[cfg(unix)]
pub(crate) fn remove_entry_at_counted(
    parent: &File,
    name: &OsStr,
    expected: (u64, u64),
    is_dir: bool,
) -> Result<crate::error::CommittedRemoval, Error> {
    use rustix::fs::{self as rfs, AtFlags};
    single_leaf(name)?;
    assert_entry_identity(parent, name, expected, is_dir)?;
    #[cfg(test)]
    unix::inject_removal(unix::RemovalFaultPoint::BeforeTopOpen)?;
    let mut removed_entries = 0;
    if is_dir {
        let parent_stat = rfs::fstat(parent).map_err(|error| Error::Io(Box::new(error.into())))?;
        if let Err(cause) = unix::remove_tree_at(
            parent,
            name,
            expected,
            0,
            unix::raw_stat_identity(&parent_stat).0,
            &mut removed_entries,
        ) {
            return if removed_entries == 0 {
                Err(cause)
            } else {
                Err(Error::PartialRemoval {
                    removed_entries,
                    cause: Box::new(cause),
                })
            };
        }
    } else {
        rfs::unlinkat(parent, name, AtFlags::empty())
            .map_err(|error| Error::Io(Box::new(error.into())))?;
        removed_entries = 1;
    }
    Ok(crate::error::CommittedRemoval::new(
        removed_entries,
        sync_parent_after_workspace_removal(parent).err(),
    ))
}

fn sync_parent_after_workspace_removal(parent: &File) -> Result<(), Error> {
    #[cfg(all(test, unix))]
    if let Err(error) = unix::inject_removal(unix::RemovalFaultPoint::ParentSync) {
        log::warn!("workspace removal parent sync failed: {error}");
        return Err(Error::CommittedDurabilityUncertain(
            crate::error::DurabilityStage::WorkspaceRemoval,
        ));
    }
    if let Err(error) = parent.sync_all() {
        log::warn!("workspace removal parent sync failed: {error}");
        return Err(Error::CommittedDurabilityUncertain(
            crate::error::DurabilityStage::WorkspaceRemoval,
        ));
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn remove_empty_directory_at(
    parent: &File,
    name: &OsStr,
    expected: (u64, u64),
) -> Result<(), Error> {
    use rustix::fs::{self as rfs, AtFlags};
    single_leaf(name)?;
    assert_entry_identity(parent, name, expected, true)?;
    #[cfg(test)]
    unix::inject_removal(unix::RemovalFaultPoint::BeforeTopOpen)?;
    rfs::unlinkat(parent, name, AtFlags::REMOVEDIR)
        .map_err(|error| Error::Io(Box::new(error.into())))?;
    sync_parent_after_workspace_removal(parent)
}

#[cfg(windows)]
pub(crate) fn remove_entry_at_counted(
    parent: &File,
    name: &OsStr,
    expected: (u64, u64),
    is_dir: bool,
) -> Result<crate::error::CommittedRemoval, Error> {
    win::remove_entry_at_counted(parent, name, expected, is_dir)
}

#[cfg(windows)]
pub(crate) fn remove_empty_directory_at(
    parent: &File,
    name: &OsStr,
    expected: (u64, u64),
) -> Result<(), Error> {
    win::remove_empty_directory_at(parent, name, expected)
}

#[cfg(unix)]
pub(crate) fn remove_optional_regular_at(parent: &File, name: &OsStr) -> Result<(), Error> {
    use rustix::{
        fs::{self as rfs, AtFlags, FileType},
        io::Errno,
    };
    match rfs::statat(parent, name, AtFlags::SYMLINK_NOFOLLOW) {
        Err(error) if error == Errno::NOENT => Ok(()),
        Err(error) => Err(Error::Io(Box::new(error.into()))),
        Ok(stat) if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile => Err(
            Error::InvalidInput("workspace sidecar must be a regular file".into()),
        ),
        Ok(_) => rfs::unlinkat(parent, name, AtFlags::empty())
            .map_err(|error| Error::Io(Box::new(error.into()))),
    }
}

#[cfg(windows)]
pub(crate) fn remove_optional_regular_at(parent: &File, name: &OsStr) -> Result<(), Error> {
    win::remove_optional_regular_at(parent, name)
}

pub fn atomic_replace_at_with_precommit<F, P>(
    parent: &File,
    leaf: &OsStr,
    precommit: P,
    write_fn: F,
) -> Result<AtomicFileOutcome, Error>
where
    F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
    P: FnOnce() -> Result<(), Error>,
{
    atomic_replace_at_identified_with_precommit(parent, leaf, precommit, write_fn)
        .map(|installed| installed.outcome)
}

/// Same fd-relative commit, with the inode identity captured from the still-open temporary FD
/// after `renameat` and before any pathname lookup can occur.
pub fn atomic_replace_at_identified<F>(
    parent: &File,
    leaf: &OsStr,
    write_fn: F,
) -> Result<AtomicInstalledFile, Error>
where
    F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
{
    atomic_replace_at_identified_with_precommit(parent, leaf, || Ok(()), write_fn)
}

pub fn atomic_replace_at_identified_with_precommit<F, P>(
    parent: &File,
    leaf: &OsStr,
    precommit: P,
    write_fn: F,
) -> Result<AtomicInstalledFile, Error>
where
    F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
    P: FnOnce() -> Result<(), Error>,
{
    atomic_publish_at_identified_with_precommit(
        parent,
        leaf,
        AtomicFileMode::Replace,
        precommit,
        write_fn,
    )
}

pub(crate) fn atomic_create_at_identified<F>(
    parent: &File,
    leaf: &OsStr,
    write_fn: F,
) -> Result<AtomicInstalledFile, Error>
where
    F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
{
    atomic_create_at_identified_with_precommit(parent, leaf, || Ok(()), write_fn)
}

pub(crate) fn atomic_create_at_identified_with_precommit<F, P>(
    parent: &File,
    leaf: &OsStr,
    precommit: P,
    write_fn: F,
) -> Result<AtomicInstalledFile, Error>
where
    F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
    P: FnOnce() -> Result<(), Error>,
{
    atomic_publish_at_identified_with_precommit(
        parent,
        leaf,
        AtomicFileMode::Create,
        precommit,
        write_fn,
    )
}

/// Exclusive sidecar publication inside a forward workspace pair. Unlike file creation,
/// every occupied destination name is a collision, without opening or following that object.
pub(crate) fn atomic_create_workspace_sidecar_at<F, P>(
    parent: &File,
    leaf: &OsStr,
    precommit: P,
    write_fn: F,
) -> Result<AtomicInstalledFile, Error>
where
    F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
    P: FnOnce() -> Result<(), Error>,
{
    atomic_publish_at_identified_with_precommit(
        parent,
        leaf,
        AtomicFileMode::CreateWorkspaceSidecar,
        precommit,
        write_fn,
    )
}

fn atomic_publish_at_identified_with_precommit<F, P>(
    parent: &File,
    leaf: &OsStr,
    mode: AtomicFileMode,
    precommit: P,
    write_fn: F,
) -> Result<AtomicInstalledFile, Error>
where
    F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
    P: FnOnce() -> Result<(), Error>,
{
    single_leaf(leaf)?;
    #[cfg(unix)]
    {
        unix::replace_at(
            parent.try_clone()?,
            leaf.to_os_string(),
            mode,
            precommit,
            write_fn,
        )
        .map(|installed| AtomicInstalledFile {
            outcome: installed.outcome,
            identity: installed.identity,
            ctime_nanos: installed.ctime_nanos,
            modified_seconds: installed.modified_seconds,
        })
    }
    #[cfg(windows)]
    {
        win::replace_at(
            parent.try_clone()?,
            leaf.to_os_string(),
            mode,
            precommit,
            write_fn,
        )
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AtomicDirFaultPoint {
    InstallerEntry,
    /// Final Windows source consumer after the shared stat. Remove with this boundary's tests
    /// if a stronger native publication primitive replaces the retained-entry contract.
    #[cfg(windows)]
    CommitEntry,
    SyncEntry,
    PreCommit,
    /// Unix: immediately before the single `EXCHANGE` (no backup is taken). Windows: after the
    /// live target has been renamed to the `{INSTALL_BACKUP_PREFIX}` sibling.
    BackupRename,
    InstallRename,
    ParentSync,
    BackupCleanup,
    /// Windows only: on the rollback arm, immediately before the backup is renamed back onto the
    /// target name. Never constructed on unix, so its variant is exempt from `dead_code` there.
    #[cfg_attr(not(windows), allow(dead_code))]
    RollbackRename,
}
#[cfg(test)]
pub(crate) trait AtomicDirInjector {
    fn inject(&self, _: AtomicDirFaultPoint) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
std::thread_local! {
    static TEST_ATOMIC_DIR_INJECTOR: std::cell::RefCell<Option<Box<dyn AtomicDirInjector>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_test_atomic_dir_injector(injector: Option<Box<dyn AtomicDirInjector>>) {
    TEST_ATOMIC_DIR_INJECTOR.with(|current| *current.borrow_mut() = injector);
}

#[cfg(test)]
fn inject_atomic_dir(point: AtomicDirFaultPoint) -> Result<(), Error> {
    TEST_ATOMIC_DIR_INJECTOR.with(|current| {
        current
            .borrow()
            .as_ref()
            .map_or(Ok(()), |injector| injector.inject(point).map_err(io))
    })
}

#[cfg(test)]
pub fn atomic_install_dir(temp_path: &Path, target_path: &Path) -> Result<(), Error> {
    #[cfg(unix)]
    {
        unix::install_dir(temp_path, target_path)
    }
    #[cfg(windows)]
    {
        win::install_dir(temp_path, target_path)
    }
}

#[cfg(all(test, unix))]
std::thread_local! {
    static OPEN_PARENT_CHILD_IDENTITY_HOOK: std::cell::RefCell<Option<(u64, u64)>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
std::thread_local! {
    /// Armed `OwnedStagingDir` drops on this thread, so a test can observe disarming.
    static OWNED_STAGING_DROP_REMOVALS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Replaces the child identity the next [`open_parent_directory`] looks for in the parent.
#[cfg(all(test, unix))]
pub(crate) fn set_open_parent_child_identity_hook(identity: Option<(u64, u64)>) {
    OPEN_PARENT_CHILD_IDENTITY_HOOK.with(|slot| *slot.borrow_mut() = identity);
}

fn opened_identity(file: &File) -> Result<(u64, u64), Error> {
    #[cfg(unix)]
    {
        let stat = rustix::fs::fstat(file).map_err(|error| io(error.into()))?;
        Ok(unix::raw_stat_identity(&stat))
    }
    #[cfg(windows)]
    {
        crate::infra::path_authority::opened_file_identity(file)
    }
}

/// Unix only, like its one caller [`open_parent_directory`].
#[cfg(all(test, unix))]
fn parent_child_mismatch() -> Error {
    Error::Conflict("directory is not a child of its opened parent".into())
}

/// Opens the parent of an already-open directory through its relative `".."` entry, then
/// refuses unless that parent, on the same device, lists a directory with `dir`'s identity. A
/// mount root fails that check: its `".."` lists the covered mount point, not the root.
///
/// Unix only. A Windows relative open has no `".."` (and [`single_leaf`] refuses the name), so
/// [`OwnedStagingDir::adopt`] reaches its parent through `win::open_verified_parent` instead.
#[cfg(all(test, unix))]
pub(crate) fn open_parent_directory(dir: &File) -> Result<File, Error> {
    use rustix::fs::{self as rfs, AtFlags, FileType};
    use std::os::unix::ffi::OsStrExt;
    let child = opened_identity(dir)?;
    #[cfg(test)]
    let child = OPEN_PARENT_CHILD_IDENTITY_HOOK
        .with(|slot| slot.borrow_mut().take())
        .unwrap_or(child);
    let parent = open_directory_at(dir, OsStr::new(".."), true)?;
    if opened_identity(&parent)?.0 != child.0 {
        return Err(parent_child_mismatch());
    }
    let mut found = false;
    unix::walk_directory(&parent, |bytes, ino, _kind| {
        if found || ino != child.1 {
            return Ok(());
        }
        let stat = match rfs::statat(&parent, OsStr::from_bytes(bytes), AtFlags::SYMLINK_NOFOLLOW) {
            Ok(stat) => stat,
            Err(_) => return Ok(()),
        };
        found = FileType::from_raw_mode(stat.st_mode) == FileType::Directory
            && unix::raw_stat_identity(&stat) == child;
        Ok(())
    })?;
    if !found {
        return Err(parent_child_mismatch());
    }
    Ok(parent)
}

/// A private directory the process created, held as a leaf under one open parent
/// descriptor. It carries no pathname: installing it and cleaning it up are both relative to the
/// held parent, so a later swap of the parent's pathname cannot redirect either. Until it is
/// consumed by a commit, dropping it removes the leaf by identity.
///
/// Adoption is the one step that differs by platform. Unix opens the parent relative to the child
/// (`".."`). Windows has no such open, so it walks the parent's pathname component by component,
/// refusing every reparse point, and then requires the leaf under that parent to carry the
/// identity of the already-open child. Nothing is trusted from the string: a pathname swapped
/// between the two opens ends in `Error::Conflict`, never in a different parent being held.
pub(crate) struct OwnedStagingDir {
    parent: File,
    leaf: OsString,
    child: Option<File>,
    identity: (u64, u64),
    armed: bool,
}

const STAGING_DIRECTORY_CREATE_ATTEMPTS: usize = 32;

impl OwnedStagingDir {
    /// Exclusively creates a randomized private sibling through the retained authority parent.
    /// Unix mkdir/open is not atomic against substitution between the individual syscalls.
    /// Cleanup is armed once the no-follow child's identity is known. The following parent-entry
    /// assertion guards that binding, and identity-checked cleanup preserves a substituted entry.
    pub(crate) fn create_in(parent: &File, prefix: &str) -> Result<Self, Error> {
        let parent = parent.try_clone()?;
        for _ in 0..STAGING_DIRECTORY_CREATE_ATTEMPTS {
            let leaf = staging_directory_name(prefix);
            single_leaf(&leaf)?;
            #[cfg(unix)]
            let created =
                rustix::fs::mkdirat(&parent, &leaf, rustix::fs::Mode::from_raw_mode(0o700))
                    .map_err(|error| io(error.into()));
            #[cfg(windows)]
            let created = win::create_directory_child(&parent, &leaf);
            let child = match created {
                #[cfg(unix)]
                Ok(()) => open_directory_at(&parent, &leaf, true)?,
                #[cfg(windows)]
                Ok(child) => child,
                Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    continue
                }
                Err(error) => return Err(error),
            };
            let identity = opened_identity(&child)?;
            let staging = Self {
                parent,
                leaf,
                child: Some(child),
                identity,
                armed: true,
            };
            assert_entry_identity(&staging.parent, &staging.leaf, identity, true)?;
            #[cfg(test)]
            if let Some(hook) =
                STAGING_DIRECTORY_INITIALIZED_HOOK.with(|slot| slot.borrow_mut().take())
            {
                hook(&staging);
            }
            // From here all failures drop the identity-bound owner. Its cleanup logs errors
            // without replacing this original initialization failure.
            if let AtomicFileOutcome::CommittedDurabilityUncertain(error) =
                parent_sync_as_atomic_outcome(&staging.parent)
            {
                return Err(io(error));
            }
            return Ok(staging);
        }
        Err(io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "archive staging name collisions exhausted",
        )))
    }

    /// Test-fixture adoption. Production creates directly through its authority parent.
    /// No-follow open of `temp`, then the platform's parent open of that handle (see the type
    /// documentation), then a check that `temp`'s leaf under the held parent is still the opened
    /// directory.
    #[cfg(test)]
    pub(crate) fn adopt(temp: &tempfile::TempDir) -> Result<Self, Error> {
        let leaf = temp
            .path()
            .file_name()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| Error::InvalidInput("owned staging directory needs a leaf name".into()))?
            .to_os_string();
        #[cfg(unix)]
        let child = unix::open_dir_no_follow(temp.path())?;
        // Writable: the relative creates make directories below this handle, and the Windows
        // `create_dir_at` flushes its parent, which a read-only directory handle refuses.
        #[cfg(windows)]
        let child = win::open_directory_path(temp.path(), true)?;
        let identity = opened_identity(&child)?;
        #[cfg(unix)]
        let parent = open_parent_directory(&child)?;
        // The shared helper words its mismatch for a workspace entry the user named; this leaf
        // is internal staging, so it reports as the identity check below does.
        #[cfg(windows)]
        let (parent, _) =
            win::open_verified_parent(temp.path(), identity, true, ParentAccess::Writable)
                .map_err(|error| match error {
                    Error::Conflict(_) => owned_staging_changed(),
                    other => other,
                })?;
        match entry_identity_at(&parent, &leaf, true) {
            Ok(actual) if actual == identity => {}
            Ok(_) => return Err(owned_staging_changed()),
            Err(error) => return Err(error),
        }
        Ok(Self {
            parent,
            leaf,
            child: Some(child),
            identity,
            armed: true,
        })
    }

    /// Identity of the held parent descriptor, for a caller that must confirm the directory it
    /// named is the one this value will install into.
    pub(crate) fn parent_identity(&self) -> Result<(u64, u64), Error> {
        opened_identity(&self.parent)
    }

    pub(crate) fn binding(&self) -> (&File, &OsStr, (u64, u64)) {
        (&self.parent, &self.leaf, self.identity)
    }

    pub(crate) fn directory(&self) -> Result<&File, Error> {
        owned_staging_child(self)
    }

    /// Creates-if-missing each component of `relative` below the held child, one
    /// [`ensure_directory_at`] per component. An empty `relative` is the staging root itself.
    pub(crate) fn ensure_relative_directory(&self, relative: &Path) -> Result<(), Error> {
        let components = owned_staging_components(relative)?;
        ensure_owned_staging_walk(owned_staging_child(self)?, &components)?;
        Ok(())
    }

    /// Exclusively creates the regular-file leaf of `relative` (mode 0o600 on unix) after
    /// creating-if-missing its parent components below the held child.
    pub(crate) fn create_relative_regular(
        &self,
        relative: &Path,
    ) -> Result<crate::infra::inode_ownership::OwnedFile, Error> {
        let components = owned_staging_components(relative)?;
        let (leaf, parents) = components
            .split_last()
            .ok_or_else(|| Error::InvalidInput("owned staging file needs a leaf name".into()))?;
        let child = owned_staging_child(self)?;
        let parent = ensure_owned_staging_walk(child, parents)?;
        let (created, _) = create_regular_at(parent.as_ref().unwrap_or(child), leaf)?;
        Ok(created)
    }
}

fn staging_directory_name(prefix: &str) -> OsString {
    #[cfg(test)]
    if let Some(name) = STAGING_DIRECTORY_NAMES.with(|slot| slot.borrow_mut().pop()) {
        return name;
    }
    format!("{prefix}-{}", uuid::Uuid::new_v4()).into()
}

#[cfg(test)]
type StagingDirectoryInitializedHook = Box<dyn FnOnce(&OwnedStagingDir)>;

#[cfg(test)]
std::thread_local! {
    static STAGING_DIRECTORY_NAMES: std::cell::RefCell<Vec<OsString>> = const { std::cell::RefCell::new(Vec::new()) };
    static STAGING_DIRECTORY_INITIALIZED_HOOK: std::cell::RefCell<Option<StagingDirectoryInitializedHook>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn owned_staging_changed() -> Error {
    Error::Conflict("owned staging directory changed concurrently".into())
}

fn owned_staging_child(staging: &OwnedStagingDir) -> Result<&File, Error> {
    staging
        .child
        .as_ref()
        .ok_or_else(|| Error::Conflict("owned staging directory was already consumed".into()))
}

/// Splits `relative` into single-leaf components. Anything but plain names is refused, including
/// a `.` or empty component that [`Path::components`] would silently normalise away.
fn owned_staging_components(relative: &Path) -> Result<Vec<&OsStr>, Error> {
    let refused = || Error::InvalidInput("owned staging path must be plain relative names".into());
    let mut components = Vec::new();
    let mut spelled = 0;
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err(refused());
        };
        single_leaf(name).map_err(|_| refused())?;
        spelled += name.len();
        components.push(name);
    }
    spelled += components.len().saturating_sub(1);
    if spelled != relative.as_os_str().len() {
        return Err(refused());
    }
    Ok(components)
}

/// Walks `components` from `root` with [`ensure_directory_at`]. `None` means no component, so the
/// directory reached is `root` itself.
fn ensure_owned_staging_walk(root: &File, components: &[&OsStr]) -> Result<Option<File>, Error> {
    let mut current: Option<File> = None;
    for name in components {
        current = Some(ensure_directory_at(current.as_ref().unwrap_or(root), name)?);
    }
    Ok(current)
}

impl Drop for OwnedStagingDir {
    fn drop(&mut self) {
        drop(self.child.take());
        if !self.armed {
            return;
        }
        #[cfg(test)]
        OWNED_STAGING_DROP_REMOVALS.with(|count| count.set(count.get() + 1));
        if let Err(error) = remove_entry_at(&self.parent, &self.leaf, self.identity, true) {
            log::warn!("owned staging directory cleanup failed: {error}");
        }
    }
}

/// Installs `source` onto `dest_leaf`, a sibling name under the source's held parent: absent, or
/// an existing real directory to replace. Same-parent is structural, so there is no pathname
/// reopen. Once the commit has returned, `source` no longer owns a leaf and its cleanup is
/// disarmed, including when the result is `CommittedDurabilityUncertain`.
#[cfg(test)]
pub(crate) fn install_owned_staging_dir(
    mut source: OwnedStagingDir,
    dest_leaf: &OsStr,
) -> Result<(), Error> {
    let parent = source.parent.try_clone()?;
    install_staging_dir_at(
        &mut source,
        &parent,
        dest_leaf,
        DirectoryInstallPolicy::Replace,
    )
}

/// Consumes the original staged binding only at the actual commit. Callers keep this owner on
/// their blocking worker, including precommit failures and committed durability uncertainty.
pub(crate) fn install_staging_dir_at(
    source: &mut OwnedStagingDir,
    destination_parent: &File,
    dest_leaf: &OsStr,
    policy: DirectoryInstallPolicy,
) -> Result<(), Error> {
    #[cfg(test)]
    inject_atomic_dir(AtomicDirFaultPoint::InstallerEntry)?;
    if source.parent_identity()? != opened_identity(destination_parent)? {
        return Err(Error::InvalidInput(
            "directory staging source must be in the target's real parent directory".into(),
        ));
    }
    single_leaf(dest_leaf)?;
    if dest_leaf == source.leaf {
        return Err(Error::InvalidInput(
            "owned staging directory cannot install onto itself".into(),
        ));
    }
    drop(source.child.take());
    let mut committed = false;
    #[cfg(unix)]
    let result = unix::install_dir_at(
        destination_parent,
        &source.leaf,
        source.identity,
        dest_leaf,
        policy,
        &mut committed,
    );
    #[cfg(windows)]
    let result = win::install_dir_at(
        destination_parent,
        &source.leaf,
        source.identity,
        dest_leaf,
        policy,
        &mut committed,
    );
    if committed {
        source.armed = false;
    }
    result
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn windows_created_failure_removes_leaf_and_allows_retry_through_public_wrappers() {
        for failure in ["identity", "admission", "reopen"] {
            for open_or_create in [false, true] {
                let root = tempfile::tempdir().unwrap();
                let parent = windows_test_parent(root.path());
                win::CREATED_TEST_CONTROLS.with(|slot| {
                    *slot.borrow_mut() = win::CreatedTestControls {
                        identity_failure: failure == "identity",
                        reopen_failure: failure == "reopen",
                        ..Default::default()
                    }
                });
                crate::infra::inode_ownership::WINDOWS_CREATED_ADMISSION_FAILURE
                    .with(|slot| slot.set(failure == "admission"));
                let result = if open_or_create {
                    open_or_create_regular_at(&parent, OsStr::new("retry"))
                } else {
                    create_regular_at(&parent, OsStr::new("retry")).map(|(file, _)| file)
                };
                let expected = format!("injected created-file {failure} failure");
                assert!(result.unwrap_err().diagnostic().contains(&expected));
                assert!(
                    !root.path().join("retry").exists(),
                    "failed exclusive create left its leaf behind"
                );
                let (file, identity) = if open_or_create {
                    let file = open_or_create_regular_at(&parent, OsStr::new("retry")).unwrap();
                    let identity = file.identity();
                    (file, identity)
                } else {
                    create_regular_at(&parent, OsStr::new("retry")).unwrap()
                };
                assert_eq!(file.identity(), identity);
                assert_eq!(
                    identity,
                    crate::infra::path_authority::opened_file_identity(&file).unwrap()
                );
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_created_owner_permits_strict_sharing_and_synchronous_read_write() {
        use std::io::{Seek, SeekFrom};
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

        for open_or_create in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let parent = windows_test_parent(root.path());
            let (mut owner, identity) = if open_or_create {
                let owner = open_or_create_regular_at(&parent, OsStr::new("ordinary")).unwrap();
                let identity = owner.identity();
                (owner, identity)
            } else {
                create_regular_at(&parent, OsStr::new("ordinary")).unwrap()
            };
            // The owner stays live through this strict open and both directions of I/O.
            // Returning the DELETE-capable creator makes this open fail with sharing violation.
            let mut strict = File::options()
                .read(true)
                .write(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .open(root.path().join("ordinary"))
                .expect("live ordinary owner must permit strict sharing");
            assert_eq!(owner.identity(), identity);
            assert_eq!(
                crate::infra::path_authority::opened_file_identity(&strict).unwrap(),
                identity
            );
            owner.write_all(b"owner").unwrap();
            let mut bytes = [0; 5];
            strict.read_exact(&mut bytes).unwrap();
            assert_eq!(&bytes, b"owner");
            strict.seek(SeekFrom::Start(0)).unwrap();
            strict.write_all(b"probe").unwrap();
            owner.seek(SeekFrom::Start(0)).unwrap();
            owner.read_exact(&mut bytes).unwrap();
            assert_eq!(&bytes, b"probe");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_created_reopen_keeps_moved_original_and_preserves_replacement() {
        use std::io::{Seek, SeekFrom};

        for open_or_create in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let parent = windows_test_parent(root.path());
            let path = root.path().join("leaf");
            let moved = root.path().join("moved");
            win::CREATED_TEST_CONTROLS.with(|slot| {
                *slot.borrow_mut() = win::CreatedTestControls {
                    after_create: Some(Box::new(move || {
                        std::fs::rename(&path, moved).unwrap();
                        std::fs::write(path, b"sentinel").unwrap();
                    })),
                    ..Default::default()
                }
            });
            let (mut owner, identity) = if open_or_create {
                let owner = open_or_create_regular_at(&parent, OsStr::new("leaf")).unwrap();
                let identity = owner.identity();
                (owner, identity)
            } else {
                create_regular_at(&parent, OsStr::new("leaf")).unwrap()
            };
            let moved = File::open(root.path().join("moved")).unwrap();
            assert_eq!(
                crate::infra::path_authority::opened_file_identity(&moved).unwrap(),
                identity
            );
            owner.write_all(b"original").unwrap();
            owner.seek(SeekFrom::Start(0)).unwrap();
            let mut bytes = Vec::new();
            owner.read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, b"original");
            assert_eq!(
                std::fs::read(root.path().join("moved")).unwrap(),
                b"original"
            );
            assert_eq!(
                std::fs::read(root.path().join("leaf")).unwrap(),
                b"sentinel"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_created_cleanup_deletes_the_held_object_and_preserves_replacement() {
        let root = tempfile::tempdir().unwrap();
        let parent = windows_test_parent(root.path());
        let path = root.path().join("leaf");
        let moved = root.path().join("moved");
        win::CREATED_TEST_CONTROLS.with(|slot| {
            *slot.borrow_mut() = win::CreatedTestControls {
                identity_failure: true,
                after_create: Some(Box::new(move || {
                    std::fs::rename(&path, moved).unwrap();
                    std::fs::write(path, b"sentinel").unwrap();
                })),
                ..Default::default()
            }
        });
        assert!(create_regular_at(&parent, OsStr::new("leaf")).is_err());
        assert!(!root.path().join("moved").exists());
        assert_eq!(
            std::fs::read(root.path().join("leaf")).unwrap(),
            b"sentinel"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_open_or_create_bounds_competing_changes_without_deleting_the_winner() {
        let root = tempfile::tempdir().unwrap();
        let parent = windows_test_parent(root.path());
        let path = root.path().join("racing");
        let remove = path.clone();
        let count = std::rc::Rc::new(std::cell::Cell::new(0));
        let attempts = count.clone();
        win::CREATED_TEST_CONTROLS.with(|slot| {
            *slot.borrow_mut() = win::CreatedTestControls {
                before_existing_open: Some(Box::new(move || {
                    if remove.exists() {
                        std::fs::remove_file(&remove).unwrap();
                    }
                })),
                before_create: Some(Box::new(move || {
                    attempts.set(attempts.get() + 1);
                    std::fs::write(&path, b"sentinel").unwrap();
                })),
                ..Default::default()
            }
        });
        let error = open_or_create_regular_at(&parent, OsStr::new("racing")).unwrap_err();
        assert!(error.diagnostic().contains("kept changing"));
        assert_eq!(count.get(), win::OPEN_OR_CREATE_RETRIES);
        assert_eq!(
            std::fs::read(root.path().join("racing")).unwrap(),
            b"sentinel"
        );
        win::CREATED_TEST_CONTROLS.with(|slot| *slot.borrow_mut() = Default::default());
    }

    #[cfg(windows)]
    #[test]
    fn windows_private_temp_handoff_failure_compensates_before_return() {
        for admission in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let parent = windows_test_parent(root.path());
            win::CREATED_TEST_CONTROLS.with(|slot| {
                *slot.borrow_mut() = win::CreatedTestControls {
                    identity_failure: !admission,
                    ..Default::default()
                }
            });
            crate::infra::inode_ownership::WINDOWS_CREATED_ADMISSION_FAILURE
                .with(|slot| slot.set(admission));
            let expected = if admission {
                "injected created-file admission failure"
            } else {
                "injected created-file identity failure"
            };
            assert!(win::create_temp(&parent, None)
                .unwrap_err()
                .diagnostic()
                .contains(expected));
            assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
            let (_, file) = win::create_temp(&parent, None).unwrap();
            drop(file);
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_created_cleanup_failure_preserves_sentinel_and_safe_error() {
        let root = tempfile::tempdir().unwrap();
        let parent = windows_test_parent(root.path());
        let path = root.path().join("sentinel");
        win::CREATED_TEST_CONTROLS.with(|slot| {
            *slot.borrow_mut() = win::CreatedTestControls {
                identity_failure: true,
                cleanup_failure: true,
                after_create: Some(Box::new(move || std::fs::write(path, b"sentinel").unwrap())),
                ..Default::default()
            }
        });
        let error = create_regular_at(&parent, OsStr::new("sentinel")).unwrap_err();
        let Error::OperationAndCleanup { primary, cleanup } = &error else {
            panic!("{error:?}")
        };
        assert!(primary.contains("identity failure"));
        assert!(cleanup.contains("disposition failure"));
        assert_eq!(
            std::fs::read(root.path().join("sentinel")).unwrap(),
            b"sentinel"
        );
        let wire = serde_json::to_value(&error).unwrap();
        assert_eq!(wire["category"], "operation-and-cleanup");
        assert_eq!(
            wire["message"],
            "Operation failed; temporary cleanup also failed"
        );
        assert!(!wire.to_string().contains("injected"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_open_or_create_preserves_existing_and_appearing_file_bytes() {
        for appearing in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let parent = windows_test_parent(root.path());
            let path = root.path().join("existing");
            if !appearing {
                std::fs::write(&path, b"sentinel").unwrap();
            }
            win::CREATED_TEST_CONTROLS.with(|slot| {
                *slot.borrow_mut() = win::CreatedTestControls {
                    identity_failure: true,
                    before_create: appearing.then(|| {
                        Box::new(move || std::fs::write(&path, b"sentinel").unwrap())
                            as Box<dyn FnMut()>
                    }),
                    ..Default::default()
                }
            });
            let file = open_or_create_regular_at(&parent, OsStr::new("existing")).unwrap();
            assert_eq!(
                file.identity(),
                crate::infra::path_authority::opened_file_identity(&file).unwrap()
            );
            assert_eq!(
                std::fs::read(root.path().join("existing")).unwrap(),
                b"sentinel"
            );
            win::CREATED_TEST_CONTROLS.with(|slot| *slot.borrow_mut() = Default::default());
        }
    }

    #[cfg(windows)]
    use super::windows_test_parent;
    use super::*;
    use crate::infra::blocking::source_scan::{body_at_indent, braced_body, normalise, Literals};
    use std::{
        io::{Read, Write},
        path::PathBuf,
        sync::{Arc, Mutex},
    };

    #[test]
    fn advisory_lock_contends_then_acquires_after_holder_drops() -> std::io::Result<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("advisory.lock");
        let first = File::options()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)?;
        let second = File::options().read(true).write(true).open(&path)?;
        lock_advisory_file(&first, AdvisoryLockMode::NonBlocking)
            .map_err(AdvisoryLockError::into_io_error)?;
        assert!(matches!(
            lock_advisory_file(&second, AdvisoryLockMode::NonBlocking),
            Err(AdvisoryLockError::HeldElsewhere(_))
        ));
        drop(first);
        retry_until_lock_released(|| {
            match lock_advisory_file(&second, AdvisoryLockMode::NonBlocking) {
                Ok(()) => Some(Ok(())),
                Err(AdvisoryLockError::HeldElsewhere(_)) => None,
                Err(AdvisoryLockError::Io(error)) => Some(Err(error)),
            }
        })
        .expect("advisory lock was not released within the deadline after the holder dropped")?;
        Ok(())
    }

    #[test]
    fn advisory_lock_blocking_acquires_unheld_file() -> std::io::Result<()> {
        let directory = tempfile::tempdir()?;
        let file = File::options()
            .read(true)
            .write(true)
            .create_new(true)
            .open(directory.path().join("advisory.lock"))?;
        lock_advisory_file(&file, AdvisoryLockMode::Blocking)
            .map_err(AdvisoryLockError::into_io_error)?;
        Ok(())
    }

    #[test]
    fn advisory_lock_blocking_waits_for_holder_to_drop() -> std::io::Result<()> {
        use std::sync::mpsc;
        use std::time::Duration;
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("advisory.lock");
        let first = File::options()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)?;
        let second = File::options().read(true).write(true).open(&path)?;
        lock_advisory_file(&first, AdvisoryLockMode::NonBlocking)
            .map_err(AdvisoryLockError::into_io_error)?;
        let (ready_tx, ready_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            ready_tx.send(()).unwrap();
            let result = lock_advisory_file(&second, AdvisoryLockMode::Blocking);
            done_tx.send(result).unwrap();
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let pending = done_rx.recv_timeout(Duration::from_millis(200));
        drop(first);
        assert!(matches!(pending, Err(mpsc::RecvTimeoutError::Timeout)));
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("blocking lock must complete after release")
            .map_err(AdvisoryLockError::into_io_error)?;
        thread.join().unwrap();
        Ok(())
    }

    #[test]
    fn advisory_lock_unsupported_errors_are_platform_specific() {
        use AdvisoryLockPlatform::{Linux, MacOs, Windows};
        for (platform, unsupported, ordinary) in [
            (Linux, &[95, 38][..], &[37, 13][..]),
            (MacOs, &[102, 45, 78][..], &[77, 13][..]),
            (Windows, &[50, 1][..], &[33, 5][..]),
        ] {
            for &code in unsupported {
                assert!(
                    advisory_lock_is_unsupported(code, platform),
                    "{platform:?}: {code}"
                );
            }
            for &code in ordinary {
                assert!(
                    !advisory_lock_is_unsupported(code, platform),
                    "{platform:?}: {code}"
                );
            }
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn advisory_lock_literal_table_matches_native_errno() {
        use rustix::io::Errno;
        #[cfg(target_os = "linux")]
        let platform = AdvisoryLockPlatform::Linux;
        #[cfg(target_os = "macos")]
        let platform = AdvisoryLockPlatform::MacOs;
        for error in [Errno::OPNOTSUPP, Errno::NOTSUP, Errno::NOSYS] {
            assert!(advisory_lock_is_unsupported(error.raw_os_error(), platform));
        }
        assert!(!advisory_lock_is_unsupported(
            Errno::NOLCK.raw_os_error(),
            platform
        ));
    }

    #[cfg(windows)]
    #[test]
    fn advisory_lock_literal_table_matches_native_windows_errors() {
        use windows_sys::Win32::Foundation::{
            ERROR_INVALID_FUNCTION, ERROR_LOCK_VIOLATION, ERROR_NOT_SUPPORTED,
        };
        for code in [ERROR_NOT_SUPPORTED, ERROR_INVALID_FUNCTION] {
            assert!(advisory_lock_is_unsupported(
                code as i32,
                AdvisoryLockPlatform::Windows
            ));
        }
        assert!(!advisory_lock_is_unsupported(
            ERROR_LOCK_VIOLATION as i32,
            AdvisoryLockPlatform::Windows
        ));
    }

    #[test]
    fn write_if_changed_leaves_identical_bytes_untouched() {
        let directory = tempfile::tempdir().expect("binding directory");
        let path = directory.path().join("generated.ts");

        write_if_changed(&path, "first").expect("create");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");

        let pinned = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(pinned)
            .unwrap();
        write_if_changed(&path, "first").expect("identical");
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            pinned
        );

        write_if_changed(&path, "second").expect("changed");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
        assert_ne!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            pinned
        );

        set_test_atomic_file_injector(Some(Arc::new(ParentSyncFault("uncertain"))));
        let uncertain = write_if_changed(&path, "third");
        set_test_atomic_file_injector(None);
        let message = format!("{:?}", uncertain.expect_err("uncertain commit"));
        assert!(message.contains("durability is uncertain"), "{message}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "third");

        assert!(write_if_changed(directory.path(), "unreadable").is_err());
    }

    #[test]
    fn write_if_changed_missing_entry_preserves_native_durability_classification() {
        use crate::error::ErrorCategory;

        struct RawParentSyncFault(i32);
        impl AtomicWriterInjector for RawParentSyncFault {
            fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
                if point == AtomicFileFaultPoint::ParentSync {
                    Err(std::io::Error::from_raw_os_error(self.0))
                } else {
                    Ok(())
                }
            }
        }

        #[cfg(unix)]
        let cases = [
            (libc::ENOENT, true, ErrorCategory::MissingResource),
            (libc::EACCES, false, ErrorCategory::Permission),
        ];
        #[cfg(windows)]
        let cases = [(
            windows_sys::Win32::Foundation::ERROR_BAD_NETPATH as i32,
            false,
            ErrorCategory::Io,
        )];
        for (code, missing, category) in cases {
            let directory = tempfile::tempdir().expect("binding directory");
            let path = directory.path().join("generated.ts");
            set_test_atomic_file_injector(Some(Arc::new(RawParentSyncFault(code))));
            let result = write_if_changed(&path, "committed bytes");
            set_test_atomic_file_injector(None);

            let error = result.expect_err("parent sync fault must report an uncertain commit");
            assert_eq!(error.is_missing_entry(), missing);
            assert_eq!(error.category(), category);
            assert!(error
                .diagnostic()
                .contains("replaced, but durability is uncertain"));
            assert!(matches!(error, Error::Io(error) if error.raw_os_error().is_none()));
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "committed bytes");
        }
    }

    /// The module's dual-cfg parent pair, so a test that needs only `std::fs` plus a retained
    /// parent handle runs on both targets instead of being gated to unix by its fixture.
    fn test_parent(path: &std::path::Path) -> File {
        #[cfg(unix)]
        {
            File::open(path).expect("open parent")
        }
        #[cfg(windows)]
        {
            windows_test_parent(path)
        }
    }

    fn enumerated_entry(parent: &File, leaf: &OsStr) -> DirectoryEntry {
        enumerated_directory_entry_for_test(parent, leaf)
    }

    fn opened_modified_seconds(file: &impl crate::infra::inode_ownership::FileMetadata) -> i64 {
        let metadata = file.metadata().expect("retained metadata");
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            metadata.mtime()
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            win::filetime_to_unix_seconds(metadata.last_write_time() as i64)
        }
    }

    #[test]
    fn installed_file_seconds_match_pre_epoch_enumeration() {
        let directory = tempfile::tempdir().expect("directory");
        let parent = test_parent(directory.path());
        let leaf = OsStr::new("old.pgn");
        let installed = atomic_replace_at_identified(&parent, leaf, |file| {
            file.write_all(b"*").map_err(io)?;
            file.set_modified(SystemTime::UNIX_EPOCH - std::time::Duration::from_secs(1))
                .map_err(io)
        })
        .expect("install");
        installed.outcome.expect_durable();
        let listed = enumerated_entry(&parent, leaf);
        assert!(installed.modified_seconds < 0);
        assert_eq!(installed.modified_seconds, listed.modified_seconds);
        assert_eq!(installed.identity, listed.identity);
    }

    #[test]
    fn post_rename_metadata_failure_keeps_pre_rename_seconds() {
        for modified in [
            SystemTime::UNIX_EPOCH - std::time::Duration::from_secs(1),
            SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000),
        ] {
            let directory = tempfile::tempdir().expect("directory");
            let parent = test_parent(directory.path());
            let leaf = OsStr::new("target");
            let mut fallback_seconds = None;
            set_test_atomic_file_injector(Some(Arc::new(Fault(
                Some(AtomicFileFaultPoint::PostRenameMetadata),
                None,
                Arc::new(Mutex::new(Vec::new())),
            ))));
            let result = atomic_replace_at_identified(&parent, leaf, |file| {
                file.write_all(b"new").map_err(io)?;
                file.set_modified(modified).map_err(io)?;
                fallback_seconds = Some(opened_modified_seconds(file));
                Ok(())
            });
            set_test_atomic_file_injector(None);
            let installed = result.expect("committed install retains fallback metadata");
            assert!(matches!(
                installed.outcome,
                AtomicFileOutcome::CommittedDurabilityUncertain(_)
            ));
            assert_eq!(Some(installed.modified_seconds), fallback_seconds);
            assert_eq!(installed.identity, enumerated_entry(&parent, leaf).identity);
        }
    }

    #[cfg(unix)]
    #[test]
    fn post_rename_seconds_follow_the_retained_descriptor_across_a_swap() {
        struct SwapInstalledFile(PathBuf);
        impl AtomicWriterInjector for SwapInstalledFile {
            fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
                if point == AtomicFileFaultPoint::PostRenameMetadata {
                    std::fs::rename(&self.0, self.0.with_extension("saved"))?;
                    std::fs::write(&self.0, b"replacement")?;
                    File::options().write(true).open(&self.0)?.set_modified(
                        SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(777),
                    )?;
                }
                Ok(())
            }
        }
        let directory = tempfile::tempdir().expect("directory");
        let parent = test_parent(directory.path());
        let leaf = OsStr::new("target");
        set_test_atomic_file_injector(Some(Arc::new(SwapInstalledFile(
            directory.path().join(leaf),
        ))));
        let result = atomic_replace_at_identified(&parent, leaf, |file| {
            file.write_all(b"installed").map_err(io)?;
            file.set_modified(SystemTime::UNIX_EPOCH - std::time::Duration::from_secs(1))
                .map_err(io)
        });
        set_test_atomic_file_injector(None);
        let installed = result.expect("install");
        installed.outcome.expect_durable();
        let saved = enumerated_entry(&parent, OsStr::new("target.saved"));
        let replacement = enumerated_entry(&parent, leaf);
        assert_eq!(installed.modified_seconds, saved.modified_seconds);
        assert_eq!(installed.identity, saved.identity);
        assert_ne!(installed.modified_seconds, replacement.modified_seconds);
        assert_ne!(installed.identity, replacement.identity);
    }

    #[cfg(unix)]
    fn inode(path: &std::path::Path) -> (u64, u64) {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::symlink_metadata(path).expect("metadata");
        (metadata.dev(), metadata.ino())
    }

    #[test]
    fn bounded_reader_accepts_zero_and_exact_limits_and_detects_one_excess_byte() {
        let mut empty = std::io::Cursor::new(Vec::<u8>::new());
        assert_eq!(
            read_bounded_bytes(&mut empty, 0, 0, "too large", || Ok(())).unwrap(),
            b""
        );
        let mut exact = std::io::Cursor::new(b"exact".to_vec());
        assert_eq!(
            read_bounded_bytes(&mut exact, u64::MAX, 5, "too large", || Ok(())).unwrap(),
            b"exact"
        );
        let mut excess = std::io::Cursor::new(b"excess".to_vec());
        assert!(matches!(
            read_bounded_bytes(&mut excess, 0, 5, "too large", || Ok(())),
            Err(Error::ResourceLimit(_))
        ));
        assert_eq!(excess.position(), 6, "reader consumes only cap plus one");
    }

    #[test]
    fn bounded_reader_retries_interrupted_and_propagates_io_and_checkpoint_errors() {
        struct InterruptedOnce {
            interrupted: bool,
            bytes: std::io::Cursor<Vec<u8>>,
        }
        impl Read for InterruptedOnce {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                if !self.interrupted {
                    self.interrupted = true;
                    return Err(std::io::Error::from(std::io::ErrorKind::Interrupted));
                }
                self.bytes.read(output)
            }
        }
        let mut interrupted = InterruptedOnce {
            interrupted: false,
            bytes: std::io::Cursor::new(b"ok".to_vec()),
        };
        assert_eq!(
            read_bounded_bytes(&mut interrupted, 2, 2, "too large", || Ok(())).unwrap(),
            b"ok"
        );

        let mut interrupted_then_cancelled = InterruptedOnce {
            interrupted: false,
            bytes: std::io::Cursor::new(b"unread".to_vec()),
        };
        let mut checkpoints = 0;
        let error = read_bounded_bytes(&mut interrupted_then_cancelled, 6, 6, "too large", || {
            checkpoints += 1;
            if checkpoints == 3 {
                Err(Error::Cancellation)
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert!(matches!(error, Error::Cancellation));
        assert_eq!(interrupted_then_cancelled.bytes.position(), 0);

        let mut failed = std::io::repeat(0).take(1);
        let error = read_bounded_bytes(&mut failed, 1, 1, "too large", || Err(Error::Cancellation))
            .unwrap_err();
        assert!(matches!(error, Error::Cancellation));

        struct FailedReader;
        impl Read for FailedReader {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("read failed"))
            }
        }
        assert!(matches!(
            read_bounded_bytes(&mut FailedReader, 0, 1, "too large", || Ok(())),
            Err(Error::Io(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn read_directory_entries_at_classifies_without_following() {
        use std::os::unix::fs::symlink;
        use std::os::unix::net::UnixListener;
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("directory");
        std::fs::create_dir(&directory).unwrap();
        let regular = root.path().join("regular");
        std::fs::write(&regular, b"regular").unwrap();
        symlink(&directory, root.path().join("outside-link")).unwrap();
        symlink(&regular, root.path().join("file-link")).unwrap();
        let handle = File::open(root.path()).unwrap();
        let _socket = UnixListener::bind(root.path().join("socket")).unwrap();
        let entries =
            read_directory_entries_at(&handle, &CancellationToken::new(), None, &mut |_| true)
                .unwrap();
        assert_eq!(entries.len(), 5);
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry.name == "regular")
                .unwrap()
                .kind,
            DirectoryEntryKind::RegularFile
        );
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry.name == "directory")
                .unwrap()
                .kind,
            DirectoryEntryKind::Directory
        );
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.kind == DirectoryEntryKind::Other)
                .count(),
            3
        );
        for entry in entries {
            assert_ne!(entry.name, ".");
            assert_ne!(entry.name, "..");
            assert_eq!(entry.identity, inode(&root.path().join(&entry.name)));
        }
    }

    #[test]
    fn directory_listing_bound_counts_names_before_filtering_and_preserves_none(
    ) -> Result<(), Error> {
        let root = tempfile::tempdir()?;
        #[cfg(unix)]
        let dir = File::open(root.path())?;
        #[cfg(windows)]
        let dir = win::open_directory_path(root.path(), false)?;
        let token = CancellationToken::new();
        for index in 0..MAX_DIRECTORY_LISTING_ENTRIES {
            std::fs::write(root.path().join(format!("{index}.txt")), b"")?;
        }
        let exact = read_directory_entries_at(
            &dir,
            &token,
            Some(MAX_DIRECTORY_LISTING_ENTRIES),
            &mut |_| true,
        )?;
        assert_eq!(exact.len(), MAX_DIRECTORY_LISTING_ENTRIES);
        std::fs::write(root.path().join("overflow.txt"), b"")?;
        for keep_all in [true, false] {
            assert!(matches!(
                read_directory_entries_at(
                    &dir,
                    &token,
                    Some(MAX_DIRECTORY_LISTING_ENTRIES),
                    &mut |_| keep_all
                ),
                Err(ref error) if matches!(error.unlabelled(), Error::ResourceLimit(_))
            ));
        }
        let unbounded = read_directory_entries_at(&dir, &token, None, &mut |_| true)?;
        assert_eq!(unbounded.len(), MAX_DIRECTORY_LISTING_ENTRIES + 1);
        token.cancel();
        assert!(matches!(
            read_directory_entries_at(
                &dir,
                &token,
                Some(MAX_DIRECTORY_LISTING_ENTRIES),
                &mut |_| true
            ),
            Err(Error::Cancellation)
        ));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn directory_listing_bound_cancellation_precedes_next_name() -> Result<(), Error> {
        let root = tempfile::tempdir()?;
        std::fs::write(root.path().join("a"), b"")?;
        std::fs::write(root.path().join("b"), b"")?;
        let dir = File::open(root.path())?;
        let token = CancellationToken::new();
        let result = read_directory_entries_at(&dir, &token, Some(1), &mut |_| {
            token.cancel();
            false
        });
        assert!(matches!(result, Err(Error::Cancellation)));
        Ok(())
    }

    #[test]
    fn directory_listing_bound_resource_limit_serializes_command_category(
    ) -> Result<(), serde_json::Error> {
        let error = Error::ResourceLimit("directory listing exceeded 4096 entries".into());
        let payload = serde_json::to_value(&error)?;
        assert_eq!(payload["category"], "resource-limit");
        assert_eq!(payload["tag"], "backend-error");
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn read_directory_entries_at_stats_only_after_keep() {
        let root = tempfile::tempdir().unwrap();
        for name in ["a", "b", "c"] {
            std::fs::write(root.path().join(name), name).unwrap();
        }
        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let hook_events = Arc::clone(&events);
        set_read_directory_pre_stat_hook(Some(Box::new(move |name| {
            hook_events
                .lock()
                .unwrap()
                .push(format!("stat:{}", name.to_string_lossy()));
        })));
        let keep_events = Arc::clone(&events);
        let root_path = root.path().to_path_buf();
        let mut keep = move |name: &OsStr| {
            keep_events
                .lock()
                .unwrap()
                .push(format!("keep:{}", name.to_string_lossy()));
            if name != OsStr::new("b") {
                std::fs::remove_file(root_path.join(name)).unwrap();
                false
            } else {
                true
            }
        };
        let handle = File::open(root.path()).unwrap();
        let result = read_directory_entries_at(&handle, &CancellationToken::new(), None, &mut keep);
        set_read_directory_pre_stat_hook(None);
        assert!(result.is_ok());
        let log = events.lock().unwrap().clone();
        assert_eq!(
            log.iter()
                .filter(|event| event.starts_with("stat:"))
                .count(),
            1
        );
        let stat_index = log.iter().position(|event| event == "stat:b").unwrap();
        let keep_index = log.iter().position(|event| event == "keep:b").unwrap();
        assert!(keep_index < stat_index);
    }

    #[cfg(unix)]
    #[test]
    fn read_directory_entries_at_checks_cancellation_before_opening() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("file");
        std::fs::write(&file, b"file").unwrap();
        let descriptor = File::open(file).unwrap();
        let token = CancellationToken::new();
        token.cancel();
        assert!(matches!(
            read_directory_entries_at(&descriptor, &token, None, &mut |_| true),
            Err(Error::Cancellation)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn read_directory_entries_at_skips_the_stat_once_keep_cancels() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a"), b"a").unwrap();
        std::fs::write(root.path().join("b"), b"b").unwrap();
        let token = CancellationToken::new();
        let worker = token.clone();
        let fired = Arc::new(Mutex::new(false));
        let observed = Arc::clone(&fired);
        set_read_directory_pre_stat_hook(Some(Box::new(move |_| {
            *observed.lock().unwrap() = true;
        })));
        let handle = File::open(root.path()).unwrap();
        let result = read_directory_entries_at(&handle, &token, None, &mut |_| {
            worker.cancel();
            true
        });
        set_read_directory_pre_stat_hook(None);
        assert!(matches!(result, Err(Error::Cancellation)));
        assert!(!*fired.lock().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn read_directory_entries_at_checks_cancellation_at_end_of_stream() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a"), b"a").unwrap();
        let token = CancellationToken::new();
        let worker = token.clone();
        set_read_directory_pre_stat_hook(Some(Box::new(move |_| worker.cancel())));
        let handle = File::open(root.path()).unwrap();
        let result = read_directory_entries_at(&handle, &token, None, &mut |_| true);
        set_read_directory_pre_stat_hook(None);
        assert!(matches!(result, Err(Error::Cancellation)));
    }

    #[cfg(unix)]
    #[test]
    fn read_directory_entries_at_fails_for_an_entry_removed_before_stat() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("a");
        std::fs::write(&path, b"a").unwrap();
        let remove = path.clone();
        set_read_directory_pre_stat_hook(Some(Box::new(move |_| {
            std::fs::remove_file(&remove).unwrap();
        })));
        let handle = File::open(root.path()).unwrap();
        let result =
            read_directory_entries_at(&handle, &CancellationToken::new(), None, &mut |_| true);
        set_read_directory_pre_stat_hook(None);
        assert!(
            matches!(result, Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound)
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_directory_entries_at_refuses_a_removed_directory() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("directory");
        std::fs::create_dir(&directory).unwrap();
        let handle = File::open(&directory).unwrap();
        std::fs::remove_dir(&directory).unwrap();
        assert!(matches!(
            read_directory_entries_at(&handle, &CancellationToken::new(), None, &mut |_| true),
            Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound
        ));
    }

    #[cfg(unix)]
    #[test]
    fn held_matches_path_compares_the_held_and_named_identities() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("directory");
        std::fs::create_dir(&directory).unwrap();
        let handle = File::open(&directory).unwrap();

        assert!(held_matches_path(&handle, &directory).unwrap());
        std::fs::remove_dir(&directory).unwrap();
        assert!(!held_matches_path(&handle, &directory).unwrap());
        std::fs::create_dir(&directory).unwrap();
        assert!(!held_matches_path(&handle, &directory).unwrap());
    }

    #[cfg(unix)]
    fn assert_directory_removed_during_enumeration(error: &Error) {
        assert!(matches!(
            error,
            Error::Io(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && error.to_string() == "directory was removed during enumeration"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn read_directory_entries_at_refuses_a_directory_removed_after_the_walk() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("directory");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("entry"), b"entry").unwrap();
        let handle = File::open(&directory).unwrap();
        let injector = Arc::new(PostWalkMutation::new(
            directory.clone(),
            PostWalkAction::Remove,
        ));

        let result = {
            let _guard = unix::scoped_test_removal_injector(injector);
            read_directory_entries_at(&handle, &CancellationToken::new(), None, &mut |_| true)
        };

        let error = result.expect_err("post-walk removal must be refused");
        assert_directory_removed_during_enumeration(&error);
    }

    #[cfg(unix)]
    #[test]
    fn read_directory_entries_at_rejects_a_same_name_directory_replacement() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("directory");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("entry"), b"entry").unwrap();
        let handle = File::open(&directory).unwrap();
        let injector = Arc::new(PostWalkMutation::new(
            directory.clone(),
            PostWalkAction::ReplaceWithSentinel,
        ));

        let result = {
            let _guard = unix::scoped_test_removal_injector(injector);
            read_directory_entries_at(&handle, &CancellationToken::new(), None, &mut |_| true)
        };

        let error = result.expect_err("same-name replacement must be refused");
        assert_directory_removed_during_enumeration(&error);
        assert_eq!(
            std::fs::read(directory.join("sentinel")).unwrap(),
            b"sentinel"
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_directory_entries_at_accepts_a_directory_renamed_after_the_walk() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("directory");
        let moved = root.path().join("moved");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("entry"), b"entry").unwrap();
        let handle = File::open(&directory).unwrap();
        let injector = Arc::new(PostWalkMutation::new(
            directory,
            PostWalkAction::RenameAway {
                destination: moved.clone(),
            },
        ));

        let result = {
            let _guard = unix::scoped_test_removal_injector(injector);
            read_directory_entries_at(&handle, &CancellationToken::new(), None, &mut |_| true)
        };

        assert!(
            result.is_ok(),
            "rename-away must preserve the held directory"
        );
        assert!(moved.join("entry").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn read_directory_entries_at_keeps_cancellation_precedence_at_the_post_walk_point() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("directory");
        std::fs::create_dir(&directory).unwrap();
        let handle = File::open(&directory).unwrap();
        let token = CancellationToken::new();
        let injector = Arc::new(
            PostWalkMutation::new(directory, PostWalkAction::Remove)
                .with_cancellation(token.clone()),
        );

        let result = {
            let _guard = unix::scoped_test_removal_injector(injector);
            read_directory_entries_at(&handle, &token, None, &mut |_| true)
        };

        assert!(matches!(result, Err(Error::Cancellation)));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn read_directory_entries_at_maps_getpath_enotdir_to_removed_directory() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("parent");
        let directory = parent.join("directory");
        std::fs::create_dir_all(&directory).unwrap();
        let handle = File::open(&directory).unwrap();
        let injector = Arc::new(PostWalkMutation::new(
            directory,
            PostWalkAction::RemoveParentAndCreateFile {
                parent: parent.clone(),
            },
        ));

        let result = {
            let _guard = unix::scoped_test_removal_injector(injector);
            read_directory_entries_at(&handle, &CancellationToken::new(), None, &mut |_| true)
        };

        let error = result.expect_err("parent replacement must be refused");
        assert_directory_removed_during_enumeration(&error);
        assert!(std::fs::metadata(parent).unwrap().is_file());
    }

    #[test]
    fn directory_types_carry_no_pathname() {
        // Both types cross from an enumeration to a later identity check, so what must stay true
        // is the field set: a leaf name, a kind, an identity and a timestamp — never a pathname a
        // caller could feed back, and never one the OS would re-walk. The fields are
        // platform-neutral since the Windows listing arm landed, so the assertion is on the
        // declared fields rather than on a `#[cfg(unix)]` shape; an added `Path`, `PathBuf`,
        // `OsString` path or `String` path field reddens it on every target.
        fn declared_fields(body: &str) -> Vec<(String, String)> {
            body.lines()
                .skip(1)
                .map(str::trim)
                .filter(|line| {
                    !line.is_empty()
                        && !line.starts_with("//")
                        && !line.starts_with("#[")
                        && !line.starts_with('}')
                })
                .map(|line| {
                    let line = line.trim_end_matches(',');
                    let (name, kind) = line.split_once(": ").unwrap_or((line, ""));
                    (
                        name.rsplit(' ').next().unwrap_or(name).to_owned(),
                        kind.to_owned(),
                    )
                })
                .collect()
        }

        let source = include_str!("fs.rs");
        let directory = body_at_indent(source, "pub(crate) struct DirectoryEntry {");
        assert_eq!(
            declared_fields(directory),
            vec![
                ("name".to_owned(), "OsString".to_owned()),
                ("kind".to_owned(), "DirectoryEntryKind".to_owned()),
                ("identity".to_owned(), "(u64, u64)".to_owned()),
                ("modified_seconds".to_owned(), "i64".to_owned()),
            ],
            "DirectoryEntry field set changed: {directory}"
        );
        let capability_source = include_str!("path_authority/mod.rs");
        let capability =
            body_at_indent(capability_source, "pub(crate) struct CapabilityDirectory {");
        assert_eq!(
            declared_fields(capability),
            vec![("directory".to_owned(), "fs::File".to_owned())],
            "CapabilityDirectory field set changed: {capability}"
        );
        for (name, kind) in declared_fields(directory)
            .into_iter()
            .chain(declared_fields(capability))
        {
            let lowercase = format!("{name} {kind}").to_lowercase();
            assert!(
                !lowercase.contains("path"),
                "directory types must carry identity, never a pathname: {name}: {kind}"
            );
        }
    }

    #[test]
    fn mark_engine_executable_uses_checked_raw_mode() {
        let source = include_str!("path_authority/resolved.rs");
        let body = braced_body(source, "pub(crate) fn mark_engine_executable(");
        let compact: String = normalise(&source[body.clone()], Literals::Blank)
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect();
        assert!(compact.contains("Mode::from_raw_mode(crate::infra::fs::raw_mode_from(mode)?)"));
        assert_eq!(compact.matches("from_raw_mode(").count(), 1);
        assert!(!normalise(&source[body], Literals::Blank).contains(" as "));
    }

    #[test]
    fn bounded_reader_checks_cancellation_between_reads_and_after_eof() {
        struct OneByteReader(std::io::Cursor<Vec<u8>>);
        impl Read for OneByteReader {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                self.0.read(&mut output[..1])
            }
        }
        let mut between = OneByteReader(std::io::Cursor::new(b"two".to_vec()));
        let mut checkpoints = 0;
        let error = read_bounded_bytes(&mut between, 3, 3, "too large", || {
            checkpoints += 1;
            if checkpoints == 3 {
                Err(Error::Cancellation)
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert!(matches!(error, Error::Cancellation));
        assert_eq!(between.0.position(), 1);

        use std::{cell::Cell, rc::Rc};
        struct EofSignallingReader {
            bytes: std::io::Cursor<Vec<u8>>,
            saw_eof: Rc<Cell<bool>>,
        }
        impl Read for EofSignallingReader {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                let read = self.bytes.read(output)?;
                if read == 0 {
                    self.saw_eof.set(true);
                }
                Ok(read)
            }
        }
        let saw_eof = Rc::new(Cell::new(false));
        let checkpoint_eof = Rc::clone(&saw_eof);
        let mut after_eof = EofSignallingReader {
            bytes: std::io::Cursor::new(b"done".to_vec()),
            saw_eof,
        };
        let error = read_bounded_bytes(&mut after_eof, 4, 4, "too large", || {
            if checkpoint_eof.get() {
                Err(Error::Cancellation)
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert!(matches!(error, Error::Cancellation));
        assert_eq!(after_eof.bytes.position(), 4);
    }

    #[cfg(unix)]
    #[test]
    fn verified_parent_rejects_an_intermediate_symlink_swap() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("root");
        let nested = root.join("nested");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&root).expect("root");
        std::fs::create_dir(&nested).expect("nested");
        std::fs::create_dir(&outside).expect("outside");
        let entry = nested.join("game.pgn");
        std::fs::write(&entry, b"trusted").expect("entry");
        std::fs::write(outside.join("game.pgn"), b"outside").expect("outside entry");
        let expected = inode(&entry);
        std::fs::rename(&nested, root.join("nested-old")).expect("move nested");
        std::os::unix::fs::symlink(&outside, &nested).expect("swap link");

        assert!(matches!(
            open_verified_parent(&entry, expected, false, ParentAccess::Readable),
            Err(Error::Io(_))
        ));
        assert_eq!(
            std::fs::read(outside.join("game.pgn")).expect("outside intact"),
            b"outside"
        );
    }

    #[cfg(unix)]
    #[test]
    fn verified_directory_refuses_a_mismatched_identity() {
        let temp = tempfile::tempdir().expect("tempdir");
        let opened_path = temp.path().join("opened");
        let expected_path = temp.path().join("expected");
        std::fs::create_dir(&opened_path).expect("opened directory");
        std::fs::create_dir(&expected_path).expect("expected directory");
        let opened = File::open(&opened_path).expect("opened descriptor");

        assert!(matches!(
            VerifiedDir::new(opened, inode(&expected_path)),
            Err(Error::Conflict(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn open_verified_directory_contains_exactly_one_openat() {
        let source = include_str!("fs.rs");
        let body = body_at_indent(source, "fn open_verified_directory(");
        assert_eq!(body.matches("openat").count(), 1, "{body}");
    }

    #[cfg(unix)]
    #[test]
    fn open_regular_at_opens_exact_regular_file_bytes() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("track.mp3"), b"exact bytes").expect("write file");
        let parent = File::open(temp.path()).expect("open parent");
        let mut opened = open_regular_at(
            &parent,
            OsStr::new("track.mp3"),
            RegularFileAccess::ReadOnly,
        )
        .expect("open leaf");
        let mut bytes = Vec::new();
        opened.read_to_end(&mut bytes).expect("read leaf");
        assert_eq!(bytes, b"exact bytes");
    }

    #[cfg(unix)]
    #[test]
    fn open_regular_at_supports_explicit_read_write_access() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("game.pgn");
        std::fs::write(&path, b"old").expect("write file");
        let parent = File::open(temp.path()).expect("open parent");
        let mut opened = open_regular_at(
            &parent,
            OsStr::new("game.pgn"),
            RegularFileAccess::ReadWrite,
        )
        .expect("open read/write");
        opened.write_all(b"!").expect("write descriptor");
        drop(opened);
        assert_eq!(std::fs::read(path).unwrap(), b"!ld");
    }

    #[cfg(unix)]
    #[test]
    fn open_regular_at_refuses_a_symlink_leaf() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("target"), b"target").expect("write target");
        std::os::unix::fs::symlink("target", temp.path().join("link")).expect("link");
        let parent = File::open(temp.path()).expect("open parent");
        assert!(open_regular_at(&parent, OsStr::new("link"), RegularFileAccess::ReadOnly).is_err());
    }

    #[test]
    fn native_export_dest_refuses_wrong_extension() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("missing").join("board.jpg");
        let error = NativeExportDest::from_save_path(path.clone(), "png")
            .expect_err("wrong extension must be refused");
        assert!(
            matches!(&error, Error::InvalidInput(message) if message == "export must use .png extension"),
            "extension must be checked before the parent is opened: {error:?}"
        );
        assert!(!path.exists());
        assert!(!temp.path().join("missing").exists());
    }

    #[cfg(unix)]
    #[test]
    fn native_export_dest_refuses_symlink_leaf() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("target.png"), b"target").expect("write target");
        let link = temp.path().join("board.png");
        std::os::unix::fs::symlink("target.png", &link).expect("link");
        let dest = NativeExportDest::from_save_path(link.clone(), "png").expect("dest");
        let error = dest
            .replace(|file| file.write_all(b"png").map_err(Error::from))
            .expect_err("symlink leaf must be refused");
        assert!(
            matches!(error, Error::InvalidInput(_)),
            "unexpected error: {error:?}"
        );
        assert!(std::fs::symlink_metadata(&link)
            .expect("link remains")
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read(temp.path().join("target.png")).unwrap(),
            b"target"
        );
    }

    #[cfg(unix)]
    #[test]
    fn native_export_dest_write_follows_held_parent_after_rename() {
        let temp = tempfile::tempdir().expect("tempdir");
        let original = temp.path().join("original");
        let moved = temp.path().join("moved");
        std::fs::create_dir(&original).expect("original");
        let dest =
            NativeExportDest::from_save_path(original.join("board.png"), "png").expect("dest");
        std::fs::rename(&original, &moved).expect("rename parent");
        std::fs::create_dir(&original).expect("replacement parent");
        let outcome = dest
            .replace(|file| file.write_all(b"png").map_err(Error::from))
            .expect("replace");
        assert!(matches!(outcome, AtomicFileOutcome::DurableCommit));
        assert_eq!(std::fs::read(moved.join("board.png")).unwrap(), b"png");
        assert!(!original.join("board.png").exists());
    }

    #[cfg(unix)]
    #[test]
    fn open_regular_at_refuses_a_directory_leaf() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(temp.path().join("directory")).expect("directory");
        let parent = File::open(temp.path()).expect("open parent");
        assert!(open_regular_at(
            &parent,
            OsStr::new("directory"),
            RegularFileAccess::ReadOnly
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn open_regular_at_refuses_a_fifo_leaf() {
        let temp = tempfile::tempdir().expect("tempdir");
        let fifo = temp.path().join("fifo");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .expect("run mkfifo");
        assert!(status.success(), "mkfifo failed with {status}");
        let parent = File::open(temp.path()).expect("open parent");
        assert!(open_regular_at(&parent, OsStr::new("fifo"), RegularFileAccess::ReadOnly).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn open_regular_at_refuses_a_multicomponent_leaf() {
        let temp = tempfile::tempdir().expect("tempdir");
        let parent = File::open(temp.path()).expect("open parent");
        assert!(open_regular_at(
            &parent,
            OsStr::new("nested/file"),
            RegularFileAccess::ReadOnly
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn open_regular_at_refuses_an_empty_leaf() {
        let temp = tempfile::tempdir().expect("tempdir");
        let parent = File::open(temp.path()).expect("open parent");
        assert!(open_regular_at(&parent, OsStr::new(""), RegularFileAccess::ReadOnly).is_err());
    }

    #[test]
    fn create_regular_at_is_exclusive_and_returns_the_created_identity() {
        let temp = tempfile::tempdir().expect("tempdir");
        #[cfg(unix)]
        let parent = File::open(temp.path()).expect("open parent");
        #[cfg(windows)]
        let parent = windows_test_parent(temp.path());
        let (created, identity) =
            create_regular_at(&parent, OsStr::new("database.db3")).expect("create regular leaf");
        assert_eq!(created.metadata().expect("created metadata").len(), 0);
        assert_eq!(
            entry_identity_at(&parent, OsStr::new("database.db3"), false).unwrap(),
            identity
        );
        match create_regular_at(&parent, OsStr::new("database.db3")) {
            Err(Error::Io(error)) => {
                assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists)
            }
            other => panic!("expected AlreadyExists, got {other:?}"),
        }
    }

    #[test]
    fn create_dir_at_is_exclusive_and_reports_already_exists() {
        let temp = tempfile::tempdir().expect("tempdir");
        #[cfg(unix)]
        let parent = File::open(temp.path()).expect("open parent");
        #[cfg(windows)]
        let parent = windows_test_parent(temp.path());
        create_dir_at(&parent, OsStr::new("folder")).expect("create directory");
        match create_dir_at(&parent, OsStr::new("folder")) {
            Err(Error::Io(error)) => {
                assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists)
            }
            other => panic!("expected AlreadyExists, got {other:?}"),
        }
    }

    #[test]
    fn archive_staging_authority_exclusive_collision_and_bounded_retries() {
        let root = tempfile::tempdir().unwrap();
        let parent = test_parent(root.path());
        std::fs::create_dir(root.path().join("collision")).unwrap();
        std::fs::write(root.path().join("collision/foreign"), b"keep").unwrap();
        STAGING_DIRECTORY_NAMES
            .with(|slot| *slot.borrow_mut() = vec!["owned".into(), "collision".into()]);
        let staging = OwnedStagingDir::create_in(&parent, ".archive").unwrap();
        assert_eq!(staging.binding().1, OsStr::new("owned"));
        assert_eq!(
            std::fs::read(root.path().join("collision/foreign")).unwrap(),
            b"keep"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                root.path()
                    .join("owned")
                    .metadata()
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        drop(staging);
        assert!(!root.path().join("owned").exists());
        STAGING_DIRECTORY_NAMES.with(|slot| {
            *slot.borrow_mut() = vec!["collision".into(); STAGING_DIRECTORY_CREATE_ATTEMPTS]
        });
        let error = OwnedStagingDir::create_in(&parent, ".archive")
            .err()
            .unwrap();
        assert!(
            matches!(error, Error::Io(ref error) if error.kind() == std::io::ErrorKind::AlreadyExists),
            "{error}"
        );
        assert!(STAGING_DIRECTORY_NAMES.with(|slot| slot.borrow().is_empty()));
        assert_eq!(
            std::fs::read(root.path().join("collision/foreign")).unwrap(),
            b"keep"
        );
    }

    #[test]
    fn archive_staging_authority_post_create_failure_cleans_and_preserves_original_error() {
        let root = tempfile::tempdir().unwrap();
        let parent = test_parent(root.path());
        STAGING_DIRECTORY_NAMES.with(|slot| *slot.borrow_mut() = vec!["owned".into()]);
        let _reset = install_test_atomic_file_injector(Arc::new(ParentSyncFault(
            "archive initialization failure",
        )));
        let error = OwnedStagingDir::create_in(&parent, ".archive")
            .err()
            .unwrap();
        assert!(
            matches!(&error, Error::Io(error) if error.to_string() == "archive initialization failure"),
            "{error}"
        );
        assert!(
            !root.path().join("owned").exists(),
            "initialized owner must clean on parent sync failure"
        );
    }

    #[test]
    fn archive_staging_authority_post_create_substitution_keeps_foreign_entry() {
        let root = tempfile::tempdir().unwrap();
        let parent = test_parent(root.path());
        STAGING_DIRECTORY_NAMES.with(|slot| *slot.borrow_mut() = vec!["owned".into()]);
        let path = root.path().to_path_buf();
        STAGING_DIRECTORY_INITIALIZED_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move |_| {
                std::fs::rename(path.join("owned"), path.join("moved")).unwrap();
                std::fs::create_dir(path.join("owned")).unwrap();
                std::fs::write(path.join("owned/foreign"), b"keep").unwrap();
            }))
        });
        let _reset = install_test_atomic_file_injector(Arc::new(ParentSyncFault(
            "archive initialization failure",
        )));
        let error = OwnedStagingDir::create_in(&parent, ".archive")
            .err()
            .unwrap();
        assert!(
            matches!(&error, Error::Io(error) if error.to_string() == "archive initialization failure"),
            "{error}"
        );
        assert_eq!(
            std::fs::read(root.path().join("owned/foreign")).unwrap(),
            b"keep",
            "cleanup must preserve substituted staging entry"
        );
        assert!(root.path().join("moved").is_dir());
    }

    #[test]
    fn create_dir_at_parent_sync_failure_is_io_for_adapter() {
        let temp = tempfile::tempdir().expect("tempdir");
        let parent = test_parent(temp.path());
        set_test_atomic_file_injector(Some(Arc::new(ParentSyncFault("uncertain"))));
        let adapter = create_dir_at(&parent, OsStr::new("folder"));
        let committed = create_dir_at_committed(&parent, OsStr::new("other"));
        set_test_atomic_file_injector(None);
        assert!(
            matches!(adapter, Err(Error::Io(_))),
            "adapter must keep Error::Io: {adapter:?}"
        );
        assert!(temp.path().join("folder").is_dir());
        assert!(
            matches!(
                committed,
                Ok(AtomicFileOutcome::CommittedDurabilityUncertain(_))
            ),
            "committed path reports uncertainty: {committed:?}"
        );
        assert!(temp.path().join("other").is_dir());
    }

    #[test]
    fn remove_empty_directory_at_removes_only_the_observed_empty_directory() {
        let temp = tempfile::tempdir().expect("tempdir");
        let parent = test_parent(temp.path());
        create_dir_at(&parent, OsStr::new("empty")).expect("create empty");
        let identity = entry_identity_at(&parent, OsStr::new("empty"), true).expect("identity");
        remove_empty_directory_at(&parent, OsStr::new("empty"), identity).expect("remove empty");
        assert!(!temp.path().join("empty").exists());

        create_dir_at(&parent, OsStr::new("filled")).expect("create filled");
        std::fs::write(temp.path().join("filled/child.txt"), b"keep").expect("child");
        let filled = entry_identity_at(&parent, OsStr::new("filled"), true).expect("filled");
        let filled_error = remove_empty_directory_at(&parent, OsStr::new("filled"), filled)
            .expect_err("non-empty directory is not removed");
        assert!(
            filled_error.to_string().contains("not empty") || matches!(filled_error, Error::Io(_)),
            "{filled_error:?}"
        );
        assert_eq!(
            std::fs::read(temp.path().join("filled/child.txt")).expect("child intact"),
            b"keep"
        );

        std::fs::write(temp.path().join("file"), b"bytes").expect("file");
        let file_identity = entry_identity_at(&parent, OsStr::new("file"), false).expect("file");
        let file_error = remove_empty_directory_at(&parent, OsStr::new("file"), file_identity)
            .expect_err("a file is not removed as a directory");
        assert!(matches!(file_error, Error::Conflict(_)), "{file_error:?}");
        assert_eq!(
            std::fs::read(temp.path().join("file")).expect("file intact"),
            b"bytes"
        );
    }

    #[test]
    fn ensure_directory_at_creates_a_missing_name_and_reopens_an_existing_one() {
        let temp = tempfile::tempdir().expect("tempdir");
        #[cfg(unix)]
        let parent = File::open(temp.path()).expect("open parent");
        #[cfg(windows)]
        let parent = windows_test_parent(temp.path());
        let created = ensure_directory_at(&parent, OsStr::new("folder")).expect("create");
        let reopened = ensure_directory_at(&parent, OsStr::new("folder")).expect("reopen");
        assert!(temp.path().join("folder").is_dir());
        assert_eq!(
            crate::infra::path_authority::opened_file_identity(&created).unwrap(),
            crate::infra::path_authority::opened_file_identity(&reopened).unwrap()
        );
    }

    /// Test 3: a symlink planted at the name after the exclusive create collided is refused by the
    /// no-follow open, not followed.
    #[cfg(unix)]
    #[test]
    fn ensure_directory_at_refuses_a_symlink_planted_after_the_collision() {
        let temp = tempfile::tempdir().expect("tempdir");
        let outside = temp.path().join("outside");
        let parent_path = temp.path().join("parent");
        std::fs::create_dir(&outside).unwrap();
        std::fs::create_dir_all(parent_path.join("child")).unwrap();
        let parent = File::open(&parent_path).expect("open parent");
        let child = parent_path.join("child");
        let target = outside.clone();
        set_ensure_directory_post_collision_hook(Some(Box::new(move || {
            std::fs::remove_dir(&child).unwrap();
            std::os::unix::fs::symlink(&target, &child).unwrap();
        })));
        let result = ensure_directory_at(&parent, OsStr::new("child"));
        set_ensure_directory_post_collision_hook(None);
        assert!(
            matches!(result, Err(Error::Io(_))),
            "a racing symlink must fail the open: {result:?}"
        );
        assert!(std::fs::symlink_metadata(parent_path.join("child"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }

    /// Test 2 at the helper: a symlink swapped in at the name before the create is not followed
    /// either — the exclusive `mkdirat` collides with it and the no-follow open refuses it.
    #[cfg(unix)]
    #[test]
    fn ensure_directory_at_refuses_a_symlink_planted_before_the_create() {
        let temp = tempfile::tempdir().expect("tempdir");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let parent = File::open(temp.path()).expect("open parent");
        let child = temp.path().join("child");
        let target = outside.clone();
        set_ensure_directory_pre_create_hook(Some(Box::new(move || {
            std::os::unix::fs::symlink(&target, &child).unwrap();
        })));
        let result = ensure_directory_at(&parent, OsStr::new("child"));
        set_ensure_directory_pre_create_hook(None);
        assert!(matches!(result, Err(Error::Io(_))), "{result:?}");
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn ensure_directory_at_and_create_dir_at_refuse_non_single_leaves() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(temp.path().join("parent")).expect("parent");
        let parent = test_parent(&temp.path().join("parent"));
        for leaf in ["..", ".", "", "a/b"] {
            assert!(
                matches!(
                    ensure_directory_at(&parent, OsStr::new(leaf)),
                    Err(Error::InvalidInput(_))
                ),
                "{leaf:?}"
            );
            assert!(
                matches!(
                    create_dir_at(&parent, OsStr::new(leaf)),
                    Err(Error::InvalidInput(_))
                ),
                "{leaf:?}"
            );
        }
        assert!(!temp.path().join("a").exists());
    }

    #[test]
    fn optional_regular_missing_leaf_is_success() {
        let temp = tempfile::tempdir().expect("tempdir");
        #[cfg(unix)]
        let parent = File::open(temp.path()).expect("open parent");
        #[cfg(windows)]
        let parent = windows_test_parent(temp.path());
        let missing = OsStr::new("sidecar.info");
        assert!(
            rename_optional_regular_at(&parent, missing, &parent, OsStr::new("other.info"))
                .expect("missing sidecar rename")
                .is_none()
        );
        remove_optional_regular_at(&parent, missing).expect("missing sidecar removal");
    }

    #[test]
    fn rename_parent_sync_failures_preserve_commit_and_offer_every_parent() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct SyncFault(Arc<AtomicUsize>, usize);
        impl AtomicWriterInjector for SyncFault {
            fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
                if point == AtomicFileFaultPoint::ParentSync {
                    let call = self.0.fetch_add(1, Ordering::SeqCst);
                    if call >= self.1 {
                        return Err(std::io::Error::other(format!("rename sync {call}")));
                    }
                }
                Ok(())
            }
        }
        for optional in [false, true] {
            for distinct in [false, true] {
                for fail_from in 0..=usize::from(distinct) {
                    let temp = tempfile::tempdir().unwrap();
                    let target_dir = if distinct {
                        let path = temp.path().join("target");
                        std::fs::create_dir(&path).unwrap();
                        path
                    } else {
                        temp.path().to_path_buf()
                    };
                    let source = test_parent(temp.path());
                    let target = test_parent(&target_dir);
                    std::fs::write(temp.path().join("before"), b"identity and contents").unwrap();
                    let expected = entry_identity_at(&source, OsStr::new("before"), false).unwrap();
                    let calls = Arc::new(AtomicUsize::new(0));
                    let _reset = install_test_atomic_file_injector(Arc::new(SyncFault(
                        calls.clone(),
                        fail_from,
                    )));
                    let capture = crate::error::LogCaptureScope::start();
                    let outcome = if optional {
                        rename_optional_regular_at(
                            &source,
                            OsStr::new("before"),
                            &target,
                            OsStr::new("after"),
                        )
                        .unwrap()
                        .expect("present sidecar")
                    } else {
                        rename_entry_at(
                            &source,
                            OsStr::new("before"),
                            expected,
                            false,
                            &target,
                            OsStr::new("after"),
                        )
                        .unwrap()
                    };
                    assert!(
                        matches!(outcome, AtomicFileOutcome::CommittedDurabilityUncertain(ref error) if error.to_string() == format!("rename sync {fail_from}"))
                    );
                    assert_eq!(calls.load(Ordering::SeqCst), if distinct { 2 } else { 1 });
                    assert!(!temp.path().join("before").exists());
                    assert_eq!(
                        std::fs::read(target_dir.join("after")).unwrap(),
                        b"identity and contents"
                    );
                    assert_eq!(
                        entry_identity_at(&target, OsStr::new("after"), false).unwrap(),
                        expected
                    );
                    if distinct && fail_from == 0 {
                        assert!(capture
                            .messages()
                            .iter()
                            .any(|line| line.contains("rename sync 1")));
                    }
                }
            }
        }
    }

    #[test]
    fn rename_refusals_do_not_commit_or_sync() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct CountSync(Arc<AtomicUsize>);
        impl AtomicWriterInjector for CountSync {
            fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
                if point == AtomicFileFaultPoint::ParentSync {
                    self.0.fetch_add(1, Ordering::SeqCst);
                }
                Ok(())
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let parent = test_parent(temp.path());
        std::fs::write(temp.path().join("source"), b"source").unwrap();
        std::fs::write(temp.path().join("occupied"), b"occupied").unwrap();
        let identity = entry_identity_at(&parent, OsStr::new("source"), false).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let _reset = install_test_atomic_file_injector(Arc::new(CountSync(calls.clone())));
        assert!(rename_entry_at(
            &parent,
            OsStr::new("source"),
            identity,
            false,
            &parent,
            OsStr::new("occupied")
        )
        .is_err());
        assert!(rename_optional_regular_at(
            &parent,
            OsStr::new("source"),
            &parent,
            OsStr::new("occupied")
        )
        .is_err());
        assert!(rename_entry_at(
            &parent,
            OsStr::new("source"),
            (identity.0, identity.1.wrapping_add(1)),
            false,
            &parent,
            OsStr::new("free")
        )
        .is_err());
        std::fs::create_dir(temp.path().join("directory")).unwrap();
        assert!(rename_optional_regular_at(
            &parent,
            OsStr::new("directory"),
            &parent,
            OsStr::new("free")
        )
        .is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("source", temp.path().join("link")).unwrap();
            assert!(rename_optional_regular_at(
                &parent,
                OsStr::new("link"),
                &parent,
                OsStr::new("free")
            )
            .is_err());
            assert!(rename_entry_at(
                &parent,
                OsStr::new("link"),
                identity,
                false,
                &parent,
                OsStr::new("free")
            )
            .is_err());
        }
        assert!(rename_optional_regular_at(
            &parent,
            OsStr::new("missing"),
            &parent,
            OsStr::new("free")
        )
        .unwrap()
        .is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            std::fs::read(temp.path().join("source")).unwrap(),
            b"source"
        );
        assert_eq!(
            std::fs::read(temp.path().join("occupied")).unwrap(),
            b"occupied"
        );
        assert!(!temp.path().join("free").exists());
    }

    #[test]
    fn workspace_rename_collision_payload_is_opt_in_and_identity_conflicts_stay_distinct() {
        let temp = tempfile::tempdir().unwrap();
        let parent = test_parent(temp.path());
        std::fs::write(temp.path().join("source"), b"source").unwrap();
        std::fs::write(temp.path().join("occupied"), b"occupied").unwrap();
        let identity = entry_identity_at(&parent, OsStr::new("source"), false).unwrap();
        for optional in [false, true] {
            let error = if optional {
                rename_workspace_sidecar_at(
                    &parent,
                    OsStr::new("source"),
                    &parent,
                    OsStr::new("occupied"),
                )
                .unwrap_err()
            } else {
                rename_workspace_entry_at(
                    &parent,
                    OsStr::new("source"),
                    identity,
                    false,
                    &parent,
                    OsStr::new("occupied"),
                )
                .unwrap_err()
            };
            let payload = serde_json::to_value(error).unwrap();
            assert_eq!(payload["category"], "conflict");
            assert_eq!(payload["nameTaken"], true);
            let generic = if optional {
                rename_optional_regular_at(
                    &parent,
                    OsStr::new("source"),
                    &parent,
                    OsStr::new("occupied"),
                )
                .unwrap_err()
            } else {
                rename_entry_at(
                    &parent,
                    OsStr::new("source"),
                    identity,
                    false,
                    &parent,
                    OsStr::new("occupied"),
                )
                .unwrap_err()
            };
            assert!(serde_json::to_value(generic)
                .unwrap()
                .get("nameTaken")
                .is_none());
        }
        let stale = rename_workspace_entry_at(
            &parent,
            OsStr::new("source"),
            (identity.0, identity.1.wrapping_add(1)),
            false,
            &parent,
            OsStr::new("occupied"),
        )
        .unwrap_err();
        let payload = serde_json::to_value(stale).unwrap();
        assert_eq!(payload["category"], "conflict");
        assert!(payload.get("nameTaken").is_none());
        assert_eq!(
            std::fs::read(temp.path().join("source")).unwrap(),
            b"source"
        );
        assert_eq!(
            std::fs::read(temp.path().join("occupied")).unwrap(),
            b"occupied"
        );
        let permission = workspace_collision(Error::from(std::io::Error::from(
            std::io::ErrorKind::PermissionDenied,
        )));
        let payload = serde_json::to_value(permission).unwrap();
        assert_eq!(payload["category"], "permission");
        assert!(payload.get("nameTaken").is_none());
    }

    #[test]
    fn forward_sidecar_publication_refuses_occupied_objects_without_following_them() {
        for kind in ["file", "directory", "link"] {
            #[cfg(not(unix))]
            if kind == "link" {
                continue;
            }
            let temp = tempfile::tempdir().unwrap();
            let parent = test_parent(temp.path());
            let target = temp.path().join("destination.info");
            let preserved = if kind == "directory" {
                std::fs::create_dir(&target).unwrap();
                target.join("child")
            } else if kind == "link" {
                let outside = temp.path().join("outside");
                #[cfg(unix)]
                std::os::unix::fs::symlink(&outside, &target).unwrap();
                outside
            } else {
                target.clone()
            };
            std::fs::write(&preserved, b"unrelated bytes").unwrap();
            let error = atomic_create_workspace_sidecar_at(
                &parent,
                OsStr::new("destination.info"),
                || Ok(()),
                |file| file.write_all(b"new metadata").map_err(io),
            )
            .unwrap_err();
            assert_eq!(std::fs::read(&preserved).unwrap(), b"unrelated bytes");
            let payload = serde_json::to_value(error).unwrap();
            assert_eq!(payload["category"], "conflict");
            assert_eq!(payload["nameTaken"], true);
            if kind == "link" {
                assert!(std::fs::symlink_metadata(&target)
                    .unwrap()
                    .file_type()
                    .is_symlink());
            }
            assert!(std::fs::read_dir(temp.path()).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".atomic-")));
        }
    }

    #[cfg(unix)]
    #[test]
    fn create_regular_at_refuses_symlinks_and_invalid_leaves() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("tempdir");
        let outside = temp.path().join("outside");
        std::fs::write(&outside, b"outside").expect("outside");
        let parent = File::open(temp.path()).expect("open parent");
        symlink(&outside, temp.path().join("link.db3")).expect("link");
        assert!(matches!(
            create_regular_at(&parent, OsStr::new("link.db3")),
            Err(Error::Io(_))
        ));
        for leaf in [OsStr::new(""), OsStr::new("nested/database.db3")] {
            assert!(matches!(
                create_regular_at(&parent, leaf),
                Err(Error::InvalidInput(_))
            ));
        }
        assert_eq!(std::fs::read(outside).expect("outside intact"), b"outside");
    }

    #[cfg(unix)]
    #[test]
    fn create_regular_at_uses_retained_parent_after_pathname_swap() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("root");
        let moved = temp.path().join("moved");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&root).expect("root");
        std::fs::create_dir(&outside).expect("outside");
        std::fs::write(outside.join("sentinel.db3"), b"outside").expect("sentinel");
        let parent = File::open(&root).expect("open retained parent");
        std::fs::rename(&root, &moved).expect("move root");
        symlink(&outside, &root).expect("install pathname substitute");

        let (_created, _) =
            create_regular_at(&parent, OsStr::new("created.db3")).expect("retained parent create");
        assert!(moved.join("created.db3").is_file());
        assert!(!outside.join("created.db3").exists());
        assert_eq!(
            std::fs::read(outside.join("sentinel.db3")).expect("outside intact"),
            b"outside"
        );
    }

    #[test]
    fn counted_removal_owns_physical_file_and_tree_counts() {
        for is_dir in [false, true] {
            let temp = tempfile::tempdir().expect("tempdir");
            let target = temp.path().join("victim");
            if is_dir {
                std::fs::create_dir_all(target.join("nested")).expect("nested directory");
                std::fs::write(target.join("first"), b"first").expect("first file");
                std::fs::write(target.join("nested/second"), b"second").expect("second file");
            } else {
                std::fs::write(&target, b"file").expect("file");
            }
            let parent = test_parent(temp.path());
            let identity =
                entry_identity_at(&parent, OsStr::new("victim"), is_dir).expect("identity");
            let removal = remove_entry_at_counted(&parent, OsStr::new("victim"), identity, is_dir)
                .expect("completed removal");
            assert!(!target.exists());
            let (count, failure) = removal.into_parts();
            assert_eq!(count, if is_dir { 4 } else { 1 });
            assert!(failure.is_none());
        }
    }

    #[cfg(unix)]
    #[test]
    fn counted_removal_keeps_count_at_parent_sync_and_legacy_category() {
        for counted in [false, true] {
            let temp = tempfile::tempdir().expect("tempdir");
            std::fs::create_dir(temp.path().join("victim")).expect("directory");
            std::fs::write(temp.path().join("victim/file"), b"file").expect("file");
            let parent = test_parent(temp.path());
            let identity =
                entry_identity_at(&parent, OsStr::new("victim"), true).expect("identity");
            let _guard = unix::scoped_test_removal_injector(Arc::new(RemovalFault(
                RemovalFaultPoint::ParentSync,
            )));
            let error = if counted {
                let (count, failure) =
                    remove_entry_at_counted(&parent, OsStr::new("victim"), identity, true)
                        .expect("primary completed before sync")
                        .into_parts();
                assert_eq!(count, 2);
                failure.expect("sync uncertainty")
            } else {
                remove_entry_at(&parent, OsStr::new("victim"), identity, true)
                    .expect_err("legacy sync uncertainty")
            };
            assert!(matches!(
                error,
                Error::CommittedDurabilityUncertain(
                    crate::error::DurabilityStage::WorkspaceRemoval
                )
            ));
            assert!(!temp.path().join("victim").exists());
        }
    }

    #[test]
    fn remove_entry_at_refuses_invalid_leaf_names() {
        let temp = tempfile::tempdir().expect("tempdir");
        let parent = test_parent(temp.path());
        for name in ["", "nested/file"] {
            assert!(matches!(
                remove_entry_at(&parent, OsStr::new(name), (0, 0), false),
                Err(Error::InvalidInput(_))
            ));
        }
    }

    #[test]
    fn remove_entry_at_does_not_unlink_outside_parent() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&root).expect("root");
        std::fs::write(&outside, b"outside").expect("outside");
        let parent = test_parent(&root);
        let expected = entry_identity_at(&test_parent(temp.path()), OsStr::new("outside"), false)
            .expect("outside identity");

        for name in [OsStr::new("../outside"), outside.as_os_str()] {
            assert!(matches!(
                remove_entry_at(&parent, name, expected, false),
                Err(Error::InvalidInput(_))
            ));
            assert_eq!(std::fs::read(&outside).expect("outside intact"), b"outside");
        }
    }

    #[cfg(unix)]
    #[test]
    fn retained_parent_rename_cannot_follow_a_post_open_target_swap() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("root");
        let nested = root.join("nested");
        let outside = temp.path().join("outside");
        let destination = root.join("destination");
        std::fs::create_dir(&root).expect("root");
        std::fs::create_dir(&nested).expect("nested");
        std::fs::create_dir(&outside).expect("outside");
        std::fs::create_dir(&destination).expect("destination");
        let entry = nested.join("game.pgn");
        std::fs::write(&entry, b"trusted").expect("entry");
        std::fs::write(outside.join("game.pgn"), b"outside").expect("outside entry");
        let expected = inode(&entry);
        let (parent, leaf) = open_verified_parent(&entry, expected, false, ParentAccess::Readable)
            .expect("retain parent");
        let target_parent = std::fs::File::open(&destination).expect("destination FD");
        std::fs::rename(&nested, root.join("nested-old")).expect("move nested");
        std::os::unix::fs::symlink(&outside, &nested).expect("swap link");

        rename_entry_at(&parent, &leaf, expected, false, &target_parent, &leaf)
            .expect("rename through retained parent")
            .expect_durable();
        assert_eq!(
            std::fs::read(destination.join("game.pgn")).expect("moved"),
            b"trusted"
        );
        assert_eq!(
            std::fs::read(outside.join("game.pgn")).expect("outside intact"),
            b"outside"
        );
    }

    #[cfg(unix)]
    #[test]
    fn recursive_delete_rejects_symlink_children_without_traversing_them() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        let victim = root.join("victim");
        std::fs::create_dir(&root).expect("root");
        std::fs::create_dir(&outside).expect("outside");
        std::fs::create_dir(&victim).expect("victim");
        std::fs::write(outside.join("keep"), b"outside").expect("outside file");
        std::os::unix::fs::symlink(&outside, victim.join("link")).expect("link");
        let parent = std::fs::File::open(&root).expect("parent FD");

        assert!(matches!(
            remove_entry_at(
                &parent,
                std::ffi::OsStr::new("victim"),
                inode(&victim),
                true
            ),
            Err(Error::InvalidInput(_))
        ));
        assert_eq!(
            std::fs::read(outside.join("keep")).expect("outside intact"),
            b"outside"
        );
    }

    #[test]
    fn directory_enumeration_returns_every_entry_across_several_pages() {
        // F4. The Windows read pulls `FILE_ID_BOTH_DIR_INFORMATION` records out of an
        // 8192-byte buffer one `NtQueryDirectoryFile` page at a time and continues until
        // `STATUS_NO_MORE_FILES`. A record is ~104 bytes plus the UTF-16 name, so a real
        // workspace of a few dozen PGNs with sidecars already needs a second call — yet every
        // Windows-executing listing test used at most six entries, which fits the first page.
        // Replacing the continuation with a `break` after page one reddened nothing, and the
        // product symptom would be a silently truncated Files page. The fixture needs only
        // `std::fs` plus a parent handle, so it runs on both targets.
        const ENTRIES: usize = 256;
        let temp = tempfile::tempdir().expect("tempdir");
        let mut expected = Vec::with_capacity(ENTRIES);
        for index in 0..ENTRIES {
            let name = format!("multi-page-enumeration-fixture-{index:04}.pgn");
            std::fs::write(temp.path().join(&name), b"pgn").expect("fixture entry");
            expected.push(name);
        }
        let parent = test_parent(temp.path());

        let listed =
            read_directory_entries_at(&parent, &CancellationToken::new(), None, &mut |_| true)
                .expect("listing");

        let mut names = listed
            .iter()
            .map(|entry| entry.name.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        expected.sort();
        assert_eq!(
            names, expected,
            "every entry must survive the page continuation"
        );
        assert!(
            listed
                .iter()
                .all(|entry| entry.kind == DirectoryEntryKind::RegularFile),
            "a page boundary must not corrupt the entry classification"
        );
        let mut identities = listed
            .iter()
            .map(|entry| entry.identity)
            .collect::<Vec<_>>();
        identities.sort_unstable();
        identities.dedup();
        assert_eq!(
            identities.len(),
            ENTRIES,
            "a page boundary must not corrupt or duplicate the composed identity"
        );
    }

    #[test]
    fn recursive_delete_descends_through_nested_directories() {
        // `recursive_delete_rejects_symlink_children_without_traversing_them` does reach the
        // recursive call, but only to have it fail: the child is a symlink, so `?` propagates out
        // of the walk and the loop never reaches a second entry, the `.`/`..` skip, or the
        // closing `unlinkat(REMOVEDIR)`. Nothing deliberately drives the *successful* descent.
        // What actually reached it was other tests' workspace cleanup, and only where that
        // cleanup happens to take the permanent-delete path — on GitHub's runner the directory
        // arm runs exactly once (from the test above) against 21 times here, which is the whole
        // of the cross-machine coverage gap in `f-20260829-01`. Three levels, because two would
        // still pass if the recursion only ever unwound once.
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("root");
        let victim = root.join("victim");
        let middle = victim.join("middle");
        let deepest = middle.join("deepest");
        std::fs::create_dir_all(&deepest).expect("tree");
        std::fs::write(victim.join("top.pgn"), b"top").expect("top file");
        std::fs::write(middle.join("middle.pgn"), b"middle").expect("middle file");
        std::fs::write(deepest.join("deepest.pgn"), b"deepest").expect("deepest file");
        std::fs::write(root.join("sibling.pgn"), b"sibling").expect("sibling file");
        let parent = test_parent(&root);
        // Un-gated since F5: the Windows walk (`remove_windows_tree_at` / `remove_regular_child`)
        // executed in no test on any platform, so reverting its child-before-parent unlink order
        // or its depth bound reddened only a source-text pin.
        let expected =
            entry_identity_at(&parent, std::ffi::OsStr::new("victim"), true).expect("identity");

        remove_entry_at(&parent, std::ffi::OsStr::new("victim"), expected, true)
            .expect("recursive delete");

        assert!(!victim.exists(), "the whole subtree is gone");
        assert_eq!(
            std::fs::read(root.join("sibling.pgn")).expect("sibling intact"),
            b"sibling",
            "the descent stays inside the named entry"
        );
    }

    #[cfg(unix)]
    #[test]
    fn recursive_delete_reports_a_held_directory_removed_after_the_walk() {
        let (_temp, _root, victim, expected, parent) = removal_fixture();
        std::fs::write(victim.join("removed"), b"content").unwrap();
        let injector = Arc::new(PostWalkMutation::new(
            victim.clone(),
            PostWalkAction::Remove,
        ));

        let error = remove_entry_with_injector(&parent, OsStr::new("victim"), expected, injector)
            .expect_err("removed held directory must be reported");

        let Error::PartialRemoval {
            removed_entries,
            cause,
        } = &error
        else {
            panic!("expected partial removal, got {error:?}");
        };
        assert!(*removed_entries >= 1);
        assert_directory_removed_during_enumeration(cause);
    }

    #[cfg(unix)]
    #[test]
    fn recursive_delete_rejects_a_same_name_directory_replacement_after_the_walk() {
        let (_temp, _root, victim, expected, parent) = removal_fixture();
        std::fs::write(victim.join("removed"), b"content").unwrap();
        let injector = Arc::new(PostWalkMutation::new(
            victim.clone(),
            PostWalkAction::ReplaceWithSentinel,
        ));

        let error = remove_entry_with_injector(&parent, OsStr::new("victim"), expected, injector)
            .expect_err("same-name replacement must be reported");

        let Error::PartialRemoval { cause, .. } = &error else {
            panic!("expected partial removal, got {error:?}");
        };
        assert_directory_removed_during_enumeration(cause);
        assert_eq!(std::fs::read(victim.join("sentinel")).unwrap(), b"sentinel");
    }

    #[cfg(unix)]
    #[test]
    fn recursive_delete_rejects_a_symlink_planted_below_the_top_level() {
        // The test above refuses a symlink that is a direct child of the removed entry, so the
        // walk rejects it before descending into any directory. The property that matters is that
        // the refusal survives a real descent: the `statat`/`NOFOLLOW` check is per entry, so a
        // symlink reached only after two directory levels must hit the same arm rather than be
        // followed out of the tree.
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        let victim = root.join("victim");
        let deepest = victim.join("middle").join("deepest");
        std::fs::create_dir_all(&deepest).expect("tree");
        std::fs::create_dir(&outside).expect("outside");
        std::fs::write(outside.join("keep"), b"outside").expect("outside file");
        std::os::unix::fs::symlink(&outside, deepest.join("link")).expect("link");
        let parent = std::fs::File::open(&root).expect("parent FD");

        assert!(matches!(
            remove_entry_at(
                &parent,
                std::ffi::OsStr::new("victim"),
                inode(&victim),
                true
            ),
            Err(Error::InvalidInput(_))
        ));
        assert_eq!(
            std::fs::read(outside.join("keep")).expect("outside intact"),
            b"outside",
            "the descent never followed the link"
        );
    }

    #[cfg(unix)]
    struct RemovalSwap {
        point: unix::RemovalFaultPoint,
        target: PathBuf,
        replacement: PathBuf,
    }

    #[cfg(unix)]
    impl unix::RemovalInjector for RemovalSwap {
        fn inject(&self, point: unix::RemovalFaultPoint) -> std::io::Result<Option<u64>> {
            if point == self.point && self.replacement.exists() {
                std::fs::remove_dir_all(&self.target)?;
                std::fs::rename(&self.replacement, &self.target)?;
            }
            Ok(None)
        }
    }

    #[cfg(unix)]
    enum PostWalkAction {
        Remove,
        ReplaceWithSentinel,
        RenameAway {
            destination: PathBuf,
        },
        #[cfg(target_os = "macos")]
        RemoveParentAndCreateFile {
            parent: PathBuf,
        },
    }

    #[cfg(unix)]
    struct PostWalkMutation {
        target: PathBuf,
        action: PostWalkAction,
        cancellation: Option<CancellationToken>,
        fired: std::sync::atomic::AtomicBool,
    }

    #[cfg(unix)]
    impl PostWalkMutation {
        fn new(target: PathBuf, action: PostWalkAction) -> Self {
            Self {
                target,
                action,
                cancellation: None,
                fired: std::sync::atomic::AtomicBool::new(false),
            }
        }

        fn with_cancellation(mut self, cancellation: CancellationToken) -> Self {
            self.cancellation = Some(cancellation);
            self
        }
    }

    #[cfg(unix)]
    impl unix::RemovalInjector for PostWalkMutation {
        fn inject(&self, point: unix::RemovalFaultPoint) -> std::io::Result<Option<u64>> {
            if point != unix::RemovalFaultPoint::AfterDirectoryWalk
                || self.fired.swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                return Ok(None);
            }
            match &self.action {
                PostWalkAction::Remove => std::fs::remove_dir_all(&self.target)?,
                PostWalkAction::ReplaceWithSentinel => {
                    std::fs::remove_dir_all(&self.target)?;
                    std::fs::create_dir(&self.target)?;
                    std::fs::write(self.target.join("sentinel"), b"sentinel")?;
                }
                PostWalkAction::RenameAway { destination } => {
                    std::fs::rename(&self.target, destination)?;
                }
                #[cfg(target_os = "macos")]
                PostWalkAction::RemoveParentAndCreateFile { parent } => {
                    std::fs::remove_dir_all(&self.target)?;
                    std::fs::remove_dir_all(parent)?;
                    std::fs::write(parent, b"parent replacement")?;
                }
            }
            if let Some(cancellation) = &self.cancellation {
                cancellation.cancel();
            }
            Ok(None)
        }
    }

    #[cfg(unix)]
    struct ParentDeviceOverride(u64);

    #[cfg(unix)]
    impl unix::RemovalInjector for ParentDeviceOverride {
        fn inject(&self, point: unix::RemovalFaultPoint) -> std::io::Result<Option<u64>> {
            if point == unix::RemovalFaultPoint::BeforeChildOpen {
                return Ok(Some(self.0));
            }
            Ok(None)
        }
    }

    #[cfg(target_os = "linux")]
    #[derive(Clone, Copy)]
    enum InjectedStatx {
        Nosys,
        MissingMountRootMask,
        MountRoot(bool),
        Error(i32),
    }

    #[cfg(target_os = "linux")]
    enum InjectedFdinfo {
        Real,
        Unreadable,
        ByDescriptor(Mutex<std::collections::HashMap<std::os::fd::RawFd, Vec<u8>>>),
    }

    #[cfg(target_os = "linux")]
    struct MountEvidenceInjector {
        statx: InjectedStatx,
        fdinfo: InjectedFdinfo,
        child_fdinfo_record: Option<Vec<u8>>,
    }

    #[cfg(target_os = "linux")]
    impl MountEvidenceInjector {
        fn real_fdinfo(statx: InjectedStatx) -> Self {
            Self {
                statx,
                fdinfo: InjectedFdinfo::Real,
                child_fdinfo_record: None,
            }
        }

        fn unreadable_fdinfo(statx: InjectedStatx) -> Self {
            Self {
                statx,
                fdinfo: InjectedFdinfo::Unreadable,
                child_fdinfo_record: None,
            }
        }

        fn records(
            statx: InjectedStatx,
            parent: std::os::fd::RawFd,
            parent_record: &[u8],
            child_record: &[u8],
        ) -> Self {
            Self {
                statx,
                fdinfo: InjectedFdinfo::ByDescriptor(Mutex::new(
                    [(parent, parent_record.to_vec())].into_iter().collect(),
                )),
                child_fdinfo_record: Some(child_record.to_vec()),
            }
        }
    }

    #[cfg(target_os = "linux")]
    impl unix::RemovalInjector for MountEvidenceInjector {
        fn statx_mount_attributes(
            &self,
            descriptor: std::os::fd::RawFd,
        ) -> Option<std::io::Result<(u64, u64)>> {
            use rustix::{fs::StatxAttributes, io::Errno};
            if let (InjectedFdinfo::ByDescriptor(records), Some(child_record)) =
                (&self.fdinfo, &self.child_fdinfo_record)
            {
                records
                    .lock()
                    .expect("fdinfo records")
                    .insert(descriptor, child_record.clone());
            }
            let mount_root = StatxAttributes::MOUNT_ROOT.bits();
            Some(match self.statx {
                InjectedStatx::Nosys => Err(std::io::Error::from_raw_os_error(
                    Errno::NOSYS.raw_os_error(),
                )),
                InjectedStatx::MissingMountRootMask => Ok((0, 0)),
                InjectedStatx::MountRoot(is_mount) => {
                    Ok((mount_root, if is_mount { mount_root } else { 0 }))
                }
                InjectedStatx::Error(code) => Err(std::io::Error::from_raw_os_error(code)),
            })
        }

        fn fdinfo_record(
            &self,
            descriptor: std::os::fd::RawFd,
        ) -> Option<std::io::Result<Vec<u8>>> {
            match &self.fdinfo {
                InjectedFdinfo::Real => None,
                InjectedFdinfo::Unreadable => Some(Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected unreadable fdinfo",
                ))),
                InjectedFdinfo::ByDescriptor(records) => Some(
                    match records.lock().expect("fdinfo records").get(&descriptor) {
                        Some(record) => Ok(record.clone()),
                        None => Err(std::io::Error::new(
                            std::io::ErrorKind::NotFound,
                            format!("no injected fdinfo record for descriptor {descriptor}"),
                        )),
                    },
                ),
            }
        }
    }

    #[cfg(target_os = "macos")]
    struct MacMountInjector {
        paths: Mutex<Vec<std::io::Result<Vec<libc::c_char>>>>,
        flags: Mutex<Vec<std::io::Result<u32>>>,
        events: Mutex<Vec<&'static str>>,
    }

    #[cfg(target_os = "macos")]
    impl MacMountInjector {
        fn new(
            paths: Vec<std::io::Result<Vec<libc::c_char>>>,
            flags: Vec<std::io::Result<u32>>,
        ) -> Arc<Self> {
            Arc::new(Self {
                paths: Mutex::new(paths),
                flags: Mutex::new(flags),
                events: Mutex::new(Vec::new()),
            })
        }

        fn path(bytes: &[u8]) -> std::io::Result<Vec<libc::c_char>> {
            Ok(bytes.iter().map(|byte| *byte as libc::c_char).collect())
        }

        fn events(&self) -> Vec<&'static str> {
            self.events.lock().expect("mount events").clone()
        }
    }

    #[cfg(target_os = "macos")]
    impl unix::RemovalInjector for MacMountInjector {
        fn inject(&self, point: unix::RemovalFaultPoint) -> std::io::Result<Option<u64>> {
            if point == unix::RemovalFaultPoint::BeforeDirOpen {
                self.events
                    .lock()
                    .expect("mount events")
                    .push("before_dir_open");
            }
            Ok(None)
        }

        fn mount_path_buffer(
            &self,
            _: std::os::fd::RawFd,
        ) -> Option<std::io::Result<Vec<libc::c_char>>> {
            self.events.lock().expect("mount events").push("mount_path");
            let mut paths = self.paths.lock().expect("mount paths");
            (!paths.is_empty()).then(|| paths.remove(0))
        }

        fn mount_flags(&self, _: std::os::fd::RawFd) -> Option<std::io::Result<u32>> {
            self.events
                .lock()
                .expect("mount events")
                .push("mount_flags");
            let mut flags = self.flags.lock().expect("mount flags");
            (!flags.is_empty()).then(|| flags.remove(0))
        }
    }

    #[cfg(unix)]
    #[test]
    fn mount_path_buffer_parser_accepts_only_terminated_non_empty_paths() {
        let path = |bytes: &[u8]| {
            bytes
                .iter()
                .map(|byte| *byte as libc::c_char)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            unix::mount_path_from_buffer(&path(b"/private/tmp\0trailing"))
                .expect("terminated mount path"),
            b"/private/tmp"
        );
        for buffer in [path(b"/private/tmp"), path(b"\0")].iter() {
            assert!(matches!(
                unix::mount_path_from_buffer(buffer),
                Err(Error::InvalidInput(_))
            ));
        }
    }

    #[cfg(unix)]
    #[test]
    fn mount_decision_compares_paths_and_propagates_either_error() {
        assert!(!unix::mount_crossing_from(Ok(b"/tmp".to_vec()), Ok(b"/tmp".to_vec())).unwrap());
        assert!(unix::mount_crossing_from(Ok(b"/".to_vec()), Ok(b"/dev".to_vec())).unwrap());
        let parent_error = Error::InvalidInput("parent evidence".into());
        assert!(matches!(
            unix::mount_crossing_from(Err(parent_error), Ok(Vec::new())),
            Err(Error::InvalidInput(message)) if message == "parent evidence"
        ));
        let child_error = Error::InvalidInput("child evidence".into());
        assert!(matches!(
            unix::mount_crossing_from(Ok(Vec::new()), Err(child_error)),
            Err(Error::InvalidInput(message)) if message == "child evidence"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn union_mount_refusal_rejects_the_union_flag() {
        assert!(unix::union_mount_refusal(0, 0x20).is_ok());
        for flags in [0x20, 0x21] {
            assert!(unix::union_mount_refusal(flags, 0x20).is_err());
        }
        assert!(matches!(
            unix::union_mount_refusal(0x20, 0x20),
            Err(Error::InvalidInput(message)) if message == "directory walks refuse union mounts"
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_port_mnt_union_is_the_expected_flag() {
        assert_eq!(libc::MNT_UNION as u32, 0x20);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_port_real_tempdir_walk_passes_union_check() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("file"), b"file").expect("file");
        let directory = File::open(temp.path()).expect("directory");
        unix::walk_directory(&directory, |_, _, _| Ok(())).expect("ordinary tempdir walk");
    }

    #[cfg(target_os = "macos")]
    fn macos_mount_fixture() -> (tempfile::TempDir, PathBuf, (u64, u64), File) {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("root");
        let victim = root.join("victim");
        std::fs::create_dir_all(victim.join("child")).expect("tree");
        std::fs::write(victim.join("child/file"), b"file").expect("file");
        let parent = File::open(&root).expect("parent");
        (temp, victim.clone(), inode(&victim), parent)
    }

    #[cfg(target_os = "macos")]
    fn assert_macos_mount_error(
        paths: Vec<std::io::Result<Vec<libc::c_char>>>,
    ) -> (Error, tempfile::TempDir, PathBuf, Arc<MacMountInjector>) {
        let (temp, victim, expected, parent) = macos_mount_fixture();
        let injector = MacMountInjector::new(paths, Vec::new());
        let error = remove_entry_with_injector(
            &parent,
            OsStr::new("victim"),
            expected,
            Arc::clone(&injector) as Arc<dyn unix::RemovalInjector + Send + Sync>,
        )
        .expect_err("injected mount evidence must refuse deletion");
        (error, temp, victim, injector)
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_port_mount_crossing_refuses_different_mount_paths() {
        let paths = vec![
            MacMountInjector::path(b"/parent\0"),
            MacMountInjector::path(b"/child\0"),
        ];
        let (error, _temp, victim, _injector) = assert_macos_mount_error(paths);
        assert!(matches!(
            error,
            Error::InvalidInput(message) if message == "directory cleanup refuses to cross a mount"
        ));
        assert!(victim.join("child/file").is_file());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_port_mount_crossing_rejects_unterminated_path() {
        let paths = vec![
            MacMountInjector::path(b"/parent\0"),
            MacMountInjector::path(b"/child"),
        ];
        let (error, _temp, victim, _injector) = assert_macos_mount_error(paths);
        assert!(matches!(error, Error::InvalidInput(_)));
        assert!(victim.join("child/file").is_file());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_port_mount_crossing_rejects_empty_paths() {
        let paths = vec![MacMountInjector::path(b"\0"), MacMountInjector::path(b"\0")];
        let (error, _temp, victim, _injector) = assert_macos_mount_error(paths);
        assert!(matches!(error, Error::InvalidInput(_)));
        assert!(victim.join("child/file").is_file());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_port_mount_crossing_propagates_child_error() {
        let paths = vec![
            MacMountInjector::path(b"/parent\0"),
            Err(std::io::Error::from_raw_os_error(libc::EIO)),
        ];
        let (error, _temp, victim, _injector) = assert_macos_mount_error(paths);
        assert!(matches!(error, Error::Io(io_error) if io_error.raw_os_error() == Some(libc::EIO)));
        assert!(victim.join("child/file").is_file());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_port_mount_crossing_propagates_parent_error() {
        let paths = vec![
            Err(std::io::Error::from_raw_os_error(libc::EIO)),
            MacMountInjector::path(b"/child\0"),
        ];
        let (error, _temp, victim, _injector) = assert_macos_mount_error(paths);
        assert!(matches!(error, Error::Io(io_error) if io_error.raw_os_error() == Some(libc::EIO)));
        assert!(victim.join("child/file").is_file());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_port_union_mount_refusal_happens_before_child_dir_open() {
        let (temp, victim, expected, parent) = macos_mount_fixture();
        let injector = MacMountInjector::new(Vec::new(), vec![Ok(0), Ok(libc::MNT_UNION as u32)]);
        let error = remove_entry_with_injector(
            &parent,
            OsStr::new("victim"),
            expected,
            Arc::clone(&injector) as Arc<dyn unix::RemovalInjector + Send + Sync>,
        )
        .expect_err("union mount must refuse deletion");
        assert!(matches!(
            error,
            Error::InvalidInput(message) if message == "directory walks refuse union mounts"
        ));
        assert!(victim.join("child/file").is_file());
        let events = injector.events();
        assert_eq!(
            events
                .iter()
                .filter(|event| **event == "mount_flags")
                .count(),
            2
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| **event == "before_dir_open")
                .count(),
            1
        );
        assert_eq!(events.last(), Some(&"mount_flags"));
        drop(temp);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_port_union_mount_refusal_happens_before_install_dir_open() {
        let (temp, source, target) = directory_fixture();
        let nested = source.join("nested");
        std::fs::create_dir(&nested).expect("nested");
        std::fs::write(nested.join("file"), b"file").expect("file");
        let injector = MacMountInjector::new(Vec::new(), vec![Ok(0), Ok(libc::MNT_UNION as u32)]);
        let _guard = unix::scoped_test_removal_injector(
            Arc::clone(&injector) as Arc<dyn unix::RemovalInjector + Send + Sync>
        );
        let error =
            atomic_install_dir(&source, &target).expect_err("union mount must refuse install");
        assert!(matches!(
            error,
            Error::InvalidInput(message) if message == "directory walks refuse union mounts"
        ));
        assert!(source.join("new").is_file());
        assert!(nested.join("file").is_file());
        assert_eq!(
            std::fs::read(target.join("old")).expect("old target"),
            b"old"
        );
        assert_eq!(
            injector.events(),
            vec!["mount_flags", "before_dir_open", "mount_flags"]
        );
        drop(temp);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_port_real_mount_evidence_distinguishes_devfs() {
        let temp = tempfile::tempdir().expect("tempdir");
        let first = File::open(temp.path()).expect("tempdir descriptor");
        let second = File::open(temp.path()).expect("second descriptor");
        assert!(!unix::mount_crossing(&first, &second).expect("same mount evidence"));
        let root = File::open("/").expect("root descriptor");
        let dev = File::open("/dev").expect("devfs descriptor");
        assert!(unix::mount_crossing(&root, &dev).expect("devfs mount evidence"));
    }

    fn removal_fixture() -> (tempfile::TempDir, PathBuf, PathBuf, (u64, u64), File) {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("root");
        let victim = root.join("victim");
        std::fs::create_dir_all(&victim).expect("victim");
        let parent = test_parent(&root);
        let expected =
            entry_identity_at(&parent, OsStr::new("victim"), true).expect("victim identity");
        (temp, root, victim, expected, parent)
    }

    #[cfg(unix)]
    fn remove_entry_with_injector(
        parent: &File,
        name: &OsStr,
        expected: (u64, u64),
        injector: Arc<dyn unix::RemovalInjector + Send + Sync>,
    ) -> Result<(), Error> {
        let _guard = unix::scoped_test_removal_injector(injector);
        remove_entry_at(parent, name, expected, true)
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fdinfo_mount_id_parser_accepts_one_decimal_field() {
        assert_eq!(
            unix::parse_fdinfo_mount_id(b"pos:\t0\nflags:\t0100000\nmnt_id:\t4294967297\n")
                .expect("valid mount id"),
            4_294_967_297
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fdinfo_mount_id_parser_rejects_missing_duplicate_malformed_and_boundedness_failures() {
        let oversized = vec![b'x'; 4097];
        for record in [
            b"pos:\t0\n".as_slice(),
            b"mnt_id:\t1\nmnt_id:\t1\n".as_slice(),
            b"mnt_id: 12x\n".as_slice(),
            b"mnt_id:\t18446744073709551616\n".as_slice(),
            oversized.as_slice(),
        ] {
            assert!(matches!(
                unix::parse_fdinfo_mount_id(record),
                Err(Error::InvalidInput(_))
            ));
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fdinfo_mount_id_reads_real_descriptor_records() {
        let temp = tempfile::tempdir().expect("tempdir");
        let left = File::open(temp.path()).expect("left descriptor");
        let right = File::open(temp.path()).expect("right descriptor");
        assert_eq!(
            unix::read_fdinfo_mount_id(&left).expect("left mount id"),
            unix::read_fdinfo_mount_id(&right).expect("right mount id")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recursive_delete_succeeds_with_same_mount_fdinfo_for_both_statx_unavailable_forms() {
        for statx in [InjectedStatx::Nosys, InjectedStatx::MissingMountRootMask] {
            let (_temp, _root, victim, expected, parent) = removal_fixture();
            std::fs::create_dir(victim.join("child")).expect("child");
            std::fs::write(victim.join("child/removed"), b"content").expect("content");
            remove_entry_with_injector(
                &parent,
                OsStr::new("victim"),
                expected,
                Arc::new(MountEvidenceInjector::real_fdinfo(statx)),
            )
            .expect("same-mount recursive deletion");
            assert!(!victim.exists());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recursive_delete_propagates_non_nosys_statx_errors_before_deletion() {
        let (_temp, _root, victim, expected, parent) = removal_fixture();
        std::fs::write(victim.join("keep"), b"content").expect("content");
        let error = remove_entry_with_injector(
            &parent,
            OsStr::new("victim"),
            expected,
            Arc::new(MountEvidenceInjector::real_fdinfo(InjectedStatx::Error(
                rustix::io::Errno::ACCESS.raw_os_error(),
            ))),
        )
        .expect_err("statx error must propagate");
        assert!(matches!(error, Error::Io(_)));
        assert_eq!(
            std::fs::read(victim.join("keep")).expect("intact"),
            b"content"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recursive_delete_refuses_unreadable_fdinfo_before_deletion() {
        let (_temp, _root, victim, expected, parent) = removal_fixture();
        std::fs::write(victim.join("keep"), b"content").expect("content");
        let error = remove_entry_with_injector(
            &parent,
            OsStr::new("victim"),
            expected,
            Arc::new(MountEvidenceInjector::unreadable_fdinfo(
                InjectedStatx::Nosys,
            )),
        )
        .expect_err("unreadable fdinfo must refuse descent");
        assert!(matches!(error, Error::Io(_)));
        assert_eq!(
            std::fs::read(victim.join("keep")).expect("intact"),
            b"content"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recursive_delete_refuses_invalid_fdinfo_before_deletion() {
        use std::os::fd::AsRawFd;

        let (_temp, _root, victim, expected, parent) = removal_fixture();
        std::fs::write(victim.join("keep"), b"content").expect("content");
        let error = remove_entry_with_injector(
            &parent,
            OsStr::new("victim"),
            expected,
            Arc::new(MountEvidenceInjector::records(
                InjectedStatx::Nosys,
                parent.as_raw_fd(),
                b"pos:\t0\n",
                b"mnt_id:\t42\n",
            )),
        )
        .expect_err("invalid fdinfo must refuse descent");
        assert!(matches!(error, Error::InvalidInput(_)));
        assert_eq!(
            std::fs::read(victim.join("keep")).expect("intact"),
            b"content"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recursive_delete_refuses_unequal_mount_ids_even_when_devices_match() {
        use std::os::fd::AsRawFd;

        let (_temp, _root, victim, expected, parent) = removal_fixture();
        std::fs::write(victim.join("keep"), b"content").expect("content");
        let error = remove_entry_with_injector(
            &parent,
            OsStr::new("victim"),
            expected,
            Arc::new(MountEvidenceInjector::records(
                InjectedStatx::MissingMountRootMask,
                parent.as_raw_fd(),
                b"mnt_id:\t41\n",
                b"mnt_id:\t42\n",
            )),
        )
        .expect_err("different descriptor mount ids must refuse descent");
        assert!(matches!(error, Error::InvalidInput(_)));
        assert_eq!(
            std::fs::read(victim.join("keep")).expect("intact"),
            b"content"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recursive_delete_accepts_equal_descriptor_addressed_mount_ids() {
        use std::os::fd::AsRawFd;

        let (_temp, _root, victim, expected, parent) = removal_fixture();
        std::fs::write(victim.join("removed"), b"content").expect("content");
        remove_entry_with_injector(
            &parent,
            OsStr::new("victim"),
            expected,
            Arc::new(MountEvidenceInjector::records(
                InjectedStatx::MissingMountRootMask,
                parent.as_raw_fd(),
                b"mnt_id:\t42\n",
                b"mnt_id:\t42\n",
            )),
        )
        .expect("equal descriptor mount ids permit deletion");
        assert!(!victim.exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recursive_delete_uses_supported_statx_mount_root_without_fdinfo() {
        let (_temp, _root, victim, expected, parent) = removal_fixture();
        std::fs::write(victim.join("keep"), b"content").expect("content");
        let error = remove_entry_with_injector(
            &parent,
            OsStr::new("victim"),
            expected,
            Arc::new(MountEvidenceInjector::unreadable_fdinfo(
                InjectedStatx::MountRoot(true),
            )),
        )
        .expect_err("mount root must refuse descent");
        assert!(matches!(error, Error::InvalidInput(_)));
        assert_eq!(
            std::fs::read(victim.join("keep")).expect("intact"),
            b"content"
        );

        let (_temp, _root, victim, expected, parent) = removal_fixture();
        std::fs::write(victim.join("removed"), b"content").expect("content");
        remove_entry_with_injector(
            &parent,
            OsStr::new("victim"),
            expected,
            Arc::new(MountEvidenceInjector::unreadable_fdinfo(
                InjectedStatx::MountRoot(false),
            )),
        )
        .expect("clear supported mount-root attribute permits deletion");
        assert!(!victim.exists());
    }

    #[cfg(target_os = "linux")]
    struct BindMountFixture {
        temp: Option<tempfile::TempDir>,
        root: PathBuf,
        victim: PathBuf,
        source: PathBuf,
        mounted: Option<PathBuf>,
    }

    #[cfg(target_os = "linux")]
    impl BindMountFixture {
        fn new(mount_below_target: bool) -> std::io::Result<Self> {
            let temp = tempfile::tempdir()?;
            let root = temp.path().join("root");
            let victim = root.join("victim");
            let source = temp.path().join("source");
            std::fs::create_dir_all(&victim)?;
            std::fs::create_dir(&source)?;
            std::fs::write(source.join("keep"), b"mounted content")?;
            let target = if mount_below_target {
                let target = victim.join("mounted");
                std::fs::create_dir(&target)?;
                target
            } else {
                victim.clone()
            };
            // Own and disarm cleanup before starting `mount`: even a command error is uncertain
            // until an explicit unmount attempt proves the target is clear.
            let mut fixture = Self {
                temp: Some(temp),
                root,
                victim,
                source,
                mounted: Some(target.clone()),
            };
            let output = std::process::Command::new("mount")
                .args(["--bind"])
                .arg(&fixture.source)
                .arg(&target)
                .output();
            match output {
                Ok(output) if output.status.success() => Ok(fixture),
                Ok(output) => {
                    let primary = format!(
                        "bind mount failed with {}: {}",
                        output.status,
                        String::from_utf8_lossy(&output.stderr)
                    );
                    if let Err(cleanup) = fixture.cleanup() {
                        return Err(std::io::Error::other(format!(
                            "{primary}; cleanup also failed: {cleanup}"
                        )));
                    }
                    Err(std::io::Error::other(primary))
                }
                Err(primary) => {
                    if let Err(cleanup) = fixture.cleanup() {
                        return Err(std::io::Error::other(format!(
                            "bind mount command failed: {primary}; cleanup also failed: {cleanup}"
                        )));
                    }
                    Err(primary)
                }
            }
        }

        fn cleanup(&mut self) -> std::io::Result<()> {
            let Some(target) = self.mounted.as_ref() else {
                drop(self.temp.take());
                return Ok(());
            };
            let failure = match std::process::Command::new("umount").arg(target).output() {
                Ok(output) if output.status.success() => None,
                Ok(output) => Some(format!(
                    "{}: {}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr)
                )),
                Err(error) => Some(error.to_string()),
            };
            if let Some(failure) = failure {
                let retained = self
                    .temp
                    .take()
                    .expect("mounted fixture owns its temporary directory")
                    .keep();
                return Err(std::io::Error::other(format!(
                    "failed to unmount bind fixture; retained {}: {failure}",
                    retained.display()
                )));
            }
            self.mounted.take();
            drop(self.temp.take());
            Ok(())
        }
    }

    #[cfg(target_os = "linux")]
    impl Drop for BindMountFixture {
        fn drop(&mut self) {
            if self.mounted.is_none() || self.temp.is_none() {
                return;
            }
            if let Err(error) = self.cleanup() {
                eprintln!("bind-mount fixture cleanup failed during unwind: {error}");
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn bind_mount_fixture_retains_tempdir_when_unmount_fails() {
        let temp = tempfile::tempdir().expect("tempdir");
        let retained = temp.path().to_path_buf();
        let nonexistent_target = retained.join("not-mounted");
        let mut fixture = BindMountFixture {
            temp: Some(temp),
            root: retained.join("root"),
            victim: retained.join("victim"),
            source: retained.join("source"),
            mounted: Some(nonexistent_target),
        };
        fixture.cleanup().expect_err("unmount must fail");
        assert!(retained.exists(), "failed cleanup retains the fixture");
        drop(fixture);
        std::fs::remove_dir_all(retained).expect("remove known-unmounted retained test fixture");
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires an isolated user and mount namespace"]
    fn recursive_delete_refuses_bind_mount_without_mount_root() {
        for mount_below_target in [false, true] {
            for statx in [InjectedStatx::Nosys, InjectedStatx::MissingMountRootMask] {
                let mut fixture = BindMountFixture::new(mount_below_target)
                    .expect("create real same-filesystem bind mount fixture");
                let parent = File::open(&fixture.root).expect("parent descriptor");
                let expected = inode(&fixture.victim);
                let error = remove_entry_with_injector(
                    &parent,
                    OsStr::new("victim"),
                    expected,
                    Arc::new(MountEvidenceInjector::real_fdinfo(statx)),
                )
                .expect_err("descriptor mount-id mismatch must refuse recursive deletion");
                assert_eq!(
                    std::fs::read(fixture.source.join("keep")).expect("source content survives"),
                    b"mounted content"
                );
                assert!(matches!(
                    error,
                    Error::InvalidInput(message)
                        if message == "directory cleanup refuses to cross a mount"
                ));
                fixture
                    .cleanup()
                    .expect("unmount bind fixture before temporary-directory cleanup");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn recursive_delete_rejects_top_level_substitution() {
        let (_temp, root, victim, expected, parent) = removal_fixture();
        let replacement = root.join("replacement");
        std::fs::create_dir(&replacement).expect("replacement");
        std::fs::write(replacement.join("keep"), b"replacement").expect("replacement content");

        let error = remove_entry_with_injector(
            &parent,
            OsStr::new("victim"),
            expected,
            Arc::new(RemovalSwap {
                point: unix::RemovalFaultPoint::BeforeTopOpen,
                target: victim.clone(),
                replacement,
            }),
        )
        .expect_err("substitution must be rejected");

        assert!(matches!(error, Error::Conflict(_)));
        assert_eq!(
            std::fs::read(victim.join("keep")).expect("substituted tree survives"),
            b"replacement"
        );
    }

    #[cfg(unix)]
    #[test]
    fn recursive_delete_rejects_child_substitution() {
        let (_temp, root, victim, expected, parent) = removal_fixture();
        let child = victim.join("child");
        let replacement = root.join("replacement");
        std::fs::create_dir_all(&child).expect("child");
        std::fs::create_dir(&replacement).expect("replacement");
        std::fs::write(replacement.join("keep"), b"replacement").expect("replacement content");
        let error = remove_entry_with_injector(
            &parent,
            OsStr::new("victim"),
            expected,
            Arc::new(RemovalSwap {
                point: unix::RemovalFaultPoint::BeforeChildOpen,
                target: child.clone(),
                replacement,
            }),
        )
        .expect_err("substitution must be rejected");

        assert!(matches!(error, Error::Conflict(_)));
        assert_eq!(
            std::fs::read(child.join("keep")).expect("substituted tree survives"),
            b"replacement"
        );
    }

    #[cfg(unix)]
    #[test]
    fn recursive_delete_rejects_child_substitution_before_stat() {
        let (_temp, root, victim, expected, parent) = removal_fixture();
        let child = victim.join("child");
        let replacement = root.join("replacement");
        std::fs::create_dir_all(&child).expect("child");
        std::fs::create_dir(&replacement).expect("replacement");
        std::fs::write(replacement.join("keep"), b"replacement").expect("replacement content");

        let error = remove_entry_with_injector(
            &parent,
            OsStr::new("victim"),
            expected,
            Arc::new(RemovalSwap {
                point: unix::RemovalFaultPoint::BeforeChildStat,
                target: child.clone(),
                replacement,
            }),
        )
        .expect_err("substitution must be rejected");

        assert!(matches!(error, Error::Conflict(_)));
        assert_eq!(
            std::fs::read(child.join("keep")).expect("substituted tree survives"),
            b"replacement"
        );
    }

    #[cfg(unix)]
    #[test]
    fn recursive_delete_refuses_a_forced_parent_device() {
        let (_temp, _root, victim, expected, parent) = removal_fixture();
        let child = victim.join("child");
        std::fs::create_dir_all(&child).expect("child");
        std::fs::write(child.join("keep"), b"content").expect("child content");

        let error = remove_entry_with_injector(
            &parent,
            OsStr::new("victim"),
            expected,
            Arc::new(ParentDeviceOverride(expected.0.wrapping_add(1))),
        )
        .expect_err("mount must be rejected");

        assert!(matches!(error, Error::InvalidInput(_)));
        assert_eq!(
            std::fs::read(child.join("keep")).expect("mounted child survives"),
            b"content"
        );
    }

    #[test]
    fn recursive_delete_refuses_more_than_the_maximum_depth() {
        // Un-gated since F5. It also drives the `removed_entries == 0` arm of the partial-removal
        // split on both platforms: the bound is hit before anything has been unlinked, so the
        // caller must see the plain `ResourceLimit`, not an `Error::PartialRemoval`.
        let (_temp, _root, victim, expected, parent) = removal_fixture();
        let mut current = victim.clone();
        for level in 1..MAX_REMOVE_TREE_DEPTH {
            current = current.join(format!("level-{level}"));
            std::fs::create_dir(&current).expect("nested directory");
        }
        let boundary = current.join("boundary");
        std::fs::write(&boundary, b"content").expect("boundary entry");
        let error = remove_entry_at(&parent, OsStr::new("victim"), expected, true)
            .expect_err("depth must be bounded");

        assert!(matches!(error, Error::ResourceLimit(_)), "{error:?}");
        assert!(boundary.is_file(), "the refused entry survives");
    }

    #[cfg(unix)]
    #[test]
    fn recursive_delete_reports_partial_progress() {
        let (_temp, _root, victim, expected, parent) = removal_fixture();
        std::fs::write(victim.join("removed"), b"content").expect("child content");

        let error = remove_entry_with_injector(
            &parent,
            OsStr::new("victim"),
            expected,
            Arc::new(unix::RemovalFault(
                unix::RemovalFaultPoint::AfterEntryRemoved,
            )),
        )
        .expect_err("post-removal failure must be reported");

        let serialized = serde_json::to_string(&error).expect("serialize partial removal");
        let payload: serde_json::Value =
            serde_json::from_str(&serialized).expect("serialized error is a JSON object");
        assert_eq!(payload["category"], "partial-removal");
        assert_eq!(payload["message"], error.to_string());
        assert!(!serialized.contains("/private/removal"));
        assert!(!serialized.contains(r"C:\private\removal"));
        assert!(!serialized.contains("injected removal failure"));

        assert!(matches!(
            error,
            Error::PartialRemoval {
                removed_entries,
                ..
            } if removed_entries >= 1
        ));
        assert!(error.to_string().starts_with("Partially removed:"));
    }

    #[cfg(unix)]
    #[test]
    fn recursive_delete_maps_parent_sync_failure_after_complete_removal() {
        let (_temp, _root, victim, expected, parent) = removal_fixture();
        std::fs::write(victim.join("removed"), b"content").expect("child content");

        let error = remove_entry_with_injector(
            &parent,
            OsStr::new("victim"),
            expected,
            Arc::new(unix::RemovalFault(unix::RemovalFaultPoint::ParentSync)),
        )
        .expect_err("parent sync failure must preserve commit status");

        let serialized = serde_json::to_string(&error).expect("serialize removal error");
        let payload: serde_json::Value =
            serde_json::from_str(&serialized).expect("serialized error is a JSON object");
        assert_eq!(payload["category"], "durability");
        assert_eq!(
            payload["message"],
            "Committed but durability uncertain: workspace removal"
        );

        assert!(matches!(error, Error::CommittedDurabilityUncertain(_)));
        assert!(!victim.exists(), "the tree was completely removed");
    }

    struct Fault(
        Option<AtomicFileFaultPoint>,
        Option<AtomicFileFaultPoint>,
        Arc<Mutex<Vec<AtomicFileFaultPoint>>>,
    );
    impl AtomicWriterInjector for Fault {
        fn inject(&self, p: AtomicFileFaultPoint) -> std::io::Result<()> {
            self.2.lock().expect("lock").push(p);
            if self.0 == Some(p) || self.1 == Some(p) {
                Err(std::io::Error::other("injected"))
            } else {
                Ok(())
            }
        }
    }

    struct Mutation {
        point: AtomicFileFaultPoint,
        target: PathBuf,
        // Unix uses the pathname to perform the real parent-directory substitution; Windows
        // injects the distinct identity through the retained-handle test seam below.
        #[cfg(not(windows))]
        parent: PathBuf,
        action: &'static str,
    }
    impl AtomicWriterInjector for Mutation {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point != self.point {
                return Ok(());
            }
            match self.action {
                "create" => std::fs::write(&self.target, b"racer"),
                "directory" => std::fs::create_dir(&self.target),
                #[cfg(unix)]
                "symlink" => std::os::unix::fs::symlink("replacement", &self.target),
                "replace" => {
                    std::fs::remove_file(&self.target)?;
                    #[cfg(unix)]
                    {
                        std::os::unix::fs::symlink("replacement", &self.target)
                    }
                    #[cfg(not(unix))]
                    {
                        std::fs::write(&self.target, b"racer")
                    }
                }
                "parent" => {
                    #[cfg(windows)]
                    {
                        // The private temporary deliberately omits FILE_SHARE_DELETE, so moving
                        // its containing directory cannot faithfully stage this race on Windows.
                        Ok(())
                    }
                    #[cfg(not(windows))]
                    {
                        let moved = self.parent.with_extension("moved");
                        std::fs::rename(&self.parent, &moved)?;
                        std::fs::create_dir(&self.parent)
                    }
                }
                _ => unreachable!("test action"),
            }
        }

        #[cfg(windows)]
        fn parent_revalidation_identity(&self, actual: (u64, u64)) -> (u64, u64) {
            if self.action == "parent" {
                (actual.0, actual.1 ^ 1)
            } else {
                actual
            }
        }
    }

    struct PrivateTemp {
        parent: PathBuf,
    }

    struct BreakCleanup {
        parent: PathBuf,
    }

    struct PrecommitOrder {
        complete: std::sync::Arc<std::sync::atomic::AtomicBool>,
        observed_at_rename: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }
    impl AtomicWriterInjector for PrecommitOrder {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == AtomicFileFaultPoint::Rename {
                self.observed_at_rename.store(
                    self.complete.load(std::sync::atomic::Ordering::SeqCst),
                    std::sync::atomic::Ordering::SeqCst,
                );
            }
            Ok(())
        }
    }
    impl AtomicWriterInjector for BreakCleanup {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == AtomicFileFaultPoint::Write {
                return Err(std::io::Error::other("primary"));
            }
            if point == AtomicFileFaultPoint::Cleanup {
                let temp = std::fs::read_dir(&self.parent)?
                    .find_map(|entry| {
                        let entry = entry.ok()?;
                        entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with(".atomic-")
                            .then_some(entry.path())
                    })
                    .expect("temp");
                #[cfg(windows)]
                {
                    // The creator SID repair makes this process pass the temporary's DACL. Its
                    // FILE_SHARE_PRIVATE_TEMP mask still refuses a read opener, which is the
                    // cleanup failure this precedence test needs and does not rename the held
                    // private object just to manufacture an error.
                    return match std::fs::File::open(temp) {
                        Ok(_) => Err(std::io::Error::other(
                            "private temporary unexpectedly allowed a read opener",
                        )),
                        Err(error) => Err(error),
                    };
                }
                #[cfg(not(windows))]
                {
                    let moved = self.parent.join("moved-temp");
                    std::fs::rename(&temp, &moved)?;
                    std::fs::create_dir(&temp)?;
                    std::fs::write(temp.join("blocker"), b"x")?;
                }
            }
            Ok(())
        }
    }
    impl AtomicWriterInjector for PrivateTemp {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            #[cfg(windows)]
            if point == AtomicFileFaultPoint::Write {
                let temp = std::fs::read_dir(&self.parent)?
                    .find_map(|entry| {
                        let entry = entry.ok()?;
                        entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with(".atomic-")
                            .then_some(entry.path())
                    })
                    .expect("private temporary file exists");
                assert!(
                    std::fs::File::open(temp).is_err(),
                    "temporary must not share reads before its DACL is final"
                );
            }
            #[cfg(not(unix))]
            let _ = point;
            #[cfg(unix)]
            if matches!(
                point,
                AtomicFileFaultPoint::Write
                    | AtomicFileFaultPoint::Flush
                    | AtomicFileFaultPoint::FileSync
                    | AtomicFileFaultPoint::PermissionCopy
            ) {
                use std::os::unix::fs::PermissionsExt;
                let temp = std::fs::read_dir(&self.parent)?
                    .find_map(|entry| entry.ok().map(|entry| entry.path()))
                    .expect("private temporary file exists");
                assert_eq!(std::fs::metadata(temp)?.permissions().mode() & 0o777, 0o600);
            }
            Ok(())
        }

        #[cfg(windows)]
        fn inspect_temp(&self, temp: &OwnedFile) -> std::io::Result<()> {
            assert!(
                win::test_security_descriptor_is_creator_only(temp)
                    .map_err(|error| std::io::Error::other(error.to_string()))?,
                "temporary DACL must grant access only to its creator"
            );
            Ok(())
        }
    }

    /// A single-point injector shared by the unix fault matrix and the Windows rollback tests.
    struct DirFault {
        point: AtomicDirFaultPoint,
    }

    #[cfg(unix)]
    struct SourceSwap {
        source: PathBuf,
    }
    #[cfg(unix)]
    impl AtomicDirInjector for SourceSwap {
        fn inject(&self, point: AtomicDirFaultPoint) -> std::io::Result<()> {
            if point == AtomicDirFaultPoint::PreCommit {
                std::fs::remove_dir_all(&self.source)?;
                #[cfg(unix)]
                {
                    std::os::unix::fs::symlink("elsewhere", &self.source)?;
                }
            }
            Ok(())
        }
    }
    #[cfg(unix)]
    struct DirTargetMutation {
        target: PathBuf,
        existing: bool,
    }
    #[cfg(unix)]
    impl AtomicDirInjector for DirTargetMutation {
        fn inject(&self, point: AtomicDirFaultPoint) -> std::io::Result<()> {
            if point == AtomicDirFaultPoint::PreCommit {
                if self.existing {
                    std::fs::remove_dir_all(&self.target)?;
                    #[cfg(unix)]
                    {
                        return std::os::unix::fs::symlink("replacement", &self.target);
                    }
                }
                std::fs::create_dir(&self.target)?;
            }
            Ok(())
        }
    }
    impl AtomicDirInjector for DirFault {
        fn inject(&self, point: AtomicDirFaultPoint) -> std::io::Result<()> {
            if point == self.point {
                return Err(std::io::Error::other("injected"));
            }
            Ok(())
        }
    }

    #[cfg(unix)]
    fn directory_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().expect("tempdir");
        let source = root.path().join("source");
        let target = root.path().join("target");
        std::fs::create_dir(&source).expect("source");
        std::fs::write(source.join("new"), b"new").expect("new");
        std::fs::create_dir(&target).expect("target");
        std::fs::write(target.join("old"), b"old").expect("old");
        (root, source, target)
    }

    #[cfg(unix)]
    #[test]
    fn directory_install_refuses_a_source_removed_after_the_walk() {
        let (_root, source, target) = directory_fixture();
        let injector = Arc::new(PostWalkMutation::new(
            source.clone(),
            PostWalkAction::Remove,
        ));

        let result = {
            let _guard = unix::scoped_test_removal_injector(injector);
            atomic_install_dir(&source, &target)
        };

        let error = result.expect_err("source removal must be refused");
        assert_directory_removed_during_enumeration(&error);
        assert_eq!(std::fs::read(target.join("old")).unwrap(), b"old");
    }

    #[cfg(unix)]
    #[test]
    fn directory_install_refuses_a_same_name_source_replacement_after_the_walk() {
        let (_root, source, target) = directory_fixture();
        let injector = Arc::new(PostWalkMutation::new(
            source.clone(),
            PostWalkAction::ReplaceWithSentinel,
        ));

        let result = {
            let _guard = unix::scoped_test_removal_injector(injector);
            atomic_install_dir(&source, &target)
        };

        let error = result.expect_err("same-name source replacement must be refused");
        assert_directory_removed_during_enumeration(&error);
        assert_eq!(std::fs::read(target.join("old")).unwrap(), b"old");
        assert!(!target.join("sentinel").exists());
        assert_eq!(std::fs::read(source.join("sentinel")).unwrap(), b"sentinel");
    }

    #[cfg(unix)]
    #[test]
    fn directory_install_refuses_more_than_the_maximum_depth() {
        let (_root, source, target) = directory_fixture();
        let mut current = source.clone();
        for level in 0..MAX_REMOVE_TREE_DEPTH {
            current = current.join(format!("level-{level}"));
            std::fs::create_dir(&current).expect("nested directory");
        }
        std::fs::write(current.join("boundary"), b"boundary").expect("boundary");

        let error = atomic_install_dir(&source, &target).expect_err("depth must be bounded");
        assert!(matches!(error, Error::ResourceLimit(_)));
        assert_eq!(
            std::fs::read(target.join("old")).expect("old target"),
            b"old"
        );
        assert!(current.join("boundary").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn directory_install_refuses_a_regular_file_beyond_the_maximum_depth() {
        let (_root, source, target) = directory_fixture();
        std::fs::remove_file(source.join("new")).expect("fixture file");
        let mut current = source.clone();
        for level in 0..(MAX_REMOVE_TREE_DEPTH - 1) {
            current = current.join(format!("level-{level}"));
            std::fs::create_dir(&current).expect("nested directory");
        }
        std::fs::write(current.join("boundary"), b"boundary").expect("boundary");

        let error = atomic_install_dir(&source, &target).expect_err("file depth must be bounded");
        assert!(matches!(error, Error::ResourceLimit(_)));
        assert_eq!(
            std::fs::read(target.join("old")).expect("old target"),
            b"old"
        );

        let (_root, source, target) = directory_fixture();
        std::fs::remove_file(source.join("new")).expect("fixture file");
        let mut current = source.clone();
        for level in 0..(MAX_REMOVE_TREE_DEPTH - 2) {
            current = current.join(format!("level-{level}"));
            std::fs::create_dir(&current).expect("nested directory");
        }
        std::fs::write(current.join("boundary"), b"boundary").expect("boundary");
        let boundary = current
            .strip_prefix(&source)
            .expect("boundary below source")
            .join("boundary");

        atomic_install_dir(&source, &target).expect("shallower file depth must install");
        assert_eq!(
            std::fs::read(target.join(boundary)).expect("installed boundary"),
            b"boundary"
        );
    }

    #[cfg(unix)]
    #[test]
    fn directory_install_rejects_links_and_special_files_without_following() {
        use std::os::unix::{fs::symlink, net::UnixListener};

        let (root, source, target) = directory_fixture();
        let outside = root.path().join("outside");
        std::fs::create_dir(&outside).expect("outside");
        std::fs::write(outside.join("sentinel"), b"untouched").expect("sentinel");
        symlink(&outside, source.join("outside-link")).expect("link");
        let error = atomic_install_dir(&source, &target).expect_err("link must be rejected");
        assert!(matches!(
            error,
            Error::InvalidInput(message) if message == "directory install rejects links and special files"
        ));
        assert_eq!(
            std::fs::read(target.join("old")).expect("old target"),
            b"old"
        );
        assert_eq!(
            std::fs::read(outside.join("sentinel")).expect("sentinel"),
            b"untouched"
        );

        let (_root, source, target) = directory_fixture();
        let _socket = UnixListener::bind(source.join("socket")).expect("socket");
        let error = atomic_install_dir(&source, &target).expect_err("socket must be rejected");
        assert!(matches!(
            error,
            Error::InvalidInput(message) if message == "directory install rejects links and special files"
        ));
        assert_eq!(
            std::fs::read(target.join("old")).expect("old target"),
            b"old"
        );
    }

    fn run_atomic_file_fault<F>(
        target: &Path,
        injector: Arc<dyn AtomicWriterInjector + Send + Sync>,
        write_fn: F,
    ) -> Result<AtomicFileOutcome, Error>
    where
        F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
    {
        set_test_atomic_file_injector(Some(injector));
        let result = atomic_replace(target, write_fn);
        set_test_atomic_file_injector(None);
        result
    }

    fn run_atomic_dir_fault(
        source: &Path,
        target: &Path,
        injector: Box<dyn AtomicDirInjector>,
    ) -> Result<(), Error> {
        set_test_atomic_dir_injector(Some(injector));
        let result = atomic_install_dir(source, target);
        set_test_atomic_dir_injector(None);
        result
    }

    #[test]
    fn fresh_target_is_private_then_durable() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("new");
        #[cfg(windows)]
        {
            let parent = windows_test_parent(dir.path());
            win::set_test_parent_inheritable_dacl(&parent).expect("inheritable parent DACL");
        }
        let outcome = run_atomic_file_fault(
            &target,
            Arc::new(PrivateTemp {
                parent: dir.path().to_path_buf(),
            }),
            |f| f.write_all(b"new").map_err(io),
        )
        .expect("replace");
        assert!(matches!(outcome, AtomicFileOutcome::DurableCommit));
        assert_eq!(std::fs::read(&target).expect("read"), b"new");
        #[cfg(windows)]
        assert!(
            win::test_security_descriptor_is_creator_only(
                &File::open(&target).expect("installed target")
            )
            .expect("installed target DACL"),
            "installed target DACL must grant access only to its creator"
        );
    }
    #[test]
    fn retained_parent_descriptor_installs_without_reopening_a_target_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        #[cfg(unix)]
        let parent = std::fs::File::open(dir.path()).expect("open parent");
        #[cfg(windows)]
        let parent = windows_test_parent(dir.path());
        let moved = dir.path().with_extension("moved");
        std::fs::rename(dir.path(), &moved).expect("rename parent");
        atomic_replace_at(&parent, std::ffi::OsStr::new("artifact.pgn"), |file| {
            file.write_all(b"exact").map_err(io)
        })
        .expect("fd-relative replace")
        .expect_durable();
        assert_eq!(
            std::fs::read(moved.join("artifact.pgn")).expect("read"),
            b"exact"
        );
        assert!(
            atomic_replace_at(&parent, std::ffi::OsStr::new("nested/name"), |_| Ok(())).is_err()
        );
    }

    fn assert_atomic_entry_point_refuses_an_empty_or_multicomponent_leaf<T>(
        entry_point: impl Fn(&File, &OsStr) -> Result<T, Error>,
    ) {
        let temp = tempfile::tempdir().expect("tempdir");
        let parent_path = temp.path().join("parent");
        std::fs::write(&parent_path, b"parent").expect("write parent");
        let parent = File::open(parent_path).expect("open parent");
        for leaf in [OsStr::new(""), OsStr::new("nested/file")] {
            assert!(matches!(
                entry_point(&parent, leaf),
                Err(Error::InvalidInput(_))
            ));
        }
    }

    #[test]
    fn atomic_replace_at_refuses_an_empty_or_multicomponent_leaf() {
        assert_atomic_entry_point_refuses_an_empty_or_multicomponent_leaf(|parent, leaf| {
            atomic_replace_at(parent, leaf, |_| Ok(()))
        });
    }

    #[test]
    fn atomic_replace_at_with_precommit_refuses_an_empty_or_multicomponent_leaf() {
        assert_atomic_entry_point_refuses_an_empty_or_multicomponent_leaf(|parent, leaf| {
            atomic_replace_at_with_precommit(parent, leaf, || Ok(()), |_| Ok(()))
        });
    }

    #[test]
    fn atomic_replace_at_identified_refuses_an_empty_or_multicomponent_leaf() {
        assert_atomic_entry_point_refuses_an_empty_or_multicomponent_leaf(|parent, leaf| {
            atomic_replace_at_identified(parent, leaf, |_| Ok(()))
        });
    }

    #[test]
    fn atomic_replace_at_identified_with_precommit_refuses_an_empty_or_multicomponent_leaf() {
        assert_atomic_entry_point_refuses_an_empty_or_multicomponent_leaf(|parent, leaf| {
            atomic_replace_at_identified_with_precommit(parent, leaf, || Ok(()), |_| Ok(()))
        });
    }
    #[cfg(unix)]
    fn assert_logical_parent_unchanged(parent: &File, logical: &Path) -> Result<(), Error> {
        use std::os::unix::fs::MetadataExt;
        let expected = parent.metadata()?;
        let current = std::fs::symlink_metadata(logical)?;
        if current.file_type().is_symlink()
            || current.dev() != expected.dev()
            || current.ino() != expected.ino()
        {
            return Err(Error::Conflict(
                "logical parent changed after resolution".into(),
            ));
        }
        Ok(())
    }
    #[cfg(unix)]
    #[test]
    fn fd_replace_rejects_real_logical_parent_swap_without_touching_either_target() {
        let root = tempfile::tempdir().unwrap();
        let logical = root.path().join("logical");
        let old = root.path().join("old");
        std::fs::create_dir(&logical).unwrap();
        std::fs::write(logical.join("artifact"), b"old").unwrap();
        let parent = std::fs::File::open(&logical).unwrap();
        std::fs::rename(&logical, &old).unwrap();
        std::fs::create_dir(&logical).unwrap();
        std::fs::write(logical.join("artifact"), b"outside").unwrap();
        let result = atomic_replace_at_with_precommit(
            &parent,
            std::ffi::OsStr::new("artifact"),
            || assert_logical_parent_unchanged(&parent, &logical),
            |file| file.write_all(b"new").map_err(io),
        );
        assert!(matches!(result, Err(Error::Conflict(_))));
        assert_eq!(std::fs::read(old.join("artifact")).unwrap(), b"old");
        assert_eq!(std::fs::read(logical.join("artifact")).unwrap(), b"outside");
    }
    #[cfg(unix)]
    #[test]
    fn fd_replace_rejects_symlink_logical_parent_swap_without_touching_either_target() {
        let root = tempfile::tempdir().unwrap();
        let logical = root.path().join("logical");
        let replacement = root.path().join("replacement");
        let old = root.path().join("old");
        std::fs::create_dir(&logical).unwrap();
        std::fs::create_dir(&replacement).unwrap();
        std::fs::write(logical.join("artifact"), b"old").unwrap();
        std::fs::write(replacement.join("artifact"), b"outside").unwrap();
        let parent = std::fs::File::open(&logical).unwrap();
        std::fs::rename(&logical, &old).unwrap();
        std::os::unix::fs::symlink(&replacement, &logical).unwrap();
        let result = atomic_replace_at_with_precommit(
            &parent,
            std::ffi::OsStr::new("artifact"),
            || assert_logical_parent_unchanged(&parent, &logical),
            |file| file.write_all(b"new").map_err(io),
        );
        assert!(matches!(result, Err(Error::Conflict(_))));
        assert_eq!(std::fs::read(old.join("artifact")).unwrap(), b"old");
        assert_eq!(
            std::fs::read(replacement.join("artifact")).unwrap(),
            b"outside"
        );
    }
    #[test]
    fn replacement_preserves_existing_target_and_mode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("old");
        std::fs::write(&target, b"old").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640))
                .expect("mode");
        }
        atomic_replace(&target, |file| file.write_all(b"new").map_err(io))
            .expect("replace")
            .expect_durable();
        assert_eq!(std::fs::read(&target).expect("read"), b"new");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&target)
                    .expect("metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o640
            );
        }
    }

    #[test]
    fn caller_precommit_runs_after_revalidation_before_rename_and_preserves_target_on_conflict() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("target");
        std::fs::write(&target, b"old").expect("old");
        let complete = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let injector = PrecommitOrder {
            complete: complete.clone(),
            observed_at_rename: observed.clone(),
        };
        set_test_atomic_file_injector(Some(Arc::new(injector)));
        atomic_replace_with_precommit(
            &target,
            || {
                complete.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            },
            |file| file.write_all(b"new").map_err(io),
        )
        .expect("replace")
        .expect_durable();
        set_test_atomic_file_injector(None);
        assert!(observed.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(std::fs::read(&target).expect("target"), b"new");
        let rejected = dir.path().join("rejected");
        std::fs::write(&rejected, b"old").expect("old");
        assert!(matches!(
            atomic_replace_with_precommit(
                &rejected,
                || Err(Error::Conflict("caller validation failed".into())),
                |file| file.write_all(b"new").map_err(io)
            ),
            Err(Error::Conflict(_))
        ));
        assert_eq!(std::fs::read(&rejected).expect("target"), b"old");
        assert_eq!(std::fs::read_dir(dir.path()).expect("entries").count(), 2);
    }
    #[test]
    fn file_fault_matrix_preserves_old_or_absent_target() {
        for point in [
            AtomicFileFaultPoint::ParentOpen,
            AtomicFileFaultPoint::TempfileCreate,
            AtomicFileFaultPoint::Write,
            AtomicFileFaultPoint::Flush,
            AtomicFileFaultPoint::FileSync,
            AtomicFileFaultPoint::PermissionCopy,
            AtomicFileFaultPoint::PreCommitRevalidate,
            AtomicFileFaultPoint::Rename,
        ] {
            let dir = tempfile::tempdir().expect("tempdir");
            let target = dir.path().join("new");
            let fault = Fault(Some(point), None, Arc::new(Mutex::new(Vec::new())));
            assert!(run_atomic_file_fault(&target, Arc::new(fault), |f| f
                .write_all(b"new")
                .map_err(io))
            .is_err());
            assert!(!target.exists());
        }
    }

    #[test]
    fn file_post_commit_and_cleanup_precedence_are_explicit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("new");
        let sync_fault = Fault(
            Some(AtomicFileFaultPoint::ParentSync),
            None,
            Arc::new(Mutex::new(Vec::new())),
        );
        assert!(matches!(
            run_atomic_file_fault(&target, Arc::new(sync_fault), |f| f
                .write_all(b"new")
                .map_err(io)),
            Ok(AtomicFileOutcome::CommittedDurabilityUncertain(_))
        ));
        assert_eq!(std::fs::read(&target).expect("read"), b"new");
        let second = dir.path().join("second");
        let cleanup_points = Arc::new(Mutex::new(Vec::new()));
        let cleanup_fault = Fault(
            Some(AtomicFileFaultPoint::Write),
            Some(AtomicFileFaultPoint::Cleanup),
            cleanup_points.clone(),
        );
        assert!(run_atomic_file_fault(&second, Arc::new(cleanup_fault), |_| Ok(())).is_err());
        assert!(cleanup_points
            .lock()
            .expect("lock")
            .contains(&AtomicFileFaultPoint::Cleanup));
        assert!(!second.exists());
        let third = dir.path().join("third");
        let real_cleanup_fault = BreakCleanup {
            parent: dir.path().to_path_buf(),
        };
        match run_atomic_file_fault(&third, Arc::new(real_cleanup_fault), |_| Ok(())) {
            Err(error @ Error::OperationAndCleanup { .. }) => {
                let Error::OperationAndCleanup { primary, cleanup } = &error else {
                    unreachable!();
                };
                assert!(primary.contains("I/O failure: primary"), "{primary}");
                assert!(!cleanup.is_empty());
                let serialized = serde_json::to_string(&error).expect("serialize cleanup error");
                let payload: serde_json::Value =
                    serde_json::from_str(&serialized).expect("serialized error is a JSON object");
                assert_eq!(payload["category"], "operation-and-cleanup");
                assert_eq!(
                    payload["message"],
                    "Operation failed; temporary cleanup also failed"
                );
            }
            other => panic!("expected structured cleanup error, got {other:?}"),
        }
    }

    #[test]
    fn workspace_file_name_taken_at_revalidation_and_at_rename_cleans_temporary_file() {
        for point in [
            AtomicFileFaultPoint::PreCommitRevalidate,
            AtomicFileFaultPoint::Rename,
        ] {
            let root = tempfile::tempdir().expect("tempdir");
            let target = root.path().join("target");
            let parent = open_parent_no_follow(&target).expect("parent");
            let _injector = install_test_atomic_file_injector(Arc::new(Mutation {
                point,
                target: target.clone(),
                #[cfg(not(windows))]
                parent: root.path().to_path_buf(),
                action: "create",
            }));
            clear_durability_log();
            let error = atomic_create_at_identified(&parent, OsStr::new("target"), |file| {
                file.write_all(b"new").map_err(io)
            })
            .expect_err("competing creator wins");
            let payload = serde_json::to_value(&error).expect("error payload");
            assert_eq!(payload["category"], "conflict");
            assert_eq!(payload["nameTaken"], true);
            assert!(durability_log().contains(&"target_stat:revalidation"));
            assert_eq!(std::fs::read(&target).expect("winner"), b"racer");
            assert_eq!(std::fs::read_dir(root.path()).expect("entries").count(), 1);
        }
    }

    #[test]
    fn workspace_file_name_taken_initial_refusal_precedes_temporary_file_creation() {
        let root = tempfile::tempdir().expect("tempdir");
        let target = root.path().join("target");
        std::fs::write(&target, b"old").expect("old");
        let parent = open_parent_no_follow(&target).expect("parent");
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let _injector = install_test_atomic_file_injector(Arc::new(Fault(
            Some(AtomicFileFaultPoint::TempfileCreate),
            None,
            calls.clone(),
        )));
        let error = atomic_create_at_identified(&parent, OsStr::new("target"), |_| {
            panic!("existing target must be refused before writing")
        })
        .expect_err("name taken");
        assert_eq!(serde_json::to_value(error).unwrap()["nameTaken"], true);
        assert!(calls.lock().expect("calls").is_empty());
        assert_eq!(std::fs::read(target).expect("old bytes"), b"old");
    }

    fn assert_create_rejects_nonregular_race(point: AtomicFileFaultPoint, action: &'static str) {
        let root = tempfile::tempdir().expect("tempdir");
        let target = root.path().join("target");
        let parent = open_parent_no_follow(&target).expect("parent");
        let _injector = install_test_atomic_file_injector(Arc::new(Mutation {
            point,
            target: target.clone(),
            #[cfg(not(windows))]
            parent: root.path().to_path_buf(),
            action,
        }));
        let error = atomic_create_at_identified(&parent, OsStr::new("target"), |file| {
            file.write_all(b"new").map_err(io)
        })
        .expect_err("non-regular competing node must be rejected");
        assert!(
            matches!(&error, Error::InvalidInput(message)
                if message == "target must be a regular file, not a link or special file"),
            "{error:?}"
        );
        let payload = serde_json::to_value(&error).expect("error payload");
        assert_eq!(payload["category"], "invalid-input");
        assert!(payload.get("nameTaken").is_none(), "{payload}");
        let metadata = std::fs::symlink_metadata(&target).expect("preserved target");
        match action {
            "directory" => {
                assert!(metadata.is_dir());
                assert_eq!(std::fs::read_dir(&target).expect("directory").count(), 0);
            }
            #[cfg(unix)]
            "symlink" => {
                assert!(metadata.file_type().is_symlink());
                assert_eq!(
                    std::fs::read_link(&target).expect("link"),
                    Path::new("replacement")
                );
            }
            _ => unreachable!("test action"),
        }
        let entries: Vec<_> = std::fs::read_dir(root.path())
            .expect("entries")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert_eq!(entries, vec![OsString::from("target")]);
    }

    #[test]
    fn workspace_file_name_taken_rejects_directories_at_revalidation_and_at_rename() {
        for point in [
            AtomicFileFaultPoint::PreCommitRevalidate,
            AtomicFileFaultPoint::Rename,
        ] {
            assert_create_rejects_nonregular_race(point, "directory");
        }
    }

    #[cfg(unix)]
    #[test]
    fn workspace_file_name_taken_rejects_symlinks_at_revalidation() {
        assert_create_rejects_nonregular_race(AtomicFileFaultPoint::PreCommitRevalidate, "symlink");
    }

    #[test]
    fn workspace_file_name_taken_keeps_other_rename_failures_as_io() {
        let root = tempfile::tempdir().expect("tempdir");
        let parent = open_parent_no_follow(&root.path().join("target")).expect("parent");
        let _injector = install_test_atomic_file_injector(Arc::new(Fault(
            Some(AtomicFileFaultPoint::Rename),
            None,
            Arc::new(std::sync::Mutex::new(Vec::new())),
        )));
        let error = atomic_create_at_identified(&parent, OsStr::new("target"), |file| {
            file.write_all(b"new").map_err(io)
        })
        .expect_err("injected I/O error");
        assert!(matches!(error, Error::Io(_)), "{error:?}");
        assert_eq!(std::fs::read_dir(root.path()).expect("entries").count(), 0);
    }

    #[test]
    fn file_revalidation_races_are_conflicts_and_actual_rename_failure_is_preserved() {
        for (existing, action) in [(false, "create"), (true, "replace")] {
            let root = tempfile::tempdir().expect("tempdir");
            let parent = root.path().join("parent");
            std::fs::create_dir(&parent).expect("parent");
            let target = parent.join("target");
            if existing {
                std::fs::write(&target, b"old").expect("old");
            }
            let injector = Mutation {
                point: AtomicFileFaultPoint::PreCommitRevalidate,
                target: target.clone(),
                #[cfg(not(windows))]
                parent: parent.clone(),
                action,
            };
            match run_atomic_file_fault(&target, Arc::new(injector), |f| {
                f.write_all(b"new").map_err(io)
            }) {
                Err(Error::Conflict(_)) => {}
                other => panic!("{action} revalidation race: {other:?}"),
            }
            if action == "create" {
                assert_eq!(std::fs::read(&target).expect("read"), b"racer");
            }
            #[cfg(unix)]
            if action == "replace" {
                assert!(std::fs::symlink_metadata(&target)
                    .expect("metadata")
                    .file_type()
                    .is_symlink());
            }
        }
        let root = tempfile::tempdir().expect("tempdir");
        let parent = root.path().join("parent");
        std::fs::create_dir(&parent).expect("parent");
        let target = parent.join("target");
        let injector = Mutation {
            point: AtomicFileFaultPoint::PreCommitRevalidate,
            target: target.clone(),
            #[cfg(not(windows))]
            parent: parent.clone(),
            action: "parent",
        };
        match run_atomic_file_fault(&target, Arc::new(injector), |f| {
            f.write_all(b"new").map_err(io)
        }) {
            Err(Error::Conflict(_)) => {}
            other => panic!("parent revalidation race: {other:?}"),
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("target");
        let injector = Mutation {
            point: AtomicFileFaultPoint::Rename,
            target: target.clone(),
            #[cfg(not(windows))]
            parent: dir.path().to_path_buf(),
            action: "create",
        };
        let result = run_atomic_file_fault(&target, Arc::new(injector), |f| {
            f.write_all(b"new").map_err(io)
        });
        #[cfg(unix)]
        match result {
            Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            other => panic!("rename collision: {other:?}"),
        }
        #[cfg(windows)]
        match result {
            Err(Error::Conflict(message)) if message == "Windows object name collision" => {}
            other => panic!("rename collision: {other:?}"),
        }
        assert_eq!(std::fs::read(target).expect("read"), b"racer");
    }

    #[test]
    fn nofollow_rejects_ancestor_and_final_parent_symlinks_and_temp_collision_retries() {
        #[cfg(unix)]
        {
            let root = tempfile::tempdir().expect("root");
            let real = root.path().join("real");
            std::fs::create_dir(&real).expect("real");
            let ancestor = root.path().join("ancestor");
            std::os::unix::fs::symlink(&real, &ancestor).expect("symlink");
            assert!(atomic_replace(&ancestor.join("target"), |_| Ok(())).is_err());
            let final_parent = root.path().join("final");
            std::os::unix::fs::symlink(&real, &final_parent).expect("symlink");
            assert!(atomic_replace(&final_parent.join("target"), |_| Ok(())).is_err());
            let _temp_names =
                unix::scoped_test_temp_names(vec!["available".into(), "collision".into()]);
            std::fs::write(root.path().join("collision"), b"collision").expect("collision");
            atomic_replace(&root.path().join("target"), |f| {
                f.write_all(b"new").map_err(io)
            })
            .expect("retry")
            .expect_durable();
            assert_eq!(
                std::fs::read(root.path().join("target")).expect("target"),
                b"new"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn temporary_name_overrides_are_thread_owned_and_scoped() {
        use std::sync::mpsc;
        use std::time::Duration;

        let (first_ready_tx, first_ready_rx) = mpsc::channel();
        let (second_ready_tx, second_ready_rx) = mpsc::channel();
        let (run_first_tx, run_first_rx) = mpsc::channel();
        let (first_done_tx, first_done_rx) = mpsc::channel();

        let first = std::thread::spawn(move || {
            let root = tempfile::tempdir().expect("first tempdir");
            std::fs::write(root.path().join(".atomic-first-collision"), b"collision")
                .expect("first collision");
            let observed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            {
                let _names = unix::scoped_test_temp_names(vec![
                    ".atomic-first-unused".into(),
                    ".atomic-first-available".into(),
                    ".atomic-first-collision".into(),
                ]);
                first_ready_tx.send(()).expect("first ready");
                run_first_rx
                    .recv_timeout(Duration::from_secs(5))
                    .expect("run first");
                let observed_in_write = observed.clone();
                atomic_replace(&root.path().join("target"), |_| {
                    observed_in_write.store(
                        root.path().join(".atomic-first-available").exists(),
                        std::sync::atomic::Ordering::SeqCst,
                    );
                    Ok(())
                })
                .expect("first replacement")
                .expect_durable();
            }
            first_done_tx.send(()).expect("first done");
            atomic_replace(&root.path().join("after-scope"), |_| {
                assert!(!root.path().join(".atomic-first-unused").exists());
                Ok(())
            })
            .expect("first replacement after scope")
            .expect_durable();
            let unwind = std::panic::catch_unwind(|| {
                let _names =
                    unix::scoped_test_temp_names(vec![".atomic-first-panic-unused".into()]);
                panic!("exercise temporary-name guard cleanup");
            });
            assert!(unwind.is_err());
            atomic_replace(&root.path().join("after-unwind"), |_| {
                assert!(!root.path().join(".atomic-first-panic-unused").exists());
                Ok(())
            })
            .expect("first replacement after unwind")
            .expect_durable();
            observed.load(std::sync::atomic::Ordering::SeqCst)
        });

        first_ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("first installed names");
        let second = std::thread::spawn(move || {
            let root = tempfile::tempdir().expect("second tempdir");
            std::fs::write(root.path().join(".atomic-second-collision"), b"collision")
                .expect("second collision");
            let observed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let _names = unix::scoped_test_temp_names(vec![
                ".atomic-second-available".into(),
                ".atomic-second-collision".into(),
            ]);
            second_ready_tx.send(()).expect("second ready");
            first_done_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("first finished replacement");
            let observed_in_write = observed.clone();
            atomic_replace(&root.path().join("target"), |_| {
                observed_in_write.store(
                    root.path().join(".atomic-second-available").exists(),
                    std::sync::atomic::Ordering::SeqCst,
                );
                Ok(())
            })
            .expect("second replacement")
            .expect_durable();
            observed.load(std::sync::atomic::Ordering::SeqCst)
        });

        second_ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("second installed names");
        run_first_tx.send(()).expect("run first replacement");
        let first_observed_own_name = first.join().expect("first thread");
        let second_observed_own_name = second.join().expect("second thread");
        assert!(first_observed_own_name);
        assert!(second_observed_own_name);
    }

    #[cfg(unix)]
    #[test]
    fn directory_fault_matrix_preserves_or_recovers_old_target() {
        for point in [
            AtomicDirFaultPoint::SyncEntry,
            AtomicDirFaultPoint::PreCommit,
            AtomicDirFaultPoint::BackupRename,
            AtomicDirFaultPoint::InstallRename,
        ] {
            let (_root, source, target) = directory_fixture();
            let injector = DirFault { point };
            assert!(run_atomic_dir_fault(&source, &target, Box::new(injector)).is_err());
            assert_eq!(std::fs::read(target.join("old")).expect("old"), b"old");
        }
        let (_root, source, target) = directory_fixture();
        let injector = DirFault {
            point: AtomicDirFaultPoint::ParentSync,
        };
        assert!(matches!(
            run_atomic_dir_fault(&source, &target, Box::new(injector)),
            Err(Error::CommittedDurabilityUncertain(_))
        ));
        assert_eq!(std::fs::read(target.join("new")).expect("new"), b"new");

        let root = tempfile::tempdir().expect("root");
        let source = root.path().join("source");
        let target = root.path().join("target");
        std::fs::create_dir(&source).expect("source");
        std::fs::write(source.join("new"), b"new").expect("new");
        assert!(matches!(
            run_atomic_dir_fault(
                &source,
                &target,
                Box::new(DirTargetMutation {
                    target: target.clone(),
                    existing: false
                })
            ),
            Err(Error::Conflict(_))
        ));
        assert!(target.is_dir());
        let (_root, source, target) = directory_fixture();
        assert!(matches!(
            run_atomic_dir_fault(
                &source,
                &target,
                Box::new(DirTargetMutation {
                    target: target.clone(),
                    existing: true
                })
            ),
            Err(Error::Conflict(_))
        ));

        let (_root, source, target) = directory_fixture();
        assert!(run_atomic_dir_fault(
            &source,
            &target,
            Box::new(SourceSwap {
                source: source.clone()
            })
        )
        .is_err());
        #[cfg(unix)]
        assert!(std::fs::symlink_metadata(source)
            .expect("source")
            .file_type()
            .is_symlink());
        let (_root, source, target) = directory_fixture();
        let injector = DirFault {
            point: AtomicDirFaultPoint::BackupCleanup,
        };
        assert!(matches!(
            run_atomic_dir_fault(&source, &target, Box::new(injector)),
            Err(Error::CommittedDurabilityUncertain(_))
        ));
        assert_eq!(std::fs::read(target.join("new")).expect("new"), b"new");
    }

    #[cfg(windows)]
    fn run_atomic_at_fault<F>(
        parent: &File,
        leaf: &OsStr,
        injector: Arc<dyn AtomicWriterInjector + Send + Sync>,
        write_fn: F,
    ) -> Result<AtomicInstalledFile, Error>
    where
        F: FnOnce(&mut OwnedFile) -> Result<(), Error>,
    {
        set_test_atomic_file_injector(Some(injector));
        let result = atomic_replace_at_identified(parent, leaf, write_fn);
        set_test_atomic_file_injector(None);
        result
    }

    #[cfg(windows)]
    fn assert_no_windows_temporary_files(path: &Path) {
        assert!(
            std::fs::read_dir(path)
                .expect("temporary directory")
                .filter_map(Result::ok)
                .all(|entry| !entry.file_name().to_string_lossy().starts_with(".atomic-")),
            "temporary file survived cleanup"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_filetime_ticks_become_unix_seconds() {
        // 1970-01-01T00:00:00Z expressed as a FILETIME.
        assert_eq!(win::filetime_to_unix_seconds(116_444_736_000_000_000), 0);
        // 2001-09-09T01:46:40Z, i.e. Unix second 1_000_000_000.
        assert_eq!(
            win::filetime_to_unix_seconds(126_444_736_000_000_000),
            1_000_000_000
        );
        // Sub-second ticks truncate downwards rather than rounding into the next second.
        assert_eq!(win::filetime_to_unix_seconds(116_444_736_009_999_999), 0);
        // A zero or negative FILETIME is a pre-1970 instant, not a panic.
        assert_eq!(win::filetime_to_unix_seconds(0), -11_644_473_600);
        assert_eq!(win::filetime_to_unix_seconds(-1), -11_644_473_601);
        for bits in [116_444_735_990_000_000_u64, u64::MAX] {
            assert_eq!(
                win::filetime_bits_to_unix_seconds(bits),
                win::filetime_to_unix_seconds(bits as i64)
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_enumerated_identity_equals_the_opened_child_identity() {
        // A raw `FileId` carries no volume serial and would fail every later confirmation, which
        // opens the child and compares `opened_file_identity`. No Linux run can observe this.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("game.pgn"), b"pgn").expect("child file");
        std::fs::create_dir(dir.path().join("folder")).expect("child directory");
        let parent = windows_test_parent(dir.path());
        let listed =
            read_directory_entries_at(&parent, &CancellationToken::new(), None, &mut |_| true)
                .expect("listing");
        for (name, is_dir) in [("game.pgn", false), ("folder", true)] {
            let entry = listed
                .iter()
                .find(|entry| entry.name == OsStr::new(name))
                .unwrap_or_else(|| panic!("{name} must be listed"));
            assert_eq!(
                entry.identity,
                entry_identity_at(&parent, &entry.name, is_dir).expect("identity"),
                "{name} enumeration identity must equal the opened-handle identity"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_listing_reports_a_junction_as_other() {
        // A junction is FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT. Classified on
        // the directory bit it would be descended, `open_child_directory` would refuse it, and
        // the whole listing would fail where unix returns the tree minus the link.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(dir.path().join("real")).expect("target directory");
        windows_test_junction(&dir.path().join("link"), &dir.path().join("real"));
        let parent = windows_test_parent(dir.path());
        let listed =
            read_directory_entries_at(&parent, &CancellationToken::new(), None, &mut |_| true)
                .expect("listing");
        let link = listed
            .iter()
            .find(|entry| entry.name == OsStr::new("link"))
            .expect("the junction must be listed");
        assert_eq!(link.kind, DirectoryEntryKind::Other);
        let real = listed
            .iter()
            .find(|entry| entry.name == OsStr::new("real"))
            .expect("the real directory must be listed");
        assert_eq!(real.kind, DirectoryEntryKind::Directory);
    }

    #[cfg(windows)]
    #[test]
    fn windows_recursive_delete_refuses_a_junction_child_without_traversing_it() {
        // The Windows counterpart of `recursive_delete_rejects_symlink_children_without_
        // traversing_them`, which has to stay `#[cfg(unix)]` because it creates a symlink.
        // A junction is FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT: classified on
        // the directory bit the walk would descend it and delete another directory's contents,
        // so `enumerated_kind` reports `Other` and the removal fails closed exactly as unix does.
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        let victim = root.join("victim");
        std::fs::create_dir(&root).expect("root");
        std::fs::create_dir(&outside).expect("outside");
        std::fs::create_dir(&victim).expect("victim");
        std::fs::write(outside.join("keep"), b"outside").expect("outside file");
        windows_test_junction(&victim.join("link"), &outside);
        let parent = test_parent(&root);
        let expected = entry_identity_at(&parent, OsStr::new("victim"), true).expect("identity");

        let error = remove_entry_at(&parent, OsStr::new("victim"), expected, true)
            .expect_err("a junction child must be refused");

        assert!(matches!(error, Error::InvalidInput(_)), "{error:?}");
        assert_eq!(
            std::fs::read(outside.join("keep")).expect("outside intact"),
            b"outside",
            "the descent never followed the junction"
        );
        assert!(victim.exists(), "the refusal removes nothing");
    }

    /// A staging tree plus an absent destination, both inside one temp parent.
    #[cfg(windows)]
    fn windows_install_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().expect("tempdir");
        let source = root.path().join("staging");
        let target = root.path().join("installed");
        std::fs::create_dir(&source).expect("staging");
        std::fs::write(source.join("engine"), b"new").expect("staged file");
        (root, source, target)
    }

    /// The Windows materialisation of `BackupRename` is the point *after* the live target has
    /// been parked at `{INSTALL_BACKUP_PREFIX}<uuid>`, so an injected failure there exercises the
    /// rollback rename rather than the pre-commit revalidation.
    #[cfg(windows)]
    struct FailingInstallAndRollback;

    #[cfg(windows)]
    impl AtomicDirInjector for FailingInstallAndRollback {
        fn inject(&self, point: AtomicDirFaultPoint) -> std::io::Result<()> {
            match point {
                AtomicDirFaultPoint::InstallRename => {
                    Err(std::io::Error::other("injected install rename"))
                }
                AtomicDirFaultPoint::RollbackRename => {
                    Err(std::io::Error::other("injected rollback rename"))
                }
                _ => Ok(()),
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn install_dir_windows_replaces_an_existing_target() {
        let (root, source, target) = windows_install_fixture();
        std::fs::create_dir(&target).expect("existing target");
        std::fs::write(target.join("old"), b"old").expect("old tree");

        atomic_install_dir(&source, &target).expect("replace");

        assert_eq!(
            std::fs::read(target.join("engine")).expect("new tree"),
            b"new"
        );
        assert!(
            !target.join("old").exists(),
            "the displaced tree must be removed after a successful replace"
        );
        let leftovers = std::fs::read_dir(root.path())
            .expect("parent listing")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(INSTALL_BACKUP_PREFIX)
            })
            .count();
        assert_eq!(leftovers, 0, "a successful replace leaves no backup");
    }

    #[cfg(windows)]
    #[test]
    fn install_dir_windows_absent_target_renames() {
        let (_root, source, target) = windows_install_fixture();

        atomic_install_dir(&source, &target).expect("install");

        assert_eq!(
            std::fs::read(target.join("engine")).expect("installed tree"),
            b"new"
        );
        assert!(
            !source.exists(),
            "the staging name is consumed by the rename"
        );
    }

    #[cfg(windows)]
    #[test]
    fn install_dir_windows_backup_rename_rollbacks() {
        let (root, source, target) = windows_install_fixture();
        std::fs::create_dir(&target).expect("existing target");
        std::fs::write(target.join("old"), b"old").expect("old tree");

        let error = run_atomic_dir_fault(
            &source,
            &target,
            Box::new(DirFault {
                point: AtomicDirFaultPoint::BackupRename,
            }),
        )
        .expect_err("the injected backup rename must fail the install");

        assert!(matches!(error, Error::Io(_)), "{error:?}");
        assert_eq!(
            std::fs::read(target.join("old")).expect("old tree restored"),
            b"old"
        );
        assert!(
            !target.join("engine").exists(),
            "the staged tree never lands"
        );
        assert!(
            source.join("engine").is_file(),
            "the staging tree is untouched"
        );
        let leftovers = std::fs::read_dir(root.path())
            .expect("parent listing")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(INSTALL_BACKUP_PREFIX)
            })
            .count();
        assert_eq!(
            leftovers, 0,
            "a successful rollback leaves no backup behind"
        );
    }

    #[cfg(windows)]
    #[test]
    fn install_dir_windows_rollback_failure_is_an_uncommitted_conflict() {
        let (root, source, target) = windows_install_fixture();
        std::fs::create_dir(&target).expect("existing target");
        std::fs::write(target.join("old"), b"old").expect("old tree");
        let capture = crate::error::LogCaptureScope::start();

        let error = run_atomic_dir_fault(&source, &target, Box::new(FailingInstallAndRollback))
            .expect_err("a failed rollback did not commit");

        assert!(
            matches!(error, Error::Conflict(_)),
            "failed rollback must not claim durability-uncertain/applied: {error:?}"
        );
        assert!(!target.exists(), "the install rename never ran");
        let backup_name = std::fs::read_dir(root.path())
            .expect("parent listing")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name())
            .find(|name| name.to_string_lossy().starts_with(INSTALL_BACKUP_PREFIX))
            .map(|name| name.to_string_lossy().into_owned())
            .expect("the parked old tree must remain for the user to see");
        let messages = capture.messages();
        assert!(
            messages
                .iter()
                .any(|message| message.contains(&backup_name)),
            "the failed-rollback log must name the backup leaf {backup_name}: {messages:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn install_dir_windows_refuses_a_junction() {
        let root = tempfile::tempdir().expect("tempdir");
        let source = root.path().join("staging");
        let target = root.path().join("installed");
        let outside = root.path().join("outside");
        std::fs::create_dir(&outside).expect("outside");
        windows_test_junction(&source, &outside);

        let error = atomic_install_dir(&source, &target)
            .expect_err("a junction staging source must be refused");

        assert!(matches!(error, Error::InvalidInput(_)), "{error:?}");
        assert!(!target.exists(), "the refusal installs nothing");
    }

    #[cfg(windows)]
    #[test]
    fn windows_replace_at_installs_durably() {
        let dir = tempfile::tempdir().expect("tempdir");
        let parent = windows_test_parent(dir.path());
        atomic_replace_at(&parent, OsStr::new("target"), |file| {
            file.write_all(b"new").map_err(io)
        })
        .expect("replace")
        .expect_durable();
        assert_eq!(
            std::fs::read(dir.path().join("target")).expect("target"),
            b"new"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_replace_at_records_real_durability_sequence() {
        let dir = tempfile::tempdir().expect("tempdir");
        let parent = windows_test_parent(dir.path());
        clear_durability_log();
        atomic_replace_at(&parent, OsStr::new("target"), |file| {
            file.write_all(b"new").map_err(io)
        })
        .expect("replace")
        .expect_durable();
        let log = durability_log();
        assert!(
            log.iter().position(|entry| *entry == "temp.flush")
                < log
                    .iter()
                    .position(|entry| *entry == "temp.sync_all:content")
        );
        assert!(
            log.iter().position(|entry| *entry == "temp.metadata")
                < log.iter().position(|entry| *entry == "dir.sync_all")
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_precommit_logs_after_revalidation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let parent = windows_test_parent(dir.path());
        clear_durability_log();
        let observed = Arc::new(Mutex::new(Vec::new()));
        let observed_by_precommit = Arc::clone(&observed);
        atomic_replace_at_with_precommit(
            &parent,
            OsStr::new("target"),
            move || {
                observed_by_precommit
                    .lock()
                    .expect("log")
                    .extend(durability_log());
                Ok(())
            },
            |file| file.write_all(b"new").map_err(io),
        )
        .expect("replace")
        .expect_durable();
        assert_eq!(
            observed.lock().expect("log").last().copied(),
            Some("target_stat:revalidation")
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_post_rename_identity_query_is_performed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("target");
        let parent = windows_test_parent(dir.path());
        clear_durability_log();
        let result = run_atomic_at_fault(
            &parent,
            OsStr::new("target"),
            Arc::new(Fault(None, None, Arc::new(Mutex::new(Vec::new())))),
            |file| file.write_all(b"new").map_err(io),
        )
        .expect("replace");
        result.outcome.expect_durable();
        let durability = durability_log();
        assert!(
            durability.contains(&"temp.metadata"),
            "durability log: {durability:?}"
        );
        assert_eq!(
            result.identity,
            crate::infra::path_authority::opened_file_identity(
                &File::open(&target).expect("target")
            )
            .expect("identity")
        );
        assert_eq!(std::fs::read(&target).expect("target"), b"new");
        // A live pathname swap cannot be staged while the private temporary is retained: the
        // exact sharing mask under test rejects the second opener, which is `f-20260916-12`. The
        // invariant it used to prove at runtime — that the post-rename identity comes from the
        // retained handle and never from re-opening the pathname — is pinned against the source
        // instead, beside this repository's other source pins in `infra/platform_support/tests.rs`,
        // so that rewriting the query to reopen the target fails a test rather than passing
        // silently.
    }

    #[cfg(windows)]
    #[test]
    fn windows_post_rename_metadata_failure_reports_uncertain_with_target_values() {
        let dir = tempfile::tempdir().expect("tempdir");
        let parent = windows_test_parent(dir.path());
        let result = run_atomic_at_fault(
            &parent,
            OsStr::new("target"),
            Arc::new(Fault(
                Some(AtomicFileFaultPoint::PostRenameMetadata),
                None,
                Arc::new(Mutex::new(Vec::new())),
            )),
            |file| file.write_all(b"new").map_err(io),
        )
        .expect("committed replacement retains its marker");
        assert!(matches!(
            result.outcome,
            AtomicFileOutcome::CommittedDurabilityUncertain(_)
        ));
        let target = File::open(dir.path().join("target")).expect("target");
        assert_eq!(
            result.identity,
            crate::infra::path_authority::opened_file_identity(&target).expect("identity")
        );
        assert_eq!(
            std::fs::read(dir.path().join("target")).expect("read"),
            b"new"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_dacl_is_preserved_across_replacement() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target_path = dir.path().join("target");
        std::fs::write(&target_path, b"old").expect("old");
        win::set_test_target_security_descriptor(&target_path, win::TARGET_ACCESS)
            .expect("distinct target DACL");
        let parent = windows_test_parent(dir.path());
        let parent_dacl = win::test_security_descriptor(&parent).expect("parent DACL");
        let before = win::test_security_descriptor(&File::open(&target_path).expect("target"))
            .expect("target DACL");
        assert_ne!(before, parent_dacl);
        atomic_replace_at(&parent, OsStr::new("target"), |file| {
            file.write_all(b"new").map_err(io)
        })
        .expect("replace")
        .expect_durable();
        let after = win::test_security_descriptor(&File::open(&target_path).expect("target"))
            .expect("installed DACL");
        assert_eq!(before, after);
    }

    #[cfg(windows)]
    #[test]
    fn windows_dacl_capture_failure_fails_closed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("target");
        std::fs::write(&target, b"old").expect("old");
        let result = run_atomic_file_fault(
            &target,
            Arc::new(Fault(
                Some(AtomicFileFaultPoint::DaclCapture),
                None,
                Arc::new(Mutex::new(Vec::new())),
            )),
            |file| file.write_all(b"new").map_err(io),
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read(&target).expect("target"), b"old");
        assert_no_windows_temporary_files(dir.path());
    }

    #[cfg(windows)]
    #[test]
    fn windows_dacl_apply_failure_fails_closed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("target");
        std::fs::write(&target, b"old").expect("old");
        let result = run_atomic_file_fault(
            &target,
            Arc::new(Fault(
                Some(AtomicFileFaultPoint::DaclApply),
                None,
                Arc::new(Mutex::new(Vec::new())),
            )),
            |file| file.write_all(b"new").map_err(io),
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read(&target).expect("target"), b"old");
        assert_no_windows_temporary_files(dir.path());
    }

    #[cfg(windows)]
    #[test]
    fn windows_target_stat_failure_cleans_up() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("target");
        std::fs::write(&target, b"old").expect("old");
        let result = run_atomic_file_fault(
            &target,
            Arc::new(Fault(
                Some(AtomicFileFaultPoint::TargetStat),
                None,
                Arc::new(Mutex::new(Vec::new())),
            )),
            |file| file.write_all(b"new").map_err(io),
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read(&target).expect("target"), b"old");
        assert_no_windows_temporary_files(dir.path());
    }

    #[cfg(windows)]
    #[test]
    fn windows_temp_metadata_failure_cleans_up() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("target");
        std::fs::write(&target, b"old").expect("old");
        let result = run_atomic_file_fault(
            &target,
            Arc::new(Fault(
                Some(AtomicFileFaultPoint::TempMetadata),
                None,
                Arc::new(Mutex::new(Vec::new())),
            )),
            |file| file.write_all(b"new").map_err(io),
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read(&target).expect("target"), b"old");
        assert_no_windows_temporary_files(dir.path());
    }

    #[cfg(windows)]
    #[test]
    fn windows_workspace_entry_rename_to_one_character_preserves_typed_collisions() {
        for directory in [false, true] {
            let root = tempfile::tempdir().expect("root");
            let parent = windows_test_parent(root.path());
            for name in ["source", "second"] {
                let path = root.path().join(name);
                if directory {
                    std::fs::create_dir(&path).expect("directory");
                    std::fs::write(path.join("child"), name).expect("child");
                } else {
                    std::fs::write(path, name).expect("file");
                }
            }
            let identity = entry_identity_at(&parent, OsStr::new("source"), directory)
                .expect("source identity");
            let outcome = rename_workspace_entry_at(
                &parent,
                OsStr::new("source"),
                identity,
                directory,
                &parent,
                OsStr::new("X"),
            )
            .expect("rename to one-character leaf");
            assert!(matches!(outcome, AtomicFileOutcome::DurableCommit));
            assert!(!root.path().join("source").exists());
            assert_eq!(
                entry_identity_at(&parent, OsStr::new("X"), directory).expect("renamed identity"),
                identity
            );
            let second_identity = entry_identity_at(&parent, OsStr::new("second"), directory)
                .expect("second identity");
            let error = rename_workspace_entry_at(
                &parent,
                OsStr::new("second"),
                second_identity,
                directory,
                &parent,
                OsStr::new("X"),
            )
            .expect_err("occupied one-character leaf");
            let payload = serde_json::to_value(error).expect("collision payload");
            assert_eq!(payload["category"], "conflict");
            assert_eq!(payload["nameTaken"], true);
            assert_eq!(
                entry_identity_at(&parent, OsStr::new("second"), directory)
                    .expect("preserved source identity"),
                second_identity
            );
            for (name, contents) in [
                ("X", b"source".as_slice()),
                ("second", b"second".as_slice()),
            ] {
                let path = root.path().join(name);
                let path = if directory { path.join("child") } else { path };
                assert_eq!(std::fs::read(path).expect("preserved contents"), contents);
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_rename_collision_is_conflict_not_io() {
        let root = tempfile::tempdir().expect("root");
        let parent = root.path().join("parent");
        std::fs::create_dir(&parent).expect("parent");
        let target = parent.join("target");
        let injector = Mutation {
            point: AtomicFileFaultPoint::Rename,
            target: target.clone(),
            #[cfg(not(windows))]
            parent: parent.clone(),
            action: "create",
        };
        let result = run_atomic_file_fault(&target, Arc::new(injector), |file| {
            file.write_all(b"new").map_err(io)
        });
        assert!(matches!(result, Err(Error::Conflict(_))));
        assert_eq!(std::fs::read(target).expect("racer"), b"racer");
        assert_no_windows_temporary_files(&parent);
    }

    #[cfg(windows)]
    #[test]
    fn windows_sharing_violation_is_conflict_not_io() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("target");
        std::fs::write(&target, b"old").expect("old");
        let mut options = std::fs::OpenOptions::new();
        options
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
        let _holder = options.open(&target).expect("sharing holder");
        let parent = windows_test_parent(dir.path());
        let result = atomic_replace_at(&parent, OsStr::new("target"), |file| {
            file.write_all(b"new").map_err(io)
        });
        assert!(matches!(result, Err(Error::Conflict(_))));
        assert_eq!(std::fs::read(&target).expect("target"), b"old");
    }

    #[cfg(windows)]
    #[test]
    fn windows_private_temp_refuses_read_and_rename_while_held() {
        use std::io::{Seek, SeekFrom};
        use windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION;

        let dir = tempfile::tempdir().expect("tempdir");
        let parent = windows_test_parent(dir.path());
        let (name, mut file) = win::create_temp(&parent, None).expect("private temporary");
        let path = dir.path().join(&name);
        assert_eq!(
            File::open(&path)
                .expect_err("held temporary refuses readers")
                .raw_os_error(),
            Some(ERROR_SHARING_VIOLATION as i32)
        );
        assert_eq!(
            std::fs::rename(&path, dir.path().join("renamed"))
                .expect_err("held temporary refuses renames")
                .raw_os_error(),
            Some(ERROR_SHARING_VIOLATION as i32)
        );
        file.write_all(b"private bytes").expect("synchronous write");
        file.seek(SeekFrom::Start(0)).expect("rewind");
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).expect("synchronous read");
        assert_eq!(bytes, b"private bytes");
        drop(file);
        std::fs::remove_file(path).expect("remove temporary");
        assert_eq!(std::fs::read_dir(dir.path()).expect("directory").count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn windows_private_temp_refuses_a_non_single_leaf_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        let _names = win::scoped_test_temp_names(vec!["a\\b".into()]);
        let parent = windows_test_parent(dir.path());
        let error = win::create_temp(&parent, None).expect_err("non-leaf temporary name");
        assert!(matches!(error, Error::InvalidInput(_)), "{error:?}");
        assert_eq!(std::fs::read_dir(dir.path()).expect("directory").count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn windows_temp_name_collision_drives_the_retry() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("collision"), b"existing").expect("collision");
        let _names = win::scoped_test_temp_names(vec!["available".into(), "collision".into()]);
        let parent = windows_test_parent(dir.path());
        atomic_replace_at(&parent, OsStr::new("target"), |file| {
            file.write_all(b"new").map_err(io)
        })
        .expect("retry")
        .expect_durable();
        assert_eq!(
            std::fs::read(dir.path().join("target")).expect("target"),
            b"new"
        );
        assert_eq!(
            std::fs::read(dir.path().join("collision")).expect("collision"),
            b"existing"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_readonly_target_is_replaced() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("target");
        std::fs::write(&target, b"old").expect("old");
        let mut permissions = std::fs::metadata(&target).expect("metadata").permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&target, permissions).expect("readonly");
        let parent = windows_test_parent(dir.path());
        atomic_replace_at(&parent, OsStr::new("target"), |file| {
            file.write_all(b"new").map_err(io)
        })
        .expect("replace readonly target")
        .expect_durable();
        assert_eq!(std::fs::read(&target).expect("target"), b"new");
    }

    #[cfg(windows)]
    #[test]
    fn windows_replace_succeeds_on_target_denying_generic_write() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("target");
        std::fs::write(&target, b"old").expect("old");
        win::set_test_target_security_descriptor(&target, win::TARGET_ACCESS)
            .expect("target DACL without generic write");
        let parent = windows_test_parent(dir.path());
        atomic_replace_at(&parent, OsStr::new("target"), |file| {
            file.write_all(b"new").map_err(io)
        })
        .expect("replacement only needs delete/read-control access to target")
        .expect_durable();
        assert_eq!(std::fs::read(&target).expect("target"), b"new");
    }

    #[cfg(windows)]
    #[test]
    fn windows_replace_under_a_read_only_ancestor_succeeds() {
        // Regression guard for the read-only walk: open_directory_path honours `writable` on its
        // base open but once demanded DIRECTORY_ACCESS (which carries GENERIC_WRITE) for every
        // child component, so the pre-commit revalidation — which opens the parent chain with
        // `writable = false` — failed on any path whose ancestor denies write. The source pin in
        // infra/platform_support/tests.rs proves the two-predicate split is still written; this
        // proves the behaviour it exists for. Nothing local executes it: it first runs on a
        // Windows runner.
        let dir = tempfile::tempdir().expect("tempdir");
        let ancestor = dir.path().join("ancestor");
        std::fs::create_dir(&ancestor).expect("ancestor");
        let writable_parent = ancestor.join("parent");
        std::fs::create_dir(&writable_parent).expect("writable parent");
        let target = writable_parent.join("target");
        std::fs::write(&target, b"old").expect("old");
        // Deny GENERIC_WRITE on the ancestor itself; traversal and revalidation need only
        // read access to it, and the replacement happens inside it via a retained descriptor.
        win::set_test_target_security_descriptor(&ancestor, win::TARGET_ACCESS)
            .expect("ancestor DACL without generic write");
        atomic_replace(&target, |file| file.write_all(b"new").map_err(io))
            .expect("a read-only ancestor must not block replacement")
            .expect_durable();
        assert_eq!(std::fs::read(&target).expect("target"), b"new");
    }

    fn owned_staging_fixture(parent: &Path) -> tempfile::TempDir {
        let inner = tempfile::Builder::new()
            .prefix(".zip")
            .tempdir_in(parent)
            .expect("inner staging");
        std::fs::create_dir(inner.path().join("nested")).expect("nested");
        std::fs::write(inner.path().join("nested").join("a.txt"), b"staged").expect("member");
        inner
    }

    fn assert_fixed_conflict(error: Error, expected: &str) {
        match error {
            Error::Conflict(message) => {
                assert_eq!(message, expected);
                assert!(!message.contains('/') && !message.contains('\\'));
            }
            other => panic!("expected Conflict, got {other:?}"),
        }
    }

    fn owned_staging_drop_removals() -> usize {
        OWNED_STAGING_DROP_REMOVALS.with(std::cell::Cell::get)
    }

    #[test]
    fn owned_staging_dir_adopt_and_install_onto_an_absent_leaf() {
        let outer = tempfile::tempdir().expect("outer");
        let inner = owned_staging_fixture(outer.path());
        let before = owned_staging_drop_removals();
        let source = OwnedStagingDir::adopt(&inner).expect("adopt");
        install_owned_staging_dir(source, OsStr::new("extracted")).expect("install");
        assert_eq!(owned_staging_drop_removals(), before);
        assert_eq!(
            std::fs::read(outer.path().join("extracted/nested/a.txt")).expect("installed"),
            b"staged"
        );
        assert!(!inner.path().exists());
    }

    #[test]
    fn owned_staging_dir_replaces_an_existing_real_directory() {
        let outer = tempfile::tempdir().expect("outer");
        let dest = outer.path().join("extracted");
        std::fs::create_dir(&dest).expect("existing dest");
        std::fs::write(dest.join("old.txt"), b"old").expect("old member");
        let inner = owned_staging_fixture(outer.path());
        let source = OwnedStagingDir::adopt(&inner).expect("adopt");
        install_owned_staging_dir(source, OsStr::new("extracted")).expect("install");
        assert_eq!(
            std::fs::read(dest.join("nested/a.txt")).expect("new"),
            b"staged"
        );
        assert!(!dest.join("old.txt").exists());
        let names: Vec<_> = std::fs::read_dir(outer.path())
            .expect("list")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert_eq!(names, vec![OsString::from("extracted")]);
    }

    #[test]
    fn owned_staging_dir_source_identity_substitution_before_commit_is_conflict() {
        let outer = tempfile::tempdir().expect("outer");
        let inner = owned_staging_fixture(outer.path());
        let source = OwnedStagingDir::adopt(&inner).expect("adopt");
        std::fs::remove_dir_all(inner.path()).expect("remove adopted leaf");
        std::fs::create_dir(inner.path()).expect("substitute leaf");
        std::fs::write(inner.path().join("planted.txt"), b"planted").expect("planted");
        let before = owned_staging_drop_removals();
        let error = install_owned_staging_dir(source, OsStr::new("extracted"))
            .expect_err("substituted source must be refused");
        assert_fixed_conflict(error, "directory staging source changed concurrently");
        // A pre-commit refusal leaves Drop armed; its identity check spares the substitute.
        assert_eq!(owned_staging_drop_removals(), before + 1);
        assert!(!outer.path().join("extracted").exists());
        assert!(inner.path().join("planted.txt").exists());
    }

    #[test]
    fn owned_staging_dir_drop_removes_unconsumed_leaf() {
        let outer = tempfile::tempdir().expect("outer");
        let inner = owned_staging_fixture(outer.path());
        let before = owned_staging_drop_removals();
        drop(OwnedStagingDir::adopt(&inner).expect("adopt"));
        assert_eq!(owned_staging_drop_removals(), before + 1);
        assert!(!inner.path().exists());
    }

    #[test]
    fn owned_staging_dir_drop_is_inert_after_commit_including_uncertain_durability() {
        for existing in [false, true] {
            let outer = tempfile::tempdir().expect("outer");
            let dest = outer.path().join("extracted");
            if existing {
                std::fs::create_dir(&dest).expect("existing dest");
            }
            let inner = owned_staging_fixture(outer.path());
            let source = OwnedStagingDir::adopt(&inner).expect("adopt");
            let before = owned_staging_drop_removals();
            set_test_atomic_dir_injector(Some(Box::new(DirFault {
                point: AtomicDirFaultPoint::ParentSync,
            })));
            let result = install_owned_staging_dir(source, OsStr::new("extracted"));
            set_test_atomic_dir_injector(None);
            assert!(matches!(
                result,
                Err(Error::CommittedDurabilityUncertain(
                    crate::error::DurabilityStage::DirectoryInstall
                ))
            ));
            assert_eq!(owned_staging_drop_removals(), before, "existing={existing}");
            assert_eq!(
                std::fs::read(dest.join("nested/a.txt")).expect("committed tree"),
                b"staged",
                "existing={existing}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn owned_staging_dir_parent_path_swap_cannot_redirect_install() {
        let root = tempfile::tempdir().expect("root");
        let parent = root.path().join("parent");
        let moved = root.path().join("moved");
        std::fs::create_dir(&parent).expect("parent");
        let inner = owned_staging_fixture(&parent);
        let source = OwnedStagingDir::adopt(&inner).expect("adopt");
        std::fs::rename(&parent, &moved).expect("move parent");
        std::fs::create_dir(&parent).expect("swap in a new parent");
        install_owned_staging_dir(source, OsStr::new("extracted")).expect("install");
        assert_eq!(
            std::fs::read(moved.join("extracted/nested/a.txt")).expect("held parent"),
            b"staged"
        );
        assert_eq!(std::fs::read_dir(&parent).expect("swapped").count(), 0);
    }

    /// The unix swap cannot be staged on Windows: while the staging handles are held the OS
    /// refuses to rename their parent (measured on `windows-latest`, run 35424078540: os error 5),
    /// so the held parent is still the named one when the install lands.
    #[cfg(windows)]
    #[test]
    fn owned_staging_dir_held_parent_cannot_be_renamed_away_before_install() {
        let root = tempfile::tempdir().expect("root");
        let parent = root.path().join("parent");
        std::fs::create_dir(&parent).expect("parent");
        let inner = owned_staging_fixture(&parent);
        let source = OwnedStagingDir::adopt(&inner).expect("adopt");
        let refused = std::fs::rename(&parent, root.path().join("moved"))
            .expect_err("a held staging parent cannot be renamed");
        assert_eq!(refused.kind(), std::io::ErrorKind::PermissionDenied);
        install_owned_staging_dir(source, OsStr::new("extracted")).expect("install");
        assert_eq!(
            std::fs::read(parent.join("extracted").join("nested").join("a.txt")).expect("install"),
            b"staged"
        );
    }

    #[cfg(windows)]
    #[test]
    fn owned_staging_dir_verified_parent_refuses_when_child_identity_does_not_match() {
        let outer = tempfile::tempdir().expect("outer");
        let path = outer.path().join("child");
        std::fs::create_dir(&path).expect("child");
        let child = win::open_directory_path(&path, false).expect("open child");
        let identity = opened_identity(&child).expect("identity");
        let (reopened, leaf) =
            win::open_verified_parent(&path, identity, true, ParentAccess::Writable)
                .expect("genuine parent");
        assert_eq!(leaf, OsStr::new("child"));
        assert_eq!(
            entry_identity_at(&reopened, &leaf, true).expect("leaf under the held parent"),
            identity
        );
        for substituted in [
            (identity.0, identity.1.wrapping_add(1)),
            (identity.0.wrapping_add(1), identity.1),
        ] {
            assert_fixed_conflict(
                win::open_verified_parent(&path, substituted, true, ParentAccess::Writable)
                    .expect_err("mismatched child identity must be refused"),
                "workspace entry changed concurrently",
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn owned_staging_dir_open_parent_refuses_when_child_identity_does_not_match() {
        let outer = tempfile::tempdir().expect("outer");
        std::fs::create_dir(outer.path().join("child")).expect("child");
        let parent = test_parent(outer.path());
        let child = open_directory_at(&parent, OsStr::new("child"), false).expect("open child");
        let identity = opened_identity(&child).expect("identity");
        let reopened = open_parent_directory(&child).expect("genuine parent");
        assert_eq!(
            opened_identity(&reopened).expect("parent identity"),
            opened_identity(&parent).expect("held identity")
        );
        for substituted in [
            (identity.0, identity.1.wrapping_add(1)),
            (identity.0.wrapping_add(1), identity.1),
        ] {
            set_open_parent_child_identity_hook(Some(substituted));
            let result = open_parent_directory(&child);
            set_open_parent_child_identity_hook(None);
            assert_fixed_conflict(
                result.expect_err("mismatched child identity must be refused"),
                "directory is not a child of its opened parent",
            );
        }
    }

    #[cfg(unix)]
    struct SourceSubstitution {
        result: Result<(), Error>,
        swaps: usize,
        parent_sync: bool,
        backup_cleanup: bool,
        displaced_preserved: bool,
        preserved: bool,
    }

    #[cfg(unix)]
    fn observe_source_substitution(replace: bool, fail_parent_sync: bool) -> SourceSubstitution {
        use std::os::unix::fs::MetadataExt;

        #[derive(Debug, Default)]
        struct Observation {
            swaps: usize,
            substitute: Option<(u64, u64)>,
            post_commit_parent_sync: bool,
            backup_cleanup: bool,
        }
        struct Substitute {
            source: PathBuf,
            moved: PathBuf,
            observation: Arc<Mutex<Observation>>,
            fail_parent_sync: bool,
        }
        impl AtomicDirInjector for Substitute {
            fn inject(&self, point: AtomicDirFaultPoint) -> std::io::Result<()> {
                if point == AtomicDirFaultPoint::InstallRename {
                    std::fs::rename(&self.source, &self.moved)?;
                    std::fs::create_dir(&self.source)?;
                    std::fs::write(self.source.join("engine"), b"UNVERIFIED-SUBSTITUTE")?;
                    let metadata = std::fs::metadata(&self.source)?;
                    let mut observation = self.observation.lock().unwrap();
                    observation.swaps += 1;
                    observation.substitute = Some((metadata.dev(), metadata.ino()));
                }
                if point == AtomicDirFaultPoint::ParentSync {
                    self.observation.lock().unwrap().post_commit_parent_sync = true;
                    if self.fail_parent_sync {
                        return Err(std::io::Error::other(
                            "parent sync must not precede confirmation",
                        ));
                    }
                }
                if point == AtomicDirFaultPoint::BackupCleanup {
                    self.observation.lock().unwrap().backup_cleanup = true;
                }
                Ok(())
            }
        }

        let root = tempfile::tempdir().unwrap();
        let temp = tempfile::Builder::new()
            .prefix(".source-probe-")
            .tempdir_in(root.path())
            .unwrap();
        std::fs::write(temp.path().join("engine"), b"VERIFIED-ORIGINAL").unwrap();
        let mut owner = OwnedStagingDir::adopt(&temp).unwrap();
        let source = temp.keep();
        let parent = owner.binding().0.try_clone().unwrap();
        let accepted_identity = owner.binding().2;
        let original_pin = owner.directory().unwrap().try_clone().unwrap();
        let moved = root.path().join("moved-original");
        let target = root.path().join("installed");
        if replace {
            std::fs::create_dir(&target).unwrap();
            std::fs::write(target.join("engine"), b"DISPLACED-ORIGINAL").unwrap();
        }
        let displaced_identity = std::fs::metadata(&target)
            .ok()
            .map(|metadata| (metadata.dev(), metadata.ino()));
        let observation = Arc::new(Mutex::new(Observation::default()));
        let removals_before = OWNED_STAGING_DROP_REMOVALS.with(|count| count.get());
        set_test_atomic_dir_injector(Some(Box::new(Substitute {
            source: source.clone(),
            moved: moved.clone(),
            observation: observation.clone(),
            fail_parent_sync,
        })));
        let result = install_staging_dir_at(
            &mut owner,
            &parent,
            OsStr::new("installed"),
            if replace {
                DirectoryInstallPolicy::Replace
            } else {
                DirectoryInstallPolicy::Absent
            },
        );
        set_test_atomic_dir_injector(None);

        // These fields belong to the real facade. It disarms only when its local committed
        // flag is true, so the observed disarm proves that flag without a production hook.
        let owner_armed = owner.armed;
        let owner_child_present = owner.child.is_some();
        let committed_from_facade_disarm = !owner_armed;
        let parent_identity = opened_identity(&parent).unwrap();
        let pin_identity = opened_identity(&original_pin).unwrap();
        let mut pin_bytes = Vec::new();
        open_regular_at(
            &original_pin,
            OsStr::new("engine"),
            RegularFileAccess::ReadOnly,
        )
        .unwrap()
        .read_to_end(&mut pin_bytes)
        .unwrap();
        let directory_identity = |path: &Path| {
            std::fs::symlink_metadata(path)
                .ok()
                .map(|metadata| (metadata.dev(), metadata.ino()))
        };
        let source_identity = directory_identity(&source);
        let target_identity = directory_identity(&target);
        let moved_identity = directory_identity(&moved);
        let source_bytes = std::fs::read(source.join("engine")).ok();
        let target_bytes = std::fs::read(target.join("engine")).ok();
        let moved_bytes = std::fs::read(moved.join("engine")).ok();
        drop(owner);
        let removals_after = OWNED_STAGING_DROP_REMOVALS.with(|count| count.get());
        let target_after_drop = directory_identity(&target);
        let moved_after_drop = directory_identity(&moved);
        let source_after_drop = directory_identity(&source);
        let observed = observation.lock().unwrap();
        eprintln!("NATIVE_SOURCE_COMMIT_PROBE source={source:?} target={target:?} moved={moved:?}");
        eprintln!("NATIVE_SOURCE_COMMIT_PROBE result={result:?} parent={parent_identity:?} accepted={accepted_identity:?} pin={pin_identity:?} pin_bytes={pin_bytes:?}");
        eprintln!("NATIVE_SOURCE_COMMIT_PROBE observation={observed:?} source={source_identity:?} target={target_identity:?} moved={moved_identity:?}");
        eprintln!("NATIVE_SOURCE_COMMIT_PROBE source_bytes={source_bytes:?} target_bytes={target_bytes:?} moved_bytes={moved_bytes:?}");
        eprintln!("NATIVE_SOURCE_COMMIT_PROBE committed_from_facade_disarm={committed_from_facade_disarm} owner_armed={owner_armed} owner_child_present={owner_child_present} drop_removal_delta={} after_drop_source={source_after_drop:?} after_drop_target={target_after_drop:?} after_drop_moved={moved_after_drop:?}", removals_after - removals_before);
        let swaps = observed.swaps;
        let substitute_identity = observed.substitute;
        let parent_sync = observed.post_commit_parent_sync;
        let backup_cleanup = observed.backup_cleanup;
        drop(observed);
        let displaced_preserved = source_after_drop == displaced_identity
            && source_bytes.as_deref() == Some(b"DISPLACED-ORIGINAL".as_slice());
        let refused_without_trusted_publication = matches!(&result, Err(Error::Conflict(_)))
            && target_identity == substitute_identity
            && target_bytes.as_deref() == Some(b"UNVERIFIED-SUBSTITUTE".as_slice())
            && moved_after_drop == Some(accepted_identity)
            && moved_bytes.as_deref() == Some(b"VERIFIED-ORIGINAL".as_slice())
            && if replace {
                displaced_preserved
            } else {
                source_after_drop.is_none()
            }
            && committed_from_facade_disarm
            && removals_after == removals_before;
        drop(original_pin);
        drop(parent);
        root.close().unwrap();
        eprintln!("NATIVE_SOURCE_COMMIT_PROBE all native handles closed and disposable root removed before assertion");
        SourceSubstitution {
            result,
            swaps,
            parent_sync,
            backup_cleanup,
            displaced_preserved,
            preserved: refused_without_trusted_publication,
        }
    }

    #[cfg(unix)]
    #[test]
    fn catalog_install_publication_confirmation_completed_source_substitution() {
        let observed = observe_source_substitution(false, false);
        assert!(!observed.parent_sync,
            "SOURCE_MISMATCH_BEFORE_PARENT_SYNC: native mismatch must be refused before parent sync: {:?}", observed.result);
        assert_eq!(
            observed.swaps, 1,
            "the probe must complete exactly one substitution"
        );
        assert!(
            observed.preserved,
            "NATIVE_SOURCE_COMMIT_UNVERIFIED_PUBLICATION: {:?}",
            observed.result
        );
    }

    #[cfg(unix)]
    #[test]
    fn catalog_install_r12_source_mismatch_precedes_sync_failure() {
        let observed = observe_source_substitution(false, true);
        assert!(matches!(observed.result, Err(Error::Conflict(_))),
            "SOURCE_MISMATCH_SYNC_FAILURE_IS_HARD: native mismatch must precede applied sync uncertainty: {:?}", observed.result);
        assert!(!observed.parent_sync);
        assert!(!observed.backup_cleanup);
        assert_eq!(observed.swaps, 1);
        assert!(observed.preserved);
    }

    #[cfg(unix)]
    #[test]
    fn catalog_install_r12_source_mismatch_preserves_displaced_tree() {
        let observed = observe_source_substitution(true, false);
        assert!(observed.displaced_preserved && !observed.backup_cleanup,
            "SOURCE_MISMATCH_PRESERVES_DISPLACED: displaced tree must survive unconfirmed publication: {:?}", observed.result);
        assert!(!observed.parent_sync);
        assert_eq!(observed.swaps, 1);
        assert!(observed.preserved);
    }

    #[cfg(windows)]
    #[test]
    fn catalog_install_publication_confirmation_windows_renames_accepted_entry() {
        struct Swap {
            source: PathBuf,
            moved: PathBuf,
            refusal: Arc<Mutex<Option<i32>>>,
        }
        impl AtomicDirInjector for Swap {
            fn inject(&self, point: AtomicDirFaultPoint) -> std::io::Result<()> {
                if point == AtomicDirFaultPoint::CommitEntry {
                    match std::fs::rename(&self.source, &self.moved) {
                        Ok(()) => {
                            std::fs::create_dir(&self.source)?;
                            std::fs::write(self.source.join("foreign"), b"preserve substitute")?;
                        }
                        Err(error) if matches!(error.raw_os_error(), Some(5 | 32)) => {
                            *self.refusal.lock().unwrap() = error.raw_os_error();
                        }
                        Err(error) => return Err(error),
                    }
                }
                Ok(())
            }
        }
        let root = tempfile::tempdir().unwrap();
        let temp = tempfile::tempdir_in(root.path()).unwrap();
        std::fs::write(temp.path().join("engine"), b"accepted original").unwrap();
        let mut source = OwnedStagingDir::adopt(&temp).unwrap();
        let source_path = temp.keep();
        let parent = source.binding().0.try_clone().unwrap();
        let expected = source.binding().2;
        let moved = root.path().join("moved-original");
        let refusal = Arc::new(Mutex::new(None));
        set_test_atomic_dir_injector(Some(Box::new(Swap {
            source: source_path.clone(),
            moved: moved.clone(),
            refusal: refusal.clone(),
        })));
        let result = install_staging_dir_at(
            &mut source,
            &parent,
            OsStr::new("installed"),
            DirectoryInstallPolicy::Absent,
        );
        set_test_atomic_dir_injector(None);
        let disarmed = !source.armed;
        drop(source);
        let installed = entry_identity_at(&parent, OsStr::new("installed"), true);
        let bytes = std::fs::read(root.path().join("installed/engine"));
        let substitute = std::fs::read(source_path.join("foreign")).ok();
        let original_moved = moved.exists();
        let refusal = *refusal.lock().unwrap();
        drop(parent);
        root.close().unwrap();
        assert!(result.is_ok(), "WINDOWS_ACCEPTED_SOURCE_ENTRY: {result:?}");
        assert!(disarmed);
        assert_eq!(installed.unwrap(), expected);
        assert_eq!(bytes.unwrap(), b"accepted original");
        assert!(
            !original_moved,
            "the exact accepted handle must reach the destination"
        );
        if refusal.is_some() {
            assert!(matches!(refusal, Some(5 | 32)));
            assert!(substitute.is_none());
        } else {
            assert_eq!(
                substitute.as_deref(),
                Some(b"preserve substitute".as_slice())
            );
        }
    }

    #[test]
    fn joiner_absent_install_disarms_owned_cleanup_after_durability_uncertainty() {
        let root = tempfile::tempdir().unwrap();
        let temp = tempfile::tempdir_in(root.path()).unwrap();
        std::fs::write(temp.path().join("engine"), b"committed").unwrap();
        let mut source = OwnedStagingDir::adopt(&temp).unwrap();
        let _ = temp.keep();
        let parent = source.binding().0.try_clone().unwrap();
        let before = OWNED_STAGING_DROP_REMOVALS.with(|count| count.get());
        set_test_atomic_dir_injector(Some(Box::new(DirFault {
            point: AtomicDirFaultPoint::ParentSync,
        })));
        let result = install_staging_dir_at(
            &mut source,
            &parent,
            OsStr::new("installed"),
            DirectoryInstallPolicy::Absent,
        );
        set_test_atomic_dir_injector(None);
        assert!(matches!(
            result,
            Err(Error::CommittedDurabilityUncertain(_))
        ));
        drop(source);
        assert_eq!(
            OWNED_STAGING_DROP_REMOVALS.with(|count| count.get()),
            before
        );
        assert_eq!(
            std::fs::read(root.path().join("installed/engine")).unwrap(),
            b"committed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn owned_staging_dir_relative_walk_refuses_a_planted_symlink_component() {
        let outer = tempfile::tempdir().expect("outer");
        let outside = outer.path().join("outside");
        std::fs::create_dir(&outside).expect("outside");
        let inner = owned_staging_fixture(outer.path());
        let staging = OwnedStagingDir::adopt(&inner).expect("adopt");
        let planted = inner.path().join("members");
        for create_file in [false, true] {
            let (target, link) = (outside.clone(), planted.clone());
            set_ensure_directory_pre_create_hook(Some(Box::new(move || {
                std::os::unix::fs::symlink(&target, &link).unwrap();
            })));
            let result = if create_file {
                staging
                    .create_relative_regular(Path::new("members/a.txt"))
                    .map(drop)
            } else {
                staging.ensure_relative_directory(Path::new("members/sub"))
            };
            set_ensure_directory_pre_create_hook(None);
            assert!(matches!(result, Err(Error::Io(_))), "{result:?}");
            assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
            std::fs::remove_file(&planted).expect("remove planted link");
        }
    }

    #[test]
    fn owned_staging_dir_relative_walk_refuses_non_plain_components() {
        let outer = tempfile::tempdir().expect("outer");
        let inner = owned_staging_fixture(outer.path());
        let staging = OwnedStagingDir::adopt(&inner).expect("adopt");
        let absolute = outer.path().join("escaped");
        let mut refused = vec![
            Path::new(".."),
            Path::new("nested/../escaped"),
            Path::new("./nested"),
            Path::new("nested/./a"),
            Path::new("nested//a"),
            Path::new("nested/"),
            absolute.as_path(),
        ];
        if cfg!(windows) {
            refused.push(Path::new("C:escaped"));
        }
        for relative in refused {
            for result in [
                staging.ensure_relative_directory(relative),
                staging.create_relative_regular(relative).map(drop),
            ] {
                match result {
                    Err(Error::InvalidInput(message)) => {
                        assert!(
                            !message.contains('/') && !message.contains("escaped"),
                            "{message}"
                        )
                    }
                    other => panic!("{relative:?} must be InvalidInput, got {other:?}"),
                }
            }
        }
        assert!(!outer.path().join("escaped").exists());
        staging
            .ensure_relative_directory(Path::new(""))
            .expect("empty relative is the staging root");
        assert!(matches!(
            staging.create_relative_regular(Path::new("")),
            Err(Error::InvalidInput(_))
        ));
    }

    #[test]
    fn owned_staging_dir_create_relative_regular_is_exclusive() {
        let outer = tempfile::tempdir().expect("outer");
        let inner = owned_staging_fixture(outer.path());
        let staging = OwnedStagingDir::adopt(&inner).expect("adopt");
        let mut created = staging
            .create_relative_regular(Path::new("deep/er/b.txt"))
            .expect("create");
        created.write_all(b"member").expect("write");
        drop(created);
        assert!(staging
            .create_relative_regular(Path::new("deep/er/b.txt"))
            .is_err());
        staging
            .ensure_relative_directory(Path::new("deep/er"))
            .expect("existing directories are reopened");
        assert_eq!(
            std::fs::read(inner.path().join("deep/er/b.txt")).expect("member"),
            b"member"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(inner.path().join("deep/er/b.txt"))
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn owned_staging_dir_drop_removes_unconsumed_leaf_after_keep() {
        let outer = tempfile::tempdir().expect("outer");
        let inner = owned_staging_fixture(outer.path());
        let staging = OwnedStagingDir::adopt(&inner).expect("adopt");
        let leaf = inner.keep();
        staging
            .create_relative_regular(Path::new("nested/b.txt"))
            .expect("create");
        let before = owned_staging_drop_removals();
        drop(staging);
        assert_eq!(owned_staging_drop_removals(), before + 1);
        assert!(!leaf.exists());
    }
}
