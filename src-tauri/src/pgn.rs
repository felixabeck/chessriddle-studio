#[cfg(test)]
use std::fs::File;
use std::{
    collections::HashMap,
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write},
    sync::Arc,
};

use pgn_reader::{BufferedReader, Skip, Visitor};
use serde::Serialize;
use sha2::{Digest, Sha256};
use specta::Type;
use tokio_util::sync::CancellationToken;

use crate::{
    error::Error,
    infra::{
        blocking::BLOCKING_GATEWAY,
        keyed_locks::{KeyedLockLease, KeyedLocks},
        operations::OperationLease,
    },
    AppState,
};

fn resolve_pgn(
    state: &AppState,
    file: &crate::infra::path_authority::FileWorkspaceHandle,
    operation: crate::infra::path_authority::PathOperation,
) -> Result<crate::infra::path_authority::ResolvedPath, Error> {
    state
        .pgn_path_authority
        .with_mut(|authority| authority.resolve(file.path_ref(), operation, &[]))?
}

fn resolve_readable_pgn(
    state: &AppState,
    file: &crate::infra::path_authority::FileWorkspaceHandle,
) -> Result<crate::infra::path_authority::ResolvedPath, Error> {
    state.pgn_path_authority.with_mut(|authority| {
        authority.ensure_pgn_not_trashed(file)?;
        authority.resolve(
            file.path_ref(),
            crate::infra::path_authority::PathOperation::ReadPgn,
            &[],
        )
    })?
}

#[derive(Clone)]
pub(crate) struct PgnCapabilityRebind {
    authority: crate::infra::path_authority::SharedPathAuthority,
    path_ref: crate::infra::path_authority::PathRef,
    binding: Option<Option<crate::db::linked_collections::SourceBinding>>,
}

impl PgnCapabilityRebind {
    pub(crate) fn new(
        authority: crate::infra::path_authority::SharedPathAuthority,
        file: &crate::infra::path_authority::FileWorkspaceHandle,
    ) -> Self {
        Self {
            authority,
            path_ref: file.path_ref().clone(),
            binding: None,
        }
    }

    pub(crate) fn qualified(
        mut self,
        binding: crate::db::linked_collections::SourceBinding,
    ) -> Self {
        self.binding = Some(Some(binding));
        self
    }

    pub(crate) fn capture_binding(&mut self) -> Result<(), Error> {
        if self.binding.is_none() {
            self.binding = Some(if let Some(service) = self.authority.collections()? {
                service.capture_binding(
                    &self.authority,
                    &crate::infra::path_authority::FileWorkspaceHandle::new(self.path_ref.clone()),
                )?
            } else {
                None
            });
        }
        Ok(())
    }

    pub(crate) fn captured_binding(
        &self,
    ) -> Result<&Option<crate::db::linked_collections::SourceBinding>, Error> {
        self.binding.as_ref().ok_or(Error::StaleGame)
    }

    fn validate_linked_source(&self) -> Result<(), Error> {
        if self
            .captured_binding()?
            .as_ref()
            .is_some_and(|binding| binding.is_preserved_original())
        {
            return Err(Error::StaleGame);
        }
        Ok(())
    }

    pub(crate) fn validate_binding(&self) -> Result<(), Error> {
        if let Some(service) = self.authority.collections()? {
            service.validate_binding(
                &self.authority,
                &crate::infra::path_authority::FileWorkspaceHandle::new(self.path_ref.clone()),
                self.binding.as_ref().ok_or(Error::StaleGame)?,
            )?;
        }
        Ok(())
    }

