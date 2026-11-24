//! Coach connections: what the user connected, stored natively.
//!
//! A connection's secret is one JSON document in the OS keyring that holds the connection kind
//! and everything that belongs to it together: an address with its key, so that a key can never be
//! paired with another address by a later edit, or a sign-in's client id with its refresh token.
//! The journaled credential registry holds only the handle and the display label.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;

use super::{address::Address, error::CoachError};
use crate::credentials::{CoachConnectionHandle, CoachCredentials, MAX_KEYRING_SECRET_UTF16_UNITS};

pub(crate) const MAX_CONNECTIONS: usize = 16;
/// The labels of the sign-in connections, of which there is one each. The account is shown
/// beside the label.
const CHATGPT_LABEL: &str = "ChatGPT";
const GROK_LABEL: &str = "Grok";
const MAX_LABEL_CHARS: usize = 64;
const MAX_KEY_BYTES: usize = 512;

/// The keyring document. It must never implement `Debug`: it carries the key.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Secret {
    Api {
        address: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<String>,
    },
    /// A sign-in with ChatGPT.
    ChatGpt(ChatGptSecret),
    /// A sign-in with Grok.
    Grok(GrokSecret),
}

/// What a Grok sign-in leaves on this computer. No `Debug`: it carries the refresh token.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrokSecret {
    /// The token endpoint the provider named at the sign-in. It is checked again before every
    /// use: a stored address is not trusted for what it was.
    pub token_endpoint: String,
    /// Absent once the provider has ended the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// For display only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

/// What a ChatGPT sign-in leaves on this computer. No `Debug`: it carries the refresh token.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatGptSecret {
    /// The client id the provider issued to this installation at its first sign-in.
    pub client_id: String,
    /// Absent once the provider has ended the session: the user has to sign in again, and the
    /// connection keeps its place and its client id until then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// The account's stable identity at the provider.
    pub subject: String,
    /// For display only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

impl Secret {
    /// The refresh token of a sign-in; `None` for an address, and for a sign-in that has ended.
    fn refresh_token_mut(&mut self) -> Option<&mut Option<String>> {
        match self {
            Self::Api { .. } => None,
            Self::ChatGpt(secret) => Some(&mut secret.refresh_token),
            Self::Grok(secret) => Some(&mut secret.refresh_token),
        }
    }

    fn encode(&self) -> Result<String, CoachError> {
        let encoded = serde_json::to_string(self).map_err(|_| CoachError::Storage)?;
        if encoded.encode_utf16().count() > MAX_KEYRING_SECRET_UTF16_UNITS {
            return Err(CoachError::Storage);
        }
        Ok(encoded)
    }

