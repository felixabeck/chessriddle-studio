//! The tokens of the signed-in connections.
//!
//! One worker task owns them: every use of a refresh token goes through its bounded queue, so two
//! turns that find the same access token refused cause one refresh, and no lock is held while the
//! provider or the keyring is being talked to. A caller gets an access token and does its request
//! itself; the worker is never busy with a model's answer.

use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use tokio::sync::{mpsc, oneshot};

use super::{
    chatgpt::ChatGpt,
    connections::{Connections, Secret},
    error::CoachError,
    grok::Grok,
};
use crate::{
    credentials::CoachConnectionHandle,
    infra::token_session::{
        Bearer, BearerError, IssuedTokens, RefreshError, TokenAuthority, TokenSession,
    },
};

/// Requests that may wait for the worker; a further one is refused as `busy`.
const QUEUE_CAPACITY: usize = 16;

enum Action {
    /// A usable access token of the connection.
    Bearer(CoachConnectionHandle),
    /// The token of this generation was refused as unauthorized: a newer one.
    Rejected(CoachConnectionHandle, u64),
    /// A sign-in just stored this connection; these are the tokens that came with it.
    SignedIn(CoachConnectionHandle, SignInProvider, IssuedTokens),
    /// The connection was removed or changed behind the worker's back: forget what is held.
    Forget(CoachConnectionHandle),
}

/// What the worker answers with.
enum Reply {
    Bearer(Bearer),
    Done,
    /// What a forgotten connection still held, if anything.
    Forgotten(Option<HeldSignIn>),
}

struct Request {
    action: Action,
    reply: oneshot::Sender<Result<Reply, CoachError>>,
}

/// The sign-in a removed connection still held in memory: its provider and its newest refresh
/// token, which a rotation may not have brought to the keyring yet. No `Debug`: it is a token.
pub(crate) struct HeldSignIn {
    pub provider: SignInProvider,
    pub refresh: String,
}

/// Where a signed-in connection's refresh token is exchanged, with what that provider needs
/// named beside the token.
pub(crate) enum SignInProvider {
    /// The client id the provider issued to this installation.
    ChatGpt { client_id: String },
    /// The token endpoint the provider named at the sign-in.
    Grok { token_endpoint: String },
}

/// A signed-in connection as the worker holds it.
struct Signed {
    provider: SignInProvider,
    tokens: TokenSession,
}

/// The provider and the keyring entry behind one signed-in connection.
struct Keeper<'a> {
    chatgpt: &'a ChatGpt,
    grok: &'a Grok,
    connections: &'a Connections,
    handle: &'a CoachConnectionHandle,
    provider: &'a SignInProvider,
}

#[async_trait]
impl TokenAuthority for Keeper<'_> {
    type Error = CoachError;

    async fn refresh(&mut self, refresh: &str) -> Result<IssuedTokens, RefreshError<CoachError>> {
        match self.provider {
            SignInProvider::ChatGpt { client_id } => self.chatgpt.refresh(client_id, refresh).await,
            SignInProvider::Grok { token_endpoint } => {
                self.grok.refresh(token_endpoint, refresh).await
            }
        }
    }

    async fn persist(&mut self, refresh: &str) -> Result<(), CoachError> {
        self.connections
            .set_refresh_token(self.handle.clone(), Some(refresh.to_owned()))
            .await
    }

    /// The connection stays where it is, without its refresh token: it is listed as "sign in
    /// again" and a new sign-in takes its place.
    async fn forget(&mut self) -> Result<(), CoachError> {
        self.connections
            .set_refresh_token(self.handle.clone(), None)
            .await
    }
}

struct Worker {
    connections: Connections,
    chatgpt: Arc<ChatGpt>,
    grok: Arc<Grok>,
    /// By handle. An entry exists from the first use after a start, or from a sign-in.
    sessions: HashMap<String, Signed>,
}

