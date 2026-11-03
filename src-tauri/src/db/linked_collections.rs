//! Authoritative PGN collection identities and disposable, generation-qualified search caches.
use super::*;
use crate::file_workspace::{
    WorkspaceEntry, WorkspaceEntryKind, WorkspaceFileType, WorkspaceListing,
};
use crate::infra::{
    fs::{
        atomic_create_at_identified, atomic_replace_at, create_regular_at, entry_identity_at,
        open_regular_at, read_bounded_bytes, read_directory_entries_at, remove_entry_at,
        require_durable, single_leaf, DirectoryEntryKind, RegularFileAccess,
    },
    path_authority::{
        self as authority, AppDataDir, AppOwnedDefaultRoot, AuthorizedDir, SharedPathAuthority,
    },
};
use crate::pgn::{self, PgnRepository};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    ffi::OsString,
    io::{Read, Seek, SeekFrom},
    sync::Mutex,
};
use uuid::Uuid;
pub(crate) mod batch;
mod legacy;
use batch::digest_file;

const REGISTRY: &str = "registry.json";
const MAX_RECORDS: usize = 4096;
const MAX_REGISTRY_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_ACCOUNT_NAME_BYTES: usize = 64;
const MAX_SELECTED_GAMES: usize = 1000;
const MAX_PLAYER_NAME_BYTES: usize = 1024;
const BACKUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const BACKUP_PAGE_STEP: i32 = 128;
const BACKUP_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(10);
const MIGRATION_SOURCE_OWNER_RETRY: std::time::Duration = std::time::Duration::from_millis(25);
const SOURCE_REBUILD_ATTEMPTS: usize = 3;

#[cfg(test)]
pub(crate) static RECORD_DOWNLOAD_FAILURE: crate::infra::test_hooks::KeyedTestValues<
    (String, String),
    Error,
> = crate::infra::test_hooks::KeyedTestValues::new();

pub(crate) async fn record_download_receipt(
    authority: &SharedPathAuthority,
    file: FileWorkspaceHandle,
    provider: &str,
    account: &str,
    since_ms: Option<i64>,
    coverage_holds: Option<Vec<crate::lichess::CoverageHold>>,
    cancellation: CancellationToken,
) -> Option<Error> {
    async {
        if let Some(service) = authority.collections()? {
            let authority = authority.clone();
            let provider = provider.to_owned();
            let account = account.to_owned();
            crate::infra::blocking::BLOCKING_GATEWAY
                .spawn_cancellable(cancellation, move |token| {
                    service.record_download(
                        &authority,
                        file,
                        &provider,
                        &account,
                        since_ms,
                        coverage_holds.as_deref(),
                        token,
                    )
                })
                .await?;
        }
        Ok::<_, Error>(())
    }
    .await
    .err()
}

pub(crate) fn supported() -> bool {
    cfg!(any(target_os = "linux", target_os = "macos"))
}

#[tauri::command]
#[specta::specta]
pub(crate) fn linked_collections_supported() -> bool {
    supported()
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountIdentity {
    pub provider: String,
    pub account: String,
}

impl AccountIdentity {
    fn validate(mut self) -> Result<Self, Error> {
        if !matches!(self.provider.as_str(), "lichess" | "chesscom")
            || self.account.is_empty()
            || self.account.len() > MAX_ACCOUNT_NAME_BYTES
            || !self
                .account
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(Error::InvalidInput(
                "invalid collection account identity".into(),
            ));
        }
        self.account.make_ascii_lowercase();
        Ok(self)
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    id: Uuid,
    workspace: FileWorkspaceHandle,
    #[serde(
        serialize_with = "serialize_locator",
        deserialize_with = "deserialize_locator"
    )]
    locator: Vec<OsString>,
    // Retain the last verified trash binding for cleanup after authority removes the handle.
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        serialize_with = "serialize_locator",
        deserialize_with = "deserialize_locator"
    )]
    trash_locator: Vec<OsString>,
    file: FileWorkspaceHandle,
    identity: (u64, u64),
    #[serde(default)]
    source_epoch: u64,
    purpose: WorkspaceFileType,
    account: Option<AccountIdentity>,
    database: Option<DatabaseHandle>,
    retired_database: Option<DatabaseHandle>,
    #[serde(default)]
    pending: Option<batch::PendingBatch>,
    #[serde(default)]
    coverage_cursor_ms: Option<i64>,
    #[serde(default)]
    coverage_cursor_current: bool,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct SourceBinding {
    id: Uuid,
    workspace: FileWorkspaceHandle,
    locator: Vec<OsString>,
    file: FileWorkspaceHandle,
    identity: (u64, u64),
    source_epoch: u64,
    purpose: WorkspaceFileType,
    preserved_original: bool,
}

impl SourceBinding {
    pub(crate) fn collection(&self) -> Uuid {
        self.id
    }

    pub(crate) fn is_preserved_original(&self) -> bool {
        self.preserved_original
    }
}

impl Record {
    fn is_trashed(&self) -> bool {
        !self.trash_locator.is_empty()
    }

    fn source_is_trashed(&self, authority: &SharedPathAuthority) -> bool {
        match relative_locator(authority, &self.workspace, &self.file) {
            Ok(locator) => crate::file_workspace::is_trash_locator(&locator),
            Err(_) => self.is_trashed(),
        }
    }

    fn binding(&self) -> SourceBinding {
        SourceBinding {
            id: self.id,
            workspace: self.workspace.clone(),
            locator: self.locator.clone(),
            file: self.file.clone(),
            identity: self.identity,
            source_epoch: self.source_epoch,
            purpose: self.purpose.clone(),
            preserved_original: false,
        }
    }
}

fn visit_file_entries(entries: &[WorkspaceEntry], visit: &mut impl FnMut(&WorkspaceEntry)) {
    for entry in entries {
        match entry.kind {
            WorkspaceEntryKind::File => visit(entry),
            WorkspaceEntryKind::Directory => visit_file_entries(&entry.children, visit),
        }
    }
}

fn selected_metadata(
    entries: &[WorkspaceEntry],
    file: &FileWorkspaceHandle,
) -> Option<crate::file_workspace::WorkspaceMetadata> {
    entries.iter().find_map(|entry| {
        if entry.handle == *file {
            entry.metadata.clone()
        } else {
            selected_metadata(&entry.children, file)
        }
    })
}

fn relative_locator(
    authority: &SharedPathAuthority,
    workspace: &FileWorkspaceHandle,
    file: &FileWorkspaceHandle,
) -> Result<Vec<OsString>, Error> {
    authority.with_mut(|authority| {
        let root = authority.workspace_root(workspace, PathOperation::ReadPgn)?;
        let path = authority.workspace_entry_path(file, PathOperation::ReadPgn)?;
        Ok(path
            .strip_prefix(root)
            .map_err(|_| Error::StaleGame)?
            .components()
            .map(|part| part.as_os_str().to_os_string())
            .collect())
    })?
}

fn serialize_locator<S: serde::Serializer>(
    parts: &[OsString],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    parts
        .iter()
        .map(|part| authority::NativePath::from_path(std::path::Path::new(part)))
        .collect::<Vec<_>>()
        .serialize(serializer)
}

fn deserialize_locator<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<OsString>, D::Error> {
    Vec::<authority::NativePath>::deserialize(deserializer)?
        .into_iter()
        .map(|part| {
            part.to_path()
                .map(std::path::PathBuf::into_os_string)
                .map_err(serde::de::Error::custom)
        })
        .collect()
}

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    version: u32,
    records: Vec<Record>,
    #[serde(default)]
    migrations: Vec<MigrationIntent>,
    #[serde(default)]
    creations: Vec<CreationIntent>,
    #[serde(default)]
    restores: Vec<RestoreIntent>,
    #[serde(default)]
    downloads: Vec<ProviderDownload>,
}

impl Registry {
    fn creation_for_source(
        &self,
        authority: &SharedPathAuthority,
        workspace: &FileWorkspaceHandle,
        file: &FileWorkspaceHandle,
        locator: &[OsString],
        purpose: &WorkspaceFileType,
    ) -> Result<Option<CreationIntent>, Error> {
        let mut matched = None;
        let mut source_identity = None;
        for creation in &self.creations {
            let intended_locator = vec![OsString::from(crate::file_workspace::pgn_name(
                &creation.name,
            )?)];
            let at_locator = creation.workspace == *workspace && intended_locator == locator;
            if !at_locator
                && !matches!(
                    purpose,
                    WorkspaceFileType::Game | WorkspaceFileType::Tournament
                )
            {
                continue;
            }
            let identity = if let Some(identity) = source_identity {
                identity
            } else {
                let identity = authority.with_mut(|authority| {
                    authority
                        .resolve(file.path_ref(), PathOperation::ReadPgn, &[])?
                        .pgn_snapshot()
                        .map(|snapshot| snapshot.identity.pair())
                })??;
                source_identity = Some(identity);
                identity
            };
            if !at_locator && creation.identity != Some(identity) {
                continue;
            }
            if matched.is_some()
                || creation.workspace != *workspace
                || intended_locator != locator
                || creation.identity != Some(identity)
                || *purpose != WorkspaceFileType::Game
                || self.records.iter().any(|record| {
                    (record.id == creation.id
                        || record.file == *file
                        || record.identity == identity
                        || record.workspace == *workspace
                            && !record.is_trashed()
                            && record.locator == locator
                        || record.account.as_ref() == Some(&creation.account))
                        && !(record.id == creation.id
                            && record.workspace == *workspace
                            && record.locator == locator
                            && record.file == *file
                            && record.identity == identity
                            && record.purpose == *purpose
                            && record.account.as_ref() == Some(&creation.account))
                })
                || self.migrations.iter().any(|intent| {
                    intent.source.as_ref() == Some(file)
                        || intent.destination.as_ref() == Some(file)
                        || intent.destination_identity == Some(identity)
                        || intent.collection == Some(creation.id)
                        || intent.original_collection == Some(creation.id)
                })
            {
                return Err(Error::Conflict(
                    "account creation source ownership cannot be confirmed".into(),
                ));
            }
            matched = Some(creation.clone());
        }
        Ok(matched)
    }

    fn pending_destination(&self, collection: Uuid) -> bool {
        self.records
            .iter()
            .find(|record| record.id == collection)
            .is_some_and(|record| {
                self.migrations.iter().any(|intent| {
                    intent.choice == MigrationChoice::Database
                        && intent.collection.is_none()
                        && intent.workspace == record.workspace
                        && (intent.destination.as_ref() == Some(&record.file)
                            || intent.destination_identity == Some(record.identity))
                })
            })
    }

    fn inactive_migration_index(&self, collection: Uuid) -> bool {
        self.preserves_original(collection) || self.pending_destination(collection)
    }

    fn source_binding(
        &self,
        authority: &SharedPathAuthority,
        file: &FileWorkspaceHandle,
        identity: (u64, u64),
    ) -> Option<SourceBinding> {
        self.records
            .iter()
            .find(|record| {
                record.file == *file
                    || record.identity == identity
                    || CollectionService::snapshot(record, authority)
                        .is_ok_and(|source| source.identity.pair() == identity)
            })
            .map(|record| {
                let mut binding = record.binding();
                binding.preserved_original = self.preserves_original(record.id);
                binding
            })
    }

