//! Folder-switch orchestration for Databases, Engines, and Puzzles:
//! choose/restore classification, DialogGrant-backed single-use grants with replay,
//! preflight checks, quiesce coordination, same-volume rename / cross-volume verified copy,
//! `.ecsi`/`.integrity` rebinding, identity-preserving registry rebase, write-ahead journal,
//! explicit rollback, and startup recovery.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::error::{Error, FolderSwitchFailure, RootFailure};
use crate::infra::fs::{
    atomic_replace, create_dir_at, create_regular_at, entry_identity_at, open_directory_at,
    open_regular_at, open_verified_directory, read_directory_entries_at, remove_empty_directory_at,
    remove_entry_at, rename_entry_at, require_durable, DirectoryEntryKind, RegularFileAccess,
    VerifiedDir,
};

pub(super) const JOURNAL_VERSION: u32 = 1;
const COPY_BUFFER_BYTES: usize = 64 * 1024;
const MAX_ANCESTOR_WALK_DEPTH: usize = 256;
const MAX_COPY_TREE_DEPTH: usize = 64;

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Deserialize, Serialize, Type,
)]
#[serde(rename_all = "camelCase")]
pub enum FolderSwitchKind {
    Database,
    Engine,
    Puzzle,
}

impl FolderSwitchKind {
    pub(crate) const ALL: [Self; 3] = [Self::Database, Self::Engine, Self::Puzzle];

    pub(crate) fn visible_default_kind(self) -> VisibleDefaultKind {
        match self {
            Self::Database => VisibleDefaultKind::Databases,
            Self::Engine => VisibleDefaultKind::Engines,
            Self::Puzzle => VisibleDefaultKind::Puzzles,
        }
    }

    pub(crate) fn legacy_default_root(self) -> AppOwnedDefaultRoot {
        match self {
            Self::Database => AppOwnedDefaultRoot::Databases,
            Self::Engine => AppOwnedDefaultRoot::Engines,
            Self::Puzzle => AppOwnedDefaultRoot::Puzzles,
        }
    }

    pub(crate) fn root_operation(self) -> PathOperation {
        match self {
            Self::Database => PathOperation::DatabaseRead,
            Self::Engine => PathOperation::EngineInstall,
            Self::Puzzle => PathOperation::PuzzleRead,
        }
    }

