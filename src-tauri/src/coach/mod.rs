//! Coach: an AI chat about the position (d-20261122-18 to d-20261122-21).
//!
//! The native side owns the connections, their secrets and all provider traffic. The renderer
//! sees connection summaries and model lists, never a key or a token.

pub(crate) mod accounts;
pub(crate) mod address;
pub(crate) mod answer;
pub(crate) mod assistant;
pub(crate) mod attempts;
pub(crate) mod backend;
pub(crate) mod brackets;
pub(crate) mod chat_completions;
pub(crate) mod chatgpt;
pub(crate) mod connections;
pub(crate) mod driver;
pub(crate) mod engine;
pub(crate) mod error;
pub(crate) mod grok;
pub(crate) mod http;
pub(crate) mod lines;
pub(crate) mod model_loop;
pub(crate) mod models;
pub(crate) mod prompt;
pub(crate) mod responses;
pub(crate) mod scoresheet;
pub(crate) mod scoresheet_photo;
pub(crate) mod sse;
pub(crate) mod stats;
#[cfg(test)]
pub(crate) mod test_server;
pub(crate) mod tools;
pub(crate) mod turn;

use std::{
    collections::HashSet,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_plugin_opener::OpenerExt;
use tauri_specta::Event;
use tokio_util::sync::CancellationToken;

pub(crate) use self::assistant::{AssistantTurnEvent, AssistantTurnInput, AssistantTurnUpdate};
pub(crate) use self::scoresheet::{ScoresheetGame, ScoresheetReadInput, MAX_SCORESHEET_READS};
pub(crate) use self::scoresheet_photo::{
    clear_window_dropped_photos, handle_drop as handle_scoresheet_drop, DroppedPhotoSlots,
    ScoresheetPhoto, ScoresheetPhotoBatch, ScoresheetPhotosDropped,
};
use self::{
    accounts::{Accounts, ConnectionBearer, HeldSignIn, SignInProvider},
    address::Address,
    answer::{Answer, Segment},
    assistant::AssistantTurnParts,
    attempts::{SignInAttempts, SignInKind},
    backend::{Message, ModelBackend},
    chat_completions::ChatCompletions,
    chatgpt::{BrowserOpener, ChatGpt},
    connections::{
        ApiConnectionInput, ConnectionRemoved, ConnectionSaved, ConnectionSummary, Connections,
        Secret,
    },
    driver::{DrivenTurn, TurnOutcome, UpdateEmitter, TURN_DEADLINE},
    engine::{Analyst, EngineAnalyst},
    error::CoachError,
    grok::{Grok, GrokCode, PendingSignIn},
    http::HttpClients,
    lines::TurnPosition,
    model_loop::ProgressSink,
    models::{ModelList, MAX_MODEL_LIST_BYTES},
    responses::{PlanProvider, Responses},
    stats::{DatabaseStatistics, Statistics},
    tools::{ToolActivity, ToolSource},
    turn::TurnRequest,
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
pub(crate) const MAX_QUESTION_CHARS: usize = 4000;
pub(crate) const MAX_HISTORY_MESSAGES: usize = 40;
pub(crate) const MAX_HISTORY_BYTES: usize = 96 * 1024;
const MAX_GAME_BYTES: usize = 24 * 1024;
const MAX_REPERTOIRE_BYTES: usize = 8 * 1024;
pub(crate) const MAX_MODEL_CHARS: usize = 200;
pub(crate) const MAX_EFFORT_CHARS: usize = 32;
const MAX_TURN_PLIES: usize = 2000;
const MAX_TAB_CHARS: usize = 128;

/// Assistant turns that may run at the same time (at most one per window).
pub(crate) const MAX_ASSISTANT_TURNS: usize = 4;
pub(crate) const MAX_ASSISTANT_TURN_ID_CHARS: usize = 128;
pub(crate) const MAX_ASSISTANT_TOPICS: usize = 64;
pub(crate) const MAX_ASSISTANT_TOPIC_BODY_BYTES: usize = 32 * 1024;
pub(crate) const MAX_ASSISTANT_TOPICS_TOTAL_BYTES: usize = 512 * 1024;
pub(crate) const MAX_ASSISTANT_SETTINGS: usize = 256;
pub(crate) const MAX_ASSISTANT_SETTINGS_TOTAL_BYTES: usize = 128 * 1024;
pub(crate) const MAX_ASSISTANT_TARGETS: usize = 512;
pub(crate) const MAX_ASSISTANT_ENGINES: usize = 64;
pub(crate) const MAX_ASSISTANT_ID_CHARS: usize = 128;
pub(crate) const MAX_ASSISTANT_TITLE_CHARS: usize = 200;
pub(crate) const MAX_ASSISTANT_SUMMARY_CHARS: usize = 400;
pub(crate) const MAX_ASSISTANT_DESCRIPTION_CHARS: usize = 400;
pub(crate) const MAX_ASSISTANT_PAGE_CHARS: usize = 128;
pub(crate) const MAX_ASSISTANT_TAB_KIND_CHARS: usize = 64;
pub(crate) const MAX_ASSISTANT_LANGUAGE_CHARS: usize = 32;
pub(crate) const MAX_ASSISTANT_ENGINE_NAME_CHARS: usize = 128;
pub(crate) const MAX_ASSISTANT_TOPICS_PER_CALL: usize = 4;

/// Kill switch for the Coach in release builds. Felix released it on 2026-11-24; setting it
/// false in a patch release hides the Coach again. `.dev` builds always have it.
pub(crate) const RELEASE_AVAILABLE: bool = true;

fn available_for(identifier: &str) -> bool {
    RELEASE_AVAILABLE || identifier.ends_with(".dev")
}

pub(crate) struct Coach {
    available: bool,
    connections: Connections,
    credentials: Arc<CoachCredentials>,
    http: HttpClients,
    turns: Arc<TurnSlots>,
    assistant_turns: Arc<TurnSlots<String, MAX_ASSISTANT_TURNS>>,
    scoresheet_reads: Arc<TurnSlots<String, MAX_SCORESHEET_READS>>,
    chatgpt: Arc<ChatGpt>,
    grok: Arc<Grok>,
    /// The tokens of the signed-in connections.
    accounts: Accounts,
    sign_ins: Arc<SignInAttempts>,
    /// The Grok sign-in whose result has not been fetched yet.
    grok_sign_in: Arc<PendingSignIn>,
    /// Per-window-label pending grants for dropped scoresheet photos.
    dropped_photos: DroppedPhotoSlots,
}

/// Active turns, keyed by `K`: one per key, `MAX` overall.
pub(crate) struct TurnSlots<K = (String, String), const MAX: usize = MAX_TURNS>(
    pub(crate) Mutex<HashSet<K>>,
);

impl<K, const MAX: usize> Default for TurnSlots<K, MAX> {
    fn default() -> Self {
        Self(Mutex::new(HashSet::new()))
    }
}

/// One running turn's place. Dropping it frees the place on every way the turn ends.
pub(crate) struct TurnSlot<K: Eq + std::hash::Hash, const MAX: usize> {
    slots: Arc<TurnSlots<K, MAX>>,
    key: K,
}

impl<K: Eq + std::hash::Hash + Clone, const MAX: usize> TurnSlots<K, MAX> {
    pub(crate) fn take_key(self: &Arc<Self>, key: K) -> Result<TurnSlot<K, MAX>, CoachError> {
        let mut running = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if running.len() >= MAX || !running.insert(key.clone()) {
            return Err(CoachError::Busy);
        }
        Ok(TurnSlot {
            slots: Arc::clone(self),
            key,
        })
    }
}

impl TurnSlots<(String, String), MAX_TURNS> {
    fn take(
        self: &Arc<Self>,
        window: &str,
        tab: &str,
    ) -> Result<TurnSlot<(String, String), MAX_TURNS>, CoachError> {
        self.take_key((window.to_owned(), tab.to_owned()))
    }
}

impl<K: Eq + std::hash::Hash, const MAX: usize> Drop for TurnSlot<K, MAX> {
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

/// Whether `text` is a short plain value: not empty, at most `max_chars` characters, and without
/// control characters. The one check for every label, id and name that crosses into the Coach.
pub(crate) fn plain(text: &str, max_chars: usize) -> bool {
    !text.is_empty() && text.chars().count() <= max_chars && !text.chars().any(char::is_control)
}

pub(crate) fn effort_is_plain(effort: Option<&str>) -> bool {
    effort.is_none_or(|effort| {
        !effort.is_empty()
            && effort.len() <= MAX_EFFORT_CHARS
            && effort
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    })
}

/// One prior turn message that can be bounded and converted into a provider [`Message`].
pub(crate) trait HistoryEntry {
    fn is_user(&self) -> bool;
    fn text_len(&self) -> usize;
    fn into_text(self) -> String;
}

impl HistoryEntry for HistoryMessage {
    fn is_user(&self) -> bool {
        matches!(self.role, HistoryRole::User)
    }

    fn text_len(&self) -> usize {
        self.text.len()
    }

    fn into_text(self) -> String {
        self.text
    }
}

/// The newest history messages that fit the bounds, oldest first. Older ones are left out rather
/// than refused: a long conversation stays usable.
pub(crate) fn bounded_history<M: HistoryEntry>(history: Vec<M>) -> Vec<Message> {
    let mut kept = Vec::new();
    let mut bytes = 0;
    for message in history.into_iter().rev() {
        bytes += message.text_len();
        if kept.len() == MAX_HISTORY_MESSAGES || bytes > MAX_HISTORY_BYTES {
            break;
        }
        let is_user = message.is_user();
        let text = message.into_text();
        kept.push(if is_user {
            Message::User(text)
        } else {
            Message::Assistant {
                text,
                tool_calls: Vec::new(),
                extra: serde_json::Map::new(),
            }
        });
    }
    kept.reverse();
    kept
}

impl TurnInput {
    fn into_parts(self) -> Result<TurnParts, CoachError> {
        let question = self.message.trim();
        if question.is_empty()
            || question.chars().count() > MAX_QUESTION_CHARS
            || !plain(&self.model, MAX_MODEL_CHARS)
            || !effort_is_plain(self.effort.as_deref())
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

struct CoachUpdateEmitter<'a, R: tauri::Runtime> {
    app: &'a tauri::AppHandle<R>,
    tab: &'a str,
    turn: &'a str,
}

impl<R: tauri::Runtime> UpdateEmitter for CoachUpdateEmitter<'_, R> {
    type Tool = ToolActivity;
    type Answer = Answer;
    type Update = TurnUpdate;

    fn text(&self, delta: String) -> TurnUpdate {
        TurnUpdate::Text { delta }
    }

    fn reset(&self) -> TurnUpdate {
        TurnUpdate::Reset
    }

    fn tool(&self, activity: ToolActivity) -> TurnUpdate {
        TurnUpdate::Tool {
            source: activity.source,
            line: activity.line,
        }
    }

    fn completed(&self, answer: Answer) -> TurnUpdate {
        TurnUpdate::Completed {
            failed_lines: u32::try_from(answer.failed.len()).unwrap_or(u32::MAX),
            segments: answer.segments,
        }
    }

    fn cancelled(&self, text: String) -> TurnUpdate {
        TurnUpdate::Cancelled { text }
    }

    fn failed(&self, error: CoachError, text: String) -> TurnUpdate {
        TurnUpdate::Failed { error, text }
    }

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
}

struct CoachTurn<'a, 'b> {
    backend: &'a dyn ModelBackend,
    analyst: &'a mut dyn Analyst,
    statistics: Option<&'a mut (dyn Statistics + 'b)>,
    position: &'a TurnPosition,
    request: &'a TurnRequest,
    cancellation: &'a CancellationToken,
}

#[async_trait]
impl DrivenTurn<ToolActivity, Answer> for CoachTurn<'_, '_> {
    async fn run(self, sink: &mut dyn ProgressSink<ToolActivity>) -> TurnOutcome<Answer> {
        turn::run_turn(
            self.backend,
            self.analyst,
            self.statistics,
            self.position,
            self.request,
            sink,
            self.cancellation,
        )
        .await
    }
}

/// Runs an admitted turn to its end and reports it: progress while it runs, then exactly one
/// terminal event. The terminal update is also returned, for the command's own reply.
// Keeps `start_turn` and the turn tests free of driver wiring by packing the Coach's separately
// owned pieces into `CoachUpdateEmitter` and `CoachTurn` and handing them to `driver::drive`.
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
    let emitter = CoachUpdateEmitter {
        app,
        tab,
        turn: turn_id,
    };
    let turn = CoachTurn {
        backend,
        analyst,
        statistics,
        position,
        request,
        cancellation,
    };
    driver::drive(&emitter, turn, cancellation, deadline).await
}

impl Coach {
    fn new(available: bool, credentials: Arc<CoachCredentials>) -> Result<Self, CoachError> {
        let http = HttpClients::new()?;
        let chatgpt = ChatGpt::new(http.public().clone());
        let grok = Grok::new(http.public().clone());
        Ok(Self::with_providers(
            available,
            credentials,
            http,
            chatgpt,
            grok,
        ))
    }

    /// The Coach around given sign-in providers, which tests point at provider doubles.
    fn with_providers(
        available: bool,
        credentials: Arc<CoachCredentials>,
        http: HttpClients,
        chatgpt: ChatGpt,
        grok: Grok,
    ) -> Self {
        let connections = Connections::new(credentials.clone());
        let (chatgpt, grok) = (Arc::new(chatgpt), Arc::new(grok));
        Self {
            available,
            accounts: Accounts::start(connections.clone(), chatgpt.clone(), grok.clone()),
            connections,
            credentials,
            http,
            turns: Arc::default(),
            assistant_turns: Arc::default(),
            scoresheet_reads: Arc::default(),
            chatgpt,
            grok,
            sign_ins: Arc::default(),
            grok_sign_in: Arc::default(),
            dropped_photos: DroppedPhotoSlots::default(),
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
                    PlanProvider::ChatGpt,
                )))
            }
            Secret::Grok(secret) => {
                if secret.refresh_token.is_none() {
                    return Err(CoachError::SignInAgain);
                }
                Ok(Box::new(Responses::new(
                    self.grok.http().clone(),
                    self.grok.api("responses"),
                    ConnectionBearer {
                        accounts: self.accounts.clone(),
                        handle,
                    },
                    PlanProvider::Grok,
                )))
            }
        }
    }

    /// The models of a sign-in, from its provider's model list at `url`. A token refused before
    /// the answer was read is replaced once.
    async fn plan_models(
        &self,
        handle: CoachConnectionHandle,
        provider: PlanProvider,
        http: &reqwest::Client,
        url: String,
    ) -> Result<ModelList, CoachError> {
        let mut bearer = self.accounts.bearer(handle.clone()).await?;
        for retry in [false, true] {
            let request = http.get(&url).bearer_auth(&bearer.token);
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
                    let (error, message) =
                        responses::classify_plan_refusal(provider, status, &body, false, false);
                    log::warn!(
                        "coach: the plan model list was refused with HTTP {status}: {}",
                        http::diagnostic(&message, Some(&bearer.token))
                    );
                    return Err(error);
                }
            }
        }
        Err(CoachError::ProviderFailure)
    }

    /// Removes a connection: here first, durably, with whatever the token owner holds for it;
    /// then, for a sign-in, the provider is asked once to withdraw it. The token used for that
    /// is already gone from this computer.
    ///
    /// The removal does not depend on the keyring being readable. What is withdrawn is the token
    /// in memory if there is one (a rotation may not have reached the keyring), otherwise the
    /// stored one. With neither, and a keyring that could not be read, a sign-in may be left at
    /// the provider, and the result says so.
    async fn remove(&self, handle: CoachConnectionHandle) -> Result<ConnectionRemoved, CoachError> {
        let stored = self.connections.secret(handle.clone()).await;
        let mut removed = self.connections.remove(handle.clone()).await?;
        let held = match self.accounts.forget(handle).await {
            Ok(held) => held,
            Err(error) => {
                log::warn!("coach: the removed connection's tokens were not dropped: {error:?}");
                None
            }
        };
        let unread = matches!(stored, Err(CoachError::Storage));
        let sign_in = held.or_else(|| match stored.ok()? {
            Secret::ChatGpt(secret) => Some(HeldSignIn {
                provider: SignInProvider::ChatGpt {
                    client_id: secret.client_id,
                },
                // A sign-in the provider already ended has no token left to withdraw.
                refresh: secret.refresh_token?,
            }),
            Secret::Grok(secret) => Some(HeldSignIn {
                provider: SignInProvider::Grok {
                    token_endpoint: secret.token_endpoint,
                },
                refresh: secret.refresh_token?,
            }),
            Secret::Api { .. } => None,
        });
        removed.revocation_pending = match sign_in {
            Some(HeldSignIn {
                provider: SignInProvider::ChatGpt { client_id },
                refresh,
            }) => !self.chatgpt.revoke(&client_id, &refresh).await,
            Some(HeldSignIn {
                provider: SignInProvider::Grok { .. },
                refresh,
            }) => !self.grok.revoke(&refresh).await,
            None => unread,
        };
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
                        .signed_in(
                            saved.connection.handle.clone(),
                            SignInProvider::ChatGpt { client_id },
                            tokens,
                        )
                        .await?;
                    Ok(saved)
                },
            )
            .await
    }

    async fn models(&self, handle: CoachConnectionHandle) -> Result<ModelList, CoachError> {
        let (address, key) = match self.connections.secret(handle.clone()).await? {
            Secret::Api { address, key } => (address, key),
            Secret::ChatGpt(_) => {
                let (http, url) = (self.chatgpt.http(), self.chatgpt.api("models"));
                return self
                    .plan_models(handle, PlanProvider::ChatGpt, http, url)
                    .await;
            }
            Secret::Grok(_) => {
                let (http, url) = (self.grok.http(), self.grok.api("models"));
                return self
                    .plan_models(handle, PlanProvider::Grok, http, url)
                    .await;
            }
        };
        // The class is derived from the stored text on every use, never taken from the caller.
        let address = Address::parse(&address).map_err(|_| CoachError::NeedsRepair)?;
        let url = address.endpoint("models");
        let mut request = self.http.for_address(&address).get(url.clone());
        if let Some(key) = key.as_deref().filter(|_| address.owns(&url)) {
            request = request.bearer_auth(key);
        }
        let (status, body) = http::send_bounded(request, MAX_MODEL_LIST_BYTES).await?;
        if status == 200 {
            return models::parse_model_list(&body);
        }
        let message = http::error_text(&body);
        log::warn!(
            "coach: the model list was refused with HTTP {status}: {}",
            http::diagnostic(&message, key.as_deref())
        );
        if http::key_refused(status, &message) {
            Err(CoachError::KeyRejected)
        } else if status == 429 {
            Err(CoachError::RateLimited)
        } else {
            Err(CoachError::ProviderFailure)
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
    .map_err(connections::storage_failure(
        "opening the connection registry",
    ))?;
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

/// Whether the Coach is available and at least one connection exists in the credential registry,
/// answered without reading the system keyring.
#[tauri::command]
#[specta::specta]
pub(crate) async fn coach_has_connection(
    state: tauri::State<'_, crate::AppState>,
) -> Result<bool, CoachError> {
    coach(&state)?.connections.has_any().await
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

/// Starts a sign-in with Grok and returns the code the user enters at the provider. The page for
/// it is opened in the system browser. `attempt` is the caller's own id for this sign-in: the one
/// `coach_finish_grok_sign_in` waits with and `coach_cancel_sign_in` takes.
#[tauri::command]
#[specta::specta]
pub(crate) async fn coach_begin_grok_sign_in(
    attempt: String,
    state: tauri::State<'_, crate::AppState>,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<GrokCode, CoachError> {
    begin_grok_sign_in(attempt, &state, window.label(), browser_opener(app)).await
}

async fn begin_grok_sign_in(
    attempt: String,
    state: &crate::AppState,
    window: &str,
    opener: BrowserOpener,
) -> Result<GrokCode, CoachError> {
    let coach = coach(state)?;
    let sign_in = grok::SignIn {
        grok: coach.grok.clone(),
        connections: coach.connections.clone(),
        accounts: coach.accounts.clone(),
        attempts: coach.sign_ins.clone(),
        pending: coach.grok_sign_in.clone(),
    };
    sign_in.begin(attempt, window.to_owned(), opener).await
}

/// Waits until the Grok sign-in with this id is over and returns its connection. A sign-in that
/// is unknown, was replaced by a newer one, or whose result was already fetched is `cancelled`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn coach_finish_grok_sign_in(
    attempt: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<ConnectionSaved, CoachError> {
    coach(&state)?.grok_sign_in.finish(&attempt).await
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

#[tauri::command]
#[specta::specta]
pub(crate) async fn scoresheet_pick_photos(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<ScoresheetPhotoBatch, CoachError> {
    scoresheet_photo::pick_photos(app, &state).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn scoresheet_paste_photo(
    state: tauri::State<'_, crate::AppState>,
) -> Result<ScoresheetPhoto, CoachError> {
    scoresheet_photo::paste_photo(&state).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn scoresheet_take_dropped_photos(
    drop: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
) -> Result<ScoresheetPhotoBatch, CoachError> {
    scoresheet_photo::take_dropped_photos(drop, &window, &state).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn scoresheet_read(
    read: ScoresheetReadInput,
    ticket: Option<String>,
    state: tauri::State<'_, crate::AppState>,
    window: tauri::WebviewWindow,
) -> Result<ScoresheetGame, CoachError> {
    scoresheet::read_scoresheet(read, ticket, &state, window.label()).await
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

/// Runs one Assistant turn under a window-owned native read reservation. `id` is the renderer's
/// turn id carried on every `AssistantTurnEvent`; `ticket` is the read reservation reserved with
/// `prepare_native_read`. One Assistant turn may run per window, separate from the Coach's turn
/// slots. Returns the same terminal update the last event carried; an `Err` means the turn never
/// started and no event follows.
#[tauri::command]
#[specta::specta]
pub(crate) async fn assistant_turn(
    id: String,
    ticket: String,
    turn: AssistantTurnInput,
    state: tauri::State<'_, crate::AppState>,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<AssistantTurnUpdate, CoachError> {
    start_assistant_turn(id, ticket, turn, state.inner(), app, window.label()).await
}

async fn start_assistant_turn<R: tauri::Runtime>(
    id: String,
    ticket: String,
    turn: AssistantTurnInput,
    state: &crate::AppState,
    app: tauri::AppHandle<R>,
    window: &str,
) -> Result<AssistantTurnUpdate, CoachError> {
    let coach = coach(state)?;
    if !plain(&id, MAX_ASSISTANT_TURN_ID_CHARS) {
        return Err(CoachError::InvalidInput);
    }
    let AssistantTurnParts {
        connection,
        request,
    } = turn.into_parts()?;
    let slot = coach.assistant_turns.take_key(window.to_owned())?;
    let operation = state
        .operations
        .claim_read(&ticket, window, &format!("assistant_turn {id}"))
        .map_err(|_| CoachError::Busy)?;
    let backend = coach.backend(connection).await?;
    let cancellation = operation.token();
    let workflow = async move {
        let _slot = slot;
        let end = assistant::drive_turn(
            &app,
            &id,
            backend.as_ref(),
            &request,
            &cancellation,
            TURN_DEADLINE,
        )
        .await;
        Ok(end)
    };
    crate::infra::operations::run_native_operation(operation, "assistant_turn", workflow)
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
    fn release_and_dev_builds_have_the_coach_while_the_release_switch_is_on() {
        assert!(available_for("com.chessriddle.studio"));
        assert!(available_for("com.chessriddle.studio.dev"));
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
                coach_has_connection(app.state()).await.unwrap_err(),
                CoachError::Unavailable
            );
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
                begin_grok_sign_in("attempt".into(), &state, "main", no_browser.clone())
                    .await
                    .unwrap_err(),
                CoachError::Unavailable
            );
            assert_eq!(
                coach_finish_grok_sign_in("attempt".into(), app.state())
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

    /// A Coach whose sign-ins talk to the provider double.
    fn signed_in_coach(
        provider: &crate::coach::chatgpt::tests::Provider,
    ) -> (
        crate::AppState,
        Arc<test_server::FaultyStore>,
        tempfile::TempDir,
    ) {
        let store = Arc::new(test_server::FaultyStore::default());
        let (credentials, directory) = CoachCredentials::for_test(store.clone());
        let coach = Coach::with_providers(
            true,
            Arc::new(credentials),
            HttpClients::new().unwrap(),
            provider.chatgpt(Duration::from_secs(30)),
            crate::coach::grok::tests::grok(&provider.server),
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
    async fn a_grok_sign_in_runs_through_its_two_commands_and_answers_with_its_tokens() {
        let provider = crate::coach::chatgpt::tests::Provider::start();
        let (state, store, _directory) = signed_in_coach(&provider);
        let app = tauri::test::mock_app();
        app.manage(state.clone());
        let (opening, mut opened) = tokio::sync::mpsc::unbounded_channel::<String>();
        let opener: BrowserOpener = Arc::new(move |url: &str| {
            let _ = opening.send(url.to_owned());
            Ok(())
        });

        // The user never approves: the cancel command ends the wait, and nothing is stored.
        provider.answer(
            StatusCode::BAD_REQUEST,
            serde_json::json!({ "error": "authorization_pending" }),
        );
        let code = begin_grok_sign_in("grok-1".into(), &state, "main", opener.clone())
            .await
            .unwrap();
        assert_eq!(code.user_code, "WXYZ-9876");
        assert_eq!(code.verification_url, provider.server.url("/activate"));
        // The code is handed out first and the page opened after it, so a slow browser cannot
        // hold the dialog back: the page is waited for here, not expected to be open already.
        let page = tokio::time::timeout(Duration::from_secs(10), opened.recv())
            .await
            .expect("the sign-in page is opened");
        assert_eq!(page, Some(provider.server.url("/activate")));
        coach_cancel_sign_in("grok-1".into(), app.state())
            .await
            .unwrap();
        assert_eq!(
            coach_finish_grok_sign_in("grok-1".into(), app.state())
                .await
                .unwrap_err(),
            CoachError::Cancelled
        );
        let coach = the_coach(&state);
        assert!(coach.connections.list().await.unwrap().is_empty());

        // The user approves: the second command returns the connection.
        provider.answer(
            StatusCode::OK,
            crate::coach::chatgpt::tests::tokens(1, None, ""),
        );
        begin_grok_sign_in("grok-2".into(), &state, "main", opener)
            .await
            .unwrap();
        let saved = coach_finish_grok_sign_in("grok-2".into(), app.state())
            .await
            .unwrap();
        assert_eq!(saved.connection.kind, connections::ConnectionKind::Grok);
        assert_eq!(saved.connection.label, "Grok");
        let handle = saved.connection.handle.clone();
        assert_eq!(
            coach.connections.list().await.unwrap(),
            std::slice::from_ref(&saved.connection)
        );

        // Its models and its rounds are asked with the token of the sign-in.
        provider.api_calls.lock().unwrap().clear();
        let exchanges = provider.forms.lock().unwrap().len();
        assert_eq!(coach.models(handle.clone()).await.unwrap().models.len(), 1);
        let backend = coach.backend(handle.clone()).await.unwrap();
        let round = backend
            .round(
                backend::RoundRequest {
                    model: "grok-plan",
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
        assert_eq!(provider.forms.lock().unwrap().len(), exchanges);

        // Removal: gone here first, then withdrawn at the endpoint the provider names.
        let removed = coach.remove(handle.clone()).await.unwrap();
        assert!(!removed.revocation_pending);
        assert!(crate::credentials::CredentialStore::get(
            store.as_ref(),
            &format!("coach-connection:{}", handle.0)
        )
        .unwrap()
        .is_none());
        let revocations = provider.revocations.lock().unwrap().clone();
        assert_eq!(revocations.len(), 1);
        assert_eq!(revocations[0]["token"], "refresh-1");
        assert_eq!(revocations[0]["client_id"], grok::CLIENT_ID);
        assert_eq!(
            coach.accounts.bearer(handle).await.err(),
            Some(CoachError::NotFound)
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
    async fn a_removal_does_not_depend_on_a_readable_keyring() {
        use std::sync::atomic::Ordering;
        let provider = crate::coach::chatgpt::tests::Provider::start();
        let (state, store, _directory) = signed_in_coach(&provider);
        let coach = the_coach(&state);

        // A sign-in whose tokens the owner holds: removed while the keyring does not answer.
        let saved = start_chatgpt_sign_in(
            "attempt-1",
            &state,
            "main",
            provider.approving_browser(1, "oaiapp_issued"),
        )
        .await
        .unwrap();
        let handle = saved.connection.handle;
        // The provider rotated since, and the new token never reached the keyring.
        provider.refused.lock().unwrap().push("access-1".into());
        provider.answer(
            StatusCode::OK,
            crate::coach::chatgpt::tests::tokens(2, None, ""),
        );
        store.fail_next_write.store(true, Ordering::SeqCst);
        assert_eq!(
            coach.models(handle.clone()).await.err(),
            Some(CoachError::Storage)
        );
        store.silent.store(true, Ordering::SeqCst);
        let removed = coach.remove(handle.clone()).await.unwrap();
        // Withdrawn with the token in memory, the newest one; the stored one is spent.
        assert!(!removed.revocation_pending);
        let revocations = provider.revocations.lock().unwrap().clone();
        assert_eq!(revocations.len(), 1);
        assert_eq!(revocations[0]["token"], "refresh-2");
        assert_eq!(revocations[0]["client_id"], "oaiapp_issued");
        store.silent.store(false, Ordering::SeqCst);
        // Nothing of the sign-in is left in memory.
        assert!(coach
            .accounts
            .forget(handle.clone())
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            coach.accounts.bearer(handle).await.err(),
            Some(CoachError::NotFound)
        );
        assert!(coach.connections.list().await.unwrap().is_empty());

        // A connection of which nothing could be read and nothing is held: it is removed, and
        // the result does not claim that there was nothing to withdraw at a provider.
        let unknown = local_connection(coach, "http://localhost:11434/v1", None).await;
        store.silent.store(true, Ordering::SeqCst);
        let removed = coach.remove(unknown).await.unwrap();
        assert!(removed.revocation_pending);
        assert_eq!(provider.revocations.lock().unwrap().len(), 1);
        store.silent.store(false, Ordering::SeqCst);
        assert!(coach.connections.list().await.unwrap().is_empty());
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
                // Gemini's answer to a wrong key, as observed: 400 with the reason in words.
                .route(
                    "/wrongkey/models",
                    get(|| async {
                        (
                            StatusCode::BAD_REQUEST,
                            r#"{"error":{"code":400,"message":"Please pass a valid API key","status":"INVALID_ARGUMENT"}}"#,
                        )
                    }),
                )
                .route(
                    "/badrequest/models",
                    get(|| async { (StatusCode::BAD_REQUEST, r#"{"error":{"message":"bad"}}"#) }),
                )
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
            ("/wrongkey", CoachError::KeyRejected),
            ("/badrequest", CoachError::ProviderFailure),
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

    #[tokio::test]
    async fn coach_has_connection_reads_registry_without_keyring_and_reports_storage_error() {
        use crate::credentials::CredentialStore;
        use std::sync::atomic::{AtomicUsize, Ordering};

        /// Allows storing a connection into the registry, but fails every keyring read.
        struct NoKeyringReads {
            reads: AtomicUsize,
        }

        impl CredentialStore for NoKeyringReads {
            fn set(&self, _key: &str, _secret: &str) -> Result<(), crate::error::Error> {
                Ok(())
            }

            fn get(&self, _key: &str) -> Result<Option<String>, crate::error::Error> {
                self.reads.fetch_add(1, Ordering::SeqCst);
                Err(crate::error::Error::CredentialFailure(
                    "keyring read must not happen".into(),
                ))
            }

            fn delete(&self, _key: &str) -> Result<(), crate::error::Error> {
                Ok(())
            }
        }

        let store = Arc::new(NoKeyringReads {
            reads: AtomicUsize::new(0),
        });
        let (credentials, _dir) = CoachCredentials::for_test(store.clone());
        let coach = Coach::new(true, Arc::new(credentials)).unwrap();
        let app = tauri::test::mock_app();
        let state = crate::AppState::default();
        assert!(state.coach.set(coach).is_ok());
        app.manage(state);

        // Empty registry -> false, zero keyring reads.
        assert_eq!(coach_has_connection(app.state()).await, Ok(false));
        assert_eq!(store.reads.load(Ordering::SeqCst), 0);

        // Add one connection -> true, still zero keyring reads.
        local_connection(
            app.state::<crate::AppState>().coach.get().unwrap(),
            "http://127.0.0.1:9/v1",
            Some("sk-test"),
        )
        .await;
        assert_eq!(coach_has_connection(app.state()).await, Ok(true));
        assert_eq!(store.reads.load(Ordering::SeqCst), 0);

        // Registry failure (unreadable/poisoned registry) -> Storage, never false.
        let (broken_credentials, _broken_dir) = CoachCredentials::for_test(store);
        broken_credentials.poison_registry_for_test();
        let broken_coach = Coach::new(true, Arc::new(broken_credentials)).unwrap();
        let broken_app = tauri::test::mock_app();
        let broken_state = crate::AppState::default();
        assert!(broken_state.coach.set(broken_coach).is_ok());
        broken_app.manage(broken_state);
        assert_eq!(
            coach_has_connection(broken_app.state()).await,
            Err(CoachError::Storage)
        );
    }

    #[tokio::test]
    async fn assistant_turn_refuses_switch_off_bounds_unclaimable_ticket_and_second_turn() {
        use tauri::Listener;
        let app = tauri::test::mock_app();
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events!(AssistantTurnEvent))
            .mount_events(&app);
        let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let sink = events.clone();
        app.listen_any(AssistantTurnEvent::NAME, move |event| {
            let value = serde_json::from_str(event.payload()).expect("JSON event");
            sink.lock().unwrap().push(value);
        });

        // Switch off / uninitialized -> Unavailable.
        for coach in [None, Some(test_coach(false))] {
            let state = crate::AppState::default();
            let _dir = coach.map(|(coach, dir)| {
                assert!(state.coach.set(coach).is_ok());
                dir
            });
            assert_eq!(
                start_assistant_turn(
                    "turn-1".into(),
                    "ticket".into(),
                    assistant::tests::sample_input(some_handle()),
                    &state,
                    app.handle().clone(),
                    "main",
                )
                .await,
                Err(CoachError::Unavailable)
            );
        }

        let (coach, _dir) = test_coach(true);
        let connection = local_connection(&coach, "http://127.0.0.1:9/v1", None).await;
        let state = crate::AppState::default();
        assert!(state.coach.set(coach).is_ok());

        // Bounds refused before connection or ticket is checked (unknown connection + unknown ticket).
        let mut bad = assistant::tests::sample_input(some_handle());
        bad.message = "   ".into();
        assert_eq!(
            start_assistant_turn(
                "turn-1".into(),
                "no-ticket".into(),
                bad,
                &state,
                app.handle().clone(),
                "main",
            )
            .await,
            Err(CoachError::InvalidInput)
        );
        // Empty turn id is InvalidInput.
        assert_eq!(
            start_assistant_turn(
                String::new(),
                "no-ticket".into(),
                assistant::tests::sample_input(some_handle()),
                &state,
                app.handle().clone(),
                "main",
            )
            .await,
            Err(CoachError::InvalidInput)
        );

        // Unclaimable tickets (unknown, foreign window, cancelled, already claimed, sealed) -> Busy.
        assert_eq!(
            start_assistant_turn(
                "turn-1".into(),
                "unknown-ticket".into(),
                assistant::tests::sample_input(connection.clone()),
                &state,
                app.handle().clone(),
                "main",
            )
            .await,
            Err(CoachError::Busy)
        );
        let foreign_ticket = state.operations.prepare_read("other-window").unwrap();
        assert_eq!(
            start_assistant_turn(
                "turn-1".into(),
                foreign_ticket,
                assistant::tests::sample_input(connection.clone()),
                &state,
                app.handle().clone(),
                "main",
            )
            .await,
            Err(CoachError::Busy)
        );
        let cancelled_ticket = state.operations.prepare_read("main").unwrap();
        state
            .operations
            .cancel_read(&cancelled_ticket, "main")
            .unwrap();
        assert_eq!(
            start_assistant_turn(
                "turn-1".into(),
                cancelled_ticket,
                assistant::tests::sample_input(connection.clone()),
                &state,
                app.handle().clone(),
                "main",
            )
            .await,
            Err(CoachError::Busy)
        );
        let claimed_ticket = state.operations.prepare_read("main").unwrap();
        let _active_read = state
            .operations
            .claim_read(&claimed_ticket, "main", "already")
            .unwrap();
        assert_eq!(
            start_assistant_turn(
                "turn-1".into(),
                claimed_ticket,
                assistant::tests::sample_input(connection.clone()),
                &state,
                app.handle().clone(),
                "main",
            )
            .await,
            Err(CoachError::Busy)
        );
        drop(_active_read);

        // Second turn in the same window -> Busy; Coach's TurnSlots is independent.
        let coach_slot = state
            .coach
            .get()
            .unwrap()
            .turns
            .take("main", "tab-0")
            .unwrap();
        let held_assistant = state
            .coach
            .get()
            .unwrap()
            .assistant_turns
            .take_key("main".to_owned())
            .unwrap();
        let valid_ticket = state.operations.prepare_read("main").unwrap();
        assert_eq!(
            start_assistant_turn(
                "turn-2".into(),
                valid_ticket.clone(),
                assistant::tests::sample_input(connection.clone()),
                &state,
                app.handle().clone(),
                "main",
            )
            .await,
            Err(CoachError::Busy)
        );
        drop(held_assistant);
        drop(coach_slot);

        // Sealed registry -> Busy.
        state.operations.seal_and_request_cancellation().unwrap();
        assert_eq!(
            start_assistant_turn(
                "turn-3".into(),
                valid_ticket,
                assistant::tests::sample_input(connection),
                &state,
                app.handle().clone(),
                "main",
            )
            .await,
            Err(CoachError::Busy)
        );

        // None of the refusals emitted an event or leaked a window slot.
        assert!(events.lock().unwrap().is_empty());
        assert!(state
            .coach
            .get()
            .unwrap()
            .assistant_turns
            .0
            .lock()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn cancelling_read_reservation_stops_assistant_turn_and_frees_window_place() {
        use axum::{body::StreamBody, routing::post};
        use tauri::Listener;
        use tokio::sync::Notify;

        let started_stream = Arc::new(Notify::new());
        let notify_server = started_stream.clone();
        let server = test_server::serve(Router::new().route(
            "/v1/chat/completions",
            post(move || {
                let notify = notify_server.clone();
                async move {
                    notify.notify_one();
                    let first = futures_util::stream::iter([Ok::<_, std::convert::Infallible>(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"Halfway\"}}]}\n\n",
                    )]);
                    let silent = futures_util::stream::pending();
                    (
                        [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
                        StreamBody::new(futures_util::StreamExt::chain(first, silent)),
                    )
                }
            }),
        ));

        let app = tauri::test::mock_app();
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events!(AssistantTurnEvent))
            .mount_events(&app);
        let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let sink = events.clone();
        app.listen_any(AssistantTurnEvent::NAME, move |event| {
            let value = serde_json::from_str(event.payload()).expect("JSON event");
            sink.lock().unwrap().push(value);
        });

        let (coach, _dir) = test_coach(true);
        let connection = local_connection(&coach, &server.url("/v1"), None).await;
        let state = crate::AppState::default();
        assert!(state.coach.set(coach).is_ok());
        let ticket = state.operations.prepare_read("main").unwrap();

        let state_for_cancel = state.clone();
        let ticket_for_cancel = ticket.clone();
        let cancel_task = tokio::spawn(async move {
            started_stream.notified().await;
            // Let the SSE chunk arrive and be processed before cancelling.
            tokio::time::sleep(Duration::from_millis(30)).await;
            state_for_cancel
                .operations
                .cancel_read(&ticket_for_cancel, "main")
                .unwrap();
        });

        let result = start_assistant_turn(
            "turn-cancel".into(),
            ticket.clone(),
            assistant::tests::sample_input(connection),
            &state,
            app.handle().clone(),
            "main",
        )
        .await;
        cancel_task.await.unwrap();

        let expected = AssistantTurnUpdate::Cancelled {
            text: "Halfway".into(),
        };
        assert_eq!(result, Ok(expected.clone()));
        let seen = events.lock().unwrap().clone();
        let terminal: Vec<_> = seen
            .iter()
            .filter(|e| {
                matches!(
                    e["update"]["type"].as_str(),
                    Some("completed" | "cancelled" | "failed")
                )
            })
            .collect();
        assert_eq!(terminal.len(), 1);
        assert_eq!(terminal[0]["turn"], "turn-cancel");
        assert_eq!(
            terminal[0]["update"],
            serde_json::to_value(&expected).unwrap()
        );
        // The window's place is free again.
        assert!(state
            .coach
            .get()
            .unwrap()
            .assistant_turns
            .0
            .lock()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn scoresheet_read_command_enforces_switch_ticket_slots_claim_and_release() {
        use axum::{
            body::StreamBody,
            http::{header::CONTENT_TYPE, StatusCode},
            routing::post,
            Json, Router,
        };
        use base64::Engine as _;

        let jpeg_url = || {
            let bytes = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F'];
            format!(
                "data:image/jpeg;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        };
        let sample_read = |connection: CoachConnectionHandle| ScoresheetReadInput {
            connection,
            model: "vision-model".into(),
            effort: None,
            photos: vec![jpeg_url()],
        };
        let some_handle = || CoachConnectionHandle(uuid::Uuid::new_v4().to_string());

        // 1. Kill switch off / uninitialized -> Unavailable.
        for coach in [None, Some(test_coach(false))] {
            let state = crate::AppState::default();
            let _dir = coach.map(|(coach, dir)| {
                assert!(state.coach.set(coach).is_ok());
                dir
            });
            assert_eq!(
                scoresheet::read_scoresheet(
                    sample_read(some_handle()),
                    Some("ticket".into()),
                    &state,
                    "main"
                )
                .await,
                Err(CoachError::Unavailable)
            );
        }

        // Loopback ChatCompletions server answering one valid scoresheet JSON round.
        let reply = serde_json::json!({
            "status": "ok",
            "headers": { "white": "Alice", "black": "Bob", "result": "1-0" },
            "moves": [{ "n": 1, "white": "e4", "black": "e5" }]
        })
        .to_string();
        let sse_ok = format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            serde_json::json!({ "choices": [{ "index": 0, "delta": { "content": reply } }] }),
            serde_json::json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }] }),
        );
        let ok_server = test_server::serve(Router::new().route(
            "/v1/chat/completions",
            post(move || {
                let body = sse_ok.clone();
                async move {
                    let stream =
                        futures_util::stream::iter([Ok::<_, std::convert::Infallible>(body)]);
                    (
                        [(CONTENT_TYPE, "text/event-stream")],
                        StreamBody::new(stream),
                    )
                }
            }),
        ));
        let err_server = test_server::serve(Router::new().route(
            "/v1/chat/completions",
            post(|| async move {
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(serde_json::json!({ "error": { "message": "slow down" } })),
                )
            }),
        ));
        let hang_server = test_server::serve(Router::new().route(
            "/v1/chat/completions",
            post(|| async move {
                let silent =
                    futures_util::stream::pending::<Result<String, std::convert::Infallible>>();
                (
                    [(CONTENT_TYPE, "text/event-stream")],
                    StreamBody::new(silent),
                )
            }),
        ));

        let (coach, _dir) = test_coach(true);
        let ok_conn = local_connection(&coach, &ok_server.url("/v1"), None).await;
        let err_conn = local_connection(&coach, &err_server.url("/v1"), None).await;
        let hang_conn = local_connection(&coach, &hang_server.url("/v1"), None).await;
        let state = crate::AppState::default();
        assert!(state.coach.set(coach).is_ok());

        // 2. Missing or blank ticket -> InvalidInput.
        for bad_ticket in [None, Some("".into()), Some("   ".into())] {
            assert_eq!(
                scoresheet::read_scoresheet(
                    sample_read(ok_conn.clone()),
                    bad_ticket,
                    &state,
                    "main"
                )
                .await,
                Err(CoachError::InvalidInput)
            );
        }

        // 3. Slot pool refuses a second read in the same window and a third overall -> Busy.
        {
            let slots = &state.coach.get().unwrap().scoresheet_reads;
            let _hold1 = slots.take_key("main".into()).unwrap();
            let t = state.operations.prepare_read("main").unwrap();
            assert_eq!(
                scoresheet::read_scoresheet(sample_read(ok_conn.clone()), Some(t), &state, "main")
                    .await,
                Err(CoachError::Busy)
            );
            let _hold2 = slots.take_key("second".into()).unwrap();
            let t3 = state.operations.prepare_read("third").unwrap();
            assert_eq!(
                scoresheet::read_scoresheet(
                    sample_read(ok_conn.clone()),
                    Some(t3),
                    &state,
                    "third"
                )
                .await,
                Err(CoachError::Busy)
            );
        }

        // 4. claim_read refusal: unknown, foreign-window, and pre-claim cancelled tickets all
        //    answer InvalidInput (in-flight cancellation answers Cancelled, tested in 5c below).
        assert_eq!(
            scoresheet::read_scoresheet(
                sample_read(ok_conn.clone()),
                Some("unknown-ticket".into()),
                &state,
                "main"
            )
            .await,
            Err(CoachError::InvalidInput)
        );
        let foreign = state.operations.prepare_read("other-window").unwrap();
        assert_eq!(
            scoresheet::read_scoresheet(
                sample_read(ok_conn.clone()),
                Some(foreign),
                &state,
                "main"
            )
            .await,
            Err(CoachError::InvalidInput)
        );
        let cancelled = state.operations.prepare_read("main").unwrap();
        state.operations.cancel_read(&cancelled, "main").unwrap();
        assert_eq!(
            scoresheet::read_scoresheet(
                sample_read(ok_conn.clone()),
                Some(cancelled),
                &state,
                "main"
            )
            .await,
            Err(CoachError::InvalidInput)
        );

        let slots_empty = || {
            state
                .coach
                .get()
                .unwrap()
                .scoresheet_reads
                .0
                .lock()
                .unwrap()
                .is_empty()
        };

        // 5a. Slot released after normal completion.
        let t_ok = state.operations.prepare_read("main").unwrap();
        let game =
            scoresheet::read_scoresheet(sample_read(ok_conn.clone()), Some(t_ok), &state, "main")
                .await
                .expect("read succeeded");
        assert_eq!(game.moves.len(), 2);
        assert!(slots_empty());

        // 5b. Slot released after provider error.
        let t_err = state.operations.prepare_read("main").unwrap();
        assert_eq!(
            scoresheet::read_scoresheet(sample_read(err_conn), Some(t_err), &state, "main").await,
            Err(CoachError::RateLimited)
        );
        assert!(slots_empty());

        // 5c. Slot released after in-flight cancellation.
        let t_cancel = state.operations.prepare_read("main").unwrap();
        let ops = state.operations.clone();
        let cancel_ticket = t_cancel.clone();
        let cancel_task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            let _ = ops.cancel_read(&cancel_ticket, "main");
        });
        assert_eq!(
            scoresheet::read_scoresheet(sample_read(hang_conn), Some(t_cancel), &state, "main")
                .await,
            Err(CoachError::Cancelled)
        );
        cancel_task.await.unwrap();
        assert!(slots_empty());
    }
}
