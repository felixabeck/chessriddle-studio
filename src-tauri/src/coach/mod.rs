//! Coach: an AI chat about the position (d-20261122-18 to d-20261122-21).
//!
//! The native side owns the connections, their secrets and all provider traffic. The renderer
//! sees connection summaries and model lists, never a key or a token.

pub(crate) mod accounts;
pub(crate) mod address;
pub(crate) mod answer;
pub(crate) mod attempts;
pub(crate) mod backend;
pub(crate) mod chat_completions;
pub(crate) mod chatgpt;
pub(crate) mod connections;
pub(crate) mod engine;
pub(crate) mod error;
pub(crate) mod http;
pub(crate) mod lines;
pub(crate) mod models;
pub(crate) mod prompt;
pub(crate) mod responses;
pub(crate) mod sse;
pub(crate) mod stats;
#[cfg(test)]
pub(crate) mod test_server;
pub(crate) mod tools;
pub(crate) mod turn;

use std::{
    collections::HashSet,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_plugin_opener::OpenerExt;
use tauri_specta::Event;
use tokio_util::sync::CancellationToken;

use self::{
    accounts::{Accounts, ConnectionBearer},
    address::Address,
    answer::Segment,
    attempts::{SignInAttempts, SignInKind},
    backend::{Message, ModelBackend},
    chat_completions::ChatCompletions,
    chatgpt::{BrowserOpener, ChatGpt},
    connections::{
        ApiConnectionInput, ConnectionRemoved, ConnectionSaved, ConnectionSummary, Connections,
        Secret,
    },
    engine::{Analyst, EngineAnalyst},
    error::CoachError,
    http::HttpClients,
    lines::TurnPosition,
    models::{ModelList, MAX_MODEL_LIST_BYTES},
    responses::{Responses, ToolLayout},
    stats::{DatabaseStatistics, Statistics},
    tools::{ToolActivity, ToolSource},
    turn::{TurnEnd, TurnRequest, TurnSink},
};
use crate::{
    credentials::{CoachConnectionHandle, CoachCredentials},
    engine::{EngineKey, EngineOption},
    infra::{
        blocking::BLOCKING_GATEWAY,
        path_authority::{AppDataDir, DatabaseHandle, EngineHandle},
    },
};

/// Turns that may run at the same time, over all windows and tabs.
const MAX_TURNS: usize = 4;
/// The longest a turn may take from its first engine search to its last word.
const TURN_DEADLINE: Duration = Duration::from_secs(300);
/// Streamed text is passed on at most this often, so a fast stream does not flood the renderer.
const TEXT_FLUSH_INTERVAL: Duration = Duration::from_millis(50);
const MAX_QUESTION_CHARS: usize = 4000;
const MAX_HISTORY_MESSAGES: usize = 40;
const MAX_HISTORY_BYTES: usize = 96 * 1024;
const MAX_GAME_BYTES: usize = 24 * 1024;
const MAX_REPERTOIRE_BYTES: usize = 8 * 1024;
const MAX_MODEL_CHARS: usize = 200;
const MAX_EFFORT_CHARS: usize = 32;
const MAX_TURN_PLIES: usize = 2000;
const MAX_TAB_CHARS: usize = 128;

/// Switch for release builds. The Coach stays hidden there until Felix's "release"; `.dev` builds
/// always have it.
pub(crate) const RELEASE_AVAILABLE: bool = false;

fn available_for(identifier: &str) -> bool {
    RELEASE_AVAILABLE || identifier.ends_with(".dev")
}

/// The namespace the tools are declared in where a provider wants them grouped.
const TOOL_NAMESPACE: &str = "chess";

pub(crate) struct Coach {
    available: bool,
    connections: Connections,
    credentials: Arc<CoachCredentials>,
    http: HttpClients,
    turns: Arc<TurnSlots>,
    chatgpt: Arc<ChatGpt>,
    /// The tokens of the signed-in connections.
    accounts: Accounts,
    sign_ins: Arc<SignInAttempts>,
}

/// The turns that run now, by window and tab: one per tab, [`MAX_TURNS`] overall.
#[derive(Default)]
struct TurnSlots(Mutex<HashSet<(String, String)>>);

/// One running turn's place. Dropping it frees the place on every way the turn ends.
struct TurnSlot {
    slots: Arc<TurnSlots>,
    key: (String, String),
}

impl TurnSlots {
    fn take(self: &Arc<Self>, window: &str, tab: &str) -> Result<TurnSlot, CoachError> {
        let key = (window.to_owned(), tab.to_owned());
        let mut running = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if running.len() >= MAX_TURNS || !running.insert(key.clone()) {
            return Err(CoachError::Busy);
        }
        Ok(TurnSlot {
            slots: Arc::clone(self),
            key,
        })
    }
}

impl Drop for TurnSlot {
    fn drop(&mut self) {
        self.slots
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.key);
    }
}

#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HistoryRole {
    User,
    Coach,
}

#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HistoryMessage {
    pub role: HistoryRole,
    pub text: String,
}

/// One user message with everything the turn needs. All of it is renderer input and is bounded
/// here before anything is started.
#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TurnInput {
    pub connection: CoachConnectionHandle,
    pub model: String,
    /// Absent sends no effort level: the provider's default applies.
    #[specta(optional)]
    pub effort: Option<String>,
    /// The FEN of the game's root.
    pub start_fen: String,
    /// The UCI moves from the root to the position on the board.
    pub moves: Vec<String>,
    /// Earlier user and coach texts, oldest first.
    pub history: Vec<HistoryMessage>,
    pub message: String,
    /// The game as PGN.
    pub game: String,
    pub engine: EngineHandle,
    pub engine_id: String,
    pub uci_options: Vec<EngineOption>,
    /// The reference database for opening statistics, if the user chose one.
    #[specta(optional)]
    pub reference_db: Option<DatabaseHandle>,
    /// What the user's repertoire files play from the position, as text.
    #[specta(optional)]
    pub repertoire: Option<String>,
    /// The repertoire files were only partly read.
    pub repertoire_partial: bool,
}

struct TurnEngine {
    handle: EngineHandle,
    id: String,
    uci_options: Vec<EngineOption>,
}

/// A turn's input, bounded and taken apart.
struct TurnParts {
    connection: CoachConnectionHandle,
    position: TurnPosition,
    request: TurnRequest,
    engine: TurnEngine,
    reference_db: Option<DatabaseHandle>,
}

fn plain(text: &str, max_chars: usize) -> bool {
    !text.is_empty() && text.chars().count() <= max_chars && !text.chars().any(char::is_control)
}

/// The newest history messages that fit the bounds, oldest first. Older ones are left out rather
/// than refused: a long conversation stays usable.
fn bounded_history(history: Vec<HistoryMessage>) -> Vec<Message> {
    let mut kept = Vec::new();
    let mut bytes = 0;
    for message in history.into_iter().rev() {
        bytes += message.text.len();
        if kept.len() == MAX_HISTORY_MESSAGES || bytes > MAX_HISTORY_BYTES {
            break;
        }
        kept.push(match message.role {
            HistoryRole::User => Message::User(message.text),
            HistoryRole::Coach => Message::Assistant {
                text: message.text,
                tool_calls: Vec::new(),
                extra: serde_json::Map::new(),
            },
        });
    }
    kept.reverse();
    kept
}

