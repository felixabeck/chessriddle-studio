#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
#![cfg_attr(test, allow(clippy::disallowed_methods))]

mod cancellable_read;
mod chess;
mod chesscom;
mod chessriddle;
mod chessriddle_training;
mod credentials;
mod db;
mod engine;
mod error;
mod feedback;
mod file_workspace;
mod game;
mod infra;

mod fs;
mod lexer;
mod lichess;
mod oauth;
mod oauth_pkce;
mod opening;
mod pgn;
mod practice;
mod progress;
mod puzzle;
mod sound;
mod system_appearance;

#[cfg(any(test, debug_assertions))]
use std::path::Path;
#[cfg(test)]
use std::sync::{Barrier, OnceLock};
use std::{
    collections::{HashMap, VecDeque},
    ffi::OsStr,
    io,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime},
};

use chess::BestMovesPayload;
use db::{
    ConvertProgress, DatabaseContentFailure, GameQuery, IndexSource, NormalizedGame, PositionStats,
};
use engine::EngineSupervisor;
use game::GameManager;
use progress::{clear_progress, failed_progress_snapshot, get_progress, ProgressEvent};

use log::LevelFilter;
use oauth::AuthLifecycle;
#[cfg(debug_assertions)]
use specta_typescript::{BigIntExportBehavior, Typescript};
use sysinfo::SystemExt;
use tauri::{Manager, WebviewWindow, Window};
use tauri_plugin_log::{Target, TargetKind};

use crate::chess::{
    analyze_game, cancel_analysis, get_engine_config, get_engine_logs, kill_engine, kill_engines,
    prepare_analysis, prepare_engine_search, release_engine_search, retire_engine, stop_engine,
};
use crate::chesscom::{download_chess_com_games, get_public_chess_com_json};
use crate::db::{
    cancel_conversion, clear_games, convert_pgn, create_indexes, delete_database, delete_db_game,
    delete_empty_games, delete_indexes, export_to_pgn, get_player, get_players_game_info,
    get_tournaments, preload_reference_db, prepare_conversion, release_conversion, search_position,
    MmapSearchIndex,
};
use crate::error::Error;
use crate::game::{
    abort_game, get_game_engine_logs, get_game_state, make_game_move, resign_game, start_game,
    take_back_game_move, ClockUpdateEvent, GameMoveEvent, GameOverEvent,
};
use crate::infra::blocking::BLOCKING_GATEWAY;
use crate::infra::keyed_locks::{KeyedLockLease, KeyedLocks};
use crate::infra::operations::{OperationLease, OperationRegistry};

use crate::feedback::submit_feedback;
use crate::file_workspace::{
    create_workspace_directory, create_workspace_file, delete_workspace_trash_item,
    empty_workspace_trash, issue_file_workspace, list_file_workspace, list_workspace_trash,
    map_picker_join, move_workspace_entry, rename_workspace_file, restore_workspace_trash_item,
    trash_workspace_entry, write_workspace_file_metadata,
};
use crate::lexer::lex_pgn;
use crate::lichess::{
    get_authenticated_lichess_account, get_authenticated_lichess_explorer, get_public_lichess_json,
};
use crate::oauth::{
    authenticate, get_authentication_status, list_lichess_accounts, migrate_legacy_lichess_token,
    remove_lichess_account, revoke_legacy_lichess_token,
};
use crate::pgn::{
    count_pgn_games, delete_game, file_revision, move_games, read_game, read_games,
    set_game_section, write_game,
};
use crate::practice::{
    acknowledge_practice_orphans, list_practice_decks, load_practice_deck, load_practice_reviews,
    migrate_practice_deck, practice_epoch, record_practice_review, repair_practice_deck,
    reset_practice_deck, sync_practice_positions,
};
use crate::puzzle::{
    delete_puzzle_database, get_puzzle, get_puzzle_themes, get_puzzle_workspace,
    get_themes_for_puzzle, issue_puzzle_download_destination, issue_puzzle_workspace,
    list_puzzle_databases,
};
use crate::sound::get_sound_server_port;
use crate::{
    chess::get_best_moves,
    db::{
        delete_duplicated_games, edit_db_info, get_db_game, get_db_info, get_games, get_players,
        insert_db_game, merge_players, write_db_game,
    },
    fs::{
        cancel_download, cancel_download_for_progress, download_file, download_lichess_games,
        file_exists, prepare_download, release_download, verify_signed_bytes,
    },
    opening::{get_opening_from_fens, get_opening_from_name, search_opening_name},
};
use tokio::sync::Semaphore;

const SEARCH_RESULT_CACHE_CAPACITY: usize = 128;
const SEARCH_INDEX_CACHE_CAPACITY: usize = 8;
const SEARCH_RESULT_CACHE_MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_ENGINE_IMAGE_BYTES: usize = 10 * 1024 * 1024;
type SearchResult = (Vec<PositionStats>, Vec<NormalizedGame>);

#[cfg(test)]
struct ImageIssuanceTestGate {
    entered: Arc<Barrier>,
    release: Arc<Barrier>,
}
#[cfg(test)]
static IMAGE_ISSUANCE_TEST_GATE: OnceLock<Mutex<Option<ImageIssuanceTestGate>>> = OnceLock::new();

#[cfg(test)]
fn pause_image_issuance_after_lease() {
    let gate = IMAGE_ISSUANCE_TEST_GATE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("image issuance test gate")
        .take();
    if let Some(gate) = gate {
        gate.entered.wait();
        gate.release.wait();
    }
}

#[derive(Clone)]
struct CachedSearchResult {
    value: SearchResult,
    bytes: usize,
}

fn estimated_search_result_bytes(value: &SearchResult) -> usize {
    let position_bytes = value
        .0
        .iter()
        .map(|item| {
            item.move_.len() + std::mem::size_of::<PositionStats>() + item.recency_heap_bytes()
        })
        .sum::<usize>();
    let game_bytes = value
        .1
        .iter()
        .map(|game| {
            game.event.len()
                + game.site.len()
                + game.white.len()
                + game.black.len()
                + game.fen.len()
                + game.moves.len()
                + game.date.as_ref().map_or(0, String::len)
                + game.time.as_ref().map_or(0, String::len)
                + game.round.as_ref().map_or(0, String::len)
                + game.time_control.as_ref().map_or(0, String::len)
                + game.eco.as_ref().map_or(0, String::len)
                + std::mem::size_of_val(game)
        })
        .sum::<usize>();
    position_bytes.saturating_add(game_bytes)
}

/// A cache identity bound to the authorized database and mapped sidecar descriptor.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct SearchIndexIdentity {
    parent_object: (u64, u64),
    sidecar_object: (u64, u64),
    source: IndexSource,
    length: u64,
    modified: Duration,
}

impl SearchIndexIdentity {
    pub(crate) fn from_opened_sidecar(
        target: &crate::infra::path_authority::DatabaseFileTarget,
        source: IndexSource,
        file: &impl crate::infra::inode_ownership::FileMetadata,
    ) -> Result<Self, Error> {
        #[cfg(test)]
        if FAIL_NEXT_SIDECAR_STAMP.with(|fail| fail.replace(false)) {
            return Err(io::Error::other("injected sidecar descriptor stamp failure").into());
        }
        let sidecar_object = crate::infra::path_authority::opened_file_identity(file)?;
        let metadata = file.metadata()?;
        Ok(Self {
            parent_object: search_parent_identity(target)?,
            sidecar_object,
            source,
            length: metadata.len(),
            modified: metadata
                .modified()?
                .duration_since(SystemTime::UNIX_EPOCH)
                .map_err(io::Error::other)?,
        })
    }

    #[cfg(test)]
    pub(crate) fn for_test_database(database: &Path, source: IndexSource) -> Result<Self, Error> {
        let target = crate::infra::path_authority::DatabaseFileTarget::for_test_path(database)?;
        let file = crate::infra::fs::open_regular_at(
            target.parent(),
            db::get_index_path(target.path())
                .file_name()
                .ok_or_else(|| Error::InvalidInput("sidecar path needs a leaf name".into()))?,
            crate::infra::fs::RegularFileAccess::ReadOnly,
        )?;
        Self::from_opened_sidecar(&target, source, &file)
    }

    // A simultaneous replacement and spelling change can leave cached entries
    // under the old object and sidecar. Invalidate the whole parent to cover them.
    fn matches_invalidation_scope(&self, parent: Option<(u64, u64)>, object: (u64, u64)) -> bool {
        parent.is_none_or(|parent| self.parent_object == parent || self.source.object == object)
    }
}

fn search_parent_identity(
    target: &crate::infra::path_authority::DatabaseFileTarget,
) -> Result<(u64, u64), Error> {
    #[cfg(test)]
    if FAIL_NEXT_SEARCH_PARENT_IDENTITY.with(|fail| fail.replace(false)) {
        return Err(io::Error::other("injected search parent metadata failure").into());
    }
    crate::infra::path_authority::opened_file_identity(target.parent())
}

#[cfg(test)]
std::thread_local! {
    static FAIL_NEXT_SIDECAR_STAMP: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static FAIL_NEXT_SEARCH_PARENT_IDENTITY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct SearchResultKey {
    query: GameQuery,
    identity: SearchIndexIdentity,
}

impl SearchResultKey {
    pub(crate) fn new(query: GameQuery, identity: SearchIndexIdentity) -> Self {
        Self { query, identity }
    }
}

struct BoundedSearchCache<K, V> {
    values: HashMap<K, V>,
    newest_last: VecDeque<K>,
}

impl<K, V> Default for BoundedSearchCache<K, V> {
    fn default() -> Self {
        Self {
            values: HashMap::new(),
            newest_last: VecDeque::new(),
        }
    }
}

impl<K: Clone + Eq + std::hash::Hash, V: Clone> BoundedSearchCache<K, V> {
    fn get(&mut self, key: &K) -> Option<V> {
        let value = self.values.get(key)?.clone();
        if let Some(position) = self.newest_last.iter().position(|existing| existing == key) {
            self.newest_last.remove(position);
        }
        self.newest_last.push_back(key.clone());
        Some(value)
    }

    /// Returns every value displaced by the insert so the caller can drop them
    /// after releasing the cache mutex.
    fn insert(&mut self, key: K, value: V, capacity: usize) -> Vec<V> {
        let mut evicted = Vec::new();
        evicted.extend(self.values.insert(key.clone(), value));
        if let Some(position) = self
            .newest_last
            .iter()
            .position(|existing| existing == &key)
        {
            self.newest_last.remove(position);
        }
        self.newest_last.push_back(key);
        while self.values.len() > capacity {
            if let Some(oldest) = self.newest_last.pop_front() {
                evicted.extend(self.values.remove(&oldest));
            }
        }
        evicted
    }

    fn evict_oldest(&mut self) -> Option<V> {
        self.newest_last
            .pop_front()
            .and_then(|oldest| self.values.remove(&oldest))
    }

    /// Returns the removed values so the caller can drop them after releasing
    /// the cache mutex.
    fn retain(&mut self, mut predicate: impl FnMut(&K, &V) -> bool) -> Vec<V> {
        let removed_keys = self
            .values
            .iter()
            .filter(|(key, value)| !predicate(key, value))
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        let removed = removed_keys
            .iter()
            .filter_map(|key| self.values.remove(key))
            .collect();
        self.newest_last.retain(|key| self.values.contains_key(key));
        removed
    }
}

#[derive(Default)]
pub(crate) struct SearchCache {
    results: Mutex<BoundedSearchCache<SearchResultKey, CachedSearchResult>>,
    indexes: Mutex<BoundedSearchCache<SearchIndexIdentity, MmapSearchIndex>>,
    collisions: KeyedLocks<(GameQuery, (u64, u64)), parking_lot::Mutex<()>>,
    generation_locks: KeyedLocks<(u64, u64), parking_lot::Mutex<()>>,
    /// Global invalidation sequence: one atomic, no per-database registry. A load of
    /// another database may skip caching once when any database is invalidated.
    invalidation_counter: AtomicU64,
}

impl SearchCache {
    /// Clears cached results and indexes; keyed locks are reclaimed by their outstanding leases.
    pub(crate) fn clear(&self) {
        *self.results.lock().expect("search result cache poisoned") = Default::default();
        let evicted =
            std::mem::take(&mut *self.indexes.lock().expect("search index cache poisoned"));
        drop(evicted);
    }

    pub(crate) fn invalidation_snapshot(&self) -> u64 {
        self.invalidation_counter.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) fn cached_index_count(&self) -> usize {
        self.indexes
            .lock()
            .expect("search index cache poisoned")
            .values
            .len()
    }

    pub(crate) fn get_result(&self, key: &SearchResultKey) -> Option<SearchResult> {
        self.results
            .lock()
            .expect("search result cache poisoned")
            .get(key)
            .map(|cached| cached.value)
    }

    pub(crate) fn insert_result(&self, key: SearchResultKey, value: SearchResult) {
        let bytes = estimated_search_result_bytes(&value);
        if bytes > SEARCH_RESULT_CACHE_MAX_BYTES {
            return;
        }
        let mut cache = self.results.lock().expect("search result cache poisoned");
        cache.insert(
            key,
            CachedSearchResult { value, bytes },
            SEARCH_RESULT_CACHE_CAPACITY,
        );
        let mut total = cache
            .values
            .values()
            .map(|cached| cached.bytes)
            .sum::<usize>();
        while total > SEARCH_RESULT_CACHE_MAX_BYTES {
            let Some(evicted) = cache.evict_oldest() else {
                break;
            };
            total = total.saturating_sub(evicted.bytes);
        }
    }

    pub(crate) fn get_index(&self, identity: &SearchIndexIdentity) -> Option<MmapSearchIndex> {
        self.indexes.lock().ok()?.get(identity)
    }

    /// The only insert path for mapped indexes. Deduplicates under the indexes
    /// mutex, then caches only if no invalidation began since the loader's probe
    /// snapshot. Displaced mappings are dropped after releasing that mutex.
    pub(crate) fn insert_index(
        &self,
        identity: SearchIndexIdentity,
        index: MmapSearchIndex,
        invalidation_snapshot: u64,
    ) -> MmapSearchIndex {
        let (loaded, discarded) = {
            let mut cache = self.indexes.lock().expect("search index cache poisoned");
            if let Some(existing) = cache.get(&identity) {
                (existing, vec![index])
            } else if self.invalidation_snapshot() != invalidation_snapshot {
                (index, Vec::new())
            } else {
                let evicted = cache.insert(identity, index.clone(), SEARCH_INDEX_CACHE_CAPACITY);
                (index, evicted)
            }
        };
        drop(discarded);
        loaded
    }

    pub(crate) fn collision_lock(
        &self,
        query: GameQuery,
        target: &crate::infra::path_authority::DatabaseFileTarget,
    ) -> KeyedLockLease<'_, (GameQuery, (u64, u64)), parking_lot::Mutex<()>> {
        self.collisions.lease((query, target.identity()))
    }

    pub(crate) fn generation_lock(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
    ) -> KeyedLockLease<'_, (u64, u64), parking_lot::Mutex<()>> {
        self.generation_locks.lease(target.identity())
    }

    /// Invalidates before eviction so publication under the indexes mutex either
    /// precedes the eviction or sees the changed counter and stays uncached.
    /// Readers retain their own mapped generation without waiting (d-20261005-06).
    pub(crate) fn invalidate_database(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
    ) {
        self.invalidation_counter.fetch_add(1, Ordering::SeqCst);
        // Failure to narrow an optional cache operation must evict conservatively.
        let parent = search_parent_identity(target).ok();
        self.results
            .lock()
            .expect("search result cache poisoned")
            .retain(|key, _| {
                !key.identity
                    .matches_invalidation_scope(parent, target.identity())
            });
        let evicted = self
            .indexes
            .lock()
            .expect("search index cache poisoned")
            .retain(|identity, _| !identity.matches_invalidation_scope(parent, target.identity()));
        drop(evicted);
    }
}

#[derive(Clone)]
pub struct AppState {
    pub(crate) database_repository: Arc<db::DatabaseRepository>,
    new_request: Arc<Semaphore>,
    pub(crate) search_cache: Arc<SearchCache>,
    pub pgn_repository: crate::pgn::PgnRepository,
    pub pgn_path_authority: crate::infra::path_authority::SharedPathAuthority,
    pub(crate) workspace_mutation: Arc<std::sync::Mutex<()>>,

    engine_supervisor: Arc<EngineSupervisor>,
    auth: Arc<AuthLifecycle>,
    credentials: Arc<crate::credentials::CredentialManager>,
    pub(crate) chessriddle: Arc<std::sync::OnceLock<crate::chessriddle::AccountOwner>>,
    game_manager: Arc<GameManager>,
    progress_state: progress::ProgressStore,
    pub(crate) operations: OperationRegistry,
    puzzle_cache: Arc<tokio::sync::Mutex<crate::puzzle::PuzzleCache>>,
    pub http_transport: Arc<dyn crate::infra::net::DownloadTransport>,
    pub(crate) json_http_client: Arc<reqwest::Client>,
}

impl AppState {
    fn try_new(credentials: Arc<crate::credentials::CredentialManager>) -> Result<Self, Error> {
        Self::try_new_with_builders(
            credentials,
            reqwest::Client::builder(),
            reqwest::Client::builder(),
        )
    }

    fn try_new_with_builders(
        credentials: Arc<crate::credentials::CredentialManager>,
        download_builder: reqwest::ClientBuilder,
        json_builder: reqwest::ClientBuilder,
    ) -> Result<Self, Error> {
        let http_transport = Arc::new(crate::infra::net::ProdTransport::new(download_builder)?);
        let json_http_client = Arc::new(crate::infra::net::native_json_http_client(json_builder)?);
        let operations = OperationRegistry::default();
        Ok(Self {
            database_repository: Arc::new(db::DatabaseRepository::with_operations(
                operations.clone(),
            )),
            new_request: Arc::new(Semaphore::new(2)),
            search_cache: Arc::new(SearchCache::default()),
            pgn_repository: Default::default(),
            pgn_path_authority: crate::infra::path_authority::SharedPathAuthority::uninitialized(),
            workspace_mutation: Arc::new(std::sync::Mutex::new(())),
            engine_supervisor: Arc::new(EngineSupervisor::default()),
            auth: Arc::new(AuthLifecycle::default()),
            credentials,
            chessriddle: Arc::new(std::sync::OnceLock::new()),
            game_manager: Arc::new(GameManager::default()),
            progress_state: Default::default(),
            operations,
            puzzle_cache: Arc::new(tokio::sync::Mutex::new(crate::puzzle::PuzzleCache::new())),
            http_transport,
            json_http_client,
        })
    }
}

#[tauri::command]
#[specta::specta]
fn prepare_native_read(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<String, Error> {
    state.operations.prepare_read(window.label())
}

#[tauri::command]
#[specta::specta]
fn cancel_native_read(
    ticket: String,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    state.operations.cancel_read(&ticket, window.label())
}

pub(crate) fn native_read_operation(
    ticket: Option<String>,
    window: &WebviewWindow,
    state: &AppState,
    label: &str,
) -> Result<OperationLease, Error> {
    native_read_operation_for_owner(ticket, window.label(), state, label)
}

fn native_read_operation_for_owner(
    ticket: Option<String>,
    owner: &str,
    state: &AppState,
    label: &str,
) -> Result<OperationLease, Error> {
    match ticket {
        Some(ticket) => state.operations.claim_read(&ticket, owner, label),
        None => state.operations.accept(label),
    }
}

fn cancel_destroyed_window_operations(state: &AppState, label: &str) {
    cancel_destroyed_window_operations_in_registry(
        &state.operations,
        &state.engine_supervisor,
        label,
    );
}

fn cancel_destroyed_window_operations_in_registry(
    operations: &OperationRegistry,
    supervisor: &crate::engine::EngineSupervisor,
    label: &str,
) {
    match operations.cancel_owner(label) {
        Ok(cancelled) if !cancelled.is_empty() => {
            let ids = signal_cancelled_analyses(supervisor, &cancelled);
            log::info!(
                "destroyed webview {label} cancelled native reads/downloads: {}",
                ids
            );
        }
        Ok(_) => {}
        Err(error) => {
            log::error!(
                "could not cancel native reads/downloads for destroyed webview {label}: {error}"
            )
        }
    }
}

#[tauri::command]
#[specta::specta]
fn release_previous_document_operations(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    release_previous_document_operations_in_registry(
        &state.operations,
        &state.engine_supervisor,
        window.label(),
    )
}

fn release_previous_document_operations_in_registry(
    operations: &OperationRegistry,
    supervisor: &crate::engine::EngineSupervisor,
    label: &str,
) -> Result<(), Error> {
    let cancelled = operations.cancel_owner_reservations(label)?;
    if !cancelled.is_empty() {
        let ids = signal_cancelled_analyses(supervisor, &cancelled);
        log::info!(
            "reloaded webview {label} cancelled native reservations: {}",
            ids
        );
    }
    Ok(())
}

fn signal_cancelled_analyses(
    supervisor: &crate::engine::EngineSupervisor,
    cancelled: &[crate::infra::operations::CancelledOperation],
) -> String {
    for operation in cancelled {
        if operation.kind == crate::infra::operations::CancelledOperationKind::Analysis {
            if let Err(error) = chess::cancel_analysis_engine(supervisor, &operation.id) {
                log::error!("could not cancel analysis engine {}: {error}", operation.id);
            }
        }
    }
    cancelled
        .iter()
        .map(|operation| operation.id.as_str())
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(test)]
impl Default for AppState {
    fn default() -> Self {
        Self::try_new(Arc::new(crate::credentials::CredentialManager::default()))
            .expect("test AppState HTTP clients must be constructible")
    }
}

fn show_labeled_main_window<R: tauri::Runtime>(
    manager: &impl tauri::Manager<R>,
) -> Result<(), Error> {
    manager
        .get_webview_window("main")
        .ok_or_else(|| Error::InvalidInput("no window labeled 'main' found".into()))?
        .show()?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn close_splashscreen(window: Window) -> Result<(), Error> {
    show_labeled_main_window(&window)
}

#[tauri::command]
#[specta::specta]
async fn reconcile_startup_path_owners<'a>(
    owners: crate::infra::path_authority::StartupPathOwners,
    state: tauri::State<'a, AppState>,
) -> Result<(), Error> {
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "reconcile_startup_path_owners",
        move || {
            authority.with_mut(|authority| {
                crate::infra::path_authority::require_durable(
                    authority.reconcile_startup_owners(owners)?,
                )?;
                // Owner reconciliation already committed. Maintenance failure must retain retry
                // state without rejecting unrelated startup ownership work.
                if let Err(error) = authority.collect_catalog_installs() {
                    log::warn!(
                        "catalog install startup cleanup failed: {}",
                        error.diagnostic()
                    );
                }
                Ok(())
            })?
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
async fn reconcile_engine_attachments(
    action: crate::infra::path_authority::EngineAttachmentAction,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>, // caller's managed state
) -> Result<(), Error> {
    let startup = matches!(
        &action,
        crate::infra::path_authority::EngineAttachmentAction::Reconcile { startup: true, .. }
    );
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "reconcile_engine_attachments",
        move || {
            authority.with_mut(|authority| {
                authority.reconcile_engine_attachments(action)?;
                if startup {
                    let image_dir = crate::infra::path_authority::ensure_app_owned_default_dir(
                        &crate::infra::path_authority::AppDataDir::for_app(&app)?,
                        crate::infra::path_authority::AppOwnedDefaultRoot::EngineImages,
                    )?;
                    authority.cleanup_engine_images(&image_dir, false)?;
                }
                Ok(())
            })?
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
async fn issue_pgn_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::FileWorkspaceDescriptor, Error> {
    use tauri_plugin_dialog::DialogExt;
    let path = tokio::task::spawn_blocking(move || {
        let extensions = chessbase::picker_extensions();
        let filters: Vec<&str> = extensions.iter().map(String::as_str).collect();
        app.dialog()
            .file()
            .add_filter("PGN, ChessBase", &filters)
            .blocking_pick_file()
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| Error::InvalidInput(format!("invalid native file selection: {error}")))
    })
    .await
    .map_err(map_picker_join)??;
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_pgn_workspace",
        move || issue_pgn_workspace_blocking(&authority, path),
    )
    .await
}

fn issue_pgn_workspace_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    path: PathBuf,
) -> Result<crate::infra::path_authority::FileWorkspaceDescriptor, Error> {
    if chessbase::is_database(&path) {
        return Err(Error::ChessBaseDatabase);
    }
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "PGN".into());
    authority.with_mut(|authority| {
        let grant = authority.grant_dialog_operations(
            &path,
            display_name.clone(),
            crate::infra::path_authority::PathClass::BoundedDialogGrant,
            vec![
                crate::infra::path_authority::PathOperation::ReadPgn,
                crate::infra::path_authority::PathOperation::WritePgn,
            ],
            crate::infra::path_authority::PGN_FILE_DIALOG_GRANT_TTL,
            crate::infra::path_authority::PGN_FILE_DIALOG_GRANT_USES,
        )?;
        let commit = authority.promote_dialog(
            &grant,
            crate::infra::path_authority::PathClass::PersistentFile,
            display_name.clone(),
            vec![
                crate::infra::path_authority::PathOperation::ReadPgn,
                crate::infra::path_authority::PathOperation::WritePgn,
            ],
        )?;
        Ok(crate::infra::path_authority::FileWorkspaceDescriptor {
            handle: crate::infra::path_authority::FileWorkspaceHandle::new(commit.id),
            display_name,
            availability: crate::infra::path_authority::PathAvailability::Available,
        })
    })?
}

/// Native-only save destination picker for database export. The selection is immediately
/// persisted as an exact ReadPgn+WritePgn workspace, so the renderer never receives a path and
/// can safely open the exported file after writing it.
#[tauri::command]
#[specta::specta]
async fn issue_pgn_export_destination(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::FileWorkspaceDescriptor, Error> {
    use tauri_plugin_dialog::DialogExt;
    let path = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("PGN", &["pgn"])
            .set_file_name("games.pgn")
            .blocking_save_file()
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| Error::InvalidInput(format!("invalid native file selection: {error}")))
    })
    .await
    .map_err(map_picker_join)??;
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_pgn_export_destination",
        move || issue_pgn_export_destination_blocking(&authority, path),
    )
    .await
}

fn issue_pgn_export_destination_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    path: PathBuf,
) -> Result<crate::infra::path_authority::FileWorkspaceDescriptor, Error> {
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "PGN export".into());
    authority.with_mut(|authority| authority.create_pgn_export_destination(&path, display_name))?
}

