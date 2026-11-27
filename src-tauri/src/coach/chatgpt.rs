//! Sign in with ChatGPT, as OpenAI documents it for open-source and locally run apps.
//!
//! The first sign-in registers this installation: the authorization request names the
//! registration client and a stable host id, and the callback returns the client id that was
//! issued. That id is what the code is exchanged with, what every refresh names, and what later
//! sign-ins start from. Nothing is stored before the whole sign-in has succeeded, so a failed one
//! leaves no connection and no keyring entry.
//!
//! Bodies of the authentication endpoints are never logged: a failure is logged by its status, the
//! provider's error code and its error description, with every secret the request carried removed
//! from that description first.

use std::{
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::Engine as _;
use oauth2::CsrfToken;
use serde::Deserialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::{
    connections::{ChatGptSecret, ConnectionSaved, Connections},
    error::CoachError,
    http::{browser_link, diagnostic_without, send_bounded, timed_out},
    responses::classify_code,
};
use crate::{
    credentials::CoachCredentials,
    error::Error,
    infra::token_session::{IssuedTokens, RefreshError},
    oauth_pkce::{self, AttemptRegistry, CodeGrant, ListenerSpec, OAuthProvider},
};

/// The client id of a first sign-in. It is only the door to registration and is never stored.
const REGISTRATION_CLIENT: &str = "dynamic_agent_client";
/// The name the provider shows the user for this app at registration.
const AGENT_NAME: &str = "ChessRiddle Studio";
/// The API the tokens are asked for.
const RESOURCE: &str = "https://api.openai.com/v1";
/// The scope that allows requests on the user's plan; a sign-in without it is of no use here.
const DIRECT_SCOPE: &str = "chatgpt.tokens.use.direct";
const SCOPES: [&str; 6] = [
    "openid",
    "profile",
    "email",
    "offline_access",
    "resource.invoke",
    DIRECT_SCOPE,
];
/// Refresh refusals after which only a new sign-in helps.
const TERMINAL_REFRESH_ERRORS: [&str; 6] = [
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
];
/// The provider accepts a loopback redirect on this path only; the port may differ per sign-in.
const LISTENER: ListenerSpec = ListenerSpec {
    path: "/auth/callback",
    ports: &[1455, 1457, 0],
};
/// The note beside the Coach's credential registry that holds this installation's host id.
const HOST_ID_FILE: &str = "coach-host-id";
const AUTHORIZE_HOST: &str = "auth.openai.com";
const USAGE_HOST: &str = "chatgpt.com";
/// Where the user manages what their plan is used for.
const USAGE_URL: &str = "https://chatgpt.com/settings/usage";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(180);
/// A removal does not wait longer than this for the provider to confirm the revocation.
const REVOKE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_TOKEN_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_TOKEN_BYTES: usize = 16 * 1024;
const MAX_EXPIRES_IN_SECONDS: u64 = 24 * 60 * 60;
const MAX_CLIENT_ID_CHARS: usize = 128;
const MAX_IDENTITY_CHARS: usize = 254;
const MAX_ERROR_CODE_CHARS: usize = 64;
/// The fields of a token request whose values are secrets and never reach the log.
const SECRET_FIELDS: [&str; 3] = ["code", "code_verifier", "refresh_token"];

/// Hands a link to the system browser.
pub(crate) type BrowserOpener = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

pub(crate) struct Endpoints {
    pub issuer: String,
    pub authorize: String,
    pub token: String,
    pub revoke: String,
    /// The base of the API the tokens are for, without a trailing slash.
    pub api: String,
}

impl Endpoints {
    pub(crate) fn official() -> Self {
        Self {
            issuer: "https://auth.openai.com".into(),
            authorize: "https://auth.openai.com/api/accounts/authorize".into(),
            token: "https://auth.openai.com/api/accounts/oauth/token".into(),
            revoke: "https://auth.openai.com/api/accounts/oauth/revoke".into(),
            api: RESOURCE.into(),
        }
    }
}

/// The token endpoint's answer. No `Debug`: it carries the tokens.
#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}

impl TokenResponse {
    fn valid(&self) -> bool {
        let bounded = |token: &str| !token.is_empty() && token.len() <= MAX_TOKEN_BYTES;
        bounded(&self.access_token)
            && bounded(&self.refresh_token)
            && (1..=MAX_EXPIRES_IN_SECONDS).contains(&self.expires_in)
            && self
                .token_type
                .as_deref()
                .is_none_or(|kind| kind.eq_ignore_ascii_case("bearer"))
    }

    fn issued(self) -> IssuedTokens {
        IssuedTokens {
            access: self.access_token,
            refresh: self.refresh_token,
            expires_in: Duration::from_secs(self.expires_in),
        }
    }
}

enum TokenFailure {
    /// The provider refused the request and named this error code.
    Refused(String),
    Other(CoachError),
}

/// The error code of an OAuth error body, if it is one of the plain words these codes are.
pub(crate) fn error_code(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let code = match value.get("error")? {
        Value::String(code) => code.as_str(),
        error => error.get("code")?.as_str()?,
    };
    (!code.is_empty()
        && code.len() <= MAX_ERROR_CODE_CHARS
        && code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'))
    .then(|| code.to_owned())
}

/// The provider's own words about a refused token request, for the native log: the OAuth
/// `error_description`, else the message of a nested error object, with every secret value of
/// `form` removed and cut to one bounded line. `None` when the body says nothing.
fn refusal_description(body: &[u8], form: &[(&str, &str)]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let text = value
        .get("error_description")
        .and_then(Value::as_str)
        .or_else(|| value.get("error")?.get("message")?.as_str())?;
    let secrets: Vec<&str> = form
        .iter()
        .filter(|(name, _)| SECRET_FIELDS.contains(name))
        .map(|(_, value)| *value)
        .collect();
    let line = diagnostic_without(text, &secrets);
    (!line.trim().is_empty()).then_some(line)
}

/// Who signed in, from the claims of the ID token.
struct Identity {
    subject: String,
    email: Option<String>,
}

fn plain(text: &str) -> Option<String> {
    super::plain(text, MAX_IDENTITY_CHARS).then(|| text.to_owned())
}

/// Checks the ID token by its claims: issuer, audience, expiry and the nonce of this attempt. It
/// came straight from the token endpoint over TLS and only says who signed in; its signature is
/// not checked separately (decision d-20261122-18).
fn identity(
    id_token: &str,
    issuer: &str,
    client_id: &str,
    nonce: &str,
    now: u64,
) -> Option<Identity> {
    let claims = id_token_claims(id_token)?;
    let for_this_client = match claims.get("aud")? {
        Value::String(audience) => audience == client_id,
        Value::Array(audiences) => audiences.iter().any(|audience| audience == client_id),
        _ => false,
    };
    if claims.get("iss")?.as_str()? != issuer
        || !for_this_client
        || claims.get("exp")?.as_u64()? <= now
        || claims.get("nonce")?.as_str()? != nonce
    {
        return None;
    }
    Some(Identity {
        subject: plain(claims.get("sub")?.as_str()?)?,
        email: display_email(&claims),
    })
}

/// What the middle part of an ID token says. Nothing about it is verified here.
pub(crate) fn id_token_claims(id_token: &str) -> Option<Value> {
    if id_token.len() > MAX_TOKEN_BYTES {
        return None;
    }
    let mut parts = id_token.split('.');
    let (_header, payload, _signature) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// The account's email among the claims, if it is one that can be shown.
pub(crate) fn display_email(claims: &Value) -> Option<String> {
    claims
        .get("email")
        .and_then(Value::as_str)
        .filter(|email| email.contains('@'))
        .and_then(plain)
}

/// A client id as the provider issues them: a short plain word that is not the registration door.
fn issued_client(client_id: &str) -> Option<String> {
    (!client_id.is_empty()
        && client_id != REGISTRATION_CLIENT
        && client_id.len() <= MAX_CLIENT_ID_CHARS
        && client_id.bytes().all(|byte| byte.is_ascii_graphic()))
    .then(|| client_id.to_owned())
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

/// Opens `url` in the system browser if it is a plain `https` link on `host`.
fn open_on(url: &str, host: &str, opener: &BrowserOpener) -> Result<(), CoachError> {
    let link = browser_link(url, |candidate| candidate == host).ok_or_else(|| {
        log::error!("coach: a link for the browser was not on {host} and was not opened");
        CoachError::ProviderFailure
    })?;
    opener(link.as_str()).map_err(|_| CoachError::SignInFailed)
}

pub(crate) struct ChatGpt {
    endpoints: Endpoints,
    http: reqwest::Client,
    attempts: Arc<AttemptRegistry>,
    sign_in_timeout: Duration,
    listener: &'static ListenerSpec,
}

impl ChatGpt {
    pub(crate) fn new(http: reqwest::Client) -> Self {
        Self {
            endpoints: Endpoints::official(),
            http,
            attempts: Arc::default(),
            sign_in_timeout: SIGN_IN_TIMEOUT,
            listener: &LISTENER,
        }
    }

    /// For tests: a provider double, a short deadline, and a listener on a port of the system's
    /// choosing, so that tests running side by side never meet on the preferred ports.
    #[cfg(test)]
    pub(crate) fn with_endpoints(
        http: reqwest::Client,
        endpoints: Endpoints,
        sign_in_timeout: Duration,
    ) -> Self {
        static ANY_PORT: ListenerSpec = ListenerSpec {
            path: LISTENER.path,
            ports: &[0],
        };
        Self {
            endpoints,
            http,
            attempts: Arc::default(),
            sign_in_timeout,
            listener: &ANY_PORT,
        }
    }

    pub(crate) fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// The address of an API endpoint the tokens are for.
    pub(crate) fn api(&self, path: &str) -> String {
        format!("{}/{path}", self.endpoints.api)
    }

    pub(crate) fn open_usage(&self, opener: &BrowserOpener) -> Result<(), CoachError> {
        open_on(USAGE_URL, USAGE_HOST, opener)
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> Result<TokenResponse, TokenFailure> {
        let request = self.http.post(&self.endpoints.token).form(form);
        let (status, body) = send_bounded(request, MAX_TOKEN_RESPONSE_BYTES)
            .await
            .map_err(TokenFailure::Other)?;
        match status {
            200 => serde_json::from_slice::<TokenResponse>(&body)
                .ok()
                .filter(TokenResponse::valid)
                .ok_or(TokenFailure::Other(CoachError::ProviderFailure)),
            429 => Err(TokenFailure::Other(CoachError::RateLimited)),
            400 | 401 | 403 => {
                let code = error_code(&body).unwrap_or_else(|| "unknown".into());
                match refusal_description(&body, form) {
                    Some(description) => log::warn!(
                        "coach: the ChatGPT token endpoint refused with HTTP {status}: {code} ({description})"
                    ),
                    None => log::warn!(
                        "coach: the ChatGPT token endpoint refused with HTTP {status}: {code}"
                    ),
                }
                Err(TokenFailure::Refused(code))
            }
            _ => {
                log::warn!("coach: the ChatGPT token endpoint answered HTTP {status}");
                Err(TokenFailure::Other(if timed_out(status) {
                    CoachError::ProviderTimeout
                } else {
                    CoachError::ProviderFailure
                }))
            }
        }
    }

    /// Exchanges a refresh token. The provider rotates it: the answer's refresh token replaces it.
    pub(crate) async fn refresh(
        &self,
        client_id: &str,
        refresh: &str,
    ) -> Result<IssuedTokens, RefreshError<CoachError>> {
        let form = [
            ("grant_type", "refresh_token"),
            ("client_id", client_id),
            ("refresh_token", refresh),
            ("resource", RESOURCE),
        ];
        match self.token_request(&form).await {
            Ok(tokens) => Ok(tokens.issued()),
            Err(TokenFailure::Refused(code))
                if TERMINAL_REFRESH_ERRORS.contains(&code.as_str()) =>
            {
                Err(RefreshError::Terminal)
            }
            Err(TokenFailure::Refused(code)) => Err(RefreshError::Other(
                classify_code(&code).unwrap_or(CoachError::ProviderFailure),
            )),
            Err(TokenFailure::Other(error)) => Err(RefreshError::Other(error)),
        }
    }

    /// Withdraws a sign-in at the provider. `true` only when the provider confirmed it.
    pub(crate) async fn revoke(&self, client_id: &str, refresh: &str) -> bool {
        let form = [
            ("token", refresh),
            ("token_type_hint", "refresh_token"),
            ("client_id", client_id),
        ];
        self.http
            .post(&self.endpoints.revoke)
            .form(&form)
            .timeout(REVOKE_TIMEOUT)
            .send()
            .await
            .is_ok_and(|response| response.status().as_u16() == 200)
    }

    /// Runs one sign-in in the system browser and stores its result as the ChatGPT connection.
    /// On success the connection is returned with the tokens that came with it; the caller hands
    /// those to the connection's token owner.
    pub(crate) async fn sign_in(
        &self,
        connections: &Connections,
        credentials: &Arc<CoachCredentials>,
        cancellation: &CancellationToken,
        opener: &BrowserOpener,
    ) -> Result<(ConnectionSaved, String, IssuedTokens), CoachError> {
        // A returning installation starts from the client id it was issued.
        let known_client = connections
            .chatgpt()
            .await?
            .map(|(_, secret)| secret.client_id);
        let host = credentials.installation_id(HOST_ID_FILE).await.map_err(
            super::connections::storage_failure("reading the installation id"),
        )?;
        let host = format!("urn:uuid:{host}");
        let nonce = CsrfToken::new_random().secret().clone();
        let mut extra_params = vec![
            ("ext_agent_host_id", host.as_str()),
            ("resource", RESOURCE),
            ("nonce", nonce.as_str()),
        ];
        if known_client.is_none() {
            extra_params.push(("agent_name_hint", AGENT_NAME));
        }
        let provider = OAuthProvider {
            authorization_url: &self.endpoints.authorize,
            token_url: &self.endpoints.token,
            client_id: known_client.as_deref().unwrap_or(REGISTRATION_CLIENT),
            scopes: &SCOPES,
            extra_params: &extra_params,
        };
        // The helper reports every failure alike; what went wrong is kept here.
        let cause = Mutex::new(CoachError::SignInFailed);
        let fail = |error: CoachError| {
            if let Ok(mut cause) = cause.lock() {
                *cause = error;
            }
            Error::OAuthFailure(oauth_pkce::OAUTH_FAILURE.into())
        };
        let mut granted = None;
        let granted_ref = &mut granted;
        let attempts = self.attempts.clone();
        let known = known_client.as_deref();
        let outcome = oauth_pkce::authenticate_cancellable(
            provider,
            self.attempts.clone(),
            self.sign_in_timeout,
            cancellation,
            move || oauth_pkce::start_listener_on(attempts, self.listener),
            |url| open_on(url, AUTHORIZE_HOST, opener).map_err(|error| fail(error).to_string()),
            |client, grant: CodeGrant, verifier| async move {
                let returned = grant.client_id.as_deref();
                let client_id = match (known, returned) {
                    // A reauthorization may leave the id out, but must not name another one.
                    (Some(known), Some(returned)) if known != returned => None,
                    (Some(known), _) => Some(known.to_owned()),
                    // A first sign-in without an issued id is an incomplete registration.
                    (None, returned) => returned.and_then(issued_client),
                };
                let (Some(client_id), Some(redirect)) = (client_id, client.redirect_url()) else {
                    return Err(fail(CoachError::SignInFailed));
                };
                let form = [
                    ("grant_type", "authorization_code"),
                    ("client_id", client_id.as_str()),
                    ("code", grant.code.secret().as_str()),
                    ("code_verifier", verifier.secret().as_str()),
                    ("redirect_uri", redirect.as_str()),
                    ("resource", RESOURCE),
                ];
                let tokens = self
                    .token_request(&form)
                    .await
                    .map_err(|failure| match failure {
                        TokenFailure::Other(error) => fail(error),
                        // A code that names the account's eligibility or limit says so; any other
                        // refusal (`invalid_grant` included) needs a fresh sign-in.
                        TokenFailure::Refused(code) => {
                            fail(classify_code(&code).unwrap_or(CoachError::SignInFailed))
                        }
                    })?;
                *granted_ref = Some((client_id, tokens));
                Ok(())
            },
        )
        .await;
        if outcome.is_err() {
            return Err(if cancellation.is_cancelled() {
                CoachError::Cancelled
            } else {
                cause.into_inner().unwrap_or(CoachError::SignInFailed)
            });
        }
        let (client_id, tokens) = granted.ok_or(CoachError::SignInFailed)?;
        let direct = tokens
            .scope
            .as_deref()
            .is_some_and(|scope| scope.split(' ').any(|granted| granted == DIRECT_SCOPE));
        if !direct {
            // Signed in, but without leave to use the plan from this app.
            return Err(CoachError::SubscriptionNotEligible);
        }
        let identity = tokens
            .id_token
            .as_deref()
            .and_then(|id_token| {
                identity(
                    id_token,
                    &self.endpoints.issuer,
                    &client_id,
                    &nonce,
                    now_seconds(),
                )
            })
            .ok_or(CoachError::SignInFailed)?;
        let saved = connections
            .save_chatgpt(ChatGptSecret {
                client_id: client_id.clone(),
                refresh_token: Some(tokens.refresh_token.clone()),
                subject: identity.subject,
                email: identity.email,
            })
            .await?;
        Ok((saved, client_id, tokens.issued()))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        coach::{
            connections::{ConnectionKind, ConnectionStatus},
            test_server::{self, TestServer},
        },
        credentials::{CoachConnectionHandle, CredentialStore, MemoryCredentialStore},
    };
    use axum::{
        extract::Form,
        http::{header::AUTHORIZATION, header::CONTENT_TYPE, HeaderMap, StatusCode},
        response::IntoResponse,
        routing::{get, post},
        Json, Router,
    };
    use std::collections::HashMap;

    type Forms = Arc<Mutex<Vec<HashMap<String, String>>>>;

    /// What the provider double answers the next token requests with.
    #[derive(Clone)]
    pub(crate) struct Script {
        pub status: StatusCode,
        pub body: Value,
    }

    /// The provider double: a token and a revocation endpoint that record their forms, and the
    /// two API endpoints, which record the path and the authorization of every call. For the
    /// device-code sign-in it also serves a discovery document that names these endpoints, and a
    /// device endpoint.
    pub(crate) struct Provider {
        pub server: TestServer,
        pub forms: Forms,
        pub revocations: Forms,
        pub token: Arc<Mutex<Script>>,
        pub revoke_status: Arc<Mutex<StatusCode>>,
        pub api_calls: Arc<Mutex<Vec<(&'static str, String)>>>,
        /// Access tokens the API refuses as unauthorized.
        pub refused: Arc<Mutex<Vec<String>>>,
    }

    /// The API's answer to a call with this authorization: `None` when its token is refused.
    fn admitted(
        path: &'static str,
        headers: &HeaderMap,
        calls: &Mutex<Vec<(&'static str, String)>>,
        refused: &Mutex<Vec<String>>,
    ) -> bool {
        let authorization = headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let token = authorization.trim_start_matches("Bearer ").to_owned();
        calls.lock().unwrap().push((path, authorization));
        !refused.lock().unwrap().contains(&token)
    }

    /// The double's own address, as the caller reached it.
    fn own_origin(headers: &HeaderMap) -> String {
        let host = headers
            .get(axum::http::header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        format!("http://{host}")
    }

    impl Provider {
        pub(crate) fn start() -> Self {
            let forms = Forms::default();
            let revocations = Forms::default();
            let token = Arc::new(Mutex::new(Script {
                status: StatusCode::OK,
                body: Value::Null,
            }));
            let revoke_status = Arc::new(Mutex::new(StatusCode::OK));
            let api_calls = Arc::new(Mutex::new(Vec::new()));
            let refused = Arc::new(Mutex::new(Vec::new()));
            let router = Router::new()
                .route(
                    "/v1/models",
                    get({
                        let (calls, refused) = (api_calls.clone(), refused.clone());
                        move |headers: HeaderMap| async move {
                            if !admitted("models", &headers, &calls, &refused) {
                                return StatusCode::UNAUTHORIZED.into_response();
                            }
                            Json(serde_json::json!({ "models": [
                                { "slug": "gpt-plan", "display_name": "GPT Plan", "visibility": "list" },
                            ] }))
                            .into_response()
                        }
                    }),
                )
                .route(
                    "/v1/responses",
                    post({
                        let (calls, refused) = (api_calls.clone(), refused.clone());
                        move |headers: HeaderMap| async move {
                            if !admitted("responses", &headers, &calls, &refused) {
                                return StatusCode::UNAUTHORIZED.into_response();
                            }
                            let stream = concat!(
                                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Ok.\"}\n\n",
                                "data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
                            );
                            ([(CONTENT_TYPE, "text/event-stream")], stream).into_response()
                        }
                    }),
                )
                .route(
                    "/.well-known/openid-configuration",
                    get(|headers: HeaderMap| async move {
                        let origin = own_origin(&headers);
                        Json(serde_json::json!({
                            "device_authorization_endpoint": format!("{origin}/device"),
                            "token_endpoint": format!("{origin}/token"),
                            "revocation_endpoint": format!("{origin}/revoke"),
                        }))
                    }),
                )
                .route(
                    "/device",
                    post(|headers: HeaderMap| async move {
                        let origin = own_origin(&headers);
                        Json(serde_json::json!({
                            "device_code": "the-device-code",
                            "user_code": "WXYZ-9876",
                            "verification_uri": format!("{origin}/activate"),
                            "expires_in": 600,
                            "interval": 1,
                        }))
                    }),
                )
                .route(
                    "/token",
                    post({
                        let (forms, token) = (forms.clone(), token.clone());
                        move |Form(form): Form<HashMap<String, String>>| async move {
                            forms.lock().unwrap().push(form);
                            let script = token.lock().unwrap().clone();
                            (script.status, Json(script.body))
                        }
                    }),
                )
                .route(
                    "/revoke",
                    post({
                        let (revocations, status) = (revocations.clone(), revoke_status.clone());
                        move |Form(form): Form<HashMap<String, String>>| async move {
                            revocations.lock().unwrap().push(form);
                            *status.lock().unwrap()
                        }
                    }),
                );
            Self {
                server: test_server::serve(router),
                forms,
                revocations,
                token,
                revoke_status,
                api_calls,
                refused,
            }
        }

        /// A browser in which the user approves the sign-in. It sets the token answer for the
        /// attempt (sign-in number `n`; the ID token needs the attempt's nonce) and follows the
        /// redirect, naming `client_id` as the issued one.
        pub(crate) fn approving_browser(&self, n: u32, client_id: &'static str) -> BrowserOpener {
            let token = self.token.clone();
            Arc::new(move |url: &str| {
                let url = url::Url::parse(url).unwrap();
                let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
                let claims = serde_json::json!({
                    "iss": "https://auth.openai.com",
                    "aud": client_id,
                    "exp": now_seconds() + 600,
                    "nonce": query["nonce"],
                    "sub": "user-123",
                    "email": "player@example.com",
                });
                *token.lock().unwrap() = Script {
                    status: StatusCode::OK,
                    body: tokens(n, Some(id_token(claims)), ALL_SCOPES),
                };
                let (redirect, state) = (query["redirect_uri"].clone(), query["state"].clone());
                tokio::spawn(async move {
                    let http = reqwest::Client::builder().no_proxy().build().unwrap();
                    let callback = [
                        ("state", state.as_str()),
                        ("code", "the-code"),
                        ("client_id", client_id),
                    ];
                    let _ = http.get(redirect).query(&callback).send().await;
                });
                Ok(())
            })
        }

        pub(crate) fn answer(&self, status: StatusCode, body: Value) {
            *self.token.lock().unwrap() = Script { status, body };
        }

        pub(crate) fn endpoints(&self) -> Endpoints {
            Endpoints {
                issuer: "https://auth.openai.com".into(),
                // Never contacted: the test plays the browser.
                authorize: "https://auth.openai.com/api/accounts/authorize".into(),
                token: self.server.url("/token"),
                revoke: self.server.url("/revoke"),
                api: self.server.url("/v1"),
            }
        }

        pub(crate) fn chatgpt(&self, timeout: Duration) -> ChatGpt {
            let http = reqwest::Client::builder().no_proxy().build().unwrap();
            ChatGpt::with_endpoints(http, self.endpoints(), timeout)
        }
    }

    pub(crate) fn id_token(claims: Value) -> String {
        let encode = |value: &Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string().as_bytes())
        };
        format!(
            "{}.{}.signature",
            encode(&serde_json::json!({ "alg": "RS256" })),
            encode(&claims)
        )
    }

    pub(crate) fn tokens(n: u32, id_token: Option<String>, scope: &str) -> Value {
        serde_json::json!({
            "access_token": format!("access-{n}"),
            "refresh_token": format!("refresh-{n}"),
            "token_type": "Bearer",
            "expires_in": 3600,
            "scope": scope,
            "id_token": id_token,
        })
    }

    const ALL_SCOPES: &str =
        "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";

    struct Fixture {
        provider: Provider,
        chatgpt: ChatGpt,
        connections: Connections,
        credentials: Arc<CoachCredentials>,
        store: Arc<MemoryCredentialStore>,
        directory: tempfile::TempDir,
    }

    fn fixture(timeout: Duration) -> Fixture {
        let provider = Provider::start();
        let chatgpt = provider.chatgpt(timeout);
        let store = Arc::new(MemoryCredentialStore::default());
        let (credentials, directory) = CoachCredentials::for_test(store.clone());
        let credentials = Arc::new(credentials);
        Fixture {
            provider,
            chatgpt,
            connections: Connections::new(credentials.clone()),
            credentials,
            store,
            directory,
        }
    }

    /// What the browser does once it was opened: answer the redirect.
    type Browser =
        Box<dyn Fn(HashMap<String, String>) -> Option<Vec<(String, String)>> + Send + Sync>;

    /// Runs one sign-in. `browser` gets the authorization query and returns the callback's query
    /// (`None`: the user never comes back). `before_exchange` sets the token answer from the
    /// authorization query, which holds the nonce.
    async fn sign_in(
        fixture: &Fixture,
        cancellation: &CancellationToken,
        browser: Browser,
        before_exchange: impl Fn(&HashMap<String, String>) + Send + Sync + 'static,
    ) -> (
        Result<ConnectionSaved, CoachError>,
        Option<HashMap<String, String>>,
    ) {
        let asked = Arc::new(Mutex::new(None));
        let opener: BrowserOpener = Arc::new({
            let asked = asked.clone();
            move |url: &str| {
                let url = url::Url::parse(url).unwrap();
                assert_eq!(
                    url.as_str().split('?').next(),
                    Some("https://auth.openai.com/api/accounts/authorize")
                );
                let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
                *asked.lock().unwrap() = Some(query.clone());
                before_exchange(&query);
                if let Some(callback) = browser(query.clone()) {
                    let redirect = query["redirect_uri"].clone();
                    tokio::spawn(async move {
                        let http = reqwest::Client::builder().no_proxy().build().unwrap();
                        let _ = http.get(redirect).query(&callback).send().await;
                    });
                }
                Ok(())
            }
        });
        let result = fixture
            .chatgpt
            .sign_in(
                &fixture.connections,
                &fixture.credentials,
                cancellation,
                &opener,
            )
            .await
            .map(|(saved, _, _)| saved);
        let asked = asked.lock().unwrap().clone();
        (result, asked)
    }

    fn approve(client_id: Option<&'static str>) -> Browser {
        Box::new(move |query| {
            let mut callback = vec![
                ("state".to_owned(), query["state"].clone()),
                ("code".to_owned(), "the-code".to_owned()),
            ];
            if let Some(client_id) = client_id {
                callback.push(("client_id".to_owned(), client_id.to_owned()));
            }
            Some(callback)
        })
    }

    /// Sets a token answer whose ID token is for `client_id` and carries the attempt's nonce.
    fn good_answer(
        provider: &Provider,
        n: u32,
        client_id: &'static str,
    ) -> impl Fn(&HashMap<String, String>) + Send + Sync + 'static {
        let token = provider.token.clone();
        move |query| {
            let claims = serde_json::json!({
                "iss": "https://auth.openai.com",
                "aud": client_id,
                "exp": now_seconds() + 600,
                "nonce": query["nonce"],
                "sub": "user-123",
                "email": "player@example.com",
            });
            *token.lock().unwrap() = Script {
                status: StatusCode::OK,
                body: tokens(n, Some(id_token(claims)), ALL_SCOPES),
            };
        }
    }

    fn stored(fixture: &Fixture, handle: &CoachConnectionHandle) -> Value {
        let stored = fixture
            .store
            .get(&format!("coach-connection:{}", handle.0))
            .unwrap()
            .expect("the connection has a keyring entry");
        serde_json::from_str(&stored).unwrap()
    }

    async fn no_connection(fixture: &Fixture) {
        assert!(fixture.connections.list().await.unwrap().is_empty());
        assert!(fixture.connections.chatgpt().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_first_sign_in_registers_this_installation_and_a_later_one_starts_from_its_client() {
        let fixture = fixture(Duration::from_secs(10));
        let (result, asked) = sign_in(
            &fixture,
            &CancellationToken::new(),
            approve(Some("oaiapp_issued")),
            good_answer(&fixture.provider, 1, "oaiapp_issued"),
        )
        .await;
        let saved = result.unwrap();
        let asked = asked.unwrap();

        // The authorization request of a first sign-in.
        assert_eq!(asked["client_id"], "dynamic_agent_client");
        assert_eq!(asked["agent_name_hint"], "ChessRiddle Studio");
        assert_eq!(asked["response_type"], "code");
        assert_eq!(asked["resource"], "https://api.openai.com/v1");
        assert_eq!(
            asked["scope"],
            "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
        );
        assert_eq!(asked["code_challenge_method"], "S256");
        assert!(!asked["nonce"].is_empty() && !asked["state"].is_empty());
        let host = asked["ext_agent_host_id"].clone();
        assert!(uuid::Uuid::parse_str(host.strip_prefix("urn:uuid:").unwrap()).is_ok());
        let redirect = url::Url::parse(&asked["redirect_uri"]).unwrap();
        assert_eq!(
            (redirect.scheme(), redirect.host_str(), redirect.path()),
            ("http", Some("127.0.0.1"), "/auth/callback")
        );

        // The code is exchanged with the issued client id, never with the registration door.
        let form = fixture.provider.forms.lock().unwrap()[0].clone();
        assert_eq!(form["grant_type"], "authorization_code");
        assert_eq!(form["client_id"], "oaiapp_issued");
        assert_eq!(form["code"], "the-code");
        assert_eq!(form["redirect_uri"], asked["redirect_uri"]);
        assert_eq!(form["resource"], "https://api.openai.com/v1");
        assert!(!form["code_verifier"].is_empty());

        // One connection, with everything of the sign-in in one keyring document.
        assert_eq!(saved.connection.kind, ConnectionKind::ChatGpt);
        assert_eq!(saved.connection.label, "ChatGPT");
        assert_eq!(
            saved.connection.account.as_deref(),
            Some("player@example.com")
        );
        assert_eq!(saved.connection.status, ConnectionStatus::Ready);
        assert_eq!(
            stored(&fixture, &saved.connection.handle),
            serde_json::json!({
                "kind": "chatGpt",
                "clientId": "oaiapp_issued",
                "refreshToken": "refresh-1",
                "subject": "user-123",
                "email": "player@example.com",
            })
        );
        // The host id was stored before the browser was opened.
        let note = std::fs::read_to_string(
            fixture
                .directory
                .path()
                .join("credentials")
                .join(HOST_ID_FILE),
        )
        .unwrap();
        assert_eq!(format!("urn:uuid:{note}"), host);

        // A later sign-in: the issued client id, no name hint, the same host, the same connection.
        let (again, asked_again) = sign_in(
            &fixture,
            &CancellationToken::new(),
            approve(None),
            good_answer(&fixture.provider, 2, "oaiapp_issued"),
        )
        .await;
        let again = again.unwrap();
        let asked_again = asked_again.unwrap();
        assert_eq!(asked_again["client_id"], "oaiapp_issued");
        assert!(!asked_again.contains_key("agent_name_hint"));
        assert_eq!(asked_again["ext_agent_host_id"], host);
        assert_ne!(asked_again["nonce"], asked["nonce"]);
        assert_eq!(again.connection.handle, saved.connection.handle);
        assert_eq!(fixture.connections.list().await.unwrap().len(), 1);
        assert_eq!(
            stored(&fixture, &saved.connection.handle)["refreshToken"],
            "refresh-2"
        );
    }

    #[tokio::test]
    async fn a_sign_in_that_does_not_fit_leaves_no_connection_behind() {
        type Answer = Box<dyn Fn(&Provider, &HashMap<String, String>) + Send + Sync>;
        let claims = |query: &HashMap<String, String>| {
            serde_json::json!({
                "iss": "https://auth.openai.com",
                "aud": "oaiapp_issued",
                "exp": now_seconds() + 600,
                "nonce": query["nonce"],
                "sub": "user-123",
            })
        };
        let with = move |change: fn(&mut Value)| -> Answer {
            Box::new(move |provider, query| {
                let mut claims = claims(query);
                change(&mut claims);
                provider.answer(
                    StatusCode::OK,
                    tokens(1, Some(id_token(claims)), ALL_SCOPES),
                );
            })
        };
        let cases: Vec<(&str, Browser, Answer, CoachError)> = vec![
            (
                "the plan scope was not granted",
                approve(Some("oaiapp_issued")),
                Box::new(move |provider, query| {
                    provider.answer(
                        StatusCode::OK,
                        tokens(1, Some(id_token(claims(query))), "openid profile email"),
                    );
                }),
                CoachError::SubscriptionNotEligible,
            ),
            (
                "another attempt's nonce",
                approve(Some("oaiapp_issued")),
                with(|claims| claims["nonce"] = "someone-else".into()),
                CoachError::SignInFailed,
            ),
            (
                "an ID token for another client",
                approve(Some("oaiapp_issued")),
                with(|claims| claims["aud"] = "oaiapp_other".into()),
                CoachError::SignInFailed,
            ),
            (
                "an ID token from another issuer",
                approve(Some("oaiapp_issued")),
                with(|claims| claims["iss"] = "https://auth.example.com".into()),
                CoachError::SignInFailed,
            ),
            (
                "an expired ID token",
                approve(Some("oaiapp_issued")),
                with(|claims| claims["exp"] = 1.into()),
                CoachError::SignInFailed,
            ),
            (
                "no ID token at all",
                approve(Some("oaiapp_issued")),
                Box::new(|provider, _| {
                    provider.answer(StatusCode::OK, tokens(1, None, ALL_SCOPES));
                }),
                CoachError::SignInFailed,
            ),
            (
                "a registration that issued no client id",
                approve(None),
                with(|_| {}),
                CoachError::SignInFailed,
            ),
            (
                "the registration door returned as the issued id",
                approve(Some("dynamic_agent_client")),
                with(|_| {}),
                CoachError::SignInFailed,
            ),
            (
                "the user declined",
                Box::new(|query| {
                    Some(vec![
                        ("state".to_owned(), query["state"].clone()),
                        ("error".to_owned(), "access_denied".to_owned()),
                    ])
                }),
                with(|_| {}),
                CoachError::SignInFailed,
            ),
            (
                "the code was refused",
                approve(Some("oaiapp_issued")),
                Box::new(|provider, _| {
                    provider.answer(
                        StatusCode::BAD_REQUEST,
                        serde_json::json!({ "error": "invalid_grant" }),
                    );
                }),
                CoachError::SignInFailed,
            ),
            (
                "the code was refused because the account may not use its plan here",
                approve(Some("oaiapp_issued")),
                Box::new(|provider, _| {
                    provider.answer(
                        StatusCode::FORBIDDEN,
                        serde_json::json!({
                            "error": { "code": "subscription_sharing_user_not_eligible" }
                        }),
                    );
                }),
                CoachError::SubscriptionNotEligible,
            ),
            (
                "the token endpoint's gateway timed out",
                approve(Some("oaiapp_issued")),
                Box::new(|provider, _| {
                    provider.answer(StatusCode::GATEWAY_TIMEOUT, Value::Null);
                }),
                CoachError::ProviderTimeout,
            ),
            (
                "the token endpoint is limiting requests",
                approve(Some("oaiapp_issued")),
                Box::new(|provider, _| {
                    provider.answer(StatusCode::TOO_MANY_REQUESTS, Value::Null);
                }),
                CoachError::RateLimited,
            ),
            (
                "a token answer without tokens",
                approve(Some("oaiapp_issued")),
                Box::new(|provider, _| {
                    provider.answer(StatusCode::OK, serde_json::json!({ "ok": true }));
                }),
                CoachError::ProviderFailure,
            ),
        ];
        for (name, browser, answer, expected) in cases {
            let fixture = Arc::new(fixture(Duration::from_secs(10)));
            let scripted = fixture.clone();
            let (result, _) = sign_in(&fixture, &CancellationToken::new(), browser, move |query| {
                answer(&scripted.provider, query)
            })
            .await;
            assert_eq!(result.err(), Some(expected), "{name}");
            no_connection(&fixture).await;
            assert!(fixture.chatgpt.attempts.is_idle().await, "{name}");
        }
    }

    #[test]
    fn a_refusal_description_reaches_the_log_without_any_secret_of_the_request() {
        let form = [
            ("grant_type", "authorization_code"),
            ("client_id", "oaiapp_issued"),
            ("code", "the-code"),
            ("code_verifier", "the-verifier"),
            ("refresh_token", "the-refresh"),
        ];
        let body = serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Code the-code\nwith verifier the-verifier and the-refresh is bad",
        });
        let line = refusal_description(body.to_string().as_bytes(), &form).unwrap();
        assert_eq!(line, "Code [key] with verifier [key] and [key] is bad");
        // The client id is no secret and stays readable.
        let named = serde_json::json!({ "error_description": "unknown oaiapp_issued" });
        assert_eq!(
            refusal_description(named.to_string().as_bytes(), &form).as_deref(),
            Some("unknown oaiapp_issued")
        );

        // The nested shape gives its message; a long text is cut to one bounded line.
        let nested = serde_json::json!({
            "error": { "code": "x", "message": format!("{}{}", "a".repeat(600), "the-code") }
        });
        let cut = refusal_description(nested.to_string().as_bytes(), &form).unwrap();
        assert_eq!(cut.chars().count(), 512);
        assert!(cut.chars().all(|c| c == 'a'));

        // A body that says nothing, or says only blanks, gives no description.
        for silent in [
            serde_json::json!({ "error": "invalid_grant" }).to_string(),
            serde_json::json!({ "error_description": " \n " }).to_string(),
            "<html>".to_owned(),
        ] {
            assert_eq!(
                refusal_description(silent.as_bytes(), &form),
                None,
                "{silent}"
            );
        }
    }

    #[tokio::test]
    async fn a_callback_with_another_state_is_ignored_and_the_attempt_ends_at_its_deadline() {
        let fixture = fixture(Duration::from_millis(400));
        let (result, _) = sign_in(
            &fixture,
            &CancellationToken::new(),
            Box::new(|_| {
                Some(vec![
                    ("state".to_owned(), "forged".to_owned()),
                    ("code".to_owned(), "the-code".to_owned()),
                    ("client_id".to_owned(), "oaiapp_issued".to_owned()),
                ])
            }),
            |_| {},
        )
        .await;
        assert_eq!(result.err(), Some(CoachError::SignInFailed));
        assert!(fixture.provider.forms.lock().unwrap().is_empty());
        no_connection(&fixture).await;
    }

    #[tokio::test]
    async fn a_cancelled_sign_in_ends_at_once_as_cancelled() {
        let fixture = fixture(Duration::from_secs(30));
        let cancellation = CancellationToken::new();
        let stop = cancellation.clone();
        let started = std::time::Instant::now();
        let (result, asked) = sign_in(
            &fixture,
            &cancellation,
            // The user never comes back from the browser.
            Box::new(move |_| {
                stop.cancel();
                None
            }),
            |_| {},
        )
        .await;
        assert_eq!(result.err(), Some(CoachError::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(5));
        no_connection(&fixture).await;
        assert!(fixture.chatgpt.attempts.is_idle().await);
        // Its listener is closed.
        let asked = asked.unwrap();
        assert!(
            !fixture
                .chatgpt
                .attempts
                .late_callback_reaches(&asked["redirect_uri"], &asked["state"])
                .await
        );
    }

    #[tokio::test]
    async fn a_later_sign_in_that_returns_another_client_id_is_refused_and_keeps_the_connection() {
        let fixture = fixture(Duration::from_secs(10));
        let (first, _) = sign_in(
            &fixture,
            &CancellationToken::new(),
            approve(Some("oaiapp_issued")),
            good_answer(&fixture.provider, 1, "oaiapp_issued"),
        )
        .await;
        let handle = first.unwrap().connection.handle;
        let (second, _) = sign_in(
            &fixture,
            &CancellationToken::new(),
            approve(Some("oaiapp_other")),
            good_answer(&fixture.provider, 2, "oaiapp_other"),
        )
        .await;
        assert_eq!(second.err(), Some(CoachError::SignInFailed));
        // Nothing was exchanged for the refused callback, and the stored sign-in is untouched.
        assert_eq!(fixture.provider.forms.lock().unwrap().len(), 1);
        assert_eq!(stored(&fixture, &handle)["refreshToken"], "refresh-1");
    }

    #[tokio::test]
    async fn a_refresh_names_the_issued_client_and_tells_a_terminal_refusal_from_the_rest() {
        let provider = Provider::start();
        let chatgpt = provider.chatgpt(Duration::from_secs(1));
        provider.answer(StatusCode::OK, tokens(7, None, ALL_SCOPES));
        let issued = chatgpt.refresh("oaiapp_issued", "refresh-6").await;
        let Ok(issued) = issued else {
            panic!("the refresh succeeds");
        };
        assert_eq!(
            (issued.access.as_str(), issued.refresh.as_str()),
            ("access-7", "refresh-7")
        );
        assert_eq!(issued.expires_in, Duration::from_secs(3600));
        assert_eq!(
            provider.forms.lock().unwrap()[0],
            HashMap::from([
                ("grant_type".to_owned(), "refresh_token".to_owned()),
                ("client_id".to_owned(), "oaiapp_issued".to_owned()),
                ("refresh_token".to_owned(), "refresh-6".to_owned()),
                (
                    "resource".to_owned(),
                    "https://api.openai.com/v1".to_owned()
                ),
            ])
        );

        for code in TERMINAL_REFRESH_ERRORS {
            provider.answer(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": code }),
            );
            assert!(
                matches!(
                    chatgpt.refresh("oaiapp_issued", "refresh-6").await,
                    Err(RefreshError::Terminal)
                ),
                "{code}"
            );
        }
        // The nested error shape is read as well.
        provider.answer(
            StatusCode::UNAUTHORIZED,
            serde_json::json!({ "error": { "code": "refresh_token_reused", "message": "x" } }),
        );
        assert!(matches!(
            chatgpt.refresh("oaiapp_issued", "refresh-6").await,
            Err(RefreshError::Terminal)
        ));
        for (status, body, expected) in [
            (
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": "invalid_client" }),
                CoachError::ProviderFailure,
            ),
            (
                StatusCode::TOO_MANY_REQUESTS,
                Value::Null,
                CoachError::RateLimited,
            ),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Value::Null,
                CoachError::ProviderFailure,
            ),
            (
                StatusCode::FORBIDDEN,
                serde_json::json!({
                    "error": { "code": "subscription_sharing_user_not_eligible" }
                }),
                CoachError::SubscriptionNotEligible,
            ),
            (
                StatusCode::GATEWAY_TIMEOUT,
                Value::Null,
                CoachError::ProviderTimeout,
            ),
            (
                StatusCode::OK,
                serde_json::json!({ "access_token": "", "refresh_token": "r", "expires_in": 3600 }),
                CoachError::ProviderFailure,
            ),
        ] {
            provider.answer(status, body);
            assert!(
                matches!(
                    chatgpt.refresh("oaiapp_issued", "refresh-6").await,
                    Err(RefreshError::Other(error)) if error == expected
                ),
                "{status}"
            );
        }
    }

    #[tokio::test]
    async fn a_revocation_counts_only_when_the_provider_confirmed_it() {
        let provider = Provider::start();
        let chatgpt = provider.chatgpt(Duration::from_secs(1));
        assert!(chatgpt.revoke("oaiapp_issued", "refresh-1").await);
        assert_eq!(
            provider.revocations.lock().unwrap()[0],
            HashMap::from([
                ("token".to_owned(), "refresh-1".to_owned()),
                ("token_type_hint".to_owned(), "refresh_token".to_owned()),
                ("client_id".to_owned(), "oaiapp_issued".to_owned()),
            ])
        );
        *provider.revoke_status.lock().unwrap() = StatusCode::INTERNAL_SERVER_ERROR;
        assert!(!chatgpt.revoke("oaiapp_issued", "refresh-1").await);
        drop(provider);
        assert!(!chatgpt.revoke("oaiapp_issued", "refresh-1").await);
    }

    #[test]
    fn the_listener_prefers_the_documented_port_then_a_second_one_then_any() {
        let chatgpt = ChatGpt::new(reqwest::Client::new());
        assert_eq!(chatgpt.listener.path, "/auth/callback");
        assert_eq!(chatgpt.listener.ports, [1455, 1457, 0]);
        assert_eq!(chatgpt.sign_in_timeout, Duration::from_secs(180));
    }

    #[test]
    fn links_for_the_browser_are_opened_only_on_their_own_host() {
        let opened = Arc::new(Mutex::new(Vec::new()));
        let opener: BrowserOpener = Arc::new({
            let opened = opened.clone();
            move |url: &str| {
                opened.lock().unwrap().push(url.to_owned());
                Ok(())
            }
        });
        let chatgpt = ChatGpt::new(reqwest::Client::new());
        chatgpt.open_usage(&opener).unwrap();
        assert_eq!(
            opened.lock().unwrap().as_slice(),
            ["https://chatgpt.com/settings/usage"]
        );
        assert_eq!(
            open_on(
                "https://auth.openai.com.evil.example/x",
                AUTHORIZE_HOST,
                &opener
            ),
            Err(CoachError::ProviderFailure)
        );
        assert_eq!(opened.lock().unwrap().len(), 1);
        let failing: BrowserOpener = Arc::new(|_| Err("no browser".into()));
        assert_eq!(chatgpt.open_usage(&failing), Err(CoachError::SignInFailed));
    }

    #[test]
    fn the_identity_needs_three_parts_and_a_readable_subject() {
        let claims = serde_json::json!({
            "iss": "https://auth.openai.com",
            "aud": ["other", "oaiapp_issued"],
            "exp": 2000,
            "nonce": "n",
            "sub": "user-123",
            "email": "not an address",
        });
        let token = id_token(claims.clone());
        let read =
            |token: &str| identity(token, "https://auth.openai.com", "oaiapp_issued", "n", 1000);
        let found = read(&token).expect("an audience list that names the client is accepted");
        assert_eq!(found.subject, "user-123");
        assert_eq!(found.email, None, "a value that is no address is not shown");
        assert!(read(&format!("{token}.extra")).is_none());
        assert!(read("only.two").is_none());
        assert!(read("a.!!!.c").is_none());
        let mut nameless = claims;
        nameless["sub"] = "".into();
        assert!(read(&id_token(nameless)).is_none());
        // Exactly at its expiry the token is over.
        assert!(identity(
            &token,
            "https://auth.openai.com",
            "oaiapp_issued",
            "n",
            2000
        )
        .is_none());
    }
}
