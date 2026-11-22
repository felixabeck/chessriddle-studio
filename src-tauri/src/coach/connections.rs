//! Coach connections: what the user connected, stored natively.
//!
//! A connection's secret is one JSON document in the OS keyring that holds the connection kind,
//! its address and its key together, so a key can never be paired with another address by a later
//! edit. The journaled credential registry holds only the handle and the display label.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;

use super::{address::Address, error::CoachError};
use crate::credentials::{CoachConnectionHandle, CoachCredentials, MAX_KEYRING_SECRET_UTF16_UNITS};

pub(crate) const MAX_CONNECTIONS: usize = 16;
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
}

impl Secret {
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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConnectionStatus {
    Ready,
    /// The stored secret is missing or cannot be read; the connection can be re-entered or removed.
    NeedsRepair,
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
}

fn valid_label(label: &str) -> Result<String, CoachError> {
    let label = label.trim();
    if label.is_empty()
        || label.chars().count() > MAX_LABEL_CHARS
        || label.chars().any(char::is_control)
    {
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

fn summary(
    handle: CoachConnectionHandle,
    label: String,
    secret: Option<&Secret>,
) -> ConnectionSummary {
    match secret {
        Some(Secret::Api { address, key }) => ConnectionSummary {
            handle,
            kind: ConnectionKind::Api,
            label,
            address: Some(address.clone()),
            has_key: key.is_some(),
            status: ConnectionStatus::Ready,
        },
        None => ConnectionSummary {
            handle,
            kind: ConnectionKind::Api,
            label,
            address: None,
            has_key: false,
            status: ConnectionStatus::NeedsRepair,
        },
    }
}

pub(crate) struct Connections {
    credentials: Arc<CoachCredentials>,
}

impl Connections {
    pub(crate) fn new(credentials: Arc<CoachCredentials>) -> Self {
        Self { credentials }
    }

    /// The stored secret of one connection: `NotFound` when the connection does not exist,
    /// `NeedsRepair` when its secret is missing or cannot be decoded.
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
        self.readable_secret(handle)
            .await
            .ok_or(CoachError::NeedsRepair)
    }

    /// A keyring read failure and an undecodable document both make one connection unreadable;
    /// neither may fail the others.
    async fn readable_secret(&self, handle: CoachConnectionHandle) -> Option<Secret> {
        let stored = self.credentials.token(handle).await.ok().flatten()?;
        Secret::decode(&stored)
    }

    pub(crate) async fn list(&self) -> Result<Vec<ConnectionSummary>, CoachError> {
        let accounts = self
            .credentials
            .list()
            .await
            .map_err(|_| CoachError::Storage)?;
        let mut connections = Vec::with_capacity(accounts.len());
        for account in accounts {
            let secret = self.readable_secret(account.handle.clone()).await;
            connections.push(summary(account.handle, account.username, secret.as_ref()));
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
                    connection: summary(account.handle, account.username, Some(&secret)),
                    durability_uncertain,
                })
            }
            Some(handle) => {
                let key = match (entered_key, self.secret(handle.clone()).await) {
                    (_, Err(CoachError::NotFound)) => return Err(CoachError::NotFound),
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
                    connection: summary(handle, label, Some(&secret)),
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
        })
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