    fn journal_filename(self) -> &'static str {
        match self {
            Self::Database => "folder-switch-database.json",
            Self::Engine => "folder-switch-engine.json",
            Self::Puzzle => "folder-switch-puzzle.json",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderSwitchGrant {
    pub id: PathRef,
    pub kind: FolderSwitchKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FolderSwitchMode {
    Move,
    UseOnly,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WorkspaceChoice<D> {
    Activated {
        descriptor: D,
    },
    Pending {
        grant: FolderSwitchGrant,
        #[serde(rename = "displayName")]
        display_name: String,
        #[serde(rename = "itemCount")]
        item_count: u32,
    },
}

/// RAII guard for a root-scoped engine quiesce barrier in `PathAuthority`.
/// Lifts the barrier on explicit `lift()` or on `Drop` (never panics).
pub(crate) struct EngineRootQuiesceGuard {
    quiesced: Arc<std::sync::Mutex<HashSet<(u64, u64)>>>,
    root_identity: (u64, u64),
    lifted: bool,
}

impl EngineRootQuiesceGuard {
    pub(crate) fn lift(mut self) {
        self.lift_inner();
    }

    fn lift_inner(&mut self) {
        if self.lifted {
            return;
        }
        self.lifted = true;
        self.quiesced
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.root_identity);
    }
}

impl Drop for EngineRootQuiesceGuard {
    fn drop(&mut self) {
        self.lift_inner();
    }
}

/// Stored inside the existing `DialogGrant` registry (no second registry).
#[derive(Clone)]
pub(super) struct FolderSwitchGrantMetadata {
    pub(super) kind: FolderSwitchKind,
    pub(super) source_root: PathRef,
    pub(super) source_identity: Identity,
    pub(super) target_expected_identity: Option<Identity>,
    pub(super) committed_status: Option<FolderStatus>,
}

/// Enforces one writer per `FolderSwitchKind` across choose, restore, apply, recovery and
/// migration. Non-blocking acquisition refuses concurrent callers with `SwitchInProgress`.
#[derive(Clone, Default)]
pub struct FolderSwitchCoordinator {
    in_flight: Arc<Mutex<BTreeSet<FolderSwitchKind>>>,
}

pub struct KindWriterGuard {
    in_flight: Arc<Mutex<BTreeSet<FolderSwitchKind>>>,
    kind: FolderSwitchKind,
}

impl Drop for KindWriterGuard {
    fn drop(&mut self) {
        let mut guard = self
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.remove(&self.kind);
    }
}

impl FolderSwitchCoordinator {
    pub fn try_acquire(&self, kind: FolderSwitchKind) -> Result<KindWriterGuard, Error> {
        let mut guard = self
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !guard.insert(kind) {
            return Err(Error::FolderSwitch(FolderSwitchFailure::SwitchInProgress));
        }
        Ok(KindWriterGuard {
            in_flight: Arc::clone(&self.in_flight),
            kind,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TransferMode {
    Rename,
    Copy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum JournalStage {
    Prepared,
    Transferring,
    Committed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JournalItem {
    pub(crate) leaf: NativePath,
    pub(crate) is_dir: bool,
    pub(crate) is_primary_db: bool,
    pub(crate) source_identity: Identity,
    pub(crate) target_identity: Option<Identity>,
    pub(crate) transferred: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderSwitchJournal {
    pub(crate) version: u32,
    pub(crate) kind: FolderSwitchKind,
    pub(crate) grant_id: String,
    pub(crate) mode: TransferMode,
    pub(crate) source_root_id: PathRef,
    pub(crate) source_root_path: NativePath,
    pub(crate) source_root_identity: Identity,
    pub(crate) target_root_path: NativePath,
    pub(crate) target_root_identity: Identity,
    pub(crate) target_display_name: String,
    pub(crate) stage: JournalStage,
    pub(crate) items: Vec<JournalItem>,
}

/// Best-effort drop backstop that logs if a move exited without running explicit commit/rollback.
/// Never panics, even during unwinding.
pub(super) struct MoveBackstopGuard {
    kind: FolderSwitchKind,
    disarmed: bool,
}

impl MoveBackstopGuard {
    pub(super) fn new(kind: FolderSwitchKind) -> Self {
        Self {
            kind,
            disarmed: false,
        }
    }

    fn disarm(&mut self) {
        self.disarmed = true;
    }
}

impl Drop for MoveBackstopGuard {
    fn drop(&mut self) {
        if !self.disarmed {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                #[cfg(test)]
                if take_test_fault(FolderSwitchTestFault::PanicInBackstop) {
                    panic!("injected panic in backstop drop");
                }
                log::warn!(
                    "folder switch backstop dropped before explicit finish for {:?}; journal recovery will settle on next start",
                    self.kind
                );
            }));
            if result.is_err() {
                // Never panic or double-panic inside Drop.
            }
        }
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FolderSwitchTestFault {
    ForceCopyMode,
    FailJournalWrite,
    FailTransferAfterFirst,
    FailCopyMidFile,
    FailCopyMidTree,
    FailCommit,
    FailRollback,
    FailCleanup,
    SimulateExdevOnFirstRename,
    PanicInBackstop,
    CorruptCopiedEngineFileBeforeCommit,
}

#[cfg(test)]
std::thread_local! {
    static FOLDER_SWITCH_FAULTS: std::cell::RefCell<Vec<FolderSwitchTestFault>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(test)]
pub(crate) struct FolderSwitchFaultReset;

#[cfg(test)]
impl Drop for FolderSwitchFaultReset {
    fn drop(&mut self) {
        FOLDER_SWITCH_FAULTS.with(|slot| slot.borrow_mut().clear());
    }
}

#[cfg(test)]
pub(crate) fn install_folder_switch_fault(fault: FolderSwitchTestFault) -> FolderSwitchFaultReset {
    install_folder_switch_faults(&[fault])
}

#[cfg(test)]
pub(crate) fn install_folder_switch_faults(
    faults: &[FolderSwitchTestFault],
) -> FolderSwitchFaultReset {
    FOLDER_SWITCH_FAULTS.with(|slot| {
        let mut list = slot.borrow_mut();
        list.clear();
        list.extend_from_slice(faults);
    });
    FolderSwitchFaultReset
}

#[cfg(test)]
pub(crate) fn is_test_fault_pending(expected: FolderSwitchTestFault) -> bool {
    FOLDER_SWITCH_FAULTS.with(|slot| slot.borrow().contains(&expected))
}

#[cfg(test)]
fn take_test_fault(expected: FolderSwitchTestFault) -> bool {
    FOLDER_SWITCH_FAULTS.with(|slot| {
        let mut list = slot.borrow_mut();
        if let Some(pos) = list.iter().position(|f| *f == expected) {
            list.remove(pos);
            true
        } else {
            false
        }
    })
}

/// Decides same-volume vs cross-volume from opened-handle device / volume serial identity.
pub(crate) fn same_volume_identities(source: (u64, u64), target: (u64, u64)) -> bool {
    source.0 == target.0
}

fn is_cross_device_error(error: &Error) -> bool {
    let Error::Io(io_err) = error.unlabelled() else {
        return false;
    };
    match io_err.raw_os_error() {
        Some(code) => {
            #[cfg(unix)]
            {
                code == libc::EXDEV
            }
            #[cfg(windows)]
            {
                use windows_sys::Win32::Foundation::ERROR_NOT_SAME_DEVICE;
                code == ERROR_NOT_SAME_DEVICE as i32
            }
        }
        None => false,
    }
}

/// Folds a single leaf filename according to the active target filesystem's collision rules:
/// Windows `RtlUpcaseUnicodeChar` per UTF-16 unit (as in `bound_sqlite.rs`),
/// macOS case-insensitive APFS default (NFC + lowercase), Linux byte-exact.
pub(crate) fn fold_leaf_name_for_collision(leaf: &OsStr) -> Vec<u8> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Wdk::System::SystemServices::RtlUpcaseUnicodeChar;
        let mut out = Vec::new();
        for unit in leaf.encode_wide() {
            let folded = unsafe { RtlUpcaseUnicodeChar(unit) };
            out.extend_from_slice(&folded.to_le_bytes());
        }
        out
    }
    #[cfg(target_os = "macos")]
    {
        match leaf.to_str() {
            Some(text) => text.nfc().collect::<String>().to_lowercase().into_bytes(),
            None => {
                use std::os::unix::ffi::OsStrExt;
                leaf.as_bytes().to_vec()
            }
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::os::unix::ffi::OsStrExt;
        leaf.as_bytes().to_vec()
    }
}

/// Computes `entry_path` relative to `root_identity` by live directory identity rather than
/// textual path spelling, so case- or normalization-variant root spellings still match.
fn relative_from_ancestor_identity(
    entry_path: &Path,
    entry_parent_identity: Option<&Identity>,
    root_identity: (u64, u64),
) -> Option<PathBuf> {
    if entry_parent_identity.is_some_and(|id| (id.a, id.b) == root_identity) {
        return entry_path.file_name().map(PathBuf::from);
    }
    let mut reversed_components: Vec<OsString> = Vec::new();
    let mut current: &Path = entry_path;
    let mut depth = 0usize;
    while depth < MAX_ANCESTOR_WALK_DEPTH {
        depth += 1;
        let leaf = current.file_name()?;
        reversed_components.push(leaf.to_os_string());
        let parent = current.parent()?;
        if let Ok(parent_file) = open_directory_nofollow_readonly(parent) {
            if let Ok(id) = opened_file_identity(&parent_file) {
                if id == root_identity {
                    let mut rel = PathBuf::new();
                    for comp in reversed_components.into_iter().rev() {
                        rel.push(comp);
                    }
                    return Some(rel);
                }
            }
        }
        if parent == current {
            break;
        }
        current = parent;
    }
    None
}

fn ancestor_identities(path: &Path) -> Result<Vec<(u64, u64)>, Error> {
    let mut ancestors = Vec::new();
    let mut current = path.parent();
    let mut depth = 0usize;
    while let Some(dir) = current {
        if depth >= MAX_ANCESTOR_WALK_DEPTH {
            break;
        }
        depth += 1;
        let file = open_directory_nofollow_readonly(dir)?;
        let id = opened_file_identity(&file)?;
        if ancestors.last() == Some(&id) {
            break;
        }
        ancestors.push(id);
        current = dir.parent();
    }
    Ok(ancestors)
}

#[cfg(unix)]
pub(crate) fn open_directory_nofollow_readonly(path: &Path) -> Result<fs::File, Error> {
    use rustix::fs::{self as rfs, Mode, OFlags};
    let fd = rfs::open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| Error::Io(Box::new(error.into())))?;
    Ok(fs::File::from(fd))
}

#[cfg(windows)]
pub(crate) fn open_directory_nofollow_readonly(path: &Path) -> Result<fs::File, Error> {
    open_windows_nofollow(path, false)
}

/// Opens a directory for identity probing (following symlinks/junctions in `path` so alias
/// spellings resolve to the underlying directory identity, while setting
/// `FILE_FLAG_BACKUP_SEMANTICS` on Windows and `O_DIRECTORY` on Unix).
#[cfg(unix)]
pub(crate) fn open_directory_for_identity_probe(path: &Path) -> Result<fs::File, Error> {
    use rustix::fs::{self as rfs, Mode, OFlags};
    let fd = rfs::open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| Error::Io(Box::new(error.into())))?;
    Ok(fs::File::from(fd))
}

#[cfg(windows)]
pub(crate) fn open_directory_for_identity_probe(path: &Path) -> Result<fs::File, Error> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let mut options = fs::OpenOptions::new();
    options
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    let file = options.open(path)?;
    if !file.metadata()?.is_dir() {
        return Err(Error::InvalidInput("expected a directory".into()));
    }
    Ok(file)
}

#[cfg(unix)]
fn open_directory_nofollow_writable(path: &Path) -> Result<fs::File, Error> {
    open_directory_nofollow_readonly(path)
}

#[cfg(windows)]
fn open_directory_nofollow_writable(path: &Path) -> Result<fs::File, Error> {
    // `remove_empty_directory_at` calls `sync_all` (`FlushFileBuffers`) on the parent handle,
    // which requires `GENERIC_WRITE` on Windows.
    open_windows_nofollow(path, true)
}

fn probe_target_writable(target_dir: &fs::File) -> Result<(), Error> {
    let probe_name = format!(".chessriddle-probe-{}", Uuid::new_v4());
    let leaf = OsStr::new(&probe_name);
    let (file, identity) = create_regular_at(target_dir, leaf)
        .map_err(|_| Error::FolderSwitch(FolderSwitchFailure::TargetUnwritable))?;
    drop(file);
    if let Err(error) = remove_entry_at(target_dir, leaf, identity, false) {
        log::warn!(
            "folder switch write probe cleanup failed: {}",
            error.diagnostic()
        );
    }
    Ok(())
}

fn is_db3_leaf(leaf: &OsStr) -> bool {
    Path::new(leaf)
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|ext| ext.eq_ignore_ascii_case("db3"))
}

fn db3_sidecar_candidates(db_leaf: &OsStr) -> Vec<OsString> {
    let mut candidates = Vec::with_capacity(6);
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut name = db_leaf.to_os_string();
        name.push(suffix);
        candidates.push(name);
    }
    let preferred = crate::db::preferred_sidecar_leaf(db_leaf);
    let legacy = crate::db::legacy_sidecar_leaf(db_leaf);
    let integrity = crate::db::integrity_stamp_leaf(db_leaf);
    candidates.push(preferred.clone());
    candidates.push(integrity);
    if legacy != preferred {
        candidates.push(legacy);
    }
    candidates
}

fn verify_tree_has_no_links(dir: &fs::File, depth: usize) -> Result<(), Error> {
    if depth >= MAX_COPY_TREE_DEPTH {
        return Err(Error::FolderSwitch(FolderSwitchFailure::SourceUnreadable));
    }
    let entries = read_directory_entries_at(dir, &CancellationToken::new(), None, &mut |_| true)
        .map_err(|_| Error::FolderSwitch(FolderSwitchFailure::SourceUnreadable))?;
    for entry in entries {
        match entry.kind {
            DirectoryEntryKind::Directory => {
                let child_dir = open_directory_at(dir, &entry.name, false).map_err(|error| {
                    if matches!(error.unlabelled(), Error::InvalidInput(_)) {
                        Error::FolderSwitch(FolderSwitchFailure::SymlinkInTree)
                    } else {
                        Error::FolderSwitch(FolderSwitchFailure::SourceUnreadable)
                    }
                })?;
                if opened_file_identity(&child_dir)
                    .map_err(|_| Error::FolderSwitch(FolderSwitchFailure::SourceUnreadable))?
                    != entry.identity
                {
                    return Err(Error::FolderSwitch(FolderSwitchFailure::IdentityChanged));
                }
                verify_tree_has_no_links(&child_dir, depth + 1)?;
            }
            DirectoryEntryKind::RegularFile => {}
            DirectoryEntryKind::Other => {
                return Err(Error::FolderSwitch(FolderSwitchFailure::SymlinkInTree));
            }
        }
    }
    Ok(())
}

pub(crate) struct MovablePlan {
    pub(crate) item_count: u32,
    pub(crate) items: Vec<JournalItem>,
}

fn enumerate_db3_movable(source_dir: &fs::File) -> Result<MovablePlan, Error> {
    let entries =
        read_directory_entries_at(source_dir, &CancellationToken::new(), None, &mut |_| true)
            .map_err(|_| Error::FolderSwitch(FolderSwitchFailure::SourceUnreadable))?;
    let mut db_leaves = Vec::new();
    for entry in entries {
        if !is_db3_leaf(&entry.name) {
            continue;
        }
        match entry.kind {
            DirectoryEntryKind::RegularFile => db_leaves.push(entry.name),
            DirectoryEntryKind::Directory => {}
            DirectoryEntryKind::Other => {
                return Err(Error::FolderSwitch(FolderSwitchFailure::SymlinkInTree));
            }
        }
    }
    db_leaves.sort();

    let mut items = Vec::new();
    let mut seen_leaves = HashSet::new();
    for db_leaf in &db_leaves {
        let id = entry_identity_at(source_dir, db_leaf, false).map_err(|error| {
            if matches!(error.unlabelled(), Error::InvalidInput(_)) {
                Error::FolderSwitch(FolderSwitchFailure::SymlinkInTree)
            } else {
                Error::FolderSwitch(FolderSwitchFailure::SourceUnreadable)
            }
        })?;
        if seen_leaves.insert(db_leaf.clone()) {
            items.push(JournalItem {
                leaf: NativePath::from_path(Path::new(db_leaf)),
                is_dir: false,
                is_primary_db: true,
                source_identity: Identity { a: id.0, b: id.1 },
                target_identity: None,
                transferred: false,
            });
        }
        for sidecar in db3_sidecar_candidates(db_leaf) {
            if !seen_leaves.insert(sidecar.clone()) {
                continue;
            }
            match entry_identity_at(source_dir, &sidecar, false) {
                Ok(sidecar_id) => {
                    items.push(JournalItem {
                        leaf: NativePath::from_path(Path::new(&sidecar)),
                        is_dir: false,
                        is_primary_db: false,
                        source_identity: Identity {
                            a: sidecar_id.0,
                            b: sidecar_id.1,
                        },
                        target_identity: None,
                        transferred: false,
                    });
                }
                Err(error) if error.is_missing_entry() => {}
                Err(error) if matches!(error.unlabelled(), Error::InvalidInput(_)) => {
                    return Err(Error::FolderSwitch(FolderSwitchFailure::SymlinkInTree));
                }
                Err(_) => {
                    return Err(Error::FolderSwitch(FolderSwitchFailure::SourceUnreadable));
                }
            }
        }
    }
    let item_count = u32::try_from(db_leaves.len()).unwrap_or(u32::MAX);
    Ok(MovablePlan { item_count, items })
}

fn copy_and_verify_file_at(
    source_parent: &fs::File,
    target_parent: &fs::File,
    leaf: &OsStr,
    expected_source: Option<(u64, u64)>,
    on_created: &mut dyn FnMut((u64, u64)) -> Result<(), Error>,
) -> Result<(u64, u64), Error> {
    let mut source_file = open_regular_at(source_parent, leaf, RegularFileAccess::ReadOnly)
        .map_err(|error| {
            if matches!(error.unlabelled(), Error::InvalidInput(_)) {
                Error::FolderSwitch(FolderSwitchFailure::SymlinkInTree)
            } else {
                error
            }
        })?;
    let actual_source = opened_file_identity(&source_file)?;
    if let Some(expected) = expected_source {
        if actual_source != expected {
            return Err(Error::Conflict(
                "source file identity changed during copy".into(),
            ));
        }
    }
    #[cfg(unix)]
    let source_mode = {
        use std::os::unix::fs::PermissionsExt;
        source_file.metadata()?.permissions().mode() & 0o777
    };
    let (mut dest_file, dest_identity) = create_regular_at(target_parent, leaf)?;
    let write_and_verify = (|| -> Result<(), Error> {
        on_created(dest_identity)?;
        let mut hasher = Sha256::new();
        let mut total_bytes: u64 = 0;
        let mut buf = vec![0u8; COPY_BUFFER_BYTES];
        loop {
            let read = source_file.read(&mut buf)?;
            if read == 0 {
                break;
            }
            dest_file.write_all(&buf[..read])?;
            hasher.update(&buf[..read]);
            total_bytes = total_bytes.saturating_add(read as u64);
            #[cfg(test)]
            if take_test_fault(FolderSwitchTestFault::FailCopyMidFile) {
                return Err(Error::Io(Box::new(std::io::Error::other(
                    "injected mid-file copy failure",
                ))));
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            dest_file.set_permissions(fs::Permissions::from_mode(source_mode))?;
        }
        dest_file.sync_all()?;
        drop(dest_file);
        let expected_hash = hasher.finalize();

        // Re-open destination read-only (no-follow) and verify identity, size, and SHA-256.
        let mut verify_file = open_regular_at(target_parent, leaf, RegularFileAccess::ReadOnly)?;
        if opened_file_identity(&verify_file)? != dest_identity {
            return Err(Error::Conflict(
                "copied file identity changed before verification".into(),
            ));
        }
        let meta_len = verify_file.metadata()?.len();
        if meta_len != total_bytes {
            return Err(Error::Io(Box::new(std::io::Error::other(
                "copied file size mismatch",
            ))));
        }
        let mut verify_hasher = Sha256::new();
        let mut verified_bytes: u64 = 0;
        loop {
            let read = verify_file.read(&mut buf)?;
            if read == 0 {
                break;
            }
            verify_hasher.update(&buf[..read]);
            verified_bytes = verified_bytes.saturating_add(read as u64);
        }
        if verified_bytes != total_bytes || verify_hasher.finalize() != expected_hash {
            return Err(Error::Io(Box::new(std::io::Error::other(
                "copied file content hash mismatch",
            ))));
        }
        Ok(())
    })();
    if let Err(error) = write_and_verify {
        if let Err(cleanup_err) = remove_entry_at(target_parent, leaf, dest_identity, false) {
            if !cleanup_err.is_missing_entry() {
                log::warn!(
                    "could not immediately remove partial destination file: {}",
                    cleanup_err.diagnostic()
                );
            }
        }
        return Err(error);
    }
    Ok(dest_identity)
}

fn copy_and_verify_tree_at(
    source_parent: &fs::File,
    target_parent: &fs::File,
    leaf: &OsStr,
    expected_source: Option<(u64, u64)>,
    depth: usize,
    on_created: &mut dyn FnMut((u64, u64)) -> Result<(), Error>,
) -> Result<(u64, u64), Error> {
    if depth >= MAX_COPY_TREE_DEPTH {
        return Err(Error::FolderSwitch(FolderSwitchFailure::SourceUnreadable));
    }
    let source_dir = open_directory_at(source_parent, leaf, false).map_err(|error| {
        if matches!(error.unlabelled(), Error::InvalidInput(_)) {
            Error::FolderSwitch(FolderSwitchFailure::SymlinkInTree)
        } else {
            error
        }
    })?;
    if let Some(expected) = expected_source {
        if opened_file_identity(&source_dir)? != expected {
            return Err(Error::Conflict(
                "source directory identity changed during copy".into(),
            ));
        }
    }
    create_dir_at(target_parent, leaf)?;
    let target_dir = open_directory_at(target_parent, leaf, true)?;
    let target_id = opened_file_identity(&target_dir)?;

    let populate = (|| -> Result<(), Error> {
        on_created(target_id)?;
        let entries =
            read_directory_entries_at(&source_dir, &CancellationToken::new(), None, &mut |_| true)?;
        for entry in entries {
            match entry.kind {
                DirectoryEntryKind::Directory => {
                    copy_and_verify_tree_at(
                        &source_dir,
                        &target_dir,
                        &entry.name,
                        Some(entry.identity),
                        depth + 1,
                        &mut |_| Ok(()),
                    )?;
                }
                DirectoryEntryKind::RegularFile => {
                    copy_and_verify_file_at(
                        &source_dir,
                        &target_dir,
                        &entry.name,
                        Some(entry.identity),
                        &mut |_| Ok(()),
                    )?;
                    #[cfg(test)]
                    if take_test_fault(FolderSwitchTestFault::FailCopyMidTree) {
                        return Err(Error::Io(Box::new(std::io::Error::other(
                            "injected mid-tree copy failure",
                        ))));
                    }
                }
                DirectoryEntryKind::Other => {
                    return Err(Error::FolderSwitch(FolderSwitchFailure::SymlinkInTree));
                }
            }
        }
        target_dir.sync_all()?;
        Ok(())
    })();
    drop(target_dir);
    if let Err(error) = populate {
        if let Err(cleanup_err) = remove_entry_at(target_parent, leaf, target_id, true) {
            if !cleanup_err.is_missing_entry() {
                log::warn!(
                    "could not immediately remove partial destination tree: {}",
                    cleanup_err.diagnostic()
                );
            }
        }
        return Err(error);
    }
    Ok(target_id)
}

fn check_collisions(target_dir: &fs::File, items: &[JournalItem]) -> Result<(), Error> {
    let entries =
        read_directory_entries_at(target_dir, &CancellationToken::new(), None, &mut |_| true)
            .map_err(|_| Error::FolderSwitch(FolderSwitchFailure::TargetUnwritable))?;
    let mut existing = HashSet::new();
    for entry in entries {
        existing.insert(fold_leaf_name_for_collision(&entry.name));
    }
    let mut collisions: u32 = 0;
    for item in items {
        let leaf_path = item
            .leaf
            .to_path()
            .map_err(|_| Error::FolderSwitch(FolderSwitchFailure::SourceUnreadable))?;
        if existing.contains(&fold_leaf_name_for_collision(leaf_path.as_os_str())) {
            collisions = collisions.saturating_add(1);
        }
    }
    if collisions > 0 {
        return Err(Error::FolderSwitch(FolderSwitchFailure::NameCollision {
            count: collisions,
        }));
    }
    Ok(())
}

/// Explicit, error-returning rollback of a transfer before commit.
pub(super) fn rollback_transfer(
    journal: &mut FolderSwitchJournal,
    source_dir: &fs::File,
    target_dir: &fs::File,
) -> Result<(), Error> {
    #[cfg(test)]
    if take_test_fault(FolderSwitchTestFault::FailRollback) {
        return Err(Error::Io(Box::new(std::io::Error::other(
            "injected rollback failure",
        ))));
    }
    for item in journal.items.iter_mut().rev() {
        let leaf_path = item.leaf.to_path()?;
        let leaf = leaf_path.as_os_str();
        match journal.mode {
            TransferMode::Rename => {
                // Same-volume rename preserves `source_identity`. Check `target_dir` regardless of
                // `item.transferred` so a crash between `rename_entry_at` and `write_journal_file`
                // still recovers the item back to `source_dir`.
                let expected_target = item
                    .target_identity
                    .as_ref()
                    .map(|id| (id.a, id.b))
                    .unwrap_or((item.source_identity.a, item.source_identity.b));
                match entry_identity_at(target_dir, leaf, item.is_dir) {
                    Ok(actual) if actual == expected_target => {
                        let outcome = rename_entry_at(
                            target_dir,
                            leaf,
                            expected_target,
                            item.is_dir,
                            source_dir,
                            leaf,
                        )?;
                        let _ = outcome;
                        item.transferred = false;
                        item.target_identity = None;
                    }
                    Err(error) if error.is_missing_entry() => {
                        // Prove the item is actually back in `source_dir` before settling.
                        let source_id = entry_identity_at(source_dir, leaf, item.is_dir)?;
                        if source_id != (item.source_identity.a, item.source_identity.b) {
                            return Err(Error::Conflict(
                                "source entry identity mismatch during rename rollback".into(),
                            ));
                        }
                        item.transferred = false;
                        item.target_identity = None;
                    }
                    Ok(_) => {
                        return Err(Error::Conflict(
                            "target entry identity mismatch during rollback".into(),
                        ));
                    }
                    Err(error) => return Err(error),
                }
            }
            TransferMode::Copy => {
                let Some(target_id) = item.target_identity.as_ref() else {
                    continue;
                };
                match remove_entry_at(target_dir, leaf, (target_id.a, target_id.b), item.is_dir) {
                    Ok(()) => {
                        item.transferred = false;
                        item.target_identity = None;
                    }
                    Err(error) if error.is_missing_entry() => {
                        item.transferred = false;
                        item.target_identity = None;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
    }
    Ok(())
}

fn cleanup_after_commit(
    journal: &FolderSwitchJournal,
    source_dir: VerifiedDir,
    source_path: &Path,
    lookups: &DefaultDirLookups<'_>,
) -> Result<(), Error> {
    #[cfg(test)]
    if take_test_fault(FolderSwitchTestFault::FailCleanup) {
        return Err(Error::Io(Box::new(std::io::Error::other(
            "injected cleanup failure",
        ))));
    }
    if journal.mode == TransferMode::Copy {
        for item in &journal.items {
            let leaf_path = item.leaf.to_path()?;
            let leaf = leaf_path.as_os_str();
            let expected = (item.source_identity.a, item.source_identity.b);
            match remove_entry_at(source_dir.as_file(), leaf, expected, item.is_dir) {
                Ok(()) => {}
                Err(error) if error.is_missing_entry() => {}
                Err(error) => return Err(error),
            }
        }
    }

    // Remove the old root directory ONLY if it is the legacy app-data default (by identity),
    // is NOT the current visible default (by identity), and is now empty.
    let source_id = (
        journal.source_root_identity.a,
        journal.source_root_identity.b,
    );
    let is_empty = read_directory_entries_at(
        source_dir.as_file(),
        &CancellationToken::new(),
        Some(1),
        &mut |_| true,
    )
    .map(|entries| entries.is_empty())
    .unwrap_or(false);
    // Close `source_dir` before attempting to remove `source_path` so Windows does not fail with
    // ERROR_SHARING_VIOLATION.
    drop(source_dir);

    let is_legacy = (lookups.app_data)()
        .ok()
        .map(|app_data| {
            app_data
                .path
                .join(journal.kind.legacy_default_root().leaf())
        })
        .and_then(|legacy_path| open_directory_nofollow_readonly(&legacy_path).ok())
        .and_then(|file| opened_file_identity(&file).ok())
        .is_some_and(|id| id == source_id);
    let is_current_default =
        live_visible_default_identity(lookups, journal.kind.visible_default_kind())
            .is_some_and(|id| (id.a, id.b) == source_id);
    if is_empty && is_legacy && !is_current_default {
        if let (Some(parent), Some(leaf)) = (source_path.parent(), source_path.file_name()) {
            if let Ok(parent_dir) = open_directory_nofollow_writable(parent) {
                if let Err(error) = remove_empty_directory_at(&parent_dir, leaf, source_id) {
                    log::warn!(
                        "could not remove empty legacy default folder after move: {}",
                        error.diagnostic()
                    );
                }
            }
        }
    }
    Ok(())
}

fn update_rebound_sidecar_identity(
    authority: &SharedPathAuthority,
    journal: &mut FolderSwitchJournal,
    target_dir: &fs::File,
    sidecar_leaf: &OsStr,
) -> Result<(), Error> {
    let new_id = entry_identity_at(target_dir, sidecar_leaf, false)?;
    let folded_leaf = fold_leaf_name_for_collision(sidecar_leaf);
    for item in &mut journal.items {
        if let Ok(item_leaf) = item.leaf.to_path() {
            if fold_leaf_name_for_collision(item_leaf.as_os_str()) == folded_leaf {
                item.target_identity = Some(Identity {
                    a: new_id.0,
                    b: new_id.1,
                });
                break;
            }
        }
    }
    authority.with_mut(|auth| auth.write_journal_file(journal))??;
    Ok(())
}

fn rebind_copied_database_sidecars(
    authority: &SharedPathAuthority,
    source_dir: &fs::File,
    target_dir: &fs::File,
    journal: &mut FolderSwitchJournal,
) -> Result<(), Error> {
    let primary_leaves: Vec<OsString> = journal
        .items
        .iter()
        .filter(|item| item.is_primary_db)
        .filter_map(|item| item.leaf.to_path().ok().map(|p| p.into_os_string()))
        .collect();

    for db_leaf_owned in primary_leaves {
        let db_leaf = db_leaf_owned.as_os_str();
        let src_file = open_regular_at(source_dir, db_leaf, RegularFileAccess::ReadOnly)?;
        let src_object = opened_file_identity(&src_file)?;
        let src_meta = src_file.metadata()?;
        let src_len = src_meta.len();
        let src_modified = src_meta.modified()?;
        drop(src_file);

        let db_file = open_regular_at(target_dir, db_leaf, RegularFileAccess::ReadOnly)?;
        let new_object = opened_file_identity(&db_file)?;
        let meta = db_file.metadata()?;
        let new_len = meta.len();
        let new_modified = meta.modified()?;
        drop(db_file);

        let src_stamp = crate::db::SidecarFileStamp {
            object: src_object,
            length: src_len,
            modified: src_modified,
        };
        let dst_stamp = crate::db::SidecarFileStamp {
            object: new_object,
            length: new_len,
            modified: new_modified,
        };

        // Rebind preferred `.db3.ecsi` and legacy `.ecsi` if present and valid for source.
        let preferred = crate::db::preferred_sidecar_leaf(db_leaf);
        if crate::db::rebind_index_source_at(target_dir, &preferred, src_stamp, dst_stamp)? {
            update_rebound_sidecar_identity(authority, journal, target_dir, &preferred)?;
        }
        let legacy = crate::db::legacy_sidecar_leaf(db_leaf);
        if legacy != preferred
            && crate::db::rebind_index_source_at(target_dir, &legacy, src_stamp, dst_stamp)?
        {
            update_rebound_sidecar_identity(authority, journal, target_dir, &legacy)?;
        }
        // Rebind `.db3.integrity` stamp if present and valid for source.
        if crate::db::rebind_stamp_at(target_dir, db_leaf, src_stamp, dst_stamp)? {
            let stamp_leaf = crate::db::integrity_stamp_leaf(db_leaf);
            update_rebound_sidecar_identity(authority, journal, target_dir, &stamp_leaf)?;
        }
    }
    Ok(())
}

pub(crate) enum FolderSwitchGrantLookup {
    Replay(FolderStatus),
    Live {
        kind: FolderSwitchKind,
        source_root: PathRef,
        source_identity: Identity,
        target_path: PathBuf,
        target_identity: Identity,
        target_display_name: String,
        target_expected_identity: Option<Identity>,
    },
}

#[derive(Debug)]
pub(crate) struct PreparedFolderMove {
    pub(crate) kind: FolderSwitchKind,
    pub(crate) source_root: PathRef,
    pub(crate) source_path: PathBuf,
    pub(crate) source_identity: (u64, u64),
    pub(crate) target_path: PathBuf,
    pub(crate) target_identity: (u64, u64),
    pub(crate) target_display_name: String,
    pub(crate) target_expected_identity: Option<Identity>,
}

impl PathAuthority {
    pub(crate) fn quiesce_engine_root(&self, root_identity: (u64, u64)) -> EngineRootQuiesceGuard {
        self.quiesced_engine_roots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(root_identity);
        EngineRootQuiesceGuard {
            quiesced: Arc::clone(&self.quiesced_engine_roots),
            root_identity,
            lifted: false,
        }
    }

    pub(super) fn is_engine_root_quiesced(&self, root_identity: (u64, u64)) -> bool {
        self.quiesced_engine_roots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains(&root_identity)
    }

    pub(super) fn is_under_quiesced_engine_root(
        &self,
        path: &Path,
        identity: Option<(u64, u64)>,
        parent_identity: Option<(u64, u64)>,
    ) -> bool {
        let quiesced: Vec<(u64, u64)> = {
            let guard = self
                .quiesced_engine_roots
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if guard.is_empty() {
                return false;
            }
            guard.iter().copied().collect()
        };
        if identity.is_some_and(|id| quiesced.contains(&id))
            || parent_identity.is_some_and(|id| quiesced.contains(&id))
        {
            return true;
        }
        if let Ok(ancestors) = ancestor_identities(path) {
            if ancestors.iter().any(|id| quiesced.contains(id)) {
                return true;
            }
        }
        false
    }

    /// Collects all registered engine executable/configure and resource `PathRef`s currently
    /// residing under `source_identity` (matched by live ancestor directory identity).
    pub(crate) fn collect_engine_refs_under_root(
        &self,
        source_identity: (u64, u64),
    ) -> (HashSet<PathRef>, HashSet<PathRef>) {
        let mut executable_refs = HashSet::new();
        let mut resource_refs = HashSet::new();
        for entry in self.persistent.values() {
            let is_exec = entry.stored.operations.iter().any(|op| {
                matches!(
                    op,
                    PathOperation::EngineExecute | PathOperation::EngineConfigure
                )
            });
            let is_resource = entry
                .stored
                .operations
                .contains(&PathOperation::EngineResourceRead);
            if !is_exec && !is_resource {
                continue;
            }
            if let Ok(entry_path) = entry.stored.path.to_path() {
                if relative_from_ancestor_identity(
                    &entry_path,
                    entry.stored.parent_identity.as_ref(),
                    source_identity,
                )
                .is_some()
                {
                    if is_exec {
                        executable_refs.insert(entry.stored.id.clone());
                    }
                    if is_resource {
                        resource_refs.insert(entry.stored.id.clone());
                    }
                }
            }
        }
        (executable_refs, resource_refs)
    }

    pub(crate) fn journal_path(&self, kind: FolderSwitchKind) -> PathBuf {
        self.registry_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(kind.journal_filename())
    }

    pub(crate) fn has_unresolved_journal(&self, kind: FolderSwitchKind) -> bool {
        self.unresolved_journals.contains(&kind) || self.journal_path(kind).exists()
    }

    pub(crate) fn interrupted_move_root_error() -> Error {
        Error::FolderSwitch(FolderSwitchFailure::InterruptedMove)
            .with_root_failure(RootFailure::InterruptedMove)
    }

    pub(crate) fn active_root_id_for_kind(&self, kind: FolderSwitchKind) -> Option<PathRef> {
        match kind {
            FolderSwitchKind::Database => self.active_database_root.clone(),
            FolderSwitchKind::Engine => self.active_engine_root.clone(),
            FolderSwitchKind::Puzzle => self.active_puzzle_root.clone(),
        }
    }

    pub(super) fn write_journal_file(&self, journal: &FolderSwitchJournal) -> Result<(), Error> {
        #[cfg(test)]
        if take_test_fault(FolderSwitchTestFault::FailJournalWrite) {
            return Err(Error::FolderSwitch(FolderSwitchFailure::JournalWriteFailed));
        }
        let path = self.journal_path(journal.kind);
        let bytes = serde_json::to_vec(journal).map_err(|error| {
            log::error!("folder switch journal encode failed: {error}");
            Error::FolderSwitch(FolderSwitchFailure::JournalWriteFailed)
        })?;
        let outcome = atomic_replace(&path, |file| file.write_all(&bytes).map_err(Error::from))
            .map_err(|error| {
                log::error!("folder switch journal write failed: {}", error.diagnostic());
                Error::FolderSwitch(FolderSwitchFailure::JournalWriteFailed)
            })?;
        require_durable(outcome, crate::error::DurabilityStage::RegistryReplacement).map_err(
            |error| {
                log::error!(
                    "folder switch journal durability failed: {}",
                    error.diagnostic()
                );
                Error::FolderSwitch(FolderSwitchFailure::JournalWriteFailed)
            },
        )
    }

    fn remove_journal_file(&mut self, kind: FolderSwitchKind) {
        let path = self.journal_path(kind);
        match fs::remove_file(&path) {
            Ok(()) => {
                self.unresolved_journals.remove(&kind);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.unresolved_journals.remove(&kind);
            }
            Err(error) => {
                log::warn!(
                    "failed to remove completed folder switch journal for {kind:?}: {error}"
                );
            }
        }
    }

    /// Runs at startup before any root of any kind is served. Settles any leftover move journal
    /// idempotently (rollback if active root is still source; finish cleanup if active root is
    /// target). If recovery cannot reach a complete state, the kind is marked unresolved so it
    /// surfaces as `RootFailure::InterruptedMove` and retries on the next start.
    pub(crate) fn recover_folder_switch_journals(&mut self, lookups: &DefaultDirLookups<'_>) {
        for kind in FolderSwitchKind::ALL {
            let path = self.journal_path(kind);
            if !path.exists() {
                continue;
            }
            let raw = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(error) => {
                    log::error!(
                        "could not read folder switch journal for {kind:?} during startup recovery: {error}"
                    );
                    self.unresolved_journals.insert(kind);
                    continue;
                }
            };
            let mut journal: FolderSwitchJournal = match serde_json::from_slice(&raw) {
                Ok(journal) => journal,
                Err(error) => {
                    log::error!(
                        "corrupt folder switch journal for {kind:?} during startup recovery: {error}"
                    );
                    self.unresolved_journals.insert(kind);
                    continue;
                }
            };
            if journal.version != JOURNAL_VERSION || journal.kind != kind {
                log::error!("unsupported folder switch journal metadata for {kind:?}");
                self.unresolved_journals.insert(kind);
                continue;
            }
            let active_is_target = self
                .active_root_id_for_kind(kind)
                .and_then(|id| self.persistent.get(&id.id))
                .is_some_and(|entry| entry.stored.identity == journal.target_root_identity);

            let outcome: Result<(), Error> = (|| {
                let source_path = journal.source_root_path.to_path()?;
                let target_path = journal.target_root_path.to_path()?;
                if active_is_target {
                    match open_verified_directory(
                        &source_path,
                        (
                            journal.source_root_identity.a,
                            journal.source_root_identity.b,
                        ),
                    ) {
                        Ok(source_dir) => {
                            cleanup_after_commit(&journal, source_dir, &source_path, lookups)?;
                        }
                        Err(error) if error.is_missing_entry() => {
                            // Source directory already gone (e.g. empty legacy default removed).
                        }
                        Err(error) => return Err(error),
                    }
                    Ok(())
                } else {
                    let source_dir = open_verified_directory(
                        &source_path,
                        (
                            journal.source_root_identity.a,
                            journal.source_root_identity.b,
                        ),
                    )?;
                    let target_dir = open_verified_directory(
                        &target_path,
                        (
                            journal.target_root_identity.a,
                            journal.target_root_identity.b,
                        ),
                    )?;
                    rollback_transfer(&mut journal, source_dir.as_file(), target_dir.as_file())
                }
            })();

            match outcome {
                Ok(()) => {
                    self.remove_journal_file(kind);
                    log::info!(
                        "recovered interrupted folder switch for {kind:?} (committed={active_is_target})"
                    );
                }
                Err(error) => {
                    log::error!(
                        "startup folder switch recovery failed for {kind:?} (committed={active_is_target}): {}",
                        error.diagnostic()
                    );
                    self.unresolved_journals.insert(kind);
                }
            }
        }
    }

    pub(super) fn issue_folder_switch_grant(
        &mut self,
        kind: FolderSwitchKind,
        source_root: PathRef,
        source_identity: Identity,
        target_acquired: AcquiredTarget,
        target_display_name: String,
        target_expected_identity: Option<Identity>,
    ) -> Result<FolderSwitchGrant, Error> {
        let id = self.insert_dialog_grant(
            target_acquired,
            target_display_name,
            PathClass::SingleDialogGrant,
            vec![kind.root_operation()],
            (PICKER_DIALOG_GRANT_TTL, 1),
            Some(FolderSwitchGrantMetadata {
                kind,
                source_root,
                source_identity,
                target_expected_identity,
                committed_status: None,
            }),
        )?;
        Ok(FolderSwitchGrant { id, kind })
    }

    pub(crate) fn cancel_folder_switch_grant(&mut self, grant: &FolderSwitchGrant) {
        self.evict_dialogs();
        let should_remove = self.dialogs.get(&grant.id.id).is_some_and(|entry| {
            entry
                .folder_switch
                .as_ref()
                .is_some_and(|meta| meta.kind == grant.kind && meta.committed_status.is_none())
        });
        if should_remove {
            self.dialogs.remove(&grant.id.id);
        }
    }

    pub(crate) fn lookup_folder_switch_grant(
        &mut self,
        grant: &FolderSwitchGrant,
    ) -> Result<FolderSwitchGrantLookup, Error> {
        self.evict_dialogs();
        let entry = self
            .dialogs
            .get(&grant.id.id)
            .ok_or(Error::FolderSwitch(FolderSwitchFailure::ExpiredGrant))?;
        let meta = entry
            .folder_switch
            .as_ref()
            .filter(|meta| meta.kind == grant.kind)
            .ok_or(Error::FolderSwitch(FolderSwitchFailure::ExpiredGrant))?;
        if let Some(status) = &meta.committed_status {
            return Ok(FolderSwitchGrantLookup::Replay(status.clone()));
        }
        if entry.uses_left == 0 {
            return Err(Error::FolderSwitch(FolderSwitchFailure::ExpiredGrant));
        }
        let target_path = entry
            .entry
            .stored
            .path
            .to_path()
            .map_err(|_| Error::FolderSwitch(FolderSwitchFailure::IdentityChanged))?;
        Ok(FolderSwitchGrantLookup::Live {
            kind: meta.kind,
            source_root: meta.source_root.clone(),
            source_identity: meta.source_identity.clone(),
            target_path,
            target_identity: entry.entry.stored.identity.clone(),
            target_display_name: entry.entry.stored.display_name.clone(),
            target_expected_identity: meta.target_expected_identity.clone(),
        })
    }

    pub(crate) fn mark_folder_switch_grant_committed(
        &mut self,
        grant: &FolderSwitchGrant,
        status: FolderStatus,
    ) {
        if let Some(entry) = self.dialogs.get_mut(&grant.id.id) {
            entry.uses_left = 0;
            if let Some(meta) = entry.folder_switch.as_mut() {
                meta.committed_status = Some(status);
            }
        }
    }

    pub(crate) fn folder_status_for_kind(
        &mut self,
        kind: FolderSwitchKind,
        lookups: &DefaultDirLookups<'_>,
    ) -> Result<FolderStatus, Error> {
        match kind {
            FolderSwitchKind::Database => self.database_folder_status(lookups),
            FolderSwitchKind::Engine => self.engine_folder_status(lookups),
            FolderSwitchKind::Puzzle => self.puzzle_folder_status(lookups),
        }
    }

    /// Evaluates choosing `target_path` for `kind`. Returns `Ok(None)` when the target was
    /// immediately activated (empty/unusable/missing/same source), or `Ok(Some((grant, display_name, item_count)))`
    /// when movable content exists and the user must choose Move / Use new folder only / Cancel.
    pub(crate) fn choose_folder_switch(
        &mut self,
        kind: FolderSwitchKind,
        target_path: &Path,
        target_display_name: String,
        target_expected_identity: Option<VerifiedIdentity>,
    ) -> Result<Option<(FolderSwitchGrant, String, u32)>, Error> {
        // InterruptedMove ALWAYS takes precedence over every other result, including Activated.
        if self.has_unresolved_journal(kind) {
            return Err(Error::FolderSwitch(FolderSwitchFailure::InterruptedMove));
        }
        let target_acquired = acquire_target(
            target_path,
            AcquireShape::Root {
                parent_access: ParentAccess::Readable,
            },
        )?;
        reject_disagreeing_expected_identity(&target_acquired.identity, target_expected_identity)?;

        let active_id = self.active_root_id_for_kind(kind);
        let source_resolved = match active_id {
            Some(ref id) => match self.resolve_active_root(Some(id.clone()), kind.root_operation())
            {
                Ok(Some(valid_id)) => Some(valid_id),
                Ok(None) | Err(_) => None,
            },
            None => None,
        };

        let Some(source_root_id) = source_resolved else {
            // No active root or current root is unusable/missing -> activate target directly.
            self.activate_root_directly(
                kind,
                &target_acquired.path,
                target_display_name,
                target_expected_identity,
            )?;
            return Ok(None);
        };

        let source_entry = self
            .persistent
            .get(&source_root_id.id)
            .cloned()
            .ok_or_else(|| Error::FolderSwitch(FolderSwitchFailure::SourceUnreadable))?;
        let source_identity = source_entry.stored.identity.clone();

        if source_identity == target_acquired.identity {
            // Already active on this exact directory -> Activated without a grant.
            return Ok(None);
        }

        let source_path = source_entry
            .stored
            .path
            .to_path()
            .map_err(|_| Error::FolderSwitch(FolderSwitchFailure::SourceUnreadable))?;
        let source_dir =
            open_verified_directory(&source_path, (source_identity.a, source_identity.b))
                .map_err(|_| Error::FolderSwitch(FolderSwitchFailure::SourceUnreadable))?;

        let plan = self.enumerate_movable_for_kind(
            kind,
            source_dir.as_file(),
            (source_identity.a, source_identity.b),
        )?;

        if plan.item_count == 0 {
            self.activate_root_directly(
                kind,
                &target_acquired.path,
                target_display_name,
                target_expected_identity,
            )?;
            return Ok(None);
        }

        let grant = self.issue_folder_switch_grant(
            kind,
            source_root_id,
            source_identity,
            target_acquired,
            target_display_name.clone(),
            target_expected_identity.map(|v| {
                let (a, b) = v.pair();
                Identity { a, b }
            }),
        )?;
        Ok(Some((grant, target_display_name, plan.item_count)))
    }

    pub(crate) fn activate_root_directly(
        &mut self,
        kind: FolderSwitchKind,
        target_path: &Path,
        target_display_name: String,
        target_expected_identity: Option<VerifiedIdentity>,
    ) -> Result<PathRef, Error> {
        match kind {
            FolderSwitchKind::Database => {
                let root = self.get_or_create_database_root(
                    target_path,
                    target_display_name,
                    target_expected_identity,
                )?;
                self.set_active_database_root(&root)?;
                Ok(root.path_ref().clone())
            }
            FolderSwitchKind::Engine => {
                let root = self.get_or_create_engine_root(
                    target_path,
                    target_display_name,
                    target_expected_identity,
                )?;
                self.set_active_engine_root(&root)?;
                Ok(root.path_ref().clone())
            }
            FolderSwitchKind::Puzzle => {
                let root = self.get_or_create_puzzle_root(
                    target_path,
                    target_display_name,
                    target_expected_identity,
                )?;
                self.set_active_puzzle_root(&root)?;
                Ok(root.path_ref().clone())
            }
        }
    }

    pub(crate) fn enumerate_movable_for_kind(
        &self,
        kind: FolderSwitchKind,
        source_dir: &fs::File,
        source_identity: (u64, u64),
    ) -> Result<MovablePlan, Error> {
        match kind {
            FolderSwitchKind::Database | FolderSwitchKind::Puzzle => {
                enumerate_db3_movable(source_dir)
            }
            FolderSwitchKind::Engine => {
                let leaves = self.catalog_install_leaves_for_root(Identity {
                    a: source_identity.0,
                    b: source_identity.1,
                });
                let mut items = Vec::new();
                for leaf in leaves {
                    match entry_identity_at(source_dir, &leaf, true) {
                        Ok(dir_id) => {
                            let child_dir =
                                open_directory_at(source_dir, &leaf, false).map_err(|error| {
                                    if matches!(error.unlabelled(), Error::InvalidInput(_)) {
                                        Error::FolderSwitch(FolderSwitchFailure::SymlinkInTree)
                                    } else {
                                        Error::FolderSwitch(FolderSwitchFailure::SourceUnreadable)
                                    }
                                })?;
                            verify_tree_has_no_links(&child_dir, 0)?;
                            items.push(JournalItem {
                                leaf: NativePath::from_path(Path::new(&leaf)),
                                is_dir: true,
                                is_primary_db: false,
                                source_identity: Identity {
                                    a: dir_id.0,
                                    b: dir_id.1,
                                },
                                target_identity: None,
                                transferred: false,
                            });
                        }
                        Err(error) if error.is_missing_entry() => {}
                        Err(error) if matches!(error.unlabelled(), Error::InvalidInput(_)) => {
                            return Err(Error::FolderSwitch(FolderSwitchFailure::SymlinkInTree));
                        }
                        Err(_) => {
                            return Err(Error::FolderSwitch(FolderSwitchFailure::SourceUnreadable));
                        }
                    }
                }
                let item_count = u32::try_from(items.len()).unwrap_or(u32::MAX);
                Ok(MovablePlan { item_count, items })
            }
        }
    }

    /// Re-proves grant, collects metadata needed for quiesce and transfer without holding
    /// the authority lock across blocking filesystem copy or async quiesce.
    pub(crate) fn prepare_folder_move(
        &mut self,
        grant: &FolderSwitchGrant,
    ) -> Result<Result<PreparedFolderMove, FolderStatus>, Error> {
        if self.has_unresolved_journal(grant.kind) {
            return Err(Error::FolderSwitch(FolderSwitchFailure::InterruptedMove));
        }
        let lookup = self.lookup_folder_switch_grant(grant)?;
        match lookup {
            FolderSwitchGrantLookup::Replay(status) => Ok(Err(status)),
            FolderSwitchGrantLookup::Live {
                kind,
                source_root,
                source_identity,
                target_path,
                target_identity,
                target_display_name,
                target_expected_identity,
            } => {
                // Re-prove source root is still the active root and matches identity.
                if self.active_root_id_for_kind(kind).as_ref() != Some(&source_root) {
                    return Err(Error::FolderSwitch(FolderSwitchFailure::IdentityChanged));
                }
                let source_entry = self
                    .persistent
                    .get(&source_root.id)
                    .cloned()
                    .ok_or(Error::FolderSwitch(FolderSwitchFailure::IdentityChanged))?;
                if source_entry.stored.identity != source_identity {
                    return Err(Error::FolderSwitch(FolderSwitchFailure::IdentityChanged));
                }
                let source_path = source_entry
                    .stored
                    .path
                    .to_path()
                    .map_err(|_| Error::FolderSwitch(FolderSwitchFailure::IdentityChanged))?;

                Ok(Ok(PreparedFolderMove {
                    kind,
                    source_root,
                    source_path,
                    source_identity: (source_identity.a, source_identity.b),
                    target_path,
                    target_identity: (target_identity.a, target_identity.b),
                    target_display_name,
                    target_expected_identity,
                }))
            }
        }
    }

    /// Executes `useOnly` mode: re-proves both source and target identities, activates target root
    /// without moving any files, marks grant committed for lost-reply replay, and returns the new
    /// `FolderStatus`.
    pub(crate) fn apply_folder_switch_use_only(
        &mut self,
        grant: &FolderSwitchGrant,
        lookups: &DefaultDirLookups<'_>,
    ) -> Result<FolderStatus, Error> {
        if self.has_unresolved_journal(grant.kind) {
            return Err(Error::FolderSwitch(FolderSwitchFailure::InterruptedMove));
        }
        match self.lookup_folder_switch_grant(grant)? {
            FolderSwitchGrantLookup::Replay(status) => Ok(status),
            FolderSwitchGrantLookup::Live {
                kind,
                source_root,
                source_identity,
                target_path,
                target_identity,
                target_display_name,
                target_expected_identity,
            } => {
                // Re-prove source root is still active and its live directory identity matches.
                if self.active_root_id_for_kind(kind).as_ref() != Some(&source_root) {
                    return Err(Error::FolderSwitch(FolderSwitchFailure::IdentityChanged));
                }
                let source_entry = self
                    .persistent
                    .get(&source_root.id)
                    .cloned()
                    .ok_or(Error::FolderSwitch(FolderSwitchFailure::IdentityChanged))?;
                if source_entry.stored.identity != source_identity {
                    return Err(Error::FolderSwitch(FolderSwitchFailure::IdentityChanged));
                }
                let source_path = source_entry
                    .stored
                    .path
                    .to_path()
                    .map_err(|_| Error::FolderSwitch(FolderSwitchFailure::IdentityChanged))?;
                let _source_dir =
                    open_verified_directory(&source_path, (source_identity.a, source_identity.b))
                        .map_err(|_| Error::FolderSwitch(FolderSwitchFailure::IdentityChanged))?;

                let target_acquired = acquire_target(
                    &target_path,
                    AcquireShape::Root {
                        parent_access: ParentAccess::Readable,
                    },
                )
                .map_err(|_| Error::FolderSwitch(FolderSwitchFailure::IdentityChanged))?;
                if target_acquired.identity != target_identity {
                    return Err(Error::FolderSwitch(FolderSwitchFailure::IdentityChanged));
                }
                let expected =
                    target_expected_identity.map(|id| VerifiedIdentity::from_pair((id.a, id.b)));
                self.activate_root_directly(
                    kind,
                    &target_acquired.path,
                    target_display_name,
                    expected,
                )?;
                let status = self.folder_status_for_kind(kind, lookups)?;
                self.mark_folder_switch_grant_committed(grant, status.clone());
                Ok(status)
            }
        }
    }

    /// Commits a completed move: ensures/reuses the target root entry (Step 1), then rebases
    /// every moved descendant entry in place keeping its `PathRef` id (re-observing live identity
    /// and parent identity at the destination), rewrites `catalog_installs` / `catalog_uses` for
    /// engines, switches the active root in one atomic registry replacement (Step 2), and marks
    /// the grant committed for replay.
    pub(crate) fn commit_folder_move(
        &mut self,
        grant: &FolderSwitchGrant,
        prepared: &PreparedFolderMove,
        moved_items: &[JournalItem],
        lookups: &DefaultDirLookups<'_>,
    ) -> Result<FolderStatus, Error> {
        #[cfg(test)]
        if take_test_fault(FolderSwitchTestFault::FailCommit) {
            return Err(Error::Io(Box::new(std::io::Error::other(
                "injected commit failure",
            ))));
        }
        let kind = prepared.kind;
        let expected_target = prepared
            .target_expected_identity
            .as_ref()
            .map(|id| VerifiedIdentity::from_pair((id.a, id.b)));

        // Step 1: ensure or reuse the target root entry in the registry by live identity.
        let target_root_id = match kind {
            FolderSwitchKind::Database => self
                .get_or_create_database_root(
                    &prepared.target_path,
                    prepared.target_display_name.clone(),
                    expected_target,
                )?
                .path_ref()
                .clone(),
            FolderSwitchKind::Engine => self
                .get_or_create_engine_root(
                    &prepared.target_path,
                    prepared.target_display_name.clone(),
                    expected_target,
                )?
                .path_ref()
                .clone(),
            FolderSwitchKind::Puzzle => self
                .get_or_create_puzzle_root(
                    &prepared.target_path,
                    prepared.target_display_name.clone(),
                    expected_target,
                )?
                .path_ref()
                .clone(),
        };

        let target_root_stored = self
            .persistent
            .get(&target_root_id.id)
            .ok_or_else(|| Error::Conflict("target root disappeared before commit".into()))?
            .stored
            .clone();

        // Build folded set of moved top-level leaves so foreign entries are untouched and
        // case/normalization variants still match on Windows and macOS.
        let moved_leaves_folded: HashSet<Vec<u8>> = moved_items
            .iter()
            .filter_map(|item| {
                item.leaf
                    .to_path()
                    .ok()
                    .map(|p| fold_leaf_name_for_collision(p.as_os_str()))
            })
            .collect();

        let mut candidate = self.persistent.clone();
        let mut identity_map: BTreeMap<(PathBuf, u64, u64), (PathBuf, u64, u64)> = BTreeMap::new();

        for entry in candidate.values_mut() {
            if entry.stored.id == prepared.source_root || entry.stored.id == target_root_id {
                continue;
            }
            let Ok(old_path) = entry.stored.path.to_path() else {
                continue;
            };
            let Some(rel) = relative_from_ancestor_identity(
                &old_path,
                entry.stored.parent_identity.as_ref(),
                prepared.source_identity,
            ) else {
                continue;
            };
            let Some(first_comp) = rel.components().next() else {
                continue;
            };
            if !moved_leaves_folded.contains(&fold_leaf_name_for_collision(first_comp.as_os_str()))
            {
                continue;
            }
            let new_path = prepared.target_path.join(&rel);
            let shape = AcquireShape::for_persistent_class(
                entry.stored.class,
                parent_access_for_operations(&entry.stored.operations),
            );
            let acquired = acquire_target(&new_path, shape)?;
            let old_key = (old_path, entry.stored.identity.a, entry.stored.identity.b);
            let new_val = (
                acquired.path.clone(),
                acquired.identity.a,
                acquired.identity.b,
            );
            identity_map.insert(old_key, new_val);

            entry.stored.path = NativePath::from_path(&acquired.path);
            entry.stored.identity = acquired.identity;
            entry.stored.parent_identity = acquired.parent_identity;
            entry.availability = PathAvailability::Available;
        }

        // For engines: rewrite catalog_installs and catalog_uses before committing.
        let prev_catalog_installs = self.catalog_installs.clone();
        let prev_catalog_uses = self.catalog_uses.clone();
        if kind == FolderSwitchKind::Engine {
            if let Err(error) = self.rebase_catalog_installs_for_move(
                Identity {
                    a: prepared.source_identity.0,
                    b: prepared.source_identity.1,
                },
                &target_root_stored,
                &moved_leaves_folded,
                &identity_map,
            ) {
                self.catalog_installs = prev_catalog_installs;
                self.catalog_uses = prev_catalog_uses;
                return Err(error);
            }
        }

        let (active_db, active_puzzle, active_engine) = match kind {
            FolderSwitchKind::Database => (
                Some(target_root_id.clone()),
                self.active_puzzle_root.clone(),
                self.active_engine_root.clone(),
            ),
            FolderSwitchKind::Puzzle => (
                self.active_database_root.clone(),
                Some(target_root_id.clone()),
                self.active_engine_root.clone(),
            ),
            FolderSwitchKind::Engine => (
                self.active_database_root.clone(),
                self.active_puzzle_root.clone(),
                Some(target_root_id.clone()),
            ),
        };

        let commit_result = self.commit_state(
            candidate,
            active_db,
            active_puzzle,
            active_engine,
            self.pending_artifacts.clone(),
            None,
        );
        if let Err(error) = commit_result {
            if kind == FolderSwitchKind::Engine {
                self.catalog_installs = prev_catalog_installs;
                self.catalog_uses = prev_catalog_uses;
            }
            return Err(error);
        }

        let status = self.folder_status_for_kind(kind, lookups)?;
        self.mark_folder_switch_grant_committed(grant, status.clone());
        Ok(status)
    }

    pub(crate) fn mark_unresolved_journal(&mut self, kind: FolderSwitchKind) {
        self.unresolved_journals.insert(kind);
    }
}

/// Rolls back a failed transfer or commit, settles the journal, disarms the backstop, and maps
/// the outcome to the appropriate closed `FolderSwitchFailure`.
fn settle_failed_move(
    authority: &SharedPathAuthority,
    phase: &str,
    primary: Error,
    journal: &mut FolderSwitchJournal,
    source_dir: &fs::File,
    target_dir: &fs::File,
    backstop: &mut MoveBackstopGuard,
) -> Error {
    let kind = journal.kind;
    let is_symlink_error = matches!(
        primary.unlabelled(),
        Error::FolderSwitch(FolderSwitchFailure::SymlinkInTree)
    );
    log::error!(
        "folder switch {phase} failed for {kind:?}: {}",
        primary.diagnostic()
    );
    match rollback_transfer(journal, source_dir, target_dir) {
        Ok(()) => {
            let _ = authority.with_mut(|auth| auth.remove_journal_file(kind));
            backstop.disarm();
            Error::FolderSwitch(if is_symlink_error {
                FolderSwitchFailure::SymlinkInTree
            } else {
                FolderSwitchFailure::TransferFailedRolledBack
            })
        }
        Err(rollback_err) => {
            log::error!(
                "folder switch rollback after {phase} failure incomplete for {kind:?}: primary={}; rollback={}",
                primary.diagnostic(),
                rollback_err.diagnostic()
            );
            let _ = authority.with_mut(|auth| {
                let _ = auth.write_journal_file(journal);
                auth.mark_unresolved_journal(kind);
            });
            backstop.disarm();
            Error::FolderSwitch(FolderSwitchFailure::RollbackIncomplete)
        }
    }
}

/// Executes the blocking preflight + journal + transfer + commit + cleanup phase of a folder move.
/// Caller holds the per-kind writer guard and all quiesce barriers (databases / engines / puzzles).
pub(crate) fn execute_folder_move_blocking(
    authority: &SharedPathAuthority,
    grant: &FolderSwitchGrant,
    prepared: &PreparedFolderMove,
    lookups: &DefaultDirLookups<'_>,
) -> Result<FolderStatus, Error> {
    // 1. Re-prove both directories and identities.
    let source_dir = open_verified_directory(&prepared.source_path, prepared.source_identity)
        .map_err(|_| Error::FolderSwitch(FolderSwitchFailure::IdentityChanged))?;
    let target_dir = open_verified_directory(&prepared.target_path, prepared.target_identity)
        .map_err(|_| Error::FolderSwitch(FolderSwitchFailure::IdentityChanged))?;

    // 2. Preflight: same folder, nested either way, target writable, enumerate + symlink check, collisions.
    if prepared.source_identity == prepared.target_identity {
        return Err(Error::FolderSwitch(FolderSwitchFailure::SameFolder));
    }
    let source_ancestors = ancestor_identities(&prepared.source_path)
        .map_err(|_| Error::FolderSwitch(FolderSwitchFailure::SourceUnreadable))?;
    let target_ancestors = ancestor_identities(&prepared.target_path)
        .map_err(|_| Error::FolderSwitch(FolderSwitchFailure::TargetUnwritable))?;
    if target_ancestors.contains(&prepared.source_identity)
        || source_ancestors.contains(&prepared.target_identity)
    {
        return Err(Error::FolderSwitch(FolderSwitchFailure::NestedFolders));
    }

    probe_target_writable(target_dir.as_file())?;

    let plan = authority.with_mut(|auth| {
        auth.enumerate_movable_for_kind(
            prepared.kind,
            source_dir.as_file(),
            prepared.source_identity,
        )
    })??;

    check_collisions(target_dir.as_file(), &plan.items)?;

    // 3. Decide TransferMode from opened-handle device/volume identity.
    #[cfg(test)]
    let force_copy = take_test_fault(FolderSwitchTestFault::ForceCopyMode);
    #[cfg(not(test))]
    let force_copy = false;

    let initial_mode = if !force_copy
        && same_volume_identities(prepared.source_identity, prepared.target_identity)
    {
        TransferMode::Rename
    } else {
        TransferMode::Copy
    };

    let mut journal = FolderSwitchJournal {
        version: JOURNAL_VERSION,
        kind: prepared.kind,
        grant_id: grant.id.id.clone(),
        mode: initial_mode,
        source_root_id: prepared.source_root.clone(),
        source_root_path: NativePath::from_path(&prepared.source_path),
        source_root_identity: Identity {
            a: prepared.source_identity.0,
            b: prepared.source_identity.1,
        },
        target_root_path: NativePath::from_path(&prepared.target_path),
        target_root_identity: Identity {
            a: prepared.target_identity.0,
            b: prepared.target_identity.1,
        },
        target_display_name: prepared.target_display_name.clone(),
        stage: JournalStage::Prepared,
        items: plan.items,
    };

    // 4. Write durable write-ahead journal BEFORE the first filesystem mutation.
    authority.with_mut(|auth| auth.write_journal_file(&journal))??;

    let mut backstop = MoveBackstopGuard::new(prepared.kind);

    // 5. Perform transfer.
    let transfer_result: Result<(), Error> = (|| {
        journal.stage = JournalStage::Transferring;
        let mut idx = 0usize;
        while idx < journal.items.len() {
            #[cfg(test)]
            if idx > 0 && take_test_fault(FolderSwitchTestFault::FailTransferAfterFirst) {
                return Err(Error::Io(Box::new(std::io::Error::other(
                    "injected transfer failure",
                ))));
            }
            let leaf_path = journal.items[idx].leaf.to_path()?;
            let leaf = leaf_path.as_os_str();
            let is_dir = journal.items[idx].is_dir;
            let expected_source = (
                journal.items[idx].source_identity.a,
                journal.items[idx].source_identity.b,
            );
            match journal.mode {
                TransferMode::Rename => {
                    #[cfg(test)]
                    let rename_res = if idx == 0
                        && take_test_fault(FolderSwitchTestFault::SimulateExdevOnFirstRename)
                    {
                        #[cfg(unix)]
                        let err = std::io::Error::from_raw_os_error(libc::EXDEV);
                        #[cfg(windows)]
                        let err = std::io::Error::from_raw_os_error(
                            windows_sys::Win32::Foundation::ERROR_NOT_SAME_DEVICE as i32,
                        );
                        Err(Error::Io(Box::new(err)))
                    } else {
                        rename_entry_at(
                            source_dir.as_file(),
                            leaf,
                            expected_source,
                            is_dir,
                            target_dir.as_file(),
                            leaf,
                        )
                    };
                    #[cfg(not(test))]
                    let rename_res = rename_entry_at(
                        source_dir.as_file(),
                        leaf,
                        expected_source,
                        is_dir,
                        target_dir.as_file(),
                        leaf,
                    );
                    match rename_res {
                        Ok(_outcome) => {
                            journal.items[idx].transferred = true;
                            journal.items[idx].target_identity =
                                Some(journal.items[idx].source_identity.clone());
                            authority.with_mut(|auth| auth.write_journal_file(&journal))??;
                            idx += 1;
                        }
                        Err(error) if idx == 0 && is_cross_device_error(&error) => {
                            // Cross-device fallback on first rename -> switch to verified Copy mode.
                            journal.mode = TransferMode::Copy;
                            authority.with_mut(|auth| auth.write_journal_file(&journal))??;
                            // Retry same idx in Copy mode.
                        }
                        Err(error) => return Err(error),
                    }
                }
                TransferMode::Copy => {
                    let mut record_created = |dest_id: (u64, u64)| -> Result<(), Error> {
                        journal.items[idx].target_identity = Some(Identity {
                            a: dest_id.0,
                            b: dest_id.1,
                        });
                        authority.with_mut(|auth| auth.write_journal_file(&journal))??;
                        Ok(())
                    };
                    let target_id = if is_dir {
                        copy_and_verify_tree_at(
                            source_dir.as_file(),
                            target_dir.as_file(),
                            leaf,
                            Some(expected_source),
                            0,
                            &mut record_created,
                        )?
                    } else {
                        copy_and_verify_file_at(
                            source_dir.as_file(),
                            target_dir.as_file(),
                            leaf,
                            Some(expected_source),
                            &mut record_created,
                        )?
                    };
                    journal.items[idx].transferred = true;
                    journal.items[idx].target_identity = Some(Identity {
                        a: target_id.0,
                        b: target_id.1,
                    });
                    authority.with_mut(|auth| auth.write_journal_file(&journal))??;
                    idx += 1;
                }
            }
        }

        // For copied databases, rebind `.ecsi` and `.integrity` headers before commit and persist
        // their new identities in the journal so rollback stays exact.
        if journal.mode == TransferMode::Copy && prepared.kind == FolderSwitchKind::Database {
            rebind_copied_database_sidecars(
                authority,
                source_dir.as_file(),
                target_dir.as_file(),
                &mut journal,
            )?;
        }
        Ok(())
    })();

    // If transfer failed, explicitly roll back in-process.
    if let Err(primary) = transfer_result {
        return Err(settle_failed_move(
            authority,
            "transfer",
            primary,
            &mut journal,
            source_dir.as_file(),
            target_dir.as_file(),
            &mut backstop,
        ));
    }

    // 6. Commit the rebased entries and active-root switch.
    #[cfg(test)]
    if prepared.kind == FolderSwitchKind::Engine
        && take_test_fault(FolderSwitchTestFault::CorruptCopiedEngineFileBeforeCommit)
    {
        if let Some(first_item) = journal.items.first() {
            if let Ok(leaf) = first_item.leaf.to_path() {
                let _ = fs::write(
                    prepared.target_path.join(leaf).join("nnue/net.nnue"),
                    b"corrupted-after-copy",
                );
            }
        }
    }
    let commit_result = authority
        .with_mut(|auth| auth.commit_folder_move(grant, prepared, &journal.items, lookups))?;

    let mut status = match commit_result {
        Ok(status) => status,
        Err(primary) => {
            return Err(settle_failed_move(
                authority,
                "registry commit",
                primary,
                &mut journal,
                source_dir.as_file(),
                target_dir.as_file(),
                &mut backstop,
            ));
        }
    };

    // 7. Post-commit cleanup.
    journal.stage = JournalStage::Committed;
    let _ = authority.with_mut(|auth| auth.write_journal_file(&journal));
    match cleanup_after_commit(&journal, source_dir, &prepared.source_path, lookups) {
        Ok(()) => {
            let _ = authority.with_mut(|auth| auth.remove_journal_file(prepared.kind));
        }
        Err(cleanup_err) => {
            log::warn!(
                "folder switch post-commit cleanup deferred to next startup for {:?}: {}",
                prepared.kind,
                cleanup_err.diagnostic()
            );
            if let Ok(Ok(updated)) = authority.with_mut(|auth| {
                auth.mark_unresolved_journal(prepared.kind);
                let updated = auth.folder_status_for_kind(prepared.kind, lookups)?;
                auth.mark_folder_switch_grant_committed(grant, updated.clone());
                Ok::<FolderStatus, Error>(updated)
            }) {
                status = updated;
            }
        }
    }
    backstop.disarm();
    Ok(status)
}
