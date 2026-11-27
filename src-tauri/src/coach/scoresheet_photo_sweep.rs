//! Background fail-closed mark-and-sweep for unreferenced scoresheet photos.
//!
//! Runs once per process after startup when the application-data instance lock is held, waits for
//! any startup database folder-switch migration gate, executes blocking I/O off the Tokio worker
//! pool via [`BLOCKING_GATEWAY`], and is cancelled cleanly on application exit.
//!
//! Mark sources:
//! - Library PGN files including the Library trash (`.en-croissant-trash`), enumerated
//!   descriptor-relative, no-follow, depth- and entry-bounded, with ASCII case-insensitive `.pgn`
//!   matching;
//! - Library databases' `ScoresheetPhotos` tables (absent table = no references), opened read-only
//!   through the bound SQLite database authority;
//! - Every PGN file, PGN workspace, database root, and database currently registered in
//!   [`PathAuthority`], opened through the authority rather than by stored pathname;
//! - Native workspace-session leaves (`<app_data>/workspace-session/`), decoded from
//!   `LZString.compressToUTF16(JSON)` or legacy plain JSON, reading `headers.other`.
//!
//! Fail-closed invariant: any unreadable or undecodable location, any skipped, quarantined, or
//! omitted session leaf, any unresolved database folder-switch journal, or any exceeded scan bound
//! (depth, entries, files, bytes) aborts the sweep with zero deletions and logs one abort line
//! naming the location class and error category.
//!
//! Known limit: a PGN copied outside Studio to a location Studio does not know keeps only the
//! reference; if every Studio-known copy is deleted, the photo is removed after the 24-hour grace
//! period.

use std::{
    collections::HashSet,
    ffi::OsStr,
    fmt,
    fs::File,
    io::Read,
    time::{Duration, SystemTime},
};

use rusqlite::{Connection, OpenFlags};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use super::scoresheet_photo_store::{
    is_valid_photo_id, lock_store, validate_scoresheet_photos_tag, MAX_SCORESHEET_PHOTOS_TAG_LEN,
    SCORESHEET_PHOTOS_TAG,
};
use crate::{
    db::bound_sqlite::{BoundDatabase, SqliteMode},
    error::{Error, ErrorCategory},
    infra::{
        blocking::BLOCKING_GATEWAY,
        fs::{
            is_atomic_temp_name, open_directory_at, open_regular_at, probe_regular_file_at,
            read_directory_entries_at, remove_atomic_temp_orphan_at, AtomicTempSweepOutcome,
            DirectoryEntryKind, RegularFileAccess,
        },
        path_authority::{
            open_existing_app_owned_default_dir, open_existing_visible_default_dir,
            opened_file_identity, with_app_default_lookups, AppDataDir, AppOwnedDefaultRoot,
            DatabaseFileTarget, DefaultDirLookups, FolderSwitchCoordinator, FolderSwitchKind,
            PathOperation, SharedPathAuthority, VisibleDefaultKind,
        },
    },
    workspace_session::{
        list_names_in, read_fixed_in, read_keys_in, WorkspaceSessionLeafState, QUARANTINE_PREFIX,
        WORKSPACE_SESSION_READ_MAX_KEYS,
    },
};

/// Grace period before an unmarked photo leaf is eligible for deletion (24 hours).
const PHOTO_SWEEP_GRACE: Duration = Duration::from_secs(24 * 60 * 60);
/// Minimum age before an unlocked `.atomic-<UUID>` temporary in the photo root is removed.
const ATOMIC_TEMP_ORPHAN_GRACE: Duration = Duration::from_secs(60);
/// Default read chunk size for streaming PGN scanning.
const PGN_SCAN_CHUNK_BYTES: usize = 64 * 1024;
/// Overlap window retained between PGN read chunks; must exceed the maximum valid tag line length.
const PGN_SCAN_OVERLAP_BYTES: usize = 1024;
const MAX_SCAN_DEPTH: usize = 32;
const MAX_SCAN_ENTRIES: usize = 65_536;
const MAX_SCAN_FILES: usize = 16_384;
const MAX_PGN_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TOTAL_PGN_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_PHOTO_SWEEP_ENTRIES: usize = 16_384;
const MAX_SESSION_DIR_ENTRIES: usize = 4_096;
const MAX_DECODED_SESSION_UTF16_UNITS: usize = 32 * 1024 * 1024;
const MAX_DECODED_SESSION_DICT_ENTRIES: usize = 1_048_576;
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(2);
const SWEEP_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
/// UTF-16 codepoint offset added by `LZString.compressToUTF16` (0x20, ASCII space).
const LZ_UTF16_CODE_OFFSET: u16 = 32;
/// Upper bound on LZW bit width before failing closed with `ResourceLimit`.
const LZ_MAX_CODE_BITS: u32 = 24;

/// Scan bounds varied in tests; hitting any bound aborts fail-closed with zero deletions.
#[derive(Clone, Copy, Debug)]
struct SweepLimits {
    pgn_chunk_bytes: usize,
    pgn_overlap_bytes: usize,
    max_scan_depth: usize,
    max_scan_entries: usize,
    max_scan_files: usize,
    max_pgn_file_bytes: u64,
    max_total_pgn_bytes: u64,
    max_photo_entries: usize,
}

impl Default for SweepLimits {
    fn default() -> Self {
        Self {
            pgn_chunk_bytes: PGN_SCAN_CHUNK_BYTES,
            pgn_overlap_bytes: PGN_SCAN_OVERLAP_BYTES,
            max_scan_depth: MAX_SCAN_DEPTH,
            max_scan_entries: MAX_SCAN_ENTRIES,
            max_scan_files: MAX_SCAN_FILES,
            max_pgn_file_bytes: MAX_PGN_FILE_BYTES,
            max_total_pgn_bytes: MAX_TOTAL_PGN_BYTES,
            max_photo_entries: MAX_PHOTO_SWEEP_ENTRIES,
        }
    }
}

/// Location class reported in the single abort log line when the sweep fails closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SweepLocation {
    Lifecycle,
    Authority,
    LibraryPgn,
    LibraryDatabase,
    RegisteredPgn,
    RegisteredDatabase,
    WorkspaceSession,
    PhotoStore,
}

impl fmt::Display for SweepLocation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Lifecycle => f.write_str("lifecycle"),
            Self::Authority => f.write_str("authority"),
            Self::LibraryPgn => f.write_str("library_pgn"),
            Self::LibraryDatabase => f.write_str("library_database"),
            Self::RegisteredPgn => f.write_str("registered_pgn"),
            Self::RegisteredDatabase => f.write_str("registered_database"),
            Self::WorkspaceSession => f.write_str("workspace_session"),
            Self::PhotoStore => f.write_str("photo_store"),
        }
    }
}

/// Fail-closed abort reason carrying only a closed location class and error category (no paths).
/// When cancellation occurs mid-deletion inside the photo store after one or more removals,
/// `partial` records the real counts deleted before stopping.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SweepAbort {
    location: SweepLocation,
    category: ErrorCategory,
    partial: Option<SweepSummary>,
}

impl SweepAbort {
    fn new(location: SweepLocation, category: ErrorCategory) -> Self {
        Self {
            location,
            category,
            partial: None,
        }
    }

    fn from_error(location: SweepLocation, error: &Error) -> Self {
        Self {
            location,
            category: error.category(),
            partial: None,
        }
    }

    fn cancelled_in_photo_store(summary: SweepSummary) -> Self {
        let partial = (summary.deleted > 0 || summary.temps_removed > 0).then_some(summary);
        Self {
            location: SweepLocation::PhotoStore,
            category: ErrorCategory::Cancellation,
            partial,
        }
    }

    fn log_message(&self) -> String {
        match self.partial {
            Some(summary) => format!(
                "scoresheet photo sweep aborted at {}: {} (partial: marked={}, deleted={}, kept={}, temps_removed={}, errors={})",
                self.location,
                self.category,
                summary.marked,
                summary.deleted,
                summary.kept,
                summary.temps_removed,
                summary.errors,
            ),
            None => format!(
                "scoresheet photo sweep aborted at {}: {} (zero deletions)",
                self.location, self.category,
            ),
        }
    }
}

/// Counters logged once when a sweep completes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct SweepSummary {
    marked: usize,
    deleted: usize,
    kept: usize,
    temps_removed: usize,
    errors: usize,
}

/// Owned handle for the once-per-process background scoresheet photo sweep.
/// Disabled when `app_data_locked` is false; cancelled and joined on application exit.
pub(crate) struct ScoresheetPhotoSweep(Option<SweepOwner>);

struct SweepOwner {
    cancellation: CancellationToken,
    task: AsyncMutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl ScoresheetPhotoSweep {
    /// Starts the background sweep once when the application-data instance lock is held.
    /// Returns an inactive handle without spawning anything when `app_data_locked` is false.
    pub(crate) fn start<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        authority: SharedPathAuthority,
        folder_switch: FolderSwitchCoordinator,
        app_data_locked: bool,
    ) -> Self {
        if !app_data_locked {
            return Self(None);
        }
        let app_handle = app.clone();
        Self::spawn_with_runner(folder_switch, move |token| {
            let app_data = match AppDataDir::for_app(&app_handle) {
                Ok(data) => data,
                Err(error) => {
                    return Err(SweepAbort::from_error(SweepLocation::PhotoStore, &error));
                }
            };
            match with_app_default_lookups(&app_handle, |lookups| {
                Ok(run_sweep(
                    &app_data,
                    lookups,
                    &authority,
                    SystemTime::now(),
                    &SweepLimits::default(),
                    token,
                ))
            }) {
                Ok(inner) => inner,
                Err(error) => Err(SweepAbort::from_error(SweepLocation::Authority, &error)),
            }
        })
    }

    fn spawn_with_runner<F>(folder_switch: FolderSwitchCoordinator, runner: F) -> Self
    where
        F: FnOnce(&CancellationToken) -> Result<SweepSummary, SweepAbort> + Send + 'static,
    {
        let cancellation = CancellationToken::new();
        let task_token = cancellation.clone();
        let handle = tauri::async_runtime::spawn(async move {
            if let Err(error) = folder_switch
                .wait_for_migration(FolderSwitchKind::Database, Some(&task_token))
                .await
            {
                log::warn!(
                    "scoresheet photo sweep aborted at {}: {} (zero deletions)",
                    SweepLocation::LibraryDatabase,
                    error.category()
                );
                return;
            }
            let outcome = BLOCKING_GATEWAY
                .spawn_cancellable(task_token, move |token| Ok(runner(token)))
                .await;

            match outcome {
                Ok(Ok(summary)) => {
                    log::info!(
                        "scoresheet photo sweep finished: marked={}, deleted={}, kept={}, temps_removed={}, errors={}",
                        summary.marked,
                        summary.deleted,
                        summary.kept,
                        summary.temps_removed,
                        summary.errors
                    );
                }
                Ok(Err(abort)) => {
                    log::warn!("{}", abort.log_message());
                }
                Err(error) => {
                    log::warn!(
                        "scoresheet photo sweep aborted at {}: {} (zero deletions)",
                        SweepLocation::Lifecycle,
                        error.category()
                    );
                }
            }
        });
        Self(Some(SweepOwner {
            cancellation,
            task: AsyncMutex::new(Some(handle)),
        }))
    }

    /// Cancels the background sweep and waits up to [`SWEEP_SHUTDOWN_TIMEOUT`] for it to exit.
    pub(crate) async fn shutdown(&self) {
        let Some(owner) = &self.0 else {
            return;
        };
        owner.cancellation.cancel();
        let handle = owner.task.lock().await.take();
        if let Some(handle) = handle {
            let _ = tokio::time::timeout(SWEEP_SHUTDOWN_TIMEOUT, handle).await;
        }
    }
}

struct ScanCounters {
    entries: usize,
    files: usize,
    pgn_bytes: u64,
    visited_dirs: HashSet<(u64, u64)>,
    visited_pgns: HashSet<(u64, u64)>,
    visited_dbs: HashSet<(u64, u64)>,
}

