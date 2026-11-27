//! Sign in with Grok: the device-code flow of xAI's own command-line client.
//!
//! xAI documents no sign-in for other apps, so this connection is labelled unofficial in the UI
//! and may stop working. The user gets a short code and a page at the provider; this side asks
//! the token endpoint at the provider's pace until the user has approved, declined or run out of
//! time. Nothing is stored before the whole sign-in has succeeded.
//!
//! The provider names its endpoints itself, in its discovery document. None of them, and no link
//! handed to the browser, is used unless it is a plain `https` address on `x.ai` or below it; the
//! stored token endpoint is checked again before every use.
//!
//! Bodies of the authentication endpoints are never logged: a failure is logged by its status and
//! the provider's error code only.

use std::{
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::{
    accounts::{Accounts, SignInProvider},
    attempts::{self, SignInAttempts, SignInKind},
    chatgpt::{display_email, error_code, id_token_claims, BrowserOpener},
    connections::{ConnectionSaved, Connections, GrokSecret},
    error::CoachError,
    http::{browser_link, send_bounded, timed_out},
};
use crate::infra::token_session::{IssuedTokens, RefreshError};

/// The public client of xAI's command-line tool. It has no secret.
pub(crate) const CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE: &str = "openid profile email offline_access grok-cli:access api:access";
const DISCOVERY_URL: &str = "https://auth.x.ai/.well-known/openid-configuration";
/// The API the tokens are for, without a trailing slash.
const API: &str = "https://api.x.ai/v1";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// Seconds between two questions to the token endpoint when the provider names none.
const DEFAULT_INTERVAL: u64 = 5;
const MIN_INTERVAL: u64 = 1;
const MAX_INTERVAL: u64 = 30;
/// What the provider's `slow_down` adds to the interval.
const SLOW_DOWN_STEP: u64 = 5;
/// A sign-in is not waited for longer than this, whatever lifetime the code has (15 minutes).
const MAX_WAIT_SECONDS: u64 = 15 * 60;
/// A removal does not wait longer than this for the provider to confirm the revocation.
const REVOKE_TIMEOUT: Duration = Duration::from_secs(10);
/// An access token whose lifetime the provider did not tell is taken as short-lived.
const ASSUMED_EXPIRY_SECONDS: u64 = 10 * 60;
const MAX_EXPIRES_IN_SECONDS: u64 = 24 * 60 * 60;
const MAX_DISCOVERY_BYTES: usize = 64 * 1024;
const MAX_DEVICE_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_TOKEN_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_TOKEN_BYTES: usize = 16 * 1024;
const MAX_DEVICE_CODE_BYTES: usize = 2048;
const MAX_USER_CODE_CHARS: usize = 32;
const MAX_ADDRESS_BYTES: usize = 2048;

/// An address the provider may name: plain `https` on `x.ai` or below it.
fn official(value: &str) -> Option<url::Url> {
    browser_link(value, |host| host == "x.ai" || host.ends_with(".x.ai"))
}

/// The provider's endpoints, as its discovery document names them.
#[derive(Deserialize)]
struct Discovery {
    device_authorization_endpoint: String,
    token_endpoint: String,
    #[serde(default)]
    revocation_endpoint: Option<String>,
}

#[derive(Deserialize)]
struct DeviceResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    verification_uri_complete: Option<String>,
    expires_in: u64,
    #[serde(default)]
    interval: Option<u64>,
}

/// The token endpoint's answer. No `Debug`: it carries the tokens.
#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
}

impl TokenResponse {
    fn parse(body: &[u8]) -> Option<Self> {
        let bounded = |token: &str| !token.is_empty() && token.len() <= MAX_TOKEN_BYTES;
        serde_json::from_slice::<Self>(body).ok().filter(|tokens| {
            bounded(&tokens.access_token)
                && tokens.refresh_token.as_deref().is_none_or(bounded)
                && tokens.expires_in != Some(0)
                && tokens
                    .token_type
                    .as_deref()
                    .is_none_or(|kind| kind.eq_ignore_ascii_case("bearer"))
        })
    }

    /// The tokens for their owner. `refresh` is the one in use, kept when the answer names no
    /// new one.
    fn issued(self, refresh: Option<&str>) -> Option<IssuedTokens> {
        let seconds = self
            .expires_in
            .unwrap_or(ASSUMED_EXPIRY_SECONDS)
            .min(MAX_EXPIRES_IN_SECONDS);
        Some(IssuedTokens {
            access: self.access_token,
            refresh: self.refresh_token.or_else(|| refresh.map(str::to_owned))?,
            expires_in: Duration::from_secs(seconds),
        })
    }
}

/// A started sign-in: the code to ask the token endpoint with. No `Debug`: the device code is a
/// secret until the sign-in is over.
pub(crate) struct DeviceCode {
    device_code: String,
    token_endpoint: String,
    /// The page with the code filled in where the provider offers one; this is what is opened.
    browser_link: String,
    interval: u64,
    shown: GrokCode,
}