impl Worker {
    async fn bearer(&mut self, handle: CoachConnectionHandle) -> Result<Bearer, CoachError> {
        if !self.sessions.contains_key(&handle.0) {
            let (provider, refresh) = match self.connections.secret(handle.clone()).await? {
                Secret::ChatGpt(secret) => (
                    SignInProvider::ChatGpt {
                        client_id: secret.client_id,
                    },
                    secret.refresh_token,
                ),
                Secret::Grok(secret) => (
                    SignInProvider::Grok {
                        token_endpoint: secret.token_endpoint,
                    },
                    secret.refresh_token,
                ),
                Secret::Api { .. } => return Err(CoachError::InvalidInput),
            };
            let refresh = refresh.ok_or(CoachError::SignInAgain)?;
            self.sessions.insert(
                handle.0.clone(),
                Signed {
                    provider,
                    tokens: TokenSession::restored(refresh),
                },
            );
        }
        let Some(signed) = self.sessions.get_mut(&handle.0) else {
            return Err(CoachError::SignInAgain);
        };
        let mut keeper = Keeper {
            chatgpt: &self.chatgpt,
            grok: &self.grok,
            connections: &self.connections,
            handle: &handle,
            provider: &signed.provider,
        };
        match signed.tokens.bearer(&mut keeper).await {
            Ok(bearer) => Ok(bearer),
            Err(BearerError::Ended) => {
                self.sessions.remove(&handle.0);
                Err(CoachError::SignInAgain)
            }
            // A connection that was removed while its token was being refreshed is simply gone.
            Err(BearerError::Failed(CoachError::NotFound)) => {
                self.sessions.remove(&handle.0);
                Err(CoachError::NotFound)
            }
            Err(BearerError::Failed(error)) => Err(error),
        }
    }

    async fn execute(&mut self, action: Action) -> Result<Reply, CoachError> {
        match action {
            Action::Bearer(handle) => self.bearer(handle).await.map(Reply::Bearer),
            Action::Rejected(handle, generation) => {
                if let Some(signed) = self.sessions.get_mut(&handle.0) {
                    signed.tokens.rejected(generation);
                }
                self.bearer(handle).await.map(Reply::Bearer)
            }
            Action::SignedIn(handle, provider, tokens) => {
                self.sessions.insert(
                    handle.0,
                    Signed {
                        provider,
                        tokens: TokenSession::stored_sign_in(tokens),
                    },
                );
                Ok(Reply::Done)
            }
            Action::Forget(handle) => Ok(Reply::Forgotten(self.sessions.remove(&handle.0).map(
                |signed| HeldSignIn {
                    provider: signed.provider,
                    refresh: signed.tokens.into_revocable().refresh,
                },
            ))),
        }
    }
}

/// The door to the worker. Cloning it is cheap; the worker ends when the last door is dropped.
#[derive(Clone)]
pub(crate) struct Accounts {
    sender: mpsc::Sender<Request>,
}

impl Accounts {
    pub(crate) fn start(connections: Connections, chatgpt: Arc<ChatGpt>, grok: Arc<Grok>) -> Self {
        let (sender, mut receiver) = mpsc::channel::<Request>(QUEUE_CAPACITY);
        // The worker takes every accepted request to its end even if the caller is gone. Dropping
        // the last sender drains the queue, then drops every token.
        tauri::async_runtime::spawn(async move {
            let mut worker = Worker {
                connections,
                chatgpt,
                grok,
                sessions: HashMap::new(),
            };
            while let Some(request) = receiver.recv().await {
                let result = worker.execute(request.action).await;
                let _ = request.reply.send(result);
            }
        });
        Self { sender }
    }

    /// A request for an access token. A worker that answers with anything else has no token.
    async fn request(&self, action: Action) -> Result<Bearer, CoachError> {
        let (reply, receiver) = oneshot::channel();
        self.sender
            .try_send(Request { action, reply })
            .map_err(|_| CoachError::Busy)?;
        match receiver.await.map_err(|_| CoachError::Unavailable)?? {
            Reply::Bearer(bearer) => Ok(bearer),
            Reply::Done | Reply::Forgotten(_) => Err(CoachError::SignInAgain),
        }
    }