async fn save_native_export(
    app: &tauri::AppHandle,
    operations: &OperationRegistry,
    label: &'static str,
    suggested_name: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<(), Error> {
    use tauri_plugin_dialog::DialogExt;
    let picker_app = app.clone();
    let picker_extension = extension.to_owned();
    let picker_name = suggested_name.to_owned();
    let path = tokio::task::spawn_blocking(move || {
        picker_app
            .dialog()
            .file()
            .add_filter(
                picker_extension.to_uppercase(),
                &[picker_extension.as_str()],
            )
            .set_file_name(picker_name)
            .blocking_save_file()
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| Error::InvalidInput(format!("invalid native file selection: {error}")))
    })
    .await
    .map_err(map_picker_join)??;
    let extension = extension.to_owned();
    let bytes = bytes.to_vec();
    crate::infra::operations::run_accepted_blocking(operations, label, move || {
        save_native_export_blocking(path, extension, bytes)
    })
    .await
}

fn save_native_export_blocking(
    path: PathBuf,
    extension: String,
    bytes: Vec<u8>,
) -> Result<(), Error> {
    let dest = crate::infra::fs::NativeExportDest::from_save_path(path, &extension)?;
    let outcome = dest.replace(|file| {
        file.write_all(&bytes).map_err(Error::from)?;
        Ok(())
    })?;
    crate::infra::fs::require_durable(outcome, crate::error::DurabilityStage::NativeExport)
}

/// Native save dialog and atomic export for a renderer-produced board image.
#[tauri::command]
#[specta::specta]
async fn save_board_snapshot(app: tauri::AppHandle, bytes: Vec<u8>) -> Result<(), Error> {
    save_native_export(
        &app,
        &app.state::<AppState>().operations,
        "save_board_snapshot",
        "board.png",
        "png",
        &bytes,
    )
    .await
}

/// Native save dialog and atomic export for renderer-selected engine logs.
#[tauri::command]
#[specta::specta]
async fn save_engine_logs(app: tauri::AppHandle, text: String) -> Result<(), Error> {
    save_native_export(
        &app,
        &app.state::<AppState>().operations,
        "save_engine_logs",
        "engine-logs.csv",
        "csv",
        text.as_bytes(),
    )
    .await
}

const DOCUMENTATION_URL: &str = concat!(env!("CARGO_PKG_REPOSITORY"), "/tree/master/docs");
macro_rules! app_log_file_stem {
    () => {
        "chessriddle-studio"
    };
}
const APP_LOG_FILE_STEM: &str = app_log_file_stem!();
const APP_LOG_FILE_NAME: &str = concat!(app_log_file_stem!(), ".log");

/// Opens the fixed project documentation URL without granting arbitrary URL authority to the
/// renderer.
#[tauri::command]
#[specta::specta]
fn open_documentation(app: tauri::AppHandle) -> Result<(), Error> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(DOCUMENTATION_URL, None::<&str>)
        .map_err(Error::from)
}

/// Opens the application-owned log file without exposing its native path to the renderer.
#[tauri::command]
#[specta::specta]
async fn open_app_log(app: tauri::AppHandle) -> Result<(), Error> {
    let operations = app.state::<AppState>().operations.clone();
    crate::infra::operations::run_accepted_blocking(&operations, "open_app_log", move || {
        open_app_log_blocking(app)
    })
    .await
}

fn open_app_log_blocking(app: tauri::AppHandle) -> Result<(), Error> {
    use tauri_plugin_opener::OpenerExt;
    let path = app.path().app_log_dir()?.join(APP_LOG_FILE_NAME);
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(Error::from)
}

/// The native picker creates a persistent, least-privilege root for one-file downloads.
/// The renderer receives only the opaque capability ID, never a filesystem path.
#[tauri::command]
#[specta::specta]
async fn issue_download_destination(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::PathRef, Error> {
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
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_download_destination",
        move || issue_download_destination_blocking(&authority, path),
    )
    .await
}

fn issue_download_destination_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    path: PathBuf,
) -> Result<crate::infra::path_authority::PathRef, Error> {
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Download destination".into());
    authority.with_mut(|authority| {
        let grant = authority.grant_dialog(
            &path,
            display_name.clone(),
            crate::infra::path_authority::PathClass::SingleDialogGrant,
            crate::infra::path_authority::PathOperation::DownloadFile,
            crate::infra::path_authority::PICKER_DIALOG_GRANT_TTL,
            1,
        )?;
        Ok(authority
            .promote_dialog(
                &grant,
                crate::infra::path_authority::PathClass::PersistentCustomRoot,
                display_name,
                vec![crate::infra::path_authority::PathOperation::DownloadFile],
            )?
            .id)
    })?
}

#[tauri::command]
#[specta::specta]
async fn download_destination_is_known(
    destination: crate::infra::path_authority::PathRef,
    state: tauri::State<'_, AppState>,
) -> Result<bool, Error> {
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "download_destination_is_known",
        move || download_destination_is_known_blocking(&authority, destination),
    )
    .await
}

fn download_destination_is_known_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    destination: crate::infra::path_authority::PathRef,
) -> Result<bool, Error> {
    authority.with_mut(|authority| Ok(authority.download_destination_is_known(&destination)))?
}

/// Native-only database-root selection.  A directory is promoted immediately
/// to a persistent database workspace and the renderer receives its opaque
/// handle and the folder's display name, never its path.
#[tauri::command]
#[specta::specta]
async fn issue_database_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::DatabaseRootDescriptor, Error> {
    use tauri_plugin_dialog::DialogExt;
    let path = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| {
                Error::native_folder_selection("invalid database folder selection", error)
            })
    })
    .await
    .map_err(map_picker_join)??;
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_database_workspace",
        move || issue_database_workspace_blocking(&authority, path),
    )
    .await
}

fn issue_database_workspace_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    path: PathBuf,
) -> Result<crate::infra::path_authority::DatabaseRootDescriptor, Error> {
    let display_name = crate::infra::path_authority::selected_root_display_name(&path, "Databases");
    authority.with_mut(|authority| {
        let root = authority.get_or_create_database_root(&path, display_name, None)?;
        authority.set_active_database_root(&root)?;
        authority.database_root_descriptor(root)
    })?
}

/// Returns the active database root or refuses an unusable selection. With no selection,
/// it acquires, registers and activates the app-owned default root without a renderer path.
#[tauri::command]
#[specta::specta]
async fn get_database_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::DatabaseRootDescriptor, Error> {
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "get_database_workspace",
        move || {
            get_database_workspace_blocking(&authority, &|| {
                crate::infra::path_authority::AppDataDir::for_app(&app)
            })
        },
    )
    .await
}

fn get_database_workspace_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    app_data: &dyn Fn() -> Result<crate::infra::path_authority::AppDataDir, Error>,
) -> Result<crate::infra::path_authority::DatabaseRootDescriptor, Error> {
    authority.with_mut(|authority| {
        if let Some(root) = authority.active_database_root()? {
            return authority.database_root_descriptor(root);
        }
        let app_data = app_data()?;
        let root = get_default_database_workspace(authority, &app_data)?;
        authority.database_root_descriptor(root)
    })?
}

fn get_default_database_workspace(
    authority: &mut crate::infra::path_authority::PathAuthority,
    app_data: &crate::infra::path_authority::AppDataDir,
) -> Result<crate::infra::path_authority::DatabaseRootHandle, Error> {
    let authorized_dir = crate::infra::path_authority::ensure_app_owned_default_dir(
        app_data,
        crate::infra::path_authority::AppOwnedDefaultRoot::Databases,
    )
    .map_err(Error::label_root_failure)?;
    let root = authority.get_or_create_database_root(
        authorized_dir.path(),
        "Databases",
        Some(authorized_dir.identity()),
    )?;
    authority.set_active_default_database_root(&root)?;
    Ok(root)
}

#[tauri::command]
#[specta::specta]
async fn list_workspace_databases(
    root: crate::infra::path_authority::DatabaseRootHandle,
    ticket: Option<String>,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::DatabaseListing, Error> {
    let operation = native_read_operation(ticket, &window, &state, "list_workspace_databases")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_native_operation(
        operation,
        "list_workspace_databases",
        async move {
            BLOCKING_GATEWAY
                .spawn_cancellable(cancellation, move |token| {
                    if token.is_cancelled() {
                        return Err(Error::Cancellation);
                    }
                    let databases = list_workspace_databases_blocking(&authority, root, token)?;
                    if token.is_cancelled() {
                        return Err(Error::Cancellation);
                    }
                    Ok(databases)
                })
                .await
        },
    )
    .await
}

fn list_workspace_databases_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    root: crate::infra::path_authority::DatabaseRootHandle,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<crate::infra::path_authority::DatabaseListing, Error> {
    let result = (|| {
        authority.with_mut(|authority| {
            authority.list_database_children_cancellable(&root, cancellation)
        })?
    })();
    result.map_err(|error| {
        crate::infra::path_authority::probe_listing_root_failure(
            authority,
            root.path_ref(),
            crate::infra::path_authority::PathOperation::DatabaseRead,
            error,
            cancellation,
        )
    })
}

#[tauri::command]
#[specta::specta]
async fn create_workspace_database(
    root: crate::infra::path_authority::DatabaseRootHandle,
    filename: String,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::DatabaseHandle, Error> {
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "create_workspace_database",
        move || create_workspace_database_blocking(&authority, root, filename),
    )
    .await
}

fn create_workspace_database_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    root: crate::infra::path_authority::DatabaseRootHandle,
    filename: String,
) -> Result<crate::infra::path_authority::DatabaseHandle, Error> {
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') {
        return Err(Error::InvalidInput("invalid database filename".into()));
    }
    authority.with_mut(|authority| {
        authority.create_database_child(&root, std::ffi::OsStr::new(&filename))
    })?
}

#[tauri::command]
#[specta::specta]
async fn database_download_destination(
    root: crate::infra::path_authority::DatabaseRootHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::PathRef, Error> {
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "database_download_destination",
        move || database_download_destination_blocking(&authority, root),
    )
    .await
}

fn database_download_destination_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    root: crate::infra::path_authority::DatabaseRootHandle,
) -> Result<crate::infra::path_authority::PathRef, Error> {
    authority.with_mut(|authority| authority.database_download_destination(&root))?
}

#[tauri::command]
#[specta::specta]
async fn issue_engine_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::EngineRootDescriptor, Error> {
    use tauri_plugin_dialog::DialogExt;
    let path = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| {
                Error::InvalidInput(format!("invalid engine folder selection: {error}"))
            })
    })
    .await
    .map_err(map_picker_join)??;
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_engine_workspace",
        move || issue_engine_workspace_blocking(&authority, path),
    )
    .await
}

fn issue_engine_workspace_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    path: PathBuf,
) -> Result<crate::infra::path_authority::EngineRootDescriptor, Error> {
    let display_name = crate::infra::path_authority::selected_root_display_name(&path, "Engines");
    authority.with_mut(|authority| {
        let root = authority.get_or_create_engine_root(&path, display_name, None)?;
        authority.set_active_engine_root(&root)?;
        authority.engine_root_descriptor(root)
    })?
}

/// Returns the active engine root or refuses an unusable selection. The app-owned default
/// is created and activated only when no selection exists.
#[tauri::command]
#[specta::specta]
async fn get_engine_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::EngineRootDescriptor, Error> {
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "get_engine_workspace",
        move || {
            get_engine_workspace_blocking(&authority, &|| {
                crate::infra::path_authority::AppDataDir::for_app(&app)
            })
        },
    )
    .await
}

fn get_engine_workspace_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    app_data: &dyn Fn() -> Result<crate::infra::path_authority::AppDataDir, Error>,
) -> Result<crate::infra::path_authority::EngineRootDescriptor, Error> {
    authority.with_mut(|authority| {
        if let Some(root) = authority.active_engine_root()? {
            return authority.engine_root_descriptor(root);
        }
        let authorized_dir = crate::infra::path_authority::ensure_app_owned_default_dir(
            &app_data()?,
            crate::infra::path_authority::AppOwnedDefaultRoot::Engines,
        )?;
        let root = authority.get_or_create_engine_root(
            authorized_dir.path(),
            "Engines",
            Some(authorized_dir.identity()),
        )?;
        authority.set_active_engine_root(&root)?;
        authority.engine_root_descriptor(root)
    })?
}

#[tauri::command]
#[specta::specta]
async fn issue_engine_binary(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::EngineHandle, Error> {
    use tauri_plugin_dialog::DialogExt;
    let path = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_file()
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| Error::InvalidInput(format!("invalid engine file selection: {error}")))
    })
    .await
    .map_err(map_picker_join)??;
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_engine_binary",
        move || issue_engine_binary_blocking(&authority, path),
    )
    .await
}

fn issue_engine_binary_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    path: PathBuf,
) -> Result<crate::infra::path_authority::EngineHandle, Error> {
    let label = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Engine".into());
    authority.with_mut(|authority| authority.register_engine_file(&path, label))?
}

/// Native-only resource picker for UCI file/directory options.  The dialog
/// selection is immediately bound to a no-follow persistent capability.
#[tauri::command]
#[specta::specta]
async fn issue_engine_resource(
    directory: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::EngineResourceHandle, Error> {
    use tauri_plugin_dialog::DialogExt;
    let path = tokio::task::spawn_blocking(move || {
        let picker = app.dialog().file();
        let selected = if directory {
            picker.blocking_pick_folder()
        } else {
            picker.blocking_pick_file()
        };
        selected
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| {
                Error::InvalidInput(format!("invalid engine resource selection: {error}"))
            })
    })
    .await
    .map_err(map_picker_join)??;
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_engine_resource",
        move || issue_engine_resource_blocking(&authority, path, directory),
    )
    .await
}

fn issue_engine_resource_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    path: PathBuf,
    directory: bool,
) -> Result<crate::infra::path_authority::EngineResourceHandle, Error> {
    let label = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Engine resource".into());
    authority.with_mut(|authority| {
        let grant = authority.grant_dialog(
            &path,
            label.clone(),
            crate::infra::path_authority::PathClass::SingleDialogGrant,
            crate::infra::path_authority::PathOperation::EngineResourceRead,
            crate::infra::path_authority::PICKER_DIALOG_GRANT_TTL,
            1,
        )?;
        authority.promote_engine_resource(
            &grant,
            if directory {
                crate::infra::path_authority::EngineResourceHandleKind::Directory
            } else {
                crate::infra::path_authority::EngineResourceHandleKind::File
            },
            label,
        )
    })?
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct EngineImageData {
    bytes: Vec<u8>,
    mime_type: String,
}

fn engine_image_mime_type(bytes: &[u8]) -> Result<&'static str, Error> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Ok("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Ok("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Ok("image/webp")
    } else {
        Err(Error::InvalidInput(
            "engine image must be a PNG, JPEG, GIF, or WebP file".into(),
        ))
    }
}

/// Copies a picker-selected raster image into app-owned storage. The original
/// physical path is consumed natively and never serialized to the renderer.
#[tauri::command]
#[specta::specta]
async fn issue_engine_image(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::EngineImageHandle, Error> {
    use tauri_plugin_dialog::DialogExt;
    let picker_app = app.clone();
    let path = tokio::task::spawn_blocking(move || {
        picker_app
            .dialog()
            .file()
            .add_filter("Image", &["png", "jpg", "jpeg", "gif", "webp"])
            .blocking_pick_file()
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| {
                Error::InvalidInput(format!("invalid native image selection: {error}"))
            })
    })
    .await
    .map_err(map_picker_join)??;
    let authority = state.pgn_path_authority.clone();
    let operation = state.operations.accept("issue_engine_image")?;
    crate::infra::operations::run_native_operation(operation, "issue_engine_image", async move {
        issue_engine_image_blocking_async(authority, app, path, None).await
    })
    .await
}

fn issue_engine_image_blocking<R: tauri::Runtime>(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    app: tauri::AppHandle<R>,
    path: PathBuf,
    app_data_override: Option<crate::infra::path_authority::AppDataDir>,
) -> Result<crate::infra::path_authority::EngineImageHandle, Error> {
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Engine image".into());
    let (issuance_lease, grant) = {
        authority.with_mut(|authority| {
            let issuance_lease = authority.begin_engine_image_issuance()?;
            let grant = authority.grant_dialog(
                &path,
                display_name.clone(),
                crate::infra::path_authority::PathClass::SingleDialogGrant,
                crate::infra::path_authority::PathOperation::ImageRead,
                crate::infra::path_authority::PICKER_DIALOG_GRANT_TTL,
                1,
            )?;
            Ok::<_, Error>((issuance_lease, grant))
        })??
    };
    // The lease intentionally spans descriptor reads, the complete blocking copy, registration,
    // and error cleanup. A dropped command future cannot let shutdown unlink this image early.
    let _issuance_lease = issuance_lease;
    #[cfg(test)]
    pause_image_issuance_after_lease();
    let app_data = app_data_override
        .map(Ok)
        .unwrap_or_else(|| crate::infra::path_authority::AppDataDir::for_app(&app))?;
    let (file, declared) = crate::infra::path_authority::engine_image_reader_for(
        authority,
        &crate::infra::path_authority::EngineImageHandle::new(grant),
        MAX_ENGINE_IMAGE_BYTES,
    )?;
    let bytes = crate::infra::path_authority::read_engine_image_bytes(
        file,
        declared,
        MAX_ENGINE_IMAGE_BYTES,
    )?;
    engine_image_mime_type(&bytes)?;
    let image_dir = crate::infra::path_authority::ensure_app_owned_default_dir(
        &app_data,
        crate::infra::path_authority::AppOwnedDefaultRoot::EngineImages,
    )?;
    let leaf_name = uuid::Uuid::new_v4().to_string();
    let leaf = OsStr::new(&leaf_name);
    let (outcome, installed) = image_dir
        .atomic_replace_leaf_identified(leaf, |file| file.write_all(&bytes).map_err(Error::from))?;
    match outcome {
        crate::infra::fs::AtomicFileOutcome::DurableCommit => {}
        crate::infra::fs::AtomicFileOutcome::CommittedDurabilityUncertain(error) => {
            log::warn!(
                "engine-image parent sync failed after installing {leaf_name:?}; the leaf is kept: {error}"
            );
        }
    }
    match authority.with_mut(|authority| {
        match authority.register_engine_image(&image_dir, leaf, installed, display_name) {
            Ok(handle) => Ok(handle),
            Err(error) => Err(engine_image_error_after_cleanup(
                &image_dir,
                leaf,
                installed,
                error,
                Some(authority),
            )),
        }
    }) {
        Ok(result) => result,
        Err(unavailable) => Err(engine_image_error_after_cleanup(
            &image_dir,
            leaf,
            installed,
            Error::from(unavailable),
            None,
        )),
    }
}

async fn issue_engine_image_blocking_async<R: tauri::Runtime>(
    authority: crate::infra::path_authority::SharedPathAuthority,
    app: tauri::AppHandle<R>,
    path: PathBuf,
    app_data_override: Option<crate::infra::path_authority::AppDataDir>,
) -> Result<crate::infra::path_authority::EngineImageHandle, Error> {
    BLOCKING_GATEWAY
        .spawn(move || issue_engine_image_blocking(&authority, app, path, app_data_override))
        .await
}

fn engine_image_error_after_cleanup(
    image_dir: &crate::infra::path_authority::AuthorizedDir,
    leaf: &OsStr,
    installed: crate::infra::path_authority::VerifiedIdentity,
    original: Error,
    authority: Option<&mut crate::infra::path_authority::PathAuthority>,
) -> Error {
    match image_dir.remove_leaf_identified(leaf, installed) {
        Ok(()) => original,
        Err(error) if error.is_missing_entry() => original,
        Err(Error::CommittedDurabilityUncertain(stage)) => {
            log::warn!("engine image {leaf:?} was removed but parent sync is uncertain at {stage}");
            original
        }
        Err(removal) => {
            let intent = authority.map_or_else(
                || "not recorded: no path authority".into(),
                |authority| {
                    authority
                        .record_engine_image_cleanup(image_dir, leaf, installed)
                        .diagnostic()
                },
            );
            Error::with_cleanup(
                original,
                Err(Error::Conflict(format!(
                    "failed to remove unregistered engine image {leaf:?}: {}; cleanup intent {intent}",
                    removal.diagnostic()
                ))),
            )
        }
    }
}

#[tauri::command]
#[specta::specta]
async fn read_engine_image(
    image: crate::infra::path_authority::EngineImageHandle,
    state: tauri::State<'_, AppState>,
) -> Result<EngineImageData, Error> {
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "read_engine_image",
        move || read_engine_image_blocking(&authority, image),
    )
    .await
}

fn read_engine_image_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    image: crate::infra::path_authority::EngineImageHandle,
) -> Result<EngineImageData, Error> {
    let (file, declared) = crate::infra::path_authority::engine_image_reader_for(
        authority,
        &image,
        MAX_ENGINE_IMAGE_BYTES,
    )?;
    let bytes = crate::infra::path_authority::read_engine_image_bytes(
        file,
        declared,
        MAX_ENGINE_IMAGE_BYTES,
    )?;
    Ok(EngineImageData {
        mime_type: engine_image_mime_type(&bytes)?.into(),
        bytes,
    })
}

#[tauri::command]
#[specta::specta]
async fn issue_opening_book(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::OpeningBookHandle, Error> {
    use tauri_plugin_dialog::DialogExt;
    let path = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_file()
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| {
                Error::InvalidInput(format!("invalid opening book selection: {error}"))
            })
    })
    .await
    .map_err(map_picker_join)??;
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_opening_book",
        move || issue_opening_book_blocking(&authority, path),
    )
    .await
}

fn issue_opening_book_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    path: PathBuf,
) -> Result<crate::infra::path_authority::OpeningBookHandle, Error> {
    let label = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Opening book".into());
    authority.with_mut(|authority| authority.register_opening_book(&path, label))?
}

fn engine_archive_destination_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    root: crate::infra::path_authority::EngineRootHandle,
) -> Result<crate::infra::path_authority::PathRef, Error> {
    crate::infra::path_authority::with_engine_root_probe(
        authority,
        root.path_ref(),
        crate::infra::path_authority::PathOperation::DownloadArchive,
        &tokio_util::sync::CancellationToken::new(),
        |authority, probe| authority.engine_archive_destination_with_probe(&root, probe),
    )
}

fn register_installed_engine_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    root: crate::infra::path_authority::EngineRootHandle,
    relative_path: String,
) -> Result<crate::infra::path_authority::EngineHandle, Error> {
    let register = || {
        crate::infra::path_authority::with_engine_root_probe(
            authority,
            root.path_ref(),
            crate::infra::path_authority::PathOperation::EngineInstall,
            &tokio_util::sync::CancellationToken::new(),
            |authority, probe| authority.register_installed_engine(&root, &relative_path, probe),
        )
    };
    match register() {
        Err(original)
            if matches!(
                original.unlabelled(),
                Error::CommittedDurabilityUncertain(_)
            ) =>
        {
            // Registration is get-or-create on the adopted inode. Recover a committed handle
            // after a durability warning, preserving the original failure if lookup also fails.
            register().or(Err(original))
        }
        result => result,
    }
}

#[tauri::command]
#[specta::specta]
async fn open_engine_workspace(
    app: tauri::AppHandle,
    root: crate::infra::path_authority::EngineRootHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    use tauri_plugin_opener::OpenerExt;
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "open_engine_workspace",
        move || {
            open_engine_workspace_blocking(&authority, root, |path| {
                app.opener().open_path(path.to_string_lossy(), None::<&str>)
            })
        },
    )
    .await
}

fn open_engine_workspace_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    root: crate::infra::path_authority::EngineRootHandle,
    opener: impl FnOnce(&std::path::Path) -> Result<(), tauri_plugin_opener::Error>,
) -> Result<(), Error> {
    let path = authority.with_mut(|authority| authority.engine_root_path(&root))??;
    opener(&path).map_err(|error| {
        let error = Error::from(error);
        log::error!("cannot open engine workspace: {}", error.diagnostic());
        error
    })
}

/// Whole-process budget for shutdown cleanup. Independent resources are reaped
/// concurrently; this remains a backstop for a teardown that never completes.
const SHUTDOWN_BUDGET: Duration = Duration::from_secs(15);

const EXIT_IDLE: u8 = 0;
const EXIT_RUNNING: u8 = 1;
const EXIT_DONE: u8 = 2;

#[derive(Debug, PartialEq, Eq)]
enum ExitDecision {
    StartCleanup,
    PreventExit,
    AllowExit,
}

#[derive(Default)]
struct ExitGuard(std::sync::atomic::AtomicU8);

impl ExitGuard {
    fn request(&self) -> ExitDecision {
        match self.0.compare_exchange(
            EXIT_IDLE,
            EXIT_RUNNING,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        ) {
            Ok(_) => ExitDecision::StartCleanup,
            Err(EXIT_RUNNING) => ExitDecision::PreventExit,
            Err(EXIT_DONE) => ExitDecision::AllowExit,
            Err(_) => ExitDecision::PreventExit,
        }
    }

    fn finish(&self) {
        self.0.store(EXIT_DONE, std::sync::atomic::Ordering::SeqCst);
    }
}

