#[cfg(test)]
use crate::infra::path_authority::PathAuthority;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{BufRead, BufReader, Cursor, Read},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, OnceLock,
    },
    time::Instant,
};

use dashmap::DashMap;
use log::{error, info, warn};
use pgn_reader::{BufferedReader, RawHeader, Skip, Visitor};
use polyglot_book_rs::polyglot_hash_from_fen;
use rand::Rng;
use serde::{Deserialize, Serialize};
use shakmaty::{
    fen::Fen, san::SanPlus, uci::UciMove, CastlingMode, Chess, Color, EnPassantMode, Position,
};
use specta::Type;
use tauri::{AppHandle, Runtime};
use tauri_specta::Event;
use tokio::{
    sync::{watch, Mutex, OwnedSemaphorePermit, RwLock, Semaphore},
    time::{interval, Duration},
};
use tokio_util::sync::CancellationToken;

use crate::{
    cancellable_read::{map_read_error, CancellableRead},
    engine::{
        log_registration_cleanup_error, parse_fen_to_position, resolve_launch, spawn_registered,
        verify_option_resources, AdmissionLease, EngineActor, EngineDeadlines, EngineKey,
        EngineLog, EngineOption, EngineSupervisor, EngineTerminalSnapshot, GoMode, PlayersTime,
        RegistrationGuard, ResolvedEngineOption, MAX_ENGINE_LIMIT,
    },
    error::Error,
    infra::blocking::BLOCKING_GATEWAY,
    infra::keyed_locks::{KeyedLockLease, KeyedLocks},
    infra::path_authority::{EngineExecutable, EngineHandle, OpeningBookHandle, PathOperation},
};

#[cfg(all(test, unix))]
use crate::engine::resolve_engine_option_leases;

pub type GameId = String;

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PlayerConfig {
    Human {
        name: String,
    },
    Engine {
        name: String,
        #[serde(rename = "engineId")]
        engine_id: String,
        handle: EngineHandle,
        #[serde(default)]
        options: Vec<EngineOption>,
        go: Option<GoMode>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TimeControl {
    pub initial_time: u64,
    pub increment: u64,
}

// Sub-second clocks flag on the first ~100 ms tick before a human can move, and settle_active_clock flags before any increment, so increment-only controls are unsupported.
const MIN_INITIAL_TIME_MS: u64 = 1_000;

fn validate_time_controls(config: &GameConfig) -> Result<(), Error> {
    let (Some(white), Some(black)) = (&config.white_time_control, &config.black_time_control)
    else {
        return if config.white_time_control.is_none() && config.black_time_control.is_none() {
            Ok(())
        } else {
            Err(Error::InvalidInput(
                "both players must provide a time control".into(),
            ))
        };
    };
    let max = u64::from(MAX_ENGINE_LIMIT);
    for (name, value) in [
        ("white initial time", white.initial_time),
        ("black initial time", black.initial_time),
        ("white increment", white.increment),
        ("black increment", black.increment),
    ] {
        if value > max {
            return Err(Error::InvalidInput(format!(
                "{name} must not exceed {MAX_ENGINE_LIMIT} milliseconds"
            )));
        }
    }
    for (name, value) in [
        ("white initial time", white.initial_time),
        ("black initial time", black.initial_time),
    ] {
        if value < MIN_INITIAL_TIME_MS {
            return Err(Error::InvalidInput(format!(
                "{name} must be at least {MIN_INITIAL_TIME_MS} milliseconds"
            )));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GameConfig {
    pub white: PlayerConfig,
    pub black: PlayerConfig,
    pub white_time_control: Option<TimeControl>,
    pub black_time_control: Option<TimeControl>,
    pub initial_fen: Option<String>,
    #[serde(default)]
    pub initial_moves: Vec<String>,
    pub opening_book: Option<OpeningBookConfig>,
}

#[derive(Clone, Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpeningBookConfig {
    pub book: OpeningBookHandle,
    #[serde(default = "default_opening_book_max_ply")]
    pub max_ply: usize,
}

fn default_opening_book_max_ply() -> usize {
    40
}

#[derive(Clone, Debug, Serialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum GameStatus {
    Playing,
    Finished { result: GameResult },
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GameResult {
    WhiteWins {
        reason: GameEndReason,
    },
    BlackWins {
        reason: GameEndReason,
    },
    Draw {
        reason: DrawReason,
    },
    Interrupted {
        reason: GameInterruptionReason,
        // Terminal diagnostics are transient native output, never persisted input.
        #[serde(default, deserialize_with = "ignore_terminal_snapshot")]
        snapshot: Option<EngineTerminalSnapshot>,
    },
}

fn ignore_terminal_snapshot<'de, D>(
    deserializer: D,
) -> Result<Option<EngineTerminalSnapshot>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    serde::de::IgnoredAny::deserialize(deserializer)?;
    Ok(None)
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum GameInterruptionReason {
    EngineFailure,
    EngineTaskFailed,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum GameEndReason {
    Checkmate,
    Timeout,
    Resignation,
    // Retained for deserialization of older results.
    Abandonment,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DrawReason {
    Stalemate,
    InsufficientMaterial,
    ThreefoldRepetition,
    FiftyMoveRule,
    Agreement,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GameMove {
    pub uci: String,
    pub san: String,
    pub fen_after: String,
    /// The mover's remaining clock after this move, including the increment.
    pub clock: Option<u64>,
    pub white_time: Option<u64>,
    pub black_time: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GameState {
    pub game_id: GameId,
    pub session: u64,
    pub revision: u64,
    pub status: GameStatus,
    pub initial_fen: String,
    pub moves: Vec<GameMove>,
    pub current_fen: String,
    pub ply: u32,
    pub turn: String,
    pub white_time: Option<u64>,
    pub black_time: Option<u64>,
    pub white_player: String,
    pub black_player: String,
}

#[derive(Clone, Debug, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct GameMoveEvent {
    pub game_id: GameId,
    pub session: u64,
    pub revision: u64,
    pub moves: Vec<GameMove>,
    pub fen: String,
    pub white_time: Option<u64>,
    pub black_time: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ClockUpdateEvent {
    pub game_id: GameId,
    pub session: u64,
    pub revision: u64,
    pub white_time: Option<u64>,
    pub black_time: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct GameOverEvent {
    pub game_id: GameId,
    pub session: u64,
    pub revision: u64,
    pub result: GameResult,
    pub moves: Vec<GameMove>,
}

struct ClockState {
    white_time: Option<u64>,
    black_time: Option<u64>,
    white_increment: u64,
    black_increment: u64,
    last_tick: Instant,
}

#[derive(Clone)]
struct EngineRequestContext {
    session: u64,
    position_generation: u64,
    nonce: u64,
    cancellation: CancellationToken,
}

struct ActiveEngineRequest {
    context: EngineRequestContext,
    request_id: Option<crate::engine::EngineRequestId>,
}

struct GameController {
    game_id: GameId,
    session: u64,
    revision: u64,
    position_generation: u64,
    next_engine_request: u64,
    config: GameConfig,
    initial_fen: String,
    root_position: Chess,
    moves: Vec<GameMove>,
    position: Chess,
    position_history: HashMap<String, u32>,
    status: GameStatus,
    terminal_attempt_claimed: bool,
    emission_diagnostics: EmissionDiagnosticLatch,
    clock: Option<ClockState>,
    white_engine: Option<RegisteredGameEngine>,
    black_engine: Option<RegisteredGameEngine>,
    move_notify_tx: Option<tokio::sync::mpsc::Sender<()>>,
    engine_thinking: bool,
    active_engine_request: Option<ActiveEngineRequest>,
    polyglot_book: Option<CancellablePolyglotBook>,
    polyglot_max_ply: usize,
}

#[derive(Clone)]
struct RegisteredGameEngine {
    actor: Arc<EngineActor>,
    key: EngineKey,
    generation: u64,
}

struct GameEngineRegistration {
    supervisor: Arc<EngineSupervisor>,
    key: EngineKey,
    engine_id: String,
    executable_ref: crate::infra::path_authority::PathRef,
}

impl GameController {
    fn new(game_id: GameId, session: u64, config: GameConfig) -> Result<Self, Error> {
        validate_time_controls(&config)?;
        let initial_fen = config.initial_fen.clone().unwrap_or_else(|| {
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".to_string()
        });

        let position = if matches!(config.white, PlayerConfig::Engine { .. })
            || matches!(config.black, PlayerConfig::Engine { .. })
        {
            crate::engine::canonicalize_engine_position(&initial_fen, &[])?.position
        } else {
            parse_fen_to_position(&initial_fen)?
        };

        let clock = if config.white_time_control.is_some() || config.black_time_control.is_some() {
            Some(ClockState {
                white_time: config.white_time_control.as_ref().map(|tc| tc.initial_time),
                black_time: config.black_time_control.as_ref().map(|tc| tc.initial_time),
                white_increment: config
                    .white_time_control
                    .as_ref()
                    .map(|tc| tc.increment)
                    .unwrap_or(0),
                black_increment: config
                    .black_time_control
                    .as_ref()
                    .map(|tc| tc.increment)
                    .unwrap_or(0),
                last_tick: Instant::now(),
            })
        } else {
            None
        };

        let mut position_history = HashMap::new();
        let initial_key = Self::position_key(&position);
        position_history.insert(initial_key, 1);

        let initial_moves = config.initial_moves.clone();

        let mut controller = Self {
            game_id,
            session,
            revision: 0,
            position_generation: 0,
            next_engine_request: 0,
            config,
            initial_fen,
            root_position: position.clone(),
            moves: Vec::new(),
            position,
            position_history,
            status: GameStatus::Playing,
            terminal_attempt_claimed: false,
            emission_diagnostics: EmissionDiagnosticLatch::default(),
            clock,
            white_engine: None,
            black_engine: None,
            move_notify_tx: None,
            engine_thinking: false,
            active_engine_request: None,
            polyglot_book: None,
            polyglot_max_ply: 0,
        };

        controller.check_game_end();
        for uci_str in &initial_moves {
            if controller.status != GameStatus::Playing {
                return Err(Error::InvalidInput(
                    "initial moves continue after a terminal position".into(),
                ));
            }
            controller.apply_move_no_clock(uci_str)?;
        }

        Ok(controller)
    }

    fn get_state(&self) -> GameState {
        let turn = if self.position.turn() == Color::White {
            "white"
        } else {
            "black"
        };

        let (white_time, black_time) = self.get_current_times();

        let white_player = match &self.config.white {
            PlayerConfig::Human { name } => name.clone(),
            PlayerConfig::Engine { name, .. } => name.clone(),
        };

        let black_player = match &self.config.black {
            PlayerConfig::Human { name } => name.clone(),
            PlayerConfig::Engine { name, .. } => name.clone(),
        };

        GameState {
            game_id: self.game_id.clone(),
            session: self.session,
            revision: self.revision,
            status: self.status.clone(),
            initial_fen: self.initial_fen.clone(),
            moves: self.moves.clone(),
            current_fen: Fen::from_position(self.position.clone(), EnPassantMode::Legal)
                .to_string(),
            ply: self.moves.len() as u32,
            turn: turn.to_string(),
            white_time,
            black_time,
            white_player,
            black_player,
        }
    }

    fn position_key(position: &Chess) -> String {
        let fen = Fen::from_position(position.clone(), EnPassantMode::Legal).to_string();
        fen.split_whitespace().take(4).collect::<Vec<_>>().join(" ")
    }

    fn current_turn_player(&self) -> &PlayerConfig {
        if self.position.turn() == Color::White {
            &self.config.white
        } else {
            &self.config.black
        }
    }

    fn is_engine_turn(&self) -> bool {
        matches!(self.current_turn_player(), PlayerConfig::Engine { .. })
    }

    fn advance_position_generation(&mut self) {
        self.position_generation = self.position_generation.saturating_add(1);
        self.cancel_engine_request();
    }

    fn cancel_engine_request(&mut self) {
        if let Some(request) = &self.active_engine_request {
            request.context.cancellation.cancel();
        }
        self.active_engine_request = None;
        self.engine_thinking = false;
    }

    fn begin_engine_request(&mut self) -> Option<EngineRequestContext> {
        if self.status != GameStatus::Playing || !self.is_engine_turn() || self.engine_thinking {
            return None;
        }
        self.next_engine_request = self.next_engine_request.saturating_add(1);
        let context = EngineRequestContext {
            session: self.session,
            position_generation: self.position_generation,
            nonce: self.next_engine_request,
            cancellation: CancellationToken::new(),
        };
        self.engine_thinking = true;
        self.active_engine_request = Some(ActiveEngineRequest {
            context: context.clone(),
            request_id: None,
        });
        Some(context)
    }

    fn register_engine_request_id(
        &mut self,
        context: &EngineRequestContext,
        request_id: crate::engine::EngineRequestId,
    ) -> bool {
        let Some(active) = &mut self.active_engine_request else {
            return false;
        };
        if active.context.session != context.session
            || active.context.position_generation != context.position_generation
            || active.context.nonce != context.nonce
            || active.context.cancellation.is_cancelled()
        {
            return false;
        }
        active.request_id = Some(request_id);
        true
    }

    fn accepts_engine_result(
        &self,
        context: &EngineRequestContext,
        request_id: crate::engine::EngineRequestId,
    ) -> bool {
        self.status == GameStatus::Playing
            && self.session == context.session
            && self.position_generation == context.position_generation
            && self.active_engine_request.as_ref().is_some_and(|active| {
                active.context.nonce == context.nonce
                    && active.context.session == context.session
                    && active.context.position_generation == context.position_generation
                    && active.request_id == Some(request_id)
                    && !active.context.cancellation.is_cancelled()
            })
    }

    fn accepts_engine_context(&self, context: &EngineRequestContext) -> bool {
        self.status == GameStatus::Playing
            && self.session == context.session
            && self.position_generation == context.position_generation
            && self.active_engine_request.as_ref().is_some_and(|active| {
                active.context.nonce == context.nonce
                    && active.context.session == context.session
                    && active.context.position_generation == context.position_generation
                    && !active.context.cancellation.is_cancelled()
            })
    }

    fn apply_move(&mut self, uci_str: &str) -> Result<GameMove, Error> {
        if self.status != GameStatus::Playing {
            return Err(Error::GameNotInProgress);
        }
        if let Some(result) = self.settle_active_clock() {
            self.end_game(result);
            return Err(Error::GameNotInProgress);
        }

        let uci = UciMove::from_ascii(uci_str.as_bytes())?;
        let mv = uci.to_move(&self.position)?;

        let san = SanPlus::from_move_and_play_unchecked(&mut self.position.clone(), &mv);

        self.position.play_unchecked(&mv);
        self.advance_position_generation();

        let pos_key = Self::position_key(&self.position);
        *self.position_history.entry(pos_key).or_insert(0) += 1;

        if let Some(clock_state) = self.clock.as_mut() {
            // `position.turn()` now names the opponent, so credit the mover
            // only after their elapsed time was settled above.
            if self.position.turn() == Color::Black {
                if let Some(white) = &mut clock_state.white_time {
                    *white = white.saturating_add(clock_state.white_increment);
                }
            } else if let Some(black) = &mut clock_state.black_time {
                *black = black.saturating_add(clock_state.black_increment);
            }
            clock_state.last_tick = Instant::now();
        }

        let (white_time, black_time) = self
            .clock
            .as_ref()
            .map(|c| (c.white_time, c.black_time))
            .unwrap_or((None, None));
        let clock = if self.position.turn() == Color::Black {
            white_time
        } else {
            black_time
        };
        let fen_after = Fen::from_position(self.position.clone(), EnPassantMode::Legal).to_string();

        let game_move = GameMove {
            uci: uci_str.to_string(),
            san: san.to_string(),
            fen_after,
            clock,
            white_time,
            black_time,
        };

        self.moves.push(game_move.clone());
        self.bump_revision();
        self.check_game_end();

        Ok(game_move)
    }

    fn apply_move_no_clock(&mut self, uci_str: &str) -> Result<GameMove, Error> {
        let uci = UciMove::from_ascii(uci_str.as_bytes())?;
        let mv = uci.to_move(&self.position)?;

        let san = SanPlus::from_move_and_play_unchecked(&mut self.position.clone(), &mv);

        self.position.play_unchecked(&mv);
        self.advance_position_generation();

        let pos_key = Self::position_key(&self.position);
        *self.position_history.entry(pos_key).or_insert(0) += 1;

        let (white_time, black_time) = self
            .clock
            .as_ref()
            .map(|c| (c.white_time, c.black_time))
            .unwrap_or((None, None));

        let fen_after = Fen::from_position(self.position.clone(), EnPassantMode::Legal).to_string();

        let game_move = GameMove {
            uci: uci_str.to_string(),
            san: san.to_string(),
            fen_after,
            clock: None,
            white_time,
            black_time,
        };

        self.moves.push(game_move.clone());
        self.check_game_end();

        Ok(game_move)
    }

    fn rebuild_position_from_moves(&mut self) -> Result<(), Error> {
        self.position = self.root_position.clone();

        self.position_history.clear();
        let initial_key = Self::position_key(&self.position);
        self.position_history.insert(initial_key, 1);

        for m in &self.moves {
            let uci = UciMove::from_ascii(m.uci.as_bytes())?;
            let mv = uci.to_move(&self.position)?;
            self.position.play_unchecked(&mv);
            let pos_key = Self::position_key(&self.position);
            *self.position_history.entry(pos_key).or_insert(0) += 1;
        }

        if let Some(ref mut clock) = self.clock {
            clock.white_time = self
                .config
                .white_time_control
                .as_ref()
                .map(|tc| tc.initial_time);
            clock.black_time = self
                .config
                .black_time_control
                .as_ref()
                .map(|tc| tc.initial_time);

            if let Some(last_move) = self.moves.last() {
                if last_move.white_time.is_some() || last_move.black_time.is_some() {
                    clock.white_time = last_move.white_time;
                    clock.black_time = last_move.black_time;
                }
            }

            clock.last_tick = Instant::now();
        }

        Ok(())
    }

    fn take_back_moves(&mut self, count: usize) -> Result<(), Error> {
        self.cancel_engine_request();
        for _ in 0..count {
            self.moves.pop();
        }
        self.status = GameStatus::Playing;
        self.rebuild_position_from_moves()?;
        self.advance_position_generation();
        self.bump_revision();
        self.check_game_end();
        Ok(())
    }

    fn check_game_end(&mut self) {
        let result = if self.position.is_checkmate() {
            Some(if self.position.turn() == Color::White {
                GameResult::BlackWins {
                    reason: GameEndReason::Checkmate,
                }
            } else {
                GameResult::WhiteWins {
                    reason: GameEndReason::Checkmate,
                }
            })
        } else if self.position.is_stalemate() {
            Some(GameResult::Draw {
                reason: DrawReason::Stalemate,
            })
        } else if self.position.is_insufficient_material() {
            Some(GameResult::Draw {
                reason: DrawReason::InsufficientMaterial,
            })
        } else if self.position.halfmoves() >= 100 {
            Some(GameResult::Draw {
                reason: DrawReason::FiftyMoveRule,
            })
        } else {
            let pos_key = Self::position_key(&self.position);
            self.position_history
                .get(&pos_key)
                .filter(|count| **count >= 3)
                .map(|_| GameResult::Draw {
                    reason: DrawReason::ThreefoldRepetition,
                })
        };

        if let Some(result) = result {
            self.end_game(result);
        }
    }

    /// Debits the side to move before any move is parsed or accepted. A flag
    /// falls to a draw when the opponent has no possible mating material.
    fn settle_active_clock(&mut self) -> Option<GameResult> {
        let clock = self.clock.as_mut()?;
        let elapsed = clock.last_tick.elapsed().as_millis() as u64;
        let flagged = self.position.turn();
        let active = if flagged == Color::White {
            &mut clock.white_time
        } else {
            &mut clock.black_time
        };
        let Some(remaining) = active else {
            clock.last_tick = Instant::now();
            return None;
        };
        if elapsed >= *remaining {
            *remaining = 0;
            clock.last_tick = Instant::now();
            let winner = !flagged;
            return Some(if self.position.has_insufficient_material(winner) {
                GameResult::Draw {
                    reason: DrawReason::InsufficientMaterial,
                }
            } else if winner == Color::White {
                GameResult::WhiteWins {
                    reason: GameEndReason::Timeout,
                }
            } else {
                GameResult::BlackWins {
                    reason: GameEndReason::Timeout,
                }
            });
        }
        *remaining -= elapsed;
        clock.last_tick = Instant::now();
        None
    }

    fn get_current_times(&self) -> (Option<u64>, Option<u64>) {
        if let Some(ref clock) = self.clock {
            if self.status != GameStatus::Playing {
                return (clock.white_time, clock.black_time);
            }
            let elapsed = clock.last_tick.elapsed().as_millis() as u64;

            let white_time = if self.position.turn() == Color::White {
                clock.white_time.map(|t| t.saturating_sub(elapsed))
            } else {
                clock.white_time
            };

            let black_time = if self.position.turn() == Color::Black {
                clock.black_time.map(|t| t.saturating_sub(elapsed))
            } else {
                clock.black_time
            };

            (white_time, black_time)
        } else {
            (None, None)
        }
    }

    fn end_game(&mut self, result: GameResult) -> bool {
        if self.status != GameStatus::Playing {
            return false;
        }
        let (white_time, black_time) = self.get_current_times();
        if let Some(clock) = &mut self.clock {
            clock.white_time = white_time;
            clock.black_time = black_time;
        }
        self.status = GameStatus::Finished { result };
        self.advance_position_generation();
        self.terminal_attempt_claimed = false;
        self.bump_revision();
        true
    }

    fn reset_clock(&mut self) {
        if let Some(ref mut clock) = self.clock {
            clock.last_tick = Instant::now();
        }
    }

    fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }

    fn move_event_revision(&self) -> u64 {
        if matches!(self.status, GameStatus::Finished { .. }) {
            self.revision.saturating_sub(1)
        } else {
            self.revision
        }
    }

    fn attempt_event_emission<F>(
        &mut self,
        kind: GameEventKind,
        revision: u64,
        emitter: F,
    ) -> Option<&'static str>
    where
        F: FnOnce() -> Result<(), tauri::Error>,
    {
        let latch = match kind {
            GameEventKind::Move => &mut self.emission_diagnostics.move_failed,
            GameEventKind::Clock => &mut self.emission_diagnostics.clock_failed,
            GameEventKind::GameOver => &mut self.emission_diagnostics.terminal_failed,
        };
        attempt_game_event_emission(&self.game_id, self.session, revision, kind, latch, emitter)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GameEventKind {
    Move,
    Clock,
    GameOver,
}

impl GameEventKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Move => "move",
            Self::Clock => "clock",
            Self::GameOver => "game-over",
        }
    }
}

fn safe_tauri_error_label(error: &tauri::Error) -> &'static str {
    match error {
        tauri::Error::Json(_) => "serialization",
        tauri::Error::Runtime(_) => "runtime",
        tauri::Error::Io(_) => "io",
        tauri::Error::FailedToReceiveMessage => "message-receive",
        _ => "other-tauri",
    }
}

#[derive(Default, Clone, Copy, Debug)]
struct EmissionDiagnosticLatch {
    move_failed: bool,
    clock_failed: bool,
    terminal_failed: bool,
}

fn attempt_game_event_emission<F>(
    game_id: &str,
    session: u64,
    revision: u64,
    kind: GameEventKind,
    latch: &mut bool,
    emitter: F,
) -> Option<&'static str>
where
    F: FnOnce() -> Result<(), tauri::Error>,
{
    match emitter() {
        Ok(()) => None,
        Err(err) => {
            if !*latch {
                *latch = true;
                let cause = safe_tauri_error_label(&err);
                warn!(
                    "Game event emission failed: kind={}, game_id={}, session={}, revision={}, cause={}",
                    kind.as_str(),
                    game_id,
                    session,
                    revision,
                    cause,
                );
                Some(cause)
            } else {
                None
            }
        }
    }
}

/// Attempts terminal event emission exactly once for the state transition that
/// produced it. Transport remains best effort, but competing timeout,
/// resignation and engine-error paths cannot claim or attempt conflicting transitions.
fn attempt_terminal_event_emission_with<F>(controller: &mut GameController, emitter: F) -> bool
where
    F: FnOnce(&GameOverEvent) -> Result<(), tauri::Error>,
{
    let GameStatus::Finished { result } = &controller.status else {
        return false;
    };
    if controller.terminal_attempt_claimed {
        return false;
    }
    controller.terminal_attempt_claimed = true;
    let event = GameOverEvent {
        game_id: controller.game_id.clone(),
        session: controller.session,
        revision: controller.revision,
        result: result.clone(),
        moves: controller.moves.clone(),
    };
    let revision = controller.revision;
    controller.attempt_event_emission(GameEventKind::GameOver, revision, || emitter(&event));
    true
}

fn attempt_terminal_event_emission<R: Runtime>(
    controller: &mut GameController,
    app: &AppHandle<R>,
) -> bool {
    attempt_terminal_event_emission_with(controller, |event| event.emit(app))
}

const COMPLETED_GAME_SNAPSHOTS: usize = 128;
const CLOCK_TICK_INTERVAL: Duration = Duration::from_millis(100);
const MAX_SAFE_JS_COUNTER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, PartialEq, Eq)]
enum SessionDisposition {
    Active,
    Completed,
    Tombstoned,
}

struct LatestSession {
    session: u64,
    disposition: SessionDisposition,
}

struct CompletedSnapshot {
    game_id: GameId,
    session: u64,
    state: GameState,
}

#[derive(Default)]
struct SessionMetadata {
    snapshots: VecDeque<CompletedSnapshot>,
    latest: HashMap<GameId, LatestSession>,
}

impl SessionMetadata {
    fn prune(&mut self, games: &DashMap<GameId, Arc<LiveSession>>) {
        while self.snapshots.len() > COMPLETED_GAME_SNAPSHOTS {
            self.snapshots.pop_front();
        }
        self.latest
            .retain(|game_id, latest| match latest.disposition {
                SessionDisposition::Active => games
                    .get(game_id)
                    .is_some_and(|live| live.session == latest.session),
                SessionDisposition::Completed => self.snapshots.iter().any(|snapshot| {
                    snapshot.game_id == *game_id && snapshot.session == latest.session
                }),
                SessionDisposition::Tombstoned => self
                    .snapshots
                    .iter()
                    .any(|snapshot| snapshot.game_id == *game_id),
            });
    }
}

/// One lifecycle owner per public game ID. Keeping controller, shutdown and
/// loop handle together makes replacement and natural cleanup exact-session
/// operations instead of independent best-effort map mutations.
struct LiveSession {
    cleanup: SessionCleanup,
    session: u64,
    controller: Arc<RwLock<GameController>>,
    shutdown: watch::Sender<bool>,
    join: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    engine_supervisor: Arc<EngineSupervisor>,
}

const MAX_SESSIONS_AWAITING_CLEANUP_OBSERVATION: usize = 4096;

#[derive(Default)]
struct SessionCleanup {
    join_observation: Mutex<()>,
    loop_outcome: OnceLock<Result<(), Arc<Error>>>,
    join_failure: OnceLock<Arc<Error>>,
    slot: std::sync::Mutex<Option<OwnedSemaphorePermit>>,
}

impl SessionCleanup {
    fn record(&self, result: Result<(), Error>) {
        let success = result.is_ok();
        let _ = self.loop_outcome.set(result.map_err(Arc::new));
        if success {
            self.release_slot();
        }
    }

    fn release_slot(&self) {
        self.slot.lock().unwrap_or_else(|e| e.into_inner()).take();
    }

    fn failed(&self) -> bool {
        self.loop_outcome.get().is_some_and(Result::is_err)
    }

    fn outcome(&self) -> Result<(), Error> {
        self.loop_outcome
            .get()
            .cloned()
            .unwrap_or(Ok(()))
            .map_err(Error::Shared)
    }
}

struct RestoreJoinOnDrop<'a> {
    slot: &'a std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl<'a> RestoreJoinOnDrop<'a> {
    fn new(
        slot: &'a std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
        handle: tokio::task::JoinHandle<()>,
    ) -> Self {
        Self {
            slot,
            handle: Some(handle),
        }
    }

    // The handle remains here from construction until disarm; every caller
    // disarms only after its last use, so this expect is an invariant.
    fn handle_mut(&mut self) -> &mut tokio::task::JoinHandle<()> {
        self.handle
            .as_mut()
            .expect("join restoration guard retains its handle until disarmed")
    }

    fn disarm(&mut self) {
        self.handle.take();
    }

    fn abort(&mut self) {
        self.handle_mut().abort();
    }
}

impl Drop for RestoreJoinOnDrop<'_> {
    fn drop(&mut self) {
        let Some(handle) = self.handle.take() else {
            return;
        };
        let mut slot = match self.slot.lock() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        if slot.is_none() {
            *slot = Some(handle);
        } else {
            drop(slot);
            handle.abort();
        }
    }
}

struct RemovedSessionRetirement {
    session: Arc<LiveSession>,
    game_id: GameId,
    join_budget: Duration,
    armed: bool,
}

impl RemovedSessionRetirement {
    fn new(session: Arc<LiveSession>, game_id: GameId, join_budget: Duration) -> Self {
        Self {
            session,
            game_id,
            join_budget,
            armed: true,
        }
    }

    async fn finish(&mut self) -> Result<(), Error> {
        let result = self.session.finish_retired(self.join_budget).await;
        if let Err(error) = &result {
            log_game_cleanup_error(&self.game_id, self.session.session, "retirement", error);
        }
        self.armed = false;
        result
    }
}

impl Drop for RemovedSessionRetirement {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.armed = false;
        let session = self.session.clone();
        let game_id = self.game_id.clone();
        let join_budget = self.join_budget;
        tokio::spawn(async move {
            let mut retirement = RemovedSessionRetirement::new(session, game_id, join_budget);
            let _ = retirement.finish().await;
        });
    }
}

struct GameEngineConstruction {
    game_id: GameId,
    session: u64,
    guards: Vec<RegistrationGuard>,
}

impl GameEngineConstruction {
    fn new(game_id: GameId, session: u64) -> Self {
        Self {
            game_id,
            session,
            guards: Vec::with_capacity(2),
        }
    }

    fn own(&mut self, guard: RegistrationGuard) {
        self.guards.push(guard);
    }

    async fn abandon(self, primary: Error) -> Error {
        let cleanup = aggregate_game_engine_termination_results(
            futures_util::future::join_all(
                self.guards
                    .into_iter()
                    .map(RegistrationGuard::terminate_now),
            )
            .await,
        );
        let error = Error::with_cleanup(primary, cleanup);
        if matches!(&error, Error::OperationAndCleanup { .. }) {
            log_game_cleanup_error(
                &self.game_id,
                self.session,
                "construction abandoned",
                &error,
            );
        }
        error
    }

    fn transfer_to_live_session(mut self) {
        for guard in &mut self.guards {
            guard.disarm();
        }
    }
}

fn log_game_cleanup_error(game_id: &str, session: u64, event: &'static str, error: &Error) {
    let message = format!(
        "game cleanup failed game_id={game_id} session={session} event={event} error={}",
        error.diagnostic()
    );
    #[cfg(test)]
    match crate::engine::CLEANUP_FAILURE_LOG.lock() {
        Ok(mut errors) => errors.push(message.clone()),
        Err(poisoned) => poisoned.into_inner().push(message.clone()),
    }
    error!("{message}");
}

impl LiveSession {
    async fn terminate_registered_engines(&self) -> Result<(), Error> {
        let engines = {
            let controller = self.controller.read().await;
            controller
                .white_engine
                .iter()
                .chain(controller.black_engine.iter())
                .cloned()
                .collect::<Vec<_>>()
        };
        terminate_game_engines(&self.engine_supervisor, engines).await
    }