/// What the user needs to finish a Grok sign-in in the browser.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrokCode {
    pub user_code: String,
    /// The provider's page where the code is entered.
    pub verification_url: String,
    pub expires_in_seconds: u32,
}

fn clamped_interval(interval: Option<u64>) -> u64 {
    interval
        .unwrap_or(DEFAULT_INTERVAL)
        .clamp(MIN_INTERVAL, MAX_INTERVAL)
}

/// What the token endpoint said about a sign-in that is not yet granted.
#[derive(Debug, PartialEq, Eq)]
enum Pending {
    /// Ask again after this many seconds.
    Wait(u64),
    /// The sign-in is over without a grant.
    Ended,
}

/// Reads a refusal of the token endpoint during the wait. Only the two codes the flow defines
/// keep it going; a declined or expired code and everything else end it.
fn pending(code: Option<&str>, interval: u64) -> Pending {
    match code {
        Some("authorization_pending") => Pending::Wait(interval),
        Some("slow_down") => Pending::Wait((interval + SLOW_DOWN_STEP).min(MAX_INTERVAL)),
        _ => Pending::Ended,
    }
}

pub(crate) struct Grok {
    http: reqwest::Client,
    discovery: String,
    api: String,
    /// Which addresses the provider may name for its endpoints and for the browser.
    own: fn(&str) -> Option<url::Url>,
    /// How long one second of the wait lasts. Tests shorten it.
    second: Duration,
}

impl Grok {
    pub(crate) fn new(http: reqwest::Client) -> Self {
        Self {
            http,
            discovery: DISCOVERY_URL.into(),
            api: API.into(),
            own: official,
            second: Duration::from_secs(1),
        }
    }

    pub(crate) fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// The address of an API endpoint the tokens are for.
    pub(crate) fn api(&self, path: &str) -> String {
        format!("{}/{path}", self.api)
    }

    /// `value` if the provider may name it, as the URL parser read it: what was checked is what
    /// is used, not the text it was parsed from.
    fn own_address(&self, value: &str, what: &str) -> Result<String, CoachError> {
        let checked = (value.len() <= MAX_ADDRESS_BYTES)
            .then(|| (self.own)(value))
            .flatten();
        match checked {
            Some(url) => Ok(url.into()),
            None => {
                log::error!("coach: Grok named {what} that is not its own; it was not used");
                Err(CoachError::ProviderFailure)
            }
        }
    }

    async fn discover(&self) -> Result<Discovery, CoachError> {
        let request = self
            .http
            .get(&self.discovery)
            .header(reqwest::header::ACCEPT, "application/json");
        let (status, body) = send_bounded(request, MAX_DISCOVERY_BYTES).await?;
        if status != 200 {
            log::warn!("coach: Grok's discovery document answered HTTP {status}");
            return Err(match status {
                429 => CoachError::RateLimited,
                status if timed_out(status) => CoachError::ProviderTimeout,
                _ => CoachError::ProviderFailure,
            });
        }
        let mut discovery: Discovery =
            serde_json::from_slice(&body).map_err(|_| CoachError::ProviderFailure)?;
        discovery.device_authorization_endpoint = self.own_address(
            &discovery.device_authorization_endpoint,
            "a device authorization endpoint",
        )?;
        discovery.token_endpoint =
            self.own_address(&discovery.token_endpoint, "a token endpoint")?;
        // A revocation endpoint that cannot be used is the same as none: removal says so.
        discovery.revocation_endpoint = discovery
            .revocation_endpoint
            .and_then(|endpoint| self.own_address(&endpoint, "a revocation endpoint").ok());
        Ok(discovery)
    }

    /// Starts a sign-in: asks the provider for a code.
    pub(crate) async fn request_code(&self) -> Result<DeviceCode, CoachError> {
        let discovery = self.discover().await?;
        let request = self
            .http
            .post(&discovery.device_authorization_endpoint)
            .header(reqwest::header::ACCEPT, "application/json")
            .form(&[("client_id", CLIENT_ID), ("scope", SCOPE)]);
        let (status, body) = send_bounded(request, MAX_DEVICE_RESPONSE_BYTES).await?;
        if status != 200 {
            let code = error_code(&body).unwrap_or_else(|| "unknown".into());
            log::warn!("coach: Grok's device endpoint answered HTTP {status}: {code}");
            return Err(match status {
                429 => CoachError::RateLimited,
                403 => CoachError::SubscriptionNotEligible,
                status if timed_out(status) => CoachError::ProviderTimeout,
                _ => CoachError::ProviderFailure,
            });
        }
        let device: DeviceResponse =
            serde_json::from_slice(&body).map_err(|_| CoachError::ProviderFailure)?;
        let user_code_plain = !device.user_code.is_empty()
            && device.user_code.chars().count() <= MAX_USER_CODE_CHARS
            && device
                .user_code
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-');
        if device.device_code.is_empty()
            || device.device_code.len() > MAX_DEVICE_CODE_BYTES
            || !user_code_plain
            || device.expires_in == 0
        {
            return Err(CoachError::ProviderFailure);
        }
        let verification_url = self.own_address(&device.verification_uri, "a sign-in page")?;
        let browser_link = match &device.verification_uri_complete {
            Some(complete) => self.own_address(complete, "a sign-in page")?,
            None => verification_url.clone(),
        };
        let wait = device.expires_in.min(MAX_WAIT_SECONDS);
        Ok(DeviceCode {
            device_code: device.device_code,
            token_endpoint: discovery.token_endpoint,
            browser_link,
            interval: clamped_interval(device.interval),
            shown: GrokCode {
                user_code: device.user_code,
                verification_url,
                expires_in_seconds: u32::try_from(wait).unwrap_or(u32::MAX),
            },
        })
    }