struct SoundServerLifecycle {
    shutdown: sound::SoundShutdownTx,
    join: tokio::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl SoundServerLifecycle {
    // One loopback sound route on every platform; setup publishes either a live lifecycle or a
    // disabled one, so this is constructed in production wherever the app starts.
    fn new(
        shutdown: Option<tokio::sync::oneshot::Sender<()>>,
        join: Option<tauri::async_runtime::JoinHandle<()>>,
    ) -> Self {
        Self {
            shutdown: sound::SoundShutdownTx(std::sync::Mutex::new(shutdown)),
            join: tokio::sync::Mutex::new(join),
        }
    }

    async fn shutdown_and_join(&self) -> Result<(), String> {
        let shutdown = self
            .shutdown
            .0
            .lock()
            .map_err(|_| "sound shutdown lock was poisoned".to_string())?
            .take();
        if let Some(shutdown) = shutdown {
            let _ = shutdown.send(());
            // `scripts/verify-app.mjs` asserts this line: it is the only externally
            // observable evidence that the signal was sent rather than the sender
            // merely dropped. `b663a122` moved this teardown inside the shutdown
            // budget and deleted the log with the block it replaced, while adding
            // the assertion for it, so the check has been failing ever since.
            log::info!("Sound server shutdown signalled");
        }
        let join = self.join.lock().await.take();
        if let Some(join) = join {
            join.await
                .map_err(|error| format!("sound server join failed: {error}"))?;
        }
        Ok(())
    }
}

/// Every teardown the process owns. Awaited before the event loop is allowed to
/// exit, because tao exits the process from inside `run()` — no `Drop` runs
/// afterwards and any child that was not reaped here is re-parented to init.
async fn shutdown_backend_with_attachments<F, L>(
    supervisor: &EngineSupervisor,
    games: &GameManager,
    sound: Option<&SoundServerLifecycle>,
    operations: &OperationRegistry,
    attachments: F,
    launch_reclaim: L,
    budget: Duration,
) -> bool
where
    F: std::future::Future<Output = Result<(), String>>,
    L: std::future::Future<Output = Result<(), String>>,
{
    log::info!("Shutdown requested: terminating engines and live games");
    let seal_failure = operations
        .seal_and_request_cancellation()
        .err()
        .map(|error| format!("native operation admission seal failed: {error}"));
    let operations_for_drain = operations.clone();
    let cleanup = async {
        let engines = supervisor.terminate_all();
        // Reserve half of the process-wide budget for the direct engine
        // fallback used when a game loop ignores its shutdown signal.
        let games = games.shutdown_all(budget / 2);
        let sound = async {
            if let Some(sound) = sound {
                sound.shutdown_and_join().await
            } else {
                Ok(())
            }
        };
        let native_operations =
            tokio::task::spawn_blocking(move || operations_for_drain.wait_for_drain(budget));
        let (engines, games, sound, attachments, native_operations) =
            tokio::join!(engines, games, sound, attachments, native_operations);
        let mut failures = seal_failure.into_iter().collect::<Vec<_>>();
        if let Err(error) = engines {
            failures.push(format!("engine teardown failed: {error}"));
        }
        if let Err(error) = games {
            failures.push(format!("game teardown failed: {error}"));
        }
        if let Err(error) = sound {
            failures.push(error);
        }
        if let Err(error) = attachments {
            failures.push(format!("engine attachment teardown failed: {error}"));
        }
        match native_operations {
            Ok(Ok(true)) => {}
            Ok(Ok(false)) => failures.push("native operation drain timed out".into()),
            Ok(Err(error)) => failures.push(format!("native operation drain failed: {error}")),
            Err(error) => failures.push(format!("native operation drain task failed: {error}")),
        }
        if let Err(error) = launch_reclaim.await {
            failures.push(format!("engine launch-root teardown failed: {error}"));
        }
        failures
    };
    match tokio::time::timeout(budget, cleanup).await {
        Ok(failures) if failures.is_empty() => {
            log::info!("Shutdown cleanup finished");
            true
        }
        Ok(failures) => {
            log::error!("Shutdown cleanup failed: {}", failures.join("; "));
            false
        }
        Err(_) => {
            log::error!(
                "Shutdown budget of {budget:?} elapsed with native operations {:?}",
                operations
                    .outstanding_diagnostics()
                    .unwrap_or_else(|error| vec![format!("diagnostics unavailable: {error}")])
            );
            false
        }
    }
}

/// One process-wide deadline includes the post-teardown durable catalog clear. A false,
/// timed-out or panicked teardown never invokes it. Cancel queued native access on every exit.
async fn shutdown_with_catalog_clear<T, C, F>(teardown: T, clear: F, budget: Duration) -> bool
where
    T: std::future::Future<Output = bool>,
    C: std::future::Future<Output = Result<(), Error>>,
    F: FnOnce(tokio_util::sync::CancellationToken) -> C,
{
    let cancellation = tokio_util::sync::CancellationToken::new();
    let _cancel_on_exit = cancellation.clone().drop_guard();
    let mut phase = "teardown";
    let cleanup = async {
        if !teardown.await {
            return false;
        }
        phase = "catalog install session clear";
        match clear(cancellation).await {
            Ok(()) => true,
            Err(error) => {
                log::error!(
                    "catalog install session clear failed: {}",
                    error.diagnostic()
                );
                false
            }
        }
    };
    match tokio::time::timeout(budget, cleanup).await {
        Ok(success) => success,
        Err(error) => {
            log::error!("shutdown {phase} exceeded {budget:?}: {error}");
            false
        }
    }
}

/// Production shutdown boundary shared by RunEvent and durable catalog integration tests.
async fn shutdown_with_catalog_authority<T>(
    teardown: T,
    authority: crate::infra::path_authority::SharedPathAuthority,
    budget: Duration,
) -> bool
where
    T: std::future::Future<Output = bool>,
{
    shutdown_with_catalog_clear(
        teardown,
        |cancellation| async move {
            BLOCKING_GATEWAY
                .spawn(move || {
                    authority.with_mut_cancellable(&cancellation, |authority| {
                        if cancellation.is_cancelled() {
                            return Err(Error::Cancellation);
                        }
                        authority.clear_catalog_session_use()
                    })??
                })
                .await
        },
        budget,
    )
    .await
}

async fn shutdown_engine_launch_root(
    authority: crate::infra::path_authority::SharedPathAuthority,
) -> Result<(), Error> {
    #[cfg(target_os = "macos")]
    {
        let report = BLOCKING_GATEWAY
            .spawn(move || {
                authority.with_mut(|authority| Ok(authority.engine_launch_root()?.reclaim()))?
            })
            .await?;
        for (leaf, error) in &report.failed {
            log::error!(
                "engine launch leaf reclaim failed at exit for key={} engine_id={} category={}",
                leaf.engine_key,
                leaf.engine_id,
                error.category()
            );
        }
        if report.failed.is_empty() {
            Ok(())
        } else {
            Err(Error::Conflict(format!(
                "{} engine launch leaves could not be reclaimed",
                report.failed.len()
            )))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = authority;
        Ok(())
    }
}

async fn shutdown_engine_attachments(app: tauri::AppHandle) -> Result<(), Error> {
    let authority = app.state::<AppState>().pgn_path_authority.clone();
    seal_and_drain_engine_image_issuances(authority.clone()).await?;
    BLOCKING_GATEWAY
        .spawn(move || {
            let app_data = crate::infra::path_authority::AppDataDir::for_app(&app)?;
            authority.with_mut(|authority| {
                let image_dir = crate::infra::path_authority::ensure_app_owned_default_dir(
                    &app_data,
                    crate::infra::path_authority::AppOwnedDefaultRoot::EngineImages,
                )?;
                authority.cleanup_engine_images(&image_dir, false)
            })?
        })
        .await
}

async fn seal_and_drain_engine_image_issuances(
    authority: crate::infra::path_authority::SharedPathAuthority,
) -> Result<(), Error> {
    let authority_for_seal = authority.clone();
    let active_issuances = BLOCKING_GATEWAY
        .spawn(move || {
            authority_for_seal.with_mut(|authority| {
                authority.seal_engine_attachments();
                Ok::<_, Error>(authority.active_image_issuances())
            })?
        })
        .await?;
    active_issuances.wait_for_zero().await;
    Ok(())
}

/// Native log sinks. The webview is absent on purpose: a diagnostic that names a
/// path, SQL fragment or keyring error stays on stdout (and, in release, the log
/// directory) and is never emitted on `log://log`. `TargetKind::Webview` is not a
/// variant, so it cannot be configured without a compile error here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeLogSink {
    Stdout,
    LogDir,
}

const NATIVE_LOG_SINKS: &[NativeLogSink] = &[NativeLogSink::Stdout, NativeLogSink::LogDir];
/// Bound: 2 MiB per file plus 2 archived files (~6 MiB of native log on disk).
const NATIVE_LOG_MAX_FILE_SIZE: u128 = 2 * 1024 * 1024;
const NATIVE_LOG_ROTATION_KEEP: usize = 2;

fn native_log_sinks() -> &'static [NativeLogSink] {
    #[cfg(debug_assertions)]
    {
        &NATIVE_LOG_SINKS[..1]
    }
    #[cfg(not(debug_assertions))]
    {
        NATIVE_LOG_SINKS
    }
}

fn target_for_sink(sink: NativeLogSink) -> Target {
    match sink {
        NativeLogSink::Stdout => Target::new(TargetKind::Stdout),
        NativeLogSink::LogDir => Target::new(TargetKind::LogDir {
            file_name: Some(String::from(APP_LOG_FILE_STEM)),
        }),
    }
}

fn native_log_targets() -> Vec<Target> {
    native_log_sinks()
        .iter()
        .copied()
        .map(target_for_sink)
        .collect()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let specta_builder = tauri_specta::Builder::new()
        .commands(tauri_specta::collect_commands!(
            chessriddle::chessriddle_account,
            chessriddle::connect_chessriddle,
            chessriddle::disconnect_chessriddle,
            chessriddle::chessriddle_training_available,
            chessriddle::chessriddle_training_next,
            chessriddle::chessriddle_mistake_count,
            chessriddle::chessriddle_training_submit,
            chessriddle::chessriddle_open_upgrade,
            chessriddle::chessriddle_training_settings,
            chessriddle::chessriddle_save_training_settings,
            chessriddle::chessriddle_training_motifs,
            chessriddle::chessriddle_open_website,
            close_splashscreen,
            verify_signed_bytes,
            prepare_native_read,
            cancel_native_read,
            release_previous_document_operations,
            prepare_analysis,
            reconcile_startup_path_owners,
            reconcile_engine_attachments,
            issue_pgn_workspace,
            issue_pgn_export_destination,
            save_board_snapshot,
            save_engine_logs,
            open_documentation,
            open_app_log,
            issue_download_destination,
            download_destination_is_known,
            issue_database_workspace,
            get_database_workspace,
            list_workspace_databases,
            create_workspace_database,
            database_download_destination,
            issue_engine_workspace,
            get_engine_workspace,
            issue_engine_binary,
            issue_engine_resource,
            issue_engine_image,
            read_engine_image,
            issue_opening_book,
            open_engine_workspace,
            issue_file_workspace,
            list_file_workspace,
            create_workspace_file,
            create_workspace_directory,
            move_workspace_entry,
            rename_workspace_file,
            write_workspace_file_metadata,
            trash_workspace_entry,
            list_workspace_trash,
            empty_workspace_trash,
            restore_workspace_trash_item,
            delete_workspace_trash_item,
            get_best_moves,
            prepare_engine_search,
            analyze_game,
            cancel_analysis,
            stop_engine,
            release_engine_search,
            kill_engine,
            kill_engines,
            retire_engine,
            get_engine_logs,
            memory_size,
            get_puzzle,
            issue_puzzle_download_destination,
            issue_puzzle_workspace,
            get_puzzle_workspace,
            list_puzzle_databases,
            load_practice_deck,
            practice_epoch,
            record_practice_review,
            sync_practice_positions,
            reset_practice_deck,
            load_practice_reviews,
            migrate_practice_deck,
            acknowledge_practice_orphans,
            repair_practice_deck,
            list_practice_decks,
            search_opening_name,
            get_opening_from_fens,
            get_opening_from_name,
            get_players_game_info,
            get_engine_config,
            file_exists,
            merge_players,
            convert_pgn,
            prepare_conversion,
            cancel_conversion,
            release_conversion,
            get_player,
            db::infer_game_orientation,
            count_pgn_games,
            file_revision,
            read_game,
            db::linked_collections::list_linked_collections,
            db::linked_collections::resolve_linked_game,
            db::linked_collections::collection_for_database,
            db::linked_collections::migrate_linked_collection,
            db::linked_collections::prepare_account_collection,
            infra::operations::accounts::import_account_games,
            infra::operations::accounts::pending_account_completions,
            infra::operations::accounts::acknowledge_account_completion,
            db::linked_collections::batch::append_collection_games,
            db::linked_collections::edit_linked_collection,
            db::linked_collections::linked_collections_supported,
            db::linked_collections::rebuild_linked_collection,
            db::linked_collections::reselect_linked_collection,
            db::linked_collections::restore_collection_archive,
            read_games,
            lex_pgn,
            is_bmi2_compatible,
            delete_game,
            move_games,
            delete_duplicated_games,
            delete_empty_games,
            clear_games,
            delete_indexes,
            create_indexes,
            edit_db_info,
            delete_db_game,
            write_db_game,
            insert_db_game,
            delete_database,
            export_to_pgn,
            authenticate,
            get_authentication_status,
            list_lichess_accounts,
            remove_lichess_account,
            migrate_legacy_lichess_token,
            revoke_legacy_lichess_token,
            get_authenticated_lichess_account,
            get_authenticated_lichess_explorer,
            get_public_lichess_json,
            write_game,
            set_game_section,
            download_file,
            fs::install_engine_workflow,
            fs::pending_engine_completions,
            fs::retire_engine_completion,
            fs::acknowledge_engine_completion,
            download_lichess_games,
            cancel_download,
            cancel_download_for_progress,
            prepare_download,
            release_download,
            get_tournaments,
            get_db_info::<tauri::Wry>,
            get_games,
            get_db_game,
            search_position,
            get_players,
            get_puzzle_themes,
            get_themes_for_puzzle,
            delete_puzzle_database,
            start_game,
            get_game_state,
            make_game_move,
            take_back_game_move,
            resign_game,
            abort_game,
            get_game_engine_logs,
            preload_reference_db,
            get_progress,
            failed_progress_snapshot,
            clear_progress,
            get_sound_server_port,
            download_chess_com_games,
            get_public_chess_com_json,
            submit_feedback
        ))
        .events(tauri_specta::collect_events!(
            chessbase::ChessBaseSelected,
            BestMovesPayload,
            ConvertProgress,
            DatabaseContentFailure,
            ProgressEvent,
            infra::operations::completions::CompletionChanged,
            GameMoveEvent,
            ClockUpdateEvent,
            GameOverEvent
        ));

    #[cfg(debug_assertions)]
    {
        let rendered = specta_builder
            .export_str(Typescript::default().bigint(BigIntExportBehavior::BigInt))
            .map_err(|error| format!("failed to render TypeScript bindings: {error}"))?;
        // `atomic_replace` refuses a parent path with `..`, so resolve the repository root here.
        let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("the manifest directory has no parent")?;
        crate::infra::fs::write_if_changed(
            &repository.join("src/bindings/generated.ts"),
            &rendered,
        )
        // Debug, not Display: `Error::Io` displays only a renderer-safe "I/O failure", and this
        // CLI export needs the cause.
        .map_err(|error| format!("failed to export TypeScript bindings: {error:?}"))?;
    }

    #[cfg(debug_assertions)]
    if std::env::args_os().any(|argument| argument == "--export-bindings-only") {
        return Ok(());
    }

    // Hoisted so the credential store can be constructed with the bundle identifier below; the
    // `--config` merge that `pnpm dev` applies is already resolved in here.
    let context = tauri::generate_context!();

    let app = tauri::Builder::default()
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(event) = event {
                if let Err(error) = chessbase::handle_drop(window, event) {
                    log::warn!("could not emit ChessBase selection: {error}");
                }
            }
        })
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .targets(native_log_targets())
                .max_file_size(NATIVE_LOG_MAX_FILE_SIZE)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(
                    NATIVE_LOG_ROTATION_KEEP,
                ))
                .level(LevelFilter::Info)
                .build(),
        )
        .invoke_handler(specta_builder.invoke_handler())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            log::info!("Setting up application");
            // A debug build that carries the release identifier writes the installed release's
            // databases, engines and keyring entries.  `pnpm dev` merges tauri.dev.conf.json to
            // prevent that; `pnpm tauri dev` and a bare `cargo run` do not, and nothing else in the
            // process would say so.
            if cfg!(debug_assertions) && !app.config().identifier.ends_with(".dev") {
                log::warn!(
                    "development build running under the release identifier {} — it reads and \
                     writes the installed release's data. Start it with `pnpm dev`.",
                    app.config().identifier
                );
            }
            // Credential initialization reaches the filesystem through the same descriptor doors
            // as unix: `ensure_app_owned_default_dir`, the `open_regular_relative` walk, and
            // `atomic_replace_leaf_identified` are all ungated, so Windows materialises
            // `credentials/` and commits the registry instead of failing at the root. The Lichess
            // `authenticate` / `migrate_legacy_lichess_token` doors remain refused
            // (`oauth.rs:445`, `:575`) and are a different finding.
            let app_data = crate::infra::path_authority::AppDataDir::for_app(app.handle())
                .map_err(|error| {
                    log::error!("application data directory could not be acquired: {error}");
                    "application data directory could not be acquired"
                })?;
            let admission = crate::infra::path_authority::admit_instance(app.handle(), &app_data)
                .map_err(|_| {
                "application data directory instance lock could not be acquired"
            })?;
            let app_data_locked = match admission {
                crate::infra::path_authority::InstanceAdmission::Owned(guard) => {
                    let app_data_locked = guard.app_data_locked();
                    app.manage(guard);
                    app_data_locked
                }
                crate::infra::path_authority::InstanceAdmission::Unguarded => false,
                crate::infra::path_authority::InstanceAdmission::HeldElsewhere => {
                    use tauri_plugin_dialog::DialogExt;
                    app.dialog()
                        .message(
                            "ChessRiddle Studio is already open. Switch to its window to continue.",
                        )
                        .title("ChessRiddle Studio is already running")
                        // Skip the window-state exit hook, which would save this refused launch's cache.
                        .show(|_| std::process::exit(0));
                    return Ok(());
                }
            };
            app.state::<AppState>()
                .credentials
                .initialize(&app_data)
                .map_err(|error| {
                    log::error!("native credential storage could not be initialized: {error}");
                    "native credential storage could not be initialized"
                })?;
            let authority_registry = app.path().app_config_dir()?.join("path-authority.json");
            let chessriddle = crate::chessriddle::initialize(app.handle())
                .map_err(|_| "ChessRiddle credential storage could not be initialized")?;
            app.state::<AppState>()
                .chessriddle
                .set(chessriddle)
                .map_err(|_| "ChessRiddle token owner was already initialized")?;
            app.state::<AppState>().pgn_repository.initialize_practice(
                crate::infra::path_authority::ensure_app_owned_default_dir(
                    &app_data,
                    crate::infra::path_authority::AppOwnedDefaultRoot::Practice,
                )?,
            )?;
            #[cfg(target_os = "macos")]
            let mut authority = {
                let launch_root =
                    crate::infra::path_authority::initialize_engine_launch_root(&app_data)
                        .map_err(|error| {
                            format!("engine launch root initialization failed: {error}")
                        })?;
                crate::infra::path_authority::PathAuthority::open_for_app(
                    authority_registry,
                    vec![],
                    Some(launch_root),
                )
                .map_err(|error| format!("path authority initialization failed: {error}"))?
            };
            #[cfg(not(target_os = "macos"))]
            let mut authority = crate::infra::path_authority::PathAuthority::open_for_app(
                authority_registry,
                vec![],
                (),
            )
            .map_err(|error| format!("path authority initialization failed: {error}"))?;
            authority.set_engine_image_sweep_root(app_data_locked.then_some(app_data));
            app.state::<AppState>()
                .pgn_path_authority
                .install(authority)
                .map_err(|_| "path authority lock poisoned")?;
            db::linked_collections::initialize(app.handle(), &app.state::<AppState>())
                .map_err(|error| format!("collection service initialization failed: {error}"))?;

            // #[cfg(any(windows, target_os = "macos"))]
            // set_shadow(&app.get_webview_window("main").unwrap(), true).unwrap();

            specta_builder.mount_events(app);

            // sound-startup — sliced by sound_startup_keeps_all_four_outcomes_distinguishable
            let (port, lifecycle) =
                match crate::infra::path_authority::ResourceDir::for_app(app.handle()) {
                    Err(error) => {
                        log::warn!("sound resource root could not be resolved: {error}");
                        (0, SoundServerLifecycle::new(None, None))
                    }
                    Ok(resource_dir) => {
                        match crate::infra::path_authority::open_app_owned_resource_dir(
                            &resource_dir,
                        ) {
                            Err(error) if error.is_missing_entry() => {
                                log::info!(
                                    "no bundled sound resources found, sound stays disabled"
                                );
                                (0, SoundServerLifecycle::new(None, None))
                            }
                            Err(error) => {
                                log::warn!("bundled sound resources could not be opened: {error}");
                                (0, SoundServerLifecycle::new(None, None))
                            }
                            Ok(sound_dir) => {
                                let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
                                // Port 0 means "no sound server"; the renderer skips playback rather
                                // than requesting http://127.0.0.1:0/. A construction failure is logged
                                // because it is otherwise indistinguishable from a build without sound
                                // resources — that silence is how the reactor panic in this very call
                                // reached a release.
                                match sound::create_sound_server(sound_dir, shutdown_rx) {
                                    Ok((port, server)) => {
                                        let join = tauri::async_runtime::spawn(server);
                                        (
                                            port,
                                            SoundServerLifecycle::new(
                                                Some(shutdown_tx),
                                                Some(join),
                                            ),
                                        )
                                    }
                                    Err(error) => {
                                        log::error!("sound server could not be started: {error}");
                                        (0, SoundServerLifecycle::new(None, None))
                                    }
                                }
                            }
                        }
                    }
                };
            app.manage(sound::SoundServerPort(port));
            app.manage(lifecycle);
            // sound-startup-end — sliced by sound_startup_keeps_all_four_outcomes_distinguishable

            // WebKitGTK only follows a desktop light/dark switch through GtkSettings.
            system_appearance::follow_desktop_color_scheme();

            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_cli::init())?;

            let main_window = app
                .config()
                .app
                .windows
                .first()
                .ok_or("main window configuration is missing")?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), main_window)?.build()?;

            log::info!("Finished rust initialization");

            Ok(())
        })
        .build(context)?;

    // The OS credential manager is shared by every build on the machine, so the store is
    // constructed with the running bundle identifier. Build the application and its logging
    // plugin before the process-lifetime clients so startup can record construction failures.
    let app_state = AppState::try_new(Arc::new(crate::credentials::CredentialManager::new(
        Arc::new(crate::credentials::OsCredentialStore::new(
            &app.config().identifier,
        )),
    )))
    .map_err(|error| {
        log::error!("application state could not be initialized: {error}");
        error
    })?;
    app.manage(app_state);
    app.run({
        let guard = Arc::new(ExitGuard::default());
        move |app, event| {
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = &event
            {
                cancel_destroyed_window_operations(&app.state::<AppState>(), label);
            }
            let tauri::RunEvent::ExitRequested { api, .. } = &event else {
                return;
            };
            match guard.request() {
                ExitDecision::StartCleanup => api.prevent_exit(),
                ExitDecision::PreventExit => {
                    api.prevent_exit();
                    return;
                }
                ExitDecision::AllowExit => return,
            }
            // Tao calls `process::exit` from inside `run()`, so nothing after
            // this point gets a second chance: the event loop has to stay
            // alive until the children are reaped.
            let app_handle = app.clone();
            let guard = guard.clone();
            tauri::async_runtime::spawn(async move {
                // The cleanup runs in its own task so that a panic inside it
                // arrives here as a `JoinError` instead of unwinding past the
                // `exit` below.
                let cleanup = tauri::async_runtime::spawn({
                    let app_handle = app_handle.clone();
                    async move {
                        let state = app_handle.state::<AppState>();
                        shutdown_with_catalog_authority(
                            shutdown_backend_with_attachments(
                                state.engine_supervisor.as_ref(),
                                &state.game_manager,
                                app_handle.try_state::<SoundServerLifecycle>().as_deref(),
                                &state.operations,
                                async {
                                    shutdown_engine_attachments(app_handle.clone())
                                        .await
                                        .map_err(|error| error.diagnostic())
                                },
                                {
                                    let authority = state.pgn_path_authority.clone();
                                    async move {
                                        shutdown_engine_launch_root(authority)
                                            .await
                                            .map_err(|error| error.diagnostic())
                                    }
                                },
                                SHUTDOWN_BUDGET,
                            ),
                            state.pgn_path_authority.clone(),
                            SHUTDOWN_BUDGET,
                        )
                        .await;
                    }
                });
                if let Err(error) = cleanup.await {
                    log::error!("shutdown cleanup did not finish: {error}");
                }
                // Unconditional, and outside the budget: a cleanup that hung
                // or panicked must never leave a windowless process running.
                guard.finish();
                app_handle.exit(0);
            });
        }
    });

    Ok(())
}

#[tauri::command]
#[specta::specta]
fn is_bmi2_compatible() -> bool {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    if is_x86_feature_detected!("bmi2") {
        return true;
    }
    false
}

#[tauri::command]
#[specta::specta]
fn memory_size() -> u32 {
    let total_bytes = sysinfo::System::new_all().total_memory();
    (total_bytes / 1024 / 1024) as u32
}

#[cfg(test)]
mod search_cache_tests {
    use super::*;
    use crate::db::SearchIndexChunk;
    use std::hash::Hash;
    use tempfile::tempdir;

    fn assert_clear_keeps_the_live_lock<K: Clone + Eq + Hash + Send + Sync>(
        cache: &Arc<SearchCache>,
        registry: fn(&SearchCache) -> &KeyedLocks<K, parking_lot::Mutex<()>>,
        key: K,
    ) {
        let holder = registry(cache).lease(key.clone());
        let held = holder.lock();
        let worker_cache = Arc::clone(cache);
        let worker_key = key.clone();
        let (waiting_tx, waiting_rx) = std::sync::mpsc::sync_channel(1);
        let (acquired_tx, acquired_rx) = std::sync::mpsc::sync_channel(1);
        let cancellation = tokio_util::sync::CancellationToken::new();
        let worker_cancellation = cancellation.clone();

        std::thread::scope(|scope| {
            let worker = scope.spawn(move || {
                let worker_lease = registry(&worker_cache).lease(worker_key);
                let _ = waiting_tx.send(());
                let acquired = worker_lease.lock_cancellable(&worker_cancellation).is_ok();
                let _ = acquired_tx.send(acquired);
            });

            waiting_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("second thread takes its lease before waiting");
            cache.clear();
            let third = registry(cache).lease(key);
            assert!(third.try_lock().is_none());
            drop(held);
            assert!(acquired_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("second thread acquires after the holder releases"));
            worker.join().expect("second lease holder must finish");
            drop(third);
        });

        drop(holder);
        assert_eq!(registry(cache).len(), 0);
    }

    fn generation_registry(cache: &SearchCache) -> &KeyedLocks<(u64, u64), parking_lot::Mutex<()>> {
        &cache.generation_locks
    }

    fn collision_registry(
        cache: &SearchCache,
    ) -> &KeyedLocks<(GameQuery, (u64, u64)), parking_lot::Mutex<()>> {
        &cache.collisions
    }

    #[test]
    fn bounded_cache_evicts_the_oldest_key() {
        let mut cache = BoundedSearchCache::default();
        cache.insert("first", 1, 2);
        cache.insert("second", 2, 2);
        cache.insert("third", 3, 2);
        assert_eq!(cache.get(&"first"), None);
        assert_eq!(cache.get(&"second"), Some(2));
        assert_eq!(cache.get(&"third"), Some(3));
    }

    #[test]
    fn database_and_index_revisions_do_not_share_cache_identity() {
        let directory = tempdir().unwrap();
        let first_database = directory.path().join("first.db");
        let second_database = directory.path().join("second.db");
        std::fs::write(&first_database, []).unwrap();
        std::fs::write(&second_database, []).unwrap();
        SearchIndexChunk::default()
            .write_to(db::get_index_path(&first_database))
            .unwrap();
        let mut changed = SearchIndexChunk::default();
        changed.entries.push(crate::db::SearchGameEntry {
            id: 1,
            white_id: 1,
            black_id: 2,
            date: None,
            result: Default::default(),
            pawn_home: 0,
            white_material: 0,
            black_material: 0,
            white_elo: 0,
            black_elo: 0,
            fen: None,
            moves: vec![],
        });
        changed
            .write_to(db::get_index_path(&second_database))
            .unwrap();

        let first = SearchIndexIdentity::for_test_database(
            &first_database,
            IndexSource::from_database(&first_database, 0).unwrap(),
        )
        .unwrap();
        let second = SearchIndexIdentity::for_test_database(
            &second_database,
            IndexSource::from_database(&second_database, 0).unwrap(),
        )
        .unwrap();
        assert_ne!(first, second);
        assert_ne!(first.source.object, second.source.object);
        assert_eq!(first.parent_object, second.parent_object);
    }

