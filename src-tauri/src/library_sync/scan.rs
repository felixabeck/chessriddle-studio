//! Workspace scanning, revision-gated hashing, name normalisation and 5-pass identity matching (S-3).

use crate::{
    db::{
        resolve_database,
        sync_export::{
            export_database_pgn_bounded, is_deferred_database_error, read_cheap_database_info,
            BoundedDatabaseExport, CheapDatabaseInfo,
        },
        DatabaseIdentity, DatabaseRepository,
    },
    error::Error,
    file_workspace::{WorkspaceEntry, WorkspaceEntryKind, WorkspaceFileType},
    infra::path_authority::{
        DatabaseHandle, FileWorkspaceHandle, PathAvailability, PathOperation, SharedPathAuthority,
    },
    library_sync::{
        state::{SyncEntry, SyncSource, SyncState, MAX_STATE_ENTRIES},
        wire::{
            is_valid_studio_file_id, LibraryFileKind, StudioLibraryFile, LIBRARY_MAX_BYTES,
            LIBRARY_MAX_GAMES,
        },
        LibrarySyncHandle, ABSENCE_DELETE_THRESHOLD,
    },
};
use sha2::{Digest, Sha256};
use std::{
    borrow::Cow,
    collections::{BTreeMap, HashMap, HashSet},
    ffi::OsString,
    io::Read,
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

const HASH_CHUNK_BYTES: usize = 64 * 1024;
const MAX_LIBRARY_NAME_CHARS: usize = 120;

fn trim_and_cut(value: &str) -> String {
    let trimmed = value.trim();
    let cut: String = trimmed.chars().take(MAX_LIBRARY_NAME_CHARS).collect();
    cut.trim().to_owned()
}

/// Normalises a Studio PGN file leaf name exactly as the server stores it: strips one trailing
/// `.pgn` in any ASCII case, trims, cuts to 120 Unicode scalar values and trims again. An empty
/// result falls back to the full leaf name normalised the same way.
pub(crate) fn normalize_library_name(file_name: &str) -> String {
    let bytes = file_name.as_bytes();
    let stripped = if bytes.len() >= 4 && bytes[bytes.len() - 4..].eq_ignore_ascii_case(b".pgn") {
        &file_name[..file_name.len() - 4]
    } else {
        file_name
    };
    let normalized = trim_and_cut(stripped);
    if normalized.is_empty() {
        trim_and_cut(file_name)
    } else {
        normalized
    }
}

pub(crate) fn kind_for_file_type(file_type: Option<&WorkspaceFileType>) -> LibraryFileKind {
    match file_type {
        Some(WorkspaceFileType::Repertoire) => LibraryFileKind::Repertoire,
        _ => LibraryFileKind::Games,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CandidateFingerprint {
    pub source: SyncSource,
    pub locator: Vec<OsString>,
    pub name: String,
    pub kind: LibraryFileKind,
    pub revision: Option<String>,
    pub oversized: bool,
    pub unreadable: bool,
    pub too_many_games: bool,
    pub empty: bool,
    pub invalid_pgn: bool,
    pub deferred: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ScannedCandidate {
    pub source: SyncSource,
    pub handle: LibrarySyncHandle,
    pub locator: Vec<OsString>,
    pub name: String,
    pub normalized_name: String,
    pub folder_label: String,
    pub kind: LibraryFileKind,
    pub revision: Option<String>,
    pub content_sha256: Option<String>,
    pub oversized: bool,
    pub unreadable: bool,
    pub too_many_games: bool,
    pub empty: bool,
    pub invalid_pgn: bool,
    pub deferred: bool,
}

impl ScannedCandidate {
    pub(crate) fn fingerprint(&self) -> CandidateFingerprint {
        CandidateFingerprint {
            source: self.source,
            locator: self.locator.clone(),
            name: self.name.clone(),
            kind: self.kind,
            revision: self.revision.clone(),
            oversized: self.oversized,
            unreadable: self.unreadable,
            too_many_games: self.too_many_games,
            empty: self.empty,
            invalid_pgn: self.invalid_pgn,
            deferred: self.deferred,
        }
    }

    /// Databases that fail the cheap size/game-count/empty gate default to unselected so huge
    /// reference databases (e.g. Mega Database) do not raise Attention on every launch.
    pub(crate) fn fails_cheap_gate(&self) -> bool {
        self.source == SyncSource::Database && (self.too_many_games || self.oversized || self.empty)
    }

    pub(crate) fn default_selected(&self) -> bool {
        !self.fails_cheap_gate()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ScanResult {
    pub candidates: Vec<ScannedCandidate>,
    pub files_complete: bool,
    pub databases_complete: bool,
    pub updated_hash_cache: HashMap<(SyncSource, Vec<OsString>), (String, String)>,
}

impl ScanResult {
    pub(crate) fn complete(&self) -> bool {
        self.files_complete && self.databases_complete
    }

    pub(crate) fn fingerprints(&self) -> Vec<CandidateFingerprint> {
        self.candidates
            .iter()
            .map(ScannedCandidate::fingerprint)
            .collect()
    }
}

/// Controls whether `scan_workspace_blocking` exports eligible databases to PGN for hashing.
pub(crate) enum DatabaseExportPolicy<'a> {
    /// Off-mode snapshot / turn-on preview: cheap Info only, never export databases.
    CheapInfoOnly,
    /// On-mode scan: export an eligible database only when it is selected or will default-select.
    SelectedOrDefault {
        entries: &'a BTreeMap<String, SyncEntry>,
        pending_deselected_handles: &'a HashSet<LibrarySyncHandle>,
        pending_deselected_locators: &'a HashSet<Vec<OsString>>,
    },
}

impl DatabaseExportPolicy<'_> {
    fn should_export(&self, handle: &LibrarySyncHandle, locator: &[OsString]) -> bool {
        match self {
            Self::CheapInfoOnly => false,
            Self::SelectedOrDefault {
                entries,
                pending_deselected_handles,
                pending_deselected_locators,
            } => {
                if let Some((_, entry)) = entries.iter().find(|(_, entry)| {
                    entry.source == SyncSource::Database && entry.handle.as_ref() == Some(handle)
                }) {
                    return entry.selected;
                }
                if let Some((_, entry)) = entries.iter().find(|(_, entry)| {
                    entry.source == SyncSource::Database && entry.locator.as_slice() == locator
                }) {
                    return entry.selected;
                }
                !pending_deselected_handles.contains(handle)
                    && !pending_deselected_locators.contains(locator)
            }
        }
    }
}

/// Result of reading/exporting a candidate's PGN bytes for upload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CandidateReadOutcome {
    Bytes { bytes: Vec<u8>, sha256: String },
    Empty,
    TooManyGames,
    TooLarge,
    InvalidPgn,
    Deferred,
    Unreadable,
}

fn database_revision_string(identity: &DatabaseIdentity) -> String {
    let modified = match identity.modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => format!("{}:{}", d.as_secs(), d.subsec_nanos()),
        Err(e) => {
            let d = e.duration();
            format!("-{}:{}", d.as_secs(), d.subsec_nanos())
        }
    };
    format!(
        "db:{}:{}:{}:{}:{}",
        identity.object.0, identity.object.1, identity.length, modified, identity.data_revision
    )
}

struct WalkedFile {
    handle: FileWorkspaceHandle,
    locator: Vec<OsString>,
    name: String,
    folder_label: String,
    kind: LibraryFileKind,
    read_error: bool,
}

struct WalkContext<'a> {
    authority: &'a SharedPathAuthority,
    workspace: &'a FileWorkspaceHandle,
    excluded_handles: &'a HashSet<FileWorkspaceHandle>,
    excluded_locators: &'a HashSet<Vec<OsString>>,
    folder_parts: Vec<String>,
    out: Vec<WalkedFile>,
    incomplete: bool,
}

fn collect_walked_files(entries: &[WorkspaceEntry], ctx: &mut WalkContext<'_>) {
    for entry in entries {
        match entry.kind {
            WorkspaceEntryKind::Directory => {
                if entry.read_error.is_some() {
                    ctx.incomplete = true;
                }
                ctx.folder_parts.push(entry.name.clone());
                collect_walked_files(&entry.children, ctx);
                ctx.folder_parts.pop();
            }
            WorkspaceEntryKind::File => {
                if ctx.excluded_handles.contains(&entry.handle) {
                    continue;
                }
                let locator = match crate::db::linked_collections::relative_locator(
                    ctx.authority,
                    ctx.workspace,
                    &entry.handle,
                ) {
                    Ok(locator) => locator,
                    Err(error) => {
                        // A candidate whose locator cannot be resolved makes the scan incomplete so
                        // absence deletion and pruning never run on a partial observation.
                        log::warn!("library sync could not resolve relative locator: {error}");
                        ctx.incomplete = true;
                        continue;
                    }
                };
                if ctx.excluded_locators.contains(&locator) {
                    continue;
                }
                let kind = kind_for_file_type(entry.metadata.as_ref().map(|m| &m.file_type));
                ctx.out.push(WalkedFile {
                    handle: entry.handle.clone(),
                    locator,
                    name: entry.name.clone(),
                    folder_label: ctx.folder_parts.join("/"),
                    kind,
                    read_error: entry.read_error.is_some(),
                });
            }
        }
    }
}

fn hash_file_bounded(
    file: &mut impl Read,
    token: &CancellationToken,
) -> Result<Option<String>, Error> {
    let mut hasher = Sha256::new();
    let mut total: u64 = 0;
    let mut buf = [0u8; HASH_CHUNK_BYTES];
    loop {
        if token.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        total = total.saturating_add(n as u64);
        if total > LIBRARY_MAX_BYTES {
            return Ok(None);
        }
        hasher.update(&buf[..n]);
    }
    Ok(Some(format!("{:x}", hasher.finalize())))
}

/// Walks the Library folder under `workspace_mutation`, excludes account-linked collection
/// histories, hashes files outside the lock only when their revision changed, and lists standalone
/// game databases from the active Databases root.
///
/// A PGN walk error still fails the whole scan (yielding `FolderUnavailable`). A database-root
/// listing error or failed migration wait omits database candidates and marks `databases_complete`
/// false without failing the PGN side.
#[allow(clippy::too_many_arguments)]
pub(crate) fn scan_workspace_blocking(
    authority: &SharedPathAuthority,
    workspace_mutation: &Mutex<()>,
    workspace: &FileWorkspaceHandle,
    database_repository: &DatabaseRepository,
    db_migration_ready: bool,
    db_export_policy: DatabaseExportPolicy<'_>,
    hash_cache: &HashMap<(SyncSource, Vec<OsString>), (String, String)>,
    token: &CancellationToken,
) -> Result<ScanResult, Error> {
    let listing = {
        let _guard = crate::infra::cancellable_lock::lock_std_cancellable(
            workspace_mutation,
            token,
            "workspace mutation lock was poisoned",
        )?;
        let (listing, _missing) =
            crate::file_workspace::collect_tree_entries(authority, workspace, token)?;
        listing
    };

    let (excluded_handles, excluded_locators) = match authority.collections()? {
        Some(collections) => collections.account_linked_files(authority, workspace, token)?,
        None => (HashSet::new(), HashSet::new()),
    };

    let mut ctx = WalkContext {
        authority,
        workspace,
        excluded_handles: &excluded_handles,
        excluded_locators: &excluded_locators,
        folder_parts: Vec::new(),
        out: Vec::new(),
        incomplete: false,
    };
    collect_walked_files(&listing.entries, &mut ctx);

    let files_complete = listing.unread.is_empty() && !ctx.incomplete;
    let mut candidates = Vec::with_capacity(ctx.out.len());
    let mut updated_hash_cache = HashMap::with_capacity(ctx.out.len());

    for item in ctx.out {
        if token.is_cancelled() {
            return Err(Error::Cancellation);
        }
        // Normalise from the raw leaf (last locator component) because `WorkspaceEntry.name` has
        // already been stripped of `.pgn` by `collect_tree_entries` (S-4).
        let raw_leaf = item
            .locator
            .last()
            .map(|leaf| leaf.to_string_lossy())
            .unwrap_or(Cow::Borrowed(&item.name));
        let normalized_name = normalize_library_name(&raw_leaf);
        let cache_key = (SyncSource::File, item.locator.clone());

        let (revision, content_sha256, oversized, unreadable) = if item.read_error {
            (None, None, false, true)
        } else {
            let snapshot = authority
                .with_mut(|auth| {
                    auth.ensure_pgn_not_trashed(&item.handle)?;
                    auth.resolve(item.handle.path_ref(), PathOperation::ReadPgn, &[])?
                        .pgn_snapshot()
                })
                .and_then(|res| {
                    res.map_err(|_| {
                        crate::infra::path_authority::AuthorityUnavailable::Uninitialized
                    })
                });
            match snapshot {
                Err(_) => (None, None, false, true),
                Ok(mut snapshot) => {
                    let revision = crate::pgn::revision_string(&snapshot);
                    if snapshot.revision.size > LIBRARY_MAX_BYTES {
                        (Some(revision), None, true, false)
                    } else if let Some((_, cached_hash)) = hash_cache
                        .get(&cache_key)
                        .filter(|(cached_rev, _)| cached_rev == &revision)
                    {
                        updated_hash_cache
                            .insert(cache_key, (revision.clone(), cached_hash.clone()));
                        (Some(revision), Some(cached_hash.clone()), false, false)
                    } else {
                        match hash_file_bounded(&mut snapshot.file, token) {
                            Ok(Some(sha)) => {
                                updated_hash_cache
                                    .insert(cache_key, (revision.clone(), sha.clone()));
                                (Some(revision), Some(sha), false, false)
                            }
                            Ok(None) => (Some(revision), None, true, false),
                            Err(Error::Cancellation) => return Err(Error::Cancellation),
                            Err(_) => (Some(revision), None, false, true),
                        }
                    }
                }
            }
        };

        candidates.push(ScannedCandidate {
            source: SyncSource::File,
            handle: LibrarySyncHandle::File(item.handle),
            locator: item.locator,
            name: item.name,
            normalized_name,
            folder_label: item.folder_label,
            kind: item.kind,
            revision,
            content_sha256,
            oversized,
            unreadable,
            too_many_games: false,
            empty: false,
            invalid_pgn: false,
            deferred: false,
        });
    }

    let databases_complete = scan_databases_into(
        authority,
        database_repository,
        db_migration_ready,
        &db_export_policy,
        hash_cache,
        &mut updated_hash_cache,
        &mut candidates,
        token,
    )?;

    Ok(ScanResult {
        candidates,
        files_complete,
        databases_complete,
        updated_hash_cache,
    })
}

#[allow(clippy::too_many_arguments)]
fn scan_databases_into(
    authority: &SharedPathAuthority,
    database_repository: &DatabaseRepository,
    db_migration_ready: bool,
    db_export_policy: &DatabaseExportPolicy<'_>,
    hash_cache: &HashMap<(SyncSource, Vec<OsString>), (String, String)>,
    updated_hash_cache: &mut HashMap<(SyncSource, Vec<OsString>), (String, String)>,
    candidates: &mut Vec<ScannedCandidate>,
    token: &CancellationToken,
) -> Result<bool, Error> {
    if !db_migration_ready {
        return Ok(false);
    }
    if token.is_cancelled() {
        return Err(Error::Cancellation);
    }

    let active_root = match authority.with_mut(|auth| auth.active_database_root()) {
        Ok(Ok(Some(root))) => root,
        Ok(Ok(None)) => return Ok(true),
        Ok(Err(error)) => {
            log::warn!("library sync active database root lookup failed: {error}");
            return Ok(false);
        }
        Err(error) => {
            log::warn!("library sync path authority unavailable for databases: {error:?}");
            return Ok(false);
        }
    };

    let db_listing = match crate::workspace_commands::list_workspace_databases_blocking(
        authority,
        active_root,
        token,
    ) {
        Ok(listing) => listing,
        Err(Error::Cancellation) => return Err(Error::Cancellation),
        Err(error) => {
            log::warn!("library sync database root listing failed: {error}");
            return Ok(false);
        }
    };

    let mut databases_complete = db_listing.unread.is_empty();

    for descriptor in db_listing.entries {
        if token.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let target =
            match resolve_database(authority, &descriptor.handle, PathOperation::DatabaseRead) {
                Ok(target) => target,
                Err(Error::Cancellation) => return Err(Error::Cancellation),
                Err(error) => {
                    log::warn!(
                        "library sync could not resolve database {}: {error}",
                        descriptor.filename
                    );
                    databases_complete = false;
                    continue;
                }
            };

        let locator = vec![target.leaf().to_os_string()];
        let handle = LibrarySyncHandle::Database(descriptor.handle.clone());

        if descriptor.availability != PathAvailability::Available {
            let display_name = descriptor.filename;
            let normalized_name = normalize_library_name(&display_name);
            candidates.push(ScannedCandidate {
                source: SyncSource::Database,
                handle,
                locator,
                name: display_name,
                normalized_name,
                folder_label: String::new(),
                kind: LibraryFileKind::Games,
                revision: None,
                content_sha256: None,
                oversized: false,
                unreadable: true,
                too_many_games: false,
                empty: false,
                invalid_pgn: false,
                deferred: false,
            });
            continue;
        }

        let cheap_info =
            read_cheap_database_info(database_repository, &target, LIBRARY_MAX_GAMES, token)?;

        let mut display_name = descriptor.filename;
        let mut revision: Option<String> = None;
        let mut content_sha256: Option<String> = None;
        let mut oversized = false;
        let mut unreadable = false;
        let mut too_many_games = false;
        let mut empty = false;
        let mut invalid_pgn = false;
        let mut deferred = false;

        match cheap_info {
            CheapDatabaseInfo::Eligible {
                identity, title, ..
            } => {
                if let Some(title) = title {
                    display_name = title;
                }
                let rev = database_revision_string(&identity);
                revision = Some(rev.clone());
                if db_export_policy.should_export(&handle, &locator) {
                    let cache_key = (SyncSource::Database, locator.clone());
                    if let Some((_, cached_hash)) = hash_cache
                        .get(&cache_key)
                        .filter(|(cached_rev, _)| cached_rev == &rev)
                    {
                        updated_hash_cache.insert(cache_key, (rev, cached_hash.clone()));
                        content_sha256 = Some(cached_hash.clone());
                    } else {
                        match export_resolved_database_bounded(
                            authority,
                            database_repository,
                            &descriptor.handle,
                            token,
                        )? {
                            BoundedDatabaseExport::Exported { sha256, .. } => {
                                updated_hash_cache.insert(cache_key, (rev, sha256.clone()));
                                content_sha256 = Some(sha256);
                            }
                            BoundedDatabaseExport::Empty => empty = true,
                            BoundedDatabaseExport::TooManyGames => too_many_games = true,
                            BoundedDatabaseExport::TooLarge => oversized = true,
                            BoundedDatabaseExport::InvalidPgn => invalid_pgn = true,
                            BoundedDatabaseExport::Deferred => deferred = true,
                            BoundedDatabaseExport::Unreadable => unreadable = true,
                        }
                    }
                }
            }
            CheapDatabaseInfo::Empty { identity, title } => {
                if let Some(title) = title {
                    display_name = title;
                }
                revision = Some(database_revision_string(&identity));
                empty = true;
            }
            CheapDatabaseInfo::TooManyGames {
                identity, title, ..
            } => {
                if let Some(title) = title {
                    display_name = title;
                }
                revision = Some(database_revision_string(&identity));
                too_many_games = true;
            }
            CheapDatabaseInfo::Deferred => {
                deferred = true;
            }
            CheapDatabaseInfo::Unreadable => {
                unreadable = true;
            }
        }

        let normalized_name = normalize_library_name(&display_name);
        candidates.push(ScannedCandidate {
            source: SyncSource::Database,
            handle,
            locator,
            name: display_name,
            normalized_name,
            folder_label: String::new(),
            kind: LibraryFileKind::Games,
            revision,
            content_sha256,
            oversized,
            unreadable,
            too_many_games,
            empty,
            invalid_pgn,
            deferred,
        });
    }

    Ok(databases_complete)
}

fn export_resolved_database_bounded(
    authority: &SharedPathAuthority,
    database_repository: &DatabaseRepository,
    db_handle: &DatabaseHandle,
    token: &CancellationToken,
) -> Result<BoundedDatabaseExport, Error> {
    let target = match resolve_database(authority, db_handle, PathOperation::DatabaseExport) {
        Ok(target) => target,
        Err(Error::Cancellation) => return Err(Error::Cancellation),
        Err(error) if is_deferred_database_error(&error) => {
            return Ok(BoundedDatabaseExport::Deferred);
        }
        Err(error) => {
            log::warn!(
                "library sync could not resolve database {} for export: {error}",
                db_handle.path_ref().id
            );
            return Ok(BoundedDatabaseExport::Unreadable);
        }
    };
    export_database_pgn_bounded(
        database_repository,
        &target,
        LIBRARY_MAX_GAMES,
        LIBRARY_MAX_BYTES,
        token,
    )
}

/// Reads or exports the exact PGN bytes of one candidate for upload, bounded to `LIBRARY_MAX_BYTES`
/// (and `LIBRARY_MAX_GAMES` for databases).
pub(crate) fn read_candidate_bytes_blocking(
    authority: &SharedPathAuthority,
    database_repository: &DatabaseRepository,
    handle: &LibrarySyncHandle,
    token: &CancellationToken,
) -> Result<CandidateReadOutcome, Error> {
    match handle {
        LibrarySyncHandle::File(file_handle) => {
            let mut snapshot = authority.with_mut(|auth| {
                auth.ensure_pgn_not_trashed(file_handle)?;
                auth.resolve(file_handle.path_ref(), PathOperation::ReadPgn, &[])?
                    .pgn_snapshot()
            })??;
            if snapshot.revision.size > LIBRARY_MAX_BYTES {
                return Ok(CandidateReadOutcome::TooLarge);
            }
            let mut bytes =
                Vec::with_capacity(snapshot.revision.size.min(LIBRARY_MAX_BYTES) as usize);
            let mut buf = [0u8; HASH_CHUNK_BYTES];
            loop {
                if token.is_cancelled() {
                    return Err(Error::Cancellation);
                }
                let n = snapshot.file.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                if bytes.len().saturating_add(n) as u64 > LIBRARY_MAX_BYTES {
                    return Ok(CandidateReadOutcome::TooLarge);
                }
                bytes.extend_from_slice(&buf[..n]);
            }
            let sha256 = format!("{:x}", Sha256::digest(&bytes));
            Ok(CandidateReadOutcome::Bytes { bytes, sha256 })
        }
        LibrarySyncHandle::Database(db_handle) => {
            match export_resolved_database_bounded(
                authority,
                database_repository,
                db_handle,
                token,
            )? {
                BoundedDatabaseExport::Exported { bytes, sha256 } => {
                    Ok(CandidateReadOutcome::Bytes { bytes, sha256 })
                }
                BoundedDatabaseExport::Empty => Ok(CandidateReadOutcome::Empty),
                BoundedDatabaseExport::TooManyGames => Ok(CandidateReadOutcome::TooManyGames),
                BoundedDatabaseExport::TooLarge => Ok(CandidateReadOutcome::TooLarge),
                BoundedDatabaseExport::InvalidPgn => Ok(CandidateReadOutcome::InvalidPgn),
                BoundedDatabaseExport::Deferred => Ok(CandidateReadOutcome::Deferred),
                BoundedDatabaseExport::Unreadable => Ok(CandidateReadOutcome::Unreadable),
            }
        }
    }
}

/// Pure read-only identity passes 1 to 3 (handle, locator, content hash) over existing state
/// entries of the same `source`. Returns per-candidate matched entry ids and the set of claimed
/// entry ids.
fn match_existing_entries(
    candidates: &[ScannedCandidate],
    entries: &BTreeMap<String, SyncEntry>,
) -> (Vec<Option<String>>, HashSet<String>) {
    let mut matched_ids: Vec<Option<String>> = vec![None; candidates.len()];
    let mut claimed_entries: HashSet<String> = HashSet::new();

    // Pass 1: handle match (same source).
    for (idx, candidate) in candidates.iter().enumerate() {
        if let Some((id, _)) = entries.iter().find(|(id, entry)| {
            !claimed_entries.contains(*id)
                && entry.source == candidate.source
                && entry.handle.as_ref() == Some(&candidate.handle)
        }) {
            let id = id.clone();
            claimed_entries.insert(id.clone());
            matched_ids[idx] = Some(id);
        }
    }

    // Pass 2: locator match (same source).
    for (idx, candidate) in candidates.iter().enumerate() {
        if matched_ids[idx].is_some() {
            continue;
        }
        if let Some((id, _)) = entries.iter().find(|(id, entry)| {
            !claimed_entries.contains(*id)
                && entry.source == candidate.source
                && entry.locator == candidate.locator
        }) {
            let id = id.clone();
            claimed_entries.insert(id.clone());
            matched_ids[idx] = Some(id);
        }
    }

    // Pass 3: content hash match against unmatched entries of the same source.
    for (idx, candidate) in candidates.iter().enumerate() {
        if matched_ids[idx].is_some() {
            continue;
        }
        let Some(sha) = candidate.content_sha256.as_deref() else {
            continue;
        };
        if let Some((id, _)) = entries.iter().find(|(id, entry)| {
            !claimed_entries.contains(*id)
                && entry.source == candidate.source
                && entry.last_content_sha256.as_deref() == Some(sha)
        }) {
            let id = id.clone();
            claimed_entries.insert(id.clone());
            matched_ids[idx] = Some(id);
        }
    }

    (matched_ids, claimed_entries)
}

/// Pure predicate reporting whether any entry in `state.entries` belonging to a completely scanned
/// source is left unmatched by `candidates` under identity passes 1 to 3.
pub(crate) fn has_unmatched_entries(
    candidates: &[ScannedCandidate],
    state: &SyncState,
    files_complete: bool,
    databases_complete: bool,
) -> bool {
    let (_, claimed_entries) = match_existing_entries(candidates, &state.entries);
    state.entries.iter().any(|(id, entry)| {
        let source_complete = match entry.source {
            SyncSource::File => files_complete,
            SyncSource::Database => databases_complete,
        };
        source_complete && !claimed_entries.contains(id)
    })
}

/// Five-pass identity matcher (S-3). Returns the matched `studio_file_id` for each candidate in
/// `candidates` (same index order), mutating `state.entries` in place.
///
/// Passes run in path order, each only over candidates and entries of the same source still
/// unmatched:
/// 1. handle match (in-session rename or move inside Studio)
/// 2. locator match (after restart)
/// 3. last content hash match (rename or move outside Studio / while closed)
/// 4. server file with same `content_sha256` whose id no entry holds (adoption)
/// 5. new entry with a new UUID v4: gate-failing databases default to `selected: false` unless
///    present in `initial_selected_*`; other candidates default to `selected: true` unless in
///    `initial_deselected_*`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn match_candidates_to_entries(
    candidates: &[ScannedCandidate],
    state: &mut SyncState,
    server_files: Option<&[StudioLibraryFile]>,
    files_complete: bool,
    databases_complete: bool,
    can_increment_file_missed: bool,
    can_increment_db_missed: bool,
    initial_deselected_handles: &HashSet<LibrarySyncHandle>,
    initial_deselected_locators: &HashSet<Vec<OsString>>,
    initial_selected_handles: &HashSet<LibrarySyncHandle>,
    initial_selected_locators: &HashSet<Vec<OsString>>,
) -> Vec<Option<String>> {
    let (mut matched_ids, mut claimed_entries) = match_existing_entries(candidates, &state.entries);

    // Update all entries matched in passes 1-3.
    for (idx, candidate) in candidates.iter().enumerate() {
        if let Some(id) = matched_ids[idx].as_ref() {
            if let Some(entry) = state.entries.get_mut(id) {
                entry.handle = Some(candidate.handle.clone());
                entry.locator = candidate.locator.clone();
                entry.missed_scans = 0;
                if let Some(sha) = candidate.content_sha256.as_ref() {
                    entry.last_content_sha256 = Some(sha.clone());
                }
            }
        }
    }

    let is_initially_deselected = |candidate: &ScannedCandidate| {
        initial_deselected_handles.contains(&candidate.handle)
            || initial_deselected_locators.contains(&candidate.locator)
    };
    let is_initially_selected = |candidate: &ScannedCandidate| {
        initial_selected_handles.contains(&candidate.handle)
            || initial_selected_locators.contains(&candidate.locator)
    };

    // Pass 4: adopt a server file with matching `content_sha256` whose id no entry holds.
    if let Some(server_files) = server_files {
        for (idx, candidate) in candidates.iter().enumerate() {
            if matched_ids[idx].is_some() || state.entries.len() >= MAX_STATE_ENTRIES {
                continue;
            }
            let Some(sha) = candidate.content_sha256.as_deref() else {
                continue;
            };
            if let Some(server_file) = server_files.iter().find(|sf| {
                is_valid_studio_file_id(&sf.studio_file_id)
                    && !state.entries.contains_key(&sf.studio_file_id)
                    && sf.content_sha256.as_deref() == Some(sha)
            }) {
                let id = server_file.studio_file_id.clone();
                let selected = !is_initially_deselected(candidate);
                state.entries.insert(
                    id.clone(),
                    SyncEntry {
                        source: candidate.source,
                        locator: candidate.locator.clone(),
                        handle: Some(candidate.handle.clone()),
                        selected,
                        last_content_sha256: Some(sha.to_owned()),
                        missed_scans: 0,
                        last_rejection: None,
                    },
                );
                claimed_entries.insert(id.clone());
                matched_ids[idx] = Some(id);
            }
        }
    }

    // Pass 5: mint a new UUID v4 entry for each remaining candidate.
    for (idx, candidate) in candidates.iter().enumerate() {
        if matched_ids[idx].is_some() || state.entries.len() >= MAX_STATE_ENTRIES {
            continue;
        }
        let id = uuid::Uuid::new_v4().hyphenated().to_string();
        let selected = if candidate.fails_cheap_gate() {
            is_initially_selected(candidate)
        } else {
            !is_initially_deselected(candidate)
        };
        state.entries.insert(
            id.clone(),
            SyncEntry {
                source: candidate.source,
                locator: candidate.locator.clone(),
                handle: Some(candidate.handle.clone()),
                selected,
                last_content_sha256: candidate.content_sha256.clone(),
                missed_scans: 0,
                last_rejection: None,
            },
        );
        claimed_entries.insert(id.clone());
        matched_ids[idx] = Some(id);
    }

    // Missed-scan accounting and pruning for unmatched entries, gated per source.
    for (id, entry) in &mut state.entries {
        if claimed_entries.contains(id) {
            continue;
        }
        let (source_complete, can_inc) = match entry.source {
            SyncSource::File => (files_complete, can_increment_file_missed),
            SyncSource::Database => (databases_complete, can_increment_db_missed),
        };
        if source_complete && can_inc {
            entry.missed_scans = entry.missed_scans.saturating_add(1);
        }
    }
    if let Some(server_files) = server_files {
        let server_ids: HashSet<&str> = server_files
            .iter()
            .map(|sf| sf.studio_file_id.as_str())
            .collect();
        state.entries.retain(|id, entry| {
            let source_complete = match entry.source {
                SyncSource::File => files_complete,
                SyncSource::Database => databases_complete,
            };
            !source_complete
                || claimed_entries.contains(id)
                || entry.missed_scans < ABSENCE_DELETE_THRESHOLD
                || server_ids.contains(id.as_str())
        });
    }

    matched_ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::path_authority::{PathAuthority, PathClass, PathRef};
    use std::time::Duration;

    fn cand(handle: &str, locator: &str, sha: Option<&str>) -> ScannedCandidate {
        ScannedCandidate {
            source: SyncSource::File,
            handle: LibrarySyncHandle::File(FileWorkspaceHandle::new(PathRef {
                id: handle.to_owned(),
            })),
            locator: vec![OsString::from(locator)],
            name: locator.to_owned(),
            normalized_name: normalize_library_name(locator),
            folder_label: String::new(),
            kind: LibraryFileKind::Games,
            revision: Some("rev-1".into()),
            content_sha256: sha.map(str::to_owned),
            oversized: false,
            unreadable: false,
            too_many_games: false,
            empty: false,
            invalid_pgn: false,
            deferred: false,
        }
    }

    fn setup_workspace(
        files: &[(&str, &[u8])],
    ) -> (tempfile::TempDir, SharedPathAuthority, FileWorkspaceHandle) {
        let temp = tempfile::tempdir().unwrap();
        let workspace_dir = temp.path().join("library");
        std::fs::create_dir_all(&workspace_dir).unwrap();
        for (name, bytes) in files {
            let path = workspace_dir.join(name);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&path, bytes).unwrap();
        }
        let authority = SharedPathAuthority::uninitialized();
        let mut pa = PathAuthority::open(temp.path().join("path-authority.json"), vec![]).unwrap();
        let grant = pa
            .grant_dialog_operations(
                &workspace_dir,
                "Library",
                PathClass::BoundedDialogGrant,
                vec![PathOperation::ReadPgn, PathOperation::WritePgn],
                Duration::from_secs(60),
                1,
            )
            .unwrap();
        let committed = pa
            .promote_dialog(
                &grant,
                PathClass::PersistentCustomRoot,
                "Library",
                vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            )
            .unwrap();
        authority.install(pa).unwrap();
        (temp, authority, FileWorkspaceHandle::new(committed.id))
    }

    #[test]
    fn name_normalisation_matches_server_rules() {
        assert_eq!(normalize_library_name("Sicilian.pgn"), "Sicilian");
        assert_eq!(normalize_library_name("foo.pgn.pgn"), "foo.pgn");
        assert_eq!(normalize_library_name("  Sicilian.PGN  "), "Sicilian.PGN");
        assert_eq!(normalize_library_name("  Sicilian .PGN"), "Sicilian");
        assert_eq!(normalize_library_name(".pgn"), ".pgn");
        assert_eq!(normalize_library_name(" .pgn"), ".pgn");
        assert_eq!(normalize_library_name("   .PGN"), ".PGN");
        let long = format!("{}   .pgn", "ä".repeat(125));
        let norm = normalize_library_name(&long);
        assert_eq!(norm.chars().count(), 120);
        let padded = format!("{}   {}", "a".repeat(118), "b".repeat(10));
        let norm_padded = normalize_library_name(&padded);
        assert_eq!(norm_padded, "a".repeat(118));
    }

    #[test]
    fn scan_normalises_from_raw_leaf_for_double_extension_and_space_pgn() {
        let (_temp, authority, workspace) =
            setup_workspace(&[("foo.pgn.pgn", b"1. e4 e5 *\n"), (" .pgn", b"1. d4 d5 *\n")]);
        let mutation = Mutex::new(());
        let db_repo = DatabaseRepository::default();
        let result = scan_workspace_blocking(
            &authority,
            &mutation,
            &workspace,
            &db_repo,
            true,
            DatabaseExportPolicy::CheapInfoOnly,
            &HashMap::new(),
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(result.complete());
        let names: HashMap<String, String> = result
            .candidates
            .iter()
            .map(|c| {
                (
                    c.locator.last().unwrap().to_string_lossy().into_owned(),
                    c.normalized_name.clone(),
                )
            })
            .collect();
        assert_eq!(
            names.get("foo.pgn.pgn").map(String::as_str),
            Some("foo.pgn")
        );
        assert_eq!(names.get(" .pgn").map(String::as_str), Some(".pgn"));
    }

    #[test]
    fn scan_marks_oversized_file_without_reading_it() {
        let oversized = vec![b' '; (LIBRARY_MAX_BYTES + 1) as usize];
        let (_temp, authority, workspace) =
            setup_workspace(&[("big.pgn", &oversized), ("small.pgn", b"1. e4 *\n")]);
        let mutation = Mutex::new(());
        let db_repo = DatabaseRepository::default();
        let result = scan_workspace_blocking(
            &authority,
            &mutation,
            &workspace,
            &db_repo,
            true,
            DatabaseExportPolicy::CheapInfoOnly,
            &HashMap::new(),
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(result.complete());
        let big = result
            .candidates
            .iter()
            .find(|c| c.normalized_name == "big")
            .unwrap();
        assert!(big.oversized);
        assert!(!big.unreadable);
        assert!(big.content_sha256.is_none());
        let read = read_candidate_bytes_blocking(
            &authority,
            &db_repo,
            &big.handle,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(read, CandidateReadOutcome::TooLarge);
    }

    #[test]
    fn unresolvable_relative_locator_marks_scan_incomplete() {
        let (_temp, authority, workspace) = setup_workspace(&[("ok.pgn", b"1. e4 *\n")]);
        let bogus_handle = FileWorkspaceHandle::new(PathRef {
            id: "missing-handle".to_owned(),
        });
        let entries = vec![WorkspaceEntry {
            handle: bogus_handle,
            kind: WorkspaceEntryKind::File,
            name: "ghost".into(),
            children: vec![],
            metadata: None,
            read_error: None,
            game_count: None,
            last_modified: 0,
        }];
        let excluded_handles = HashSet::new();
        let excluded_locators = HashSet::new();
        let mut ctx = WalkContext {
            authority: &authority,
            workspace: &workspace,
            excluded_handles: &excluded_handles,
            excluded_locators: &excluded_locators,
            folder_parts: Vec::new(),
            out: Vec::new(),
            incomplete: false,
        };
        collect_walked_files(&entries, &mut ctx);
        assert!(ctx.incomplete);
        assert!(ctx.out.is_empty());
    }

    #[test]
    fn without_collection_service_nothing_is_excluded() {
        let (_temp, authority, workspace) =
            setup_workspace(&[("mine.pgn", b"1. e4 *\n"), ("history.pgn", b"1. d4 *\n")]);
        let mutation = Mutex::new(());
        let db_repo = DatabaseRepository::default();
        let result = scan_workspace_blocking(
            &authority,
            &mutation,
            &workspace,
            &db_repo,
            true,
            DatabaseExportPolicy::CheapInfoOnly,
            &HashMap::new(),
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(result.candidates.len(), 2);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn scan_excludes_account_linked_collection_and_keeps_plain_collection() {
        use crate::{
            db::linked_collections::{AccountIdentity, CollectionService},
            infra::path_authority::{
                ensure_app_owned_default_dir, AppDataDir, AppOwnedDefaultRoot,
            },
            pgn::PgnRepository,
            SearchCache,
        };
        use std::sync::Arc;

        let (temp, authority, workspace) = setup_workspace(&[
            (
                "mine.pgn",
                b"[Event \"Club\"]\n[Result \"*\"]\n\n1. e4 e5 *\n",
            ),
            ("mine.info", br#"{"type":"game","tags":[]}"#),
            (
                "history.pgn",
                b"[Event \"Online\"]\n[Result \"*\"]\n\n1. d4 d5 *\n",
            ),
            ("history.info", br#"{"type":"game","tags":[]}"#),
        ]);
        let app_data = AppDataDir::for_test(temp.path());
        let collections_root =
            ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Collections).unwrap();
        let workspace_mutation = Arc::new(Mutex::new(()));
        let service = CollectionService::open(
            collections_root,
            Arc::clone(&workspace_mutation),
            Arc::new(crate::db::DatabaseRepository::default()),
            Arc::new(SearchCache::default()),
            PgnRepository::default(),
        );
        let token = CancellationToken::new();
        let (listing, _, _) = service.discover(&authority, &workspace, &token).unwrap();
        let history_handle = listing
            .entries
            .iter()
            .find(|e| e.name == "history")
            .unwrap()
            .handle
            .clone();
        service
            .set_test_record_account(
                &workspace,
                &history_handle,
                AccountIdentity {
                    provider: "lichess".into(),
                    account: "alice".into(),
                },
            )
            .unwrap();
        authority.install_collections(service).unwrap();

        let db_repo = DatabaseRepository::default();
        let result = scan_workspace_blocking(
            &authority,
            &workspace_mutation,
            &workspace,
            &db_repo,
            true,
            DatabaseExportPolicy::CheapInfoOnly,
            &HashMap::new(),
            &token,
        )
        .unwrap();
        assert!(result.complete());
        let names: Vec<&str> = result
            .candidates
            .iter()
            .map(|c| c.normalized_name.as_str())
            .collect();
        assert_eq!(names, vec!["mine"]);
    }

    #[test]
    fn pass_2_matches_by_locator_without_session_handle_even_when_content_changed() {
        let mut state = SyncState::off();
        let id = "11111111-1111-4111-8111-111111111111";
        state.entries.insert(
            id.into(),
            SyncEntry {
                source: SyncSource::File,
                locator: vec![OsString::from("repertoire.pgn")],
                handle: None,
                selected: true,
                last_content_sha256: Some("old-sha".into()),
                missed_scans: 0,
                last_rejection: None,
            },
        );
        let candidates = vec![cand(
            "new-session-handle",
            "repertoire.pgn",
            Some("new-sha"),
        )];
        let matched = match_candidates_to_entries(
            &candidates,
            &mut state,
            Some(&[]),
            true,
            true,
            true,
            true,
            &HashSet::new(),
            &HashSet::new(),
            &HashSet::new(),
            &HashSet::new(),
        );
        assert_eq!(matched[0].as_deref(), Some(id));
        assert_eq!(
            state.entries[id].last_content_sha256.as_deref(),
            Some("new-sha")
        );
    }

    #[test]
    fn rename_inside_studio_with_new_file_at_old_name_keeps_original_entry() {
        let mut state = SyncState::off();
        let old_handle = LibrarySyncHandle::File(FileWorkspaceHandle::new(PathRef {
            id: "h-1".to_owned(),
        }));
        state.entries.insert(
            "11111111-1111-4111-8111-111111111111".into(),
            SyncEntry {
                source: SyncSource::File,
                locator: vec![OsString::from("a.pgn")],
                handle: Some(old_handle),
                selected: false,
                last_content_sha256: Some("sha-a".into()),
                missed_scans: 0,
                last_rejection: None,
            },
        );
        let candidates = vec![
            cand("h-2", "a.pgn", Some("sha-new")),
            cand("h-1", "b.pgn", Some("sha-a")),
        ];
        let matched = match_candidates_to_entries(
            &candidates,
            &mut state,
            Some(&[]),
            true,
            true,
            true,
            true,
            &HashSet::new(),
            &HashSet::new(),
            &HashSet::new(),
            &HashSet::new(),
        );
        assert_eq!(
            matched[1].as_deref(),
            Some("11111111-1111-4111-8111-111111111111")
        );
        assert_ne!(
            matched[0].as_deref(),
            Some("11111111-1111-4111-8111-111111111111")
        );
        assert!(!state.entries["11111111-1111-4111-8111-111111111111"].selected);
        assert_eq!(
            state.entries["11111111-1111-4111-8111-111111111111"].locator,
            vec![OsString::from("b.pgn")]
        );
        assert!(state.entries[matched[0].as_ref().unwrap()].selected);
    }

    #[test]
    fn rename_outside_studio_keeps_entry_and_resets_missed_scans() {
        let mut state = SyncState::off();
        let id = "11111111-1111-4111-8111-111111111111";
        state.entries.insert(
            id.into(),
            SyncEntry {
                source: SyncSource::File,
                locator: vec![OsString::from("old.pgn")],
                handle: None,
                selected: false,
                last_content_sha256: Some("sha-1".into()),
                missed_scans: 1,
                last_rejection: None,
            },
        );
        let candidates = vec![cand("h-new", "renamed.pgn", Some("sha-1"))];
        let matched = match_candidates_to_entries(
            &candidates,
            &mut state,
            Some(&[]),
            true,
            true,
            true,
            true,
            &HashSet::new(),
            &HashSet::new(),
            &HashSet::new(),
            &HashSet::new(),
        );
        assert_eq!(matched[0].as_deref(), Some(id));
        assert_eq!(state.entries[id].missed_scans, 0);
        assert_eq!(
            state.entries[id].locator,
            vec![OsString::from("renamed.pgn")]
        );
        assert!(!state.entries[id].selected);
    }

    #[test]
    fn pass_4_adopts_server_file_and_duplicate_content_gets_distinct_ids() {
        let mut state = SyncState::off();
        let server_id = "22222222-2222-4222-8222-222222222222";
        let server = vec![StudioLibraryFile {
            studio_file_id: server_id.into(),
            name: "Copy1".into(),
            kind: LibraryFileKind::Games,
            version: 1,
            content_sha256: Some("dup-sha".into()),
        }];
        let candidates = vec![
            cand("h-1", "a.pgn", Some("dup-sha")),
            cand("h-2", "b.pgn", Some("dup-sha")),
        ];
        let matched = match_candidates_to_entries(
            &candidates,
            &mut state,
            Some(&server),
            true,
            true,
            true,
            true,
            &HashSet::new(),
            &HashSet::new(),
            &HashSet::new(),
            &HashSet::new(),
        );
        assert_eq!(matched[0].as_deref(), Some(server_id));
        assert!(matched[1].is_some());
        assert_ne!(matched[1].as_deref(), Some(server_id));
        assert_eq!(state.entries.len(), 2);
    }

    #[test]
    fn incomplete_scan_never_increments_missed_or_prunes() {
        let mut state = SyncState::off();
        let id = "11111111-1111-4111-8111-111111111111";
        state.entries.insert(
            id.into(),
            SyncEntry {
                source: SyncSource::File,
                locator: vec![OsString::from("missing.pgn")],
                handle: None,
                selected: false,
                last_content_sha256: Some("sha".into()),
                missed_scans: 1,
                last_rejection: None,
            },
        );
        match_candidates_to_entries(
            &[],
            &mut state,
            Some(&[]),
            false,
            true,
            true,
            true,
            &HashSet::new(),
            &HashSet::new(),
            &HashSet::new(),
            &HashSet::new(),
        );
        assert_eq!(state.entries[id].missed_scans, 1);
        assert!(state.entries.contains_key(id));
    }

    #[test]
    fn complete_scan_prunes_only_when_missed_twice_and_not_on_server() {
        let mut state = SyncState::off();
        let gone_id = "11111111-1111-4111-8111-111111111111";
        let server_id = "22222222-2222-4222-8222-222222222222";
        state.entries.insert(
            gone_id.into(),
            SyncEntry {
                source: SyncSource::File,
                locator: vec![OsString::from("a.pgn")],
                handle: None,
                selected: true,
                last_content_sha256: None,
                missed_scans: 1,
                last_rejection: None,
            },
        );
        state.entries.insert(
            server_id.into(),
            SyncEntry {
                source: SyncSource::File,
                locator: vec![OsString::from("b.pgn")],
                handle: None,
                selected: true,
                last_content_sha256: None,
                missed_scans: 1,
                last_rejection: None,
            },
        );
        let server = vec![StudioLibraryFile {
            studio_file_id: server_id.into(),
            name: "b".into(),
            kind: LibraryFileKind::Games,
            version: 1,
            content_sha256: None,
        }];
        match_candidates_to_entries(
            &[],
            &mut state,
            Some(&server),
            true,
            true,
            true,
            true,
            &HashSet::new(),
            &HashSet::new(),
            &HashSet::new(),
            &HashSet::new(),
        );
        assert!(!state.entries.contains_key(gone_id));
        assert!(state.entries.contains_key(server_id));
        assert_eq!(state.entries[server_id].missed_scans, 2);
    }

    #[test]
    fn has_unmatched_entries_matches_by_content_hash_and_detects_missing_with_equal_counts() {
        let mut state = SyncState::off();
        state.entries.insert(
            "11111111-1111-4111-8111-111111111111".into(),
            SyncEntry {
                source: SyncSource::File,
                locator: vec![OsString::from("old.pgn")],
                handle: None,
                selected: true,
                last_content_sha256: Some("sha-alpha".into()),
                missed_scans: 0,
                last_rejection: None,
            },
        );

        let renamed_same_hash = cand("handle-renamed", "renamed.pgn", Some("sha-alpha"));
        assert!(!has_unmatched_entries(
            &[renamed_same_hash],
            &state,
            true,
            true
        ));

        let unrelated_new_file = cand("handle-new", "new.pgn", Some("sha-beta"));
        assert!(has_unmatched_entries(
            &[unrelated_new_file],
            &state,
            true,
            true
        ));
    }

    #[test]
    fn untagged_handle_serializes_as_underlying_capability_object() {
        use crate::infra::path_authority::DatabaseHandle;

        let file = LibrarySyncHandle::File(FileWorkspaceHandle::new(PathRef {
            id: "file-1".to_owned(),
        }));
        let file_json = serde_json::to_value(&file).unwrap();
        assert_eq!(
            file_json,
            serde_json::json!({ "id": { "id": "file-1" }, "kind": "fileWorkspace" })
        );
        assert_eq!(
            serde_json::from_value::<LibrarySyncHandle>(file_json).unwrap(),
            file
        );

        let db = LibrarySyncHandle::Database(DatabaseHandle::new(PathRef {
            id: "db-1".to_owned(),
        }));
        let db_json = serde_json::to_value(&db).unwrap();
        assert_eq!(
            db_json,
            serde_json::json!({ "id": { "id": "db-1" }, "kind": "database" })
        );
        assert_eq!(
            serde_json::from_value::<LibrarySyncHandle>(db_json).unwrap(),
            db
        );
    }

    #[test]
    fn candidate_fingerprint_distinguishes_deferred_at_same_revision() {
        let mut active = cand("db-1", "busy.db3", Some("sha-1"));
        active.source = SyncSource::Database;
        active.handle = LibrarySyncHandle::Database(DatabaseHandle::new(PathRef {
            id: "db-1".to_owned(),
        }));
        active.name = "Busy DB".to_owned();
        active.normalized_name = normalize_library_name("Busy DB");
        active.revision = Some("db:1:2:4096:1700000000:0:1".to_owned());
        active.deferred = false;

        let mut deferred = active.clone();
        deferred.deferred = true;

        assert_ne!(active.fingerprint(), deferred.fingerprint());
        deferred.deferred = false;
        assert_eq!(active.fingerprint(), deferred.fingerprint());
    }

    #[test]
    fn match_existing_entries_never_matches_across_sync_source() {
        let mut entries = BTreeMap::new();
        // Entry for Pass 2 (same locator as Database candidate).
        entries.insert(
            "11111111-1111-4111-8111-111111111111".to_owned(),
            SyncEntry {
                source: SyncSource::File,
                locator: vec![OsString::from("personal.db3")],
                handle: Some(LibrarySyncHandle::File(FileWorkspaceHandle::new(PathRef {
                    id: "file-handle-1".to_owned(),
                }))),
                selected: true,
                last_content_sha256: Some("sha-file-only".to_owned()),
                missed_scans: 0,
                last_rejection: None,
            },
        );
        // Entry for Pass 3 (same content_sha256 as Database candidate).
        entries.insert(
            "22222222-2222-4222-8222-222222222222".to_owned(),
            SyncEntry {
                source: SyncSource::File,
                locator: vec![OsString::from("other.pgn")],
                handle: Some(LibrarySyncHandle::File(FileWorkspaceHandle::new(PathRef {
                    id: "file-handle-2".to_owned(),
                }))),
                selected: true,
                last_content_sha256: Some("sha-shared".to_owned()),
                missed_scans: 0,
                last_rejection: None,
            },
        );

        let mut db_same_locator = cand("db-handle-1", "personal.db3", Some("sha-db-1"));
        db_same_locator.source = SyncSource::Database;
        db_same_locator.handle = LibrarySyncHandle::Database(DatabaseHandle::new(PathRef {
            id: "db-handle-1".to_owned(),
        }));

        let mut db_same_hash = cand("db-handle-2", "different.db3", Some("sha-shared"));
        db_same_hash.source = SyncSource::Database;
        db_same_hash.handle = LibrarySyncHandle::Database(DatabaseHandle::new(PathRef {
            id: "db-handle-2".to_owned(),
        }));

        let (matched, claimed) = match_existing_entries(&[db_same_locator, db_same_hash], &entries);
        assert_eq!(matched, vec![None, None]);
        assert!(claimed.is_empty());
    }

    #[test]
    fn scan_lists_active_database_root_only_and_skips_collection_root_indexes() {
        use crate::{
            db::linked_collections::CollectionService,
            infra::path_authority::{
                ensure_app_owned_default_dir, AppDataDir, AppOwnedDefaultRoot, DatabaseRootHandle,
            },
            pgn::PgnRepository,
            SearchCache,
        };
        use diesel::{
            connection::SimpleConnection, sql_query, Connection, RunQueryDsl, SqliteConnection,
        };
        use std::sync::Arc;

        let (temp, authority, workspace) = setup_workspace(&[(
            "mine.pgn",
            b"[Event \"Club\"]\n[Result \"*\"]\n\n1. e4 e5 *\n",
        )]);
        let app_data = AppDataDir::for_test(temp.path());
        let collections_root =
            ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Collections).unwrap();
        let db_dir = temp.path().join("databases");
        std::fs::create_dir_all(&db_dir).unwrap();

        // Seed one standalone database in the active Databases root with a blank title (must fall
        // back to listing filename).
        let db_path = db_dir.join("personal.db3");
        {
            let mut conn = SqliteConnection::establish(db_path.to_str().unwrap()).unwrap();
            conn.batch_execute(include_str!("../db/create.sql"))
                .unwrap();
            sql_query("INSERT OR REPLACE INTO Info (Name, Value) VALUES ('Version', '2.4.0')")
                .execute(&mut conn)
                .unwrap();
            sql_query("INSERT OR REPLACE INTO Info (Name, Value) VALUES ('Title', '   ')")
                .execute(&mut conn)
                .unwrap();
            sql_query("INSERT OR REPLACE INTO Info (Name, Value) VALUES ('GameCount', '1')")
                .execute(&mut conn)
                .unwrap();
        }
        // Seed a second database inside Collections (must NOT be listed).
        let collection_db_path = collections_root.path().join("collection_index.db3");
        {
            let mut conn =
                SqliteConnection::establish(collection_db_path.to_str().unwrap()).unwrap();
            conn.batch_execute(include_str!("../db/create.sql"))
                .unwrap();
            sql_query("INSERT OR REPLACE INTO Info (Name, Value) VALUES ('Version', '2.4.0')")
                .execute(&mut conn)
                .unwrap();
            sql_query(
                "INSERT OR REPLACE INTO Info (Name, Value) VALUES ('Title', 'Collection Index')",
            )
            .execute(&mut conn)
            .unwrap();
            sql_query("INSERT OR REPLACE INTO Info (Name, Value) VALUES ('GameCount', '5')")
                .execute(&mut conn)
                .unwrap();
        }

        authority
            .with_mut(|pa| {
                let grant = pa
                    .grant_dialog_operations(
                        &db_dir,
                        "Databases",
                        PathClass::BoundedDialogGrant,
                        vec![
                            PathOperation::DatabaseRead,
                            PathOperation::DatabaseCreate,
                            PathOperation::DatabaseExport,
                            PathOperation::DatabaseMutate,
                        ],
                        Duration::from_secs(60),
                        1,
                    )
                    .unwrap();
                let committed = pa
                    .promote_dialog(
                        &grant,
                        PathClass::PersistentCustomRoot,
                        "Databases",
                        vec![
                            PathOperation::DatabaseRead,
                            PathOperation::DatabaseCreate,
                            PathOperation::DatabaseExport,
                            PathOperation::DatabaseMutate,
                        ],
                    )
                    .unwrap();
                let root = DatabaseRootHandle::new(committed.id);
                pa.set_active_database_root(&root).unwrap();
            })
            .unwrap();

        let workspace_mutation = Arc::new(Mutex::new(()));
        let db_repo = Arc::new(DatabaseRepository::default());
        let service = CollectionService::open(
            collections_root,
            Arc::clone(&workspace_mutation),
            Arc::clone(&db_repo),
            Arc::new(SearchCache::default()),
            PgnRepository::default(),
        );
        authority.install_collections(service).unwrap();

        let result = scan_workspace_blocking(
            &authority,
            &workspace_mutation,
            &workspace,
            &db_repo,
            true,
            DatabaseExportPolicy::CheapInfoOnly,
            &HashMap::new(),
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(result.files_complete);
        assert!(result.databases_complete);

        let db_candidates: Vec<&ScannedCandidate> = result
            .candidates
            .iter()
            .filter(|c| c.source == SyncSource::Database)
            .collect();
        assert_eq!(db_candidates.len(), 1);
        assert_eq!(
            db_candidates[0].locator,
            vec![OsString::from("personal.db3")]
        );
        assert_eq!(db_candidates[0].name, "personal.db3");
        assert!(db_candidates[0].folder_label.is_empty());
        assert_eq!(db_candidates[0].kind, LibraryFileKind::Games);
    }
}