    /// A message the worker must not miss: it waits for a place in the queue instead of being
    /// refused. A session the worker went on holding after a new sign-in or a removal would
    /// spend a refresh token that is no longer the connection's.
    async fn tell(&self, action: Action) -> Result<Reply, CoachError> {
        let (reply, receiver) = oneshot::channel();
        self.sender
            .send(Request { action, reply })
            .await
            .map_err(|_| CoachError::Unavailable)?;
        receiver.await.map_err(|_| CoachError::Unavailable)?
    }

    pub(crate) async fn bearer(&self, handle: CoachConnectionHandle) -> Result<Bearer, CoachError> {
        self.request(Action::Bearer(handle)).await
    }

    /// A request with the token of `generation` was refused as unauthorized before any of its
    /// answer was read. The caller repeats the request once with what this returns.
    pub(crate) async fn rejected(
        &self,
        handle: CoachConnectionHandle,
        generation: u64,
    ) -> Result<Bearer, CoachError> {
        self.request(Action::Rejected(handle, generation)).await
    }

    pub(crate) async fn signed_in(
        &self,
        handle: CoachConnectionHandle,
        provider: SignInProvider,
        tokens: IssuedTokens,
    ) -> Result<(), CoachError> {
        self.tell(Action::SignedIn(handle, provider, tokens))
            .await
            .map(|_| ())
    }

    /// Drops what is held for a connection and hands it back: the caller withdraws the sign-in
    /// with it. `None` for a connection the worker held nothing for.
    pub(crate) async fn forget(
        &self,
        handle: CoachConnectionHandle,
    ) -> Result<Option<HeldSignIn>, CoachError> {
        match self.tell(Action::Forget(handle)).await? {
            Reply::Forgotten(held) => Ok(held),
            Reply::Bearer(_) | Reply::Done => Ok(None),
        }
    }
}

/// Where a model backend gets the access token of its connection.
#[async_trait]
pub(crate) trait BearerSource: Send + Sync {
    async fn bearer(&self) -> Result<Bearer, CoachError>;
    async fn rejected(&self, generation: u64) -> Result<Bearer, CoachError>;
}

/// The token of one signed-in connection, through the worker.
pub(crate) struct ConnectionBearer {
    pub accounts: Accounts,
    pub handle: CoachConnectionHandle,
}

#[async_trait]
impl BearerSource for ConnectionBearer {
    async fn bearer(&self) -> Result<Bearer, CoachError> {
        self.accounts.bearer(self.handle.clone()).await
    }

    async fn rejected(&self, generation: u64) -> Result<Bearer, CoachError> {
        self.accounts
            .rejected(self.handle.clone(), generation)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        coach::{
            chatgpt::tests::{tokens, Provider},
            connections::{ApiConnectionInput, ChatGptSecret, ConnectionStatus, GrokSecret},
            grok::tests::grok,
            test_server::FaultyStore,
        },
        credentials::{CoachCredentials, CredentialStore},
    };
    use axum::http::StatusCode;
    use std::{sync::atomic::Ordering, time::Duration};

    struct Fixture {
        provider: Provider,
        accounts: Accounts,
        connections: Connections,
        store: Arc<FaultyStore>,
        handle: CoachConnectionHandle,
        _directory: tempfile::TempDir,
    }

    async fn fixture() -> Fixture {
        let provider = Provider::start();
        let store = Arc::new(FaultyStore::default());
        let (credentials, directory) = CoachCredentials::for_test(store.clone());
        let connections = Connections::new(Arc::new(credentials));
        let saved = connections
            .save_chatgpt(ChatGptSecret {
                client_id: "oaiapp_issued".into(),
                refresh_token: Some("refresh-0".into()),
                subject: "user-123".into(),
                email: None,
            })
            .await
            .unwrap();
        let accounts = Accounts::start(
            connections.clone(),
            Arc::new(provider.chatgpt(Duration::from_secs(1))),
            Arc::new(grok(&provider.server)),
        );
        Fixture {
            provider,
            accounts,
            connections,
            store,
            handle: saved.connection.handle,
            _directory: directory,
        }
    }