    fn decode(stored: &str) -> Option<Self> {
        serde_json::from_str(stored).ok()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConnectionKind {
    Api,
    ChatGpt,
    Grok,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConnectionStatus {
    Ready,
    /// The stored secret is missing or cannot be read; the connection can be re-entered or removed.
    NeedsRepair,
    /// The provider ended the sign-in; signing in again restores the connection.
    SignInAgain,
    /// The keyring could not be asked just now, so nothing but the name is known. The
    /// connection itself may be fine.
    StorageUnavailable,
}

/// Everything the renderer may know about a connection. No key or token is part of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionSummary {
    pub handle: CoachConnectionHandle,
    pub kind: ConnectionKind,
    pub label: String,
    pub address: Option<String>,
    pub has_key: bool,
    /// The signed-in account, for a sign-in connection whose provider told its email.
    pub account: Option<String>,
    pub status: ConnectionStatus,
}

/// An API connection as entered in Settings. No `Debug`: it may carry a key.
#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApiConnectionInput {
    /// Absent for a new connection.
    #[specta(optional)]
    pub handle: Option<CoachConnectionHandle>,
    pub label: String,
    pub address: String,
    /// Absent or empty keeps the stored key, which is only possible on the same host.
    #[specta(optional)]
    pub key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionSaved {
    pub connection: ConnectionSummary,
    pub durability_uncertain: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionRemoved {
    pub durability_uncertain: bool,
    /// The connection is gone here, but its sign-in could not be withdrawn at the provider.
    pub revocation_pending: bool,
}

fn valid_label(label: &str) -> Result<String, CoachError> {
    let label = label.trim();
    if !super::plain(label, MAX_LABEL_CHARS) {
        return Err(CoachError::InvalidInput);
    }
    Ok(label.to_owned())
}

/// A key is sent as a header value, so only visible ASCII is accepted.
fn valid_key(key: Option<&str>) -> Result<Option<String>, CoachError> {
    let Some(key) = key.map(str::trim).filter(|key| !key.is_empty()) else {
        return Ok(None);
    };
    if key.len() > MAX_KEY_BYTES || !key.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(CoachError::InvalidInput);
    }
    Ok(Some(key.to_owned()))
}

fn signed_in_summary(
    handle: CoachConnectionHandle,
    kind: ConnectionKind,
    label: String,
    email: &Option<String>,
    refresh_token: &Option<String>,
) -> ConnectionSummary {
    ConnectionSummary {
        handle,
        kind,
        label,
        address: None,
        has_key: false,
        account: email.clone(),
        status: if refresh_token.is_some() {
            ConnectionStatus::Ready
        } else {
            ConnectionStatus::SignInAgain
        },
    }
}

/// A connection of which only the name is known. Its kind is not known either; it is listed as
/// an address, which grants nothing.
fn unread_summary(
    handle: CoachConnectionHandle,
    label: String,
    status: ConnectionStatus,
) -> ConnectionSummary {
    ConnectionSummary {
        handle,
        kind: ConnectionKind::Api,
        label,
        address: None,
        has_key: false,
        account: None,
        status,
    }
}

fn summary(handle: CoachConnectionHandle, label: String, secret: &Secret) -> ConnectionSummary {
    match secret {
        Secret::Api { address, key } => ConnectionSummary {
            handle,
            kind: ConnectionKind::Api,
            label,
            address: Some(address.clone()),
            has_key: key.is_some(),
            account: None,
            status: ConnectionStatus::Ready,
        },
        Secret::ChatGpt(secret) => signed_in_summary(
            handle,
            ConnectionKind::ChatGpt,
            label,
            &secret.email,
            &secret.refresh_token,
        ),
        Secret::Grok(secret) => signed_in_summary(
            handle,
            ConnectionKind::Grok,
            label,
            &secret.email,
            &secret.refresh_token,
        ),
    }
}

#[derive(Clone)]
pub(crate) struct Connections {
    credentials: Arc<CoachCredentials>,
}

impl Connections {
    pub(crate) fn new(credentials: Arc<CoachCredentials>) -> Self {
        Self { credentials }
    }

    /// The stored secret of one connection: `NotFound` when the connection does not exist,
    /// `NeedsRepair` when its secret is missing or cannot be decoded, `Storage` when the keyring
    /// could not be asked. The last one says nothing about the connection and passes.
    pub(crate) async fn secret(&self, handle: CoachConnectionHandle) -> Result<Secret, CoachError> {
        let known = self
            .credentials
            .list()
            .await
            .map_err(|_| CoachError::Storage)?
            .into_iter()
            .any(|account| account.handle == handle);
        if !known {
            return Err(CoachError::NotFound);
        }
        self.stored_secret(handle)
            .await?
            .ok_or(CoachError::NeedsRepair)
    }

    /// What the keyring holds for a listed connection: `None` when there is nothing, or nothing
    /// that can be decoded. `Err` when the keyring could not be asked.
    async fn stored_secret(
        &self,
        handle: CoachConnectionHandle,
    ) -> Result<Option<Secret>, CoachError> {
        match self.credentials.token(handle).await {
            Ok(stored) => Ok(stored.as_deref().and_then(Secret::decode)),
            Err(error) => {
                log::warn!("coach: a connection's keyring entry could not be read: {error}");
                Err(CoachError::Storage)
            }
        }
    }

    /// Whether at least one connection exists in the registry, without reading the keyring.
    pub(crate) async fn has_any(&self) -> Result<bool, CoachError> {
        let accounts = self
            .credentials
            .list()
            .await
            .map_err(|_| CoachError::Storage)?;
        Ok(!accounts.is_empty())
    }

    pub(crate) async fn list(&self) -> Result<Vec<ConnectionSummary>, CoachError> {
        let accounts = self
            .credentials
            .list()
            .await
            .map_err(|_| CoachError::Storage)?;
        let mut connections = Vec::with_capacity(accounts.len());
        for account in accounts {
            // One connection that cannot be read must not hide the others: it is listed by its
            // name, and the status says whether its secret is broken or only out of reach.
            let (handle, label) = (account.handle, account.username);
            connections.push(match self.stored_secret(handle.clone()).await {
                Ok(Some(secret)) => summary(handle, label, &secret),
                Ok(None) => unread_summary(handle, label, ConnectionStatus::NeedsRepair),
                Err(_) => unread_summary(handle, label, ConnectionStatus::StorageUnavailable),
            });
        }
        connections.sort_by(|left, right| {
            left.label
                .to_lowercase()
                .cmp(&right.label.to_lowercase())
                .then_with(|| left.handle.0.cmp(&right.handle.0))
        });
        Ok(connections)
    }

    pub(crate) async fn save_api(
        &self,
        input: ApiConnectionInput,
    ) -> Result<ConnectionSaved, CoachError> {
        let label = valid_label(&input.label)?;
        let address = Address::parse(&input.address)?;
        let entered_key = valid_key(input.key.as_deref())?;
        match input.handle {
            None => {
                let existing = self
                    .credentials
                    .list()
                    .await
                    .map_err(|_| CoachError::Storage)?;
                if existing.len() >= MAX_CONNECTIONS {
                    return Err(CoachError::TooManyConnections);
                }
                let secret = Secret::Api {
                    address: address.as_str().to_owned(),
                    key: entered_key,
                };
                let (account, durability_uncertain) = self
                    .credentials
                    .store(label, secret.encode()?)
                    .await
                    .map_err(|_| CoachError::Storage)?;
                Ok(ConnectionSaved {
                    connection: summary(account.handle, account.username, &secret),
                    durability_uncertain,
                })
            }
            Some(handle) => {
                let key = match (entered_key, self.secret(handle.clone()).await) {
                    (_, Err(CoachError::NotFound)) => return Err(CoachError::NotFound),
                    // Without a look at what is stored, nothing is decided about its key.
                    (_, Err(CoachError::Storage)) => return Err(CoachError::Storage),
                    // A sign-in is not turned into an address by an edit.
                    (_, Ok(Secret::ChatGpt(_) | Secret::Grok(_))) => {
                        return Err(CoachError::InvalidInput)
                    }
                    (Some(key), _) => Some(key),
                    // An unreadable connection is re-entered: nothing is carried over.
                    (None, Err(_)) => None,
                    (None, Ok(Secret::Api { key: None, .. })) => None,
                    (
                        None,
                        Ok(Secret::Api {
                            address: stored,
                            key: Some(key),
                        }),
                    ) => {
                        let same_origin = Address::parse(&stored)
                            .is_ok_and(|stored| stored.same_origin(&address));
                        if !same_origin {
                            return Err(CoachError::KeyRequired);
                        }
                        Some(key)
                    }
                };
                let secret = Secret::Api {
                    address: address.as_str().to_owned(),
                    key,
                };
                let durability_uncertain = self
                    .credentials
                    .update(handle.clone(), label.clone(), secret.encode()?)
                    .await
                    .map_err(|_| CoachError::Storage)?;
                Ok(ConnectionSaved {
                    connection: summary(handle, label, &secret),
                    durability_uncertain,
                })
            }
        }
    }

    pub(crate) async fn remove(
        &self,
        handle: CoachConnectionHandle,
    ) -> Result<ConnectionRemoved, CoachError> {
        let removed = self
            .credentials
            .remove(handle)
            .await
            .map_err(|_| CoachError::Storage)?
            .ok_or(CoachError::NotFound)?;
        Ok(ConnectionRemoved {
            durability_uncertain: removed.durability_uncertain,
            revocation_pending: false,
        })
    }

    /// The first connection whose readable secret `pick` accepts, with what it returned. A keyring
    /// that could not be asked is an error, never "there is none": a sign-in would otherwise be
    /// stored a second time beside the one that could not be seen.
    async fn find<T>(
        &self,
        pick: impl Fn(Secret) -> Option<T>,
    ) -> Result<Option<(CoachConnectionHandle, T)>, CoachError> {
        let accounts = self
            .credentials
            .list()
            .await
            .map_err(|_| CoachError::Storage)?;
        for account in accounts {
            let found = self
                .stored_secret(account.handle.clone())
                .await?
                .and_then(&pick);
            if let Some(found) = found {
                return Ok(Some((account.handle, found)));
            }
        }
        Ok(None)
    }

    /// The ChatGPT connection, if there is one: at most one exists.
    pub(crate) async fn chatgpt(
        &self,
    ) -> Result<Option<(CoachConnectionHandle, ChatGptSecret)>, CoachError> {
        self.find(|secret| match secret {
            Secret::ChatGpt(secret) => Some(secret),
            _ => None,
        })
        .await
    }

    /// The Grok connection, if there is one: at most one exists.
    pub(crate) async fn grok(
        &self,
    ) -> Result<Option<(CoachConnectionHandle, GrokSecret)>, CoachError> {
        self.find(|secret| match secret {
            Secret::Grok(secret) => Some(secret),
            _ => None,
        })
        .await
    }

    /// Stores a completed sign-in: in the place of the existing connection of its kind, which
    /// keeps its handle, or as a new connection.
    async fn save_sign_in(
        &self,
        existing: Option<CoachConnectionHandle>,
        label: &str,
        secret: Secret,
    ) -> Result<ConnectionSaved, CoachError> {
        let encoded = secret.encode()?;
        let (handle, durability_uncertain) = match existing {
            Some(handle) => {
                let uncertain = self
                    .credentials
                    .update(handle.clone(), label.to_owned(), encoded)
                    .await
                    .map_err(|_| CoachError::Storage)?;
                (handle, uncertain)
            }
            None => {
                let count = self
                    .credentials
                    .list()
                    .await
                    .map_err(|_| CoachError::Storage)?
                    .len();
                if count >= MAX_CONNECTIONS {
                    return Err(CoachError::TooManyConnections);
                }
                let (account, uncertain) = self
                    .credentials
                    .store(label.to_owned(), encoded)
                    .await
                    .map_err(|_| CoachError::Storage)?;
                (account.handle, uncertain)
            }
        };
        Ok(ConnectionSaved {
            connection: summary(handle, label.to_owned(), &secret),
            durability_uncertain,
        })
    }

    pub(crate) async fn save_chatgpt(
        &self,
        secret: ChatGptSecret,
    ) -> Result<ConnectionSaved, CoachError> {
        let existing = self.chatgpt().await?.map(|(handle, _)| handle);
        self.save_sign_in(existing, CHATGPT_LABEL, Secret::ChatGpt(secret))
            .await
    }

    pub(crate) async fn save_grok(
        &self,
        secret: GrokSecret,
    ) -> Result<ConnectionSaved, CoachError> {
        let existing = self.grok().await?.map(|(handle, _)| handle);
        self.save_sign_in(existing, GROK_LABEL, Secret::Grok(secret))
            .await
    }

    /// Replaces the refresh token of a sign-in connection after a rotation, or takes it away
    /// (`None`) after the provider ended the session. Everything else in its secret stays.
    pub(crate) async fn set_refresh_token(
        &self,
        handle: CoachConnectionHandle,
        refresh_token: Option<String>,
    ) -> Result<(), CoachError> {
        let mut secret = self.secret(handle.clone()).await?;
        let Some(stored) = secret.refresh_token_mut() else {
            return Err(CoachError::InvalidInput);
        };
        *stored = refresh_token;
        self.credentials
            .replace(handle, secret.encode()?)
            .await
            .map_err(|_| CoachError::Storage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{CredentialStore, MemoryCredentialStore};

    fn connections() -> (Connections, Arc<MemoryCredentialStore>, tempfile::TempDir) {
        let store = Arc::new(MemoryCredentialStore::default());
        let (credentials, directory) = CoachCredentials::for_test(store.clone());
        (Connections::new(Arc::new(credentials)), store, directory)
    }

    fn api(
        handle: Option<&CoachConnectionHandle>,
        label: &str,
        address: &str,
        key: Option<&str>,
    ) -> ApiConnectionInput {
        ApiConnectionInput {
            handle: handle.cloned(),
            label: label.into(),
            address: address.into(),
            key: key.map(str::to_owned),
        }
    }

    fn stored_secret(
        store: &MemoryCredentialStore,
        handle: &CoachConnectionHandle,
    ) -> serde_json::Value {
        let stored = store
            .get(&format!("coach-connection:{}", handle.0))
            .unwrap()
            .expect("the connection has a keyring entry");
        serde_json::from_str(&stored).unwrap()
    }

    #[tokio::test]
    async fn a_saved_connection_keeps_key_and_address_in_one_document_and_never_lists_the_key() {
        let (connections, store, _directory) = connections();
        let saved = connections
            .save_api(api(
                None,
                "  OpenAI  ",
                "https://api.openai.com/v1/",
                Some(" sk-test "),
            ))
            .await
            .unwrap();

        assert_eq!(saved.connection.label, "OpenAI");
        assert_eq!(
            saved.connection.address.as_deref(),
            Some("https://api.openai.com/v1")
        );
        assert!(saved.connection.has_key);
        assert_eq!(saved.connection.status, ConnectionStatus::Ready);
        assert_eq!(
            stored_secret(&store, &saved.connection.handle),
            serde_json::json!({ "kind": "api", "address": "https://api.openai.com/v1", "key": "sk-test" })
        );
        let listed = connections.list().await.unwrap();
        assert_eq!(listed, vec![saved.connection]);
        assert!(!serde_json::to_string(&listed).unwrap().contains("sk-test"));
    }

    #[tokio::test]
    async fn equal_labels_get_separate_handles_and_secrets() {
        let (connections, store, _directory) = connections();
        let first = connections
            .save_api(api(None, "Home", "http://localhost:11434/v1", None))
            .await
            .unwrap();
        let second = connections
            .save_api(api(
                None,
                "home",
                "https://api.deepseek.com",
                Some("sk-two"),
            ))
            .await
            .unwrap();

        assert_ne!(first.connection.handle, second.connection.handle);
        assert_eq!(
            stored_secret(&store, &first.connection.handle),
            serde_json::json!({ "kind": "api", "address": "http://localhost:11434/v1" })
        );
        assert_eq!(
            stored_secret(&store, &second.connection.handle)["key"],
            "sk-two"
        );
        assert_eq!(connections.list().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn an_edit_keeps_the_key_on_the_same_origin_and_requires_it_on_another() {
        let (connections, store, _directory) = connections();
        let saved = connections
            .save_api(api(
                None,
                "OpenAI",
                "https://api.openai.com/v1",
                Some("sk-one"),
            ))
            .await
            .unwrap();
        let handle = saved.connection.handle;

        let renamed = connections
            .save_api(api(
                Some(&handle),
                "Work",
                "https://api.openai.com/v2",
                None,
            ))
            .await
            .unwrap();
        assert_eq!(renamed.connection.handle, handle);
        assert_eq!(renamed.connection.label, "Work");
        assert_eq!(
            stored_secret(&store, &handle),
            serde_json::json!({ "kind": "api", "address": "https://api.openai.com/v2", "key": "sk-one" })
        );
        assert_eq!(connections.list().await.unwrap()[0].label, "Work");

        for moved in [
            "https://api.deepseek.com/v2",
            "https://api.openai.com:8443/v2",
            "http://localhost:11434/v1",
        ] {
            assert_eq!(
                connections
                    .save_api(api(Some(&handle), "Work", moved, None))
                    .await
                    .unwrap_err(),
                CoachError::KeyRequired,
                "{moved}"
            );
        }
        assert_eq!(
            stored_secret(&store, &handle)["address"],
            "https://api.openai.com/v2"
        );

        connections
            .save_api(api(
                Some(&handle),
                "Work",
                "https://api.deepseek.com",
                Some("sk-two"),
            ))
            .await
            .unwrap();
        assert_eq!(
            stored_secret(&store, &handle),
            serde_json::json!({ "kind": "api", "address": "https://api.deepseek.com", "key": "sk-two" })
        );
    }

    #[tokio::test]
    async fn inputs_outside_their_bounds_are_refused_before_anything_is_stored() {
        let (connections, _store, _directory) = connections();
        let long_label = "l".repeat(MAX_LABEL_CHARS + 1);
        let long_key = "k".repeat(MAX_KEY_BYTES + 1);
        for (label, address, key, expected) in [
            (
                "",
                "https://api.openai.com/v1",
                None,
                CoachError::InvalidInput,
            ),
            (
                long_label.as_str(),
                "https://api.openai.com/v1",
                None,
                CoachError::InvalidInput,
            ),
            (
                "Tab\there",
                "https://api.openai.com/v1",
                None,
                CoachError::InvalidInput,
            ),
            (
                "Key",
                "https://api.openai.com/v1",
                Some(long_key.as_str()),
                CoachError::InvalidInput,
            ),
            (
                "Key",
                "https://api.openai.com/v1",
                Some("two words"),
                CoachError::InvalidInput,
            ),
            (
                "Key",
                "https://api.openai.com/v1",
                Some("schlüssel"),
                CoachError::InvalidInput,
            ),
            (
                "Address",
                "http://api.openai.com/v1",
                None,
                CoachError::InvalidAddressScheme,
            ),
        ] {
            assert_eq!(
                connections
                    .save_api(api(None, label, address, key))
                    .await
                    .unwrap_err(),
                expected,
                "{label:?} {address:?}"
            );
        }
        assert!(connections.list().await.unwrap().is_empty());
    }

    #[test]
    fn a_secret_beyond_the_keyring_limit_is_a_storage_error() {
        let fits = Secret::Api {
            address: "https://api.openai.com/v1".into(),
            key: Some("k".repeat(MAX_KEY_BYTES)),
        };
        assert!(fits.encode().is_ok());
        let oversized = Secret::Api {
            address: "https://api.openai.com/v1".into(),
            key: Some("k".repeat(MAX_KEYRING_SECRET_UTF16_UNITS)),
        };
        assert!(matches!(oversized.encode(), Err(CoachError::Storage)));
    }

    #[tokio::test]
    async fn the_seventeenth_connection_is_refused() {
        let (connections, _store, _directory) = connections();
        for index in 0..MAX_CONNECTIONS {
            connections
                .save_api(api(
                    None,
                    &format!("Local {index}"),
                    "http://localhost:11434/v1",
                    None,
                ))
                .await
                .unwrap();
        }
        assert_eq!(
            connections
                .save_api(api(None, "One more", "http://localhost:11434/v1", None))
                .await
                .unwrap_err(),
            CoachError::TooManyConnections
        );
        assert_eq!(connections.list().await.unwrap().len(), MAX_CONNECTIONS);
    }

    #[tokio::test]
    async fn an_unreadable_secret_marks_only_its_own_connection() {
        let (connections, store, _directory) = connections();
        let healthy = connections
            .save_api(api(
                None,
                "A healthy",
                "https://api.openai.com/v1",
                Some("sk-one"),
            ))
            .await
            .unwrap();
        let broken = connections
            .save_api(api(
                None,
                "B broken",
                "https://api.deepseek.com",
                Some("sk-two"),
            ))
            .await
            .unwrap();
        store
            .set(
                &format!("coach-connection:{}", broken.connection.handle.0),
                "not json",
            )
            .unwrap();

        let listed = connections.list().await.unwrap();
        assert_eq!(listed[0], healthy.connection);
        assert_eq!(listed[1].handle, broken.connection.handle);
        assert_eq!(listed[1].status, ConnectionStatus::NeedsRepair);
        assert_eq!(listed[1].address, None);
        assert!(!listed[1].has_key);
        assert!(matches!(
            connections.secret(broken.connection.handle.clone()).await,
            Err(CoachError::NeedsRepair)
        ));

        // Re-entering repairs it; nothing of the unreadable document is carried over.
        let repaired = connections
            .save_api(api(
                Some(&broken.connection.handle),
                "B repaired",
                "https://api.deepseek.com",
                None,
            ))
            .await
            .unwrap();
        assert_eq!(repaired.connection.status, ConnectionStatus::Ready);
        assert!(!repaired.connection.has_key);
    }

    #[tokio::test]
    async fn a_keyring_that_does_not_answer_is_a_storage_error_and_changes_nothing() {
        let store = Arc::new(crate::coach::test_server::FaultyStore::default());
        let (credentials, _directory) = CoachCredentials::for_test(store.clone());
        let connections = Connections::new(Arc::new(credentials));
        let hosted = connections
            .save_api(api(
                None,
                "Hosted",
                "https://api.deepseek.com",
                Some("sk-kept"),
            ))
            .await
            .unwrap();
        let chatgpt = connections
            .save_chatgpt(signed_in(Some("refresh-1")))
            .await
            .unwrap();
        let handle = hosted.connection.handle.clone();
        let silent = |value| {
            store
                .silent
                .store(value, std::sync::atomic::Ordering::SeqCst)
        };

        silent(true);
        // Not "enter it again": the connection may be perfectly fine.
        assert!(matches!(
            connections.secret(handle.clone()).await,
            Err(CoachError::Storage)
        ));
        // An edit without a key does not drop the stored key unseen.
        assert_eq!(
            connections
                .save_api(api(
                    Some(&handle),
                    "Hosted",
                    "https://api.deepseek.com",
                    None
                ))
                .await
                .err(),
            Some(CoachError::Storage)
        );
        // A sign-in is not stored a second time beside the one that cannot be seen.
        assert!(matches!(
            connections.chatgpt().await,
            Err(CoachError::Storage)
        ));
        assert_eq!(
            connections
                .save_chatgpt(signed_in(Some("refresh-2")))
                .await
                .err(),
            Some(CoachError::Storage)
        );
        // The list still names every connection, and says that the keyring is out of reach
        // instead of calling them broken.
        let unreachable = connections.list().await.unwrap();
        assert_eq!(unreachable.len(), 2);
        for connection in &unreachable {
            assert_eq!(connection.status, ConnectionStatus::StorageUnavailable);
            assert_eq!(
                (connection.address.as_deref(), connection.has_key),
                (None, false)
            );
            assert_eq!(connection.account, None);
        }
        assert_eq!(
            unreachable
                .iter()
                .map(|connection| connection.label.as_str())
                .collect::<Vec<_>>(),
            ["ChatGPT", "Hosted"]
        );

        silent(false);
        let listed = connections.list().await.unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed
            .iter()
            .all(|connection| connection.status == ConnectionStatus::Ready));
        let Ok(Secret::Api { key, .. }) = connections.secret(handle).await else {
            panic!("the connection is an address again");
        };
        assert_eq!(key.as_deref(), Some("sk-kept"));
        let (kept, secret) = connections.chatgpt().await.unwrap().unwrap();
        assert_eq!(kept, chatgpt.connection.handle);
        assert_eq!(secret.refresh_token.as_deref(), Some("refresh-1"));
    }

    fn signed_in(refresh: Option<&str>) -> ChatGptSecret {
        ChatGptSecret {
            client_id: "oaiapp_issued".into(),
            refresh_token: refresh.map(str::to_owned),
            subject: "user-123".into(),
            email: Some("player@example.com".into()),
        }
    }

    #[tokio::test]
    async fn there_is_one_chatgpt_connection_and_a_new_sign_in_takes_its_place() {
        let (connections, store, _directory) = connections();
        assert!(connections.chatgpt().await.unwrap().is_none());
        let first = connections
            .save_chatgpt(signed_in(Some("refresh-1")))
            .await
            .unwrap();
        assert_eq!(
            first.connection,
            ConnectionSummary {
                handle: first.connection.handle.clone(),
                kind: ConnectionKind::ChatGpt,
                label: "ChatGPT".into(),
                address: None,
                has_key: false,
                account: Some("player@example.com".into()),
                status: ConnectionStatus::Ready,
            }
        );
        assert_eq!(
            stored_secret(&store, &first.connection.handle),
            serde_json::json!({
                "kind": "chatGpt",
                "clientId": "oaiapp_issued",
                "refreshToken": "refresh-1",
                "subject": "user-123",
                "email": "player@example.com",
            })
        );

        let mut other_account = signed_in(Some("refresh-2"));
        other_account.email = None;
        let second = connections.save_chatgpt(other_account).await.unwrap();
        assert_eq!(second.connection.handle, first.connection.handle);
        assert_eq!(second.connection.account, None);
        assert_eq!(connections.list().await.unwrap().len(), 1);
        let (handle, secret) = connections.chatgpt().await.unwrap().unwrap();
        assert_eq!(handle, first.connection.handle);
        assert_eq!(secret.refresh_token.as_deref(), Some("refresh-2"));
    }

    #[tokio::test]
    async fn a_sign_in_without_its_refresh_token_asks_to_sign_in_again_and_keeps_its_place() {
        let (connections, store, _directory) = connections();
        let handle = connections
            .save_chatgpt(signed_in(Some("refresh-1")))
            .await
            .unwrap()
            .connection
            .handle;
        connections
            .set_refresh_token(handle.clone(), Some("refresh-2".into()))
            .await
            .unwrap();
        assert_eq!(stored_secret(&store, &handle)["refreshToken"], "refresh-2");
        assert_eq!(
            connections.list().await.unwrap()[0].status,
            ConnectionStatus::Ready
        );

        connections
            .set_refresh_token(handle.clone(), None)
            .await
            .unwrap();
        let listed = connections.list().await.unwrap();
        assert_eq!(listed[0].status, ConnectionStatus::SignInAgain);
        assert_eq!(listed[0].kind, ConnectionKind::ChatGpt);
        assert_eq!(listed[0].label, "ChatGPT");
        // The issued client id and the account stay for the next sign-in.
        assert_eq!(
            stored_secret(&store, &handle),
            serde_json::json!({
                "kind": "chatGpt",
                "clientId": "oaiapp_issued",
                "subject": "user-123",
                "email": "player@example.com",
            })
        );
    }

    #[tokio::test]
    async fn a_grok_sign_in_is_a_connection_of_its_own_beside_chatgpt() {
        let (connections, store, _directory) = connections();
        let grok = |refresh: Option<&str>| GrokSecret {
            token_endpoint: "https://auth.x.ai/oauth2/token".into(),
            refresh_token: refresh.map(str::to_owned),
            email: None,
        };
        let chatgpt = connections
            .save_chatgpt(signed_in(Some("refresh-1")))
            .await
            .unwrap()
            .connection
            .handle;
        let first = connections.save_grok(grok(Some("grok-1"))).await.unwrap();
        assert_ne!(first.connection.handle, chatgpt);
        assert_eq!(first.connection.kind, ConnectionKind::Grok);
        assert_eq!(first.connection.label, "Grok");
        assert_eq!(first.connection.account, None);
        assert_eq!(
            stored_secret(&store, &first.connection.handle),
            serde_json::json!({
                "kind": "grok",
                "tokenEndpoint": "https://auth.x.ai/oauth2/token",
                "refreshToken": "grok-1",
            })
        );
        // Each kind finds its own connection, and a new sign-in takes its own place.
        assert_eq!(connections.chatgpt().await.unwrap().unwrap().0, chatgpt);
        let again = connections.save_grok(grok(Some("grok-2"))).await.unwrap();
        assert_eq!(again.connection.handle, first.connection.handle);
        assert_eq!(connections.list().await.unwrap().len(), 2);

        // A rotation and the end of the session change only the refresh token.
        let handle = first.connection.handle;
        connections
            .set_refresh_token(handle.clone(), Some("grok-3".into()))
            .await
            .unwrap();
        assert_eq!(
            connections
                .grok()
                .await
                .unwrap()
                .unwrap()
                .1
                .refresh_token
                .as_deref(),
            Some("grok-3")
        );
        connections
            .set_refresh_token(handle.clone(), None)
            .await
            .unwrap();
        let listed = connections.list().await.unwrap();
        let listed_grok = listed.iter().find(|entry| entry.handle == handle).unwrap();
        assert_eq!(listed_grok.status, ConnectionStatus::SignInAgain);
        assert_eq!(
            stored_secret(&store, &handle),
            serde_json::json!({
                "kind": "grok",
                "tokenEndpoint": "https://auth.x.ai/oauth2/token",
            })
        );
        // An address edit that names it is refused.
        assert_eq!(
            connections
                .save_api(api(
                    Some(&handle),
                    "Mine",
                    "https://api.example.com/v1",
                    None
                ))
                .await
                .unwrap_err(),
            CoachError::InvalidInput
        );
    }

    #[tokio::test]
    async fn a_sign_in_and_an_address_are_never_turned_into_each_other() {
        let (connections, store, _directory) = connections();
        let signed = connections
            .save_chatgpt(signed_in(Some("refresh-1")))
            .await
            .unwrap()
            .connection
            .handle;
        // An address edit that names the sign-in's handle is refused and changes nothing.
        assert_eq!(
            connections
                .save_api(api(
                    Some(&signed),
                    "Mine",
                    "https://api.example.com/v1",
                    Some("sk-test")
                ))
                .await
                .unwrap_err(),
            CoachError::InvalidInput
        );
        assert_eq!(stored_secret(&store, &signed)["kind"], "chatGpt");

        let address = connections
            .save_api(api(None, "Local", "http://localhost:11434/v1", None))
            .await
            .unwrap()
            .connection
            .handle;
        assert_eq!(
            connections
                .set_refresh_token(address.clone(), Some("refresh".into()))
                .await
                .unwrap_err(),
            CoachError::InvalidInput
        );
        assert_eq!(stored_secret(&store, &address)["kind"], "api");
        // A new sign-in still finds the sign-in, not the address.
        assert_eq!(connections.chatgpt().await.unwrap().unwrap().0, signed);
        assert_eq!(
            connections
                .set_refresh_token(
                    CoachConnectionHandle(uuid::Uuid::new_v4().to_string()),
                    None
                )
                .await
                .unwrap_err(),
            CoachError::NotFound
        );
    }

    #[tokio::test]
    async fn a_sign_in_counts_towards_the_bound_and_a_secret_too_long_for_the_keyring_is_refused() {
        let (connections, _store, _directory) = connections();
        for index in 0..MAX_CONNECTIONS {
            connections
                .save_api(api(
                    None,
                    &format!("Local {index}"),
                    "http://localhost:1/v1",
                    None,
                ))
                .await
                .unwrap();
        }
        assert_eq!(
            connections
                .save_chatgpt(signed_in(Some("refresh-1")))
                .await
                .unwrap_err(),
            CoachError::TooManyConnections
        );

        let (connections, _store, _directory) = self::connections();
        let long = "r".repeat(MAX_KEYRING_SECRET_UTF16_UNITS);
        assert_eq!(
            connections
                .save_chatgpt(signed_in(Some(&long)))
                .await
                .unwrap_err(),
            CoachError::Storage
        );
        assert!(connections.list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn removal_deletes_the_keyring_entry_and_unknown_handles_are_not_found() {
        let (connections, store, _directory) = connections();
        let saved = connections
            .save_api(api(
                None,
                "OpenAI",
                "https://api.openai.com/v1",
                Some("sk-one"),
            ))
            .await
            .unwrap();
        let handle = saved.connection.handle;

        connections.remove(handle.clone()).await.unwrap();

        assert!(store
            .get(&format!("coach-connection:{}", handle.0))
            .unwrap()
            .is_none());
        assert!(connections.list().await.unwrap().is_empty());
        assert_eq!(
            connections.remove(handle.clone()).await.unwrap_err(),
            CoachError::NotFound
        );
        assert!(matches!(
            connections.secret(handle.clone()).await,
            Err(CoachError::NotFound)
        ));
        assert_eq!(
            connections
                .save_api(api(
                    Some(&handle),
                    "Gone",
                    "https://api.openai.com/v1",
                    Some("sk")
                ))
                .await
                .unwrap_err(),
            CoachError::NotFound
        );
    }
}