    async fn shutdown_and_join(&self, join_budget: Duration) -> Result<(), Error> {
        let game_id = {
            let mut controller = self.controller.write().await;
            controller.cancel_engine_request();
            controller.game_id.clone()
        };
        let _ = self.shutdown.send(true);
        let observation = self.cleanup.join_observation.lock().await;
        let join = match self.join.lock() {
            Ok(mut join) => join.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        if let Some(join) = join {
            let mut join = RestoreJoinOnDrop::new(&self.join, join);
            #[cfg(test)]
            SHUTDOWN_JOIN_TAKEN_HOOKS.run(&(game_id.clone(), self.session));
            match tokio::time::timeout(join_budget, &mut *join.handle_mut()).await {
                Ok(Ok(())) => join.disarm(),
                Ok(Err(error)) => {
                    let primary = Error::task_join(
                        "game loop join failed",
                        &error,
                        &format!("game_id={game_id} session={}", self.session),
                    );
                    let primary = Error::Shared(
                        self.cleanup
                            .join_failure
                            .get_or_init(|| Arc::new(primary))
                            .clone(),
                    );
                    log_game_cleanup_error(&game_id, self.session, "loop join failed", &primary);
                    join.disarm();
                    drop(observation);
                    return Err(Error::with_cleanup(
                        primary,
                        self.terminate_registered_engines().await,
                    ));
                }
                Err(_) => {
                    let primary = Error::Shared(
                        self.cleanup
                            .join_failure
                            .get_or_init(|| {
                                Arc::new(Error::Conflict(format!(
                                    "game loop did not exit within {join_budget:?}"
                                )))
                            })
                            .clone(),
                    );
                    log_game_cleanup_error(&game_id, self.session, "loop join failed", &primary);
                    join.abort();
                    let handle = join.handle_mut();
                    let _ = (&mut *handle).await;
                    join.disarm();
                    drop(observation);
                    return Err(Error::with_cleanup(
                        primary,
                        self.terminate_registered_engines().await,
                    ));
                }
            }
        }
        match self.cleanup.join_failure.get() {
            Some(error) => Err(Error::Shared(error.clone())),
            None => Ok(()),
        }
    }

    async fn finish_retired(&self, join_budget: Duration) -> Result<(), Error> {
        let join = self.shutdown_and_join(join_budget).await;
        let termination = self.terminate_registered_engines().await;
        let outcome = self.cleanup.outcome();
        let result = match join {
            Ok(()) => termination,
            Err(primary) => Err(Error::with_cleanup(primary, termination)),
        };
        let result = match outcome {
            Ok(()) => result,
            Err(primary) => Err(Error::with_cleanup(primary, result)),
        };
        self.cleanup.release_slot();
        result
    }
}

pub struct GameManager {
    cleanup_observation_slots: Arc<Semaphore>,
    games: DashMap<GameId, Arc<LiveSession>>,
    next_session: AtomicU64,
    sealed: AtomicBool,
    registration: Mutex<()>,
    lifecycle: KeyedLocks<GameId>,
    session_metadata: Mutex<SessionMetadata>,
}

async fn spawn_configured_game_engine(
    registration: GameEngineRegistration,
    engine: EngineHandle,
    options: &[EngineOption],
    authority: crate::infra::path_authority::SharedPathAuthority,
    chess960: bool,
) -> Result<(RegisteredGameEngine, RegistrationGuard), Error> {
    let GameEngineRegistration {
        supervisor,
        key,
        engine_id,
        executable_ref,
    } = registration;
    let admission = supervisor
        .admit_for_launch(key.clone(), engine_id.clone(), executable_ref.clone())
        .await?;
    let (executable, resolved) = resolve_launch(
        authority,
        engine,
        PathOperation::EngineExecute,
        options,
        &admission,
    )
    .await?;
    spawn_configured_game_engine_with_resolved(
        supervisor, executable, resolved, admission, key, chess960,
    )
    .await
}

fn game_engine_registration_for_side(
    player: &PlayerConfig,
    supervisor: &Arc<EngineSupervisor>,
    game_id: &str,
    session: u64,
    side: &str,
) -> Result<Option<GameEngineRegistration>, Error> {
    let PlayerConfig::Engine {
        engine_id, handle, ..
    } = player
    else {
        return Ok(None);
    };
    Ok(Some(GameEngineRegistration {
        supervisor: supervisor.clone(),
        key: game_side_engine_key(game_id, session, side, engine_id)?,
        engine_id: engine_id.clone(),
        executable_ref: handle.id.clone(),
    }))
}

async fn initialize_configured_game_engine(
    engine: Arc<EngineActor>,
    resolved: Vec<ResolvedEngineOption>,
    chess960: bool,
    key: EngineKey,
) -> Result<(), Error> {
    #[cfg(all(test, unix))]
    GAME_ENGINE_AFTER_SPAWN_HOOKS.run(&key);
    #[cfg(not(all(test, unix)))]
    drop(key);
    engine.init_uci().await?;
    verify_option_resources(&engine, &resolved, None).await?;
    for option in resolved {
        if option.name != "UCI_Chess960" {
            engine
                .set_option_with_resources(&option.name, &option.value, &option.resource_values)
                .await?;
        }
    }
    engine
        .set_option("UCI_Chess960", if chess960 { "true" } else { "false" })
        .await?;
    engine.ensure_ready().await
}

async fn spawn_configured_game_engine_with_resolved(
    supervisor: Arc<EngineSupervisor>,
    executable: EngineExecutable,
    resolved: Vec<ResolvedEngineOption>,
    admission: AdmissionLease,
    key: EngineKey,
    chess960: bool,
) -> Result<(RegisteredGameEngine, RegistrationGuard), Error> {
    let hook_key = key.clone();
    let registered_key = key.clone();
    spawn_registered(supervisor, key, executable, admission, move |engine| {
        initialize_configured_game_engine(engine, resolved, chess960, hook_key)
    })
    .await
    .map(|(supervised, guard, ())| {
        (
            RegisteredGameEngine {
                actor: supervised.actor,
                key: registered_key,
                generation: supervised.generation,
            },
            guard,
        )
    })
}

/// The after-spawn hook every game engine's initialization fires. It is keyed by engine
/// identity because `cargo test` runs these tests in parallel in one process — see
/// `infra::test_hooks` and `f-20260917-09`.
#[cfg(all(test, unix))]
static GAME_ENGINE_AFTER_SPAWN_HOOKS: crate::infra::test_hooks::KeyedTestHooks<EngineKey> =
    crate::infra::test_hooks::KeyedTestHooks::new();

#[cfg(test)]
static GAME_PUBLICATION_WAIT_HOOKS: crate::infra::test_hooks::KeyedTestHooks<GameId> =
    crate::infra::test_hooks::KeyedTestHooks::new();

#[cfg(test)]
static SHUTDOWN_JOIN_TAKEN_HOOKS: crate::infra::test_hooks::KeyedTestHooks<(GameId, u64)> =
    crate::infra::test_hooks::KeyedTestHooks::new();

#[cfg(test)]
static RUN_PUBLISHED_LOOP_READY_HOOKS: crate::infra::test_hooks::KeyedTestHooks<(GameId, u64)> =
    crate::infra::test_hooks::KeyedTestHooks::new();

#[cfg(test)]
type PublishedLoopResolution = Box<dyn FnOnce(bool) + Send>;

#[cfg(test)]
static RUN_PUBLISHED_LOOP_RESOLUTIONS: crate::infra::test_hooks::KeyedTestValues<
    (GameId, u64),
    PublishedLoopResolution,
> = crate::infra::test_hooks::KeyedTestValues::new();

#[cfg(test)]
type AfterHandoffHook = Box<dyn FnOnce(Arc<RwLock<GameController>>) + Send>;

#[cfg(test)]
static GAME_START_AFTER_HANDOFF_HOOKS: crate::infra::test_hooks::KeyedTestValues<
    GameId,
    AfterHandoffHook,
> = crate::infra::test_hooks::KeyedTestValues::new();

#[cfg(test)]
type GameLoopEngineTask = (
    tokio::task::JoinHandle<Result<(), Error>>,
    CancellationToken,
);

#[cfg(test)]
static GAME_LOOP_ENGINE_TASKS: crate::infra::test_hooks::KeyedTestValues<
    (GameId, u64),
    GameLoopEngineTask,
> = crate::infra::test_hooks::KeyedTestValues::new();

#[cfg(all(test, unix))]
async fn spawn_configured_game_engine_with_executable(
    registration: GameEngineRegistration,
    executable: EngineExecutable,
    options: &[EngineOption],
    authority: &crate::infra::path_authority::SharedPathAuthority,
    chess960: bool,
) -> Result<(RegisteredGameEngine, RegistrationGuard), Error> {
    let GameEngineRegistration {
        supervisor,
        key,
        engine_id,
        executable_ref,
    } = registration;
    let admission = supervisor
        .admit_for_launch(key.clone(), engine_id.clone(), executable_ref.clone())
        .await?;
    let mut resolved =
        authority.with_mut(|authority| resolve_engine_option_leases(authority, options))??;
    #[cfg(target_os = "macos")]
    for option in &resolved {
        for resource in &option.resources {
            resource.pin_test_target_to_original()?;
        }
    }
    for option in &mut resolved {
        option.refresh_resource_values()?;
    }
    let child_leases = resolved
        .iter_mut()
        .flat_map(|option| std::mem::take(&mut option.resources))
        .collect();
    let executable = executable.with_resource_leases(child_leases);
    spawn_configured_game_engine_with_resolved(
        supervisor, executable, resolved, admission, key, chess960,
    )
    .await
}

pub(crate) fn game_side_engine_key(
    game_id: &str,
    session: u64,
    side: &str,
    engine_id: &str,
) -> Result<EngineKey, Error> {
    // Side lives in `tab` so `retire_engine` can match `key.engine` against the
    // application id. Using `"white"`/`"black"` as the engine field would reap
    // every white-side game if a user ever stored that string as an engine id.
    EngineKey::game(game_id, session, side, engine_id)
}

async fn terminate_game_engines(
    supervisor: &EngineSupervisor,
    engines: impl IntoIterator<Item = RegisteredGameEngine>,
) -> Result<(), Error> {
    let results = futures_util::future::join_all(engines.into_iter().map(|engine| async move {
        let result = supervisor
            .terminate_exact(&engine.key, engine.generation)
            .await;
        if let Err(error) = &result {
            log_registration_cleanup_error(Some(&engine.key), Some(engine.generation), error);
        }
        result
    }))
    .await;
    aggregate_game_engine_termination_results(results)
}

fn aggregate_game_engine_termination_results(
    results: impl IntoIterator<Item = Result<(), Error>>,
) -> Result<(), Error> {
    let failures = results
        .into_iter()
        .filter_map(Result::err)
        .map(|error| error.to_string())
        .collect::<Vec<_>>();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(Error::Conflict(format!(
            "failed to terminate game engines: {}",
            failures.join("; ")
        )))
    }
}

impl GameManager {
    #[cfg(test)]
    pub(crate) async fn install_failed_production_cleanup_test_session(
        self: &Arc<Self>,
        supervisor: Arc<EngineSupervisor>,
        game_id: &str,
    ) {
        let engine = tests::register_test_game_engine_with_actor(
            &supervisor,
            game_id,
            1,
            "white",
            "failed-shutdown",
            "failed-shutdown-path",
            EngineActor::recoverable_cleanup_test_actor(),
        )
        .await;
        let (live, controller) = tests::test_live_session_with_supervisor(game_id, 1, supervisor);
        controller.write().await.white_engine = Some(engine);
        controller.write().await.end_game(GameResult::Draw {
            reason: DrawReason::Stalemate,
        });
        tests::publish_test_session(self, game_id, live.clone()).await;
        let app = tauri::test::mock_app();
        let (_tx, rx) = tokio::sync::mpsc::channel(1);
        game_loop(
            game_id.into(),
            live.clone(),
            live.shutdown.subscribe(),
            rx,
            app.handle().clone(),
            Arc::downgrade(self),
        )
        .await;
    }
    pub fn new() -> Self {
        Self {
            cleanup_observation_slots: Arc::new(Semaphore::new(
                MAX_SESSIONS_AWAITING_CLEANUP_OBSERVATION,
            )),
            games: DashMap::new(),
            next_session: AtomicU64::new(0),
            sealed: AtomicBool::new(false),
            registration: Mutex::new(()),
            lifecycle: KeyedLocks::default(),
            session_metadata: Mutex::new(SessionMetadata::default()),
        }
    }

    // The returned lease's lifetime is tied to this manager.
    fn lifecycle_lease(&self, game_id: &str) -> KeyedLockLease<'_, GameId> {
        self.lifecycle.lease(game_id.to_owned())
    }

    fn ensure_accepting_starts(&self) -> Result<(), Error> {
        if self.sealed.load(Ordering::SeqCst) {
            Err(Error::Conflict("application is shutting down".into()))
        } else {
            Ok(())
        }
    }

    fn allocate_session(&self) -> Result<u64, Error> {
        let mut current = self.next_session.load(Ordering::Relaxed);
        loop {
            if current >= MAX_SAFE_JS_COUNTER {
                return Err(Error::ResourceLimit(
                    "game session generation exhausted".into(),
                ));
            }
            match self.next_session.compare_exchange_weak(
                current,
                current + 1,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return Ok(current + 1),
                Err(observed) => current = observed,
            }
        }
    }

    async fn publish_live(
        &self,
        game_id: GameId,
        session: u64,
        live: Arc<LiveSession>,
        install_loop: impl FnOnce(),
    ) -> Result<(), Error> {
        #[cfg(test)]
        GAME_PUBLICATION_WAIT_HOOKS.run(&game_id);
        let registration = self.registration.lock().await;
        self.ensure_accepting_starts()?;
        {
            let mut metadata = self.session_metadata.lock().await;
            self.games.insert(game_id.clone(), live);
            metadata.latest.insert(
                game_id,
                LatestSession {
                    session,
                    disposition: SessionDisposition::Active,
                },
            );
            metadata.prune(&self.games);
        }
        install_loop();
        drop(registration);
        Ok(())
    }

    async fn complete_exact(
        &self,
        game_id: &str,
        session: u64,
        controller: &Arc<RwLock<GameController>>,
    ) {
        let snapshot = controller.read().await.get_state();
        let mut metadata = self.session_metadata.lock().await;
        let is_exact_live = self
            .games
            .get(game_id)
            .is_some_and(|live| live.session == session);
        let is_exact_active = metadata.latest.get(game_id).is_some_and(|latest| {
            latest.session == session && latest.disposition == SessionDisposition::Active
        });
        if !is_exact_live || !is_exact_active {
            return;
        }
        metadata
            .snapshots
            .retain(|entry| entry.game_id != game_id || entry.session != session);
        metadata.snapshots.push_back(CompletedSnapshot {
            game_id: game_id.to_owned(),
            session,
            state: snapshot,
        });
        let _ = self.games.remove_if(game_id, |_, current| {
            current.session == session && !current.cleanup.failed()
        });
        metadata.latest.insert(
            game_id.to_owned(),
            LatestSession {
                session,
                disposition: SessionDisposition::Completed,
            },
        );
        metadata.prune(&self.games);
    }

    fn retire_live_locked(
        &self,
        metadata: &mut SessionMetadata,
        game_id: &str,
        session: u64,
    ) -> Option<Arc<LiveSession>> {
        let removed = self
            .games
            .remove_if(game_id, |_, current| current.session == session)
            .map(|(_, live)| live);
        if removed.is_some() {
            metadata.latest.insert(
                game_id.to_owned(),
                LatestSession {
                    session,
                    disposition: SessionDisposition::Tombstoned,
                },
            );
        }
        metadata.prune(&self.games);
        removed
    }

    async fn retire_replaced_session(
        &self,
        game_id: &str,
        old_game: Arc<LiveSession>,
        join_budget: Duration,
    ) -> Result<(), Error> {
        {
            let mut metadata = self.session_metadata.lock().await;
            self.retire_live_locked(&mut metadata, game_id, old_game.session);
        }
        let mut retirement =
            RemovedSessionRetirement::new(old_game, game_id.to_owned(), join_budget);
        retirement.finish().await
    }

    pub async fn start_game<R: Runtime>(
        self: &Arc<Self>,
        game_id: GameId,
        config: GameConfig,
        app: AppHandle<R>,
        authority: crate::infra::path_authority::SharedPathAuthority,
        engine_supervisor: Arc<EngineSupervisor>,
    ) -> Result<GameState, Error> {
        self.ensure_accepting_starts()?;
        let lifecycle = self.lifecycle_lease(&game_id);
        let _transition = lifecycle.lock().await;
        let observation_slot = self
            .cleanup_observation_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                Error::ResourceLimit("game cleanup observation capacity reached".into())
            })?;
        let session = self.allocate_session()?;
        let OpeningBookResult {
            config,
            polyglot_book,
            polyglot_max_ply,
        } = apply_opening_book(config, &authority).await?;
        let mut controller = GameController::new(game_id.clone(), session, config.clone())?;
        let castling_mode = controller.position.castles().mode();
        controller.polyglot_book = polyglot_book;
        controller.polyglot_max_ply = polyglot_max_ply;
        let mut construction = GameEngineConstruction::new(game_id.clone(), session);
        let white_registration = game_engine_registration_for_side(
            &config.white,
            &engine_supervisor,
            &game_id,
            session,
            "white",
        )?;
        let black_registration = game_engine_registration_for_side(
            &config.black,
            &engine_supervisor,
            &game_id,
            session,
            "black",
        )?;

        if let (
            Some(registration),
            PlayerConfig::Engine {
                handle, options, ..
            },
        ) = (white_registration, &config.white)
        {
            let (registered, guard) = match spawn_configured_game_engine(
                registration,
                handle.clone(),
                options,
                authority.clone(),
                castling_mode.is_chess960(),
            )
            .await
            {
                Ok(registered) => registered,
                Err(primary) => {
                    return Err(construction.abandon(primary).await);
                }
            };
            construction.own(guard);
            controller.white_engine = Some(registered);
        }

        if let (
            Some(registration),
            PlayerConfig::Engine {
                handle, options, ..
            },
        ) = (black_registration, &config.black)
        {
            match spawn_configured_game_engine(
                registration,
                handle.clone(),
                options,
                authority.clone(),
                castling_mode.is_chess960(),
            )
            .await
            {
                Ok((registered, guard)) => {
                    construction.own(guard);
                    controller.black_engine = Some(registered);
                }
                Err(primary) => {
                    return Err(construction.abandon(primary).await);
                }
            }
        }

        controller.reset_clock();

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let (move_notify_tx, move_notify_rx) = tokio::sync::mpsc::channel(1);
        controller.move_notify_tx = Some(move_notify_tx);

        let state = controller.get_state();
        let controller = Arc::new(RwLock::new(controller));
        let live = Arc::new(LiveSession {
            cleanup: SessionCleanup {
                slot: std::sync::Mutex::new(Some(observation_slot)),
                ..SessionCleanup::default()
            },
            session,
            controller: controller.clone(),
            shutdown: shutdown_tx,
            join: std::sync::Mutex::new(None),
            engine_supervisor: engine_supervisor.clone(),
        });

        // Construct and validate the entire replacement before disturbing a
        // running game. A failed new configuration therefore preserves it.
        if let Some(old_game) = self.games.get(&game_id).map(|entry| entry.clone()) {
            // The lifecycle lock prevents a newer session from replacing this
            // exact one while it is joined. Remove before signaling so an
            // aborted replacement cannot become a completed snapshot.
            if let Err(primary) = self
                .retire_replaced_session(&game_id, old_game, EngineDeadlines::default().quit)
                .await
            {
                return Err(construction.abandon(primary).await);
            }
        }
        let (start_loop, start_loop_rx) = tokio::sync::oneshot::channel();
        let manager = Arc::downgrade(self);
        let loop_game_id = game_id.clone();
        let loop_live = live.clone();
        let loop_app = app.clone();
        let install_live = live.clone();
        let publication = self
            .publish_live(game_id.clone(), session, live.clone(), move || {
                let join = tokio::spawn(run_published_loop(
                    loop_game_id,
                    loop_live,
                    shutdown_rx,
                    move_notify_rx,
                    loop_app,
                    manager,
                    start_loop_rx,
                ));
                match install_live.join.lock() {
                    Ok(mut slot) => *slot = Some(join),
                    Err(poisoned) => *poisoned.into_inner() = Some(join),
                }
            })
            .await;
        if let Err(primary) = publication {
            return Err(construction.abandon(primary).await);
        }
        construction.transfer_to_live_session();

        #[cfg(test)]
        if let Some(hook) = GAME_START_AFTER_HANDOFF_HOOKS.take(&game_id) {
            hook(controller.clone());
        }

        // A FEN (or a validated initial move sequence) may already be
        // terminal. Register the LiveSession first, then publish exactly once
        // through the same terminal-event guard used by live play.
        let terminal_attempt_claimed = {
            let mut controller = controller.write().await;
            attempt_terminal_event_emission(&mut controller, &app)
        };
        if terminal_attempt_claimed {
            let _ = live.shutdown.send(true);
        }
        let _ = start_loop.send(());

        Ok(state)
    }

    async fn current_session(
        &self,
        game_id: &str,
        expected_session: u64,
    ) -> Result<Arc<LiveSession>, Error> {
        let game = self
            .games
            .get(game_id)
            .map(|entry| entry.clone())
            .ok_or_else(|| Error::GameNotFound(game_id.to_string()))?;
        if game.session != expected_session {
            return Err(Error::Conflict("game session is no longer current".into()));
        }
        Ok(game)
    }

    fn session_is_current(&self, game_id: &str, expected_session: u64) -> bool {
        self.games
            .get(game_id)
            .is_some_and(|game| game.session == expected_session)
    }

    pub async fn get_game_state(
        &self,
        game_id: &str,
        expected_session: u64,
    ) -> Result<GameState, Error> {
        let lifecycle = self.lifecycle_lease(game_id);
        let _operation = lifecycle.lock().await;
        if let Some(game) = self.games.get(game_id).map(|entry| entry.clone()) {
            if game.session != expected_session {
                return Err(Error::Conflict("game session is no longer current".into()));
            }
            return Ok(game.controller.read().await.get_state());
        }
        let metadata = self.session_metadata.lock().await;
        let Some(latest) = metadata.latest.get(game_id) else {
            return Err(Error::GameNotFound(game_id.to_string()));
        };
        if latest.session != expected_session {
            return Err(Error::Conflict("game session is no longer current".into()));
        }
        if latest.disposition == SessionDisposition::Tombstoned {
            return Err(Error::GameNotFound(game_id.to_string()));
        }
        metadata
            .snapshots
            .iter()
            .rev()
            .find(|entry| entry.game_id == game_id && entry.session == expected_session)
            .map(|entry| entry.state.clone())
            .ok_or_else(|| Error::GameNotFound(game_id.to_string()))
    }

    pub async fn make_move<R: Runtime>(
        &self,
        game_id: &str,
        expected_session: u64,
        uci: &str,
        expected_ply: u32,
        app: &AppHandle<R>,
    ) -> Result<GameState, Error> {
        let lifecycle = self.lifecycle_lease(game_id);
        let _operation = lifecycle.lock().await;
        let game = self.current_session(game_id, expected_session).await?;

        let mut controller = game.controller.write().await;

        if !self.session_is_current(game_id, expected_session) {
            return Err(Error::Conflict(
                "game session changed before move commit".into(),
            ));
        }

        if controller.is_engine_turn() {
            return Err(Error::NotHumanTurn);
        }

        if controller.moves.len() != expected_ply as usize {
            return Err(Error::Conflict(
                "game position changed before move commit".into(),
            ));
        }

        let game_move = match controller.apply_move(uci) {
            Ok(move_) => move_,
            Err(_) if matches!(controller.status, GameStatus::Finished { .. }) => {
                let terminal_attempt_claimed =
                    attempt_terminal_event_emission(&mut controller, app);
                let state = controller.get_state();
                drop(controller);
                if terminal_attempt_claimed {
                    let _ = game.shutdown.send(true);
                }
                return Ok(state);
            }
            Err(error) => return Err(error),
        };
        let (white_time, black_time) = controller.get_current_times();

        let move_revision = controller.move_event_revision();
        let move_event = GameMoveEvent {
            game_id: game_id.to_string(),
            session: controller.session,
            // A terminal move is followed by a distinct GameOver event. The move
            // itself owns the revision assigned by `apply_move`; `end_game`
            // advances it once more for the terminal state/event.
            revision: move_revision,
            moves: controller.moves.clone(),
            fen: game_move.fen_after,
            white_time,
            black_time,
        };
        controller
            .attempt_event_emission(GameEventKind::Move, move_revision, || move_event.emit(app));

        let terminal_attempt_claimed = attempt_terminal_event_emission(&mut controller, app);
        if !terminal_attempt_claimed {
            if let Some(tx) = &controller.move_notify_tx {
                let _ = tx.try_send(());
            }
        }

        let state = controller.get_state();
        drop(controller);
        if terminal_attempt_claimed {
            let _ = game.shutdown.send(true);
        }
        Ok(state)
    }

    pub async fn take_back_move(
        &self,
        game_id: &str,
        expected_session: u64,
        app: &AppHandle,
    ) -> Result<GameState, Error> {
        let lifecycle = self.lifecycle_lease(game_id);
        let _operation = lifecycle.lock().await;
        let game = self.current_session(game_id, expected_session).await?;

        let mut controller = game.controller.write().await;

        if !self.session_is_current(game_id, expected_session) {
            return Err(Error::Conflict(
                "game session changed before takeback commit".into(),
            ));
        }

        if controller.status != GameStatus::Playing {
            return Err(Error::GameNotInProgress);
        }
        if controller.moves.is_empty() {
            return Err(Error::NoMovesFound);
        }

        let human_color = match (&controller.config.white, &controller.config.black) {
            (PlayerConfig::Human { .. }, PlayerConfig::Engine { .. }) => Some(Color::White),
            (PlayerConfig::Engine { .. }, PlayerConfig::Human { .. }) => Some(Color::Black),
            _ => None,
        };

        let should_pop_two = human_color
            .map(|c| controller.position.turn() == c)
            .unwrap_or(false);

        controller.take_back_moves(if should_pop_two { 2 } else { 1 })?;

        let (white_time, black_time) = controller.get_current_times();
        let fen = Fen::from_position(controller.position.clone(), EnPassantMode::Legal).to_string();

        let move_revision = controller.move_event_revision();
        let move_event = GameMoveEvent {
            game_id: game_id.to_string(),
            session: controller.session,
            revision: move_revision,
            moves: controller.moves.clone(),
            fen,
            white_time,
            black_time,
        };
        controller
            .attempt_event_emission(GameEventKind::Move, move_revision, || move_event.emit(app));

        let terminal_attempt_claimed = attempt_terminal_event_emission(&mut controller, app);
        if !terminal_attempt_claimed && controller.is_engine_turn() {
            if let Some(tx) = &controller.move_notify_tx {
                let _ = tx.try_send(());
            }
        }

        let state = controller.get_state();
        drop(controller);
        if terminal_attempt_claimed {
            let _ = game.shutdown.send(true);
        }
        Ok(state)
    }

    pub async fn resign(
        &self,
        game_id: &str,
        expected_session: u64,
        color: &str,
        app: &AppHandle,
    ) -> Result<GameState, Error> {
        let lifecycle = self.lifecycle_lease(game_id);
        let _operation = lifecycle.lock().await;
        let game = self.current_session(game_id, expected_session).await?;

        let mut controller = game.controller.write().await;

        if !self.session_is_current(game_id, expected_session) {
            return Err(Error::Conflict(
                "game session changed before resignation commit".into(),
            ));
        }

        if controller.status != GameStatus::Playing {
            return Err(Error::GameNotInProgress);
        }

        let result = match color {
            "white" => GameResult::BlackWins {
                reason: GameEndReason::Resignation,
            },
            "black" => GameResult::WhiteWins {
                reason: GameEndReason::Resignation,
            },
            _ => return Err(Error::InvalidColor(color.to_string())),
        };

        let finished = controller.end_game(result);
        attempt_terminal_event_emission(&mut controller, app);

        let state = controller.get_state();
        drop(controller);
        if finished {
            let _ = game.shutdown.send(true);
        }
        Ok(state)
    }

    /// Shuts every live session down, joins its loop and unconditionally finishes
    /// exact engine cleanup before retiring it. An empty join slot after a
    /// cancelled timeout fallback does not prove that engine cleanup completed.
    ///
    /// The sessions are collected before the first `await` — holding a `DashMap`
    /// iterator across one would deadlock against the loop's own
    /// `complete_exact`, which removes the entry it is joining on.
    pub async fn shutdown_all(&self, join_budget: Duration) -> Result<(), Error> {
        self.sealed.store(true, Ordering::SeqCst);
        drop(self.registration.lock().await);
        let mut failures = Vec::new();
        let mut visited = HashSet::new();
        loop {
            let sessions: Vec<_> = self
                .games
                .iter()
                .filter(|entry| !visited.contains(&entry.session))
                .map(|entry| (entry.key().clone(), entry.value().clone()))
                .collect();
            if sessions.is_empty() {
                break;
            }
            visited.extend(sessions.iter().map(|(_, session)| session.session));
            let results = futures_util::future::join_all(sessions.into_iter().map(
                |(game_id, session)| async move {
                    let result = session.finish_retired(join_budget).await;
                    let mut metadata = self.session_metadata.lock().await;
                    self.retire_live_locked(&mut metadata, &game_id, session.session);
                    (game_id, result)
                },
            ))
            .await;
            for (game_id, result) in results {
                if let Err(error) = result {
                    failures.push(format!("{game_id}: {error}"));
                }
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(Error::Conflict(format!(
                "failed to shut down one or more games: {}",
                failures.join("; ")
            )))
        }
    }

    pub async fn abort_game(&self, game_id: &str, expected_session: u64) -> Result<(), Error> {
        let lifecycle = self.lifecycle_lease(game_id);
        let _transition = lifecycle.lock().await;
        self.current_session(game_id, expected_session).await?;
        let removed = {
            let mut metadata = self.session_metadata.lock().await;
            self.retire_live_locked(&mut metadata, game_id, expected_session)
        };
        let Some(game) = removed else {
            return Err(Error::Conflict(
                "game session changed before abort commit".into(),
            ));
        };
        let mut retirement = RemovedSessionRetirement::new(
            game,
            game_id.to_owned(),
            EngineDeadlines::default().quit,
        );
        // The abort has committed: the session is tombstoned and removed. The
        // armed retirement owner is responsible for pending teardown, including
        // cancellation. Completed cleanup failures are logged, and the committed
        // abort returns Ok. Shutdown instead propagates cleanup failures: there the
        // caller is `shutdown_backend`, which must know whether a child survived.
        let _ = retirement.finish().await;
        Ok(())
    }

    pub async fn get_engine_logs(
        &self,
        game_id: &str,
        expected_session: u64,
        color: &str,
    ) -> Result<Vec<EngineLog>, Error> {
        let lifecycle = self.lifecycle_lease(game_id);
        let _operation = lifecycle.lock().await;
        let game = self.current_session(game_id, expected_session).await?;

        let engine = {
            let controller = game.controller.read().await;
            match color {
                "white" => controller.white_engine.clone(),
                "black" => controller.black_engine.clone(),
                _ => return Err(Error::InvalidColor(color.to_string())),
            }
        };

        if let Some(engine_arc) = engine {
            engine_arc.actor.logs().await
        } else {
            Ok(Vec::new())
        }
    }
}

impl Default for GameManager {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug)]
struct OpeningBookSelection {
    initial_fen: String,
    initial_moves: Vec<String>,
}

struct OpeningBookResult {
    config: GameConfig,
    polyglot_book: Option<CancellablePolyglotBook>,
    polyglot_max_ply: usize,
}

#[cfg(test)]
fn select_random_epd_entry(reader: impl BufRead) -> Result<OpeningBookSelection, Error> {
    select_random_epd_entry_cancellable(reader, &CancellationToken::new())
}

fn select_random_epd_entry_cancellable(
    mut reader: impl BufRead,
    cancellation: &CancellationToken,
) -> Result<OpeningBookSelection, Error> {
    let mut rng = rand::thread_rng();
    let mut selected = None;
    let mut seen = 0_u64;
    while let Some(line) = read_epd_line_cancellable(&mut reader, cancellation)? {
        ensure_opening_book_not_cancelled(cancellation)?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let (fields, operations) = split_epd_position_and_operations(line)?;
        validate_epd_operations(operations)?;
        let fen = format!(
            "{} {} {} {} 0 1",
            fields[0], fields[1], fields[2], fields[3]
        );
        parse_fen_to_position(&fen)?;
        seen = seen
            .checked_add(1)
            .ok_or_else(|| Error::ResourceLimit("too many EPD entries".into()))?;
        if rng.gen_range(0..seen) == 0 {
            selected = Some(fen);
        }
    }
    let selected_line = selected.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Opening book EPD has no entries",
        )
    })?;

    Ok(OpeningBookSelection {
        initial_fen: selected_line,
        initial_moves: Vec::new(),
    })
}

/// Reads one EPD line without allowing an untrusted missing newline to grow an
/// allocation indefinitely. `fill_buf` is consumed incrementally so a
/// cancellation is also observed while a single line is being read.
fn read_epd_line_cancellable(
    reader: &mut impl BufRead,
    cancellation: &CancellationToken,
) -> Result<Option<String>, Error> {
    let mut line = Vec::new();
    loop {
        ensure_opening_book_not_cancelled(cancellation)?;
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            break;
        }

        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let new_len = line.len().checked_add(consumed).ok_or_else(|| {
            Error::ResourceLimit("opening-book EPD line exceeds the configured size limit".into())
        })?;
        if new_len > MAX_OPENING_BOOK_EPD_LINE_BYTES {
            return Err(Error::ResourceLimit(
                "opening-book EPD line exceeds the configured size limit".into(),
            ));
        }
        line.extend_from_slice(&available[..consumed]);
        reader.consume(consumed);
        if newline.is_some() {
            break;
        }
    }

    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    String::from_utf8(line)
        .map(Some)
        .map_err(|_| Error::InvalidInput("opening-book EPD is not valid UTF-8".into()))
}

fn split_epd_position_and_operations(line: &str) -> Result<([&str; 4], &str), Error> {
    let mut fields = [""; 4];
    let mut remaining = line;
    for field in &mut fields {
        remaining = remaining.trim_start();
        let end = remaining
            .find(char::is_whitespace)
            .unwrap_or(remaining.len());
        if end == 0 {
            return Err(Error::InvalidInput(
                "EPD entry must contain exactly four FEN position fields".into(),
            ));
        }
        (*field, remaining) = remaining.split_at(end);
    }
    Ok((fields, remaining.trim()))
}

/// Validates the EPD operation-list grammar without interpreting individual engine opcodes.
/// A fifth/sixth FEN field therefore cannot be mistaken for an operation.
fn validate_epd_operations(operations: &str) -> Result<(), Error> {
    let mut remaining = operations;
    while !remaining.is_empty() {
        let mut quoted = false;
        let mut escaped = false;
        let mut end = None;
        for (index, character) in remaining.char_indices() {
            if escaped {
                escaped = false;
            } else if character == '\\' && quoted {
                escaped = true;
            } else if character == '"' {
                quoted = !quoted;
            } else if character == ';' && !quoted {
                end = Some(index);
                break;
            } else if character.is_control() {
                return Err(Error::InvalidInput(
                    "EPD operations must not contain control characters".into(),
                ));
            }
        }
        if quoted || escaped {
            return Err(Error::InvalidInput(
                "EPD operation contains an unterminated quoted operand".into(),
            ));
        }
        let end =
            end.ok_or_else(|| Error::InvalidInput("EPD operations must end with ';'".into()))?;
        let operation = remaining[..end].trim();
        let opcode = operation
            .split_whitespace()
            .next()
            .ok_or_else(|| Error::InvalidInput("EPD operation must contain an opcode".into()))?;
        if !opcode
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic())
            || !opcode
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            return Err(Error::InvalidInput(
                "EPD operation has an invalid opcode".into(),
            ));
        }
        remaining = remaining[end + 1..].trim_start();
    }
    Ok(())
}

struct OpeningBookPgnVisitor {
    selected: Option<OpeningBookSelection>,
    seen: u64,
    current_position: Chess,
    initial_position: Chess,
    castling_mode: CastlingMode,
    initial_fen: Option<String>,
    moves: Vec<String>,
    skip: bool,
    exceeded_resource_limit: bool,
}

impl OpeningBookPgnVisitor {
    fn new() -> Self {
        let start = Chess::default();
        Self {
            selected: None,
            seen: 0,
            current_position: start.clone(),
            initial_position: start,
            castling_mode: CastlingMode::Standard,
            initial_fen: None,
            moves: Vec::new(),
            skip: false,
            exceeded_resource_limit: false,
        }
    }
}

impl Visitor for OpeningBookPgnVisitor {
    type Result = Option<OpeningBookSelection>;

    fn begin_game(&mut self) {
        let start = Chess::default();
        self.current_position = start.clone();
        self.initial_position = start;
        self.castling_mode = CastlingMode::Standard;
        self.initial_fen = None;
        self.moves.clear();
        self.skip = false;
    }

    fn header(&mut self, key: &[u8], value: RawHeader<'_>) {
        if key == b"FEN" {
            let fen_text = value.decode_utf8_lossy().into_owned();
            match parse_fen_to_position(&fen_text) {
                Ok(position) => {
                    let parsed_fen: Fen = match fen_text.parse() {
                        Ok(fen) => fen,
                        Err(_) => {
                            self.skip = true;
                            return;
                        }
                    };
                    self.current_position = position.clone();
                    self.initial_position = position;
                    self.castling_mode = CastlingMode::detect(parsed_fen.as_setup());
                    self.initial_fen = Some(fen_text);
                }
                Err(_) => {
                    self.skip = true;
                }
            }
        }
    }

    fn end_headers(&mut self) -> Skip {
        Skip(self.skip)
    }

    fn san(&mut self, san: SanPlus) {
        if self.skip {
            return;
        }

        let mv = match san.san.to_move(&self.current_position) {
            Ok(mv) => mv,
            Err(_) => {
                self.skip = true;
                return;
            }
        };

        let uci = UciMove::from_move(&mv, self.castling_mode).to_string();
        if self.moves.len() == MAX_OPENING_BOOK_PGN_MOVES {
            self.exceeded_resource_limit = true;
            self.skip = true;
            return;
        }
        self.moves.push(uci);
        self.current_position.play_unchecked(&mv);
    }

    fn end_game(&mut self) -> Self::Result {
        if self.skip || self.moves.is_empty() {
            return None;
        }

        let initial_fen = self.initial_fen.clone().unwrap_or_else(|| {
            Fen::from_position(self.initial_position.clone(), EnPassantMode::Legal).to_string()
        });

        let candidate = OpeningBookSelection {
            initial_fen,
            initial_moves: self.moves.clone(),
        };

        self.seen = match self.seen.checked_add(1) {
            Some(seen) => seen,
            None => {
                self.exceeded_resource_limit = true;
                return None;
            }
        };
        let mut rng = rand::thread_rng();
        if rng.gen_range(0..self.seen) == 0 {
            self.selected = Some(candidate.clone());
        }

        Some(candidate)
    }
}

#[cfg(test)]
fn select_random_pgn_entry(input: impl Read) -> Result<OpeningBookSelection, Error> {
    select_random_pgn_entry_cancellable(input, &CancellationToken::new())
}

fn select_random_pgn_entry_cancellable(
    input: impl Read,
    cancellation: &CancellationToken,
) -> Result<OpeningBookSelection, Error> {
    let mut reader = BufferedReader::new(CancellableRead::new(input, cancellation));
    let mut visitor = OpeningBookPgnVisitor::new();

    loop {
        ensure_opening_book_not_cancelled(cancellation)?;
        match reader.read_game(&mut visitor) {
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(error) => return Err(map_read_error(error, cancellation)),
        }
    }

    if visitor.exceeded_resource_limit {
        return Err(Error::ResourceLimit(
            "opening-book PGN exceeds the configured game-size limit".into(),
        ));
    }

    visitor.selected.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Opening book PGN has no valid games",
        )
        .into()
    })
}

