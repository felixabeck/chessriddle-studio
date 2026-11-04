use axum::{
    extract::Query,
    response::{Html, IntoResponse},
    routing::get,
    Extension, Router,
};
use log::{error, info, warn};
use oauth2::{
    basic::BasicClient, AuthUrl, AuthorizationCode, ClientId, CsrfToken, HttpRequest, HttpResponse,
    PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope, TokenResponse, TokenUrl,
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    net::TcpListener,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri_plugin_opener::OpenerExt;
use tokio::{
    sync::{oneshot, Mutex},
    task::JoinHandle,
};

use crate::{
    credentials::{LichessAccountHandle, LichessAccountMetadata, LichessAccountStoreResult},
    error::Error,
    AppState,
};
use dashmap::DashMap;
use serde::Serialize;
use specta::Type;

const OAUTH_FAILURE: &str = "OAuth authentication failed";
const LISTENER_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const JOB_TTL: Duration = Duration::from_secs(15 * 60);
const LICHESS_ACCOUNT_URL: &str = "https://lichess.org/api/account";
const LICHESS_TOKEN_URL: &str = "https://lichess.org/api/token";
const LICHESS_TOKEN_TEST_URL: &str = "https://lichess.org/api/token/test";
const REVOCATION_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_TOKEN_TEST_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_VERIFY_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_OAUTH_RESPONSE_BYTES: usize = 64 * 1024;

async fn safe_oauth_http_client(
    client: &reqwest::Client,
    request: HttpRequest,
) -> Result<HttpResponse, oauth2::reqwest::Error<reqwest::Error>> {
    let method = reqwest::Method::from_bytes(request.method.as_str().as_bytes())
        .map_err(|error| oauth2::reqwest::Error::Other(error.to_string()))?;
    let mut builder = client
        .request(method, request.url.as_str())
        .body(request.body);
    for (name, value) in &request.headers {
        builder = builder.header(name.as_str(), value.as_bytes());
    }
    let response = client
        .execute(builder.build().map_err(oauth2::reqwest::Error::Reqwest)?)
        .await
        .map_err(oauth2::reqwest::Error::Reqwest)?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_OAUTH_RESPONSE_BYTES as u64)
    {
        return Err(oauth2::reqwest::Error::Other(
            "OAuth response exceeded the native limit".into(),
        ));
    }
    let status = response.status();
    let headers = response.headers().clone();
    let body = response
        .bytes()
        .await
        .map_err(oauth2::reqwest::Error::Reqwest)?;
    oauth_response_from_reqwest(status, &headers, body)
}

fn oauth_response_from_reqwest(
    status: reqwest::StatusCode,
    response_headers: &reqwest::header::HeaderMap,
    body: bytes::Bytes,
) -> Result<HttpResponse, oauth2::reqwest::Error<reqwest::Error>> {
    if body.len() > MAX_OAUTH_RESPONSE_BYTES {
        return Err(oauth2::reqwest::Error::Other(
            "OAuth response exceeded the native limit".into(),
        ));
    }
    let status_code = axum::http::StatusCode::from_u16(status.as_u16())
        .map_err(|error| oauth2::reqwest::Error::Other(error.to_string()))?;
    let mut headers = axum::http::HeaderMap::new();
    for (name, value) in response_headers {
        let name = axum::http::header::HeaderName::from_bytes(name.as_str().as_bytes())
            .map_err(|error| oauth2::reqwest::Error::Other(error.to_string()))?;
        let value = axum::http::header::HeaderValue::from_bytes(value.as_bytes())
            .map_err(|error| oauth2::reqwest::Error::Other(error.to_string()))?;
        headers.insert(name, value);
    }
    Ok(HttpResponse {
        status_code,
        headers,
        body: body.to_vec(),
    })
}

pub struct AuthLifecycle {
    active: Mutex<HashMap<u64, AuthTransaction>>,
    next_generation: AtomicU64,
    jobs: DashMap<String, (AuthenticationStatus, tokio::time::Instant)>,
}

impl Default for AuthLifecycle {
    fn default() -> Self {
        Self {
            active: Mutex::new(HashMap::new()),
            next_generation: AtomicU64::new(0),
            jobs: DashMap::new(),
        }
    }
}

struct AuthTransaction {
    csrf_token: CsrfToken,
    callback_tx: Option<oneshot::Sender<CallbackSignal>>,
}

enum CallbackSignal {
    Code(AuthorizationCode),
    Rejected,
}

#[derive(Debug, PartialEq, Eq)]
enum CallbackResult {
    AcceptedCode,
    AcceptedRejection,
    Mismatch,
    Missing,
    Closed,
}

impl AuthLifecycle {
    async fn begin(
        &self,
        csrf_token: CsrfToken,
    ) -> Result<(u64, oneshot::Receiver<CallbackSignal>), Error> {
        let mut active = self.active.lock().await;
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let (callback_tx, callback_rx) = oneshot::channel();
        active.insert(
            generation,
            AuthTransaction {
                csrf_token,
                callback_tx: Some(callback_tx),
            },
        );
        Ok((generation, callback_rx))
    }

    async fn clear_generation(&self, generation: u64) {
        let mut active = self.active.lock().await;
        active.remove(&generation);
    }

    async fn accept_callback(&self, query: CallbackQuery) -> CallbackResult {
        let (callback_tx, signal) = {
            let mut active = self.active.lock().await;
            let Some(state) = query.state.as_ref() else {
                return CallbackResult::Mismatch;
            };
            let Some(transaction) = active
                .values_mut()
                .find(|attempt| state.secret() == attempt.csrf_token.secret())
            else {
                return if active.is_empty() {
                    CallbackResult::Missing
                } else {
                    CallbackResult::Mismatch
                };
            };
            let Some(callback_tx) = transaction.callback_tx.take() else {
                return CallbackResult::Closed;
            };
            if query.error.is_some() {
                warn!("OAuth provider callback rejected authentication");
            }
            let signal = match query.code {
                Some(code) if query.error.is_none() => CallbackSignal::Code(code),
                _ => CallbackSignal::Rejected,
            };
            (callback_tx, signal)
        };

        let accepted_result = match &signal {
            CallbackSignal::Code(_) => CallbackResult::AcceptedCode,
            CallbackSignal::Rejected => CallbackResult::AcceptedRejection,
        };
        match callback_tx.send(signal) {
            Ok(()) => accepted_result,
            Err(_) => CallbackResult::Closed,
        }
    }

    #[cfg(test)]
    async fn active_state(&self) -> Option<CsrfToken> {
        self.active
            .lock()
            .await
            .values()
            .next()
            .map(|attempt| attempt.csrf_token.clone())
    }

    #[cfg(test)]
    async fn is_idle(&self) -> bool {
        self.active.lock().await.is_empty()
    }

