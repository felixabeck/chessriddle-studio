use dashmap::DashMap;
use diesel::prelude::*;
use log::info;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use shakmaty::{fen::Fen, san::SanPlus, Bitboard, Chess, Color, EnPassantMode, Position, Setup};
use specta::Type;
use std::{
    cmp::Reverse,
    collections::{BinaryHeap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::Manager;
use tokio::sync::OwnedSemaphorePermit;
use tokio_util::sync::CancellationToken;

#[cfg(test)]
use crate::db::search_index::get_index_path;
use crate::db::search_index::{
    legacy_sidecar_leaf, preferred_sidecar_leaf, promote_legacy_index_sidecar_at,
};
#[cfg(test)]
use crate::progress::ProgressUpdateHook;
use crate::{
    db::{
        encoding::{
            database_setup_to_chess, decode_move, try_iter_mainline_move_bytes_cancellable,
        },
        get_db_or_create, get_pawn_home,
        models::*,
        normalize_games,
        schema::*,
        search_index::{GameResult, IndexSource, MmapSearchIndex, SearchGameEntryRef},
        DatabaseRepository,
    },
    error::Error,
    infra::{
        blocking::BLOCKING_GATEWAY,
        path_authority::{
            classify_probe_error, DatabaseFileTarget, DatabaseHandle, PathOperation,
            ProbeErrorClass,
        },
    },
    progress::{
        handle_running_progress_result, update_progress_with_state, JobProgress, ProgressLease,
        ProgressState,
    },
    AppState, SearchCache, SearchIndexIdentity, SearchResultKey,
};

use super::GameQuery;

#[derive(Debug, Hash, PartialEq, Eq, Clone)]
pub struct ExactData {
    pawn_home: u16,
    position: Chess,
}

#[derive(Debug, Hash, PartialEq, Eq, Clone)]
pub enum PositionQuery {
    Exact(ExactData),
    Partial(Setup),
}

impl PositionQuery {
    pub fn exact_from_fen(fen: &str) -> Result<PositionQuery, Error> {
        let fen = Fen::from_ascii(fen.as_bytes())?;
        let position = database_setup_to_chess(fen.into_setup())?;
        let pawn_home = get_pawn_home(position.board());
        Ok(PositionQuery::Exact(ExactData {
            pawn_home,
            position,
        }))
    }

    pub fn partial_from_fen(fen: &str) -> Result<PositionQuery, Error> {
        let fen = Fen::from_ascii(fen.as_bytes())?;
        Ok(PositionQuery::Partial(fen.into_setup()))
    }
}

#[derive(Debug, Clone, Deserialize, Type, PartialEq, Eq, Hash)]
pub struct PositionQueryJs {
    pub fen: String,
    pub type_: String,
}

fn convert_position_query(query: PositionQueryJs) -> Result<PositionQuery, Error> {
    match query.type_.as_str() {
        "exact" => PositionQuery::exact_from_fen(&query.fen),
        "partial" => PositionQuery::partial_from_fen(&query.fen),
        _ => Err(Error::InvalidInput(format!(
            "unsupported position query type: {}",
            query.type_
        ))),
    }
}

impl PositionQuery {
    fn matches(&self, position: &Chess) -> bool {
        match self {
            PositionQuery::Exact(ref data) => {
                // Exact search matches side-to-move, board layout, castling rights, and en-passant state.
                // Halfmove and fullmove counters are intentionally excluded.
                data.position.turn() == position.turn()
                    && data.position.board() == position.board()
                    && data.position.castles().castling_rights()
                        == position.castles().castling_rights()
                    && data.position.ep_square(EnPassantMode::Legal)
                        == position.ep_square(EnPassantMode::Legal)
            }
            PositionQuery::Partial(ref data) => {
                let query_board = &data.board;
                let tested_board = position.board();

                is_contained(tested_board.pawns(), query_board.pawns())
                    && is_contained(tested_board.knights(), query_board.knights())
                    && is_contained(tested_board.bishops(), query_board.bishops())
                    && is_contained(tested_board.rooks(), query_board.rooks())
                    && is_contained(tested_board.queens(), query_board.queens())
                    && is_contained(tested_board.kings(), query_board.kings())
                    && is_contained(
                        tested_board.by_color(Color::White),
                        query_board.by_color(Color::White),
                    )
                    && is_contained(
                        tested_board.by_color(Color::Black),
                        query_board.by_color(Color::Black),
                    )
            }
        }
    }

    fn is_reachable_by(&self, pawn_home: u16) -> bool {
        match self {
            PositionQuery::Exact(ref data) => is_end_reachable(data.pawn_home, pawn_home),
            PositionQuery::Partial(_) => true,
        }
    }

    fn can_reach(&self, pawn_home: u16) -> bool {
        match self {
            PositionQuery::Exact(ref data) => is_end_reachable(pawn_home, data.pawn_home),
            PositionQuery::Partial(_) => true,
        }
    }
}

/// Returns true if the end pawn structure is reachable
fn is_end_reachable(end: u16, pos: u16) -> bool {
    end & !pos == 0
}

#[cfg(all(test, unix))]
pub(crate) fn load_search_index(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &Arc<SearchCache>,
    handle: &DatabaseHandle,
) -> Result<(SearchIndexIdentity, MmapSearchIndex), Error> {
    load_search_index_cancellable(
        authority,
        repository,
        search_cache,
        handle,
        &CancellationToken::new(),
    )
}

#[cfg(test)]
std::thread_local! {
    pub(super) static AFTER_FAST_IDENTITY_PROBE_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static AFTER_SIDECAR_OPEN_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn run_after_fast_identity_probe_hook() {
    AFTER_FAST_IDENTITY_PROBE_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

/// Loads the search index for `handle`, serving a sidecar only when its archived
/// provenance equals the database identity probed by this call.
///
/// The identity probe is the linearization point, so no re-probe after the sidecar open
/// is added (`d-20260929-03`): the sidecar is opened relative to the retained parent,
/// and every call probes again before any cached index or result is reused, so a later
/// change is seen by the next call. Its object, length, mtime and revision now come from
/// the authority-bound file and its bound SQLite open, so one probe describes one object
/// through an A-B-A leaf swap (`f-20260912-07`, `f-20260929-01`).
pub(crate) fn load_search_index_cancellable(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &Arc<SearchCache>,
    handle: &DatabaseHandle,
    cancellation: &CancellationToken,
) -> Result<(SearchIndexIdentity, MmapSearchIndex), Error> {
    if let Some(service) = authority.collections()? {
        service.resolve_database(authority, handle, PathOperation::DatabaseRead, cancellation)?;
    }
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    // Snapshot before the identity probe for every attempt (plan O3 / d-20261005-06).
    let probe_attempt = || {
        let target = super::resolve_database(authority, handle, PathOperation::DatabaseRead)?;
        let invalidation_snapshot = search_cache.invalidation_snapshot();
        let db_identity = repository.database_identity_expected(
            &target,
            target.identity(),
            Some(cancellation),
        )?;
        let expected_source = IndexSource::from_database_identity(&db_identity)?;
        Ok::<_, Error>((target, invalidation_snapshot, db_identity, expected_source))
    };
    let (read_target, invalidation_snapshot, _, expected_source) = probe_attempt()?;
    #[cfg(test)]
    run_after_fast_identity_probe_hook();
    if let Some((identity, index)) =
        open_valid_preferred(&read_target, &expected_source, cancellation)?
    {
        return cache_loaded_index(
            search_cache,
            identity,
            index,
            invalidation_snapshot,
            cancellation,
        );
    }

    // Different queries for the same database may arrive concurrently. One
    // object-owned lock serializes generation across every authorized spelling.
    let generation_object = read_target.identity();
    let generation_lease = search_cache.generation_lock(&read_target);
    let _generation_guard = generation_lease.lock_cancellable(cancellation)?;

    let (read_target, invalidation_snapshot, db_identity, expected_source) = probe_attempt()?;
    require_generation_object(
        &read_target,
        generation_object,
        "database changed while waiting for search generation",
    )?;
    if let Some((identity, index)) =
        open_valid_preferred(&read_target, &expected_source, cancellation)?
    {
        return cache_loaded_index(
            search_cache,
            identity,
            index,
            invalidation_snapshot,
            cancellation,
        );
    }

    let linked = authority
        .collections()?
        .map(|service| service.is_linked(handle))
        .transpose()?
        .unwrap_or(false);
    let mutate_target = super::resolve_database(
        authority,
        handle,
        if linked {
            PathOperation::DatabaseRead
        } else {
            PathOperation::DatabaseMutate
        },
    )?;
    require_generation_object(
        &mutate_target,
        generation_object,
        "database changed before search generation",
    )?;
    let preferred_leaf = preferred_sidecar_leaf(mutate_target.leaf());
    let legacy_leaf = legacy_sidecar_leaf(mutate_target.leaf());
    search_cache.invalidate_database(&mutate_target);
    promote_legacy_index_sidecar_at(
        mutate_target.parent(),
        &preferred_leaf,
        &legacy_leaf,
        &db_identity,
        cancellation,
    )?;
    if let Some((identity, index)) =
        open_valid_preferred(&mutate_target, &expected_source, cancellation)?
    {
        return cache_loaded_index(
            search_cache,
            identity,
            index,
            invalidation_snapshot,
            cancellation,
        );
    }

    info!("Search index is absent, corrupt, or stale; generating automatically...");
    let generation_error = match super::generate_search_index(
        handle,
        authority,
        repository,
        search_cache,
        cancellation,
    ) {
        Ok(()) => None,
        Err(
            error @ Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::SearchIndexReplacement,
            ),
        ) => Some(error),
        Err(error) => return Err(error),
    };

    let (read_target, invalidation_snapshot, _, expected_source) = probe_attempt()?;
    let Some((identity, index)) =
        open_valid_preferred(&read_target, &expected_source, cancellation)?
    else {
        return Err(generation_error
            .unwrap_or_else(|| Error::Conflict("search index changed while loading".into())));
    };
    // Generation's rename landed; the new sidecar is the only copy. Returning
    // CommittedDurabilityUncertain here would fail a search whose index is now
    // valid. Promotion still returns that error because it must not unlink the
    // last durable (legacy) copy — d-20260831-23.
    cache_loaded_index(
        search_cache,
        identity,
        index,
        invalidation_snapshot,
        cancellation,
    )
}

fn require_generation_object(
    target: &DatabaseFileTarget,
    expected_object: (u64, u64),
    failure_message: &'static str,
) -> Result<(), Error> {
    if target.identity() != expected_object {
        return Err(Error::Conflict(failure_message.into()));
    }
    Ok(())
}

fn open_valid_preferred(
    target: &DatabaseFileTarget,
    expected_source: &IndexSource,
    cancellation: &CancellationToken,
) -> Result<Option<(SearchIndexIdentity, MmapSearchIndex)>, Error> {
    let leaf = preferred_sidecar_leaf(target.leaf());
    let file = match crate::infra::fs::open_regular_at(
        target.parent(),
        &leaf,
        crate::infra::fs::RegularFileAccess::ReadOnly,
    ) {
        Ok(file) => file,
        Err(error) => match classify_probe_error(&error, target.parent(), &leaf) {
            ProbeErrorClass::NotFound | ProbeErrorClass::Reparse => return Ok(None),
            ProbeErrorClass::Malformed => return Ok(None),
            ProbeErrorClass::WrongKind | ProbeErrorClass::MappedFile | ProbeErrorClass::Other => {
                return Err(error)
            }
        },
    };
    #[cfg(test)]
    AFTER_SIDECAR_OPEN_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
    let identity =
        SearchIndexIdentity::from_opened_sidecar(target, expected_source.clone(), &file)?;
    let index = match MmapSearchIndex::open_file_cancellable(file, cancellation) {
        Ok(index) => index,
        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::InvalidData => {
            return Ok(None)
        }
        Err(error) => return Err(error),
    };
    Ok((index.source() == expected_source).then_some((identity, index)))
}

#[cfg(all(test, unix))]
pub(crate) fn ownership_preferred_probe(
    target: &DatabaseFileTarget,
    source: &IndexSource,
) -> Result<(), Error> {
    open_valid_preferred(target, source, &CancellationToken::new()).map(|_| ())
}

fn cache_loaded_index(
    search_cache: &SearchCache,
    identity: SearchIndexIdentity,
    index: MmapSearchIndex,
    invalidation_snapshot: u64,
    cancellation: &CancellationToken,
) -> Result<(SearchIndexIdentity, MmapSearchIndex), Error> {
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    let index = search_cache.insert_index(identity.clone(), index, invalidation_snapshot);
    Ok((identity, index))
}

/// Returns true if the subset is contained in the container
fn is_contained(container: Bitboard, subset: Bitboard) -> bool {
    container & subset == subset
}

// Date interval containment: a shaped PGN date with a known year matches when its earliest
// possible date >= start and latest <= end. Unknown years fail bounded queries,
// unknown month/day components span 01..12/31, and other shapes stay lexical.
fn matches_date(date: Option<&str>, start: Option<&str>, end: Option<&str>) -> bool {
    if start.is_none() && end.is_none() {
        return true;
    }
    let Some(date) = date else {
        return false;
    };
    let bytes = date.as_bytes();
    let is_pgn_date = bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                *byte == b'.'
            } else {
                byte.is_ascii_digit() || *byte == b'?'
            }
        });
    if !is_pgn_date {
        return start.is_none_or(|bound| date >= bound) && end.is_none_or(|bound| date <= bound);
    }
    if bytes[..4].contains(&b'?') {
        return false;
    }

    let mut earliest = *b"0000.00.00";
    earliest.copy_from_slice(bytes);
    let mut latest = earliest;
    for (range, last) in [(5..7, b"12"), (8..10, b"31")] {
        if bytes[range.clone()].contains(&b'?') {
            earliest[range.clone()].copy_from_slice(b"01");
            latest[range].copy_from_slice(last);
        }
    }
    start.is_none_or(|bound| earliest.as_slice() >= bound.as_bytes())
        && end.is_none_or(|bound| latest.as_slice() <= bound.as_bytes())
}

pub(super) fn date_interval_endpoint_sql(
    latest: bool,
) -> diesel::expression::SqlLiteral<
    diesel::sql_types::Nullable<diesel::sql_types::Text>,
    impl diesel::query_builder::QueryFragment<diesel::sqlite::Sqlite> + Clone + Send,
> {
    let (month, day) = if latest { ("12", "31") } else { ("01", "01") };
    diesel::dsl::sql(
        r#"CASE WHEN length(CAST("Games"."Date" AS BLOB)) = 10
            AND "Games"."Date" GLOB '[0-9?][0-9?][0-9?][0-9?].[0-9?][0-9?].[0-9?][0-9?]'
        THEN CASE WHEN instr(substr("Games"."Date", 1, 4), '?') > 0 THEN NULL
            ELSE substr("Games"."Date", 1, 4) || '.' ||
                CASE WHEN instr(substr("Games"."Date", 6, 2), '?') > 0
                    THEN "#,
    )
    .bind::<diesel::sql_types::Text, _>(month)
    .sql(
        r#" ELSE substr("Games"."Date", 6, 2) END || '.' ||
                CASE WHEN instr(substr("Games"."Date", 9, 2), '?') > 0
                    THEN "#,
    )
    .bind::<diesel::sql_types::Text, _>(day)
    .sql(
        r#" ELSE substr("Games"."Date", 9, 2) END
            END
        ELSE "Games"."Date" END"#,
    )
}

/// Inclusive Elo bound. The index stores a missing rating as 0, so a band
/// starting above 0 excludes unrated players.
fn elo_in_range(elo: i16, range: Option<(i32, i32)>) -> bool {
    let elo = i32::from(elo);
    range.is_none_or(|(min, max)| elo >= min && elo <= max)
}

/// Case-insensitive event-name substrings of fast events. Rapid is kept on purpose.
const FAST_EVENT_NAME_TOKENS: [&str; 3] = ["blitz", "bullet", "armageddon"];

