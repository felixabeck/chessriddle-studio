use axum::{
    extract::Query,
    response::{Html, IntoResponse},
    routing::get,
    Extension, Router,
};
use log::{error, warn};
use oauth2::{
    basic::{BasicClient, BasicTokenResponse},
    AuthUrl, AuthorizationCode, ClientId, CsrfToken, HttpRequest, HttpResponse, PkceCodeChallenge,
    PkceCodeVerifier, RedirectUrl, Scope, TokenUrl,
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    future::Future,
    net::TcpListener,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    sync::{oneshot, Mutex},
    task::JoinHandle,
};

use crate::error::Error;

pub(crate) const OAUTH_FAILURE: &str = "OAuth authentication failed";
const LISTENER_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
pub(crate) const MAX_OAUTH_RESPONSE_BYTES: usize = 64 * 1024;

pub(crate) async fn safe_oauth_http_client(
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

pub(crate) fn oauth_response_from_reqwest(
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

/// A single attempt uses this provider for both authorization and code exchange.
/// Callers supply provider-specific scopes and authorization parameters.
pub(crate) struct OAuthProvider<'a> {
    pub authorization_url: &'a str,
    pub token_url: &'a str,
    pub client_id: &'a str,
    pub scopes: &'a [&'a str],
    pub extra_params: &'a [(&'a str, &'a str)],
}

#[derive(Default)]
pub(crate) struct AttemptRegistry {
    active: Mutex<HashMap<u64, AuthTransaction>>,
    next_generation: AtomicU64,
}

struct AuthTransaction {
    csrf_token: CsrfToken,
    callback_tx: Option<oneshot::Sender<CallbackSignal>>,
}