impl ScanCounters {
    fn new() -> Self {
        Self {
            entries: 0,
            files: 0,
            pgn_bytes: 0,
            visited_dirs: HashSet::new(),
            visited_pgns: HashSet::new(),
            visited_dbs: HashSet::new(),
        }
    }

    fn count_file(
        &mut self,
        location: SweepLocation,
        limits: &SweepLimits,
    ) -> Result<(), SweepAbort> {
        if self.files >= limits.max_scan_files {
            return Err(SweepAbort::new(location, ErrorCategory::ResourceLimit));
        }
        self.files += 1;
        Ok(())
    }
}

fn check_cancelled(
    location: SweepLocation,
    cancellation: &CancellationToken,
) -> Result<(), SweepAbort> {
    if cancellation.is_cancelled() {
        return Err(SweepAbort::new(location, ErrorCategory::Cancellation));
    }
    Ok(())
}

fn has_ascii_extension(name: &OsStr, expected: &str) -> bool {
    let Some(text) = name.to_str() else {
        return false;
    };
    let Some((_, ext)) = text.rsplit_once('.') else {
        return false;
    };
    ext.eq_ignore_ascii_case(expected)
}

fn mark_tag_value(raw: &str, marked: &mut HashSet<String>) {
    if let Some(valid) = validate_scoresheet_photos_tag(raw) {
        for id in valid.split(',') {
            marked.insert(id.to_owned());
        }
    }
}

/// Runs the complete mark-and-sweep synchronously using an injected `now` and explicit `limits`.
/// Returns `Err(SweepAbort)` with zero deletions if any mark source fails or hits a bound.
fn run_sweep(
    app_data: &AppDataDir,
    lookups: &DefaultDirLookups<'_>,
    authority: &SharedPathAuthority,
    now: SystemTime,
    limits: &SweepLimits,
    cancellation: &CancellationToken,
) -> Result<SweepSummary, SweepAbort> {
    check_cancelled(SweepLocation::Authority, cancellation)?;

    let mut marked = HashSet::new();
    let mut counters = ScanCounters::new();

    // Snapshot registered handles from PathAuthority without holding its lock during I/O.
    let snapshot = authority
        .with_mut(|auth| auth.photo_sweep_snapshot())
        .map_err(|error| SweepAbort::from_error(SweepLocation::Authority, &Error::from(error)))?
        .map_err(|error| SweepAbort::from_error(SweepLocation::Authority, &error))?;

    // 1. Default Library PGN root (absent = no references; unreadable = abort).
    if let Some(default_pgn_dir) =
        open_existing_visible_default_dir(lookups, VisibleDefaultKind::Pgn)
            .map_err(|error| SweepAbort::from_error(SweepLocation::LibraryPgn, &error))?
    {
        scan_pgn_directory_tree(
            default_pgn_dir.descriptor(),
            default_pgn_dir.identity().pair(),
            0,
            &mut marked,
            &mut counters,
            limits,
            cancellation,
        )?;
    }

    // 2. Registered Library PGN workspaces (including their .en-croissant-trash directories).
    for workspace in &snapshot.pgn_workspaces {
        check_cancelled(SweepLocation::LibraryPgn, cancellation)?;
        let dir = authority
            .with_mut(|auth| auth.open_pgn_workspace_for_sweep(workspace))
            .map_err(|error| {
                SweepAbort::from_error(SweepLocation::LibraryPgn, &Error::from(error))
            })?
            .map_err(|error| SweepAbort::from_error(SweepLocation::LibraryPgn, &error))?;
        scan_pgn_directory_tree(
            dir.descriptor(),
            dir.identity(),
            0,
            &mut marked,
            &mut counters,
            limits,
            cancellation,
        )?;
    }

    // 3. Registered individual PGN files, opened through PathAuthority.
    for handle in &snapshot.pgn_files {
        check_cancelled(SweepLocation::RegisteredPgn, cancellation)?;
        let pgn = authority
            .with_mut(|auth| {
                auth.resolve(handle.path_ref(), PathOperation::ReadPgn, &[])?
                    .pgn_snapshot()
            })
            .map_err(|error| {
                SweepAbort::from_error(SweepLocation::RegisteredPgn, &Error::from(error))
            })?
            .map_err(|error| SweepAbort::from_error(SweepLocation::RegisteredPgn, &error))?;
        let pgn_identity = opened_file_identity(&pgn.file)
            .map_err(|error| SweepAbort::from_error(SweepLocation::RegisteredPgn, &error))?;
        if !counters.visited_pgns.insert(pgn_identity) {
            continue;
        }
        counters.count_file(SweepLocation::RegisteredPgn, limits)?;
        let mut file = pgn.file;
        scan_pgn_reader(
            &mut file,
            &mut marked,
            &mut counters.pgn_bytes,
            limits,
            cancellation,
        )
        .map_err(|error| SweepAbort::from_error(SweepLocation::RegisteredPgn, &error))?;
    }

    // 4. Library database roots: visible default, legacy app-data default, and registered roots.
    let mut visited_db_roots = HashSet::new();
    if let Some(default_db_dir) =
        open_existing_visible_default_dir(lookups, VisibleDefaultKind::Databases)
            .map_err(|error| SweepAbort::from_error(SweepLocation::LibraryDatabase, &error))?
    {
        if visited_db_roots.insert(default_db_dir.identity().pair()) {
            scan_database_directory(
                default_db_dir.descriptor(),
                |leaf| default_db_dir.database_target(leaf),
                &mut marked,
                &mut counters,
                limits,
                cancellation,
            )?;
        }
    }
    if let Some(legacy_db_dir) =
        open_existing_app_owned_default_dir(app_data, AppOwnedDefaultRoot::Databases, false)
            .map_err(|error| SweepAbort::from_error(SweepLocation::LibraryDatabase, &error))?
    {
        if visited_db_roots.insert(legacy_db_dir.identity().pair()) {
            scan_database_directory(
                legacy_db_dir.descriptor(),
                |leaf| legacy_db_dir.database_target(leaf),
                &mut marked,
                &mut counters,
                limits,
                cancellation,
            )?;
        }
    }
    for root in &snapshot.database_roots {
        check_cancelled(SweepLocation::LibraryDatabase, cancellation)?;
        let dir = authority
            .with_mut(|auth| auth.open_database_root_for_sweep(root))
            .map_err(|error| {
                SweepAbort::from_error(SweepLocation::LibraryDatabase, &Error::from(error))
            })?
            .map_err(|error| SweepAbort::from_error(SweepLocation::LibraryDatabase, &error))?;
        if visited_db_roots.insert(dir.identity()) {
            scan_database_directory(
                dir.descriptor(),
                |leaf| dir.database_target(leaf),
                &mut marked,
                &mut counters,
                limits,
                cancellation,
            )?;
        }
    }

    // 5. Registered individual databases, opened through PathAuthority.
    for handle in &snapshot.database_files {
        check_cancelled(SweepLocation::RegisteredDatabase, cancellation)?;
        let target = authority
            .with_mut(|auth| auth.database_file_target(handle, PathOperation::DatabaseRead))
            .map_err(|error| {
                SweepAbort::from_error(SweepLocation::RegisteredDatabase, &Error::from(error))
            })?
            .map_err(|error| SweepAbort::from_error(SweepLocation::RegisteredDatabase, &error))?;
        if !counters.visited_dbs.insert(target.identity()) {
            continue;
        }
        counters.count_file(SweepLocation::RegisteredDatabase, limits)?;
        scan_database_target(
            &target,
            SweepLocation::RegisteredDatabase,
            &mut marked,
            cancellation,
        )?;
    }

    // 6. Native workspace-session leaves (open and restorable tabs).
    scan_workspace_session(app_data, &mut marked, cancellation)?;

    // 7. Sweep phase: only reached when every mark source completed cleanly.
    sweep_photo_root(app_data, &marked, now, limits, cancellation)
}

fn scan_pgn_directory_tree(
    dir: &File,
    dir_identity: (u64, u64),
    depth: usize,
    marked: &mut HashSet<String>,
    counters: &mut ScanCounters,
    limits: &SweepLimits,
    cancellation: &CancellationToken,
) -> Result<(), SweepAbort> {
    check_cancelled(SweepLocation::LibraryPgn, cancellation)?;
    if depth > limits.max_scan_depth {
        return Err(SweepAbort::new(
            SweepLocation::LibraryPgn,
            ErrorCategory::ResourceLimit,
        ));
    }
    if !counters.visited_dirs.insert(dir_identity) {
        return Ok(());
    }
    let remaining_entries = limits.max_scan_entries.saturating_sub(counters.entries);
    let entries =
        read_directory_entries_at(dir, cancellation, Some(remaining_entries), &mut |_| true)
            .map_err(|error| SweepAbort::from_error(SweepLocation::LibraryPgn, &error))?;
    counters.entries = counters.entries.saturating_add(entries.len());

    for entry in entries {
        check_cancelled(SweepLocation::LibraryPgn, cancellation)?;
        match entry.kind {
            DirectoryEntryKind::Directory => {
                let child = open_directory_at(dir, &entry.name, false)
                    .map_err(|error| SweepAbort::from_error(SweepLocation::LibraryPgn, &error))?;
                let child_identity = opened_file_identity(&child)
                    .map_err(|error| SweepAbort::from_error(SweepLocation::LibraryPgn, &error))?;
                scan_pgn_directory_tree(
                    &child,
                    child_identity,
                    depth + 1,
                    marked,
                    counters,
                    limits,
                    cancellation,
                )?;
            }
            DirectoryEntryKind::RegularFile => {
                if !has_ascii_extension(&entry.name, "pgn") {
                    continue;
                }
                let mut file = open_regular_at(dir, &entry.name, RegularFileAccess::ReadOnly)
                    .map_err(|error| SweepAbort::from_error(SweepLocation::LibraryPgn, &error))?;
                let file_identity = opened_file_identity(&file)
                    .map_err(|error| SweepAbort::from_error(SweepLocation::LibraryPgn, &error))?;
                if !counters.visited_pgns.insert(file_identity) {
                    continue;
                }
                counters.count_file(SweepLocation::LibraryPgn, limits)?;
                scan_pgn_reader(
                    &mut file,
                    marked,
                    &mut counters.pgn_bytes,
                    limits,
                    cancellation,
                )
                .map_err(|error| SweepAbort::from_error(SweepLocation::LibraryPgn, &error))?;
            }
            // Symlinks, FIFOs, sockets, etc. are never followed or opened by Studio.
            DirectoryEntryKind::Other => {}
        }
    }
    Ok(())
}

fn scan_database_directory(
    dir: &File,
    mut target_for: impl FnMut(&OsStr) -> Result<DatabaseFileTarget, Error>,
    marked: &mut HashSet<String>,
    counters: &mut ScanCounters,
    limits: &SweepLimits,
    cancellation: &CancellationToken,
) -> Result<(), SweepAbort> {
    check_cancelled(SweepLocation::LibraryDatabase, cancellation)?;
    let remaining_entries = limits.max_scan_entries.saturating_sub(counters.entries);
    let entries =
        read_directory_entries_at(dir, cancellation, Some(remaining_entries), &mut |_| true)
            .map_err(|error| SweepAbort::from_error(SweepLocation::LibraryDatabase, &error))?;
    counters.entries = counters.entries.saturating_add(entries.len());

    for entry in entries {
        check_cancelled(SweepLocation::LibraryDatabase, cancellation)?;
        if entry.kind != DirectoryEntryKind::RegularFile || !has_ascii_extension(&entry.name, "db3")
        {
            continue;
        }
        let target = target_for(&entry.name)
            .map_err(|error| SweepAbort::from_error(SweepLocation::LibraryDatabase, &error))?;
        if !counters.visited_dbs.insert(target.identity()) {
            continue;
        }
        counters.count_file(SweepLocation::LibraryDatabase, limits)?;
        scan_database_target(
            &target,
            SweepLocation::LibraryDatabase,
            marked,
            cancellation,
        )?;
    }
    Ok(())
}

