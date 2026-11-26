//! Native-only provider-separated credential storage.
//!
//! Tokens are held exclusively by the operating-system credential manager.  The on-disk registry
//! contains only public metadata and a durable journal used to complete interrupted add/delete
//! operations without ever serialising a bearer token.

#[cfg(test)]
use std::fs;

use crate::{
    error::Error,
    infra::blocking::BLOCKING_GATEWAY,
    infra::{
        fs::AtomicFileOutcome,
        path_authority::{
            ensure_app_owned_default_dir, AppDataDir, AppOwnedDefaultRoot, AuthorizedDir,
            DefaultRootLocation,
        },
    },
};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};
use tokio_util::sync::CancellationToken;

/// Appended to the bundle identifier to form the OS credential-manager service name.  The release
/// and development identifiers deliberately produce disjoint namespaces so neither build can
/// access tokens stored by the other.
const KEYRING_SERVICE_SUFFIX: &str = ".lichess";
const REGISTRY_FILE: &str = "lichess-accounts.json";
const REGISTRY_VERSION: u8 = 2;

/// Windows Credential Manager limits a credential blob to 2560 bytes of UTF-16. A secret that
/// must be storable on every platform stays within this many UTF-16 units.
pub(crate) const MAX_KEYRING_SECRET_UTF16_UNITS: usize = 1280;
/// The most a note beside a registry may hold; anything longer is not one of ours.
const MAX_NOTE_BYTES: u64 = 256;

#[derive(Clone, Copy, PartialEq, Eq)]
enum CredentialProvider {
    Lichess,
    ChessRiddle,
    Coach,
}

impl CredentialProvider {
    fn registry_file(self) -> &'static str {
        match self {
            Self::Lichess => REGISTRY_FILE,
            Self::ChessRiddle => "chessriddle-account.json",
            Self::Coach => "coach-connections.json",
        }
    }

    fn key(self, handle: &LichessAccountHandle) -> String {
        match self {
            Self::Lichess => format!("lichess-account:{}", handle.0),
            Self::ChessRiddle => format!("chessriddle-account:{}", handle.0),
            Self::Coach => format!("coach-connection:{}", handle.0),
        }
    }

    /// How many accounts the registry may hold, pending records included.
    fn max_accounts(self) -> Option<usize> {
        match self {
            Self::Lichess => None,
            Self::ChessRiddle => Some(1),
            Self::Coach => Some(crate::coach::connections::MAX_CONNECTIONS),
        }
    }

    /// Storing under a known name re-authenticates that account and keeps its handle. A Coach
    /// connection's name is only a display label, so every store there is a new account.
    fn reauthenticates_by_name(self) -> bool {
        match self {
            Self::Lichess | Self::ChessRiddle => true,
            Self::Coach => false,
        }
    }

    /// A durable deletion intent removes local authority even while the keyring is unreachable.
    fn removal_survives_keyring_failure(self) -> bool {
        match self {
            Self::ChessRiddle | Self::Coach => true,
            Self::Lichess => false,
        }
    }
}

/// This handle has no conversion into a Lichess handle at the provider boundary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub(crate) struct ChessRiddleAccountHandle(pub String);

/// Names one Coach connection. Like the ChessRiddle handle it never converts into another
/// provider's handle.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub(crate) struct CoachConnectionHandle(pub String);

/// A provider's own opaque handle type over the shared journal's record key.
pub(crate) trait ProviderHandle: Clone + Send + 'static {
    fn from_raw(raw: String) -> Self;
    fn into_raw(self) -> String;
}

impl ProviderHandle for ChessRiddleAccountHandle {
    fn from_raw(raw: String) -> Self {
        Self(raw)
    }

    fn into_raw(self) -> String {
        self.0
    }
}

impl ProviderHandle for CoachConnectionHandle {
    fn from_raw(raw: String) -> Self {
        Self(raw)
    }

    fn into_raw(self) -> String {
        self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProviderAccount<H> {
    pub handle: H,
    pub username: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ProviderRemoval {
    pub durability_uncertain: bool,
}

/// The async door to one provider's journaled credentials. Only this adapter may use the shared
/// journal's internal record representation: its manager and Lichess-shaped records never leave
/// the credential subsystem. Every call offloads the keyring and registry work to the blocking
/// gateway.
pub(crate) struct ProviderCredentials<H> {
    manager: CredentialManager,
    handle: std::marker::PhantomData<fn() -> H>,
}

pub(crate) type ChessRiddleAccountMetadata = ProviderAccount<ChessRiddleAccountHandle>;
pub(crate) type ChessRiddleCredentials = ProviderCredentials<ChessRiddleAccountHandle>;
pub(crate) type CoachCredentials = ProviderCredentials<CoachConnectionHandle>;

impl ProviderCredentials<ChessRiddleAccountHandle> {
    #[cfg(test)]
    pub(crate) fn with_uncertain_store(store: Arc<dyn CredentialStore>) -> Self {
        Self::from_manager(
            CredentialManager::with_uncertain_persistence(store),
            CredentialProvider::ChessRiddle,
        )
    }

    pub(crate) fn new(identifier: &str) -> Self {
        Self::with_store(Arc::new(OsCredentialStore {
            service: format!("{identifier}.chessriddle"),
        }))
    }

    pub(crate) fn with_store(store: Arc<dyn CredentialStore>) -> Self {
        Self::from_manager(
            CredentialManager::new(store),
            CredentialProvider::ChessRiddle,
        )
    }
}

impl ProviderCredentials<CoachConnectionHandle> {
    pub(crate) fn new(identifier: &str) -> Self {
        Self::with_store(Arc::new(OsCredentialStore {
            service: format!("{identifier}.coach"),
        }))
    }

    pub(crate) fn with_store(store: Arc<dyn CredentialStore>) -> Self {
        Self::from_manager(CredentialManager::new(store), CredentialProvider::Coach)
    }

    /// Initialized credentials over `store` in a temporary app data directory.
    #[cfg(test)]
    pub(crate) fn for_test(store: Arc<dyn CredentialStore>) -> (Self, tempfile::TempDir) {
        let directory = tempfile::tempdir().expect("temporary app data directory");
        let credentials = Self::with_store(store);
        credentials
            .initialize(&AppDataDir::for_test(directory.path()))
            .expect("coach credential registry");
        (credentials, directory)
    }

    #[cfg(test)]
    pub(crate) fn poison_registry_for_test(&self) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = self.manager.registry.lock().unwrap();
            panic!("poison registry for test");
        }));
    }
}

impl<H: ProviderHandle> ProviderCredentials<H> {
    fn from_manager(mut manager: CredentialManager, provider: CredentialProvider) -> Self {
        manager.provider = provider;
        Self {
            manager,
            handle: std::marker::PhantomData,
        }
    }

    pub(crate) fn initialize(&self, app_data_dir: &AppDataDir) -> Result<(), Error> {
        self.manager.initialize(app_data_dir)
    }

    async fn blocking<T, F>(self: &Arc<Self>, work: F) -> Result<T, Error>
    where
        T: Send + 'static,
        F: FnOnce(&CredentialManager) -> Result<T, Error> + Send + 'static,
    {
        let credentials = self.clone();
        BLOCKING_GATEWAY
            .spawn_cancellable(CancellationToken::new(), move |_| {
                work(&credentials.manager)
            })
            .await
    }

    pub(crate) async fn list(self: &Arc<Self>) -> Result<Vec<ProviderAccount<H>>, Error> {
        self.blocking(|manager| {
            Ok(manager
                .list()?
                .into_iter()
                .map(|account| ProviderAccount {
                    handle: H::from_raw(account.handle.0),
                    username: account.username,
                })
                .collect())
        })
        .await
    }

    pub(crate) async fn token(self: &Arc<Self>, handle: H) -> Result<Option<String>, Error> {
        self.blocking(move |manager| manager.token(&LichessAccountHandle(handle.into_raw())))
            .await
    }

    pub(crate) async fn store(
        self: &Arc<Self>,
        username: String,
        token: String,
    ) -> Result<(ProviderAccount<H>, bool), Error> {
        self.blocking(move |manager| {
            manager.reconcile()?;
            let result = manager.store_lichess_token(username, token)?;
            Ok((
                ProviderAccount {
                    handle: H::from_raw(result.account.handle.0),
                    username: result.account.username,
                },
                result.durability_uncertain,
            ))
        })
        .await
    }

    /// A stable identifier of this installation for the provider's sign-ins: the stored one, or a
    /// new random one that is stored before it is returned. It is not a credential.
    pub(crate) async fn installation_id(
        self: &Arc<Self>,
        filename: &'static str,
    ) -> Result<uuid::Uuid, Error> {
        self.blocking(move |manager| {
            let stored = manager
                .read_note(filename)?
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .and_then(|text| uuid::Uuid::parse_str(text.trim()).ok());
            if let Some(id) = stored {
                return Ok(id);
            }
            // Absent or unreadable as an id: a new one replaces it.
            let id = uuid::Uuid::new_v4();
            manager.write_note(filename, id.to_string().as_bytes())?;
            Ok(id)
        })
        .await
    }

    /// Rewrites an active account's secret under its handle and keeps its name.
    pub(crate) async fn replace(self: &Arc<Self>, handle: H, token: String) -> Result<(), Error> {
        self.blocking(move |manager| {
            manager
                .update(&LichessAccountHandle(handle.into_raw()), None, &token)
                .map(|_| ())
        })
        .await
    }

    /// Rewrites an active account's secret and name under its handle. Returns whether the
    /// renamed registry was committed without a durability guarantee.
    pub(crate) async fn update(
        self: &Arc<Self>,
        handle: H,
        username: String,
        token: String,
    ) -> Result<bool, Error> {
        self.blocking(move |manager| {
            manager.update(
                &LichessAccountHandle(handle.into_raw()),
                Some(username),
                &token,
            )
        })
        .await
    }