    fn create_job(&self) -> AuthenticationJob {
        let now = tokio::time::Instant::now();
        self.jobs
            .retain(|_, (_, created)| now.duration_since(*created) < JOB_TTL);
        let job = AuthenticationJob {
            id: uuid::Uuid::new_v4().to_string(),
        };
        self.jobs
            .insert(job.id.clone(), (AuthenticationStatus::Pending, now));
        job
    }
    fn complete_job(&self, id: &str, status: AuthenticationStatus) {
        self.jobs
            .insert(id.into(), (status, tokio::time::Instant::now()));
    }
    fn job(&self, id: &str) -> Option<AuthenticationStatus> {
        let status = self.jobs.get(id).and_then(|status| {
            (tokio::time::Instant::now().duration_since(status.1) < JOB_TTL)
                .then(|| status.0.clone())
        });
        if status.is_none() {
            self.jobs.remove(id);
        }
        status
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct AuthenticationJob {
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum AuthenticationStatus {
    Pending,
    Succeeded {
        account: LichessAccountMetadata,
        #[serde(default)]
        durability_uncertain: bool,
    },
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum LichessAccountRemoval {
    NotFound,
    Removed {
        revocation_pending: bool,
        revocation_outcome: Option<LichessRevocationOutcome>,
        durability_uncertain: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LichessRevocationOutcome {
    Revoked,
    AlreadyInvalid,
    Unreachable,
    RateLimited,
    Rejected,
}

impl LichessRevocationOutcome {
    fn is_pending(self) -> bool {
        !matches!(self, Self::Revoked | Self::AlreadyInvalid)
    }
}

pub struct ListenerHandle {
    redirect_url: String,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: JoinHandle<Result<(), String>>,
    task_completed: bool,
}

pub trait OAuthServices: Send + Sync + 'static {
    async fn exchange_code(
        &self,
        client: &BasicClient,
        code: AuthorizationCode,
        verifier: PkceCodeVerifier,
    ) -> Result<String, Error>;

    async fn verify_identity(&self, access_token: &str) -> Result<String, Error>;

    async fn revoke_token(&self, access_token: &str) -> LichessRevocationOutcome;

    fn start_listener_and_server(
        &self,
        lifecycle: Arc<AuthLifecycle>,
    ) -> Result<ListenerHandle, Error>;
}

pub struct ProdOAuthServices {
    http_client: Arc<reqwest::Client>,
    token_url: String,
    token_test_url: String,
}

impl ProdOAuthServices {
    pub(crate) fn new(http_client: Arc<reqwest::Client>) -> Self {
        Self {
            http_client,
            token_url: LICHESS_TOKEN_URL.into(),
            token_test_url: LICHESS_TOKEN_TEST_URL.into(),
        }
    }

    #[cfg(test)]
    fn with_token_urls(
        http_client: Arc<reqwest::Client>,
        token_url: String,
        token_test_url: String,
    ) -> Self {
        Self {
            http_client,
            token_url,
            token_test_url,
        }
    }

    #[cfg(test)]
    pub(crate) fn shares_http_client(&self, client: &Arc<reqwest::Client>) -> bool {
        Arc::ptr_eq(&self.http_client, client)
    }

    async fn revoke_token_before(
        &self,
        access_token: &str,
        deadline: tokio::time::Instant,
        #[cfg(test)] retained_body_bytes: Option<&std::sync::atomic::AtomicUsize>,
    ) -> LichessRevocationOutcome {
        use LichessRevocationOutcome::*;
        // One deadline owns both requests and all response reads. Dropping this future on
        // expiry also drops the response stream, with no retained task or retry state.
        tokio::time::timeout_at(deadline, async {
            let response = match self
                .http_client
                .delete(&self.token_url)
                .bearer_auth(access_token)
                .send()
                .await
            {
                Ok(response) => response,
                Err(_) => return Unreachable,
            };
            match response.status() {
                status if status.is_success() => return Revoked,
                reqwest::StatusCode::TOO_MANY_REQUESTS => return RateLimited,
                reqwest::StatusCode::UNAUTHORIZED => {}
                _ => return Rejected,
            }
            // DELETE bodies cannot establish invalidity, including "No such token".
            drop(response);
            let mut response = match self
                .http_client
                .post(&self.token_test_url)
                .header(reqwest::header::CONTENT_TYPE, "text/plain")
                .body(access_token.to_owned())
                .send()
                .await
            {
                Ok(response) => response,
                Err(_) => return Unreachable,
            };
            match response.status() {
                reqwest::StatusCode::OK => {}
                reqwest::StatusCode::TOO_MANY_REQUESTS => return RateLimited,
                _ => return Rejected,
            }
            if response
                .content_length()
                .is_some_and(|length| length > MAX_TOKEN_TEST_RESPONSE_BYTES as u64)
            {
                return Rejected;
            }
            let mut body = Vec::new();
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        if chunk.len() > MAX_TOKEN_TEST_RESPONSE_BYTES - body.len() {
                            #[cfg(test)]
                            if let Some(counter) = retained_body_bytes {
                                counter.store(body.len(), std::sync::atomic::Ordering::Relaxed);
                            }
                            return Rejected;
                        }
                        body.extend_from_slice(&chunk);
                        #[cfg(test)]
                        if let Some(counter) = retained_body_bytes {
                            counter.store(body.len(), std::sync::atomic::Ordering::Relaxed);
                        }
                    }
                    Ok(None) => break,
                    Err(_) => return Unreachable,
                }
            }
            // The echoed token and body remain native, ephemeral, and never diagnostic data.
            match serde_json::from_slice::<serde_json::Value>(&body) {
                Ok(serde_json::Value::Object(values))
                    if values
                        .get(access_token)
                        .is_some_and(serde_json::Value::is_null) =>
                {
                    AlreadyInvalid
                }
                _ => Rejected,
            }
        })
        .await
        .unwrap_or(Unreachable)
    }
}

impl OAuthServices for ProdOAuthServices {
    async fn exchange_code(
        &self,
        client: &BasicClient,
        code: AuthorizationCode,
        verifier: PkceCodeVerifier,
    ) -> Result<String, Error> {
        let token_response = client
            .exchange_code(code)
            .set_pkce_verifier(verifier)
            .request_async(|request| safe_oauth_http_client(&self.http_client, request))
            .await
            .map_err(|source| {
                error!("OAuth token exchange failed: {source}");
                Error::OAuthFailure(OAUTH_FAILURE.into())
            })?;
        Ok(token_response.access_token().secret().clone())
    }

    async fn verify_identity(&self, access_token: &str) -> Result<String, Error> {
        #[derive(Deserialize)]
        struct Account {
            username: String,
        }
        let response = self
            .http_client
            .get(LICHESS_ACCOUNT_URL)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|_| Error::OAuthFailure(OAUTH_FAILURE.into()))?;
        if !response.status().is_success() {
            return Err(Error::OAuthFailure(OAUTH_FAILURE.into()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_VERIFY_RESPONSE_BYTES as u64)
        {
            return Err(Error::OAuthFailure(OAUTH_FAILURE.into()));
        }
        let body = response
            .bytes()
            .await
            .map_err(|_| Error::OAuthFailure(OAUTH_FAILURE.into()))?;
        if body.len() > MAX_VERIFY_RESPONSE_BYTES {
            return Err(Error::OAuthFailure(OAUTH_FAILURE.into()));
        }
        let account = serde_json::from_slice::<Account>(&body)
            .map_err(|_| Error::OAuthFailure(OAUTH_FAILURE.into()))?;
        if account.username.trim().is_empty() {
            return Err(Error::OAuthFailure(OAUTH_FAILURE.into()));
        }
        Ok(account.username)
    }

    async fn revoke_token(&self, access_token: &str) -> LichessRevocationOutcome {
        self.revoke_token_before(
            access_token,
            tokio::time::Instant::now() + REVOCATION_TIMEOUT,
            #[cfg(test)]
            None,
        )
        .await
    }

    fn start_listener_and_server(
        &self,
        lifecycle: Arc<AuthLifecycle>,
    ) -> Result<ListenerHandle, Error> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|source| {
            error!("OAuth callback listener bind failed: {source}");
            Error::OAuthFailure(OAUTH_FAILURE.into())
        })?;
        let addr = listener.local_addr().map_err(|source| {
            error!("OAuth callback listener address lookup failed: {source}");
            Error::OAuthFailure(OAUTH_FAILURE.into())
        })?;
        let redirect_url = format!("http://{addr}/callback");
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let router = Router::new()
            .route("/callback", get(authorize))
            .layer(Extension(lifecycle));
        let server = crate::infra::runtime::with_reactor(|| axum::Server::from_tcp(listener))
            .map_err(|source| {
                error!("OAuth callback server construction failed: {source}");
                Error::OAuthFailure(OAUTH_FAILURE.into())
            })?
            .serve(router.into_make_service())
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            });
        let task = tokio::spawn(async move {
            server.await.map_err(|source| {
                error!("OAuth callback server failed: {source}");
                source.to_string()
            })
        });

        Ok(ListenerHandle {
            redirect_url,
            shutdown_tx: Some(shutdown_tx),
            task,
            task_completed: false,
        })
    }
}

pub struct AuthInternalConfig<'a> {
    pub client_id: &'a str,
    pub token_url_override: &'a str,
    pub timeout_duration: Duration,
}