fn scan_database_target(
    target: &DatabaseFileTarget,
    location: SweepLocation,
    marked: &mut HashSet<String>,
    cancellation: &CancellationToken,
) -> Result<(), SweepAbort> {
    check_cancelled(location, cancellation)?;
    let binding =
        BoundDatabase::acquire(target).map_err(|error| SweepAbort::from_error(location, &error))?;
    let lifetime = binding
        .connection_lifetime()
        .map_err(|error| SweepAbort::from_error(location, &error))?;
    let uri = binding
        .uri(SqliteMode::ReadOnly)
        .map_err(|error| SweepAbort::from_error(location, &error))?;
    let db_abort = |_| SweepAbort::new(location, ErrorCategory::Database);
    let conn = lifetime.wrap(
        Connection::open_with_flags(
            uri,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(db_abort)?,
    );
    conn.busy_timeout(SQLITE_BUSY_TIMEOUT).map_err(db_abort)?;

    let table_exists: bool = {
        let mut stmt = conn
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ScoresheetPhotos' LIMIT 1",
            )
            .map_err(db_abort)?;
        let mut rows = stmt.query([]).map_err(db_abort)?;
        rows.next().map_err(db_abort)?.is_some()
    };
    if !table_exists {
        return Ok(());
    }

    let mut stmt = conn
        .prepare("SELECT Photos FROM ScoresheetPhotos")
        .map_err(db_abort)?;
    let mut rows = stmt.query([]).map_err(db_abort)?;
    while let Some(row) = rows.next().map_err(db_abort)? {
        check_cancelled(location, cancellation)?;
        let raw: String = row.get(0).map_err(db_abort)?;
        mark_tag_value(&raw, marked);
    }
    Ok(())
}

/// Streams a PGN reader in bounded chunks with an overlap window at least the maximum tag-line
/// length, extracting valid `ScoresheetPhotos` tags regardless of BOM, CRLF, multi-tag lines,
/// or spacing around the tag name and value.
fn scan_pgn_reader(
    reader: &mut impl Read,
    marked: &mut HashSet<String>,
    total_bytes: &mut u64,
    limits: &SweepLimits,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    let chunk_size = limits.pgn_chunk_bytes.max(1);
    let overlap = limits.pgn_overlap_bytes;
    let mut read_buf = vec![0u8; chunk_size];
    let mut window = Vec::with_capacity(overlap.saturating_add(chunk_size));
    let mut file_bytes = 0u64;

    loop {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let read = reader.read(&mut read_buf)?;
        if read == 0 {
            break;
        }
        let read_u64 = read as u64;
        file_bytes = file_bytes.saturating_add(read_u64);
        *total_bytes = total_bytes.saturating_add(read_u64);
        if file_bytes > limits.max_pgn_file_bytes || *total_bytes > limits.max_total_pgn_bytes {
            return Err(Error::ResourceLimit("PGN scan exceeded byte limit".into()));
        }

        window.extend_from_slice(&read_buf[..read]);
        extract_pgn_tags_from_slice(&window, marked);

        if window.len() > overlap {
            let drain_len = window.len() - overlap;
            window.drain(..drain_len);
        }
    }
    Ok(())
}

/// Leniently matches `[` + optional whitespace + `ScoresheetPhotos` + optional whitespace + `"`
/// followed by a validated tag value, `"`, optional whitespace, and `]` anywhere in `slice`.
///
/// Marking is intentionally lenient (matching every layout accepted by `pgn-reader` / `parsePGN`):
/// a false positive only keeps a photo, whereas a false negative deletes user data.
fn extract_pgn_tags_from_slice(slice: &[u8], marked: &mut HashSet<String>) {
    let tag = SCORESHEET_PHOTOS_TAG.as_bytes();
    let tag_len = tag.len();
    let mut cursor = 0usize;

    while cursor + tag_len <= slice.len() {
        let Some(rel) = slice[cursor..]
            .windows(tag_len)
            .position(|window| window == tag)
        else {
            break;
        };
        let pos = cursor + rel;
        cursor = pos + tag_len;

        // Walk backward over optional horizontal whitespace before the tag name; require '['.
        let mut before = pos;
        while before > 0 && matches!(slice[before - 1], b' ' | b'\t') {
            before -= 1;
        }
        if before == 0 || slice[before - 1] != b'[' {
            continue;
        }

        // Walk forward over optional horizontal whitespace after the tag name; require '"'.
        let mut after = pos + tag_len;
        while after < slice.len() && matches!(slice[after], b' ' | b'\t') {
            after += 1;
        }
        if after >= slice.len() || slice[after] != b'"' {
            continue;
        }
        let value_start = after + 1;
        // Include `+ 1` so the closing '"' of a full 4-photo (259-byte) value sits inside the slice.
        let max_quote_end = value_start
            .saturating_add(MAX_SCORESHEET_PHOTOS_TAG_LEN)
            .saturating_add(1)
            .min(slice.len());
        let Some(rel_quote) = slice[value_start..max_quote_end]
            .iter()
            .position(|byte| *byte == b'"')
        else {
            continue;
        };
        let value_end = value_start + rel_quote;
        let mut closing = value_end + 1;
        while closing < slice.len() && matches!(slice[closing], b' ' | b'\t') {
            closing += 1;
        }
        if closing >= slice.len() || slice[closing] != b']' {
            continue;
        }
        if let Ok(raw) = std::str::from_utf8(&slice[value_start..value_end]) {
            mark_tag_value(raw, marked);
        }
    }
}