#[cfg(test)]
thread_local! {
    // Per thread, not per process: search_position_blocking reads it on the calling test's
    // thread, so a parallel search test cannot count into an instrumented test's counters.
    static SEARCH_POSITION_INSTRUMENT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
// Taken only by `mod tests`, which is unix-only; `cfg(test)` alone is dead code on Windows.
#[cfg(all(test, unix))]
static SEARCH_POSITION_INSTRUMENT_LOCK: Mutex<()> = Mutex::new(());
#[cfg(test)]
static PROCESS_ENTRY_CALLS: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
static EXCLUDE_FAST_SQL_COMPLETED: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
type ExcludeFastLoadHook = Box<dyn FnOnce() -> Option<Result<HashSet<i32>, Error>>>;

#[cfg(test)]
thread_local! {
    // Runs at the start of load_excluded_fast_game_ids, inside the SQLite
    // cancellation scope. Some(result) replaces the whole load.
    static EXCLUDE_FAST_LOAD_HOOK: std::cell::RefCell<Option<ExcludeFastLoadHook>> =
        const { std::cell::RefCell::new(None) };
}

/// Ids of games whose event name contains a fast-event token. Runs as the
/// entire body of one `with_sqlite_cancellation` scope.
fn load_excluded_fast_game_ids(db: &mut SqliteConnection) -> Result<HashSet<i32>, Error> {
    #[cfg(test)]
    if let Some(result) = EXCLUDE_FAST_LOAD_HOOK
        .with(|hook| hook.borrow_mut().take())
        .and_then(|hook| hook())
    {
        return result;
    }
    let mut fast_events = events::table.select(events::id).into_boxed();
    for token in FAST_EVENT_NAME_TOKENS {
        fast_events = fast_events.or_filter(events::name.like(format!("%{token}%")));
    }
    let ids: Vec<i32> = games::table
        .filter(games::event_id.eq_any(fast_events))
        .select(games::id)
        .load(db)?;
    Ok(ids.into_iter().collect())
}

fn parse_wanted_result(value: Option<&str>) -> Result<Option<GameResult>, Error> {
    value
        .map(|value| match value {
            "any" => Ok(None),
            "whitewon" => Ok(Some(GameResult::WhiteWin)),
            "blackwon" => Ok(Some(GameResult::BlackWin)),
            "draw" => Ok(Some(GameResult::Draw)),
            _ => Err(Error::InvalidInput(format!(
                "unsupported result filter: {value}"
            ))),
        })
        .transpose()
        .map(Option::flatten)
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct PositionStats {
    #[serde(rename = "move")]
    pub move_: String,
    pub white: i32,
    pub draw: i32,
    pub black: i32,
}

fn invalid_move_stream(game_id: i32, error: Error) -> Error {
    match error {
        Error::Cancellation => Error::Cancellation,
        error => Error::InvalidInput(format!("game {game_id} has invalid move stream: {error}")),
    }
}

fn matched_position_continuation(
    game_id: i32,
    chess: Chess,
    next_byte: Option<u8>,
) -> Result<String, Error> {
    let Some(next_byte) = next_byte else {
        return Ok("*".to_string());
    };
    let next_move = decode_move(next_byte, &chess).ok_or_else(|| {
        Error::InvalidInput(format!(
            "game {game_id} has illegal encoded move {next_byte}"
        ))
    })?;
    let san = SanPlus::from_move(chess, &next_move);
    Ok(san.to_string())
}

fn get_move_after_match(
    game_id: i32,
    move_blob: &[u8],
    fen: &Option<&str>,
    query: &PositionQuery,
    cancellation: &CancellationToken,
) -> Result<Option<String>, Error> {
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    let mut chess = if let Some(fen) = fen {
        let fen = Fen::from_ascii(fen.as_bytes()).map_err(|error| {
            Error::InvalidInput(format!("game {game_id} has invalid FEN: {error}"))
        })?;
        database_setup_to_chess(fen.into_setup()).map_err(|error| {
            Error::InvalidInput(format!("game {game_id} has invalid FEN setup: {error}"))
        })?
    } else {
        Chess::default()
    };

    if query.matches(&chess) {
        let mut mainline = try_iter_mainline_move_bytes_cancellable(move_blob, cancellation)
            .map_err(|error| invalid_move_stream(game_id, error))?
            .peekable();
        return matched_position_continuation(game_id, chess, mainline.peek().copied()).map(Some);
    }

    let mut mainline = try_iter_mainline_move_bytes_cancellable(move_blob, cancellation)
        .map_err(|error| invalid_move_stream(game_id, error))?
        .peekable();

    while let Some(byte) = mainline.next() {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let m = decode_move(byte, &chess).ok_or_else(|| {
            Error::InvalidInput(format!("game {game_id} has illegal encoded move {byte}"))
        })?;
        chess.play_unchecked(&m);

        let is_irreversible =
            m.is_capture() || m.role() == shakmaty::Role::Pawn || m.is_promotion();

        if is_irreversible {
            let board = chess.board();
            if !query.is_reachable_by(get_pawn_home(board)) {
                return Ok(None);
            }
        }
        if query.matches(&chess) {
            return matched_position_continuation(game_id, chess, mainline.peek().copied())
                .map(Some);
        }
    }
    Ok(None)
}

fn search_progress_percent(processed: usize, total: usize) -> f32 {
    if total == 0 {
        return 0.0;
    }
    (processed as f64 / total as f64 * 100.0) as f32
}

#[tauri::command]
#[specta::specta]
pub async fn search_position(
    file: DatabaseHandle,
    query: GameQuery,
    app: tauri::AppHandle,
    tab_id: String,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(Vec<PositionStats>, Vec<NormalizedGame>), Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "search_position")?;
    let cancellation = operation.token();
    let progress = JobProgress::new(app.clone(), tab_id)?;
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    let search_cache = Arc::clone(&state.search_cache);
    let new_request = state.new_request.clone();
    let lease = progress.lease();
    let worker_app = app.clone();
    crate::infra::operations::run_native_operation(operation, "search_position", async move {
        let permit = acquire_search_request(new_request, &cancellation).await?;
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                let result = search_position_blocking(
                    &authority,
                    &repository,
                    &search_cache,
                    permit,
                    lease,
                    worker_app,
                    file,
                    query,
                    token,
                    #[cfg(test)]
                    None,
                );
                progress.complete(match &result {
                    Ok(_) => ProgressState::Succeeded,
                    Err(Error::Cancellation) => ProgressState::Cancelled,
                    Err(_) => ProgressState::Failed,
                });
                result
            })
            .await
    })
    .await
}

async fn acquire_search_request(
    new_request: Arc<tokio::sync::Semaphore>,
    cancellation: &CancellationToken,
) -> Result<OwnedSemaphorePermit, Error> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(Error::Cancellation),
        permit = new_request.acquire_owned() => {
            permit.map_err(|_| Error::Conflict("position search permit unavailable".into()))
        }
    }
}

const POSITION_SEARCH_PROGRESS_INTERVAL: usize = 50_000;

// Individual Arc handles the closure must own: BlockingGateway::spawn is
// `'static` and AppState is not Clone. A bundle type was rejected (plan
// decision D-B).
#[allow(clippy::too_many_arguments)]
pub(super) fn search_position_blocking<R: tauri::Runtime>(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &Arc<SearchCache>,
    permit: OwnedSemaphorePermit,
    lease: ProgressLease,
    app: tauri::AppHandle<R>,
    file: DatabaseHandle,
    query: GameQuery,
    cancellation: &CancellationToken,
    #[cfg(test)] progress_update: Option<&ProgressUpdateHook<'_>>,
) -> Result<(Vec<PositionStats>, Vec<NormalizedGame>), Error> {
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    #[cfg(test)]
    let instrument = SEARCH_POSITION_INSTRUMENT.get();
    // Omitted and explicit false are the same query and must share a cache key.
    let mut query = query;
    if query.exclude_fast_events == Some(false) {
        query.exclude_fast_events = None;
    }
    let database_handle = file;
    let target = super::resolve_database(authority, &database_handle, PathOperation::DatabaseRead)?;
    let collision_lease = search_cache.collision_lock(query.clone(), &target);
    let _guard = collision_lease.lock_cancellable(cancellation)?;

    let mut database_connection = get_db_or_create(
        repository,
        &target,
        Some(cancellation),
        authority,
        &database_handle,
    )?;
    let db = &mut *database_connection;

    let start = Instant::now();
    info!("start loading games");

    let (identity, mmap_index) = load_search_index_cancellable(
        authority,
        repository,
        search_cache,
        &database_handle,
        cancellation,
    )?;
    let cache_key = SearchResultKey::new(query.clone(), identity);
    db.transaction::<_, Error, _>(|db| {
        if super::repository::read_data_revision(db)? != mmap_index.source().revision {
            return Err(Error::StaleGame);
        }
        let admitted_generation =
            super::linked_collections::linked_metadata(db)?.map(|(generation, _)| generation);
        if let Some(result) = search_cache.get_result(&cache_key) {
            if let Some(service) = authority.collections()? {
                service.validate_result(authority, &database_handle, &admitted_generation)?;
            }
            return Ok(result);
        }

        let game_count = mmap_index.len();

        info!(
            "Ready to search {} games: {:?}",
            game_count,
            start.elapsed()
        );

        let openings: DashMap<String, PositionStats> = DashMap::new();
        const MAX_SAMPLES: usize = 500;
        // Min-heap of (elo_key, game_id) to track top-rated sample games.
        // Using Reverse so peek() returns the entry with the lowest ELO,
        // which we can evict when a higher-rated game is found.
        let top_games: Mutex<BinaryHeap<Reverse<(i16, i32)>>> =
            Mutex::new(BinaryHeap::with_capacity(MAX_SAMPLES + 1));

        let processed = AtomicUsize::new(0);
        let progress_error_diagnosed = AtomicBool::new(false);

        let parsed_position_query: Option<PositionQuery> = if let Some(pq) = &query.position {
            Some(convert_position_query(pq.clone())?)
        } else {
            None
        };

        let wanted_result = parse_wanted_result(query.wanted_result.as_deref())?;

        let excluded_fast_game_ids: Option<HashSet<i32>> = if query.exclude_fast_events
            == Some(true)
        {
            let ids = super::sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
                load_excluded_fast_game_ids(db)
            })?;
            #[cfg(test)]
            if instrument {
                EXCLUDE_FAST_SQL_COMPLETED.store(true, Ordering::SeqCst);
            }
            Some(ids)
        } else {
            None
        };

        info!("start search on {}", lease.id);

        let process_entry = |entry: SearchGameEntryRef<'_>| -> Result<(), Error> {
            #[cfg(test)]
            if instrument {
                PROCESS_ENTRY_CALLS.fetch_add(1, Ordering::SeqCst);
            }
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            let index = processed.fetch_add(1, Ordering::Relaxed) + 1;
            if index.is_multiple_of(POSITION_SEARCH_PROGRESS_INTERVAL) {
                let percent = search_progress_percent(index, game_count);
                let report_progress = || {
                    update_progress_with_state(
                        &app.state::<AppState>().progress_state,
                        &app,
                        &lease,
                        percent,
                        ProgressState::Running,
                    )
                };
                #[cfg(test)]
                let progress_result = progress_update
                    .and_then(|update| update(&lease, percent))
                    .unwrap_or_else(report_progress);
                #[cfg(not(test))]
                let progress_result = report_progress();
                handle_running_progress_result(
                    progress_result,
                    "position search",
                    &lease,
                    &progress_error_diagnosed,
                    Some(cancellation),
                )?;
            }

            try_iter_mainline_move_bytes_cancellable(entry.moves, cancellation)
                .map_err(|error| invalid_move_stream(entry.id, error))?;

            if let Some(white) = query.player1 {
                if white != entry.white_id {
                    return Ok(());
                }
            }

            if let Some(black) = query.player2 {
                if black != entry.black_id {
                    return Ok(());
                }
            }

            if let Some(wanted) = wanted_result {
                if entry.result != wanted {
                    return Ok(());
                }
            } else if matches!(entry.result, GameResult::None | GameResult::Other) {
                // Unknown and non-standard results are neither draws nor wins.
                // PositionStats has no unknown bucket, so omit them explicitly.
                return Ok(());
            }

            if !matches_date(
                entry.date,
                query.start_date.as_deref(),
                query.end_date.as_deref(),
            ) {
                return Ok(());
            }

            // range1 bounds White and range2 bounds Black in position search.
            if !elo_in_range(entry.white_elo, query.range1)
                || !elo_in_range(entry.black_elo, query.range2)
            {
                return Ok(());
            }

            if excluded_fast_game_ids
                .as_ref()
                .is_some_and(|ids| ids.contains(&entry.id))
            {
                return Ok(());
            }

            if let Some(position_query) = &parsed_position_query {
                if position_query.can_reach(entry.pawn_home) {
                    if let Some(m) = get_move_after_match(
                        entry.id,
                        entry.moves,
                        &entry.fen,
                        position_query,
                        cancellation,
                    )? {
                        let elo_key = entry.white_elo.max(entry.black_elo);
                        let mut heap = top_games.lock().unwrap();
                        if heap.len() < MAX_SAMPLES {
                            heap.push(Reverse((elo_key, entry.id)));
                        } else if let Some(&Reverse((min_elo, _))) = heap.peek() {
                            if elo_key > min_elo {
                                heap.pop();
                                heap.push(Reverse((elo_key, entry.id)));
                            }
                        }
                        drop(heap);

                        openings
                            .entry(m)
                            .and_modify(|opening| match entry.result {
                                GameResult::WhiteWin => opening.white += 1,
                                GameResult::BlackWin => opening.black += 1,
                                GameResult::Draw => opening.draw += 1,
                                GameResult::Other | GameResult::None => {}
                            })
                            .or_insert_with(|| PositionStats {
                                black: i32::from(entry.result == GameResult::BlackWin),
                                white: i32::from(entry.result == GameResult::WhiteWin),
                                draw: i32::from(entry.result == GameResult::Draw),
                                move_: String::new(),
                            });
                    }
                }
            }
            Ok(())
        };

        mmap_index.par_iter().try_for_each(process_entry)?;

        let openings: Vec<PositionStats> = openings
            .into_iter()
            .map(|(k, mut v)| {
                v.move_ = k;
                v
            })
            .collect();
        let ids: Vec<i32> = top_games
            .into_inner()
            .unwrap()
            .into_iter()
            .map(|Reverse((_, id))| id)
            .collect();

        info!("finished search in {:?}", start.elapsed());

        let (white_players, black_players) = diesel::alias!(players as white, players as black);
        let games: Vec<(Game, Player, Player, Event, Site)> =
            super::sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
                games::table
                    .inner_join(
                        white_players.on(games::white_id.eq(white_players.field(players::id))),
                    )
                    .inner_join(
                        black_players.on(games::black_id.eq(black_players.field(players::id))),
                    )
                    .inner_join(events::table.on(games::event_id.eq(events::id)))
                    .inner_join(sites::table.on(games::site_id.eq(sites::id)))
                    .filter(games::id.eq_any(ids))
                    .order((games::white_elo.desc(), games::black_elo.desc()))
                    .load(db)
            })?;
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let mut normalized_games = normalize_games(games, cancellation)?;
        super::linked_collections::qualify_games(
            db,
            &database_handle,
            authority,
            &mut normalized_games,
        )?;
        if let Some(service) = authority.collections()? {
            service.validate_result(authority, &database_handle, &admitted_generation)?;
        }
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        search_cache.insert_result(cache_key, (openings.clone(), normalized_games.clone()));

        drop(permit);

        Ok((openings, normalized_games))
    })
}

#[cfg(all(test, unix))]
pub fn is_position_in_db(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &Arc<SearchCache>,
    file: &DatabaseHandle,
    query: &GameQuery,
) -> Result<bool, Error> {
    is_position_in_db_cancellable(
        authority,
        repository,
        search_cache,
        file,
        query,
        &CancellationToken::new(),
    )
}

pub(crate) fn is_position_in_db_cancellable(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &Arc<SearchCache>,
    file: &DatabaseHandle,
    query: &GameQuery,
    cancellation: &CancellationToken,
) -> Result<bool, Error> {
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    let database_handle = file;
    let target = super::resolve_database(authority, database_handle, PathOperation::DatabaseRead)?;
    let collision_lease = search_cache.collision_lock(query.clone(), &target);
    let _guard = collision_lease.lock_cancellable(cancellation)?;

    let parsed_position_query: Option<PositionQuery> = if let Some(pq) = &query.position {
        Some(convert_position_query(pq.clone())?)
    } else {
        None
    };

    let start = Instant::now();
    info!("start loading games for is_position_in_db");

    let (_identity, mmap_index) = load_search_index_cancellable(
        authority,
        repository,
        search_cache,
        database_handle,
        cancellation,
    )?;
    // Presence checks occurrences. Nonempty explorer statistics prove an occurrence,
    let service = authority.collections()?;
    let admitted = service
        .as_ref()
        .map(|service| service.query_generation(authority, file))
        .transpose()?
        .flatten();
    if admitted
        .as_ref()
        .is_some_and(|(_, revision)| *revision != mmap_index.source().revision)
    {
        return Err(Error::StaleGame);
    }
    // but empty statistics can reflect outcome or other filters and cannot prove absence.
    // Presence therefore uses its own occurrence scan.

    let exists = AtomicBool::new(false);
    let check_entry = |entry: SearchGameEntryRef<'_>| -> Result<(), Error> {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        try_iter_mainline_move_bytes_cancellable(entry.moves, cancellation)
            .map_err(|error| invalid_move_stream(entry.id, error))?;
        if let Some(position_query) = &parsed_position_query {
            if position_query.can_reach(entry.pawn_home)
                && get_move_after_match(
                    entry.id,
                    entry.moves,
                    &entry.fen,
                    position_query,
                    cancellation,
                )?
                .is_some()
            {
                exists.store(true, Ordering::Relaxed);
            }
        }
        Ok(())
    };

    mmap_index.par_iter().try_for_each(check_entry)?;
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    let exists = exists.load(Ordering::Relaxed);

    info!("finished search in {:?}", start.elapsed());

    if let Some(service) = service {
        service.validate_result(authority, file, &admitted.map(|(generation, _)| generation))?;
    }
    Ok(exists)
}

