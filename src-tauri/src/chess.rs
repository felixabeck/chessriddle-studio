use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use derivative::Derivative;
use governor::{Quota, RateLimiter};
use log::{info, warn};
use nonzero_ext::*;
use serde::{Deserialize, Serialize};
use shakmaty::{
    fen::Fen, san::SanPlus, uci::UciMove, ByColor, Chess, Color, EnPassantMode, Position, Role,
};
use specta::Type;
use tauri_specta::Event;
use vampirc_uci::{
    parse_one,
    uci::{Score, ScoreValue},
    UciInfoAttribute, UciMessage, UciOptionConfig,
};

use crate::{
    db::{DatabaseRepository, GameQuery, PositionQueryJs},
    engine::{
        resolve_launch, resolve_option_leases, spawn_registered, verify_option_resources,
        AdmissionLease, EngineActor, EngineDeadlines, EngineKey, EngineLog, EngineOption,
        EngineRequestId, GoMode, RegistrationGuard, ResolvedEngineOption, SupervisedEngine,
    },
    error::{cancelled_search_error, Error},
    infra::{
        blocking::BLOCKING_GATEWAY,
        path_authority::{DatabaseHandle, EngineExecutable, EngineHandle, PathOperation},
    },
    progress::{begin_progress, update_progress_with_state, ProgressState},
    AppState, SearchCache,
};
use tokio::sync::OwnedSemaphorePermit;
use tokio_util::sync::CancellationToken;

#[cfg(all(test, target_os = "linux"))]
use crate::engine::resolve_engine_option_leases;

#[derive(Clone)]
pub struct EngineProcess {
    base: Arc<EngineActor>,
    last_depth: u32,
    best_moves: Vec<BestMoves>,
    last_best_moves: Vec<BestMoves>,
    last_progress: f32,
    options: EngineOptions,
    /// Keeps option resource leases alive for the engine process lifetime.
    resource_leases: Vec<Arc<crate::infra::path_authority::EngineResourceLease>>,
    go_mode: GoMode,
    running: bool,
    request_id: Option<EngineRequestId>,
    real_multipv: u16,
    start: Instant,
}

/// The option belief and launch leases are retained only by the supervisor's live actor entry.
pub(crate) struct WarmEngine {
    process: EngineProcess,
    resolved: Vec<ResolvedEngineOption>,
    defaults: HashMap<String, String>,
}

impl WarmEngine {
    pub(crate) async fn new(
        base: Arc<EngineActor>,
        resolved: Vec<ResolvedEngineOption>,
        cancelled: &AtomicBool,
    ) -> Result<Self, Error> {
        ensure_search_not_cancelled(Some(cancelled))?;
        let config = collect_engine_configuration_inner(base.clone(), Some(cancelled)).await?;
        ensure_search_not_cancelled(Some(cancelled))?;
        base.ensure_ready().await?;
        ensure_search_not_cancelled(Some(cancelled))?;
        let defaults = config
            .options
            .into_iter()
            .filter_map(|option| {
                let name = option.get_name().to_string();
                let value = match option {
                    UciOptionConfig::Check { default, .. } => {
                        default.map(|value| value.to_string())
                    }
                    UciOptionConfig::Spin { default, .. } => default.map(|value| value.to_string()),
                    UciOptionConfig::Combo { default, .. }
                    | UciOptionConfig::String { default, .. } => default,
                    UciOptionConfig::Button { .. } => None,
                };
                value
                    .filter(|value| {
                        crate::engine::validate_engine_option(&EngineOption::String {
                            name: name.clone(),
                            value: value.clone(),
                        })
                        .is_ok()
                    })
                    .map(|value| (name, value))
            })
            .collect();
        Ok(Self {
            process: EngineProcess::from_actor(base),
            resolved,
            defaults,
        })
    }

    pub(crate) fn can_reuse(&self, options: &EngineOptions) -> bool {
        let previous = crate::engine::effective_engine_options(&self.process.options.extra_options);
        let next = crate::engine::effective_engine_options(&options.extra_options);
        let resources = |options: Vec<EngineOption>| {
            let mut resources = options
                .into_iter()
                .filter(|option| matches!(option, EngineOption::Resource { .. }))
                .collect::<Vec<_>>();
            resources.sort_by(|left, right| left.name().cmp(right.name()));
            resources
        };
        let previous_resources = resources(previous.clone());
        let next_resources = resources(next.clone());
        previous_resources.len() == next_resources.len()
            && previous_resources
                .iter()
                .zip(next_resources)
                .all(|(previous, next)| previous.has_same_value(&next))
            && previous.iter().all(|option| {
                option.name() == "UCI_Chess960"
                    || next.iter().any(|next| next.name() == option.name())
                    || self.defaults.contains_key(option.name())
            })
    }

    pub(crate) async fn start(
        &mut self,
        options: EngineOptions,
        mode: &GoMode,
        cancelled: &AtomicBool,
    ) -> Result<EngineProcess, Error> {
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancellation);
        }
        let next = crate::engine::effective_engine_options(&options.extra_options);
        for option in &next {
            crate::engine::validate_engine_option(option)?;
        }
        for previous in crate::engine::effective_engine_options(&self.process.options.extra_options)
        {
            ensure_search_not_cancelled(Some(cancelled))?;
            // This flag follows the position, not the advertised default.
            if previous.name() == "UCI_Chess960" {
                continue;
            }
            if !next.iter().any(|option| option.name() == previous.name()) {
                let default = self
                    .defaults
                    .get(previous.name())
                    .ok_or_else(|| Error::Conflict("engine option default unavailable".into()))?;
                self.process
                    .base
                    .set_option(previous.name(), default)
                    .await?;
                self.process
                    .options
                    .extra_options
                    .retain(|option| option.name() != previous.name());
            }
        }
        let resolved = next
            .iter()
            .map(|option| match option {
                EngineOption::String { name, value } => Ok(ResolvedEngineOption {
                    name: name.clone(),
                    value: value.clone(),
                    resources: Vec::new(),
                    resource_values: Vec::new(),
                }),
                EngineOption::Resource { name, .. } => self
                    .resolved
                    .iter()
                    .find(|resolved| resolved.name == *name)
                    .cloned()
                    .ok_or_else(|| {
                        Error::Conflict("engine resource option lease unavailable".into())
                    }),
            })
            .collect::<Result<Vec<_>, Error>>()?;
        self.process
            .set_options_inner(options, resolved, None, Some(cancelled))
            .await?;
        self.process.last_progress = 0.0;
        #[cfg(all(test, unix))]
        run_interactive_before_go_hook().await;
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancellation);
        }
        self.process.go(mode).await?;
        Ok(self.process.clone())
    }
}

impl EngineProcess {
    async fn new(
        supervisor: Arc<crate::engine::EngineSupervisor>,
        key: EngineKey,
        executable: EngineExecutable,
        admission: AdmissionLease,
    ) -> Result<(Self, crate::engine::SupervisedEngine, RegistrationGuard), Error> {
        let (supervised, guard, ()) =
            spawn_registered(supervisor, key, executable, admission, |actor| async move {
                actor.init_uci().await
            })
            .await?;
        Ok((
            Self::from_actor(supervised.actor.clone()),
            supervised,
            guard,
        ))
    }

    fn from_actor(base: Arc<EngineActor>) -> Self {
        Self {
            base,
            last_depth: 0,
            best_moves: Vec::new(),
            last_best_moves: Vec::new(),
            last_progress: 0.0,
            options: EngineOptions::default(),
            resource_leases: Vec::new(),
            real_multipv: 0,
            go_mode: GoMode::Infinite,
            running: false,
            request_id: None,
            start: Instant::now(),
        }
    }

    async fn set_options(
        &mut self,
        options: EngineOptions,
        resolved: Vec<ResolvedEngineOption>,
        operation_cancellation: Option<CancellationToken>,
    ) -> Result<(), Error> {
        self.set_options_inner(options, resolved, operation_cancellation, None)
            .await
    }

    async fn set_options_inner(
        &mut self,
        options: EngineOptions,
        resolved: Vec<ResolvedEngineOption>,
        operation_cancellation: Option<CancellationToken>,
        search_cancelled: Option<&AtomicBool>,
    ) -> Result<(), Error> {
        ensure_search_not_cancelled(search_cancelled)?;
        let canonical = crate::engine::canonicalize_engine_position(&options.fen, &options.moves)?;
        let effective_options = crate::engine::effective_engine_options(&options.extra_options);
        if resolved.len() != effective_options.len() {
            return Err(Error::Conflict(
                "resolved engine options do not match requested options".into(),
            ));
        }
        verify_option_resources(&self.base, &resolved, operation_cancellation.as_ref()).await?;
        #[cfg(all(test, unix))]
        run_after_resource_verification_hook().await;
        if search_cancelled.is_some_and(|cancelled| cancelled.load(Ordering::SeqCst)) {
            return Err(Error::Cancellation);
        }
        let fen_changed = options.fen != self.options.fen;
        let castling_mode = canonical.castling_mode;
        let pos = canonical.position;

        let chess960_option = EngineOption::String {
            name: "UCI_Chess960".into(),
            value: castling_mode.is_chess960().to_string(),
        };
        let chess960_changed = self
            .options
            .extra_options
            .iter()
            .rev()
            .find(|option| option.name() == "UCI_Chess960")
            .is_some_and(|previous| !previous.has_same_value(&chess960_option));
        if fen_changed || chess960_changed {
            self.base
                .set_option_with_operation(
                    "UCI_Chess960",
                    &castling_mode.is_chess960().to_string(),
                    &[],
                    operation_cancellation.clone(),
                )
                .await?;
            self.record_written_option(chess960_option);
        }

        let to_send = resolved;
        let next_resource_leases = to_send
            .iter()
            .flat_map(|option| option.resources.iter().cloned())
            .collect();

        let multipv = to_send
            .iter()
            .find(|option| option.name == "MultiPV")
            .map(|option| {
                option
                    .value
                    .parse::<u16>()
                    .map_err(|_| Error::InvalidInput("MultiPV must be a positive integer".into()))
            })
            .transpose()?
            .unwrap_or(1);
        if multipv == 0 {
            return Err(Error::InvalidInput("MultiPV must be at least one".into()));
        }

        self.real_multipv = multipv.min(pos.legal_moves().len() as u16);

        for option in &to_send {
            ensure_search_not_cancelled(search_cancelled)?;
            let current = effective_options
                .iter()
                .find(|configured| configured.name() == option.name);
            let previous = self
                .options
                .extra_options
                .iter()
                .rev()
                .find(|configured| configured.name() == option.name);
            if !current
                .zip(previous)
                .is_some_and(|(current, previous)| current.has_same_value(previous))
                && option.name != "UCI_Chess960"
            {
                self.base
                    .set_option_with_operation(
                        &option.name,
                        &option.value,
                        &option.resource_values,
                        operation_cancellation.clone(),
                    )
                    .await?;
                if let Some(current) = current {
                    self.record_written_option(current.clone());
                }
                // A fresh actor can be cancelled after its first resource write.
                // Retain those leases along with the now-written option belief.
                for resource in &option.resources {
                    if !self
                        .resource_leases
                        .iter()
                        .any(|held| Arc::ptr_eq(held, resource))
                    {
                        self.resource_leases.push(resource.clone());
                    }
                }
            }
        }

        ensure_search_not_cancelled(search_cancelled)?;
        if fen_changed || options.moves != self.options.moves {
            self.set_position(&options.fen, &options.moves).await?;
        }
        // UCI applies setoption lazily in many engines. A ready barrier makes
        // the following position/go belong to this exact configuration.
        ensure_search_not_cancelled(search_cancelled)?;
        self.base.ensure_ready().await?;
        ensure_search_not_cancelled(search_cancelled)?;
        self.resource_leases = next_resource_leases;
        self.last_depth = 0;
        self.options = options.clone();
        self.best_moves.clear();
        self.last_best_moves.clear();
        Ok(())
    }

    fn record_written_option(&mut self, option: EngineOption) {
        self.options
            .extra_options
            .retain(|previous| previous.name() != option.name());
        self.options.extra_options.push(option);
    }

    async fn set_position(&mut self, fen: &str, moves: &[String]) -> Result<(), Error> {
        self.base.set_position(fen, moves).await?;
        self.options.fen = fen.to_string();
        self.options.moves = moves.to_owned();
        Ok(())
    }

    async fn go(&mut self, mode: &GoMode) -> Result<(), Error> {
        #[cfg(all(test, unix))]
        observe_interactive_go_attempt();
        self.go_mode = mode.clone();
        self.request_id = Some(self.base.start_search(mode).await?);
        self.running = true;
        self.start = Instant::now();
        Ok(())
    }

    async fn next_line(&mut self) -> Result<Option<String>, Error> {
        let request_id = self.request_id.ok_or(Error::EngineNotInitialized)?;
        self.base.next_search_line(request_id).await
    }

    async fn next_line_cancellable(
        &mut self,
        cancelled: &AtomicBool,
    ) -> Result<Option<String>, Error> {
        let request_id = self.request_id.ok_or(Error::EngineNotInitialized)?;
        self.base
            .next_search_line_cancellable(request_id, cancelled)
            .await
    }
}

#[derive(Clone, Serialize, Debug, Derivative, Type)]
#[derivative(Default)]
pub struct BestMoves {
    nodes: u64,
    depth: u32,
    score: Score,
    #[serde(rename = "uciMoves")]
    uci_moves: Vec<String>,
    #[serde(rename = "sanMoves")]
    san_moves: Vec<String>,
    #[derivative(Default(value = "1"))]
    multipv: u16,
    nps: u64,
}

#[derive(Serialize, Debug, Clone, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct BestMovesPayload {
    pub best_lines: Vec<BestMoves>,
    pub engine: String,
    pub tab: String,
    pub fen: String,
    pub moves: Vec<String>,
    pub progress: f64,
    pub generation: String,
}

impl BestMoves {
    pub(crate) fn depth(&self) -> u32 {
        self.depth
    }

    /// The evaluation from White's point of view.
    pub(crate) fn score(&self) -> &Score {
        &self.score
    }

    pub(crate) fn san_moves(&self) -> &[String] {
        &self.san_moves
    }
}

fn invert_score(score: Score) -> Score {
    let new_value = match score.value {
        ScoreValue::Cp(x) => ScoreValue::Cp(x.saturating_neg()),
        ScoreValue::Mate(x) => ScoreValue::Mate(x.saturating_neg()),
    };
    let new_wdl = score.wdl.map(|(w, d, l)| (l, d, w));
    Score {
        value: new_value,
        wdl: new_wdl,
        ..score
    }
}

fn parse_uci_attrs(
    attrs: Vec<UciInfoAttribute>,
    fen: &str,
    moves: &[String],
) -> Result<BestMoves, Error> {
    let mut best_moves = BestMoves::default();
    let mut score_seen = false;

    let mut pos = crate::engine::canonicalize_engine_position(fen, moves)?.position;
    let turn = pos.turn();

    for a in attrs {
        match a {
            UciInfoAttribute::Pv(m) => {
                for mv in m {
                    let uci: UciMove = mv.to_string().parse()?;
                    let m = uci.to_move(&pos)?;
                    let san = SanPlus::from_move_and_play_unchecked(&mut pos, &m);
                    best_moves.san_moves.push(san.to_string());
                    best_moves.uci_moves.push(uci.to_string());
                }
            }
            UciInfoAttribute::Nps(nps) => {
                best_moves.nps = nps;
            }
            UciInfoAttribute::Nodes(nodes) => {
                best_moves.nodes = nodes;
            }
            UciInfoAttribute::Depth(depth) => {
                best_moves.depth = depth;
            }
            UciInfoAttribute::MultiPv(multipv) => {
                best_moves.multipv = multipv;
            }
            UciInfoAttribute::Score(score) => {
                best_moves.score = score;
                score_seen = true;
            }
            _ => (),
        }
    }

    if best_moves.san_moves.is_empty() || !score_seen {
        return Err(Error::NoMovesFound);
    }

    if turn == Color::Black {
        best_moves.score = invert_score(best_moves.score);
    }

    Ok(best_moves)
}

fn score_is_bound(score: &Score) -> bool {
    score.lower_bound == Some(true) || score.upper_bound == Some(true)
}

/// A finished MultiPV set removed from `collected`. Ingest clears the collector
/// on a complete set; callers do not. Mixed-depth and shallower sets still
/// complete the sequence, but callers publish only when `publishable`.
struct CompleteMultiPv {
    depth: u32,
    nodes: u64,
    publishable: bool,
    lines: Vec<BestMoves>,
}

/// Shared UCI `info` aggregation for the interactive and report paths.
/// Bound scores are not evaluations (`64fad3d6`); out-of-sequence MultiPV
/// lines are dropped; a complete set is one whose last line is `real_multipv`.
fn ingest_info_line(
    collected: &mut Vec<BestMoves>,
    last_depth: u32,
    real_multipv: u16,
    line: BestMoves,
) -> Option<CompleteMultiPv> {
    if score_is_bound(&line.score) {
        return None;
    }
    let multipv = line.multipv;
    let depth = line.depth;
    let nodes = line.nodes;
    if multipv as usize != collected.len() + 1 {
        return None;
    }
    collected.push(line);
    if multipv != real_multipv {
        return None;
    }
    let publishable = collected.iter().all(|x| x.depth == depth) && depth >= last_depth;
    let lines = std::mem::take(collected);
    Some(CompleteMultiPv {
        depth,
        nodes,
        publishable,
        lines,
    })
}

#[derive(Deserialize, Debug, Clone, Type, Derivative, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
#[derivative(Default)]
pub struct EngineOptions {
    pub fen: String,
    pub moves: Vec<String>,
    pub extra_options: Vec<EngineOption>,
}

async fn terminate_analysis_engines(
    supervisor: &crate::engine::EngineSupervisor,
    ids: impl IntoIterator<Item = String>,
) -> Result<Vec<String>, Error> {
    let mut failures = Vec::new();
    for id in ids {
        let key = EngineKey::new("analysis".into(), id)?;
        if let Err(error) = supervisor.kill_engine(&key).await {
            failures.push(error.to_string());
        }
    }
    Ok(failures)
}

#[tauri::command]
#[specta::specta]
pub async fn kill_engines(
    tab: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let analyses = state
        .operations
        .cancel_analyses_for_tab(window.label(), &tab)?;
    let mut failures = terminate_analysis_engines(&state.engine_supervisor, analyses).await?;
    if let Err(error) = state.engine_supervisor.terminate_tab(&tab).await {
        failures.push(error.to_string());
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(Error::Conflict(failures.join("; ")))
    }
}

#[tauri::command]
#[specta::specta]
pub async fn retire_engine(engine: String, state: tauri::State<'_, AppState>) -> Result<(), Error> {
    state.engine_supervisor.retire_engine(engine).await
}

#[tauri::command]
#[specta::specta]
#[cfg(test)]
pub async fn retire_engine_binary(
    engine: String,
    retired: EngineHandle,
    current: EngineHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    state
        .engine_supervisor
        .retire_engine_binary(engine, retired.id, current.id)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn kill_engine(
    engine: String,
    tab: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let key = EngineKey::new(tab, engine)?;
    state.engine_supervisor.kill_engine(&key).await
}
#[tauri::command]
#[specta::specta]
pub async fn stop_engine(
    engine: String,
    tab: String,
    expected_generation: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<bool, Error> {
    let key = EngineKey::new(tab, engine)?;
    let generation = expected_generation
        .as_deref()
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|_| Error::InvalidInput("invalid engine generation".into()))
        })
        .transpose()?;
    state.engine_supervisor.stop_search(&key, generation).await
}