    /// Asks the token endpoint until the user has approved the code, declined it, or run out of
    /// time. Network failures, timeouts and an overloaded provider are waited out.
    async fn wait_for_grant(&self, code: &DeviceCode) -> Result<TokenResponse, CoachError> {
        let form = [
            ("grant_type", DEVICE_GRANT),
            ("client_id", CLIENT_ID),
            ("device_code", code.device_code.as_str()),
        ];
        let mut interval = code.interval;
        loop {
            let seconds = u32::try_from(interval).unwrap_or(u32::MAX);
            tokio::time::sleep(self.second.saturating_mul(seconds)).await;
            let request = self
                .http
                .post(&code.token_endpoint)
                .header(reqwest::header::ACCEPT, "application/json")
                .form(&form);
            let (status, body) = match send_bounded(request, MAX_TOKEN_RESPONSE_BYTES).await {
                Ok(answer) => answer,
                Err(CoachError::Network | CoachError::ProviderTimeout) => continue,
                Err(error) => return Err(error),
            };
            match status {
                200 => return TokenResponse::parse(&body).ok_or(CoachError::ProviderFailure),
                408 | 429 | 500..=599 => {}
                _ => {
                    let said = error_code(&body);
                    match pending(said.as_deref(), interval) {
                        Pending::Wait(next) => interval = next,
                        Pending::Ended => {
                            log::warn!(
                                "coach: the Grok sign-in ended with HTTP {status}: {}",
                                said.as_deref().unwrap_or("unknown")
                            );
                            return Err(CoachError::SignInFailed);
                        }
                    }
                }
            }
        }
    }

    /// Waits for the user and stores the sign-in as the Grok connection. On success the
    /// connection is returned with the tokens that came with it; the caller hands those to the
    /// connection's token owner.
    pub(crate) async fn complete(
        &self,
        code: &DeviceCode,
        connections: &Connections,
        cancellation: &CancellationToken,
    ) -> Result<(ConnectionSaved, SignInProvider, IssuedTokens), CoachError> {
        let wait = self.second.saturating_mul(code.shown.expires_in_seconds);
        let tokens = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(CoachError::Cancelled),
            granted = tokio::time::timeout(wait, self.wait_for_grant(code)) => {
                // A code nobody approved in its lifetime is a sign-in that was not completed.
                granted.map_err(|_| CoachError::SignInFailed)??
            }
        };
        let email = tokens
            .id_token
            .as_deref()
            .and_then(id_token_claims)
            .as_ref()
            .and_then(display_email);
        // Without a refresh token the sign-in would end with its first access token.
        let issued = tokens.issued(None).ok_or(CoachError::SignInFailed)?;
        let saved = connections
            .save_grok(GrokSecret {
                token_endpoint: code.token_endpoint.clone(),
                refresh_token: Some(issued.refresh.clone()),
                email,
            })
            .await?;
        let provider = SignInProvider::Grok {
            token_endpoint: code.token_endpoint.clone(),
        };
        Ok((saved, provider, issued))
    }

    /// Exchanges a refresh token at the endpoint stored with the sign-in. The provider rotates
    /// the token; an answer that names no new one keeps the one in use.
    pub(crate) async fn refresh(
        &self,
        token_endpoint: &str,
        refresh: &str,
    ) -> Result<IssuedTokens, RefreshError<CoachError>> {
        let endpoint = self
            .own_address(token_endpoint, "a stored token endpoint")
            .map_err(RefreshError::Other)?;
        let request = self
            .http
            .post(endpoint)
            .header(reqwest::header::ACCEPT, "application/json")
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", CLIENT_ID),
                ("refresh_token", refresh),
            ]);
        let (status, body) = send_bounded(request, MAX_TOKEN_RESPONSE_BYTES)
            .await
            .map_err(RefreshError::Other)?;
        if status == 200 {
            return TokenResponse::parse(&body)
                .and_then(|tokens| tokens.issued(Some(refresh)))
                .ok_or(RefreshError::Other(CoachError::ProviderFailure));
        }
        let code = error_code(&body).unwrap_or_else(|| "unknown".into());
        log::warn!("coach: Grok's token endpoint refused a refresh with HTTP {status}: {code}");
        Err(match status {
            400 | 401 => RefreshError::Terminal,
            // Signed in, but this subscription may not be used from other apps.
            403 => RefreshError::Other(CoachError::SubscriptionNotEligible),
            429 => RefreshError::Other(CoachError::RateLimited),
            status if timed_out(status) => RefreshError::Other(CoachError::ProviderTimeout),
            _ => RefreshError::Other(CoachError::ProviderFailure),
        })
    }

    /// Withdraws a sign-in at the provider. `true` only when the provider confirmed it.
    pub(crate) async fn revoke(&self, refresh: &str) -> bool {
        let revoked = async {
            let endpoint = self.discover().await.ok()?.revocation_endpoint?;
            let form = [
                ("token", refresh),
                ("token_type_hint", "refresh_token"),
                ("client_id", CLIENT_ID),
            ];
            let response = self.http.post(endpoint).form(&form).send().await.ok()?;
            (response.status().as_u16() == 200).then_some(())
        };
        matches!(
            tokio::time::timeout(REVOKE_TIMEOUT, revoked).await,
            Ok(Some(()))
        )
    }
}