#[cfg(test)]
fn mount_progress_test_events(app: &impl tauri::Manager<tauri::test::MockRuntime>) {
    tauri_specta::Builder::<tauri::test::MockRuntime>::new()
        .events(tauri_specta::collect_events!(
            crate::progress::ProgressEvent
        ))
        .mount_events(app);
}

#[cfg(test)]
mod descriptor_identity_tests {
    use super::*;
    use crate::db::{legacy_index_path, SearchIndexChunk};
    use crate::infra::path_authority::opened_file_identity;

    pub(super) fn preferred_sidecar_test_case(
        file_stem: &str,
        operations: Vec<PathOperation>,
        archive: SearchIndexChunk,
    ) -> (
        tempfile::TempDir,
        tauri::AppHandle<tauri::test::MockRuntime>,
        DatabaseHandle,
        std::path::PathBuf,
        DatabaseFileTarget,
        IndexSource,
    ) {
        let (dir, app, handle, database) =
            super::super::schema_database_case(file_stem, operations);
        let state = app.state::<AppState>();
        let target = super::super::resolve_database(
            &state.pgn_path_authority,
            &handle,
            PathOperation::DatabaseRead,
        )
        .unwrap();
        let database_identity = state
            .database_repository
            .database_identity_expected(&target, target.identity(), None)
            .unwrap();
        let source = IndexSource::from_database_identity(&database_identity).unwrap();
        archive
            .write_to_with_source(get_index_path(&database), source.clone())
            .unwrap()
            .expect_durable();
        (dir, app, handle, database, target, source)
    }

    fn descriptor_fixture() -> (
        tempfile::TempDir,
        tauri::AppHandle<tauri::test::MockRuntime>,
        DatabaseHandle,
        DatabaseFileTarget,
        IndexSource,
    ) {
        let (dir, app, handle, _database, target, source) = preferred_sidecar_test_case(
            "descriptor",
            vec![PathOperation::DatabaseRead, PathOperation::DatabaseMutate],
            SearchIndexChunk::default(),
        );
        (dir, app, handle, target, source)
    }

    #[test]
    fn generation_object_agreement_accepts_equal_authority_bound_objects() {
        let (_dir, app, handle, target, _source) = descriptor_fixture();
        let state = app.state::<AppState>();
        let resolved = super::super::resolve_database(
            &state.pgn_path_authority,
            &handle,
            PathOperation::DatabaseRead,
        )
        .unwrap();
        assert_eq!(resolved.identity(), target.identity());
        for failure_message in [
            "database changed while waiting for search generation",
            "database changed before search generation",
        ] {
            assert!(
                require_generation_object(&resolved, target.identity(), failure_message).is_ok()
            );
        }
    }

    fn assert_generation_object_rejected(expected_message: &'static str) {
        let (_dir, _app, _handle, target, _source) = descriptor_fixture();
        let (_other_dir, _other_app, _other_handle, other_target, _other_source) =
            descriptor_fixture();
        assert_ne!(other_target.identity(), target.identity());

        let result = require_generation_object(&other_target, target.identity(), expected_message);
        assert!(matches!(result, Err(Error::Conflict(message))
            if message == expected_message));
    }

    #[test]
    fn generation_object_agreement_rejects_different_object_after_wait() {
        assert_generation_object_rejected("database changed while waiting for search generation");
    }

    #[test]
    fn generation_object_agreement_rejects_different_object_before_generation() {
        assert_generation_object_rejected("database changed before search generation");
    }

    #[test]
    fn descriptor_identity_and_mapping_retain_the_opened_preferred_object_after_replacement() {
        let (_dir, _app, _handle, target, source) = descriptor_fixture();
        let preferred = get_index_path(target.path());
        let original = std::fs::File::open(&preferred).unwrap();
        let original_object = opened_file_identity(&original).unwrap();
        let original_metadata = original.metadata().unwrap();
        let replacement = preferred.with_file_name("replacement.ecsi");
        let mut replacement_source = source.clone();
        replacement_source.revision += 1;
        SearchIndexChunk::default()
            .write_to_with_source(&replacement, replacement_source.clone())
            .unwrap()
            .expect_durable();
        std::fs::File::options()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(
                std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1),
            ))
            .unwrap();
        assert_ne!(
            original_metadata.modified().unwrap(),
            std::fs::metadata(&replacement).unwrap().modified().unwrap()
        );
        let replacement_object =
            opened_file_identity(&std::fs::File::open(&replacement).unwrap()).unwrap();
        assert_ne!(original_object, replacement_object);
        let preferred_for_hook = preferred.clone();
        AFTER_SIDECAR_OPEN_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                std::fs::rename(&replacement, &preferred_for_hook).unwrap();
            }));
        });
        let (identity, index) = open_valid_preferred(&target, &source, &CancellationToken::new())
            .unwrap()
            .unwrap();
        assert_eq!(
            identity.sidecar_object, original_object,
            "identity must stamp the opened descriptor A"
        );
        assert_ne!(
            identity.sidecar_object, replacement_object,
            "identity must not stamp replacement B"
        );
        assert_eq!(identity.length, original_metadata.len());
        assert_eq!(
            identity.modified,
            original_metadata
                .modified()
                .unwrap()
                .duration_since(std::time::SystemTime::UNIX_EPOCH)
                .unwrap()
        );
        assert_eq!(
            identity.parent_object,
            crate::search_parent_identity(&target).unwrap()
        );
        assert_eq!(index.source(), &source, "mapping must retain A's bytes");
        assert_eq!(
            MmapSearchIndex::open(&preferred).unwrap().source(),
            &replacement_source
        );
    }

    fn descriptor_failure_fixture() -> (
        tempfile::TempDir,
        tauri::AppHandle<tauri::test::MockRuntime>,
        DatabaseHandle,
        DatabaseFileTarget,
        IndexSource,
    ) {
        let fixture = descriptor_fixture();
        let (_, _, _, target, source) = &fixture;
        SearchIndexChunk::default()
            .write_to_with_source(legacy_index_path(target.path()), source.clone())
            .unwrap()
            .expect_durable();
        fixture
    }

    #[test]
    fn descriptor_stamp_failure_propagates_from_open_without_legacy_fallback() {
        let (_dir, _app, _handle, target, source) = descriptor_failure_fixture();
        crate::FAIL_NEXT_SIDECAR_STAMP.with(|fail| fail.set(true));
        let opened = open_valid_preferred(&target, &source, &CancellationToken::new());
        assert!(
            matches!(opened, Err(Error::Io(ref error)) if error.to_string() == "injected sidecar descriptor stamp failure"),
            "descriptor stamp failure must propagate from open_valid_preferred: {opened:?}"
        );
        assert!(
            open_valid_preferred(&target, &source, &CancellationToken::new())
                .unwrap()
                .is_some(),
            "fault injection must fail only once"
        );
    }

    #[test]
    fn descriptor_stamp_failure_propagates_from_loader_without_cache_publication() {
        let (_dir, app, handle, _target, _source) = descriptor_failure_fixture();
        crate::FAIL_NEXT_SIDECAR_STAMP.with(|fail| fail.set(true));
        let state = app.state::<AppState>();
        let loaded = load_search_index_cancellable(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
            &CancellationToken::new(),
        );
        assert!(
            matches!(loaded, Err(Error::Io(ref error)) if error.to_string() == "injected sidecar descriptor stamp failure"),
            "descriptor stamp failure must propagate from the loader: {loaded:?}"
        );
        assert_eq!(
            state.search_cache.cached_index_count(),
            0,
            "failed descriptor stamp must not publish an index"
        );
        assert!(
            state.search_cache.results.lock().unwrap().values.is_empty(),
            "failed descriptor stamp must not publish results"
        );
    }
}

#[cfg(test)]
mod progress_error_tests {
    use super::*;
    use crate::db::{SearchGameEntry, SearchIndexChunk};
    use crate::error::LogCaptureScope;
    use crate::progress::ProgressStore;

    fn checkpoint_fixture(
        count: usize,
    ) -> (
        tempfile::TempDir,
        tauri::AppHandle<tauri::test::MockRuntime>,
        DatabaseHandle,
    ) {
        // Only the first entry matches the player filter. The rest cheaply exercise
        // real Rayon checkpoints without inserting thousands of database rows.
        let entries = (0..count)
            .map(|index| SearchGameEntry {
                id: i32::try_from(index + 1).unwrap(),
                white_id: i32::from(index == 0),
                black_id: 0,
                date: None,
                result: GameResult::Draw,
                pawn_home: 0,
                white_material: 0,
                black_material: 0,
                white_elo: 0,
                black_elo: 0,
                fen: None,
                moves: vec![],
            })
            .collect();
        let (dir, app, handle, database, target, _source) =
            super::descriptor_identity_tests::preferred_sidecar_test_case(
                "progress-checkpoint",
                vec![PathOperation::DatabaseRead, PathOperation::DatabaseMutate],
                SearchIndexChunk::default(),
            );
        // Pool initialization enables WAL and changes database freshness. Archive
        // provenance only after that initialization so the core serves this index.
        let state = app.state::<AppState>();
        drop(
            get_db_or_create(
                &state.database_repository,
                &target,
                None,
                &state.pgn_path_authority,
                &handle,
            )
            .unwrap(),
        );
        let identity = state
            .database_repository
            .database_identity_expected(&target, target.identity(), None)
            .unwrap();
        SearchIndexChunk { entries }
            .write_to_with_source(
                get_index_path(&database),
                IndexSource::from_database_identity(&identity).unwrap(),
            )
            .unwrap()
            .expect_durable();
        mount_progress_test_events(&app);
        (dir, app, handle)
    }

    fn run_checkpoint_search(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        handle: DatabaseHandle,
        lease: ProgressLease,
        cancellation: &CancellationToken,
        progress_update: &ProgressUpdateHook<'_>,
    ) -> Result<(Vec<PositionStats>, Vec<NormalizedGame>), Error> {
        let state = app.state::<AppState>();
        let mut query = GameQuery::new().position(PositionQueryJs {
            fen: Fen::from_position(Chess::default(), EnPassantMode::Legal).to_string(),
            type_: "exact".into(),
        });
        query.player1 = Some(1);
        search_position_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            state.new_request.clone().try_acquire_owned().unwrap(),
            lease,
            app.clone(),
            handle,
            query,
            cancellation,
            Some(progress_update),
        )
    }

    #[test]
    fn production_checkpoint_revoked_lease_cancels_without_publishing_results() {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .unwrap();
        pool.install(|| {
            for clear in [false, true] {
                let capture = LogCaptureScope::start();
                let (_dir, app, handle) = checkpoint_fixture(100_000);
                let state = app.state::<AppState>();
                let progress = JobProgress::new(app.clone(), "revoked-search".into()).unwrap();
                let lease = progress.lease();
                let newer = Mutex::new(None);
                let checkpoints = AtomicUsize::new(0);
                let revoke = |old: &ProgressLease, _percent: f32| {
                    if checkpoints.fetch_add(1, Ordering::SeqCst) == 0 {
                        if clear {
                            state.progress_state.clear(&old.id).unwrap();
                        }
                        let replacement = state.progress_state.start(old.id.clone()).unwrap();
                        state
                            .progress_state
                            .transition(&replacement, 17.0, ProgressState::Running)
                            .unwrap();
                        *newer.lock().unwrap() = state.progress_state.get(&old.id).unwrap();
                    }
                    // Let the actual typed production update reject the stale lease.
                    None
                };
                let cancellation = CancellationToken::new();
                let result =
                    run_checkpoint_search(&app, handle, lease.clone(), &cancellation, &revoke);
                assert!(
                    matches!(result, Err(Error::Cancellation)),
                    "revoked search must return Cancellation, got error {:?}",
                    result.as_ref().err()
                );
                assert!(
                    cancellation.is_cancelled(),
                    "Rayon sibling token must be cancelled"
                );
                assert!((1..=2).contains(&checkpoints.load(Ordering::SeqCst)));
                assert!(state.search_cache.results.lock().unwrap().values.is_empty());
                assert!(capture
                    .records()
                    .iter()
                    .all(|record| record.level != log::Level::Error));
                progress.complete(ProgressState::Cancelled);
                drop(progress);
                let current = state.progress_state.get(&lease.id).unwrap();
                assert_eq!(current, *newer.lock().unwrap());
                assert!(current.unwrap().generation > lease.generation);
            }
        });
    }

    #[test]
    fn production_checkpoint_delivery_failures_diagnose_once_and_publish_results() {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .unwrap();
        pool.install(|| {
            for store_failure in [false, true] {
                let capture = LogCaptureScope::start();
                let (_dir, app, handle) = checkpoint_fixture(100_000);
                let state = app.state::<AppState>();
                let progress = JobProgress::new(app.clone(), "best-effort-search".into()).unwrap();
                let lease = progress.lease();
                let checkpoints = AtomicUsize::new(0);
                let checkpoint_percentages = Mutex::new(Vec::new());
                let fail = |lease: &ProgressLease, percent: f32| {
                    checkpoints.fetch_add(1, Ordering::SeqCst);
                    checkpoint_percentages.lock().unwrap().push(percent);
                    Some(if store_failure {
                        Err(Error::Conflict("injected progress store failure".into()))
                    } else {
                        // An emitter fails after the store has accepted the transition.
                        state
                            .progress_state
                            .transition(lease, percent, ProgressState::Running)
                            .unwrap();
                        Err(Error::Tauri(Box::new(tauri::Error::Io(
                            std::io::Error::other("injected native emitter failure"),
                        ))))
                    })
                };
                let cancellation = CancellationToken::new();
                let (stats, games) =
                    run_checkpoint_search(&app, handle, lease.clone(), &cancellation, &fail)
                        .unwrap();
                assert!(!cancellation.is_cancelled());
                assert_eq!(
                    checkpoints.load(Ordering::SeqCst),
                    2,
                    "keep the 50,000-game cadence"
                );
                assert_eq!(
                    *checkpoint_percentages.lock().unwrap(),
                    [50.0, 100.0],
                    "checkpoints must report 50 and 100 percent over 100,000 entries"
                );
                assert_eq!(stats.len(), 1);
                assert_eq!(stats[0].move_, "*");
                assert_eq!(stats[0].draw, 1);
                assert!(games.is_empty());
                let cache = state.search_cache.results.lock().unwrap();
                assert_eq!(
                    cache.values.len(),
                    1,
                    "successful results must be published"
                );
                drop(cache);
                let diagnostics: Vec<_> = capture
                    .records()
                    .into_iter()
                    .filter(|record| record.level == log::Level::Error)
                    .collect();
                assert_eq!(
                    diagnostics.len(),
                    1,
                    "checkpoint failures must emit exactly one native ERROR record per search"
                );
                assert!(diagnostics[0]
                    .message
                    .contains("position search progress update failed"));
                assert!(diagnostics[0].message.contains(&lease.id));
                assert!(diagnostics[0]
                    .message
                    .contains(&format!("generation {}", lease.generation)));
                assert!(diagnostics[0].message.contains(if store_failure {
                    "injected progress store failure"
                } else {
                    "injected native emitter failure"
                }));
            }
        });
    }

    #[test]
    fn progress_error_policy_cancels_stale_even_after_a_delivery_diagnostic() {
        let store = ProgressStore::default();
        let lease = store.start("policy".into()).unwrap();
        let cancellation = CancellationToken::new();
        let diagnosed = AtomicBool::new(false);
        let capture = LogCaptureScope::start();
        handle_running_progress_result(
            Err(Error::Conflict("store failure".into())),
            "position search",
            &lease,
            &diagnosed,
            Some(&cancellation),
        )
        .unwrap();
        assert!(!cancellation.is_cancelled());
        assert!(matches!(
            handle_running_progress_result(
                Err(Error::StaleProgressLease),
                "position search",
                &lease,
                &diagnosed,
                Some(&cancellation),
            ),
            Err(Error::Cancellation)
        ));
        assert!(cancellation.is_cancelled());
        assert_eq!(
            capture
                .records()
                .iter()
                .filter(|record| record.level == log::Level::Error)
                .count(),
            1
        );
    }

    #[test]
    fn progress_error_policy_diagnoses_concurrent_failures_once_per_search() {
        let store = ProgressStore::default();
        let lease = store.start("concurrent-policy".into()).unwrap();
        for _ in 0..2 {
            let diagnosed = AtomicBool::new(false);
            let cancellation = CancellationToken::new();
            let diagnostics: usize = (0..32)
                .into_par_iter()
                .map(|_| {
                    let capture = LogCaptureScope::start();
                    handle_running_progress_result(
                        Err(Error::Conflict("concurrent store failure".into())),
                        "position search",
                        &lease,
                        &diagnosed,
                        Some(&cancellation),
                    )
                    .unwrap();
                    capture
                        .records()
                        .iter()
                        .filter(|record| record.level == log::Level::Error)
                        .count()
                })
                .sum();
            assert_eq!(diagnostics, 1);
            assert!(!cancellation.is_cancelled());
        }
    }
}