#[tauri::command]
#[specta::specta]
pub async fn release_engine_search(
    engine: String,
    tab: String,
    generation: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let key = EngineKey::new(tab, engine)?;
    let generation = generation
        .parse::<u64>()
        .map_err(|_| Error::InvalidInput("invalid engine generation".into()))?;
    state
        .engine_supervisor
        .release_generation(&key, generation)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn prepare_engine_search(
    id: String,
    engine: EngineHandle,
    tab: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, Error> {
    let executable_ref = engine.id.clone();
    let key = EngineKey::new(tab, id.clone())?;
    state
        .engine_supervisor
        .prepare_engine_search(key, id, executable_ref)
        .await
}

fn classify_interactive_search_result(
    run_result: Result<(), Error>,
    cancelled: bool,
) -> Result<(), Error> {
    match run_result {
        Ok(()) if cancelled => Err(Error::Cancellation),
        Ok(()) => Ok(()),
        Err(error) => Err(cancelled_search_error(error, cancelled)),
    }
}

fn interactive_best_moves_payload(
    process: &EngineProcess,
    engine: &str,
    tab: &str,
    generation: u64,
    best_lines: Vec<BestMoves>,
    progress: f64,
) -> BestMovesPayload {
    BestMovesPayload {
        best_lines,
        engine: engine.to_owned(),
        tab: tab.to_owned(),
        fen: process.options.fen.clone(),
        moves: process.options.moves.clone(),
        progress,
        generation: generation.to_string(),
    }
}

fn emit_live_interactive_best_moves<R: tauri::Runtime>(
    supervised: &SupervisedEngine,
    app: &tauri::AppHandle<R>,
    payload: BestMovesPayload,
) -> Result<bool, Error> {
    // Publication barrier: the same lock `mark_cancelled` takes. Stop/kill
    // cannot return while a dequeued line is still free to emit.
    supervised.try_publish(|| {
        payload.emit(app)?;
        Ok(())
    })
}

async fn process_interactive_search_output<R: tauri::Runtime>(
    process: &mut EngineProcess,
    engine: &str,
    tab: &str,
    supervised: &SupervisedEngine,
    app: &tauri::AppHandle<R>,
) -> Result<(), Error> {
    let limiter = RateLimiter::direct(Quota::per_second(nonzero!(5u32)));
    let mut parse_error = None;
    loop {
        let Some(line) = process.next_line().await? else {
            break;
        };
        #[cfg(test)]
        observe_dequeued_search_line(&line);
        #[cfg(all(test, unix))]
        run_interactive_line_dequeued_hook().await;
        match parse_one(&line) {
            UciMessage::Info(attrs) => {
                match parse_uci_attrs(attrs, &process.options.fen, &process.options.moves) {
                    Ok(best_moves) => {
                        if let Some(set) = ingest_info_line(
                            &mut process.best_moves,
                            process.last_depth,
                            process.real_multipv,
                            best_moves,
                        ) {
                            if set.publishable {
                                let progress = (match process.go_mode {
                                    GoMode::Depth(depth) => {
                                        (set.depth as f64 / depth as f64) * 100.0
                                    }
                                    GoMode::Time(time) => {
                                        (process.start.elapsed().as_millis() as f64 / time as f64)
                                            * 100.0
                                    }
                                    GoMode::Nodes(nodes) => {
                                        (set.nodes as f64 / nodes as f64) * 100.0
                                    }
                                    GoMode::PlayersTime(_) => 99.99,
                                    GoMode::Infinite => 99.99,
                                })
                                .clamp(0.0, 100.0);
                                // Retain every complete set under the search barrier;
                                // only intermediate events consume the rate limit.
                                let generation = supervised.owner_generation();
                                supervised.try_publish(|| -> Result<(), Error> {
                                    process.last_depth = set.depth;
                                    process.last_best_moves = set.lines;
                                    process.last_progress = progress as f32;
                                    if limiter.check().is_ok() {
                                        interactive_best_moves_payload(
                                            process,
                                            engine,
                                            tab,
                                            generation,
                                            process.last_best_moves.clone(),
                                            progress,
                                        )
                                        .emit(app)?;
                                    }
                                    Ok(())
                                })?;
                            }
                        }
                    }
                    Err(Error::NoMovesFound) => {}
                    Err(error) => {
                        warn!("Failed to parse info line: {}, error: {:?}", line, error);
                        parse_error = Some(error);
                    }
                }
            }
            UciMessage::BestMove { .. } => {
                if process.last_best_moves.is_empty() {
                    if let Some(error) = parse_error.take() {
                        return Err(error);
                    }
                }
                let published = emit_live_interactive_best_moves(
                    supervised,
                    app,
                    interactive_best_moves_payload(
                        process,
                        engine,
                        tab,
                        supervised.owner_generation(),
                        process.last_best_moves.clone(),
                        100.0,
                    ),
                )?;
                if published {
                    process.last_progress = 100.0;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_engine_logs(
    engine: String,
    tab: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<EngineLog>, Error> {
    let key = EngineKey::new(tab, engine)?;
    get_engine_logs_from_supervisor(&state.engine_supervisor, &key).await
}

async fn get_engine_logs_from_supervisor(
    supervisor: &crate::engine::EngineSupervisor,
    key: &EngineKey,
) -> Result<Vec<EngineLog>, Error> {
    if let Some(process) = supervisor.get_exact(key) {
        process.actor.logs().await
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
#[specta::specta]
// Tauri injects `app` and `state`; the remaining Specta arguments stay explicit
// because grouping them would change the generated renderer invoke contract.
#[allow(clippy::too_many_arguments)]
pub async fn get_best_moves(
    id: String,
    engine: EngineHandle,
    tab: String,
    go_mode: GoMode,
    options: EngineOptions,
    generation: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<(f32, Vec<BestMoves>)>, Error> {
    get_best_moves_core(
        id,
        engine,
        tab,
        go_mode,
        options,
        generation,
        app,
        state.inner().clone(),
    )
    .await
}

// Keep the command's independently validated engine, tab and generation fields visible at this
// internal boundary; grouping them would hide which values participate in stale-result checks.
#[allow(clippy::too_many_arguments)]
async fn get_best_moves_core<R: tauri::Runtime>(
    id: String,
    engine: EngineHandle,
    tab: String,
    go_mode: GoMode,
    options: EngineOptions,
    generation: String,
    app: tauri::AppHandle<R>,
    state: AppState,
) -> Result<Option<(f32, Vec<BestMoves>)>, Error> {
    let executable_ref = engine.id.clone();
    let key = EngineKey::new(tab.clone(), id.clone())?;
    let admission = state
        .engine_supervisor
        .consume_engine_search(key.clone(), id.clone(), executable_ref.clone(), &generation)
        .await?;
    let (mut process, supervised, search) = state
        .engine_supervisor
        .start_interactive_search(
            key.clone(),
            engine.clone(),
            state.pgn_path_authority.clone(),
            admission,
            options,
            &go_mode,
        )
        .await?;
    let mut guard = crate::engine::RegistrationGuard::for_search(
        state.engine_supervisor.clone(),
        key.clone(),
        search.generation,
    );
    let run_result =
        process_interactive_search_output(&mut process, &id, &tab, &supervised, &app).await;
    let run_result =
        classify_interactive_search_result(run_result, search.cancelled.load(Ordering::SeqCst));
    info!(
        "Engine search finished: tab: {}, engine: {}",
        tab, engine.id.id
    );
    let cleanup = if run_result
        .as_ref()
        .is_err_and(|error| !matches!(error, Error::Cancellation))
    {
        state
            .engine_supervisor
            .release_generation(&key, search.generation)
            .await
    } else {
        Ok(())
    };
    guard.disarm();
    complete_interactive_search(run_result, cleanup)
}

fn complete_interactive_search(
    run_result: Result<(), Error>,
    cleanup: Result<(), Error>,
) -> Result<Option<(f32, Vec<BestMoves>)>, Error> {
    match (run_result, cleanup) {
        (Ok(()), Ok(())) => Ok(None),
        (Err(primary), Ok(())) => Err(primary),
        (Ok(()), Err(cleanup)) => Err(cleanup),
        (Err(primary), Err(cleanup)) => Err(Error::with_cleanup(primary, Err(cleanup))),
    }
}

/// Why a report position has no legal continuation worth searching, decided by the native chess
/// library. Stalemate and insufficient material are both draws.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReportTerminal {
    Checkmate,
    Draw,
}

/// One mainline position of a report: entry `i` of [`GameAnalysis::positions`] is the position
/// after `i` mainline moves. `best` is White-relative; a terminal position is never searched and
/// has empty `best`. `is_sacrifice` describes the move that reached the position.
#[derive(Serialize, Debug, Default, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReportPosition {
    best: Vec<BestMoves>,
    terminal: Option<ReportTerminal>,
    is_sacrifice: bool,
}

/// The novelty phase's outcome. `position` is the 0-based index into
/// [`GameAnalysis::positions`] of the first position absent from the reference database, never 0.
#[derive(Serialize, Debug, Clone, PartialEq, Eq, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NoveltyOutcome {
    NotRequested,
    Found { position: u32 },
    NotFound,
    Unavailable,
}

#[derive(Serialize, Debug, Type)]
#[serde(rename_all = "camelCase")]
pub struct GameAnalysis {
    positions: Vec<ReportPosition>,
    novelty: NoveltyOutcome,
}

#[derive(Deserialize, Debug, Default, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisOptions {
    pub fen: String,
    pub moves: Vec<String>,
    pub annotate_novelties: bool,
    pub reference_db: Option<DatabaseHandle>,
}

const REPORT_MULTIPV: u16 = 2;

fn restore_inherited_resource_provenance(
    option: &mut ResolvedEngineOption,
    inherited_resources: &HashMap<String, (String, Vec<String>)>,
) {
    let Some((value, resource_values)) = inherited_resources.get(&option.name) else {
        return;
    };
    option.value = value.clone();
    option.resource_values = resource_values.clone();
    option.resources.clear();
}

/// The configured options with `MultiPV` forced to `lines`, whatever the engine's own setting is.
fn analysis_options_with_lines(uci_options: &[EngineOption], lines: u16) -> Vec<EngineOption> {
    let mut options = crate::engine::effective_engine_options(uci_options);
    let multipv = EngineOption::String {
        name: "MultiPV".into(),
        value: lines.to_string(),
    };
    if let Some(option) = options.iter_mut().find(|option| option.name() == "MultiPV") {
        *option = multipv;
    } else {
        options.push(multipv);
    }
    options
}

/// Grace after a timed search's own limit before the session stops waiting for `bestmove`.
const TIMED_SEARCH_GRACE: Duration = Duration::from_secs(3);

/// A timed search ends itself, so a wall-clock bound is its time plus a grace. The other modes keep
/// the actor's own per-line deadlines.
fn analysis_search_deadline(go_mode: &GoMode, grace: Duration) -> Option<Duration> {
    match go_mode {
        GoMode::Time(milliseconds) => Some(Duration::from_millis(u64::from(*milliseconds)) + grace),
        GoMode::PlayersTime(_) | GoMode::Depth(_) | GoMode::Nodes(_) | GoMode::Infinite => None,
    }
}

/// One private engine process for a sequence of single-position searches. The game report and the
/// Coach share it: `start` admits, resolves and spawns under the caller's key, `analyze` runs one
/// bounded search, and the owner ends it with `terminate` (or hands the guard to its own cleanup
/// through `into_guard`). Dropping it without either leaves the guard's detached cleanup.
pub(crate) struct AnalysisSession {
    proc: EngineProcess,
    supervised: SupervisedEngine,
    guard: RegistrationGuard,
    authority: crate::infra::path_authority::SharedPathAuthority,
    cancellation: CancellationToken,
    uci_options: Vec<EngineOption>,
    /// Spawn-time values of the resource options: the initial lease owns the child access, but the
    /// individual values remain provenance for delayed transcript echoes. Freshly resolving the
    /// same handle may produce different descriptor numbers.
    inherited_resources: HashMap<String, (String, Vec<String>)>,
    timed_search_grace: Duration,
}

impl AnalysisSession {
    pub(crate) async fn start(
        state: &AppState,
        key: EngineKey,
        engine: EngineHandle,
        engine_id: String,
        uci_options: Vec<EngineOption>,
        cancellation: CancellationToken,
    ) -> Result<Self, Error> {
        let executable_ref = engine.id.clone();
        let resource_refs = crate::engine::resource_path_refs(&uci_options);
        // Admission is deliberately before any descriptor resolution. A canceled analysis must not
        // acquire the authority lock or create a launch leaf.
        let admission = state
            .engine_supervisor
            .admit_for_operation_with_resources(
                key.clone(),
                engine_id,
                executable_ref,
                &resource_refs,
                cancellation.clone(),
            )
            .await?;
        let (executable, initial_resolved) = resolve_launch(
            state.pgn_path_authority.clone(),
            engine,
            PathOperation::EngineExecute,
            &uci_options,
            &admission,
        )
        .await?;
        let resource_options: HashSet<String> =
            crate::engine::effective_engine_options(&uci_options)
                .iter()
                .filter(|option| matches!(option, EngineOption::Resource { .. }))
                .map(|option| option.name().to_owned())
                .collect();
        let inherited_resources = initial_resolved
            .into_iter()
            .filter(|option| resource_options.contains(&option.name))
            .map(|option| (option.name, (option.value, option.resource_values)))
            .collect();
        let (proc, supervised, guard) =
            EngineProcess::new(state.engine_supervisor.clone(), key, executable, admission).await?;
        Ok(Self {
            proc,
            supervised,
            guard,
            authority: state.pgn_path_authority.clone(),
            cancellation,
            uci_options,
            inherited_resources,
            timed_search_grace: TIMED_SEARCH_GRACE,
        })
    }

    /// Whether the owner cancelled the operation or the supervisor cancelled this engine.
    pub(crate) fn ensure_active(&self) -> Result<(), Error> {
        ensure_analysis_owner_active(&self.supervised, &self.cancellation)
    }

    /// One search of the position after `moves` from `fen` with `lines` principal variations.
    pub(crate) async fn analyze(
        &mut self,
        fen: &str,
        moves: &[String],
        lines: u16,
        go_mode: &GoMode,
    ) -> Result<Vec<BestMoves>, Error> {
        let configured_options = EngineOptions {
            fen: fen.to_owned(),
            moves: moves.to_vec(),
            extra_options: analysis_options_with_lines(&self.uci_options, lines),
        };
        let mut resolved = resolve_option_leases(
            self.authority.clone(),
            &configured_options.extra_options,
            self.cancellation.clone(),
        )
        .await?;
        for option in &mut resolved {
            restore_inherited_resource_provenance(option, &self.inherited_resources);
        }
        self.proc
            .set_options(
                configured_options,
                resolved,
                Some(self.cancellation.clone()),
            )
            .await?;

        let search = analyze_position_with_owner(
            &mut self.proc,
            &self.supervised,
            &self.cancellation,
            go_mode,
            moves,
        );
        let Some(deadline) = analysis_search_deadline(go_mode, self.timed_search_grace) else {
            return search.await;
        };
        match tokio::time::timeout(deadline, search).await {
            Ok(result) => result,
            Err(_) => {
                let overdue = Error::EngineTimeout("engine search did not finish in time".into());
                let stopped = match self.proc.request_id {
                    Some(request) => self.proc.base.stop_request(request).await,
                    None => Ok(()),
                };
                Err(Error::with_cleanup(overdue, stopped))
            }
        }
    }

    pub(crate) async fn terminate(self) -> Result<(), Error> {
        self.guard.terminate_now().await
    }

    fn into_guard(self) -> RegistrationGuard {
        self.guard
    }
}

#[tauri::command]
#[specta::specta]
pub fn prepare_analysis(
    tab: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<String, Error> {
    state.operations.prepare_analysis(window.label(), &tab)
}

#[tauri::command]
#[specta::specta]
pub async fn cancel_analysis(
    id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    state.operations.cancel_analysis(&id, window.label())?;
    cancel_analysis_engine(&state.engine_supervisor, &id)
}

pub(crate) fn cancel_analysis_engine(
    supervisor: &crate::engine::EngineSupervisor,
    id: &str,
) -> Result<(), Error> {
    let key = EngineKey::new("analysis".into(), id.to_owned())?;
    if let Some(process) = supervisor.get_exact(&key) {
        supervisor.cancel_exact(&key, process.generation);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
// Specta commands are a flat parameter list; grouping them would change the
// generated invoke contract (`engineId` is a new required argument).
#[allow(clippy::too_many_arguments)]
pub async fn analyze_game(
    id: String,
    tab: String,
    engine: EngineHandle,
    engine_id: String,
    go_mode: GoMode,
    options: AnalysisOptions,
    uci_options: Vec<EngineOption>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<GameAnalysis, Error> {
    if options.reference_db.is_some() {
        crate::wait_for_reserved_migration(
            state.inner(),
            crate::infra::path_authority::FolderSwitchKind::Database,
            Some(&id),
            window.label(),
            crate::infra::operations::ReservationKind::Analysis { tab: &tab },
        )
        .await?;
    }
    let label = format!("analyze_game {id}");
    let operation = state
        .operations
        .claim_analysis(&id, window.label(), &tab, &label)?;
    let cancellation = operation.token();
    let state = state.inner().clone();
    crate::infra::operations::run_native_operation(operation, "analyze_game", async move {
        analyze_game_core(
            id,
            engine,
            engine_id,
            go_mode,
            options,
            uci_options,
            state,
            app,
            cancellation,
        )
        .await
    })
    .await
}

fn analysis_terminal_state(error: &Error) -> ProgressState {
    if matches!(error, Error::Cancellation | Error::AnalysisCancelled) {
        ProgressState::Cancelled
    } else {
        ProgressState::Failed
    }
}

fn ensure_analysis_not_cancelled(cancellation: &CancellationToken) -> Result<(), Error> {
    if cancellation.is_cancelled() {
        Err(Error::AnalysisCancelled)
    } else {
        Ok(())
    }
}

fn ensure_analysis_owner_active(
    supervised: &crate::engine::SupervisedEngine,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    if supervised.cancelled.load(Ordering::SeqCst) {
        Err(Error::AnalysisCancelled)
    } else {
        ensure_analysis_not_cancelled(cancellation)
    }
}

#[cfg(test)]
type AnalysisLineHook = Box<dyn FnMut(&str)>;

#[cfg(test)]
type AnalysisReplayPlyHook = Box<dyn FnMut(usize)>;

#[cfg(all(test, unix))]
type AsyncAnalysisHook =
    Box<dyn FnOnce() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send>;

#[cfg(all(test, unix))]
type SyncAnalysisHook = Box<dyn FnOnce() + Send>;

#[cfg(test)]
std::thread_local! {
    static ANALYSIS_LINE_DEQUEUED_HOOK: std::cell::RefCell<Option<AnalysisLineHook>> =
        const { std::cell::RefCell::new(None) };
    static ANALYSIS_REPLAY_PLY_HOOK: std::cell::RefCell<Option<AnalysisReplayPlyHook>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(all(test, unix))]
std::thread_local! {
    static AFTER_RESOURCE_VERIFICATION_HOOK: std::cell::RefCell<Option<AsyncAnalysisHook>> =
        const { std::cell::RefCell::new(None) };
    static INTERACTIVE_BEFORE_GO_HOOK: std::cell::RefCell<Option<AsyncAnalysisHook>> =
        const { std::cell::RefCell::new(None) };
    static INTERACTIVE_GO_ATTEMPT_HOOK: std::cell::RefCell<Option<SyncAnalysisHook>> =
        const { std::cell::RefCell::new(None) };
    static INTERACTIVE_LINE_DEQUEUED_HOOK: std::cell::RefCell<Option<AsyncAnalysisHook>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(all(test, unix))]
fn set_after_resource_verification_hook(hook: Option<AsyncAnalysisHook>) {
    AFTER_RESOURCE_VERIFICATION_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(all(test, unix))]
async fn run_after_resource_verification_hook() {
    let hook = AFTER_RESOURCE_VERIFICATION_HOOK.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook().await;
    }
}

#[cfg(all(test, unix))]
fn set_interactive_before_go_hook(hook: Option<AsyncAnalysisHook>) {
    INTERACTIVE_BEFORE_GO_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(all(test, unix))]
async fn run_interactive_before_go_hook() {
    let hook = INTERACTIVE_BEFORE_GO_HOOK.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook().await;
    }
}

#[cfg(all(test, unix))]
async fn run_interactive_line_dequeued_hook() {
    let hook = INTERACTIVE_LINE_DEQUEUED_HOOK.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook().await;
    }
}

#[cfg(all(test, unix))]
fn set_interactive_go_attempt_hook(hook: Option<SyncAnalysisHook>) {
    INTERACTIVE_GO_ATTEMPT_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(all(test, unix))]
fn observe_interactive_go_attempt() {
    let hook = INTERACTIVE_GO_ATTEMPT_HOOK.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}

#[cfg(test)]
fn observe_dequeued_search_line(line: &str) {
    ANALYSIS_LINE_DEQUEUED_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().as_mut() {
            hook(line);
        }
    });
}

/// One replayed mainline position: the position itself, the moves that reach it from the root,
/// and whether the game is over there.
#[derive(Debug)]
struct ReplayedPosition {
    position: Chess,
    fen: Fen,
    moves: Vec<String>,
    played_move: Option<shakmaty::Move>,
    terminal: Option<ReportTerminal>,
}

fn report_terminal(position: &Chess) -> Option<ReportTerminal> {
    if position.is_checkmate() {
        Some(ReportTerminal::Checkmate)
    } else if position.is_game_over() {
        // No legal move without check is stalemate; otherwise neither side can mate.
        Some(ReportTerminal::Draw)
    } else {
        None
    }
}

/// Replays the mainline. The result has `moves.len() + 1` entries in game order; entry 0 is the
/// root.
fn collect_report_positions(
    fen: Fen,
    moves: &[String],
    cancellation: &CancellationToken,
) -> Result<Vec<ReplayedPosition>, Error> {
    ensure_analysis_not_cancelled(cancellation)?;
    let (mut chess, _) = crate::engine::engine_setup_to_chess(fen.as_setup().clone())?;
    let mut positions = vec![ReplayedPosition {
        terminal: report_terminal(&chess),
        position: chess.clone(),
        fen,
        moves: Vec::new(),
        played_move: None,
    }];

    for (i, m) in moves.iter().enumerate() {
        ensure_analysis_not_cancelled(cancellation)?;
        let uci = UciMove::from_ascii(m.as_bytes())?;
        let played = uci.to_move(&chess)?;
        chess.play_unchecked(&played);
        #[cfg(test)]
        ANALYSIS_REPLAY_PLY_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().as_mut() {
                hook(i);
            }
        });
        ensure_analysis_not_cancelled(cancellation)?;
        positions.push(ReplayedPosition {
            terminal: report_terminal(&chess),
            position: chess.clone(),
            fen: Fen::from_position(chess.clone(), EnPassantMode::Legal),
            moves: moves[..=i].to_vec(),
            played_move: Some(played),
        });
    }
    Ok(positions)
}

/// Searches one report position. The two-line collector decides publishable sets exactly as the
/// interactive path does; when the search ends without one, the deepest exact first line the
/// engine reported during this search is the result. The fallback is local to this call, so no
/// line leaks from one position into the next.
async fn analyze_position_with_owner(
    proc: &mut EngineProcess,
    supervised: &crate::engine::SupervisedEngine,
    cancellation: &CancellationToken,
    go_mode: &GoMode,
    moves: &[String],
) -> Result<Vec<BestMoves>, Error> {
    ensure_analysis_owner_active(supervised, cancellation)?;
    proc.go(go_mode).await?;

    let mut published: Vec<BestMoves> = Vec::new();
    let mut deepest_first_line: Option<BestMoves> = None;
    loop {
        let line = proc.next_line_cancellable(&supervised.cancelled).await?;
        let Some(line) = line else {
            return Err(Error::EngineDisconnected);
        };
        #[cfg(test)]
        observe_dequeued_search_line(&line);
        match parse_one(&line) {
            UciMessage::Info(attrs) => match parse_uci_attrs(attrs, &proc.options.fen, moves) {
                Ok(best_moves) => {
                    if best_moves.multipv == 1
                        && !score_is_bound(&best_moves.score)
                        && deepest_first_line
                            .as_ref()
                            .is_none_or(|deepest| best_moves.depth >= deepest.depth)
                    {
                        deepest_first_line = Some(best_moves.clone());
                    }
                    if let Some(set) = ingest_info_line(
                        &mut proc.best_moves,
                        proc.last_depth,
                        proc.real_multipv,
                        best_moves,
                    ) {
                        if set.publishable {
                            published = set.lines;
                            proc.last_depth = set.depth;
                        }
                    }
                }
                Err(Error::NoMovesFound) => {}
                Err(error) => warn!("Failed to parse info line: {line}, error: {error:?}"),
            },
            UciMessage::BestMove { .. } => {
                ensure_analysis_owner_active(supervised, cancellation)?;
                break;
            }
            _ => {}
        }
    }
    ensure_analysis_owner_active(supervised, cancellation)?;
    if published.is_empty() {
        Ok(deepest_first_line.into_iter().collect())
    } else {
        Ok(published)
    }
}

async fn finish_analysis_failure<R: tauri::Runtime>(
    guard: Option<RegistrationGuard>,
    progress_state: &crate::progress::ProgressStore,
    app: &tauri::AppHandle<R>,
    progress: &crate::progress::ProgressLease,
    error: Error,
) -> Error {
    let cleanup = match guard {
        Some(guard) => guard.terminate_now().await,
        None => Ok(()),
    };
    if let Err(terminal) = update_progress_with_state(
        progress_state,
        app,
        progress,
        0.0,
        analysis_terminal_state(&error),
    ) {
        log::warn!(
            "analysis terminal progress generation {} failed: {}",
            progress.generation,
            terminal.category()
        );
    }
    Error::with_cleanup(error, cleanup)
}

// Keep the command's independently validated engine, report and native-owner fields visible at
// this internal boundary; grouping them would hide which values participate in stale-result checks.
#[allow(clippy::too_many_arguments)]
async fn analyze_game_core<R: tauri::Runtime>(
    id: String,
    engine: EngineHandle,
    engine_id: String,
    go_mode: GoMode,
    options: AnalysisOptions,
    uci_options: Vec<EngineOption>,
    state: AppState,
    app: tauri::AppHandle<R>,
    cancellation: CancellationToken,
) -> Result<GameAnalysis, Error> {
    ensure_analysis_not_cancelled(&cancellation)?;
    // A report searches every position to the same bound; an open-ended or clock-based limit
    // has none. Refused before any progress entry, admission or spawn exists.
    if matches!(go_mode, GoMode::Infinite | GoMode::PlayersTime(_)) {
        return Err(Error::InvalidInput(
            "a report needs a depth, time or node limit".into(),
        ));
    }
    if options.annotate_novelties && options.reference_db.is_none() {
        return Err(Error::MissingReferenceDatabase);
    }
    let analysis_key = EngineKey::new("analysis".into(), id.clone())?;

    let fen = Fen::from_ascii(options.fen.as_bytes())?;
    let replay = collect_report_positions(fen, &options.moves, &cancellation)?;
    let sacrifices = report_sacrifices(
        replay
            .iter()
            .map(|entry| (entry.position.clone(), entry.terminal.is_some()))
            .collect(),
        cancellation.clone(),
        |_| {},
    )
    .await?;
    ensure_analysis_not_cancelled(&cancellation)?;
    let mut positions: Vec<ReportPosition> = replay
        .iter()
        .zip(sacrifices)
        .map(|(entry, is_sacrifice)| ReportPosition {
            best: Vec::new(),
            terminal: entry.terminal,
            is_sacrifice,
        })
        .collect();
    // The last position first and the root last, so the engine's hash carries what it learned
    // from later positions into earlier ones. Terminal positions are never searched.
    let search_order: Vec<usize> = (0..replay.len())
        .rev()
        .filter(|&index| replay[index].terminal.is_none())
        .collect();
    let progress_lease = begin_progress(&state.progress_state, &app, id.clone())?;
    let mut session = match AnalysisSession::start(
        &state,
        analysis_key.clone(),
        engine,
        engine_id.clone(),
        uci_options,
        cancellation.clone(),
    )
    .await
    {
        Ok(session) => session,
        Err(error) => {
            return Err(finish_analysis_failure(
                None,
                &state.progress_state,
                &app,
                &progress_lease,
                error,
            )
            .await);
        }
    };
    macro_rules! fail_analysis_progress {
        ($guard:expr, $error:expr) => {{
            let error = $error;
            return Err(finish_analysis_failure(
                $guard,
                &state.progress_state,
                &app,
                &progress_lease,
                error,
            )
            .await);
        }};
    }

    for (step, &index) in search_order.iter().enumerate() {
        let moves = &replay[index].moves;
        if let Err(cancelled) = session.ensure_active() {
            fail_analysis_progress!(Some(session.into_guard()), cancelled);
        }

        if let Err(error) = update_progress_with_state(
            &state.progress_state,
            &app,
            &progress_lease,
            (step as f32 / search_order.len() as f32) * 100.0,
            ProgressState::Running,
        ) {
            fail_analysis_progress!(Some(session.into_guard()), error);
        }

        match session
            .analyze(&options.fen, moves, REPORT_MULTIPV, &go_mode)
            .await
        {
            Ok(best) => positions[index].best = best,
            Err(error) => fail_analysis_progress!(Some(session.into_guard()), error),
        }
    }

    if let Err(error) = session.terminate().await {
        fail_analysis_progress!(None, error);
    }

    // After the engine pass, a novelty problem costs the novelty mark only. Cancellation still
    // cancels the report.
    let novelty = match options.reference_db.clone() {
        Some(reference) if options.annotate_novelties => {
            let queries = novelty_queries(&replay);
            let excluded_game = novelty_excluded_game(&replay);
            let authority = state.pgn_path_authority.clone();
            let repository = std::sync::Arc::clone(&state.database_repository);
            let search_cache = std::sync::Arc::clone(&state.search_cache);
            let lookup = async {
                let permit = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => Err(Error::AnalysisCancelled),
                    permit = state.new_request.clone().acquire_owned() => permit.map_err(|_| Error::Conflict("position search permit unavailable".into())),
                }?;
                BLOCKING_GATEWAY
                    .spawn_cancellable(cancellation.clone(), move |worker_cancellation| {
                        novelty_lookup_blocking(
                            &authority,
                            &repository,
                            &search_cache,
                            permit,
                            reference,
                            queries,
                            excluded_game.as_ref(),
                            worker_cancellation,
                        )
                    })
                    .await
            }
            .await;
            match lookup {
                Ok(present) => novelty_outcome(&present),
                Err(error) => match novelty_failure(error, cancellation.is_cancelled()) {
                    Ok(error) => {
                        log::warn!(
                            "report novelty unavailable id={id} label=analyze_game: {}",
                            error.diagnostic()
                        );
                        NoveltyOutcome::Unavailable
                    }
                    Err(cancelled) => fail_analysis_progress!(None, cancelled),
                },
            }
        }
        _ => NoveltyOutcome::NotRequested,
    };
    if let Err(cancelled) = ensure_analysis_not_cancelled(&cancellation) {
        fail_analysis_progress!(None, cancelled);
    }
    update_progress_with_state(
        &state.progress_state,
        &app,
        &progress_lease,
        100.0,
        ProgressState::Succeeded,
    )?;
    Ok(GameAnalysis { positions, novelty })
}

/// Sorts a failed novelty phase: `Err` carries the cancellation that cancels the report, `Ok`
/// the failure that only makes the novelty unavailable. Either native cancellation variant, or
/// any failure while the operation's token is cancelled, is a cancellation.
fn novelty_failure(error: Error, token_cancelled: bool) -> Result<Error, Error> {
    match error {
        Error::Cancellation | Error::AnalysisCancelled => Err(error),
        _ if token_cancelled => Err(Error::AnalysisCancelled),
        error => Ok(error),
    }
}

/// One exact-position query per position reached by a move, in game order.
/// The start position is not a move, so it is never queried and never the
/// novelty; [`novelty_outcome`] maps the resulting flags back.
fn novelty_queries(positions: &[ReplayedPosition]) -> Vec<GameQuery> {
    positions
        .iter()
        .skip(1)
        .map(|entry| {
            GameQuery::new().position(PositionQueryJs {
                fen: entry.fen.to_string(),
                type_: "exact".to_string(),
            })
        })
        .collect()
}

/// The position that first leaves the reference database. `present` covers the positions after
/// each move, so its index `k` is position `k + 1`; position 0 is the start position, which a
/// game from a custom FEN may not share with any reference game.
fn novelty_outcome(present: &[bool]) -> NoveltyOutcome {
    match present.iter().position(|found| !found) {
        Some(first_absent) => match u32::try_from(first_absent + 1) {
            Ok(position) => NoveltyOutcome::Found { position },
            Err(_) => NoveltyOutcome::Unavailable,
        },
        None => NoveltyOutcome::NotFound,
    }
}

fn novelty_excluded_game(positions: &[ReplayedPosition]) -> Option<crate::db::ExcludedGame> {
    let start = &positions.first()?.position;
    let moves = positions
        .iter()
        .skip(1)
        .filter_map(|entry| entry.played_move.clone())
        .collect();
    Some(crate::db::ExcludedGame::new(start, moves))
}

/// Returns a prefix of presence flags ending at the first absent position, or
/// the full length when every position is present. Each element is "this
/// position is PRESENT in the reference database"; `novelty_outcome` turns the
/// flags into the report's novelty. A full-index scan per ply is the cost this
/// offload exists to bound.
// Keep `permit` by value and the `AppState` pieces explicit at this blocking boundary:
// source scans in `main.rs` assert `OwnedSemaphorePermit` in the signature, and grouping
// the arguments into a struct would hide the permit and state dependencies.
#[allow(clippy::too_many_arguments)]
pub(crate) fn novelty_lookup_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &std::sync::Arc<SearchCache>,
    permit: OwnedSemaphorePermit,
    file: DatabaseHandle,
    queries: Vec<GameQuery>,
    excluded_game: Option<&crate::db::ExcludedGame>,
    cancellation: &CancellationToken,
) -> Result<Vec<bool>, Error> {
    let _permit = permit;
    let mut present = Vec::with_capacity(queries.len());
    for query in &queries {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let found = crate::db::is_position_in_db_cancellable(
            authority,
            repository,
            search_cache,
            &file,
            query,
            excluded_game,
            cancellation,
        )?;
        present.push(found);
        if !found {
            break;
        }
    }
    Ok(present)
}

const MATE_SCORE: i32 = 10000;
const PAWN_VALUE: i32 = 100;
const KNIGHT_VALUE: i32 = 300;
const BISHOP_VALUE: i32 = 300;
const ROOK_VALUE: i32 = 500;
const QUEEN_VALUE: i32 = 900;

/// The capture search's static score: the side to move's material balance, with a mate scored
/// as lost and a stalemate as level.
fn count_material(position: &Chess) -> i32 {
    if position.is_checkmate() {
        return -MATE_SCORE;
    }
    if position.is_stalemate() {
        return 0;
    }
    material_balance(position)
}

fn piece_value(role: Role) -> i32 {
    match role {
        Role::Pawn => PAWN_VALUE,
        Role::Knight => KNIGHT_VALUE,
        Role::Bishop => BISHOP_VALUE,
        Role::Rook => ROOK_VALUE,
        Role::Queen => QUEEN_VALUE,
        _ => 0,
    }
}

/// A move is a sacrifice when the mover's material, after the opponent's best capture sequence,
/// ends at least this far below the mover's material before the move.
const SACRIFICE_THRESHOLD: i32 = 200;
/// Nodes one move's capture search may visit. A search that runs out gives "no sacrifice".
const SACRIFICE_NODE_BUDGET: u32 = 20_000;
/// The capture search checks the operation's cancellation every this many nodes.
const SACRIFICE_CANCELLATION_INTERVAL: u32 = 256;

/// The side to move's material minus the opponent's, without terminal scoring.
fn material_balance(position: &Chess) -> i32 {
    let material: ByColor<i32> = position.board().material().map(|p| {
        p.pawn as i32 * PAWN_VALUE
            + p.knight as i32 * KNIGHT_VALUE
            + p.bishop as i32 * BISHOP_VALUE
            + p.rook as i32 * ROOK_VALUE
            + p.queen as i32 * QUEEN_VALUE
    });
    if position.turn() == Color::White {
        material.white - material.black
    } else {
        material.black - material.white
    }
}

enum CaptureSearchStop {
    Budget,
    Cancelled,
}

struct CaptureSearch<'a> {
    nodes_left: u32,
    cancellation: &'a CancellationToken,
}

impl CaptureSearch<'_> {
    fn visit(&mut self) -> Result<(), CaptureSearchStop> {
        if self.nodes_left == 0 {
            return Err(CaptureSearchStop::Budget);
        }
        self.nodes_left -= 1;
        if self
            .nodes_left
            .is_multiple_of(SACRIFICE_CANCELLATION_INTERVAL)
            && self.cancellation.is_cancelled()
        {
            return Err(CaptureSearchStop::Cancelled);
        }
        Ok(())
    }

    /// Captures-only search with stand-pat, scored for the side to move.
    fn qsearch(
        &mut self,
        position: &Chess,
        mut alpha: i32,
        beta: i32,
    ) -> Result<i32, CaptureSearchStop> {
        self.visit()?;
        if position.is_checkmate() || position.is_stalemate() {
            return Ok(count_material(position));
        }
        let stand_pat = count_material(position);
        if stand_pat >= beta {
            return Ok(beta);
        }
        if alpha < stand_pat {
            alpha = stand_pat;
        }
        let legal_moves = position.legal_moves();
        let mut captures: Vec<_> = legal_moves
            .iter()
            .filter_map(|mv| mv.capture().map(|captured| (mv, captured)))
            .collect();
        captures.sort_by_key(|capture| std::cmp::Reverse(piece_value(capture.1)));

        for (capture, _) in captures {
            let mut new_position = position.clone();
            new_position.play_unchecked(capture);
            let score = -self.qsearch(&new_position, -beta, -alpha)?;
            if score >= beta {
                return Ok(beta);
            }
            if score > alpha {
                alpha = score;
            }
        }
        Ok(alpha)
    }
}