    #[test]
    fn identity_uses_only_the_preferred_sidecar_descriptor() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("legacy.db");
        std::fs::write(&database, []).unwrap();
        let legacy = db::legacy_index_path(&database);
        std::fs::write(&legacy, [0_u8; 3]).unwrap();

        let absent = SearchIndexIdentity::for_test_database(
            &database,
            IndexSource::from_database(&database, 0).unwrap(),
        );
        assert!(absent.is_err());

        let preferred = db::get_index_path(&database);
        SearchIndexChunk::default().write_to(&preferred).unwrap();
        let identity = SearchIndexIdentity::for_test_database(
            &database,
            IndexSource::from_database(&database, 0).unwrap(),
        )
        .unwrap();
        let preferred_file = std::fs::File::open(&preferred).unwrap();
        assert_eq!(
            identity.sidecar_object,
            crate::infra::path_authority::opened_file_identity(&preferred_file).unwrap()
        );
        assert_eq!(identity.length, preferred_file.metadata().unwrap().len());
        assert_ne!(
            identity.sidecar_object,
            crate::infra::path_authority::opened_file_identity(
                &std::fs::File::open(&legacy).unwrap()
            )
            .unwrap()
        );
    }

    #[test]
    fn invalidation_matches_replaced_database_at_the_same_path() {
        let (directory, cache, database, identity, key) = invalidation_fixture();
        std::fs::rename(&database, directory.path().join("old.db")).unwrap();
        std::fs::write(&database, b"replacement").unwrap();
        let target =
            crate::infra::path_authority::DatabaseFileTarget::for_test_path(&database).unwrap();
        assert_ne!(identity.source.object, target.identity());
        assert_eq!(
            identity.parent_object,
            search_parent_identity(&target).unwrap()
        );
        cache.invalidate_database(&target);
        assert!(
            cache.get_index(&identity).is_none(),
            "same-path replacement must evict the index"
        );
        assert!(
            cache.get_result(&key).is_none(),
            "same-path replacement must evict results"
        );
    }

    #[test]
    fn invalidation_matches_the_database_object_through_a_hard_link() {
        let (directory, cache, database, identity, key) = invalidation_fixture();
        let other_parent = directory.path().join("other-parent");
        std::fs::create_dir(&other_parent).unwrap();
        let alias = other_parent.join("alias.db");
        std::fs::hard_link(&database, &alias).unwrap();
        let target =
            crate::infra::path_authority::DatabaseFileTarget::for_test_path(&alias).unwrap();
        assert_eq!(identity.source.object, target.identity());
        assert_ne!(
            identity.parent_object,
            search_parent_identity(&target).unwrap()
        );
        cache.invalidate_database(&target);
        assert!(
            cache.get_index(&identity).is_none(),
            "hard-link alias must evict the index"
        );
        assert!(
            cache.get_result(&key).is_none(),
            "hard-link alias must evict results"
        );
    }

    #[test]
    fn invalidation_keeps_another_database_object_at_another_path() {
        let (directory, cache, _database, identity, key) = invalidation_fixture();
        let other_parent = directory.path().join("other-parent");
        std::fs::create_dir(&other_parent).unwrap();
        let other = other_parent.join("other.db");
        std::fs::write(&other, b"other").unwrap();
        let target =
            crate::infra::path_authority::DatabaseFileTarget::for_test_path(&other).unwrap();
        assert_ne!(identity.source.object, target.identity());
        assert_ne!(
            identity.parent_object,
            search_parent_identity(&target).unwrap()
        );
        cache.invalidate_database(&target);
        assert!(
            cache.get_index(&identity).is_some(),
            "unrelated database must keep the index"
        );
        assert!(
            cache.get_result(&key).is_some(),
            "unrelated database must keep results"
        );
    }

    fn invalidation_fixture() -> (
        tempfile::TempDir,
        SearchCache,
        PathBuf,
        SearchIndexIdentity,
        SearchResultKey,
    ) {
        let directory = tempdir().unwrap();
        let database = directory.path().join("cached.db");
        let cache = SearchCache::default();
        let (identity, key) = seed_database(&cache, &database);
        (directory, cache, database, identity, key)
    }

    fn seed_database(
        cache: &SearchCache,
        database: &Path,
    ) -> (SearchIndexIdentity, SearchResultKey) {
        std::fs::write(database, b"database").unwrap();
        let preferred = db::get_index_path(database);
        let source = IndexSource::from_database(database, 0).unwrap();
        SearchIndexChunk::default()
            .write_to_with_source(&preferred, source.clone())
            .unwrap()
            .expect_durable();
        let identity = SearchIndexIdentity::for_test_database(database, source).unwrap();
        let index = MmapSearchIndex::open(&preferred).unwrap();
        let key = SearchResultKey::new(GameQuery::new(), identity.clone());
        cache.insert_index(identity.clone(), index, cache.invalidation_snapshot());
        cache.insert_result(key.clone(), (Vec::new(), Vec::new()));
        (identity, key)
    }

    #[test]
    fn invalidation_matches_replacement_with_changed_spelling_and_keeps_readers() {
        let (directory, cache, database, identity, key) = invalidation_fixture();
        let reader = cache.get_index(&identity).unwrap();
        let snapshot = cache.invalidation_snapshot();
        std::fs::rename(&database, directory.path().join("old.db")).unwrap();
        let replacement = directory.path().join("CACHED.db");
        std::fs::write(&replacement, b"replacement").unwrap();
        let target =
            crate::infra::path_authority::DatabaseFileTarget::for_test_path(&replacement).unwrap();
        assert_ne!(identity.source.object, target.identity());
        assert_ne!(database.file_name(), replacement.file_name());
        cache.invalidate_database(&target);
        assert!(
            cache.get_index(&identity).is_none(),
            "changed object and spelling must evict index"
        );
        assert!(
            cache.get_result(&key).is_none(),
            "changed object and spelling must evict result"
        );
        assert_eq!(
            reader.source(),
            &identity.source,
            "readers retain the mapped generation"
        );
        cache.insert_index(identity.clone(), reader, snapshot);
        assert!(
            cache.get_index(&identity).is_none(),
            "late insertion must remain uncached"
        );
    }

    #[test]
    fn invalidation_evicts_other_objects_in_the_same_parent_only() {
        let (directory, cache, database, identity, key) = invalidation_fixture();
        let (sibling, sibling_key) = seed_database(&cache, &directory.path().join("sibling.db"));
        let unrelated = tempdir().unwrap();
        let (other, other_key) = seed_database(&cache, &unrelated.path().join("other.db"));
        let target =
            crate::infra::path_authority::DatabaseFileTarget::for_test_path(&database).unwrap();
        assert_ne!(sibling.source.object, target.identity());
        cache.invalidate_database(&target);
        for (identity, key) in [(&identity, &key), (&sibling, &sibling_key)] {
            assert!(
                cache.get_index(identity).is_none(),
                "same parent must evict index"
            );
            assert!(
                cache.get_result(key).is_none(),
                "same parent must evict result"
            );
        }
        assert!(
            cache.get_index(&other).is_some(),
            "different directory keeps index"
        );
        assert!(
            cache.get_result(&other_key).is_some(),
            "different directory keeps result"
        );
    }

    #[test]
    fn parent_metadata_failure_evicts_both_caches_and_rejects_late_insertion() {
        let (_directory, cache, database, identity, key) = invalidation_fixture();
        let unrelated = tempdir().unwrap();
        let (other, other_key) = seed_database(&cache, &unrelated.path().join("other.db"));
        let reader = cache.get_index(&identity).unwrap();
        let snapshot = cache.invalidation_snapshot();
        let target =
            crate::infra::path_authority::DatabaseFileTarget::for_test_path(&database).unwrap();
        FAIL_NEXT_SEARCH_PARENT_IDENTITY.with(|fail| fail.set(true));
        cache.invalidate_database(&target);
        assert!(
            cache.invalidation_snapshot() > snapshot,
            "failed metadata still advances invalidation"
        );
        for (identity, key) in [(&identity, &key), (&other, &other_key)] {
            assert!(
                cache.get_index(identity).is_none(),
                "metadata failure must clear every index"
            );
            assert!(
                cache.get_result(key).is_none(),
                "metadata failure must clear every result"
            );
        }
        cache.insert_index(identity.clone(), reader, snapshot);
        assert!(
            cache.get_index(&identity).is_none(),
            "metadata failure must reject late insertion"
        );
    }

    fn assert_alias_shares_cache_and_leases(
        database: &Path,
        alias: &Path,
        cache: &SearchCache,
        identity: &SearchIndexIdentity,
        key: &SearchResultKey,
    ) {
        use crate::infra::path_authority::DatabaseFileTarget;
        let original = DatabaseFileTarget::for_test_path(database).unwrap();
        let aliased = DatabaseFileTarget::for_test_path(alias).unwrap();
        assert_ne!(original.path(), aliased.path());
        assert_eq!(original.identity(), aliased.identity());
        let alias_identity =
            SearchIndexIdentity::for_test_database(alias, identity.source.clone()).unwrap();
        assert_eq!(
            &alias_identity, identity,
            "aliases mapping one sidecar must have equal identities"
        );
        assert!(
            cache.get_index(&alias_identity).is_some(),
            "alias must reuse cached index"
        );
        let alias_key = SearchResultKey::new(key.query.clone(), alias_identity.clone());
        assert!(
            cache.get_result(&alias_key).is_some(),
            "alias must reuse cached result"
        );
        // A competing mapping with distinct provenance proves insert returns the existing mapping.
        let alternate = database.with_extension("alternate.ecsi");
        let mut alternate_source = identity.source.clone();
        alternate_source.revision += 1;
        SearchIndexChunk::default()
            .write_to_with_source(&alternate, alternate_source)
            .unwrap()
            .expect_durable();
        let shared = cache.insert_index(
            alias_identity,
            MmapSearchIndex::open(alternate).unwrap(),
            cache.invalidation_snapshot(),
        );
        assert_eq!(
            shared.source(),
            &identity.source,
            "alias insertion must deduplicate the mapped index"
        );
        assert_eq!(cache.cached_index_count(), 1);
        let generation = cache.generation_lock(&original);
        let alias_generation = cache.generation_lock(&aliased);
        let held = generation.lock();
        assert!(
            alias_generation.try_lock().is_none(),
            "aliases share generation exclusion"
        );
        drop(held);
        let collision = cache.collision_lock(key.query.clone(), &original);
        let alias_collision = cache.collision_lock(key.query.clone(), &aliased);
        let held = collision.lock();
        assert!(
            alias_collision.try_lock().is_none(),
            "aliases share collision exclusion"
        );
        let mut other_query = key.query.clone();
        other_query.player1 = Some(1);
        assert!(cache
            .collision_lock(other_query, &aliased)
            .try_lock()
            .is_some());
        drop(held);
    }

    #[test]
    fn hard_link_aliases_share_identity_cache_and_leases() {
        let (directory, cache, database, identity, key) = invalidation_fixture();
        let alias = directory.path().join("alias.db");
        std::fs::hard_link(&database, &alias).unwrap();
        std::fs::hard_link(db::get_index_path(&database), db::get_index_path(&alias)).unwrap();
        assert_alias_shares_cache_and_leases(&database, &alias, &cache, &identity, &key);
    }

    #[test]
    fn native_case_aliases_share_identity_cache_and_leases() {
        let (directory, cache, database, identity, key) = invalidation_fixture();
        let alias = directory.path().join("CACHED.db");
        if let Err(error) = std::fs::metadata(&alias) {
            assert_eq!(error.kind(), io::ErrorKind::NotFound);
            writeln!(
                std::io::stderr().lock(),
                "CASE_ALIAS_APPLICABLE=false: alternate spelling is absent on this volume"
            )
            .unwrap();
            return;
        }
        writeln!(
            std::io::stderr().lock(),
            "CASE_ALIAS_APPLICABLE=true: alternate spelling resolves on this volume"
        )
        .unwrap();
        assert_alias_shares_cache_and_leases(&database, &alias, &cache, &identity, &key);
        std::fs::rename(&database, directory.path().join("old.db")).unwrap();
        std::fs::write(&alias, b"replacement").unwrap();
        let target =
            crate::infra::path_authority::DatabaseFileTarget::for_test_path(&alias).unwrap();
        assert_ne!(identity.source.object, target.identity());
        cache.invalidate_database(&target);
        assert!(
            cache.get_index(&identity).is_none(),
            "native alias replacement evicts index"
        );
        assert!(
            cache.get_result(&key).is_none(),
            "native alias replacement evicts result"
        );
    }

    #[test]
    fn parent_metadata_failure_during_identity_construction_propagates() {
        let (_directory, _cache, database, identity, _key) = invalidation_fixture();
        FAIL_NEXT_SEARCH_PARENT_IDENTITY.with(|fail| fail.set(true));
        let result = SearchIndexIdentity::for_test_database(&database, identity.source);
        assert!(
            matches!(result, Err(Error::Io(_))),
            "parent metadata error must propagate before publication"
        );
    }

    #[test]
    fn generation_lock_is_shared_only_for_the_same_object() {
        let (directory, cache, database, _identity, _key) = invalidation_fixture();
        let other_database = directory.path().join("other.db");
        seed_database(&cache, &other_database);
        let target =
            crate::infra::path_authority::DatabaseFileTarget::for_test_path(&database).unwrap();
        let other_target =
            crate::infra::path_authority::DatabaseFileTarget::for_test_path(&other_database)
                .unwrap();
        assert_ne!(target.identity(), other_target.identity());
        let first = cache.generation_lock(&target);
        let same = cache.generation_lock(&target);
        let other = cache.generation_lock(&other_target);
        let held = first.lock();
        assert!(same.try_lock().is_none());
        assert!(other.try_lock().is_some());
        drop(held);
        let first_collision = cache.collision_lock(GameQuery::new(), &target);
        let same_collision = cache.collision_lock(GameQuery::new(), &target);
        let other_collision = cache.collision_lock(GameQuery::new(), &other_target);
        let held = first_collision.lock();
        assert!(same_collision.try_lock().is_none());
        assert!(other_collision.try_lock().is_some());
        drop(held);
    }

    #[test]
    fn clear_keeps_generation_and_collision_locks_with_live_leases() {
        let cache = Arc::new(SearchCache::default());
        assert_clear_keeps_the_live_lock(&cache, generation_registry, (1, 1));
        assert_clear_keeps_the_live_lock(&cache, collision_registry, (GameQuery::new(), (1, 1)));
    }
}

#[cfg(test)]
mod native_window_operation_wiring_tests {
    use super::*;

    #[test]
    fn previous_document_command_uses_actual_owner_and_shared_analysis_signal() {
        use crate::infra::blocking::source_scan::body_at_indent;
        let source = include_str!("main.rs");
        let command = body_at_indent(source, "fn release_previous_document_operations(");
        assert_eq!(command.matches("window.label()").count(), 1, "{command}");
        let compact: String = command.chars().filter(|c| !c.is_whitespace()).collect();
        assert!(compact.contains("release_previous_document_operations_in_registry(&state.operations,&state.engine_supervisor,window.label(),)"), "{command}");
        for signature in [
            "fn release_previous_document_operations_in_registry(",
            "fn cancel_destroyed_window_operations_in_registry(",
        ] {
            let body = body_at_indent(source, signature);
            assert_eq!(
                body.matches("signal_cancelled_analyses(supervisor, &cancelled)")
                    .count(),
                1,
                "{body}"
            );
        }
        let signal = body_at_indent(source, "fn signal_cancelled_analyses(");
        assert!(
            signal.contains("chess::cancel_analysis_engine(supervisor, &operation.id)"),
            "{signal}"
        );
        let destroy = body_at_indent(source, "fn cancel_destroyed_window_operations(");
        assert!(destroy.contains("&state.engine_supervisor"), "{destroy}");
        let cancel = body_at_indent(include_str!("chess.rs"), "pub async fn cancel_analysis(");
        assert!(
            cancel.contains("cancel_analysis_engine(&state.engine_supervisor, &id)"),
            "{cancel}"
        );
    }

    #[tokio::test]
    async fn lifecycle_cancellation_signals_the_exact_supervised_analysis() {
        for destroyed in [false, true] {
            let operations = OperationRegistry::default();
            let supervisor = crate::engine::EngineSupervisor::default();
            let id = operations.prepare_analysis("main", "tab").unwrap();
            let lease = operations
                .claim_analysis(&id, "main", "tab", "analysis")
                .unwrap();
            let other_id = operations.prepare_analysis("other", "tab").unwrap();
            let other_lease = operations
                .claim_analysis(&other_id, "other", "tab", "other analysis")
                .unwrap();
            let mut processes = Vec::new();
            for id in [&id, &other_id] {
                let key = crate::engine::EngineKey::new("analysis".into(), id.clone()).unwrap();
                let (actor, _) = crate::engine::EngineActor::recording_test_actor(&[]);
                processes.push(
                    supervisor
                        .replace_handle(
                            key,
                            actor,
                            id.clone(),
                            crate::infra::path_authority::PathRef {
                                id: "test-engine".into(),
                            },
                        )
                        .await
                        .unwrap(),
                );
            }

            if destroyed {
                cancel_destroyed_window_operations_in_registry(&operations, &supervisor, "main");
            } else {
                release_previous_document_operations_in_registry(&operations, &supervisor, "main")
                    .unwrap();
            }
            assert!(lease.token().is_cancelled());
            assert!(!other_lease.token().is_cancelled());
            assert!(processes[0]
                .cancelled
                .load(std::sync::atomic::Ordering::SeqCst));
            // Publication consults the supervisor signal independently of the registry token.
            assert!(!processes[0].try_publish(|| Ok::<_, Error>(())).unwrap());
            assert!(processes[1].try_publish(|| Ok::<_, Error>(())).unwrap());
            supervisor.terminate_all().await.unwrap();
        }
    }

    #[test]
    fn previous_document_sweep_returns_typed_registry_failure() {
        let operations = OperationRegistry::default();
        operations.poison_for_test();
        assert!(matches!(
            release_previous_document_operations_in_registry(
                &operations,
                &crate::engine::EngineSupervisor::default(),
                "main"
            ),
            Err(Error::Conflict(_))
        ));
    }

    #[test]
    fn destroyed_window_dispatches_its_actual_label() {
        let source = include_str!("main.rs");
        let event_loop = source
            .split("move |app, event| {")
            .nth(1)
            .expect("application event loop must exist")
            .split("let tauri::RunEvent::ExitRequested")
            .next()
            .expect("window event branch must precede exit handling");
        assert!(event_loop.contains("WindowEvent::Destroyed"));
        assert!(event_loop.contains("cancel_destroyed_window_operations"));
        assert!(event_loop.contains(", label);"));
        assert!(!event_loop
            .contains("cancel_destroyed_window_operations(&app.state::<AppState>(), \"main\")"));
    }