#[cfg(test)]
pub(super) fn run_position_search(
    app: &tauri::AppHandle<tauri::test::MockRuntime>,
    handle: &DatabaseHandle,
    query: GameQuery,
    progress_id: &str,
) -> Result<(Vec<PositionStats>, Vec<NormalizedGame>), Error> {
    let state = app.state::<AppState>();
    let progress = JobProgress::new(app.clone(), progress_id.into()).unwrap();
    let permit = state.new_request.clone().try_acquire_owned().unwrap();
    search_position_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        permit,
        progress.lease(),
        app.clone(),
        handle.clone(),
        query,
        &CancellationToken::new(),
        None,
    )
}

#[cfg(test)]
fn exact_position_query(fen: &str) -> GameQuery {
    GameQuery::new().position(PositionQueryJs {
        fen: fen.to_string(),
        type_: "exact".to_string(),
    })
}

#[cfg(test)]
mod imported_search_tests {
    use super::*;

    const NINE_PAWN_FEN: &str = "4k3/8/8/8/8/P7/PPPPPPPP/4K3 w - - 0 1";
    const KINGS_FEN: &str = "4k3/8/8/8/8/8/8/4K3 w - - 0 1";
    const AFTER_E4_FEN: &str = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
    const ABSENT_FEN: &str = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";

    fn imported_search_database(
        pgn: &str,
    ) -> (
        tempfile::TempDir,
        tauri::AppHandle<tauri::test::MockRuntime>,
        DatabaseHandle,
        std::path::PathBuf,
    ) {
        let (dir, app, handle, database) = super::super::schema_database_case(
            "imported-search",
            vec![
                PathOperation::DatabaseCreate,
                PathOperation::DatabaseRead,
                PathOperation::DatabaseMutate,
            ],
        );
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events!(
                crate::progress::ProgressEvent,
                super::super::ConvertProgress
            ))
            .mount_events(&app);
        let pgn_path = dir.path().join("fixture.pgn");
        std::fs::write(&pgn_path, pgn).unwrap();
        let state = app.state::<AppState>();
        let file = state
            .pgn_path_authority
            .with_mut(|authority| {
                let grant = authority.grant_persistent_file_for_test(
                    &pgn_path,
                    "fixture.pgn",
                    vec![PathOperation::ReadPgn],
                );
                super::super::FileWorkspaceHandle::new(grant.id)
            })
            .unwrap();
        super::super::convert_pgn_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            vec![file],
            handle.clone(),
            None,
            app.clone(),
            "Imported search".into(),
            None,
            "imported-search".into(),
            &CancellationToken::new(),
        )
        .unwrap();
        (dir, app, handle, database)
    }

    fn assert_imported_too_much_material_search(query_fen: &str, query_type: &str) {
        // Reuse the portable schema and capability fixture. This runs the actual
        // PGN conversion, index generation, search and normalized-game decoder.
        let (_dir, app, handle, database) = imported_search_database(&format!(
            "[Event \"Setup policy\"]\n[Site \"Fixture\"]\n[White \"Nine pawns\"]\n[Black \"King\"]\n[Result \"1-0\"]\n[SetUp \"1\"]\n[FEN \"{NINE_PAWN_FEN}\"]\n\n1. a4 1-0\n"
        ));
        let state = app.state::<AppState>();

        let mut connection = SqliteConnection::establish(database.to_str().unwrap()).unwrap();
        let imported = games::table.load::<Game>(&mut connection).unwrap();
        assert_eq!(imported.len(), 1, "the nine-pawn PGN must be imported");
        assert_eq!(imported[0].fen.as_deref(), Some(NINE_PAWN_FEN));
        assert_eq!(imported[0].moves.len(), 1);
        assert_eq!(
            super::super::encoding::decode_game_to_movetext(
                &imported[0].moves,
                NINE_PAWN_FEN.parse().unwrap(),
            )
            .unwrap(),
            "1. a4"
        );
        drop(connection);

        let query = GameQuery::new().position(PositionQueryJs {
            fen: query_fen.into(),
            type_: query_type.into(),
        });
        for progress_id in ["setup-policy-first", "setup-policy-cached"] {
            let result = run_position_search(&app, &handle, query.clone(), progress_id);
            assert!(
                result.is_ok(),
                "imported nine-pawn setup must be searchable by {query_type}: {:?}",
                result.as_ref().err()
            );
            let (stats, samples) = result.unwrap();
            assert_eq!(stats.len(), 1);
            assert_eq!(stats[0].move_, "a4");
            assert_eq!((stats[0].white, stats[0].draw, stats[0].black), (1, 0, 0));
            assert_eq!(samples.len(), 1);
            assert_eq!(samples[0].id, imported[0].id);
            assert_eq!(samples[0].fen, NINE_PAWN_FEN);
            assert_eq!(samples[0].moves, "1. a4 1-0");

            let cache = state.search_cache.results.lock().unwrap();
            assert_eq!(cache.values.len(), 1);
            let (key, cached) = cache.values.iter().next().unwrap();
            assert_eq!(key.query, query);
            assert_eq!(
                serde_json::to_value(&cached.value).unwrap(),
                serde_json::to_value(&(stats, samples)).unwrap()
            );
        }
        let index = MmapSearchIndex::open(get_index_path(&database)).unwrap();
        assert_eq!(index.len(), 1);
        let entry = index.get_entry_ref(0).unwrap();
        assert_eq!(entry.id, imported[0].id);
        assert_eq!(entry.fen, Some(NINE_PAWN_FEN));
        assert_eq!(entry.moves, imported[0].moves);
    }

    #[test]
    fn too_much_material_import_is_searchable_by_partial_kings() {
        assert_imported_too_much_material_search(KINGS_FEN, "partial");
    }

    #[test]
    fn too_much_material_import_is_searchable_by_exact_setup() {
        assert_imported_too_much_material_search(NINE_PAWN_FEN, "exact");
    }

    #[test]
    fn import_and_replacement_preserve_material_minima_and_index() {
        fn material_pgn(fen: &str, movetext: &str) -> String {
            format!("[SetUp \"1\"]\n[FEN \"{fen}\"]\n[Result \"*\"]\n\n{movetext}\n")
        }

        let cases = [
            (
                "kr6/pp6/8/QQQQQQQQ/QQQQQQQQ/QQQQQQQQ/QQQQQ3/7K w - - 0 1",
                "*",
                (39, 7),
                None,
            ),
            (
                "7k/qqqqq3/qqqqqqqq/qqqqqqqq/qqqqqqqq/8/PP6/KR6 b - - 0 1",
                "*",
                (7, 39),
                None,
            ),
            (
                "7k/P7/8/8/8/8/8/7K w - - 0 1",
                "1. a8=Q+ *",
                (1, 0),
                Some(("a8=Q+", "Q6k/8/8/8/8/8/8/7K b - - 0 1")),
            ),
            (
                "7k/8/8/8/8/8/p7/7K b - - 0 1",
                "1... a1=Q+ *",
                (0, 1),
                Some(("a1=Q+", "7k/8/8/8/8/8/8/q6K w - - 0 2")),
            ),
        ];

        // Validate the supplied promotion SAN and full final FEN before exercising
        // the actual import, replacement and index pipeline for every case.
        for &(fen, _, _, promotion) in &cases {
            let mut position =
                database_setup_to_chess(fen.parse::<Fen>().unwrap().into_setup()).unwrap();
            if let Some((san, final_fen)) = promotion {
                let m = SanPlus::from_ascii(san.as_bytes())
                    .unwrap()
                    .san
                    .to_move(&position)
                    .unwrap();
                assert!(m.is_promotion());
                position.play_unchecked(&m);
                assert!(position.is_check());
                assert_eq!(
                    Fen::from_position(position, EnPassantMode::Always).to_string(),
                    final_fen
                );
            }
        }

        for (case_index, &(fen, movetext, _, _)) in cases.iter().enumerate() {
            let pgn = material_pgn(fen, movetext);
            let (_dir, app, handle, database) = imported_search_database(&pgn);
            let state = app.state::<AppState>();
            let mut connection = SqliteConnection::establish(database.to_str().unwrap()).unwrap();
            let imported = games::table.load::<Game>(&mut connection).unwrap();
            assert_eq!(imported.len(), 1, "setup must be imported: {fen}");
            let game_id = imported[0].id;
            drop(connection);

            // Adjacent cases are opposite colours. Keep one row identity through
            // both operations and use the same assertions for excess and promotion.
            for (operation, &(fen, movetext, minimum, promotion)) in
                [cases[case_index], cases[case_index ^ 1]]
                    .iter()
                    .enumerate()
            {
                if operation == 1 {
                    super::super::write_db_game_blocking(
                        &state.pgn_path_authority,
                        &state.database_repository,
                        &state.search_cache,
                        handle.clone(),
                        game_id,
                        material_pgn(fen, movetext),
                        super::super::test_game_stamp(&state, &handle, game_id),
                        &CancellationToken::new(),
                    )
                    .unwrap();
                }

                let mut connection =
                    SqliteConnection::establish(database.to_str().unwrap()).unwrap();
                let saved = games::table.load::<Game>(&mut connection).unwrap();
                assert_eq!(saved.len(), 1);
                let saved = &saved[0];
                assert_eq!(saved.id, game_id);
                assert_eq!(saved.fen.as_deref(), Some(fen));
                assert_eq!(saved.result.as_deref(), Some("*"));
                assert_eq!(
                    (saved.white_material, saved.black_material),
                    minimum,
                    "persisted minimum for operation {operation}, setup {fen}"
                );
                assert_eq!(saved.ply_count, Some(i32::from(promotion.is_some())));
                assert_eq!(saved.moves.len(), usize::from(promotion.is_some()));
                drop(connection);

                super::super::generate_search_index(
                    &handle,
                    &state.pgn_path_authority,
                    &state.database_repository,
                    &state.search_cache,
                    &CancellationToken::new(),
                )
                .unwrap();
                let index = MmapSearchIndex::open(get_index_path(&database)).unwrap();
                assert_eq!(index.len(), 1);
                let entry = index.get_entry_ref(0).unwrap();
                assert_eq!(entry.id, game_id);
                assert_eq!(entry.fen, Some(fen));
                assert_eq!(entry.moves, saved.moves);
                drop(index);
                assert!(presence(&app, &handle, &exact_position_query(fen)));
                if let Some((_, final_fen)) = promotion {
                    assert!(presence(&app, &handle, &exact_position_query(final_fen)));
                }
            }
        }
    }

    fn imported_e4_e5(
        result: &str,
    ) -> (
        tempfile::TempDir,
        tauri::AppHandle<tauri::test::MockRuntime>,
        DatabaseHandle,
        std::path::PathBuf,
    ) {
        let fixture = imported_search_database(&format!(
            "[Event \"Presence\"]\n[Site \"Fixture\"]\n[White \"White\"]\n[Black \"Black\"]\n[Result \"{result}\"]\n\n1. e4 e5 {result}\n"
        ));
        let (_, _, _, database) = &fixture;
        let mut db = SqliteConnection::establish(database.to_str().unwrap()).unwrap();
        let imported = games::table.load::<Game>(&mut db).unwrap();
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].result.as_deref(), Some(result));
        assert_eq!(imported[0].moves.len(), 2);
        fixture
    }

    fn presence(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        handle: &DatabaseHandle,
        query: &GameQuery,
    ) -> bool {
        let state = app.state::<AppState>();
        is_position_in_db_cancellable(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle,
            query,
            &CancellationToken::new(),
        )
        .unwrap()
    }

    #[test]
    fn imported_presence_and_explorer_have_independent_predicates_in_both_orders() {
        for result in ["*", "1-0"] {
            for presence_first in [false, true] {
                let (_dir, app, handle, _database) = imported_e4_e5(result);
                let state = app.state::<AppState>();
                for (fen, expected_presence) in [(AFTER_E4_FEN, true), (ABSENT_FEN, false)] {
                    let query = exact_position_query(fen);
                    let prior_tuples = state.search_cache.results.lock().unwrap().values.len();
                    if presence_first {
                        assert_eq!(presence(&app, &handle, &query), expected_presence);
                        assert_eq!(
                            state.search_cache.results.lock().unwrap().values.len(),
                            prior_tuples,
                            "presence must not publish explorer tuples"
                        );
                    }
                    let explorer =
                        run_position_search(&app, &handle, query.clone(), "explorer").unwrap();
                    if result == "1-0" && expected_presence {
                        assert_eq!(explorer.0.len(), 1);
                        assert_eq!(explorer.0[0].move_, "e5");
                        assert_eq!(
                            (explorer.0[0].white, explorer.0[0].draw, explorer.0[0].black),
                            (1, 0, 0)
                        );
                        assert_eq!(explorer.1.len(), 1);
                    } else {
                        assert!(explorer.0.is_empty() && explorer.1.is_empty());
                    }
                    let (identity, _) = load_search_index_cancellable(
                        &state.pgn_path_authority,
                        &state.database_repository,
                        &state.search_cache,
                        &handle,
                        &CancellationToken::new(),
                    )
                    .unwrap();
                    let key = SearchResultKey::new(query.clone(), identity);
                    let cached = state.search_cache.get_result(&key).unwrap();
                    assert_eq!(
                        serde_json::to_value(&cached).unwrap(),
                        serde_json::to_value(&explorer).unwrap()
                    );
                    assert_eq!(
                        presence(&app, &handle, &query),
                        expected_presence,
                        "explorer statistics must not change occurrence presence for {result}"
                    );
                    let reused =
                        run_position_search(&app, &handle, query, "explorer-cached").unwrap();
                    assert_eq!(
                        serde_json::to_value(&reused).unwrap(),
                        serde_json::to_value(&explorer).unwrap()
                    );
                    assert_eq!(
                        state.search_cache.results.lock().unwrap().values.len(),
                        prior_tuples + 1
                    );
                }
                assert_eq!(state.search_cache.cached_index_count(), 1);
            }
        }
    }

    #[test]
    fn novelty_lookup_keeps_unfinished_import_present_after_empty_explorer_statistics() {
        let (_dir, app, handle, _database) = imported_e4_e5("*");
        let state = app.state::<AppState>();
        let present = exact_position_query(AFTER_E4_FEN);
        let absent = exact_position_query(ABSENT_FEN);
        assert!(
            presence(&app, &handle, &present),
            "cold unfinished occurrence"
        );
        let explorer =
            run_position_search(&app, &handle, present.clone(), "unfinished-explorer").unwrap();
        assert!(explorer.0.is_empty() && explorer.1.is_empty());
        assert_eq!(state.search_cache.results.lock().unwrap().values.len(), 1);
        let found = crate::chess::novelty_lookup_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            state.new_request.clone().try_acquire_owned().unwrap(),
            handle,
            vec![present, absent],
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(
            found,
            [true, false],
            "warmed occurrence precedes genuine absence"
        );
        assert_eq!(state.search_cache.results.lock().unwrap().values.len(), 1);
    }

    #[test]
    fn search_rejects_malformed_fen_invalid_kings_and_move_blobs() {
        let partial = PositionQuery::partial_from_fen(KINGS_FEN).unwrap();
        for (fen, message) in [
            ("invalid fen", "game 42 has invalid FEN:"),
            (
                "8/8/8/8/8/P7/PPPPPPPP/4K3 w - - 0 1",
                "game 42 has invalid FEN setup:",
            ),
            (
                "4k3/8/8/8/8/P7/PPPPPPPP/3KK3 w - - 0 1",
                "game 42 has invalid FEN setup:",
            ),
        ] {
            assert!(PositionQuery::exact_from_fen(fen).is_err());
            let error =
                get_move_after_match(42, &[], &Some(fen), &partial, &CancellationToken::new())
                    .unwrap_err();
            assert!(
                matches!(error, Error::InvalidInput(ref cause) if cause.starts_with(message)),
                "{error}"
            );
        }
        for (blob, message) in [
            (&[251][..], "game 42 has illegal encoded move 251"),
            (&[253, 1][..], "game 42 has invalid move stream:"),
        ] {
            let error = get_move_after_match(
                42,
                blob,
                &Some(NINE_PAWN_FEN),
                &partial,
                &CancellationToken::new(),
            )
            .unwrap_err();
            assert!(
                matches!(error, Error::InvalidInput(ref cause) if cause.starts_with(message)),
                "{error}"
            );
        }
    }
}

#[cfg(test)]
mod date_filter_tests {
    use super::*;
    use diesel::connection::SimpleConnection;