/// Whether the move from `before` to `after` gives up material: the mover's balance in `before`
/// against the mover's balance after the opponent's best capture sequence from `after`. A
/// terminal `after` or an exhausted budget is no sacrifice; cancellation is an error.
fn is_sacrifice(
    before: &Chess,
    after: &Chess,
    after_is_terminal: bool,
    cancellation: &CancellationToken,
) -> Result<bool, Error> {
    if after_is_terminal {
        return Ok(false);
    }
    let mut search = CaptureSearch {
        nodes_left: SACRIFICE_NODE_BUDGET,
        cancellation,
    };
    match search.qsearch(after, -MATE_SCORE - 1, MATE_SCORE + 1) {
        Ok(opponent_view) => {
            let mover_after = -opponent_view;
            Ok(material_balance(before) - mover_after >= SACRIFICE_THRESHOLD)
        }
        Err(CaptureSearchStop::Budget) => Ok(false),
        Err(CaptureSearchStop::Cancelled) => Err(Error::AnalysisCancelled),
    }
}

/// Sacrifice flags for each replayed position (`(position, terminal)`, root first); entry `i`
/// describes the move that reached position `i`, and the root's entry is false. Runs on a
/// blocking worker; `on_ply` observes each move before its search.
fn sacrifice_flags_blocking(
    positions: &[(Chess, bool)],
    cancellation: &CancellationToken,
    on_ply: &mut dyn FnMut(usize),
) -> Result<Vec<bool>, Error> {
    let mut flags = Vec::with_capacity(positions.len());
    flags.push(false);
    for (ply, pair) in positions.windows(2).enumerate() {
        on_ply(ply);
        ensure_analysis_not_cancelled(cancellation)?;
        let (before, _) = &pair[0];
        let (after, after_is_terminal) = &pair[1];
        flags.push(is_sacrifice(
            before,
            after,
            *after_is_terminal,
            cancellation,
        )?);
    }
    Ok(flags)
}