impl TurnInput {
    fn into_parts(self) -> Result<TurnParts, CoachError> {
        let question = self.message.trim();
        let effort_is_plain = self.effort.as_deref().is_none_or(|effort| {
            !effort.is_empty()
                && effort.len() <= MAX_EFFORT_CHARS
                && effort
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        });
        if question.is_empty()
            || question.chars().count() > MAX_QUESTION_CHARS
            || !plain(&self.model, MAX_MODEL_CHARS)
            || !effort_is_plain
            || self.game.len() > MAX_GAME_BYTES
            || self.moves.len() > MAX_TURN_PLIES
            || self
                .repertoire
                .as_ref()
                .is_some_and(|text| text.len() > MAX_REPERTOIRE_BYTES)
        {
            return Err(CoachError::InvalidInput);
        }
        let position = TurnPosition::new(&self.start_fen, &self.moves)?;
        let request = TurnRequest {
            model: self.model,
            effort: self.effort,
            history: bounded_history(self.history),
            question: question.to_owned(),
            game: self.game,
            repertoire: self.repertoire.filter(|text| !text.trim().is_empty()),
            repertoire_partial: self.repertoire_partial,
        };
        let engine = TurnEngine {
            handle: self.engine,
            id: self.engine_id,
            uci_options: self.uci_options,
        };
        Ok(TurnParts {
            connection: self.connection,
            position,
            request,
            engine,
            reference_db: self.reference_db,
        })
    }
}

/// What a running turn tells the renderer. Every turn ends with exactly one of `Completed`,
/// `Cancelled` and `Failed`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum TurnUpdate {
    Text {
        delta: String,
    },
    /// The text streamed so far is superseded by what follows.
    Reset,
    /// The engine is checking this line, or the reference database is asked about it (SAN from
    /// the turn position; empty for the position).
    Tool {
        source: ToolSource,
        line: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Completed {
        segments: Vec<Segment>,
        /// Lines the model wrote that are not legal; they are in `segments` as plain text.
        failed_lines: u32,
    },
    Cancelled {
        text: String,
    },
    Failed {
        error: CoachError,
        text: String,
    },
}

/// Broadcast to every window; the receiver keeps only the turn it is waiting for.
#[derive(Clone, Debug, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoachTurnEvent {
    pub tab: String,
    /// The turn's id: the ticket of its analysis operation.
    pub turn: String,
    pub update: TurnUpdate,
}

struct EventSink<'a, R: tauri::Runtime> {
    app: &'a tauri::AppHandle<R>,
    tab: &'a str,
    turn: &'a str,
    /// The text of the running round, for a turn that ends by its deadline.
    text: String,
    pending: String,
    flushed_at: Instant,
}

impl<R: tauri::Runtime> EventSink<'_, R> {
    fn emit(&self, update: TurnUpdate) {
        let event = CoachTurnEvent {
            tab: self.tab.to_owned(),
            turn: self.turn.to_owned(),
            update,
        };
        if let Err(error) = event.emit(self.app) {
            log::warn!("coach: turn event was not delivered: {error}");
        }
    }

    fn flush(&mut self) {
        if !self.pending.is_empty() {
            let delta = std::mem::take(&mut self.pending);
            self.emit(TurnUpdate::Text { delta });
        }
        self.flushed_at = Instant::now();
    }
}

impl<R: tauri::Runtime> TurnSink for EventSink<'_, R> {
    fn text(&mut self, delta: &str) {
        self.text.push_str(delta);
        self.pending.push_str(delta);
        if self.flushed_at.elapsed() >= TEXT_FLUSH_INTERVAL {
            self.flush();
        }
    }

    fn reset(&mut self) {
        self.text.clear();
        self.pending.clear();
        self.emit(TurnUpdate::Reset);
    }

    fn tool(&mut self, activity: &ToolActivity) {
        self.flush();
        self.emit(TurnUpdate::Tool {
            source: activity.source,
            line: activity.line.clone(),
        });
    }
}

/// Runs an admitted turn to its end and reports it: progress while it runs, then exactly one
/// terminal event. The terminal update is also returned, for the command's own reply.
#[allow(clippy::too_many_arguments)]
async fn drive_turn<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    tab: &str,
    turn_id: &str,
    backend: &dyn ModelBackend,
    analyst: &mut dyn Analyst,
    statistics: Option<&mut (dyn Statistics + '_)>,
    position: &TurnPosition,
    request: &TurnRequest,
    cancellation: &CancellationToken,
    deadline: Duration,
) -> TurnUpdate {
    let mut sink = EventSink {
        app,
        tab,
        turn: turn_id,
        text: String::new(),
        pending: String::new(),
        flushed_at: Instant::now(),
    };
    let end = tokio::time::timeout(
        deadline,
        turn::run_turn(
            backend,
            analyst,
            statistics,
            position,
            request,
            &mut sink,
            cancellation,
        ),
    )
    .await;
    sink.flush();
    let update = match end {
        Ok(TurnEnd::Completed(answer)) => TurnUpdate::Completed {
            failed_lines: u32::try_from(answer.failed.len()).unwrap_or(u32::MAX),
            segments: answer.segments,
        },
        Ok(TurnEnd::Failed {
            error: CoachError::Cancelled,
            text,
        }) => TurnUpdate::Cancelled { text },
        Ok(TurnEnd::Failed { error, text }) => TurnUpdate::Failed { error, text },
        Err(_) => {
            // Past the deadline the turn is over for everything that still listens to its token.
            cancellation.cancel();
            TurnUpdate::Failed {
                error: CoachError::LimitExceeded,
                text: std::mem::take(&mut sink.text),
            }
        }
    };
    sink.emit(update.clone());
    update
}

impl Coach {
    fn new(available: bool, credentials: Arc<CoachCredentials>) -> Result<Self, CoachError> {
        let http = HttpClients::new()?;
        let chatgpt = ChatGpt::new(http.public().clone());
        Ok(Self::with_chatgpt(available, credentials, http, chatgpt))
    }

    /// The Coach around a given ChatGPT sign-in, which tests point at a provider double.
    fn with_chatgpt(
        available: bool,
        credentials: Arc<CoachCredentials>,
        http: HttpClients,
        chatgpt: ChatGpt,
    ) -> Self {
        let connections = Connections::new(credentials.clone());
        let chatgpt = Arc::new(chatgpt);
        Self {
            available,
            accounts: Accounts::start(connections.clone(), chatgpt.clone()),
            connections,
            credentials,
            http,
            turns: Arc::default(),
            chatgpt,
            sign_ins: Arc::default(),
        }
    }