type SignInResult = Result<ConnectionSaved, CoachError>;

/// A Grok sign-in between its two commands: the one whose result nobody has fetched yet. A later
/// sign-in takes its place.
#[derive(Default)]
pub(crate) struct PendingSignIn(Mutex<Option<(String, oneshot::Receiver<SignInResult>)>>);

impl PendingSignIn {
    fn set(&self, attempt: &str, result: oneshot::Receiver<SignInResult>) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some((attempt.to_owned(), result));
    }

    /// The result of the sign-in with this id, once it is over. A sign-in that is unknown, was
    /// replaced, or whose result was already fetched is `cancelled`.
    pub(crate) async fn finish(&self, attempt: &str) -> SignInResult {
        let result = {
            let mut pending = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            match pending.take() {
                Some((id, result)) if id == attempt => result,
                other => {
                    *pending = other;
                    return Err(CoachError::Cancelled);
                }
            }
        };
        result.await.unwrap_or(Err(CoachError::Cancelled))
    }
}

/// What a Grok sign-in runs with; all of it outlives the command that started it.
#[derive(Clone)]
pub(crate) struct SignIn {
    pub grok: Arc<Grok>,
    pub connections: Connections,
    pub accounts: Accounts,
    pub attempts: Arc<SignInAttempts>,
    pub pending: Arc<PendingSignIn>,
}

impl SignIn {
    /// Starts a sign-in as the one attempt of its kind and returns the code for the user as soon
    /// as the provider issued it. The sign-in then goes on in a task of its own, until the user
    /// is done, the code runs out, or the attempt is cancelled; [`PendingSignIn::finish`] hands
    /// out its result.
    pub(crate) async fn begin(
        self,
        attempt: String,
        window: String,
        opener: BrowserOpener,
    ) -> Result<GrokCode, CoachError> {
        if !attempts::valid_id(&attempt) {
            return Err(CoachError::InvalidInput);
        }
        let (started, code) = oneshot::channel::<Result<GrokCode, CoachError>>();
        let (finished, result) = oneshot::channel::<SignInResult>();
        tauri::async_runtime::spawn(async move {
            let SignIn {
                grok,
                connections,
                accounts,
                attempts,
                pending,
            } = self;
            let id = attempt.clone();
            let outcome = attempts
                .run(
                    SignInKind::Grok,
                    &attempt,
                    &window,
                    |cancellation| async move {
                        let code = tokio::select! {
                            biased;
                            () = cancellation.cancelled() => Err(CoachError::Cancelled),
                            code = grok.request_code() => code,
                        };
                        let code = match code {
                            Ok(code) => code,
                            Err(error) => {
                                let _ = started.send(Err(error));
                                return Err(error);
                            }
                        };
                        // From here on the result has a place to be fetched from.
                        pending.set(&id, result);
                        let _ = started.send(Ok(code.shown.clone()));
                        // The user can also open the page by hand: the code and its address are shown.
                        if opener(&code.browser_link).is_err() {
                            log::warn!(
                                "coach: the Grok sign-in page was not opened in the browser"
                            );
                        }
                        let (saved, provider, tokens) =
                            grok.complete(&code, &connections, &cancellation).await?;
                        accounts
                            .signed_in(saved.connection.handle.clone(), provider, tokens)
                            .await?;
                        Ok(saved)
                    },
                )
                .await;
            // Nobody may be waiting: the result of a sign-in that was replaced is dropped.
            let _ = finished.send(outcome);
        });
        // The task ended before it could say anything: it was replaced or the app is closing.
        code.await.unwrap_or(Err(CoachError::Cancelled))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        coach::{
            chatgpt::tests::id_token,
            connections::{ConnectionKind, ConnectionStatus},
            test_server::{self, TestServer},
        },
        credentials::{CoachCredentials, MemoryCredentialStore},
    };
    use axum::{extract::Form, http::StatusCode, routing::get, routing::post, Json, Router};
    use serde_json::{json, Value};
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::Ordering::SeqCst;

    /// The test rule for the provider's own addresses: the loopback double.
    fn loopback(value: &str) -> Option<url::Url> {
        url::Url::parse(value)
            .ok()
            .filter(|url| url.host_str() == Some("127.0.0.1"))
    }

