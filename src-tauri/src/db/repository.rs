#[cfg(test)]
use std::path::Path;
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Seek, SeekFrom, Write},
    ops::{Deref, DerefMut},
    path::PathBuf,
    sync::{Arc, Condvar, Mutex, Weak},
    time::{Duration, Instant},
};

#[cfg(all(test, unix))]
std::thread_local! {
    pub(crate) static FAIL_NEXT_REVISION_BUMP: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(all(test, unix))]
pub(crate) struct RevisionBumpFailureGuard;

#[cfg(all(test, unix))]
impl Drop for RevisionBumpFailureGuard {
    fn drop(&mut self) {
        FAIL_NEXT_REVISION_BUMP.with(|fail| fail.set(false));
    }
}

#[cfg(all(test, unix))]
pub(crate) fn fail_next_revision_bump() -> RevisionBumpFailureGuard {
    FAIL_NEXT_REVISION_BUMP.with(|fail| fail.set(true));
    RevisionBumpFailureGuard
}

use diesel::sql_types::{Nullable, Text};
use diesel::{
    prelude::*,
    r2d2::{CustomizeConnection, ManageConnection, Pool, PooledConnection},
    sql_query, Connection, OptionalExtension, SqliteConnection,
};
use parking_lot::{Condvar as ParkingCondvar, Mutex as ParkingMutex, RwLock as ParkingRwLock};
use scheduled_thread_pool::{OnPoolDropBehavior, ScheduledThreadPool};
use tokio_util::sync::CancellationToken;

use crate::error::{
    Error, DATABASE_OPEN_THROUGH_ANOTHER_DIRECTORY, DATABASE_OPEN_THROUGH_ANOTHER_NAME,
};

use super::{
    bound_sqlite::{BoundDatabase, SqliteMode, VanishedWal},
    migrations, ConnectionOptions, DatabaseSchemaIdentity, RegularFileMetadata,
};

const MAX_OPEN_DATABASES: usize = 16;

#[cfg(test)]
const RELEASE_DELAY: Duration = Duration::from_millis(150);
#[cfg(all(test, unix))]
const DRAIN_START_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(test)]
fn spawn_after_release_delay<'scope, 'env, F>(
    scope: &'scope std::thread::Scope<'scope, 'env>,
    release: F,
) -> Instant
where
    F: FnOnce() + Send + 'scope,
{
    // Capture before spawn so parent descheduling cannot shift timing past the release sleep.
    let started = Instant::now();
    scope.spawn(move || {
        std::thread::sleep(RELEASE_DELAY);
        release();
    });
    started
}

// Maximum number of pooled SQLite connections per database.
const MAX_CONNECTIONS_PER_DATABASE: u32 = 16;
const POOL_WORKER_THREADS: usize = 3;
// Ordinary lazy pools need the same establishment budget in every build.
const POOL_CONNECTION_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(all(test, unix))]
const SHORT_POOL_CONNECTION_TIMEOUT: Duration = Duration::from_secs(2);
// Must exceed `PRAGMA busy_timeout = 30000` in `db/mod.rs` so an ordinary
// contended write completes rather than tripping retirement.
const RETIRE_WAIT_TIMEOUT: Duration = Duration::from_secs(60);
const RETIRE_CANCELLATION_POLL: Duration = Duration::from_millis(25);

fn pool_worker_threads() -> Arc<ScheduledThreadPool> {
    // Retired pool workers must not wait for a reaper tick of a pool that no longer exists.
    let scheduler = Arc::new(
        ScheduledThreadPool::builder()
            .num_threads(POOL_WORKER_THREADS)
            .thread_name_pattern("r2d2-worker-{}")
            .on_drop_behavior(OnPoolDropBehavior::DiscardPendingScheduled)
            .build(),
    );
    #[cfg(test)]
    LAST_BUILT_POOL_WORKERS.with(|slot| *slot.borrow_mut() = Some(Arc::clone(&scheduler)));
    scheduler
}

#[cfg(test)]
thread_local! {
    static LAST_BUILT_POOL_WORKERS: std::cell::RefCell<Option<Arc<ScheduledThreadPool>>> = const { std::cell::RefCell::new(None) };
    static SNAPSHOT_COPY_HOOK: std::cell::RefCell<Option<Box<dyn FnMut()>>> = const { std::cell::RefCell::new(None) };
    static SNAPSHOT_OPEN_HOOK: std::cell::RefCell<Option<Box<dyn FnMut() -> String>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
struct SnapshotCopyHookGuard;

#[cfg(test)]
struct SnapshotOpenHookGuard;

#[cfg(test)]
impl Drop for SnapshotOpenHookGuard {
    fn drop(&mut self) {
        SNAPSHOT_OPEN_HOOK.with(|hook| *hook.borrow_mut() = None);
    }
}

#[cfg(test)]
impl Drop for SnapshotCopyHookGuard {
    fn drop(&mut self) {
        SNAPSHOT_COPY_HOOK.with(|hook| *hook.borrow_mut() = None);
    }
}

#[cfg(all(test, unix))]
pub(crate) fn cancel_snapshot_copy_after_chunks(cancellation: CancellationToken, chunks: usize) {
    let mut seen = 0usize;
    SNAPSHOT_COPY_HOOK.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            seen += 1;
            if seen >= chunks {
                cancellation.cancel();
            }
        }));
    });
}

type SqlitePool = Pool<BoundConnectionManager>;
type AcquiredConnection = (
    Arc<DatabaseEntry>,
    EntryLease,
    PooledConnection<BoundConnectionManager>,
    RegularFileMetadata,
);

/// Keeps the binding alive until after the SQLite connection closes. Field
/// order is deliberate: Rust drops the native connection and its binding before the ticket.
struct BoundSqliteConnection {
    connection: super::bound_sqlite::BoundConnection<SqliteConnection>,
    // The ticket drops last, after SQLite has closed and the binding is released.
    _connection: DrainTicket,
}

/// Admission gate with an outstanding-ticket count. `close` refuses new tickets; `wait_drained`
/// blocks until every ticket issued before the close has been dropped, bounded by a deadline and
/// an optional cancellation token. Entries use gates for caller leases, SQLite connection tickets,
/// and pool/manager ownership plus disposal tickets (`owners`). Retirement requires drained
/// connections AND zero owners: an upgraded-but-unadmitted r2d2 worker still holds the manager.
#[derive(Debug, Default)]
struct DrainGate {
    state: ParkingMutex<DrainState>,
    changed: ParkingCondvar,
}

#[derive(Clone, Copy, Debug, Default)]
struct DrainState {
    closed: bool,
    outstanding: usize,
    #[cfg(test)]
    waiting: usize,
}

struct DrainTicket {
    gate: Arc<DrainGate>,
}

impl DrainGate {
    fn enter(self: &Arc<Self>) -> Option<DrainTicket> {
        let mut state = self.state.lock();
        if state.closed {
            return None;
        }
        state.outstanding = state.outstanding.saturating_add(1);
        Some(DrainTicket {
            gate: Arc::clone(self),
        })
    }

    fn close(&self) {
        self.state.lock().closed = true;
        self.changed.notify_all();
    }

    fn reopen(&self) {
        self.state.lock().closed = false;
        self.changed.notify_all();
    }

    fn snapshot(&self) -> DrainState {
        *self.state.lock()
    }

    fn wait_drained(
        &self,
        timeout: Duration,
        cancellation: Option<&CancellationToken>,
        timeout_message: &'static str,
    ) -> Result<(), Error> {
        self.wait_drained_until(Instant::now() + timeout, cancellation, timeout_message)
    }

    fn wait_drained_until(
        &self,
        deadline: Instant,
        cancellation: Option<&CancellationToken>,
        timeout_message: &'static str,
    ) -> Result<(), Error> {
        let mut state = self.state.lock();
        while state.outstanding != 0 {
            if cancellation.is_some_and(CancellationToken::is_cancelled) {
                return Err(Error::Cancellation);
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(Error::Conflict(timeout_message.into()));
            }
            #[cfg(test)]
            {
                state.waiting += 1;
                self.changed.notify_all();
            }
            self.changed.wait_for(
                &mut state,
                if cancellation.is_some() {
                    deadline
                        .saturating_duration_since(now)
                        .min(RETIRE_CANCELLATION_POLL)
                } else {
                    deadline.saturating_duration_since(now)
                },
            );
            #[cfg(test)]
            {
                state.waiting -= 1;
            }
        }
        if cancellation.is_some_and(CancellationToken::is_cancelled) {
            return Err(Error::Cancellation);
        }
        Ok(())
    }

    #[cfg(test)]
    fn wait_until_waiting(&self, deadline: Instant) {
        let mut state = self.state.lock();
        while state.waiting == 0 {
            let now = Instant::now();
            assert!(now < deadline, "predecessor drain wait was not entered");
            self.changed
                .wait_for(&mut state, deadline.saturating_duration_since(now));
        }
    }
}

impl Drop for DrainTicket {
    fn drop(&mut self) {
        let mut state = self.gate.state.lock();
        state.outstanding = state.outstanding.saturating_sub(1);
        self.gate.changed.notify_all();
    }
}

impl Deref for BoundSqliteConnection {
    type Target = SqliteConnection;

    fn deref(&self) -> &Self::Target {
        &self.connection
    }
}

impl DerefMut for BoundSqliteConnection {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.connection
    }
}

#[derive(Clone)]
struct BoundConnectionManager {
    database: BoundDatabase,
    uri: String,
    connections: Arc<DrainGate>,
    barrier: Option<PoolBarrier>,
    // Last field: every manager binding is released before this ownership ticket.
    _owner: Arc<DrainTicket>,
}

#[derive(Clone)]
struct PoolBarrier {
    state: Weak<Mutex<RepositoryState>>,
    key: EntryKey,
    retire_wait: Duration,
}

#[derive(Debug)]
enum BoundPoolError {
    Admission(Error),
    Binding(Error),
    Establish(diesel::ConnectionError),
    Customize(diesel::r2d2::Error),
    Validate(diesel::result::Error),
}

impl std::fmt::Display for BoundPoolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Admission(error) | Self::Binding(error) => {
                formatter.write_str(&error.diagnostic())
            }
            Self::Establish(error) => error.fmt(formatter),
            Self::Customize(error) => error.fmt(formatter),
            Self::Validate(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for BoundPoolError {}

// Keep the existing pooled error category and renderer-safe payload while retaining
// the concrete query error or native connection diagnostic.
fn pooled_diesel_error(error: diesel::r2d2::Error) -> Error {
    match error {
        diesel::r2d2::Error::QueryError(error) => Error::from(error),
        diesel::r2d2::Error::ConnectionError(error) => {
            Error::from(diesel::result::Error::DatabaseError(
                diesel::result::DatabaseErrorKind::Unknown,
                Box::new(error.to_string()),
            ))
        }
    }
}

impl std::fmt::Debug for BoundConnectionManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BoundConnectionManager")
            .field("database", &self.database)
            .finish()
    }
}

impl ManageConnection for BoundConnectionManager {
    type Connection = BoundSqliteConnection;
    type Error = BoundPoolError;

    fn connect(&self) -> Result<Self::Connection, Self::Error> {
        #[cfg(test)]
        if let Some(barrier) = &self.barrier {
            run_test_hook(TestHook::WorkerBeforeAdmission, &barrier.key.path);
        }
        let ticket = self.connections.enter().ok_or_else(|| {
            BoundPoolError::Admission(Error::Conflict("database pool is retiring".into()))
        })?;
        if self.connections.snapshot().closed {
            return Err(BoundPoolError::Admission(Error::Conflict(
                "database pool is retiring".into(),
            )));
        }
        #[cfg(test)]
        if let Some(barrier) = &self.barrier {
            run_test_hook(TestHook::WorkerAfterAdmission, &barrier.key.path);
        }
        // An admitted predecessor is counted by its own retirement, never waited on by it.
        let _admission = self
            .barrier
            .as_ref()
            .map(|barrier| {
                let state = barrier
                    .state
                    .upgrade()
                    .ok_or_else(|| Error::Conflict("database repository has closed".into()))?;
                predecessor_admission_inner(
                    &state,
                    &barrier.key,
                    Some(&self.connections),
                    Instant::now() + barrier.retire_wait,
                    None,
                    #[cfg(test)]
                    true,
                )
            })
            .transpose()
            .map_err(BoundPoolError::Admission)?;
        if self.connections.snapshot().closed {
            return Err(BoundPoolError::Admission(Error::Conflict(
                "database pool is retiring".into(),
            )));
        }
        #[cfg(test)]
        if let Some(barrier) = &self.barrier {
            run_test_hook(TestHook::WorkerBeforeEstablish, &barrier.key.path);
        }
        let binding = self
            .database
            .connection_lifetime()
            .map_err(BoundPoolError::Binding)?;
        let connection =
            SqliteConnection::establish(&self.uri).map_err(BoundPoolError::Establish)?;
        Ok(BoundSqliteConnection {
            connection: binding.wrap(connection),
            _connection: ticket,
        })
    }

    fn is_valid(&self, connection: &mut Self::Connection) -> Result<(), Self::Error> {
        <SqliteConnection as diesel::r2d2::R2D2Connection>::ping(&mut connection.connection)
            .map_err(BoundPoolError::Validate)
    }

    fn has_broken(&self, connection: &mut Self::Connection) -> bool {
        std::thread::panicking()
            || <SqliteConnection as diesel::r2d2::R2D2Connection>::is_broken(
                &mut connection.connection,
            )
    }
}

impl CustomizeConnection<BoundSqliteConnection, BoundPoolError> for ConnectionOptions {
    fn on_acquire(&self, connection: &mut BoundSqliteConnection) -> Result<(), BoundPoolError> {
        <ConnectionOptions as CustomizeConnection<SqliteConnection, diesel::r2d2::Error>>::on_acquire(
            self,
            &mut connection.connection,
        ).map_err(BoundPoolError::Customize)
    }
}
/// A pooled connection cannot outlive the repository lifecycle lease which
/// admitted it. Keeping the two values together makes an unleased pooled
/// connection unrepresentable at the repository boundary.
pub struct DatabaseConnection {
    connection: DatabaseConnectionInner,
    _lease: Option<EntryLease>,
    _pinned_file: Option<crate::infra::inode_ownership::OwnedFile>,
    _authority_snapshot: Option<tempfile::NamedTempFile>,
}

enum DatabaseConnectionInner {
    Pooled(PooledConnection<BoundConnectionManager>),
    Pinned(SqliteConnection),
}

impl Deref for DatabaseConnection {
    type Target = SqliteConnection;
    fn deref(&self) -> &Self::Target {
        match &self.connection {
            DatabaseConnectionInner::Pooled(connection) => connection,
            DatabaseConnectionInner::Pinned(connection) => connection,
        }
    }
}

impl DerefMut for DatabaseConnection {
    fn deref_mut(&mut self) -> &mut Self::Target {
        match &mut self.connection {
            DatabaseConnectionInner::Pooled(connection) => connection,
            DatabaseConnectionInner::Pinned(connection) => connection,
        }
    }
}

/// Canonical object identity used by caches that consume non-game SQLite
/// databases as well. The filesystem component catches replacement outside
/// this process; `data_revision` is persisted in the database's Info table.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DatabaseIdentity {
    pub data_revision: u64,
    pub object: (u64, u64),
    pub length: u64,
    pub modified: std::time::SystemTime,
}

struct DatabaseEntry {
    // Declared before `bound`: fields drop in order, so pooled connections close before the
    // entry's binding handle is released.
    pool: ParkingRwLock<Option<SqlitePool>>,
    bound: BoundDatabase,
    connections: Arc<DrainGate>,
    owners: Arc<DrainGate>,
    pool_wake: Arc<PoolWake>,
    write_lock: Arc<ParkingMutex<()>>,
    index_lock: Arc<ParkingMutex<()>>,
    state: Mutex<EntryState>,
    leases: Arc<DrainGate>,
}

#[derive(Debug, Default)]
struct PoolWake {
    generation: ParkingMutex<u64>,
    changed: ParkingCondvar,
    failure: ParkingMutex<PoolFailureState>,
}

#[derive(Debug, Default)]
struct PoolFailureState {
    latest: Option<CachedPoolFailure>,
    reported: bool,
}

#[derive(Clone, Debug)]
struct CachedPoolFailure {
    error: Arc<Error>,
    native_open: bool,
}

#[derive(Debug)]
struct PoolEvents {
    wake: Arc<PoolWake>,
    path: PathBuf,
}

impl PoolWake {
    fn notify(&self) {
        let mut generation = self.generation.lock();
        *generation = generation.wrapping_add(1);
        self.changed.notify_all();
    }

    fn wait_since(&self, observed: u64, duration: Duration) {
        let mut generation = self.generation.lock();
        if *generation == observed {
            self.changed.wait_for(&mut generation, duration);
        }
    }
}

impl diesel::r2d2::HandleEvent for PoolEvents {
    fn handle_acquire(&self, _: diesel::r2d2::event::AcquireEvent) {
        *self.wake.failure.lock() = PoolFailureState::default();
        self.wake.notify();
    }

    fn handle_checkin(&self, _: diesel::r2d2::event::CheckinEvent) {
        self.wake.notify();
    }
}

impl diesel::r2d2::HandleError<BoundPoolError> for PoolEvents {
    fn handle_error(&self, error: BoundPoolError) {
        let mut failure = self.wake.failure.lock();
        if !failure.reported {
            log::error!("database pool error for {:?}: {error}", self.path);
            failure.reported = true;
        }
        let error = match error {
            // Worker admission belongs to that worker. Callers observe their own barriers.
            BoundPoolError::Admission(_) => None,
            BoundPoolError::Binding(error) => Some((error, true)),
            BoundPoolError::Establish(error) => Some((
                pooled_diesel_error(diesel::r2d2::Error::ConnectionError(error)),
                true,
            )),
            BoundPoolError::Customize(error) => Some((pooled_diesel_error(error), false)),
            BoundPoolError::Validate(error) => Some((Error::from(error), false)),
        };
        if let Some((error, native_open)) = error {
            failure.latest = Some(CachedPoolFailure {
                error: Arc::new(error),
                native_open,
            });
        }
        drop(failure);
        self.wake.notify();
    }
}

struct EntryLease {
    _entry: Arc<DatabaseEntry>,
    _ticket: DrainTicket,
}

#[derive(Default)]
struct EntryState {
    schema_identity: Option<DatabaseSchemaIdentity>,
    passed_stamp_due: Option<DatabaseIdentity>,
    last_used: u64,
}

#[derive(Default)]
struct RepositoryState {
    entries: HashMap<EntryKey, Arc<DatabaseEntry>>,
    tombstones: HashSet<PathBuf>,
    building: HashSet<EntryKey>,
    retired: Vec<Retirement>,
    retirement_reservations: usize,
    admissions: Vec<Weak<Admission>>,
    clock: u64,
}

fn repository_state_poisoned<T>(_: std::sync::PoisonError<T>) -> Error {
    Error::Conflict("database repository state poisoned".into())
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct EntryKey {
    identity: (u64, u64),
    parent_identity: (u64, u64),
    path: PathBuf,
}

impl EntryKey {
    fn matches_predecessor(&self, other: &Self) -> bool {
        self.identity == other.identity || self.parent_identity == other.parent_identity
    }
}

#[derive(Clone)]
struct Retirement {
    key: EntryKey,
    connections: Arc<DrainGate>,
    owners: Arc<DrainGate>,
}

impl Retirement {
    fn complete(&self) -> bool {
        let connections = self.connections.snapshot();
        connections.closed
            && connections.outstanding == 0
            && self.owners.snapshot().outstanding == 0
    }

    fn wait(
        &self,
        deadline: Instant,
        cancellation: Option<&CancellationToken>,
    ) -> Result<(), Error> {
        const MESSAGE: &str = "database connections did not close before retirement timed out";
        self.connections
            .wait_drained_until(deadline, cancellation, MESSAGE)?;
        self.owners
            .wait_drained_until(deadline, cancellation, MESSAGE)
    }
}

struct Admission {
    key: EntryKey,
    connections: Option<Arc<DrainGate>>,
}

struct RetirementCapacity {
    state: Arc<Mutex<RepositoryState>>,
    reserved: bool,
}

impl RetirementCapacity {
    fn publish(&mut self, state: &mut RepositoryState) {
        state.retirement_reservations -= 1;
        self.reserved = false;
    }
}

impl Drop for RetirementCapacity {
    fn drop(&mut self) {
        if self.reserved {
            if let Ok(mut state) = self.state.lock() {
                state.retirement_reservations = state.retirement_reservations.saturating_sub(1);
            }
        }
    }
}

impl RepositoryState {
    fn prune_retirements(&mut self) {
        self.retired.retain(|retired| !retired.complete());
        self.admissions
            .retain(|admission| admission.strong_count() != 0);
    }

    fn retirement_reserved(&self, key: &EntryKey, connections: &Arc<DrainGate>) -> bool {
        self.admissions
            .iter()
            .filter_map(Weak::upgrade)
            .any(|admission| {
                key.matches_predecessor(&admission.key)
                    && !admission
                        .connections
                        .as_ref()
                        .is_some_and(|gate| Arc::ptr_eq(gate, connections))
            })
    }

    fn publish_retirement(
        &mut self,
        key: &EntryKey,
        entry: &DatabaseEntry,
    ) -> Result<DrainTicket, Error> {
        // The disposal ticket is published before removal, even if the pool has no handles.
        let disposal = entry
            .owners
            .enter()
            .ok_or_else(|| Error::Conflict("database disposal admission has closed".into()))?;
        entry.connections.close();
        self.retired.push(Retirement {
            key: key.clone(),
            connections: Arc::clone(&entry.connections),
            owners: Arc::clone(&entry.owners),
        });
        Ok(disposal)
    }
}

fn predecessor_admission(
    state: &Arc<Mutex<RepositoryState>>,
    key: &EntryKey,
    own: Option<&Arc<DrainGate>>,
    deadline: Instant,
    cancellation: Option<&CancellationToken>,
) -> Result<Arc<Admission>, Error> {
    predecessor_admission_inner(
        state,
        key,
        own,
        deadline,
        cancellation,
        #[cfg(test)]
        false,
    )
}

fn predecessor_admission_inner(
    state: &Arc<Mutex<RepositoryState>>,
    key: &EntryKey,
    own: Option<&Arc<DrainGate>>,
    deadline: Instant,
    cancellation: Option<&CancellationToken>,
    #[cfg(test)] worker: bool,
) -> Result<Arc<Admission>, Error> {
    loop {
        if cancellation.is_some_and(CancellationToken::is_cancelled) {
            return Err(Error::Cancellation);
        }
        let mut state = state.lock().map_err(repository_state_poisoned)?;
        state.prune_retirements();
        if own.is_some_and(|gate| gate.snapshot().closed) {
            return Err(Error::Conflict("database pool is retiring".into()));
        }
        let predecessors: Vec<_> = state
            .retired
            .iter()
            .filter(|retired| {
                key.matches_predecessor(&retired.key)
                    && !own.is_some_and(|gate| Arc::ptr_eq(gate, &retired.connections))
            })
            .cloned()
            .collect();
        if predecessors.is_empty() {
            if state.tombstones.contains(&key.path) && own.is_some() {
                return Err(Error::Conflict("database is being deleted".into()));
            }
            let admission = Arc::new(Admission {
                key: key.clone(),
                connections: own.cloned(),
            });
            state.admissions.push(Arc::downgrade(&admission));
            return Ok(admission);
        }
        drop(state);
        #[cfg(test)]
        run_test_hook(
            if worker {
                TestHook::WorkerPredecessorWait
            } else {
                TestHook::PredecessorWait
            },
            &key.path,
        );
        for predecessor in predecessors {
            if let Some(own) = own {
                loop {
                    if cancellation.is_some_and(CancellationToken::is_cancelled) {
                        return Err(Error::Cancellation);
                    }
                    if own.snapshot().closed {
                        return Err(Error::Conflict("database pool is retiring".into()));
                    }
                    let slice = deadline.min(Instant::now() + RETIRE_CANCELLATION_POLL);
                    match predecessor.wait(slice, cancellation) {
                        Ok(()) => break,
                        Err(Error::Conflict(_)) if Instant::now() < deadline => continue,
                        Err(error) => return Err(error),
                    }
                }
            } else {
                predecessor.wait(deadline, cancellation)?;
            }
            #[cfg(test)]
            run_test_hook(TestHook::PredecessorDrained, &key.path);
        }
    }
}

/// The sole owner of SQLite pools and per-database lifecycle state.
///
/// Canonical parent spellings share pools, locks, revisions and cache invalidations.
/// Distinct hard-link names keep separate keys, but bound SQLite admits only one
/// name per inode at a time. The bounded LRU eviction only releases idle entries,
/// and live callers keep their entry alive via Arc.
pub struct DatabaseRepository {
    pub(super) content_validation: super::content_validation::ContentValidationState,
    state: Arc<Mutex<RepositoryState>>,
    build_changed: Condvar,
    retire_wait: Duration,
    pool_connection_timeout: Duration,
    #[cfg(test)]
    fail_next_deletion_release: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    vanished_retirement_attempts: std::sync::atomic::AtomicUsize,
}

impl Default for DatabaseRepository {
    fn default() -> Self {
        Self {
            content_validation: Default::default(),
            state: Arc::new(Mutex::new(RepositoryState::default())),
            build_changed: Condvar::new(),
            retire_wait: RETIRE_WAIT_TIMEOUT,
            pool_connection_timeout: POOL_CONNECTION_TIMEOUT,
            #[cfg(test)]
            fail_next_deletion_release: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            vanished_retirement_attempts: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

impl DatabaseRepository {
    #[cfg(test)]
    fn with_retire_wait(retire_wait: Duration) -> Self {
        Self {
            retire_wait,
            ..Self::default()
        }
    }

    #[cfg(all(test, unix))]
    fn with_pool_connection_timeout(pool_connection_timeout: Duration) -> Self {
        Self {
            pool_connection_timeout,
            ..Self::default()
        }
    }

    pub fn connection(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        cancellation: Option<&CancellationToken>,
    ) -> Result<DatabaseConnection, Error> {
        // Ordinary reads must not let the pool's WAL PRAGMA initialize a raw-empty
        // destination. The metadata-only identity probe preserves lifecycle refusals.
        if self
            .identity_from_probe(
                target,
                cancellation.unwrap_or(&CancellationToken::new()),
                false,
            )?
            .length
            == 0
        {
            return Err(migrations::uninitialized_database_error());
        }
        super::sqlite_cancellation::install()?;
        let (entry, lease, mut connection, probe) = self.acquire_probed(target, cancellation)?;
        let identity = DatabaseSchemaIdentity::from_probe(&probe);
        let requires_validation = entry
            .state
            .lock()
            .map_err(repository_state_poisoned)?
            .schema_identity
            .as_ref()
            != Some(&identity);
        if requires_validation {
            if migrations::validate_existing_database(&mut connection)? {
                match self.database_identity(target) {
                    Ok(validated_identity) => {
                        entry
                            .state
                            .lock()
                            .map_err(repository_state_poisoned)?
                            .passed_stamp_due = Some(validated_identity)
                    }
                    Err(error) => log::warn!(
                        "passed content validation identity lookup failed for {:?}: {}",
                        target.leaf(),
                        error.diagnostic()
                    ),
                }
            }
            self.mark_schema_validated_entry(&entry, identity)?;
        }
        Ok(DatabaseConnection {
            connection: DatabaseConnectionInner::Pooled(connection),
            _lease: Some(lease),
            _pinned_file: None,
            _authority_snapshot: None,
        })
    }

    /// Consumes a committed migration's publication record only for that identity.
    pub(super) fn take_passed_stamp_due(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
    ) -> Result<Option<DatabaseIdentity>, Error> {
        let entry = self
            .state
            .lock()
            .map_err(repository_state_poisoned)?
            .entries
            .get(&entry_key(target)?)
            .cloned();
        let Some(entry) = entry else {
            return Ok(None);
        };
        let due = entry
            .state
            .lock()
            .map_err(repository_state_poisoned)?
            .passed_stamp_due
            .clone();
        let Some(identity) = due else {
            return Ok(None);
        };
        if self.database_identity(target)? != identity {
            return Ok(None);
        }
        let mut state = entry.state.lock().map_err(repository_state_poisoned)?;
        if state.passed_stamp_due.as_ref() == Some(&identity) {
            state.passed_stamp_due = None;
            Ok(Some(identity))
        } else {
            Ok(None)
        }
    }

    pub fn initialization_connection(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        cancellation: Option<&CancellationToken>,
    ) -> Result<DatabaseConnection, Error> {
        super::sqlite_cancellation::install()?;
        let (_entry, lease, connection, _probe) = self.acquire_probed(target, cancellation)?;
        Ok(DatabaseConnection {
            connection: DatabaseConnectionInner::Pooled(connection),
            _lease: Some(lease),
            _pinned_file: None,
            _authority_snapshot: None,
        })
    }

    /// Keep the production pool exhausted for command acquisition regression tests.
    /// Remove with the shared acquisition contention harness if it is superseded.
    #[cfg(test)]
    pub(super) fn hold_all_connections_for_test(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
    ) -> Result<Vec<DatabaseConnection>, Error> {
        (0..MAX_CONNECTIONS_PER_DATABASE)
            .map(|_| self.initialization_connection(target, None))
            .collect()
    }

    /// Test-fixture helper for creating non-game SQLite schemas. Production
    /// puzzle reads must use a retained authority descriptor below.
    #[cfg(all(test, unix))]
    pub fn schema_specific_connection(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
    ) -> Result<DatabaseConnection, Error> {
        self.initialization_connection(target, None)
    }

    /// Opens SQLite from a private snapshot copied from the exact descriptor
    /// retained by path authority. SQLite's API accepts pathnames, not file
    /// descriptors, and resolves `/proc/self/fd` back to a mutable filename;
    /// a private snapshot is therefore the portable way to prevent an
    /// A→B→A replacement from redirecting the connection.
    pub fn schema_specific_connection_expected_file_cancellable(
        &self,
        file: crate::infra::inode_ownership::OwnedFile,
        expected_object: (u64, u64),
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<DatabaseConnection, Error> {
        #[cfg(test)]
        let _copy_hook_guard = SnapshotCopyHookGuard;
        #[cfg(test)]
        let _open_hook_guard = SnapshotOpenHookGuard;
        super::sqlite_cancellation::install()?;
        if crate::infra::path_authority::opened_file_identity(&file)? != expected_object {
            return Err(Error::Conflict(
                "database changed after capability resolution".into(),
            ));
        }
        let mut source = file.try_clone()?;
        source.seek(SeekFrom::Start(0))?;
        let mut snapshot = tempfile::NamedTempFile::new()?;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            snapshot.as_file_mut().write_all(&buffer[..read])?;
            #[cfg(test)]
            SNAPSHOT_COPY_HOOK.with(|hook| {
                if let Some(hook) = hook.borrow_mut().as_mut() {
                    hook();
                }
            });
        }
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        snapshot.as_file_mut().sync_all()?;
        let snapshot_path = snapshot.path().to_string_lossy().into_owned();
        #[cfg(test)]
        let snapshot_path = SNAPSHOT_OPEN_HOOK.with(|hook| {
            hook.borrow_mut()
                .as_mut()
                .map_or(snapshot_path, |hook| hook())
        });
        let connection = SqliteConnection::establish(&snapshot_path)
            .map_err(crate::error::map_sqlite_establish)?;
        Ok(DatabaseConnection {
            connection: DatabaseConnectionInner::Pinned(connection),
            _lease: None,
            _pinned_file: Some(file),
            _authority_snapshot: Some(snapshot),
        })
    }

    pub fn database_identity(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
    ) -> Result<DatabaseIdentity, Error> {
        self.database_identity_with_cancellation(target, None)
    }

    fn database_identity_with_cancellation(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        cancellation: Option<&CancellationToken>,
    ) -> Result<DatabaseIdentity, Error> {
        let owned_cancellation;
        let cancellation = match cancellation {
            Some(cancellation) => cancellation,
            None => {
                owned_cancellation = CancellationToken::new();
                &owned_cancellation
            }
        };
        self.identity_from_probe(target, cancellation, true)
    }

    pub fn database_identity_expected(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        expected_object: (u64, u64),
        cancellation: Option<&CancellationToken>,
    ) -> Result<DatabaseIdentity, Error> {
        let identity = self.database_identity_with_cancellation(target, cancellation)?;
        if identity.object != expected_object {
            return Err(Error::Conflict(
                "database changed after capability resolution".into(),
            ));
        }
        Ok(identity)
    }

    pub(crate) fn identity_from_probe(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        cancellation: &CancellationToken,
        hydrate: bool,
    ) -> Result<DatabaseIdentity, Error> {
        if !hydrate {
            let schema = self.probe_schema(target, cancellation)?;
            self.tombstone_conflict(target)?;
            super::cancellation_check(cancellation)?;
            return Ok(DatabaseIdentity {
                data_revision: 0,
                object: schema.object,
                length: schema.length,
                modified: schema.modified,
            });
        }

        let mut wrote_main = false;
        for sample in 0..2 {
            let (s1, r1) = self.probe_schema_and_revision(target, cancellation, &mut wrote_main)?;
            let (s2, r2) = self.probe_schema_and_revision(target, cancellation, &mut wrote_main)?;
            let (s3, r3) = self.probe_schema_and_revision(target, cancellation, &mut wrote_main)?;
            let (s4, r4) = self.probe_schema_and_revision(target, cancellation, &mut wrote_main)?;
            self.tombstone_conflict(target)?;
            if s1 == s2 && s2 == s3 && s3 == s4 && r1 == r2 && r2 == r3 && r3 == r4 {
                super::cancellation_check(cancellation)?;
                return Ok(DatabaseIdentity {
                    data_revision: r4,
                    object: s4.object,
                    length: s4.length,
                    modified: s4.modified,
                });
            }
            if sample != 0 || !wrote_main {
                break;
            }
        }
        Err(Error::Conflict(
            "database changed while reading its identity".into(),
        ))
    }

    fn probe_schema_and_revision(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        cancellation: &CancellationToken,
        wrote_main: &mut bool,
    ) -> Result<(DatabaseSchemaIdentity, u64), Error> {
        let schema = self.probe_schema(target, cancellation)?;
        let revision = self.read_revision_tracking_writes(target, cancellation, wrote_main)?;
        Ok((schema, revision))
    }

    fn probe_schema(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        cancellation: &CancellationToken,
    ) -> Result<DatabaseSchemaIdentity, Error> {
        super::cancellation_check(cancellation)?;
        self.tombstone_conflict(target)?;
        let probe = self.probe_current(target)?;
        Ok(DatabaseSchemaIdentity::from_probe(&probe))
    }

    /// Waits for every retired predecessor sharing object or parent identity, with cancellation
    /// and one absolute deadline of now + retire_wait. The guard blocks matching retirement
    /// publication through retirement_reserved. Hold it across SQLite establishment, then drop
    /// it before long work, as content scans do before validate_content.
    pub(super) fn predecessor_admission_for(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        cancellation: &CancellationToken,
    ) -> Result<impl Drop, Error> {
        super::cancellation_check(cancellation)?;
        crate::infra::inode_ownership::check_sqlite(target.identity())?;
        let key = entry_key(target)?;
        predecessor_admission(
            &self.state,
            &key,
            None,
            Instant::now() + self.retire_wait,
            Some(cancellation),
        )
    }

    #[cfg(test)]
    fn read_revision(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        cancellation: &CancellationToken,
    ) -> Result<u64, Error> {
        self.read_revision_tracking_writes(target, cancellation, &mut false)
    }

    fn read_revision_tracking_writes(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        cancellation: &CancellationToken,
        wrote_main: &mut bool,
    ) -> Result<u64, Error> {
        super::cancellation_check(cancellation)?;
        super::sqlite_cancellation::install()?;
        let mut attempted_retirement = false;
        let (_admission, bound) = loop {
            let admission = self.predecessor_admission_for(target, cancellation)?;
            self.tombstone_conflict(target)?;
            match self.acquire_bound(target) {
                Ok(bound) => break (admission, bound),
                Err(error) => {
                    drop(admission);
                    *wrote_main |= self.recover_vanished_holder_conflict(
                        target,
                        Some(cancellation),
                        &mut attempted_retirement,
                        error,
                    )?;
                }
            }
        };
        let uri = bound.uri(SqliteMode::ReadOnly)?;
        let refusal_count = bound.refusal_count();
        let connection_lifetime = bound.connection_lifetime()?;
        let connection =
            SqliteConnection::establish(&uri).map_err(crate::error::map_sqlite_establish);
        let mut connection = match connection {
            Ok(connection) => connection_lifetime.wrap(connection),
            Err(error) => {
                return Err(self.classify_bound_open_error(target, &bound, refusal_count, error));
            }
        };
        let revision = super::sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
            read_data_revision(&mut connection)
        })?;
        #[cfg(test)]
        run_test_hook(TestHook::AfterReadRevision, target.path());
        Ok(revision)
    }

    fn tombstone_conflict(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
    ) -> Result<(), Error> {
        if self
            .state
            .lock()
            .map_err(repository_state_poisoned)?
            .tombstones
            .contains(target.path())
        {
            return Err(Error::Conflict("database is being deleted".into()));
        }
        Ok(())
    }

    #[cfg(all(test, unix))]
    pub fn mark_schema_validated(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
    ) -> Result<(), Error> {
        let (_key, entry, probe) = self.entry(target, None)?;
        self.mark_schema_validated_entry(&entry, DatabaseSchemaIdentity::from_probe(&probe))
    }

    #[cfg(all(test, unix))]
    pub fn with_write_lock<T>(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        operation: impl FnOnce() -> Result<T, Error>,
    ) -> Result<T, Error> {
        let (_, entry, _) = self.entry(target, None)?;
        let _lease = entry.acquire()?;
        let _guard = entry.write_lock.lock();
        operation()
    }

    pub fn with_write_lock_cancellable<T>(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        cancellation: &CancellationToken,
        operation: impl FnOnce() -> Result<T, Error>,
    ) -> Result<T, Error> {
        let (_, entry, _) = self.entry(target, Some(cancellation))?;
        let _lease = entry.acquire()?;
        let _guard =
            crate::infra::cancellable_lock::lock_cancellable(&entry.write_lock, cancellation)?;
        operation()
    }

    #[cfg(test)]
    pub(crate) fn index_lock_for_test(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
    ) -> Result<Arc<ParkingMutex<()>>, Error> {
        let (_, entry, _) = self.entry(target, None)?;
        Ok(Arc::clone(&entry.index_lock))
    }

    pub fn with_index_lock_cancellable<T>(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        cancellation: &CancellationToken,
        operation: impl FnOnce() -> Result<T, Error>,
    ) -> Result<T, Error> {
        let (_, entry, _) = self.entry(target, Some(cancellation))?;
        let _lease = entry.acquire()?;
        let _guard =
            crate::infra::cancellable_lock::lock_cancellable(&entry.index_lock, cancellation)?;
        operation()
    }

    /// Evicts every resource owned by this canonical database. A future open
    /// receives a fresh pool and therefore cannot use a deleted/replaced file.
    #[cfg(test)]
    pub fn close_and_invalidate(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
    ) -> Result<(), Error> {
        let key = entry_key(target)?;
        let entry = self
            .state
            .lock()
            .map_err(repository_state_poisoned)?
            .entries
            .get(&key)
            .cloned();
        if let Some(entry) = entry {
            entry.retire_and_wait(self.retire_wait)?;
            self.close_retired_entry(&key, &entry, None)?;
        }
        Ok(())
    }

    #[cfg(all(test, unix))]
    pub fn deletion_is_waiting(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
    ) -> Result<bool, Error> {
        let key = entry_key(target)?;
        let entry = self
            .state
            .lock()
            .map_err(repository_state_poisoned)?
            .entries
            .get(&key)
            .cloned();
        Ok(entry.is_some_and(|entry| {
            let snapshot = entry.leases.snapshot();
            snapshot.closed && snapshot.outstanding != 0
        }))
    }

    #[cfg(all(test, unix))]
    pub(crate) fn is_building(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
    ) -> Result<bool, Error> {
        let key = entry_key(target)?;
        Ok(self
            .state
            .lock()
            .map_err(repository_state_poisoned)?
            .building
            .contains(&key))
    }

    /// Reserves a database name before unlinking it so no concurrent command
    /// can recreate a pool for the soon-to-be-deleted inode. The reservation
    /// is released only after the deletion operation has reached a terminal
    /// success/failure result.
    #[cfg(all(test, unix))]
    pub fn delete_exclusive<T>(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        operation: impl FnOnce() -> Result<T, Error>,
    ) -> Result<T, Error> {
        self.delete_exclusive_inner(target, None, operation)
    }

    /// Reserves and retires a database entry cooperatively. Cancellation may stop the wait only
    /// before `operation` starts; once unlink begins, the operation and its caller-owned cleanup
    /// tail retain the committed outcome.
    pub fn delete_exclusive_cancellable<T>(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        cancellation: &CancellationToken,
        operation: impl FnOnce() -> Result<T, Error>,
    ) -> Result<T, Error> {
        self.delete_exclusive_inner(target, Some(cancellation), operation)
    }

    fn delete_exclusive_inner<T>(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        cancellation: Option<&CancellationToken>,
        operation: impl FnOnce() -> Result<T, Error>,
    ) -> Result<T, Error> {
        let tombstone = self.reserve_for_deletion(target, cancellation)?;
        let result = operation();
        self.release_deletion(tombstone)?;
        result
    }

    fn reserve_for_deletion(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        cancellation: Option<&CancellationToken>,
    ) -> Result<TombstoneGuard<'_>, Error> {
        if cancellation.is_some_and(CancellationToken::is_cancelled) {
            return Err(Error::Cancellation);
        }
        let deadline = Instant::now() + self.retire_wait;
        let key = entry_key(target)?;
        let path = target.path().to_owned();
        let entry = {
            let state = self.state.lock().map_err(repository_state_poisoned)?;
            let mut state = self.wait_while_building_until(state, &key, deadline, cancellation)?;
            if !state.tombstones.insert(path.clone()) {
                return Err(Error::Conflict(
                    "database deletion is already in progress".into(),
                ));
            }
            state.entries.get(&key).cloned()
        };
        let mut tombstone = TombstoneGuard::new(self, path.clone(), entry.clone());
        if let Some(entry) = &entry {
            entry.retire_and_wait_cancellable(
                deadline.saturating_duration_since(Instant::now()),
                cancellation,
            )?;
        }
        if cancellation.is_some_and(CancellationToken::is_cancelled) {
            return Err(Error::Cancellation);
        }
        if let Some(entry) = &entry {
            self.close_retired_entry_until(&key, entry, deadline, cancellation)?;
        }
        // Retain admission through the unlink callback. A matching retirement cannot be
        // published in the gap after the final recheck and before destructive work.
        tombstone.admission = Some(predecessor_admission(
            &self.state,
            &key,
            None,
            deadline,
            cancellation,
        )?);
        Ok(tombstone)
    }

    fn release_deletion(&self, mut tombstone: TombstoneGuard<'_>) -> Result<(), Error> {
        #[cfg(test)]
        if self
            .fail_next_deletion_release
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Err(Error::Conflict(
                "injected database deletion release failure".into(),
            ));
        }
        let mut state = self.state.lock().map_err(repository_state_poisoned)?;
        state.tombstones.remove(&tombstone.path);
        tombstone.disarm();
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn fail_next_deletion_release(&self) {
        self.fail_next_deletion_release
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn entry(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        cancellation: Option<&CancellationToken>,
    ) -> Result<(EntryKey, Arc<DatabaseEntry>, RegularFileMetadata), Error> {
        self.entry_until(target, Instant::now() + self.retire_wait, cancellation)
    }

    fn entry_until(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        deadline: Instant,
        cancellation: Option<&CancellationToken>,
    ) -> Result<(EntryKey, Arc<DatabaseEntry>, RegularFileMetadata), Error> {
        if let Some(cancellation) = cancellation {
            super::cancellation_check(cancellation)?;
        }
        crate::infra::inode_ownership::check_sqlite(target.identity())?;
        // Identity and lock-only callers can create the pool before `connection()` is reached.
        // Register the SQLite auto-extension at the one shared construction boundary so every
        // pooled connection receives the cancellation progress handler.
        super::sqlite_cancellation::install()?;
        let key = entry_key(target)?;
        let mut initial_probe = self.entry_probe(target, &key, cancellation)?;
        let mut attempted_retirement = false;
        loop {
            let mut state = self.state.lock().map_err(repository_state_poisoned)?;
            state.prune_retirements();
            if state.tombstones.contains(target.path()) {
                return Err(Error::Conflict("database is being deleted".into()));
            }
            state.clock = state.clock.saturating_add(1);
            let now = state.clock;
            if let Some(entry) = state.entries.get(&key).cloned() {
                let retiring = entry.leases.snapshot().closed;
                if retiring {
                    return Err(Error::Conflict(
                        "database is being replaced or deleted".into(),
                    ));
                }
                entry
                    .state
                    .lock()
                    .map_err(repository_state_poisoned)?
                    .last_used = now;
                return Ok((key, entry, initial_probe));
            }
            if state.building.contains(&key) {
                drop(state);
                self.wait_while_building_key(&key, deadline, cancellation)?;
                initial_probe = self.entry_probe(target, &key, cancellation)?;
                continue;
            }
            state.building.insert(key.clone());
            drop(state);
            let mut build_guard = BuildGuard {
                repository: self,
                key: key.clone(),
                finished: false,
            };

            let mut capacity = Some(self.reserve_retirement_capacity(deadline, cancellation)?);
            let (admission, bound) = loop {
                let admission =
                    predecessor_admission(&self.state, &key, None, deadline, cancellation)?;

                self.probe_current(target)?;
                #[cfg(all(test, unix))]
                run_test_hook(TestHook::PreBuild, target.path());
                match self.acquire_bound(target) {
                    Ok(bound) => break (admission, bound),
                    Err(error) => {
                        drop(admission);
                        drop(capacity.take());
                        self.recover_vanished_holder_conflict(
                            target,
                            cancellation,
                            &mut attempted_retirement,
                            error,
                        )?;
                    }
                }
            };
            let uri = bound.uri(SqliteMode::ReadWrite)?;
            let connections = Arc::new(DrainGate::default());
            let owners = Arc::new(DrainGate::default());
            let pool_wake = Arc::new(PoolWake::default());
            let owner = owners
                .enter()
                .ok_or_else(|| Error::Conflict("database ownership admission has closed".into()))?;
            let pool = Pool::builder()
                .thread_pool(pool_worker_threads())
                .max_size(MAX_CONNECTIONS_PER_DATABASE)
                .min_idle(Some(0))
                .connection_timeout(self.pool_connection_timeout)
                .connection_customizer(Box::new(ConnectionOptions))
                .event_handler(Box::new(PoolEvents {
                    wake: Arc::clone(&pool_wake),
                    path: target.path().to_path_buf(),
                }))
                .error_handler(Box::new(PoolEvents {
                    wake: Arc::clone(&pool_wake),
                    path: target.path().to_path_buf(),
                }))
                .build(BoundConnectionManager {
                    database: bound.clone(),
                    uri,
                    connections: Arc::clone(&connections),
                    barrier: Some(PoolBarrier {
                        state: Arc::downgrade(&self.state),
                        key: key.clone(),
                        retire_wait: self.retire_wait,
                    }),
                    _owner: Arc::new(owner),
                })?;
            #[cfg(all(test, unix))]
            run_test_hook(TestHook::PostBuild, target.path());
            initial_probe = self.probe_current(target)?;

            // The unopened pool is protected by the construction reservation. Its first
            // SQLite open receives a separate admission in the manager.
            drop(admission);
            let mut capacity = match capacity {
                Some(capacity) => capacity,
                None => self.reserve_retirement_capacity(deadline, cancellation)?,
            };
            let mut state = loop {
                let mut state = self.state.lock().map_err(repository_state_poisoned)?;
                state.prune_retirements();
                if cancellation.is_some_and(CancellationToken::is_cancelled) {
                    return Err(Error::Cancellation);
                }
                if state.entries.len() < MAX_OPEN_DATABASES {
                    break state;
                }
                let eviction = self.eviction_candidate(&state, &key);
                let Some(eviction) = eviction else {
                    break state;
                };
                if !capacity.reserved {
                    drop(state);
                    capacity = self.reserve_retirement_capacity(deadline, cancellation)?;
                    continue;
                }
                let Some(evicted) = state.entries.get(&eviction).cloned() else {
                    continue;
                };
                if state.retirement_reserved(&eviction, &evicted.connections) {
                    drop(state);
                    #[cfg(test)]
                    run_test_hook(TestHook::RetirementReservedWait, &eviction.path);
                    self.wait_retirement_change(deadline, cancellation)?;
                    continue;
                }
                let disposal = state.publish_retirement(&eviction, &evicted)?;
                capacity.publish(&mut state);
                let removed = state.entries.remove(&eviction);
                drop(state);
                #[cfg(test)]
                run_test_hook(TestHook::RetirementPublished, &eviction.path);
                drop(evicted);
                drop(removed);
                drop(disposal);
            };
            #[cfg(all(test, unix))]
            run_test_hook(TestHook::PreInsert, target.path());
            if cancellation.is_some_and(CancellationToken::is_cancelled) {
                drop(state);
                drop(build_guard);
                return Err(Error::Cancellation);
            }
            if state.tombstones.contains(target.path()) {
                drop(state);
                drop(build_guard);
                return Err(Error::Conflict("database is being deleted".into()));
            }
            state.clock = state.clock.saturating_add(1);
            let entry = Arc::new(DatabaseEntry {
                pool: ParkingRwLock::new(Some(pool)),
                bound,
                connections,
                owners,
                pool_wake,
                write_lock: Arc::new(ParkingMutex::new(())),
                index_lock: Arc::new(ParkingMutex::new(())),
                state: Mutex::new(EntryState {
                    last_used: state.clock,
                    ..EntryState::default()
                }),
                leases: Arc::new(DrainGate::default()),
            });
            state.entries.insert(key.clone(), entry.clone());
            state.building.remove(&key);
            self.build_changed.notify_all();
            build_guard.finish();
            drop(build_guard);
            drop(state);
            return Ok((key, entry, initial_probe));
        }
    }

    fn mark_schema_validated_entry(
        &self,
        entry: &Arc<DatabaseEntry>,
        identity: DatabaseSchemaIdentity,
    ) -> Result<(), Error> {
        entry
            .state
            .lock()
            .map_err(repository_state_poisoned)?
            .schema_identity = Some(identity);
        Ok(())
    }

    fn recover_vanished_holder_conflict(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        cancellation: Option<&CancellationToken>,
        attempted_retirement: &mut bool,
        error: Error,
    ) -> Result<bool, Error> {
        if *attempted_retirement
            || !matches!(&error, Error::Conflict(message)
                if message == DATABASE_OPEN_THROUGH_ANOTHER_NAME
                    || message == DATABASE_OPEN_THROUGH_ANOTHER_DIRECTORY)
        {
            return Err(error);
        }
        *attempted_retirement = true;
        self.retire_vanished_idle_holders(target, cancellation)?
            .ok_or(error)
    }

    /// Select only unowned idle holders, then preserve their WAL before the existing drain.
    /// The incoming predecessor admission and construction capacity must already be released.
    fn retire_vanished_idle_holders(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        cancellation: Option<&CancellationToken>,
    ) -> Result<Option<bool>, Error> {
        #[cfg(test)]
        self.vanished_retirement_attempts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let incoming = entry_key(target)?;
        let selected = {
            let state = self.state.lock().map_err(repository_state_poisoned)?;
            let mut stale = Vec::new();
            for (key, entry) in &state.entries {
                if *key == incoming
                    || key.identity != incoming.identity
                    || state.tombstones.contains(&key.path)
                    || Arc::strong_count(entry) != 1
                    || !entry.is_idle()
                {
                    continue;
                }
                if !entry.bound.retained_name_is_current()?
                    && Arc::strong_count(entry) == 1
                    && entry.is_idle()
                {
                    stale.push((key, entry));
                }
            }
            stale
                .into_iter()
                .map(|(key, entry)| {
                    entry.leases.close();
                    (key.clone(), Arc::clone(entry))
                })
                .collect::<Vec<_>>()
        };
        let mut retired = false;
        let mut wrote_main = false;
        let result = (|| {
            for (key, entry) in &selected {
                if cancellation.is_some_and(CancellationToken::is_cancelled) {
                    return Err(Error::Cancellation);
                }
                let preserved = {
                    let pool = entry.pool.read();
                    if let Some(pool) = pool.as_ref().filter(|pool| pool.state().connections != 0) {
                        // try_get never schedules a new connection. An idle connection's
                        // descriptors retain the vanished inode and its WAL.
                        let mut connection = pool.try_get().ok_or_else(|| {
                            Error::Conflict(
                                "database idle checkpoint connection is unavailable".into(),
                            )
                        })?;
                        #[derive(QueryableByName)]
                        struct Checkpoint {
                            #[diesel(sql_type = diesel::sql_types::Integer)]
                            busy: i32,
                        }
                        let mut checkpoint = || -> Result<Checkpoint, Error> {
                            Ok(sql_query("PRAGMA wal_checkpoint(TRUNCATE)")
                                .get_result::<Checkpoint>(&mut **connection)?)
                        };
                        let outcome = match cancellation {
                            Some(token) => super::sqlite_cancellation::with_sqlite_cancellation(
                                token, checkpoint,
                            )?,
                            None => checkpoint()?,
                        };
                        if outcome.busy != 0 {
                            return Err(Error::Conflict("database idle checkpoint is busy".into()));
                        }
                        true
                    } else {
                        #[cfg(test)]
                        run_test_hook(TestHook::VanishedHolderSelected, &key.path);
                        match entry.bound.move_vanished_wal(target)? {
                            VanishedWal::Empty => false,
                            VanishedWal::Moved => true,
                            VanishedWal::Unproven => return Ok(None),
                        }
                    }
                };
                self.retire_replaced(key, entry, cancellation)?;
                retired = true;
                wrote_main |= preserved;
            }
            Ok(retired.then_some(wrote_main))
        })();
        // Also restore any selected but unprocessed lease gates on an error. A published
        // retirement keeps its closed connection gate and cannot be reopened here.
        for (_, entry) in &selected {
            entry.cancel_retirement();
        }
        drop(selected);
        #[cfg(test)]
        if matches!(result, Ok(Some(_))) {
            run_test_hook(TestHook::VanishedHoldersRetired, target.path());
        }
        result
    }

    fn retire_replaced(
        &self,
        key: &EntryKey,
        entry: &Arc<DatabaseEntry>,
        cancellation: Option<&CancellationToken>,
    ) -> Result<(), Error> {
        let deadline = Instant::now() + self.retire_wait;
        entry.retire_and_wait_cancellable(
            deadline.saturating_duration_since(Instant::now()),
            cancellation,
        )?;
        let result = self.close_retired_entry_until(key, entry, deadline, cancellation);
        if result.is_err() {
            entry.cancel_retirement();
        }
        result
    }

    #[cfg(test)]
    fn close_retired_entry(
        &self,
        key: &EntryKey,
        entry: &Arc<DatabaseEntry>,
        cancellation: Option<&CancellationToken>,
    ) -> Result<(), Error> {
        self.close_retired_entry_until(key, entry, Instant::now() + self.retire_wait, cancellation)
    }

    fn close_retired_entry_until(
        &self,
        key: &EntryKey,
        entry: &Arc<DatabaseEntry>,
        deadline: Instant,
        cancellation: Option<&CancellationToken>,
    ) -> Result<(), Error> {
        let mut capacity = self.reserve_retirement_capacity(deadline, cancellation)?;
        let retirement = loop {
            let mut state = self.state.lock().map_err(repository_state_poisoned)?;
            state.prune_retirements();
            if let Some(retired) = state
                .retired
                .iter()
                .find(|retired| Arc::ptr_eq(&retired.connections, &entry.connections))
                .cloned()
            {
                break retired;
            }
            if state.retirement_reserved(key, &entry.connections) {
                drop(state);
                self.wait_retirement_change(deadline, cancellation)?;
                continue;
            }
            let disposal = state.publish_retirement(key, entry)?;
            capacity.publish(&mut state);
            let removed = if state
                .entries
                .get(key)
                .is_some_and(|current| Arc::ptr_eq(current, entry))
            {
                state.entries.remove(key)
            } else {
                None
            };
            let retirement =
                state.retired.last().cloned().ok_or_else(|| {
                    Error::Conflict("database retirement was not published".into())
                })?;
            drop(state);
            #[cfg(test)]
            run_test_hook(TestHook::RetirementPublished, &key.path);
            drop(entry.pool.write().take());
            drop(removed);
            drop(disposal);
            break retirement;
        };
        drop(capacity);
        retirement.wait(deadline, cancellation)
    }

    fn reserve_retirement_capacity(
        &self,
        deadline: Instant,
        cancellation: Option<&CancellationToken>,
    ) -> Result<RetirementCapacity, Error> {
        loop {
            if cancellation.is_some_and(CancellationToken::is_cancelled) {
                return Err(Error::Cancellation);
            }
            let mut state = self.state.lock().map_err(repository_state_poisoned)?;
            state.prune_retirements();
            if state.retired.len() + state.retirement_reservations < MAX_OPEN_DATABASES {
                state.retirement_reservations += 1;
                return Ok(RetirementCapacity {
                    state: Arc::clone(&self.state),
                    reserved: true,
                });
            }
            drop(state);
            #[cfg(test)]
            run_test_hook(TestHook::RetirementCapacityWait, std::path::Path::new("."));
            self.wait_retirement_change(deadline, cancellation)?;
        }
    }

    fn wait_retirement_change(
        &self,
        deadline: Instant,
        cancellation: Option<&CancellationToken>,
    ) -> Result<(), Error> {
        if cancellation.is_some_and(CancellationToken::is_cancelled) {
            return Err(Error::Cancellation);
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(Error::Conflict(
                "database retirement capacity timed out".into(),
            ));
        }
        let state = self.state.lock().map_err(repository_state_poisoned)?;
        drop(
            self.build_changed
                .wait_timeout(
                    state,
                    deadline
                        .saturating_duration_since(now)
                        .min(RETIRE_CANCELLATION_POLL),
                )
                .map_err(repository_state_poisoned)?,
        );
        Ok(())
    }

    fn eviction_candidate(
        &self,
        state: &RepositoryState,
        protected: &EntryKey,
    ) -> Option<EntryKey> {
        state
            .entries
            .iter()
            .filter(|(key, entry)| {
                *key != protected && Arc::strong_count(entry) == 1 && entry.is_idle()
            })
            .filter_map(|(path, entry)| {
                entry
                    .state
                    .lock()
                    .ok()
                    .map(|entry_state| (path.clone(), entry_state.last_used))
            })
            .min_by_key(|(_, last_used)| *last_used)
            .map(|(path, _)| path)
    }

    fn probe_current(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
    ) -> Result<RegularFileMetadata, Error> {
        let result = target.probe_current();
        #[cfg(test)]
        run_test_hook(TestHook::AfterProbeCurrent, target.path());
        result
    }

    fn entry_probe(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        key: &EntryKey,
        cancellation: Option<&CancellationToken>,
    ) -> Result<RegularFileMetadata, Error> {
        match self.probe_current(target) {
            Ok(probe) => Ok(probe),
            Err(error @ Error::Conflict(_)) => match self.probe_current(target) {
                Ok(probe) => Ok(probe),
                Err(Error::Conflict(_)) => {
                    let stale_entry = self
                        .state
                        .lock()
                        .map_err(repository_state_poisoned)?
                        .entries
                        .get(key)
                        .cloned();
                    if let Some(entry) = stale_entry {
                        let active = entry.leases.snapshot().outstanding;
                        if active == 0 {
                            self.retire_replaced(key, &entry, cancellation)?;
                        }
                    }
                    Err(error)
                }
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        }
    }

    fn acquire_probed(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        cancellation: Option<&CancellationToken>,
    ) -> Result<AcquiredConnection, Error> {
        self.acquire_probed_until(target, Instant::now() + self.retire_wait, cancellation)
    }

    fn acquire_probed_until(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        deadline: Instant,
        cancellation: Option<&CancellationToken>,
    ) -> Result<AcquiredConnection, Error> {
        let (key, entry, _) = self.entry_until(target, deadline, cancellation)?;
        let lease = entry.acquire()?;
        #[cfg(all(test, unix))]
        run_test_hook(TestHook::PreGet, target.path());
        if let Err(error) = self.probe_current(target) {
            drop(lease);
            return Err(self.retire_after_probe_conflict(&key, &entry, error, cancellation)?);
        }
        let refusal_count = entry.bound.refusal_count();
        #[cfg(test)]
        run_test_hook(TestHook::BeforePoolGet, target.path());
        let connection =
            match entry.get_connection_cancellable(&self.state, &key, deadline, cancellation) {
                Ok(connection) => connection,
                Err(error) => {
                    if matches!(error, Error::Cancellation | Error::Conflict(_))
                        && target.probe_current().is_ok()
                    {
                        return Err(error);
                    }
                    #[cfg(test)]
                    run_test_hook(TestHook::PoolGetFailed, target.path());
                    let error =
                        self.classify_bound_open_error(target, &entry.bound, refusal_count, error);
                    drop(lease);
                    return Err(self.retire_after_probe_conflict(
                        &key,
                        &entry,
                        error,
                        cancellation,
                    )?);
                }
            };
        #[cfg(test)]
        run_test_hook(TestHook::PostGet, target.path());
        let post_get_probe = match self.probe_current(target) {
            Ok(probe) => probe,
            Err(error) => {
                drop(connection);
                drop(lease);
                return Err(self.retire_after_probe_conflict(&key, &entry, error, cancellation)?);
            }
        };
        Ok((entry, lease, connection, post_get_probe))
    }

    fn acquire_bound(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
    ) -> Result<BoundDatabase, Error> {
        #[cfg(test)]
        run_test_hook(TestHook::BeforeAcquireBound, target.path());
        let result = BoundDatabase::acquire(target);
        #[cfg(unix)]
        return result.map_err(|error| self.classify_bound_failure(target, false, error));
        #[cfg(windows)]
        result
    }

    fn classify_bound_open_error(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        bound: &BoundDatabase,
        refusal_count_before: u64,
        error: Error,
    ) -> Error {
        self.classify_bound_failure(target, bound.refusal_count() > refusal_count_before, error)
    }

    fn classify_bound_failure(
        &self,
        target: &crate::infra::path_authority::DatabaseFileTarget,
        refused_identity: bool,
        error: Error,
    ) -> Error {
        #[cfg(test)]
        if refused_identity {
            run_test_hook(TestHook::BoundRefusal, target.path());
        }
        classify_bound_open_error_result(
            refused_identity,
            || {
                let probe = target.probe_current().map(|_| ());
                #[cfg(test)]
                if matches!(&probe, Err(Error::Conflict(_))) {
                    run_test_hook(TestHook::BoundRefusal, target.path());
                }
                probe
            },
            error,
        )
    }

    fn retire_after_probe_conflict(
        &self,
        key: &EntryKey,
        entry: &Arc<DatabaseEntry>,
        error: Error,
        cancellation: Option<&CancellationToken>,
    ) -> Result<Error, Error> {
        if !matches!(&error, Error::Conflict(_)) {
            return Err(error);
        }
        let active = entry.leases.snapshot().outstanding;
        if active == 0 {
            self.retire_replaced(key, entry, cancellation)?;
        }
        Ok(error)
    }

    fn wait_while_building_key(
        &self,
        key: &EntryKey,
        deadline: Instant,
        cancellation: Option<&CancellationToken>,
    ) -> Result<(), Error> {
        let state = self.state.lock().map_err(repository_state_poisoned)?;
        drop(self.wait_while_building_until(state, key, deadline, cancellation)?);
        Ok(())
    }

    fn wait_while_building_until<'a>(
        &self,
        mut state: std::sync::MutexGuard<'a, RepositoryState>,
        key: &EntryKey,
        deadline: Instant,
        cancellation: Option<&CancellationToken>,
    ) -> Result<std::sync::MutexGuard<'a, RepositoryState>, Error> {
        while state.building.contains(key) {
            if cancellation.is_some_and(CancellationToken::is_cancelled) {
                return Err(Error::Cancellation);
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(Error::Conflict("database construction timed out".into()));
            }
            let duration = if cancellation.is_some() {
                deadline
                    .saturating_duration_since(now)
                    .min(RETIRE_CANCELLATION_POLL)
            } else {
                deadline.saturating_duration_since(now)
            };
            let (guard, result) = self
                .build_changed
                .wait_timeout(state, duration)
                .map_err(repository_state_poisoned)?;
            state = guard;
            if result.timed_out() && state.building.contains(key) && Instant::now() >= deadline {
                return Err(Error::Conflict("database construction timed out".into()));
            }
        }
        Ok(state)
    }
}

fn entry_key(target: &crate::infra::path_authority::DatabaseFileTarget) -> Result<EntryKey, Error> {
    Ok(EntryKey {
        identity: target.identity(),
        parent_identity: crate::infra::path_authority::opened_file_identity(target.parent())?,
        path: target.path().to_owned(),
    })
}

fn classify_bound_open_error_result(
    refused_identity: bool,
    probe_current: impl FnOnce() -> Result<(), Error>,
    original: Error,
) -> Error {
    if refused_identity {
        return Error::Conflict("database changed after capability resolution".into());
    }
    match probe_current() {
        Err(Error::Conflict(_)) => {
            Error::Conflict("database changed after capability resolution".into())
        }
        Err(error) => error,
        Ok(()) => original,
    }
}

#[derive(QueryableByName)]
struct RevisionRow {
    #[diesel(sql_type = Nullable<Text>)]
    value: Option<String>,
}

#[derive(QueryableByName)]
struct CountRow {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    count: i64,
}

pub(crate) fn read_data_revision(conn: &mut SqliteConnection) -> Result<u64, Error> {
    let info_exists = sql_query(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'Info'",
    )
    .get_result::<CountRow>(conn)?
    .count
        != 0;
    if !info_exists {
        return Ok(0);
    }

    let Some(row) = sql_query("SELECT Value AS value FROM Info WHERE Name = 'DataRevision'")
        .get_result::<RevisionRow>(conn)
        .optional()?
    else {
        return Ok(0);
    };
    let Some(value) = row.value else {
        return Err(Error::InvalidInput(
            "DataRevision is not a non-negative i64".into(),
        ));
    };
    let value = value
        .parse::<i64>()
        .map_err(|_| Error::InvalidInput("DataRevision is not a non-negative i64".into()))?;
    if value < 0 {
        return Err(Error::InvalidInput(
            "DataRevision is not a non-negative i64".into(),
        ));
    }
    u64::try_from(value)
        .map_err(|_| Error::InvalidInput("DataRevision is not a non-negative i64".into()))
}

struct BuildGuard<'a> {
    repository: &'a DatabaseRepository,
    key: EntryKey,
    finished: bool,
}

impl BuildGuard<'_> {
    fn finish(&mut self) {
        self.finished = true;
    }
}

impl Drop for BuildGuard<'_> {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        if let Ok(mut state) = self.repository.state.lock() {
            state.building.remove(&self.key);
            self.repository.build_changed.notify_all();
        }
    }
}

struct TombstoneGuard<'a> {
    repository: &'a DatabaseRepository,
    path: PathBuf,
    entry: Option<Arc<DatabaseEntry>>,
    disarmed: bool,
    admission: Option<Arc<Admission>>,
}

impl<'a> TombstoneGuard<'a> {
    fn new(
        repository: &'a DatabaseRepository,
        path: PathBuf,
        entry: Option<Arc<DatabaseEntry>>,
    ) -> Self {
        Self {
            repository,
            path,
            entry,
            disarmed: false,
            admission: None,
        }
    }

    fn disarm(&mut self) {
        self.disarmed = true;
    }
}

impl Drop for TombstoneGuard<'_> {
    fn drop(&mut self) {
        if self.disarmed {
            return;
        }
        if let Some(entry) = &self.entry {
            entry.cancel_retirement();
        }
        if let Ok(mut state) = self.repository.state.lock() {
            state.tombstones.remove(&self.path);
        }
    }
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum TestHook {
    #[cfg(unix)]
    PreBuild,
    #[cfg(unix)]
    PostBuild,
    #[cfg(unix)]
    PreInsert,
    #[cfg(unix)]
    PreGet,
    BeforePoolGet,
    PoolGetFailed,
    BoundRefusal,
    PostGet,
    AfterProbeCurrent,
    AfterReadRevision,
    WorkerBeforeAdmission,
    WorkerAfterAdmission,
    WorkerBeforeEstablish,
    PredecessorWait,
    WorkerPredecessorWait,
    PredecessorDrained,
    RetirementPublished,
    RetirementCapacityWait,
    RetirementReservedWait,
    VanishedHolderSelected,
    VanishedHoldersRetired,
    BeforeVanishedShmRename,
    BeforeAcquireBound,
    ScanBeforeAdmission,
    ScanAfterEstablish,
    ScanValidationCheckpoint,
    PoolBeyondRetireDeadline,
    PoolBeforeFailureArbitration,
    #[cfg(unix)]
    AfterBumpOp,
    #[cfg(unix)]
    BeforeRevisionBump,
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct TestHooks {
    generation: u64,
    scope: Option<PathBuf>,
    by_path: HashMap<(TestHook, PathBuf), Box<dyn FnMut() + Send>>,
    #[cfg(unix)]
    pub(crate) pre_build: Option<Box<dyn FnMut() + Send>>,
    #[cfg(unix)]
    pub(crate) post_build: Option<Box<dyn FnMut() + Send>>,
    #[cfg(unix)]
    pub(crate) pre_insert: Option<Box<dyn FnMut() + Send>>,
    #[cfg(unix)]
    pub(crate) pre_get: Option<Box<dyn FnMut() + Send>>,
    pub(crate) before_pool_get: Option<Box<dyn FnMut() + Send>>,
    pub(crate) pool_get_failed: Option<Box<dyn FnMut() + Send>>,
    pub(crate) bound_refusal: Option<Box<dyn FnMut() + Send>>,
    pub(crate) post_get: Option<Box<dyn FnMut() + Send>>,
    pub(crate) after_probe_current: Option<Box<dyn FnMut(usize) + Send>>,
    pub(crate) after_read_revision: Option<Box<dyn FnMut() + Send>>,
    worker_before_admission: Option<Box<dyn FnMut() + Send>>,
    worker_after_admission: Option<Box<dyn FnMut() + Send>>,
    worker_before_establish: Option<Box<dyn FnMut() + Send>>,
    predecessor_wait: Option<Box<dyn FnMut() + Send>>,
    worker_predecessor_wait: Option<Box<dyn FnMut() + Send>>,
    predecessor_drained: Option<Box<dyn FnMut() + Send>>,
    retirement_published: Option<Box<dyn FnMut() + Send>>,
    retirement_capacity_wait: Option<Box<dyn FnMut() + Send>>,
    retirement_reserved_wait: Option<Box<dyn FnMut() + Send>>,
    scan_before_admission: Option<Box<dyn FnMut() + Send>>,
    scan_after_establish: Option<Box<dyn FnMut() + Send>>,
    scan_validation_checkpoint: Option<Box<dyn FnMut() + Send>>,
    pool_beyond_retire_deadline: Option<Box<dyn FnMut() + Send>>,
    #[cfg(unix)]
    pub(crate) after_bump_op: Option<Box<dyn FnMut() + Send>>,
    #[cfg(unix)]
    pub(crate) before_revision_bump: Option<Box<dyn FnMut() + Send>>,
    pub(crate) probe_current_count: usize,
}

#[cfg(test)]
static TEST_HOOKS: std::sync::OnceLock<std::sync::Mutex<TestHooks>> = std::sync::OnceLock::new();

#[cfg(test)]
static TEST_HOOK_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
static NEXT_TEST_HOOK_GENERATION: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(1);

#[cfg(test)]
fn test_hook_scope_matches(hooks: &TestHooks, path: &Path) -> bool {
    let normalized_path = normalize_test_hook_path(path);
    hooks
        .scope
        .as_deref()
        .is_some_and(|scope| normalized_path.starts_with(scope))
}

#[cfg(test)]
fn normalize_test_hook_path(scope: &Path) -> PathBuf {
    if scope.is_dir() {
        return scope.canonicalize().unwrap_or_else(|_| scope.to_path_buf());
    }

    let Some(file_name) = scope.file_name().filter(|name| !name.is_empty()) else {
        return scope.to_path_buf();
    };
    let parent = scope
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::canonicalize(parent)
        .map(|parent| parent.join(file_name))
        .unwrap_or_else(|_| scope.to_path_buf())
}

#[cfg(test)]
pub(crate) struct TestHooksGuard {
    previous: Option<TestHooks>,
    _serial: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
pub(crate) fn configure_test_hooks(
    scope: impl AsRef<Path>,
    configure: impl FnOnce(&mut TestHooks),
) -> TestHooksGuard {
    let serial = TEST_HOOK_SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let scope = normalize_test_hook_path(scope.as_ref());
    let generation = NEXT_TEST_HOOK_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut guard = TestHooksGuard {
        previous: None,
        _serial: serial,
    };
    let hooks_mutex = TEST_HOOKS.get_or_init(|| std::sync::Mutex::new(TestHooks::default()));
    let mut hooks = hooks_mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.previous = Some(std::mem::take(&mut *hooks));
    hooks.generation = generation;
    hooks.scope = Some(scope);
    configure(&mut hooks);
    guard
}

#[cfg(test)]
impl Drop for TestHooksGuard {
    fn drop(&mut self) {
        let Some(previous) = self.previous.take() else {
            return;
        };
        if let Some(hooks) = TEST_HOOKS.get() {
            let mut hooks = hooks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let _ = std::mem::replace(&mut *hooks, previous);
        }
    }
}

#[cfg(test)]
pub(crate) fn run_test_hook(hook: TestHook, path: &Path) {
    match hook {
        #[cfg(unix)]
        TestHook::PreBuild | TestHook::PostBuild | TestHook::PreInsert | TestHook::PreGet => {
            run_noarg_test_hook(hook, path)
        }
        TestHook::BeforePoolGet
        | TestHook::PoolGetFailed
        | TestHook::BoundRefusal
        | TestHook::PostGet => run_noarg_test_hook(hook, path),
        TestHook::AfterProbeCurrent => run_after_probe_current_test_hook(path),
        TestHook::AfterReadRevision => run_noarg_test_hook(hook, path),
        TestHook::WorkerBeforeAdmission
        | TestHook::WorkerAfterAdmission
        | TestHook::WorkerBeforeEstablish
        | TestHook::PredecessorWait
        | TestHook::WorkerPredecessorWait
        | TestHook::PredecessorDrained
        | TestHook::RetirementPublished
        | TestHook::RetirementCapacityWait
        | TestHook::RetirementReservedWait
        | TestHook::VanishedHolderSelected
        | TestHook::VanishedHoldersRetired
        | TestHook::BeforeVanishedShmRename
        | TestHook::BeforeAcquireBound
        | TestHook::ScanBeforeAdmission
        | TestHook::ScanAfterEstablish
        | TestHook::ScanValidationCheckpoint
        | TestHook::PoolBeyondRetireDeadline
        | TestHook::PoolBeforeFailureArbitration => run_noarg_test_hook(hook, path),
        #[cfg(unix)]
        TestHook::AfterBumpOp => run_noarg_test_hook(hook, path),
        #[cfg(unix)]
        TestHook::BeforeRevisionBump => run_noarg_test_hook(hook, path),
    }
}

#[cfg(test)]
fn run_noarg_test_hook(hook: TestHook, path: &Path) {
    let hooks_mutex = TEST_HOOKS.get_or_init(|| std::sync::Mutex::new(TestHooks::default()));
    let mut hooks = hooks_mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !test_hook_scope_matches(&hooks, path) {
        return;
    }
    let mut callback = hooks
        .by_path
        .remove(&(hook, normalize_test_hook_path(path)))
        .or_else(|| match hook {
            #[cfg(unix)]
            TestHook::PreBuild => hooks.pre_build.take(),
            #[cfg(unix)]
            TestHook::PostBuild => hooks.post_build.take(),
            #[cfg(unix)]
            TestHook::PreInsert => hooks.pre_insert.take(),
            #[cfg(unix)]
            TestHook::PreGet => hooks.pre_get.take(),
            TestHook::BeforePoolGet => hooks.before_pool_get.take(),
            TestHook::PoolGetFailed => hooks.pool_get_failed.take(),
            TestHook::BoundRefusal => hooks.bound_refusal.take(),
            TestHook::PostGet => hooks.post_get.take(),
            TestHook::AfterProbeCurrent
            | TestHook::PoolBeforeFailureArbitration
            | TestHook::VanishedHolderSelected
            | TestHook::VanishedHoldersRetired
            | TestHook::BeforeVanishedShmRename
            | TestHook::BeforeAcquireBound => None,
            TestHook::AfterReadRevision => hooks.after_read_revision.take(),
            TestHook::WorkerBeforeAdmission => hooks.worker_before_admission.take(),
            TestHook::WorkerAfterAdmission => hooks.worker_after_admission.take(),
            TestHook::WorkerBeforeEstablish => hooks.worker_before_establish.take(),
            TestHook::PredecessorWait => hooks.predecessor_wait.take(),
            TestHook::WorkerPredecessorWait => hooks.worker_predecessor_wait.take(),
            TestHook::PredecessorDrained => hooks.predecessor_drained.take(),
            TestHook::RetirementPublished => hooks.retirement_published.take(),
            TestHook::RetirementCapacityWait => hooks.retirement_capacity_wait.take(),
            TestHook::RetirementReservedWait => hooks.retirement_reserved_wait.take(),
            TestHook::ScanBeforeAdmission => hooks.scan_before_admission.take(),
            TestHook::ScanAfterEstablish => hooks.scan_after_establish.take(),
            TestHook::ScanValidationCheckpoint => hooks.scan_validation_checkpoint.take(),
            TestHook::PoolBeyondRetireDeadline => hooks.pool_beyond_retire_deadline.take(),
            #[cfg(unix)]
            TestHook::AfterBumpOp => hooks.after_bump_op.take(),
            #[cfg(unix)]
            TestHook::BeforeRevisionBump => hooks.before_revision_bump.take(),
        });
    let generation = hooks.generation;
    drop(hooks);
    if let Some(mut callback_fn) = callback.take() {
        callback_fn();
        let mut hooks = hooks_mutex
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if hooks.generation == generation {
            match hook {
                #[cfg(unix)]
                TestHook::PreBuild => hooks.pre_build = Some(callback_fn),
                #[cfg(unix)]
                TestHook::PostBuild => hooks.post_build = Some(callback_fn),
                #[cfg(unix)]
                TestHook::PreInsert => hooks.pre_insert = Some(callback_fn),
                #[cfg(unix)]
                TestHook::PreGet => hooks.pre_get = Some(callback_fn),
                TestHook::BeforePoolGet | TestHook::PoolGetFailed | TestHook::BoundRefusal => {}
                TestHook::PostGet | TestHook::AfterProbeCurrent => {}
                TestHook::AfterReadRevision => hooks.after_read_revision = Some(callback_fn),
                TestHook::WorkerBeforeAdmission
                | TestHook::WorkerAfterAdmission
                | TestHook::WorkerBeforeEstablish
                | TestHook::WorkerPredecessorWait
                | TestHook::PredecessorDrained
                | TestHook::RetirementPublished
                | TestHook::RetirementCapacityWait
                | TestHook::RetirementReservedWait
                | TestHook::ScanBeforeAdmission
                | TestHook::ScanAfterEstablish
                | TestHook::ScanValidationCheckpoint
                | TestHook::PoolBeyondRetireDeadline
                | TestHook::PoolBeforeFailureArbitration => {}
                TestHook::VanishedHolderSelected
                | TestHook::VanishedHoldersRetired
                | TestHook::BeforeVanishedShmRename
                | TestHook::BeforeAcquireBound => {
                    hooks
                        .by_path
                        .insert((hook, normalize_test_hook_path(path)), callback_fn);
                }
                TestHook::PredecessorWait => hooks.predecessor_wait = Some(callback_fn),
                #[cfg(unix)]
                TestHook::AfterBumpOp => hooks.after_bump_op = Some(callback_fn),
                #[cfg(unix)]
                TestHook::BeforeRevisionBump => hooks.before_revision_bump = Some(callback_fn),
            }
        }
    }
}

#[cfg(test)]
fn run_after_probe_current_test_hook(path: &Path) {
    let hooks_mutex = TEST_HOOKS.get_or_init(|| std::sync::Mutex::new(TestHooks::default()));
    let mut hooks = hooks_mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !test_hook_scope_matches(&hooks, path) {
        return;
    }
    hooks.probe_current_count = hooks.probe_current_count.saturating_add(1);
    let (mut callback, count, generation) = (
        hooks.after_probe_current.take(),
        hooks.probe_current_count,
        hooks.generation,
    );
    drop(hooks);
    if let Some(mut callback_fn) = callback.take() {
        callback_fn(count);
        let mut hooks = hooks_mutex
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if hooks.generation == generation {
            hooks.after_probe_current = Some(callback_fn);
        }
    }
}

impl DatabaseEntry {
    #[cfg(test)]
    fn get_connection(&self) -> Result<PooledConnection<BoundConnectionManager>, Error> {
        let pool = self.pool.read();
        let pool = pool
            .as_ref()
            .ok_or_else(|| Error::Conflict("database pool has been retired".into()))?;
        pool.get().map_err(Error::from)
    }

    fn get_connection_cancellable(
        &self,
        state: &Arc<Mutex<RepositoryState>>,
        key: &EntryKey,
        deadline: Instant,
        cancellation: Option<&CancellationToken>,
    ) -> Result<PooledConnection<BoundConnectionManager>, Error> {
        let pool = self
            .pool
            .read()
            .as_ref()
            .cloned()
            .ok_or_else(|| Error::Conflict("database pool has been retired".into()))?;
        let pool_deadline = Instant::now() + pool.connection_timeout();
        let mut requested = false;
        let mut pool_failure = None;
        loop {
            // Each caller observes its own barrier, token and absolute deadline.
            drop(predecessor_admission(
                state,
                key,
                Some(&self.connections),
                deadline,
                cancellation,
            )?);
            let generation = *self.pool_wake.generation.lock();
            // Sample before availability. AcquireEvent clears stale failure before r2d2
            // inserts its connection, so it is not itself an availability notification.
            let failure = self.pool_wake.failure.lock().latest.clone();
            let remaining = pool_deadline.saturating_duration_since(Instant::now());
            #[cfg(test)]
            if Instant::now() >= deadline && remaining > RETIRE_CANCELLATION_POLL {
                run_test_hook(TestHook::PoolBeyondRetireDeadline, &key.path);
            }
            // One nonblocking get starts replenishment. Subsequent probes neither consume
            // r2d2's diagnostic nor start an extra worker at the terminal timeout.
            let available = if requested {
                pool.try_get()
            } else {
                // try_get alone never schedules r2d2 replenishment for an empty pool.
                requested = true;
                match pool.get_timeout(Duration::ZERO) {
                    Ok(connection) => Some(connection),
                    Err(error) => {
                        pool_failure = Some(error);
                        None
                    }
                }
            };
            if let Some(connection) = available {
                let _admission = predecessor_admission(
                    state,
                    key,
                    Some(&self.connections),
                    deadline,
                    cancellation,
                )?;
                return Ok(connection);
            }
            if failure.as_ref().is_some_and(|failure| failure.native_open) || remaining.is_zero() {
                let _admission = predecessor_admission(
                    state,
                    key,
                    Some(&self.connections),
                    deadline,
                    cancellation,
                )?;
                // A success or newer failure since the availability observation requires
                // another observation. There is no atomic publication seam across r2d2.
                #[cfg(test)]
                run_test_hook(TestHook::PoolBeforeFailureArbitration, &key.path);
                let current = self.pool_wake.failure.lock();
                match (failure, current.latest.as_ref()) {
                    (Some(failure), Some(latest)) if Arc::ptr_eq(&latest.error, &failure.error) => {
                        return Err(Error::Shared(failure.error));
                    }
                    (None, None) => {}
                    _ => continue,
                }
                drop(current);
                return Err(pool_failure.take().map(Error::from).unwrap_or_else(|| {
                    Error::Conflict("database connection acquisition timed out".into())
                }));
            }
            self.pool_wake
                .wait_since(generation, remaining.min(RETIRE_CANCELLATION_POLL));
        }
    }

    fn acquire(self: &Arc<Self>) -> Result<EntryLease, Error> {
        self.leases
            .enter()
            .map(|_ticket| EntryLease {
                _entry: self.clone(),
                _ticket,
            })
            .ok_or_else(|| Error::Conflict("database is being replaced or deleted".into()))
    }

    #[cfg(test)]
    fn retire_and_wait(&self, timeout: Duration) -> Result<(), Error> {
        self.retire_and_wait_cancellable(timeout, None)
    }

    fn retire_and_wait_cancellable(
        &self,
        timeout: Duration,
        cancellation: Option<&CancellationToken>,
    ) -> Result<(), Error> {
        self.leases.close();
        let result =
            self.leases
                .wait_drained(timeout, cancellation, "database retirement timed out");
        if result.is_err() {
            self.cancel_retirement();
        }
        result
    }

    fn cancel_retirement(&self) {
        if !self.connections.snapshot().closed {
            self.leases.reopen();
        }
    }

    fn is_idle(&self) -> bool {
        let snapshot = self.leases.snapshot();
        snapshot.outstanding == 0 && !snapshot.closed
    }
}

#[cfg(test)]
mod drain_gate_tests {
    use super::*;

    #[test]
    fn close_refuses_tickets_until_reopened() {
        let gate = Arc::new(DrainGate::default());
        gate.close();
        assert!(gate.enter().is_none());
        gate.reopen();
        assert!(gate.enter().is_some());
    }

    #[test]
    fn wait_drained_blocks_until_the_held_ticket_is_dropped() {
        let gate = Arc::new(DrainGate::default());
        let ticket = gate.enter().expect("open gate issues a ticket");
        let dropped_at = std::sync::OnceLock::new();
        gate.close();
        std::thread::scope(|scope| {
            let release_record = &dropped_at;
            let started = spawn_after_release_delay(scope, move || {
                release_record
                    .set(Instant::now())
                    .expect("ticket release is recorded once");
                drop(ticket);
            });

            let result = gate.wait_drained(Duration::from_secs(10), None, "t");
            let returned_at = Instant::now();
            assert_eq!(gate.snapshot().outstanding, 0);
            assert!(result.is_ok());
            let dropped_at = dropped_at
                .get()
                .expect("ticket release must be recorded before drain returns");
            assert!(
                returned_at >= *dropped_at,
                "drain wait returned before ticket release was recorded"
            );
            assert!(started.elapsed() >= RELEASE_DELAY);
        });
        assert_eq!(gate.snapshot().outstanding, 0);
    }

    #[test]
    fn wait_drained_reports_deadline_without_reopening_gate() {
        let gate = Arc::new(DrainGate::default());
        let _ticket = gate.enter().expect("open gate issues a ticket");
        gate.close();

        assert!(matches!(
            gate.wait_drained(
                Duration::from_millis(50),
                None,
                "drain timed out"
            ),
            Err(Error::Conflict(message)) if message == "drain timed out"
        ));
        assert!(gate.snapshot().closed);
    }

    #[test]
    fn wait_drained_observes_an_already_cancelled_token() {
        let gate = Arc::new(DrainGate::default());
        let _ticket = gate.enter().expect("open gate issues a ticket");
        gate.close();
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        assert!(matches!(
            gate.wait_drained(Duration::from_secs(10), Some(&cancellation), "t"),
            Err(Error::Cancellation)
        ));
    }

    #[test]
    fn wait_drained_reports_cancellation_even_when_already_drained() {
        let gate = Arc::new(DrainGate::default());
        gate.close();
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        assert!(matches!(
            gate.wait_drained(Duration::from_secs(1), Some(&cancellation), "t"),
            Err(Error::Cancellation)
        ));
    }
}

#[cfg(test)]
pub(crate) fn test_target(path: &Path) -> crate::infra::path_authority::DatabaseFileTarget {
    crate::infra::path_authority::DatabaseFileTarget::for_test_path(path)
        .expect("test database path must produce a target")
}

#[cfg(test)]
mod retirement_tests {
    use super::*;
    use diesel::{connection::SimpleConnection, RunQueryDsl};
    use std::sync::mpsc;

    const SIGNAL_TIMEOUT: Duration = Duration::from_secs(10);
    const SHORT_WAIT: Duration = Duration::from_millis(300);
    // Retirement completion stays bounded independently of the ordinary pool timeout.
    const COMPLETION_BOUND: Duration = Duration::from_millis(1500);
    const MULTI_PREDECESSOR_BUDGET: Duration = Duration::from_millis(700);
    const FIRST_PREDECESSOR_RELEASE_DELAY: Duration = Duration::from_millis(500);
    // Above the single retirement budget, below release delay + a refreshed retirement budget.
    const MULTI_PREDECESSOR_COMPLETION_BOUND: Duration = Duration::from_millis(1050);

    #[test]
    fn ordinary_empty_refusal_preserves_explicit_initialization() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("empty.db3");
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        for _ in 0..3 {
            assert!(matches!(
                repository.connection(&target, None),
                Err(Error::InvalidInput(message))
                    if message == "Database has not been initialized yet"
            ));
            assert!(std::fs::read(&path).unwrap().is_empty());
            assert_eq!(target.probe_current().unwrap().identity, target.identity());
            assert!(repository.state.lock().unwrap().entries.is_empty());
        }
        let mut initialized = repository.initialization_connection(&target, None).unwrap();
        assert!(migrations::prepare_database(&mut initialized, "Explicit import", "kept").unwrap());
        drop(initialized);
        let mut ordinary = repository.connection(&target, None).unwrap();
        let title = sql_query("SELECT Value AS value FROM Info WHERE Name='Title'")
            .get_result::<RevisionRow>(&mut *ordinary)
            .unwrap();
        assert_eq!(title.value.as_deref(), Some("Explicit import"));
    }

    #[test]
    fn ordinary_empty_cancellation_and_deletion_precede_uninitialized() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("empty.db3");
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(matches!(
            repository.connection(&target, Some(&cancellation)),
            Err(Error::Cancellation)
        ));
        let deletion = repository.reserve_for_deletion(&target, None).unwrap();
        assert!(matches!(
            repository.connection(&target, None),
            Err(Error::Conflict(message)) if message == "database is being deleted"
        ));
        assert!(matches!(
            repository.connection(&target, Some(&cancellation)),
            Err(Error::Cancellation)
        ));
        repository.release_deletion(deletion).unwrap();
        assert!(std::fs::read(&path).unwrap().is_empty());
        assert!(repository.state.lock().unwrap().entries.is_empty());
    }

    #[test]
    fn ordinary_empty_retained_identity_refuses_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("empty.db3");
        let held = directory.path().join("held.db3");
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        std::fs::rename(&path, &held).unwrap();
        std::fs::File::create(&path).unwrap();
        assert!(matches!(
            repository.connection(&target, None),
            Err(Error::Conflict(message))
                if message == "database changed after capability resolution"
        ));
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(matches!(
            repository.connection(&target, Some(&cancellation)),
            Err(Error::Cancellation)
        ));
        assert!(std::fs::read(&path).unwrap().is_empty());
        assert!(std::fs::read(&held).unwrap().is_empty());
        assert!(repository.state.lock().unwrap().entries.is_empty());
    }

    #[test]
    fn ordinary_empty_mid_probe_cancellation_precedes_uninitialized() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("empty.db3");
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        let cancellation = CancellationToken::new();
        let callback_token = cancellation.clone();
        let _hooks = configure_test_hooks(&path, |hooks| {
            hooks.after_probe_current = Some(Box::new(move |_| callback_token.cancel()));
        });
        assert!(matches!(
            repository.connection(&target, Some(&cancellation)),
            Err(Error::Cancellation)
        ));
        assert!(std::fs::read(&path).unwrap().is_empty());
        assert!(repository.state.lock().unwrap().entries.is_empty());
    }

    #[test]
    fn ordinary_empty_mid_probe_tombstone_precedes_uninitialized() {
        let directory = tempfile::tempdir().unwrap();
        let child = directory.path().join("child");
        std::fs::create_dir(&child).unwrap();
        let path = child.join("..").join("empty.db3");
        let target = test_target(&path);
        assert_ne!(path, target.path());
        let repository = Arc::new(DatabaseRepository::default());
        let callback_repository = Arc::clone(&repository);
        let callback_path = target.path().to_path_buf();
        let _hooks = configure_test_hooks(&path, |hooks| {
            hooks.after_probe_current = Some(Box::new(move |_| {
                callback_repository
                    .state
                    .lock()
                    .unwrap()
                    .tombstones
                    .insert(callback_path.clone());
            }));
        });
        assert!(matches!(
            repository.connection(&target, None),
            Err(Error::Conflict(message)) if message == "database is being deleted"
        ));
        assert!(std::fs::read(&path).unwrap().is_empty());
        assert!(repository.state.lock().unwrap().entries.is_empty());
    }

    #[test]
    fn pool_wake_preserves_a_notification_published_before_wait() {
        let wake = PoolWake::default();
        let observed = *wake.generation.lock();
        wake.notify();
        assert_ne!(*wake.generation.lock(), observed);
        let (ready, readiness) = signal();
        let (done, completion) = signal();
        std::thread::scope(|scope| {
            let waiter = scope.spawn(|| {
                ready.send(()).unwrap();
                wake.wait_since(observed, SIGNAL_TIMEOUT);
                done.send(()).unwrap();
            });
            reached(&readiness);
            let deadline = Instant::now() + SIGNAL_TIMEOUT;
            let outcome = loop {
                if Instant::now() >= deadline {
                    break Err("notification completion was not observed");
                }
                if completion.try_recv().is_ok() {
                    break Ok(());
                }
                // A true result observes and releases a genuinely parked consumer. The first
                // production notification was already published, so it must not need this one.
                if wake.changed.notify_one() {
                    break Err("consumer parked for a second notification");
                }
                std::thread::yield_now();
            };
            // Release and join before asserting, including when the guard fault parks the waiter.
            wake.notify();
            waiter.join().unwrap();
            assert!(
                outcome.is_ok(),
                "POOL_WAKE_LOST_PUBLISHED_NOTIFICATION: {outcome:?}"
            );
        });
    }

    #[test]
    fn stale_retirement_cleanup_preserves_the_current_database_generation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("same-database.db3");
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        let (key, old, _) = repository.entry(&target, None).unwrap();
        old.get_connection()
            .unwrap()
            .batch_execute(
                "CREATE TABLE Retained (value INTEGER); INSERT INTO Retained VALUES (42);",
            )
            .unwrap();
        repository.retire_replaced(&key, &old, None).unwrap();
        assert!(old.pool.read().is_none());
        let (current_key, current, _) = repository.entry(&target, None).unwrap();
        assert_eq!(current_key, key);
        assert!(!Arc::ptr_eq(&current, &old));

        repository.close_retired_entry(&key, &old, None).unwrap();
        assert!(
            repository
                .state
                .lock()
                .unwrap()
                .entries
                .get(&key)
                .is_some_and(|entry| Arc::ptr_eq(entry, &current)),
            "STALE_RETIREMENT_REMOVED_CURRENT_GENERATION"
        );
        let (reused_key, reused, _) = repository.entry(&target, None).unwrap();
        assert_eq!(reused_key, key);
        assert!(Arc::ptr_eq(&reused, &current));
        current
            .get_connection()
            .unwrap()
            .batch_execute("UPDATE Retained SET value = value + 1 WHERE value = 42;")
            .unwrap();
        assert_eq!(
            diesel::select(diesel::dsl::sql::<diesel::sql_types::BigInt>(
                "(SELECT value FROM Retained)"
            ))
            .get_result::<i64>(&mut **reused.get_connection().unwrap())
            .unwrap(),
            43
        );
    }

    #[test]
    fn retirement_capacity_rechecks_cancellation_before_reserving() {
        let root = tempfile::tempdir().unwrap();
        let target = test_target(&root.path().join("capacity-cancellation.db3"));
        let repository = DatabaseRepository::default();
        let (key, entry, _) = repository.entry(&target, None).unwrap();
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let result = repository
            .reserve_retirement_capacity(Instant::now() + SIGNAL_TIMEOUT, Some(&cancellation));
        assert!(
            matches!(result, Err(Error::Cancellation)),
            "CANCELLED_RETIREMENT_CAPACITY_WAS_RESERVED"
        );
        {
            let state = repository.state.lock().unwrap();
            assert_eq!(state.retirement_reservations, 0);
            assert!(state.retired.is_empty());
            assert!(state.admissions.is_empty());
            assert!(state.building.is_empty());
            assert!(state.tombstones.is_empty());
            assert_eq!(state.entries.len(), 1);
            assert!(Arc::ptr_eq(state.entries.get(&key).unwrap(), &entry));
        }
        assert!(!entry.connections.snapshot().closed);
        assert!(!entry.owners.snapshot().closed);
        assert!(entry.pool.read().is_some());

        let uncancelled = CancellationToken::new();
        let reservation = repository
            .reserve_retirement_capacity(Instant::now() + SIGNAL_TIMEOUT, Some(&uncancelled))
            .unwrap();
        assert_eq!(repository.state.lock().unwrap().retirement_reservations, 1);
        drop(reservation);
        let state = repository.state.lock().unwrap();
        assert_eq!(state.retirement_reservations, 0);
        assert!(state.retired.is_empty());
        assert_eq!(state.entries.len(), 1);
        assert!(Arc::ptr_eq(state.entries.get(&key).unwrap(), &entry));
    }

    #[test]
    fn retired_pool_workers_discard_pending_scheduled_jobs() {
        const PENDING_JOB_DELAY: Duration = Duration::from_millis(200);
        const OBSERVATION_WAIT: Duration = Duration::from_millis(700);

        LAST_BUILT_POOL_WORKERS.with(|slot| slot.borrow_mut().take());
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("scheduler-retirement.db3");
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        let (_, entry, _) = repository.entry(&target, None).unwrap();
        let scheduler = LAST_BUILT_POOL_WORKERS
            .with(|slot| slot.borrow_mut().take())
            .expect("repository pool builder did not use pool_worker_threads");
        assert!(
            Arc::strong_count(&scheduler) >= 2,
            "live repository pool did not retain its worker scheduler"
        );
        let retired_scheduler = Arc::downgrade(&scheduler);
        let workers_ready = mpsc::channel();
        let release = Arc::new(std::sync::Barrier::new(POOL_WORKER_THREADS + 1));
        for _ in 0..POOL_WORKER_THREADS {
            let ready = workers_ready.0.clone();
            let release = Arc::clone(&release);
            scheduler.execute(move || {
                ready.send(()).unwrap();
                release.wait();
            });
        }
        for _ in 0..POOL_WORKER_THREADS {
            reached(&workers_ready.1);
        }

        let (completed, completion) = mpsc::channel();
        let scheduled_completion = completed.clone();
        scheduler.execute_after(PENDING_JOB_DELAY, move || {
            scheduled_completion.send(()).unwrap();
        });
        drop(scheduler);
        drop(entry);
        repository.close_and_invalidate(&target).unwrap();
        let deadline = Instant::now() + SIGNAL_TIMEOUT;
        while retired_scheduler.upgrade().is_some() {
            assert!(
                Instant::now() < deadline,
                "retired repository pool retained its worker scheduler"
            );
            std::thread::yield_now();
        }
        release.wait();
        // Keep the channel connected so the observation extends beyond the pending job's delay.
        assert!(
            matches!(
                completion.recv_timeout(OBSERVATION_WAIT),
                Err(mpsc::RecvTimeoutError::Timeout)
            ),
            "a retired pool ran a pending scheduled job"
        );
        drop(completed);
    }

    fn signal() -> (mpsc::Sender<()>, mpsc::Receiver<()>) {
        mpsc::channel()
    }

    fn reached(receiver: &mpsc::Receiver<()>) {
        receiver
            .recv_timeout(SIGNAL_TIMEOUT)
            .expect("lifecycle boundary was not reached");
    }

    fn pause(entered: mpsc::Sender<()>, resume: mpsc::Receiver<()>) -> Box<dyn FnMut() + Send> {
        Box::new(move || {
            entered.send(()).unwrap();
            resume
                .recv_timeout(SIGNAL_TIMEOUT)
                .expect("paused lifecycle was not resumed");
        })
    }

    fn path_in(root: &Path, parent: &str, leaf: &str) -> PathBuf {
        let directory = root.join(parent);
        std::fs::create_dir_all(&directory).unwrap();
        directory.join(leaf)
    }

    fn scan_target(
        path: &Path,
        expected_key: &EntryKey,
    ) -> crate::infra::path_authority::DatabaseFileTarget {
        // Scans write durable sidecars through the parent, which Windows cannot sync when read-only.
        let target =
            crate::infra::path_authority::DatabaseFileTarget::for_test_deletion(path).unwrap();
        assert_eq!(entry_key(&target).unwrap(), *expected_key);
        target
    }

    fn held_handle(
        repository: &DatabaseRepository,
        path: &Path,
    ) -> (
        EntryKey,
        Arc<DrainGate>,
        PooledConnection<BoundConnectionManager>,
    ) {
        let target = test_target(path);
        let (key, entry, _) = repository.entry(&target, None).unwrap();
        let mut held = entry.get_connection().unwrap();
        held.batch_execute("SELECT 1;").unwrap();
        let gate = Arc::clone(&entry.connections);
        drop(entry);
        (key, gate, held)
    }

    fn force_lru(repository: &DatabaseRepository, key: &EntryKey, root: &Path, tag: &str) {
        let predecessor_connections = {
            let state = repository.state.lock().unwrap();
            let entry = state
                .entries
                .get(key)
                .expect("predecessor must still be cached");
            assert_eq!(
                Arc::strong_count(entry),
                1,
                "LRU predecessor must have no external entry holder"
            );
            assert!(entry.is_idle(), "LRU predecessor must have no caller lease");
            Arc::clone(&entry.connections)
        };
        for index in 0..=MAX_OPEN_DATABASES {
            let path = path_in(root, tag, &format!("{index}.db3"));
            drop(repository.entry(&test_target(&path), None).unwrap());
            if repository
                .state
                .lock()
                .unwrap()
                .entries
                .get(key)
                .is_none_or(|entry| !Arc::ptr_eq(&entry.connections, &predecessor_connections))
            {
                return;
            }
        }
        panic!("real LRU selection did not remove the eligible predecessor");
    }

    fn assert_retained(repository: &DatabaseRepository, key: &EntryKey) -> Retirement {
        let state = repository.state.lock().unwrap();
        let retired = state
            .retired
            .iter()
            .find(|retired| retired.key == *key)
            .expect("undrained predecessor ownership must remain discoverable");
        assert!(!retired.complete());
        assert!(
            retired.connections.snapshot().closed,
            "retirement must close connection admission"
        );
        assert!(state.retired.len() + state.retirement_reservations <= MAX_OPEN_DATABASES);
        retired.clone()
    }

    #[test]
    fn lru_retains_actual_handle_and_fences_same_key_reopen() {
        let root = tempfile::tempdir().unwrap();
        let path = path_in(root.path(), "old", "database.db3");
        let repository = DatabaseRepository::default();
        let (key, gate, held) = held_handle(&repository, &path);
        force_lru(&repository, &key, root.path(), "churn");
        assert_retained(&repository, &key);
        assert!(gate.enter().is_none());
        let (waiting, waited) = signal();
        let _hooks = configure_test_hooks(&path, |hooks| {
            hooks.predecessor_wait = Some(Box::new(move || {
                waiting.send(()).unwrap();
            }))
        });
        std::thread::scope(|scope| {
            let (done, result) = mpsc::channel();
            let repository = &repository;
            let path = &path;
            scope.spawn(move || {
                done.send(
                    repository
                        .initialization_connection(&test_target(path), None)
                        .map(|_| ()),
                )
                .unwrap();
            });
            reached(&waited);
            assert!(
                result.try_recv().is_err(),
                "same-key reopen crossed a live predecessor"
            );
            let other = path_in(root.path(), "other", "progress.db3");
            drop(
                repository
                    .initialization_connection(&test_target(&other), None)
                    .unwrap(),
            );
            assert_retained(repository, &key);
            drop(held);
            result.recv_timeout(SIGNAL_TIMEOUT).unwrap().unwrap();
        });
        assert_eq!(gate.snapshot().outstanding, 0);
        assert!(repository.state.lock().unwrap().retired.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn cross_capability_retired_draining_pool_refuses_ordinary_alias_and_preserves_locks() {
        let root = tempfile::tempdir().unwrap();
        let path = path_in(root.path(), "holder", "database.db3");
        let repository = DatabaseRepository::default();
        let target = test_target(&path);
        let probe = std::fs::File::open(&path).unwrap();
        let (key, gate, mut held) = held_handle(&repository, &path);
        migrations::prepare_database(&mut held, "retired ownership", "").unwrap();
        held.batch_execute("BEGIN; SELECT Value FROM Info WHERE Name='DataRevision';")
            .unwrap();
        super::bound_sqlite_witnesses::assert_sqlite_shared_read_lock_is_held(&probe);
        force_lru(&repository, &key, root.path(), "churn");
        assert_retained(&repository, &key);
        let alias = path.with_file_name("alias.pgn");
        std::fs::hard_link(&path, &alias).unwrap();
        for leaf in [target.leaf(), alias.file_name().unwrap()] {
            let result = crate::infra::fs::open_regular_at(
                target.parent(),
                leaf,
                crate::infra::fs::RegularFileAccess::ReadOnly,
            );
            assert!(matches!(result, Err(Error::Conflict(_))));
            super::bound_sqlite_witnesses::assert_sqlite_shared_read_lock_is_held(&probe);
        }
        drop(held);
        assert_eq!(gate.snapshot().outstanding, 0);
        drop(repository);
        drop(probe);
        drop(
            crate::infra::fs::open_regular_at(
                target.parent(),
                target.leaf(),
                crate::infra::fs::RegularFileAccess::ReadOnly,
            )
            .unwrap(),
        );
    }

    #[cfg(unix)]
    #[test]
    fn cross_capability_ordinary_conflict_precedes_retired_parent_wait() {
        let root = tempfile::tempdir().unwrap();
        let path = path_in(root.path(), "holder", "database.db3");
        let repository = DatabaseRepository::default();
        let (key, _gate, held) = held_handle(&repository, &path);
        force_lru(&repository, &key, root.path(), "churn");
        assert_retained(&repository, &key);
        let ordinary_path = path.with_file_name("ordinary.db3");
        let target = test_target(&ordinary_path);
        let ordinary = crate::infra::fs::open_regular_at(
            target.parent(),
            target.leaf(),
            crate::infra::fs::RegularFileAccess::ReadOnly,
        )
        .unwrap();
        let cancellation = CancellationToken::new();
        let cancel_wait = cancellation.clone();
        let waited = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = Arc::clone(&waited);
        let _hooks = configure_test_hooks(&ordinary_path, |hooks| {
            hooks.predecessor_wait = Some(Box::new(move || {
                observed.store(true, std::sync::atomic::Ordering::SeqCst);
                cancel_wait.cancel();
            }));
        });
        let result = repository.initialization_connection(&target, Some(&cancellation));
        assert!(
            matches!(result, Err(Error::Conflict(_))),
            "an ordinary conflict must refuse before predecessor admission"
        );
        assert!(
            !waited.load(std::sync::atomic::Ordering::SeqCst),
            "ownership refusal cannot wait on retirement"
        );
        drop(ordinary);
        drop(held);
    }

    #[test]
    fn lru_disposal_is_outstanding_even_without_sqlite_tickets() {
        let root = tempfile::tempdir().unwrap();
        let path = path_in(root.path(), "old", "empty.db3");
        let repository = DatabaseRepository::default();
        let key = repository.entry(&test_target(&path), None).unwrap().0;
        let (published, publication) = signal();
        let (resume, resumed) = signal();
        let (waiting, waited) = signal();
        let _hooks = configure_test_hooks(&path, |hooks| {
            hooks.retirement_published = Some(pause(published, resumed));
            hooks.predecessor_wait = Some(Box::new(move || {
                waiting.send(()).unwrap();
            }));
        });
        std::thread::scope(|scope| {
            scope.spawn(|| force_lru(&repository, &key, root.path(), "churn"));
            reached(&publication);
            assert_retained(&repository, &key);
            assert_eq!(
                repository.state.lock().unwrap().retired[0]
                    .connections
                    .snapshot()
                    .outstanding,
                0
            );
            let (done, result) = mpsc::channel();
            let repository = &repository;
            let path = &path;
            scope.spawn(move || {
                done.send(
                    repository
                        .initialization_connection(&test_target(path), None)
                        .map(|_| ()),
                )
                .unwrap();
            });
            reached(&waited);
            assert!(
                result.try_recv().is_err(),
                "zero tickets must not hide evictor-owned pool disposal"
            );
            let other = path_in(root.path(), "other", "progress.db3");
            drop(
                repository
                    .initialization_connection(&test_target(&other), None)
                    .unwrap(),
            );
            resume.send(()).unwrap();
            result.recv_timeout(SIGNAL_TIMEOUT).unwrap().unwrap();
        });
    }

    fn boundary_case(boundary: &str) {
        let root = tempfile::tempdir().unwrap();
        let path = path_in(root.path(), "old", "old.db3");
        let successor = path_in(root.path(), "old", "successor.db3");
        let repository = DatabaseRepository::default();
        let (key, _, held) = held_handle(&repository, &path);
        if boundary == "cached" {
            drop(repository.entry(&test_target(&successor), None).unwrap());
        }
        force_lru(&repository, &key, root.path(), "churn");
        let (waiting, waited) = signal();
        let _hooks = configure_test_hooks(&successor, |hooks| {
            hooks.predecessor_wait = Some(Box::new(move || {
                waiting.send(()).unwrap();
            }))
        });
        std::thread::scope(|scope| {
            let (done, result) = mpsc::channel();
            let repository = &repository;
            let successor = &successor;
            scope.spawn(move || {
                let target = test_target(successor);
                let result = match boundary {
                    "revision" => repository
                        .read_revision(&target, &CancellationToken::new())
                        .map(|_| ()),
                    "delete" => repository.delete_exclusive_cancellable(
                        &target,
                        &CancellationToken::new(),
                        || Ok(()),
                    ),
                    _ => repository
                        .initialization_connection(&target, None)
                        .map(|_| ()),
                };
                done.send(result).unwrap();
            });
            reached(&waited);
            assert!(
                result.try_recv().is_err(),
                "same-parent boundary crossed a live predecessor"
            );
            drop(held);
            result.recv_timeout(SIGNAL_TIMEOUT).unwrap().unwrap();
        });
    }

    #[test]
    fn same_parent_cached_acquisition_waits_for_lru_predecessor() {
        boundary_case("cached");
    }

    #[test]
    fn ordinary_pool_establishment_outlives_short_retire_wait_without_predecessors() {
        enum AcquisitionEvent {
            BeyondRetireDeadline,
            Completed(Result<(), Error>),
        }
        let root = tempfile::tempdir().unwrap();
        let path = path_in(root.path(), "ordinary", "database.db3");
        let repository = DatabaseRepository::with_retire_wait(SHORT_WAIT);
        let (entered, entry_signal) = signal();
        let (resume, resumed) = signal();
        let (event, events) = mpsc::channel();
        let beyond_deadline = event.clone();
        let _hooks = configure_test_hooks(&path, |hooks| {
            hooks.worker_before_establish = Some(pause(entered, resumed));
            hooks.pool_beyond_retire_deadline = Some(Box::new(move || {
                beyond_deadline
                    .send(AcquisitionEvent::BeyondRetireDeadline)
                    .unwrap();
            }));
        });
        std::thread::scope(|scope| {
            let repository = &repository;
            let path = &path;
            let started = Instant::now();
            scope.spawn(move || {
                event
                    .send(AcquisitionEvent::Completed(
                        repository
                            .initialization_connection(&test_target(path), None)
                            .map(|_| ()),
                    ))
                    .unwrap();
            });
            let first_event = entry_signal
                .recv_timeout(SIGNAL_TIMEOUT)
                .and_then(|()| events.recv_timeout(SIGNAL_TIMEOUT));
            let observed_after = started.elapsed();
            // Release before asserting so every negative proof cleans up the held worker.
            resume.send(()).unwrap();
            assert!(repository.state.lock().unwrap().retired.is_empty());
            match first_event.expect("ordinary acquisition did not reach a budget observation") {
                AcquisitionEvent::BeyondRetireDeadline => {}
                AcquisitionEvent::Completed(outcome) => {
                    panic!("ordinary pool acquisition expired at the predecessor deadline: {outcome:?}");
                }
            }
            assert!(observed_after >= SHORT_WAIT);
            match events.recv_timeout(SIGNAL_TIMEOUT).unwrap() {
                AcquisitionEvent::Completed(outcome) => outcome.unwrap(),
                AcquisitionEvent::BeyondRetireDeadline => panic!("duplicate budget observation"),
            }
            eprintln!(
                "ordinary acquisition completed in {:?} after observing its {:?} retire wait, with {:?} signal bound per phase",
                started.elapsed(),
                SHORT_WAIT,
                SIGNAL_TIMEOUT
            );
        });
    }

    #[test]
    fn default_pool_first_establishment_outlives_two_seconds() {
        const BLOCKED_ESTABLISHMENT_WAIT: Duration = Duration::from_millis(2500);

        let root = tempfile::tempdir().unwrap();
        let path = path_in(root.path(), "default-budget", "database.db3");
        let repository = DatabaseRepository::default();
        let (entered, entry_signal) = signal();
        let (resume, resumed) = signal();
        let (completed, completion) = mpsc::channel();
        let _hooks = configure_test_hooks(&path, |hooks| {
            hooks.worker_before_establish = Some(pause(entered, resumed));
        });
        std::thread::scope(|scope| {
            let repository = &repository;
            let path = &path;
            scope.spawn(move || {
                completed
                    .send(
                        repository
                            .initialization_connection(&test_target(path), None)
                            .map(|_| ()),
                    )
                    .unwrap();
            });
            reached(&entry_signal);
            let blocked_since = Instant::now();
            let pending = completion.recv_timeout(BLOCKED_ESTABLISHMENT_WAIT);
            // Release before asserting so the old-budget negative proof cleans up its worker.
            resume.send(()).unwrap();
            assert!(
                matches!(pending, Err(mpsc::RecvTimeoutError::Timeout)),
                "default first acquisition ended while establishment was blocked: {pending:?}"
            );
            let blocked_for = blocked_since.elapsed();
            assert!(blocked_for >= BLOCKED_ESTABLISHMENT_WAIT);
            completion.recv_timeout(SIGNAL_TIMEOUT).unwrap().unwrap();
            eprintln!(
                "default first acquisition succeeded after establishment was blocked for {blocked_for:?} with {:?} pool budget",
                repository.pool_connection_timeout
            );
        });
    }

    #[test]
    fn transient_revision_waits_for_lru_predecessor() {
        boundary_case("revision");
    }

    #[test]
    fn unlink_callback_waits_for_lru_predecessor() {
        boundary_case("delete");
    }

    fn predecessor_worker_case(admitted: bool, alias: bool) {
        #[derive(Debug, PartialEq, Eq)]
        enum PredecessorEvent {
            WorkerPredecessorWait,
            CallerDrained,
        }

        let root = tempfile::tempdir().unwrap();
        let path = path_in(root.path(), "old", "worker.db3");
        let repository = DatabaseRepository::with_retire_wait(SIGNAL_TIMEOUT);
        let target = test_target(&path);
        let (key, entry, _) = repository.entry(&target, None).unwrap();
        let gate = Arc::clone(&entry.connections);
        let pool = entry.pool.read().as_ref().unwrap().clone();
        drop(entry);
        let successor = if alias {
            let alias = path.with_file_name("alias.db3");
            std::fs::hard_link(&path, &alias).unwrap();
            alias
        } else {
            path.clone()
        };
        let (entered, entry_signal) = signal();
        let (resume, resumed) = signal();
        let (waiting, waited) = signal();
        let (event, events) = mpsc::channel();
        let worker_wait = event.clone();
        let _hooks = configure_test_hooks(path.parent().unwrap(), |hooks| {
            if admitted {
                hooks.worker_after_admission = Some(pause(entered, resumed));
            } else {
                hooks.worker_before_admission = Some(pause(entered, resumed));
            }
            hooks.predecessor_wait = Some(Box::new(move || {
                waiting.send(()).unwrap();
            }));
            hooks.worker_predecessor_wait = Some(Box::new(move || {
                worker_wait
                    .send(PredecessorEvent::WorkerPredecessorWait)
                    .unwrap();
            }));
            hooks.predecessor_drained = Some(Box::new(move || {
                event.send(PredecessorEvent::CallerDrained).unwrap();
            }));
        });
        assert!(pool.get_timeout(Duration::ZERO).is_err());
        reached(&entry_signal);
        drop(pool);
        assert_eq!(gate.snapshot().outstanding, usize::from(admitted));
        force_lru(&repository, &key, root.path(), "churn");
        let retirement = assert_retained(&repository, &key);
        let (done, result) = mpsc::channel();
        std::thread::scope(|scope| {
            let repository = &repository;
            let successor = &successor;
            scope.spawn(move || {
                done.send(
                    repository
                        .initialization_connection(&test_target(successor), None)
                        .map(|_| ()),
                )
                .unwrap();
            });
            reached(&waited);
            let drain = if admitted {
                &retirement.connections
            } else {
                &retirement.owners
            };
            drain.wait_until_waiting(Instant::now() + SIGNAL_TIMEOUT);
            assert!(
                result.try_recv().is_err(),
                "worker ownership must fence the successor even before ticket admission"
            );
            resume.send(()).unwrap();
            assert_eq!(
                events.recv_timeout(SIGNAL_TIMEOUT).unwrap(),
                PredecessorEvent::CallerDrained,
                "retired worker entered WorkerPredecessorWait before caller drainage"
            );
            assert!(
                retirement.complete(),
                "caller drainage must complete the old retirement"
            );
            result
                .recv_timeout(SIGNAL_TIMEOUT)
                .expect("successor acquisition did not complete")
                .expect(
                    "alias reopen must wait and succeed, never return alias admission conflict",
                );
        });
        assert_eq!(gate.snapshot().outstanding, 0);
    }

    #[test]
    fn admitted_predecessor_worker_refuses_without_self_wait() {
        predecessor_worker_case(true, false);
    }

    fn same_parent_retired_workers_case(already_waiting: bool) {
        let root = tempfile::tempdir().unwrap();
        let b = path_in(root.path(), "old", "b.db3");
        let a = b.with_file_name("a.db3");
        let repository = DatabaseRepository::with_retire_wait(SIGNAL_TIMEOUT);
        let (b_key, b_entry, _) = repository.entry(&test_target(&b), None).unwrap();
        let b_gate = Arc::clone(&b_entry.connections);
        let b_pool = b_entry.pool.read().as_ref().unwrap().clone();
        drop(b_entry);
        let (a_key, a_entry, _) = repository.entry(&test_target(&a), None).unwrap();
        let a_gate = Arc::clone(&a_entry.connections);
        let a_pool = a_entry.pool.read().as_ref().unwrap().clone();
        drop(a_entry);
        let (a_entered, a_admitted) = signal();
        let (a_resume, a_resumed) = signal();
        let (b_entered, b_admitted) = signal();
        let (b_resume, b_resumed) = signal();
        let (waiting, waited) = signal();
        let (a_published, a_retired) = mpsc::channel();
        let state = Arc::clone(&repository.state);
        let published_key = a_key.clone();
        let _hooks = configure_test_hooks(b.parent().unwrap(), |hooks| {
            hooks.by_path.insert(
                (TestHook::WorkerAfterAdmission, normalize_test_hook_path(&a)),
                pause(a_entered, a_resumed),
            );
            hooks.by_path.insert(
                (TestHook::WorkerAfterAdmission, normalize_test_hook_path(&b)),
                pause(b_entered, b_resumed),
            );
            hooks.by_path.insert(
                (
                    TestHook::WorkerPredecessorWait,
                    normalize_test_hook_path(&a),
                ),
                Box::new(move || waiting.send(()).unwrap()),
            );
            hooks.by_path.insert(
                (TestHook::RetirementPublished, normalize_test_hook_path(&a)),
                Box::new(move || {
                    let retirement = state
                        .lock()
                        .unwrap()
                        .retired
                        .iter()
                        .find(|retirement| retirement.key == published_key)
                        .unwrap()
                        .clone();
                    a_published.send(retirement).unwrap();
                }),
            );
        });
        assert!(a_pool.get_timeout(Duration::ZERO).is_err());
        assert!(b_pool.get_timeout(Duration::ZERO).is_err());
        reached(&a_admitted);
        reached(&b_admitted);
        assert_eq!(a_gate.snapshot().outstanding, 1);
        assert_eq!(b_gate.snapshot().outstanding, 1);
        drop(a_pool);
        drop(b_pool);
        force_lru(&repository, &b_key, root.path(), "churn-b");
        let b_retirement = assert_retained(&repository, &b_key);
        if already_waiting {
            a_resume.send(()).unwrap();
            reached(&waited);
            b_gate.wait_until_waiting(Instant::now() + SIGNAL_TIMEOUT);
        }
        force_lru(&repository, &a_key, root.path(), "churn-a");
        let retirements = [
            a_retired.recv_timeout(SIGNAL_TIMEOUT).unwrap(),
            b_retirement,
        ];
        let started = Instant::now();
        if !already_waiting {
            a_resume.send(()).unwrap();
        } else {
            retirements
                .iter()
                .find(|retirement| retirement.key == a_key)
                .unwrap()
                .wait(started + COMPLETION_BOUND, None)
                .expect("own retirement failed to interrupt an in-progress predecessor wait");
        }
        b_resume.send(()).unwrap();
        for retirement in &retirements {
            retirement
                .wait(started + COMPLETION_BOUND, None)
                .expect("retired same-parent workers waited on each other's ownership");
            assert!(retirement.complete());
        }
        assert!(started.elapsed() < COMPLETION_BOUND);
        assert_eq!(a_gate.snapshot().outstanding, 0);
        assert_eq!(b_gate.snapshot().outstanding, 0);
        let next = a.with_file_name("after.db3");
        drop(
            repository
                .initialization_connection(&test_target(&next), None)
                .unwrap(),
        );
    }

    #[test]
    fn same_parent_workers_refuse_when_both_pools_retire_after_admission() {
        same_parent_retired_workers_case(false);
    }

    #[test]
    fn same_parent_worker_wait_is_interrupted_when_its_own_pool_retires() {
        same_parent_retired_workers_case(true);
    }

    #[test]
    fn scan_establishment_waits_for_retirement_published_after_identity_check() {
        let root = tempfile::tempdir().unwrap();
        let scan = path_in(root.path(), "old", "scan.db3");
        let repository = DatabaseRepository::default();
        let (key, _, mut held) = held_handle(&repository, &scan);
        let target = scan_target(&scan, &key);
        // Rollback mode keeps the identity stable when the predecessor's final handle closes.
        held.batch_execute(
            "PRAGMA journal_mode=DELETE;
             CREATE TABLE Info (Name TEXT PRIMARY KEY, Value TEXT);
             INSERT INTO Info VALUES ('DataRevision', '0');",
        )
        .unwrap();
        let identity = repository.database_identity(&target).unwrap();
        let (checked, check_signal) = signal();
        let (resume, resumed) = signal();
        let (waiting, waited) = signal();
        let (establishing, established) = signal();
        let _hooks = configure_test_hooks(&scan, |hooks| {
            hooks.scan_before_admission = Some(pause(checked, resumed));
            hooks.predecessor_wait = Some(Box::new(move || waiting.send(()).unwrap()));
            hooks.scan_after_establish = Some(Box::new(move || establishing.send(()).unwrap()));
        });
        std::thread::scope(|scope| {
            let repository = &repository;
            let target = &target;
            let identity = &identity;
            let (done, result) = mpsc::channel();
            scope.spawn(move || {
                done.send(super::super::content_validation::scan_worker(
                    repository,
                    target,
                    identity,
                    &CancellationToken::new(),
                ))
                .unwrap();
            });
            reached(&check_signal);
            force_lru(repository, &key, root.path(), "churn");
            assert_retained(repository, &key);
            resume.send(()).unwrap();
            reached(&waited);
            assert!(
                established.try_recv().is_err(),
                "scan established SQLite beside a live retired predecessor"
            );
            assert!(result.try_recv().is_err());
            drop(held);
            reached(&established);
            let outcome = result.recv_timeout(SIGNAL_TIMEOUT).unwrap();
            outcome.result.unwrap();
            assert!(outcome.event.is_none());
        });
    }

    #[test]
    fn scan_admission_blocks_retirement_only_through_establishment() {
        let root = tempfile::tempdir().unwrap();
        let scan = path_in(root.path(), "scan", "scan.db3");
        let repository = DatabaseRepository::default();
        let (key, gate, mut held) = held_handle(&repository, &scan);
        held.batch_execute(
            "PRAGMA journal_mode=DELETE;
             CREATE TABLE Info (Name TEXT PRIMARY KEY, Value TEXT);
             INSERT INTO Info VALUES ('DataRevision', '0');",
        )
        .unwrap();
        drop(held);
        let target = scan_target(&scan, &key);
        let identity = repository.database_identity(&target).unwrap();
        for index in 1..MAX_OPEN_DATABASES {
            let path = path_in(root.path(), "fill", &format!("{index}.db3"));
            drop(repository.entry(&test_target(&path), None).unwrap());
        }
        let (established, establish_signal) = signal();
        let (establish_resume, establish_resumed) = signal();
        let (validating, validation_signal) = signal();
        let (validation_resume, validation_resumed) = signal();
        let (boundary, boundaries) = mpsc::channel();
        let first_reserved = boundary.clone();
        let second_reserved = boundary.clone();
        let (retirement_resume, retirement_resumed) = signal();
        let _hooks = configure_test_hooks(&scan, |hooks| {
            hooks.scan_after_establish = Some(pause(established, establish_resumed));
            hooks.scan_validation_checkpoint = Some(pause(validating, validation_resumed));
            hooks.by_path.insert(
                (
                    TestHook::RetirementReservedWait,
                    normalize_test_hook_path(&scan),
                ),
                Box::new(move || {
                    first_reserved.send(false).unwrap();
                    reached(&retirement_resumed);
                }),
            );
            hooks.retirement_reserved_wait =
                Some(Box::new(move || second_reserved.send(false).unwrap()));
            hooks.retirement_published = Some(Box::new(move || boundary.send(true).unwrap()));
        });
        let (scan_done, scan_result) = mpsc::channel();
        std::thread::scope(|scope| {
            let repository = &repository;
            let target = &target;
            let identity = &identity;
            scope.spawn(move || {
                scan_done
                    .send(super::super::content_validation::scan_worker(
                        repository,
                        target,
                        identity,
                        &CancellationToken::new(),
                    ))
                    .unwrap();
            });
            reached(&establish_signal);
            let first_target = test_target(&path_in(root.path(), "churn", "first.db3"));
            let first_cancellation = CancellationToken::new();
            let cancellation = first_cancellation.clone();
            let (first_done, first_result) = mpsc::channel();
            scope.spawn(move || {
                first_done
                    .send(
                        repository
                            .entry(&first_target, Some(&cancellation))
                            .map(|_| ()),
                    )
                    .unwrap();
            });
            let published_during_establishment = boundaries.recv_timeout(SIGNAL_TIMEOUT).unwrap();
            if !published_during_establishment {
                assert!(!gate.snapshot().closed);
                let state = repository.state.lock().unwrap();
                assert!(state.entries.contains_key(&key));
                assert!(state.retired.is_empty());
                assert!(first_result.try_recv().is_err());
            }
            // Cancel the blocked attempt so validation gets a fresh publication attempt.
            first_cancellation.cancel();
            let _ = retirement_resume.send(());
            let first_outcome = first_result.recv_timeout(SIGNAL_TIMEOUT).unwrap();
            if published_during_establishment {
                establish_resume.send(()).unwrap();
                validation_resume.send(()).unwrap();
                panic!("matching retirement published while scan establishment admission was held");
            }
            assert!(matches!(first_outcome, Err(Error::Cancellation)));
            establish_resume.send(()).unwrap();
            reached(&validation_signal);

            let second_target = test_target(&path_in(root.path(), "churn", "second.db3"));
            let second_cancellation = CancellationToken::new();
            let cancellation = second_cancellation.clone();
            let (second_done, second_result) = mpsc::channel();
            scope.spawn(move || {
                second_done
                    .send(
                        repository
                            .entry(&second_target, Some(&cancellation))
                            .map(|_| ()),
                    )
                    .unwrap();
            });
            let published_during_validation = boundaries.recv_timeout(SIGNAL_TIMEOUT).unwrap();
            if published_during_validation {
                assert!(gate.snapshot().closed);
                assert!(!repository.state.lock().unwrap().entries.contains_key(&key));
                assert!(scan_result.try_recv().is_err());
            } else {
                second_cancellation.cancel();
            }
            let second_outcome = second_result.recv_timeout(SIGNAL_TIMEOUT).unwrap();
            validation_resume.send(()).unwrap();
            let outcome = scan_result.recv_timeout(SIGNAL_TIMEOUT).unwrap();
            assert!(
                published_during_validation,
                "matching retirement still waited on scan admission during content validation"
            );
            second_outcome.unwrap();
            outcome.result.unwrap();
            assert!(outcome.event.is_none());
        });
    }

    #[test]
    fn admitted_successor_defers_matching_lru_retirement_publication() {
        let root = tempfile::tempdir().unwrap();
        let old = path_in(root.path(), "old", "old.db3");
        let next = old.with_file_name("next.db3");
        let repository = DatabaseRepository::default();
        let (key, entry, _) = repository.entry(&test_target(&old), None).unwrap();
        let gate = Arc::clone(&entry.connections);
        drop(entry);
        let (_, entry, _) = repository.entry(&test_target(&next), None).unwrap();
        let pool = entry.pool.read().as_ref().unwrap().clone();
        drop(entry);
        for index in 2..MAX_OPEN_DATABASES {
            let path = path_in(root.path(), "fill", &format!("{index}.db3"));
            drop(repository.entry(&test_target(&path), None).unwrap());
        }
        let (entered, entry_signal) = signal();
        let (resume, resumed) = signal();
        let (boundary, boundary_signal) = mpsc::channel();
        let reserved = boundary.clone();
        let (publish_resume, publish_resumed) = signal();
        let _hooks = configure_test_hooks(old.parent().unwrap(), |hooks| {
            hooks.worker_before_establish = Some(pause(entered, resumed));
            hooks.retirement_reserved_wait = Some(Box::new(move || reserved.send(false).unwrap()));
            hooks.retirement_published = Some(Box::new(move || {
                boundary.send(true).unwrap();
                reached(&publish_resumed);
            }));
        });
        assert!(pool.get_timeout(Duration::ZERO).is_err());
        reached(&entry_signal);
        std::thread::scope(|scope| {
            let (done, result) = mpsc::channel();
            let repository = &repository;
            let root = root.path();
            scope.spawn(move || {
                let path = path_in(root, "new", "trigger.db3");
                done.send(repository.entry(&test_target(&path), None).map(|_| ()))
                    .unwrap();
            });
            assert!(
                !boundary_signal.recv_timeout(SIGNAL_TIMEOUT).unwrap(),
                "matching retirement was published while successor admission was held"
            );
            assert!(!gate.snapshot().closed);
            assert!(repository.state.lock().unwrap().retired.is_empty());
            assert!(result.try_recv().is_err());
            resume.send(()).unwrap();
            assert!(boundary_signal.recv_timeout(SIGNAL_TIMEOUT).unwrap());
            assert!(gate.snapshot().closed);
            assert_retained(repository, &key);
            publish_resume.send(()).unwrap();
            result.recv_timeout(SIGNAL_TIMEOUT).unwrap().unwrap();
        });
        drop(pool.get_timeout(SIGNAL_TIMEOUT).unwrap());
    }

    #[test]
    fn upgraded_unadmitted_worker_keeps_retirement_incomplete() {
        predecessor_worker_case(false, false);
    }

    #[cfg(unix)]
    #[test]
    fn upgraded_unadmitted_worker_alias_reopen_waits_and_succeeds() {
        predecessor_worker_case(false, true);
    }

    #[cfg(unix)]
    #[test]
    fn different_parent_hard_link_alias_waits_by_object_identity() {
        let root = tempfile::tempdir().unwrap();
        let path = path_in(root.path(), "old", "database.db3");
        let alias = path_in(root.path(), "alias", "database.db3");
        let repository = DatabaseRepository::default();
        let (key, _, held) = held_handle(&repository, &path);
        std::fs::hard_link(&path, &alias).unwrap();
        let alias_target = test_target(&alias);
        assert_eq!(key.identity, alias_target.identity());
        assert_ne!(
            key.parent_identity,
            entry_key(&alias_target).unwrap().parent_identity
        );
        force_lru(&repository, &key, root.path(), "churn");
        let (waiting, waited) = signal();
        let _hooks = configure_test_hooks(&alias, |hooks| {
            hooks.predecessor_wait = Some(Box::new(move || {
                waiting.send(()).unwrap();
            }))
        });
        std::thread::scope(|scope| {
            let repository = &repository;
            let alias_target = &alias_target;
            let (done, result) = mpsc::channel();
            scope.spawn(move || {
                done.send(
                    repository
                        .initialization_connection(alias_target, None)
                        .map(|_| ()),
                )
                .unwrap();
            });
            reached(&waited);
            assert!(
                result.try_recv().is_err(),
                "object matching must fence an alias in another retained parent"
            );
            drop(held);
            result.recv_timeout(SIGNAL_TIMEOUT).unwrap().unwrap();
        });
    }

    #[test]
    fn delayed_cached_successor_worker_establishment_waits_at_retirement_boundary() {
        let root = tempfile::tempdir().unwrap();
        let old = path_in(root.path(), "old", "old.db3");
        let next = old.with_file_name("next.db3");
        let repository = DatabaseRepository::default();
        let (key, _, held) = held_handle(&repository, &old);
        let (_, entry, _) = repository.entry(&test_target(&next), None).unwrap();
        let pool = entry.pool.read().as_ref().unwrap().clone();
        drop(entry);
        let (entered, entry_signal) = signal();
        let (resume, resumed) = signal();
        let (waiting, waited) = signal();
        let (establishing, established) = signal();
        let _hooks = configure_test_hooks(&next, |hooks| {
            hooks.worker_before_admission = Some(pause(entered, resumed));
            hooks.worker_predecessor_wait = Some(Box::new(move || {
                waiting.send(()).unwrap();
            }));
            hooks.worker_before_establish = Some(Box::new(move || {
                establishing.send(()).unwrap();
            }));
        });
        assert!(pool.get_timeout(Duration::ZERO).is_err());
        reached(&entry_signal);
        force_lru(&repository, &key, root.path(), "churn");
        resume.send(()).unwrap();
        reached(&waited);
        assert!(
            established.try_recv().is_err(),
            "cached successor worker established across a live predecessor"
        );
        drop(held);
        reached(&established);
        drop(pool.get_timeout(SIGNAL_TIMEOUT).unwrap());
    }

    fn failed_drain_case(cancel: bool) {
        let root = tempfile::tempdir().unwrap();
        let path = path_in(root.path(), "old", "drain.db3");
        let repository = DatabaseRepository::with_retire_wait(SHORT_WAIT);
        let (key, gate, held) = held_handle(&repository, &path);
        let (published, publication) = signal();
        let _hooks = configure_test_hooks(&path, |hooks| {
            hooks.retirement_published = Some(Box::new(move || {
                published.send(()).unwrap();
            }))
        });
        let cancellation = CancellationToken::new();
        let ran = std::sync::atomic::AtomicBool::new(false);
        std::thread::scope(|scope| {
            let (done, result) = mpsc::channel();
            let repository = &repository;
            let path = &path;
            let cancellation = &cancellation;
            let ran = &ran;
            scope.spawn(move || {
                done.send(repository.delete_exclusive_cancellable(
                    &test_target(path),
                    cancellation,
                    || {
                        ran.store(true, std::sync::atomic::Ordering::SeqCst);
                        Ok(())
                    },
                ))
                .unwrap();
            });
            reached(&publication);
            assert!(
                gate.snapshot().closed,
                "cancellation must select the connection-drain phase"
            );
            if cancel {
                cancellation.cancel();
            }
            let error = result.recv_timeout(COMPLETION_BOUND).unwrap().unwrap_err();
            if cancel {
                assert!(matches!(error, Error::Cancellation));
            } else {
                assert!(matches!(error, Error::Conflict(_)));
            }
        });
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
        assert_retained(&repository, &key);
        assert!(repository.state.lock().unwrap().tombstones.is_empty());
        assert!(matches!(
            repository.initialization_connection(&test_target(&path), None),
            Err(Error::Conflict(_))
        ));
        assert!(matches!(
            repository.delete_exclusive_cancellable(
                &test_target(&path),
                &CancellationToken::new(),
                || {
                    ran.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                }
            ),
            Err(Error::Conflict(_))
        ));
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
        drop(held);
        drop(
            repository
                .initialization_connection(&test_target(&path), None)
                .unwrap(),
        );
        repository
            .delete_exclusive_cancellable(&test_target(&path), &CancellationToken::new(), || Ok(()))
            .unwrap();
        assert!(repository
            .state
            .lock()
            .unwrap()
            .retired
            .iter()
            .all(Retirement::complete));
    }

    #[test]
    fn cancelled_connection_drain_preserves_barrier_until_retry() {
        failed_drain_case(true);
    }

    #[test]
    fn timed_out_connection_drain_preserves_barrier_until_retry() {
        failed_drain_case(false);
    }

    fn cached_worker_failure_case(cancel: bool) {
        let root = tempfile::tempdir().unwrap();
        let old = path_in(root.path(), "old", "old.db3");
        let next = old.with_file_name("cached.db3");
        // The caller's deadline starts at call entry, before the paused admission hook.
        // Give cancellation a budget only it ends, keeping the timeout case's asserted 300 ms.
        let repository =
            DatabaseRepository::with_retire_wait(if cancel { SIGNAL_TIMEOUT } else { SHORT_WAIT });
        let (key, _, held) = held_handle(&repository, &old);
        // A valid WAL database avoids racing initial journal-mode conversion between
        // the failed worker's r2d2 retry and the independently admitted healthy caller.
        let mut seed = SqliteConnection::establish(next.to_str().unwrap()).unwrap();
        seed.batch_execute("PRAGMA journal_mode=WAL; CREATE TABLE Ready (value INTEGER);")
            .unwrap();
        drop(seed);
        drop(repository.entry(&test_target(&next), None).unwrap());
        let (entered, entry_signal) = signal();
        let (resume, resumed) = signal();
        let (waiting, waited) = signal();
        let (caller_waiting, caller_waited) = signal();
        let _hooks = configure_test_hooks(&next, |hooks| {
            hooks.worker_before_admission = Some(pause(entered, resumed));
            hooks.worker_predecessor_wait = Some(Box::new(move || {
                waiting.send(()).unwrap();
            }));
            hooks.predecessor_wait = Some(Box::new(move || {
                caller_waiting.send(()).unwrap();
            }));
        });
        let cancellation = CancellationToken::new();
        std::thread::scope(|scope| {
            let (done, result) = mpsc::channel();
            let repository = &repository;
            let next = &next;
            let cancellation = &cancellation;
            scope.spawn(move || {
                done.send(
                    repository
                        .initialization_connection(&test_target(next), Some(cancellation))
                        .map(|_| ()),
                )
                .unwrap();
            });
            reached(&entry_signal);
            force_lru(repository, &key, root.path(), "churn");
            // The worker's deadline starts in connect after the admission hook, excluding setup before resume.
            let resumed_at = Instant::now();
            resume.send(()).unwrap();
            reached(&waited);
            let cancelled_at = Instant::now();
            if cancel {
                cancellation.cancel();
            }
            let error = result
                .recv_timeout(COMPLETION_BOUND)
                .expect("cached acquisition consumed an additional pool timeout")
                .unwrap_err();
            eprintln!("cached worker {} completed in {:?} from worker resume, {:?} after synchronized signal", if cancel { "cancellation" } else { "timeout" }, resumed_at.elapsed(), cancelled_at.elapsed());
            assert!(
                resumed_at.elapsed() < COMPLETION_BOUND,
                "cached acquisition refreshed its predecessor budget"
            );
            if cancel {
                assert!(cancelled_at.elapsed() < COMPLETION_BOUND);
                assert_eq!(error.category(), crate::error::ErrorCategory::Cancellation);
                assert!(
                    matches!(error, Error::Cancellation),
                    "worker transport lost typed Cancellation"
                );
            } else {
                assert_eq!(error.category(), crate::error::ErrorCategory::Conflict);
                assert!(
                    matches!(error, Error::Conflict(_)),
                    "worker transport lost typed Conflict"
                );
            }
            assert_retained(repository, &key);
            // This healthy operation has its own recovery budget, including r2d2 backoff.
            // The failed caller's deadline and cancellation cannot poison it.
            while caller_waited.try_recv().is_ok() {}
            let (healthy, healthy_result) = mpsc::channel();
            scope.spawn(move || {
                healthy
                    .send(
                        repository
                            .acquire_probed_until(
                                &test_target(next),
                                Instant::now() + SIGNAL_TIMEOUT,
                                None,
                            )
                            .map(|_| ()),
                    )
                    .unwrap();
            });
            reached(&caller_waited);
            drop(held);
            let healthy_outcome = healthy_result.recv_timeout(SIGNAL_TIMEOUT).unwrap();
            if healthy_outcome.is_err() {
                let state = repository.state.lock().unwrap();
                let entry = state
                    .entries
                    .get(&entry_key(&test_target(next)).unwrap())
                    .unwrap();
                eprintln!(
                    "healthy outcome {healthy_outcome:?}, pool {:?}, connections {:?}, retired {}, factory failure {:?}",
                    entry.pool.read().as_ref().unwrap().state(),
                    entry.connections.snapshot(),
                    state.retired.len(),
                    entry.pool_wake.failure.lock().latest.as_ref().map(|failure| failure.error.diagnostic())
                );
            }
            healthy_outcome.unwrap();
        });
        drop(
            repository
                .initialization_connection(&test_target(&next), None)
                .unwrap(),
        );
    }

    #[test]
    fn cached_worker_timeout_is_typed_bounded_and_retry_is_independent() {
        cached_worker_failure_case(false);
    }

    #[test]
    fn cached_worker_cancellation_is_typed_prompt_and_retry_is_independent() {
        cached_worker_failure_case(true);
    }

    #[test]
    fn retirement_churn_is_bounded_and_completed_names_are_pruned_on_other_access() {
        let body = || {
            let root = tempfile::tempdir().unwrap();
            let repository = DatabaseRepository::default();
            for index in 0..MAX_OPEN_DATABASES * 4 {
                let path = path_in(root.path(), &format!("parent-{index}"), "churn.db3");
                drop(
                    repository
                        .initialization_connection(&test_target(&path), None)
                        .unwrap(),
                );
                let state = repository.state.lock().unwrap();
                assert!(state.retired.len() + state.retirement_reservations <= MAX_OPEN_DATABASES);
                assert!(state.entries.len() <= MAX_OPEN_DATABASES);
            }
            let path = path_in(root.path(), "unrelated", "prune.db3");
            drop(
                repository
                    .initialization_connection(&test_target(&path), None)
                    .unwrap(),
            );
            assert!(repository.state.lock().unwrap().retired.is_empty());
        };
        #[cfg(unix)]
        crate::db::test_support::run_isolated("db::repository::retirement_tests::retirement_churn_is_bounded_and_completed_names_are_pruned_on_other_access", body);
        #[cfg(not(unix))]
        body();
    }

    #[test]
    fn active_lease_lru_exception_is_preserved() {
        let root = tempfile::tempdir().unwrap();
        let repository = DatabaseRepository::default();
        let mut leases = Vec::new();
        for index in 0..=MAX_OPEN_DATABASES {
            let path = path_in(root.path(), "active", &format!("{index}.db3"));
            leases.push(
                repository
                    .initialization_connection(&test_target(&path), None)
                    .unwrap(),
            );
        }
        assert_eq!(
            repository.state.lock().unwrap().entries.len(),
            MAX_OPEN_DATABASES + 1
        );
        assert!(repository.state.lock().unwrap().retired.is_empty());
        drop(leases);
        let path = path_in(root.path(), "active", "after.db3");
        drop(
            repository
                .initialization_connection(&test_target(&path), None)
                .unwrap(),
        );
        assert_eq!(
            repository.state.lock().unwrap().entries.len(),
            MAX_OPEN_DATABASES
        );
    }

    #[test]
    fn retirement_saturation_fails_closed_cancels_and_recovers_after_release() {
        let root = tempfile::tempdir().unwrap();
        let repository = DatabaseRepository::with_retire_wait(SHORT_WAIT);
        let mut held = Vec::new();
        for index in 0..MAX_OPEN_DATABASES {
            let path = path_in(root.path(), &format!("held-{index}"), "database.db3");
            held.push(held_handle(&repository, &path).2);
        }
        for index in 0..MAX_OPEN_DATABASES {
            let path = path_in(root.path(), "fill", &format!("{index}.db3"));
            let result = repository.entry(&test_target(&path), None);
            drop(result.unwrap());
        }
        assert_eq!(
            repository.state.lock().unwrap().retired.len(),
            MAX_OPEN_DATABASES
        );
        assert_eq!(repository.state.lock().unwrap().retirement_reservations, 0);
        let (pending_key, pending_entry) = {
            let state = repository.state.lock().unwrap();
            let (key, entry) = state.entries.iter().next().unwrap();
            (key.clone(), Arc::clone(entry))
        };
        assert!(matches!(
            repository.retire_replaced(&pending_key, &pending_entry, None),
            Err(Error::Conflict(_))
        ));
        assert!(
            pending_entry.is_idle(),
            "capacity failure before connection retirement must restore caller admission"
        );
        assert!(!pending_entry.connections.snapshot().closed);
        drop(pending_entry);
        let path = path_in(root.path(), "other", "blocked.db3");
        assert!(
            matches!(
                repository.entry(&test_target(&path), None),
                Err(Error::Conflict(_))
            ),
            "saturated retirement capacity must time out before publishing a cache entry"
        );
        let cancellation = CancellationToken::new();
        let (started, waiting) = signal();
        let _hooks = configure_test_hooks(Path::new("."), |hooks| {
            hooks.retirement_capacity_wait = Some(Box::new(move || {
                started.send(()).unwrap();
            }))
        });
        std::thread::scope(|scope| {
            let (done, result) = mpsc::channel();
            let repository = &repository;
            let path = &path;
            let cancellation = &cancellation;
            scope.spawn(move || {
                done.send(
                    repository
                        .entry(&test_target(path), Some(cancellation))
                        .map(|_| ()),
                )
                .unwrap();
            });
            reached(&waiting);
            cancellation.cancel();
            assert!(matches!(
                result.recv_timeout(COMPLETION_BOUND).unwrap(),
                Err(Error::Cancellation)
            ));
        });
        let state = repository.state.lock().unwrap();
        assert!(state.building.is_empty());
        assert_eq!(state.retirement_reservations, 0);
        assert!(!state
            .entries
            .contains_key(&entry_key(&test_target(&path)).unwrap()));
        drop(state);
        drop(held);
        drop(
            repository
                .acquire_probed_until(&test_target(&path), Instant::now() + SIGNAL_TIMEOUT, None)
                .unwrap(),
        );
        assert!(repository.state.lock().unwrap().retired.is_empty());
    }

    #[test]
    fn multiple_predecessors_share_one_absolute_acquisition_deadline() {
        let root = tempfile::tempdir().unwrap();
        let first = path_in(root.path(), "old", "first.db3");
        let second = first.with_file_name("second.db3");
        let next = first.with_file_name("cached.db3");
        let repository = DatabaseRepository::with_retire_wait(MULTI_PREDECESSOR_BUDGET);
        let (first_key, _, first_held) = held_handle(&repository, &first);
        let (second_key, _, second_held) = held_handle(&repository, &second);
        drop(repository.entry(&test_target(&next), None).unwrap());
        force_lru(&repository, &first_key, root.path(), "churn-a");
        force_lru(&repository, &second_key, root.path(), "churn-b");
        assert_retained(&repository, &first_key);
        assert_retained(&repository, &second_key);
        let (waiting, waited) = signal();
        let (drained, drain_signal) = signal();
        let acquisition_started = Arc::new(std::sync::OnceLock::<Instant>::new());
        let hook_started = Arc::clone(&acquisition_started);
        let _hooks = configure_test_hooks(&next, |hooks| {
            let mut first_held = Some(first_held);
            hooks.predecessor_wait = Some(Box::new(move || {
                waiting.send(()).unwrap();
                if let Some(first_held) = first_held.take() {
                    let release_at = *hook_started.get().expect("acquisition start was not set")
                        + FIRST_PREDECESSOR_RELEASE_DELAY;
                    let delay = release_at.saturating_duration_since(Instant::now());
                    if !delay.is_zero() {
                        std::thread::sleep(delay);
                    }
                    // Release before waiting, independently of the test thread's wakeup.
                    // The second predecessor stays held so refreshing its budget is visible.
                    drop(first_held);
                }
            }));
            hooks.predecessor_drained = Some(Box::new(move || {
                drained.send(()).unwrap();
            }));
        });
        std::thread::scope(|scope| {
            let (done, result) = mpsc::channel();
            let repository = &repository;
            let next = &next;
            let started = Instant::now();
            acquisition_started.set(started).unwrap();
            scope.spawn(move || {
                let outcome = repository
                    .initialization_connection(&test_target(next), None)
                    .map(|_| ());
                let elapsed = started.elapsed();
                done.send((outcome, elapsed)).unwrap();
            });
            waited
                .recv_timeout(SIGNAL_TIMEOUT)
                .expect("predecessor-wait boundary was not reached");
            drain_signal
                .recv_timeout(SIGNAL_TIMEOUT)
                .expect("first-predecessor drain boundary was not reached");
            let (outcome, elapsed) = result.recv_timeout(COMPLETION_BOUND).unwrap();
            let error = outcome.unwrap_err();
            assert!(matches!(error, Error::Conflict(_)));
            assert!(
                elapsed < MULTI_PREDECESSOR_COMPLETION_BOUND,
                "each predecessor received a fresh retirement budget: {:?}",
                elapsed
            );
            assert_retained(repository, &second_key);
            eprintln!(
                "multiple predecessor acquisition completed in {:?} with one {:?} budget",
                elapsed, MULTI_PREDECESSOR_BUDGET
            );
            drop(second_held);
        });
        drop(
            repository
                .initialization_connection(&test_target(&next), None)
                .unwrap(),
        );
    }

    #[cfg(unix)]
    fn replacement_case(boundary: &str, spelling_alias: bool) {
        let root = tempfile::tempdir().unwrap();
        let path = path_in(root.path(), "old", "GameCase.db3");
        let alias = path.with_file_name("gamecase.db3");
        std::fs::File::create(&path).unwrap();
        if spelling_alias {
            match std::fs::metadata(&alias) {
                Ok(_) => assert_eq!(
                    test_target(&path).identity(),
                    test_target(&alias).identity()
                ),
                Err(_) => {
                    eprintln!("SKIP spelling alias witness: filesystem does not accept GameCase.db3 as gamecase.db3");
                    return;
                }
            }
        }
        let repository = DatabaseRepository::default();
        let (key, gate, mut held) = held_handle(&repository, &path);
        held.batch_execute("PRAGMA journal_mode=DELETE; CREATE TABLE Predecessor (value INTEGER); INSERT INTO Predecessor VALUES (1);").unwrap();
        let wal = path.with_file_name("GameCase.db3-wal");
        let shm = path.with_file_name("GameCase.db3-shm");
        assert!(!wal.exists() && !shm.exists());
        let replacement = path.with_file_name("replacement.db3");
        let mut seed = SqliteConnection::establish(replacement.to_str().unwrap()).unwrap();
        seed.batch_execute(
            "CREATE TABLE Successor (value INTEGER); INSERT INTO Successor VALUES (42);",
        )
        .unwrap();
        drop(seed);
        std::fs::rename(&replacement, &path).unwrap();
        let successor = if spelling_alias { &alias } else { &path };
        let target = test_target(successor);
        assert_ne!(key.identity, target.identity());
        // This replacement pool exists before the predecessor becomes LRU-evicted.
        drop(repository.entry(&target, None).unwrap());
        force_lru(&repository, &key, root.path(), "churn");
        let (waiting, waited) = signal();
        let (establishing, established) = signal();
        let _hooks = configure_test_hooks(successor.parent().unwrap(), |hooks| {
            hooks.predecessor_wait = Some(Box::new(move || {
                waiting.send(()).unwrap();
            }));
            hooks.worker_before_establish = Some(Box::new(move || {
                establishing.send(()).unwrap();
            }));
        });
        std::thread::scope(|scope| {
            let (done, result) = mpsc::channel();
            let repository = &repository;
            let target = &target;
            let gate = &gate;
            let wal = &wal;
            let shm = &shm;
            scope.spawn(move || {
                let result = match boundary {
                    "revision" => repository
                        .read_revision(target, &CancellationToken::new())
                        .map(|_| ()),
                    "delete" => repository.delete_exclusive_cancellable(
                        target,
                        &CancellationToken::new(),
                        || {
                            assert_eq!(
                                gate.snapshot().outstanding,
                                0,
                                "unlink ran before predecessor SQLite close"
                            );
                            Ok(())
                        },
                    ),
                    _ => {
                        let mut connection =
                            repository.initialization_connection(target, None).unwrap();
                        assert_eq!(
                            gate.snapshot().outstanding,
                            0,
                            "successor WAL opened before predecessor SQLite close"
                        );
                        connection
                            .batch_execute(
                                "PRAGMA wal_autocheckpoint=0; INSERT INTO Successor VALUES (43);",
                            )
                            .unwrap();
                        assert!(
                            wal.exists() && shm.exists(),
                            "successor sidecars must remain intact"
                        );
                        assert_eq!(
                            sql_query("SELECT COUNT(*) AS count FROM Successor")
                                .get_result::<CountRow>(&mut *connection)
                                .unwrap()
                                .count,
                            2,
                            "successor remains queryable after final predecessor close"
                        );
                        Ok(())
                    }
                };
                done.send(result).unwrap();
            });
            reached(&waited);
            assert!(
                result.try_recv().is_err(),
                "replacement boundary crossed a live predecessor"
            );
            assert!(
                established.try_recv().is_err(),
                "replacement worker established SQLite before predecessor close"
            );
            drop(held);
            result.recv_timeout(SIGNAL_TIMEOUT).unwrap().unwrap();
        });
    }

    #[cfg(unix)]
    #[test]
    fn cached_same_path_replacement_waits_and_preserves_successor_wal() {
        replacement_case("cached", false);
    }

    #[cfg(unix)]
    #[test]
    fn predecessor_final_wal_close_precedes_successor_sidecars_and_queries() {
        let root = tempfile::tempdir().unwrap();
        let path = path_in(root.path(), "old", "wal.db3");
        let repository = DatabaseRepository::default();
        let (key, gate, mut held) = held_handle(&repository, &path);
        held.batch_execute("PRAGMA wal_autocheckpoint=0; CREATE TABLE Lifetime (value INTEGER); INSERT INTO Lifetime VALUES (1);").unwrap();
        let wal = path.with_file_name("wal.db3-wal");
        let shm = path.with_file_name("wal.db3-shm");
        assert!(wal.exists() && shm.exists());
        force_lru(&repository, &key, root.path(), "churn");
        let (waiting, waited) = signal();
        let (before_open, open_signal) = signal();
        let (resume, resumed) = signal();
        let _hooks = configure_test_hooks(&path, |hooks| {
            hooks.predecessor_wait = Some(Box::new(move || {
                waiting.send(()).unwrap();
            }));
            hooks.worker_before_establish = Some(pause(before_open, resumed));
        });
        std::thread::scope(|scope| {
            let repository = &repository;
            let path = &path;
            let wal = &wal;
            let shm = &shm;
            let gate = &gate;
            let (done, result) = mpsc::channel();
            scope.spawn(move || {
                let mut connection = repository
                    .initialization_connection(&test_target(path), None)
                    .unwrap();
                assert_eq!(gate.snapshot().outstanding, 0);
                connection
                    .batch_execute("PRAGMA wal_autocheckpoint=0; INSERT INTO Lifetime VALUES (2);")
                    .unwrap();
                assert!(
                    wal.exists() && shm.exists(),
                    "successor WAL and SHM must survive predecessor teardown"
                );
                assert_eq!(
                    sql_query("SELECT COUNT(*) AS count FROM Lifetime")
                        .get_result::<CountRow>(&mut *connection)
                        .unwrap()
                        .count,
                    2
                );
                done.send(()).unwrap();
            });
            reached(&waited);
            assert!(open_signal.try_recv().is_err());
            drop(held);
            reached(&open_signal);
            assert!(
                !wal.exists() && !shm.exists(),
                "predecessor's final close must remove its sidecars before the successor opens"
            );
            resume.send(()).unwrap();
            reached(&result);
        });
    }

    #[cfg(unix)]
    #[test]
    fn spelling_alias_replacement_cached_acquisition_waits() {
        replacement_case("cached", true);
    }

    #[cfg(unix)]
    #[test]
    fn spelling_alias_replacement_revision_waits() {
        replacement_case("revision", true);
    }

    #[cfg(unix)]
    #[test]
    fn spelling_alias_replacement_delete_waits() {
        replacement_case("delete", true);
    }
}

#[cfg(all(test, unix))]
mod vanished_holder_tests {
    use super::*;
    use diesel::connection::{AnsiTransactionManager, SimpleConnection, TransactionManager};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    };

    const WAIT: Duration = Duration::from_secs(10);

    fn sidecar(path: &Path, suffix: &str) -> PathBuf {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        PathBuf::from(name)
    }

    fn committed_fixture(repository: &DatabaseRepository, path: &Path) -> Result<EntryKey, Error> {
        let target = test_target(path);
        let mut connection = repository.initialization_connection(&target, None)?;
        migrations::prepare_database(&mut connection, "before rename", "fixture")?;
        connection.batch_execute(
            "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0;
            BEGIN IMMEDIATE;
            UPDATE Info SET Value='committed renamed row' WHERE Name='Title';
            INSERT OR REPLACE INTO Info(Name, Value) VALUES ('DataRevision', '23');
            COMMIT;",
        )?;
        drop(connection);
        assert!(std::fs::metadata(sidecar(path, "-wal"))?.len() > 0);
        entry_key(&target)
    }

    // An unfinished transaction makes r2d2 discard each checked-out connection. The BEGIN
    // writes nothing, and the vanished leaf prevents final-close checkpointing. No reaper tick.
    fn close_idle_connections(
        repository: &DatabaseRepository,
        key: &EntryKey,
    ) -> Result<(), Error> {
        let pool = repository
            .state
            .lock()
            .map_err(repository_state_poisoned)?
            .entries
            .get(key)
            .and_then(|entry| entry.pool.read().clone())
            .ok_or_else(|| Error::Conflict("fixture pool missing".into()))?;
        while let Some(mut connection) = pool.try_get() {
            AnsiTransactionManager::begin_transaction(&mut **connection)?;
            drop(connection);
        }
        assert_eq!(pool.state().connections, 0);
        Ok(())
    }

    fn assert_committed(repository: &DatabaseRepository, path: &Path) -> Result<(), Error> {
        let target = test_target(path);
        let mut connection = repository.connection(&target, None)?;
        let row: RevisionRow = sql_query("SELECT Value AS value FROM Info WHERE Name='Title'")
            .get_result(&mut *connection)?;
        assert_eq!(row.value.as_deref(), Some("committed renamed row"));
        assert_eq!(repository.database_identity(&target)?.data_revision, 23);
        Ok(())
    }

    fn assert_admission_refusal<T>(result: Result<T, Error>, directory: bool) {
        let expected = if directory {
            DATABASE_OPEN_THROUGH_ANOTHER_DIRECTORY
        } else {
            DATABASE_OPEN_THROUGH_ANOTHER_NAME
        };
        assert!(matches!(result, Err(Error::Conflict(message)) if message == expected));
    }

    #[test]
    fn vanished_renamed_idle_cache_opens_under_the_new_name() -> Result<(), Error> {
        for cross_directory in [false, true] {
            let root = tempfile::tempdir()?;
            let old = root.path().join("old.db3");
            let parent = root.path().join("moved");
            std::fs::create_dir(&parent)?;
            let new = if cross_directory {
                parent.join("new.db3")
            } else {
                root.path().join("new.db3")
            };
            let repository = DatabaseRepository::default();
            let old_key = committed_fixture(&repository, &old)?;
            std::fs::hard_link(&old, &new)?;
            // A live alias, even with no lease or extra entry owner, must remain refused.
            assert_admission_refusal(
                repository.connection(&test_target(&new), None),
                cross_directory,
            );
            assert!(repository
                .state
                .lock()
                .map_err(repository_state_poisoned)?
                .entries
                .contains_key(&old_key));
            std::fs::remove_file(&new)?;
            let lease = repository.connection(&test_target(&old), None)?;
            std::fs::rename(&old, &new)?;
            assert_admission_refusal(
                repository.connection(&test_target(&new), None),
                cross_directory,
            );
            drop(lease);
            let extra_owner = repository
                .state
                .lock()
                .map_err(repository_state_poisoned)?
                .entries
                .get(&old_key)
                .cloned();
            assert_admission_refusal(
                repository.connection(&test_target(&new), None),
                cross_directory,
            );
            drop(extra_owner);
            assert_admission_refusal(BoundDatabase::acquire(&test_target(&new)), cross_directory);
            assert_committed(&repository, &new)?;
            let state = repository.state.lock().map_err(repository_state_poisoned)?;
            assert!(!state.entries.contains_key(&old_key));
            assert!(state.entries.keys().all(|key| key.path != old));
            assert_eq!(state.entries.len(), 1);
            drop(state);
            drop(BoundDatabase::acquire(&test_target(&new))?);
        }
        Ok(())
    }

    #[test]
    fn vanished_renamed_idle_cache_keeps_committed_row() -> Result<(), Error> {
        let root = tempfile::tempdir()?;
        let old = root.path().join("old.db3");
        let new = root.path().join("new.db3");
        let repository = DatabaseRepository::default();
        let key = committed_fixture(&repository, &old)?;
        let old_wal = sidecar(&old, "-wal");
        let old_wal_identity = test_target(&old_wal).identity();
        std::fs::rename(&old, &new)?;
        // A pending leaf-open hook must remain unused by the checkpoint and retirement.
        let bound = repository
            .state
            .lock()
            .map_err(repository_state_poisoned)?
            .entries
            .get(&key)
            .map(|entry| entry.bound.clone())
            .ok_or_else(|| Error::Conflict("fixture binding missing".into()))?;
        let opens = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&opens);
        bound.set_before_openat_hook(move || {
            observed.fetch_add(1, Ordering::SeqCst);
        })?;
        drop(bound);
        assert_committed(&repository, &new)?;
        assert_eq!(opens.load(Ordering::SeqCst), 0);
        assert_eq!(test_target(&old_wal).identity(), old_wal_identity);
        assert_eq!(std::fs::metadata(&old_wal)?.len(), 0);
        std::fs::remove_file(old_wal)?;
        assert_committed(&repository, &new)?;
        Ok(())
    }

    #[test]
    fn vanished_renamed_idle_cache_keeps_row_after_idle_close() -> Result<(), Error> {
        for cross_directory in [false, true] {
            let root = tempfile::tempdir()?;
            let old = root.path().join("old.db3");
            std::fs::create_dir(root.path().join("moved"))?;
            let new = if cross_directory {
                root.path().join("moved/new.db3")
            } else {
                root.path().join("new.db3")
            };
            let repository = DatabaseRepository::default();
            let key = committed_fixture(&repository, &old)?;
            std::fs::rename(&old, &new)?;
            close_idle_connections(&repository, &key)?;
            assert!(std::fs::metadata(sidecar(&old, "-wal"))?.len() > 0);
            assert_committed(&repository, &new)?;
            assert!(!sidecar(&old, "-wal").exists());
            assert!(!sidecar(&old, "-shm").exists());
        }
        Ok(())
    }

    #[test]
    fn vanished_rename_with_directory_at_old_name() -> Result<(), Error> {
        for empty_pool in [false, true] {
            let root = tempfile::tempdir()?;
            let old = root.path().join("old.db3");
            let new = root.path().join("new.db3");
            let repository = DatabaseRepository::default();
            let key = committed_fixture(&repository, &old)?;
            std::fs::rename(&old, &new)?;
            std::fs::create_dir(&old)?;
            if empty_pool {
                close_idle_connections(&repository, &key)?;
            }
            assert_committed(&repository, &new)?;
            let state = repository.state.lock().map_err(repository_state_poisoned)?;
            assert!(!state.entries.contains_key(&key));
            assert!(state.entries.contains_key(&entry_key(&test_target(&new))?));
            assert!(old.is_dir());
        }
        Ok(())
    }

    #[test]
    fn vanished_rename_with_absent_or_empty_wal() -> Result<(), Error> {
        for empty_wal in [false, true] {
            let root = tempfile::tempdir()?;
            let old = root.path().join("old.db3");
            let new = root.path().join("new.db3");
            let repository = DatabaseRepository::default();
            let key = committed_fixture(&repository, &old)?;
            let mut connection = repository.connection(&test_target(&old), None)?;
            connection.batch_execute("PRAGMA wal_checkpoint(TRUNCATE)")?;
            drop(connection);
            close_idle_connections(&repository, &key)?;
            let wal = sidecar(&old, "-wal");
            if empty_wal {
                std::fs::File::create(&wal)?;
                assert_eq!(std::fs::metadata(&wal)?.len(), 0);
            } else {
                match std::fs::remove_file(&wal) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
                assert!(!wal.exists());
            }
            {
                let state = repository.state.lock().map_err(repository_state_poisoned)?;
                assert!(state.entries.get(&key).is_some_and(|entry| entry.is_idle()));
            }
            std::fs::rename(&old, &new)?;
            assert_committed(&repository, &new)?;
            if empty_wal {
                assert_eq!(std::fs::metadata(&wal)?.len(), 0);
            } else {
                assert!(!wal.exists());
            }
            let state = repository.state.lock().map_err(repository_state_poisoned)?;
            assert!(!state.entries.contains_key(&key));
            assert!(state.entries.contains_key(&entry_key(&test_target(&new))?));
            drop(state);
            drop(BoundDatabase::acquire(&test_target(&new))?);
        }
        Ok(())
    }

    fn shm_rename_failure_case(fail_restore: bool) -> Result<(), Error> {
        let root = tempfile::tempdir()?;
        let old = root.path().join("old.db3");
        let new = root.path().join("new.db3");
        let repository = DatabaseRepository::default();
        let key = committed_fixture(&repository, &old)?;
        std::fs::rename(&old, &new)?;
        close_idle_connections(&repository, &key)?;
        let old_wal = sidecar(&old, "-wal");
        let new_wal = sidecar(&new, "-wal");
        let new_shm = sidecar(&new, "-shm");
        let saved_wal = root.path().join("saved-wal");
        let wal_bytes = std::fs::read(&old_wal)?;
        let wal_identity = test_target(&old_wal).identity();
        assert!(!wal_bytes.is_empty());
        assert!(sidecar(&old, "-shm").is_file());
        let hooks = configure_test_hooks(root.path(), |hooks| {
            let new_wal = new_wal.clone();
            let new_shm = new_shm.clone();
            let saved_wal = saved_wal.clone();
            hooks.by_path.insert(
                (
                    TestHook::BeforeVanishedShmRename,
                    normalize_test_hook_path(&new),
                ),
                Box::new(move || {
                    assert_eq!(test_target(&new_wal).identity(), wal_identity);
                    assert!(!new_shm.exists());
                    assert!(std::fs::write(&new_shm, b"destination shm").is_ok());
                    if fail_restore {
                        assert!(std::fs::rename(&new_wal, &saved_wal).is_ok());
                        assert!(std::fs::write(&new_wal, b"replacement wal").is_ok());
                        assert_ne!(test_target(&new_wal).identity(), wal_identity);
                    }
                }),
            );
        });
        let error = repository
            .connection(&test_target(&new), None)
            .err()
            .ok_or_else(|| Error::Conflict("SHM rename unexpectedly succeeded".into()))?;
        if fail_restore {
            let Error::OperationAndCleanup { primary, cleanup } = error else {
                return Err(Error::Conflict(format!(
                    "expected operation and cleanup failures, got {error:?}"
                )));
            };
            assert_eq!(
                primary,
                Error::from(std::io::Error::from_raw_os_error(libc::EEXIST)).diagnostic()
            );
            assert_eq!(
                cleanup,
                Error::Conflict("workspace entry changed concurrently".into()).diagnostic()
            );
            assert!(!old_wal.exists());
            assert_eq!(std::fs::read(&new_wal)?, b"replacement wal");
            assert_eq!(test_target(&saved_wal).identity(), wal_identity);
            assert_eq!(std::fs::read(&saved_wal)?, wal_bytes);
        } else {
            assert!(matches!(error, Error::Io(error)
                if error.kind() == std::io::ErrorKind::AlreadyExists));
            assert_eq!(std::fs::read(&old_wal)?, wal_bytes);
            assert_eq!(test_target(&old_wal).identity(), wal_identity);
            assert!(!new_wal.exists());
        }
        assert_eq!(std::fs::read(&new_shm)?, b"destination shm");
        assert_admission_refusal(BoundDatabase::acquire(&test_target(&new)), false);
        {
            let state = repository.state.lock().map_err(repository_state_poisoned)?;
            let entry = state
                .entries
                .get(&key)
                .ok_or_else(|| Error::Conflict("old entry was retired".into()))?;
            assert!(entry.is_idle());
            assert!(!entry.leases.snapshot().closed);
            assert!(!state.entries.contains_key(&entry_key(&test_target(&new))?));
        }
        drop(hooks);
        if !fail_restore {
            std::fs::remove_file(&new_shm)?;
            assert_committed(&repository, &new)?;
            let state = repository.state.lock().map_err(repository_state_poisoned)?;
            assert!(!state.entries.contains_key(&key));
            assert!(state.entries.contains_key(&entry_key(&test_target(&new))?));
        }
        Ok(())
    }

    #[test]
    fn vanished_shm_rename_failure_restores_wal() -> Result<(), Error> {
        shm_rename_failure_case(false)
    }

    #[test]
    fn vanished_shm_rename_and_restore_failures_are_preserved() -> Result<(), Error> {
        shm_rename_failure_case(true)
    }

    fn replacement_wal_case(after_selection: bool) -> Result<(), Error> {
        let root = tempfile::tempdir()?;
        let old = root.path().join("old.db3");
        let new = root.path().join("new.db3");
        let repository = DatabaseRepository::default();
        let key = committed_fixture(&repository, &old)?;
        std::fs::rename(&old, &new)?;
        let distinctive = b"replacement wal must stay at its own name";
        if !after_selection {
            std::fs::write(&old, b"different regular database file")?;
        }
        close_idle_connections(&repository, &key)?;
        let _hooks = if after_selection {
            let old = old.clone();
            Some(configure_test_hooks(root.path(), |hooks| {
                hooks.by_path.insert(
                    (
                        TestHook::VanishedHolderSelected,
                        normalize_test_hook_path(&old),
                    ),
                    Box::new(move || {
                        assert!(!old.exists());
                        assert!(
                            std::fs::write(&old, b"replacement installed after selection").is_ok()
                        );
                        assert!(std::fs::write(sidecar(&old, "-wal"), distinctive).is_ok());
                    }),
                );
            }))
        } else {
            std::fs::write(sidecar(&old, "-wal"), distinctive)?;
            None
        };
        assert_admission_refusal(repository.connection(&test_target(&new), None), false);
        let state = repository.state.lock().map_err(repository_state_poisoned)?;
        let entry = state
            .entries
            .get(&key)
            .ok_or_else(|| Error::Conflict("old entry was retired".into()))?;
        assert!(entry.is_idle());
        assert_eq!(std::fs::read(sidecar(&old, "-wal"))?, distinctive);
        assert!(!sidecar(&new, "-wal").exists());
        assert!(!sidecar(&new, "-shm").exists());
        Ok(())
    }

    #[test]
    fn vanished_rename_refuses_unproven_replacement_wal() -> Result<(), Error> {
        replacement_wal_case(false)
    }

    #[test]
    fn vanished_rename_refuses_wal_replaced_after_selection() -> Result<(), Error> {
        replacement_wal_case(true)
    }

    #[test]
    fn vanished_renamed_idle_cache_waits_for_drain() -> Result<(), Error> {
        let root = tempfile::tempdir()?;
        let old = root.path().join("old.db3");
        let new = root.path().join("new.db3");
        let repository = DatabaseRepository::default();
        let key = committed_fixture(&repository, &old)?;
        let gate = repository
            .state
            .lock()
            .map_err(repository_state_poisoned)?
            .entries
            .get(&key)
            .map(|entry| Arc::clone(&entry.connections))
            .ok_or_else(|| Error::Conflict("fixture gate missing".into()))?;
        let ticket = gate
            .enter()
            .ok_or_else(|| Error::Conflict("fixture gate closed".into()))?;
        std::fs::rename(&old, &new)?;
        let acquires = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&acquires);
        let (published, published_rx) = mpsc::channel();
        let (resume, resume_rx) = mpsc::channel();
        let _hooks = configure_test_hooks(root.path(), |hooks| {
            hooks.by_path.insert(
                (TestHook::BeforeAcquireBound, normalize_test_hook_path(&new)),
                Box::new(move || {
                    observed.fetch_add(1, Ordering::SeqCst);
                }),
            );
            hooks.retirement_published = Some(Box::new(move || {
                assert!(published.send(()).is_ok());
                assert!(resume_rx.recv_timeout(WAIT).is_ok());
            }));
        });
        std::thread::scope(|scope| -> Result<(), Error> {
            let worker =
                scope.spawn(|| repository.connection(&test_target(&new), None).map(|_| ()));
            assert!(published_rx.recv_timeout(WAIT).is_ok());
            assert_eq!(acquires.load(Ordering::SeqCst), 1);
            assert!(resume.send(()).is_ok());
            let deadline = Instant::now() + WAIT;
            while gate.snapshot().waiting == 0
                && acquires.load(Ordering::SeqCst) == 1
                && Instant::now() < deadline
            {
                std::thread::yield_now();
            }
            assert!(
                gate.snapshot().waiting > 0,
                "connection gate must hold the retry back"
            );
            assert_eq!(acquires.load(Ordering::SeqCst), 1);
            drop(ticket);
            worker
                .join()
                .map_err(|_| Error::Conflict("open worker panicked".into()))??;
            assert_eq!(acquires.load(Ordering::SeqCst), 2);
            assert!(gate.snapshot().closed);
            assert_eq!(gate.snapshot().outstanding, 0);
            Ok(())
        })
    }

    #[test]
    fn revision_read_retires_vanished_idle_cache() -> Result<(), Error> {
        for empty_pool in [false, true] {
            let root = tempfile::tempdir()?;
            let old = root.path().join("old.db3");
            let new = root.path().join("new.db3");
            let repository = DatabaseRepository::default();
            let key = committed_fixture(&repository, &old)?;
            std::fs::rename(&old, &new)?;
            if empty_pool {
                close_idle_connections(&repository, &key)?;
            }
            let target = test_target(&new);
            let reads = Arc::new(AtomicUsize::new(0));
            let observed = Arc::clone(&reads);
            let _hooks = configure_test_hooks(&new, |hooks| {
                hooks.after_read_revision = Some(Box::new(move || {
                    observed.fetch_add(1, Ordering::SeqCst);
                }));
            });
            assert_eq!(repository.database_identity(&target)?.data_revision, 23);
            let count = reads.load(Ordering::SeqCst);
            if !empty_pool {
                assert_eq!(
                    count, 8,
                    "checkpoint requires exactly one identity resample"
                );
            } else {
                assert!(count == 4 || count == 8);
            }
            assert!(repository
                .state
                .lock()
                .map_err(repository_state_poisoned)?
                .entries
                .is_empty());
            assert_committed(&repository, &new)?;
            drop(_hooks);

            // Without a write by this identity call, metadata disagreement remains a conflict.
            let changed = new.clone();
            let mut changed_once = false;
            let _hooks = configure_test_hooks(&new, |hooks| {
                hooks.after_read_revision = Some(Box::new(move || {
                    if !changed_once {
                        changed_once = true;
                        let metadata = std::fs::metadata(&changed);
                        assert!(metadata.is_ok());
                        if let Ok(metadata) = metadata {
                            let file = std::fs::OpenOptions::new().write(true).open(&changed);
                            assert!(file.is_ok());
                            if let Ok(file) = file {
                                assert!(file.set_len(metadata.len() + 4096).is_ok());
                            }
                        }
                    }
                }));
            });
            assert!(matches!(repository.database_identity(&target),
                Err(Error::Conflict(message)) if message == "database changed while reading its identity"));
        }
        Ok(())
    }

    #[test]
    fn vanished_rename_retry_conflict_runs_helper_once() -> Result<(), Error> {
        let root = tempfile::tempdir()?;
        let old = root.path().join("old.db3");
        let new = root.path().join("new.db3");
        let link = root.path().join("live.db3");
        let repository = DatabaseRepository::default();
        committed_fixture(&repository, &old)?;
        std::fs::hard_link(&old, &link)?;
        std::fs::rename(&old, &new)?;
        let holder = Arc::new(Mutex::new(None));
        let held = Arc::clone(&holder);
        let _hooks = configure_test_hooks(&new, |hooks| {
            hooks.by_path.insert(
                (
                    TestHook::VanishedHoldersRetired,
                    normalize_test_hook_path(&new),
                ),
                Box::new(move || {
                    let bound = BoundDatabase::acquire(&test_target(&link));
                    assert!(bound.is_ok());
                    *held
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = bound.ok();
                }),
            );
        });
        assert_admission_refusal(repository.connection(&test_target(&new), None), false);
        assert_eq!(
            repository
                .vanished_retirement_attempts
                .load(Ordering::SeqCst),
            1
        );
        assert!(repository
            .state
            .lock()
            .map_err(repository_state_poisoned)?
            .entries
            .is_empty());
        drop(holder.lock().map_err(repository_state_poisoned)?.take());
        Ok(())
    }

    #[test]
    fn vanished_rename_admits_with_fifteen_incomplete_retirements() -> Result<(), Error> {
        let root = tempfile::tempdir()?;
        let repository = DatabaseRepository::with_retire_wait(Duration::from_secs(2));
        let mut tickets = Vec::new();
        for index in 0..15 {
            let parent = root.path().join(format!("retired-{index}"));
            std::fs::create_dir(&parent)?;
            let target = test_target(&parent.join("held.db3"));
            let (key, entry, _) = repository.entry(&target, None)?;
            tickets.push(
                entry
                    .connections
                    .enter()
                    .ok_or_else(|| Error::Conflict("fixture gate closed".into()))?,
            );
            entry.leases.close();
            let mut capacity =
                repository.reserve_retirement_capacity(Instant::now() + WAIT, None)?;
            let mut state = repository.state.lock().map_err(repository_state_poisoned)?;
            let disposal = state.publish_retirement(&key, &entry)?;
            capacity.publish(&mut state);
            let removed = state.entries.remove(&key);
            drop(state);
            drop(entry.pool.write().take());
            drop(removed);
            drop(disposal);
        }
        assert_eq!(
            repository
                .state
                .lock()
                .map_err(repository_state_poisoned)?
                .retired
                .len(),
            15
        );
        let old = root.path().join("old.db3");
        let new = root.path().join("new.db3");
        let key = committed_fixture(&repository, &old)?;
        std::fs::rename(&old, &new)?;
        assert_committed(&repository, &new)?;
        let state = repository.state.lock().map_err(repository_state_poisoned)?;
        assert!(!state.entries.contains_key(&key));
        assert_eq!(state.retired.len(), 15);
        assert_eq!(state.retirement_reservations, 0);
        drop(state);
        drop(tickets);
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use diesel::{connection::SimpleConnection, RunQueryDsl};
    use std::{sync::mpsc, time::Duration};

    fn assert_repository_state_poison(error: Error) {
        assert!(
            matches!(&error, Error::Conflict(_)),
            "poison must return Conflict"
        );
        assert_eq!(error.category(), crate::error::ErrorCategory::Conflict);
        assert_eq!(
            error.to_string(),
            "Conflict: database repository state poisoned"
        );
        let payload = serde_json::to_value(&error).unwrap();
        assert_eq!(payload["category"], "conflict");
        assert_eq!(
            payload["message"],
            "Conflict: database repository state poisoned"
        );
    }

    #[test]
    fn repository_state_poison_fails_public_operations_closed() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        let state = Arc::clone(&repository.state);
        assert!(std::thread::spawn(move || {
            let _guard = state.lock().unwrap();
            panic!("deliberate repository state poison");
        })
        .join()
        .is_err());
        assert!(repository.state.is_poisoned());

        assert_repository_state_poison(
            repository
                .connection(&target, None)
                .err()
                .expect("poisoned repository must refuse a connection"),
        );
        let mut called = false;
        let result =
            repository.with_write_lock_cancellable(&target, &CancellationToken::new(), || {
                called = true;
                Ok(())
            });
        assert_repository_state_poison(result.unwrap_err());
        assert!(
            !called,
            "poisoned repository must refuse the write callback"
        );
    }

    #[test]
    fn entry_state_poison_fails_public_operations_closed() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let repository = DatabaseRepository::default();
        let (target, _key, entry) = initialized_target_entry(&repository, &path);
        let poisoned_entry = Arc::clone(&entry);
        assert!(std::thread::spawn(move || {
            let _guard = poisoned_entry.state.lock().unwrap();
            panic!("deliberate entry state poison");
        })
        .join()
        .is_err());
        assert!(entry.state.is_poisoned());
        assert!(!repository.state.is_poisoned());

        assert_repository_state_poison(
            repository
                .connection(&target, None)
                .err()
                .expect("poisoned entry must refuse a connection"),
        );
        let mut called = false;
        let result =
            repository.with_write_lock_cancellable(&target, &CancellationToken::new(), || {
                called = true;
                Ok(())
            });
        assert_repository_state_poison(result.unwrap_err());
        assert!(!called, "poisoned entry must refuse the write callback");
    }

    #[derive(diesel::QueryableByName)]
    struct TestText {
        #[diesel(sql_type = diesel::sql_types::Text)]
        value: String,
    }

    #[test]
    fn snapshot_open_establish_failure_sanitizes_payload_and_logs_native_cause() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        drop(SqliteConnection::establish(path.to_str().unwrap()).unwrap());
        let file = std::fs::File::open(&path).unwrap();
        let identity = crate::infra::path_authority::opened_file_identity(&file).unwrap();
        let forced_path = directory.path().join("private-snapshot-open");
        std::fs::create_dir(&forced_path).unwrap();
        let override_path = forced_path.to_str().unwrap().to_owned();
        let native_cause = SqliteConnection::establish(&override_path)
            .err()
            .expect("SQLite must refuse a directory")
            .to_string();
        SNAPSHOT_OPEN_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || override_path.clone()));
        });
        let capture = crate::error::LogCaptureScope::start();

        let error = DatabaseRepository::default()
            .schema_specific_connection_expected_file_cancellable(
                file.into(),
                identity,
                &CancellationToken::new(),
            )
            .err()
            .expect("the forced snapshot path must fail to open");

        assert!(matches!(&error, Error::Io(source) if source.kind() == std::io::ErrorKind::Other));
        assert!(error.diagnostic().contains(&native_cause));
        let payload = serde_json::to_value(&error).unwrap();
        assert_eq!(payload["category"], "io");
        let message = payload["message"].as_str().unwrap();
        assert_eq!(message, "I/O failure");
        assert!(!message.contains(&native_cause));
        for component in forced_path.components() {
            if let std::path::Component::Normal(fragment) = component {
                assert!(!message.contains(fragment.to_str().unwrap()));
            }
        }
        assert!(capture.records().iter().any(|record| {
            record.level == log::Level::Warn && record.message.contains(&native_cause)
        }));
        SNAPSHOT_OPEN_HOOK.with(|hook| assert!(hook.borrow().is_none()));
    }

    #[test]
    fn aliases_share_one_pool_and_revision_sequence() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let alias = directory.path().join(".").join("database.db3");
        let repository = DatabaseRepository::default();

        let mut connection = repository
            .initialization_connection(&test_target(&path), None)
            .unwrap();
        assert!(!repository.is_building(&test_target(&path)).unwrap());
        migrations::prepare_database(&mut connection, "title", "description").unwrap();
        drop(connection);
        repository
            .mark_schema_validated(&test_target(&path))
            .unwrap();
        repository.connection(&test_target(&alias), None).unwrap();

        assert_eq!(repository.state.lock().unwrap().entries.len(), 1);
        let mut revision_connection = repository
            .initialization_connection(&test_target(&alias), None)
            .unwrap();
        assert_eq!(read_data_revision(&mut revision_connection).unwrap(), 0);
        revision_connection
            .transaction::<_, Error, _>(|db| {
                crate::db::bump_revision_in_transaction(
                    db,
                    &alias,
                    &CancellationToken::new(),
                    |_| Ok(()),
                )
            })
            .unwrap();
        assert_eq!(read_data_revision(&mut revision_connection).unwrap(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn bump_hook_matches_a_canonical_scope_for_a_raw_alias_path() {
        use diesel::connection::SimpleConnection;

        let directory = tempfile::tempdir().unwrap();
        let real_parent = directory.path().join("real");
        std::fs::create_dir(&real_parent).unwrap();
        let linked_parent = directory.path().join("linked");
        std::os::unix::fs::symlink(&real_parent, &linked_parent).unwrap();
        let raw_alias = linked_parent.join("database.db3");
        let scoped_target = test_target(&raw_alias);
        let canonical_scope = scoped_target.path().to_path_buf();
        let mut connection =
            SqliteConnection::establish(canonical_scope.to_str().unwrap()).unwrap();
        connection
            .batch_execute(
                "CREATE TABLE Info (Name TEXT PRIMARY KEY, Value TEXT);\
                 INSERT INTO Info (Name, Value) VALUES ('DataRevision', '0');",
            )
            .unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = Arc::clone(&calls);
        let _hooks = configure_test_hooks(&canonical_scope, move |hooks| {
            hooks.after_bump_op = Some(Box::new(move || {
                observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }));
        });

        connection
            .transaction::<_, Error, _>(|db| {
                crate::db::bump_revision_in_transaction(
                    db,
                    &raw_alias,
                    &CancellationToken::new(),
                    |_| Ok(()),
                )
            })
            .unwrap();

        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[cfg(unix)]
    #[test]
    fn hard_link_alias_is_refused_until_cached_entry_and_owners_are_released() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let alias = directory.path().join("alias.db3");
        std::fs::File::create(&path).unwrap();
        std::fs::hard_link(&path, &alias).unwrap();
        let path_target = test_target(&path);
        let alias_target = test_target(&alias);
        let repository = DatabaseRepository::default();

        let connection = repository
            .initialization_connection(&path_target, None)
            .unwrap();
        let path_entry = repository.entry(&path_target, None).unwrap().1;
        let alias_key = entry_key(&alias_target).unwrap();
        let assert_refused = || {
            assert!(
                matches!(repository.initialization_connection(&alias_target, None),
                    Err(Error::Conflict(message)) if message == "database is open through another name"
                ),
                "repository must refuse a same-parent alias before constructing its pool"
            );
            let state = repository.state.lock().unwrap();
            assert!(
                !state.entries.contains_key(&alias_key),
                "refused alias must not publish an entry"
            );
            assert!(
                !state.building.contains(&alias_key),
                "refused alias must release its build marker"
            );
            assert_eq!(state.entries.len(), 1);
        };
        assert_refused();
        drop(connection);
        assert!(
            path_entry
                .pool
                .read()
                .as_ref()
                .unwrap()
                .state()
                .idle_connections
                > 0
        );
        assert_refused();
        repository.close_and_invalidate(&path_target).unwrap();
        assert!(
            matches!(repository.initialization_connection(&alias_target, None),
                Err(Error::Conflict(message)) if message == "database is open through another name"
            ),
            "an external entry holder must keep alias admission closed after eviction"
        );
        drop(path_entry);
        let mut alias_connection = repository
            .initialization_connection(&alias_target, None)
            .unwrap();
        alias_connection
            .batch_execute("CREATE TABLE AliasAdmitted (value INTEGER);")
            .unwrap();
        assert_eq!(repository.state.lock().unwrap().entries.len(), 1);
    }

    #[test]
    fn wal_writer_survives_alias_refusal_without_alias_sidecars() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let alias = directory.path().join("alias.db3");
        std::fs::File::create(&path).unwrap();
        std::fs::hard_link(&path, &alias).unwrap();
        let path_target = test_target(&path);
        let alias_target = test_target(&alias);
        let repository = DatabaseRepository::default();
        let mut connection = repository
            .initialization_connection(&path_target, None)
            .unwrap();
        connection
            .batch_execute(
                "PRAGMA journal_mode=WAL;
            CREATE TABLE Writer (value INTEGER);
            BEGIN IMMEDIATE; INSERT INTO Writer VALUES (1);",
            )
            .unwrap();
        assert!(path.with_file_name("database.db3-wal").exists());
        assert!(path.with_file_name("database.db3-shm").exists());
        assert!(
            matches!(repository.initialization_connection(&alias_target, None),
                Err(Error::Conflict(message)) if message == "database is open through another name"
            ),
            "WAL alias must be refused before opening SQLite"
        );
        connection
            .batch_execute("INSERT INTO Writer VALUES (2);")
            .unwrap();
        let count: TestText = sql_query("SELECT CAST(COUNT(*) AS TEXT) AS value FROM Writer")
            .get_result(&mut *connection)
            .unwrap();
        assert_eq!(
            count.value, "2",
            "the original WAL writer must remain usable after refusal"
        );
        connection.batch_execute("COMMIT;").unwrap();
        assert!(
            !alias.with_file_name("alias.db3-wal").exists(),
            "refusal must not create alias WAL"
        );
        assert!(
            !alias.with_file_name("alias.db3-shm").exists(),
            "refusal must not create alias SHM"
        );
        assert!(!super::super::bound_sqlite::has_binding_for_test(
            &alias_target
        ));
    }

    #[test]
    fn revision_read_refuses_same_parent_alias_before_pool_timeout() {
        const PROMPT_REFUSAL_BOUND: Duration = Duration::from_secs(1);
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let alias = directory.path().join("alias.db3");
        std::fs::File::create(&path).unwrap();
        std::fs::hard_link(&path, &alias).unwrap();
        let path_target = test_target(&path);
        let alias_target = test_target(&alias);
        let repository = Arc::new(DatabaseRepository::default());
        let _connection = repository
            .initialization_connection(&path_target, None)
            .unwrap();
        let worker_repository = Arc::clone(&repository);
        let (result_tx, result_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            result_tx
                .send(worker_repository.read_revision(&alias_target, &CancellationToken::new()))
                .unwrap();
        });
        let result = result_rx
            .recv_timeout(PROMPT_REFUSAL_BOUND)
            .expect("revision alias refusal must complete before the r2d2 connection timeout");
        worker.join().unwrap();
        assert!(
            matches!(result,
                Err(Error::Conflict(message)) if message == "database is open through another name"
            ),
            "revision reads must fail closed at binding admission"
        );
    }

    #[test]
    fn construction_does_not_hold_the_repository_mutex() {
        let directory = tempfile::tempdir().unwrap();
        let first_path = directory.path().join("first.db3");
        let second_path = directory.path().join("second.db3");
        let first_target = test_target(&first_path);
        let second_target = test_target(&second_path);
        let repository = Arc::new(DatabaseRepository::default());
        let (entered, entered_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let first_build = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let first_build_callback = Arc::clone(&first_build);
        let expected_thread = Arc::new(std::sync::Mutex::new(None));
        let expected_thread_callback = Arc::clone(&expected_thread);
        let _hooks = configure_test_hooks(&first_path, |hooks| {
            hooks.pre_build = Some(Box::new(move || {
                let is_expected_thread =
                    expected_thread_callback.lock().ok().is_some_and(|thread| {
                        thread
                            .as_ref()
                            .is_some_and(|expected| *expected == std::thread::current().id())
                    });
                if is_expected_thread
                    && first_build_callback.swap(false, std::sync::atomic::Ordering::SeqCst)
                {
                    entered.send(()).unwrap();
                    release_rx.recv().unwrap();
                }
            }));
        });

        let worker_repository = Arc::clone(&repository);
        let worker_expected_thread = Arc::clone(&expected_thread);
        let worker = std::thread::spawn(move || {
            *worker_expected_thread.lock().unwrap() = Some(std::thread::current().id());
            worker_repository.initialization_connection(&first_target, None)
        });
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let second_started = Instant::now();
        repository
            .initialization_connection(&second_target, None)
            .unwrap();
        assert!(second_started.elapsed() < Duration::from_secs(1));
        release.send(()).unwrap();
        worker.join().unwrap().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn test_hooks_are_scoped_to_the_database_path() {
        let directory = tempfile::tempdir().unwrap();
        let real_parent = directory.path().join("real");
        std::fs::create_dir(&real_parent).unwrap();
        let linked_parent = directory.path().join("linked");
        std::os::unix::fs::symlink(&real_parent, &linked_parent).unwrap();
        let path_a = linked_parent.join("database-a.db3");
        let path_b = linked_parent.join("database-b.db3");
        let target_a = test_target(&path_a);
        let repository = Arc::new(DatabaseRepository::default());
        let probes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_probes = Arc::clone(&probes);
        let _hooks = configure_test_hooks(&path_a, move |hooks| {
            hooks.after_probe_current = Some(Box::new(move |_| {
                observed_probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }));
        });

        repository
            .initialization_connection(&target_a, None)
            .unwrap();
        let a_probes_before_b = probes.load(std::sync::atomic::Ordering::SeqCst);
        assert!(a_probes_before_b > 0, "database A's hook must fire");

        let worker_repository = Arc::clone(&repository);
        let worker = std::thread::spawn(move || {
            worker_repository.initialization_connection(&test_target(&path_b), None)
        });
        worker.join().unwrap().unwrap();

        assert_eq!(
            probes.load(std::sync::atomic::Ordering::SeqCst),
            a_probes_before_b,
            "probing an unrelated database must not run or count database A's hook"
        );
    }

    struct StaleHookCallback {
        entered: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
        first_call: Arc<std::sync::atomic::AtomicBool>,
        calls: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl StaleHookCallback {
        fn invoke(&self) {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self
                .first_call
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                self.entered.send(()).unwrap();
                self.release.recv().unwrap();
            }
        }
    }

    fn install_stale_hook(hooks: &mut TestHooks, hook: TestHook, callback: StaleHookCallback) {
        match hook {
            TestHook::AfterProbeCurrent => {
                hooks.after_probe_current = Some(Box::new(move |_| callback.invoke()));
            }
            TestHook::AfterReadRevision => {
                hooks.after_read_revision = Some(Box::new(move || callback.invoke()));
            }
            _ => unreachable!("stale hook test only supports callback forms"),
        }
    }

    fn install_counting_hook(
        hooks: &mut TestHooks,
        hook: TestHook,
        calls: Arc<std::sync::atomic::AtomicUsize>,
    ) {
        match hook {
            TestHook::AfterProbeCurrent => {
                hooks.after_probe_current = Some(Box::new(move |_| {
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }));
            }
            TestHook::AfterReadRevision => {
                hooks.after_read_revision = Some(Box::new(move || {
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }));
            }
            _ => unreachable!("stale hook test only supports callback forms"),
        }
    }

    fn stale_hook_writeback_case(hook: TestHook) {
        let directory = tempfile::tempdir().unwrap();
        let path_a = directory.path().join("database-a.db3");
        let path_b = directory.path().join("database-b.db3");
        let (entered, entered_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let a_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_a_calls = Arc::clone(&a_calls);
        let _a_hooks = configure_test_hooks(&path_a, move |hooks| {
            install_stale_hook(
                hooks,
                hook,
                StaleHookCallback {
                    entered,
                    release: release_rx,
                    first_call: Arc::new(std::sync::atomic::AtomicBool::new(true)),
                    calls: observed_a_calls,
                },
            );
        });

        let worker_path = path_a.clone();
        let worker = std::thread::spawn(move || {
            run_test_hook(hook, &worker_path);
        });
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        drop(_a_hooks);

        let b_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_b_calls = Arc::clone(&b_calls);
        let _b_hooks = configure_test_hooks(&path_b, move |hooks| {
            install_counting_hook(hooks, hook, observed_b_calls);
        });

        release.send(()).unwrap();
        worker.join().unwrap();
        run_test_hook(hook, &path_b);

        assert_eq!(
            b_calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "database B's callback must run after its configuration"
        );
        assert_eq!(
            a_calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "database A's callback must not run during database B's dispatch"
        );
    }

    #[test]
    fn stale_hook_callback_cannot_overwrite_new_configuration() {
        stale_hook_writeback_case(TestHook::AfterProbeCurrent);
    }

    #[test]
    fn stale_noarg_hook_callback_cannot_overwrite_new_configuration() {
        stale_hook_writeback_case(TestHook::AfterReadRevision);
    }

    #[test]
    fn panicking_hook_configuration_does_not_poison_following_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database-a.db3");
        let fresh_path = directory.path().join("database-b.db3");
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_calls = Arc::clone(&calls);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _hooks = configure_test_hooks(&path, move |hooks| {
                hooks.after_probe_current = Some(Box::new(move |_| {
                    observed_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }));
                panic!("injected hook configuration panic");
            });
        }));
        assert!(result.is_err());
        let repository = DatabaseRepository::default();
        repository
            .initialization_connection(&test_target(&path), None)
            .unwrap();
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "a hook from a panicking configuration must not remain installed"
        );

        let fresh_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_fresh_calls = Arc::clone(&fresh_calls);
        let _hooks = configure_test_hooks(&fresh_path, move |hooks| {
            hooks.after_probe_current = Some(Box::new(move |_| {
                observed_fresh_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }));
        });
        run_test_hook(TestHook::AfterProbeCurrent, &fresh_path);
        assert_eq!(
            fresh_calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "a fresh hook must dispatch after mutex poisoning"
        );
    }

    #[test]
    fn cancelled_build_is_not_published() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let target = test_target(&path);
        // Ordinary empty reads refuse before pool construction. Seed a valid database
        // so this test still reaches cancellation at the pool-publication checkpoint.
        {
            let mut seed = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
            migrations::prepare_database(&mut seed, "Cancellation fixture", "").unwrap();
        }
        let repository = Arc::new(DatabaseRepository::default());
        let cancellation = CancellationToken::new();
        let (entered, entered_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let expected_thread = Arc::new(std::sync::Mutex::new(None));
        let expected_thread_callback = Arc::clone(&expected_thread);
        let _hooks = configure_test_hooks(&path, |hooks| {
            hooks.pre_insert = Some(Box::new(move || {
                let is_expected_thread =
                    expected_thread_callback.lock().ok().is_some_and(|thread| {
                        thread
                            .as_ref()
                            .is_some_and(|expected| *expected == std::thread::current().id())
                    });
                if is_expected_thread {
                    entered.send(()).unwrap();
                    release_rx.recv().unwrap();
                }
            }));
        });

        let worker_repository = Arc::clone(&repository);
        let worker_token = cancellation.clone();
        let worker_expected_thread = Arc::clone(&expected_thread);
        let worker = std::thread::spawn(move || {
            *worker_expected_thread.lock().unwrap() = Some(std::thread::current().id());
            worker_repository.connection(&target, Some(&worker_token))
        });
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        cancellation.cancel();
        release.send(()).unwrap();
        assert!(matches!(worker.join().unwrap(), Err(Error::Cancellation)));
        assert!(repository.state.lock().unwrap().entries.is_empty());
        assert!(!repository.is_building(&test_target(&path)).unwrap());
        drop(_hooks);
        repository
            .initialization_connection(&test_target(&path), None)
            .expect("an uncancelled retry must build a fresh pool");
    }

    #[test]
    fn unlinked_before_get_is_rejected_by_the_prompt_probe() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        repository.initialization_connection(&target, None).unwrap();
        let expected_thread = Arc::new(std::sync::Mutex::new(None));
        let expected_thread_callback = Arc::clone(&expected_thread);
        let _hooks = configure_test_hooks(&path, |hooks| {
            hooks.pre_get = Some(Box::new({
                let path = path.clone();
                move || {
                    let is_expected_thread =
                        expected_thread_callback.lock().ok().is_some_and(|thread| {
                            thread
                                .as_ref()
                                .is_some_and(|expected| *expected == std::thread::current().id())
                        });
                    if is_expected_thread {
                        std::fs::remove_file(&path).unwrap();
                    }
                }
            }));
        });

        let started = Instant::now();
        *expected_thread.lock().unwrap() = Some(std::thread::current().id());
        let result = repository.initialization_connection(&target, None);
        assert!(matches!(
            result,
            Err(Error::Conflict(message))
                if message == "database changed after capability resolution"
        ));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(!path.exists());
        assert!(!repository.is_building(&target).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn swap_after_get_is_rejected_without_retiring_an_outer_lease() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let saved = directory.path().join("saved.db3");
        let replacement = directory.path().join("replacement.db3");
        std::fs::File::create(&path).unwrap();
        std::fs::hard_link(&path, &saved).unwrap();
        std::fs::File::create(&replacement).unwrap();
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        drop(repository.initialization_connection(&target, None).unwrap());
        let old_entry = repository.entry(&target, None).unwrap().1;
        let expected_thread = Arc::new(std::sync::Mutex::new(None));
        let expected_thread_callback = Arc::clone(&expected_thread);
        let _hooks = configure_test_hooks(&path, |hooks| {
            hooks.post_get = Some(Box::new({
                let path = path.clone();
                let replacement = replacement.clone();
                move || {
                    let is_expected_thread =
                        expected_thread_callback.lock().ok().is_some_and(|thread| {
                            thread
                                .as_ref()
                                .is_some_and(|expected| *expected == std::thread::current().id())
                        });
                    if is_expected_thread {
                        std::fs::remove_file(&path).unwrap();
                        std::fs::rename(&replacement, &path).unwrap();
                    }
                }
            }));
        });

        *expected_thread.lock().unwrap() = Some(std::thread::current().id());
        let result = repository.with_write_lock(&target, || {
            repository
                .initialization_connection(&target, None)
                .map(|_| ())
        });
        assert!(matches!(
            result,
            Err(Error::Conflict(message))
                if message == "database changed after capability resolution"
        ));
        let key = entry_key(&target).unwrap();
        let current_entry = repository
            .state
            .lock()
            .unwrap()
            .entries
            .get(&key)
            .cloned()
            .unwrap();
        assert!(Arc::ptr_eq(&old_entry, &current_entry));
        assert!(!old_entry.leases.snapshot().closed);

        drop(_hooks);
        std::fs::remove_file(&path).unwrap();
        std::fs::hard_link(&saved, &path).unwrap();
        repository.close_and_invalidate(&target).unwrap();
    }

    #[test]
    fn stale_probe_confirms_once_then_retires_an_idle_entry() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let replacement = directory.path().join("replacement.db3");
        std::fs::File::create(&path).unwrap();
        std::fs::File::create(&replacement).unwrap();
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        drop(repository.initialization_connection(&target, None).unwrap());
        std::fs::remove_file(&path).unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        let probe_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let probe_count_callback = Arc::clone(&probe_count);
        let expected_thread = Arc::new(std::sync::Mutex::new(None));
        let expected_thread_callback = Arc::clone(&expected_thread);
        let _hooks = configure_test_hooks(&path, |hooks| {
            hooks.after_probe_current = Some(Box::new(move |_| {
                let is_expected_thread =
                    expected_thread_callback.lock().ok().is_some_and(|thread| {
                        thread
                            .as_ref()
                            .is_some_and(|expected| *expected == std::thread::current().id())
                    });
                if is_expected_thread {
                    probe_count_callback.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            }));
        });

        *expected_thread.lock().unwrap() = Some(std::thread::current().id());
        let result = repository.initialization_connection(&target, None);
        assert!(matches!(
            result,
            Err(Error::Conflict(message))
                if message == "database changed after capability resolution"
        ));
        assert_eq!(
            probe_count.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "a conflict gets exactly one confirm probe"
        );
        assert!(repository.state.lock().unwrap().entries.is_empty());
    }

    #[test]
    fn unlinked_before_pool_build_is_a_prompt_conflict_and_clears_building() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        let expected_thread = Arc::new(std::sync::Mutex::new(None));
        let expected_thread_callback = Arc::clone(&expected_thread);
        let _hooks = configure_test_hooks(&path, |hooks| {
            hooks.pre_build = Some(Box::new({
                let path = path.clone();
                move || {
                    let is_expected_thread =
                        expected_thread_callback.lock().ok().is_some_and(|thread| {
                            thread
                                .as_ref()
                                .is_some_and(|expected| *expected == std::thread::current().id())
                        });
                    if is_expected_thread {
                        std::fs::remove_file(&path).unwrap();
                    }
                }
            }));
        });

        let started = Instant::now();
        *expected_thread.lock().unwrap() = Some(std::thread::current().id());
        let result = repository.initialization_connection(&target, None);
        assert!(matches!(
            result,
            Err(Error::Conflict(message))
                if message == "database changed after capability resolution"
        ));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(!path.exists());
        assert!(!repository.is_building(&target).unwrap());
    }

    #[test]
    fn close_evicts_a_database_so_a_replacement_is_revalidated() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let repository = DatabaseRepository::default();
        let mut connection = repository
            .initialization_connection(&test_target(&path), None)
            .unwrap();
        migrations::prepare_database(&mut connection, "title", "description").unwrap();
        drop(connection);
        repository
            .mark_schema_validated(&test_target(&path))
            .unwrap();
        repository
            .close_and_invalidate(&test_target(&path))
            .unwrap();

        assert!(repository.state.lock().unwrap().entries.is_empty());
        repository.connection(&test_target(&path), None).unwrap();
    }

    #[test]
    fn deletion_tombstone_blocks_reacquisition_until_the_terminal_result() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let repository = DatabaseRepository::default();
        let target = test_target(&path);
        let mut connection = repository.initialization_connection(&target, None).unwrap();
        migrations::prepare_database(&mut connection, "title", "description").unwrap();
        drop(connection);
        repository.mark_schema_validated(&target).unwrap();

        repository
            .delete_exclusive(&target, || {
                assert!(matches!(
                    repository.connection(&target, None),
                    Err(Error::Conflict(message)) if message.contains("being deleted")
                ));
                Ok(())
            })
            .unwrap();
        repository.connection(&test_target(&path), None).unwrap();
    }

    #[test]
    fn replacement_at_the_same_path_never_reuses_an_old_pooled_connection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let replacement = directory.path().join("replacement.db3");
        let repository = DatabaseRepository::default();
        let mut connection = repository
            .initialization_connection(&test_target(&path), None)
            .unwrap();
        migrations::prepare_database(&mut connection, "old", "description").unwrap();
        drop(connection);
        let old_target = test_target(&path);
        repository.mark_schema_validated(&old_target).unwrap();
        let old_entry = repository.entry(&old_target, None).unwrap().1;
        let old_object = old_target.identity();

        let replacement_target = test_target(&replacement);
        let mut replacement_connection = repository
            .initialization_connection(&replacement_target, None)
            .unwrap();
        migrations::prepare_database(&mut replacement_connection, "new", "description").unwrap();
        diesel::connection::SimpleConnection::batch_execute(
            &mut *replacement_connection,
            "PRAGMA wal_checkpoint(TRUNCATE);",
        )
        .unwrap();
        drop(replacement_connection);
        // Release the setup name before admitting this inode under its renamed leaf.
        repository
            .close_and_invalidate(&replacement_target)
            .unwrap();
        for suffix in ["-wal", "-shm"] {
            let stale = PathBuf::from(format!("{}{}", path.display(), suffix));
            let _ = std::fs::remove_file(stale);
        }
        std::fs::rename(&replacement, &path).unwrap();
        let new_object = crate::infra::path_authority::opened_file_identity(
            &std::fs::File::open(&path).unwrap(),
        )
        .unwrap();
        assert_ne!(old_object, new_object);

        let new_target = test_target(&path);
        let mut connection = repository.connection(&new_target, None).unwrap();
        let new_entry = repository.entry(&new_target, None).unwrap().1;
        assert!(!Arc::ptr_eq(&old_entry, &new_entry));
        let title = diesel::sql_query("SELECT Value AS value FROM Info WHERE Name = 'Title'")
            .get_result::<TestText>(&mut *connection)
            .unwrap();
        assert_eq!(title.value, "new");
    }

    #[test]
    fn active_connection_blocks_delete_until_its_lease_is_released() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let repository = Arc::new(DatabaseRepository::default());
        let target = test_target(&path);
        let mut setup = repository.initialization_connection(&target, None).unwrap();
        migrations::prepare_database(&mut setup, "title", "description").unwrap();
        drop(setup);
        repository.mark_schema_validated(&target).unwrap();
        let active_read = repository.connection(&target, None).unwrap();
        let (started, started_rx) = mpsc::channel();
        let (done, done_rx) = mpsc::channel();
        let repo = repository.clone();
        let delete_path = path.clone();
        std::thread::spawn(move || {
            started.send(()).unwrap();
            let result = repo.delete_exclusive(&test_target(&delete_path), || Ok(()));
            done.send(result.is_ok()).unwrap();
        });
        started_rx.recv().unwrap();
        assert!(done_rx.recv_timeout(Duration::from_millis(100)).is_err());
        drop(active_read);
        assert!(done_rx.recv_timeout(Duration::from_secs(2)).unwrap());
    }

    #[test]
    fn active_connection_delete_wait_cancels_and_restores_admission() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let repository = Arc::new(DatabaseRepository::default());
        let target = test_target(&path);
        let mut setup = repository.initialization_connection(&target, None).unwrap();
        migrations::prepare_database(&mut setup, "title", "description").unwrap();
        drop(setup);
        repository.mark_schema_validated(&target).unwrap();
        let active_read = repository.connection(&target, None).unwrap();
        let cancellation = CancellationToken::new();
        let worker_token = cancellation.clone();
        let worker_repository = Arc::clone(&repository);
        let worker_path = path.clone();
        let (done, done_rx) = mpsc::channel();
        let operation_ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let worker_operation_ran = Arc::clone(&operation_ran);
        let worker = std::thread::spawn(move || {
            let result = worker_repository.delete_exclusive_cancellable(
                &test_target(&worker_path),
                &worker_token,
                || {
                    worker_operation_ran.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                },
            );
            done.send(result).unwrap();
        });

        let deadline = Instant::now() + DRAIN_START_TIMEOUT;
        while !repository.deletion_is_waiting(&target).unwrap() {
            assert!(
                Instant::now() < deadline,
                "delete never entered retirement wait"
            );
            std::thread::yield_now();
        }
        cancellation.cancel();
        assert!(matches!(
            done_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            Err(Error::Cancellation)
        ));
        worker.join().unwrap();
        assert!(!operation_ran.load(std::sync::atomic::Ordering::SeqCst));

        drop(active_read);
        repository.connection(&test_target(&path), None).unwrap();
        repository
            .delete_exclusive(&test_target(&path), || Ok(()))
            .unwrap();
    }

    #[test]
    fn delete_cancellation_during_connection_drain_unwinds() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let repository = DatabaseRepository::default();
        let (target, key, entry) = initialized_target_entry(&repository, &path);
        let held = entry.get_connection().unwrap();
        let cancellation = CancellationToken::new();
        let operation_ran = std::sync::atomic::AtomicBool::new(false);

        std::thread::scope(|scope| {
            let release_token = cancellation.clone();
            let release_connections = Arc::clone(&entry.connections);
            let started = spawn_after_release_delay(scope, move || {
                // Cancel only after deletion has begun draining connections.
                let deadline = Instant::now() + DRAIN_START_TIMEOUT;
                while !release_connections.snapshot().closed {
                    assert!(
                        Instant::now() < deadline,
                        "delete never entered connection drain"
                    );
                    std::thread::yield_now();
                }
                release_token.cancel();
            });

            let result = repository.delete_exclusive_cancellable(
                &target,
                &cancellation,
                || -> Result<(), Error> {
                    operation_ran.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                },
            );
            assert!(matches!(result, Err(Error::Cancellation)));
            assert!(started.elapsed() >= RELEASE_DELAY);
        });

        assert!(!operation_ran.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!repository
            .state
            .lock()
            .unwrap()
            .tombstones
            .contains(target.path()));
        assert!(!repository.state.lock().unwrap().entries.contains_key(&key));
        assert!(entry.leases.snapshot().closed);

        drop(held);
        assert!(repository.connection(&test_target(&path), None).is_ok());
    }

    #[test]
    fn retire_wait_timeout_unwinds_tombstone_and_retiring_flag() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let repository = DatabaseRepository::with_retire_wait(Duration::from_millis(200));
        let (target, key, _entry) = initialized_target_entry(&repository, &path);
        let held_lease = repository.connection(&target, None).unwrap();

        let result = repository.delete_exclusive(&target, || Ok(()));
        assert!(
            matches!(result, Err(Error::Conflict(ref message)) if message.contains("timed out")),
            "held lease must expire retire_and_wait: {result:?}"
        );

        let state = repository.state.lock().unwrap();
        assert!(
            !state.tombstones.contains(target.path()),
            "timeout must remove the deletion tombstone"
        );
        let entry = state
            .entries
            .get(&key)
            .expect("timeout must leave the entry in the repository")
            .clone();
        drop(state);
        assert!(
            !entry.leases.snapshot().closed,
            "timeout must clear the retiring flag"
        );

        drop(held_lease);
        repository.connection(&test_target(&path), None).unwrap();
        repository
            .delete_exclusive(&test_target(&path), || Ok(()))
            .unwrap();
    }

    fn initialized_target_entry(
        repository: &DatabaseRepository,
        path: &Path,
    ) -> (
        crate::infra::path_authority::DatabaseFileTarget,
        EntryKey,
        Arc<DatabaseEntry>,
    ) {
        let target = test_target(path);
        let mut setup = repository.initialization_connection(&target, None).unwrap();
        migrations::prepare_database(&mut setup, "title", "description").unwrap();
        drop(setup);
        repository.mark_schema_validated(&target).unwrap();
        drop(repository.connection(&target, None).unwrap());

        let key = entry_key(&target).unwrap();
        let entry = repository
            .state
            .lock()
            .unwrap()
            .entries
            .get(&key)
            .expect("initialized database entry")
            .clone();
        (target, key, entry)
    }

    #[test]
    fn retire_replaced_waits_until_every_pooled_connection_has_closed() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let repository = DatabaseRepository::default();
        let (_target, key, entry) = initialized_target_entry(&repository, &path);
        let first = entry.get_connection().unwrap();
        let second = entry.get_connection().unwrap();
        assert_eq!(entry.connections.snapshot().outstanding, 2);

        std::thread::scope(|scope| {
            let started = spawn_after_release_delay(scope, move || {
                drop(first);
                std::thread::sleep(RELEASE_DELAY);
                drop(second);
            });

            assert!(repository.retire_replaced(&key, &entry, None).is_ok());
            assert!(started.elapsed() >= RELEASE_DELAY * 2);
        });

        assert_eq!(entry.connections.snapshot().outstanding, 0);
        assert!(!repository.state.lock().unwrap().entries.contains_key(&key));
    }

    #[test]
    fn delete_waits_for_pooled_connections_before_unlinking() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let repository = DatabaseRepository::default();
        let (target, _key, entry) = initialized_target_entry(&repository, &path);
        let held = entry.get_connection().unwrap();

        std::thread::scope(|scope| {
            let started = spawn_after_release_delay(scope, move || drop(held));

            let result = repository
                .delete_exclusive(&target, || Ok(entry.connections.snapshot().outstanding));
            assert!(matches!(result, Ok(0)));
            assert!(started.elapsed() >= RELEASE_DELAY);
        });
    }

    #[test]
    fn delete_connection_drain_timeout_unwinds_and_drops_the_entry() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let repository = DatabaseRepository::with_retire_wait(Duration::from_millis(200));
        let (target, key, entry) = initialized_target_entry(&repository, &path);
        let held = entry.get_connection().unwrap();

        let result = repository.delete_exclusive(&target, || Ok(()));
        assert!(matches!(
            result,
            Err(Error::Conflict(message)) if message.contains("did not close")
        ));
        assert!(!repository
            .state
            .lock()
            .unwrap()
            .tombstones
            .contains(target.path()));
        assert!(!repository.state.lock().unwrap().entries.contains_key(&key));
        assert!(entry.leases.snapshot().closed);

        drop(held);
        let fresh = repository.connection(&test_target(&path), None);
        assert!(fresh.is_ok());
    }

    #[test]
    fn lru_evicts_the_least_recently_used_idle_entry() {
        let directory = tempfile::tempdir().unwrap();
        let repository = DatabaseRepository::default();

        for index in 0..=MAX_OPEN_DATABASES {
            let path = directory.path().join(format!("{index}.db3"));
            drop(
                repository
                    .initialization_connection(&test_target(&path), None)
                    .unwrap(),
            );
        }

        let state = repository.state.lock().unwrap();
        assert_eq!(state.entries.len(), MAX_OPEN_DATABASES);
        assert!(!state
            .entries
            .contains_key(&entry_key(&test_target(&directory.path().join("0.db3"))).unwrap()));
        assert!(state.entries.contains_key(
            &entry_key(&test_target(
                &directory.path().join(format!("{}.db3", MAX_OPEN_DATABASES))
            ))
            .unwrap()
        ));
    }

    #[test]
    fn acquire_refuses_a_retired_entry() {
        let directory = tempfile::tempdir().unwrap();
        let repository = DatabaseRepository::default();
        let (_target, _key, entry) =
            initialized_target_entry(&repository, &directory.path().join("database.db3"));

        entry.retire_and_wait(Duration::from_secs(1)).unwrap();

        assert!(matches!(
            entry.acquire(),
            Err(Error::Conflict(message)) if message == "database is being replaced or deleted"
        ));
    }

    #[test]
    fn production_generation_write_and_index_lock_waits_cancel_while_contended() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("database.db3");
        let repository = Arc::new(DatabaseRepository::default());
        let connection = repository
            .initialization_connection(&test_target(&path), None)
            .unwrap();
        drop(connection);
        let target = test_target(&path);
        let entry = repository.entry(&target, None).unwrap().1;

        for (name, held) in [
            ("write", entry.write_lock.lock()),
            ("index", entry.index_lock.lock()),
        ] {
            let cancellation = CancellationToken::new();
            let worker_token = cancellation.clone();
            let worker_repository = Arc::clone(&repository);
            let worker_path = path.clone();
            let (done_tx, done_rx) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || {
                let result = if name == "write" {
                    worker_repository.with_write_lock_cancellable(
                        &test_target(&worker_path),
                        &worker_token,
                        || Ok(()),
                    )
                } else {
                    worker_repository.with_index_lock_cancellable(
                        &test_target(&worker_path),
                        &worker_token,
                        || Ok(()),
                    )
                };
                let _ = done_tx.send(result);
            });
            cancellation.cancel();
            assert!(matches!(
                done_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
                Err(Error::Cancellation)
            ));
            worker.join().unwrap();
            drop(held);
        }
    }

    fn revision_fixture(initial: i64) -> (tempfile::TempDir, PathBuf, DatabaseRepository) {
        use diesel::connection::SimpleConnection;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("revision.db3");
        let mut connection = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        connection
            .batch_execute("CREATE TABLE Info (Name TEXT PRIMARY KEY, Value TEXT);")
            .unwrap();
        connection
            .batch_execute(&format!(
                "INSERT INTO Info (Name, Value) VALUES ('DataRevision', '{initial}');"
            ))
            .unwrap();
        drop(connection);
        (directory, path, DatabaseRepository::default())
    }

    #[cfg(unix)]
    #[test]
    fn identity_sandwich_rejects_object_swap() {
        let (directory, path, repository) = revision_fixture(0);
        let replacement = directory.path().join("replacement.db3");
        std::fs::write(&replacement, std::fs::read(&path).unwrap()).unwrap();
        let target = test_target(&path);
        let _hooks = configure_test_hooks(&path, {
            let path = path.clone();
            let replacement = replacement.clone();
            move |hooks| {
                hooks.after_probe_current = Some(Box::new(move |count| {
                    if count == 1 {
                        std::fs::rename(&replacement, &path).unwrap();
                    }
                }));
            }
        });
        assert!(matches!(
            repository.identity_from_probe(&target, &CancellationToken::new(), true),
            Err(Error::Conflict(_))
        ));
    }

    fn bump_file_revision(path: &Path) {
        let mut connection = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        connection
            .transaction::<_, Error, _>(|db| {
                crate::db::bump_revision_in_transaction(db, path, &CancellationToken::new(), |_| {
                    Ok(())
                })
            })
            .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn identity_sandwich_rejects_wal_revision_after_r1() {
        let (_directory, path, repository) = revision_fixture(0);
        let target = test_target(&path);
        let changed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let changed_callback = std::sync::Arc::clone(&changed);
        let _hooks = configure_test_hooks(path.clone(), move |hooks| {
            hooks.after_read_revision = Some(Box::new(move || {
                if !changed_callback.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    bump_file_revision(&path);
                }
            }));
        });
        assert!(matches!(
            repository.identity_from_probe(&target, &CancellationToken::new(), true),
            Err(Error::Conflict(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn identity_sandwich_rejects_wal_revision_after_r2() {
        let (_directory, path, repository) = revision_fixture(0);
        let target = test_target(&path);
        let reads = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let reads_callback = std::sync::Arc::clone(&reads);
        let _hooks = configure_test_hooks(path.clone(), move |hooks| {
            hooks.after_read_revision = Some(Box::new(move || {
                if reads_callback.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                    bump_file_revision(&path);
                }
            }));
        });
        assert!(matches!(
            repository.identity_from_probe(&target, &CancellationToken::new(), true),
            Err(Error::Conflict(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn identity_sandwich_rejects_object_swap_after_r3() {
        let (directory, path, repository) = revision_fixture(0);
        let replacement = directory.path().join("replacement.db3");
        std::fs::write(&replacement, std::fs::read(&path).unwrap()).unwrap();
        let target = test_target(&path);
        let _hooks = configure_test_hooks(&path, {
            let path = path.clone();
            move |hooks| {
                hooks.after_probe_current = Some(Box::new(move |count| {
                    if count == 3 {
                        std::fs::rename(&replacement, &path).unwrap();
                    }
                }));
            }
        });
        assert!(matches!(
            repository.identity_from_probe(&target, &CancellationToken::new(), true),
            Err(Error::Conflict(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn identity_sandwich_rejects_wal_revision_after_r3() {
        let (_directory, path, repository) = revision_fixture(0);
        let target = test_target(&path);
        let reads = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let reads_callback = std::sync::Arc::clone(&reads);
        let _hooks = configure_test_hooks(path.clone(), move |hooks| {
            hooks.after_read_revision = Some(Box::new(move || {
                if reads_callback.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 2 {
                    bump_file_revision(&path);
                }
            }));
        });
        assert!(matches!(
            repository.identity_from_probe(&target, &CancellationToken::new(), true),
            Err(Error::Conflict(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn identity_from_probe_observes_cancellation() {
        {
            let (_directory, path, repository) = revision_fixture(0);
            let target = test_target(&path);
            let cancellation = CancellationToken::new();
            cancellation.cancel();
            let probes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let observed_probes = std::sync::Arc::clone(&probes);
            let _hooks = configure_test_hooks(&path, |hooks| {
                hooks.after_probe_current = Some(Box::new(move |_| {
                    observed_probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }));
            });
            assert!(matches!(
                repository.identity_from_probe(&target, &cancellation, true),
                Err(Error::Cancellation)
            ));
            assert_eq!(probes.load(std::sync::atomic::Ordering::SeqCst), 0);
        }

        {
            let (_directory, path, repository) = revision_fixture(0);
            let target = test_target(&path);
            let cancellation = CancellationToken::new();
            let callback_token = cancellation.clone();
            let probes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let reads = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let observed_probes = std::sync::Arc::clone(&probes);
            let observed_reads = std::sync::Arc::clone(&reads);
            let _hooks = configure_test_hooks(&path, move |hooks| {
                hooks.after_probe_current = Some(Box::new(move |_| {
                    observed_probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }));
                hooks.after_read_revision = Some(Box::new(move || {
                    observed_reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    callback_token.cancel();
                }));
            });
            assert!(matches!(
                repository.identity_from_probe(&target, &cancellation, true),
                Err(Error::Cancellation)
            ));
            assert_eq!(probes.load(std::sync::atomic::Ordering::SeqCst), 1);
            assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 1);
        }

        {
            let (_directory, path, repository) = revision_fixture(0);
            let target = test_target(&path);
            let cancellation = CancellationToken::new();
            let reads = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let observed_reads = std::sync::Arc::clone(&reads);
            let callback_token = cancellation.clone();
            let _hooks = configure_test_hooks(&path, move |hooks| {
                hooks.after_read_revision = Some(Box::new(move || {
                    if observed_reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1 == 4 {
                        callback_token.cancel();
                    }
                }));
            });
            assert!(matches!(
                repository.identity_from_probe(&target, &cancellation, true),
                Err(Error::Cancellation)
            ));
            assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 4);
        }
    }

    #[cfg(unix)]
    #[test]
    fn identity_from_probe_cancels_during_read_data_revision() {
        let (_directory, path, repository) = revision_fixture(0);
        let target = test_target(&path);
        let cancellation = CancellationToken::new();
        let revisions = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = std::sync::Arc::clone(&revisions);
        let _hooks = configure_test_hooks(&path, move |hooks| {
            hooks.after_read_revision = Some(Box::new(move || {
                observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }));
        });
        let checkpoints =
            crate::db::sqlite_cancellation::cancel_on_callback(cancellation.clone(), 1);
        let _identity = repository.identity_from_probe(&target, &cancellation, true);
        assert!(checkpoints.load(std::sync::atomic::Ordering::SeqCst) > 0);
        assert!(matches!(_identity, Err(Error::Cancellation)));
        assert_eq!(revisions.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[cfg(unix)]
    #[test]
    fn identity_from_probe_hydrate_false_rejects_mid_probe_tombstone() {
        let (_directory, path, repository) = revision_fixture(0);
        let target = test_target(&path);
        let repository = std::sync::Arc::new(repository);
        let callback_repository = std::sync::Arc::clone(&repository);
        let callback_path = path.clone();
        let _hooks = configure_test_hooks(&path, move |hooks| {
            hooks.after_probe_current = Some(Box::new(move |count| {
                if count == 1 {
                    callback_repository
                        .state
                        .lock()
                        .unwrap()
                        .tombstones
                        .insert(callback_path.clone());
                }
            }));
        });
        assert!(matches!(
            repository.identity_from_probe(&target, &CancellationToken::new(), false),
            Err(Error::Conflict(message)) if message == "database is being deleted"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn identity_from_probe_hydrate_true_rejects_terminal_tombstone() {
        let (_directory, path, repository) = revision_fixture(0);
        let target = test_target(&path);
        let repository = std::sync::Arc::new(repository);
        let callback_repository = std::sync::Arc::clone(&repository);
        let callback_path = path.clone();
        let reads = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_reads = std::sync::Arc::clone(&reads);
        let _hooks = configure_test_hooks(&path, move |hooks| {
            hooks.after_read_revision = Some(Box::new(move || {
                if observed_reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1 == 4 {
                    let mut state = callback_repository.state.lock().unwrap();
                    state.tombstones.insert(callback_path.clone());
                }
            }));
        });
        assert!(matches!(
            repository.identity_from_probe(&target, &CancellationToken::new(), true),
            Err(Error::Conflict(message)) if message == "database is being deleted"
        ));
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 4);
    }

    #[test]
    fn read_data_revision_malformed_is_error() {
        for value in [None, Some("bad"), Some("-1"), Some("9223372036854775808")] {
            let mut connection = SqliteConnection::establish(":memory:").unwrap();
            diesel::connection::SimpleConnection::batch_execute(
                &mut connection,
                "CREATE TABLE Info (Name TEXT PRIMARY KEY, Value TEXT);",
            )
            .unwrap();
            match value {
                Some(value) => diesel::sql_query(format!(
                    "INSERT INTO Info (Name, Value) VALUES ('DataRevision', '{value}');"
                ))
                .execute(&mut connection)
                .unwrap(),
                None => diesel::sql_query(
                    "INSERT INTO Info (Name, Value) VALUES ('DataRevision', NULL);",
                )
                .execute(&mut connection)
                .unwrap(),
            };
            assert!(matches!(
                read_data_revision(&mut connection),
                Err(Error::InvalidInput(message))
                    if message == "DataRevision is not a non-negative i64"
            ));
        }
    }

    #[test]
    fn read_data_revision_missing_table_is_zero() {
        let mut connection = SqliteConnection::establish(":memory:").unwrap();
        assert_eq!(read_data_revision(&mut connection).unwrap(), 0);
    }

    #[test]
    fn read_data_revision_missing_row_is_zero() {
        let mut connection = SqliteConnection::establish(":memory:").unwrap();
        diesel::connection::SimpleConnection::batch_execute(
            &mut connection,
            "CREATE TABLE Info (Name TEXT PRIMARY KEY, Value TEXT);",
        )
        .unwrap();
        assert_eq!(read_data_revision(&mut connection).unwrap(), 0);
    }

    #[test]
    fn read_data_revision_puzzle_schema_without_info_is_zero() {
        let mut connection = SqliteConnection::establish(":memory:").unwrap();
        diesel::connection::SimpleConnection::batch_execute(
            &mut connection,
            "CREATE TABLE puzzles (id INTEGER PRIMARY KEY, fen TEXT, moves TEXT, rating INTEGER, rating_deviation INTEGER, popularity INTEGER, nb_plays INTEGER);",
        )
        .unwrap();
        assert_eq!(read_data_revision(&mut connection).unwrap(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn identity_from_probe_tombstone() {
        let (_directory, path, repository) = revision_fixture(0);
        let target = test_target(&path);
        let probes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_probes = std::sync::Arc::clone(&probes);
        let _hooks = configure_test_hooks(&path, |hooks| {
            hooks.after_probe_current = Some(Box::new(move |_| {
                observed_probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }));
        });
        repository
            .state
            .lock()
            .unwrap()
            .tombstones
            .insert(path.clone());
        assert!(matches!(
            repository.identity_from_probe(&target, &CancellationToken::new(), true),
            Err(Error::Conflict(message)) if message == "database is being deleted"
        ));
        assert_eq!(probes.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[test]
    fn data_changed_overflow_is_error() {
        let (_directory, _path, repository) = revision_fixture(i64::MAX);
        let target = test_target(&_path);
        let mut connection = repository.initialization_connection(&target, None).unwrap();
        let result = connection.transaction::<_, Error, _>(|db| {
            crate::db::bump_revision_in_transaction(db, &_path, &CancellationToken::new(), |_| {
                Ok(())
            })
        });
        assert!(matches!(
            result,
            Err(Error::InvalidInput(message)) if message == "DataRevision overflow"
        ));
        let mut check = SqliteConnection::establish(_path.to_str().unwrap()).unwrap();
        assert_eq!(read_data_revision(&mut check).unwrap(), i64::MAX as u64);
    }

    #[test]
    fn identity_from_probe_source_has_no_pool() {
        let source = include_str!("repository.rs");
        let body = source
            .split("pub(crate) fn identity_from_probe")
            .nth(1)
            .unwrap()
            .split("fn tombstone_conflict")
            .next()
            .unwrap();
        assert!(!body.contains("Pool::builder"));
        assert!(!body.contains("entry("));
        assert!(!body.contains("repository.connection("));
    }
}

#[cfg(test)]
mod bound_sqlite_witnesses {
    use super::*;
    use crate::{
        db::bound_sqlite::{BoundDatabase, SqliteMode},
        infra::path_authority::database_test_support::replace_parent_with_same_inode_hard_link,
    };
    use diesel::connection::SimpleConnection as _;
    use diesel::Connection as _;
    use rusqlite::Connection;
    use std::{
        collections::BTreeSet,
        ffi::OsStr,
        fs,
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
    };

    #[derive(Clone, Debug, Default, Eq, PartialEq)]
    struct SidecarListing {
        held: BTreeSet<String>,
        replacement: BTreeSet<String>,
    }

    struct ParentSwapGuard {
        path: PathBuf,
        held_parent: PathBuf,
    }

    impl ParentSwapGuard {
        fn replace(path: &Path) -> Self {
            let held_parent = replace_parent_with_same_inode_hard_link(path);
            Self {
                path: path.to_path_buf(),
                held_parent,
            }
        }

        fn listing(&self, leaf: &str) -> SidecarListing {
            SidecarListing {
                held: sidecar_listing(&self.held_parent, leaf),
                replacement: sidecar_listing(self.path.parent().expect("database parent"), leaf),
            }
        }

        fn restore(&mut self) {
            self.try_restore().expect("restore authorized parent");
        }

        fn try_restore(&mut self) -> std::io::Result<()> {
            let parent = self.path.parent().expect("database parent");
            if self.held_parent.exists() {
                let _ = fs::remove_dir_all(parent);
                fs::rename(&self.held_parent, parent)?;
            }
            Ok(())
        }
    }

    impl Drop for ParentSwapGuard {
        // Never panics: a panic here while a failing test unwinds aborts the whole test binary
        // and hides every result (Windows refuses to rename a directory with open files in it).
        fn drop(&mut self) {
            if let Err(error) = self.try_restore() {
                eprintln!("could not restore the authorized parent: {error}");
            }
        }
    }

    struct LeafSwapGuard {
        path: PathBuf,
        backup: PathBuf,
        replacement: PathBuf,
    }

    impl LeafSwapGuard {
        fn new(path: &Path, replacement: &Path) -> Self {
            let backup = path.with_file_name(format!(
                "{}.leaf-swap-original",
                path.file_name().expect("database leaf").to_string_lossy()
            ));
            Self {
                path: path.to_path_buf(),
                backup,
                replacement: replacement.to_path_buf(),
            }
        }

        fn swap_to_replacement(&mut self) {
            if self.backup.exists() {
                return;
            }
            fs::rename(&self.path, &self.backup).expect("move authorized database aside");
            fs::hard_link(&self.replacement, &self.path).expect("link replacement database");
        }

        fn restore(&mut self) {
            self.try_restore()
                .expect("restore authorized database leaf");
        }

        fn try_restore(&mut self) -> std::io::Result<()> {
            if self.backup.exists() {
                let _ = fs::remove_file(&self.path);
                fs::rename(&self.backup, &self.path)?;
            }
            Ok(())
        }
    }

    impl Drop for LeafSwapGuard {
        // Never panics, for the same reason as `ParentSwapGuard`.
        fn drop(&mut self) {
            if let Err(error) = self.try_restore() {
                eprintln!("could not restore the authorized database leaf: {error}");
            }
        }
    }

    fn sidecar_listing(parent: &Path, leaf: &str) -> BTreeSet<String> {
        let names = [
            format!("{leaf}-wal"),
            format!("{leaf}-shm"),
            format!("{leaf}-journal"),
        ];
        fs::read_dir(parent)
            .expect("list database parent")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|entry| names.iter().any(|name| name == entry))
            .collect()
    }

    fn seed_database(path: &Path, revision: i64, journal_mode: &str) {
        let connection = Connection::open(path).expect("open database fixture");
        connection
            .execute_batch(&format!(
                "PRAGMA journal_mode = {journal_mode};\
                 CREATE TABLE Info (Name TEXT PRIMARY KEY, Value TEXT);\
                 INSERT INTO Info (Name, Value) VALUES ('DataRevision', '{revision}');"
            ))
            .expect("seed database fixture");
    }

    fn read_revision_from_plain_path(path: &Path) -> u64 {
        let connection = Connection::open(path).expect("open fixture to inspect revision");
        connection
            .query_row(
                "SELECT CAST(Value AS INTEGER) FROM Info WHERE Name = 'DataRevision'",
                [],
                |row| row.get(0),
            )
            .expect("read fixture revision")
    }

    fn journal_mode(path: &Path) -> String {
        let connection = Connection::open(path).expect("open fixture to inspect journal mode");
        connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("read fixture journal mode")
    }

    fn new_database_parent(root: &Path) -> PathBuf {
        let parent = root.join("authorized");
        fs::create_dir(&parent).expect("create database parent");
        parent
    }

    // SQLite's WALINDEX_LOCK_OFFSET and SQLITE_SHM_NLOCK.
    #[cfg(unix)]
    const WAL_INDEX_LOCK_OFFSET: i64 = 120;
    #[cfg(unix)]
    const WAL_INDEX_LOCK_SLOTS: i64 = 8;

    #[cfg(unix)]
    fn sqlite_shared_read_lock_query() -> libc::flock {
        const PENDING_BYTE: libc::off_t = 0x4000_0000;
        const SHARED_FIRST: libc::off_t = PENDING_BYTE + 2;
        const SHARED_SIZE: libc::off_t = 510;

        let mut query: libc::flock = unsafe { std::mem::zeroed() };
        query.l_type = libc::F_WRLCK as _;
        query.l_whence = libc::SEEK_SET as _;
        query.l_start = SHARED_FIRST;
        query.l_len = SHARED_SIZE;
        query.l_pid = 0;
        query
    }

    #[cfg(unix)]
    pub(super) fn assert_sqlite_shared_read_lock_is_held(probe: &fs::File) {
        assert!(
            sqlite_shared_read_lock_is_held(probe),
            "SQLite shared read lock absent"
        );
    }

    #[cfg(unix)]
    fn sqlite_shared_read_lock_is_held(probe: &fs::File) -> bool {
        native_lock_is_held(probe, sqlite_shared_read_lock_query())
    }

    #[cfg(unix)]
    fn native_lock_is_held(probe: &impl std::os::fd::AsRawFd, mut lock: libc::flock) -> bool {
        let probe_fd = probe.as_raw_fd();
        let child = unsafe { libc::fork() };
        assert!(child >= 0, "fork lock observer");
        if child == 0 {
            let result = unsafe { libc::fcntl(probe_fd, libc::F_GETLK, &mut lock) };
            let status = if result != 0 {
                2
            } else if lock.l_type != libc::F_UNLCK as libc::c_short {
                0
            } else {
                1
            };
            unsafe { libc::_exit(status) };
        }

        let mut status = 0;
        let waited = unsafe { libc::waitpid(child, &mut status, 0) };
        assert_eq!(waited, child, "wait for lock observer");
        assert!(
            libc::WIFEXITED(status),
            "lock observer did not exit normally"
        );
        assert!(libc::WEXITSTATUS(status) <= 1, "F_GETLK observer failed");
        libc::WEXITSTATUS(status) == 0
    }

    #[cfg(target_os = "linux")]
    use crate::infra::inode_ownership::open_descriptor_count;

    #[cfg(target_os = "linux")]
    fn assert_final_release_closed_descriptors(identity: (u64, u64), diagnostic: &str) {
        crate::infra::inode_ownership::FINAL_RELEASE_COUNTS.with(|counts| {
            let counts = counts.borrow();
            let final_count = counts
                .iter()
                .rev()
                .find(|(released, _)| *released == identity)
                .expect("final release observation");
            assert_eq!(final_count.1, 0, "{diagnostic}");
        });
    }

    #[cfg(unix)]
    fn sqlite_shm_lock_query() -> libc::flock {
        let mut query: libc::flock = unsafe { std::mem::zeroed() };
        query.l_type = libc::F_WRLCK as _;
        query.l_whence = libc::SEEK_SET as _;
        query.l_start = WAL_INDEX_LOCK_OFFSET as _;
        query.l_len = WAL_INDEX_LOCK_SLOTS as _;
        query
    }

    #[cfg(unix)]
    fn bound_wal_reader(
        bound: &BoundDatabase,
    ) -> rusqlite::Result<crate::db::bound_sqlite::BoundConnection<Connection>> {
        let lifetime = bound.connection_lifetime().unwrap();
        Connection::open_with_flags(
            bound.uri(SqliteMode::ReadWrite).unwrap(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .map(|reader| lifetime.wrap(reader))
        .and_then(|reader| {
            reader.execute_batch("BEGIN; SELECT Value FROM Info;")?;
            Ok(reader)
        })
    }

    #[cfg(unix)]
    fn assert_descriptors_have_identity(fds: &[libc::c_int], identity: (u64, u64)) {
        use crate::infra::fs::raw_libc_stat_identity;

        assert!(!fds.is_empty(), "expected retained descriptors");
        for fd in fds {
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            assert_eq!(unsafe { libc::fstat(*fd, stat.as_mut_ptr()) }, 0);
            assert_eq!(
                raw_libc_stat_identity(unsafe { &stat.assume_init() }),
                identity,
                "retained descriptor names another inode"
            );
        }
    }

    #[cfg(unix)]
    fn lock_plain_database(path: &Path) -> (fs::File, Connection) {
        let probe = fs::File::open(path).expect("open database inode for lock probe");
        let reader = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("open database reader");
        reader
            .execute_batch("BEGIN;")
            .expect("begin read transaction");
        reader
            .query_row(
                "SELECT Value FROM Info WHERE Name='DataRevision'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("take SQLite shared read lock");
        (probe, reader)
    }

    #[cfg(unix)]
    fn ownership_repository(
        path: &Path,
    ) -> (
        DatabaseRepository,
        crate::infra::path_authority::DatabaseFileTarget,
        fs::File,
        DatabaseConnection,
    ) {
        let repository = DatabaseRepository::default();
        let target = test_target(path);
        let mut connection = repository.initialization_connection(&target, None).unwrap();
        migrations::prepare_database(&mut connection, "ownership witness", "").unwrap();
        let probe = fs::File::open(path).unwrap();
        connection
            .batch_execute("BEGIN; SELECT Value FROM Info WHERE Name='DataRevision';")
            .unwrap();
        assert_sqlite_shared_read_lock_is_held(&probe);
        (repository, target, probe, connection)
    }

    #[cfg(unix)]
    #[test]
    fn cross_capability_expired_registration_uses_the_same_admission_liveness() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("expired.db3");
        let (repository, target, probe, connection) = ownership_repository(&path);
        let (entered, entry) = std::sync::mpsc::channel();
        let (resume, resumed) = std::sync::mpsc::channel();
        crate::db::bound_sqlite::set_registration_drop_hook(&target, move || {
            entered.send(()).unwrap();
            let _ = resumed.recv_timeout(Duration::from_secs(10));
        });
        drop(connection);
        std::thread::scope(|scope| {
            scope.spawn(move || drop(repository));
            entry.recv_timeout(Duration::from_secs(10)).unwrap();
            assert!(
                !sqlite_shared_read_lock_is_held(&probe),
                "all SQLite connections must be closed before registration removal"
            );
            let ordinary = crate::infra::fs::open_regular_at(
                target.parent(),
                target.leaf(),
                crate::infra::fs::RegularFileAccess::ReadOnly,
            );
            assert!(
                matches!(ordinary, Err(Error::Conflict(_))),
                "a retiring primary must exclude ordinary opens until its pin closes"
            );
            resume.send(()).unwrap();
        });
        drop(probe);
        drop(BoundDatabase::acquire(&target).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn primary_pin_final_close_serializes_successor_and_preserves_its_runtime_lock() {
        let name = "db::repository::bound_sqlite_witnesses::primary_pin_final_close_serializes_successor_and_preserves_its_runtime_lock";
        crate::db::test_support::run_isolated(name, || {
            use crate::infra::inode_ownership::{PRIMARY_CLOSE_BARRIERS, REGISTRY};
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("primary-successor.db3");
            seed_database(&path, 1, "DELETE");
            let target = test_target(&path);
            let probe = fs::File::open(&path).unwrap();
            let predecessor = BoundDatabase::acquire(&target).unwrap();
            let entered = Arc::new(std::sync::Barrier::new(2));
            let resume = Arc::new(std::sync::Barrier::new(2));
            let (started, start) = std::sync::mpsc::channel();
            let (locked, lock) = std::sync::mpsc::channel();
            let (release, released) = std::sync::mpsc::channel();
            std::thread::scope(|scope| {
                let entered_close = Arc::clone(&entered);
                let resume_close = Arc::clone(&resume);
                let closer = scope.spawn(move || {
                    PRIMARY_CLOSE_BARRIERS
                        .with(|slot| *slot.borrow_mut() = Some((entered_close, resume_close)));
                    drop(predecessor);
                });
                entered.wait();
                // Exercise both schedules. A faulty unlocked close lets the successor take locks
                // before we release the predecessor, so the final runtime lock assertion detects it.
                let serialized = matches!(
                    REGISTRY.get().unwrap().try_lock(),
                    Err(std::sync::TryLockError::WouldBlock)
                );
                let target = &target;
                scope.spawn(move || {
                    started.send(()).unwrap();
                    let successor = BoundDatabase::acquire(target).unwrap();
                    let reader = bound_wal_reader(&successor).unwrap();
                    locked.send(()).unwrap();
                    released.recv_timeout(Duration::from_secs(10)).unwrap();
                    drop(reader);
                    drop(successor);
                });
                start.recv_timeout(Duration::from_secs(10)).unwrap();
                if serialized {
                    resume.wait();
                    closer.join().unwrap();
                    lock.recv_timeout(Duration::from_secs(10)).unwrap();
                } else {
                    let result = lock.recv_timeout(Duration::from_secs(10));
                    resume.wait();
                    closer.join().unwrap();
                    result.unwrap();
                }
                let held = sqlite_shared_read_lock_is_held(&probe);
                release.send(()).unwrap();
                assert!(
                    held,
                    "predecessor primary pin close released the successor SQLite lock"
                );
                assert!(
                    serialized,
                    "primary pin close must exclude successor admission"
                );
            });
        });
    }

    #[cfg(unix)]
    #[test]
    fn primary_pin_reuse_and_rejected_candidates_preserve_live_sqlite_locks() {
        let name = "db::repository::bound_sqlite_witnesses::primary_pin_reuse_and_rejected_candidates_preserve_live_sqlite_locks";
        crate::db::test_support::run_isolated(name, || {
            use crate::infra::inode_ownership::{PRIMARY_PIN_TEST_CONTROLS, REGISTRY};
            let root = tempfile::tempdir().unwrap();
            let live_path = root.path().join("locked-primary.db3");
            seed_database(&live_path, 1, "DELETE");
            let live_target = test_target(&live_path);
            let probe = fs::File::open(&live_path).unwrap();
            let bound = BoundDatabase::acquire(&live_target).unwrap();
            let reader = bound_wal_reader(&bound).unwrap();
            for _ in 0..3 {
                let reused = BoundDatabase::acquire(&live_target).unwrap();
                assert_eq!(bound.token(), reused.token());
                drop(reused);
                assert_sqlite_shared_read_lock_is_held(&probe);
            }
            let path = root.path().join("candidate.db3");
            fs::write(&path, b"candidate").unwrap();
            let candidate = test_target(&path);
            let swap = path.clone();
            let live = live_path.clone();
            PRIMARY_PIN_TEST_CONTROLS.with(|controls| {
                controls.borrow_mut().after_identify = Some(Box::new(move || {
                    fs::remove_file(&swap).unwrap();
                    fs::hard_link(live, swap).unwrap();
                }))
            });
            assert!(matches!(
                BoundDatabase::acquire(&candidate),
                Err(Error::Conflict(_))
            ));
            assert!(!crate::db::bound_sqlite::has_binding_for_test(&candidate));
            assert_sqlite_shared_read_lock_is_held(&probe);
            #[cfg(not(target_os = "linux"))]
            {
                let registry = REGISTRY.get().unwrap().lock().unwrap();
                assert_eq!(
                    registry.quarantined_descriptors[&live_target.identity()].len(),
                    1
                );
            }
            fs::remove_file(&path).unwrap();
            fs::write(&path, b"unclassified candidate").unwrap();
            let candidate = test_target(&path);
            PRIMARY_PIN_TEST_CONTROLS
                .with(|controls| controls.borrow_mut().inspect_error = Some(libc::EIO));
            assert!(
                matches!(BoundDatabase::acquire(&candidate), Err(Error::Io(error)) if error.raw_os_error() == Some(libc::EIO))
            );
            assert!(!crate::db::bound_sqlite::has_binding_for_test(&candidate));
            assert_sqlite_shared_read_lock_is_held(&probe);
            #[cfg(not(target_os = "linux"))]
            {
                let registry = REGISTRY.get().unwrap().lock().unwrap();
                assert_eq!(registry.unclassified_descriptors.len(), 1);
            }
            drop(reader);
            drop(bound);
            let registry = REGISTRY.get().unwrap().lock().unwrap();
            assert!(registry.quarantined_descriptors.is_empty());
            assert!(registry.unclassified_descriptors.is_empty());
        });
    }

    #[cfg(unix)]
    #[test]
    fn cross_capability_sidecar_handoff_keeps_shm_locks_and_releases_at_last_connection() {
        use crate::infra::path_authority::{DatabaseHandle, PathAuthority, PathOperation};
        use std::os::fd::FromRawFd;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("owner.db3");
        seed_database(&path, 1, "DELETE");
        let target = test_target(&path);
        let bound = BoundDatabase::acquire(&target).unwrap();
        let first = bound.connection_lifetime().unwrap().wrap(
            Connection::open_with_flags(
                bound.uri(SqliteMode::ReadWrite).unwrap(),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_URI,
            )
            .unwrap(),
        );
        first.execute_batch("PRAGMA journal_mode=WAL; UPDATE Info SET Value='2' WHERE Name='DataRevision'; BEGIN; SELECT Value FROM Info;").unwrap();
        let shm = root.path().join("owner.db3-shm");
        let alias = root.path().join("shm-alias.db3");
        fs::hard_link(&shm, &alias).unwrap();
        let mut authority =
            PathAuthority::open(root.path().join("authority.json"), vec![]).unwrap();
        let handle = DatabaseHandle::new(
            authority
                .grant_persistent_file_for_test(
                    &alias,
                    "sidecar alias",
                    vec![PathOperation::DatabaseRead],
                )
                .id,
        );
        let sidecar_target = authority
            .database_file_target(&handle, PathOperation::DatabaseRead)
            .unwrap();
        let query = sqlite_shm_lock_query();
        let native =
            crate::db::bound_sqlite::open_bound_sidecar_for_test(&bound, "-shm", libc::O_RDONLY)
                .unwrap();
        let probe = unsafe { fs::File::from_raw_fd(native) };
        assert!(
            native_lock_is_held(&probe, query),
            "handoff must not close a fresh descriptor of SQLite's locked SHM inode"
        );
        let second = bound.connection_lifetime().unwrap().wrap(
            Connection::open_with_flags(
                bound.uri(SqliteMode::ReadWrite).unwrap(),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_URI,
            )
            .unwrap(),
        );
        second
            .execute_batch("BEGIN; SELECT Value FROM Info;")
            .unwrap();
        assert!(matches!(
            BoundDatabase::acquire(&sidecar_target),
            Err(Error::Conflict(_))
        ));
        drop(first);
        assert!(
            native_lock_is_held(&probe, query),
            "one surviving connection retains SHM locks"
        );
        assert!(matches!(
            BoundDatabase::acquire(&sidecar_target),
            Err(Error::Conflict(_))
        ));
        #[cfg(target_os = "linux")]
        let shm_identity = crate::infra::path_authority::opened_file_identity(&probe).unwrap();
        drop(probe);
        drop(second);
        #[cfg(target_os = "linux")]
        assert_final_release_closed_descriptors(
            shm_identity,
            "sidecar descriptor must close before final release",
        );
        drop(BoundDatabase::acquire(&sidecar_target).unwrap());
        assert!(
            matches!(
                crate::infra::fs::open_regular_at(
                    target.parent(),
                    target.leaf(),
                    crate::infra::fs::RegularFileAccess::ReadOnly
                ),
                Err(Error::Conflict(_))
            ),
            "the idle primary binding remains an incompatible holder"
        );
        drop(bound);
    }

    #[cfg(unix)]
    #[test]
    fn cross_capability_shm_alias_refuses_capability_after_wal_reader() {
        use crate::infra::fs::{open_regular_at, RegularFileAccess};
        use std::os::fd::FromRawFd;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("shm-owner.db3");
        seed_database(&path, 1, "WAL");
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        let mut reader = repository.initialization_connection(&target, None).unwrap();
        reader
            .batch_execute("BEGIN; SELECT Value FROM Info;")
            .unwrap();
        let shm = root.path().join("shm-owner.db3-shm");
        let alias = root.path().join("alias.pgn");
        fs::hard_link(&shm, &alias).unwrap();
        let bound = BoundDatabase::acquire(&target).unwrap();
        let native =
            crate::db::bound_sqlite::open_bound_sidecar_for_test(&bound, "-shm", libc::O_RDONLY)
                .unwrap();
        let probe = unsafe { fs::File::from_raw_fd(native) };
        assert!(native_lock_is_held(&probe, sqlite_shm_lock_query()));
        let attempt = open_regular_at(
            target.parent(),
            alias.file_name().unwrap(),
            RegularFileAccess::ReadOnly,
        );
        assert!(
            matches!(attempt, Err(Error::Conflict(_))),
            "capability alias of live SHM must be refused"
        );
        assert!(native_lock_is_held(&probe, sqlite_shm_lock_query()));
        drop(attempt);
        assert!(
            native_lock_is_held(&probe, sqlite_shm_lock_query()),
            "refusal cleanup must preserve SHM locks"
        );
        drop(probe);
        drop(reader);
        drop(repository);
        drop(bound);
    }

    #[cfg(unix)]
    #[test]
    fn cross_capability_shm_alias_refuses_wal_after_capability_owner() {
        use crate::infra::fs::{open_regular_at, RegularFileAccess};
        use std::os::fd::AsRawFd;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("shm-successor.db3");
        seed_database(&path, 1, "WAL");
        let target = test_target(&path);
        let alias = root.path().join("alias.pgn");
        fs::write(&alias, b"").unwrap();
        let capability = open_regular_at(
            target.parent(),
            alias.file_name().unwrap(),
            RegularFileAccess::ReadOnly,
        )
        .unwrap();
        let fd = capability.as_raw_fd();
        fs::hard_link(&alias, root.path().join("shm-successor.db3-shm")).unwrap();
        let bound = BoundDatabase::acquire(&target).unwrap();
        let attempt = bound_wal_reader(&bound);
        assert!(
            attempt.is_err(),
            "WAL open must refuse an existing capability owner of SHM"
        );
        assert!(
            bound.refusal_count() > 0,
            "SHM sidecar admission must record the refusal"
        );
        assert!(
            unsafe { libc::fcntl(fd, libc::F_GETFD) } >= 0,
            "refused sidecar must leave capability descriptor open"
        );
        drop(attempt);
        drop(capability);
        let retry = bound_wal_reader(&bound).unwrap();
        drop(retry);
        drop(bound);
    }

    #[cfg(unix)]
    #[test]
    fn cross_capability_shm_alias_refuses_another_registration_and_preserves_locks() {
        use std::os::fd::FromRawFd;
        let root = tempfile::tempdir().unwrap();
        let first_path = root.path().join("first-domain.db3");
        let second_path = root.path().join("second-domain.db3");
        seed_database(&first_path, 1, "WAL");
        seed_database(&second_path, 2, "WAL");
        let first_target = test_target(&first_path);
        let second_target = test_target(&second_path);
        assert_ne!(first_target.identity(), second_target.identity());
        let first = BoundDatabase::acquire(&first_target).unwrap();
        let first_reader = bound_wal_reader(&first).unwrap();
        let first_shm = root.path().join("first-domain.db3-shm");
        fs::hard_link(&first_shm, root.path().join("second-domain.db3-shm")).unwrap();
        let native =
            crate::db::bound_sqlite::open_bound_sidecar_for_test(&first, "-shm", libc::O_RDONLY)
                .unwrap();
        let probe = unsafe { fs::File::from_raw_fd(native) };
        assert!(native_lock_is_held(&probe, sqlite_shm_lock_query()));
        let second = BoundDatabase::acquire(&second_target).unwrap();
        assert_ne!(first.token(), second.token());
        let attempt = bound_wal_reader(&second);
        assert!(
            attempt.is_err(),
            "another registration must not share the locked SHM inode"
        );
        assert!(
            second.refusal_count() > 0,
            "SHM domain conflict must record a refusal"
        );
        assert!(
            native_lock_is_held(&probe, sqlite_shm_lock_query()),
            "refused WAL open must preserve the first registration's SHM locks"
        );
        drop(attempt);
        drop(second);
        assert!(
            native_lock_is_held(&probe, sqlite_shm_lock_query()),
            "refusal cleanup must preserve the first registration's SHM locks"
        );
        drop(probe);
        drop(first_reader);
        drop(first);
        let retry = BoundDatabase::acquire(&second_target).unwrap();
        drop(bound_wal_reader(&retry).unwrap());
        drop(retry);
    }

    #[cfg(unix)]
    #[test]
    fn cross_capability_resolved_consumers_preserve_repository_locks_in_both_orders() {
        use crate::infra::path_authority::{
            EngineHandle, EngineImageHandle, EngineResourceHandle, EngineResourceHandleKind,
            OpeningBookHandle, PathAuthority, PathOperation as Op, SharedPathAuthority,
        };
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("locked.db3");
        let alias = root.path().join("hard-link.db3");
        let (repository, target, probe, connection) = ownership_repository(&path);
        fs::hard_link(&path, &alias).unwrap();
        let independent = root.path().join("independent");
        fs::write(&independent, b"[Event \"independent\"]\n\n1. e4 *\n").unwrap();
        for operation in [
            Op::PuzzleRead,
            Op::PuzzleDelete,
            Op::ReadPgn,
            Op::WritePgn,
            Op::EngineExecute,
            Op::EngineResourceRead,
            Op::OpeningBookRead,
            Op::ImageRead,
            Op::DownloadFile,
        ] {
            for selected in [&path, &alias, &independent] {
                let mut authority =
                    PathAuthority::open(root.path().join("authority.json"), vec![]).unwrap();
                let grant = authority
                    .grant_persistent_file_for_test(selected, "picked file", vec![operation])
                    .id;
                let result = match operation {
                    Op::PuzzleRead | Op::PuzzleDelete => {
                        let shared = SharedPathAuthority::installed(authority);
                        crate::puzzle::resolve_puzzle_with_authority(&shared, &grant, operation)
                            .map(|_| ())
                    }
                    Op::EngineExecute => authority
                        .engine_executable(&EngineHandle::new(grant), operation)
                        .map(|_| ()),
                    Op::EngineResourceRead => authority
                        .engine_resource(&EngineResourceHandle::new(
                            grant,
                            EngineResourceHandleKind::File,
                            "resource".into(),
                        ))
                        .map(|_| ()),
                    Op::OpeningBookRead => authority
                        .opening_book_descriptor(&OpeningBookHandle::new(grant))
                        .map(|_| ()),
                    Op::ImageRead => {
                        let shared = SharedPathAuthority::uninitialized();
                        shared.install(authority).unwrap();
                        crate::infra::path_authority::engine_image_reader_for(
                            &shared,
                            &EngineImageHandle::new(grant),
                            usize::MAX,
                        )
                        .map(|_| ())
                    }
                    _ => authority.resolve(&grant, operation, &[]).map(|_| ()),
                };
                assert_sqlite_shared_read_lock_is_held(&probe);
                if selected == &independent {
                    assert!(result.is_ok(), "independent {operation:?}: {result:?}");
                } else {
                    assert!(
                        matches!(result, Err(Error::Conflict(_))),
                        "alias {operation:?}: {result:?}"
                    );
                }
            }
        }
        drop(connection);
        drop(repository);
        drop(probe);
        for operation in [
            Op::PuzzleRead,
            Op::PuzzleDelete,
            Op::ReadPgn,
            Op::WritePgn,
            Op::EngineExecute,
            Op::EngineResourceRead,
            Op::OpeningBookRead,
            Op::ImageRead,
            Op::DownloadFile,
        ] {
            for selected in [&path, &alias] {
                let mut authority =
                    PathAuthority::open(root.path().join("reverse-authority.json"), vec![])
                        .unwrap();
                let grant = authority
                    .grant_persistent_file_for_test(selected, "picked alias", vec![operation])
                    .id;
                let ordinary = authority.resolve(&grant, operation, &[]).unwrap();
                assert!(
                    matches!(BoundDatabase::acquire(&target), Err(Error::Conflict(_))),
                    "reverse {operation:?}"
                );
                drop(ordinary);
                drop(BoundDatabase::acquire(&target).unwrap());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn cross_capability_sidecar_consumers_preserve_repository_locks() {
        use crate::db::search_index::{
            integrity_stamp_leaf, legacy_sidecar_leaf, preferred_sidecar_leaf, IndexSource,
        };
        use crate::infra::path_authority::{PathAuthority, PathClass, PathOperation};
        for hard_link in [false, true] {
            for family in [
                "preferred",
                "legacy",
                "integrity",
                "metadata",
                "workspace-file",
                "sqlite-wal",
                "sqlite-shm",
                "sqlite-journal",
            ] {
                let root = tempfile::tempdir().unwrap();
                let owner = root.path().join("owner.db3");
                let owner_target = test_target(&owner);
                let leaf = match family {
                    "preferred" => preferred_sidecar_leaf(owner_target.leaf()),
                    "legacy" => legacy_sidecar_leaf(owner_target.leaf()),
                    "integrity" => integrity_stamp_leaf(owner_target.leaf()),
                    "metadata" => crate::infra::path_authority::workspace_sidecar_leaf(OsStr::new(
                        "workspace.pgn",
                    ))
                    .unwrap(),
                    "workspace-file" => "workspace.pgn".into(),
                    suffix => format!("owner.db3-{}", suffix.trim_start_matches("sqlite-")).into(),
                };
                let sidecar = root.path().join(&leaf);
                let locked = if hard_link {
                    root.path().join("locked.db3")
                } else {
                    sidecar.clone()
                };
                let (repository, locked_target, probe, connection) = ownership_repository(&locked);
                if hard_link {
                    fs::hard_link(&locked, &sidecar).unwrap();
                }
                let source = IndexSource::from_database_identity(
                    &repository.database_identity(&locked_target).unwrap(),
                )
                .unwrap();
                let result = match family {
                    "preferred" => {
                        crate::db::search::ownership_preferred_probe(&owner_target, &source)
                    }
                    "legacy" => crate::db::search_index::probe_legacy_index_sidecar_at(
                        owner_target.parent(),
                        &leaf,
                        &source,
                        None,
                    )
                    .map(|_| ()),
                    "integrity" => {
                        crate::db::content_validation::ownership_stamp_probe(&owner_target)
                    }
                    "workspace-file" => crate::file_workspace::count_installed_workspace_pgn(
                        owner_target.parent(),
                        &leaf,
                        locked_target.identity(),
                        &crate::pgn::PgnRepository::default(),
                        &CancellationToken::new(),
                    )
                    .map(|_| ()),
                    "metadata" => {
                        fs::write(
                            root.path().join("workspace.pgn"),
                            b"[Event \"workspace\"]\n\n*\n",
                        )
                        .unwrap();
                        let mut authority =
                            PathAuthority::open(root.path().join("authority.json"), vec![])
                                .unwrap();
                        let grant = authority
                            .grant_dialog(
                                root.path(),
                                "workspace",
                                PathClass::SingleDialogGrant,
                                PathOperation::ReadPgn,
                                Duration::from_secs(30),
                                1,
                            )
                            .unwrap();
                        let directory = authority
                            .capability_directory(&grant, PathOperation::ReadPgn)
                            .unwrap();
                        let entry = directory
                            .entries(&CancellationToken::new(), &mut |name| {
                                name == OsStr::new("workspace.pgn")
                            })
                            .unwrap()
                            .pop()
                            .unwrap();
                        crate::file_workspace::metadata_from(&directory, &entry).map(|_| ())
                    }
                    suffix => {
                        let owner_binding = BoundDatabase::acquire(&owner_target).unwrap();
                        let suffix = format!("-{}", suffix.trim_start_matches("sqlite-"));
                        let result = crate::db::bound_sqlite::open_bound_sidecar_for_test(
                            &owner_binding,
                            &suffix,
                            libc::O_RDONLY,
                        );
                        assert_eq!(result, Err(libc::ESTALE));
                        Err(Error::Conflict("sidecar ownership refused".into()))
                    }
                };
                assert!(
                    matches!(result, Err(Error::Conflict(_))),
                    "{family}, hard link={hard_link}: {result:?}"
                );
                assert_sqlite_shared_read_lock_is_held(&probe);
                drop(connection);
                drop(repository);
                drop(probe);
                let ordinary = crate::infra::fs::open_regular_at(
                    owner_target.parent(),
                    &leaf,
                    crate::infra::fs::RegularFileAccess::ReadOnly,
                )
                .unwrap();
                assert!(matches!(
                    BoundDatabase::acquire(&locked_target),
                    Err(Error::Conflict(_))
                ));
                drop(ordinary);
                drop(BoundDatabase::acquire(&locked_target).unwrap());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn cross_capability_pgn_import_export_entry_points_preserve_repository_locks() {
        use crate::infra::path_authority::{
            DatabaseHandle, FileWorkspaceHandle, PathAuthority, PathOperation as Op,
            SharedPathAuthority,
        };
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("locked.db3");
        let (repository, _target, probe, connection) = ownership_repository(&path);
        let alias = root.path().join("alias.pgn");
        fs::hard_link(&path, &alias).unwrap();
        let independent = root.path().join("independent.pgn");
        fs::write(&independent, b"[Event \"independent\"]\n\n1. e4 *\n").unwrap();
        let other_database = root.path().join("import.db3");
        drop(test_target(&other_database));
        let app = tauri::test::mock_app();
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events![crate::db::ConvertProgress])
            .mount_events(&app);
        let cache = crate::SearchCache::default();
        let mut authority =
            PathAuthority::open(root.path().join("authority.json"), vec![]).unwrap();
        let protected = DatabaseHandle::new(
            authority
                .grant_persistent_file_for_test(&path, "locked database", vec![Op::DatabaseExport])
                .id,
        );
        let destination = DatabaseHandle::new(
            authority
                .grant_persistent_file_for_test(
                    &other_database,
                    "import database",
                    vec![Op::DatabaseCreate],
                )
                .id,
        );
        let mut cases = Vec::new();
        for selected in [&path, &alias, &independent] {
            let input = FileWorkspaceHandle::new(
                authority
                    .grant_persistent_file_for_test(selected, "source.pgn", vec![Op::ReadPgn])
                    .id,
            );
            let output = FileWorkspaceHandle::new(
                authority
                    .grant_persistent_file_for_test(selected, "output.pgn", vec![Op::WritePgn])
                    .id,
            );
            cases.push((selected == &independent, input, output));
        }
        let shared = SharedPathAuthority::installed(authority);
        for (independent, input, output) in cases {
            let imported = crate::db::convert_pgn_blocking(
                &shared,
                &repository,
                &cache,
                vec![input],
                destination.clone(),
                None,
                app.handle().clone(),
                "import".into(),
                None,
                "ownership-import".into(),
                &CancellationToken::new(),
            );
            assert_sqlite_shared_read_lock_is_held(&probe);
            let exported = crate::db::export_to_pgn_blocking(
                &shared,
                &repository,
                protected.clone(),
                output,
                &CancellationToken::new(),
            );
            assert_sqlite_shared_read_lock_is_held(&probe);
            if independent {
                assert!(imported.is_ok(), "independent import: {imported:?}");
                assert!(exported.is_ok(), "independent export: {exported:?}");
            } else {
                assert!(
                    matches!(imported, Err(Error::Conflict(_))),
                    "import alias: {imported:?}"
                );
                assert!(
                    matches!(exported, Err(Error::Conflict(_))),
                    "export alias: {exported:?}"
                );
            }
        }
        drop(connection);
        drop(repository);
        drop(probe);
    }

    #[cfg(unix)]
    #[test]
    fn cross_capability_independent_index_sidecars_and_exclusive_creation_succeed() {
        use crate::db::search_index::{
            legacy_sidecar_leaf, preferred_sidecar_leaf, write_entries_to_at, IndexSource,
        };
        use crate::infra::fs::{create_regular_at, open_regular_at, RegularFileAccess};
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("locked.db3");
        let (repository, target, probe, connection) = ownership_repository(&path);
        let source =
            IndexSource::from_database_identity(&repository.database_identity(&target).unwrap())
                .unwrap();
        let token = CancellationToken::new();
        for leaf in [
            preferred_sidecar_leaf(target.leaf()),
            legacy_sidecar_leaf(target.leaf()),
        ] {
            crate::infra::fs::require_durable(
                write_entries_to_at(
                    target.parent(),
                    &leaf,
                    source.clone(),
                    std::iter::empty(),
                    &token,
                )
                .unwrap(),
                crate::error::DurabilityStage::SearchIndexReplacement,
            )
            .unwrap();
        }
        crate::db::search::ownership_preferred_probe(&target, &source).unwrap();
        let legacy = crate::db::search_index::probe_legacy_index_sidecar_at(
            target.parent(),
            &legacy_sidecar_leaf(target.leaf()),
            &source,
            None,
        )
        .unwrap();
        assert!(legacy.source_matches);
        drop(legacy);
        assert_sqlite_shared_read_lock_is_held(&probe);
        let leaf = OsStr::new("created.pgn");
        let (mut created, _) = create_regular_at(target.parent(), leaf).unwrap();
        created.write_all(b"newly reachable").unwrap();
        created.sync_all().unwrap();
        let created_target = test_target(&root.path().join(leaf));
        assert!(matches!(
            BoundDatabase::acquire(&created_target),
            Err(Error::Conflict(_))
        ));
        drop(created);
        drop(BoundDatabase::acquire(&created_target).unwrap());
        drop(open_regular_at(target.parent(), leaf, RegularFileAccess::ReadOnly).unwrap());
        assert_sqlite_shared_read_lock_is_held(&probe);
        drop(connection);
        drop(repository);
        drop(probe);
    }

    #[cfg(unix)]
    #[test]
    fn cross_capability_clone_transfer_cancellation_malformed_and_last_release() {
        use crate::infra::fs::{open_regular_at, RegularFileAccess};
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("source.db3");
        seed_database(&path, 1, "DELETE");
        let target = test_target(&path);
        let original =
            open_regular_at(target.parent(), target.leaf(), RegularFileAccess::ReadOnly).unwrap();
        let duplicate = original.try_clone().unwrap();
        drop(original);
        assert!(matches!(
            BoundDatabase::acquire(&target),
            Err(Error::Conflict(_))
        ));
        let transferred = std::thread::spawn(move || duplicate).join().unwrap();
        assert!(matches!(
            BoundDatabase::acquire(&target),
            Err(Error::Conflict(_))
        ));
        let token = CancellationToken::new();
        token.cancel();
        let result = DatabaseRepository::default()
            .schema_specific_connection_expected_file_cancellable(
                transferred,
                target.identity(),
                &token,
            );
        assert!(matches!(result, Err(Error::Cancellation)));
        drop(BoundDatabase::acquire(&target).unwrap());
        for cancelled in [false, true] {
            let file = open_regular_at(target.parent(), target.leaf(), RegularFileAccess::ReadOnly)
                .unwrap();
            let token = CancellationToken::new();
            if cancelled {
                token.cancel();
            }
            assert!(
                crate::db::search_index::MmapSearchIndex::open_file_cancellable(file, &token)
                    .is_err()
            );
            drop(BoundDatabase::acquire(&target).unwrap());
        }
        let pgn_path = root.path().join("malformed.pgn");
        fs::write(&pgn_path, b"[Event \"broken\"]\n\n1. e4 { never closes").unwrap();
        let pgn_target = test_target(&pgn_path);
        for cancelled in [false, true] {
            use crate::infra::path_authority::{PathAuthority, PathOperation};
            let mut authority =
                PathAuthority::open(root.path().join("pgn-authority.json"), vec![]).unwrap();
            let grant = authority
                .grant_persistent_file_for_test(&pgn_path, "PGN", vec![PathOperation::ReadPgn])
                .id;
            let resolved = authority
                .resolve(&grant, PathOperation::ReadPgn, &[])
                .unwrap();
            let snapshot = resolved.pgn_snapshot().unwrap();
            let token = CancellationToken::new();
            if cancelled {
                token.cancel();
            }
            let result = crate::pgn::count_pgn_games_core_blocking(
                snapshot,
                &token,
                &crate::pgn::PgnRepository::default(),
            );
            assert!(result.is_err(), "malformed/canceled PGN must fail");
            drop(resolved);
            drop(BoundDatabase::acquire(&pgn_target).unwrap());
        }
    }

    #[cfg(unix)]
    #[test]
    fn cross_capability_open_boundary_substitution_and_errno_preserve_locks() {
        crate::db::test_support::run_isolated("db::repository::bound_sqlite_witnesses::cross_capability_open_boundary_substitution_and_errno_preserve_locks", || {
            use crate::infra::{fs::{open_regular_at, RegularFileAccess}, inode_ownership::OPEN_TEST_CONTROLS};
            let root = tempfile::tempdir().unwrap();
            let locked = root.path().join("locked.db3");
            let (repository, target, probe, connection) = ownership_repository(&locked);
            let selected = root.path().join("selected.pgn");
            fs::write(&selected, b"independent PGN bytes").unwrap();
            let held_name = root.path().join("selected-backup.pgn");
            let swapped_name = selected.clone();
            let locked_name = locked.clone();
            let backup = held_name.clone();
            OPEN_TEST_CONTROLS.with(|controls| controls.borrow_mut().after_identify = Some(Box::new(move || {
                fs::rename(&swapped_name, backup).unwrap();
                fs::hard_link(locked_name, swapped_name).unwrap();
            })));
            let opened = open_regular_at(target.parent(), selected.file_name().unwrap(), RegularFileAccess::ReadOnly);
            #[cfg(target_os = "linux")]
            {
                let mut file = opened.unwrap();
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes).unwrap();
                assert_eq!(bytes, b"independent PGN bytes", "reopen must follow the O_PATH descriptor");
                drop(file);
            }
            #[cfg(not(target_os = "linux"))]
            assert!(matches!(opened, Err(Error::Conflict(_))), "foreign descriptor must be quarantined");
            assert_sqlite_shared_read_lock_is_held(&probe);
            fs::remove_file(&selected).unwrap();
            fs::rename(&held_name, &selected).unwrap();
            OPEN_TEST_CONTROLS.with(|controls| controls.borrow_mut().inspect_error = Some(libc::EIO));
            let error = open_regular_at(target.parent(), selected.file_name().unwrap(), RegularFileAccess::ReadOnly).unwrap_err();
            assert!(matches!(error, Error::Io(error) if error.raw_os_error() == Some(libc::EIO)));
            assert_sqlite_shared_read_lock_is_held(&probe);
            #[cfg(not(target_os = "linux"))]
            {
                use crate::infra::inode_ownership::{lock, QUARANTINE_ADMISSION_LIMIT};
                let initial = lock().unwrap().unclassified_descriptors.len();
                for count in initial..QUARANTINE_ADMISSION_LIMIT {
                    let swapped = selected.clone();
                    let backup = held_name.clone();
                    let foreign = locked.clone();
                    OPEN_TEST_CONTROLS.with(|controls| {
                        let mut controls = controls.borrow_mut();
                        controls.inspect_error = Some(libc::EIO);
                        controls.after_identify = Some(Box::new(move || {
                            fs::rename(&swapped, backup).unwrap();
                            fs::hard_link(foreign, swapped).unwrap();
                        }));
                    });
                    let error = open_regular_at(target.parent(), selected.file_name().unwrap(), RegularFileAccess::ReadOnly).unwrap_err();
                    assert!(matches!(error, Error::Io(error) if error.raw_os_error() == Some(libc::EIO)));
                    assert_eq!(lock().unwrap().unclassified_descriptors.len(), count + 1);
                    assert_sqlite_shared_read_lock_is_held(&probe);
                    fs::remove_file(&selected).unwrap();
                    fs::rename(&held_name, &selected).unwrap();
                }
                let error = open_regular_at(target.parent(), selected.file_name().unwrap(), RegularFileAccess::ReadOnly).unwrap_err();
                assert!(matches!(error, Error::Io(error) if error.raw_os_error() == Some(libc::EMFILE)));
                assert_eq!(lock().unwrap().unclassified_descriptors.len(), QUARANTINE_ADMISSION_LIMIT);
                assert_sqlite_shared_read_lock_is_held(&probe);
            }
            #[cfg(target_os = "linux")]
            {
                OPEN_TEST_CONTROLS.with(|controls| controls.borrow_mut().reopen_error = Some(libc::ENOENT));
                let error = open_regular_at(target.parent(), selected.file_name().unwrap(), RegularFileAccess::ReadOnly).unwrap_err();
                assert!(matches!(error, Error::Io(error) if error.raw_os_error() == Some(libc::ENOENT)));
                let independent_target = test_target(&selected);
                drop(BoundDatabase::acquire(&independent_target).unwrap());
                assert_sqlite_shared_read_lock_is_held(&probe);
            }
            drop(connection);
            drop(repository);
            drop(probe);
            #[cfg(not(target_os = "linux"))]
            {
                let registry = crate::infra::inode_ownership::lock().unwrap();
                assert!(registry.quarantined_descriptors.is_empty());
                assert!(registry.unclassified_descriptors.is_empty());
            }
        });
    }

    #[cfg(unix)]
    #[test]
    fn cross_capability_final_close_and_sqlite_admission_share_arbitration() {
        use crate::infra::{
            fs::{open_regular_at, RegularFileAccess},
            inode_ownership,
        };
        use std::os::fd::AsRawFd;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("concurrent.db3");
        seed_database(&path, 1, "DELETE");
        let target = test_target(&path);
        let ordinary =
            open_regular_at(target.parent(), target.leaf(), RegularFileAccess::ReadOnly).unwrap();
        let fd = ordinary.as_raw_fd();
        #[cfg(target_os = "linux")]
        let identity = target.identity();
        let entered = Arc::new(std::sync::Barrier::new(2));
        let resume = Arc::new(std::sync::Barrier::new(2));
        let (release_reader, reader_release) = std::sync::mpsc::channel();
        let (started, start) = std::sync::mpsc::channel();
        let (locked, lock) = std::sync::mpsc::channel();
        let repository = DatabaseRepository::default();
        std::thread::scope(|scope| {
            let entered_in_close = Arc::clone(&entered);
            let resume_in_close = Arc::clone(&resume);
            let closer = scope.spawn(move || {
                inode_ownership::FINAL_CLOSE_BARRIERS
                    .with(|slot| *slot.borrow_mut() = Some((entered_in_close, resume_in_close)));
                drop(ordinary);
                #[cfg(target_os = "linux")]
                assert_final_release_closed_descriptors(
                    identity,
                    "capability descriptor must close before final release",
                );
            });
            entered.wait();
            let descriptor_live = unsafe { libc::fcntl(fd, libc::F_GETFD) } >= 0;
            let close_arbitration = matches!(
                inode_ownership::REGISTRY.get().unwrap().try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            );
            let target = &target;
            let repository = &repository;
            scope.spawn(move || {
                started.send(()).unwrap();
                let mut connection = repository.initialization_connection(target, None).unwrap();
                connection
                    .batch_execute("BEGIN; SELECT Value FROM Info WHERE Name='DataRevision';")
                    .unwrap();
                locked.send(()).unwrap();
                let _ = reader_release.recv_timeout(Duration::from_secs(10));
                drop(connection);
            });
            let started = start.recv_timeout(Duration::from_secs(10));
            let admission_excluded = lock.try_recv().is_err();
            resume.wait();
            started.unwrap();
            assert!(
                descriptor_live,
                "ordinary descriptor is still live at the close barrier"
            );
            assert!(
                close_arbitration,
                "final close must hold SQLite admission arbitration"
            );
            assert!(
                admission_excluded,
                "SQLite cannot pass the paused final close"
            );
            lock.recv_timeout(Duration::from_secs(10)).unwrap();
            let probe = fs::File::open(&path).unwrap();
            assert_sqlite_shared_read_lock_is_held(&probe);
            release_reader.send(()).unwrap();
            closer.join().unwrap();
        });
        drop(repository);
    }

    #[cfg(unix)]
    #[test]
    fn cross_capability_poison_preserves_live_lock_and_closes_owned_files_safely() {
        crate::db::test_support::run_isolated("db::repository::bound_sqlite_witnesses::cross_capability_poison_preserves_live_lock_and_closes_owned_files_safely", || {
            use crate::infra::{fs::{open_regular_at, RegularFileAccess}, inode_ownership};
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("locked.db3");
            let independent = root.path().join("independent.pgn");
            fs::write(&independent, b"ordinary").unwrap();
            let (repository, target, probe, connection) = ownership_repository(&path);
            let ordinary = open_regular_at(target.parent(), independent.file_name().unwrap(), RegularFileAccess::ReadOnly).unwrap();
            let _ = std::panic::catch_unwind(|| {
                let _guard = inode_ownership::lock().unwrap();
                panic!("ownership poison witness");
            });
            assert!(matches!(BoundDatabase::acquire(&target), Err(Error::Conflict(_))));
            assert!(matches!(open_regular_at(target.parent(), target.leaf(), RegularFileAccess::ReadOnly), Err(Error::Conflict(_))));
            drop(ordinary);
            assert_sqlite_shared_read_lock_is_held(&probe);
            drop(connection);
            drop(repository);
            drop(probe);
        });
    }

    #[cfg(unix)]
    #[test]
    fn database_listing_keeps_pooled_sqlite_shared_read_lock_without_leaf_descriptors() {
        use crate::infra::path_authority::{database_test_support, PathAuthority, PathOperation};
        use tokio_util::sync::CancellationToken;

        let root = tempfile::tempdir().unwrap();
        let parent = new_database_parent(root.path());
        let path = parent.join("held.db3");
        let mut authority = PathAuthority::open(root.path().join("registry.json"), vec![]).unwrap();
        let database_root = authority
            .get_or_create_database_root(&parent, "Databases", None)
            .unwrap();
        let (repository, target, probe, connection) = ownership_repository(&path);
        repository.mark_schema_validated(&target).unwrap();
        let probe = Arc::new(probe);
        #[cfg(target_os = "linux")]
        let before = open_descriptor_count(target.identity());
        let observed = Arc::new(AtomicBool::new(false));
        let hook_observed = observed.clone();
        let hook_probe = probe.clone();
        #[cfg(target_os = "linux")]
        let identity = target.identity();
        database_test_support::set_database_child_post_resolve_hook(move || {
            assert_sqlite_shared_read_lock_is_held(&hook_probe);
            #[cfg(target_os = "linux")]
            assert_eq!(open_descriptor_count(identity), before);
            hook_observed.store(true, Ordering::SeqCst);
        });

        let children = authority
            .list_database_children_cancellable(&database_root, &CancellationToken::new())
            .expect("listing a pooled database must not open its leaf");
        assert!(observed.load(Ordering::SeqCst));
        assert_eq!(children.entries.len(), 1);
        assert_eq!(children.entries[0].filename, "held.db3");
        assert_sqlite_shared_read_lock_is_held(&probe);
        #[cfg(target_os = "linux")]
        assert_eq!(open_descriptor_count(target.identity()), before);

        let listed_target = authority
            .database_file_target(&children.entries[0].handle, PathOperation::DatabaseRead)
            .unwrap();
        assert_eq!(listed_target.identity(), target.identity());
        let usable = repository.connection(&listed_target, None).unwrap();
        assert_sqlite_shared_read_lock_is_held(&probe);
        drop(usable);
        drop(connection);
    }

    #[cfg(unix)]
    #[test]
    fn database_probe_current_keeps_pooled_sqlite_shared_read_lock_held() {
        let root = tempfile::tempdir().unwrap();
        let parent = new_database_parent(root.path());
        let path = parent.join("probe-lock.db3");
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        let mut setup = repository.initialization_connection(&target, None).unwrap();
        migrations::prepare_database(&mut setup, "title", "description").unwrap();
        drop(setup);
        repository.mark_schema_validated(&target).unwrap();

        let probe = fs::File::open(&path).expect("open persistent probe descriptor");
        let key = entry_key(&target).unwrap();
        let bound = repository
            .state
            .lock()
            .unwrap()
            .entries
            .get(&key)
            .expect("repository database entry")
            .bound
            .clone();
        let refusal_count = bound.refusal_count();

        let mut held_connection = repository.connection(&target, None).unwrap();
        held_connection
            .batch_execute("BEGIN; SELECT Value FROM Info WHERE Name='DataRevision';")
            .unwrap();
        assert_sqlite_shared_read_lock_is_held(&probe);

        let second_connection = repository.connection(&target, None).unwrap();
        assert_sqlite_shared_read_lock_is_held(&probe);
        drop(second_connection);

        repository.database_identity(&target).unwrap();
        assert_sqlite_shared_read_lock_is_held(&probe);

        let classified = repository.classify_bound_open_error(
            &target,
            &bound,
            refusal_count,
            Error::InvalidInput("simulated SQLite open failure".into()),
        );
        assert!(matches!(
            classified,
            Error::InvalidInput(message) if message == "simulated SQLite open failure"
        ));
        assert_sqlite_shared_read_lock_is_held(&probe);
    }

    #[cfg(unix)]
    fn open_bound_connection(
        bound: &BoundDatabase,
    ) -> rusqlite::Result<crate::db::bound_sqlite::BoundConnection<Connection>> {
        let lifetime = bound.connection_lifetime().map_err(|error| {
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CANTOPEN),
                Some(error.diagnostic()),
            )
        })?;
        let connection = Connection::open_with_flags(
            bound
                .uri(SqliteMode::ReadOnly)
                .expect("bound read-only URI"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )?;
        Ok(lifetime.wrap(connection))
    }

    #[cfg(all(unix, not(target_os = "linux")))]
    fn assert_full_quarantine_refuses_leaf_opens_without_closing_retained_descriptors(
        retained_path: &Path,
        retained_identity: (u64, u64),
        bound_open: &BoundDatabase,
        mut retain_descriptor: impl FnMut(libc::c_int),
        inspect_descriptors: impl Fn() -> Vec<libc::c_int>,
    ) -> (fs::File, Connection, Arc<AtomicBool>) {
        use crate::db::bound_sqlite::open_bound_leaf_for_test;
        use std::os::fd::IntoRawFd;

        let admission_limit = crate::db::bound_sqlite::quarantine_admission_limit();
        for _ in 0..admission_limit {
            let fd = fs::File::open(retained_path)
                .expect("open descriptor to retain")
                .into_raw_fd();
            retain_descriptor(fd);
        }
        let (probe, reader) = lock_plain_database(retained_path);

        let hook_ran = Arc::new(AtomicBool::new(false));
        let hook_ran_callback = Arc::clone(&hook_ran);
        bound_open
            .set_before_openat_hook(move || {
                hook_ran_callback.store(true, Ordering::SeqCst);
            })
            .unwrap();
        let refusal_count = bound_open.refusal_count();
        assert_eq!(open_bound_leaf_for_test(bound_open), Err(libc::EMFILE));
        assert_eq!(bound_open.refusal_count(), refusal_count);
        assert!(!hook_ran.load(Ordering::SeqCst));
        assert!(bound_open.has_pending_before_openat_hook());
        let retained = inspect_descriptors();
        assert_eq!(retained.len(), admission_limit);
        assert_descriptors_have_identity(&retained, retained_identity);
        assert_sqlite_shared_read_lock_is_held(&probe);

        let overflow_fd = fs::File::open(retained_path)
            .expect("open descriptor beyond admission limit")
            .into_raw_fd();
        retain_descriptor(overflow_fd);
        let over_limit = inspect_descriptors();
        assert_eq!(over_limit.len(), admission_limit + 1);
        assert_descriptors_have_identity(&over_limit, retained_identity);
        assert_sqlite_shared_read_lock_is_held(&probe);

        (probe, reader, hook_ran)
    }

    #[test]
    fn pool_parent_swap_keeps_wal_and_shm_in_held_parent_and_unlinks_them_there() {
        let root = tempfile::tempdir().unwrap();
        let parent = new_database_parent(root.path());
        let path = parent.join("pool.db3");
        seed_database(&path, 3, "WAL");
        let target = test_target(&path);
        let bound = BoundDatabase::acquire(&target).unwrap();
        let repository = DatabaseRepository::default();
        let swap = Arc::new(Mutex::new(None));
        let observed = Arc::new(Mutex::new(None));
        let swap_path = path.clone();
        let swap_before = Arc::clone(&swap);
        let swap_after = Arc::clone(&swap);
        let observed_after = Arc::clone(&observed);
        let leaf = "pool.db3".to_owned();
        let _hooks = configure_test_hooks(&path, move |hooks| {
            hooks.before_pool_get = Some(Box::new(move || {
                *swap_before.lock().unwrap() = Some(ParentSwapGuard::replace(&swap_path));
            }));
            hooks.post_get = Some(Box::new(move || {
                if let Some(swap) = swap_after.lock().unwrap().as_ref() {
                    *observed_after.lock().unwrap() = Some(swap.listing(&leaf));
                }
            }));
        });

        assert!(matches!(
            repository.initialization_connection(&target, None),
            Err(Error::Conflict(_))
        ));
        let during = observed
            .lock()
            .unwrap()
            .clone()
            .expect("post-get observation");
        assert!(during.held.contains("pool.db3-wal"), "{during:?}");
        assert!(during.held.contains("pool.db3-shm"), "{during:?}");
        assert!(during.replacement.is_empty(), "{during:?}");
        assert!(bound
            .opened_names()
            .iter()
            .any(|name| name == OsStr::new("pool.db3-wal")));

        let mut swap = swap.lock().unwrap().take().expect("parent swap");
        assert!(!sidecar_listing(&swap.held_parent, "pool.db3")
            .iter()
            .any(|name| name.ends_with("-wal") || name.ends_with("-shm")));
        assert!(sidecar_listing(path.parent().unwrap(), "pool.db3").is_empty());
        drop(bound);
        swap.restore();
    }

    // Unix only: these fixtures hold a writer or journal handle without `FILE_SHARE_DELETE`
    // inside the authorized parent, and Windows refuses to rename a directory with such a
    // child open (`ERROR_ACCESS_DENIED`, CI run 36590198609), so the swap cannot happen there.
    #[cfg(unix)]
    #[test]
    fn revision_parent_swap_reads_the_existing_wal_from_the_held_parent() {
        let root = tempfile::tempdir().unwrap();
        let parent = new_database_parent(root.path());
        let path = parent.join("revision.db3");
        seed_database(&path, 1, "WAL");
        let writer = Connection::open(&path).unwrap();
        writer
            .execute_batch("PRAGMA wal_autocheckpoint = 0;")
            .unwrap();
        writer
            .execute(
                "UPDATE Info SET Value = '23' WHERE Name = 'DataRevision'",
                [],
            )
            .unwrap();
        let target = test_target(&path);
        let bound = BoundDatabase::acquire(&target).unwrap();
        let repository = DatabaseRepository::default();
        let swap = Arc::new(Mutex::new(None));
        let observed = Arc::new(Mutex::new(None));
        let swap_path = path.clone();
        let swap_after_probe = Arc::clone(&swap);
        let swap_after_read = Arc::clone(&swap);
        let observed_after_read = Arc::clone(&observed);
        let leaf = "revision.db3".to_owned();
        let _hooks = configure_test_hooks(&path, move |hooks| {
            hooks.after_probe_current = Some(Box::new(move |count| {
                if count == 1 {
                    *swap_after_probe.lock().unwrap() = Some(ParentSwapGuard::replace(&swap_path));
                }
            }));
            hooks.after_read_revision = Some(Box::new(move || {
                if let Some(swap) = swap_after_read.lock().unwrap().as_ref() {
                    *observed_after_read.lock().unwrap() = Some(swap.listing(&leaf));
                }
            }));
        });

        repository.probe_current(&target).unwrap();
        assert_eq!(
            repository
                .read_revision(&target, &CancellationToken::new())
                .unwrap(),
            23
        );
        assert!(matches!(
            repository.database_identity(&target),
            Err(Error::Conflict(_))
        ));
        let during = observed
            .lock()
            .unwrap()
            .clone()
            .expect("revision observation");
        assert!(during.held.contains("revision.db3-wal"), "{during:?}");
        assert!(during.held.contains("revision.db3-shm"), "{during:?}");
        assert!(during.replacement.is_empty(), "{during:?}");
        assert!(bound
            .opened_names()
            .iter()
            .any(|name| name == OsStr::new("revision.db3-wal")));

        let mut swap = swap.lock().unwrap().take().expect("parent swap");
        assert!(sidecar_listing(path.parent().unwrap(), "revision.db3").is_empty());
        drop(writer);
        drop(bound);
        swap.restore();
    }

    #[test]
    fn zero_length_rollback_journal_is_absent_for_revision_read() {
        let root = tempfile::tempdir().unwrap();
        let parent = new_database_parent(root.path());
        let path = parent.join("empty-journal.db3");
        seed_database(&path, 17, "DELETE");
        let journal = PathBuf::from(format!("{}-journal", path.to_string_lossy()));
        fs::File::create(&journal).expect("create empty rollback journal");

        let target = test_target(&path);
        let bound = BoundDatabase::acquire(&target).unwrap();
        let repository = DatabaseRepository::default();
        assert_eq!(
            repository
                .read_revision(&target, &CancellationToken::new())
                .unwrap(),
            17
        );
        assert!(!bound
            .opened_names()
            .iter()
            .any(|name| name == OsStr::new("empty-journal.db3-journal")));
    }

    // Unix only: these fixtures hold a writer or journal handle without `FILE_SHARE_DELETE`
    // inside the authorized parent, and Windows refuses to rename a directory with such a
    // child open (`ERROR_ACCESS_DENIED`, CI run 36590198609), so the swap cannot happen there.
    #[cfg(unix)]
    #[test]
    fn rollback_mode_pool_conversion_opens_journal_only_in_the_held_parent() {
        let root = tempfile::tempdir().unwrap();
        let parent = new_database_parent(root.path());
        let path = parent.join("rollback.db3");
        seed_database(&path, 4, "DELETE");
        let target = test_target(&path);
        let bound = BoundDatabase::acquire(&target).unwrap();
        let repository = DatabaseRepository::default();
        let swap = Arc::new(Mutex::new(None));
        let observed = Arc::new(Mutex::new(None));
        let swap_path = path.clone();
        let swap_before = Arc::clone(&swap);
        let swap_after = Arc::clone(&swap);
        let observed_after = Arc::clone(&observed);
        let leaf = "rollback.db3".to_owned();
        let _hooks = configure_test_hooks(&path, move |hooks| {
            hooks.before_pool_get = Some(Box::new(move || {
                *swap_before.lock().unwrap() = Some(ParentSwapGuard::replace(&swap_path));
            }));
            hooks.post_get = Some(Box::new(move || {
                if let Some(swap) = swap_after.lock().unwrap().as_ref() {
                    *observed_after.lock().unwrap() = Some(swap.listing(&leaf));
                }
            }));
        });

        assert!(matches!(
            repository.initialization_connection(&target, None),
            Err(Error::Conflict(_))
        ));
        let during = observed
            .lock()
            .unwrap()
            .clone()
            .expect("post-get observation");
        assert!(!during.held.contains("rollback.db3-journal"), "{during:?}");
        assert!(during.replacement.is_empty(), "{during:?}");
        assert!(bound
            .opened_names()
            .iter()
            .any(|name| name == OsStr::new("rollback.db3-journal")));
        assert_eq!(journal_mode(&path), "wal");

        let mut swap = swap.lock().unwrap().take().expect("parent swap");
        assert!(sidecar_listing(&swap.held_parent, "rollback.db3").is_empty());
        assert!(sidecar_listing(path.parent().unwrap(), "rollback.db3").is_empty());
        drop(bound);
        swap.restore();
    }

    #[cfg(unix)]
    struct HotJournalFixture {
        root: tempfile::TempDir,
        path: PathBuf,
        _writer: Connection,
    }

    #[cfg(unix)]
    fn hot_journal_fixture(name: &str) -> HotJournalFixture {
        let root = tempfile::tempdir().unwrap();
        let parent = new_database_parent(root.path());
        let path = parent.join(format!("{name}.db3"));
        let source = root.path().join(format!("{name}-source.db3"));
        let writer = Connection::open(&source).unwrap();
        writer
            .execute_batch(
                "PRAGMA journal_mode = DELETE;\
                 PRAGMA synchronous = FULL;\
                 PRAGMA cache_size = 1;\
                 PRAGMA cache_spill = ON;\
                 CREATE TABLE Payload (Id INTEGER PRIMARY KEY, Data BLOB);\
                 INSERT INTO Payload (Data) VALUES (zeroblob(8192));",
            )
            .unwrap();
        for _ in 0..80 {
            writer
                .execute("INSERT INTO Payload (Data) VALUES (zeroblob(8192))", [])
                .unwrap();
        }
        writer
            .execute_batch(
                "CREATE TABLE Info (Name TEXT PRIMARY KEY, Value TEXT);\
                 INSERT INTO Info (Name, Value) VALUES ('DataRevision', '1');\
                 BEGIN IMMEDIATE;\
                 UPDATE Info SET Value = '2' WHERE Name = 'DataRevision';\
                 UPDATE Payload SET Data = randomblob(8192);",
            )
            .unwrap();
        let source_journal = PathBuf::from(format!("{}-journal", source.to_string_lossy()));
        assert!(fs::metadata(&source_journal).unwrap().len() > 512);
        fs::copy(&source, &path).unwrap();
        let destination_journal = PathBuf::from(format!("{}-journal", path.to_string_lossy()));
        fs::copy(source_journal, destination_journal).unwrap();
        HotJournalFixture {
            root,
            path,
            _writer: writer,
        }
    }

    // Unix only: these fixtures hold a writer or journal handle without `FILE_SHARE_DELETE`
    // inside the authorized parent, and Windows refuses to rename a directory with such a
    // child open (`ERROR_ACCESS_DENIED`, CI run 36590198609), so the swap cannot happen there.
    #[cfg(unix)]
    #[test]
    fn revision_read_does_not_skip_a_held_hot_journal_after_parent_swap() {
        let fixture = hot_journal_fixture("revision-hot");
        let target = test_target(&fixture.path);
        let repository = DatabaseRepository::default();
        let swap = Arc::new(Mutex::new(None));
        let hot_path = fixture.path.clone();
        let swap_after_probe = Arc::clone(&swap);
        let _hooks = configure_test_hooks(&fixture.path, move |hooks| {
            hooks.after_probe_current = Some(Box::new(move |count| {
                if count == 1 {
                    *swap_after_probe.lock().unwrap() = Some(ParentSwapGuard::replace(&hot_path));
                }
            }));
        });
        repository.probe_current(&target).unwrap();
        let result = repository.read_revision(&target, &CancellationToken::new());
        assert!(
            !matches!(result, Ok(2)),
            "hot journal returned spilled revision: {result:?}"
        );
        let mut swap = swap.lock().unwrap().take().expect("parent swap");
        let held = sidecar_listing(&swap.held_parent, "revision-hot.db3");
        let replacement = sidecar_listing(fixture.path.parent().unwrap(), "revision-hot.db3");
        assert!(held.contains("revision-hot.db3-journal"), "{held:?}");
        assert!(replacement.is_empty(), "{replacement:?}");
        drop(target);
        swap.restore();
        let _ = fixture.root.path();
    }

    // Unix only: these fixtures hold a writer or journal handle without `FILE_SHARE_DELETE`
    // inside the authorized parent, and Windows refuses to rename a directory with such a
    // child open (`ERROR_ACCESS_DENIED`, CI run 36590198609), so the swap cannot happen there.
    #[cfg(unix)]
    #[test]
    fn read_write_pool_rolls_back_held_hot_journal_and_removes_it_from_held_parent() {
        let fixture = hot_journal_fixture("pool-hot");
        let target = test_target(&fixture.path);
        let bound = BoundDatabase::acquire(&target).unwrap();
        let repository = DatabaseRepository::default();
        let swap = Arc::new(Mutex::new(None));
        let observed = Arc::new(Mutex::new(None));
        let hot_path = fixture.path.clone();
        let swap_before = Arc::clone(&swap);
        let swap_after = Arc::clone(&swap);
        let observed_after = Arc::clone(&observed);
        let leaf = "pool-hot.db3".to_owned();
        let _hooks = configure_test_hooks(&fixture.path, move |hooks| {
            hooks.before_pool_get = Some(Box::new(move || {
                *swap_before.lock().unwrap() = Some(ParentSwapGuard::replace(&hot_path));
            }));
            hooks.post_get = Some(Box::new(move || {
                if let Some(swap) = swap_after.lock().unwrap().as_ref() {
                    *observed_after.lock().unwrap() = Some(swap.listing(&leaf));
                }
            }));
        });

        assert!(matches!(
            repository.initialization_connection(&target, None),
            Err(Error::Conflict(_))
        ));
        let during = observed
            .lock()
            .unwrap()
            .clone()
            .expect("post-get observation");
        assert!(!during.held.contains("pool-hot.db3-journal"), "{during:?}");
        assert!(during.replacement.is_empty(), "{during:?}");
        let mut swap = swap.lock().unwrap().take().expect("parent swap");
        assert!(sidecar_listing(&swap.held_parent, "pool-hot.db3").is_empty());
        assert!(sidecar_listing(fixture.path.parent().unwrap(), "pool-hot.db3").is_empty());
        drop(bound);
        swap.restore();
        assert_eq!(read_revision_from_plain_path(&fixture.path), 1);
        let _ = fixture.root.path();
    }

    #[test]
    fn leaf_a_to_b_to_a_refusal_is_conflict_and_restores_the_authorized_leaf() {
        let root = tempfile::tempdir().unwrap();
        let parent = new_database_parent(root.path());
        let path = parent.join("leaf.db3");
        let b_path = parent.join("replacement.db3");
        seed_database(&path, 11, "WAL");
        seed_database(&b_path, 22, "WAL");
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        let leaf_swap = Arc::new(Mutex::new(LeafSwapGuard::new(&path, &b_path)));
        let after_probe = Arc::clone(&leaf_swap);
        let after_read = Arc::clone(&leaf_swap);
        let on_refusal = Arc::clone(&leaf_swap);
        let refusal_seen = Arc::new(AtomicBool::new(false));
        let refusal_seen_hook = Arc::clone(&refusal_seen);
        let _hooks = configure_test_hooks(&path, move |hooks| {
            hooks.after_probe_current = Some(Box::new(move |_| {
                after_probe.lock().unwrap().swap_to_replacement();
            }));
            hooks.after_read_revision = Some(Box::new(move || {
                #[cfg(unix)]
                after_read.lock().unwrap().restore();
                #[cfg(windows)]
                let _ = &after_read;
            }));
            hooks.bound_refusal = Some(Box::new(move || {
                refusal_seen_hook.store(true, Ordering::SeqCst);
                on_refusal.lock().unwrap().restore();
            }));
        });

        assert!(matches!(
            repository.database_identity(&target),
            Err(Error::Conflict(_))
        ));
        assert!(refusal_seen.load(Ordering::SeqCst));
        assert_eq!(read_revision_from_plain_path(&path), 11);
        leaf_swap.lock().unwrap().restore();
    }

    #[test]
    fn pool_refusal_counter_maps_r2d2_failure_to_conflict_and_retires_entry() {
        const PROMPT_OPEN_COMPLETION_BOUND: Duration = Duration::from_secs(10);

        let root = tempfile::tempdir().unwrap();
        let parent = new_database_parent(root.path());
        let path = parent.join("pool-refusal.db3");
        let b_path = parent.join("replacement.db3");
        seed_database(&path, 1, "WAL");
        seed_database(&b_path, 9, "DELETE");
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        assert_eq!(repository.pool_connection_timeout, Duration::from_secs(30));
        let leaf_swap = Arc::new(Mutex::new(LeafSwapGuard::new(&path, &b_path)));
        let before_pool = Arc::clone(&leaf_swap);
        let after_failure = Arc::clone(&leaf_swap);
        let failed_hook_seen = Arc::new(AtomicBool::new(false));
        let failed_hook = Arc::clone(&failed_hook_seen);
        let refusal_hook_seen = Arc::new(AtomicBool::new(false));
        let refusal_hook = Arc::clone(&refusal_hook_seen);
        let _hooks = configure_test_hooks(&path, move |hooks| {
            hooks.before_pool_get = Some(Box::new(move || {
                before_pool.lock().unwrap().swap_to_replacement();
            }));
            hooks.pool_get_failed = Some(Box::new(move || {
                failed_hook.store(true, Ordering::SeqCst);
                after_failure.lock().unwrap().restore();
            }));
            hooks.bound_refusal = Some(Box::new(move || {
                refusal_hook.store(true, Ordering::SeqCst);
            }));
        });

        let started = Instant::now();
        let result = repository.initialization_connection(&target, None);
        let elapsed = started.elapsed();
        assert!(
            elapsed < PROMPT_OPEN_COMPLETION_BOUND,
            "IDENTITY_NATIVE_OPEN_NOT_PROMPT: acquisition took {elapsed:?}, exceeding {PROMPT_OPEN_COMPLETION_BOUND:?} under the production budget"
        );
        eprintln!(
            "identity native open returned in {elapsed:?} with {:?} pool budget",
            repository.pool_connection_timeout
        );
        assert!(matches!(
            result,
            Err(Error::Conflict(message)) if message == "database changed after capability resolution"
        ));
        assert!(failed_hook_seen.load(Ordering::SeqCst));
        assert!(refusal_hook_seen.load(Ordering::SeqCst));
        let key = entry_key(&target).unwrap();
        assert!(!repository.state.lock().unwrap().entries.contains_key(&key));
        assert_eq!(journal_mode(&b_path), "delete");
        leaf_swap.lock().unwrap().restore();
    }

    // Unix permissions give a real native open failure without changing the bound identity.
    // The fixture requires the unprivileged test user, as do the permission witnesses below.
    #[cfg(unix)]
    #[test]
    fn non_identity_native_open_is_prompt_and_pool_recovers() {
        use std::os::unix::fs::PermissionsExt;
        const PROMPT_OPEN_COMPLETION_BOUND: Duration = Duration::from_secs(10);

        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("native-permission.db3");
        seed_database(&path, 17, "WAL");
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        let (key, entry, _) = repository.entry(&target, None).unwrap();
        assert_eq!(repository.pool_connection_timeout, Duration::from_secs(30));
        let deny_path = path.clone();
        let restore_path = path.clone();
        let observed_failure = Arc::new(Mutex::new(None));
        let capture_failure = Arc::clone(&observed_failure);
        let failed_entry = Arc::clone(&entry);
        let _hooks = configure_test_hooks(&path, |hooks| {
            hooks.before_pool_get = Some(Box::new(move || {
                fs::set_permissions(&deny_path, fs::Permissions::from_mode(0o000)).unwrap();
            }));
            hooks.pool_get_failed = Some(Box::new(move || {
                *capture_failure.lock().unwrap() =
                    failed_entry.pool_wake.failure.lock().latest.clone();
                fs::set_permissions(&restore_path, fs::Permissions::from_mode(0o600)).unwrap();
            }));
        });
        let started = Instant::now();
        let result = repository.initialization_connection(&target, None);
        let elapsed = started.elapsed();
        // Restore even if the boundary is broken, before any assertion or worker cleanup.
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        eprintln!(
            "non-identity native acquisition outcome: {:?}",
            result.as_ref().map(|_| ())
        );
        assert!(
            elapsed < PROMPT_OPEN_COMPLETION_BOUND,
            "NON_IDENTITY_NATIVE_OPEN_NOT_PROMPT: acquisition took {elapsed:?} under the production budget"
        );
        assert!(
            matches!(&result, Err(error) if matches!(error.unlabelled(),
                Error::Diesel(source) if matches!(source.as_ref(), diesel::result::Error::DatabaseError(
                    diesel::result::DatabaseErrorKind::Unknown, info
                ) if info.message() == "Unable to open the database file")
            )),
            "native open retains concrete pooled SQLite diagnostic"
        );
        let failure = observed_failure.lock().unwrap().take().unwrap();
        assert!(
            failure.native_open,
            "real failure must originate in native establishment"
        );
        assert_eq!(
            entry.bound.refusal_count(),
            0,
            "permission is not identity refusal"
        );
        assert_eq!(target.probe_current().unwrap().identity, target.identity());
        assert!(Arc::ptr_eq(
            &repository.state.lock().unwrap().entries[&key],
            &entry
        ));
        drop(_hooks);

        // The existing r2d2 retry recovers this very pool without another controller.
        let deadline = Instant::now() + PROMPT_OPEN_COMPLETION_BOUND;
        while entry.pool.read().as_ref().unwrap().state().idle_connections == 0 {
            let generation = *entry.pool_wake.generation.lock();
            assert!(
                Instant::now() < deadline,
                "native-open pool did not recover"
            );
            entry
                .pool_wake
                .wait_since(generation, RETIRE_CANCELLATION_POLL);
        }
        assert!(
            entry.pool_wake.failure.lock().latest.is_none(),
            "success clears stale native failure"
        );
        let mut recovered = repository.initialization_connection(&target, None).unwrap();
        assert_eq!(read_data_revision(&mut recovered).unwrap(), 17);
        eprintln!(
            "non-identity native open returned in {elapsed:?} with {:?} pool budget and recovered",
            repository.pool_connection_timeout
        );
    }

    #[test]
    fn writer_customization_failure_retries_for_the_same_waiting_caller() {
        use std::sync::mpsc;
        const COMPLETION_BOUND: Duration = Duration::from_secs(10);
        const FAILURE_OBSERVATION_WAIT: Duration = Duration::from_millis(200);

        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("writer-customization.db3");
        seed_database(&path, 23, "DELETE");
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        let (_, entry, _) = repository.entry(&target, None).unwrap();
        assert_eq!(repository.pool_connection_timeout, Duration::from_secs(30));
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE;").unwrap();
        let (done, result) = mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                done.send(
                    repository
                        .initialization_connection(&target, None)
                        .map(|_| ()),
                )
                .unwrap();
            });
            let deadline = Instant::now() + COMPLETION_BOUND;
            let observed = loop {
                let generation = *entry.pool_wake.generation.lock();
                if let Some(failure) = entry.pool_wake.failure.lock().latest.clone() {
                    break Some(failure);
                }
                if Instant::now() >= deadline {
                    break None;
                }
                entry
                    .pool_wake
                    .wait_since(generation, RETIRE_CANCELLATION_POLL);
            };
            let early = result.recv_timeout(FAILURE_OBSERVATION_WAIT);
            // Release before asserting, including the deliberately terminal-customization control.
            writer.execute_batch("ROLLBACK;").unwrap();
            let failure = observed.expect("writer must cause a real pool setup failure");
            assert!(
                !failure.native_open,
                "writer error is customization, not establishment"
            );
            assert!(
                matches!(failure.error.unlabelled(), Error::Diesel(source) if matches!(
                    source.as_ref(), diesel::result::Error::DatabaseError(
                        diesel::result::DatabaseErrorKind::Unknown, info
                    ) if info.message() == "database is locked"
                )),
                "writer must exercise the actual WAL customization error: {:?}",
                failure.error
            );
            assert_eq!(entry.bound.refusal_count(), 0);
            assert!(matches!(early, Err(mpsc::RecvTimeoutError::Timeout)),
                "CUSTOMIZATION_RETRY_LOST: same caller returned while valid writer held the lock: {early:?}");
            let outcome = result.recv_timeout(COMPLETION_BOUND).unwrap();
            assert!(outcome.is_ok(), "CUSTOMIZATION_RETRY_LOST: same waiting caller failed after writer release: {outcome:?}");
        });
        assert_eq!(journal_mode(&path), "wal");
        assert!(entry.pool_wake.failure.lock().latest.is_none());
    }

    fn report_test_native_failure(events: &PoolEvents) {
        diesel::r2d2::HandleError::handle_error(
            events,
            BoundPoolError::Establish(diesel::ConnectionError::BadConnection(
                "native-open test diagnostic".into(),
            )),
        );
    }

    #[test]
    fn pool_failure_diagnostics_are_deduplicated() {
        let capture = crate::error::LogCaptureScope::start();
        let events = PoolEvents {
            wake: Arc::new(PoolWake::default()),
            path: PathBuf::from("/diagnostic/one/database.db3"),
        };
        for _ in 0..3 {
            report_test_native_failure(&events);
        }
        let records = capture.records();
        assert_eq!(
            records.len(),
            1,
            "POOL_DIAGNOSTIC_DUPLICATED: one diagnostic per episode"
        );
        assert_eq!(records[0].level, log::Level::Error);
        assert!(records[0].message.contains("native-open test diagnostic"));
    }

    #[test]
    fn pool_failure_diagnostics_distinguish_equal_leaf_names() {
        let root = tempfile::tempdir().unwrap();
        let capture = crate::error::LogCaptureScope::start();
        let paths = [
            root.path().join("one/database.db3"),
            root.path().join("two/database.db3"),
        ];
        for path in &paths {
            report_test_native_failure(&PoolEvents {
                wake: Arc::new(PoolWake::default()),
                path: path.clone(),
            });
        }
        let records = capture.records();
        assert_eq!(records.len(), 2);
        for (record, path) in records.iter().zip(&paths) {
            assert!(
                record.message.contains(&format!("{path:?}")),
                "POOL_DIAGNOSTIC_CONTEXT_LOST: equal leaf names need bound directory context: {}",
                record.message
            );
        }
    }

    #[test]
    fn built_pool_validation_diagnostics_distinguish_equal_leaf_names() {
        let root = tempfile::tempdir().unwrap();
        let paths = [
            root.path().join("one/database.db3"),
            root.path().join("two/database.db3"),
        ];
        let mut diagnostic_paths = Vec::new();
        let capture = crate::error::LogCaptureScope::start();
        for path in &paths {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            seed_database(path, 37, "WAL");
            let target = test_target(path);
            diagnostic_paths.push(target.path().to_path_buf());
            let repository = DatabaseRepository::default();
            let (_, entry, _) = repository.entry(&target, None).unwrap();
            let pool = entry.pool.read().as_ref().unwrap().clone();
            // Establish outside the fault scope so checkout validates an actual idle connection.
            drop(entry.get_connection().unwrap());
            assert_eq!(pool.state().idle_connections, 1);
            let cancellation = CancellationToken::new();
            cancellation.cancel();
            // Deliberate test fault only. r2d2 validates and invokes its configured error
            // handler synchronously here, on the thread observed by LogCaptureScope.
            let result =
                crate::db::sqlite_cancellation::with_sqlite_cancellation(&cancellation, || {
                    pool.try_get().ok_or_else(|| {
                        Error::Conflict("test checkout validation refused the connection".into())
                    })
                });
            let failure = entry.pool_wake.failure.lock().latest.clone();
            // The cancellation scope has exited before healthy recovery and teardown.
            let mut recovered = entry.get_connection().unwrap();
            assert_eq!(read_data_revision(&mut recovered).unwrap(), 37);
            assert!(
                matches!(result, Err(Error::Cancellation)),
                "{:?}",
                result.as_ref().map(|_| ())
            );
            let failure = failure.expect("BUILT_POOL_VALIDATION_FAILURE_NOT_OBSERVED");
            assert!(
                !failure.native_open,
                "checkout must fail validation, not opening"
            );
            assert!(
                matches!(failure.error.unlabelled(), Error::Diesel(source) if matches!(
                    source.as_ref(), diesel::result::Error::DatabaseError(
                        diesel::result::DatabaseErrorKind::Unknown, info
                    ) if info.message() == "interrupted"
                )),
                "BUILT_POOL_VALIDATION_FAILURE_NOT_OBSERVED: {:?}",
                failure.error
            );
        }
        let records = capture.records();
        assert_eq!(
            records.len(),
            2,
            "BUILT_POOL_DIAGNOSTIC_CALLBACK_NOT_OBSERVED"
        );
        for (record, path) in records.iter().zip(&diagnostic_paths) {
            assert_eq!(record.level, log::Level::Error);
            assert!(record.message.contains("interrupted"), "{}", record.message);
            assert!(
                record.message.contains(&format!("{path:?}")),
                "BUILT_POOL_DIAGNOSTIC_CONTEXT_LOST: actual builder callback needs full directory context: {}",
                record.message
            );
        }
    }

    #[test]
    fn pool_recovery_between_sample_and_arbitration_serves_the_same_acquisition() {
        use std::sync::mpsc;
        const COMPLETION_BOUND: Duration = Duration::from_secs(10);

        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("arbitration-recovery.db3");
        seed_database(&path, 41, "WAL");
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        let (key, entry, _) = repository.entry(&target, None).unwrap();
        let pool = entry.pool.read().as_ref().unwrap().clone();
        let (entered, worker_entered) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let boundary_seen = Arc::new(AtomicBool::new(false));
        let observed_boundary = Arc::clone(&boundary_seen);
        let recovering_entry = Arc::clone(&entry);
        let recovering_pool = pool.clone();
        let _hooks = configure_test_hooks(&path, |hooks| {
            hooks.by_path.insert(
                (
                    TestHook::WorkerBeforeEstablish,
                    normalize_test_hook_path(&path),
                ),
                Box::new(move || {
                    entered.send(()).unwrap();
                    // Disconnection or the bound also releases this fixture on a failed test.
                    let _ = released.recv_timeout(COMPLETION_BOUND);
                }),
            );
            hooks.by_path.insert(
                (
                    TestHook::PoolBeforeFailureArbitration,
                    normalize_test_hook_path(&path),
                ),
                Box::new(move || {
                    observed_boundary.store(true, Ordering::SeqCst);
                    let entered = worker_entered.recv_timeout(COMPLETION_BOUND);
                    // Release before assertions even if the worker signal is missing.
                    let released = release.send(());
                    entered.expect("ARBITRATION_WORKER_NOT_HELD_BEFORE_ESTABLISHMENT");
                    released.unwrap();
                    let deadline = Instant::now() + COMPLETION_BOUND;
                    loop {
                        let generation = *recovering_entry.pool_wake.generation.lock();
                        // AcquireEvent precedes publication. Observe both real success/reset
                        // and an idle connection before resuming terminal arbitration.
                        if recovering_pool.state().idle_connections > 0
                            && recovering_entry.pool_wake.failure.lock().latest.is_none()
                        {
                            break;
                        }
                        assert!(
                            Instant::now() < deadline,
                            "ARBITRATION_WORKER_RECOVERY_NOT_OBSERVED"
                        );
                        recovering_entry
                            .pool_wake
                            .wait_since(generation, RETIRE_CANCELLATION_POLL);
                    }
                }),
            );
        });
        // The acquisition makes the sole replenishment request. Its worker is held before
        // native establishment so it cannot reset this injected sample before the boundary.
        report_test_native_failure(&PoolEvents {
            wake: Arc::clone(&entry.pool_wake),
            path: path.clone(),
        });
        let result = entry.get_connection_cancellable(
            &repository.state,
            &key,
            Instant::now() + COMPLETION_BOUND,
            None,
        );
        // The boundary releases the worker before the deliberate stale-return assertion.
        drop(_hooks);
        assert!(
            boundary_seen.load(Ordering::SeqCst),
            "ARBITRATION_BOUNDARY_NOT_OBSERVED"
        );
        let mut recovered = result.expect("STALE_SAMPLED_FAILURE_RETURNED_AFTER_REAL_RECOVERY");
        assert_eq!(read_data_revision(&mut recovered).unwrap(), 41);
        assert!(entry.pool_wake.failure.lock().latest.is_none());
    }

    #[test]
    fn pool_failure_success_resets_suppression_and_available_connection_wins() {
        const COMPLETION_BOUND: Duration = Duration::from_secs(10);
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("episode.db3");
        seed_database(&path, 31, "WAL");
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        let (key, entry, _) = repository.entry(&target, None).unwrap();
        let events = PoolEvents {
            wake: Arc::clone(&entry.pool_wake),
            path: path.clone(),
        };
        let capture = crate::error::LogCaptureScope::start();
        report_test_native_failure(&events);
        report_test_native_failure(&events);
        // A real establishment drives the production success event on its worker thread.
        drop(entry.get_connection().unwrap());
        assert!(
            entry.pool_wake.failure.lock().latest.is_none(),
            "POOL_STALE_FAILURE_NOT_RESET"
        );
        report_test_native_failure(&events);
        report_test_native_failure(&events);
        assert_eq!(
            capture.records().len(),
            2,
            "POOL_DIAGNOSTIC_RESET_LOST: recovery permits one new diagnostic"
        );
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(
            matches!(
                entry.get_connection_cancellable(
                    &repository.state,
                    &key,
                    Instant::now() + COMPLETION_BOUND,
                    Some(&cancellation)
                ),
                Err(Error::Cancellation)
            ),
            "cached native failure cannot replace caller cancellation"
        );
        let mut available = entry
            .get_connection_cancellable(
                &repository.state,
                &key,
                Instant::now() + COMPLETION_BOUND,
                None,
            )
            .expect("AVAILABLE_CONNECTION_LOST_TO_CACHED_FAILURE");
        assert_eq!(read_data_revision(&mut available).unwrap(), 31);
        diesel::r2d2::HandleError::handle_error(
            &events,
            BoundPoolError::Admission(Error::Cancellation),
        );
        assert!(
            entry
                .pool_wake
                .failure
                .lock()
                .latest
                .as_ref()
                .unwrap()
                .native_open,
            "worker admission cannot replace the pool's native failure"
        );
    }

    #[test]
    fn bound_refusal_keeps_an_unchanged_permission_failure_non_conflict() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let root = tempfile::tempdir().unwrap();
            let parent = new_database_parent(root.path());
            let path = parent.join("unreadable.db3");
            seed_database(&path, 1, "WAL");
            let target = test_target(&path);
            let bound = BoundDatabase::acquire(&target).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o0)).unwrap();
            let repository = DatabaseRepository::default();
            let result = repository.initialization_connection(&target, None);
            let refusal_count = bound.refusal_count();
            let permission_error = Error::Io(Box::new(std::io::Error::from(
                std::io::ErrorKind::PermissionDenied,
            )));
            let classified = repository.classify_bound_open_error(
                &target,
                &bound,
                refusal_count,
                permission_error,
            );
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(target.probe_current().unwrap().identity, target.identity());
            assert!(matches!(
                result,
                Err(Error::Io(source))
                    if source.kind() == std::io::ErrorKind::PermissionDenied
            ));
            assert!(matches!(
                classified,
                Error::Io(source) if source.kind() == std::io::ErrorKind::PermissionDenied
            ));

            let probed_io_error = classify_bound_open_error_result(
                false,
                || {
                    Err(Error::Io(Box::new(std::io::Error::from(
                        std::io::ErrorKind::PermissionDenied,
                    ))))
                },
                crate::error::map_sqlite_establish(
                    SqliteConnection::establish(root.path().to_str().unwrap())
                        .err()
                        .expect("SQLite must refuse a directory"),
                ),
            );
            assert!(matches!(
                probed_io_error,
                Error::Io(source) if source.kind() == std::io::ErrorKind::PermissionDenied
            ));
        }
    }

    #[test]
    fn bound_open_error_checks_the_probe_when_refusal_count_is_unchanged() {
        let root = tempfile::tempdir().unwrap();
        let parent = new_database_parent(root.path());
        let path = parent.join("authorized.db3");
        let replacement = parent.join("replacement.db3");
        let original = parent.join("authorized.db3.original");
        seed_database(&path, 1, "DELETE");
        seed_database(&replacement, 2, "DELETE");
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        let bound = BoundDatabase::acquire(&target).unwrap();
        let refusal_count = bound.refusal_count();

        let host_error = || {
            crate::error::map_sqlite_establish(
                SqliteConnection::establish(root.path().to_str().unwrap())
                    .err()
                    .expect("SQLite must refuse a directory"),
            )
        };
        let native_cause = host_error().diagnostic();
        let refused = classify_bound_open_error_result(
            true,
            || panic!("an identity refusal must take precedence over probing"),
            host_error(),
        );
        assert!(matches!(
            refused,
            Error::Conflict(message) if message == "database changed after capability resolution"
        ));

        fs::rename(&path, &original).unwrap();
        fs::rename(&replacement, &path).unwrap();
        let changed =
            repository.classify_bound_open_error(&target, &bound, refusal_count, host_error());
        assert!(matches!(
            changed,
            Error::Conflict(message) if message == "database changed after capability resolution"
        ));

        fs::remove_file(&path).unwrap();
        fs::rename(&original, &path).unwrap();
        let unchanged =
            repository.classify_bound_open_error(&target, &bound, refusal_count, host_error());
        assert!(matches!(
            &unchanged,
            Error::Io(source) if source.kind() == std::io::ErrorKind::Other
        ));
        assert_eq!(unchanged.diagnostic(), native_cause);
    }

    #[cfg(unix)]
    #[test]
    fn leaf_identity_stat_refuses_a_parked_descriptor_for_another_inode() {
        let root = tempfile::tempdir().unwrap();
        let parent = new_database_parent(root.path());
        let path = parent.join("cached.db3");
        let b_path = parent.join("replacement.db3");
        seed_database(&path, 1, "DELETE");
        seed_database(&b_path, 2, "DELETE");
        let target = test_target(&path);
        let bound = BoundDatabase::acquire(&target).unwrap();
        let mut leaf_swap = LeafSwapGuard::new(&path, &b_path);
        leaf_swap.swap_to_replacement();
        let b_probe = fs::File::open(&b_path).unwrap();

        let first =
            Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let second =
            Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        second.execute_batch("BEGIN;").unwrap();
        second
            .query_row(
                "SELECT Value FROM Info WHERE Name='DataRevision'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        first
            .query_row(
                "SELECT Value FROM Info WHERE Name='DataRevision'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        drop(first);

        let result = Connection::open_with_flags(
            bound.uri(SqliteMode::ReadOnly).unwrap(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        );
        assert!(result.is_err());
        assert!(bound.refusal_count() > 0);
        assert_sqlite_shared_read_lock_is_held(&b_probe);
        drop(second);
        drop(b_probe);
        drop(bound);
        leaf_swap.restore();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn bound_sqlite_leaf_swap_before_verification_never_opens_foreign_inode_lockably() {
        let root = tempfile::tempdir().unwrap();
        let parent = new_database_parent(root.path());
        let path_a = parent.join("race-a.db3");
        let path_b = parent.join("race-b.db3");
        seed_database(&path_a, 1, "DELETE");
        seed_database(&path_b, 2, "DELETE");
        let target_a = test_target(&path_a);
        let target_b = test_target(&path_b);
        let bound_a = BoundDatabase::acquire(&target_a).unwrap();
        let bound_b = BoundDatabase::acquire(&target_b).unwrap();
        let b_identity = target_b.identity();
        let (b_probe, b_reader) = lock_plain_database(&path_b);

        let swap = Arc::new(Mutex::new(LeafSwapGuard::new(&path_a, &path_b)));
        let swap_in_hook = Arc::clone(&swap);
        let swapped = Arc::new(AtomicBool::new(false));
        let swapped_in_hook = Arc::clone(&swapped);
        bound_a
            .set_before_openat_hook(move || {
                swap_in_hook.lock().unwrap().swap_to_replacement();
                swapped_in_hook.store(true, Ordering::SeqCst);
            })
            .unwrap();

        let before = open_descriptor_count(b_identity);
        let result =
            DatabaseRepository::default().read_revision(&target_a, &CancellationToken::new());
        assert!(matches!(result, Err(Error::Conflict(_))), "{result:?}");
        assert!(bound_a.refusal_count() > 0);
        assert!(
            swapped.load(Ordering::SeqCst),
            "the pre-open swap seam did not run"
        );
        assert_sqlite_shared_read_lock_is_held(&b_probe);
        assert_eq!(open_descriptor_count(b_identity), before);

        drop(b_reader);
        drop(b_probe);
        drop(bound_a);
        drop(bound_b);
        swap.lock().unwrap().restore();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn bound_sqlite_leaf_reopen_uses_the_verified_inode_after_a_name_swap() {
        let root = tempfile::tempdir().unwrap();
        let parent = new_database_parent(root.path());
        let path_a = parent.join("reopen-a.db3");
        let path_b = parent.join("reopen-b.db3");
        seed_database(&path_a, 1, "DELETE");
        seed_database(&path_b, 2, "DELETE");
        let target_a = test_target(&path_a);
        let target_b = test_target(&path_b);
        let bound_a = BoundDatabase::acquire(&target_a).unwrap();
        let bound_b = BoundDatabase::acquire(&target_b).unwrap();
        let a_identity = target_a.identity();
        let (b_probe, b_reader) = lock_plain_database(&path_b);

        let swap = Arc::new(Mutex::new(LeafSwapGuard::new(&path_a, &path_b)));
        let swap_in_hook = Arc::clone(&swap);
        let swapped = Arc::new(AtomicBool::new(false));
        let swapped_in_hook = Arc::clone(&swapped);
        bound_a
            .set_before_proc_reopen_hook(move || {
                swap_in_hook.lock().unwrap().swap_to_replacement();
                swapped_in_hook.store(true, Ordering::SeqCst);
            })
            .unwrap();

        let before = open_descriptor_count(a_identity);
        let revision = DatabaseRepository::default()
            .read_revision(&target_a, &CancellationToken::new())
            .unwrap();
        assert_eq!(revision, 1);
        assert!(
            swapped.load(Ordering::SeqCst),
            "the pre-reopen swap seam did not run"
        );
        assert_sqlite_shared_read_lock_is_held(&b_probe);
        assert_eq!(open_descriptor_count(a_identity), before);

        drop(b_reader);
        drop(b_probe);
        drop(bound_a);
        drop(bound_b);
        swap.lock().unwrap().restore();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn bound_sqlite_leaf_fstat_failure_closes_only_the_path_descriptor() {
        let root = tempfile::tempdir().unwrap();
        let parent = new_database_parent(root.path());
        let path = parent.join("fstat-error.db3");
        seed_database(&path, 7, "DELETE");
        let target = test_target(&path);
        let bound = BoundDatabase::acquire(&target).unwrap();
        let identity = target.identity();
        let (probe, reader) = lock_plain_database(&path);
        let before = open_descriptor_count(identity);
        bound.fail_next_leaf_fstat_with(libc::EIO).unwrap();

        assert!(open_bound_connection(&bound).is_err());
        assert_sqlite_shared_read_lock_is_held(&probe);
        assert_eq!(open_descriptor_count(identity), before);

        drop(reader);
        drop(probe);
        drop(bound);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn bound_sqlite_leaf_reopen_failure_closes_the_path_descriptor() {
        let root = tempfile::tempdir().unwrap();
        let parent = new_database_parent(root.path());
        let path = parent.join("reopen-error.db3");
        seed_database(&path, 8, "DELETE");
        let target = test_target(&path);
        let bound = BoundDatabase::acquire(&target).unwrap();
        let identity = target.identity();
        let (probe, reader) = lock_plain_database(&path);
        let before = open_descriptor_count(identity);
        bound.fail_next_proc_reopen_with(libc::ENOENT).unwrap();

        assert!(open_bound_connection(&bound).is_err());
        assert_sqlite_shared_read_lock_is_held(&probe);
        assert_eq!(open_descriptor_count(identity), before);

        drop(reader);
        drop(probe);
        drop(bound);
    }

    #[cfg(all(unix, not(target_os = "linux")))]
    #[test]
    fn bound_sqlite_fifo_leaf_swap_finishes_without_a_writer() {
        crate::db::test_support::run_isolated(
            "db::repository::bound_sqlite_witnesses::bound_sqlite_fifo_leaf_swap_finishes_without_a_writer",
            || {
                use std::os::unix::ffi::OsStrExt;
                let root = tempfile::tempdir().unwrap();
                let path = root.path().join("fifo-leaf.db3");
                seed_database(&path, 7, "DELETE");
                let target = test_target(&path);
                let bound = BoundDatabase::acquire(&target).unwrap();
                let fifo_path = path.clone();
                bound.set_before_openat_hook(move || {
                    fs::rename(&fifo_path, fifo_path.with_extension("backup")).unwrap();
                    let name = std::ffi::CString::new(fifo_path.as_os_str().as_bytes()).unwrap();
                    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
                }).unwrap();
                let result = DatabaseRepository::default().read_revision(&target, &CancellationToken::new());
                assert!(matches!(result, Err(Error::Conflict(_))), "FIFO leaf swap must return Conflict: {result:?}");
                assert!(bound.refusal_count() > 0, "FIFO leaf refusal increments identity counter");
                fs::remove_file(&path).unwrap();
                fs::rename(path.with_extension("backup"), &path).unwrap();
                let fd = crate::db::bound_sqlite::open_bound_leaf_for_test(&bound).unwrap();
                assert_ne!(unsafe { libc::fcntl(fd, libc::F_GETFL) } & libc::O_NONBLOCK, 0, "regular non-Linux leaf retains O_NONBLOCK");
                assert_eq!(unsafe { libc::close(fd) }, 0);
                assert_eq!(DatabaseRepository::default().read_revision(&target, &CancellationToken::new()).unwrap(), 7);
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn bound_sqlite_sidecar_metadata_failure_preserves_locks_errno_admission_and_cleanup() {
        crate::db::test_support::run_isolated(
            "db::repository::bound_sqlite_witnesses::bound_sqlite_sidecar_metadata_failure_preserves_locks_errno_admission_and_cleanup",
            || {
                use crate::db::bound_sqlite::{open_bound_sidecar_for_test, quarantine_admission_limit, unclassified_descriptor_fds};
                let root = tempfile::tempdir().unwrap();
                let path_a = root.path().join("owner-a.db3");
                let path_b = root.path().join("locked-b.db3");
                seed_database(&path_a, 1, "DELETE");
                seed_database(&path_b, 2, "DELETE");
                let target_a = test_target(&path_a);
                let target_b = test_target(&path_b);
                let bound_a = BoundDatabase::acquire(&target_a).unwrap();
                let bound_b = BoundDatabase::acquire(&target_b).unwrap();
                // This hard link injects an unknown lockable database inode at a sidecar name.
                // It is not an acceptance policy for ordinary hard-linked WAL sidecars.
                fs::hard_link(&path_b, root.path().join("owner-a.db3-shm")).unwrap();
                let probe = fs::File::open(&path_b).unwrap();
                let reader = open_bound_connection(&bound_b).unwrap();
                reader.execute_batch("BEGIN; SELECT Value FROM Info WHERE Name='DataRevision';").unwrap();
                assert_sqlite_shared_read_lock_is_held(&probe);
                for count in 1..=quarantine_admission_limit() {
                    bound_a.fail_next_sidecar_fstat_with(libc::EIO);
                    assert_eq!(open_bound_sidecar_for_test(&bound_a, "-shm", libc::O_RDONLY), Err(libc::EIO), "metadata failure preserves inspection errno");
                    let retained = unclassified_descriptor_fds();
                    assert_eq!(retained.len(), count, "unknown descriptor remains registry-owned");
                    assert_descriptors_have_identity(&retained, target_b.identity());
                    assert_sqlite_shared_read_lock_is_held(&probe);
                }
                let retained = unclassified_descriptor_fds();
                for bound in [&bound_a, &bound_b] {
                    for suffix in ["-wal", "-shm", "-journal"] {
                        assert_eq!(open_bound_sidecar_for_test(bound, suffix, libc::O_RDWR | libc::O_CREAT), Err(libc::EMFILE), "full unknown bucket refuses sidecar admission");
                    }
                }
                assert_eq!(bound_a.refusal_count(), 0, "metadata and admission failures leave identity counter unchanged");
                assert_eq!(bound_b.refusal_count(), 0);
                assert_eq!(unclassified_descriptor_fds(), retained, "full bucket never closes retained descriptors");
                assert_sqlite_shared_read_lock_is_held(&probe);
                drop(bound_a);
                assert_eq!(unclassified_descriptor_fds(), retained, "another live registration retains unknown descriptors");
                assert_sqlite_shared_read_lock_is_held(&probe);
                drop(reader);
                drop(probe);
                drop(bound_b);
                assert!(unclassified_descriptor_fds().is_empty(), "last registration drains unknown bucket");
                for fd in retained {
                    assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, -1, "cleanup closes the retained descriptor");
                    assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(libc::EBADF));
                }
                let reopened = BoundDatabase::acquire(&target_a).unwrap();
                let fd = open_bound_sidecar_for_test(&reopened, "-journal", libc::O_RDWR | libc::O_CREAT).unwrap();
                assert_eq!(unsafe { libc::close(fd) }, 0);
            },
        );
    }

    #[cfg(unix)]
    fn assert_fifo_shm_query_error(result: Result<u64, Error>) {
        assert!(
            matches!(&result, Err(Error::Diesel(error)) if matches!(
                error.as_ref(),
                diesel::result::Error::DatabaseError(diesel::result::DatabaseErrorKind::Unknown, info)
                    if info.message() == "unable to open database file"
            )),
            "query-time SHM refusal retains concrete Diesel/SQLite error: {result:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn bound_sqlite_fifo_shm_repository_failures_and_regular_fallback_recovery() {
        crate::db::test_support::run_isolated(
            "db::repository::bound_sqlite_witnesses::bound_sqlite_fifo_shm_repository_failures_and_regular_fallback_recovery",
            || {
                use std::os::unix::{ffi::OsStrExt, fs::PermissionsExt};
                let root = tempfile::tempdir().unwrap();
                let source = root.path().join("source.db3");
                seed_database(&source, 9, "WAL");
                let writer = Connection::open(&source).unwrap();
                writer.execute_batch("PRAGMA wal_autocheckpoint=0; UPDATE Info SET Value='10' WHERE Name='DataRevision';").unwrap();
                let path = root.path().join("fallback.db3");
                fs::copy(&source, &path).unwrap();
                fs::copy(root.path().join("source.db3-wal"), root.path().join("fallback.db3-wal")).unwrap();
                let shm = root.path().join("fallback.db3-shm");
                let good_shm = root.path().join("good-shm");
                fs::copy(root.path().join("source.db3-shm"), &good_shm).unwrap();
                let name = std::ffi::CString::new(shm.as_os_str().as_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o400) }, 0);
                let target = test_target(&path);
                let bound = BoundDatabase::acquire(&target).unwrap();
                // Prove the real read-only fallback is reachable, rather than merely arranging
                // a FIFO that a privileged process could open read-write.
                assert_eq!(crate::db::bound_sqlite::open_bound_sidecar_for_test(&bound, "-shm", libc::O_RDWR), Err(libc::EACCES), "fixture must force SQLite's read-only SHM fallback");
                let repository = DatabaseRepository::with_pool_connection_timeout(SHORT_POOL_CONNECTION_TIMEOUT);
                let mut established = SqliteConnection::establish(&bound.uri(SqliteMode::ReadOnly).unwrap()).expect("establish succeeds before SHM query");
                let query = read_data_revision(&mut established);
                eprintln!("FIFO SHM after establish: {query:?}");
                assert_fifo_shm_query_error(query);
                drop(established);
                let revision = repository.read_revision(&target, &CancellationToken::new());
                eprintln!("FIFO SHM revision boundary: {revision:?}");
                assert_fifo_shm_query_error(revision);
                assert!(matches!(repository.database_identity(&target), Err(Error::Diesel(_))), "FIFO SHM must not hydrate a successful identity");
                let pool = repository.initialization_connection(&target, None);
                match &pool {
                    Err(error) => eprintln!("FIFO SHM pool boundary: {error:?}"),
                    Ok(_) => panic!("FIFO SHM pool unexpectedly succeeded"),
                }
                assert!(matches!(pool, Err(ref error) if error.category() == crate::error::ErrorCategory::Database && error.diagnostic().contains("unable to open database file")), "pool retains concrete bounded acquisition error");
                assert_eq!(bound.refusal_count(), 0, "FIFO sidecar failure is not Conflict");
                fs::remove_file(&shm).unwrap();
                fs::copy(&good_shm, &shm).unwrap();
                fs::set_permissions(&shm, fs::Permissions::from_mode(0o400)).unwrap();
                assert_eq!(repository.read_revision(&target, &CancellationToken::new()).unwrap(), 10, "read-only regular SHM fallback reads WAL revision");
                fs::set_permissions(&shm, fs::Permissions::from_mode(0o600)).unwrap();
                let mut connection = repository.initialization_connection(&target, None).unwrap();
                connection.batch_execute("UPDATE Info SET Value='11' WHERE Name='DataRevision'; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
                assert_eq!(read_data_revision(&mut connection).unwrap(), 11, "regular WAL write and checkpoint succeed after replacement");
                drop(writer);
            },
        );
    }

    #[cfg(all(unix, not(target_os = "linux")))]
    #[test]
    fn post_open_leaf_swap_quarantines_foreign_descriptor_without_dropping_locks() {
        use crate::db::bound_sqlite::quarantined_descriptor_fds;

        let root = tempfile::tempdir().unwrap();
        let parent = new_database_parent(root.path());
        let path_a = parent.join("race-a.db3");
        let path_b = parent.join("race-b.db3");
        seed_database(&path_a, 1, "DELETE");
        seed_database(&path_b, 2, "DELETE");
        let target_a = test_target(&path_a);
        let target_b = test_target(&path_b);
        let bound_a = BoundDatabase::acquire(&target_a).unwrap();
        let bound_b = BoundDatabase::acquire(&target_b).unwrap();
        let b_identity = target_b.identity();
        let (b_probe, b_reader) = lock_plain_database(&path_b);

        let swap = Arc::new(Mutex::new(LeafSwapGuard::new(&path_a, &path_b)));
        let swap_in_hook = Arc::clone(&swap);
        let swapped = Arc::new(AtomicBool::new(false));
        let swapped_in_hook = Arc::clone(&swapped);
        bound_a
            .set_before_openat_hook(move || {
                swap_in_hook.lock().unwrap().swap_to_replacement();
                swapped_in_hook.store(true, Ordering::SeqCst);
            })
            .unwrap();

        let result =
            DatabaseRepository::default().read_revision(&target_a, &CancellationToken::new());
        assert!(matches!(result, Err(Error::Conflict(_))), "{result:?}");
        assert!(bound_a.refusal_count() > 0);
        assert!(
            swapped.load(Ordering::SeqCst),
            "the pre-open swap seam did not run"
        );
        assert_sqlite_shared_read_lock_is_held(&b_probe);

        let quarantined = quarantined_descriptor_fds(b_identity);
        assert_descriptors_have_identity(&quarantined, b_identity);
        drop(bound_a);
        let retained_after_a_drops = quarantined_descriptor_fds(b_identity);
        assert_descriptors_have_identity(&retained_after_a_drops, b_identity);
        assert_sqlite_shared_read_lock_is_held(&b_probe);

        drop(b_reader);
        drop(b_probe);
        drop(bound_b);
        assert!(quarantined_descriptor_fds(b_identity).is_empty());
        swap.lock().unwrap().restore();
    }

    #[cfg(all(unix, not(target_os = "linux")))]
    #[test]
    fn bound_sqlite_fstat_failure_retains_unclassified_descriptor_until_all_bindings_drop() {
        crate::db::test_support::run_isolated(
            "db::repository::bound_sqlite_witnesses::bound_sqlite_fstat_failure_retains_unclassified_descriptor_until_all_bindings_drop",
            || {
                use crate::db::bound_sqlite::unclassified_descriptor_fds;

                let root = tempfile::tempdir().unwrap();
                let parent = new_database_parent(root.path());
                let path_a = parent.join("unclassified-a.db3");
                let path_b = parent.join("unclassified-b.db3");
                seed_database(&path_a, 1, "DELETE");
                seed_database(&path_b, 2, "DELETE");
                let target_a = test_target(&path_a);
                let target_b = test_target(&path_b);
                let bound_a = BoundDatabase::acquire(&target_a).unwrap();
                let bound_b = BoundDatabase::acquire(&target_b).unwrap();
                let b_identity = target_b.identity();
                let (b_probe, b_reader) = lock_plain_database(&path_b);

                let swap = Arc::new(Mutex::new(LeafSwapGuard::new(&path_a, &path_b)));
                let swap_in_hook = Arc::clone(&swap);
                let swapped = Arc::new(AtomicBool::new(false));
                let swapped_in_hook = Arc::clone(&swapped);
                bound_a
                    .set_before_openat_hook(move || {
                        swap_in_hook.lock().unwrap().swap_to_replacement();
                        swapped_in_hook.store(true, Ordering::SeqCst);
                    })
                    .unwrap();
                bound_a.fail_next_leaf_fstat_with(libc::EIO).unwrap();

                assert!(open_bound_connection(&bound_a).is_err());
                assert!(
                    swapped.load(Ordering::SeqCst),
                    "the pre-open swap seam did not run"
                );
                let retained = unclassified_descriptor_fds();
                assert_descriptors_have_identity(&retained, b_identity);
                assert_sqlite_shared_read_lock_is_held(&b_probe);

                drop(bound_a);
                let retained_after_a_drops = unclassified_descriptor_fds();
                assert_descriptors_have_identity(&retained_after_a_drops, b_identity);
                assert_sqlite_shared_read_lock_is_held(&b_probe);

                drop(b_reader);
                drop(b_probe);
                drop(bound_b);
                assert!(unclassified_descriptor_fds().is_empty());
                swap.lock().unwrap().restore();
            },
        );
    }

    #[cfg(all(unix, not(target_os = "linux")))]
    #[test]
    fn full_identity_quarantine_refuses_leaf_opens_without_closing_retained_descriptors() {
        crate::db::test_support::run_isolated(
            "db::repository::bound_sqlite_witnesses::full_identity_quarantine_refuses_leaf_opens_without_closing_retained_descriptors",
            || {
                use crate::db::bound_sqlite::{
                    open_bound_leaf_for_test, quarantined_descriptor_fds,
                    retain_mismatched_descriptor_for_test,
                };

                let root = tempfile::tempdir().unwrap();
                let parent = new_database_parent(root.path());
                let filled_path = parent.join("filled.db3");
                let foreign_path = parent.join("foreign.db3");
                let open_path = parent.join("open.db3");
                seed_database(&filled_path, 1, "DELETE");
                seed_database(&foreign_path, 2, "DELETE");
                seed_database(&open_path, 3, "DELETE");

                let filled_target = test_target(&filled_path);
                let open_target = test_target(&open_path);
                let bound_filled = BoundDatabase::acquire(&filled_target).unwrap();
                let bound_open = BoundDatabase::acquire(&open_target).unwrap();
                let filled_identity = filled_target.identity();
                let mut leaf_swap = LeafSwapGuard::new(&open_path, &foreign_path);
                leaf_swap.swap_to_replacement();

                let (probe, reader, hook_ran) =
                    assert_full_quarantine_refuses_leaf_opens_without_closing_retained_descriptors(
                        &filled_path,
                        filled_identity,
                        &bound_open,
                        |fd| retain_mismatched_descriptor_for_test(fd, filled_identity),
                        || quarantined_descriptor_fds(filled_identity),
                    );

                leaf_swap.restore();
                drop(reader);
                drop(probe);
                drop(bound_filled);
                assert!(quarantined_descriptor_fds(filled_identity).is_empty());
                let reopened_fd = open_bound_leaf_for_test(&bound_open).unwrap();
                assert!(hook_ran.load(Ordering::SeqCst));
                assert_eq!(unsafe { libc::close(reopened_fd) }, 0);
                drop(bound_open);
            },
        );
    }

    #[cfg(all(unix, not(target_os = "linux")))]
    #[test]
    fn full_unclassified_bucket_refuses_leaf_opens_without_closing_retained_descriptors() {
        crate::db::test_support::run_isolated(
            "db::repository::bound_sqlite_witnesses::full_unclassified_bucket_refuses_leaf_opens_without_closing_retained_descriptors",
            || {
                use crate::db::bound_sqlite::{
                    open_bound_leaf_for_test, retain_unclassified_descriptor_for_test,
                    unclassified_descriptor_fds,
                };

                let root = tempfile::tempdir().unwrap();
                let parent = new_database_parent(root.path());
                let unknown_path = parent.join("unknown.db3");
                let unclassified_open_path = parent.join("unclassified-open.db3");
                seed_database(&unknown_path, 4, "DELETE");
                seed_database(&unclassified_open_path, 5, "DELETE");

                let unknown_target = test_target(&unknown_path);
                let unclassified_open_target = test_target(&unclassified_open_path);
                let bound_unknown = BoundDatabase::acquire(&unknown_target).unwrap();
                let bound_unclassified_open =
                    BoundDatabase::acquire(&unclassified_open_target).unwrap();
                let unknown_identity = unknown_target.identity();
                let (probe, reader, hook_ran) =
                    assert_full_quarantine_refuses_leaf_opens_without_closing_retained_descriptors(
                        &unknown_path,
                        unknown_identity,
                        &bound_unclassified_open,
                        retain_unclassified_descriptor_for_test,
                        unclassified_descriptor_fds,
                    );

                drop(reader);
                drop(probe);
                drop(bound_unknown);
                let retained = unclassified_descriptor_fds();
                assert_eq!(
                    retained.len(),
                    crate::db::bound_sqlite::quarantine_admission_limit() + 1
                );
                assert_descriptors_have_identity(&retained, unknown_identity);
                drop(bound_unclassified_open);
                assert!(unclassified_descriptor_fds().is_empty());

                let reopened_bound = BoundDatabase::acquire(&unclassified_open_target).unwrap();
                let hook_ran_callback = Arc::clone(&hook_ran);
                reopened_bound
                    .set_before_openat_hook(move || {
                        hook_ran_callback.store(true, Ordering::SeqCst);
                    })
                    .unwrap();
                let reopened_fd = open_bound_leaf_for_test(&reopened_bound).unwrap();
                assert!(hook_ran.load(Ordering::SeqCst));
                assert_eq!(unsafe { libc::close(reopened_fd) }, 0);
                drop(reopened_bound);
            },
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_reparse_sidecar_is_reported_as_present_but_never_followed() {
        use std::os::windows::fs::symlink_file;

        let root = tempfile::tempdir().unwrap();
        let parent = new_database_parent(root.path());
        let path = parent.join("reparse.db3");
        let baseline = parent.join("baseline.db3");
        let wal_copy = parent.join("external-wal");
        seed_database(&path, 1, "WAL");
        fs::copy(&path, &baseline).unwrap();
        let writer = Connection::open(&path).unwrap();
        writer
            .execute_batch("PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        writer
            .execute("UPDATE Info SET Value='2' WHERE Name='DataRevision'", [])
            .unwrap();
        fs::copy(
            PathBuf::from(format!("{}-wal", path.to_string_lossy())),
            &wal_copy,
        )
        .unwrap();
        drop(writer);
        fs::copy(&baseline, &path).unwrap();
        let wal_path = PathBuf::from(format!("{}-wal", path.to_string_lossy()));
        let _ = fs::remove_file(&wal_path);
        symlink_file(&wal_copy, &wal_path).unwrap();
        let target = test_target(&path);
        let repository = DatabaseRepository::default();
        assert!(repository
            .read_revision(&target, &CancellationToken::new())
            .is_err());
    }

    #[test]
    fn bound_uri_mode_is_read_only_for_revision_and_plain_connections_are_unbound() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("uri-check.db3");
        seed_database(&path, 5, "WAL");
        let target = test_target(&path);
        let bound = BoundDatabase::acquire(&target).unwrap();
        assert!(bound.uri(SqliteMode::ReadOnly).unwrap().contains("mode=ro"));
        assert!(bound
            .uri(SqliteMode::ReadWrite)
            .unwrap()
            .contains("mode=rw"));
        let plain = Connection::open(&path).unwrap();
        plain.execute_batch("SELECT 1;").unwrap();
    }

    #[test]
    fn failed_bound_connect_releases_its_ticket_and_closed_gate_refuses_connects() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("bound-existing.db3");
        seed_database(&path, 1, "DELETE");
        let target = test_target(&path);
        let database = BoundDatabase::acquire(&target).unwrap();
        let missing_path = root.path().join("missing.db3");
        assert!(!missing_path.exists());
        let connections = Arc::new(DrainGate::default());
        let manager = BoundConnectionManager {
            database,
            uri: format!("file:{}?mode=ro", missing_path.to_string_lossy()),
            connections: Arc::clone(&connections),
            barrier: None,
            _owner: Arc::new(Arc::new(DrainGate::default()).enter().unwrap()),
        };

        assert!(<BoundConnectionManager as ManageConnection>::connect(&manager).is_err());
        assert_eq!(connections.snapshot().outstanding, 0);

        connections.close();
        assert!(matches!(
            <BoundConnectionManager as ManageConnection>::connect(&manager),
            Err(BoundPoolError::Admission(Error::Conflict(message)))
                if message == "database pool is retiring"
        ));
        assert_eq!(connections.snapshot().outstanding, 0);
    }

    #[test]
    fn pool_and_revision_reader_share_one_binding_while_wal_is_open() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("shared-wal.db3");
        seed_database(&path, 7, "WAL");
        let target = test_target(&path);
        let bound = BoundDatabase::acquire(&target).unwrap();
        let repository = DatabaseRepository::default();
        let pool_connection = repository.initialization_connection(&target, None).unwrap();
        assert_eq!(
            repository
                .read_revision(&target, &CancellationToken::new())
                .unwrap(),
            7
        );
        let same_binding = BoundDatabase::acquire(&target).unwrap();
        assert_eq!(bound.token(), same_binding.token());
        assert!(bound
            .opened_names()
            .iter()
            .any(|name| name == OsStr::new("shared-wal.db3-wal")));
        drop(pool_connection);
    }

    #[test]
    fn pooled_connection_keeps_the_vfs_registered_until_connection_close() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("binding-lifetime.db3");
        seed_database(&path, 3, "WAL");
        let target = test_target(&path);
        let bound = BoundDatabase::acquire(&target).unwrap();
        let token = bound.token();
        let uri = bound.uri(SqliteMode::ReadWrite).unwrap();
        let connections = Arc::new(DrainGate::default());
        let owners = Arc::new(DrainGate::default());
        let pool = Pool::builder()
            .max_size(MAX_CONNECTIONS_PER_DATABASE)
            .min_idle(Some(0))
            .connection_timeout(POOL_CONNECTION_TIMEOUT)
            .connection_customizer(Box::new(ConnectionOptions))
            .build(BoundConnectionManager {
                database: bound.clone(),
                uri,
                connections: Arc::clone(&connections),
                barrier: None,
                _owner: Arc::new(owners.enter().unwrap()),
            })
            .unwrap();
        let mut pooled = pool.get().unwrap();
        drop(bound);
        drop(pool);
        pooled
            .batch_execute(
                "PRAGMA wal_autocheckpoint = 0;\
                 CREATE TABLE Lifetime (Value INTEGER);\
                 INSERT INTO Lifetime VALUES (1);\
                 INSERT INTO Lifetime VALUES (2);",
            )
            .unwrap();
        assert!(
            sidecar_listing(path.parent().unwrap(), "binding-lifetime.db3")
                .contains("binding-lifetime.db3-wal")
        );
        // Refuse late worker admission before observing either drain.
        connections.close();
        owners.close();
        drop(pooled);
        let deadline = Instant::now() + Duration::from_secs(10);
        // Managers can outlive checkout, and idle connections can outlive their manager.
        owners
            .wait_drained_until(deadline, None, "pool owners did not release the binding")
            .unwrap();
        connections
            .wait_drained_until(deadline, None, "pooled SQLite connections did not close")
            .unwrap();
        let name = std::ffi::CString::new(format!("chessfable-bound-{token}")).unwrap();
        assert!(unsafe { rusqlite::ffi::sqlite3_vfs_find(name.as_ptr()) }.is_null());
        assert!(sidecar_listing(path.parent().unwrap(), "binding-lifetime.db3").is_empty());
    }
}
