//! Workspace scanning, revision-gated hashing, name normalisation and 5-pass identity matching (S-3).

use crate::{
    error::Error,
    file_workspace::{WorkspaceEntry, WorkspaceEntryKind, WorkspaceFileType},
    infra::path_authority::{FileWorkspaceHandle, PathOperation, SharedPathAuthority},
    library_sync::{
        state::{SyncEntry, SyncState, MAX_STATE_ENTRIES},
        wire::{is_valid_studio_file_id, LibraryFileKind, StudioLibraryFile, LIBRARY_MAX_BYTES},
        ABSENCE_DELETE_THRESHOLD,
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
    pub locator: Vec<OsString>,
    pub name: String,
    pub kind: LibraryFileKind,
    pub revision: Option<String>,
    pub oversized: bool,
    pub unreadable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ScannedCandidate {
    pub handle: FileWorkspaceHandle,
    pub locator: Vec<OsString>,
    pub name: String,
    pub normalized_name: String,
    pub folder_label: String,
    pub kind: LibraryFileKind,
    pub revision: Option<String>,
    pub content_sha256: Option<String>,
    pub oversized: bool,
    pub unreadable: bool,
}

impl ScannedCandidate {
    pub(crate) fn fingerprint(&self) -> CandidateFingerprint {
        CandidateFingerprint {
            locator: self.locator.clone(),
            name: self.name.clone(),
            kind: self.kind,
            revision: self.revision.clone(),
            oversized: self.oversized,
            unreadable: self.unreadable,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ScanResult {
    pub candidates: Vec<ScannedCandidate>,
    pub complete: bool,
    pub updated_hash_cache: HashMap<Vec<OsString>, (String, String)>,
}

impl ScanResult {
    pub(crate) fn fingerprints(&self) -> Vec<CandidateFingerprint> {
        self.candidates
            .iter()
            .map(ScannedCandidate::fingerprint)
            .collect()
    }
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
/// histories, and hashes files outside the lock only when their revision changed.
pub(crate) fn scan_workspace_blocking(
    authority: &SharedPathAuthority,
    workspace_mutation: &Mutex<()>,
    workspace: &FileWorkspaceHandle,
    hash_cache: &HashMap<Vec<OsString>, (String, String)>,
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

    let complete = listing.unread.is_empty() && !ctx.incomplete;
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
                        .get(&item.locator)
                        .filter(|(cached_rev, _)| cached_rev == &revision)
                    {
                        updated_hash_cache.insert(
                            item.locator.clone(),
                            (revision.clone(), cached_hash.clone()),
                        );
                        (Some(revision), Some(cached_hash.clone()), false, false)
                    } else {
                        match hash_file_bounded(&mut snapshot.file, token) {
                            Ok(Some(sha)) => {
                                updated_hash_cache
                                    .insert(item.locator.clone(), (revision.clone(), sha.clone()));
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
            handle: item.handle,
            locator: item.locator,
            name: item.name,
            normalized_name,
            folder_label: item.folder_label,
            kind: item.kind,
            revision,
            content_sha256,
            oversized,
            unreadable,
        });
    }

    Ok(ScanResult {
        candidates,
        complete,
        updated_hash_cache,
    })
}

/// Reads the exact bytes of one candidate file for upload, bounded to `LIBRARY_MAX_BYTES`.
pub(crate) fn read_candidate_bytes_blocking(
    authority: &SharedPathAuthority,
    handle: &FileWorkspaceHandle,
    token: &CancellationToken,
) -> Result<Option<(Vec<u8>, String)>, Error> {
    let mut snapshot = authority.with_mut(|auth| {
        auth.ensure_pgn_not_trashed(handle)?;
        auth.resolve(handle.path_ref(), PathOperation::ReadPgn, &[])?
            .pgn_snapshot()
    })??;
    if snapshot.revision.size > LIBRARY_MAX_BYTES {
        return Ok(None);
    }
    let mut bytes = Vec::with_capacity(snapshot.revision.size.min(LIBRARY_MAX_BYTES) as usize);
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
            return Ok(None);
        }
        bytes.extend_from_slice(&buf[..n]);
    }
    let sha = format!("{:x}", Sha256::digest(&bytes));
    Ok(Some((bytes, sha)))
}

/// Pure read-only identity passes 1 to 3 (handle, locator, content hash) over existing state
/// entries. Returns per-candidate matched entry ids and the set of claimed entry ids.
fn match_existing_entries(
    candidates: &[ScannedCandidate],
    entries: &BTreeMap<String, SyncEntry>,
) -> (Vec<Option<String>>, HashSet<String>) {
    let mut matched_ids: Vec<Option<String>> = vec![None; candidates.len()];
    let mut claimed_entries: HashSet<String> = HashSet::new();

    // Pass 1: handle match.
    for (idx, candidate) in candidates.iter().enumerate() {
        if let Some((id, _)) = entries.iter().find(|(id, entry)| {
            !claimed_entries.contains(*id) && entry.handle.as_ref() == Some(&candidate.handle)
        }) {
            let id = id.clone();
            claimed_entries.insert(id.clone());
            matched_ids[idx] = Some(id);
        }
    }

    // Pass 2: locator match.
    for (idx, candidate) in candidates.iter().enumerate() {
        if matched_ids[idx].is_some() {
            continue;
        }
        if let Some((id, _)) = entries.iter().find(|(id, entry)| {
            !claimed_entries.contains(*id) && entry.locator == candidate.locator
        }) {
            let id = id.clone();
            claimed_entries.insert(id.clone());
            matched_ids[idx] = Some(id);
        }
    }

    // Pass 3: content hash match against unmatched entries.
    for (idx, candidate) in candidates.iter().enumerate() {
        if matched_ids[idx].is_some() {
            continue;
        }
        let Some(sha) = candidate.content_sha256.as_deref() else {
            continue;
        };
        if let Some((id, _)) = entries.iter().find(|(id, entry)| {
            !claimed_entries.contains(*id) && entry.last_content_sha256.as_deref() == Some(sha)
        }) {
            let id = id.clone();
            claimed_entries.insert(id.clone());
            matched_ids[idx] = Some(id);
        }
    }

    (matched_ids, claimed_entries)
}

/// Pure predicate reporting whether any entry in `state.entries` is left unmatched by
/// `candidates` under identity passes 1 to 3.
pub(crate) fn has_unmatched_entries(candidates: &[ScannedCandidate], state: &SyncState) -> bool {
    let (_, claimed_entries) = match_existing_entries(candidates, &state.entries);
    claimed_entries.len() < state.entries.len()
}

/// Five-pass identity matcher (S-3). Returns the matched `studio_file_id` for each candidate in
/// `candidates` (same index order), mutating `state.entries` in place.
///
/// Passes run in path order, each only over candidates and entries still unmatched:
/// 1. handle match (in-session rename or move inside Studio)
/// 2. locator match (after restart)
/// 3. last content hash match (rename or move outside Studio / while closed)
/// 4. server file with same `content_sha256` whose id no entry holds (adoption)
/// 5. new entry with a new UUID v4, selected (unless in `initial_deselected_handles` or
///    `initial_deselected_locators`)
pub(crate) fn match_candidates_to_entries(
    candidates: &[ScannedCandidate],
    state: &mut SyncState,
    server_files: Option<&[StudioLibraryFile]>,
    complete_scan: bool,
    can_increment_missed: bool,
    initial_deselected_handles: &HashSet<FileWorkspaceHandle>,
    initial_deselected_locators: &HashSet<Vec<OsString>>,
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
        let selected = !is_initially_deselected(candidate);
        state.entries.insert(
            id.clone(),
            SyncEntry {
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

    // Missed-scan accounting and pruning for unmatched entries.
    if complete_scan {
        if can_increment_missed {
            for (id, entry) in &mut state.entries {
                if !claimed_entries.contains(id) {
                    entry.missed_scans = entry.missed_scans.saturating_add(1);
                }
            }
        }
        if let Some(server_files) = server_files {
            let server_ids: HashSet<&str> = server_files
                .iter()
                .map(|sf| sf.studio_file_id.as_str())
                .collect();
            state.entries.retain(|id, entry| {
                claimed_entries.contains(id)
                    || entry.missed_scans < ABSENCE_DELETE_THRESHOLD
                    || server_ids.contains(id.as_str())
            });
        }
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
            handle: FileWorkspaceHandle::new(PathRef {
                id: handle.to_owned(),
            }),
            locator: vec![OsString::from(locator)],
            name: locator.to_owned(),
            normalized_name: normalize_library_name(locator),
            folder_label: String::new(),
            kind: LibraryFileKind::Games,
            revision: Some("rev-1".into()),
            content_sha256: sha.map(str::to_owned),
            oversized: false,
            unreadable: false,
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
        let result = scan_workspace_blocking(
            &authority,
            &mutation,
            &workspace,
            &HashMap::new(),
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(result.complete);
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
        let result = scan_workspace_blocking(
            &authority,
            &mutation,
            &workspace,
            &HashMap::new(),
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(result.complete);
        let big = result
            .candidates
            .iter()
            .find(|c| c.normalized_name == "big")
            .unwrap();
        assert!(big.oversized);
        assert!(!big.unreadable);
        assert!(big.content_sha256.is_none());
        let read =
            read_candidate_bytes_blocking(&authority, &big.handle, &CancellationToken::new())
                .unwrap();
        assert!(read.is_none());
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
        let result = scan_workspace_blocking(
            &authority,
            &mutation,
            &workspace,
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

        let result = scan_workspace_blocking(
            &authority,
            &workspace_mutation,
            &workspace,
            &HashMap::new(),
            &token,
        )
        .unwrap();
        assert!(result.complete);
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
        let old_handle = FileWorkspaceHandle::new(PathRef {
            id: "h-1".to_owned(),
        });
        state.entries.insert(
            "11111111-1111-4111-8111-111111111111".into(),
            SyncEntry {
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
                locator: vec![OsString::from("old.pgn")],
                handle: None,
                selected: true,
                last_content_sha256: Some("sha-alpha".into()),
                missed_scans: 0,
                last_rejection: None,
            },
        );

        let renamed_same_hash = cand("handle-renamed", "renamed.pgn", Some("sha-alpha"));
        assert!(!has_unmatched_entries(&[renamed_same_hash], &state));

        let unrelated_new_file = cand("handle-new", "new.pgn", Some("sha-beta"));
        assert!(has_unmatched_entries(&[unrelated_new_file], &state));
    }
}