fn scan_workspace_session(
    app_data: &AppDataDir,
    marked: &mut HashSet<String>,
    cancellation: &CancellationToken,
) -> Result<(), SweepAbort> {
    check_cancelled(SweepLocation::WorkspaceSession, cancellation)?;
    let Some(session_dir) =
        open_existing_app_owned_default_dir(app_data, AppOwnedDefaultRoot::WorkspaceSession, false)
            .map_err(|error| SweepAbort::from_error(SweepLocation::WorkspaceSession, &error))?
    else {
        return Ok(());
    };

    // Fail closed if any quarantine bucket exists in workspace-session/.
    let dir_entries = read_directory_entries_at(
        session_dir.descriptor(),
        cancellation,
        Some(MAX_SESSION_DIR_ENTRIES),
        &mut |_| true,
    )
    .map_err(|error| SweepAbort::from_error(SweepLocation::WorkspaceSession, &error))?;
    if dir_entries.iter().any(|entry| {
        entry
            .name
            .to_str()
            .is_some_and(|name| name.starts_with(QUARANTINE_PREFIX))
    }) {
        return Err(SweepAbort::new(
            SweepLocation::WorkspaceSession,
            ErrorCategory::Conflict,
        ));
    }

    // Fail closed if fixed session leaves are unreadable/skipped.
    let fixed = read_fixed_in(&session_dir)
        .map_err(|error| SweepAbort::from_error(SweepLocation::WorkspaceSession, &error))?;
    if matches!(fixed.workspace, WorkspaceSessionLeafState::Skipped { .. })
        || matches!(fixed.page_tabs, WorkspaceSessionLeafState::Skipped { .. })
    {
        return Err(SweepAbort::new(
            SweepLocation::WorkspaceSession,
            ErrorCategory::Conflict,
        ));
    }

    // List all UUID tree leaves; any omitted count fails closed.
    let listing = list_names_in(&session_dir)
        .map_err(|error| SweepAbort::from_error(SweepLocation::WorkspaceSession, &error))?;
    if listing.omitted > 0 {
        return Err(SweepAbort::new(
            SweepLocation::WorkspaceSession,
            ErrorCategory::ResourceLimit,
        ));
    }

    for chunk in listing.names.chunks(WORKSPACE_SESSION_READ_MAX_KEYS) {
        check_cancelled(SweepLocation::WorkspaceSession, cancellation)?;
        let entries = read_keys_in(&session_dir, chunk)
            .map_err(|error| SweepAbort::from_error(SweepLocation::WorkspaceSession, &error))?;
        for entry in entries {
            check_cancelled(SweepLocation::WorkspaceSession, cancellation)?;
            match entry.state {
                WorkspaceSessionLeafState::Record { content } => {
                    let value = decode_session_leaf_json(
                        &content,
                        MAX_DECODED_SESSION_UTF16_UNITS,
                        MAX_DECODED_SESSION_DICT_ENTRIES,
                    )
                    .map_err(|category| {
                        SweepAbort::new(SweepLocation::WorkspaceSession, category)
                    })?;
                    extract_photos_from_session_json(&value, marked);
                }
                WorkspaceSessionLeafState::Skipped { .. } | WorkspaceSessionLeafState::Absent => {
                    return Err(SweepAbort::new(
                        SweepLocation::WorkspaceSession,
                        ErrorCategory::Conflict,
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Decodes a workspace-session leaf from `LZString.compressToUTF16(JSON)` first, falling back to
/// legacy plain JSON (matching `decodeCompressedOrJson` in `src/state/store/debouncedStorage.ts`).
/// Returns `Err(ErrorCategory)` when the leaf is empty, undecodable, exceeds bounds, or is not a
/// JSON object.
fn decode_session_leaf_json(
    stored: &str,
    max_utf16_units: usize,
    max_dict_entries: usize,
) -> Result<serde_json::Value, ErrorCategory> {
    if stored.is_empty() {
        return Err(ErrorCategory::InvalidInput);
    }
    match lz_decompress_utf16(stored, max_utf16_units, max_dict_entries) {
        Ok(json) => {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) {
                if value.is_object() {
                    return Ok(value);
                }
            }
        }
        Err(ErrorCategory::ResourceLimit) => return Err(ErrorCategory::ResourceLimit),
        Err(_) => {}
    }
    match serde_json::from_str::<serde_json::Value>(stored) {
        Ok(value) if value.is_object() => Ok(value),
        _ => Err(ErrorCategory::InvalidInput),
    }
}

fn extract_photos_from_session_json(value: &serde_json::Value, marked: &mut HashSet<String>) {
    let headers = value
        .get("state")
        .and_then(|state| state.get("headers"))
        .or_else(|| value.get("headers"));
    let Some(raw) = headers
        .and_then(|headers| headers.get("other"))
        .and_then(|other| other.get(SCORESHEET_PHOTOS_TAG))
        .and_then(serde_json::Value::as_str)
    else {
        return;
    };
    mark_tag_value(raw, marked);
}

/// Pure-Rust port of `LZString.decompressFromUTF16` (lz-string 1.4.5) with explicit output and
/// dictionary bounds so malformed or adversarial inputs fail closed without panicking.
fn lz_decompress_utf16(
    compressed: &str,
    max_utf16_units: usize,
    max_dict_entries: usize,
) -> Result<String, ErrorCategory> {
    if compressed.is_empty() {
        return Err(ErrorCategory::InvalidInput);
    }
    struct BitReader<'a> {
        units: &'a [u16],
        val: u32,
        position: u32,
        index: usize,
    }

    impl<'a> BitReader<'a> {
        const RESET_VALUE: u32 = 16_384; // 1 << 14 (15 bits per UTF-16 char)

        fn new(units: &'a [u16]) -> Result<Self, ErrorCategory> {
            let first = Self::unit_val(units, 0)?;
            Ok(Self {
                units,
                val: first,
                position: Self::RESET_VALUE,
                index: 1,
            })
        }

        fn unit_val(units: &[u16], idx: usize) -> Result<u32, ErrorCategory> {
            let unit = *units.get(idx).ok_or(ErrorCategory::InvalidInput)?;
            Ok(u32::from(
                unit.checked_sub(LZ_UTF16_CODE_OFFSET)
                    .ok_or(ErrorCategory::InvalidInput)?,
            ))
        }

        fn exhausted(&self) -> bool {
            self.index > self.units.len()
        }

        fn read_bits(&mut self, num_bits: u32) -> Result<u32, ErrorCategory> {
            let mut bits: u32 = 0;
            for shift in 0..num_bits {
                let resb = self.val & self.position;
                self.position >>= 1;
                if self.position == 0 {
                    self.position = Self::RESET_VALUE;
                    if self.index < self.units.len() {
                        self.val = Self::unit_val(self.units, self.index)?;
                        self.index += 1;
                    } else {
                        // Matches lz-string.js: reading past the final char on the EOS bits yields
                        // 0 and increments index; the main loop checks `exhausted()`.
                        self.val = 0;
                        self.index = self.index.saturating_add(1);
                    }
                }
                if resb != 0 {
                    bits |= 1u32 << shift;
                }
            }
            Ok(bits)
        }
    }

    let units: Vec<u16> = compressed.encode_utf16().collect();
    let mut reader = BitReader::new(&units)?;

    let mut dictionary: Vec<Vec<u16>> = vec![Vec::new(), Vec::new(), Vec::new()];
    let mut enlarge_in: usize = 4;
    let mut num_bits: u32 = 3;

    let first_code = reader.read_bits(2)?;
    let first_char: u16 = match first_code {
        0 => reader.read_bits(8)? as u16,
        1 => reader.read_bits(16)? as u16,
        2 => return Ok(String::new()),
        _ => return Err(ErrorCategory::InvalidInput),
    };

    if max_utf16_units == 0 || max_dict_entries < 4 {
        return Err(ErrorCategory::ResourceLimit);
    }
    let mut w: Vec<u16> = vec![first_char];
    dictionary.push(w.clone());
    let mut result: Vec<u16> = vec![first_char];

    loop {
        if reader.exhausted() {
            return Err(ErrorCategory::InvalidInput);
        }
        let mut code = reader.read_bits(num_bits)? as usize;
        match code {
            0 => {
                let ch = reader.read_bits(8)? as u16;
                if dictionary.len() >= max_dict_entries {
                    return Err(ErrorCategory::ResourceLimit);
                }
                dictionary.push(vec![ch]);
                code = dictionary.len() - 1;
                enlarge_in -= 1;
            }
            1 => {
                let ch = reader.read_bits(16)? as u16;
                if dictionary.len() >= max_dict_entries {
                    return Err(ErrorCategory::ResourceLimit);
                }
                dictionary.push(vec![ch]);
                code = dictionary.len() - 1;
                enlarge_in -= 1;
            }
            2 => {
                return String::from_utf16(&result).map_err(|_| ErrorCategory::InvalidInput);
            }
            _ => {}
        }

        if enlarge_in == 0 {
            enlarge_in = 1usize
                .checked_shl(num_bits)
                .ok_or(ErrorCategory::ResourceLimit)?;
            num_bits = num_bits
                .checked_add(1)
                .ok_or(ErrorCategory::ResourceLimit)?;
            if num_bits > LZ_MAX_CODE_BITS {
                return Err(ErrorCategory::ResourceLimit);
            }
        }

        let entry = if code >= 3 && code < dictionary.len() {
            dictionary[code].clone()
        } else if code == dictionary.len() {
            let Some(&first) = w.first() else {
                return Err(ErrorCategory::InvalidInput);
            };
            let mut next = Vec::with_capacity(w.len() + 1);
            next.extend_from_slice(&w);
            next.push(first);
            next
        } else {
            return Err(ErrorCategory::InvalidInput);
        };

        if result.len().saturating_add(entry.len()) > max_utf16_units {
            return Err(ErrorCategory::ResourceLimit);
        }
        result.extend_from_slice(&entry);

        let Some(&entry_first) = entry.first() else {
            return Err(ErrorCategory::InvalidInput);
        };
        if dictionary.len() >= max_dict_entries {
            return Err(ErrorCategory::ResourceLimit);
        }
        let mut combined = Vec::with_capacity(w.len() + 1);
        combined.extend_from_slice(&w);
        combined.push(entry_first);
        dictionary.push(combined);
        enlarge_in -= 1;

        w = entry;

        if enlarge_in == 0 {
            enlarge_in = 1usize
                .checked_shl(num_bits)
                .ok_or(ErrorCategory::ResourceLimit)?;
            num_bits = num_bits
                .checked_add(1)
                .ok_or(ErrorCategory::ResourceLimit)?;
            if num_bits > LZ_MAX_CODE_BITS {
                return Err(ErrorCategory::ResourceLimit);
            }
        }
    }
}

fn sweep_photo_root(
    app_data: &AppDataDir,
    marked: &HashSet<String>,
    now: SystemTime,
    limits: &SweepLimits,
    cancellation: &CancellationToken,
) -> Result<SweepSummary, SweepAbort> {
    sweep_photo_root_with_hook(app_data, marked, now, limits, cancellation, |_| {})
}

fn sweep_photo_root_with_hook(
    app_data: &AppDataDir,
    marked: &HashSet<String>,
    now: SystemTime,
    limits: &SweepLimits,
    cancellation: &CancellationToken,
    mut before_entry: impl FnMut(&SweepSummary),
) -> Result<SweepSummary, SweepAbort> {
    check_cancelled(SweepLocation::PhotoStore, cancellation)?;
    // Open writable so Windows parent directory flushes (`FlushFileBuffers`) succeed on removal.
    let Some(photo_dir) =
        open_existing_app_owned_default_dir(app_data, AppOwnedDefaultRoot::ScoresheetPhotos, true)
            .map_err(|error| SweepAbort::from_error(SweepLocation::PhotoStore, &error))?
    else {
        return Ok(SweepSummary {
            marked: marked.len(),
            ..SweepSummary::default()
        });
    };

    let _guard = lock_store();
    check_cancelled(SweepLocation::PhotoStore, cancellation)?;

    let entries = read_directory_entries_at(
        photo_dir.descriptor(),
        cancellation,
        Some(limits.max_photo_entries),
        &mut |_| true,
    )
    .map_err(|error| SweepAbort::from_error(SweepLocation::PhotoStore, &error))?;

    let mut summary = SweepSummary {
        marked: marked.len(),
        ..SweepSummary::default()
    };
    let mut atomic_locks_unsupported = false;
    let mut temp_error_category: Option<ErrorCategory> = None;
    let mut leaf_error_category: Option<ErrorCategory> = None;

    for entry in entries {
        before_entry(&summary);
        if cancellation.is_cancelled() {
            if let Some(category) = temp_error_category {
                log::warn!(
                    "scoresheet photo sweep encountered temporary-file removal error(s) in photo_store: {category}"
                );
            }
            if let Some(category) = leaf_error_category {
                log::warn!(
                    "scoresheet photo sweep encountered photo-leaf removal error(s) in photo_store: {category}"
                );
            }
            return Err(SweepAbort::cancelled_in_photo_store(summary));
        }
        if entry.kind != DirectoryEntryKind::RegularFile {
            continue;
        }
        if is_atomic_temp_name(&entry.name) {
            if !atomic_locks_unsupported {
                match remove_atomic_temp_orphan_at(
                    photo_dir.descriptor(),
                    &entry,
                    now,
                    ATOMIC_TEMP_ORPHAN_GRACE,
                ) {
                    AtomicTempSweepOutcome::Removed => summary.temps_removed += 1,
                    AtomicTempSweepOutcome::Kept => {}
                    AtomicTempSweepOutcome::Failed(category) => {
                        summary.errors += 1;
                        temp_error_category.get_or_insert(category);
                    }
                    AtomicTempSweepOutcome::LockUnsupported => {
                        atomic_locks_unsupported = true;
                    }
                }
            }
            continue;
        }

        let Some(name_str) = entry.name.to_str() else {
            continue;
        };
        let normalized = name_str.to_ascii_lowercase();
        if !is_valid_photo_id(&normalized) {
            continue;
        }
        if marked.contains(&normalized) {
            summary.kept += 1;
            continue;
        }

        // Probe the regular file directly for its live modification time (avoids stale NTFS
        // directory-enumeration timestamps and detects a concurrent atomic replacement).
        let probe = match probe_regular_file_at(photo_dir.descriptor(), &entry.name) {
            Ok(probe) if probe.identity == entry.identity => probe,
            Ok(_) => {
                summary.kept += 1;
                continue;
            }
            Err(error) if error.is_missing_entry() => continue,
            Err(error) => {
                summary.errors += 1;
                leaf_error_category.get_or_insert(error.category());
                continue;
            }
        };
        let older_than_grace = now
            .duration_since(probe.modified)
            .is_ok_and(|age| age > PHOTO_SWEEP_GRACE);
        if !older_than_grace {
            summary.kept += 1;
            continue;
        }

        let verified = match photo_dir.open_leaf_identified(&entry.name) {
            Ok(verified) if verified.pair() == entry.identity => verified,
            Ok(_) => {
                summary.kept += 1;
                continue;
            }
            Err(error) if error.is_missing_entry() => continue,
            Err(error) => {
                summary.errors += 1;
                leaf_error_category.get_or_insert(error.category());
                continue;
            }
        };
        match photo_dir.remove_leaf_identified(&entry.name, verified) {
            Ok(()) => summary.deleted += 1,
            Err(error) if error.is_missing_entry() => {}
            Err(error) => {
                summary.errors += 1;
                leaf_error_category.get_or_insert(error.category());
            }
        }
    }

    if let Some(category) = temp_error_category {
        log::warn!(
            "scoresheet photo sweep encountered temporary-file removal error(s) in photo_store: {category}"
        );
    }
    if let Some(category) = leaf_error_category {
        log::warn!(
            "scoresheet photo sweep encountered photo-leaf removal error(s) in photo_store: {category}"
        );
    }

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        coach::{
            scoresheet_photo::encode_jpeg_data_url,
            scoresheet_photo_store::{store_photos_in_app_data, PHOTO_ID_HEX_LEN},
        },
        infra::path_authority::{
            ensure_app_owned_default_dir, ensure_home_owned_default_dir, AuthorizedDir, HomeDir,
            LegacyMigrationCandidate, PathAuthority, PathClass, PathOperation, PathRef,
        },
        workspace_session::{self, WORKSPACE_SESSION_NAMES_MAX},
    };
    use std::{
        fs,
        io::Cursor,
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc,
        },
    };

    // Real fixtures generated via Node from `node_modules/lz-string/libs/lz-string.js`
    // (`LZString.compressToUTF16(JSON.stringify(...))`).
    const REAL_LZ_PAYLOAD_1: &str = "{\"version\":0,\"state\":{\"headers\":{\"event\":\"Club Championship\",\"white\":\"Müller, Jürgen\",\"black\":\"Test ♟️\",\"other\":{\"ScoresheetPhotos\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\",\"Section\":\"Open\"}},\"root\":{\"fen\":\"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1\",\"children\":[]}}}";
    const REAL_LZ_COMPRESSED_1: &str = "\u{1be1}\u{83b}\u{416c}\u{500}\u{6724}\u{583e}\u{605b}\u{825}\u{6023}\u{54}\u{10e0}\u{1722}\u{d90}\u{46c8}\u{4c}\u{1400}\u{4fa}\u{c44}\u{40b2}\u{12d9}\u{5120}\u{30a0}\u{1b21}\u{2e21}\u{c20}\u{12da}\u{2fa0}\u{16e0}\u{1f1}\u{92c}\u{2958}\u{1141}\u{5823}\u{5cc5}\u{8d0}\u{5b0}\u{21f}\u{378d}\u{9b7}\u{4034}\u{5574}\u{93}\u{434}\u{6cfd}\u{6e10}\u{338}\u{378}\u{5821}\u{2863}\u{6608}\u{fc6}\u{242f}\u{41d}\u{4920}\u{4bbc}\u{4a3d}\u{85}\u{5a4}\u{1423}\u{5ca2}\u{ba0}\u{75}\u{1298}\u{1189}\u{2840}\u{7c98}\u{4282}\u{2959}\u{12ba}\u{4b6f}\u{25c6}\u{31f0}\u{ac}\u{46}\u{53}\u{25}\u{402a}\u{6023}\u{3023}\u{5820}\u{1c20}\u{4e9c}\u{3725}\u{5aa0}\u{683}\u{4849}\u{1474}\u{6b0a}\u{d30}\u{66dc}\u{5179}\u{2ad6}\u{5f74}\u{698b}\u{77d6}\u{6db}\u{e0e}\u{5f28}\u{5ce}\u{1c65}\u{402f}\u{1136}\u{18a0}\u{19d}\u{2bf8}\u{2824}\u{27bd}\u{11c5}\u{3b35}\u{266}\u{7022}\u{1ccd}\u{5c68}\u{2820}\u{3d28}\u{4716}\u{7399}\u{3cc8}\u{3d5e}\u{1ee3}\u{2f8f}\u{57eb}\u{4032}\u{402e}\u{2024}\u{1024}\u{2821}\u{52df}\u{37f3}\u{7601}\u{64dc}\u{205f}\u{72d3}\u{edc}\u{36}\u{4be7}\u{2198}\u{6cdb}\u{4182}\u{49f8}\u{4a30}\u{22a5}\u{2020}\u{6d20}\u{177d}\u{3579}\u{20}\u{20}";
    const REAL_LZ_PAYLOAD_2: &str =
        "{\"version\":0,\"state\":{\"headers\":{\"event\":\"No photo\"}}}";
    const REAL_LZ_COMPRESSED_2: &str = "ᯡ࠻䅬Ԁ朤堾恛ࠥ怣Tრᜢඐ䛈L᐀Ӻౄ䂲ዙ儠Ტ(Z䡷ɀƝ䊠 ";
    const REAL_LZ_PAYLOAD_EMOJI: &str = "{\"version\":0,\"state\":{\"headers\":{\"event\":\"Surrogate 😀 test\",\"other\":{\"ScoresheetPhotos\":\"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\"}}}}";
    const REAL_LZ_COMPRESSED_EMOJI: &str =
        "ᯡ࠻䅬Ԁ朤堾恛ࠥ怣Tრᜢඐ䛈L᐀Ӻౄ䂲ዙ儠㊠坈偀ᳰ䐠ҡ㰻䀠㶡⊘⇐ጇኧ⫠ᣡਤಒࣘ5⒄ድ℠ڂ㪌糥旋歗噠̚Ὼ  ";

    struct SweepHarness {
        _temp: tempfile::TempDir,
        app_data_path: PathBuf,
        home_path: PathBuf,
        external_path: PathBuf,
        app_data: AppDataDir,
        authority: SharedPathAuthority,
    }

    impl SweepHarness {
        fn new() -> Self {
            let temp = tempfile::tempdir().expect("tempdir");
            let app_data_path = temp.path().join("app-data");
            let home_path = temp.path().join("home");
            let external_path = temp.path().join("external");
            fs::create_dir_all(&app_data_path).expect("app_data dir");
            fs::create_dir_all(&home_path).expect("home dir");
            fs::create_dir_all(&external_path).expect("external dir");

            let app_data = AppDataDir::for_test(&app_data_path);
            let registry = temp.path().join("path-authority.json");
            let authority = SharedPathAuthority::installed(
                PathAuthority::open(registry, Vec::new()).expect("open authority"),
            );
            Self {
                _temp: temp,
                app_data_path,
                home_path,
                external_path,
                app_data,
                authority,
            }
        }

        fn home_dir(&self) -> HomeDir {
            HomeDir::for_test(&self.home_path, "com.chessriddle.studio")
        }

        fn run_with(
            &self,
            now: SystemTime,
            limits: &SweepLimits,
            cancellation: &CancellationToken,
        ) -> Result<SweepSummary, SweepAbort> {
            let home_path = self.home_path.clone();
            let app_data_path = self.app_data_path.clone();
            let home_fn = move || Ok(HomeDir::for_test(&home_path, "com.chessriddle.studio"));
            let app_fn = move || Ok(AppDataDir::for_test(&app_data_path));
            let lookups = DefaultDirLookups::new(&home_fn, &app_fn);
            run_sweep(
                &self.app_data,
                &lookups,
                &self.authority,
                now,
                limits,
                cancellation,
            )
        }

        fn photo_root(&self) -> PathBuf {
            ensure_app_owned_default_dir(&self.app_data, AppOwnedDefaultRoot::ScoresheetPhotos)
                .expect("photo root")
                .path()
                .to_path_buf()
        }

        fn write_photo(&self, id: &str, mtime: SystemTime) -> PathBuf {
            let root = self.photo_root();
            let path = root.join(id);
            fs::write(&path, [0xFF, 0xD8, 0xFF, 0xE0, 0xFF, 0xD9]).expect("write photo");
            set_mtime(&path, mtime);
            path
        }

        fn default_pgn_dir(&self) -> PathBuf {
            ensure_home_owned_default_dir(&self.home_dir(), VisibleDefaultKind::Pgn)
                .expect("default pgn dir")
                .path()
                .to_path_buf()
        }

        fn default_db_dir(&self) -> PathBuf {
            ensure_home_owned_default_dir(&self.home_dir(), VisibleDefaultKind::Databases)
                .expect("default db dir")
                .path()
                .to_path_buf()
        }

        fn legacy_db_dir(&self) -> PathBuf {
            ensure_app_owned_default_dir(&self.app_data, AppOwnedDefaultRoot::Databases)
                .expect("legacy db dir")
                .path()
                .to_path_buf()
        }

        fn session_dir(&self) -> AuthorizedDir {
            ensure_app_owned_default_dir(&self.app_data, AppOwnedDefaultRoot::WorkspaceSession)
                .expect("session dir")
        }

        fn register_external_pgn(&self, name: &str, content: &[u8]) -> PathBuf {
            let path = self.external_path.join(name);
            fs::write(&path, content).expect("write external pgn");
            self.authority
                .with_mut(|auth| {
                    let grant = auth.grant_dialog_operations(
                        &path,
                        name,
                        PathClass::BoundedDialogGrant,
                        vec![PathOperation::ReadPgn, PathOperation::WritePgn],
                        Duration::from_secs(60),
                        4,
                    )?;
                    auth.promote_dialog(
                        &grant,
                        PathClass::PersistentFile,
                        name,
                        vec![PathOperation::ReadPgn, PathOperation::WritePgn],
                    )?;
                    Ok::<_, Error>(())
                })
                .expect("authority lock")
                .expect("register pgn");
            path
        }

        fn register_external_pgn_workspace(&self, name: &str) -> PathBuf {
            let path = self.external_path.join(name);
            fs::create_dir_all(&path).expect("create external pgn workspace");
            self.authority
                .with_mut(|auth| {
                    auth.get_or_create_file_workspace_root(&path, name, None)?;
                    Ok::<_, Error>(())
                })
                .expect("authority lock")
                .expect("register pgn workspace");
            path
        }

        fn register_external_db(&self, name: &str, photo_tag: Option<&str>) -> PathBuf {
            let path = self.external_path.join(name);
            create_sqlite_db(&path, photo_tag);
            self.authority
                .with_mut(|auth| {
                    let grant = auth.grant_dialog_operations(
                        &path,
                        name,
                        PathClass::BoundedDialogGrant,
                        vec![PathOperation::DatabaseRead],
                        Duration::from_secs(60),
                        4,
                    )?;
                    auth.promote_dialog(
                        &grant,
                        PathClass::PersistentFile,
                        name,
                        vec![PathOperation::DatabaseRead],
                    )?;
                    Ok::<_, Error>(())
                })
                .expect("authority lock")
                .expect("register db");
            path
        }

        fn register_external_db_root(&self, name: &str) -> PathBuf {
            let path = self.external_path.join(name);
            fs::create_dir_all(&path).expect("create external db root");
            self.authority
                .with_mut(|auth| {
                    auth.get_or_create_database_root(&path, name, None)?;
                    Ok::<_, Error>(())
                })
                .expect("authority lock")
                .expect("register db root");
            path
        }
    }

    fn set_mtime(path: &Path, mtime: SystemTime) {
        fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("open for mtime")
            .set_modified(mtime)
            .expect("set_modified");
    }

    fn create_sqlite_db(path: &Path, photo_tag: Option<&str>) {
        let conn = Connection::open(path).expect("create sqlite db");
        conn.execute_batch(
            "CREATE TABLE Games (ID INTEGER PRIMARY KEY, White TEXT);
             INSERT INTO Games (ID, White) VALUES (1, 'Alice');",
        )
        .expect("init Games");
        if let Some(tag) = photo_tag {
            conn.execute_batch(
                "CREATE TABLE ScoresheetPhotos (
                    GameID INTEGER PRIMARY KEY REFERENCES Games(ID) ON DELETE CASCADE,
                    Photos TEXT NOT NULL
                );",
            )
            .expect("create ScoresheetPhotos");
            conn.execute(
                "INSERT INTO ScoresheetPhotos (GameID, Photos) VALUES (1, ?1)",
                [tag],
            )
            .expect("insert ScoresheetPhotos");
        }
    }

    fn make_id(hex_char: char) -> String {
        std::iter::repeat_n(hex_char, PHOTO_ID_HEX_LEN).collect()
    }

    #[test]
    fn lz_decoder_decodes_real_lz_string_fixtures_and_rejects_malformed() {
        let decoded_1 = lz_decompress_utf16(
            REAL_LZ_COMPRESSED_1,
            MAX_DECODED_SESSION_UTF16_UNITS,
            MAX_DECODED_SESSION_DICT_ENTRIES,
        )
        .expect("decode fixture 1");
        assert_eq!(decoded_1, REAL_LZ_PAYLOAD_1);

        let decoded_2 = lz_decompress_utf16(
            REAL_LZ_COMPRESSED_2,
            MAX_DECODED_SESSION_UTF16_UNITS,
            MAX_DECODED_SESSION_DICT_ENTRIES,
        )
        .expect("decode fixture 2");
        assert_eq!(decoded_2, REAL_LZ_PAYLOAD_2);

        let decoded_emoji = lz_decompress_utf16(
            REAL_LZ_COMPRESSED_EMOJI,
            MAX_DECODED_SESSION_UTF16_UNITS,
            MAX_DECODED_SESSION_DICT_ENTRIES,
        )
        .expect("decode emoji fixture");
        assert_eq!(decoded_emoji, REAL_LZ_PAYLOAD_EMOJI);

        // Bounds and malformed inputs fail closed without panicking.
        assert_eq!(
            lz_decompress_utf16("", 1024, 1024),
            Err(ErrorCategory::InvalidInput)
        );
        assert_eq!(
            lz_decompress_utf16(REAL_LZ_COMPRESSED_1, 10, 1024),
            Err(ErrorCategory::ResourceLimit)
        );
        assert_eq!(
            lz_decompress_utf16("\x01\x02\x03", 1024, 1024),
            Err(ErrorCategory::InvalidInput)
        );
        let truncated: String = REAL_LZ_COMPRESSED_1.chars().take(12).collect();
        assert!(lz_decompress_utf16(&truncated, 1024, 1024).is_err());
    }

    #[test]
    fn pgn_scanner_handles_four_photo_tags_lenient_layouts_and_real_chunk_drain() {
        let id_bom = make_id('0');
        let id_ws = make_id('1');
        let id_nospace = make_id('2');
        let id_sameline = make_id('3');
        let id_3a = make_id('4');
        let id_3b = make_id('5');
        let id_3c = make_id('6');
        let id_4a = make_id('7');
        let id_4b = make_id('8');
        let id_4c = make_id('9');
        let id_4d = make_id('a');

        let mut pgn = Vec::new();
        // UTF-8 BOM right before a 1-photo tag.
        pgn.extend_from_slice(b"\xEF\xBB\xBF");
        pgn.extend_from_slice(format!("[ScoresheetPhotos \"{id_bom}\"]\r\n").as_bytes());
        // CRLF + extra spaces and tabs around brackets, tag name, and value.
        pgn.extend_from_slice(
            format!("  [ \t ScoresheetPhotos \t   \"{id_ws}\" \t ]\r\n").as_bytes(),
        );
        // Zero spaces between tag name and quote (accepted by pgn-reader).
        pgn.extend_from_slice(format!("[ScoresheetPhotos\"{id_nospace}\"]\r\n").as_bytes());
        // Multiple tag pairs on one line (accepted by pgn-reader and parsePGN).
        pgn.extend_from_slice(
            format!("[Event \"Club\"] [ScoresheetPhotos \"{id_sameline}\"]\r\n").as_bytes(),
        );
        // 3-photo tag.
        pgn.extend_from_slice(
            format!("[ScoresheetPhotos \"{id_3a},{id_3b},{id_3c}\"]\n").as_bytes(),
        );
        // Pad well past `pgn_overlap_bytes` (512 bytes) so `window.drain(..)` executes multiple
        // times, then place a maximum-length 4-photo tag (259-byte value) straddling the boundary.
        let padding_len = 900usize;
        pgn.extend(std::iter::repeat_n(b' ', padding_len));
        pgn.push(b'\n');
        // Align the 4-photo tag so its first half lands in one 256-byte chunk and its second half
        // lands in the next chunk after a drain.
        let pad_to_boundary = 256 - (pgn.len() % 256);
        if pad_to_boundary > 40 {
            pgn.extend(std::iter::repeat_n(b'x', pad_to_boundary - 40));
            pgn.push(b'\n');
        }
        pgn.extend_from_slice(
            format!("[ScoresheetPhotos \"{id_4a},{id_4b},{id_4c},{id_4d}\"]\r\n1. e4 e5 *\r\n")
                .as_bytes(),
        );
        // Malformed tag must be ignored without aborting.
        pgn.extend_from_slice(b"[ScoresheetPhotos \"not-a-valid-hash\"]\n");

        assert!(
            pgn.len() > 1500,
            "fixture must significantly exceed overlap window to exercise drain"
        );
        let limits = SweepLimits {
            pgn_chunk_bytes: 256,
            pgn_overlap_bytes: 512,
            ..SweepLimits::default()
        };
        let mut marked = HashSet::new();
        let mut total = 0u64;
        scan_pgn_reader(
            &mut Cursor::new(&pgn),
            &mut marked,
            &mut total,
            &limits,
            &CancellationToken::new(),
        )
        .expect("scan pgn");

        let expected = [
            &id_bom,
            &id_ws,
            &id_nospace,
            &id_sameline,
            &id_3a,
            &id_3b,
            &id_3c,
            &id_4a,
            &id_4b,
            &id_4c,
            &id_4d,
        ];
        for id in expected {
            assert!(marked.contains(id), "expected id {id} to be marked");
        }
        assert_eq!(marked.len(), expected.len());
    }

    #[test]
    fn each_mark_source_keeps_its_photo_and_unmarked_respects_24h_grace() {
        let harness = SweepHarness::new();
        let now = SystemTime::now();
        let old = now - Duration::from_secs(24 * 60 * 60 + 60);
        let young = now - Duration::from_secs(23 * 60 * 60);

        let id_lib_pgn = make_id('1');
        let id_trash = make_id('2');
        let id_ext_pgn = make_id('3');
        let id_reg_workspace_pgn = make_id('4');
        let id_lib_db = make_id('5');
        let id_legacy_db = make_id('6');
        let id_reg_db_root = make_id('7');
        let id_ext_db = make_id('8');
        let id_lz_a = make_id('a');
        let id_lz_b = "0123456789abcdef".repeat(4);
        let id_plain_session = make_id('b');
        let id_unmarked_old = make_id('d');
        let id_unmarked_young = make_id('e');
        // Use a real hex letter ('C') so uppercase normalization is actually exercised on all FSes.
        let id_uppercase_old = make_id('c').to_ascii_uppercase();

        let kept_paths = [
            harness.write_photo(&id_lib_pgn, old),
            harness.write_photo(&id_trash, old),
            harness.write_photo(&id_ext_pgn, old),
            harness.write_photo(&id_reg_workspace_pgn, old),
            harness.write_photo(&id_lib_db, old),
            harness.write_photo(&id_legacy_db, old),
            harness.write_photo(&id_reg_db_root, old),
            harness.write_photo(&id_ext_db, old),
            harness.write_photo(&id_lz_a, old),
            harness.write_photo(&id_lz_b, old),
            harness.write_photo(&id_plain_session, old),
            harness.write_photo(&id_unmarked_young, young),
        ];
        let deleted_old = harness.write_photo(&id_unmarked_old, old);
        let deleted_upper = harness.write_photo(&id_uppercase_old, old);
        // Foreign file in scoresheet-photos must never be touched.
        let foreign = harness.photo_root().join("readme.txt");
        fs::write(&foreign, b"keep me").expect("write foreign");
        set_mtime(&foreign, old);

        // 1. Default Library PGN with uppercase .PGN extension.
        let pgn_dir = harness.default_pgn_dir();
        fs::write(
            pgn_dir.join("CLUB.PGN"),
            format!("[ScoresheetPhotos \"{id_lib_pgn}\"]\n1. e4 e5 *\n"),
        )
        .expect("write lib pgn");

        // 2. Library trash PGN.
        let trash_bucket = pgn_dir
            .join(".en-croissant-trash")
            .join("0f8fad5b-d9cb-469f-a165-70867728950e");
        fs::create_dir_all(&trash_bucket).expect("create trash bucket");
        fs::write(
            trash_bucket.join("deleted.pgn"),
            format!("[ScoresheetPhotos \"{id_trash}\"]\n1. d4 d5 *\n"),
        )
        .expect("write trashed pgn");

        // 3. Registered external PGN workspace (custom switched Library folder).
        let reg_pgn_ws = harness.register_external_pgn_workspace("custom-library-pgn");
        fs::write(
            reg_pgn_ws.join("switched.pgn"),
            format!("[ScoresheetPhotos \"{id_reg_workspace_pgn}\"]\n1. Nf3 Nf6 *\n"),
        )
        .expect("write registered workspace pgn");

        // 4. Registered external PGN file.
        harness.register_external_pgn(
            "outside.pgn",
            format!("[ScoresheetPhotos \"{id_ext_pgn}\"]\n1. c4 e5 *\n").as_bytes(),
        );

        // 5. Default Library DB (.DB3 uppercase), legacy app-data DB, registered DB root, and
        // registered standalone DB.
        let db_dir = harness.default_db_dir();
        create_sqlite_db(&db_dir.join("LIBRARY.DB3"), Some(&id_lib_db));
        create_sqlite_db(&db_dir.join("legacy-no-table.db3"), None);

        let legacy_db_dir = harness.legacy_db_dir();
        create_sqlite_db(&legacy_db_dir.join("legacy-root.db3"), Some(&id_legacy_db));

        let reg_db_root = harness.register_external_db_root("custom-db-root");
        create_sqlite_db(&reg_db_root.join("custom-root.db3"), Some(&id_reg_db_root));

        harness.register_external_db("registered.db3", Some(&id_ext_db));

        // 6. Native workspace-session leaves: real lz-string UTF-16 + legacy plain JSON.
        let session_dir = harness.session_dir();
        workspace_session::write_in(
            &session_dir,
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            REAL_LZ_COMPRESSED_1,
        )
        .expect("write lz session leaf");
        workspace_session::write_in(
            &session_dir,
            "7c9e6679-7425-40de-944b-e07fc1f90ae7",
            &format!(
                "{{\"version\":0,\"state\":{{\"headers\":{{\"other\":{{\"ScoresheetPhotos\":\"{id_plain_session}\"}}}}}}}}"
            ),
        )
        .expect("write legacy json session leaf");

        let summary = harness
            .run_with(now, &SweepLimits::default(), &CancellationToken::new())
            .expect("sweep succeeds");
        assert_eq!(summary.deleted, 2);
        assert_eq!(summary.kept, kept_paths.len());
        assert_eq!(summary.errors, 0);
        assert!(!deleted_old.exists(), "unmarked >24h photo must be deleted");
        assert!(
            !deleted_upper.exists(),
            "case-normalized unmarked >24h photo must be deleted"
        );
        assert!(foreign.exists(), "foreign file must remain");
        for path in &kept_paths {
            assert!(
                path.exists(),
                "referenced or young photo must stay: {path:?}"
            );
        }
    }

    #[test]
    fn database_without_scoresheet_photos_table_counts_as_no_references() {
        let harness = SweepHarness::new();
        let now = SystemTime::now();
        let old = now - Duration::from_secs(25 * 60 * 60);
        let orphan = harness.write_photo(&make_id('d'), old);

        let db_dir = harness.default_db_dir();
        create_sqlite_db(&db_dir.join("old-build.db3"), None);

        let summary = harness
            .run_with(now, &SweepLimits::default(), &CancellationToken::new())
            .expect("sweep succeeds with absent table");
        assert_eq!(summary.marked, 0);
        assert_eq!(summary.deleted, 1);
        assert!(!orphan.exists());
    }

    #[test]
    fn fail_closed_on_corrupt_db_missing_registered_and_session_anomalies() {
        let now = SystemTime::now();
        let old = now - Duration::from_secs(25 * 60 * 60);

        // (a) Corrupt database in Library DB root reports Database category.
        {
            let h = SweepHarness::new();
            let orphan = h.write_photo(&make_id('a'), old);
            fs::write(h.default_db_dir().join("corrupt.db3"), b"not sqlite").expect("corrupt db");
            let abort = h
                .run_with(now, &SweepLimits::default(), &CancellationToken::new())
                .expect_err("corrupt db must abort");
            assert_eq!(abort.location, SweepLocation::LibraryDatabase);
            assert_eq!(abort.category, ErrorCategory::Database);
            assert!(orphan.exists(), "zero deletions on abort");
        }

        // (b) Missing / unavailable registered external PGN.
        {
            let h = SweepHarness::new();
            let orphan = h.write_photo(&make_id('b'), old);
            let ext = h.register_external_pgn("vanished.pgn", b"1. e4 e5 *\n");
            fs::remove_file(&ext).expect("remove external pgn");
            let abort = h
                .run_with(now, &SweepLimits::default(), &CancellationToken::new())
                .expect_err("missing registered pgn must abort");
            assert_eq!(abort.location, SweepLocation::RegisteredPgn);
            assert!(orphan.exists(), "zero deletions on abort");
        }

        // (c) Undecodable session leaf.
        {
            let h = SweepHarness::new();
            let orphan = h.write_photo(&make_id('c'), old);
            workspace_session::write_in(
                &h.session_dir(),
                "0f8fad5b-d9cb-469f-a165-70867728950e",
                "<<<not-lz-and-not-json>>>",
            )
            .expect("write bad leaf");
            let abort = h
                .run_with(now, &SweepLimits::default(), &CancellationToken::new())
                .expect_err("undecodable session leaf must abort");
            assert_eq!(abort.location, SweepLocation::WorkspaceSession);
            assert!(orphan.exists(), "zero deletions on abort");
        }

        // (d) Skipped UUID session leaf (non-UTF-8 bytes).
        {
            let h = SweepHarness::new();
            let orphan = h.write_photo(&make_id('d'), old);
            let session_path = h.session_dir().path().to_path_buf();
            fs::write(
                session_path.join("0f8fad5b-d9cb-469f-a165-70867728950e.json"),
                [0xFFu8, 0xFE, 0x00],
            )
            .expect("write non-utf8 leaf");
            let abort = h
                .run_with(now, &SweepLimits::default(), &CancellationToken::new())
                .expect_err("skipped session leaf must abort");
            assert_eq!(abort.location, SweepLocation::WorkspaceSession);
            assert!(orphan.exists(), "zero deletions on abort");
        }

        // (e) Skipped fixed leaves (workspace.json and page-tabs.json).
        for fixed_leaf in ["workspace.json", "page-tabs.json"] {
            let h = SweepHarness::new();
            let orphan = h.write_photo(&make_id('1'), old);
            let session_path = h.session_dir().path().to_path_buf();
            fs::write(session_path.join(fixed_leaf), [0xFFu8, 0xFE, 0x00])
                .expect("write non-utf8 fixed leaf");
            let abort = h
                .run_with(now, &SweepLimits::default(), &CancellationToken::new())
                .expect_err("skipped fixed leaf must abort");
            assert_eq!(abort.location, SweepLocation::WorkspaceSession);
            assert!(orphan.exists(), "zero deletions on {fixed_leaf} abort");
        }

        // (f) Quarantined session leaf bucket present.
        {
            let h = SweepHarness::new();
            let orphan = h.write_photo(&make_id('e'), old);
            let session_dir = h.session_dir();
            workspace_session::write_in(
                &session_dir,
                "0f8fad5b-d9cb-469f-a165-70867728950e",
                REAL_LZ_COMPRESSED_2,
            )
            .expect("write leaf");
            workspace_session::quarantine_in(
                &session_dir,
                Some(&["0f8fad5b-d9cb-469f-a165-70867728950e".to_owned()]),
            )
            .expect("quarantine leaf");
            let abort = h
                .run_with(now, &SweepLimits::default(), &CancellationToken::new())
                .expect_err("quarantined session leaf must abort");
            assert_eq!(abort.location, SweepLocation::WorkspaceSession);
            assert!(orphan.exists(), "zero deletions on abort");
        }

        // (g) Omitted session leaves (> WORKSPACE_SESSION_NAMES_MAX).
        {
            let h = SweepHarness::new();
            let orphan = h.write_photo(&make_id('f'), old);
            let session_path = h.session_dir().path().to_path_buf();
            for i in 0..=WORKSPACE_SESSION_NAMES_MAX {
                let id = uuid::Uuid::from_u128(i as u128 + 1)
                    .hyphenated()
                    .to_string();
                fs::write(session_path.join(format!("{id}.json")), "{}").expect("write leaf");
            }
            let abort = h
                .run_with(now, &SweepLimits::default(), &CancellationToken::new())
                .expect_err("omitted session leaves must abort");
            assert_eq!(abort.location, SweepLocation::WorkspaceSession);
            assert_eq!(abort.category, ErrorCategory::ResourceLimit);
            assert!(orphan.exists(), "zero deletions on abort");
        }
    }

    #[test]
    fn fail_closed_on_unreadable_default_roots_and_home_lookup_failure() {
        let now = SystemTime::now();
        let old = now - Duration::from_secs(25 * 60 * 60);

        // (a) Regular file blocking default visible PGN folder.
        {
            let h = SweepHarness::new();
            let orphan = h.write_photo(&make_id('1'), old);
            let studio = h.home_path.join("ChessRiddle Studio");
            fs::create_dir_all(&studio).expect("studio dir");
            fs::write(studio.join("PGN"), b"not a directory").expect("pgn blocker");
            let abort = h
                .run_with(now, &SweepLimits::default(), &CancellationToken::new())
                .expect_err("blocked default PGN root must abort");
            assert_eq!(abort.location, SweepLocation::LibraryPgn);
            assert!(orphan.exists());
        }

        // (b) Regular file blocking default visible Databases folder.
        {
            let h = SweepHarness::new();
            let orphan = h.write_photo(&make_id('2'), old);
            let studio = h.home_path.join("ChessRiddle Studio");
            fs::create_dir_all(&studio).expect("studio dir");
            fs::write(studio.join("Databases"), b"not a directory").expect("db blocker");
            let abort = h
                .run_with(now, &SweepLimits::default(), &CancellationToken::new())
                .expect_err("blocked default DB root must abort");
            assert_eq!(abort.location, SweepLocation::LibraryDatabase);
            assert!(orphan.exists());
        }

        // (c) Regular file blocking workspace-session root.
        {
            let h = SweepHarness::new();
            let orphan = h.write_photo(&make_id('3'), old);
            fs::write(h.app_data_path.join("workspace-session"), b"not a dir")
                .expect("session blocker");
            let abort = h
                .run_with(now, &SweepLimits::default(), &CancellationToken::new())
                .expect_err("blocked session root must abort");
            assert_eq!(abort.location, SweepLocation::WorkspaceSession);
            assert!(orphan.exists());
        }

        // (d) Home lookup failure fails closed for both Pgn and Databases (never silently skips).
        {
            let h = SweepHarness::new();
            let orphan = h.write_photo(&make_id('4'), old);
            let app_data_path = h.app_data_path.clone();
            let failing_home = || Err(Error::Conflict("home unavailable".into()));
            let app_fn = move || Ok(AppDataDir::for_test(&app_data_path));
            let lookups = DefaultDirLookups::new(&failing_home, &app_fn);
            assert!(
                open_existing_visible_default_dir(&lookups, VisibleDefaultKind::Databases).is_err(),
                "home lookup failure must fail closed for Databases"
            );
            let abort = run_sweep(
                &h.app_data,
                &lookups,
                &h.authority,
                now,
                &SweepLimits::default(),
                &CancellationToken::new(),
            )
            .expect_err("home lookup failure must abort sweep");
            assert_eq!(abort.location, SweepLocation::LibraryPgn);
            assert!(orphan.exists());
        }
    }

    #[test]
    fn fail_closed_on_hit_scan_bounds_and_cancellation() {
        let now = SystemTime::now();
        let old = now - Duration::from_secs(25 * 60 * 60);

        // (a) Depth bound.
        {
            let h = SweepHarness::new();
            let orphan = h.write_photo(&make_id('1'), old);
            let deep = h.default_pgn_dir().join("a").join("b").join("c");
            fs::create_dir_all(&deep).expect("deep dir");
            let limits = SweepLimits {
                max_scan_depth: 2,
                ..SweepLimits::default()
            };
            let abort = h
                .run_with(now, &limits, &CancellationToken::new())
                .expect_err("depth bound must abort");
            assert_eq!(abort.category, ErrorCategory::ResourceLimit);
            assert!(orphan.exists());
        }

        // (b) Entries bound.
        {
            let h = SweepHarness::new();
            let orphan = h.write_photo(&make_id('2'), old);
            let pgn_dir = h.default_pgn_dir();
            for i in 0..5 {
                fs::write(pgn_dir.join(format!("g{i}.pgn")), b"1. e4 *\n").expect("write pgn");
            }
            let limits = SweepLimits {
                max_scan_entries: 3,
                ..SweepLimits::default()
            };
            let abort = h
                .run_with(now, &limits, &CancellationToken::new())
                .expect_err("entries bound must abort");
            assert_eq!(abort.category, ErrorCategory::ResourceLimit);
            assert!(orphan.exists());
        }

        // (c) Files bound.
        {
            let h = SweepHarness::new();
            let orphan = h.write_photo(&make_id('3'), old);
            let pgn_dir = h.default_pgn_dir();
            fs::write(pgn_dir.join("a.pgn"), b"1. e4 *\n").expect("write a");
            fs::write(pgn_dir.join("b.pgn"), b"1. d4 *\n").expect("write b");
            let limits = SweepLimits {
                max_scan_files: 1,
                ..SweepLimits::default()
            };
            let abort = h
                .run_with(now, &limits, &CancellationToken::new())
                .expect_err("files bound must abort");
            assert_eq!(abort.category, ErrorCategory::ResourceLimit);
            assert!(orphan.exists());
        }

        // (d) Per-file PGN bytes bound.
        {
            let h = SweepHarness::new();
            let orphan = h.write_photo(&make_id('4'), old);
            fs::write(h.default_pgn_dir().join("big.pgn"), vec![b'a'; 256]).expect("write big");
            let limits = SweepLimits {
                max_pgn_file_bytes: 128,
                ..SweepLimits::default()
            };
            let abort = h
                .run_with(now, &limits, &CancellationToken::new())
                .expect_err("per-file bytes bound must abort");
            assert_eq!(abort.category, ErrorCategory::ResourceLimit);
            assert!(orphan.exists());
        }

        // (e) Total PGN bytes bound across multiple files (each under per-file cap).
        {
            let h = SweepHarness::new();
            let orphan = h.write_photo(&make_id('5'), old);
            let pgn_dir = h.default_pgn_dir();
            fs::write(pgn_dir.join("part1.pgn"), vec![b'a'; 100]).expect("write part1");
            fs::write(pgn_dir.join("part2.pgn"), vec![b'b'; 100]).expect("write part2");
            let limits = SweepLimits {
                max_pgn_file_bytes: 150,
                max_total_pgn_bytes: 150,
                ..SweepLimits::default()
            };
            let abort = h
                .run_with(now, &limits, &CancellationToken::new())
                .expect_err("total PGN bytes bound must abort");
            assert_eq!(abort.category, ErrorCategory::ResourceLimit);
            assert!(orphan.exists());
        }

        // (f) Photo root entries bound.
        {
            let h = SweepHarness::new();
            let p1 = h.write_photo(&make_id('6'), old);
            let p2 = h.write_photo(&make_id('7'), old);
            let p3 = h.write_photo(&make_id('8'), old);
            let limits = SweepLimits {
                max_photo_entries: 2,
                ..SweepLimits::default()
            };
            let abort = h
                .run_with(now, &limits, &CancellationToken::new())
                .expect_err("photo root entries bound must abort");
            assert_eq!(abort.location, SweepLocation::PhotoStore);
            assert_eq!(abort.category, ErrorCategory::ResourceLimit);
            assert!(p1.exists() && p2.exists() && p3.exists());
        }

        // (g) Cancellation before sweep deletes nothing.
        {
            let h = SweepHarness::new();
            let orphan = h.write_photo(&make_id('9'), old);
            let token = CancellationToken::new();
            token.cancel();
            let abort = h
                .run_with(now, &SweepLimits::default(), &token)
                .expect_err("cancelled sweep must abort");
            assert_eq!(abort.category, ErrorCategory::Cancellation);
            assert!(orphan.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_symlinks_are_not_deleted_and_unreadable_pgn_aborts() {
        use std::os::unix::fs::PermissionsExt;

        let now = SystemTime::now();
        let old = now - Duration::from_secs(25 * 60 * 60);

        // Symlink inside scoresheet-photos named like a 64-hex id is never deleted.
        {
            let h = SweepHarness::new();
            let outside = h.external_path.join("outside.jpg");
            fs::write(&outside, b"outside").expect("write outside");
            let link_path = h.photo_root().join(make_id('a'));
            std::os::unix::fs::symlink(&outside, &link_path).expect("create symlink");

            let summary = h
                .run_with(now, &SweepLimits::default(), &CancellationToken::new())
                .expect("sweep succeeds");
            assert_eq!(summary.deleted, 0);
            assert!(link_path.symlink_metadata().is_ok());
            assert!(outside.exists());
        }

        // Unreadable PGN file inside Library PGN dir aborts with zero deletions.
        {
            let h = SweepHarness::new();
            let orphan = h.write_photo(&make_id('b'), old);
            let pgn = h.default_pgn_dir().join("locked.pgn");
            fs::write(&pgn, b"1. e4 *\n").expect("write pgn");
            fs::set_permissions(&pgn, fs::Permissions::from_mode(0o000)).expect("chmod 000");

            let result = h.run_with(now, &SweepLimits::default(), &CancellationToken::new());
            // Restore permissions before asserting so tempdir cleanup always succeeds.
            let _ = fs::set_permissions(&pgn, fs::Permissions::from_mode(0o600));

            let abort = result.expect_err("unreadable pgn must abort");
            assert_eq!(abort.location, SweepLocation::LibraryPgn);
            assert!(orphan.exists(), "zero deletions on unreadable pgn");
        }
    }

    #[test]
    fn stale_atomic_temps_are_removed_and_fresh_ones_are_kept() {
        let harness = SweepHarness::new();
        let now = SystemTime::now();
        let stale_time = now - Duration::from_secs(120);
        let fresh_time = now - Duration::from_secs(10);

        let root = harness.photo_root();
        let stale_temp = root.join(format!(".atomic-{}", uuid::Uuid::new_v4().hyphenated()));
        let fresh_temp = root.join(format!(".atomic-{}", uuid::Uuid::new_v4().hyphenated()));
        fs::write(&stale_temp, b"stale").expect("write stale temp");
        fs::write(&fresh_temp, b"fresh").expect("write fresh temp");
        set_mtime(&stale_temp, stale_time);
        set_mtime(&fresh_temp, fresh_time);

        let summary = harness
            .run_with(now, &SweepLimits::default(), &CancellationToken::new())
            .expect("sweep succeeds");
        assert_eq!(summary.temps_removed, 1);
        assert!(!stale_temp.exists(), "stale .atomic-* temp must be removed");
        assert!(fresh_temp.exists(), "fresh .atomic-* temp must be kept");
    }

    #[test]
    fn sweep_delete_step_blocks_on_store_lock_and_racing_store_keeps_its_file() {
        let harness = SweepHarness::new();
        let jpeg = vec![
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 77, 0xFF, 0xD9,
        ];
        let url = encode_jpeg_data_url(&jpeg);
        let ids = store_photos_in_app_data(&harness.app_data, std::slice::from_ref(&url))
            .expect("initial store");
        let id = &ids[0];
        let leaf_path = harness.photo_root().join(id);

        let now = SystemTime::now();
        let old = now - Duration::from_secs(25 * 60 * 60);
        set_mtime(&leaf_path, old);

        // 1. Prove `sweep_photo_root` acquires `lock_store()`: holding `lock_store()` blocks a real
        // `run_sweep` call on another thread before it can delete the >24h orphan.
        let guard = lock_store();
        let app_data_path = harness.app_data_path.clone();
        let home_path = harness.home_path.clone();
        let authority = harness.authority.clone();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let sweep_thread = std::thread::spawn(move || {
            started_tx.send(()).expect("signal sweep start");
            let app_data = AppDataDir::for_test(&app_data_path);
            let home_fn = move || Ok(HomeDir::for_test(&home_path, "com.chessriddle.studio"));
            let app_fn = move || Ok(AppDataDir::for_test(&app_data_path));
            let lookups = DefaultDirLookups::new(&home_fn, &app_fn);
            let res = run_sweep(
                &app_data,
                &lookups,
                &authority,
                now,
                &SweepLimits::default(),
                &CancellationToken::new(),
            );
            done_tx.send(res).expect("signal sweep done");
        });
        started_rx.recv().expect("sweep thread started");
        assert!(
            done_rx.recv_timeout(Duration::from_millis(80)).is_err(),
            "run_sweep must block in sweep_photo_root while lock_store() is held"
        );
        assert!(
            leaf_path.exists(),
            "orphan must not be deleted while lock_store() is held"
        );
        drop(guard);

        let summary = done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("sweep completes after lock_store() is released")
            .expect("sweep succeeds");
        sweep_thread.join().expect("join sweep thread");
        assert_eq!(summary.deleted, 1);
        assert!(!leaf_path.exists());

        // 2. Re-store before sweep acquires lock_store -> atomic replace refreshes mtime -> kept!
        store_photos_in_app_data(&harness.app_data, std::slice::from_ref(&url))
            .expect("re-store refreshes mtime");
        let summary = harness
            .run_with(now, &SweepLimits::default(), &CancellationToken::new())
            .expect("sweep succeeds");
        assert_eq!(summary.deleted, 0);
        assert!(leaf_path.exists(), "re-stored photo must survive sweep");
    }

    #[test]
    fn sweep_is_disabled_when_app_data_locked_is_false() {
        let harness = SweepHarness::new();
        let now = SystemTime::now();
        let old = now - Duration::from_secs(25 * 60 * 60);
        let orphan = harness.write_photo(&make_id('e'), old);

        let app = tauri::test::mock_app();
        let sweep = ScoresheetPhotoSweep::start(
            app.handle(),
            harness.authority.clone(),
            FolderSwitchCoordinator::default(),
            false,
        );
        assert!(sweep.0.is_none(), "sweep must stay disabled when unlocked");
        tauri::async_runtime::block_on(sweep.shutdown());
        assert!(orphan.exists(), "unlocked sweep must delete nothing");
    }

    #[tokio::test]
    async fn sweep_waits_for_database_migration_gate_and_cancels_cleanly_on_shutdown() {
        let make_candidate = || LegacyMigrationCandidate {
            kind: FolderSwitchKind::Database,
            source_root: PathRef {
                id: "legacy-db".into(),
            },
            source_path: PathBuf::new(),
            source_identity: (0, 0),
            engine_descendants: HashSet::new(),
        };
        let coordinator = FolderSwitchCoordinator::default();
        let pending = coordinator.raise_migration_gates(vec![make_candidate()]);
        assert_eq!(pending.len(), 1);
        let (_, gate_guard) = pending.into_iter().next().expect("db gate");

        // While the database migration gate is raised, the sweep must not enter its runner.
        let ran = Arc::new(AtomicBool::new(false));
        let ran_clone = Arc::clone(&ran);
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let sweep = ScoresheetPhotoSweep::spawn_with_runner(coordinator.clone(), move |_token| {
            ran_clone.store(true, Ordering::SeqCst);
            let _ = done_tx.send(());
            Ok(SweepSummary::default())
        });

        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(
            !ran.load(Ordering::SeqCst),
            "sweep must wait for FolderSwitchKind::Database migration gate before running"
        );

        // Releasing the gate lets the sweep run to completion.
        drop(gate_guard);
        tokio::time::timeout(Duration::from_secs(5), done_rx)
            .await
            .expect("sweep finishes after migration gate clears")
            .expect("runner signaled");
        assert!(ran.load(Ordering::SeqCst));
        sweep.shutdown().await;

        // Shutting down while the gate is raised cancels cleanly without running the sweep.
        let pending = coordinator.raise_migration_gates(vec![make_candidate()]);
        let (_, held_guard) = pending.into_iter().next().expect("db gate");
        let ran_cancelled = Arc::new(AtomicBool::new(false));
        let ran_cancelled_clone = Arc::clone(&ran_cancelled);
        let cancelled_sweep =
            ScoresheetPhotoSweep::spawn_with_runner(coordinator.clone(), move |_token| {
                ran_cancelled_clone.store(true, Ordering::SeqCst);
                Ok(SweepSummary::default())
            });
        tokio::time::sleep(Duration::from_millis(40)).await;
        cancelled_sweep.shutdown().await;
        assert!(
            !ran_cancelled.load(Ordering::SeqCst),
            "shutdown while gated must cancel without running the sweep"
        );
        drop(held_guard);
    }

    #[test]
    fn unresolved_database_folder_switch_journal_aborts_sweep_with_zero_deletions() {
        let harness = SweepHarness::new();
        let now = SystemTime::now();
        let old = now - Duration::from_secs(25 * 60 * 60);
        let orphan = harness.write_photo(&make_id('a'), old);

        // Plant an unresolved Database folder-switch journal next to the path-authority registry.
        let journal_path = harness
            .authority
            .with_mut(|auth| auth.journal_path(FolderSwitchKind::Database))
            .expect("journal path");
        fs::write(&journal_path, b"{invalid-json-unresolved-journal")
            .expect("write corrupt journal");

        let abort = harness
            .run_with(now, &SweepLimits::default(), &CancellationToken::new())
            .expect_err("unresolved database journal must abort sweep");
        assert_eq!(abort.location, SweepLocation::Authority);
        assert!(orphan.exists(), "zero deletions on unresolved journal");
    }

    #[test]
    fn cancellation_mid_deletion_loop_reports_partial_deletions_and_stops_remaining() {
        let now = SystemTime::now();
        let old = now - Duration::from_secs(25 * 60 * 60);
        let stale_temp_time = now - Duration::from_secs(120);

        // 1a. Photo-only fixture: cancellation after deleting 1 photo reports `deleted=1`
        //     instead of zero deletions and leaves the remaining photo untouched.
        {
            let harness = SweepHarness::new();
            let p1 = harness.write_photo(&make_id('1'), old);
            let p2 = harness.write_photo(&make_id('2'), old);

            let token = CancellationToken::new();
            let cancel_token = token.clone();
            let abort = sweep_photo_root_with_hook(
                &harness.app_data,
                &HashSet::new(),
                now,
                &SweepLimits::default(),
                &token,
                move |summary| {
                    if summary.deleted >= 1 {
                        cancel_token.cancel();
                    }
                },
            )
            .expect_err("mid-loop cancellation after photo deletion must abort");

            assert_eq!(abort.location, SweepLocation::PhotoStore);
            assert_eq!(abort.category, ErrorCategory::Cancellation);
            let partial = abort
                .partial
                .expect("mid-loop cancellation after a photo deletion must carry partial counts");
            assert_eq!(partial.deleted, 1);
            assert_eq!(partial.temps_removed, 0);

            let remaining = [&p1, &p2].iter().filter(|path| path.exists()).count();
            assert_eq!(
                remaining, 1,
                "cancellation must stop before deleting the second photo"
            );

            let log_line = abort.log_message();
            assert!(
                !log_line.contains("zero deletions"),
                "partial cancellation log must not claim zero deletions: {log_line}"
            );
            assert!(
                log_line
                    .contains("partial: marked=0, deleted=1, kept=0, temps_removed=0, errors=0"),
                "partial cancellation log must state real photo count: {log_line}"
            );
        }

        // 1b. Stale-temp-only fixture: cancellation after removing 1 stale temp reports
        //     `temps_removed=1` instead of zero deletions and leaves the second temp untouched.
        {
            let harness = SweepHarness::new();
            let root = harness.photo_root();
            let t1 = root.join(format!(".atomic-{}", uuid::Uuid::new_v4().hyphenated()));
            let t2 = root.join(format!(".atomic-{}", uuid::Uuid::new_v4().hyphenated()));
            fs::write(&t1, b"stale-1").expect("write stale temp 1");
            fs::write(&t2, b"stale-2").expect("write stale temp 2");
            set_mtime(&t1, stale_temp_time);
            set_mtime(&t2, stale_temp_time);

            let token = CancellationToken::new();
            let cancel_token = token.clone();
            let abort = sweep_photo_root_with_hook(
                &harness.app_data,
                &HashSet::new(),
                now,
                &SweepLimits::default(),
                &token,
                move |summary| {
                    if summary.temps_removed >= 1 {
                        cancel_token.cancel();
                    }
                },
            )
            .expect_err("mid-loop cancellation after stale temp removal must abort");

            assert_eq!(abort.location, SweepLocation::PhotoStore);
            assert_eq!(abort.category, ErrorCategory::Cancellation);
            let partial = abort
                .partial
                .expect("mid-loop cancellation after a temp removal must carry partial counts");
            assert_eq!(partial.deleted, 0);
            assert_eq!(partial.temps_removed, 1);

            let remaining = [&t1, &t2].iter().filter(|path| path.exists()).count();
            assert_eq!(
                remaining, 1,
                "cancellation must stop before removing the second stale temp"
            );

            let log_line = abort.log_message();
            assert!(
                !log_line.contains("zero deletions"),
                "partial cancellation log must not claim zero deletions: {log_line}"
            );
            assert!(
                log_line
                    .contains("partial: marked=0, deleted=0, kept=0, temps_removed=1, errors=0"),
                "partial cancellation log must state real temp count: {log_line}"
            );
        }

        // 2. Cancellation on the first iteration before any deletion still reports zero deletions.
        {
            let harness = SweepHarness::new();
            let p1 = harness.write_photo(&make_id('3'), old);
            let token = CancellationToken::new();
            let cancel_token = token.clone();
            let abort = sweep_photo_root_with_hook(
                &harness.app_data,
                &HashSet::new(),
                now,
                &SweepLimits::default(),
                &token,
                move |_| {
                    cancel_token.cancel();
                },
            )
            .expect_err("cancellation before first deletion must abort");

            assert_eq!(abort.location, SweepLocation::PhotoStore);
            assert_eq!(abort.category, ErrorCategory::Cancellation);
            assert!(abort.partial.is_none());
            assert!(p1.exists());
            assert!(abort.log_message().contains("(zero deletions)"));
        }
    }
}