    /// A Grok whose provider is `server`, with seconds that last two milliseconds.
    pub(crate) fn grok(server: &TestServer) -> Grok {
        Grok {
            // Short enough that a stalled poll ends in a test's time, long for a loopback answer.
            http: reqwest::Client::builder()
                .no_proxy()
                .read_timeout(Duration::from_millis(500))
                .build()
                .unwrap(),
            discovery: server.url("/.well-known/openid-configuration"),
            api: server.url("/v1"),
            own: loopback,
            second: Duration::from_millis(2),
        }
    }

    type Forms = Arc<Mutex<Vec<HashMap<String, String>>>>;
    type Answers = Arc<Mutex<VecDeque<(StatusCode, Value)>>>;

    /// The provider double: discovery, the device endpoint and a token endpoint that answers
    /// from a queue (its last answer is repeated).
    struct Double {
        server: TestServer,
        discovery: Arc<Mutex<Value>>,
        discovery_status: Arc<Mutex<StatusCode>>,
        device: Arc<Mutex<(StatusCode, Value)>>,
        /// Token requests still to be held without an answer past the client's read timeout.
        stalls: Arc<std::sync::atomic::AtomicUsize>,
        device_forms: Forms,
        token: Answers,
        token_forms: Forms,
        revocations: Forms,
    }

    fn next(answers: &Answers) -> (StatusCode, Value) {
        let mut answers = answers.lock().unwrap();
        if answers.len() > 1 {
            answers.pop_front().unwrap()
        } else {
            answers
                .front()
                .cloned()
                .unwrap_or((StatusCode::INTERNAL_SERVER_ERROR, Value::Null))
        }
    }

    fn pending_answer(code: &str) -> (StatusCode, Value) {
        (StatusCode::BAD_REQUEST, json!({ "error": code }))
    }

    fn granted(n: u32, email: Option<&str>) -> (StatusCode, Value) {
        (
            StatusCode::OK,
            json!({
                "access_token": format!("grok-access-{n}"),
                "refresh_token": format!("grok-refresh-{n}"),
                "token_type": "Bearer",
                "expires_in": 3600,
                "id_token": email.map(|email| id_token(json!({ "email": email }))),
            }),
        )
    }

    impl Double {
        fn start() -> Self {
            let discovery = Arc::new(Mutex::new(Value::Null));
            let discovery_status = Arc::new(Mutex::new(StatusCode::OK));
            let device = Arc::new(Mutex::new((StatusCode::OK, Value::Null)));
            let stalls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let (device_forms, token_forms, revocations) =
                (Forms::default(), Forms::default(), Forms::default());
            let token = Answers::default();
            let router = Router::new()
                .route(
                    "/.well-known/openid-configuration",
                    get({
                        let (discovery, status) = (discovery.clone(), discovery_status.clone());
                        move || async move {
                            let status = *status.lock().unwrap();
                            (status, Json(discovery.lock().unwrap().clone()))
                        }
                    }),
                )
                .route(
                    "/device",
                    post({
                        let (forms, device) = (device_forms.clone(), device.clone());
                        move |Form(form): Form<HashMap<String, String>>| async move {
                            forms.lock().unwrap().push(form);
                            let (status, body) = device.lock().unwrap().clone();
                            (status, Json(body))
                        }
                    }),
                )
                .route(
                    "/token",
                    post({
                        let (forms, token, stalls) =
                            (token_forms.clone(), token.clone(), stalls.clone());
                        move |Form(form): Form<HashMap<String, String>>| async move {
                            forms.lock().unwrap().push(form);
                            let stall = stalls
                                .fetch_update(SeqCst, SeqCst, |left| left.checked_sub(1))
                                .is_ok();
                            if stall {
                                tokio::time::sleep(Duration::from_secs(3)).await;
                            }
                            let (status, body) = next(&token);
                            (status, Json(body))
                        }
                    }),
                )
                .route(
                    "/revoke",
                    post({
                        let revocations = revocations.clone();
                        move |Form(form): Form<HashMap<String, String>>| async move {
                            revocations.lock().unwrap().push(form);
                            StatusCode::OK
                        }
                    }),
                );
            let server = test_server::serve(router);
            *discovery.lock().unwrap() = json!({
                "issuer": "https://auth.x.ai",
                "device_authorization_endpoint": server.url("/device"),
                "token_endpoint": server.url("/token"),
                "revocation_endpoint": server.url("/revoke"),
            });
            *device.lock().unwrap() = (
                StatusCode::OK,
                json!({
                    "device_code": "the-device-code",
                    "user_code": "ABCD-1234",
                    "verification_uri": server.url("/activate"),
                    "verification_uri_complete": server.url("/activate?user_code=ABCD-1234"),
                    "expires_in": 600,
                    "interval": 1,
                }),
            );
            Self {
                server,
                discovery,
                discovery_status,
                device,
                stalls,
                device_forms,
                token,
                token_forms,
                revocations,
            }
        }