    /// The model backend of a connection, from what is stored for it now.
    async fn backend(
        &self,
        handle: CoachConnectionHandle,
    ) -> Result<Box<dyn ModelBackend>, CoachError> {
        match self.connections.secret(handle.clone()).await? {
            Secret::Api { address, key } => {
                let address = Address::parse(&address).map_err(|_| CoachError::NeedsRepair)?;
                let client = self.http.for_address(&address).clone();
                Ok(Box::new(ChatCompletions::new(client, address, key)))
            }
            Secret::ChatGpt(secret) => {
                if secret.refresh_token.is_none() {
                    return Err(CoachError::SignInAgain);
                }
                Ok(Box::new(Responses::new(
                    self.chatgpt.http().clone(),
                    self.chatgpt.api("responses"),
                    ConnectionBearer {
                        accounts: self.accounts.clone(),
                        handle,
                    },
                    ToolLayout::Namespace(TOOL_NAMESPACE),
                )))
            }
        }
    }

    /// The models of a ChatGPT sign-in. A token refused before the answer was read is replaced
    /// once.
    async fn plan_models(&self, handle: CoachConnectionHandle) -> Result<ModelList, CoachError> {
        let mut bearer = self.accounts.bearer(handle.clone()).await?;
        for retry in [false, true] {
            let request = self
                .chatgpt
                .http()
                .get(self.chatgpt.api("models"))
                .bearer_auth(&bearer.token);
            let (status, body) = http::send_bounded(request, MAX_MODEL_LIST_BYTES).await?;
            match status {
                200 => return models::parse_plan_models(&body),
                401 if !retry => {
                    bearer = self
                        .accounts
                        .rejected(handle.clone(), bearer.generation)
                        .await?;
                }
                _ => {
                    let (error, message) = responses::classify_plan_refusal(status, &body, false);
                    log::warn!(
                        "coach: the plan model list was refused with HTTP {status}: {}",
                        http::diagnostic(&message, None)
                    );
                    return Err(error);
                }
            }
        }
        Err(CoachError::ProviderFailure)
    }

    /// Removes a connection: here first, durably; then, for a sign-in, the provider is asked once
    /// to withdraw it. The token used for that is already gone from this computer.
    async fn remove(&self, handle: CoachConnectionHandle) -> Result<ConnectionRemoved, CoachError> {
        let signed_in = match self.connections.secret(handle.clone()).await {
            Ok(Secret::ChatGpt(secret)) => Some(secret),
            _ => None,
        };
        let mut removed = self.connections.remove(handle.clone()).await?;
        if let Some(secret) = signed_in {
            if let Err(error) = self.accounts.forget(handle).await {
                log::warn!("coach: the removed sign-in's tokens were not dropped: {error:?}");
            }
            if let Some(refresh) = secret.refresh_token {
                removed.revocation_pending =
                    !self.chatgpt.revoke(&secret.client_id, &refresh).await;
            }
        }
        Ok(removed)
    }

    /// Runs a ChatGPT sign-in as the one attempt of its kind and hands its tokens to their owner.
    async fn sign_in_chatgpt(
        &self,
        attempt: &str,
        window: &str,
        opener: BrowserOpener,
    ) -> Result<ConnectionSaved, CoachError> {
        self.sign_ins
            .run(
                SignInKind::ChatGpt,
                attempt,
                window,
                |cancellation| async move {
                    let (saved, client_id, tokens) = self
                        .chatgpt
                        .sign_in(&self.connections, &self.credentials, &cancellation, &opener)
                        .await?;
                    self.accounts
                        .signed_in(saved.connection.handle.clone(), client_id, tokens)
                        .await?;
                    Ok(saved)
                },
            )
            .await
    }

    async fn models(&self, handle: CoachConnectionHandle) -> Result<ModelList, CoachError> {
        let (address, key) = match self.connections.secret(handle.clone()).await? {
            Secret::Api { address, key } => (address, key),
            Secret::ChatGpt(_) => return self.plan_models(handle).await,
        };
        // The class is derived from the stored text on every use, never taken from the caller.
        let address = Address::parse(&address).map_err(|_| CoachError::NeedsRepair)?;
        let url = address.endpoint("models");
        let mut request = self.http.for_address(&address).get(url.clone());
        if let Some(key) = key.filter(|_| address.owns(&url)) {
            request = request.bearer_auth(key);
        }
        let (status, body) = http::send_bounded(request, MAX_MODEL_LIST_BYTES).await?;
        match status {
            200 => models::parse_model_list(&body),
            401 | 403 => Err(CoachError::KeyRejected),
            429 => Err(CoachError::RateLimited),
            _ => Err(CoachError::ProviderFailure),
        }
    }
}

pub(crate) fn initialize(app: &tauri::AppHandle) -> Result<Coach, CoachError> {
    let identifier = app.config().identifier.clone();
    let credentials = Arc::new(CoachCredentials::new(&identifier));
    let worker_credentials = credentials.clone();
    let handle = app.clone();
    tauri::async_runtime::block_on(BLOCKING_GATEWAY.spawn_cancellable(
        CancellationToken::new(),
        move |_| {
            let data = AppDataDir::for_app(&handle)?;
            worker_credentials.initialize(&data)
        },
    ))
    .map_err(|_| CoachError::Storage)?;
    Coach::new(available_for(&identifier), credentials)
}