const MAX_OPENING_BOOK_BYTES: usize = 32 * 1024 * 1024;
const MAX_OPENING_BOOK_COMPRESSION_RATIO: u64 = 100;
const MAX_OPENING_BOOK_PGN_MOVES: usize = 10_000;
const MAX_OPENING_BOOK_EPD_LINE_BYTES: usize = 64 * 1024;

#[cfg(test)]
fn read_zip_inner(zip_bytes: &[u8]) -> Result<(String, Vec<u8>), Error> {
    read_zip_inner_cancellable(zip_bytes, &CancellationToken::new())
}

fn read_zip_inner_cancellable(
    zip_bytes: &[u8],
    cancellation: &CancellationToken,
) -> Result<(String, Vec<u8>), Error> {
    ensure_opening_book_not_cancelled(cancellation)?;
    let mut archive = zip::ZipArchive::new(Cursor::new(zip_bytes))?;
    if archive.len() != 1 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Opening book zip must contain exactly one file",
        )
        .into());
    }
    let mut inner = archive.by_index(0)?;
    let name = inner.name().to_string();
    let compressed = inner.compressed_size();
    let uncompressed = inner.size();
    if uncompressed > MAX_OPENING_BOOK_BYTES as u64
        || (compressed == 0 && uncompressed > 0)
        || (compressed > 0
            && uncompressed > compressed.saturating_mul(MAX_OPENING_BOOK_COMPRESSION_RATIO))
    {
        return Err(Error::ResourceLimit(
            "opening-book zip exceeds decompression safety limits".into(),
        ));
    }
    let mut buf = Vec::with_capacity(uncompressed as usize);
    let mut chunk = [0_u8; 16 * 1024];
    loop {
        // `ZipFile::read` performs decompression. Bound every such step so a
        // cancelled request releases its blocking-gateway permit promptly,
        // even while expanding one large archive member.
        ensure_opening_book_not_cancelled(cancellation)?;
        let read = inner.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        let new_len = buf.len().checked_add(read).ok_or_else(|| {
            Error::ResourceLimit("opening-book zip exceeds decompression safety limits".into())
        })?;
        if new_len > MAX_OPENING_BOOK_BYTES {
            return Err(Error::ResourceLimit(
                "opening-book zip exceeds decompression safety limits".into(),
            ));
        }
        buf.extend_from_slice(&chunk[..read]);
    }
    if buf.len() != uncompressed as usize {
        return Err(Error::InvalidInput(
            "opening-book zip size does not match its declared metadata".into(),
        ));
    }
    ensure_opening_book_not_cancelled(cancellation)?;
    Ok((name, buf))
}

fn ensure_opening_book_not_cancelled(cancellation: &CancellationToken) -> Result<(), Error> {
    if cancellation.is_cancelled() {
        Err(Error::Cancellation)
    } else {
        Ok(())
    }
}

fn opening_book_ext(name: &str) -> Option<&str> {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".epd") {
        Some("epd")
    } else if lower.ends_with(".pgn") {
        Some("pgn")
    } else if lower.ends_with(".bin") {
        Some("bin")
    } else if lower.ends_with(".zip") {
        Some("zip")
    } else {
        None
    }
}

fn normalize_polyglot_uci(uci: &str) -> String {
    match uci {
        "e1h1" => "e1g1".to_string(),
        "e1a1" => "e1c1".to_string(),
        "e8h8" => "e8g8".to_string(),
        "e8a8" => "e8c8".to_string(),
        _ => uci.to_string(),
    }
}

fn choose_weighted_index(weights: &[u16], rng: &mut impl Rng) -> usize {
    let total: u64 = weights.iter().map(|w| *w as u64).sum();
    if total == 0 {
        return rng.gen_range(0..weights.len());
    }

    choose_weighted_target(weights, rng.gen_range(0..total))
}

fn choose_weighted_target(weights: &[u16], mut target: u64) -> usize {
    for (index, weight) in weights.iter().enumerate() {
        let weight = *weight as u64;
        if target < weight {
            return index;
        }
        target -= weight;
    }

    weights.len().saturating_sub(1)
}

async fn apply_opening_book(
    config: GameConfig,
    authority: &crate::infra::path_authority::SharedPathAuthority,
) -> Result<OpeningBookResult, Error> {
    let Some(opening_book) = &config.opening_book else {
        return Ok(OpeningBookResult {
            config,
            polyglot_book: None,
            polyglot_max_ply: 0,
        });
    };

    let snapshot =
        authority.with_mut(|authority| authority.opening_book_descriptor(&opening_book.book))??;
    let max_ply = opening_book.max_ply.max(1);

    let cancellation = CancellationToken::new();
    BLOCKING_GATEWAY
        .spawn_cancellable(cancellation, move |cancellation| {
            apply_opening_book_descriptor(config, snapshot, max_ply, cancellation)
        })
        .await
}

fn apply_opening_book_descriptor(
    config: GameConfig,
    mut descriptor: crate::infra::path_authority::OpeningBookDescriptor,
    max_ply: usize,
    cancellation: &CancellationToken,
) -> Result<OpeningBookResult, Error> {
    ensure_opening_book_not_cancelled(cancellation)?;
    let file_name = descriptor.file_name.clone();
    let bytes = descriptor.read_bounded_bytes_cancellable(MAX_OPENING_BOOK_BYTES, cancellation)?;
    let ext = opening_book_ext(&file_name);

    let is_human_vs_human = matches!(
        (&config.white, &config.black),
        (PlayerConfig::Human { .. }, PlayerConfig::Human { .. })
    );

    enum BookAction {
        Selection(OpeningBookSelection),
        Polyglot(CancellablePolyglotBook),
        Skip,
    }

    let action = match ext {
        Some("epd") => BookAction::Selection(select_random_epd_entry_cancellable(
            BufReader::new(Cursor::new(bytes)),
            cancellation,
        )?),
        Some("pgn") => BookAction::Selection(select_random_pgn_entry_cancellable(
            Cursor::new(bytes),
            cancellation,
        )?),
        Some("bin") => {
            if is_human_vs_human {
                BookAction::Skip
            } else {
                BookAction::Polyglot(load_polyglot_book_cancellable(&bytes, cancellation)?)
            }
        }
        Some("zip") => {
            let (inner_name, data) = read_zip_inner_cancellable(&bytes, cancellation)?;
            match opening_book_ext(&inner_name) {
                Some("epd") => BookAction::Selection(select_random_epd_entry_cancellable(
                    BufReader::new(Cursor::new(data)),
                    cancellation,
                )?),
                Some("pgn") => BookAction::Selection(select_random_pgn_entry_cancellable(
                    Cursor::new(data),
                    cancellation,
                )?),
                Some("bin") => {
                    if is_human_vs_human {
                        BookAction::Skip
                    } else {
                        BookAction::Polyglot(load_polyglot_book_cancellable(&data, cancellation)?)
                    }
                }
                _ => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "Zip must contain a .pgn, .epd, or .bin file",
                    )
                    .into())
                }
            }
        }
        _ => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Unsupported opening book format. Use .pgn, .epd, .bin, or .zip",
            )
            .into())
        }
    };

    match action {
        BookAction::Selection(selection) => {
            let mut next = config;
            next.initial_fen = Some(selection.initial_fen);
            next.initial_moves = selection.initial_moves;
            Ok(OpeningBookResult {
                config: next,
                polyglot_book: None,
                polyglot_max_ply: 0,
            })
        }
        BookAction::Polyglot(book) => Ok(OpeningBookResult {
            config,
            polyglot_book: Some(book),
            polyglot_max_ply: max_ply,
        }),
        BookAction::Skip => Ok(OpeningBookResult {
            config,
            polyglot_book: None,
            polyglot_max_ply: 0,
        }),
    }
}

#[cfg(test)]
fn load_polyglot_book(bytes: &[u8]) -> Result<CancellablePolyglotBook, Error> {
    load_polyglot_book_cancellable(bytes, &CancellationToken::new())
}

#[derive(Clone, Copy)]
struct PolyglotRecord {
    key: u64,
    move_data: u16,
    weight: u16,
}

struct PolyglotMoveEntry {
    move_string: String,
    weight: u16,
}

/// A bounded, cancellation-aware Polyglot representation. The upstream
/// loader parses and sorts a whole file without checkpoints, so it cannot run
/// inside the shared blocking gateway without making cancellation advisory.
struct CancellablePolyglotBook {
    entries: Vec<PolyglotRecord>,
}

impl CancellablePolyglotBook {
    fn get_all_moves_from_fen(&self, fen: &str) -> Vec<PolyglotMoveEntry> {
        let Ok(key) = polyglot_hash_from_fen(fen) else {
            return Vec::new();
        };
        let Ok(mut index) = self.entries.binary_search_by_key(&key, |entry| entry.key) else {
            return Vec::new();
        };
        while index > 0 && self.entries[index - 1].key == key {
            index -= 1;
        }
        let mut moves = Vec::new();
        for entry in self.entries[index..]
            .iter()
            .take_while(|entry| entry.key == key)
        {
            if let Some(move_string) = polyglot_move_to_uci(entry.move_data) {
                moves.push(PolyglotMoveEntry {
                    move_string,
                    weight: entry.weight,
                });
            }
        }
        moves.sort_by_key(|entry| std::cmp::Reverse(entry.weight));
        moves
    }
}

fn polyglot_move_to_uci(move_data: u16) -> Option<String> {
    let from = ((move_data >> 6) & 0x3f) as u8;
    let to = (move_data & 0x3f) as u8;
    let promotion = match (move_data >> 12) & 0x0f {
        0 => None,
        1 => Some('n'),
        2 => Some('b'),
        3 => Some('r'),
        4 => Some('q'),
        _ => return None,
    };
    let square = |square: u8| {
        let file = (b'a' + square % 8) as char;
        let rank = (b'1' + square / 8) as char;
        format!("{file}{rank}")
    };
    let mut uci = format!("{}{}", square(from), square(to));
    if let Some(promotion) = promotion {
        uci.push(promotion);
    }
    Some(uci)
}

fn load_polyglot_book_cancellable(
    bytes: &[u8],
    cancellation: &CancellationToken,
) -> Result<CancellablePolyglotBook, Error> {
    ensure_opening_book_not_cancelled(cancellation)?;
    if bytes.len() > MAX_OPENING_BOOK_BYTES {
        return Err(Error::ResourceLimit(
            "Polyglot book exceeds the configured size limit".into(),
        ));
    }
    if !bytes.len().is_multiple_of(16) {
        return Err(Error::InvalidInput(
            "Polyglot book is not aligned to 16-byte records".into(),
        ));
    }
    let mut entries = Vec::with_capacity(bytes.len() / 16);
    // The remainder is provably empty: the multiple-of-16 check above returns early otherwise.
    let (records, _remainder) = bytes.as_chunks::<16>();
    debug_assert!(_remainder.is_empty());
    for (index, record) in records.iter().enumerate() {
        if index % 1024 == 0 {
            ensure_opening_book_not_cancelled(cancellation)?;
        }
        entries.push(PolyglotRecord {
            key: u64::from_be_bytes([
                record[0], record[1], record[2], record[3], record[4], record[5], record[6],
                record[7],
            ]),
            move_data: u16::from_be_bytes([record[8], record[9]]),
            weight: u16::from_be_bytes([record[10], record[11]]),
        });
    }
    cancellable_polyglot_sort(&mut entries, cancellation)?;
    Ok(CancellablePolyglotBook { entries })
}

fn cancellable_polyglot_sort(
    entries: &mut [PolyglotRecord],
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    if entries.len() < 2 {
        return Ok(());
    }
    let mut buffer = vec![
        PolyglotRecord {
            key: 0,
            move_data: 0,
            weight: 0,
        };
        entries.len()
    ];
    let mut width = 1_usize;
    while width < entries.len() {
        let mut start = 0;
        while start < entries.len() {
            ensure_opening_book_not_cancelled(cancellation)?;
            let mid = (start + width).min(entries.len());
            let end = (mid + width).min(entries.len());
            let (mut left, mut right, mut output) = (start, mid, start);
            while left < mid && right < end {
                if entries[left].key <= entries[right].key {
                    buffer[output] = entries[left];
                    left += 1;
                } else {
                    buffer[output] = entries[right];
                    right += 1;
                }
                output += 1;
                if output % 4096 == 0 {
                    ensure_opening_book_not_cancelled(cancellation)?;
                }
            }
            buffer[output..output + (mid - left)].copy_from_slice(&entries[left..mid]);
            output += mid - left;
            buffer[output..output + (end - right)].copy_from_slice(&entries[right..end]);
            entries[start..end].copy_from_slice(&buffer[start..end]);
            start = end;
        }
        width = width.saturating_mul(2);
    }
    Ok(())
}

fn spawn_engine_task<R: Runtime>(
    game_id: &GameId,
    controller: &Arc<RwLock<GameController>>,
    app: &AppHandle<R>,
    context: EngineRequestContext,
    manager: std::sync::Weak<GameManager>,
) -> tokio::task::JoinHandle<Result<(), Error>> {
    let game_id_clone = game_id.clone();
    let controller_clone = controller.clone();
    let app_clone = app.clone();
    tokio::spawn(async move {
        request_engine_move(
            &game_id_clone,
            &controller_clone,
            &app_clone,
            context,
            manager,
        )
        .await
    })
}

async fn maybe_start_engine(
    controller: &Arc<RwLock<GameController>>,
    engine_task: &Option<tokio::task::JoinHandle<Result<(), Error>>>,
) -> Option<EngineRequestContext> {
    let mut ctrl = controller.write().await;
    if engine_task.is_some() {
        return None;
    }
    ctrl.begin_engine_request()
}

async fn run_published_loop<R: Runtime>(
    game_id: GameId,
    live: Arc<LiveSession>,
    shutdown_rx: watch::Receiver<bool>,
    move_notify_rx: tokio::sync::mpsc::Receiver<()>,
    app: AppHandle<R>,
    manager: std::sync::Weak<GameManager>,
    start_loop_rx: tokio::sync::oneshot::Receiver<()>,
) {
    #[cfg(test)]
    let hook_key = (game_id.clone(), live.session);
    #[cfg(test)]
    RUN_PUBLISHED_LOOP_READY_HOOKS.run(&hook_key);
    let started = start_loop_rx.await.is_ok();
    #[cfg(test)]
    if let Some(resolve) = RUN_PUBLISHED_LOOP_RESOLUTIONS.take(&hook_key) {
        resolve(started);
    }

    if started {
        game_loop(game_id, live, shutdown_rx, move_notify_rx, app, manager).await;
        return;
    }

    let cleanup = live.terminate_registered_engines().await;
    if let Err(error) = &cleanup {
        error!(
            "Game {game_id} never-started engine cleanup failed: {}",
            error.diagnostic()
        );
    }
    live.cleanup.record(cleanup);
    if let Some(manager) = manager.upgrade() {
        let mut metadata = manager.session_metadata.lock().await;
        manager.retire_live_locked(&mut metadata, &game_id, live.session);
    }
}

fn log_cancelled_engine_error(game_id: &str, session: u64, error: &Error) {
    if !matches!(
        error,
        Error::Cancellation | Error::AnalysisCancelled | Error::EngineDisconnected
    ) {
        error!(
            "Game {game_id} session {session} cancelled engine move failed: {}",
            error.diagnostic()
        );
    }
}

async fn game_loop<R: Runtime>(
    game_id: GameId,
    live: Arc<LiveSession>,
    mut shutdown_rx: watch::Receiver<bool>,
    mut move_notify_rx: tokio::sync::mpsc::Receiver<()>,
    app: AppHandle<R>,
    manager: std::sync::Weak<GameManager>,
) {
    let controller = live.controller.clone();
    let mut clock_interval = interval(CLOCK_TICK_INTERVAL);
    #[cfg(not(test))]
    let mut engine_task: Option<tokio::task::JoinHandle<Result<(), Error>>> = None;
    #[cfg(not(test))]
    let mut engine_cancellation = None;
    #[cfg(test)]
    let (mut engine_task, mut engine_cancellation) = GAME_LOOP_ENGINE_TASKS
        .take(&(game_id.clone(), live.session))
        .map(|(task, cancellation)| (Some(task), Some(cancellation)))
        .unwrap_or_default();

    if let Some(context) = maybe_start_engine(&controller, &engine_task).await {
        engine_cancellation = Some(context.cancellation.clone());
        engine_task = Some(spawn_engine_task(
            &game_id,
            &controller,
            &app,
            context,
            manager.clone(),
        ));
    }

    loop {
        tokio::select! {
            biased;

            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    info!("Game {} shutting down", game_id);
                    if let Some(task) = engine_task.take() {
                        task.abort();
                        let _ = task.await;
                    }
                    break;
                }
            }

            result = async {
                if let Some(ref mut task) = engine_task {
                    Some(task.await)
                } else {
                    std::future::pending::<Option<Result<Result<(), Error>, tokio::task::JoinError>>>().await
                }
            } => {
                engine_task = None;
                let cancellation = engine_cancellation.take();

                match result {
                    Some(Ok(Ok(()))) => {}
                    Some(Ok(Err(e))) => {
                        let mut ctrl = controller.write().await;
                        if !cancellation.as_ref().is_some_and(CancellationToken::is_cancelled) {
                            error!("Engine move error: {:?}", e);
                            ctrl.engine_thinking = false;
                            if ctrl.status == GameStatus::Playing {
                                ctrl.end_game(GameResult::Interrupted {
                                    reason: GameInterruptionReason::EngineFailure,
                                    snapshot: e.engine_failure_snapshot().cloned(),
                                });
                            }
                            attempt_terminal_event_emission(&mut ctrl, &app);
                            break;
                        } else {
                            log_cancelled_engine_error(&game_id, live.session, &e);
                        }
                    }
                    Some(Err(join_error)) => {
                        if join_error.is_cancelled() {
                            continue;
                        }
                        error!("Engine task join failed: {join_error}");
                        let mut ctrl = controller.write().await;
                        if cancellation.as_ref().is_some_and(CancellationToken::is_cancelled) {
                            continue;
                        }
                        ctrl.engine_thinking = false;
                        if ctrl.status == GameStatus::Playing {
                            ctrl.end_game(GameResult::Interrupted {
                                reason: GameInterruptionReason::EngineTaskFailed,
                                snapshot: None,
                            });
                        }
                        attempt_terminal_event_emission(&mut ctrl, &app);
                        break;
                    }
                    None => {
                        error!("game loop observed an impossible empty engine-task completion");
                        break;
                    }
                }
                if let Some(context) = maybe_start_engine(&controller, &engine_task).await {
                    engine_cancellation = Some(context.cancellation.clone());
                    engine_task = Some(spawn_engine_task(
                        &game_id,
                        &controller,
                        &app,
                        context,
                        manager.clone(),
                    ));
                }
            }

            _ = move_notify_rx.recv() => {
                if let Some(context) = maybe_start_engine(&controller, &engine_task).await {
                    engine_cancellation = Some(context.cancellation.clone());
                    engine_task = Some(spawn_engine_task(
                        &game_id,
                        &controller,
                        &app,
                        context,
                        manager.clone(),
                    ));
                }
            }

            _ = clock_interval.tick() => {
                let is_finished;

                {
                    let mut ctrl = controller.write().await;

                    if ctrl.status != GameStatus::Playing {
                        break;
                    }

                    if let Some(result) = ctrl.settle_active_clock() {
                        ctrl.end_game(result);
                        attempt_terminal_event_emission(&mut ctrl, &app);
                        break;
                    }

                    let (white_time, black_time) = ctrl.get_current_times();
                    ctrl.bump_revision();
                    let clock_event = ClockUpdateEvent {
                        game_id: game_id.clone(),
                        session: ctrl.session,
                        revision: ctrl.revision,
                        white_time,
                        black_time,
                    };
                    let clock_revision = ctrl.revision;
                    ctrl.attempt_event_emission(GameEventKind::Clock, clock_revision, || {
                        clock_event.emit(&app)
                    });

                    is_finished = ctrl.status != GameStatus::Playing;
                }

                if is_finished {
                    break;
                }
            }
        }
    }

    if let Some(task) = engine_task.take() {
        task.abort();
        let _ = task.await;
    }

    let engines = {
        let ctrl = controller.read().await;
        [ctrl.white_engine.clone(), ctrl.black_engine.clone()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
    };
    let cleanup = terminate_game_engines(&live.engine_supervisor, engines).await;
    if let Err(error) = &cleanup {
        error!("Game {game_id} engine cleanup failed: {error}");
    }
    live.cleanup.record(cleanup);

    if let Some(manager) = manager.upgrade() {
        manager
            .complete_exact(&game_id, live.session, &controller)
            .await;
    }
    info!("Game loop ended for {}", game_id);
}

fn try_polyglot_book_move(controller: &GameController) -> Option<String> {
    let book = controller.polyglot_book.as_ref()?;

    if controller.moves.len() >= controller.polyglot_max_ply {
        return None;
    }

    // Polyglot hashes the en-passant file when an adjacent pawn can capture, even if it is pinned.
    let fen =
        Fen::from_position(controller.position.clone(), EnPassantMode::PseudoLegal).to_string();
    let entries = book.get_all_moves_from_fen(&fen);

    if entries.is_empty() {
        return None;
    }

    let mut rng = rand::thread_rng();
    let legal_moves = entries
        .into_iter()
        .filter_map(|entry| {
            let uci = normalize_polyglot_uci(&entry.move_string);
            let parsed = UciMove::from_ascii(uci.as_bytes()).ok()?;
            parsed.to_move(&controller.position).ok()?;
            Some((uci, entry.weight))
        })
        .collect::<Vec<_>>();

    if legal_moves.is_empty() {
        return None;
    }

    let weights = legal_moves.iter().map(|(_, w)| *w).collect::<Vec<_>>();
    let selected = choose_weighted_index(&weights, &mut rng);
    Some(legal_moves[selected].0.clone())
}