    #[tokio::test]
    async fn destroyed_window_core_cancels_held_worker_but_not_other_owners() {
        let operations = OperationRegistry::default();
        let destroyed_ticket = operations.prepare_read("destroyed").unwrap();
        let destroyed = operations
            .claim_read(&destroyed_ticket, "destroyed", "held worker")
            .unwrap();
        let other_ticket = operations.prepare_read("other").unwrap();
        let other = operations
            .claim_read(&other_ticket, "other", "other worker")
            .unwrap();
        let accepted = operations.accept("accepted").unwrap();

        let cancellation = destroyed.token();
        let worker_token = cancellation.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker = tokio::spawn(crate::infra::operations::run_native_operation(
            destroyed,
            "held worker",
            async move {
                BLOCKING_GATEWAY
                    .spawn_cancellable(worker_token, move |token| {
                        let _ = started_tx.send(());
                        release_rx
                            .recv_timeout(Duration::from_secs(5))
                            .map_err(|_| Error::Conflict("test worker release timed out".into()))?;
                        if token.is_cancelled() {
                            Err::<(), _>(Error::Cancellation)
                        } else {
                            Ok(())
                        }
                    })
                    .await
            },
        ));
        tokio::time::timeout(Duration::from_secs(5), started_rx)
            .await
            .unwrap()
            .unwrap();

        cancel_destroyed_window_operations_in_registry(
            &operations,
            &crate::engine::EngineSupervisor::default(),
            "destroyed",
        );

        assert!(cancellation.is_cancelled());
        assert!(operations
            .outstanding_labels()
            .unwrap()
            .contains(&"held worker".to_string()));
        assert!(!other.token().is_cancelled());
        assert!(!accepted.token().is_cancelled());
        release_tx.send(()).unwrap();
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(5), worker)
                .await
                .unwrap()
                .unwrap(),
            Err(Error::Cancellation)
        ));
        assert!(!operations
            .outstanding_labels()
            .unwrap()
            .contains(&"held worker".to_string()));
    }

    #[test]
    fn raw_read_claims_reject_wrong_owner_duplicate_and_expired_without_accepted_fallback() {
        let mut state = AppState::default();
        let ticket = state.operations.prepare_read("owner").unwrap();
        assert!(
            native_read_operation_for_owner(Some(ticket.clone()), "wrong", &state, "raw read")
                .is_err()
        );
        assert!(state.operations.outstanding_labels().unwrap().is_empty());
        let lease =
            native_read_operation_for_owner(Some(ticket.clone()), "owner", &state, "raw read")
                .unwrap();
        assert!(
            native_read_operation_for_owner(Some(ticket), "owner", &state, "raw read").is_err()
        );
        drop(lease);

        state.operations = OperationRegistry::with_reservation_ttl(Duration::ZERO);
        let expired = state.operations.prepare_read("owner").unwrap();
        assert!(
            native_read_operation_for_owner(Some(expired), "owner", &state, "raw read").is_err()
        );
        assert!(state.operations.outstanding_labels().unwrap().is_empty());

        let accepted =
            native_read_operation_for_owner(None, "owner", &state, "accepted read").unwrap();
        assert_eq!(
            state.operations.outstanding_labels().unwrap(),
            vec!["accepted read"]
        );
        drop(accepted);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimated_search_result_includes_recency_allocations(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut result = (
            vec![PositionStats {
                move_: "e4".into(),
                white: 3,
                draw: 0,
                black: 0,
                unknown: 0,
                last_played: None,
                year_counts: vec![],
            }],
            vec![],
        );
        let empty_recency = estimated_search_result_bytes(&result);
        let mut date = String::with_capacity(32);
        date.push_str("2026.11.08");
        result.0[0].last_played = Some(date);
        assert_eq!(estimated_search_result_bytes(&result), empty_recency + 32);
        result.0[0].year_counts = serde_json::from_str(r#"[{"year":2026,"count":3}]"#)?;
        result.0[0].year_counts.reserve(5);
        let year_bytes =
            result.0[0].year_counts.capacity() * std::mem::size_of_val(&result.0[0].year_counts[0]);
        assert_eq!(
            estimated_search_result_bytes(&result),
            empty_recency + 32 + year_bytes
        );
        Ok(())
    }

    #[test]
    fn database_and_engine_workspace_descriptors_preserve_selected_names_and_handles() {
        use crate::infra::path_authority::{PathAuthority, SharedPathAuthority};

        let directory = tempfile::tempdir().unwrap();
        let databases = directory.path().join("MyChessDBs");
        let engines = directory.path().join("MyChessEngines");
        std::fs::create_dir(&databases).unwrap();
        std::fs::create_dir(&engines).unwrap();
        let authority = SharedPathAuthority::installed(
            PathAuthority::open(directory.path().join("registry.json"), vec![]).unwrap(),
        );
        let no_default = || Err(Error::Conflict("unexpected app-data lookup".into()));

        let database = issue_database_workspace_blocking(&authority, databases).unwrap();
        assert_eq!(database.display_name, "MyChessDBs");
        assert_eq!(
            get_database_workspace_blocking(&authority, &no_default).unwrap(),
            database
        );
        let engine = issue_engine_workspace_blocking(&authority, engines).unwrap();
        assert_eq!(engine.display_name, "MyChessEngines");
        assert_eq!(
            get_engine_workspace_blocking(&authority, &no_default).unwrap(),
            engine
        );
    }

    #[test]
    fn database_and_engine_workspace_bodies_default_only_without_a_selection() {
        use crate::infra::path_authority::{
            portable_tests::assert_workspace_body_defaults_only_without_a_selection,
            AppOwnedDefaultRoot,
        };
        for domain in [AppOwnedDefaultRoot::Databases, AppOwnedDefaultRoot::Engines] {
            assert_workspace_body_defaults_only_without_a_selection(domain, |authority, lookup| {
                match domain {
                    AppOwnedDefaultRoot::Databases => {
                        get_database_workspace_blocking(authority, lookup).map(|descriptor| {
                            assert_eq!(descriptor.display_name, "Databases");
                            descriptor.root.path_ref().clone()
                        })
                    }
                    AppOwnedDefaultRoot::Engines => {
                        get_engine_workspace_blocking(authority, lookup).map(|descriptor| {
                            assert_eq!(descriptor.display_name, "Engines");
                            descriptor.root.path_ref().clone()
                        })
                    }
                    _ => unreachable!(),
                }
            });
        }
    }

    #[test]
    fn database_and_engine_workspace_bodies_refuse_unusable_selections_without_defaults() {
        use crate::infra::path_authority::{
            portable_tests::assert_workspace_body_refuses_unusable_selections_without_defaults,
            AppOwnedDefaultRoot,
        };
        for domain in [AppOwnedDefaultRoot::Databases, AppOwnedDefaultRoot::Engines] {
            assert_workspace_body_refuses_unusable_selections_without_defaults(
                domain,
                |authority, lookup| match domain {
                    AppOwnedDefaultRoot::Databases => {
                        get_database_workspace_blocking(authority, lookup)
                            .map(|descriptor| descriptor.root.path_ref().clone())
                    }
                    AppOwnedDefaultRoot::Engines => {
                        get_engine_workspace_blocking(authority, lookup)
                            .map(|descriptor| descriptor.root.path_ref().clone())
                    }
                    _ => unreachable!(),
                },
            );
        }
    }

    #[test]
    fn root_failure_default_database_non_directory_is_unusable() {
        use crate::infra::path_authority::{AppDataDir, PathAuthority, SystemClock};
        let directory = tempfile::tempdir().unwrap();
        let app_data = AppDataDir::for_test(directory.path());
        std::fs::write(directory.path().join("db"), b"not a directory").unwrap();
        let mut authority = PathAuthority::open_with_clock(
            directory.path().join("registry.json"),
            vec![],
            std::sync::Arc::new(SystemClock),
            2,
        )
        .unwrap();
        let error = get_default_database_workspace(&mut authority, &app_data).unwrap_err();
        assert_eq!(
            error.root_failure(),
            Some(crate::error::RootFailure::Unusable)
        );
        assert_eq!(error.category(), crate::error::ErrorCategory::Io);
        assert_eq!(error.to_string(), "I/O failure");
        assert_eq!(
            error.diagnostic(),
            "I/O failure: app-owned default root is not a directory"
        );
    }

    #[test]
    fn open_engine_workspace_redacts_opener_path_and_logs_native_cause() {
        use crate::infra::path_authority::{PathAuthority, SharedPathAuthority};
        let directory = tempfile::tempdir().unwrap();
        let fixture_path = directory.path().canonicalize().unwrap();
        let mut authority = PathAuthority::open_for_engine_test(&fixture_path).unwrap();
        let root = authority
            .get_or_create_engine_root(&fixture_path, "Engines", None)
            .unwrap();
        let authority = SharedPathAuthority::installed(authority);
        let capture = crate::error::LogCaptureScope::start();
        let cause = format!("opener rejected private path {}", fixture_path.display());
        let error = open_engine_workspace_blocking(&authority, root, |path| {
            assert_eq!(path, fixture_path);
            Err(tauri_plugin_opener::Error::Io(std::io::Error::other(
                cause.clone(),
            )))
        })
        .unwrap_err();
        let payload = serde_json::to_value(&error).unwrap();
        assert!(!payload.to_string().contains(&cause));
        assert!(!payload
            .to_string()
            .contains(&fixture_path.display().to_string()));
        assert_eq!(payload["category"], "platform");
        assert!(matches!(&error, Error::TauriOpener(_)));
        assert!(error.diagnostic().contains(&cause));
        assert!(capture
            .messages()
            .iter()
            .any(|message| message.contains(&cause)));
    }

    #[test]
    fn native_folder_selection_commands_use_the_shared_redacting_helper() {
        use crate::infra::blocking::source_scan::body_at_indent;

        for (source, signature) in [
            (
                include_str!("main.rs"),
                "async fn issue_download_destination(",
            ),
            (
                include_str!("main.rs"),
                "async fn issue_database_workspace(",
            ),
            (
                include_str!("file_workspace.rs"),
                "pub async fn issue_file_workspace(",
            ),
        ] {
            let body = body_at_indent(source, signature);
            assert!(
                body.contains("Error::native_folder_selection("),
                "{signature}"
            );
            assert!(!body.contains("Error::InvalidInput"), "{signature}");
            assert!(!body.contains("{error}"), "{signature}");
        }
    }

    #[test]
    fn create_workspace_file_publishes_through_exclusive_create() {
        use crate::infra::blocking::source_scan::body_at_indent;

        let body = body_at_indent(
            include_str!("file_workspace.rs"),
            "fn create_owned_workspace_file_blocking(",
        );
        assert!(body.contains("atomic_create_at_identified_with_precommit("));
        assert!(body.contains("atomic_create_at_identified("));
        assert!(!body.contains("atomic_replace_at_identified"));
    }

    #[test]
    fn native_log_targets_never_include_the_webview() {
        use crate::infra::blocking::source_scan::body_at_indent;

        assert_eq!(
            NATIVE_LOG_SINKS,
            &[NativeLogSink::Stdout, NativeLogSink::LogDir]
        );
        assert_eq!(native_log_sinks(), &[NativeLogSink::Stdout]);
        assert_eq!(native_log_targets().len(), native_log_sinks().len());
        let _ = target_for_sink(NativeLogSink::LogDir);
        assert_eq!(APP_LOG_FILE_STEM, "chessriddle-studio");
        assert_eq!(APP_LOG_FILE_NAME, "chessriddle-studio.log");
        assert_eq!(APP_LOG_FILE_NAME, format!("{APP_LOG_FILE_STEM}.log"));
        assert_eq!(NATIVE_LOG_MAX_FILE_SIZE, 2 * 1024 * 1024);
        assert_eq!(NATIVE_LOG_ROTATION_KEEP, 2);

        let source = include_str!("main.rs");
        let sinks = body_at_indent(source, "fn native_log_sinks()");
        let map = body_at_indent(source, "fn target_for_sink(");
        let targets = body_at_indent(source, "fn native_log_targets()");
        let opener = body_at_indent(source, "fn open_app_log_blocking(");
        assert!(
            !sinks.contains("Webview") && !map.contains("Webview") && !targets.contains("Webview"),
            "a path-bearing native log must not have a webview sink"
        );
        assert!(
            targets.contains("native_log_sinks()") && targets.contains("target_for_sink"),
            "plugin sinks must be exactly NativeLogSink, which has no webview: {targets}"
        );
        assert!(
            map.contains("APP_LOG_FILE_STEM") && opener.contains("APP_LOG_FILE_NAME"),
            "log-dir uses the plugin stem; open_app_log reads the derived active file"
        );
        assert!(
            !map.contains("APP_LOG_FILE_NAME"),
            "LogDir file_name is the stem; the plugin appends .log: {map}"
        );

        let main = body_at_indent(source, "fn main()");
        assert!(
            main.contains("native_log_targets()"),
            "the plugin must take sinks only from native_log_targets: {main}"
        );
        assert!(
            !main.contains("TargetKind::Webview"),
            "main must not reintroduce the webview log target: {main}"
        );
        assert!(
            main.contains(".max_file_size(NATIVE_LOG_MAX_FILE_SIZE)"),
            "the plugin must take the named max-file-size bound: {main}"
        );
        assert!(
            main.contains("RotationStrategy::KeepSome(")
                && main.contains("NATIVE_LOG_ROTATION_KEEP"),
            "the plugin must keep the named archive count: {main}"
        );
    }

    #[test]
    fn documentation_url_targets_the_fork_repository() {
        assert_eq!(
            DOCUMENTATION_URL,
            "https://github.com/felixabeck/chessriddle-studio/tree/master/docs"
        );
    }

    fn test_credentials() -> Arc<crate::credentials::CredentialManager> {
        Arc::new(crate::credentials::CredentialManager::default())
    }

    fn failing_client_builder() -> reqwest::ClientBuilder {
        reqwest::Client::builder().user_agent("\n")
    }

    #[test]
    fn app_state_constructs_both_http_clients() {
        assert!(AppState::try_new(test_credentials()).is_ok());
    }

    #[test]
    fn app_state_propagates_download_client_construction_failure() {
        assert!(AppState::try_new_with_builders(
            test_credentials(),
            failing_client_builder(),
            reqwest::Client::builder(),
        )
        .is_err());
    }

    #[test]
    fn app_state_propagates_json_client_failure_after_download_client_succeeds() {
        assert!(AppState::try_new_with_builders(
            test_credentials(),
            reqwest::Client::builder(),
            failing_client_builder(),
        )
        .is_err());
    }

    #[test]
    fn exit_requests_are_blocked_until_cleanup_is_done() {
        let guard = ExitGuard::default();
        assert!(
            matches!(guard.request(), ExitDecision::StartCleanup),
            "the first request must run the cleanup"
        );
        assert!(
            matches!(guard.request(), ExitDecision::PreventExit),
            "a second request must remain blocked while cleanup runs"
        );
        guard.finish();
        assert!(matches!(guard.request(), ExitDecision::AllowExit));
    }

    #[test]
    fn native_export_keeps_the_file_and_reports_uncertain_durability() {
        let directory = tempfile::tempdir().expect("export directory");
        let path = directory.path().join("board.png");
        crate::infra::fs::set_test_atomic_file_injector(Some(std::sync::Arc::new(
            crate::infra::fs::ParentSyncFault("uncertain"),
        )));
        let error = save_native_export_blocking(path.clone(), "png".into(), b"png".to_vec())
            .expect_err("uncertain durability must be surfaced");
        crate::infra::fs::set_test_atomic_file_injector(None);
        assert!(matches!(
            error,
            Error::CommittedDurabilityUncertain(crate::error::DurabilityStage::NativeExport)
        ));
        assert_eq!(std::fs::read(&path).expect("exported file"), b"png");
        assert!(save_native_export_blocking(path, "png".into(), b"png".to_vec()).is_ok());
    }

    struct HeldNativeExport {
        entered: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
        fail: bool,
    }

    impl crate::infra::fs::AtomicWriterInjector for HeldNativeExport {
        fn inject(&self, point: crate::infra::fs::AtomicFileFaultPoint) -> std::io::Result<()> {
            if point != crate::infra::fs::AtomicFileFaultPoint::Write {
                return Ok(());
            }
            if let Some(entered) = self.entered.lock().unwrap().take() {
                let _ = entered.send(());
            }
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .map_err(|_| std::io::Error::other("native export release timed out"))?;
            if self.fail {
                Err(std::io::Error::other("injected native export failure"))
            } else {
                Ok(())
            }
        }
    }

    struct NativeExportTestGuard(Option<std::sync::mpsc::Sender<()>>);

    impl NativeExportTestGuard {
        fn release(&mut self) {
            if let Some(release) = self.0.take() {
                let _ = release.send(());
            }
        }
    }

    impl Drop for NativeExportTestGuard {
        fn drop(&mut self) {
            self.release();
            crate::infra::fs::set_test_atomic_file_injector(None);
        }
    }

    #[tokio::test]
    async fn native_export_core_keeps_real_success_and_error_tails_after_caller_drop() {
        for fail in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("board.png");
            let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let mut guard = NativeExportTestGuard(Some(release_tx));
            crate::infra::fs::set_test_atomic_file_injector(Some(Arc::new(HeldNativeExport {
                entered: std::sync::Mutex::new(Some(entered_tx)),
                release: std::sync::Mutex::new(release_rx),
                fail,
            })));

            let operations = OperationRegistry::default();
            let task_operations = operations.clone();
            let task_path = path.clone();
            let caller = tokio::spawn(async move {
                crate::infra::operations::run_accepted_blocking(
                    &task_operations,
                    "save_board_snapshot",
                    move || {
                        save_native_export_blocking(
                            task_path,
                            "png".into(),
                            b"owned export".to_vec(),
                        )
                    },
                )
                .await
            });
            tokio::time::timeout(Duration::from_secs(5), entered_rx)
                .await
                .unwrap()
                .unwrap();
            caller.abort();
            assert_eq!(
                operations.outstanding_labels().unwrap(),
                vec!["save_board_snapshot"]
            );
            guard.release();
            tokio::time::timeout(Duration::from_secs(5), async {
                while !operations.outstanding_labels().unwrap().is_empty() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            if fail {
                assert!(!path.exists());
            } else {
                assert_eq!(std::fs::read(path).unwrap(), b"owned export");
            }
        }
    }

    #[tokio::test]
    async fn catalog_install_shutdown_clear_runs_after_complete_success() {
        let supervisor = EngineSupervisor::default();
        let games = GameManager::new();
        let operations = OperationRegistry::default();
        let order = std::cell::RefCell::new(Vec::new());
        assert!(
            shutdown_with_catalog_clear(
                async {
                    let success = shutdown_backend_with_attachments(
                        &supervisor,
                        &games,
                        None,
                        &operations,
                        std::future::ready(Ok(())),
                        std::future::ready(Ok(())),
                        Duration::from_secs(1),
                    )
                    .await;
                    order.borrow_mut().push("teardown complete");
                    success
                },
                |_| async {
                    assert_eq!(*order.borrow(), vec!["teardown complete"]);
                    assert!(operations.prepare_download("sealed").is_err());
                    order.borrow_mut().push("clear complete");
                    Ok(())
                },
                Duration::from_secs(1)
            )
            .await
        );
        assert_eq!(*order.borrow(), vec!["teardown complete", "clear complete"]);
    }

    #[tokio::test]
    async fn catalog_install_shutdown_false_teardown_never_clears() {
        let supervisor = EngineSupervisor::default();
        let games = GameManager::new();
        let operations = OperationRegistry::default();
        assert!(
            !shutdown_with_catalog_clear(
                shutdown_backend_with_attachments(
                    &supervisor,
                    &games,
                    None,
                    &operations,
                    std::future::ready(Err("catalog teardown refusal".into())),
                    std::future::ready(Ok(())),
                    Duration::from_secs(1),
                ),
                |_| async { panic!("false teardown cannot clear markers") },
                Duration::from_secs(1)
            )
            .await
        );
    }

    #[tokio::test]
    async fn catalog_install_shutdown_pending_clear_is_bounded_and_cancels_access() {
        let token = std::cell::RefCell::new(None);
        let capture = crate::error::LogCaptureScope::start();
        let success = tokio::time::timeout(
            Duration::from_secs(1),
            shutdown_with_catalog_clear(
                std::future::ready(true),
                |cancellation| {
                    *token.borrow_mut() = Some(cancellation);
                    std::future::pending::<Result<(), Error>>()
                },
                Duration::from_millis(20),
            ),
        )
        .await
        .expect("pending clear cannot prevent exit");
        assert!(!success);
        assert!(token.borrow().as_ref().unwrap().is_cancelled());
        assert!(capture.records().iter().any(|record| record
            .message
            .contains("catalog install session clear exceeded")));
    }

    #[tokio::test]
    async fn catalog_install_shutdown_clear_failure_is_returned_and_logged() {
        let capture = crate::error::LogCaptureScope::start();
        assert!(
            !shutdown_with_catalog_clear(
                std::future::ready(true),
                |_| async { Err(Error::InvalidInput("catalog-clear-proof-failure".into())) },
                Duration::from_secs(1)
            )
            .await
        );
        assert!(capture
            .records()
            .iter()
            .any(|record| record.message.contains("catalog-clear-proof-failure")));
    }

    #[tokio::test]
    async fn catalog_install_shutdown_timed_out_or_panicked_teardown_never_clears() {
        assert!(
            !shutdown_with_catalog_clear(
                std::future::pending::<bool>(),
                |_| async { panic!("timed-out teardown cannot clear markers") },
                Duration::from_millis(20)
            )
            .await
        );
        let panic = tokio::spawn(shutdown_with_catalog_clear(
            async { panic!("catalog teardown panic") },
            |_| async { panic!("panicked teardown cannot clear markers") },
            Duration::from_secs(1),
        ))
        .await
        .unwrap_err();
        assert!(panic.is_panic());
    }

    #[tokio::test]
    async fn shutdown_with_nothing_running_is_a_no_op_and_repeatable() {
        let supervisor = EngineSupervisor::default();
        let games = GameManager::new();
        let operations = OperationRegistry::default();
        assert!(
            shutdown_backend_with_attachments(
                &supervisor,
                &games,
                None,
                &operations,
                std::future::ready(Ok(())),
                std::future::ready(Ok(())),
                Duration::from_secs(30),
            )
            .await
        );
        assert!(
            shutdown_backend_with_attachments(
                &supervisor,
                &games,
                None,
                &operations,
                std::future::ready(Ok(())),
                std::future::ready(Ok(())),
                Duration::from_secs(30),
            )
            .await
        );
    }

    #[tokio::test]
    async fn retained_cleanup_native_shutdown_reports_production_game_failure_within_budget() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let games = Arc::new(GameManager::new());
        games
            .install_failed_production_cleanup_test_session(
                supervisor.clone(),
                "retained-native-shutdown",
            )
            .await;
        let operations = OperationRegistry::default();
        let result = tokio::time::timeout(
            SHUTDOWN_BUDGET,
            shutdown_backend_with_attachments(
                &supervisor,
                &games,
                None,
                &operations,
                std::future::ready(Ok(())),
                std::future::ready(Ok(())),
                SHUTDOWN_BUDGET,
            ),
        )
        .await
        .expect("retained failed game cannot extend process shutdown budget");
        assert!(!result, "native shutdown must report the production loop's retained failure after supervisor recovery");
        let key =
            game::game_side_engine_key("retained-native-shutdown", 1, "white", "failed-shutdown")
                .unwrap();
        assert!(supervisor.get_exact(&key).is_none());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_engine_launch_root_reclaims_released_leaves_and_reports_failure() {
        use crate::infra::path_authority::{EngineLaunchRoot, PathAuthority};

        let directory = tempfile::tempdir().unwrap();
        let root = EngineLaunchRoot::for_test(directory.path()).unwrap();
        let source = directory.path().join("source");
        std::fs::write(&source, b"released").unwrap();
        let mut leaf = root
            .reserve_leaves(1, "shutdown:success", "shutdown-engine")
            .unwrap()
            .pop()
            .unwrap();
        leaf.create_from(
            &std::fs::File::open(&source).unwrap(),
            crate::infra::path_authority::ENGINE_RESOURCE_LEAF_MODE,
            &|| false,
        )
        .unwrap();
        let leaf_path = leaf.path();
        drop(leaf);
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(
            PathAuthority::open_with_launch_root(
                directory.path().join("registry.json"),
                Vec::new(),
                root.clone(),
            )
            .unwrap(),
        );
        let supervisor = EngineSupervisor::default();
        let games = GameManager::new();
        let operations = OperationRegistry::default();
        assert!(
            shutdown_backend_with_attachments(
                &supervisor,
                &games,
                None,
                &operations,
                std::future::ready(Ok::<(), String>(())),
                async move {
                    shutdown_engine_launch_root(authority)
                        .await
                        .map_err(|error| error.to_string())
                },
                Duration::from_secs(2),
            )
            .await
        );
        assert!(!leaf_path.exists());

        let failure_directory = tempfile::tempdir().unwrap();
        let failure_root = EngineLaunchRoot::for_test(failure_directory.path()).unwrap();
        let failure_source = failure_directory.path().join("source");
        std::fs::write(&failure_source, b"retained").unwrap();
        let mut failure_leaf = failure_root
            .reserve_leaves(1, "shutdown:failure", "shutdown-engine")
            .unwrap()
            .pop()
            .unwrap();
        failure_leaf
            .create_from(
                &std::fs::File::open(&failure_source).unwrap(),
                crate::infra::path_authority::ENGINE_RESOURCE_LEAF_MODE,
                &|| false,
            )
            .unwrap();
        drop(failure_leaf);
        let failure_authority = crate::infra::path_authority::SharedPathAuthority::installed(
            PathAuthority::open_with_launch_root(
                failure_directory.path().join("registry.json"),
                Vec::new(),
                failure_root,
            )
            .unwrap(),
        );
        crate::infra::fs::set_test_removal_injector(Some(Arc::new(
            crate::infra::fs::RemovalFault(crate::infra::fs::RemovalFaultPoint::BeforeTopOpen),
        )));
        let capture = crate::error::LogCaptureScope::start();
        let failed = shutdown_backend_with_attachments(
            &EngineSupervisor::default(),
            &GameManager::new(),
            None,
            &OperationRegistry::default(),
            std::future::ready(Ok::<(), String>(())),
            async move {
                shutdown_engine_launch_root(failure_authority)
                    .await
                    .map_err(|error| error.to_string())
            },
            Duration::from_secs(2),
        )
        .await;
        crate::infra::fs::set_test_removal_injector(None);
        assert!(!failed);
        assert!(capture
            .messages()
            .iter()
            .any(|message| message.contains("engine launch-root teardown failed")));
    }

    #[tokio::test]
    async fn shutdown_seals_cancels_and_drains_a_real_native_owned_tail() {
        let supervisor = EngineSupervisor::default();
        let games = GameManager::new();
        let operations = OperationRegistry::default();
        let read_ticket = operations.prepare_read("main").unwrap();
        let read = operations
            .claim_read(&read_ticket, "main", "shutdown read")
            .unwrap();
        let read_token = read.token();
        let accepted = operations.accept("shutdown tail").unwrap();
        let accepted_token = accepted.token();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let caller = tokio::spawn(crate::infra::operations::run_native_operation(
            accepted,
            "shutdown tail",
            async move {
                let _ = entered_tx.send(());
                let _ = release_rx.await;
                Ok::<(), Error>(())
            },
        ));
        tokio::time::timeout(Duration::from_secs(1), entered_rx)
            .await
            .unwrap()
            .unwrap();
        caller.abort();
        let release = tokio::spawn(async move {
            accepted_token.cancelled().await;
            assert!(read_token.is_cancelled());
            drop(read);
            release_tx.send(()).unwrap();
        });

        assert!(
            shutdown_backend_with_attachments(
                &supervisor,
                &games,
                None,
                &operations,
                std::future::ready(Ok(())),
                std::future::ready(Ok(())),
                Duration::from_secs(2),
            )
            .await
        );
        tokio::time::timeout(Duration::from_secs(1), release)
            .await
            .unwrap()
            .unwrap();
        assert!(operations.accept("late mutation").is_err());
        assert!(operations.prepare_read("main").is_err());
        assert!(operations.wait_for_drain(Duration::ZERO).unwrap());
    }

    #[tokio::test]
    async fn shutdown_aggregates_attachment_failure_without_skipping_other_teardown() {
        let supervisor = EngineSupervisor::default();
        let games = GameManager::new();
        let operations = OperationRegistry::default();
        let (sound_shutdown, sound_signal) = tokio::sync::oneshot::channel();
        let sound_joined = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let sound_joined_clone = sound_joined.clone();
        let sound_join = tauri::async_runtime::spawn(async move {
            let _ = sound_signal.await;
            sound_joined_clone.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        let sound = SoundServerLifecycle::new(Some(sound_shutdown), Some(sound_join));
        assert!(
            !shutdown_backend_with_attachments(
                &supervisor,
                &games,
                Some(&sound),
                &operations,
                std::future::ready(Err("cleanup failed".into())),
                std::future::ready(Ok(())),
                Duration::from_secs(30),
            )
            .await
        );
        assert!(sound_joined.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn poisoned_operation_registry_does_not_skip_independent_shutdown_cleanup() {
        let supervisor = EngineSupervisor::default();
        let key = engine::EngineKey::new("shutdown".into(), "poisoned-registry".into()).unwrap();
        let (actor, _) = engine::EngineActor::recording_test_actor(&[]);
        supervisor
            .replace_handle(
                key.clone(),
                actor,
                "test-engine".into(),
                crate::infra::path_authority::PathRef {
                    id: "shutdown-test-engine".into(),
                },
            )
            .await
            .unwrap();
        let games = GameManager::new();
        let operations = OperationRegistry::default();
        operations.poison_for_test();
        let (sound_shutdown, sound_signal) = tokio::sync::oneshot::channel();
        let sound_joined = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let sound_joined_clone = Arc::clone(&sound_joined);
        let sound_join = tauri::async_runtime::spawn(async move {
            let _ = sound_signal.await;
            sound_joined_clone.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        let sound = SoundServerLifecycle::new(Some(sound_shutdown), Some(sound_join));
        let attachments_ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let attachments_ran_clone = Arc::clone(&attachments_ran);

        assert!(
            !shutdown_backend_with_attachments(
                &supervisor,
                &games,
                Some(&sound),
                &operations,
                async move {
                    attachments_ran_clone.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                },
                std::future::ready(Ok(())),
                Duration::from_secs(2),
            )
            .await
        );
        assert!(sound_joined.load(std::sync::atomic::Ordering::SeqCst));
        assert!(attachments_ran.load(std::sync::atomic::Ordering::SeqCst));
        assert!(supervisor.get_exact(&key).is_none());
    }

    #[tokio::test]
    async fn shutdown_timeout_still_runs_sound_teardown_when_attachments_are_pending() {
        let supervisor = EngineSupervisor::default();
        let games = GameManager::new();
        let operations = OperationRegistry::default();
        let (sound_shutdown, sound_signal) = tokio::sync::oneshot::channel();
        let (sound_seen_tx, sound_seen_rx) = tokio::sync::oneshot::channel();
        let sound_join = tauri::async_runtime::spawn(async move {
            if sound_signal.await.is_ok() {
                let _ = sound_seen_tx.send(());
            }
        });
        let sound = SoundServerLifecycle::new(Some(sound_shutdown), Some(sound_join));
        // Pending attachment forces the 5 ms timeout path; join/shutdown slots and the oneshot prove sound teardown without racing the budget.
        assert!(
            !shutdown_backend_with_attachments(
                &supervisor,
                &games,
                Some(&sound),
                &operations,
                std::future::pending::<Result<(), String>>(),
                std::future::ready(Ok(())),
                Duration::from_millis(5),
            )
            .await
        );
        assert!(
            sound.join.try_lock().unwrap().is_none(),
            "sound teardown took its join handle"
        );
        assert!(
            sound.shutdown.0.lock().unwrap().is_none(),
            "sound teardown took its shutdown sender"
        );
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(10), sound_seen_rx).await,
            Ok(Ok(()))
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_drains_real_image_issue_before_seal_rejection_cleanup() {
        let directory = tempfile::tempdir().unwrap();
        let registry = directory.path().join("registry.json");
        let app_data = directory.path().join("app-data");
        let source = directory.path().join("source.png");
        let late_source = directory.path().join("late.png");
        let png = b"\x89PNG\r\n\x1a\n";
        std::fs::write(&source, png).unwrap();
        std::fs::write(&late_source, png).unwrap();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(
            crate::infra::path_authority::PathAuthority::open(registry, vec![]).unwrap(),
        );
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        *IMAGE_ISSUANCE_TEST_GATE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap() = Some(ImageIssuanceTestGate {
            entered: entered.clone(),
            release: release.clone(),
        });
        let app = tauri::test::mock_app();
        let issuing_authority = authority.clone();
        let issuing_app = app.handle().clone();
        let issuing = tokio::spawn(issue_engine_image_blocking_async(
            issuing_authority,
            issuing_app,
            source,
            Some(crate::infra::path_authority::AppDataDir::for_test(
                &app_data,
            )),
        ));
        // The production blocking issuer has acquired its RAII lease but has not copied bytes.
        entered.wait();

        let mut draining = tokio::spawn(seal_and_drain_engine_image_issuances(authority.clone()));
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if authority
                    .raw_for_test()
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .engine_attachments_are_sealed()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("shutdown seals while the real copy is paused");
        assert!(!app_data.join("engine-images").exists());

        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut draining)
                .await
                .is_err()
        );
        issuing.abort();
        assert!(issuing
            .await
            .expect_err("issuer awaiter must be cancelled")
            .is_cancelled());
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut draining)
                .await
                .is_err(),
            "cancelling the async caller must not release the blocking issuance lease"
        );
        let refusal = issue_engine_image_blocking_async(
            authority.clone(),
            app.handle().clone(),
            late_source,
            Some(crate::infra::path_authority::AppDataDir::for_test(
                &app_data,
            )),
        )
        .await
        .expect_err("new image work must refuse before opening or copying after seal");
        assert!(matches!(refusal, Error::Conflict(message) if message.contains("sealed")));
        assert!(!app_data.join("engine-images").exists());

        // Let the already-leased production issue finish. Registration now observes the seal,
        // and its real orphan-cleanup path must remove the copied UUID leaf before the drain ends.
        release.wait();
        draining.await.unwrap().unwrap();
        let image_dir = crate::infra::path_authority::ensure_app_owned_default_dir(
            &crate::infra::path_authority::AppDataDir::for_test(&app_data),
            crate::infra::path_authority::AppOwnedDefaultRoot::EngineImages,
        )
        .unwrap();
        assert_eq!(std::fs::read_dir(image_dir.path()).unwrap().count(), 0);
    }
}

#[cfg(test)]
mod blocking_offload_scans {
    use crate::infra::blocking::source_scan::body_at_indent;

    /// Byte offset of the `)` matching the `(` at `open`. Shared so the gateway-closure scan
    /// and the engine-image lock-across-read scan cannot diverge.
    fn closing_paren(source: &str, open: usize) -> Option<usize> {
        let mut depth = 0usize;
        for (offset, character) in source[open..].char_indices() {
            match character {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(open + offset);
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// The argument text of the `BLOCKING_GATEWAY.spawn*(…)` call in `body`. Position alone is
    /// not enough: `BLOCKING_GATEWAY.spawn(|| Ok(())).await?;` followed by a direct call to the
    /// worker puts that call after the gateway token and still runs it on the command future.
    fn gateway_closure(body: &'static str, signature: &str) -> &'static str {
        let gateway = body
            .find("BLOCKING_GATEWAY")
            .unwrap_or_else(|| panic!("{signature} must acquire BLOCKING_GATEWAY: {body}"));
        let rest = &body[gateway..];
        let spawn = rest
            .find(".spawn")
            .unwrap_or_else(|| panic!("{signature} must call .spawn on the gateway: {body}"));
        let open = spawn
            + rest[spawn..]
                .find('(')
                .unwrap_or_else(|| panic!("{signature} must open the spawn call: {body}"));
        let close = closing_paren(rest, open)
            .unwrap_or_else(|| panic!("{signature} has an unbalanced spawn call: {body}"));
        &rest[open + 1..close]
    }

    fn call_arguments<'a>(body: &'a str, signature: &str, call: &str) -> &'a str {
        let start = body
            .find(call)
            .unwrap_or_else(|| panic!("{signature} must call {call}: {body}"));
        let rest = &body[start..];
        let open = rest
            .find('(')
            .unwrap_or_else(|| panic!("{signature} must open the {call} call: {body}"));
        let close = closing_paren(rest, open)
            .unwrap_or_else(|| panic!("{signature} has an unbalanced {call} call: {body}"));
        &rest[open + 1..close]
    }

    /// `body_at_indent` panics when its needle is absent. Runtime-generic
    /// helpers are `fn name<R: …>(`, so the plain `fn {name}(` needle misses
    /// them. Prefer the generic form when it exists. One copy for every scan;
    /// `_blocking` workers reach it through `blocking_fn_signature`, which adds
    /// the suffix and the check that it survived resolution.
    fn fn_signature(source: &str, name: &str) -> String {
        let generic = format!("fn {name}<");
        if source.contains(&generic) {
            generic
        } else {
            format!("fn {name}(")
        }
    }

    /// The `_blocking` needle for `name`, with the one rule that the resolved signature really
    /// targets the worker rather than the command it wraps. Asserted here rather than at each
    /// caller: at the 21-name loop below the name is a loop variable and the only other check
    /// is that the body is non-empty, so a dropped suffix would resolve `fn get_db_info(`
    /// against the command and silently retire that half of the scan for every name.
    fn blocking_fn_signature(source: &str, name: &str) -> String {
        let signature = fn_signature(source, &format!("{name}_blocking"));
        assert!(
            signature.ends_with("_blocking(") || signature.ends_with("_blocking<"),
            "the resolved needle must target {name}_blocking, not the command it wraps: \
             {signature}"
        );
        signature
    }

    /// Offset of the next `_blocking(` or `_blocking<` in `source[from..]`.
    /// Generic helpers would otherwise vanish from `s8` the moment their
    /// signature stopped containing the literal `_blocking(`.
    fn next_blocking_offset(source: &str, from: usize) -> Option<usize> {
        let rest = &source[from..];
        let paren = rest.find("_blocking(");
        let generic = rest.find("_blocking<");
        match (paren, generic) {
            (None, None) => None,
            (Some(paren), None) => Some(paren),
            (None, Some(generic)) => Some(generic),
            (Some(paren), Some(generic)) => Some(paren.min(generic)),
        }
    }

    /// Follow either the direct gateway dispatch used by transient reads or the accepted helper
    /// dispatch used by completion-owned commands. The worker must occur exactly once and inside
    /// the dispatched argument, so removing real delegation or adding a second direct call fails.
    fn assert_offloads(source: &'static str, signature: &str, worker: &str) {
        let body = body_at_indent(source, signature);
        assert_body_offloads(body, signature, worker);
    }

    fn command_dispatch_body(source: &'static str, name: &str) -> &'static str {
        let generic = format!("pub async fn {name}<");
        let signature = if source.contains(&generic) {
            generic
        } else {
            format!("pub async fn {name}(")
        };
        let body = body_at_indent(source, &signature);
        let core_call = format!("{name}_command_core(");
        if body.contains(&core_call) {
            assert_eq!(body.matches(&core_call).count(), 1, "{body}");
            assert!(!body.contains(&format!("{name}_blocking(")), "{body}");
            body_at_indent(source, &format!("async fn {name}_command_core"))
        } else {
            body
        }
    }

    fn assert_body_offloads(body: &'static str, signature: &str, worker: &str) {
        let call = format!("{worker}(");
        let occurrences = body.matches(call.as_str()).count();
        assert_eq!(
            occurrences, 1,
            "{signature} must call {call} exactly once, so the closure scan cannot be \
             satisfied while a second call runs on the command future: {body}"
        );
        let closure = if body.contains("run_accepted_blocking(") {
            call_arguments(body, signature, "run_accepted_blocking")
        } else {
            gateway_closure(body, signature)
        };
        assert!(
            closure.contains(call.as_str()),
            "{signature} must call {call} inside its native dispatch, not on the command \
             future; dispatched arguments were {closure:?}: {body}"
        );
    }

    #[test]
    fn accepted_blocking_helper_owns_the_real_gateway_dispatch() {
        let operations = include_str!("infra/operations.rs");
        let body = body_at_indent(operations, "pub async fn run_accepted_blocking");
        let accept = body
            .find("registry.accept(label)")
            .expect("accepted admission");
        let native = body
            .find("run_native_operation(lease")
            .expect("native workflow ownership");
        let gateway = body
            .find("BLOCKING_GATEWAY")
            .expect("blocking gateway dispatch");
        let workflow = gateway_closure(body, "run_accepted_blocking");
        assert!(accept < native && native < gateway, "{body}");
        assert_eq!(workflow.trim(), "workflow", "{body}");
    }

    #[test]
    fn download_claims_record_their_progress_id_and_webview_owner_once() {
        let fs = include_str!("fs.rs");
        let file_command = body_at_indent(fs, "pub async fn download_file(");
        assert_eq!(
            file_command.matches("download_file_runtime(").count(),
            1,
            "{file_command}"
        );
        assert_eq!(
            file_command.matches("window.label()").count(),
            1,
            "{file_command}"
        );
        assert_eq!(
            file_command.matches("claim_download(").count(),
            0,
            "{file_command}"
        );
        for (source, signature, owner, label, progress_id, admission_key, exclusive) in [
            (
                fs,
                "async fn download_file_runtime<",
                "owner",
                "download publication",
                "id",
                "id",
                false,
            ),
            (
                fs,
                "async fn download_lichess_games_runtime<",
                "owner",
                "download_lichess_games",
                "job_id",
                "admission_key",
                true,
            ),
            (
                include_str!("chesscom.rs"),
                "async fn download_chess_com_games_runtime<",
                "owner",
                "download_chess_com_games",
                "job_id",
                "admission_key",
                true,
            ),
        ] {
            let body = body_at_indent(source, signature);
            assert_eq!(
                body.matches("claim_download(").count(),
                1,
                "{signature}: {body}"
            );
            let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
            let compact_label: String = label.chars().filter(|c| !c.is_whitespace()).collect();
            assert!(
                compact.contains(&format!(
                    "claim_download(&job_id,{owner},\"{compact_label}\",&{progress_id},&{admission_key},{exclusive},"
                )),
                "{signature}: {body}"
            );
        }

        let lichess_command = body_at_indent(
            include_str!("infra/operations/accounts.rs"),
            "async fn import_account_games(",
        );
        assert_eq!(
            lichess_command.matches("window.label()").count(),
            1,
            "{lichess_command}"
        );
        let lichess = body_at_indent(fs, "async fn download_lichess_games_runtime<");
        assert_eq!(
            lichess
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect::<String>()
                .matches("format!(\"lichess_")
                .count(),
            1,
            "{lichess}"
        );
        assert!(
            lichess.find("let admission_key =").unwrap() < lichess.find("claim_download(").unwrap(),
            "{lichess}"
        );
        let compact: String = lichess.chars().filter(|c| !c.is_whitespace()).collect();
        assert!(
            compact.contains(
                "letadmission_key=format!(\"lichess_{}\",crate::lichess::lichess_user_segment(&player)?.to_ascii_lowercase());"
            ),
            "{lichess}"
        );
        assert!(
            compact.contains("download_to_destination(&job_id,"),
            "{lichess}"
        );
        let destination = body_at_indent(fs, "async fn download_to_destination_inner<");
        assert!(
            destination.contains("begin_progress(&state.progress_state, app, id.to_owned())"),
            "{destination}"
        );

        let chesscom = include_str!("chesscom.rs");
        let command = body_at_indent(chesscom, "async fn download_chess_com_games_runtime<");
        assert_eq!(
            command.matches("format!(\"chesscom_").count(),
            1,
            "{command}"
        );
        assert!(
            command.find("let admission_key =").unwrap() < command.find("claim_download(").unwrap(),
            "{command}"
        );
        let compact: String = command.chars().filter(|c| !c.is_whitespace()).collect();
        assert!(
            compact
                .contains("letadmission_key=format!(\"chesscom_{}\",player.to_ascii_lowercase());"),
            "{command}"
        );
        assert!(
            compact.contains("download_chess_com_games_core(destination,filename,job_id,"),
            "{command}"
        );
        let core = body_at_indent(chesscom, "async fn download_chess_com_games_core<");
        assert!(
            core.contains("begin_progress(&state.progress_state, &app, job_id)"),
            "{core}"
        );
        assert!(!core.contains("format!(\"chesscom_"), "{core}");

        for (signature, call) in [
            (
                "pub async fn cancel_download(",
                "cancel_download(&id,window.label())",
            ),
            (
                "pub fn cancel_download_for_progress(",
                "cancel_download_for_progress(&progress_id,window.label())",
            ),
        ] {
            let body = body_at_indent(fs, signature);
            let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
            assert_eq!(compact.matches(call).count(), 1, "{body}");
            assert_eq!(body.matches("window.label()").count(), 1, "{body}");
        }
    }

    #[test]
    fn phase4_accepted_command_inventory_reaches_one_native_owner() {
        for (file, source, commands) in [
            (
                "db/mod.rs",
                include_str!("db/mod.rs"),
                &[
                    "convert_pgn",
                    "create_indexes",
                    "delete_indexes",
                    "edit_db_info",
                    "delete_database",
                    "delete_duplicated_games",
                    "delete_empty_games",
                    "export_to_pgn",
                    "delete_db_game",
                    "write_db_game",
                    "merge_players",
                ][..],
            ),
            (
                "file_workspace.rs",
                include_str!("file_workspace.rs"),
                &[
                    "create_workspace_file",
                    "create_workspace_directory",
                    "move_workspace_entry",
                    "rename_workspace_file",
                    "write_workspace_file_metadata",
                    "trash_workspace_entry",
                    "list_workspace_trash",
                    "empty_workspace_trash",
                    "restore_workspace_trash_item",
                    "delete_workspace_trash_item",
                ][..],
            ),
        ] {
            for command in commands {
                let body = command_dispatch_body(source, command);
                assert!(
                    body.contains("run_native_operation(")
                        || body.contains("run_accepted_blocking("),
                    "{file}::{command} must dispatch through one native owner: {body}"
                );
            }
        }

        for (file, source, command) in [
            (
                "puzzle.rs",
                include_str!("puzzle.rs"),
                "delete_puzzle_database",
            ),
            (
                "chesscom.rs",
                include_str!("chesscom.rs"),
                "download_chess_com_games_runtime<R: tauri::Runtime>",
            ),
        ] {
            let body = body_at_indent(source, &format!("async fn {command}("));
            assert!(
                body.contains("run_native_operation(") || body.contains("run_accepted_blocking("),
                "{file}::{command} must dispatch through one native owner: {body}"
            );
        }

        for (source, command, route) in [
            (
                include_str!("main.rs"),
                "save_board_snapshot",
                "save_native_export(",
            ),
            (
                include_str!("main.rs"),
                "save_engine_logs",
                "save_native_export(",
            ),
        ] {
            let body = body_at_indent(source, &format!("async fn {command}("));
            assert_eq!(body.matches(route).count(), 1, "{command}: {body}");
        }

        let fs = include_str!("fs.rs");
        let file_runtime = body_at_indent(fs, "async fn download_file_runtime<");
        assert_eq!(
            file_runtime
                .matches("download_to_destination_with_failure(")
                .count(),
            1,
            "{file_runtime}"
        );
        let download_owner = body_at_indent(fs, "async fn download_to_destination_with_failure<");
        assert!(
            download_owner.contains("run_native_operation("),
            "{download_owner}"
        );
        let lichess_runtime = body_at_indent(fs, "async fn download_lichess_games_runtime");
        assert_eq!(
            lichess_runtime.matches("download_to_destination(").count(),
            1,
            "{lichess_runtime}"
        );

        for (command, core_name, owner_name) in [
            ("delete_game", "delete_game_core", "delete_game_core"),
            ("move_games", "move_games_core", "move_games_core"),
            ("write_game", "write_game_core", "mutate_game_core"),
            ("set_game_section", "mutate_game_core", "mutate_game_core"),
        ] {
            let pgn = include_str!("pgn.rs");
            let body = body_at_indent(pgn, &format!("pub async fn {command}("));
            let core = format!("{core_name}(");
            assert!(
                body.contains("state.operations.accept("),
                "{command}: {body}"
            );
            assert_eq!(body.matches(&core).count(), 1, "{command}: {body}");
            let core_body = body_at_indent(pgn, &format!("async fn {owner_name}("));
            assert!(
                core_body.contains("run_native_operation("),
                "{command}: {core_body}"
            );
        }
    }

    #[test]
    fn exit_requested_dispatches_the_production_shutdown_core() {
        let source = include_str!("main.rs");
        let exit = source
            .split("let tauri::RunEvent::ExitRequested")
            .nth(1)
            .expect("ExitRequested event branch");
        let dispatch = body_at_indent(exit, "tauri::async_runtime::spawn(async move {");
        let cleanup = call_arguments(
            dispatch,
            "ExitRequested cleanup",
            "shutdown_backend_with_attachments",
        );
        for argument in [
            "state.engine_supervisor.as_ref()",
            "&state.game_manager",
            "&state.operations",
            "shutdown_engine_attachments",
            "SHUTDOWN_BUDGET",
        ] {
            assert!(cleanup.contains(argument), "missing {argument}: {cleanup}");
        }
        assert!(dispatch.contains("app_handle.exit(0)"), "{dispatch}");
    }

    #[test]
    fn shutdown_cleanup_dispatch_preserves_native_error_diagnostics() {
        let main = body_at_indent(include_str!("main.rs"), "fn main()");
        let exit = main
            .split_once("let tauri::RunEvent::ExitRequested")
            .expect("ExitRequested event branch")
            .1;
        let dispatch = body_at_indent(exit, "tauri::async_runtime::spawn(async move {");
        for call in [
            "shutdown_engine_attachments(app_handle.clone())",
            "shutdown_engine_launch_root(authority)",
        ] {
            let mapping = dispatch
                .split_once(call)
                .unwrap_or_else(|| panic!("shutdown dispatch must call {call}: {dispatch}"))
                .1
                .split_once('}')
                .expect("shutdown cleanup closure end")
                .0
                .split_whitespace()
                .collect::<String>();
            assert!(
                mapping.starts_with(".await.map_err(|error|error.diagnostic())"),
                "{call} must retain native diagnostics: {mapping}"
            );
            assert!(
                !mapping.contains(".to_string()"),
                "{call} must not redact native diagnostics: {mapping}"
            );
        }
    }

    #[test]
    fn sound_startup_keeps_all_four_outcomes_distinguishable() {
        let main = include_str!("main.rs");
        let setup = body_at_indent(main, ".setup(move |app| {");
        let startup = setup
            .split_once("// sound-startup")
            .expect("sound startup marker")
            .1
            .split_once("// sound-startup-end")
            .expect("sound startup end marker")
            .0;

        assert!(
            startup.contains("ResourceDir::for_app(app.handle())"),
            "{startup}"
        );
        assert!(
            startup.contains("open_app_owned_resource_dir("),
            "{startup}"
        );
        assert!(startup.contains("error.is_missing_entry()"), "{startup}");
        assert!(
            startup.contains("no bundled sound resources found, sound stays disabled"),
            "{startup}"
        );
        assert!(
            startup.contains("sound resource root could not be resolved"),
            "{startup}"
        );
        assert!(
            startup.contains("bundled sound resources could not be opened"),
            "{startup}"
        );
        assert!(
            startup.contains("sound server could not be started"),
            "{startup}"
        );
        assert!(startup.contains("sound::create_sound_server("), "{startup}");
        assert_eq!(startup.matches("log::warn!(").count(), 2, "{startup}");
        assert_eq!(startup.matches("log::info!(").count(), 1, "{startup}");
        assert_eq!(startup.matches("log::error!(").count(), 1, "{startup}");
        assert!(!startup.contains("BaseDirectory::Resource"), "{startup}");

        // The ungate is detected on the whole setup body, not only the delimited slice: a restored
        // platform gate placed above `// sound-startup` must redden this pin too.
        assert!(!setup.contains("SoundServerPort(0)"), "{setup}");
        let linux_gate = ["#[cfg(target_os = ", "\"linux\")]"].concat();
        assert!(!setup.contains(&linux_gate), "{setup}");
        let non_linux_gate = ["#[cfg(not(target_os = ", "\"linux\"))]"].concat();
        assert!(!setup.contains(&non_linux_gate), "{setup}");
    }

    #[test]
    fn credential_initialization_precedes_path_authority_open() {
        let main = include_str!("main.rs");
        let setup = body_at_indent(main, ".setup(move |app| {");
        let app_data = setup
            .find("let app_data = crate::infra::path_authority::AppDataDir::for_app(app.handle())")
            .expect("application data directory local");
        let credential = setup
            .find(".credentials\n                .initialize(")
            .expect("credential initialization call");
        let authority = setup
            .find("PathAuthority::open")
            .expect("path authority initialization call");
        assert!(app_data < credential, "{setup}");
        assert!(credential < authority, "{setup}");
        assert_eq!(
            setup.matches("PathAuthority::open_for_app(").count(),
            2,
            "each startup branch must use the production constructor: {setup}"
        );
        for (offset, _) in setup.match_indices("PathAuthority::open_for_app(") {
            // The registry no longer exempts app-owned spellings, so the authority takes no
            // application-data context: `AppDataDir` is canonical and so is everything under it.
            let rest = &setup[offset..];
            let call = rest.find(')').map_or(rest, |end| &rest[..end]);
            assert!(
                !call.contains("app_data"),
                "startup branch must not pass app_data to the authority constructor: {setup}"
            );
        }
        // A construction failure is logged at setup with the fixed text, like credentials.
        assert!(
            setup.contains("application data directory could not be acquired: {error}"),
            "{setup}"
        );
        // The application-data path is constructed once and shared by credential
        // initialization and the macOS launch-root setup.
        let call = &setup[app_data..authority];
        assert_eq!(call.matches("AppDataDir::for_app(").count(), 1, "{call}");
        assert!(
            call.contains(".initialize(&app_data)")
                && call.contains("initialize_engine_launch_root(&app_data)"),
            "{call}"
        );
        assert!(
            call.contains("AppDataDir::for_app(") && !call.contains("credentials\")"),
            "{call}"
        );
    }

    #[test]
    fn instance_admission_is_unconditional_and_precedes_shared_state() {
        let setup = body_at_indent(include_str!("main.rs"), ".setup(move |app| {");
        let app_data = setup.find("            let app_data = ").unwrap();
        let app_data_end = setup[app_data..].find("})?;").unwrap() + app_data + "})?;".len();
        let statement = "            let admission = crate::infra::path_authority::admit_instance(app.handle(), &app_data)\n                .map_err(|_| {\n                \"application data directory instance lock could not be acquired\"\n            })?;";
        let admission = setup
            .find(statement)
            .expect("complete setup-level propagating admission");
        assert!(setup[app_data_end..admission].trim().is_empty());
        let after_admission = &setup[admission + statement.len()..];
        assert!(after_admission
            .trim_start()
            .starts_with("let app_data_locked = match admission {"));
        let matched = body_at_indent(setup, "            let app_data_locked = match admission {");
        assert_eq!(matched.matches("=>").count(), 3);
        let variants = matched
            .lines()
            .filter(|line| line.contains("InstanceAdmission::"))
            .map(str::trim)
            .collect::<Vec<_>>();
        assert_eq!(
            variants,
            [
                "crate::infra::path_authority::InstanceAdmission::Owned(guard) => {",
                "crate::infra::path_authority::InstanceAdmission::Unguarded => false,",
                "crate::infra::path_authority::InstanceAdmission::HeldElsewhere => {",
            ]
        );
        let owned = body_at_indent(
            matched,
            "                crate::infra::path_authority::InstanceAdmission::Owned(guard) => {",
        );
        assert_eq!(owned.trim(), "crate::infra::path_authority::InstanceAdmission::Owned(guard) => {\n                    let app_data_locked = guard.app_data_locked();\n                    app.manage(guard);\n                    app_data_locked");
        let held = body_at_indent(
            matched,
            "                crate::infra::path_authority::InstanceAdmission::HeldElsewhere => {",
        );
        assert!(held.trim_end().ends_with("return Ok(());"));
        assert!(held.contains("use tauri_plugin_dialog::DialogExt;"));
        let compact: String = held.chars().filter(|c| !c.is_whitespace()).collect();
        let compact_contains_call = |call: &str| {
            let needle: String = call.chars().filter(|c| !c.is_whitespace()).collect();
            compact.contains(&needle) || {
                let (head, close) = needle.split_at(needle.len() - 1);
                compact.contains(&format!("{head},{close}"))
            }
        };
        assert!(
            compact_contains_call(
                ".message(\"ChessRiddle Studio is already open. Switch to its window to continue.\")"
            ),
            "{held}"
        );
        assert!(
            compact_contains_call(".title(\"ChessRiddle Studio is already running\")"),
            "{held}"
        );
        assert!(held.contains(".show(|_| std::process::exit(0));"));
        assert!(!held.contains(".parent("));
        assert!(!held
            .lines()
            .any(|line| line.trim_start().starts_with("log::")));
        let returned = setup.find("return Ok(());").unwrap();
        assert!(admission < returned);
        assert!(returned < setup.find(".credentials").unwrap());
        assert!(returned < setup.find("PathAuthority::open_for_app(").unwrap());
        assert_eq!(setup.matches("admit_instance(").count(), 1);
        let setter = "authority.set_engine_image_sweep_root(app_data_locked.then_some(app_data));";
        assert_eq!(setup.matches(setter).count(), 1);
        let permitted = setup.find(setter).unwrap();
        assert!(setup.rfind("PathAuthority::open_for_app(").unwrap() < permitted);
        assert!(!setup[permitted + setter.len()..].contains("app_data"));
        assert!(permitted < setup.find(".install(authority)").unwrap());
    }

    #[test]
    fn main_window_is_created_from_config_after_cli_registration() {
        let setup = body_at_indent(include_str!("main.rs"), ".setup(move |app| {");
        let setup = setup.split("\n        })").next().unwrap();
        let cli = setup
            .find("app.handle().plugin(tauri_plugin_cli::init())?;")
            .unwrap();
        let config = setup.find("let main_window = app").unwrap();
        let window = setup
            .find("tauri::WebviewWindowBuilder::from_config(app.handle(), main_window)?.build()?;")
            .unwrap();
        assert!(cli < config && config < window);
        assert!(setup[config..window].contains(".windows\n                .first()\n                .ok_or(\"main window configuration is missing\")?;"));
        assert_eq!(setup[window..].trim(), "tauri::WebviewWindowBuilder::from_config(app.handle(), main_window)?.build()?;\n\n            log::info!(\"Finished rust initialization\");\n\n            Ok(())");
    }

    #[test]
    fn main_window_config_defers_creation_until_setup() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["app"]["windows"][0]["create"], false);
    }

    #[test]
    fn s1_converted_symbols_offload_their_worker_through_the_gateway() {
        let main = include_str!("main.rs");
        let puzzle = include_str!("puzzle.rs");
        for (signature, worker) in [
            (
                "async fn save_native_export(",
                "save_native_export_blocking",
            ),
            ("async fn open_app_log(", "open_app_log_blocking"),
            (
                "async fn get_database_workspace(",
                "get_database_workspace_blocking",
            ),
            (
                "async fn list_workspace_databases(",
                "list_workspace_databases_blocking",
            ),
            (
                "async fn create_workspace_database(",
                "create_workspace_database_blocking",
            ),
            (
                "async fn database_download_destination(",
                "database_download_destination_blocking",
            ),
            (
                "async fn get_engine_workspace(",
                "get_engine_workspace_blocking",
            ),
            ("async fn read_engine_image(", "read_engine_image_blocking"),
            (
                "async fn open_engine_workspace(",
                "open_engine_workspace_blocking",
            ),
            (
                "async fn issue_pgn_workspace(",
                "issue_pgn_workspace_blocking",
            ),
            (
                "async fn issue_pgn_export_destination(",
                "issue_pgn_export_destination_blocking",
            ),
            (
                "async fn issue_download_destination(",
                "issue_download_destination_blocking",
            ),
            (
                "async fn download_destination_is_known(",
                "download_destination_is_known_blocking",
            ),
            (
                "async fn issue_database_workspace(",
                "issue_database_workspace_blocking",
            ),
            (
                "async fn issue_engine_workspace(",
                "issue_engine_workspace_blocking",
            ),
            (
                "async fn issue_engine_binary(",
                "issue_engine_binary_blocking",
            ),
            (
                "async fn issue_engine_resource(",
                "issue_engine_resource_blocking",
            ),
            (
                "async fn issue_opening_book(",
                "issue_opening_book_blocking",
            ),
        ] {
            assert_offloads(main, signature, worker);
        }
        // The image command first completes the native picker and then forwards to the
        // production async wrapper. Keep the gateway assertion on that wrapper so this scan
        // follows the call chain when the offload is factored out of the command body.
        let image_command = body_at_indent(main, "async fn issue_engine_image(");
        assert_eq!(
            image_command
                .matches("issue_engine_image_blocking_async(")
                .count(),
            1,
            "issue_engine_image must forward exactly once to its blocking wrapper: {image_command}"
        );
        assert!(
            !image_command.contains("BLOCKING_GATEWAY"),
            "{image_command}"
        );
        assert_offloads(
            main,
            "async fn issue_engine_image_blocking_async<R:",
            "issue_engine_image_blocking",
        );
        // `get_puzzle_workspace` is the documented exception: `active_or_default_puzzle_workspace`
        // already is the blocking body, so no `*_blocking` wrapper was added (`e770bcdb`).
        for (signature, worker) in [
            (
                "pub async fn get_puzzle_workspace(",
                "active_or_default_puzzle_workspace",
            ),
            (
                "pub async fn issue_puzzle_download_destination(",
                "issue_puzzle_download_destination_blocking",
            ),
            (
                "pub async fn issue_puzzle_workspace(",
                "issue_puzzle_workspace_blocking",
            ),
            (
                "pub async fn list_puzzle_databases(",
                "list_puzzle_databases_blocking",
            ),
        ] {
            assert_offloads(puzzle, signature, worker);
        }
        let file_workspace = include_str!("file_workspace.rs");
        for (signature, worker) in [
            (
                "pub async fn issue_file_workspace(",
                "issue_file_workspace_blocking",
            ),
            (
                "pub(crate) async fn list_file_workspace_core(",
                "collect_tree_entries",
            ),
            (
                "pub async fn create_workspace_file(",
                "create_workspace_file_blocking",
            ),
            (
                "pub async fn create_workspace_directory(",
                "create_workspace_directory_inner",
            ),
            (
                "pub async fn move_workspace_entry(",
                "move_workspace_entry_blocking",
            ),
            (
                "pub async fn rename_workspace_file(",
                "rename_workspace_file_blocking",
            ),
            (
                "pub async fn write_workspace_file_metadata(",
                "write_workspace_file_metadata_blocking",
            ),
            ("pub async fn trash_workspace_entry(", "trash_entry"),
            (
                "pub async fn restore_workspace_trash_item(",
                "restore_trash_item",
            ),
            ("async fn remove_trash(", "remove_trash_blocking"),
        ] {
            assert_offloads(file_workspace, signature, worker);
        }
        let fs = include_str!("fs.rs");
        assert_offloads(fs, "pub async fn file_exists(", "file_exists_blocking");
        for signature in [
            "async fn save_board_snapshot(",
            "async fn save_engine_logs(",
        ] {
            let body = body_at_indent(main, signature);
            assert!(
                body.contains("save_native_export"),
                "{signature} must forward to save_native_export: {body}"
            );
        }
        let delete_command =
            body_at_indent(file_workspace, "pub async fn delete_workspace_trash_item(");
        assert!(
            delete_command.contains("remove_trash"),
            "delete_workspace_trash_item must forward to remove_trash: {delete_command}"
        );
        let list_command = body_at_indent(file_workspace, "pub async fn list_file_workspace(");
        assert_eq!(
            list_command.matches("list_file_workspace_core(").count(),
            1,
            "list_file_workspace must forward exactly once to list_file_workspace_core: {list_command}"
        );
        assert!(
            !list_command.contains("BLOCKING_GATEWAY"),
            "list_file_workspace must not acquire BLOCKING_GATEWAY directly: {list_command}"
        );
        assert!(
            !list_command.contains("collect_tree_entries"),
            "list_file_workspace must delegate collect_tree_entries offloading to list_file_workspace_core: {list_command}"
        );
        assert!(
            !list_command.contains("count_pgn_games_core"),
            "list_file_workspace must delegate count_pgn_games_core to list_file_workspace_core: {list_command}"
        );
    }

    #[test]
    fn native_export_writes_through_the_held_parent_descriptor() {
        let main = include_str!("main.rs");
        let blocking = body_at_indent(main, "fn save_native_export_blocking(");
        assert!(
            blocking.contains("NativeExportDest::from_save_path("),
            "save_native_export_blocking must build a NativeExportDest: {blocking}"
        );
        assert!(
            !blocking.contains("atomic_replace("),
            "save_native_export_blocking must not replace by pathname: {blocking}"
        );
        let fs = include_str!("infra/fs.rs");
        let replace = body_at_indent(fs, "pub(crate) fn replace<F>(&self, write_fn: F)");
        assert!(
            replace.contains("atomic_replace_at("),
            "NativeExportDest::replace must write relative to the held parent: {replace}"
        );
    }

    #[test]
    fn s2_dialogs_precede_blocking_gateway() {
        let main = include_str!("main.rs");
        let save = body_at_indent(main, "async fn save_native_export(");
        let save_dialog = save
            .find("blocking_save_file")
            .expect("save_native_export must call blocking_save_file");
        let save_gateway = save
            .find("run_accepted_blocking")
            .expect("save_native_export must enter accepted ownership");
        assert!(
            save_dialog < save_gateway,
            "save_native_export must run blocking_save_file before accepted admission: {save}"
        );

        let image = body_at_indent(main, "async fn issue_engine_image(");
        let picker = image
            .find("blocking_pick_file")
            .expect("issue_engine_image must call blocking_pick_file");
        let image_gateway = image
            .find("issue_engine_image_blocking_async(")
            .expect("issue_engine_image must forward to its blocking wrapper");
        assert!(
            picker < image_gateway,
            "issue_engine_image must run the picker before BLOCKING_GATEWAY: {image}"
        );

        let file_workspace = include_str!("file_workspace.rs");
        let puzzle = include_str!("puzzle.rs");
        for (source, signature, picker) in [
            (main, "async fn issue_pgn_workspace(", "blocking_pick_file"),
            (
                main,
                "async fn issue_pgn_export_destination(",
                "blocking_save_file",
            ),
            (
                main,
                "async fn issue_download_destination(",
                "blocking_pick_folder",
            ),
            (
                main,
                "async fn issue_database_workspace(",
                "blocking_pick_folder",
            ),
            (
                main,
                "async fn issue_engine_workspace(",
                "blocking_pick_folder",
            ),
            (main, "async fn issue_engine_binary(", "blocking_pick_file"),
            (
                main,
                "async fn issue_engine_resource(",
                "blocking_pick_file",
            ),
            (
                main,
                "async fn issue_engine_resource(",
                "blocking_pick_folder",
            ),
            (main, "async fn issue_opening_book(", "blocking_pick_file"),
            (
                file_workspace,
                "pub async fn issue_file_workspace(",
                "blocking_pick_folder",
            ),
            (
                puzzle,
                "pub async fn issue_puzzle_workspace(",
                "blocking_pick_folder",
            ),
        ] {
            let body = body_at_indent(source, signature);
            let picker_at = body
                .find(picker)
                .unwrap_or_else(|| panic!("{signature} must call {picker}: {body}"));
            let gateway_at = body
                .find("run_accepted_blocking")
                .unwrap_or_else(|| panic!("{signature} must enter accepted ownership: {body}"));
            assert!(
                picker_at < gateway_at,
                "{signature} must run {picker} before accepted admission: {body}"
            );
        }
    }

    #[test]
    fn s3_workspace_mutation_is_on_the_blocking_signatures() {
        let source = include_str!("file_workspace.rs");
        for signature in [
            "fn create_workspace_directory_inner(",
            "fn trash_entry(",
            "fn restore_trash_item(",
            "fn move_workspace_entry_blocking(",
            "fn rename_workspace_file_blocking(",
            "fn write_workspace_file_metadata_blocking(",
            "fn create_workspace_file_blocking(",
            "fn remove_trash_blocking(",
        ] {
            let body = body_at_indent(source, signature);
            let signature_text = body
                .split_once('{')
                .map(|(signature, _)| signature)
                .unwrap_or(body);
            assert!(
                signature_text.contains("workspace_mutation"),
                "{signature} must take workspace_mutation: {signature_text}"
            );
        }
    }

    #[test]
    fn s4_database_commands_offload_through_named_blocking_functions() {
        let db = include_str!("db/mod.rs");
        let search = include_str!("db/search.rs");
        let chess = include_str!("chess.rs");
        for name in [
            "get_db_info",
            "create_indexes",
            "delete_indexes",
            "edit_db_info",
            "get_games",
            "get_player",
            "get_players",
            "get_tournaments",
            "get_players_game_info",
            "delete_database",
            "delete_duplicated_games",
            "delete_empty_games",
            "export_to_pgn",
            "delete_db_game",
            "write_db_game",
            "merge_players",
            "preload_reference_db",
            "convert_pgn",
        ] {
            let blocking = body_at_indent(db, &blocking_fn_signature(db, name));
            assert!(
                !blocking.trim().is_empty(),
                "{name}_blocking must exist: {blocking}"
            );
            assert_body_offloads(
                command_dispatch_body(db, name),
                &format!("pub async fn {name}("),
                &format!("{name}_blocking"),
            );
        }
        let search_blocking =
            body_at_indent(search, &blocking_fn_signature(search, "search_position"));
        assert!(
            !search_blocking.trim().is_empty(),
            "search_position_blocking must exist: {search_blocking}"
        );
        assert_offloads(
            search,
            "pub async fn search_position(",
            "search_position_blocking",
        );
        let search_wrapper = body_at_indent(search, "pub async fn search_position(");

        let convert = body_at_indent(db, &blocking_fn_signature(db, "convert_pgn"));
        assert!(
            convert.contains("ConvertProgress"),
            "convert_pgn_blocking must emit ConvertProgress: {convert}"
        );
        let convert_wrapper = command_dispatch_body(db, "convert_pgn");
        let convert_dispatch = gateway_closure(convert_wrapper, "convert_pgn");
        assert!(
            convert_dispatch.contains("description,")
                && convert_dispatch.contains("progress_id,")
                && convert_dispatch.find("description,") < convert_dispatch.find("progress_id,"),
            "convert_pgn must forward progress_id into convert_pgn_blocking: {convert_wrapper}"
        );
        let players_info = body_at_indent(db, &blocking_fn_signature(db, "get_players_game_info"));
        assert!(
            players_info.contains("ProgressLease"),
            "get_players_game_info_blocking must take ProgressLease: {players_info}"
        );
        assert!(
            players_info.contains("* 100_f64"),
            "get_players_game_info_blocking must keep the 0..=100 scale: {players_info}"
        );
        for token in ["Succeeded", "Failed", "Cancelled", "complete("] {
            assert!(
                !players_info.contains(token),
                "get_players_game_info_blocking must not decide the terminal state (contains {token:?}): {players_info}"
            );
        }
        let players_wrapper = body_at_indent(db, "pub async fn get_players_game_info(");
        assert!(
            players_wrapper.contains("JobProgress::best_effort("),
            "get_players_game_info must diagnose optional progress initialization without failing data delivery: {players_wrapper}"
        );
        assert!(
            players_wrapper.contains(
                "get_players_game_info_blocking("
            ),
            "get_players_game_info must forward the JobProgress lease into the blocking call: {players_wrapper}"
        );
        assert!(
            !players_wrapper.contains(".ok()"),
            "get_players_game_info must not silently discard progress initialization failures: {players_wrapper}"
        );
        assert!(
            players_wrapper.contains("complete("),
            "get_players_game_info must complete the lease from the worker-owned closure: {players_wrapper}"
        );

        assert!(
            search_blocking.contains("ProgressLease"),
            "search_position_blocking must take ProgressLease: {search_blocking}"
        );
        assert!(
            search_blocking.contains("search_progress_percent"),
            "search_position_blocking must keep the 0..=100 scale: {search_blocking}"
        );
        for token in ["Succeeded", "Failed", "Cancelled", "complete("] {
            assert!(
                !search_blocking.contains(token),
                "search_position_blocking must not decide the terminal state (contains {token:?}): {search_blocking}"
            );
        }
        assert!(
            search_wrapper.contains("JobProgress"),
            "search_position must retain JobProgress through worker completion: {search_wrapper}"
        );
        assert!(
            search_wrapper.contains("complete("),
            "search_position must complete the lease from the worker-owned closure: {search_wrapper}"
        );

        let search_signature = search_blocking
            .split_once('{')
            .map(|(signature, _)| signature)
            .unwrap_or(search_blocking);
        assert!(
            search_signature.contains("OwnedSemaphorePermit"),
            "search_position_blocking must take OwnedSemaphorePermit: {search_signature}"
        );
        let novelty = body_at_indent(chess, "fn novelty_lookup_blocking(");
        let novelty_signature = novelty
            .split_once('{')
            .map(|(signature, _)| signature)
            .unwrap_or(novelty);
        assert!(
            novelty_signature.contains("OwnedSemaphorePermit"),
            "novelty_lookup_blocking must take OwnedSemaphorePermit: {novelty_signature}"
        );
    }

    #[test]
    fn s5_staged_and_published_hash_leaves_the_guard_and_the_tokio_worker() {
        let path_authority = concat!(
            include_str!("infra/path_authority/mod.rs"),
            include_str!("infra/path_authority/verified.rs"),
        );
        let reserve = body_at_indent(path_authority, "fn reserve_download_artifact");
        assert!(
            !reserve.contains("sha256_file"),
            "reserve_download_artifact must not hash the staged payload: {reserve}"
        );
        assert!(
            !reserve.contains("sha256_open_file"),
            "reserve_download_artifact must not hash the staged payload: {reserve}"
        );

        let prepare = body_at_indent(path_authority, "fn prepare_download_artifact");
        assert!(
            !prepare.contains("sha256_file")
                && !prepare.contains("sha256_open_file")
                && !prepare.contains(".read("),
            "prepare_download_artifact must not read or hash payload: {prepare}"
        );

        let commit = body_at_indent(path_authority, "fn commit_download_artifact");
        assert!(
            !commit.contains("sha256_file")
                && !commit.contains("sha256_open_file")
                && !commit.contains(".read("),
            "commit_download_artifact must not read or hash payload: {commit}"
        );

        let verify = body_at_indent(path_authority, "fn verify(");
        assert!(
            verify.contains(".sha256("),
            "verify must hash through VerifiedFile::sha256: {verify}"
        );
        let mint_hash = body_at_indent(path_authority, "fn sha256(");
        assert!(
            mint_hash.contains("sha256_open_file"),
            "VerifiedFile::sha256 must call sha256_open_file: {mint_hash}"
        );

        let hash_open = body_at_indent(path_authority, "fn sha256_open_file(");
        assert!(hash_open.contains("sha256_read_core("));
        let hash_core = body_at_indent(path_authority, "fn sha256_read_core(");
        assert!(
            hash_core.contains(".read(") && hash_core.contains("hasher.finalize()"),
            "the shared hash core must hash the descriptor: {hash_core}"
        );

        let runtime_helper = body_at_indent(
            path_authority,
            "pub(crate) async fn activate_download_artifact_runtime",
        );
        assert!(
            runtime_helper.contains("BLOCKING_GATEWAY"),
            "activate_download_artifact_runtime must offload: {runtime_helper}"
        );

        let cancellable_hash = body_at_indent(
            path_authority,
            "pub(crate) async fn hash_staged_payload_cancellable(",
        );
        assert!(
            cancellable_hash.contains("BLOCKING_GATEWAY"),
            "{cancellable_hash}"
        );
        assert!(
            cancellable_hash.contains("spawn_cancellable"),
            "{cancellable_hash}"
        );
        assert!(
            cancellable_hash.contains("sha256_reader_cancellable"),
            "{cancellable_hash}"
        );

        let fs = include_str!("fs.rs");
        for signature in [
            "async fn download_to_destination_inner",
            "pub(crate) async fn install_staged_pgn_artifact",
        ] {
            let body = body_at_indent(fs, signature);
            let hash = body
                .find("hash_staged_payload")
                .unwrap_or_else(|| panic!("{signature} must call hash_staged_payload: {body}"));
            let reserve = body.find("reserve_download_artifact").unwrap_or_else(|| {
                panic!("{signature} must call reserve_download_artifact: {body}")
            });
            assert!(
                hash < reserve,
                "{signature} must hash the staged payload before reserve_download_artifact: {body}"
            );
            assert!(
                body.contains("activate_download_artifact_runtime"),
                "{signature} must call activate_download_artifact_runtime: {body}"
            );
            assert!(
                !body.contains("activate_download_artifact("),
                "{signature} must not invoke synchronous activate_download_artifact: {body}"
            );
        }
    }

    #[test]
    fn s7_analyze_game_kills_the_engine_before_the_novelty_lookup() {
        let chess = include_str!("chess.rs");
        let command = body_at_indent(chess, "pub async fn analyze_game(");
        assert_eq!(
            command.matches("analyze_game_core(").count(),
            1,
            "{command}"
        );
        assert!(command.contains("run_native_operation("), "{command}");
        assert!(!command.contains("novelty_lookup_blocking("), "{command}");
        let body = body_at_indent(chess, "async fn analyze_game_core<");
        assert_offloads(
            chess,
            "async fn analyze_game_core<",
            "novelty_lookup_blocking",
        );
        let position_loop = body_at_indent(chess, "async fn analyze_position_with_owner(");
        assert!(
            position_loop.contains("ingest_info_line("),
            "{position_loop}"
        );
        let last_position = body
            .rmatch_indices("analyze_position_with_owner(")
            .next()
            .map(|(index, _)| index)
            .expect("analyze_game must call its production UCI position loop");
        let first_novelty = body
            .find("novelty_lookup_blocking")
            .expect("analyze_game must call novelty_lookup_blocking");
        let terminate_between = body
            .match_indices("terminate_now()")
            .any(|(index, _)| index > last_position && index < first_novelty);
        assert!(
            terminate_between,
            "analyze_game must terminate the engine through its registration guard (terminate_now) after the UCI loop and before novelty_lookup_blocking: {body}"
        );
    }

    /// Textual proof that the early exit still exists, because no unit test in this tree
    /// can drive `novelty_lookup_blocking` without a real reference database. This is not
    /// a proof that `break` is the right bound — only that the early-exit is still in the
    /// body.
    #[test]
    fn novelty_lookup_blocking_stops_at_the_first_absent_position() {
        let chess = include_str!("chess.rs");
        let novelty = body_at_indent(chess, "fn novelty_lookup_blocking(");
        assert!(
            novelty.contains("break"),
            "novelty_lookup_blocking must stop at the first absent position: {novelty}"
        );
    }

    #[test]
    fn s8_blocking_functions_do_not_nest_the_gateway() {
        for (file, source) in [
            ("main.rs", include_str!("main.rs")),
            ("puzzle.rs", include_str!("puzzle.rs")),
            ("file_workspace.rs", include_str!("file_workspace.rs")),
            ("fs.rs", include_str!("fs.rs")),
            ("db/mod.rs", include_str!("db/mod.rs")),
            ("db/search.rs", include_str!("db/search.rs")),
            ("chess.rs", include_str!("chess.rs")),
        ] {
            let mut search_from = 0;
            while let Some(rel) = next_blocking_offset(source, search_from) {
                let abs = search_from + rel;
                let line_start = source[..abs].rfind('\n').map(|i| i + 1).unwrap_or(0);
                let line_end = source[abs..]
                    .find('\n')
                    .map(|i| abs + i)
                    .unwrap_or(source.len());
                let line = &source[line_start..line_end];
                let trimmed = line.trim_start();
                let is_sync_fn = trimmed.starts_with("fn ")
                    || trimmed.starts_with("pub fn ")
                    || trimmed.starts_with("pub(crate) fn ");
                if is_sync_fn {
                    let name_start = trimmed.find("fn ").expect("sync fn prefix") + 3;
                    let name = trimmed[name_start..]
                        .split('(')
                        .next()
                        .expect("function name")
                        .trim();
                    let body = body_at_indent(source, &format!("fn {name}("));
                    for token in ["BLOCKING_GATEWAY", "block_on", "Handle::current", ".await"] {
                        assert!(
                            !body.contains(token),
                            "{file}::{name} must not nest a gateway acquisition (contains {token:?}): {body}"
                        );
                    }
                }
                search_from = abs + "_blocking".len();
            }
        }

        // Workers that carry a blocking body without the `_blocking` suffix are invisible to the
        // walk above, so they are named here. `active_or_default_puzzle_workspace` is the
        // documented exception (`e770bcdb`, `d-20260903-06`): it already was the blocking body,
        // so no pass-through wrapper was added — and without this it would be the one offloaded
        // worker never checked for the nested acquisition that deadlocks the gateway.
        //
        // The five database helpers are the deadlock chain: `_blocking` bodies call them
        // while holding a gateway permit, so wrapping any of them in `BLOCKING_GATEWAY.spawn`
        // would take a second permit and stall. A glob cannot find them because they carry
        // no `_blocking` suffix — commit `a22bbdf4` made them synchronous for that reason.
        let file_workspace = include_str!("file_workspace.rs");
        let db = include_str!("db/mod.rs");
        let search = include_str!("db/search.rs");
        let pgn = include_str!("pgn.rs");
        // Limit hook lookup to free functions, before the same-named repository methods.
        let pgn_scan_hooks = pgn
            .split_once("impl PgnRepository {")
            .expect("repository implementation")
            .0;
        for (file, source, name) in [
            (
                "puzzle.rs",
                include_str!("puzzle.rs"),
                "active_or_default_puzzle_workspace",
            ),
            ("file_workspace.rs", file_workspace, "collect_tree_entries"),
            (
                "file_workspace.rs",
                file_workspace,
                "create_workspace_directory_inner",
            ),
            ("file_workspace.rs", file_workspace, "trash_entry"),
            ("file_workspace.rs", file_workspace, "restore_trash_item"),
            (
                "file_workspace.rs",
                file_workspace,
                "count_installed_workspace_pgn",
            ),
            ("pgn.rs", pgn, "scan_current_blocking"),
            ("pgn.rs", pgn, "count_pgn_games_core_blocking"),
            ("pgn.rs", pgn, "cached_scan"),
            ("pgn.rs", pgn, "snapshot_key"),
            ("pgn.rs", pgn, "scan_file"),
            ("pgn.rs", pgn, "fresh_snapshot"),
            ("pgn.rs", pgn, "revision_matches"),
            ("pgn.rs", pgn, "next_revision_attempt"),
            ("pgn.rs", pgn, "scan_and_read_ranges_blocking"),
            ("pgn.rs", pgn, "read_ranges"),
            ("pgn.rs", pgn, "read_range_bytes"),
            ("pgn.rs", pgn_scan_hooks, "set_read_chunk_hook"),
            ("pgn.rs", pgn_scan_hooks, "current_read_chunk_hook"),
            ("pgn.rs", pgn_scan_hooks, "set_scan_attempt_action"),
            ("pgn.rs", pgn_scan_hooks, "observe_scan_attempt_action"),
            ("pgn.rs", pgn, "scan_attempt_action"),
            ("pgn.rs", pgn, "observe_read_attempt_action"),
            ("pgn.rs", pgn, "scan_games_cancelled"),
            ("pgn.rs", pgn, "is_tag_header"),
            ("pgn.rs", pgn, "update_brace_comment"),
            ("pgn.rs", pgn, "malformed"),
            ("pgn.rs", pgn, "read_bounded_line"),
            ("pgn.rs", pgn_scan_hooks, "set_scan_line_hook"),
            ("pgn.rs", pgn_scan_hooks, "current_scan_line_hook"),
            ("pgn.rs", pgn, "observe_count_hook"),
            ("pgn.rs", pgn, "count_after_scan"),
            ("db/search.rs", search, "load_search_index"),
            ("db/mod.rs", db, "generate_search_index"),
            ("db/mod.rs", db, "generate_search_index_locked"),
            ("db/search.rs", search, "is_position_in_db"),
            ("db/mod.rs", db, "get_db_or_create"),
        ] {
            let signature = fn_signature(source, name);
            if file == "pgn.rs" {
                assert_eq!(
                    source.matches(&signature).count(),
                    1,
                    "{file}::{name} must resolve unambiguously"
                );
            }
            let body = body_at_indent(source, &signature);
            for token in ["BLOCKING_GATEWAY", "block_on", "Handle::current", ".await"] {
                assert!(
                    !body.contains(token),
                    "{file}::{name} must not nest a gateway acquisition (contains {token:?}): {body}"
                );
            }
        }
    }

    #[test]
    fn s9_nested_awaits_stay_on_the_async_side() {
        let source = include_str!("file_workspace.rs");
        for (signature, token) in [
            (
                "pub(crate) async fn list_file_workspace_core(",
                "count_pgn_games_core",
            ),
            ("async fn remove_trash(", "retire_executables"),
        ] {
            let body = body_at_indent(source, signature);
            assert!(
                body.contains(token),
                "{signature} must keep {token} on the async side: {body}"
            );
        }
        let puzzle = include_str!("puzzle.rs");
        let list_puzzles = body_at_indent(puzzle, "pub async fn list_puzzle_databases(");
        assert!(
            list_puzzles.contains("puzzle_database_info_for_file"),
            "list_puzzle_databases must keep puzzle_database_info_for_file on the async side: {list_puzzles}"
        );
    }

    /// Helper-level tests in `path_authority.rs` pin that the helpers keep the split, but they
    /// do not constrain the callers. Taking `authority.with_mut(…)` around
    /// `read_engine_image_bytes` puts the whole up-to-10 MiB read back under the process-wide
    /// mutex, and those tests stay green. This is the caller-side half, and it is what goes red
    /// when a call site puts the read back under the guard — or stops going through the split
    /// at all.
    #[test]
    fn s10_engine_image_call_sites_read_outside_the_authority_guard() {
        let main = include_str!("main.rs");
        for signature in [
            "fn issue_engine_image_blocking<R:",
            "fn read_engine_image_blocking(",
        ] {
            let body = body_at_indent(main, signature);
            let reader_token = "engine_image_reader_for(";
            let read_token = "read_engine_image_bytes(";
            assert_eq!(
                body.matches(reader_token).count(),
                1,
                "{signature} must call {reader_token} exactly once: {body}"
            );
            assert_eq!(
                body.matches(read_token).count(),
                1,
                "{signature} must call {read_token} exactly once: {body}"
            );
            assert!(
                body.contains("MAX_ENGINE_IMAGE_BYTES"),
                "{signature} must mention MAX_ENGINE_IMAGE_BYTES: {body}"
            );
            let reader = body.find(reader_token).unwrap();
            let read = body.find(read_token).unwrap();
            assert!(
                reader < read,
                "{signature} must call {reader_token} before {read_token}: {body}"
            );

            let open = read + "read_engine_image_bytes".len();
            let close = closing_paren(body, open).unwrap_or_else(|| {
                panic!("{signature} has an unbalanced {read_token} call: {body}")
            });
            let read_end = close + 1;

            let mut depth_at = vec![0usize; body.len()];
            let mut depth = 0usize;
            for (i, character) in body.char_indices() {
                depth_at[i] = depth;
                match character {
                    '{' => depth += 1,
                    '}' => depth = depth.saturating_sub(1),
                    _ => {}
                }
                for byte in 1..character.len_utf8() {
                    depth_at[i + byte] = depth_at[i];
                }
            }

            for acquisition in [".lock(", ".with_mut(", ".with_mut_cancellable("] {
                let mut search_from = 0;
                while let Some(rel) = body[search_from..].find(acquisition) {
                    let i = search_from + rel;
                    if i < reader {
                        // A guard taken at a strictly deeper block level than the read has
                        // provably been dropped by the time the read runs, because the block
                        // closed. A guard taken at the read's own level would still be alive.
                        assert!(
                            depth_at[i] > depth_at[reader],
                            "{signature} must drop any authority lock taken before \
                         {reader_token} before the read runs: {body}"
                        );
                    } else if i < read_end {
                        panic!(
                            "{signature} must not re-acquire an authority lock around \
                         {read_token}: {body}"
                        );
                    }
                    search_from = i + acquisition.len();
                }
            }
        }
    }

    #[test]
    fn engine_image_install_and_post_install_cleanup_are_pinned_to_the_descriptor() {
        let main = include_str!("main.rs");
        let body = body_at_indent(main, "fn issue_engine_image_blocking<R:");
        assert!(
            body.contains("atomic_replace_leaf_identified("),
            "engine-image installation must use the authorized directory descriptor: {body}"
        );
        assert!(!body.contains(".join("), "{body}");
        assert!(
            !body.contains("crate::infra::fs::atomic_replace("),
            "{body}"
        );
        assert!(
            body.contains("CommittedDurabilityUncertain"),
            "engine-image installation must handle uncertain parent durability: {body}"
        );
        assert!(!body.contains("let (_, installed)"), "{body}");
        let install_at = body
            .find("atomic_replace_leaf_identified(")
            .expect("install through the descriptor");
        let after_install = &body[install_at..];
        assert!(
            after_install.contains("match authority.with_mut(|authority|"),
            "{after_install}"
        );
        let unavailable = after_install
            .split_once("Err(unavailable) =>")
            .expect("both typed acquisition failures share the cleanup arm")
            .1;
        assert!(
            unavailable
                .trim_start()
                .starts_with("Err(engine_image_error_after_cleanup("),
            "{unavailable}"
        );
        let arguments = unavailable
            .split_once("engine_image_error_after_cleanup(")
            .unwrap()
            .1
            .split_once(")),")
            .expect("end of acquisition error cleanup")
            .0;
        assert!(
            arguments.contains("Error::from(unavailable)"),
            "{arguments}"
        );
        assert!(arguments.trim_end().ends_with("None,"), "{arguments}");
        let registration = after_install
            .split_once("register_engine_image(")
            .expect("registration after install")
            .1;
        let arguments = registration
            .split_once("engine_image_error_after_cleanup(")
            .expect("registration error cleanup")
            .1
            .split_once(")),")
            .expect("end of the registration error cleanup call")
            .0;
        assert!(
            arguments.trim_end().ends_with("Some(authority),"),
            "registration error cleanup must forward the authority: {arguments}"
        );
        let cleanup = body_at_indent(main, "fn engine_image_error_after_cleanup(");
        assert!(cleanup.contains("remove_leaf_identified("), "{cleanup}");
        assert!(cleanup.contains("Error::with_cleanup("), "{cleanup}");
        assert!(
            cleanup.contains("record_engine_image_cleanup("),
            "{cleanup}"
        );
        assert!(!cleanup.contains("log::error!("), "{cleanup}");
        assert!(
            cleanup.contains("engine image {leaf:?} was removed but parent sync"),
            "{cleanup}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn engine_image_orphan_removal_failure_records_intent_and_preserves_both_errors() {
        use crate::infra::fs::{scoped_test_removal_injector, RemovalFault, RemovalFaultPoint};
        use crate::infra::path_authority::portable_tests::EngineImageCleanupFixture;
        let mut f = EngineImageCleanupFixture::new();
        f.authority.seal_engine_attachments();
        let original = f
            .authority
            .register_engine_image(&f.image_dir, &f.leaf, f.installed, "image".into())
            .unwrap_err();
        let primary = original.diagnostic();
        let guard = scoped_test_removal_injector(std::sync::Arc::new(RemovalFault(
            RemovalFaultPoint::BeforeTopOpen,
        )));
        let error = crate::engine_image_error_after_cleanup(
            &f.image_dir,
            &f.leaf,
            f.installed,
            original,
            Some(&mut f.authority),
        );
        drop(guard);
        assert_engine_image_cleanup_diagnostic(
            &error,
            &primary,
            &f.leaf,
            "cleanup intent recorded",
        );
        assert!(f.image_dir.path().join(&f.leaf).is_file());
        f.reload_and_remove();
    }

    #[cfg(unix)]
    fn assert_engine_image_cleanup_diagnostic(
        error: &crate::Error,
        primary: &str,
        leaf: &std::ffi::OsStr,
        outcome: &str,
    ) {
        let crate::Error::OperationAndCleanup {
            primary: actual_primary,
            cleanup,
        } = error
        else {
            panic!(
                "expected composed engine image error: {}",
                error.diagnostic()
            );
        };
        assert_eq!(actual_primary, primary);
        for expected in [leaf.to_str().unwrap(), "injected removal failure", outcome] {
            assert!(
                cleanup.contains(expected),
                "missing {expected:?}: {cleanup}"
            );
            assert!(
                error.diagnostic().contains(expected),
                "missing {expected:?}: {}",
                error.diagnostic()
            );
        }
        assert!(error.diagnostic().contains(primary));
    }

    #[cfg(unix)]
    #[test]
    fn engine_image_orphan_removal_failure_without_authority_reports_no_intent() {
        use crate::infra::fs::{scoped_test_removal_injector, RemovalFault, RemovalFaultPoint};
        use crate::infra::path_authority::portable_tests::EngineImageCleanupFixture;
        for original in [
            crate::infra::path_authority::AuthorityUnavailable::Poisoned,
            crate::infra::path_authority::AuthorityUnavailable::Uninitialized,
        ] {
            let f = EngineImageCleanupFixture::new();
            let original = crate::Error::from(original);
            let primary = original.diagnostic();
            let guard = scoped_test_removal_injector(std::sync::Arc::new(RemovalFault(
                RemovalFaultPoint::BeforeTopOpen,
            )));
            let error = crate::engine_image_error_after_cleanup(
                &f.image_dir,
                &f.leaf,
                f.installed,
                original,
                None,
            );
            drop(guard);
            assert_engine_image_cleanup_diagnostic(
                &error,
                &primary,
                &f.leaf,
                "not recorded: no path authority",
            );
            f.assert_no_intent();
        }
    }

    #[cfg(unix)]
    #[test]
    fn engine_image_cleanup_helper_reports_registry_write_failure_and_admission_refusal() {
        use crate::infra::fs::{
            install_test_atomic_file_injector, scoped_test_removal_injector, AtomicFileFaultPoint,
            CancelAtomicFileAt, RemovalFault, RemovalFaultPoint,
        };
        use crate::infra::path_authority::portable_tests::EngineImageCleanupFixture;
        for admission in [false, true] {
            let mut f = EngineImageCleanupFixture::new();
            let before = if admission {
                f.fill_admission_bound();
                Some(std::fs::read(&f.registry).unwrap())
            } else {
                None
            };
            let atomic_guard = (!admission).then(|| {
                install_test_atomic_file_injector(std::sync::Arc::new(CancelAtomicFileAt {
                    cancel_at: AtomicFileFaultPoint::Cleanup,
                    fail_at: Some(AtomicFileFaultPoint::Write),
                    cancellation: tokio_util::sync::CancellationToken::new(),
                }))
            });
            let original = crate::Error::Conflict("original registration failure".into());
            let primary = original.diagnostic();
            let guard = scoped_test_removal_injector(std::sync::Arc::new(RemovalFault(
                RemovalFaultPoint::BeforeTopOpen,
            )));
            let error = crate::engine_image_error_after_cleanup(
                &f.image_dir,
                &f.leaf,
                f.installed,
                original,
                Some(&mut f.authority),
            );
            drop(guard);
            drop(atomic_guard);
            let expected = if admission {
                "not recorded: Resource limit: path registry identifier limit reached"
            } else {
                "not recorded, retained in memory: I/O failure: injected Write failure"
            };
            assert_engine_image_cleanup_diagnostic(&error, &primary, &f.leaf, expected);
            if let Some(before) = before {
                assert_eq!(std::fs::read(&f.registry).unwrap(), before);
            } else {
                assert!(!f.registry.exists());
                f.authority
                    .cleanup_engine_images(&f.image_dir, false)
                    .unwrap();
                assert!(!f.image_dir.path().join(&f.leaf).exists());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn engine_image_cleanup_after_unlink_uncertainty_returns_original_without_intent() {
        use crate::infra::fs::{scoped_test_removal_injector, RemovalFault, RemovalFaultPoint};
        use crate::infra::path_authority::portable_tests::EngineImageCleanupFixture;
        let mut f = EngineImageCleanupFixture::new();
        let guard = scoped_test_removal_injector(std::sync::Arc::new(RemovalFault(
            RemovalFaultPoint::ParentSync,
        )));
        let error = crate::engine_image_error_after_cleanup(
            &f.image_dir,
            &f.leaf,
            f.installed,
            crate::Error::Conflict("registration failed".into()),
            Some(&mut f.authority),
        );
        drop(guard);
        assert!(
            matches!(error, crate::Error::Conflict(message) if message == "registration failed")
        );
        assert!(!f.image_dir.path().join(&f.leaf).exists());
        f.assert_no_intent();
    }

    #[test]
    fn engine_image_cleanup_already_absent_returns_original_without_intent() {
        use crate::infra::path_authority::portable_tests::EngineImageCleanupFixture;
        let mut f = EngineImageCleanupFixture::new();
        f.image_dir
            .remove_leaf_identified(&f.leaf, f.installed)
            .unwrap();
        let error = crate::engine_image_error_after_cleanup(
            &f.image_dir,
            &f.leaf,
            f.installed,
            crate::Error::Conflict("registration failed".into()),
            Some(&mut f.authority),
        );
        assert!(
            matches!(error, crate::Error::Conflict(message) if message == "registration failed")
        );
        f.assert_no_intent();
    }

    #[test]
    fn engine_image_cleanup_helper_wire_form_omits_leaf_and_native_paths() {
        use crate::infra::path_authority::portable_tests::EngineImageCleanupFixture;
        let mut f = EngineImageCleanupFixture::new();
        // A different installed identity makes descriptor removal refuse on every target.
        let other = f.image_dir.identity();
        let original = crate::Error::Conflict(format!(
            "registration failed under {}",
            f.app_data.display()
        ));
        let error = crate::engine_image_error_after_cleanup(
            &f.image_dir,
            &f.leaf,
            other,
            original,
            Some(&mut f.authority),
        );
        assert!(matches!(error, crate::Error::OperationAndCleanup { .. }));
        let wire = serde_json::to_value(&error).unwrap();
        assert_eq!(wire["category"], "operation-and-cleanup");
        assert_eq!(
            wire["message"],
            "Operation failed; temporary cleanup also failed"
        );
        let payload = serde_json::to_string(&wire).unwrap();
        assert!(!payload.contains(f.leaf.to_str().unwrap()), "{payload}");
        assert!(
            !payload.contains(&f.app_data.to_string_lossy().to_string()),
            "{payload}"
        );
        let encoded_path = serde_json::to_string(&f.app_data.to_string_lossy()).unwrap();
        assert!(
            !payload.contains(&encoded_path[1..encoded_path.len() - 1]),
            "{payload}"
        );
        assert!(f.image_dir.path().join(&f.leaf).is_file());
    }

    #[test]
    fn engine_image_post_install_error_removes_the_orphan() {
        use crate::infra::path_authority::portable_tests::EngineImageCleanupFixture;
        use crate::{engine_image_error_after_cleanup, Error};
        let mut f = EngineImageCleanupFixture::new();

        let error = engine_image_error_after_cleanup(
            &f.image_dir,
            &f.leaf,
            f.installed,
            Error::Conflict("registration failed".into()),
            Some(&mut f.authority),
        );

        assert!(matches!(error, Error::Conflict(message) if message == "registration failed"));
        assert!(!f.image_dir.path().join(&f.leaf).exists());
        f.assert_no_intent();
    }

    /// A one-directional "who calls `ensure_app_owned_default_dir`" scan cannot see the swap
    /// that matters: exchanging `Databases` and `Engines` between the two workspace helpers
    /// leaves the surface counts unchanged and registers the database root under `engines`.
    /// So each call site is pinned to its own variant, to the exact parent argument
    /// it passes (the lazily resolved app-data directory: a residual `.join("db")` would yield
    /// `<app_data>/db/db`), and to no longer joining its own leaf. The argument is spelled out
    /// per site. The needle is the fully-qualified variant: three of these bodies already
    /// contain the bare word as a `display_name` argument.
    #[test]
    fn app_owned_default_roots_are_pinned_to_their_call_sites() {
        let main = include_str!("main.rs");
        let puzzle = include_str!("puzzle.rs");
        let lazy = "&app_data()?,";
        for (source, name, lookup) in [
            (main, "get_database_workspace", "AppDataDir::for_app(&app)"),
            (main, "get_engine_workspace", "AppDataDir::for_app(&app)"),
            (puzzle, "get_puzzle_workspace", "AppDataDir::for_app(&app)"),
            (
                puzzle,
                "issue_puzzle_download_destination_blocking",
                "AppDataDir::for_app(&app)",
            ),
            (
                puzzle,
                "list_puzzle_databases_blocking",
                "AppDataDir::for_app(app)",
            ),
        ] {
            let body = body_at_indent(source, &fn_signature(source, name));
            assert!(
                body.contains(lookup),
                "{name} must supply its own app-data lookup: {body}"
            );
            assert!(
                !body.contains(".join("),
                "{name} must not append a default leaf: {body}"
            );
        }
        let bootstrap = body_at_indent(main, "fn get_database_workspace_blocking(");
        assert!(
            bootstrap.contains("let app_data = app_data()?;"),
            "{bootstrap}"
        );
        assert!(
            bootstrap.contains("get_default_database_workspace(authority, &app_data)"),
            "{bootstrap}"
        );
        for (file, source, name, variant, parent, leaf) in [
            (
                "main.rs",
                main,
                "get_default_database_workspace",
                "AppOwnedDefaultRoot::Databases",
                "app_data,",
                "db",
            ),
            (
                "main.rs",
                main,
                "get_engine_workspace_blocking",
                "AppOwnedDefaultRoot::Engines",
                lazy,
                "engines",
            ),
            (
                "main.rs",
                main,
                "issue_engine_image_blocking",
                "AppOwnedDefaultRoot::EngineImages",
                "&app_data,",
                "engine-images",
            ),
            (
                "puzzle.rs",
                puzzle,
                "active_or_default_puzzle_workspace",
                "AppOwnedDefaultRoot::Puzzles",
                lazy,
                "puzzles",
            ),
        ] {
            let body = body_at_indent(source, &fn_signature(source, name));
            let call = "ensure_app_owned_default_dir(";
            let call_at = body.find(call).unwrap_or_else(|| {
                panic!("{file}::{name} must materialise its root through {call}: {body}")
            });
            let variant_at = body[call_at..]
                .find(variant)
                .map(|offset| call_at + offset)
                .unwrap_or_else(|| panic!("{file}::{name} must pass {variant}: {body}"));
            // The variant is written path-qualified at the call sites, so the argument ends at
            // the last comma before it rather than at the needle itself.
            let between = &body[call_at + call.len()..variant_at];
            let comma = between
                .rfind(',')
                .unwrap_or_else(|| panic!("{file}::{name} must pass {variant} second: {body}"));
            let argument: String = between[..=comma].split_whitespace().collect();
            assert_eq!(
                argument, parent,
                "{file}::{name} must pass its app-data directory as {parent}: {body}"
            );
            let quoted = format!("{leaf:?}");
            assert!(
                !body.contains(&quoted),
                "{file}::{name} must not join {quoted} itself: {body}"
            );
        }

        // Pin the descriptor identity as the third root-registration argument. Searching the
        // whole body for `Some(` is insufficient because each helper already handles an active
        // root option before reaching this call.
        for (file, source, name, call) in [
            (
                "main.rs",
                main,
                "get_default_database_workspace",
                "get_or_create_database_root(",
            ),
            (
                "main.rs",
                main,
                "get_engine_workspace_blocking",
                "get_or_create_engine_root(",
            ),
            (
                "puzzle.rs",
                puzzle,
                "active_or_default_puzzle_workspace",
                "get_or_create_puzzle_root(",
            ),
        ] {
            let body = body_at_indent(source, &fn_signature(source, name));
            assert_eq!(
                body.matches(call).count(),
                1,
                "{file}::{name} must call {call} exactly once: {body}"
            );
            let call_at = body.find(call).unwrap();
            let open = call_at + call.len() - 1;
            let close = closing_paren(body, open)
                .unwrap_or_else(|| panic!("{file}::{name} has an unbalanced {call} call: {body}"));
            let arguments = &body[open + 1..close];
            let mut depth = 0usize;
            let mut commas = Vec::new();
            for (offset, character) in arguments.char_indices() {
                match character {
                    '(' => depth += 1,
                    ')' => depth = depth.saturating_sub(1),
                    ',' if depth == 0 => commas.push(offset),
                    _ => {}
                }
            }
            let trailing_comma = arguments.trim_end().ends_with(',');
            assert_eq!(
                commas.len(),
                if trailing_comma { 3 } else { 2 },
                "{file}::{name} must pass exactly three arguments to {call}: {body}"
            );
            let third_end = commas.get(2).copied().unwrap_or(arguments.len());
            let expected_identity: String = arguments[commas[1] + 1..third_end]
                .split_whitespace()
                .collect();
            assert_eq!(
                expected_identity, "Some(authorized_dir.identity())",
                "{file}::{name} must pass the descriptor identity third: {body}"
            );
        }
    }
}

mod chessbase {
    use std::path::{Path, PathBuf};
    use tauri_specta::Event;

    const EXTENSIONS: [&str; 6] = ["cbh", "2cbh", "cbone", "cbv", "cbz", "cbf"];

    pub(crate) fn is_database(path: &Path) -> bool {
        path.extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                EXTENSIONS
                    .iter()
                    .any(|known| extension.eq_ignore_ascii_case(known))
            })
    }

    pub(crate) fn picker_extensions() -> Vec<String> {
        std::iter::once("pgn".to_owned())
            .chain(
                EXTENSIONS
                    .iter()
                    .flat_map(|extension| [extension.to_string(), extension.to_ascii_uppercase()]),
            )
            .collect()
    }

    #[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type, Event)]
    pub(crate) struct ChessBaseSelected {}

    fn should_emit(paths: &[PathBuf]) -> bool {
        paths.iter().any(|path| is_database(path))
    }

    pub(crate) fn handle_drop<R: tauri::Runtime>(
        window: &tauri::Window<R>,
        event: &tauri::DragDropEvent,
    ) -> tauri::Result<()> {
        if window.label() == "main" {
            if let tauri::DragDropEvent::Drop { paths, .. } = event {
                if should_emit(paths) {
                    ChessBaseSelected {}.emit_to(window, window.label())?;
                }
            }
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::{Arc, Mutex};

        #[test]
        fn chessbase_classifier_and_filter_list() {
            let filters = picker_extensions();
            assert_eq!(filters.len(), 13);
            assert_eq!(filters[0], "pgn");
            for extension in EXTENSIONS {
                for case in [
                    extension.to_owned(),
                    extension.to_ascii_uppercase(),
                    extension
                        .chars()
                        .enumerate()
                        .map(|(index, value)| {
                            if index % 2 == 0 {
                                value.to_ascii_uppercase()
                            } else {
                                value
                            }
                        })
                        .collect(),
                ] {
                    assert!(is_database(Path::new(&format!("games.{case}"))));
                }
                assert!(filters.contains(&extension.to_owned()));
                assert!(filters.contains(&extension.to_ascii_uppercase()));
            }
            for file in ["games.pgn", "games", "games.cbh.pgn"] {
                assert!(!is_database(Path::new(file)));
            }
        }

        #[test]
        fn chessbase_drop_decision() {
            assert!(should_emit(&["games.pgn".into(), "games.CbH".into()]));
            assert!(!should_emit(&["games.pgn".into(), "games.txt".into()]));
            assert!(!should_emit(&[]));
        }

        #[test]
        fn chessbase_drop_to_typed_event() -> Result<(), Box<dyn std::error::Error>> {
            let app = tauri::test::mock_app();
            tauri_specta::Builder::<tauri::test::MockRuntime>::new()
                .events(tauri_specta::collect_events!(ChessBaseSelected))
                .mount_events(&app);
            let webview =
                tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build()?;
            let window = webview.as_ref().window();
            let received = Arc::new(Mutex::new(0));
            let observed = received.clone();
            let listener = ChessBaseSelected::listen(&window, move |_| {
                if let Ok(mut count) = observed.lock() {
                    *count += 1;
                }
            });
            let drop = |paths| tauri::DragDropEvent::Drop {
                paths,
                position: tauri::PhysicalPosition::new(0.0, 0.0),
            };
            handle_drop(
                &window,
                &drop(vec!["games.CBH".into(), "archive.cbv".into()]),
            )?;
            assert_eq!(*received.lock().map_err(|_| "event lock poisoned")?, 1);
            handle_drop(&window, &drop(vec!["games.pgn".into()]))?;
            handle_drop(&window, &tauri::DragDropEvent::Leave)?;
            handle_drop(
                &window,
                &tauri::DragDropEvent::Enter {
                    paths: vec!["games.cbh".into()],
                    position: tauri::PhysicalPosition::new(0.0, 0.0),
                },
            )?;
            assert_eq!(*received.lock().map_err(|_| "event lock poisoned")?, 1);
            use tauri::Listener;
            window.unlisten(listener);
            Ok(())
        }
    }
}

#[cfg(test)]
mod chessbase_boundary_tests {
    use super::*;

    #[test]
    fn chessbase_selection_refuses_before_authority_and_pgn_still_succeeds(
    ) -> Result<(), Box<dyn std::error::Error>> {
        use crate::infra::path_authority::{PathAuthority, SharedPathAuthority};
        let directory = tempfile::tempdir()?;
        let registry = directory.path().join("registry.json");
        let authority =
            SharedPathAuthority::installed(PathAuthority::open(registry.clone(), vec![])?);
        let before = authority
            .with_mut(|authority| serde_json::to_value(authority.descriptors()))
            .map_err(Error::from)??;
        for name in [
            "games.cbh",
            "games.2CbH",
            "games.CBONE",
            "games.cbv",
            "games.cbz",
            "games.cbf",
        ] {
            // The path need not exist: refusal must precede all file access and authority changes.
            let result = issue_pgn_workspace_blocking(&authority, directory.path().join(name));
            assert!(matches!(result, Err(Error::ChessBaseDatabase)));
            let after = authority
                .with_mut(|authority| serde_json::to_value(authority.descriptors()))
                .map_err(Error::from)??;
            assert_eq!(before, after);
            assert!(!registry.exists());
        }
        let pgn = directory.path().join("games.pgn");
        std::fs::write(&pgn, "*")?;
        let descriptor = issue_pgn_workspace_blocking(&authority, pgn)?;
        assert_eq!(descriptor.display_name, "games.pgn");
        assert!(registry.exists());
        let persisted = PathAuthority::open(registry, vec![])?.descriptors();
        assert_eq!(persisted.len(), 1);
        Ok(())
    }
}

#[cfg(test)]
mod close_splashscreen_tests {
    use super::{show_labeled_main_window, Error};
    use crate::error::ErrorCategory;

    #[test]
    fn missing_main_window_is_typed_invalid_input() {
        let app = tauri::test::mock_app();
        let error =
            show_labeled_main_window(app.handle()).expect_err("mock app has no main window");
        assert_eq!(error.category(), ErrorCategory::InvalidInput);
        let payload = serde_json::to_value(&error).expect("serialize missing-window error");
        assert_eq!(payload["tag"], "backend-error");
        assert_eq!(payload["category"], "invalid-input");
        assert_eq!(
            payload["message"],
            "Invalid input: no window labeled 'main' found"
        );
    }

    #[test]
    fn existing_main_window_is_shown() {
        let app = tauri::test::mock_app();
        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("create labeled main window");
        show_labeled_main_window(app.handle()).expect("show existing main window");
    }

    #[test]
    fn show_failure_stays_an_opaque_platform_payload() {
        let error = Error::from(tauri::Error::AssetNotFound(
            "/private/secret-tauri-asset".into(),
        ));
        assert_eq!(error.category(), ErrorCategory::Platform);
        let serialized = serde_json::to_string(&error).expect("serialize show failure");
        assert!(
            !serialized.contains("/private/secret-tauri-asset"),
            "tauri Display leaked in {serialized}"
        );
        let payload: serde_json::Value =
            serde_json::from_str(&serialized).expect("show failure is JSON");
        assert_eq!(payload["tag"], "backend-error");
        assert_eq!(payload["category"], "platform");
        assert_eq!(payload["message"], "platform failure");
    }
}

#[cfg(test)]
mod authority_unavailable_command_tests {
    use super::{reconcile_startup_path_owners, AppState};
    use tauri::Manager;

    #[tokio::test]
    async fn unavailable_authority_commands_preserve_renderer_payloads() {
        use crate::infra::path_authority::{
            AuthorityUnavailable, DatabaseHandle, PathRef, StartupPathOwners,
        };
        for unavailable in [
            AuthorityUnavailable::Poisoned,
            AuthorityUnavailable::Uninitialized,
        ] {
            let state = AppState::default();
            match unavailable {
                AuthorityUnavailable::Poisoned => state.pgn_path_authority.poison(),
                AuthorityUnavailable::Uninitialized => state.pgn_path_authority.uninstall(),
            }
            let app = tauri::test::mock_app();
            app.manage(state);
            let accepted = reconcile_startup_path_owners(
                StartupPathOwners {
                    retained_ids: vec![],
                    trusted_families: vec![],
                },
                app.state::<AppState>(),
            )
            .await
            .unwrap_err();
            let gateway = crate::db::create_indexes(
                DatabaseHandle::new(PathRef {
                    id: "unavailable-database".into(),
                }),
                app.state::<AppState>(),
            )
            .await
            .unwrap_err();
            let expected = match unavailable {
                AuthorityUnavailable::Poisoned => "Conflict: path authority lock was poisoned",
                AuthorityUnavailable::Uninitialized => {
                    "Conflict: path authority is not initialized"
                }
            };
            for error in [accepted, gateway] {
                assert_eq!(
                    serde_json::to_value(error).unwrap(),
                    serde_json::json!({
                        "tag": "backend-error", "category": "conflict", "message": expected,
                    })
                );
            }
            assert!(app
                .state::<AppState>()
                .operations
                .outstanding_labels()
                .unwrap()
                .is_empty());
        }
    }
}