fn auth_internal_config(config: &tauri::Config) -> AuthInternalConfig<'_> {
    AuthInternalConfig {
        client_id: &config.identifier,
        token_url_override: "https://lichess.org/api/token",
        timeout_duration: Duration::from_secs(300),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn authenticate(
    username: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<AuthenticationJob, Error> {
    crate::infra::platform_support::off_unix_refusal("Lichess authentication", cfg!(unix))?;
    let lifecycle = state.auth.clone();
    let credentials = state.credentials.clone();
    let http_client = state.json_http_client.clone();
    let job = lifecycle.create_job();
    let job_id = job.id.clone();
    let opener = app.clone();
    let stashed_token = Arc::new(std::sync::Mutex::new(None));
    let token_for_delivery = stashed_token.clone();
    let username_for_store = username.clone();
    let credentials_for_store = credentials.clone();
    tauri::async_runtime::spawn(async move {
        let result = authenticate_internal(
            username.clone(),
            lifecycle.clone(),
            move |url| {
                opener
                    .opener()
                    .open_url(url, None::<&str>)
                    .map_err(|source| source.to_string())
            },
            move |access_token| {
                *token_for_delivery
                    .lock()
                    .map_err(|_| "OAuth token stash was unavailable".to_string())? =
                    Some(access_token);
                Ok(())
            },
            auth_internal_config(app.config()),
            ProdOAuthServices::new(http_client.clone()),
        )
        .await;
        let status = match result {
            Ok(()) => match persist_stashed_lichess_token(
                username_for_store,
                credentials_for_store,
                stashed_token,
                &ProdOAuthServices::new(http_client),
            )
            .await
            {
                Ok(status) => status,
                Err(source) => {
                    error!("OAuth native credential persistence failed: {source}");
                    AuthenticationStatus::Failed
                }
            },
            Err(_) => AuthenticationStatus::Failed,
        };
        lifecycle.complete_job(&job_id, status);
    });
    Ok(job)
}

async fn persist_stashed_lichess_token<S: OAuthServices>(
    username: String,
    credentials: Arc<crate::credentials::CredentialManager>,
    stashed_token: Arc<std::sync::Mutex<Option<String>>>,
    services: &S,
) -> Result<AuthenticationStatus, Error> {
    let token = stashed_token
        .lock()
        .map_err(|_| Error::Conflict("OAuth token stash was unavailable".into()))?
        .take()
        .ok_or_else(|| Error::OAuthFailure(OAUTH_FAILURE.into()))?;
    let result = match credentials
        .store_lichess_token_async(username, token.clone())
        .await
    {
        Ok(result) => result,
        Err(source) => {
            revoke_failed_authentication_token(services, &token).await;
            return Err(source);
        }
    };
    Ok(AuthenticationStatus::Succeeded {
        account: result.account,
        durability_uncertain: result.durability_uncertain,
    })
}

async fn revoke_failed_authentication_token<S: OAuthServices>(services: &S, token: &str) {
    let outcome = services.revoke_token(token).await;
    warn!("OAuth failed authentication token revocation outcome: {outcome:?}");
}

#[tauri::command]
#[specta::specta]
pub fn get_authentication_status(
    job: AuthenticationJob,
    state: tauri::State<'_, AppState>,
) -> Result<AuthenticationStatus, Error> {
    state
        .auth
        .job(&job.id)
        .ok_or_else(|| Error::InvalidInput("authentication job not found".into()))
}

#[tauri::command]
#[specta::specta]
pub fn list_lichess_accounts(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<LichessAccountMetadata>, Error> {
    state.credentials.list()
}

#[tauri::command]
#[specta::specta]
pub async fn remove_lichess_account(
    handle: LichessAccountHandle,
    state: tauri::State<'_, AppState>,
) -> Result<LichessAccountRemoval, Error> {
    let services = ProdOAuthServices::new(state.json_http_client.clone());
    remove_lichess_account_internal(handle, state.credentials.clone(), &services).await
}

async fn remove_lichess_account_internal<S: OAuthServices>(
    handle: LichessAccountHandle,
    credentials: Arc<crate::credentials::CredentialManager>,
    services: &S,
) -> Result<LichessAccountRemoval, Error> {
    let Some(removal) = credentials.remove_async(handle).await? else {
        return Ok(LichessAccountRemoval::NotFound);
    };
    // Local removal is already committed. A provider outage, or an unconfirmed parent
    // fsync, is reported on the result without rolling local access back into existence.
    let revocation_outcome = match removal.token {
        Some(token) => Some(services.revoke_token(&token).await),
        None => None,
    };
    Ok(LichessAccountRemoval::Removed {
        revocation_pending: revocation_outcome.is_some_and(LichessRevocationOutcome::is_pending),
        revocation_outcome,
        durability_uncertain: removal.durability_uncertain,
    })
}

/// Handle-free revocation: writes no keyring, registry or file, is not platform-gated,
/// and never echoes the supplied token.
#[tauri::command]
#[specta::specta]
pub async fn revoke_legacy_lichess_token(
    token: String,
    state: tauri::State<'_, AppState>,
) -> Result<LichessRevocationOutcome, Error> {
    revoke_legacy_lichess_token_internal(
        token,
        &ProdOAuthServices::new(state.json_http_client.clone()),
    )
    .await
}

async fn revoke_legacy_lichess_token_internal<S: OAuthServices>(
    token: String,
    services: &S,
) -> Result<LichessRevocationOutcome, Error> {
    Ok(services.revoke_token(&token).await)
}

/// One-way bridge for pre-credential-store renderer records. The caller must erase the supplied
/// legacy token from Web Storage after this succeeds; this command never returns it.
#[tauri::command]
#[specta::specta]
pub async fn migrate_legacy_lichess_token(
    username: String,
    token: String,
    state: tauri::State<'_, AppState>,
) -> Result<LichessAccountStoreResult, Error> {
    crate::infra::platform_support::off_unix_refusal("legacy Lichess token migration", cfg!(unix))?;
    let services = ProdOAuthServices::new(state.json_http_client.clone());
    migrate_legacy_token_internal(username, token, state.credentials.clone(), &services).await
}

async fn migrate_legacy_token_internal<S: OAuthServices>(
    username: String,
    token: String,
    credentials: Arc<crate::credentials::CredentialManager>,
    services: &S,
) -> Result<LichessAccountStoreResult, Error> {
    let verified_username = services.verify_identity(&token).await?;
    if !verified_username.eq_ignore_ascii_case(username.trim()) {
        return Err(Error::OAuthFailure(OAUTH_FAILURE.into()));
    }
    credentials
        .store_lichess_token_async(verified_username, token)
        .await
}

pub async fn authenticate_internal<O, E, S>(
    username: String,
    lifecycle: Arc<AuthLifecycle>,
    open_browser: O,
    emit_token: E,
    config: AuthInternalConfig<'_>,
    services: S,
) -> Result<(), Error>
where
    O: FnOnce(&str) -> Result<(), String>,
    E: FnOnce(String) -> Result<(), String>,
    S: OAuthServices,
{
    let csrf_token = CsrfToken::new_random();
    let deadline = tokio::time::Instant::now() + config.timeout_duration;
    let (generation, callback_rx) = lifecycle.begin(csrf_token.clone()).await?;
    let mut listener = match services.start_listener_and_server(lifecycle.clone()) {
        Ok(listener) => listener,
        Err(source) => {
            error!("OAuth callback listener setup failed: {source}");
            lifecycle.clear_generation(generation).await;
            return Err(Error::OAuthFailure(OAUTH_FAILURE.into()));
        }
    };

    let mut issued_token: Option<String> = None;
    let result = match tokio::time::timeout(
        deadline.saturating_duration_since(tokio::time::Instant::now()),
        authenticate_after_listener(
            username,
            csrf_token,
            callback_rx,
            &mut listener,
            open_browser,
            emit_token,
            &config,
            &services,
            &mut issued_token,
        ),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            warn!("OAuth authentication timed out");
            Err(Error::OAuthFailure(OAUTH_FAILURE.into()))
        }
    };
    shutdown_listener(
        &mut listener,
        deadline.saturating_duration_since(tokio::time::Instant::now()),
    )
    .await;
    lifecycle.clear_generation(generation).await;
    if let Some(token) = issued_token.take() {
        revoke_failed_authentication_token(&services, &token).await;
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn authenticate_after_listener<O, E, S>(
    username: String,
    csrf_token: CsrfToken,
    callback_rx: oneshot::Receiver<CallbackSignal>,
    listener: &mut ListenerHandle,
    open_browser: O,
    emit_token: E,
    config: &AuthInternalConfig<'_>,
    services: &S,
    issued_token: &mut Option<String>,
) -> Result<(), Error>
where
    O: FnOnce(&str) -> Result<(), String>,
    E: FnOnce(String) -> Result<(), String>,
    S: OAuthServices,
{
    let client = match oauth_client(
        &listener.redirect_url,
        config.client_id,
        config.token_url_override,
    ) {
        Ok(client) => client,
        Err(source) => {
            error!("OAuth client setup failed: {source}");
            return Err(Error::OAuthFailure(OAUTH_FAILURE.into()));
        }
    };
    let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
    let (authorization_url, _) = client
        .authorize_url(|| csrf_token)
        .add_scope(Scope::new("preference:read".into()))
        .add_extra_param("username", username.clone())
        .set_pkce_challenge(pkce_challenge)
        .url();

    if let Err(source) = open_browser(authorization_url.as_str()) {
        error!("OAuth browser opener failed: {source}");
        return Err(Error::OAuthFailure(OAUTH_FAILURE.into()));
    }

    tokio::pin!(callback_rx);
    tokio::select! {
        server_result = &mut listener.task => {
            listener.task_completed = true;
            match server_result {
                Ok(Ok(())) => error!("OAuth callback server stopped before authentication completed"),
                Ok(Err(source)) => error!("OAuth callback server failed: {source}"),
                Err(source) => error!("OAuth callback server task failed: {source}"),
            }
            Err(Error::OAuthFailure(OAUTH_FAILURE.into()))
        }
        callback_result = &mut callback_rx => match callback_result {
            Ok(CallbackSignal::Code(code)) => match services.exchange_code(&client, code, pkce_verifier).await {
                Ok(access_token) => {
                    *issued_token = Some(access_token.clone());
                    match services.verify_identity(&access_token).await {
                        Ok(verified_username) if verified_username.eq_ignore_ascii_case(&username) => if let Err(source) = emit_token(access_token) {
                            error!("OAuth native credential persistence failed: {source}");
                            Err(Error::OAuthFailure(OAUTH_FAILURE.into()))
                        } else {
                            issued_token.take();
                            info!("OAuth identity credential stored");
                            Ok(())
                        },
                        Ok(_) => {
                            warn!("OAuth verified identity did not match requested account");
                            Err(Error::OAuthFailure(OAUTH_FAILURE.into()))
                        }
                        Err(source) => {
                            error!("OAuth identity verification failed: {source}");
                            Err(Error::OAuthFailure(OAUTH_FAILURE.into()))
                        }
                    }
                },
                Err(source) => {
                    error!("OAuth token exchange failed: {source}");
                    Err(Error::OAuthFailure(OAUTH_FAILURE.into()))
                }
            },
            Ok(CallbackSignal::Rejected) => {
                warn!("OAuth provider rejected or cancelled authentication");
                Err(Error::OAuthFailure(OAUTH_FAILURE.into()))
            },
            Err(source) => {
                error!("OAuth callback channel closed: {source}");
                Err(Error::OAuthFailure(OAUTH_FAILURE.into()))
            }
        },
    }
}

fn oauth_client(
    redirect_url: &str,
    client_id: &str,
    token_url_override: &str,
) -> Result<BasicClient, String> {
    let auth_url =
        AuthUrl::new("https://lichess.org/oauth".into()).map_err(|source| source.to_string())?;
    let token_url =
        TokenUrl::new(token_url_override.into()).map_err(|source| source.to_string())?;
    let redirect_url =
        RedirectUrl::new(redirect_url.into()).map_err(|source| source.to_string())?;
    Ok(BasicClient::new(
        ClientId::new(client_id.into()),
        None,
        auth_url,
        Some(token_url),
    )
    .set_redirect_uri(redirect_url))
}

async fn shutdown_listener(listener: &mut ListenerHandle, drain_timeout: Duration) {
    if let Some(shutdown_tx) = listener.shutdown_tx.take() {
        let _ = shutdown_tx.send(());
    }
    if listener.task_completed {
        return;
    }
    match tokio::time::timeout(
        drain_timeout.min(LISTENER_DRAIN_TIMEOUT),
        &mut listener.task,
    )
    .await
    {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(source))) => error!("OAuth callback server cleanup failed: {source}"),
        Ok(Err(source)) => error!("OAuth callback server task cleanup failed: {source}"),
        Err(_) => {
            warn!(
                "OAuth callback server did not stop before the transaction deadline; aborting it"
            );
            listener.task.abort();
            if let Err(source) = (&mut listener.task).await {
                if !source.is_cancelled() {
                    error!("OAuth callback server abort join failed: {source}");
                }
            }
        }
    }
    listener.task_completed = true;
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    pub code: Option<AuthorizationCode>,
    pub state: Option<CsrfToken>,
    pub error: Option<String>,
}

pub async fn authorize(
    Extension(lifecycle): Extension<Arc<AuthLifecycle>>,
    Query(query): Query<CallbackQuery>,
) -> impl IntoResponse {
    callback_page(lifecycle.accept_callback(query).await)
}

fn callback_page(result: CallbackResult) -> Html<&'static str> {
    match result {
        CallbackResult::AcceptedCode => {
            Html("Authentication successful! You can close this window.")
        }
        CallbackResult::AcceptedRejection => Html("Authentication was cancelled or denied."),
        CallbackResult::Mismatch => {
            warn!("OAuth callback rejected because its CSRF state did not match");
            Html("Authentication failed: state mismatch.")
        }
        CallbackResult::Missing => Html("Authentication failed: no active transaction."),
        CallbackResult::Closed => Html("Authentication failed: transaction closed."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Uri;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct RejectingCredentialStore;

    impl crate::credentials::CredentialStore for RejectingCredentialStore {
        fn set(&self, _key: &str, _secret: &str) -> Result<(), Error> {
            Err(Error::CredentialFailure("injected".into()))
        }

        fn get(&self, _key: &str) -> Result<Option<String>, Error> {
            Ok(None)
        }

        fn delete(&self, _key: &str) -> Result<(), Error> {
            Ok(())
        }
    }

    #[test]
    fn oauth_http_response_conversion_preserves_http_02_status_headers_and_body() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        headers.insert(
            "x-provider-request-id",
            reqwest::header::HeaderValue::from_static("request-123"),
        );

        let converted = oauth_response_from_reqwest(
            reqwest::StatusCode::OK,
            &headers,
            bytes::Bytes::from_static(br#"{\"access_token\":\"token\"}"#),
        )
        .unwrap();

        assert_eq!(converted.status_code, axum::http::StatusCode::OK);
        assert_eq!(
            converted.headers.get("content-type").unwrap(),
            "application/json"
        );
        assert_eq!(
            converted.headers.get("x-provider-request-id").unwrap(),
            "request-123"
        );
        assert_eq!(converted.body, br#"{\"access_token\":\"token\"}"#);
    }

    #[test]
    fn oauth_http_response_conversion_rejects_oversized_body_after_transfer() {
        let error = oauth_response_from_reqwest(
            reqwest::StatusCode::OK,
            &reqwest::header::HeaderMap::new(),
            bytes::Bytes::from(vec![0; MAX_OAUTH_RESPONSE_BYTES + 1]),
        )
        .unwrap_err();

        assert!(
            matches!(error, oauth2::reqwest::Error::Other(message) if message.contains("exceeded"))
        );
    }

    #[test]
    fn production_auth_config_sources_client_id_from_shipped_tauri_config() {
        let config = serde_json::from_str::<tauri::Config>(include_str!("../tauri.conf.json"))
            .expect("repository Tauri configuration must deserialize");
        let auth_config = auth_internal_config(&config);
        assert_eq!(config.identifier, "com.chessriddle.encroissant");
        assert_eq!(auth_config.client_id, config.identifier);
    }

    #[test]
    fn development_auth_config_uses_fork_identifier() {
        let config =
            serde_json::from_str::<serde_json::Value>(include_str!("../tauri.dev.conf.json"))
                .expect("repository development Tauri configuration must deserialize");
        assert_eq!(config["identifier"], "com.chessriddle.encroissant.dev");
    }

    #[derive(Clone)]
    struct MockServices {
        bind_error: Option<String>,
        exchange_error: Option<String>,
        exchange_pending: bool,
        verified_username: String,
        verify_error: Option<String>,
        verify_delay: Option<Duration>,
        revoke_outcome: LichessRevocationOutcome,
        server_error: bool,
        listener_ignores_shutdown: bool,
        exchange_started: Arc<AtomicBool>,
        revoke_calls: Arc<AtomicUsize>,
        revoked_tokens: Arc<Mutex<Vec<String>>>,
        listener_stopped: Arc<AtomicBool>,
        listener_aborted: Arc<AtomicBool>,
        listener_starts: Arc<AtomicUsize>,
    }

    impl MockServices {
        fn new() -> Self {
            Self {
                bind_error: None,
                exchange_error: None,
                exchange_pending: false,
                verified_username: "user".into(),
                verify_error: None,
                verify_delay: None,
                revoke_outcome: LichessRevocationOutcome::Revoked,
                server_error: false,
                listener_ignores_shutdown: false,
                exchange_started: Arc::new(AtomicBool::new(false)),
                revoke_calls: Arc::new(AtomicUsize::new(0)),
                revoked_tokens: Arc::new(Mutex::new(Vec::new())),
                listener_stopped: Arc::new(AtomicBool::new(false)),
                listener_aborted: Arc::new(AtomicBool::new(false)),
                listener_starts: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    impl OAuthServices for MockServices {
        async fn exchange_code(
            &self,
            _: &BasicClient,
            _: AuthorizationCode,
            _: PkceCodeVerifier,
        ) -> Result<String, Error> {
            self.exchange_started.store(true, Ordering::Relaxed);
            if self.exchange_pending {
                std::future::pending::<()>().await;
            }
            match self.exchange_error.clone() {
                Some(source) => Err(Error::OAuthFailure(source)),
                None => Ok("token".into()),
            }
        }

        async fn verify_identity(&self, _: &str) -> Result<String, Error> {
            if let Some(delay) = self.verify_delay {
                tokio::time::sleep(delay).await;
            }
            match self.verify_error.clone() {
                Some(source) => Err(Error::OAuthFailure(source)),
                None => Ok(self.verified_username.clone()),
            }
        }

        async fn revoke_token(&self, access_token: &str) -> LichessRevocationOutcome {
            self.revoke_calls.fetch_add(1, Ordering::Relaxed);
            self.revoked_tokens.lock().await.push(access_token.into());
            self.revoke_outcome
        }

        fn start_listener_and_server(
            &self,
            _: Arc<AuthLifecycle>,
        ) -> Result<ListenerHandle, Error> {
            self.listener_starts.fetch_add(1, Ordering::Relaxed);
            if let Some(source) = &self.bind_error {
                return Err(Error::OAuthFailure(source.clone()));
            }
            let (shutdown_tx, shutdown_rx) = oneshot::channel();
            let stopped = self.listener_stopped.clone();
            let aborted = self.listener_aborted.clone();
            let server_error = self.server_error;
            let ignores_shutdown = self.listener_ignores_shutdown;
            let task = tokio::spawn(async move {
                struct AbortMarker(Arc<AtomicBool>);
                impl Drop for AbortMarker {
                    fn drop(&mut self) {
                        self.0.store(true, Ordering::Relaxed);
                    }
                }
                if server_error {
                    return Err("mock server failure".into());
                }
                if ignores_shutdown {
                    let _aborted = AbortMarker(aborted);
                    std::future::pending::<()>().await;
                }
                let _ = shutdown_rx.await;
                stopped.store(true, Ordering::Relaxed);
                Ok(())
            });
            Ok(ListenerHandle {
                redirect_url: "http://mock/callback".into(),
                shutdown_tx: Some(shutdown_tx),
                task,
                task_completed: false,
            })
        }
    }

    fn config() -> AuthInternalConfig<'static> {
        AuthInternalConfig {
            client_id: "test-client-id",
            token_url_override: "http://mock/token",
            timeout_duration: Duration::from_secs(1),
        }
    }

    fn short_config() -> AuthInternalConfig<'static> {
        AuthInternalConfig {
            client_id: "test-client-id",
            token_url_override: "http://mock/token",
            timeout_duration: Duration::from_millis(20),
        }
    }

    fn deadline_config() -> AuthInternalConfig<'static> {
        AuthInternalConfig {
            client_id: "test-client-id",
            token_url_override: "http://mock/token",
            timeout_duration: Duration::from_millis(100),
        }
    }

    fn start_attempt(
        lifecycle: Arc<AuthLifecycle>,
        services: MockServices,
        emit: impl FnOnce(String) -> Result<(), String> + Send + 'static,
    ) -> JoinHandle<Result<(), Error>> {
        start_attempt_with_config(lifecycle, services, emit, config())
    }

    fn start_attempt_with_config(
        lifecycle: Arc<AuthLifecycle>,
        services: MockServices,
        emit: impl FnOnce(String) -> Result<(), String> + Send + 'static,
        config: AuthInternalConfig<'static>,
    ) -> JoinHandle<Result<(), Error>> {
        tokio::spawn(authenticate_internal(
            "user".into(),
            lifecycle,
            |_| Ok(()),
            emit,
            config,
            services,
        ))
    }

    async fn send_valid(lifecycle: Arc<AuthLifecycle>) -> CallbackResult {
        let state = lifecycle
            .active_state()
            .await
            .expect("active test transaction");
        lifecycle
            .accept_callback(CallbackQuery {
                code: Some(AuthorizationCode::new("code".into())),
                state: Some(state),
                error: None,
            })
            .await
    }

    #[tokio::test]
    async fn opener_failure_cleans_state_and_listener() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        let services = MockServices::new();
        let result = authenticate_internal(
            "user".into(),
            lifecycle.clone(),
            |_| Err("opener failed".into()),
            |_| Ok(()),
            config(),
            services.clone(),
        )
        .await;
        assert!(matches!(result, Err(Error::OAuthFailure(message)) if message == OAUTH_FAILURE));
        assert!(lifecycle.is_idle().await);
        assert!(services.listener_stopped.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn authentication_url_carries_configured_client_id() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        let services = MockServices::new();
        let opened_url = Arc::new(std::sync::Mutex::new(None));
        let captured_url = opened_url.clone();
        let result = authenticate_internal(
            "user".into(),
            lifecycle,
            move |url| {
                *captured_url.lock().expect("captured URL mutex") =
                    Some(url::Url::parse(url).expect("OAuth authorization URL"));
                Err("stop after capturing URL".into())
            },
            |_| Ok(()),
            config(),
            services,
        )
        .await;

        assert!(matches!(result, Err(Error::OAuthFailure(message)) if message == OAUTH_FAILURE));
        let opened_url = opened_url.lock().expect("captured URL mutex");
        let client_id = opened_url
            .as_ref()
            .expect("browser opener receives a URL")
            .query_pairs()
            .find_map(|(key, value)| (key == "client_id").then(|| value.into_owned()));
        assert_eq!(client_id.as_deref(), Some("test-client-id"));
    }

    #[tokio::test]
    async fn bind_failure_clears_reserved_attempt() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        let mut services = MockServices::new();
        services.bind_error = Some("occupied".into());
        let result = authenticate_internal(
            "user".into(),
            lifecycle.clone(),
            |_| Ok(()),
            |_| Ok(()),
            config(),
            services,
        )
        .await;
        assert!(matches!(result, Err(Error::OAuthFailure(message)) if message == OAUTH_FAILURE));
        assert!(lifecycle.is_idle().await);
    }

    #[tokio::test]
    async fn stale_generation_cleanup_does_not_clear_new_attempt() {
        let lifecycle = AuthLifecycle::default();
        let (first_generation, first_rx) = lifecycle
            .begin(CsrfToken::new_random())
            .await
            .expect("first attempt");
        lifecycle.clear_generation(first_generation).await;
        drop(first_rx);
        let (second_generation, second_rx) = lifecycle
            .begin(CsrfToken::new_random())
            .await
            .expect("second attempt");
        lifecycle.clear_generation(first_generation).await;
        assert!(lifecycle.active_state().await.is_some());
        lifecycle.clear_generation(second_generation).await;
        drop(second_rx);
        assert!(lifecycle.is_idle().await);
    }

    #[test]
    fn authentication_jobs_are_correlated_and_token_free() {
        let lifecycle = AuthLifecycle::default();
        let first = lifecycle.create_job();
        let second = lifecycle.create_job();
        assert_ne!(first.id, second.id);
        assert_eq!(
            lifecycle.job(&first.id),
            Some(AuthenticationStatus::Pending)
        );
        lifecycle.complete_job(&first.id, AuthenticationStatus::Failed);
        assert_eq!(lifecycle.job(&first.id), Some(AuthenticationStatus::Failed));
        assert_eq!(
            lifecycle.job(&second.id),
            Some(AuthenticationStatus::Pending)
        );
    }

    #[test]
    fn expired_authentication_job_is_evicted_on_lookup() {
        let lifecycle = AuthLifecycle::default();
        let job = AuthenticationJob {
            id: uuid::Uuid::new_v4().to_string(),
        };
        lifecycle.jobs.insert(
            job.id.clone(),
            (
                AuthenticationStatus::Pending,
                tokio::time::Instant::now() - JOB_TTL,
            ),
        );
        assert_eq!(lifecycle.job(&job.id), None);
        assert!(!lifecycle.jobs.contains_key(&job.id));
    }

    #[test]
    fn provider_endpoints_are_exactly_allowlisted() {
        let services = ProdOAuthServices::new(Arc::new(reqwest::Client::new()));
        assert_eq!(services.token_url, LICHESS_TOKEN_URL);
        assert_eq!(services.token_test_url, LICHESS_TOKEN_TEST_URL);
        for (endpoint, path) in [
            (LICHESS_ACCOUNT_URL, "/api/account"),
            (LICHESS_TOKEN_URL, "/api/token"),
            (LICHESS_TOKEN_TEST_URL, "/api/token/test"),
        ] {
            let parsed = reqwest::Url::parse(endpoint).unwrap();
            assert_eq!(parsed.scheme(), "https");
            assert_eq!(parsed.host_str(), Some("lichess.org"));
            assert_eq!(parsed.path(), path);
            assert!(parsed.query().is_none());
        }
    }

    #[tokio::test]
    async fn legacy_revocation_calls_services_once_with_the_supplied_token() {
        let services = MockServices::new();
        let outcome = revoke_legacy_lichess_token_internal("legacy-secret".into(), &services)
            .await
            .unwrap();
        assert_eq!(outcome, LichessRevocationOutcome::Revoked);
        assert_eq!(services.revoke_calls.load(Ordering::Relaxed), 1);
        assert_eq!(*services.revoked_tokens.lock().await, vec!["legacy-secret"]);
    }

    fn assert_token_free_outcome(outcome: LichessRevocationOutcome, token: &str) {
        assert!(!serde_json::to_string(&outcome).unwrap().contains(token));
        assert!(!format!("{outcome:?}").contains(token));
    }

    #[tokio::test]
    async fn legacy_revocation_preserves_every_safe_outcome_as_successful_data() {
        use LichessRevocationOutcome::*;
        let token = "legacy-private-secret";
        for outcome in [Revoked, AlreadyInvalid, Unreachable, RateLimited, Rejected] {
            let mut services = MockServices::new();
            services.revoke_outcome = outcome;
            let result = revoke_legacy_lichess_token_internal(token.into(), &services)
                .await
                .unwrap();
            assert_eq!(result, outcome);
            assert_eq!(services.revoke_calls.load(Ordering::Relaxed), 1);
            assert_eq!(*services.revoked_tokens.lock().await, vec![token]);
            assert_token_free_outcome(result, token);
        }
    }

    async fn read_revocation_request(stream: &mut tokio::net::TcpStream) -> String {
        use tokio::io::AsyncReadExt;
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(stream.read_u8().await.unwrap());
            assert!(request.len() <= 8192);
        }
        let headers = String::from_utf8(request.clone()).unwrap();
        let length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        assert!(length <= 8192);
        let mut body = vec![0; length];
        stream.read_exact(&mut body).await.unwrap();
        request.extend(body);
        String::from_utf8(request).unwrap()
    }

    fn assert_revocation_delete_request(request: &str) {
        assert!(request.starts_with("DELETE /api/token HTTP/1.1\r\n"));
        assert!(request.contains("authorization: Bearer loopback-private-secret\r\n"));
    }

    fn assert_revocation_confirmation_request(request: &str) {
        assert!(request.starts_with("POST /api/token/test HTTP/1.1\r\n"));
        assert!(request.contains("content-type: text/plain\r\n"));
        assert!(!request.contains("authorization:"));
        assert_eq!(
            request.split_once("\r\n\r\n").unwrap().1,
            "loopback-private-secret"
        );
    }

    fn revocation_response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    async fn loopback_revocation(
        responses: Vec<String>,
    ) -> (Vec<String>, LichessRevocationOutcome) {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        // Only the loopback test bypasses public DNS policy. Production retains AppState's client.
        let services = ProdOAuthServices::with_token_urls(
            Arc::new(reqwest::Client::builder().no_proxy().build().unwrap()),
            format!("{origin}/api/token"),
            format!("{origin}/api/token/test"),
        );
        let server = async {
            let mut requests = Vec::new();
            for response in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                requests.push(read_revocation_request(&mut stream).await);
                // A bounded reader may close before this over-cap test response finishes.
                let _ = stream.write_all(response.as_bytes()).await;
            }
            requests
        };
        let (requests, outcome) = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(server, services.revoke_token("loopback-private-secret"))
        })
        .await
        .expect("revocation must reach and finish the loopback server");
        // An unexpected extra token-test request cannot succeed after the server exits.
        assert_token_free_outcome(outcome, "loopback-private-secret");
        (requests, outcome)
    }

    #[tokio::test]
    async fn production_revocation_sends_delete_with_bearer_and_checks_status() {
        use LichessRevocationOutcome::*;
        for (status, expected) in [
            ("200 OK", Revoked),
            ("204 No Content", Revoked),
            ("429 Too Many Requests", RateLimited),
            ("403 Forbidden", Rejected),
            ("500 Internal Server Error", Rejected),
        ] {
            let (requests, outcome) =
                loopback_revocation(vec![revocation_response(status, "No such token")]).await;
            assert_eq!(outcome, expected);
            assert_eq!(requests.len(), 1);
            assert_revocation_delete_request(&requests[0]);
        }
    }

    #[tokio::test]
    async fn production_revocation_only_confirms_the_exact_token_null_after_401() {
        use LichessRevocationOutcome::*;
        for (status, body, expected) in [
            (
                "200 OK",
                r#"{"loopback-private-secret":null}"#,
                AlreadyInvalid,
            ),
            (
                "200 OK",
                r#"{"loopback-private-secret":{"userId":"existing"}}"#,
                Rejected,
            ),
            ("200 OK", r#"{"another-token":null}"#, Rejected),
            ("200 OK", r#"{"loopback-private-secret":false}"#, Rejected),
            ("200 OK", r#"{"loopback-private-secret":"null"}"#, Rejected),
            ("200 OK", "null", Rejected),
            ("200 OK", "malformed loopback-private-secret", Rejected),
            (
                "429 Too Many Requests",
                "loopback-private-secret",
                RateLimited,
            ),
            (
                "401 Unauthorized",
                r#"{"loopback-private-secret":null}"#,
                Rejected,
            ),
            (
                "201 Created",
                r#"{"loopback-private-secret":null}"#,
                Rejected,
            ),
        ] {
            // Signature rejection of an existing token uses this same ambiguous DELETE body.
            let (requests, outcome) = loopback_revocation(vec![
                revocation_response("401 Unauthorized", "No such token"),
                revocation_response(status, body),
            ])
            .await;
            assert_eq!(outcome, expected);
            assert_eq!(requests.len(), 2);
            assert_revocation_confirmation_request(&requests[1]);
        }
    }

    #[tokio::test]
    async fn production_revocation_bounds_streaming_confirmation_and_distinguishes_read_failure() {
        use tokio::io::AsyncWriteExt;
        use LichessRevocationOutcome::*;
        let prefix = r#"{"loopback-private-secret":null}"#;
        let exact_cap = format!(
            "{prefix}{}",
            " ".repeat(MAX_TOKEN_TEST_RESPONSE_BYTES - prefix.len())
        );
        assert_eq!(exact_cap.len(), MAX_TOKEN_TEST_RESPONSE_BYTES);
        let oversize = format!("{exact_cap} ");
        for (response, expected) in [
            (String::new(), Unreachable),
            (revocation_response("200 OK", &exact_cap), AlreadyInvalid),
            (revocation_response("200 OK", &oversize), Rejected),
            // No Content-Length: enforce the cap on chunks, not just response headers.
            (format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{oversize}\r\n0\r\n\r\n", oversize.len()), Rejected),
            // A declared length is not trusted as evidence that the complete JSON arrived.
            ("HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{\"loopback-private-secret\":null}".into(), Unreachable),
        ] {
            let (_, outcome) = loopback_revocation(vec![revocation_response("401 Unauthorized", ""), response]).await;
            assert_eq!(outcome, expected);
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let services = ProdOAuthServices::with_token_urls(
            Arc::new(reqwest::Client::builder().no_proxy().build().unwrap()),
            format!("{origin}/api/token"),
            format!("{origin}/api/token/test"),
        );
        let server = async {
            let (mut delete, _) = listener.accept().await.unwrap();
            read_revocation_request(&mut delete).await;
            delete
                .write_all(revocation_response("401 Unauthorized", "").as_bytes())
                .await
                .unwrap();
            drop(delete);
            let (mut confirmation, _) = listener.accept().await.unwrap();
            read_revocation_request(&mut confirmation).await;
            confirmation
                .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            confirmation.write_all(oversize.as_bytes()).await.unwrap();
            // Windows loopback can accept this trailer into the receive window
            // after the client has stopped. The retained-byte counter is the
            // proof that those bytes were not kept.
            let trailing_body = vec![b' '; 16 * 1024 * 1024];
            tokio::time::timeout(
                Duration::from_secs(2),
                confirmation.write_all(&trailing_body),
            )
            .await
        };
        let retained = AtomicUsize::new(usize::MAX);
        let (_extra_write, outcome) = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(
                server,
                services.revoke_token_before(
                    "loopback-private-secret",
                    tokio::time::Instant::now() + REVOCATION_TIMEOUT,
                    Some(&retained),
                )
            )
        })
        .await
        .expect("revocation must stop reading the over-cap loopback response");
        assert_eq!(outcome, Rejected);
        assert!(
            retained.load(Ordering::Relaxed) <= MAX_TOKEN_TEST_RESPONSE_BYTES,
            "retained revocation body exceeded the cap"
        );
        assert_token_free_outcome(outcome, "loopback-private-secret");
    }

    #[tokio::test]
    async fn production_revocation_uses_one_absolute_deadline_for_both_requests_and_reads() {
        use std::{future::Future, pin::Pin};
        use tokio::io::AsyncWriteExt;
        use tokio::time::Instant;

        async fn checkpoint<T>(
            client: Pin<&mut impl Future<Output = LichessRevocationOutcome>>,
            stage: impl Future<Output = T>,
            name: &str,
        ) -> T {
            tokio::select! {
                biased;
                outcome = client => panic!("revocation completed before {name}: {outcome:?}"),
                result = tokio::time::timeout(REVOCATION_TIMEOUT / 3, stage) => {
                    result.unwrap_or_else(|_| panic!("revocation checkpoint timed out: {name}"))
                }
            }
        }

        assert_eq!(REVOCATION_TIMEOUT, Duration::from_secs(30));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let services = ProdOAuthServices::with_token_urls(
            Arc::new(reqwest::Client::builder().no_proxy().build().unwrap()),
            format!("{url}/api/token"),
            format!("{url}/api/token/test"),
        );
        let retained = AtomicUsize::new(0);
        let started = Instant::now();
        let deadline = started + REVOCATION_TIMEOUT;
        let client =
            services.revoke_token_before("loopback-private-secret", deadline, Some(&retained));
        tokio::pin!(client);
        let (mut delete, delete_request, delete_received) = checkpoint(
            client.as_mut(),
            async {
                let (mut delete, _) = listener.accept().await.unwrap();
                let request = read_revocation_request(&mut delete).await;
                (delete, request, Instant::now())
            },
            "DELETE receipt",
        )
        .await;
        assert_revocation_delete_request(&delete_request);
        let first_consumption = REVOCATION_TIMEOUT / 2;
        assert!(delete_received + first_consumption < deadline);
        // No stage watchdog survives a jump, and only this controller advances time.
        tokio::time::pause();
        tokio::time::advance(first_consumption).await;
        tokio::time::resume();

        // POST cannot begin before we release DELETE's 401. This lower bound is
        // earlier than POST receipt and also bounds any renewed body-read budget.
        let second_request_not_before = Instant::now();
        let earliest_renewed_deadline = second_request_not_before + REVOCATION_TIMEOUT;
        let body = r#"{"loopback-private-secret":null}"#;
        let prefix = r#"{"loopback-private-secret":"#;
        assert!(!prefix.is_empty() && prefix.len() < body.len());
        let (confirmation, post_request, post_received) = checkpoint(
            client.as_mut(),
            async {
                delete
                    .write_all(revocation_response("401 Unauthorized", "").as_bytes())
                    .await
                    .unwrap();
                drop(delete);
                let (mut confirmation, _) = listener.accept().await.unwrap();
                let request = read_revocation_request(&mut confirmation).await;
                let received = Instant::now();
                confirmation
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{prefix}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                (confirmation, request, received)
            },
            "401 response and POST receipt",
        )
        .await;
        assert_revocation_confirmation_request(&post_request);
        let body_entered = checkpoint(
            client.as_mut(),
            async {
                while retained.load(Ordering::Relaxed) != prefix.len() {
                    tokio::task::yield_now().await;
                }
                Instant::now()
            },
            "client retention of the incomplete body prefix",
        )
        .await;
        assert_eq!(retained.load(Ordering::Relaxed), prefix.len());
        assert!(delete_received + first_consumption <= second_request_not_before);
        assert!(second_request_not_before <= post_received && post_received <= body_entered);
        assert!(body_entered < deadline);

        let margin = REVOCATION_TIMEOUT / 6;
        let expiry_probe = deadline + margin;
        let observation_limit = earliest_renewed_deadline - margin;
        assert!(body_entered < expiry_probe);
        assert!(deadline < expiry_probe && expiry_probe < observation_limit);
        assert!(observation_limit < earliest_renewed_deadline);
        tokio::time::pause();
        tokio::time::advance(expiry_probe - Instant::now()).await;
        tokio::time::resume();

        // Keep the incomplete response and its socket open. Tokio advance does
        // not guarantee immediate timer readiness, so await with time running.
        let outcome = tokio::time::timeout_at(observation_limit, client.as_mut())
            .await
            .expect("original revocation deadline must expire before any renewed budget");
        let completed = Instant::now();
        drop(confirmation);
        drop(listener);
        assert!(deadline < completed && completed < observation_limit);
        assert!(completed < earliest_renewed_deadline);
        assert_eq!(outcome, LichessRevocationOutcome::Unreachable);
        assert_token_free_outcome(outcome, "loopback-private-secret");
        eprintln!(
            "revocation boundaries from start: DELETE={:?}, before401={:?}, POST={:?}, body={:?}, original={:?}, completed={:?}, observation_limit={:?}, earliest_renewed={:?}",
            delete_received - started,
            second_request_not_before - started,
            post_received - started,
            body_entered - started,
            deadline - started,
            completed - started,
            observation_limit - started,
            earliest_renewed_deadline - started,
        );
    }

    #[tokio::test]
    async fn production_revocation_redacts_connection_failure() {
        // Keep the port reserved for the whole dial: a freed ephemeral port can be
        // handed to a concurrent loopback fixture (f-20261101-02).
        let reservation = tokio::net::TcpSocket::new_v4().unwrap();
        reservation.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let addr = reservation.local_addr().unwrap();
        let url = format!("http://{addr}/api/token");
        let assert_held = || {
            assert_eq!(
                std::net::TcpListener::bind(addr).unwrap_err().kind(),
                std::io::ErrorKind::AddrInUse,
            );
        };
        assert_held();
        // Distinguishes a non-listening reservation (dial fails) from a
        // listening-but-never-accepting one (loopback handshake completes in
        // the backlog, so connect_timeout returns Ok).
        //
        // Linux and Windows RST a SYN to a bound, never-listened socket
        // (ConnectionRefused). macOS tcp_input drops that SYN when the matching
        // socket is bound but in TCPS_CLOSED, so the dial times out (observed
        // on rust-macos-test run 41271269599). Production revocation on macOS
        // therefore reaches Unreachable through the 2 s client timeout rather
        // than a refusal. A listening reservation still completes the loopback
        // handshake well inside the macOS probe timeout and would turn this red.
        #[cfg(target_os = "macos")]
        const RESERVATION_REFUSE_TIMEOUT: Duration = Duration::from_secs(1);
        #[cfg(not(target_os = "macos"))]
        const RESERVATION_REFUSE_TIMEOUT: Duration = Duration::from_secs(10);
        #[cfg(target_os = "macos")]
        const RESERVATION_REFUSE_KIND: std::io::ErrorKind = std::io::ErrorKind::TimedOut;
        #[cfg(not(target_os = "macos"))]
        const RESERVATION_REFUSE_KIND: std::io::ErrorKind = std::io::ErrorKind::ConnectionRefused;
        assert_eq!(
            std::net::TcpStream::connect_timeout(&addr, RESERVATION_REFUSE_TIMEOUT)
                .unwrap_err()
                .kind(),
            RESERVATION_REFUSE_KIND,
        );
        let client = Arc::new(
            reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
        );
        let services = ProdOAuthServices::with_token_urls(client, url.clone(), url);
        let token = "refused-connection-private-secret";
        let outcome = services.revoke_token(token).await;
        assert_eq!(outcome, LichessRevocationOutcome::Unreachable);
        assert_token_free_outcome(outcome, token);
        assert_held();
        drop(reservation);
    }

    #[tokio::test]
    async fn legacy_migration_verifies_identity_before_storing_an_opaque_handle() {
        let temp = tempfile::tempdir().unwrap();
        let credentials = Arc::new(crate::credentials::CredentialManager::new(Arc::new(
            crate::credentials::MemoryCredentialStore::default(),
        )));
        credentials
            .initialize(&crate::infra::path_authority::AppDataDir::for_test(
                temp.path(),
            ))
            .unwrap();
        let result = migrate_legacy_token_internal(
            "user".into(),
            "legacy-token".into(),
            credentials.clone(),
            &MockServices::new(),
        )
        .await
        .unwrap();
        assert_eq!(result.account.username, "user");
        assert!(!result.durability_uncertain);
        assert_eq!(credentials.list().unwrap(), vec![result.account]);
        assert!(!std::fs::read_to_string(
            temp.path()
                .join("credentials")
                .join("lichess-accounts.json"),
        )
        .unwrap()
        .contains("legacy-token"));
    }

    #[tokio::test]
    async fn persist_stashed_token_returns_the_stored_account() {
        let credentials = Arc::new(crate::credentials::CredentialManager::new(Arc::new(
            crate::credentials::MemoryCredentialStore::default(),
        )));
        let stash = Arc::new(std::sync::Mutex::new(Some("token".into())));
        let services = MockServices::new();

        let status =
            persist_stashed_lichess_token("user".into(), credentials.clone(), stash, &services)
                .await
                .unwrap();

        let AuthenticationStatus::Succeeded {
            account,
            durability_uncertain,
        } = status
        else {
            panic!("successful persistence must produce a successful status");
        };
        assert_eq!(account.username, "user");
        assert!(!durability_uncertain);
        assert_eq!(credentials.list().unwrap(), vec![account]);
        assert_eq!(services.revoke_calls.load(Ordering::Relaxed), 0);
        assert!(services.revoked_tokens.lock().await.is_empty());
    }

    #[tokio::test]
    async fn persist_stashed_token_rejects_a_poisoned_stash() {
        let credentials = Arc::new(crate::credentials::CredentialManager::new(Arc::new(
            crate::credentials::MemoryCredentialStore::default(),
        )));
        let stash = Arc::new(std::sync::Mutex::new(Some("token".into())));
        let stash_to_poison = stash.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = stash_to_poison.lock().unwrap();
            panic!("poison OAuth token stash");
        }));
        assert!(result.is_err());

        assert!(matches!(
            persist_stashed_lichess_token("user".into(), credentials, stash, &MockServices::new()).await,
            Err(Error::Conflict(message)) if message == "OAuth token stash was unavailable"
        ));
    }

    #[tokio::test]
    async fn persist_stashed_token_maps_uncertain_durability_to_success() {
        let temp = tempfile::tempdir().unwrap();
        let credentials = Arc::new(
            crate::credentials::CredentialManager::with_uncertain_persistence(Arc::new(
                crate::credentials::MemoryCredentialStore::default(),
            )),
        );
        credentials
            .initialize(&crate::infra::path_authority::AppDataDir::for_test(
                temp.path(),
            ))
            .unwrap();
        let stash = Arc::new(std::sync::Mutex::new(Some("token".into())));

        let services = MockServices::new();
        let status =
            persist_stashed_lichess_token("user".into(), credentials.clone(), stash, &services)
                .await
                .unwrap();

        let AuthenticationStatus::Succeeded {
            account,
            durability_uncertain,
        } = status
        else {
            panic!("uncertain persistence must remain successful");
        };
        assert!(durability_uncertain);
        assert_eq!(credentials.list().unwrap(), vec![account]);
        assert_eq!(services.revoke_calls.load(Ordering::Relaxed), 0);
        assert!(services.revoked_tokens.lock().await.is_empty());
    }

    #[tokio::test]
    async fn persist_stashed_token_revokes_on_store_error_and_preserves_the_error() {
        use LichessRevocationOutcome::*;
        for outcome in [Revoked, AlreadyInvalid, Unreachable, RateLimited, Rejected] {
            let credentials = Arc::new(crate::credentials::CredentialManager::new(Arc::new(
                RejectingCredentialStore,
            )));
            let stash = Arc::new(std::sync::Mutex::new(Some("token".into())));
            let mut services = MockServices::new();
            services.revoke_outcome = outcome;

            assert!(matches!(
                persist_stashed_lichess_token("user".into(), credentials, stash.clone(), &services)
                    .await,
                Err(Error::CredentialRecoveryRequired)
            ));
            assert!(stash.lock().unwrap().is_none());
            assert_eq!(services.revoke_calls.load(Ordering::Relaxed), 1);
            assert_eq!(*services.revoked_tokens.lock().await, vec!["token"]);
        }
    }

    #[tokio::test]
    async fn migration_rejects_identity_mismatch_without_storing_the_token() {
        let temp = tempfile::tempdir().unwrap();
        let credentials = Arc::new(crate::credentials::CredentialManager::new(Arc::new(
            crate::credentials::MemoryCredentialStore::default(),
        )));
        credentials
            .initialize(&crate::infra::path_authority::AppDataDir::for_test(
                temp.path(),
            ))
            .unwrap();
        assert!(migrate_legacy_token_internal(
            "different".into(),
            "legacy-token".into(),
            credentials.clone(),
            &MockServices::new()
        )
        .await
        .is_err());
        assert!(credentials.list().unwrap().is_empty());
    }

    #[tokio::test]
    async fn local_removal_stays_committed_for_every_provider_outcome() {
        use LichessRevocationOutcome::*;
        for outcome in [Revoked, AlreadyInvalid, Unreachable, RateLimited, Rejected] {
            let temp = tempfile::tempdir().unwrap();
            let credentials = Arc::new(crate::credentials::CredentialManager::new(Arc::new(
                crate::credentials::MemoryCredentialStore::default(),
            )));
            credentials
                .initialize(&crate::infra::path_authority::AppDataDir::for_test(
                    temp.path(),
                ))
                .unwrap();
            let account = credentials
                .store_lichess_token("user".into(), "token".into())
                .unwrap()
                .account;
            let mut services = MockServices::new();
            services.revoke_outcome = outcome;
            assert_eq!(
                remove_lichess_account_internal(
                    account.handle.clone(),
                    credentials.clone(),
                    &services
                )
                .await
                .unwrap(),
                LichessAccountRemoval::Removed {
                    revocation_pending: !matches!(outcome, Revoked | AlreadyInvalid),
                    revocation_outcome: Some(outcome),
                    durability_uncertain: false,
                }
            );
            assert!(credentials.list().unwrap().is_empty());
            assert_eq!(credentials.token(&account.handle).unwrap(), None);
            assert_eq!(services.revoke_calls.load(Ordering::Relaxed), 1);
        }
    }

    #[tokio::test]
    async fn uncertain_removal_and_revocation_pending_are_independent() {
        use LichessRevocationOutcome::*;
        for outcome in [Revoked, AlreadyInvalid, Unreachable, RateLimited, Rejected] {
            let temp = tempfile::tempdir().unwrap();
            let credentials = Arc::new(
                crate::credentials::CredentialManager::with_uncertain_persistence(Arc::new(
                    crate::credentials::MemoryCredentialStore::default(),
                )),
            );
            credentials
                .initialize(&crate::infra::path_authority::AppDataDir::for_test(
                    temp.path(),
                ))
                .unwrap();
            let account = credentials
                .store_lichess_token("user".into(), "token".into())
                .unwrap()
                .account;
            let mut services = MockServices::new();
            services.revoke_outcome = outcome;

            assert_eq!(
                remove_lichess_account_internal(account.handle, credentials.clone(), &services)
                    .await
                    .unwrap(),
                LichessAccountRemoval::Removed {
                    revocation_pending: !matches!(outcome, Revoked | AlreadyInvalid),
                    revocation_outcome: Some(outcome),
                    durability_uncertain: true,
                }
            );
            assert!(credentials.list().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn removal_without_a_local_token_does_not_claim_a_provider_attempt() {
        struct MissingTokenStore;
        impl crate::credentials::CredentialStore for MissingTokenStore {
            fn set(&self, _: &str, _: &str) -> Result<(), Error> {
                Ok(())
            }
            fn get(&self, _: &str) -> Result<Option<String>, Error> {
                Ok(None)
            }
            fn delete(&self, _: &str) -> Result<(), Error> {
                Ok(())
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let credentials = Arc::new(crate::credentials::CredentialManager::new(Arc::new(
            MissingTokenStore,
        )));
        credentials
            .initialize(&crate::infra::path_authority::AppDataDir::for_test(
                temp.path(),
            ))
            .unwrap();
        let account = credentials
            .store_lichess_token("user".into(), "token".into())
            .unwrap()
            .account;
        let services = MockServices::new();
        assert_eq!(
            remove_lichess_account_internal(account.handle, credentials.clone(), &services)
                .await
                .unwrap(),
            LichessAccountRemoval::Removed {
                revocation_pending: false,
                revocation_outcome: None,
                durability_uncertain: false,
            }
        );
        assert!(credentials.list().unwrap().is_empty());
        assert_eq!(services.revoke_calls.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn removing_an_unknown_account_does_not_revoke_a_provider_token() {
        let temp = tempfile::tempdir().unwrap();
        let credentials = Arc::new(crate::credentials::CredentialManager::new(Arc::new(
            crate::credentials::MemoryCredentialStore::default(),
        )));
        credentials
            .initialize(&crate::infra::path_authority::AppDataDir::for_test(
                temp.path(),
            ))
            .unwrap();
        let services = MockServices::new();

        assert_eq!(
            remove_lichess_account_internal(LichessAccountHandle::new(), credentials, &services)
                .await
                .unwrap(),
            LichessAccountRemoval::NotFound
        );
        assert_eq!(services.revoke_calls.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn concurrent_attempts_keep_independent_callback_transactions() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        let first_state = CsrfToken::new_random();
        let second_state = CsrfToken::new_random();
        let (first_generation, first_rx) = lifecycle.begin(first_state.clone()).await.unwrap();
        let (second_generation, second_rx) = lifecycle.begin(second_state.clone()).await.unwrap();
        assert_eq!(
            lifecycle
                .accept_callback(CallbackQuery {
                    code: Some(AuthorizationCode::new("one".into())),
                    state: Some(second_state),
                    error: None
                })
                .await,
            CallbackResult::AcceptedCode
        );
        assert!(matches!(second_rx.await, Ok(CallbackSignal::Code(_))));
        assert_eq!(
            lifecycle
                .accept_callback(CallbackQuery {
                    code: Some(AuthorizationCode::new("two".into())),
                    state: Some(first_state),
                    error: None
                })
                .await,
            CallbackResult::AcceptedCode
        );
        assert!(matches!(first_rx.await, Ok(CallbackSignal::Code(_))));
        lifecycle.clear_generation(first_generation).await;
        lifecycle.clear_generation(second_generation).await;
        assert!(lifecycle.is_idle().await);
    }

    #[tokio::test]
    async fn mismatch_does_not_consume_then_valid_callback_succeeds() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        let services = MockServices::new();
        let task = start_attempt(lifecycle.clone(), services, |_| Ok(()));
        tokio::task::yield_now().await;
        assert_eq!(
            lifecycle
                .accept_callback(CallbackQuery {
                    code: Some(AuthorizationCode::new("bad".into())),
                    state: Some(CsrfToken::new("wrong".into())),
                    error: None,
                })
                .await,
            CallbackResult::Mismatch
        );
        assert!(lifecycle.active_state().await.is_some());
        assert_eq!(
            send_valid(lifecycle.clone()).await,
            CallbackResult::AcceptedCode
        );
        assert!(task.await.expect("task join").is_ok());
    }

    #[tokio::test]
    async fn callback_without_state_is_rejected_before_transaction_lookup() {
        let lifecycle = AuthLifecycle::default();

        assert_eq!(
            lifecycle
                .accept_callback(CallbackQuery {
                    code: Some(AuthorizationCode::new("code".into())),
                    state: None,
                    error: None,
                })
                .await,
            CallbackResult::Mismatch
        );
    }

    #[tokio::test]
    async fn unknown_callback_state_reports_no_active_transaction_when_idle() {
        let lifecycle = AuthLifecycle::default();

        assert_eq!(
            lifecycle
                .accept_callback(CallbackQuery {
                    code: Some(AuthorizationCode::new("code".into())),
                    state: Some(CsrfToken::new("unknown".into())),
                    error: None,
                })
                .await,
            CallbackResult::Missing
        );
    }

    #[tokio::test]
    async fn callback_with_code_and_error_is_treated_as_rejection() {
        let lifecycle = AuthLifecycle::default();
        let state = CsrfToken::new_random();
        let (_, callback_rx) = lifecycle.begin(state.clone()).await.unwrap();

        assert_eq!(
            lifecycle
                .accept_callback(CallbackQuery {
                    code: Some(AuthorizationCode::new("code".into())),
                    state: Some(state),
                    error: Some("access_denied".into()),
                })
                .await,
            CallbackResult::AcceptedRejection
        );
        assert!(matches!(callback_rx.await, Ok(CallbackSignal::Rejected)));
    }

    #[tokio::test]
    async fn replay_fails_after_one_valid_callback() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        let task = start_attempt(lifecycle.clone(), MockServices::new(), |_| Ok(()));
        tokio::task::yield_now().await;
        let state = lifecycle
            .active_state()
            .await
            .expect("active test transaction");
        assert_eq!(
            lifecycle
                .accept_callback(CallbackQuery {
                    code: Some(AuthorizationCode::new("code".into())),
                    state: Some(state.clone()),
                    error: None,
                })
                .await,
            CallbackResult::AcceptedCode
        );
        let (next_generation, next_rx) = lifecycle.begin(CsrfToken::new_random()).await.unwrap();
        assert_eq!(
            lifecycle
                .accept_callback(CallbackQuery {
                    code: Some(AuthorizationCode::new("replay".into())),
                    state: Some(state),
                    error: None,
                })
                .await,
            CallbackResult::Closed
        );
        assert!(task.await.expect("task join").is_ok());
        lifecycle.clear_generation(next_generation).await;
        drop(next_rx);
    }

    #[tokio::test]
    async fn timeout_returns_generic_error_and_cleans_up() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        let services = MockServices::new();
        let task = start_attempt_with_config(
            lifecycle.clone(),
            services.clone(),
            |_| Ok(()),
            short_config(),
        );
        let result = task.await.expect("task join");
        assert!(matches!(result, Err(Error::OAuthFailure(message)) if message == OAUTH_FAILURE));
        assert!(lifecycle.is_idle().await);
        assert!(services.listener_stopped.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn provider_denial_with_matching_state_is_terminal_and_cleans_up() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        let services = MockServices::new();
        let task = start_attempt(lifecycle.clone(), services.clone(), |_| Ok(()));
        tokio::task::yield_now().await;
        let state = lifecycle
            .active_state()
            .await
            .expect("active test transaction");
        let uri: Uri = format!("/callback?error=access_denied&state={}", state.secret())
            .parse()
            .expect("valid callback URI");
        let Query(query) = Query::<CallbackQuery>::try_from_uri(&uri)
            .expect("provider denial query is accepted by Axum");
        assert_eq!(
            lifecycle.accept_callback(query).await,
            CallbackResult::AcceptedRejection
        );
        assert!(
            matches!(task.await.expect("task join"), Err(Error::OAuthFailure(message)) if message == OAUTH_FAILURE)
        );
        assert!(lifecycle.is_idle().await);
        assert!(services.listener_stopped.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn empty_callback_with_matching_state_is_rendered_as_rejection() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        let services = MockServices::new();
        let task = start_attempt(lifecycle.clone(), services.clone(), |_| Ok(()));
        tokio::task::yield_now().await;
        let state = lifecycle
            .active_state()
            .await
            .expect("active test transaction");
        let result = lifecycle
            .accept_callback(CallbackQuery {
                code: None,
                state: Some(state),
                error: None,
            })
            .await;
        assert_eq!(result, CallbackResult::AcceptedRejection);
        assert_eq!(
            callback_page(result).0,
            "Authentication was cancelled or denied."
        );
        assert!(
            matches!(task.await.expect("task join"), Err(Error::OAuthFailure(message)) if message == OAUTH_FAILURE)
        );
        assert!(lifecycle.is_idle().await);
        assert!(services.listener_stopped.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn deadline_cancels_pending_exchange_and_cleans_up() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        let mut services = MockServices::new();
        services.exchange_pending = true;
        let task = start_attempt_with_config(
            lifecycle.clone(),
            services.clone(),
            |_| Ok(()),
            deadline_config(),
        );
        tokio::task::yield_now().await;
        assert_eq!(
            send_valid(lifecycle.clone()).await,
            CallbackResult::AcceptedCode
        );
        assert!(tokio::time::timeout(Duration::from_millis(50), async {
            while !services.exchange_started.load(Ordering::Relaxed) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .is_ok());
        let result = tokio::time::timeout(Duration::from_millis(200), task)
            .await
            .expect("transaction deadline");
        assert!(
            matches!(result.expect("task join"), Err(Error::OAuthFailure(message)) if message == OAUTH_FAILURE)
        );
        assert!(lifecycle.is_idle().await);
        assert!(services.listener_stopped.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn deadline_aborts_listener_that_ignores_shutdown() {
        // The 100 ms watchdog runs in paused (virtual) time, so wall-clock delay
        // cannot trip it: the blocking SIMULATED_RUNNER_STALL below stands in for a
        // loaded runner and fails the test only if the clock is not paused.
        // What still overruns the bound is virtual time: a shutdown that waited the
        // full LISTENER_DRAIN_TIMEOUT (1 s) instead of the remaining 20 ms
        // short_config deadline.
        tokio::time::pause();
        const SIMULATED_RUNNER_STALL: Duration = Duration::from_millis(150);
        let lifecycle = Arc::new(AuthLifecycle::default());
        let mut services = MockServices::new();
        services.listener_ignores_shutdown = true;
        let task = start_attempt_with_config(
            lifecycle.clone(),
            services.clone(),
            |_| Ok(()),
            short_config(),
        );
        let watchdog = tokio::time::timeout(Duration::from_millis(100), task);
        std::thread::sleep(SIMULATED_RUNNER_STALL);
        let result = watchdog.await.expect("bounded listener shutdown");
        assert!(
            matches!(result.expect("task join"), Err(Error::OAuthFailure(message)) if message == OAUTH_FAILURE)
        );
        assert!(lifecycle.is_idle().await);
        assert!(services.listener_aborted.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn token_endpoint_failure_cleans_up() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        let mut services = MockServices::new();
        services.exchange_error = Some("token endpoint unavailable".into());
        let task = start_attempt(lifecycle.clone(), services.clone(), |_| Ok(()));
        tokio::task::yield_now().await;
        assert_eq!(
            send_valid(lifecycle.clone()).await,
            CallbackResult::AcceptedCode
        );
        assert!(
            matches!(task.await.expect("task join"), Err(Error::OAuthFailure(message)) if message == OAUTH_FAILURE)
        );
        assert!(lifecycle.is_idle().await);
        assert!(services.listener_stopped.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn identity_mismatch_revokes_token_and_returns_generic_error() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        let mut services = MockServices::new();
        services.verified_username = "different-user".into();
        let task = start_attempt(lifecycle.clone(), services.clone(), |_| Ok(()));
        tokio::task::yield_now().await;
        assert_eq!(
            send_valid(lifecycle.clone()).await,
            CallbackResult::AcceptedCode
        );
        assert!(
            matches!(task.await.expect("task join"), Err(Error::OAuthFailure(message)) if message == OAUTH_FAILURE)
        );
        assert_eq!(services.revoke_calls.load(Ordering::Relaxed), 1);
        assert_eq!(*services.revoked_tokens.lock().await, vec!["token"]);
    }

    #[tokio::test]
    async fn verification_timeout_revokes_token_and_returns_generic_error() {
        tokio::time::pause();
        let lifecycle = Arc::new(AuthLifecycle::default());
        let mut services = MockServices::new();
        services.verify_delay = Some(Duration::from_secs(2));
        let task = start_attempt(lifecycle.clone(), services.clone(), |_| Ok(()));
        tokio::task::yield_now().await;
        assert_eq!(
            send_valid(lifecycle.clone()).await,
            CallbackResult::AcceptedCode
        );
        assert!(
            matches!(task.await.expect("task join"), Err(Error::OAuthFailure(message)) if message == OAUTH_FAILURE)
        );
        assert!(services.exchange_started.load(Ordering::Relaxed));
        assert_eq!(services.revoke_calls.load(Ordering::Relaxed), 1);
        assert_eq!(*services.revoked_tokens.lock().await, vec!["token"]);
        assert!(lifecycle.is_idle().await);
    }

    #[tokio::test]
    async fn verification_failure_revokes_token_and_returns_generic_error() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        let mut services = MockServices::new();
        services.verify_error = Some("identity endpoint unavailable".into());
        services.revoke_outcome = LichessRevocationOutcome::Unreachable;
        let task = start_attempt(lifecycle.clone(), services.clone(), |_| Ok(()));
        tokio::task::yield_now().await;
        assert_eq!(send_valid(lifecycle).await, CallbackResult::AcceptedCode);
        assert!(
            matches!(task.await.expect("task join"), Err(Error::OAuthFailure(message)) if message == OAUTH_FAILURE)
        );
        assert_eq!(services.revoke_calls.load(Ordering::Relaxed), 1);
        assert_eq!(*services.revoked_tokens.lock().await, vec!["token"]);
    }

    #[tokio::test]
    async fn event_failure_cleans_up_without_broadcast() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        let services = MockServices::new();
        let task = start_attempt(lifecycle.clone(), services.clone(), |_| {
            Err("event sink failed".into())
        });
        tokio::task::yield_now().await;
        assert_eq!(
            send_valid(lifecycle.clone()).await,
            CallbackResult::AcceptedCode
        );
        assert!(
            matches!(task.await.expect("task join"), Err(Error::OAuthFailure(message)) if message == OAUTH_FAILURE)
        );
        assert!(lifecycle.is_idle().await);
        assert!(services.listener_stopped.load(Ordering::Relaxed));
        assert_eq!(services.revoke_calls.load(Ordering::Relaxed), 1);
        assert_eq!(*services.revoked_tokens.lock().await, vec!["token"]);
    }

    #[tokio::test]
    async fn success_delivers_token_once_and_cleans_up() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        let deliveries = Arc::new(AtomicUsize::new(0));
        let delivered = deliveries.clone();
        let services = MockServices::new();
        let task = start_attempt(lifecycle.clone(), services.clone(), move |token| {
            assert_eq!(token, "token");
            delivered.fetch_add(1, Ordering::Relaxed);
            Ok(())
        });
        tokio::task::yield_now().await;
        assert_eq!(
            send_valid(lifecycle.clone()).await,
            CallbackResult::AcceptedCode
        );
        assert!(task.await.expect("task join").is_ok());
        assert_eq!(deliveries.load(Ordering::Relaxed), 1);
        assert_eq!(services.revoke_calls.load(Ordering::Relaxed), 0);
        assert!(services.revoked_tokens.lock().await.is_empty());
        assert!(lifecycle.is_idle().await);
        assert!(services.listener_stopped.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn server_failure_cleans_state() {
        let lifecycle = Arc::new(AuthLifecycle::default());
        let mut services = MockServices::new();
        services.server_error = true;
        let result = authenticate_internal(
            "user".into(),
            lifecycle.clone(),
            |_| Ok(()),
            |_| Ok(()),
            config(),
            services,
        )
        .await;
        assert!(matches!(result, Err(Error::OAuthFailure(message)) if message == OAUTH_FAILURE));
        assert!(lifecycle.is_idle().await);
    }
}