async fn request_engine_move<R: Runtime>(
    game_id: &str,
    controller: &Arc<RwLock<GameController>>,
    app: &AppHandle<R>,
    context: EngineRequestContext,
    manager: std::sync::Weak<GameManager>,
) -> Result<(), Error> {
    // Try polyglot book move first (only for engine turns with a loaded book)
    {
        let ctrl = controller.read().await;
        let book_move = try_polyglot_book_move(&ctrl);
        let turn = ctrl.position.turn();
        drop(ctrl);

        if let Some(book_uci) = book_move {
            let Some(manager) = manager.upgrade() else {
                return Ok(());
            };
            let lifecycle = manager.lifecycle_lease(game_id);
            let _operation = lifecycle.lock().await;
            let mut ctrl = controller.write().await;
            if !manager.session_is_current(game_id, context.session)
                || !ctrl.accepts_engine_context(&context)
                || ctrl.position.turn() != turn
            {
                return Ok(());
            }

            let game_move = match ctrl.apply_move(&book_uci) {
                Ok(move_) => move_,
                Err(_) if matches!(ctrl.status, GameStatus::Finished { .. }) => {
                    attempt_terminal_event_emission(&mut ctrl, app);
                    return Ok(());
                }
                Err(error) => return Err(error),
            };
            let (white_time, black_time) = ctrl.get_current_times();

            let move_revision = ctrl.move_event_revision();
            let move_event = GameMoveEvent {
                game_id: game_id.to_string(),
                session: ctrl.session,
                revision: move_revision,
                moves: ctrl.moves.clone(),
                fen: game_move.fen_after,
                white_time,
                black_time,
            };
            ctrl.attempt_event_emission(GameEventKind::Move, move_revision, || {
                move_event.emit(app)
            });

            attempt_terminal_event_emission(&mut ctrl, app);

            return Ok(());
        }
    }

    let (engine_arc, go_mode, initial_fen, moves, turn) = {
        let ctrl = controller.read().await;

        if ctrl.status != GameStatus::Playing {
            return Ok(());
        }

        let turn = ctrl.position.turn();
        let (engine_arc, player_config) = if turn == Color::White {
            (
                ctrl.white_engine
                    .as_ref()
                    .map(|engine| engine.actor.clone()),
                ctrl.config.white.clone(),
            )
        } else {
            (
                ctrl.black_engine
                    .as_ref()
                    .map(|engine| engine.actor.clone()),
                ctrl.config.black.clone(),
            )
        };

        let engine = match engine_arc {
            Some(e) => e,
            None => return Err(Error::EngineNotInitialized),
        };

        let go = match player_config {
            PlayerConfig::Engine { go, .. } => go,
            _ => return Err(Error::NotEngineTurn),
        };

        let initial_fen = ctrl.initial_fen.clone();
        let moves: Vec<String> = ctrl.moves.iter().map(|m| m.uci.clone()).collect();
        let (white_time, black_time) = ctrl.get_current_times();

        let go_mode = match (white_time, black_time, ctrl.clock.as_ref()) {
            (None, None, None) => go.unwrap_or(GoMode::Depth(20)),
            (Some(wtime), Some(btime), Some(clock)) => GoMode::PlayersTime(PlayersTime::new(
                u32::try_from(wtime)
                    .map_err(|_| Error::InvalidInput("white clock exceeds UCI range".into()))?,
                u32::try_from(btime)
                    .map_err(|_| Error::InvalidInput("black clock exceeds UCI range".into()))?,
                u32::try_from(clock.white_increment)
                    .map_err(|_| Error::InvalidInput("white increment exceeds UCI range".into()))?,
                u32::try_from(clock.black_increment)
                    .map_err(|_| Error::InvalidInput("black increment exceeds UCI range".into()))?,
            )),
            _ => {
                return Err(Error::Conflict(
                    "game clock state is asymmetric or incomplete".into(),
                ));
            }
        };

        (engine, go_mode, initial_fen, moves, turn)
    };

    if context.cancellation.is_cancelled() {
        return Ok(());
    }
    if let Err(error) = engine_arc.set_position(&initial_fen, &moves).await {
        return if context.cancellation.is_cancelled() {
            log_cancelled_engine_error(game_id, context.session, &error);
            Ok(())
        } else {
            Err(error)
        };
    }
    if context.cancellation.is_cancelled() {
        return Ok(());
    }
    let request_id = match engine_arc.start_search(&go_mode).await {
        Ok(request_id) => request_id,
        Err(error) if context.cancellation.is_cancelled() => {
            log_cancelled_engine_error(game_id, context.session, &error);
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    {
        let mut ctrl = controller.write().await;
        if !ctrl.register_engine_request_id(&context, request_id) {
            drop(ctrl);
            if let Err(error) = engine_arc.stop_current().await {
                log_cancelled_engine_error(game_id, context.session, &error);
            }
            return Ok(());
        }
    }
    let best_move = match engine_arc
        .wait_bestmove_cancellable(request_id, &context.cancellation)
        .await
    {
        Ok(best_move) => best_move,
        Err(error) if context.cancellation.is_cancelled() => {
            log_cancelled_engine_error(game_id, context.session, &error);
            return Ok(());
        }
        Err(error) => return Err(error),
    };

    let Some(manager) = manager.upgrade() else {
        return Ok(());
    };
    let lifecycle = manager.lifecycle_lease(game_id);
    let _operation = lifecycle.lock().await;
    let mut ctrl = controller.write().await;
    if !manager.session_is_current(game_id, context.session)
        || !ctrl.accepts_engine_result(&context, request_id)
        || ctrl.position.turn() != turn
    {
        return Ok(());
    }

    let game_move = match ctrl.apply_move(&best_move) {
        Ok(move_) => move_,
        Err(_) if matches!(ctrl.status, GameStatus::Finished { .. }) => {
            attempt_terminal_event_emission(&mut ctrl, app);
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let (white_time, black_time) = ctrl.get_current_times();

    let move_revision = ctrl.move_event_revision();
    let move_event = GameMoveEvent {
        game_id: game_id.to_string(),
        session: ctrl.session,
        revision: move_revision,
        moves: ctrl.moves.clone(),
        fen: game_move.fen_after,
        white_time,
        black_time,
    };
    ctrl.attempt_event_emission(GameEventKind::Move, move_revision, || move_event.emit(app));

    attempt_terminal_event_emission(&mut ctrl, app);

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn start_game(
    game_id: String,
    config: GameConfig,
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<GameState, Error> {
    info!("Starting game with ID {}", game_id);
    state
        .game_manager
        .start_game(
            game_id,
            config,
            app,
            state.pgn_path_authority.clone(),
            state.engine_supervisor.clone(),
        )
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn get_game_state(
    game_id: String,
    expected_session: u64,
    state: tauri::State<'_, crate::AppState>,
) -> Result<GameState, Error> {
    state
        .game_manager
        .get_game_state(&game_id, expected_session)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn make_game_move(
    game_id: String,
    expected_session: u64,
    uci: String,
    expected_ply: u32,
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<GameState, Error> {
    state
        .game_manager
        .make_move(&game_id, expected_session, &uci, expected_ply, &app)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn take_back_game_move(
    game_id: String,
    expected_session: u64,
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<GameState, Error> {
    state
        .game_manager
        .take_back_move(&game_id, expected_session, &app)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn resign_game(
    game_id: String,
    expected_session: u64,
    color: String,
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<GameState, Error> {
    state
        .game_manager
        .resign(&game_id, expected_session, &color, &app)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn abort_game(
    game_id: String,
    expected_session: u64,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), Error> {
    state
        .game_manager
        .abort_game(&game_id, expected_session)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn get_game_engine_logs(
    game_id: String,
    expected_session: u64,
    color: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<EngineLog>, Error> {
    state
        .game_manager
        .get_engine_logs(&game_id, expected_session, &color)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_engine_move_logs_failed_stop_and_keeps_playing() {
        for stale_registration in [false, true] {
            let capture = crate::error::LogCaptureScope::start();
            let game_id = "cancelled-stop-proof";
            let manager = Arc::new(GameManager::new());
            let (live, controller) = test_live_session(game_id, 1);
            let actor = EngineActor::recording_failure_test_actor(
                &[],
                true,
                Some("cancelled-reap-native-cause"),
            );
            let registered = register_test_game_engine_with_actor(
                &live.engine_supervisor,
                game_id,
                1,
                "white",
                "test-engine-id",
                "test-engine",
                actor,
            )
            .await;
            let mut context = {
                let mut ctrl = controller.write().await;
                ctrl.config.white = fake_engine_player();
                ctrl.white_engine = Some(registered);
                ctrl.begin_engine_request().unwrap()
            };
            if stale_registration {
                context.nonce += 1;
            }
            let cancellation = context.cancellation.clone();
            let app = tauri::test::mock_app();
            let (result, ()) = tokio::time::timeout(TEST_WAIT, async {
                tokio::join!(
                    request_engine_move(
                        game_id,
                        &controller,
                        app.handle(),
                        context,
                        Arc::downgrade(&manager)
                    ),
                    async {
                        if stale_registration {
                            return;
                        }
                        loop {
                            if controller
                                .read()
                                .await
                                .active_engine_request
                                .as_ref()
                                .is_some_and(|request| request.request_id.is_some())
                            {
                                cancellation.cancel();
                                break;
                            }
                            tokio::task::yield_now().await;
                        }
                    }
                )
            })
            .await
            .unwrap();
            result.unwrap();
            assert_eq!(controller.read().await.status, GameStatus::Playing);
            assert_eq!(
                controller
                    .read()
                    .await
                    .active_engine_request
                    .as_ref()
                    .unwrap()
                    .request_id
                    .is_none(),
                stale_registration
            );
            assert!(capture
                .records()
                .iter()
                .any(|record| record.level == log::Level::Error
                    && record.message.contains(
                        "Game cancelled-stop-proof session 1 cancelled engine move failed"
                    )
                    && record.message.contains("cancelled-reap-native-cause")
                    && record.message.contains("fake stdin closed")));
        }
    }

    #[tokio::test]
    async fn cancelled_game_loop_logs_cleanup_failure_and_keeps_playing() {
        let capture = crate::error::LogCaptureScope::start();
        let game_id = "cancelled-loop-proof";
        let manager = Arc::new(GameManager::new());
        let (live, controller) = test_live_session(game_id, 1);
        manager
            .publish_live(game_id.into(), 1, live.clone(), || {})
            .await
            .unwrap();
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let task = tokio::spawn(async {
            Err(Error::with_cleanup(
                Error::Cancellation,
                Err(std::io::Error::other("loop-reap-native-cause").into()),
            ))
        });
        GAME_LOOP_ENGINE_TASKS.arm((game_id.into(), 1), (task, cancellation));
        let (_move_tx, move_rx) = tokio::sync::mpsc::channel(1);
        let app = tauri::test::mock_app();
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events!(
                GameOverEvent,
                ClockUpdateEvent
            ))
            .mount_events(&app);
        tokio::time::timeout(TEST_WAIT, async {
            tokio::join!(
                game_loop(
                    game_id.into(),
                    live.clone(),
                    live.shutdown.subscribe(),
                    move_rx,
                    app.handle().clone(),
                    Arc::downgrade(&manager)
                ),
                async {
                    while !capture
                        .messages()
                        .iter()
                        .any(|message| message.contains("loop-reap-native-cause"))
                    {
                        tokio::task::yield_now().await;
                    }
                    assert_eq!(controller.read().await.status, GameStatus::Playing);
                    live.shutdown.send(true).unwrap();
                }
            );
        })
        .await
        .unwrap();
        assert!(capture
            .records()
            .iter()
            .any(|record| record.level == log::Level::Error
                && record
                    .message
                    .contains("Game cancelled-loop-proof session 1 cancelled engine move failed")
                && record.message.contains("loop-reap-native-cause")));
    }

    async fn run_engine_completion_case(
        game_id: &str,
        task: tokio::task::JoinHandle<Result<(), Error>>,
        prior: Option<GameResult>,
    ) -> (Arc<GameManager>, Arc<RwLock<GameController>>) {
        let manager = Arc::new(GameManager::new());
        let (live, controller) = test_live_session(game_id, 1);
        {
            let mut ctrl = controller.write().await;
            ctrl.apply_move_no_clock("e2e4").unwrap();
            ctrl.engine_thinking = true;
            if let Some(result) = prior {
                ctrl.end_game(result);
            }
        }
        manager
            .publish_live(game_id.into(), 1, live.clone(), || {})
            .await
            .unwrap();
        GAME_LOOP_ENGINE_TASKS.arm((game_id.into(), 1), (task, CancellationToken::new()));
        let (_move_tx, move_rx) = tokio::sync::mpsc::channel(1);
        let app = tauri::test::mock_app();
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events!(
                GameOverEvent,
                ClockUpdateEvent
            ))
            .mount_events(&app);
        let attempts = Arc::new(AtomicU64::new(0));
        let observed = attempts.clone();
        use tauri::Listener;
        app.listen_any("game-over-event", move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
        });
        tokio::time::timeout(
            TEST_WAIT,
            game_loop(
                game_id.into(),
                live.clone(),
                live.shutdown.subscribe(),
                move_rx,
                app.handle().clone(),
                Arc::downgrade(&manager),
            ),
        )
        .await
        .unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        (manager, controller)
    }

    #[tokio::test]
    async fn engine_completion_interrupts_with_safe_snapshot_and_retains_exact_terminal_state() {
        let safe = crate::engine::EngineTerminalSnapshot {
            kind: crate::engine::EngineFailureKind::ProtocolFailure,
            exit_status: None,
            reason: Some("Invalid engine command".into()),
            entries: vec![crate::engine::EngineTerminalEntry::InfoString(
                "Invalid engine command".into(),
            )],
        };
        let snapshot = safe.clone();
        let task = tokio::spawn(async move {
            Err(Error::EngineFailure {
                snapshot: Some(Box::new(snapshot)),
                cause: Box::new(Error::InvalidInput("private native diagnostic".into())),
                cleanup: None,
            })
        });
        let (manager, controller) =
            run_engine_completion_case("engine-completion-safe", task, None).await;
        let snapshot = manager
            .get_game_state("engine-completion-safe", 1)
            .await
            .unwrap();
        let result = serde_json::to_value(&snapshot.status).unwrap();
        assert_eq!(
            result["finished"]["result"],
            serde_json::json!({
                "type": "interrupted", "reason": "engineFailure", "snapshot": safe,
            })
        );
        assert!(!result.to_string().contains("private native"));
        assert_eq!(snapshot.moves.len(), 1);
        assert_eq!(snapshot.moves[0].uci, "e2e4");
        let mut ctrl = controller.write().await;
        assert!(!ctrl.engine_thinking);
        assert!(ctrl.terminal_attempt_claimed);
        let mut duplicate_attempts = 0;
        assert!(!attempt_terminal_event_emission_with(&mut ctrl, |_| {
            duplicate_attempts += 1;
            Ok(())
        }));
        assert_eq!(duplicate_attempts, 0);
        assert_eq!(snapshot.status, ctrl.status);
        assert_eq!(snapshot.current_fen, ctrl.get_state().current_fen);
        assert!(manager
            .get_game_state("engine-completion-safe", 2)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn engine_completion_join_failure_uses_only_generic_safe_reason() {
        let task = tokio::spawn(async { panic!("private join diagnostic") });
        let (manager, _) = run_engine_completion_case("engine-completion-join", task, None).await;
        let snapshot = manager
            .get_game_state("engine-completion-join", 1)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(snapshot.status).unwrap(),
            serde_json::json!({
                "finished": { "result": { "type": "interrupted", "reason": "engineTaskFailed", "snapshot": null } }
            })
        );
    }

    #[tokio::test]
    async fn engine_completion_unrequested_cancellation_interrupts_instead_of_hanging() {
        let task = tokio::spawn(async { Err(Error::Cancellation) });
        let (manager, controller) =
            run_engine_completion_case("unrequested-cancellation", task, None).await;
        let state = manager
            .get_game_state("unrequested-cancellation", 1)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(state.status).unwrap(),
            serde_json::json!({
                "finished": { "result": { "type": "interrupted", "reason": "engineFailure", "snapshot": null } }
            })
        );
        let ctrl = controller.read().await;
        assert!(!ctrl.engine_thinking);
        assert!(ctrl.terminal_attempt_claimed);
    }

    #[tokio::test]
    async fn engine_completion_preserves_prior_timeout_and_resignation() {
        for reason in [GameEndReason::Timeout, GameEndReason::Resignation] {
            let prior = GameResult::WhiteWins { reason };
            let task = tokio::spawn(async { Err(Error::EngineDisconnected) });
            let (manager, _) =
                run_engine_completion_case("engine-completion-race", task, Some(prior.clone()))
                    .await;
            assert_eq!(
                manager
                    .get_game_state("engine-completion-race", 1)
                    .await
                    .unwrap()
                    .status,
                GameStatus::Finished { result: prior }
            );
        }
    }

    #[tokio::test]
    async fn engine_completion_cancellation_keeps_game_playing() {
        for aborted in [false, true] {
            let game_id = if aborted {
                "engine-completion-aborted"
            } else {
                "engine-completion-cancelled"
            };
            let manager = Arc::new(GameManager::new());
            let (live, controller) = test_live_session(game_id, 1);
            manager
                .publish_live(game_id.into(), 1, live.clone(), || {})
                .await
                .unwrap();
            let task = if aborted {
                let task = tokio::spawn(std::future::pending::<Result<(), Error>>());
                task.abort();
                task
            } else {
                tokio::spawn(async { Err(Error::Cancellation) })
            };
            let cancellation = CancellationToken::new();
            if !aborted {
                cancellation.cancel();
            }
            GAME_LOOP_ENGINE_TASKS.arm((game_id.into(), 1), (task, cancellation));
            let (_move_tx, move_rx) = tokio::sync::mpsc::channel(1);
            let app = tauri::test::mock_app();
            tauri_specta::Builder::<tauri::test::MockRuntime>::new()
                .events(tauri_specta::collect_events!(
                    GameOverEvent,
                    ClockUpdateEvent
                ))
                .mount_events(&app);
            let loop_task = tokio::spawn(game_loop(
                game_id.into(),
                live.clone(),
                live.shutdown.subscribe(),
                move_rx,
                app.handle().clone(),
                Arc::downgrade(&manager),
            ));
            tokio::time::timeout(TEST_WAIT, async {
                while controller.read().await.revision == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert_eq!(controller.read().await.status, GameStatus::Playing);
            assert!(!controller.read().await.terminal_attempt_claimed);
            live.shutdown.send(true).unwrap();
            tokio::time::timeout(TEST_WAIT, loop_task)
                .await
                .unwrap()
                .unwrap();
        }
    }

    #[test]
    fn terminal_transition_freezes_clocks_and_legacy_abandonment_still_deserializes() {
        let mut config = human_config();
        config.white_time_control = Some(TimeControl {
            initial_time: 60_000,
            increment: 0,
        });
        config.black_time_control = config.white_time_control.clone();
        let mut ctrl = GameController::new("frozen-clock".into(), 1, config).unwrap();
        ctrl.end_game(GameResult::BlackWins {
            reason: GameEndReason::Resignation,
        });
        let times = ctrl.get_current_times();
        ctrl.clock.as_mut().unwrap().last_tick = Instant::now() - Duration::from_secs(20);
        assert_eq!(ctrl.get_current_times(), times);
        assert!(matches!(
            serde_json::from_value::<GameResult>(serde_json::json!({
                "type": "whiteWins", "reason": "abandonment"
            }))
            .unwrap(),
            GameResult::WhiteWins {
                reason: GameEndReason::Abandonment
            }
        ));
    }

    #[test]
    fn engine_games_refuse_excess_material_at_creation_but_human_games_keep_it() {
        let mut config = human_config();
        config.initial_fen = Some("4k3/8/8/8/8/8/PPPPPPPP/QQQ1K3 w - - 0 1".into());
        assert!(GameController::new("human".into(), 1, config.clone()).is_ok());
        for side in [Color::White, Color::Black] {
            let mut engine_config = config.clone();
            match side {
                Color::White => engine_config.white = fake_engine_player(),
                Color::Black => engine_config.black = fake_engine_player(),
            }
            assert!(matches!(
                GameController::new("engine".into(), 1, engine_config),
                Err(Error::EnginePositionRejected(_))
            ));
        }
        config.black = fake_engine_player();
        config.initial_fen = Some("4k3/8/8/8/8/NNNNNNNN/NN6/4K3 w - - 0 1".into());
        assert!(GameController::new("ten-knights".into(), 1, config).is_ok());
    }

    #[test]
    fn engine_game_takeback_restores_root_with_normalized_negative_halfmove() {
        let mut config = human_config();
        config.black = fake_engine_player();
        let fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - -1 1";
        config.initial_fen = Some(fen.into());
        let mut game = GameController::new("takeback".into(), 1, config).unwrap();
        let root = game.position.clone();

        game.apply_move("e2e4").unwrap();
        game.take_back_moves(1).unwrap();

        assert!(game.moves.is_empty());
        assert_eq!(game.position, root);
        assert_eq!(game.get_state().initial_fen, fen);
    }

    #[test]
    fn engine_game_clamps_wire_counters_without_replacing_request_state() {
        let mut config = human_config();
        config.black = fake_engine_player();
        let fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 150 200000";
        config.initial_fen = Some(fen.into());
        let game = GameController::new("clocks".into(), 1, config).unwrap();
        let state = game.get_state();
        assert_eq!(state.initial_fen, fen);
        assert_eq!(state.current_fen, fen);
    }
    use std::io::Write;

    use crate::engine::CLEANUP_FAILURE_LOG;
    #[cfg(unix)]
    use crate::engine::REGISTRATION_GUARD_DROPS;

    const TEST_WAIT: Duration = Duration::from_secs(15);

    async fn register_test_game_engine(
        supervisor: &Arc<EngineSupervisor>,
        game_id: &str,
        session: u64,
        side: &str,
        engine_id: &str,
        executable_id: &str,
    ) -> RegisteredGameEngine {
        let key = game_side_engine_key(game_id, session, side, engine_id).unwrap();
        let (actor, _) = EngineActor::recording_test_actor(&[]);
        register_test_actor(supervisor, key, actor, engine_id, executable_id).await
    }

    pub(super) async fn register_test_game_engine_with_actor(
        supervisor: &Arc<EngineSupervisor>,
        game_id: &str,
        session: u64,
        side: &str,
        engine_id: &str,
        executable_id: &str,
        actor: Arc<EngineActor>,
    ) -> RegisteredGameEngine {
        let key = game_side_engine_key(game_id, session, side, engine_id).unwrap();
        register_test_actor(supervisor, key, actor, engine_id, executable_id).await
    }

    async fn register_test_actor(
        supervisor: &Arc<EngineSupervisor>,
        key: EngineKey,
        actor: Arc<EngineActor>,
        engine_id: &str,
        executable_id: &str,
    ) -> RegisteredGameEngine {
        let supervised = supervisor
            .replace_handle(
                key.clone(),
                actor,
                engine_id.into(),
                crate::infra::path_authority::PathRef {
                    id: executable_id.into(),
                },
            )
            .await
            .unwrap();
        RegisteredGameEngine {
            actor: supervised.actor,
            key,
            generation: supervised.generation,
        }
    }

    async fn register_unrelated_test_engine(
        supervisor: &Arc<EngineSupervisor>,
        game_id: &str,
    ) -> RegisteredGameEngine {
        let key = EngineKey::new(
            format!("unrelated:{game_id}"),
            "unrelated-test-engine".into(),
        )
        .unwrap();
        let (actor, _) = EngineActor::recording_test_actor(&[]);
        register_test_actor(
            supervisor,
            key,
            actor,
            "unrelated-test-engine",
            &format!("unrelated-{game_id}"),
        )
        .await
    }

    fn assert_unrelated_engine_survives(
        supervisor: &EngineSupervisor,
        unrelated: &RegisteredGameEngine,
    ) {
        assert!(supervisor
            .get_exact(&unrelated.key)
            .is_some_and(|entry| entry.generation == unrelated.generation));
    }

    fn registration_cleanup_messages(key: &EngineKey, generation: u64) -> Vec<String> {
        let identity = format!("{}:{} generation={generation}", key.tab, key.engine);
        let errors = CLEANUP_FAILURE_LOG
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        errors
            .iter()
            .filter(|message| message.contains(&identity))
            .cloned()
            .collect()
    }

    fn game_cleanup_messages(game_id: &str, session: u64, event: &str) -> Vec<String> {
        let identity = format!("game_id={game_id} session={session} event={event}");
        let errors = CLEANUP_FAILURE_LOG
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        errors
            .iter()
            .filter(|message| message.contains(&identity))
            .cloned()
            .collect()
    }

    #[cfg(unix)]
    fn guard_drop_records(key: &EngineKey, generation: u64) -> Vec<bool> {
        REGISTRATION_GUARD_DROPS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .filter(|(dropped_key, dropped_generation, _)| {
                dropped_key == key && *dropped_generation == generation
            })
            .map(|(_, _, completed)| *completed)
            .collect()
    }

    #[cfg(unix)]
    fn guard_drop_records_for_key(key: &EngineKey) -> Vec<(u64, bool)> {
        REGISTRATION_GUARD_DROPS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .filter(|(dropped_key, _, _)| dropped_key == key)
            .map(|(_, generation, completed)| (*generation, *completed))
            .collect()
    }

    async fn wait_until(mut condition: impl FnMut() -> bool) {
        tokio::time::timeout(TEST_WAIT, async {
            while !condition() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("condition did not become true before the test timeout");
    }

    #[cfg(unix)]
    async fn wait_for_generation(supervisor: &EngineSupervisor, key: &EngineKey) -> u64 {
        tokio::time::timeout(TEST_WAIT, async {
            loop {
                if let Some(engine) = supervisor.get_exact(key) {
                    break engine.generation;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("engine generation was not registered before the test timeout")
    }

    async fn wait_for_generation_gone(
        supervisor: &EngineSupervisor,
        key: &EngineKey,
        generation: u64,
    ) {
        wait_until(|| !supervisor.owns_generation(key, generation)).await;
    }

    #[cfg(unix)]
    async fn wait_for_guard_drop_completion(key: &EngineKey, generation: u64) {
        wait_until(|| guard_drop_records(key, generation).contains(&true)).await;
    }

    async fn assert_session_retired(manager: &GameManager, game_id: &str, _session: u64) {
        assert!(manager.games.get(game_id).is_none());
        let metadata = manager.session_metadata.lock().await;
        assert!(!metadata
            .snapshots
            .iter()
            .any(|snapshot| snapshot.game_id == game_id));
        assert!(!metadata.latest.contains_key(game_id));
    }

    async fn set_session_engines(
        controller: &Arc<RwLock<GameController>>,
        white: Option<RegisteredGameEngine>,
        black: Option<RegisteredGameEngine>,
    ) {
        let mut controller = controller.write().await;
        controller.white_engine = white;
        controller.black_engine = black;
    }

    pub(super) async fn publish_test_session(
        manager: &GameManager,
        game_id: &str,
        live: Arc<LiveSession>,
    ) {
        manager
            .publish_live(game_id.into(), live.session, live, || {})
            .await
            .unwrap();
    }

    async fn published_teardown_fixture(
        manager: &GameManager,
        supervisor: &Arc<EngineSupervisor>,
        game_id: &str,
        actors: [Arc<EngineActor>; 2],
    ) -> (
        Arc<LiveSession>,
        [RegisteredGameEngine; 2],
        RegisteredGameEngine,
    ) {
        let unrelated = register_unrelated_test_engine(supervisor, game_id).await;
        let [white_actor, black_actor] = actors;
        let white = register_test_game_engine_with_actor(
            supervisor,
            game_id,
            1,
            "white",
            "teardown-white",
            "teardown-white-handle",
            white_actor,
        )
        .await;
        let black = register_test_game_engine_with_actor(
            supervisor,
            game_id,
            1,
            "black",
            "teardown-black",
            "teardown-black-handle",
            black_actor,
        )
        .await;
        let (live, controller) = test_live_session_with_supervisor(game_id, 1, supervisor.clone());
        set_session_engines(&controller, Some(white.clone()), Some(black.clone())).await;
        let join = loop_exits_without_engine_cleanup(live.shutdown.subscribe());
        *live
            .join
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(join);
        publish_test_session(manager, game_id, live.clone()).await;
        (live, [white, black], unrelated)
    }

    fn healthy_teardown_actors() -> [Arc<EngineActor>; 2] {
        [
            EngineActor::recording_test_actor(&[]).0,
            EngineActor::recording_test_actor(&[]).0,
        ]
    }

    fn assert_teardown_engines_owned(
        supervisor: &EngineSupervisor,
        engines: &[RegisteredGameEngine; 2],
    ) {
        for engine in engines {
            assert!(supervisor.owns_generation(&engine.key, engine.generation));
        }
    }

    fn assert_published_teardown_untouched(
        manager: &GameManager,
        game_id: &str,
        live: &LiveSession,
        engines: &[RegisteredGameEngine; 2],
        unrelated: &RegisteredGameEngine,
    ) {
        assert!(manager.session_is_current(game_id, live.session));
        assert!(!*live.shutdown.borrow());
        assert!(live.join.lock().unwrap().is_some());
        assert_teardown_engines_owned(&live.engine_supervisor, engines);
        assert_unrelated_engine_survives(&live.engine_supervisor, unrelated);
    }

    async fn assert_published_teardown_finished_and_cleanup_unrelated_engine(
        manager: &GameManager,
        game_id: &str,
        live: &LiveSession,
        engines: &[RegisteredGameEngine; 2],
        unrelated: &RegisteredGameEngine,
    ) {
        for engine in engines {
            wait_for_generation_gone(&live.engine_supervisor, &engine.key, engine.generation).await;
        }
        assert!(*live.shutdown.borrow());
        assert!(live
            .join
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_none());
        assert_session_retired(manager, game_id, live.session).await;
        assert_unrelated_engine_survives(&live.engine_supervisor, unrelated);
        live.engine_supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[cfg(unix)]
    fn loop_exits_on_shutdown(
        mut shutdown_rx: watch::Receiver<bool>,
        supervisor: Arc<EngineSupervisor>,
        engines: Vec<RegisteredGameEngine>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            while shutdown_rx.changed().await.is_ok() {
                if *shutdown_rx.borrow() {
                    let _ = terminate_game_engines(&supervisor, engines).await;
                    return;
                }
            }
        })
    }

    fn loop_exits_without_engine_cleanup(
        mut shutdown_rx: watch::Receiver<bool>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            while shutdown_rx.changed().await.is_ok() {
                if *shutdown_rx.borrow() {
                    return;
                }
            }
        })
    }

    #[cfg(unix)]
    enum TestEngineScript {
        Responsive,
        Pending,
    }

    #[cfg(unix)]
    struct TestGameEngineBundle {
        _directory: tempfile::TempDir,
        config: GameConfig,
        authority: crate::infra::path_authority::SharedPathAuthority,
        white_engine_id: String,
        black_engine_id: String,
    }

    #[cfg(unix)]
    fn test_game_engine_bundle(
        game_id: &str,
        black_script: TestEngineScript,
        register_black: bool,
    ) -> TestGameEngineBundle {
        let directory = tempfile::tempdir().unwrap();
        let white_engine_id = format!("{game_id}-white-engine");
        let black_engine_id = format!("{game_id}-black-engine");
        let white_path = directory.path().join("white-engine.sh");
        let black_path = directory.path().join("black-engine.sh");
        let responsive = "#!/bin/sh\nwhile IFS= read -r line; do case \"$line\" in uci) echo uciok;; isready) echo readyok;; quit) exit 0;; esac; done\n";
        let black_source = match black_script {
            TestEngineScript::Responsive => responsive,
            TestEngineScript::Pending => {
                "#!/bin/sh\nwhile IFS= read -r line; do case \"$line\" in quit) exit 0;; esac; done\n"
            }
        };
        crate::infra::test_executable::publish_test_executable(&white_path, responsive, 0o700)
            .unwrap();
        crate::infra::test_executable::publish_test_executable(&black_path, black_source, 0o700)
            .unwrap();
        let mut path_authority = {
            #[cfg(target_os = "macos")]
            {
                PathAuthority::open_with_launch_root(
                    directory.path().join("registry.json"),
                    Vec::new(),
                    crate::infra::path_authority::EngineLaunchRoot::for_test(directory.path())
                        .unwrap(),
                )
                .unwrap()
            }
            #[cfg(not(target_os = "macos"))]
            {
                PathAuthority::open(directory.path().join("registry.json"), Vec::new()).unwrap()
            }
        };
        let white_handle = path_authority
            .register_engine_file(&white_path, &white_engine_id)
            .unwrap();
        let black_handle = if register_black {
            path_authority
                .register_engine_file(&black_path, &black_engine_id)
                .unwrap()
        } else {
            crate::infra::path_authority::EngineHandle {
                id: crate::infra::path_authority::PathRef {
                    id: format!("{game_id}-missing-black"),
                },
                kind: crate::infra::path_authority::EngineHandleKind::Engine,
            }
        };
        let player = |engine_id: String, handle: EngineHandle| PlayerConfig::Engine {
            name: engine_id.clone(),
            engine_id,
            handle,
            options: Vec::new(),
            go: None,
        };
        TestGameEngineBundle {
            _directory: directory,
            config: GameConfig {
                white: player(white_engine_id.clone(), white_handle),
                black: player(black_engine_id.clone(), black_handle),
                white_time_control: None,
                black_time_control: None,
                initial_fen: None,
                initial_moves: Vec::new(),
                opening_book: None,
            },
            authority: crate::infra::path_authority::SharedPathAuthority::installed(path_authority),
            white_engine_id,
            black_engine_id,
        }
    }

    #[cfg(unix)]
    fn game_side_keys(
        bundle: &TestGameEngineBundle,
        game_id: &str,
        session: u64,
    ) -> (EngineKey, EngineKey) {
        (
            game_side_engine_key(game_id, session, "white", &bundle.white_engine_id).unwrap(),
            game_side_engine_key(game_id, session, "black", &bundle.black_engine_id).unwrap(),
        )
    }

    #[cfg(unix)]
    fn assert_dropped_generation(key: &EngineKey, generation: u64) {
        assert!(
            guard_drop_records(key, generation)
                .iter()
                .any(|completed| *completed),
            "armed guard drop for {key:?} generation {generation} must finish"
        );
    }

    fn test_live_session(
        game_id: &str,
        session: u64,
    ) -> (Arc<LiveSession>, Arc<RwLock<GameController>>) {
        test_live_session_with_supervisor(game_id, session, Arc::new(EngineSupervisor::default()))
    }

    pub(super) fn test_live_session_with_supervisor(
        game_id: &str,
        session: u64,
        engine_supervisor: Arc<EngineSupervisor>,
    ) -> (Arc<LiveSession>, Arc<RwLock<GameController>>) {
        let controller = Arc::new(RwLock::new(
            GameController::new(game_id.into(), session, human_config()).unwrap(),
        ));
        let (shutdown, _) = watch::channel(false);
        (
            Arc::new(LiveSession {
                session,
                controller: controller.clone(),
                shutdown,
                cleanup: SessionCleanup::default(),
                join: std::sync::Mutex::new(None),
                engine_supervisor,
            }),
            controller,
        )
    }

    /// `start_game` and its loop are generic over the Tauri runtime, so a mock app can drive
    /// the real construction path.
    #[tokio::test]
    async fn start_game_runs_on_the_mock_runtime() {
        let game_id = "start_game_runs_on_the_mock_runtime";
        let app = tauri::test::mock_app();
        let manager = Arc::new(GameManager::new());

        let state = manager
            .start_game(
                game_id.into(),
                human_config(),
                app.handle().clone(),
                crate::infra::path_authority::SharedPathAuthority::uninitialized(),
                Arc::new(EngineSupervisor::default()),
            )
            .await
            .unwrap();

        assert_eq!(state.game_id, game_id);
        assert_eq!(state.status, GameStatus::Playing);
        assert!(manager.games.get(game_id).is_some());
        manager.abort_game(game_id, state.session).await.unwrap();
        assert!(manager.games.get(game_id).is_none());
    }

    struct CancelsAfterFirstRead {
        bytes: Cursor<Vec<u8>>,
        cancellation: CancellationToken,
        reads: usize,
    }

    impl Read for CancelsAfterFirstRead {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let chunk_len = buffer.len().min(1);
            let read = self.bytes.read(&mut buffer[..chunk_len])?;
            self.reads += 1;
            if self.reads == 1 {
                self.cancellation.cancel();
            }
            Ok(read)
        }
    }

    fn human_config() -> GameConfig {
        GameConfig {
            white: PlayerConfig::Human {
                name: "White".into(),
            },
            black: PlayerConfig::Human {
                name: "Black".into(),
            },
            white_time_control: None,
            black_time_control: None,
            initial_fen: None,
            initial_moves: Vec::new(),
            opening_book: None,
        }
    }

    fn polyglot_book_bytes(entries: &[(u64, &str, u16)]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(entries.len() * 16);
        for &(key, uci, weight) in entries {
            let uci = uci.as_bytes();
            assert_eq!(uci.len(), 4);
            let square = |file: u8, rank: u8| {
                assert!((b'a'..=b'h').contains(&file));
                assert!((b'1'..=b'8').contains(&rank));
                (rank - b'1') as u16 * 8 + (file - b'a') as u16
            };
            let from = square(uci[0], uci[1]);
            let to = square(uci[2], uci[3]);
            let move_data = (from << 6) | to;

            bytes.extend_from_slice(&key.to_be_bytes());
            bytes.extend_from_slice(&move_data.to_be_bytes());
            bytes.extend_from_slice(&weight.to_be_bytes());
            bytes.extend_from_slice(&0_u32.to_be_bytes());
        }
        bytes
    }

    fn controller_with_polyglot_book(
        initial_fen: &str,
        move_uci: &str,
        entries: &[(u64, &str, u16)],
    ) -> GameController {
        let mut config = human_config();
        config.initial_fen = Some(initial_fen.into());
        let mut controller = GameController::new("polyglot-test".into(), 1, config).unwrap();
        controller.apply_move(move_uci).unwrap();
        controller.polyglot_book = Some(load_polyglot_book(&polyglot_book_bytes(entries)).unwrap());
        controller.polyglot_max_ply = 16;
        controller
    }

    fn mating_config(white: PlayerConfig) -> GameConfig {
        GameConfig {
            white,
            black: PlayerConfig::Human {
                name: "Black".into(),
            },
            white_time_control: None,
            black_time_control: None,
            // White has Qg7#, which lets this test cover the terminal-move
            // publication protocol without an external engine process.
            initial_fen: Some("7k/8/5KQ1/8/8/8/8/8 w - - 0 1".into()),
            initial_moves: Vec::new(),
            opening_book: None,
        }
    }

    fn fake_engine_player() -> PlayerConfig {
        PlayerConfig::Engine {
            name: "Engine".into(),
            engine_id: "test-engine-id".into(),
            handle: EngineHandle {
                id: crate::infra::path_authority::PathRef {
                    id: "test-engine".into(),
                },
                kind: crate::infra::path_authority::EngineHandleKind::Engine,
            },
            options: Vec::new(),
            go: None,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn game_engine_is_registered_while_uci_initialization_is_pending() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("pending-uci-engine.sh");
        crate::infra::test_executable::publish_test_executable(
            &script,
            "#!/bin/sh\nwhile IFS= read -r line; do case \"$line\" in quit) exit 0;; esac; done\n",
            0o700,
        )
        .unwrap();
        let executable = EngineExecutable::test_fixture(
            std::fs::File::open(&script).unwrap(),
            directory.path().to_path_buf(),
            Vec::new(),
        );
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(
            PathAuthority::open(directory.path().join("registry.json"), Vec::new()).unwrap(),
        );
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = game_side_engine_key("game-id", 9, "white", "application-engine-id").unwrap();
        let registration = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            async move {
                spawn_configured_game_engine_with_executable(
                    GameEngineRegistration {
                        supervisor,
                        key,
                        engine_id: "application-engine-id".into(),
                        executable_ref: crate::infra::path_authority::PathRef {
                            id: "pending-executable".into(),
                        },
                    },
                    executable,
                    &[],
                    &authority,
                    false,
                )
                .await
            }
        });

        tokio::time::timeout(Duration::from_secs(1), async {
            while supervisor.get_exact(&key).is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        registration.abort();
        let _ = registration.await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while supervisor.get_exact(&key).is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn production_game_engine_start_uses_the_shared_launch_resolution_helper() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("production-game-engine.sh");
        crate::infra::test_executable::publish_test_executable(
            &script,
            "#!/bin/sh\nwhile IFS= read -r line; do case \"$line\" in uci) echo uciok;; isready) echo readyok;; quit) exit 0;; esac; done\n", 0o700)
        .unwrap();
        let mut authority = {
            #[cfg(target_os = "macos")]
            {
                PathAuthority::open_with_launch_root(
                    directory.path().join("registry.json"),
                    Vec::new(),
                    crate::infra::path_authority::EngineLaunchRoot::for_test(directory.path())
                        .unwrap(),
                )
                .unwrap()
            }
            #[cfg(target_os = "linux")]
            {
                PathAuthority::open(directory.path().join("registry.json"), Vec::new()).unwrap()
            }
        };
        let engine = authority
            .register_engine_file(&script, "production-game-engine")
            .unwrap();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(authority);
        let supervisor = Arc::new(EngineSupervisor::default());
        let key =
            game_side_engine_key("production-game", 1, "white", "production-game-engine").unwrap();
        let (_registered, guard) = spawn_configured_game_engine(
            GameEngineRegistration {
                supervisor: supervisor.clone(),
                key: key.clone(),
                engine_id: "production-game-engine".into(),
                executable_ref: engine.id.clone(),
            },
            engine,
            &[],
            authority,
            false,
        )
        .await
        .unwrap();
        assert!(supervisor.get_exact(&key).is_some());
        guard.terminate_now().await.unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn production_game_engine_directory_replacement_is_refused_before_any_option() {
        use crate::infra::path_authority::{EngineResourceHandleKind, PathClass};

        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("production-game-directory-engine.sh");
        crate::infra::test_executable::publish_test_executable(
            &script,
            r#"#!/bin/sh
capture="$PWD/capture.log"
while IFS= read -r line; do
    case "$line" in
        uci) echo uciok ;;
        isready) echo readyok ;;
        setoption*) printf 'setoption=%s\n' "$line" >> "$capture"; echo "$line" ;;
        quit) exit 0 ;;
    esac
done
"#,
            0o700,
        )
        .unwrap();
        let tables = directory.path().join("tables");
        std::fs::create_dir(&tables).unwrap();
        std::fs::write(tables.join("authorized"), b"authorized").unwrap();
        let mut authority = PathAuthority::open_with_launch_root(
            directory.path().join("registry.json"),
            Vec::new(),
            crate::infra::path_authority::EngineLaunchRoot::for_test(directory.path()).unwrap(),
        )
        .unwrap();
        let engine = authority
            .register_engine_file(&script, "production-game-directory-engine")
            .unwrap();
        let grant = authority
            .grant_dialog(
                &tables,
                "tables",
                PathClass::SingleDialogGrant,
                PathOperation::EngineResourceRead,
                Duration::from_secs(30),
                1,
            )
            .unwrap();
        let resource = authority
            .promote_engine_resource(&grant, EngineResourceHandleKind::Directory, "tables")
            .unwrap();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(authority);
        let replaced = Arc::new(AtomicBool::new(false));
        let replaced_for_hook = replaced.clone();
        let tables_for_hook = tables.clone();
        let hook: crate::infra::test_hooks::TestHook = Box::new(move || {
            std::fs::remove_dir_all(&tables_for_hook).unwrap();
            std::fs::write(&tables_for_hook, b"replacement").unwrap();
            replaced_for_hook.store(true, Ordering::SeqCst);
        });
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = game_side_engine_key(
            "production-game-directory",
            1,
            "white",
            "production-game-directory-engine",
        )
        .unwrap();
        GAME_ENGINE_AFTER_SPAWN_HOOKS.arm(key.clone(), hook);
        let result = spawn_configured_game_engine(
            GameEngineRegistration {
                supervisor,
                key: key.clone(),
                engine_id: "production-game-directory-engine".into(),
                executable_ref: engine.id.clone(),
            },
            engine,
            &[EngineOption::Resource {
                name: "SyzygyPath".into(),
                resources: vec![resource],
            }],
            authority,
            false,
        )
        .await;
        GAME_ENGINE_AFTER_SPAWN_HOOKS.clear(&key);
        assert!(
            replaced.load(Ordering::SeqCst),
            "the after-spawn hook armed for {key:?} never ran, so the replacement never happened"
        );
        match result {
            Err(Error::Conflict(ref message))
                if message == "engine resource changed after authorization" => {}
            Err(other) => panic!("expected the authorization conflict, got {other:?}"),
            Ok((registered, mut guard)) => {
                guard.disarm();
                panic!(
                    "expected the authorization conflict, but the engine started as {:?}",
                    registered.key
                )
            }
        }
        let capture =
            std::fs::read_to_string(directory.path().join("capture.log")).unwrap_or_default();
        assert!(!capture.contains("setoption"));
        assert!(!capture.contains("UCI_Chess960"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sealed_game_engine_start_refuses_before_resolution() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("sealed-game-engine.sh");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut authority = {
            #[cfg(target_os = "macos")]
            {
                PathAuthority::open_with_launch_root(
                    directory.path().join("registry.json"),
                    Vec::new(),
                    crate::infra::path_authority::EngineLaunchRoot::for_test(directory.path())
                        .unwrap(),
                )
                .unwrap()
            }
            #[cfg(target_os = "linux")]
            {
                PathAuthority::open(directory.path().join("registry.json"), Vec::new()).unwrap()
            }
        };
        let engine = authority
            .register_engine_file(&script, "sealed-game-engine")
            .unwrap();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(authority);
        let supervisor = Arc::new(EngineSupervisor::default());
        supervisor.terminate_all().await.unwrap();
        let key = game_side_engine_key("sealed-game", 1, "white", "sealed-game-engine").unwrap();
        assert!(matches!(
            spawn_configured_game_engine(
                GameEngineRegistration {
                    supervisor,
                    key,
                    engine_id: "sealed-game-engine".into(),
                    executable_ref: engine.id.clone(),
                },
                engine,
                &[],
                authority,
                false,
            )
            .await,
            Err(Error::Conflict(message)) if message == "application is shutting down"
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn game_engine_initialization_passes_resource_provenance_to_actor_logs() {
        use crate::infra::path_authority::{EngineResourceHandleKind, PathClass};

        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("resource-logging-engine.sh");
        crate::infra::test_executable::publish_test_executable(
            &script,
            r#"#!/bin/sh
capture="$PWD/capture.log"
while IFS= read -r line; do
    case "$line" in
        uci)
            echo uciok
            ;;
        isready)
            echo readyok
            ;;
        setoption\ name\ EvalFile\ value\ *)
            value=${line#*value }
            printf 'eval=%s\n' "$value" >> "$capture"
            if [ "$(cat "$value" 2>/dev/null)" = "weights" ]; then
                printf 'read=weights\n' >> "$capture"
            else
                printf 'read=unreadable\n' >> "$capture"
            fi
            child=
            case "$value" in
                /proc/self/fd/*)
                    for fd in /proc/$$/fd/[0-9]*; do
                        if [ -f "$fd" ] && [ "$(cat "$fd" 2>/dev/null)" = "weights" ]; then
                            child="/proc/self/fd/${fd##*/}"
                            break
                        fi
                    done
                    ;;
                *) child="$value" ;;
            esac
            printf 'child=%s\n' "$child" >> "$capture"
            echo "$line"
            ;;
        setoption*)
            echo "$line"
            ;;
        quit)
            exit 0
            ;;
    esac
done
"#,
            0o700,
        )
        .unwrap();
        let resource_path = directory.path().join("weights.nnue");
        std::fs::write(&resource_path, b"weights").unwrap();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(
            PathAuthority::open(directory.path().join("registry.json"), Vec::new()).unwrap(),
        );
        let resource_handle = {
            let mut authority = authority.raw_for_test().lock().unwrap();
            let authority = authority.as_mut().unwrap();
            let grant = authority
                .grant_dialog(
                    &resource_path,
                    "weights",
                    PathClass::SingleDialogGrant,
                    PathOperation::EngineResourceRead,
                    Duration::from_secs(30),
                    1,
                )
                .unwrap();
            authority
                .promote_engine_resource(&grant, EngineResourceHandleKind::File, "weights")
                .unwrap()
        };
        let executable = EngineExecutable::test_fixture(
            std::fs::File::open(&script).unwrap(),
            directory.path().to_path_buf(),
            Vec::new(),
        );
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = game_side_engine_key("resource-game", 1, "white", "resource-engine").unwrap();
        let (registered, mut guard) = spawn_configured_game_engine_with_executable(
            GameEngineRegistration {
                supervisor: supervisor.clone(),
                key: key.clone(),
                engine_id: "resource-engine".into(),
                executable_ref: crate::infra::path_authority::PathRef {
                    id: "resource-executable".into(),
                },
            },
            executable,
            &[EngineOption::Resource {
                name: "EvalFile".into(),
                resources: vec![resource_handle],
            }],
            &authority,
            false,
        )
        .await
        .unwrap();
        guard.disarm();

        let manager = GameManager::new();
        let mut controller =
            GameController::new("resource-game".into(), 1, human_config()).unwrap();
        controller.white_engine = Some(registered.clone());
        let controller = Arc::new(RwLock::new(controller));
        let (shutdown, _) = watch::channel(false);
        manager.games.insert(
            "resource-game".into(),
            Arc::new(LiveSession {
                session: 1,
                controller,
                shutdown,
                cleanup: SessionCleanup::default(),
                join: std::sync::Mutex::new(None),
                engine_supervisor: supervisor.clone(),
            }),
        );
        let logs = manager
            .get_engine_logs("resource-game", 1, "white")
            .await
            .unwrap();
        assert!(logs.iter().any(|entry| matches!(
            entry,
            EngineLog::Engine(line) if line == "setoption name EvalFile value [redacted]"
        )));
        assert!(logs.iter().all(|entry| match entry {
            EngineLog::Gui(line) | EngineLog::Engine(line) => !line.contains("/proc/self/fd/"),
            EngineLog::Truncated { .. } => true,
        }));
        let capture = std::fs::read_to_string(directory.path().join("capture.log")).unwrap();
        let eval = capture
            .lines()
            .find_map(|line| line.strip_prefix("eval="))
            .expect("resource engine must capture the EvalFile wire value");
        let child = capture
            .lines()
            .find_map(|line| line.strip_prefix("child="))
            .expect("resource engine must capture the child-visible resource value");
        let read = capture
            .lines()
            .find_map(|line| line.strip_prefix("read="))
            .expect("resource engine must capture the EvalFile read result");
        #[cfg(target_os = "linux")]
        for value in [eval, child] {
            let descriptor = value
                .strip_prefix("/proc/self/fd/")
                .expect("resource option must use a procfs descriptor");
            assert!(!descriptor.is_empty() && descriptor.bytes().all(|byte| byte.is_ascii_digit()));
        }
        #[cfg(target_os = "macos")]
        {
            assert!(!eval.contains("/proc/self/fd/"));
        }
        assert_eq!(
            eval, child,
            "the wire value must be the authorized resource value"
        );
        assert_eq!(
            read, "weights",
            "the child must read bytes through the wire value"
        );
        registered.actor.terminate().await.unwrap();
        supervisor
            .terminate_exact(&key, registered.generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn retiring_one_game_engine_id_keeps_the_other_even_for_the_same_handle() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let white =
            register_test_game_engine(&supervisor, "game", 3, "white", "engine-a", "same-handle")
                .await;
        let black =
            register_test_game_engine(&supervisor, "game", 3, "black", "engine-b", "same-handle")
                .await;

        supervisor.retire_engine("engine-a".into()).await.unwrap();

        assert!(supervisor.get_exact(&white.key).is_none());
        assert!(supervisor.get_exact(&black.key).is_some());
        supervisor
            .terminate_exact(&black.key, black.generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn retiring_an_engine_named_white_does_not_reap_white_side_games() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let white = register_test_game_engine(
            &supervisor,
            "game",
            5,
            "white",
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "handle-a",
        )
        .await;
        supervisor.retire_engine("white".into()).await.unwrap();
        assert!(supervisor.get_exact(&white.key).is_some());
        supervisor
            .terminate_exact(&white.key, white.generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn disconnected_registered_game_actor_returns_a_log_error() {
        let manager = GameManager::new();
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = game_side_engine_key("game", 4, "white", "engine-a").unwrap();
        let (actor, _) = EngineActor::recording_test_actor(&[]);
        actor.terminate().await.unwrap();
        let supervised = supervisor
            .replace_handle(
                key.clone(),
                actor,
                "engine-a".into(),
                crate::infra::path_authority::PathRef {
                    id: "handle-a".into(),
                },
            )
            .await
            .unwrap();
        let registered = RegisteredGameEngine {
            actor: supervised.actor,
            key,
            generation: supervised.generation,
        };
        let mut controller = GameController::new("game".into(), 4, human_config()).unwrap();
        controller.white_engine = Some(registered.clone());
        let controller = Arc::new(RwLock::new(controller));
        let (shutdown, _) = watch::channel(false);
        manager.games.insert(
            "game".into(),
            Arc::new(LiveSession {
                session: 4,
                controller,
                shutdown,
                cleanup: SessionCleanup::default(),
                join: std::sync::Mutex::new(None),
                engine_supervisor: supervisor.clone(),
            }),
        );

        assert!(matches!(
            manager.get_engine_logs("game", 4, "white").await,
            Err(Error::EngineDisconnected)
        ));
        supervisor
            .terminate_exact(&registered.key, registered.generation)
            .await
            .unwrap();
        assert!(supervisor.get_exact(&registered.key).is_none());
    }

    #[tokio::test]
    async fn human_move_checks_expected_ply_before_applying_move() {
        let game_id = "human_move_checks_expected_ply_before_applying_move";
        let app = tauri::test::mock_app();
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events!(
                GameMoveEvent,
                GameOverEvent,
                ClockUpdateEvent
            ))
            .mount_events(&app);
        let manager = Arc::new(GameManager::new());
        let initial = manager
            .start_game(
                game_id.into(),
                human_config(),
                app.handle().clone(),
                crate::infra::path_authority::SharedPathAuthority::uninitialized(),
                Arc::new(EngineSupervisor::default()),
            )
            .await
            .unwrap();

        for (ply, uci) in ["e2e4", "e7e5", "g1f3", "b8c6"].into_iter().enumerate() {
            manager
                .make_move(game_id, initial.session, uci, ply as u32, app.handle())
                .await
                .unwrap();
        }
        let before = manager
            .get_game_state(game_id, initial.session)
            .await
            .unwrap();
        let result = manager
            .make_move(game_id, initial.session, "f1c4", 2, app.handle())
            .await;
        let after = manager
            .get_game_state(game_id, initial.session)
            .await
            .unwrap();
        // Retire the production loop even if an assertion below detects a regression.
        let correct = manager
            .make_move(game_id, initial.session, "f1c4", 4, app.handle())
            .await;
        manager.abort_game(game_id, initial.session).await.unwrap();

        assert!(
            matches!(result, Err(Error::Conflict(message)) if message == "game position changed before move commit")
        );
        assert_eq!(before.moves.len(), 4);
        assert_eq!(
            serde_json::to_value(&after.moves).unwrap(),
            serde_json::to_value(&before.moves).unwrap()
        );
        assert_eq!(after.current_fen, before.current_fen);
        assert_eq!(after.revision, before.revision);

        let accepted = correct.unwrap();
        assert_eq!(accepted.moves.len(), 5);
        assert_eq!(accepted.moves[4].uci, "f1c4");
        assert_ne!(accepted.current_fen, before.current_fen);
        assert!(accepted.revision > before.revision);
    }

    fn assert_terminal_move_publication_revisions(config: GameConfig) {
        let mut controller = GameController::new("game".into(), 1, config).unwrap();
        controller.apply_move("g6g7").unwrap();

        assert!(matches!(controller.status, GameStatus::Finished { .. }));
        let move_revision = controller.move_event_revision();
        let terminal_revision = controller.get_state().revision;
        assert_eq!(terminal_revision, move_revision + 1);

        // A strict client accepts the publications in natural order, and keeps
        // the terminal state if transport delivers the two events out of order.
        let mut newest = 0;
        assert!(move_revision > newest);
        newest = move_revision;
        assert!(terminal_revision > newest);

        let mut newest = 0;
        assert!(terminal_revision > newest);
        newest = terminal_revision;
        assert!(move_revision <= newest);
    }

    #[test]
    fn controller_applies_and_rebuilds_moves_without_losing_position_history() {
        let mut controller = GameController::new("game".into(), 1, human_config()).unwrap();
        assert_eq!(controller.revision, 0);
        controller.apply_move("e2e4").unwrap();
        assert_eq!(controller.revision, 1);
        controller.apply_move("e7e5").unwrap();
        assert_eq!(controller.moves.len(), 2);
        controller.moves.pop();
        controller.rebuild_position_from_moves().unwrap();
        controller.bump_revision();
        assert_eq!(controller.revision, 3);
        assert_eq!(controller.moves.len(), 1);
        assert_eq!(controller.position.turn(), Color::Black);
        assert!(controller.position_history.values().all(|count| *count > 0));
    }

    #[test]
    fn move_application_counts_repeated_positions_for_live_and_initial_moves() {
        let cycle = ["g1f3", "g8f6", "f3g1", "f6g8"];
        let mut live = GameController::new("live".into(), 1, human_config()).unwrap();
        let initial_key = GameController::position_key(&live.position);
        for uci in cycle {
            live.apply_move(uci).unwrap();
        }
        assert_eq!(live.position_history.get(&initial_key), Some(&2));

        let mut config = human_config();
        config.initial_moves = cycle.into_iter().map(str::to_owned).collect();
        let initial = GameController::new("initial".into(), 1, config).unwrap();
        assert_eq!(initial.position_history.get(&initial_key), Some(&2));
    }

    #[test]
    fn ending_a_game_is_idempotent() {
        let mut controller = GameController::new("game".into(), 1, human_config()).unwrap();
        assert!(controller.end_game(GameResult::Draw {
            reason: DrawReason::Agreement,
        }));
        assert_eq!(controller.revision, 1);
        assert!(!controller.end_game(GameResult::Draw {
            reason: DrawReason::Agreement,
        }));
        assert_eq!(controller.revision, 1);
    }

    #[test]
    fn terminal_human_move_has_distinct_move_and_game_over_revisions() {
        let config = mating_config(PlayerConfig::Human {
            name: "White".into(),
        });
        assert_terminal_move_publication_revisions(config.clone());
        let mut controller = GameController::new("game".into(), 1, config).unwrap();
        controller.apply_move("g6g7").unwrap();
        assert!(matches!(
            controller.status,
            GameStatus::Finished {
                result: GameResult::WhiteWins {
                    reason: GameEndReason::Checkmate
                }
            }
        ));
    }

    #[test]
    fn terminal_engine_move_has_distinct_move_and_game_over_revisions() {
        assert_terminal_move_publication_revisions(mating_config(fake_engine_player()));
    }

    #[test]
    fn opening_zip_rejects_compression_bombs_before_decompression() {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("book.pgn", options).unwrap();
        zip.write_all(&vec![b'x'; 1024 * 1024]).unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        assert!(matches!(
            read_zip_inner(&bytes),
            Err(Error::ResourceLimit(_))
        ));
    }

    #[test]
    fn zipped_epd_opening_book_is_applied_through_outer_dispatch() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("book.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
        zip.start_file("book.epd", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - bm e4;\n")
            .unwrap();
        zip.finish().unwrap();

        let mut authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
        let book = authority
            .register_opening_book(&zip_path, "book.zip")
            .unwrap();
        let descriptor = authority.opening_book_descriptor(&book).unwrap();

        let result = apply_opening_book_descriptor(
            human_config(),
            descriptor,
            40,
            &CancellationToken::new(),
        )
        .unwrap();

        assert_eq!(
            result.config.initial_fen.as_deref(),
            Some("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
        );
    }

    #[test]
    fn opening_book_rejects_malformed_epd_operations_and_extra_fen_fields() {
        let valid = b"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - bm e4;\n";
        assert!(select_random_epd_entry(BufReader::new(Cursor::new(valid))).is_ok());

        let missing_terminator = b"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - bm e4\n";
        assert!(select_random_epd_entry(BufReader::new(Cursor::new(missing_terminator))).is_err());

        let full_fen = b"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1\n";
        assert!(select_random_epd_entry(BufReader::new(Cursor::new(full_fen))).is_err());
    }

    #[test]
    fn epd_operation_grammar_handles_quotes_escapes_and_opcode_boundaries() {
        for valid in [
            "bm e4;",
            "id \"semicolon; stays quoted\";",
            "id \"escaped \\\" quote\";",
            "bm_1 e4;",
        ] {
            assert!(validate_epd_operations(valid).is_ok(), "{valid}");
        }
        for invalid in ["bm a\\\";", "1bad e4;", "bad-op e4;", "bm e4"] {
            assert!(validate_epd_operations(invalid).is_err(), "{invalid}");
        }
        assert!(matches!(
            validate_epd_operations("id \"unterminated;"),
            Err(Error::InvalidInput(message))
                if message == "EPD operation contains an unterminated quoted operand"
        ));
    }

    #[test]
    fn opening_book_extension_castling_and_weight_selection_are_exact() {
        for (name, expected) in [
            ("book.EPD", Some("epd")),
            ("book.pgn", Some("pgn")),
            ("book.BIN", Some("bin")),
            ("book.zip", Some("zip")),
        ] {
            assert_eq!(opening_book_ext(name), expected);
        }
        for (input, expected) in [
            ("e1h1", "e1g1"),
            ("e1a1", "e1c1"),
            ("e8h8", "e8g8"),
            ("e8a8", "e8c8"),
            ("e2e4", "e2e4"),
        ] {
            assert_eq!(normalize_polyglot_uci(input), expected);
        }

        let weights = [2, 3, 5];
        for (target, expected) in [(0, 0), (1, 0), (2, 1), (4, 1), (5, 2), (9, 2)] {
            assert_eq!(choose_weighted_target(&weights, target), expected);
        }
        use rand::SeedableRng;
        use std::collections::HashSet;

        let zero_weight_selections = (0..128)
            .map(|seed| {
                let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
                choose_weighted_index(&[0, 0, 0], &mut rng)
            })
            .collect::<HashSet<_>>();
        assert_eq!(zero_weight_selections, HashSet::from([0, 1, 2]));
    }

    #[test]
    fn polyglot_lookup_uses_pseudo_legal_en_passant_and_filters_illegal_moves() {
        // Fixed reference keys from shakmaty 0.27.1's independent Zobrist64 implementation.
        let cases = [
            (
                "white pinned en passant",
                "4r2k/3p4/8/4P3/8/8/8/4K3 b - - 0 1",
                "d7d5",
                0xccc1_0c96_ec17_72c4,
                "e5d6",
                "e1d1",
            ),
            (
                "black pinned en passant",
                "4k3/8/8/8/4p3/8/3P4/4R2K w - - 0 1",
                "d2d4",
                0x35c2_0801_ff02_3f44,
                "e4d3",
                "e8d8",
            ),
            (
                "legal en passant",
                "7k/3p4/8/4P3/8/8/8/4K3 b - - 0 1",
                "d7d5",
                0xb3bd_cf02_ccb4_d781,
                "e1e3",
                "e5d6",
            ),
            (
                "no adjacent capturing pawn",
                "7k/3p4/8/8/8/8/8/4K3 b - - 0 1",
                "d7d5",
                0xb134_2340_efab_cea4,
                "e5d6",
                "e1d1",
            ),
        ];

        for (name, initial_fen, played, key, illegal_move, book_move) in cases {
            let controller = controller_with_polyglot_book(
                initial_fen,
                played,
                &[(key, illegal_move, 100), (key, book_move, 1)],
            );
            assert_eq!(
                try_polyglot_book_move(&controller).as_deref(),
                Some(book_move),
                "{name}"
            );
        }

        let (_, initial_fen, played, key, illegal_move, _) = cases[0];
        let controller =
            controller_with_polyglot_book(initial_fen, played, &[(key, illegal_move, 1)]);
        assert_eq!(try_polyglot_book_move(&controller), None);

        let legal_fen = "4r2k/8/8/3pP3/8/8/8/4K3 w - - 0 2";
        assert_eq!(controller.get_state().current_fen, legal_fen);
        assert_eq!(controller.moves.last().unwrap().fen_after, legal_fen);
        assert!(controller
            .position_history
            .contains_key("4r2k/8/8/3pP3/8/8/8/4K3 w - -"));
        assert!(!controller
            .position_history
            .contains_key("4r2k/8/8/3pP3/8/8/8/4K3 w - d6"));
    }

    #[test]
    fn malformed_opening_book_payloads_return_errors_without_panicking() {
        let zip = std::panic::catch_unwind(|| read_zip_inner(b"not a zip archive"));
        assert!(matches!(zip, Ok(Err(_))));

        let pgn = std::panic::catch_unwind(|| {
            select_random_pgn_entry(Cursor::new(b"1. definitely-not-san *".to_vec()))
        });
        assert!(matches!(pgn, Ok(Err(_))));

        let polyglot = std::panic::catch_unwind(|| load_polyglot_book(&[0_u8]));
        assert!(matches!(polyglot, Ok(Err(_))));
    }

    #[test]
    fn cancelled_opening_book_parsers_stop_before_consuming_input() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        assert!(matches!(
            select_random_pgn_entry_cancellable(Cursor::new(b"1. e4 e5 *"), &cancellation),
            Err(Error::Cancellation)
        ));
        assert!(matches!(
            read_zip_inner_cancellable(b"not a zip archive", &cancellation),
            Err(Error::Cancellation)
        ));
        assert!(matches!(
            load_polyglot_book_cancellable(&[0_u8; 16], &cancellation),
            Err(Error::Cancellation)
        ));
    }

    #[test]
    fn pgn_cancellation_interrupts_an_in_progress_read_game() {
        let cancellation = CancellationToken::new();
        let reader = CancelsAfterFirstRead {
            bytes: Cursor::new(b"1. e4 e5 *".to_vec()),
            cancellation: cancellation.clone(),
            reads: 0,
        };

        assert!(matches!(
            select_random_pgn_entry_cancellable(reader, &cancellation),
            Err(Error::Cancellation)
        ));
    }

    #[test]
    fn epd_cancellation_interrupts_an_in_progress_unterminated_line() {
        let cancellation = CancellationToken::new();
        let reader = BufReader::new(CancelsAfterFirstRead {
            bytes: Cursor::new(
                b"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - bm e4;".to_vec(),
            ),
            cancellation: cancellation.clone(),
            reads: 0,
        });

        assert!(matches!(
            select_random_epd_entry_cancellable(reader, &cancellation),
            Err(Error::Cancellation)
        ));
    }

    #[test]
    fn epd_reader_rejects_unbounded_lines() {
        let line = vec![b'x'; MAX_OPENING_BOOK_EPD_LINE_BYTES + 1];
        assert!(matches!(
            select_random_epd_entry(BufReader::new(Cursor::new(line))),
            Err(Error::ResourceLimit(_))
        ));
    }

    #[test]
    fn time_controls_reject_asymmetry_and_values_outside_uci_range() {
        let mut config = human_config();
        config.white_time_control = Some(TimeControl {
            initial_time: 1_000,
            increment: 0,
        });
        assert!(matches!(
            GameController::new("game".into(), 1, config.clone()),
            Err(Error::InvalidInput(_))
        ));

        config.black_time_control = Some(TimeControl {
            initial_time: 1_000,
            increment: u64::from(MAX_ENGINE_LIMIT) + 1,
        });
        assert!(matches!(
            GameController::new("game".into(), 1, config),
            Err(Error::InvalidInput(_))
        ));
    }

    #[test]
    fn time_controls_accept_exact_uci_limits_and_the_minimum_initial_clock() {
        for (white_initial, black_initial) in [
            (u64::from(MAX_ENGINE_LIMIT), MIN_INITIAL_TIME_MS),
            (MIN_INITIAL_TIME_MS, u64::from(MAX_ENGINE_LIMIT)),
        ] {
            let mut config = human_config();
            config.white_time_control = Some(TimeControl {
                initial_time: white_initial,
                increment: u64::from(MAX_ENGINE_LIMIT),
            });
            config.black_time_control = Some(TimeControl {
                initial_time: black_initial,
                increment: u64::from(MAX_ENGINE_LIMIT),
            });
            assert!(GameController::new("game".into(), 1, config).is_ok());
        }
    }

    #[test]
    fn time_controls_reject_a_side_below_the_minimum_initial_clock() {
        for (white_initial, black_initial, name) in [
            (0, 60_000, "white initial time"),
            (60_000, 0, "black initial time"),
            (1, 60_000, "white initial time"),
            (60_000, MIN_INITIAL_TIME_MS - 1, "black initial time"),
        ] {
            let mut config = human_config();
            config.white_time_control = Some(TimeControl {
                initial_time: white_initial,
                increment: 0,
            });
            config.black_time_control = Some(TimeControl {
                initial_time: black_initial,
                increment: 0,
            });
            assert!(matches!(
                GameController::new("game".into(), 1, config),
                Err(Error::InvalidInput(message))
                    if message == format!("{name} must be at least {MIN_INITIAL_TIME_MS} milliseconds")
            ));
        }
    }

    #[test]
    fn clock_is_debited_before_a_legal_move_then_incremented_once() {
        let mut config = human_config();
        config.white_time_control = Some(TimeControl {
            initial_time: 1_000,
            increment: 100,
        });
        config.black_time_control = Some(TimeControl {
            initial_time: 1_000,
            increment: 0,
        });
        let mut controller = GameController::new("game".into(), 1, config).unwrap();
        controller.clock.as_mut().unwrap().last_tick = Instant::now() - Duration::from_millis(250);

        let game_move = controller.apply_move("e2e4").unwrap();
        let white_time = controller.clock.as_ref().unwrap().white_time.unwrap();
        assert_eq!(game_move.clock, Some(white_time));
        assert!((800..=850).contains(&white_time));
        assert_eq!(controller.clock.as_ref().unwrap().black_time, Some(1_000));
    }

    #[test]
    fn timeout_is_a_draw_when_the_opponent_has_insufficient_mating_material() {
        let mut config = human_config();
        config.initial_fen = Some("8/8/8/8/8/8/3K2N1/5k2 b - - 0 1".into());
        config.white_time_control = Some(TimeControl {
            initial_time: 1_000,
            increment: 0,
        });
        config.black_time_control = Some(TimeControl {
            initial_time: MIN_INITIAL_TIME_MS,
            increment: 0,
        });
        let mut controller = GameController::new("game".into(), 1, config).unwrap();
        controller.clock.as_mut().unwrap().black_time = Some(1);
        controller.clock.as_mut().unwrap().last_tick = Instant::now() - Duration::from_millis(2);

        assert_eq!(
            controller.settle_active_clock(),
            Some(GameResult::Draw {
                reason: DrawReason::InsufficientMaterial,
            })
        );
    }

    #[test]
    fn timeout_awards_the_opponent_and_current_times_debit_only_the_active_side() {
        let mut config = human_config();
        config.white_time_control = Some(TimeControl {
            initial_time: 1_000,
            increment: 0,
        });
        config.black_time_control = Some(TimeControl {
            initial_time: 2_000,
            increment: 0,
        });
        let mut white_to_move = GameController::new("white".into(), 1, config.clone()).unwrap();
        white_to_move.clock.as_mut().unwrap().last_tick =
            Instant::now() - Duration::from_millis(100);
        let (white, black) = white_to_move.get_current_times();
        assert!(matches!(white, Some(850..=950)));
        assert_eq!(black, Some(2_000));

        config.initial_fen =
            Some("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1".into());
        let mut black_to_move = GameController::new("black".into(), 1, config).unwrap();
        black_to_move.clock.as_mut().unwrap().last_tick =
            Instant::now() - Duration::from_millis(100);
        let (white, black) = black_to_move.get_current_times();
        assert_eq!(white, Some(1_000));
        assert!(matches!(black, Some(1_850..=1_950)));

        black_to_move.clock.as_mut().unwrap().black_time = Some(1);
        black_to_move.clock.as_mut().unwrap().last_tick = Instant::now() - Duration::from_millis(2);
        assert!(matches!(
            black_to_move.settle_active_clock(),
            Some(GameResult::WhiteWins {
                reason: GameEndReason::Timeout
            })
        ));

        let no_clock = GameController::new("none".into(), 1, human_config()).unwrap();
        assert_eq!(no_clock.get_current_times(), (None, None));
    }

    #[test]
    fn game_session_identity_is_preserved_in_state() {
        let controller = GameController::new("game".into(), 42, human_config()).unwrap();
        assert_eq!(controller.get_state().session, 42);
    }

    #[test]
    fn session_allocation_accepts_the_final_safe_identity_and_then_stays_exhausted() {
        let manager = GameManager::new();
        manager
            .next_session
            .store(MAX_SAFE_JS_COUNTER - 1, Ordering::Relaxed);

        assert_eq!(manager.allocate_session().unwrap(), MAX_SAFE_JS_COUNTER);
        for _ in 0..2 {
            assert!(matches!(
                manager.allocate_session(),
                Err(Error::ResourceLimit(_))
            ));
            assert_eq!(
                manager.next_session.load(Ordering::Relaxed),
                MAX_SAFE_JS_COUNTER
            );
        }
    }

    #[test]
    fn initial_terminal_fen_is_finished_before_a_live_session_starts() {
        let mut source = GameController::new(
            "source".into(),
            1,
            mating_config(PlayerConfig::Human {
                name: "White".into(),
            }),
        )
        .unwrap();
        source.apply_move("g6g7").unwrap();
        let mut config = human_config();
        config.initial_fen = Some(source.get_state().current_fen);
        let controller = GameController::new("game".into(), 1, config).unwrap();
        assert!(matches!(controller.status, GameStatus::Finished { .. }));
    }

    #[test]
    fn initial_moves_cannot_continue_after_a_terminal_position() {
        let mut config = mating_config(PlayerConfig::Human {
            name: "White".into(),
        });
        config.initial_moves = vec!["g6g7".into(), "h8h7".into()];
        assert!(matches!(
            GameController::new("game".into(), 1, config),
            Err(Error::InvalidInput(_))
        ));
    }

    #[tokio::test]
    async fn delayed_engine_result_cannot_commit_after_two_takebacks() {
        let mut config = human_config();
        config.black = fake_engine_player();
        let mut controller = GameController::new("game".into(), 7, config).unwrap();
        controller.apply_move("e2e4").unwrap();
        let context = controller.begin_engine_request().unwrap();
        let request_id = crate::engine::EngineRequestId(91);
        assert!(controller.register_engine_request_id(&context, request_id));

        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let delayed_barrier = barrier.clone();
        let delayed_context = context.clone();
        let delayed = tokio::spawn(async move {
            delayed_barrier.wait().await;
            delayed_barrier.wait().await;
            delayed_context
        });

        barrier.wait().await;
        controller.take_back_moves(1).unwrap();
        controller.take_back_moves(1).unwrap();
        barrier.wait().await;
        let delayed_context = delayed.await.unwrap();

        assert!(delayed_context.cancellation.is_cancelled());
        assert!(!controller.accepts_engine_result(&delayed_context, request_id));
    }

    #[tokio::test]
    async fn same_game_lifecycle_lease_serializes_start_and_abort_transitions() {
        let manager = GameManager::new();
        let first = manager.lifecycle_lease("game");
        let held = first.lock().await;
        let second = manager.lifecycle_lease("game");
        assert!(second.try_lock().is_err());
        drop(held);
        drop(first);
        assert!(second.try_lock().is_ok());
        drop(second);
        assert_eq!(manager.lifecycle.len(), 0);
    }

    #[tokio::test]
    async fn distinct_missing_game_operations_leave_no_lifecycle_entries() {
        let manager = GameManager::new();
        for index in 0..2_000 {
            let game_id = format!("missing-{index}");
            assert!(matches!(
                manager.get_game_state(&game_id, 1).await,
                Err(Error::GameNotFound(_))
            ));
        }
        assert_eq!(manager.lifecycle.len(), 0);
    }

    #[tokio::test]
    async fn cancelled_registration_wait_cannot_publish_live_or_latest_state() {
        let manager = GameManager::new();
        let callback_count = AtomicU64::new(0);
        let registration = manager.registration.lock().await;
        let (live, _) = test_live_session("cancelled", 1);
        let mut publication = Box::pin(manager.publish_live("cancelled".into(), 1, live, || {
            callback_count.fetch_add(1, Ordering::SeqCst);
        }));
        assert!(futures_util::poll!(&mut publication).is_pending());
        drop(publication);
        drop(registration);

        assert!(manager.games.get("cancelled").is_none());
        assert!(!manager
            .session_metadata
            .lock()
            .await
            .latest
            .contains_key("cancelled"));
        assert_eq!(callback_count.load(Ordering::SeqCst), 0);

        let (active, _) = test_live_session("active-callback", 3);
        manager
            .publish_live("active-callback".into(), 3, active, || {
                assert_eq!(callback_count.fetch_add(1, Ordering::SeqCst), 0);
                assert!(manager.registration.try_lock().is_err());
                assert!(manager
                    .games
                    .get("active-callback")
                    .is_some_and(|live| live.session == 3));
                let metadata = manager.session_metadata.try_lock().unwrap();
                assert!(metadata
                    .latest
                    .get("active-callback")
                    .is_some_and(|latest| {
                        latest.session == 3 && latest.disposition == SessionDisposition::Active
                    }));
            })
            .await
            .unwrap();
        assert_eq!(callback_count.load(Ordering::SeqCst), 1);

        manager.sealed.store(true, Ordering::SeqCst);
        let (rejected, _) = test_live_session("rejected", 2);
        assert!(matches!(
            manager
                .publish_live("rejected".into(), 2, rejected, || {
                    callback_count.fetch_add(1, Ordering::SeqCst);
                })
                .await,
            Err(Error::Conflict(_))
        ));
        assert!(manager.games.get("rejected").is_none());
        assert!(!manager
            .session_metadata
            .lock()
            .await
            .latest
            .contains_key("rejected"));
        assert_eq!(callback_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn completion_abort_and_replacement_churn_keep_metadata_at_its_state_bound() {
        let manager = GameManager::new();
        let (active, _) = test_live_session("active", 10_000);
        manager
            .publish_live("active".into(), 10_000, active, || {})
            .await
            .unwrap();

        for session in 1..=300 {
            let game_id = format!("completed-{session}");
            let (live, controller) = test_live_session(&game_id, session);
            manager
                .publish_live(game_id.clone(), session, live, || {})
                .await
                .unwrap();
            manager.complete_exact(&game_id, session, &controller).await;
        }
        for session in 1..=150 {
            let game_id = format!("aborted-{session}");
            let (live, _) = test_live_session(&game_id, session);
            manager
                .publish_live(game_id.clone(), session, live, || {})
                .await
                .unwrap();
            manager.abort_game(&game_id, session).await.unwrap();
        }

        let retained_id = "replaced-retained";
        {
            let mut metadata = manager.session_metadata.lock().await;
            metadata.snapshots.push_back(CompletedSnapshot {
                game_id: retained_id.into(),
                session: 0,
                state: GameController::new(retained_id.into(), 0, human_config())
                    .unwrap()
                    .get_state(),
            });
            metadata.latest.insert(
                retained_id.into(),
                LatestSession {
                    session: 0,
                    disposition: SessionDisposition::Completed,
                },
            );
        }
        let (old, _) = test_live_session(retained_id, 1);
        *old.join.lock().unwrap() = Some(tokio::spawn(std::future::pending::<()>()));
        manager
            .publish_live(retained_id.into(), 1, old.clone(), || {})
            .await
            .unwrap();
        assert!(manager
            .retire_replaced_session(retained_id, old, Duration::ZERO)
            .await
            .is_err());
        assert!(manager.games.get(retained_id).is_none());
        assert!(manager
            .session_metadata
            .lock()
            .await
            .latest
            .get(retained_id)
            .is_some_and(|latest| latest.session == 1
                && latest.disposition == SessionDisposition::Tombstoned));
        assert!(matches!(
            manager.get_game_state(retained_id, 1).await,
            Err(Error::GameNotFound(_))
        ));
        assert!(matches!(
            manager.get_game_state(retained_id, 0).await,
            Err(Error::Conflict(_))
        ));
        let (replacement, _) = test_live_session(retained_id, 2);
        manager
            .publish_live(retained_id.into(), 2, replacement, || {})
            .await
            .unwrap();
        manager.abort_game(retained_id, 2).await.unwrap();

        for index in 1..=150 {
            let game_id = format!("replaced-{index}");
            let (old, _) = test_live_session(&game_id, 1);
            manager
                .publish_live(game_id.clone(), 1, old.clone(), || {})
                .await
                .unwrap();
            manager
                .retire_replaced_session(&game_id, old, Duration::ZERO)
                .await
                .unwrap();
            let (replacement, _) = test_live_session(&game_id, 2);
            manager
                .publish_live(game_id.clone(), 2, replacement, || {})
                .await
                .unwrap();
            manager.abort_game(&game_id, 2).await.unwrap();
        }
        for session in 1..=200 {
            let (live, controller) = test_live_session("repeated", session);
            manager
                .publish_live("repeated".into(), session, live, || {})
                .await
                .unwrap();
            manager
                .complete_exact("repeated", session, &controller)
                .await;
        }

        let metadata = manager.session_metadata.lock().await;
        assert_eq!(metadata.snapshots.len(), COMPLETED_GAME_SNAPSHOTS);
        assert!(metadata.latest.len() <= manager.games.len() + metadata.snapshots.len());
        assert!(metadata.latest.get("active").is_some_and(|latest| {
            latest.session == 10_000 && latest.disposition == SessionDisposition::Active
        }));
        for (game_id, latest) in &metadata.latest {
            match latest.disposition {
                SessionDisposition::Active => assert!(manager
                    .games
                    .get(game_id)
                    .is_some_and(|live| live.session == latest.session)),
                SessionDisposition::Completed => assert!(metadata
                    .snapshots
                    .iter()
                    .any(|snapshot| snapshot.game_id == *game_id
                        && snapshot.session == latest.session)),
                SessionDisposition::Tombstoned => assert!(metadata
                    .snapshots
                    .iter()
                    .any(|snapshot| snapshot.game_id == *game_id)),
            }
        }
        for game_id in metadata.latest.keys() {
            assert!(
                manager.games.contains_key(game_id)
                    || metadata
                        .snapshots
                        .iter()
                        .any(|snapshot| snapshot.game_id == *game_id)
            );
        }
        drop(metadata);
        assert_eq!(manager.lifecycle.len(), 0);
    }

    #[tokio::test]
    async fn shutdown_fallback_retires_live_metadata() {
        let manager = GameManager::new();
        let (live, _) = test_live_session("shutdown", 7);
        manager
            .publish_live("shutdown".into(), 7, live, || {})
            .await
            .unwrap();

        manager.shutdown_all(Duration::from_secs(1)).await.unwrap();

        assert!(manager.games.is_empty());
        assert!(!manager
            .session_metadata
            .lock()
            .await
            .latest
            .contains_key("shutdown"));
    }

    #[tokio::test]
    async fn natural_completion_removes_only_the_matching_session_and_keeps_a_bounded_snapshot() {
        let manager = GameManager::new();
        let controller = Arc::new(RwLock::new(
            GameController::new("game".into(), 1, human_config()).unwrap(),
        ));
        let (shutdown, _) = watch::channel(false);
        manager.session_metadata.lock().await.latest.insert(
            "game".into(),
            LatestSession {
                session: 1,
                disposition: SessionDisposition::Active,
            },
        );
        manager.games.insert(
            "game".into(),
            Arc::new(LiveSession {
                session: 1,
                controller: controller.clone(),
                shutdown,
                cleanup: SessionCleanup::default(),
                join: std::sync::Mutex::new(None),
                engine_supervisor: Arc::new(EngineSupervisor::default()),
            }),
        );
        manager.complete_exact("game", 1, &controller).await;
        assert!(manager.games.get("game").is_none());
        assert_eq!(manager.get_game_state("game", 1).await.unwrap().session, 1);

        let replacement = Arc::new(RwLock::new(
            GameController::new("game".into(), 2, human_config()).unwrap(),
        ));
        let (shutdown, _) = watch::channel(false);
        manager.session_metadata.lock().await.latest.insert(
            "game".into(),
            LatestSession {
                session: 2,
                disposition: SessionDisposition::Active,
            },
        );
        manager.games.insert(
            "game".into(),
            Arc::new(LiveSession {
                session: 2,
                controller: replacement.clone(),
                shutdown,
                cleanup: SessionCleanup::default(),
                join: std::sync::Mutex::new(None),
                engine_supervisor: Arc::new(EngineSupervisor::default()),
            }),
        );
        manager.complete_exact("game", 1, &controller).await;
        assert_eq!(manager.get_game_state("game", 2).await.unwrap().session, 2);
        assert!(manager.session_metadata.lock().await.snapshots.len() <= COMPLETED_GAME_SNAPSHOTS);
    }

    #[tokio::test]
    async fn abort_controller_lock_cancellation_finishes_removed_session() {
        let game_id = "abort_controller_lock_cancellation_finishes_removed_session";
        let manager = GameManager::new();
        let supervisor = Arc::new(EngineSupervisor::default());
        let (live, engines, unrelated) =
            published_teardown_fixture(&manager, &supervisor, game_id, healthy_teardown_actors())
                .await;
        let controller = live.controller.write().await;
        let mut abort = Box::pin(manager.abort_game(game_id, 1));
        assert!(futures_util::poll!(abort.as_mut()).is_pending());
        assert_session_retired(&manager, game_id, 1).await;
        assert!(!*live.shutdown.borrow());
        assert_teardown_engines_owned(&supervisor, &engines);

        drop(abort);
        drop(controller);
        assert_published_teardown_finished_and_cleanup_unrelated_engine(
            &manager, game_id, &live, &engines, &unrelated,
        )
        .await;
    }

    #[tokio::test]
    async fn abort_join_acquisition_cancellation_restores_handle_for_remainder() {
        let game_id = "abort_join_acquisition_cancellation_restores_handle_for_remainder";
        let manager = GameManager::new();
        let supervisor = Arc::new(EngineSupervisor::default());
        let (live, engines, unrelated) =
            published_teardown_fixture(&manager, &supervisor, game_id, healthy_teardown_actors())
                .await;
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        live.join.lock().unwrap().take().unwrap().abort();
        *live.join.lock().unwrap() = Some(tokio::spawn(async move {
            let _ = release_rx.await;
        }));
        let taken = Arc::new(AtomicBool::new(false));
        SHUTDOWN_JOIN_TAKEN_HOOKS.arm(
            (game_id.into(), 1),
            Box::new({
                let taken = taken.clone();
                move || taken.store(true, Ordering::SeqCst)
            }),
        );
        let mut abort = Box::pin(manager.abort_game(game_id, 1));
        assert!(futures_util::poll!(abort.as_mut()).is_pending());
        assert!(taken.load(Ordering::SeqCst));
        assert!(live.join.lock().unwrap().is_none());
        let controller = live.controller.write().await;
        drop(abort);
        assert!(
            live.join.lock().unwrap().is_some(),
            "cancelled join must be restored before the remainder runs"
        );
        assert_teardown_engines_owned(&supervisor, &engines);
        let retaken = Arc::new(AtomicBool::new(false));
        SHUTDOWN_JOIN_TAKEN_HOOKS.arm(
            (game_id.into(), 1),
            Box::new({
                let retaken = retaken.clone();
                move || retaken.store(true, Ordering::SeqCst)
            }),
        );
        drop(controller);
        wait_until(|| retaken.load(Ordering::SeqCst)).await;
        assert_teardown_engines_owned(&supervisor, &engines);
        release_tx.send(()).unwrap();
        assert_published_teardown_finished_and_cleanup_unrelated_engine(
            &manager, game_id, &live, &engines, &unrelated,
        )
        .await;
    }

    #[tokio::test]
    async fn abort_precommit_cancellation_leaves_published_session_untouched() {
        let game_id = "abort_precommit_cancellation_leaves_published_session_untouched";
        let manager = GameManager::new();
        let supervisor = Arc::new(EngineSupervisor::default());
        let (live, engines, unrelated) =
            published_teardown_fixture(&manager, &supervisor, game_id, healthy_teardown_actors())
                .await;
        // Exercise both waits before exact removal commits.
        let lifecycle = manager.lifecycle_lease(game_id);
        let transition = lifecycle.lock().await;
        let mut abort = Box::pin(manager.abort_game(game_id, 1));
        assert!(futures_util::poll!(abort.as_mut()).is_pending());
        drop(abort);
        drop(transition);
        tokio::task::yield_now().await;
        assert_published_teardown_untouched(&manager, game_id, &live, &engines, &unrelated);
        let metadata = manager.session_metadata.lock().await;
        let mut abort = Box::pin(manager.abort_game(game_id, 1));
        assert!(futures_util::poll!(abort.as_mut()).is_pending());
        drop(abort);
        drop(metadata);
        tokio::task::yield_now().await;
        assert_published_teardown_untouched(&manager, game_id, &live, &engines, &unrelated);
        manager.abort_game(game_id, 1).await.unwrap();
        assert_published_teardown_finished_and_cleanup_unrelated_engine(
            &manager, game_id, &live, &engines, &unrelated,
        )
        .await;
    }

    #[tokio::test]
    async fn abort_stale_expected_session_leaves_current_session_untouched() {
        let game_id = "abort_stale_expected_session_leaves_current_session_untouched";
        let manager = GameManager::new();
        let supervisor = Arc::new(EngineSupervisor::default());
        let (live, engines, unrelated) =
            published_teardown_fixture(&manager, &supervisor, game_id, healthy_teardown_actors())
                .await;
        assert!(matches!(manager.abort_game(game_id, 0).await,
            Err(Error::Conflict(message)) if message == "game session is no longer current"));
        assert_published_teardown_untouched(&manager, game_id, &live, &engines, &unrelated);
        manager.abort_game(game_id, 1).await.unwrap();
        assert_published_teardown_finished_and_cleanup_unrelated_engine(
            &manager, game_id, &live, &engines, &unrelated,
        )
        .await;
    }

    #[tokio::test]
    async fn abort_natural_completion_before_removal_commit_preserves_completed_session() {
        let game_id = "abort_natural_completion_before_removal_commit_preserves_completed_session";
        let manager = GameManager::new();
        let supervisor = Arc::new(EngineSupervisor::default());
        let (live, engines, unrelated) =
            published_teardown_fixture(&manager, &supervisor, game_id, healthy_teardown_actors())
                .await;
        let completed_state = {
            let mut controller = live.controller.write().await;
            assert!(controller.end_game(GameResult::Draw {
                reason: DrawReason::Agreement,
            }));
            serde_json::to_value(controller.get_state()).unwrap()
        };
        let metadata = manager.session_metadata.lock().await;
        let mut completion = Box::pin(manager.complete_exact(game_id, 1, &live.controller));
        // Tokio's metadata mutex queues completion ahead of abort's commit.
        assert!(futures_util::poll!(completion.as_mut()).is_pending());
        let mut abort = Box::pin(manager.abort_game(game_id, 1));
        assert!(futures_util::poll!(abort.as_mut()).is_pending());
        assert_published_teardown_untouched(&manager, game_id, &live, &engines, &unrelated);
        drop(metadata);
        completion.await;

        assert!(matches!(abort.await,
            Err(Error::Conflict(message)) if message == "game session changed before abort commit"));
        // Allow any erroneously armed drop remainder to run before observing it.
        tokio::task::yield_now().await;
        assert!(!*live.shutdown.borrow());
        assert!(live.join.lock().unwrap().is_some());
        assert_teardown_engines_owned(&supervisor, &engines);
        for engine in &engines {
            assert!(supervisor
                .get_exact(&engine.key)
                .is_some_and(|entry| entry.generation == engine.generation));
        }
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        assert!(game_cleanup_messages(game_id, 1, "retirement").is_empty());
        assert!(manager.games.get(game_id).is_none());
        {
            let metadata = manager.session_metadata.lock().await;
            let latest = metadata.latest.get(game_id).unwrap();
            assert_eq!(latest.session, 1);
            assert!(matches!(latest.disposition, SessionDisposition::Completed));
            let snapshots = metadata
                .snapshots
                .iter()
                .filter(|snapshot| snapshot.game_id == game_id)
                .collect::<Vec<_>>();
            assert_eq!(snapshots.len(), 1);
            assert_eq!(snapshots[0].session, 1);
            assert_eq!(
                serde_json::to_value(&snapshots[0].state).unwrap(),
                completed_state,
            );
        }
        assert_eq!(
            serde_json::to_value(manager.get_game_state(game_id, 1).await.unwrap()).unwrap(),
            completed_state,
        );

        // Completion metadata does not own this fixture's responsive loop or engines.
        live.finish_retired(Duration::from_secs(1)).await.unwrap();
        for engine in &engines {
            wait_for_generation_gone(&supervisor, &engine.key, engine.generation).await;
        }
        assert!(live.join.lock().unwrap().is_none());
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn abort_failed_termination_logs_diagnostics_once_and_returns_ok() {
        let game_id = "abort_failed_termination_logs_diagnostics_once_and_returns_ok";
        let manager = GameManager::new();
        let supervisor = Arc::new(EngineSupervisor::default());
        let causes = [
            format!("{game_id}-white-cause"),
            format!("{game_id}-black-cause"),
        ];
        let (live, engines, unrelated) = published_teardown_fixture(
            &manager,
            &supervisor,
            game_id,
            [
                EngineActor::failing_terminate_test_actor(causes[0].clone()),
                EngineActor::failing_terminate_test_actor(causes[1].clone()),
            ],
        )
        .await;
        assert!(game_cleanup_messages(game_id, 1, "retirement").is_empty());
        manager.abort_game(game_id, 1).await.unwrap();
        let messages = game_cleanup_messages(game_id, 1, "retirement");
        assert_eq!(
            messages.len(),
            1,
            "committed abort must log one completed retirement failure"
        );
        assert!(messages[0].contains("failed to terminate game engines"));
        for (engine, cause) in engines.iter().zip(causes.iter()) {
            assert!(
                registration_cleanup_messages(&engine.key, engine.generation)
                    .iter()
                    .any(|message| message.contains(cause))
            );
            assert!(!messages[0].contains(cause));
        }
        assert_published_teardown_finished_and_cleanup_unrelated_engine(
            &manager, game_id, &live, &engines, &unrelated,
        )
        .await;
    }

    #[tokio::test]
    async fn shutdown_timeout_fallback_cancellation_retry_cleans_before_retirement() {
        let game_id = "shutdown_timeout_fallback_cancellation_retry_cleans_before_retirement";
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let (white_actor, white_gate, _) = EngineActor::gated_pending_test_actor(None);
        let (black_actor, black_gate, _) = EngineActor::gated_pending_test_actor(None);
        let (live, engines, unrelated) =
            published_teardown_fixture(&manager, &supervisor, game_id, [white_actor, black_actor])
                .await;
        // Keep a receiver alive so the signal is observable even for the stuck loop.
        let shutdown_rx = live.shutdown.subscribe();
        live.join.lock().unwrap().take().unwrap().abort();
        *live.join.lock().unwrap() = Some(tokio::spawn(std::future::pending::<()>()));
        let shutdown = tokio::spawn({
            let manager = manager.clone();
            async move { manager.shutdown_all(Duration::from_millis(10)).await }
        });
        wait_until(|| {
            white_gate.parked.load(Ordering::SeqCst) && black_gate.parked.load(Ordering::SeqCst)
        })
        .await;
        assert!(live.join.lock().unwrap().is_none());
        assert!(*shutdown_rx.borrow());
        assert_teardown_engines_owned(&supervisor, &engines);
        // Both actors have moved into pending ownership, which get_exact misses.
        for engine in &engines {
            assert!(supervisor.get_exact(&engine.key).is_none());
        }
        shutdown.abort();
        assert!(shutdown.await.unwrap_err().is_cancelled());
        assert!(manager.session_is_current(game_id, 1));
        let join_messages = game_cleanup_messages(game_id, 1, "loop join failed");
        assert_eq!(join_messages.len(), 1);
        assert!(join_messages[0].contains("did not exit within"));

        let mut retry = Box::pin(manager.shutdown_all(Duration::from_secs(1)));
        assert!(
            futures_util::poll!(retry.as_mut()).is_pending(),
            "shutdown retry must await pending engine cleanup before retiring the session"
        );
        assert!(manager.session_is_current(game_id, 1));
        assert_teardown_engines_owned(&supervisor, &engines);
        // Block retirement, then observe cleanup completion while still published.
        let metadata = manager.session_metadata.lock().await;
        white_gate.open();
        black_gate.open();
        for engine in &engines {
            wait_for_generation_gone(&supervisor, &engine.key, engine.generation).await;
        }
        assert!(futures_util::poll!(retry.as_mut()).is_pending());
        assert!(manager.session_is_current(game_id, 1));
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        drop(metadata);
        let error = retry.await.unwrap_err();
        assert!(error
            .to_string()
            .contains("game loop did not exit within 10ms"));
        assert_published_teardown_finished_and_cleanup_unrelated_engine(
            &manager, game_id, &live, &engines, &unrelated,
        )
        .await;
    }

    #[tokio::test]
    async fn shutdown_all_signals_and_joins_every_live_session() {
        use std::sync::atomic::AtomicBool;

        let manager = GameManager::new();
        let mut joined_flags = Vec::new();
        for (game_id, session) in [("first", 1u64), ("second", 2u64)] {
            let controller = Arc::new(RwLock::new(
                GameController::new(game_id.into(), session, human_config()).unwrap(),
            ));
            let (shutdown, mut shutdown_rx) = watch::channel(false);
            let joined = Arc::new(AtomicBool::new(false));
            // Stands in for `run_game_loop`, whose tail is what actually
            // terminates that session's engines once the loop breaks.
            let join = tokio::spawn({
                let joined = joined.clone();
                async move {
                    while shutdown_rx.changed().await.is_ok() {
                        if *shutdown_rx.borrow() {
                            break;
                        }
                    }
                    joined.store(true, Ordering::SeqCst);
                }
            });
            manager.games.insert(
                game_id.into(),
                Arc::new(LiveSession {
                    session,
                    controller,
                    shutdown,
                    cleanup: SessionCleanup::default(),
                    join: std::sync::Mutex::new(Some(join)),
                    engine_supervisor: Arc::new(EngineSupervisor::default()),
                }),
            );
            joined_flags.push(joined);
        }

        manager.shutdown_all(Duration::from_secs(1)).await.unwrap();

        assert!(
            manager.games.is_empty(),
            "every session must be removed, not left behind as a live entry"
        );
        for joined in joined_flags {
            assert!(
                joined.load(Ordering::SeqCst),
                "each game loop must be joined, not merely signalled"
            );
        }
    }

    #[tokio::test]
    async fn shutdown_all_is_a_no_op_without_live_sessions() {
        let manager = GameManager::new();
        manager.shutdown_all(Duration::from_secs(1)).await.unwrap();
        assert!(manager.games.is_empty());
    }

    #[tokio::test]
    async fn retained_cleanup_production_loop_failure_survives_replacement_after_retry() {
        assert_production_loop_failure_survives_supervisor_retry("replacement").await;
    }

    #[tokio::test]
    async fn retained_cleanup_production_loop_failure_survives_shutdown_after_retry() {
        assert_production_loop_failure_survives_supervisor_retry("shutdown").await;
    }

    #[tokio::test]
    async fn retained_cleanup_production_loop_failure_survives_retirement_after_retry() {
        assert_production_loop_failure_survives_supervisor_retry("direct").await;
    }

    async fn assert_production_loop_failure_survives_supervisor_retry(retirement: &str) {
        let capture = crate::error::LogCaptureScope::start();
        let game_id = format!("retained-production-{retirement}");
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let white = register_test_game_engine_with_actor(
            &supervisor,
            &game_id,
            1,
            "white",
            "white",
            "white-path",
            EngineActor::recoverable_cleanup_test_actor_with_cause("retained-white-reap-cause"),
        )
        .await;
        let black = register_test_game_engine_with_actor(
            &supervisor,
            &game_id,
            1,
            "black",
            "black",
            "black-path",
            EngineActor::recoverable_cleanup_test_actor_with_cause("retained-black-reap-cause"),
        )
        .await;
        let generations = [white.clone(), black.clone()];
        let (live, controller) = test_live_session_with_supervisor(&game_id, 1, supervisor.clone());
        set_session_engines(&controller, Some(white), Some(black)).await;
        controller.write().await.end_game(GameResult::Draw {
            reason: DrawReason::Stalemate,
        });
        let slot = manager
            .cleanup_observation_slots
            .clone()
            .try_acquire_owned()
            .unwrap();
        *live.cleanup.slot.lock().unwrap() = Some(slot);
        publish_test_session(&manager, &game_id, live.clone()).await;
        let app = tauri::test::mock_app();
        let (_move_tx, move_rx) = tokio::sync::mpsc::channel(1);
        tokio::time::timeout(
            TEST_WAIT,
            game_loop(
                game_id.clone(),
                live.clone(),
                live.shutdown.subscribe(),
                move_rx,
                app.handle().clone(),
                Arc::downgrade(&manager),
            ),
        )
        .await
        .unwrap();
        assert!(
            live.cleanup.failed(),
            "real production loop must retain its failed cleanup"
        );
        let original =
            Error::Conflict("failed to terminate game engines: I/O failure; I/O failure".into());
        let original_payload = serde_json::to_value(&original).unwrap();
        assert_eq!(
            original_payload["message"],
            "Conflict: failed to terminate game engines: I/O failure; I/O failure"
        );
        for (engine, cause) in generations
            .iter()
            .zip(["retained-white-reap-cause", "retained-black-reap-cause"])
        {
            assert!(capture.messages().iter().any(|message| {
                message.contains(&engine.key.engine)
                    && message.contains(&format!("generation={}", engine.generation))
                    && message.contains(cause)
            }));
        }
        assert!(
            manager.games.contains_key(&game_id),
            "natural completion keeps unobserved failed session reachable"
        );
        assert_eq!(
            manager.cleanup_observation_slots.available_permits(),
            MAX_SESSIONS_AWAITING_CLEANUP_OBSERVATION - 1
        );
        assert_eq!(
            manager.get_game_state(&game_id, 1).await.unwrap().status,
            GameStatus::Finished {
                result: GameResult::Draw {
                    reason: DrawReason::Stalemate
                }
            }
        );
        for engine in &generations {
            assert!(supervisor.owns_generation(&engine.key, engine.generation));
            supervisor
                .terminate_exact(&engine.key, engine.generation)
                .await
                .unwrap();
        }
        let result = match retirement {
            "replacement" => {
                manager
                    .retire_replaced_session(&game_id, live.clone(), Duration::from_secs(1))
                    .await
            }
            "shutdown" => manager.shutdown_all(Duration::from_secs(1)).await,
            _ => live.finish_retired(Duration::from_secs(1)).await,
        };
        let observed = result.unwrap_err();
        assert_eq!(observed.category(), crate::error::ErrorCategory::Conflict);
        if retirement == "shutdown" {
            assert_eq!(observed.category(), crate::error::ErrorCategory::Conflict);
            assert_eq!(
                serde_json::to_value(&observed).unwrap()["message"],
                format!("Conflict: failed to shut down one or more games: {game_id}: {original}")
            );
        } else {
            assert_eq!(serde_json::to_value(&observed).unwrap(), original_payload);
        }
        let repeated = live
            .finish_retired(Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(serde_json::to_value(&repeated).unwrap(), original_payload);
        for (engine, cause) in generations
            .iter()
            .zip(["retained-white-reap-cause", "retained-black-reap-cause"])
        {
            assert!(
                capture.messages().iter().any(|message| {
                    message.contains(&engine.key.engine)
                        && message.contains(&format!("generation={}", engine.generation))
                        && message.contains(cause)
                }),
                "native causes remain observable after recovery and {retirement}"
            );
        }
        assert_eq!(
            manager.cleanup_observation_slots.available_permits(),
            MAX_SESSIONS_AWAITING_CLEANUP_OBSERVATION
        );
    }

    #[tokio::test]
    async fn retained_cleanup_game_capacity_refuses_before_launch() {
        let manager = Arc::new(GameManager {
            cleanup_observation_slots: Arc::new(Semaphore::new(1)),
            ..GameManager::new()
        });
        let slot = manager
            .cleanup_observation_slots
            .clone()
            .try_acquire_owned()
            .unwrap();
        let app = tauri::test::mock_app();
        let directory = tempfile::tempdir().unwrap();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(
            PathAuthority::open(directory.path().join("registry.json"), Vec::new()).unwrap(),
        );
        let result = manager
            .start_game(
                "capacity".into(),
                human_config(),
                app.handle().clone(),
                authority,
                Arc::new(EngineSupervisor::default()),
            )
            .await;
        if result.is_ok() {
            manager.shutdown_all(Duration::from_secs(1)).await.unwrap();
        }
        assert!(
            matches!(result, Err(Error::ResourceLimit(_))),
            "unobserved session capacity is reserved before launch"
        );
        assert_eq!(
            manager.next_session.load(Ordering::SeqCst),
            0,
            "overflow must refuse before allocating a session"
        );
        drop(slot);
        assert_eq!(manager.cleanup_observation_slots.available_permits(), 1);
    }

    #[tokio::test]
    async fn retained_cleanup_shutdown_visits_failed_session_once() {
        let manager = Arc::new(GameManager::new());
        let (live, _) = test_live_session("retained-failed-shutdown", 1);
        live.cleanup
            .record(Err(Error::EngineTimeout("unconfirmed reap".into())));
        publish_test_session(&manager, "retained-failed-shutdown", live.clone()).await;
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            manager.shutdown_all(Duration::from_millis(10)),
        )
        .await
        .expect("failed sessions cannot make shutdown rescan forever");
        assert!(result.is_err());
        assert!(manager.games.is_empty());
        assert!(live.cleanup.outcome().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn retained_cleanup_concurrent_retirement_observes_pending_join_failure() {
        for panic in [true, false] {
            let (live, _) = test_live_session("serialized-join-observation", 1);
            let slots = Arc::new(Semaphore::new(1));
            *live.cleanup.slot.lock().unwrap() = Some(slots.clone().try_acquire_owned().unwrap());
            let (release, released) = tokio::sync::oneshot::channel::<()>();
            *live.join.lock().unwrap() = Some(tokio::spawn(async move {
                let _ = released.await;
                if panic {
                    panic!("serialized-join-native-panic");
                }
                std::future::pending::<()>().await;
            }));
            let taken = Arc::new(AtomicBool::new(false));
            SHUTDOWN_JOIN_TAKEN_HOOKS.arm(
                ("serialized-join-observation".into(), 1),
                Box::new({
                    let taken = taken.clone();
                    move || taken.store(true, Ordering::SeqCst)
                }),
            );
            let budget = Duration::from_millis(20);
            let mut first = Box::pin(live.finish_retired(budget));
            assert!(futures_util::poll!(first.as_mut()).is_pending());
            assert!(
                taken.load(Ordering::SeqCst),
                "first owner took an actually pending join"
            );
            let mut second = Box::pin(live.finish_retired(budget));
            assert!(
                futures_util::poll!(second.as_mut()).is_pending(),
                "second owner must await join observation"
            );
            assert_eq!(
                slots.available_permits(),
                0,
                "pending observation retains capacity"
            );
            release.send(()).unwrap();
            let (first, second) = tokio::join!(first, second);
            let first = first.unwrap_err();
            let second = second.unwrap_err();
            let expected = if panic {
                "Conflict: game loop join failed".into()
            } else {
                format!("Conflict: game loop did not exit within {budget:?}")
            };
            assert_eq!(first.category(), crate::error::ErrorCategory::Conflict);
            assert_eq!(serde_json::to_value(&first).unwrap()["message"], expected);
            assert_eq!(
                serde_json::to_value(&second).unwrap(),
                serde_json::to_value(&first).unwrap()
            );
            let repeated = live.finish_retired(budget).await.unwrap_err();
            assert_eq!(
                serde_json::to_value(&repeated).unwrap(),
                serde_json::to_value(&first).unwrap()
            );
            assert_eq!(slots.available_permits(), 1);
        }
    }

    #[tokio::test]
    async fn retained_cleanup_game_panic_marker_stays_native() {
        let capture = crate::error::LogCaptureScope::start();
        const MARKER: &str = "/private/retained-game-panic-marker";
        let (live, _) = test_live_session("retained-game-panic", 1);
        *live.join.lock().unwrap() = Some(tokio::spawn(async { panic!("{MARKER}") }));
        let error = live
            .finish_retired(Duration::from_secs(1))
            .await
            .unwrap_err();
        let direct = serde_json::to_string(&error).unwrap();
        let composite =
            serde_json::to_string(&Error::with_cleanup(Error::Cancellation, Err(error))).unwrap();
        assert!(
            !direct.contains(MARKER),
            "game join payload cannot leak a panic path"
        );
        assert!(!composite.contains(MARKER));
        assert!(
            capture.records().iter().any(|record| {
                record.level == log::Level::Error
                    && record.message.contains("game loop join failed")
                    && record
                        .message
                        .contains("game_id=retained-game-panic session=1")
                    && record.message.contains(MARKER)
            }),
            "native join diagnostics retain panic context"
        );
        let repeated = live
            .finish_retired(Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(repeated.category(), crate::error::ErrorCategory::Conflict);
        assert!(!serde_json::to_string(&repeated).unwrap().contains(MARKER));
    }

    #[tokio::test]
    async fn shutdown_all_seals_the_manager_against_new_games() {
        let manager = GameManager::new();
        manager.shutdown_all(Duration::from_secs(1)).await.unwrap();
        assert!(matches!(
            manager.ensure_accepting_starts(),
            Err(Error::Conflict(message)) if message == "application is shutting down"
        ));
    }

    #[tokio::test]
    async fn shutdown_all_drains_a_session_published_while_shutdown_is_running() {
        let manager = Arc::new(GameManager::new());
        let controller = Arc::new(RwLock::new(
            GameController::new("initial".into(), 1, human_config()).unwrap(),
        ));
        let (shutdown, mut shutdown_rx) = watch::channel(false);
        let initial_join = tokio::spawn(async move {
            while shutdown_rx.changed().await.is_ok() {
                if *shutdown_rx.borrow() {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    break;
                }
            }
        });
        manager.games.insert(
            "initial".into(),
            Arc::new(LiveSession {
                session: 1,
                controller,
                shutdown,
                cleanup: SessionCleanup::default(),
                join: std::sync::Mutex::new(Some(initial_join)),
                engine_supervisor: Arc::new(EngineSupervisor::default()),
            }),
        );

        let shutdown = tokio::spawn({
            let manager = manager.clone();
            async move { manager.shutdown_all(Duration::from_secs(1)).await }
        });
        while !manager.sealed.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
        let controller = Arc::new(RwLock::new(
            GameController::new("slipped".into(), 2, human_config()).unwrap(),
        ));
        let (slipped_shutdown, mut slipped_shutdown_rx) = watch::channel(false);
        let joined = Arc::new(AtomicBool::new(false));
        let slipped_join = tokio::spawn({
            let joined = joined.clone();
            async move {
                while slipped_shutdown_rx.changed().await.is_ok() {
                    if *slipped_shutdown_rx.borrow() {
                        joined.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            }
        });
        manager.games.insert(
            "slipped".into(),
            Arc::new(LiveSession {
                session: 2,
                controller,
                shutdown: slipped_shutdown,
                cleanup: SessionCleanup::default(),
                join: std::sync::Mutex::new(Some(slipped_join)),
                engine_supervisor: Arc::new(EngineSupervisor::default()),
            }),
        );

        shutdown.await.unwrap().unwrap();
        assert!(manager.games.is_empty());
        assert!(joined.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn caller_budget_abandons_a_game_loop_that_never_exits() {
        let manager = GameManager::new();
        let supervisor = Arc::new(EngineSupervisor::default());
        let registered =
            register_test_game_engine(&supervisor, "stuck", 1, "white", "engine-a", "handle-a")
                .await;
        let mut game_controller = GameController::new("stuck".into(), 1, human_config()).unwrap();
        game_controller.white_engine = Some(registered.clone());
        let controller = Arc::new(RwLock::new(game_controller));
        let (shutdown, _) = watch::channel(false);
        let join = tokio::spawn(std::future::pending::<()>());
        manager.games.insert(
            "stuck".into(),
            Arc::new(LiveSession {
                session: 1,
                controller,
                shutdown,
                cleanup: SessionCleanup::default(),
                join: std::sync::Mutex::new(Some(join)),
                engine_supervisor: supervisor.clone(),
            }),
        );

        let budget = Duration::from_millis(50);
        let started = std::time::Instant::now();
        assert!(manager.shutdown_all(budget).await.is_err());
        assert!(started.elapsed() >= budget);
        assert!(manager.games.is_empty());
        assert!(supervisor.get_exact(&registered.key).is_none());
    }

    #[tokio::test]
    async fn shutdown_all_and_supervisor_termination_are_generation_safe_in_parallel() {
        let manager = GameManager::new();
        let supervisor = Arc::new(EngineSupervisor::default());
        let registered =
            register_test_game_engine(&supervisor, "parallel", 1, "white", "engine-a", "handle-a")
                .await;
        let mut game_controller =
            GameController::new("parallel".into(), 1, human_config()).unwrap();
        game_controller.white_engine = Some(registered.clone());
        let controller = Arc::new(RwLock::new(game_controller));
        let (shutdown, mut shutdown_rx) = watch::channel(false);
        let join = tokio::spawn({
            let supervisor = supervisor.clone();
            let registered = registered.clone();
            async move {
                while shutdown_rx.changed().await.is_ok() {
                    if *shutdown_rx.borrow() {
                        let _ = supervisor
                            .terminate_exact(&registered.key, registered.generation)
                            .await;
                        break;
                    }
                }
            }
        });
        manager.games.insert(
            "parallel".into(),
            Arc::new(LiveSession {
                session: 1,
                controller,
                shutdown,
                cleanup: SessionCleanup::default(),
                join: std::sync::Mutex::new(Some(join)),
                engine_supervisor: supervisor.clone(),
            }),
        );

        let (games, engines) = tokio::join!(
            manager.shutdown_all(Duration::from_secs(1)),
            supervisor.terminate_all()
        );

        games.unwrap();
        engines.unwrap();
        assert!(manager.games.is_empty());
        assert!(supervisor.get_exact(&registered.key).is_none());
    }

    #[tokio::test]
    async fn tombstoned_latest_session_never_falls_back_to_an_older_snapshot() {
        let manager = GameManager::new();
        let old_state = GameController::new("game".into(), 1, human_config())
            .unwrap()
            .get_state();
        let mut metadata = manager.session_metadata.lock().await;
        metadata.snapshots.push_back(CompletedSnapshot {
            game_id: "game".into(),
            session: 1,
            state: old_state,
        });
        metadata.latest.insert(
            "game".into(),
            LatestSession {
                session: 2,
                disposition: SessionDisposition::Tombstoned,
            },
        );
        drop(metadata);

        assert!(matches!(
            manager.get_game_state("game", 2).await,
            Err(Error::GameNotFound(_))
        ));
        assert!(matches!(
            manager.get_game_state("game", 1).await,
            Err(Error::Conflict(_))
        ));
    }

    #[tokio::test]
    async fn evicting_a_tombstones_last_snapshot_never_reveals_the_old_session() {
        let manager = GameManager::new();
        {
            let mut metadata = manager.session_metadata.lock().await;
            metadata.snapshots.push_back(CompletedSnapshot {
                game_id: "old".into(),
                session: 1,
                state: GameController::new("old".into(), 1, human_config())
                    .unwrap()
                    .get_state(),
            });
            metadata.latest.insert(
                "old".into(),
                LatestSession {
                    session: 2,
                    disposition: SessionDisposition::Tombstoned,
                },
            );
        }
        for session in 1..=COMPLETED_GAME_SNAPSHOTS {
            let game_id = format!("new-{session}");
            let (live, controller) = test_live_session(&game_id, session as u64);
            manager
                .publish_live(game_id.clone(), session as u64, live, || {})
                .await
                .unwrap();
            manager
                .complete_exact(&game_id, session as u64, &controller)
                .await;
        }

        assert!(matches!(
            manager.get_game_state("old", 1).await,
            Err(Error::GameNotFound(_))
        ));
        let metadata = manager.session_metadata.lock().await;
        assert!(!metadata.latest.contains_key("old"));
        assert!(!metadata
            .snapshots
            .iter()
            .any(|snapshot| snapshot.game_id == "old"));
    }

    #[test]
    fn epd_reader_errors_are_not_silently_treated_as_end_of_book() {
        assert!(select_random_epd_entry(BufReader::new(Cursor::new(vec![0xff]))).is_err());
    }

    #[test]
    fn emission_diagnostics_and_safe_label_mapping_are_session_isolated() {
        let capture = crate::error::LogCaptureScope::start();
        const RAW_MARKER: &str = "raw-sensitive-error-marker-must-never-leak-to-logs";

        let mut ctrl1 = GameController::new("session-1".into(), 1, human_config()).unwrap();

        // 1. Session 1: First Move failure emits safe diagnostic log with all fields and returns safe label.
        let res1 = ctrl1.attempt_event_emission(GameEventKind::Move, 1, || {
            Err(tauri::Error::Json(
                serde_json::from_str::<i32>(RAW_MARKER).unwrap_err(),
            ))
        });
        assert_eq!(res1, Some("serialization"));
        let records = capture.records();
        assert_eq!(
            records.len(),
            1,
            "first move failure must emit exactly one log record"
        );
        assert_eq!(records[0].level, log::Level::Warn);
        assert!(records[0].message.contains("kind=move"));
        assert!(records[0].message.contains("game_id=session-1"));
        assert!(records[0].message.contains("session=1"));
        assert!(records[0].message.contains("revision=1"));
        assert!(records[0].message.contains("cause=serialization"));

        // 2. Second Move failure in same session is suppressed (at most one failure per kind/session).
        let res2 = ctrl1.attempt_event_emission(GameEventKind::Move, 2, || {
            Err(tauri::Error::Io(std::io::Error::other(RAW_MARKER)))
        });
        assert_eq!(res2, None);
        assert_eq!(
            capture.records().len(),
            1,
            "subsequent move failure in same session must be suppressed"
        );

        // 3. Subsequent successful Move emission still happens even after latch is set.
        let mut move_emitted = false;
        let res_ok = ctrl1.attempt_event_emission(GameEventKind::Move, 3, || {
            move_emitted = true;
            Ok(())
        });
        assert!(
            move_emitted,
            "move emission must still be attempted after latching"
        );
        assert_eq!(res_ok, None);

        // 4. Session 1: First Clock failure emits safe diagnostic log and returns safe label.
        let res_clock1 = ctrl1.attempt_event_emission(GameEventKind::Clock, 1, || {
            Err(tauri::Error::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                RAW_MARKER,
            )))
        });
        assert_eq!(res_clock1, Some("io"));
        let records = capture.records();
        assert_eq!(
            records.len(),
            2,
            "first clock failure must emit exactly one log record"
        );
        assert_eq!(records[1].level, log::Level::Warn);
        assert!(records[1].message.contains("kind=clock"));
        assert!(records[1].message.contains("game_id=session-1"));
        assert!(records[1].message.contains("session=1"));
        assert!(records[1].message.contains("revision=1"));
        assert!(records[1].message.contains("cause=io"));

        // 5. Second Clock failure suppressed.
        let res_clock2 =
            ctrl1.attempt_event_emission(GameEventKind::Clock, 2, || Err(tauri::Error::NoParent));
        assert_eq!(res_clock2, None);
        assert_eq!(
            capture.records().len(),
            2,
            "subsequent clock failure in same session must be suppressed"
        );

        // 6. Subsequent successful Clock emission still happens.
        let mut clock_emitted = false;
        let res_clock_ok = ctrl1.attempt_event_emission(GameEventKind::Clock, 3, || {
            clock_emitted = true;
            Ok(())
        });
        assert!(
            clock_emitted,
            "clock emission must still be attempted after latching"
        );
        assert_eq!(res_clock_ok, None);

        // 7. Session 1: First Terminal failure emits safe diagnostic log and returns safe label.
        let res_term1 = ctrl1.attempt_event_emission(GameEventKind::GameOver, 1, || {
            Err(tauri::Error::FailedToReceiveMessage)
        });
        assert_eq!(res_term1, Some("message-receive"));
        let records = capture.records();
        assert_eq!(
            records.len(),
            3,
            "first terminal failure must emit exactly one log record"
        );
        assert_eq!(records[2].level, log::Level::Warn);
        assert!(records[2].message.contains("kind=game-over"));
        assert!(records[2].message.contains("game_id=session-1"));
        assert!(records[2].message.contains("session=1"));
        assert!(records[2].message.contains("revision=1"));
        assert!(records[2].message.contains("cause=message-receive"));

        // 8. Second Terminal failure suppressed.
        let res_term2 = ctrl1
            .attempt_event_emission(GameEventKind::GameOver, 2, || Err(tauri::Error::NoParent));
        assert_eq!(res_term2, None);
        assert_eq!(
            capture.records().len(),
            3,
            "subsequent terminal failure in same session must be suppressed"
        );

        // 9. Subsequent successful GameOver emission still happens.
        let mut term_emitted = false;
        let res_term_ok = ctrl1.attempt_event_emission(GameEventKind::GameOver, 3, || {
            term_emitted = true;
            Ok(())
        });
        assert!(
            term_emitted,
            "terminal emission must still be attempted after latching"
        );
        assert_eq!(res_term_ok, None);

        // 10. Session 2 isolation: A fresh session reports anew for each kind.
        let mut ctrl2 = GameController::new("session-2".into(), 2, human_config()).unwrap();

        let s2_move = ctrl2.attempt_event_emission(GameEventKind::Move, 1, || {
            Err(tauri::Error::Json(
                serde_json::from_str::<i32>(RAW_MARKER).unwrap_err(),
            ))
        });
        assert_eq!(s2_move, Some("serialization"));

        let s2_clock = ctrl2.attempt_event_emission(GameEventKind::Clock, 1, || {
            Err(tauri::Error::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                RAW_MARKER,
            )))
        });
        assert_eq!(s2_clock, Some("io"));

        let s2_term = ctrl2.attempt_event_emission(GameEventKind::GameOver, 1, || {
            Err(tauri::Error::FailedToReceiveMessage)
        });
        assert_eq!(s2_term, Some("message-receive"));

        let all_records = capture.records();
        assert_eq!(
            all_records.len(),
            6,
            "session 2 must report all three failures anew"
        );
        assert_eq!(all_records[3].level, log::Level::Warn);
        assert!(all_records[3].message.contains("kind=move"));
        assert!(all_records[3].message.contains("game_id=session-2"));
        assert!(all_records[3].message.contains("session=2"));
        assert!(all_records[3].message.contains("revision=1"));
        assert!(all_records[3].message.contains("cause=serialization"));

        assert_eq!(all_records[4].level, log::Level::Warn);
        assert!(all_records[4].message.contains("kind=clock"));
        assert!(all_records[4].message.contains("game_id=session-2"));
        assert!(all_records[4].message.contains("session=2"));
        assert!(all_records[4].message.contains("revision=1"));
        assert!(all_records[4].message.contains("cause=io"));

        assert_eq!(all_records[5].level, log::Level::Warn);
        assert!(all_records[5].message.contains("kind=game-over"));
        assert!(all_records[5].message.contains("game_id=session-2"));
        assert!(all_records[5].message.contains("session=2"));
        assert!(all_records[5].message.contains("revision=1"));
        assert!(all_records[5].message.contains("cause=message-receive"));

        // 11. Raw error marker must be absent across all captured records.
        assert!(
            capture
                .messages()
                .iter()
                .all(|msg| !msg.contains(RAW_MARKER)),
            "raw error marker must not appear in any diagnostic warning output"
        );
    }

    #[tokio::test]
    async fn failed_terminal_emission_attempt_still_permits_completion_and_exact_query() {
        let manager = Arc::new(GameManager::new());
        let game_id = "test-terminal-fail";
        let session = 1u64;
        let (live, controller) = test_live_session(game_id, session);
        manager
            .publish_live(game_id.into(), session, live, || {})
            .await
            .unwrap();

        let mut ctrl = controller.write().await;
        let end_res = ctrl.end_game(GameResult::WhiteWins {
            reason: GameEndReason::Checkmate,
        });
        assert!(end_res);
        assert!(!ctrl.terminal_attempt_claimed);

        // Injected terminal failure
        let claimed = attempt_terminal_event_emission_with(&mut ctrl, |_| {
            Err(tauri::Error::FailedToReceiveMessage)
        });
        assert!(
            claimed,
            "terminal attempt must be claimed even if emission fails"
        );
        assert!(ctrl.terminal_attempt_claimed);

        // Second call must return false (once-only claim)
        let second_claim = attempt_terminal_event_emission_with(&mut ctrl, |_| Ok(()));
        assert!(!second_claim, "competing terminal attempt must be rejected");

        // Authoritative state remains completely intact
        assert_eq!(
            ctrl.status,
            GameStatus::Finished {
                result: GameResult::WhiteWins {
                    reason: GameEndReason::Checkmate,
                },
            }
        );
        drop(ctrl);

        // Completion proceeds normally, retaining exact completed snapshot
        manager.complete_exact(game_id, session, &controller).await;

        // Exact retained query succeeds
        let snapshot = manager.get_game_state(game_id, session).await.unwrap();
        assert_eq!(snapshot.game_id, game_id);
        assert_eq!(snapshot.session, session);
        assert_eq!(
            snapshot.status,
            GameStatus::Finished {
                result: GameResult::WhiteWins {
                    reason: GameEndReason::Checkmate,
                },
            }
        );
    }

    #[test]
    fn move_and_clock_emission_failures_preserve_authoritative_state() {
        let mut config = human_config();
        config.white_time_control = Some(TimeControl {
            initial_time: 60_000,
            increment: 1_000,
        });
        config.black_time_control = Some(TimeControl {
            initial_time: 60_000,
            increment: 1_000,
        });
        let mut ctrl = GameController::new("session-auth".into(), 1, config).unwrap();
        assert_eq!(ctrl.moves.len(), 0);
        assert_eq!(ctrl.position.turn(), Color::White);
        let initial_fen =
            Fen::from_position(ctrl.position.clone(), EnPassantMode::Legal).to_string();
        assert_eq!(
            initial_fen,
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        );
        assert_eq!(ctrl.clock.as_ref().unwrap().white_time, Some(60_000));
        assert_eq!(ctrl.clock.as_ref().unwrap().black_time, Some(60_000));

        // 1. Move emission failure preserves applied move in authoritative state
        let game_move = ctrl.apply_move("e2e4").expect("legal move");
        assert_eq!(ctrl.moves.len(), 1);
        assert_eq!(ctrl.moves[0].uci, "e2e4");
        assert_eq!(ctrl.position.turn(), Color::Black);

        let fen_after_move =
            Fen::from_position(ctrl.position.clone(), EnPassantMode::Legal).to_string();
        assert_eq!(
            fen_after_move,
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
        );
        assert_eq!(game_move.fen_after, fen_after_move);

        let stored_white_pre_move_emit = ctrl.clock.as_ref().unwrap().white_time;
        let stored_black_pre_move_emit = ctrl.clock.as_ref().unwrap().black_time;

        let move_revision = ctrl.move_event_revision();
        let res = ctrl.attempt_event_emission(GameEventKind::Move, move_revision, || {
            Err(tauri::Error::Json(
                serde_json::from_str::<i32>("bad").unwrap_err(),
            ))
        });
        assert_eq!(res, Some("serialization"));
        assert_eq!(ctrl.moves.len(), 1);
        assert_eq!(ctrl.moves[0].uci, "e2e4");
        assert_eq!(ctrl.position.turn(), Color::Black);
        assert_eq!(ctrl.status, GameStatus::Playing);

        // Assert FEN consistency across failed move emission
        let fen_after_failed_emit =
            Fen::from_position(ctrl.position.clone(), EnPassantMode::Legal).to_string();
        assert_eq!(fen_after_failed_emit, fen_after_move);
        let state = ctrl.get_state();
        assert_eq!(state.current_fen, fen_after_move);
        assert_eq!(state.moves.len(), 1);
        assert_eq!(state.moves[0].uci, "e2e4");
        assert_eq!(state.turn, "black");

        // Assert stored clock times remain unchanged across failed move emission
        assert_eq!(
            ctrl.clock.as_ref().unwrap().white_time,
            stored_white_pre_move_emit
        );
        assert_eq!(
            ctrl.clock.as_ref().unwrap().black_time,
            stored_black_pre_move_emit
        );

        // 2. Clock emission failure preserves clock time and revision in authoritative state
        // Control last_tick to a known deterministic offset in the past
        ctrl.clock.as_mut().unwrap().last_tick = Instant::now() - Duration::from_secs(5);
        let stored_white_pre_clock = ctrl.clock.as_ref().unwrap().white_time;
        let stored_black_pre_clock = ctrl.clock.as_ref().unwrap().black_time;

        let before_revision = ctrl.revision;
        ctrl.bump_revision();
        let clock_revision = ctrl.revision;
        assert_eq!(clock_revision, before_revision + 1);

        let res_clock = ctrl.attempt_event_emission(GameEventKind::Clock, clock_revision, || {
            Err(tauri::Error::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "broken",
            )))
        });
        assert_eq!(res_clock, Some("io"));
        assert_eq!(ctrl.revision, clock_revision);
        assert_eq!(ctrl.status, GameStatus::Playing);

        // Assert stored times remain unchanged across failed clock emission
        assert_eq!(
            ctrl.clock.as_ref().unwrap().white_time,
            stored_white_pre_clock
        );
        assert_eq!(
            ctrl.clock.as_ref().unwrap().black_time,
            stored_black_pre_clock
        );

        // Assert authoritative returned times have controlled last_tick and deterministic bounds
        let (auth_white, auth_black) = ctrl.get_current_times();
        assert_eq!(auth_white, stored_white_pre_clock);
        let black_stored = stored_black_pre_clock.unwrap();
        let black_current = auth_black.unwrap();
        assert!(
            black_current <= black_stored.saturating_sub(5_000)
                && black_current >= black_stored.saturating_sub(6_000),
            "black authoritative returned time ({black_current}) must reflect controlled elapsed time within deterministic bounds [{}, {}]",
            black_stored.saturating_sub(6_000),
            black_stored.saturating_sub(5_000)
        );

        // Assert FEN consistency across failed clock emission
        let fen_after_clock_emit =
            Fen::from_position(ctrl.position.clone(), EnPassantMode::Legal).to_string();
        assert_eq!(fen_after_clock_emit, fen_after_move);
        let state_after_clock = ctrl.get_state();
        assert_eq!(state_after_clock.current_fen, fen_after_move);
    }

    #[tokio::test]
    async fn never_started_published_loop_reaps_and_tombstones_its_session() {
        let game_id = "never_started_published_loop_reaps_and_tombstones_its_session";
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let unrelated = register_unrelated_test_engine(&supervisor, game_id).await;
        let white = register_test_game_engine(
            &supervisor,
            game_id,
            1,
            "white",
            "never-started-white",
            "never-started-white-handle",
        )
        .await;
        let black = register_test_game_engine(
            &supervisor,
            game_id,
            1,
            "black",
            "never-started-black",
            "never-started-black-handle",
        )
        .await;
        let white_key = white.key.clone();
        let black_key = black.key.clone();
        let (live, controller) = test_live_session_with_supervisor(game_id, 1, supervisor.clone());
        set_session_engines(&controller, Some(white.clone()), Some(black.clone())).await;
        publish_test_session(&manager, game_id, live.clone()).await;
        let (start_loop, start_loop_rx) = tokio::sync::oneshot::channel();
        drop(start_loop);
        let (_, move_notify_rx) = tokio::sync::mpsc::channel(1);
        let app = tauri::test::mock_app();
        let shutdown_rx = live.shutdown.subscribe();

        run_published_loop(
            game_id.into(),
            live,
            shutdown_rx,
            move_notify_rx,
            app.handle().clone(),
            Arc::downgrade(&manager),
            start_loop_rx,
        )
        .await;

        assert!(supervisor.get_exact(&white_key).is_none());
        assert!(supervisor.get_exact(&black_key).is_none());
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn never_started_published_loop_retires_even_when_both_terminations_fail() {
        let game_id = "never_started_published_loop_retires_even_when_both_terminations_fail";
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let unrelated = register_unrelated_test_engine(&supervisor, game_id).await;
        let white_error = format!("{game_id}-white-termination-failure");
        let black_error = format!("{game_id}-black-termination-failure");
        let white = register_test_game_engine_with_actor(
            &supervisor,
            game_id,
            1,
            "white",
            "never-started-failing-white",
            "never-started-failing-white-handle",
            EngineActor::failing_terminate_test_actor(white_error.clone()),
        )
        .await;
        let black = register_test_game_engine_with_actor(
            &supervisor,
            game_id,
            1,
            "black",
            "never-started-failing-black",
            "never-started-failing-black-handle",
            EngineActor::failing_terminate_test_actor(black_error.clone()),
        )
        .await;
        let white_key = white.key.clone();
        let white_generation = white.generation;
        let black_key = black.key.clone();
        let black_generation = black.generation;
        assert!(registration_cleanup_messages(&white_key, white_generation).is_empty());
        assert!(registration_cleanup_messages(&black_key, black_generation).is_empty());
        let (live, controller) = test_live_session_with_supervisor(game_id, 1, supervisor.clone());
        set_session_engines(&controller, Some(white), Some(black)).await;
        publish_test_session(&manager, game_id, live.clone()).await;
        let (start_loop, start_loop_rx) = tokio::sync::oneshot::channel();
        drop(start_loop);
        let (_, move_notify_rx) = tokio::sync::mpsc::channel(1);
        let app = tauri::test::mock_app();
        let shutdown_rx = live.shutdown.subscribe();

        run_published_loop(
            game_id.into(),
            live.clone(),
            shutdown_rx,
            move_notify_rx,
            app.handle().clone(),
            Arc::downgrade(&manager),
            start_loop_rx,
        )
        .await;

        assert!(supervisor.get_exact(&white_key).is_none());
        assert!(supervisor.get_exact(&black_key).is_none());
        let white_messages = registration_cleanup_messages(&white_key, white_generation);
        let black_messages = registration_cleanup_messages(&black_key, black_generation);
        assert!(white_messages
            .iter()
            .any(|message| message.contains(&white_error)));
        assert!(black_messages
            .iter()
            .any(|message| message.contains(&black_error)));
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn construction_abandon_returns_and_logs_cleanup_failure() {
        let game_id = "construction_abandon_returns_and_logs_cleanup_failure";
        let supervisor = Arc::new(EngineSupervisor::default());
        let error_text = format!("{game_id}-terminate-os-cause");
        let registered = register_test_game_engine_with_actor(
            &supervisor,
            game_id,
            1,
            "white",
            "construction-failing-engine",
            "construction-failing-handle",
            EngineActor::failing_terminate_test_actor(error_text.clone()),
        )
        .await;
        assert!(registration_cleanup_messages(&registered.key, registered.generation).is_empty());
        assert!(game_cleanup_messages(game_id, 1, "construction abandoned").is_empty());
        let mut construction = GameEngineConstruction::new(game_id.into(), 1);
        construction.own(RegistrationGuard::new(
            supervisor.clone(),
            registered.key.clone(),
            registered.generation,
        ));

        let error = construction
            .abandon(Error::Conflict("construction primary sentinel".into()))
            .await;

        match error {
            Error::OperationAndCleanup { primary, cleanup } => {
                assert_eq!(primary, "Conflict: construction primary sentinel");
                assert!(cleanup.contains("failed to terminate game engines"));
                assert!(!cleanup.contains(&error_text));
            }
            other => panic!("expected a folded construction error, got {other:?}"),
        }
        assert!(supervisor.get_exact(&registered.key).is_none());
        assert!(
            registration_cleanup_messages(&registered.key, registered.generation)
                .iter()
                .any(|message| message.contains(&error_text))
        );
        let messages = game_cleanup_messages(game_id, 1, "construction abandoned");
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("construction primary sentinel"));
        assert!(messages[0].contains("failed to terminate game engines"));
        assert!(!messages[0].contains(&error_text));
    }

    #[test]
    fn aggregate_game_engine_termination_error_keeps_os_cause_out_of_ipc() {
        const CAUSE: &str = "aggregate-game-termination-os-cause";
        let error = aggregate_game_engine_termination_results([Err(Error::from(
            std::io::Error::other(CAUSE),
        ))])
        .expect_err("the aggregate reports the failed termination");

        assert!(error
            .to_string()
            .contains("failed to terminate game engines"));
        assert!(!error.to_string().contains(CAUSE));
        let serialized = serde_json::to_string(&error).unwrap();
        assert!(!serialized.contains(CAUSE));
    }

    #[tokio::test]
    async fn construction_abandon_logs_cleanup_failure_already_in_primary() {
        let game_id = "construction_abandon_logs_cleanup_failure_already_in_primary";
        let supervisor = Arc::new(EngineSupervisor::default());
        let registered = register_test_game_engine(
            &supervisor,
            game_id,
            1,
            "white",
            "construction-success-engine",
            "construction-success-handle",
        )
        .await;
        assert!(game_cleanup_messages(game_id, 1, "construction abandoned").is_empty());
        let primary = Error::with_cleanup(
            std::io::Error::other(format!("{game_id}-primary-io-cause")).into(),
            Err(std::io::Error::other(format!("{game_id}-primary-cleanup-cause")).into()),
        );
        let mut construction = GameEngineConstruction::new(game_id.into(), 1);
        construction.own(RegistrationGuard::new(
            supervisor.clone(),
            registered.key.clone(),
            registered.generation,
        ));

        let error = construction.abandon(primary).await;

        match error {
            Error::OperationAndCleanup { primary, cleanup } => {
                assert!(primary.contains(&format!("{game_id}-primary-io-cause")));
                assert!(cleanup.contains(&format!("{game_id}-primary-cleanup-cause")));
            }
            other => panic!("expected the original folded error, got {other:?}"),
        }
        assert!(supervisor.get_exact(&registered.key).is_none());
        let messages = game_cleanup_messages(game_id, 1, "construction abandoned");
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains(&format!("{game_id}-primary-io-cause")));
        assert!(messages[0].contains(&format!("{game_id}-primary-cleanup-cause")));
    }

    #[tokio::test]
    async fn construction_abandon_logs_operation_and_cleanup_primary_without_guards() {
        let game_id = "construction_abandon_logs_operation_and_cleanup_primary_without_guards";
        assert!(game_cleanup_messages(game_id, 1, "construction abandoned").is_empty());
        let primary = Error::with_cleanup(
            std::io::Error::other(format!("{game_id}-primary-cause")).into(),
            Err(std::io::Error::other(format!("{game_id}-primary-cleanup-cause")).into()),
        );
        let construction = GameEngineConstruction::new(game_id.into(), 1);

        let error = construction.abandon(primary).await;

        assert!(matches!(error, Error::OperationAndCleanup { .. }));
        let messages = game_cleanup_messages(game_id, 1, "construction abandoned");
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains(&format!("{game_id}-primary-cause")));
        assert!(messages[0].contains(&format!("{game_id}-primary-cleanup-cause")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn start_game_preserves_black_spawn_error_and_abandons_white_generation() {
        let game_id = "start_game_preserves_black_spawn_error_and_abandons_white_generation";
        let bundle = test_game_engine_bundle(game_id, TestEngineScript::Responsive, false);
        let PlayerConfig::Engine {
            handle, options, ..
        } = &bundle.config.black
        else {
            panic!("test engine bundle must have an engine as black");
        };
        let expected_supervisor = Arc::new(EngineSupervisor::default());
        let expected_registration = game_engine_registration_for_side(
            &bundle.config.black,
            &expected_supervisor,
            game_id,
            1,
            "black",
        )
        .unwrap()
        .unwrap();
        let expected = match spawn_configured_game_engine(
            expected_registration,
            handle.clone(),
            options,
            bundle.authority.clone(),
            false,
        )
        .await
        {
            Ok(_) => panic!("the unregistered black executable must fail to resolve"),
            Err(error) => error,
        };
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let unrelated = register_unrelated_test_engine(&supervisor, game_id).await;
        let white_key = game_side_engine_key(game_id, 1, "white", &bundle.white_engine_id).unwrap();
        let white_generation = Arc::new(AtomicU64::new(0));
        let generation_for_hook = white_generation.clone();
        let supervisor_for_hook = supervisor.clone();
        let key_for_hook = white_key.clone();
        GAME_ENGINE_AFTER_SPAWN_HOOKS.arm(
            white_key.clone(),
            Box::new(move || {
                if let Some(engine) = supervisor_for_hook.get_exact(&key_for_hook) {
                    generation_for_hook.store(engine.generation, Ordering::SeqCst);
                }
            }),
        );
        assert!(game_cleanup_messages(game_id, 1, "construction abandoned").is_empty());
        let app = tauri::test::mock_app();

        let actual = manager
            .start_game(
                game_id.into(),
                bundle.config.clone(),
                app.handle().clone(),
                bundle.authority.clone(),
                supervisor.clone(),
            )
            .await
            .unwrap_err();

        assert_eq!(actual.category(), expected.category());
        assert_eq!(actual.to_string(), expected.to_string());
        let generation = white_generation.load(Ordering::SeqCst);
        assert_ne!(generation, 0);
        assert!(supervisor.get_exact(&white_key).is_none());
        assert!(game_cleanup_messages(game_id, 1, "construction abandoned").is_empty());
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn start_game_validates_both_engine_keys_before_spawning_white() {
        let game_id = "start_game_validates_both_engine_keys_before_spawning_white";
        let bundle = test_game_engine_bundle(game_id, TestEngineScript::Responsive, true);
        let mut config = bundle.config.clone();
        let PlayerConfig::Engine { engine_id, .. } = &mut config.black else {
            panic!("test engine bundle must have an engine as black");
        };
        engine_id.push('\u{1f}');
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let unrelated = register_unrelated_test_engine(&supervisor, game_id).await;
        let white_key = game_side_engine_key(game_id, 1, "white", &bundle.white_engine_id).unwrap();
        let spawned = Arc::new(AtomicBool::new(false));
        let spawned_by_hook = spawned.clone();
        GAME_ENGINE_AFTER_SPAWN_HOOKS.arm(
            white_key.clone(),
            Box::new(move || spawned_by_hook.store(true, Ordering::SeqCst)),
        );
        let app = tauri::test::mock_app();

        let error = manager
            .start_game(
                game_id.into(),
                config,
                app.handle().clone(),
                bundle.authority.clone(),
                supervisor.clone(),
            )
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            Error::InvalidInput(message) if message == "engine contains a UCI control character"
        ));
        assert!(!spawned.load(Ordering::SeqCst));
        assert!(supervisor.get_exact(&white_key).is_none());
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn start_game_abandons_new_engines_when_predecessor_retirement_fails() {
        let game_id = "start_game_abandons_new_engines_when_predecessor_retirement_fails";
        let bundle = test_game_engine_bundle(game_id, TestEngineScript::Responsive, true);
        let manager = Arc::new(GameManager::new());
        manager.next_session.store(1, Ordering::Relaxed);
        let supervisor = Arc::new(EngineSupervisor::default());
        let unrelated = register_unrelated_test_engine(&supervisor, game_id).await;
        let old_error = format!("{game_id}-old-engine-termination-failure");
        let old_engine = register_test_game_engine_with_actor(
            &supervisor,
            game_id,
            1,
            "white",
            "predecessor-failing-engine",
            "predecessor-failing-handle",
            EngineActor::failing_terminate_test_actor(old_error.clone()),
        )
        .await;
        let old_key = old_engine.key.clone();
        let old_generation = old_engine.generation;
        assert!(registration_cleanup_messages(&old_key, old_generation).is_empty());
        assert!(game_cleanup_messages(game_id, 1, "retirement").is_empty());
        let (old_live, old_controller) =
            test_live_session_with_supervisor(game_id, 1, supervisor.clone());
        set_session_engines(&old_controller, Some(old_engine), None).await;
        let old_shutdown_rx = old_live.shutdown.subscribe();
        let old_join = loop_exits_without_engine_cleanup(old_shutdown_rx);
        match old_live.join.lock() {
            Ok(mut slot) => *slot = Some(old_join),
            Err(poisoned) => *poisoned.into_inner() = Some(old_join),
        }
        publish_test_session(&manager, game_id, old_live).await;
        let (white_key, black_key) = game_side_keys(&bundle, game_id, 2);
        let app = tauri::test::mock_app();
        let task = tokio::spawn({
            let manager = manager.clone();
            let supervisor = supervisor.clone();
            let config = bundle.config.clone();
            let authority = bundle.authority.clone();
            let game_id = game_id.to_owned();
            async move {
                manager
                    .start_game(game_id, config, app.handle().clone(), authority, supervisor)
                    .await
            }
        });
        let white_generation = wait_for_generation(&supervisor, &white_key).await;
        let black_generation = wait_for_generation(&supervisor, &black_key).await;
        let error = task.await.unwrap().unwrap_err();

        assert!(error
            .to_string()
            .contains("failed to terminate game engines"));
        assert!(!error.to_string().contains(&old_error));
        assert!(supervisor.get_exact(&white_key).is_none());
        assert!(supervisor.get_exact(&black_key).is_none());
        wait_for_generation_gone(&supervisor, &white_key, white_generation).await;
        wait_for_generation_gone(&supervisor, &black_key, black_generation).await;
        assert!(supervisor.get_exact(&old_key).is_none());
        assert!(registration_cleanup_messages(&old_key, old_generation)
            .iter()
            .any(|message| message.contains(&old_error)));
        let messages = game_cleanup_messages(game_id, 1, "retirement");
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("failed to terminate game engines"));
        assert!(!messages[0].contains(&old_error));
        assert_session_retired(&manager, game_id, 1).await;
        assert!(!manager.games.contains_key(game_id));
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn start_game_abandons_new_engines_when_publication_is_rejected() {
        let game_id = "start_game_abandons_new_engines_when_publication_is_rejected";
        let bundle = test_game_engine_bundle(game_id, TestEngineScript::Responsive, true);
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let unrelated = register_unrelated_test_engine(&supervisor, game_id).await;
        let (white_key, black_key) = game_side_keys(&bundle, game_id, 1);
        let registration = manager.registration.lock().await;
        let (reached_tx, reached_rx) = tokio::sync::oneshot::channel();
        GAME_PUBLICATION_WAIT_HOOKS.arm(
            game_id.into(),
            Box::new(move || {
                let _ = reached_tx.send(());
            }),
        );
        let app = tauri::test::mock_app();
        let task = tokio::spawn({
            let manager = manager.clone();
            let supervisor = supervisor.clone();
            let config = bundle.config.clone();
            let authority = bundle.authority.clone();
            let game_id = game_id.to_owned();
            async move {
                manager
                    .start_game(game_id, config, app.handle().clone(), authority, supervisor)
                    .await
            }
        });
        let white_generation = wait_for_generation(&supervisor, &white_key).await;
        let black_generation = wait_for_generation(&supervisor, &black_key).await;
        tokio::time::timeout(TEST_WAIT, reached_rx)
            .await
            .expect("publication wait hook did not fire")
            .expect("publication wait signal was dropped");
        manager.sealed.store(true, Ordering::SeqCst);
        drop(registration);
        let error = task.await.unwrap().unwrap_err();

        assert!(matches!(
            error,
            Error::Conflict(message) if message == "application is shutting down"
        ));
        assert!(supervisor.get_exact(&white_key).is_none());
        assert!(supervisor.get_exact(&black_key).is_none());
        wait_for_generation_gone(&supervisor, &white_key, white_generation).await;
        wait_for_generation_gone(&supervisor, &black_key, black_generation).await;
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn replacement_cancellation_before_join_take_retires_predecessor_and_new_engines() {
        let game_id =
            "replacement_cancellation_before_join_take_retires_predecessor_and_new_engines";
        let bundle = test_game_engine_bundle(game_id, TestEngineScript::Responsive, true);
        let manager = Arc::new(GameManager::new());
        manager.next_session.store(1, Ordering::Relaxed);
        let supervisor = Arc::new(EngineSupervisor::default());
        let unrelated = register_unrelated_test_engine(&supervisor, game_id).await;
        let old_white = register_test_game_engine(
            &supervisor,
            game_id,
            1,
            "white",
            "old-white-engine",
            "old-white-handle",
        )
        .await;
        let old_black = register_test_game_engine(
            &supervisor,
            game_id,
            1,
            "black",
            "old-black-engine",
            "old-black-handle",
        )
        .await;
        let old_white_key = old_white.key.clone();
        let old_white_generation = old_white.generation;
        let old_black_key = old_black.key.clone();
        let old_black_generation = old_black.generation;
        let (old_live, old_controller) =
            test_live_session_with_supervisor(game_id, 1, supervisor.clone());
        set_session_engines(
            &old_controller,
            Some(old_white.clone()),
            Some(old_black.clone()),
        )
        .await;
        let old_join = loop_exits_on_shutdown(
            old_live.shutdown.subscribe(),
            supervisor.clone(),
            vec![old_white, old_black],
        );
        match old_live.join.lock() {
            Ok(mut slot) => *slot = Some(old_join),
            Err(poisoned) => *poisoned.into_inner() = Some(old_join),
        }
        publish_test_session(&manager, game_id, old_live.clone()).await;
        let (new_white_key, new_black_key) = game_side_keys(&bundle, game_id, 2);
        let controller_guard = old_controller.write().await;
        let app = tauri::test::mock_app();
        let task = tokio::spawn({
            let manager = manager.clone();
            let supervisor = supervisor.clone();
            let config = bundle.config.clone();
            let authority = bundle.authority.clone();
            let game_id = game_id.to_owned();
            async move {
                manager
                    .start_game(game_id, config, app.handle().clone(), authority, supervisor)
                    .await
            }
        });
        let new_white_generation = wait_for_generation(&supervisor, &new_white_key).await;
        let new_black_generation = wait_for_generation(&supervisor, &new_black_key).await;
        assert!(guard_drop_records(&new_white_key, new_white_generation).is_empty());
        assert!(guard_drop_records(&new_black_key, new_black_generation).is_empty());
        wait_until(|| manager.games.get(game_id).is_none()).await;
        assert!(manager.games.is_empty());

        task.abort();
        let _ = task.await;
        drop(controller_guard);
        wait_for_generation_gone(&supervisor, &new_white_key, new_white_generation).await;
        wait_for_generation_gone(&supervisor, &new_black_key, new_black_generation).await;
        wait_for_generation_gone(&supervisor, &old_white_key, old_white_generation).await;
        wait_for_generation_gone(&supervisor, &old_black_key, old_black_generation).await;
        wait_until(|| {
            old_live
                .join
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_none()
        })
        .await;
        assert!(*old_live.shutdown.borrow());
        assert_dropped_generation(&new_white_key, new_white_generation);
        assert_dropped_generation(&new_black_key, new_black_generation);
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn replacement_join_wait_cancellation_restores_handle_for_remainder() {
        let game_id = "replacement_join_wait_cancellation_restores_handle_for_remainder";
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let unrelated = register_unrelated_test_engine(&supervisor, game_id).await;
        let white = register_test_game_engine(
            &supervisor,
            game_id,
            1,
            "white",
            "join-wait-white",
            "join-wait-white-handle",
        )
        .await;
        let black = register_test_game_engine(
            &supervisor,
            game_id,
            1,
            "black",
            "join-wait-black",
            "join-wait-black-handle",
        )
        .await;
        let white_key = white.key.clone();
        let white_generation = white.generation;
        let black_key = black.key.clone();
        let black_generation = black.generation;
        assert!(registration_cleanup_messages(&white_key, white_generation).is_empty());
        assert!(registration_cleanup_messages(&black_key, black_generation).is_empty());
        let (live, controller) = test_live_session_with_supervisor(game_id, 1, supervisor.clone());
        set_session_engines(&controller, Some(white), Some(black)).await;
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let join = tokio::spawn(async move {
            let _ = release_rx.await;
        });
        match live.join.lock() {
            Ok(mut slot) => *slot = Some(join),
            Err(poisoned) => *poisoned.into_inner() = Some(join),
        }
        publish_test_session(&manager, game_id, live.clone()).await;
        let key = (game_id.to_owned(), 1);
        let (first_tx, first_rx) = tokio::sync::oneshot::channel();
        SHUTDOWN_JOIN_TAKEN_HOOKS.arm(
            key.clone(),
            Box::new(move || {
                let _ = first_tx.send(());
            }),
        );
        let retirement = tokio::spawn({
            let manager = manager.clone();
            let live = live.clone();
            let game_id = game_id.to_owned();
            async move {
                manager
                    .retire_replaced_session(&game_id, live, Duration::from_secs(60))
                    .await
            }
        });
        tokio::time::timeout(TEST_WAIT, first_rx)
            .await
            .expect("first join-taken hook did not fire")
            .expect("first join-taken signal was dropped");
        let (second_tx, second_rx) = tokio::sync::oneshot::channel();
        SHUTDOWN_JOIN_TAKEN_HOOKS.arm(
            key,
            Box::new(move || {
                let _ = second_tx.send(());
            }),
        );

        retirement.abort();
        let _ = retirement.await;
        tokio::time::timeout(TEST_WAIT, second_rx)
            .await
            .expect("remainder did not take the restored join handle")
            .expect("remainder join-taken signal was dropped");
        assert!(supervisor
            .get_exact(&white_key)
            .is_some_and(|engine| engine.generation == white_generation));
        assert!(supervisor
            .get_exact(&black_key)
            .is_some_and(|engine| engine.generation == black_generation));

        let _ = release_tx.send(());
        wait_for_generation_gone(&supervisor, &white_key, white_generation).await;
        wait_for_generation_gone(&supervisor, &black_key, black_generation).await;
        assert!(live
            .join
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_none());
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn replacement_timeout_fallback_cancellation_reaps_engines_and_logs_join_failure() {
        let game_id =
            "replacement_timeout_fallback_cancellation_reaps_engines_and_logs_join_failure";
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let unrelated = register_unrelated_test_engine(&supervisor, game_id).await;
        let (white_actor, white_started) =
            EngineActor::delayed_terminate_test_actor(Duration::from_millis(150));
        let (black_actor, black_started) =
            EngineActor::delayed_terminate_test_actor(Duration::from_millis(150));
        let white = register_test_game_engine_with_actor(
            &supervisor,
            game_id,
            1,
            "white",
            "timeout-white",
            "timeout-white-handle",
            white_actor,
        )
        .await;
        let black = register_test_game_engine_with_actor(
            &supervisor,
            game_id,
            1,
            "black",
            "timeout-black",
            "timeout-black-handle",
            black_actor,
        )
        .await;
        let white_key = white.key.clone();
        let white_generation = white.generation;
        let black_key = black.key.clone();
        let black_generation = black.generation;
        assert!(game_cleanup_messages(game_id, 1, "loop join failed").is_empty());
        assert!(game_cleanup_messages(game_id, 1, "retirement").is_empty());
        let (live, controller) = test_live_session_with_supervisor(game_id, 1, supervisor.clone());
        set_session_engines(&controller, Some(white), Some(black)).await;
        let join = tokio::spawn(std::future::pending::<()>());
        match live.join.lock() {
            Ok(mut slot) => *slot = Some(join),
            Err(poisoned) => *poisoned.into_inner() = Some(join),
        }
        publish_test_session(&manager, game_id, live.clone()).await;
        let retirement = tokio::spawn({
            let manager = manager.clone();
            let live = live.clone();
            let game_id = game_id.to_owned();
            async move {
                manager
                    .retire_replaced_session(&game_id, live, Duration::from_millis(40))
                    .await
            }
        });
        wait_until(|| {
            live.join
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_none()
                && white_started.load(Ordering::SeqCst)
                && black_started.load(Ordering::SeqCst)
        })
        .await;
        let join_messages = game_cleanup_messages(game_id, 1, "loop join failed");
        assert_eq!(join_messages.len(), 1);
        assert!(join_messages[0].contains("did not exit within"));

        retirement.abort();
        let _ = retirement.await;
        wait_for_generation_gone(&supervisor, &white_key, white_generation).await;
        wait_for_generation_gone(&supervisor, &black_key, black_generation).await;
        assert!(live
            .join
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_none());
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn replacement_join_error_returns_and_logs_failure_after_engine_cleanup() {
        let game_id = "replacement_join_error_returns_and_logs_failure_after_engine_cleanup";
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let unrelated = register_unrelated_test_engine(&supervisor, game_id).await;
        let white = register_test_game_engine(
            &supervisor,
            game_id,
            1,
            "white",
            "join-error-white",
            "join-error-white-handle",
        )
        .await;
        let black = register_test_game_engine(
            &supervisor,
            game_id,
            1,
            "black",
            "join-error-black",
            "join-error-black-handle",
        )
        .await;
        let white_key = white.key.clone();
        let white_generation = white.generation;
        let black_key = black.key.clone();
        let black_generation = black.generation;
        assert!(registration_cleanup_messages(&white_key, white_generation).is_empty());
        assert!(registration_cleanup_messages(&black_key, black_generation).is_empty());
        let (live, controller) = test_live_session_with_supervisor(game_id, 1, supervisor.clone());
        set_session_engines(&controller, Some(white), Some(black)).await;
        let join = tokio::spawn(async { panic!("join-error test loop panic") });
        match live.join.lock() {
            Ok(mut slot) => *slot = Some(join),
            Err(poisoned) => *poisoned.into_inner() = Some(join),
        }
        publish_test_session(&manager, game_id, live.clone()).await;
        assert!(game_cleanup_messages(game_id, 1, "loop join failed").is_empty());
        assert!(game_cleanup_messages(game_id, 1, "retirement").is_empty());

        let error = manager
            .retire_replaced_session(game_id, live, Duration::from_secs(2))
            .await
            .unwrap_err();

        assert!(error.to_string().contains("game loop join failed"));
        assert!(supervisor.get_exact(&white_key).is_none());
        assert!(supervisor.get_exact(&black_key).is_none());
        wait_for_generation_gone(&supervisor, &white_key, white_generation).await;
        wait_for_generation_gone(&supervisor, &black_key, black_generation).await;
        let join_messages = game_cleanup_messages(game_id, 1, "loop join failed");
        assert_eq!(join_messages.len(), 1);
        assert!(join_messages[0].contains("game loop join failed"));
        let retirement_messages = game_cleanup_messages(game_id, 1, "retirement");
        assert_eq!(retirement_messages.len(), 1);
        assert!(retirement_messages[0].contains("game loop join failed"));
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn replacement_join_error_folds_and_logs_termination_failures() {
        let game_id = "replacement_join_error_folds_and_logs_termination_failures";
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let unrelated = register_unrelated_test_engine(&supervisor, game_id).await;
        let white_error = format!("{game_id}-white-termination-error");
        let black_error = format!("{game_id}-black-termination-error");
        let white = register_test_game_engine_with_actor(
            &supervisor,
            game_id,
            1,
            "white",
            "join-error-failing-white",
            "join-error-failing-white-handle",
            EngineActor::failing_terminate_test_actor(white_error.clone()),
        )
        .await;
        let black = register_test_game_engine_with_actor(
            &supervisor,
            game_id,
            1,
            "black",
            "join-error-failing-black",
            "join-error-failing-black-handle",
            EngineActor::failing_terminate_test_actor(black_error.clone()),
        )
        .await;
        let white_key = white.key.clone();
        let white_generation = white.generation;
        let black_key = black.key.clone();
        let black_generation = black.generation;
        assert!(registration_cleanup_messages(&white_key, white_generation).is_empty());
        assert!(registration_cleanup_messages(&black_key, black_generation).is_empty());
        let (live, controller) = test_live_session_with_supervisor(game_id, 1, supervisor.clone());
        set_session_engines(&controller, Some(white), Some(black)).await;
        let join = tokio::spawn(async { panic!("join-error combined test loop panic") });
        match live.join.lock() {
            Ok(mut slot) => *slot = Some(join),
            Err(poisoned) => *poisoned.into_inner() = Some(join),
        }
        publish_test_session(&manager, game_id, live.clone()).await;
        assert!(game_cleanup_messages(game_id, 1, "retirement").is_empty());

        let error = manager
            .retire_replaced_session(game_id, live, Duration::from_secs(2))
            .await
            .unwrap_err();

        match error {
            Error::OperationAndCleanup { primary, cleanup } => {
                assert!(primary.contains("game loop join failed"));
                assert!(cleanup.contains("failed to terminate game engines"));
                assert!(!cleanup.contains(&white_error));
                assert!(!cleanup.contains(&black_error));
            }
            other => panic!("expected combined join and termination failure, got {other:?}"),
        }
        assert!(supervisor.get_exact(&white_key).is_none());
        assert!(supervisor.get_exact(&black_key).is_none());
        for (key, generation, cause) in [
            (&white_key, white_generation, white_error.as_str()),
            (&black_key, black_generation, black_error.as_str()),
        ] {
            assert!(registration_cleanup_messages(key, generation)
                .iter()
                .any(|message| message.contains(cause)));
        }
        let retirement_messages = game_cleanup_messages(game_id, 1, "retirement");
        assert_eq!(retirement_messages.len(), 1);
        assert!(retirement_messages[0].contains("game loop join failed"));
        assert!(retirement_messages[0].contains("failed to terminate game engines"));
        assert!(!retirement_messages[0].contains(&white_error));
        assert!(!retirement_messages[0].contains(&black_error));
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn retired_session_with_empty_join_slot_still_terminates_registered_engines() {
        let game_id = "retired_session_with_empty_join_slot_still_terminates_registered_engines";
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let unrelated = register_unrelated_test_engine(&supervisor, game_id).await;
        let white = register_test_game_engine(
            &supervisor,
            game_id,
            1,
            "white",
            "empty-join-white",
            "empty-join-white-handle",
        )
        .await;
        let black = register_test_game_engine(
            &supervisor,
            game_id,
            1,
            "black",
            "empty-join-black",
            "empty-join-black-handle",
        )
        .await;
        let white_key = white.key.clone();
        let white_generation = white.generation;
        let black_key = black.key.clone();
        let black_generation = black.generation;
        let (live, controller) = test_live_session_with_supervisor(game_id, 1, supervisor.clone());
        set_session_engines(&controller, Some(white), Some(black)).await;
        publish_test_session(&manager, game_id, live.clone()).await;
        assert!(live
            .join
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_none());

        manager
            .retire_replaced_session(game_id, live, Duration::from_secs(1))
            .await
            .unwrap();

        wait_for_generation_gone(&supervisor, &white_key, white_generation).await;
        wait_for_generation_gone(&supervisor, &black_key, black_generation).await;
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn retired_session_reports_termination_failure_after_clean_join() {
        let game_id = "retired_session_reports_termination_failure_after_clean_join";
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let white_error = format!("{game_id}-white-termination-error");
        let black_error = format!("{game_id}-black-termination-error");
        let (live, [white, black], unrelated) = published_teardown_fixture(
            &manager,
            &supervisor,
            game_id,
            [
                EngineActor::failing_terminate_test_actor(white_error.clone()),
                EngineActor::failing_terminate_test_actor(black_error.clone()),
            ],
        )
        .await;
        let white_key = white.key.clone();
        let white_generation = white.generation;
        let black_key = black.key.clone();
        let black_generation = black.generation;
        assert!(registration_cleanup_messages(&white_key, white_generation).is_empty());
        assert!(registration_cleanup_messages(&black_key, black_generation).is_empty());
        assert!(game_cleanup_messages(game_id, 1, "retirement").is_empty());

        let error = manager
            .retire_replaced_session(game_id, live, Duration::from_secs(1))
            .await
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("failed to terminate game engines"));
        assert!(!error.to_string().contains(&white_error));
        assert!(!error.to_string().contains(&black_error));
        assert!(supervisor.get_exact(&white_key).is_none());
        assert!(supervisor.get_exact(&black_key).is_none());
        for (key, generation, cause) in [
            (&white_key, white_generation, white_error.as_str()),
            (&black_key, black_generation, black_error.as_str()),
        ] {
            assert!(registration_cleanup_messages(key, generation)
                .iter()
                .any(|message| message.contains(cause)));
        }
        let messages = game_cleanup_messages(game_id, 1, "retirement");
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("failed to terminate game engines"));
        assert!(!messages[0].contains(&white_error));
        assert!(!messages[0].contains(&black_error));
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn retired_session_folds_join_timeout_with_termination_failure() {
        let game_id = "retired_session_folds_join_timeout_with_termination_failure";
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let unrelated = register_unrelated_test_engine(&supervisor, game_id).await;
        let white_error = format!("{game_id}-white-termination-error");
        let black_error = format!("{game_id}-black-termination-error");
        let white = register_test_game_engine_with_actor(
            &supervisor,
            game_id,
            1,
            "white",
            "retired-timeout-white",
            "retired-timeout-white-handle",
            EngineActor::failing_terminate_test_actor(white_error.clone()),
        )
        .await;
        let black = register_test_game_engine_with_actor(
            &supervisor,
            game_id,
            1,
            "black",
            "retired-timeout-black",
            "retired-timeout-black-handle",
            EngineActor::failing_terminate_test_actor(black_error.clone()),
        )
        .await;
        let white_key = white.key.clone();
        let white_generation = white.generation;
        let black_key = black.key.clone();
        let black_generation = black.generation;
        assert!(registration_cleanup_messages(&white_key, white_generation).is_empty());
        assert!(registration_cleanup_messages(&black_key, black_generation).is_empty());
        let (live, controller) = test_live_session_with_supervisor(game_id, 1, supervisor.clone());
        set_session_engines(&controller, Some(white), Some(black)).await;
        let join = tokio::spawn(std::future::pending::<()>());
        match live.join.lock() {
            Ok(mut slot) => *slot = Some(join),
            Err(poisoned) => *poisoned.into_inner() = Some(join),
        }
        publish_test_session(&manager, game_id, live.clone()).await;
        assert!(game_cleanup_messages(game_id, 1, "loop join failed").is_empty());
        assert!(game_cleanup_messages(game_id, 1, "retirement").is_empty());

        let error = manager
            .retire_replaced_session(game_id, live, Duration::from_millis(35))
            .await
            .unwrap_err();

        match error {
            Error::OperationAndCleanup { primary, cleanup } => {
                assert!(primary.contains("did not exit within"));
                assert!(cleanup.contains("failed to terminate game engines"));
                assert!(!cleanup.contains(&white_error));
                assert!(!cleanup.contains(&black_error));
            }
            other => panic!("expected folded timeout and cleanup failure, got {other:?}"),
        }
        assert!(supervisor.get_exact(&white_key).is_none());
        assert!(supervisor.get_exact(&black_key).is_none());
        for (key, generation, cause) in [
            (&white_key, white_generation, white_error.as_str()),
            (&black_key, black_generation, black_error.as_str()),
        ] {
            assert!(registration_cleanup_messages(key, generation)
                .iter()
                .any(|message| message.contains(cause)));
        }
        let join_messages = game_cleanup_messages(game_id, 1, "loop join failed");
        assert_eq!(join_messages.len(), 1);
        assert!(join_messages[0].contains("did not exit within"));
        let retirement_messages = game_cleanup_messages(game_id, 1, "retirement");
        assert_eq!(retirement_messages.len(), 1);
        assert!(retirement_messages[0].contains("did not exit within"));
        assert!(retirement_messages[0].contains("failed to terminate game engines"));
        assert!(!retirement_messages[0].contains(&white_error));
        assert!(!retirement_messages[0].contains(&black_error));
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn retired_session_cancellation_remainder_logs_and_reaps_failing_engines() {
        let game_id = "retired_session_cancellation_remainder_logs_and_reaps_failing_engines";
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let white_error = format!("{game_id}-white-termination-error");
        let black_error = format!("{game_id}-black-termination-error");
        let (live, [white, black], unrelated) = published_teardown_fixture(
            &manager,
            &supervisor,
            game_id,
            [
                EngineActor::failing_terminate_test_actor(white_error.clone()),
                EngineActor::failing_terminate_test_actor(black_error.clone()),
            ],
        )
        .await;
        let white_key = white.key.clone();
        let white_generation = white.generation;
        let black_key = black.key.clone();
        let black_generation = black.generation;
        assert!(registration_cleanup_messages(&white_key, white_generation).is_empty());
        assert!(registration_cleanup_messages(&black_key, black_generation).is_empty());
        assert!(game_cleanup_messages(game_id, 1, "retirement").is_empty());
        let controller_guard = live.controller.write().await;
        let retirement = tokio::spawn({
            let manager = manager.clone();
            let live = live.clone();
            let game_id = game_id.to_owned();
            async move {
                manager
                    .retire_replaced_session(&game_id, live, Duration::from_secs(2))
                    .await
            }
        });
        wait_until(|| manager.games.get(game_id).is_none()).await;
        retirement.abort();
        let _ = retirement.await;
        drop(controller_guard);

        wait_for_generation_gone(&supervisor, &white_key, white_generation).await;
        wait_for_generation_gone(&supervisor, &black_key, black_generation).await;
        let messages = game_cleanup_messages(game_id, 1, "retirement");
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("failed to terminate game engines"));
        assert!(!messages[0].contains(&white_error));
        assert!(!messages[0].contains(&black_error));
        for (key, generation, cause) in [
            (&white_key, white_generation, white_error.as_str()),
            (&black_key, black_generation, black_error.as_str()),
        ] {
            assert!(registration_cleanup_messages(key, generation)
                .iter()
                .any(|message| message.contains(cause)));
        }
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn mixed_retirement_failure_is_logged_before_cancellation_and_remainder_finishes() {
        let game_id =
            "mixed_retirement_failure_is_logged_before_cancellation_and_remainder_finishes";
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let error_text = format!("{game_id}-white-termination-error");
        let (black_actor, black_started) =
            EngineActor::delayed_terminate_test_actor(Duration::from_millis(200));
        let (live, [white, black], unrelated) = published_teardown_fixture(
            &manager,
            &supervisor,
            game_id,
            [
                EngineActor::failing_terminate_test_actor(error_text.clone()),
                black_actor,
            ],
        )
        .await;
        let white_key = white.key.clone();
        let white_generation = white.generation;
        let black_key = black.key.clone();
        let black_generation = black.generation;
        assert!(registration_cleanup_messages(&white_key, white_generation).is_empty());
        assert!(game_cleanup_messages(game_id, 1, "retirement").is_empty());
        let retirement = tokio::spawn({
            let manager = manager.clone();
            let live = live.clone();
            let game_id = game_id.to_owned();
            async move {
                manager
                    .retire_replaced_session(&game_id, live, Duration::from_secs(2))
                    .await
            }
        });
        wait_until(|| {
            black_started.load(Ordering::SeqCst)
                && registration_cleanup_messages(&white_key, white_generation)
                    .iter()
                    .any(|message| message.contains(&error_text))
        })
        .await;
        assert!(registration_cleanup_messages(&white_key, white_generation)
            .iter()
            .any(|message| message.contains(&error_text)));

        retirement.abort();
        let _ = retirement.await;
        wait_for_generation_gone(&supervisor, &white_key, white_generation).await;
        wait_for_generation_gone(&supervisor, &black_key, black_generation).await;
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn replacement_join_error_fallback_cancellation_logs_when_failure_forms() {
        let game_id = "replacement_join_error_fallback_cancellation_logs_when_failure_forms";
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let unrelated = register_unrelated_test_engine(&supervisor, game_id).await;
        let (white_actor, white_started) =
            EngineActor::delayed_terminate_test_actor(Duration::from_millis(150));
        let (black_actor, black_started) =
            EngineActor::delayed_terminate_test_actor(Duration::from_millis(150));
        let white = register_test_game_engine_with_actor(
            &supervisor,
            game_id,
            1,
            "white",
            "join-panic-white",
            "join-panic-white-handle",
            white_actor,
        )
        .await;
        let black = register_test_game_engine_with_actor(
            &supervisor,
            game_id,
            1,
            "black",
            "join-panic-black",
            "join-panic-black-handle",
            black_actor,
        )
        .await;
        let white_key = white.key.clone();
        let white_generation = white.generation;
        let black_key = black.key.clone();
        let black_generation = black.generation;
        assert!(game_cleanup_messages(game_id, 1, "loop join failed").is_empty());
        assert!(game_cleanup_messages(game_id, 1, "retirement").is_empty());
        let (live, controller) = test_live_session_with_supervisor(game_id, 1, supervisor.clone());
        set_session_engines(&controller, Some(white), Some(black)).await;
        let join = tokio::spawn(async { panic!("join-panic test loop panic") });
        match live.join.lock() {
            Ok(mut slot) => *slot = Some(join),
            Err(poisoned) => *poisoned.into_inner() = Some(join),
        }
        publish_test_session(&manager, game_id, live.clone()).await;
        let retirement = tokio::spawn({
            let manager = manager.clone();
            let live = live.clone();
            let game_id = game_id.to_owned();
            async move {
                manager
                    .retire_replaced_session(&game_id, live, Duration::from_secs(60))
                    .await
            }
        });
        wait_until(|| {
            live.join
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_none()
                && white_started.load(Ordering::SeqCst)
                && black_started.load(Ordering::SeqCst)
        })
        .await;
        let join_messages = game_cleanup_messages(game_id, 1, "loop join failed");
        assert_eq!(join_messages.len(), 1);
        assert!(join_messages[0].contains("game loop join failed"));

        retirement.abort();
        let _ = retirement.await;
        wait_for_generation_gone(&supervisor, &white_key, white_generation).await;
        wait_for_generation_gone(&supervisor, &black_key, black_generation).await;
        assert!(live
            .join
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_none());
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn game_engine_construction_cancellation_reaps_both_spawn_boundaries() {
        let game_id = "game_engine_construction_cancellation_reaps_both_spawn_boundaries";
        let bundle = test_game_engine_bundle(game_id, TestEngineScript::Pending, true);
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let unrelated = register_unrelated_test_engine(&supervisor, game_id).await;
        let (white_key, black_key) = game_side_keys(&bundle, game_id, 1);
        assert!(guard_drop_records_for_key(&white_key).is_empty());
        assert!(guard_drop_records_for_key(&black_key).is_empty());

        let app = tauri::test::mock_app();
        let task = tokio::spawn({
            let manager = manager.clone();
            let supervisor = supervisor.clone();
            let bundle_config = bundle.config.clone();
            let authority = bundle.authority.clone();
            let game_id = game_id.to_owned();
            async move {
                manager
                    .start_game(
                        game_id,
                        bundle_config,
                        app.handle().clone(),
                        authority,
                        supervisor,
                    )
                    .await
            }
        });

        let white_generation = wait_for_generation(&supervisor, &white_key).await;
        let black_generation = wait_for_generation(&supervisor, &black_key).await;
        assert!(guard_drop_records(&white_key, white_generation).is_empty());
        assert!(guard_drop_records(&black_key, black_generation).is_empty());

        task.abort();
        let _ = task.await;
        wait_for_generation_gone(&supervisor, &white_key, white_generation).await;
        wait_for_generation_gone(&supervisor, &black_key, black_generation).await;
        wait_for_guard_drop_completion(&white_key, white_generation).await;
        wait_for_guard_drop_completion(&black_key, black_generation).await;
        assert_dropped_generation(&white_key, white_generation);
        assert_dropped_generation(&black_key, black_generation);
        assert!(manager.games.is_empty());
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn game_engine_construction_cancellation_at_publication_reaps_both_engines() {
        let game_id = "game_engine_construction_cancellation_at_publication_reaps_both_engines";
        let bundle = test_game_engine_bundle(game_id, TestEngineScript::Responsive, true);
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let unrelated = register_unrelated_test_engine(&supervisor, game_id).await;
        let (white_key, black_key) = game_side_keys(&bundle, game_id, 1);
        let registration = manager.registration.lock().await;
        let (reached_tx, reached_rx) = tokio::sync::oneshot::channel();
        GAME_PUBLICATION_WAIT_HOOKS.arm(
            game_id.into(),
            Box::new(move || {
                let _ = reached_tx.send(());
            }),
        );

        let app = tauri::test::mock_app();
        let task = tokio::spawn({
            let manager = manager.clone();
            let supervisor = supervisor.clone();
            let config = bundle.config.clone();
            let authority = bundle.authority.clone();
            let game_id = game_id.to_owned();
            async move {
                manager
                    .start_game(game_id, config, app.handle().clone(), authority, supervisor)
                    .await
            }
        });

        let white_generation = wait_for_generation(&supervisor, &white_key).await;
        let black_generation = wait_for_generation(&supervisor, &black_key).await;
        tokio::time::timeout(TEST_WAIT, reached_rx)
            .await
            .expect("publication wait hook did not fire")
            .expect("publication wait signal was dropped");
        assert!(guard_drop_records(&white_key, white_generation).is_empty());
        assert!(guard_drop_records(&black_key, black_generation).is_empty());

        task.abort();
        let _ = task.await;
        drop(registration);
        wait_for_generation_gone(&supervisor, &white_key, white_generation).await;
        wait_for_generation_gone(&supervisor, &black_key, black_generation).await;
        wait_for_guard_drop_completion(&white_key, white_generation).await;
        wait_for_guard_drop_completion(&black_key, black_generation).await;
        assert_dropped_generation(&white_key, white_generation);
        assert_dropped_generation(&black_key, black_generation);
        assert!(manager.games.is_empty());
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn successful_game_start_transfers_engine_ownership_to_live_session() {
        let game_id = "successful_game_start_transfers_engine_ownership_to_live_session";
        let bundle = test_game_engine_bundle(game_id, TestEngineScript::Responsive, true);
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let unrelated = register_unrelated_test_engine(&supervisor, game_id).await;
        let (white_key, black_key) = game_side_keys(&bundle, game_id, 1);
        assert!(guard_drop_records_for_key(&white_key).is_empty());
        assert!(guard_drop_records_for_key(&black_key).is_empty());
        let app = tauri::test::mock_app();

        let state = manager
            .start_game(
                game_id.into(),
                bundle.config.clone(),
                app.handle().clone(),
                bundle.authority.clone(),
                supervisor.clone(),
            )
            .await
            .unwrap();

        assert_eq!(state.session, 1);
        let white_generation = wait_for_generation(&supervisor, &white_key).await;
        let black_generation = wait_for_generation(&supervisor, &black_key).await;
        assert!(manager
            .games
            .get(game_id)
            .is_some_and(|live| live.session == state.session));
        assert!(guard_drop_records(&white_key, white_generation).is_empty());
        assert!(guard_drop_records(&black_key, black_generation).is_empty());
        assert!(supervisor
            .get_exact(&white_key)
            .is_some_and(|engine| engine.generation == white_generation));
        assert!(supervisor
            .get_exact(&black_key)
            .is_some_and(|engine| engine.generation == black_generation));

        manager.abort_game(game_id, state.session).await.unwrap();
        wait_for_generation_gone(&supervisor, &white_key, white_generation).await;
        wait_for_generation_gone(&supervisor, &black_key, black_generation).await;
        assert_session_retired(&manager, game_id, state.session).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_after_publication_retires_the_never_started_session() {
        let game_id = "cancellation_after_publication_retires_the_never_started_session";
        let bundle = test_game_engine_bundle(game_id, TestEngineScript::Responsive, true);
        let manager = Arc::new(GameManager::new());
        let supervisor = Arc::new(EngineSupervisor::default());
        let unrelated = register_unrelated_test_engine(&supervisor, game_id).await;
        let (white_key, black_key) = game_side_keys(&bundle, game_id, 1);
        let held_controller = Arc::new(std::sync::Mutex::new(None));
        let held_for_hook = held_controller.clone();
        GAME_START_AFTER_HANDOFF_HOOKS.arm(
            game_id.into(),
            Box::new(move |controller| {
                let guard = controller
                    .try_write_owned()
                    .expect("no controller writer exists before the start handoff continues");
                *held_for_hook
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(guard);
            }),
        );
        let loop_key = (game_id.into(), 1);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        RUN_PUBLISHED_LOOP_READY_HOOKS.arm(
            loop_key.clone(),
            Box::new(move || {
                let _ = ready_tx.send(());
            }),
        );
        let (resolution_tx, mut resolution_rx) = tokio::sync::mpsc::unbounded_channel();
        RUN_PUBLISHED_LOOP_RESOLUTIONS.arm(
            loop_key,
            Box::new(move |started| {
                let _ = resolution_tx.send(started);
            }),
        );

        let app = tauri::test::mock_app();
        let task = tokio::spawn({
            let manager = manager.clone();
            let supervisor = supervisor.clone();
            let config = bundle.config.clone();
            let authority = bundle.authority.clone();
            let game_id = game_id.to_owned();
            async move {
                manager
                    .start_game(game_id, config, app.handle().clone(), authority, supervisor)
                    .await
            }
        });

        let white_generation = wait_for_generation(&supervisor, &white_key).await;
        let black_generation = wait_for_generation(&supervisor, &black_key).await;
        tokio::time::timeout(TEST_WAIT, ready_rx)
            .await
            .expect("published loop did not reach its start receiver")
            .expect("published loop readiness signal was dropped");
        assert!(matches!(
            resolution_rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        assert!(guard_drop_records(&white_key, white_generation).is_empty());
        assert!(guard_drop_records(&black_key, black_generation).is_empty());
        assert!(manager
            .games
            .get(game_id)
            .is_some_and(|live| live.session == 1));

        task.abort();
        let _ = task.await;
        let held = held_controller
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        drop(held);
        assert_eq!(
            tokio::time::timeout(TEST_WAIT, resolution_rx.recv())
                .await
                .expect("published loop did not resolve after its sender was dropped"),
            Some(false)
        );
        assert!(resolution_rx.try_recv().is_err());
        wait_for_generation_gone(&supervisor, &white_key, white_generation).await;
        wait_for_generation_gone(&supervisor, &black_key, black_generation).await;
        assert!(guard_drop_records(&white_key, white_generation).is_empty());
        assert!(guard_drop_records(&black_key, black_generation).is_empty());
        assert_session_retired(&manager, game_id, 1).await;
        assert_unrelated_engine_survives(&supervisor, &unrelated);
        supervisor
            .terminate_exact(&unrelated.key, unrelated.generation)
            .await
            .unwrap();
    }

    struct RoutingAnchor {
        name: &'static str,
        start_marker: &'static str,
        end_marker: &'static str,
        expected_patterns: &'static [RoutingPattern],
    }

    struct RoutingPattern {
        text: &'static str,
        count: usize,
    }

    const ROUTING_ANCHORS: &[RoutingAnchor] = &[
        RoutingAnchor {
            name: "terminal_helper_common_attempt",
            start_marker: "fn attempt_terminal_event_emission_with<F>(",
            end_marker: "fn attempt_terminal_event_emission<R: Runtime>(",
            expected_patterns: &[RoutingPattern {
                text: "controller.attempt_event_emission(GameEventKind::GameOver, revision, || emitter(&event));",
                count: 1,
            }],
        },
        RoutingAnchor {
            name: "initial_terminal",
            start_marker: "// A FEN (or a validated initial move sequence) may already be",
            end_marker: "let _ = start_loop.send(());",
            expected_patterns: &[
                RoutingPattern {
                    text: "attempt_terminal_event_emission(&mut controller, &app)",
                    count: 1,
                },
                RoutingPattern {
                    text: "live.shutdown.send(true);",
                    count: 1,
                },
            ],
        },
        RoutingAnchor {
            name: "human_move",
            start_marker: "pub async fn make_move<R: Runtime>(",
            end_marker: "pub async fn take_back_move(",
            expected_patterns: &[
                RoutingPattern {
                    text: ".attempt_event_emission(GameEventKind::Move, move_revision, || move_event.emit(app));",
                    count: 1,
                },
                RoutingPattern {
                    text: "attempt_terminal_event_emission(&mut controller, app)",
                    count: 2,
                },
                RoutingPattern {
                    text: "game.shutdown.send(true);",
                    count: 2,
                },
            ],
        },
        RoutingAnchor {
            name: "takeback_move",
            start_marker: "pub async fn take_back_move(",
            end_marker: "pub async fn resign(",
            expected_patterns: &[
                RoutingPattern {
                    text: ".attempt_event_emission(GameEventKind::Move, move_revision, || move_event.emit(app));",
                    count: 1,
                },
                RoutingPattern {
                    text: "attempt_terminal_event_emission(&mut controller, app)",
                    count: 1,
                },
                RoutingPattern {
                    text: "game.shutdown.send(true);",
                    count: 1,
                },
            ],
        },
        RoutingAnchor {
            name: "resignation",
            start_marker: "pub async fn resign(",
            end_marker: "pub async fn shutdown_all(",
            expected_patterns: &[
                RoutingPattern {
                    text: "attempt_terminal_event_emission(&mut controller, app);",
                    count: 1,
                },
                RoutingPattern {
                    text: "game.shutdown.send(true);",
                    count: 1,
                },
            ],
        },
        RoutingAnchor {
            name: "start_game_construction_handoff",
            start_marker: "pub async fn start_game<R: Runtime>(\n        self: &Arc<Self>,",
            end_marker: "async fn current_session(",
            expected_patterns: &[
                RoutingPattern {
                    text: "run_published_loop(",
                    count: 1,
                },
                RoutingPattern {
                    text: ".transfer_to_live_session()",
                    count: 1,
                },
                RoutingPattern {
                    text: "return Err(construction.abandon(primary).await);",
                    count: 4,
                },
            ],
        },
        RoutingAnchor {
            name: "shutdown_and_join_logs_failures_when_formed",
            start_marker: "async fn shutdown_and_join(",
            end_marker: "join.abort();",
            expected_patterns: &[RoutingPattern {
                text: "log_game_cleanup_error(",
                count: 2,
            }],
        },
        RoutingAnchor {
            name: "engine_error_terminal",
            start_marker: "Some(Ok(Err(e))) => {",
            end_marker: "Some(Err(join_error)) => {",
            expected_patterns: &[RoutingPattern {
                text: "attempt_terminal_event_emission(&mut ctrl, &app);",
                count: 1,
            }],
        },
        RoutingAnchor {
            name: "game_loop_shutdown_task_cleanup",
            start_marker: "_ = shutdown_rx.changed() => {",
            end_marker: "result = async {",
            expected_patterns: &[
                RoutingPattern {
                    text: "task.abort();",
                    count: 1,
                },
                RoutingPattern {
                    text: "let _ = task.await;",
                    count: 1,
                },
            ],
        },
        RoutingAnchor {
            name: "engine_join_error_terminal",
            start_marker: "Some(Err(join_error)) => {",
            end_marker: "error!(\"game loop observed an impossible empty engine-task completion\");",
            expected_patterns: &[RoutingPattern {
                text: "attempt_terminal_event_emission(&mut ctrl, &app);",
                count: 1,
            }],
        },
        RoutingAnchor {
            name: "clock_timeout_terminal",
            start_marker: "if let Some(result) = ctrl.settle_active_clock() {",
            end_marker: "let (white_time, black_time) = ctrl.get_current_times();",
            expected_patterns: &[RoutingPattern {
                text: "attempt_terminal_event_emission(&mut ctrl, &app);",
                count: 1,
            }],
        },
        RoutingAnchor {
            name: "clock_tick_emission",
            start_marker: "let (white_time, black_time) = ctrl.get_current_times();
                    ctrl.bump_revision();",
            end_marker: "is_finished = ctrl.status != GameStatus::Playing;",
            expected_patterns: &[RoutingPattern {
                text: "ctrl.attempt_event_emission(GameEventKind::Clock, clock_revision, || {",
                count: 1,
            }],
        },
        RoutingAnchor {
            name: "game_loop_completion_and_cleanup",
            start_marker: "        }
    }

    if let Some(task) = engine_task.take() {",
            end_marker: "fn try_polyglot_book_move(",
            expected_patterns: &[
                RoutingPattern {
                    text: "task.abort();",
                    count: 1,
                },
                RoutingPattern {
                    text: "let _ = task.await;",
                    count: 1,
                },
                RoutingPattern {
                    text: "terminate_game_engines(&live.engine_supervisor, engines).await",
                    count: 1,
                },
                RoutingPattern {
                    text: "complete_exact(&game_id, live.session, &controller)",
                    count: 1,
                },
            ],
        },
        RoutingAnchor {
            name: "book_move",
            start_marker: "if let Some(book_uci) = book_move {",
            end_marker: "let (engine_arc, go_mode, initial_fen, moves, turn) = {",
            expected_patterns: &[
                RoutingPattern {
                    text: "ctrl.attempt_event_emission(GameEventKind::Move, move_revision, || {",
                    count: 1,
                },
                RoutingPattern {
                    text: "attempt_terminal_event_emission(&mut ctrl, app);",
                    count: 2,
                },
            ],
        },
        RoutingAnchor {
            name: "engine_move",
            start_marker: "let game_move = match ctrl.apply_move(&best_move) {",
            end_marker: "pub async fn start_game(",
            expected_patterns: &[
                RoutingPattern {
                    text: "ctrl.attempt_event_emission(GameEventKind::Move, move_revision, || move_event.emit(app));",
                    count: 1,
                },
                RoutingPattern {
                    text: "attempt_terminal_event_emission(&mut ctrl, app);",
                    count: 2,
                },
            ],
        },
    ];

    fn normalize_routing_source(source: &str) -> String {
        source.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    fn routing_anchor_body<'a>(prod_source: &'a str, anchor: &RoutingAnchor) -> &'a str {
        let start_marker = normalize_routing_source(anchor.start_marker);
        let end_marker = normalize_routing_source(anchor.end_marker);
        let start_pos = prod_source.find(&start_marker).unwrap_or_else(|| {
            panic!(
                "anchor '{}' start marker not found: '{}'",
                anchor.name, anchor.start_marker
            )
        });
        let after_start_pos = start_pos + start_marker.len();
        let end_offset = prod_source[after_start_pos..]
            .find(&end_marker)
            .unwrap_or_else(|| {
                panic!(
                    "anchor '{}' end marker not found after its start: '{}'",
                    anchor.name, anchor.end_marker
                )
            });
        &prod_source[after_start_pos..after_start_pos + end_offset]
    }

    fn verify_production_routing(normalized_prod_source: &str) {
        assert!(
            !normalized_prod_source.contains(".emit(app).unwrap_or(())"),
            "production publishers must not use bare discarded unwrap_or(()) emits"
        );
        assert!(
            !normalized_prod_source.contains("emit_terminal_event"),
            "emit_terminal_event must be fully replaced by attempt_terminal_event_emission"
        );

        for anchor in ROUTING_ANCHORS {
            let body = routing_anchor_body(normalized_prod_source, anchor);

            for pattern in anchor.expected_patterns {
                let normalized_pattern = normalize_routing_source(pattern.text);
                assert_eq!(
                    body.matches(&normalized_pattern).count(),
                    pattern.count,
                    "anchor '{}' expected exactly {} occurrence(s) of pattern '{}' within boundaries",
                    anchor.name,
                    pattern.count,
                    pattern.text
                );
            }
        }
    }

    #[test]
    fn every_production_game_publisher_routes_through_emission_helper() {
        let source = include_str!("game.rs");
        let (prod_source, _) = source
            .split_once("mod tests {")
            .expect("production code must be separated by mod tests");
        let normalized_prod_source = normalize_routing_source(prod_source);

        verify_production_routing(&normalized_prod_source);
    }

    #[test]
    fn routing_anchors_fail_closed_when_production_wiring_is_removed() {
        let source = include_str!("game.rs");
        let (prod_source, _) = source
            .split_once("mod tests {")
            .expect("production code must be separated by mod tests");
        let normalized_prod_source = normalize_routing_source(prod_source);

        verify_production_routing(&normalized_prod_source);

        let mut checked_occurrences = 0;
        for anchor in ROUTING_ANCHORS {
            let body = routing_anchor_body(&normalized_prod_source, anchor);
            let body_start = body.as_ptr() as usize - normalized_prod_source.as_ptr() as usize;
            for pattern in anchor.expected_patterns {
                let normalized_pattern = normalize_routing_source(pattern.text);
                let positions = body
                    .match_indices(&normalized_pattern)
                    .map(|(position, _)| body_start + position)
                    .collect::<Vec<_>>();
                assert_eq!(positions.len(), pattern.count);

                for position in positions {
                    let mut altered_source = normalized_prod_source.clone();
                    altered_source.replace_range(
                        position..position + normalized_pattern.len(),
                        "/* removed for negative control */",
                    );

                    let result = std::panic::catch_unwind(|| {
                        verify_production_routing(&altered_source);
                    });
                    assert!(
                        result.is_err(),
                        "removing one occurrence of pattern '{}' from anchor '{}' must fail routing verification",
                        pattern.text,
                        anchor.name
                    );
                    checked_occurrences += 1;
                }
            }
        }
        assert_eq!(
            checked_occurrences, 37,
            "all 37 production routing and cleanup occurrences must be tested individually"
        );
    }
}
