//! Native ChessRiddle connection. The bounded owner queue is the only token consumer.

use crate::{
    credentials::{ChessRiddleAccountHandle, ChessRiddleAccountMetadata, ChessRiddleCredentials},
    error::Error,
    infra::{blocking::BLOCKING_GATEWAY, path_authority::AppDataDir},
    oauth_pkce::{self, AttemptRegistry, OAuthProvider},
};
use futures_util::StreamExt;
use oauth2::TokenResponse;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

pub(crate) const API_ORIGIN: &str = "https://chessriddle.com";
pub(crate) const FEEDBACK_URL: &str = "https://chessriddle.com/api/v1/feedback";
pub(crate) const RELEASE_AVAILABLE: bool = false;
const DEV_API_ORIGIN: Option<&str> = option_env!("CHESSRIDDLE_API_ORIGIN");
const DEV_WEB_ORIGIN: Option<&str> = option_env!("CHESSRIDDLE_WEB_ORIGIN");
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const REFRESH_MARGIN: Duration = Duration::from_secs(60);

#[derive(Clone)]
struct Endpoints {
    origin: String,
    web_origin: String,
    dev_web_override: bool,
    available: bool,
}

fn resolve_origin(
    development: bool,
    override_origin: Option<&str>,
) -> Result<String, AccountError> {
    match (development, override_origin) {
        (true, Some(value)) => {
            let url = url::Url::parse(value).map_err(|_| AccountError::Unavailable)?;
            if url.scheme() != "http"
                || url.host_str() != Some("127.0.0.1")
                || url.port().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
                || !value.starts_with("http://127.0.0.1:")
                || url.port() == Some(0)
            {
                return Err(AccountError::Unavailable);
            }
            Ok(url.origin().ascii_serialization())
        }
        _ => Ok(API_ORIGIN.into()),
    }
}

impl Endpoints {
    fn new(
        identifier: &str,
        api_override: Option<&str>,
        web_override: Option<&str>,
    ) -> Result<Self, AccountError> {
        let development = identifier.ends_with(".dev");
        Ok(Self {
            origin: resolve_origin(development, api_override)?,
            web_origin: resolve_origin(development, web_override)?,
            dev_web_override: development && web_override.is_some(),
            available: RELEASE_AVAILABLE || development,
        })
    }

    fn api(&self, path: &str) -> String {
        format!("{}/api/v1{path}", self.origin)
    }

    fn allowed_link(&self, value: &str) -> bool {
        url::Url::parse(value).is_ok_and(|url| {
            if !url.username().is_empty() || url.password().is_some() {
                return false;
            }
            let authority = value
                .split_once("://")
                .and_then(|(_, remainder)| remainder.split(['/', '?', '#']).next());
            let production = url.scheme() == "https"
                && matches!(url.host_str(), Some("chessriddle.com" | "www.chessriddle.com"))
                && url.port().is_none()
                // URL parsing removes an explicit default port, so also inspect its authority.
                && authority.is_some_and(|authority| !authority.contains(':'));
            production
                || (self.dev_web_override
                    && url.origin().ascii_serialization() == self.web_origin
                    && authority.is_some_and(|authority| {
                        Some(authority) == self.web_origin.strip_prefix("http://")
                    }))
        })
    }

    fn open_link(
        &self,
        value: &str,
        opener: &dyn Fn(&str) -> Result<(), String>,
    ) -> Result<(), AccountError> {
        if !self.allowed_link(value) {
            return Err(AccountError::InvalidLink);
        }
        opener(value).map_err(|_| AccountError::Browser)
    }
}

fn platform() -> Result<&'static str, AccountError> {
    crate::feedback::client_platform_label(std::env::consts::OS).ok_or(AccountError::Unavailable)
}