    pub(crate) fn edit_lock<'a>(
        &self,
        repository: &'a PgnRepository,
        identity: crate::infra::path_authority::PgnSnapshotIdentity,
    ) -> Result<KeyedLockLease<'a, EditOwner>, Error> {
        if let Some(Some(binding)) = &self.binding {
            repository.collection_edit_lock(binding.collection())
        } else {
            repository.edit_lock(identity)
        }
    }

    fn after_replace(
        &self,
        expected_identity: (u64, u64),
        installed_identity: (u64, u64),
    ) -> Result<(), Error> {
        self.authority.with_mut(|authority| {
            authority.rebind_pgn_file_after_replace(
                &self.path_ref,
                expected_identity,
                installed_identity,
            )
        })?
    }

    fn resolve_read(&self) -> Result<crate::infra::path_authority::ResolvedPath, Error> {
        self.authority.with_mut(|authority| {
            authority.resolve(
                &self.path_ref,
                crate::infra::path_authority::PathOperation::ReadPgn,
                &[],
            )
        })?
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StampedGame {
    pub pgn: String,
    pub stamp: String,
    pub revision: String,
    pub present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub omission: Option<GameOmission>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub linked: Option<crate::db::linked_collections::LinkedGameLocator>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GameOmission {
    TooLarge,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WriteExpectation {
    Game { stamp: String },
    LinkedGame { stamp: String, revision: String },
    Append,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WriteStamp {
    pub stamp: Option<String>,
    pub revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub linked: Option<crate::db::linked_collections::LinkedGameLocator>,
}

const MAX_LINE_LEN: usize = 1024 * 1024;
const MAX_PAGE_LEN: usize = 1_000;
const MAX_PGN_BYTES: usize = 10 * 1024 * 1024;
/// Maximum total PGN text bytes returned by one page.
const MAX_PAGE_BYTES: usize = MAX_PGN_BYTES;
/// Size of each PGN read and copy chunk.
const IO_CHUNK_LEN: usize = 64 * 1024;
const MAX_CACHE_ENTRIES: usize = 128;
const MAX_CACHE_BYTES: usize = 4 * 1024 * 1024;
const MAX_REVISION_ATTEMPTS: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FileRevision {
    size: u64,
    mtime_nanos: i128,
    ctime_nanos: i128,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct CacheKey {
    identity: crate::infra::path_authority::PgnSnapshotIdentity,
    revision: FileRevision,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct GameRange {
    pub(crate) start: u64,
    pub(crate) end: u64,
}

impl GameRange {
    /// Returns the checked byte length of the cached PGN range.
    fn byte_len(self) -> Result<u64, Error> {
        self.end
            .checked_sub(self.start)
            .ok_or_else(|| Error::Conflict("invalid cached PGN byte range".into()))
    }
}

#[derive(Debug, Clone)]
struct CachedScan {
    games: Arc<[GameRange]>,
    last_used: u64,
}

#[cfg(test)]
#[derive(Clone)]
pub(crate) struct BoundedHook {
    entered: Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    release: Arc<std::sync::Mutex<std::sync::mpsc::Receiver<()>>>,
}

#[cfg(test)]
#[derive(Clone, Default)]
struct OneShotSignal(Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>);

#[cfg(test)]
impl OneShotSignal {
    fn new() -> (Self, tokio::sync::oneshot::Receiver<()>) {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        (
            Self(Arc::new(std::sync::Mutex::new(Some(sender)))),
            receiver,
        )
    }

    fn notify(&self) {
        if let Ok(mut sender) = self.0.lock() {
            if let Some(sender) = sender.take() {
                let _ = sender.send(());
            }
        }
    }
}

#[cfg(test)]
impl BoundedHook {
    pub(crate) fn new() -> (
        Self,
        tokio::sync::oneshot::Receiver<()>,
        std::sync::mpsc::SyncSender<()>,
    ) {
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        (
            Self {
                entered: Arc::new(std::sync::Mutex::new(Some(entered_tx))),
                release: Arc::new(std::sync::Mutex::new(release_rx)),
            },
            entered_rx,
            release_tx,
        )
    }

    pub(crate) fn notify_and_wait(&self) {
        let entered = self.entered.lock().ok().and_then(|mut guard| guard.take());
        if let Some(tx) = entered {
            let _ = tx.send(());
            if let Ok(guard) = self.release.lock() {
                let _ = guard.recv_timeout(std::time::Duration::from_secs(5));
            }
        }
    }
}

#[cfg(test)]
std::thread_local! {
    static TEST_READ_CHUNK_HOOK: std::cell::RefCell<Option<BoundedHook>> = const { std::cell::RefCell::new(None) };
    static TEST_COPY_CHUNK_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static TEST_SCAN_LINE_HOOK: std::cell::RefCell<Option<BoundedHook>> = const { std::cell::RefCell::new(None) };
    static TEST_SCAN_ATTEMPT_ACTION: std::cell::RefCell<Option<RevisionAttemptAction>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
type RevisionAttemptAction = Arc<dyn Fn() + Send + Sync>;

#[cfg(test)]
fn set_scan_attempt_action(action: Option<RevisionAttemptAction>) {
    TEST_SCAN_ATTEMPT_ACTION.with(|cell| *cell.borrow_mut() = action);
}

#[cfg(test)]
fn observe_scan_attempt_action() {
    let action = TEST_SCAN_ATTEMPT_ACTION.with(|cell| cell.borrow().clone());
    if let Some(action) = action {
        action();
    }
}

#[cfg(test)]
pub(crate) fn set_read_chunk_hook(hook: Option<BoundedHook>) {
    TEST_READ_CHUNK_HOOK.with(|cell| *cell.borrow_mut() = hook);
}

#[cfg(test)]
fn current_read_chunk_hook() -> Option<BoundedHook> {
    TEST_READ_CHUNK_HOOK.with(|cell| cell.borrow().clone())
}

#[cfg(test)]
pub(crate) fn copy_chunk_count() -> usize {
    TEST_COPY_CHUNK_COUNT.with(std::cell::Cell::get)
}

#[cfg(test)]
fn set_scan_line_hook(hook: Option<BoundedHook>) {
    TEST_SCAN_LINE_HOOK.with(|cell| *cell.borrow_mut() = hook);
}

#[cfg(test)]
fn current_scan_line_hook() -> Option<BoundedHook> {
    TEST_SCAN_LINE_HOOK.with(|cell| cell.borrow().clone())
}

#[cfg(test)]
pub(crate) type CreatePostRegisterHook = Box<dyn FnOnce() + Send>;

#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) enum EditOwner {
    File(crate::infra::path_authority::PgnSnapshotIdentity),
    Collection(uuid::Uuid),
    PracticeFile(String),
}

#[derive(Default)]
struct PgnRepositoryInner {
    practice_directory: Option<Arc<crate::infra::path_authority::AuthorizedDir>>,
    cache: HashMap<CacheKey, CachedScan>,
    clock: u64,
    retained_bytes: usize,
    #[cfg(test)]
    read_chunk_hook: Option<BoundedHook>,
    #[cfg(test)]
    scan_line_hook: Option<BoundedHook>,
    #[cfg(test)]
    scan_attempt_action: Option<RevisionAttemptAction>,
    #[cfg(test)]
    read_attempt_action: Option<RevisionAttemptAction>,
    #[cfg(test)]
    edit_worker_hook: Option<BoundedHook>,
    #[cfg(test)]
    edit_lock_wait_signal: Option<OneShotSignal>,
    #[cfg(test)]
    edit_lock_acquired_signal: Option<OneShotSignal>,
    #[cfg(test)]
    count_hook: Option<BoundedHook>,
    #[cfg(test)]
    post_commit_hook: Option<BoundedHook>,
    #[cfg(test)]
    atomic_file_injector: Option<Arc<dyn crate::infra::fs::AtomicWriterInjector + Send + Sync>>,
    #[cfg(test)]
    create_post_register_hook: Option<CreatePostRegisterHook>,
}

/// Bounded PGN state. Cache entries are revision-specific. Clones share edit locks keyed by
/// snapshot identity or collection UUID, with entries removed when the final lease drops.
#[derive(Clone)]
pub struct PgnRepository {
    inner: Arc<std::sync::Mutex<PgnRepositoryInner>>,
    edit_locks: Arc<KeyedLocks<EditOwner>>,
    cache_byte_limit: usize,
}

impl Default for PgnRepository {
    fn default() -> Self {
        Self {
            inner: Arc::new(std::sync::Mutex::new(PgnRepositoryInner::default())),
            edit_locks: Arc::new(KeyedLocks::default()),
            cache_byte_limit: MAX_CACHE_BYTES,
        }
    }
}

impl PgnRepository {
    pub(crate) fn initialize_practice(
        &self,
        directory: crate::infra::path_authority::AuthorizedDir,
    ) -> Result<(), Error> {
        self.inner()?.practice_directory = Some(Arc::new(directory));
        Ok(())
    }

    fn practice_file(
        &self,
        rebind: Option<&PgnCapabilityRebind>,
    ) -> Result<Option<(Arc<crate::infra::path_authority::AuthorizedDir>, String)>, Error> {
        Ok(self
            .inner()?
            .practice_directory
            .clone()
            .zip(rebind.map(|binding| binding.path_ref.id.clone())))
    }

    /// Atomic replacement changes the inode. Keep practice evidence serialized across that
    /// change as well as across commands which resolved the previous inode before waiting.
    /// The shared keyed registry retains only outstanding leases, bounded by distinct file ids
    /// with active callers. The final lease's Drop removes its entry on completion, error,
    /// cancellation, or an unused lease being dropped.
    fn practice_edit_lock(&self, file_id: String) -> Result<KeyedLockLease<'_, EditOwner>, Error> {
        self.edit_owner(EditOwner::PracticeFile(file_id))
    }

    fn practice_mutation_lock(
        &self,
        rebind: Option<&PgnCapabilityRebind>,
    ) -> Result<Option<KeyedLockLease<'_, EditOwner>>, Error> {
        self.practice_file(rebind)?
            .map(|(_, file_id)| self.practice_edit_lock(file_id))
            .transpose()
    }
    #[cfg(test)]
    fn set_scan_attempt_action(&self, action: Option<RevisionAttemptAction>) -> Result<(), Error> {
        self.inner()?.scan_attempt_action = action;
        Ok(())
    }

    #[cfg(test)]
    fn scan_attempt_action(&self) -> Result<Option<RevisionAttemptAction>, Error> {
        Ok(self.inner()?.scan_attempt_action.clone())
    }

    #[cfg(test)]
    fn set_read_attempt_action(&self, action: Option<RevisionAttemptAction>) -> Result<(), Error> {
        self.inner()?.read_attempt_action = action;
        Ok(())
    }

    #[cfg(test)]
    fn observe_read_attempt_action(&self) -> Result<(), Error> {
        let action = self.inner()?.read_attempt_action.clone();
        if let Some(action) = action {
            action();
        }
        Ok(())
    }

    fn inner(&self) -> Result<std::sync::MutexGuard<'_, PgnRepositoryInner>, Error> {
        self.inner
            .lock()
            .map_err(|_| Error::Conflict("PGN repository lock was poisoned".into()))
    }

    #[cfg(test)]
    fn retained_edit_lock_count(&self) -> Result<usize, Error> {
        let _inner = self.inner()?;
        Ok(self.edit_locks.len())
    }

    #[cfg(test)]
    pub(crate) fn set_read_chunk_hook(&self, hook: Option<BoundedHook>) -> Result<(), Error> {
        self.inner()?.read_chunk_hook = hook;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn read_chunk_hook(&self) -> Result<Option<BoundedHook>, Error> {
        Ok(self.inner()?.read_chunk_hook.clone())
    }

    #[cfg(all(test, unix))]
    fn set_post_commit_hook(&self, hook: Option<BoundedHook>) -> Result<(), Error> {
        self.inner()?.post_commit_hook = hook;
        Ok(())
    }

    #[cfg(test)]
    fn post_commit_hook(&self) -> Result<Option<BoundedHook>, Error> {
        Ok(self.inner()?.post_commit_hook.clone())
    }

    #[cfg(test)]
    pub(crate) fn set_scan_line_hook(&self, hook: Option<BoundedHook>) -> Result<(), Error> {
        self.inner()?.scan_line_hook = hook;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn scan_line_hook(&self) -> Result<Option<BoundedHook>, Error> {
        Ok(self.inner()?.scan_line_hook.clone())
    }

    #[cfg(test)]
    pub(crate) fn has_cached_identity(
        &self,
        identity: crate::infra::path_authority::PgnSnapshotIdentity,
    ) -> Result<bool, Error> {
        let inner = self.inner()?;
        Ok(inner.cache.keys().any(|key| key.identity == identity))
    }

    #[cfg(test)]
    pub(crate) fn set_edit_worker_hook(&self, hook: Option<BoundedHook>) -> Result<(), Error> {
        self.inner()?.edit_worker_hook = hook;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn edit_worker_hook(&self) -> Result<Option<BoundedHook>, Error> {
        Ok(self.inner()?.edit_worker_hook.clone())
    }

    #[cfg(test)]
    pub(crate) fn observe_edit_lock_wait(
        &self,
    ) -> Result<tokio::sync::oneshot::Receiver<()>, Error> {
        let (signal, receiver) = OneShotSignal::new();
        self.inner()?.edit_lock_wait_signal = Some(signal);
        Ok(receiver)
    }

    #[cfg(test)]
    pub(crate) fn notify_edit_lock_wait(&self) -> Result<(), Error> {
        if let Some(signal) = self.inner()?.edit_lock_wait_signal.take() {
            signal.notify();
        }
        Ok(())
    }

    #[cfg(all(test, unix))]
    pub(crate) fn observe_edit_lock_acquired(
        &self,
    ) -> Result<tokio::sync::oneshot::Receiver<()>, Error> {
        let (signal, receiver) = OneShotSignal::new();
        self.inner()?.edit_lock_acquired_signal = Some(signal);
        Ok(receiver)
    }

    #[cfg(test)]
    pub(crate) fn notify_edit_lock_acquired(&self) -> Result<(), Error> {
        if let Some(signal) = self.inner()?.edit_lock_acquired_signal.take() {
            signal.notify();
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn set_count_hook(&self, hook: Option<BoundedHook>) -> Result<(), Error> {
        self.inner()?.count_hook = hook;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn set_create_post_register_hook(
        &self,
        hook: Option<CreatePostRegisterHook>,
    ) -> Result<(), Error> {
        self.inner()?.create_post_register_hook = hook;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn take_create_post_register_hook(
        &self,
    ) -> Result<Option<CreatePostRegisterHook>, Error> {
        Ok(self.inner()?.create_post_register_hook.take())
    }

    #[cfg(test)]
    pub(crate) fn count_hook(&self) -> Result<Option<BoundedHook>, Error> {
        Ok(self.inner()?.count_hook.clone())
    }

    #[cfg(test)]
    pub(crate) fn set_atomic_file_injector(
        &self,
        injector: Option<Arc<dyn crate::infra::fs::AtomicWriterInjector + Send + Sync>>,
    ) -> Result<(), Error> {
        self.inner()?.atomic_file_injector = injector;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn atomic_file_injector(
        &self,
    ) -> Result<Option<Arc<dyn crate::infra::fs::AtomicWriterInjector + Send + Sync>>, Error> {
        Ok(self.inner()?.atomic_file_injector.clone())
    }

    fn tick(inner: &mut PgnRepositoryInner) -> u64 {
        inner.clock = inner.clock.wrapping_add(1);
        inner.clock
    }

    pub(crate) fn edit_lock(
        &self,
        identity: crate::infra::path_authority::PgnSnapshotIdentity,
    ) -> Result<KeyedLockLease<'_, EditOwner>, Error> {
        self.edit_owner(EditOwner::File(identity))
    }

    pub(crate) fn collection_edit_lock(
        &self,
        collection: uuid::Uuid,
    ) -> Result<KeyedLockLease<'_, EditOwner>, Error> {
        self.edit_owner(EditOwner::Collection(collection))
    }

    fn edit_owner(&self, identity: EditOwner) -> Result<KeyedLockLease<'_, EditOwner>, Error> {
        // Preserve poisoned-repository admission refusal without lending the cache mutex.
        let _inner = self.inner()?;
        Ok(self.edit_locks.lease(identity))
    }

    fn get(&self, key: &CacheKey) -> Result<Option<Arc<[GameRange]>>, Error> {
        let mut inner = self.inner()?;
        let now = Self::tick(&mut inner);
        Ok(inner.cache.get_mut(key).map(|entry| {
            entry.last_used = now;
            entry.games.clone()
        }))
    }

    fn retain_if_within_budget(&self, key: CacheKey, games: Arc<[GameRange]>) -> Result<(), Error> {
        let mut inner = self.inner()?;
        let now = Self::tick(&mut inner);
        if let Some(replaced) = inner.cache.remove(&key) {
            inner.retained_bytes = inner
                .retained_bytes
                .saturating_sub(std::mem::size_of_val(replaced.games.as_ref()));
        }
        let retained_bytes = std::mem::size_of_val(games.as_ref());
        if retained_bytes > self.cache_byte_limit {
            return Ok(());
        }
        while inner.cache.len() >= MAX_CACHE_ENTRIES
            || inner.retained_bytes > self.cache_byte_limit - retained_bytes
        {
            if let Some(oldest) = inner
                .cache
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| key.clone())
            {
                if let Some(evicted) = inner.cache.remove(&oldest) {
                    inner.retained_bytes = inner
                        .retained_bytes
                        .saturating_sub(std::mem::size_of_val(evicted.games.as_ref()));
                }
            } else {
                break;
            }
        }
        inner.retained_bytes += retained_bytes;
        inner.cache.insert(
            key,
            CachedScan {
                games,
                last_used: now,
            },
        );
        Ok(())
    }

    pub(crate) fn invalidate(
        &self,
        identity: &crate::infra::path_authority::PgnSnapshotIdentity,
    ) -> Result<(), Error> {
        let mut inner = self.inner()?;
        let removed_bytes = inner
            .cache
            .iter()
            .filter(|(key, _)| &key.identity == identity)
            .map(|(_, entry)| std::mem::size_of_val(entry.games.as_ref()))
            .sum::<usize>();
        inner.cache.retain(|key, _| &key.identity != identity);
        inner.retained_bytes = inner.retained_bytes.saturating_sub(removed_bytes);
        Ok(())
    }
}

fn snapshot_key(snapshot: &crate::infra::path_authority::PgnSnapshot) -> CacheKey {
    CacheKey {
        identity: snapshot.identity.clone(),
        revision: FileRevision {
            size: snapshot.revision.size,
            mtime_nanos: snapshot.revision.mtime_nanos,
            ctime_nanos: snapshot.revision.ctime_nanos,
        },
    }
}

fn is_tag_header(line: &str, in_brace_comment: bool) -> bool {
    !in_brace_comment && tag_value_spans(line.as_bytes()).is_some()
}

pub(crate) struct TagValueSpan {
    pub(crate) name: std::ops::Range<usize>,
    pub(crate) value: std::ops::Range<usize>,
}

/// A physical header line contains complete tag pairs and whitespace only. Both range
/// detection and lossless header editing use these exact byte spans, including escapes.
pub(crate) fn tag_value_spans(bytes: &[u8]) -> Option<Vec<TagValueSpan>> {
    let mut at = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        3
    } else {
        0
    };
    let mut spans = Vec::new();
    loop {
        while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
            at += 1;
        }
        if at == bytes.len() {
            return (!spans.is_empty()).then_some(spans);
        }
        if bytes.get(at) != Some(&b'[') {
            return None;
        }
        at += 1;
        let name_start = at;
        while bytes
            .get(at)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
        {
            at += 1;
        }
        let name = name_start..at;
        if name.is_empty() || !matches!(bytes.get(at), Some(b' ' | b'\t')) {
            return None;
        }
        while matches!(bytes.get(at), Some(b' ' | b'\t')) {
            at += 1;
        }
        if bytes.get(at) != Some(&b'"') {
            return None;
        }
        at += 1;
        let start = at;
        loop {
            match bytes.get(at)? {
                b'"' => break,
                b'\r' | b'\n' => return None,
                b'\\' => {
                    at += 1;
                    if matches!(bytes.get(at), None | Some(b'\r' | b'\n')) {
                        return None;
                    }
                }
                _ => {}
            }
            at += 1;
        }
        let value = start..at;
        at += 1;
        while matches!(bytes.get(at), Some(b' ' | b'\t')) {
            at += 1;
        }
        if bytes.get(at) != Some(&b']') {
            return None;
        }
        at += 1;
        spans.push(TagValueSpan { name, value });
    }
}

fn update_brace_comment(line: &str, in_brace_comment: &mut bool) {
    let mut in_quoted_string = false;
    let mut escaped = false;
    for character in line.chars() {
        if *in_brace_comment {
            if character == '}' {
                *in_brace_comment = false;
            }
            continue;
        }
        if escaped {
            escaped = false;
            continue;
        }
        if in_quoted_string && character == '\\' {
            escaped = true;
            continue;
        }
        match character {
            '"' => in_quoted_string = !in_quoted_string,
            ';' if !in_quoted_string => break,
            '{' if !in_quoted_string => *in_brace_comment = true,
            _ => {}
        }
    }
}

fn malformed(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn read_bounded_line<R: Read>(reader: &mut BufReader<R>, line: &mut Vec<u8>) -> io::Result<usize> {
    line.clear();
    let mut limited = reader.by_ref().take((MAX_LINE_LEN + 1) as u64);
    let bytes = limited.read_until(b'\n', line)?;
    if bytes > MAX_LINE_LEN {
        return Err(malformed("PGN line exceeds the 1 MiB limit"));
    }
    Ok(bytes)
}

/// Strict, synchronous byte-range scanner. Every range excludes a UTF-8 BOM and is
/// `[start, end)`, with `end` at the next game's header line start (including accepted indentation) or EOF.
#[cfg(test)]
fn scan_games<R: Read + Seek>(reader: R) -> io::Result<Vec<GameRange>> {
    scan_games_cancelled(reader, &CancellationToken::new())
}

fn scan_games_cancelled<R: Read + Seek>(
    reader: R,
    cancellation: &CancellationToken,
) -> io::Result<Vec<GameRange>> {
    let mut reader = BufReader::new(reader);
    reader.seek(SeekFrom::Start(0))?;
    let mut bom = [0; 3];
    let mut initial = 0;
    while initial < bom.len() {
        match reader.read(&mut bom[initial..]) {
            Ok(0) => break,
            Ok(bytes) => initial += bytes,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    let start = if initial == bom.len() && bom == [0xEF, 0xBB, 0xBF] {
        3
    } else {
        reader.seek(SeekFrom::Start(0))?;
        0
    };
    let mut games: Vec<GameRange> = Vec::new();
    let mut line = Vec::new();
    let mut game_start = None;
    let mut header_block_ended = false;
    let mut in_brace_comment = false;
    #[cfg(test)]
    let mut observed_attempt = false;
    loop {
        if cancellation.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "PGN scan cancelled",
            ));
        }
        let line_start = reader.stream_position()?;
        let bytes = read_bounded_line(&mut reader, &mut line)?;
        if bytes == 0 {
            break;
        }
        #[cfg(test)]
        if let Some(hook) = current_scan_line_hook() {
            hook.notify_and_wait();
        }
        #[cfg(test)]
        if !observed_attempt {
            observed_attempt = true;
            observe_scan_attempt_action();
        }
        let line = std::str::from_utf8(&line).map_err(|_| malformed("PGN is not valid UTF-8"))?;
        let header = is_tag_header(line, in_brace_comment);
        let escaped_line =
            !in_brace_comment && line.trim_start_matches([' ', '\t']).starts_with('%');
        let escaped_or_line_comment = escaped_line
            || (!in_brace_comment && line.trim_start_matches([' ', '\t']).starts_with(';'));
        let non_whitespace = !escaped_or_line_comment && !line.trim().is_empty();
        if header && header_block_ended {
            games
                .last_mut()
                .expect("game start implies a game range")
                .end = line_start;
            game_start = Some(line_start);
            header_block_ended = false;
            games.push(GameRange {
                start: line_start,
                end: line_start,
            });
        } else if non_whitespace && game_start.is_none() {
            game_start = Some(line_start.max(start));
            games.push(GameRange {
                start: line_start.max(start),
                end: line_start.max(start),
            });
        }
        if !header && !escaped_line && game_start.is_some() {
            header_block_ended = true;
        }
        if !header && !escaped_or_line_comment {
            update_brace_comment(line, &mut in_brace_comment);
        }
    }
    let end = reader.stream_position()?;
    if let Some(last) = games.last_mut() {
        last.end = end;
    }
    if in_brace_comment {
        return Err(malformed("PGN brace comment is not closed before EOF"));
    }
    Ok(games)
}

fn scan_file(
    snapshot: &crate::infra::path_authority::PgnSnapshot,
    cancellation: &CancellationToken,
) -> Result<(CacheKey, Arc<[GameRange]>), Error> {
    let key = snapshot_key(snapshot);
    let games = scan_games_cancelled(snapshot.file.try_clone()?, cancellation)
        .map_err(|error| crate::cancellable_read::map_read_error(error, cancellation))?
        .into();
    Ok((key, games))
}

type ScanCacheLookup = (CacheKey, Option<Arc<[GameRange]>>);

fn fresh_snapshot(
    snapshot: &crate::infra::path_authority::PgnSnapshot,
) -> Result<crate::infra::path_authority::PgnSnapshot, Error> {
    Ok(crate::infra::path_authority::PgnSnapshot {
        file: snapshot.file.try_clone()?,
        identity: snapshot.identity.clone(),
        revision: snapshot.current_revision()?,
    })
}

fn revision_matches(
    snapshot: &crate::infra::path_authority::PgnSnapshot,
    key: &CacheKey,
) -> Result<bool, Error> {
    let revision = snapshot.current_revision()?;
    Ok(revision.size == key.revision.size
        && revision.mtime_nanos == key.revision.mtime_nanos
        && revision.ctime_nanos == key.revision.ctime_nanos)
}

fn next_revision_attempt(
    snapshot: &crate::infra::path_authority::PgnSnapshot,
    repository: &PgnRepository,
    attempt: &mut usize,
    cancellation: &CancellationToken,
) -> Result<crate::infra::path_authority::PgnSnapshot, Error> {
    repository.invalidate(&snapshot.identity)?;
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    if *attempt + 1 >= MAX_REVISION_ATTEMPTS {
        return Err(Error::StaleGame);
    }
    *attempt += 1;
    fresh_snapshot(snapshot)
}

fn cached_scan(
    snapshot: &crate::infra::path_authority::PgnSnapshot,
    repository: &PgnRepository,
    cancellation: &CancellationToken,
) -> Result<ScanCacheLookup, Error> {
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    let key = snapshot_key(snapshot);
    if let Some(games) = repository.get(&key)? {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        return Ok((key, Some(games)));
    }
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    Ok((key, None))
}

pub(crate) fn scan_current_blocking(
    mut snapshot: crate::infra::path_authority::PgnSnapshot,
    repository: &PgnRepository,
    cancellation: &CancellationToken,
) -> Result<(CacheKey, Arc<[GameRange]>), Error> {
    if let (key, Some(games)) = cached_scan(&snapshot, repository, cancellation)? {
        return Ok((key, games));
    }
    #[cfg(test)]
    let scan_line_hook = repository.scan_line_hook()?;
    #[cfg(test)]
    let _guard = {
        set_scan_line_hook(scan_line_hook);
        set_scan_attempt_action(repository.scan_attempt_action()?);
        struct HookGuard;
        impl Drop for HookGuard {
            fn drop(&mut self) {
                set_scan_line_hook(None);
                set_scan_attempt_action(None);
            }
        }
        HookGuard
    };
    let mut attempt = 0;
    loop {
        let (key, cached) = cached_scan(&snapshot, repository, cancellation)?;
        if let Some(games) = cached {
            return Ok((key, games));
        }
        let outcome = scan_file(&snapshot, cancellation);
        if cancellation.is_cancelled() || matches!(outcome, Err(Error::Cancellation)) {
            return Err(Error::Cancellation);
        }
        let unchanged = revision_matches(&snapshot, &key);
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        if unchanged? {
            let (key, games) = outcome?;
            repository.retain_if_within_budget(key.clone(), games.clone())?;
            return Ok((key, games));
        }
        snapshot = next_revision_attempt(&snapshot, repository, &mut attempt, cancellation)?;
    }
}

async fn scan_current(
    snapshot: crate::infra::path_authority::PgnSnapshot,
    repository: &PgnRepository,
    cancellation: &CancellationToken,
) -> Result<(CacheKey, Arc<[GameRange]>), Error> {
    if let (key, Some(games)) = cached_scan(&snapshot, repository, cancellation)? {
        return Ok((key, games));
    }
    let repository = repository.clone();
    BLOCKING_GATEWAY
        .spawn_cancellable(cancellation.clone(), move |token| {
            scan_current_blocking(snapshot, &repository, token)
        })
        .await
}

fn checked_index(n: i32) -> Result<usize, Error> {
    Ok(crate::infra::validation::ValidGameIndex::new(n)?.as_usize())
}

fn checked_range(start: i32, end: i32) -> Result<(usize, usize), Error> {
    let range = crate::infra::validation::ValidGameRange::new(start, end)?;
    let start = range.start;
    let count = range.count;
    if count > MAX_PAGE_LEN {
        return Err(Error::ResourceLimit(format!(
            "PGN page exceeds {MAX_PAGE_LEN} games"
        )));
    }
    Ok((start, count))
}

pub(crate) fn read_range_bytes(
    file: &mut (impl Read + Seek),
    range: GameRange,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, Error> {
    let bytes = range.byte_len()?;
    let len =
        usize::try_from(bytes).map_err(|_| Error::ResourceLimit("PGN game is too large".into()))?;
    if len > MAX_PGN_BYTES {
        return Err(Error::ResourceLimit("PGN game exceeds 10 MiB".into()));
    }
    file.seek(SeekFrom::Start(range.start))?;
    let mut data = vec![0; len];
    let mut offset = 0;
    while offset < len {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let chunk = (len - offset).min(IO_CHUNK_LEN);
        file.read_exact(&mut data[offset..offset + chunk])?;
        offset += chunk;
        #[cfg(test)]
        if let Some(hook) = current_read_chunk_hook() {
            hook.notify_and_wait();
        }
    }
    Ok(data)
}

/// Outcome of reading a scanner range as a single parser game.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RangeGame<T> {
    /// The range contained exactly one parser game.
    One(T),
    /// The range was empty after the reader's whitespace and `%`-line skipping.
    Empty,
    /// A further `read_game` would return `Some` after the first game.
    Remainder,
}

pub(crate) const MORE_THAN_ONE_GAME: &str = "PGN text contains more than one game";

struct SkipRemainder;

impl Visitor for SkipRemainder {
    type Result = ();

    fn end_headers(&mut self) -> Skip {
        Skip(true)
    }

    fn end_game(&mut self) {}
}

#[cfg(test)]
pub(crate) struct RemainderCheckHook {
    pub entered: std::sync::mpsc::SyncSender<()>,
    pub release: std::sync::mpsc::Receiver<()>,
}

#[cfg(test)]
std::thread_local! {
    static TEST_REMAINDER_HOOK: std::cell::RefCell<Option<RemainderCheckHook>> = const {
        std::cell::RefCell::new(None)
    };
}

#[cfg(test)]
pub(crate) fn set_test_remainder_check_hook(hook: Option<RemainderCheckHook>) {
    TEST_REMAINDER_HOOK.with(|current| *current.borrow_mut() = hook);
}

#[cfg(test)]
fn trigger_remainder_check_hook() {
    let hook = TEST_REMAINDER_HOOK.with(|current| current.borrow_mut().take());
    if let Some(hook) = hook {
        let _ = hook.entered.send(());
        let _ = hook.release.recv_timeout(std::time::Duration::from_secs(5));
    }
}

/// Reads a scanner range's bytes as one of three outcomes: `One` when the range
/// contains exactly one parser game, `Empty` when nothing but whitespace and `%`
/// lines is present, or `Remainder` when a further `read_game` would return `Some`
/// after the first game.
///
/// After the caller's visitor consumes the first game, a further `read_game` with a
/// skipping visitor decides the remainder: `Some` is refused, independent of visitor
/// callbacks. Only whitespace and `%` escape lines may follow.
pub(crate) fn read_one_range_game<R, V>(
    reader: &mut BufferedReader<R>,
    visitor: &mut V,
) -> io::Result<RangeGame<V::Result>>
where
    R: Read,
    V: Visitor,
{
    let Some(game) = reader.read_game(visitor)? else {
        return Ok(RangeGame::Empty);
    };
    #[cfg(test)]
    trigger_remainder_check_hook();
    match reader.read_game(&mut SkipRemainder)? {
        Some(_) => Ok(RangeGame::Remainder),
        None => Ok(RangeGame::One(game)),
    }
}

fn refuse_multi_game_range(bytes: &[u8]) -> Result<(), Error> {
    match read_one_range_game(&mut BufferedReader::new(bytes), &mut SkipRemainder)? {
        RangeGame::One(()) | RangeGame::Empty => Ok(()),
        RangeGame::Remainder => Err(Error::InvalidInput(MORE_THAN_ONE_GAME.into())),
    }
}

fn read_ranges(
    mut file: impl Read + Seek,
    ranges: Vec<GameRange>,
    cancellation: &CancellationToken,
) -> Result<Vec<String>, Error> {
    let mut games = Vec::with_capacity(ranges.len());
    for range in ranges {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let data = read_range_bytes(&mut file, range, cancellation)?;
        games.push(
            String::from_utf8(data)
                .map_err(|error| malformed(&format!("invalid UTF-8 PGN: {error}")))?,
        );
    }
    Ok(games)
}

async fn scan_and_read_ranges<T: Send + 'static>(
    resolved: crate::infra::path_authority::ResolvedPath,
    repository: &PgnRepository,
    cancellation: &CancellationToken,
    select: impl FnMut(&CacheKey, &[GameRange]) -> Result<(T, Vec<GameRange>), Error> + Send + 'static,
) -> Result<(CacheKey, T, Vec<String>), Error> {
    let repository = repository.clone();
    BLOCKING_GATEWAY
        .spawn_cancellable(cancellation.clone(), move |token| {
            scan_and_read_ranges_blocking(resolved.pgn_snapshot()?, &repository, token, select)
        })
        .await
}

fn scan_and_read_ranges_blocking<T>(
    mut snapshot: crate::infra::path_authority::PgnSnapshot,
    repository: &PgnRepository,
    cancellation: &CancellationToken,
    mut select: impl FnMut(&CacheKey, &[GameRange]) -> Result<(T, Vec<GameRange>), Error>,
) -> Result<(CacheKey, T, Vec<String>), Error> {
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    #[cfg(test)]
    let test_hook = repository.read_chunk_hook()?;
    #[cfg(test)]
    let _guard = {
        set_read_chunk_hook(test_hook);
        struct HookGuard;
        impl Drop for HookGuard {
            fn drop(&mut self) {
                set_read_chunk_hook(None);
            }
        }
        HookGuard
    };
    let mut attempt = 0;
    loop {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let mut key = snapshot_key(&snapshot);
        let outcome = (|| {
            let (scanned_key, games) =
                scan_current_blocking(fresh_snapshot(&snapshot)?, repository, cancellation)?;
            key = scanned_key;
            let (selection, requested) = select(&key, &games)?;
            let values = read_ranges(snapshot.file.try_clone()?, requested, cancellation)?;
            Ok((selection, values))
        })();
        if cancellation.is_cancelled() || matches!(outcome, Err(Error::Cancellation)) {
            return Err(Error::Cancellation);
        }
        #[cfg(test)]
        repository.observe_read_attempt_action()?;
        let unchanged = revision_matches(&snapshot, &key);
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        if unchanged? {
            let (selection, values) = outcome?;
            return Ok((key, selection, values));
        }
        snapshot = next_revision_attempt(&snapshot, repository, &mut attempt, cancellation)?;
    }
}

pub(crate) fn game_stamp(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn revision_string_for_key(key: &CacheKey) -> String {
    let (device, inode) = key.identity.pair();
    format!(
        "{device}:{inode}:{}:{}:{}",
        key.revision.size, key.revision.mtime_nanos, key.revision.ctime_nanos
    )
}

pub(crate) fn revision_string(snapshot: &crate::infra::path_authority::PgnSnapshot) -> String {
    revision_string_for_key(&snapshot_key(snapshot))
}

pub(crate) fn copy_range(
    source: &mut (impl Read + Seek),
    target: &mut impl Write,
    start: u64,
    end: u64,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    #[cfg(test)]
    TEST_COPY_CHUNK_COUNT.with(|count| count.set(0));
    let len = end
        .checked_sub(start)
        .ok_or_else(|| Error::Conflict("invalid PGN byte range".into()))?;
    source.seek(SeekFrom::Start(start))?;
    let mut remaining = len;
    let mut buffer = [0; IO_CHUNK_LEN];
    while remaining > 0 {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let chunk = usize::try_from(remaining.min(buffer.len() as u64))
            .map_err(|_| Error::ResourceLimit("PGN copy range is too large".into()))?;
        let read = source.read(&mut buffer[..chunk])?;
        if read == 0 {
            return Err(Error::Conflict("PGN snapshot ended while copying".into()));
        }
        target.write_all(&buffer[..read])?;
        remaining -= u64::try_from(read)
            .map_err(|_| Error::ResourceLimit("PGN copy range is too large".into()))?;
        #[cfg(test)]
        {
            TEST_COPY_CHUNK_COUNT.with(|count| count.set(count.get().saturating_add(1)));
            if let Some(hook) = current_read_chunk_hook() {
                hook.notify_and_wait();
            }
        }
    }
    Ok(())
}

fn edit_existing(
    resolved: &crate::infra::path_authority::ResolvedPath,
    expected: CacheKey,
    snapshot: crate::infra::path_authority::PgnSnapshot,
    target: GameRange,
    mut replacement: Option<PgnReplacement>,
    cancellation: &CancellationToken,
) -> Result<crate::infra::fs::AtomicInstalledFile, Error> {
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    resolved.replace_pgn_atomic(&snapshot, cancellation, |source, temporary| {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        copy_range(source, temporary, 0, target.start, cancellation)?;
        if let Some(ref mut replacement) = replacement {
            if target.start > 0 && !replacement.starts_with_newline()? {
                source.seek(SeekFrom::Start(target.start - 1))?;
                let mut prior = [0];
                source.read_exact(&mut prior)?;
                if prior[0] != b'\n' {
                    temporary.write_all(b"\n")?;
                }
            }
            replacement.write_to(temporary, cancellation)?;
            if !replacement.ends_with_newline()?
                && (target.end < expected.revision.size || target.end == target.start)
            {
                temporary.write_all(b"\n")?;
            }
        } else if target.start > 0 && target.end < expected.revision.size {
            source.seek(SeekFrom::Start(target.start - 1))?;
            let mut prior = [0];
            source.read_exact(&mut prior)?;
            source.seek(SeekFrom::Start(target.end))?;
            let mut following = [0];
            source.read_exact(&mut following)?;
            if prior[0] != b'\n' && following[0] != b'\n' {
                temporary.write_all(b"\n")?;
            }
        }
        copy_range(
            source,
            temporary,
            target.end,
            expected.revision.size,
            cancellation,
        )?;
        Ok(())
    })
}

#[tauri::command]
#[specta::specta]
pub async fn count_pgn_games(
    file: crate::infra::path_authority::FileWorkspaceHandle,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<i32, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "count_pgn_games")?;
    let cancellation = operation.token();
    let state = state.inner().clone();
    crate::infra::operations::run_native_operation(operation, "count_pgn_games", async move {
        count_workspace_games(&state, &file, &cancellation).await
    })
    .await
}

async fn count_workspace_games(
    state: &AppState,
    file: &crate::infra::path_authority::FileWorkspaceHandle,
    cancellation: &CancellationToken,
) -> Result<i32, Error> {
    let resolved = resolve_readable_pgn(state, file)?;
    count_pgn_games_core(resolved, cancellation, &state.pgn_repository).await
}

fn observe_count_hook(repository: &PgnRepository) -> Result<(), Error> {
    #[cfg(test)]
    if let Some(hook) = repository.count_hook()? {
        hook.notify_and_wait();
    }
    let _ = repository;
    Ok(())
}

pub(crate) const COUNT_LIMIT_MESSAGE: &str = "PGN count exceeds IPC limit";

fn count_after_scan(
    games: Arc<[GameRange]>,
    cancellation: &CancellationToken,
) -> Result<i32, Error> {
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    i32::try_from(games.len()).map_err(|_| Error::ResourceLimit(COUNT_LIMIT_MESSAGE.into()))
}

pub async fn count_pgn_games_core(
    resolved: crate::infra::path_authority::ResolvedPath,
    cancellation: &CancellationToken,
    repository: &PgnRepository,
) -> Result<i32, Error> {
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    observe_count_hook(repository)?;
    let (_, games) = scan_current(resolved.pgn_snapshot()?, repository, cancellation).await?;
    count_after_scan(games, cancellation)
}

pub(crate) fn count_pgn_games_core_blocking(
    snapshot: crate::infra::path_authority::PgnSnapshot,
    cancellation: &CancellationToken,
    repository: &PgnRepository,
) -> Result<i32, Error> {
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    observe_count_hook(repository)?;
    let (_, games) = scan_current_blocking(snapshot, repository, cancellation)?;
    count_after_scan(games, cancellation)
}

#[tauri::command]
#[specta::specta]
pub async fn read_games(
    file: crate::infra::path_authority::FileWorkspaceHandle,
    start: i32,
    end: i32,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<StampedGame>, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "read_games")?;
    let cancellation = operation.token();
    let repository = state.pgn_repository.clone();
    let resolved = resolve_pgn(
        &state,
        &file,
        crate::infra::path_authority::PathOperation::ReadPgn,
    )?;
    crate::infra::operations::run_native_operation(operation, "read_games", async move {
        read_games_core(resolved, start, end, &cancellation, &repository).await
    })
    .await
}

/// Returns a non-empty prefix of the requested range within `MAX_PAGE_BYTES`.
/// Callers continue at start + returned length; only the empty-file opening range returns empty.
/// An oversized first game returns one omission without reading its body.
pub async fn read_games_core(
    resolved: crate::infra::path_authority::ResolvedPath,
    start: i32,
    end: i32,
    cancellation: &CancellationToken,
    repository: &PgnRepository,
) -> Result<Vec<StampedGame>, Error> {
    let (start, count) = checked_range(start, end)?;
    let (key, omission, values) =
        scan_and_read_ranges(resolved, repository, cancellation, move |_, games| {
            let end = start
                .checked_add(count)
                .ok_or_else(|| Error::InvalidInput("game range overflows".into()))?;
            let requested = if games.is_empty() && start == 0 && count == 1 {
                Vec::new()
            } else {
                let requested = games
                    .get(start..end)
                    .ok_or_else(|| Error::InvalidInput("game index is out of bounds".into()))?;
                let mut total_bytes = 0_u64;
                let mut selected_len = 0;
                for (index, range) in requested.iter().enumerate() {
                    let bytes = range.byte_len()?;
                    if index == 0 && bytes > MAX_PGN_BYTES as u64 {
                        return Ok((Some(GameOmission::TooLarge), Vec::new()));
                    }
                    let Some(next_bytes) = total_bytes.checked_add(bytes) else {
                        break;
                    };
                    if index > 0 && next_bytes > MAX_PAGE_BYTES as u64 {
                        break;
                    }
                    total_bytes = next_bytes;
                    selected_len = index + 1;
                }
                requested[..selected_len].to_vec()
            };
            Ok((None, requested))
        })
        .await?;
    let revision = revision_string_for_key(&key);
    if let Some(omission) = omission {
        return Ok(vec![StampedGame {
            pgn: String::new(),
            stamp: String::new(),
            revision,
            present: true,
            omission: Some(omission),
            linked: None,
        }]);
    }
    Ok(values
        .into_iter()
        .map(|pgn| StampedGame {
            stamp: game_stamp(pgn.as_bytes()),
            pgn,
            revision: revision.clone(),
            present: true,
            omission: None,
            linked: None,
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn file_revision(
    file: crate::infra::path_authority::FileWorkspaceHandle,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<String, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "file_revision")?;
    let cancellation = operation.token();
    let resolved = resolve_pgn(
        &state,
        &file,
        crate::infra::path_authority::PathOperation::ReadPgn,
    )?;
    crate::infra::operations::run_native_operation(operation, "file_revision", async move {
        file_revision_core(resolved, &cancellation).await
    })
    .await
}

pub async fn file_revision_core(
    resolved: crate::infra::path_authority::ResolvedPath,
    cancellation: &CancellationToken,
) -> Result<String, Error> {
    BLOCKING_GATEWAY
        .spawn_cancellable(cancellation.clone(), move |_| {
            let snapshot = resolved.pgn_snapshot()?;
            Ok(revision_string(&snapshot))
        })
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn read_game(
    file: crate::infra::path_authority::FileWorkspaceHandle,
    n: i32,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<StampedGame, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "read_game")?;
    let cancellation = operation.token();
    let state = state.inner().clone();
    crate::infra::operations::run_native_operation(operation, "read_game", async move {
        read_workspace_game(&state, &file, n, &cancellation).await
    })
    .await
}

async fn read_workspace_game(
    state: &AppState,
    file: &crate::infra::path_authority::FileWorkspaceHandle,
    n: i32,
    cancellation: &CancellationToken,
) -> Result<StampedGame, Error> {
    let resolved = resolve_readable_pgn(state, file)?;
    let mut game = read_game_core(resolved, n, cancellation, &state.pgn_repository).await?;
    let authority = state.pgn_path_authority.clone();
    let file = file.clone();
    BLOCKING_GATEWAY
        .spawn_cancellable(cancellation.clone(), move |token| {
            authority.with_mut(|authority| authority.ensure_pgn_not_trashed(&file))??;
            if game.present {
                game.linked = crate::db::linked_collections::qualify_source(
                    &authority,
                    &file,
                    n,
                    &game.stamp,
                    &game.revision,
                    token,
                )?;
            }
            Ok(game)
        })
        .await
}

async fn read_game_core(
    resolved: crate::infra::path_authority::ResolvedPath,
    n: i32,
    cancellation: &CancellationToken,
    repository: &PgnRepository,
) -> Result<StampedGame, Error> {
    let n = checked_index(n)?;
    let (key, present, values) =
        scan_and_read_ranges(resolved, repository, cancellation, move |_key, games| {
            if n < games.len() {
                Ok((true, vec![games[n]]))
            } else if n == games.len() {
                Ok((false, Vec::new()))
            } else {
                Err(Error::InvalidInput("game index is out of bounds".into()))
            }
        })
        .await?;
    let pgn = if present {
        values
            .into_iter()
            .next()
            .ok_or_else(|| Error::Conflict("PGN read returned no selected game".into()))?
    } else {
        String::new()
    };
    Ok(StampedGame {
        stamp: game_stamp(pgn.as_bytes()),
        pgn,
        revision: revision_string_for_key(&key),
        present,
        omission: None,
        linked: None,
    })
}

async fn resolve_practice_before_mutation(
    resolved: &crate::infra::path_authority::ResolvedPath,
    repository: &PgnRepository,
    rebind: Option<&PgnCapabilityRebind>,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    let Some((directory, file_id)) = repository.practice_file(rebind)? else {
        return Ok(());
    };
    let check_directory = directory.clone();
    let check_id = file_id.clone();
    if !BLOCKING_GATEWAY
        .spawn(move || crate::practice::has_pending_delete(&check_directory, &check_id))
        .await?
    {
        return Ok(());
    }
    // The mutation's retained descriptor can predate a previous replacement. Recovery must
    // count the current authorized file even when that stale mutation will itself be refused.
    if let Some(binding) = rebind.cloned() {
        let current = BLOCKING_GATEWAY
            .spawn(move || binding.resolve_read())
            .await?;
        resolve_practice_pending_locked(&current, repository, directory, file_id, cancellation)
            .await
    } else {
        resolve_practice_pending_locked(resolved, repository, directory, file_id, cancellation)
            .await
    }
}

async fn resolve_practice_pending_locked(
    resolved: &crate::infra::path_authority::ResolvedPath,
    repository: &PgnRepository,
    directory: Arc<crate::infra::path_authority::AuthorizedDir>,
    file_id: String,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    let check_directory = directory.clone();
    let check_id = file_id.clone();
    let pending = BLOCKING_GATEWAY
        .spawn(move || crate::practice::has_pending_delete(&check_directory, &check_id))
        .await?;
    if !pending {
        return Ok(());
    }
    let (_, games) = scan_current(resolved.pgn_snapshot()?, repository, cancellation).await?;
    let count = games.len();
    let sync = resolved.pgn_publication_sync()?;
    BLOCKING_GATEWAY
        .spawn(move || {
            crate::practice::resolve_pending_delete_in(&directory, &file_id, count, sync)
        })
        .await
}

/// Practice recovery takes the same edit lock as content writers, before the map lock.
pub(crate) async fn resolve_practice_pending(
    authority: crate::infra::path_authority::SharedPathAuthority,
    file_id: String,
    repository: PgnRepository,
    directory: Arc<crate::infra::path_authority::AuthorizedDir>,
) -> Result<(), Error> {
    let practice_lock = repository.practice_edit_lock(file_id.clone())?;
    let _practice_guard = practice_lock.lock().await;
    let handle = crate::infra::path_authority::FileWorkspaceHandle::new(
        crate::infra::path_authority::PathRef {
            id: file_id.clone(),
        },
    );
    let mut rebind = PgnCapabilityRebind::new(authority.clone(), &handle);
    let (resolved, prepared) = BLOCKING_GATEWAY
        .spawn(move || {
            rebind.capture_binding()?;
            let resolved = rebind.resolve_read()?;
            Ok((resolved, rebind))
        })
        .await?;
    let identity = resolved.pgn_snapshot()?.identity;
    let lock = prepared.edit_lock(&repository, identity)?;
    let _guard = lock.lock().await;
    let resolved = BLOCKING_GATEWAY
        .spawn(move || prepared.resolve_read())
        .await?;
    resolve_practice_pending_locked(
        &resolved,
        &repository,
        directory,
        file_id,
        &CancellationToken::new(),
    )
    .await
}

struct PgnMutation {
    target: GameRange,
    replacement: Option<PgnReplacement>,
    expectation: Option<WriteExpectation>,
    stale_on_snapshot_change: bool,
    operation_name: &'static str,
    rebind: Option<PgnCapabilityRebind>,
}

enum PgnReplacement {
    Bytes(Vec<u8>),
    Stream(tempfile::NamedTempFile),
}

impl PgnReplacement {
    fn boundary_byte(&mut self, last: bool) -> Result<Option<u8>, Error> {
        match self {
            Self::Bytes(bytes) => Ok(if last { bytes.last() } else { bytes.first() }.copied()),
            Self::Stream(file) => {
                let size = file.as_file().metadata()?.len();
                if size == 0 {
                    return Ok(None);
                }
                file.as_file_mut()
                    .seek(SeekFrom::Start(if last { size - 1 } else { 0 }))?;
                let mut byte = [0];
                file.as_file_mut().read_exact(&mut byte)?;
                Ok(Some(byte[0]))
            }
        }
    }
    fn starts_with_newline(&mut self) -> Result<bool, Error> {
        Ok(self.boundary_byte(false)? == Some(b'\n'))
    }
    fn ends_with_newline(&mut self) -> Result<bool, Error> {
        Ok(self.boundary_byte(true)? == Some(b'\n'))
    }
    fn write_to(
        &mut self,
        target: &mut impl Write,
        cancellation: &CancellationToken,
    ) -> Result<(), Error> {
        match self {
            Self::Bytes(bytes) => {
                target.write_all(bytes)?;
            }
            Self::Stream(file) => {
                let size = file.as_file().metadata()?.len();
                copy_range(file.as_file_mut(), target, 0, size, cancellation)?;
            }
        }
        Ok(())
    }
}

/// One streamed bulk edit uses the same lock, snapshot check, replacement and committed-error
/// boundary as a single-game edit. Preparation never materializes the collection's PGN text.
pub(crate) async fn transform_file_core<T: Send + 'static>(
    resolved: crate::infra::path_authority::ResolvedPath,
    expected_revision: String,
    repository: PgnRepository,
    mut rebind: PgnCapabilityRebind,
    cancellation: CancellationToken,
    transform: impl FnOnce(
            &mut crate::infra::inode_ownership::OwnedFile,
            &[GameRange],
            &mut std::fs::File,
            &CancellationToken,
        ) -> Result<T, Error>
        + Send
        + 'static,
) -> Result<T, Error> {
    rebind.capture_binding()?;
    let practice_lock = repository.practice_mutation_lock(Some(&rebind))?;
    let _practice_guard = match &practice_lock {
        Some(lock) => Some(tokio::select! {
            guard = lock.lock() => guard,
            _ = cancellation.cancelled() => return Err(Error::Cancellation),
        }),
        None => None,
    };
    let snapshot = resolved.pgn_snapshot()?;
    let lock = rebind.edit_lock(&repository, snapshot.identity.clone())?;
    #[cfg(test)]
    repository.notify_edit_lock_wait()?;
    let _guard = tokio::select! {
        guard = lock.lock() => guard,
        _ = cancellation.cancelled() => return Err(Error::Cancellation),
    };
    rebind.validate_binding()?;
    resolve_practice_before_mutation(&resolved, &repository, Some(&rebind), &cancellation).await?;
    let scan_repository = repository.clone();
    let (key, replacement, value, unchanged) = BLOCKING_GATEWAY
        .spawn_cancellable(cancellation.clone(), move |token| {
            if revision_string(&snapshot) != expected_revision {
                return Err(Error::StaleGame);
            }
            let mut source = snapshot.file.try_clone()?;
            let (key, ranges) = scan_current_blocking(snapshot, &scan_repository, token)?;
            let mut replacement = tempfile::NamedTempFile::new()?;
            let value = transform(&mut source, &ranges, replacement.as_file_mut(), token)?;
            let mut unchanged = replacement.as_file().metadata()?.len() == key.revision.size;
            if unchanged {
                source.seek(SeekFrom::Start(0))?;
                replacement.as_file_mut().seek(SeekFrom::Start(0))?;
                let mut left = [0u8; 64 * 1024];
                let mut right = [0u8; 64 * 1024];
                let mut remaining = key.revision.size;
                while remaining > 0 {
                    if token.is_cancelled() {
                        return Err(Error::Cancellation);
                    }
                    let count = remaining.min(left.len() as u64) as usize;
                    source.read_exact(&mut left[..count])?;
                    replacement.as_file_mut().read_exact(&mut right[..count])?;
                    if left[..count] != right[..count] {
                        unchanged = false;
                        break;
                    }
                    remaining -= count as u64;
                }
            }
            Ok((key, replacement, value, unchanged))
        })
        .await?;
    if unchanged {
        rebind.validate_binding()?;
        if snapshot_key(&resolved.pgn_snapshot()?) != key {
            return Err(Error::StaleGame);
        }
        return Ok(value);
    }
    let size = key.revision.size;
    commit_pgn_mutation(
        resolved,
        key,
        PgnMutation {
            target: GameRange {
                start: 0,
                end: size,
            },
            replacement: Some(PgnReplacement::Stream(replacement)),
            expectation: None,
            stale_on_snapshot_change: true,
            operation_name: "transform_file",
            rebind: Some(rebind),
        },
        &repository,
        &cancellation,
    )
    .await?;
    Ok(value)
}

async fn commit_pgn_mutation(
    resolved: crate::infra::path_authority::ResolvedPath,
    key: CacheKey,
    mutation: PgnMutation,
    repository: &PgnRepository,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    let PgnMutation {
        target,
        replacement,
        expectation,
        stale_on_snapshot_change,
        operation_name,
        rebind,
    } = mutation;
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    let commit_snapshot = resolved.pgn_snapshot()?;
    if snapshot_key(&commit_snapshot) != key {
        return Err(if stale_on_snapshot_change {
            Error::StaleGame
        } else {
            Error::Conflict("PGN changed after scan".into())
        });
    }
    if let Some(expectation) = expectation {
        if let WriteExpectation::LinkedGame { revision, .. } = &expectation {
            if let Some(rebind) = &rebind {
                rebind.validate_linked_source()?;
            }
            if *revision != revision_string_for_key(&key) {
                return Err(Error::StaleGame);
            }
        }
        let matched = match expectation {
            WriteExpectation::Append => {
                target.start == key.revision.size && target.end == key.revision.size
            }
            WriteExpectation::Game { stamp } | WriteExpectation::LinkedGame { stamp, .. } => {
                let mut file = commit_snapshot.file.try_clone()?;
                let range = target;
                let replacing = replacement.is_some();
                BLOCKING_GATEWAY
                    .spawn_cancellable(cancellation.clone(), move |token| {
                        let bytes = read_range_bytes(&mut file, range, token)?;
                        if game_stamp(&bytes) != stamp {
                            return Err(Error::StaleGame);
                        }
                        if replacing && !bytes.is_empty() {
                            refuse_multi_game_range(&bytes)?;
                        }
                        Ok(())
                    })
                    .await?;
                true
            }
        };
        if !matched {
            return Err(Error::StaleGame);
        }
    }
    let identity = key.identity.clone();
    let collection_rebind = rebind.clone();
    #[cfg(test)]
    let edit_hook = repository.edit_worker_hook()?;
    #[cfg(test)]
    let atomic_injector = repository.atomic_file_injector()?;

    let edit_result = BLOCKING_GATEWAY
        .spawn_cancellable(cancellation.clone(), move |token| {
            #[cfg(test)]
            if let Some(ref hook) = edit_hook {
                hook.notify_and_wait();
            }
            #[cfg(test)]
            let _injector_guard =
                atomic_injector.map(crate::infra::fs::install_test_atomic_file_injector);
            if let Some(rebind) = &rebind {
                rebind.validate_binding()?;
            }
            let installed = edit_existing(
                &resolved,
                key.clone(),
                commit_snapshot,
                target,
                replacement,
                token,
            )?;
            let rebind_result =
                rebind.map(|rebind| rebind.after_replace(key.identity.pair(), installed.identity));
            Ok((installed, rebind_result))
        })
        .await;

    let (installed, rebind_result) = match edit_result {
        Ok(result) => result,
        Err(err) => return Err(err),
    };
    let pgn_outcome = crate::infra::fs::require_durable(
        installed.outcome,
        crate::error::DurabilityStage::PgnEdit,
    );
    // Every failure from here on happens after the replacement was installed, so it is reported
    // as a committed-but-uncertain write: a raw rebind or cache error would tell the renderer the
    // game was not written, and a Save-As would then drop the "may have been written" notice.
    let rebind_outcome = rebind_result.unwrap_or(Ok(())).map_err(|error| {
        log::warn!(
            "{operation_name} capability rebind failed after replacing file {:?}: {error}",
            identity.pair()
        );
        Error::CommittedDurabilityUncertain(crate::error::DurabilityStage::PgnCapabilityRebind)
    });
    let edit_outcome = pgn_outcome.and(rebind_outcome);

    if let Err(invalidation_error) = repository.invalidate(&identity) {
        log::warn!(
            "{operation_name} cache invalidation failed for file {:?}: {invalidation_error}",
            identity.pair()
        );
        if edit_outcome.is_ok() {
            return Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::PgnCacheInvalidation,
            ));
        }
    }

    if let Some(rebind) = collection_rebind {
        let refresh = BLOCKING_GATEWAY
            .spawn_cancellable(CancellationToken::new(), move |token| {
                if let Some(service) = rebind.authority.collections()? {
                    service.refresh_source(
                        &rebind.authority,
                        &crate::infra::path_authority::FileWorkspaceHandle::new(rebind.path_ref),
                        token,
                    )?;
                }
                Ok(())
            })
            .await;
        if let Err(error) = refresh {
            log::warn!(
                "collection index refresh failed after PGN publication: {}",
                error.diagnostic()
            );
            edit_outcome?;
            return Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::CollectionIndexRefresh,
            ));
        }
    }
    edit_outcome
}

#[tauri::command]
#[specta::specta]
pub async fn delete_game(
    file: crate::infra::path_authority::FileWorkspaceHandle,
    n: i32,
    stamp: String,
    revision: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    crate::infra::platform_support::off_unix_refusal("PGN atomic replacement", cfg!(unix))?;
    let lease = state.operations.accept("delete_game")?;
    let resolved = resolve_pgn(
        &state,
        &file,
        crate::infra::path_authority::PathOperation::WritePgn,
    )?;
    let repository = state.pgn_repository.clone();
    let rebind = PgnCapabilityRebind::new(state.pgn_path_authority.clone(), &file);
    delete_game_core(
        lease,
        resolved,
        n,
        stamp,
        revision,
        repository,
        Some(rebind),
    )
    .await
}

pub async fn delete_game_core(
    lease: OperationLease,
    resolved: crate::infra::path_authority::ResolvedPath,
    n: i32,
    expected_stamp: String,
    expected_revision: String,
    repository: PgnRepository,
    mut rebind: Option<PgnCapabilityRebind>,
) -> Result<(), Error> {
    let cancellation = lease.token();
    crate::infra::operations::run_native_operation(lease, "delete_game", async move {
        if let Some(rebind) = &mut rebind {
            rebind.capture_binding()?;
        }
        let practice_lock = repository.practice_mutation_lock(rebind.as_ref())?;
        let _practice_guard = match &practice_lock {
            Some(lock) => Some(tokio::select! {
                guard = lock.lock() => guard,
                _ = cancellation.cancelled() => return Err(Error::Cancellation),
            }),
            None => None,
        };
        let n = checked_index(n)?;
        let scan_snapshot = resolved.pgn_snapshot()?;
        let identity = scan_snapshot.identity.clone();
        let lock = if let Some(rebind) = &rebind {
            rebind.edit_lock(&repository, identity.clone())?
        } else {
            repository.edit_lock(identity.clone())?
        };
        #[cfg(test)]
        repository.notify_edit_lock_wait()?;
        let _guard = tokio::select! {
            guard = lock.lock() => guard,
            _ = cancellation.cancelled() => return Err(Error::Cancellation),
        };
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        resolve_practice_before_mutation(&resolved, &repository, rebind.as_ref(), &cancellation)
            .await?;
        let (key, games) = scan_current(scan_snapshot, &repository, &cancellation).await?;
        if revision_string_for_key(&key) != expected_revision {
            return Err(Error::StaleGame);
        }
        let range = games.get(n).cloned().ok_or(Error::StaleGame)?;
        let practice = repository.practice_file(rebind.as_ref())?;
        let pending_id = if let Some((directory, file_id)) = &practice {
            let directory = directory.clone();
            let file_id = file_id.clone();
            let count = games.len();
            Some(
                BLOCKING_GATEWAY
                    .spawn(move || {
                        crate::practice::prepare_delete_in(&directory, &file_id, n, count)
                    })
                    .await?,
            )
        } else {
            None
        };
        let result = commit_pgn_mutation(
            resolved,
            key,
            PgnMutation {
                target: range,
                replacement: None,
                expectation: Some(WriteExpectation::Game {
                    stamp: expected_stamp,
                }),
                stale_on_snapshot_change: true,
                operation_name: "delete_game",
                rebind,
            },
            &repository,
            &cancellation,
        )
        .await;
        if let (Some((directory, file_id)), Some(pending_id)) = (practice, pending_id) {
            let landed = match &result {
                Ok(()) => Some(true),
                Err(Error::CommittedDurabilityUncertain(
                    crate::error::DurabilityStage::PgnEdit,
                )) => None,
                Err(Error::CommittedDurabilityUncertain(_)) => Some(true),
                Err(_) => Some(false),
            };
            if let Some(landed) = landed {
                if let Err(error) = BLOCKING_GATEWAY
                    .spawn(move || {
                        crate::practice::finish_delete_in(&directory, &file_id, &pending_id, landed)
                    })
                    .await
                {
                    if landed {
                        log::warn!(
                            "practice delete finalization failed: {}",
                            error.diagnostic()
                        );
                        return Err(Error::CommittedDurabilityUncertain(
                            crate::error::DurabilityStage::PracticeState,
                        ));
                    }
                    return Err(error);
                }
            }
        }
        result
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn write_game(
    file: crate::infra::path_authority::FileWorkspaceHandle,
    n: i32,
    pgn: String,
    expected: WriteExpectation,
    state: tauri::State<'_, AppState>,
) -> Result<WriteStamp, Error> {
    crate::infra::platform_support::off_unix_refusal("PGN atomic replacement", cfg!(unix))?;
    let lease = state.operations.accept("write_game")?;
    if matches!(&expected, WriteExpectation::Game { .. })
        && state
            .pgn_path_authority
            .collections()?
            .map(|service| service.contains_source(&file))
            .transpose()?
            .unwrap_or(false)
    {
        return Err(Error::StaleGame);
    }
    let resolved = resolve_pgn(
        &state,
        &file,
        crate::infra::path_authority::PathOperation::WritePgn,
    )?;
    let repository = state.pgn_repository.clone();
    let rebind = PgnCapabilityRebind::new(state.pgn_path_authority.clone(), &file);
    write_game_core(lease, resolved, n, pgn, expected, repository, Some(rebind)).await
}

pub async fn write_game_core(
    lease: OperationLease,
    resolved: crate::infra::path_authority::ResolvedPath,
    n: i32,
    pgn: String,
    expected: WriteExpectation,
    repository: PgnRepository,
    mut rebind: Option<PgnCapabilityRebind>,
) -> Result<WriteStamp, Error> {
    let cancellation = lease.token();
    crate::infra::operations::run_native_operation(lease, "write_game", async move {
        if let Some(rebind) = &mut rebind {
            rebind.capture_binding()?;
        }
        let practice_lock = repository.practice_mutation_lock(rebind.as_ref())?;
        let _practice_guard = match &practice_lock {
            Some(lock) => Some(tokio::select! {
                guard = lock.lock() => guard,
                _ = cancellation.cancelled() => return Err(Error::Cancellation),
            }),
            None => None,
        };
        let game_number = n;
        let n = checked_index(n)?;
        if pgn.len() > MAX_PGN_BYTES {
            return Err(Error::ResourceLimit(
                "replacement PGN exceeds 10 MiB".into(),
            ));
        }
        // Validate text before creating a replacement; malformed UTF-8 cannot enter through String.
        let replacement = pgn.as_bytes().to_vec();
        let scan_snapshot = resolved.pgn_snapshot()?;
        let identity = scan_snapshot.identity.clone();
        let lock = if let Some(rebind) = &rebind {
            rebind.edit_lock(&repository, identity.clone())?
        } else {
            repository.edit_lock(identity.clone())?
        };
        #[cfg(test)]
        repository.notify_edit_lock_wait()?;
        let _guard = tokio::select! {
            guard = lock.lock() => guard,
            _ = cancellation.cancelled() => return Err(Error::Cancellation),
        };
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        resolve_practice_before_mutation(&resolved, &repository, rebind.as_ref(), &cancellation)
            .await?;
        let (key, games) = scan_current(scan_snapshot, &repository, &cancellation).await?;
        let target = if let Some(range) = games.get(n).cloned() {
            range
        } else if n == games.len() {
            GameRange {
                start: key.revision.size,
                end: key.revision.size,
            }
        } else {
            return Err(Error::InvalidInput("game index is out of bounds".into()));
        };
        let readback_capability = rebind.clone();
        commit_pgn_mutation(
            resolved,
            key,
            PgnMutation {
                target,
                replacement: Some(PgnReplacement::Bytes(replacement)),
                expectation: Some(expected),
                stale_on_snapshot_change: false,
                operation_name: "write_game",
                rebind,
            },
            &repository,
            &cancellation,
        )
        .await?;

        #[cfg(test)]
        if let Some(hook) = repository.post_commit_hook()? {
            hook.notify_and_wait();
        }

        let (stamp, revision, linked) = if let Some(rebind) = readback_capability {
            if let Ok(readback_path) = rebind.resolve_read() {
                match read_game_core(readback_path, game_number, &cancellation, &repository).await {
                    Ok(readback) if readback.pgn.trim() == pgn.trim() => {
                        let authority = rebind.authority.clone();
                        let file = crate::infra::path_authority::FileWorkspaceHandle::new(
                            rebind.path_ref.clone(),
                        );
                        let stamped = readback.clone();
                        match BLOCKING_GATEWAY
                            .spawn_cancellable(cancellation.clone(), move |token| {
                                crate::db::linked_collections::qualify_source(
                                    &authority,
                                    &file,
                                    game_number,
                                    &stamped.stamp,
                                    &stamped.revision,
                                    token,
                                )
                            })
                            .await
                        {
                            Ok(linked) => (Some(readback.stamp), Some(readback.revision), linked),
                            Err(_) => (None, None, None),
                        }
                    }
                    _ => (None, None, None),
                }
            } else {
                (None, None, None)
            }
        } else {
            (None, None, None)
        };
        Ok(WriteStamp {
            stamp,
            revision,
            linked,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[tokio::test]
    async fn practice_decks_follow_native_delete_and_recover_uncertain_publication() {
        use crate::infra::path_authority::{
            ensure_app_owned_default_dir, AppDataDir, AppOwnedDefaultRoot, PathAuthority,
            PathOperation,
        };
        for uncertain in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("practice.pgn");
            std::fs::write(
                &path,
                "[Event \"White\"]\n\n1. e4 *\n\n[Event \"Black\"]\n\n1. d4 *\n",
            )
            .unwrap();
            let mut authority =
                PathAuthority::open(directory.path().join("registry.json"), vec![]).unwrap();
            let handle = promote_pgn_file(&mut authority, &path);
            let app = mock_app();
            let state = app.state::<AppState>();
            state.pgn_path_authority.install(authority).unwrap();
            let practice = ensure_app_owned_default_dir(
                &AppDataDir::for_test(directory.path()),
                AppOwnedDefaultRoot::Practice,
            )
            .unwrap();
            let file_id = handle.path_ref().id.clone();
            for number in [0, 1] {
                crate::practice::sync_practice_positions_in(
                    &practice,
                    &file_id,
                    number,
                    0,
                    0,
                    r#"{"positions":[{"fen":"start"}]}"#,
                )
                .unwrap();
                crate::practice::record_practice_review_in(
                    &practice,
                    &file_id,
                    number,
                    0,
                    1,
                    1,
                    r#"{"positions":[{"fen":"start"}]}"#,
                    r#"{"fen":"start","rating":3}"#,
                    "review",
                )
                .unwrap();
            }
            let expected = crate::practice::load_practice_deck_in(&practice, &file_id, 1)
                .unwrap()
                .unwrap();
            let reviews =
                crate::practice::load_practice_reviews_in(&practice, &file_id, 1, None, 100)
                    .unwrap();
            state.pgn_repository.initialize_practice(practice).unwrap();
            let practice = state
                .pgn_repository
                .inner()
                .unwrap()
                .practice_directory
                .clone()
                .unwrap();
            let selected = read_game_core(
                resolve_pgn(&state, &handle, PathOperation::ReadPgn).unwrap(),
                0,
                &CancellationToken::new(),
                &state.pgn_repository,
            )
            .await
            .unwrap();
            let refused = delete_through_capability(
                &app,
                &handle,
                0,
                "wrong stamp".into(),
                selected.revision.clone(),
            )
            .await;
            assert!(matches!(refused, Err(Error::StaleGame)));
            assert_eq!(
                crate::practice::practice_epoch_in(&practice, &file_id, 0)
                    .unwrap()
                    .epoch,
                "no-map"
            );
            if uncertain {
                state
                    .pgn_repository
                    .set_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
                        "practice delete",
                    ))))
                    .unwrap();
            }
            let result =
                delete_through_capability(&app, &handle, 0, selected.stamp, selected.revision)
                    .await;
            if uncertain {
                assert!(
                    matches!(
                        result,
                        Err(Error::CommittedDurabilityUncertain(
                            crate::error::DurabilityStage::PgnEdit
                        ))
                    ),
                    "{result:?}"
                );
                assert!(crate::practice::has_pending_delete(&practice, &file_id).unwrap());
                state.pgn_repository.set_atomic_file_injector(None).unwrap();
                resolve_practice_pending(
                    state.pgn_path_authority.clone(),
                    file_id.clone(),
                    state.pgn_repository.clone(),
                    practice.clone(),
                )
                .await
                .unwrap();
            } else {
                result.unwrap();
            }
            let loaded =
                crate::practice::load_mapped_practice_deck_in(&practice, &file_id, 0).unwrap();
            assert_eq!(loaded.deck.unwrap(), expected);
            assert_ne!(loaded.epoch, "no-map");
            assert_eq!(
                crate::practice::load_practice_reviews_in(&practice, &file_id, 1, None, 100)
                    .unwrap(),
                reviews
            );
            assert!(
                crate::practice::load_practice_deck_in(&practice, &file_id, 0)
                    .unwrap()
                    .is_none()
            );
            let inventory = crate::practice::list_practice_decks_in(&practice).unwrap();
            assert_eq!(
                inventory.decks,
                vec![crate::practice::PracticeDeckIdentity { file_id, game: 0 }]
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn every_content_mutation_resolves_pending_before_it_can_change_count() {
        use crate::infra::path_authority::{
            ensure_app_owned_default_dir, AppDataDir, AppOwnedDefaultRoot, PathAuthority,
            PathOperation,
        };
        for append_expectation in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("practice.pgn");
            std::fs::write(&path, "[Event \"White\"]\n\n1. e4 *\n").unwrap();
            let mut authority =
                PathAuthority::open(directory.path().join("registry.json"), vec![]).unwrap();
            let handle = promote_pgn_file(&mut authority, &path);
            let app = mock_app();
            let state = app.state::<AppState>();
            state.pgn_path_authority.install(authority).unwrap();
            let practice = ensure_app_owned_default_dir(
                &AppDataDir::for_test(directory.path()),
                AppOwnedDefaultRoot::Practice,
            )
            .unwrap();
            let file_id = handle.path_ref().id.clone();
            crate::practice::prepare_delete_in(&practice, &file_id, 0, 1).unwrap();
            state.pgn_repository.initialize_practice(practice).unwrap();
            let practice = state
                .pgn_repository
                .inner()
                .unwrap()
                .practice_directory
                .clone()
                .unwrap();
            // A rename and an in-place edit change the revision while keeping count evidence.
            let renamed = directory.path().join("renamed.pgn");
            std::fs::rename(&path, &renamed).unwrap();
            std::fs::rename(&renamed, &path).unwrap();
            std::fs::write(&path, "[Event \"Edited\"]\n\n1. d4 *\n").unwrap();
            write_through_capability(&app, &handle, 0, "[Event \"Saved\"]\n\n1. e4 *\n".into())
                .await
                .unwrap();
            assert!(!crate::practice::has_pending_delete(&practice, &file_id).unwrap());
            assert_eq!(
                crate::practice::practice_epoch_in(&practice, &file_id, 0)
                    .unwrap()
                    .epoch,
                "no-map"
            );
            crate::practice::prepare_delete_in(&practice, &file_id, 0, 1).unwrap();
            if append_expectation {
                append_through_capability(
                    &app,
                    &handle,
                    1,
                    "[Event \"Append\"]\n\n1. c4 *\n".into(),
                )
                .await
                .unwrap();
            } else {
                write_through_capability(
                    &app,
                    &handle,
                    1,
                    "[Event \"End save\"]\n\n1. c4 *\n".into(),
                )
                .await
                .unwrap();
            }
            assert!(!crate::practice::has_pending_delete(&practice, &file_id).unwrap());
            assert_eq!(
                crate::practice::practice_epoch_in(&practice, &file_id, 0)
                    .unwrap()
                    .epoch,
                "no-map"
            );
            let saved = read_game_core(
                resolve_pgn(&state, &handle, PathOperation::ReadPgn).unwrap(),
                0,
                &CancellationToken::new(),
                &state.pgn_repository,
            )
            .await
            .unwrap();
            // A present but malformed map fails closed, including for ordinary saves.
            for entry in std::fs::read_dir(practice.path()).unwrap() {
                let entry = entry.unwrap();
                if entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with("-deck-map.json")
                {
                    std::fs::write(entry.path(), b"{damaged").unwrap();
                }
            }
            let before = std::fs::read(&path).unwrap();
            assert!(matches!(
                write_through_capability(&app, &handle, 0, saved.pgn.clone()).await,
                Err(Error::InvalidInput(_))
            ));
            assert!(matches!(
                append_through_capability(&app, &handle, 2, saved.pgn.clone()).await,
                Err(Error::InvalidInput(_))
            ));
            let resolved = resolve_pgn(&state, &handle, PathOperation::WritePgn).unwrap();
            let transformed = transform_file_core(
                resolved,
                saved.revision.clone(),
                state.pgn_repository.clone(),
                PgnCapabilityRebind::new(state.pgn_path_authority.clone(), &handle),
                CancellationToken::new(),
                |_, _, _, _| -> Result<(), Error> {
                    panic!("damaged map must refuse before transform")
                },
            )
            .await;
            assert!(matches!(transformed, Err(Error::InvalidInput(_))));
            assert!(matches!(
                delete_through_capability(&app, &handle, 0, saved.stamp, saved.revision).await,
                Err(Error::InvalidInput(_))
            ));
            assert_eq!(std::fs::read(&path).unwrap(), before);
        }
    }

    #[cfg(not(unix))]
    #[tokio::test]
    async fn delete_command_platform_refusal_preserves_practice_state() {
        use crate::infra::path_authority::{
            ensure_app_owned_default_dir, AppDataDir, AppOwnedDefaultRoot, FileWorkspaceHandle,
            PathRef,
        };
        let directory = tempfile::tempdir().unwrap();
        let practice = ensure_app_owned_default_dir(
            &AppDataDir::for_test(directory.path()),
            AppOwnedDefaultRoot::Practice,
        )
        .unwrap();
        crate::practice::sync_practice_positions_in(
            &practice,
            "file",
            0,
            0,
            0,
            r#"{"positions":[]}"#,
        )
        .unwrap();
        let pending = crate::practice::prepare_delete_in(&practice, "file", 0, 1).unwrap();
        crate::practice::finish_delete_in(&practice, "file", &pending, false).unwrap();
        let before = std::fs::read_dir(practice.path())
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                (entry.file_name(), std::fs::read(entry.path()).unwrap())
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        let app = mock_app();
        let result = delete_game(
            FileWorkspaceHandle::new(PathRef { id: "file".into() }),
            0,
            "stamp".into(),
            "revision".into(),
            app.state::<AppState>(),
        )
        .await;
        assert!(matches!(result, Err(Error::Conflict(_))));
        let after = std::fs::read_dir(practice.path())
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                (entry.file_name(), std::fs::read(entry.path()).unwrap())
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(before, after);
    }
    use super::*;
    use std::{
        io::{BufWriter, Cursor},
        path::Path,
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };
    use tauri::Manager;

    #[tokio::test]
    #[cfg(unix)]
    async fn trash_count_and_read_refuse_linked_and_unlinked_files_then_restore() {
        use crate::{
            db::linked_collections::{tests::Fixture, CollectionStatus},
            error::ErrorCategory,
            file_workspace::{restore_entry, trash_entry, WorkspaceFileType},
        };

        for purpose in [WorkspaceFileType::Game, WorkspaceFileType::Repertoire] {
            let fixture = Fixture::new();
            let file = fixture.create("games", "*", purpose.clone());
            let collections = fixture.list();
            if purpose == WorkspaceFileType::Game {
                assert_eq!(collections.len(), 1);
                assert_eq!(collections[0].file, file);
                assert_eq!(collections[0].status, CollectionStatus::Ready);
            } else {
                assert!(collections.is_empty());
            }
            let token = CancellationToken::new();
            let state = &fixture.state;
            assert_eq!(
                count_workspace_games(state, &file, &token).await.unwrap(),
                1
            );
            let original = read_workspace_game(state, &file, 0, &token).await.unwrap();
            assert!(original.present);
            assert_eq!(
                original.linked.is_some(),
                purpose == WorkspaceFileType::Game
            );

            let _trash_item = trash_entry(
                &state.pgn_path_authority,
                &state.workspace_mutation,
                &fixture.workspace,
                &file,
                &token,
            )
            .unwrap();
            let collections = fixture.list();
            if purpose == WorkspaceFileType::Game {
                assert_eq!(collections[0].status, CollectionStatus::Trashed);
            } else {
                assert!(collections.is_empty());
            }
            let count_error = count_workspace_games(state, &file, &token)
                .await
                .unwrap_err();
            let read_error = read_workspace_game(state, &file, 0, &token)
                .await
                .unwrap_err();
            for error in [count_error, read_error] {
                assert!(matches!(error, Error::FileTrashed), "{error:?}");
                let payload = error.renderer_payload();
                assert_eq!(payload.category, ErrorCategory::MissingResource);
                assert_eq!(payload.message, "The file was moved to the trash");
            }

            restore_entry(
                &state.pgn_path_authority,
                &state.workspace_mutation,
                &fixture.workspace,
                &file,
                &token,
            )
            .unwrap();
            let collections = fixture.list();
            if purpose == WorkspaceFileType::Game {
                assert_eq!(collections[0].status, CollectionStatus::Ready);
            } else {
                assert!(collections.is_empty());
            }
            assert_eq!(
                count_workspace_games(state, &file, &token).await.unwrap(),
                1
            );
            let restored = read_workspace_game(state, &file, 0, &token).await.unwrap();
            assert_eq!(restored.pgn, original.pgn);
            assert_eq!(restored.stamp, original.stamp);
            assert_eq!(restored.linked.is_some(), original.linked.is_some());
        }
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn trash_after_read_before_qualification_returns_not_found() {
        use crate::{
            db::linked_collections::tests::Fixture,
            error::ErrorCategory,
            file_workspace::{trash_entry, WorkspaceFileType},
        };

        for purpose in [WorkspaceFileType::Game, WorkspaceFileType::Repertoire] {
            let fixture = Fixture::new();
            let file = fixture.create("games", "1. e4 *", purpose.clone());
            let collections = fixture.list();
            assert_eq!(
                collections.len(),
                usize::from(purpose == WorkspaceFileType::Game)
            );
            let token = CancellationToken::new();
            let original = read_workspace_game(&fixture.state, &file, 0, &token)
                .await
                .unwrap();
            assert_eq!(
                original.linked.is_some(),
                purpose == WorkspaceFileType::Game
            );

            let authority = fixture.state.pgn_path_authority.clone();
            let mutation = Arc::clone(&fixture.state.workspace_mutation);
            let workspace = fixture.workspace.clone();
            let hook_file = file.clone();
            let attempts = Arc::new(AtomicUsize::new(0));
            let hook_attempts = Arc::clone(&attempts);
            fixture
                .state
                .pgn_repository
                .set_read_attempt_action(Some(Arc::new(move || {
                    // The bytes have been read and the entry guard has already passed.
                    // Rename changes ctime, so let the snapshot retry after this one move.
                    if hook_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                        let _trash_item = trash_entry(
                            &authority,
                            &mutation,
                            &workspace,
                            &hook_file,
                            &CancellationToken::new(),
                        )
                        .unwrap();
                    }
                })))
                .unwrap();

            let result = read_workspace_game(&fixture.state, &file, 0, &token).await;
            fixture
                .state
                .pgn_repository
                .set_read_attempt_action(None)
                .unwrap();
            assert!(attempts.load(Ordering::SeqCst) > 0, "read hook did not run");
            assert!(!fixture.path("games").exists());
            let error = result.unwrap_err();
            assert!(matches!(error, Error::FileTrashed), "{error:?}");
            let payload = error.renderer_payload();
            assert_eq!(payload.category, ErrorCategory::MissingResource);
            assert_eq!(payload.message, "The file was moved to the trash");
        }
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn trash_directory_descendant_reads_fail_then_restore() {
        use crate::{
            db::linked_collections::tests::Fixture,
            file_workspace::{restore_entry, trash_entry},
            infra::path_authority::{opened_file_identity, PathOperation},
        };

        let fixture = Fixture::new();
        let folder_path = fixture.directory.path().join("library/folder");
        std::fs::create_dir(&folder_path).unwrap();
        let file_path = folder_path.join("child.pgn");
        std::fs::write(&file_path, "*").unwrap();
        let (folder, file) = fixture
            .state
            .pgn_path_authority
            .with_mut(|authority| {
                let mut register = |parts: &[&str], path: &Path, is_dir| {
                    authority.register_workspace_child_observed(
                        &fixture.workspace,
                        &parts
                            .iter()
                            .map(std::ffi::OsString::from)
                            .collect::<Vec<_>>(),
                        "fixture",
                        opened_file_identity(&File::open(path)?)?,
                        is_dir,
                        PathOperation::ReadPgn,
                    )
                };
                let folder = register(&["folder"], &folder_path, true)?;
                let file = register(&["folder", "child.pgn"], &file_path, false)?;
                Ok::<_, Error>((folder, file))
            })
            .unwrap()
            .unwrap();
        let state = &fixture.state;
        let token = CancellationToken::new();
        assert_eq!(
            count_workspace_games(state, &file, &token).await.unwrap(),
            1
        );
        let _trash_item = trash_entry(
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &fixture.workspace,
            &folder,
            &token,
        )
        .unwrap();
        assert!(matches!(
            count_workspace_games(state, &file, &token).await,
            Err(Error::FileTrashed)
        ));
        assert!(matches!(
            read_workspace_game(state, &file, 0, &token).await,
            Err(Error::FileTrashed)
        ));
        restore_entry(
            &state.pgn_path_authority,
            &state.workspace_mutation,
            &fixture.workspace,
            &folder,
            &token,
        )
        .unwrap();
        assert_eq!(
            count_workspace_games(state, &file, &token).await.unwrap(),
            1
        );
        assert!(
            read_workspace_game(state, &file, 0, &token)
                .await
                .unwrap()
                .present
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn trash_guard_preserves_genuine_stale_game_qualification() {
        use crate::{
            db::linked_collections::{qualify_source, tests::Fixture, CollectionStatus},
            file_workspace::WorkspaceFileType,
        };

        let fixture = Fixture::new();
        let file = fixture.create("games", "1. e4 *", WorkspaceFileType::Game);
        let collections = fixture.list();
        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].file, file);
        assert_eq!(collections[0].status, CollectionStatus::Ready);
        let token = CancellationToken::new();
        let original = read_workspace_game(&fixture.state, &file, 0, &token)
            .await
            .unwrap();
        assert!(original.linked.is_some());
        std::fs::write(fixture.path("games"), "1. d4 d5 2. c4 *").unwrap();
        let error = qualify_source(
            &fixture.state.pgn_path_authority,
            &file,
            0,
            &original.stamp,
            &original.revision,
            &token,
        )
        .unwrap_err();
        assert!(matches!(error, Error::StaleGame));
        assert_eq!(error.category(), crate::error::ErrorCategory::StaleGame);
        assert!(read_workspace_game(&fixture.state, &file, 0, &token)
            .await
            .unwrap()
            .linked
            .is_some());
    }

    #[tokio::test]
    async fn bounded_hook_only_waits_for_its_first_invocation() {
        let (hook, entered, release) = BoundedHook::new();
        let (first_done_tx, first_done_rx) = std::sync::mpsc::sync_channel(1);
        let first_hook = hook.clone();
        let first = std::thread::spawn(move || {
            first_hook.notify_and_wait();
            first_done_tx.send(()).expect("first invocation completed");
        });
        tokio::time::timeout(Duration::from_secs(2), entered)
            .await
            .expect("first invocation entry timeout")
            .expect("first invocation entered");

        let (later_done_tx, later_done_rx) = std::sync::mpsc::sync_channel(1);
        let later = std::thread::spawn(move || {
            hook.notify_and_wait();
            later_done_tx.send(()).expect("later invocation completed");
        });
        // A later invocation must finish while the first still owns the release handshake.
        let later_result = later_done_rx.recv_timeout(Duration::from_secs(2));
        let first_before_release = first_done_rx.try_recv();
        release.send(()).expect("release only the first invocation");
        first.join().expect("join first invocation");
        later.join().expect("join later invocation");

        later_result.expect("later invocation must not wait for another release");
        assert!(matches!(
            first_before_release,
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        first_done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("first invocation finishes after its release");
    }

    fn resolved_for(
        directory: &tempfile::TempDir,
        path: &Path,
    ) -> crate::infra::path_authority::ResolvedPath {
        let mut authority = crate::infra::path_authority::PathAuthority::open(
            directory.path().join("registry.json"),
            vec![],
        )
        .expect("open path authority");
        let descriptor = authority
            .create_pgn_export_destination(path, "test PGN")
            .expect("register PGN");
        authority
            .resolve(
                descriptor.handle.path_ref(),
                crate::infra::path_authority::PathOperation::ReadPgn,
                &[],
            )
            .expect("resolve PGN")
    }

    fn snapshot_for(
        directory: &tempfile::TempDir,
        path: &Path,
    ) -> crate::infra::path_authority::PgnSnapshot {
        resolved_for(directory, path)
            .pgn_snapshot()
            .expect("snapshot PGN")
    }

    #[cfg(test)]
    fn rewrite_padded_pgn(path: &Path, attempts: &AtomicUsize) -> usize {
        let count = attempts.fetch_add(1, Ordering::SeqCst) + 1;
        std::fs::write(
            path,
            format!("[Event \"A\"]\n\n1. e4 *\n{}", " ".repeat(count)),
        )
        .expect("rewrite padded PGN");
        count
    }

    #[test]
    fn revision_matches_compares_size_mtime_and_ctime() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("revision-fields.pgn");
        std::fs::write(&path, "[Event \"A\"]\n\n1. e4 *\n").expect("initial PGN");
        let snapshot = snapshot_for(&directory, &path);
        let key = snapshot_key(&snapshot);
        assert!(revision_matches(&snapshot, &key).expect("matching revision"));

        let mut size_key = key.clone();
        size_key.revision.size += 1;
        let mut mtime_key = key.clone();
        mtime_key.revision.mtime_nanos += 1;
        let mut ctime_key = key.clone();
        ctime_key.revision.ctime_nanos += 1;
        for (field, changed_key) in [
            ("size", size_key),
            ("mtime", mtime_key),
            ("ctime", ctime_key),
        ] {
            assert!(
                !revision_matches(&snapshot, &changed_key).expect("compare revision field"),
                "a change to {field} alone must invalidate the revision"
            );
        }
    }

    async fn assert_read_rewrite(original: &[u8], rewritten: &[u8], page: bool) {
        assert_ne!(original.len(), rewritten.len());
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("read-revision.pgn");
        std::fs::write(&path, original).expect("write original PGN");
        let repository = PgnRepository::default();
        let resolved = resolved_for(&directory, &path);
        let identity = resolved.pgn_snapshot().expect("original snapshot").identity;
        let (hook, entered, release) = BoundedHook::new();
        repository
            .set_read_chunk_hook(Some(hook))
            .expect("read hook");
        let task = tokio::spawn(async move {
            let token = CancellationToken::new();
            if page {
                read_games_core(resolved, 0, 1, &token, &repository).await
            } else {
                read_game_core(resolved, 0, &token, &repository)
                    .await
                    .map(|game| vec![game])
            }
        });
        tokio::time::timeout(Duration::from_secs(5), entered)
            .await
            .expect("read hook timeout")
            .expect("read hook entered");
        std::fs::write(&path, rewritten).expect("rewrite same inode");
        drop(release);
        let actual = task
            .await
            .expect("join read")
            .expect("read retries rewrite");
        let token = CancellationToken::new();
        let fresh_repository = PgnRepository::default();
        let expected = if page {
            read_games_core(
                resolved_for(&directory, &path),
                0,
                1,
                &token,
                &fresh_repository,
            )
            .await
            .expect("fresh page")
        } else {
            vec![read_game_core(
                resolved_for(&directory, &path),
                0,
                &token,
                &fresh_repository,
            )
            .await
            .expect("fresh game")]
        };
        assert_eq!(actual, expected);
        let snapshot = snapshot_for(&directory, &path);
        assert_eq!(snapshot.identity, identity);
        let ranges = scan_games(snapshot.file).expect("rewritten ranges");
        assert_eq!(ranges.len(), if page { 2 } else { 1 });
        let revision = file_revision_core(resolved_for(&directory, &path), &token)
            .await
            .expect("fresh revision");
        for (game, range) in actual.iter().zip(ranges) {
            assert!(game.present);
            assert_eq!(game.revision, revision);
            assert_eq!(
                game.pgn.as_bytes(),
                &rewritten[range.start as usize..range.end as usize]
            );
            assert_eq!(game.stamp, game_stamp(game.pgn.as_bytes()));
        }
    }

    #[tokio::test]
    async fn read_revision_retry_preserves_bom_and_page_bytes() {
        assert_read_rewrite(
            b"\xef\xbb\xbf[Event \"Old A\"]\n[Site \"Old\"]\n\n1. e4 *\n[Event \"Old B\"]\n\n1. d4 *\n",
            b"\xef\xbb\xbf[Event \"Rewritten first game\"]\n[Site \"New site\"]\n\n1. c4 e5 *\n[Event \"Rewritten second game\"]\n\n1. Nf3 d5 *\n",
            true,
        ).await;
    }

    #[tokio::test]
    async fn read_revision_retry_binds_single_game_stamp() {
        assert_read_rewrite(
            b"\xef\xbb\xbf[Event \"Old A\"]\n[Site \"Old\"]\n\n1. e4 *\n[Event \"Old B\"]\n\n1. d4 *\n",
            b"\xef\xbb\xbf[Event \"One rewritten game with padding\"]\n[Site \"New site\"]\n\n1. c4 e5 {padding to change the size of the file} *\n",
            false,
        ).await;
    }

    #[tokio::test]
    async fn read_revision_retry_discards_shortening_eof_error() {
        assert_read_rewrite(
            b"[Event \"Old first game with padding\"]\n\n1. e4 {old first padding} *\n[Event \"Old second game with padding\"]\n\n1. d4 {old second padding} *\n",
            b"[Event \"A\"]\n\n1. c4 *\n[Event \"B\"]\n\n1. Nf3 *\n",
            true,
        ).await;
    }

    async fn assert_read_retry_after_append(index: i32, appended: &'static str, expected: &str) {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("append-revision.pgn");
        let first = "[Event \"A\"]\n\n1. e4 *\n";
        std::fs::write(&path, first).expect("first game");
        let repository = PgnRepository::default();
        let attempts = Arc::new(AtomicUsize::new(0));
        let action_attempts = attempts.clone();
        let action_path = path.clone();
        repository
            .set_read_attempt_action(Some(Arc::new(move || {
                if action_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    std::fs::write(&action_path, format!("{first}{appended}"))
                        .expect("append in place");
                }
            })))
            .expect("attempt action");
        let token = CancellationToken::new();
        let game = read_game_core(resolved_for(&directory, &path), index, &token, &repository)
            .await
            .expect("selection retried after append");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert!(game.present);
        assert_eq!(game.pgn, expected);
        assert_eq!(game.stamp, game_stamp(expected.as_bytes()));
        assert_eq!(
            game.revision,
            file_revision_core(resolved_for(&directory, &path), &token)
                .await
                .expect("revision")
        );
    }

    #[tokio::test]
    async fn read_revision_retry_reselects_missing_game() {
        let second = "[Event \"Appended\"]\n\n1. d4 *\n";
        assert_read_retry_after_append(1, second, second).await;
    }

    #[tokio::test]
    async fn read_revision_retry_discards_select_error() {
        assert_read_retry_after_append(
            2,
            "[Event \"Second\"]\n\n1. d4 *\n[Event \"Third\"]\n\n1. c4 *\n",
            "[Event \"Third\"]\n\n1. c4 *\n",
        )
        .await;
    }

    #[tokio::test]
    async fn read_revision_exhaustion_is_bounded() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("read-churn.pgn");
        std::fs::write(&path, "[Event \"A\"]\n\n1. e4 *\n").expect("initial PGN");
        let repository = PgnRepository::default();
        let attempts = Arc::new(AtomicUsize::new(0));
        let action_attempts = attempts.clone();
        let action_path = path.clone();
        repository
            .set_read_attempt_action(Some(Arc::new(move || {
                rewrite_padded_pgn(&action_path, &action_attempts);
            })))
            .expect("attempt action");
        let result = read_game_core(
            resolved_for(&directory, &path),
            0,
            &CancellationToken::new(),
            &repository,
        )
        .await;
        assert!(matches!(result, Err(Error::StaleGame)), "{result:?}");
        assert_eq!(attempts.load(Ordering::SeqCst), MAX_REVISION_ATTEMPTS);
        assert!(repository.inner().expect("cache").cache.is_empty());
    }

    async fn assert_scan_rewrite(original: &[u8], rewritten: &[u8], expected_count: i32) {
        assert_ne!(original.len(), rewritten.len());
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("scan-revision.pgn");
        std::fs::write(&path, original).expect("original PGN");
        let repository = PgnRepository::default();
        let resolved = resolved_for(&directory, &path);
        let old_key = snapshot_key(&resolved.pgn_snapshot().expect("snapshot"));
        let (hook, entered, release) = BoundedHook::new();
        repository
            .set_scan_line_hook(Some(hook))
            .expect("scan hook");
        let task_repository = repository.clone();
        let task = tokio::spawn(async move {
            count_pgn_games_core(resolved, &CancellationToken::new(), &task_repository).await
        });
        tokio::time::timeout(Duration::from_secs(5), entered)
            .await
            .expect("scan timeout")
            .expect("scan entered");
        std::fs::write(&path, rewritten).expect("rewrite during scan");
        drop(release);
        assert_eq!(
            task.await
                .expect("join scan")
                .expect("scan retries rewrite"),
            expected_count
        );
        assert!(repository.get(&old_key).expect("old cache key").is_none());
        let snapshot = snapshot_for(&directory, &path);
        assert_eq!(snapshot.identity, old_key.identity);
        assert!(repository
            .get(&snapshot_key(&snapshot))
            .expect("verified cache key")
            .is_some());
        assert_eq!(
            count_pgn_games_core_blocking(snapshot, &CancellationToken::new(), &repository)
                .expect("blocking count"),
            expected_count
        );
    }

    #[tokio::test]
    async fn scan_revision_retry_retains_only_verified_ranges() {
        assert_scan_rewrite(
            b"[Event \"Old\"]\n\n1. e4 *\n",
            b"[Event \"New A\"]\n\n1. c4 *\n[Event \"New B\"]\n\n1. d4 *\n",
            2,
        )
        .await;
    }

    #[tokio::test]
    async fn scan_revision_exhaustion_is_bounded_and_uncached() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("scan-churn.pgn");
        std::fs::write(&path, "[Event \"A\"]\n\n1. e4 *\n").expect("initial PGN");
        let repository = PgnRepository::default();
        let attempts = Arc::new(AtomicUsize::new(0));
        let action_attempts = attempts.clone();
        let action_path = path.clone();
        repository
            .set_scan_attempt_action(Some(Arc::new(move || {
                rewrite_padded_pgn(&action_path, &action_attempts);
            })))
            .expect("scan action");
        let result = count_pgn_games_core(
            resolved_for(&directory, &path),
            &CancellationToken::new(),
            &repository,
        )
        .await;
        assert!(matches!(result, Err(Error::StaleGame)), "{result:?}");
        assert_eq!(attempts.load(Ordering::SeqCst), MAX_REVISION_ATTEMPTS);
        assert!(repository.inner().expect("cache").cache.is_empty());
    }

    #[tokio::test]
    async fn revision_retry_cancellation_takes_precedence() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("cancel-retry.pgn");
        std::fs::write(&path, "[Event \"A\"]\n\n1. e4 *\n").expect("initial PGN");
        let repository = PgnRepository::default();
        let token = CancellationToken::new();
        let action_token = token.clone();
        let attempts = Arc::new(AtomicUsize::new(0));
        let action_attempts = attempts.clone();
        let action_path = path.clone();
        repository
            .set_read_attempt_action(Some(Arc::new(move || {
                let count = rewrite_padded_pgn(&action_path, &action_attempts);
                if count == 2 {
                    action_token.cancel();
                }
            })))
            .expect("attempt action");
        let result = read_game_core(resolved_for(&directory, &path), 0, &token, &repository).await;
        assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn scan_revision_retry_discards_mixed_utf8_error() {
        // The first old line consumes the entire BufReader buffer. The rewrite places a
        // multi-byte character across that boundary, so the resumed scan starts at its tail.
        let original = format!(
            "[Event \"{}\"]\n\n1. e4 *\n[Event \"B\"]\n\n1. d4 *\n",
            "x".repeat(8181)
        );
        assert_eq!(original.find('\n').expect("first newline") + 1, 8192);
        let rewritten = format!("[Event \"{}é\"]\n\n1. c4 *\n", "y".repeat(8183));
        assert_eq!(rewritten.as_bytes()[8192], 0xa9);
        assert_scan_rewrite(original.as_bytes(), rewritten.as_bytes(), 1).await;
    }

    fn with_line_ending(value: &str, line_ending: &str) -> Vec<u8> {
        value.replace('\n', line_ending).into_bytes()
    }

    fn for_each_scan_variant(mut assertion: impl FnMut(&str, &[u8])) {
        for line_ending in ["\n", "\r\n"] {
            for bom in [b"".as_slice(), b"\xef\xbb\xbf".as_slice()] {
                assertion(line_ending, bom);
            }
        }
    }

    fn assert_scan_variants(leading: &str, expected_games: &[&str]) {
        assert_scan_fixture_variants(leading, expected_games, |_, _| {});
    }

    fn assert_scan_fixture_variants(
        leading: &str,
        expected_games: &[&str],
        mut assertion: impl FnMut(&[u8], &[GameRange]),
    ) {
        for_each_scan_variant(|line_ending, bom| {
            let leading = with_line_ending(leading, line_ending);
            let expected_games: Vec<Vec<u8>> = expected_games
                .iter()
                .map(|game| with_line_ending(game, line_ending))
                .collect();
            let mut data = bom.to_vec();
            data.extend_from_slice(&leading);
            for game in &expected_games {
                data.extend_from_slice(game);
            }

            let ranges = scan_games(Cursor::new(&data)).expect("scan PGN fixture");
            assert_eq!(ranges.len(), expected_games.len());
            let mut expected_start = (bom.len() + leading.len()) as u64;
            for (range, expected_game) in ranges.iter().zip(&expected_games) {
                let expected_end = expected_start + expected_game.len() as u64;
                assert_eq!(range.start, expected_start);
                assert_eq!(range.end, expected_end);
                assert_eq!(
                    &data[range.start as usize..range.end as usize],
                    expected_game
                );
                expected_start = expected_end;
            }
            assertion(&data, &ranges);
        });
    }

    fn assert_invalid_scan_variants(data: &str) {
        for_each_scan_variant(|line_ending, bom| {
            let data = with_line_ending(data, line_ending);
            let mut fixture = bom.to_vec();
            fixture.extend_from_slice(&data);
            assert_eq!(
                scan_games(Cursor::new(fixture))
                    .expect_err("unterminated comment must fail")
                    .kind(),
                io::ErrorKind::InvalidData
            );
        });
    }

    fn writable_for(
        directory: &tempfile::TempDir,
        path: &Path,
    ) -> crate::infra::path_authority::ResolvedPath {
        let mut authority = crate::infra::path_authority::PathAuthority::open(
            directory.path().join("registry.json"),
            vec![],
        )
        .expect("open path authority");
        let descriptor = authority
            .create_pgn_export_destination(path, "test PGN")
            .expect("register PGN");
        authority
            .resolve(
                descriptor.handle.path_ref(),
                crate::infra::path_authority::PathOperation::WritePgn,
                &[],
            )
            .expect("resolve writable PGN")
    }

    fn poisoned_pgn_repository() -> PgnRepository {
        let repository = PgnRepository::default();
        let inner = Arc::clone(&repository.inner);
        let poisoner = std::thread::spawn(move || {
            let _guard = inner.lock().expect("repository lock");
            panic!("poison the PGN repository lock");
        });
        assert!(poisoner.join().is_err());
        assert!(repository.inner.is_poisoned());
        repository
    }

    #[test]
    fn pgn_edit_lock_registry_refuses_file_admission_after_poison() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("poisoned-admission.pgn");
        std::fs::write(&path, "[Event \"Lock fixture\"]\n\n1. e4 *\n").expect("write PGN fixture");
        let identity = snapshot_for(&directory, &path).identity;
        let repository = poisoned_pgn_repository();

        let error = repository
            .edit_lock(identity)
            .err()
            .expect("poisoned repository must refuse file admission");
        assert!(
            matches!(&error, Error::Conflict(message) if message == "PGN repository lock was poisoned"),
            "unexpected error: {error:?}"
        );
    }

    #[test]
    fn pgn_edit_lock_registry_refuses_collection_admission_after_poison() {
        let repository = poisoned_pgn_repository();

        let error = repository
            .collection_edit_lock(uuid::Uuid::nil())
            .err()
            .expect("poisoned repository must refuse collection admission");
        assert!(
            matches!(&error, Error::Conflict(message) if message == "PGN repository lock was poisoned"),
            "unexpected error: {error:?}"
        );
    }

    #[test]
    fn pgn_edit_lock_registry_preserves_identity_and_key_domains_across_clones() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let first_path = directory.path().join("first.pgn");
        let second_path = directory.path().join("second.pgn");
        for path in [&first_path, &second_path] {
            std::fs::write(path, "[Event \"Lock fixture\"]\n\n1. e4 *\n")
                .expect("write PGN fixture");
        }
        let first = writable_for(&directory, &first_path)
            .pgn_snapshot()
            .expect("first snapshot")
            .identity;
        let second = writable_for(&directory, &second_path)
            .pgn_snapshot()
            .expect("second snapshot")
            .identity;
        assert_ne!(first, second);

        let repository = PgnRepository::default();
        let cloned = repository.clone();
        let file = repository.edit_lock(first.clone()).expect("file lock");
        let file_guard = file.try_lock().expect("hold first file");
        let same_file = cloned.edit_lock(first).expect("same file lock");
        assert!(same_file.try_lock().is_err());
        let other_file = cloned.edit_lock(second).expect("other file lock");
        let other_file_guard = other_file.try_lock().expect("distinct snapshot progresses");

        let collection = repository
            .collection_edit_lock(uuid::Uuid::nil())
            .expect("collection lock");
        let collection_guard = collection
            .try_lock()
            .expect("collection progresses while file locks are held");
        let same_collection = cloned
            .collection_edit_lock(uuid::Uuid::nil())
            .expect("same collection lock");
        assert!(same_collection.try_lock().is_err());
        assert!(same_file.try_lock().is_err());
        let other_collection = cloned
            .collection_edit_lock(uuid::Uuid::from_u128(1))
            .expect("other collection lock");
        let other_collection_guard = other_collection
            .try_lock()
            .expect("distinct collection progresses");
        assert_eq!(
            repository.retained_edit_lock_count().expect("lock count"),
            4
        );

        drop((
            file_guard,
            other_file_guard,
            collection_guard,
            other_collection_guard,
        ));
        drop((
            file,
            same_file,
            other_file,
            collection,
            same_collection,
            other_collection,
        ));
        assert_eq!(
            cloned.retained_edit_lock_count().expect("final lock count"),
            0
        );
    }

    #[tokio::test]
    async fn pgn_edit_lock_registry_cancelled_waiter_preserves_surviving_owner() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("cancelled-waiter.pgn");
        std::fs::write(&path, "[Event \"Lock fixture\"]\n\n1. e4 *\n").expect("write PGN fixture");
        let identity = writable_for(&directory, &path)
            .pgn_snapshot()
            .expect("snapshot")
            .identity;
        let repository = PgnRepository::default();
        let owner = repository.edit_lock(identity.clone()).expect("owner lock");
        let held = owner.try_lock().expect("hold owner lock");
        let waiter_repository = repository.clone();
        let waiter_identity = identity.clone();
        let (waiting_tx, waiting_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let waiter = waiter_repository
                .edit_lock(waiter_identity)
                .expect("waiter lock");
            let mut waiting = Box::pin(waiter.lock());
            assert!(futures_util::poll!(&mut waiting).is_pending());
            waiting_tx.send(()).expect("report polled waiter");
            let _guard = waiting.await;
        });
        tokio::time::timeout(Duration::from_secs(5), waiting_rx)
            .await
            .expect("waiter poll timeout")
            .expect("waiter is queued");
        task.abort();
        let error = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("waiter cancellation timeout")
            .expect_err("waiting task must cancel");
        assert!(error.is_cancelled());

        let fresh = repository.edit_lock(identity).expect("fresh owner lock");
        assert!(fresh.try_lock().is_err());
        assert_eq!(
            repository.retained_edit_lock_count().expect("lock count"),
            1
        );
        drop(held);
        let fresh_guard = fresh.try_lock().expect("surviving owner progresses");
        assert!(owner.try_lock().is_err());
        drop(fresh_guard);
        drop((owner, fresh));
        assert_eq!(
            repository
                .retained_edit_lock_count()
                .expect("final lock count"),
            0
        );
    }

    #[tokio::test]
    async fn pgn_edit_lock_registry_cancelled_holder_preserves_surviving_owner() {
        let repository = PgnRepository::default();
        let collection = uuid::Uuid::nil();
        let survivor = repository
            .collection_edit_lock(collection)
            .expect("surviving collection lock");
        let holder_repository = repository.clone();
        let (held_tx, held_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let holder = holder_repository
                .collection_edit_lock(collection)
                .expect("holder collection lock");
            let guard = holder.lock().await;
            held_tx.send(()).expect("report held guard");
            std::future::pending::<()>().await;
            drop(guard);
        });
        tokio::time::timeout(Duration::from_secs(5), held_rx)
            .await
            .expect("holder acquisition timeout")
            .expect("holder owns guard");
        assert!(survivor.try_lock().is_err());
        let mut waiting = Box::pin(survivor.lock());
        assert!(futures_util::poll!(&mut waiting).is_pending());
        task.abort();
        let error = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("holder cancellation timeout")
            .expect_err("holding task must cancel");
        assert!(error.is_cancelled());
        let surviving_guard = tokio::time::timeout(Duration::from_secs(5), waiting.as_mut())
            .await
            .expect("surviving owner must progress after holder cancellation");
        let fresh = repository
            .collection_edit_lock(collection)
            .expect("fresh collection lock");
        assert!(fresh.try_lock().is_err());
        assert_eq!(
            repository.retained_edit_lock_count().expect("lock count"),
            1
        );
        drop(surviving_guard);
        drop(waiting);
        drop((survivor, fresh));
        assert_eq!(
            repository
                .retained_edit_lock_count()
                .expect("final lock count"),
            0
        );
    }

    #[test]
    fn pgn_edit_lock_registry_distinct_key_burst_returns_to_zero() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let repository = PgnRepository::default();
        let cloned = repository.clone();
        let mut locks = Vec::new();
        for index in 0..16 {
            let path = directory.path().join(format!("history-{index}.pgn"));
            std::fs::write(&path, "[Event \"Lock fixture\"]\n\n1. e4 *\n")
                .expect("write PGN fixture");
            let identity = writable_for(&directory, &path)
                .pgn_snapshot()
                .expect("snapshot")
                .identity;
            locks.push(repository.edit_lock(identity).expect("file lock"));
            locks.push(
                cloned
                    .collection_edit_lock(uuid::Uuid::from_u128(index))
                    .expect("collection lock"),
            );
        }
        let guards: Vec<_> = locks
            .iter()
            .map(|lock| lock.try_lock().expect("distinct key progresses"))
            .collect();
        assert_eq!(
            repository
                .retained_edit_lock_count()
                .expect("burst lock count"),
            32
        );
        drop(guards);
        drop(locks);
        assert_eq!(
            cloned.retained_edit_lock_count().expect("final lock count"),
            0
        );
    }

    #[tokio::test]
    async fn practice_file_lock_leases_reclaim_holders_waiters_errors_and_unused_keys() {
        let repository = PgnRepository::default();
        let held_lease = repository.practice_edit_lock("file".into()).unwrap();
        let held = held_lease.lock().await;
        let waiter = repository.practice_edit_lock("file".into()).unwrap();
        let mut waiting = Box::pin(waiter.lock());
        assert!(futures_util::poll!(&mut waiting).is_pending());
        assert_eq!(repository.retained_edit_lock_count().unwrap(), 1);
        // Dropping a cancelled wait releases its lease without disturbing the holder.
        drop(waiting);
        drop(waiter);
        let unused = repository.practice_edit_lock("unused".into()).unwrap();
        assert_eq!(repository.retained_edit_lock_count().unwrap(), 2);
        drop(unused);
        assert_eq!(repository.retained_edit_lock_count().unwrap(), 1);
        drop(held);
        drop(held_lease);
        assert_eq!(repository.retained_edit_lock_count().unwrap(), 0);

        let failed = async {
            let lease = repository.practice_edit_lock("error".into())?;
            let _guard = lease.lock().await;
            Err::<(), Error>(Error::Cancellation)
        }
        .await;
        assert!(failed.is_err());
        assert_eq!(repository.retained_edit_lock_count().unwrap(), 0);
        let burst = (0..32)
            .map(|index| {
                repository
                    .practice_edit_lock(format!("file-{index}"))
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert_eq!(repository.retained_edit_lock_count().unwrap(), burst.len());
        drop(burst);
        assert_eq!(repository.retained_edit_lock_count().unwrap(), 0);
    }

    async fn delete_with_snapshot(
        directory: &tempfile::TempDir,
        path: &Path,
        n: i32,
        selected: StampedGame,
    ) -> Result<(), Error> {
        let app = mock_app();
        let state = app.state::<AppState>();
        let lease = state.operations.accept("delete_game")?;
        delete_game_core(
            lease,
            writable_for(directory, path),
            n,
            selected.stamp,
            selected.revision,
            state.pgn_repository.clone(),
            None,
        )
        .await
    }

    #[cfg(unix)]
    fn promote_pgn_file(
        authority: &mut crate::infra::path_authority::PathAuthority,
        path: &Path,
    ) -> crate::infra::path_authority::FileWorkspaceHandle {
        use crate::infra::path_authority::{PathClass, PathOperation};

        let operations = vec![PathOperation::ReadPgn, PathOperation::WritePgn];
        let grant = authority
            .grant_dialog_operations(
                path,
                "picked PGN",
                PathClass::BoundedDialogGrant,
                operations.clone(),
                Duration::from_secs(60),
                1,
            )
            .expect("grant picked PGN");
        let committed = authority
            .promote_dialog(&grant, PathClass::PersistentFile, "picked PGN", operations)
            .expect("promote picked PGN");
        crate::infra::path_authority::FileWorkspaceHandle::new(committed.id)
    }

    #[cfg(unix)]
    fn promote_pgn_workspace(
        authority: &mut crate::infra::path_authority::PathAuthority,
        path: &Path,
    ) -> crate::infra::path_authority::FileWorkspaceHandle {
        use crate::infra::path_authority::{PathClass, PathOperation};

        let operations = vec![PathOperation::ReadPgn, PathOperation::WritePgn];
        let grant = authority
            .grant_dialog_operations(
                path,
                "PGN workspace",
                PathClass::BoundedDialogGrant,
                operations.clone(),
                Duration::from_secs(60),
                1,
            )
            .expect("grant PGN workspace");
        let committed = authority
            .promote_dialog(
                &grant,
                PathClass::PersistentCustomRoot,
                "PGN workspace",
                operations,
            )
            .expect("promote PGN workspace");
        crate::infra::path_authority::FileWorkspaceHandle::new(committed.id)
    }

    #[cfg(unix)]
    fn fs_identity(path: &Path) -> (u64, u64) {
        use std::os::unix::fs::MetadataExt;

        let metadata = std::fs::metadata(path).expect("stat PGN fixture");
        (metadata.dev(), metadata.ino())
    }

    #[cfg(unix)]
    fn registry_identity(
        registry_path: &Path,
        id: &crate::infra::path_authority::PathRef,
    ) -> (u64, u64) {
        let bytes = std::fs::read(registry_path).expect("read path registry");
        let registry: serde_json::Value =
            serde_json::from_slice(&bytes).expect("decode path registry");
        let entries = registry
            .get("entries")
            .and_then(serde_json::Value::as_array)
            .expect("registry entries");
        let entry = entries
            .iter()
            .find(|entry| {
                entry
                    .get("id")
                    .and_then(|id| id.get("id"))
                    .and_then(serde_json::Value::as_str)
                    == Some(id.id.as_str())
            })
            .expect("capability registry entry");
        let identity = entry.get("identity").expect("stored identity");
        (
            identity
                .get("a")
                .and_then(serde_json::Value::as_u64)
                .expect("stored device identity"),
            identity
                .get("b")
                .and_then(serde_json::Value::as_u64)
                .expect("stored inode identity"),
        )
    }

    #[cfg(unix)]
    async fn write_through_capability(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        handle: &crate::infra::path_authority::FileWorkspaceHandle,
        n: i32,
        pgn: String,
    ) -> Result<WriteStamp, Error> {
        let (lease, resolved, readback_path, repository, rebind) = {
            let state = app.state::<AppState>();
            let lease = state.operations.accept("write_game")?;
            let resolved = resolve_pgn(
                &state,
                handle,
                crate::infra::path_authority::PathOperation::WritePgn,
            )?;
            let readback_path = resolve_pgn(
                &state,
                handle,
                crate::infra::path_authority::PathOperation::ReadPgn,
            )?;
            let repository = state.pgn_repository.clone();
            let rebind = PgnCapabilityRebind {
                authority: state.pgn_path_authority.clone(),
                path_ref: handle.path_ref().clone(),
                binding: None,
            };
            (lease, resolved, readback_path, repository, rebind)
        };
        let current =
            read_game_core(readback_path, n, &CancellationToken::new(), &repository).await?;
        write_game_core(
            lease,
            resolved,
            n,
            pgn,
            WriteExpectation::Game {
                stamp: current.stamp,
            },
            repository,
            Some(rebind),
        )
        .await
    }

    #[cfg(unix)]
    async fn append_through_capability(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        handle: &crate::infra::path_authority::FileWorkspaceHandle,
        n: i32,
        pgn: String,
    ) -> Result<WriteStamp, Error> {
        let (lease, resolved, repository, rebind) = {
            let state = app.state::<AppState>();
            let lease = state.operations.accept("write_game")?;
            let resolved = resolve_pgn(
                &state,
                handle,
                crate::infra::path_authority::PathOperation::WritePgn,
            )?;
            let repository = state.pgn_repository.clone();
            let rebind = PgnCapabilityRebind {
                authority: state.pgn_path_authority.clone(),
                path_ref: handle.path_ref().clone(),
                binding: None,
            };
            (lease, resolved, repository, rebind)
        };
        write_game_core(
            lease,
            resolved,
            n,
            pgn,
            WriteExpectation::Append,
            repository,
            Some(rebind),
        )
        .await
    }

    #[cfg(unix)]
    async fn delete_through_capability(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        handle: &crate::infra::path_authority::FileWorkspaceHandle,
        n: i32,
        expected_stamp: String,
        expected_revision: String,
    ) -> Result<(), Error> {
        let (lease, resolved, repository, rebind) = {
            let state = app.state::<AppState>();
            let lease = state.operations.accept("delete_game")?;
            let resolved = resolve_pgn(
                &state,
                handle,
                crate::infra::path_authority::PathOperation::WritePgn,
            )?;
            let repository = state.pgn_repository.clone();
            let rebind = PgnCapabilityRebind {
                authority: state.pgn_path_authority.clone(),
                path_ref: handle.path_ref().clone(),
                binding: None,
            };
            (lease, resolved, repository, rebind)
        };
        delete_game_core(
            lease,
            resolved,
            n,
            expected_stamp,
            expected_revision,
            repository,
            Some(rebind),
        )
        .await
    }

    #[test]
    #[cfg(unix)]
    fn edit_existing_file_sync_cancellation_preserves_original_pgn() {
        use crate::infra::fs::{
            install_test_atomic_file_injector, AtomicFileFaultPoint, CancelAtomicFileAt,
        };

        let directory = tempfile::tempdir().expect("PGN directory");
        let path = directory.path().join("games.pgn");
        let original = b"[Event \"before\"]\n\n1. e4 *\n";
        std::fs::write(&path, original).expect("PGN");
        let resolved = writable_for(&directory, &path);
        let snapshot = resolved.pgn_snapshot().expect("snapshot");
        let key = snapshot_key(&snapshot);
        let range = GameRange {
            start: 0,
            end: snapshot.revision.size,
        };
        let cancellation = CancellationToken::new();
        let injector = install_test_atomic_file_injector(std::sync::Arc::new(CancelAtomicFileAt {
            cancel_at: AtomicFileFaultPoint::FileSync,
            fail_at: None,
            cancellation: cancellation.clone(),
        }));
        let result = edit_existing(
            &resolved,
            key,
            snapshot,
            range,
            Some(PgnReplacement::Bytes(
                b"[Event \"after\"]\n\n1. d4 *\n".to_vec(),
            )),
            &cancellation,
        );
        drop(injector);
        assert!(cancellation.is_cancelled());
        assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
        assert_eq!(std::fs::read(&path).expect("original PGN"), original);
    }

    #[test]
    #[cfg_attr(not(unix), ignore = "unported on this platform: f-20260914-10")]
    fn edit_existing_keeps_the_replacement_and_reports_uncertain_pgn_edit() {
        let directory = tempfile::tempdir().expect("PGN directory");
        let path = directory.path().join("games.pgn");
        std::fs::write(&path, "[Event \"before\"]\n\n1. e4 *\n").expect("PGN");
        let resolved = writable_for(&directory, &path);
        let snapshot = resolved.pgn_snapshot().expect("snapshot");
        let key = snapshot_key(&snapshot);
        let range = GameRange {
            start: 0,
            end: snapshot.revision.size,
        };
        crate::infra::fs::set_test_atomic_file_injector(Some(std::sync::Arc::new(
            crate::infra::fs::ParentSyncFault("uncertain"),
        )));
        let result = edit_existing(
            &resolved,
            key,
            snapshot,
            range,
            Some(PgnReplacement::Bytes(
                b"[Event \"after\"]\n\n1. d4 *\n".to_vec(),
            )),
            &CancellationToken::new(),
        );
        crate::infra::fs::set_test_atomic_file_injector(None);
        assert!(matches!(
            crate::infra::fs::require_durable(
                result.expect("atomic replacement installed").outcome,
                crate::error::DurabilityStage::PgnEdit,
            ),
            Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::PgnEdit
            ))
        ));
        assert_eq!(
            std::fs::read_to_string(&path).expect("edited PGN"),
            "[Event \"after\"]\n\n1. d4 *\n"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn persistent_file_capability_survives_own_replacements_and_registry_reload() {
        use crate::infra::path_authority::{PathAuthority, PathOperation};

        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("picked.pgn");
        let registry = directory.path().join("registry.json");
        std::fs::write(
            &path,
            "[Event \"First\"]\n\n1. e4 *\n\n[Event \"Second\"]\n\n1. d4 *\n",
        )
        .expect("write PGN fixture");
        let mut authority =
            PathAuthority::open(registry.clone(), vec![]).expect("open path authority");
        let handle = promote_pgn_file(&mut authority, &path);
        let app = mock_app();
        let authority_arc = {
            let state = app.state::<AppState>();
            let authority_arc = state.pgn_path_authority.clone();
            authority_arc.install(authority).unwrap();
            authority_arc
        };

        let original_identity = fs_identity(&path);
        write_through_capability(
            &app,
            &handle,
            0,
            "[Event \"First write\"]\n\n1. d4 *\n".into(),
        )
        .await
        .expect("first capability write");
        let first_identity = fs_identity(&path);
        assert_ne!(first_identity, original_identity);
        assert_eq!(
            registry_identity(&registry, handle.path_ref()),
            first_identity
        );

        write_through_capability(
            &app,
            &handle,
            0,
            "[Event \"Second write\"]\n\n1. c4 *\n".into(),
        )
        .await
        .expect("second capability write");
        let second_identity = fs_identity(&path);
        assert_ne!(second_identity, first_identity);
        assert_eq!(
            registry_identity(&registry, handle.path_ref()),
            second_identity
        );

        let current = {
            let state = app.state::<AppState>();
            read_game_core(
                resolve_pgn(&state, &handle, PathOperation::ReadPgn).expect("resolve game"),
                0,
                &CancellationToken::new(),
                &state.pgn_repository,
            )
            .await
            .expect("read current game before delete")
        };
        delete_through_capability(&app, &handle, 0, current.stamp, current.revision)
            .await
            .expect("capability delete");
        let deleted_identity = fs_identity(&path);
        assert_ne!(deleted_identity, second_identity);
        assert_eq!(
            registry_identity(&registry, handle.path_ref()),
            deleted_identity
        );

        let reloaded =
            PathAuthority::open(registry.clone(), vec![]).expect("reload path authority");
        authority_arc.install(reloaded).unwrap();
        let (resolved, repository) = {
            let state = app.state::<AppState>();
            let resolved = resolve_pgn(&state, &handle, PathOperation::ReadPgn)
                .expect("resolve capability after reload");
            (resolved, state.pgn_repository.clone())
        };
        let games = read_games_core(resolved, 0, 0, &CancellationToken::new(), &repository)
            .await
            .expect("read games after reload");
        assert_eq!(games.len(), 1);
        assert!(games[0].pgn.contains("[Event \"Second\"]"));
        assert_eq!(
            registry_identity(&registry, handle.path_ref()),
            deleted_identity
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn a_rebind_failure_after_the_replacement_reports_a_committed_write() {
        use crate::infra::path_authority::PathAuthority;

        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("picked.pgn");
        let registry_directory = directory.path().join("registry");
        std::fs::create_dir(&registry_directory).expect("registry directory");
        let registry = registry_directory.join("registry.json");
        std::fs::write(&path, "[Event \"Before\"]\n\n1. e4 *\n").expect("write PGN fixture");
        let mut authority =
            PathAuthority::open(registry.clone(), vec![]).expect("open path authority");
        let handle = promote_pgn_file(&mut authority, &path);
        let app = mock_app();
        app.state::<AppState>()
            .pgn_path_authority
            .install(authority)
            .expect("path authority lock");
        // The registry cannot be replaced any more, so the rebind that follows the PGN
        // replacement fails with a raw NotFound after the game is already on disk.
        std::fs::remove_dir_all(&registry_directory).expect("remove registry directory");

        let error =
            write_through_capability(&app, &handle, 0, "[Event \"After\"]\n\n1. d4 *\n".into())
                .await
                .expect_err("the rebind cannot be persisted");

        assert!(
            matches!(
                error,
                Error::CommittedDurabilityUncertain(
                    crate::error::DurabilityStage::PgnCapabilityRebind
                )
            ),
            "unexpected error: {error:?}"
        );
        assert_eq!(error.category(), crate::error::ErrorCategory::Durability);
        assert_eq!(
            std::fs::read_to_string(&path).expect("replaced PGN"),
            "[Event \"After\"]\n\n1. d4 *\n"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn external_rename_replace_between_persistent_file_writes_stays_conflict() {
        use crate::infra::path_authority::PathAuthority;

        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("picked.pgn");
        let registry = directory.path().join("registry.json");
        std::fs::write(&path, "[Event \"Before\"]\n\n1. e4 *\n").expect("write PGN fixture");
        let mut authority =
            PathAuthority::open(registry.clone(), vec![]).expect("open path authority");
        let handle = promote_pgn_file(&mut authority, &path);
        let app = mock_app();
        {
            let state = app.state::<AppState>();
            state
                .pgn_path_authority
                .install(authority)
                .expect("path authority lock");
        }

        write_through_capability(
            &app,
            &handle,
            0,
            "[Event \"App write\"]\n\n1. d4 *\n".into(),
        )
        .await
        .expect("first capability write");
        let stored_identity = registry_identity(&registry, handle.path_ref());

        let external = directory.path().join("external.pgn");
        std::fs::write(&external, "[Event \"External\"]\n\n1. c4 *\n")
            .expect("write external replacement");
        std::fs::rename(&external, &path).expect("replace PGN from another writer");
        assert_ne!(fs_identity(&path), stored_identity);

        assert!(matches!(
            write_through_capability(
                &app,
                &handle,
                0,
                "[Event \"Must not commit\"]\n\n1. Nf3 *\n".into(),
            )
            .await,
            Err(Error::Conflict(_))
        ));
        assert_eq!(
            registry_identity(&registry, handle.path_ref()),
            stored_identity
        );
        assert!(std::fs::read_to_string(&path)
            .expect("read external PGN")
            .contains("[Event \"External\"]"));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn pgn_write_rebind_does_not_change_directory_rooted_workspace_handle() {
        use crate::infra::path_authority::{PathAuthority, PathOperation};
        use std::ffi::OsString;

        let directory = tempfile::tempdir().expect("temporary directory");
        let workspace_path = directory.path().join("workspace");
        std::fs::create_dir(&workspace_path).expect("create workspace");
        let path = workspace_path.join("study.pgn");
        std::fs::write(&path, "[Event \"Before\"]\n\n1. e4 *\n").expect("write PGN fixture");
        let registry = directory.path().join("registry.json");
        let mut authority =
            PathAuthority::open(registry.clone(), vec![]).expect("open path authority");
        let workspace = promote_pgn_workspace(&mut authority, &workspace_path);
        let child = authority
            .register_workspace_child_observed(
                &workspace,
                &[OsString::from("study.pgn")],
                "study.pgn",
                fs_identity(&path),
                false,
                PathOperation::WritePgn,
            )
            .expect("register workspace PGN");
        let parent = crate::infra::fs::open_parent_no_follow(&path).expect("PGN parent descriptor");
        let parent_identity = crate::infra::path_authority::opened_file_identity(&parent)
            .expect("parent descriptor identity");
        assert_eq!(
            authority.parent_identity_for_test(child.path_ref()),
            Some(parent_identity)
        );
        assert!(authority
            .resolve(child.path_ref(), PathOperation::ReadPgn, &[])
            .is_ok());
        let root_identity = fs_identity(&workspace_path);
        assert_eq!(
            registry_identity(&registry, workspace.path_ref()),
            root_identity
        );

        let app = mock_app();
        let authority_arc = {
            let state = app.state::<AppState>();
            let authority_arc = state.pgn_path_authority.clone();
            authority_arc.install(authority).unwrap();
            authority_arc
        };
        write_through_capability(&app, &child, 0, "[Event \"After\"]\n\n1. d4 *\n".into())
            .await
            .expect("write workspace PGN");

        assert_eq!(fs_identity(&workspace_path), root_identity);
        {
            let mut authority = authority_arc
                .raw_for_test()
                .lock()
                .expect("path authority lock");
            let authority = authority.as_mut().expect("path authority");
            assert_eq!(
                authority.parent_identity_for_test(child.path_ref()),
                Some(parent_identity),
                "atomic PGN replacement must preserve the bound parent identity"
            );
            assert!(authority
                .resolve(child.path_ref(), PathOperation::ReadPgn, &[])
                .is_ok());
        }
        assert_eq!(
            registry_identity(&registry, workspace.path_ref()),
            root_identity
        );
        let resolved_root = authority_arc
            .raw_for_test()
            .lock()
            .expect("path authority lock")
            .as_mut()
            .expect("path authority initialized")
            .workspace_root(&workspace, PathOperation::ReadPgn)
            .expect("resolve unchanged workspace root");
        assert_eq!(resolved_root, workspace_path);
        assert_eq!(
            registry_identity(&registry, child.path_ref()),
            fs_identity(&path)
        );
    }

    fn key_with_size(key: &CacheKey, size: u64) -> CacheKey {
        CacheKey {
            identity: key.identity.clone(),
            revision: FileRevision {
                size,
                mtime_nanos: key.revision.mtime_nanos,
                ctime_nanos: key.revision.ctime_nanos,
            },
        }
    }

    fn mock_app() -> tauri::AppHandle<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(AppState::default());
        app.handle().clone()
    }

    #[cfg(unix)]
    async fn file_revision_through_capability(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        handle: &crate::infra::path_authority::FileWorkspaceHandle,
    ) -> Result<String, Error> {
        let resolved = {
            let state = app.state::<AppState>();
            resolve_pgn(
                &state,
                handle,
                crate::infra::path_authority::PathOperation::ReadPgn,
            )?
        };
        file_revision_core(resolved, &CancellationToken::new()).await
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn file_revision_tracks_external_and_app_writes_through_a_persistent_handle() {
        use crate::infra::path_authority::PathAuthority;

        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("revision.pgn");
        let registry = directory.path().join("registry.json");
        std::fs::write(&path, "[Event \"Initial\"]\n\n1. e4 *\n").expect("initial PGN");
        let mut authority = PathAuthority::open(registry, vec![]).expect("path authority");
        let handle = promote_pgn_file(&mut authority, &path);
        let app = mock_app();
        {
            let state = app.state::<AppState>();
            state
                .pgn_path_authority
                .install(authority)
                .expect("path authority lock");
        }

        let initial = file_revision_through_capability(&app, &handle)
            .await
            .expect("initial revision");
        std::fs::write(&path, "[Event \"External\"]\n\n1. d4 d5 *\n")
            .expect("external in-place write");
        let external = file_revision_through_capability(&app, &handle)
            .await
            .expect("revision after external write");
        assert_ne!(external, initial);

        write_through_capability(
            &app,
            &handle,
            0,
            "[Event \"Application\"]\n\n1. c4 e5 *\n".into(),
        )
        .await
        .expect("application write");
        let application = file_revision_through_capability(&app, &handle)
            .await
            .expect("revision after application write");
        assert_ne!(application, external);

        let (resolved, repository) = {
            let state = app.state::<AppState>();
            (
                resolve_pgn(
                    &state,
                    &handle,
                    crate::infra::path_authority::PathOperation::ReadPgn,
                )
                .expect("persistent handle remains usable"),
                state.pgn_repository.clone(),
            )
        };
        let games = read_games_core(resolved, 0, 0, &CancellationToken::new(), &repository)
            .await
            .expect("read through rebound persistent handle");
        assert_eq!(games.len(), 1);
        assert!(games[0].pgn.contains("[Event \"Application\"]"));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn file_revision_reports_delete_and_external_rename_replace_categories() {
        use crate::{error::ErrorCategory, infra::path_authority::PathAuthority};

        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("deleted.pgn");
        let registry = directory.path().join("deleted-registry.json");
        std::fs::write(&path, "[Event \"Delete\"]\n\n1. e4 *\n").expect("initial PGN");
        let mut authority = PathAuthority::open(registry, vec![]).expect("path authority");
        let handle = promote_pgn_file(&mut authority, &path);
        let app = mock_app();
        {
            let state = app.state::<AppState>();
            state
                .pgn_path_authority
                .install(authority)
                .expect("path authority lock");
        }
        file_revision_through_capability(&app, &handle)
            .await
            .expect("initial revision");
        std::fs::remove_file(&path).expect("delete PGN");
        let deleted = file_revision_through_capability(&app, &handle)
            .await
            .expect_err("deleted file must reject revision");
        assert_eq!(deleted.category(), ErrorCategory::MissingResource);

        let replace_dir = tempfile::tempdir().expect("replacement directory");
        let replaced_path = replace_dir.path().join("replaced.pgn");
        let replace_registry = replace_dir.path().join("replace-registry.json");
        std::fs::write(&replaced_path, "[Event \"Before\"]\n\n1. e4 *\n")
            .expect("initial replacement PGN");
        let mut replace_authority =
            PathAuthority::open(replace_registry, vec![]).expect("replace path authority");
        let replace_handle = promote_pgn_file(&mut replace_authority, &replaced_path);
        let replace_app = mock_app();
        {
            let state = replace_app.state::<AppState>();
            state
                .pgn_path_authority
                .install(replace_authority)
                .expect("path authority lock");
        }
        file_revision_through_capability(&replace_app, &replace_handle)
            .await
            .expect("initial revision before replacement");
        let sibling = replace_dir.path().join("replacement.pgn");
        std::fs::write(&sibling, "[Event \"After\"]\n\n1. d4 *\n").expect("replacement PGN");
        std::fs::rename(&sibling, &replaced_path).expect("rename replacement over PGN");
        let replaced = file_revision_through_capability(&replace_app, &replace_handle)
            .await
            .expect_err("replaced file identity must reject revision");
        assert_eq!(replaced.category(), ErrorCategory::Conflict);
    }

    #[tokio::test]
    async fn read_games_core_returns_complete_pages_and_rejects_missing_ranges() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("two-games.pgn");
        std::fs::write(&path, b"[Event \"A\"]\n\n1. e4\n[Event \"B\"]\n\n1. d4\n")
            .expect("write PGN");
        let app = mock_app();
        let state = app.state::<AppState>();

        let page = read_games_core(
            resolved_for(&directory, &path),
            0,
            1,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await
        .expect("read complete two-game page");
        assert_eq!(page.len(), 2);
        assert!(page[0].pgn.starts_with("[Event \"A\"]"));
        assert!(page[1].pgn.starts_with("[Event \"B\"]"));
        assert!(page.iter().all(|game| game.present));
        assert_eq!(page[0].revision, page[1].revision);
        assert_eq!(page[0].stamp, game_stamp(b"[Event \"A\"]\n\n1. e4\n"));
        assert_eq!(page[1].stamp, game_stamp(b"[Event \"B\"]\n\n1. d4\n"));

        let partial = read_games_core(
            resolved_for(&directory, &path),
            1,
            2,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await;
        assert!(matches!(
            partial,
            Err(Error::InvalidInput(message)) if message == "game index is out of bounds"
        ));

        let missing = read_games_core(
            resolved_for(&directory, &path),
            2,
            2,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await;
        assert!(matches!(
            missing,
            Err(Error::InvalidInput(message)) if message == "game index is out of bounds"
        ));
    }

    fn seed_page_ranges(
        directory: &tempfile::TempDir,
        path: &Path,
        repository: &PgnRepository,
        ranges: Vec<GameRange>,
    ) {
        repository
            .retain_if_within_budget(snapshot_key(&snapshot_for(directory, path)), ranges.into())
            .expect("seed cached page ranges");
    }

    #[tokio::test]
    async fn page_byte_budget_returns_fitting_prefix_with_unchanged_stamps() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("prefix.pgn");
        let pgn = b"[Event \"A\"]\n\n1. e4 *\n[Event \"B\"]\n\n1. d4 *\n[Event \"C\"]\n\n1. c4 *\n";
        std::fs::write(&path, pgn).expect("write PGN");
        let app = mock_app();
        let state = app.state::<AppState>();
        let expected = read_games_core(
            resolved_for(&directory, &path),
            1,
            2,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await
        .expect("read complete fitting range");
        let mut ranges = scan_games(Cursor::new(pgn)).expect("scan real game ranges");
        let fitting_bytes = ranges[2].end - ranges[1].start;
        let suffix_start = pgn.len() as u64;
        ranges.push(GameRange {
            start: suffix_start,
            end: suffix_start + MAX_PAGE_BYTES as u64 - fitting_bytes + 1,
        });
        seed_page_ranges(&directory, &path, &state.pgn_repository, ranges);

        let page = read_games_core(
            resolved_for(&directory, &path),
            1,
            3,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await
        .expect("read fitting prefix");
        assert_eq!(page.len(), 2);
        assert_eq!(
            page, expected,
            "PGN, stamp, revision and presence stay identical"
        );
    }

    #[tokio::test]
    async fn page_byte_budget_never_reads_excluded_suffix_past_eof() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("unread-suffix.pgn");
        let pgn = b"[Event \"A\"]\n\n1. e4 *\n";
        std::fs::write(&path, pgn).expect("write PGN");
        let app = mock_app();
        let state = app.state::<AppState>();
        let eof = pgn.len() as u64;
        seed_page_ranges(
            &directory,
            &path,
            &state.pgn_repository,
            vec![
                GameRange { start: 0, end: eof },
                // This game meets the per-game limit, but read_exact would fail past EOF.
                GameRange {
                    start: eof + 1,
                    end: eof + 1 + MAX_PAGE_BYTES as u64,
                },
            ],
        );

        let page = read_games_core(
            resolved_for(&directory, &path),
            0,
            1,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await
        .expect("excluded suffix must never be read");
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].pgn.as_bytes(), pgn);
    }

    #[tokio::test]
    async fn page_byte_budget_includes_exact_sum_and_excludes_next_game() {
        assert_eq!(
            MAX_PAGE_BYTES,
            10 * 1024 * 1024,
            "d-20261004-02 fixes the page budget at 10 MiB"
        );
        assert_eq!(
            MAX_PAGE_BYTES, MAX_PGN_BYTES,
            "d-20261004-02 requires equal page and game byte budgets"
        );
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("exact-budget.pgn");
        let game_bytes = 16 * 1024;
        let mut pgn = b"[Event \"Exact\"]\n\n1. e4 *\n".to_vec();
        pgn.resize(game_bytes, b' ');
        std::fs::write(&path, &pgn).expect("write small PGN");
        let app = mock_app();
        let state = app.state::<AppState>();
        let expected = read_games_core(
            resolved_for(&directory, &path),
            0,
            0,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await
        .expect("read real game");
        let fitting_games = MAX_PAGE_BYTES / game_bytes;
        assert_eq!(fitting_games * game_bytes, MAX_PAGE_BYTES);
        assert!(fitting_games < MAX_PAGE_LEN);
        // Reuse an in-file range to exercise the exact production budget with a small fixture.
        seed_page_ranges(
            &directory,
            &path,
            &state.pgn_repository,
            vec![
                GameRange {
                    start: 0,
                    end: game_bytes as u64
                };
                fitting_games + 1
            ],
        );

        let page = read_games_core(
            resolved_for(&directory, &path),
            0,
            fitting_games as i32,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await
        .expect("read page landing exactly on budget");
        assert_eq!(page.len(), fitting_games);
        assert_eq!(
            page.iter().map(|game| game.pgn.len()).sum::<usize>(),
            MAX_PAGE_BYTES
        );
        assert!(page.iter().all(|game| game == &expected[0]));
    }

    #[tokio::test]
    async fn page_byte_budget_returns_omission_for_oversized_first_game() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("oversized-first.pgn");
        let pgn = b"[Event \"A\"]\n\n1. e4 *\n";
        let mut file_bytes = pgn.to_vec();
        file_bytes.resize(IO_CHUNK_LEN, b' ');
        std::fs::write(&path, &file_bytes).expect("write PGN");
        let app = mock_app();
        let state = app.state::<AppState>();
        for bytes in [MAX_PGN_BYTES as u64 + 1, u64::MAX] {
            seed_page_ranges(
                &directory,
                &path,
                &state.pgn_repository,
                vec![
                    GameRange {
                        start: 0,
                        end: pgn.len() as u64,
                    },
                    GameRange {
                        start: 0,
                        end: bytes,
                    },
                    GameRange { start: 0, end: 1 },
                ],
            );
            let prefix = read_games_core(
                resolved_for(&directory, &path),
                0,
                2,
                &CancellationToken::new(),
                &state.pgn_repository,
            )
            .await
            .expect("later oversized game stops the readable prefix");
            assert_eq!(prefix.len(), 1);
            assert_eq!(prefix[0].pgn.as_bytes(), pgn);

            let (hook, mut entered, _release) = BoundedHook::new();
            state
                .pgn_repository
                .set_read_chunk_hook(Some(hook))
                .expect("read chunk hook");
            let page = read_games_core(
                resolved_for(&directory, &path),
                1,
                2,
                &CancellationToken::new(),
                &state.pgn_repository,
            )
            .await;
            assert_eq!(
                entered.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty),
                "oversized omission must not read any body chunks"
            );
            state
                .pgn_repository
                .set_read_chunk_hook(None)
                .expect("clear read chunk hook");
            let page = page.expect("oversized first game is omitted without reading past EOF");
            assert_eq!(page.len(), 1);
            assert_eq!(page[0].omission, Some(GameOmission::TooLarge));
            assert!(page[0].present);
            assert!(page[0].pgn.is_empty());
            assert!(page[0].stamp.is_empty());
            assert_eq!(page[0].revision, prefix[0].revision);
            assert_eq!(
                serde_json::to_value(&page[0]).expect("serialize omission")["omission"],
                "tooLarge"
            );

            let following = read_games_core(
                resolved_for(&directory, &path),
                2,
                2,
                &CancellationToken::new(),
                &state.pgn_repository,
            )
            .await
            .expect("continue after omitted game");
            assert_eq!(following.len(), 1);
            assert_eq!(following[0].pgn, "[");
            assert_eq!(following[0].omission, None);
        }
    }

    #[tokio::test]
    async fn read_games_core_discards_omission_when_revision_changes() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("omission-revision.pgn");
        let original = "[Event \"A\"]\n\n1. e4 *\n";
        let rewritten = "[Event \"Rewritten longer game\"]\n\n1. d4 d5 2. c4 *\n";
        assert!(rewritten.len() > original.len());
        std::fs::write(&path, original).expect("write original PGN");
        let repository = PgnRepository::default();
        seed_page_ranges(
            &directory,
            &path,
            &repository,
            vec![GameRange {
                start: 0,
                end: MAX_PGN_BYTES as u64 + 1,
            }],
        );
        let attempts = Arc::new(AtomicUsize::new(0));
        let action_attempts = attempts.clone();
        let action_path = path.clone();
        repository
            .set_read_attempt_action(Some(Arc::new(move || {
                if action_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    std::fs::write(&action_path, rewritten).expect("rewrite PGN in place");
                }
            })))
            .expect("attempt action");

        let token = CancellationToken::new();
        let page = read_games_core(resolved_for(&directory, &path), 0, 0, &token, &repository)
            .await
            .expect("omission retried after revision changes");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(page.len(), 1);
        assert!(page[0].present);
        assert_eq!(page[0].pgn, rewritten);
        assert_eq!(page[0].omission, None);
        assert_eq!(page[0].stamp, game_stamp(rewritten.as_bytes()));
        assert_eq!(
            page[0].revision,
            file_revision_core(resolved_for(&directory, &path), &token)
                .await
                .expect("current revision")
        );
    }

    #[tokio::test]
    async fn page_byte_budget_returns_exact_cap_game() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("exact-cap.pgn");
        let mut pgn = String::from("[Event \"Exact cap\"]\n\n1. e4 *\n");
        pgn.extend(std::iter::repeat_n(' ', MAX_PGN_BYTES - pgn.len()));
        assert_eq!(pgn.len(), MAX_PGN_BYTES);
        std::fs::write(&path, &pgn).expect("write exact-cap UTF-8 file");
        let app = mock_app();
        let state = app.state::<AppState>();
        seed_page_ranges(
            &directory,
            &path,
            &state.pgn_repository,
            vec![GameRange {
                start: 0,
                end: MAX_PGN_BYTES as u64,
            }],
        );
        let page = read_games_core(
            resolved_for(&directory, &path),
            0,
            0,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await
        .expect("exact-cap game stays readable");
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].pgn, pgn);
        assert_eq!(page[0].stamp, game_stamp(pgn.as_bytes()));
        assert!(page[0].present);
        assert_eq!(page[0].omission, None);
        assert!(serde_json::to_value(&page[0])
            .expect("serialize readable game")
            .get("omission")
            .is_none());
    }

    #[tokio::test]
    async fn read_game_core_returns_resource_limit_for_oversized_range() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("oversized-single.pgn");
        let mut pgn = b"[Event \"A\"]\n\n1. e4 *\n".to_vec();
        pgn.resize(IO_CHUNK_LEN, b' ');
        std::fs::write(&path, &pgn).expect("write PGN");
        let app = mock_app();
        let state = app.state::<AppState>();
        for bytes in [MAX_PGN_BYTES as u64 + 1, u64::MAX] {
            seed_page_ranges(
                &directory,
                &path,
                &state.pgn_repository,
                vec![GameRange {
                    start: 0,
                    end: bytes,
                }],
            );
            let (hook, mut entered, _release) = BoundedHook::new();
            state
                .pgn_repository
                .set_read_chunk_hook(Some(hook))
                .expect("read chunk hook");
            let result = read_game_core(
                resolved_for(&directory, &path),
                0,
                &CancellationToken::new(),
                &state.pgn_repository,
            )
            .await;
            assert_eq!(
                entered.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty),
                "oversized range must not read any body chunks"
            );
            state
                .pgn_repository
                .set_read_chunk_hook(None)
                .expect("clear read chunk hook");
            assert!(matches!(result, Err(Error::ResourceLimit(_))));
        }
    }

    #[tokio::test]
    async fn page_byte_budget_checks_whole_requested_range_before_selection() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("missing-end.pgn");
        let pgn = b"[Event \"A\"]\n\n1. e4 *\n";
        std::fs::write(&path, pgn).expect("write PGN");
        let app = mock_app();
        let state = app.state::<AppState>();
        seed_page_ranges(
            &directory,
            &path,
            &state.pgn_repository,
            vec![
                GameRange {
                    start: 0,
                    end: pgn.len() as u64,
                },
                GameRange {
                    start: 0,
                    end: MAX_PAGE_BYTES as u64,
                },
            ],
        );

        let result = read_games_core(
            resolved_for(&directory, &path),
            0,
            2,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await;
        assert!(matches!(
            result,
            Err(Error::InvalidInput(message)) if message == "game index is out of bounds"
        ));
    }

    #[tokio::test]
    async fn page_byte_budget_rejects_inverted_cached_ranges() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("inverted.pgn");
        let pgn = b"[Event \"A\"]\n\n1. e4 *\n";
        std::fs::write(&path, pgn).expect("write PGN");
        let app = mock_app();
        let state = app.state::<AppState>();
        let inverted = GameRange { start: 1, end: 0 };
        for ranges in [
            vec![inverted],
            vec![
                GameRange {
                    start: 0,
                    end: pgn.len() as u64,
                },
                inverted,
            ],
        ] {
            let end = ranges.len() as i32 - 1;
            seed_page_ranges(&directory, &path, &state.pgn_repository, ranges);
            let result = read_games_core(
                resolved_for(&directory, &path),
                0,
                end,
                &CancellationToken::new(),
                &state.pgn_repository,
            )
            .await;
            assert!(matches!(
                result,
                Err(Error::Conflict(message)) if message == "invalid cached PGN byte range"
            ));
        }
    }

    #[tokio::test]
    async fn read_games_core_preserves_only_the_empty_file_opening_range() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("empty.pgn");
        std::fs::write(&path, b"").expect("write empty PGN");
        let app = mock_app();
        let state = app.state::<AppState>();

        let opening = read_games_core(
            resolved_for(&directory, &path),
            0,
            0,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await
        .expect("empty opening range remains valid");
        assert!(opening.is_empty());

        let missing = read_games_core(
            resolved_for(&directory, &path),
            1,
            1,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await;
        assert!(matches!(
            missing,
            Err(Error::InvalidInput(message)) if message == "game index is out of bounds"
        ));
    }

    #[tokio::test]
    async fn delete_game_refuses_when_an_external_insertion_shifts_the_selected_row() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("insert-before-delete.pgn");
        let original = b"[Event \"A\"]\n\n1. e4 *\n\n[Event \"B\"]\n\n1. d4 *\n";
        std::fs::write(&path, original).expect("write initial PGN");
        let app = mock_app();
        let state = app.state::<AppState>();
        let selected = read_game_core(
            writable_for(&directory, &path),
            1,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await
        .expect("read selected game");
        let changed = b"[Event \"Inserted\"]\n\n1. c4 *\n\n[Event \"A\"]\n\n1. e4 *\n\n[Event \"B\"]\n\n1. d4 *\n";
        std::fs::write(&path, changed).expect("insert game before selected row");

        let result = delete_with_snapshot(&directory, &path, 1, selected).await;

        assert!(matches!(result, Err(Error::StaleGame)));
        assert_eq!(std::fs::read(&path).expect("read unchanged PGN"), changed);
    }

    #[tokio::test]
    async fn delete_game_uses_revision_to_distinguish_moved_equal_text_duplicates() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("duplicate-delete.pgn");
        let duplicate = b"[Event \"Same\"]\n\n1. e4 *\n";
        let original = [duplicate.as_slice(), b"\n", duplicate.as_slice()].concat();
        std::fs::write(&path, &original).expect("write duplicate PGNs");
        let app = mock_app();
        let state = app.state::<AppState>();
        let selected = read_game_core(
            writable_for(&directory, &path),
            1,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await
        .expect("read second duplicate");
        assert_eq!(selected.stamp, game_stamp(duplicate));
        let inserted = b"[Event \"Inserted\"]\n\n1. c4 *\n\n";
        let changed = [inserted.as_slice(), original.as_slice()].concat();
        std::fs::write(&path, &changed).expect("shift duplicate rows");

        let result = delete_with_snapshot(&directory, &path, 1, selected).await;

        assert!(matches!(result, Err(Error::StaleGame)));
        assert_eq!(std::fs::read(&path).expect("read unchanged PGN"), changed);
    }

    #[tokio::test]
    async fn delete_game_refuses_when_the_selected_game_was_edited() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("edited-delete.pgn");
        std::fs::write(&path, b"[Event \"Before\"]\n\n1. e4 *\n").expect("write PGN");
        let app = mock_app();
        let state = app.state::<AppState>();
        let selected = read_game_core(
            writable_for(&directory, &path),
            0,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await
        .expect("read selected game");
        let changed = b"[Event \"Changed after display\"]\n\n1. d4 d5 *\n";
        std::fs::write(&path, changed).expect("edit selected game");

        let result = delete_with_snapshot(&directory, &path, 0, selected).await;

        assert!(matches!(result, Err(Error::StaleGame)));
        assert_eq!(std::fs::read(&path).expect("read unchanged PGN"), changed);
    }

    #[tokio::test]
    async fn delete_game_requires_the_selected_game_stamp_at_the_expected_revision() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("wrong-stamp-delete.pgn");
        let original = b"[Event \"Current\"]\n\n1. e4 *\n";
        std::fs::write(&path, original).expect("write PGN");
        let app = mock_app();
        let state = app.state::<AppState>();
        let mut selected = read_game_core(
            writable_for(&directory, &path),
            0,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await
        .expect("read selected game");
        selected.stamp = "different-game-stamp".into();

        let result = delete_with_snapshot(&directory, &path, 0, selected).await;

        assert!(matches!(result, Err(Error::StaleGame)));
        assert_eq!(std::fs::read(&path).expect("read unchanged PGN"), original);
    }

    #[tokio::test]
    async fn delete_game_refuses_an_out_of_range_row_as_stale_with_current_revision() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("missing-delete.pgn");
        let original = b"[Event \"Before\"]\n\n1. e4 *\n";
        std::fs::write(&path, original).expect("write PGN");
        let app = mock_app();
        let state = app.state::<AppState>();
        let selected = read_game_core(
            writable_for(&directory, &path),
            0,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await
        .expect("read selected game");

        let result = delete_with_snapshot(&directory, &path, 1, selected).await;

        assert!(matches!(result, Err(Error::StaleGame)));
        assert_eq!(std::fs::read(&path).expect("read unchanged PGN"), original);
    }

    #[tokio::test]
    async fn delete_game_rejects_a_changed_commit_snapshot_without_mutating_it() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("changed-commit-snapshot.pgn");
        let original = b"[Event \"Before\"]\n\n1. e4 *\n";
        std::fs::write(&path, original).expect("write PGN");
        let app = mock_app();
        let state = app.state::<AppState>();
        let repository = state.pgn_repository.clone();
        let resolved = writable_for(&directory, &path);
        let cancellation = CancellationToken::new();
        let (key, games) = scan_current(
            resolved.pgn_snapshot().expect("scan snapshot"),
            &repository,
            &cancellation,
        )
        .await
        .expect("scan current PGN");
        let target = games[0];
        let changed = b"[Event \"Changed externally\"]\n\n1. d4 d5 *\n";
        std::fs::write(&path, changed).expect("change PGN after scan");

        let result = commit_pgn_mutation(
            resolved,
            key,
            PgnMutation {
                target,
                replacement: None,
                expectation: Some(WriteExpectation::Game {
                    stamp: game_stamp(original),
                }),
                stale_on_snapshot_change: true,
                operation_name: "delete_game",
                rebind: None,
            },
            &repository,
            &cancellation,
        )
        .await;

        assert!(matches!(result, Err(Error::StaleGame)));
        assert_eq!(
            std::fs::read(&path).expect("read unchanged changed PGN"),
            changed
        );
    }

    #[tokio::test]
    #[cfg_attr(not(unix), ignore = "unported on this platform: f-20260914-10")]
    async fn delete_game_succeeds_when_the_selected_snapshot_is_unchanged() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("current-delete.pgn");
        let first = b"[Event \"First\"]\n\n1. e4 *\n";
        let second = b"[Event \"Second\"]\n\n1. d4 *\n";
        std::fs::write(&path, [first.as_slice(), b"\n", second.as_slice()].concat())
            .expect("write PGN");
        let app = mock_app();
        let state = app.state::<AppState>();
        let selected = read_game_core(
            writable_for(&directory, &path),
            1,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await
        .expect("read selected game");

        delete_with_snapshot(&directory, &path, 1, selected)
            .await
            .expect("delete current row");

        assert_eq!(
            std::fs::read(&path).expect("read edited PGN"),
            [first.as_slice(), b"\n"].concat()
        );
    }

    #[tokio::test]
    async fn read_game_stamps_exact_bom_prefixed_crlf_game_bytes() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("stamped-games.pgn");
        let first = b"[Event \"A\"]\r\n\r\n1. e4 *\r\n";
        let second = b"[Event \"B\"]\r\n\r\n1. d4 *\r\n";
        let mut fixture = b"\xef\xbb\xbf".to_vec();
        fixture.extend_from_slice(first);
        fixture.extend_from_slice(second);
        std::fs::write(&path, fixture).expect("write PGN fixture");
        let app = mock_app();
        let state = app.state::<AppState>();

        let game = read_game_core(
            resolved_for(&directory, &path),
            1,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await
        .expect("read second game with stamp");

        assert_eq!(game.pgn.as_bytes(), second);
        assert_eq!(game.stamp, game_stamp(second));
        assert!(game.present);
        assert!(!game.revision.is_empty());
    }

    #[tokio::test]
    async fn read_game_returns_the_empty_end_slot_and_rejects_beyond_it() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("end-slot.pgn");
        std::fs::write(&path, b"[Event \"A\"]\n\n1. e4 *\n").expect("write PGN fixture");
        let app = mock_app();
        let state = app.state::<AppState>();

        let end = read_game_core(
            resolved_for(&directory, &path),
            1,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await
        .expect("read the append slot");
        assert_eq!(end.pgn, "");
        assert_eq!(end.stamp, game_stamp(b""));
        assert!(!end.present);

        let beyond = read_game_core(
            resolved_for(&directory, &path),
            2,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await;
        assert!(matches!(beyond, Err(Error::InvalidInput(_))));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn game_cas_at_end_of_empty_file_appends_and_returns_readback_stamp() {
        use crate::infra::path_authority::PathAuthority;

        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("empty-capability.pgn");
        let registry = directory.path().join("registry.json");
        std::fs::write(&path, b"").expect("write empty PGN");
        let mut authority = PathAuthority::open(registry, vec![]).expect("open authority");
        let handle = promote_pgn_file(&mut authority, &path);
        let app = mock_app();
        {
            let state = app.state::<AppState>();
            state
                .pgn_path_authority
                .install(authority)
                .expect("path authority lock");
        }
        let before = {
            let state = app.state::<AppState>();
            read_game_core(
                resolve_pgn(
                    &state,
                    &handle,
                    crate::infra::path_authority::PathOperation::ReadPgn,
                )
                .expect("resolve empty PGN"),
                0,
                &CancellationToken::new(),
                &state.pgn_repository,
            )
            .await
            .expect("read empty slot")
        };
        assert!(!before.present);
        assert_eq!(before.stamp, game_stamp(b""));

        let submitted = "[Event \"Created\"]\n\n1. e4 *\n";
        let written = write_through_capability(&app, &handle, 0, submitted.into())
            .await
            .expect("CAS write into empty slot");
        let after = {
            let state = app.state::<AppState>();
            read_game_core(
                resolve_pgn(
                    &state,
                    &handle,
                    crate::infra::path_authority::PathOperation::ReadPgn,
                )
                .expect("resolve written PGN"),
                0,
                &CancellationToken::new(),
                &state.pgn_repository,
            )
            .await
            .expect("read written game")
        };
        assert!(after.present);
        assert_eq!(written.stamp.as_deref(), Some(after.stamp.as_str()));
        assert_eq!(written.revision.as_deref(), Some(after.revision.as_str()));
        assert_eq!(
            written.revision.as_deref(),
            Some(
                file_revision_through_capability(&app, &handle)
                    .await
                    .expect("revision after write")
                    .as_str()
            )
        );
        assert_eq!(after.pgn.trim(), submitted.trim());
    }

    #[tokio::test]
    async fn stale_game_cas_refuses_without_changing_file_bytes() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("stale-cas.pgn");
        let original = b"[Event \"Before\"]\n\n1. e4 *\n";
        std::fs::write(&path, original).expect("write initial PGN");
        let app = mock_app();
        let state = app.state::<AppState>();
        let stale = read_game_core(
            writable_for(&directory, &path),
            0,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await
        .expect("read original game");
        let changed = b"[Event \"External\"]\n\n1. d4 d5 2. c4 *\n";
        std::fs::write(&path, changed).expect("external in-place write");

        let lease = state.operations.accept("write_game").expect("accept write");
        let result = write_game_core(
            lease,
            writable_for(&directory, &path),
            0,
            "[Event \"Replacement\"]\n\n1. c4 *\n".into(),
            WriteExpectation::Game { stamp: stale.stamp },
            state.pgn_repository.clone(),
            None,
        )
        .await;

        assert!(matches!(result, Err(Error::StaleGame)));
        assert_eq!(std::fs::read(&path).expect("read unchanged PGN"), changed);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn append_expectation_succeeds_at_end_and_rejects_after_another_append() {
        use crate::infra::path_authority::PathAuthority;

        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("append-cas.pgn");
        let registry = directory.path().join("registry.json");
        std::fs::write(&path, b"[Event \"A\"]\n\n1. e4 *\n").expect("write initial PGN");
        let mut authority = PathAuthority::open(registry, vec![]).expect("open authority");
        let handle = promote_pgn_file(&mut authority, &path);
        let app = mock_app();
        let state = app.state::<AppState>();
        state
            .pgn_path_authority
            .install(authority)
            .expect("path authority lock");
        let result = write_game_core(
            state
                .operations
                .accept("write_game")
                .expect("accept append"),
            resolve_pgn(
                &state,
                &handle,
                crate::infra::path_authority::PathOperation::WritePgn,
            )
            .expect("resolve writable PGN"),
            1,
            "[Event \"B\"]\n\n1. d4 *\n".into(),
            WriteExpectation::Append,
            state.pgn_repository.clone(),
            Some(PgnCapabilityRebind {
                authority: state.pgn_path_authority.clone(),
                path_ref: handle.path_ref().clone(),
                binding: None,
            }),
        )
        .await
        .expect("append at current end");
        assert!(result.stamp.is_some());
        let after_first = std::fs::read(&path).expect("read first append");
        let stale = append_through_capability(
            &app,
            &handle,
            1,
            "[Event \"Wrong end\"]\n\n1. c4 *\n".into(),
        )
        .await;
        assert!(matches!(stale, Err(Error::StaleGame)));
        assert_eq!(
            std::fs::read(&path).expect("read after stale append"),
            after_first
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(unix)]
    async fn committed_write_returns_no_stamp_if_post_commit_readback_differs() {
        use crate::infra::path_authority::PathAuthority;

        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("post-commit-change.pgn");
        let registry = directory.path().join("registry.json");
        std::fs::write(&path, b"[Event \"A\"]\n\n1. e4 *\n").expect("write initial PGN");
        let mut authority = PathAuthority::open(registry, vec![]).expect("open authority");
        let handle = promote_pgn_file(&mut authority, &path);
        let app = mock_app();
        let state = app.state::<AppState>();
        state
            .pgn_path_authority
            .install(authority)
            .expect("path authority lock");
        let (hook, entered, release) = BoundedHook::new();
        state
            .pgn_repository
            .set_post_commit_hook(Some(hook))
            .expect("set post-commit hook");
        let writer_app = app.clone();
        let writer_handle = handle.clone();
        let task = tokio::spawn(async move {
            write_through_capability(
                &writer_app,
                &writer_handle,
                0,
                "[Event \"Written\"]\n\n1. d4 *\n".into(),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), entered)
            .await
            .expect("post-commit hook entry timeout")
            .expect("post-commit hook entry");
        std::fs::write(&path, b"[Event \"External\"]\n\n1. c4 *\n")
            .expect("external in-place write after commit");
        drop(release);

        let written = task.await.expect("join writer").expect("committed write");
        assert_eq!(written.stamp, None);
        assert_eq!(written.revision, None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(unix)]
    async fn committed_write_returns_success_without_stamp_if_readback_fails() {
        use crate::infra::path_authority::PathAuthority;

        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("post-commit-read-failure.pgn");
        let registry = directory.path().join("registry.json");
        std::fs::write(&path, b"[Event \"A\"]\n\n1. e4 *\n").expect("write initial PGN");
        let mut authority = PathAuthority::open(registry, vec![]).expect("open authority");
        let handle = promote_pgn_file(&mut authority, &path);
        let app = mock_app();
        let state = app.state::<AppState>();
        state
            .pgn_path_authority
            .install(authority)
            .expect("path authority lock");
        let (hook, entered, release) = BoundedHook::new();
        state
            .pgn_repository
            .set_post_commit_hook(Some(hook))
            .expect("set post-commit hook");
        let writer_app = app.clone();
        let writer_handle = handle.clone();
        let task = tokio::spawn(async move {
            write_through_capability(
                &writer_app,
                &writer_handle,
                0,
                "[Event \"Written\"]\n\n1. d4 *\n".into(),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), entered)
            .await
            .expect("post-commit hook entry timeout")
            .expect("post-commit hook entry");
        std::fs::write(&path, b"[Event \"External\"]\n\n\xff\n")
            .expect("replace bytes with invalid UTF-8 after commit");
        drop(release);

        let written = task.await.expect("join writer").expect("committed write");
        assert_eq!(written.stamp, None);
        assert_eq!(written.revision, None);
    }

    #[tokio::test]
    async fn cancel_long_single_game_read() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("long-game.pgn");
        let mut content = String::from("[Event \"Long Game\"]\n\n");
        while content.len() < 128 * 1024 {
            content.push_str(
                "1. e4 e5 2. Nf3 Nc6 { Comment padding to ensure multiple read chunks } ",
            );
        }
        content.push_str("1-0\n");
        std::fs::write(&path, content.as_bytes()).expect("write large PGN");

        let app = mock_app();
        let state = app.state::<AppState>();
        let resolved = resolved_for(&directory, &path);
        let token = CancellationToken::new();

        let (hook, entered, release) = BoundedHook::new();
        state
            .pgn_repository
            .set_read_chunk_hook(Some(hook))
            .expect("set read chunk hook");

        let repo = state.pgn_repository.clone();
        let token_clone = token.clone();
        let read_task =
            tokio::spawn(async move { read_games_core(resolved, 0, 0, &token_clone, &repo).await });

        // Prove stopping already-running actual read work: wait until chunk reading is active
        tokio::time::timeout(Duration::from_secs(5), entered)
            .await
            .expect("read chunk entered timeout")
            .expect("entered must receive");

        // Cancel while running in the chunk reading loop
        token.cancel();
        drop(release);

        let result = read_task.await.expect("read task must join");
        assert!(matches!(result, Err(Error::Cancellation)));
    }

    #[test]
    fn ranges_preserve_bom_line_endings_and_comment_headers() {
        let data = b"\xef\xbb\xbf[Event \"A\"]\r\n\r\n1. e4 {\r\n[Event \"not a tag\"]\r\n} e5\r\n[Event \"B\"]\r\n\r\n1. d4\r\n";
        let ranges = scan_games(Cursor::new(data)).expect("scan PGN");
        assert_eq!(ranges.len(), 2);
        assert_eq!(
            &data[ranges[0].start as usize..ranges[0].end as usize],
            b"[Event \"A\"]\r\n\r\n1. e4 {\r\n[Event \"not a tag\"]\r\n} e5\r\n"
        );
    }

    #[test]
    fn empty_short_and_invalid_utf8_inputs_are_exact() {
        assert!(scan_games(Cursor::new(b"".as_slice()))
            .expect("empty scan")
            .is_empty());
        assert!(scan_games(Cursor::new(b"\xef\xbb".as_slice())).is_err());
        assert!(scan_games(Cursor::new(b"\xff".as_slice())).is_err());
    }

    fn pickup_parser_events(data: &[u8], skip: bool) -> Vec<Vec<u8>> {
        struct Events {
            event: Vec<u8>,
            skip: bool,
        }

        impl pgn_reader::Visitor for Events {
            type Result = Vec<u8>;

            fn header(&mut self, key: &[u8], value: pgn_reader::RawHeader<'_>) {
                if key == b"Event" {
                    self.event = value.as_bytes().to_vec();
                }
            }

            fn end_headers(&mut self) -> pgn_reader::Skip {
                pgn_reader::Skip(self.skip)
            }

            fn end_game(&mut self) -> Self::Result {
                std::mem::take(&mut self.event)
            }
        }

        let mut reader = pgn_reader::BufferedReader::new(Cursor::new(data));
        let mut visitor = Events {
            event: Vec::new(),
            skip,
        };
        let mut events = Vec::new();
        while let Some(event) = reader
            .read_game(&mut visitor)
            .expect("parse pickup fixture")
        {
            events.push(event);
        }
        events
    }

    fn assert_pickup_header_ranges(expected_games: &[&str], expected_events: &[&[u8]]) {
        assert_pickup_header_ranges_and_sans(expected_games, expected_events, None);
    }

    fn pickup_parser_sans(data: &[u8]) -> Vec<usize> {
        struct Sans {
            count: usize,
        }

        impl pgn_reader::Visitor for Sans {
            type Result = usize;

            fn san(&mut self, _san: pgn_reader::SanPlus) {
                self.count += 1;
            }

            fn end_game(&mut self) -> Self::Result {
                std::mem::take(&mut self.count)
            }
        }

        let mut reader = pgn_reader::BufferedReader::new(Cursor::new(data));
        let mut visitor = Sans { count: 0 };
        let mut sans = Vec::new();
        while let Some(count) = reader
            .read_game(&mut visitor)
            .expect("parse pickup SAN fixture")
        {
            sans.push(count);
        }
        sans
    }

    fn assert_pickup_header_ranges_and_sans(
        expected_games: &[&str],
        expected_events: &[&[u8]],
        expected_sans: Option<&[usize]>,
    ) {
        assert_eq!(expected_games.len(), expected_events.len());
        if let Some(expected_sans) = expected_sans {
            assert_eq!(expected_games.len(), expected_sans.len());
        }
        let mut failures = Vec::new();
        assert_scan_fixture_variants("", expected_games, |data, ranges| {
            for skip in [false, true] {
                let events = pickup_parser_events(data, skip);
                println!(
                    "pickup: skip={skip}, data={data:?}, ranges={ranges:?}, events={events:?}"
                );
                if events != expected_events || events.len() != ranges.len() {
                    failures.push(format!("skip={skip}, data={data:?}, events={events:?}"));
                }
                if !skip {
                    if let Some(expected_sans) = expected_sans {
                        let sans = pickup_parser_sans(data);
                        if sans != expected_sans {
                            failures.push(format!("sans data={data:?}, sans={sans:?}"));
                        }
                    }
                }
                for (index, (range, expected_event)) in
                    ranges.iter().zip(expected_events).enumerate()
                {
                    let bytes = &data[range.start as usize..range.end as usize];
                    let events = pickup_parser_events(bytes, skip);
                    if events != [*expected_event] {
                        failures.push(format!("skip={skip}, range={range:?}, events={events:?}"));
                    }
                    if !skip {
                        if let Some(expected_sans) = expected_sans {
                            let sans = pickup_parser_sans(bytes);
                            if sans != [expected_sans[index]] {
                                failures.push(format!("sans range={range:?}, sans={sans:?}"));
                            }
                        }
                    }
                }
            }
        });
        assert!(
            failures.is_empty(),
            "real parser header events: {failures:#?}"
        );
    }

    #[test]
    fn pgn_scanner_pickup_header_key_horizontal_separators() {
        for separator in [" ", "  ", "\t", " \t ", "\t \t"] {
            assert_pickup_header_ranges(
                &[
                    &format!("[Event{separator}\" A \"]\n\n1. e4 *\n"),
                    &format!("[Event{separator}\"B\"]\n\n1. d4 *\n"),
                ],
                &[b" A ", b"B"],
            );
        }
    }

    #[test]
    fn pgn_scanner_pickup_c1_percent_after_blank_separator() {
        assert_pickup_header_ranges(
            &["[Event \"A\"]\n\n% comment\n", "[Event \"B\"]\n"],
            &[b"A", b"B"],
        );
    }

    #[test]
    fn pgn_scanner_pickup_c2_indented_percent_continues_headers() {
        for indent in [" ", "\t", " \t"] {
            assert_pickup_header_ranges(
                &[&format!(
                    "[Event \"A\"]\n{indent}% comment\n[Event \"B\"]\n"
                )],
                &[b"B"],
            );
        }
    }

    #[test]
    fn pgn_scanner_pickup_p1_indented_tag_continues_headers() {
        for indent in [" ", "\t", " \t"] {
            assert_pickup_header_ranges(
                &[&format!(
                    "[Event \"A\"]\n{indent}[Site \"X\"]\n[Event \"B\"]\n"
                )],
                &[b"B"],
            );
        }
    }

    #[test]
    fn pgn_scanner_pickup_pl1_indented_next_game_header() {
        for indent in [" ", "\t", " \t"] {
            assert_pickup_header_ranges(
                &["[Event \"A\"]\n\n", &format!("{indent}[Event \"B\"]\n")],
                &[b"A", b"B"],
            );
        }
    }

    #[test]
    fn pgn_scanner_pickup_escape_and_whitespace_boundary_matrix() {
        for indent in ["", " ", "\t", " \t"] {
            for separator in ["\n", " \t\n"] {
                for escapes in ["% { ignored\n", "% { ignored\n\t% } ignored\n"] {
                    for moves in ["", "1. e4 *\n"] {
                        assert_pickup_header_ranges(
                            &[
                                &format!("[Event \"A\"]\n{separator}{moves}{escapes}"),
                                &format!("{indent}[Event \"B\"]\n"),
                            ],
                            &[b"A", b"B"],
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn pgn_scanner_pickup_header_only_before_movetext() {
        assert_pickup_header_ranges(
            &["[Event \"empty\"]\n\n", "[Event \"B\"]\n\n1. e4 *"],
            &[b"empty", b"B"],
        );
    }

    #[test]
    fn pgn_scanner_pickup_two_header_only_games() {
        assert_pickup_header_ranges(&["[Event \"A\"]\n\n", "[Event \"B\"]\n"], &[b"A", b"B"]);
    }

    #[test]
    fn pgn_scanner_pickup_header_line_semicolon_ends_block() {
        for first_game in ["[Event \"A\"]\n; comment\n", "[Event \"A\"]\n; { comment\n"] {
            assert_pickup_header_ranges(&[first_game, "[Event \"B\"]\n\n1. e4 *"], &[b"A", b"B"]);
        }
    }

    #[test]
    fn pgn_scanner_pickup_header_line_percent_keeps_block() {
        for game in [
            "[Event \"A\"]\n% comment\n[Site \"B\"]\n\n1. e4 *",
            "[Event \"A\"]\n% { comment\n[Site \"B\"]\n\n1. e4 *",
        ] {
            assert_pickup_header_ranges(&[game], &[b"A"]);
        }
    }

    #[test]
    fn pgn_scanner_pickup_adjacent_and_inline_headers_stay_together() {
        assert_pickup_header_ranges(
            &["[Event \"{literal\"] [Site \"X\\\"Y\"]\n[White \"W\"]\n\n"],
            &[b"{literal"],
        );
    }

    #[test]
    fn pgn_scanner_pickup_blank_lines_inside_brace_comments_do_not_split() {
        assert_pickup_header_ranges(
            &[
                "[Event \"A\"]\n\n{\n\n[Event \"comment\"]\n\n}\n",
                "[Event \"B\"]\n\n1. e4 *",
            ],
            &[b"A", b"B"],
        );
    }

    #[test]
    fn pgn_scanner_pickup_blank_line_inside_headed_movetext_is_one_game() {
        assert_pickup_header_ranges_and_sans(
            &["[Event \"A\"]\n\n1. e4 e5\n\n2. Nf3 Nc6 *"],
            &[b"A"],
            Some(&[4]),
        );
    }

    #[test]
    fn pgn_scanner_pickup_blank_line_after_comment_line_is_one_game() {
        assert_pickup_header_ranges_and_sans(
            &["[Event \"A\"]\n\n{intro}\n\n1. e4 e5\n\n2. Nf3 Nc6 *"],
            &[b"A"],
            Some(&[4]),
        );
    }

    #[test]
    fn pgn_scanner_pickup_headed_games_separated_by_blank_and_tag_stay_two() {
        assert_pickup_header_ranges_and_sans(
            &["[Event \"A\"]\n\n1. e4 *\n", "[Event \"B\"]\n\n1. d4 *"],
            &[b"A", b"B"],
            Some(&[1, 1]),
        );
    }

    struct PickupOneByteReader<R> {
        inner: R,
        reads: usize,
        error_on_read: Option<(usize, io::ErrorKind)>,
    }

    impl<R: Read> Read for PickupOneByteReader<R> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.reads += 1;
            if let Some((read, kind)) = self.error_on_read {
                if self.reads == read {
                    return Err(io::Error::new(kind, "pickup injected read error"));
                }
            }
            let len = buffer.len().min(1);
            self.inner.read(&mut buffer[..len])
        }
    }

    impl<R: Seek> Seek for PickupOneByteReader<R> {
        fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
            self.inner.seek(position)
        }
    }

    #[test]
    fn pgn_scanner_pickup_bom_probe_handles_short_reads_and_interruptions() {
        for data in [
            b"\xef\xbb\xbf[Event \"A\"]\r\n\r\n1. e4 *\r\n".as_slice(),
            b"[Event \"A\"]\n\n1. e4 *\n".as_slice(),
            b"*".as_slice(),
            b"*\n".as_slice(),
            b" ".as_slice(),
            b"".as_slice(),
            b"\xef\xbb\xbf".as_slice(),
        ] {
            let expected = scan_games(Cursor::new(data)).expect("scan contiguous fixture");
            for error_on_read in [None, Some((2, io::ErrorKind::Interrupted))] {
                let ranges = scan_games(PickupOneByteReader {
                    inner: Cursor::new(data),
                    reads: 0,
                    error_on_read,
                })
                .expect("scan one-byte reads");
                println!("pickup short reads: data={data:?}, error={error_on_read:?}, {ranges:?}");
                assert_eq!(ranges.len(), expected.len());
                for (range, expected) in ranges.iter().zip(&expected) {
                    assert_eq!((range.start, range.end), (expected.start, expected.end));
                }
                if let Some(range) = ranges.first() {
                    let start = if data.starts_with(b"\xef\xbb\xbf") {
                        3
                    } else {
                        0
                    };
                    assert_eq!((range.start, range.end), (start, data.len() as u64));
                } else {
                    assert!(data.is_empty() || data == b" " || data == b"\xef\xbb\xbf");
                }
            }
        }
    }

    #[test]
    fn pgn_scanner_pickup_bom_probe_preserves_invalid_data_and_read_errors() {
        for data in [b"\xef".as_slice(), b"\xef\xbb".as_slice()] {
            for error_on_read in [None, Some((2, io::ErrorKind::Interrupted))] {
                assert_eq!(
                    scan_games(PickupOneByteReader {
                        inner: Cursor::new(data),
                        reads: 0,
                        error_on_read,
                    })
                    .expect_err("partial BOM is invalid UTF-8")
                    .kind(),
                    io::ErrorKind::InvalidData
                );
            }
        }
        assert_eq!(
            scan_games(PickupOneByteReader {
                inner: Cursor::new(b"\xef\xbb\xbf"),
                reads: 0,
                error_on_read: Some((2, io::ErrorKind::PermissionDenied)),
            })
            .expect_err("probe read error must propagate")
            .kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn signed_bounds_are_checked_before_conversion() {
        assert!(checked_index(-1).is_err());
        assert!(checked_range(-1, 0).is_err());
        assert!(checked_range(1, 0).is_err());
        assert!(checked_range(0, 1_000).is_err());
        assert_eq!(checked_range(0, 999).expect("bounded range"), (0, 1_000));
    }

    #[test]
    fn header_clusters_and_malformed_headers_do_not_split_games() {
        let data = b"[Event \"A\"]\n[Site \"x\\\"y\"]\n\n1. e4\n[Event \"B\"]\n\n1. d4\n[Event \"unterminated]\n";
        let ranges = scan_games(Cursor::new(data)).expect("scan PGN");
        assert_eq!(ranges.len(), 2);
        assert_eq!(
            &data[ranges[1].start as usize..ranges[1].end as usize],
            b"[Event \"B\"]\n\n1. d4\n[Event \"unterminated]\n"
        );
    }

    #[test]
    fn tag_header_grammar_accepts_underscore_and_rejects_empty_tag_names() {
        assert!(is_tag_header("[Tag_Name \"value\"]\n", false));
        assert!(!is_tag_header("[ \"value\"]\n", false));
        assert!(!is_tag_header("[Tag-Name \"value\"]\n", false));
        assert!(!is_tag_header("[Tag_Name \"value\"]\n", true));
    }

    #[test]
    fn inline_tag_header_spans_and_scanner_share_escaped_grammar() {
        let data = b"\xef\xbb\xbf \t[Event \"A\"] [Site \"X\\\"Y\"]\r\n[White \"W\"]\r\n\r\n1. e4 *\r\n[Event \"B\"] [Site \"Z\"]\r\n\r\n1. d4 *\r\n";
        let ranges = scan_games(Cursor::new(data)).unwrap();
        assert_eq!(
            ranges.len(),
            2,
            "inline tags split a single game into fragments"
        );
        assert!(data[ranges[0].start as usize..ranges[0].end as usize].ends_with(b"1. e4 *\r\n"));
        assert!(is_tag_header(
            " [Event \"A\"]\t[Site \"X\\\"Y\"]\r\n",
            false
        ));
        assert!(!is_tag_header("[Event \"A\"] [Broken]", false));
        assert!(!is_tag_header("[Event \"A\"] 1. e4", false));
        // The sibling preface report is not assumed to be a scanner failure.
        for prefix in ["% preface\n", "; preface\n"] {
            let input = format!("{prefix}[Event \"A\"]\n\n1. e4 *\n");
            let ranges = scan_games(Cursor::new(input.as_bytes())).unwrap();
            assert_eq!(ranges.len(), 1);
            assert_eq!(
                &input[ranges[0].start as usize..],
                "[Event \"A\"]\n\n1. e4 *\n"
            );
        }
    }

    #[test]
    fn braces_in_quoted_tag_values_do_not_start_comments() {
        let data = b"[Event \"{literal\"]\n\n1. e4\n[Event \"B\"]\n\n1. d4\n";
        assert_eq!(scan_games(Cursor::new(data)).expect("scan PGN").len(), 2);
    }

    #[test]
    fn quoted_literal_brace_without_semicolon_does_not_start_a_comment() {
        assert_scan_variants(
            "",
            &[
                "[Event \"A\"]\n\n1. e4 \"quoted { literal\" e5\n",
                "[Event \"B\"]\n\n1. d4\n",
            ],
        );
    }

    #[test]
    fn escaped_quote_before_literal_brace_keeps_the_brace_quoted() {
        assert_scan_variants(
            "",
            &[
                "[Event \"A\"]\n\n1. e4 \"quoted \\\" { literal\" e5\n",
                "[Event \"B\"]\n\n1. d4\n",
            ],
        );
    }

    #[test]
    fn unterminated_comment_after_a_closing_quote_is_invalid_data() {
        assert_invalid_scan_variants("[Event \"A\"]\n\n1. e4 \"quoted literal\" {unterminated\n");
    }

    #[test]
    fn quoted_semicolon_before_an_unterminated_comment_is_invalid_data() {
        assert_invalid_scan_variants("[Event \"A\"]\n\n1. e4 \"quoted ; literal\" {unterminated\n");
    }

    #[test]
    fn percent_escape_lines_with_unmatched_braces_do_not_mask_games() {
        assert_scan_variants(
            "% { unmatched before games\n",
            &[
                "[Event \"A\"]\n\n1. e4\n% { unmatched between games\n",
                "[Event \"B\"]\n\n1. d4\n",
            ],
        );
    }

    #[test]
    fn inline_semicolon_comments_cannot_open_brace_comments() {
        let data = b"[Event \"A\"]\n\n1. e4 ; { ignored\n[Event \"B\"]\n\n1. d4\n";
        let ranges = scan_games(Cursor::new(data)).expect("scan PGN");
        assert_eq!(ranges.len(), 2);
        assert_eq!(
            &data[ranges[0].start as usize..ranges[0].end as usize],
            b"[Event \"A\"]\n\n1. e4 ; { ignored\n"
        );
        assert_eq!(
            &data[ranges[1].start as usize..ranges[1].end as usize],
            b"[Event \"B\"]\n\n1. d4\n"
        );
    }

    #[test]
    fn semicolons_and_braces_inside_comments_and_quoted_movetext_keep_their_context() {
        let data = b"[Event \"A\"]\n\n1. e4 { ; remains a brace comment\n} \"quoted ; { ignored\" e5\n[Event \"B\"]\n\n1. d4\n";
        let ranges = scan_games(Cursor::new(data)).expect("scan PGN");
        assert_eq!(ranges.len(), 2);
        assert_eq!(
            &data[ranges[0].start as usize..ranges[0].end as usize],
            b"[Event \"A\"]\n\n1. e4 { ; remains a brace comment\n} \"quoted ; { ignored\" e5\n"
        );
    }

    #[test]
    fn line_comments_and_unclosed_brace_comments_are_handled_explicitly() {
        let data =
            b"  ; { [Event \"ignored\"]\n\t% [Event \"ignored too\"]\n[Event \"A\"]\n\n1. e4\n";
        assert_eq!(scan_games(Cursor::new(data)).expect("scan PGN").len(), 1);
        assert!(scan_games(Cursor::new(
            b"[Event \"A\"]\n\n1. e4 {unterminated".as_slice()
        ))
        .is_err());
        let comment_close = b"[Event \"A\"]\n\n1. e4 {\n; }\n[Event \"B\"]\n\n1. d4\n";
        assert_eq!(
            scan_games(Cursor::new(comment_close))
                .expect("brace closes inside comment")
                .len(),
            2
        );
    }

    #[test]
    fn oversized_line_fails_before_string_allocation() {
        for (content_bytes, newline, expected_ok) in [
            (MAX_LINE_LEN - 1, true, true),
            (MAX_LINE_LEN, false, true),
            (MAX_LINE_LEN, true, false),
            (MAX_LINE_LEN + 1, false, false),
        ] {
            let mut data = vec![b'x'; content_bytes];
            if newline {
                data.push(b'\n');
            }
            assert_eq!(scan_games(Cursor::new(data)).is_ok(), expected_ok);
        }
    }

    #[test]
    fn scan_file_accepts_a_generated_300_mib_pgn() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("large.pgn");
        let file = File::create(&path).expect("create large PGN");
        let mut writer = BufWriter::new(file);
        writer
            .write_all(b"% generated without a corpus-sized fixture\n")
            .expect("write PGN preface");
        let mut comment_line = vec![b'a'; MAX_LINE_LEN - 1];
        comment_line.push(b'\n');
        for game in 0..301 {
            writeln!(writer, "[Event \"{game}\"]\n\n1. e4 {{").expect("write game header");
            writer
                .write_all(&comment_line)
                .expect("write bounded comment line");
            writer.write_all(b"} e5 1/2-1/2\n\n").expect("finish game");
        }
        writer.flush().expect("flush large PGN");

        let snapshot = snapshot_for(&directory, &path);
        let read_file = snapshot.file.try_clone().expect("clone PGN descriptor");
        assert!(snapshot.revision.size > 300 * 1024 * 1024);
        let expected_size = snapshot.revision.size;
        let (_, games) = scan_file(&snapshot, &CancellationToken::new()).expect("scan large PGN");
        assert_eq!(games.len(), 301);
        assert_eq!(games[300].end, expected_size);
        let late_page = read_ranges(read_file, games[300..].to_vec(), &CancellationToken::new())
            .expect("read final game");
        assert_eq!(late_page.len(), 1);
        assert!(late_page[0].starts_with("[Event \"300\"]"));
        assert!(late_page[0].ends_with("} e5 1/2-1/2\n\n"));
    }

    #[test]
    fn scan_file_reads_a_late_page_beyond_100_000_games() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("many-games.pgn");
        let file = File::create(&path).expect("create many-game PGN");
        let mut writer = BufWriter::new(file);
        for game in 0..100_005 {
            writeln!(writer, "[Event \"{game}\"]\n\n1. e4\n").expect("write game");
        }
        writer.flush().expect("flush many-game PGN");

        let snapshot = snapshot_for(&directory, &path);
        let read_file = snapshot.file.try_clone().expect("clone PGN descriptor");
        let (_, games) =
            scan_file(&snapshot, &CancellationToken::new()).expect("scan many-game PGN");
        assert_eq!(games.len(), 100_005);
        let late_page = read_ranges(
            read_file,
            games[100_000..100_005].to_vec(),
            &CancellationToken::new(),
        )
        .expect("read late page");
        assert_eq!(late_page.len(), 5);
        assert!(late_page[0].contains("[Event \"100000\"]"));
        assert!(late_page[4].contains("[Event \"100004\"]"));
    }

    #[tokio::test]
    async fn cache_hits_share_range_storage() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("cache.pgn");
        std::fs::write(&path, b"[Event \"A\"]\n\n1. e4\n").expect("write PGN");
        let resolved = resolved_for(&directory, &path);
        let repository = PgnRepository::default();
        let (_, scanned) = scan_current(
            resolved.pgn_snapshot().expect("first snapshot"),
            &repository,
            &CancellationToken::new(),
        )
        .await
        .expect("initial scan");
        let (_, hit) = scan_current(
            resolved.pgn_snapshot().expect("second snapshot"),
            &repository,
            &CancellationToken::new(),
        )
        .await
        .expect("cached scan");
        assert!(Arc::ptr_eq(&scanned, &hit));
    }

    #[test]
    fn post_epoch_revision_string_keeps_unsigned_mtime_digits() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("timed.pgn");
        std::fs::write(&path, b"1. e4 *").expect("write PGN");
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open PGN")
            .set_modified(std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1))
            .expect("set post-epoch mtime");
        let snapshot = snapshot_for(&directory, &path);
        let metadata = std::fs::metadata(&path).expect("PGN metadata");
        assert_eq!(snapshot.revision.size, metadata.len());
        assert_eq!(
            snapshot.revision.mtime_nanos,
            i128::try_from(
                metadata
                    .modified()
                    .expect("PGN mtime")
                    .duration_since(std::time::SystemTime::UNIX_EPOCH)
                    .expect("post-epoch mtime")
                    .as_nanos()
            )
            .expect("mtime fits signed nanoseconds")
        );
        assert!(snapshot.revision.mtime_nanos > 0);
        let rendered = revision_string(&snapshot);
        let (device, inode) = snapshot.identity.pair();
        assert_eq!(
            rendered,
            format!(
                "{device}:{inode}:{}:{}:{}",
                snapshot.revision.size,
                snapshot.revision.mtime_nanos,
                snapshot.revision.ctime_nanos
            )
        );
        let mtime = snapshot.revision.mtime_nanos.to_string();
        assert!(
            !mtime.starts_with('-'),
            "post-1970 mtime digits must stay unsigned: {mtime}"
        );
    }

    /// A same-length in-place rewrite that restores the last-write timestamp must still miss the
    /// offset cache. On Unix the inode `ctime` moves; on Windows the open handle's `ChangeTime`
    /// does. The rewrite goes through the pathname (`std::fs::write`) so identity, size and mtime
    /// stay equal and only the change stamp separates the two snapshots.
    #[tokio::test]
    async fn same_length_rewrite_restoring_mtime_misses_offset_cache() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("rewrite.pgn");
        let two_games = b"[Event \"A\"]\n\n1. e4\n[Event \"B\"]\n\n1. d4\n";
        std::fs::write(&path, two_games).expect("write two-game PGN");
        let resolved = resolved_for(&directory, &path);

        let first_mtime = std::fs::metadata(&path)
            .expect("read metadata")
            .modified()
            .expect("read modified time");
        let first = resolved.pgn_snapshot().expect("first snapshot");
        let first_identity = first.identity.clone();
        let first_revision = first.revision.clone();
        let repository = PgnRepository::default();
        let (_, first_games) = scan_current(first, &repository, &CancellationToken::new())
            .await
            .expect("initial scan");
        assert_eq!(first_games.len(), 2);

        // A one-game PGN padded with trailing whitespace to the exact byte length of the two-game
        // file, so the rewrite preserves `size` and cannot be blamed on a length change.
        let mut one_game = b"[Event \"A\"]\n\n1. e4\n".to_vec();
        one_game.resize(two_games.len(), b' ');
        std::fs::write(&path, &one_game).expect("same-length in-place rewrite");
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open rewrite for timestamp restore")
            .set_modified(first_mtime)
            .expect("restore last-write timestamp");

        let second = resolved.pgn_snapshot().expect("second snapshot");
        assert_eq!(
            second.identity, first_identity,
            "in-place rewrite keeps the same identity"
        );
        assert_eq!(
            second.revision.size, first_revision.size,
            "rewrite preserves the byte length"
        );
        assert_eq!(
            second.revision.mtime_nanos, first_revision.mtime_nanos,
            "rewrite restores the last-write timestamp"
        );
        #[cfg(windows)]
        assert_ne!(
            second.revision.ctime_nanos, first_revision.ctime_nanos,
            "ChangeTime must move when a rewrite restores LastWriteTime"
        );

        let (_, second_games) = scan_current(second, &repository, &CancellationToken::new())
            .await
            .expect("rescan after rewrite");
        assert!(
            !Arc::ptr_eq(&first_games, &second_games),
            "stale offset ranges must not be reused after the rewrite"
        );
        assert_eq!(second_games.len(), 1, "rewritten PGN holds one game");
    }

    /// Pins the Windows change stamp to an inline `GetFileInformationByHandleEx(FileBasicInfo)`
    /// query inside `pgn_snapshot_file`. Extracting it beside `windows_file_identity` would move
    /// the tokens out of the acceptance slice, so the pin reads the producer text directly.
    #[test]
    fn windows_pgn_revision_stamp_source_pin() {
        use crate::infra::blocking::source_scan::body_at_indent;

        let source = include_str!("infra/path_authority/resolved.rs");
        let slice = body_at_indent(source, "fn pgn_snapshot_file");
        assert!(
            slice.contains("GetFileInformationByHandleEx"),
            "the Windows change stamp must query the already-open handle"
        );
        assert!(
            slice.contains("ChangeTime"),
            "the Windows change stamp must be FILE_BASIC_INFO.ChangeTime"
        );
        assert!(
            !slice.contains("creation_time"),
            "the Windows change stamp must not fall back to creation_time"
        );
    }

    #[test]
    fn cache_byte_eviction_replacement_and_invalidation_account_exactly() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("cache-accounting.pgn");
        std::fs::write(&path, b"[Event \"A\"]\n\n1. e4\n").expect("write PGN");
        let base = snapshot_key(&snapshot_for(&directory, &path));
        let range_bytes = std::mem::size_of::<GameRange>();
        let repository = PgnRepository {
            inner: Arc::new(std::sync::Mutex::new(PgnRepositoryInner::default())),
            edit_locks: Arc::new(KeyedLocks::default()),
            cache_byte_limit: range_bytes * 4,
        };
        let key_one = key_with_size(&base, 1);
        let key_two = key_with_size(&base, 2);
        let key_three = key_with_size(&base, 3);
        let two_ranges: Arc<[GameRange]> = vec![GameRange { start: 0, end: 1 }; 2].into();
        repository
            .retain_if_within_budget(key_one.clone(), two_ranges.clone())
            .expect("insert first scan");
        repository
            .retain_if_within_budget(key_two.clone(), two_ranges.clone())
            .expect("insert second scan");
        assert!(repository
            .get(&key_one)
            .expect("touch first scan")
            .is_some());
        repository
            .retain_if_within_budget(key_three.clone(), two_ranges)
            .expect("insert third scan");
        assert!(repository.get(&key_one).expect("read first scan").is_some());
        assert!(repository
            .get(&key_two)
            .expect("read evicted scan")
            .is_none());
        assert!(repository
            .get(&key_three)
            .expect("read third scan")
            .is_some());

        let one_range: Arc<[GameRange]> = vec![GameRange { start: 0, end: 1 }].into();
        repository
            .retain_if_within_budget(key_one.clone(), one_range)
            .expect("replace first scan");
        assert_eq!(
            repository.inner().expect("inspect cache").retained_bytes,
            range_bytes * 3
        );
        repository
            .invalidate(&base.identity)
            .expect("invalidate identity");
        let inner = repository.inner().expect("inspect invalidated cache");
        assert!(inner.cache.is_empty());
        assert_eq!(inner.retained_bytes, 0);
    }

    #[tokio::test]
    async fn oversized_scan_is_returned_but_not_retained() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("oversized-cache.pgn");
        std::fs::write(&path, b"[Event \"A\"]\n\n1. e4\n[Event \"B\"]\n\n1. d4\n")
            .expect("write PGN");
        let resolved = resolved_for(&directory, &path);
        let snapshot = resolved.pgn_snapshot().expect("snapshot PGN");
        let read_file = snapshot.file.try_clone().expect("clone PGN descriptor");
        let range_bytes = std::mem::size_of::<GameRange>();
        let repository = PgnRepository {
            inner: Arc::new(std::sync::Mutex::new(PgnRepositoryInner::default())),
            edit_locks: Arc::new(KeyedLocks::default()),
            cache_byte_limit: range_bytes,
        };
        let (key, ranges) = scan_current(snapshot, &repository, &CancellationToken::new())
            .await
            .expect("scan remains available to caller");
        assert_eq!(ranges.len(), 2);
        let games = read_ranges(read_file, ranges.to_vec(), &CancellationToken::new())
            .expect("read returned ranges");
        assert!(games[0].starts_with("[Event \"A\"]"));
        assert!(games[1].starts_with("[Event \"B\"]"));
        assert!(repository.get(&key).expect("read cache").is_none());
        assert_eq!(repository.inner().expect("inspect cache").retained_bytes, 0);
    }

    #[tokio::test]
    #[cfg_attr(not(unix), ignore = "unported on this platform: f-20260914-10")]
    async fn held_accepted_write_caller_dropped_commits_and_invalidates_cache() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("write-held.pgn");
        std::fs::write(&path, b"[Event \"Initial\"]\n\n1. e4\n").expect("write PGN");
        let resolved = writable_for(&directory, &path);
        let snapshot = resolved.pgn_snapshot().expect("snapshot");

        let app = mock_app();
        let state = app.state::<AppState>();
        let repository = state.pgn_repository.clone();
        let operations = state.operations.clone();

        // Warm the cache so we can verify post-worker invalidation
        let (old_key, _) = scan_current(snapshot, &repository, &CancellationToken::new())
            .await
            .expect("warm cache");
        assert!(repository.get(&old_key).unwrap().is_some());
        // Install bounded hook on the worker
        let (hook, entered, release) = BoundedHook::new();
        repository
            .set_edit_worker_hook(Some(hook))
            .expect("set edit hook");

        let lease = operations.accept("write_game").unwrap();
        let replacement = "[Event \"Updated\"]\n\n1. d4 d5 1-0\n".to_string();
        let expected_stamp = read_game_core(
            writable_for(&directory, &path),
            0,
            &CancellationToken::new(),
            &repository,
        )
        .await
        .expect("read initial game")
        .stamp;
        let caller_task = tokio::spawn(write_game_core(
            lease,
            resolved,
            0,
            replacement,
            WriteExpectation::Game {
                stamp: expected_stamp,
            },
            repository.clone(),
            None,
        ));

        // Wait until worker is actively inside the blocking edit task
        tokio::time::timeout(Duration::from_secs(5), entered)
            .await
            .expect("timeout waiting for worker entry")
            .expect("worker must enter blocking task");

        // Drop the caller future while the accepted worker is running
        caller_task.abort();
        let _ = caller_task.await;

        // Release the worker to finish commit and invalidation
        drop(release);

        let drained = tokio::task::spawn_blocking(move || {
            operations.wait_for_drain(Duration::from_secs(5)).unwrap()
        })
        .await
        .unwrap();
        assert!(drained, "operations must drain after held write");

        // Assert exact old cached identity was invalidated and removed
        assert!(
            repository.get(&old_key).unwrap().is_none(),
            "exact old cache identity must be invalidated"
        );

        let content = std::fs::read_to_string(&path).expect("read committed file");
        assert!(
            content.contains("[Event \"Updated\"]"),
            "file on disk must contain the updated game"
        );
    }

    #[tokio::test]
    #[cfg_attr(not(unix), ignore = "unported on this platform: f-20260914-10")]
    async fn a_cache_invalidation_failure_after_the_replacement_reports_a_committed_write() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("invalidation.pgn");
        std::fs::write(&path, b"[Event \"Initial\"]\n\n1. e4\n").expect("write PGN");
        let app = mock_app();
        let state = app.state::<AppState>();
        let repository = state.pgn_repository.clone();
        let expected_stamp = read_game_core(
            writable_for(&directory, &path),
            0,
            &CancellationToken::new(),
            &repository,
        )
        .await
        .expect("read initial game")
        .stamp;
        let (hook, entered, release) = BoundedHook::new();
        repository
            .set_edit_worker_hook(Some(hook))
            .expect("set edit hook");

        let write = tokio::spawn(write_game_core(
            state.operations.accept("write_game").expect("accept write"),
            writable_for(&directory, &path),
            0,
            "[Event \"Updated\"]\n\n1. d4\n".to_string(),
            WriteExpectation::Game {
                stamp: expected_stamp,
            },
            repository.clone(),
            None,
        ));
        tokio::time::timeout(Duration::from_secs(5), entered)
            .await
            .expect("timeout waiting for worker entry")
            .expect("worker must enter blocking task");
        // Poison the repository lock while the edit is held, so only the invalidation that
        // follows the installed replacement can fail.
        let inner = Arc::clone(&repository.inner);
        let poisoner = std::thread::spawn(move || {
            let _guard = inner.lock().expect("repository lock");
            panic!("poison the PGN repository lock");
        });
        assert!(poisoner.join().is_err());
        drop(release);

        let error = write
            .await
            .expect("write task")
            .expect_err("the cache cannot be invalidated");
        assert!(
            matches!(
                error,
                Error::CommittedDurabilityUncertain(
                    crate::error::DurabilityStage::PgnCacheInvalidation
                )
            ),
            "unexpected error: {error:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&path).expect("replaced PGN"),
            "[Event \"Updated\"]\n\n1. d4\n"
        );
    }

    #[tokio::test]
    #[cfg_attr(not(unix), ignore = "unported on this platform: f-20260914-10")]
    async fn held_accepted_delete_caller_dropped_commits_and_invalidates_cache() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("delete-held.pgn");
        std::fs::write(
            &path,
            b"[Event \"First\"]\n\n1. e4\n\n[Event \"Second\"]\n\n1. d4\n",
        )
        .expect("write PGN");
        let resolved = writable_for(&directory, &path);
        let snapshot = resolved.pgn_snapshot().expect("snapshot");

        let app = mock_app();
        let state = app.state::<AppState>();
        let repository = state.pgn_repository.clone();
        let operations = state.operations.clone();

        // Warm the cache
        let (old_key, _) = scan_current(snapshot, &repository, &CancellationToken::new())
            .await
            .expect("warm cache");
        assert!(repository.get(&old_key).unwrap().is_some());
        let expected = read_game_core(
            writable_for(&directory, &path),
            0,
            &CancellationToken::new(),
            &repository,
        )
        .await
        .expect("read game selected for delete");

        // Install bounded hook on the worker
        let (hook, entered, release) = BoundedHook::new();
        repository
            .set_edit_worker_hook(Some(hook))
            .expect("set edit hook");

        let lease = operations.accept("delete_game").unwrap();
        let caller_task = tokio::spawn(delete_game_core(
            lease,
            resolved,
            0,
            expected.stamp,
            expected.revision,
            repository.clone(),
            None,
        ));

        // Wait until worker is actively inside the blocking edit task
        tokio::time::timeout(Duration::from_secs(5), entered)
            .await
            .expect("timeout waiting for worker entry")
            .expect("worker must enter blocking task");

        // Drop the caller future while the accepted worker is running
        caller_task.abort();
        let _ = caller_task.await;

        // Release the worker to finish commit and invalidation
        drop(release);

        let drained = tokio::task::spawn_blocking(move || {
            operations.wait_for_drain(Duration::from_secs(5)).unwrap()
        })
        .await
        .unwrap();
        assert!(drained, "operations must drain after held delete");

        // Assert exact old cached identity was invalidated and removed
        assert!(
            repository.get(&old_key).unwrap().is_none(),
            "exact old cache identity must be invalidated"
        );

        let content = std::fs::read_to_string(&path).expect("read committed file");
        assert!(
            !content.contains("[Event \"First\"]") && content.contains("[Event \"Second\"]"),
            "file on disk must have first game deleted and second game preserved"
        );
    }

    #[tokio::test]
    #[cfg_attr(not(unix), ignore = "unported on this platform: f-20260914-10")]
    async fn held_accepted_write_caller_dropped_with_uncertain_durability_invalidates_cache() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("write-uncertain.pgn");
        std::fs::write(&path, b"[Event \"Initial\"]\n\n1. e4\n").expect("write PGN");
        let resolved = writable_for(&directory, &path);
        let snapshot = resolved.pgn_snapshot().expect("snapshot");

        let app = mock_app();
        let state = app.state::<AppState>();
        let repository = state.pgn_repository.clone();
        let operations = state.operations.clone();

        // Warm the cache
        let (old_key, _) = scan_current(snapshot, &repository, &CancellationToken::new())
            .await
            .expect("warm cache");
        assert!(repository.get(&old_key).unwrap().is_some());

        // Configure atomic file injector for parent sync fault (committed durability uncertain)
        repository
            .set_atomic_file_injector(Some(std::sync::Arc::new(
                crate::infra::fs::ParentSyncFault("injected sync fault"),
            )))
            .expect("set atomic injector");

        // Install bounded hook on the worker
        let (hook, entered, release) = BoundedHook::new();
        repository
            .set_edit_worker_hook(Some(hook))
            .expect("set edit hook");

        let lease = operations.accept("write_game").unwrap();
        let replacement = "[Event \"Updated\"]\n\n1. d4 d5 1-0\n".to_string();
        let expected_stamp = read_game_core(
            writable_for(&directory, &path),
            0,
            &CancellationToken::new(),
            &repository,
        )
        .await
        .expect("read initial game")
        .stamp;
        let caller_task = tokio::spawn(write_game_core(
            lease,
            resolved,
            0,
            replacement,
            WriteExpectation::Game {
                stamp: expected_stamp,
            },
            repository.clone(),
            None,
        ));

        // Wait until worker is actively inside the blocking edit task
        tokio::time::timeout(Duration::from_secs(5), entered)
            .await
            .expect("timeout waiting for worker entry")
            .expect("worker must enter blocking task");

        // Drop the caller future
        caller_task.abort();
        let _ = caller_task.await;

        // Release the worker
        drop(release);

        let drained = tokio::task::spawn_blocking(move || {
            operations.wait_for_drain(Duration::from_secs(5)).unwrap()
        })
        .await
        .unwrap();
        assert!(drained, "operations must drain after held write");

        // Assert exact old cached identity was invalidated despite durability uncertainty
        assert!(
            repository.get(&old_key).unwrap().is_none(),
            "cache identity must be invalidated on committed durability uncertainty"
        );

        let content = std::fs::read_to_string(&path).expect("read committed file");
        assert!(
            content.contains("[Event \"Updated\"]"),
            "committed file must be on disk"
        );
    }

    async fn queued_edit_shutdown_preserves_file(write: bool) {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join(if write {
            "queued-write.pgn"
        } else {
            "queued-delete.pgn"
        });
        let original = b"[Event \"First\"]\n\n1. e4\n\n[Event \"Second\"]\n\n1. d4\n";
        std::fs::write(&path, original).expect("write PGN");
        let resolved = writable_for(&directory, &path);
        let snapshot = resolved.pgn_snapshot().expect("snapshot");
        let identity = snapshot.identity.clone();
        let app = mock_app();
        let state = app.state::<AppState>();
        let repository = state.pgn_repository.clone();
        let operations = state.operations.clone();
        let (old_key, _) = scan_current(snapshot, &repository, &CancellationToken::new())
            .await
            .expect("warm cache");
        let lock = repository.edit_lock(identity).expect("edit lock");
        let held = lock.lock().await;
        let waiting = repository
            .observe_edit_lock_wait()
            .expect("observe edit wait");
        let expected = read_game_core(
            writable_for(&directory, &path),
            0,
            &CancellationToken::new(),
            &repository,
        )
        .await
        .expect("read game before queued edit");
        let lease = operations
            .accept(if write { "write_game" } else { "delete_game" })
            .expect("accept edit");
        let task = if write {
            let write_repository = repository.clone();
            tokio::spawn(async move {
                write_game_core(
                    lease,
                    resolved,
                    0,
                    "[Event \"Replacement\"]\n\n1. c4\n".into(),
                    WriteExpectation::Game {
                        stamp: expected.stamp.clone(),
                    },
                    write_repository,
                    None,
                )
                .await
                .map(|_| ())
            })
        } else {
            tokio::spawn(delete_game_core(
                lease,
                resolved,
                0,
                expected.stamp,
                expected.revision,
                repository.clone(),
                None,
            ))
        };
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("edit wait timeout")
            .expect("edit reached held lock");
        operations
            .seal_and_request_cancellation()
            .expect("request shutdown cancellation");
        let error = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("queued edit must stop while lock remains held")
            .expect("join queued edit")
            .expect_err("queued edit must cancel");
        assert!(matches!(error, Error::Cancellation));
        assert_eq!(std::fs::read(&path).expect("read unchanged PGN"), original);
        assert!(
            repository.get(&old_key).expect("read cache").is_some(),
            "pre-mutation cancellation must preserve the current scan cache"
        );
        drop(held);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_cancels_write_queued_at_actual_edit_lock() {
        queued_edit_shutdown_preserves_file(true).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_cancels_delete_queued_at_actual_edit_lock() {
        queued_edit_shutdown_preserves_file(false).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn active_production_scan_serializes_as_cancellation() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("cancelled.pgn");
        std::fs::write(&path, b"[Event \"A\"]\n\n1. e4\n").expect("write PGN");
        let repository = PgnRepository::default();
        let (hook, entered, release) = BoundedHook::new();
        repository
            .set_scan_line_hook(Some(hook))
            .expect("set scan hook");
        let cancellation = CancellationToken::new();
        let worker_token = cancellation.clone();
        let task = tokio::spawn(async move {
            count_pgn_games_core(resolved_for(&directory, &path), &worker_token, &repository).await
        });
        tokio::time::timeout(Duration::from_secs(5), entered)
            .await
            .expect("scan entry timeout")
            .expect("scan entered");
        cancellation.cancel();
        release.send(()).expect("release scan");
        let error = task
            .await
            .expect("join active scan")
            .expect_err("cancelled scan must fail");
        assert!(matches!(error, Error::Cancellation));
        let serialized = serde_json::to_value(&error).expect("serialize cancellation");
        assert_eq!(serialized["category"], "cancellation");
    }

    #[test]
    fn malformed_scans_remain_io_errors() {
        let malformed = scan_games(Cursor::new(b"[Event \"A\"]\n\n{ open\n"))
            .expect_err("unclosed comment must be malformed");
        assert_eq!(malformed.kind(), io::ErrorKind::InvalidData);
        let serialized = serde_json::to_value(Error::from(malformed)).expect("serialize I/O");
        assert_eq!(serialized["category"], "io");
    }

    #[test]
    fn read_and_seek_errors_propagate_without_retrying() {
        struct FailingRead;
        impl Read for FailingRead {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "read failure",
                ))
            }
        }
        impl Seek for FailingRead {
            fn seek(&mut self, _: SeekFrom) -> io::Result<u64> {
                Ok(0)
            }
        }
        struct FailingSeek;
        impl Read for FailingSeek {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                let bom = [0xEF, 0xBB, 0xBF];
                buffer[..bom.len()].copy_from_slice(&bom);
                Ok(bom.len())
            }
        }
        impl Seek for FailingSeek {
            fn seek(&mut self, _: SeekFrom) -> io::Result<u64> {
                Err(io::Error::other("seek failure"))
            }
        }
        assert_eq!(
            scan_games(FailingRead).expect_err("read error").kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            scan_games(FailingSeek).expect_err("seek error").kind(),
            io::ErrorKind::Other
        );
    }

    fn single_scan_range_bytes(data: &[u8]) -> Vec<u8> {
        let ranges = scan_games(Cursor::new(data)).expect("scan range");
        assert_eq!(ranges.len(), 1, "fixture must be one scanner range");
        data[ranges[0].start as usize..ranges[0].end as usize].to_vec()
    }

    fn lex_scanned_range(data: &[u8]) -> Result<Vec<crate::lexer::Token>, Error> {
        let range = single_scan_range_bytes(data);
        let text = std::str::from_utf8(&range).expect("range is UTF-8");
        crate::lexer::lex_pgn_cancellable(text, None)
    }

    fn for_each_line_ending(pgn: &str, mut body: impl FnMut(&[u8])) {
        body(pgn.as_bytes());
        body(pgn.replace('\n', "\r\n").as_bytes());
    }

    fn assert_more_than_one_game(result: Result<Vec<crate::lexer::Token>, Error>) {
        assert!(
            matches!(
                result,
                Err(Error::InvalidInput(ref message)) if message == MORE_THAN_ONE_GAME
            ),
            "expected more-than-one-game refusal, got {result:?}"
        );
    }

    #[test]
    fn headed_blank_line_range_lexes_all_four_moves() {
        for_each_line_ending("[Event \"A\"]\n\n1. e4 e5\n\n2. Nf3 Nc6 *\n", |data| {
            let tokens = lex_scanned_range(data).expect("headed blank-line game");
            let sans: Vec<_> = tokens
                .iter()
                .filter_map(|token| match token {
                    crate::lexer::Token::San(san) => Some(san.as_str()),
                    _ => None,
                })
                .collect();
            assert_eq!(sans, ["e4", "e5", "Nf3", "Nc6"], "data={data:?}");
        });
    }

    #[test]
    fn refuse_multi_game_range_allows_empty_and_one_game() {
        assert!(matches!(
            refuse_multi_game_range(b"  \n% escape\n\n"),
            Ok(())
        ));
        assert!(matches!(refuse_multi_game_range(b"1. e4 *\n"), Ok(())));
        let error = refuse_multi_game_range(b"1. e4 *\n\n1. d4 *\n").unwrap_err();
        assert!(
            matches!(
                error,
                Error::InvalidInput(ref message) if message == MORE_THAN_ONE_GAME
            ),
            "expected more-than-one-game refusal, got {error:?}"
        );
    }

    #[test]
    fn tagless_two_game_range_is_refused() {
        for_each_line_ending("1. e4 *\n\n1. d4 *\n", |data| {
            assert_more_than_one_game(lex_scanned_range(data));
        });
    }

    #[test]
    fn clk_line_range_is_refused() {
        for_each_line_ending(
            "[Event \"A\"]\n\n1. e4 e5\n[%clk 0:01]\n2. Nf3 Nc6 *\n",
            |data| {
                assert_more_than_one_game(lex_scanned_range(data));
            },
        );
    }

    #[test]
    fn comment_and_semicolon_remainders_are_refused() {
        for remainder in ["{comment}", "; comment"] {
            for_each_line_ending(&format!("1. e4 *\n\n{remainder}\n"), |data| {
                assert_more_than_one_game(lex_scanned_range(data));
            });
        }
    }

    #[test]
    fn percent_escape_and_whitespace_remainders_are_accepted() {
        for remainder in ["% escape", "   \n\t"] {
            for_each_line_ending(&format!("1. e4 *\n\n{remainder}\n"), |data| {
                let tokens = lex_scanned_range(data)
                    .unwrap_or_else(|error| panic!("accepted remainder {remainder:?}: {error}"));
                let sans: Vec<_> = tokens
                    .iter()
                    .filter_map(|token| match token {
                        crate::lexer::Token::San(san) => Some(san.as_str()),
                        _ => None,
                    })
                    .collect();
                assert_eq!(sans, ["e4"], "remainder {remainder:?} data={data:?}");
            });
        }
    }

    #[test]
    fn cancelling_during_remainder_check_returns_cancellation() {
        let pgn = "1. e4 *\n\n1. d4 *\n";
        let token = CancellationToken::new();
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let thread_token = token.clone();
        let pgn_owned = pgn.to_string();
        let worker = std::thread::spawn(move || {
            set_test_remainder_check_hook(Some(RemainderCheckHook {
                entered: entered_tx,
                release: release_rx,
            }));
            struct Cleanup;
            impl Drop for Cleanup {
                fn drop(&mut self) {
                    set_test_remainder_check_hook(None);
                }
            }
            let _cleanup = Cleanup;
            crate::lexer::lex_pgn_cancellable(&pgn_owned, Some(&thread_token))
        });
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("remainder check must start");
        token.cancel();
        let _ = release_tx.send(());
        let result = worker.join().expect("worker thread must complete");
        assert!(
            matches!(result, Err(Error::Cancellation)),
            "expected cancellation during remainder check, got {result:?}"
        );
    }

    #[tokio::test]
    async fn write_game_core_refuses_a_two_game_range_without_changing_bytes() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("two-game.pgn");
        let original = b"1. e4 *\n\n1. d4 *\n";
        std::fs::write(&path, original).expect("write two-game PGN");
        let app = mock_app();
        let state = app.state::<AppState>();
        let current = read_game_core(
            writable_for(&directory, &path),
            0,
            &CancellationToken::new(),
            &state.pgn_repository,
        )
        .await
        .expect("read original range");
        let lease = state.operations.accept("write_game").expect("accept write");
        let result = write_game_core(
            lease,
            writable_for(&directory, &path),
            0,
            "1. c4 *\n".into(),
            WriteExpectation::Game {
                stamp: current.stamp,
            },
            state.pgn_repository.clone(),
            None,
        )
        .await;
        assert!(
            matches!(
                result,
                Err(Error::InvalidInput(ref message)) if message == MORE_THAN_ONE_GAME
            ),
            "expected save refusal, got {result:?}"
        );
        assert_eq!(std::fs::read(&path).expect("read unchanged PGN"), original);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn write_game_core_replaces_a_one_game_range() {
        use crate::infra::path_authority::PathAuthority;

        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("one-game.pgn");
        let registry = directory.path().join("registry.json");
        std::fs::write(&path, b"[Event \"A\"]\n\n1. e4 *\n").expect("write one-game PGN");
        let mut authority = PathAuthority::open(registry, vec![]).expect("open authority");
        let handle = promote_pgn_file(&mut authority, &path);
        let app = mock_app();
        let state = app.state::<AppState>();
        state
            .pgn_path_authority
            .install(authority)
            .expect("path authority lock");
        let submitted = "[Event \"B\"]\n\n1. d4 *\n";
        write_through_capability(&app, &handle, 0, submitted.into())
            .await
            .expect("write over one-game range");
        assert_eq!(
            std::fs::read_to_string(&path)
                .expect("read written PGN")
                .trim(),
            submitted.trim()
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn write_game_core_still_appends() {
        use crate::infra::path_authority::PathAuthority;

        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("append.pgn");
        let registry = directory.path().join("registry.json");
        std::fs::write(&path, b"[Event \"A\"]\n\n1. e4 *\n").expect("write one-game PGN");
        let mut authority = PathAuthority::open(registry, vec![]).expect("open authority");
        let handle = promote_pgn_file(&mut authority, &path);
        let app = mock_app();
        let state = app.state::<AppState>();
        state
            .pgn_path_authority
            .install(authority)
            .expect("path authority lock");
        append_through_capability(&app, &handle, 1, "[Event \"B\"]\n\n1. d4 *\n".into())
            .await
            .expect("append after one-game range");
        let body = std::fs::read_to_string(&path).expect("read appended PGN");
        assert!(body.contains("[Event \"A\"]"));
        assert!(body.contains("[Event \"B\"]"));
    }
}