    fn preserves_original(&self, collection: Uuid) -> bool {
        self.migrations.iter().any(|intent| {
            intent.collection.is_some()
                && intent.choice == MigrationChoice::Database
                && (intent.original_collection == Some(collection)
                    || intent.original_collection.is_none()
                        && self.records.iter().any(|record| {
                            record.id == collection && intent.source.as_ref() == Some(&record.file)
                        }))
        })
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderDownload {
    file: FileWorkspaceHandle,
    revision: String,
    leaf: String,
    identity: (u64, u64),
    account: AccountIdentity,
    since_ms: Option<i64>,
    through_ms: i64,
    #[serde(default)]
    coverage_cursor_current: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreIntent {
    migration: Uuid,
    destination: DatabaseHandle,
    identity: (u64, u64),
    completed: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreationIntent {
    id: Uuid,
    workspace: FileWorkspaceHandle,
    account: AccountIdentity,
    name: String,
    identity: Option<(u64, u64)>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MigrationChoice {
    Pgn,
    Database,
    Decline,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MigrationIntent {
    id: Uuid,
    workspace: FileWorkspaceHandle,
    database: DatabaseHandle,
    database_identity: (u64, u64),
    database_revision: u64,
    source: Option<FileWorkspaceHandle>,
    source_revision: Option<String>,
    choice: MigrationChoice,
    account: Option<AccountIdentity>,
    destination_name: String,
    archive_identity: Option<(u64, u64)>,
    #[serde(default)]
    archive_ready: bool,
    source_archive_identity: Option<(u64, u64)>,
    #[serde(default)]
    export_identity: Option<(u64, u64)>,
    destination: Option<FileWorkspaceHandle>,
    #[serde(default)]
    destination_identity: Option<(u64, u64)>,
    collection: Option<Uuid>,
    #[serde(default)]
    original_collection: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CollectionStatus {
    Ready,
    Stale,
    Missing,
    Retired,
    PreservedOriginal,
    Unavailable,
    Trashed,
}

#[derive(Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionDescriptor {
    pub id: String,
    pub name: String,
    pub file: FileWorkspaceHandle,
    pub database: Option<DatabaseHandle>,
    pub account: Option<AccountIdentity>,
    pub status: CollectionStatus,
    pub generation: String,
    pub omitted: i32,
    pub retired_database: Option<DatabaseHandle>,
    pub fetch_since_ms: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub pending_batch: Option<FileWorkspaceHandle>,
}

#[cfg(test)]
type RebuildHook = Box<dyn Fn() -> Result<(), Error> + Send>;

/// The registry is small and bounded. PGN bodies and membership projections stay on disk.
/// The registry lock serializes publication. Database write owners deduplicate rebuilds.
pub(crate) struct CollectionService {
    root: AuthorizedDir,
    workspace_mutation: Arc<Mutex<()>>,
    registry: Mutex<Result<Registry, String>>,
    repository: Arc<DatabaseRepository>,
    search_cache: Arc<SearchCache>,
    pgn_repository: PgnRepository,
    batch_locks: crate::infra::keyed_locks::KeyedLocks<Uuid, parking_lot::Mutex<()>>,
    migration_locks:
        crate::infra::keyed_locks::KeyedLocks<authority::PathRef, parking_lot::Mutex<()>>,
    maintenance_done: Mutex<bool>,
    #[cfg(test)]
    rebuild_hook: Mutex<Option<RebuildHook>>,
    #[cfg(test)]
    batch_preparation_injector:
        Mutex<Option<Arc<dyn crate::infra::fs::AtomicWriterInjector + Send + Sync>>>,
    #[cfg(test)]
    pub(crate) append_admission_hook: Mutex<Option<pgn::BoundedHook>>,
}

impl CollectionService {
    pub(crate) fn capture_binding(
        &self,
        authority: &SharedPathAuthority,
        file: &FileWorkspaceHandle,
    ) -> Result<Option<SourceBinding>, Error> {
        let selected = authority.with_mut(|authority| {
            authority
                .resolve(file.path_ref(), PathOperation::ReadPgn, &[])?
                .pgn_snapshot()
        })??;
        let registry = Self::state(&mut *self.lock(&CancellationToken::new())?)?.clone();
        let binding = registry.source_binding(authority, file, selected.identity.pair());
        if binding
            .as_ref()
            .is_some_and(|binding| registry.pending_destination(binding.collection()))
        {
            return Err(Error::StaleGame);
        }
        Ok(binding)
    }

    pub(crate) fn validate_binding(
        &self,
        authority: &SharedPathAuthority,
        file: &FileWorkspaceHandle,
        binding: &Option<SourceBinding>,
    ) -> Result<(), Error> {
        if self.capture_binding(authority, file)? != *binding {
            return Err(Error::StaleGame);
        }
        Ok(())
    }

    fn validate_captured_binding(
        &self,
        binding: &SourceBinding,
        token: &CancellationToken,
    ) -> Result<(), Error> {
        self.require_active(binding.id, token)?;
        if self.record(binding.id, token)?.binding() != *binding {
            return Err(Error::StaleGame);
        }
        Ok(())
    }

    fn require_active(&self, id: Uuid, token: &CancellationToken) -> Result<(), Error> {
        let mut guard = self.lock(token)?;
        let registry = Self::state(&mut guard)?;
        if registry.inactive_migration_index(id)
            || registry
                .records
                .iter()
                .any(|record| record.id == id && record.is_trashed())
        {
            return Err(Error::StaleGame);
        }
        Ok(())
    }

    fn inactive_status(
        &self,
        record: &Record,
        token: &CancellationToken,
    ) -> Result<Option<CollectionStatus>, Error> {
        let mut guard = self.lock(token)?;
        let registry = Self::state(&mut guard)?;
        if registry.preserves_original(record.id) {
            Ok(Some(CollectionStatus::PreservedOriginal))
        } else if registry.pending_destination(record.id)
            || !matches!(
                record.purpose,
                WorkspaceFileType::Game | WorkspaceFileType::Tournament
            )
        {
            Ok(Some(CollectionStatus::Retired))
        } else {
            Ok(None)
        }
    }

    fn retained_files(registry: &Registry) -> HashSet<String> {
        let mut retained = HashSet::new();
        for id in registry
            .records
            .iter()
            .map(|record| record.id)
            .chain(registry.creations.iter().map(|intent| intent.id))
            .chain(registry.migrations.iter().flat_map(|intent| {
                [intent.collection, intent.original_collection]
                    .into_iter()
                    .flatten()
            }))
        {
            let leaf = format!("{id}.db3");
            for suffix in ["", "-wal", "-shm", "-journal", ".ecsi", ".integrity"] {
                retained.insert(format!("{leaf}{suffix}"));
            }
            for suffix in ["", "-wal", "-shm", "-journal"] {
                retained.insert(format!("{id}-identity.db3{suffix}"));
            }
        }
        for record in &registry.records {
            if let Some(pending) = &record.pending {
                retained.insert(format!("{}-batch.pgn", pending.id));
            }
        }
        for intent in &registry.migrations {
            for suffix in [
                "-original.db3",
                "-original.db3-wal",
                "-original.db3-shm",
                "-original.db3-journal",
                "-original.pgn",
                "-export.pgn",
            ] {
                retained.insert(format!("{}{suffix}", intent.id));
            }
        }
        retained
    }

    fn remove_record_files(
        &self,
        record: &Record,
        candidate: &Registry,
        token: &CancellationToken,
    ) -> Result<(), Error> {
        let owned = Self::retained_files(&Registry {
            records: vec![record.clone()],
            ..Registry::default()
        });
        let retained = Self::retained_files(candidate);
        let primary = format!("{}.db3", record.id);
        let mut names = owned.difference(&retained).collect::<Vec<_>>();
        names.sort_by_key(|name| (*name == &primary, *name));
        for name in names {
            cancellation_check(token)?;
            let leaf = OsStr::new(name);
            let identity = match entry_identity_at(self.root.descriptor(), leaf, false) {
                Ok(identity) => identity,
                Err(error) if error.is_missing_entry() => continue,
                Err(error) => return Err(error),
            };
            remove_entry_at(self.root.descriptor(), leaf, identity, false)?;
        }
        self.root.descriptor().sync_all()?;
        Ok(())
    }

    fn remove_trashed_records(
        &self,
        authority: &SharedPathAuthority,
        workspace: &FileWorkspaceHandle,
        cancellation: &CancellationToken,
    ) -> Result<(), Error> {
        let records = Self::state(&mut *self.lock(cancellation)?)?
            .records
            .iter()
            .filter(|record| record.workspace == *workspace && record.is_trashed())
            .cloned()
            .collect::<Vec<_>>();
        for record in records {
            let absent = || {
                if relative_locator(authority, workspace, &record.file).is_ok() {
                    return Ok(false);
                }
                crate::file_workspace::workspace_locator_exists(
                    authority,
                    workspace,
                    &record.trash_locator,
                )
                .map(|exists| !exists)
            };
            let remove = || {
                let _workspace = crate::infra::cancellable_lock::lock_std_cancellable(
                    &self.workspace_mutation,
                    cancellation,
                    "workspace mutation lock was poisoned",
                )?;
                let mut guard = self.lock(cancellation)?;
                let mut candidate = Self::state(&mut guard)?.clone();
                if !candidate.records.iter().any(|current| current == &record)
                    // Migration recovery requires these record identities at registry load.
                    || candidate.migrations.iter().any(|intent| intent.collection == Some(record.id) || intent.original_collection == Some(record.id))
                    || !absent()?
                {
                    return Ok(());
                }
                candidate.records.retain(|prior| prior.id != record.id);
                self.remove_record_files(&record, &candidate, cancellation)?;
                self.save(&mut guard, candidate)
            };
            // Database retirement precedes workspace and registry ownership, as in migration.
            // Keep the primary until its companions are gone so an interrupted cleanup retries.
            let result = (|| {
                if !absent()? {
                    return Ok(());
                }
                match self.target(&record) {
                    Ok(target) => {
                        self.repository
                            .delete_exclusive_cancellable(&target, cancellation, || {
                                self.search_cache.invalidate_database(&target);
                                let result = remove();
                                self.search_cache.invalidate_database(&target);
                                result
                            })
                    }
                    Err(error) if error.is_missing_entry() => remove(),
                    Err(error) => Err(error),
                }
            })();
            if let Err(error) = result {
                if matches!(error, Error::Cancellation) {
                    return Err(error);
                }
                log::warn!(
                    "trashed collection {} cleanup will retry: {}",
                    record.id,
                    error.diagnostic()
                );
            }
        }
        Ok(())
    }

    fn maintain(&self, cancellation: &CancellationToken) -> Result<(), Error> {
        let mut done = crate::infra::cancellable_lock::lock_std_cancellable(
            &self.maintenance_done,
            cancellation,
            "collection maintenance lock was poisoned",
        )?;
        if *done {
            return Ok(());
        }
        let registry = Self::state(&mut *self.lock(cancellation)?)?.clone();
        let retained = Self::retained_files(&registry);
        let entries = read_directory_entries_at(
            self.root.descriptor(),
            cancellation,
            Some(MAX_RECORDS * 16),
            &mut |_| true,
        )?;
        for entry in entries {
            cancellation_check(cancellation)?;
            if entry.kind != DirectoryEntryKind::RegularFile {
                continue;
            }
            let Some(name) = entry.name.to_str() else {
                continue;
            };
            let owned_temporary = name
                .strip_prefix(".atomic-")
                .is_some_and(|id| Uuid::parse_str(id).is_ok());
            let owned_generation = name.get(..36).is_some_and(|id| Uuid::parse_str(id).is_ok())
                && [
                    ".db3",
                    ".db3-wal",
                    ".db3-shm",
                    ".db3-journal",
                    ".db3.ecsi",
                    ".db3.integrity",
                    "-batch.pgn",
                    "-identity.db3",
                    "-identity.db3-wal",
                    "-identity.db3-shm",
                    "-identity.db3-journal",
                ]
                .iter()
                .any(|suffix| name.get(36..) == Some(*suffix));
            if owned_temporary || owned_generation && !retained.contains(name) {
                remove_entry_at(self.root.descriptor(), &entry.name, entry.identity, false)?;
            }
        }
        let batches = self.root.ensure_child(OsStr::new("batches"))?;
        let retained_batches = registry
            .downloads
            .iter()
            .map(|receipt| receipt.leaf.as_str())
            .chain(registry.records.iter().filter_map(|record| {
                record
                    .pending
                    .as_ref()?
                    .coverage
                    .as_ref()
                    .map(|receipt| receipt.leaf.as_str())
            }))
            .collect::<HashSet<_>>();
        let entries = read_directory_entries_at(
            batches.descriptor(),
            cancellation,
            Some(MAX_RECORDS * 16),
            &mut |_| true,
        )?;
        for entry in entries {
            cancellation_check(cancellation)?;
            let Some(name) = entry.name.to_str() else {
                continue;
            };
            if entry.kind == DirectoryEntryKind::RegularFile && !retained_batches.contains(name) {
                remove_entry_at(batches.descriptor(), &entry.name, entry.identity, false)?;
            }
        }
        *done = true;
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_download(
        &self,
        authority: &SharedPathAuthority,
        file: FileWorkspaceHandle,
        provider: &str,
        account: &str,
        since_ms: Option<i64>,
        coverage_holds: Option<&[crate::lichess::CoverageHold]>,
        token: &CancellationToken,
    ) -> Result<(), Error> {
        #[cfg(test)]
        if let Some(error) = RECORD_DOWNLOAD_FAILURE.take(&(provider.into(), account.into())) {
            return Err(error);
        }
        let path = authority.with_mut(|authority| {
            authority.workspace_entry_path(&file, PathOperation::ReadPgn)
        })??;
        if path.parent() != Some(self.root.path().join("batches").as_path()) {
            return Ok(());
        }
        let account = AccountIdentity {
            provider: provider.into(),
            account: account.into(),
        }
        .validate()?;
        let snapshot = authority.with_mut(|authority| {
            authority
                .resolve(file.path_ref(), PathOperation::ReadPgn, &[])?
                .pgn_snapshot()
        })??;
        let revision = pgn::revision_string(&snapshot);
        let identity = snapshot.identity.pair();
        let leaf = path
            .file_name()
            .and_then(OsStr::to_str)
            .ok_or_else(|| {
                Error::InvalidInput("provider staging filename cannot be encoded".into())
            })?
            .to_owned();
        let mut bytes = snapshot.file.try_clone()?;
        let (_, ranges) = pgn::scan_current_blocking(snapshot, &self.pgn_repository, token)?;
        let mut newest_start_ms = None;
        let mut provider_ids = HashSet::new();
        for range in ranges.iter() {
            let (body, game) = identity_range(&mut bytes, *range, token)?;
            if let Some(id) = readable_provider_game_id(&body, &account)? {
                provider_ids.insert(id);
            }
            let Some(game) = game else { continue };
            if let Some((date, time)) = game.date.as_deref().zip(game.time.as_deref()) {
                let date = NaiveDate::parse_from_str(date, "%Y.%m.%d")
                    .map_err(|_| Error::Conflict("provider game has an invalid date".into()))?;
                let time = NaiveTime::parse_from_str(time, "%H:%M:%S")
                    .map_err(|_| Error::Conflict("provider game has an invalid time".into()))?;
                let start = date.and_time(time).and_utc().timestamp_millis();
                newest_start_ms =
                    Some(newest_start_ms.map_or(start, |prior: i64| prior.max(start)));
            } else {
                return Err(Error::Conflict(
                    "provider export has incomplete time coverage".into(),
                ));
            }
        }
        let through_ms = account_sync_cursor(
            &account.provider,
            since_ms,
            newest_start_ms,
            &provider_ids,
            coverage_holds,
        );
        let current = authority.with_mut(|authority| {
            authority
                .resolve(file.path_ref(), PathOperation::ReadPgn, &[])?
                .pgn_snapshot()
        })??;
        if pgn::revision_string(&current) != revision {
            return Err(Error::StaleGame);
        }
        let mut guard = self.lock(token)?;
        let mut registry = Self::state(&mut guard)?.clone();
        let obsolete = registry
            .downloads
            .iter()
            .find(|receipt| receipt.account == account && receipt.leaf != leaf)
            .cloned();
        registry
            .downloads
            .retain(|receipt| receipt.account != account);
        registry.downloads.push(ProviderDownload {
            file,
            revision,
            leaf,
            identity,
            account,
            since_ms,
            through_ms,
            coverage_cursor_current: true,
        });
        // Retain one completed private download per account for idempotent receipt retries.
        // Startup removes abandoned files outside these bounded receipt and pending owners.
        self.save(&mut guard, registry)?;
        drop(guard);
        if let Some(obsolete) = obsolete {
            let batches = self.root.ensure_child(OsStr::new("batches"))?;
            match remove_entry_at(
                batches.descriptor(),
                OsStr::new(&obsolete.leaf),
                obsolete.identity,
                false,
            ) {
                Ok(()) => {}
                Err(error) if error.is_missing_entry() => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
    pub(crate) fn contains_source(&self, file: &FileWorkspaceHandle) -> Result<bool, Error> {
        let mut guard = self.lock(&CancellationToken::new())?;
        let registry = Self::state(&mut guard)?;
        Ok(registry.records.iter().any(|record| {
            record.file == *file
                && !registry.preserves_original(record.id)
                && matches!(
                    record.purpose,
                    WorkspaceFileType::Game | WorkspaceFileType::Tournament
                )
        }))
    }

    pub(crate) fn guard_conversion_source(
        &self,
        authority: &SharedPathAuthority,
        file: &FileWorkspaceHandle,
        cancellation: &CancellationToken,
    ) -> Result<(), Error> {
        let snapshot = authority.with_mut(|authority| {
            authority
                .resolve(file.path_ref(), PathOperation::ReadPgn, &[])?
                .pgn_snapshot()
        })??;
        let records = Self::state(&mut *self.lock(cancellation)?)?.records.clone();
        for record in records {
            if matches!(
                record.purpose,
                WorkspaceFileType::Game | WorkspaceFileType::Tournament
            ) && (record.file == *file
                || record.identity == snapshot.identity.pair()
                || Self::snapshot(&record, authority)
                    .is_ok_and(|current| current.identity == snapshot.identity))
            {
                return Err(Error::Conflict(
                    "library collection sources cannot be imported as independent databases".into(),
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn refresh_source(
        &self,
        authority: &SharedPathAuthority,
        file: &FileWorkspaceHandle,
        cancellation: &CancellationToken,
    ) -> Result<(), Error> {
        let records = Self::state(&mut *self.lock(cancellation)?)?.records.clone();
        for record in records.iter().filter(|record| {
            record.file == *file
                && matches!(
                    record.purpose,
                    WorkspaceFileType::Game | WorkspaceFileType::Tournament
                )
        }) {
            if self.inactive_status(record, cancellation)?.is_some() {
                continue;
            }
            if let Err(error) = self.refresh(authority, record.id, cancellation) {
                log::warn!(
                    "collection {} post-publication source refresh failed: {}",
                    record.id,
                    error.diagnostic()
                );
                return Err(error);
            }
        }
        Ok(())
    }

    pub(crate) fn export_snapshot(
        &self,
        authority: &SharedPathAuthority,
        file: &DatabaseHandle,
        cancellation: &CancellationToken,
    ) -> Result<Option<authority::PgnSnapshot>, Error> {
        let record = Self::state(&mut *self.lock(cancellation)?)?
            .records
            .iter()
            .find(|record| record.database.as_ref() == Some(file))
            .cloned();
        record
            .map(|record| {
                self.refresh(authority, record.id, cancellation)?;
                Self::snapshot(&record, authority)
            })
            .transpose()
    }

    fn recover_created_file(
        &self,
        authority: &SharedPathAuthority,
        workspace_mutation: &Mutex<()>,
        workspace: &FileWorkspaceHandle,
        name: &str,
        expected: Option<(u64, u64)>,
        cancellation: &CancellationToken,
    ) -> Result<Option<FileWorkspaceHandle>, Error> {
        let file = self.recover_created_source(authority, workspace, name, expected)?;
        let Some(file) = file else {
            return Ok(None);
        };
        let _guard = crate::infra::cancellable_lock::lock_std_cancellable(
            workspace_mutation,
            cancellation,
            "workspace mutation lock was poisoned",
        )?;
        let metadata = crate::file_workspace::create_missing_workspace_file_metadata(
            authority,
            workspace,
            &file,
            crate::file_workspace::WorkspaceMetadata {
                file_type: WorkspaceFileType::Game,
                tags: vec![],
            },
            cancellation,
        )?;
        if metadata.file_type != WorkspaceFileType::Game {
            return Err(Error::Conflict(
                "migration destination purpose changed".into(),
            ));
        }
        Ok(Some(file))
    }

    fn recover_created_source(
        &self,
        authority: &SharedPathAuthority,
        workspace: &FileWorkspaceHandle,
        name: &str,
        expected: Option<(u64, u64)>,
    ) -> Result<Option<FileWorkspaceHandle>, Error> {
        let Some(expected) = expected else {
            return Ok(None);
        };
        let filename = crate::file_workspace::pgn_name(name)?;
        let target =
            authority.with_mut(|authority| authority.workspace_mutation_target(workspace))??;
        let identity = match entry_identity_at(target.directory()?, OsStr::new(&filename), false) {
            Ok(identity) => identity,
            Err(error) if error.is_missing_entry() => return Ok(None),
            Err(error) => return Err(error),
        };
        if identity != expected {
            return Err(Error::Conflict(
                "migration destination ownership cannot be confirmed".into(),
            ));
        }
        let file = authority.with_mut(|authority| {
            authority.register_workspace_child_observed_with_parent(
                workspace,
                &[filename.into()],
                name,
                authority::IdentityBinding::from_pairs(identity, target.identity),
                false,
                PathOperation::WritePgn,
            )
        })??;
        Ok(Some(file))
    }
    fn internal_file(
        &self,
        authority: &SharedPathAuthority,
        leaf: &str,
        operations: Vec<PathOperation>,
    ) -> Result<authority::PathRef, Error> {
        let identity = entry_identity_at(self.root.descriptor(), OsStr::new(leaf), false)?;
        let commit = authority.with_mut(|authority| {
            authority.get_or_create_persistent_file_verified(
                &self.root.path().join(leaf),
                leaf,
                operations,
                authority::VerifiedIdentity::from_pair(identity),
                authority::VerifiedIdentity::from_pair(authority::opened_file_identity(
                    self.root.descriptor(),
                )?),
                authority::RegistrationDoor::ExplicitReauthorization,
            )
        })??;
        authority::require_durable(commit.durability)?;
        Ok(commit.id)
    }

    fn update_intent(
        &self,
        intent: MigrationIntent,
        cancellation: &CancellationToken,
    ) -> Result<(), Error> {
        let mut guard = self.lock(cancellation)?;
        let mut candidate = Self::state(&mut guard)?.clone();
        if let Some(prior) = candidate
            .migrations
            .iter_mut()
            .find(|prior| prior.id == intent.id)
        {
            *prior = intent;
        } else {
            candidate.migrations.push(intent);
        }
        if candidate.migrations.len() > MAX_RECORDS {
            return Err(Error::ResourceLimit(
                "too many collection migrations".into(),
            ));
        }
        self.save(&mut guard, candidate)
    }

    fn export_database(
        &self,
        target: &DatabaseFileTarget,
        leaf: &str,
        cancellation: &CancellationToken,
        mut owner: impl FnMut((u64, u64)) -> Result<(), Error>,
    ) -> Result<(u64, u64), Error> {
        let mut db = self.repository.connection(target, Some(cancellation))?;
        let installed =
            atomic_create_at_identified(self.root.descriptor(), OsStr::new(leaf), |file| {
                db.transaction::<_, Error, _>(|db| {
                    let (white, black) = diesel::alias!(players as white, players as black);
                    let rows = games::table
                        .inner_join(white.on(games::white_id.eq(white.field(players::id))))
                        .inner_join(black.on(games::black_id.eq(black.field(players::id))))
                        .inner_join(events::table.on(games::event_id.eq(events::id)))
                        .inner_join(sites::table.on(games::site_id.eq(sites::id)))
                        .order(games::id.asc())
                        .load_iter::<(Game, Player, Player, Event, Site), DefaultLoadingMode>(db)?;
                    write_pgn_rows(&mut *file, rows, cancellation)
                })?;
                owner(authority::opened_file_identity(file)?)
            })?;
        require_durable(
            installed.outcome,
            crate::error::DurabilityStage::NativeExport,
        )?;
        Ok(installed.identity)
    }

    fn migrate(
        &self,
        authority: &SharedPathAuthority,
        workspace_mutation: &Mutex<()>,
        intent: MigrationIntent,
        cancellation: &CancellationToken,
    ) -> Result<CollectionDescriptor, Error> {
        if let Some(collection) = intent.collection {
            return self.describe(
                authority,
                &self.record(collection, cancellation)?,
                cancellation,
            );
        }
        if matches!(intent.choice, MigrationChoice::Decline) {
            return Err(Error::Cancellation);
        }
        let source_target = authority.with_mut(|authority| {
            authority.database_file_target(&intent.database, PathOperation::DatabaseRead)
        })??;
        self.repository
            .with_write_lock_cancellable(&source_target, cancellation, || {
                let mut rebind = intent
                    .source
                    .as_ref()
                    .map(|source| pgn::PgnCapabilityRebind::new(authority.clone(), source));
                let owner = if let (Some(rebind), Some(source)) = (&mut rebind, &intent.source) {
                    rebind.capture_binding()?;
                    let snapshot = authority.with_mut(|authority| {
                        authority
                            .resolve(source.path_ref(), PathOperation::ReadPgn, &[])?
                            .pgn_snapshot()
                    })??;
                    Some(rebind.edit_lock(&self.pgn_repository, snapshot.identity)?)
                } else {
                    None
                };
                // Migration runs on the blocking gateway. Use the same PGN owner and retain
                // cancellation while waiting, including when a source edit was already admitted.
                let _source_owner = if let Some(owner) = &owner {
                    #[cfg(test)]
                    let mut reported_wait = false;
                    Some(loop {
                        cancellation_check(cancellation)?;
                        if let Ok(guard) = owner.try_lock() {
                            break guard;
                        }
                        #[cfg(test)]
                        if !reported_wait {
                            self.pgn_repository.notify_edit_lock_wait()?;
                            reported_wait = true;
                        }
                        std::thread::sleep(MIGRATION_SOURCE_OWNER_RETRY);
                    })
                } else {
                    None
                };
                if let Some(rebind) = &rebind {
                    rebind.validate_binding()?;
                }
                self.migrate_owned(
                    authority,
                    workspace_mutation,
                    intent,
                    &source_target,
                    rebind.as_ref(),
                    cancellation,
                )
            })
    }

    fn migrate_owned(
        &self,
        authority: &SharedPathAuthority,
        workspace_mutation: &Mutex<()>,
        mut intent: MigrationIntent,
        source_target: &DatabaseFileTarget,
        source_binding: Option<&pgn::PgnCapabilityRebind>,
        cancellation: &CancellationToken,
    ) -> Result<CollectionDescriptor, Error> {
        #[cfg(test)]
        database_command_checkpoint("migration_snapshot", &intent.database);
        self.guard_database_target(
            &intent.database,
            PathOperation::DatabaseMutate,
            source_target.identity(),
        )?;
        if let Some(source) = &intent.source {
            let selected = authority.with_mut(|authority| {
                authority
                    .resolve(source.path_ref(), PathOperation::ReadPgn, &[])?
                    .pgn_snapshot()
            })??;
            let registry = Self::state(&mut *self.lock(cancellation)?)?.clone();
            let original_id = registry
                .source_binding(authority, source, selected.identity.pair())
                .map(|binding| binding.collection());
            let records = &registry.records;
            for record in records
                .iter()
                .filter(|record| Some(record.id) == original_id)
            {
                self.require_active(record.id, cancellation)?;
            }
            if intent.choice == MigrationChoice::Database
                && records.iter().any(|record| {
                    Some(record.id) == original_id
                        && (record.account.is_some() || record.pending.is_some())
                })
            {
                return Err(Error::Conflict("the selected original has an account association or unfinished batch that must be reconciled first".into()));
            }
            if records.iter().any(|record| {
                record.retired_database.is_some()
                    && (record.file == *source
                        || record.identity == selected.identity.pair()
                        || Self::snapshot(record, authority)
                            .is_ok_and(|current| current.identity == selected.identity))
            }) {
                return Err(Error::Conflict(
                    "selected source already has a completed database migration".into(),
                ));
            }
        }
        // A standalone writer that acquired the owner first belongs to the initial snapshot.
        if intent.archive_identity.is_none() {
            intent.database_revision = self
                .repository
                .database_identity(source_target)?
                .data_revision;
            self.update_intent(intent.clone(), cancellation)?;
        }
        if source_target.identity() != intent.database_identity
            || self
                .repository
                .database_identity(source_target)?
                .data_revision
                != intent.database_revision
        {
            return Err(Error::StaleGame);
        }
        if let Some(file) = &intent.source {
            let revision = authority.with_mut(|authority| {
                authority
                    .resolve(file.path_ref(), PathOperation::ReadPgn, &[])?
                    .pgn_snapshot()
                    .map(|snapshot| pgn::revision_string(&snapshot))
            })??;
            if intent.source_revision.as_ref() != Some(&revision) {
                return Err(Error::StaleGame);
            }
        }
        let archive_leaf = format!("{}-original.db3", intent.id);
        if entry_identity_at(self.root.descriptor(), OsStr::new(&archive_leaf), false)
            .is_err_and(|error| error.is_missing_entry())
        {
            let installed = atomic_create_at_identified(
                self.root.descriptor(),
                OsStr::new(&archive_leaf),
                |file| {
                    intent.archive_identity = Some(authority::opened_file_identity(file)?);
                    self.update_intent(intent.clone(), cancellation)
                },
            )?;
            require_durable(
                installed.outcome,
                crate::error::DurabilityStage::NativeExport,
            )?;
        }
        let archive = self.root.database_target(OsStr::new(&archive_leaf))?;
        if Some(archive.identity()) != intent.archive_identity {
            return Err(Error::Conflict(
                "migration archive ownership changed".into(),
            ));
        }
        // Copy through SQLite's online backup API. A raw copy of the database leaf would lose WAL.
        if !intent.archive_ready {
            snapshot_database(source_target, &archive, cancellation)?;
        }
        migrations::validate_content(
            &mut *self.repository.connection(&archive, Some(cancellation))?,
        )?;
        let archive_revision = self.repository.database_identity(&archive)?.data_revision;
        if archive_revision != intent.database_revision {
            return Err(Error::StaleGame);
        }
        if !intent.archive_ready {
            intent.archive_ready = true;
            self.update_intent(intent.clone(), cancellation)?;
        }
        if matches!(intent.choice, MigrationChoice::Database) {
            if let Some(source) = &intent.source {
                let source_archive = format!("{}-original.pgn", intent.id);
                if entry_identity_at(self.root.descriptor(), OsStr::new(&source_archive), false)
                    .is_err_and(|error| error.is_missing_entry())
                {
                    let snapshot = authority.with_mut(|authority| {
                        authority
                            .resolve(source.path_ref(), PathOperation::ReadPgn, &[])?
                            .pgn_snapshot()
                    })??;
                    let mut source = snapshot.file;
                    let size = source.metadata()?.len();
                    let installed = atomic_create_at_identified(
                        self.root.descriptor(),
                        OsStr::new(&source_archive),
                        |file| {
                            pgn::copy_range(&mut source, file, 0, size, cancellation)?;
                            intent.source_archive_identity =
                                Some(authority::opened_file_identity(file)?);
                            self.update_intent(intent.clone(), cancellation)
                        },
                    )?;
                    require_durable(
                        installed.outcome,
                        crate::error::DurabilityStage::NativeExport,
                    )?;
                    intent.source_archive_identity = Some(installed.identity);
                    self.update_intent(intent.clone(), cancellation)?;
                }
                if Some(entry_identity_at(
                    self.root.descriptor(),
                    OsStr::new(&source_archive),
                    false,
                )?) != intent.source_archive_identity
                {
                    return Err(Error::Conflict(
                        "migration source archive ownership changed".into(),
                    ));
                }
            }
            if intent.destination.is_none() {
                intent.destination = self.recover_created_file(
                    authority,
                    workspace_mutation,
                    &intent.workspace,
                    &intent.destination_name,
                    intent.destination_identity,
                    cancellation,
                )?;
            }
            if intent.destination.is_none() {
                let export_leaf = format!("{}-export.pgn", intent.id);
                if entry_identity_at(self.root.descriptor(), OsStr::new(&export_leaf), false)
                    .is_err_and(|error| error.is_missing_entry())
                {
                    self.export_database(&archive, &export_leaf, cancellation, |identity| {
                        intent.export_identity = Some(identity);
                        self.update_intent(intent.clone(), cancellation)
                    })?;
                }
                if Some(entry_identity_at(
                    self.root.descriptor(),
                    OsStr::new(&export_leaf),
                    false,
                )?) != intent.export_identity
                {
                    return Err(Error::Conflict("migration export ownership changed".into()));
                }
                let handle = FileWorkspaceHandle::new(self.internal_file(
                    authority,
                    &export_leaf,
                    vec![PathOperation::ReadPgn],
                )?);
                let revision = authority.with_mut(|authority| {
                    authority
                        .resolve(handle.path_ref(), PathOperation::ReadPgn, &[])?
                        .pgn_snapshot()
                        .map(|snapshot| pgn::revision_string(&snapshot))
                })??;
                let mut owned_intent = intent.clone();
                let mut owner = |identity| {
                    owned_intent.destination_identity = Some(identity);
                    self.update_intent(owned_intent.clone(), cancellation)
                };
                let entry = crate::file_workspace::create_owned_workspace_file_blocking(
                    intent.workspace.clone(),
                    intent.workspace.clone(),
                    intent.destination_name.clone(),
                    crate::file_workspace::WorkspaceMetadata {
                        file_type: WorkspaceFileType::Game,
                        tags: vec![],
                    },
                    crate::file_workspace::WorkspaceFileContent::Copy {
                        source: handle,
                        revision,
                    },
                    authority,
                    workspace_mutation,
                    &self.pgn_repository,
                    cancellation,
                    Some(&mut owner),
                )?;
                intent.destination_identity = owned_intent.destination_identity;
                intent.destination = Some(entry.handle);
                self.update_intent(intent.clone(), cancellation)?;
            }
        } else {
            intent.destination = intent.source.clone();
        }
        cancellation_check(cancellation)?;
        if self
            .repository
            .database_identity(source_target)?
            .data_revision
            != intent.database_revision
        {
            return Err(Error::StaleGame);
        }
        if let Some(source) = &intent.source {
            let current = authority.with_mut(|authority| {
                authority
                    .resolve(source.path_ref(), PathOperation::ReadPgn, &[])?
                    .pgn_snapshot()
            })??;
            if intent.source_revision.as_ref() != Some(&pgn::revision_string(&current)) {
                return Err(Error::StaleGame);
            }
        }
        let file = intent
            .destination
            .clone()
            .ok_or_else(|| Error::InvalidInput("migration requires a selected PGN".into()))?;
        let (listing, _) = crate::file_workspace::collect_tree_entries(
            authority,
            &intent.workspace,
            cancellation,
        )?;
        let mut metadata = selected_metadata(&listing.entries, &file).ok_or(Error::StaleGame)?;
        if !matches!(
            metadata.file_type,
            WorkspaceFileType::Game | WorkspaceFileType::Tournament
        ) {
            metadata.file_type = WorkspaceFileType::Game;
            crate::file_workspace::write_workspace_file_metadata_blocking(
                intent.workspace.clone(),
                file.clone(),
                metadata,
                authority,
                workspace_mutation,
                cancellation,
            )?;
        }
        let snapshot = authority.with_mut(|authority| {
            authority
                .resolve(file.path_ref(), PathOperation::ReadPgn, &[])?
                .pgn_snapshot()
        })??;
        let locator = relative_locator(authority, &intent.workspace, &file)?;
        if let Some(binding) = source_binding {
            binding.validate_binding()?;
        }
        let mut guard = self.lock(cancellation)?;
        let mut registry = Self::state(&mut guard)?.clone();
        if let (Some(binding), Some(source)) = (source_binding, &intent.source) {
            let current = authority.with_mut(|authority| {
                authority
                    .resolve(source.path_ref(), PathOperation::ReadPgn, &[])?
                    .pgn_snapshot()
            })??;
            if registry.source_binding(authority, source, current.identity.pair())
                != *binding.captured_binding()?
                || intent.source_revision.as_ref() != Some(&pgn::revision_string(&current))
            {
                return Err(Error::StaleGame);
            }
        }
        let collection = registry
            .records
            .iter()
            .find(|record| record.workspace == intent.workspace && record.file == file)
            .map(|record| record.id)
            .unwrap_or_else(Uuid::new_v4);
        if registry.records.iter().any(|record| {
            record.id == collection
                && (record.retired_database.is_some()
                    || record.pending.is_some()
                    || record.account.is_some() && record.account != intent.account)
        }) {
            return Err(Error::Conflict("the selected collection has an account association or unfinished batch that must be reconciled first".into()));
        }
        if registry.records.iter().any(|record| {
            record.account.is_some() && record.account == intent.account && record.id != collection
        }) {
            return Err(Error::Conflict(
                "account already has a linked collection".into(),
            ));
        }
        let mut record = Record {
            id: collection,
            workspace: intent.workspace.clone(),
            locator,
            trash_locator: vec![],
            file,
            identity: snapshot.identity.pair(),
            source_epoch: registry
                .records
                .iter()
                .find(|prior| prior.id == collection)
                .map_or(0, |prior| prior.source_epoch),
            purpose: WorkspaceFileType::Game,
            account: intent.account.clone(),
            database: None,
            retired_database: Some(intent.database.clone()),
            pending: None,
            coverage_cursor_ms: registry
                .records
                .iter()
                .find(|prior| prior.id == collection)
                .and_then(|prior| prior.coverage_cursor_ms),
            coverage_cursor_current: registry
                .records
                .iter()
                .find(|prior| prior.id == collection)
                .is_some_and(|prior| prior.coverage_cursor_current),
        };
        self.ensure_cache(authority, &mut record)?;
        if intent.choice == MigrationChoice::Database {
            if let Some(source) = &intent.source {
                let original_metadata =
                    selected_metadata(&listing.entries, source).ok_or(Error::StaleGame)?;
                let original_snapshot = authority.with_mut(|authority| {
                    authority
                        .resolve(source.path_ref(), PathOperation::ReadPgn, &[])?
                        .pgn_snapshot()
                })??;
                let original_locator = relative_locator(authority, &intent.workspace, source)?;
                let original_id = registry
                    .source_binding(authority, source, original_snapshot.identity.pair())
                    .map(|binding| binding.collection());
                let position = registry.records.iter().position(|prior| {
                    Some(prior.id) == original_id && prior.workspace == intent.workspace
                });
                if let Some(position) = position {
                    let prior = &registry.records[position];
                    if prior.account.is_some()
                        || prior.pending.is_some()
                        || prior.retired_database.is_some()
                        || registry.preserves_original(prior.id)
                    {
                        return Err(Error::Conflict("the selected original has existing collection ownership that must be reconciled first".into()));
                    }
                    intent.original_collection = Some(prior.id);
                } else {
                    let id = Uuid::new_v4();
                    registry.records.push(Record {
                        id,
                        workspace: intent.workspace.clone(),
                        locator: original_locator,
                        trash_locator: vec![],
                        file: source.clone(),
                        identity: original_snapshot.identity.pair(),
                        source_epoch: 0,
                        purpose: original_metadata.file_type,
                        account: None,
                        database: None,
                        retired_database: None,
                        pending: None,
                        coverage_cursor_ms: None,
                        coverage_cursor_current: false,
                    });
                    intent.original_collection = Some(id);
                }
            }
        }
        registry.records.retain(|prior| prior.id != collection);
        registry.records.push(record.clone());
        intent.collection = Some(collection);
        if let Some(prior) = registry
            .migrations
            .iter_mut()
            .find(|prior| prior.id == intent.id)
        {
            *prior = intent;
        }
        self.save(&mut guard, registry)?;
        drop(guard);
        self.describe(authority, &record, cancellation)
    }
    pub(crate) fn open(
        root: AuthorizedDir,
        workspace_mutation: Arc<Mutex<()>>,
        repository: Arc<DatabaseRepository>,
        search_cache: Arc<SearchCache>,
        pgn_repository: PgnRepository,
    ) -> Self {
        let registry = Self::load(&root).map_err(|error| {
            log::warn!("collection registry unavailable: {}", error.diagnostic());
            "collection registry is unavailable and has not been overwritten".to_owned()
        });
        Self {
            root,
            workspace_mutation,
            registry: Mutex::new(registry),
            repository,
            search_cache,
            pgn_repository,
            batch_locks: Default::default(),
            migration_locks: Default::default(),
            maintenance_done: Mutex::new(false),
            #[cfg(test)]
            rebuild_hook: Mutex::new(None),
            #[cfg(test)]
            batch_preparation_injector: Mutex::new(None),
            #[cfg(test)]
            append_admission_hook: Mutex::new(None),
        }
    }

    fn load(root: &AuthorizedDir) -> Result<Registry, Error> {
        let mut file = match open_regular_at(
            root.descriptor(),
            OsStr::new(REGISTRY),
            RegularFileAccess::ReadOnly,
        ) {
            Ok(file) => file,
            Err(error) if error.is_missing_entry() => {
                return Ok(Registry {
                    version: 1,
                    ..Registry::default()
                })
            }
            Err(error) => return Err(error),
        };
        let length = file.metadata()?.len();
        let bytes = read_bounded_bytes(
            &mut file,
            length,
            MAX_REGISTRY_BYTES,
            "collection registry exceeds its size limit",
            || Ok(()),
        )?;
        let registry: Registry = serde_json::from_slice(&bytes)
            .map_err(|_| Error::InvalidInput("invalid collection registry".into()))?;
        if registry.version != 1
            || registry.records.len() > MAX_RECORDS
            || registry.migrations.len() > MAX_RECORDS
            || registry.creations.len() > MAX_RECORDS
            || registry.restores.len() > MAX_RECORDS
            || registry.downloads.len() > MAX_RECORDS
        {
            return Err(Error::InvalidInput(
                "unsupported collection registry".into(),
            ));
        }
        let mut ids = HashSet::new();
        let mut accounts = HashSet::new();
        let mut sources = HashSet::new();
        let mut locators = HashSet::new();
        let mut caches = HashSet::new();
        for record in &registry.records {
            if !ids.insert(record.id)
                || !sources.insert(record.file.path_ref().id.clone())
                || !record.is_trashed()
                    && !locators.insert((
                        record.workspace.path_ref().id.clone(),
                        record.locator.clone(),
                    ))
                || record.locator.is_empty()
                || record.locator.iter().any(|part| single_leaf(part).is_err())
                || record.is_trashed()
                    && (!crate::file_workspace::is_trash_locator(&record.trash_locator)
                        || record
                            .trash_locator
                            .iter()
                            .any(|part| single_leaf(part).is_err()))
                || record
                    .database
                    .as_ref()
                    .is_some_and(|file| !caches.insert(file.path_ref().id.clone()))
            {
                return Err(Error::InvalidInput(
                    "invalid collection registry identity".into(),
                ));
            }
            if let Some(account) = &record.account {
                if account.clone().validate()? != *account
                    || !accounts.insert((account.provider.clone(), account.account.clone()))
                {
                    return Err(Error::InvalidInput(
                        "invalid collection account association".into(),
                    ));
                }
            }
        }
        let mut migrations = HashSet::new();
        for intent in &registry.migrations {
            if !migrations.insert(intent.id)
                || intent.account.as_ref().is_some_and(|account| {
                    !account
                        .clone()
                        .validate()
                        .is_ok_and(|validated| validated == *account)
                })
                || intent.collection.is_some_and(|id| !ids.contains(&id))
                || intent
                    .original_collection
                    .is_some_and(|id| !ids.contains(&id) || intent.collection == Some(id))
            {
                return Err(Error::InvalidInput(
                    "invalid collection migration record".into(),
                ));
            }
            if intent.choice == MigrationChoice::Database {
                crate::file_workspace::pgn_name(&intent.destination_name)?;
            }
        }
        let mut download_accounts = HashSet::new();
        for receipt in &registry.downloads {
            if receipt.account.clone().validate()? != receipt.account
                || single_leaf(OsStr::new(&receipt.leaf)).is_err()
                || !download_accounts.insert(receipt.account.clone())
            {
                return Err(Error::InvalidInput(
                    "invalid provider staging record".into(),
                ));
            }
        }
        Ok(registry)
    }

    fn lock(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<std::sync::MutexGuard<'_, Result<Registry, String>>, Error> {
        crate::infra::cancellable_lock::lock_std_cancellable(
            &self.registry,
            cancellation,
            "collection registry lock was poisoned",
        )
    }

    fn state(guard: &mut Result<Registry, String>) -> Result<&mut Registry, Error> {
        guard
            .as_mut()
            .map_err(|message| Error::Conflict(message.clone()))
    }

    fn save(&self, guard: &mut Result<Registry, String>, candidate: Registry) -> Result<(), Error> {
        if candidate.records.len() > MAX_RECORDS
            || candidate.migrations.len() > MAX_RECORDS
            || candidate.creations.len() > MAX_RECORDS
            || candidate.restores.len() > MAX_RECORDS
            || candidate.downloads.len() > MAX_RECORDS
        {
            return Err(Error::ResourceLimit(
                "too many linked collection records".into(),
            ));
        }
        let bytes = serde_json::to_vec(&candidate)
            .map_err(|_| Error::InvalidInput("collection registry cannot be encoded".into()))?;
        if bytes.len() > MAX_REGISTRY_BYTES {
            return Err(Error::ResourceLimit(
                "collection registry exceeds its size limit".into(),
            ));
        }
        let outcome = atomic_replace_at(self.root.descriptor(), OsStr::new(REGISTRY), |file| {
            file.write_all(&bytes)?;
            Ok(())
        })?;
        *guard = Ok(candidate);
        require_durable(outcome, crate::error::DurabilityStage::RegistryReplacement)
    }

    fn snapshot(
        record: &Record,
        authority: &SharedPathAuthority,
    ) -> Result<authority::PgnSnapshot, Error> {
        if record.is_trashed() {
            return Err(Error::StaleGame);
        }
        if relative_locator(authority, &record.workspace, &record.file)? != record.locator {
            return Err(Error::StaleGame);
        }
        authority.with_mut(|authority| {
            authority
                .resolve(record.file.path_ref(), PathOperation::ReadPgn, &[])?
                .pgn_snapshot()
        })?
    }

    fn target(&self, record: &Record) -> Result<DatabaseFileTarget, Error> {
        self.root
            .database_target(OsStr::new(&format!("{}.db3", record.id)))
    }

    fn ensure_cache(
        &self,
        authority: &SharedPathAuthority,
        record: &mut Record,
    ) -> Result<(), Error> {
        let leaf = format!("{}.db3", record.id);
        if self.target(record).is_err() {
            let (file, _) = create_regular_at(self.root.descriptor(), OsStr::new(&leaf))?;
            file.sync_all()?;
            self.root.descriptor().sync_all()?;
        }
        let database = authority.with_mut(|authority| {
            authority.acquire_collection_cache(
                &self.root,
                record.id,
                record.database.as_ref(),
                record
                    .locator
                    .last()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            )
        })??;
        record.database = Some(database);
        Ok(())
    }

    pub(crate) fn ensure_database(
        &self,
        authority: &SharedPathAuthority,
        file: &DatabaseHandle,
    ) -> Result<(), Error> {
        let token = CancellationToken::new();
        let record = Self::state(&mut *self.lock(&token)?)?
            .records
            .iter()
            .find(|record| record.database.as_ref() == Some(file))
            .cloned();
        if let Some(mut record) = record {
            self.require_active(record.id, &token)?;
            if self.target(&record).is_err() {
                self.ensure_cache(authority, &mut record)?;
            }
        }
        Ok(())
    }

    /// Reconcile current workspace metadata through the verified walk under the publication owner.
    /// Locator equality permits replacement. App-renamed handles retain their collection UUID.
    pub(crate) fn reconcile(
        &self,
        authority: &SharedPathAuthority,
        workspace: &FileWorkspaceHandle,
        cancellation: &CancellationToken,
    ) -> Result<Vec<CollectionDescriptor>, Error> {
        self.discover(authority, workspace, cancellation)
            .map(|(_, _, collections)| collections)
    }

    pub(crate) fn discover(
        &self,
        authority: &SharedPathAuthority,
        workspace: &FileWorkspaceHandle,
        cancellation: &CancellationToken,
    ) -> Result<
        (
            WorkspaceListing,
            Vec<FileWorkspaceHandle>,
            Vec<CollectionDescriptor>,
        ),
        Error,
    > {
        self.maintain(cancellation)?;
        let workspace_guard = crate::infra::cancellable_lock::lock_std_cancellable(
            &self.workspace_mutation,
            cancellation,
            "workspace mutation lock was poisoned",
        )?;
        let (mut listing, missing) =
            crate::file_workspace::collect_tree_entries(authority, workspace, cancellation)?;
        self.reconcile_owned(authority, workspace, &mut listing, cancellation)?;
        // Migration takes its database owner before workspace publication. Index refresh must
        // therefore run after releasing workspace ownership, as well as the registry owner.
        drop(workspace_guard);
        self.remove_trashed_records(authority, workspace, cancellation)?;
        let records = Self::state(&mut *self.lock(cancellation)?)?
            .records
            .iter()
            .filter(|record| record.workspace == *workspace)
            .cloned()
            .collect::<Vec<_>>();
        let collections = records
            .iter()
            .map(|record| self.describe(authority, record, cancellation))
            .collect::<Result<_, _>>()?;
        Ok((listing, missing, collections))
    }

    fn reconcile_owned(
        &self,
        authority: &SharedPathAuthority,
        workspace: &FileWorkspaceHandle,
        listing: &mut WorkspaceListing,
        cancellation: &CancellationToken,
    ) -> Result<(), Error> {
        if !supported() {
            return Ok(());
        }
        let mut entries = vec![];
        visit_file_entries(&listing.entries, &mut |entry| entries.push(entry.clone()));
        let mut guard = self.lock(cancellation)?;
        let mut registry = Self::state(&mut guard)?.clone();
        for record in registry
            .records
            .iter_mut()
            .filter(|record| record.workspace == *workspace)
        {
            if let Ok(locator) = relative_locator(authority, workspace, &record.file) {
                record.trash_locator = if crate::file_workspace::is_trash_locator(&locator) {
                    locator
                } else {
                    vec![]
                };
            }
        }
        if *Self::state(&mut guard)? != registry {
            self.save(&mut guard, registry.clone())?;
        }
        for entry in entries {
            cancellation_check(cancellation)?;
            let Some(mut metadata) = entry.metadata else {
                continue;
            };
            let locator = relative_locator(authority, workspace, &entry.handle)?;
            // Only the exact pending owner can complete a missing sidecar. Qualify against
            // its intended Game purpose before inspecting the actual sidecar independently.
            if registry.creations.iter().any(|creation| {
                creation.workspace == *workspace
                    && crate::file_workspace::pgn_name(&creation.name)
                        .is_ok_and(|name| locator == [OsString::from(name)])
            }) {
                registry.creation_for_source(
                    authority,
                    workspace,
                    &entry.handle,
                    &locator,
                    &WorkspaceFileType::Game,
                )?;
                metadata = crate::file_workspace::create_missing_workspace_file_metadata(
                    authority,
                    workspace,
                    &entry.handle,
                    crate::file_workspace::WorkspaceMetadata {
                        file_type: WorkspaceFileType::Game,
                        tags: vec![],
                    },
                    cancellation,
                )?;
            }
            if let Some(current) =
                crate::file_workspace::workspace_entry_mut(&mut listing.entries, &entry.handle)
            {
                current.metadata = Some(metadata.clone());
            }
            let creation = registry.creation_for_source(
                authority,
                workspace,
                &entry.handle,
                &locator,
                &metadata.file_type,
            )?;
            let is_collection = matches!(
                metadata.file_type,
                WorkspaceFileType::Game | WorkspaceFileType::Tournament
            );
            if registry
                .records
                .iter()
                .any(|record| record.workspace != *workspace && record.file == entry.handle)
            {
                return Err(Error::Conflict(
                    "source already belongs to a different library workspace".into(),
                ));
            }
            let position = registry
                .records
                .iter()
                .position(|record| record.workspace == *workspace && record.file == entry.handle)
                .or_else(|| {
                    registry.records.iter().position(|record| {
                        record.workspace == *workspace
                            && !record.is_trashed()
                            && record.locator == locator
                    })
                });
            let preserved_intent = registry.migrations.iter().position(|intent| {
                intent.collection.is_some()
                    && intent.choice == MigrationChoice::Database
                    && (intent.source.as_ref() == Some(&entry.handle)
                        || position.is_some_and(|position| {
                            intent.original_collection == Some(registry.records[position].id)
                                || intent.original_collection.is_none()
                                    && intent.source.as_ref()
                                        == Some(&registry.records[position].file)
                        }))
            });
            let Some(position) = position.or_else(|| {
                if !is_collection && preserved_intent.is_none() {
                    return None;
                }
                registry.records.push(Record {
                    id: creation
                        .as_ref()
                        .map_or_else(Uuid::new_v4, |intent| intent.id),
                    workspace: workspace.clone(),
                    locator: locator.clone(),
                    trash_locator: vec![],
                    file: entry.handle.clone(),
                    identity: (0, 0),
                    source_epoch: 0,
                    purpose: metadata.file_type.clone(),
                    account: creation.as_ref().map(|intent| intent.account.clone()),
                    database: None,
                    retired_database: None,
                    pending: None,
                    coverage_cursor_ms: None,
                    coverage_cursor_current: false,
                });
                Some(registry.records.len() - 1)
            }) else {
                continue;
            };
            if let Some(intent) = preserved_intent {
                registry.migrations[intent].original_collection =
                    Some(registry.records[position].id);
            }
            let record = &mut registry.records[position];
            record.locator = locator;
            record.trash_locator.clear();
            record.file = entry.handle;
            record.purpose = metadata.file_type;
            record.identity = Self::snapshot(record, authority)?.identity.pair();
            if is_collection && !registry.inactive_migration_index(registry.records[position].id) {
                self.ensure_cache(authority, &mut registry.records[position])?;
            }
            if let Some(creation) = creation {
                registry.creations.retain(|intent| intent.id != creation.id);
            }
        }
        if *Self::state(&mut guard)? != registry {
            self.save(&mut guard, registry)?;
        }
        Ok(())
    }

    fn descriptor(record: &Record) -> CollectionDescriptor {
        CollectionDescriptor {
            id: record.id.to_string(),
            name: record
                .locator
                .last()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            file: record.file.clone(),
            database: record.database.clone(),
            account: record.account.clone(),
            status: CollectionStatus::Stale,
            generation: String::new(),
            omitted: 0,
            retired_database: record.retired_database.clone(),
            fetch_since_ms: record
                .coverage_cursor_ms
                .filter(|_| {
                    record.coverage_cursor_current
                        || record
                            .account
                            .as_ref()
                            .is_none_or(|account| account.provider != "lichess")
                })
                .map(|value| value.to_string()),
            pending_batch: record
                .pending
                .as_ref()
                .filter(|pending| !pending.completed)
                .and_then(|pending| pending.owned_source.clone()),
        }
    }

    pub(crate) fn metadata_for_database(
        &self,
        authority: &SharedPathAuthority,
        file: &DatabaseHandle,
        cancellation: &CancellationToken,
    ) -> Result<Option<CollectionDescriptor>, Error> {
        let record = Self::state(&mut *self.lock(cancellation)?)?
            .records
            .iter()
            .find(|record| {
                record.database.as_ref() == Some(file)
                    || record.retired_database.as_ref() == Some(file)
            })
            .cloned();
        let Some(record) = record else {
            return Ok(None);
        };
        if record.source_is_trashed(authority) {
            let mut descriptor = Self::descriptor(&record);
            descriptor.status = CollectionStatus::Trashed;
            return Ok(Some(descriptor));
        }
        if let Some(status) = self.inactive_status(&record, cancellation)? {
            let mut descriptor = Self::descriptor(&record);
            descriptor.status = status;
            descriptor.database = None;
            return Ok(Some(descriptor));
        }
        let mut descriptor = Self::descriptor(&record);
        let check = (|| {
            let current = self.current_record(authority, record.id, cancellation)?;
            descriptor.file = current.file.clone();
            descriptor.generation = pgn::revision_string(&Self::snapshot(&current, authority)?);
            let mut db = self
                .repository
                .initialization_connection(&self.target(&current)?, Some(cancellation))?;
            let metadata = if has_info_table(&mut db)? {
                linked_metadata(&mut db)?
            } else {
                None
            };
            if let Some((generation, omitted)) = metadata {
                descriptor.omitted = omitted;
                if generation == descriptor.generation {
                    descriptor.status = CollectionStatus::Ready;
                }
            }
            Ok::<_, Error>(())
        })();
        match check {
            Ok(()) => {}
            Err(Error::Cancellation) => return Err(Error::Cancellation),
            Err(_) => descriptor.status = CollectionStatus::Unavailable,
        }
        if let Some(status) = self.inactive_status(&record, cancellation)? {
            descriptor.status = status;
            descriptor.database = None;
        }
        Ok(Some(descriptor))
    }

    fn describe(
        &self,
        authority: &SharedPathAuthority,
        record: &Record,
        cancellation: &CancellationToken,
    ) -> Result<CollectionDescriptor, Error> {
        let mut descriptor = Self::descriptor(record);
        if record.source_is_trashed(authority) {
            descriptor.status = CollectionStatus::Trashed;
            return Ok(descriptor);
        }
        if let Some(status) = self.inactive_status(record, cancellation)? {
            descriptor.status = status;
            descriptor.database = None;
            return Ok(descriptor);
        }
        match self.refresh(authority, record.id, cancellation) {
            Ok((generation, omitted)) => {
                descriptor.generation = generation;
                descriptor.omitted = omitted;
                descriptor.status = CollectionStatus::Ready;
            }
            Err(Error::Cancellation) => return Err(Error::Cancellation),
            Err(error) => {
                log::warn!(
                    "collection {} refresh failed: {}",
                    record.id,
                    error.diagnostic()
                );
                descriptor.status = if error.is_missing_entry() {
                    CollectionStatus::Missing
                } else {
                    CollectionStatus::Unavailable
                };
            }
        }
        match self.pending_source(authority, record.id, cancellation) {
            Ok(source) => descriptor.pending_batch = source,
            Err(Error::Cancellation) => return Err(Error::Cancellation),
            Err(error) => {
                log::warn!(
                    "collection append recovery is unavailable: {}",
                    error.diagnostic()
                );
                descriptor.status = CollectionStatus::Unavailable;
            }
        }
        if let Some(status) = self.inactive_status(record, cancellation)? {
            descriptor.status = status;
            descriptor.database = None;
        }
        Ok(descriptor)
    }

    fn record(&self, id: Uuid, cancellation: &CancellationToken) -> Result<Record, Error> {
        Self::state(&mut *self.lock(cancellation)?)?
            .records
            .iter()
            .find(|record| record.id == id)
            .cloned()
            .ok_or_else(|| Error::InvalidInput("unknown linked collection".into()))
    }

    fn current_record(
        &self,
        authority: &SharedPathAuthority,
        id: Uuid,
        cancellation: &CancellationToken,
    ) -> Result<Record, Error> {
        self.require_active(id, cancellation)?;
        self.maintain(cancellation)?;
        let mut guard = self.lock(cancellation)?;
        let mut record = Self::state(&mut guard)?
            .records
            .iter()
            .find(|record| record.id == id)
            .cloned()
            .ok_or_else(|| Error::InvalidInput("unknown linked collection".into()))?;
        drop(guard);
        if record.source_is_trashed(authority) {
            return Err(Error::StaleGame);
        }
        if Self::snapshot(&record, authority).is_err() {
            let captured = record.binding();
            let (listing, _) = crate::file_workspace::collect_tree_entries(
                authority,
                &record.workspace,
                cancellation,
            )?;
            let mut candidates = vec![];
            visit_file_entries(&listing.entries, &mut |entry| {
                candidates.push(entry.handle.clone());
            });
            let matches = candidates
                .into_iter()
                .filter_map(|file| {
                    let relative = relative_locator(authority, &record.workspace, &file);
                    match relative {
                        Ok(locator) if locator == record.locator => Some(file),
                        _ => None,
                    }
                })
                .collect::<Vec<_>>();
            if matches.len() != 1 {
                return Err(Error::StaleGame);
            }
            record.file = matches[0].clone();
            record.identity = Self::snapshot(&record, authority)?.identity.pair();
            let mut guard = self.lock(cancellation)?;
            let mut registry = Self::state(&mut guard)?.clone();
            let target_record = registry
                .records
                .iter_mut()
                .find(|prior| prior.id == id)
                .ok_or(Error::StaleGame)?;
            if target_record.binding() != captured {
                return Err(Error::StaleGame);
            }
            target_record.file = record.file;
            target_record.identity = record.identity;
            record = target_record.clone();
            self.save(&mut guard, registry)?;
        }
        if self.target(&record).is_err() || record.database.is_none() {
            self.ensure_cache(authority, &mut record)?;
            let mut guard = self.lock(cancellation)?;
            let mut registry = Self::state(&mut guard)?.clone();
            let prior = registry
                .records
                .iter_mut()
                .find(|prior| prior.id == id)
                .ok_or(Error::StaleGame)?;
            if prior.binding() != record.binding() {
                return Err(Error::StaleGame);
            }
            prior.database = record.database.clone();
            record = prior.clone();
            self.save(&mut guard, registry)?;
        }
        Ok(record)
    }

    /// A single transaction publishes rows, byte locators, digest and DataRevision.
    /// Provider membership is reconciled separately by batch and legacy identity processing.
    /// Failed builds leave the previous generation unavailable through the authority facade.
    fn refresh(
        &self,
        authority: &SharedPathAuthority,
        id: Uuid,
        cancellation: &CancellationToken,
    ) -> Result<(String, i32), Error> {
        let record = self.current_record(authority, id, cancellation)?;
        if !matches!(
            record.purpose,
            WorkspaceFileType::Game | WorkspaceFileType::Tournament
        ) {
            return Err(Error::Conflict("collection index is retired".into()));
        }
        let target = self.target(&record)?;
        self.repository.with_write_lock_cancellable(&target, cancellation, || {
            let mut db = self.repository.initialization_connection(&target, Some(cancellation))?;
            for attempt in 0..SOURCE_REBUILD_ATTEMPTS {
                let snapshot = Self::snapshot(&record, authority)?;
                let generation = pgn::revision_string(&snapshot);
                let prior = if has_info_table(&mut db)? { linked_metadata(&mut db)? } else { None };
                if let Some((revision, omitted)) = prior { if revision == generation { return Ok((generation, omitted)); } }
                let mut source = snapshot.file.try_clone()?;
                let (_, ranges) = pgn::scan_current_blocking(snapshot, &self.pgn_repository, cancellation)?;
                let result = db.transaction::<_, Error, _>(|db| {
                    migrations::prepare_database_with_validation(db, &record.locator.last().map(|name| name.to_string_lossy()).unwrap_or_default(), "")?;
                    db.batch_execute("DROP TABLE IF EXISTS LinkedSource; CREATE TABLE LinkedSource (GameID INTEGER PRIMARY KEY, Ordinal INTEGER NOT NULL, Stamp TEXT NOT NULL); DELETE FROM Games;")?;
                    let mut omitted = 0;
                    for (ordinal, range) in ranges.iter().enumerate() {
                        cancellation_check(cancellation)?;
                        let (bytes, game) = identity_range(&mut source, *range, cancellation)?;
                        let Some(game) = game else { omitted += 1; continue; };
                        game.insert_to_db(db)?;
                        let ordinal = i32::try_from(ordinal).map_err(|_| Error::ResourceLimit("collection has too many games".into()))?;
                        sql_query("INSERT INTO LinkedSource(GameID,Ordinal,Stamp) VALUES(last_insert_rowid(),?,?)")
                            .bind::<diesel::sql_types::Integer,_>(ordinal).bind::<Text,_>(pgn::game_stamp(&bytes))
                            .execute(db)?;
                    }
                    cancellation_check(cancellation)?;
                    let digest = digest_file(&mut source, cancellation)?;
                    #[cfg(test)]
                    if let Some(hook) = self.rebuild_hook.lock().unwrap().as_ref() { hook()?; }
                    let current = Self::snapshot(&record, authority)?;
                    if pgn::revision_string(&current) != generation { return Err(Error::StaleGame); }
                    self.require_active(record.id, cancellation)?;
                    let revision = repository::read_data_revision(db)?.checked_add(1).and_then(|value| i64::try_from(value).ok()).ok_or_else(|| Error::ResourceLimit("collection generation overflow".into()))?;
                    update_info_count(db, "DataRevision", revision)?;
                    for (name, value) in [("LinkedGeneration", generation.clone()), ("LinkedOmitted", omitted.to_string()), ("LinkedDigest", digest)] {
                        sql_query("INSERT INTO Info(Name,Value) VALUES(?,?) ON CONFLICT(Name) DO UPDATE SET Value=excluded.Value").bind::<Text,_>(name).bind::<Text,_>(value).execute(db)?;
                    }
                    db.batch_execute("DELETE FROM Players WHERE ID != 0 AND NOT EXISTS(SELECT 1 FROM Games WHERE WhiteID=Players.ID OR BlackID=Players.ID); DELETE FROM Events WHERE ID != 0 AND NOT EXISTS(SELECT 1 FROM Games WHERE EventID=Events.ID); DELETE FROM Sites WHERE ID != 0 AND NOT EXISTS(SELECT 1 FROM Games WHERE SiteID=Sites.ID);")?;
                    update_database_counts(db)?; create_required_indexes(db)?;
                    cancellation_check(cancellation)?;
                    Ok((generation.clone(), omitted))
                });
                self.search_cache.invalidate_database(&target);
                match result { Err(Error::StaleGame) if attempt + 1 < SOURCE_REBUILD_ATTEMPTS => continue, result => return result }
            }
            Err(Error::StaleGame)
        })
    }

    pub(crate) fn resolve_database(
        &self,
        authority: &SharedPathAuthority,
        file: &DatabaseHandle,
        operation: PathOperation,
        cancellation: &CancellationToken,
    ) -> Result<(), Error> {
        let records = Self::state(&mut *self.lock(cancellation)?)?.records.clone();
        if records
            .iter()
            .any(|record| record.retired_database.as_ref() == Some(file))
        {
            return Err(Error::Conflict(
                "database was linked and is no longer an independent edit source".into(),
            ));
        }
        if let Some(record) = records
            .iter()
            .find(|record| record.database.as_ref() == Some(file))
        {
            if matches!(
                operation,
                PathOperation::DatabaseCreate | PathOperation::DatabaseMutate
            ) {
                return Err(Error::Conflict(
                    "linked search indexes cannot be edited directly".into(),
                ));
            }
            self.refresh(authority, record.id, cancellation)?;
        }
        Ok(())
    }

    pub(crate) fn guard_database(
        &self,
        file: &DatabaseHandle,
        operation: PathOperation,
    ) -> Result<(), Error> {
        let mut guard = self.lock(&CancellationToken::new())?;
        let registry = Self::state(&mut guard)?;
        if registry.records.iter().any(|record| {
            record.retired_database.as_ref() == Some(file)
                || record.database.as_ref() == Some(file)
                    && (matches!(
                        operation,
                        PathOperation::DatabaseCreate | PathOperation::DatabaseMutate
                    ) || registry.inactive_migration_index(record.id)
                        || !matches!(
                            record.purpose,
                            WorkspaceFileType::Game | WorkspaceFileType::Tournament
                        ))
        }) {
            return Err(Error::Conflict(
                "database is an index or a retired independent copy".into(),
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn insert_retired_database_for_test(&self, file: DatabaseHandle) {
        let source = FileWorkspaceHandle::new(file.path_ref().clone());
        Self::state(&mut self.lock(&CancellationToken::new()).unwrap())
            .unwrap()
            .records
            .push(Record {
                id: Uuid::new_v4(),
                workspace: source.clone(),
                locator: vec![OsString::from("retired.pgn")],
                trash_locator: vec![],
                file: source,
                identity: (0, 0),
                source_epoch: 0,
                purpose: WorkspaceFileType::Game,
                account: None,
                database: None,
                retired_database: Some(file),
                pending: None,
                coverage_cursor_ms: None,
                coverage_cursor_current: false,
            });
    }

    pub(crate) fn is_linked(&self, file: &DatabaseHandle) -> Result<bool, Error> {
        Ok(Self::state(&mut *self.lock(&CancellationToken::new())?)?
            .records
            .iter()
            .any(|record| record.database.as_ref() == Some(file)))
    }

    pub(crate) fn guard_database_target(
        &self,
        file: &DatabaseHandle,
        operation: PathOperation,
        identity: (u64, u64),
    ) -> Result<(), Error> {
        self.guard_database(file, operation)?;
        let mut guard = self.lock(&CancellationToken::new())?;
        let registry = Self::state(&mut guard)?;
        if registry
            .migrations
            .iter()
            .any(|intent| intent.collection.is_some() && intent.database_identity == identity)
            || registry.records.iter().any(|record| {
                self.target(record)
                    .is_ok_and(|target| target.identity() == identity)
                    && (matches!(
                        operation,
                        PathOperation::DatabaseCreate | PathOperation::DatabaseMutate
                    ) || registry.inactive_migration_index(record.id)
                        || record.database.as_ref() != Some(file))
            })
        {
            return Err(Error::Conflict(
                "database is an index or a retired independent copy".into(),
            ));
        }
        Ok(())
    }

    pub(crate) fn validate_result(
        &self,
        authority: &SharedPathAuthority,
        file: &DatabaseHandle,
        generation: &Option<String>,
    ) -> Result<(), Error> {
        let Some(expected) = generation else {
            return Ok(());
        };
        let records = Self::state(&mut *self.lock(&CancellationToken::new())?)?
            .records
            .clone();
        let record = records
            .iter()
            .find(|record| record.database.as_ref() == Some(file))
            .ok_or(Error::StaleGame)?;
        self.require_active(record.id, &CancellationToken::new())?;
        if pgn::revision_string(&Self::snapshot(record, authority)?) != *expected {
            return Err(Error::StaleGame);
        }
        Ok(())
    }

    pub(crate) fn query_generation(
        &self,
        _authority: &SharedPathAuthority,
        file: &DatabaseHandle,
    ) -> Result<Option<(String, u64)>, Error> {
        let records = Self::state(&mut *self.lock(&CancellationToken::new())?)?
            .records
            .clone();
        records
            .iter()
            .find(|record| record.database.as_ref() == Some(file))
            .map(|record| {
                self.require_active(record.id, &CancellationToken::new())?;
                let mut db = self.repository.connection(&self.target(record)?, None)?;
                let generation = linked_metadata(&mut db)?.ok_or(Error::StaleGame)?.0;
                Ok((generation, repository::read_data_revision(&mut db)?))
            })
            .transpose()
    }
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountCollectionPreparation {
    pub collection: Option<CollectionDescriptor>,
    pub migration_required: bool,
    pub destination: authority::PathRef,
    pub pending_batch: Option<FileWorkspaceHandle>,
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn prepare_account_collection(
    workspace: FileWorkspaceHandle,
    account: AccountIdentity,
    legacy_database: Option<DatabaseHandle>,
    state: tauri::State<'_, AppState>,
) -> Result<Option<AccountCollectionPreparation>, Error> {
    let operation = state.operations.accept("prepare_account_collection")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let mutation = Arc::clone(&state.workspace_mutation);
    crate::infra::operations::run_native_operation(
        operation,
        "prepare_account_collection",
        async move {
            BLOCKING_GATEWAY
                .spawn_cancellable(cancellation, move |token| {
                    let Some(service) = authority.collections()? else {
                        return Ok(None);
                    };
                    let account = account.validate()?;
                    let batches = service.root.ensure_child(OsStr::new("batches"))?;
                    let destination = authority
                        .with_mut(|authority| authority.collection_batch_destination(&batches))??;
                    let (existing, recovering) = {
                        let mut guard = service.lock(token)?;
                        let registry = CollectionService::state(&mut guard)?;
                        (
                            registry
                                .records
                                .iter()
                                .find(|record| record.account.as_ref() == Some(&account))
                                .cloned(),
                            registry
                                .creations
                                .iter()
                                .any(|intent| intent.account == account),
                        )
                    };
                    let existing = existing.filter(|_| !recovering);
                    if let Some(record) = existing {
                        let pending_batch = service.pending_source(&authority, record.id, token)?;
                        return Ok(Some(AccountCollectionPreparation {
                            collection: Some(service.describe(&authority, &record, token)?),
                            migration_required: false,
                            destination,
                            pending_batch,
                        }));
                    }
                    if let Some(database) = legacy_database.as_ref().filter(|_| !recovering) {
                        if CollectionService::state(&mut *service.lock(token)?)?
                            .migrations
                            .iter()
                            .any(|intent| {
                                intent.database == *database
                                    && intent.account.as_ref() == Some(&account)
                                    && intent.choice == MigrationChoice::Decline
                            })
                        {
                            return Ok(None);
                        }
                        return Ok(Some(AccountCollectionPreparation {
                            collection: None,
                            migration_required: true,
                            destination,
                            pending_batch: None,
                        }));
                    }
                    let mut guard = service.lock(token)?;
                    let mut registry = CollectionService::state(&mut guard)?.clone();
                    let creation = registry
                        .creations
                        .iter()
                        .find(|creation| creation.account == account)
                        .cloned()
                        .unwrap_or_else(|| {
                            let id = Uuid::new_v4();
                            CreationIntent {
                                id,
                                workspace: workspace.clone(),
                                name: format!("{}-{}-{}", account.provider, account.account, id),
                                account: account.clone(),
                                identity: None,
                            }
                        });
                    if !registry
                        .creations
                        .iter()
                        .any(|prior| prior.id == creation.id)
                    {
                        registry.creations.push(creation.clone());
                        service.save(&mut guard, registry)?;
                    }
                    drop(guard);
                    let mut creation = creation;
                    let recovered = service.recover_created_source(
                        &authority,
                        &creation.workspace,
                        &creation.name,
                        creation.identity,
                    )?;
                    let file = if let Some(file) = recovered {
                        file
                    } else {
                        let workspace = creation.workspace.clone();
                        let name = creation.name.clone();
                        let mut owner = |identity| {
                            creation.identity = Some(identity);
                            let mut guard = service.lock(token)?;
                            let mut registry = CollectionService::state(&mut guard)?.clone();
                            let prior = registry
                                .creations
                                .iter_mut()
                                .find(|prior| prior.id == creation.id)
                                .ok_or(Error::StaleGame)?;
                            *prior = creation.clone();
                            service.save(&mut guard, registry)
                        };
                        crate::file_workspace::create_owned_workspace_file_blocking(
                            workspace.clone(),
                            workspace,
                            name,
                            crate::file_workspace::WorkspaceMetadata {
                                file_type: WorkspaceFileType::Game,
                                tags: vec![],
                            },
                            crate::file_workspace::WorkspaceFileContent::Text {
                                pgn: String::new(),
                            },
                            &authority,
                            &mutation,
                            &service.pgn_repository,
                            token,
                            Some(&mut owner),
                        )?
                        .handle
                    };
                    let collection = service
                        .reconcile(&authority, &creation.workspace, token)?
                        .into_iter()
                        .find(|record| record.id == creation.id.to_string() && record.file == file)
                        .ok_or_else(|| {
                            Error::Conflict(
                                "account creation source could not be reconciled".into(),
                            )
                        })?;
                    let pending_batch = service.pending_source(&authority, creation.id, token)?;
                    Ok(Some(AccountCollectionPreparation {
                        collection: Some(collection),
                        migration_required: false,
                        destination,
                        pending_batch,
                    }))
                })
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn collection_for_database(
    file: DatabaseHandle,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<Option<CollectionDescriptor>, Error> {
    let operation =
        crate::native_read_operation(ticket, &window, &state, "collection_for_database")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_native_operation(
        operation,
        "collection_for_database",
        async move {
            BLOCKING_GATEWAY
                .spawn_cancellable(cancellation, move |token| {
                    authority
                        .collections()?
                        .map(|service| service.metadata_for_database(&authority, &file, token))
                        .transpose()
                        .map(Option::flatten)
                })
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn migrate_linked_collection(
    request_id: String,
    workspace: FileWorkspaceHandle,
    database: DatabaseHandle,
    source: Option<FileWorkspaceHandle>,
    choice: MigrationChoice,
    account: Option<AccountIdentity>,
    destination_name: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<CollectionDescriptor>, Error> {
    crate::infra::platform_support::off_unix_refusal("PGN atomic replacement", cfg!(unix))?;
    let operation = state.operations.accept("migrate_linked_collection")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let mutation = Arc::clone(&state.workspace_mutation);
    crate::infra::operations::run_native_operation(
        operation,
        "migrate_linked_collection",
        async move {
            BLOCKING_GATEWAY
                .spawn_cancellable(cancellation, move |token| {
                    let service = authority.collections()?.ok_or_else(|| {
                        Error::Conflict("linked collections are unavailable".into())
                    })?;
                    let id = Uuid::parse_str(&request_id)
                        .map_err(|_| Error::InvalidInput("invalid migration identity".into()))?;
                    let migration_owner =
                        service.migration_locks.lease(database.path_ref().clone());
                    let _migration_owner = migration_owner.lock_cancellable(token)?;
                    let account = account.map(AccountIdentity::validate).transpose()?;
                    let existing = CollectionService::state(&mut *service.lock(token)?)?
                        .migrations
                        .iter()
                        .find(|intent| {
                            intent.id == id
                                || intent.database == database
                                    && intent.choice != MigrationChoice::Decline
                        })
                        .cloned();
                    if choice == MigrationChoice::Decline {
                        if let Some(mut prior) = existing.clone() {
                            if prior.workspace != workspace || prior.database != database {
                                return Err(Error::Conflict(
                                    "migration identity was already used for different inputs"
                                        .into(),
                                ));
                            }
                            if let Some(collection) = prior.collection {
                                return service
                                    .describe(
                                        &authority,
                                        &service.record(collection, token)?,
                                        token,
                                    )
                                    .map(Some);
                            }
                            prior.choice = MigrationChoice::Decline;
                            service.update_intent(prior, token)?;
                            return Ok(None);
                        }
                    }
                    let intent = if let Some(existing) = existing {
                        if existing.workspace != workspace
                            || existing.database != database
                            || existing.source != source
                            || existing.choice != choice
                            || existing.account != account
                            || existing.destination_name != destination_name
                        {
                            return Err(Error::Conflict(
                                "migration identity was already used for different inputs".into(),
                            ));
                        }
                        existing
                    } else {
                        let target =
                            resolve_database(&authority, &database, PathOperation::DatabaseRead)?;
                        let identity = service.repository.database_identity(&target)?;
                        let source_revision = source
                            .as_ref()
                            .map(|source| {
                                authority.with_mut(|authority| {
                                    authority
                                        .resolve(source.path_ref(), PathOperation::ReadPgn, &[])?
                                        .pgn_snapshot()
                                        .map(|snapshot| pgn::revision_string(&snapshot))
                                })?
                            })
                            .transpose()?;
                        let intent = MigrationIntent {
                            id,
                            workspace,
                            database,
                            database_identity: target.identity(),
                            database_revision: identity.data_revision,
                            source,
                            source_revision,
                            choice,
                            account,
                            destination_name,
                            archive_identity: None,
                            archive_ready: false,
                            source_archive_identity: None,
                            export_identity: None,
                            destination: None,
                            destination_identity: None,
                            collection: None,
                            original_collection: None,
                        };
                        service.update_intent(intent.clone(), token)?;
                        intent
                    };
                    if intent.choice == MigrationChoice::Decline {
                        return Ok(None);
                    }
                    service
                        .migrate(&authority, &mutation, intent, token)
                        .map(Some)
                })
                .await
        },
    )
    .await
}

#[derive(Clone, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum CollectionEdit {
    Delete { games: Vec<LinkedGameLocator> },
    Cleanup { empty: bool, duplicates: bool },
    RenamePlayer { from: String, to: String },
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn edit_linked_collection(
    collection: String,
    generation: String,
    edit: CollectionEdit,
    state: tauri::State<'_, AppState>,
) -> Result<bool, Error> {
    crate::infra::platform_support::off_unix_refusal("PGN atomic replacement", cfg!(unix))?;
    let operation = state.operations.accept("edit_linked_collection")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let id = Uuid::parse_str(&collection)
        .map_err(|_| Error::InvalidInput("invalid collection identity".into()))?;
    let service = authority
        .collections()?
        .ok_or_else(|| Error::Conflict("linked collections are unavailable".into()))?;
    crate::infra::operations::run_native_operation(
        operation,
        "edit_linked_collection",
        async move {
            let prepared_service = Arc::clone(&service);
            let record = BLOCKING_GATEWAY
                .spawn_cancellable(cancellation.clone(), move |token| {
                    prepared_service.record(id, token)
                })
                .await?;
            let resolved = authority.with_mut(|authority| {
                authority.resolve(record.file.path_ref(), PathOperation::WritePgn, &[])
            })??;
            let expected_generation = generation.clone();
            pgn::transform_file_core(
                resolved,
                generation,
                service.pgn_repository.clone(),
                pgn::PgnCapabilityRebind::new(authority.clone(), &record.file)
                    .qualified(record.binding()),
                cancellation.clone(),
                move |source, ranges, target, token| {
                    let scratch = tempfile::NamedTempFile::new()?;
                    let projection = rusqlite::Connection::open(scratch.path()).map_err(|_| {
                        Error::Conflict("collection cleanup could not be prepared".into())
                    })?;
                    projection
                        .execute_batch("CREATE TABLE Seen(Stamp TEXT PRIMARY KEY)")
                        .map_err(|_| {
                            Error::Conflict("collection cleanup could not be prepared".into())
                        })?;
                    if let CollectionEdit::Delete { games } = &edit {
                        if games.len() > MAX_SELECTED_GAMES {
                            return Err(Error::ResourceLimit("too many selected games".into()));
                        }
                        for game in games {
                            if game.collection != collection
                                || game.generation != expected_generation
                            {
                                return Err(Error::StaleGame);
                            }
                            let range = ranges
                                .get(usize::try_from(game.ordinal).map_err(|_| Error::StaleGame)?)
                                .ok_or(Error::StaleGame)?;
                            if pgn::game_stamp(&pgn::read_range_bytes(source, *range, token)?)
                                != game.stamp
                            {
                                return Err(Error::StaleGame);
                            }
                        }
                    }
                    let mut offset = 0;
                    for (ordinal, range) in ranges.iter().enumerate() {
                        cancellation_check(token)?;
                        pgn::copy_range(source, target, offset, range.start, token)?;
                        let bytes = pgn::read_range_bytes(source, *range, token)?;
                        let omit = match &edit {
                            CollectionEdit::Delete { games } => games
                                .iter()
                                .any(|game| usize::try_from(game.ordinal).ok() == Some(ordinal)),
                            CollectionEdit::Cleanup { empty, duplicates } => {
                                // A refused (Remainder) range is never judged empty and is copied unchanged.
                                let game = match pgn::read_one_range_game(
                                    &mut BufferedReader::new(bytes.as_slice()),
                                    &mut Importer::new(None),
                                )? {
                                    pgn::RangeGame::One(game) => game,
                                    pgn::RangeGame::Empty | pgn::RangeGame::Remainder => None,
                                };
                                if *empty
                                    && game.as_ref().is_some_and(|game| {
                                        iter_mainline_move_bytes(&game.moves).next().is_none()
                                    })
                                {
                                    true
                                } else if *duplicates {
                                    projection
                                        .execute(
                                            "INSERT OR IGNORE INTO Seen VALUES(?)",
                                            [pgn::game_stamp(&bytes)],
                                        )
                                        .map_err(|_| {
                                            Error::Conflict("collection cleanup failed".into())
                                        })?
                                        == 0
                                } else {
                                    false
                                }
                            }
                            CollectionEdit::RenamePlayer { .. } => false,
                        };
                        if !omit {
                            if let CollectionEdit::RenamePlayer { from, to } = &edit {
                                target.write_all(&rename_player_tags(&bytes, from, to)?)?;
                            } else {
                                target.write_all(&bytes)?;
                            }
                        }
                        offset = range.end;
                    }
                    pgn::copy_range(source, target, offset, source.metadata()?.len(), token)
                },
            )
            .await?;
            let native_authority = authority.clone();
            let refreshed = BLOCKING_GATEWAY
                .spawn_cancellable(CancellationToken::new(), move |token| {
                    service.refresh(&native_authority, id, token)
                })
                .await;
            if let Err(error) = &refreshed {
                log::warn!(
                    "collection {id} post-edit refresh failed: {}",
                    error.diagnostic()
                );
            }
            Ok(refreshed.is_ok())
        },
    )
    .await
}

fn rename_player_tags(bytes: &[u8], from: &str, to: &str) -> Result<Vec<u8>, Error> {
    if to.is_empty() || to.len() > MAX_PLAYER_NAME_BYTES || to.contains(['\n', '\r', '\0']) {
        return Err(Error::InvalidInput("invalid player name".into()));
    }
    // Only header spans in the initial header section can change. Movetext, custom headers,
    // comments, variations and every unrelated byte retain their original spelling.
    let mut result = Vec::with_capacity(bytes.len());
    let mut in_headers = true;
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        if in_headers {
            if let Some(spans) = pgn::tag_value_spans(line) {
                let mut offset = 0;
                for span in spans {
                    if matches!(&line[span.name], b"White" | b"Black")
                        && RawHeader(&line[span.value.clone()]).decode_utf8_lossy() == from
                    {
                        result.extend_from_slice(&line[offset..span.value.start]);
                        for byte in to.bytes() {
                            if matches!(byte, b'\\' | b'"') {
                                result.push(b'\\');
                            }
                            result.push(byte);
                        }
                        offset = span.value.end;
                    }
                }
                result.extend_from_slice(&line[offset..]);
                continue;
            }
            if !line.starts_with(b"%") && !line.iter().all(u8::is_ascii_whitespace) {
                in_headers = false;
            }
        }
        result.extend_from_slice(line);
    }
    Ok(result)
}

fn snapshot_database(
    source: &DatabaseFileTarget,
    destination: &DatabaseFileTarget,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    use super::bound_sqlite::{BoundDatabase, SqliteMode};
    let source_binding = BoundDatabase::acquire(source)?;
    let destination_binding = BoundDatabase::acquire(destination)?;
    let source_lifetime = source_binding.connection_lifetime()?;
    let destination_lifetime = destination_binding.connection_lifetime()?;
    let source_db = source_lifetime.wrap(
        rusqlite::Connection::open_with_flags(
            source_binding.uri(SqliteMode::ReadOnly)?,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|error| {
            log::warn!("database archive open failed: {error}");
            Error::Conflict("database archive could not be opened".into())
        })?,
    );
    let destination_db = destination_lifetime.wrap(
        rusqlite::Connection::open_with_flags(
            destination_binding.uri(SqliteMode::ReadWrite)?,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|error| {
            log::warn!("database archive open failed: {error}");
            Error::Conflict("database archive could not be opened".into())
        })?,
    );
    destination_db
        .execute_batch("PRAGMA synchronous=FULL")
        .map_err(|_| {
            Error::Conflict("database snapshot durability could not be established".into())
        })?;
    let main = c"main";
    // Both connections and their descriptor bindings outlive the backup handle. Every exit calls
    // finish, including cancellation and a bounded busy timeout.
    let backup = unsafe {
        rusqlite::ffi::sqlite3_backup_init(
            destination_db.handle(),
            main.as_ptr(),
            source_db.handle(),
            main.as_ptr(),
        )
    };
    if backup.is_null() {
        return Err(Error::Conflict(
            "database snapshot could not be started".into(),
        ));
    }
    let deadline = std::time::Instant::now() + BACKUP_TIMEOUT;
    let result = loop {
        if cancellation.is_cancelled() {
            break Err(Error::Cancellation);
        }
        let status = unsafe { rusqlite::ffi::sqlite3_backup_step(backup, BACKUP_PAGE_STEP) };
        match status {
            rusqlite::ffi::SQLITE_DONE => break Ok(()),
            rusqlite::ffi::SQLITE_OK => {}
            rusqlite::ffi::SQLITE_BUSY | rusqlite::ffi::SQLITE_LOCKED
                if std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(BACKUP_RETRY_INTERVAL)
            }
            _ => {
                break Err(Error::Conflict(
                    "database snapshot could not be completed".into(),
                ))
            }
        }
    };
    let finished = unsafe { rusqlite::ffi::sqlite3_backup_finish(backup) };
    result?;
    if finished != rusqlite::ffi::SQLITE_OK {
        return Err(Error::Conflict(
            "database snapshot could not be completed".into(),
        ));
    }
    destination_db
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .map_err(|_| Error::Conflict("database snapshot could not be flushed".into()))?;
    drop(destination_db);
    drop(source_db);
    drop(destination_binding);
    drop(source_binding);
    destination.parent().sync_all()?;
    Ok(())
}

#[derive(QueryableByName)]
struct MetadataRow {
    #[diesel(sql_type = Text)]
    name: String,
    #[diesel(sql_type = diesel::sql_types::Nullable<Text>)]
    value: Option<String>,
}

fn has_info_table(db: &mut SqliteConnection) -> Result<bool, Error> {
    #[derive(QueryableByName)]
    struct Row {
        #[diesel(sql_type = diesel::sql_types::BigInt)]
        count: i64,
    }
    Ok(
        sql_query("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='Info'")
            .get_result::<Row>(db)?
            .count
            != 0,
    )
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LinkedGameLocator {
    pub collection: String,
    pub generation: String,
    pub ordinal: i32,
    pub stamp: String,
}

#[derive(QueryableByName)]
struct LocatorRow {
    #[diesel(sql_type = diesel::sql_types::Integer)]
    ordinal: i32,
    #[diesel(sql_type = Text)]
    stamp: String,
}

/// Match headers within this collection only. Rebuild ids and source positions are not identity.
pub(super) fn recent_game_id(
    db: &mut SqliteConnection,
    file: &DatabaseHandle,
    authority: &SharedPathAuthority,
    identity: &LinkedGameIdentity,
    game_id: i32,
    cancellation: &CancellationToken,
) -> Result<Option<i32>, Error> {
    let Some(service) = authority.collections()? else {
        return Ok(Some(game_id));
    };
    let records = CollectionService::state(&mut *service.lock(cancellation)?)?
        .records
        .clone();
    if !records.iter().any(|record| {
        record.database.as_ref() == Some(file)
            && record.id.to_string() == identity.locator.collection
    }) {
        return Ok(Some(game_id));
    }
    #[derive(QueryableByName)]
    struct IdRow {
        #[diesel(sql_type = diesel::sql_types::Integer)]
        id: i32,
    }
    let signature = identity.signature.normalized();
    let predicate = SignatureField::ALL
        .into_iter()
        .map(|field| format!("{} IS ?", field.normalized_sql()))
        .collect::<Vec<_>>()
        .join(" AND ");
    let query = format!(
        "SELECT g.ID AS id FROM Games g
        JOIN Players w ON w.ID=g.WhiteID JOIN Players b ON b.ID=g.BlackID
        JOIN Events e ON e.ID=g.EventID JOIN Sites s ON s.ID=g.SiteID
        JOIN LinkedSource l ON l.GameID=g.ID WHERE {predicate}
        ORDER BY (l.Stamp=?) DESC, ABS(CAST(l.Ordinal AS BIGINT)-?), l.Ordinal LIMIT 1"
    );
    sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
        sql_query(query)
            .bind::<diesel::sql_types::Nullable<Text>, _>(signature.white)
            .bind::<diesel::sql_types::Nullable<Text>, _>(signature.black)
            .bind::<diesel::sql_types::Nullable<Text>, _>(signature.event)
            .bind::<diesel::sql_types::Nullable<Text>, _>(signature.site)
            .bind::<diesel::sql_types::Nullable<Text>, _>(signature.date)
            .bind::<diesel::sql_types::Nullable<Text>, _>(signature.round)
            .bind::<Text, _>(&identity.locator.stamp)
            .bind::<diesel::sql_types::Integer, _>(identity.locator.ordinal)
            .get_result::<IdRow>(db)
            .optional()
    })
    .map(|row| row.map(|row| row.id))
}

pub(super) fn qualify_games(
    db: &mut SqliteConnection,
    file: &DatabaseHandle,
    authority: &SharedPathAuthority,
    games: &mut [NormalizedGame],
) -> Result<(), Error> {
    let Some(service) = authority.collections()? else {
        return Ok(());
    };
    let records = CollectionService::state(&mut *service.lock(&CancellationToken::new())?)?
        .records
        .clone();
    let Some(record) = records
        .iter()
        .find(|record| record.database.as_ref() == Some(file))
    else {
        return Ok(());
    };
    let (generation, _) = linked_metadata(db)?.ok_or(Error::StaleGame)?;
    for game in games {
        let row =
            sql_query("SELECT Ordinal AS ordinal,Stamp AS stamp FROM LinkedSource WHERE GameID=?")
                .bind::<diesel::sql_types::Integer, _>(game.id)
                .get_result::<LocatorRow>(db)?;
        game.linked = Some(LinkedGameLocator {
            collection: record.id.to_string(),
            generation: generation.clone(),
            ordinal: row.ordinal,
            stamp: row.stamp,
        });
    }
    service.validate_result(authority, file, &Some(generation))
}

pub(super) fn linked_metadata(db: &mut SqliteConnection) -> Result<Option<(String, i32)>, Error> {
    let rows: Vec<MetadataRow> = sql_query("SELECT Name AS name,Value AS value FROM Info WHERE Name IN ('LinkedGeneration','LinkedOmitted')").load(db)?;
    let generation = rows
        .iter()
        .find(|row| row.name == "LinkedGeneration")
        .and_then(|row| row.value.clone());
    Ok(generation.map(|generation| {
        (
            generation,
            rows.iter()
                .find(|row| row.name == "LinkedOmitted")
                .and_then(|row| row.value.as_ref())
                .and_then(|value| value.parse().ok())
                .unwrap_or_default(),
        )
    }))
}

pub(super) fn read_snapshot<T>(
    db: &mut SqliteConnection,
    authority: &SharedPathAuthority,
    file: &DatabaseHandle,
    read: impl FnOnce(&mut SqliteConnection) -> Result<T, Error>,
) -> Result<T, Error> {
    let Some(service) = authority.collections()? else {
        return read(db);
    };
    if !service.is_linked(file)? {
        return read(db);
    }
    db.transaction::<_, Error, _>(|db| {
        let generation = linked_metadata(db)?
            .map(|(generation, _)| generation)
            .ok_or(Error::StaleGame)?;
        let value = read(db)?;
        service.validate_result(authority, file, &Some(generation))?;
        Ok(value)
    })
}

#[derive(Default)]
struct IdentityHeaders {
    site: Option<String>,
    link: Option<String>,
}
impl Visitor for IdentityHeaders {
    type Result = (Option<String>, Option<String>);
    fn header(&mut self, key: &[u8], value: RawHeader<'_>) {
        match key {
            b"Site" => self.site = Some(value.decode_utf8_lossy().into_owned()),
            b"Link" => self.link = Some(value.decode_utf8_lossy().into_owned()),
            _ => {}
        }
    }
    fn end_headers(&mut self) -> Skip {
        Skip(true)
    }
    fn end_game(&mut self) -> Self::Result {
        (self.site.take(), self.link.take())
    }
}

// Oversized games still expose provider headers through a bounded 1 MiB prefix.
const MAX_IDENTITY_PREFIX_BYTES: u64 = 1024 * 1024;

/// Classify one bounded range for both identity processing and the search projection.
/// Parser errors concern in-memory PGN bytes. File read errors remain fatal.
fn identity_range(
    source: &mut (impl Read + Seek),
    range: pgn::GameRange,
    cancellation: &CancellationToken,
) -> Result<(Vec<u8>, Option<TempGame>), Error> {
    cancellation_check(cancellation)?;
    let bytes = match pgn::read_range_bytes(source, range, cancellation) {
        Ok(bytes) => bytes,
        Err(Error::ResourceLimit(_)) => {
            let prefix = pgn::GameRange {
                start: range.start,
                end: range
                    .end
                    .min(range.start.saturating_add(MAX_IDENTITY_PREFIX_BYTES)),
            };
            return Ok((pgn::read_range_bytes(source, prefix, cancellation)?, None));
        }
        Err(error) => return Err(error),
    };
    let game = match pgn::read_one_range_game(
        &mut BufferedReader::new(bytes.as_slice()),
        &mut Importer::new(None),
    ) {
        Ok(pgn::RangeGame::One(Some(game))) => Some(game),
        _ => None,
    };
    cancellation_check(cancellation)?;
    Ok((bytes, game))
}

// A malformed header can make the in-memory header reader fail too. It supplies no ID.
fn readable_provider_game_id(
    bytes: &[u8],
    account: &AccountIdentity,
) -> Result<Option<String>, Error> {
    match provider_game_id(bytes, account) {
        Err(Error::Io(_)) => Ok(None),
        result => result,
    }
}

pub(crate) fn provider_game_id(
    bytes: &[u8],
    account: &AccountIdentity,
) -> Result<Option<String>, Error> {
    let mut headers = IdentityHeaders::default();
    let Some((site, link)) = BufferedReader::new(bytes).read_game(&mut headers)? else {
        return Ok(None);
    };
    let mut found = None;
    for value in [site, link].into_iter().flatten() {
        let Ok(url) = reqwest::Url::parse(&value) else {
            continue;
        };
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
            continue;
        }
        let parts: Vec<_> = url.path_segments().into_iter().flatten().collect();
        let id = match (account.provider.as_str(), url.host_str(), parts.as_slice()) {
            ("lichess", Some("lichess.org"), [id] | [id, "white" | "black"])
                if id.len() == 8 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()) =>
            {
                Some((*id).to_owned())
            }
            ("chesscom", Some("www.chess.com" | "chess.com"), ["game", "live" | "daily", id])
                if !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()) =>
            {
                Some((*id).to_owned())
            }
            _ => None,
        };
        if let Some(id) = id {
            if found.as_ref().is_some_and(|prior| prior != &id) {
                return Err(Error::Conflict(
                    "provider identity requires reconciliation".into(),
                ));
            }
            found = Some(id);
        }
    }
    Ok(found)
}

fn linked_semantic_fingerprint(
    game: &TempGame,
    account: &AccountIdentity,
) -> Result<String, Error> {
    let fields = [&game.white_name, &game.black_name, &game.date, &game.time];
    if fields
        .iter()
        .any(|field| field.as_ref().is_none_or(|value| value.is_empty()))
    {
        return Err(Error::Conflict(
            "game identity is incomplete and requires reconciliation".into(),
        ));
    }
    Ok(semantic_fingerprint(game, account))
}

pub(crate) fn semantic_fingerprint(game: &TempGame, account: &AccountIdentity) -> String {
    let mut digest = Sha256::new();
    for field in [
        Some(&account.provider),
        Some(&account.account),
        game.white_name.as_ref(),
        game.black_name.as_ref(),
        game.date.as_ref(),
        game.time.as_ref(),
    ] {
        if let Some(value) = field {
            let value = value.to_ascii_lowercase();
            digest.update((value.len() as u64).to_le_bytes());
            digest.update(value.as_bytes());
        } else {
            digest.update(u64::MAX.to_le_bytes());
        }
    }
    let fen = game
        .fen
        .as_deref()
        .unwrap_or("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    digest.update(fen.as_bytes());
    digest.update(iter_mainline_move_bytes(&game.moves).collect::<Vec<_>>());
    format!("{:x}", digest.finalize())
}

/// Computes coverage from every game in the export, including games a merge will deduplicate.
pub(crate) fn account_sync_cursor(
    provider: &str,
    since_ms: Option<i64>,
    newest_start_ms: Option<i64>,
    provider_ids: &HashSet<String>,
    holds: Option<&[crate::lichess::CoverageHold]>,
) -> i64 {
    let since = since_ms.unwrap_or(0);
    let newest = newest_start_ms.unwrap_or(since).max(since);
    if provider != "lichess" {
        return newest;
    }
    let Some(holds) = holds else { return since };
    holds
        .iter()
        .filter(|hold| hold.ongoing || !provider_ids.contains(&hold.id))
        .map(|hold| hold.created_at_ms.saturating_sub(1).max(since))
        .min()
        .map_or(newest, |floor| newest.min(floor))
}

pub(crate) fn initialize<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
) -> Result<(), Error> {
    if !supported() {
        return Ok(());
    }
    let root = authority::ensure_app_owned_default_dir(
        &AppDataDir::for_app(app)?,
        AppOwnedDefaultRoot::Collections,
    )?;
    state
        .pgn_path_authority
        .install_collections(CollectionService::open(
            root,
            Arc::clone(&state.workspace_mutation),
            Arc::clone(&state.database_repository),
            Arc::clone(&state.search_cache),
            state.pgn_repository.clone(),
        ))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn list_linked_collections(
    workspace: Option<FileWorkspaceHandle>,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<CollectionDescriptor>, Error> {
    let operation =
        crate::native_read_operation(ticket, &window, &state, "list_linked_collections")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = state.pgn_repository.clone();
    crate::infra::operations::run_native_operation(
        operation,
        "list_linked_collections",
        async move {
            list_linked_collections_core(workspace, &authority, &repository, &cancellation).await
        },
    )
    .await
}

pub(crate) async fn list_linked_collections_core(
    workspace: Option<FileWorkspaceHandle>,
    authority: &SharedPathAuthority,
    repository: &PgnRepository,
    cancellation: &CancellationToken,
) -> Result<Vec<CollectionDescriptor>, Error> {
    let Some(service) = authority.collections()? else {
        return Ok(vec![]);
    };
    let service_for_records = Arc::clone(&service);
    let workspaces = BLOCKING_GATEWAY
        .spawn_cancellable(cancellation.clone(), move |token| {
            let mut workspaces = vec![];
            if let Some(workspace) = workspace {
                workspaces.push(workspace);
            }
            for record in &CollectionService::state(&mut *service_for_records.lock(token)?)?.records
            {
                if !workspaces.contains(&record.workspace) {
                    workspaces.push(record.workspace.clone());
                }
            }
            Ok(workspaces)
        })
        .await?;
    let mut result = vec![];
    for workspace in workspaces {
        let listing = crate::file_workspace::list_file_workspace_core(
            &workspace,
            authority,
            repository,
            cancellation,
        )
        .await;
        let service = Arc::clone(&service);
        let authority = authority.clone();
        result.extend(
            BLOCKING_GATEWAY
                .spawn_cancellable(cancellation.clone(), move |token| match listing {
                    Ok(_) => service.reconcile(&authority, &workspace, token),
                    Err(Error::Cancellation) => Err(Error::Cancellation),
                    Err(error) => {
                        log::warn!("collection workspace unavailable: {}", error.diagnostic());
                        let records = CollectionService::state(&mut *service.lock(token)?)?
                            .records
                            .iter()
                            .filter(|record| record.workspace == workspace)
                            .cloned()
                            .collect::<Vec<_>>();
                        records
                            .iter()
                            .map(|record| service.describe(&authority, record, token))
                            .collect()
                    }
                })
                .await?,
        );
    }
    Ok(result)
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenedLinkedGame {
    pub locator: LinkedGameLocator,
    pub file: FileWorkspaceHandle,
    pub name: String,
    pub ordinal: i32,
    pub game: pgn::StampedGame,
    pub purpose: WorkspaceFileType,
    pub num_games: i32,
}

impl CollectionService {
    fn resolve_game(
        &self,
        authority: &SharedPathAuthority,
        file: &DatabaseHandle,
        game_id: i32,
        locator: Option<&LinkedGameLocator>,
        token: &CancellationToken,
    ) -> Result<Option<OpenedLinkedGame>, Error> {
        self.guard_database(file, PathOperation::DatabaseRead)?;
        let records = CollectionService::state(&mut *self.lock(token)?)?
            .records
            .clone();
        let Some(record) = records
            .iter()
            .find(|record| record.database.as_ref() == Some(file))
        else {
            return Ok(None);
        };
        let (generation, _) = self.refresh(authority, record.id, token)?;
        let target = self.target(record)?;
        let mut db = self.repository.connection(&target, Some(token))?;
        let row =
            sql_query("SELECT Ordinal AS ordinal,Stamp AS stamp FROM LinkedSource WHERE GameID=?")
                .bind::<diesel::sql_types::Integer, _>(game_id)
                .get_result::<LocatorRow>(&mut *db)
                .optional()?
                .ok_or(Error::StaleGame)?;
        if locator.is_none_or(|locator| {
            *locator
                != (LinkedGameLocator {
                    collection: record.id.to_string(),
                    generation: generation.clone(),
                    ordinal: row.ordinal,
                    stamp: row.stamp.clone(),
                })
        }) {
            return Err(Error::StaleGame);
        }
        let snapshot = CollectionService::snapshot(record, authority)?;
        if pgn::revision_string(&snapshot) != generation {
            return Err(Error::StaleGame);
        }
        let mut source = snapshot.file.try_clone()?;
        let (_, ranges) = pgn::scan_current_blocking(snapshot, &self.pgn_repository, token)?;
        let range = ranges
            .get(usize::try_from(row.ordinal).map_err(|_| Error::StaleGame)?)
            .ok_or(Error::StaleGame)?;
        let bytes = pgn::read_range_bytes(&mut source, *range, token)?;
        if pgn::game_stamp(&bytes) != row.stamp
            || pgn::revision_string(&CollectionService::snapshot(record, authority)?) != generation
        {
            return Err(Error::StaleGame);
        }
        Ok(Some(OpenedLinkedGame {
            locator: LinkedGameLocator {
                collection: record.id.to_string(),
                generation: generation.clone(),
                ordinal: row.ordinal,
                stamp: row.stamp.clone(),
            },
            file: record.file.clone(),
            name: record
                .locator
                .last()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            ordinal: row.ordinal,
            purpose: record.purpose.clone(),
            num_games: i32::try_from(ranges.len())
                .map_err(|_| Error::ResourceLimit("collection has too many source games".into()))?,
            game: pgn::StampedGame {
                pgn: String::from_utf8(bytes)
                    .map_err(|_| Error::InvalidInput("game is not valid UTF-8".into()))?,
                stamp: row.stamp,
                revision: generation,
                present: true,
                omission: None,
                linked: None,
            },
        }))
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn resolve_linked_game(
    file: DatabaseHandle,
    game_id: i32,
    locator: Option<LinkedGameLocator>,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<Option<OpenedLinkedGame>, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "resolve_linked_game")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_native_operation(operation, "resolve_linked_game", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                let Some(service) = authority.collections()? else {
                    return Ok(None);
                };
                service.resolve_game(&authority, &file, game_id, locator.as_ref(), token)
            })
            .await
    })
    .await
}

pub(crate) fn qualify_source(
    authority: &SharedPathAuthority,
    file: &FileWorkspaceHandle,
    ordinal: i32,
    stamp: &str,
    revision: &str,
    cancellation: &CancellationToken,
) -> Result<Option<LinkedGameLocator>, Error> {
    let Some(service) = authority.collections()? else {
        return Ok(None);
    };
    let records = CollectionService::state(&mut *service.lock(cancellation)?)?
        .records
        .clone();
    let Some(record) = records.iter().find(|record| {
        record.file == *file
            && matches!(
                record.purpose,
                WorkspaceFileType::Game | WorkspaceFileType::Tournament
            )
    }) else {
        return Ok(None);
    };
    if service.inactive_status(record, cancellation)?.is_some() {
        return Ok(None);
    }
    if pgn::revision_string(&CollectionService::snapshot(record, authority)?) != revision {
        return Err(Error::StaleGame);
    }
    Ok(Some(LinkedGameLocator {
        collection: record.id.to_string(),
        generation: revision.into(),
        ordinal,
        stamp: stamp.into(),
    }))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn rebuild_linked_collection(
    collection: String,
    force: bool,
    state: tauri::State<'_, AppState>,
) -> Result<CollectionDescriptor, Error> {
    let operation = state.operations.accept("rebuild_linked_collection")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_native_operation(
        operation,
        "rebuild_linked_collection",
        async move {
            BLOCKING_GATEWAY
                .spawn_cancellable(cancellation, move |token| {
                    let service = authority.collections()?.ok_or_else(|| {
                        Error::Conflict("linked collections are unavailable".into())
                    })?;
                    let id = Uuid::parse_str(&collection)
                        .map_err(|_| Error::InvalidInput("invalid collection identity".into()))?;
                    let record = service.record(id, token)?;
                    let target = service.target(&record)?;
                    if force {
                        service
                            .repository
                            .with_write_lock_cancellable(&target, token, || {
                                let mut db = service
                                    .repository
                                    .initialization_connection(&target, Some(token))?;
                                if has_info_table(&mut db)? {
                                    sql_query("DELETE FROM Info WHERE Name='LinkedGeneration'")
                                        .execute(&mut *db)?;
                                }
                                service.search_cache.invalidate_database(&target);
                                Ok(())
                            })?;
                    }
                    service.describe(&authority, &record, token)
                })
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn reselect_linked_collection(
    collection: String,
    workspace: FileWorkspaceHandle,
    source: FileWorkspaceHandle,
    state: tauri::State<'_, AppState>,
) -> Result<CollectionDescriptor, Error> {
    crate::infra::platform_support::off_unix_refusal("PGN atomic replacement", cfg!(unix))?;
    let operation = state.operations.accept("reselect_linked_collection")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let mutation = Arc::clone(&state.workspace_mutation);
    crate::infra::operations::run_native_operation(
        operation,
        "reselect_linked_collection",
        async move {
            let service = authority
                .collections()?
                .ok_or_else(|| Error::Conflict("linked collections are unavailable".into()))?;
            let id = Uuid::parse_str(&collection)
                .map_err(|_| Error::InvalidInput("invalid collection identity".into()))?;
            let prepare_service = Arc::clone(&service);
            let mut record = BLOCKING_GATEWAY
                .spawn_cancellable(cancellation.clone(), move |token| {
                    let record = prepare_service.record(id, token)?;
                    Ok(record)
                })
                .await?;
            let edit_owner = service.pgn_repository.collection_edit_lock(id)?;
            #[cfg(test)]
            service.pgn_repository.notify_edit_lock_wait()?;
            let _edit_owner = tokio::select! {
                guard = edit_owner.lock() => guard,
                _ = cancellation.cancelled() => return Err(Error::Cancellation),
            };
            #[cfg(test)]
            service.pgn_repository.notify_edit_lock_acquired()?;
            let worker_service = Arc::clone(&service);
            BLOCKING_GATEWAY
                .spawn_cancellable(cancellation, move |token| {
                    let service = worker_service;
                    let captured = record.binding();
                    service.validate_captured_binding(&captured, token)?;
                    if record.file != source || record.workspace != workspace {
                        service.validate_reselection_batch(&authority, &record, token)?;
                    }
                    let (listing, _) =
                        crate::file_workspace::collect_tree_entries(&authority, &workspace, token)?;
                    let mut metadata =
                        selected_metadata(&listing.entries, &source).ok_or_else(|| {
                            Error::InvalidInput(
                                "selected source is not a file in this workspace".into(),
                            )
                        })?;
                    if CollectionService::state(&mut *service.lock(token)?)?
                        .records
                        .iter()
                        .any(|prior| prior.id != id && prior.file == source)
                    {
                        return Err(Error::Conflict(
                            "selected source already belongs to another collection".into(),
                        ));
                    }
                    metadata.file_type = record.purpose.clone();
                    crate::file_workspace::write_workspace_file_metadata_blocking(
                        workspace.clone(),
                        source.clone(),
                        metadata,
                        &authority,
                        &mutation,
                        token,
                    )?;
                    let locator = relative_locator(&authority, &workspace, &source)?;
                    record.file = source;
                    record.workspace = workspace;
                    record.locator = locator;
                    record.trash_locator.clear();
                    record.identity = CollectionService::snapshot(&record, &authority)?
                        .identity
                        .pair();
                    let mut guard = service.lock(token)?;
                    let mut registry = CollectionService::state(&mut guard)?.clone();
                    if registry
                        .records
                        .iter()
                        .any(|prior| prior.id != id && prior.file == record.file)
                    {
                        return Err(Error::Conflict(
                            "selected source already belongs to another collection".into(),
                        ));
                    }
                    let current = registry
                        .records
                        .iter_mut()
                        .find(|prior| prior.id == id)
                        .ok_or(Error::StaleGame)?;
                    if current.binding() != captured {
                        return Err(Error::StaleGame);
                    }
                    if current.file != record.file || current.workspace != record.workspace {
                        current.source_epoch =
                            current.source_epoch.checked_add(1).ok_or_else(|| {
                                Error::ResourceLimit("collection source generation overflow".into())
                            })?;
                        if let Some(pending) = &mut current.pending {
                            pending.clear_preparation();
                        }
                    }
                    current.file = record.file;
                    current.workspace = record.workspace;
                    current.locator = record.locator;
                    current.identity = record.identity;
                    record = current.clone();
                    service.save(&mut guard, registry)?;
                    drop(guard);
                    service.describe(&authority, &record, token)
                })
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn restore_collection_archive(
    collection: String,
    destination: DatabaseHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let operation = state.operations.accept("restore_collection_archive")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_native_operation(
        operation,
        "restore_collection_archive",
        async move {
            BLOCKING_GATEWAY
                .spawn_cancellable(cancellation, move |token| {
                    let service = authority.collections()?.ok_or_else(|| {
                        Error::Conflict("linked collections are unavailable".into())
                    })?;
                    let id = Uuid::parse_str(&collection)
                        .map_err(|_| Error::InvalidInput("invalid collection identity".into()))?;
                    service.restore_archive(&authority, id, &destination, token)
                })
                .await
        },
    )
    .await
}

impl CollectionService {
    fn restore_archive(
        &self,
        authority: &SharedPathAuthority,
        id: Uuid,
        destination: &DatabaseHandle,
        token: &CancellationToken,
    ) -> Result<(), Error> {
        let intent = Self::state(&mut *self.lock(token)?)?
            .migrations
            .iter()
            .find(|intent| intent.collection == Some(id))
            .cloned()
            .ok_or_else(|| Error::InvalidInput("collection has no migration archive".into()))?;
        let archive = self
            .root
            .database_target(OsStr::new(&format!("{}-original.db3", intent.id)))?;
        if Some(archive.identity()) != intent.archive_identity {
            return Err(Error::Conflict(
                "migration archive ownership cannot be confirmed".into(),
            ));
        }
        let target = resolve_database(authority, destination, PathOperation::DatabaseCreate)?;
        self.repository
            .with_write_lock_cancellable(&target, token, || {
                self.guard_database_target(
                    destination,
                    PathOperation::DatabaseCreate,
                    target.identity(),
                )?;
                let mut guard = self.lock(token)?;
                let mut registry = Self::state(&mut guard)?.clone();
                let prior = registry
                    .restores
                    .iter()
                    .find(|restore| restore.destination == *destination)
                    .cloned();
                if let Some(prior) = &prior {
                    if prior.migration != intent.id || prior.identity != target.identity() {
                        return Err(Error::Conflict(
                            "restore destination belongs to a different operation".into(),
                        ));
                    }
                    if prior.completed {
                        let current = self.repository.database_identity(&target)?.data_revision;
                        if current != intent.database_revision {
                            return Err(Error::Conflict(
                                "restored database has been edited since restoration".into(),
                            ));
                        }
                        migrations::validate_content(
                            &mut *self.repository.connection(&target, Some(token))?,
                        )?;
                        return Ok(());
                    }
                } else {
                    if target.probe_current()?.length != 0 {
                        return Err(Error::Conflict(
                            "archive restore requires an exclusively created empty database".into(),
                        ));
                    }
                    registry.restores.push(RestoreIntent {
                        migration: intent.id,
                        destination: destination.clone(),
                        identity: target.identity(),
                        completed: false,
                    });
                    self.save(&mut guard, registry)?;
                }
                drop(guard);
                snapshot_database(&archive, &target, token)?;
                migrations::validate_content(
                    &mut *self.repository.connection(&target, Some(token))?,
                )?;
                if self.repository.database_identity(&target)?.data_revision
                    != intent.database_revision
                {
                    return Err(Error::StaleGame);
                }
                self.search_cache.invalidate_database(&target);
                let mut guard = self.lock(token)?;
                let mut registry = Self::state(&mut guard)?.clone();
                registry
                    .restores
                    .iter_mut()
                    .find(|restore| restore.destination == *destination)
                    .ok_or(Error::StaleGame)?
                    .completed = true;
                self.save(&mut guard, registry)
            })
    }
}

#[cfg(all(test, unix))]
pub(crate) mod tests;

#[cfg(all(test, target_os = "windows"))]
mod platform_tests {
    use super::*;

    #[test]
    fn linked_collections_do_not_initialize_a_registry_or_cache_on_windows() {
        let state = AppState::default();
        let app = tauri::test::mock_app();
        assert!(!linked_collections_supported());
        initialize(app.handle(), &state).unwrap();
        assert!(state.pgn_path_authority.collections().unwrap().is_none());
    }
}