    const BOUNDS: [(Option<&str>, Option<&str>); 6] = [
        (None, None),
        (Some("2025.11.01"), None),
        (Some("2024.01.01"), Some("2024.12.31")),
        (Some("2024.06.15"), Some("2024.06.15")),
        (None, Some("2024.06.15")),
        (Some("2024.06.15"), None),
    ];

    const CASES: &[(Option<&str>, [bool; BOUNDS.len()])] = &[
        (None, [true, false, false, false, false, false]),
        (
            Some("????.??.??"),
            [true, false, false, false, false, false],
        ),
        (
            Some("202?.01.01"),
            [true, false, false, false, false, false],
        ),
        (
            Some("?024.01.01"),
            [true, false, false, false, false, false],
        ),
        (Some("2024.??.??"), [true, false, true, false, false, false]),
        (Some("2024.06.??"), [true, false, true, false, false, false]),
        (Some("2024.05.??"), [true, false, true, false, true, false]),
        (Some("2024.07.??"), [true, false, true, false, false, true]),
        (Some("2024.??.15"), [true, false, true, false, false, false]),
        (Some("2024.0?.?5"), [true, false, true, false, false, false]),
        (Some("2024.06.?5"), [true, false, true, false, false, false]),
        (Some("2024.06.14"), [true, false, true, false, true, false]),
        (Some("2024.06.15"), [true, false, true, true, true, true]),
        (Some("2024.06.16"), [true, false, true, false, false, true]),
        (Some("2024.01.01"), [true, false, true, false, true, false]),
        (Some("2024.12.31"), [true, false, true, false, false, true]),
        (Some("2023.??.??"), [true, false, false, false, true, false]),
        (Some("2025.??.??"), [true, false, false, false, false, true]),
        (Some("2025.10.??"), [true, false, false, false, false, true]),
        (Some("2025.11.??"), [true, true, false, false, false, true]),
        (Some("2025.11.01"), [true, true, false, false, false, true]),
        (Some("2025.10.31"), [true, false, false, false, false, true]),
        (Some(""), [true, false, false, false, true, false]),
        (Some("2024"), [true, false, false, false, true, false]),
        (Some("2024.??"), [true, false, false, false, false, true]),
        (Some("????"), [true, true, false, false, false, true]),
        (Some("2024-??-??"), [true, false, false, false, true, false]),
        (Some("2024.xx.xx"), [true, false, false, false, false, true]),
        (
            Some("2024.??.??extra"),
            [true, false, false, false, false, true],
        ),
        (
            Some("2024.??.??\0extra"),
            [true, false, false, false, false, true],
        ),
        (
            Some("2024.０?.??"),
            [true, false, false, false, false, true],
        ),
        (Some("2024.00.00"), [true, false, false, false, true, false]),
        (Some("2024.99.99"), [true, false, false, false, false, true]),
    ];

    #[test]
    fn index_date_filter_matches_shared_interval_cases() {
        for &(date, expected) in CASES {
            for ((start, end), expected) in BOUNDS.into_iter().zip(expected) {
                assert_eq!(
                    matches_date(date, start, end),
                    expected,
                    "date {date:?}, start {start:?}, end {end:?}"
                );
            }
        }
    }

    #[test]
    fn sql_date_filter_matches_shared_interval_cases_for_rows_and_counts() {
        let mut db = SqliteConnection::establish(":memory:").unwrap();
        db.batch_execute("CREATE TABLE Games (ID INTEGER PRIMARY KEY, Date TEXT)")
            .unwrap();
        for (id, &(date, _)) in CASES.iter().enumerate() {
            diesel::insert_into(games::table)
                .values((
                    games::id.eq(i32::try_from(id).unwrap()),
                    games::date.eq(date),
                ))
                .execute(&mut db)
                .unwrap();
        }

        for (bound_index, (start, end)) in BOUNDS.into_iter().enumerate() {
            let mut rows = games::table.select(games::id).into_boxed();
            let mut counts = games::table.into_boxed();
            if let Some(start) = start {
                let filter = date_interval_endpoint_sql(false).ge(start);
                rows = rows.filter(filter.clone());
                counts = counts.filter(filter);
            }
            if let Some(end) = end {
                let filter = date_interval_endpoint_sql(true).le(end);
                rows = rows.filter(filter.clone());
                counts = counts.filter(filter);
            }

            let expected: Vec<i32> = CASES
                .iter()
                .enumerate()
                .filter(|(_, (_, expected))| expected[bound_index])
                .map(|(id, _)| i32::try_from(id).unwrap())
                .collect();
            let actual = rows.order(games::id).load::<i32>(&mut db).unwrap();
            assert_eq!(actual, expected, "start {start:?}, end {end:?}");
            assert_eq!(
                counts.count().get_result::<i64>(&mut db).unwrap(),
                i64::try_from(expected.len()).unwrap(),
                "count for start {start:?}, end {end:?}"
            );
        }
    }
}

#[cfg(test)]
mod position_query_tests {
    use super::*;