        fn answers(&self, answers: impl IntoIterator<Item = (StatusCode, Value)>) {
            *self.token.lock().unwrap() = answers.into_iter().collect();
        }

        /// Queues `answers` behind the current ones; the current last answer is then served
        /// once more before them, because it is no longer the last.
        fn then(&self, answers: impl IntoIterator<Item = (StatusCode, Value)>) {
            self.token.lock().unwrap().extend(answers);
        }

        /// How many queued answers are left behind the one being repeated.
        fn unanswered(&self) -> usize {
            self.token.lock().unwrap().len().saturating_sub(1)
        }

        /// Waits, bounded, until the token endpoint has been asked `count` times, and returns
        /// how often it has been asked by then.
        async fn wait_for_polls(&self, count: usize) -> usize {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let polls = self.polls();
                    if polls >= count {
                        return polls;
                    }
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            })
            .await
            .expect("the sign-in polls")
        }

        fn device_field(&self, name: &str, value: Value) {
            self.device.lock().unwrap().1[name] = value;
        }

        fn polls(&self) -> usize {
            self.token_forms.lock().unwrap().len()
        }
    }

    struct Fixture {
        double: Double,
        sign_in: SignIn,
        opened: Arc<Mutex<Vec<String>>>,
        _directory: tempfile::TempDir,
    }

    fn fixture() -> Fixture {
        let double = Double::start();
        let store = Arc::new(MemoryCredentialStore::default());
        let (credentials, directory) = CoachCredentials::for_test(store);
        let connections = Connections::new(Arc::new(credentials));
        let grok = Arc::new(grok(&double.server));
        let chatgpt = Arc::new(crate::coach::chatgpt::ChatGpt::new(
            reqwest::Client::builder().no_proxy().build().unwrap(),
        ));
        let sign_in = SignIn {
            accounts: Accounts::start(connections.clone(), chatgpt, grok.clone()),
            grok,
            connections,
            attempts: Arc::default(),
            pending: Arc::default(),
        };
        Fixture {
            double,
            sign_in,
            opened: Arc::default(),
            _directory: directory,
        }
    }

    impl Fixture {
        fn opener(&self) -> BrowserOpener {
            let opened = self.opened.clone();
            Arc::new(move |url: &str| {
                opened.lock().unwrap().push(url.to_owned());
                Ok(())
            })
        }

        async fn begin(&self, attempt: &str) -> Result<GrokCode, CoachError> {
            self.sign_in
                .clone()
                .begin(attempt.into(), "main".into(), self.opener())
                .await
        }

        async fn finish(&self, attempt: &str) -> SignInResult {
            tokio::time::timeout(
                Duration::from_secs(10),
                self.sign_in.pending.finish(attempt),
            )
            .await
            .expect("the sign-in ends")
        }

        async fn idle(&self) {
            tokio::time::timeout(Duration::from_secs(10), async {
                while !self.sign_in.attempts.is_idle() {
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            })
            .await
            .expect("the attempt leaves the holder");
        }

        /// How many connections exist.
        async fn stored(&self) -> usize {
            self.sign_in.connections.list().await.unwrap().len()
        }
    }

    #[test]
    fn only_plain_https_addresses_on_the_providers_domain_are_its_own() {
        for accepted in [
            "https://auth.x.ai/oauth2/token",
            "https://x.ai/device",
            "https://accounts.x.ai/device?user_code=ABCD",
        ] {
            assert!(official(accepted).is_some(), "{accepted}");
        }
        for refused in [
            "http://auth.x.ai/oauth2/token",
            "https://auth.x.ai:8443/oauth2/token",
            "https://user@auth.x.ai/oauth2/token",
            "https://auth.x.ai.evil.example/oauth2/token",
            "https://notx.ai/oauth2/token",
            "https://evil.example/?next=https://auth.x.ai/",
            "",
        ] {
            assert!(official(refused).is_none(), "{refused}");
        }
        let grok = Grok::new(reqwest::Client::new());
        assert_eq!(grok.discovery, DISCOVERY_URL);
        assert!(official(&grok.discovery).is_some());
        assert_eq!(grok.api("responses"), "https://api.x.ai/v1/responses");
        assert_eq!(grok.second, Duration::from_secs(1));
    }

    #[test]
    fn the_wait_follows_the_providers_pace_inside_its_bounds() {
        assert_eq!(clamped_interval(None), 5);
        assert_eq!(clamped_interval(Some(0)), 1);
        assert_eq!(clamped_interval(Some(7)), 7);
        assert_eq!(clamped_interval(Some(600)), 30);
        assert_eq!(pending(Some("authorization_pending"), 5), Pending::Wait(5));
        assert_eq!(pending(Some("slow_down"), 5), Pending::Wait(10));
        assert_eq!(pending(Some("slow_down"), 28), Pending::Wait(30));
        for ended in [
            Some("access_denied"),
            Some("expired_token"),
            Some("invalid_grant"),
            None,
        ] {
            assert_eq!(pending(ended, 5), Pending::Ended, "{ended:?}");
        }
    }

    #[tokio::test]
    async fn a_sign_in_shows_the_code_waits_for_the_user_and_stores_the_connection() {
        let fixture = fixture();
        // Until the user approves, the provider only ever answers "pending".
        fixture
            .double
            .answers([pending_answer("authorization_pending")]);
        let code = fixture.begin("first").await.unwrap();
        assert_eq!(
            code,
            GrokCode {
                user_code: "ABCD-1234".into(),
                verification_url: fixture.double.server.url("/activate"),
                expires_in_seconds: 600,
            }
        );
        // Nothing is stored while the user is away, however often the sign-in has asked.
        let waiting = fixture.double.wait_for_polls(1).await;
        assert_eq!(fixture.stored().await, 0);
        // Then the user approves; transient failures and a slow-down come first.
        fixture.double.then([
            (StatusCode::BAD_GATEWAY, Value::Null),
            pending_answer("slow_down"),
            (StatusCode::TOO_MANY_REQUESTS, Value::Null),
            granted(1, Some("player@example.com")),
        ]);
        let saved = fixture.finish("first").await.unwrap();
        assert_eq!(saved.connection.kind, ConnectionKind::Grok);
        assert_eq!(saved.connection.status, ConnectionStatus::Ready);
        assert_eq!(
            saved.connection.account.as_deref(),
            Some("player@example.com")
        );
        // Every queued answer was consumed by its own poll before the grant was stored.
        assert_eq!(fixture.double.unanswered(), 0);
        let polls = fixture.double.polls();
        assert!(polls >= waiting + 4, "{polls} polls after {waiting}");

        // The requests name the public client, the scopes and the device code.
        let device = fixture.double.device_forms.lock().unwrap()[0].clone();
        assert_eq!(device["client_id"], CLIENT_ID);
        assert_eq!(device["scope"], SCOPE);
        let poll = fixture.double.token_forms.lock().unwrap()[0].clone();
        assert_eq!(poll["grant_type"], DEVICE_GRANT);
        assert_eq!(poll["client_id"], CLIENT_ID);
        assert_eq!(poll["device_code"], "the-device-code");
        // The page with the code filled in is what the browser was given.
        assert_eq!(
            *fixture.opened.lock().unwrap(),
            vec![fixture.double.server.url("/activate?user_code=ABCD-1234")]
        );

        // The secret holds the refresh token and the token endpoint, and the owner the tokens.
        let (handle, secret) = fixture.sign_in.connections.grok().await.unwrap().unwrap();
        assert_eq!(handle, saved.connection.handle);
        assert_eq!(secret.refresh_token.as_deref(), Some("grok-refresh-1"));
        assert_eq!(secret.token_endpoint, fixture.double.server.url("/token"));
        let bearer = fixture.sign_in.accounts.bearer(handle).await.unwrap();
        assert_eq!(bearer.token, "grok-access-1");
        assert_eq!(fixture.double.polls(), polls);

        // The result is handed out once; the attempt is gone from the holder.
        assert_eq!(fixture.finish("first").await, Err(CoachError::Cancelled));
        fixture.idle().await;
    }

    #[tokio::test]
    async fn a_declined_or_expired_code_ends_the_sign_in_and_stores_nothing() {
        let fixture = fixture();
        fixture.double.answers([
            pending_answer("authorization_pending"),
            pending_answer("access_denied"),
        ]);
        fixture.begin("declined").await.unwrap();
        assert_eq!(
            fixture.finish("declined").await,
            Err(CoachError::SignInFailed)
        );
        assert_eq!(fixture.double.polls(), 2);

        // A code nobody approves ends with its lifetime, not later.
        fixture
            .double
            .answers([pending_answer("authorization_pending")]);
        fixture.double.device_field("expires_in", json!(4));
        let code = fixture.begin("expired").await.unwrap();
        assert_eq!(code.expires_in_seconds, 4);
        assert_eq!(
            fixture.finish("expired").await,
            Err(CoachError::SignInFailed)
        );

        // An answer without a refresh token is no sign-in that would last.
        let mut once = granted(1, None);
        once.1["refresh_token"] = Value::Null;
        fixture.double.device_field("expires_in", json!(600));
        fixture.double.answers([once]);
        fixture.begin("once").await.unwrap();
        assert_eq!(fixture.finish("once").await, Err(CoachError::SignInFailed));

        assert_eq!(fixture.stored().await, 0);
        fixture.idle().await;
    }

    #[tokio::test]
    async fn a_cancelled_or_replaced_sign_in_ends_as_cancelled() {
        let fixture = fixture();
        fixture
            .double
            .answers([pending_answer("authorization_pending")]);
        fixture.begin("first").await.unwrap();
        fixture.sign_in.attempts.cancel("first");
        assert_eq!(fixture.finish("first").await, Err(CoachError::Cancelled));
        fixture.idle().await;

        // A second sign-in ends the first; the first one's result has nowhere to go.
        fixture.begin("second").await.unwrap();
        fixture.begin("third").await.unwrap();
        assert_eq!(fixture.finish("second").await, Err(CoachError::Cancelled));
        // The window that started it goes away.
        fixture.sign_in.attempts.cancel_window("main");
        assert_eq!(fixture.finish("third").await, Err(CoachError::Cancelled));
        fixture.idle().await;

        // An id that was never started, and one that is no id.
        assert_eq!(fixture.finish("never").await, Err(CoachError::Cancelled));
        assert_eq!(fixture.begin("").await, Err(CoachError::InvalidInput));
        assert_eq!(fixture.stored().await, 0);
    }

    #[tokio::test]
    async fn an_address_that_is_not_the_providers_fails_the_sign_in_before_it_is_used() {
        let fixture = fixture();
        fixture.double.answers([granted(1, None)]);
        for field in ["verification_uri", "verification_uri_complete"] {
            let kept = fixture.double.device.lock().unwrap().1[field].clone();
            fixture
                .double
                .device_field(field, json!("https://evil.example/activate"));
            assert_eq!(
                fixture.begin("link").await,
                Err(CoachError::ProviderFailure),
                "{field}"
            );
            fixture.double.device_field(field, kept);
        }
        for field in ["device_authorization_endpoint", "token_endpoint"] {
            let kept = fixture.double.discovery.lock().unwrap()[field].clone();
            fixture.double.discovery.lock().unwrap()[field] = json!("https://evil.example/oauth2");
            assert_eq!(
                fixture.begin("endpoint").await,
                Err(CoachError::ProviderFailure),
                "{field}"
            );
            fixture.double.discovery.lock().unwrap()[field] = kept;
        }
        // Nothing was opened, asked for a token, or stored; no attempt is left behind.
        assert!(fixture.opened.lock().unwrap().is_empty());
        assert_eq!(fixture.double.polls(), 0);
        assert_eq!(fixture.stored().await, 0);
        fixture.idle().await;

        // A code that is no plain code is not shown either.
        fixture
            .double
            .device_field("user_code", json!("<b>ABCD</b>"));
        assert_eq!(
            fixture.begin("code").await,
            Err(CoachError::ProviderFailure)
        );

        // A stored token endpoint is checked again before it is used.
        let grok = &fixture.sign_in.grok;
        assert!(matches!(
            grok.refresh("https://evil.example/oauth2/token", "refresh")
                .await,
            Err(RefreshError::Other(CoachError::ProviderFailure))
        ));
    }

    #[tokio::test]
    async fn a_gateway_timeout_is_told_apart_and_a_poll_that_stalls_is_asked_again() {
        let fixture = fixture();
        *fixture.double.discovery_status.lock().unwrap() = StatusCode::GATEWAY_TIMEOUT;
        assert_eq!(
            fixture.begin("discovery").await,
            Err(CoachError::ProviderTimeout)
        );
        *fixture.double.discovery_status.lock().unwrap() = StatusCode::OK;

        let kept = fixture.double.device.lock().unwrap().clone();
        *fixture.double.device.lock().unwrap() = (StatusCode::GATEWAY_TIMEOUT, Value::Null);
        assert_eq!(
            fixture.begin("device").await,
            Err(CoachError::ProviderTimeout)
        );
        *fixture.double.device.lock().unwrap() = kept;

        fixture
            .double
            .answers([(StatusCode::GATEWAY_TIMEOUT, Value::Null)]);
        let token_endpoint = fixture.double.server.url("/token");
        assert!(matches!(
            fixture
                .sign_in
                .grok
                .refresh(&token_endpoint, "refresh")
                .await,
            Err(RefreshError::Other(CoachError::ProviderTimeout))
        ));

        // The first poll gets no answer before the read timeout; the sign-in asks again.
        let before = fixture.double.polls();
        fixture.double.stalls.store(1, SeqCst);
        fixture.double.answers([granted(1, None)]);
        fixture.begin("stalled").await.unwrap();
        let saved = fixture.finish("stalled").await.unwrap();
        assert_eq!(saved.connection.kind, ConnectionKind::Grok);
        assert!(fixture.double.polls() >= before + 2);
        fixture.idle().await;
    }

    #[tokio::test]
    async fn revocation_asks_the_endpoint_the_provider_names() {
        let fixture = fixture();
        assert!(fixture.sign_in.grok.revoke("the-refresh-token").await);
        let form = fixture.double.revocations.lock().unwrap()[0].clone();
        assert_eq!(form["token"], "the-refresh-token");
        assert_eq!(form["token_type_hint"], "refresh_token");
        assert_eq!(form["client_id"], CLIENT_ID);

        // Without a usable endpoint the revocation is not confirmed.
        fixture.double.discovery.lock().unwrap()["revocation_endpoint"] =
            json!("https://evil.example/revoke");
        assert!(!fixture.sign_in.grok.revoke("the-refresh-token").await);
        fixture.double.discovery.lock().unwrap()["revocation_endpoint"] = Value::Null;
        assert!(!fixture.sign_in.grok.revoke("the-refresh-token").await);
        assert_eq!(fixture.double.revocations.lock().unwrap().len(), 1);
    }
}