    fn rotation(provider: &Provider, n: u32) {
        provider.answer(StatusCode::OK, tokens(n, None, ""));
    }

    fn stored_refresh(fixture: &Fixture) -> Option<String> {
        let stored = fixture
            .store
            .get(&format!("coach-connection:{}", fixture.handle.0))
            .unwrap()
            .unwrap();
        serde_json::from_str::<serde_json::Value>(&stored).unwrap()["refreshToken"]
            .as_str()
            .map(str::to_owned)
    }

    fn refreshes(fixture: &Fixture) -> usize {
        fixture.provider.forms.lock().unwrap().len()
    }

    #[tokio::test]
    async fn the_first_use_refreshes_stores_the_rotation_and_later_uses_share_the_token() {
        let fixture = fixture().await;
        rotation(&fixture.provider, 1);
        let (first, second, third) = tokio::join!(
            fixture.accounts.bearer(fixture.handle.clone()),
            fixture.accounts.bearer(fixture.handle.clone()),
            fixture.accounts.bearer(fixture.handle.clone()),
        );
        for bearer in [first, second, third] {
            let bearer = bearer.unwrap();
            assert_eq!((bearer.token.as_str(), bearer.generation), ("access-1", 1));
        }
        // Three callers at once, one exchange, with the stored token and the issued client.
        assert_eq!(refreshes(&fixture), 1);
        let form = fixture.provider.forms.lock().unwrap()[0].clone();
        assert_eq!(form["refresh_token"], "refresh-0");
        assert_eq!(form["client_id"], "oaiapp_issued");
        assert_eq!(stored_refresh(&fixture).as_deref(), Some("refresh-1"));
    }

    #[tokio::test]
    async fn any_number_of_refusals_of_one_token_cause_one_refresh() {
        let fixture = fixture().await;
        rotation(&fixture.provider, 1);
        let first = fixture
            .accounts
            .bearer(fixture.handle.clone())
            .await
            .unwrap();
        rotation(&fixture.provider, 2);
        let (one, two) = tokio::join!(
            fixture
                .accounts
                .rejected(fixture.handle.clone(), first.generation),
            fixture
                .accounts
                .rejected(fixture.handle.clone(), first.generation),
        );
        let (one, two) = (one.unwrap(), two.unwrap());
        assert_eq!(one.token, "access-2");
        assert_eq!(
            (two.token.as_str(), two.generation),
            ("access-2", one.generation)
        );
        assert_eq!(refreshes(&fixture), 2);
        assert_eq!(stored_refresh(&fixture).as_deref(), Some("refresh-2"));
    }

    #[tokio::test]
    async fn a_rotation_that_could_not_be_stored_fails_once_and_is_stored_by_the_next_use() {
        let fixture = fixture().await;
        rotation(&fixture.provider, 1);
        fixture.store.fail_next_write.store(true, Ordering::SeqCst);
        assert_eq!(
            fixture.accounts.bearer(fixture.handle.clone()).await.err(),
            Some(CoachError::Storage)
        );
        assert_eq!(stored_refresh(&fixture).as_deref(), Some("refresh-0"));
        // The rotated tokens were kept: no second exchange with the token that is spent.
        let bearer = fixture
            .accounts
            .bearer(fixture.handle.clone())
            .await
            .unwrap();
        assert_eq!(bearer.token, "access-1");
        assert_eq!(refreshes(&fixture), 1);
        assert_eq!(stored_refresh(&fixture).as_deref(), Some("refresh-1"));
    }