    pub(crate) async fn remove(
        self: &Arc<Self>,
        handle: H,
    ) -> Result<Option<ProviderRemoval>, Error> {
        self.blocking(move |manager| {
            Ok(manager
                .remove(&LichessAccountHandle(handle.into_raw()))?
                .map(|result| ProviderRemoval {
                    durability_uncertain: result.durability_uncertain,
                }))
        })
        .await
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct LichessAccountHandle(pub String);

impl LichessAccountHandle {
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }

    #[cfg(test)]
    fn key(&self) -> String {
        format!("lichess-account:{}", self.0)
    }

    fn valid(&self) -> bool {
        self.0.parse::<uuid::Uuid>().is_ok()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct LichessAccountMetadata {
    pub handle: LichessAccountHandle,
    pub username: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct LichessAccountStoreResult {
    pub account: LichessAccountMetadata,
    pub durability_uncertain: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RemovedLichessCredential {
    pub token: Option<String>,
    pub durability_uncertain: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "state", content = "account", rename_all = "snake_case")]
enum AccountRecord {
    Active(LichessAccountMetadata),
    PendingAdd(LichessAccountMetadata),
    PendingDelete(LichessAccountMetadata),
}

impl AccountRecord {
    fn metadata(&self) -> &LichessAccountMetadata {
        match self {
            Self::Active(account) | Self::PendingAdd(account) | Self::PendingDelete(account) => {
                account
            }
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct RegistryFile {
    version: u8,
    accounts: BTreeMap<String, AccountRecord>,
}

pub trait CredentialStore: Send + Sync + 'static {
    fn set(&self, key: &str, secret: &str) -> Result<(), Error>;
    fn get(&self, key: &str) -> Result<Option<String>, Error>;
    fn delete(&self, key: &str) -> Result<(), Error>;
}

/// The operating-system credential manager is shared by every build on the machine, so the service
/// name is derived from the bundle identifier rather than hard-coded.  A development build runs
/// under the development identifier and therefore cannot read, overwrite or delete the tokens of
/// an installed release.
pub struct OsCredentialStore {
    service: String,
}

impl OsCredentialStore {
    pub fn new(identifier: &str) -> Self {
        Self {
            service: format!("{identifier}{KEYRING_SERVICE_SUFFIX}"),
        }
    }
}

impl CredentialStore for OsCredentialStore {
    fn set(&self, key: &str, secret: &str) -> Result<(), Error> {
        Entry::new(&self.service, key)
            .and_then(|entry| entry.set_password(secret))
            .map_err(|source| Error::CredentialFailure(source.to_string()))
    }

    fn get(&self, key: &str) -> Result<Option<String>, Error> {
        read_with_session_retry(|| {
            Entry::new(&self.service, key).and_then(|entry| entry.get_password())
        })
    }

    fn delete(&self, key: &str) -> Result<(), Error> {
        match Entry::new(&self.service, key).and_then(|entry| entry.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(source) => Err(Error::CredentialFailure(source.to_string())),
        }
    }
}

/// Runs one keyring read, and runs it once more when the Secret Service session could not decrypt
/// the answer. The second read builds a new entry and with it a new session; if it fails too, that
/// failure is returned. Every other failure is returned at once.
fn read_with_session_retry(
    mut read: impl FnMut() -> keyring::Result<String>,
) -> Result<Option<String>, Error> {
    let mut outcome = read();
    if outcome
        .as_ref()
        .is_err_and(is_secret_session_decrypt_failure)
    {
        log::warn!("credentials: a keyring read could not be decrypted; reading it again");
        outcome = read();
    }
    match outcome {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(source) => Err(Error::CredentialFailure(source.to_string())),
    }
}

/// Whether a keyring failure is a crypto failure of the Secret Service session, such as the
/// intermittent `Crypto error: Unpad Error` logged on 2026-11-25/26 against KWallet, after which a
/// later read of the same entry succeeded.
fn is_secret_session_decrypt_failure(error: &keyring::Error) -> bool {
    #[cfg(target_os = "linux")]
    if let keyring::Error::PlatformFailure(source) = error {
        return matches!(
            source.downcast_ref::<dbus_secret_service::Error>(),
            Some(dbus_secret_service::Error::Crypto(_))
        );
    }
    let _ = error;
    false
}

/// Stands in until the real store is injected with the running bundle identifier.  It refuses every
/// operation instead of guessing a namespace: a fallback would silently address the installed
/// release's secrets from a development build.
struct UnboundCredentialStore;

impl UnboundCredentialStore {
    fn refuse<T>() -> Result<T, Error> {
        Err(Error::CredentialFailure(
            "credential storage was used before it was bound to an application identifier".into(),
        ))
    }
}

impl CredentialStore for UnboundCredentialStore {
    fn set(&self, _key: &str, _secret: &str) -> Result<(), Error> {
        Self::refuse()
    }

    fn get(&self, _key: &str) -> Result<Option<String>, Error> {
        Self::refuse()
    }

    fn delete(&self, _key: &str) -> Result<(), Error> {
        Self::refuse()
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct MemoryCredentialStore(Mutex<BTreeMap<String, String>>);

#[cfg(test)]
impl CredentialStore for MemoryCredentialStore {
    fn set(&self, key: &str, secret: &str) -> Result<(), Error> {
        self.0
            .lock()
            .expect("memory credential mutex poisoned")
            .insert(key.into(), secret.into());
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Option<String>, Error> {
        Ok(self
            .0
            .lock()
            .expect("memory credential mutex poisoned")
            .get(key)
            .cloned())
    }

    fn delete(&self, key: &str) -> Result<(), Error> {
        self.0
            .lock()
            .expect("memory credential mutex poisoned")
            .remove(key);
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RegistryCommit {
    Durable,
    CommittedDurabilityUncertain,
}

#[derive(Clone, Copy)]
enum CredentialWriteKind {
    Add,
    Reauthentication,
}

trait RegistryPersistence: Send + Sync + 'static {
    fn write(
        &self,
        directory: &AuthorizedDir,
        filename: &str,
        bytes: &[u8],
    ) -> Result<RegistryCommit, Error>;
}

#[derive(Default)]
struct AtomicRegistryPersistence;

impl RegistryPersistence for AtomicRegistryPersistence {
    fn write(
        &self,
        directory: &AuthorizedDir,
        filename: &str,
        bytes: &[u8],
    ) -> Result<RegistryCommit, Error> {
        match directory.atomic_replace_leaf_identified(OsStr::new(filename), |file| {
            file.write_all(bytes)
                .map_err(|source| Error::CredentialFailure(source.to_string()))
        })? {
            (AtomicFileOutcome::DurableCommit, _) => Ok(RegistryCommit::Durable),
            // The rename happened.  Keeping the new in-memory state is the only truthful action;
            // compensating can destroy the only committed copy after a parent-fsync failure.
            (AtomicFileOutcome::CommittedDurabilityUncertain(error), _) => {
                log::warn!("credential registry replacement parent sync failed: {error}");
                Ok(RegistryCommit::CommittedDurabilityUncertain)
            }
        }
    }
}

#[cfg(test)]
struct UncertainRegistryPersistence;

#[cfg(test)]
impl RegistryPersistence for UncertainRegistryPersistence {
    fn write(
        &self,
        directory: &AuthorizedDir,
        filename: &str,
        bytes: &[u8],
    ) -> Result<RegistryCommit, Error> {
        AtomicRegistryPersistence.write(directory, filename, bytes)?;
        Ok(RegistryCommit::CommittedDurabilityUncertain)
    }
}

#[derive(Clone)]
struct CredentialRegistryDir {
    directory: Arc<AuthorizedDir>,
    location: DefaultRootLocation,
}

/// One mutex covers the public journal and all credential-store mutations.  It prevents this
/// process from exposing an account before a durable intent exists or interleaving compensations.
pub struct CredentialManager {
    provider: CredentialProvider,
    store: Arc<dyn CredentialStore>,
    persistence: Arc<dyn RegistryPersistence>,
    registry: Mutex<RegistryFile>,
    registry_dir: Mutex<Option<CredentialRegistryDir>>,
}

// Keep the credential manager's locks fail-closed after an unwind.
fn credential_lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, Error> {
    mutex.lock().map_err(|_| Error::CredentialRecoveryRequired)
}

impl Default for CredentialManager {
    fn default() -> Self {
        Self::new(Arc::new(UnboundCredentialStore))
    }
}

impl CredentialManager {
    pub fn new(store: Arc<dyn CredentialStore>) -> Self {
        Self::with_persistence(store, Arc::new(AtomicRegistryPersistence))
    }

    #[cfg(test)]
    pub(crate) fn with_uncertain_persistence(store: Arc<dyn CredentialStore>) -> Self {
        Self::with_persistence(store, Arc::new(UncertainRegistryPersistence))
    }

    fn with_persistence(
        store: Arc<dyn CredentialStore>,
        persistence: Arc<dyn RegistryPersistence>,
    ) -> Self {
        Self {
            provider: CredentialProvider::Lichess,
            store,
            persistence,
            registry: Mutex::new(RegistryFile::default()),
            registry_dir: Mutex::new(None),
        }
    }

    pub(crate) fn initialize(&self, app_data_dir: &AppDataDir) -> Result<(), Error> {
        let location = app_data_dir.startup_location(AppOwnedDefaultRoot::Credentials);
        let directory = Arc::new(
            ensure_app_owned_default_dir(app_data_dir, AppOwnedDefaultRoot::Credentials)
                .map_err(credential_failure)?,
        );
        let registry = self.load_registry(&directory)?;
        *credential_lock(&self.registry)? = registry;
        *credential_lock(&self.registry_dir)? = Some(CredentialRegistryDir {
            directory: Arc::clone(&directory),
            location,
        });
        // Commit legacy metadata-only registries to the journalled format before reconciliation
        // is allowed to touch the native credential manager.
        let registry = credential_lock(&self.registry)?;
        log_uncertain_commit(
            self.persist_locked(&registry)?,
            "credential registry initialization",
        );
        drop(registry);
        // Reopening is the enforcement `secure_registry_file` used to perform: it applies the
        // 0600 the atomic replacement would otherwise inherit from a legacy file's bits, and an
        // absent registry here means one disappeared between the commit above and this line.
        let registry_file = open_named_private_registry(&directory, self.provider.registry_file())
            .map_err(credential_failure)?
            .ok_or_else(|| {
                Error::CredentialFailure(
                    "credential registry disappeared during initialization".into(),
                )
            })?;
        drop(registry_file);
        self.reconcile()
    }

    pub fn list(&self) -> Result<Vec<LichessAccountMetadata>, Error> {
        Ok(credential_lock(&self.registry)?
            .accounts
            .values()
            .filter_map(|record| match record {
                AccountRecord::Active(account) => Some(account.clone()),
                AccountRecord::PendingAdd(_) | AccountRecord::PendingDelete(_) => None,
            })
            .collect())
    }

    pub fn token(&self, handle: &LichessAccountHandle) -> Result<Option<String>, Error> {
        if !handle.valid() {
            return Ok(None);
        }
        let registry = credential_lock(&self.registry)?;
        if !matches!(
            registry.accounts.get(&handle.0),
            Some(AccountRecord::Active(_))
        ) {
            return Ok(None);
        }
        self.store.get(&self.provider.key(handle))
    }

    async fn spawn_blocking<T, F>(self: &Arc<Self>, work: F) -> Result<T, Error>
    where
        T: Send + 'static,
        F: FnOnce(Arc<Self>) -> Result<T, Error> + Send + 'static,
    {
        let manager = self.clone();
        BLOCKING_GATEWAY
            .spawn_cancellable(CancellationToken::new(), move |_| work(manager))
            .await
    }

    pub async fn token_async(
        self: &Arc<Self>,
        handle: LichessAccountHandle,
    ) -> Result<Option<String>, Error> {
        self.spawn_blocking(move |manager| manager.token(&handle))
            .await
    }

    /// Resolves an optional Lichess credential handle for a download or export.
    /// Without a handle the caller runs anonymously (`Ok(None)`); a handle whose stored token is
    /// missing fails with `Error::OAuthFailure` and is never retried anonymously.
    pub(crate) async fn optional_lichess_token_async(
        self: &Arc<Self>,
        handle: Option<LichessAccountHandle>,
    ) -> Result<Option<String>, Error> {
        match handle {
            Some(handle) => self
                .token_async(handle)
                .await?
                .ok_or_else(|| {
                    Error::OAuthFailure("authenticated Lichess account unavailable".into())
                })
                .map(Some),
            None => Ok(None),
        }
    }

    pub(crate) fn store_lichess_token(
        &self,
        username: String,
        token: String,
    ) -> Result<LichessAccountStoreResult, Error> {
        let mut registry = credential_lock(&self.registry)?;
        // Re-authentication must retain the public opaque handle.  Otherwise a successful
        // refresh would orphan the old keyring entry and every persisted renderer session.
        let existing = if self.provider.reauthenticates_by_name() {
            registry.accounts.values().find_map(|record| match record {
                AccountRecord::Active(metadata)
                    if metadata.username.eq_ignore_ascii_case(username.trim()) =>
                {
                    Some(metadata.clone())
                }
                AccountRecord::Active(_)
                | AccountRecord::PendingAdd(_)
                | AccountRecord::PendingDelete(_) => None,
            })
        } else {
            None
        };
        if let Some(existing) = existing {
            self.checked_keyring_write(
                &mut registry,
                &existing,
                &token,
                CredentialWriteKind::Reauthentication,
            )?;
            return Ok(LichessAccountStoreResult {
                account: existing,
                durability_uncertain: false,
            });
        }
        if self
            .provider
            .max_accounts()
            .is_some_and(|max| registry.accounts.len() >= max)
        {
            return Err(Error::CredentialRecoveryRequired);
        }
        let metadata = LichessAccountMetadata {
            handle: LichessAccountHandle::new(),
            username,
        };
        let durability_uncertain =
            self.checked_keyring_write(&mut registry, &metadata, &token, CredentialWriteKind::Add)?;
        Ok(LichessAccountStoreResult {
            account: metadata,
            durability_uncertain,
        })
    }

    /// Rewrites an active account's keyring secret under its existing handle and, when a
    /// different `username` is given, its name in the registry. The secret is written first: a
    /// failed rename leaves the new secret under the old name, never the reverse.
    fn update(
        &self,
        handle: &LichessAccountHandle,
        username: Option<String>,
        token: &str,
    ) -> Result<bool, Error> {
        let mut registry = credential_lock(&self.registry)?;
        let Some(AccountRecord::Active(metadata)) = registry.accounts.get(&handle.0).cloned()
        else {
            return Err(Error::CredentialRecoveryRequired);
        };
        self.checked_keyring_write(
            &mut registry,
            &metadata,
            token,
            CredentialWriteKind::Reauthentication,
        )?;
        let Some(username) = username.filter(|username| *username != metadata.username) else {
            return Ok(false);
        };
        registry.accounts.insert(
            handle.0.clone(),
            AccountRecord::Active(LichessAccountMetadata {
                handle: metadata.handle.clone(),
                username,
            }),
        );
        match self.persist_locked(&registry) {
            Ok(commit) => Ok(commit == RegistryCommit::CommittedDurabilityUncertain),
            Err(error) => {
                registry
                    .accounts
                    .insert(handle.0.clone(), AccountRecord::Active(metadata));
                Err(error)
            }
        }
    }

    /// Checks the registry location before writing and compensates if it changes during a write.
    /// Once the keyring write is attempted, the final check follows the call's last registry
    /// write on every exit: a detached secret is deleted, or recorded in a verified tombstone;
    /// if neither succeeds, the operation requires recovery.
    fn checked_keyring_write(
        &self,
        registry: &mut RegistryFile,
        metadata: &LichessAccountMetadata,
        token: &str,
        kind: CredentialWriteKind,
    ) -> Result<bool, Error> {
        let binding = credential_lock(&self.registry_dir)?.clone();
        let operation = match kind {
            CredentialWriteKind::Add => "add",
            CredentialWriteKind::Reauthentication => "re-authentication",
        };
        if !binding_is_at_startup(binding.as_ref()) {
            log::warn!(
                "credential {operation} detected a detached registry directory for account {}",
                metadata.handle.0
            );
            return Err(credential_directory_replaced());
        }

        let mut durability_uncertain = false;
        if matches!(kind, CredentialWriteKind::Add) {
            registry.accounts.insert(
                metadata.handle.0.clone(),
                AccountRecord::PendingAdd(metadata.clone()),
            );
            durability_uncertain = matches!(
                self.persist_locked(registry)?,
                RegistryCommit::CommittedDurabilityUncertain
            );
        }

        let set_result = self.store.set(&self.provider.key(&metadata.handle), token);
        let mut active_result = Ok(());
        if set_result.is_ok() && matches!(kind, CredentialWriteKind::Add) {
            registry.accounts.insert(
                metadata.handle.0.clone(),
                AccountRecord::Active(metadata.clone()),
            );
            match self.persist_locked(registry) {
                Ok(RegistryCommit::Durable) => {}
                Ok(RegistryCommit::CommittedDurabilityUncertain) => {
                    durability_uncertain = true;
                }
                Err(error) => {
                    registry.accounts.insert(
                        metadata.handle.0.clone(),
                        AccountRecord::PendingAdd(metadata.clone()),
                    );
                    active_result = Err(error);
                }
            }
        }

        if let Some(binding) = binding.as_ref() {
            if !binding_is_at_startup(Some(binding)) {
                log::warn!(
                    "credential {operation} detected a detached registry directory for account {}",
                    metadata.handle.0
                );
                if matches!(kind, CredentialWriteKind::Add) {
                    registry.accounts.remove(&metadata.handle.0);
                }
                self.compensate_detached_secret(metadata, binding)?;
                return Err(credential_directory_replaced());
            }
        }

        if let Err(error) = &set_result {
            log::warn!("credential {operation} could not write the OS keyring: {error:?}");
            // A write-then-error may have stored the secret. Keep an add's PendingAdd intent so
            // startup can reconcile it instead of dropping its only journal record.
            return Err(Error::CredentialRecoveryRequired);
        }
        active_result?;
        Ok(durability_uncertain)
    }

    fn compensate_detached_secret(
        &self,
        metadata: &LichessAccountMetadata,
        binding: &CredentialRegistryDir,
    ) -> Result<(), Error> {
        if let Err(error) = self.store.delete(&self.provider.key(&metadata.handle)) {
            log::error!(
                "failed to delete detached credential for account {}: {error:?}",
                metadata.handle.0
            );
        } else {
            return Ok(());
        }
        let directory = match binding.location.reacquire() {
            Ok(directory) => directory,
            Err(error) => {
                log::error!(
                    "failed to reacquire credential directory for tombstone for account {}: {error:?}",
                    metadata.handle.0
                );
                return Err(Error::CredentialRecoveryRequired);
            }
        };
        let mut registry = match self.load_registry(&directory) {
            Ok(registry) => registry,
            Err(error) => {
                log::error!(
                    "failed to load credential registry for tombstone for account {}: {error:?}",
                    metadata.handle.0
                );
                return Err(Error::CredentialRecoveryRequired);
            }
        };
        registry.accounts.insert(
            metadata.handle.0.clone(),
            AccountRecord::PendingDelete(metadata.clone()),
        );
        let bytes = match serde_json::to_vec(&registry) {
            Ok(bytes) => bytes,
            Err(error) => {
                log::error!(
                    "failed to serialize credential tombstone for account {}: {error:?}",
                    metadata.handle.0
                );
                return Err(Error::CredentialRecoveryRequired);
            }
        };
        match self
            .persistence
            .write(&directory, self.provider.registry_file(), &bytes)
        {
            Ok(RegistryCommit::Durable) => {}
            Ok(RegistryCommit::CommittedDurabilityUncertain) => {
                log::error!(
                    "credential tombstone commit has uncertain durability for account {}",
                    metadata.handle.0
                );
                return Err(Error::CredentialRecoveryRequired);
            }
            Err(error) => {
                log::error!(
                    "failed to persist credential tombstone for account {}: {error:?}",
                    metadata.handle.0
                );
                return Err(Error::CredentialRecoveryRequired);
            }
        }
        match directory.resides_at(&binding.location) {
            Ok(true) => {}
            Ok(false) => {
                log::error!(
                    "credential tombstone directory no longer resolves to startup location for account {}",
                    metadata.handle.0
                );
                return Err(Error::CredentialRecoveryRequired);
            }
            Err(error) => {
                log::error!(
                    "failed to verify credential tombstone location for account {}: {error:?}",
                    metadata.handle.0
                );
                return Err(Error::CredentialRecoveryRequired);
            }
        }
        Ok(())
    }

    pub(crate) async fn store_lichess_token_async(
        self: &Arc<Self>,
        username: String,
        token: String,
    ) -> Result<LichessAccountStoreResult, Error> {
        self.spawn_blocking(move |manager| manager.store_lichess_token(username, token))
            .await
    }

    /// Removes local access first. Provider revocation is deliberately a separate best-effort
    /// network concern; its failure cannot make the local deletion result untrue.
    pub(crate) fn remove(
        &self,
        handle: &LichessAccountHandle,
    ) -> Result<Option<RemovedLichessCredential>, Error> {
        if !handle.valid() {
            return Ok(None);
        }
        let mut registry = credential_lock(&self.registry)?;
        let Some(record) = registry.accounts.get(&handle.0).cloned() else {
            return Ok(None);
        };
        let metadata = record.metadata().clone();
        registry.accounts.insert(
            handle.0.clone(),
            AccountRecord::PendingDelete(metadata.clone()),
        );
        let commit = match self.persist_locked(&registry) {
            Ok(commit) => commit,
            Err(error) => {
                if self.provider.removal_survives_keyring_failure() {
                    registry.accounts.insert(handle.0.clone(), record);
                }
                return Err(error);
            }
        };
        let mut durability_uncertain = commit == RegistryCommit::CommittedDurabilityUncertain;
        let token = if self.provider.removal_survives_keyring_failure() {
            // A durable deletion intent removes local authority even if the keyring is offline.
            self.store
                .get(&self.provider.key(&metadata.handle))
                .ok()
                .flatten()
        } else {
            self.store.get(&self.provider.key(&metadata.handle))?
        };
        if let Err(error) = self.store.delete(&self.provider.key(&metadata.handle)) {
            if self.provider.removal_survives_keyring_failure() {
                return Ok(Some(RemovedLichessCredential {
                    token,
                    durability_uncertain,
                }));
            }
            return Err(error);
        }
        registry.accounts.remove(&handle.0);
        match self.persist_locked(&registry) {
            Ok(RegistryCommit::Durable) => {}
            Ok(RegistryCommit::CommittedDurabilityUncertain) => {
                durability_uncertain = true;
            }
            Err(error) => {
                registry
                    .accounts
                    .insert(handle.0.clone(), AccountRecord::PendingDelete(metadata));
                if self.provider.removal_survives_keyring_failure() {
                    return Ok(Some(RemovedLichessCredential {
                        token,
                        durability_uncertain: true,
                    }));
                }
                return Err(error);
            }
        }
        Ok(Some(RemovedLichessCredential {
            token,
            durability_uncertain,
        }))
    }

    pub async fn remove_async(
        self: &Arc<Self>,
        handle: LichessAccountHandle,
    ) -> Result<Option<RemovedLichessCredential>, Error> {
        self.spawn_blocking(move |manager| manager.remove(&handle))
            .await
    }

    fn reconcile(&self) -> Result<(), Error> {
        let mut registry = credential_lock(&self.registry)?;
        let records: Vec<(String, AccountRecord)> = registry
            .accounts
            .iter()
            .map(|(handle, record)| (handle.clone(), record.clone()))
            .collect();
        for (handle, record) in records {
            let metadata = record.metadata().clone();
            match record {
                AccountRecord::Active(_) => {
                    if self
                        .store
                        .get(&self.provider.key(&metadata.handle))?
                        .is_none()
                    {
                        registry.accounts.remove(&handle);
                        log_uncertain_commit(
                            self.persist_locked(&registry)?,
                            "credential registry active-account reconciliation",
                        );
                    }
                }
                AccountRecord::PendingAdd(_) => {
                    if self
                        .store
                        .get(&self.provider.key(&metadata.handle))?
                        .is_some()
                    {
                        registry
                            .accounts
                            .insert(handle, AccountRecord::Active(metadata));
                    } else {
                        registry.accounts.remove(&handle);
                    }
                    log_uncertain_commit(
                        self.persist_locked(&registry)?,
                        "credential registry pending-add reconciliation",
                    );
                }
                AccountRecord::PendingDelete(_) => {
                    self.store.delete(&self.provider.key(&metadata.handle))?;
                    registry.accounts.remove(&handle);
                    log_uncertain_commit(
                        self.persist_locked(&registry)?,
                        "credential registry pending-delete reconciliation",
                    );
                }
            }
        }
        Ok(())
    }

    fn load_registry(&self, directory: &AuthorizedDir) -> Result<RegistryFile, Error> {
        let Some(mut file) = open_named_private_registry(directory, self.provider.registry_file())
            .map_err(credential_failure)?
        else {
            return Ok(RegistryFile {
                version: REGISTRY_VERSION,
                accounts: BTreeMap::new(),
            });
        };
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|source| Error::CredentialFailure(source.to_string()))?;
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|_| Error::CredentialFailure("credential registry is invalid".into()))?;
        let version = value.get("version").and_then(serde_json::Value::as_u64);
        let mut registry = if version == Some(1) {
            #[derive(Deserialize)]
            struct Legacy {
                accounts: Vec<LichessAccountMetadata>,
            }
            let legacy: Legacy = serde_json::from_value(value)
                .map_err(|_| Error::CredentialFailure("credential registry is invalid".into()))?;
            RegistryFile {
                version: REGISTRY_VERSION,
                accounts: legacy
                    .accounts
                    .into_iter()
                    .map(|account| (account.handle.0.clone(), AccountRecord::Active(account)))
                    .collect(),
            }
        } else {
            serde_json::from_value::<RegistryFile>(value)
                .map_err(|_| Error::CredentialFailure("credential registry is invalid".into()))?
        };
        self.validate_registry(&registry)?;
        registry.version = REGISTRY_VERSION;
        Ok(registry)
    }

    fn validate_registry(&self, registry: &RegistryFile) -> Result<(), Error> {
        if registry.version != REGISTRY_VERSION
            || self
                .provider
                .max_accounts()
                .is_some_and(|max| registry.accounts.len() > max)
        {
            return Err(Error::CredentialFailure(
                "credential registry is invalid".into(),
            ));
        }
        let handles: BTreeSet<_> = registry.accounts.keys().collect();
        if handles.len() != registry.accounts.len()
            || registry.accounts.iter().any(|(handle, record)| {
                handle != &record.metadata().handle.0
                    || !record.metadata().handle.valid()
                    || record.metadata().username.trim().is_empty()
            })
        {
            return Err(Error::CredentialFailure(
                "credential registry is invalid".into(),
            ));
        }
        Ok(())
    }

    /// A small document that is no credential but belongs with this provider's registry: it is
    /// read from the credentials directory under the registry's owner-only rule. `None` when it
    /// does not exist.
    fn read_note(&self, filename: &str) -> Result<Option<Vec<u8>>, Error> {
        let binding = credential_lock(&self.registry_dir)?.clone();
        let Some(binding) = binding else {
            return Ok(None);
        };
        let Some(file) = open_named_private_registry(&binding.directory, filename)
            .map_err(credential_failure)?
        else {
            return Ok(None);
        };
        let mut bytes = Vec::new();
        file.take(MAX_NOTE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|source| Error::CredentialFailure(source.to_string()))?;
        Ok(Some(bytes))
    }

    /// Writes such a document through the registry's atomic replacement.
    fn write_note(&self, filename: &str, bytes: &[u8]) -> Result<(), Error> {
        let binding = credential_lock(&self.registry_dir)?.clone();
        let Some(binding) = binding else {
            return Err(Error::CredentialFailure(
                "credential directory is not initialized".into(),
            ));
        };
        self.persistence
            .write(&binding.directory, filename, bytes)
            .map(|_| ())
            .map_err(|source| {
                Error::CredentialFailure(format!("credential note update failed: {source:?}"))
            })
    }

    fn persist_locked(&self, registry: &RegistryFile) -> Result<RegistryCommit, Error> {
        let binding = credential_lock(&self.registry_dir)?.clone();
        let Some(binding) = binding else {
            return Ok(RegistryCommit::Durable);
        };
        let bytes = serde_json::to_vec(registry)
            .map_err(|source| Error::CredentialFailure(source.to_string()))?;
        self.persistence
            .write(&binding.directory, self.provider.registry_file(), &bytes)
            .map_err(|source| {
                Error::CredentialFailure(format!("credential registry update failed: {source:?}"))
            })
    }
}

fn binding_is_at_startup(binding: Option<&CredentialRegistryDir>) -> bool {
    let Some(binding) = binding else {
        return true;
    };
    match binding.directory.resides_at(&binding.location) {
        Ok(at_startup) => at_startup,
        Err(error) => {
            log::warn!("credential registry location check failed: {error:?}");
            false
        }
    }
}

fn credential_directory_replaced() -> Error {
    Error::CredentialFailure(
        "credential directory was replaced while the application was running".into(),
    )
}

fn log_uncertain_commit(commit: RegistryCommit, operation: &str) {
    if commit == RegistryCommit::CommittedDurabilityUncertain {
        log::warn!("{operation} committed, but durability could not be confirmed");
    }
}

fn credential_failure(error: Error) -> Error {
    // `Debug`, not `Display`: the display text of a wrapped failure leaves its cause out.
    Error::CredentialFailure(format!("{error:?}"))
}

#[cfg(all(test, unix))]
fn open_private_registry(
    dir: &AuthorizedDir,
) -> Result<Option<crate::infra::inode_ownership::OwnedFile>, Error> {
    open_named_private_registry(dir, REGISTRY_FILE)
}

fn open_named_private_registry(
    dir: &AuthorizedDir,
    filename: &str,
) -> Result<Option<crate::infra::inode_ownership::OwnedFile>, Error> {
    let file = match dir.open_regular_relative(Path::new(filename)) {
        Ok(file) => file,
        Err(error) if error.is_missing_entry() => return Ok(None),
        Err(error) => return Err(error),
    };
    #[cfg(unix)]
    chmod_registry_file(&file)?;
    Ok(Some(file))
}

#[cfg(unix)]
fn chmod_registry_file(file: &crate::infra::inode_ownership::OwnedFile) -> Result<(), Error> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(PermissionsExt::from_mode(0o600))
        .map_err(|source| Error::CredentialFailure(source.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::path::PathBuf;

    #[tokio::test]
    async fn chessriddle_namespace_keeps_lichess_addresses_registry_and_handles_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(MemoryCredentialStore::default());
        let lichess = CredentialManager::new(store.clone());
        let root = AppDataDir::for_test(temp.path());
        lichess.initialize(&root).unwrap();
        let original = lichess
            .store_lichess_token("user".into(), "lichess-secret".into())
            .unwrap()
            .account;
        let before = fs::read(temp.path().join("credentials").join(REGISTRY_FILE)).unwrap();
        let chessriddle = Arc::new(ChessRiddleCredentials::with_store(store.clone()));
        chessriddle.initialize(&root).unwrap();
        let (account, _) = chessriddle
            .store("user".into(), "refresh-secret".into())
            .await
            .unwrap();
        chessriddle
            .replace(account.handle.clone(), "rotated".into())
            .await
            .unwrap();
        assert_eq!(
            lichess.token(&original.handle).unwrap().as_deref(),
            Some("lichess-secret")
        );
        assert_eq!(
            fs::read(temp.path().join("credentials").join(REGISTRY_FILE)).unwrap(),
            before
        );
        assert_eq!(
            OsCredentialStore::new("com.chessriddle.studio").service,
            "com.chessriddle.studio.lichess"
        );
        assert_eq!(
            CredentialProvider::Lichess.key(&original.handle),
            original.handle.key()
        );
        assert_eq!(
            store
                .get(&format!("chessriddle-account:{}", account.handle.0))
                .unwrap()
                .as_deref(),
            Some("rotated")
        );
        assert!(!String::from_utf8(
            fs::read(temp.path().join("credentials/chessriddle-account.json")).unwrap()
        )
        .unwrap()
        .contains("secret"));
        assert!(chessriddle
            .store("second".into(), "second-refresh".into())
            .await
            .is_err());
        assert_eq!(chessriddle.list().await.unwrap(), vec![account]);
    }

    #[tokio::test]
    async fn chessriddle_restart_reconciles_pending_add_and_pending_delete() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(MemoryCredentialStore::default());
        let credentials = Arc::new(ChessRiddleCredentials::with_store(store.clone()));
        let root = AppDataDir::for_test(temp.path());
        credentials.initialize(&root).unwrap();
        let (account, _) = credentials
            .store("user".into(), "refresh".into())
            .await
            .unwrap();
        let metadata = LichessAccountMetadata {
            handle: LichessAccountHandle(account.handle.0.clone()),
            username: account.username.clone(),
        };
        {
            let mut registry = credentials.manager.registry.lock().unwrap();
            registry.accounts.insert(
                account.handle.0.clone(),
                AccountRecord::PendingAdd(metadata.clone()),
            );
            credentials.manager.persist_locked(&registry).unwrap();
        }
        let restarted = Arc::new(ChessRiddleCredentials::with_store(store.clone()));
        restarted.initialize(&root).unwrap();
        assert_eq!(restarted.list().await.unwrap(), vec![account.clone()]);
        {
            let mut registry = restarted.manager.registry.lock().unwrap();
            registry.accounts.insert(
                account.handle.0.clone(),
                AccountRecord::PendingDelete(metadata),
            );
            restarted.manager.persist_locked(&registry).unwrap();
        }
        let restarted = Arc::new(ChessRiddleCredentials::with_store(store.clone()));
        restarted.initialize(&root).unwrap();
        assert!(restarted.list().await.unwrap().is_empty());
        assert!(store
            .get(&format!("chessriddle-account:{}", account.handle.0))
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn coach_connections_never_share_a_handle_by_name_and_are_bounded() {
        let store = Arc::new(MemoryCredentialStore::default());
        let (credentials, _directory) = CoachCredentials::for_test(store.clone());
        let credentials = Arc::new(credentials);

        let (first, _) = credentials
            .store("Home".into(), "first".into())
            .await
            .unwrap();
        let (second, _) = credentials
            .store("home".into(), "second".into())
            .await
            .unwrap();
        assert_ne!(first.handle, second.handle);
        assert_eq!(
            store
                .get(&format!("coach-connection:{}", first.handle.0))
                .unwrap()
                .as_deref(),
            Some("first")
        );
        assert_eq!(
            credentials.token(second.handle).await.unwrap().as_deref(),
            Some("second")
        );

        for index in 2..16 {
            credentials
                .store(format!("Connection {index}"), "secret".into())
                .await
                .unwrap();
        }
        assert!(matches!(
            credentials.store("One more".into(), "secret".into()).await,
            Err(Error::CredentialRecoveryRequired)
        ));
        assert_eq!(credentials.list().await.unwrap().len(), 16);
    }

    #[tokio::test]
    async fn an_installation_id_is_created_once_stored_beside_the_registry_and_read_again() {
        let temp = tempfile::tempdir().unwrap();
        let root = AppDataDir::for_test(temp.path());
        let credentials = Arc::new(CoachCredentials::with_store(Arc::new(
            MemoryCredentialStore::default(),
        )));
        credentials.initialize(&root).unwrap();
        let note = temp.path().join("credentials").join("host-id");
        assert!(!note.exists());

        let first = credentials.installation_id("host-id").await.unwrap();
        assert_eq!(fs::read_to_string(&note).unwrap(), first.to_string());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&note).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(credentials.installation_id("host-id").await.unwrap(), first);

        // Another run of the application reads the same id.
        let restarted = Arc::new(CoachCredentials::with_store(Arc::new(
            MemoryCredentialStore::default(),
        )));
        restarted.initialize(&root).unwrap();
        assert_eq!(restarted.installation_id("host-id").await.unwrap(), first);

        // A note that is not an id, or far too long to be one, is replaced by a new id.
        for damaged in ["not an id".to_owned(), "f".repeat(4096)] {
            fs::write(&note, damaged).unwrap();
            let replaced = credentials.installation_id("host-id").await.unwrap();
            assert_ne!(replaced, first);
            assert_eq!(fs::read_to_string(&note).unwrap(), replaced.to_string());
        }

        // Before the credentials directory is known there is nowhere to keep an id.
        let unbound = Arc::new(CoachCredentials::with_store(Arc::new(
            MemoryCredentialStore::default(),
        )));
        assert!(unbound.installation_id("host-id").await.is_err());
    }

    #[tokio::test]
    async fn coach_update_rewrites_secret_and_name_under_the_same_handle() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(MemoryCredentialStore::default());
        let credentials = Arc::new(CoachCredentials::with_store(store.clone()));
        let root = AppDataDir::for_test(temp.path());
        credentials.initialize(&root).unwrap();
        let (account, _) = credentials
            .store("Old name".into(), "old".into())
            .await
            .unwrap();

        credentials
            .update(account.handle.clone(), "New name".into(), "new".into())
            .await
            .unwrap();
        credentials
            .replace(account.handle.clone(), "newer".into())
            .await
            .unwrap();

        let restarted = Arc::new(CoachCredentials::with_store(store));
        restarted.initialize(&root).unwrap();
        assert_eq!(
            restarted.list().await.unwrap(),
            vec![ProviderAccount {
                handle: account.handle.clone(),
                username: "New name".into(),
            }]
        );
        assert_eq!(
            restarted.token(account.handle).await.unwrap().as_deref(),
            Some("newer")
        );
        let unknown = CoachConnectionHandle(LichessAccountHandle::new().0);
        assert!(matches!(
            restarted
                .update(unknown, "Name".into(), "secret".into())
                .await,
            Err(Error::CredentialRecoveryRequired)
        ));
    }

    #[tokio::test]
    async fn coach_rename_failure_keeps_the_old_name_with_the_new_secret() {
        let temp = tempfile::tempdir().unwrap();
        let persistence = Arc::new(RecordingPersistence::default());
        let store = Arc::new(MemoryCredentialStore::default());
        let manager = CredentialManager::with_persistence(store.clone(), persistence.clone());
        let credentials = Arc::new(CoachCredentials::from_manager(
            manager,
            CredentialProvider::Coach,
        ));
        credentials
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        let (account, _) = credentials
            .store("Old name".into(), "old".into())
            .await
            .unwrap();
        persistence.fail_on(
            persistence
                .writes
                .load(std::sync::atomic::Ordering::Relaxed)
                + 1,
        );

        assert!(credentials
            .update(account.handle.clone(), "New name".into(), "new".into())
            .await
            .is_err());

        assert_eq!(credentials.list().await.unwrap(), vec![account.clone()]);
        assert_eq!(
            credentials.token(account.handle).await.unwrap().as_deref(),
            Some("new")
        );
    }

    #[tokio::test]
    async fn chessriddle_disconnect_before_journal_failure_preserves_local_authority() {
        let temp = tempfile::tempdir().unwrap();
        let persistence = Arc::new(RecordingPersistence::default());
        let manager = CredentialManager::with_persistence(
            Arc::new(MemoryCredentialStore::default()),
            persistence.clone(),
        );
        let credentials = Arc::new(ChessRiddleCredentials::from_manager(
            manager,
            CredentialProvider::ChessRiddle,
        ));
        credentials
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        let (account, _) = credentials
            .store("user".into(), "refresh".into())
            .await
            .unwrap();
        persistence.fail_on(
            persistence
                .writes
                .load(std::sync::atomic::Ordering::Relaxed)
                + 1,
        );
        assert!(credentials.remove(account.handle.clone()).await.is_err());
        assert_eq!(credentials.list().await.unwrap(), vec![account.clone()]);
        assert_eq!(
            credentials.token(account.handle).await.unwrap().as_deref(),
            Some("refresh")
        );
    }

    #[tokio::test]
    async fn chessriddle_disconnect_final_write_failure_reports_removed_and_uncertain() {
        let temp = tempfile::tempdir().unwrap();
        let persistence = Arc::new(RecordingPersistence::default());
        let store = Arc::new(MemoryCredentialStore::default());
        let manager = CredentialManager::with_persistence(store.clone(), persistence.clone());
        let credentials = Arc::new(ChessRiddleCredentials::from_manager(
            manager,
            CredentialProvider::ChessRiddle,
        ));
        let root = AppDataDir::for_test(temp.path());
        credentials.initialize(&root).unwrap();
        let (account, _) = credentials
            .store("user".into(), "refresh".into())
            .await
            .unwrap();
        persistence.fail_on(
            persistence
                .writes
                .load(std::sync::atomic::Ordering::Relaxed)
                + 2,
        );
        assert_eq!(
            credentials.remove(account.handle).await.unwrap(),
            Some(ProviderRemoval {
                durability_uncertain: true
            })
        );
        assert!(credentials.list().await.unwrap().is_empty());
        let restarted = Arc::new(ChessRiddleCredentials::with_store(store));
        restarted.initialize(&root).unwrap();
        assert!(restarted.list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn chessriddle_disconnect_keyring_failure_leaves_a_durable_tombstone() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(RecordingStore::configured(false, true));
        let credentials = Arc::new(ChessRiddleCredentials::with_store(store));
        credentials
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        let (account, _) = credentials
            .store("user".into(), "refresh".into())
            .await
            .unwrap();
        assert_eq!(
            credentials.remove(account.handle).await.unwrap(),
            Some(ProviderRemoval {
                durability_uncertain: false
            })
        );
        assert!(credentials.list().await.unwrap().is_empty());
        assert!(
            fs::read_to_string(temp.path().join("credentials/chessriddle-account.json"))
                .unwrap()
                .contains("pending_delete")
        );
    }

    #[derive(Default)]
    struct ThreadRecordingStore {
        inner: MemoryCredentialStore,
        threads: Mutex<Vec<std::thread::ThreadId>>,
    }

    impl CredentialStore for ThreadRecordingStore {
        fn set(&self, key: &str, secret: &str) -> Result<(), Error> {
            self.threads
                .lock()
                .unwrap()
                .push(std::thread::current().id());
            self.inner.set(key, secret)
        }

        fn get(&self, key: &str) -> Result<Option<String>, Error> {
            self.threads
                .lock()
                .unwrap()
                .push(std::thread::current().id());
            self.inner.get(key)
        }

        fn delete(&self, key: &str) -> Result<(), Error> {
            self.threads
                .lock()
                .unwrap()
                .push(std::thread::current().id());
            self.inner.delete(key)
        }
    }

    #[derive(Default)]
    struct FailStore {
        inner: MemoryCredentialStore,
        fail_set: bool,
        fail_delete: bool,
    }

    #[derive(Default)]
    struct CountingStore {
        calls: std::sync::atomic::AtomicUsize,
    }

    impl CredentialStore for CountingStore {
        fn set(&self, _key: &str, _secret: &str) -> Result<(), Error> {
            self.calls
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(())
        }

        fn get(&self, _key: &str) -> Result<Option<String>, Error> {
            self.calls
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(None)
        }

        fn delete(&self, _key: &str) -> Result<(), Error> {
            self.calls
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(())
        }
    }

    fn poison<T>(mutex: &Mutex<T>) {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = mutex.lock().unwrap();
            panic!("poison test mutex");
        }));
        assert!(result.is_err());
    }
    impl CredentialStore for FailStore {
        fn set(&self, key: &str, secret: &str) -> Result<(), Error> {
            if self.fail_set {
                Err(Error::CredentialFailure("injected".into()))
            } else {
                self.inner.set(key, secret)
            }
        }
        fn get(&self, key: &str) -> Result<Option<String>, Error> {
            self.inner.get(key)
        }
        fn delete(&self, key: &str) -> Result<(), Error> {
            if self.fail_delete {
                Err(Error::CredentialFailure("injected".into()))
            } else {
                self.inner.delete(key)
            }
        }
    }

    #[derive(Default)]
    struct RecordingStore {
        inner: MemoryCredentialStore,
        set_calls: std::sync::atomic::AtomicUsize,
        delete_calls: std::sync::atomic::AtomicUsize,
        set_keys: Mutex<Vec<String>>,
        write_then_error: std::sync::atomic::AtomicBool,
        fail_delete: std::sync::atomic::AtomicBool,
        on_set: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    }

    impl RecordingStore {
        fn configured(write_then_error: bool, fail_delete: bool) -> Self {
            let store = Self::default();
            store.set_write_then_error(write_then_error);
            store
                .fail_delete
                .store(fail_delete, std::sync::atomic::Ordering::Relaxed);
            store
        }

        fn set_write_then_error(&self, enabled: bool) {
            self.write_then_error
                .store(enabled, std::sync::atomic::Ordering::Relaxed);
        }

        #[cfg(unix)]
        fn set_on_set_hook(&self, hook: impl FnOnce() + Send + 'static) {
            *self.on_set.lock().unwrap() = Some(Box::new(hook));
        }

        #[cfg(unix)]
        fn set_count(&self) -> usize {
            self.set_calls.load(std::sync::atomic::Ordering::Relaxed)
        }

        #[cfg(unix)]
        fn delete_count(&self) -> usize {
            self.delete_calls.load(std::sync::atomic::Ordering::Relaxed)
        }

        #[cfg(unix)]
        fn last_set_key(&self) -> String {
            self.set_keys.lock().unwrap().last().unwrap().clone()
        }
    }

    impl CredentialStore for RecordingStore {
        fn set(&self, key: &str, secret: &str) -> Result<(), Error> {
            self.set_calls
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            self.set_keys.lock().unwrap().push(key.to_owned());
            self.inner.set(key, secret)?;
            if let Some(hook) = self.on_set.lock().unwrap().take() {
                hook();
            }
            if self
                .write_then_error
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                Err(Error::CredentialFailure(
                    "injected post-write failure".into(),
                ))
            } else {
                Ok(())
            }
        }

        fn get(&self, key: &str) -> Result<Option<String>, Error> {
            self.inner.get(key)
        }

        fn delete(&self, key: &str) -> Result<(), Error> {
            self.delete_calls
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if self.fail_delete.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(Error::CredentialFailure("injected delete failure".into()));
            }
            self.inner.delete(key)
        }
    }

    type PersistenceHook = Box<dyn FnOnce(&AuthorizedDir) + Send>;

    #[derive(Default)]
    struct RecordingPersistence {
        writes: std::sync::atomic::AtomicUsize,
        fail_on: Mutex<BTreeSet<usize>>,
        uncertain_on: Mutex<BTreeSet<usize>>,
        before_write: Mutex<BTreeMap<usize, PersistenceHook>>,
        after_write: Mutex<BTreeMap<usize, PersistenceHook>>,
    }

    impl RecordingPersistence {
        #[cfg(unix)]
        fn writes(&self) -> usize {
            self.writes.load(std::sync::atomic::Ordering::Relaxed)
        }

        fn fail_on(&self, write: usize) {
            self.fail_on.lock().unwrap().insert(write);
        }

        fn return_uncertain_on(&self, write: usize) {
            self.uncertain_on.lock().unwrap().insert(write);
        }

        #[cfg(unix)]
        fn before_write(&self, write: usize, hook: impl FnOnce(&AuthorizedDir) + Send + 'static) {
            self.before_write
                .lock()
                .unwrap()
                .insert(write, Box::new(hook));
        }

        #[cfg(unix)]
        fn after_write(&self, write: usize, hook: impl FnOnce(&AuthorizedDir) + Send + 'static) {
            self.after_write
                .lock()
                .unwrap()
                .insert(write, Box::new(hook));
        }
    }

    impl RegistryPersistence for RecordingPersistence {
        fn write(
            &self,
            directory: &AuthorizedDir,
            filename: &str,
            bytes: &[u8],
        ) -> Result<RegistryCommit, Error> {
            let write = self
                .writes
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                + 1;
            if let Some(hook) = self.before_write.lock().unwrap().remove(&write) {
                hook(directory);
            }
            if self.fail_on.lock().unwrap().contains(&write) {
                return Err(Error::CredentialFailure("injected registry failure".into()));
            }
            let commit = AtomicRegistryPersistence.write(directory, filename, bytes)?;
            if let Some(hook) = self.after_write.lock().unwrap().remove(&write) {
                hook(directory);
            }
            if self.uncertain_on.lock().unwrap().contains(&write) {
                Ok(RegistryCommit::CommittedDurabilityUncertain)
            } else {
                Ok(commit)
            }
        }
    }

    #[cfg(unix)]
    fn detach_credentials(app_data: &Path, displaced_name: &str, recreate: bool) -> PathBuf {
        let credentials = app_data.join("credentials");
        let displaced = app_data.join(displaced_name);
        fs::rename(&credentials, &displaced).unwrap();
        if recreate {
            fs::create_dir(&credentials).unwrap();
        }
        displaced
    }

    #[cfg(unix)]
    fn replace_credentials_with_file(app_data: &Path, displaced_name: &str) {
        detach_credentials(app_data, displaced_name, false);
        fs::write(app_data.join("credentials"), b"not a directory").unwrap();
    }

    #[cfg(unix)]
    struct PermissionRestore {
        path: PathBuf,
        mode: u32,
    }

    #[cfg(unix)]
    impl PermissionRestore {
        fn new(path: &Path) -> Self {
            use std::os::unix::fs::PermissionsExt;
            Self {
                path: path.to_path_buf(),
                mode: fs::metadata(path).unwrap().permissions().mode() & 0o777,
            }
        }
    }

    #[cfg(unix)]
    impl Drop for PermissionRestore {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(self.mode));
        }
    }

    #[cfg(unix)]
    fn make_unreadable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o0)).unwrap();
    }

    #[cfg(unix)]
    fn is_replaced_directory_error(result: &Result<LichessAccountStoreResult, Error>) -> bool {
        matches!(
            result,
            Err(Error::CredentialFailure(message))
                if message == "credential directory was replaced while the application was running"
        )
    }

    #[cfg(unix)]
    enum RegistryMutationAfterWrite {
        Delete,
        Symlink,
    }

    #[cfg(unix)]
    impl RegistryPersistence for RegistryMutationAfterWrite {
        fn write(
            &self,
            directory: &AuthorizedDir,
            filename: &str,
            bytes: &[u8],
        ) -> Result<RegistryCommit, Error> {
            AtomicRegistryPersistence.write(directory, filename, bytes)?;
            let registry_path = directory.path().join(REGISTRY_FILE);
            fs::remove_file(&registry_path).unwrap();
            if matches!(self, Self::Symlink) {
                let target = directory.path().join("registry-target.json");
                fs::write(&target, b"{}").unwrap();
                std::os::unix::fs::symlink(&target, &registry_path).unwrap();
            }
            Ok(RegistryCommit::Durable)
        }
    }

    #[test]
    fn public_registry_survives_restart_without_secret() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(MemoryCredentialStore::default());
        let manager = CredentialManager::new(store.clone());
        manager
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        assert!(manager.list().unwrap().is_empty());
        let result = manager
            .store_lichess_token("Felix".into(), "not-in-registry".into())
            .unwrap();
        let account = result.account;
        let content =
            fs::read_to_string(temp.path().join("credentials").join(REGISTRY_FILE)).unwrap();
        assert!(!content.contains("not-in-registry"));
        let after_restart = CredentialManager::new(store);
        after_restart
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        assert_eq!(after_restart.list().unwrap(), vec![account]);
    }

    #[test]
    fn failed_keyring_add_is_not_visible_or_retained_after_restart() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(FailStore {
            fail_set: true,
            ..Default::default()
        });
        let manager = CredentialManager::new(store.clone());
        manager
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        let capture = crate::error::LogCaptureScope::start();
        assert!(manager
            .store_lichess_token("a".into(), "secret".into())
            .is_err());
        // The keyring's own cause reaches the native log, not only "requires recovery".
        assert!(capture
            .messages()
            .iter()
            .any(|message| message.contains("injected")));
        assert!(manager.list().unwrap().is_empty());
        let after_restart = CredentialManager::new(store);
        after_restart
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        assert!(after_restart.list().unwrap().is_empty());
    }

    #[test]
    fn write_then_error_keyring_add_recovers_after_restart_without_leaking_a_token() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(RecordingStore::configured(true, false));
        let manager = CredentialManager::new(store.clone());
        manager
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        assert!(matches!(
            manager.store_lichess_token("a".into(), "secret".into()),
            Err(Error::CredentialRecoveryRequired)
        ));
        assert!(manager.list().unwrap().is_empty());
        assert!(
            !fs::read_to_string(temp.path().join("credentials").join(REGISTRY_FILE))
                .unwrap()
                .contains("secret")
        );
        let after_restart = CredentialManager::new(store);
        after_restart
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        assert_eq!(after_restart.list().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn pending_delete_tombstone_refuses_token_while_secret_remains() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(RecordingStore::configured(false, true));
        let manager = Arc::new(CredentialManager::new(store.clone()));
        manager
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        let account = manager
            .store_lichess_token("a".into(), "secret".into())
            .unwrap()
            .account;
        let handle = account.handle;

        assert!(manager.remove(&handle).is_err());
        assert!(manager.list().unwrap().is_empty());
        assert_eq!(store.get(&handle.key()).unwrap().as_deref(), Some("secret"));
        assert!(matches!(
            manager.registry.lock().unwrap().accounts.get(&handle.0),
            Some(AccountRecord::PendingDelete(_))
        ));
        assert!(matches!(manager.token(&handle), Ok(None)));
        assert!(matches!(manager.token_async(handle).await, Ok(None)));
    }

    #[test]
    fn pending_delete_reconciles_idempotently_after_restart() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(MemoryCredentialStore::default());
        let manager = CredentialManager::new(store.clone());
        manager
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        let account = manager
            .store_lichess_token("a".into(), "secret".into())
            .unwrap()
            .account;
        {
            let mut registry = manager.registry.lock().unwrap();
            registry.accounts.insert(
                account.handle.0.clone(),
                AccountRecord::PendingDelete(account.clone()),
            );
            manager.persist_locked(&registry).unwrap();
        }
        let after_restart = CredentialManager::new(store.clone());
        after_restart
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        assert!(after_restart.list().unwrap().is_empty());
        assert_eq!(store.get(&account.handle.key()).unwrap(), None);
    }

    #[test]
    fn final_add_write_failure_keeps_journal_for_restart_reconciliation() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(MemoryCredentialStore::default());
        let persistence = Arc::new(RecordingPersistence::default());
        persistence.fail_on(3);
        let manager = CredentialManager::with_persistence(store.clone(), persistence);
        manager
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        // The failed write's own cause stays in the error, for the native log.
        assert!(matches!(
            manager.store_lichess_token("a".into(), "secret".into()),
            Err(Error::CredentialFailure(message))
                if message.starts_with("credential registry update failed: ")
                    && message.contains("injected")
        ));
        assert!(manager.list().unwrap().is_empty());
        let after_restart = CredentialManager::new(store);
        after_restart
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        assert_eq!(after_restart.list().unwrap().len(), 1);
    }

    #[test]
    fn durability_uncertain_pending_add_journal_is_reported() {
        let temp = tempfile::tempdir().unwrap();
        let persistence = Arc::new(RecordingPersistence::default());
        persistence.return_uncertain_on(2);
        let manager = CredentialManager::with_persistence(
            Arc::new(MemoryCredentialStore::default()),
            persistence,
        );
        manager
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        let result = manager
            .store_lichess_token("a".into(), "secret".into())
            .unwrap();
        assert!(result.durability_uncertain);
        assert_eq!(manager.list().unwrap(), vec![result.account]);
    }

    #[test]
    fn durability_uncertain_final_add_journal_is_reported() {
        let temp = tempfile::tempdir().unwrap();
        let persistence = Arc::new(RecordingPersistence::default());
        persistence.return_uncertain_on(3);
        let manager = CredentialManager::with_persistence(
            Arc::new(MemoryCredentialStore::default()),
            persistence,
        );
        manager
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        let result = manager
            .store_lichess_token("a".into(), "secret".into())
            .unwrap();
        assert!(result.durability_uncertain);
        assert_eq!(manager.list().unwrap(), vec![result.account]);
    }

    #[test]
    fn durability_uncertain_pending_delete_journal_is_reported() {
        let temp = tempfile::tempdir().unwrap();
        let persistence = Arc::new(RecordingPersistence::default());
        persistence.return_uncertain_on(4);
        let manager = CredentialManager::with_persistence(
            Arc::new(MemoryCredentialStore::default()),
            persistence,
        );
        manager
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        let account = manager
            .store_lichess_token("a".into(), "secret".into())
            .unwrap()
            .account;
        let removal = manager.remove(&account.handle).unwrap().unwrap();
        assert!(removal.durability_uncertain);
        assert_eq!(removal.token.as_deref(), Some("secret"));
        assert!(manager.list().unwrap().is_empty());
    }

    #[test]
    fn durability_uncertain_final_delete_journal_is_reported() {
        let temp = tempfile::tempdir().unwrap();
        let persistence = Arc::new(RecordingPersistence::default());
        persistence.return_uncertain_on(5);
        let manager = CredentialManager::with_persistence(
            Arc::new(MemoryCredentialStore::default()),
            persistence,
        );
        manager
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        let account = manager
            .store_lichess_token("a".into(), "secret".into())
            .unwrap()
            .account;
        let removal = manager.remove(&account.handle).unwrap().unwrap();
        assert!(removal.durability_uncertain);
        assert_eq!(removal.token.as_deref(), Some("secret"));
        assert!(manager.list().unwrap().is_empty());
    }

    #[test]
    fn reauthentication_reuses_the_existing_opaque_handle() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(MemoryCredentialStore::default());
        let manager = CredentialManager::new(store.clone());
        manager
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        let first = manager
            .store_lichess_token("Felix".into(), "first-token".into())
            .unwrap()
            .account;
        let second = manager
            .store_lichess_token("felix".into(), "replacement-token".into())
            .unwrap();
        assert!(!second.durability_uncertain);
        assert_eq!(first, second.account);
        assert_eq!(manager.list().unwrap(), vec![first.clone()]);
        assert_eq!(
            store.get(&first.handle.key()).unwrap().as_deref(),
            Some("replacement-token")
        );
        assert!(
            !fs::read_to_string(temp.path().join("credentials").join(REGISTRY_FILE))
                .unwrap()
                .contains("replacement-token")
        );
    }

    #[cfg(unix)]
    #[test]
    fn registry_and_its_parent_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("credentials");
        let manager = CredentialManager::new(Arc::new(MemoryCredentialStore::default()));
        manager
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(directory.join(REGISTRY_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    /// The configured release and development identifiers must produce their corresponding,
    /// disjoint credential-manager service names.
    #[test]
    fn keyring_service_is_derived_from_the_bundle_identifier() {
        assert_eq!(
            OsCredentialStore::new("com.chessriddle.studio").service,
            "com.chessriddle.studio.lichess"
        );
        assert_eq!(
            OsCredentialStore::new("com.chessriddle.studio.dev").service,
            "com.chessriddle.studio.dev.lichess"
        );
    }

    #[cfg(target_os = "linux")]
    fn session_decrypt_failure() -> keyring::Error {
        keyring::Error::PlatformFailure(Box::new(dbus_secret_service::Error::Crypto(
            "Unpad Error".into(),
        )))
    }

    /// A read that answers with the given outcomes in turn and counts its calls.
    fn scripted_read(
        outcomes: Vec<keyring::Result<String>>,
    ) -> (
        impl FnMut() -> keyring::Result<String>,
        Arc<std::sync::atomic::AtomicUsize>,
    ) {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = calls.clone();
        let mut outcomes = outcomes.into_iter();
        let read = move || {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            outcomes
                .next()
                .expect("the read was called more often than scripted")
        };
        (read, calls)
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_read_the_session_could_not_decrypt_is_read_again() {
        let (read, calls) =
            scripted_read(vec![Err(session_decrypt_failure()), Ok("secret".into())]);
        assert_eq!(
            read_with_session_retry(read).unwrap().as_deref(),
            Some("secret")
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_second_decrypt_failure_is_reported_without_a_third_read() {
        let (read, calls) = scripted_read(vec![
            Err(session_decrypt_failure()),
            Err(session_decrypt_failure()),
        ]);
        let error = read_with_session_retry(read).unwrap_err();
        assert!(
            matches!(error, Error::CredentialFailure(ref text) if text.contains("Unpad Error"))
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn other_keyring_failures_and_absent_entries_are_read_once() {
        let (read, calls) =
            scripted_read(vec![Err(keyring::Error::NoStorageAccess("locked".into()))]);
        assert!(read_with_session_retry(read).is_err());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);

        #[cfg(target_os = "linux")]
        {
            let (read, calls) = scripted_read(vec![Err(keyring::Error::PlatformFailure(
                Box::new(dbus_secret_service::Error::Unavailable),
            ))]);
            assert!(read_with_session_retry(read).is_err());
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        }

        let (read, calls) = scripted_read(vec![Err(keyring::Error::NoEntry)]);
        assert_eq!(read_with_session_retry(read).unwrap(), None);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn keyring_lockfile_includes_a_platform_backend() {
        let manifest = include_str!("../Cargo.toml");
        let lockfile = include_str!("../Cargo.lock");

        for feature in [
            "sync-secret-service",
            "crypto-rust",
            "apple-native",
            "windows-native",
        ] {
            assert!(
                manifest.contains(feature),
                "missing keyring feature {feature}"
            );
        }
        assert!(lockfile.contains("name = \"dbus-secret-service\""));
    }

    #[tokio::test]
    async fn async_store_methods_do_not_run_on_the_caller_thread() {
        let caller = std::thread::current().id();
        let store = Arc::new(ThreadRecordingStore::default());
        let manager = Arc::new(CredentialManager::new(store.clone()));
        let temp = tempfile::tempdir().unwrap();
        manager
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();

        let unknown = LichessAccountHandle::new();
        assert_eq!(manager.token_async(unknown).await.unwrap(), None);
        let account = manager
            .store_lichess_token_async("user".into(), "secret".into())
            .await
            .unwrap()
            .account;
        assert_eq!(
            manager
                .remove_async(account.handle)
                .await
                .unwrap()
                .and_then(|removal| removal.token),
            Some("secret".into()),
        );

        let observed = store.threads.lock().unwrap();
        assert!(!observed.is_empty());
        assert!(observed.iter().all(|thread| *thread != caller));
    }

    #[cfg(unix)]
    #[test]
    fn initialize_refuses_a_symlinked_credential_directory() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        fs::create_dir(&target).unwrap();
        let link = temp.path().join("credentials");
        symlink(&target, &link).unwrap();
        let manager = CredentialManager::new(Arc::new(MemoryCredentialStore::default()));

        assert!(matches!(
            manager.initialize(&AppDataDir::for_test(temp.path())),
            Err(Error::CredentialFailure(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn initialize_refuses_a_symlinked_registry_file() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("credentials");
        fs::create_dir(&directory).unwrap();
        let target = temp.path().join("registry-target.json");
        fs::write(&target, r#"{"version":2,"accounts":{}}"#).unwrap();
        symlink(&target, directory.join(REGISTRY_FILE)).unwrap();
        let manager = CredentialManager::new(Arc::new(MemoryCredentialStore::default()));

        assert!(matches!(
            manager.initialize(&AppDataDir::for_test(temp.path())),
            Err(Error::CredentialFailure(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn open_private_registry_refuses_a_symlinked_registry_file() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let directory = ensure_app_owned_default_dir(
            &AppDataDir::for_test(temp.path()),
            AppOwnedDefaultRoot::Credentials,
        )
        .unwrap();
        let target = temp.path().join("registry-target.json");
        fs::write(&target, r#"{"version":2,"accounts":{}}"#).unwrap();
        symlink(&target, directory.path().join(REGISTRY_FILE)).unwrap();

        assert!(matches!(
            open_private_registry(&directory),
            Err(Error::Io(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn load_registry_enforces_private_mode() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let directory = ensure_app_owned_default_dir(
            &AppDataDir::for_test(temp.path()),
            AppOwnedDefaultRoot::Credentials,
        )
        .unwrap();
        let registry_path = directory.path().join(REGISTRY_FILE);
        fs::write(&registry_path, br#"{"version":2,"accounts":{}}"#).unwrap();
        fs::set_permissions(&registry_path, fs::Permissions::from_mode(0o644)).unwrap();

        CredentialManager::default()
            .load_registry(&directory)
            .unwrap();

        assert_eq!(
            fs::metadata(registry_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn initialize_rejects_a_registry_deleted_during_enforcement() {
        let temp = tempfile::tempdir().unwrap();
        let manager = CredentialManager::with_persistence(
            Arc::new(MemoryCredentialStore::default()),
            Arc::new(RegistryMutationAfterWrite::Delete),
        );

        assert!(matches!(
            manager.initialize(&AppDataDir::for_test(temp.path())),
            Err(Error::CredentialFailure(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn initialize_maps_a_registry_symlink_error_during_enforcement() {
        let temp = tempfile::tempdir().unwrap();
        let manager = CredentialManager::with_persistence(
            Arc::new(MemoryCredentialStore::default()),
            Arc::new(RegistryMutationAfterWrite::Symlink),
        );

        assert!(matches!(
            manager.initialize(&AppDataDir::for_test(temp.path())),
            Err(Error::CredentialFailure(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn open_private_registry_refuses_a_fifo_registry_file() {
        let temp = tempfile::tempdir().unwrap();
        let directory = ensure_app_owned_default_dir(
            &AppDataDir::for_test(temp.path()),
            AppOwnedDefaultRoot::Credentials,
        )
        .unwrap();
        let fifo = directory.path().join(REGISTRY_FILE);
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(status.success());
        let _fifo_endpoint = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&fifo)
            .unwrap();

        assert!(matches!(
            open_private_registry(&directory),
            Err(Error::InvalidInput(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn retained_credential_directory_descriptor_is_used_after_rename() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(RecordingStore::default());
        let persistence = Arc::new(RecordingPersistence::default());
        let manager = CredentialManager::with_persistence(store.clone(), persistence.clone());
        manager
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();

        let writes_before = persistence.writes();
        let renamed = detach_credentials(temp.path(), "credentials-renamed", true);

        let result = manager.store_lichess_token("user".into(), "secret".into());

        assert!(is_replaced_directory_error(&result));
        assert_eq!(store.set_count(), 0);
        assert_eq!(persistence.writes(), writes_before);
        assert!(manager.list().unwrap().is_empty());
        assert_eq!(
            fs::read_dir(temp.path().join("credentials"))
                .unwrap()
                .count(),
            0
        );
        assert_eq!(fs::read_dir(renamed).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn credential_add_refuses_a_renamed_directory_left_absent() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(RecordingStore::default());
        let persistence = Arc::new(RecordingPersistence::default());
        let manager = CredentialManager::with_persistence(store.clone(), persistence.clone());
        manager
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        let writes_before = persistence.writes();
        detach_credentials(temp.path(), "credentials-renamed", false);

        let result = manager.store_lichess_token("user".into(), "secret".into());

        assert!(is_replaced_directory_error(&result));
        assert_eq!(store.set_count(), 0);
        assert_eq!(persistence.writes(), writes_before);
        assert!(manager.list().unwrap().is_empty());
        assert!(!temp.path().join("credentials").exists());
    }

    #[cfg(unix)]
    #[test]
    fn credential_reauthentication_refuses_replaced_directory_without_changing_secret() {
        for recreate in [true, false] {
            let temp = tempfile::tempdir().unwrap();
            let store = Arc::new(RecordingStore::default());
            let persistence = Arc::new(RecordingPersistence::default());
            let manager = CredentialManager::with_persistence(store.clone(), persistence.clone());
            manager
                .initialize(&AppDataDir::for_test(temp.path()))
                .unwrap();
            let account = manager
                .store_lichess_token("user".into(), "existing-secret".into())
                .unwrap()
                .account;
            let sets_before = store.set_count();
            let writes_before = persistence.writes();
            detach_credentials(temp.path(), "credentials-renamed", recreate);

            let result = manager.store_lichess_token("USER".into(), "new-secret".into());

            assert!(is_replaced_directory_error(&result));
            assert_eq!(store.set_count(), sets_before);
            assert_eq!(persistence.writes(), writes_before);
            assert_eq!(
                store.inner.get(&account.handle.key()).unwrap().as_deref(),
                Some("existing-secret")
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn credential_add_refuses_an_unreadable_startup_location_before_writing() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(RecordingStore::default());
        let persistence = Arc::new(RecordingPersistence::default());
        let manager = CredentialManager::with_persistence(store.clone(), persistence.clone());
        manager
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();
        let writes_before = persistence.writes();
        let restore = PermissionRestore::new(temp.path());
        make_unreadable(temp.path());

        let result = manager.store_lichess_token("user".into(), "secret".into());
        drop(restore);

        assert!(is_replaced_directory_error(&result));
        assert_eq!(store.set_count(), 0);
        assert_eq!(persistence.writes(), writes_before);
    }

    #[cfg(unix)]
    #[test]
    fn replacement_during_successful_or_write_then_error_set_is_compensated_for_add_and_reauth() {
        for write_then_error in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let app_data = temp.path().to_path_buf();
            let store = Arc::new(RecordingStore::configured(write_then_error, false));
            let manager = CredentialManager::new(store.clone());
            manager
                .initialize(&AppDataDir::for_test(&app_data))
                .unwrap();
            store.set_on_set_hook(move || {
                detach_credentials(&app_data, "credentials-after-add-set", true);
            });

            let result = manager.store_lichess_token("user".into(), "secret".into());

            assert!(is_replaced_directory_error(&result));
            assert_eq!(store.set_count(), 1);
            assert_eq!(store.delete_count(), 1);
            assert_eq!(store.inner.get(&store.last_set_key()).unwrap(), None);
            assert!(manager.list().unwrap().is_empty());

            let temp = tempfile::tempdir().unwrap();
            let app_data = temp.path().to_path_buf();
            let store = Arc::new(RecordingStore::default());
            let manager = CredentialManager::new(store.clone());
            manager
                .initialize(&AppDataDir::for_test(&app_data))
                .unwrap();
            let account = manager
                .store_lichess_token("user".into(), "existing-secret".into())
                .unwrap()
                .account;
            store.set_write_then_error(write_then_error);
            store.set_on_set_hook(move || {
                detach_credentials(&app_data, "credentials-after-reauth-set", true);
            });

            let result = manager.store_lichess_token("USER".into(), "new-secret".into());

            assert!(is_replaced_directory_error(&result));
            assert_eq!(store.set_count(), 2);
            assert_eq!(store.delete_count(), 1);
            assert_eq!(store.inner.get(&account.handle.key()).unwrap(), None);
        }
    }

    #[cfg(unix)]
    #[test]
    fn replacement_before_successful_or_failing_active_write_is_compensated() {
        for fail_active_write in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let app_data = temp.path().to_path_buf();
            let store = Arc::new(RecordingStore::default());
            let persistence = Arc::new(RecordingPersistence::default());
            let manager = CredentialManager::with_persistence(store.clone(), persistence.clone());
            manager
                .initialize(&AppDataDir::for_test(&app_data))
                .unwrap();
            persistence.before_write(3, move |_| {
                detach_credentials(&app_data, "credentials-during-active-write", true);
            });
            if fail_active_write {
                persistence.fail_on(3);
            }

            let result = manager.store_lichess_token("user".into(), "secret".into());

            assert!(is_replaced_directory_error(&result));
            assert_eq!(persistence.writes(), 3);
            assert_eq!(store.set_count(), 1);
            assert_eq!(store.delete_count(), 1);
            assert_eq!(store.inner.get(&store.last_set_key()).unwrap(), None);
            assert!(manager.list().unwrap().is_empty());
        }
    }

    #[cfg(unix)]
    #[test]
    fn replacement_verification_error_after_set_is_compensated_for_add_and_reauth() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        for reauthenticate in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let app_data = temp.path().to_path_buf();
            let store = Arc::new(RecordingStore::default());
            let manager = CredentialManager::new(store.clone());
            manager
                .initialize(&AppDataDir::for_test(&app_data))
                .unwrap();
            let account = if reauthenticate {
                Some(
                    manager
                        .store_lichess_token("user".into(), "existing-secret".into())
                        .unwrap()
                        .account,
                )
            } else {
                None
            };
            let restore = PermissionRestore::new(&app_data);
            store.set_on_set_hook(move || make_unreadable(&app_data));

            let result = manager.store_lichess_token(
                if reauthenticate { "USER" } else { "user" }.into(),
                "new-secret".into(),
            );
            drop(restore);

            assert!(is_replaced_directory_error(&result));
            assert_eq!(store.delete_count(), 1);
            let key = account
                .as_ref()
                .map(|account| account.handle.key())
                .unwrap_or_else(|| store.last_set_key());
            assert_eq!(store.inner.get(&key).unwrap(), None);
        }
    }

    #[cfg(unix)]
    #[test]
    fn failed_compensating_delete_is_reconciled_from_startup_location_tombstone() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().to_path_buf();
        let store = Arc::new(RecordingStore::configured(false, true));
        let persistence = Arc::new(RecordingPersistence::default());
        let manager = CredentialManager::with_persistence(store.clone(), persistence.clone());
        manager
            .initialize(&AppDataDir::for_test(&app_data))
            .unwrap();
        store.set_on_set_hook({
            let app_data = app_data.clone();
            move || {
                detach_credentials(&app_data, "credentials-before-tombstone", true);
            }
        });

        let result = manager.store_lichess_token("user".into(), "secret".into());

        assert!(is_replaced_directory_error(&result));
        assert_eq!(store.set_count(), 1);
        assert_eq!(store.delete_count(), 1);
        let key = store.last_set_key();
        assert_eq!(store.inner.get(&key).unwrap().as_deref(), Some("secret"));
        assert!(matches!(
            serde_json::from_slice::<RegistryFile>(
                &fs::read(app_data.join("credentials").join(REGISTRY_FILE)).unwrap()
            )
            .unwrap()
            .accounts
            .get(key.strip_prefix("lichess-account:").unwrap()),
            Some(AccountRecord::PendingDelete(_))
        ));

        let restart_store = Arc::new(MemoryCredentialStore::default());
        restart_store.set(&key, "secret").unwrap();
        CredentialManager::new(restart_store.clone())
            .initialize(&AppDataDir::for_test(&app_data))
            .unwrap();
        assert_eq!(restart_store.get(&key).unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn failed_compensating_delete_reacquires_a_missing_credential_leaf() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().to_path_buf();
        let store = Arc::new(RecordingStore::configured(false, true));
        let persistence = Arc::new(RecordingPersistence::default());
        let manager = CredentialManager::with_persistence(store.clone(), persistence);
        manager
            .initialize(&AppDataDir::for_test(&app_data))
            .unwrap();
        store.set_on_set_hook({
            let app_data = app_data.clone();
            move || {
                detach_credentials(&app_data, "credentials-absent-before-tombstone", false);
            }
        });

        let result = manager.store_lichess_token("user".into(), "secret".into());

        assert!(is_replaced_directory_error(&result));
        assert_eq!(store.set_count(), 1);
        assert_eq!(store.delete_count(), 1);
        let key = store.last_set_key();
        assert_eq!(store.inner.get(&key).unwrap().as_deref(), Some("secret"));
        let registry: RegistryFile = serde_json::from_slice(
            &fs::read(app_data.join("credentials").join(REGISTRY_FILE)).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            registry
                .accounts
                .get(key.strip_prefix("lichess-account:").unwrap()),
            Some(AccountRecord::PendingDelete(_))
        ));

        let restart_store = Arc::new(MemoryCredentialStore::default());
        restart_store.set(&key, "secret").unwrap();
        CredentialManager::new(restart_store.clone())
            .initialize(&AppDataDir::for_test(&app_data))
            .unwrap();
        assert_eq!(restart_store.get(&key).unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn failed_delete_and_tombstone_write_returns_recovery_required() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().to_path_buf();
        let store = Arc::new(RecordingStore::configured(false, true));
        let persistence = Arc::new(RecordingPersistence::default());
        let manager = CredentialManager::with_persistence(store.clone(), persistence.clone());
        manager
            .initialize(&AppDataDir::for_test(&app_data))
            .unwrap();
        persistence.fail_on(4);
        store.set_on_set_hook({
            let app_data = app_data.clone();
            move || {
                detach_credentials(&app_data, "credentials-before-failed-tombstone", true);
            }
        });

        let result = manager.store_lichess_token("user".into(), "secret".into());

        assert!(matches!(result, Err(Error::CredentialRecoveryRequired)));
        assert_eq!(store.set_count(), 1);
        assert_eq!(store.delete_count(), 1);
        assert_eq!(persistence.writes(), 4, "the tombstone write was attempted");
    }

    #[cfg(unix)]
    #[test]
    fn failed_delete_and_regular_startup_leaf_returns_recovery_required_without_write() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().to_path_buf();
        let store = Arc::new(RecordingStore::configured(false, true));
        let persistence = Arc::new(RecordingPersistence::default());
        let manager = CredentialManager::with_persistence(store.clone(), persistence.clone());
        manager
            .initialize(&AppDataDir::for_test(&app_data))
            .unwrap();
        store.set_on_set_hook({
            let app_data = app_data.clone();
            move || replace_credentials_with_file(&app_data, "credentials-before-file-leaf")
        });

        let result = manager.store_lichess_token("user".into(), "secret".into());

        assert!(matches!(result, Err(Error::CredentialRecoveryRequired)));
        assert_eq!(store.set_count(), 1);
        assert_eq!(store.delete_count(), 1);
        assert_eq!(
            persistence.writes(),
            3,
            "reacquire refused before a tombstone write"
        );
    }

    #[cfg(unix)]
    #[test]
    fn replaced_tombstone_directory_returns_recovery_required_after_write() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().to_path_buf();
        let store = Arc::new(RecordingStore::configured(false, true));
        let persistence = Arc::new(RecordingPersistence::default());
        let manager = CredentialManager::with_persistence(store.clone(), persistence.clone());
        manager
            .initialize(&AppDataDir::for_test(&app_data))
            .unwrap();
        store.set_on_set_hook({
            let app_data = app_data.clone();
            move || {
                detach_credentials(&app_data, "credentials-before-postwrite-check", true);
            }
        });
        persistence.after_write(4, {
            let app_data = app_data.clone();
            move |_| {
                detach_credentials(&app_data, "credentials-after-tombstone-write", true);
            }
        });

        let result = manager.store_lichess_token("user".into(), "secret".into());

        assert!(matches!(result, Err(Error::CredentialRecoveryRequired)));
        assert_eq!(store.set_count(), 1);
        assert_eq!(store.delete_count(), 1);
        assert_eq!(persistence.writes(), 4, "the tombstone write was attempted");
        assert!(app_data
            .join("credentials-after-tombstone-write")
            .join(REGISTRY_FILE)
            .is_file());
    }

    #[cfg(unix)]
    #[test]
    fn uncertain_tombstone_is_left_for_fresh_startup_reconciliation() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().to_path_buf();
        let store = Arc::new(RecordingStore::configured(false, true));
        let persistence = Arc::new(RecordingPersistence::default());
        let manager = CredentialManager::with_persistence(store.clone(), persistence.clone());
        manager
            .initialize(&AppDataDir::for_test(&app_data))
            .unwrap();
        persistence.return_uncertain_on(4);
        store.set_on_set_hook({
            let app_data = app_data.clone();
            move || {
                detach_credentials(&app_data, "credentials-before-uncertain-tombstone", true);
            }
        });

        let result = manager.store_lichess_token("user".into(), "secret".into());

        assert!(matches!(result, Err(Error::CredentialRecoveryRequired)));
        assert_eq!(store.set_count(), 1);
        assert_eq!(store.delete_count(), 1);
        assert_eq!(
            persistence.writes(),
            4,
            "the uncertain tombstone was committed"
        );
        let key = store.last_set_key();
        let restart_store = Arc::new(MemoryCredentialStore::default());
        restart_store.set(&key, "secret").unwrap();
        CredentialManager::new(restart_store.clone())
            .initialize(&AppDataDir::for_test(&app_data))
            .unwrap();
        assert_eq!(restart_store.get(&key).unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn invalid_startup_registry_prevents_tombstone_write_and_requires_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().to_path_buf();
        let store = Arc::new(RecordingStore::configured(false, true));
        let persistence = Arc::new(RecordingPersistence::default());
        let manager = CredentialManager::with_persistence(store.clone(), persistence.clone());
        manager
            .initialize(&AppDataDir::for_test(&app_data))
            .unwrap();
        store.set_on_set_hook({
            let app_data = app_data.clone();
            move || {
                detach_credentials(&app_data, "credentials-before-invalid-registry", true);
                fs::write(
                    app_data.join("credentials").join(REGISTRY_FILE),
                    b"not json",
                )
                .unwrap();
            }
        });

        let result = manager.store_lichess_token("user".into(), "secret".into());

        assert!(matches!(result, Err(Error::CredentialRecoveryRequired)));
        assert_eq!(store.set_count(), 1);
        assert_eq!(store.delete_count(), 1);
        assert_eq!(
            persistence.writes(),
            3,
            "load failure prevented a tombstone write"
        );
    }

    #[cfg(unix)]
    #[test]
    fn pending_add_reconciliation_reacquires_the_registry_lock_without_deadlock() {
        let temp = tempfile::tempdir().unwrap();
        let credentials = temp.path().join("credentials");
        fs::create_dir(&credentials).unwrap();
        let account = LichessAccountMetadata {
            handle: LichessAccountHandle::new(),
            username: "user".into(),
        };
        fs::write(
            credentials.join(REGISTRY_FILE),
            serde_json::to_vec(&RegistryFile {
                version: REGISTRY_VERSION,
                accounts: BTreeMap::from([(
                    account.handle.0.clone(),
                    AccountRecord::PendingAdd(account.clone()),
                )]),
            })
            .unwrap(),
        )
        .unwrap();

        let manager = Arc::new(CredentialManager::new(Arc::new(
            MemoryCredentialStore::default(),
        )));
        let app_data_dir = AppDataDir::for_test(temp.path());
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let worker = Arc::clone(&manager);
        std::thread::spawn(move || {
            result_tx.send(worker.initialize(&app_data_dir)).unwrap();
        });

        let result = result_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("credential initialization deadlocked during reconciliation");
        assert!(
            result.is_ok(),
            "pending-add reconciliation failed: {result:?}"
        );

        let reloaded: RegistryFile =
            serde_json::from_slice(&fs::read(credentials.join(REGISTRY_FILE)).unwrap()).unwrap();
        assert!(!reloaded.accounts.contains_key(&account.handle.0));
    }

    /// Guessing a namespace would silently reach into the release's secrets, so the placeholder that
    /// stands in before the identifier is known must refuse rather than fall back.  Asserted on the
    /// message: the variant alone cannot be told apart from a keyring backend failure.
    #[test]
    fn unbound_store_refuses_every_operation() {
        let store = UnboundCredentialStore;
        for outcome in [
            store.set("lichess-account:x", "secret").err(),
            store.get("lichess-account:x").err(),
            store.delete("lichess-account:x").err(),
        ] {
            match outcome {
                Some(Error::CredentialFailure(message)) => {
                    assert!(
                        message.contains("before it was bound to an application identifier"),
                        "unexpected message: {message}"
                    );
                }
                other => panic!("expected a refusal, got {other:?}"),
            }
        }
    }

    #[test]
    fn invalid_and_absent_handles_do_not_reach_the_credential_store() {
        let invalid = LichessAccountMetadata {
            handle: LichessAccountHandle("not-a-uuid".into()),
            username: "invalid".into(),
        };
        let manager = CredentialManager {
            provider: CredentialProvider::Lichess,
            store: Arc::new(UnboundCredentialStore),
            persistence: Arc::new(AtomicRegistryPersistence),
            registry: Mutex::new(RegistryFile {
                version: REGISTRY_VERSION,
                accounts: BTreeMap::from([(
                    invalid.handle.0.clone(),
                    AccountRecord::Active(invalid.clone()),
                )]),
            }),
            registry_dir: Mutex::new(None),
        };
        let absent = LichessAccountHandle("56d05779-a8d4-426b-97a6-a237a4b4d31d".into());

        assert_eq!(
            (
                manager.token(&invalid.handle).ok(),
                manager.remove(&invalid.handle).ok(),
                manager.remove(&absent).ok(),
                manager.list().unwrap(),
            ),
            (Some(None), Some(None), Some(None), vec![invalid],)
        );
    }

    #[test]
    fn poisoned_registry_rejects_operations_without_reaching_the_credential_store() {
        let store = Arc::new(CountingStore::default());
        let manager = CredentialManager::new(store.clone());
        poison(&manager.registry);

        let handle = LichessAccountHandle::new();
        assert!(matches!(
            manager.list(),
            Err(Error::CredentialRecoveryRequired)
        ));
        assert!(matches!(
            manager.token(&handle),
            Err(Error::CredentialRecoveryRequired)
        ));
        assert!(matches!(
            manager.store_lichess_token("user".into(), "secret".into()),
            Err(Error::CredentialRecoveryRequired)
        ));
        assert!(matches!(
            manager.remove(&handle),
            Err(Error::CredentialRecoveryRequired)
        ));
        assert_eq!(store.calls.load(std::sync::atomic::Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn poisoned_registry_rejects_async_token_reads() {
        let store = Arc::new(CountingStore::default());
        let manager = Arc::new(CredentialManager::new(store.clone()));
        poison(&manager.registry);

        assert!(matches!(
            manager.token_async(LichessAccountHandle::new()).await,
            Err(Error::CredentialRecoveryRequired)
        ));
        assert_eq!(store.calls.load(std::sync::atomic::Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn optional_lichess_token_async_resolves_anonymous_stored_and_missing_handles() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Arc::new(CredentialManager::new(Arc::new(
            MemoryCredentialStore::default(),
        )));
        manager
            .initialize(&AppDataDir::for_test(temp.path()))
            .unwrap();

        assert_eq!(
            manager.optional_lichess_token_async(None).await.unwrap(),
            None
        );

        let stored = manager
            .store_lichess_token("player".into(), "disposable-token".into())
            .unwrap()
            .account;
        assert_eq!(
            manager
                .optional_lichess_token_async(Some(stored.handle))
                .await
                .unwrap(),
            Some("disposable-token".into())
        );

        let missing = manager
            .optional_lichess_token_async(Some(LichessAccountHandle::new()))
            .await
            .unwrap_err();
        assert!(matches!(missing, Error::OAuthFailure(_)));
    }

    #[test]
    fn poisoned_registry_dir_rejects_mutations_without_reaching_the_credential_store() {
        let store = Arc::new(CountingStore::default());
        let manager = CredentialManager::new(store.clone());
        let account = LichessAccountMetadata {
            handle: LichessAccountHandle::new(),
            username: "user".into(),
        };
        manager.registry.lock().unwrap().accounts.insert(
            account.handle.0.clone(),
            AccountRecord::Active(account.clone()),
        );
        poison(&manager.registry_dir);

        assert!(matches!(
            manager.store_lichess_token("other".into(), "secret".into()),
            Err(Error::CredentialRecoveryRequired)
        ));
        assert!(matches!(
            manager.remove(&account.handle),
            Err(Error::CredentialRecoveryRequired)
        ));
        assert_eq!(store.calls.load(std::sync::atomic::Ordering::Relaxed), 0);
    }

    #[cfg(unix)]
    #[test]
    fn registry_version_migration_and_pathless_persistence_are_explicit() {
        let manager = CredentialManager::default();
        let current = RegistryFile {
            version: REGISTRY_VERSION,
            accounts: BTreeMap::new(),
        };
        let outdated = RegistryFile {
            version: REGISTRY_VERSION - 1,
            accounts: BTreeMap::new(),
        };
        let temp = tempfile::tempdir().unwrap();
        let directory = ensure_app_owned_default_dir(
            &AppDataDir::for_test(temp.path()),
            AppOwnedDefaultRoot::Credentials,
        )
        .unwrap();
        let legacy_path = directory.path().join(REGISTRY_FILE);
        let legacy = LichessAccountMetadata {
            handle: LichessAccountHandle("56d05779-a8d4-426b-97a6-a237a4b4d31d".into()),
            username: "Felix".into(),
        };
        let write = fs::write(
            &legacy_path,
            r#"{"version":1,"accounts":[{"handle":"56d05779-a8d4-426b-97a6-a237a4b4d31d","username":"Felix"}]}"#,
        );
        let migrated = manager.load_registry(&directory).ok().map(|registry| {
            (
                registry.version,
                registry
                    .accounts
                    .values()
                    .map(|record| record.metadata().clone())
                    .collect::<Vec<_>>(),
            )
        });

        assert_eq!(
            (
                manager.validate_registry(&outdated).is_err(),
                manager.persist_locked(&current).ok(),
                write.is_ok(),
                migrated,
            ),
            (
                true,
                Some(RegistryCommit::Durable),
                true,
                Some((REGISTRY_VERSION, vec![legacy])),
            )
        );
    }
}
