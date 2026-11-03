#[cfg(test)]
use crate::infra::path_authority::PathAuthority;
#[cfg(test)]
use crate::progress::ProgressUpdateHook;
#[cfg(all(test, unix))]
pub(crate) mod allocation_probe;
pub(crate) mod bound_sqlite;
mod content_validation;
mod encoding;
pub(crate) mod linked_collections;
mod migrations;
mod models;
mod ops;
mod repository;
#[cfg(all(test, unix))]
mod test_support;
#[cfg(all(test, unix))]
pub(crate) use repository::cancel_snapshot_copy_after_chunks;
#[cfg(test)]
pub(crate) use repository::test_target;
mod schema;
mod search;
pub(crate) use search::is_position_in_db_cancellable;
mod search_index;
pub(crate) mod sqlite_cancellation;

use crate::{
    cancellable_read::{map_read_error, CancellableRead, SourceRead, SourceReadState},
    db::{
        encoding::{
            database_setup_to_chess, decode_game_to_movetext, decode_game_to_movetext_cancellable,
            decode_move, iter_mainline_move_bytes, try_iter_mainline_move_bytes_cancellable,
        },
        models::*,
        ops::*,
        schema::*,
    },
    error::{CommittedRemoval, Error},
    infra::{
        blocking::BLOCKING_GATEWAY,
        path_authority::{
            DatabaseDeleteRecovery, DatabaseFileTarget, DatabaseHandle, FileWorkspaceHandle,
            PathOperation, RegularFileMetadata,
        },
    },
    opening::get_opening_from_setup,
    progress::{
        complete_preserving_result, handle_running_progress_result, update_progress_with_state,
        JobProgress, ProgressLease, ProgressState,
    },
    AppState, SearchCache,
};

use crate::infra::fs::{entry_identity_at, remove_entry_at};
use chrono::{NaiveDate, NaiveTime};
use diesel::{
    connection::{DefaultLoadingMode, SimpleConnection},
    expression::{BoxableExpression, SelectableExpression},
    prelude::*,
    sql_query,
    sql_types::Text,
    sqlite::Sqlite,
};
use pgn_reader::{BufferedReader, Nag, RawHeader, SanPlus, Skip, Visitor};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use shakmaty::{fen::Fen, Board, ByColor, Chess, EnPassantMode, Piece, Position};
use specta::Type;
use std::ffi::OsStr;
#[cfg(all(test, unix))]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{
    collections::HashMap,
    fs::File,
    sync::Arc,
    time::{Instant, SystemTime},
};
use std::{
    io::{BufWriter, Write},
    str::FromStr,
};

use log::info;
use tauri::Manager;
use tauri_specta::Event as _;
use tokio_util::sync::CancellationToken;

use self::encoding::{
    encode_comment, encode_move, encode_nag, VARIATION_END_MARKER, VARIATION_START_MARKER,
};
pub use self::repository::{DatabaseIdentity, DatabaseRepository};
#[cfg(test)]
pub use self::search_index::{get_index_path, legacy_index_path, SearchIndexChunk};
pub use self::search_index::{IndexSource, MmapSearchIndex, SearchGameEntry};

pub use self::models::NormalizedGame;
pub use self::models::Puzzle;
pub use self::schema::puzzle_themes;
pub use self::schema::puzzles;
pub use self::schema::themes;
pub use self::search::{search_position, PositionQueryJs, PositionStats};

const INDEXES_SQL: &str = include_str!("indexes.sql");

const DELETE_INDEXES_SQL: &str = include_str!("delete_indexes.sql");

/// Established cap for replaying plies during statistics opening lookup.
const OPENING_STATISTICS_PLY_LIMIT: usize = 55;
const PLAYER_STATISTICS_BATCH_ROW_BYTE_BUDGET: usize = 1024 * 1024;
const PLAYER_STATISTICS_BATCH_ROW_LIMIT: usize = 256;
/// Emit on kept rows 1, 1001 and subsequent intervals.
const PLAYER_STATISTICS_PROGRESS_INTERVAL: usize = 1_000;

fn cancellation_check(cancellation: &CancellationToken) -> Result<(), Error> {
    if cancellation.is_cancelled() {
        Err(Error::Cancellation)
    } else {
        Ok(())
    }
}

#[cfg(test)]
const CREATE_TABLES_SQL: &str = include_str!("create.sql");

const WHITE_PAWN: Piece = Piece {
    color: shakmaty::Color::White,
    role: shakmaty::Role::Pawn,
};

const BLACK_PAWN: Piece = Piece {
    color: shakmaty::Color::Black,
    role: shakmaty::Role::Pawn,
};

type MaterialCount = ByColor<u16>;

fn get_material_count(board: &Board) -> MaterialCount {
    board.material().map(|material| {
        u16::from(material.pawn)
            + u16::from(material.knight) * 3
            + u16::from(material.bishop) * 3
            + u16::from(material.rook) * 5
            + u16::from(material.queen) * 9
    })
}

/// Returns the bit representation of the pawns on the second and seventh rank
/// of the given board.
fn get_pawn_home(board: &Board) -> u16 {
    let white_pawns = board.by_piece(WHITE_PAWN);
    let black_pawns = board.by_piece(BLACK_PAWN);
    let second_rank_pawns = (white_pawns.0 >> 8) as u8;
    let seventh_rank_pawns = (black_pawns.0 >> 48) as u8;
    (second_rank_pawns as u16) | ((seventh_rank_pawns as u16) << 8)
}

/// Immutable safety policy for every connection in every database pool.  Import
/// batching belongs at the transaction/index layer; a pooled connection must
/// never retain weaker integrity or durability PRAGMAs from a prior caller.
#[derive(Debug, Default)]
pub struct ConnectionOptions;

/// Metadata used to invalidate the cheap schema-validation cache whenever a
/// database is replaced or modified outside this process.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DatabaseSchemaIdentity {
    object: (u64, u64),
    length: u64,
    modified: SystemTime,
}

impl DatabaseSchemaIdentity {
    fn from_probe(probe: &RegularFileMetadata) -> Self {
        Self {
            object: probe.identity,
            length: probe.length,
            modified: probe.modified,
        }
    }
}

impl diesel::r2d2::CustomizeConnection<SqliteConnection, diesel::r2d2::Error>
    for ConnectionOptions
{
    fn on_acquire(&self, conn: &mut SqliteConnection) -> Result<(), diesel::r2d2::Error> {
        (|| {
            conn.batch_execute(
                "PRAGMA busy_timeout = 30000;\
                 PRAGMA foreign_keys = ON;\
                 PRAGMA journal_mode = WAL;\
                 PRAGMA synchronous = FULL;",
            )?;
            Ok(())
        })()
        .map_err(diesel::r2d2::Error::QueryError)
    }
}

pub(crate) fn get_db_or_create(
    repository: &crate::db::DatabaseRepository,
    target: &DatabaseFileTarget,
    cancellation: Option<&CancellationToken>,
    authority: &crate::infra::path_authority::SharedPathAuthority,
    file: &DatabaseHandle,
) -> Result<repository::DatabaseConnection, Error> {
    if let Some(collections) = authority.collections()? {
        collections.resolve_database(
            authority,
            file,
            PathOperation::DatabaseRead,
            cancellation.unwrap_or(&CancellationToken::new()),
        )?;
    }
    let connection = repository.connection(target, cancellation)?;
    match repository.take_passed_stamp_due(target) {
        Ok(Some(identity)) => {
            content_validation::publish_passed_stamp(repository, authority, file, &identity)
        }
        Ok(None) => {}
        Err(error) => log::warn!(
            "passed content validation stamp lookup failed for {:?}: {}",
            target.leaf(),
            error.diagnostic()
        ),
    }
    Ok(connection)
}

/// The sole database capability boundary.  Native repository code receives a
/// checked path only after the opaque handle and the exact requested operation
/// have been validated; no renderer path is ever parsed here.
pub(crate) fn resolve_database(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    handle: &DatabaseHandle,
    operation: PathOperation,
) -> Result<DatabaseFileTarget, Error> {
    #[cfg(test)]
    RESOLVE_DATABASE_OPERATIONS.with(|operations| operations.borrow_mut().push(operation));
    if let Some(collections) = authority.collections()? {
        collections.guard_database(handle, operation)?;
        collections.ensure_database(authority, handle)?;
    }
    let target =
        authority.with_mut(|authority| authority.database_file_target(handle, operation))??;
    if let Some(collections) = authority.collections()? {
        collections.guard_database_target(handle, operation, target.identity())?;
    }
    Ok(target)
}

fn update_info_count(
    db: &mut SqliteConnection,
    name: &str,
    value: i64,
) -> Result<(), diesel::result::Error> {
    diesel::insert_into(info::table)
        .values((info::name.eq(name), info::value.eq(value.to_string())))
        .on_conflict(info::name)
        .do_update()
        .set(info::value.eq(value.to_string()))
        .execute(db)?;
    Ok(())
}

fn bump_revision_in_transaction<T>(
    db: &mut SqliteConnection,
    path: &std::path::Path,
    cancellation: &CancellationToken,
    op: impl FnOnce(&mut SqliteConnection) -> Result<T, Error>,
) -> Result<T, Error> {
    #[cfg(not(all(test, unix)))]
    let _ = path;
    cancellation_check(cancellation)?;
    let current = repository::read_data_revision(db)?;
    let result = op(db)?;
    #[cfg(all(test, unix))]
    repository::run_test_hook(repository::TestHook::AfterBumpOp, path);
    cancellation_check(cancellation)?;
    #[cfg(all(test, unix))]
    repository::run_test_hook(repository::TestHook::BeforeRevisionBump, path);
    let next = i64::try_from(current)
        .ok()
        .and_then(|revision| revision.checked_add(1))
        .ok_or_else(|| Error::InvalidInput("DataRevision overflow".into()))?;
    #[cfg(all(test, unix))]
    if repository::FAIL_NEXT_REVISION_BUMP.with(|fail| fail.replace(false)) {
        return Err(Error::Conflict("injected revision bump failure".into()));
    }
    update_info_count(db, "DataRevision", next)?;
    cancellation_check(cancellation)?;
    Ok(result)
}

fn finish_search_cache_after_transaction(
    result: Result<(), Error>,
    search_cache: &SearchCache,
    target: &DatabaseFileTarget,
) -> Result<(), Error> {
    match result {
        Ok(()) => {
            search_cache.invalidate_database(target);
            Ok(())
        }
        Err(error @ Error::Diesel(_)) => {
            search_cache.invalidate_database(target);
            Err(error)
        }
        Err(error) => Err(error),
    }
}

fn with_validated_mutation(
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    target: &DatabaseFileTarget,
    cancellation: &CancellationToken,
    authority: &crate::infra::path_authority::SharedPathAuthority,
    file: &DatabaseHandle,
    operation: impl FnOnce(&mut SqliteConnection) -> Result<(), Error>,
) -> Result<(), Error> {
    let mut content_validated = false;
    #[cfg(test)]
    database_command_checkpoint("mutation_owner", file);
    let result = repository.with_write_lock_cancellable(target, cancellation, || {
        guard_database_mutation(authority, file, PathOperation::DatabaseMutate)?;
        #[cfg(test)]
        database_command_checkpoint("mutation_owned", file);
        let mut connection = repository.initialization_connection(target, Some(cancellation))?;
        connection.transaction::<_, Error, _>(|db| {
            bump_revision_in_transaction(db, target.path(), cancellation, |db| {
                content_validated = migrations::validate_existing_database(db)?;
                operation(db)
            })
        })?;
        if content_validated {
            content_validation::publish_committed_pass(repository, authority, file, target);
        }
        Ok(())
    });
    finish_search_cache_after_transaction(result, search_cache, target)
}

fn guard_database_mutation(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    file: &DatabaseHandle,
    operation: PathOperation,
) -> Result<(), Error> {
    if let Some(collections) = authority.collections()? {
        collections.guard_database(file, operation)?;
        let target =
            authority.with_mut(|authority| authority.database_file_target(file, operation))??;
        collections.guard_database_target(file, operation, target.identity())?;
    }
    Ok(())
}

/// The material tracker starts at standard material (39) and only decreases,
/// capping persisted minima at 39 even for excess-material setups.
const STANDARD_MATERIAL_BASELINE: u16 = 39;

#[derive(Debug)]
pub struct MaterialColor {
    white: u16,
    black: u16,
}

impl MaterialColor {
    fn minimum_material(&self, board: &Board) -> MaterialCount {
        let final_material = get_material_count(board);
        ByColor {
            white: self.white.min(final_material.white),
            black: self.black.min(final_material.black),
        }
    }
}

impl Default for MaterialColor {
    fn default() -> Self {
        Self {
            white: STANDARD_MATERIAL_BASELINE,
            black: STANDARD_MATERIAL_BASELINE,
        }
    }
}

#[derive(Default, Debug)]
pub struct TempGame {
    provider_headers: Vec<u8>,
    pub event_name: Option<String>,
    pub site_name: Option<String>,
    pub date: Option<String>,
    pub time: Option<String>,
    pub round: Option<String>,
    pub white_name: Option<String>,
    pub white_elo: Option<i32>,
    pub black_name: Option<String>,
    pub black_elo: Option<i32>,
    pub result: Option<String>,
    pub time_control: Option<String>,
    pub eco: Option<String>,
    pub fen: Option<String>,
    pub moves: Vec<u8>,
    pub position: Chess,
    pub material_count: MaterialColor,
}

impl TempGame {
    pub fn insert_to_db(&self, db: &mut SqliteConnection) -> Result<i32, diesel::result::Error> {
        let pawn_home = get_pawn_home(self.position.board());

        let white_id = if let Some(name) = &self.white_name {
            create_player(db, name)?.id
        } else {
            0
        };
        let black_id = if let Some(name) = &self.black_name {
            create_player(db, name)?.id
        } else {
            0
        };

        let event_id = if let Some(name) = &self.event_name {
            create_event(db, name)?.id
        } else {
            0
        };

        let site_id = if let Some(name) = &self.site_name {
            create_site(db, name)?.id
        } else {
            0
        };

        let ply_count = iter_mainline_move_bytes(&self.moves).count() as i32;
        let minimum_material = self.material_count.minimum_material(self.position.board());
        let minimal_white_material = i32::from(minimum_material.white);
        let minimal_black_material = i32::from(minimum_material.black);

        let new_game = NewGame {
            white_id,
            black_id,
            ply_count,
            eco: self.eco.as_deref(),
            round: self.round.as_deref(),
            white_elo: self.white_elo,
            black_elo: self.black_elo,
            white_material: minimal_white_material,
            black_material: minimal_black_material,
            // max_rating: self.game.white.rating.max(self.game.black.rating),
            date: self.date.as_deref(),
            time: self.time.as_deref(),
            time_control: self.time_control.as_deref(),
            site_id,
            event_id,
            fen: self.fen.as_deref(),
            result: self.result.as_deref(),
            moves: self.moves.as_slice(),
            pawn_home: pawn_home as i32,
        };

        Ok(create_game(db, new_game)?.id)
    }
}

fn normalize_pgn_result(value: &str) -> &'static str {
    match value.trim() {
        "1-0" => "1-0",
        "0-1" => "0-1",
        "1/2-1/2" | "1/2" | "½-½" => "1/2-1/2",
        _ => "*",
    }
}

struct Importer {
    game: TempGame,
    games_started: usize,
    capture_provider_headers: bool,
    skip: bool,
    frames: Vec<ImportFrame>,
}

struct ImportFrame {
    position: Chess,
    pre_move_positions: Vec<Chess>,
}

impl ImportFrame {
    fn new(position: Chess) -> Self {
        Self {
            position,
            pre_move_positions: Vec::new(),
        }
    }
}

impl Importer {
    fn new(account: Option<&linked_collections::AccountIdentity>) -> Importer {
        Importer {
            game: TempGame::default(),
            games_started: 0,
            capture_provider_headers: account.is_some(),
            skip: false,
            frames: Vec::new(),
        }
    }
}

impl Visitor for Importer {
    type Result = Option<TempGame>;

    fn begin_game(&mut self) {
        self.games_started += 1;
        self.game = TempGame::default();
        self.skip = false;
        self.frames.clear();
    }

    fn header(&mut self, key: &[u8], value: RawHeader<'_>) {
        if self.capture_provider_headers && matches!(key, b"Site" | b"Link") {
            self.game.provider_headers.push(b'[');
            self.game.provider_headers.extend_from_slice(key);
            self.game.provider_headers.extend_from_slice(b" \"");
            self.game
                .provider_headers
                .extend_from_slice(value.as_bytes());
            self.game.provider_headers.extend_from_slice(b"\"]\n");
        }
        if key == b"White" {
            self.game.white_name = Some(value.decode_utf8_lossy().into_owned());
        } else if key == b"Black" {
            self.game.black_name = Some(value.decode_utf8_lossy().into_owned());
        } else if key == b"WhiteElo" {
            if value.as_bytes() == b"-" {
                self.game.white_elo = Some(0);
            } else {
                self.game.white_elo = btoi::btoi(value.as_bytes()).ok();
            }
        } else if key == b"BlackElo" {
            if value.as_bytes() == b"-" {
                self.game.black_elo = Some(0);
            } else {
                self.game.black_elo = btoi::btoi(value.as_bytes()).ok();
            }
        } else if key == b"TimeControl" {
            self.game.time_control = Some(value.decode_utf8_lossy().into_owned());
        } else if key == b"ECO" {
            self.game.eco = Some(value.decode_utf8_lossy().into_owned());
        } else if key == b"Round" {
            self.game.round = Some(value.decode_utf8_lossy().into_owned());
        } else if key == b"Date" || key == b"UTCDate" {
            self.game.date = Some(String::from_utf8_lossy(value.as_bytes()).to_string());
        } else if key == b"UTCTime" {
            self.game.time = Some(String::from_utf8_lossy(value.as_bytes()).to_string());
        } else if key == b"Site" {
            self.game.site_name = Some(String::from_utf8_lossy(value.as_bytes()).to_string());
        } else if key == b"Event" {
            self.game.event_name = Some(String::from_utf8_lossy(value.as_bytes()).to_string());
        } else if key == b"Result" {
            self.game.result =
                Some(normalize_pgn_result(&String::from_utf8_lossy(value.as_bytes())).to_string());
        } else if key == b"FEN" {
            if value.as_bytes() == b"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" {
                self.game.fen = None;
                self.game.position = Chess::default();
            } else {
                let fen = Fen::from_ascii(value.as_bytes());
                if let Ok(fen) = fen {
                    self.game.fen = Some(value.decode_utf8_lossy().into_owned());
                    if let Ok(setup) = database_setup_to_chess(fen.into_setup()) {
                        self.game.position = setup;
                    } else {
                        self.skip = true;
                    }
                } else {
                    self.skip = true;
                }
            }
        }
    }

    fn end_headers(&mut self) -> Skip {
        // Skip games without ELO
        // self.skip |= self.current.white_elo.is_none() || self.current.black_elo.is_none();

        self.frames.clear();
        self.frames
            .push(ImportFrame::new(self.game.position.clone()));

        Skip(self.skip)
    }

    fn san(&mut self, san: SanPlus) {
        if self.frames.is_empty() {
            self.frames
                .push(ImportFrame::new(self.game.position.clone()));
        }

        let is_mainline = self.frames.len() == 1;
        let Some(frame) = self.frames.last_mut() else {
            self.skip = true;
            return;
        };
        let pre_move_position = frame.position.clone();

        let m = san.san.to_move(&frame.position).ok();
        if let Some(m) = m {
            let encoded = match encode_move(&m, &frame.position) {
                Ok(byte) => byte,
                Err(_) => {
                    self.skip = true;
                    return;
                }
            };

            if is_mainline && m.is_promotion() {
                let cur_material = get_material_count(frame.position.board());
                if cur_material.white < self.game.material_count.white {
                    self.game.material_count.white = cur_material.white;
                }
                if cur_material.black < self.game.material_count.black {
                    self.game.material_count.black = cur_material.black;
                }
            }
            self.game.moves.push(encoded);
            frame.pre_move_positions.push(pre_move_position);
            frame.position.play_unchecked(&m);

            if is_mainline {
                self.game.position = frame.position.clone();
            }
        } else {
            self.skip = true;
        }
    }

    fn begin_variation(&mut self) -> Skip {
        if self.frames.is_empty() {
            self.frames
                .push(ImportFrame::new(self.game.position.clone()));
        }

        let Some(parent) = self.frames.last() else {
            self.skip = true;
            return Skip(true);
        };
        let variation_start = parent
            .pre_move_positions
            .last()
            .cloned()
            .unwrap_or_else(|| parent.position.clone());

        self.game.moves.push(VARIATION_START_MARKER);
        self.frames.push(ImportFrame::new(variation_start));
        Skip(false)
    }

    fn end_variation(&mut self) {
        self.game.moves.push(VARIATION_END_MARKER);
        if self.frames.len() > 1 {
            self.frames.pop();
        } else {
            self.skip = true;
        }

        if let Some(root) = self.frames.first() {
            self.game.position = root.position.clone();
        }
    }

    fn comment(&mut self, comment: pgn_reader::RawComment<'_>) {
        let comment = String::from_utf8_lossy(comment.as_bytes());
        encode_comment(comment.as_ref(), &mut self.game.moves);
    }

    fn nag(&mut self, nag: Nag) {
        encode_nag(&nag.to_string(), &mut self.game.moves);
    }

    fn end_game(&mut self) -> Self::Result {
        self.frames.clear();
        if self.skip {
            self.game = TempGame::default();
            None
        } else {
            Some(std::mem::take(&mut self.game))
        }
    }
}

#[cfg(test)]
struct DatabaseCommandCheckpoint {
    entered: std::sync::mpsc::SyncSender<()>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}

#[cfg(test)]
type DatabaseCommandCheckpoints =
    std::collections::HashMap<(&'static str, String), Arc<DatabaseCommandCheckpoint>>;

#[cfg(test)]
static DATABASE_COMMAND_CHECKPOINTS: once_cell::sync::Lazy<
    std::sync::Mutex<DatabaseCommandCheckpoints>,
> = once_cell::sync::Lazy::new(Default::default);

#[cfg(test)]
fn install_database_command_checkpoint(
    label: &'static str,
    handle: &DatabaseHandle,
) -> (
    std::sync::mpsc::Receiver<()>,
    std::sync::mpsc::SyncSender<()>,
) {
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    DATABASE_COMMAND_CHECKPOINTS.lock().unwrap().insert(
        (label, handle.path_ref().id.clone()),
        Arc::new(DatabaseCommandCheckpoint {
            entered: entered_tx,
            release: std::sync::Mutex::new(release_rx),
        }),
    );
    (entered_rx, release_tx)
}

#[cfg(test)]
fn database_command_checkpoint(label: &'static str, handle: &DatabaseHandle) {
    let key = (label, handle.path_ref().id.clone());
    let checkpoint = DATABASE_COMMAND_CHECKPOINTS.lock().unwrap().remove(&key);
    if let Some(checkpoint) = checkpoint {
        let _ = checkpoint.entered.send(());
        let _ = checkpoint
            .release
            .lock()
            .unwrap()
            .recv_timeout(std::time::Duration::from_secs(5));
    }
}

#[cfg(test)]
std::thread_local! {
    static RESOLVE_DATABASE_OPERATIONS: std::cell::RefCell<Vec<PathOperation>> = const {
        std::cell::RefCell::new(Vec::new())
    };
}

#[cfg(all(test, unix))]
pub(crate) fn take_resolve_database_operations() -> Vec<PathOperation> {
    RESOLVE_DATABASE_OPERATIONS.with(|operations| std::mem::take(&mut *operations.borrow_mut()))
}

#[cfg(test)]
fn full_database_operations() -> Vec<PathOperation> {
    vec![
        PathOperation::DatabaseRead,
        PathOperation::DatabaseMutate,
        PathOperation::DatabaseCreate,
        PathOperation::DatabaseExport,
    ]
}

#[cfg(test)]
fn database_app_with_grant(
    registry_dir: &std::path::Path,
    registered_path: &std::path::Path,
    display_name: &str,
    operations: Vec<PathOperation>,
) -> (tauri::AppHandle<tauri::test::MockRuntime>, DatabaseHandle) {
    use tauri::Manager;

    let mut authority = PathAuthority::open(registry_dir.join("registry.json"), vec![]).unwrap();
    let commit =
        authority.grant_persistent_file_for_test(registered_path, display_name, operations);
    let state = AppState::default();
    state.pgn_path_authority.install(authority).unwrap();
    let app = tauri::test::mock_app();
    app.manage(state);
    (app.handle().clone(), DatabaseHandle::new(commit.id))
}

#[cfg(test)]
fn grant_pgn_file(
    app: &tauri::AppHandle<tauri::test::MockRuntime>,
    path: &std::path::Path,
    display_name: &str,
    operations: Vec<PathOperation>,
) -> FileWorkspaceHandle {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let mut guard = state.pgn_path_authority.raw_for_test().lock().unwrap();
    let authority = guard.as_mut().unwrap();
    let commit = authority.grant_persistent_file_for_test(path, display_name, operations);
    FileWorkspaceHandle::new(commit.id)
}

#[cfg(test)]
mod acquisition_cancellation_tests;
#[cfg(test)]
mod conversion_cancellation_tests;
#[cfg(test)]
mod game_cas_tests;
#[cfg(test)]
use game_cas_tests::test_game_stamp;
#[cfg(test)]
mod insert_db_game_tests;

#[cfg(test)]
static CONVERSION_BEFORE_REVISION: crate::infra::test_hooks::KeyedTestHooks<String> =
    crate::infra::test_hooks::KeyedTestHooks::new();
#[cfg(test)]
static CONVERSION_AFTER_COMMIT: crate::infra::test_hooks::KeyedTestHooks<String> =
    crate::infra::test_hooks::KeyedTestHooks::new();

#[cfg(test)]
pub(crate) fn schema_database_case(
    file_stem: &str,
    operations: Vec<PathOperation>,
) -> (
    tempfile::TempDir,
    tauri::AppHandle<tauri::test::MockRuntime>,
    DatabaseHandle,
    std::path::PathBuf,
) {
    use diesel::connection::SimpleConnection;

    let dir = tempfile::tempdir().unwrap();
    let database = dir.path().join(format!("{file_stem}.db3"));
    let mut connection = diesel::SqliteConnection::establish(database.to_str().unwrap()).unwrap();
    connection.batch_execute(CREATE_TABLES_SQL).unwrap();
    connection
        .batch_execute("INSERT INTO Info (Name, Value) VALUES ('Version', '2.0.0');")
        .unwrap();
    drop(connection);

    let (app, handle) = database_app_with_grant(dir.path(), &database, file_stem, operations);
    (dir, app, handle, database)
}

#[cfg(test)]
fn blocking_database_case() -> (
    tempfile::TempDir,
    tauri::AppHandle<tauri::test::MockRuntime>,
    DatabaseHandle,
    std::path::PathBuf,
) {
    schema_database_case("games", full_database_operations())
}

#[cfg(test)]
fn arbitrary_database_case(
    contents: &[u8],
) -> (
    tempfile::TempDir,
    tauri::AppHandle<tauri::test::MockRuntime>,
    DatabaseHandle,
    std::path::PathBuf,
) {
    let dir = tempfile::tempdir().unwrap();
    let database = dir.path().join("arbitrary.db3");
    std::fs::write(&database, contents).unwrap();
    let (app, handle) = database_app_with_grant(
        dir.path(),
        &database,
        "arbitrary",
        full_database_operations(),
    );
    (dir, app, handle, database)
}

#[cfg(test)]
fn seed_search_cache_for_database(
    app: &tauri::AppHandle<tauri::test::MockRuntime>,
    database: &std::path::Path,
) -> crate::SearchResultKey {
    use tauri::Manager;

    let source = IndexSource::from_database(database, 0).unwrap();
    let index_path = get_index_path(database);
    SearchIndexChunk::default()
        .write_to_with_source(&index_path, source.clone())
        .unwrap()
        .expect_durable();
    let identity = crate::SearchIndexIdentity::for_test_database(database, source).unwrap();
    let key = crate::SearchResultKey::new(GameQuery::new(), identity);
    app.state::<AppState>()
        .search_cache
        .insert_result(key.clone(), (Vec::new(), Vec::new()));
    key
}

#[cfg(test)]
fn assert_database_registry_entry_removed(root: &std::path::Path, handle: &DatabaseHandle) {
    assert_database_registry_entry_present(root, handle, false);
}

#[cfg(test)]
fn assert_database_registry_entry_present(
    root: &std::path::Path,
    handle: &DatabaseHandle,
    expected: bool,
) {
    let registry: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("registry.json")).unwrap()).unwrap();
    assert_eq!(
        registry["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"]["id"] == handle.path_ref().id),
        expected
    );
}

#[cfg(test)]
struct FailAtomicExportAt(crate::infra::fs::AtomicFileFaultPoint);

#[cfg(test)]
impl crate::infra::fs::AtomicWriterInjector for FailAtomicExportAt {
    fn inject(&self, point: crate::infra::fs::AtomicFileFaultPoint) -> std::io::Result<()> {
        if point == self.0 {
            Err(std::io::Error::other(format!("injected {point:?} failure")))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
fn install_atomic_export_failure(
    point: crate::infra::fs::AtomicFileFaultPoint,
) -> crate::infra::fs::AtomicInjectorReset {
    crate::infra::fs::install_test_atomic_file_injector(Arc::new(FailAtomicExportAt(point)))
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)] // IPC contract is generated and intentionally stable.
pub async fn convert_pgn(
    progress_id: String,
    files: Vec<FileWorkspaceHandle>,
    database: DatabaseHandle,
    app: tauri::AppHandle,
    title: String,
    description: Option<String>,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    convert_pgn_command_core(
        progress_id,
        files,
        database,
        app,
        title,
        description,
        ticket.as_deref(),
        window.label(),
        &state,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn convert_pgn_command_core<R: tauri::Runtime>(
    progress_id: String,
    files: Vec<FileWorkspaceHandle>,
    database: DatabaseHandle,
    app: tauri::AppHandle<R>,
    title: String,
    description: Option<String>,
    ticket: Option<&str>,
    owner: &str,
    state: &AppState,
) -> Result<(), Error> {
    let operation = match ticket {
        Some(ticket) => state.operations.claim_conversion(ticket, owner)?,
        None => state.operations.accept("convert_pgn")?,
    };
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    let search_cache = Arc::clone(&state.search_cache);
    crate::infra::operations::run_native_operation(operation, "convert_pgn", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                convert_pgn_blocking(
                    &authority,
                    &repository,
                    &search_cache,
                    files,
                    database,
                    None,
                    app,
                    title,
                    description,
                    progress_id,
                    token,
                )
            })
            .await
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub fn prepare_conversion(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<String, Error> {
    state.operations.prepare_conversion(window.label())
}

#[tauri::command]
#[specta::specta]
pub fn cancel_conversion(
    ticket: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<bool, Error> {
    state.operations.cancel_conversion(&ticket, window.label())
}

#[tauri::command]
#[specta::specta]
pub fn release_conversion(
    ticket: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    state.operations.release_conversion(&ticket, window.label())
}

#[derive(Default)]
struct ImportFileContext {
    capability_id: Option<String>,
    display_name: Option<String>,
    game: usize,
    source: SourceReadState,
    parser_diagnostic: Option<String>,
}

impl ImportFileContext {
    fn run(&mut self, work: impl FnOnce(&mut Self) -> Result<(), Error>) -> Result<(), Error> {
        let result = work(self);
        if let Err(error) = &result {
            if matches!(error, Error::Cancellation | Error::AnalysisCancelled) {
                return result;
            }
            let diagnostic = error.diagnostic();
            let diagnostic = match &self.parser_diagnostic {
                Some(cause) => format!("{diagnostic}; parser cause: {cause}"),
                None => diagnostic,
            };
            log::error!(
                "PGN import failed capability_id={:?} file={:?} game={} decompressed_offset={}: {}",
                self.capability_id,
                self.display_name.as_deref().unwrap_or("unknown PGN"),
                self.game,
                self.source.bytes_read.get(),
                diagnostic,
            );
        }
        result
    }
}

pub(crate) struct AccountImportContext {
    pub identity: linked_collections::AccountIdentity,
    pub since_ms: Option<i64>,
    pub coverage_holds: Option<Vec<crate::lichess::CoverageHold>>,
}

struct AccountImporter {
    context: AccountImportContext,
    newest_start_ms: Option<i64>,
    provider_ids: std::collections::HashSet<String>,
}

#[derive(QueryableByName)]
struct AccountGameId {
    #[diesel(sql_type = diesel::sql_types::Integer)]
    game_id: i32,
}

impl AccountImporter {
    fn new(
        db: &mut SqliteConnection,
        context: AccountImportContext,
        cancellation: &CancellationToken,
    ) -> Result<Self, Error> {
        db.batch_execute(
            "CREATE TABLE IF NOT EXISTS AccountProviderGames (
                Provider TEXT NOT NULL,
                ProviderGameID TEXT NOT NULL,
                GameID INTEGER NOT NULL UNIQUE REFERENCES Games(ID) ON DELETE CASCADE,
                PRIMARY KEY (Provider, ProviderGameID)
            );
            CREATE TEMP TABLE IF NOT EXISTS AccountFingerprints (
                GameID INTEGER PRIMARY KEY, Fingerprint TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS temp.AccountFingerprintLookup ON AccountFingerprints(Fingerprint);
            DELETE FROM temp.AccountFingerprints;",
        )?;
        // Bound the decoded row batch. Membership stays in SQLite instead of retaining every
        // stored game's moves in memory while replaying a full-history legacy sync.
        let mut after = -1;
        loop {
            cancellation_check(cancellation)?;
            let (white, black) = diesel::alias!(players as account_white, players as account_black);
            let rows: Vec<(Game, Player, Player)> = games::table
                .inner_join(white.on(games::white_id.eq(white.field(players::id))))
                .inner_join(black.on(games::black_id.eq(black.field(players::id))))
                .select((
                    games::all_columns,
                    white.fields(players::all_columns),
                    black.fields(players::all_columns),
                ))
                .filter(games::id.gt(after))
                .order(games::id.asc())
                .limit(256)
                .load(db)?;
            if rows.is_empty() {
                break;
            }
            for (game, white, black) in rows {
                cancellation_check(cancellation)?;
                after = game.id;
                let stored = TempGame {
                    white_name: (white.id != 0).then_some(white.name).flatten(),
                    black_name: (black.id != 0).then_some(black.name).flatten(),
                    date: game.date,
                    time: game.time,
                    fen: game.fen,
                    moves: game.moves,
                    ..Default::default()
                };
                Self::remember(
                    db,
                    game.id,
                    &linked_collections::semantic_fingerprint(&stored, &context.identity),
                )?;
            }
        }
        Ok(Self {
            context,
            newest_start_ms: None,
            provider_ids: Default::default(),
        })
    }

    fn remember(db: &mut SqliteConnection, game_id: i32, fingerprint: &str) -> Result<(), Error> {
        sql_query("INSERT INTO temp.AccountFingerprints (GameID, Fingerprint) VALUES (?, ?)")
            .bind::<diesel::sql_types::Integer, _>(game_id)
            .bind::<Text, _>(fingerprint)
            .execute(db)?;
        Ok(())
    }

    fn insert(&mut self, db: &mut SqliteConnection, game: &TempGame) -> Result<bool, Error> {
        let start = game
            .date
            .as_ref()
            .zip(game.time.as_ref())
            .and_then(|(date, time)| {
                Some(
                    NaiveDate::parse_from_str(date, "%Y.%m.%d")
                        .ok()?
                        .and_time(NaiveTime::parse_from_str(time, "%H:%M:%S").ok()?)
                        .and_utc()
                        .timestamp_millis(),
                )
            });
        self.newest_start_ms = self.newest_start_ms.into_iter().chain(start).max();
        let identity = &self.context.identity;
        let id = linked_collections::provider_game_id(&game.provider_headers, identity)?;
        let fingerprint = linked_collections::semantic_fingerprint(game, identity);
        let mut inserted = false;
        if let Some(id) = id {
            self.provider_ids.insert(id.clone());
            let known = sql_query("SELECT GameID AS game_id FROM AccountProviderGames WHERE Provider = ? AND ProviderGameID = ?")
                .bind::<Text, _>(&identity.provider)
                .bind::<Text, _>(&id)
                .get_result::<AccountGameId>(db).optional()?;
            if known.is_some() {
                return Ok(false);
            }
            let legacy = sql_query("SELECT f.GameID AS game_id FROM temp.AccountFingerprints f WHERE f.Fingerprint = ? AND NOT EXISTS (SELECT 1 FROM AccountProviderGames p WHERE p.GameID = f.GameID) ORDER BY f.GameID LIMIT 1")
                .bind::<Text, _>(&fingerprint)
                .get_result::<AccountGameId>(db).optional()?;
            let game_id = match legacy {
                Some(row) => row.game_id,
                None => {
                    let game_id = game.insert_to_db(db)?;
                    Self::remember(db, game_id, &fingerprint)?;
                    inserted = true;
                    game_id
                }
            };
            sql_query("INSERT INTO AccountProviderGames (Provider, ProviderGameID, GameID) VALUES (?, ?, ?)")
                .bind::<Text, _>(&identity.provider)
                .bind::<Text, _>(id)
                .bind::<diesel::sql_types::Integer, _>(game_id)
                .execute(db)?;
        } else {
            let known = sql_query("SELECT GameID AS game_id FROM temp.AccountFingerprints WHERE Fingerprint = ? LIMIT 1")
                .bind::<Text, _>(&fingerprint)
                .get_result::<AccountGameId>(db).optional()?;
            if known.is_none() {
                let game_id = game.insert_to_db(db)?;
                Self::remember(db, game_id, &fingerprint)?;
                inserted = true;
            }
        }
        Ok(inserted)
    }

    fn finish(self, db: &mut SqliteConnection) -> Result<(), Error> {
        let cursor = linked_collections::account_sync_cursor(
            &self.context.identity.provider,
            self.context.since_ms,
            self.newest_start_ms,
            &self.provider_ids,
            self.context.coverage_holds.as_deref(),
        );
        update_info_count(db, "AccountSyncCursor", cursor)?;
        db.batch_execute("DELETE FROM temp.AccountFingerprints;")?;
        Ok(())
    }
}

pub(crate) fn account_sync_cursor_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    database: &DatabaseHandle,
    cancellation: &CancellationToken,
) -> Result<Option<i64>, Error> {
    let target = resolve_database(authority, database, PathOperation::DatabaseCreate)?;
    repository.with_write_lock_cancellable(&target, cancellation, || {
        let mut connection = repository.initialization_connection(&target, Some(cancellation))?;
        // New account targets are empty files. Reading their cursor must not initialize them
        // outside the eventual import transaction.
        #[derive(QueryableByName)]
        struct Count {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            count: i64,
        }
        let tables = sql_query("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'")
            .get_result::<Count>(&mut *connection)?
            .count;
        if tables == 0 {
            return Ok(None);
        }
        migrations::validate_existing_database(&mut connection)?;
        let value = info::table
            .filter(info::name.eq("AccountSyncCursor"))
            .select(info::value)
            .first::<Option<String>>(&mut *connection)
            .optional()?
            .flatten();
        value
            .map(|value| {
                value
                    .parse::<i64>()
                    .ok()
                    .filter(|value| *value >= 0)
                    .ok_or_else(|| Error::InvalidInput("invalid account sync cursor".into()))
            })
            .transpose()
    })
}

fn read_import_games(
    source: impl std::io::Read,
    context: &mut ImportFileContext,
    account: Option<&linked_collections::AccountIdentity>,
    cancellation: &CancellationToken,
    mut insert: impl FnMut(TempGame) -> Result<(), Error>,
) -> Result<(), Error> {
    let mut importer = Importer::new(account);
    let mut reader = BufferedReader::new(CancellableRead::new(
        SourceRead::new(source, &context.source),
        cancellation,
    ));
    loop {
        context.source.failed.set(false);
        let parsed = reader.read_game(&mut importer);
        context.game = importer.games_started;
        let parsed = parsed.map_err(|error| {
            match map_read_error(error, cancellation) {
                Error::Cancellation => Error::Cancellation,
                Error::Io(error) if context.source.failed.get() => Error::Io(error),
                error => {
                    // Preserve the parser cause locally before replacing the wire message.
                    context.parser_diagnostic = Some(error.diagnostic());
                    Error::InvalidInput(format!(
                        "{}: game {} could not be read (unterminated comment or tag)",
                        context.display_name.as_deref().unwrap_or("unknown PGN"),
                        context.game,
                    ))
                }
            }
        })?;
        let Some(parsed_game) = parsed else {
            return Ok(());
        };
        cancellation_check(cancellation)?;
        if let Some(game) = parsed_game {
            insert(game)?;
        }
    }
}

// Individual Arc handles the closure must own: BlockingGateway::spawn is
// `'static` and AppState is not Clone. A bundle type was rejected (plan
// decision D-B).
#[allow(clippy::too_many_arguments)]
pub(crate) fn convert_pgn_blocking<R: tauri::Runtime>(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    files: Vec<FileWorkspaceHandle>,
    database: DatabaseHandle,
    account: Option<AccountImportContext>,
    app: tauri::AppHandle<R>,
    title: String,
    description: Option<String>,
    progress_id: String,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    #[cfg(test)]
    database_command_checkpoint("convert_pgn", &database);
    let target = resolve_database(authority, &database, PathOperation::DatabaseCreate)?;

    if files.is_empty() {
        return Ok(());
    }

    let description = description.unwrap_or_default();
    let start = Instant::now();
    let mut imported_games = 0usize;
    let mut content_validated = false;
    let result = repository.with_write_lock_cancellable(&target, cancellation, || {
        guard_database_mutation(authority, &database, PathOperation::DatabaseCreate)?;
        if let Some(collections) = authority.collections()? {
            for source in &files {
                collections.guard_conversion_source(authority, source, cancellation)?;
            }
        }
        let mut database_connection =
            repository.initialization_connection(&target, Some(cancellation))?;
        let db = &mut *database_connection;
        db.transaction::<_, Error, _>(|db| {
            bump_revision_in_transaction(db, target.path(), cancellation, |db| {
                let (database_was_created, validated) =
                    migrations::prepare_database_with_validation(db, &title, &description)?;
                content_validated = validated;
                let mut account_import = account
                    .map(|account| AccountImporter::new(db, account, cancellation))
                    .transpose()?;

                for file_handle in files {
                    let mut context = ImportFileContext {
                        capability_id: Some(file_handle.path_ref().id.clone()),
                        ..Default::default()
                    };
                    context.run(|context| {
                        cancellation_check(cancellation)?;
                        let file = authority.with_mut(|authority| {
                            context.display_name =
                                Some(authority.display_name(file_handle.path_ref())?);
                            let resolved = authority.resolve(
                                file_handle.path_ref(),
                                PathOperation::ReadPgn,
                                &[],
                            )?;
                            resolved.into_read_file()
                        })??;
                        let current_file_name = context.display_name.clone();
                        let extension = current_file_name
                            .as_deref()
                            .and_then(|name| std::path::Path::new(name).extension())
                            .map(std::ffi::OsStr::to_os_string);
                        let uncompressed: Box<dyn std::io::Read + Send> =
                            if extension.as_deref() == Some("bz2".as_ref()) {
                                Box::new(bzip2::read::MultiBzDecoder::new(file))
                            } else if extension.as_deref() == Some("zst".as_ref()) {
                                Box::new(zstd::Decoder::new(file)?)
                            } else {
                                Box::new(file)
                            };

                        let identity = account_import
                            .as_ref()
                            .map(|importer| importer.context.identity.clone());
                        read_import_games(
                            uncompressed,
                            context,
                            identity.as_ref(),
                            cancellation,
                            |game| {
                                let inserted = match account_import.as_mut() {
                                    Some(importer) => importer.insert(db, &game)?,
                                    None => {
                                        game.insert_to_db(db)?;
                                        true
                                    }
                                };
                                if !inserted {
                                    return Ok(());
                                }
                                if imported_games.is_multiple_of(1000) {
                                    let _ = ConvertProgress {
                                        id: progress_id.clone(),
                                        imported_games: imported_games as u32,
                                        elapsed_ms: start.elapsed().as_millis() as u32,
                                        source_file_name: current_file_name.clone(),
                                    }
                                    .emit(&app);
                                }
                                imported_games += 1;
                                Ok(())
                            },
                        )
                    })?;
                }

                if let Some(importer) = account_import {
                    importer.finish(db)?;
                }

                if database_was_created {
                    create_required_indexes(db)?;
                }
                update_database_counts(db)?;
                #[cfg(test)]
                CONVERSION_BEFORE_REVISION.run(&progress_id);
                Ok(())
            })
        })?;
        if content_validated {
            content_validation::publish_committed_pass(repository, authority, &database, &target);
        }
        Ok(())
    });
    finish_search_cache_after_transaction(result, search_cache, &target)?;

    #[cfg(test)]
    CONVERSION_AFTER_COMMIT.run(&progress_id);

    let _ = ConvertProgress {
        id: progress_id,
        imported_games: imported_games as u32,
        elapsed_ms: start.elapsed().as_millis() as u32,
        source_file_name: None,
    }
    .emit(&app);
    Ok(())
}

pub fn generate_search_index(
    handle: &DatabaseHandle,
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    cancellation_check(cancellation)?;
    let linked = authority
        .collections()?
        .map(|service| service.is_linked(handle))
        .transpose()?
        .unwrap_or(false);
    if let Some(service) = authority.collections()? {
        service.resolve_database(authority, handle, PathOperation::DatabaseRead, cancellation)?;
    }
    let target = resolve_database(
        authority,
        handle,
        if linked {
            PathOperation::DatabaseRead
        } else {
            PathOperation::DatabaseMutate
        },
    )?;
    info!("Preparing search index for {:?}", target.path());
    repository.with_write_lock_cancellable(&target, cancellation, || {
        guard_database_mutation(
            authority,
            handle,
            if linked {
                PathOperation::DatabaseRead
            } else {
                PathOperation::DatabaseMutate
            },
        )?;
        repository.with_index_lock_cancellable(&target, cancellation, || {
            generate_search_index_locked(
                &target,
                repository,
                search_cache,
                cancellation,
                authority,
                handle,
            )
        })
    })
}

#[derive(Queryable)]
struct SearchIndexGameRecord {
    id: i32,
    white_id: i32,
    black_id: i32,
    date: Option<String>,
    result: Option<String>,
    moves: Vec<u8>,
    fen: Option<String>,
    pawn_home: i32,
    white_material: i32,
    black_material: i32,
    white_elo: Option<i32>,
    black_elo: Option<i32>,
}

fn generate_search_index_locked(
    target: &DatabaseFileTarget,
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    cancellation: &CancellationToken,
    authority: &crate::infra::path_authority::SharedPathAuthority,
    file: &DatabaseHandle,
) -> Result<(), Error> {
    cancellation_check(cancellation)?;
    let linked = authority
        .collections()?
        .map(|service| service.is_linked(file))
        .transpose()?
        .unwrap_or(false);
    let mut database_connection = if linked {
        repository.connection(target, Some(cancellation))?
    } else {
        get_db_or_create(repository, target, Some(cancellation), authority, file)?
    };
    let db = &mut *database_connection;
    let index_leaf = search_index::preferred_sidecar_leaf(target.leaf());

    info!("Generating search index for {:?}", target.path());
    let start = Instant::now();

    let source = IndexSource::from_database_identity(&repository.database_identity_expected(
        target,
        target.identity(),
        Some(cancellation),
    )?)?;
    let outcome = sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
        let rows = games::table
            .select((
                games::id,
                games::white_id,
                games::black_id,
                games::date,
                games::result,
                games::moves,
                games::fen,
                games::pawn_home,
                games::white_material,
                games::black_material,
                games::white_elo,
                games::black_elo,
            ))
            .load_iter::<SearchIndexGameRecord, DefaultLoadingMode>(db)?
            .map(|row| {
                cancellation_check(cancellation)?;
                let game = row.map_err(Error::from)?;
                SearchGameEntry::from_game_data_cancellable(
                    crate::db::search_index::SearchGameData {
                        id: game.id,
                        white_id: game.white_id,
                        black_id: game.black_id,
                        date: game.date,
                        result: game.result,
                        moves: game.moves,
                        fen: game.fen,
                        pawn_home: game.pawn_home,
                        white_material: game.white_material,
                        black_material: game.black_material,
                        white_elo: game.white_elo,
                        black_elo: game.black_elo,
                    },
                    cancellation,
                )
            });
        search_cache.invalidate_database(target);
        search_index::write_entries_to_at(target.parent(), &index_leaf, source, rows, cancellation)
    })?;
    // Publication has committed once `write_entries_to_at` returns. From here on the durability
    // and cache-invalidation tail must finish even if cancellation arrives concurrently.
    let durability = crate::infra::fs::require_durable(
        outcome,
        crate::error::DurabilityStage::SearchIndexReplacement,
    );
    search_cache.invalidate_database(target);
    durability?;

    info!("Search index generated in {:?}", start.elapsed());
    Ok(())
}

#[derive(Serialize, Type)]
pub struct DatabaseInfo {
    title: String,
    description: String,
    player_count: i32,
    event_count: i32,
    game_count: i32,
    storage_size: String,
    filename: String,
    indexed: bool,
}

#[derive(QueryableByName, Debug, Serialize)]
struct IndexInfo {
    #[diesel(sql_type = Text, column_name = "name")]
    _name: String,
}

#[derive(QueryableByName)]
struct IndexListInfo {
    #[diesel(sql_type = Text)]
    name: String,
    #[diesel(sql_type = diesel::sql_types::Integer)]
    unique_value: i32,
    #[diesel(sql_type = diesel::sql_types::Integer)]
    partial: i32,
}

#[derive(QueryableByName)]
struct IndexSqlInfo {
    #[diesel(sql_type = Text)]
    sql: String,
}

const REQUIRED_GAME_INDEXES: [(&str, &str); 7] = [
    ("games_date_idx", "Date"),
    ("games_white_idx", "WhiteID"),
    ("games_black_idx", "BlackID"),
    ("games_result_idx", "Result"),
    ("games_white_elo_idx", "WhiteElo"),
    ("games_black_elo_idx", "BlackElo"),
    ("games_plycount_idx", "PlyCount"),
];

fn check_index_exists(conn: &mut SqliteConnection) -> Result<bool, Error> {
    for (index_name, expected_column) in REQUIRED_GAME_INDEXES {
        let definitions: Vec<IndexListInfo> = sql_query(
            "SELECT name, \"unique\" AS unique_value, partial
             FROM pragma_index_list('Games') WHERE name = ?",
        )
        .bind::<Text, _>(index_name)
        .load(conn)?;
        if definitions.len() != 1
            || definitions[0].name != index_name
            || definitions[0].unique_value != 0
            || definitions[0].partial != 0
        {
            return Ok(false);
        }
        let indexes: Vec<IndexInfo> = sql_query("SELECT name FROM pragma_index_info(?)")
            .bind::<Text, _>(index_name)
            .load(conn)?;
        if indexes.len() != 1 || indexes[0]._name != expected_column {
            return Ok(false);
        }
        let stored: IndexSqlInfo = sql_query(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ? AND tbl_name = 'Games'",
        )
        .bind::<Text, _>(index_name)
        .get_result(conn)?;
        let normalize = |sql: &str| {
            sql.chars()
                .filter(|character| !character.is_whitespace())
                .collect::<String>()
                .to_ascii_uppercase()
        };
        if normalize(&stored.sql)
            != format!("CREATEINDEX{index_name}ONGAMES({expected_column})").to_ascii_uppercase()
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn create_required_indexes(conn: &mut SqliteConnection) -> Result<(), Error> {
    conn.transaction::<_, Error, _>(create_required_indexes_body)
}

fn create_required_indexes_body(conn: &mut SqliteConnection) -> Result<(), Error> {
    // Rebuilding the named contract inside one transaction repairs a
    // same-name but semantically wrong/partial/collated index as well as
    // a missing one. Readers observe either the former set or the full
    // canonical set, never a partial repair.
    conn.batch_execute(DELETE_INDEXES_SQL)?;
    conn.batch_execute(INDEXES_SQL)?;
    if !check_index_exists(conn)? {
        return Err(Error::InvalidInput(
            "Required Games indexes were not created with their expected definitions".into(),
        ));
    }
    Ok(())
}

fn drop_required_indexes_body(conn: &mut SqliteConnection) -> Result<(), Error> {
    conn.batch_execute(DELETE_INDEXES_SQL)?;
    if check_index_exists(conn)? {
        return Err(Error::InvalidInput(
            "Required Games indexes remain after deletion".into(),
        ));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_db_info<R: tauri::Runtime>(
    file: DatabaseHandle,
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
) -> Result<DatabaseInfo, Error> {
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    let read_file = file.clone();
    let read_repository = Arc::clone(&repository);
    let read_authority = authority.clone();
    let metadata = crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "get_db_info",
        move || get_db_info_blocking(&read_authority, &read_repository, read_file),
    )
    .await?;
    if let Some((path, identity)) = metadata.scan {
        content_validation::schedule(
            repository,
            authority,
            &state.operations,
            app,
            file,
            path,
            identity,
        )
        .await;
    }
    Ok(metadata.info)
}

struct DatabaseMetadata {
    info: DatabaseInfo,
    scan: Option<(std::path::PathBuf, DatabaseIdentity)>,
}

impl std::ops::Deref for DatabaseMetadata {
    type Target = DatabaseInfo;
    fn deref(&self) -> &Self::Target {
        &self.info
    }
}

fn get_db_info_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
) -> Result<DatabaseMetadata, Error> {
    let target = resolve_database(authority, &file, PathOperation::DatabaseRead)?;

    info!("get_db_info {:?}", target.path());

    let mut database_connection = get_db_or_create(repository, &target, None, authority, &file)?;
    let db = &mut *database_connection;
    linked_collections::read_snapshot(db, authority, &file, |db| {
        let info_records: Vec<Info> = info::table.load(db)?;

        let get_info_value = |key: &str| -> Option<String> {
            info_records
                .iter()
                .find(|i| i.name == key)
                .and_then(|i| i.value.clone())
        };

        let title = get_info_value("Title").unwrap_or_else(|| "Untitled".to_string());
        let description = get_info_value("Description").unwrap_or_default();
        let player_count = get_info_value("PlayerCount")
            .and_then(|v| v.parse::<i32>().ok())
            .unwrap_or(0);
        let game_count = get_info_value("GameCount")
            .and_then(|v| v.parse::<i32>().ok())
            .unwrap_or(0);
        let event_count = get_info_value("EventCount")
            .and_then(|v| v.parse::<i32>().ok())
            .unwrap_or(0);

        let identity = repository.database_identity(&target)?;
        let storage_size = identity.length.to_string();
        let scan = content_validation::inspect(repository, &target, &identity, authority, &file)?
            .then(|| (target.path().to_path_buf(), identity));
        let filename = target
            .path()
            .file_name()
            .ok_or_else(|| Error::InvalidInput("Database path has no filename".into()))?
            .to_string_lossy();

        let is_indexed = check_index_exists(db)?;
        Ok(DatabaseMetadata {
            scan,
            info: DatabaseInfo {
                title,
                description,
                player_count,
                game_count,
                event_count,
                storage_size,
                filename: filename.to_string(),
                indexed: is_indexed,
            },
        })
    })
}

#[tauri::command]
#[specta::specta]
pub async fn create_indexes(
    file: DatabaseHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let operation = state.operations.accept("create_indexes")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    crate::infra::operations::run_native_operation(operation, "create_indexes", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |cancellation| {
                create_indexes_blocking(&authority, &repository, file, cancellation)
            })
            .await
    })
    .await
}

fn run_required_index_ddl(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
    cancellation: &CancellationToken,
    label: &'static str,
    body: fn(&mut SqliteConnection) -> Result<(), Error>,
) -> Result<(), Error> {
    #[cfg(test)]
    database_command_checkpoint(label, &file);
    #[cfg(not(test))]
    let _ = label;
    let target = resolve_database(authority, &file, PathOperation::DatabaseMutate)?;

    repository.with_write_lock_cancellable(&target, cancellation, || {
        guard_database_mutation(authority, &file, PathOperation::DatabaseMutate)?;
        repository.with_index_lock_cancellable(&target, cancellation, || {
            let mut database_connection =
                get_db_or_create(repository, &target, Some(cancellation), authority, &file)?;
            let db = &mut *database_connection;
            sqlite_cancellation::with_sqlite_cancellation_transaction(db, cancellation, body)
        })
    })
}

fn create_indexes_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    run_required_index_ddl(
        authority,
        repository,
        file,
        cancellation,
        "create_indexes",
        create_required_indexes_body,
    )
}

#[tauri::command]
#[specta::specta]
pub async fn delete_indexes(
    file: DatabaseHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let operation = state.operations.accept("delete_indexes")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    crate::infra::operations::run_native_operation(operation, "delete_indexes", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |cancellation| {
                delete_indexes_blocking(&authority, &repository, file, cancellation)
            })
            .await
    })
    .await
}

fn delete_indexes_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    run_required_index_ddl(
        authority,
        repository,
        file,
        cancellation,
        "delete_indexes",
        drop_required_indexes_body,
    )
}

#[tauri::command]
#[specta::specta]
pub async fn edit_db_info(
    file: DatabaseHandle,
    title: Option<String>,
    description: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let operation = state.operations.accept("edit_db_info")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    let search_cache = Arc::clone(&state.search_cache);
    crate::infra::operations::run_native_operation(operation, "edit_db_info", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                edit_db_info_blocking(
                    &authority,
                    &repository,
                    &search_cache,
                    file,
                    title,
                    description,
                    token,
                )
            })
            .await
    })
    .await
}

fn edit_db_info_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    file: DatabaseHandle,
    title: Option<String>,
    description: Option<String>,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    #[cfg(test)]
    database_command_checkpoint("edit_db_info", &file);
    let target = resolve_database(authority, &file, PathOperation::DatabaseMutate)?;

    with_validated_mutation(
        repository,
        search_cache,
        &target,
        cancellation,
        authority,
        &file,
        |db| {
            if let Some(title) = title {
                diesel::insert_into(info::table)
                    .values((info::name.eq("Title"), info::value.eq(title.clone())))
                    .on_conflict(info::name)
                    .do_update()
                    .set(info::value.eq(title))
                    .execute(db)?;
            }

            if let Some(description) = description {
                diesel::insert_into(info::table)
                    .values((
                        info::name.eq("Description"),
                        info::value.eq(description.clone()),
                    ))
                    .on_conflict(info::name)
                    .do_update()
                    .set(info::value.eq(description))
                    .execute(db)?;
            }
            Ok(())
        },
    )
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, Type)]
pub enum Sides {
    BlackWhite,
    WhiteBlack,
    Any,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, Type)]
pub enum GameSort {
    #[default]
    #[serde(rename = "id")]
    Id,
    #[serde(rename = "date")]
    Date,
    #[serde(rename = "whiteElo")]
    WhiteElo,
    #[serde(rename = "blackElo")]
    BlackElo,
    #[serde(rename = "ply_count")]
    PlyCount,
}

#[derive(Default, Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, Type)]
pub enum SortDirection {
    #[serde(rename = "asc")]
    Asc,
    #[default]
    #[serde(rename = "desc")]
    Desc,
}

#[derive(Default, Debug, Clone, Deserialize, PartialEq, Eq, Hash, Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryOptions<SortT> {
    pub skip_count: bool,
    #[specta(optional)]
    pub page: Option<i32>,
    #[specta(optional)]
    pub page_size: Option<i32>,
    pub sort: SortT,
    pub direction: SortDirection,
}

const MAX_PAGE_SIZE: i32 = 1000;

fn pagination_limit_offset(
    page: Option<i32>,
    page_size: Option<i32>,
) -> Result<(Option<i64>, Option<i64>), Error> {
    if let Some(page_size) = page_size {
        if !(1..=MAX_PAGE_SIZE).contains(&page_size) {
            return Err(Error::InvalidInput(format!(
                "page size must be between 1 and {MAX_PAGE_SIZE}"
            )));
        }
    }

    if let Some(page) = page {
        if page < 1 {
            return Err(Error::InvalidInput("page must be at least 1".into()));
        }
    }

    let limit = page_size.map(i64::from);
    let offset = page.map(|page| (i64::from(page) - 1) * page_size.map(i64::from).unwrap_or(10));

    Ok((limit, offset))
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq, Hash, Type)]
pub struct GameQuery {
    #[specta(optional)]
    pub options: Option<QueryOptions<GameSort>>,
    #[specta(optional)]
    pub player1: Option<i32>,
    #[specta(optional)]
    pub player2: Option<i32>,
    #[specta(optional)]
    pub tournament_id: Option<i32>,
    #[specta(optional)]
    pub start_date: Option<String>,
    #[specta(optional)]
    pub end_date: Option<String>,
    #[specta(optional)]
    pub range1: Option<(i32, i32)>,
    #[specta(optional)]
    pub range2: Option<(i32, i32)>,
    #[specta(optional)]
    pub sides: Option<Sides>,
    #[specta(optional)]
    pub outcome: Option<String>,
    #[specta(optional)]
    pub position: Option<PositionQueryJs>,
    #[specta(optional)]
    pub wanted_result: Option<String>,
    #[specta(optional)]
    pub exclude_fast_events: Option<bool>,
}

impl GameQuery {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn position(mut self, position: PositionQueryJs) -> Self {
        self.position = Some(position);
        self
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct QueryResponse<T> {
    pub data: T,
    pub count: Option<i32>,
}

#[tauri::command]
#[specta::specta]
pub async fn get_games(
    file: DatabaseHandle,
    query: GameQuery,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<QueryResponse<Vec<NormalizedGame>>, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "get_games")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    crate::infra::operations::run_native_operation(operation, "get_games", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                get_games_blocking(&authority, &repository, file, query, token)
            })
            .await
    })
    .await
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct GameSignature {
    pub white: Option<String>,
    pub black: Option<String>,
    pub event: Option<String>,
    pub site: Option<String>,
    pub date: Option<String>,
    pub round: Option<String>,
}

#[derive(Clone, Copy)]
enum SignatureNormalization {
    Name,
    Date,
    Plain,
}

#[derive(Clone, Copy)]
enum SignatureField {
    White,
    Black,
    Event,
    Site,
    Date,
    Round,
}

impl SignatureField {
    const ALL: [Self; 6] = [
        Self::White,
        Self::Black,
        Self::Event,
        Self::Site,
        Self::Date,
        Self::Round,
    ];

    fn column(self) -> (&'static str, SignatureNormalization) {
        match self {
            Self::White => ("w.Name", SignatureNormalization::Name),
            Self::Black => ("b.Name", SignatureNormalization::Name),
            Self::Event => ("e.Name", SignatureNormalization::Name),
            Self::Site => ("s.Name", SignatureNormalization::Name),
            Self::Date => ("g.Date", SignatureNormalization::Date),
            Self::Round => ("g.Round", SignatureNormalization::Plain),
        }
    }

    fn normalize(self, value: &Option<String>) -> Option<String> {
        let (_, kind) = self.column();
        value
            .as_ref()
            .filter(|value| !kind.markers().any(|marker| marker == value.as_str()))
            .cloned()
    }

    fn normalized_sql(self) -> String {
        let (column, kind) = self.column();
        kind.markers()
            .fold(column.to_owned(), |expression, marker| {
                format!("NULLIF({expression}, '{marker}')")
            })
    }
}

impl SignatureNormalization {
    fn markers(self) -> impl Iterator<Item = &'static str> {
        GameSignature::ABSENT_MARKERS.into_iter().chain(match self {
            Self::Name => Some(GameSignature::ABSENT_NAME),
            Self::Date => Some(GameSignature::ABSENT_DATE),
            Self::Plain => None,
        })
    }
}

impl GameSignature {
    const ABSENT_MARKERS: [&'static str; 2] = ["", "?"];
    const ABSENT_DATE: &'static str = "????.??.??";
    const ABSENT_NAME: &'static str = "Unknown";

    fn normalized(&self) -> Self {
        Self {
            white: SignatureField::White.normalize(&self.white),
            black: SignatureField::Black.normalize(&self.black),
            event: SignatureField::Event.normalize(&self.event),
            site: SignatureField::Site.normalize(&self.site),
            date: SignatureField::Date.normalize(&self.date),
            round: SignatureField::Round.normalize(&self.round),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct LinkedGameIdentity {
    pub locator: linked_collections::LinkedGameLocator,
    pub signature: GameSignature,
}

#[derive(Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DbGameLookup {
    Found { game: Box<NormalizedGame> },
    Missing,
}

#[tauri::command]
#[specta::specta]
pub async fn get_db_game(
    file: DatabaseHandle,
    game_id: i32,
    linked: Option<LinkedGameIdentity>,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<DbGameLookup, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "get_db_game")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    crate::infra::operations::run_native_operation(operation, "get_db_game", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                get_db_game_blocking(
                    &authority,
                    &repository,
                    file,
                    game_id,
                    linked.as_ref(),
                    token,
                )
            })
            .await
    })
    .await
}

fn get_db_game_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
    game_id: i32,
    linked: Option<&LinkedGameIdentity>,
    cancellation: &CancellationToken,
) -> Result<DbGameLookup, Error> {
    cancellation_check(cancellation)?;
    if !authority.with_mut(|authority| authority.has_persistent_id(&file.path_ref().id))? {
        return Ok(DbGameLookup::Missing);
    }
    // Resolve collections first so a lost disposable cache can be rebuilt. Ordinary databases
    // still require an existing file target before opening a connection.
    let target = match resolve_database(authority, &file, PathOperation::DatabaseRead) {
        Ok(target) => target,
        Err(error) if error.is_missing_entry() => return Ok(DbGameLookup::Missing),
        Err(error) => return Err(error),
    };
    let mut connection =
        match get_db_or_create(repository, &target, Some(cancellation), authority, &file) {
            Ok(connection) => connection,
            Err(error) if error.is_missing_entry() => return Ok(DbGameLookup::Missing),
            Err(error) => return Err(error),
        };
    connection.transaction::<_, Error, _>(|db| {
        let id = if let Some(identity) = linked {
            match linked_collections::recent_game_id(
                db,
                &file,
                authority,
                identity,
                game_id,
                cancellation,
            )? {
                Some(id) => id,
                None => return Ok(DbGameLookup::Missing),
            }
        } else {
            game_id
        };
        let rows = load_games(
            db,
            authority,
            &file,
            GameQuery::new(),
            Some(id),
            cancellation,
        )?;
        Ok(match rows.data.into_iter().next() {
            Some(game) => DbGameLookup::Found {
                game: Box::new(game),
            },
            None => DbGameLookup::Missing,
        })
    })
}

type SidesAnyEloExpr<QS> = Box<
    dyn BoxableExpression<
        QS,
        Sqlite,
        SqlType = diesel::sql_types::Nullable<diesel::sql_types::Bool>,
    >,
>;

fn sides_any_elo_band_predicate<QS>(
    player1: Option<i32>,
    range1: Option<(i32, i32)>,
    range2: Option<(i32, i32)>,
) -> Option<SidesAnyEloExpr<QS>>
where
    QS: 'static,
    games::white_id: SelectableExpression<QS>,
    games::black_id: SelectableExpression<QS>,
    games::white_elo: SelectableExpression<QS>,
    games::black_elo: SelectableExpression<QS>,
{
    if range1.is_none() && range2.is_none() {
        return None;
    }

    let white_as_player = {
        let mut terms: Vec<SidesAnyEloExpr<QS>> = Vec::new();
        if let Some((lo, hi)) = range1 {
            terms.push(Box::new(games::white_elo.between(lo, hi)));
        }
        if let Some((lo, hi)) = range2 {
            terms.push(Box::new(games::black_elo.between(lo, hi)));
        }
        let band = terms
            .into_iter()
            .reduce(|acc, term| Box::new(acc.and(term)) as SidesAnyEloExpr<QS>)?;
        match player1 {
            Some(id) => Box::new(band.and(games::white_id.eq(id))) as SidesAnyEloExpr<QS>,
            None => band,
        }
    };
    let black_as_player = {
        let mut terms: Vec<SidesAnyEloExpr<QS>> = Vec::new();
        if let Some((lo, hi)) = range1 {
            terms.push(Box::new(games::black_elo.between(lo, hi)));
        }
        if let Some((lo, hi)) = range2 {
            terms.push(Box::new(games::white_elo.between(lo, hi)));
        }
        let band = terms
            .into_iter()
            .reduce(|acc, term| Box::new(acc.and(term)) as SidesAnyEloExpr<QS>)?;
        match player1 {
            Some(id) => Box::new(band.and(games::black_id.eq(id))) as SidesAnyEloExpr<QS>,
            None => band,
        }
    };
    Some(Box::new(white_as_player.or(black_as_player)))
}

fn get_games_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
    query: GameQuery,
    cancellation: &CancellationToken,
) -> Result<QueryResponse<Vec<NormalizedGame>>, Error> {
    cancellation_check(cancellation)?;
    let target = resolve_database(authority, &file, PathOperation::DatabaseRead)?;

    let mut database_connection =
        get_db_or_create(repository, &target, Some(cancellation), authority, &file)?;
    let db = &mut *database_connection;
    load_games(db, authority, &file, query, None, cancellation)
}

fn load_games(
    db: &mut SqliteConnection,
    authority: &crate::infra::path_authority::SharedPathAuthority,
    file: &DatabaseHandle,
    query: GameQuery,
    game_id: Option<i32>,
    cancellation: &CancellationToken,
) -> Result<QueryResponse<Vec<NormalizedGame>>, Error> {
    db.transaction::<_, Error, _>(|db| {
        let mut count: Option<i64> = None;
        let query_options = query.options.unwrap_or_default();

        let (white_players, black_players) = diesel::alias!(players as white, players as black);
        let mut sql_query = games::table
            .inner_join(white_players.on(games::white_id.eq(white_players.field(players::id))))
            .inner_join(black_players.on(games::black_id.eq(black_players.field(players::id))))
            .inner_join(events::table.on(games::event_id.eq(events::id)))
            .inner_join(sites::table.on(games::site_id.eq(sites::id)))
            .into_boxed();
        let mut count_query = games::table.into_boxed();

        if let Some(id) = game_id {
            sql_query = sql_query.filter(games::id.eq(id));
            count_query = count_query.filter(games::id.eq(id));
        }

        // if let Some(speed) = query.speed {
        //     sql_query = sql_query.filter(games::speed.eq(speed as i32));
        //     count_query = count_query.filter(games::speed.eq(speed as i32));
        // }

        if let Some(outcome) = query.outcome {
            sql_query = sql_query.filter(games::result.eq(outcome.clone()));
            count_query = count_query.filter(games::result.eq(outcome));
        }

        if let Some(start_date) = query.start_date {
            let date_filter = search::date_interval_endpoint_sql(false).ge(start_date);
            sql_query = sql_query.filter(date_filter.clone());
            count_query = count_query.filter(date_filter);
        }

        if let Some(end_date) = query.end_date {
            let date_filter = search::date_interval_endpoint_sql(true).le(end_date);
            sql_query = sql_query.filter(date_filter.clone());
            count_query = count_query.filter(date_filter);
        }

        if let Some(tournament_id) = query.tournament_id {
            sql_query = sql_query.filter(games::event_id.eq(tournament_id));
            count_query = count_query.filter(games::event_id.eq(tournament_id));
        }

        let (limit, offset) = pagination_limit_offset(query_options.page, query_options.page_size)?;
        if let Some(limit) = limit {
            sql_query = sql_query.limit(limit);
        }

        if let Some(offset) = offset {
            sql_query = sql_query.offset(offset);
        }

        match query.sides {
            Some(Sides::BlackWhite) => {
                if let Some(player1) = query.player1 {
                    sql_query = sql_query.filter(games::black_id.eq(player1));
                    count_query = count_query.filter(games::black_id.eq(player1));
                }
                if let Some(player2) = query.player2 {
                    sql_query = sql_query.filter(games::white_id.eq(player2));
                    count_query = count_query.filter(games::white_id.eq(player2));
                }

                if let Some(range1) = query.range1 {
                    sql_query = sql_query.filter(games::black_elo.between(range1.0, range1.1));
                    count_query = count_query.filter(games::black_elo.between(range1.0, range1.1));
                }

                if let Some(range2) = query.range2 {
                    sql_query = sql_query.filter(games::white_elo.between(range2.0, range2.1));
                    count_query = count_query.filter(games::white_elo.between(range2.0, range2.1));
                }
            }
            Some(Sides::WhiteBlack) => {
                if let Some(player1) = query.player1 {
                    sql_query = sql_query.filter(games::white_id.eq(player1));
                    count_query = count_query.filter(games::white_id.eq(player1));
                }
                if let Some(player2) = query.player2 {
                    sql_query = sql_query.filter(games::black_id.eq(player2));
                    count_query = count_query.filter(games::black_id.eq(player2));
                }

                if let Some(range1) = query.range1 {
                    sql_query = sql_query.filter(games::white_elo.between(range1.0, range1.1));
                    count_query = count_query.filter(games::white_elo.between(range1.0, range1.1));
                }

                if let Some(range2) = query.range2 {
                    sql_query = sql_query.filter(games::black_elo.between(range2.0, range2.1));
                    count_query = count_query.filter(games::black_elo.between(range2.0, range2.1));
                }
            }
            Some(Sides::Any) => {
                if let Some(player1) = query.player1 {
                    sql_query = sql_query
                        .filter(games::white_id.eq(player1).or(games::black_id.eq(player1)));
                    count_query = count_query
                        .filter(games::white_id.eq(player1).or(games::black_id.eq(player1)));
                }
                if let Some(player2) = query.player2 {
                    sql_query = sql_query
                        .filter(games::white_id.eq(player2).or(games::black_id.eq(player2)));
                    count_query = count_query
                        .filter(games::white_id.eq(player2).or(games::black_id.eq(player2)));
                }

                if let Some(predicate) =
                    sides_any_elo_band_predicate(query.player1, query.range1, query.range2)
                {
                    sql_query = sql_query.filter(predicate);
                }
                if let Some(predicate) =
                    sides_any_elo_band_predicate(query.player1, query.range1, query.range2)
                {
                    count_query = count_query.filter(predicate);
                }
            }
            None => {}
        }

        sql_query = match query_options.sort {
            GameSort::Id => match query_options.direction {
                SortDirection::Asc => sql_query.order(games::id.asc()),
                SortDirection::Desc => sql_query.order(games::id.desc()),
            },
            GameSort::Date => match query_options.direction {
                SortDirection::Asc => sql_query.order((games::date.asc(), games::time.asc())),
                SortDirection::Desc => sql_query.order((games::date.desc(), games::time.desc())),
            },
            GameSort::WhiteElo => match query_options.direction {
                SortDirection::Asc => sql_query.order(games::white_elo.asc()),
                SortDirection::Desc => sql_query.order(games::white_elo.desc()),
            },
            GameSort::BlackElo => match query_options.direction {
                SortDirection::Asc => sql_query.order(games::black_elo.asc()),
                SortDirection::Desc => sql_query.order(games::black_elo.desc()),
            },
            GameSort::PlyCount => match query_options.direction {
                SortDirection::Asc => sql_query.order(games::ply_count.asc()),
                SortDirection::Desc => sql_query.order(games::ply_count.desc()),
            },
        };

        if !query_options.skip_count {
            count = Some(sqlite_cancellation::with_sqlite_cancellation(
                cancellation,
                || count_query.select(diesel::dsl::count(games::id)).first(db),
            )?);
        }

        // println!(
        //     "{:?}\n",
        //     diesel::debug_query::<diesel::sqlite::Sqlite, _>(&sql_query)
        // );

        let games: Vec<(Game, Player, Player, Event, Site)> =
            sqlite_cancellation::with_sqlite_cancellation(cancellation, || sql_query.load(db))?;
        cancellation_check(cancellation)?;
        let mut normalized_games = normalize_games(games, cancellation)?;
        linked_collections::qualify_games(db, file, authority, &mut normalized_games)?;

        Ok(QueryResponse {
            data: normalized_games,
            count: count.map(|c| c as i32),
        })
    })
}

/// Hash the stored row, independently of joined names and decoded movetext.
fn game_row_stamp(game: &Game) -> String {
    use sha2::{Digest, Sha256};

    fn field(hash: &mut Sha256, value: Option<&[u8]>) {
        match value {
            None => hash.update([0]),
            Some(bytes) => {
                hash.update([1]);
                hash.update((bytes.len() as u64).to_be_bytes());
                hash.update(bytes);
            }
        }
    }
    let mut hash = Sha256::new();
    macro_rules! integer {
        ($value:expr) => {
            field(&mut hash, Some(&$value.to_be_bytes()))
        };
    }
    macro_rules! optional_integer {
        ($value:expr) => {
            field(
                &mut hash,
                $value
                    .map(i32::to_be_bytes)
                    .as_ref()
                    .map(|bytes| bytes.as_slice()),
            )
        };
    }
    macro_rules! text {
        ($value:expr) => {
            field(&mut hash, $value.as_deref().map(str::as_bytes))
        };
    }
    integer!(game.id);
    integer!(game.event_id);
    integer!(game.site_id);
    text!(game.date);
    text!(game.time);
    text!(game.round);
    integer!(game.white_id);
    optional_integer!(game.white_elo);
    integer!(game.black_id);
    optional_integer!(game.black_elo);
    integer!(game.white_material);
    integer!(game.black_material);
    text!(game.result);
    text!(game.time_control);
    text!(game.eco);
    optional_integer!(game.ply_count);
    text!(game.fen);
    field(&mut hash, Some(&game.moves));
    integer!(game.pawn_home);
    format!("{:x}", hash.finalize())
}

fn normalize_games(
    games: Vec<(Game, Player, Player, Event, Site)>,
    cancellation: &CancellationToken,
) -> Result<Vec<NormalizedGame>, Error> {
    games
        .into_iter()
        .map(|(game, white, black, event, site)| {
            cancellation_check(cancellation)?;
            let stamp = game_row_stamp(&game);
            let fen: Fen = game
                .fen
                .map(|f| {
                    Fen::from_ascii(f.as_bytes()).map_err(|error| {
                        Error::InvalidInput(format!("game {} has invalid FEN: {error}", game.id))
                    })
                })
                .transpose()?
                .unwrap_or_default();
            let game_result = game.result.clone().unwrap_or_default();
            let result_token = if game_result.is_empty() {
                "*".to_string()
            } else {
                game_result.clone()
            };

            Ok(NormalizedGame {
                stamp: Some(stamp),
                linked: None,
                id: game.id,
                event: event.name.unwrap_or_default(),
                event_id: event.id,
                site: site.name.unwrap_or_default(),
                site_id: site.id,
                date: game.date,
                time: game.time,
                round: game.round,
                white: white.name.unwrap_or_default(),
                white_id: game.white_id,
                white_elo: game.white_elo,
                black: black.name.unwrap_or_default(),
                black_id: game.black_id,
                black_elo: game.black_elo,
                result: Outcome::from_str(&game_result).unwrap_or_default(),
                time_control: game.time_control,
                eco: game.eco,
                ply_count: game.ply_count,
                fen: fen.to_string(),
                moves: {
                    let movetext =
                        decode_game_to_movetext_cancellable(&game.moves, fen, cancellation)?;
                    cancellation_check(cancellation)?;
                    if movetext.is_empty() {
                        result_token
                    } else {
                        format!("{} {}", movetext, result_token)
                    }
                },
            })
        })
        .collect()
}

#[derive(Debug, Clone, Deserialize, Type)]
pub struct PlayerQuery {
    pub options: QueryOptions<PlayerSort>,
    #[specta(optional)]
    pub name: Option<String>,
    #[serde(rename = "nameMatch")]
    #[specta(optional)]
    pub name_match: Option<PlayerNameMatch>,
    #[specta(optional)]
    pub range: Option<(i32, i32)>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PlayerNameMatch {
    Contains,
    Exact,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum PlayerSort {
    #[serde(rename = "id")]
    Id,
    #[serde(rename = "name")]
    Name,
    #[serde(rename = "elo")]
    Elo,
}

#[tauri::command]
#[specta::specta]
pub async fn get_player(
    file: DatabaseHandle,
    id: i32,
    state: tauri::State<'_, AppState>,
) -> Result<Option<Player>, Error> {
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    crate::infra::operations::run_accepted_blocking(&state.operations, "get_player", move || {
        get_player_blocking(&authority, &repository, file, id)
    })
    .await
}

fn get_player_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
    id: i32,
) -> Result<Option<Player>, Error> {
    let target = resolve_database(authority, &file, PathOperation::DatabaseRead)?;

    let mut database_connection = get_db_or_create(repository, &target, None, authority, &file)?;
    let db = &mut *database_connection;
    linked_collections::read_snapshot(db, authority, &file, |db| {
        let player = players::table
            .filter(players::id.eq(id))
            .first::<Player>(db)
            .optional()?;
        Ok(player)
    })
}

#[tauri::command]
#[specta::specta]
pub async fn get_players(
    file: DatabaseHandle,
    query: PlayerQuery,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<QueryResponse<Vec<Player>>, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "get_players")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    crate::infra::operations::run_native_operation(operation, "get_players", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                get_players_blocking(&authority, &repository, file, query, token)
            })
            .await
    })
    .await
}

fn get_players_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
    query: PlayerQuery,
    cancellation: &CancellationToken,
) -> Result<QueryResponse<Vec<Player>>, Error> {
    cancellation_check(cancellation)?;
    let target = resolve_database(authority, &file, PathOperation::DatabaseRead)?;

    let mut database_connection =
        get_db_or_create(repository, &target, Some(cancellation), authority, &file)?;
    let db = &mut *database_connection;
    linked_collections::read_snapshot(db, authority, &file, |db| {
        let mut count: Option<i64> = None;

        let mut sql_query = players::table.into_boxed();
        let mut count_query = players::table.into_boxed();
        sql_query = sql_query.filter(players::name.is_not("Unknown"));
        count_query = count_query.filter(players::name.is_not("Unknown"));

        if let Some(name) = query.name {
            let (predicate, value) = match query.name_match {
                Some(PlayerNameMatch::Exact) => ("Name COLLATE NOCASE = ", name),
                _ => ("Name LIKE ", format!("%{}%", name)),
            };
            let name_filter = diesel::dsl::sql::<diesel::sql_types::Bool>(predicate)
                .bind::<diesel::sql_types::Text, _>(value);
            sql_query = sql_query.filter(name_filter.clone());
            count_query = count_query.filter(name_filter);
        }

        if let Some(range) = query.range {
            sql_query = sql_query.filter(players::elo.between(range.0, range.1));
            count_query = count_query.filter(players::elo.between(range.0, range.1));
        }

        if !query.options.skip_count {
            count = Some(sqlite_cancellation::with_sqlite_cancellation(
                cancellation,
                || count_query.count().get_result(db),
            )?);
        }

        let (limit, offset) = pagination_limit_offset(query.options.page, query.options.page_size)?;
        if let Some(limit) = limit {
            sql_query = sql_query.limit(limit);
        }

        if let Some(offset) = offset {
            sql_query = sql_query.offset(offset);
        }

        sql_query = match query.options.sort {
            PlayerSort::Id => match query.options.direction {
                SortDirection::Asc => sql_query.order(players::id.asc()),
                SortDirection::Desc => sql_query.order(players::id.desc()),
            },
            PlayerSort::Name => match query.options.direction {
                SortDirection::Asc => sql_query.order(players::name.asc()),
                SortDirection::Desc => sql_query.order(players::name.desc()),
            },
            PlayerSort::Elo => match query.options.direction {
                SortDirection::Asc => sql_query.order(players::elo.asc()),
                SortDirection::Desc => sql_query.order(players::elo.desc()),
            },
        };

        let players = sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
            sql_query.load::<Player>(db)
        })?;
        cancellation_check(cancellation)?;

        Ok(QueryResponse {
            data: players,
            count: count.map(|c| c as i32),
        })
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum TournamentSort {
    #[serde(rename = "id")]
    Id,
    #[serde(rename = "name")]
    Name,
}

#[derive(Debug, Clone, Deserialize, Type)]
pub struct TournamentQuery {
    pub options: QueryOptions<TournamentSort>,
    pub name: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn get_tournaments(
    file: DatabaseHandle,
    query: TournamentQuery,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<QueryResponse<Vec<Event>>, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "get_tournaments")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    crate::infra::operations::run_native_operation(operation, "get_tournaments", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                get_tournaments_blocking(&authority, &repository, file, query, token)
            })
            .await
    })
    .await
}

fn get_tournaments_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
    query: TournamentQuery,
    cancellation: &CancellationToken,
) -> Result<QueryResponse<Vec<Event>>, Error> {
    cancellation_check(cancellation)?;
    let target = resolve_database(authority, &file, PathOperation::DatabaseRead)?;

    let mut database_connection =
        get_db_or_create(repository, &target, Some(cancellation), authority, &file)?;
    let db = &mut *database_connection;
    linked_collections::read_snapshot(db, authority, &file, |db| {
        let mut count: Option<i64> = None;

        let mut sql_query = events::table.into_boxed();
        let mut count_query = events::table.into_boxed();
        sql_query = sql_query.filter(events::name.is_not("Unknown").and(events::name.is_not("")));
        count_query =
            count_query.filter(events::name.is_not("Unknown").and(events::name.is_not("")));

        if let Some(name) = query.name {
            sql_query = sql_query.filter(events::name.like(format!("%{}%", name)));
            count_query = count_query.filter(events::name.like(format!("%{}%", name)));
        }

        if !query.options.skip_count {
            count = Some(sqlite_cancellation::with_sqlite_cancellation(
                cancellation,
                || count_query.count().get_result(db),
            )?);
        }

        let (limit, offset) = pagination_limit_offset(query.options.page, query.options.page_size)?;
        if let Some(limit) = limit {
            sql_query = sql_query.limit(limit);
        }

        if let Some(offset) = offset {
            sql_query = sql_query.offset(offset);
        }

        sql_query = match query.options.sort {
            TournamentSort::Id => match query.options.direction {
                SortDirection::Asc => sql_query.order(events::id.asc()),
                SortDirection::Desc => sql_query.order(events::id.desc()),
            },
            TournamentSort::Name => match query.options.direction {
                SortDirection::Asc => sql_query.order(events::name.asc()),
                SortDirection::Desc => sql_query.order(events::name.desc()),
            },
        };

        let events = sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
            sql_query.load::<Event>(db)
        })?;
        cancellation_check(cancellation)?;

        Ok(QueryResponse {
            data: events,
            count: count.map(|c| c as i32),
        })
    })
}

#[derive(Debug, Clone, Serialize, Type, Default)]
pub struct PlayerGameInfo {
    pub site_stats_data: Vec<SiteStatsData>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, Type)]
#[repr(u8)] // Ensure minimal memory usage (as u8)
pub enum GameOutcome {
    #[default]
    Won = 0,
    Drawn = 1,
    Lost = 2,
}

impl GameOutcome {
    pub fn from_str(result_str: &str, is_white: bool) -> Option<Self> {
        match result_str {
            "1-0" => Some(if is_white {
                GameOutcome::Won
            } else {
                GameOutcome::Lost
            }),
            "1/2-1/2" => Some(GameOutcome::Drawn),
            "0-1" => Some(if is_white {
                GameOutcome::Lost
            } else {
                GameOutcome::Won
            }),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Type, Default)]
pub struct SiteStatsData {
    pub site: String,
    pub player: String,
    pub daily: Vec<DailyStatsData>,
    pub openings: Vec<OpeningStatsData>,
}

#[derive(Debug, Clone, Serialize, Type, Default)]
pub struct DailyStatsData {
    pub date: String,
    pub time_control: String,
    pub won: u32,
    pub drawn: u32,
    pub lost: u32,
    pub max_player_elo: i32,
}

#[derive(Debug, Clone, Serialize, Type, Default)]
pub struct OpeningStatsData {
    pub time_control: String,
    pub is_player_white: bool,
    pub opening: String,
    pub won: u32,
    pub drawn: u32,
    pub lost: u32,
}

/// Import progress for a PGN-to-database conversion. A conversion has no total
/// to divide by until it finishes, so this reports the counters the UI shows
/// rather than a percentage.
#[derive(Serialize, Deserialize, Debug, Clone, Type, tauri_specta::Event)]
pub struct ConvertProgress {
    pub id: String,
    pub imported_games: u32,
    pub elapsed_ms: u32,
    pub source_file_name: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type, tauri_specta::Event)]
pub struct DatabaseContentFailure {
    pub filename: String,
    pub message: String,
}

#[tauri::command]
#[specta::specta]
pub async fn get_players_game_info(
    progress_id: String,
    file: DatabaseHandle,
    id: i32,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<PlayerGameInfo, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "get_players_game_info")?;
    let cancellation = operation.token();
    let progress = JobProgress::best_effort(app.clone(), progress_id, "get_players_game_info");
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    let lease = progress.as_ref().map(JobProgress::lease);
    let worker_app = app.clone();
    crate::infra::operations::run_native_operation(operation, "get_players_game_info", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                let result = get_players_game_info_blocking(
                    &authority,
                    &repository,
                    file,
                    id,
                    (worker_app, lease),
                    token,
                    #[cfg(test)]
                    None,
                );
                complete_preserving_result(result, |state| {
                    if let Some(progress) = &progress {
                        progress.complete(state);
                    }
                })
            })
            .await
    })
    .await
}

fn get_players_game_info_blocking<R: tauri::Runtime>(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
    id: i32,
    (app, lease): (tauri::AppHandle<R>, Option<ProgressLease>),
    cancellation: &CancellationToken,
    #[cfg(test)] progress_update: Option<&ProgressUpdateHook<'_>>,
) -> Result<PlayerGameInfo, Error> {
    cancellation_check(cancellation)?;
    let target = resolve_database(authority, &file, PathOperation::DatabaseRead)?;

    let mut database_connection =
        get_db_or_create(repository, &target, Some(cancellation), authority, &file)?;
    let db = &mut *database_connection;
    linked_collections::read_snapshot(db, authority, &file, |db| {
        let timer = Instant::now();

        let base_query = games::table
            .inner_join(sites::table.on(games::site_id.eq(sites::id)))
            .inner_join(players::table.on(players::id.eq(id)))
            .filter(games::white_id.eq(id).or(games::black_id.eq(id)))
            .filter(games::fen.is_null());

        let progress_error_diagnosed = std::sync::atomic::AtomicBool::new(false);
        let emit_progress = |kept_rows, total_rows| {
            if let Some(lease) = &lease {
                let percent =
                    (player_statistics_progress_fraction(kept_rows, total_rows) * 100_f64) as f32;
                let report_progress = || {
                    update_progress_with_state(
                        &app.state::<AppState>().progress_state,
                        &app,
                        lease,
                        percent,
                        ProgressState::Running,
                    )
                };
                #[cfg(test)]
                let progress_result = progress_update
                    .and_then(|update| update(lease, percent))
                    .unwrap_or_else(report_progress);
                #[cfg(not(test))]
                let progress_result = report_progress();
                handle_running_progress_result(
                    progress_result,
                    "get_players_game_info",
                    lease,
                    &progress_error_diagnosed,
                    None,
                )?;
            }
            Ok::<(), Error>(())
        };

        let mut accumulator = PlayerStatisticsAccumulator::default();
        let mut kept_rows = 0usize;
        let total_rows = sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
            let total_rows = base_query.count().get_result::<i64>(db)?;
            let sql_query = base_query.select((
                games::white_id,
                games::black_id,
                games::result,
                games::date,
                games::moves,
                games::white_elo,
                games::black_elo,
                games::time_control,
                sites::name,
                players::name,
            ));
            let rows = sql_query.load_iter::<PlayerStatisticsRow, DefaultLoadingMode>(db)?;
            process_player_statistics_batches(
                rows,
                PLAYER_STATISTICS_BATCH_ROW_BYTE_BUDGET,
                PLAYER_STATISTICS_BATCH_ROW_LIMIT,
                cancellation,
                |batch| {
                    let evaluated = batch
                        .par_iter()
                        .map(|row| evaluate_player_statistics_row(row, id, cancellation))
                        .collect::<Result<Vec<_>, Error>>()?;

                    for row in evaluated.into_iter().flatten() {
                        cancellation_check(cancellation)?;
                        accumulator.add(row);
                        kept_rows = kept_rows.saturating_add(1);
                        if (kept_rows - 1).is_multiple_of(PLAYER_STATISTICS_PROGRESS_INTERVAL) {
                            emit_progress(kept_rows, total_rows)?;
                        }
                    }

                    Ok(())
                },
            )?;
            Ok::<i64, Error>(total_rows)
        })?;

        cancellation_check(cancellation)?;
        if kept_rows > 0 {
            emit_progress(kept_rows, total_rows)?;
        }

        let game_info = accumulator.into_player_game_info();
        cancellation_check(cancellation)?;

        println!(
            "get_players_game_info {:?}: {:?}",
            target.path(),
            timer.elapsed()
        );

        Ok(game_info)
    })
}

#[derive(Queryable)]
struct PlayerStatisticsRow {
    white_id: i32,
    black_id: i32,
    outcome: Option<String>,
    date: Option<String>,
    moves: Vec<u8>,
    white_elo: Option<i32>,
    black_elo: Option<i32>,
    time_control: Option<String>,
    site: Option<String>,
    player: Option<String>,
}

impl PlayerStatisticsRow {
    fn owned_heap_bytes(&self) -> usize {
        self.moves
            .len()
            .saturating_add(self.outcome.as_ref().map_or(0, String::len))
            .saturating_add(self.date.as_ref().map_or(0, String::len))
            .saturating_add(self.time_control.as_ref().map_or(0, String::len))
            .saturating_add(self.site.as_ref().map_or(0, String::len))
            .saturating_add(self.player.as_ref().map_or(0, String::len))
    }
}

struct EvaluatedPlayerStatisticsRow {
    site: String,
    player: String,
    date: String,
    is_player_white: bool,
    player_elo: i32,
    result: GameOutcome,
    time_control: String,
    opening: String,
}

#[derive(Default)]
struct PlayerStatisticsOutcomeCounts {
    won: u32,
    drawn: u32,
    lost: u32,
}

impl PlayerStatisticsOutcomeCounts {
    fn add(&mut self, result: &GameOutcome) {
        match result {
            GameOutcome::Won => self.won = self.won.saturating_add(1),
            GameOutcome::Drawn => self.drawn = self.drawn.saturating_add(1),
            GameOutcome::Lost => self.lost = self.lost.saturating_add(1),
        }
    }
}

struct PlayerStatisticsDailyAccumulator {
    outcomes: PlayerStatisticsOutcomeCounts,
    max_player_elo: i32,
}

/// The result holds one record per distinct (site, player, time_control, date) and per distinct
/// (site, player, time_control, colour, opening). Apart from the Lichess URL normalisation,
/// site and time_control are kept verbatim, so a database whose games carry per-game Site or
/// TimeControl strings yields one small record per game. Move blobs are never retained.
#[derive(Default)]
struct PlayerStatisticsAccumulator {
    daily: HashMap<(String, String, String, String), PlayerStatisticsDailyAccumulator>,
    openings: HashMap<(String, String, String, bool, String), PlayerStatisticsOutcomeCounts>,
}

impl PlayerStatisticsAccumulator {
    fn add(&mut self, row: EvaluatedPlayerStatisticsRow) {
        let EvaluatedPlayerStatisticsRow {
            site,
            player,
            date,
            is_player_white,
            player_elo,
            result,
            time_control,
            opening,
        } = row;

        let daily = self
            .daily
            .entry((site.clone(), player.clone(), time_control.clone(), date))
            .or_insert_with(|| PlayerStatisticsDailyAccumulator {
                outcomes: PlayerStatisticsOutcomeCounts::default(),
                max_player_elo: player_elo,
            });
        daily.outcomes.add(&result);
        daily.max_player_elo = daily.max_player_elo.max(player_elo);

        self.openings
            .entry((site, player, time_control, is_player_white, opening))
            .or_default()
            .add(&result);
    }

    fn into_player_game_info(self) -> PlayerGameInfo {
        let mut grouped: HashMap<(String, String), SiteStatsData> = HashMap::new();

        for ((site, player, time_control, date), daily) in self.daily {
            let group = player_statistics_site_group(&mut grouped, &site, &player);
            group.daily.push(DailyStatsData {
                date,
                time_control,
                won: daily.outcomes.won,
                drawn: daily.outcomes.drawn,
                lost: daily.outcomes.lost,
                max_player_elo: daily.max_player_elo,
            });
        }

        for ((site, player, time_control, is_player_white, opening), outcomes) in self.openings {
            let group = player_statistics_site_group(&mut grouped, &site, &player);
            group.openings.push(OpeningStatsData {
                time_control,
                is_player_white,
                opening,
                won: outcomes.won,
                drawn: outcomes.drawn,
                lost: outcomes.lost,
            });
        }

        let mut site_stats_data: Vec<_> = grouped.into_values().collect();
        for group in &mut site_stats_data {
            group.daily.sort_unstable_by(|left, right| {
                left.time_control
                    .cmp(&right.time_control)
                    .then_with(|| left.date.cmp(&right.date))
            });
            group.openings.sort_unstable_by(|left, right| {
                left.time_control
                    .cmp(&right.time_control)
                    .then_with(|| left.is_player_white.cmp(&right.is_player_white))
                    .then_with(|| left.opening.cmp(&right.opening))
            });
        }
        site_stats_data.sort_unstable_by(|left, right| {
            left.site
                .cmp(&right.site)
                .then_with(|| left.player.cmp(&right.player))
        });

        PlayerGameInfo { site_stats_data }
    }
}

fn player_statistics_site_group<'a>(
    grouped: &'a mut HashMap<(String, String), SiteStatsData>,
    site: &str,
    player: &str,
) -> &'a mut SiteStatsData {
    grouped
        .entry((site.to_string(), player.to_string()))
        .or_insert_with(|| SiteStatsData {
            site: site.to_string(),
            player: player.to_string(),
            ..SiteStatsData::default()
        })
}

fn evaluate_player_statistics_row(
    row: &PlayerStatisticsRow,
    id: i32,
    cancellation: &CancellationToken,
) -> Result<Option<EvaluatedPlayerStatisticsRow>, Error> {
    cancellation_check(cancellation)?;
    let is_white = row.white_id == id;
    let is_black = row.black_id == id;
    if !is_white && !is_black {
        return Ok(None);
    }

    let Some(player) = row.player.clone() else {
        return Ok(None);
    };
    let Some(date) = row.date.clone() else {
        return Ok(None);
    };
    let Some(result) = row
        .outcome
        .as_deref()
        .and_then(|outcome| GameOutcome::from_str(outcome, is_white))
    else {
        return Ok(None);
    };
    let player_elo = if is_white {
        if is_black && row.black_elo.is_none() {
            // Preserve the prior eligibility rule for malformed self-play rows: both
            // appearances of the selected player must carry a rating.
            return Ok(None);
        }
        let Some(white_elo) = row.white_elo else {
            return Ok(None);
        };
        white_elo
    } else {
        let Some(black_elo) = row.black_elo else {
            return Ok(None);
        };
        black_elo
    };
    let Some(site) = row.site.as_deref().map(|site| {
        if site.starts_with("https://lichess.org/") {
            "Lichess".to_string()
        } else {
            site.to_string()
        }
    }) else {
        return Ok(None);
    };

    let move_bytes = match try_iter_mainline_move_bytes_cancellable(&row.moves, cancellation) {
        Ok(move_bytes) => move_bytes,
        Err(Error::Cancellation) => return Err(Error::Cancellation),
        Err(_) => return Ok(None),
    };
    let mut setups = vec![];
    let mut chess = Chess::default();
    for byte in move_bytes.take(OPENING_STATISTICS_PLY_LIMIT) {
        cancellation_check(cancellation)?;
        let Some(m) = decode_move(byte, &chess) else {
            break;
        };
        chess.play_unchecked(&m);
        setups.push(chess.clone().into_setup(EnPassantMode::Legal));
    }

    setups.reverse();
    let opening = setups
        .iter()
        .find_map(|setup| get_opening_from_setup(setup.clone()).ok())
        .unwrap_or_default();

    Ok(Some(EvaluatedPlayerStatisticsRow {
        site,
        player,
        date,
        is_player_white: is_white,
        player_elo,
        result,
        time_control: row.time_control.clone().unwrap_or_default(),
        opening,
    }))
}

fn next_player_statistics_batch<I>(
    rows: &mut I,
    pending: &mut Option<PlayerStatisticsRow>,
    row_byte_budget: usize,
    row_count_limit: usize,
) -> Result<Option<Vec<PlayerStatisticsRow>>, Error>
where
    I: Iterator<Item = diesel::QueryResult<PlayerStatisticsRow>>,
{
    let row_count_limit = row_count_limit.max(1);
    let mut batch = Vec::with_capacity(row_count_limit.min(PLAYER_STATISTICS_BATCH_ROW_LIMIT));
    let mut row_bytes = 0usize;

    loop {
        let row = match pending.take() {
            Some(row) => row,
            None => match rows.next() {
                Some(row) => row.map_err(Error::from)?,
                None => break,
            },
        };
        let row_heap_bytes = row.owned_heap_bytes();

        if !batch.is_empty()
            && (batch.len() >= row_count_limit
                || row_bytes.saturating_add(row_heap_bytes) > row_byte_budget)
        {
            *pending = Some(row);
            break;
        }

        row_bytes = row_bytes.saturating_add(row_heap_bytes);
        batch.push(row);
        if row_heap_bytes > row_byte_budget
            || row_bytes >= row_byte_budget
            || batch.len() >= row_count_limit
        {
            break;
        }
    }

    if batch.is_empty() {
        Ok(None)
    } else {
        Ok(Some(batch))
    }
}

fn process_player_statistics_batches<I, F>(
    rows: I,
    row_byte_budget: usize,
    row_count_limit: usize,
    cancellation: &CancellationToken,
    mut process_batch: F,
) -> Result<(), Error>
where
    I: Iterator<Item = diesel::QueryResult<PlayerStatisticsRow>>,
    F: FnMut(&[PlayerStatisticsRow]) -> Result<(), Error>,
{
    let mut rows = rows.fuse();
    let mut pending = None;
    loop {
        cancellation_check(cancellation)?;
        let Some(batch) = next_player_statistics_batch(
            &mut rows,
            &mut pending,
            row_byte_budget,
            row_count_limit,
        )?
        else {
            break;
        };
        process_batch(&batch)?;
    }
    Ok(())
}

fn player_statistics_progress_fraction(kept_rows: usize, total_rows: i64) -> f64 {
    if total_rows <= 0 {
        return 0.0;
    }
    (kept_rows as f64 / total_rows as f64).clamp(0.0, 1.0)
}

#[tauri::command]
#[specta::specta]
pub async fn delete_database(
    file: DatabaseHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let operation = state.operations.accept("delete_database")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    let search_cache = Arc::clone(&state.search_cache);
    crate::infra::operations::run_native_operation(operation, "delete_database", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                delete_database_blocking(&authority, &repository, &search_cache, file, token)
            })
            .await
    })
    .await
}

// index_sidecar_removal_identity compares only source.object for preferred sidecars,
// but requires source == *expected_source for legacy (preferred=false) sidecars.
// IndexSource::from_database never carries these sentinels, so full equality fails
// and the legacy file stays. The object field still uses the recovered target identity.
const ABSENT_PRIMARY_INDEX_REVISION: u64 = u64::MAX;
const ABSENT_PRIMARY_INDEX_DATABASE_LENGTH: u64 = u64::MAX;
const ABSENT_PRIMARY_INDEX_DATABASE_MODIFIED_NANOS: u128 = u128::MAX;

fn delete_database_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    file: DatabaseHandle,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    #[cfg(test)]
    database_command_checkpoint("delete_database", &file);
    let (target, absent) = match resolve_database(authority, &file, PathOperation::DatabaseMutate) {
        Ok(target) => (target, false),
        Err(error) if error.is_missing_entry() => {
            match authority.with_mut(|authority| {
                authority.recover_database_deletion(&file, error, cancellation)
            })?? {
                DatabaseDeleteRecovery::Absent(target) => (target, true),
                DatabaseDeleteRecovery::Present => (
                    resolve_database(authority, &file, PathOperation::DatabaseMutate)?,
                    false,
                ),
            }
        }
        Err(error) => return Err(error),
    };
    let _content_deletion =
        content_validation::begin_delete(repository, target.path(), cancellation)?;
    let expected_source = if absent {
        IndexSource {
            object: target.identity(),
            revision: ABSENT_PRIMARY_INDEX_REVISION,
            database_length: ABSENT_PRIMARY_INDEX_DATABASE_LENGTH,
            database_modified_nanos: ABSENT_PRIMARY_INDEX_DATABASE_MODIFIED_NANOS,
        }
    } else {
        let identity = match repository.identity_from_probe(&target, cancellation, true) {
            Ok(identity) => identity,
            Err(error) if crate::error::is_sqlite_notadb(&error) => {
                repository.identity_from_probe(&target, cancellation, false)?
            }
            Err(error) => return Err(error),
        };
        IndexSource::from_database_identity(&identity)?
    };
    let mut committed_removal: Option<CommittedRemoval> = None;
    let unlink_result = repository.delete_exclusive_cancellable(&target, cancellation, || {
        if absent {
            if let Some(collections) = authority.collections()? {
                #[cfg(test)]
                ABSENT_PRIMARY_BEFORE_COLLECTION_GUARD.with(|slot| {
                    if let Some(hook) = slot.borrow_mut().take() {
                        hook();
                    }
                });
                collections.guard_database(&file, PathOperation::DatabaseMutate)?;
            }
        } else {
            guard_database_mutation(authority, &file, PathOperation::DatabaseMutate)?;
        }
        search_cache.invalidate_database(&target);
        let result = unlink_database_files(&target, &expected_source);
        search_cache.invalidate_database(&target);
        let result = result?;
        committed_removal = Some(result);
        Ok(())
    });
    if committed_removal.is_some() {
        content_validation::forget(repository, target.path());
    }
    let Some(mut committed_removal) = committed_removal else {
        return unlink_result;
    };
    committed_removal.record(unlink_result, "database lease release", target.path());

    let registry_result = (|| authority.with_mut(|authority| authority.remove_database(&file))?)();
    committed_removal.record(registry_result, "database registry cleanup", target.path());
    committed_removal.finish()
}

#[cfg(test)]
std::thread_local! {
    static ABSENT_PRIMARY_BEFORE_COLLECTION_GUARD:
        std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    static UNLINK_PRIMARY_AFTER_IDENTITY_PROBE_HOOK:
        std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    static UNLINK_SIDECAR_AFTER_IDENTITY_PROBE_HOOK:
        std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn set_unlink_primary_after_identity_probe_hook(hook: Option<Box<dyn FnOnce()>>) {
    UNLINK_PRIMARY_AFTER_IDENTITY_PROBE_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(test)]
fn run_unlink_primary_after_identity_probe_hook() {
    UNLINK_PRIMARY_AFTER_IDENTITY_PROBE_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(test)]
fn set_unlink_sidecar_after_identity_probe_hook(hook: Option<Box<dyn FnOnce()>>) {
    UNLINK_SIDECAR_AFTER_IDENTITY_PROBE_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(test)]
fn run_unlink_sidecar_after_identity_probe_hook() {
    UNLINK_SIDECAR_AFTER_IDENTITY_PROBE_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UnlinkProbeStage {
    Identity,
    ReadOpen,
    OpenedIdentity,
    SourceRead,
}

#[cfg(test)]
std::thread_local! {
    static UNLINK_PROBE_FAULT:
        std::cell::RefCell<Option<(UnlinkProbeStage, std::ffi::OsString, std::io::ErrorKind)>> = const { std::cell::RefCell::new(None) };
    static UNLINK_PROBE_OPENED_IDENTITY_MISMATCH:
        std::cell::RefCell<Option<std::ffi::OsString>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn set_unlink_probe_opened_identity_mismatch(leaf: Option<std::ffi::OsString>) {
    UNLINK_PROBE_OPENED_IDENTITY_MISMATCH.with(|slot| *slot.borrow_mut() = leaf);
}

#[cfg(test)]
fn inject_unlink_probe_opened_identity_mismatch(leaf: &OsStr, identity: (u64, u64)) -> (u64, u64) {
    UNLINK_PROBE_OPENED_IDENTITY_MISMATCH.with(|slot| {
        let mut armed_leaf = slot.borrow_mut();
        if armed_leaf.as_deref() == Some(leaf) {
            *armed_leaf = None;
            (identity.0, identity.1.wrapping_add(1))
        } else {
            identity
        }
    })
}

#[cfg(test)]
fn inject_unlink_probe_fault<T, E: From<std::io::Error>>(
    stage: UnlinkProbeStage,
    leaf: Option<&OsStr>,
    result: Result<T, E>,
) -> Result<T, E> {
    UNLINK_PROBE_FAULT.with(|slot| {
        let mut fault = slot.borrow_mut();
        match fault.as_ref() {
            Some((point, fault_leaf, kind))
                if *point == stage && leaf.is_none_or(|leaf| leaf == fault_leaf) =>
            {
                let kind = *kind;
                *fault = None;
                return Err(std::io::Error::new(kind, "injected sidecar probe failure").into());
            }
            _ => {}
        }
        result
    })
}

/// Judges provenance and binds removal to the identity of that same file. POSIX retains
/// the `statat` → `unlinkat` instant inside `remove_entry_at`; Windows deletes through the
/// checked handle and has no such window. A sidecar written under a database object that
/// has since changed is kept as foreign; loaders reject it and later generation replaces it.
/// `PermissionDenied` at any probe stage keeps either index name and deletion continues.
/// A preferred file whose header and source are not a decodable archive is removed;
/// the same defect on the legacy name keeps that file.
/// An Ok result means the primary was removed or was already missing at unlink;
/// any retained error must be reported after cache and registry cleanup, including
/// a later SQLite sidecar failure.
fn unlink_database_files(
    target: &DatabaseFileTarget,
    expected_source: &IndexSource,
) -> Result<CommittedRemoval, Error> {
    fn remember_sidecar_error(
        error: Error,
        parent: &File,
        leaf: &OsStr,
        retained: &mut Option<Error>,
    ) -> Result<(), Error> {
        match crate::infra::path_authority::classify_probe_error(&error, parent, leaf) {
            crate::infra::path_authority::ProbeErrorClass::NotFound => Ok(()),
            crate::infra::path_authority::ProbeErrorClass::Reparse
            | crate::infra::path_authority::ProbeErrorClass::WrongKind => {
                if let Some(sidecar_error) = retained.as_ref() {
                    log::warn!(
                        "database sidecar removal failed after durability uncertainty: {sidecar_error}"
                    );
                }
                Err(Error::InvalidInput(
                    "workspace sidecar must be a regular file".into(),
                ))
            }
            crate::infra::path_authority::ProbeErrorClass::Malformed
            | crate::infra::path_authority::ProbeErrorClass::MappedFile
            | crate::infra::path_authority::ProbeErrorClass::Other => {
                if matches!(error, Error::CommittedDurabilityUncertain(_)) {
                    if retained.is_some() {
                        log::warn!(
                            "database sidecar removal durability remained uncertain: {}",
                            error.diagnostic()
                        );
                    } else {
                        *retained = Some(error);
                    }
                    Ok(())
                } else {
                    if let Some(sidecar_error) = retained.as_ref() {
                        log::warn!(
                            "database sidecar removal failed after durability uncertainty: {sidecar_error}"
                        );
                    }
                    Err(error)
                }
            }
        }
    }

    fn remove_sidecar(
        parent: &File,
        leaf: &OsStr,
        identity: (u64, u64),
        unlinked: &mut usize,
        retained: &mut Option<Error>,
    ) -> Result<(), Error> {
        match remove_entry_at(parent, leaf, identity, false) {
            Ok(()) => {
                *unlinked += 1;
                Ok(())
            }
            Err(error) => match error {
                Error::CommittedDurabilityUncertain(_) => {
                    *unlinked += 1;
                    remember_sidecar_error(error, parent, leaf, retained)
                }
                error => remember_sidecar_error(error, parent, leaf, retained),
            },
        }
    }

    fn unlink_judged_sidecar(
        parent: &File,
        leaf: &OsStr,
        expected_source: &IndexSource,
        preferred: bool,
        unlinked: &mut usize,
        retained: &mut Option<Error>,
    ) -> Result<(), Error> {
        match index_sidecar_removal_identity(parent, leaf, expected_source, preferred) {
            Ok(Some(identity)) => remove_sidecar(parent, leaf, identity, unlinked, retained),
            Ok(None) => Ok(()),
            Err(error) => remember_sidecar_error(error, parent, leaf, retained),
        }
    }

    let preferred_leaf = search_index::preferred_sidecar_leaf(target.leaf());
    let integrity_leaf = search_index::integrity_stamp_leaf(target.leaf());
    let legacy_leaf = search_index::legacy_sidecar_leaf(target.leaf());
    let mut unlinked = 0;
    let mut durability = None;

    // Refuse unsafe SQLite sidecars before deleting anything, but retain their
    // identities so they can only be unlinked after the primary is removed.
    let mut sqlite_sidecars = Vec::with_capacity(2);
    for suffix in ["-wal", "-shm"] {
        let mut leaf = target.leaf().to_os_string();
        leaf.push(suffix);
        match entry_identity_at(target.parent(), &leaf, false) {
            Ok(identity) => sqlite_sidecars.push((leaf, identity)),
            Err(error) => remember_sidecar_error(error, target.parent(), &leaf, &mut durability)?,
        }
    }

    unlink_judged_sidecar(
        target.parent(),
        &preferred_leaf,
        expected_source,
        true,
        &mut unlinked,
        &mut durability,
    )?;

    match entry_identity_at(target.parent(), &integrity_leaf, false) {
        Ok(identity) => remove_sidecar(
            target.parent(),
            &integrity_leaf,
            identity,
            &mut unlinked,
            &mut durability,
        )?,
        Err(error) => {
            remember_sidecar_error(error, target.parent(), &integrity_leaf, &mut durability)?
        }
    }

    if legacy_leaf != preferred_leaf {
        unlink_judged_sidecar(
            target.parent(),
            &legacy_leaf,
            expected_source,
            false,
            &mut unlinked,
            &mut durability,
        )?;
    }

    #[cfg(test)]
    run_unlink_primary_after_identity_probe_hook();
    let mut primary_result =
        remove_entry_at(target.parent(), target.leaf(), target.identity(), false);
    match primary_result {
        Ok(()) => unlinked += 1,
        Err(Error::CommittedDurabilityUncertain(_)) => {
            unlinked += 1;
        }
        Err(Error::Conflict(_)) => {
            if let Some(sidecar_error) = durability {
                log::warn!(
                    "database sidecar removal durability was uncertain before primary failure: {sidecar_error}"
                );
            }
            return Err(Error::Conflict("database changed before deletion".into()));
        }
        Err(ref error) if error.is_missing_entry() => primary_result = Ok(()),
        Err(error) => {
            if let Some(sidecar_error) = durability {
                log::warn!(
                    "database sidecar removal durability was uncertain before primary failure: {sidecar_error}"
                );
            }
            return Err(error);
        }
    }
    let mut committed_removal = CommittedRemoval::new(unlinked, durability);
    committed_removal.record(primary_result, "database primary removal", target.path());
    for (leaf, identity) in sqlite_sidecars {
        #[cfg(test)]
        run_unlink_sidecar_after_identity_probe_hook();
        let result = remove_entry_at(target.parent(), &leaf, identity, false);
        if result.is_ok() || matches!(result, Err(Error::CommittedDurabilityUncertain(_))) {
            committed_removal.add_removed_entries(1);
        }
        let result = result.or_else(|error| {
            if matches!(error, Error::CommittedDurabilityUncertain(_)) {
                Err(error)
            } else {
                remember_sidecar_error(error, target.parent(), &leaf, &mut None)
            }
        });
        if let Err(error) = &result {
            log::warn!(
                "database SQLite sidecar removal failed after primary deletion for {}: {}",
                leaf.to_string_lossy(),
                error.diagnostic()
            );
        }
        committed_removal.record(result, "database SQLite sidecar removal", target.path());
    }
    Ok(committed_removal)
}

#[cfg(all(test, unix))]
fn legacy_sidecar_removal_identity(
    parent: &File,
    leaf: &OsStr,
    expected_source: &IndexSource,
) -> Result<Option<(u64, u64)>, Error> {
    index_sidecar_removal_identity(parent, leaf, expected_source, false)
}

fn index_sidecar_removal_identity(
    parent: &File,
    leaf: &OsStr,
    expected_source: &IndexSource,
    preferred: bool,
) -> Result<Option<(u64, u64)>, Error> {
    use crate::infra::path_authority::{
        classify_probe_error, opened_file_identity, ProbeErrorClass,
    };

    let mut judged_identity = None;
    let probe = (|| {
        let result = entry_identity_at(parent, leaf, false);
        #[cfg(test)]
        let result = inject_unlink_probe_fault(UnlinkProbeStage::Identity, Some(leaf), result);
        let identity = result?;
        judged_identity = Some(identity);
        let result = crate::infra::fs::open_regular_at(
            parent,
            leaf,
            crate::infra::fs::RegularFileAccess::ReadOnly,
        );
        #[cfg(test)]
        let result = inject_unlink_probe_fault(UnlinkProbeStage::ReadOpen, Some(leaf), result);
        let mut file = result?;
        let result = opened_file_identity(&file);
        #[cfg(test)]
        let result =
            inject_unlink_probe_fault(UnlinkProbeStage::OpenedIdentity, Some(leaf), result);
        #[cfg(test)]
        let result =
            result.map(|identity| inject_unlink_probe_opened_identity_mismatch(leaf, identity));
        if result? != identity {
            return Err(Error::Conflict(
                "index sidecar changed before deletion".into(),
            ));
        }
        let source = search_index::read_index_source(&mut file).map_err(Error::from);
        drop(file);
        source
    })();

    let remove = match probe {
        Ok(source) => {
            if preferred {
                source.object == expected_source.object
            } else {
                source == *expected_source
            }
        }
        Err(error) => match classify_probe_error(&error, parent, leaf) {
            ProbeErrorClass::NotFound => false,
            ProbeErrorClass::Malformed => preferred,
            ProbeErrorClass::Reparse | ProbeErrorClass::WrongKind if !preferred => false,
            ProbeErrorClass::Other if matches!(&error, Error::Io(error) if error.kind() == std::io::ErrorKind::PermissionDenied) => {
                false
            }
            _ => return Err(error),
        },
    };
    if !remove {
        return Ok(None);
    }
    #[cfg(test)]
    run_unlink_sidecar_after_identity_probe_hook();
    Ok(judged_identity)
}

fn delete_orphaned_data(db: &mut SqliteConnection) -> Result<(), Error> {
    db.batch_execute(
        "
        DELETE FROM Players WHERE ID != 0 AND ID NOT IN (
            SELECT WhiteID FROM Games UNION SELECT BlackID FROM Games
        );
        DELETE FROM Events WHERE ID != 0 AND ID NOT IN (
            SELECT EventID FROM Games
        );
        DELETE FROM Sites WHERE ID != 0 AND ID NOT IN (
            SELECT SiteID FROM Games
        );
        ",
    )?;

    Ok(())
}

fn update_database_counts(db: &mut SqliteConnection) -> Result<(), Error> {
    let game_count: i64 = games::table.count().get_result(db)?;
    update_info_count(db, "GameCount", game_count)?;

    let player_count: i64 = players::table.count().get_result(db)?;
    update_info_count(db, "PlayerCount", player_count)?;

    let event_count: i64 = events::table.count().get_result(db)?;
    update_info_count(db, "EventCount", event_count)?;

    let site_count: i64 = sites::table.count().get_result(db)?;
    update_info_count(db, "SiteCount", site_count)?;

    Ok(())
}

fn remove_orphans_and_update_counts(db: &mut SqliteConnection) -> Result<(), Error> {
    delete_orphaned_data(db)?;
    update_database_counts(db)
}

#[tauri::command]
#[specta::specta]
pub async fn delete_duplicated_games(
    file: DatabaseHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let operation = state.operations.accept("delete_duplicated_games")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    let search_cache = Arc::clone(&state.search_cache);
    crate::infra::operations::run_native_operation(
        operation,
        "delete_duplicated_games",
        async move {
            BLOCKING_GATEWAY
                .spawn_cancellable(cancellation, move |token| {
                    delete_duplicated_games_blocking(
                        &authority,
                        &repository,
                        &search_cache,
                        file,
                        token,
                    )
                })
                .await
        },
    )
    .await
}

fn delete_duplicated_games_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    file: DatabaseHandle,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    #[cfg(test)]
    database_command_checkpoint("delete_duplicated_games", &file);
    let target = resolve_database(authority, &file, PathOperation::DatabaseMutate)?;

    with_validated_mutation(
        repository,
        search_cache,
        &target,
        cancellation,
        authority,
        &file,
        delete_duplicated_games_transaction,
    )
}

fn delete_duplicated_games_transaction(db: &mut SqliteConnection) -> Result<(), Error> {
    db.batch_execute(
        "
        DELETE FROM Games
        WHERE ID IN (
            SELECT ID
            FROM (
                SELECT ID,
                    ROW_NUMBER() OVER (PARTITION BY EventID, SiteID, Round, WhiteID, BlackID, Moves, Date, UTCTime, FEN, Result, WhiteElo, BlackElo, TimeControl ORDER BY ID) AS RowNum
                FROM Games
            ) AS Subquery
            WHERE RowNum > 1
        );
        ",
    )?;

    remove_orphans_and_update_counts(db)?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_empty_games(
    file: DatabaseHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let operation = state.operations.accept("delete_empty_games")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    let search_cache = Arc::clone(&state.search_cache);
    crate::infra::operations::run_native_operation(operation, "delete_empty_games", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                delete_empty_games_blocking(&authority, &repository, &search_cache, file, token)
            })
            .await
    })
    .await
}

pub(crate) fn delete_empty_games_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    file: DatabaseHandle,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    #[cfg(test)]
    database_command_checkpoint("delete_empty_games", &file);
    let target = resolve_database(authority, &file, PathOperation::DatabaseMutate)?;

    with_validated_mutation(
        repository,
        search_cache,
        &target,
        cancellation,
        authority,
        &file,
        delete_empty_games_transaction,
    )
}

fn delete_empty_games_transaction(db: &mut SqliteConnection) -> Result<(), Error> {
    diesel::delete(games::table.filter(games::ply_count.eq(0))).execute(db)?;

    remove_orphans_and_update_counts(db)?;

    Ok(())
}

struct PgnGame {
    event: Option<String>,
    site: Option<String>,
    date: Option<String>,
    time: Option<String>,
    round: Option<String>,
    white: Option<String>,
    black: Option<String>,
    result: Option<String>,
    time_control: Option<String>,
    eco: Option<String>,
    white_elo: Option<String>,
    black_elo: Option<String>,
    ply_count: Option<String>,
    fen: Option<String>,
    moves: Option<String>,
}

fn write_decoded_pgn_tag(writer: &mut impl Write, name: &str, value: &str) -> Result<(), Error> {
    write!(writer, "[{name} \"")?;
    for character in value.chars() {
        if character == '\\' || character == '"' {
            writer.write_all(b"\\")?;
        }
        write!(writer, "{character}")?;
    }
    writeln!(writer, "\"]")?;
    Ok(())
}

impl PgnGame {
    fn write(&self, writer: &mut impl Write) -> Result<(), Error> {
        // Event, Site, Date, UTCTime, and Result retain RawHeader's escaped spelling in existing
        // databases. The fields written through write_decoded_pgn_tag were decoded on import.
        writeln!(
            writer,
            "[Event \"{}\"]",
            self.event.as_deref().unwrap_or("")
        )?;
        writeln!(writer, "[Site \"{}\"]", self.site.as_deref().unwrap_or(""))?;
        writeln!(writer, "[Date \"{}\"]", self.date.as_deref().unwrap_or(""))?;
        if let Some(time) = self.time.as_deref() {
            if !time.is_empty() {
                writeln!(writer, "[UTCTime \"{}\"]", time)?;
            }
        }
        write_decoded_pgn_tag(writer, "Round", self.round.as_deref().unwrap_or(""))?;
        write_decoded_pgn_tag(writer, "White", self.white.as_deref().unwrap_or(""))?;
        write_decoded_pgn_tag(writer, "Black", self.black.as_deref().unwrap_or(""))?;
        writeln!(
            writer,
            "[Result \"{}\"]",
            self.result.as_deref().unwrap_or("*")
        )?;
        if let Some(time_control) = self.time_control.as_deref() {
            write_decoded_pgn_tag(writer, "TimeControl", time_control)?;
        }
        if let Some(eco) = self.eco.as_deref() {
            write_decoded_pgn_tag(writer, "ECO", eco)?;
        }
        if let Some(white_elo) = self.white_elo.as_deref() {
            if white_elo == "0" {
                writeln!(writer, "[WhiteElo \"-\"]")?;
            } else {
                writeln!(writer, "[WhiteElo \"{}\"]", white_elo)?;
            }
        }
        if let Some(black_elo) = self.black_elo.as_deref() {
            if black_elo == "0" {
                writeln!(writer, "[BlackElo \"-\"]")?;
            } else {
                writeln!(writer, "[BlackElo \"{}\"]", black_elo)?;
            }
        }
        if let Some(ply_count) = self.ply_count.as_deref() {
            writeln!(writer, "[PlyCount \"{}\"]", ply_count)?;
        }
        if let Some(fen) = self.fen.as_deref() {
            writeln!(writer, "[SetUp \"1\"]")?;
            write_decoded_pgn_tag(writer, "FEN", fen)?;
        }
        writeln!(writer)?;
        if let Some(moves) = self.moves.as_deref() {
            if !moves.is_empty() {
                write!(writer, "{} ", moves)?;
            }
        }
        match self.result.as_deref() {
            Some("1-0") => writeln!(writer, "1-0"),
            Some("0-1") => writeln!(writer, "0-1"),
            Some("1/2-1/2") => writeln!(writer, "1/2-1/2"),
            _ => writeln!(writer, "*"),
        }?;
        writeln!(writer)?;
        Ok(())
    }
}

#[tauri::command]
#[specta::specta]
pub async fn export_to_pgn(
    file: DatabaseHandle,
    destination: FileWorkspaceHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    crate::infra::platform_support::off_unix_refusal("PGN atomic replacement", cfg!(unix))?;
    let operation = state.operations.accept("export_to_pgn")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    crate::infra::operations::run_native_operation(operation, "export_to_pgn", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                export_to_pgn_blocking(&authority, &repository, file, destination, token)
            })
            .await
    })
    .await
}

fn export_to_pgn_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
    destination: FileWorkspaceHandle,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    #[cfg(test)]
    database_command_checkpoint("export_to_pgn", &file);
    let target = resolve_database(authority, &file, PathOperation::DatabaseExport)?;
    let (resolved, snapshot) = authority.with_mut(|authority| {
        let resolved = authority.resolve(destination.path_ref(), PathOperation::WritePgn, &[])?;
        let snapshot = resolved.pgn_snapshot()?;
        Ok::<_, Error>((resolved, snapshot))
    })??;

    let collection_source = authority
        .collections()?
        .map(|service| service.export_snapshot(authority, &file, cancellation))
        .transpose()?
        .flatten();
    if authority
        .collections()?
        .map(|service| service.contains_source(&destination))
        .transpose()?
        .unwrap_or(false)
    {
        return Err(Error::Conflict(
            "choose an export destination outside active collections".into(),
        ));
    }
    let mut database_connection = if collection_source.is_none() {
        Some(get_db_or_create(
            repository,
            &target,
            Some(cancellation),
            authority,
            &file,
        )?)
    } else {
        None
    };

    let installed = resolved.replace_pgn_atomic(&snapshot, cancellation, |_, temporary| {
        if let Some(source) = &collection_source {
            let mut bytes = source.file.try_clone()?;
            crate::pgn::copy_range(&mut bytes, temporary, 0, source.revision.size, cancellation)?;
            if source.current_revision()? != source.revision {
                return Err(Error::StaleGame);
            }
            return Ok(());
        }
        let db = &mut **database_connection
            .as_mut()
            .ok_or_else(|| Error::Conflict("database export source is unavailable".into()))?;
        let (white_players, black_players) = diesel::alias!(players as white, players as black);
        let rows = games::table
            .inner_join(white_players.on(games::white_id.eq(white_players.field(players::id))))
            .inner_join(black_players.on(games::black_id.eq(black_players.field(players::id))))
            .inner_join(events::table.on(games::event_id.eq(events::id)))
            .inner_join(sites::table.on(games::site_id.eq(sites::id)))
            .load_iter::<(Game, Player, Player, Event, Site), DefaultLoadingMode>(db)?;
        #[cfg(test)]
        let rows = rows.inspect(|_| {
            EXPORT_ROW_COUNT.with(|counter| {
                if let Some(counter) = counter.borrow().as_ref() {
                    counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
            });
        });
        write_pgn_rows(temporary, rows, cancellation)
    })?;
    crate::infra::fs::require_durable(
        installed.outcome,
        crate::error::DurabilityStage::DatabasePgnReplacement,
    )
}

fn write_pgn_rows<W, I>(
    destination: W,
    rows: I,
    cancellation: &CancellationToken,
) -> Result<(), Error>
where
    W: Write,
    I: IntoIterator<Item = diesel::QueryResult<(Game, Player, Player, Event, Site)>>,
{
    let mut writer = BufWriter::new(destination);
    let mut rows = rows.into_iter();
    loop {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let Some(row) = rows.next() else { break };
        #[cfg(test)]
        if let Some(block) = take_export_write_block() {
            block.entered.wait();
            block.release.wait();
        }
        let (game, white, black, event, site) = row.map_err(Error::from)?;
        let initial_fen = game
            .fen
            .as_deref()
            .map(|fen| {
                Fen::from_ascii(fen.as_bytes()).map_err(|error| {
                    Error::InvalidInput(format!("game {} has invalid FEN: {error}", game.id))
                })
            })
            .transpose()?
            .unwrap_or_default();
        let moves = decode_game_to_movetext(&game.moves, initial_fen).map_err(|error| {
            Error::InvalidInput(format!("game {} has invalid movetext: {error}", game.id))
        })?;
        PgnGame {
            event: event.name,
            site: site.name,
            date: game.date,
            time: game.time,
            round: game.round,
            white: white.name,
            black: black.name,
            result: game.result,
            time_control: game.time_control,
            eco: game.eco,
            white_elo: game.white_elo.map(|elo| elo.to_string()),
            black_elo: game.black_elo.map(|elo| elo.to_string()),
            ply_count: game.ply_count.map(|count| count.to_string()),
            fen: game.fen,
            moves: Some(moves),
        }
        .write(&mut writer)?;
    }
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
struct ExportWriteBlock {
    entered: std::sync::Barrier,
    release: std::sync::Barrier,
}

#[cfg(test)]
std::thread_local! {
    static EXPORT_WRITE_BLOCK: std::cell::RefCell<Option<Arc<ExportWriteBlock>>> = const {
        std::cell::RefCell::new(None)
    };
    static EXPORT_ROW_COUNT: std::cell::RefCell<Option<Arc<std::sync::atomic::AtomicUsize>>> = const {
        std::cell::RefCell::new(None)
    };
}

#[cfg(test)]
fn take_export_write_block() -> Option<Arc<ExportWriteBlock>> {
    EXPORT_WRITE_BLOCK.with(|block| block.borrow_mut().take())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_db_game(
    file: DatabaseHandle,
    game_id: i32,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let operation = state.operations.accept("delete_db_game")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    let search_cache = Arc::clone(&state.search_cache);
    crate::infra::operations::run_native_operation(operation, "delete_db_game", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                delete_db_game_blocking(
                    &authority,
                    &repository,
                    &search_cache,
                    file,
                    game_id,
                    token,
                )
            })
            .await
    })
    .await
}

fn delete_db_game_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    file: DatabaseHandle,
    game_id: i32,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    #[cfg(test)]
    database_command_checkpoint("delete_db_game", &file);
    let target = resolve_database(authority, &file, PathOperation::DatabaseMutate)?;

    with_validated_mutation(
        repository,
        search_cache,
        &target,
        cancellation,
        authority,
        &file,
        |db| delete_db_game_transaction(db, game_id),
    )
}

fn delete_db_game_transaction(db: &mut SqliteConnection, game_id: i32) -> Result<(), Error> {
    diesel::delete(games::table.filter(games::id.eq(game_id))).execute(db)?;

    remove_orphans_and_update_counts(db)?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn insert_db_game(
    file: DatabaseHandle,
    pgn: String,
    state: tauri::State<'_, AppState>,
) -> Result<InsertedDbGame, Error> {
    let operation = state.operations.accept("insert_db_game")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    let search_cache = Arc::clone(&state.search_cache);
    crate::infra::operations::run_native_operation(operation, "insert_db_game", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                insert_db_game_from_reader(
                    &authority,
                    &repository,
                    &search_cache,
                    file,
                    pgn.as_bytes(),
                    token,
                )
            })
            .await
    })
    .await
}

fn parse_first_db_game(
    input: impl std::io::Read,
    cancellation: &CancellationToken,
) -> Result<TempGame, Error> {
    let mut importer = Importer::new(None);
    BufferedReader::new(CancellableRead::new(input, cancellation))
        .read_game(&mut importer)
        .map_err(|error| map_read_error(error, cancellation))?
        .flatten()
        .ok_or(Error::NoMovesFound)
}

fn insert_db_game_from_reader(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    file: DatabaseHandle,
    input: impl std::io::Read,
    cancellation: &CancellationToken,
) -> Result<InsertedDbGame, Error> {
    let target = resolve_database(authority, &file, PathOperation::DatabaseMutate)?;
    let game = parse_first_db_game(input, cancellation)?;
    if iter_mainline_move_bytes(&game.moves).next().is_none() {
        return Err(Error::NoMovesFound);
    }
    let mut inserted = None;
    with_validated_mutation(
        repository,
        search_cache,
        &target,
        cancellation,
        authority,
        &file,
        |db| {
            let id = game.insert_to_db(db)?;
            update_database_counts(db)?;
            let row = games::table.find(id).first::<Game>(db)?;
            inserted = Some(InsertedDbGame {
                id,
                stamp: game_row_stamp(&row),
            });
            Ok(())
        },
    )?;
    inserted.ok_or_else(|| Error::InvalidInput("Insert returned no game ID".into()))
}

#[tauri::command]
#[specta::specta]
pub async fn write_db_game(
    file: DatabaseHandle,
    game_id: i32,
    pgn: String,
    expected_stamp: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, Error> {
    let operation = state.operations.accept("write_db_game")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    let search_cache = Arc::clone(&state.search_cache);
    crate::infra::operations::run_native_operation(operation, "write_db_game", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                write_db_game_blocking(
                    &authority,
                    &repository,
                    &search_cache,
                    file,
                    game_id,
                    pgn,
                    expected_stamp,
                    token,
                )
            })
            .await
    })
    .await
}

// Keep the command's injected authority, repository and search cache, request fields (file, game id,
// PGN, expected stamp) and cancellation token separate so tests can call this without Tauri state.
#[allow(clippy::too_many_arguments)]
fn write_db_game_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    file: DatabaseHandle,
    game_id: i32,
    pgn: String,
    expected_stamp: String,
    cancellation: &CancellationToken,
) -> Result<String, Error> {
    #[cfg(test)]
    database_command_checkpoint("write_db_game", &file);
    let target = resolve_database(authority, &file, PathOperation::DatabaseMutate)?;

    let temp_game = parse_first_db_game(pgn.as_bytes(), cancellation)?;
    let mut written_stamp = None;
    with_validated_mutation(
        repository,
        search_cache,
        &target,
        cancellation,
        authority,
        &file,
        |db| {
            written_stamp = Some(write_parsed_db_game(
                db,
                game_id,
                &temp_game,
                &expected_stamp,
                remove_orphans_and_update_counts,
            )?);
            Ok(())
        },
    )?;
    written_stamp.ok_or_else(|| Error::InvalidInput("Write returned no game stamp".into()))
}

fn write_parsed_db_game(
    db: &mut SqliteConnection,
    game_id: i32,
    temp_game: &TempGame,
    expected_stamp: &str,
    maintain_metadata: fn(&mut SqliteConnection) -> Result<(), Error>,
) -> Result<String, Error> {
    let existing = games::table
        .filter(games::id.eq(game_id))
        .first::<Game>(db)
        .optional()?
        .ok_or_else(|| Error::GameNotFound(game_id.to_string()))?;
    if game_row_stamp(&existing) != expected_stamp {
        return Err(Error::StaleGame);
    }
    let game_time = temp_game.time.clone().or(existing.time);

    let white_id = if let Some(name) = temp_game.white_name.as_deref() {
        create_player(db, name)?.id
    } else {
        0
    };
    let black_id = if let Some(name) = temp_game.black_name.as_deref() {
        create_player(db, name)?.id
    } else {
        0
    };
    let event_id = if let Some(name) = temp_game.event_name.as_deref() {
        create_event(db, name)?.id
    } else {
        0
    };
    let site_id = if let Some(name) = temp_game.site_name.as_deref() {
        create_site(db, name)?.id
    } else {
        0
    };

    let minimum_material = temp_game
        .material_count
        .minimum_material(temp_game.position.board());
    let minimal_white_material = i32::from(minimum_material.white);
    let minimal_black_material = i32::from(minimum_material.black);
    let pawn_home = get_pawn_home(temp_game.position.board()) as i32;
    let ply_count = iter_mainline_move_bytes(&temp_game.moves).count() as i32;

    let updated_rows = diesel::update(games::table.filter(games::id.eq(game_id)))
        .set((
            games::event_id.eq(event_id),
            games::site_id.eq(site_id),
            games::date.eq(temp_game.date.clone()),
            games::time.eq(game_time),
            games::round.eq(temp_game.round.clone()),
            games::white_id.eq(white_id),
            games::white_elo.eq(temp_game.white_elo),
            games::black_id.eq(black_id),
            games::black_elo.eq(temp_game.black_elo),
            games::white_material.eq(minimal_white_material),
            games::black_material.eq(minimal_black_material),
            games::result.eq(temp_game.result.clone()),
            games::time_control.eq(temp_game.time_control.clone()),
            games::eco.eq(temp_game.eco.clone()),
            games::ply_count.eq(ply_count),
            games::fen.eq(temp_game.fen.clone()),
            games::moves.eq(temp_game.moves.clone()),
            games::pawn_home.eq(pawn_home),
        ))
        .execute(db)?;

    if updated_rows != 1 {
        return Err(Error::GameNotFound(game_id.to_string()));
    }

    maintain_metadata(db)?;

    let written = games::table.find(game_id).first::<Game>(db)?;
    Ok(game_row_stamp(&written))
}

#[tauri::command]
#[specta::specta]
pub async fn merge_players(
    file: DatabaseHandle,
    player1: i32,
    player2: i32,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let operation = state.operations.accept("merge_players")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    let search_cache = Arc::clone(&state.search_cache);
    crate::infra::operations::run_native_operation(operation, "merge_players", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                merge_players_blocking(
                    &authority,
                    &repository,
                    &search_cache,
                    file,
                    player1,
                    player2,
                    token,
                )
            })
            .await
    })
    .await
}

fn merge_players_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    file: DatabaseHandle,
    player1: i32,
    player2: i32,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    #[cfg(test)]
    database_command_checkpoint("merge_players", &file);
    let target = resolve_database(authority, &file, PathOperation::DatabaseMutate)?;

    with_validated_mutation(
        repository,
        search_cache,
        &target,
        cancellation,
        authority,
        &file,
        |db| merge_players_transaction(db, player1, player2),
    )
}

fn merge_players_transaction(
    db: &mut SqliteConnection,
    source_player: i32,
    target_player: i32,
) -> Result<(), Error> {
    if source_player == target_player {
        return Err(Error::InvalidInput(
            "source and target player IDs must be different".into(),
        ));
    }
    if source_player == 0 || target_player == 0 {
        return Err(Error::InvalidInput(
            "the unknown player (ID 0) cannot be merged".into(),
        ));
    }

    let source_exists = players::table
        .find(source_player)
        .select(players::id)
        .first::<i32>(db)
        .optional()?
        .is_some();
    if !source_exists {
        return Err(Error::InvalidInput(format!(
            "source player {source_player} does not exist"
        )));
    }

    let target_exists = players::table
        .find(target_player)
        .select(players::id)
        .first::<i32>(db)
        .optional()?
        .is_some();
    if !target_exists {
        return Err(Error::InvalidInput(format!(
            "target player {target_player} does not exist"
        )));
    }

    // Players that faced each other cannot be merged without changing a game into self-play.
    let count: i64 = games::table
        .filter(
            games::white_id
                .eq(source_player)
                .and(games::black_id.eq(target_player)),
        )
        .or_filter(
            games::white_id
                .eq(target_player)
                .and(games::black_id.eq(source_player)),
        )
        .limit(1)
        .count()
        .get_result(db)?;

    if count > 0 {
        return Err(Error::NotDistinctPlayers);
    }

    diesel::update(games::table.filter(games::white_id.eq(source_player)))
        .set(games::white_id.eq(target_player))
        .execute(db)?;
    diesel::update(games::table.filter(games::black_id.eq(source_player)))
        .set(games::black_id.eq(target_player))
        .execute(db)?;

    let deleted_rows =
        diesel::delete(players::table.filter(players::id.eq(source_player))).execute(db)?;
    if deleted_rows != 1 {
        return Err(Error::InvalidInput(format!(
            "source player {source_player} could not be deleted"
        )));
    }

    remove_orphans_and_update_counts(db)?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn clear_games(state: tauri::State<'_, AppState>) {
    state.search_cache.clear();
}

#[tauri::command]
#[specta::specta]
pub async fn preload_reference_db(
    file: DatabaseHandle,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "preload_reference_db")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    let search_cache = Arc::clone(&state.search_cache);
    crate::infra::operations::run_native_operation(operation, "preload_reference_db", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                preload_reference_db_blocking(&authority, &repository, &search_cache, file, token)
            })
            .await
    })
    .await
}

fn preload_reference_db_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &Arc<SearchCache>,
    file: DatabaseHandle,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    let (_, index) = search::load_search_index_cancellable(
        authority,
        repository,
        search_cache,
        &file,
        cancellation,
    )?;
    info!("Preloaded reference database with {} games", index.len());
    if let Some(service) = authority.collections()? {
        let admitted = service.query_generation(authority, &file)?;
        if admitted
            .as_ref()
            .is_some_and(|(_, revision)| *revision != index.source().revision)
        {
            return Err(Error::StaleGame);
        }
        service.validate_result(
            authority,
            &file,
            &admitted.map(|(generation, _)| generation),
        )?;
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::{db::allocation_probe, infra::path_authority::PathClass};
    use pgn_reader::BufferedReader;
    use std::path::{Path, PathBuf};
    use tauri::Manager;

    #[test]
    fn recent_signature_normalization_matches_renderer_table() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../../src/utils/gameSignature.cases.json"))
                .unwrap();
        for case in cases {
            let value: Option<String> = serde_json::from_value(case["value"].clone()).unwrap();
            let normalized = GameSignature {
                white: value.clone(),
                black: value.clone(),
                event: value.clone(),
                site: value.clone(),
                date: value.clone(),
                round: value,
            }
            .normalized();
            assert_eq!(
                serde_json::to_value(normalized).unwrap(),
                serde_json::json!({
                "white": case["normal"], "black": case["normal"], "event": case["normal"], "site": case["normal"], "date": case["date"], "round": case["round"],
                })
            );
        }
    }

    #[test]
    fn get_db_game_matches_joined_list_and_reports_definitive_absence() {
        let (dir, app, handle, database) = blocking_database_case();
        mount_convert_progress_events(&app);
        let source = dir.path().join("recent.pgn");
        std::fs::write(&source, REPLACEMENT_PGN).unwrap();
        run_import(
            &app,
            handle.clone(),
            vec![grant_import_file(&app, &source)],
            None,
        )
        .unwrap();
        let state = app.state::<AppState>();
        let token = CancellationToken::new();
        let row = get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            GameQuery::new(),
            &token,
        )
        .unwrap()
        .data
        .remove(0);
        let lookup = get_db_game_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            row.id,
            None,
            &token,
        )
        .unwrap();
        let DbGameLookup::Found { game } = lookup else {
            panic!("existing game must be found")
        };
        assert_eq!(
            serde_json::to_value(game).unwrap(),
            serde_json::to_value(row).unwrap()
        );
        assert!(matches!(
            get_db_game_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle.clone(),
                i32::MAX,
                None,
                &token
            )
            .unwrap(),
            DbGameLookup::Missing
        ));
        delete_database_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            &token,
        )
        .unwrap();
        assert!(matches!(
            get_db_game_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                1,
                None,
                &token
            )
            .unwrap(),
            DbGameLookup::Missing
        ));
        assert!(!database.exists());
    }

    #[test]
    fn get_db_game_absent_file_is_not_created_and_other_failures_stay_errors() {
        let (_dir, app, handle, database) = blocking_database_case();
        let state = app.state::<AppState>();
        std::fs::remove_file(&database).unwrap();
        assert!(matches!(
            get_db_game_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle.clone(),
                1,
                None,
                &CancellationToken::new()
            )
            .unwrap(),
            DbGameLookup::Missing
        ));
        assert!(!database.exists());
        let token = CancellationToken::new();
        token.cancel();
        assert!(matches!(
            get_db_game_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                1,
                None,
                &token
            ),
            Err(Error::Cancellation)
        ));
        let (_dir, app, handle, _) = arbitrary_database_case(b"not sqlite");
        let state = app.state::<AppState>();
        assert!(get_db_game_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            1,
            None,
            &CancellationToken::new()
        )
        .is_err());
    }

    struct RemovalFaultSequence(
        std::sync::Mutex<std::collections::VecDeque<crate::infra::fs::RemovalFaultPoint>>,
    );

    impl RemovalFaultSequence {
        fn new(points: impl IntoIterator<Item = crate::infra::fs::RemovalFaultPoint>) -> Self {
            Self(std::sync::Mutex::new(points.into_iter().collect()))
        }
    }

    impl crate::infra::fs::RemovalInjector for RemovalFaultSequence {
        fn inject(
            &self,
            point: crate::infra::fs::RemovalFaultPoint,
        ) -> std::io::Result<Option<u64>> {
            let mut points = self.0.lock().expect("removal fault sequence lock");
            if points.front().copied() == Some(point) {
                points.pop_front();
                return Err(std::io::Error::other(format!("injected {point:?} failure")));
            }
            Ok(None)
        }
    }

    struct CacheInvalidationProbe {
        cache: Arc<SearchCache>,
        identity: crate::SearchIndexIdentity,
        observed_before_removal: std::sync::atomic::AtomicBool,
    }

    struct GenerationCacheEvictionProbe {
        cache: Arc<SearchCache>,
        identity: crate::SearchIndexIdentity,
        observed_before_replacement: std::sync::atomic::AtomicBool,
    }

    impl crate::infra::fs::AtomicWriterInjector for GenerationCacheEvictionProbe {
        fn inject(&self, point: crate::infra::fs::AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == crate::infra::fs::AtomicFileFaultPoint::TempfileCreate {
                if self.cache.get_index(&self.identity).is_some() {
                    return Err(std::io::Error::other(
                        "search index cache was not invalidated before generation",
                    ));
                }
                self.observed_before_replacement
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
            Ok(())
        }
    }

    impl crate::infra::fs::RemovalInjector for CacheInvalidationProbe {
        fn inject(
            &self,
            point: crate::infra::fs::RemovalFaultPoint,
        ) -> std::io::Result<Option<u64>> {
            match point {
                crate::infra::fs::RemovalFaultPoint::BeforeTopOpen => {
                    if self.cache.get_index(&self.identity).is_some() {
                        return Err(std::io::Error::other(
                            "search index cache was not invalidated before removal",
                        ));
                    }
                    self.observed_before_removal
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(None)
                }
                crate::infra::fs::RemovalFaultPoint::ParentSync => Err(std::io::Error::other(
                    "injected primary parent sync failure",
                )),
                _ => Ok(None),
            }
        }
    }

    struct RemovalFaultReset;

    impl Drop for RemovalFaultReset {
        fn drop(&mut self) {
            crate::infra::fs::set_test_removal_injector(None);
        }
    }

    fn scoped_removal_failures(
        points: impl IntoIterator<Item = crate::infra::fs::RemovalFaultPoint>,
    ) -> RemovalFaultReset {
        crate::infra::fs::set_test_removal_injector(Some(Arc::new(RemovalFaultSequence::new(
            points,
        ))));
        RemovalFaultReset
    }

    fn database_is_registered(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        handle: &DatabaseHandle,
    ) -> bool {
        let state = app.state::<AppState>();
        let registered = state
            .pgn_path_authority
            .raw_for_test()
            .lock()
            .expect("path authority lock")
            .as_mut()
            .is_some_and(|authority| {
                authority
                    .resolve(handle.path_ref(), PathOperation::DatabaseRead, &[])
                    .is_ok()
            });
        registered
    }

    #[test]
    fn legacy_sidecar_read_permission_failure_keeps_sidecar_and_deletes_database() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("legacy-permission.db3");
        std::fs::write(&database, b"database").unwrap();
        let expected_source = IndexSource::from_database(&database, 0).unwrap();
        let legacy = legacy_index_path(&database);
        std::fs::write(&legacy, b"unreadable").unwrap();
        std::fs::set_permissions(&legacy, std::fs::Permissions::from_mode(0o000)).unwrap();
        let target = DatabaseFileTarget::for_test_path(&database).unwrap();

        let result = legacy_sidecar_removal_identity(
            target.parent(),
            legacy.file_name().unwrap(),
            &expected_source,
        );
        assert!(matches!(result, Ok(None)));
        let result = unlink_database_files(&target, &expected_source)
            .unwrap()
            .into_parts();
        std::fs::set_permissions(&legacy, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(result.0, 1);
        assert!(result.1.is_none());
        assert!(!database.exists());
        assert_eq!(std::fs::read(&legacy).unwrap(), b"unreadable");
    }

    #[test]
    fn unlink_database_files_keeps_unreadable_foreign_preferred_sidecar() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("preferred-permission.db3");
        let foreign = dir.path().join("foreign.db3");
        std::fs::write(&database, b"database").unwrap();
        std::fs::write(&foreign, b"foreign database").unwrap();
        let preferred = get_index_path(&database);
        SearchIndexChunk::default()
            .write_to_with_source(&preferred, IndexSource::from_database(&foreign, 0).unwrap())
            .unwrap()
            .expect_durable();
        let bytes = std::fs::read(&preferred).unwrap();
        let source = IndexSource::from_database(&database, 0).unwrap();
        let target = DatabaseFileTarget::for_test_path(&database).unwrap();
        std::fs::set_permissions(&preferred, std::fs::Permissions::from_mode(0o000)).unwrap();
        let result = unlink_database_files(&target, &source)
            .unwrap()
            .into_parts();
        std::fs::set_permissions(&preferred, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(result.0, 1);
        assert!(result.1.is_none());
        assert!(!database.exists());
        assert_eq!(std::fs::read(&preferred).unwrap(), bytes);
    }

    #[test]
    fn sidecar_durability_uncertainty_is_retained_until_primary_delete() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("sidecar-durability.db3");
        std::fs::write(&database, b"database").unwrap();
        let expected_source = IndexSource::from_database(&database, 0).unwrap();
        let preferred = get_index_path(&database);
        std::fs::write(&preferred, b"sidecar").unwrap();
        let target = DatabaseFileTarget::for_test_path(&database).unwrap();
        let _faults = scoped_removal_failures([crate::infra::fs::RemovalFaultPoint::ParentSync]);

        let result = unlink_database_files(&target, &expected_source)
            .unwrap()
            .into_parts();
        assert_eq!(result.0, 2);
        assert!(matches!(
            result.1,
            Some(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::WorkspaceRemoval
            ))
        ));
        assert!(!database.exists());
        assert!(!preferred.exists());
    }

    #[test]
    fn sequential_sidecar_failure_returns_the_later_hard_error_and_keeps_primary() {
        let (_dir, app, handle, database) = blocking_database_case();
        let state = app.state::<AppState>();
        let cache_key = seed_search_cache_for_database(&app, &database);
        let expected_source = IndexSource::from_database(&database, 0).unwrap();
        let legacy = legacy_index_path(&database);
        SearchIndexChunk::default()
            .write_to_with_source(&legacy, expected_source.clone())
            .unwrap()
            .expect_durable();
        let target = DatabaseFileTarget::for_test_path(&database).unwrap();
        let capture = crate::error::LogCaptureScope::start();
        let _faults = scoped_removal_failures([
            crate::infra::fs::RemovalFaultPoint::ParentSync,
            crate::infra::fs::RemovalFaultPoint::BeforeTopOpen,
        ]);

        let result = unlink_database_files(&target, &expected_source);
        assert!(matches!(result, Err(Error::Io(_))));
        assert!(database.exists());
        assert!(!get_index_path(&database).exists());
        assert!(legacy.exists());
        assert!(state.search_cache.get_result(&cache_key).is_some());
        assert!(database_is_registered(&app, &handle));
        assert!(
            capture
                .messages()
                .iter()
                .any(|message| message
                    .contains("sidecar removal failed after durability uncertainty"))
        );
    }

    #[test]
    fn primary_durability_uncertainty_runs_cache_and_registry_cleanup() {
        let (_dir, app, handle, database) = blocking_database_case();
        let state = app.state::<AppState>();
        let (cache_key, index_identity) = seed_search_index_cache_for_database(&app, &database);
        std::fs::remove_file(get_index_path(&database)).unwrap();
        let removal_probe = Arc::new(CacheInvalidationProbe {
            cache: Arc::clone(&state.search_cache),
            identity: index_identity,
            observed_before_removal: std::sync::atomic::AtomicBool::new(false),
        });
        crate::infra::fs::set_test_removal_injector(Some(removal_probe.clone()));
        let _faults = RemovalFaultReset;

        let result = delete_database_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            &CancellationToken::new(),
        );
        assert!(matches!(
            result,
            Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::WorkspaceRemoval
            ))
        ));
        assert!(!database.exists());
        assert!(removal_probe
            .observed_before_removal
            .load(std::sync::atomic::Ordering::SeqCst));
        assert!(state.search_cache.get_result(&cache_key).is_none());
        assert!(!database_is_registered(&app, &handle));

        let (_dir, app, handle, database) = blocking_database_case();
        let state = app.state::<AppState>();
        let capture = crate::error::LogCaptureScope::start();
        let _atomic =
            install_atomic_export_failure(crate::infra::fs::AtomicFileFaultPoint::ParentSync);
        let _faults = scoped_removal_failures([crate::infra::fs::RemovalFaultPoint::ParentSync]);

        let result = delete_database_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle,
            &CancellationToken::new(),
        );
        assert!(matches!(
            result,
            Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::WorkspaceRemoval
            ))
        ));
        assert!(!database.exists());
        assert!(capture.messages().iter().any(|message| message
            .contains("database registry cleanup failed after durability uncertainty")));
    }

    #[test]
    fn primary_durability_before_sqlite_sidecar_failure_runs_cleanup() {
        let (dir, app, handle, database) = blocking_database_case();
        let state = app.state::<AppState>();
        let cache_key = seed_search_cache_for_database(&app, &database);
        std::fs::remove_file(get_index_path(&database)).unwrap();
        let wal = database.with_extension("db3-wal");
        let replacement = dir.path().join("replacement-wal");
        std::fs::write(&wal, b"").unwrap();
        std::fs::write(&replacement, b"keep replacement WAL").unwrap();
        let wal_for_hook = wal.clone();
        set_unlink_sidecar_after_identity_probe_hook(Some(Box::new(move || {
            std::fs::rename(&replacement, &wal_for_hook).unwrap();
        })));
        let capture = crate::error::LogCaptureScope::start();
        let _faults = scoped_removal_failures([crate::infra::fs::RemovalFaultPoint::ParentSync]);

        let result = delete_database_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            &CancellationToken::new(),
        );
        assert!(matches!(
            result,
            Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::WorkspaceRemoval
            ))
        ));
        assert!(!database.exists());
        assert_eq!(std::fs::read(&wal).unwrap(), b"keep replacement WAL");
        assert!(state.search_cache.get_result(&cache_key).is_none());
        assert!(!database_is_registered(&app, &handle));
        assert_database_registry_entry_removed(dir.path(), &handle);
        assert!(capture
            .records()
            .iter()
            .any(|record| record.level == log::Level::Warn
                && record.message.contains(
                    "database SQLite sidecar removal failed after durability uncertainty"
                )
                && record.message.contains("kept category: Durability")
                && record.message.contains("Conflict: ")));
    }

    #[test]
    fn primary_durability_before_deletion_release_failure_runs_cleanup() {
        let (dir, app, handle, database) = blocking_database_case();
        let state = app.state::<AppState>();
        let cache_key = seed_search_cache_for_database(&app, &database);
        std::fs::remove_file(get_index_path(&database)).unwrap();
        state.database_repository.fail_next_deletion_release();
        let capture = crate::error::LogCaptureScope::start();
        let _faults = scoped_removal_failures([crate::infra::fs::RemovalFaultPoint::ParentSync]);

        let result = delete_database_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            &CancellationToken::new(),
        );
        assert!(matches!(
            result,
            Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::WorkspaceRemoval
            ))
        ));
        assert!(!database.exists());
        assert!(state.search_cache.get_result(&cache_key).is_none());
        assert!(!database_is_registered(&app, &handle));
        assert_database_registry_entry_removed(dir.path(), &handle);
        assert!(capture
            .records()
            .iter()
            .any(|record| record.level == log::Level::Warn
                && record
                    .message
                    .contains("database lease release failed after durability uncertainty")
                && record.message.contains("kept category: Durability")
                && record
                    .message
                    .contains("Conflict: injected database deletion release failure")));
    }

    #[test]
    fn delete_database_failed_unlink_evicts_mapping_inserted_after_pre_invalidation() {
        struct InsertBeforePrimaryFailure {
            cache: Arc<SearchCache>,
            identity: crate::SearchIndexIdentity,
            index: std::sync::Mutex<Option<MmapSearchIndex>>,
            sidecar: PathBuf,
            inserted: std::sync::atomic::AtomicBool,
        }

        impl crate::infra::fs::RemovalInjector for InsertBeforePrimaryFailure {
            fn inject(
                &self,
                point: crate::infra::fs::RemovalFaultPoint,
            ) -> std::io::Result<Option<u64>> {
                if point == crate::infra::fs::RemovalFaultPoint::BeforeTopOpen
                    && !self.sidecar.exists()
                {
                    assert_eq!(self.cache.cached_index_count(), 0);
                    let index = self.index.lock().unwrap().take().unwrap();
                    self.cache.insert_index(
                        self.identity.clone(),
                        index,
                        self.cache.invalidation_snapshot(),
                    );
                    assert_eq!(self.cache.cached_index_count(), 1);
                    self.inserted
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    return Err(std::io::Error::other("injected primary removal failure"));
                }
                Ok(None)
            }
        }

        let (_dir, app, handle, database) = blocking_database_case();
        let state = app.state::<AppState>();
        let (_key, identity) = seed_search_index_cache_for_database(&app, &database);
        let sidecar = get_index_path(&database);
        let probe = Arc::new(InsertBeforePrimaryFailure {
            cache: Arc::clone(&state.search_cache),
            index: std::sync::Mutex::new(Some(MmapSearchIndex::open(&sidecar).unwrap())),
            identity,
            sidecar: sidecar.clone(),
            inserted: std::sync::atomic::AtomicBool::new(false),
        });
        crate::infra::fs::set_test_removal_injector(Some(probe.clone()));
        let _faults = RemovalFaultReset;
        let result = delete_database_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            &CancellationToken::new(),
        );
        assert!(matches!(result, Err(Error::Io(_))), "{result:?}");
        assert!(probe.inserted.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!sidecar.exists());
        assert!(database.exists());
        assert!(database_is_registered(&app, &handle));
        assert_eq!(state.search_cache.cached_index_count(), 0);
    }

    #[test]
    fn search_index_generation_evicts_cache_before_replacement() {
        let (_dir, app, handle, database) = blocking_database_case();
        let state = app.state::<AppState>();
        let (_cache_key, identity) = seed_search_index_cache_for_database(&app, &database);
        let probe = Arc::new(GenerationCacheEvictionProbe {
            cache: Arc::clone(&state.search_cache),
            identity,
            observed_before_replacement: std::sync::atomic::AtomicBool::new(false),
        });
        crate::infra::fs::set_test_atomic_file_injector(Some(probe.clone()));
        let result = generate_search_index(
            &handle,
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &CancellationToken::new(),
        );
        crate::infra::fs::set_test_atomic_file_injector(None);

        assert!(result.is_ok());
        assert!(probe
            .observed_before_replacement
            .load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn search_index_generation_uses_fd_relative_atomic_writer() {
        let source = include_str!("mod.rs");
        let command = source
            .split("fn generate_search_index")
            .nth(1)
            .unwrap()
            .split("#[derive(Queryable)]")
            .next()
            .unwrap();
        assert!(command.contains("resolve_database("));
        assert!(!command.contains("database_file_target("));
        assert!(!command.contains("database_path("));
        assert!(!command.contains("workspace_entry_path("));
        assert!(!command.contains("canonicalize("));
        assert!(command.contains("target.path()"));

        let body = source
            .split("fn generate_search_index_locked")
            .nth(1)
            .unwrap()
            .split("#[derive(Serialize, Type)]")
            .next()
            .unwrap();
        assert!(body.contains("write_entries_to_at"));
        assert!(body.contains("load_iter"));
        assert!(!body.contains("resolve_database("));
        assert!(!body.contains("database_path("));
        assert!(!body.contains("workspace_entry_path("));
        assert!(!body.contains("canonicalize("));
        assert!(body.contains("target.path()"));
        assert!(!body.contains("let games: Vec"));
        assert!(!body.contains("atomic_replace(&"));
        assert!(!body.contains("std::fs::remove_file"));
    }

    #[test]
    fn database_target_source_text_anchors() {
        let source = include_str!("mod.rs");
        let production = source
            .split("#[cfg(all(test, unix))]\nmod tests")
            .next()
            .unwrap();
        // Includes the two collection-service admission checks, the authority door,
        // the insert command's mutation resolution, the deletion recovery present-arm re-resolve,
        // and the single-game recent lookup's read resolution.
        assert_eq!(production.matches("resolve_database(").count(), 24);
        let resolver = production
            .split("pub(crate) fn resolve_database(")
            .nth(1)
            .unwrap()
            .split("fn update_info_count")
            .next()
            .unwrap();
        assert_eq!(resolver.matches("database_file_target(").count(), 1);
        assert!(!production.contains("database_path("));
        assert!(!production.contains("DatabaseFileTarget {"));
        assert!(!production.contains("assemble("));
        for function in ["insert_db_game_from_reader", "write_db_game_blocking"] {
            let body = production
                .split(&format!("fn {function}("))
                .nth(1)
                .unwrap()
                .split("\n}")
                .next()
                .unwrap();
            assert!(
                body.contains("resolve_database(authority, &file, PathOperation::DatabaseMutate)?"),
                "{function}"
            );
        }

        let source = include_str!("search.rs");
        let production = source
            .split("#[cfg(test)]\nmod descriptor_identity_tests")
            .next()
            .unwrap();
        // Five sites include the linked generation admission before the existing loader,
        // loader mutation resolution, position search and membership query.
        assert_eq!(production.matches("resolve_database(").count(), 5);
        assert_eq!(production.matches("database_file_target(").count(), 0);
        assert!(!production.contains("canonicalize("));
        assert!(!production.contains("DatabaseFileTarget {"));
        assert!(!production.contains("assemble("));
    }

    #[cfg(unix)]
    #[test]
    fn resolve_database_rejects_directory_entries_before_path_access() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("directories");
        let path = parent.join("database.db3");
        std::fs::create_dir_all(&path).unwrap();
        let mut authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
        let committed = authority
            .migrate_legacy_os_path(
                path.clone().into_os_string(),
                "database",
                PathClass::PersistentCustomRoot,
                vec![PathOperation::DatabaseRead],
            )
            .unwrap();
        let handle = DatabaseHandle::new(committed.id);
        let state = AppState::default();
        state.pgn_path_authority.install(authority).unwrap();
        let app = tauri::test::mock_app();
        app.manage(state);
        std::fs::remove_dir_all(&parent).unwrap();

        let result = resolve_database(
            &app.state::<AppState>().pgn_path_authority,
            &handle,
            PathOperation::DatabaseRead,
        );
        assert!(matches!(
            result,
            Err(Error::InvalidInput(message))
                if message == "database handle must identify a regular file"
        ));
    }

    #[test]
    fn production_index_generation_and_open_have_bounded_rust_heap_peaks() {
        let (_dir, app, handle, database) = blocking_database_case();
        let (corpus_bytes, row_count, _) =
            populate_large_valid_comment_corpus(&app, &database, None);
        let generation_threshold = corpus_bytes / 2;
        let open_threshold = corpus_bytes / 8;
        let sanity_peak =
            allocation_probe::assert_detects_owned_collection(corpus_bytes, generation_threshold);
        let state = app.state::<AppState>();
        let (result, generation_peak) = allocation_probe::measure(|| {
            generate_search_index(
                &handle,
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                &CancellationToken::new(),
            )
        });
        result.unwrap();
        assert!(
            generation_peak < generation_threshold,
            "index generation peak {generation_peak} materialized too much of the {corpus_bytes}-byte corpus (threshold {generation_threshold}, sanity peak {sanity_peak})"
        );

        let file = File::open(get_index_path(&database)).unwrap();
        let (opened, open_peak) = allocation_probe::measure(|| MmapSearchIndex::open_file(file));
        assert_eq!(opened.unwrap().len(), row_count);
        assert!(
            open_peak < open_threshold,
            "index open peak {open_peak} deserialized too much of the {corpus_bytes}-byte corpus (threshold {open_threshold}, sanity peak {sanity_peak})"
        );
        eprintln!(
            "index heap evidence: corpus={corpus_bytes} generation_peak={generation_peak} generation_threshold={generation_threshold} open_peak={open_peak} open_threshold={open_threshold} sanity_peak={sanity_peak}"
        );
    }

    fn measure_player_statistics_on_one_rayon_thread<R: Send>(
        operation: impl FnOnce() -> R + Send,
    ) -> (R, usize) {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .unwrap();
        pool.install(|| allocation_probe::measure(operation))
    }

    #[test]
    fn player_statistics_large_move_corpus_has_a_bounded_heap_peak() {
        let (_dir, app, handle, database) = blocking_database_case();
        let (corpus_bytes, row_count, player_id) =
            populate_large_valid_comment_corpus(&app, &database, Some("1-0"));
        let threshold = corpus_bytes / 2;
        let sanity_peak =
            allocation_probe::assert_detects_owned_collection(corpus_bytes, threshold);
        let state = app.state::<AppState>();
        let (result, peak) = measure_player_statistics_on_one_rayon_thread(|| {
            get_players_game_info_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                player_id,
                (app.clone(), None),
                &CancellationToken::new(),
                None,
            )
        });
        let info = result.unwrap();
        assert!(
            peak < threshold,
            "player statistics peak {peak} materialized too much of the {corpus_bytes}-byte move corpus (threshold {threshold}, sanity peak {sanity_peak})"
        );
        assert_eq!(info.site_stats_data.len(), 1);
        assert_eq!(info.site_stats_data[0].daily.len(), 1);
        assert_eq!(info.site_stats_data[0].openings.len(), 1);
        assert_eq!(info.site_stats_data[0].daily[0].won, row_count as u32);
        assert_eq!(info.site_stats_data[0].openings[0].won, row_count as u32);
        eprintln!(
            "player statistics large-row heap evidence: corpus={corpus_bytes} peak={peak} threshold={threshold} sanity_peak={sanity_peak} rows={row_count}"
        );
    }

    #[test]
    fn player_statistics_many_rows_have_a_bounded_heap_peak() {
        const ROW_COUNT: usize = 32_768;
        const THRESHOLD: usize = 1024 * 1024;

        let (_dir, app, handle, database) = blocking_database_case();
        let player_id = populate_many_eligible_player_statistics_games(&app, &database, ROW_COUNT);
        let sanity_peak =
            allocation_probe::assert_detects_owned_collection(2 * THRESHOLD, THRESHOLD);
        let state = app.state::<AppState>();
        let (result, peak) = measure_player_statistics_on_one_rayon_thread(|| {
            get_players_game_info_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                player_id,
                (app.clone(), None),
                &CancellationToken::new(),
                None,
            )
        });
        let info = result.unwrap();
        assert!(
            peak < THRESHOLD,
            "player statistics peak {peak} retained per-game state for {ROW_COUNT} games (threshold {THRESHOLD}, sanity peak {sanity_peak})"
        );
        assert_eq!(info.site_stats_data.len(), 1);
        assert_eq!(info.site_stats_data[0].daily.len(), 1);
        assert_eq!(info.site_stats_data[0].openings.len(), 1);
        assert_eq!(info.site_stats_data[0].daily[0].won, ROW_COUNT as u32);
        assert_eq!(info.site_stats_data[0].openings[0].won, ROW_COUNT as u32);
        eprintln!(
            "player statistics many-row heap evidence: rows={ROW_COUNT} peak={peak} threshold={THRESHOLD} sanity_peak={sanity_peak}"
        );
    }

    #[test]
    fn search_index_generation_reports_uncertain_parent_sync() {
        use crate::infra::fs::set_test_atomic_file_injector;

        let (_dir, app, handle, database) = blocking_database_case();
        let state = app.state::<AppState>();

        set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
            "injected parent sync failure",
        ))));
        let result = generate_search_index(
            &handle,
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &CancellationToken::new(),
        );
        set_test_atomic_file_injector(None);

        assert!(matches!(
            result,
            Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::SearchIndexReplacement
            ))
        ));
        assert!(get_index_path(&database).exists());
    }

    #[test]
    fn search_index_row_conversion_failure_preserves_previous_sidecar() {
        let (_dir, app, handle, database) = blocking_database_case();
        let game_id = insert_named_game(&app, &database, "White", "Black", "Event", "Site");
        {
            let state = app.state::<AppState>();
            let mut db = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            diesel::update(games::table.find(game_id))
                .set(games::pawn_home.eq(-1))
                .execute(&mut *db)
                .unwrap();
        }
        let index_path = get_index_path(&database);
        SearchIndexChunk {
            entries: vec![crate::db::search_index::SearchGameEntry {
                id: 99,
                white_id: 1,
                black_id: 2,
                date: None,
                result: crate::db::search_index::GameResult::None,
                pawn_home: 0,
                white_material: 0,
                black_material: 0,
                white_elo: 0,
                black_elo: 0,
                fen: None,
                moves: vec![],
            }],
        }
        .write_to(&index_path)
        .unwrap();
        let previous = std::fs::read(&index_path).unwrap();
        let state = app.state::<AppState>();
        let result = generate_search_index(
            &handle,
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &CancellationToken::new(),
        );
        assert!(matches!(result, Err(Error::InvalidInput(_))));
        assert_eq!(std::fs::read(index_path).unwrap(), previous);
    }

    #[test]
    fn pagination_limit_offset_validates_and_uses_i64_arithmetic() {
        struct Case {
            page: Option<i32>,
            page_size: Option<i32>,
            expected: Result<(Option<i64>, Option<i64>), ()>,
        }

        let cases = [
            Case {
                page: None,
                page_size: Some(-1),
                expected: Err(()),
            },
            Case {
                page: Some(0),
                page_size: None,
                expected: Err(()),
            },
            Case {
                page: Some(-1),
                page_size: None,
                expected: Err(()),
            },
            Case {
                page: Some(2_000_000_000),
                page_size: Some(2),
                expected: Ok((Some(2), Some(3_999_999_998))),
            },
            Case {
                page: None,
                page_size: Some(1000),
                expected: Ok((Some(1000), None)),
            },
            Case {
                page: None,
                page_size: Some(1001),
                expected: Err(()),
            },
            Case {
                page: Some(3),
                page_size: Some(50),
                expected: Ok((Some(50), Some(100))),
            },
            Case {
                page: None,
                page_size: None,
                expected: Ok((None, None)),
            },
        ];

        for case in cases {
            let actual = pagination_limit_offset(case.page, case.page_size);
            match case.expected {
                Ok(expected) => assert_eq!(actual.unwrap(), expected),
                Err(()) => assert!(matches!(actual, Err(Error::InvalidInput(_)))),
            }
        }
    }

    #[test]
    fn pagination_limit_offset_is_used_by_all_query_commands() {
        let source = include_str!("mod.rs");

        for function_name in ["get_games", "get_players", "get_tournaments"] {
            let signature = format!("fn {function_name}_blocking(");
            let start = source.find(&signature).unwrap();
            let remainder = &source[start..];
            let end = remainder
                .find("\n#[tauri::command]")
                .unwrap_or(remainder.len());
            let function = &remainder[..end];

            assert!(
                function.contains("pagination_limit_offset"),
                "{function_name} must validate pagination through pagination_limit_offset"
            );
            assert!(
                !function.contains("limit as i64"),
                "{function_name} must not cast an unvalidated limit"
            );
        }
    }

    #[test]
    fn home_row() {
        use shakmaty::Board;

        let pawn_home = get_pawn_home(&Board::default());
        assert_eq!(pawn_home, 0b1111111111111111);

        let pawn_home = get_pawn_home(
            &Board::from_ascii_board_fen(b"8/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/8").unwrap(),
        );
        assert_eq!(pawn_home, 0b1110111111101111);

        let pawn_home = get_pawn_home(&Board::from_ascii_board_fen(b"8/8/8/8/8/8/8/8").unwrap());
        assert_eq!(pawn_home, 0b0000000000000000);
    }

    #[test]
    fn importer_handles_nested_variations() {
        let pgn = r#"[Event "T"]
[Site "S"]
[Date "2026.02.27"]
[UTCTime "12:00:00"]
[White "W"]
[Black "B"]
[Result "*"]

1. e4 (1. d4 d5 (1... Nf6) {inner}) e5 *
"#;

        let mut importer = Importer::new(None);
        let games: Vec<TempGame> = BufferedReader::new(pgn.as_bytes())
            .into_iter(&mut importer)
            .flatten()
            .flatten()
            .collect();

        assert_eq!(games.len(), 1);
        let movetext = decode_game_to_movetext(&games[0].moves, Fen::default()).unwrap();

        assert_eq!(movetext, "1. e4 (1. d4 d5 (1... Nf6) {inner}) 1... e5");
    }

    #[test]
    fn importer_handles_symbolic_and_numeric_nags() {
        let pgn = r#"[Event "T"]
[Site "S"]
[Date "2026.02.27"]
[UTCTime "12:00:00"]
[White "W"]
[Black "B"]
[Result "*"]

1. e4! (1. d4 $2) e5 $1 *
"#;

        let mut importer = Importer::new(None);
        let games: Vec<TempGame> = BufferedReader::new(pgn.as_bytes())
            .into_iter(&mut importer)
            .flatten()
            .flatten()
            .collect();

        assert_eq!(games.len(), 1);
        let movetext = decode_game_to_movetext(&games[0].moves, Fen::default()).unwrap();
        assert_eq!(movetext, "1. e4! (1. d4?) 1... e5!");
    }

    fn setup_test_db() -> SqliteConnection {
        let mut conn = SqliteConnection::establish(":memory:").unwrap();
        conn.batch_execute("PRAGMA foreign_keys = ON;").unwrap();
        conn.batch_execute(CREATE_TABLES_SQL).unwrap();
        conn
    }

    #[test]
    fn required_indexes_have_an_exact_status_and_can_be_repaired_atomically() {
        let db = &mut setup_test_db();
        assert!(!check_index_exists(db).unwrap());

        create_required_indexes(db).unwrap();
        assert!(check_index_exists(db).unwrap());

        db.transaction::<_, Error, _>(drop_required_indexes_body)
            .unwrap();
        assert!(!check_index_exists(db).unwrap());

        db.batch_execute("CREATE INDEX games_date_idx ON Games(Result);")
            .unwrap();
        assert!(!check_index_exists(db).unwrap());

        create_required_indexes(db).unwrap();
        assert!(check_index_exists(db).unwrap());
    }

    #[test]
    fn delete_orphaned_data_removes_unreferenced_players_events_sites() {
        let db = &mut setup_test_db();

        // Create players, events, sites
        let player1 = create_player(db, "Magnus").unwrap();
        let player2 = create_player(db, "Hikaru").unwrap();
        let event = create_event(db, "World Championship").unwrap();
        let site = create_site(db, "Reykjavik").unwrap();

        // Insert a game referencing them
        let game = create_game(
            db,
            NewGame {
                event_id: event.id,
                site_id: site.id,
                white_id: player1.id,
                black_id: player2.id,
                white_elo: None,
                black_elo: None,
                white_material: 0,
                black_material: 0,
                date: None,
                time: None,
                round: None,
                result: None,
                time_control: None,
                eco: None,
                ply_count: 10,
                fen: None,
                moves: &[],
                pawn_home: 0,
            },
        )
        .unwrap();

        // Verify everything exists: 3 players (Unknown + 2), 2 events, 2 sites
        let player_count: i64 = players::table.count().get_result(db).unwrap();
        assert_eq!(player_count, 3);
        let event_count: i64 = events::table.count().get_result(db).unwrap();
        assert_eq!(event_count, 2);
        let site_count: i64 = sites::table.count().get_result(db).unwrap();
        assert_eq!(site_count, 2);

        // Delete the game
        diesel::delete(games::table.filter(games::id.eq(game.id)))
            .execute(db)
            .unwrap();

        // Before fix: orphans would remain. Call our cleanup function.
        remove_orphans_and_update_counts(db).unwrap();

        // Players: only the sentinel "Unknown" (ID=0) should remain
        let player_count: i64 = players::table.count().get_result(db).unwrap();
        assert_eq!(player_count, 1, "Orphaned players should be deleted");

        let remaining_player: Player = players::table.first(db).unwrap();
        assert_eq!(
            remaining_player.id, 0,
            "Only the Unknown player should remain"
        );

        // Events: only the sentinel should remain
        let event_count: i64 = events::table.count().get_result(db).unwrap();
        assert_eq!(event_count, 1, "Orphaned events should be deleted");

        // Sites: only the sentinel should remain
        let site_count: i64 = sites::table.count().get_result(db).unwrap();
        assert_eq!(site_count, 1, "Orphaned sites should be deleted");

        assert_info_counts_match_tables(db);
    }

    #[test]
    fn delete_orphaned_data_preserves_referenced_records() {
        let db = &mut setup_test_db();

        // Create players, events, sites for two games
        let magnus = create_player(db, "Magnus").unwrap();
        let hikaru = create_player(db, "Hikaru").unwrap();
        let fabiano = create_player(db, "Fabiano").unwrap();
        let event1 = create_event(db, "World Championship").unwrap();
        let event2 = create_event(db, "Candidates").unwrap();
        let site1 = create_site(db, "Reykjavik").unwrap();
        let site2 = create_site(db, "Toronto").unwrap();

        let make_game = |db: &mut SqliteConnection, w: i32, b: i32, e: i32, s: i32| {
            create_game(
                db,
                NewGame {
                    event_id: e,
                    site_id: s,
                    white_id: w,
                    black_id: b,
                    white_elo: None,
                    black_elo: None,
                    white_material: 0,
                    black_material: 0,
                    date: None,
                    time: None,
                    round: None,
                    result: None,
                    time_control: None,
                    eco: None,
                    ply_count: 10,
                    fen: None,
                    moves: &[],
                    pawn_home: 0,
                },
            )
            .unwrap()
        };

        // Game 1: Magnus vs Hikaru at World Championship in Reykjavik
        let game1 = make_game(db, magnus.id, hikaru.id, event1.id, site1.id);
        // Game 2: Fabiano vs Hikaru at Candidates in Toronto
        let game2 = make_game(db, fabiano.id, hikaru.id, event2.id, site2.id);

        // Delete only game 1
        diesel::delete(games::table.filter(games::id.eq(game1.id)))
            .execute(db)
            .unwrap();
        remove_orphans_and_update_counts(db).unwrap();

        // Magnus should be gone (only in game 1), but Hikaru and Fabiano should remain
        let player_count: i64 = players::table.count().get_result(db).unwrap();
        assert_eq!(player_count, 3, "Unknown + Hikaru + Fabiano should remain");

        let magnus_exists: i64 = players::table
            .filter(players::name.eq("Magnus"))
            .count()
            .get_result(db)
            .unwrap();
        assert_eq!(magnus_exists, 0, "Magnus should be deleted (orphaned)");

        // Event1 and Site1 should be gone, Event2 and Site2 should remain
        let event_count: i64 = events::table.count().get_result(db).unwrap();
        assert_eq!(event_count, 2, "Unknown + Candidates should remain");

        let site_count: i64 = sites::table.count().get_result(db).unwrap();
        assert_eq!(site_count, 2, "Unknown + Toronto should remain");
        assert_info_counts_match_tables(db);

        // Delete game 2 — now everything should be orphaned
        diesel::delete(games::table.filter(games::id.eq(game2.id)))
            .execute(db)
            .unwrap();
        remove_orphans_and_update_counts(db).unwrap();

        let player_count: i64 = players::table.count().get_result(db).unwrap();
        assert_eq!(player_count, 1, "Only Unknown should remain");
        let event_count: i64 = events::table.count().get_result(db).unwrap();
        assert_eq!(event_count, 1, "Only Unknown should remain");
        let site_count: i64 = sites::table.count().get_result(db).unwrap();
        assert_eq!(site_count, 1, "Only Unknown should remain");
        assert_info_counts_match_tables(db);
    }

    fn parsed_game(pgn: &str) -> TempGame {
        parsed_games(pgn).into_iter().next().unwrap()
    }

    fn parsed_games(pgn: &str) -> Vec<TempGame> {
        let mut importer = Importer::new(None);
        BufferedReader::new(pgn.as_bytes())
            .into_iter(&mut importer)
            .flatten()
            .flatten()
            .collect()
    }

    fn test_game_pgn(white: &str, black: &str, event: &str, site: &str) -> String {
        format!(
            "[Event \"{event}\"]\n[Site \"{site}\"]\n[Date \"2026.08.09\"]\n[White \"{white}\"]\n[Black \"{black}\"]\n[Result \"*\"]\n\n1. e4 e5 *\n"
        )
    }

    fn insert_test_game(
        db: &mut SqliteConnection,
        white_id: i32,
        black_id: i32,
        event_id: i32,
        site_id: i32,
    ) -> Game {
        create_game(
            db,
            NewGame {
                event_id,
                site_id,
                white_id,
                black_id,
                white_elo: None,
                black_elo: None,
                white_material: 0,
                black_material: 0,
                date: None,
                time: None,
                round: None,
                result: None,
                time_control: None,
                eco: None,
                ply_count: 2,
                fen: None,
                moves: &[],
                pawn_home: 0,
            },
        )
        .unwrap()
    }

    type DatabaseState = (i64, i64, i64, i64, Vec<(String, Option<String>)>);

    fn database_state(db: &mut SqliteConnection) -> DatabaseState {
        (
            games::table.count().get_result(db).unwrap(),
            players::table.count().get_result(db).unwrap(),
            events::table.count().get_result(db).unwrap(),
            sites::table.count().get_result(db).unwrap(),
            info::table
                .order(info::name.asc())
                .select((info::name, info::value))
                .load(db)
                .unwrap(),
        )
    }

    fn assert_info_counts_match_tables(db: &mut SqliteConnection) {
        for (name, count) in [
            (
                "GameCount",
                games::table.count().get_result::<i64>(db).unwrap(),
            ),
            (
                "PlayerCount",
                players::table.count().get_result::<i64>(db).unwrap(),
            ),
            (
                "EventCount",
                events::table.count().get_result::<i64>(db).unwrap(),
            ),
            (
                "SiteCount",
                sites::table.count().get_result::<i64>(db).unwrap(),
            ),
        ] {
            assert_eq!(
                info::table
                    .find(name)
                    .select(info::value)
                    .first::<Option<String>>(db)
                    .unwrap(),
                Some(count.to_string()),
                "{name} must match its table"
            );
        }
    }

    #[test]
    fn delete_empty_games_maintains_all_info_counts() {
        let db = &mut setup_test_db();
        let white = create_player(db, "White").unwrap();
        let black = create_player(db, "Black").unwrap();
        let event = create_event(db, "Event").unwrap();
        let site = create_site(db, "Site").unwrap();
        let empty_game = insert_test_game(db, white.id, black.id, event.id, site.id);
        insert_test_game(db, white.id, black.id, event.id, site.id);
        diesel::update(games::table.find(empty_game.id))
            .set(games::ply_count.eq(0))
            .execute(db)
            .unwrap();

        db.transaction(delete_empty_games_transaction).unwrap();

        assert_eq!(games::table.count().get_result::<i64>(db).unwrap(), 1);
        assert_info_counts_match_tables(db);
    }

    #[test]
    fn deleting_a_game_maintains_all_info_counts() {
        let db = &mut setup_test_db();
        let white = create_player(db, "White").unwrap();
        let black = create_player(db, "Black").unwrap();
        let event = create_event(db, "Event").unwrap();
        let site = create_site(db, "Site").unwrap();
        let deleted_game = insert_test_game(db, white.id, black.id, event.id, site.id);
        insert_test_game(db, white.id, black.id, event.id, site.id);

        db.transaction(|db| delete_db_game_transaction(db, deleted_game.id))
            .unwrap();

        assert_eq!(games::table.count().get_result::<i64>(db).unwrap(), 1);
        assert_info_counts_match_tables(db);
    }

    #[test]
    fn deleting_duplicate_games_maintains_all_info_counts() {
        let db = &mut setup_test_db();
        let white = create_player(db, "White").unwrap();
        let black = create_player(db, "Black").unwrap();
        let event = create_event(db, "Event").unwrap();
        let site = create_site(db, "Site").unwrap();
        insert_test_game(db, white.id, black.id, event.id, site.id);
        insert_test_game(db, white.id, black.id, event.id, site.id);

        db.transaction(delete_duplicated_games_transaction).unwrap();

        assert_eq!(games::table.count().get_result::<i64>(db).unwrap(), 1);
        assert_info_counts_match_tables(db);
    }

    #[test]
    fn deleting_duplicate_games_keeps_games_that_differ_in_fen_result_ratings_or_time_control() {
        fn remaining_after_duplicate_delete<F>(mutate: F) -> i64
        where
            F: FnOnce(&mut SqliteConnection, i32, i32),
        {
            let db = &mut setup_test_db();
            let white = create_player(db, "White").unwrap();
            let black = create_player(db, "Black").unwrap();
            let event = create_event(db, "Event").unwrap();
            let site = create_site(db, "Site").unwrap();
            let first = insert_test_game(db, white.id, black.id, event.id, site.id);
            let second = insert_test_game(db, white.id, black.id, event.id, site.id);
            mutate(db, first.id, second.id);
            db.transaction(delete_duplicated_games_transaction).unwrap();
            games::table.count().get_result::<i64>(db).unwrap()
        }

        assert_eq!(
            remaining_after_duplicate_delete(|db, first, second| {
                diesel::update(games::table.find(first))
                    .set(games::fen.eq("4k3/8/8/8/8/8/8/4K3 w - - 0 1"))
                    .execute(db)
                    .unwrap();
                diesel::update(games::table.find(second))
                    .set(games::fen.eq("4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"))
                    .execute(db)
                    .unwrap();
            }),
            2,
            "FEN"
        );
        assert_eq!(
            remaining_after_duplicate_delete(|db, first, second| {
                diesel::update(games::table.find(first))
                    .set(games::result.eq("1-0"))
                    .execute(db)
                    .unwrap();
                diesel::update(games::table.find(second))
                    .set(games::result.eq("0-1"))
                    .execute(db)
                    .unwrap();
            }),
            2,
            "Result"
        );
        assert_eq!(
            remaining_after_duplicate_delete(|db, first, second| {
                diesel::update(games::table.find(first))
                    .set(games::white_elo.eq(2750))
                    .execute(db)
                    .unwrap();
                diesel::update(games::table.find(second))
                    .set(games::white_elo.eq(1500))
                    .execute(db)
                    .unwrap();
            }),
            2,
            "WhiteElo"
        );
        assert_eq!(
            remaining_after_duplicate_delete(|db, first, second| {
                diesel::update(games::table.find(first))
                    .set(games::black_elo.eq(2750))
                    .execute(db)
                    .unwrap();
                diesel::update(games::table.find(second))
                    .set(games::black_elo.eq(1500))
                    .execute(db)
                    .unwrap();
            }),
            2,
            "BlackElo"
        );
        assert_eq!(
            remaining_after_duplicate_delete(|db, first, second| {
                diesel::update(games::table.find(first))
                    .set(games::time_control.eq("60+0"))
                    .execute(db)
                    .unwrap();
                diesel::update(games::table.find(second))
                    .set(games::time_control.eq("180+0"))
                    .execute(db)
                    .unwrap();
            }),
            2,
            "TimeControl"
        );
    }

    #[test]
    fn normalize_pgn_result_maps_canonical_legacy_and_unknown_values() {
        for (input, expected) in [
            ("1-0", "1-0"),
            ("0-1", "0-1"),
            ("1/2-1/2", "1/2-1/2"),
            ("*", "*"),
            ("1/2", "1/2-1/2"),
            ("½-½", "1/2-1/2"),
            (" 1-0 ", "1-0"),
            (" 1/2 ", "1/2-1/2"),
            ("0-0", "*"),
            ("?", "*"),
            ("bogus", "*"),
        ] {
            assert_eq!(normalize_pgn_result(input), expected, "{input:?}");
        }
    }

    #[test]
    fn import_normalizes_half_point_result_and_keeps_sibling_games() {
        let pgn = concat!(
            "[Event \"A\"]\n[White \"W1\"]\n[Black \"B1\"]\n[Result \"1-0\"]\n\n1. e4 1-0\n\n",
            "[Event \"B\"]\n[White \"W2\"]\n[Black \"B2\"]\n[Result \"1/2\"]\n\n1. d4 1/2-1/2\n\n",
            "[Event \"C\"]\n[White \"W3\"]\n[Black \"B3\"]\n[Result \"0-1\"]\n\n1. c4 0-1\n",
        );
        let parsed = parsed_games(pgn);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[1].result.as_deref(), Some("1/2-1/2"));

        let db = &mut setup_test_db();
        for game in &parsed {
            game.insert_to_db(db).unwrap();
        }
        let stored: Vec<Option<String>> = games::table
            .select(games::result)
            .order(games::id.asc())
            .load(db)
            .unwrap();
        assert_eq!(
            stored,
            vec![
                Some("1-0".into()),
                Some("1/2-1/2".into()),
                Some("0-1".into())
            ]
        );
    }

    #[test]
    fn create_game_reports_invalid_result_as_database_error() {
        let db = &mut setup_test_db();
        let white = create_player(db, "White").unwrap();
        let black = create_player(db, "Black").unwrap();
        let event = create_event(db, "Event").unwrap();
        let site = create_site(db, "Site").unwrap();
        match create_game(
            db,
            NewGame {
                event_id: event.id,
                site_id: site.id,
                white_id: white.id,
                black_id: black.id,
                white_elo: None,
                black_elo: None,
                white_material: 0,
                black_material: 0,
                date: None,
                time: None,
                round: None,
                result: Some("bogus"),
                time_control: None,
                eco: None,
                ply_count: 2,
                fen: None,
                moves: &[],
                pawn_home: 0,
            },
        ) {
            Err(diesel::result::Error::DatabaseError(_, _)) => {}
            Err(error) => panic!("constraint failure must surface as DatabaseError, got {error:?}"),
            Ok(_) => panic!("constraint failure must surface as DatabaseError, got Ok"),
        }
    }

    #[test]
    fn import_keeps_games_with_stale_castling_rights_and_roundtrips_moves() {
        let fen = "4k3/8/8/8/8/8/8/4K3 w KQkq - 0 1";
        let pgn = format!(
            "[Event \"Study\"]\n[White \"White\"]\n[Black \"Black\"]\n[Result \"*\"]\n[FEN \"{fen}\"]\n[SetUp \"1\"]\n\n1. Ke2 *\n"
        );
        let parsed = parsed_game(&pgn);
        assert_eq!(parsed.fen.as_deref(), Some(fen));

        let db = &mut setup_test_db();
        let id = parsed.insert_to_db(db).unwrap();
        let stored: Game = games::table.find(id).first(db).unwrap();
        let stored_fen: Fen = stored
            .fen
            .as_deref()
            .expect("imported FEN")
            .parse()
            .unwrap();
        assert_eq!(
            decode_game_to_movetext(&stored.moves, stored_fen).unwrap(),
            "1. Ke2"
        );
    }

    #[test]
    fn deleting_empty_games_rolls_back_with_the_enclosing_transaction() {
        let db = &mut setup_test_db();
        let white = create_player(db, "White").unwrap();
        let black = create_player(db, "Black").unwrap();
        let event = create_event(db, "Event").unwrap();
        let site = create_site(db, "Site").unwrap();
        let empty_game = insert_test_game(db, white.id, black.id, event.id, site.id);
        diesel::update(games::table.find(empty_game.id))
            .set(games::ply_count.eq(0))
            .execute(db)
            .unwrap();
        remove_orphans_and_update_counts(db).unwrap();
        let before = database_state(db);

        let result: Result<(), Error> = db.transaction(|db| {
            delete_empty_games_transaction(db)?;
            Err(Error::InvalidInput("injected delete failure".into()))
        });

        assert!(
            matches!(result, Err(Error::InvalidInput(message)) if message == "injected delete failure")
        );
        assert_eq!(database_state(db), before);
    }

    #[test]
    fn writing_nonexistent_game_leaves_database_unchanged() {
        let db = &mut setup_test_db();
        remove_orphans_and_update_counts(db).unwrap();
        let before = database_state(db);
        let replacement = parsed_game(&test_game_pgn(
            "New White",
            "New Black",
            "New Event",
            "New Site",
        ));

        let result = db.transaction(|db| {
            write_parsed_db_game(
                db,
                404,
                &replacement,
                "missing",
                remove_orphans_and_update_counts,
            )
        });

        assert!(matches!(result, Err(Error::GameNotFound(id)) if id == "404"));
        assert_eq!(database_state(db), before);
    }

    #[test]
    fn writing_game_removes_old_last_referenced_dimensions() {
        let db = &mut setup_test_db();
        let old_white = create_player(db, "Old White").unwrap();
        let old_black = create_player(db, "Old Black").unwrap();
        let old_event = create_event(db, "Old Event").unwrap();
        let old_site = create_site(db, "Old Site").unwrap();
        let game = insert_test_game(db, old_white.id, old_black.id, old_event.id, old_site.id);
        let replacement = parsed_game(&test_game_pgn(
            "New White",
            "New Black",
            "New Event",
            "New Site",
        ));

        db.transaction(|db| {
            write_parsed_db_game(
                db,
                game.id,
                &replacement,
                &game_row_stamp(&game),
                remove_orphans_and_update_counts,
            )
        })
        .unwrap();

        for name in ["Old White", "Old Black"] {
            assert_eq!(
                players::table
                    .filter(players::name.eq(name))
                    .count()
                    .get_result::<i64>(db)
                    .unwrap(),
                0
            );
        }
        assert_eq!(
            events::table
                .filter(events::name.eq("Old Event"))
                .count()
                .get_result::<i64>(db)
                .unwrap(),
            0
        );
        assert_eq!(
            sites::table
                .filter(sites::name.eq("Old Site"))
                .count()
                .get_result::<i64>(db)
                .unwrap(),
            0
        );
        assert_eq!(database_state(db).0, 1);
        assert_eq!(database_state(db).1, 3);
        assert_eq!(database_state(db).2, 2);
        assert_eq!(database_state(db).3, 2);
        assert_info_counts_match_tables(db);
    }

    #[test]
    fn writing_game_rolls_back_when_final_metadata_maintenance_fails() {
        fn fail_final_metadata(_: &mut SqliteConnection) -> Result<(), Error> {
            Err(Error::InvalidInput("injected metadata failure".into()))
        }

        let db = &mut setup_test_db();
        let old_white = create_player(db, "Old White").unwrap();
        let old_black = create_player(db, "Old Black").unwrap();
        let old_event = create_event(db, "Old Event").unwrap();
        let old_site = create_site(db, "Old Site").unwrap();
        let game = insert_test_game(db, old_white.id, old_black.id, old_event.id, old_site.id);
        remove_orphans_and_update_counts(db).unwrap();
        let before = database_state(db);
        let replacement = parsed_game(&test_game_pgn(
            "New White",
            "New Black",
            "New Event",
            "New Site",
        ));

        let result = db.transaction(|db| {
            write_parsed_db_game(
                db,
                game.id,
                &replacement,
                &game_row_stamp(&game),
                fail_final_metadata,
            )
        });

        assert!(
            matches!(result, Err(Error::InvalidInput(message)) if message == "injected metadata failure")
        );
        assert_eq!(database_state(db), before);
    }

    #[test]
    fn merge_rejects_invalid_player_ids_without_mutating_database() {
        let db = &mut setup_test_db();
        let source = create_player(db, "Source").unwrap();
        let target = create_player(db, "Target").unwrap();
        let opponent = create_player(db, "Opponent").unwrap();
        let event = create_event(db, "Event").unwrap();
        let site = create_site(db, "Site").unwrap();
        insert_test_game(db, source.id, opponent.id, event.id, site.id);
        insert_test_game(db, target.id, opponent.id, event.id, site.id);
        remove_orphans_and_update_counts(db).unwrap();
        let before = database_state(db);

        for (source_id, target_id, expected_message) in [
            (
                source.id,
                source.id,
                "source and target player IDs must be different",
            ),
            (0, target.id, "the unknown player (ID 0) cannot be merged"),
            (source.id, 0, "the unknown player (ID 0) cannot be merged"),
            (999, target.id, "source player 999 does not exist"),
            (source.id, 999, "target player 999 does not exist"),
        ] {
            let result = db.transaction(|db| merge_players_transaction(db, source_id, target_id));
            match result {
                Err(Error::InvalidInput(message)) => assert_eq!(message, expected_message),
                other => panic!("expected InvalidInput, got {other:?}"),
            }
            assert_eq!(database_state(db), before);
        }
    }

    #[test]
    fn merge_rejects_both_head_to_head_orientations_without_mutating_database() {
        for (white_is_source, black_is_source) in [(true, false), (false, true)] {
            let db = &mut setup_test_db();
            let source = create_player(db, "Source").unwrap();
            let target = create_player(db, "Target").unwrap();
            let event = create_event(db, "Event").unwrap();
            let site = create_site(db, "Site").unwrap();
            let (white_id, black_id) = if white_is_source {
                (source.id, target.id)
            } else {
                (target.id, source.id)
            };
            assert_ne!(white_is_source, black_is_source);
            insert_test_game(db, white_id, black_id, event.id, site.id);
            remove_orphans_and_update_counts(db).unwrap();
            let before = database_state(db);

            let result = db.transaction(|db| merge_players_transaction(db, source.id, target.id));

            assert!(matches!(result, Err(Error::NotDistinctPlayers)));
            assert_eq!(database_state(db), before);
        }
    }

    #[test]
    fn merge_rewrites_white_and_black_references_then_deletes_source() {
        let db = &mut setup_test_db();
        let source = create_player(db, "Source").unwrap();
        let target = create_player(db, "Target").unwrap();
        let opponent = create_player(db, "Opponent").unwrap();
        let event = create_event(db, "Event").unwrap();
        let site = create_site(db, "Site").unwrap();
        let white_game = insert_test_game(db, source.id, opponent.id, event.id, site.id);
        let black_game = insert_test_game(db, opponent.id, source.id, event.id, site.id);

        db.transaction(|db| merge_players_transaction(db, source.id, target.id))
            .unwrap();

        assert_eq!(
            games::table
                .find(white_game.id)
                .select(games::white_id)
                .first::<i32>(db)
                .unwrap(),
            target.id
        );
        assert_eq!(
            games::table
                .find(black_game.id)
                .select(games::black_id)
                .first::<i32>(db)
                .unwrap(),
            target.id
        );
        assert_eq!(
            players::table
                .find(source.id)
                .count()
                .get_result::<i64>(db)
                .unwrap(),
            0
        );
        assert_eq!(database_state(db).1, 3);
        assert_info_counts_match_tables(db);
    }

    #[cfg(unix)]
    fn recorded_result<T>(
        expected: PathOperation,
        operation: impl FnOnce() -> Result<T, Error>,
    ) -> Result<T, Error> {
        let _ = take_resolve_database_operations();
        let result = operation();
        let recorded = take_resolve_database_operations();
        assert_eq!(recorded.first(), Some(&expected));
        result
    }

    #[cfg(unix)]
    fn assert_permit_error<T>(result: Result<T, Error>) {
        assert!(matches!(
            result,
            Err(Error::InvalidInput(message))
                if message == "workspace entry does not permit this operation"
        ));
    }

    #[cfg(unix)]
    fn assert_refused_operation<T>(
        granted: PathOperation,
        requested: PathOperation,
        command: impl FnOnce(
            &tempfile::TempDir,
            &tauri::AppHandle<tauri::test::MockRuntime>,
            DatabaseHandle,
        ) -> Result<T, Error>,
    ) {
        let (dir, app, handle, _database) = schema_database_case("games", vec![granted]);
        let result = recorded_result(requested, || command(&dir, &app, handle));
        assert_permit_error(result);
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_read_permits_get_db_info() {
        let (_dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseRead]);
        let state = app.state::<AppState>();
        assert!(recorded_result(PathOperation::DatabaseRead, || {
            get_db_info_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle.clone(),
            )
        })
        .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_read_permits_get_games() {
        let (_dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseRead]);
        let state = app.state::<AppState>();
        assert!(recorded_result(PathOperation::DatabaseRead, || {
            get_games_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle.clone(),
                GameQuery::new(),
                &CancellationToken::new(),
            )
        })
        .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_read_permits_get_player() {
        let (_dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseRead]);
        let state = app.state::<AppState>();
        assert!(recorded_result(PathOperation::DatabaseRead, || {
            get_player_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle.clone(),
                1,
            )
        })
        .unwrap()
        .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_read_permits_get_players() {
        let (_dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseRead]);
        let state = app.state::<AppState>();
        let player_query = PlayerQuery {
            options: QueryOptions {
                sort: PlayerSort::Name,
                direction: SortDirection::Asc,
                skip_count: true,
                page: None,
                page_size: None,
            },
            name: None,
            name_match: None,
            range: None,
        };
        assert!(recorded_result(PathOperation::DatabaseRead, || {
            get_players_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle.clone(),
                player_query,
                &CancellationToken::new(),
            )
        })
        .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_read_permits_get_tournaments() {
        let (_dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseRead]);
        let state = app.state::<AppState>();
        let tournament_query = TournamentQuery {
            options: QueryOptions {
                sort: TournamentSort::Name,
                direction: SortDirection::Asc,
                skip_count: true,
                page: None,
                page_size: None,
            },
            name: None,
        };
        assert!(recorded_result(PathOperation::DatabaseRead, || {
            get_tournaments_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle.clone(),
                tournament_query,
                &CancellationToken::new(),
            )
        })
        .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_read_permits_get_players_game_info() {
        let (_dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseRead]);
        let state = app.state::<AppState>();
        assert!(recorded_result(PathOperation::DatabaseRead, || {
            get_players_game_info_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                1,
                (app.clone(), None),
                &CancellationToken::new(),
                None,
            )
        })
        .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_create_permits_convert_pgn() {
        let (_dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseCreate]);
        let state = app.state::<AppState>();
        assert!(recorded_result(PathOperation::DatabaseCreate, || {
            convert_pgn_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                vec![],
                handle,
                None,
                app.clone(),
                "Imported".into(),
                None,
                "matrix".into(),
                &CancellationToken::new(),
            )
        })
        .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_export_permits_export_to_pgn() {
        let (dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseExport]);
        let state = app.state::<AppState>();
        let destination_path = dir.path().join("export.pgn");
        std::fs::write(&destination_path, b"").unwrap();
        let destination = grant_pgn_destination(&app, &destination_path);
        assert!(recorded_result(PathOperation::DatabaseExport, || {
            export_to_pgn_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                destination,
                &CancellationToken::new(),
            )
        })
        .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_mutate_permits_create_indexes() {
        let (_dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseMutate]);
        let state = app.state::<AppState>();
        assert!(recorded_result(PathOperation::DatabaseMutate, || {
            create_indexes_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                &CancellationToken::new(),
            )
        })
        .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_mutate_permits_delete_indexes() {
        let (_dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseMutate]);
        let state = app.state::<AppState>();
        assert!(recorded_result(PathOperation::DatabaseMutate, || {
            delete_indexes_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                &CancellationToken::new(),
            )
        })
        .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_mutate_permits_edit_db_info() {
        let (_dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseMutate]);
        let state = app.state::<AppState>();
        assert!(recorded_result(PathOperation::DatabaseMutate, || {
            edit_db_info_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                handle,
                Some("Matrix".into()),
                Some("Operation".into()),
                &CancellationToken::new(),
            )
        })
        .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_mutate_permits_delete_duplicated_games() {
        let (_dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseMutate]);
        let state = app.state::<AppState>();
        assert!(recorded_result(PathOperation::DatabaseMutate, || {
            delete_duplicated_games_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                handle,
                &CancellationToken::new(),
            )
        })
        .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_mutate_permits_delete_empty_games() {
        let (_dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseMutate]);
        let state = app.state::<AppState>();
        assert!(recorded_result(PathOperation::DatabaseMutate, || {
            delete_empty_games_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                handle,
                &CancellationToken::new(),
            )
        })
        .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_mutate_permits_delete_db_game() {
        let (_dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseMutate]);
        let state = app.state::<AppState>();
        assert!(recorded_result(PathOperation::DatabaseMutate, || {
            delete_db_game_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                handle,
                1,
                &CancellationToken::new(),
            )
        })
        .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_mutate_permits_write_db_game() {
        let (_dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseMutate]);
        let state = app.state::<AppState>();
        assert!(matches!(
            recorded_result(PathOperation::DatabaseMutate, || {
                write_db_game_blocking(
                    &state.pgn_path_authority,
                    &state.database_repository,
                    &state.search_cache,
                    handle,
                    1,
                    "".into(),
                    String::new(),
                    &CancellationToken::new(),
                )
            }),
            Err(Error::NoMovesFound)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_mutate_permits_merge_players() {
        let (_dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseMutate]);
        let state = app.state::<AppState>();
        assert!(matches!(
            recorded_result(PathOperation::DatabaseMutate, || {
                merge_players_blocking(
                    &state.pgn_path_authority,
                    &state.database_repository,
                    &state.search_cache,
                    handle,
                    1,
                    2,
                    &CancellationToken::new(),
                )
            }),
            Err(Error::InvalidInput(message)) if message == "source player 1 does not exist"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_mutate_permits_generate_search_index() {
        let (_dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseMutate]);
        let state = app.state::<AppState>();
        assert!(recorded_result(PathOperation::DatabaseMutate, || {
            generate_search_index(
                &handle,
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                &CancellationToken::new(),
            )
        })
        .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_mutate_permits_delete_database() {
        let (_dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseMutate]);
        let state = app.state::<AppState>();
        assert!(recorded_result(PathOperation::DatabaseMutate, || {
            delete_database_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                handle,
                &CancellationToken::new(),
            )
        })
        .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_read_refuses_create_indexes() {
        let (_dir, app, handle, _database) =
            schema_database_case("games", vec![PathOperation::DatabaseRead]);
        let state = app.state::<AppState>();
        assert_permit_error(recorded_result(PathOperation::DatabaseMutate, || {
            create_indexes_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                &CancellationToken::new(),
            )
        }));
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_create_refuses_get_db_info() {
        assert_refused_operation(
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseRead,
            |_, app, handle| {
                get_db_info_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    handle,
                )
                .map(|_| ())
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_create_refuses_export_to_pgn() {
        assert_refused_operation(
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseExport,
            |dir, app, handle| {
                let destination_path = dir.path().join("export.pgn");
                std::fs::write(&destination_path, b"").unwrap();
                let destination = grant_pgn_destination(app, &destination_path);
                export_to_pgn_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    handle,
                    destination,
                    &CancellationToken::new(),
                )
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_create_refuses_create_indexes() {
        assert_refused_operation(
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseMutate,
            |_, app, handle| {
                create_indexes_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    handle,
                    &CancellationToken::new(),
                )
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_create_refuses_get_games() {
        assert_refused_operation(
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseRead,
            |_, app, handle| {
                get_games_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    handle,
                    GameQuery::new(),
                    &CancellationToken::new(),
                )
                .map(|_| ())
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_create_refuses_get_player() {
        assert_refused_operation(
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseRead,
            |_, app, handle| {
                get_player_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    handle,
                    1,
                )
                .map(|_| ())
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_create_refuses_get_players() {
        assert_refused_operation(
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseRead,
            |_, app, handle| {
                get_players_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    handle,
                    PlayerQuery {
                        options: QueryOptions {
                            sort: PlayerSort::Name,
                            direction: SortDirection::Asc,
                            skip_count: true,
                            page: None,
                            page_size: None,
                        },
                        name: None,
                        name_match: None,
                        range: None,
                    },
                    &CancellationToken::new(),
                )
                .map(|_| ())
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_create_refuses_get_tournaments() {
        assert_refused_operation(
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseRead,
            |_, app, handle| {
                get_tournaments_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    handle,
                    TournamentQuery {
                        options: QueryOptions {
                            sort: TournamentSort::Name,
                            direction: SortDirection::Asc,
                            skip_count: true,
                            page: None,
                            page_size: None,
                        },
                        name: None,
                    },
                    &CancellationToken::new(),
                )
                .map(|_| ())
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_create_refuses_get_players_game_info() {
        assert_refused_operation(
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseRead,
            |_, app, handle| {
                get_players_game_info_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    handle,
                    1,
                    (app.clone(), None),
                    &CancellationToken::new(),
                    None,
                )
                .map(|_| ())
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_create_refuses_delete_indexes() {
        assert_refused_operation(
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseMutate,
            |_, app, handle| {
                delete_indexes_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    handle,
                    &CancellationToken::new(),
                )
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_create_refuses_edit_db_info() {
        assert_refused_operation(
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseMutate,
            |_, app, handle| {
                edit_db_info_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    &app.state::<AppState>().search_cache,
                    handle,
                    Some("Matrix".into()),
                    Some("Operation".into()),
                    &CancellationToken::new(),
                )
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_create_refuses_delete_duplicated_games() {
        assert_refused_operation(
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseMutate,
            |_, app, handle| {
                delete_duplicated_games_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    &app.state::<AppState>().search_cache,
                    handle,
                    &CancellationToken::new(),
                )
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_create_refuses_delete_empty_games() {
        assert_refused_operation(
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseMutate,
            |_, app, handle| {
                delete_empty_games_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    &app.state::<AppState>().search_cache,
                    handle,
                    &CancellationToken::new(),
                )
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_create_refuses_delete_db_game() {
        assert_refused_operation(
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseMutate,
            |_, app, handle| {
                delete_db_game_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    &app.state::<AppState>().search_cache,
                    handle,
                    1,
                    &CancellationToken::new(),
                )
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_create_refuses_write_db_game() {
        assert_refused_operation(
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseMutate,
            |_, app, handle| {
                write_db_game_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    &app.state::<AppState>().search_cache,
                    handle,
                    1,
                    "".into(),
                    String::new(),
                    &CancellationToken::new(),
                )
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_create_refuses_merge_players() {
        assert_refused_operation(
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseMutate,
            |_, app, handle| {
                merge_players_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    &app.state::<AppState>().search_cache,
                    handle,
                    1,
                    2,
                    &CancellationToken::new(),
                )
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_create_refuses_generate_search_index() {
        assert_refused_operation(
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseMutate,
            |_, app, handle| {
                generate_search_index(
                    &handle,
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    &app.state::<AppState>().search_cache,
                    &CancellationToken::new(),
                )
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_create_refuses_delete_database() {
        assert_refused_operation(
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseMutate,
            |_, app, handle| {
                delete_database_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    &app.state::<AppState>().search_cache,
                    handle,
                    &CancellationToken::new(),
                )
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_export_refuses_convert_pgn() {
        assert_refused_operation(
            PathOperation::DatabaseExport,
            PathOperation::DatabaseCreate,
            |_, app, handle| {
                convert_pgn_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    &app.state::<AppState>().search_cache,
                    vec![],
                    handle,
                    None,
                    app.clone(),
                    "Imported".into(),
                    None,
                    "matrix".into(),
                    &CancellationToken::new(),
                )
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_export_refuses_get_db_info() {
        assert_refused_operation(
            PathOperation::DatabaseExport,
            PathOperation::DatabaseRead,
            |_, app, handle| {
                get_db_info_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    handle,
                )
                .map(|_| ())
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_export_refuses_create_indexes() {
        assert_refused_operation(
            PathOperation::DatabaseExport,
            PathOperation::DatabaseMutate,
            |_, app, handle| {
                create_indexes_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    handle,
                    &CancellationToken::new(),
                )
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_mutate_refuses_convert_pgn() {
        assert_refused_operation(
            PathOperation::DatabaseMutate,
            PathOperation::DatabaseCreate,
            |_, app, handle| {
                convert_pgn_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    &app.state::<AppState>().search_cache,
                    vec![],
                    handle,
                    None,
                    app.clone(),
                    "Imported".into(),
                    None,
                    "matrix".into(),
                    &CancellationToken::new(),
                )
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_mutate_refuses_get_db_info() {
        assert_refused_operation(
            PathOperation::DatabaseMutate,
            PathOperation::DatabaseRead,
            |_, app, handle| {
                get_db_info_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    handle,
                )
                .map(|_| ())
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_mutate_refuses_export_to_pgn() {
        assert_refused_operation(
            PathOperation::DatabaseMutate,
            PathOperation::DatabaseExport,
            |dir, app, handle| {
                let destination_path = dir.path().join("export.pgn");
                std::fs::write(&destination_path, b"").unwrap();
                let destination = grant_pgn_destination(app, &destination_path);
                export_to_pgn_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    handle,
                    destination,
                    &CancellationToken::new(),
                )
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_read_refuses_convert_pgn() {
        assert_refused_operation(
            PathOperation::DatabaseRead,
            PathOperation::DatabaseCreate,
            |_, app, handle| {
                convert_pgn_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    &app.state::<AppState>().search_cache,
                    vec![],
                    handle,
                    None,
                    app.clone(),
                    "Imported".into(),
                    None,
                    "matrix".into(),
                    &CancellationToken::new(),
                )
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn commands_resolve_with_their_own_operation_read_refuses_export_to_pgn() {
        assert_refused_operation(
            PathOperation::DatabaseRead,
            PathOperation::DatabaseExport,
            |dir, app, handle| {
                let destination_path = dir.path().join("export.pgn");
                std::fs::write(&destination_path, b"").unwrap();
                let destination = grant_pgn_destination(app, &destination_path);
                export_to_pgn_blocking(
                    &app.state::<AppState>().pgn_path_authority,
                    &app.state::<AppState>().database_repository,
                    handle,
                    destination,
                    &CancellationToken::new(),
                )
            },
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn production_database_core_invalidates_cache_after_command_caller_drop() {
        let (_dir, app, handle, database) = blocking_database_case();
        let index = get_index_path(&database);
        std::fs::write(&index, b"cache identity").unwrap();
        let identity = crate::SearchIndexIdentity::for_test_database(
            &database,
            crate::db::search_index::IndexSource::from_database(&database, 0).unwrap(),
        )
        .unwrap();
        let cache_key = crate::SearchResultKey::new(GameQuery::new(), identity);
        app.state::<AppState>()
            .search_cache
            .insert_result(cache_key.clone(), (vec![], vec![]));
        assert!(app
            .state::<AppState>()
            .search_cache
            .get_result(&cache_key)
            .is_some());
        let repository = Arc::clone(&app.state::<AppState>().database_repository);
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let holder = std::thread::spawn(move || {
            repository
                .with_write_lock(&test_target(&database), || {
                    entered_tx.send(()).unwrap();
                    let _ = release_rx.recv_timeout(std::time::Duration::from_secs(5));
                    Ok(())
                })
                .unwrap();
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();

        let command_app = app.clone();
        let command_handle = handle.clone();
        let caller = tokio::spawn(async move {
            let state = command_app.state::<AppState>();
            edit_db_info(
                command_handle,
                Some("after caller drop".into()),
                Some("tail completed".into()),
                state,
            )
            .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while app
                .state::<AppState>()
                .operations
                .outstanding_labels()
                .unwrap()
                .is_empty()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        caller.abort();
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !app
                .state::<AppState>()
                .operations
                .outstanding_labels()
                .unwrap()
                .is_empty()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        let state = app.state::<AppState>();
        let info = get_db_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
        )
        .unwrap();
        assert_eq!(info.title, "after caller drop");
        assert_eq!(info.description, "tail completed");
        assert!(state.search_cache.get_result(&cache_key).is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn production_database_delete_error_tail_survives_command_caller_drop() {
        let (dir, app, handle, database) = blocking_database_case();
        let index = get_index_path(&database);
        std::fs::write(&index, b"cache identity").unwrap();
        let identity = crate::SearchIndexIdentity::for_test_database(
            &database,
            crate::db::search_index::IndexSource::from_database(&database, 0).unwrap(),
        )
        .unwrap();
        let cache_key = crate::SearchResultKey::new(GameQuery::new(), identity);
        app.state::<AppState>()
            .search_cache
            .insert_result(cache_key.clone(), (vec![], vec![]));

        let database_target = test_target(&database);
        let held_connection = app
            .state::<AppState>()
            .database_repository
            .connection(&database_target, None)
            .unwrap();
        let command_app = app.clone();
        let caller = tokio::spawn(async move {
            let state = command_app.state::<AppState>();
            delete_database(handle, state).await
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !app
                .state::<AppState>()
                .database_repository
                .deletion_is_waiting(&database_target)
                .unwrap()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        caller.abort();
        let registry = dir.path().join("registry.json");
        std::fs::remove_file(&registry).unwrap();
        std::fs::create_dir(&registry).unwrap();
        drop(held_connection);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !app
                .state::<AppState>()
                .operations
                .outstanding_labels()
                .unwrap()
                .is_empty()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        assert!(!database.exists(), "the primary database unlink completed");
        assert!(
            registry.is_dir(),
            "the registry replacement failure remained in place"
        );
        assert!(app
            .state::<AppState>()
            .search_cache
            .get_result(&cache_key)
            .is_none());
    }

    macro_rules! database_command_cases {
        ($($variant:ident => $name:ident),+ $(,)?) => {
            #[derive(Clone, Copy, Debug)]
            enum DatabaseCommandCase {
                $($variant),+
            }

            mod every_database_command_finishes_its_real_tail_after_caller_drop {
                use super::*;

                $(
                    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
                    async fn $name() {
                        assert_database_command_finishes_its_real_tail_after_caller_drop(
                            DatabaseCommandCase::$variant,
                        ).await;
                    }
                )+
            }

            mod every_database_command_retires_its_error_tail_after_caller_drop {
                use super::*;

                $(
                    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
                    async fn $name() {
                        assert_database_command_retires_its_error_tail_after_caller_drop(
                            DatabaseCommandCase::$variant,
                        ).await;
                    }
                )+
            }
        };
    }

    database_command_cases! {
        ConvertPgn => convert_pgn,
        CreateIndexes => create_indexes,
        DeleteIndexes => delete_indexes,
        EditDbInfo => edit_db_info,
        DeleteDatabase => delete_database,
        DeleteDuplicatedGames => delete_duplicated_games,
        DeleteEmptyGames => delete_empty_games,
        ExportToPgn => export_to_pgn,
        DeleteDbGame => delete_db_game,
        WriteDbGame => write_db_game,
        MergePlayers => merge_players,
    }

    impl DatabaseCommandCase {
        fn label(self) -> &'static str {
            match self {
                Self::ConvertPgn => "convert_pgn",
                Self::CreateIndexes => "create_indexes",
                Self::DeleteIndexes => "delete_indexes",
                Self::EditDbInfo => "edit_db_info",
                Self::DeleteDatabase => "delete_database",
                Self::DeleteDuplicatedGames => "delete_duplicated_games",
                Self::DeleteEmptyGames => "delete_empty_games",
                Self::ExportToPgn => "export_to_pgn",
                Self::DeleteDbGame => "delete_db_game",
                Self::WriteDbGame => "write_db_game",
                Self::MergePlayers => "merge_players",
            }
        }

        fn invalidates_cache(self) -> bool {
            !matches!(
                self,
                Self::CreateIndexes | Self::DeleteIndexes | Self::ExportToPgn
            )
        }
    }

    #[derive(Default)]
    struct DatabaseCommandInputs {
        pgn: Option<FileWorkspaceHandle>,
        destination: Option<FileWorkspaceHandle>,
        game_id: i32,
        expected_stamp: String,
        source_player: i32,
        target_player: i32,
    }

    fn prepare_database_command_case(
        case: DatabaseCommandCase,
        dir: &Path,
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        database: &Path,
    ) -> DatabaseCommandInputs {
        let mut inputs = DatabaseCommandInputs::default();
        match case {
            DatabaseCommandCase::ConvertPgn => {
                let path = dir.join("import.pgn");
                std::fs::write(&path, REPLACEMENT_PGN).unwrap();
                inputs.pgn = Some(grant_pgn_file(
                    app,
                    &path,
                    "import.pgn",
                    vec![PathOperation::ReadPgn],
                ));
                mount_convert_progress_events(app);
            }
            DatabaseCommandCase::CreateIndexes => {}
            DatabaseCommandCase::DeleteIndexes => {
                let state = app.state::<AppState>();
                let mut db = state
                    .database_repository
                    .connection(&test_target(database), None)
                    .unwrap();
                create_required_indexes(&mut db).unwrap();
            }
            DatabaseCommandCase::EditDbInfo => {}
            DatabaseCommandCase::DeleteDatabase => {}
            DatabaseCommandCase::DeleteDuplicatedGames => {
                insert_named_game(app, database, "White", "Black", "Event", "Site");
                insert_named_game(app, database, "White", "Black", "Event", "Site");
            }
            DatabaseCommandCase::DeleteEmptyGames => {
                inputs.game_id =
                    insert_named_game(app, database, "White", "Black", "Event", "Site");
                let state = app.state::<AppState>();
                let mut db = state
                    .database_repository
                    .connection(&test_target(database), None)
                    .unwrap();
                diesel::update(games::table.find(inputs.game_id))
                    .set(games::ply_count.eq(0))
                    .execute(&mut *db)
                    .unwrap();
            }
            DatabaseCommandCase::ExportToPgn => {
                insert_named_game(app, database, "White", "Black", "Event", "Site");
                let path = dir.join("export.pgn");
                std::fs::write(&path, b"old").unwrap();
                inputs.destination = Some(grant_pgn_destination(app, &path));
            }
            DatabaseCommandCase::DeleteDbGame | DatabaseCommandCase::WriteDbGame => {
                inputs.game_id =
                    insert_named_game(app, database, "White", "Black", "Event", "Site");
                let state = app.state::<AppState>();
                let mut db = state
                    .database_repository
                    .connection(&test_target(database), None)
                    .unwrap();
                let row = games::table
                    .find(inputs.game_id)
                    .first::<Game>(&mut *db)
                    .unwrap();
                inputs.expected_stamp = game_row_stamp(&row);
            }
            DatabaseCommandCase::MergePlayers => {
                let state = app.state::<AppState>();
                let mut db = state
                    .database_repository
                    .connection(&test_target(database), None)
                    .unwrap();
                let source = create_player(&mut db, "Source").unwrap();
                let target = create_player(&mut db, "Target").unwrap();
                let opponent = create_player(&mut db, "Opponent").unwrap();
                let event = create_event(&mut db, "Event").unwrap();
                let site = create_site(&mut db, "Site").unwrap();
                inputs.game_id =
                    insert_test_game(&mut db, source.id, opponent.id, event.id, site.id).id;
                inputs.source_player = source.id;
                inputs.target_player = target.id;
            }
        }
        inputs
    }

    async fn run_database_command_case(
        case: DatabaseCommandCase,
        app: tauri::AppHandle<tauri::test::MockRuntime>,
        handle: DatabaseHandle,
        inputs: DatabaseCommandInputs,
    ) -> Result<(), Error> {
        let state = app.state::<AppState>();
        match case {
            DatabaseCommandCase::ConvertPgn => {
                convert_pgn_command_core(
                    "matrix-convert".into(),
                    vec![inputs.pgn.unwrap()],
                    handle,
                    app.clone(),
                    "Imported".into(),
                    None,
                    None,
                    "main",
                    &state,
                )
                .await
            }
            DatabaseCommandCase::CreateIndexes => create_indexes(handle, state).await,
            DatabaseCommandCase::DeleteIndexes => delete_indexes(handle, state).await,
            DatabaseCommandCase::EditDbInfo => {
                edit_db_info(handle, Some("Matrix".into()), None, state).await
            }
            DatabaseCommandCase::DeleteDatabase => delete_database(handle, state).await,
            DatabaseCommandCase::DeleteDuplicatedGames => {
                delete_duplicated_games(handle, state).await
            }
            DatabaseCommandCase::DeleteEmptyGames => delete_empty_games(handle, state).await,
            DatabaseCommandCase::ExportToPgn => {
                export_to_pgn(handle, inputs.destination.unwrap(), state).await
            }
            DatabaseCommandCase::DeleteDbGame => {
                delete_db_game(handle, inputs.game_id, state).await
            }
            DatabaseCommandCase::WriteDbGame => write_db_game(
                handle,
                inputs.game_id,
                REPLACEMENT_PGN.into(),
                inputs.expected_stamp,
                state,
            )
            .await
            .map(|_| ()),
            DatabaseCommandCase::MergePlayers => {
                merge_players(handle, inputs.source_player, inputs.target_player, state).await
            }
        }
    }

    async fn assert_database_command_finishes_its_real_tail_after_caller_drop(
        case: DatabaseCommandCase,
    ) {
        let (dir, app, handle, database) = blocking_database_case();
        let inputs = prepare_database_command_case(case, dir.path(), &app, &database);
        let index = get_index_path(&database);
        std::fs::write(&index, b"matrix cache identity").unwrap();
        let identity = crate::SearchIndexIdentity::for_test_database(
            &database,
            crate::db::search_index::IndexSource::from_database(&database, 0).unwrap(),
        )
        .unwrap();
        let cache_key = crate::SearchResultKey::new(GameQuery::new(), identity);
        app.state::<AppState>()
            .search_cache
            .insert_result(cache_key.clone(), (vec![], vec![]));
        let (entered, release) = install_database_command_checkpoint(case.label(), &handle);

        let command_app = app.clone();
        let command_handle = handle.clone();
        let caller = tokio::spawn(async move {
            run_database_command_case(case, command_app, command_handle, inputs).await
        });
        entered
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap_or_else(|_| panic!("{} worker did not enter its core", case.label()));
        assert!(app
            .state::<AppState>()
            .operations
            .outstanding_labels()
            .unwrap()
            .iter()
            .any(|label| label == case.label()));
        caller.abort();
        release.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !app
                .state::<AppState>()
                .operations
                .outstanding_labels()
                .unwrap()
                .is_empty()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{} did not retire", case.label()));

        let state = app.state::<AppState>();
        if case.invalidates_cache() {
            assert!(
                state.search_cache.get_result(&cache_key).is_none(),
                "{} did not invalidate its exact cache identity",
                case.label()
            );
        } else {
            assert!(
                state.search_cache.get_result(&cache_key).is_some(),
                "{} unexpectedly invalidated its cache identity",
                case.label()
            );
        }
        match case {
            DatabaseCommandCase::ConvertPgn => {
                let mut db = state
                    .database_repository
                    .connection(&test_target(&database), None)
                    .unwrap();
                assert_eq!(games::table.count().get_result::<i64>(&mut *db).unwrap(), 1);
            }
            DatabaseCommandCase::CreateIndexes => {
                let mut db = state
                    .database_repository
                    .connection(&test_target(&database), None)
                    .unwrap();
                assert!(check_index_exists(&mut db).unwrap());
            }
            DatabaseCommandCase::DeleteIndexes => {
                let mut db = state
                    .database_repository
                    .connection(&test_target(&database), None)
                    .unwrap();
                assert!(!check_index_exists(&mut db).unwrap());
            }
            DatabaseCommandCase::EditDbInfo => {
                let mut db = state
                    .database_repository
                    .connection(&test_target(&database), None)
                    .unwrap();
                assert_eq!(
                    info::table
                        .find("Title")
                        .select(info::value)
                        .first::<Option<String>>(&mut *db)
                        .unwrap()
                        .as_deref(),
                    Some("Matrix")
                );
            }
            DatabaseCommandCase::DeleteDatabase => assert!(!database.exists()),
            DatabaseCommandCase::DeleteDuplicatedGames => {
                let mut db = state
                    .database_repository
                    .connection(&test_target(&database), None)
                    .unwrap();
                assert_eq!(games::table.count().get_result::<i64>(&mut *db).unwrap(), 1);
            }
            DatabaseCommandCase::DeleteEmptyGames => {
                let mut db = state
                    .database_repository
                    .connection(&test_target(&database), None)
                    .unwrap();
                assert_eq!(games::table.count().get_result::<i64>(&mut *db).unwrap(), 0);
            }
            DatabaseCommandCase::ExportToPgn => {
                assert!(std::fs::read_to_string(dir.path().join("export.pgn"))
                    .unwrap()
                    .contains("[White \"White\"]"));
            }
            DatabaseCommandCase::DeleteDbGame => {
                let mut db = state
                    .database_repository
                    .connection(&test_target(&database), None)
                    .unwrap();
                assert_eq!(games::table.count().get_result::<i64>(&mut *db).unwrap(), 0);
            }
            DatabaseCommandCase::WriteDbGame => {
                let mut db = state
                    .database_repository
                    .connection(&test_target(&database), None)
                    .unwrap();
                assert_eq!(
                    games::table
                        .select(games::ply_count)
                        .first::<Option<i32>>(&mut *db)
                        .unwrap(),
                    Some(2)
                );
            }
            DatabaseCommandCase::MergePlayers => {
                let mut db = state
                    .database_repository
                    .connection(&test_target(&database), None)
                    .unwrap();
                assert_eq!(
                    players::table
                        .find(1)
                        .count()
                        .get_result::<i64>(&mut *db)
                        .unwrap(),
                    0
                );
                assert_eq!(
                    games::table
                        .select(games::white_id)
                        .first::<i32>(&mut *db)
                        .unwrap(),
                    2
                );
            }
        }
    }

    async fn assert_database_command_retires_its_error_tail_after_caller_drop(
        case: DatabaseCommandCase,
    ) {
        let (dir, app, _handle, database) = blocking_database_case();
        let inputs = prepare_database_command_case(case, dir.path(), &app, &database);
        let index = get_index_path(&database);
        std::fs::write(&index, b"matrix error cache identity").unwrap();
        let identity = crate::SearchIndexIdentity::for_test_database(
            &database,
            crate::db::search_index::IndexSource::from_database(&database, 0).unwrap(),
        )
        .unwrap();
        let cache_key = crate::SearchResultKey::new(GameQuery::new(), identity);
        app.state::<AppState>()
            .search_cache
            .insert_result(cache_key.clone(), (vec![], vec![]));
        let missing_handle = DatabaseHandle::new(crate::infra::path_authority::PathRef {
            id: format!("missing-matrix-database-{}", case.label()),
        });
        let (entered, release) = install_database_command_checkpoint(case.label(), &missing_handle);

        let command_app = app.clone();
        let caller = tokio::spawn(async move {
            run_database_command_case(case, command_app, missing_handle, inputs).await
        });
        entered
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap_or_else(|_| panic!("{} error worker did not enter its core", case.label()));
        caller.abort();
        release.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !app
                .state::<AppState>()
                .operations
                .outstanding_labels()
                .unwrap()
                .is_empty()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{} error tail did not retire", case.label()));

        assert!(
            database.exists(),
            "{} error path mutated the database",
            case.label()
        );
        assert!(
            app.state::<AppState>()
                .search_cache
                .get_result(&cache_key)
                .is_some(),
            "{} error path published cache invalidation",
            case.label()
        );
    }

    fn insert_named_game(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        database: &Path,
        white: &str,
        black: &str,
        event: &str,
        site: &str,
    ) -> i32 {
        let state = app.state::<AppState>();
        let mut db = state
            .database_repository
            .connection(&test_target(database), None)
            .unwrap();
        let white = create_player(&mut db, white).unwrap();
        let black = create_player(&mut db, black).unwrap();
        let event = create_event(&mut db, event).unwrap();
        let site = create_site(&mut db, site).unwrap();
        insert_test_game(&mut db, white.id, black.id, event.id, site.id).id
    }

    const HEAP_CORPUS_TARGET_BYTES: usize = 32 * 1024 * 1024;
    const HEAP_ROW_COMMENT_BYTES: usize = 64 * 1024;

    fn populate_large_valid_comment_corpus(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        database: &Path,
        result: Option<&str>,
    ) -> (usize, usize, i32) {
        let state = app.state::<AppState>();
        let mut db = state
            .database_repository
            .connection(&test_target(database), None)
            .unwrap();
        let white = create_player(&mut db, "White").unwrap();
        let black = create_player(&mut db, "Black").unwrap();
        let event = create_event(&mut db, "Heap evidence").unwrap();
        let site = create_site(&mut db, "Disk").unwrap();
        let comment = "x".repeat(HEAP_ROW_COMMENT_BYTES);
        let mut moves = Vec::with_capacity(comment.len() + 6);
        encode_comment(&comment, &mut moves);
        let row_count = HEAP_CORPUS_TARGET_BYTES.div_ceil(moves.len());
        db.transaction::<_, diesel::result::Error, _>(|db| {
            for _ in 0..row_count {
                diesel::insert_into(games::table)
                    .values(NewGame {
                        event_id: event.id,
                        site_id: site.id,
                        white_id: white.id,
                        black_id: black.id,
                        white_elo: Some(2_100),
                        black_elo: Some(2_000),
                        white_material: 39,
                        black_material: 39,
                        date: Some("2026.09.05"),
                        time: None,
                        round: None,
                        result,
                        time_control: None,
                        eco: None,
                        ply_count: 0,
                        fen: None,
                        moves: &moves,
                        pawn_home: 0xffff,
                    })
                    .execute(db)?;
            }
            Ok(())
        })
        .unwrap();
        (row_count * moves.len(), row_count, white.id)
    }

    fn populate_many_eligible_player_statistics_games(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        database: &Path,
        row_count: usize,
    ) -> i32 {
        let state = app.state::<AppState>();
        let mut db = state
            .database_repository
            .connection(&test_target(database), None)
            .unwrap();
        let player = create_player(&mut db, "Statistics player").unwrap();
        let opponent = create_player(&mut db, "Statistics opponent").unwrap();
        let event = create_event(&mut db, "Statistics heap evidence").unwrap();
        let site = create_site(&mut db, "Statistics heap site").unwrap();
        let moves: Vec<u8> = Vec::new();

        db.transaction::<_, diesel::result::Error, _>(|db| {
            for _ in 0..row_count {
                diesel::insert_into(games::table)
                    .values(NewGame {
                        event_id: event.id,
                        site_id: site.id,
                        white_id: player.id,
                        black_id: opponent.id,
                        white_elo: Some(2_100),
                        black_elo: Some(2_000),
                        white_material: 39,
                        black_material: 39,
                        date: Some("2026.09.05"),
                        time: None,
                        round: None,
                        result: Some("1-0"),
                        time_control: Some("600+0"),
                        eco: None,
                        ply_count: 0,
                        fen: None,
                        moves: &moves,
                        pawn_home: 0xffff,
                    })
                    .execute(db)?;
            }
            Ok(())
        })
        .unwrap();
        player.id
    }

    fn grant_pgn_destination(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        path: &Path,
    ) -> FileWorkspaceHandle {
        let state = app.state::<AppState>();
        let mut guard = state.pgn_path_authority.raw_for_test().lock().unwrap();
        let authority = guard.as_mut().unwrap();
        let commit = authority.grant_persistent_file_for_test(
            path,
            "export.pgn",
            vec![PathOperation::WritePgn],
        );
        FileWorkspaceHandle::new(commit.id)
    }

    fn assert_no_atomic_export_residue(directory: &Path) {
        let residue: Vec<_> = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| name.to_string_lossy().starts_with(".atomic-"))
            .collect();
        assert!(residue.is_empty(), "atomic export residue: {residue:?}");
    }

    fn export_row(event_name: String) -> (Game, Player, Player, Event, Site) {
        (
            Game {
                id: 1,
                event_id: 1,
                site_id: 1,
                date: Some("2026.09.05".into()),
                time: None,
                round: Some("1".into()),
                white_id: 1,
                white_elo: Some(2_100),
                black_id: 2,
                black_elo: Some(2_000),
                white_material: 0,
                black_material: 0,
                result: Some("1-0".into()),
                time_control: None,
                eco: None,
                ply_count: Some(0),
                fen: None,
                moves: vec![],
                pawn_home: 0,
            },
            Player {
                id: 1,
                name: Some("White".into()),
                elo: None,
            },
            Player {
                id: 2,
                name: Some("Black".into()),
                elo: None,
            },
            Event {
                id: 1,
                name: Some(event_name),
            },
            Site {
                id: 1,
                name: Some("Berlin".into()),
            },
        )
    }

    struct FailingWriter<W> {
        inner: W,
        remaining: usize,
        fail_flush: bool,
    }

    impl<W: Write> Write for FailingWriter<W> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.remaining == 0 {
                return Err(std::io::Error::other("injected write failure"));
            }
            let count = bytes.len().min(self.remaining);
            let written = self.inner.write(&bytes[..count])?;
            self.remaining -= written;
            Ok(written)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            self.inner.flush()?;
            if self.fail_flush {
                Err(std::io::Error::other("injected flush failure"))
            } else {
                Ok(())
            }
        }
    }

    struct ObservingExportWriter {
        produced: Arc<AtomicUsize>,
        first_write_at: Arc<AtomicUsize>,
    }

    impl Write for ObservingExportWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let produced = self.produced.load(Ordering::Relaxed);
            let _ = self.first_write_at.compare_exchange(
                usize::MAX,
                produced,
                Ordering::Relaxed,
                Ordering::Relaxed,
            );
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn export_to_pgn_command_shutdown_cancel_reaches_the_worker() {
        let (dir, app, handle, database) = blocking_database_case();
        let inputs = prepare_database_command_case(
            DatabaseCommandCase::ExportToPgn,
            dir.path(),
            &app,
            &database,
        );
        let (entered, release) = install_database_command_checkpoint("export_to_pgn", &handle);
        let command_app = app.clone();
        let command = tokio::spawn(async move {
            run_database_command_case(
                DatabaseCommandCase::ExportToPgn,
                command_app,
                handle,
                inputs,
            )
            .await
        });
        entered
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("export worker did not enter its core");
        app.state::<AppState>()
            .operations
            .seal_and_request_cancellation()
            .unwrap();
        release.send(()).unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), command)
            .await
            .expect("cancelled export must finish")
            .unwrap();
        assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
        assert_eq!(
            std::fs::read(dir.path().join("export.pgn")).unwrap(),
            b"old"
        );
        assert_no_atomic_export_residue(dir.path());
    }

    #[test]
    fn export_mid_stream_cancellation_stops_before_pulling_another_row() {
        let (dir, app, handle, database) = blocking_database_case();
        insert_named_game(&app, &database, "First", "Black", "Event", "Site");
        insert_named_game(&app, &database, "Second", "Black", "Event", "Site");
        let destination_path = dir.path().join("export.pgn");
        std::fs::write(&destination_path, b"old").unwrap();
        let destination = grant_pgn_destination(&app, &destination_path);
        let cancellation = CancellationToken::new();
        let worker_cancellation = cancellation.clone();
        let block = Arc::new(ExportWriteBlock {
            entered: std::sync::Barrier::new(2),
            release: std::sync::Barrier::new(2),
        });
        let worker_block = Arc::clone(&block);
        let worker = std::thread::spawn(move || {
            let counter = Arc::new(AtomicUsize::new(0));
            EXPORT_ROW_COUNT.with(|current| *current.borrow_mut() = Some(Arc::clone(&counter)));
            EXPORT_WRITE_BLOCK.with(|current| *current.borrow_mut() = Some(worker_block));
            let state = app.state::<AppState>();
            let result = export_to_pgn_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                destination,
                &worker_cancellation,
            );
            EXPORT_ROW_COUNT.with(|current| current.borrow_mut().take());
            (result, counter.load(Ordering::Relaxed))
        });
        block.entered.wait();
        cancellation.cancel();
        block.release.wait();
        let (result, yielded) = worker.join().unwrap();
        assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
        assert_eq!(std::fs::read(&destination_path).unwrap(), b"old");
        assert_no_atomic_export_residue(dir.path());
        assert_eq!(yielded, 1, "cancelled export pulled another row");
    }

    #[test]
    fn export_file_sync_cancellation_preserves_destination_and_cleans_temporary() {
        let (dir, app, handle, database) = blocking_database_case();
        insert_named_game(&app, &database, "White", "Black", "Event", "Site");
        let destination_path = dir.path().join("export.pgn");
        std::fs::write(&destination_path, b"old").unwrap();
        let destination = grant_pgn_destination(&app, &destination_path);
        let cancellation = CancellationToken::new();
        let state = app.state::<AppState>();
        let injector = crate::infra::fs::install_test_atomic_file_injector(Arc::new(
            crate::infra::fs::CancelAtomicFileAt {
                cancel_at: crate::infra::fs::AtomicFileFaultPoint::FileSync,
                fail_at: None,
                cancellation: cancellation.clone(),
            },
        ));
        let result = export_to_pgn_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            destination,
            &cancellation,
        );
        drop(injector);
        assert!(cancellation.is_cancelled());
        assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
        assert_eq!(std::fs::read(&destination_path).unwrap(), b"old");
        assert_no_atomic_export_residue(dir.path());
    }

    #[test]
    fn export_cancellation_with_cleanup_failure_preserves_both_errors_and_destination() {
        use crate::infra::fs::{
            install_test_atomic_file_injector, AtomicFileFaultPoint, CancelAtomicFileAt,
        };

        let (dir, app, handle, database) = blocking_database_case();
        insert_named_game(&app, &database, "White", "Black", "Event", "Site");
        let destination_path = dir.path().join("export.pgn");
        std::fs::write(&destination_path, b"old").unwrap();
        let destination = grant_pgn_destination(&app, &destination_path);
        let cancellation = CancellationToken::new();
        let state = app.state::<AppState>();
        let injector = install_test_atomic_file_injector(Arc::new(CancelAtomicFileAt {
            cancel_at: AtomicFileFaultPoint::FileSync,
            fail_at: Some(AtomicFileFaultPoint::Cleanup),
            cancellation: cancellation.clone(),
        }));
        let result = export_to_pgn_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            destination,
            &cancellation,
        );
        drop(injector);
        assert!(cancellation.is_cancelled());
        assert_eq!(std::fs::read(&destination_path).unwrap(), b"old");
        // The cleanup injection reports failure, but the real unlink still removes the temporary.
        assert_no_atomic_export_residue(dir.path());
        let error = result.expect_err("export cancellation and cleanup failure must be returned");
        assert_eq!(
            error.category(),
            crate::error::ErrorCategory::OperationAndCleanup
        );
        let payload = serde_json::to_value(&error).expect("serialize actual export error");
        assert_eq!(payload["tag"], "backend-error");
        assert_eq!(payload["category"], "operation-and-cleanup");
        assert_eq!(
            payload["message"],
            "Operation failed; temporary cleanup also failed"
        );
        assert!(
            !payload.to_string().contains("injected Cleanup failure"),
            "native cleanup cause leaked into export payload: {payload}"
        );
        match error {
            Error::OperationAndCleanup { primary, cleanup } => {
                assert_eq!(primary, Error::Cancellation.to_string());
                assert_eq!(
                    cleanup, "I/O failure: injected Cleanup failure",
                    "cleanup must retain the injected native cause"
                );
            }
            other => panic!("expected cancellation and cleanup failure, got {other:?}"),
        }
    }

    #[test]
    fn export_cancellation_after_precommit_reports_complete_published_destination() {
        let (dir, app, handle, database) = blocking_database_case();
        insert_named_game(&app, &database, "First", "Black", "Event", "Site");
        insert_named_game(&app, &database, "Second", "Black", "Event", "Site");
        let destination_path = dir.path().join("export.pgn");
        std::fs::write(&destination_path, b"old").unwrap();
        let destination = grant_pgn_destination(&app, &destination_path);
        let cancellation = CancellationToken::new();
        let state = app.state::<AppState>();
        let injector = crate::infra::fs::install_test_atomic_file_injector(Arc::new(
            crate::infra::fs::CancelAtomicFileAt {
                cancel_at: crate::infra::fs::AtomicFileFaultPoint::TempMetadata,
                fail_at: None,
                cancellation: cancellation.clone(),
            },
        ));
        let result = export_to_pgn_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            destination,
            &cancellation,
        );
        drop(injector);
        assert!(cancellation.is_cancelled());
        result.unwrap();
        let exported = std::fs::read(&destination_path).unwrap();
        let mut importer = Importer::new(None);
        let games: Vec<_> = BufferedReader::new(exported.as_slice())
            .into_iter(&mut importer)
            .map(|game| {
                game.expect("exported PGN parses")
                    .expect("exported game retained")
            })
            .collect();
        assert_eq!(games.len(), 2);
        let mut whites: Vec<_> = games
            .iter()
            .map(|game| game.white_name.as_deref())
            .collect();
        whites.sort();
        assert_eq!(whites, vec![Some("First"), Some("Second")]);
        assert_no_atomic_export_residue(dir.path());
    }

    #[test]
    fn export_streams_complete_pgn_through_atomic_destination() {
        let (dir, app, handle, database) = blocking_database_case();
        insert_named_game(&app, &database, "White", "Black", "Event", "Berlin");
        let destination_path = dir.path().join("export.pgn");
        std::fs::write(&destination_path, b"old").unwrap();
        let destination = grant_pgn_destination(&app, &destination_path);
        let state = app.state::<AppState>();
        export_to_pgn_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            destination,
            &CancellationToken::new(),
        )
        .unwrap();
        let pgn = std::fs::read_to_string(destination_path).unwrap();
        assert!(pgn.contains("[Event \"Event\"]"));
        assert!(pgn.contains("[White \"White\"]"));
        assert!(pgn.ends_with("*\n\n"));
        assert_eq!(
            BufferedReader::new(pgn.as_bytes())
                .into_iter(&mut Importer::new(None))
                .count(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn export_atomic_precommit_failures_preserve_destination_and_cleanup_temporary_file() {
        use crate::infra::fs::AtomicFileFaultPoint;

        for point in [
            AtomicFileFaultPoint::TempfileCreate,
            AtomicFileFaultPoint::Write,
            AtomicFileFaultPoint::Flush,
            AtomicFileFaultPoint::FileSync,
            AtomicFileFaultPoint::PermissionCopy,
            AtomicFileFaultPoint::PreCommitRevalidate,
            AtomicFileFaultPoint::Rename,
        ] {
            let (dir, app, handle, database) = blocking_database_case();
            insert_named_game(&app, &database, "White", "Black", "Event", "Berlin");
            let destination_path = dir.path().join("export.pgn");
            std::fs::write(&destination_path, b"old").unwrap();
            let destination = grant_pgn_destination(&app, &destination_path);
            let state = app.state::<AppState>();

            let injector = install_atomic_export_failure(point);
            let result = export_to_pgn_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                destination,
                &CancellationToken::new(),
            );
            drop(injector);

            assert!(
                matches!(result, Err(Error::Io(_))),
                "fault point: {point:?}"
            );
            assert_eq!(std::fs::read(&destination_path).unwrap(), b"old");
            assert_no_atomic_export_residue(dir.path());
        }
    }

    #[cfg(unix)]
    #[test]
    fn export_atomic_postcommit_failures_return_uncertain_with_complete_parseable_destination() {
        use crate::infra::fs::AtomicFileFaultPoint;

        for point in [
            AtomicFileFaultPoint::PostRenameMetadata,
            AtomicFileFaultPoint::ParentSync,
        ] {
            let (dir, app, handle, database) = blocking_database_case();
            insert_named_game(&app, &database, "White", "Black", "Event", "Berlin");
            let destination_path = dir.path().join("export.pgn");
            std::fs::write(&destination_path, b"old").unwrap();
            let destination = grant_pgn_destination(&app, &destination_path);
            let state = app.state::<AppState>();

            let injector = install_atomic_export_failure(point);
            let result = export_to_pgn_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                destination,
                &CancellationToken::new(),
            );
            drop(injector);

            assert!(
                matches!(
                    result,
                    Err(Error::CommittedDurabilityUncertain(
                        crate::error::DurabilityStage::DatabasePgnReplacement
                    ))
                ),
                "fault point: {point:?}"
            );
            let exported = std::fs::read(&destination_path).unwrap();
            assert!(exported.ends_with(b"*\n\n"), "fault point: {point:?}");
            let mut importer = Importer::new(None);
            let mut parsed = BufferedReader::new(exported.as_slice()).into_iter(&mut importer);
            let game = parsed
                .next()
                .expect("exported one game")
                .expect("exported PGN parses")
                .expect("exported game is retained");
            assert!(parsed.next().is_none(), "exported more than one game");
            assert_eq!(game.event_name.as_deref(), Some("Event"));
            assert_eq!(game.site_name.as_deref(), Some("Berlin"));
            assert_eq!(game.white_name.as_deref(), Some("White"));
            assert_eq!(game.black_name.as_deref(), Some("Black"));
            assert_no_atomic_export_residue(dir.path());
        }
    }

    #[test]
    fn production_export_heap_peak_stays_bounded_by_one_game() {
        let (dir, app, handle, database) = blocking_database_case();
        let (corpus_bytes, _, _) = populate_large_valid_comment_corpus(&app, &database, None);
        let destination_path = dir.path().join("large-export.pgn");
        std::fs::write(&destination_path, b"old").unwrap();
        let destination = grant_pgn_destination(&app, &destination_path);
        let threshold = corpus_bytes / 4;
        let sanity_peak =
            allocation_probe::assert_detects_owned_collection(corpus_bytes, threshold);
        let state = app.state::<AppState>();
        let (result, export_peak) = allocation_probe::measure(|| {
            export_to_pgn_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                destination,
                &CancellationToken::new(),
            )
        });
        result.unwrap();
        assert!(
            export_peak < threshold,
            "export peak {export_peak} materialized too much of the {corpus_bytes}-byte corpus (threshold {threshold}, sanity peak {sanity_peak})"
        );
        eprintln!(
            "export heap evidence: corpus={corpus_bytes} peak={export_peak} threshold={threshold} sanity_peak={sanity_peak}"
        );
    }

    #[test]
    fn imported_escaped_tags_roundtrip_through_production_export() {
        let source = r#"[Event "Open \"A\" \\ Cup"]
[Site "Hall \"B\" \\ Wing"]
[Date "2026.09.05"]
[Round "R\"1\\A"]
[White "Ada \"Ace\" \\ Labs"]
[Black "Bob \\ \"B\""]
[Result "*"]
[TimeControl "40/7200\"bonus\\"]
[ECO "C\"20\\"]
[SetUp "1"]
[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1"]

*
"#;
        let mut source_importer = Importer::new(None);
        let imported = BufferedReader::new(source.as_bytes())
            .into_iter(&mut source_importer)
            .flatten()
            .flatten()
            .next()
            .expect("import source game");
        assert_eq!(imported.event_name.as_deref(), Some(r#"Open \"A\" \\ Cup"#));
        assert_eq!(imported.site_name.as_deref(), Some(r#"Hall \"B\" \\ Wing"#));
        assert_eq!(imported.round.as_deref(), Some("R\"1\\A"));
        assert_eq!(imported.white_name.as_deref(), Some("Ada \"Ace\" \\ Labs"));
        assert_eq!(imported.black_name.as_deref(), Some("Bob \\ \"B\""));
        assert_eq!(imported.time_control.as_deref(), Some("40/7200\"bonus\\"));
        assert_eq!(imported.eco.as_deref(), Some("C\"20\\"));

        let (dir, app, handle, database) = blocking_database_case();
        {
            let state = app.state::<AppState>();
            let mut db = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            imported.insert_to_db(&mut db).unwrap();
        }
        let destination_path = dir.path().join("escaped-export.pgn");
        std::fs::write(&destination_path, b"old").unwrap();
        let destination = grant_pgn_destination(&app, &destination_path);
        let state = app.state::<AppState>();
        export_to_pgn_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            destination,
            &CancellationToken::new(),
        )
        .unwrap();

        let exported = std::fs::read_to_string(destination_path).unwrap();
        assert!(exported.contains(r#"[Event "Open \"A\" \\ Cup"]"#));
        assert!(exported.contains(r#"[Site "Hall \"B\" \\ Wing"]"#));
        assert!(exported.contains(r#"[White "Ada \"Ace\" \\ Labs"]"#));
        assert!(exported.contains(r#"[Black "Bob \\ \"B\""]"#));

        let mut roundtrip_importer = Importer::new(None);
        let roundtrip = BufferedReader::new(exported.as_bytes())
            .into_iter(&mut roundtrip_importer)
            .flatten()
            .flatten()
            .next()
            .expect("reimport exported game");
        assert_eq!(roundtrip.event_name, imported.event_name);
        assert_eq!(roundtrip.site_name, imported.site_name);
        assert_eq!(roundtrip.round, imported.round);
        assert_eq!(roundtrip.white_name, imported.white_name);
        assert_eq!(roundtrip.black_name, imported.black_name);
        assert_eq!(roundtrip.time_control, imported.time_control);
        assert_eq!(roundtrip.eco, imported.eco);
        assert_eq!(roundtrip.fen, imported.fen);
    }

    #[test]
    fn imported_consecutive_escaped_backslashes_keep_every_backslash() {
        let source = r#"[White "Two \\\\ Slashes"]
[Black "Mix \\\\\" Q \\z"]
[Round "\\\\\\"]
[Result "*"]

*
"#;
        let mut importer = Importer::new(None);
        let imported = BufferedReader::new(source.as_bytes())
            .into_iter(&mut importer)
            .flatten()
            .flatten()
            .next()
            .expect("import source game");
        assert_eq!(imported.white_name.as_deref(), Some("Two \\\\ Slashes"));
        assert_eq!(imported.black_name.as_deref(), Some("Mix \\\\\" Q \\z"));
        assert_eq!(imported.round.as_deref(), Some("\\\\\\"));
    }

    #[test]
    fn export_rejects_malformed_fen_and_moves_without_replacing_destination() {
        for (column, value) in [("Fen", "'invalid fen'"), ("Moves", "X'ff'")] {
            let (dir, app, handle, database) = blocking_database_case();
            let game_id = insert_named_game(&app, &database, "White", "Black", "Event", "Site");
            {
                let state = app.state::<AppState>();
                let mut db = state
                    .database_repository
                    .connection(&test_target(&database), None)
                    .unwrap();
                sql_query(format!(
                    "UPDATE Games SET {column} = {value} WHERE Id = {game_id}"
                ))
                .execute(&mut *db)
                .unwrap();
            }
            let destination_path = dir.path().join("export.pgn");
            std::fs::write(&destination_path, b"old").unwrap();
            let destination = grant_pgn_destination(&app, &destination_path);
            let state = app.state::<AppState>();
            assert!(export_to_pgn_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                destination,
                &CancellationToken::new(),
            )
            .is_err());
            assert_eq!(std::fs::read(destination_path).unwrap(), b"old");
        }
    }

    #[test]
    fn export_row_decode_error_preserves_previous_destination() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("export.pgn");
        std::fs::write(&destination, b"old").unwrap();
        let result = crate::infra::fs::atomic_replace(&destination, |file| {
            write_pgn_rows(
                file,
                vec![Err(diesel::result::Error::NotFound)],
                &CancellationToken::new(),
            )
        });
        assert!(matches!(result, Err(Error::Diesel(_))));
        assert_eq!(std::fs::read(destination).unwrap(), b"old");
    }

    #[test]
    fn export_write_and_terminal_flush_failures_preserve_previous_file() {
        for (remaining, fail_flush, event_size) in
            [(32, false, 16 * 1024), (0, false, 1), (usize::MAX, true, 1)]
        {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("export.pgn");
            std::fs::write(&path, b"old").unwrap();
            let result = crate::infra::fs::atomic_replace(&path, |file| {
                write_pgn_rows(
                    FailingWriter {
                        inner: file,
                        remaining,
                        fail_flush,
                    },
                    vec![Ok(export_row("E".repeat(event_size)))],
                    &CancellationToken::new(),
                )
            });
            assert!(result.is_err());
            assert_eq!(std::fs::read(&path).unwrap(), b"old");
        }
    }

    #[test]
    fn export_consumes_large_row_sources_lazily() {
        let total = 20_000;
        let produced = Arc::new(AtomicUsize::new(0));
        let first_write_at = Arc::new(AtomicUsize::new(usize::MAX));
        let counter = Arc::clone(&produced);
        let rows = (0..total).map(move |_| {
            counter.fetch_add(1, Ordering::Relaxed);
            Ok(export_row("Event".into()))
        });
        write_pgn_rows(
            ObservingExportWriter {
                produced: Arc::clone(&produced),
                first_write_at: Arc::clone(&first_write_at),
            },
            rows,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(produced.load(Ordering::Relaxed), total);
        assert!(first_write_at.load(Ordering::Relaxed) < total);
    }

    #[test]
    fn export_releases_authority_mutex_before_streaming_rows() {
        let (dir, app, handle, database) = blocking_database_case();
        insert_named_game(&app, &database, "White", "Black", "Event", "Site");
        let destination_path = dir.path().join("export.pgn");
        std::fs::write(&destination_path, b"old").unwrap();
        let destination = grant_pgn_destination(&app, &destination_path);
        let block = Arc::new(ExportWriteBlock {
            entered: std::sync::Barrier::new(2),
            release: std::sync::Barrier::new(2),
        });
        let worker_block = Arc::clone(&block);
        let worker_app = app.clone();
        let worker = std::thread::spawn(move || {
            EXPORT_WRITE_BLOCK.with(|current| *current.borrow_mut() = Some(worker_block));
            let state = worker_app.state::<AppState>();
            export_to_pgn_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                destination,
                &CancellationToken::new(),
            )
        });
        block.entered.wait();
        assert!(app
            .state::<AppState>()
            .pgn_path_authority
            .raw_for_test()
            .try_lock()
            .is_ok());
        block.release.wait();
        worker.join().unwrap().unwrap();
    }

    const REPLACEMENT_PGN: &str = r#"[Event "Candidates"]
[Site "Madrid"]
[Date "2026.08.09"]
[UTCTime "12:00:00"]
[White "Carlsen"]
[Black "Nepomniachtchi"]
[Result "1-0"]
[WhiteElo "2860"]
[BlackElo "2790"]

1. e4 e5 1-0
"#;

    fn grant_import_file(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        path: &Path,
    ) -> FileWorkspaceHandle {
        grant_pgn_file(
            app,
            path,
            path.file_name().unwrap().to_str().unwrap(),
            vec![PathOperation::ReadPgn],
        )
    }

    fn run_import(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        database: DatabaseHandle,
        files: Vec<FileWorkspaceHandle>,
        account: Option<AccountImportContext>,
    ) -> Result<(), Error> {
        let state = app.state::<AppState>();
        convert_pgn_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            files,
            database,
            account,
            app.clone(),
            "Test".into(),
            None,
            "import-test".into(),
            &CancellationToken::new(),
        )
    }

    fn run_import_with_token(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        database: DatabaseHandle,
        files: Vec<FileWorkspaceHandle>,
        account: Option<AccountImportContext>,
        cancellation: &CancellationToken,
    ) -> Result<(), Error> {
        let state = app.state::<AppState>();
        convert_pgn_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            files,
            database,
            account,
            app.clone(),
            "Test".into(),
            None,
            "import-test".into(),
            cancellation,
        )
    }

    fn import_failure_unterminated_fixture(prefix: &str) -> String {
        format!(
            "{prefix}[Event \"Unreadable\"]\n\n1. e4 {{{}",
            "x".repeat(10 * 1024 * 1024 + 1)
        )
    }

    fn import_failure_assert_message(error: &Error, name: &str, game: usize) {
        let expected =
            format!("{name}: game {game} could not be read (unterminated comment or tag)");
        assert!(matches!(error, Error::InvalidInput(message) if message == &expected));
        let payload = serde_json::to_value(error).unwrap();
        assert_eq!(payload["message"], format!("Invalid input: {expected}"));
        assert_eq!(payload["category"], "invalid-input");
        assert_eq!(payload["tag"], "backend-error");
    }

    #[tokio::test]
    async fn import_failure_parser_payload_at_command_boundary() {
        let (dir, app, handle, database) = empty_database_case();
        mount_convert_progress_events(&app);
        // The registered display name, rather than the native path, reaches the wire.
        let source = dir.path().join("private-native-name.pgn");
        std::fs::write(&source, import_failure_unterminated_fixture("")).unwrap();
        let file = grant_pgn_file(
            &app,
            &source,
            "Selected games.pgn",
            vec![PathOperation::ReadPgn],
        );
        let state = app.state::<AppState>();
        let error = convert_pgn_command_core(
            "import-failure-command".into(),
            vec![file],
            handle,
            app.clone(),
            "Test".into(),
            None,
            None,
            "main",
            &state,
        )
        .await
        .unwrap_err();
        import_failure_assert_message(&error, "Selected games.pgn", 1);
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains("private-native-name"));
        assert!(!database_has_games_table(&database));
    }

    #[test]
    fn import_failure_physical_ordinal_counts_skipped_games() {
        let (dir, app, handle, database) = empty_database_case();
        mount_convert_progress_events(&app);
        let source = dir.path().join("skipped-games.pgn");
        let skipped = "[Event \"Illegal\"]\n\n1. e5 *\n\n";
        // Prove both preceding games actually take the Importer's None branch.
        let mut importer = Importer::new(None);
        let mut reader = BufferedReader::new_cursor(skipped.repeat(2));
        assert!(matches!(reader.read_game(&mut importer), Ok(Some(None))));
        assert!(matches!(reader.read_game(&mut importer), Ok(Some(None))));
        std::fs::write(
            &source,
            import_failure_unterminated_fixture(&skipped.repeat(2)),
        )
        .unwrap();
        let capture = crate::error::LogCaptureScope::start();
        let error =
            run_import(&app, handle, vec![grant_import_file(&app, &source)], None).unwrap_err();
        import_failure_assert_message(&error, "skipped-games.pgn", 3);
        let messages = capture.messages();
        let failures: Vec<_> = messages
            .iter()
            .filter(|line| line.contains("PGN import failed"))
            .collect();
        assert_eq!(failures.len(), 1, "{messages:?}");
        assert!(failures[0].contains("game=3"));
        assert!(failures[0].contains("parser cause: I/O failure:"));
        assert!(!database_has_games_table(&database));
    }

    #[test]
    fn import_failure_second_file_has_its_own_ordinal() {
        let (dir, app, handle, database) = empty_database_case();
        mount_convert_progress_events(&app);
        let first = dir.path().join("first.pgn");
        let second = dir.path().join("second.pgn");
        std::fs::write(&first, REPLACEMENT_PGN.repeat(2)).unwrap();
        std::fs::write(&second, import_failure_unterminated_fixture("")).unwrap();
        let error = run_import(
            &app,
            handle,
            vec![
                grant_import_file(&app, &first),
                grant_import_file(&app, &second),
            ],
            None,
        )
        .unwrap_err();
        import_failure_assert_message(&error, "second.pgn", 1);
        assert!(!database_has_games_table(&database));
    }

    #[test]
    fn import_failure_source_invalid_data_retains_io_and_logs_context_and_chain() {
        #[derive(Debug, thiserror::Error)]
        #[error("source read failed")]
        struct SourceFailure(#[source] std::io::Error);

        struct FailingRead {
            remaining: std::io::Cursor<Vec<u8>>,
        }
        impl std::io::Read for FailingRead {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let bytes = std::io::Read::read(&mut self.remaining, buffer)?;
                if bytes == 0 {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        SourceFailure(std::io::Error::other("underlying source cause")),
                    ))
                } else {
                    Ok(bytes)
                }
            }
        }

        // A comment spanning multiple parser refills fails inside the first game.
        let bytes = format!(
            "[Event \"Source failure\"]\n\n1. e4 {{{}",
            "x".repeat(32 * 1024)
        )
        .into_bytes();
        let offset = bytes.len();
        let source = FailingRead {
            remaining: std::io::Cursor::new(bytes),
        };
        let mut context = ImportFileContext {
            display_name: Some("source.pgn".into()),
            ..Default::default()
        };
        let capture = crate::error::LogCaptureScope::start();
        let error = context
            .run(|context| {
                read_import_games(source, context, None, &CancellationToken::new(), |_| {
                    panic!("an incomplete game must not be inserted")
                })
            })
            .unwrap_err();
        assert!(
            matches!(&error, Error::Io(cause) if cause.kind() == std::io::ErrorKind::InvalidData)
        );
        let payload = serde_json::to_value(&error).unwrap();
        assert_eq!(payload["category"], "io");
        assert_eq!(payload["message"], "I/O failure");
        let messages = capture.messages();
        assert_eq!(messages.len(), 1, "{messages:?}");
        assert!(messages[0].contains("file=\"source.pgn\" game=1"));
        assert!(messages[0].contains(&format!("decompressed_offset={offset}:")));
        assert!(messages[0].contains("source read failed"));
        assert!(messages[0].contains("underlying source cause"));
    }

    #[test]
    fn import_failure_corrupt_zstd_header_logs_game_zero() {
        let (dir, app, handle, database) = empty_database_case();
        mount_convert_progress_events(&app);
        let source = dir.path().join("corrupt.pgn.zst");
        std::fs::write(&source, b"not a zstd header").unwrap();
        let capture = crate::error::LogCaptureScope::start();
        let error =
            run_import(&app, handle, vec![grant_import_file(&app, &source)], None).unwrap_err();
        assert!(matches!(&error, Error::Io(_)), "{error:?}");
        let messages = capture.messages();
        let failures: Vec<_> = messages
            .iter()
            .filter(|line| line.contains("PGN import failed"))
            .collect();
        assert_eq!(failures.len(), 1, "{messages:?}");
        assert!(failures[0].contains("file=\"corrupt.pgn.zst\" game=0 decompressed_offset=0:"));
        assert!(failures[0].contains(&error.diagnostic()));
        assert_ne!(error.diagnostic(), "I/O failure");
        assert!(!database_has_games_table(&database));
    }

    #[test]
    fn import_failure_unavailable_source_logs_capability_and_game_zero() {
        let (dir, app, handle, database) = empty_database_case();
        mount_convert_progress_events(&app);
        let source = dir.path().join("removed.pgn");
        std::fs::write(&source, REPLACEMENT_PGN).unwrap();
        let file = grant_import_file(&app, &source);
        let capability_id = file.path_ref().id.clone();
        std::fs::remove_file(&source).unwrap();
        let capture = crate::error::LogCaptureScope::start();
        let error = run_import(&app, handle, vec![file], None).unwrap_err();
        assert!(
            matches!(&error, Error::InvalidInput(message) if message == "unknown or unavailable path capability")
        );
        let messages = capture.messages();
        let failures: Vec<_> = messages
            .iter()
            .filter(|line| line.contains("PGN import failed"))
            .collect();
        assert_eq!(failures.len(), 1, "{messages:?}");
        assert!(failures[0].contains(&format!("capability_id=Some(\"{capability_id}\")")));
        assert!(failures[0].contains("file=\"unknown PGN\" game=0 decompressed_offset=0:"));
        assert!(failures[0].contains(&error.diagnostic()));
        assert!(!database_has_games_table(&database));
    }

    #[test]
    fn import_failure_insert_error_logs_context_without_conversion() {
        let mut context = ImportFileContext {
            display_name: Some("insert.pgn".into()),
            ..Default::default()
        };
        let capture = crate::error::LogCaptureScope::start();
        let error = context
            .run(|context| {
                read_import_games(
                    REPLACEMENT_PGN.as_bytes(),
                    context,
                    None,
                    &CancellationToken::new(),
                    |_| Err(Error::Conflict("insert failure".into())),
                )
            })
            .unwrap_err();
        assert!(matches!(&error, Error::Conflict(message) if message == "insert failure"));
        let messages = capture.messages();
        assert_eq!(messages.len(), 1, "{messages:?}");
        assert!(messages[0].contains("file=\"insert.pgn\" game=1"));
        assert!(messages[0].contains(&format!(
            "decompressed_offset={}: {}",
            REPLACEMENT_PGN.len(),
            error.diagnostic()
        )));
    }

    #[test]
    fn long_token_import_preserves_middle_game_comments_through_export() {
        for size in [8 * 1024usize, 16 * 1024, 26_158, 1024 * 1024] {
            let comment = if size == 1024 * 1024 {
                "ä".repeat(size / 2)
            } else {
                let mut comment = "abcdefgh".repeat(size.div_ceil(8));
                comment.truncate(size);
                comment
            };
            assert_long_token_import_export(&[comment]);
        }
    }

    #[test]
    fn long_token_invalid_utf8_comment_imports_lists_and_exports() {
        let (dir, app, handle, database) = blocking_database_case();
        mount_convert_progress_events(&app);
        let (prefix, suffix) = REPLACEMENT_PGN.split_once("e4 e5").unwrap();
        let mut fixture = format!("{prefix}e4 {{").into_bytes();
        fixture.extend(std::iter::repeat_n(0xff, 4 * 1024 * 1024));
        fixture.extend_from_slice(format!("}} e5{suffix}").as_bytes());
        let source = dir.path().join("invalid-utf8-comment.pgn");
        std::fs::write(&source, fixture).unwrap();
        run_import(
            &app,
            handle.clone(),
            vec![grant_import_file(&app, &source)],
            None,
        )
        .unwrap();
        assert_eq!(database_row_counts(&app, &database).games, 1);

        let state = app.state::<AppState>();
        let response = get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            GameQuery::new(),
            &CancellationToken::new(),
        )
        .unwrap();
        let comment = "\u{fffd}".repeat(4 * 1024 * 1024);
        let expected_moves = format!("1. e4 {{{comment}}} e5 1-0");
        assert_eq!(response.data.len(), 1);
        assert_eq!(response.data[0].moves, expected_moves);

        let destination_path = dir.path().join("lossy-round-trip.pgn");
        std::fs::write(&destination_path, b"").unwrap();
        export_to_pgn_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            grant_pgn_destination(&app, &destination_path),
            &CancellationToken::new(),
        )
        .unwrap();
        let exported = std::fs::read_to_string(destination_path).unwrap();
        assert!(exported.contains(&expected_moves));
    }

    #[test]
    fn long_token_unterminated_tag_value_beyond_cap_fails_import() {
        assert_long_token_header_cap_failure(&format!(
            "[Event \"{}\n",
            "v".repeat(10 * 1024 * 1024 + 1)
        ));
    }

    #[test]
    fn long_token_tag_without_delimiter_beyond_cap_fails_import() {
        assert_long_token_header_cap_failure(&format!("[{}\n", "T".repeat(10 * 1024 * 1024 + 1)));
    }

    fn assert_long_token_header_cap_failure(header: &str) {
        let fixture = format!("{REPLACEMENT_PGN}\n{header}\n{REPLACEMENT_PGN}");
        let mut importer = Importer::new(None);
        let mut reader = BufferedReader::new(fixture.as_bytes());
        assert!(reader.read_game(&mut importer).unwrap().unwrap().is_some());
        let error = reader.read_game(&mut importer).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);

        let mut context = ImportFileContext {
            display_name: Some("over-cap-tag.pgn".into()),
            ..Default::default()
        };
        let mut inserted = 0;
        let error = read_import_games(
            fixture.as_bytes(),
            &mut context,
            None,
            &CancellationToken::new(),
            |_| {
                inserted += 1;
                Ok(())
            },
        )
        .unwrap_err();
        import_failure_assert_message(&error, "over-cap-tag.pgn", 2);
        assert_eq!(
            inserted, 1,
            "neither the malformed nor following game is inserted"
        );

        let (dir, app, handle, database) = empty_database_case();
        mount_convert_progress_events(&app);
        let source = dir.path().join("over-cap-tag.pgn");
        std::fs::write(&source, fixture).unwrap();
        let error =
            run_import(&app, handle, vec![grant_import_file(&app, &source)], None).unwrap_err();
        import_failure_assert_message(&error, "over-cap-tag.pgn", 2);
        assert!(!database_has_games_table(&database));
    }

    fn assert_long_token_import_export(expected: &[String]) {
        let (dir, app, handle, database) = blocking_database_case();
        mount_convert_progress_events(&app);
        let annotations = expected
            .iter()
            .map(|comment| format!("{{{comment}}}"))
            .collect::<Vec<_>>()
            .join(" ");
        let middle = REPLACEMENT_PGN.replace("e4 e5", &format!("e4 {annotations} e5"));
        let source = dir.path().join("long-comment.pgn");
        std::fs::write(
            &source,
            format!("{REPLACEMENT_PGN}\n{middle}\n{REPLACEMENT_PGN}"),
        )
        .unwrap();
        run_import(
            &app,
            handle.clone(),
            vec![grant_import_file(&app, &source)],
            None,
        )
        .unwrap();
        assert_eq!(
            database_row_counts(&app, &database).games,
            3,
            "the game following the annotated middle game must also import"
        );

        let destination_path = dir.path().join("round-trip.pgn");
        std::fs::write(&destination_path, b"").unwrap();
        let destination = grant_pgn_destination(&app, &destination_path);
        let state = app.state::<AppState>();
        export_to_pgn_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            destination,
            &CancellationToken::new(),
        )
        .unwrap();
        let exported = std::fs::read_to_string(destination_path).unwrap();
        let tokens = crate::lexer::lex_pgn_sync(
            exported
                .split("\n\n")
                .find(|part| part.contains('{'))
                .unwrap(),
        )
        .unwrap();
        let comments: Vec<_> = tokens
            .into_iter()
            .filter_map(|token| match token {
                crate::lexer::Token::Comment(text) => Some(text),
                _ => None,
            })
            .collect();
        assert_eq!(comments.as_slice(), expected);
        let mut importer = Importer::new(None);
        let games: Vec<_> = BufferedReader::new(exported.as_bytes())
            .into_iter(&mut importer)
            .map(|game| game.unwrap().unwrap())
            .collect();
        assert_eq!(games.len(), 3);
    }

    #[test]
    fn long_token_exact_chunk_multiples_round_trip() {
        for size in [65_535, 131_070] {
            assert_long_token_import_export(&["x".repeat(size)]);
        }
    }

    #[test]
    fn long_token_full_chunk_followed_by_second_comment_round_trips() {
        assert_long_token_import_export(&["x".repeat(65_535), "second".into()]);
    }

    #[test]
    fn long_token_empty_comment_after_short_comment_round_trips() {
        assert_long_token_import_export(&["short".into(), String::new()]);
    }

    #[test]
    fn long_token_save_replaces_game_with_full_comment() {
        let (_dir, app, handle, database) = blocking_database_case();
        let game_id = insert_named_game(&app, &database, "Old", "Black", "Event", "Site");
        let comment = "s".repeat(26_158);
        let pgn = REPLACEMENT_PGN.replace("e4 e5", &format!("e4 {{{comment}}} e5"));
        let state = app.state::<AppState>();
        write_db_game_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            game_id,
            pgn,
            test_game_stamp(&state, &handle, game_id),
            &CancellationToken::new(),
        )
        .unwrap();
        let response = get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            GameQuery::new(),
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(response.data.len(), 1);
        assert_eq!(response.data[0].id, game_id);
        assert_eq!(
            response.data[0].moves,
            format!("1. e4 {{{comment}}} e5 1-0")
        );
    }

    #[test]
    fn long_token_unterminated_comment_has_bounded_heap() {
        const CAP: usize = 10 * 1024 * 1024;
        // The buffer reserves the exact capped size, plus one delimiter byte.
        // Allow 64 KiB for fixed reader, visitor, and error allocations.
        const MARGIN: usize = 64 * 1024;
        let fixture = format!("1. e4 {{{}", "x".repeat(4 * CAP));
        let (result, peak) = allocation_probe::measure(|| {
            BufferedReader::new(fixture.as_bytes()).read_game(&mut Importer::new(None))
        });
        assert!(matches!(result, Err(error) if error.kind() == std::io::ErrorKind::InvalidData));
        eprintln!(
            "long token fixture_bytes={} rust_heap_peak={peak} limit={}",
            fixture.len(),
            CAP + MARGIN
        );
        assert!(
            peak < CAP + MARGIN,
            "Rust heap peak {peak} exceeded {}",
            CAP + MARGIN
        );
    }

    #[test]
    fn long_token_terminated_comment_beyond_cap_fails() {
        let fixture = format!("1. e4 {{{}}} e5 *", "x".repeat(10 * 1024 * 1024 + 1));
        let error = BufferedReader::new(fixture.as_bytes())
            .read_game(&mut Importer::new(None))
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn long_token_comment_at_cap_parses() {
        let comment = "x".repeat(10 * 1024 * 1024);
        let fixture = format!("1. e4 {{{comment}}} e5 *");
        let tokens = crate::lexer::lex_pgn_sync(&fixture).unwrap();
        assert_eq!(tokens[1], crate::lexer::Token::Comment(comment));
    }

    #[derive(Debug, PartialEq, Eq)]
    struct DatabaseRowCounts {
        games: i64,
        players: i64,
        events: i64,
        sites: i64,
    }

    fn database_row_counts(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        database: &Path,
    ) -> DatabaseRowCounts {
        let state = app.state::<AppState>();
        let mut db = state
            .database_repository
            .connection(&test_target(database), None)
            .unwrap();
        DatabaseRowCounts {
            games: games::table.count().get_result(&mut *db).unwrap(),
            players: players::table.count().get_result(&mut *db).unwrap(),
            events: events::table.count().get_result(&mut *db).unwrap(),
            sites: sites::table.count().get_result(&mut *db).unwrap(),
        }
    }

    fn empty_database_case() -> (
        tempfile::TempDir,
        tauri::AppHandle<tauri::test::MockRuntime>,
        DatabaseHandle,
        PathBuf,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("games.db3");
        File::create(&database).unwrap();
        let (app, handle) =
            database_app_with_grant(dir.path(), &database, "games", full_database_operations());
        (dir, app, handle, database)
    }

    #[test]
    fn import_two_files_is_atomic_and_updates_metadata() {
        let (dir, app, handle, database) = blocking_database_case();
        mount_convert_progress_events(&app);
        let first = dir.path().join("first.pgn");
        let second = dir.path().join("second.pgn");
        std::fs::write(&first, REPLACEMENT_PGN).unwrap();
        std::fs::write(&second, REPLACEMENT_PGN.replace("Carlsen", "Gukesh")).unwrap();
        run_import(
            &app,
            handle,
            vec![
                grant_import_file(&app, &first),
                grant_import_file(&app, &second),
            ],
            None,
        )
        .unwrap();

        let state = app.state::<AppState>();
        let mut db = state
            .database_repository
            .connection(&test_target(&database), None)
            .unwrap();
        assert_eq!(games::table.count().get_result::<i64>(&mut *db).unwrap(), 2);
        for (name, expected) in [
            ("GameCount", 2_i64),
            ("PlayerCount", 4),
            ("EventCount", 2),
            ("SiteCount", 2),
        ] {
            assert_eq!(
                info::table
                    .find(name)
                    .select(info::value)
                    .first::<Option<String>>(&mut *db)
                    .unwrap()
                    .unwrap()
                    .parse::<i64>()
                    .unwrap(),
                expected
            );
        }
    }

    #[test]
    fn unreadable_second_file_rolls_back_first_file_and_has_no_terminal_progress() {
        let (dir, app, handle, database) = blocking_database_case();
        let first = dir.path().join("first.pgn");
        let missing = dir.path().join("missing.pgn");
        std::fs::write(&first, REPLACEMENT_PGN).unwrap();
        std::fs::write(&missing, REPLACEMENT_PGN).unwrap();
        let files = vec![
            grant_import_file(&app, &first),
            grant_import_file(&app, &missing),
        ];
        std::fs::remove_file(&missing).unwrap();
        mount_convert_progress_events(&app);
        let frames = capture_events::<ConvertProgress>(&app);

        assert!(run_import(&app, handle, files, None).is_err());
        assert_eq!(
            database_row_counts(&app, &database),
            DatabaseRowCounts {
                games: 0,
                players: 1,
                events: 1,
                sites: 1,
            }
        );
        assert!(frames
            .lock()
            .unwrap()
            .iter()
            .all(|frame| frame.source_file_name.is_some()));
    }

    #[test]
    fn data_revision_failure_rolls_back_inserted_games_and_counts() {
        let (dir, app, handle, database) = blocking_database_case();
        mount_convert_progress_events(&app);
        let source = dir.path().join("revision.pgn");
        std::fs::write(&source, REPLACEMENT_PGN).unwrap();
        let _failure = repository::fail_next_revision_bump();

        assert!(run_import(&app, handle, vec![grant_import_file(&app, &source)], None).is_err());
        assert_eq!(
            database_row_counts(&app, &database),
            DatabaseRowCounts {
                games: 0,
                players: 1,
                events: 1,
                sites: 1,
            }
        );
    }

    #[test]
    fn metadata_failure_after_inserts_rolls_back_the_import() {
        let (dir, app, handle, database) = blocking_database_case();
        mount_convert_progress_events(&app);
        let source = dir.path().join("metadata.pgn");
        std::fs::write(&source, REPLACEMENT_PGN).unwrap();
        {
            let state = app.state::<AppState>();
            let mut db = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            update_database_counts(&mut db).unwrap();
            db.batch_execute(
                "CREATE TRIGGER fail_count_update BEFORE UPDATE ON Info
                 WHEN NEW.Name = 'GameCount'
                 BEGIN SELECT RAISE(ABORT, 'injected count failure'); END;",
            )
            .unwrap();
        }

        assert!(run_import(&app, handle, vec![grant_import_file(&app, &source)], None).is_err());
        assert_eq!(
            database_row_counts(&app, &database),
            DatabaseRowCounts {
                games: 0,
                players: 1,
                events: 1,
                sites: 1,
            }
        );
        let state = app.state::<AppState>();
        let mut db = state
            .database_repository
            .connection(&test_target(&database), None)
            .unwrap();
        assert_eq!(
            info::table
                .find("GameCount")
                .select(info::value)
                .first::<Option<String>>(&mut *db)
                .unwrap()
                .as_deref(),
            Some("0")
        );
    }

    #[test]
    fn failed_import_preserves_cached_index_query_and_success_refreshes_it() {
        let (dir, app, handle, database) = blocking_database_case();
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events!(
                ConvertProgress,
                crate::progress::ProgressEvent
            ))
            .mount_events(&app);
        let query = GameQuery::new().position(PositionQueryJs {
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".into(),
            type_: "exact".into(),
        });
        let state = app.state::<AppState>();
        generate_search_index(
            &handle,
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(get_index_path(&database).exists());
        let progress = crate::progress::JobProgress::new(app.clone(), "cache-seed".into()).unwrap();
        let seed = search::search_position_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            state.new_request.clone().try_acquire_owned().unwrap(),
            progress.lease(),
            app.clone(),
            handle.clone(),
            query.clone(),
            &CancellationToken::new(),
            None,
        )
        .unwrap();
        progress.complete(crate::progress::ProgressState::Succeeded);
        assert!(seed.0.is_empty() && seed.1.is_empty());
        assert!(!search::is_position_in_db(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
            &query,
        )
        .unwrap());
        let source_identity = MmapSearchIndex::open(get_index_path(&database))
            .unwrap()
            .source()
            .clone();
        let index_identity =
            crate::SearchIndexIdentity::for_test_database(&database, source_identity).unwrap();
        assert!(state.search_cache.get_index(&index_identity).is_some());
        let result_key = crate::SearchResultKey::new(query.clone(), index_identity.clone());
        assert!(state.search_cache.get_result(&result_key).is_some());
        #[derive(QueryableByName)]
        struct JournalMode {
            #[diesel(sql_type = Text)]
            journal_mode: String,
        }
        let mut db = state
            .database_repository
            .connection(&test_target(&database), None)
            .unwrap();
        assert_eq!(
            sql_query("PRAGMA journal_mode")
                .get_result::<JournalMode>(&mut *db)
                .unwrap()
                .journal_mode,
            "wal"
        );
        drop(db);

        let failed = dir.path().join("failed.pgn");
        std::fs::write(&failed, REPLACEMENT_PGN).unwrap();
        let _failure = repository::fail_next_revision_bump();
        assert!(run_import(
            &app,
            handle.clone(),
            vec![grant_import_file(&app, &failed)],
            None,
        )
        .is_err());
        assert_eq!(
            database_row_counts(&app, &database),
            DatabaseRowCounts {
                games: 0,
                players: 1,
                events: 1,
                sites: 1,
            }
        );
        assert!(!search::is_position_in_db(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
            &query,
        )
        .unwrap());

        assert!(state.search_cache.get_index(&index_identity).is_some());
        let preserved = state.search_cache.get_result(&result_key).unwrap();
        assert!(preserved.0.is_empty() && preserved.1.is_empty());

        run_import(
            &app,
            handle.clone(),
            vec![grant_import_file(&app, &failed)],
            None,
        )
        .unwrap();
        assert!(state.search_cache.get_index(&index_identity).is_none());
        assert!(state.search_cache.get_result(&result_key).is_none());
        assert!(search::is_position_in_db(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
            &query,
        )
        .unwrap());
    }

    #[test]
    fn truncated_compressed_streams_roll_back_complete_games() {
        test_support::run_isolated(
            "db::tests::truncated_compressed_streams_roll_back_complete_games",
            || {
                let (dir, app, handle, database) = blocking_database_case();
                mount_convert_progress_events(&app);
                let frames = capture_events::<ConvertProgress>(&app);
                let bz2 = dir.path().join("truncated.pgn.bz2");
                let zst = dir.path().join("truncated.pgn.zst");
                let compress_bz2 = |payload: &[u8]| {
                    let mut encoder =
                        bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::best());
                    encoder.write_all(payload).unwrap();
                    encoder.finish().unwrap()
                };
                let complete_prefix = REPLACEMENT_PGN.repeat(200);
                let mut bz_bytes = compress_bz2(complete_prefix.as_bytes());
                let mut truncated_bz_member = compress_bz2(REPLACEMENT_PGN.as_bytes());
                truncated_bz_member.truncate(truncated_bz_member.len() - 8);
                bz_bytes.extend(truncated_bz_member);
                std::fs::write(&bz2, bz_bytes).unwrap();
                let mut zst_bytes =
                    zstd::stream::encode_all(complete_prefix.as_bytes(), 1).unwrap();
                let mut truncated_zst_frame =
                    zstd::stream::encode_all(REPLACEMENT_PGN.as_bytes(), 1).unwrap();
                truncated_zst_frame.truncate(truncated_zst_frame.len() - 4);
                zst_bytes.extend(truncated_zst_frame);
                std::fs::write(&zst, zst_bytes).unwrap();

                for source in [&bz2, &zst] {
                    let frames_before = frames.lock().unwrap().len();
                    assert!(run_import(
                        &app,
                        handle.clone(),
                        vec![grant_import_file(&app, source)],
                        None,
                    )
                    .is_err());
                    assert_eq!(
                        database_row_counts(&app, &database),
                        DatabaseRowCounts {
                            games: 0,
                            players: 1,
                            events: 1,
                            sites: 1,
                        }
                    );
                    let captured = frames.lock().unwrap();
                    assert!(
                        captured[frames_before..].iter().any(|frame| {
                            frame.source_file_name.as_deref()
                                == source.file_name().unwrap().to_str()
                        }),
                        "{} must yield a complete game before reporting its truncated tail",
                        source.display()
                    );
                    assert!(captured[frames_before..]
                        .iter()
                        .all(|frame| frame.source_file_name.is_some()));
                }
            },
        );
    }

    #[test]
    fn existing_database_without_optional_indexes_stays_unindexed() {
        let (dir, app, handle, database) = blocking_database_case();
        mount_convert_progress_events(&app);
        let source = dir.path().join("plain.pgn");
        std::fs::write(&source, REPLACEMENT_PGN).unwrap();
        run_import(&app, handle, vec![grant_import_file(&app, &source)], None).unwrap();
        let state = app.state::<AppState>();
        let mut db = state
            .database_repository
            .connection(&test_target(&database), None)
            .unwrap();
        let indexes: Vec<IndexInfo> = sql_query(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'games_%_idx'",
        )
        .load(&mut *db)
        .unwrap();
        assert!(indexes.is_empty());
    }

    #[test]
    fn failed_new_database_import_can_retry_with_schema_validation_and_required_indexes() {
        let (dir, app, handle, database) = empty_database_case();
        mount_convert_progress_events(&app);
        let source = dir.path().join("new.pgn");
        std::fs::write(&source, REPLACEMENT_PGN).unwrap();
        let _failure = repository::fail_next_revision_bump();
        assert!(run_import(
            &app,
            handle.clone(),
            vec![grant_import_file(&app, &source)],
            None,
        )
        .is_err());

        let mut raw = SqliteConnection::establish(database.to_str().unwrap()).unwrap();
        let tables: Vec<IndexInfo> = sql_query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .load(&mut raw)
        .unwrap();
        assert!(tables.is_empty());
        drop(raw);

        run_import(&app, handle, vec![grant_import_file(&app, &source)], None).unwrap();
        let state = app.state::<AppState>();
        let mut db = state
            .database_repository
            .connection(&test_target(&database), None)
            .unwrap();
        assert_eq!(games::table.count().get_result::<i64>(&mut *db).unwrap(), 1);
        let indexes: Vec<IndexInfo> = sql_query(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'games_%_idx'",
        )
        .load(&mut *db)
        .unwrap();
        assert_eq!(indexes.len(), REQUIRED_GAME_INDEXES.len());
    }

    #[test]
    fn empty_import_is_a_no_op() {
        let (_dir, app, handle, database) = blocking_database_case();
        let state = app.state::<AppState>();
        let revision = {
            let mut connection = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            repository::read_data_revision(&mut connection).unwrap()
        };
        run_import(&app, handle, Vec::new(), None).unwrap();
        let after_revision = {
            let mut connection = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            repository::read_data_revision(&mut connection).unwrap()
        };
        assert_eq!(after_revision, revision);
        assert_eq!(
            database_row_counts(&app, &database),
            DatabaseRowCounts {
                games: 0,
                players: 1,
                events: 1,
                sites: 1,
            }
        );
    }

    #[test]
    fn multi_megabyte_import_keeps_rust_heap_below_half_the_corpus() {
        let (dir, app, handle, database) = blocking_database_case();
        mount_convert_progress_events(&app);
        let source = dir.path().join("large.pgn");
        let mut writer = BufWriter::new(File::create(&source).unwrap());
        let target = 4 * 1024 * 1024;
        let mut written = 0;
        while written < target {
            writer.write_all(REPLACEMENT_PGN.as_bytes()).unwrap();
            written += REPLACEMENT_PGN.len();
        }
        writer.flush().unwrap();
        let corpus_bytes = source.metadata().unwrap().len() as usize;
        let source_handle = grant_import_file(&app, &source);
        let (result, heap_peak) =
            allocation_probe::measure(|| run_import(&app, handle, vec![source_handle], None));
        result.unwrap();
        eprintln!("streamed import corpus_bytes={corpus_bytes} rust_heap_peak={heap_peak}");
        assert!(
            heap_peak < corpus_bytes / 2,
            "streaming heap peak {heap_peak} must stay below half of {corpus_bytes} bytes"
        );
        assert!(database_row_counts(&app, &database).games > 10_000);
    }

    #[test]
    fn imports_old_starts_while_preserving_invalid_game_skip_policy() {
        let (dir, app, handle, database) = blocking_database_case();
        mount_convert_progress_events(&app);
        let source = dir.path().join("skips.pgn");
        let invalid = REPLACEMENT_PGN.replace(
            "[White \"Carlsen\"]",
            "[White \"Skipped\"]\n[FEN \"invalid\"]",
        );
        let older = REPLACEMENT_PGN.replace("Carlsen", "Older");
        let valid = REPLACEMENT_PGN.replace("2026.08.09", "2026.08.10");
        std::fs::write(&source, format!("{older}\n{invalid}\n{valid}")).unwrap();
        run_import(&app, handle, vec![grant_import_file(&app, &source)], None).unwrap();
        assert_eq!(database_row_counts(&app, &database).games, 2);
    }

    #[test]
    fn replacement_does_not_advance_past_a_skipped_first_game() {
        let (_dir, app, handle, database) = blocking_database_case();
        let game_id = insert_named_game(&app, &database, "Old", "Black", "Event", "Site");
        let skipped = REPLACEMENT_PGN.replace(
            "[White \"Carlsen\"]",
            "[White \"Skipped\"]\n[FEN \"invalid\"]",
        );
        let state = app.state::<AppState>();
        assert!(matches!(
            write_db_game_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                handle.clone(),
                game_id,
                format!("{skipped}\n{REPLACEMENT_PGN}"),
                test_game_stamp(&state, &handle, game_id),
                &CancellationToken::new(),
            ),
            Err(Error::NoMovesFound)
        ));
        let mut db = state
            .database_repository
            .connection(&test_target(&database), None)
            .unwrap();
        let white_id = games::table
            .find(game_id)
            .select(games::white_id)
            .first::<i32>(&mut *db)
            .unwrap();
        assert_eq!(
            players::table
                .find(white_id)
                .select(players::name)
                .first::<Option<String>>(&mut *db)
                .unwrap()
                .unwrap(),
            "Old"
        );
    }

    #[test]
    fn write_db_game_then_read_it_back_returns_the_same_moves() {
        let (_dir, app, handle, database) = blocking_database_case();
        let game_id = insert_named_game(
            &app,
            &database,
            "Old White",
            "Old Black",
            "Old Event",
            "Old Site",
        );
        let state = app.state::<AppState>();

        let empty = write_db_game_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            game_id,
            String::new(),
            test_game_stamp(&state, &handle, game_id),
            &CancellationToken::new(),
        );
        assert!(
            matches!(empty, Err(Error::NoMovesFound)),
            "a PGN with no games must not overwrite the stored game"
        );

        write_db_game_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            game_id,
            REPLACEMENT_PGN.to_string(),
            test_game_stamp(&state, &handle, game_id),
            &CancellationToken::new(),
        )
        .unwrap();

        let games = get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            GameQuery {
                outcome: Some("1-0".into()),
                sides: Some(Sides::WhiteBlack),
                ..GameQuery::new()
            },
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(games.count, Some(1));
        assert_eq!(games.data.len(), 1);
        assert_eq!(games.data[0].white, "Carlsen");
        assert_eq!(games.data[0].black, "Nepomniachtchi");
        assert_eq!(games.data[0].event, "Candidates");
        assert_eq!(games.data[0].site, "Madrid");
        assert_eq!(games.data[0].moves, "1. e4 e5 1-0");

        let white_id = games.data[0].white_id;
        let event_id = games.data[0].event_id;

        let dated = get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            GameQuery {
                start_date: Some("2026.01.01".into()),
                end_date: Some("2026.12.31".into()),
                tournament_id: Some(event_id),
                options: Some(QueryOptions {
                    skip_count: false,
                    page: Some(1),
                    page_size: Some(10),
                    sort: GameSort::Date,
                    direction: SortDirection::Asc,
                }),
                ..GameQuery::new()
            },
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(dated.count, Some(1));
        assert_eq!(dated.data[0].id, game_id);

        let any_side = get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            GameQuery {
                player1: Some(white_id),
                sides: Some(Sides::Any),
                range1: Some((2800, 2900)),
                options: Some(QueryOptions {
                    skip_count: true,
                    page: Some(1),
                    page_size: Some(1),
                    sort: GameSort::WhiteElo,
                    direction: SortDirection::Desc,
                }),
                ..GameQuery::new()
            },
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(any_side.count, None);
        assert_eq!(any_side.data.len(), 1);

        let as_black = get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            GameQuery {
                player1: Some(white_id),
                sides: Some(Sides::BlackWhite),
                range1: Some((2700, 2800)),
                range2: Some((2800, 2900)),
                ..GameQuery::new()
            },
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(as_black.count, Some(0));
        assert!(as_black.data.is_empty());

        let white = get_player_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            games.data[0].white_id,
        )
        .unwrap()
        .expect("written white player must exist");
        assert_eq!(white.name.as_deref(), Some("Carlsen"));
        assert!(
            get_player_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle.clone(),
                999,
            )
            .unwrap()
            .is_none(),
            "a missing player id must return None rather than an error"
        );

        let players = get_players_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            PlayerQuery {
                options: QueryOptions {
                    skip_count: false,
                    page: None,
                    page_size: None,
                    sort: PlayerSort::Name,
                    direction: SortDirection::Asc,
                },
                name: Some("Carlsen".into()),
                name_match: None,
                range: None,
            },
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(players.count, Some(1));
        assert_eq!(players.data[0].name.as_deref(), Some("Carlsen"));

        let rated = get_players_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            PlayerQuery {
                options: QueryOptions {
                    skip_count: true,
                    page: Some(1),
                    page_size: Some(10),
                    sort: PlayerSort::Elo,
                    direction: SortDirection::Desc,
                },
                name: None,
                name_match: None,
                range: Some((2800, 2900)),
            },
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(rated.count, None);
        assert!(
            rated.data.is_empty(),
            "Players.Elo is not written from game ratings, so a rating band matches nobody"
        );

        let tournaments = get_tournaments_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            TournamentQuery {
                options: QueryOptions {
                    skip_count: false,
                    page: None,
                    page_size: None,
                    sort: TournamentSort::Name,
                    direction: SortDirection::Asc,
                },
                name: Some("Candidates".into()),
            },
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(tournaments.count, Some(1));
        assert_eq!(tournaments.data[0].name.as_deref(), Some("Candidates"));

        let paged_events = get_tournaments_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            TournamentQuery {
                options: QueryOptions {
                    skip_count: true,
                    page: Some(1),
                    page_size: Some(5),
                    sort: TournamentSort::Id,
                    direction: SortDirection::Desc,
                },
                name: None,
            },
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(paged_events.count, None);
        assert!(paged_events
            .data
            .iter()
            .any(|event| event.name.as_deref() == Some("Candidates")));
    }

    #[test]
    fn sides_any_elo_ranges_follow_player_orientation() {
        let (_dir, app, handle, database) = blocking_database_case();
        let high_vs_mid = insert_named_game(&app, &database, "High", "Mid", "Event", "Site");
        let high_vs_low = insert_named_game(&app, &database, "High", "Low", "Event", "Site");
        let low_vs_high = insert_named_game(&app, &database, "Low", "High", "Event", "Site");
        let state = app.state::<AppState>();
        let mut db = state
            .database_repository
            .connection(&test_target(&database), None)
            .unwrap();
        diesel::update(games::table.find(high_vs_mid))
            .set((games::white_elo.eq(2750), games::black_elo.eq(1500)))
            .execute(&mut *db)
            .unwrap();
        diesel::update(games::table.find(high_vs_low))
            .set((games::white_elo.eq(2750), games::black_elo.eq(800)))
            .execute(&mut *db)
            .unwrap();
        diesel::update(games::table.find(low_vs_high))
            .set((games::white_elo.eq(800), games::black_elo.eq(2750)))
            .execute(&mut *db)
            .unwrap();
        let mid_id = games::table
            .find(high_vs_mid)
            .select(games::black_id)
            .first::<i32>(&mut *db)
            .unwrap();
        let high_id = games::table
            .find(high_vs_mid)
            .select(games::white_id)
            .first::<i32>(&mut *db)
            .unwrap();
        let low_id = games::table
            .find(high_vs_low)
            .select(games::black_id)
            .first::<i32>(&mut *db)
            .unwrap();
        drop(db);

        let oriented = get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            GameQuery {
                sides: Some(Sides::Any),
                range1: Some((2700, 3000)),
                range2: Some((0, 1000)),
                ..GameQuery::new()
            },
            &CancellationToken::new(),
        )
        .unwrap();
        let mut oriented_ids = oriented.data.iter().map(|game| game.id).collect::<Vec<_>>();
        oriented_ids.sort_unstable();
        assert_eq!(oriented.count, Some(2));
        assert_eq!(oriented_ids, vec![high_vs_low, low_vs_high]);

        let player_at_1500 = get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            GameQuery {
                player1: Some(mid_id),
                sides: Some(Sides::Any),
                range1: Some((2700, 3000)),
                ..GameQuery::new()
            },
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(player_at_1500.count, Some(0));
        assert!(player_at_1500.data.is_empty());

        let player1_and_both_ranges = get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            GameQuery {
                player1: Some(high_id),
                sides: Some(Sides::Any),
                range1: Some((2700, 3000)),
                range2: Some((0, 1000)),
                ..GameQuery::new()
            },
            &CancellationToken::new(),
        )
        .unwrap();
        let mut player1_and_both_range_ids = player1_and_both_ranges
            .data
            .iter()
            .map(|game| game.id)
            .collect::<Vec<_>>();
        player1_and_both_range_ids.sort_unstable();
        assert_eq!(player1_and_both_ranges.count, Some(2));
        assert_eq!(player1_and_both_range_ids, vec![high_vs_low, low_vs_high]);

        let player1_at_800_vs_2750 = get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            GameQuery {
                player1: Some(low_id),
                sides: Some(Sides::Any),
                range1: Some((2700, 3000)),
                range2: Some((0, 1000)),
                ..GameQuery::new()
            },
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(player1_at_800_vs_2750.count, Some(0));
        assert!(player1_at_800_vs_2750.data.is_empty());
    }

    #[test]
    fn get_db_info_reflects_edits_and_whether_indexes_exist() {
        let (_dir, app, handle, _database) = blocking_database_case();
        let state = app.state::<AppState>();

        let before = get_db_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
        )
        .unwrap();
        assert_eq!(before.title, "Untitled");
        assert_eq!(before.description, "");
        assert_eq!(before.filename, "games.db3");
        assert!(!before.indexed);
        assert_ne!(before.storage_size.to_string(), "0");

        edit_db_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            Some("My Library".into()),
            Some("Annotated games".into()),
            &CancellationToken::new(),
        )
        .unwrap();

        create_indexes_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            &CancellationToken::new(),
        )
        .unwrap();

        let indexed = get_db_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
        )
        .unwrap();
        assert_eq!(indexed.title, "My Library");
        assert_eq!(indexed.description, "Annotated games");
        assert!(indexed.indexed);

        edit_db_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            Some("Renamed".into()),
            None,
            &CancellationToken::new(),
        )
        .unwrap();
        edit_db_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            None,
            Some("New description".into()),
            &CancellationToken::new(),
        )
        .unwrap();

        delete_indexes_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            &CancellationToken::new(),
        )
        .unwrap();

        let after = get_db_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
        )
        .unwrap();
        assert_eq!(after.title, "Renamed");
        assert_eq!(after.description, "New description");
        assert!(!after.indexed);
    }

    #[test]
    fn blocking_maintenance_removes_empty_duplicates_and_merged_players() {
        let (_dir, app, handle, database) = blocking_database_case();
        let empty_id = insert_named_game(
            &app,
            &database,
            "Empty White",
            "Empty Black",
            "Empty Event",
            "Empty Site",
        );
        let first_duplicate = insert_named_game(
            &app,
            &database,
            "Dup White",
            "Dup Black",
            "Dup Event",
            "Dup Site",
        );
        let _second_duplicate = insert_named_game(
            &app,
            &database,
            "Dup White",
            "Dup Black",
            "Dup Event",
            "Dup Site",
        );
        let source_game = insert_named_game(
            &app,
            &database,
            "Source",
            "Opponent",
            "Merge Event",
            "Merge Site",
        );
        let target_game = insert_named_game(
            &app,
            &database,
            "Target",
            "Opponent",
            "Merge Event",
            "Merge Site",
        );

        {
            let state = app.state::<AppState>();
            let mut db = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            diesel::update(games::table.find(empty_id))
                .set(games::ply_count.eq(0))
                .execute(&mut *db)
                .unwrap();
        }

        let state = app.state::<AppState>();
        delete_empty_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            &CancellationToken::new(),
        )
        .unwrap();

        let after_empty = get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            GameQuery::new(),
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(after_empty.count, Some(4));
        assert!(
            after_empty.data.iter().all(|game| game.id != empty_id),
            "zero-ply games must be gone after delete_empty_games"
        );

        delete_duplicated_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            &CancellationToken::new(),
        )
        .unwrap();

        let after_duplicates = get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            GameQuery::new(),
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(after_duplicates.count, Some(3));
        let duplicate_ids: Vec<i32> = after_duplicates
            .data
            .iter()
            .filter(|game| game.white == "Dup White")
            .map(|game| game.id)
            .collect();
        assert_eq!(duplicate_ids, vec![first_duplicate]);

        let source = get_players_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            PlayerQuery {
                options: QueryOptions {
                    skip_count: false,
                    page: None,
                    page_size: None,
                    sort: PlayerSort::Name,
                    direction: SortDirection::Asc,
                },
                name: Some("Source".into()),
                name_match: None,
                range: None,
            },
            &CancellationToken::new(),
        )
        .unwrap();
        let target = get_players_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            PlayerQuery {
                options: QueryOptions {
                    skip_count: false,
                    page: None,
                    page_size: None,
                    sort: PlayerSort::Name,
                    direction: SortDirection::Asc,
                },
                name: Some("Target".into()),
                name_match: None,
                range: None,
            },
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(source.data.len(), 1);
        assert_eq!(target.data.len(), 1);
        let source_id = source.data[0].id;
        let target_id = target.data[0].id;

        merge_players_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            source_id,
            target_id,
            &CancellationToken::new(),
        )
        .unwrap();

        let source_after = get_player_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            source_id,
        )
        .unwrap();
        assert!(source_after.is_none(), "merged source player must be gone");
        let rewritten = get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            GameQuery {
                player1: Some(target_id),
                sides: Some(Sides::WhiteBlack),
                ..GameQuery::new()
            },
            &CancellationToken::new(),
        )
        .unwrap();
        let rewritten_ids: Vec<i32> = rewritten.data.iter().map(|game| game.id).collect();
        assert!(
            rewritten_ids.contains(&source_game) && rewritten_ids.contains(&target_game),
            "both of the source player's games must now belong to the target"
        );

        delete_db_game_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            first_duplicate,
            &CancellationToken::new(),
        )
        .unwrap();
        let remaining = get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            GameQuery::new(),
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(remaining.count, Some(2));
        assert!(remaining.data.iter().all(|game| game.id != first_duplicate));
    }

    fn mount_progress_events(app: &tauri::AppHandle<tauri::test::MockRuntime>) {
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events!(
                crate::progress::ProgressEvent
            ))
            .mount_events(app);
    }

    #[derive(Clone)]
    struct PlayerStatisticsGame<'a> {
        player_id: i32,
        opponent_id: i32,
        event_id: i32,
        site_id: i32,
        is_player_white: bool,
        player_elo: Option<i32>,
        opponent_elo: Option<i32>,
        moves: Vec<u8>,
        date: Option<&'a str>,
        result: Option<&'a str>,
        time_control: Option<&'a str>,
        fen: Option<&'a str>,
    }

    fn insert_player_statistics_game(db: &mut SqliteConnection, fixture: PlayerStatisticsGame<'_>) {
        let (white_id, black_id, white_elo, black_elo) = if fixture.is_player_white {
            (
                fixture.player_id,
                fixture.opponent_id,
                fixture.player_elo,
                fixture.opponent_elo,
            )
        } else {
            (
                fixture.opponent_id,
                fixture.player_id,
                fixture.opponent_elo,
                fixture.player_elo,
            )
        };
        create_game(
            db,
            NewGame {
                event_id: fixture.event_id,
                site_id: fixture.site_id,
                white_id,
                black_id,
                white_elo,
                black_elo,
                white_material: 0,
                black_material: 0,
                date: fixture.date,
                time: None,
                round: None,
                result: fixture.result,
                time_control: fixture.time_control,
                eco: None,
                ply_count: 2,
                fen: fixture.fen,
                moves: &fixture.moves,
                pawn_home: 0,
            },
        )
        .unwrap();
    }

    fn insert_kept_player_game(
        db: &mut SqliteConnection,
        white_id: i32,
        black_id: i32,
        event_id: i32,
        site_id: i32,
    ) {
        insert_player_statistics_game(
            db,
            PlayerStatisticsGame {
                player_id: white_id,
                opponent_id: black_id,
                event_id,
                site_id,
                is_player_white: true,
                player_elo: Some(2800),
                opponent_elo: Some(2700),
                moves: Vec::new(),
                date: Some("2026.08.09"),
                result: Some("1-0"),
                time_control: Some("600+0"),
                fen: None,
            },
        );
    }

    fn load_player_statistics(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        handle: DatabaseHandle,
        player_id: i32,
    ) -> PlayerGameInfo {
        let state = app.state::<AppState>();
        get_players_game_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            player_id,
            (app.clone(), None),
            &CancellationToken::new(),
            None,
        )
        .unwrap()
    }

    #[test]
    fn player_statistics_preserve_ratings_results_and_site_metadata() {
        let (_dir, app, handle, database) = blocking_database_case();
        let player_id = {
            let state = app.state::<AppState>();
            let mut db = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            let player = create_player(&mut db, "Player").unwrap();
            let opponent = create_player(&mut db, "Opponent").unwrap();
            let event = create_event(&mut db, "Event").unwrap();
            let site = create_site(&mut db, "https://lichess.org/abcdef").unwrap();
            let base = PlayerStatisticsGame {
                player_id: player.id,
                opponent_id: opponent.id,
                event_id: event.id,
                site_id: site.id,
                is_player_white: true,
                player_elo: Some(2800),
                opponent_elo: None,
                moves: Vec::new(),
                date: Some("2026.08.01"),
                result: Some("1-0"),
                time_control: None,
                fen: None,
            };
            insert_player_statistics_game(&mut db, base.clone());
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    date: Some("2026.08.02"),
                    result: Some("0-1"),
                    time_control: Some("300+3"),
                    ..base.clone()
                },
            );
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    is_player_white: false,
                    player_elo: Some(2750),
                    date: Some("2026.08.03"),
                    result: Some("1-0"),
                    ..base.clone()
                },
            );
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    is_player_white: false,
                    player_elo: Some(2750),
                    date: Some("2026.08.04"),
                    result: Some("0-1"),
                    ..base.clone()
                },
            );
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    date: Some("2026.08.05"),
                    result: Some("1/2-1/2"),
                    ..base.clone()
                },
            );
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    is_player_white: false,
                    player_elo: Some(2750),
                    date: Some("2026.08.06"),
                    result: Some("1/2-1/2"),
                    ..base.clone()
                },
            );
            player.id
        };

        let info = load_player_statistics(&app, handle, player_id);
        assert_eq!(info.site_stats_data.len(), 1);
        let group = &info.site_stats_data[0];
        assert_eq!(group.site, "Lichess");
        assert_eq!(group.player, "Player");
        let mut rows: Vec<_> = group.daily.iter().collect();
        rows.sort_by_key(|row| &row.date);
        assert_eq!(rows.len(), 6);

        assert_eq!(rows[0].date, "2026.08.01");
        assert_eq!(rows[0].time_control, "");
        assert_eq!((rows[0].won, rows[0].drawn, rows[0].lost), (1, 0, 0));
        assert_eq!(rows[0].max_player_elo, 2800);

        assert_eq!(rows[1].date, "2026.08.02");
        assert_eq!(rows[1].time_control, "300+3");
        assert_eq!((rows[1].won, rows[1].drawn, rows[1].lost), (0, 0, 1));

        assert_eq!(rows[2].date, "2026.08.03");
        assert_eq!((rows[2].won, rows[2].drawn, rows[2].lost), (0, 0, 1));

        assert_eq!(rows[3].date, "2026.08.04");
        assert_eq!((rows[3].won, rows[3].drawn, rows[3].lost), (1, 0, 0));

        assert_eq!(rows[4].date, "2026.08.05");
        assert_eq!((rows[4].won, rows[4].drawn, rows[4].lost), (0, 1, 0));

        assert_eq!(rows[5].date, "2026.08.06");
        assert_eq!((rows[5].won, rows[5].drawn, rows[5].lost), (0, 1, 0));

        assert_eq!(group.openings.len(), 3);
        let white_default = group
            .openings
            .iter()
            .find(|row| row.is_player_white && row.time_control.is_empty())
            .unwrap();
        assert_eq!(white_default.opening, "");
        assert_eq!(
            (white_default.won, white_default.drawn, white_default.lost),
            (1, 1, 0)
        );
        let black_default = group
            .openings
            .iter()
            .find(|row| !row.is_player_white && row.time_control.is_empty())
            .unwrap();
        assert_eq!(
            (black_default.won, black_default.drawn, black_default.lost),
            (1, 1, 1)
        );
        let white_rapid = group
            .openings
            .iter()
            .find(|row| row.is_player_white && row.time_control == "300+3")
            .unwrap();
        assert_eq!(
            (white_rapid.won, white_rapid.drawn, white_rapid.lost),
            (0, 0, 1)
        );
    }

    #[test]
    fn player_statistics_exclude_each_missing_or_invalid_required_value() {
        let (_dir, app, handle, database) = blocking_database_case();
        let (player_id, nameless_player_id) = {
            let state = app.state::<AppState>();
            let mut db = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            let player = create_player(&mut db, "Player").unwrap();
            let opponent = create_player(&mut db, "Opponent").unwrap();
            let nameless_player = create_player(&mut db, "Nameless").unwrap();
            let event = create_event(&mut db, "Event").unwrap();
            let site = create_site(&mut db, "Site").unwrap();
            let nameless_site = create_site(&mut db, "Nameless site").unwrap();
            diesel::update(sites::table.find(nameless_site.id))
                .set(sites::name.eq(None::<String>))
                .execute(&mut *db)
                .unwrap();
            diesel::update(players::table.find(nameless_player.id))
                .set(players::name.eq(None::<String>))
                .execute(&mut *db)
                .unwrap();

            let base = PlayerStatisticsGame {
                player_id: player.id,
                opponent_id: opponent.id,
                event_id: event.id,
                site_id: site.id,
                is_player_white: true,
                player_elo: Some(2800),
                opponent_elo: Some(2700),
                moves: Vec::new(),
                date: Some("2026.08.09"),
                result: Some("1-0"),
                time_control: Some("600+0"),
                fen: None,
            };
            insert_player_statistics_game(&mut db, base.clone());
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    date: None,
                    ..base.clone()
                },
            );
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    result: None,
                    ..base.clone()
                },
            );
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    result: Some("*"),
                    ..base.clone()
                },
            );
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    player_elo: None,
                    ..base.clone()
                },
            );
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    is_player_white: false,
                    player_elo: None,
                    ..base.clone()
                },
            );
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    site_id: nameless_site.id,
                    ..base.clone()
                },
            );
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    player_id: player.id,
                    opponent_id: player.id,
                    opponent_elo: None,
                    ..base.clone()
                },
            );
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    fen: Some("8/8/8/8/8/8/8/8 w - - 0 1"),
                    ..base.clone()
                },
            );
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    player_id: nameless_player.id,
                    ..base.clone()
                },
            );
            (player.id, nameless_player.id)
        };

        let info = load_player_statistics(&app, handle.clone(), player_id);
        assert_eq!(info.site_stats_data.len(), 1);
        assert_eq!(info.site_stats_data[0].daily.len(), 1);
        assert_eq!(info.site_stats_data[0].daily[0].date, "2026.08.09");
        assert_eq!(info.site_stats_data[0].openings.len(), 1);

        let nameless_info = load_player_statistics(&app, handle, nameless_player_id);
        assert!(nameless_info.site_stats_data.is_empty());
    }

    #[test]
    fn player_statistics_exclude_structurally_invalid_move_streams() {
        let (_dir, app, handle, database) = blocking_database_case();
        let player_id = {
            let state = app.state::<AppState>();
            let mut db = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            let player = create_player(&mut db, "Player").unwrap();
            let opponent = create_player(&mut db, "Opponent").unwrap();
            let event = create_event(&mut db, "Event").unwrap();
            let site = create_site(&mut db, "Site").unwrap();
            let base = PlayerStatisticsGame {
                player_id: player.id,
                opponent_id: opponent.id,
                event_id: event.id,
                site_id: site.id,
                is_player_white: true,
                player_elo: Some(2800),
                opponent_elo: Some(2700),
                moves: Vec::new(),
                date: Some("2026.08.10"),
                result: Some("1-0"),
                time_control: Some("600+0"),
                fen: None,
            };

            insert_player_statistics_game(&mut db, base.clone());
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    moves: vec![
                        encoding::COMMENT_MARKER,
                        1,
                        0,
                        120,
                        encoding::NAG_MARKER,
                        1,
                        0,
                        33,
                        VARIATION_START_MARKER,
                        0,
                        VARIATION_END_MARKER,
                    ],
                    date: Some("2026.08.11"),
                    ..base.clone()
                },
            );
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    moves: vec![encoding::COMMENT_MARKER, 4, 0, 120],
                    date: Some("2026.08.12"),
                    ..base.clone()
                },
            );
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    moves: vec![encoding::NAG_MARKER, 1],
                    date: Some("2026.08.13"),
                    ..base.clone()
                },
            );
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    moves: vec![VARIATION_END_MARKER],
                    date: Some("2026.08.14"),
                    ..base.clone()
                },
            );
            insert_player_statistics_game(
                &mut db,
                PlayerStatisticsGame {
                    moves: vec![VARIATION_START_MARKER, 0],
                    date: Some("2026.08.15"),
                    ..base
                },
            );
            player.id
        };

        let info = load_player_statistics(&app, handle, player_id);
        assert_eq!(info.site_stats_data.len(), 1);
        let mut dates: Vec<_> = info.site_stats_data[0]
            .daily
            .iter()
            .map(|row| row.date.as_str())
            .collect();
        dates.sort_unstable();
        assert_eq!(dates, ["2026.08.10", "2026.08.11"]);
    }

    fn player_statistics_batch_row(moves: Vec<u8>) -> PlayerStatisticsRow {
        PlayerStatisticsRow {
            white_id: 1,
            black_id: 2,
            outcome: None,
            date: None,
            moves,
            white_elo: Some(2_000),
            black_elo: Some(1_900),
            time_control: None,
            site: None,
            player: None,
        }
    }

    #[test]
    fn player_statistics_batches_close_at_the_row_byte_budget() {
        let mut rows = vec![
            Ok(player_statistics_batch_row(vec![0; 6])),
            Ok(player_statistics_batch_row(vec![0; 5])),
        ]
        .into_iter();
        let mut pending = None;

        let first = next_player_statistics_batch(&mut rows, &mut pending, 10, 10)
            .unwrap()
            .unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].moves.len(), 6);
        let second = next_player_statistics_batch(&mut rows, &mut pending, 10, 10)
            .unwrap()
            .unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].moves.len(), 5);
        assert!(
            next_player_statistics_batch(&mut rows, &mut pending, 10, 10)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn player_statistics_batches_count_text_metadata_in_the_row_byte_budget() {
        const ROW_BYTE_BUDGET: usize = 100;

        let text_row = || {
            let mut row = player_statistics_batch_row(vec![0]);
            row.outcome = Some("r".repeat(10));
            row.date = Some("d".repeat(10));
            row.time_control = Some("t".repeat(10));
            row.site = Some("s".repeat(10));
            row.player = Some("p".repeat(10));
            row
        };
        let first_row = text_row();
        let second_row = text_row();
        assert!(first_row.owned_heap_bytes() < ROW_BYTE_BUDGET);
        assert!(first_row.owned_heap_bytes() + second_row.owned_heap_bytes() > ROW_BYTE_BUDGET);

        let mut rows = vec![Ok(first_row), Ok(second_row)].into_iter();
        let mut pending = None;

        let first = next_player_statistics_batch(&mut rows, &mut pending, ROW_BYTE_BUDGET, 10)
            .unwrap()
            .unwrap();
        assert_eq!(first.len(), 1);
        let second = next_player_statistics_batch(&mut rows, &mut pending, ROW_BYTE_BUDGET, 10)
            .unwrap()
            .unwrap();
        assert_eq!(second.len(), 1);
        assert!(
            next_player_statistics_batch(&mut rows, &mut pending, ROW_BYTE_BUDGET, 10)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn player_statistics_batches_close_at_the_row_ceiling() {
        let mut rows = vec![
            Ok(player_statistics_batch_row(vec![0])),
            Ok(player_statistics_batch_row(vec![0])),
            Ok(player_statistics_batch_row(vec![0])),
        ]
        .into_iter();
        let mut pending = None;

        let first = next_player_statistics_batch(&mut rows, &mut pending, 10, 2)
            .unwrap()
            .unwrap();
        assert_eq!(first.len(), 2);
        let second = next_player_statistics_batch(&mut rows, &mut pending, 10, 2)
            .unwrap()
            .unwrap();
        assert_eq!(second.len(), 1);
    }

    #[test]
    fn player_statistics_batches_keep_oversized_rows_alone() {
        let mut rows = vec![
            Ok(player_statistics_batch_row(vec![0; 2])),
            Ok(player_statistics_batch_row(vec![0; 9])),
            Ok(player_statistics_batch_row(vec![0; 1])),
        ]
        .into_iter();
        let mut pending = None;

        let first = next_player_statistics_batch(&mut rows, &mut pending, 8, 10)
            .unwrap()
            .unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].moves.len(), 2);
        let oversized = next_player_statistics_batch(&mut rows, &mut pending, 8, 10)
            .unwrap()
            .unwrap();
        assert_eq!(oversized.len(), 1);
        assert_eq!(oversized[0].moves.len(), 9);
        let last = next_player_statistics_batch(&mut rows, &mut pending, 8, 10)
            .unwrap()
            .unwrap();
        assert_eq!(last.len(), 1);
        assert_eq!(last[0].moves.len(), 1);
    }

    #[test]
    fn player_statistics_batch_row_errors_propagate() {
        let mut rows = vec![
            Ok(player_statistics_batch_row(vec![0])),
            Err(diesel::result::Error::NotFound),
        ]
        .into_iter();
        let mut pending = None;

        let result = next_player_statistics_batch(&mut rows, &mut pending, 10, 10);
        assert!(matches!(result, Err(Error::Diesel(_))));
    }

    #[test]
    fn player_statistics_batch_processing_fuses_non_fused_row_streams() {
        struct NonFusedRows {
            next_step: u8,
        }

        impl Iterator for NonFusedRows {
            type Item = diesel::QueryResult<PlayerStatisticsRow>;

            fn next(&mut self) -> Option<Self::Item> {
                let step = self.next_step;
                self.next_step = self.next_step.saturating_add(1);
                match step {
                    0 | 2 => Some(Ok(player_statistics_batch_row(vec![0]))),
                    1 | 3 => None,
                    _ => panic!("row stream was polled after its second None"),
                }
            }
        }

        let rows = NonFusedRows { next_step: 0 };
        let cancellation = CancellationToken::new();
        let mut processed_rows = 0;

        let result = process_player_statistics_batches(rows, 10, 10, &cancellation, |batch| {
            processed_rows += batch.len();
            Ok(())
        });

        assert!(result.is_ok());
        assert_eq!(processed_rows, 1);
    }

    #[test]
    fn player_statistics_cancellation_between_batches_returns_no_result() {
        let cancellation = CancellationToken::new();
        let mut pulled_rows = 0;
        let rows = std::iter::from_fn(|| {
            pulled_rows += 1;
            (pulled_rows <= 2).then(|| Ok(player_statistics_batch_row(vec![0])))
        });
        let mut processed_batches = 0;

        let result = process_player_statistics_batches(rows, 10, 1, &cancellation, |batch| {
            assert_eq!(batch.len(), 1);
            processed_batches += 1;
            cancellation.cancel();
            Ok(())
        });

        assert!(matches!(result, Err(Error::Cancellation)));
        assert_eq!(processed_batches, 1);
        assert_eq!(pulled_rows, 1, "the next batch was read after cancellation");
    }

    #[test]
    fn player_statistics_progress_fraction_clamps_and_handles_zero_total() {
        assert_eq!(player_statistics_progress_fraction(3, 0), 0.0);
        assert_eq!(player_statistics_progress_fraction(4, 4), 1.0);
        assert_eq!(player_statistics_progress_fraction(5, 4), 1.0);
    }

    #[test]
    fn player_statistics_aggregate_results_across_multiple_batches() {
        const FULL_BATCH_ROW_COUNT: usize = PLAYER_STATISTICS_BATCH_ROW_LIMIT;
        const TOTAL_ELIGIBLE_ROW_COUNT: usize = FULL_BATCH_ROW_COUNT + 1;

        let (_dir, app, handle, database) = blocking_database_case();
        let player_id = {
            let state = app.state::<AppState>();
            let mut db = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            let player = create_player(&mut db, "Player").unwrap();
            let opponent = create_player(&mut db, "Opponent").unwrap();
            let event = create_event(&mut db, "Event").unwrap();
            let site = create_site(&mut db, "Site").unwrap();
            let mut moves = Vec::new();
            encode_comment(&"x".repeat(5 * 1024), &mut moves);
            assert!(
                moves.len() * TOTAL_ELIGIBLE_ROW_COUNT > PLAYER_STATISTICS_BATCH_ROW_BYTE_BUDGET
            );

            db.transaction::<_, diesel::result::Error, _>(|db| {
                for index in 0..FULL_BATCH_ROW_COUNT {
                    let is_player_white = index % 2 == 0;
                    insert_player_statistics_game(
                        db,
                        PlayerStatisticsGame {
                            player_id: player.id,
                            opponent_id: opponent.id,
                            event_id: event.id,
                            site_id: site.id,
                            is_player_white,
                            player_elo: Some(2_000 + index as i32),
                            opponent_elo: Some(1_900),
                            moves: moves.clone(),
                            date: Some("2026.09.01"),
                            result: Some("1-0"),
                            time_control: Some("600+0"),
                            fen: None,
                        },
                    );
                }
                insert_player_statistics_game(
                    db,
                    PlayerStatisticsGame {
                        player_id: player.id,
                        opponent_id: opponent.id,
                        event_id: event.id,
                        site_id: site.id,
                        is_player_white: true,
                        player_elo: Some(2_000 + FULL_BATCH_ROW_COUNT as i32),
                        opponent_elo: Some(1_900),
                        moves: moves.clone(),
                        date: Some("2026.09.01"),
                        result: Some("1/2-1/2"),
                        time_control: None,
                        fen: None,
                    },
                );
                insert_player_statistics_game(
                    db,
                    PlayerStatisticsGame {
                        player_id: player.id,
                        opponent_id: player.id,
                        event_id: event.id,
                        site_id: site.id,
                        is_player_white: true,
                        player_elo: Some(2_300),
                        opponent_elo: None,
                        moves: moves.clone(),
                        date: Some("2026.09.01"),
                        result: Some("1-0"),
                        time_control: Some("600+0"),
                        fen: None,
                    },
                );
                Ok(())
            })
            .unwrap();
            player.id
        };

        let info = load_player_statistics(&app, handle, player_id);
        assert_eq!(info.site_stats_data.len(), 1);
        let group = &info.site_stats_data[0];
        assert_eq!(group.daily.len(), 2);

        let standard_daily = group
            .daily
            .iter()
            .find(|row| row.time_control == "600+0")
            .unwrap();
        assert_eq!(standard_daily.date, "2026.09.01");
        assert_eq!(
            (
                standard_daily.won,
                standard_daily.drawn,
                standard_daily.lost
            ),
            (128, 0, 128)
        );
        assert_eq!(standard_daily.max_player_elo, 2_255);

        let missing_time_control = group
            .daily
            .iter()
            .find(|row| row.time_control.is_empty())
            .unwrap();
        assert_eq!(
            (
                missing_time_control.won,
                missing_time_control.drawn,
                missing_time_control.lost
            ),
            (0, 1, 0)
        );
        assert_eq!(
            missing_time_control.max_player_elo,
            2_000 + FULL_BATCH_ROW_COUNT as i32
        );

        assert_eq!(group.openings.len(), 3);
        assert!(group.openings.iter().any(|row| {
            row.time_control == "600+0"
                && row.is_player_white
                && (row.won, row.drawn, row.lost) == (128, 0, 0)
        }));
        assert!(group.openings.iter().any(|row| {
            row.time_control == "600+0"
                && !row.is_player_white
                && (row.won, row.drawn, row.lost) == (0, 0, 128)
        }));
        assert!(group.openings.iter().any(|row| {
            row.time_control.is_empty()
                && row.is_player_white
                && (row.won, row.drawn, row.lost) == (0, 1, 0)
        }));
    }

    #[test]
    fn player_statistics_cancellation_propagates_during_full_stream_validation() {
        let (_dir, app, handle, database) = blocking_database_case();
        let (game_id, player_id) = {
            let state = app.state::<AppState>();
            let mut db = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            let player = create_player(&mut db, "Player").unwrap();
            let opponent = create_player(&mut db, "Opponent").unwrap();
            let event = create_event(&mut db, "Event").unwrap();
            let site = create_site(&mut db, "Site").unwrap();
            let game = insert_test_game(&mut db, player.id, opponent.id, event.id, site.id);
            let mut moves = Vec::new();
            encode_comment(&"validation payload".repeat(3_000), &mut moves);
            diesel::update(games::table.find(game.id))
                .set((
                    games::moves.eq(moves),
                    games::date.eq(Some("2026.09.09")),
                    games::result.eq(Some("1-0")),
                    games::white_elo.eq(Some(2_000)),
                ))
                .execute(&mut *db)
                .unwrap();
            (game.id, player.id)
        };
        assert!(game_id > 0);
        let cancellation = CancellationToken::new();
        encoding::cancel_decode_after_checkpoints(cancellation.clone(), 2);
        let state = app.state::<AppState>();
        let result = get_players_game_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            player_id,
            (app.clone(), None),
            &cancellation,
            None,
        );
        assert!(matches!(result, Err(Error::Cancellation)));
    }

    fn capture_events<E>(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
    ) -> std::sync::Arc<std::sync::Mutex<Vec<E>>>
    where
        E: tauri_specta::Event + serde::de::DeserializeOwned + Send + 'static,
    {
        let frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = frames.clone();
        E::listen(app, move |event| {
            captured.lock().expect("event frames").push(event.payload);
        });
        frames
    }

    fn kept_player_games_fixture(
        row_count: usize,
    ) -> (
        tempfile::TempDir,
        tauri::AppHandle<tauri::test::MockRuntime>,
        DatabaseHandle,
        i32,
    ) {
        let (_dir, app, handle, database) = blocking_database_case();
        mount_progress_events(&app);
        let player_id = {
            let state = app.state::<AppState>();
            let mut db = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            let white = create_player(&mut db, "White").unwrap();
            let black = create_player(&mut db, "Black").unwrap();
            let event = create_event(&mut db, "Event").unwrap();
            let site = create_site(&mut db, "Site").unwrap();
            db.transaction::<_, diesel::result::Error, _>(|db| {
                for _ in 0..row_count {
                    insert_kept_player_game(db, white.id, black.id, event.id, site.id);
                }
                Ok(())
            })
            .unwrap();
            white.id
        };
        (_dir, app, handle, player_id)
    }

    #[test]
    fn get_players_game_info_production_progress_failures_log_once_and_preserve_statistics() {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .unwrap();
        pool.install(|| {
            for store_failure in [false, true] {
                let (_dir, app, handle, player_id) = kept_player_games_fixture(2);
                let expected = load_player_statistics(&app, handle.clone(), player_id);
                assert_eq!(expected.site_stats_data[0].daily[0].won, 2);
                let state = app.state::<AppState>();
                let lease = state
                    .progress_state
                    .start("player-info-best-effort".into())
                    .unwrap();
                let checkpoints = std::sync::atomic::AtomicUsize::new(0);
                let update = |lease: &ProgressLease, percent: f32| {
                    checkpoints.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Some(if store_failure {
                        Err(Error::Conflict("injected statistics store failure".into()))
                    } else {
                        state
                            .progress_state
                            .transition(lease, percent, ProgressState::Running)
                            .unwrap();
                        Err(Error::Tauri(Box::new(tauri::Error::Io(
                            std::io::Error::other("injected statistics emitter failure"),
                        ))))
                    })
                };
                let cancellation = CancellationToken::new();
                let capture = crate::error::LogCaptureScope::start();
                let actual = get_players_game_info_blocking(
                    &state.pgn_path_authority,
                    &state.database_repository,
                    handle,
                    player_id,
                    (app.clone(), Some(lease.clone())),
                    &cancellation,
                    Some(&update),
                )
                .unwrap();
                assert_eq!(
                    serde_json::to_value(actual).unwrap(),
                    serde_json::to_value(expected).unwrap()
                );
                assert!(!cancellation.is_cancelled());
                assert_eq!(checkpoints.load(std::sync::atomic::Ordering::SeqCst), 2);
                let diagnostics: Vec<_> = capture
                    .records()
                    .into_iter()
                    .filter(|record| record.level == log::Level::Error)
                    .collect();
                assert_eq!(
                    diagnostics.len(),
                    1,
                    "statistics update failures must emit exactly one native ERROR record per operation"
                );
                assert!(diagnostics[0]
                    .message
                    .contains("get_players_game_info progress update failed"));
                assert!(diagnostics[0].message.contains(&lease.id));
                assert!(diagnostics[0]
                    .message
                    .contains(&format!("generation {}", lease.generation)));
                assert!(diagnostics[0].message.contains(if store_failure {
                    "injected statistics store failure"
                } else {
                    "injected statistics emitter failure"
                }));
                assert_eq!(
                    state.progress_state.get(&lease.id).unwrap().unwrap().progress,
                    if store_failure { 0.0 } else { 100.0 }
                );
            }
        });
    }

    #[test]
    fn get_players_game_info_production_stale_progress_preserves_statistics_and_newer_generation() {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .unwrap();
        pool.install(|| {
            for clear in [false, true] {
                let (_dir, app, handle, player_id) = kept_player_games_fixture(2);
                let expected = load_player_statistics(&app, handle.clone(), player_id);
                let state = app.state::<AppState>();
                let lease = state
                    .progress_state
                    .start("player-info-stale".into())
                    .unwrap();
                let replacement = if clear {
                    state.progress_state.clear(&lease.id).unwrap();
                    None
                } else {
                    let replacement = state.progress_state.start(lease.id.clone()).unwrap();
                    state
                        .progress_state
                        .transition(&replacement, 17.0, ProgressState::Running)
                        .unwrap();
                    state.progress_state.get(&lease.id).unwrap()
                };
                let cancellation = CancellationToken::new();
                let capture = crate::error::LogCaptureScope::start();
                let actual = get_players_game_info_blocking(
                    &state.pgn_path_authority,
                    &state.database_repository,
                    handle,
                    player_id,
                    (app.clone(), Some(lease.clone())),
                    &cancellation,
                    None,
                )
                .unwrap();
                assert_eq!(
                    serde_json::to_value(actual).unwrap(),
                    serde_json::to_value(expected).unwrap()
                );
                assert!(!cancellation.is_cancelled());
                assert_eq!(state.progress_state.get(&lease.id).unwrap(), replacement);
                if let Some(replacement) = replacement {
                    assert!(replacement.generation > lease.generation);
                }
                assert!(capture
                    .records()
                    .iter()
                    .all(|record| record.level != log::Level::Error));
            }
        });
    }

    #[test]
    fn get_players_game_info_blocking_emits_a_nonzero_running_frame_for_two_kept_rows() {
        let (_dir, app, handle, player_id) = kept_player_games_fixture(2);
        let progress_id = "player-info-two-kept";
        let lease = {
            let state = app.state::<AppState>();
            crate::progress::begin_progress(&state.progress_state, &app, progress_id.to_string())
                .unwrap()
        };
        let frames = capture_events::<crate::progress::ProgressEvent>(&app);
        let state = app.state::<AppState>();
        get_players_game_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            player_id,
            (app.clone(), Some(lease)),
            &CancellationToken::new(),
            None,
        )
        .unwrap();

        let captured = frames.lock().expect("progress frames");
        assert!(
            captured
                .iter()
                .any(|frame| frame.id == progress_id && frame.progress == 50.0),
            "blocking body must emit a 50.0 Running frame under the lease id, got {captured:?}"
        );
        assert!(
            captured
                .iter()
                .any(|frame| frame.id == progress_id && frame.progress == 100.0),
            "the final frame must include both kept rows, got {captured:?}"
        );
        let item = state.progress_state.get(progress_id).unwrap().unwrap();
        assert_eq!(item.state, crate::progress::ProgressState::Running);
        assert_eq!(item.progress, 100.0);
    }

    #[test]
    fn get_players_game_info_blocking_emits_exact_kept_row_checkpoints() {
        const KEPT_ROWS: usize = 1_002;
        let (_dir, app, handle, player_id) = kept_player_games_fixture(KEPT_ROWS);
        let progress_id = "player-info-checkpoints";
        let state = app.state::<AppState>();
        let lease =
            crate::progress::begin_progress(&state.progress_state, &app, progress_id.into())
                .unwrap();
        let frames = capture_events::<crate::progress::ProgressEvent>(&app);
        let info = get_players_game_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            player_id,
            (app.clone(), Some(lease.clone())),
            &CancellationToken::new(),
            None,
        )
        .unwrap();
        assert_eq!(info.site_stats_data[0].daily[0].won, 1_002);

        let captured = frames.lock().expect("progress frames");
        assert_eq!(
            captured.len(),
            3,
            "expected Running checkpoints at kept rows 1, 1001 and final 1002, got {captured:?}"
        );
        for (frame, kept_rows) in captured.iter().zip([1, 1_001, KEPT_ROWS]) {
            assert_eq!(frame.id, lease.id);
            assert_eq!(frame.generation, lease.generation);
            assert_eq!(frame.state, ProgressState::Running);
            assert!(!frame.finished);
            assert!(!frame.cleared);
            let expected = (kept_rows as f64 / KEPT_ROWS as f64 * 100.0) as f32;
            assert_eq!(
                frame.progress, expected,
                "checkpoint at kept row {kept_rows}"
            );
        }
        let item = state.progress_state.get(progress_id).unwrap().unwrap();
        assert_eq!(item.generation, lease.generation);
        assert_eq!(item.state, ProgressState::Running);
        assert_eq!(item.progress, 100.0);
    }

    #[test]
    fn get_players_game_info_blocking_emits_no_running_frame_when_every_row_is_filtered() {
        let (_dir, app, handle, database) = blocking_database_case();
        mount_progress_events(&app);
        let player_id = {
            let state = app.state::<AppState>();
            let mut db = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            let white = create_player(&mut db, "White").unwrap();
            let black = create_player(&mut db, "Black").unwrap();
            let event = create_event(&mut db, "Event").unwrap();
            let site = create_site(&mut db, "Site").unwrap();
            insert_test_game(&mut db, white.id, black.id, event.id, site.id);
            insert_test_game(&mut db, white.id, black.id, event.id, site.id);
            white.id
        };
        let progress_id = "player-info-zero-kept";
        let lease = {
            let state = app.state::<AppState>();
            crate::progress::begin_progress(&state.progress_state, &app, progress_id.to_string())
                .unwrap()
        };
        let frames = capture_events::<crate::progress::ProgressEvent>(&app);
        let state = app.state::<AppState>();
        get_players_game_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            player_id,
            (app.clone(), Some(lease)),
            &CancellationToken::new(),
            None,
        )
        .unwrap();

        let captured = frames.lock().expect("progress frames");
        assert!(
            captured.is_empty(),
            "zero kept rows must not emit a Running frame, got {captured:?}"
        );
        let item = state.progress_state.get(progress_id).unwrap().unwrap();
        assert_eq!(item.state, crate::progress::ProgressState::Running);
        assert_eq!(item.progress, 0.0);
    }

    #[test]
    fn get_players_game_info_blocking_emits_a_final_frame_when_a_matched_row_is_filtered() {
        let (_dir, app, handle, database) = blocking_database_case();
        mount_progress_events(&app);
        let player_id = {
            let state = app.state::<AppState>();
            let mut db = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            let white = create_player(&mut db, "White").unwrap();
            let black = create_player(&mut db, "Black").unwrap();
            let event = create_event(&mut db, "Event").unwrap();
            let site = create_site(&mut db, "Site").unwrap();
            insert_kept_player_game(&mut db, white.id, black.id, event.id, site.id);
            insert_kept_player_game(&mut db, white.id, black.id, event.id, site.id);
            insert_test_game(&mut db, white.id, black.id, event.id, site.id);
            white.id
        };
        let progress_id = "player-info-mixed-kept-filtered";
        let lease = {
            let state = app.state::<AppState>();
            crate::progress::begin_progress(&state.progress_state, &app, progress_id.to_string())
                .unwrap()
        };
        let frames = capture_events::<crate::progress::ProgressEvent>(&app);
        let state = app.state::<AppState>();
        get_players_game_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            player_id,
            (app.clone(), Some(lease)),
            &CancellationToken::new(),
            None,
        )
        .unwrap();

        let captured = frames.lock().expect("progress frames");
        let running_frames: Vec<_> = captured
            .iter()
            .filter(|frame| frame.id == progress_id && !frame.finished)
            .collect();
        assert_eq!(
            running_frames.len(),
            2,
            "expected the first and final frames"
        );
        let final_progress = running_frames.last().map(|frame| frame.progress).unwrap();
        assert!((final_progress - (200.0 / 3.0)).abs() < 0.001);
        let item = state.progress_state.get(progress_id).unwrap().unwrap();
        assert_eq!(item.state, crate::progress::ProgressState::Running);
        assert!((item.progress - (200.0 / 3.0)).abs() < 0.001);
    }

    fn assert_cancelled_during_real_sql<T>(
        run: impl FnOnce(&CancellationToken) -> Result<T, Error>,
    ) {
        let cancellation = CancellationToken::new();
        let checkpoints = sqlite_cancellation::cancel_on_callback(cancellation.clone(), 2);
        assert!(matches!(run(&cancellation), Err(Error::Cancellation)));
        assert!(
            checkpoints.load(Ordering::SeqCst) >= 2,
            "the production query did not reach two SQLite VM checkpoints"
        );
    }

    #[test]
    fn get_games_production_core_cancels_during_real_sql_without_publication() {
        let (_dir, app, handle, database) = blocking_database_case();
        insert_named_game(&app, &database, "White", "Black", "Event", "Site");
        let state = app.state::<AppState>();
        assert_cancelled_during_real_sql(|token| {
            get_games_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                GameQuery::new(),
                token,
            )
        });
    }

    #[test]
    fn get_games_production_core_cancels_inside_post_sql_normalization() {
        let (_dir, app, handle, database) = blocking_database_case();
        let game_id = insert_named_game(&app, &database, "White", "Black", "Event", "Site");
        {
            let state = app.state::<AppState>();
            let mut db = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            let mut moves = Vec::new();
            encode_comment(&"large normalization payload".repeat(2_000), &mut moves);
            diesel::update(games::table.find(game_id))
                .set(games::moves.eq(moves))
                .execute(&mut *db)
                .unwrap();
        }
        let cancellation = CancellationToken::new();
        encoding::cancel_decode_after_checkpoints(cancellation.clone(), 3);
        let state = app.state::<AppState>();
        let result = get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            GameQuery::new(),
            &cancellation,
        );
        assert!(matches!(result, Err(Error::Cancellation)));
    }

    #[test]
    fn get_players_production_core_cancels_during_real_sql_without_publication() {
        let (_dir, app, handle, database) = blocking_database_case();
        insert_named_game(&app, &database, "White", "Black", "Event", "Site");
        let state = app.state::<AppState>();
        assert_cancelled_during_real_sql(|token| {
            get_players_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                PlayerQuery {
                    options: QueryOptions {
                        skip_count: false,
                        page: None,
                        page_size: None,
                        sort: PlayerSort::Id,
                        direction: SortDirection::Asc,
                    },
                    name: None,
                    name_match: None,
                    range: None,
                },
                token,
            )
        });
    }

    #[test]
    fn get_tournaments_production_core_cancels_during_real_sql_without_publication() {
        let (_dir, app, handle, database) = blocking_database_case();
        insert_named_game(&app, &database, "White", "Black", "Event", "Site");
        let state = app.state::<AppState>();
        assert_cancelled_during_real_sql(|token| {
            get_tournaments_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                TournamentQuery {
                    options: QueryOptions {
                        skip_count: false,
                        page: None,
                        page_size: None,
                        sort: TournamentSort::Id,
                        direction: SortDirection::Asc,
                    },
                    name: None,
                },
                token,
            )
        });
    }

    #[test]
    fn get_players_game_info_production_core_cancels_during_real_sql_without_publication() {
        let (_dir, app, handle, database) = blocking_database_case();
        let game_id = insert_named_game(&app, &database, "White", "Black", "Event", "Site");
        let player_id = {
            let state = app.state::<AppState>();
            let mut connection = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            games::table
                .find(game_id)
                .select(games::white_id)
                .first::<i32>(&mut *connection)
                .unwrap()
        };
        let app_handle = app.clone();
        let state = app.state::<AppState>();
        let count_callbacks = {
            let cancellation = CancellationToken::new();
            let checkpoints =
                sqlite_cancellation::cancel_on_callback(cancellation.clone(), usize::MAX);
            let mut connection = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            let count = sqlite_cancellation::with_sqlite_cancellation(&cancellation, || {
                games::table
                    .inner_join(sites::table.on(games::site_id.eq(sites::id)))
                    .inner_join(players::table.on(players::id.eq(player_id)))
                    .filter(
                        games::white_id
                            .eq(player_id)
                            .or(games::black_id.eq(player_id)),
                    )
                    .filter(games::fen.is_null())
                    .count()
                    .get_result::<i64>(&mut *connection)
            })
            .unwrap();
            assert_eq!(count, 1);
            checkpoints.load(Ordering::SeqCst)
        };
        assert!(count_callbacks > 0);

        let cancellation = CancellationToken::new();
        let streamed_select_checkpoint = count_callbacks + 1;
        let checkpoints = sqlite_cancellation::cancel_on_callback(
            cancellation.clone(),
            streamed_select_checkpoint,
        );
        let result = get_players_game_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            player_id,
            (app_handle, None),
            &cancellation,
            None,
        );
        assert_eq!(
            checkpoints.load(Ordering::SeqCst),
            streamed_select_checkpoint,
            "expected COUNT(*) to consume {count_callbacks} callbacks and the streamed SELECT to stop at callback {streamed_select_checkpoint}"
        );
        assert!(matches!(result, Err(Error::Cancellation)));
    }

    #[test]
    fn preload_reference_db_production_core_cancels_during_index_sql_without_cache_publication() {
        let (_dir, app, handle, database) = blocking_database_case();
        insert_named_game(&app, &database, "White", "Black", "Event", "Site");
        let state = app.state::<AppState>();
        assert_cancelled_during_real_sql(|token| {
            preload_reference_db_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                handle.clone(),
                token,
            )
        });
        assert!(!get_index_path(&database).exists());
    }

    fn mount_convert_progress_events(app: &tauri::AppHandle<tauri::test::MockRuntime>) {
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events!(ConvertProgress))
            .mount_events(app);
    }

    #[test]
    fn convert_pgn_blocking_emits_exactly_two_frames_with_the_passed_id_for_one_game() {
        let (dir, app, handle, _database) = blocking_database_case();
        let pgn_path = dir.path().join("one-game.pgn");
        std::fs::write(&pgn_path, REPLACEMENT_PGN).unwrap();
        let pgn_handle = grant_pgn_file(
            &app,
            &pgn_path,
            "one-game.pgn",
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
        );
        mount_convert_progress_events(&app);
        let frames = capture_events::<ConvertProgress>(&app);
        let progress_id = "convert-one-game";
        let state = app.state::<AppState>();
        convert_pgn_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            vec![pgn_handle],
            handle,
            None,
            app.clone(),
            "Test".into(),
            None,
            progress_id.to_string(),
            &CancellationToken::new(),
        )
        .unwrap();

        let captured = frames.lock().expect("convert progress frames");
        assert_eq!(
            captured.len(),
            2,
            "a one-game import must emit the periodic frame (0.is_multiple_of(1000)) and the terminal frame, got {captured:?}"
        );
        assert!(
            captured.iter().all(|frame| frame.id == progress_id),
            "both ConvertProgress frames must carry the threaded progress_id, got {captured:?}"
        );
    }

    fn start_position_query() -> GameQuery {
        GameQuery::new().position(PositionQueryJs {
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".into(),
            type_: "exact".into(),
        })
    }

    #[test]
    fn wal_insert_does_not_change_main_file_mtime() {
        let (_dir, app, handle, database) = blocking_database_case();
        let game_id = insert_named_game(&app, &database, "Old", "Black", "Event", "Site");
        let before = std::fs::metadata(&database).unwrap();
        let before_length = before.len();
        let before_modified = before.modified().unwrap();
        let state = app.state::<AppState>();
        write_db_game_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            game_id,
            REPLACEMENT_PGN.into(),
            test_game_stamp(&state, &handle, game_id),
            &CancellationToken::new(),
        )
        .unwrap();
        let after = std::fs::metadata(&database).unwrap();
        assert_eq!(after.len(), before_length);
        assert_eq!(after.modified().unwrap(), before_modified);
        assert!(database.with_extension("db3-wal").exists());
    }

    #[test]
    fn data_revision_survives_lru_eviction() {
        let (dir, app, handle, database) = blocking_database_case();
        let game_id = insert_named_game(&app, &database, "Old", "Black", "Event", "Site");
        let state = app.state::<AppState>();
        generate_search_index(
            &handle,
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &CancellationToken::new(),
        )
        .unwrap();
        write_db_game_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            game_id,
            REPLACEMENT_PGN.into(),
            test_game_stamp(&state, &handle, game_id),
            &CancellationToken::new(),
        )
        .unwrap();
        let stale_source = MmapSearchIndex::open(get_index_path(&database))
            .unwrap()
            .source()
            .clone();
        assert_eq!(stale_source.revision, 0);
        for index in 0..=16 {
            let path = dir.path().join(format!("eviction-{index}.db3"));
            state
                .database_repository
                .initialization_connection(&test_target(&path), None)
                .unwrap();
        }
        assert!(search::is_position_in_db(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
            &start_position_query(),
        )
        .unwrap());
        let refreshed_source = MmapSearchIndex::open(get_index_path(&database))
            .unwrap()
            .source()
            .clone();
        assert!(refreshed_source.revision >= 1);
    }

    #[test]
    fn data_revision_survives_new_repository() {
        let (_dir, app, handle, database) = blocking_database_case();
        let game_id = insert_named_game(&app, &database, "Old", "Black", "Event", "Site");
        let state = app.state::<AppState>();
        write_db_game_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            game_id,
            REPLACEMENT_PGN.into(),
            test_game_stamp(&state, &handle, game_id),
            &CancellationToken::new(),
        )
        .unwrap();
        let replacement_repository = DatabaseRepository::default();
        assert!(search::is_position_in_db(
            &state.pgn_path_authority,
            &replacement_repository,
            &state.search_cache,
            &handle,
            &start_position_query(),
        )
        .unwrap());
        let identity = replacement_repository
            .database_identity(&test_target(&database))
            .unwrap();
        assert!(identity.data_revision >= 1);
    }

    #[test]
    fn writers_call_with_validated_mutation() {
        let source = include_str!("mod.rs");
        for function in [
            "edit_db_info_blocking",
            "delete_duplicated_games_blocking",
            "delete_empty_games_blocking",
            "delete_db_game_blocking",
            "write_db_game_blocking",
            "merge_players_blocking",
        ] {
            let body = source
                .split(&format!("fn {function}"))
                .nth(1)
                .unwrap()
                .split("\n}\n")
                .next()
                .unwrap();
            assert!(body.contains("with_validated_mutation"), "{function}");
            assert!(!body.contains("get_db_or_create"), "{function}");
            assert!(!body.contains("repository.connection"), "{function}");
        }
    }

    #[test]
    fn write_db_game_observes_worker_token() {
        let (_dir, app, handle, database) = blocking_database_case();
        let game_id = insert_named_game(&app, &database, "Old", "Black", "Event", "Site");
        let before = database_row_counts(&app, &database);
        let state = app.state::<AppState>();
        let cancellation = CancellationToken::new();
        let callback_token = cancellation.clone();
        let after_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = std::sync::Arc::clone(&after_count);
        let _hooks = repository::configure_test_hooks(&database, move |hooks| {
            hooks.after_bump_op = Some(Box::new(move || {
                observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                callback_token.cancel();
            }));
        });
        let result = write_db_game_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            game_id,
            REPLACEMENT_PGN.into(),
            test_game_stamp(&state, &handle, game_id),
            &cancellation,
        );
        assert!(matches!(result, Err(Error::Cancellation)));
        assert!(after_count.load(std::sync::atomic::Ordering::SeqCst) >= 1);
        assert_eq!(database_row_counts(&app, &database), before);
    }

    #[test]
    fn writers_forward_spawn_token() {
        let source = include_str!("mod.rs");
        for function in [
            "edit_db_info",
            "delete_duplicated_games",
            "delete_empty_games",
            "delete_db_game",
            "write_db_game",
            "merge_players",
            "convert_pgn_command_core",
        ] {
            let start = source
                .find(&format!(
                    "{}fn {function}",
                    if function == "convert_pgn_command_core" {
                        "async "
                    } else {
                        "pub async "
                    }
                ))
                .unwrap();
            let body = &source[start..source[start..].find(".await").unwrap() + start];
            assert!(body.contains("move |token|"), "{function}");
            assert!(body.contains("token"), "{function}");
            assert!(body.contains("blocking"), "{function}");
        }
    }

    fn cached_result_fixture() -> (
        tempfile::TempDir,
        SearchCache,
        PathBuf,
        crate::SearchResultKey,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("cache.db3");
        std::fs::write(&database, b"database").unwrap();
        let source = IndexSource::from_database(&database, 0).unwrap();
        let index_path = get_index_path(&database);
        SearchIndexChunk::default()
            .write_to_with_source(&index_path, source.clone())
            .unwrap()
            .expect_durable();
        let identity = crate::SearchIndexIdentity::for_test_database(&database, source).unwrap();
        let key = crate::SearchResultKey::new(GameQuery::new(), identity);
        let cache = SearchCache::default();
        cache.insert_result(key.clone(), (Vec::new(), Vec::new()));
        (dir, cache, database, key)
    }

    fn seed_search_index_cache_for_database(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        database: &Path,
    ) -> (crate::SearchResultKey, crate::SearchIndexIdentity) {
        let source = IndexSource::from_database(database, 0).unwrap();
        let index_path = get_index_path(database);
        SearchIndexChunk::default()
            .write_to_with_source(&index_path, source.clone())
            .unwrap()
            .expect_durable();
        let identity = crate::SearchIndexIdentity::for_test_database(database, source).unwrap();
        let index = MmapSearchIndex::open(&index_path).unwrap();
        let key = crate::SearchResultKey::new(GameQuery::new(), identity.clone());
        let cache = &app.state::<AppState>().search_cache;
        cache.insert_index(identity.clone(), index, cache.invalidation_snapshot());
        cache.insert_result(key.clone(), (Vec::new(), Vec::new()));
        (key, identity)
    }

    #[test]
    fn finish_search_cache_after_transaction_classifies_errors() {
        let (_dir, cache, path, key) = cached_result_fixture();
        assert!(finish_search_cache_after_transaction(
            Ok(()),
            &cache,
            &DatabaseFileTarget::for_test_path(&path).unwrap()
        )
        .is_ok());
        assert!(cache.get_result(&key).is_none());

        let (_dir, cache, path, key) = cached_result_fixture();
        let diesel_error = Error::Diesel(Box::new(diesel::result::Error::NotFound));
        assert!(finish_search_cache_after_transaction(
            Err(diesel_error),
            &cache,
            &DatabaseFileTarget::for_test_path(&path).unwrap()
        )
        .is_err());
        assert!(cache.get_result(&key).is_none());

        for error in [
            Error::Cancellation,
            Error::Conflict("injected revision bump failure".into()),
            Error::InvalidInput("DataRevision overflow".into()),
        ] {
            let (_dir, cache, path, key) = cached_result_fixture();
            assert!(finish_search_cache_after_transaction(
                Err(error),
                &cache,
                &DatabaseFileTarget::for_test_path(&path).unwrap()
            )
            .is_err());
            assert!(cache.get_result(&key).is_some());
        }

        let (_dir, cache, path, key) = cached_result_fixture();
        let pool_dir = tempfile::tempdir().unwrap();
        let pool_path = pool_dir.path().join("pool.db3");
        let pool = diesel::r2d2::Pool::builder()
            .max_size(1)
            .build(diesel::r2d2::ConnectionManager::<SqliteConnection>::new(
                pool_path.to_string_lossy().into_owned(),
            ))
            .unwrap();
        let _held = pool.get().unwrap();
        let pool_error = match pool.get_timeout(std::time::Duration::ZERO) {
            Err(error) => error,
            Ok(_) => panic!("exhausted pool unexpectedly yielded a connection"),
        };
        let error = Error::R2d2(Box::new(pool_error));
        assert!(finish_search_cache_after_transaction(
            Err(error),
            &cache,
            &DatabaseFileTarget::for_test_path(&path).unwrap()
        )
        .is_err());
        assert!(cache.get_result(&key).is_some());
    }

    #[test]
    fn bump_revision_rolls_back_after_successful_op() {
        let mut db = setup_test_db();
        let before = games::table.count().get_result::<i64>(&mut db).unwrap();
        let _failure = repository::fail_next_revision_bump();
        let result = db.transaction::<_, Error, _>(|db| {
            create_player(db, "rolled back")?;
            bump_revision_in_transaction(
                db,
                std::path::Path::new(":memory:"),
                &CancellationToken::new(),
                |_| Ok(()),
            )
        });
        assert!(
            matches!(result, Err(Error::Conflict(message)) if message == "injected revision bump failure")
        );
        assert_eq!(
            games::table.count().get_result::<i64>(&mut db).unwrap(),
            before
        );
        assert!(players::table
            .filter(players::name.eq("rolled back"))
            .first::<Player>(&mut db)
            .is_err());
    }

    #[test]
    fn convert_pgn_initializes_empty_database() {
        let (dir, app, handle, database) = empty_database_case();
        mount_convert_progress_events(&app);
        let source = dir.path().join("initialize.pgn");
        std::fs::write(&source, REPLACEMENT_PGN).unwrap();
        let result = run_import(&app, handle, vec![grant_import_file(&app, &source)], None);
        assert!(result.is_ok());
        assert_eq!(database_row_counts(&app, &database).games, 1);
        let mut connection = SqliteConnection::establish(database.to_str().unwrap()).unwrap();
        assert_eq!(repository::read_data_revision(&mut connection).unwrap(), 1);
    }

    #[test]
    fn convert_pgn_failed_bump_leaves_empty_database() {
        let (dir, app, handle, database) = empty_database_case();
        mount_convert_progress_events(&app);
        let source = dir.path().join("failed-initialize.pgn");
        std::fs::write(&source, REPLACEMENT_PGN).unwrap();
        let _failure = repository::fail_next_revision_bump();
        assert!(run_import(&app, handle, vec![grant_import_file(&app, &source)], None).is_err());
        let mut connection = SqliteConnection::establish(database.to_str().unwrap()).unwrap();
        let tables: Vec<IndexInfo> = sql_query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .load(&mut connection)
        .unwrap();
        assert!(tables.is_empty());
        assert!(!database
            .with_file_name(search_index::integrity_stamp_leaf(
                database.file_name().unwrap()
            ))
            .exists());
    }

    fn convert_cancel_before_bump_case() -> (Result<(), Error>, PathBuf, usize, bool) {
        let (dir, app, handle, database) = empty_database_case();
        mount_convert_progress_events(&app);
        let source = dir.path().join("cancel.pgn");
        std::fs::write(&source, REPLACEMENT_PGN).unwrap();
        let cache_key = seed_search_cache_for_database(&app, &database);
        let token = CancellationToken::new();
        let callback_token = token.clone();
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let callback_count = std::sync::Arc::clone(&count);
        let _hooks = repository::configure_test_hooks(&database, move |hooks| {
            hooks.after_bump_op = Some(Box::new(move || {
                callback_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }));
            hooks.before_revision_bump = Some(Box::new(move || callback_token.cancel()));
        });
        let result = run_import_with_token(
            &app,
            handle,
            vec![grant_import_file(&app, &source)],
            None,
            &token,
        );
        drop(_hooks);
        (
            result,
            database,
            count.load(std::sync::atomic::Ordering::SeqCst),
            app.state::<AppState>()
                .search_cache
                .get_result(&cache_key)
                .is_some(),
        )
    }

    #[test]
    fn convert_pgn_cancel_before_op_does_not_commit() {
        let (dir, app, handle, database) = empty_database_case();
        mount_convert_progress_events(&app);
        let source = dir.path().join("cancel-before-op.pgn");
        std::fs::write(&source, REPLACEMENT_PGN).unwrap();
        let cache_key = seed_search_cache_for_database(&app, &database);
        let token = CancellationToken::new();
        let after_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = std::sync::Arc::clone(&after_count);
        let _hooks = repository::configure_test_hooks(&database, move |hooks| {
            hooks.after_bump_op = Some(Box::new(move || {
                observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }));
        });
        let (entered, release) = install_database_command_checkpoint("convert_pgn", &handle);
        let worker_app = app.clone();
        let worker_state = worker_app.state::<AppState>();
        let worker_authority = worker_state.pgn_path_authority.clone();
        let worker_repository = std::sync::Arc::clone(&worker_state.database_repository);
        let worker_cache = std::sync::Arc::clone(&worker_state.search_cache);
        let worker_file = grant_import_file(&app, &source);
        let worker_token = token.clone();
        let worker = std::thread::spawn(move || {
            convert_pgn_blocking(
                &worker_authority,
                &worker_repository,
                &worker_cache,
                vec![worker_file],
                handle,
                None,
                worker_app,
                "Test".into(),
                None,
                "cancel-before-op".into(),
                &worker_token,
            )
        });
        entered
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        token.cancel();
        release.send(()).unwrap();
        let result = worker.join().unwrap();
        drop(_hooks);
        assert!(matches!(result, Err(Error::Cancellation)));
        assert_eq!(after_count.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(!database_has_games_table(&database));
        assert!(app
            .state::<AppState>()
            .search_cache
            .get_result(&cache_key)
            .is_some());
        assert!(!database_has_data_revision(&database));
    }

    #[test]
    fn convert_pgn_cancel_before_bump_does_not_commit() {
        let (result, database, count, cache_retained) = convert_cancel_before_bump_case();
        assert!(matches!(result, Err(Error::Cancellation)));
        assert_eq!(count, 1);
        assert!(!database_has_games_table(&database));
        assert!(!database_has_data_revision(&database));
        assert!(cache_retained);
    }

    #[test]
    fn convert_pgn_cancel_during_bump_does_not_commit() {
        let (dir, app, handle, database) = empty_database_case();
        mount_convert_progress_events(&app);
        let source = dir.path().join("cancel-during-bump.pgn");
        std::fs::write(&source, REPLACEMENT_PGN).unwrap();
        let cache_key = seed_search_cache_for_database(&app, &database);
        let token = CancellationToken::new();
        let callback_token = token.clone();
        let _hooks = repository::configure_test_hooks(&database, move |hooks| {
            hooks.after_bump_op = Some(Box::new(move || {
                let _ =
                    crate::db::sqlite_cancellation::cancel_on_callback(callback_token.clone(), 1);
            }));
        });
        let result = run_import_with_token(
            &app,
            handle,
            vec![grant_import_file(&app, &source)],
            None,
            &token,
        );
        assert!(matches!(result, Err(Error::Cancellation)));
        assert!(!database_has_games_table(&database));
        assert!(app
            .state::<AppState>()
            .search_cache
            .get_result(&cache_key)
            .is_some());
        assert!(!database_has_data_revision(&database));
    }

    /// Imports `files` with a token that the first `ConvertProgress` frame
    /// cancels, so everything after that frame runs on a cancelled import.
    fn convert_cancelled_at_first_frame(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        handle: DatabaseHandle,
        files: Vec<FileWorkspaceHandle>,
    ) -> (Result<(), Error>, usize) {
        mount_convert_progress_events(app);
        let frames = capture_events::<ConvertProgress>(app);
        let token = CancellationToken::new();
        let listener_token = token.clone();
        ConvertProgress::listen(app, move |_| listener_token.cancel());
        let result = run_import_with_token(app, handle, files, None, &token);
        let frame_count = frames.lock().expect("convert progress frames").len();
        (result, frame_count)
    }

    #[test]
    fn convert_pgn_cancel_mid_file_stops_parsing_and_does_not_commit() {
        let (dir, app, handle, database) = empty_database_case();
        let source = dir.path().join("cancel-mid-file.pgn");
        // 1001 games: without the per-game check the loop would reach the
        // periodic frame at game 1000 after the cancel at game 0.
        std::fs::write(&source, vec![REPLACEMENT_PGN; 1001].join("\n")).unwrap();
        let (result, frame_count) =
            convert_cancelled_at_first_frame(&app, handle, vec![grant_import_file(&app, &source)]);
        assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
        assert_eq!(frame_count, 1, "no progress may be emitted after cancel");
        assert!(!database_has_games_table(&database));
        assert!(!database_has_data_revision(&database));
    }

    #[test]
    fn convert_pgn_cancel_between_files_does_not_open_the_next_file() {
        let (dir, app, handle, database) = empty_database_case();
        let first = dir.path().join("cancel-first.pgn");
        let second = dir.path().join("cancel-second.pgn");
        std::fs::write(&first, REPLACEMENT_PGN).unwrap();
        std::fs::write(&second, REPLACEMENT_PGN).unwrap();
        let files = vec![
            grant_import_file(&app, &first),
            grant_import_file(&app, &second),
        ];
        // Resolving the removed second file fails with a non-cancellation
        // error, so only the per-file check can yield `Cancellation` here.
        std::fs::remove_file(&second).unwrap();
        let (result, frame_count) = convert_cancelled_at_first_frame(&app, handle, files);
        assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
        assert_eq!(frame_count, 1, "no progress may be emitted after cancel");
        assert!(!database_has_games_table(&database));
        assert!(!database_has_data_revision(&database));
    }

    fn write_mid_game_cancel_source(dir: &Path) -> PathBuf {
        // One bz2 stream holding a small game and a game far larger than the
        // parser's buffer, followed by bytes that are no bz2 stream. Reading
        // that tail fails with an I/O error, so only a reader that observes
        // the cancel before refilling during the large game yields
        // `Cancellation`; checks between games run only after the tail.
        let large_game = format!(
            "[Event \"Large\"]\n\n1. e4 {{{}}} e5 1-0\n",
            "x".repeat(256 * 1024)
        );
        let mut encoder = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
        std::io::Write::write_all(
            &mut encoder,
            format!("{REPLACEMENT_PGN}\n{large_game}").as_bytes(),
        )
        .unwrap();
        let mut bytes = encoder.finish().unwrap();
        bytes.extend_from_slice(b"not a bz2 stream");
        let source = dir.join("cancel-mid-game.pgn.bz2");
        std::fs::write(&source, bytes).unwrap();
        source
    }

    #[test]
    fn import_failure_mid_game_cancellation_has_no_error_failure_log() {
        let (dir, app, handle, database) = empty_database_case();
        let source = write_mid_game_cancel_source(dir.path());
        let file = grant_import_file(&app, &source);
        let capture = crate::error::LogCaptureScope::start();
        let (result, frame_count) = convert_cancelled_at_first_frame(&app, handle, vec![file]);
        assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
        assert_eq!(frame_count, 1, "no progress may be emitted after cancel");
        let records = capture.records();
        assert!(
            !records
                .iter()
                .any(|record| record.level == log::Level::Error
                    && record.message.contains("PGN import failed")),
            "cancellation must not produce an error-level failure log: {records:?}"
        );
        assert!(!database_has_games_table(&database));
        assert!(!database_has_data_revision(&database));
    }

    #[test]
    fn convert_pgn_cancel_mid_game_interrupts_the_parser() {
        let (dir, app, handle, database) = empty_database_case();
        let source = write_mid_game_cancel_source(dir.path());

        let (result, frame_count) = convert_cancelled_at_first_frame(
            &app,
            handle.clone(),
            vec![grant_import_file(&app, &source)],
        );
        assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
        assert_eq!(frame_count, 1, "no progress may be emitted after cancel");
        assert!(!database_has_games_table(&database));
        assert!(!database_has_data_revision(&database));
        let control = run_import(&app, handle, vec![grant_import_file(&app, &source)], None);
        assert!(
            matches!(control, Err(Error::Io(_))),
            "an uncancelled import must reach the corrupt tail, got {control:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn convert_pgn_command_shutdown_cancel_reaches_the_worker() {
        let (dir, app, handle, database) = blocking_database_case();
        let inputs = prepare_database_command_case(
            DatabaseCommandCase::ConvertPgn,
            dir.path(),
            &app,
            &database,
        );
        let before = database_row_counts(&app, &database);
        let (entered, release) = install_database_command_checkpoint("convert_pgn", &handle);
        let command_app = app.clone();
        let command_handle = handle.clone();
        let command = tokio::spawn(async move {
            run_database_command_case(
                DatabaseCommandCase::ConvertPgn,
                command_app,
                command_handle,
                inputs,
            )
            .await
        });
        entered
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("convert_pgn worker did not enter its core");
        app.state::<AppState>()
            .operations
            .seal_and_request_cancellation()
            .unwrap();
        release.send(()).unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), command)
            .await
            .expect("cancelled import must finish")
            .unwrap();
        assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
        assert_eq!(database_row_counts(&app, &database), before);
    }

    #[test]
    fn write_db_game_failed_bump_leaves_games_unchanged() {
        let (_dir, app, handle, database) = blocking_database_case();
        let game_id = insert_named_game(&app, &database, "Old", "Black", "Event", "Site");
        let before = database_row_counts(&app, &database);
        let state = app.state::<AppState>();
        let _failure = repository::fail_next_revision_bump();
        let result = write_db_game_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            game_id,
            REPLACEMENT_PGN.into(),
            test_game_stamp(&state, &handle, game_id),
            &CancellationToken::new(),
        );
        assert!(
            matches!(result, Err(Error::Conflict(message)) if message == "injected revision bump failure")
        );
        assert_eq!(database_row_counts(&app, &database), before);
    }

    #[test]
    fn write_db_game_parse_observes_cancellation() {
        let (_dir, app, handle, database) = blocking_database_case();
        let game_id = insert_named_game(&app, &database, "Old", "Black", "Event", "Site");
        let before = database_row_counts(&app, &database);
        let state = app.state::<AppState>();
        let token = CancellationToken::new();
        token.cancel();
        // Empty input parses to no game, `NoMovesFound`, so only a parser
        // that reads through the token reports `Cancellation`.
        let result = write_db_game_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            game_id,
            String::new(),
            test_game_stamp(&state, &handle, game_id),
            &token,
        );
        assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
        assert_eq!(database_row_counts(&app, &database), before);
    }

    #[test]
    fn edit_db_info_failed_bump_leaves_title_unchanged() {
        let (_dir, app, handle, database) = blocking_database_case();
        let state = app.state::<AppState>();
        let _failure = repository::fail_next_revision_bump();
        let result = edit_db_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle,
            Some("new title".into()),
            None,
            &CancellationToken::new(),
        );
        assert!(result.is_err());
        let mut db = state
            .database_repository
            .connection(&test_target(&database), None)
            .unwrap();
        assert!(info::table
            .find("Title")
            .select(info::value)
            .first::<Option<String>>(&mut *db)
            .optional()
            .unwrap()
            .flatten()
            .is_none());
    }

    #[test]
    fn delete_db_game_failed_bump_leaves_game() {
        let (_dir, app, handle, database) = blocking_database_case();
        let game_id = insert_named_game(&app, &database, "White", "Black", "Event", "Site");
        let state = app.state::<AppState>();
        let _failure = repository::fail_next_revision_bump();
        assert!(delete_db_game_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle,
            game_id,
            &CancellationToken::new(),
        )
        .is_err());
        let mut db = state
            .database_repository
            .connection(&test_target(&database), None)
            .unwrap();
        assert!(games::table.find(game_id).first::<Game>(&mut *db).is_ok());
    }

    #[test]
    fn delete_duplicated_games_failed_bump_leaves_games() {
        let (_dir, app, handle, database) = blocking_database_case();
        {
            let state = app.state::<AppState>();
            let mut db = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            let white = create_player(&mut db, "White").unwrap();
            let black = create_player(&mut db, "Black").unwrap();
            let event = create_event(&mut db, "Event").unwrap();
            let site = create_site(&mut db, "Site").unwrap();
            insert_test_game(&mut db, white.id, black.id, event.id, site.id);
            insert_test_game(&mut db, white.id, black.id, event.id, site.id);
        }
        let state = app.state::<AppState>();
        let _failure = repository::fail_next_revision_bump();
        assert!(delete_duplicated_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle,
            &CancellationToken::new(),
        )
        .is_err());
        assert_eq!(database_row_counts(&app, &database).games, 2);
    }

    #[test]
    fn delete_empty_games_failed_bump_leaves_games() {
        let (_dir, app, handle, database) = blocking_database_case();
        {
            let state = app.state::<AppState>();
            let mut db = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            let white = create_player(&mut db, "White").unwrap();
            let black = create_player(&mut db, "Black").unwrap();
            let event = create_event(&mut db, "Event").unwrap();
            let site = create_site(&mut db, "Site").unwrap();
            insert_test_game(&mut db, white.id, black.id, event.id, site.id);
        }
        let state = app.state::<AppState>();
        let _failure = repository::fail_next_revision_bump();
        assert!(delete_empty_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle,
            &CancellationToken::new(),
        )
        .is_err());
        assert_eq!(database_row_counts(&app, &database).games, 1);
    }

    #[test]
    fn merge_players_failed_bump_leaves_players() {
        let (_dir, app, handle, database) = blocking_database_case();
        let (source, target) = {
            let state = app.state::<AppState>();
            let mut db = state
                .database_repository
                .connection(&test_target(&database), None)
                .unwrap();
            (
                create_player(&mut db, "Source").unwrap(),
                create_player(&mut db, "Target").unwrap(),
            )
        };
        let state = app.state::<AppState>();
        let _failure = repository::fail_next_revision_bump();
        assert!(merge_players_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle,
            source.id,
            target.id,
            &CancellationToken::new(),
        )
        .is_err());
        let mut db = state
            .database_repository
            .connection(&test_target(&database), None)
            .unwrap();
        assert!(players::table
            .find(source.id)
            .first::<Player>(&mut *db)
            .is_ok());
    }

    #[test]
    fn writers_failed_bump_does_not_invalidate_cache() {
        for operation in ["write", "edit", "delete", "duplicates", "empty", "merge"] {
            let (_dir, app, handle, database) = blocking_database_case();
            let game_id = insert_named_game(&app, &database, "White", "Black", "Event", "Site");
            if operation == "duplicates" {
                let state = app.state::<AppState>();
                let mut db = state
                    .database_repository
                    .connection(&test_target(&database), None)
                    .unwrap();
                let white = games::table
                    .find(game_id)
                    .select(games::white_id)
                    .first::<i32>(&mut *db)
                    .unwrap();
                let black = games::table
                    .find(game_id)
                    .select(games::black_id)
                    .first::<i32>(&mut *db)
                    .unwrap();
                let event = games::table
                    .find(game_id)
                    .select(games::event_id)
                    .first::<i32>(&mut *db)
                    .unwrap();
                let site = games::table
                    .find(game_id)
                    .select(games::site_id)
                    .first::<i32>(&mut *db)
                    .unwrap();
                insert_test_game(&mut db, white, black, event, site);
            }
            if operation == "merge" {
                let state = app.state::<AppState>();
                let mut db = state
                    .database_repository
                    .connection(&test_target(&database), None)
                    .unwrap();
                create_player(&mut db, "MergeSource").unwrap();
                create_player(&mut db, "MergeTarget").unwrap();
            }
            if operation == "empty" {
                let state = app.state::<AppState>();
                let mut db = state
                    .database_repository
                    .connection(&test_target(&database), None)
                    .unwrap();
                let white = games::table
                    .find(game_id)
                    .select(games::white_id)
                    .first::<i32>(&mut *db)
                    .unwrap();
                let black = games::table
                    .find(game_id)
                    .select(games::black_id)
                    .first::<i32>(&mut *db)
                    .unwrap();
                let event = games::table
                    .find(game_id)
                    .select(games::event_id)
                    .first::<i32>(&mut *db)
                    .unwrap();
                let site = games::table
                    .find(game_id)
                    .select(games::site_id)
                    .first::<i32>(&mut *db)
                    .unwrap();
                diesel::update(games::table.find(game_id))
                    .set(games::ply_count.eq(0))
                    .execute(&mut *db)
                    .unwrap();
                let _ = (white, black, event, site);
            }
            let state = app.state::<AppState>();
            generate_search_index(
                &handle,
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                &CancellationToken::new(),
            )
            .unwrap();
            let source = MmapSearchIndex::open(get_index_path(&database))
                .unwrap()
                .source()
                .clone();
            let identity =
                crate::SearchIndexIdentity::for_test_database(&database, source).unwrap();
            let key = crate::SearchResultKey::new(GameQuery::new(), identity);
            state
                .search_cache
                .insert_result(key.clone(), (Vec::new(), Vec::new()));
            let _failure = repository::fail_next_revision_bump();
            let result = match operation {
                "write" => write_db_game_blocking(
                    &state.pgn_path_authority,
                    &state.database_repository,
                    &state.search_cache,
                    handle.clone(),
                    game_id,
                    REPLACEMENT_PGN.into(),
                    test_game_stamp(&state, &handle, game_id),
                    &CancellationToken::new(),
                )
                .map(|_| ()),
                "edit" => edit_db_info_blocking(
                    &state.pgn_path_authority,
                    &state.database_repository,
                    &state.search_cache,
                    handle,
                    Some("x".into()),
                    None,
                    &CancellationToken::new(),
                ),
                "delete" => delete_db_game_blocking(
                    &state.pgn_path_authority,
                    &state.database_repository,
                    &state.search_cache,
                    handle,
                    game_id,
                    &CancellationToken::new(),
                ),
                "duplicates" => delete_duplicated_games_blocking(
                    &state.pgn_path_authority,
                    &state.database_repository,
                    &state.search_cache,
                    handle,
                    &CancellationToken::new(),
                ),
                "empty" => delete_empty_games_blocking(
                    &state.pgn_path_authority,
                    &state.database_repository,
                    &state.search_cache,
                    handle,
                    &CancellationToken::new(),
                ),
                "merge" => merge_players_blocking(
                    &state.pgn_path_authority,
                    &state.database_repository,
                    &state.search_cache,
                    handle,
                    game_id + 1,
                    game_id + 2,
                    &CancellationToken::new(),
                ),
                _ => unreachable!(),
            };
            assert!(
                result.is_err(),
                "{operation} must fail at the injected bump"
            );
            assert!(
                state.search_cache.get_result(&key).is_some(),
                "{operation} invalidated pre-commit cache"
            );
        }
    }

    #[test]
    fn legacy_v1_migrate_rolls_back_with_failed_bump() {
        let mut db = SqliteConnection::establish(":memory:").unwrap();
        db.batch_execute(
            "CREATE TABLE Info (Name TEXT UNIQUE NOT NULL, Value TEXT);
             CREATE TABLE Players (ID INTEGER PRIMARY KEY, Name TEXT UNIQUE, Elo INTEGER);
             CREATE TABLE Events (ID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT UNIQUE);
             CREATE TABLE Sites (ID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT UNIQUE);
             CREATE TABLE Games (ID INTEGER PRIMARY KEY AUTOINCREMENT, EventID INTEGER, SiteID INTEGER, Date TEXT, UTCTime TEXT, Round INTEGER, WhiteID INTEGER, WhiteElo INTEGER, BlackID INTEGER, BlackElo INTEGER, WhiteMaterial INTEGER, BlackMaterial INTEGER, Result INTEGER, TimeControl TEXT, ECO TEXT, PlyCount INTEGER, FEN TEXT, Moves BLOB, PawnHome BLOB);
             INSERT INTO Players VALUES (0, 'Unknown', NULL); INSERT INTO Events VALUES (0, 'Unknown'); INSERT INTO Sites VALUES (0, 'Unknown'); INSERT INTO Info VALUES ('Version', '1.0.0');",
        )
        .unwrap();
        let _failure = repository::fail_next_revision_bump();
        let result = db.transaction::<_, Error, _>(|db| {
            bump_revision_in_transaction(
                db,
                std::path::Path::new(":memory:"),
                &CancellationToken::new(),
                migrations::validate_existing_database,
            )
        });
        assert!(
            matches!(result, Err(Error::Conflict(message)) if message == "injected revision bump failure")
        );
        let version: String = sql_query("SELECT Value AS value FROM Info WHERE Name = 'Version'")
            .get_result::<InfoValue>(&mut db)
            .unwrap()
            .value;
        assert_eq!(version, "1.0.0");
        assert_eq!(repository::read_data_revision(&mut db).unwrap(), 0);
    }

    #[derive(QueryableByName)]
    struct InfoValue {
        #[diesel(sql_type = Text)]
        value: String,
    }

    fn database_has_games_table(path: &Path) -> bool {
        #[derive(QueryableByName)]
        struct TableCount {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            count: i64,
        }
        let Ok(mut connection) = SqliteConnection::establish(path.to_str().unwrap()) else {
            return false;
        };
        sql_query(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'Games'",
        )
        .get_result::<TableCount>(&mut connection)
        .map(|row| row.count > 0)
        .unwrap_or(false)
    }

    fn database_has_data_revision(path: &Path) -> bool {
        let Ok(mut connection) = SqliteConnection::establish(path.to_str().unwrap()) else {
            return false;
        };
        sql_query("SELECT Value AS value FROM Info WHERE Name = 'DataRevision'")
            .load::<InfoValue>(&mut connection)
            .map(|rows| !rows.is_empty())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod setup_policy_tests {
    use super::*;

    #[test]
    fn connection_options_wait_for_read_lock_before_enabling_wal() {
        use diesel::r2d2::CustomizeConnection;
        use std::{sync::mpsc, time::Duration};

        const LOCK_OBSERVATION_WAIT: Duration = Duration::from_millis(200);
        const COMPLETION_BOUND: Duration = Duration::from_secs(10);
        #[derive(QueryableByName)]
        struct JournalMode {
            #[diesel(sql_type = Text)]
            journal_mode: String,
        }

        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("options.db3");
        let mut first = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        first
            .batch_execute(
                "PRAGMA journal_mode = DELETE;
                 CREATE TABLE Locked (value INTEGER);
                 INSERT INTO Locked VALUES (1);
                 BEGIN;
                 SELECT * FROM Locked;",
            )
            .unwrap();
        let mut second = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        let (started, start_signal) = mpsc::channel();
        let (done, result) = mpsc::channel();
        let origin = Instant::now();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                started.send(()).unwrap();
                done.send(ConnectionOptions.on_acquire(&mut second))
                    .unwrap();
            });
            start_signal.recv_timeout(COMPLETION_BOUND).unwrap();
            std::thread::sleep(LOCK_OBSERVATION_WAIT);
            let early = result.try_recv();
            // Release before asserting so the counterproof cannot strand the worker.
            first.batch_execute("ROLLBACK;").unwrap();
            assert!(
                matches!(early, Err(mpsc::TryRecvError::Empty)),
                "on_acquire returned while the read lock was held: {early:?}"
            );
            result.recv_timeout(COMPLETION_BOUND).unwrap().unwrap();
        });
        assert_eq!(
            sql_query("PRAGMA journal_mode")
                .get_result::<JournalMode>(&mut second)
                .unwrap()
                .journal_mode,
            "wal"
        );
        eprintln!("contended on_acquire completed in {:?}", origin.elapsed());
    }

    const IMPORTER_STANDARD_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const IMPORTER_CUSTOM_FEN: &str = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1";

    #[test]
    fn importer_custom_then_standard_fen_matches_ordinary_standard_game() {
        let custom_fen = Fen::from_ascii(IMPORTER_CUSTOM_FEN.as_bytes()).unwrap();
        assert_ne!(
            database_setup_to_chess(custom_fen.into_setup()).unwrap(),
            Chess::default()
        );
        let pgn = format!(
            "[Event \"Ordinary\"]\n\n1. e4 e5 2. Nf3 *\n\n\
             [Event \"Repeated FEN\"]\n[FEN \"{IMPORTER_CUSTOM_FEN}\"]\n\
             [FEN \"{IMPORTER_STANDARD_FEN}\"]\n\n1. e4 e5 2. Nf3 *\n"
        );
        let mut reader = BufferedReader::new(pgn.as_bytes());
        let mut importer = Importer::new(None);
        let ordinary = reader.read_game(&mut importer).unwrap().unwrap().unwrap();
        let repeated = reader.read_game(&mut importer).unwrap().unwrap().unwrap();

        assert!(ordinary.fen.is_none());
        assert!(repeated.fen.is_none());
        assert_eq!(repeated.moves, ordinary.moves);
        assert_eq!(repeated.position, ordinary.position);
        let ordinary_movetext = decode_game_to_movetext(&ordinary.moves, Fen::default()).unwrap();
        let repeated_movetext = decode_game_to_movetext(&repeated.moves, Fen::default()).unwrap();
        assert_eq!(ordinary_movetext, "1. e4 e5 2. Nf3");
        assert_eq!(repeated_movetext, ordinary_movetext);
        assert!(reader.read_game(&mut importer).unwrap().is_none());
    }

    #[test]
    fn importer_custom_then_standard_fen_rejects_custom_only_move() {
        let pgn = format!(
            "[Event \"Custom\"]\n[FEN \"{IMPORTER_CUSTOM_FEN}\"]\n\n1. Kf2 *\n\n\
             [Event \"Repeated FEN\"]\n[FEN \"{IMPORTER_CUSTOM_FEN}\"]\n\
             [FEN \"{IMPORTER_STANDARD_FEN}\"]\n\n1. Kf2 *\n"
        );
        let mut reader = BufferedReader::new(pgn.as_bytes());
        let mut importer = Importer::new(None);
        let custom = reader.read_game(&mut importer).unwrap().unwrap().unwrap();
        let custom_fen = Fen::from_ascii(custom.fen.as_ref().unwrap().as_bytes()).unwrap();
        assert_eq!(
            decode_game_to_movetext(&custom.moves, custom_fen).unwrap(),
            "1. Kf2"
        );
        assert!(reader.read_game(&mut importer).unwrap().unwrap().is_none());
        assert!(reader.read_game(&mut importer).unwrap().is_none());
    }

    #[test]
    fn importer_standard_then_custom_fen_preserves_custom_setup() {
        let pgn = format!(
            "[FEN \"{IMPORTER_STANDARD_FEN}\"]\n[FEN \"{IMPORTER_CUSTOM_FEN}\"]\n\n\
             1. Kf2 Kf7 *\n"
        );
        let mut reader = BufferedReader::new(pgn.as_bytes());
        let mut importer = Importer::new(None);
        let game = reader.read_game(&mut importer).unwrap().unwrap().unwrap();

        assert_eq!(game.fen.as_deref(), Some(IMPORTER_CUSTOM_FEN));
        let initial_fen = Fen::from_ascii(game.fen.as_ref().unwrap().as_bytes()).unwrap();
        assert_eq!(
            decode_game_to_movetext(&game.moves, initial_fen).unwrap(),
            "1. Kf2 Kf7"
        );
        assert!(reader.read_game(&mut importer).unwrap().is_none());
    }

    #[test]
    fn importer_malformed_then_standard_fen_remains_skipped() {
        for malformed_fen in ["invalid fen", "8/8/8/8/8/P7/PPPPPPPP/4K3 w - - 0 1"] {
            let pgn = format!(
                "[FEN \"{malformed_fen}\"]\n[FEN \"{IMPORTER_STANDARD_FEN}\"]\n\n\
                 1. e4 e5 *\n"
            );
            let mut reader = BufferedReader::new(pgn.as_bytes());
            let mut importer = Importer::new(None);
            assert!(reader.read_game(&mut importer).unwrap().unwrap().is_none());
            assert!(reader.read_game(&mut importer).unwrap().is_none());
        }
    }

    #[test]
    fn importer_rejects_malformed_fen_and_invalid_king_setups() {
        for fen in [
            "invalid fen",
            "8/8/8/8/8/P7/PPPPPPPP/4K3 w - - 0 1",
            "4k3/8/8/8/8/P7/PPPPPPPP/3KK3 w - - 0 1",
        ] {
            let pgn = format!("[SetUp \"1\"]\n[FEN \"{fen}\"]\n\n*\n");
            let mut reader = BufferedReader::new(pgn.as_bytes());
            let mut importer = Importer::new(None);
            assert!(reader.read_game(&mut importer).unwrap().unwrap().is_none());
            assert!(reader.read_game(&mut importer).unwrap().is_none());
        }
    }
}

#[cfg(test)]
mod content_validation_tests;

#[cfg(test)]
mod exact_player_tests {
    use super::*;
    use diesel::connection::SimpleConnection;
    use tauri::Manager;

    fn query(name: &str, mode: Option<PlayerNameMatch>) -> PlayerQuery {
        PlayerQuery {
            options: QueryOptions {
                skip_count: false,
                page: None,
                page_size: None,
                sort: PlayerSort::Id,
                direction: SortDirection::Asc,
            },
            name: Some(name.into()),
            name_match: mode,
            range: None,
        }
    }

    #[test]
    fn exact_player_literal_identity_and_default_substring() {
        let (_dir, app, handle, database) =
            schema_database_case("exact-player", vec![PathOperation::DatabaseRead]);
        let mut connection = SqliteConnection::establish(database.to_str().unwrap()).unwrap();
        connection
            .batch_execute(
                "INSERT INTO Players (ID, Name, Elo) VALUES
             (1, 'alexander', 1500), (2, 'alex', 1200), (3, 'ALex', 1600),
             (4, 'ALEx', 2000), (5, 'axb', 1500), (6, 'a_b', 1500),
             (7, 'percentOther', 1500), (8, 'percent%', 1500),
             (9, 'o''brien', 1500), (10, 'o''brien junior', 1500),
             (11, 'missing-owner-opponent', 1500),
             (12, 'Älex', 1500), (13, 'älex', 1500);",
            )
            .unwrap();
        drop(connection);
        let state = app.state::<AppState>();
        let lookup = |query| {
            get_players_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle.clone(),
                query,
                &CancellationToken::new(),
            )
            .unwrap()
        };
        for (name, expected) in [
            ("alex", vec![2, 3, 4]),
            ("a_b", vec![6]),
            ("percent%", vec![8]),
            ("o'brien", vec![9]),
            ("missing-owner", vec![]),
            ("ÄLEX", vec![12]),
        ] {
            let result = lookup(query(name, Some(PlayerNameMatch::Exact)));
            assert_eq!(
                result.count,
                Some(expected.len() as i32),
                "count for {name}"
            );
            assert_eq!(
                result.data.iter().map(|p| p.id).collect::<Vec<_>>(),
                expected,
                "data for {name}"
            );
        }
        for mode in [None, Some(PlayerNameMatch::Contains)] {
            let result = lookup(query("alex", mode));
            assert_eq!(result.count, Some(4));
            assert_eq!(
                result.data.iter().map(|p| p.id).collect::<Vec<_>>(),
                vec![1, 2, 3, 4]
            );
        }
        assert_eq!(lookup(query("a_b", None)).count, Some(2));
        assert_eq!(lookup(query("percent%", None)).count, Some(2));

        let mut paged = query("aLeX", Some(PlayerNameMatch::Exact));
        paged.range = Some((1500, 2200));
        paged.options.page_size = Some(1);
        paged.options.page = Some(2);
        let result = lookup(paged.clone());
        assert_eq!(result.count, Some(2));
        assert_eq!(
            result.data.iter().map(|p| p.id).collect::<Vec<_>>(),
            vec![4]
        );
        paged.options.skip_count = true;
        assert_eq!(lookup(paged).count, None);

        let mut substring_page = query("alex", None);
        substring_page.range = Some((1500, 2200));
        substring_page.options.page_size = Some(1);
        substring_page.options.page = Some(2);
        let result = lookup(substring_page);
        assert_eq!(result.count, Some(3));
        assert_eq!(
            result.data.iter().map(|p| p.id).collect::<Vec<_>>(),
            vec![3]
        );
    }

    #[test]
    fn exact_player_optional_wire_contract() {
        let original = serde_json::json!({
            "options": {"skipCount": false, "sort": "id", "direction": "asc"},
            "name": "alex"
        });
        let legacy: PlayerQuery = serde_json::from_value(original.clone()).unwrap();
        assert!(legacy.name_match.is_none());
        let mut nullable = original.clone();
        nullable["nameMatch"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<PlayerQuery>(nullable)
            .unwrap()
            .name_match
            .is_none());
        for (value, exact) in [("contains", false), ("exact", true)] {
            let mut wire = original.clone();
            wire["nameMatch"] = serde_json::json!(value);
            let decoded: PlayerQuery = serde_json::from_value(wire).unwrap();
            assert_eq!(
                matches!(decoded.name_match, Some(PlayerNameMatch::Exact)),
                exact
            );
        }
        let mut wire = original;
        wire["nameMatch"] = serde_json::json!("prefix");
        assert!(serde_json::from_value::<PlayerQuery>(wire).is_err());
    }
}

#[cfg(test)]
mod unlinked_account_tests {
    use super::*;

    struct Fixture {
        directory: tempfile::TempDir,
        app: tauri::AppHandle<tauri::test::MockRuntime>,
        database: DatabaseHandle,
        path: std::path::PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let (directory, app, database, path) = blocking_database_case();
            tauri_specta::Builder::<tauri::test::MockRuntime>::new()
                .events(tauri_specta::collect_events!(ConvertProgress))
                .mount_events(&app);
            Self {
                directory,
                app,
                database,
                path,
            }
        }

        fn cursor(&self) -> Option<i64> {
            let state = self.app.state::<AppState>();
            account_sync_cursor_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                &self.database,
                &CancellationToken::new(),
            )
            .unwrap()
        }

        fn context(
            &self,
            provider: &str,
            holds: Option<Vec<crate::lichess::CoverageHold>>,
        ) -> AccountImportContext {
            AccountImportContext {
                identity: linked_collections::AccountIdentity {
                    provider: provider.into(),
                    account: "Player".into(),
                },
                since_ms: self.cursor(),
                coverage_holds: holds,
            }
        }

        fn convert(
            &self,
            pgn: &str,
            context: Option<AccountImportContext>,
            cancellation: &CancellationToken,
        ) -> Result<(), Error> {
            let source = self.directory.path().join("account-import.pgn");
            std::fs::write(&source, pgn).unwrap();
            let file = grant_pgn_file(
                &self.app,
                &source,
                "account-import.pgn",
                vec![PathOperation::ReadPgn],
            );
            let state = self.app.state::<AppState>();
            convert_pgn_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                vec![file],
                self.database.clone(),
                context,
                self.app.clone(),
                "Account".into(),
                None,
                self.database.path_ref().id.clone(),
                cancellation,
            )
        }

        fn count(&self, table: &str) -> i64 {
            rusqlite::Connection::open(&self.path)
                .unwrap()
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        }
    }

    fn game(provider: &str, id: &str, date: &str, time: Option<&str>) -> String {
        let identity = match provider {
            "lichess" => format!("[Site \"https://lichess.org/{id}\"]\n"),
            "chesscom" => {
                format!("[Site \"Chess.com\"]\n[Link \"https://www.chess.com/game/daily/{id}\"]\n")
            }
            _ => String::new(),
        };
        let time = time
            .map(|time| format!("[UTCTime \"{time}\"]\n"))
            .unwrap_or_default();
        format!("[White \"Player\"]\n[Black \"Opponent\"]\n[Date \"{date}\"]\n{identity}{time}\n1. e4 e5 *\n\n")
    }

    #[test]
    fn unlinked_chesscom_daily_replay_reconciles_legacy_and_imports_old_start_once() {
        let fixture = Fixture::new();
        let cancellation = CancellationToken::new();
        let september = game("chesscom", "19", "2026.09.19", Some("12:00:00"));
        fixture.convert(&september, None, &cancellation).unwrap();
        assert_eq!(
            fixture.cursor(),
            None,
            "legacy rows force a full-history sync"
        );
        let daily = game("chesscom", "5", "2026.09.05", Some("12:00:00"));
        let archives = format!("{september}{daily}{september}{daily}");
        for _ in 0..2 {
            fixture
                .convert(
                    &archives,
                    Some(fixture.context("chesscom", None)),
                    &cancellation,
                )
                .unwrap();
            assert_eq!(fixture.count("Games"), 2);
            assert_eq!(fixture.count("AccountProviderGames"), 2);
        }
        assert!(fixture.cursor().is_some());
        let mut db = SqliteConnection::establish(fixture.path.to_str().unwrap()).unwrap();
        migrations::validate_existing_database(&mut db).unwrap();
        let site: Option<String> = sites::table
            .filter(sites::id.ne(0))
            .select(sites::name)
            .first(&mut db)
            .unwrap();
        assert_eq!(site.as_deref(), Some("Chess.com"));
    }

    #[test]
    fn unlinked_distinct_ids_survive_equal_fingerprints_with_and_without_time() {
        for time in [Some("12:00:00"), None] {
            let fixture = Fixture::new();
            let a = game("chesscom", "1", "2026.09.05", time);
            let b = game("chesscom", "2", "2026.09.05", time);
            let batch = format!("{a}{b}{a}{b}");
            for _ in 0..2 {
                fixture
                    .convert(
                        &batch,
                        Some(fixture.context("chesscom", None)),
                        &CancellationToken::new(),
                    )
                    .unwrap();
                assert_eq!(fixture.count("Games"), 2);
                assert_eq!(fixture.count("AccountProviderGames"), 2);
            }
        }
    }

    #[test]
    fn unlinked_legacy_rows_are_claimed_once_even_when_fingerprints_are_equal() {
        for legacy_count in [1, 2] {
            let fixture = Fixture::new();
            let legacy = game("", "", "2026.09.05", None);
            fixture
                .convert(
                    &legacy.repeat(legacy_count),
                    None,
                    &CancellationToken::new(),
                )
                .unwrap();
            let batch = format!(
                "{}{}{}",
                game("chesscom", "1", "2026.09.05", None),
                game("chesscom", "2", "2026.09.05", None),
                game("chesscom", "3", "2026.09.05", None)
            );
            for _ in 0..2 {
                fixture
                    .convert(
                        &batch,
                        Some(fixture.context("chesscom", None)),
                        &CancellationToken::new(),
                    )
                    .unwrap();
                assert_eq!(fixture.count("Games"), 3);
                assert_eq!(fixture.count("AccountProviderGames"), 3);
            }
        }
    }

    #[test]
    fn unlinked_missing_or_malformed_start_is_imported_without_moving_cursor() {
        let fixture = Fixture::new();
        let batch = format!(
            "{}{}{}",
            game("chesscom", "1", "2026.09.05", None),
            game("chesscom", "2", "invalid", Some("12:00:00")),
            game("chesscom", "3", "2026.09.05", Some("invalid"))
        );
        for _ in 0..2 {
            fixture
                .convert(
                    &batch,
                    Some(fixture.context("chesscom", None)),
                    &CancellationToken::new(),
                )
                .unwrap();
            assert_eq!(fixture.count("Games"), 3);
            assert_eq!(fixture.cursor(), Some(0));
        }
        let absent_date = game("chesscom", "4", "2026.09.05", Some("12:00:00"))
            .replace("[Date \"2026.09.05\"]\n", "");
        fixture
            .convert(
                &absent_date,
                Some(fixture.context("chesscom", None)),
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(fixture.count("Games"), 4);
        assert_eq!(fixture.cursor(), Some(0));
    }

    #[test]
    fn unlinked_idless_games_reconcile_stored_rows_and_duplicates_in_the_file() {
        let fixture = Fixture::new();
        let game = game("", "", "2026.09.05", None);
        fixture
            .convert(&game, None, &CancellationToken::new())
            .unwrap();
        fixture
            .convert(
                &game.repeat(2),
                Some(fixture.context("chesscom", None)),
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(fixture.count("Games"), 1);
        assert_eq!(fixture.count("AccountProviderGames"), 0);
        let new_game = game.replace("e4 e5", "d4 d5");
        fixture
            .convert(
                &new_game.repeat(2),
                Some(fixture.context("chesscom", None)),
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(fixture.count("Games"), 2);
    }

    #[test]
    fn unlinked_duplicate_games_still_cover_finished_holds_and_advance_cursor() {
        let fixture = Fixture::new();
        let pgn = game("lichess", "newgame1", "2026.10.10", Some("12:00:00"));
        fixture
            .convert(
                &pgn,
                Some(fixture.context("lichess", None)),
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(
            fixture.cursor(),
            Some(0),
            "missing holds freeze Lichess coverage"
        );
        let hold = crate::lichess::CoverageHold {
            id: "newgame1".into(),
            created_at_ms: 1,
            ongoing: false,
        };
        let frames = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = frames.clone();
        let listener = ConvertProgress::listen(&fixture.app, move |event| {
            captured.lock().unwrap().push(event.payload);
        });
        fixture
            .convert(
                &pgn.repeat(3),
                Some(fixture.context("lichess", Some(vec![hold]))),
                &CancellationToken::new(),
            )
            .unwrap();
        use tauri::Listener as _;
        fixture.app.unlisten(listener);
        let frames = frames.lock().unwrap();
        assert_eq!(
            frames.len(),
            1,
            "duplicate replay emits only its terminal frame"
        );
        assert_eq!(frames[0].imported_games, 0);
        assert_eq!(frames[0].source_file_name, None);
        assert_eq!(fixture.count("Games"), 1);
        assert_eq!(fixture.cursor(), Some(1_791_633_600_000));
    }

    #[test]
    fn unlinked_cancel_rolls_back_games_provider_table_and_cursor_together() {
        let fixture = Fixture::new();
        let cancellation = CancellationToken::new();
        let token = cancellation.clone();
        CONVERSION_BEFORE_REVISION.arm(
            fixture.database.path_ref().id.clone(),
            Box::new(move || token.cancel()),
        );
        let result = fixture.convert(
            &game("chesscom", "1", "2026.09.05", None),
            Some(fixture.context("chesscom", None)),
            &cancellation,
        );
        assert!(matches!(result, Err(Error::Cancellation)));
        assert_eq!(fixture.count("Games"), 0);
        assert_eq!(fixture.cursor(), None);
        let tables: i64 = rusqlite::Connection::open(&fixture.path)
            .unwrap()
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'AccountProviderGames'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0);
    }
}

/// Database deletion tests that run on every target, Windows included. Tests that need the
/// Unix-only removal fault injector stay in `mod tests`.
#[cfg(test)]
mod deletion_tests {
    use super::*;

    struct AbsentPrimaryCase {
        directory: tempfile::TempDir,
        app: tauri::AppHandle<tauri::test::MockRuntime>,
        handle: DatabaseHandle,
        database: std::path::PathBuf,
    }

    impl AbsentPrimaryCase {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let parent = directory.path().join("parent");
            std::fs::create_dir(&parent).unwrap();
            let database = parent.join("games.db3");
            std::fs::write(&database, b"").unwrap();
            let (app, handle) = database_app_with_grant(
                directory.path(),
                &database,
                "games",
                full_database_operations(),
            );
            Self {
                directory,
                app,
                handle,
                database,
            }
        }

        fn install_empty_collection_service(&self) {
            use crate::infra::path_authority::{
                ensure_app_owned_default_dir, AppDataDir, AppOwnedDefaultRoot,
            };
            let state = self.app.state::<AppState>();
            let root = ensure_app_owned_default_dir(
                &AppDataDir::for_test(&self.directory.path().join("app")),
                AppOwnedDefaultRoot::Collections,
            )
            .unwrap();
            state
                .pgn_path_authority
                .install_collections(linked_collections::CollectionService::open(
                    root,
                    Arc::clone(&state.workspace_mutation),
                    Arc::clone(&state.database_repository),
                    Arc::clone(&state.search_cache),
                    state.pgn_repository.clone(),
                ))
                .unwrap();
        }

        fn delete(&self, cancellation: &CancellationToken) -> Result<(), Error> {
            let state = self.app.state::<AppState>();
            delete_database_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                self.handle.clone(),
                cancellation,
            )
        }

        fn assert_registered(&self, expected: bool) {
            assert_database_registry_entry_present(self.directory.path(), &self.handle, expected);
            let state = self.app.state::<AppState>();
            assert_eq!(
                state
                    .pgn_path_authority
                    .with_mut(|authority| {
                        authority.has_persistent_id(&self.handle.path_ref().id)
                    })
                    .unwrap(),
                expected
            );
        }

        fn preferred(&self) -> std::path::PathBuf {
            let preferred = get_index_path(&self.database);
            SearchIndexChunk::default()
                .write_to_with_source(
                    &preferred,
                    IndexSource::from_database(&self.database, 0).unwrap(),
                )
                .unwrap()
                .expect_durable();
            preferred
        }

        fn recover(&self) -> Result<DatabaseDeleteRecovery, Error> {
            let original: Error =
                std::fs::metadata(self.directory.path().join("missing-error-source"))
                    .unwrap_err()
                    .into();
            let state = self.app.state::<AppState>();
            state
                .pgn_path_authority
                .with_mut(|authority| {
                    authority.recover_database_deletion(
                        &self.handle,
                        original,
                        &CancellationToken::new(),
                    )
                })
                .unwrap()
        }
    }

    #[test]
    fn absent_primary_database_delete_prunes_without_sidecars() {
        let case = AbsentPrimaryCase::new();
        std::fs::remove_file(&case.database).unwrap();
        case.delete(&CancellationToken::new()).unwrap();
        case.assert_registered(false);
    }

    #[test]
    fn absent_primary_database_delete_preferred_sidecar_and_truthful_count() {
        for fail_registry in [false, true] {
            let case = AbsentPrimaryCase::new();
            let preferred = case.preferred();
            std::fs::remove_file(&case.database).unwrap();
            let _fault = fail_registry.then(|| {
                install_atomic_export_failure(
                    crate::infra::fs::AtomicFileFaultPoint::TempfileCreate,
                )
            });
            let result = case.delete(&CancellationToken::new());
            if fail_registry {
                assert!(
                    matches!(result, Err(Error::PartialRemoval { removed_entries: 1, cause })
                    if matches!(*cause, Error::Io(_)))
                );
            } else {
                result.unwrap();
            }
            assert!(!preferred.exists());
            case.assert_registered(fail_registry);
        }
    }

    #[test]
    fn absent_primary_database_delete_preserves_legacy_sidecar() {
        let case = AbsentPrimaryCase::new();
        let legacy = legacy_index_path(&case.database);
        SearchIndexChunk::default()
            .write_to_with_source(
                &legacy,
                IndexSource::from_database(&case.database, 0).unwrap(),
            )
            .unwrap()
            .expect_durable();
        let bytes = std::fs::read(&legacy).unwrap();
        std::fs::remove_file(&case.database).unwrap();
        case.delete(&CancellationToken::new()).unwrap();
        assert_eq!(std::fs::read(&legacy).unwrap(), bytes);
        case.assert_registered(false);
    }

    #[test]
    fn absent_primary_database_delete_removes_stamp_and_sqlite_sidecars() {
        let case = AbsentPrimaryCase::new();
        let leaves = [
            search_index::integrity_stamp_leaf(case.database.file_name().unwrap()),
            std::ffi::OsString::from("games.db3-wal"),
            std::ffi::OsString::from("games.db3-shm"),
        ];
        let paths = leaves.map(|leaf| case.database.with_file_name(leaf));
        for path in &paths {
            std::fs::write(path, b"sidecar").unwrap();
        }
        std::fs::remove_file(&case.database).unwrap();
        case.delete(&CancellationToken::new()).unwrap();
        for path in &paths {
            assert!(!path.exists());
        }
        case.assert_registered(false);
    }

    #[test]
    fn absent_primary_database_delete_registry_failure_counts_zero() {
        let case = AbsentPrimaryCase::new();
        std::fs::remove_file(&case.database).unwrap();
        let _fault =
            install_atomic_export_failure(crate::infra::fs::AtomicFileFaultPoint::TempfileCreate);
        assert!(matches!(case.delete(&CancellationToken::new()),
            Err(Error::PartialRemoval { removed_entries: 0, cause })
                if matches!(*cause, Error::Io(_))));
        case.assert_registered(true);
    }

    #[test]
    fn absent_primary_database_delete_missing_parent_keeps_registration() {
        let case = AbsentPrimaryCase::new();
        std::fs::remove_file(&case.database).unwrap();
        std::fs::remove_dir(case.database.parent().unwrap()).unwrap();
        assert!(case
            .delete(&CancellationToken::new())
            .unwrap_err()
            .is_missing_entry());
        case.assert_registered(true);
    }

    #[test]
    fn absent_primary_database_delete_replaced_parent_keeps_old_files() {
        let case = AbsentPrimaryCase::new();
        let preferred = case.preferred();
        let bytes = std::fs::read(&preferred).unwrap();
        std::fs::remove_file(&case.database).unwrap();
        let old = case.directory.path().join("old-parent");
        std::fs::rename(case.database.parent().unwrap(), &old).unwrap();
        std::fs::create_dir(case.database.parent().unwrap()).unwrap();
        std::fs::write(&preferred, b"keep replacement sidecar").unwrap();
        assert!(
            matches!(case.delete(&CancellationToken::new()), Err(Error::Conflict(text))
            if text == "path authority is unavailable because its object changed")
        );
        assert_eq!(
            std::fs::read(old.join(preferred.file_name().unwrap())).unwrap(),
            bytes
        );
        assert_eq!(
            std::fs::read(&preferred).unwrap(),
            b"keep replacement sidecar"
        );
        case.assert_registered(true);
    }

    #[test]
    fn absent_primary_database_delete_unrecorded_parent_keeps_registration() {
        let case = AbsentPrimaryCase::new();
        let preferred = case.preferred();
        let bytes = std::fs::read(&preferred).unwrap();
        let registry_path = case.directory.path().join("registry.json");
        let mut registry: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&registry_path).unwrap()).unwrap();
        for entry in registry["entries"].as_array_mut().unwrap() {
            entry.as_object_mut().unwrap().remove("parent_identity");
        }
        std::fs::write(&registry_path, serde_json::to_vec(&registry).unwrap()).unwrap();
        std::fs::remove_file(&case.database).unwrap();
        let authority = PathAuthority::open(registry_path, vec![]).unwrap();
        case.app
            .state::<AppState>()
            .pgn_path_authority
            .install(authority)
            .unwrap();
        assert!(case
            .app
            .state::<AppState>()
            .pgn_path_authority
            .with_mut(|authority| { authority.parent_identity_for_test(case.handle.path_ref()) })
            .unwrap()
            .is_none());
        assert!(case
            .delete(&CancellationToken::new())
            .unwrap_err()
            .is_missing_entry());
        assert!(case.database.parent().unwrap().is_dir());
        assert_eq!(std::fs::read(&preferred).unwrap(), bytes);
        case.assert_registered(true);
    }

    #[cfg(unix)]
    #[test]
    fn absent_primary_database_delete_parent_permission_denied() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let case = AbsentPrimaryCase::new();
        let preferred = case.preferred();
        let bytes = std::fs::read(&preferred).unwrap();
        std::fs::remove_file(&case.database).unwrap();
        let permissions = crate::infra::path_authority::TestRootPermissionGuard::restrict(
            case.database.parent().unwrap(),
            0o000,
        );
        let _fault = crate::infra::path_authority::install_acquire_target_missing_once();
        let result = case.delete(&CancellationToken::new());
        drop(permissions);
        assert!(matches!(result, Err(Error::Io(error))
            if error.kind() == std::io::ErrorKind::PermissionDenied));
        assert_eq!(std::fs::read(&preferred).unwrap(), bytes);
        case.assert_registered(true);
    }

    #[test]
    fn absent_primary_database_delete_recovery_refuses_changed_leaf() {
        let case = AbsentPrimaryCase::new();
        // Retain the old inode so the replacement cannot reuse its identity.
        std::fs::rename(&case.database, case.database.with_extension("old")).unwrap();
        std::fs::write(&case.database, b"replacement").unwrap();
        assert!(matches!(case.recover(), Err(Error::Conflict(text))
            if text == "workspace entry is unavailable because its object changed"));
        assert_eq!(std::fs::read(&case.database).unwrap(), b"replacement");
        case.assert_registered(true);
    }

    #[test]
    fn absent_primary_database_delete_recovery_refuses_symlink() {
        let case = AbsentPrimaryCase::new();
        let original = case.database.with_extension("old");
        std::fs::rename(&case.database, &original).unwrap();
        symlink(&original, &case.database, false).unwrap();
        assert!(matches!(case.recover(), Err(Error::InvalidInput(_))));
        assert!(case
            .database
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(&original).unwrap(), b"");
        case.assert_registered(true);
    }

    #[test]
    fn absent_primary_database_delete_recovery_reports_present() {
        let case = AbsentPrimaryCase::new();
        assert!(matches!(
            case.recover(),
            Ok(DatabaseDeleteRecovery::Present)
        ));
        assert_eq!(std::fs::read(&case.database).unwrap(), b"");
        case.assert_registered(true);
    }

    #[test]
    fn absent_primary_database_delete_present_falls_through_once() {
        let (directory, app, handle, database) = blocking_database_case();
        let _fault = crate::infra::path_authority::install_acquire_target_missing_once();
        RESOLVE_DATABASE_OPERATIONS.with(|operations| operations.borrow_mut().clear());
        let state = app.state::<AppState>();
        delete_database_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            &CancellationToken::new(),
        )
        .unwrap();
        RESOLVE_DATABASE_OPERATIONS.with(|operations| {
            assert_eq!(*operations.borrow(), vec![PathOperation::DatabaseMutate; 2],)
        });
        assert!(!database.exists());
        assert_database_registry_entry_removed(directory.path(), &handle);
    }

    #[test]
    fn absent_primary_database_delete_cancelled_keeps_registration_and_sidecar() {
        let case = AbsentPrimaryCase::new();
        let preferred = case.preferred();
        let bytes = std::fs::read(&preferred).unwrap();
        std::fs::remove_file(&case.database).unwrap();
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(matches!(
            case.delete(&cancellation),
            Err(Error::Cancellation)
        ));
        assert_eq!(std::fs::read(&preferred).unwrap(), bytes);
        case.assert_registered(true);
    }

    #[test]
    fn absent_primary_database_delete_succeeds_with_empty_collection_service() {
        let case = AbsentPrimaryCase::new();
        case.install_empty_collection_service();
        let preferred = case.preferred();
        std::fs::remove_file(&case.database).unwrap();
        case.delete(&CancellationToken::new()).unwrap();
        assert!(!preferred.exists());
        case.assert_registered(false);
    }

    #[test]
    fn absent_primary_database_delete_rechecks_collection_guard_after_absence() {
        struct HookReset;
        impl Drop for HookReset {
            fn drop(&mut self) {
                ABSENT_PRIMARY_BEFORE_COLLECTION_GUARD.with(|slot| slot.borrow_mut().take());
            }
        }
        let case = AbsentPrimaryCase::new();
        let key = seed_search_cache_for_database(&case.app, &case.database);
        let preferred = get_index_path(&case.database);
        let bytes = std::fs::read(&preferred).unwrap();
        std::fs::remove_file(&case.database).unwrap();
        let state = case.app.state::<AppState>();
        case.install_empty_collection_service();
        let collections = state.pgn_path_authority.collections().unwrap().unwrap();
        let handle = case.handle.clone();
        let ran = std::rc::Rc::new(std::cell::Cell::new(false));
        let ran_hook = ran.clone();
        let _reset = HookReset;
        ABSENT_PRIMARY_BEFORE_COLLECTION_GUARD.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                ran_hook.set(true);
                collections.insert_retired_database_for_test(handle);
            }));
        });
        assert!(
            matches!(case.delete(&CancellationToken::new()), Err(Error::Conflict(text))
            if text == "database is an index or a retired independent copy")
        );
        assert!(ran.get());
        assert_eq!(std::fs::read(&preferred).unwrap(), bytes);
        assert!(state.search_cache.get_result(&key).is_some());
        case.assert_registered(true);
    }
    use std::path::Path;
    use tauri::Manager;

    #[test]
    fn deletion_missing_primary_after_identity_probe_runs_cache_and_registry_cleanup() {
        assert_deletion_missing_primary_after_identity_probe(false);
    }

    #[test]
    fn deletion_missing_primary_before_release_failure_counts_only_removed_sidecars() {
        assert_deletion_missing_primary_after_identity_probe(true);
    }

    fn assert_deletion_missing_primary_after_identity_probe(fail_release: bool) {
        let (dir, app, handle, database) = blocking_database_case();
        let state = app.state::<AppState>();
        let cache_key = seed_search_cache_for_database(&app, &database);
        let index = get_index_path(&database);
        let wal = database.with_extension("db3-wal");
        let shm = database.with_extension("db3-shm");
        std::fs::write(&wal, b"").unwrap();
        std::fs::write(&shm, b"").unwrap();
        assert!(index.exists());
        if fail_release {
            state.database_repository.fail_next_deletion_release();
        }

        let result = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let database_for_hook = database.clone();
                    set_unlink_primary_after_identity_probe_hook(Some(Box::new(move || {
                        std::fs::remove_file(database_for_hook).unwrap();
                    })));
                    delete_database_blocking(
                        &state.pgn_path_authority,
                        &state.database_repository,
                        &state.search_cache,
                        handle.clone(),
                        &CancellationToken::new(),
                    )
                })
                .join()
                .unwrap()
        });
        if fail_release {
            // This call removes the preferred index, WAL and SHM, but not the primary.
            assert!(
                matches!(result, Err(Error::PartialRemoval { removed_entries: 3, cause })
                if matches!(*cause, Error::Conflict(ref message)
                    if message == "injected database deletion release failure"))
            );
        } else {
            assert!(result.is_ok(), "{result:?}");
        }
        assert!(!database.exists());
        assert!(!index.exists());
        assert!(!wal.exists());
        assert!(!shm.exists());
        assert!(state.search_cache.get_result(&cache_key).is_none());
        assert_database_registry_entry_removed(dir.path(), &handle);
    }

    #[test]
    fn deletion_release_failure_counts_primary_index_and_sqlite_sidecars() {
        let (dir, app, handle, database) = blocking_database_case();
        let state = app.state::<AppState>();
        let cache_key = seed_search_cache_for_database(&app, &database);
        let index = get_index_path(&database);
        let wal = database.with_extension("db3-wal");
        let shm = database.with_extension("db3-shm");
        std::fs::write(&wal, b"").unwrap();
        std::fs::write(&shm, b"").unwrap();
        assert!(index.exists());
        state.database_repository.fail_next_deletion_release();

        let result = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    delete_database_blocking(
                        &state.pgn_path_authority,
                        &state.database_repository,
                        &state.search_cache,
                        handle.clone(),
                        &CancellationToken::new(),
                    )
                })
                .join()
                .unwrap()
        });
        // The primary, preferred index, WAL and SHM are the fixture's four entries.
        assert!(
            matches!(result, Err(Error::PartialRemoval { removed_entries: 4, cause })
            if matches!(*cause, Error::Conflict(ref message)
                if message == "injected database deletion release failure"))
        );
        assert!(!database.exists());
        assert!(!index.exists());
        assert!(!wal.exists());
        assert!(!shm.exists());
        assert!(state.search_cache.get_result(&cache_key).is_none());
        assert_database_registry_entry_removed(dir.path(), &handle);
    }

    #[test]
    fn deletion_release_failure_after_primary_runs_cache_and_registry_cleanup() {
        let (dir, app, handle, database) = blocking_database_case();
        let state = app.state::<AppState>();
        let cache_key = seed_search_cache_for_database(&app, &database);
        std::fs::remove_file(get_index_path(&database)).unwrap();
        state.database_repository.fail_next_deletion_release();

        let result = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    delete_database_blocking(
                        &state.pgn_path_authority,
                        &state.database_repository,
                        &state.search_cache,
                        handle.clone(),
                        &CancellationToken::new(),
                    )
                })
                .join()
                .unwrap()
        });
        assert!(
            matches!(result, Err(Error::PartialRemoval { removed_entries: 1, cause })
            if matches!(*cause, Error::Conflict(ref message)
                if message == "injected database deletion release failure"))
        );
        assert!(!database.exists());
        assert!(state.search_cache.get_result(&cache_key).is_none());
        assert_database_registry_entry_removed(dir.path(), &handle);

        // Reusing the same repository proves the failure was one-shot and released the tombstone.
        let mut connection = SqliteConnection::establish(database.to_str().unwrap()).unwrap();
        connection.batch_execute(CREATE_TABLES_SQL).unwrap();
        drop(connection);
        let target = DatabaseFileTarget::for_test_path(&database).unwrap();
        assert!(state
            .database_repository
            .delete_exclusive_cancellable(&target, &CancellationToken::new(), || Ok(()))
            .is_ok());
    }

    struct UnlinkProbeFaultGuard;

    impl UnlinkProbeFaultGuard {
        fn permission_denied(stage: UnlinkProbeStage, leaf: &OsStr) -> Self {
            UNLINK_PROBE_FAULT.with(|slot| {
                *slot.borrow_mut() = Some((
                    stage,
                    leaf.to_os_string(),
                    std::io::ErrorKind::PermissionDenied,
                ));
            });
            Self
        }
    }

    impl Drop for UnlinkProbeFaultGuard {
        fn drop(&mut self) {
            UNLINK_PROBE_FAULT.with(|slot| *slot.borrow_mut() = None);
        }
    }

    #[test]
    fn unlink_database_files_keeps_replacement_database_and_its_preferred_index() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("a.db3");
        let replacement = dir.path().join("b.db3");
        std::fs::write(&database, b"database A").unwrap();
        std::fs::write(&replacement, b"database B").unwrap();
        let expected_source = IndexSource::from_database(&database, 0).unwrap();
        let target = DatabaseFileTarget::for_test_path(&database).unwrap();
        let preferred = get_index_path(&database);
        let replacement_index = get_index_path(&replacement);
        SearchIndexChunk::default()
            .write_to_with_source(&preferred, expected_source.clone())
            .unwrap()
            .expect_durable();
        SearchIndexChunk::default()
            .write_to_with_source(
                &replacement_index,
                IndexSource::from_database(&replacement, 0).unwrap(),
            )
            .unwrap()
            .expect_durable();
        let index_bytes = std::fs::read(&replacement_index).unwrap();
        std::fs::rename(&replacement, &database).unwrap();
        std::fs::rename(&replacement_index, &preferred).unwrap();

        assert!(matches!(unlink_database_files(&target, &expected_source),
            Err(Error::Conflict(message)) if message == "database changed before deletion"));
        assert_eq!(std::fs::read(&database).unwrap(), b"database B");
        assert_eq!(std::fs::read(&preferred).unwrap(), index_bytes);
    }

    #[test]
    fn unlink_database_files_removes_stale_preferred_index_of_the_same_object() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("stale.db3");
        std::fs::write(&database, b"database").unwrap();
        let expected_source = IndexSource::from_database(&database, 2).unwrap();
        let mut stale_source = expected_source.clone();
        stale_source.revision = 1;
        stale_source.database_length += 1;
        let preferred = get_index_path(&database);
        SearchIndexChunk::default()
            .write_to_with_source(&preferred, stale_source)
            .unwrap()
            .expect_durable();
        let target = DatabaseFileTarget::for_test_deletion(&database).unwrap();
        let result = unlink_database_files(&target, &expected_source)
            .unwrap()
            .into_parts();
        assert_eq!(result.0, 2);
        assert!(result.1.is_none());
        assert!(!database.exists());
        assert!(!preferred.exists());
    }

    #[test]
    fn unlink_database_files_conflicts_when_opened_sidecar_identity_differs() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("opened-identity.db3");
        std::fs::write(&database, b"database").unwrap();
        let expected_source = IndexSource::from_database(&database, 0).unwrap();
        let preferred = get_index_path(&database);
        SearchIndexChunk::default()
            .write_to_with_source(&preferred, expected_source.clone())
            .unwrap()
            .expect_durable();
        let database_bytes = std::fs::read(&database).unwrap();
        let index_bytes = std::fs::read(&preferred).unwrap();
        let target = DatabaseFileTarget::for_test_deletion(&database).unwrap();
        set_unlink_probe_opened_identity_mismatch(Some(
            preferred.file_name().unwrap().to_os_string(),
        ));

        assert!(matches!(unlink_database_files(&target, &expected_source),
            Err(Error::Conflict(message)) if message == "index sidecar changed before deletion"));
        assert_eq!(std::fs::read(&database).unwrap(), database_bytes);
        assert_eq!(std::fs::read(&preferred).unwrap(), index_bytes);

        let result = unlink_database_files(&target, &expected_source)
            .unwrap()
            .into_parts();
        assert_eq!(result.0, 2);
        assert!(result.1.is_none());
        assert!(!database.exists());
        assert!(!preferred.exists());
    }

    #[test]
    fn unlink_database_files_removes_malformed_preferred_file() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("malformed.db3");
        std::fs::write(&database, b"database").unwrap();
        let expected_source = IndexSource::from_database(&database, 0).unwrap();
        let preferred = get_index_path(&database);
        std::fs::write(&preferred, b"not an archive").unwrap();
        let target = DatabaseFileTarget::for_test_deletion(&database).unwrap();
        let result = unlink_database_files(&target, &expected_source)
            .unwrap()
            .into_parts();
        assert_eq!(result.0, 2);
        assert!(result.1.is_none());
        assert!(!database.exists());
        assert!(!preferred.exists());
    }

    #[test]
    fn unlink_database_files_removes_preferred_file_with_undecodable_source() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("undecodable.db3");
        std::fs::write(&database, b"database").unwrap();
        let expected_source = IndexSource::from_database(&database, 0).unwrap();
        let preferred = get_index_path(&database);
        SearchIndexChunk::default()
            .write_to_with_source(&preferred, expected_source.clone())
            .unwrap()
            .expect_durable();
        let mut bytes = std::fs::read(&preferred).unwrap();
        // In-bounds and aligned, but too short to contain an archived IndexSource.
        bytes[8..16].copy_from_slice(&16_u64.to_le_bytes());
        std::fs::write(&preferred, bytes).unwrap();
        let target = DatabaseFileTarget::for_test_deletion(&database).unwrap();
        let result = unlink_database_files(&target, &expected_source)
            .unwrap()
            .into_parts();
        assert_eq!(result.0, 2);
        assert!(result.1.is_none());
        assert!(!database.exists());
        assert!(!preferred.exists());
    }

    #[test]
    fn unlink_database_files_keeps_colliding_foreign_preferred_index() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("foo.db3");
        let owner = dir.path().join("foo.db3.bak");
        std::fs::write(&database, b"database").unwrap();
        std::fs::write(&owner, b"backup").unwrap();
        let preferred = get_index_path(&database);
        assert_eq!(preferred, legacy_index_path(&owner));
        SearchIndexChunk::default()
            .write_to_with_source(&preferred, IndexSource::from_database(&owner, 0).unwrap())
            .unwrap()
            .expect_durable();
        let bytes = std::fs::read(&preferred).unwrap();
        let expected_source = IndexSource::from_database(&database, 0).unwrap();
        let target = DatabaseFileTarget::for_test_deletion(&database).unwrap();
        let result = unlink_database_files(&target, &expected_source)
            .unwrap()
            .into_parts();
        assert_eq!(result.0, 1);
        assert!(result.1.is_none());
        assert!(!database.exists());
        assert_eq!(std::fs::read(&preferred).unwrap(), bytes);
    }

    #[test]
    fn unlink_database_files_keeps_permission_denied_sidecars_at_every_probe_stage() {
        for stage in [
            UnlinkProbeStage::Identity,
            UnlinkProbeStage::ReadOpen,
            UnlinkProbeStage::OpenedIdentity,
            UnlinkProbeStage::SourceRead,
        ] {
            for preferred in [true, false] {
                let dir = tempfile::tempdir().unwrap();
                let database = dir.path().join("permission.db3");
                std::fs::write(&database, b"database").unwrap();
                let source = IndexSource::from_database(&database, 0).unwrap();
                let sidecar = if preferred {
                    get_index_path(&database)
                } else {
                    legacy_index_path(&database)
                };
                SearchIndexChunk::default()
                    .write_to_with_source(&sidecar, source.clone())
                    .unwrap()
                    .expect_durable();
                let bytes = std::fs::read(&sidecar).unwrap();
                let target = DatabaseFileTarget::for_test_deletion(&database).unwrap();
                let _fault =
                    UnlinkProbeFaultGuard::permission_denied(stage, sidecar.file_name().unwrap());
                let result =
                    unlink_database_files(&target, &source).map(CommittedRemoval::into_parts);
                assert!(
                    UNLINK_PROBE_FAULT.with(|slot| slot.borrow().is_none()),
                    "{stage:?}, preferred={preferred}"
                );
                assert!(
                    matches!(result, Ok((1, None))),
                    "{stage:?}, preferred={preferred}: {result:?}"
                );
                assert!(!database.exists());
                assert_eq!(std::fs::read(&sidecar).unwrap(), bytes);
            }
        }
    }

    #[test]
    fn unlink_database_files_removes_matching_legacy_index_with_corrupt_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("corrupt-chunks.db3");
        std::fs::write(&database, b"database").unwrap();
        let source = IndexSource::from_database(&database, 0).unwrap();
        let legacy = legacy_index_path(&database);
        SearchIndexChunk::default()
            .write_to_with_source(&legacy, source.clone())
            .unwrap()
            .expect_durable();
        let mut bytes = std::fs::read(&legacy).unwrap();
        bytes[24..32].copy_from_slice(&1_u64.to_le_bytes());
        bytes.extend_from_slice(&[0; 32]);
        std::fs::write(&legacy, bytes).unwrap();
        assert!(MmapSearchIndex::open_file(File::open(&legacy).unwrap()).is_err());
        let target = DatabaseFileTarget::for_test_deletion(&database).unwrap();
        let result = unlink_database_files(&target, &source)
            .unwrap()
            .into_parts();
        assert_eq!(result.0, 2);
        assert!(result.1.is_none());
        assert!(!database.exists());
        assert!(!legacy.exists());
    }

    #[test]
    fn unlink_database_files_counts_stamp_without_consuming_index_probe_hook() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("stamp-hook.db3");
        std::fs::write(&database, b"database").unwrap();
        let source = IndexSource::from_database(&database, 0).unwrap();
        let legacy = legacy_index_path(&database);
        SearchIndexChunk::default()
            .write_to_with_source(&legacy, source.clone())
            .unwrap()
            .expect_durable();
        let target = DatabaseFileTarget::for_test_deletion(&database).unwrap();
        let stamp = database.with_file_name(search_index::integrity_stamp_leaf(target.leaf()));
        std::fs::write(&stamp, b"stamp").unwrap();
        let stamp_for_hook = stamp.clone();
        let legacy_for_hook = legacy.clone();
        set_unlink_sidecar_after_identity_probe_hook(Some(Box::new(move || {
            assert!(
                !stamp_for_hook.exists(),
                "stamp removal precedes the legacy probe hook"
            );
            assert!(legacy_for_hook.exists());
        })));
        let result = unlink_database_files(&target, &source)
            .unwrap()
            .into_parts();
        assert_eq!(result.0, 3);
        assert!(result.1.is_none());
        assert!(!database.exists());
        assert!(!legacy.exists());
        assert!(!stamp.exists());
    }

    fn symlink(target: &Path, link: &Path, target_is_dir: bool) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            let _ = target_is_dir;
            std::os::unix::fs::symlink(target, link)
        }
        #[cfg(windows)]
        {
            if target_is_dir {
                std::os::windows::fs::symlink_dir(target, link)
            } else {
                std::os::windows::fs::symlink_file(target, link)
            }
        }
    }

    /// A linked ancestor is accepted on every platform because `acquire_target` canonicalises
    /// the parent before its no-follow proof; the grant, index and deletion use the real directory.
    fn assert_linked_ancestor_database_indexes_and_deletes(
        link_directory: impl FnOnce(&Path, &Path),
    ) {
        let dir = tempfile::tempdir().unwrap();
        let real_dir = dir.path().join("real");
        let link_dir = dir.path().join("link");
        let database = real_dir.join("games.db3");
        let registered_path = link_dir.join("games.db3");
        std::fs::create_dir(&real_dir).unwrap();
        File::create(&database).unwrap();
        let mut connection = SqliteConnection::establish(database.to_str().unwrap()).unwrap();
        connection.batch_execute(CREATE_TABLES_SQL).unwrap();
        connection
            .batch_execute("INSERT INTO Info (Name, Value) VALUES ('Version', '2.0.0');")
            .unwrap();
        connection.batch_execute(
            "INSERT INTO Games (ID, Result, Moves, PawnHome, WhiteMaterial, BlackMaterial) VALUES (1, '*', X'', 0, 0, 0);"
        ).unwrap();
        drop(connection);
        link_directory(&real_dir, &link_dir);

        let (app, handle) = database_app_with_grant(
            dir.path(),
            &registered_path,
            "games",
            full_database_operations(),
        );
        let state = app.state::<AppState>();

        let resolved = resolve_database(
            &state.pgn_path_authority,
            &handle,
            PathOperation::DatabaseRead,
        )
        .unwrap();
        assert_eq!(resolved.path(), database.canonicalize().unwrap());

        generate_search_index(
            &handle,
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &CancellationToken::new(),
        )
        .unwrap();
        let sidecar = database.with_file_name("games.db3.ecsi");
        assert!(sidecar.exists());
        let expected = state
            .database_repository
            .database_identity(&test_target(&database))
            .unwrap();
        let source = IndexSource::from_database_identity(&expected).unwrap();
        assert_eq!(
            source.object,
            IndexSource::from_database(&database, expected.data_revision)
                .unwrap()
                .object
        );

        let (_, index) = search::load_search_index_cancellable(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            &handle,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(index.source().object, source.object);
        let first_id = index.get_entry_ref(0).unwrap().id;
        // The reader retains its generation across the production unlink on every platform.

        delete_database_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle,
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(!database.exists());
        assert!(!sidecar.exists());
        assert_eq!(index.get_entry_ref(0).unwrap().id, first_id);
    }

    #[test]
    fn symlinked_ancestor_database_indexes_and_deletes_through_its_real_directory() {
        assert_linked_ancestor_database_indexes_and_deletes(|target, link| {
            symlink(target, link, true).unwrap();
        });
    }

    #[cfg(windows)]
    #[test]
    fn junction_ancestor_database_indexes_and_deletes_through_its_real_directory() {
        assert_linked_ancestor_database_indexes_and_deletes(|target, link| {
            crate::infra::fs::windows_test_junction(link, target);
        });
    }

    #[test]
    fn delete_database_uses_fd_relative_target_and_outcome_mapper() {
        let source = include_str!("mod.rs");
        let body = source
            .split("fn delete_database_blocking")
            .nth(1)
            .unwrap()
            .split("\n}\n")
            .next()
            .unwrap();
        assert!(body.contains("CommittedRemoval"));
        assert!(body.contains("committed_removal.finish()"));
        assert!(body.contains("resolve_database("));
        assert!(!body.contains("database_file_target("));
        assert!(!body.contains("database_path("));
        assert!(!body.contains("workspace_entry_path("));
        assert!(!body.contains("canonicalize("));
        assert!(body.contains("target.path()"));
        assert!(!body.contains("remove_file"));
    }

    #[test]
    fn delete_database_stops_at_invalid_preferred_sidecar_before_primary() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("ordered.db3");
        std::fs::write(&database, b"database").unwrap();
        let expected_source = IndexSource::from_database(&database, 0).unwrap();
        std::fs::create_dir(get_index_path(&database)).unwrap();
        let target = DatabaseFileTarget::for_test_path(&database).unwrap();

        let error = unlink_database_files(&target, &expected_source).unwrap_err();
        assert!(matches!(error, Error::InvalidInput(_)));
        assert!(database.exists());
    }

    #[test]
    fn delete_database_leaves_colliding_legacy_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let collision_owner = dir.path().join("foo");
        let database = dir.path().join("foo.db3");
        std::fs::write(&collision_owner, b"database").unwrap();
        std::fs::write(&database, b"database").unwrap();
        let shared_sidecar = get_index_path(&collision_owner);
        assert_eq!(shared_sidecar, legacy_index_path(&database));
        SearchIndexChunk::default()
            .write_to_with_source(
                &shared_sidecar,
                IndexSource::from_database(&collision_owner, 0).unwrap(),
            )
            .unwrap()
            .expect_durable();
        let expected_source = IndexSource::from_database(&database, 0).unwrap();
        let target = DatabaseFileTarget::for_test_path(&database).unwrap();

        assert_eq!(
            unlink_database_files(&target, &expected_source)
                .unwrap()
                .into_parts()
                .0,
            1
        );
        assert!(!database.exists());
        assert!(shared_sidecar.exists());
    }

    #[test]
    fn unlink_database_files_skips_duplicate_legacy_leaf_on_extensionless_names() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("foo");
        std::fs::write(&database, b"database").unwrap();
        let expected_source = IndexSource::from_database(&database, 0).unwrap();
        let preferred = get_index_path(&database);
        assert_eq!(preferred, legacy_index_path(&database));
        SearchIndexChunk::default()
            .write_to_with_source(&preferred, expected_source.clone())
            .unwrap()
            .expect_durable();
        let target = DatabaseFileTarget::for_test_path(&database).unwrap();

        assert_eq!(
            unlink_database_files(&target, &expected_source)
                .unwrap()
                .into_parts()
                .0,
            2
        );
        assert!(!database.exists());
        assert!(!preferred.exists());
    }

    #[test]
    fn unlink_database_files_rejects_a_substituted_primary() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("swap.db3");
        std::fs::write(&database, b"database").unwrap();
        let expected_source = IndexSource::from_database(&database, 0).unwrap();
        let target = DatabaseFileTarget::for_test_path(&database).unwrap();
        std::fs::remove_file(&database).unwrap();
        std::fs::create_dir(&database).unwrap();

        let error = unlink_database_files(&target, &expected_source).unwrap_err();
        assert!(matches!(error, Error::Conflict(_)));
        assert!(database.is_dir());
    }

    #[test]
    fn unlink_database_files_rejects_an_identity_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("mismatch.db3");
        let replacement = dir.path().join("replacement.db3");
        std::fs::write(&database, b"database").unwrap();
        std::fs::write(&replacement, b"replacement").unwrap();
        let expected_source = IndexSource::from_database(&database, 0).unwrap();
        let target = DatabaseFileTarget::for_test_path(&database).unwrap();
        std::fs::rename(&replacement, &database).unwrap();

        let error = unlink_database_files(&target, &expected_source).unwrap_err();
        assert!(matches!(
            error,
            Error::Conflict(message) if message == "database changed before deletion"
        ));
        assert!(database.exists());
    }

    #[test]
    fn unlink_database_files_skips_a_legacy_directory() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("legacy-dir.db3");
        std::fs::write(&database, b"database").unwrap();
        std::fs::create_dir(legacy_index_path(&database)).unwrap();
        let expected_source = IndexSource::from_database(&database, 0).unwrap();
        let target = DatabaseFileTarget::for_test_path(&database).unwrap();

        assert_eq!(
            unlink_database_files(&target, &expected_source)
                .unwrap()
                .into_parts()
                .0,
            1
        );
        assert!(!database.exists());
        assert!(legacy_index_path(&database).is_dir());
    }

    #[test]
    fn unlink_database_files_rechecks_preferred_sidecar_identity_and_ignores_vanishing_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("preferred-swap.db3");
        std::fs::write(&database, b"database").unwrap();
        let preferred = get_index_path(&database);
        SearchIndexChunk::default()
            .write_to_with_source(
                &preferred,
                IndexSource::from_database(&database, 0).unwrap(),
            )
            .unwrap()
            .expect_durable();
        let preferred_replacement = dir.path().join("preferred-replacement");
        std::fs::write(&preferred_replacement, b"replacement").unwrap();
        let target = DatabaseFileTarget::for_test_path(&database).unwrap();
        let preferred_for_hook = preferred.clone();
        let preferred_replacement_for_hook = preferred_replacement.clone();
        set_unlink_sidecar_after_identity_probe_hook(Some(Box::new(move || {
            std::fs::remove_file(&preferred_for_hook).unwrap();
            std::fs::rename(&preferred_replacement_for_hook, &preferred_for_hook).unwrap();
        })));

        let error =
            unlink_database_files(&target, &IndexSource::from_database(&database, 0).unwrap())
                .unwrap_err();
        assert!(matches!(error, Error::Conflict(_)));
        assert_eq!(std::fs::read(&preferred).unwrap(), b"replacement");
        assert!(database.exists());

        let vanished_database = dir.path().join("vanished.db3");
        std::fs::write(&vanished_database, b"database").unwrap();
        let vanished_source = IndexSource::from_database(&vanished_database, 0).unwrap();
        let vanished_preferred = get_index_path(&vanished_database);
        std::fs::write(&vanished_preferred, b"sidecar").unwrap();
        let vanished_target = DatabaseFileTarget::for_test_path(&vanished_database).unwrap();
        std::fs::remove_file(&vanished_preferred).unwrap();

        let result = unlink_database_files(&vanished_target, &vanished_source)
            .unwrap()
            .into_parts();
        assert_eq!(result.0, 1);
        assert!(!vanished_database.exists());
    }

    #[test]
    fn legacy_sidecar_removal_uses_the_verified_identity_and_skips_corrupt_archives() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("legacy-swap.db3");
        std::fs::write(&database, b"database").unwrap();
        let expected_source = IndexSource::from_database(&database, 0).unwrap();
        let legacy = legacy_index_path(&database);
        SearchIndexChunk::default()
            .write_to_with_source(&legacy, expected_source.clone())
            .unwrap()
            .expect_durable();
        let legacy_replacement = dir.path().join("legacy-replacement");
        std::fs::write(&legacy_replacement, b"replacement").unwrap();
        let target = DatabaseFileTarget::for_test_path(&database).unwrap();
        let legacy_for_hook = legacy.clone();
        let legacy_replacement_for_hook = legacy_replacement.clone();
        set_unlink_sidecar_after_identity_probe_hook(Some(Box::new(move || {
            std::fs::remove_file(&legacy_for_hook).unwrap();
            std::fs::rename(&legacy_replacement_for_hook, &legacy_for_hook).unwrap();
        })));

        let error = unlink_database_files(&target, &expected_source).unwrap_err();
        assert!(matches!(error, Error::Conflict(_)));
        assert_eq!(std::fs::read(&legacy).unwrap(), b"replacement");
        assert!(database.exists());

        let corrupt_database = dir.path().join("legacy-corrupt.db3");
        std::fs::write(&corrupt_database, b"database").unwrap();
        let corrupt_source = IndexSource::from_database(&corrupt_database, 0).unwrap();
        let corrupt_legacy = legacy_index_path(&corrupt_database);
        std::fs::write(&corrupt_legacy, b"corrupt archive").unwrap();
        let corrupt_target = DatabaseFileTarget::for_test_path(&corrupt_database).unwrap();

        let result = unlink_database_files(&corrupt_target, &corrupt_source)
            .unwrap()
            .into_parts();
        assert_eq!(result.0, 1);
        assert!(!corrupt_database.exists());
        assert!(corrupt_legacy.exists());
    }

    #[test]
    fn zero_table_delete_removes_database_and_sqlite_sidecars() {
        let (_dir, app, handle, database) = arbitrary_database_case(b"");
        {
            let mut connection = SqliteConnection::establish(database.to_str().unwrap()).unwrap();
            connection.batch_execute("VACUUM;").unwrap();
            #[derive(QueryableByName)]
            struct TableCount {
                #[diesel(sql_type = diesel::sql_types::BigInt)]
                count: i64,
            }
            let tables =
                sql_query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'")
                    .get_result::<TableCount>(&mut connection)
                    .unwrap();
            assert_eq!(tables.count, 0);
        }
        assert_eq!(
            &std::fs::read(&database).unwrap()[..16],
            b"SQLite format 3\0"
        );
        let wal = database.with_extension("db3-wal");
        let shm = database.with_extension("db3-shm");
        std::fs::write(&wal, b"").unwrap();
        std::fs::write(&shm, b"").unwrap();
        assert!(wal.exists());
        assert!(shm.exists());
        let state = app.state::<AppState>();
        delete_database_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(!database.exists());
        assert!(!wal.exists());
        assert!(!shm.exists());
        assert!(resolve_database(
            &state.pgn_path_authority,
            &handle,
            PathOperation::DatabaseRead
        )
        .is_err());
    }

    #[test]
    fn unlink_database_files_preserves_sqlite_sidecars_after_primary_substitution() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("swap.db3");
        let replacement = dir.path().join("replacement.db3");
        let wal = database.with_extension("db3-wal");
        let shm = database.with_extension("db3-shm");
        std::fs::write(&database, b"database").unwrap();
        std::fs::write(&replacement, b"replacement").unwrap();
        let expected_source = IndexSource::from_database(&database, 0).unwrap();
        let target = DatabaseFileTarget::for_test_path(&database).unwrap();
        std::fs::rename(&replacement, &database).unwrap();
        std::fs::write(&wal, b"committed replacement WAL").unwrap();
        std::fs::write(&shm, b"replacement shared memory").unwrap();

        let error = unlink_database_files(&target, &expected_source).unwrap_err();
        assert!(matches!(error, Error::Conflict(_)));
        assert_eq!(std::fs::read(&database).unwrap(), b"replacement");
        assert!(wal.exists());
        assert_eq!(std::fs::read(&wal).unwrap(), b"committed replacement WAL");
        assert!(shm.exists());
    }

    #[test]
    fn zero_table_delete_sidecar_failure_reports_partial_removal_and_cleans_up() {
        assert_zero_table_delete_sidecar_failure(false);
    }

    #[test]
    fn zero_table_delete_sidecar_and_registry_cleanup_failures_log_partial_removal() {
        assert_zero_table_delete_sidecar_failure(true);
    }

    fn assert_zero_table_delete_sidecar_failure(fail_registry_cleanup: bool) {
        let (dir, app, handle, database) = arbitrary_database_case(b"");
        {
            let mut connection = SqliteConnection::establish(database.to_str().unwrap()).unwrap();
            connection.batch_execute("VACUUM;").unwrap();
        }
        let cache_key = seed_search_cache_for_database(&app, &database);
        // Keep the hook for the SQLite sidecar, rather than the preferred index.
        std::fs::remove_file(get_index_path(&database)).unwrap();
        let wal = database.with_extension("db3-wal");
        let replacement = dir.path().join("replacement-wal");
        std::fs::write(&wal, b"").unwrap();
        std::fs::write(&replacement, b"keep replacement WAL").unwrap();
        let registry_path = dir.path().join("registry.json");
        let registry: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&registry_path).unwrap()).unwrap();
        let database_id = &handle.path_ref().id;
        assert!(registry["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"]["id"] == *database_id));

        let database_for_hook = database.clone();
        let wal_for_hook = wal.clone();
        set_unlink_sidecar_after_identity_probe_hook(Some(Box::new(move || {
            assert!(
                !database_for_hook.exists(),
                "the primary must be gone before unlinking SQLite sidecars"
            );
            std::fs::rename(&replacement, &wal_for_hook).unwrap();
        })));
        let capture = crate::error::LogCaptureScope::start();
        let _atomic = fail_registry_cleanup.then(|| {
            install_atomic_export_failure(crate::infra::fs::AtomicFileFaultPoint::TempfileCreate)
        });
        let state = app.state::<AppState>();
        let result = delete_database_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            &CancellationToken::new(),
        );
        assert!(matches!(
            result,
            Err(Error::PartialRemoval { removed_entries: 1, cause })
                if matches!(*cause, Error::Conflict(_))
        ));
        assert!(!database.exists());
        assert_eq!(std::fs::read(&wal).unwrap(), b"keep replacement WAL");
        assert!(state.search_cache.get_result(&cache_key).is_none());
        let registry: serde_json::Value =
            serde_json::from_slice(&std::fs::read(registry_path).unwrap()).unwrap();
        assert_eq!(
            registry["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["id"]["id"] == *database_id),
            fail_registry_cleanup
        );
        let records = capture.records();
        assert!(records.iter().any(|record| {
            record.level == log::Level::Warn
                && record.message.contains(&format!(
                    "database SQLite sidecar removal failed after primary deletion for {}:",
                    wal.file_name().unwrap().to_string_lossy()
                ))
                && record.message.contains("Conflict: ")
        }));
        if fail_registry_cleanup {
            let warning = records
                .iter()
                .find(|record| {
                    record.level == log::Level::Warn
                        && record
                            .message
                            .contains("database registry cleanup failed after")
                })
                .expect("registry cleanup failure must be logged");
            assert!(warning.message.contains("after partial removal"));
            assert!(!warning.message.contains("durability uncertainty"));
            assert!(warning
                .message
                .contains("I/O failure: injected TempfileCreate failure"));
        }
    }

    #[test]
    fn delete_database_junk_file_still_unlinks() {
        let (_dir, app, handle, database) = arbitrary_database_case(b"junk file");
        let state = app.state::<AppState>();
        delete_database_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle,
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(!database.exists());
    }

    #[test]
    fn zero_table_delete_refuses_symlinked_sqlite_sidecars() {
        for suffix in ["-wal", "-shm"] {
            let (dir, app, handle, database) = arbitrary_database_case(b"");
            {
                let mut connection =
                    SqliteConnection::establish(database.to_str().unwrap()).unwrap();
                connection.batch_execute("VACUUM;").unwrap();
            }
            let foreign_file = dir.path().join("foreign-file");
            std::fs::write(&foreign_file, b"keep me").unwrap();
            let sidecar = database.with_file_name(format!("arbitrary.db3{suffix}"));
            symlink(&foreign_file, &sidecar, false).unwrap();
            let state = app.state::<AppState>();
            let result = delete_database_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                handle,
                &CancellationToken::new(),
            );
            assert!(result.is_err());
            assert!(database.exists());
            assert!(sidecar.symlink_metadata().unwrap().file_type().is_symlink());
            assert_eq!(std::fs::read(&foreign_file).unwrap(), b"keep me");
        }
    }

    #[test]
    fn delete_database_malformed_revision_does_not_unlink() {
        let (_dir, app, handle, database) = blocking_database_case();
        let state = app.state::<AppState>();
        let mut db = state
            .database_repository
            .connection(&test_target(&database), None)
            .unwrap();
        sql_query("INSERT INTO Info (Name, Value) VALUES ('DataRevision', 'malformed')")
            .execute(&mut *db)
            .unwrap();
        drop(db);
        let result = delete_database_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle,
            &CancellationToken::new(),
        );
        assert!(
            matches!(result, Err(Error::InvalidInput(message)) if message == "DataRevision is not a non-negative i64")
        );
        assert!(database.exists());
    }

    #[test]
    fn delete_database_busy_does_not_unlink() {
        let (_dir, app, handle, database) = blocking_database_case();
        let mut blocker = SqliteConnection::establish(database.to_str().unwrap()).unwrap();
        blocker.batch_execute("BEGIN EXCLUSIVE;").unwrap();
        let state = app.state::<AppState>();
        let result = delete_database_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle,
            &CancellationToken::new(),
        );
        let _ = blocker.batch_execute("ROLLBACK;");
        assert!(result.is_err());
        assert!(database.exists());
    }

    #[test]
    fn delete_database_io_error_does_not_unlink() {
        let (_dir, app, handle, database) = blocking_database_case();
        std::fs::remove_file(&database).unwrap();
        std::fs::create_dir(&database).unwrap();
        let state = app.state::<AppState>();
        let result = delete_database_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle,
            &CancellationToken::new(),
        );
        assert!(result.is_err());
        assert!(database.is_dir());
    }

    #[test]
    fn delete_database_removes_legacy_sidecar_at_revision_1() {
        let (_dir, app, handle, database) = blocking_database_case();
        let state = app.state::<AppState>();
        {
            let mut db = state
                .database_repository
                .initialization_connection(&test_target(&database), None)
                .unwrap();
            db.transaction::<_, Error, _>(|db| {
                bump_revision_in_transaction(db, &database, &CancellationToken::new(), |_| Ok(()))
            })
            .unwrap();
        }
        let identity = state
            .database_repository
            .database_identity(&test_target(&database))
            .unwrap();
        let legacy = legacy_index_path(&database);
        SearchIndexChunk::default()
            .write_to_with_source(
                &legacy,
                IndexSource::from_database_identity(&identity).unwrap(),
            )
            .unwrap()
            .expect_durable();
        delete_database_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle,
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(!database.exists());
        assert!(!legacy.exists());
    }
}

#[cfg(test)]
mod index_cancellation_tests {
    use super::*;
    use crate::infra::cancellable_lock::observe_lock_wait;
    use std::{sync::atomic::Ordering, time::Duration};

    #[derive(Debug, PartialEq, Eq, QueryableByName)]
    pub(super) struct IndexDefinition {
        #[diesel(sql_type = diesel::sql_types::Text)]
        name: String,
        #[diesel(sql_type = diesel::sql_types::Text)]
        tbl_name: String,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
        sql: Option<String>,
    }

    pub(super) fn index_list(connection: &mut SqliteConnection) -> Vec<IndexDefinition> {
        sql_query(
            "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' ORDER BY name",
        )
        .load(connection)
        .unwrap()
    }

    fn snapshot(state: &AppState, handle: &DatabaseHandle) -> (bool, Vec<IndexDefinition>) {
        let target = resolve_database(
            &state.pgn_path_authority,
            handle,
            PathOperation::DatabaseMutate,
        )
        .unwrap();
        let mut connection = get_db_or_create(
            &state.database_repository,
            &target,
            None,
            &state.pgn_path_authority,
            handle,
        )
        .unwrap();
        (
            check_index_exists(&mut connection).unwrap(),
            index_list(&mut connection),
        )
    }

    fn run(
        state: &AppState,
        handle: DatabaseHandle,
        create: bool,
        token: &CancellationToken,
    ) -> Result<(), Error> {
        if create {
            create_indexes_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                token,
            )
        } else {
            delete_indexes_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle,
                token,
            )
        }
    }

    fn ddl_cancel_case(create: bool, wrong_definition: bool) {
        let (_directory, app, handle, _path) = blocking_database_case();
        let state = app.state::<AppState>();
        if !create {
            run(&state, handle.clone(), true, &CancellationToken::new()).unwrap();
        } else if wrong_definition {
            let target = resolve_database(
                &state.pgn_path_authority,
                &handle,
                PathOperation::DatabaseMutate,
            )
            .unwrap();
            let mut connection = get_db_or_create(
                &state.database_repository,
                &target,
                None,
                &state.pgn_path_authority,
                &handle,
            )
            .unwrap();
            connection
                .batch_execute("CREATE INDEX games_date_idx ON Games(Result)")
                .unwrap();
        }
        let before = snapshot(&state, &handle);
        assert_eq!(before.0, !create);
        let token = CancellationToken::new();
        let observed = sqlite_cancellation::cancel_on_scoped_callback(token.clone(), 5);
        let result = run(&state, handle.clone(), create, &token);
        // A plain transaction never arms the hook; clear it even on that mutation path.
        sqlite_cancellation::set_callback_hook(|| {});
        assert!(
            observed.load(Ordering::SeqCst) >= 5,
            "cancellation must occur inside the DDL body"
        );
        assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
        assert_eq!(snapshot(&state, &handle), before);
        run(&state, handle.clone(), create, &CancellationToken::new()).unwrap();
        assert_eq!(snapshot(&state, &handle).0, create);
    }

    #[test]
    fn create_ddl_cancel_restores_absent_indexes_and_recovers() {
        ddl_cancel_case(true, false);
    }

    #[test]
    fn create_ddl_cancel_restores_wrong_definition_and_recovers() {
        ddl_cancel_case(true, true);
    }

    #[test]
    fn delete_ddl_cancel_restores_complete_indexes_and_recovers() {
        ddl_cancel_case(false, false);
    }

    fn lock_cancel_case(create: bool) {
        let (_directory, app, handle, _path) = blocking_database_case();
        let state = app.state::<AppState>();
        if !create {
            run(&state, handle.clone(), true, &CancellationToken::new()).unwrap();
        }
        let before = snapshot(&state, &handle);
        let target = resolve_database(
            &state.pgn_path_authority,
            &handle,
            PathOperation::DatabaseMutate,
        )
        .unwrap();
        let lock = state
            .database_repository
            .index_lock_for_test(&target)
            .unwrap();
        let held = lock.lock();
        let entered = observe_lock_wait(&lock);
        let token = CancellationToken::new();
        let worker_token = token.clone();
        let worker_app = app.clone();
        let worker_handle = handle.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = run(
                &worker_app.state::<AppState>(),
                worker_handle,
                create,
                &worker_token,
            );
            done_tx.send(result).unwrap();
        });
        let waited = entered.recv_timeout(Duration::from_secs(5));
        token.cancel();
        let result = done_rx.recv_timeout(Duration::from_secs(5));
        drop(held);
        worker.join().unwrap();
        waited.expect("worker must enter the entry's index-lock wait");
        assert!(matches!(result.unwrap(), Err(Error::Cancellation)));
        assert_eq!(snapshot(&state, &handle), before);
    }

    #[test]
    fn create_lock_wait_cancel_preserves_indexes() {
        lock_cancel_case(true);
    }

    #[test]
    fn delete_lock_wait_cancel_preserves_indexes() {
        lock_cancel_case(false);
    }

    async fn shutdown_cancel_case(create: bool) {
        let (_directory, app, handle, _path) = blocking_database_case();
        let state = app.state::<AppState>();
        if !create {
            run(&state, handle.clone(), true, &CancellationToken::new()).unwrap();
        }
        let before = snapshot(&state, &handle);
        let target = resolve_database(
            &state.pgn_path_authority,
            &handle,
            PathOperation::DatabaseMutate,
        )
        .unwrap();
        let lock = state
            .database_repository
            .index_lock_for_test(&target)
            .unwrap();
        let entered = observe_lock_wait(&lock);
        let holder_lock = Arc::clone(&lock);
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _held = holder_lock.lock();
            held_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        });
        held_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let worker_app = app.clone();
        let worker_handle = handle.clone();
        let mut command = tokio::spawn(async move {
            if create {
                create_indexes(worker_handle, worker_app.state::<AppState>()).await
            } else {
                delete_indexes(worker_handle, worker_app.state::<AppState>()).await
            }
        });
        let waited = entered.recv_timeout(Duration::from_secs(5));
        state.operations.seal_and_request_cancellation().unwrap();
        let result = tokio::time::timeout(Duration::from_secs(2), &mut command).await;
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        if result.is_err() {
            command.await.unwrap().unwrap();
        }
        waited.expect("async command must enter the entry's index-lock wait");
        assert!(matches!(
            result
                .expect("shutdown must cancel the blocked worker")
                .unwrap(),
            Err(Error::Cancellation)
        ));
        assert_eq!(snapshot(&state, &handle), before);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_command_shutdown_cancel_reaches_worker() {
        shutdown_cancel_case(true).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delete_command_shutdown_cancel_reaches_worker() {
        shutdown_cancel_case(false).await;
    }
}