/// Computes the sacrifice flags off the Tokio workers. A cancellation observed anywhere in the
/// computation cancels the report with the analysis-cancelled error.
async fn report_sacrifices(
    positions: Vec<(Chess, bool)>,
    cancellation: CancellationToken,
    mut on_ply: impl FnMut(usize) + Send + 'static,
) -> Result<Vec<bool>, Error> {
    let result = BLOCKING_GATEWAY
        .spawn_cancellable(cancellation.clone(), move |worker_cancellation| {
            sacrifice_flags_blocking(&positions, worker_cancellation, &mut on_ply)
        })
        .await;
    match result {
        Err(Error::Cancellation) => Err(Error::AnalysisCancelled),
        Err(_) if cancellation.is_cancelled() => Err(Error::AnalysisCancelled),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::engine::EngineSupervisor;
    use shakmaty::FromSetup;
    #[cfg(unix)]
    use std::time::Duration;
    use tauri::{Listener, Manager};

    #[tokio::test]
    async fn terminal_snapshot_production_completion_preserves_failed_exact_cleanup() {
        let actor = crate::engine::EngineActor::recording_failure_test_actor(
            &["info string safe fatal reason"],
            false,
            Some("exact cleanup failed"),
        );
        let supervisor = crate::engine::EngineSupervisor::default();
        let key = EngineKey::new("terminal-cleanup".into(), "engine".into()).unwrap();
        let current = supervisor
            .replace_handle(
                key.clone(),
                actor.clone(),
                key.engine.clone(),
                crate::infra::path_authority::PathRef { id: "test".into() },
            )
            .await
            .unwrap();
        let request = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        actor.next_search_line(request).await.unwrap();
        let error = actor.next_search_line(request).await.unwrap_err();
        let safe = error.engine_failure_snapshot().unwrap().clone();
        assert_eq!(safe.reason.as_deref(), Some("safe fatal reason"));
        let cleanup = supervisor
            .release_generation(&key, current.generation)
            .await;
        assert!(cleanup.is_err());
        let error = complete_interactive_search(Err(error), cleanup).unwrap_err();
        let payload = serde_json::to_value(&error).unwrap();
        assert_eq!(payload["tag"], "engine-failure");
        assert_eq!(payload["category"], "operation-and-cleanup");
        assert_eq!(
            payload["engineFailure"],
            serde_json::to_value(safe).unwrap()
        );
    }

    #[tokio::test]
    async fn terminal_snapshot_survives_search_rejection_and_exact_cleanup() {
        let (actor, _) = crate::engine::EngineActor::recording_test_actor(&[
            "info string CRITICAL ERROR: e2e4 rejected token=secret /private/book.bin",
        ]);
        let supervisor = crate::engine::EngineSupervisor::default();
        let key = crate::engine::EngineKey::new("terminal-proof".into(), "terminal-engine".into())
            .unwrap();
        let registered = supervisor
            .replace_handle(
                key.clone(),
                actor.clone(),
                key.engine.clone(),
                crate::infra::path_authority::PathRef {
                    id: "terminal-proof".into(),
                },
            )
            .await
            .unwrap();
        let request = actor
            .start_search(&crate::engine::GoMode::Depth(1))
            .await
            .unwrap();
        assert!(actor.next_search_line(request).await.unwrap().is_some());
        let error = actor.next_search_line(request).await.unwrap_err();
        let cleanup = supervisor
            .release_generation(&key, registered.generation)
            .await;
        let error = crate::error::Error::with_cleanup(error, cleanup);
        let bytes = serde_json::to_string(&error).unwrap();
        let payload: serde_json::Value = serde_json::from_str(&bytes).unwrap();
        assert_eq!(payload["tag"], "engine-failure");
        assert_eq!(
            payload["engineFailure"]["reason"],
            "CRITICAL ERROR: e2e4 rejected token=[redacted]"
        );
        assert!(payload["engineFailure"]["exitStatus"].is_null());
        assert!(!bytes.contains("secret"));
        assert!(!bytes.contains("/private"));
        assert!(supervisor.get_exact(&key).is_none());
    }
    #[tokio::test]
    async fn terminate_analysis_engines_waits_for_pending_reap_and_keeps_failure() {
        let supervisor = Arc::new(crate::engine::EngineSupervisor::default());
        let id = "pending-report".to_string();
        let key = EngineKey::new("analysis".into(), id.clone()).unwrap();
        let sentinel = "report-pending-reap-failure";
        let (actor, gate, calls) = EngineActor::gated_pending_test_actor(Some(sentinel));
        let published = supervisor
            .replace_handle(
                key.clone(),
                actor,
                id.clone(),
                crate::infra::path_authority::PathRef {
                    id: "report-engine-path".into(),
                },
            )
            .await
            .unwrap();
        let guard = RegistrationGuard::new(supervisor.clone(), key.clone(), published.generation);
        let reap = tokio::spawn(guard.terminate_now());
        let deadline = std::time::Duration::from_secs(2);
        tokio::time::timeout(deadline, async {
            while !gate.parked.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("report termination must reach the gate");
        assert!(supervisor.get_exact(&key).is_none());

        let teardown = terminate_analysis_engines(&supervisor, [id]);
        tokio::pin!(teardown);
        let pending = futures_util::poll!(&mut teardown).is_pending();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        gate.open();
        assert!(pending, "report teardown must await the pending reap");
        let failures = tokio::time::timeout(deadline, teardown)
            .await
            .expect("report teardown must finish after the gate opens")
            .unwrap();
        let reap_error = tokio::time::timeout(deadline, reap)
            .await
            .expect("report owner must finish after the gate opens")
            .unwrap()
            .unwrap_err();
        assert!(reap_error.diagnostic().contains(sentinel));
        assert_eq!(failures, [reap_error.to_string()]);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    fn assert_rejects_invalid_engine_id(result: Result<(), Error>) {
        assert!(
            matches!(result, Err(Error::InvalidInput(_))),
            "the command must propagate invalid engine id errors"
        );
    }

    #[tokio::test]
    async fn configure_preflight_is_strict_and_canonical_fen_is_wire_only() {
        let (actor, writes) = EngineActor::recording_test_actor(&["readyok"]);
        let mut process = EngineProcess {
            base: actor,
            last_depth: 0,
            best_moves: Vec::new(),
            last_best_moves: Vec::new(),
            last_progress: 0.0,
            options: EngineOptions::default(),
            resource_leases: Vec::new(),
            go_mode: GoMode::Infinite,
            running: false,
            request_id: None,
            real_multipv: 0,
            start: Instant::now(),
        };
        let previous = process.options.clone();
        let rejected = EngineOptions {
            fen: "4k3/8/8/8/8/8/PPPPPPPP/QQQ1K3 w - - 0 1".into(),
            moves: Vec::new(),
            extra_options: vec![string_option("MultiPV", "4")],
        };
        assert!(matches!(
            process
                .set_options(rejected, vec![resolved_option("MultiPV", "4")], None)
                .await,
            Err(Error::EnginePositionRejected(_))
        ));
        assert!(writes.lock().await.is_empty());
        assert_eq!(process.options, previous);
        assert_eq!(process.real_multipv, 0);

        let requested = EngineOptions {
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - -1 200000".into(),
            moves: vec!["e2e4".into()],
            extra_options: Vec::new(),
        };
        process
            .set_options(requested.clone(), Vec::new(), None)
            .await
            .unwrap();
        assert!(writes.lock().await.iter().any(|line| line == "position fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 100000 moves e2e4"));
        assert_eq!(process.options, requested);
        let payload = interactive_best_moves_payload(&process, "engine", "tab", 1, Vec::new(), 0.0);
        assert_eq!(payload.fen, requested.fen);
        assert_eq!(payload.moves, requested.moves);
        let UciMessage::Info(attrs) = parse_one("info depth 1 score cp 10 pv e7e5") else {
            panic!("test fixture must be an info line");
        };
        let parsed = parse_uci_attrs(attrs, &requested.fen, &requested.moves).unwrap();
        assert_eq!(parsed.san_moves, ["e5"]);
        process.base.terminate().await.unwrap();
    }

    #[test]
    fn analysis_cancellation_uses_cancelled_terminal_state() {
        assert_eq!(
            analysis_terminal_state(&Error::Cancellation),
            ProgressState::Cancelled
        );
        assert_eq!(
            analysis_terminal_state(&Error::AnalysisCancelled),
            ProgressState::Cancelled
        );
        assert_eq!(
            analysis_terminal_state(&Error::EngineDisconnected),
            ProgressState::Failed
        );
    }

    #[test]
    fn report_replay_stops_at_the_ply_where_cancellation_arrives() {
        let moves = ["e2e4", "e7e5", "g1f3"]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let live =
            collect_report_positions(start_fen(), &moves, &CancellationToken::new()).unwrap();
        assert_eq!(live.len(), 4);

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(matches!(
            collect_report_positions(start_fen(), &moves, &cancelled),
            Err(Error::AnalysisCancelled)
        ));

        let during = CancellationToken::new();
        let cancel_at_last_ply = during.clone();
        // Cancel after the last ply is replayed so a check that only runs at
        // the next iteration cannot save the test.
        ANALYSIS_REPLAY_PLY_HOOK.with(|slot| {
            assert!(slot
                .replace(Some(Box::new(move |ply| {
                    if ply == 2 {
                        cancel_at_last_ply.cancel();
                    }
                })))
                .is_none());
        });
        let error = collect_report_positions(start_fen(), &moves, &during).unwrap_err();
        ANALYSIS_REPLAY_PLY_HOOK.with(|slot| {
            slot.replace(None);
        });
        assert!(matches!(error, Error::AnalysisCancelled));
    }

    #[tokio::test]
    async fn analyze_game_core_does_not_start_progress_when_already_cancelled() {
        let app = engine_test_app();
        let state = app.state::<AppState>().inner().clone();
        let id = "cancelled-before-admit";
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let error = analyze_game_core(
            id.into(),
            EngineHandle {
                id: crate::infra::path_authority::PathRef {
                    id: "missing-engine".into(),
                },
                kind: crate::infra::path_authority::EngineHandleKind::Engine,
            },
            "missing-engine".into(),
            GoMode::Depth(1),
            AnalysisOptions {
                fen: start_fen().to_string(),
                moves: vec!["e2e4".into(), "e7e5".into()],
                annotate_novelties: false,
                reference_db: None,
            },
            Vec::new(),
            state.clone(),
            app.clone(),
            cancellation,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, Error::AnalysisCancelled));
        assert!(state.progress_state.get(id).unwrap().is_none());
        assert!(state
            .engine_supervisor
            .get_exact(&EngineKey::new("analysis".into(), id.into()).unwrap())
            .is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn analyze_game_core_stops_during_replay_before_progress_or_spawn() {
        let (_directory, app, engine, _resource) = resource_engine_fixture();
        let state = app.state::<AppState>().inner().clone();
        let id = "cancel-during-replay";
        let cancellation = CancellationToken::new();
        let cancel_at_last_ply = cancellation.clone();
        ANALYSIS_REPLAY_PLY_HOOK.with(|slot| {
            assert!(slot
                .replace(Some(Box::new(move |ply| {
                    if ply == 2 {
                        cancel_at_last_ply.cancel();
                    }
                })))
                .is_none());
        });
        let error = analyze_game_core(
            id.into(),
            engine,
            "cancel-during-replay-engine".into(),
            GoMode::Depth(1),
            AnalysisOptions {
                fen: start_fen().to_string(),
                moves: ["e2e4", "e7e5", "g1f3"]
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
                annotate_novelties: false,
                reference_db: None,
            },
            Vec::new(),
            state.clone(),
            app.clone(),
            cancellation,
        )
        .await
        .unwrap_err();
        ANALYSIS_REPLAY_PLY_HOOK.with(|slot| {
            slot.replace(None);
        });
        assert!(matches!(error, Error::AnalysisCancelled));
        assert!(state.progress_state.get(id).unwrap().is_none());
        assert!(state
            .engine_supervisor
            .get_exact(&EngineKey::new("analysis".into(), id.into()).unwrap())
            .is_none());
    }

    /// Runs one report search from the start position against an engine that emits `lines` in
    /// order.
    async fn scripted_report_search(lines: &[&str]) -> Vec<BestMoves> {
        let (actor, _writes) = EngineActor::recording_test_actor(lines);
        let supervisor = Arc::new(crate::engine::EngineSupervisor::default());
        let key = EngineKey::new("analysis".into(), "scripted-report".into()).unwrap();
        let supervised = supervisor
            .replace_handle(
                key,
                actor.clone(),
                "engine".into(),
                crate::infra::path_authority::PathRef {
                    id: "engine-path".into(),
                },
            )
            .await
            .unwrap();
        let mut process = EngineProcess {
            base: actor.clone(),
            last_depth: 0,
            best_moves: Vec::new(),
            last_best_moves: Vec::new(),
            last_progress: 0.0,
            options: EngineOptions {
                fen: start_fen().to_string(),
                moves: Vec::new(),
                extra_options: Vec::new(),
            },
            resource_leases: Vec::new(),
            go_mode: GoMode::Depth(1),
            running: false,
            request_id: None,
            real_multipv: REPORT_MULTIPV,
            start: Instant::now(),
        };
        let best = analyze_position_with_owner(
            &mut process,
            &supervised,
            &CancellationToken::new(),
            &GoMode::Depth(1),
            &[],
        )
        .await
        .unwrap();
        actor.terminate().await.unwrap();
        best
    }

    fn line_summary(lines: &[BestMoves]) -> Vec<(u32, String)> {
        lines
            .iter()
            .map(|line| (line.depth, line.uci_moves[0].clone()))
            .collect()
    }

    #[tokio::test]
    async fn report_search_without_multipv_keeps_the_deepest_exact_first_line() {
        let best = scripted_report_search(&[
            "info depth 1 multipv 1 score cp 10 pv e2e4",
            "info depth 2 multipv 1 score cp 20 pv d2d4",
            "info depth 3 multipv 1 score cp 30 pv g1f3",
            "info depth 9 multipv 1 score cp 90 lowerbound pv c2c4",
            "bestmove g1f3",
        ])
        .await;
        assert_eq!(line_summary(&best), [(3, "g1f3".to_string())]);
    }

    #[tokio::test]
    async fn report_search_with_a_mixed_depth_pair_keeps_the_deepest_exact_first_line() {
        let best = scripted_report_search(&[
            "info depth 5 multipv 1 score cp 10 pv e2e4",
            "info depth 4 multipv 2 score cp 5 pv d2d4",
            "bestmove e2e4",
        ])
        .await;
        assert_eq!(line_summary(&best), [(5, "e2e4".to_string())]);
    }

    #[tokio::test]
    async fn report_search_publishes_a_complete_two_line_set() {
        let best = scripted_report_search(&[
            "info depth 2 multipv 1 score cp 10 pv e2e4",
            "info depth 2 multipv 2 score cp 5 pv d2d4",
            "info depth 3 multipv 1 score cp 12 pv c2c4",
            "bestmove e2e4",
        ])
        .await;
        assert_eq!(
            line_summary(&best),
            [(2, "e2e4".to_string()), (2, "d2d4".to_string())]
        );
    }

    #[tokio::test]
    async fn report_search_without_an_exact_line_has_no_evaluation() {
        let best = scripted_report_search(&[
            "info depth 3 multipv 1 score cp 30 upperbound pv e2e4",
            "bestmove e2e4",
        ])
        .await;
        assert!(best.is_empty());
    }

    #[tokio::test]
    async fn analysis_rechecks_owner_after_readyok_and_bestmove_dequeue() {
        let (actor, writes) = EngineActor::recording_test_actor(&["readyok"]);
        let supervised = SupervisedEngine::new(
            41,
            "engine".into(),
            crate::infra::path_authority::PathRef {
                id: "engine-path".into(),
            },
            actor.clone(),
            Arc::new(AtomicBool::new(false)),
        );
        let mut process = EngineProcess {
            base: actor.clone(),
            last_depth: 0,
            best_moves: Vec::new(),
            last_best_moves: Vec::new(),
            last_progress: 0.0,
            options: EngineOptions::default(),
            resource_leases: Vec::new(),
            go_mode: GoMode::Depth(1),
            running: false,
            request_id: None,
            real_multipv: 0,
            start: Instant::now(),
        };
        process
            .set_options(
                EngineOptions {
                    fen: start_fen().to_string(),
                    moves: Vec::new(),
                    extra_options: Vec::new(),
                },
                Vec::new(),
                None,
            )
            .await
            .unwrap();
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(matches!(
            analyze_position_with_owner(
                &mut process,
                &supervised,
                &cancellation,
                &GoMode::Depth(1),
                &[],
            )
            .await,
            Err(Error::AnalysisCancelled)
        ));
        assert!(!writes
            .lock()
            .await
            .iter()
            .any(|line| line.starts_with("go")));
        actor.terminate().await.unwrap();

        let (actor, writes) = EngineActor::recording_test_actor(&["bestmove e2e4"]);
        let supervisor = Arc::new(crate::engine::EngineSupervisor::default());
        let key = EngineKey::new("analysis".into(), "owned-sequence".into()).unwrap();
        let supervised = supervisor
            .replace_handle(
                key.clone(),
                actor.clone(),
                "engine".into(),
                crate::infra::path_authority::PathRef {
                    id: "engine-path".into(),
                },
            )
            .await
            .unwrap();
        let other_key = EngineKey::new("analysis".into(), "other-sequence".into()).unwrap();
        let (other_actor, _) = EngineActor::recording_test_actor(&[]);
        let other = supervisor
            .replace_handle(
                other_key.clone(),
                other_actor,
                "other-engine".into(),
                crate::infra::path_authority::PathRef {
                    id: "other-engine-path".into(),
                },
            )
            .await
            .unwrap();
        let mut process = EngineProcess {
            base: actor.clone(),
            last_depth: 0,
            best_moves: Vec::new(),
            last_best_moves: Vec::new(),
            last_progress: 0.0,
            options: EngineOptions::default(),
            resource_leases: Vec::new(),
            go_mode: GoMode::Depth(1),
            running: false,
            request_id: None,
            real_multipv: 1,
            start: Instant::now(),
        };
        let cancellation = CancellationToken::new();
        let cancel_at_dequeue = cancellation.clone();
        ANALYSIS_LINE_DEQUEUED_HOOK.with(|slot| {
            assert!(slot
                .replace(Some(Box::new(move |line| {
                    if matches!(parse_one(line), UciMessage::BestMove { .. }) {
                        cancel_at_dequeue.cancel();
                    }
                })))
                .is_none());
        });
        let error = analyze_position_with_owner(
            &mut process,
            &supervised,
            &cancellation,
            &GoMode::Depth(1),
            &[],
        )
        .await
        .unwrap_err();
        assert!(matches!(error, Error::AnalysisCancelled));
        assert!(writes.lock().await.iter().any(|line| line == "go depth 1"));

        let app = engine_test_app();
        let progress_state = crate::progress::ProgressStore::default();
        let progress = begin_progress(&progress_state, &app, "analysis-sequence".into()).unwrap();
        let error = finish_analysis_failure(
            Some(RegistrationGuard::new(
                supervisor.clone(),
                key.clone(),
                supervised.generation,
            )),
            &progress_state,
            &app,
            &progress,
            error,
        )
        .await;
        assert!(matches!(error, Error::AnalysisCancelled));
        assert!(supervisor.get_exact(&key).is_none());
        assert_eq!(
            supervisor.get_exact(&other_key).unwrap().generation,
            other.generation
        );
        supervisor
            .terminate_exact(&other_key, other.generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn finish_analysis_failure_retains_both_native_causes_and_safe_payload() {
        let app = engine_test_app();
        let supervisor = Arc::new(crate::engine::EngineSupervisor::default());
        let key = EngineKey::new("analysis-fold".into(), "engine".into()).unwrap();
        let actor = EngineActor::failing_terminate_test_actor("analysis-fold-cleanup-private-path");
        let owner = supervisor
            .replace_handle(
                key.clone(),
                actor,
                key.engine.clone(),
                crate::infra::path_authority::PathRef {
                    id: "binary".into(),
                },
            )
            .await
            .unwrap();
        let progress_state = crate::progress::ProgressStore::default();
        let progress = begin_progress(&progress_state, &app, "analysis-fold".into()).unwrap();
        let error = finish_analysis_failure(
            Some(RegistrationGuard::new(supervisor, key, owner.generation)),
            &progress_state,
            &app,
            &progress,
            std::io::Error::other("analysis-fold-primary-private-path").into(),
        )
        .await;
        let diagnostic = error.diagnostic();
        assert!(
            diagnostic.contains("analysis-fold-primary-private-path"),
            "{diagnostic}"
        );
        assert!(
            diagnostic.contains("analysis-fold-cleanup-private-path"),
            "{diagnostic}"
        );
        let payload = serde_json::to_value(&error).unwrap();
        assert_eq!(payload["category"], "operation-and-cleanup");
        assert_eq!(
            payload["message"],
            "Operation failed; temporary cleanup also failed"
        );
        assert!(!payload.to_string().contains("private-path"));
    }

    fn string_option(name: &str, value: &str) -> EngineOption {
        EngineOption::String {
            name: name.into(),
            value: value.into(),
        }
    }

    fn resolved_option(name: &str, value: &str) -> ResolvedEngineOption {
        ResolvedEngineOption {
            name: name.into(),
            value: value.into(),
            resources: Vec::new(),
            resource_values: Vec::new(),
        }
    }

    fn engine_test_app() -> tauri::AppHandle<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events!(
                BestMovesPayload,
                crate::progress::ProgressEvent
            ))
            .mount_events(&app);
        app.manage(AppState::default());
        app.handle().clone()
    }

    #[cfg(unix)]
    pub(super) fn resource_engine_fixture() -> (
        tempfile::TempDir,
        tauri::AppHandle<tauri::test::MockRuntime>,
        EngineHandle,
        crate::infra::path_authority::EngineResourceHandle,
    ) {
        resource_engine_fixture_with_quit(false)
    }

    #[cfg(unix)]
    fn resource_engine_fixture_with_quit(
        hold_quit: bool,
    ) -> (
        tempfile::TempDir,
        tauri::AppHandle<tauri::test::MockRuntime>,
        EngineHandle,
        crate::infra::path_authority::EngineResourceHandle,
    ) {
        use crate::infra::path_authority::{EngineResourceHandleKind, PathClass};

        let directory = tempfile::tempdir().unwrap();
        if hold_quit {
            std::fs::write(directory.path().join("hold-quit"), b"").unwrap();
        }
        let script = directory.path().join("resource-flow-engine.sh");
        crate::infra::test_executable::publish_test_executable(
            &script,
            r#"#!/bin/sh
capture="$PWD/capture.log"
printf 'pid=%s\n' "$$" >> "$capture"
while IFS= read -r line; do
    printf 'wire=%s\n' "$line" >> "$capture"
    case "$line" in
        uci)
            echo uciok
            ;;
        isready)
            if [ -f "$PWD/silent-ready" ]; then
                continue
            fi
            if [ -f "$PWD/slow-ready" ]; then
                sleep 0.2
            fi
            echo readyok
            ;;
        setoption\ name\ EvalFile\ value\ *)
            value=${line#*value }
            printf 'eval=%s\n' "$value" >> "$capture"
            if [ "$(cat "$value" 2>/dev/null)" = "resource-bytes" ]; then
                printf 'read=resource-bytes\n' >> "$capture"
            else
                printf 'read=unreadable\n' >> "$capture"
            fi
            child=
            case "$value" in
                /proc/self/fd/*)
                    for fd in /proc/$$/fd/[0-9]*; do
                        if [ -f "$fd" ] && [ "$(cat "$fd" 2>/dev/null)" = "resource-bytes" ]; then
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
            printf 'option=%s\n' "$line" >> "$capture"
            echo "$line"
            ;;
        go*)
            if [ -f "$PWD/fail-search" ]; then
                exit 0
            fi
            if [ -f "$PWD/illegal-pv" ]; then
                echo "info depth 1 multipv 1 score cp 12 nodes 1 pv e2e5"
                echo "info depth 2 multipv 1 score cp 15 nodes 2 pv d2d5"
                echo "bestmove e2e4"
                continue
            fi
            echo "info depth 1 multipv 1 score cp 12 nodes 1 pv e2e4"
            echo "info depth 1 multipv 2 score cp 8 nodes 1 pv d2d4"
            printf 'go-ready\n' >> "$capture"
            while [ ! -f "$PWD/release" ]; do
                sleep 0.01
            done
            echo "bestmove e2e4"
            ;;
        quit)
            if [ ! -f "$PWD/hold-quit" ]; then
                exit 0
            fi
            ;;
    esac
done
"#,
            0o700,
        )
        .unwrap();
        let resource_path = directory.path().join("weights.nnue");
        std::fs::write(&resource_path, b"resource-bytes").unwrap();

        let (mut authority, engine) =
            fixture_engine_authority(&directory, &script, "resource-flow-engine");
        let grant = authority
            .grant_dialog(
                &resource_path,
                "weights",
                PathClass::SingleDialogGrant,
                PathOperation::EngineResourceRead,
                std::time::Duration::from_secs(30),
                1,
            )
            .unwrap();
        let resource = authority
            .promote_engine_resource(&grant, EngineResourceHandleKind::File, "weights")
            .unwrap();

        let app = engine_test_app();
        app.state::<AppState>()
            .pgn_path_authority
            .install(authority)
            .unwrap();
        (directory, app, engine, resource)
    }

    #[cfg(unix)]
    fn fixture_engine_authority(
        directory: &tempfile::TempDir,
        script: &std::path::Path,
        label: &str,
    ) -> (crate::infra::path_authority::PathAuthority, EngineHandle) {
        #[cfg(target_os = "macos")]
        let mut authority = crate::infra::path_authority::PathAuthority::open_with_launch_root(
            directory.path().join("registry.json"),
            Vec::new(),
            crate::infra::path_authority::EngineLaunchRoot::for_test(directory.path()).unwrap(),
        )
        .unwrap();
        #[cfg(not(target_os = "macos"))]
        let mut authority = crate::infra::path_authority::PathAuthority::open(
            directory.path().join("registry.json"),
            Vec::new(),
        )
        .unwrap();
        let engine = authority.register_engine_file(script, label).unwrap();
        (authority, engine)
    }

    /// A UCI engine that answers each position from `responses` (`"<moves>|<info line>"`, the
    /// moves joined by spaces, empty for the root) and records every searched position as
    /// `searched=<moves>` in `capture.log`.
    #[cfg(unix)]
    fn report_script_fixture(
        responses: &[(&str, &str)],
    ) -> (
        tempfile::TempDir,
        tauri::AppHandle<tauri::test::MockRuntime>,
        EngineHandle,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let mut map = String::new();
        for (moves, info) in responses {
            map.push_str(&format!("{moves}|{info}\n"));
        }
        std::fs::write(directory.path().join("responses"), map).unwrap();
        let script = directory.path().join("report-order-engine.sh");
        crate::infra::test_executable::publish_test_executable(
            &script,
            r#"#!/bin/sh
capture="$PWD/capture.log"
key=
while IFS= read -r line; do
    case "$line" in
        uci)
            echo uciok
            ;;
        isready)
            echo readyok
            ;;
        position*)
            case "$line" in
                *" moves "*) key=${line#* moves } ;;
                *) key= ;;
            esac
            ;;
        go*)
            printf 'searched=%s\n' "$key" >> "$capture"
            awk -F'|' -v k="$key" '$1 == k { print $2 }' "$PWD/responses"
            echo "bestmove a1a1"
            ;;
        quit)
            printf 'wire=quit\n' >> "$capture"
            exit 0
            ;;
    esac
done
"#,
            0o700,
        )
        .unwrap();
        let (authority, engine) =
            fixture_engine_authority(&directory, &script, "report-order-engine");
        let app = engine_test_app();
        app.state::<AppState>()
            .pgn_path_authority
            .install(authority)
            .unwrap();
        (directory, app, engine)
    }

    #[cfg(unix)]
    fn searched_positions(directory: &tempfile::TempDir) -> Vec<String> {
        std::fs::read_to_string(directory.path().join("capture.log"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| line.strip_prefix("searched="))
            .map(str::to_string)
            .collect()
    }

    #[cfg(unix)]
    fn report_options(moves: &[&str]) -> AnalysisOptions {
        AnalysisOptions {
            fen: start_fen().to_string(),
            moves: moves.iter().map(|m| m.to_string()).collect(),
            annotate_novelties: false,
            reference_db: None,
        }
    }

    #[cfg(unix)]
    async fn run_scripted_report(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        engine: EngineHandle,
        id: &str,
        go_mode: GoMode,
        options: AnalysisOptions,
        cancellation: CancellationToken,
    ) -> Result<GameAnalysis, Error> {
        let state = app.state::<AppState>().inner().clone();
        analyze_game_core(
            id.into(),
            engine,
            format!("{id}-engine"),
            go_mode,
            options,
            Vec::new(),
            state,
            app.clone(),
            cancellation,
        )
        .await
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn report_searches_the_last_position_first_and_returns_game_order() {
        // Fool's mate: four moves, the final position is checkmate and never searched.
        let (directory, app, engine) = report_script_fixture(&[
            ("", "info depth 1 multipv 1 score cp 20 pv e2e4"),
            ("", "info depth 1 multipv 2 score cp 10 pv d2d4"),
            ("f2f3", "info depth 1 multipv 1 score cp 0 pv e7e5"),
            ("f2f3 e7e5", "info depth 1 multipv 1 score cp -60 pv d2d4"),
            (
                "f2f3 e7e5 g2g4",
                "info depth 1 multipv 1 score mate 1 pv d8h4",
            ),
        ]);
        let result = run_scripted_report(
            &app,
            engine,
            "report-order",
            GoMode::Depth(1),
            report_options(&["f2f3", "e7e5", "g2g4", "d8h4"]),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(
            searched_positions(&directory),
            ["f2f3 e7e5 g2g4", "f2f3 e7e5", "f2f3", ""],
            "backward pass, terminal position skipped"
        );
        assert_eq!(result.positions.len(), 5);
        assert_eq!(result.novelty, NoveltyOutcome::NotRequested);
        let first_moves: Vec<Option<&str>> = result
            .positions
            .iter()
            .map(|entry| entry.best.first().map(|line| line.uci_moves[0].as_str()))
            .collect();
        assert_eq!(
            first_moves,
            [Some("e2e4"), Some("e7e5"), Some("d2d4"), Some("d8h4"), None]
        );
        assert_eq!(result.positions[0].best.len(), 2);
        // Black to move after 1.f3: the engine's +0 stays 0, a mate for Black is White-relative.
        assert!(matches!(
            result.positions[3].best[0].score.value,
            ScoreValue::Mate(-1)
        ));
        let terminals: Vec<Option<ReportTerminal>> = result
            .positions
            .iter()
            .map(|entry| entry.terminal)
            .collect();
        assert_eq!(
            terminals,
            [None, None, None, None, Some(ReportTerminal::Checkmate)]
        );
        assert!(result.positions.iter().all(|entry| !entry.is_sacrifice));
        let progress = app
            .state::<AppState>()
            .progress_state
            .get("report-order")
            .unwrap()
            .unwrap();
        assert_eq!(progress.state, ProgressState::Succeeded);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn report_search_fallback_never_leaks_into_the_next_position() {
        // Searched first: the position after 1.e4 gets an exact line. Searched second: the root
        // gets none, so its evaluation stays empty.
        let (directory, app, engine) =
            report_script_fixture(&[("e2e4", "info depth 4 multipv 1 score cp 30 pv e7e5")]);
        let result = run_scripted_report(
            &app,
            engine,
            "report-no-leak",
            GoMode::Depth(1),
            report_options(&["e2e4"]),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(searched_positions(&directory), ["e2e4", ""]);
        assert_eq!(
            line_summary(&result.positions[1].best),
            [(4, "e7e5".to_string())]
        );
        assert!(result.positions[0].best.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn report_aligns_sacrifice_flags_with_their_positions() {
        // 1.e4 d5 2.Qh5 Nf6 3.Qxf7+: the queen takes a defended pawn on move five.
        let (directory, app, engine) = report_script_fixture(&[]);
        let result = run_scripted_report(
            &app,
            engine,
            "report-sacrifice",
            GoMode::Depth(1),
            report_options(&["e2e4", "d7d5", "d1h5", "g8f6", "h5f7"]),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let flags: Vec<bool> = result
            .positions
            .iter()
            .map(|entry| entry.is_sacrifice)
            .collect();
        assert_eq!(flags, [false, false, false, false, false, true]);
        assert_eq!(searched_positions(&directory).len(), 6);
        assert!(result.positions.iter().all(|entry| entry.best.is_empty()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn report_never_searches_stalemate_or_bare_kings() {
        let stalemate_root = "7k/8/7K/5Q2/8/8/8/8 w - - 0 1";
        let (directory, app, engine) = report_script_fixture(&[]);
        let mut options = report_options(&["f5f7"]);
        options.fen = stalemate_root.into();
        let result = run_scripted_report(
            &app,
            engine.clone(),
            "report-stalemate",
            GoMode::Depth(1),
            options,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(result.positions.len(), 2);
        assert_eq!(result.positions[1].terminal, Some(ReportTerminal::Draw));
        assert_eq!(searched_positions(&directory), [""]);

        let (directory, app, engine) = report_script_fixture(&[]);
        let mut options = report_options(&["d3d2", "d5e4"]);
        options.fen = "8/8/8/3k4/8/3K4/3q4/8 w - - 0 1".into();
        let result = run_scripted_report(
            &app,
            engine,
            "report-bare-kings",
            GoMode::Depth(1),
            options,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(result.positions.len(), 3);
        assert_eq!(result.positions[1].terminal, Some(ReportTerminal::Draw));
        assert_eq!(result.positions[2].terminal, Some(ReportTerminal::Draw));
        assert_eq!(searched_positions(&directory), [""]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn report_refuses_unbounded_limits_before_progress_or_admission() {
        for (index, go_mode) in [
            GoMode::Infinite,
            GoMode::PlayersTime(crate::engine::PlayersTime {
                white: 1000,
                black: 1000,
                winc: 0,
                binc: 0,
            }),
        ]
        .into_iter()
        .enumerate()
        {
            let (directory, app, engine) = report_script_fixture(&[]);
            let id = format!("report-unbounded-{index}");
            let result = run_scripted_report(
                &app,
                engine,
                &id,
                go_mode,
                report_options(&["e2e4"]),
                CancellationToken::new(),
            )
            .await;
            assert!(matches!(result, Err(Error::InvalidInput(_))), "{result:?}");
            let state = app.state::<AppState>();
            assert!(state.progress_state.get(&id).unwrap().is_none());
            assert!(state
                .engine_supervisor
                .get_exact(&EngineKey::new("analysis".into(), id.clone()).unwrap())
                .is_none());
            assert!(!directory.path().join("capture.log").exists());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn report_novelty_failures_after_the_pass_keep_the_engine_results() {
        let reference = DatabaseHandle {
            id: crate::infra::path_authority::PathRef {
                id: "no-such-reference".into(),
            },
            kind: crate::infra::path_authority::DatabaseHandleKind::Database,
        };
        // A reference that does not resolve: the lookup itself fails.
        let (_directory, app, engine) =
            report_script_fixture(&[("", "info depth 1 multipv 1 score cp 20 pv e2e4")]);
        let mut options = report_options(&["e2e4"]);
        options.annotate_novelties = true;
        options.reference_db = Some(reference.clone());
        let result = run_scripted_report(
            &app,
            engine,
            "report-novelty-lookup",
            GoMode::Depth(1),
            options,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(result.novelty, NoveltyOutcome::Unavailable);
        assert_eq!(result.positions[0].best.len(), 1);

        // The position-search permit cannot be acquired.
        let (_directory, app, engine) =
            report_script_fixture(&[("", "info depth 1 multipv 1 score cp 20 pv e2e4")]);
        app.state::<AppState>().new_request.close();
        let mut options = report_options(&["e2e4"]);
        options.annotate_novelties = true;
        options.reference_db = Some(reference);
        let result = run_scripted_report(
            &app,
            engine,
            "report-novelty-permit",
            GoMode::Depth(1),
            options,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(result.novelty, NoveltyOutcome::Unavailable);
        assert_eq!(result.positions[0].best.len(), 1);
        let progress = app
            .state::<AppState>()
            .progress_state
            .get("report-novelty-permit")
            .unwrap()
            .unwrap();
        assert_eq!(progress.state, ProgressState::Succeeded);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn report_novelty_excludes_analysed_games_own_copy_in_reference_db() {
        let game_g = "[Event \"Game G\"]\n[Site \"Fixture\"]\n[White \"A\"]\n[Black \"B\"]\n[Result \"1-0\"]\n\n1. e4 e5 2. Nf3 Nc6 1-0\n";
        let shared_first_move = "[Event \"Game H\"]\n[Site \"Fixture\"]\n[White \"C\"]\n[Black \"D\"]\n[Result \"0-1\"]\n\n1. e4 c5 2. Nf3 d6 0-1\n";

        // Reference database holds only G: novelty is the first move (position 1).
        let (directory, app, engine) = report_script_fixture(&[]);
        let (reference_only_g, _) =
            crate::db::import_pgn_into_app_database(&app, directory.path(), "only-g", game_g);
        let mut options = report_options(&["e2e4", "e7e5", "g1f3", "b8c6"]);
        options.annotate_novelties = true;
        options.reference_db = Some(reference_only_g);
        let result = run_scripted_report(
            &app,
            engine,
            "report-novelty-self-only",
            GoMode::Depth(1),
            options,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(result.novelty, NoveltyOutcome::Found { position: 1 });

        // Reference database holds G and a second game sharing G's first move: novelty is move 2 (position 2).
        let (directory, app, engine) = report_script_fixture(&[]);
        let (reference_with_other, _) = crate::db::import_pgn_into_app_database(
            &app,
            directory.path(),
            "g-and-h",
            &format!("{game_g}\n{shared_first_move}"),
        );
        let mut options = report_options(&["e2e4", "e7e5", "g1f3", "b8c6"]);
        options.annotate_novelties = true;
        options.reference_db = Some(reference_with_other);
        let result = run_scripted_report(
            &app,
            engine,
            "report-novelty-self-and-other",
            GoMode::Depth(1),
            options,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(result.novelty, NoveltyOutcome::Found { position: 2 });
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn report_cancelled_while_waiting_for_the_novelty_permit_is_cancelled() {
        let (directory, app, engine) = report_script_fixture(&[]);
        let state = app.state::<AppState>().inner().clone();
        let held = state
            .new_request
            .clone()
            .acquire_many_owned(2)
            .await
            .unwrap();
        let cancellation = CancellationToken::new();
        let mut options = report_options(&["e2e4"]);
        options.annotate_novelties = true;
        options.reference_db = Some(DatabaseHandle {
            id: crate::infra::path_authority::PathRef {
                id: "held-reference".into(),
            },
            kind: crate::infra::path_authority::DatabaseHandleKind::Database,
        });
        let core = tokio::spawn({
            let app = app.clone();
            let cancellation = cancellation.clone();
            async move {
                run_scripted_report(
                    &app,
                    engine,
                    "report-novelty-cancel",
                    GoMode::Depth(1),
                    options,
                    cancellation,
                )
                .await
            }
        });
        wait_for_fixture_capture(&directory, "wire=quit").await;
        cancellation.cancel();
        let result = core.await.unwrap();
        drop(held);
        assert!(
            matches!(result, Err(Error::AnalysisCancelled)),
            "{result:?}"
        );
        let progress = state
            .progress_state
            .get("report-novelty-cancel")
            .unwrap()
            .unwrap();
        assert_eq!(progress.state, ProgressState::Cancelled);
    }

    #[cfg(unix)]
    async fn wait_for_fixture_capture(directory: &tempfile::TempDir, marker: &str) {
        observe_fixture_capture(directory, marker)
            .await
            .expect("fixture must reach the requested wire barrier");
    }

    #[cfg(unix)]
    async fn observe_fixture_capture(
        directory: &tempfile::TempDir,
        marker: &str,
    ) -> Result<(), tokio::time::error::Elapsed> {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let capture = std::fs::read_to_string(directory.path().join("capture.log"))
                    .unwrap_or_default();
                if capture.lines().any(|line| line == marker) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
    }

    #[cfg(unix)]
    async fn assert_abandoned_engine_removed(
        directory: &tempfile::TempDir,
        supervisor: &crate::engine::EngineSupervisor,
        tab: &str,
        key: Option<&EngineKey>,
    ) {
        let capture = std::fs::read_to_string(directory.path().join("capture.log")).unwrap();
        let pid: libc::pid_t = capture
            .lines()
            .find_map(|line| line.strip_prefix("pid="))
            .unwrap()
            .parse()
            .unwrap();
        let removed = tokio::time::timeout(Duration::from_secs(12), async {
            loop {
                let registered = key.map_or_else(
                    || !supervisor.owned_keys_for_tab(tab).is_empty(),
                    |key| supervisor.owned_keys_for_tab(tab).contains(key),
                );
                // Signal zero only observes the fixture process; it sends no signal.
                let alive = unsafe { libc::kill(pid, 0) } == 0;
                if !registered && !alive {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        // Keep a failing regression run from leaving its child registered.
        if removed.is_err() {
            supervisor.terminate_all().await.unwrap();
        }
        assert!(
            removed.is_ok(),
            "aborted future left its generation registered or child alive"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn config_probe_abort_during_termination_removes_generation() {
        let (directory, app, engine, _) = resource_engine_fixture_with_quit(true);
        let state = app.state::<AppState>().inner().clone();
        let supervisor = state.engine_supervisor.clone();
        let probe = tokio::spawn(async move { get_engine_config_core(engine, &state).await });
        wait_for_fixture_capture(&directory, "wire=quit").await;
        assert_eq!(supervisor.owned_keys_for_tab("engine-config").len(), 1);
        probe.abort();
        assert!(probe.await.unwrap_err().is_cancelled());
        assert_abandoned_engine_removed(&directory, &supervisor, "engine-config", None).await;
    }

    #[cfg(unix)]
    async fn assert_report_abort_removes_generation(id: &str, barrier: &str, fail: bool) {
        let (directory, app, engine, _) = resource_engine_fixture_with_quit(barrier == "wire=quit");
        let state = app.state::<AppState>().inner().clone();
        let supervisor = state.engine_supervisor.clone();
        let key = EngineKey::new("analysis".into(), id.into()).unwrap();
        let other_key = EngineKey::new("other-tab".into(), id.into()).unwrap();
        let (other_actor, _) = EngineActor::recording_test_actor(&[]);
        let other = supervisor
            .replace_handle(
                other_key.clone(),
                other_actor,
                "other-engine".into(),
                crate::infra::path_authority::PathRef {
                    id: "other-path".into(),
                },
            )
            .await
            .unwrap();
        let cancellation = CancellationToken::new();
        let core = tokio::spawn({
            let id = id.to_string();
            let cancellation = cancellation.clone();
            async move {
                analyze_game_core(
                    id,
                    engine,
                    "report-engine".into(),
                    GoMode::Depth(1),
                    AnalysisOptions {
                        fen: start_fen().to_string(),
                        moves: Vec::new(),
                        annotate_novelties: false,
                        reference_db: None,
                    },
                    Vec::new(),
                    state,
                    app,
                    cancellation,
                )
                .await
            }
        });
        wait_for_fixture_capture(&directory, "go-ready").await;
        if fail {
            cancellation.cancel();
        }
        if barrier == "wire=quit" {
            std::fs::write(directory.path().join("release"), b"").unwrap();
            wait_for_fixture_capture(&directory, barrier).await;
        }
        assert!(supervisor.owned_keys_for_tab("analysis").contains(&key));
        core.abort();
        assert!(core.await.unwrap_err().is_cancelled());
        // Let the shell read termination commands after the mid-search abort.
        std::fs::write(directory.path().join("release"), b"").unwrap();
        assert_abandoned_engine_removed(&directory, &supervisor, "analysis", Some(&key)).await;
        assert_eq!(
            supervisor.get_exact(&other_key).unwrap().generation,
            other.generation
        );
        supervisor
            .terminate_exact(&other_key, other.generation)
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn report_abort_mid_search_removes_generation() {
        assert_report_abort_removes_generation("abort-search", "go-ready", false).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn report_abort_during_success_termination_removes_generation() {
        assert_report_abort_removes_generation("abort-success", "wire=quit", false).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn report_abort_during_failure_termination_removes_generation() {
        assert_report_abort_removes_generation("abort-failure", "wire=quit", true).await;
    }

    #[cfg(unix)]
    fn assert_safe_resource_logs(logs: &[EngineLog]) {
        assert!(logs.iter().any(|entry| matches!(
            entry,
            EngineLog::Gui(line) if line == "setoption name EvalFile value [redacted]\n"
        )));
        assert!(logs.iter().any(|entry| matches!(
            entry,
            EngineLog::Engine(line) if line == "setoption name EvalFile value [redacted]"
        )));
        assert!(logs.iter().all(|entry| match entry {
            EngineLog::Gui(line) | EngineLog::Engine(line) => {
                !line.contains("/proc/self/fd/") && !line.contains("resource-bytes")
            }
            EngineLog::Truncated { .. } => true,
        }));
    }

    #[cfg(unix)]
    fn assert_resource_wire_capture(directory: &tempfile::TempDir, expected: &str) {
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
            assert!(eval.contains("engine-launch"));
        }
        assert_eq!(
            eval, child,
            "the wire value must be the authorized resource value"
        );
        assert_eq!(
            read, expected,
            "the child must read bytes through the wire value"
        );
    }

    #[cfg(unix)]
    async fn collect_barriered_resource_logs<T: Send>(
        directory: &tempfile::TempDir,
        supervisor: &Arc<EngineSupervisor>,
        key: &EngineKey,
        core: tokio::task::JoinHandle<T>,
    ) -> (Vec<EngineLog>, T) {
        let mut core = core;
        let ready = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let capture = std::fs::read_to_string(directory.path().join("capture.log"))
                    .unwrap_or_default();
                if capture.lines().any(|line| line == "go-ready")
                    && supervisor.get_exact(key).is_some()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        if ready.is_err() {
            let _ = std::fs::write(directory.path().join("release"), b"");
            let _ = tokio::time::timeout(Duration::from_secs(10), &mut core).await;
            panic!("resource engine did not reach its log barrier");
        }

        let logs_result = get_engine_logs_from_supervisor(supervisor, key).await;
        std::fs::write(directory.path().join("release"), b"").unwrap();
        let result = tokio::time::timeout(Duration::from_secs(10), core)
            .await
            .expect("resource core cleanup must finish")
            .expect("resource core task must finish");
        (
            logs_result.expect("active resource log query must succeed"),
            result,
        )
    }

    #[tokio::test]
    async fn stop_engine_command_forwards_qualified_and_broad_generations() {
        let app = engine_test_app();
        let state = app.state::<AppState>();
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let executable = crate::infra::path_authority::PathRef {
            id: "engine-path".into(),
        };

        let (old_actor, _) = EngineActor::recording_test_actor(&[]);
        let old = state
            .engine_supervisor
            .replace_handle(key.clone(), old_actor, "engine".into(), executable.clone())
            .await
            .unwrap();
        let (replacement_actor, _) = EngineActor::recording_test_actor(&[]);
        let replacement = state
            .engine_supervisor
            .replace_handle(
                key.clone(),
                replacement_actor,
                "engine".into(),
                executable.clone(),
            )
            .await
            .unwrap();

        stop_engine(
            "engine".into(),
            "tab".into(),
            Some(old.generation.to_string()),
            app.state(),
        )
        .await
        .unwrap();
        assert_eq!(
            state.engine_supervisor.get_exact(&key).unwrap().generation,
            replacement.generation
        );

        stop_engine(
            "engine".into(),
            "tab".into(),
            Some(replacement.generation.to_string()),
            app.state(),
        )
        .await
        .unwrap();
        assert!(state.engine_supervisor.get_exact(&key).is_none());

        let (broad_actor, _) = EngineActor::recording_test_actor(&[]);
        let broad = state
            .engine_supervisor
            .replace_handle(key.clone(), broad_actor, "engine".into(), executable)
            .await
            .unwrap();
        assert!(matches!(
            stop_engine(
                "engine".into(),
                "tab".into(),
                Some("not-a-generation".into()),
                app.state(),
            )
            .await,
            Err(Error::InvalidInput(message)) if message == "invalid engine generation"
        ));
        assert_eq!(
            state.engine_supervisor.get_exact(&key).unwrap().generation,
            broad.generation
        );

        stop_engine("engine".into(), "tab".into(), None, app.state())
            .await
            .unwrap();
        assert!(state.engine_supervisor.get_exact(&key).is_none());
    }

    struct InteractiveSearchProbe {
        app: tauri::AppHandle<tauri::test::MockRuntime>,
        emitted: Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
        actor: Arc<EngineActor>,
        supervised: SupervisedEngine,
        process: EngineProcess,
        generation: u64,
    }

    async fn interactive_search_probe(lines: &[&str], cancelled: bool) -> InteractiveSearchProbe {
        let app = engine_test_app();
        let emitted = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = emitted.clone();
        app.listen(BestMovesPayload::NAME, move |event| {
            observed
                .lock()
                .unwrap()
                .push(serde_json::from_str::<serde_json::Value>(event.payload()).unwrap());
        });

        let (actor, _) = EngineActor::recording_test_actor(lines);
        let request_id = actor.start_search(&GoMode::Depth(16)).await.unwrap();
        let generation = 9_007_199_254_740_993;
        InteractiveSearchProbe {
            app,
            emitted,
            actor: actor.clone(),
            supervised: SupervisedEngine::new(
                generation,
                "engine".into(),
                crate::infra::path_authority::PathRef {
                    id: "engine-path".into(),
                },
                actor.clone(),
                Arc::new(AtomicBool::new(cancelled)),
            ),
            process: EngineProcess {
                base: actor,
                last_depth: 0,
                best_moves: Vec::new(),
                last_best_moves: Vec::new(),
                last_progress: 0.0,
                options: EngineOptions {
                    fen: start_fen().to_string(),
                    moves: Vec::new(),
                    extra_options: Vec::new(),
                },
                resource_leases: Vec::new(),
                go_mode: GoMode::Depth(16),
                running: true,
                request_id: Some(request_id),
                real_multipv: 1,
                start: Instant::now(),
            },
            generation,
        }
    }

    const INTERACTIVE_SEARCH_LINES: [&str; 2] = [
        "info depth 8 multipv 1 score cp 34 nodes 100 pv e2e4",
        "bestmove e2e4",
    ];

    #[tokio::test]
    async fn interactive_terminal_payload_retains_deepest_set_when_intermediate_events_are_throttled(
    ) {
        let mut lines = (1..=12)
            .flat_map(|depth| {
                [
                    format!("info depth {depth} multipv 1 score cp {depth} nodes {depth} pv e2e4"),
                    format!("info depth {depth} multipv 2 score cp {depth} nodes {depth} pv d2d4"),
                ]
            })
            .collect::<Vec<_>>();
        lines.push("bestmove e2e4".into());
        let borrowed = lines.iter().map(String::as_str).collect::<Vec<_>>();
        let mut probe = interactive_search_probe(&borrowed, false).await;
        probe.process.real_multipv = 2;
        process_interactive_search_output(
            &mut probe.process,
            "engine",
            "tab",
            &probe.supervised,
            &probe.app,
        )
        .await
        .unwrap();
        {
            let payloads = probe.emitted.lock().unwrap();
            assert!(
                payloads.len() < 13,
                "intermediate emissions must be throttled"
            );
            let terminal = payloads.last().unwrap();
            assert_eq!(terminal["progress"], 100.0);
            assert_eq!(terminal["bestLines"].as_array().unwrap().len(), 2);
            assert_eq!(terminal["bestLines"][0]["depth"], 12);
            assert_eq!(terminal["bestLines"][1]["depth"], 12);
        }
        assert_eq!(probe.process.last_depth, 12);
        probe.actor.terminate().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn interactive_illegal_pvs_return_typed_error_without_empty_terminal_payload() {
        let (directory, app, engine, _) = resource_engine_fixture();
        std::fs::write(directory.path().join("illegal-pv"), b"").unwrap();
        let emitted = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = emitted.clone();
        app.listen(BestMovesPayload::NAME, move |event| {
            observed.lock().unwrap().push(event.payload().to_string());
        });
        let key = EngineKey::new("illegal-pvs".into(), "id".into()).unwrap();
        let result = run_warm_fixture_search(&app, &key, engine, Vec::new()).await;
        assert!(matches!(result, Err(Error::IllegalUciMove(_))));
        assert!(emitted.lock().unwrap().is_empty());
        assert!(app
            .state::<AppState>()
            .engine_supervisor
            .get_exact(&key)
            .is_none());
    }

    #[tokio::test]
    async fn interactive_parse_error_with_a_usable_set_still_publishes_terminal_lines() {
        let mut probe = interactive_search_probe(
            &[
                "info depth 7 multipv 1 score cp 12 pv e2e5",
                INTERACTIVE_SEARCH_LINES[0],
                INTERACTIVE_SEARCH_LINES[1],
            ],
            false,
        )
        .await;
        process_interactive_search_output(
            &mut probe.process,
            "engine",
            "tab",
            &probe.supervised,
            &probe.app,
        )
        .await
        .unwrap();
        {
            let payloads = probe.emitted.lock().unwrap();
            assert_eq!(payloads.len(), 2);
            assert_eq!(payloads[1]["bestLines"][0]["depth"], 8);
            assert_eq!(payloads[1]["progress"], 100.0);
        }
        probe.actor.terminate().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_best_moves_command_releases_exact_owner_and_preserves_successor() {
        for successor in [false, true] {
            let app = engine_test_app();
            let state = app.state::<AppState>().inner().clone();
            let supervisor = state.engine_supervisor.clone();
            let key =
                EngineKey::new(format!("command-abort-{successor}"), "engine".into()).unwrap();
            let engine = EngineHandle {
                id: crate::infra::path_authority::PathRef {
                    id: "binary".into(),
                },
                kind: crate::infra::path_authority::EngineHandleKind::Engine,
            };
            let (actor, _) = EngineActor::recording_test_actor(&[
                "uciok",
                "readyok",
                "readyok",
                INTERACTIVE_SEARCH_LINES[0],
                "bestmove e2e4",
                "readyok",
                INTERACTIVE_SEARCH_LINES[0],
                "bestmove e2e4",
            ]);
            let warm = WarmEngine::new(actor.clone(), Vec::new(), &AtomicBool::new(false))
                .await
                .unwrap();
            let original = supervisor
                .replace_handle(key.clone(), actor, key.engine.clone(), engine.id.clone())
                .await
                .unwrap();
            *original.interactive.lock().await = Some(warm);
            let other_key = EngineKey::new(key.tab.clone(), "unrelated".into()).unwrap();
            let (other_actor, _) = EngineActor::recording_test_actor(&[]);
            let other = supervisor
                .replace_handle(
                    other_key.clone(),
                    other_actor.clone(),
                    other_key.engine.clone(),
                    engine.id.clone(),
                )
                .await
                .unwrap();
            let (entered, pending) = tokio::sync::oneshot::channel();
            INTERACTIVE_LINE_DEQUEUED_HOOK.with(|slot| {
                assert!(slot
                    .replace(Some(Box::new(move || Box::pin(async move {
                        entered.send(()).unwrap();
                        std::future::pending::<()>().await;
                    }))))
                    .is_none());
            });
            let generation = supervisor
                .prepare_engine_search(key.clone(), key.engine.clone(), engine.id.clone())
                .await
                .unwrap();
            let command = tokio::spawn({
                let state = state.clone();
                let app = app.clone();
                let engine = engine.clone();
                let key = key.clone();
                async move {
                    get_best_moves_core(
                        key.engine,
                        engine,
                        key.tab,
                        GoMode::Depth(16),
                        EngineOptions {
                            fen: start_fen().to_string(),
                            ..EngineOptions::default()
                        },
                        generation,
                        app,
                        state,
                    )
                    .await
                }
            });
            tokio::time::timeout(Duration::from_secs(2), pending)
                .await
                .unwrap()
                .unwrap();
            let owner = supervisor.get_exact(&key).unwrap();
            let owned_search = owner.current_search().unwrap();
            assert_eq!(
                owner.generation, original.generation,
                "warm search reuses the published actor"
            );
            assert!(owned_search.generation > original.generation);
            let replacement = if successor {
                let generation = supervisor
                    .prepare_engine_search(key.clone(), key.engine.clone(), engine.id.clone())
                    .await
                    .unwrap();
                let admission = supervisor
                    .consume_engine_search(
                        key.clone(),
                        key.engine.clone(),
                        engine.id.clone(),
                        &generation,
                    )
                    .await
                    .unwrap();
                Some(
                    supervisor
                        .start_interactive_search(
                            key.clone(),
                            engine,
                            state.pgn_path_authority.clone(),
                            admission,
                            EngineOptions {
                                fen: start_fen().to_string(),
                                ..EngineOptions::default()
                            },
                            &GoMode::Depth(16),
                        )
                        .await
                        .unwrap(),
                )
            } else {
                None
            };
            command.abort();
            assert!(command.await.unwrap_err().is_cancelled());
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let completed = crate::engine::REGISTRATION_GUARD_DROPS
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|(dropped_key, generation, completed)| {
                            dropped_key == &key
                                && *generation == owned_search.generation
                                && *completed
                        });
                    if completed {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("cancelled command's exact guard cleanup completes");
            assert_eq!(
                supervisor.get_exact(&other_key).unwrap().generation,
                other.generation
            );
            other_actor.logs().await.unwrap();
            assert!(owned_search.cancelled.load(Ordering::SeqCst));
            if let Some((mut process, replacement, search)) = replacement {
                assert_eq!(
                    supervisor.get_exact(&key).unwrap().generation,
                    replacement.generation
                );
                assert!(search.generation > owned_search.generation);
                assert!(!search.cancelled.load(Ordering::SeqCst));
                process_interactive_search_output(
                    &mut process,
                    &key.engine,
                    &key.tab,
                    &replacement,
                    &app,
                )
                .await
                .unwrap();
                assert_eq!(
                    supervisor.get_exact(&key).unwrap().generation,
                    replacement.generation,
                    "successful successor stays warm"
                );
            } else {
                assert!(supervisor.get_exact(&key).is_none());
                assert!(
                    owner.actor.logs().await.is_err(),
                    "cancelled command's actor is reaped"
                );
            }
            supervisor.terminate_all().await.unwrap();
        }
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn production_warm_handoff_suppresses_dequeued_info_and_terminal_payloads() {
        for held_terminal in [false, true] {
            let app = engine_test_app();
            let state = app.state::<AppState>().inner().clone();
            let supervisor = state.engine_supervisor.clone();
            let key = EngineKey::new("production-handoff".into(), "id".into()).unwrap();
            let engine = EngineHandle {
                id: crate::infra::path_authority::PathRef {
                    id: "binary".into(),
                },
                kind: crate::infra::path_authority::EngineHandleKind::Engine,
            };
            let mut lines = vec!["uciok", "readyok", "readyok"];
            if !held_terminal {
                lines.push(INTERACTIVE_SEARCH_LINES[0]);
            }
            lines.extend([
                "bestmove e2e4",
                "readyok",
                INTERACTIVE_SEARCH_LINES[0],
                "bestmove e2e4",
            ]);
            let (actor, _) = EngineActor::recording_test_actor(&lines);
            let warm = WarmEngine::new(actor.clone(), Vec::new(), &AtomicBool::new(false))
                .await
                .unwrap();
            let current = supervisor
                .replace_handle(key.clone(), actor, key.engine.clone(), engine.id.clone())
                .await
                .unwrap();
            *current.interactive.lock().await = Some(warm);
            let payloads = Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
            let observed = payloads.clone();
            app.listen(BestMovesPayload::NAME, move |event| {
                observed
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str(event.payload()).unwrap());
            });
            let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
            let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
            INTERACTIVE_LINE_DEQUEUED_HOOK.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(move || {
                    Box::pin(async move {
                        entered_tx.send(()).unwrap();
                        resume_rx.await.unwrap();
                    })
                }));
            });
            let generation_a = supervisor
                .prepare_engine_search(key.clone(), key.engine.clone(), engine.id.clone())
                .await
                .unwrap();
            let a_state = state.clone();
            let a_app = app.clone();
            let a_engine = engine.clone();
            let a_key = key.clone();
            let a = tokio::spawn(async move {
                get_best_moves_core(
                    a_key.engine,
                    a_engine,
                    a_key.tab,
                    GoMode::Depth(16),
                    EngineOptions {
                        fen: start_fen().to_string(),
                        ..EngineOptions::default()
                    },
                    generation_a,
                    a_app,
                    a_state,
                )
                .await
            });
            tokio::time::timeout(Duration::from_secs(1), entered_rx)
                .await
                .unwrap()
                .unwrap();
            let generation_b = supervisor
                .prepare_engine_search(key.clone(), key.engine.clone(), engine.id.clone())
                .await
                .unwrap();
            let admission = supervisor
                .consume_engine_search(
                    key.clone(),
                    key.engine.clone(),
                    engine.id.clone(),
                    &generation_b,
                )
                .await
                .unwrap();
            let (mut b_process, b_owner, _) = supervisor
                .start_interactive_search(
                    key.clone(),
                    engine,
                    state.pgn_path_authority.clone(),
                    admission,
                    EngineOptions {
                        fen: start_fen().to_string(),
                        ..EngineOptions::default()
                    },
                    &GoMode::Depth(16),
                )
                .await
                .unwrap();
            resume_tx.send(()).unwrap();
            let a_result = tokio::time::timeout(Duration::from_secs(1), a)
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(a_result, Err(Error::Cancellation)));
            assert!(
                payloads.lock().unwrap().is_empty(),
                "A's dequeued payload escaped after B started (terminal={held_terminal})"
            );
            process_interactive_search_output(
                &mut b_process,
                &key.engine,
                &key.tab,
                &b_owner,
                &app,
            )
            .await
            .unwrap();
            {
                let payloads = payloads.lock().unwrap();
                assert_eq!(payloads.len(), 2);
                assert!(payloads
                    .iter()
                    .all(|payload| payload["generation"] == generation_b));
                assert_eq!(payloads[1]["progress"], 100.0);
            }
            supervisor.terminate_all().await.unwrap();
        }
    }

    #[tokio::test]
    async fn interactive_producer_emits_supervised_generation_for_info_and_terminal_payloads() {
        let mut probe = interactive_search_probe(&INTERACTIVE_SEARCH_LINES, false).await;

        process_interactive_search_output(
            &mut probe.process,
            "engine",
            "tab",
            &probe.supervised,
            &probe.app,
        )
        .await
        .unwrap();

        {
            let payloads = probe.emitted.lock().unwrap();
            assert_eq!(payloads.len(), 2);
            assert_eq!(payloads[0]["progress"], 50.0);
            assert_eq!(payloads[0]["generation"], probe.generation.to_string());
            assert_eq!(payloads[1]["progress"], 100.0);
            assert_eq!(payloads[1]["generation"], probe.generation.to_string());
        }
        probe.actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn interactive_producer_skips_payloads_when_search_already_cancelled() {
        let mut probe = interactive_search_probe(&INTERACTIVE_SEARCH_LINES, true).await;

        process_interactive_search_output(
            &mut probe.process,
            "engine",
            "tab",
            &probe.supervised,
            &probe.app,
        )
        .await
        .unwrap();

        assert!(probe.emitted.lock().unwrap().is_empty());
        assert_eq!(probe.process.last_progress, 0.0);
        probe.actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn interactive_producer_skips_payloads_when_cancelled_after_dequeued_info() {
        let mut probe = interactive_search_probe(&INTERACTIVE_SEARCH_LINES, false).await;
        let cancelled = probe.supervised.cancelled.clone();
        ANALYSIS_LINE_DEQUEUED_HOOK.with(|slot| {
            assert!(slot
                .replace(Some(Box::new(move |line| {
                    if line.starts_with("info ") {
                        cancelled.store(true, Ordering::SeqCst);
                    }
                })))
                .is_none());
        });

        process_interactive_search_output(
            &mut probe.process,
            "engine",
            "tab",
            &probe.supervised,
            &probe.app,
        )
        .await
        .unwrap();

        assert!(probe.emitted.lock().unwrap().is_empty());
        assert_eq!(probe.process.last_progress, 0.0);
        ANALYSIS_LINE_DEQUEUED_HOOK.with(|slot| {
            slot.replace(None);
        });
        probe.actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn interactive_producer_skips_terminal_payload_when_cancelled_after_dequeued_bestmove() {
        let mut probe = interactive_search_probe(&INTERACTIVE_SEARCH_LINES, false).await;
        let cancelled = probe.supervised.cancelled.clone();
        ANALYSIS_LINE_DEQUEUED_HOOK.with(|slot| {
            assert!(slot
                .replace(Some(Box::new(move |line| {
                    if matches!(parse_one(line), UciMessage::BestMove { .. }) {
                        cancelled.store(true, Ordering::SeqCst);
                    }
                })))
                .is_none());
        });

        process_interactive_search_output(
            &mut probe.process,
            "engine",
            "tab",
            &probe.supervised,
            &probe.app,
        )
        .await
        .unwrap();

        {
            let payloads = probe.emitted.lock().unwrap();
            assert_eq!(payloads.len(), 1);
            assert_eq!(payloads[0]["progress"], 50.0);
            assert_eq!(payloads[0]["generation"], probe.generation.to_string());
        }
        assert_eq!(probe.process.last_progress, 50.0);
        ANALYSIS_LINE_DEQUEUED_HOOK.with(|slot| {
            slot.replace(None);
        });
        probe.actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn kill_engine_command_cancels_reserved_generation() {
        let app = engine_test_app();
        let state = app.state::<AppState>();
        let key = EngineKey::new("kill-command".into(), "engine".into()).unwrap();
        let engine = EngineHandle {
            id: crate::infra::path_authority::PathRef {
                id: "kill-command-image".into(),
            },
            kind: crate::infra::path_authority::EngineHandleKind::Engine,
        };
        let generation = prepare_engine_search(
            key.engine.clone(),
            engine.clone(),
            key.tab.clone(),
            app.state(),
        )
        .await
        .unwrap();
        kill_engine(key.engine.clone(), key.tab.clone(), app.state())
            .await
            .unwrap();
        assert!(matches!(
            state
                .engine_supervisor
                .consume_engine_search(key.clone(), key.engine.clone(), engine.id, &generation,)
                .await,
            Err(Error::Cancellation)
        ));
        assert!(state.engine_supervisor.get_exact(&key).is_none());
    }

    #[tokio::test]
    async fn kill_engine_cancelled_interactive_search_normalizes_only_expected_stop_consequences() {
        let supervisor = crate::engine::EngineSupervisor::default();
        let key = EngineKey::new("kill-disconnected".into(), "engine".into()).unwrap();
        let (actor, _) = EngineActor::recording_test_actor(&[]);
        let published = supervisor
            .replace_handle(
                key.clone(),
                actor,
                "engine".into(),
                crate::infra::path_authority::PathRef {
                    id: "kill-image".into(),
                },
            )
            .await
            .unwrap();
        supervisor.kill_engine(&key).await.unwrap();
        assert!(matches!(
            classify_interactive_search_result(
                Err(Error::EngineDisconnected),
                published.cancelled.load(Ordering::SeqCst)
            ),
            Err(Error::Cancellation)
        ));
        assert!(matches!(
            classify_interactive_search_result(Ok(()), true),
            Err(Error::Cancellation)
        ));

        let combined = Error::OperationAndCleanup {
            primary: "search failed".into(),
            cleanup: "reap failed".into(),
        };
        assert!(matches!(
            classify_interactive_search_result(Err(combined), true),
            Err(Error::OperationAndCleanup { primary, cleanup })
                if primary == "search failed" && cleanup == "reap failed"
        ));
    }

    #[tokio::test]
    async fn set_options_collapses_duplicate_multipv_last_wins() {
        let (actor, writes) = EngineActor::recording_test_actor(&["readyok"]);
        let mut process = EngineProcess {
            base: actor,
            last_depth: 0,
            best_moves: Vec::new(),
            last_best_moves: Vec::new(),
            last_progress: 0.0,
            options: EngineOptions::default(),
            resource_leases: Vec::new(),
            go_mode: GoMode::Infinite,
            running: false,
            request_id: None,
            real_multipv: 0,
            start: Instant::now(),
        };
        let options = EngineOptions {
            fen: start_fen().to_string(),
            moves: Vec::new(),
            extra_options: vec![string_option("MultiPV", "2"), string_option("MultiPV", "4")],
        };

        process
            .set_options(options, vec![resolved_option("MultiPV", "4")], None)
            .await
            .unwrap();

        let writes = writes.lock().await;
        assert_eq!(
            writes
                .iter()
                .filter(|line| line.as_str() == "setoption name MultiPV value 4")
                .count(),
            1
        );
        assert!(!writes
            .iter()
            .any(|line| line == "setoption name MultiPV value 2"));
        assert_eq!(process.real_multipv, 4);
        drop(writes);
        process.base.terminate().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn set_options_passes_resource_provenance_to_actor_logs() {
        let directory = tempfile::tempdir().unwrap();
        let resource_file = directory.path().join("resource.bin");
        std::fs::write(&resource_file, b"resource").unwrap();
        let lease = Arc::new(
            crate::infra::path_authority::EngineResourceLease::test_file(
                std::fs::File::open(&resource_file).unwrap(),
            ),
        );
        #[cfg(target_os = "macos")]
        lease.pin_test_target_to_original().unwrap();
        let resource = lease.uci_value().unwrap();
        let (actor, writes) = EngineActor::recording_test_actor_with_resources(
            &["readyok", &resource],
            vec![lease.clone()],
        );
        let mut process = EngineProcess {
            base: actor.clone(),
            last_depth: 0,
            best_moves: Vec::new(),
            last_best_moves: Vec::new(),
            last_progress: 0.0,
            options: EngineOptions::default(),
            resource_leases: Vec::new(),
            go_mode: GoMode::Infinite,
            running: false,
            request_id: None,
            real_multipv: 0,
            start: Instant::now(),
        };

        process
            .set_options(
                EngineOptions {
                    fen: start_fen().to_string(),
                    moves: Vec::new(),
                    extra_options: vec![string_option("EvalFile", &resource)],
                },
                vec![ResolvedEngineOption {
                    name: "EvalFile".into(),
                    value: resource.clone(),
                    resources: vec![lease],
                    resource_values: vec![resource.clone()],
                }],
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            actor.next_configuration_line().await.unwrap(),
            Some(resource.clone())
        );
        assert!(writes
            .lock()
            .await
            .iter()
            .any(|line| line == &format!("setoption name EvalFile value {resource}")));
        let logs = actor.logs().await.unwrap();
        assert!(logs.iter().all(|entry| match entry {
            EngineLog::Gui(line) | EngineLog::Engine(line) => !line.contains(&resource),
            EngineLog::Truncated { .. } => true,
        }));
        actor.terminate().await.unwrap();
    }

    #[test]
    fn report_option_prep_collapses_and_forces_multipv_on_both_sides() {
        let originals = vec![string_option("MultiPV", "2"), string_option("MultiPV", "4")];

        let extras = analysis_options_with_lines(&originals, REPORT_MULTIPV);

        assert_eq!(
            extras,
            vec![string_option("MultiPV", &REPORT_MULTIPV.to_string())]
        );
    }

    #[test]
    fn analysis_options_add_the_line_count_when_the_engine_sets_none() {
        let originals = vec![string_option("Hash", "64")];

        assert_eq!(
            analysis_options_with_lines(&originals, 3),
            vec![string_option("Hash", "64"), string_option("MultiPV", "3")]
        );
    }

    #[test]
    fn only_a_timed_search_gets_a_wall_clock_deadline() {
        assert_eq!(
            analysis_search_deadline(&GoMode::Time(1_500), TIMED_SEARCH_GRACE),
            Some(Duration::from_millis(1_500) + TIMED_SEARCH_GRACE)
        );
        for mode in [GoMode::Depth(20), GoMode::Nodes(1_000), GoMode::Infinite] {
            assert_eq!(analysis_search_deadline(&mode, TIMED_SEARCH_GRACE), None);
        }
    }

    #[cfg(unix)]
    fn fixture_capture(directory: &tempfile::TempDir) -> String {
        std::fs::read_to_string(directory.path().join("capture.log")).unwrap_or_default()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn analysis_session_sends_each_calls_line_count_and_mirrors_it() {
        let (directory, app, engine, _) = resource_engine_fixture();
        std::fs::write(directory.path().join("release"), b"").unwrap();
        let state = app.state::<AppState>().inner().clone();
        let key = EngineKey::new("analysis".into(), "session-lines".into()).unwrap();
        let mut session = AnalysisSession::start(
            &state,
            key,
            engine,
            "session-lines-engine".into(),
            vec![string_option("MultiPV", "2")],
            CancellationToken::new(),
        )
        .await
        .unwrap();

        for lines in [3_u16, 5, 3] {
            session
                .analyze(&start_fen().to_string(), &[], lines, &GoMode::Depth(1))
                .await
                .unwrap();
            let mirrored = session
                .proc
                .options
                .extra_options
                .iter()
                .rev()
                .find(|option| option.name() == "MultiPV")
                .cloned();
            assert_eq!(mirrored, Some(string_option("MultiPV", &lines.to_string())));
        }
        session.terminate().await.unwrap();

        let sent: Vec<String> = fixture_capture(&directory)
            .lines()
            .filter_map(|line| line.strip_prefix("option=setoption name MultiPV value "))
            .map(str::to_owned)
            .collect();
        assert_eq!(sent, ["3", "5", "3"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn analysis_session_stops_a_timed_search_that_outlives_its_deadline() {
        let (directory, app, engine, _) = resource_engine_fixture();
        let state = app.state::<AppState>().inner().clone();
        let key = EngineKey::new("analysis".into(), "session-deadline".into()).unwrap();
        let mut session = AnalysisSession::start(
            &state,
            key,
            engine,
            "session-deadline-engine".into(),
            Vec::new(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let grace = Duration::from_millis(200);
        session.timed_search_grace = grace;
        // The fixture answers `go` only once `release` exists, so `bestmove` arrives after the
        // deadline and the session's `stop` can then complete at the protocol boundary.
        let release = directory.path().join("release");
        let directory_for_release = directory.path().to_owned();
        let releaser = tokio::spawn(async move {
            loop {
                let capture = std::fs::read_to_string(directory_for_release.join("capture.log"))
                    .unwrap_or_default();
                if capture.contains("go-ready") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            tokio::time::sleep(grace + Duration::from_millis(250)).await;
            std::fs::write(release, b"").unwrap();
        });

        let error = session
            .analyze(&start_fen().to_string(), &[], 1, &GoMode::Time(20))
            .await
            .unwrap_err();
        releaser.await.unwrap();

        assert!(matches!(error, Error::EngineTimeout(_)), "{error:?}");
        wait_for_fixture_capture(&directory, "wire=stop").await;
        session.terminate().await.unwrap();
    }

    #[test]
    fn provenance_is_restored_for_inherited_resource_options_only() {
        let inherited = HashMap::from([(
            "EvalFile".to_owned(),
            (
                "/proc/self/fd/7".to_owned(),
                vec!["/proc/self/fd/7".to_owned()],
            ),
        )]);
        let mut resource = ResolvedEngineOption {
            name: "EvalFile".into(),
            value: String::new(),
            resources: Vec::new(),
            resource_values: Vec::new(),
        };
        let mut lines = ResolvedEngineOption {
            name: "MultiPV".into(),
            value: "5".into(),
            resources: Vec::new(),
            resource_values: Vec::new(),
        };

        restore_inherited_resource_provenance(&mut resource, &inherited);
        restore_inherited_resource_provenance(&mut lines, &inherited);

        assert_eq!(resource.value, "/proc/self/fd/7");
        assert_eq!(resource.resource_values, vec!["/proc/self/fd/7".to_owned()]);
        assert_eq!(lines.value, "5");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn report_core_restores_child_resource_provenance_after_fresh_resolution() {
        let (_directory, app, engine, resource) = resource_engine_fixture();
        let option = EngineOption::Resource {
            name: "EvalFile".into(),
            resources: vec![resource.clone()],
        };

        // Each resolution owns a new descriptor. The report path must keep the
        // descriptor inherited by the already-running child when it re-resolves
        // the same opaque handle for a report position.
        #[cfg(target_os = "linux")]
        let (initial, refreshed) = {
            let state = app.state::<AppState>();
            let mut authority = state.pgn_path_authority.raw_for_test().lock().unwrap();
            let authority = authority.as_mut().unwrap();
            let initial_option =
                resolve_engine_option_leases(authority, std::slice::from_ref(&option))
                    .unwrap()
                    .pop()
                    .unwrap();
            let mut initial_option = initial_option;
            initial_option.refresh_resource_values().unwrap();
            let initial = initial_option.resource_values[0].clone();
            let refreshed_option =
                resolve_engine_option_leases(authority, std::slice::from_ref(&option))
                    .unwrap()
                    .pop()
                    .unwrap();
            let mut refreshed_option = refreshed_option;
            refreshed_option.refresh_resource_values().unwrap();
            let refreshed = refreshed_option.resource_values[0].clone();
            (initial, refreshed)
        };
        #[cfg(target_os = "linux")]
        assert_ne!(initial, refreshed);

        let state = app.state::<AppState>().inner().clone();
        let supervisor = state.engine_supervisor.clone();
        let app_for_core = app.clone();
        let core = tokio::spawn(async move {
            analyze_game_core(
                "report-resource".into(),
                engine,
                "report-resource-engine".into(),
                GoMode::Depth(1),
                AnalysisOptions {
                    fen: start_fen().to_string(),
                    moves: Vec::new(),
                    annotate_novelties: false,
                    reference_db: None,
                },
                vec![option],
                state,
                app_for_core,
                CancellationToken::new(),
            )
            .await
        });
        let key = EngineKey::new("analysis".into(), "report-resource".into()).unwrap();
        let (logs, result) =
            collect_barriered_resource_logs(&_directory, &supervisor, &key, core).await;
        let result = result.unwrap();
        assert_eq!(result.positions.len(), 1);
        assert_eq!(result.positions[0].best.len(), 2);
        assert_safe_resource_logs(&logs);
        assert!(supervisor.get_exact(&key).is_none());
        assert_resource_wire_capture(&_directory, "resource-bytes");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn report_core_missing_reference_fails_before_admission() {
        let (directory, app, engine, _) = resource_engine_fixture();
        let id = "report-missing-reference";
        let state = app.state::<AppState>().inner().clone();
        let result = analyze_game_core(
            id.into(),
            engine,
            "report-missing-reference-engine".into(),
            GoMode::Depth(1),
            AnalysisOptions {
                fen: start_fen().to_string(),
                moves: Vec::new(),
                annotate_novelties: true,
                reference_db: None,
            },
            Vec::new(),
            state.clone(),
            app,
            CancellationToken::new(),
        )
        .await;
        assert!(
            matches!(result, Err(Error::MissingReferenceDatabase)),
            "{result:?}"
        );
        assert!(state.progress_state.get(id).unwrap().is_none());
        assert!(state
            .engine_supervisor
            .get_exact(&EngineKey::new("analysis".into(), id.into()).unwrap())
            .is_none());
        assert!(!directory.path().join("capture.log").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn invalid_initial_resource_does_not_leave_report_progress_running() {
        use crate::infra::path_authority::{
            EngineResourceHandle, EngineResourceHandleKind, PathRef,
        };

        let (_directory, app, engine, _) = resource_engine_fixture();
        let id = "invalid-initial-resource";
        let state = app.state::<AppState>().inner().clone();
        let invalid_resource = EngineResourceHandle::new(
            PathRef {
                id: "missing-resource".into(),
            },
            EngineResourceHandleKind::File,
            "missing-resource".into(),
        );
        let result = analyze_game_core(
            id.into(),
            engine,
            "invalid-resource-engine".into(),
            GoMode::Depth(1),
            AnalysisOptions {
                fen: start_fen().to_string(),
                moves: Vec::new(),
                annotate_novelties: false,
                reference_db: None,
            },
            vec![EngineOption::Resource {
                name: "EvalFile".into(),
                resources: vec![invalid_resource],
            }],
            state.clone(),
            app.clone(),
            CancellationToken::new(),
        )
        .await;
        assert!(result.is_err());
        assert!(state.progress_state.get(id).unwrap().is_some());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn get_best_moves_core_wires_resource_options_through_production_flow() {
        let (_directory, app, engine, resource) = resource_engine_fixture();
        let state = app.state::<AppState>();
        let key = EngineKey::new(
            "interactive-resource".into(),
            "interactive-resource-engine".into(),
        )
        .unwrap();
        let generation = state
            .engine_supervisor
            .prepare_engine_search(key, "interactive-resource-engine".into(), engine.id.clone())
            .await
            .unwrap();
        let supervisor = state.engine_supervisor.clone();
        let app_for_core = app.clone();
        let state_for_core = state.inner().clone();
        let core = tokio::spawn(async move {
            get_best_moves_core(
                "interactive-resource-engine".into(),
                engine,
                "interactive-resource".into(),
                GoMode::Depth(1),
                EngineOptions {
                    fen: start_fen().to_string(),
                    moves: Vec::new(),
                    extra_options: vec![EngineOption::Resource {
                        name: "EvalFile".into(),
                        resources: vec![resource],
                    }],
                },
                generation,
                app_for_core,
                state_for_core,
            )
            .await
        });
        let key = EngineKey::new(
            "interactive-resource".into(),
            "interactive-resource-engine".into(),
        )
        .unwrap();
        let (logs, result) =
            collect_barriered_resource_logs(&_directory, &supervisor, &key, core).await;
        let result = result.unwrap();
        assert!(result.is_none());
        assert_safe_resource_logs(&logs);
        assert!(supervisor.get_exact(&key).is_some());
        supervisor.stop_generation(&key, None).await.unwrap();
        assert_resource_wire_capture(&_directory, "resource-bytes");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn warm_interactive_searches_reuse_resource_handles_and_publish_each_generation() {
        let (directory, app, engine, resource) = resource_engine_fixture();
        std::fs::write(directory.path().join("release"), b"").unwrap();
        let state = app.state::<AppState>().inner().clone();
        let key = EngineKey::new("warm-tab".into(), "warm-id".into()).unwrap();
        let emitted = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = emitted.clone();
        app.listen(BestMovesPayload::NAME, move |event| {
            observed
                .lock()
                .unwrap()
                .push(serde_json::from_str::<serde_json::Value>(event.payload()).unwrap());
        });
        let mut first_actor = None;
        let mut previous_generation = None;
        for (index, moves) in [vec![], vec!["d2d4".into(), "d7d5".into()], vec![]]
            .into_iter()
            .enumerate()
        {
            let mut same_handle = resource.clone();
            same_handle.display_name = format!("label-{index}");
            let generation = state
                .engine_supervisor
                .prepare_engine_search(key.clone(), key.engine.clone(), engine.id.clone())
                .await
                .unwrap();
            get_best_moves_core(
                key.engine.clone(),
                engine.clone(),
                key.tab.clone(),
                GoMode::Depth(1),
                EngineOptions {
                    fen: start_fen().to_string(),
                    moves,
                    extra_options: vec![EngineOption::Resource {
                        name: "EvalFile".into(),
                        resources: vec![same_handle],
                    }],
                },
                generation.clone(),
                app.clone(),
                state.clone(),
            )
            .await
            .unwrap();
            let current = state.engine_supervisor.get_exact(&key).unwrap();
            if let Some(first) = &first_actor {
                assert!(Arc::ptr_eq(first, &current.actor));
            } else {
                first_actor = Some(current.actor.clone());
            }
            assert!(emitted
                .lock()
                .unwrap()
                .iter()
                .any(|payload| payload["generation"] == generation));
            if let Some(previous) = previous_generation {
                state
                    .engine_supervisor
                    .stop_generation(&key, Some(previous))
                    .await
                    .unwrap();
                state
                    .engine_supervisor
                    .release_generation(&key, previous)
                    .await
                    .unwrap();
                assert!(state.engine_supervisor.get_exact(&key).is_some());
                assert!(!current
                    .current_search()
                    .unwrap()
                    .cancelled
                    .load(Ordering::SeqCst));
            }
            state
                .engine_supervisor
                .stop_generation(&key, Some(generation.parse().unwrap()))
                .await
                .unwrap();
            assert!(state.engine_supervisor.get_exact(&key).is_some());
            previous_generation = Some(generation.parse().unwrap());
        }
        let capture = std::fs::read_to_string(directory.path().join("capture.log")).unwrap();
        assert_eq!(
            capture.lines().filter(|line| *line == "wire=uci").count(),
            1
        );
        assert_eq!(
            capture
                .lines()
                .filter(|line| line.starts_with("eval="))
                .count(),
            1
        );
        release_engine_search(
            key.engine.clone(),
            key.tab.clone(),
            previous_generation.unwrap().to_string(),
            app.state(),
        )
        .await
        .unwrap();
        assert!(state.engine_supervisor.get_exact(&key).is_none());
        assert_eq!(
            capture
                .lines()
                .filter(|line| line.starts_with("wire=go"))
                .count(),
            3
        );
        assert!(release_engine_search(
            key.engine.clone(),
            key.tab.clone(),
            "bad".into(),
            app.state()
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn warm_options_restore_removed_overrides_and_reset_search_fields() {
        let (actor, writes) = EngineActor::recording_test_actor(&[
            "option name Skill Level type spin default 20 min 0 max 20",
            "option name Ponder type check default false",
            "option name Style type combo default Normal var Normal var Aggressive",
            "option name Label type string default default-label",
            "option name Clear Hash type button",
            "uciok",
            "readyok",
            "readyok",
            "bestmove e2e4",
            "readyok",
            "bestmove e2e4",
        ]);
        let mut warm = WarmEngine::new(actor.clone(), Vec::new(), &AtomicBool::new(false))
            .await
            .unwrap();
        let override_options = EngineOptions {
            fen: start_fen().to_string(),
            moves: Vec::new(),
            extra_options: vec![string_option("Skill Level", "3")],
        };
        let cancelled = AtomicBool::new(false);
        let mut first = warm
            .start(override_options, &GoMode::Depth(1), &cancelled)
            .await
            .unwrap();
        assert!(first.next_line().await.unwrap().is_some());
        warm.process.last_progress = 100.0;
        warm.process.last_depth = 100;
        let options = EngineOptions {
            fen: start_fen().to_string(),
            ..EngineOptions::default()
        };
        assert!(warm.can_reuse(&options));
        let mut next = warm
            .start(options, &GoMode::Depth(1), &cancelled)
            .await
            .unwrap();
        assert_ne!(first.request_id, next.request_id);
        assert_eq!(next.last_progress, 0.0);
        assert_eq!(next.last_depth, 0);
        assert!(next.next_line().await.unwrap().is_some());
        assert_eq!(
            writes
                .lock()
                .await
                .iter()
                .filter(|line| *line == "uci")
                .count(),
            1
        );
        assert!(writes
            .lock()
            .await
            .iter()
            .any(|line| line == "setoption name Skill Level value 20"));
        assert!(!warm.defaults.contains_key("Clear Hash"));
        actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_warm_option_write_is_corrected_by_the_next_search() {
        for cancelled_write in ["override", "restoration", "chess960"] {
            let cancelled = Arc::new(AtomicBool::new(false));
            let command = match cancelled_write {
                "override" => "setoption name Threads value 8",
                "restoration" => "setoption name Threads value 1",
                "chess960" => "setoption name UCI_Chess960 value true",
                _ => unreachable!(),
            };
            let (actor, writes) = EngineActor::recording_test_actor_cancelling_after_write(
                &[
                    "option name Threads type spin default 1 min 1 max 128",
                    "option name Hash type spin default 16 min 1 max 1024",
                    "uciok",
                    "readyok",
                    "readyok",
                    "bestmove e2e4",
                    "readyok",
                    "bestmove e2e4",
                ],
                Vec::new(),
                command.into(),
                cancelled.clone(),
            );
            let mut warm = WarmEngine::new(actor.clone(), Vec::new(), &cancelled)
                .await
                .unwrap();
            let baseline = EngineOptions {
                fen: start_fen().to_string(),
                moves: Vec::new(),
                extra_options: vec![string_option("Threads", "4"), string_option("Hash", "16")],
            };
            let mut first = warm
                .start(baseline.clone(), &GoMode::Depth(1), &cancelled)
                .await
                .unwrap();
            assert!(first.next_line().await.unwrap().is_some());
            let transition = match cancelled_write {
                "restoration" => EngineOptions {
                    fen: baseline.fen.clone(),
                    ..EngineOptions::default()
                },
                "chess960" => EngineOptions {
                    fen: "rk5r/8/8/8/8/8/8/RK5R w HAha - 0 1".into(),
                    moves: Vec::new(),
                    extra_options: vec![string_option("Threads", "8"), string_option("Hash", "32")],
                },
                _ => EngineOptions {
                    extra_options: vec![string_option("Threads", "8"), string_option("Hash", "32")],
                    ..baseline.clone()
                },
            };
            assert!(warm.can_reuse(&transition));
            assert!(matches!(
                warm.start(transition, &GoMode::Depth(1), &cancelled).await,
                Err(Error::Cancellation)
            ));
            {
                let writes = writes.lock().await;
                assert!(
                    writes.iter().any(|line| line == command),
                    "{cancelled_write}"
                );
                assert!(!writes
                    .iter()
                    .any(|line| line == "setoption name Hash value 32"));
                assert_eq!(
                    writes.iter().filter(|line| line.starts_with("go ")).count(),
                    1
                );
            }
            assert!(warm.can_reuse(&baseline), "{cancelled_write}");
            let mut next = warm
                .start(baseline.clone(), &GoMode::Depth(1), &AtomicBool::new(false))
                .await
                .unwrap();
            assert!(next.next_line().await.unwrap().is_some());
            {
                let writes = writes.lock().await;
                let restored_command = if cancelled_write == "chess960" {
                    "setoption name UCI_Chess960 value false"
                } else {
                    "setoption name Threads value 4"
                };
                assert_eq!(writes.iter().filter(|line| *line == restored_command).count(), 2,
                    "the successor must correct the successful cancelled write ({cancelled_write}): {writes:?}");
                assert_eq!(
                    writes.iter().filter(|line| line.starts_with("go ")).count(),
                    2
                );
                assert_eq!(writes.iter().filter(|line| *line == "uci").count(), 1);
            }
            assert_eq!(warm.process.options, baseline);
            actor.terminate().await.unwrap();
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn cancelled_initial_resource_write_retains_its_mirror_and_lease_for_reuse() {
        let (_directory, app, _, resource) = resource_engine_fixture();
        let resource_option = EngineOption::Resource {
            name: "EvalFile".into(),
            resources: vec![resource],
        };
        let mut resolved = {
            let state = app.state::<AppState>();
            let mut authority = state.pgn_path_authority.raw_for_test().lock().unwrap();
            resolve_engine_option_leases(
                authority.as_mut().unwrap(),
                std::slice::from_ref(&resource_option),
            )
            .unwrap()
        };
        resolved[0].refresh_resource_values().unwrap();
        let lease = resolved[0].resources[0].clone();
        let command = format!("setoption name EvalFile value {}", resolved[0].value);
        let cancelled = Arc::new(AtomicBool::new(false));
        let (actor, writes) = EngineActor::recording_test_actor_cancelling_after_write(
            &["uciok", "readyok", "readyok", "bestmove e2e4"],
            vec![lease.clone()],
            command.clone(),
            cancelled.clone(),
        );
        let mut warm = WarmEngine::new(actor.clone(), resolved, &cancelled)
            .await
            .unwrap();
        let options = EngineOptions {
            fen: start_fen().to_string(),
            moves: Vec::new(),
            extra_options: vec![resource_option.clone(), string_option("Threads", "4")],
        };
        assert!(matches!(
            warm.start(options.clone(), &GoMode::Depth(1), &cancelled)
                .await,
            Err(Error::Cancellation)
        ));
        assert_eq!(warm.process.resource_leases.len(), 1);
        assert!(Arc::ptr_eq(&warm.process.resource_leases[0], &lease));
        assert!(warm
            .process
            .options
            .extra_options
            .iter()
            .any(|option| option.has_same_value(&resource_option)));
        assert!(warm.can_reuse(&options));
        let mut next = warm
            .start(options, &GoMode::Depth(1), &AtomicBool::new(false))
            .await
            .unwrap();
        assert!(next.next_line().await.unwrap().is_some());
        assert_eq!(
            writes
                .lock()
                .await
                .iter()
                .filter(|line| *line == &command)
                .count(),
            1
        );
        assert_eq!(warm.process.resource_leases.len(), 1);
        actor.terminate().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn warm_actor_release_paths_reap_every_owner() {
        for release in ["unscoped", "kill", "tab", "retire", "binary", "all"] {
            let (directory, app, engine, _resource) = resource_engine_fixture();
            std::fs::write(directory.path().join("release"), b"").unwrap();
            let state = app.state::<AppState>().inner().clone();
            let key = EngineKey::new("release-tab".into(), "release-id".into()).unwrap();
            let generation = state
                .engine_supervisor
                .prepare_engine_search(key.clone(), key.engine.clone(), engine.id.clone())
                .await
                .unwrap();
            get_best_moves_core(
                key.engine.clone(),
                engine.clone(),
                key.tab.clone(),
                GoMode::Depth(1),
                EngineOptions {
                    fen: start_fen().to_string(),
                    ..EngineOptions::default()
                },
                generation,
                app.clone(),
                state.clone(),
            )
            .await
            .unwrap();
            let actor = state.engine_supervisor.get_exact(&key).unwrap().actor;
            match release {
                "unscoped" => {
                    stop_engine(key.engine.clone(), key.tab.clone(), None, app.state())
                        .await
                        .unwrap();
                }
                "kill" => kill_engine(key.engine.clone(), key.tab.clone(), app.state())
                    .await
                    .unwrap(),
                "tab" => state
                    .engine_supervisor
                    .terminate_tab(&key.tab)
                    .await
                    .unwrap(),
                "retire" => state
                    .engine_supervisor
                    .retire_engine(key.engine.clone())
                    .await
                    .unwrap(),
                "binary" => state
                    .engine_supervisor
                    .retire_engine_binary(
                        key.engine.clone(),
                        engine.id,
                        crate::infra::path_authority::PathRef {
                            id: "next-binary".into(),
                        },
                    )
                    .await
                    .unwrap(),
                "all" => state.engine_supervisor.terminate_all().await.unwrap(),
                _ => unreachable!(),
            }
            assert!(
                state.engine_supervisor.get_exact(&key).is_none(),
                "{release}"
            );
            assert!(
                matches!(
                    actor.start_search(&GoMode::Depth(1)).await,
                    Err(Error::EngineDisconnected)
                ),
                "{release}"
            );
            let capture = std::fs::read_to_string(directory.path().join("capture.log")).unwrap();
            assert!(capture.lines().any(|line| line == "wire=quit"), "{release}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn warm_transition_termination_stops_after_one_slow_exchange_on_fresh_and_reuse_paths() {
        for reused in [false, true] {
            for termination in ["exact", "all", "release"] {
                assert_warm_transition_termination(reused, termination, false).await;
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn warm_transition_termination_preempts_silent_readiness_on_fresh_and_reuse_paths() {
        for reused in [false, true] {
            for termination in ["exact", "all"] {
                assert_warm_transition_termination(reused, termination, true).await;
            }
        }
    }

    #[cfg(unix)]
    async fn assert_warm_transition_termination(reused: bool, termination: &str, silent: bool) {
        let context = format!("reused={reused}, termination={termination}, silent={silent}");
        let (directory, app, engine, _) = resource_engine_fixture();
        std::fs::write(directory.path().join("release"), b"").unwrap();
        let state = app.state::<AppState>().inner().clone();
        let supervisor = state.engine_supervisor.clone();
        let key = EngineKey::new("slow-transition".into(), "id".into()).unwrap();
        if reused {
            run_warm_fixture_search(&app, &key, engine.clone(), Vec::new())
                .await
                .unwrap();
        }
        let capture_path = directory.path().join("capture.log");
        let previous_ready = std::fs::read_to_string(&capture_path)
            .unwrap_or_default()
            .lines()
            .filter(|line| *line == "wire=isready")
            .count();
        let previous_go = std::fs::read_to_string(&capture_path)
            .unwrap_or_default()
            .lines()
            .filter(|line| line.starts_with("wire=go"))
            .count();
        let ready_flag = if silent { "silent-ready" } else { "slow-ready" };
        std::fs::write(directory.path().join(ready_flag), b"").unwrap();
        let generation = supervisor
            .prepare_engine_search(key.clone(), key.engine.clone(), engine.id.clone())
            .await
            .unwrap();
        let search_generation = generation.parse::<u64>().unwrap();
        let start_key = key.clone();
        let start_state = state.clone();
        let start_app = app.clone();
        let search = tokio::spawn(async move {
            get_best_moves_core(
                start_key.engine,
                engine,
                start_key.tab,
                GoMode::Depth(1),
                EngineOptions {
                    fen: start_fen().to_string(),
                    ..EngineOptions::default()
                },
                generation,
                start_app,
                start_state,
            )
            .await
        });
        // Observe the exchange on the child's wire before requesting termination.
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let capture = std::fs::read_to_string(&capture_path).unwrap_or_default();
                if capture
                    .lines()
                    .filter(|line| *line == "wire=isready")
                    .count()
                    > previous_ready
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap_or_else(|error| panic!("{context}: readiness wire observation failed: {error}"));
        let current = supervisor
            .get_exact(&key)
            .unwrap_or_else(|| panic!("{context}: exact actor must be registered"));
        let termination_supervisor = supervisor.clone();
        let termination_key = key.clone();
        let actor_generation = current.generation;
        let termination_kind = termination.to_string();
        let mut terminator = tokio::spawn(async move {
            match termination_kind.as_str() {
                "exact" => {
                    termination_supervisor
                        .terminate_exact(&termination_key, actor_generation)
                        .await
                }
                "all" => termination_supervisor.terminate_all().await,
                "release" => {
                    termination_supervisor
                        .release_generation(&termination_key, search_generation)
                        .await
                }
                _ => unreachable!(),
            }
        });
        // Wire progress excludes child exit, stderr cleanup and the actor join.
        let started = Instant::now();
        let quit = observe_fixture_capture(&directory, "wire=quit").await;
        let wire_elapsed = started.elapsed();
        if quit.is_err() {
            eprintln!("{context}: wire=quit observation failed after {wire_elapsed:?}");
        }
        let mut search = search;
        let (termination_result, search_result) = tokio::join!(
            tokio::time::timeout(Duration::from_secs(12), &mut terminator),
            tokio::time::timeout(Duration::from_secs(12), &mut search),
        );
        // Retain failed observations until owned tasks and the child are cleaned up.
        let cleanup = if termination_result.is_err() || search_result.is_err() {
            let cleanup =
                tokio::time::timeout(Duration::from_secs(12), supervisor.terminate_all()).await;
            if termination_result.is_err() {
                terminator.abort();
                let _ = terminator.await;
            }
            if search_result.is_err() {
                search.abort();
                let _ = search.await;
            }
            Some(cleanup)
        } else {
            None
        };
        assert_abandoned_engine_removed(&directory, &supervisor, &key.tab, Some(&key)).await;
        eprintln!(
            "{context}: physical cleanup confirmed, wire observation={quit:?} after {wire_elapsed:?}"
        );
        assert!(
            quit.is_ok(),
            "{context}: wire=quit must be observed within 5s, observed {quit:?} after {wire_elapsed:?}"
        );
        assert!(
            cleanup.is_none_or(|result| matches!(result, Ok(Ok(())))),
            "{context}: fallback cleanup failed"
        );
        termination_result
            .unwrap_or_else(|error| panic!("{context}: termination completion timed out: {error}"))
            .unwrap_or_else(|error| panic!("{context}: termination task failed: {error}"))
            .unwrap_or_else(|error| panic!("{context}: termination failed: {error:?}"));
        eprintln!("{context}: termination completion confirmed");
        assert!(current.cancelled.load(Ordering::SeqCst), "{context}");
        assert!(
            current
                .current_search()
                .unwrap_or_else(|| panic!("{context}: exact search must remain observable"))
                .cancelled
                .load(Ordering::SeqCst),
            "{context}"
        );
        assert!(supervisor.get_exact(&key).is_none(), "{context}");
        let capture = std::fs::read_to_string(&capture_path).unwrap();
        assert_eq!(
            capture
                .lines()
                .filter(|line| *line == "wire=isready")
                .count(),
            previous_ready + 1,
            "no second readiness exchange: {context}: {capture}"
        );
        assert_eq!(
            capture
                .lines()
                .filter(|line| line.starts_with("wire=go"))
                .count(),
            previous_go,
            "no go after termination: {context}: {capture}"
        );
        assert!(capture.lines().any(|line| line == "wire=quit"), "{context}");
        let result = search_result
            .unwrap_or_else(|error| panic!("{context}: search completion timed out: {error}"))
            .unwrap_or_else(|error| panic!("{context}: search task failed: {error}"));
        assert!(
            matches!(result, Err(Error::Cancellation)),
            "{context}: {result:?}"
        );
    }

    #[cfg(unix)]
    async fn run_warm_fixture_search(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        key: &EngineKey,
        engine: EngineHandle,
        extra_options: Vec<EngineOption>,
    ) -> Result<String, Error> {
        let state = app.state::<AppState>().inner().clone();
        let generation = state
            .engine_supervisor
            .prepare_engine_search(key.clone(), key.engine.clone(), engine.id.clone())
            .await?;
        get_best_moves_core(
            key.engine.clone(),
            engine,
            key.tab.clone(),
            GoMode::Depth(1),
            EngineOptions {
                fen: start_fen().to_string(),
                moves: Vec::new(),
                extra_options,
            },
            generation.clone(),
            app.clone(),
            state,
        )
        .await?;
        Ok(generation)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn warm_resource_and_executable_changes_relaunch_and_duplicate_ids_stay_separate() {
        let (directory, app, engine, resource) = resource_engine_fixture();
        std::fs::write(directory.path().join("release"), b"").unwrap();
        let key = EngineKey::new("changes".into(), "id-1".into()).unwrap();
        let options = vec![EngineOption::Resource {
            name: "EvalFile".into(),
            resources: vec![resource],
        }];
        run_warm_fixture_search(&app, &key, engine.clone(), options)
            .await
            .unwrap();
        let supervisor = app.state::<AppState>().engine_supervisor.clone();
        let first = supervisor.get_exact(&key).unwrap();
        // Removing the resource handle changes the launch leases and requires a fresh process.
        run_warm_fixture_search(&app, &key, engine.clone(), Vec::new())
            .await
            .unwrap();
        let second = supervisor.get_exact(&key).unwrap();
        assert!(!Arc::ptr_eq(&first.actor, &second.actor));
        assert!(first.actor.start_search(&GoMode::Depth(1)).await.is_err());

        let replacement_path = directory.path().join("replacement.sh");
        let replacement_bytes =
            std::fs::read(directory.path().join("resource-flow-engine.sh")).unwrap();
        crate::infra::test_executable::publish_test_executable(
            &replacement_path,
            replacement_bytes,
            0o700,
        )
        .unwrap();
        let replacement = app
            .state::<AppState>()
            .pgn_path_authority
            .raw_for_test()
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .register_engine_file(&replacement_path, "resource-flow-engine")
            .unwrap();
        run_warm_fixture_search(&app, &key, replacement, Vec::new())
            .await
            .unwrap();
        let third = supervisor.get_exact(&key).unwrap();
        assert!(!Arc::ptr_eq(&second.actor, &third.actor));
        assert!(second.actor.start_search(&GoMode::Depth(1)).await.is_err());

        let duplicate = EngineKey::new("changes".into(), "id-2".into()).unwrap();
        let duplicate2 = EngineKey::new("changes".into(), "id-3".into()).unwrap();
        run_warm_fixture_search(&app, &duplicate, engine.clone(), Vec::new())
            .await
            .unwrap();
        run_warm_fixture_search(&app, &duplicate2, engine, Vec::new())
            .await
            .unwrap();
        let a = supervisor.get_exact(&duplicate).unwrap();
        let b = supervisor.get_exact(&duplicate2).unwrap();
        assert_eq!(a.executable, b.executable);
        assert!(!Arc::ptr_eq(&a.actor, &b.actor));
        supervisor
            .release_generation(&duplicate, a.owner_generation())
            .await
            .unwrap();
        assert!(supervisor.get_exact(&duplicate2).is_some());
        supervisor.terminate_all().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn warm_protocol_failure_removes_actor_and_next_search_relaunches() {
        let (directory, app, engine, _resource) = resource_engine_fixture();
        std::fs::write(directory.path().join("release"), b"").unwrap();
        let key = EngineKey::new("failure".into(), "failure-id".into()).unwrap();
        run_warm_fixture_search(&app, &key, engine.clone(), Vec::new())
            .await
            .unwrap();
        let supervisor = app.state::<AppState>().engine_supervisor.clone();
        let first = supervisor.get_exact(&key).unwrap();
        std::fs::write(directory.path().join("fail-search"), b"").unwrap();
        assert!(
            run_warm_fixture_search(&app, &key, engine.clone(), Vec::new())
                .await
                .is_err()
        );
        assert!(supervisor.get_exact(&key).is_none());
        std::fs::remove_file(directory.path().join("fail-search")).unwrap();
        run_warm_fixture_search(&app, &key, engine, Vec::new())
            .await
            .unwrap();
        let next = supervisor.get_exact(&key).unwrap();
        assert!(!Arc::ptr_eq(&first.actor, &next.actor));
        let capture = std::fs::read_to_string(directory.path().join("capture.log")).unwrap();
        assert_eq!(
            capture.lines().filter(|line| *line == "wire=uci").count(),
            2
        );
        supervisor.terminate_all().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn get_engine_config_launches_a_fixture_through_the_production_launch_helper() {
        let (_directory, app, engine, _resource) = resource_engine_fixture();
        let config = get_engine_config(engine, app.state()).await.unwrap();
        assert!(config.options.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sealed_get_engine_config_refuses_before_resolution() {
        let (directory, app, engine, _resource) = resource_engine_fixture();
        let state = app.state::<AppState>();
        state.engine_supervisor.terminate_all().await.unwrap();
        let result = get_engine_config(engine, state).await;
        assert!(matches!(
            result,
            Err(Error::Conflict(message)) if message == "application is shutting down"
        ));
        assert!(!directory.path().join("capture.log").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sealed_report_analysis_refuses_before_resolution() {
        let (directory, app, engine, _resource) = resource_engine_fixture();
        let state = app.state::<AppState>().inner().clone();
        state.engine_supervisor.terminate_all().await.unwrap();
        let result = analyze_game_core(
            "sealed-report".into(),
            engine,
            "sealed-report-engine".into(),
            GoMode::Depth(1),
            AnalysisOptions {
                fen: start_fen().to_string(),
                moves: Vec::new(),
                annotate_novelties: false,
                reference_db: None,
            },
            Vec::new(),
            state,
            app,
            CancellationToken::new(),
        )
        .await;
        assert!(matches!(
            result,
            Err(Error::Conflict(message)) if message == "application is shutting down"
        ));
        assert!(!directory.path().join("capture.log").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn removed_interactive_reservation_refuses_before_resolution() {
        let (_directory, app, engine, _resource) = resource_engine_fixture();
        let state = app.state::<AppState>();
        let id = "removed-reservation-engine";
        let tab = "removed-reservation";
        let key = EngineKey::new(tab.into(), id.into()).unwrap();
        let generation = state
            .engine_supervisor
            .prepare_engine_search(key, id.into(), engine.id.clone())
            .await
            .unwrap();
        state.engine_supervisor.terminate_all().await.unwrap();
        let result = get_best_moves_core(
            id.into(),
            engine,
            tab.into(),
            GoMode::Depth(1),
            EngineOptions::default(),
            generation,
            app.clone(),
            state.inner().clone(),
        )
        .await;
        assert!(matches!(
            result,
            Err(Error::Conflict(message))
                if message == "engine search reservation is invalid or expired"
        ));
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn report_analysis_cancellation_after_resource_verification_sends_no_resource_option() {
        let (directory, app, engine, resource) = resource_engine_fixture();
        let cancellation = CancellationToken::new();
        let cancellation_for_hook = cancellation.clone();
        set_after_resource_verification_hook(Some(Box::new(move || {
            Box::pin(async move {
                cancellation_for_hook.cancel();
            })
        })));
        let state = app.state::<AppState>().inner().clone();
        let result = analyze_game_core(
            "report-cancel-after-verify".into(),
            engine,
            "report-cancel-after-verify-engine".into(),
            GoMode::Depth(1),
            AnalysisOptions {
                fen: start_fen().to_string(),
                moves: Vec::new(),
                annotate_novelties: false,
                reference_db: None,
            },
            vec![EngineOption::Resource {
                name: "EvalFile".into(),
                resources: vec![resource],
            }],
            state,
            app.clone(),
            cancellation,
        )
        .await;
        set_after_resource_verification_hook(None);
        assert!(matches!(
            result,
            Err(Error::Cancellation | Error::AnalysisCancelled)
        ));
        let capture =
            std::fs::read_to_string(directory.path().join("capture.log")).unwrap_or_default();
        assert!(!capture.contains("eval="));
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn report_resource_cancellation_at_write_boundary_sends_no_resource_option() {
        let (directory, app, engine, resource) = resource_engine_fixture();
        let cancellation = CancellationToken::new();
        let cancellation_for_hook = cancellation.clone();
        EngineActor::set_test_option_before_send_hook(Some(Box::new(move || {
            cancellation_for_hook.cancel();
        })));
        let state = app.state::<AppState>().inner().clone();
        let result = analyze_game_core(
            "report-cancel-at-write".into(),
            engine,
            "report-cancel-at-write-engine".into(),
            GoMode::Depth(1),
            AnalysisOptions {
                fen: start_fen().to_string(),
                moves: Vec::new(),
                annotate_novelties: false,
                reference_db: None,
            },
            vec![EngineOption::Resource {
                name: "EvalFile".into(),
                resources: vec![resource],
            }],
            state,
            app.clone(),
            cancellation,
        )
        .await;
        EngineActor::set_test_option_before_send_hook(None);
        assert!(matches!(
            result,
            Err(Error::Cancellation | Error::AnalysisCancelled)
        ));
        let capture =
            std::fs::read_to_string(directory.path().join("capture.log")).unwrap_or_default();
        assert!(!capture.contains("eval="));
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn interactive_stop_after_resource_verification_sends_no_option_or_go() {
        let (directory, app, engine, resource) = resource_engine_fixture();
        let state = app.state::<AppState>();
        let id = "interactive-stop-after-verify-engine";
        let tab = "interactive-stop-after-verify";
        let key = EngineKey::new(tab.into(), id.into()).unwrap();
        let generation = state
            .engine_supervisor
            .prepare_engine_search(key, id.into(), engine.id.clone())
            .await
            .unwrap();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        set_after_resource_verification_hook(Some(Box::new(move || {
            Box::pin(async move {
                let _ = entered_tx.send(());
                let _ = release_rx.await;
            })
        })));
        let state_for_core = state.inner().clone();
        let app_for_core = app.clone();
        let generation_for_core = generation.clone();
        let core = tokio::spawn(async move {
            get_best_moves_core(
                id.into(),
                engine,
                tab.into(),
                GoMode::Depth(1),
                EngineOptions {
                    fen: start_fen().to_string(),
                    moves: Vec::new(),
                    extra_options: vec![EngineOption::Resource {
                        name: "EvalFile".into(),
                        resources: vec![resource],
                    }],
                },
                generation_for_core,
                app_for_core,
                state_for_core,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), entered_rx)
            .await
            .unwrap()
            .unwrap();
        let supervisor = state.engine_supervisor.clone();
        let stop_key = EngineKey::new(tab.into(), id.into()).unwrap();
        let stop_supervisor = supervisor.clone();
        let stop_generation = generation.parse().unwrap();
        let stop = tokio::spawn(async move {
            stop_supervisor
                .stop_generation(&stop_key, Some(stop_generation))
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !supervisor
                .get_exact(&EngineKey::new(tab.into(), id.into()).unwrap())
                .unwrap()
                .current_search()
                .unwrap()
                .cancelled
                .load(Ordering::SeqCst)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        release_tx.send(()).unwrap();
        stop.await.unwrap().unwrap();
        set_after_resource_verification_hook(None);
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), core)
                .await
                .unwrap()
                .unwrap(),
            Err(Error::Cancellation)
        ));
        let capture =
            std::fs::read_to_string(directory.path().join("capture.log")).unwrap_or_default();
        assert!(!capture.contains("eval=") && !capture.contains("go-ready"));
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn interactive_stop_between_options_and_go_rejects_go_and_keeps_actor_warm() {
        let (directory, app, engine, resource) = resource_engine_fixture();
        let state = app.state::<AppState>();
        let id = "interactive-stop-before-go-engine";
        let tab = "interactive-stop-before-go";
        let key = EngineKey::new(tab.into(), id.into()).unwrap();
        let generation = state
            .engine_supervisor
            .prepare_engine_search(key, id.into(), engine.id.clone())
            .await
            .unwrap();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let attempted = Arc::new(AtomicBool::new(false));
        let attempted_for_hook = attempted.clone();
        set_interactive_go_attempt_hook(Some(Box::new(move || {
            attempted_for_hook.store(true, Ordering::SeqCst);
        })));
        set_interactive_before_go_hook(Some(Box::new(move || {
            Box::pin(async move {
                let _ = entered_tx.send(());
                let _ = release_rx.await;
            })
        })));
        let state_for_core = state.inner().clone();
        let app_for_core = app.clone();
        let generation_for_core = generation.clone();
        let core = tokio::spawn(async move {
            get_best_moves_core(
                id.into(),
                engine,
                tab.into(),
                GoMode::Depth(1),
                EngineOptions {
                    fen: start_fen().to_string(),
                    moves: Vec::new(),
                    extra_options: vec![EngineOption::Resource {
                        name: "EvalFile".into(),
                        resources: vec![resource],
                    }],
                },
                generation_for_core,
                app_for_core,
                state_for_core,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), entered_rx)
            .await
            .unwrap()
            .unwrap();
        let supervisor = state.engine_supervisor.clone();
        let stop_key = EngineKey::new(tab.into(), id.into()).unwrap();
        let stop_supervisor = supervisor.clone();
        let stop_generation = generation.parse().unwrap();
        let stop = tokio::spawn(async move {
            stop_supervisor
                .stop_generation(&stop_key, Some(stop_generation))
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while !supervisor
                .get_exact(&EngineKey::new(tab.into(), id.into()).unwrap())
                .unwrap()
                .current_search()
                .unwrap()
                .cancelled
                .load(Ordering::SeqCst)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        release_tx.send(()).unwrap();
        stop.await.unwrap().unwrap();
        set_interactive_before_go_hook(None);
        let result = tokio::time::timeout(Duration::from_secs(2), core)
            .await
            .unwrap()
            .unwrap();
        set_interactive_go_attempt_hook(None);
        assert!(!attempted.load(Ordering::SeqCst));
        assert!(matches!(result, Err(Error::Cancellation)));
        let capture =
            std::fs::read_to_string(directory.path().join("capture.log")).unwrap_or_default();
        assert!(capture.contains("eval=") && !capture.contains("go-ready"));
        supervisor
            .stop_generation(&EngineKey::new(tab.into(), id.into()).unwrap(), None)
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn report_resource_replacement_between_positions_fails_closed_without_second_setoption() {
        let (directory, app, engine, resource) = resource_engine_fixture();
        let state = app.state::<AppState>().inner().clone();
        let mut core = tokio::spawn(async move {
            analyze_game_core(
                "report-resource-replacement".into(),
                engine,
                "report-resource-replacement-engine".into(),
                GoMode::Depth(1),
                AnalysisOptions {
                    fen: start_fen().to_string(),
                    moves: vec!["e2e4".into()],
                    annotate_novelties: false,
                    reference_db: None,
                },
                vec![
                    EngineOption::String {
                        name: "Threads".into(),
                        value: "2".into(),
                    },
                    EngineOption::Resource {
                        name: "EvalFile".into(),
                        resources: vec![resource],
                    },
                ],
                state,
                app.clone(),
                CancellationToken::new(),
            )
            .await
        });
        let ready = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let capture = std::fs::read_to_string(directory.path().join("capture.log"))
                    .unwrap_or_default();
                if capture.contains("go-ready") {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        if ready.is_err() {
            let core_result = tokio::time::timeout(Duration::from_secs(1), &mut core).await;
            let capture =
                std::fs::read_to_string(directory.path().join("capture.log")).unwrap_or_default();
            panic!("report core did not reach go-ready: core={core_result:?}, capture={capture:?}");
        }
        let resource_path = directory.path().join("weights.nnue");
        std::fs::rename(
            &resource_path,
            directory.path().join("weights-original.nnue"),
        )
        .unwrap();
        std::fs::write(&resource_path, b"replacement").unwrap();
        std::fs::write(directory.path().join("release"), b"").unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), core)
            .await
            .unwrap()
            .unwrap();
        assert!(result.is_err());
        let capture = std::fs::read_to_string(directory.path().join("capture.log")).unwrap();
        assert_eq!(capture.matches("option=setoption name Threads").count(), 1);
        assert_eq!(capture.matches("option=setoption name MultiPV").count(), 1);
        assert_eq!(
            capture
                .matches("option=setoption name UCI_Chess960")
                .count(),
            1
        );
        assert_eq!(capture.matches("eval=").count(), 1);
        assert!(!capture.contains("read=replacement"));
    }

    #[tokio::test]
    async fn retire_engine_command_reaps_and_tombstones_owner() {
        let app = engine_test_app();
        let state = app.state::<AppState>();
        let supervisor = &state.engine_supervisor;
        let key = EngineKey::new("tab".into(), "engine-id".into()).unwrap();
        let (actor, _) = EngineActor::recording_test_actor(&[]);
        supervisor
            .replace_handle(
                key.clone(),
                actor,
                "engine-id".into(),
                crate::infra::path_authority::PathRef {
                    id: "engine-path".into(),
                },
            )
            .await
            .unwrap();

        retire_engine("engine-id".into(), app.state::<AppState>())
            .await
            .unwrap();

        assert!(supervisor.get_exact(&key).is_none());
        let (replacement, _) = EngineActor::recording_test_actor(&[]);
        assert!(supervisor
            .replace_handle(
                key,
                replacement,
                "engine-id".into(),
                crate::infra::path_authority::PathRef {
                    id: "engine-path".into(),
                },
            )
            .await
            .is_err());

        assert_rejects_invalid_engine_id(
            retire_engine("engine-id\n".into(), app.state::<AppState>()).await,
        );
    }

    #[tokio::test]
    async fn retire_engine_binary_command_round_trip_readmits_current_pair() {
        let app = engine_test_app();
        let state = app.state::<AppState>();
        let supervisor = &state.engine_supervisor;
        let key = EngineKey::new("tab".into(), "engine-id".into()).unwrap();
        let handle = EngineHandle {
            id: crate::infra::path_authority::PathRef {
                id: "old-path".into(),
            },
            kind: crate::infra::path_authority::EngineHandleKind::Engine,
        };
        let current = EngineHandle {
            id: crate::infra::path_authority::PathRef {
                id: "new-path".into(),
            },
            kind: crate::infra::path_authority::EngineHandleKind::Engine,
        };
        let (actor, _) = EngineActor::recording_test_actor(&[]);
        supervisor
            .replace_handle(key.clone(), actor, "engine-id".into(), handle.id.clone())
            .await
            .unwrap();
        retire_engine_binary(
            "engine-id".into(),
            handle.clone(),
            current.clone(),
            app.state::<AppState>(),
        )
        .await
        .unwrap();
        assert!(supervisor.get_exact(&key).is_none());
        assert_rejects_invalid_engine_id(
            retire_engine_binary(
                "engine-id\n".into(),
                handle.clone(),
                current.clone(),
                app.state::<AppState>(),
            )
            .await,
        );
        let (actor, _) = EngineActor::recording_test_actor(&[]);
        assert!(supervisor
            .replace_handle(key.clone(), actor, "engine-id".into(), handle.id.clone())
            .await
            .is_err());
        let (actor, _) = EngineActor::recording_test_actor(&[]);
        supervisor
            .replace_handle(key.clone(), actor, "engine-id".into(), current.id.clone())
            .await
            .unwrap();
        retire_engine_binary(
            "engine-id".into(),
            current.clone(),
            handle.clone(),
            app.state::<AppState>(),
        )
        .await
        .unwrap();
        assert!(supervisor.get_exact(&key).is_none());
        let (actor, _) = EngineActor::recording_test_actor(&[]);
        supervisor
            .replace_handle(key.clone(), actor, "engine-id".into(), handle.id.clone())
            .await
            .unwrap();
        assert_eq!(supervisor.get_exact(&key).unwrap().executable, handle.id);
        let (actor, _) = EngineActor::recording_test_actor(&[]);
        assert!(matches!(
            supervisor
                .replace_handle(key.clone(), actor, "engine-id".into(), current.id)
                .await,
            Err(Error::Conflict(message)) if message == "engine binary pair is retired"
        ));
        assert_eq!(supervisor.get_exact(&key).unwrap().executable, handle.id);
        supervisor.terminate_all().await.unwrap();
    }

    #[tokio::test]
    async fn engine_logs_command_contract_distinguishes_absent_and_disconnected() {
        let supervisor = crate::engine::EngineSupervisor::default();
        let missing = EngineKey::new("tab".into(), "missing".into()).unwrap();
        assert!(get_engine_logs_from_supervisor(&supervisor, &missing)
            .await
            .unwrap()
            .is_empty());

        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let (actor, _) = EngineActor::recording_test_actor(&[]);
        let supervised = supervisor
            .replace_handle(
                key.clone(),
                actor.clone(),
                "engine".into(),
                crate::infra::path_authority::PathRef {
                    id: "engine-path".into(),
                },
            )
            .await
            .unwrap();
        actor.terminate().await.unwrap();
        assert!(matches!(
            get_engine_logs_from_supervisor(&supervisor, &key).await,
            Err(Error::EngineDisconnected)
        ));
        supervisor
            .terminate_exact(&key, supervised.generation)
            .await
            .unwrap();
    }

    #[test]
    fn interactive_commands_register_through_engine_process_new() {
        let source = include_str!("chess.rs");
        for function in ["pub async fn get_best_moves", "pub async fn analyze_game"] {
            let start = source.find(function).expect("command must exist");
            let suffix = &source[start + function.len()..];
            // Delimit before `mod tests` so later test-only `replace_handle`
            // call sites are not part of the production command body.
            let end = [
                suffix.find("\nmod tests"),
                suffix.find("\n#[tauri::command]"),
            ]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(suffix.len());
            let body = &suffix[..end];
            if function == "pub async fn get_best_moves" {
                assert!(body.contains("get_best_moves_core("));
            } else {
                assert!(body.contains("analyze_game_core("));
            }
        }
    }

    #[test]
    fn config_probe_uses_a_unique_supervised_key() {
        let source = include_str!("chess.rs");
        let body = source
            .split_once("pub async fn get_engine_config(")
            .map(|(_, body)| body)
            .expect("get_engine_config must exist");
        assert!(body.contains("Uuid::new_v4()"));
        assert!(body.contains("EngineKey::new(\"engine-config\""));
        assert!(body.contains("spawn_registered("));
        assert!(body.contains("terminate_now()"));
    }

    fn pos(fen: &str) -> Chess {
        let fen: Fen = fen.parse().unwrap();
        Chess::from_setup(fen.into_setup(), shakmaty::CastlingMode::Chess960).unwrap()
    }

    fn start_fen() -> Fen {
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
            .parse()
            .unwrap()
    }

    fn parsed_info(line: &str) -> BestMoves {
        match parse_one(line) {
            UciMessage::Info(attrs) => {
                parse_uci_attrs(attrs, &start_fen().to_string(), &[]).unwrap()
            }
            other => panic!("expected info, got {other:?}"),
        }
    }

    fn assert_uci_line_is_unknown(line: &str) {
        let parsed = std::panic::catch_unwind(|| parse_one(line));
        assert!(parsed.is_ok(), "parser unwound for {line}");
        assert!(
            matches!(parsed.unwrap(), UciMessage::Unknown(text, None) if text == line),
            "expected Unknown with the original line for {line}"
        );
    }

    #[test]
    fn uci_numeric_wdl_overflow_is_unknown_without_unwind() {
        for line in [
            "info depth 8 score cp 34 wdl 2147483648 0 0 pv e2e4",
            "info depth 8 score cp 34 wdl 0 2147483648 0 pv e2e4",
            "info depth 8 score cp 34 wdl 0 0 2147483648 pv e2e4",
            "info depth 8 score cp 34 wdl -2147483649 0 0 pv e2e4",
        ] {
            assert_uci_line_is_unknown(line);
        }
    }

    #[test]
    fn uci_numeric_score_overflow_is_unknown_without_unwind() {
        for line in [
            "info depth 8 score cp 2147483648 pv e2e4",
            "info depth 8 score cp -2147483649 pv e2e4",
            "info depth 8 score mate 2147483648 pv e2e4",
            "info depth 8 score mate -2147483649 pv e2e4",
        ] {
            assert_uci_line_is_unknown(line);
        }
    }

    #[test]
    fn uci_numeric_score_and_wdl_boundaries_are_exact() {
        for (line, expected) in [
            ("info score cp 2147483647 pv e2e4", ScoreValue::Cp(i32::MAX)),
            (
                "info score cp -2147483648 pv e2e4",
                ScoreValue::Cp(i32::MIN),
            ),
            (
                "info score mate 2147483647 pv e2e4",
                ScoreValue::Mate(i32::MAX),
            ),
            (
                "info score mate -2147483648 pv e2e4",
                ScoreValue::Mate(i32::MIN),
            ),
        ] {
            assert_eq!(parsed_info(line).score.value, expected, "{line}");
        }
        let parsed = parsed_info("info score cp 34 wdl 2147483647 0 -2147483648 pv e2e4");
        assert_eq!(parsed.score.value, ScoreValue::Cp(34));
        assert_eq!(parsed.score.wdl, Some((i32::MAX, 0, i32::MIN)));
    }

    #[test]
    fn uci_numeric_non_score_overflow_keeps_upstream_default() {
        let parsed = parsed_info("info depth 4294967296 score cp 34 pv e2e4");
        assert_eq!(parsed.depth, 0);
        assert_eq!(parsed.score.value, ScoreValue::Cp(34));
    }

    #[test]
    fn uci_numeric_thirteen_digit_nodes_keeps_the_rest_of_the_line() {
        let parsed = parsed_info("info depth 30 score cp 10 nodes 1234567890123 pv e2e4");
        assert_eq!(parsed.depth, 30);
        assert_eq!(parsed.score.value, ScoreValue::Cp(10));
        assert_eq!(parsed.nodes, 1_234_567_890_123);
        assert_eq!(parsed.san_moves, ["e4"]);

        let parsed = parsed_info("info nodes 1234567890123 depth 30 score cp 10 pv e2e4");
        assert_eq!(parsed.depth, 30);
        assert_eq!(parsed.score.value, ScoreValue::Cp(10));
        assert_eq!(parsed.nodes, 1_234_567_890_123);
        assert_eq!(parsed.san_moves, ["e4"]);
    }

    #[test]
    fn uci_numeric_counters_beyond_u64_keep_the_line() {
        let parsed = parsed_info(
            "info depth 30 score cp 10 nodes 18446744073709551616 nps 99999999999999999999 \
             tbhits 123456789012345678901234 pv e2e4",
        );
        assert_eq!(parsed.nodes, 0);
        assert_eq!(parsed.nps, 0);
        assert_eq!(parsed.score.value, ScoreValue::Cp(10));
        assert_eq!(parsed.san_moves, ["e4"]);
    }

    #[test]
    fn uci_numeric_time_outside_duration_range_does_not_unwind() {
        for line in [
            "info depth 30 time -9223372036854775808 score cp 10 pv e2e4",
            "info depth 30 time 9223372036854775808 score cp 10 pv e2e4",
            "info depth 30 time 1234567890123 score cp 10 pv e2e4",
        ] {
            let parsed = std::panic::catch_unwind(|| parse_one(line));
            let Ok(UciMessage::Info(attrs)) = parsed else {
                panic!("expected info without unwind for {line}");
            };
            assert!(
                attrs.iter().any(|a| matches!(a, UciInfoAttribute::Pv(_))),
                "{line}"
            );
        }
    }

    #[test]
    fn report_positions_tolerate_stale_castling_rights_in_the_root() {
        let stale: Fen = "4k3/8/8/8/8/8/4P3/4K3 w KQkq - 0 1".parse().unwrap();
        let moves = ["e2e4".to_string()];
        let fens =
            collect_report_positions(stale.clone(), &moves, &CancellationToken::new()).unwrap();
        assert_eq!(fens.len(), 2);
        assert_eq!(fens[0].fen, stale);
        assert_eq!(fens[1].fen.to_string(), "4k3/8/8/8/4P3/8/8/4K3 b - - 0 1");
    }

    #[test]
    fn novelty_queries_cover_positions_after_each_move_but_not_the_start() {
        let custom: Fen = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1".parse().unwrap();
        let moves = ["e2e4".to_string(), "e8d7".to_string()];
        let fens =
            collect_report_positions(custom.clone(), &moves, &CancellationToken::new()).unwrap();
        assert_eq!(fens.len(), 3);
        let queried: Vec<String> = novelty_queries(&fens)
            .into_iter()
            .map(|query| query.position.unwrap().fen)
            .collect();
        assert_eq!(
            queried,
            [fens[1].fen.to_string(), fens[2].fen.to_string()],
            "the start position {custom} must not be queried"
        );
    }

    #[test]
    fn novelty_never_lands_on_the_start_position() {
        // A custom start absent from the reference database: the lookup covers
        // the positions after each move, so the first move is the novelty.
        assert_eq!(
            novelty_outcome(&[false]),
            NoveltyOutcome::Found { position: 1 }
        );
        // Standard start present, third move leaves the reference games.
        assert_eq!(
            novelty_outcome(&[true, true, false]),
            NoveltyOutcome::Found { position: 3 }
        );
        // Every position present, or a game without moves.
        assert_eq!(
            novelty_outcome(&[true, true, true, true]),
            NoveltyOutcome::NotFound
        );
        assert_eq!(novelty_outcome(&[]), NoveltyOutcome::NotFound);
    }

    #[test]
    fn novelty_failures_cancel_only_for_cancellation() {
        assert!(matches!(
            novelty_failure(Error::Cancellation, false),
            Err(Error::Cancellation)
        ));
        assert!(matches!(
            novelty_failure(Error::AnalysisCancelled, false),
            Err(Error::AnalysisCancelled)
        ));
        assert!(matches!(
            novelty_failure(Error::StaleGame, true),
            Err(Error::AnalysisCancelled)
        ));
        assert!(matches!(
            novelty_failure(Error::StaleGame, false),
            Ok(Error::StaleGame)
        ));
        assert!(matches!(
            novelty_failure(Error::MissingReferenceDatabase, false),
            Ok(Error::MissingReferenceDatabase)
        ));
    }

    fn parsed_black_info(line: &str) -> BestMoves {
        let UciMessage::Info(attrs) = parse_one(line) else {
            panic!("expected info for {line}");
        };
        parse_uci_attrs(
            attrs,
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
            &[],
        )
        .unwrap()
    }

    #[test]
    fn uci_numeric_black_to_move_cp_minimum_saturates() {
        let parsed = parsed_black_info("info score cp -2147483648 pv e7e5");
        assert_eq!(parsed.score.value, ScoreValue::Cp(i32::MAX));
        assert_eq!(parsed.san_moves, ["e5"]);
    }

    #[test]
    fn uci_numeric_black_to_move_mate_minimum_saturates() {
        let parsed = parsed_black_info("info score mate -2147483648 pv e7e5");
        assert_eq!(parsed.score.value, ScoreValue::Mate(i32::MAX));
        assert_eq!(parsed.san_moves, ["e5"]);
    }

    const UCI_NUMERIC_SEARCH_LINES: [&str; 4] = [
        "info depth 8 multipv 1 score cp 2147483648 nodes 100 pv e2e4",
        "info depth 8 multipv 1 score cp 34 wdl 2147483648 0 0 nodes 100 pv e2e4",
        "info depth 8 multipv 1 score cp 34 nodes 100 pv d2d4",
        "bestmove d2d4",
    ];

    #[tokio::test]
    async fn uci_numeric_interactive_ignores_overflow_and_publishes_real_score() {
        let mut probe = interactive_search_probe(&UCI_NUMERIC_SEARCH_LINES, false).await;
        assert_eq!(probe.process.real_multipv, 1);
        let result = process_interactive_search_output(
            &mut probe.process,
            "engine",
            "tab",
            &probe.supervised,
            &probe.app,
        )
        .await;
        probe.actor.terminate().await.unwrap();
        result.unwrap();

        let payloads = probe.emitted.lock().unwrap();
        let terminal = payloads.last().unwrap();
        assert_eq!(terminal["progress"], 100.0);
        let best = &terminal["bestLines"];
        assert_eq!(best.as_array().unwrap().len(), 1);
        assert_eq!(best[0]["sanMoves"], serde_json::json!(["d4"]));
        assert_eq!(best[0]["uciMoves"], serde_json::json!(["d2d4"]));
        assert_eq!(
            best[0]["score"]["value"],
            serde_json::json!({ "type": "cp", "value": 34 })
        );
        for payload in payloads.iter() {
            for line in payload["bestLines"].as_array().unwrap() {
                assert_ne!(
                    line["score"]["value"],
                    serde_json::json!({ "type": "cp", "value": 0 })
                );
            }
        }
    }

    #[tokio::test]
    async fn uci_numeric_report_ignores_overflow_and_keeps_only_legal_line() {
        let (actor, _) = EngineActor::recording_test_actor(&UCI_NUMERIC_SEARCH_LINES);
        let supervised = SupervisedEngine::new(
            1,
            "engine".into(),
            crate::infra::path_authority::PathRef {
                id: "engine-path".into(),
            },
            actor.clone(),
            Arc::new(AtomicBool::new(false)),
        );
        let mut process = EngineProcess {
            base: actor.clone(),
            last_depth: 0,
            best_moves: Vec::new(),
            last_best_moves: Vec::new(),
            last_progress: 0.0,
            options: EngineOptions {
                fen: start_fen().to_string(),
                moves: Vec::new(),
                extra_options: Vec::new(),
            },
            resource_leases: Vec::new(),
            go_mode: GoMode::Depth(8),
            running: false,
            request_id: None,
            real_multipv: 1,
            start: Instant::now(),
        };
        let result = analyze_position_with_owner(
            &mut process,
            &supervised,
            &CancellationToken::new(),
            &GoMode::Depth(8),
            &[],
        )
        .await;
        actor.terminate().await.unwrap();
        let best = result.unwrap();
        assert_eq!(best.len(), 1);
        let best = &best[0];
        assert_eq!(best.uci_moves, ["d2d4"]);
        assert_eq!(best.san_moves, ["d4"]);
        assert_eq!(best.score.value, ScoreValue::Cp(34));
        assert_eq!(best.score.wdl, None);
        assert_eq!(best.depth, 8);
        assert_eq!(best.nodes, 100);
    }

    #[test]
    fn uci_numeric_overflow_is_not_terminal_but_bestmove_is() {
        assert!(!matches!(
            parse_one("info depth 8 score cp 34 wdl 2147483648 0 0 pv e2e4"),
            UciMessage::BestMove { .. }
        ));
        assert!(matches!(
            parse_one("bestmove e2e4"),
            UciMessage::BestMove { .. }
        ));
    }

    fn ingest(
        collected: &mut Vec<BestMoves>,
        last_depth: u32,
        real_multipv: u16,
        line: &str,
    ) -> Option<CompleteMultiPv> {
        ingest_info_line(collected, last_depth, real_multipv, parsed_info(line))
    }

    #[test]
    fn ingest_skips_lowerbound_and_keeps_the_exact_score() {
        let mut collected = Vec::new();
        assert!(ingest(
            &mut collected,
            0,
            1,
            "info depth 8 multipv 1 score cp 12 lowerbound nodes 100 pv e2e4"
        )
        .is_none());
        assert!(collected.is_empty());

        let set = ingest(
            &mut collected,
            0,
            1,
            "info depth 8 multipv 1 score cp 34 nodes 100 pv e2e4",
        )
        .expect("exact score should complete MultiPV 1");
        assert!(set.publishable);
        assert!(collected.is_empty());
        assert_eq!(set.lines[0].score.value, ScoreValue::Cp(34));
        assert_ne!(set.lines[0].score.lower_bound, Some(true));
    }

    #[test]
    fn ingest_skips_upperbound() {
        let mut collected = Vec::new();
        assert!(ingest(
            &mut collected,
            0,
            1,
            "info depth 8 multipv 1 score cp 12 upperbound nodes 100 pv e2e4"
        )
        .is_none());
        assert!(collected.is_empty());
    }

    #[test]
    fn ingest_bound_between_pvs_does_not_desync_sequence() {
        let mut collected = Vec::new();
        assert!(ingest(
            &mut collected,
            0,
            2,
            "info depth 8 multipv 1 score cp 20 nodes 100 pv e2e4"
        )
        .is_none());
        assert_eq!(collected.len(), 1);

        assert!(ingest(
            &mut collected,
            0,
            2,
            "info depth 8 multipv 1 score cp 40 lowerbound nodes 100 pv e2e4"
        )
        .is_none());
        assert_eq!(collected.len(), 1);

        let set = ingest(
            &mut collected,
            0,
            2,
            "info depth 8 multipv 2 score cp 5 nodes 100 pv d2d4",
        )
        .expect("PV2 should complete after a bound on PV1");
        assert!(set.publishable);
        assert!(collected.is_empty());
        assert_eq!(set.lines.len(), 2);
        assert_eq!(set.lines[0].score.value, ScoreValue::Cp(20));
        assert_eq!(set.lines[1].score.value, ScoreValue::Cp(5));
    }

    #[test]
    fn ingest_rejects_out_of_sequence_multipv() {
        let mut collected = Vec::new();
        assert!(ingest(
            &mut collected,
            0,
            2,
            "info depth 8 multipv 2 score cp 5 nodes 100 pv d2d4"
        )
        .is_none());
        assert!(collected.is_empty());
    }

    #[test]
    fn ingest_mixed_depth_set_is_complete_but_not_publishable() {
        let mut collected = Vec::new();
        assert!(ingest(
            &mut collected,
            0,
            2,
            "info depth 8 multipv 1 score cp 20 nodes 100 pv e2e4"
        )
        .is_none());
        let set = ingest(
            &mut collected,
            0,
            2,
            "info depth 7 multipv 2 score cp 5 nodes 100 pv d2d4",
        )
        .expect("mixed depths still complete the sequence");
        assert!(collected.is_empty());
        assert!(!set.publishable);
        assert_eq!(set.lines.len(), 2);
    }

    #[test]
    fn ingest_shallower_than_last_depth_is_not_publishable() {
        let mut collected = Vec::new();
        let set = ingest(
            &mut collected,
            10,
            1,
            "info depth 8 multipv 1 score cp 20 nodes 100 pv e2e4",
        )
        .expect("a shallower set still completes MultiPV 1");
        assert!(collected.is_empty());
        assert!(!set.publishable);
        assert_eq!(set.depth, 8);
    }

    #[test]
    fn parse_uci_attrs_rejects_pv_without_score() {
        let attrs = match parse_one("info depth 8 multipv 1 nodes 100 pv e2e4") {
            UciMessage::Info(attrs) => attrs,
            other => panic!("expected info, got {other:?}"),
        };
        assert!(matches!(
            parse_uci_attrs(attrs, &start_fen().to_string(), &[]),
            Err(Error::NoMovesFound)
        ));
    }

    #[test]
    fn production_uci_paths_share_ingest_and_live_publish() {
        let source = include_str!("chess.rs");
        let production = source
            .split_once("mod tests {")
            .map(|(prefix, _)| prefix)
            .expect("test module should exist");

        for (function, expected_call) in [
            (
                "async fn process_interactive_search_output",
                "ingest_info_line(",
            ),
            (
                "async fn process_interactive_search_output",
                "emit_live_interactive_best_moves(",
            ),
            (
                "async fn process_interactive_search_output",
                "interactive_best_moves_payload(",
            ),
            ("pub async fn get_best_moves", "get_best_moves_core("),
            (
                "async fn get_best_moves_core<",
                "process_interactive_search_output(",
            ),
            ("pub async fn analyze_game(", "analyze_game_core("),
            ("async fn analyze_game_core<", "AnalysisSession::start("),
            ("async fn analyze_game_core<", ".analyze("),
            (
                "pub(crate) async fn analyze(",
                "analyze_position_with_owner(",
            ),
            ("async fn analyze_position_with_owner(", "ingest_info_line("),
        ] {
            let body = crate::infra::blocking::source_scan::body_at_indent(production, function);
            assert!(
                body.contains(expected_call),
                "{function} must use {expected_call}"
            );
        }
    }

    fn sacrifice(before: &str, uci: &str) -> bool {
        let before = pos(before);
        let mv = UciMove::from_ascii(uci.as_bytes())
            .unwrap()
            .to_move(&before)
            .unwrap();
        let mut after = before.clone();
        after.play_unchecked(&mv);
        let terminal = report_terminal(&after).is_some();
        is_sacrifice(&before, &after, terminal, &CancellationToken::new()).unwrap()
    }

    #[test]
    fn declining_a_free_knight_is_no_sacrifice() {
        // White ignores the knight on e5 that Qxe5 would win.
        assert!(!sacrifice(
            "rnbqkb1r/pppp1ppp/8/4n3/8/8/PPPPQPPP/RNB1KBNR w KQkq - 0 1",
            "b1c3"
        ));
    }

    #[test]
    fn missing_a_mate_in_one_is_no_sacrifice() {
        // Qd8 mates; a quiet king move instead gives nothing away.
        assert!(!sacrifice("6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1", "g1f1"));
    }

    #[test]
    fn an_underpromotion_is_no_sacrifice() {
        assert!(!sacrifice("8/4P1k1/8/8/8/8/8/4K3 w - - 0 1", "e7e8n"));
    }

    #[test]
    fn a_king_move_while_the_opponent_promotes_anyway_is_no_sacrifice() {
        assert!(!sacrifice("8/8/8/8/8/k7/6p1/K7 w - - 0 1", "a1b1"));
    }

    #[test]
    fn bishop_takes_h7_check_is_a_sacrifice() {
        assert!(sacrifice(
            "r1bq1rk1/pppn1ppp/4pn2/3p4/1bPP4/2NBPN2/PP3PPP/R1BQK2R w KQ - 0 1",
            "d3h7"
        ));
    }

    #[test]
    fn an_exchange_sacrifice_is_a_sacrifice() {
        // Rxc6, bxc6: a rook for a knight.
        assert!(sacrifice(
            "r1bqkb1r/p1pp1ppp/1pn2n2/4p3/4P3/2R5/PPPP1PPP/1NBQKBNR w Kkq - 0 1",
            "c3c6"
        ));
    }

    #[test]
    fn a_queen_trade_is_no_sacrifice() {
        assert!(!sacrifice(
            "rnbqkbnr/ppp2ppp/8/4p3/4P3/8/PPP2PPP/RNBQKBNR w KQkq - 0 1",
            "d1d8"
        ));
    }

    #[test]
    fn a_terminal_position_is_no_sacrifice() {
        // The mating move leaves a queen en prise to nothing: terminal gives false.
        assert!(!sacrifice("6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1", "d1d8"));
    }

    #[test]
    fn a_capture_search_that_exhausts_its_budget_is_no_sacrifice() {
        // Twelve queens attacking each other: the capture tree is far larger than the budget.
        let before = pos("5rrk/6pp/8/1qqqqqq1/1QQQQQQ1/8/PP6/KRR5 w - - 0 1");
        let mut search = CaptureSearch {
            nodes_left: SACRIFICE_NODE_BUDGET,
            cancellation: &CancellationToken::new(),
        };
        assert!(matches!(
            search.qsearch(&before, -MATE_SCORE - 1, MATE_SCORE + 1),
            Err(CaptureSearchStop::Budget)
        ));
        let mv = before.legal_moves()[0].clone();
        let mut after = before.clone();
        after.play_unchecked(&mv);
        let started = Instant::now();
        assert!(!is_sacrifice(&before, &after, false, &CancellationToken::new()).unwrap());
        assert!(started.elapsed() < std::time::Duration::from_secs(30));
    }

    #[test]
    fn report_positions_mark_checkmate_stalemate_and_bare_kings() {
        let moves = |list: &[&str]| list.iter().map(|m| m.to_string()).collect::<Vec<_>>();
        let token = CancellationToken::new();
        let mate = collect_report_positions(
            start_fen(),
            &moves(&["f2f3", "e7e5", "g2g4", "d8h4"]),
            &token,
        )
        .unwrap();
        assert_eq!(mate.len(), 5);
        assert!(mate[..4].iter().all(|entry| entry.terminal.is_none()));
        assert_eq!(mate[4].terminal, Some(ReportTerminal::Checkmate));

        let stalemate_root: Fen = "7k/8/7K/5Q2/8/8/8/8 w - - 0 1".parse().unwrap();
        let stalemate =
            collect_report_positions(stalemate_root, &moves(&["f5f7"]), &token).unwrap();
        assert_eq!(stalemate.len(), 2);
        assert_eq!(stalemate[1].terminal, Some(ReportTerminal::Draw));

        let bare_root: Fen = "8/8/8/3k4/8/3K4/3q4/8 w - - 0 1".parse().unwrap();
        let bare = collect_report_positions(bare_root, &moves(&["d3d2", "d5e4"]), &token).unwrap();
        assert_eq!(bare.len(), 3);
        assert_eq!(bare[0].terminal, None);
        assert_eq!(bare[1].terminal, Some(ReportTerminal::Draw));
        assert_eq!(bare[2].terminal, Some(ReportTerminal::Draw));
    }

    #[test]
    fn sacrifice_flags_stop_at_the_ply_where_cancellation_arrives() {
        let token = CancellationToken::new();
        let replay = collect_report_positions(
            start_fen(),
            &["e2e4", "e7e5", "g1f3"].map(str::to_string),
            &token,
        )
        .unwrap();
        let positions: Vec<(Chess, bool)> = replay
            .iter()
            .map(|entry| (entry.position.clone(), entry.terminal.is_some()))
            .collect();
        assert_eq!(
            sacrifice_flags_blocking(&positions, &token, &mut |_| {}).unwrap(),
            [false; 4]
        );
        let cancel_at = token.clone();
        assert!(matches!(
            sacrifice_flags_blocking(&positions, &token, &mut |ply| {
                if ply == 1 {
                    cancel_at.cancel();
                }
            }),
            Err(Error::AnalysisCancelled)
        ));
    }

    #[test]
    fn a_cancelled_capture_search_is_an_error_not_a_false_flag() {
        let before = pos("5rrk/6pp/8/1qqqqqq1/1QQQQQQ1/8/PP6/KRR5 w - - 0 1");
        let mv = before.legal_moves()[0].clone();
        let mut after = before.clone();
        after.play_unchecked(&mv);
        let token = CancellationToken::new();
        token.cancel();
        assert!(matches!(
            is_sacrifice(&before, &after, false, &token),
            Err(Error::AnalysisCancelled)
        ));
    }

    #[tokio::test]
    async fn a_cancellation_during_the_sacrifice_computation_cancels_the_report() {
        let token = CancellationToken::new();
        let replay = collect_report_positions(
            start_fen(),
            &["e2e4", "e7e5", "g1f3"].map(str::to_string),
            &token,
        )
        .unwrap();
        let positions: Vec<(Chess, bool)> = replay
            .iter()
            .map(|entry| (entry.position.clone(), entry.terminal.is_some()))
            .collect();
        let cancel_at = token.clone();
        let result = report_sacrifices(positions, token, move |ply| {
            if ply == 1 {
                cancel_at.cancel();
            }
        })
        .await;
        assert!(
            matches!(result, Err(Error::AnalysisCancelled)),
            "{result:?}"
        );
    }
}

#[derive(Clone, Type, Default, Serialize, Debug)]
pub struct EngineConfig {
    pub name: String,
    pub options: Vec<UciOptionConfig>,
}

const MAX_ENGINE_OPTIONS: usize = 512;

async fn collect_engine_configuration(base: Arc<EngineActor>) -> Result<EngineConfig, Error> {
    collect_engine_configuration_inner(base, None).await
}

fn ensure_search_not_cancelled(cancelled: Option<&AtomicBool>) -> Result<(), Error> {
    if cancelled.is_some_and(|cancelled| cancelled.load(Ordering::SeqCst)) {
        Err(Error::Cancellation)
    } else {
        Ok(())
    }
}

async fn collect_engine_configuration_inner(
    base: Arc<EngineActor>,
    cancelled: Option<&AtomicBool>,
) -> Result<EngineConfig, Error> {
    ensure_search_not_cancelled(cancelled)?;
    base.start_uci_configuration().await?;
    ensure_search_not_cancelled(cancelled)?;

    // The per-line timeout in `next_configuration_line` only protects a
    // silent process. A chatty process which never sends `uciok` must be
    // bounded too, otherwise it can keep this command alive indefinitely.
    tokio::time::timeout(EngineDeadlines::default().uciok, async {
        let mut config = EngineConfig::default();
        while let Some(line) = base.next_configuration_line().await? {
            ensure_search_not_cancelled(cancelled)?;
            if let UciMessage::Id {
                name: Some(name),
                author: _,
            } = parse_one(&line)
            {
                config.name = name;
            }
            if let UciMessage::Option(opt) = parse_one(&line) {
                if config.options.len() == MAX_ENGINE_OPTIONS {
                    return Err(Error::ResourceLimit(format!(
                        "engine advertised more than {MAX_ENGINE_OPTIONS} options"
                    )));
                }
                config.options.push(opt);
            }
            if let UciMessage::UciOk = parse_one(&line) {
                return Ok(config);
            }
        }
        Err(Error::EngineDisconnected)
    })
    .await
    .map_err(|_| Error::EngineTimeout("collecting engine configuration".into()))?
}

#[tauri::command]
#[specta::specta]
pub async fn get_engine_config(
    engine: EngineHandle,
    state: tauri::State<'_, AppState>,
) -> Result<EngineConfig, Error> {
    get_engine_config_core(engine, state.inner()).await
}

pub(crate) async fn get_engine_config_core(
    engine: EngineHandle,
    state: &AppState,
) -> Result<EngineConfig, Error> {
    let executable_ref = engine.id.clone();
    let probe_id = uuid::Uuid::new_v4().to_string();
    let key = EngineKey::new("engine-config".into(), probe_id.clone())?;
    let admission = state
        .engine_supervisor
        .admit_for_launch(key.clone(), probe_id.clone(), executable_ref.clone())
        .await?;
    let (executable, _) = resolve_launch(
        state.pgn_path_authority.clone(),
        engine,
        PathOperation::EngineConfigure,
        &[],
        &admission,
    )
    .await?;
    let (_, guard, config) = spawn_registered(
        state.engine_supervisor.clone(),
        key.clone(),
        executable,
        admission,
        collect_engine_configuration,
    )
    .await?;
    guard.terminate_now().await?;
    Ok(config)
}

/// A scripted engine process with the application state it runs under, for tests of what other
/// modules build on [`AnalysisSession`]. It answers `go` with two lines (`e2e4` at +0.12, `d2d4`
/// at +0.08) and plays `bestmove` once a file named `release` exists in the returned directory;
/// every line it is sent is appended to `capture.log` there as `wire=<line>`, and each start of
/// the process as `pid=<pid>`.
#[cfg(all(test, unix))]
pub(crate) fn scripted_analysis_engine() -> (
    tempfile::TempDir,
    tauri::AppHandle<tauri::test::MockRuntime>,
    EngineHandle,
) {
    let (directory, app, engine, _) = tests::resource_engine_fixture();
    (directory, app, engine)
}