/// Every Coach command goes through here, so a build with the switch off refuses all of them.
fn coach(state: &crate::AppState) -> Result<&Coach, CoachError> {
    state
        .coach
        .get()
        .filter(|coach| coach.available)
        .ok_or(CoachError::Unavailable)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn coach_available(
    state: tauri::State<'_, crate::AppState>,
) -> Result<bool, CoachError> {
    Ok(coach(&state).is_ok())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn coach_connections(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<ConnectionSummary>, CoachError> {
    coach(&state)?.connections.list().await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn coach_save_api_connection(
    connection: ApiConnectionInput,
    state: tauri::State<'_, crate::AppState>,
) -> Result<ConnectionSaved, CoachError> {
    coach(&state)?.connections.save_api(connection).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn coach_remove_connection(
    handle: CoachConnectionHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<ConnectionRemoved, CoachError> {
    coach(&state)?.remove(handle).await
}

fn browser_opener(app: tauri::AppHandle) -> BrowserOpener {
    Arc::new(move |url: &str| {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|_| "the system browser could not be opened".into())
    })
}

/// Signs in with ChatGPT in the system browser and returns the connection once the user is back.
/// `attempt` is the caller's own id for this sign-in, the one `coach_cancel_sign_in` takes.
#[tauri::command]
#[specta::specta]
pub(crate) async fn coach_sign_in_chatgpt(
    attempt: String,
    state: tauri::State<'_, crate::AppState>,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<ConnectionSaved, CoachError> {
    start_chatgpt_sign_in(&attempt, &state, window.label(), browser_opener(app)).await
}

async fn start_chatgpt_sign_in(
    attempt: &str,
    state: &crate::AppState,
    window: &str,
    opener: BrowserOpener,
) -> Result<ConnectionSaved, CoachError> {
    coach(state)?.sign_in_chatgpt(attempt, window, opener).await
}

/// Ends the sign-in with this id, if it still runs. Its own command then ends as `cancelled`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn coach_cancel_sign_in(
    attempt: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), CoachError> {
    coach(&state)?.sign_ins.cancel(&attempt);
    Ok(())
}

/// Opens the page where the user manages what their ChatGPT plan is used for.
#[tauri::command]
#[specta::specta]
pub(crate) async fn coach_open_usage(
    state: tauri::State<'_, crate::AppState>,
    app: tauri::AppHandle,
) -> Result<(), CoachError> {
    open_usage(&state, &browser_opener(app))
}

fn open_usage(state: &crate::AppState, opener: &BrowserOpener) -> Result<(), CoachError> {
    coach(state)?.chatgpt.open_usage(opener)
}

/// Ends the sign-ins a window started: it was destroyed, or its document was replaced.
pub(crate) fn cancel_window_sign_ins(state: &crate::AppState, window: &str) {
    if let Some(coach) = state.coach.get() {
        coach.sign_ins.cancel_window(window);
    }
}

/// Ends every sign-in and waits until each is over. Called at exit, inside its budget.
pub(crate) async fn shutdown_sign_ins(state: &crate::AppState) {
    if let Some(coach) = state.coach.get() {
        coach.sign_ins.shutdown().await;
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn coach_models(
    handle: CoachConnectionHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<ModelList, CoachError> {
    coach(&state)?.models(handle).await
}

/// Runs one Coach turn. The turn is an analysis operation: `id` is the ticket the renderer
/// reserved with `prepare_analysis` for this tab, its engine runs under the analysis key of that
/// ticket, and `cancel_analysis`, closing the tab, a reload and quitting all end it. The command
/// returns when the turn is over, with the same terminal update the turn's last event carried: the
/// renderer takes whichever arrives first and ignores the other. An `Err` means the turn never
/// started, and no event follows.
#[tauri::command]
#[specta::specta]
pub(crate) async fn coach_turn(
    id: String,
    tab: String,
    turn: TurnInput,
    state: tauri::State<'_, crate::AppState>,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<TurnUpdate, CoachError> {
    start_turn(id, tab, turn, state.inner(), app, window.label()).await
}

async fn start_turn<R: tauri::Runtime>(
    id: String,
    tab: String,
    turn: TurnInput,
    state: &crate::AppState,
    app: tauri::AppHandle<R>,
    window: &str,
) -> Result<TurnUpdate, CoachError> {
    let coach = coach(state)?;
    if !plain(&tab, MAX_TAB_CHARS) {
        return Err(CoachError::InvalidInput);
    }
    let TurnParts {
        connection,
        position,
        request,
        engine,
        reference_db,
    } = turn.into_parts()?;
    let slot = coach.turns.take(window, &tab)?;
    let backend = coach.backend(connection).await?;
    let key =
        EngineKey::new("analysis".into(), id.clone()).map_err(|_| CoachError::InvalidInput)?;
    let operation = state
        .operations
        .claim_analysis(&id, window, &tab, &format!("coach_turn {id}"))
        .map_err(|_| CoachError::InvalidInput)?;
    let cancellation = operation.token();
    let state = state.clone();
    let workflow = async move {
        let _slot = slot;
        let mut analyst = EngineAnalyst::new(
            state.clone(),
            key,
            engine.handle,
            engine.id,
            engine.uci_options,
            cancellation.clone(),
            position.start_fen().to_owned(),
        );
        // The lookups report their progress under an id of the turn, which no view listens to.
        let mut statistics = reference_db.map(|database| {
            DatabaseStatistics::new(
                state.clone(),
                app.clone(),
                format!("coach:{id}"),
                database,
                cancellation.clone(),
            )
        });
        let end = drive_turn(
            &app,
            &tab,
            &id,
            backend.as_ref(),
            &mut analyst,
            statistics
                .as_mut()
                .map(|statistics| statistics as &mut dyn Statistics),
            &position,
            &request,
            &cancellation,
            TURN_DEADLINE,
        )
        .await;
        analyst.finish().await;
        Ok(end)
    };
    crate::infra::operations::run_native_operation(operation, "coach_turn", workflow)
        .await
        .map_err(|_| CoachError::ProviderFailure)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::MemoryCredentialStore;
    use axum::{
        http::{header::AUTHORIZATION, HeaderMap, StatusCode},
        routing::get,
        Router,
    };
    use std::sync::Mutex;
    use tauri::Manager;

    fn test_coach(available: bool) -> (Coach, tempfile::TempDir) {
        let (credentials, directory) =
            CoachCredentials::for_test(Arc::new(MemoryCredentialStore::default()));
        (
            Coach::new(available, Arc::new(credentials)).unwrap(),
            directory,
        )
    }

    async fn local_connection(
        coach: &Coach,
        address: &str,
        key: Option<&str>,
    ) -> CoachConnectionHandle {
        coach
            .connections
            .save_api(ApiConnectionInput {
                handle: None,
                label: "Test".into(),
                address: address.into(),
                key: key.map(str::to_owned),
            })
            .await
            .unwrap()
            .connection
            .handle
    }

    #[test]
    fn only_dev_builds_have_the_coach_while_the_release_switch_is_off() {
        assert!(available_for("com.chessriddle.studio.dev"));
        // Turning the Coach on for release builds is Felix's release decision.
        assert!(!available_for("com.chessriddle.studio"));
        assert!(!available_for("com.chessriddle.studio.developer"));
    }

    #[tokio::test]
    async fn every_command_refuses_when_the_coach_is_off_or_not_initialized() {
        let handle = || CoachConnectionHandle(uuid::Uuid::new_v4().to_string());
        let input = || ApiConnectionInput {
            handle: None,
            label: "Local".into(),
            address: "http://localhost:11434/v1".into(),
            key: None,
        };
        for coach in [None, Some(test_coach(false))] {
            let app = tauri::test::mock_app();
            let state = crate::AppState::default();
            let _directory = coach.map(|(coach, directory)| {
                assert!(state.coach.set(coach).is_ok());
                directory
            });
            app.manage(state);

            assert_eq!(coach_available(app.state()).await, Ok(false));
            assert_eq!(
                coach_connections(app.state()).await.unwrap_err(),
                CoachError::Unavailable
            );
            assert_eq!(
                coach_save_api_connection(input(), app.state())
                    .await
                    .unwrap_err(),
                CoachError::Unavailable
            );
            assert_eq!(
                coach_remove_connection(handle(), app.state())
                    .await
                    .unwrap_err(),
                CoachError::Unavailable
            );
            assert_eq!(
                coach_models(handle(), app.state()).await.unwrap_err(),
                CoachError::Unavailable
            );
            // No browser is opened and no listener started for a Coach that is off.
            let no_browser: BrowserOpener = Arc::new(|_| panic!("the Coach is off"));
            let state = app.state::<crate::AppState>();
            assert_eq!(
                start_chatgpt_sign_in("attempt", &state, "main", no_browser.clone())
                    .await
                    .unwrap_err(),
                CoachError::Unavailable
            );
            assert_eq!(
                coach_cancel_sign_in("attempt".into(), app.state())
                    .await
                    .unwrap_err(),
                CoachError::Unavailable
            );
            assert_eq!(
                open_usage(&state, &no_browser).unwrap_err(),
                CoachError::Unavailable
            );
            // The lifecycle hooks have nothing to end and do not mind.
            cancel_window_sign_ins(&state, "main");
            shutdown_sign_ins(&state).await;
        }
    }

    /// A Coach whose ChatGPT sign-in talks to the provider double.
    fn signed_in_coach(
        provider: &crate::coach::chatgpt::tests::Provider,
    ) -> (
        crate::AppState,
        Arc<MemoryCredentialStore>,
        tempfile::TempDir,
    ) {
        let store = Arc::new(MemoryCredentialStore::default());
        let (credentials, directory) = CoachCredentials::for_test(store.clone());
        let coach = Coach::with_chatgpt(
            true,
            Arc::new(credentials),
            HttpClients::new().unwrap(),
            provider.chatgpt(Duration::from_secs(30)),
        );
        let state = crate::AppState::default();
        assert!(state.coach.set(coach).is_ok());
        (state, store, directory)
    }

    fn the_coach(state: &crate::AppState) -> &Coach {
        coach(state).unwrap()
    }

    fn api_calls(provider: &crate::coach::chatgpt::tests::Provider) -> Vec<(&'static str, String)> {
        provider.api_calls.lock().unwrap().clone()
    }

    #[tokio::test]
    async fn a_chatgpt_connection_lists_its_models_and_answers_with_the_tokens_of_its_sign_in() {
        let provider = crate::coach::chatgpt::tests::Provider::start();
        let (state, _store, _directory) = signed_in_coach(&provider);
        let saved = start_chatgpt_sign_in(
            "attempt-1",
            &state,
            "main",
            provider.approving_browser(1, "oaiapp_issued"),
        )
        .await
        .unwrap();
        let handle = saved.connection.handle.clone();
        let coach = the_coach(&state);
        assert!(coach.sign_ins.is_idle());
        assert_eq!(
            coach.connections.list().await.unwrap(),
            std::slice::from_ref(&saved.connection)
        );

        // The model list: the provider's listed models, asked with the sign-in's own token.
        let list = coach.models(handle.clone()).await.unwrap();
        assert_eq!(list.models.len(), 1);
        assert_eq!(
            (list.models[0].id.as_str(), list.models[0].name.as_str()),
            ("gpt-plan", "GPT Plan")
        );
        // A round goes to the Responses endpoint with the same token.
        let backend = coach.backend(handle.clone()).await.unwrap();
        let round = backend
            .round(
                backend::RoundRequest {
                    model: "gpt-plan",
                    effort: None,
                    system: "",
                    messages: &[Message::User("Plan?".into())],
                    tools: &tools::specs(false),
                },
                &mut |_| {},
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(round.text, "Ok.");
        assert_eq!(
            api_calls(&provider),
            [
                ("models", "Bearer access-1".to_owned()),
                ("responses", "Bearer access-1".to_owned())
            ]
        );
        // Nothing was exchanged after the sign-in itself.
        assert_eq!(provider.forms.lock().unwrap().len(), 1);

        // A token the API refuses is replaced once, and the rotation is stored.
        provider.refused.lock().unwrap().push("access-1".into());
        provider.answer(
            StatusCode::OK,
            crate::coach::chatgpt::tests::tokens(2, None, ""),
        );
        assert_eq!(coach.models(handle.clone()).await.unwrap().models.len(), 1);
        assert_eq!(
            api_calls(&provider)[2..],
            [
                ("models", "Bearer access-1".to_owned()),
                ("models", "Bearer access-2".to_owned())
            ]
        );
        let (_, secret) = coach.connections.chatgpt().await.unwrap().unwrap();
        assert_eq!(secret.refresh_token.as_deref(), Some("refresh-2"));

        // Once the provider has ended the session there is no backend to ask, only a new sign-in.
        coach
            .connections
            .set_refresh_token(handle.clone(), None)
            .await
            .unwrap();
        assert_eq!(
            coach.backend(handle).await.err(),
            Some(CoachError::SignInAgain)
        );
    }

    #[tokio::test]
    async fn removing_a_sign_in_deletes_it_here_first_and_says_whether_the_provider_confirmed() {
        for (revoke_status, pending) in [
            (StatusCode::OK, false),
            (StatusCode::INTERNAL_SERVER_ERROR, true),
        ] {
            let provider = crate::coach::chatgpt::tests::Provider::start();
            let (state, store, _directory) = signed_in_coach(&provider);
            let saved = start_chatgpt_sign_in(
                "attempt-1",
                &state,
                "main",
                provider.approving_browser(1, "oaiapp_issued"),
            )
            .await
            .unwrap();
            let handle = saved.connection.handle;
            *provider.revoke_status.lock().unwrap() = revoke_status;
            let coach = the_coach(&state);
            let removed = coach.remove(handle.clone()).await.unwrap();
            assert_eq!(removed.revocation_pending, pending);
            // Gone here whatever the provider said, with its keyring entry.
            assert!(coach.connections.list().await.unwrap().is_empty());
            assert!(crate::credentials::CredentialStore::get(
                store.as_ref(),
                &format!("coach-connection:{}", handle.0)
            )
            .unwrap()
            .is_none());
            // The provider was asked once, with the token that is no longer stored anywhere.
            let revocations = provider.revocations.lock().unwrap().clone();
            assert_eq!(revocations.len(), 1);
            assert_eq!(revocations[0]["token"], "refresh-1");
            assert_eq!(revocations[0]["client_id"], "oaiapp_issued");
            // The token owner dropped the session with it.
            assert_eq!(
                coach.accounts.bearer(handle.clone()).await.err(),
                Some(CoachError::NotFound)
            );
            assert_eq!(coach.remove(handle).await.err(), Some(CoachError::NotFound));
        }
    }

    #[tokio::test]
    async fn an_api_connection_is_removed_without_asking_any_provider() {
        let provider = crate::coach::chatgpt::tests::Provider::start();
        let (state, _store, _directory) = signed_in_coach(&provider);
        let coach = the_coach(&state);
        let handle = local_connection(coach, "http://localhost:11434/v1", Some("sk-local")).await;
        let removed = coach.remove(handle).await.unwrap();
        assert!(!removed.revocation_pending);
        assert!(provider.revocations.lock().unwrap().is_empty());
    }

    /// Starts a sign-in whose user never comes back from the browser; resolves once the browser
    /// was opened.
    async fn waiting_sign_in(
        state: &crate::AppState,
        attempt: &'static str,
        window: &'static str,
    ) -> (
        tokio::task::JoinHandle<Result<ConnectionSaved, CoachError>>,
        String,
    ) {
        let (opened, redirect) = tokio::sync::oneshot::channel();
        let opened = Mutex::new(Some(opened));
        let opener: BrowserOpener = Arc::new(move |url: &str| {
            let url = url::Url::parse(url).unwrap();
            let redirect = url
                .query_pairs()
                .find(|(name, _)| name == "redirect_uri")
                .map(|(_, value)| value.into_owned())
                .unwrap();
            if let Some(opened) = opened.lock().unwrap().take() {
                let _ = opened.send(redirect);
            }
            Ok(())
        });
        let state = state.clone();
        let running =
            tokio::spawn(
                async move { start_chatgpt_sign_in(attempt, &state, window, opener).await },
            );
        (running, redirect.await.expect("the browser is opened"))
    }

    async fn ended(
        running: tokio::task::JoinHandle<Result<ConnectionSaved, CoachError>>,
    ) -> Option<CoachError> {
        tokio::time::timeout(Duration::from_secs(5), running)
            .await
            .expect("the sign-in ends")
            .unwrap()
            .err()
    }

    async fn listener_is_closed(redirect: &str) -> bool {
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        http.get(redirect).send().await.is_err()
    }

    #[tokio::test]
    async fn every_way_a_sign_in_can_be_ended_closes_its_listener_and_leaves_no_connection() {
        let provider = crate::coach::chatgpt::tests::Provider::start();
        let (state, _store, _directory) = signed_in_coach(&provider);
        let app = tauri::test::mock_app();
        app.manage(state.clone());

        // The user's cancel, by the attempt's id; another id ends nothing.
        let (running, redirect) = waiting_sign_in(&state, "by-id", "main").await;
        coach_cancel_sign_in("another".into(), app.state())
            .await
            .unwrap();
        assert!(!the_coach(&state).sign_ins.is_idle());
        coach_cancel_sign_in("by-id".into(), app.state())
            .await
            .unwrap();
        assert_eq!(ended(running).await, Some(CoachError::Cancelled));
        assert!(listener_is_closed(&redirect).await);

        // The end of its window, or of that window's document; another window ends nothing.
        let (running, redirect) = waiting_sign_in(&state, "by-window", "main").await;
        cancel_window_sign_ins(&state, "report");
        assert!(!the_coach(&state).sign_ins.is_idle());
        cancel_window_sign_ins(&state, "main");
        assert_eq!(ended(running).await, Some(CoachError::Cancelled));
        assert!(listener_is_closed(&redirect).await);

        // A new attempt ends the one before it, then runs itself.
        let (first, first_redirect) = waiting_sign_in(&state, "first", "main").await;
        let (second, second_redirect) = waiting_sign_in(&state, "second", "main").await;
        assert_eq!(ended(first).await, Some(CoachError::Cancelled));
        assert!(listener_is_closed(&first_redirect).await);

        // The application's exit ends what still runs and returns when it is over.
        tokio::time::timeout(Duration::from_secs(5), shutdown_sign_ins(&state))
            .await
            .expect("shutdown does not wait for a browser");
        assert!(the_coach(&state).sign_ins.is_idle());
        assert_eq!(ended(second).await, Some(CoachError::Cancelled));
        assert!(listener_is_closed(&second_redirect).await);

        assert!(the_coach(&state)
            .connections
            .list()
            .await
            .unwrap()
            .is_empty());
        assert!(provider.forms.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_available_coach_answers_its_commands() {
        let (coach, _directory) = test_coach(true);
        let app = tauri::test::mock_app();
        let state = crate::AppState::default();
        assert!(state.coach.set(coach).is_ok());
        app.manage(state);

        assert_eq!(coach_available(app.state()).await, Ok(true));
        assert_eq!(coach_connections(app.state()).await, Ok(vec![]));
    }

    #[tokio::test]
    async fn the_model_list_is_loaded_with_the_stored_key() {
        let seen = Arc::new(Mutex::new(Vec::<Option<String>>::new()));
        let recorded = seen.clone();
        let server = test_server::serve(Router::new().route(
            "/v1/models",
            get(move |headers: HeaderMap| {
                let recorded = recorded.clone();
                async move {
                    recorded.lock().unwrap().push(
                        headers
                            .get(AUTHORIZATION)
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned),
                    );
                    r#"{"data":[{"id":"local-model"}]}"#
                }
            }),
        ));
        let (coach, _directory) = test_coach(true);

        let with_key = local_connection(&coach, &server.url("/v1"), Some("sk-local")).await;
        let list = coach.models(with_key).await.unwrap();
        assert_eq!(list.models.len(), 1);
        assert_eq!(list.models[0].id, "local-model");

        let without_key = local_connection(&coach, &server.url("/v1/"), None).await;
        coach.models(without_key).await.unwrap();

        assert_eq!(
            *seen.lock().unwrap(),
            vec![Some("Bearer sk-local".to_owned()), None]
        );
    }

    #[tokio::test]
    async fn model_list_failures_are_typed_and_never_an_empty_list() {
        let oversized = "x".repeat(MAX_MODEL_LIST_BYTES + 1);
        let server = test_server::serve(
            Router::new()
                .route(
                    "/rejected/models",
                    get(|| async { StatusCode::UNAUTHORIZED }),
                )
                .route("/forbidden/models", get(|| async { StatusCode::FORBIDDEN }))
                .route(
                    "/limited/models",
                    get(|| async { StatusCode::TOO_MANY_REQUESTS }),
                )
                .route(
                    "/broken/models",
                    get(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
                )
                .route(
                    "/html/models",
                    get(|| async { "<html>not a model list</html>" }),
                )
                .route("/huge/models", get(move || async move { oversized })),
        );
        let (coach, _directory) = test_coach(true);
        for (path, expected) in [
            ("/rejected", CoachError::KeyRejected),
            ("/forbidden", CoachError::KeyRejected),
            ("/limited", CoachError::RateLimited),
            ("/broken", CoachError::ProviderFailure),
            ("/missing", CoachError::ProviderFailure),
            ("/html", CoachError::ProviderFailure),
            ("/huge", CoachError::ProviderFailure),
        ] {
            let handle = local_connection(&coach, &server.url(path), Some("sk")).await;
            assert_eq!(coach.models(handle).await.unwrap_err(), expected, "{path}");
        }

        let closed = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}/v1", listener.local_addr().unwrap())
        };
        let handle = local_connection(&coach, &closed, None).await;
        assert_eq!(coach.models(handle).await.unwrap_err(), CoachError::Network);

        let unknown = CoachConnectionHandle(uuid::Uuid::new_v4().to_string());
        assert_eq!(
            coach.models(unknown).await.unwrap_err(),
            CoachError::NotFound
        );
    }

    const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    fn turn_input(connection: CoachConnectionHandle) -> TurnInput {
        TurnInput {
            connection,
            model: "test-model".into(),
            effort: None,
            start_fen: START.into(),
            moves: vec!["e2e4".into()],
            history: Vec::new(),
            message: "  What is the plan?  ".into(),
            game: "1. e4 *".into(),
            engine: EngineHandle {
                id: crate::infra::path_authority::PathRef {
                    id: "missing-engine".into(),
                },
                kind: crate::infra::path_authority::EngineHandleKind::Engine,
            },
            engine_id: "missing-engine".into(),
            uci_options: Vec::new(),
            reference_db: None,
            repertoire: None,
            repertoire_partial: false,
        }
    }

    fn some_handle() -> CoachConnectionHandle {
        CoachConnectionHandle(uuid::Uuid::new_v4().to_string())
    }

    /// A mock app with the turn event mounted and every event of a turn collected.
    fn turn_app() -> (
        tauri::App<tauri::test::MockRuntime>,
        Arc<Mutex<Vec<serde_json::Value>>>,
    ) {
        use tauri::Listener;
        let app = tauri::test::mock_app();
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events!(CoachTurnEvent))
            .mount_events(&app);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        app.listen_any(CoachTurnEvent::NAME, move |event| {
            let event = serde_json::from_str(event.payload()).expect("the event is JSON");
            sink.lock().unwrap().push(event);
        });
        (app, events)
    }

    /// The updates as the renderer receives them.
    fn updates(events: &Mutex<Vec<serde_json::Value>>) -> Vec<serde_json::Value> {
        events
            .lock()
            .unwrap()
            .iter()
            .map(|event| event["update"].clone())
            .collect()
    }

    fn wire(updates: &[TurnUpdate]) -> Vec<serde_json::Value> {
        updates
            .iter()
            .map(|update| serde_json::to_value(update).unwrap())
            .collect()
    }

    #[test]
    fn a_tab_runs_one_turn_and_four_run_overall() {
        let slots = Arc::new(TurnSlots::default());
        let first = slots.take("main", "tab-0").unwrap();
        assert_eq!(slots.take("main", "tab-0").err(), Some(CoachError::Busy));
        // The same tab id in another window is another tab.
        let other_window = slots.take("second", "tab-0").unwrap();
        let more: Vec<_> = (1..MAX_TURNS - 1)
            .map(|index| slots.take("main", &format!("tab-{index}")).unwrap())
            .collect();
        assert_eq!(slots.take("main", "tab-9").err(), Some(CoachError::Busy));
        drop(first);
        // A finished turn frees its place for the tab and for the total.
        let again = slots.take("main", "tab-0").unwrap();
        drop((other_window, more, again));
        assert!(slots.0.lock().unwrap().is_empty());
    }

    #[test]
    fn turn_input_is_bounded_before_anything_starts() {
        let parts = turn_input(some_handle()).into_parts().unwrap();
        assert_eq!(parts.request.question, "What is the plan?");
        assert_eq!(parts.position.moves(), ["e2e4"]);
        assert_eq!(parts.engine.id, "missing-engine");
        assert!(parts.reference_db.is_none());
        assert_eq!(parts.request.repertoire, None);

        let refuse = |change: fn(&mut TurnInput)| {
            let mut input = turn_input(some_handle());
            change(&mut input);
            assert_eq!(input.into_parts().err(), Some(CoachError::InvalidInput));
        };
        refuse(|input| input.message = "   ".into());
        refuse(|input| input.message = "x".repeat(MAX_QUESTION_CHARS + 1));
        refuse(|input| input.model = String::new());
        refuse(|input| input.model = "m\n".into());
        refuse(|input| input.model = "m".repeat(MAX_MODEL_CHARS + 1));
        refuse(|input| input.effort = Some(String::new()));
        refuse(|input| input.effort = Some("high\"}".into()));
        refuse(|input| input.effort = Some("e".repeat(MAX_EFFORT_CHARS + 1)));
        refuse(|input| input.game = "g".repeat(MAX_GAME_BYTES + 1));
        refuse(|input| input.moves = vec!["e2e4".into(); MAX_TURN_PLIES + 1]);
        refuse(|input| input.moves = vec!["e2e5".into()]);
        refuse(|input| input.start_fen = "not a fen".into());
        refuse(|input| input.repertoire = Some("r".repeat(MAX_REPERTOIRE_BYTES + 1)));

        let mut input = turn_input(some_handle());
        input.effort = Some("x-high_2".into());
        assert_eq!(
            input.into_parts().unwrap().request.effort.as_deref(),
            Some("x-high_2")
        );

        // The repertoire is passed on with its partial flag; blank text is none at all.
        let mut input = turn_input(some_handle());
        input.repertoire = Some("r".repeat(MAX_REPERTOIRE_BYTES));
        input.repertoire_partial = true;
        let request = input.into_parts().unwrap().request;
        assert_eq!(
            request.repertoire.map(|text| text.len()),
            Some(MAX_REPERTOIRE_BYTES)
        );
        assert!(request.repertoire_partial);
        let mut input = turn_input(some_handle());
        input.repertoire = Some(" \n".into());
        assert_eq!(input.into_parts().unwrap().request.repertoire, None);
    }

    #[test]
    fn history_keeps_the_newest_messages_that_fit() {
        let message = |role, text: String| HistoryMessage { role, text };
        let many: Vec<_> = (0..MAX_HISTORY_MESSAGES + 5)
            .map(|index| message(HistoryRole::User, format!("question {index}")))
            .collect();
        let kept = bounded_history(many);
        assert_eq!(kept.len(), MAX_HISTORY_MESSAGES);
        assert_eq!(kept[0], Message::User("question 5".into()));
        assert_eq!(
            kept.last(),
            Some(&Message::User(format!(
                "question {}",
                MAX_HISTORY_MESSAGES + 4
            )))
        );

        let big = "x".repeat(MAX_HISTORY_BYTES / 2);
        let kept = bounded_history(vec![
            message(HistoryRole::User, big.clone()),
            message(HistoryRole::Coach, big.clone()),
            message(HistoryRole::User, "newest".into()),
        ]);
        assert_eq!(kept.len(), 2, "the oldest message no longer fits");
        assert!(matches!(&kept[0], Message::Assistant { text, .. } if *text == big));
        assert_eq!(kept[1], Message::User("newest".into()));
    }

    #[tokio::test]
    async fn a_turn_reports_its_progress_and_exactly_one_terminal_event() {
        use crate::coach::{tools::tests::ScriptedAnalyst, turn::tests as doubles};
        let (app, events) = turn_app();
        let backend = doubles::ScriptedBackend::new(vec![
            doubles::calls("Checking.", &[r#"{"line":"Nf6"}"#]),
            doubles::text("Play [[Nf6]]."),
        ]);
        let position = TurnPosition::new(START, &["e2e4".to_owned()]).unwrap();
        drive_turn(
            app.handle(),
            "tab-1",
            "turn-1",
            &backend,
            &mut ScriptedAnalyst::default(),
            None,
            &position,
            &doubles::request(),
            &CancellationToken::new(),
            TURN_DEADLINE,
        )
        .await;
        let seen = events.lock().unwrap().clone();
        assert!(seen
            .iter()
            .all(|event| event["tab"] == "tab-1" && event["turn"] == "turn-1"));
        assert_eq!(
            updates(&events),
            wire(&[
                // Pending text is passed on before the tool activity and before the end.
                TurnUpdate::Text {
                    delta: "Checking.".into()
                },
                TurnUpdate::Tool {
                    source: ToolSource::Engine,
                    line: vec!["Nf6".into()]
                },
                TurnUpdate::Reset,
                TurnUpdate::Text {
                    delta: "Play [[Nf6]].".into()
                },
                TurnUpdate::Completed {
                    segments: vec![
                        Segment::Text {
                            text: "Play ".into()
                        },
                        Segment::Line {
                            san: vec!["Nf6".into()],
                            uci: vec!["g8f6".into()]
                        },
                        Segment::Text { text: ".".into() },
                    ],
                    failed_lines: 0,
                },
            ])
        );
        // The wire names are the renderer's contract.
        assert_eq!(seen[1]["update"]["type"], "tool");
        assert_eq!(seen[1]["update"]["source"], "engine");
        assert_eq!(seen[4]["update"]["type"], "completed");
        assert_eq!(seen[4]["update"]["failedLines"], 0);
        assert_eq!(seen[4]["update"]["segments"][1]["type"], "line");
    }

    #[tokio::test]
    async fn cancelled_and_failed_turns_end_with_their_own_terminal_event() {
        use crate::coach::{
            backend::RoundFailure, tools::tests::ScriptedAnalyst, turn::tests as doubles,
        };
        let position = TurnPosition::new(START, &[]).unwrap();
        for (failure, expected) in [
            (
                CoachError::Cancelled,
                TurnUpdate::Cancelled {
                    text: "Half".into(),
                },
            ),
            (
                CoachError::RateLimited,
                TurnUpdate::Failed {
                    error: CoachError::RateLimited,
                    text: "Half".into(),
                },
            ),
        ] {
            let (app, events) = turn_app();
            let backend = doubles::ScriptedBackend::new(vec![Err(RoundFailure {
                error: failure,
                text: "Half".into(),
            })]);
            drive_turn(
                app.handle(),
                "tab",
                "turn",
                &backend,
                &mut ScriptedAnalyst::default(),
                None,
                &position,
                &doubles::request(),
                &CancellationToken::new(),
                TURN_DEADLINE,
            )
            .await;
            assert_eq!(updates(&events), wire(&[expected]));
        }
    }

    /// A model that streams a little and then never finishes.
    struct StalledBackend;

    #[async_trait::async_trait]
    impl ModelBackend for StalledBackend {
        async fn round(
            &self,
            _request: backend::RoundRequest<'_>,
            on_text: &mut backend::TextSink<'_>,
            _cancellation: &CancellationToken,
        ) -> Result<backend::Round, backend::RoundFailure> {
            on_text("So far");
            std::future::pending().await
        }
    }

    #[tokio::test]
    async fn a_turn_past_its_deadline_fails_with_the_text_so_far_and_cancels_its_token() {
        use crate::coach::{tools::tests::ScriptedAnalyst, turn::tests as doubles};
        let (app, events) = turn_app();
        let cancellation = CancellationToken::new();
        let position = TurnPosition::new(START, &[]).unwrap();
        drive_turn(
            app.handle(),
            "tab",
            "turn",
            &StalledBackend,
            &mut ScriptedAnalyst::default(),
            None,
            &position,
            &doubles::request(),
            &cancellation,
            Duration::from_millis(40),
        )
        .await;
        assert_eq!(
            updates(&events),
            wire(&[
                TurnUpdate::Text {
                    delta: "So far".into()
                },
                TurnUpdate::Failed {
                    error: CoachError::LimitExceeded,
                    text: "So far".into()
                },
            ])
        );
        assert!(cancellation.is_cancelled());
    }

    #[tokio::test]
    async fn a_turn_is_refused_before_it_starts_and_leaves_no_trace() {
        let (app, events) = turn_app();
        // Off, or not initialized: nothing is looked at.
        for coach in [None, Some(test_coach(false))] {
            let state = crate::AppState::default();
            let _directory = coach.map(|(coach, directory)| {
                assert!(state.coach.set(coach).is_ok());
                directory
            });
            assert_eq!(
                start_turn(
                    "ticket".into(),
                    "tab".into(),
                    turn_input(some_handle()),
                    &state,
                    app.handle().clone(),
                    "main",
                )
                .await,
                Err(CoachError::Unavailable)
            );
        }

        let (coach, _directory) = test_coach(true);
        let connection = local_connection(&coach, "http://127.0.0.1:9/v1", None).await;
        let state = crate::AppState::default();
        assert!(state.coach.set(coach).is_ok());
        let start = |ticket: &str, tab: &str, input: TurnInput| {
            start_turn(
                ticket.to_owned(),
                tab.to_owned(),
                input,
                &state,
                app.handle().clone(),
                "main",
            )
        };
        assert_eq!(
            start("ticket", "", turn_input(connection.clone())).await,
            Err(CoachError::InvalidInput)
        );
        let mut empty = turn_input(connection.clone());
        empty.message = String::new();
        assert_eq!(
            start("ticket", "tab", empty).await,
            Err(CoachError::InvalidInput)
        );
        assert_eq!(
            start("ticket", "tab", turn_input(some_handle())).await,
            Err(CoachError::NotFound)
        );
        // A ticket that was never reserved for this tab starts nothing.
        assert_eq!(
            start("ticket", "tab", turn_input(connection.clone())).await,
            Err(CoachError::InvalidInput)
        );
        let ticket = state
            .operations
            .prepare_analysis("main", "other-tab")
            .unwrap();
        assert_eq!(
            start(&ticket, "tab", turn_input(connection.clone())).await,
            Err(CoachError::InvalidInput)
        );
        // Every refusal gave its place back, and none of them reported a turn.
        let held = state
            .coach
            .get()
            .unwrap()
            .turns
            .take("main", "tab")
            .unwrap();
        let ticket = state.operations.prepare_analysis("main", "tab").unwrap();
        assert_eq!(
            start(&ticket, "tab", turn_input(connection)).await,
            Err(CoachError::Busy)
        );
        drop(held);
        assert!(events.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_started_turn_without_a_working_engine_fails_through_its_event_and_frees_everything()
    {
        let (app, events) = turn_app();
        let (coach, _directory) = test_coach(true);
        let connection = local_connection(&coach, "http://127.0.0.1:9/v1", None).await;
        let state = crate::AppState::default();
        assert!(state.coach.set(coach).is_ok());
        let ticket = state.operations.prepare_analysis("main", "tab").unwrap();

        let started = start_turn(
            ticket.clone(),
            "tab".into(),
            turn_input(connection),
            &state,
            app.handle().clone(),
            "main",
        )
        .await;
        // The turn started, so the command answers with the end its last event also carried.
        let failed = TurnUpdate::Failed {
            error: CoachError::EngineFailed,
            text: String::new(),
        };
        assert_eq!(started, Ok(failed.clone()));
        let seen = events.lock().unwrap().clone();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0]["tab"], "tab");
        assert_eq!(seen[0]["turn"], ticket.as_str());
        assert_eq!(updates(&events), wire(&[failed]));
        // The place, the operation and the engine key are free again.
        assert!(state
            .coach
            .get()
            .unwrap()
            .turns
            .0
            .lock()
            .unwrap()
            .is_empty());
        assert!(state
            .operations
            .claim_analysis(&ticket, "main", "tab", "again")
            .is_err());
        assert!(state
            .engine_supervisor
            .get_exact(&EngineKey::new("analysis".into(), ticket).unwrap())
            .is_none());
    }
}