    #[tokio::test]
    async fn a_session_the_provider_ended_asks_for_a_new_sign_in_and_keeps_the_connection() {
        let fixture = fixture().await;
        fixture.provider.answer(
            StatusCode::BAD_REQUEST,
            serde_json::json!({ "error": "refresh_token_reused" }),
        );
        assert_eq!(
            fixture.accounts.bearer(fixture.handle.clone()).await.err(),
            Some(CoachError::SignInAgain)
        );
        // The connection keeps its place and its client id, without a refresh token.
        let listed = fixture.connections.list().await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status, ConnectionStatus::SignInAgain);
        assert_eq!(stored_refresh(&fixture), None);
        let (_, secret) = fixture.connections.chatgpt().await.unwrap().unwrap();
        assert_eq!(secret.client_id, "oaiapp_issued");
        // Asking again does not reach the provider any more.
        assert_eq!(
            fixture.accounts.bearer(fixture.handle.clone()).await.err(),
            Some(CoachError::SignInAgain)
        );
        assert_eq!(refreshes(&fixture), 1);
    }

    #[tokio::test]
    async fn another_refresh_failure_is_reported_and_leaves_the_sign_in_alone() {
        let fixture = fixture().await;
        fixture
            .provider
            .answer(StatusCode::TOO_MANY_REQUESTS, serde_json::Value::Null);
        assert_eq!(
            fixture.accounts.bearer(fixture.handle.clone()).await.err(),
            Some(CoachError::RateLimited)
        );
        assert_eq!(stored_refresh(&fixture).as_deref(), Some("refresh-0"));
        rotation(&fixture.provider, 1);
        assert!(fixture
            .accounts
            .bearer(fixture.handle.clone())
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn a_sign_in_hands_over_its_tokens_and_needs_no_refresh() {
        let fixture = fixture().await;
        fixture
            .accounts
            .signed_in(
                fixture.handle.clone(),
                SignInProvider::ChatGpt {
                    client_id: "oaiapp_issued".into(),
                },
                IssuedTokens {
                    access: "signed-in-access".into(),
                    refresh: "refresh-0".into(),
                    expires_in: Duration::from_secs(3600),
                },
            )
            .await
            .unwrap();
        let bearer = fixture
            .accounts
            .bearer(fixture.handle.clone())
            .await
            .unwrap();
        assert_eq!(bearer.token, "signed-in-access");
        // Neither the provider nor the keyring was touched: the sign-in stored its own result.
        assert_eq!(refreshes(&fixture), 0);
        assert_eq!(stored_refresh(&fixture).as_deref(), Some("refresh-0"));
    }

    #[tokio::test]
    async fn a_grok_sign_in_is_refreshed_at_its_own_token_endpoint() {
        let fixture = fixture().await;
        let saved = fixture
            .connections
            .save_grok(GrokSecret {
                token_endpoint: fixture.provider.server.url("/token"),
                refresh_token: Some("grok-refresh-0".into()),
                email: None,
            })
            .await
            .unwrap();
        let handle = saved.connection.handle;
        // The provider rotates; an answer without a new refresh token keeps the one in use.
        fixture.provider.answer(
            StatusCode::OK,
            serde_json::json!({ "access_token": "grok-access-1", "expires_in": 3600 }),
        );
        let bearer = fixture.accounts.bearer(handle.clone()).await.unwrap();
        assert_eq!(bearer.token, "grok-access-1");
        let form = fixture.provider.forms.lock().unwrap()[0].clone();
        assert_eq!(form["grant_type"], "refresh_token");
        assert_eq!(form["refresh_token"], "grok-refresh-0");
        assert_eq!(form["client_id"], crate::coach::grok::CLIENT_ID);
        assert!(!form.contains_key("resource"));
        let (_, secret) = fixture.connections.grok().await.unwrap().unwrap();
        assert_eq!(secret.refresh_token.as_deref(), Some("grok-refresh-0"));

        // A plan that may not be used from other apps is not a reason to sign in again.
        fixture
            .provider
            .answer(StatusCode::FORBIDDEN, serde_json::Value::Null);
        assert_eq!(
            fixture
                .accounts
                .rejected(handle.clone(), bearer.generation)
                .await
                .err(),
            Some(CoachError::SubscriptionNotEligible)
        );
        let (_, secret) = fixture.connections.grok().await.unwrap().unwrap();
        assert!(secret.refresh_token.is_some());

        // A refused refresh token ends the session; the connection keeps its place.
        fixture
            .provider
            .answer(StatusCode::BAD_REQUEST, serde_json::Value::Null);
        assert_eq!(
            fixture.accounts.bearer(handle.clone()).await.err(),
            Some(CoachError::SignInAgain)
        );
        let (kept, secret) = fixture.connections.grok().await.unwrap().unwrap();
        assert_eq!(kept, handle);
        assert_eq!(secret.refresh_token, None);
    }

    #[tokio::test]
    async fn forgetting_hands_back_the_newest_token_also_one_the_keyring_never_got() {
        let fixture = fixture().await;
        // Nothing held yet: nothing to hand back.
        assert!(fixture
            .accounts
            .forget(fixture.handle.clone())
            .await
            .unwrap()
            .is_none());

        // A rotation whose write to the keyring fails stays in memory only.
        rotation(&fixture.provider, 1);
        fixture.store.fail_next_write.store(true, Ordering::SeqCst);
        assert_eq!(
            fixture.accounts.bearer(fixture.handle.clone()).await.err(),
            Some(CoachError::Storage)
        );
        assert_eq!(stored_refresh(&fixture).as_deref(), Some("refresh-0"));
        let held = fixture
            .accounts
            .forget(fixture.handle.clone())
            .await
            .unwrap()
            .expect("the session was held");
        // The token to withdraw is the one the provider issued last, not the spent stored one.
        assert_eq!(held.refresh, "refresh-1");
        assert!(matches!(
            held.provider,
            SignInProvider::ChatGpt { ref client_id } if client_id == "oaiapp_issued"
        ));
        // Handed back once; the worker holds nothing any more.
        assert!(fixture
            .accounts
            .forget(fixture.handle.clone())
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn a_removed_or_foreign_connection_has_no_token() {
        let fixture = fixture().await;
        rotation(&fixture.provider, 1);
        fixture
            .accounts
            .bearer(fixture.handle.clone())
            .await
            .unwrap();

        // An API connection is not a sign-in.
        let api = fixture
            .connections
            .save_api(ApiConnectionInput {
                handle: None,
                label: "Local".into(),
                address: "http://localhost:11434/v1".into(),
                key: None,
            })
            .await
            .unwrap();
        assert_eq!(
            fixture.accounts.bearer(api.connection.handle).await.err(),
            Some(CoachError::InvalidInput)
        );

        // Removed: what the worker held is dropped, and nothing is found for it afterwards.
        fixture
            .connections
            .remove(fixture.handle.clone())
            .await
            .unwrap();
        fixture
            .accounts
            .forget(fixture.handle.clone())
            .await
            .unwrap();
        assert_eq!(
            fixture.accounts.bearer(fixture.handle.clone()).await.err(),
            Some(CoachError::NotFound)
        );
        assert_eq!(refreshes(&fixture), 1);
    }

    #[tokio::test]
    async fn a_connection_removed_while_it_is_refreshed_is_gone_without_a_trace() {
        let fixture = fixture().await;
        rotation(&fixture.provider, 1);
        let bearer = fixture
            .accounts
            .bearer(fixture.handle.clone())
            .await
            .unwrap();
        fixture
            .connections
            .remove(fixture.handle.clone())
            .await
            .unwrap();
        // The worker still holds the session; its next rotation finds no place to store.
        rotation(&fixture.provider, 2);
        assert_eq!(
            fixture
                .accounts
                .rejected(fixture.handle.clone(), bearer.generation)
                .await
                .err(),
            Some(CoachError::NotFound)
        );
        assert!(fixture.connections.list().await.unwrap().is_empty());
    }
}