    #[test]
    fn partial_constructor_preserves_a_full_board_of_queens() {
        let query = PositionQuery::partial_from_fen(
            "QQQQQQQQ/QQQQQQQQ/QQQQQQQQ/QQQQQQQQ/QQQQQQQQ/QQQQQQQQ/QQQQQQQQ/QQQQQQQQ w - - 0 1",
        )
        .unwrap();
        let PositionQuery::Partial(data) = &query else {
            panic!("partial constructor must produce a partial query");
        };
        assert_eq!(data.board.queens(), Bitboard::FULL);
        assert_eq!(data.board.by_color(Color::White), Bitboard::FULL);
        let chess = Chess::default();
        assert!(query.is_reachable_by(0));
        assert!(query.can_reach(0));
        assert!(!query.matches(&chess));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::infra::keyed_locks::KeyedLockLease;
    use crate::{
        db::{
            get_material_count, legacy_index_path,
            models::NewGame,
            ops::{create_event, create_game, create_player, create_site},
            SearchIndexChunk,
        },
        infra::fs::set_test_atomic_file_injector,
    };
    use diesel::Connection;
    use parking_lot::Mutex as ParkingMutex;
    use shakmaty::FromSetup;
    use std::{hash::Hash, path::PathBuf, sync::Arc};
    use tempfile::TempDir;

    fn loader_test_case(
        operations: Vec<PathOperation>,
    ) -> (
        TempDir,
        tauri::AppHandle<tauri::test::MockRuntime>,
        DatabaseHandle,
        PathBuf,
    ) {
        super::super::schema_database_case("search", operations)
    }

    fn preferred_loader_test_case() -> (
        TempDir,
        tauri::AppHandle<tauri::test::MockRuntime>,
        DatabaseHandle,
        PathBuf,
    ) {
        let (dir, app, handle, database, _target, _source) =
            super::descriptor_identity_tests::preferred_sidecar_test_case(
                "search",
                vec![PathOperation::DatabaseRead],
                SearchIndexChunk {
                    entries: vec![crate::db::SearchGameEntry {
                        id: 1,
                        white_id: 0,
                        black_id: 0,
                        date: None,
                        result: GameResult::Draw,
                        pawn_home: 0,
                        white_material: 0,
                        black_material: 0,
                        white_elo: 0,
                        black_elo: 0,
                        fen: None,
                        moves: vec![],
                    }],
                },
            );
        (dir, app, handle, database)
    }

    fn load_preferred_after_probe(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        handle: &DatabaseHandle,
        hook: impl FnOnce() + 'static,
    ) -> Result<(SearchIndexIdentity, MmapSearchIndex), Error> {
        AFTER_FAST_IDENTITY_PROBE_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(hook));
        });
        let state = app.state::<AppState>();
        load_search_index_cancellable(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle,
            &CancellationToken::new(),
        )
    }

    #[test]
    fn search_index_loader_fast_path_does_not_wait_for_generation_lock() {
        let (_dir, app, handle, database) = preferred_loader_test_case();
        let state = app.state::<AppState>();
        let target = DatabaseFileTarget::for_test_path(&database).unwrap();
        let generation_lease = state.search_cache.generation_lock(&target);
        let _generation_guard = generation_lease.lock();
        let cancellation = CancellationToken::new();
        let timer_token = cancellation.clone();
        let (timer_sender, timer_receiver) = std::sync::mpsc::channel::<()>();
        let timer = std::thread::spawn(move || {
            if matches!(
                timer_receiver.recv_timeout(std::time::Duration::from_secs(2)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ) {
                timer_token.cancel();
            }
        });
        let result = load_search_index_cancellable(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
            &cancellation,
        );
        drop(timer_sender);
        timer.join().unwrap();
        let (_, index) = result.unwrap();
        assert_eq!(index.get_entry_ref(0).unwrap().id, 1);
        assert_eq!(state.search_cache.cached_index_count(), 1);
    }

    #[test]
    fn search_index_loader_same_database_invalidation_returns_mapping_uncached() {
        let (_dir, app, handle, database) = preferred_loader_test_case();
        let cache = Arc::clone(&app.state::<AppState>().search_cache);
        let (_, index) = load_preferred_after_probe(&app, &handle, move || {
            cache.invalidate_database(&DatabaseFileTarget::for_test_path(&database).unwrap());
        })
        .unwrap();
        assert_eq!(index.get_entry_ref(0).unwrap().id, 1);
        assert_eq!(app.state::<AppState>().search_cache.cached_index_count(), 0);
    }

    #[test]
    fn search_index_loader_without_invalidation_caches_mapping() {
        let (_dir, app, handle, _database) = preferred_loader_test_case();
        let (_, index) = load_preferred_after_probe(&app, &handle, || {}).unwrap();
        assert_eq!(index.get_entry_ref(0).unwrap().id, 1);
        assert_eq!(app.state::<AppState>().search_cache.cached_index_count(), 1);
    }

    #[test]
    fn search_index_loader_other_database_invalidation_returns_mapping_uncached() {
        let (dir, app, handle, _database) = preferred_loader_test_case();
        let other = dir.path().join("other.db3");
        std::fs::write(&other, b"other database").unwrap();
        let cache = Arc::clone(&app.state::<AppState>().search_cache);
        // The counter is global: another database's invalidation costs one uncached load.
        let (_, index) = load_preferred_after_probe(&app, &handle, move || {
            cache.invalidate_database(&DatabaseFileTarget::for_test_path(&other).unwrap());
        })
        .unwrap();
        assert_eq!(index.get_entry_ref(0).unwrap().id, 1);
        assert_eq!(app.state::<AppState>().search_cache.cached_index_count(), 0);
    }

    #[test]
    fn search_index_loader_database_removed_after_probe_returns_mapping_uncached_after_invalidation(
    ) {
        let (_dir, app, handle, database) = preferred_loader_test_case();
        let sidecar = get_index_path(&database);
        let cache = Arc::clone(&app.state::<AppState>().search_cache);
        let result = load_preferred_after_probe(&app, &handle, move || {
            cache.invalidate_database(&DatabaseFileTarget::for_test_path(&database).unwrap());
            std::fs::remove_file(&database).unwrap();
        });
        assert!(sidecar.exists());
        let (_, index) = result
            .expect("database removed after probe must return its mapping after invalidation");
        assert_eq!(index.get_entry_ref(0).unwrap().id, 1);
        assert_eq!(app.state::<AppState>().search_cache.cached_index_count(), 0);
    }

    #[test]
    fn search_index_loader_database_removed_after_probe_caches_mapping_but_next_load_fails() {
        let (_dir, app, handle, database) = preferred_loader_test_case();
        let sidecar = get_index_path(&database);
        let result = load_preferred_after_probe(&app, &handle, move || {
            std::fs::remove_file(&database).unwrap();
        });
        assert!(sidecar.exists());
        let (identity, index) = result
            .expect("database removed after probe must return its mapping without invalidation");
        assert_eq!(index.get_entry_ref(0).unwrap().id, 1);
        let state = app.state::<AppState>();
        assert_eq!(state.search_cache.cached_index_count(), 1);
        assert!(state.search_cache.get_index(&identity).is_some());
        assert!(load_search_index_cancellable(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
            &CancellationToken::new(),
        )
        .is_err());
    }

    struct CacheEvictionProbe {
        cache: Arc<SearchCache>,
        identity: SearchIndexIdentity,
        observed: AtomicBool,
    }

    impl crate::infra::fs::AtomicWriterInjector for CacheEvictionProbe {
        fn inject(&self, point: crate::infra::fs::AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == crate::infra::fs::AtomicFileFaultPoint::TempfileCreate {
                if self.cache.get_index(&self.identity).is_some() {
                    return Err(std::io::Error::other(
                        "search index cache was not invalidated before promotion",
                    ));
                }
                self.observed.store(true, Ordering::SeqCst);
            }
            Ok(())
        }
    }

    #[test]
    fn search_commands_resolve_with_their_own_operation() {
        let (_dir, app, handle, _database) = loader_test_case(vec![PathOperation::DatabaseRead]);
        mount_progress_test_events(&app);
        let state = app.state::<AppState>();
        let progress = JobProgress::new(app.clone(), "matrix-search".into()).unwrap();
        let permit = state.new_request.clone().try_acquire_owned().unwrap();
        let _ = super::super::take_resolve_database_operations();
        let result = search_position_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            permit,
            progress.lease(),
            app.clone(),
            handle,
            GameQuery::new(),
            &CancellationToken::new(),
            None,
        );
        let recorded = super::super::take_resolve_database_operations();
        assert_eq!(recorded.first(), Some(&PathOperation::DatabaseRead));
        assert!(matches!(
            result,
            Err(Error::InvalidInput(message))
                if message == "workspace entry does not permit this operation"
        ));

        let (_dir, app, handle, _database) = loader_test_case(vec![PathOperation::DatabaseRead]);
        let state = app.state::<AppState>();
        let _ = super::super::take_resolve_database_operations();
        let result = is_position_in_db_cancellable(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
            &GameQuery::new(),
            &CancellationToken::new(),
        );
        let recorded = super::super::take_resolve_database_operations();
        assert_eq!(recorded.first(), Some(&PathOperation::DatabaseRead));
        assert!(matches!(
            result,
            Err(Error::InvalidInput(message))
                if message == "workspace entry does not permit this operation"
        ));

        let (_dir, app, handle, _database) = loader_test_case(vec![
            PathOperation::DatabaseRead,
            PathOperation::DatabaseMutate,
        ]);
        let state = app.state::<AppState>();
        let _ = super::super::take_resolve_database_operations();
        load_search_index_cancellable(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(
            super::super::take_resolve_database_operations(),
            vec![
                PathOperation::DatabaseRead,
                PathOperation::DatabaseRead,
                PathOperation::DatabaseMutate,
                PathOperation::DatabaseMutate,
                PathOperation::DatabaseRead,
            ]
        );

        let (_dir, app, handle, _database) = loader_test_case(vec![PathOperation::DatabaseRead]);
        let state = app.state::<AppState>();
        let _ = super::super::take_resolve_database_operations();
        let result = load_search_index_cancellable(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
            &CancellationToken::new(),
        );
        assert_eq!(
            super::super::take_resolve_database_operations(),
            vec![
                PathOperation::DatabaseRead,
                PathOperation::DatabaseRead,
                PathOperation::DatabaseMutate,
            ]
        );
        assert!(matches!(
            result,
            Err(Error::InvalidInput(message))
                if message == "workspace entry does not permit this operation"
        ));
    }

    fn loader_source(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        database: &std::path::Path,
    ) -> IndexSource {
        IndexSource::from_database_identity(
            &app.state::<AppState>()
                .database_repository
                .database_identity(&crate::db::test_target(database))
                .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn search_index_database_read_only_loads_valid_preferred_sidecar() {
        let (_dir, app, handle, database) = loader_test_case(vec![PathOperation::DatabaseRead]);
        SearchIndexChunk::default()
            .write_to_with_source(get_index_path(&database), loader_source(&app, &database))
            .unwrap()
            .expect_durable();

        let loaded = {
            let state = app.state::<AppState>();
            load_search_index(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                &handle,
            )
        };
        assert!(loaded.is_ok());
    }

    #[test]
    fn a_loaded_index_is_not_served_after_the_database_changes_in_place() {
        let (_dir, app, handle, database) = loader_test_case(vec![PathOperation::DatabaseRead]);
        SearchIndexChunk::default()
            .write_to_with_source(get_index_path(&database), loader_source(&app, &database))
            .unwrap()
            .expect_durable();
        let state = app.state::<AppState>();
        let load = || {
            load_search_index(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                &handle,
            )
        };
        let (identity, _index) = load().unwrap();
        assert!(state.search_cache.get_index(&identity).is_some());

        // Same inode, new freshness: the sidecar and the cached index now describe
        // an earlier state. A read-only load must re-probe and refuse them, which
        // surfaces as the generation path's missing Mutate permission.
        // Any mtime other than the one just probed; the epoch is never a fresh file's.
        let stale_mtime = std::time::UNIX_EPOCH;
        std::fs::OpenOptions::new()
            .write(true)
            .open(&database)
            .unwrap()
            .set_modified(stale_mtime)
            .unwrap();
        assert!(matches!(
            load(),
            Err(Error::InvalidInput(message))
                if message == "workspace entry does not permit this operation"
        ));
    }

    #[test]
    fn search_index_database_read_only_never_promotes_or_generates() {
        let (_legacy_dir, legacy_app, legacy_handle, legacy_database) =
            loader_test_case(vec![PathOperation::DatabaseRead]);
        let legacy = legacy_index_path(&legacy_database);
        SearchIndexChunk::default()
            .write_to_with_source(&legacy, loader_source(&legacy_app, &legacy_database))
            .unwrap()
            .expect_durable();
        let result = {
            let state = legacy_app.state::<AppState>();
            load_search_index(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                &legacy_handle,
            )
        };
        assert!(matches!(result, Err(Error::InvalidInput(_))));
        assert!(legacy.exists());
        assert!(!get_index_path(&legacy_database).exists());

        let (_missing_dir, missing_app, missing_handle, missing_database) =
            loader_test_case(vec![PathOperation::DatabaseRead]);
        let result = {
            let state = missing_app.state::<AppState>();
            load_search_index(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                &missing_handle,
            )
        };
        assert!(matches!(result, Err(Error::InvalidInput(_))));
        assert!(!get_index_path(&missing_database).exists());
        assert!(!legacy_index_path(&missing_database).exists());
    }

    #[test]
    fn search_index_generation_parent_sync_loads_committed_index() {
        let (_dir, app, handle, database) = loader_test_case(vec![
            PathOperation::DatabaseRead,
            PathOperation::DatabaseMutate,
        ]);
        set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
            "injected parent sync failure",
        ))));
        let result = {
            let state = app.state::<AppState>();
            load_search_index(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                &handle,
            )
        };
        set_test_atomic_file_injector(None);

        if let Err(error) = result {
            panic!("{error:?}");
        }
        assert!(get_index_path(&database).exists());
    }

    #[test]
    fn old_search_index_version_is_regenerated_when_mutation_is_authorized() {
        let (_dir, app, handle, database) = loader_test_case(vec![
            PathOperation::DatabaseRead,
            PathOperation::DatabaseMutate,
        ]);
        let path = get_index_path(&database);
        let mut old_header = vec![0_u8; 32];
        old_header[..4].copy_from_slice(b"ECSI");
        old_header[4..8].copy_from_slice(&6_u32.to_le_bytes());
        std::fs::write(&path, old_header).unwrap();

        let loaded = {
            let state = app.state::<AppState>();
            load_search_index(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                &handle,
            )
        }
        .unwrap();
        assert_eq!(loaded.1.len(), 0);
        assert!(MmapSearchIndex::open(path).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn operational_search_index_open_error_propagates() {
        let (_dir, app, handle, database) = loader_test_case(vec![PathOperation::DatabaseRead]);
        std::fs::create_dir(get_index_path(&database)).unwrap();

        let result = {
            let state = app.state::<AppState>();
            load_search_index(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                &handle,
            )
        };
        // The loader refuses a non-regular sidecar at open instead of failing later in mmap;
        // this pins propagation, not the error variant.
        assert!(matches!(result, Err(Error::InvalidInput(_))));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_search_index_is_rejected_without_modifying_target() {
        use std::os::unix::fs::symlink;

        let (_dir, app, handle, database) = loader_test_case(vec![
            PathOperation::DatabaseRead,
            PathOperation::DatabaseMutate,
        ]);
        let outside = database.with_file_name("outside.ecsi");
        std::fs::write(&outside, b"outside").unwrap();
        symlink(&outside, get_index_path(&database)).unwrap();

        let state = app.state::<AppState>();
        let target = super::super::resolve_database(
            &state.pgn_path_authority,
            &handle,
            PathOperation::DatabaseRead,
        )
        .unwrap();
        let db_identity = state
            .database_repository
            .database_identity_expected(&target, target.identity(), None)
            .unwrap();
        let expected_source = IndexSource::from_database_identity(&db_identity).unwrap();
        let result = open_valid_preferred(&target, &expected_source, &CancellationToken::new());
        assert!(matches!(result, Ok(None)), "{result:?}");
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
    }

    #[test]
    fn search_index_promotion_evicts_cache_before_replacement() {
        let (_dir, app, handle, database) = loader_test_case(vec![
            PathOperation::DatabaseRead,
            PathOperation::DatabaseMutate,
        ]);
        let state = app.state::<AppState>();
        let target = super::super::resolve_database(
            &state.pgn_path_authority,
            &handle,
            PathOperation::DatabaseRead,
        )
        .unwrap();
        let db_identity = state
            .database_repository
            .database_identity_expected(&target, target.identity(), None)
            .unwrap();
        let source = IndexSource::from_database_identity(&db_identity).unwrap();
        let preferred = get_index_path(&database);
        SearchIndexChunk::default()
            .write_to_with_source(&preferred, source.clone())
            .unwrap()
            .expect_durable();
        let identity = SearchIndexIdentity::for_test_database(&database, source.clone()).unwrap();
        let index = MmapSearchIndex::open(&preferred).unwrap();
        state.search_cache.insert_index(
            identity.clone(),
            index,
            state.search_cache.invalidation_snapshot(),
        );
        std::fs::remove_file(&preferred).unwrap();
        SearchIndexChunk::default()
            .write_to_with_source(legacy_index_path(&database), source)
            .unwrap()
            .expect_durable();

        let probe = Arc::new(CacheEvictionProbe {
            cache: Arc::clone(&state.search_cache),
            identity,
            observed: AtomicBool::new(false),
        });
        set_test_atomic_file_injector(Some(probe.clone()));
        let result = load_search_index(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
        );
        set_test_atomic_file_injector(None);

        assert!(result.is_ok());
        assert!(probe.observed.load(Ordering::SeqCst));
    }

    #[test]
    fn search_index_loader_uses_fd_relative_authority_boundaries() {
        let source = include_str!("search.rs");
        let production = source
            .split("#[cfg(all(test, unix))]\nmod tests {")
            .next()
            .unwrap();
        let loader = production
            .split("pub(crate) fn load_search_index_cancellable(")
            .nth(1)
            .unwrap()
            .split("fn open_valid_preferred(")
            .next()
            .unwrap();
        assert!(loader.contains("resolve_database("));
        assert!(loader.contains("promote_legacy_index_sidecar_at"));
        assert!(!loader.contains("canonicalize("));
        assert!(!loader.contains("database_path("));
        assert!(!loader.contains("workspace_entry_path("));
        assert!(!loader.contains("let database"));
        assert!(loader
            .contains("cache_loaded_index(\n            search_cache,\n            identity,"));
        assert!(loader.contains("generation_lock(&read_target)"));
        assert!(loader.contains("let generation_object = read_target.identity()"));
        assert!(
            loader.contains("cache_loaded_index(")
                && loader.contains("invalidate_database(&mutate_target)")
        );
        assert!(!loader.contains("atomic_replace(&"));
        assert!(!loader.contains("std::fs::remove_file"));
    }

    #[test]
    fn generation_lock_recovers_after_a_panicking_owner() {
        let (_dir, app, handle, database) = loader_test_case(vec![PathOperation::DatabaseRead]);
        let target = DatabaseFileTarget::for_test_path(&database).unwrap();
        let state = app.state::<AppState>();
        let lock = state.search_cache.generation_lock(&target);
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = lock.lock();
            panic!("poison the search cache generation lock");
        }));
        assert!(panicked.is_err());

        let result = {
            let state = app.state::<AppState>();
            load_search_index(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                &handle,
            )
        };
        assert!(!matches!(result, Err(Error::Conflict(ref message)) if message.contains("lock")));
    }

    #[test]
    fn collision_lock_recovers_after_a_panicking_owner() {
        let (_dir, app, handle, database) = loader_test_case(vec![PathOperation::DatabaseRead]);
        let query = GameQuery::new();
        let target = DatabaseFileTarget::for_test_path(&database).unwrap();
        let state = app.state::<AppState>();
        let lock = state.search_cache.collision_lock(query.clone(), &target);
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = lock.lock();
            panic!("poison the search cache collision lock");
        }));
        assert!(panicked.is_err());

        let result = {
            let state = app.state::<AppState>();
            is_position_in_db(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                &handle,
                &query,
            )
        };
        assert!(!matches!(result, Err(Error::Conflict(ref message)) if message.contains("lock")));
    }

    fn collision_lease_for_cache(
        cache: &SearchCache,
        (query, database): (GameQuery, (u64, u64)),
    ) -> KeyedLockLease<'_, (GameQuery, (u64, u64)), ParkingMutex<()>> {
        cache.collisions.lease((query, database))
    }

    fn generation_lease_for_cache(
        cache: &SearchCache,
        database: (u64, u64),
    ) -> KeyedLockLease<'_, (u64, u64), ParkingMutex<()>> {
        cache.generation_locks.lease(database)
    }

    fn assert_search_lock_wait_cancels<K>(
        cache: &SearchCache,
        key: K,
        lease_for_cache: for<'a> fn(&'a SearchCache, K) -> KeyedLockLease<'a, K, ParkingMutex<()>>,
    ) where
        K: Clone + Eq + Hash + Send + Sync,
    {
        let holder_lease = lease_for_cache(cache, key.clone());
        let held_guard = holder_lease.lock();
        let worker_observer_lease = lease_for_cache(cache, key.clone());
        let observer = worker_observer_lease.observe_wait();
        let cancellation = CancellationToken::new();
        let worker_cancellation = cancellation.clone();
        let (done_tx, done_rx) = std::sync::mpsc::sync_channel(1);

        std::thread::scope(|scope| {
            let worker_key = key.clone();
            let worker = scope.spawn(move || {
                let worker_lease = lease_for_cache(cache, worker_key);
                let result = worker_lease
                    .lock_cancellable(&worker_cancellation)
                    .map(|_guard| ());
                let _ = done_tx.send(result);
            });

            observer
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("worker must reach an active contended lock wait");
            cancellation.cancel();
            assert!(matches!(
                done_rx
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .expect("cancellation must end the active wait"),
                Err(Error::Cancellation)
            ));
            assert!(
                holder_lease.try_lock().is_none(),
                "holder remains locked during cancellation"
            );
            drop(held_guard);
            worker.join().expect("cancelled worker must finish");
        });
    }

    #[test]
    fn production_generation_and_collision_lock_waits_cancel_while_contended() {
        let (_dir, app, _handle, database) = loader_test_case(vec![PathOperation::DatabaseRead]);
        let state = app.state::<AppState>();
        let cache = state.search_cache.as_ref();
        assert_search_lock_wait_cancels(
            cache,
            DatabaseFileTarget::for_test_path(&database)
                .unwrap()
                .identity(),
            generation_lease_for_cache,
        );
        assert_search_lock_wait_cancels(
            cache,
            (
                GameQuery::new(),
                DatabaseFileTarget::for_test_path(&database)
                    .unwrap()
                    .identity(),
            ),
            collision_lease_for_cache,
        );
    }

    fn grant_alias(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        alias: &std::path::Path,
    ) -> DatabaseHandle {
        let state = app.state::<AppState>();
        let mut guard = state.pgn_path_authority.raw_for_test().lock().unwrap();
        let commit = guard.as_mut().unwrap().grant_persistent_file_for_test(
            alias,
            "alias",
            vec![PathOperation::DatabaseRead, PathOperation::DatabaseMutate],
        );
        DatabaseHandle::new(commit.id)
    }

    #[test]
    fn generation_integration_waits_on_the_hard_link_object() {
        let (dir, app, _handle, database) = loader_test_case(vec![PathOperation::DatabaseRead]);
        let original = DatabaseFileTarget::for_test_path(&database).unwrap();
        let alias = dir.path().join("alias.db3");
        std::fs::hard_link(&database, &alias).unwrap();
        let handle = grant_alias(&app, &alias);
        let state = app.state::<AppState>();
        let holder = state.search_cache.generation_lock(&original);
        let held = holder.lock();
        let observer = holder.observe_wait();
        let cancellation = CancellationToken::new();
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                load_search_index_cancellable(
                    &state.pgn_path_authority,
                    &state.database_repository,
                    &state.search_cache,
                    &handle,
                    &cancellation,
                )
            });
            let waiting = observer.recv_timeout(std::time::Duration::from_secs(5));
            cancellation.cancel();
            let result = worker.join().unwrap();
            assert!(
                waiting.is_ok(),
                "hard-link generation must wait on the original object lease: {result:?}"
            );
            assert!(matches!(result, Err(Error::Cancellation)));
        });
        assert!(!get_index_path(&alias).exists());
        drop(held);
        drop(holder);
        assert_eq!(state.search_cache.generation_locks.len(), 0);
    }

    #[test]
    fn presence_collision_integration_waits_on_the_hard_link_object() {
        assert_collision_integration_waits_on_the_hard_link_object(false);
    }

    #[test]
    fn position_search_collision_integration_waits_on_the_hard_link_object() {
        assert_collision_integration_waits_on_the_hard_link_object(true);
    }

    fn assert_collision_integration_waits_on_the_hard_link_object(position_search: bool) {
        // JobProgress emits through the same registry mounted by the application.
        let (dir, app, _handle, database) = loader_test_case(vec![PathOperation::DatabaseRead]);
        let original = DatabaseFileTarget::for_test_path(&database).unwrap();
        let alias = dir.path().join("alias.db3");
        std::fs::hard_link(&database, &alias).unwrap();
        let handle = grant_alias(&app, &alias);
        let state = app.state::<AppState>();
        mount_progress_test_events(&app);
        let query = GameQuery::new();
        let holder = state.search_cache.collision_lock(query.clone(), &original);
        let held = holder.lock();
        let observer = holder.observe_wait();
        let cancellation = CancellationToken::new();
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                if position_search {
                    let progress = JobProgress::new(app.clone(), "alias-search".into()).unwrap();
                    search_position_blocking(
                        &state.pgn_path_authority,
                        &state.database_repository,
                        &state.search_cache,
                        state.new_request.clone().try_acquire_owned().unwrap(),
                        progress.lease(),
                        app.clone(),
                        handle.clone(),
                        query.clone(),
                        &cancellation,
                        None,
                    )
                    .map(|_| ())
                } else {
                    is_position_in_db_cancellable(
                        &state.pgn_path_authority,
                        &state.database_repository,
                        &state.search_cache,
                        &handle,
                        &query,
                        &cancellation,
                    )
                    .map(|_| ())
                }
            });
            let waiting = observer.recv_timeout(std::time::Duration::from_secs(5));
            cancellation.cancel();
            let result = worker.join().unwrap();
            assert!(waiting.is_ok(), "collision integration {position_search} must wait on the original object lease: {result:?}");
            assert!(matches!(result, Err(Error::Cancellation)));
        });
        drop(held);
        drop(holder);
        assert_eq!(state.search_cache.collisions.len(), 0);
    }

    #[test]
    fn changed_database_after_generation_wait_is_rejected_without_publication() {
        // Authority refuses the replacement before the object-agreement guards.
        // This integration proves rejection and no publication, not those guards.
        let (dir, app, handle, database) = loader_test_case(vec![
            PathOperation::DatabaseRead,
            PathOperation::DatabaseMutate,
        ]);
        let original = DatabaseFileTarget::for_test_path(&database).unwrap();
        let state = app.state::<AppState>();
        let holder = state.search_cache.generation_lock(&original);
        let held = holder.lock();
        let observer = holder.observe_wait();
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                load_search_index(
                    &state.pgn_path_authority,
                    &state.database_repository,
                    &state.search_cache,
                    &handle,
                )
            });
            let waiting = observer.recv_timeout(std::time::Duration::from_secs(5));
            if waiting.is_ok() {
                std::fs::rename(&database, dir.path().join("old.db3")).unwrap();
                std::fs::write(&database, b"replacement").unwrap();
            }
            drop(held);
            let result = worker.join().unwrap();
            assert!(waiting.is_ok(), "loader must reach generation wait");
            assert!(
                result.is_err(),
                "changed target after wait must be rejected"
            );
        });
        assert!(!get_index_path(&database).exists());
        assert_eq!(state.search_cache.cached_index_count(), 0);
        assert!(state.search_cache.results.lock().unwrap().values.is_empty());
        drop(holder);
        assert_eq!(state.search_cache.generation_locks.len(), 0);
    }

    fn assert_partial_match(fen1: &str, fen2: &str) {
        let query = PositionQuery::partial_from_fen(fen1).unwrap();
        let fen = Fen::from_ascii(fen2.as_bytes()).unwrap();
        let chess = Chess::from_setup(fen.into_setup(), shakmaty::CastlingMode::Chess960).unwrap();
        assert!(query.matches(&chess));
    }

    fn assert_partial_no_match(fen1: &str, fen2: &str) {
        let query = PositionQuery::partial_from_fen(fen1).unwrap();
        let fen = Fen::from_ascii(fen2.as_bytes()).unwrap();
        let chess = Chess::from_setup(fen.into_setup(), shakmaty::CastlingMode::Chess960).unwrap();
        assert!(!query.matches(&chess));
    }

    #[test]
    fn exact_matches() {
        let query = PositionQuery::exact_from_fen(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        )
        .unwrap();
        let chess = Chess::default();
        assert!(query.matches(&chess));
    }

    #[test]
    fn empty_matches_anything() {
        assert_partial_match(
            "8/8/8/8/8/8/8/8 w - - 0 1",
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        );
    }

    #[test]
    fn correct_partial_match() {
        assert_partial_match(
            "8/8/8/8/8/8/8/6N1 w - - 0 1",
            "3k4/8/8/8/8/4P3/3PKP2/6N1 w - - 0 1",
        );
    }

    #[test]
    fn partial_match_requires_the_piece_colour_on_each_specified_square() {
        assert_partial_no_match(
            "8/8/8/8/8/8/8/6N1 w - - 0 1",
            "3k4/8/8/8/8/4P3/3PKP2/6n1 w - - 0 1",
        );
        assert_partial_no_match(
            "8/8/8/8/8/8/8/6n1 w - - 0 1",
            "3k4/8/8/8/8/4p3/3PKP2/6N1 w - - 0 1",
        );
    }

    #[test]
    fn partial_match_accepts_extra_unspecified_pieces_of_either_colour() {
        assert_partial_match(
            "8/8/8/8/8/8/8/6N1 w - - 0 1",
            "3k4/8/8/8/8/4p3/3PKP2/6N1 w - - 0 1",
        );
    }

    #[test]
    #[should_panic]
    fn fail_partial_match() {
        assert_partial_match(
            "8/8/8/8/8/8/8/6N1 w - - 0 1",
            "3k4/8/8/8/8/4P3/3PKP2/7N w - - 0 1",
        );
        assert_partial_match(
            "8/8/8/8/8/8/8/6N1 w - - 0 1",
            "3k4/8/8/8/8/4P3/3PKP2/6n1 w - - 0 1",
        );
    }

    #[test]
    fn correct_exact_is_reachable() {
        let query =
            PositionQuery::exact_from_fen("rnbqkb1r/pppp1ppp/5n2/4p3/4P3/2N5/PPPP1PPP/R1BQKBNR")
                .unwrap();
        let chess = Chess::default();
        assert!(query.is_reachable_by(get_pawn_home(chess.board())));
    }

    #[test]
    fn correct_partial_is_reachable() {
        let query = PositionQuery::partial_from_fen("8/8/8/8/8/8/8/8").unwrap();
        let chess = Chess::default();
        assert!(query.is_reachable_by(get_pawn_home(chess.board())));
    }

    #[test]
    fn correct_partial_can_reach() {
        let query = PositionQuery::partial_from_fen("8/8/8/8/8/8/8/8").unwrap();
        let chess = Chess::default();
        assert!(query.can_reach(get_pawn_home(chess.board())));
    }

    #[test]
    fn get_move_after_exact_match_test() {
        let game = vec![12, 12]; // 1. e4 e5

        let query = PositionQuery::exact_from_fen(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        )
        .unwrap();
        let result =
            get_move_after_match(1, &game, &None, &query, &CancellationToken::new()).unwrap();
        assert_eq!(result, Some("e4".to_string()));

        let query = PositionQuery::exact_from_fen(
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
        )
        .unwrap();
        let result =
            get_move_after_match(1, &game, &None, &query, &CancellationToken::new()).unwrap();
        assert_eq!(result, Some("e5".to_string()));

        let query = PositionQuery::exact_from_fen(
            "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2",
        )
        .unwrap();
        let result =
            get_move_after_match(1, &game, &None, &query, &CancellationToken::new()).unwrap();
        assert_eq!(result, Some("*".to_string()));
    }

    #[test]
    fn exact_match_rights_regression() {
        let mut chess = Chess::default();
        chess.play_unchecked(
            &SanPlus::from_ascii(b"e4")
                .unwrap()
                .san
                .to_move(&chess)
                .unwrap(),
        );
        chess.play_unchecked(
            &SanPlus::from_ascii(b"e5")
                .unwrap()
                .san
                .to_move(&chess)
                .unwrap(),
        );

        // Correct match
        let query = PositionQuery::exact_from_fen(
            "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
        )
        .unwrap();
        assert!(query.matches(&chess));

        // Missing castling right
        let query = PositionQuery::exact_from_fen(
            "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w Qkq - 0 2",
        )
        .unwrap();
        assert!(!query.matches(&chess));

        // Wrong side to move
        let query = PositionQuery::exact_from_fen(
            "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
        )
        .unwrap();
        assert!(!query.matches(&chess));

        // Let's create an en passant scenario
        let mut chess2 = Chess::default();
        for san in ["e4", "e5", "d4", "exd4", "e5", "f5"] {
            chess2.play_unchecked(
                &SanPlus::from_ascii(san.as_bytes())
                    .unwrap()
                    .san
                    .to_move(&chess2)
                    .unwrap(),
            );
        }

        // Correct ep square f6
        let query = PositionQuery::exact_from_fen(
            "rnbqkbnr/pppp2pp/8/4Pp2/3p4/8/PPP2PPP/RNBQKBNR w KQkq f6 0 4",
        )
        .unwrap();
        assert!(query.matches(&chess2));

        // Missing ep square
        let query = PositionQuery::exact_from_fen(
            "rnbqkbnr/pppp2pp/8/4Pp2/3p4/8/PPP2PPP/RNBQKBNR w KQkq - 0 4",
        )
        .unwrap();
        assert!(!query.matches(&chess2));
    }

    #[test]
    fn get_move_after_partial_match_test() {
        let game = vec![12, 12]; // 1. e4 e5

        let query = PositionQuery::partial_from_fen("8/pppppppp/8/8/8/8/PPPPPPPP/8").unwrap();
        let result =
            get_move_after_match(1, &game, &None, &query, &CancellationToken::new()).unwrap();
        assert_eq!(result, Some("e4".to_string()));
    }

    #[test]
    fn invalid_position_query_discriminant_is_an_input_error() {
        let error = convert_position_query(PositionQueryJs {
            fen: "8/8/8/8/8/8/8/8 w - - 0 1".into(),
            type_: "surprise".into(),
        })
        .unwrap_err();
        assert!(matches!(error, Error::InvalidInput(_)));
    }

    #[test]
    fn invalid_result_filter_is_an_input_error() {
        assert!(matches!(
            parse_wanted_result(Some("anything")),
            Err(Error::InvalidInput(_))
        ));
    }

    #[test]
    fn result_filter_maps_every_supported_value_and_absence() {
        assert_eq!(parse_wanted_result(None).unwrap(), None);
        assert_eq!(parse_wanted_result(Some("any")).unwrap(), None);
        assert_eq!(
            parse_wanted_result(Some("whitewon")).unwrap(),
            Some(GameResult::WhiteWin)
        );
        assert_eq!(
            parse_wanted_result(Some("blackwon")).unwrap(),
            Some(GameResult::BlackWin)
        );
        assert_eq!(
            parse_wanted_result(Some("draw")).unwrap(),
            Some(GameResult::Draw)
        );
    }

    #[test]
    fn pawn_home_reachability_rejects_a_required_home_pawn_that_is_absent() {
        assert!(!is_end_reachable(0b0001, 0));
        assert!(is_end_reachable(0b0001, 0b0011));
    }

    #[test]
    fn promotion_material_is_not_pruned_as_unreachable() {
        let query = PositionQuery::exact_from_fen("7k/Q7/8/8/8/8/8/4K3 w - - 0 1").unwrap();
        assert!(query.is_reachable_by(0));
    }

    #[test]
    fn bounded_date_queries_exclude_unknown_dates() {
        assert!(!matches_date(None, Some("2024.01.01"), None));
        assert!(!matches_date(None, None, Some("2024.12.31")));
        assert!(matches_date(
            Some("2024.06.01"),
            Some("2024.01.01"),
            Some("2024.12.31")
        ));
        assert!(!matches_date(Some("2023.12.31"), Some("2024.01.01"), None));
    }

    #[test]
    fn corrupt_game_stream_is_reported_with_game_context() {
        let query = PositionQuery::exact_from_fen(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        )
        .unwrap();
        let error = get_move_after_match(42, &[252, 1], &None, &query, &CancellationToken::new())
            .unwrap_err();
        assert!(error.to_string().contains("game 42"));
    }

    #[test]
    fn search_progress_percent_handles_zero_game_searches() {
        assert_eq!(search_progress_percent(0, 0), 0.0);
        assert_eq!(search_progress_percent(7, 0), 0.0);
        assert_eq!(search_progress_percent(0, 200), 0.0);
        assert_eq!(search_progress_percent(50, 200), 25.0);
        assert_eq!(search_progress_percent(200, 200), 100.0);
    }

    #[tokio::test]
    async fn search_cancellation_while_queued_for_request_semaphore_never_admits_work() {
        let semaphore = Arc::new(tokio::sync::Semaphore::new(1));
        let held = semaphore.clone().acquire_owned().await.unwrap();
        let cancellation = CancellationToken::new();
        let worker_token = cancellation.clone();
        let worker_semaphore = Arc::clone(&semaphore);
        let queued =
            tokio::spawn(
                async move { acquire_search_request(worker_semaphore, &worker_token).await },
            );
        tokio::task::yield_now().await;
        cancellation.cancel();
        assert!(matches!(
            tokio::time::timeout(std::time::Duration::from_secs(1), queued)
                .await
                .unwrap()
                .unwrap(),
            Err(Error::Cancellation)
        ));
        assert_eq!(semaphore.available_permits(), 0);
        drop(held);
    }

    fn progress_test_app() -> tauri::AppHandle<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        // The store emits a typed Specta event, so the mock app needs the same
        // event registry the real application mounts in `main.rs`.
        mount_progress_test_events(&app);
        app.manage(AppState::default());
        app.handle().clone()
    }

    #[test]
    fn search_progress_is_visible_through_the_shared_store() {
        let app = progress_test_app();
        let progress = JobProgress::new(app.clone(), "tab-1".into()).unwrap();

        let store = &app.state::<AppState>().progress_state;
        assert_eq!(
            store.get("tab-1").unwrap().unwrap().state,
            ProgressState::Running
        );

        let _ = update_progress_with_state(
            &app.state::<AppState>().progress_state,
            &app,
            &progress.lease(),
            search_progress_percent(50, 200),
            ProgressState::Running,
        );
        assert_eq!(store.get("tab-1").unwrap().unwrap().progress, 25.0);

        progress.complete(ProgressState::Succeeded);
        let item = store.get("tab-1").unwrap().unwrap();
        assert_eq!(item.state, ProgressState::Succeeded);
        assert_eq!(item.progress, 100.0);

        // Dropping after a terminal transition must not reopen the entry as cancelled.
        drop(progress);
        assert_eq!(
            store.get("tab-1").unwrap().unwrap().state,
            ProgressState::Succeeded
        );
    }

    #[test]
    fn abandoned_search_is_cancelled_on_drop() {
        let app = progress_test_app();
        let progress = JobProgress::new(app.clone(), "tab-2".into()).unwrap();
        let _ = update_progress_with_state(
            &app.state::<AppState>().progress_state,
            &app,
            &progress.lease(),
            search_progress_percent(10, 100),
            ProgressState::Running,
        );
        drop(progress);

        let store = &app.state::<AppState>().progress_state;
        let item = store.get("tab-2").unwrap().unwrap();
        assert_eq!(item.state, ProgressState::Cancelled);
        assert!(item.finished);
    }

    #[test]
    fn search_cancellation_emits_exactly_one_cancelled_terminal_and_never_failed() {
        use tauri_specta::Event as _;

        let app = progress_test_app();
        let frames = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = Arc::clone(&frames);
        crate::progress::ProgressEvent::listen(&app, move |event| {
            captured.lock().unwrap().push(event.payload);
        });
        let progress = JobProgress::new(app, "cancelled-search".into()).unwrap();
        progress.complete(ProgressState::Cancelled);
        drop(progress);
        let frames = frames.lock().unwrap();
        assert_eq!(
            frames
                .iter()
                .filter(|frame| frame.state == ProgressState::Cancelled && frame.finished)
                .count(),
            1
        );
        assert!(!frames
            .iter()
            .any(|frame| frame.state == ProgressState::Failed));
    }

    #[test]
    fn search_position_production_core_cancels_during_index_sql_without_cache_publication() {
        let (_dir, app, handle, database) = loader_test_case(vec![
            PathOperation::DatabaseRead,
            PathOperation::DatabaseMutate,
        ]);
        mount_progress_test_events(&app);
        let state = app.state::<AppState>();
        let progress = JobProgress::new(app.clone(), "held-search".into()).unwrap();
        let permit = state.new_request.clone().try_acquire_owned().unwrap();
        let cancellation = CancellationToken::new();
        let checkpoints =
            crate::db::sqlite_cancellation::cancel_on_callback(cancellation.clone(), 2);
        let result = search_position_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            permit,
            progress.lease(),
            app.clone(),
            handle,
            GameQuery::new(),
            &cancellation,
            None,
        );
        assert!(matches!(result, Err(Error::Cancellation)));
        assert!(checkpoints.load(Ordering::SeqCst) >= 2);
        assert!(!get_index_path(&database).exists());
        assert!(state.search_cache.results.lock().unwrap().values.is_empty());
    }

    #[test]
    fn search_position_cancels_during_post_sql_normalization_without_cache_publication() {
        let (_dir, app, handle, _database) = position_search_database();
        mount_progress_test_events(&app);
        let state = app.state::<AppState>();
        let progress = JobProgress::new(app.clone(), "normalization-search".into()).unwrap();
        let permit = state.new_request.clone().try_acquire_owned().unwrap();
        let cancellation = CancellationToken::new();
        crate::db::encoding::cancel_decode_after_checkpoints(cancellation.clone(), 2);
        let result = search_position_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            permit,
            progress.lease(),
            app.clone(),
            handle,
            exact_position_query(STARTING_FEN),
            &cancellation,
            None,
        );
        assert!(matches!(result, Err(Error::Cancellation)));
        assert!(state.search_cache.results.lock().unwrap().values.is_empty());
    }

    #[tokio::test]
    async fn novelty_core_observes_analysis_cancellation_after_engine_exit() {
        let (_dir, app, handle, database) = position_search_database();
        let state = app.state::<AppState>();
        let cancellation = CancellationToken::new();
        let checkpoints =
            crate::db::sqlite_cancellation::cancel_on_callback(cancellation.clone(), 2);
        let permit = state.new_request.clone().try_acquire_owned().unwrap();

        // analyze_game_core has already retired its engine before it calls this
        // production novelty helper. Cancellation must still reach the real
        // index-generation SQL scope and suppress every cache publication.
        let result = crate::chess::novelty_lookup_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            permit,
            handle,
            vec![exact_position_query(AFTER_E4_E5_NF3_FEN)],
            &cancellation,
        );

        let outcome = match &result {
            Ok(present) => format!("success with {} presence flags", present.len()),
            Err(error) => error.to_string(),
        };
        assert!(
            matches!(result, Err(Error::Cancellation)),
            "novelty lookup returned {outcome} after {} SQLite checkpoints",
            checkpoints.load(Ordering::SeqCst)
        );
        assert!(checkpoints.load(Ordering::SeqCst) >= 2);
        assert!(!get_index_path(&database).exists());
        assert!(state.search_cache.results.lock().unwrap().values.is_empty());
        assert!(state.search_cache.indexes.lock().unwrap().values.is_empty());
    }

    #[test]
    fn a_newer_search_on_the_same_tab_supersedes_the_older_producer() {
        let app = progress_test_app();
        let older = JobProgress::new(app.clone(), "tab-3".into()).unwrap();
        let newer = JobProgress::new(app.clone(), "tab-3".into()).unwrap();

        // The stale producer's updates are refused rather than driving the new bar.
        let _ = update_progress_with_state(
            &app.state::<AppState>().progress_state,
            &app,
            &older.lease(),
            search_progress_percent(90, 100),
            ProgressState::Running,
        );
        let store = &app.state::<AppState>().progress_state;
        assert_eq!(store.get("tab-3").unwrap().unwrap().progress, 0.0);

        let _ = update_progress_with_state(
            &app.state::<AppState>().progress_state,
            &app,
            &newer.lease(),
            search_progress_percent(10, 100),
            ProgressState::Running,
        );
        assert_eq!(store.get("tab-3").unwrap().unwrap().progress, 10.0);

        // Even the stale producer's Drop must not cancel the running search.
        drop(older);
        assert_eq!(
            store.get("tab-3").unwrap().unwrap().state,
            ProgressState::Running
        );
    }

    const STARTING_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const AFTER_E4_E5_NF3_FEN: &str =
        "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";
    const AFTER_D4_FEN: &str = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1";

    fn insert_white_win_e4_e5(connection: &mut SqliteConnection) -> i32 {
        insert_e4_e5_game(
            connection,
            ("Carlsen", Some(2800)),
            ("Nakamura", Some(2700)),
            "Candidates",
        )
    }

    /// Inserts a 1-0 game with the same 1. e4 e5 mainline as the base fixture,
    /// so it matches every starting-position search.
    fn insert_e4_e5_game(
        connection: &mut SqliteConnection,
        (white_name, white_elo): (&str, Option<i32>),
        (black_name, black_elo): (&str, Option<i32>),
        event_name: &str,
    ) -> i32 {
        let white = create_player(connection, white_name).unwrap();
        let black = create_player(connection, black_name).unwrap();
        let event = create_event(connection, event_name).unwrap();
        let site = create_site(connection, "Madrid").unwrap();

        let mut chess = Chess::default();
        for san in ["e4", "e5"] {
            let m = SanPlus::from_ascii(san.as_bytes())
                .unwrap()
                .san
                .to_move(&chess)
                .unwrap();
            chess.play_unchecked(&m);
        }
        let material = get_material_count(chess.board());
        create_game(
            connection,
            NewGame {
                event_id: event.id,
                site_id: site.id,
                white_id: white.id,
                black_id: black.id,
                white_elo,
                black_elo,
                white_material: i32::from(material.white),
                black_material: i32::from(material.black),
                date: Some("2026.08.09"),
                time: Some("12:00:00"),
                round: None,
                result: Some("1-0"),
                time_control: None,
                eco: Some("C20"),
                ply_count: 2,
                fen: None,
                moves: &[12, 12],
                pawn_home: i32::from(get_pawn_home(chess.board())),
            },
        )
        .unwrap()
        .id
    }

    fn position_search_database() -> (
        TempDir,
        tauri::AppHandle<tauri::test::MockRuntime>,
        DatabaseHandle,
        PathBuf,
    ) {
        let (dir, app, handle, database) = loader_test_case(vec![
            PathOperation::DatabaseRead,
            PathOperation::DatabaseMutate,
        ]);
        let mut connection = SqliteConnection::establish(database.to_str().unwrap()).unwrap();
        insert_white_win_e4_e5(&mut connection);
        drop(connection);
        (dir, app, handle, database)
    }

    #[test]
    fn is_position_in_db_finds_a_played_position_and_rejects_an_unplayed_one() {
        let (_dir, app, handle, _database) = position_search_database();
        let state = app.state::<AppState>();

        let present = is_position_in_db(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
            &exact_position_query(STARTING_FEN),
        )
        .unwrap();
        assert!(
            present,
            "the starting position of 1. e4 e5 must be found in the database"
        );

        let absent = is_position_in_db(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
            &exact_position_query(AFTER_E4_E5_NF3_FEN),
        )
        .unwrap();
        assert!(
            !absent,
            "1. e4 e5 2. Nf3 is not a position of the stored game"
        );

        let absent_again = is_position_in_db(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
            &exact_position_query(AFTER_E4_E5_NF3_FEN),
        )
        .unwrap();
        assert!(
            !absent_again,
            "a repeated occurrence scan must still report the unplayed position absent"
        );

        let no_position = is_position_in_db(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
            &GameQuery::new(),
        )
        .unwrap();
        assert!(
            !no_position,
            "a query without a position is not a position match"
        );

        let pruned = is_position_in_db(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
            &exact_position_query(AFTER_D4_FEN),
        )
        .unwrap();
        assert!(
            !pruned,
            "1. d4 is unreachable from a game that never moved the d-pawn"
        );

        let invalid = is_position_in_db(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
            &GameQuery::new().position(PositionQueryJs {
                fen: STARTING_FEN.to_string(),
                type_: "surprise".to_string(),
            }),
        );
        assert!(
            matches!(invalid, Err(Error::InvalidInput(_))),
            "an unsupported position query type must be rejected, not treated as a miss"
        );
    }

    #[test]
    fn production_position_search_applies_filters_and_reuses_exact_cached_results() {
        let (_dir, app, handle, database) = position_search_database();
        mount_progress_test_events(&app);
        let mut connection = SqliteConnection::establish(database.to_str().unwrap()).unwrap();
        let white_id = players::table
            .filter(players::name.eq("Carlsen"))
            .select(players::id)
            .first::<i32>(&mut connection)
            .unwrap();
        let black_id = players::table
            .filter(players::name.eq("Nakamura"))
            .select(players::id)
            .first::<i32>(&mut connection)
            .unwrap();
        drop(connection);

        let query = exact_position_query(STARTING_FEN);
        let first = run_position_search(&app, &handle, query.clone(), "search-success").unwrap();
        assert_eq!(first.0.len(), 1);
        assert_eq!(first.0[0].move_, "e4");
        assert_eq!(
            (first.0[0].white, first.0[0].draw, first.0[0].black),
            (1, 0, 0)
        );
        assert_eq!(first.1.len(), 1);

        let cached = run_position_search(&app, &handle, query, "search-cached").unwrap();
        assert_eq!(cached.0[0].move_, "e4");
        assert_eq!(cached.1[0].white, "Carlsen");

        let mut matching_filters = exact_position_query(STARTING_FEN);
        matching_filters.player1 = Some(white_id);
        matching_filters.player2 = Some(black_id);
        matching_filters.wanted_result = Some("whitewon".into());
        matching_filters.start_date = Some("2026.01.01".into());
        matching_filters.end_date = Some("2026.12.31".into());
        let matched =
            run_position_search(&app, &handle, matching_filters, "search-filter-hit").unwrap();
        assert_eq!(matched.0[0].white, 1);
        assert_eq!(matched.1.len(), 1);

        let mut wrong_white = exact_position_query(STARTING_FEN);
        wrong_white.player1 = Some(white_id + 10_000);
        let excluded_white =
            run_position_search(&app, &handle, wrong_white, "search-white-miss").unwrap();
        assert_eq!((excluded_white.0.len(), excluded_white.1.len()), (0, 0));

        let mut wrong_black = exact_position_query(STARTING_FEN);
        wrong_black.player2 = Some(black_id + 10_000);
        let excluded_black =
            run_position_search(&app, &handle, wrong_black, "search-black-miss").unwrap();
        assert_eq!((excluded_black.0.len(), excluded_black.1.len()), (0, 0));

        let mut wrong_result = exact_position_query(STARTING_FEN);
        wrong_result.wanted_result = Some("draw".into());
        let excluded_result =
            run_position_search(&app, &handle, wrong_result, "search-result-miss").unwrap();
        assert_eq!((excluded_result.0.len(), excluded_result.1.len()), (0, 0));

        let mut wrong_date = exact_position_query(STARTING_FEN);
        wrong_date.start_date = Some("2027.01.01".into());
        let excluded_date =
            run_position_search(&app, &handle, wrong_date, "search-date-miss").unwrap();
        assert_eq!((excluded_date.0.len(), excluded_date.1.len()), (0, 0));
    }

    /// Base fixture plus extra 1. e4 e5 games, inserted before the first
    /// search builds the index.
    /// (White name, Elo), (Black name, Elo), event name.
    type ExtraGame<'a> = ((&'a str, Option<i32>), (&'a str, Option<i32>), &'a str);

    fn filter_search_database(
        extra: &[ExtraGame<'_>],
    ) -> (
        TempDir,
        tauri::AppHandle<tauri::test::MockRuntime>,
        DatabaseHandle,
        PathBuf,
    ) {
        let (dir, app, handle, database) = position_search_database();
        mount_progress_test_events(&app);
        let mut connection = SqliteConnection::establish(database.to_str().unwrap()).unwrap();
        for &(white, black, event) in extra {
            insert_e4_e5_game(&mut connection, white, black, event);
        }
        drop(connection);
        (dir, app, handle, database)
    }

    /// Total games counted across all moves.
    fn counted_games(result: &(Vec<PositionStats>, Vec<NormalizedGame>)) -> i32 {
        result.0.iter().map(|m| m.white + m.draw + m.black).sum()
    }

    fn sample_events(result: &(Vec<PositionStats>, Vec<NormalizedGame>)) -> Vec<String> {
        let mut events: Vec<String> = result.1.iter().map(|game| game.event.clone()).collect();
        events.sort();
        events
    }

    /// Holds the instrumentation lock for a whole test sequence, with the
    /// counters reset. Dropping clears the instrument flag, also on panic.
    struct SearchInstrument {
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl SearchInstrument {
        fn start() -> Self {
            let lock = SEARCH_POSITION_INSTRUMENT_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            PROCESS_ENTRY_CALLS.store(0, Ordering::SeqCst);
            EXCLUDE_FAST_SQL_COMPLETED.store(false, Ordering::SeqCst);
            SEARCH_POSITION_INSTRUMENT.set(true);
            Self { _lock: lock }
        }
    }

    impl Drop for SearchInstrument {
        fn drop(&mut self) {
            SEARCH_POSITION_INSTRUMENT.set(false);
        }
    }

    #[test]
    fn elo_in_range_excludes_unrated_zero_when_band_starts_above_zero() {
        assert!(elo_in_range(0, None));
        assert!(!elo_in_range(0, Some((1, 3000))));
        assert!(elo_in_range(0, Some((0, 2000))));
        assert!(elo_in_range(1850, Some((1850, 2350))));
        assert!(elo_in_range(2350, Some((1850, 2350))));
        assert!(!elo_in_range(2351, Some((1850, 2350))));
        // Bounds outside i16 must widen the rating, not narrow the bound.
        assert!(elo_in_range(i16::MAX, Some((0, 40_000))));
        assert!(!elo_in_range(i16::MAX, Some((40_000, 50_000))));
    }

    #[test]
    fn position_search_elo_band_requires_both_players_and_excludes_unrated() {
        let (_dir, app, handle, _database) = filter_search_database(&[(
            ("Unrated White", None),
            ("Unrated Black", None),
            "Club Open",
        )]);

        let unfiltered = run_position_search(
            &app,
            &handle,
            exact_position_query(STARTING_FEN),
            "elo-none",
        )
        .unwrap();
        assert_eq!(counted_games(&unfiltered), 2);
        assert_eq!(sample_events(&unfiltered), vec!["Candidates", "Club Open"]);

        let mut both_in = exact_position_query(STARTING_FEN);
        both_in.range1 = Some((2700, 2900));
        both_in.range2 = Some((2700, 2900));
        let hit = run_position_search(&app, &handle, both_in, "elo-hit").unwrap();
        assert_eq!(counted_games(&hit), 1);
        assert_eq!(hit.0[0].move_, "e4");
        assert_eq!(sample_events(&hit), vec!["Candidates"]);
        assert_eq!(hit.1[0].white, "Carlsen");

        let mut slice = exact_position_query(STARTING_FEN);
        slice.range1 = Some((1850, 2350));
        slice.range2 = Some((1850, 2350));
        let missed = run_position_search(&app, &handle, slice, "elo-slice").unwrap();
        assert_eq!((missed.0.len(), missed.1.len()), (0, 0));

        let mut black_out = exact_position_query(STARTING_FEN);
        black_out.range1 = Some((2700, 2900));
        black_out.range2 = Some((1000, 1200));
        let missed = run_position_search(&app, &handle, black_out, "elo-black-out").unwrap();
        assert_eq!((missed.0.len(), missed.1.len()), (0, 0));

        let mut positive_band = exact_position_query(STARTING_FEN);
        positive_band.range1 = Some((1, 3000));
        positive_band.range2 = Some((1, 3000));
        let rated = run_position_search(&app, &handle, positive_band, "elo-unrated").unwrap();
        assert_eq!(counted_games(&rated), 1);
        assert_eq!(sample_events(&rated), vec!["Candidates"]);
    }

    #[test]
    fn position_search_exclude_fast_events_is_name_based() {
        let (_dir, app, handle, _database) = filter_search_database(&[
            (
                ("Firouzja", Some(2750)),
                ("So", Some(2750)),
                "World BLITZ Championship",
            ),
            (("Caruana", Some(2780)), ("Ding", Some(2760)), "Rapid Open"),
            (("Nakamura", Some(2740)), ("Giri", Some(2730)), "Bullet Cup"),
            (
                ("Nepo", Some(2760)),
                ("Aronian", Some(2750)),
                "Armageddon Final",
            ),
        ]);
        assert!(FAST_EVENT_NAME_TOKENS.contains(&"blitz"));
        assert!(!FAST_EVENT_NAME_TOKENS
            .iter()
            .any(|token| "rapid open".contains(token)));

        let off = run_position_search(
            &app,
            &handle,
            exact_position_query(STARTING_FEN),
            "fast-off",
        )
        .unwrap();
        assert_eq!(counted_games(&off), 5);
        assert_eq!(
            sample_events(&off),
            vec![
                "Armageddon Final",
                "Bullet Cup",
                "Candidates",
                "Rapid Open",
                "World BLITZ Championship",
            ]
        );

        let mut on_query = exact_position_query(STARTING_FEN);
        on_query.exclude_fast_events = Some(true);
        let on = run_position_search(&app, &handle, on_query, "fast-on").unwrap();
        assert_eq!(counted_games(&on), 2);
        assert_eq!(on.0[0].move_, "e4");
        assert_eq!(sample_events(&on), vec!["Candidates", "Rapid Open"]);
    }

    #[test]
    fn position_search_exclude_fast_events_sql_failure_is_an_error() {
        let (_dir, app, handle, _database) = filter_search_database(&[(
            ("Firouzja", Some(2750)),
            ("So", Some(2750)),
            "Titled Blitz Arena",
        )]);
        // Build the index first so the failure can only come from the exclude pass.
        let built = run_position_search(
            &app,
            &handle,
            exact_position_query(STARTING_FEN),
            "sql-built",
        )
        .unwrap();
        assert_eq!(counted_games(&built), 2);

        let instrument = SearchInstrument::start();
        EXCLUDE_FAST_LOAD_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(|| {
                Some(Err(Error::InvalidInput(
                    "injected exclude-fast SQL failure".into(),
                )))
            }));
        });
        let mut query = exact_position_query(STARTING_FEN);
        query.exclude_fast_events = Some(true);
        let result = run_position_search(&app, &handle, query, "sql-failure");
        assert!(
            matches!(
                &result,
                Err(Error::InvalidInput(message)) if message == "injected exclude-fast SQL failure"
            ),
            "{:?}",
            result.as_ref().err()
        );
        assert!(!EXCLUDE_FAST_SQL_COMPLETED.load(Ordering::SeqCst));
        assert_eq!(PROCESS_ENTRY_CALLS.load(Ordering::SeqCst), 0);
        drop(instrument);
    }

    #[test]
    fn position_search_exclude_fast_events_cancels_during_event_sql_without_cache_publication() {
        let (_dir, app, handle, _database) = filter_search_database(&[(
            ("Firouzja", Some(2750)),
            ("So", Some(2750)),
            "Armageddon Final",
        )]);
        let state = app.state::<AppState>();
        load_search_index(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
        )
        .unwrap();
        assert!(state.search_cache.results.lock().unwrap().values.is_empty());

        let instrument = SearchInstrument::start();
        let cancellation = CancellationToken::new();
        let hook_token = cancellation.clone();
        EXCLUDE_FAST_LOAD_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                hook_token.cancel();
                None
            }));
        });
        let mut query = exact_position_query(STARTING_FEN);
        query.exclude_fast_events = Some(true);
        let progress = JobProgress::new(app.clone(), "fast-cancel".into()).unwrap();
        let permit = state.new_request.clone().try_acquire_owned().unwrap();
        let result = search_position_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            permit,
            progress.lease(),
            app.clone(),
            handle.clone(),
            query,
            &cancellation,
            None,
        );
        assert!(
            matches!(result, Err(Error::Cancellation)),
            "{:?}",
            result.as_ref().err()
        );
        assert!(cancellation.is_cancelled());
        assert!(state.search_cache.results.lock().unwrap().values.is_empty());
        assert_eq!(PROCESS_ENTRY_CALLS.load(Ordering::SeqCst), 0);
        assert!(!EXCLUDE_FAST_SQL_COMPLETED.load(Ordering::SeqCst));
        drop(instrument);
    }

    #[test]
    fn position_search_exclude_fast_events_false_and_omitted_share_cache_key() {
        let (_dir, app, handle, _database) = filter_search_database(&[]);
        let instrument = SearchInstrument::start();

        let omitted =
            run_position_search(&app, &handle, exact_position_query(STARTING_FEN), "omitted")
                .unwrap();
        assert_eq!(counted_games(&omitted), 1);
        assert!(PROCESS_ENTRY_CALLS.load(Ordering::SeqCst) > 0);
        PROCESS_ENTRY_CALLS.store(0, Ordering::SeqCst);

        let mut explicit_false = exact_position_query(STARTING_FEN);
        explicit_false.exclude_fast_events = Some(false);
        let cached = run_position_search(&app, &handle, explicit_false, "explicit-false").unwrap();
        assert_eq!(counted_games(&cached), 1);
        assert_eq!(PROCESS_ENTRY_CALLS.load(Ordering::SeqCst), 0);
        drop(instrument);
    }
}