pub(crate) enum CallbackSignal {
    Code(AuthorizationCode),
    Rejected,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CallbackResult {
    AcceptedCode,
    AcceptedRejection,
    Mismatch,
    Missing,
    Closed,
}

impl AttemptRegistry {
    pub(crate) async fn begin(
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

    pub(crate) async fn clear_generation(&self, generation: u64) {
        let mut active = self.active.lock().await;
        active.remove(&generation);
    }

    pub(crate) async fn accept_callback(&self, query: CallbackQuery) -> CallbackResult {
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
    pub(crate) async fn active_state(&self) -> Option<CsrfToken> {
        self.active
            .lock()
            .await
            .values()
            .next()
            .map(|attempt| attempt.csrf_token.clone())
    }

    #[cfg(test)]
    pub(crate) async fn is_idle(&self) -> bool {
        self.active.lock().await.is_empty()
    }
}

pub struct ListenerHandle {
    pub(crate) redirect_url: String,
    pub(crate) shutdown_tx: Option<oneshot::Sender<()>>,
    pub(crate) task: JoinHandle<Result<(), String>>,
    pub(crate) task_completed: bool,
}

pub(crate) fn start_listener_and_server(
    lifecycle: Arc<AttemptRegistry>,
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

pub(crate) async fn exchange_code(
    http_client: &reqwest::Client,
    client: &BasicClient,
    code: AuthorizationCode,
    verifier: PkceCodeVerifier,
) -> Result<BasicTokenResponse, Error> {
    client
        .exchange_code(code)
        .set_pkce_verifier(verifier)
        .request_async(|request| safe_oauth_http_client(http_client, request))
        .await
        .map_err(|source| {
            error!("OAuth token exchange failed: {source}");
            Error::OAuthFailure(OAUTH_FAILURE.into())
        })
}

/// Owns the callback transaction and listener through completion, error and timeout.
/// The code callback finishes inside the same deadline before listener cleanup.
pub(crate) async fn authenticate<O, L, C, F>(
    provider: OAuthProvider<'_>,
    lifecycle: Arc<AttemptRegistry>,
    timeout_duration: Duration,
    start_listener: L,
    open_browser: O,
    on_code: C,
) -> Result<(), Error>
where
    O: FnOnce(&str) -> Result<(), String>,
    L: FnOnce() -> Result<ListenerHandle, Error>,
    C: FnOnce(BasicClient, AuthorizationCode, PkceCodeVerifier) -> F,
    F: Future<Output = Result<(), Error>>,
{
    let csrf_token = CsrfToken::new_random();
    let deadline = tokio::time::Instant::now() + timeout_duration;
    let (generation, callback_rx) = lifecycle.begin(csrf_token.clone()).await?;
    let mut listener = match start_listener() {
        Ok(listener) => listener,
        Err(source) => {
            error!("OAuth callback listener setup failed: {source}");
            lifecycle.clear_generation(generation).await;
            return Err(Error::OAuthFailure(OAUTH_FAILURE.into()));
        }
    };

    let result = match tokio::time::timeout(
        deadline.saturating_duration_since(tokio::time::Instant::now()),
        authenticate_after_listener(
            provider,
            csrf_token,
            callback_rx,
            &mut listener,
            open_browser,
            on_code,
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
    result
}

async fn authenticate_after_listener<O, C, F>(
    provider: OAuthProvider<'_>,
    csrf_token: CsrfToken,
    callback_rx: oneshot::Receiver<CallbackSignal>,
    listener: &mut ListenerHandle,
    open_browser: O,
    on_code: C,
) -> Result<(), Error>
where
    O: FnOnce(&str) -> Result<(), String>,
    C: FnOnce(BasicClient, AuthorizationCode, PkceCodeVerifier) -> F,
    F: Future<Output = Result<(), Error>>,
{
    let client = match oauth_client(&listener.redirect_url, &provider) {
        Ok(client) => client,
        Err(source) => {
            error!("OAuth client setup failed: {source}");
            return Err(Error::OAuthFailure(OAUTH_FAILURE.into()));
        }
    };
    let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
    let mut authorization = client.authorize_url(|| csrf_token);
    for scope in provider.scopes {
        authorization = authorization.add_scope(Scope::new((*scope).into()));
    }
    for (name, value) in provider.extra_params {
        authorization = authorization.add_extra_param(*name, *value);
    }
    let (authorization_url, _) = authorization.set_pkce_challenge(pkce_challenge).url();

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
            Ok(CallbackSignal::Code(code)) => on_code(client, code, pkce_verifier).await,
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

fn oauth_client(redirect_url: &str, provider: &OAuthProvider<'_>) -> Result<BasicClient, String> {
    let auth_url =
        AuthUrl::new(provider.authorization_url.into()).map_err(|source| source.to_string())?;
    let token_url =
        TokenUrl::new(provider.token_url.into()).map_err(|source| source.to_string())?;
    let redirect_url =
        RedirectUrl::new(redirect_url.into()).map_err(|source| source.to_string())?;
    Ok(BasicClient::new(
        ClientId::new(provider.client_id.into()),
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
pub(crate) struct CallbackQuery {
    pub code: Option<AuthorizationCode>,
    pub state: Option<CsrfToken>,
    pub error: Option<String>,
}

async fn authorize(
    Extension(lifecycle): Extension<Arc<AttemptRegistry>>,
    Query(query): Query<CallbackQuery>,
) -> impl IntoResponse {
    callback_page(lifecycle.accept_callback(query).await)
}

pub(crate) fn callback_page(result: CallbackResult) -> Html<&'static str> {
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
    use axum::{extract::Form, routing::post, Json};
    use oauth2::TokenResponse;

    struct TokenFixture {
        url: String,
        forms: Arc<Mutex<Vec<HashMap<String, String>>>>,
        shutdown: oneshot::Sender<()>,
        task: JoinHandle<()>,
    }

    impl TokenFixture {
        fn new(status: axum::http::StatusCode, body: serde_json::Value) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/token", listener.local_addr().unwrap());
            let forms = Arc::new(Mutex::new(Vec::new()));
            let recorded = forms.clone();
            let router = Router::new().route(
                "/token",
                post(move |Form(form): Form<HashMap<String, String>>| {
                    let recorded = recorded.clone();
                    let body = body.clone();
                    async move {
                        recorded.lock().await.push(form);
                        (status, Json(body))
                    }
                }),
            );
            let (shutdown, shutdown_rx) = oneshot::channel();
            let server = axum::Server::from_tcp(listener)
                .unwrap()
                .serve(router.into_make_service())
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                });
            let task = tokio::spawn(async move {
                server.await.unwrap();
            });
            Self {
                url,
                forms,
                shutdown,
                task,
            }
        }

        async fn stop(self) {
            let _ = self.shutdown.send(());
            self.task.await.unwrap();
        }
    }

    async fn provider_attempt(
        registry: Arc<AttemptRegistry>,
        token_url: &str,
        name: &str,
        opened: tokio::sync::mpsc::UnboundedSender<url::Url>,
    ) -> Result<(), Error> {
        let provider = OAuthProvider {
            authorization_url: "https://provider.invalid/authorize",
            token_url,
            client_id: name,
            scopes: &["account:read"],
            extra_params: &[("account", name)],
        };
        let listener_registry = registry.clone();
        authenticate(
            provider,
            registry,
            Duration::from_secs(5),
            move || start_listener_and_server(listener_registry),
            move |url| {
                opened.send(url::Url::parse(url).unwrap()).unwrap();
                Ok(())
            },
            move |client, code, verifier| async move {
                let http = reqwest::Client::builder().no_proxy().build().unwrap();
                let token = exchange_code(&http, &client, code, verifier).await?;
                assert_eq!(token.access_token().secret(), name);
                Ok(())
            },
        )
        .await
    }

    #[tokio::test]
    async fn concurrent_attempts_exchange_only_with_their_provider_and_pkce_verifier() {
        let first = TokenFixture::new(
            axum::http::StatusCode::OK,
            serde_json::json!({"access_token": "first", "token_type": "Bearer"}),
        );
        let second = TokenFixture::new(
            axum::http::StatusCode::OK,
            serde_json::json!({"access_token": "second", "token_type": "Bearer"}),
        );
        let registry = Arc::new(AttemptRegistry::default());
        let (opened, mut urls) = tokio::sync::mpsc::unbounded_channel();
        let browser = async {
            let http = reqwest::Client::builder().no_proxy().build().unwrap();
            let mut authorizations = HashMap::new();
            for _ in 0..2 {
                let url: url::Url = urls.recv().await.unwrap();
                assert_eq!(
                    url.as_str().split('?').next(),
                    Some("https://provider.invalid/authorize")
                );
                let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
                assert_eq!(query["scope"], "account:read");
                assert_eq!(query["code_challenge_method"], "S256");
                assert_eq!(query["account"], query["client_id"]);
                let redirect = url::Url::parse(&query["redirect_uri"]).unwrap();
                assert_eq!(redirect.host_str(), Some("127.0.0.1"));
                assert!(redirect.port().is_some());
                assert_eq!(redirect.path(), "/callback");
                let response = http
                    .get(redirect)
                    .query(&[("state", &query["state"]), ("code", &query["client_id"])])
                    .send()
                    .await
                    .unwrap();
                assert_eq!(
                    response.text().await.unwrap(),
                    "Authentication successful! You can close this window."
                );
                authorizations.insert(query["client_id"].clone(), query);
            }
            authorizations
        };
        let (first_result, second_result, authorizations) =
            tokio::time::timeout(Duration::from_secs(10), async {
                tokio::join!(
                    provider_attempt(registry.clone(), &first.url, "first", opened.clone()),
                    provider_attempt(registry.clone(), &second.url, "second", opened),
                    browser,
                )
            })
            .await
            .expect("both provider attempts must finish");
        assert!(first_result.is_ok());
        assert!(second_result.is_ok());
        assert!(registry.is_idle().await);
        assert_ne!(
            authorizations["first"]["state"],
            authorizations["second"]["state"]
        );
        for (fixture, name) in [(&first, "first"), (&second, "second")] {
            let forms = fixture.forms.lock().await;
            assert_eq!(forms.len(), 1);
            let form = &forms[0];
            assert_eq!(form["code"], name);
            assert_eq!(form["client_id"], name);
            assert_eq!(form["grant_type"], "authorization_code");
            assert_eq!(form["redirect_uri"], authorizations[name]["redirect_uri"]);
            let verifier = PkceCodeVerifier::new(form["code_verifier"].clone());
            assert_eq!(
                PkceCodeChallenge::from_code_verifier_sha256(&verifier).as_str(),
                authorizations[name]["code_challenge"],
            );
        }
        first.stop().await;
        second.stop().await;
    }

    #[tokio::test]
    async fn exchange_errors_return_no_provider_response_or_credential_data() {
        let fixture = TokenFixture::new(
            axum::http::StatusCode::BAD_REQUEST,
            serde_json::json!({"error": "invalid_grant", "error_description": "private-token"}),
        );
        let provider = OAuthProvider {
            authorization_url: "https://provider.invalid/authorize",
            token_url: &fixture.url,
            client_id: "client",
            scopes: &[],
            extra_params: &[],
        };
        let client = oauth_client("http://127.0.0.1:1234/callback", &provider).unwrap();
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let result = exchange_code(
            &http,
            &client,
            AuthorizationCode::new("private-code".into()),
            PkceCodeVerifier::new("private-verifier".into()),
        )
        .await;
        assert!(matches!(result, Err(Error::OAuthFailure(message)) if message == OAUTH_FAILURE));
        fixture.stop().await;
    }
}