fn http_client() -> Result<reqwest::Client, AccountError> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        "x-client-surface",
        reqwest::header::HeaderValue::from_static("desktop"),
    );
    headers.insert(
        "x-client-platform",
        reqwest::header::HeaderValue::from_static(platform()?),
    );
    crate::infra::net::native_json_http_client(reqwest::Client::builder().default_headers(headers))
        .map_err(|_| AccountError::Network)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AccountError {
    Unavailable,
    Busy,
    Storage,
    Network,
    RateLimited,
    Server,
    InvalidGrant,
    Authentication,
    InvalidLink,
    Browser,
    AlreadyConnected,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Plan {
    Free,
    Gold,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
pub(crate) struct AccountProfile {
    pub handle: ChessRiddleAccountHandle,
    pub username: Option<String>,
    pub plan: Plan,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum AccountStatus {
    Disconnected,
    ReconnectNeeded,
    Connected {
        account: AccountProfile,
        durability_uncertain: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum DisconnectOutcome {
    NotFound,
    Removed {
        revocation_pending: bool,
        durability_uncertain: bool,
    },
}

// These structures must never implement Debug or Serialize. Only refresh reaches the keyring.
#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
    token_type: String,
}

impl Tokens {
    fn valid(&self) -> bool {
        !self.access_token.is_empty()
            && self.access_token.len() <= 4096
            && !self.refresh_token.is_empty()
            && self.refresh_token.encode_utf16().count() <= 1280
            && self.token_type.eq_ignore_ascii_case("bearer")
            && (1..=3600).contains(&self.expires_in)
    }
}

struct Session {
    account: Option<ChessRiddleAccountMetadata>,
    refresh: String,
    access: Option<(String, Instant)>,
    dirty: bool,
    durability_uncertain: bool,
}

impl Session {
    fn rotated(&mut self, tokens: Tokens) {
        self.refresh = tokens.refresh_token;
        self.access = Some((
            tokens.access_token,
            Instant::now() + Duration::from_secs(tokens.expires_in),
        ));
        self.dirty = true;
    }
}

#[derive(Deserialize)]
struct UserResponse {
    username: Option<String>,
    permissions: Permissions,
}
#[derive(Deserialize)]
struct Permissions {
    tier: Plan,
}

async fn response_bytes(response: reqwest::Response) -> Result<(u16, Vec<u8>), AccountError> {
    let status = response.status().as_u16();
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| AccountError::Network)?;
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(AccountError::Server);
        }
        body.extend_from_slice(&chunk);
    }
    Ok((status, body))
}

fn token_response(status: u16, body: &[u8]) -> Result<Tokens, AccountError> {
    if status == 400 {
        #[derive(Deserialize)]
        struct Failure {
            error: String,
        }
        if serde_json::from_slice::<Failure>(body)
            .is_ok_and(|failure| failure.error == "invalid_grant")
        {
            return Err(AccountError::InvalidGrant);
        }
    }
    match status {
        200 => serde_json::from_slice::<Tokens>(body)
            .ok()
            .filter(Tokens::valid)
            .ok_or(AccountError::Server),
        429 => Err(AccountError::RateLimited),
        _ => Err(AccountError::Server),
    }
}

type BrowserOpener = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;
enum Action {
    Status,
    Connect(BrowserOpener),
    Disconnect,
}
enum Reply {
    Status(AccountStatus),
    Disconnect(DisconnectOutcome),
}
struct Request {
    action: Action,
    reply: oneshot::Sender<Result<Reply, AccountError>>,
}

pub(crate) struct AccountOwner {
    sender: mpsc::Sender<Request>,
}

struct Worker {
    credentials: Arc<ChessRiddleCredentials>,
    endpoints: Endpoints,
    http: reqwest::Client,
    attempts: Arc<AttemptRegistry>,
    session: Option<Session>,
    loaded: bool,
    reconnect_needed: bool,
}

impl AccountOwner {
    fn start(
        credentials: Arc<ChessRiddleCredentials>,
        endpoints: Endpoints,
        http: reqwest::Client,
    ) -> Self {
        let (sender, mut receiver) = mpsc::channel::<Request>(8);
        // The worker owns every accepted request through its terminal state even if IPC is dropped.
        // Dropping the final sender drains the bounded queue, then drops all native tokens.
        tauri::async_runtime::spawn(async move {
            let mut worker = Worker {
                credentials,
                endpoints,
                http,
                attempts: Arc::new(AttemptRegistry::default()),
                session: None,
                loaded: false,
                reconnect_needed: false,
            };
            while let Some(request) = receiver.recv().await {
                let result = worker.execute(request.action).await;
                let _ = request.reply.send(result);
            }
        });
        Self { sender }
    }

    async fn request(&self, action: Action) -> Result<Reply, AccountError> {
        let (reply, receiver) = oneshot::channel();
        self.sender
            .try_send(Request { action, reply })
            .map_err(|_| AccountError::Busy)?;
        receiver.await.map_err(|_| AccountError::Unavailable)?
    }
}

impl Worker {
    async fn load(&mut self) -> Result<(), AccountError> {
        if self.loaded {
            return Ok(());
        }
        if let Some(account) = self
            .credentials
            .list()
            .await
            .map_err(|_| AccountError::Storage)?
            .into_iter()
            .next()
        {
            let refresh = self
                .credentials
                .token(account.handle.clone())
                .await
                .map_err(|_| AccountError::Storage)?;
            if let Some(refresh) = refresh {
                self.session = Some(Session {
                    account: Some(account),
                    refresh,
                    access: None,
                    dirty: false,
                    durability_uncertain: false,
                });
            } else {
                self.reconnect_needed = true;
            }
        }
        self.loaded = true;
        Ok(())
    }

    async fn persist(&mut self) -> Result<(), AccountError> {
        let Some(session) = self.session.as_mut() else {
            return Ok(());
        };
        if !session.dirty {
            return Ok(());
        }
        match &session.account {
            Some(account) => self
                .credentials
                .replace(account.handle.clone(), session.refresh.clone())
                .await
                .map_err(|_| AccountError::Storage)?,
            None => {
                let (account, uncertain) = self
                    .credentials
                    .store("ChessRiddle".into(), session.refresh.clone())
                    .await
                    .map_err(|_| AccountError::Storage)?;
                session.account = Some(account);
                session.durability_uncertain = uncertain;
            }
        }
        session.dirty = false;
        Ok(())
    }

    async fn request_refresh(&self, refresh: &str) -> Result<Tokens, AccountError> {
        let response = self
            .http
            .post(self.endpoints.api("/desktop-auth/token"))
            .form(&[("grant_type", "refresh_token"), ("refresh_token", refresh)])
            .send()
            .await
            .map_err(|_| AccountError::Network)?;
        let (status, body) = response_bytes(response).await?;
        token_response(status, &body)
    }

    async fn refresh(&mut self) -> Result<(), AccountError> {
        self.persist().await?;
        let Some(session) = self.session.as_ref() else {
            return Ok(());
        };
        if session
            .access
            .as_ref()
            .is_some_and(|(_, expiry)| *expiry > Instant::now() + REFRESH_MARGIN)
        {
            return Ok(());
        }
        match self.request_refresh(&session.refresh).await {
            Ok(tokens) => {
                if let Some(session) = self.session.as_mut() {
                    session.rotated(tokens);
                }
                self.persist().await
            }
            Err(AccountError::InvalidGrant) => {
                if let Some(account) = self
                    .session
                    .as_ref()
                    .and_then(|session| session.account.as_ref())
                {
                    self.credentials
                        .remove(account.handle.clone())
                        .await
                        .map_err(|_| AccountError::Storage)?;
                }
                self.session = None;
                self.reconnect_needed = true;
                Err(AccountError::InvalidGrant)
            }
            Err(error) => Err(error),
        }
    }

    async fn status(&mut self) -> Result<AccountStatus, AccountError> {
        match self.refresh().await {
            Err(AccountError::InvalidGrant) => return Ok(AccountStatus::ReconnectNeeded),
            Err(error) => return Err(error),
            Ok(()) => {}
        }
        for retry in [false, true] {
            let Some(session) = self.session.as_ref() else {
                return Ok(if self.reconnect_needed {
                    AccountStatus::ReconnectNeeded
                } else {
                    AccountStatus::Disconnected
                });
            };
            let account = session.account.as_ref().ok_or(AccountError::Storage)?;
            let (access, _) = session
                .access
                .as_ref()
                .ok_or(AccountError::Authentication)?;
            let response = self
                .http
                .get(self.endpoints.api("/users/me"))
                .bearer_auth(access)
                .send()
                .await
                .map_err(|_| AccountError::Network)?;
            let (status, body) = response_bytes(response).await?;
            if status == 401 && !retry {
                // A website revoke is terminal only when refresh confirms invalid_grant.
                if let Some(session) = self.session.as_mut() {
                    session.access = None;
                }
                match self.refresh().await {
                    Err(AccountError::InvalidGrant) => return Ok(AccountStatus::ReconnectNeeded),
                    Err(error) => return Err(error),
                    Ok(()) => continue,
                }
            }
            if status == 429 {
                return Err(AccountError::RateLimited);
            }
            if status != 200 {
                return Err(AccountError::Server);
            }
            let profile: UserResponse =
                serde_json::from_slice(&body).map_err(|_| AccountError::Server)?;
            return Ok(AccountStatus::Connected {
                account: AccountProfile {
                    handle: account.handle.clone(),
                    username: profile.username,
                    plan: profile.permissions.tier,
                },
                durability_uncertain: session.durability_uncertain,
            });
        }
        Err(AccountError::Server)
    }

    async fn connect(&mut self, opener: BrowserOpener) -> Result<AccountStatus, AccountError> {
        if self.session.is_some() {
            return Err(AccountError::AlreadyConnected);
        }
        let authorization_url = format!("{}/auth/connect", self.endpoints.web_origin);
        let endpoints = self.endpoints.clone();
        let token_url = self.endpoints.api("/desktop-auth/token");
        let provider = OAuthProvider {
            authorization_url: &authorization_url,
            token_url: &token_url,
            client_id: "chessriddle-studio",
            scopes: &[],
            extra_params: &[],
        };
        let attempts = self.attempts.clone();
        let http = self.http.clone();
        let mut received = None;
        let received_ref = &mut received;
        oauth_pkce::authenticate(
            provider,
            attempts.clone(),
            Duration::from_secs(180),
            move || oauth_pkce::start_listener_and_server(attempts),
            move |url| {
                endpoints
                    .open_link(url, opener.as_ref())
                    .map_err(|_| "ChessRiddle browser refused".into())
            },
            |client, code, verifier| async move {
                // The helper binds this code and verifier to this provider. Unlike the Lichess
                // exchange, this path never logs a token endpoint's diagnostic body.
                let token = client
                    .exchange_code(code)
                    .set_pkce_verifier(verifier)
                    .request_async(|request| oauth_pkce::safe_oauth_http_client(&http, request))
                    .await
                    .map_err(|_| Error::OAuthFailure("ChessRiddle authentication failed".into()))?;
                let refresh = token.refresh_token().ok_or_else(|| {
                    Error::OAuthFailure("ChessRiddle authentication failed".into())
                })?;
                let tokens = Tokens {
                    access_token: token.access_token().secret().clone(),
                    refresh_token: refresh.secret().clone(),
                    expires_in: token.expires_in().map_or(0, |duration| duration.as_secs()),
                    token_type: "Bearer".into(),
                };
                if !tokens.valid() {
                    return Err(Error::OAuthFailure(
                        "ChessRiddle authentication failed".into(),
                    ));
                }
                *received_ref = Some(tokens);
                Ok(())
            },
        )
        .await
        .map_err(|_| AccountError::Authentication)?;
        let tokens = received.ok_or(AccountError::Authentication)?;
        let mut session = Session {
            account: None,
            refresh: String::new(),
            access: None,
            dirty: false,
            durability_uncertain: false,
        };
        session.rotated(tokens);
        self.session = Some(session);
        self.reconnect_needed = false;
        self.persist().await?;
        self.status().await
    }

    async fn disconnect(&mut self) -> Result<DisconnectOutcome, AccountError> {
        let Some(session) = self.session.as_ref() else {
            return Ok(DisconnectOutcome::NotFound);
        };
        let durability_uncertain = match &session.account {
            Some(account) => self
                .credentials
                .remove(account.handle.clone())
                .await
                .map_err(|_| AccountError::Storage)?
                .unwrap_or(false),
            None => {
                // Complete an interrupted initial keyring write before journalling its deletion.
                self.persist().await?;
                let account = self
                    .session
                    .as_ref()
                    .and_then(|session| session.account.as_ref())
                    .ok_or(AccountError::Storage)?;
                self.credentials
                    .remove(account.handle.clone())
                    .await
                    .map_err(|_| AccountError::Storage)?
                    .unwrap_or(false)
            }
        };
        let session = self.session.take().ok_or(AccountError::Storage)?;
        self.reconnect_needed = false;
        let revoked = self.revoke_session(session).await;
        Ok(DisconnectOutcome::Removed {
            revocation_pending: !revoked,
            durability_uncertain,
        })
    }

    async fn revoke_session(&self, session: Session) -> bool {
        let access = match session.access {
            Some((access, expiry)) if expiry > Instant::now() => access,
            _ => match self.request_refresh(&session.refresh).await {
                Ok(tokens) => tokens.access_token,
                Err(AccountError::InvalidGrant) => return true,
                Err(_) => return false,
            },
        };
        // Local deletion is already complete. This credential is used only for this revoke,
        // then dropped, and its rotated refresh token is never persisted or retried.
        self.http
            .post(self.endpoints.api("/desktop-auth/revoke"))
            .bearer_auth(access)
            .send()
            .await
            .is_ok_and(|response| response.status().as_u16() == 204)
    }

    async fn execute(&mut self, action: Action) -> Result<Reply, AccountError> {
        if !self.endpoints.available {
            return Err(AccountError::Unavailable);
        }
        self.load().await?;
        match action {
            Action::Status => self.status().await.map(Reply::Status),
            Action::Connect(opener) => self.connect(opener).await.map(Reply::Status),
            Action::Disconnect => self.disconnect().await.map(Reply::Disconnect),
        }
    }
}

pub(crate) fn initialize(app: &tauri::AppHandle) -> Result<AccountOwner, AccountError> {
    let endpoints = Endpoints::new(&app.config().identifier, DEV_API_ORIGIN, DEV_WEB_ORIGIN)?;
    let credentials = Arc::new(ChessRiddleCredentials::new(&app.config().identifier));
    let worker_credentials = credentials.clone();
    let handle = app.clone();
    tauri::async_runtime::block_on(BLOCKING_GATEWAY.spawn_cancellable(
        CancellationToken::new(),
        move |_| {
            let data = AppDataDir::for_app(&handle)?;
            worker_credentials.initialize(&data)
        },
    ))
    .map_err(|_| AccountError::Storage)?;
    Ok(AccountOwner::start(credentials, endpoints, http_client()?))
}

fn owner(state: &crate::AppState) -> Result<&AccountOwner, AccountError> {
    state.chessriddle.get().ok_or(AccountError::Unavailable)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn chessriddle_account(
    state: tauri::State<'_, crate::AppState>,
) -> Result<AccountStatus, AccountError> {
    match owner(&state)?.request(Action::Status).await? {
        Reply::Status(status) => Ok(status),
        _ => Err(AccountError::Server),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn connect_chessriddle(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<AccountStatus, AccountError> {
    let opener = Arc::new(move |url: &str| {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|_| "ChessRiddle browser failed".into())
    });
    match owner(&state)?.request(Action::Connect(opener)).await? {
        Reply::Status(status) => Ok(status),
        _ => Err(AccountError::Server),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn disconnect_chessriddle(
    state: tauri::State<'_, crate::AppState>,
) -> Result<DisconnectOutcome, AccountError> {
    match owner(&state)?.request(Action::Disconnect).await? {
        Reply::Disconnect(outcome) => Ok(outcome),
        _ => Err(AccountError::Server),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{CredentialStore, MemoryCredentialStore};
    use axum::{
        extract::{Form, State},
        http::{HeaderMap, StatusCode},
        response::{IntoResponse, Response},
        routing::{get, post},
        Json, Router,
    };
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering},
            Mutex,
        },
    };

    #[derive(Default)]
    struct TestStore {
        inner: MemoryCredentialStore,
        writes: AtomicUsize,
        fail_next: AtomicBool,
        gate: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
        entered: tokio::sync::Notify,
    }

    impl CredentialStore for TestStore {
        fn set(&self, key: &str, secret: &str) -> Result<(), Error> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            let gate = self.gate.lock().unwrap().take();
            if let Some(gate) = gate {
                self.entered.notify_one();
                gate.recv_timeout(Duration::from_secs(10)).unwrap();
            }
            if self.fail_next.swap(false, Ordering::SeqCst) {
                return Err(Error::CredentialRecoveryRequired);
            }
            self.inner.set(key, secret)
        }
        fn get(&self, key: &str) -> Result<Option<String>, Error> {
            self.inner.get(key)
        }
        fn delete(&self, key: &str) -> Result<(), Error> {
            self.inner.delete(key)
        }
    }

    async fn credentials(
        store: Arc<TestStore>,
        uncertain: bool,
    ) -> (tempfile::TempDir, Arc<ChessRiddleCredentials>) {
        let temp = tempfile::tempdir().unwrap();
        let credentials = Arc::new(if uncertain {
            ChessRiddleCredentials::with_uncertain_store(store)
        } else {
            ChessRiddleCredentials::with_store(store)
        });
        let manager = credentials.clone();
        let path = temp.path().to_owned();
        BLOCKING_GATEWAY
            .spawn_cancellable(CancellationToken::new(), move |_| {
                manager.initialize(&AppDataDir::for_test(&path))
            })
            .await
            .unwrap();
        (temp, credentials)
    }

    struct ServerState {
        token_status: AtomicU16,
        profile_status: AtomicU16,
        revoke_status: AtomicU16,
        refresh_after_removal: AtomicBool,
        token_network_failure: AtomicBool,
        revoke_network_failure: AtomicBool,
        malformed_token: AtomicBool,
        refreshes: AtomicUsize,
        profiles: AtomicUsize,
        revokes: AtomicUsize,
        forms: Mutex<Vec<HashMap<String, String>>>,
        credentials: Arc<ChessRiddleCredentials>,
    }

    fn attribution(headers: &HeaderMap) {
        assert_eq!(headers.get("X-Client-Surface").unwrap(), "desktop");
        assert_eq!(
            headers.get("X-Client-Platform").unwrap(),
            platform().unwrap()
        );
    }

    async fn token(
        State(state): State<Arc<ServerState>>,
        headers: HeaderMap,
        Form(form): Form<HashMap<String, String>>,
    ) -> Response {
        attribution(&headers);
        if state.refresh_after_removal.load(Ordering::SeqCst) {
            assert!(
                state.credentials.list().await.unwrap().is_empty(),
                "disconnect refresh must follow local removal"
            );
        }
        state.forms.lock().unwrap().push(form);
        let generation = state.refreshes.fetch_add(1, Ordering::SeqCst) + 1;
        if state.token_network_failure.load(Ordering::SeqCst) {
            return broken_response();
        }
        let status = state.token_status.load(Ordering::SeqCst);
        let body = if state.malformed_token.load(Ordering::SeqCst) {
            serde_json::json!({"access_token": "invalid-response"})
        } else if status == 200 {
            serde_json::json!({"access_token": format!("access-{generation}"), "refresh_token": format!("refresh-{generation}"), "expires_in": 3600, "token_type": "Bearer"})
        } else {
            serde_json::json!({"error": "invalid_grant", "error_description": "must-never-leak"})
        };
        (StatusCode::from_u16(status).unwrap(), Json(body)).into_response()
    }

    async fn profile(
        State(state): State<Arc<ServerState>>,
        headers: HeaderMap,
    ) -> (StatusCode, Json<serde_json::Value>) {
        attribution(&headers);
        assert!(headers
            .get("Authorization")
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("Bearer access-"));
        state.profiles.fetch_add(1, Ordering::SeqCst);
        (
            StatusCode::from_u16(state.profile_status.load(Ordering::SeqCst)).unwrap(),
            Json(serde_json::json!({"username":"Player", "permissions":{"tier":"gold"}})),
        )
    }

    fn broken_response() -> Response {
        axum::body::StreamBody::new(futures_util::stream::once(async {
            Err::<bytes::Bytes, std::io::Error>(std::io::Error::other("fixture transport failure"))
        }))
        .into_response()
    }

    async fn revoke(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
        attribution(&headers);
        assert!(
            state.credentials.list().await.unwrap().is_empty(),
            "revoke must follow local removal"
        );
        state.revokes.fetch_add(1, Ordering::SeqCst);
        assert!(headers
            .get("Authorization")
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("Bearer access-"));
        if state.revoke_network_failure.load(Ordering::SeqCst) {
            return broken_response();
        }
        StatusCode::from_u16(state.revoke_status.load(Ordering::SeqCst))
            .unwrap()
            .into_response()
    }

    struct Fixture {
        endpoints: Endpoints,
        state: Arc<ServerState>,
        shutdown: Option<oneshot::Sender<()>>,
        task: Option<tokio::task::JoinHandle<()>>,
    }

    impl Fixture {
        fn new(credentials: Arc<ChessRiddleCredentials>) -> Self {
            let state = Arc::new(ServerState {
                token_status: AtomicU16::new(200),
                profile_status: AtomicU16::new(200),
                revoke_status: AtomicU16::new(204),
                refresh_after_removal: AtomicBool::new(false),
                token_network_failure: AtomicBool::new(false),
                revoke_network_failure: AtomicBool::new(false),
                malformed_token: AtomicBool::new(false),
                refreshes: AtomicUsize::new(0),
                profiles: AtomicUsize::new(0),
                revokes: AtomicUsize::new(0),
                forms: Mutex::new(Vec::new()),
                credentials,
            });
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let router = Router::new()
                .route("/api/v1/desktop-auth/token", post(token))
                .route("/api/v1/users/me", get(profile))
                .route("/api/v1/desktop-auth/revoke", post(revoke))
                .with_state(state.clone());
            let (shutdown, stopped) = oneshot::channel();
            let task = tokio::spawn(async move {
                axum::Server::from_tcp(listener)
                    .unwrap()
                    .serve(router.into_make_service())
                    .with_graceful_shutdown(async {
                        let _ = stopped.await;
                    })
                    .await
                    .unwrap();
            });
            Self {
                endpoints: Endpoints::new(
                    "com.chessriddle.studio.dev",
                    Some(&origin),
                    Some(&origin),
                )
                .unwrap(),
                state,
                shutdown: Some(shutdown),
                task: Some(task),
            }
        }

        fn owner(&self) -> AccountOwner {
            AccountOwner::start(
                self.state.credentials.clone(),
                self.endpoints.clone(),
                http_client().unwrap(),
            )
        }

        async fn stop(mut self) {
            if let Some(shutdown) = self.shutdown.take() {
                let _ = shutdown.send(());
            }
            if let Some(task) = self.task.take() {
                task.await.unwrap();
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Some(task) = self.task.take() {
                task.abort();
            }
        }
    }

    fn connected(reply: Reply) -> AccountProfile {
        match reply {
            Reply::Status(AccountStatus::Connected { account, .. }) => account,
            _ => panic!("expected connected"),
        }
    }

    #[test]
    fn release_availability_and_loopback_override_are_identifier_bound() {
        let release = Endpoints::new(
            "com.chessriddle.studio",
            Some("http://127.0.0.1:8000"),
            Some("http://127.0.0.1:9000"),
        )
        .unwrap();
        assert!(!release.available);
        assert_eq!(release.origin, API_ORIGIN);
        assert_eq!(release.web_origin, API_ORIGIN);
        assert!(!release.dev_web_override);
        assert!(
            Endpoints::new("com.chessriddle.studio.dev", None, None)
                .unwrap()
                .available
        );
        for bad in [
            "http://localhost:8000",
            "http://127.0.0.2:8000",
            "http://127.0.0.1",
            "http://127.1:8000",
            "http://2130706433:8000",
            "http://127.0.0.1:0",
            "https://127.0.0.1:8000",
            "http://127.0.0.1:8000/path",
            "http://user@127.0.0.1:8000",
            "http://127.0.0.1:8000/?secret=1",
            "http://127.0.0.1:8000/#fragment",
        ] {
            assert!(
                Endpoints::new("com.chessriddle.studio.dev", Some(bad), None).is_err(),
                "{bad}"
            );
            assert!(
                Endpoints::new("com.chessriddle.studio.dev", None, Some(bad)).is_err(),
                "{bad}"
            );
        }
        assert_eq!(FEEDBACK_URL, "https://chessriddle.com/api/v1/feedback");
    }

    #[test]
    fn cr6_opens_https_on_both_exact_hosts_and_never_calls_opener_for_other_links() {
        let endpoints = Endpoints::new("app", None, None).unwrap();
        let calls = AtomicUsize::new(0);
        let opener = |_: &str| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        };
        for good in [
            "https://chessriddle.com/auth/connect?state=public",
            "https://www.chessriddle.com/account",
        ] {
            endpoints.open_link(good, &opener).unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        for bad in [
            "http://chessriddle.com",
            "https://evilchessriddle.com",
            "https://chessriddle.com.evil.test",
            "https://chessriddle.com@evil.test",
            "https://chessriddle.com./",
            "https://127.0.0.1:8000",
            "javascript:alert(1)",
            "file:///tmp/a",
            "https://user@chessriddle.com/",
            "https://chessriddle.com:8443/",
            "https://www.chessriddle.com:8443/",
            "https://chessriddle.com:443/",
            "https://www.chessriddle.com:443/",
        ] {
            assert_eq!(
                endpoints.open_link(bad, &opener),
                Err(AccountError::InvalidLink)
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn web_override_only_allows_its_exact_origin_under_the_dev_identifier() {
        let calls = AtomicUsize::new(0);
        let opener = |_: &str| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        };
        let web = "http://127.0.0.1:9000";
        for endpoints in [
            Endpoints::new("app", None, Some(web)).unwrap(),
            Endpoints::new("app.dev", Some("http://127.0.0.1:9000"), None).unwrap(),
            Endpoints::new("app.dev", None, None).unwrap(),
        ] {
            assert_eq!(endpoints.web_origin, API_ORIGIN);
            assert_eq!(
                endpoints.open_link("http://127.0.0.1:9000/auth/connect", &opener),
                Err(AccountError::InvalidLink)
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let endpoints =
            Endpoints::new("app.dev", Some("http://127.0.0.1:8000"), Some(web)).unwrap();
        assert_eq!(endpoints.origin, "http://127.0.0.1:8000");
        assert_eq!(endpoints.web_origin, web);
        endpoints
            .open_link("http://127.0.0.1:9000/auth/connect?state=public", &opener)
            .unwrap();
        for denied in [
            "http://127.0.0.1:9001/auth/connect",
            "http://127.0.0.1:8000/auth/connect",
            "http://localhost:9000/auth/connect",
            "http://user@127.0.0.1:9000/auth/connect",
            "https://127.0.0.1:9000/auth/connect",
        ] {
            assert_eq!(
                endpoints.open_link(denied, &opener),
                Err(AccountError::InvalidLink)
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // Release ignores invalid overrides rather than widening or refusing its production policy.
        assert_eq!(
            Endpoints::new("app", Some("https://evil.test"), Some("https://evil.test"))
                .unwrap()
                .web_origin,
            API_ORIGIN
        );
    }

    #[tokio::test]
    async fn concurrent_callers_cannot_use_rotated_access_before_keyring_persistence_completes() {
        let store = Arc::new(TestStore::default());
        let (_temp, credentials) = credentials(store.clone(), false).await;
        credentials
            .store("user".into(), "initial-refresh".into())
            .await
            .unwrap();
        let fixture = Fixture::new(credentials);
        let (release, waiting) = std::sync::mpsc::channel();
        *store.gate.lock().unwrap() = Some(waiting);
        let owner = Arc::new(fixture.owner());
        let first_owner = owner.clone();
        let first = tokio::spawn(async move { first_owner.request(Action::Status).await });
        tokio::time::timeout(Duration::from_secs(5), store.entered.notified())
            .await
            .unwrap();
        let second_owner = owner.clone();
        let second = tokio::spawn(async move { second_owner.request(Action::Status).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!first.is_finished());
        assert!(!second.is_finished());
        assert_eq!(fixture.state.profiles.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.state.refreshes.load(Ordering::SeqCst), 1);
        release.send(()).unwrap();
        let first = connected(first.await.unwrap().unwrap());
        let second = connected(second.await.unwrap().unwrap());
        assert_eq!(first, second);
        assert_eq!(fixture.state.profiles.load(Ordering::SeqCst), 2);
        assert_eq!(fixture.state.refreshes.load(Ordering::SeqCst), 1);
        fixture.stop().await;
    }

    #[tokio::test]
    async fn failed_keyring_write_retains_rotated_tokens_and_retry_uses_them_without_refreshing_again(
    ) {
        let store = Arc::new(TestStore::default());
        let (_temp, credentials) = credentials(store.clone(), false).await;
        let (account, _) = credentials
            .store("user".into(), "initial-refresh".into())
            .await
            .unwrap();
        let fixture = Fixture::new(credentials.clone());
        let owner = fixture.owner();
        store.fail_next.store(true, Ordering::SeqCst);
        assert!(matches!(
            owner.request(Action::Status).await,
            Err(AccountError::Storage)
        ));
        assert_eq!(
            credentials
                .token(account.handle.clone())
                .await
                .unwrap()
                .as_deref(),
            Some("initial-refresh")
        );
        assert_eq!(fixture.state.profiles.load(Ordering::SeqCst), 0);
        assert_eq!(
            connected(owner.request(Action::Status).await.unwrap()).handle,
            account.handle
        );
        assert_eq!(
            credentials.token(account.handle).await.unwrap().as_deref(),
            Some("refresh-1")
        );
        assert_eq!(fixture.state.refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.state.profiles.load(Ordering::SeqCst), 1);
        fixture.stop().await;
    }

    #[tokio::test]
    async fn only_invalid_grant_clears_credentials_while_429_and_5xx_keep_them() {
        for (status, expected) in [
            (429, AccountError::RateLimited),
            (500, AccountError::Server),
            (503, AccountError::Server),
        ] {
            let (_temp, credentials) = credentials(Arc::new(TestStore::default()), false).await;
            let (account, _) = credentials
                .store("user".into(), "initial-refresh".into())
                .await
                .unwrap();
            let fixture = Fixture::new(credentials.clone());
            fixture.state.token_status.store(status, Ordering::SeqCst);
            let owner = fixture.owner();
            assert!(matches!(owner.request(Action::Status).await, Err(error) if error == expected));
            assert_eq!(
                credentials.token(account.handle).await.unwrap().as_deref(),
                Some("initial-refresh")
            );
            fixture.state.token_status.store(400, Ordering::SeqCst);
            assert!(matches!(
                owner.request(Action::Status).await.unwrap(),
                Reply::Status(AccountStatus::ReconnectNeeded)
            ));
            assert!(credentials.list().await.unwrap().is_empty());
            fixture.stop().await;
        }
    }

    #[tokio::test]
    async fn network_failure_keeps_the_credential_and_returns_a_closed_error() {
        let (_temp, credentials) = credentials(Arc::new(TestStore::default()), false).await;
        let (account, _) = credentials
            .store("user".into(), "initial-refresh".into())
            .await
            .unwrap();
        let owner = AccountOwner::start(
            credentials.clone(),
            Endpoints::new("app.dev", Some("http://127.0.0.1:1"), None).unwrap(),
            http_client().unwrap(),
        );
        assert!(matches!(
            owner.request(Action::Status).await,
            Err(AccountError::Network)
        ));
        assert_eq!(
            credentials.token(account.handle).await.unwrap().as_deref(),
            Some("initial-refresh")
        );
        assert_eq!(
            serde_json::to_string(&AccountError::Network).unwrap(),
            "\"network\""
        );
    }

    #[tokio::test]
    async fn website_revoke_is_confirmed_by_invalid_grant_before_clearing_the_credential() {
        let (_temp, credentials) = credentials(Arc::new(TestStore::default()), false).await;
        credentials
            .store("user".into(), "initial-refresh".into())
            .await
            .unwrap();
        let fixture = Fixture::new(credentials.clone());
        let owner = fixture.owner();
        connected(owner.request(Action::Status).await.unwrap());
        fixture.state.profile_status.store(401, Ordering::SeqCst);
        fixture.state.token_status.store(400, Ordering::SeqCst);
        assert!(matches!(
            owner.request(Action::Status).await.unwrap(),
            Reply::Status(AccountStatus::ReconnectNeeded)
        ));
        assert!(credentials.list().await.unwrap().is_empty());
        fixture.stop().await;
    }

    #[tokio::test]
    async fn disconnect_after_restart_refreshes_after_local_removal_once_without_persistence_for_every_outcome(
    ) {
        for (
            token_status,
            revoke_status,
            broken_token,
            broken_revoke,
            malformed,
            pending,
            revokes,
        ) in [
            (200, 204, false, false, false, false, 1),
            (400, 204, false, false, false, false, 0),
            (401, 204, false, false, false, true, 0),
            (429, 204, false, false, false, true, 0),
            (500, 204, false, false, false, true, 0),
            (503, 204, false, false, false, true, 0),
            (200, 500, false, false, false, true, 1),
            (200, 429, false, false, false, true, 1),
            (200, 401, false, false, false, true, 1),
            (200, 204, true, false, false, true, 0),
            (200, 204, false, true, false, true, 1),
            (200, 204, false, false, true, true, 0),
        ] {
            let store = Arc::new(TestStore::default());
            let (_temp, credentials) = credentials(store.clone(), false).await;
            let (account, _) = credentials
                .store("user".into(), "initial-refresh".into())
                .await
                .unwrap();
            let writes = store.writes.load(Ordering::SeqCst);
            store.fail_next.store(true, Ordering::SeqCst);
            let fixture = Fixture::new(credentials.clone());
            fixture
                .state
                .refresh_after_removal
                .store(true, Ordering::SeqCst);
            fixture
                .state
                .token_status
                .store(token_status, Ordering::SeqCst);
            fixture
                .state
                .revoke_status
                .store(revoke_status, Ordering::SeqCst);
            fixture
                .state
                .token_network_failure
                .store(broken_token, Ordering::SeqCst);
            fixture
                .state
                .revoke_network_failure
                .store(broken_revoke, Ordering::SeqCst);
            fixture
                .state
                .malformed_token
                .store(malformed, Ordering::SeqCst);
            let owner = fixture.owner();
            assert!(
                matches!(owner.request(Action::Disconnect).await.unwrap(), Reply::Disconnect(DisconnectOutcome::Removed { revocation_pending, durability_uncertain: false }) if revocation_pending == pending)
            );
            assert!(credentials.list().await.unwrap().is_empty());
            assert!(store
                .inner
                .get(&format!("chessriddle-account:{}", account.handle.0))
                .unwrap()
                .is_none());
            assert_eq!(
                store.writes.load(Ordering::SeqCst),
                writes,
                "disconnect must never persist a rotation"
            );
            assert!(matches!(
                owner.request(Action::Status).await.unwrap(),
                Reply::Status(AccountStatus::Disconnected)
            ));
            assert!(matches!(
                owner.request(Action::Disconnect).await.unwrap(),
                Reply::Disconnect(DisconnectOutcome::NotFound)
            ));
            assert_eq!(fixture.state.refreshes.load(Ordering::SeqCst), 1);
            assert_eq!(fixture.state.revokes.load(Ordering::SeqCst), revokes);
            assert_eq!(fixture.state.profiles.load(Ordering::SeqCst), 0);
            let forms = fixture.state.forms.lock().unwrap().clone();
            assert_eq!(forms.len(), 1);
            assert_eq!(forms[0]["grant_type"], "refresh_token");
            assert_eq!(forms[0]["refresh_token"], "initial-refresh");
            fixture.stop().await;
        }
    }

    #[tokio::test]
    async fn disconnect_with_expired_access_refreshes_once_and_preserves_durability_uncertainty() {
        let store = Arc::new(TestStore::default());
        let (_temp, credentials) = credentials(store.clone(), true).await;
        credentials
            .store("user".into(), "initial-refresh".into())
            .await
            .unwrap();
        let fixture = Fixture::new(credentials.clone());
        let mut worker = Worker {
            credentials: credentials.clone(),
            endpoints: fixture.endpoints.clone(),
            http: http_client().unwrap(),
            attempts: Arc::new(AttemptRegistry::default()),
            session: None,
            loaded: false,
            reconnect_needed: false,
        };
        worker.load().await.unwrap();
        assert!(matches!(
            worker.status().await.unwrap(),
            AccountStatus::Connected { .. }
        ));
        let session = worker.session.as_mut().unwrap();
        session.access.as_mut().unwrap().1 = Instant::now() - Duration::from_secs(1);
        let writes = store.writes.load(Ordering::SeqCst);
        fixture
            .state
            .refresh_after_removal
            .store(true, Ordering::SeqCst);
        assert_eq!(
            worker.disconnect().await.unwrap(),
            DisconnectOutcome::Removed {
                revocation_pending: false,
                durability_uncertain: true
            }
        );
        assert!(worker.session.is_none());
        assert!(credentials.list().await.unwrap().is_empty());
        assert_eq!(store.writes.load(Ordering::SeqCst), writes);
        assert_eq!(fixture.state.refreshes.load(Ordering::SeqCst), 2);
        assert_eq!(fixture.state.revokes.load(Ordering::SeqCst), 1);
        let forms = fixture.state.forms.lock().unwrap().clone();
        assert_eq!(forms[1]["refresh_token"], "refresh-1");
        fixture.stop().await;
    }

    #[tokio::test]
    async fn disconnect_reports_each_independent_flag_including_both_together_without_background_retry(
    ) {
        for uncertain in [false, true] {
            for failure in [false, true] {
                let (_temp, credentials) =
                    credentials(Arc::new(TestStore::default()), uncertain).await;
                credentials
                    .store("user".into(), "initial-refresh".into())
                    .await
                    .unwrap();
                let fixture = Fixture::new(credentials.clone());
                let owner = fixture.owner();
                connected(owner.request(Action::Status).await.unwrap());
                if failure {
                    fixture.state.revoke_status.store(500, Ordering::SeqCst);
                }
                assert!(
                    matches!(owner.request(Action::Disconnect).await.unwrap(), Reply::Disconnect(DisconnectOutcome::Removed { revocation_pending, durability_uncertain }) if revocation_pending == failure && durability_uncertain == uncertain)
                );
                assert!(credentials.list().await.unwrap().is_empty());
                assert!(matches!(
                    owner.request(Action::Status).await.unwrap(),
                    Reply::Status(AccountStatus::Disconnected)
                ));
                assert!(matches!(
                    owner.request(Action::Disconnect).await.unwrap(),
                    Reply::Disconnect(DisconnectOutcome::NotFound)
                ));
                assert_eq!(fixture.state.revokes.load(Ordering::SeqCst), 1);
                assert_eq!(fixture.state.refreshes.load(Ordering::SeqCst), 1);
                fixture.stop().await;
            }
        }
    }

    #[tokio::test]
    async fn restart_loads_only_the_refresh_token_and_rotates_using_the_same_handle() {
        let store = Arc::new(TestStore::default());
        let (temp, credentials) = credentials(store.clone(), false).await;
        credentials
            .store("user".into(), "initial-refresh".into())
            .await
            .unwrap();
        let fixture = Fixture::new(credentials);
        let owner = fixture.owner();
        let before = connected(owner.request(Action::Status).await.unwrap());
        drop(owner);
        let restarted = Arc::new(ChessRiddleCredentials::with_store(store));
        let manager = restarted.clone();
        let path = temp.path().to_owned();
        BLOCKING_GATEWAY
            .spawn_cancellable(CancellationToken::new(), move |_| {
                manager.initialize(&AppDataDir::for_test(&path))
            })
            .await
            .unwrap();
        let owner =
            AccountOwner::start(restarted, fixture.endpoints.clone(), http_client().unwrap());
        let after = connected(owner.request(Action::Status).await.unwrap());
        assert_eq!(before, after);
        let forms = fixture.state.forms.lock().unwrap().clone();
        assert_eq!(forms[0]["refresh_token"], "initial-refresh");
        assert_eq!(forms[1]["refresh_token"], "refresh-1");
        fixture.stop().await;
    }

    #[tokio::test]
    async fn chessriddle_attempt_binds_consent_callback_pkce_and_its_own_token_endpoint() {
        let (_temp, credentials) = credentials(Arc::new(TestStore::default()), false).await;
        let mut fixture = Fixture::new(credentials);
        let origin = fixture.endpoints.origin.clone();
        fixture.endpoints =
            Endpoints::new("app.dev", Some(&origin), Some("http://127.0.0.1:9000")).unwrap();
        let owner = fixture.owner();
        let (opened, mut browser) = mpsc::unbounded_channel::<String>();
        let opener: BrowserOpener =
            Arc::new(move |url| opened.send(url.into()).map_err(|_| "closed".into()));
        let flow = owner.request(Action::Connect(opener));
        let callback = async {
            let opened = browser.recv().await.unwrap();
            assert!(fixture.endpoints.allowed_link(&opened));
            assert!(opened.starts_with(&format!("{}/auth/connect?", fixture.endpoints.web_origin)));
            let url = url::Url::parse(&opened).unwrap();
            assert_eq!(url.path(), "/auth/connect");
            let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
            assert_eq!(query["client_id"], "chessriddle-studio");
            assert_eq!(query["code_challenge_method"], "S256");
            let response = reqwest::Client::new()
                .get(&query["redirect_uri"])
                .query(&[
                    ("state", query["state"].as_str()),
                    ("code", "chessriddle-code"),
                ])
                .send()
                .await
                .unwrap();
            assert!(response.status().is_success());
            query
        };
        let (result, query) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(flow, callback)
        })
        .await
        .unwrap();
        assert_eq!(
            connected(result.unwrap()).username.as_deref(),
            Some("Player")
        );
        let forms = fixture.state.forms.lock().unwrap().clone();
        assert_eq!(forms.len(), 1);
        assert_eq!(forms[0]["grant_type"], "authorization_code");
        assert_eq!(forms[0]["code"], "chessriddle-code");
        assert_eq!(forms[0]["redirect_uri"], query["redirect_uri"]);
        let verifier = oauth2::PkceCodeVerifier::new(forms[0]["code_verifier"].clone());
        assert_eq!(
            oauth2::PkceCodeChallenge::from_code_verifier_sha256(&verifier).as_str(),
            query["code_challenge"]
        );
        fixture.stop().await;
    }

    #[tokio::test]
    async fn release_commands_refuse_before_touching_the_keyring_or_opener() {
        let (_temp, credentials) = credentials(Arc::new(TestStore::default()), false).await;
        let owner = AccountOwner::start(
            credentials,
            Endpoints::new("app", None, None).unwrap(),
            http_client().unwrap(),
        );
        assert!(matches!(
            owner
                .request(Action::Connect(Arc::new(|_| panic!("release opener"))))
                .await,
            Err(AccountError::Unavailable)
        ));
    }
}
