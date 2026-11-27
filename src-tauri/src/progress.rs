use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;
use tauri_specta::Event;
use tokio_util::sync::CancellationToken;

use crate::{
    error::{Error, ErrorPayload},
    infra::operations::OperationRegistry,
    AppState,
};

const PROGRESS_CAPACITY: usize = 1_000;
const RUNNING_TTL: Duration = Duration::from_secs(60 * 60);
const TERMINAL_TTL: Duration = Duration::from_secs(5 * 60);
const U64_MAX_DECIMAL_DIGITS: usize = 20;

/// Progress identities retain the full u64 range across JSON without rounding.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ProgressGeneration(u64);

impl ProgressGeneration {
    fn parse_canonical(value: &str) -> Result<Self, String> {
        if value.is_empty()
            || value.len() > U64_MAX_DECIMAL_DIGITS
            || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("invalid progress generation".into());
        }
        value
            .parse::<u64>()
            .map(Self)
            .map_err(|error| error.to_string())
    }
}

impl PartialEq<u64> for ProgressGeneration {
    fn eq(&self, other: &u64) -> bool {
        self.0 == *other
    }
}

impl PartialEq<ProgressGeneration> for u64 {
    fn eq(&self, other: &ProgressGeneration) -> bool {
        *self == other.0
    }
}

impl Serialize for ProgressGeneration {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for ProgressGeneration {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse_canonical(&value).map_err(serde::de::Error::custom)
    }
}

impl Type for ProgressGeneration {
    fn inline(
        type_map: &mut specta::TypeMap,
        generics: specta::Generics,
    ) -> specta::datatype::DataType {
        String::inline(type_map, generics)
    }
}

impl std::fmt::Display for ProgressGeneration {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

#[cfg(test)]
static CLEAR_DECISION_HOOKS: crate::infra::test_hooks::KeyedTestHooks<String> =
    crate::infra::test_hooks::KeyedTestHooks::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ProgressState {
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl ProgressState {
    fn is_terminal(self) -> bool {
        !matches!(self, Self::Running)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProgressLease {
    pub id: String,
    pub generation: ProgressGeneration,
}

/// Borrowed per-call test hook for running progress updates.
/// None runs the production update after callback side effects. Some(result) substitutes its result.
#[cfg(test)]
pub(crate) type ProgressUpdateHook<'a> =
    dyn Fn(&ProgressLease, f32) -> Option<Result<(), Error>> + Sync + 'a;

pub(crate) const COUNT_EMIT_INTERVAL: Duration = Duration::from_millis(250);

/// Carries an optional initial count and callback for streaming game-count producers.
pub(crate) struct GameCountSink<'a> {
    pub(crate) initial_count: Option<u32>,
    pub(crate) on_count: &'a mut (dyn FnMut(u32) -> Result<(), Error> + Send),
}

/// Bounds live game-count emissions to at most one per `COUNT_EMIT_INTERVAL`
/// during a stream, plus one final update when the payload completes.
pub(crate) struct CountProgressThrottle {
    last_emitted_count: Option<u32>,
    last_emitted_at: Option<Instant>,
}

impl CountProgressThrottle {
    pub(crate) fn new(initial_count: Option<u32>) -> Self {
        Self {
            last_emitted_count: initial_count,
            last_emitted_at: None,
        }
    }

    pub(crate) fn record_if_due(&mut self, count: u32, now: Instant) -> bool {
        if self.last_emitted_count == Some(count) {
            return false;
        }
        if self
            .last_emitted_at
            .is_some_and(|at| now.saturating_duration_since(at) < COUNT_EMIT_INTERVAL)
        {
            return false;
        }
        self.last_emitted_count = Some(count);
        self.last_emitted_at = Some(now);
        true
    }

    pub(crate) fn record_final(&mut self, count: u32) -> bool {
        if self.last_emitted_count == Some(count) {
            return false;
        }
        self.last_emitted_count = Some(count);
        true
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct RunningProgressUpdate {
    pub(crate) progress: f32,
    pub(crate) count: Option<u32>,
}

#[cfg(test)]
type RunningProgressOverride = Box<dyn FnMut(&RunningProgressUpdate) -> Option<Result<(), Error>>>;

#[cfg(test)]
std::thread_local! {
    static RUNNING_PROGRESS_OVERRIDE: std::cell::RefCell<Option<RunningProgressOverride>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_running_progress_override(
    override_fn: Option<impl FnMut(&RunningProgressUpdate) -> Option<Result<(), Error>> + 'static>,
) {
    RUNNING_PROGRESS_OVERRIDE.with(|slot| {
        *slot.borrow_mut() = override_fn.map(|f| Box::new(f) as RunningProgressOverride);
    });
}

#[cfg(test)]
pub(crate) fn clear_running_progress_override() {
    RUNNING_PROGRESS_OVERRIDE.with(|slot| *slot.borrow_mut() = None);
}

#[derive(Clone, Debug, PartialEq, Serialize, Type)]
pub struct ProgressItem {
    pub id: String,
    pub generation: ProgressGeneration,
    pub progress: f32,
    pub finished: bool,
    pub state: ProgressState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub failure: Option<ErrorPayload>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, Type, Event)]
pub struct ProgressEvent {
    pub id: String,
    pub generation: ProgressGeneration,
    pub progress: f32,
    pub finished: bool,
    pub state: ProgressState,
    pub cleared: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub failure: Option<ErrorPayload>,
}

#[derive(Clone)]
struct StoredProgress {
    item: ProgressItem,
    updated_at: Instant,
    last_access: u64,
}

#[derive(Default)]
struct ProgressStoreState {
    entries: HashMap<String, StoredProgress>,
    access_clock: u64,
    generation_clock: u64,
}

/// Every update is authenticated by a generation-bound lease. A caller can
/// report only a job it explicitly started; no stale or arbitrary ID can
/// recreate an entry after completion, restart, eviction, or clear.
#[derive(Clone, Default)]
pub struct ProgressStore {
    state: std::sync::Arc<Mutex<ProgressStoreState>>,
}

impl ProgressStore {
    fn ttl(item: &ProgressItem) -> Duration {
        if item.state.is_terminal() {
            TERMINAL_TTL
        } else {
            RUNNING_TTL
        }
    }

    fn tick_access(state: &mut ProgressStoreState) -> u64 {
        state.access_clock = state.access_clock.saturating_add(1);
        state.access_clock
    }

    fn next_generation(state: &mut ProgressStoreState) -> Result<ProgressGeneration, Error> {
        let next = state
            .generation_clock
            .checked_add(1)
            .ok_or_else(|| Error::Conflict("progress generation exhausted".into()))?;
        state.generation_clock = next;
        Ok(ProgressGeneration(next))
    }

    fn purge_expired_at(state: &mut ProgressStoreState, now: Instant) {
        state.entries.retain(|_, stored| {
            now.saturating_duration_since(stored.updated_at) < Self::ttl(&stored.item)
        });
    }

    fn evict_to_capacity(state: &mut ProgressStoreState) {
        while state.entries.len() >= PROGRESS_CAPACITY {
            let eviction = state
                .entries
                .iter()
                .min_by(|(left_id, left), (right_id, right)| {
                    left.last_access
                        .cmp(&right.last_access)
                        .then_with(|| left_id.cmp(right_id))
                })
                .map(|(id, _)| id.clone());
            if let Some(id) = eviction {
                state.entries.remove(&id);
            } else {
                break;
            }
        }
    }

    fn sanitize(progress: f32) -> f32 {
        if progress.is_finite() {
            progress.clamp(0.0, 100.0)
        } else {
            0.0
        }
    }

    #[cfg(test)]
    fn start_with_snapshot_at(
        &self,
        id: String,
        now: Instant,
        observe: Option<&mut dyn FnMut()>,
    ) -> Result<(ProgressLease, ProgressItem), Error> {
        self.start_with_count_snapshot_at(id, None, now, observe)
    }

    fn start_with_count_snapshot_at(
        &self,
        id: String,
        initial_count: Option<u32>,
        now: Instant,
        #[cfg(test)] observe: Option<&mut dyn FnMut()>,
    ) -> Result<(ProgressLease, ProgressItem), Error> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Conflict("progress store poisoned".into()))?;
        let generation = Self::next_generation(&mut state)?;
        Self::purge_expired_at(&mut state, now);
        // Starting the same ID deliberately invalidates its former producer.
        state.entries.remove(&id);
        Self::evict_to_capacity(&mut state);
        let last_access = Self::tick_access(&mut state);
        let item = ProgressItem {
            id: id.clone(),
            generation,
            progress: 0.0,
            finished: false,
            state: ProgressState::Running,
            count: initial_count,
            failure: None,
        };
        state.entries.insert(
            id.clone(),
            StoredProgress {
                item: item.clone(),
                updated_at: now,
                last_access,
            },
        );
        let lease = ProgressLease { id, generation };
        drop(state);
        #[cfg(test)]
        if let Some(observe) = observe {
            observe();
        }
        Ok((lease, item))
    }

    #[cfg(test)]
    fn start_at(&self, id: String, now: Instant) -> Result<ProgressLease, Error> {
        self.start_with_snapshot_at(id, now, None)
            .map(|(lease, _)| lease)
    }

    #[cfg(test)]
    pub fn start(&self, id: String) -> Result<ProgressLease, Error> {
        self.start_with_snapshot_at(id, Instant::now(), None)
            .map(|(lease, _)| lease)
    }

    #[cfg(test)]
    fn transition_at(
        &self,
        lease: &ProgressLease,
        progress: f32,
        requested_state: ProgressState,
        now: Instant,
    ) -> Result<(ProgressItem, bool), Error> {
        self.transition_with_failure_and_count_at(lease, progress, requested_state, None, None, now)
    }

    #[cfg(test)]
    fn transition_with_failure_at(
        &self,
        lease: &ProgressLease,
        progress: f32,
        requested_state: ProgressState,
        failure: Option<ErrorPayload>,
        now: Instant,
    ) -> Result<(ProgressItem, bool), Error> {
        self.transition_with_failure_and_count_at(
            lease,
            progress,
            requested_state,
            failure,
            None,
            now,
        )
    }

    fn transition_with_failure_and_count_at(
        &self,
        lease: &ProgressLease,
        progress: f32,
        requested_state: ProgressState,
        failure: Option<ErrorPayload>,
        count: Option<u32>,
        now: Instant,
    ) -> Result<(ProgressItem, bool), Error> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Conflict("progress store poisoned".into()))?;
        Self::purge_expired_at(&mut state, now);
        let last_access = Self::tick_access(&mut state);
        let stored = state
            .entries
            .get_mut(&lease.id)
            .ok_or(Error::StaleProgressLease)?;
        if stored.item.generation != lease.generation {
            return Err(Error::StaleProgressLease);
        }
        let existing = &stored.item;
        let progress = Self::sanitize(progress);
        let item = if existing.state.is_terminal() {
            existing.clone()
        } else {
            let state = if requested_state.is_terminal() {
                requested_state
            } else {
                ProgressState::Running
            };
            let count = match (existing.count, count) {
                (Some(current), Some(incoming)) => Some(current.max(incoming)),
                (Some(current), None) => Some(current),
                (None, Some(incoming)) => Some(incoming),
                (None, None) => None,
            };
            ProgressItem {
                id: lease.id.clone(),
                generation: lease.generation,
                progress: progress.max(existing.progress),
                finished: state.is_terminal(),
                state,
                count,
                failure,
            }
        };
        let changed = item.progress != existing.progress
            || item.state != existing.state
            || item.count != existing.count;
        if changed {
            stored.item = item.clone();
            stored.updated_at = now;
        }
        stored.last_access = last_access;
        Ok((item, changed))
    }

    #[cfg(test)]
    pub fn transition(
        &self,
        lease: &ProgressLease,
        progress: f32,
        requested_state: ProgressState,
    ) -> Result<(ProgressItem, bool), Error> {
        self.transition_at(lease, progress, requested_state, Instant::now())
    }

    pub fn transition_with_count(
        &self,
        lease: &ProgressLease,
        progress: f32,
        count: Option<u32>,
        requested_state: ProgressState,
    ) -> Result<(ProgressItem, bool), Error> {
        self.transition_with_failure_and_count_at(
            lease,
            progress,
            requested_state,
            None,
            count,
            Instant::now(),
        )
    }

    fn get_at(&self, id: &str, now: Instant) -> Result<Option<ProgressItem>, Error> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Conflict("progress store poisoned".into()))?;
        Self::purge_expired_at(&mut state, now);
        let access = Self::tick_access(&mut state);
        Ok(state.entries.get_mut(id).map(|stored| {
            stored.last_access = access;
            stored.item.clone()
        }))
    }

    pub fn get(&self, id: &str) -> Result<Option<ProgressItem>, Error> {
        self.get_at(id, Instant::now())
    }

    pub fn failed_snapshot(&self) -> Result<Vec<ProgressItem>, Error> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Conflict("progress store poisoned".into()))?;
        Self::purge_expired_at(&mut state, Instant::now());
        Ok(state
            .entries
            .values()
            .filter(|stored| stored.item.failure.is_some())
            .map(|stored| stored.item.clone())
            .collect())
    }

    /// Clearing removes visible state and advances the global generation clock,
    /// preventing an old producer from recreating the cleared ID.
    pub fn clear(&self, id: &str) -> Result<ProgressGeneration, Error> {
        self.clear_unless_live_running(id, false)
            .map(|(generation, _)| generation)
    }

    fn clear_unless_live_running(
        &self,
        id: &str,
        live_download: bool,
    ) -> Result<(ProgressGeneration, bool), Error> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Conflict("progress store poisoned".into()))?;
        #[cfg(test)]
        CLEAR_DECISION_HOOKS.run(&id.to_owned());
        if live_download {
            if let Some(stored) = state.entries.get(id) {
                if stored.item.state == ProgressState::Running {
                    return Ok((stored.item.generation, false));
                }
            }
        }
        let generation = Self::next_generation(&mut state)?;
        state.entries.remove(id);
        Ok((generation, true))
    }
}

/// Generic over the runtime so the emitting paths can be exercised against
/// `tauri::test::MockRuntime`; the `#[tauri::command]` entry points below stay
/// on the concrete runtime, as commands must.
fn emit<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    item: ProgressItem,
    cleared: bool,
) -> Result<(), Error> {
    ProgressEvent {
        id: item.id,
        generation: item.generation,
        progress: item.progress,
        finished: item.finished,
        state: item.state,
        cleared,
        count: item.count,
        failure: item.failure,
    }
    .emit(app)?;
    Ok(())
}

pub fn begin_progress<R: tauri::Runtime>(
    store: &ProgressStore,
    app: &tauri::AppHandle<R>,
    id: String,
) -> Result<ProgressLease, Error> {
    begin_progress_with_count(store, app, id, None)
}

pub fn begin_progress_with_count<R: tauri::Runtime>(
    store: &ProgressStore,
    app: &tauri::AppHandle<R>,
    id: String,
    initial_count: Option<u32>,
) -> Result<ProgressLease, Error> {
    begin_progress_with_count_emitter(store, id, initial_count, |item| emit(app, item, false))
}

#[cfg(test)]
fn begin_progress_with_emitter(
    store: &ProgressStore,
    id: String,
    emit_item: impl FnOnce(ProgressItem) -> Result<(), Error>,
) -> Result<ProgressLease, Error> {
    begin_progress_with_count_emitter(store, id, None, emit_item)
}

fn begin_progress_with_count_emitter(
    store: &ProgressStore,
    id: String,
    initial_count: Option<u32>,
    emit_item: impl FnOnce(ProgressItem) -> Result<(), Error>,
) -> Result<ProgressLease, Error> {
    let (lease, item) = store.start_with_count_snapshot_at(
        id,
        initial_count,
        Instant::now(),
        #[cfg(test)]
        None,
    )?;
    // Delivery failure must not leave a successfully started job without its owner.
    if let Err(error) = emit_item(item) {
        log::error!(
            "progress start event failed for {} generation {}: {error:?}",
            lease.id,
            lease.generation
        );
    }
    Ok(lease)
}

pub fn update_progress_with_state<R: tauri::Runtime>(
    store: &ProgressStore,
    app: &tauri::AppHandle<R>,
    lease: &ProgressLease,
    progress: f32,
    state: ProgressState,
) -> Result<(), Error> {
    update_progress_with_count(store, app, lease, progress, None, state)
}

pub fn update_progress_with_count<R: tauri::Runtime>(
    store: &ProgressStore,
    app: &tauri::AppHandle<R>,
    lease: &ProgressLease,
    progress: f32,
    count: Option<u32>,
    state: ProgressState,
) -> Result<(), Error> {
    update_progress_with_count_emitter(store, lease, progress, count, state, |item| {
        emit(app, item, false)
    })
}

pub(crate) fn publish_download_failure<R: tauri::Runtime>(
    store: &ProgressStore,
    app: &tauri::AppHandle<R>,
    lease: &ProgressLease,
    failure: ErrorPayload,
) -> Result<(), Error> {
    let (item, changed) = store.transition_with_failure_and_count_at(
        lease,
        0.0,
        ProgressState::Failed,
        Some(failure),
        None,
        Instant::now(),
    )?;
    if changed {
        emit(app, item, false)?;
    }
    Ok(())
}

fn update_progress_with_emitter(
    store: &ProgressStore,
    lease: &ProgressLease,
    progress: f32,
    state: ProgressState,
    emit_item: impl FnOnce(ProgressItem) -> Result<(), Error>,
) -> Result<(), Error> {
    update_progress_with_count_emitter(store, lease, progress, None, state, emit_item)
}

fn update_progress_with_count_emitter(
    store: &ProgressStore,
    lease: &ProgressLease,
    progress: f32,
    count: Option<u32>,
    state: ProgressState,
    emit_item: impl FnOnce(ProgressItem) -> Result<(), Error>,
) -> Result<(), Error> {
    let (item, changed) = store.transition_with_count(lease, progress, count, state)?;
    if changed {
        emit_item(item)?;
    }
    Ok(())
}

/// Reports a running progress/count update through `handle_running_progress_result`,
/// cancelling on a stale lease and logging any other emission error once per operation.
pub(crate) fn report_running_progress<R: tauri::Runtime>(
    store: &ProgressStore,
    app: &tauri::AppHandle<R>,
    lease: &ProgressLease,
    update: RunningProgressUpdate,
    operation: &str,
    diagnosed: &AtomicBool,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    let result = update_progress_with_count(
        store,
        app,
        lease,
        update.progress,
        update.count,
        ProgressState::Running,
    );
    #[cfg(test)]
    let result = RUNNING_PROGRESS_OVERRIDE
        .with(|slot| slot.borrow_mut().as_mut().and_then(|f| f(&update)))
        .unwrap_or(result);
    handle_running_progress_result(result, operation, lease, diagnosed, Some(cancellation))
}

/// Running updates are best effort, except a revoked lease cancels a token-owning operation.
pub(crate) fn handle_running_progress_result(
    result: Result<(), Error>,
    operation: &str,
    lease: &ProgressLease,
    diagnosed: &AtomicBool,
    cancellation: Option<&CancellationToken>,
) -> Result<(), Error> {
    if let Err(error) = result {
        if matches!(error, Error::StaleProgressLease) {
            if let Some(cancellation) = cancellation {
                cancellation.cancel();
                return Err(Error::Cancellation);
            }
            return Ok(());
        }
        if !diagnosed.swap(true, Ordering::Relaxed) {
            log::error!(
                "{operation} progress update failed for {} generation {}: {error:?}",
                lease.id,
                lease.generation
            );
        }
    }
    Ok(())
}

/// Records terminal progress without allowing progress delivery to replace the work result.
pub fn complete_preserving_result<T>(
    result: Result<T, Error>,
    complete: impl FnOnce(ProgressState),
) -> Result<T, Error> {
    complete(match &result {
        Ok(_) => ProgressState::Succeeded,
        Err(Error::Cancellation) => ProgressState::Cancelled,
        Err(_) => ProgressState::Failed,
    });
    result
}

/// Job progress goes through the one shared progress store instead of a
/// bespoke event, so the renderer's `useProgress` subscription, the generation
/// leases and the bounded retention policy apply to a long-running job exactly
/// as they do to every other.
pub struct JobProgress<R: tauri::Runtime = tauri::Wry> {
    app: tauri::AppHandle<R>,
    lease: ProgressLease,
}

impl<R: tauri::Runtime> JobProgress<R> {
    pub fn new(app: tauri::AppHandle<R>, id: String) -> Result<Self, Error> {
        let lease = {
            let state = app.state::<AppState>();
            begin_progress(&state.progress_state, &app, id)?
        };
        Ok(Self { app, lease })
    }

    /// Starts optional progress reporting without changing the data operation's outcome.
    /// Initialization failures are diagnosed with a fixed operation label and opaque progress id.
    pub fn best_effort(
        app: tauri::AppHandle<R>,
        id: String,
        operation: &'static str,
    ) -> Option<Self> {
        match Self::new(app, id.clone()) {
            Ok(progress) => Some(progress),
            Err(error) => {
                log::error!("progress initialization failed for {operation} ({id}): {error}");
                None
            }
        }
    }

    pub fn lease(&self) -> ProgressLease {
        self.lease.clone()
    }

    pub fn complete(&self, state: ProgressState) {
        let progress = if matches!(state, ProgressState::Succeeded) {
            100.0
        } else {
            0.0
        };
        self.transition(progress, state);
    }

    /// A lease superseded by a newer job on the same id, or cleared by the
    /// user, makes the transition fail. That is the intended outcome — the older
    /// producer must not drive the newer bar — and it must not abort the job
    /// that is still running.
    fn transition(&self, progress: f32, state: ProgressState) {
        let app_state = self.app.state::<AppState>();
        self.transition_with(
            &app_state.progress_state,
            progress,
            state,
            |item| emit(&self.app, item, false),
            |message| log::error!("{message}"),
        );
    }

    fn transition_with(
        &self,
        store: &ProgressStore,
        progress: f32,
        state: ProgressState,
        emit_item: impl FnOnce(ProgressItem) -> Result<(), Error>,
        diagnose: impl FnOnce(String),
    ) {
        if let Err(error) =
            update_progress_with_emitter(store, &self.lease, progress, state, emit_item)
        {
            if !matches!(error, Error::StaleProgressLease) {
                diagnose(format!(
                    "progress update failed for {} generation {}: {error}",
                    self.lease.id, self.lease.generation
                ));
            }
        }
    }
}

impl<R: tauri::Runtime> Drop for JobProgress<R> {
    /// A job dropped without a terminal transition was cancelled. The store
    /// keeps the first terminal state it is given, so this is a no-op after
    /// `complete` and only fires on a genuinely abandoned job.
    fn drop(&mut self) {
        self.transition(0.0, ProgressState::Cancelled);
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_progress(
    id: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Option<ProgressItem>, Error> {
    state.progress_state.get(&id)
}

#[tauri::command]
#[specta::specta]
pub fn failed_progress_snapshot(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<ProgressItem>, Error> {
    state.progress_state.failed_snapshot()
}

#[tauri::command]
#[specta::specta]
pub fn clear_progress(
    id: String,
    state: tauri::State<'_, crate::AppState>,
    app: tauri::AppHandle,
) -> Result<ProgressGeneration, Error> {
    clear_progress_with(&state.progress_state, &state.operations, id, &mut |item| {
        emit(&app, item, true)
    })
}

fn clear_progress_with(
    store: &ProgressStore,
    operations: &OperationRegistry,
    id: String,
    emit_cleared: &mut dyn FnMut(ProgressItem) -> Result<(), Error>,
) -> Result<ProgressGeneration, Error> {
    let (generation, cleared) =
        operations.with_live_download_for_progress(&id, |live_download| {
            if live_download {
                store.clear_unless_live_running(&id, true)
            } else {
                store.clear(&id).map(|generation| (generation, true))
            }
        })??;
    if !cleared {
        return Ok(generation);
    }
    let item = ProgressItem {
        id: id.clone(),
        generation,
        progress: 0.0,
        finished: true,
        state: ProgressState::Cancelled,
        count: None,
        failure: None,
    };
    if let Err(error) = emit_cleared(item) {
        log::warn!(
            "cleared progress event could not be emitted for {id} generation {generation}: {error}"
        );
    }
    Ok(generation)
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, thread, time::Duration};

    use super::*;
    use tauri::Manager;

    // None represents an omitted field, distinct from a JSON null generation.
    fn generation_protocol_cases() -> Vec<(Option<serde_json::Value>, Result<u64, &'static str>)> {
        let mut cases = Vec::new();
        for number in [
            0,
            9_007_199_254_740_991,
            9_007_199_254_740_992,
            9_007_199_254_740_993,
            9_007_199_254_740_994,
            u64::MAX - 1,
            u64::MAX,
        ] {
            cases.push((Some(serde_json::json!(number.to_string())), Ok(number)));
        }
        for value in [
            "",
            "00",
            "01",
            "+1",
            "-1",
            " 1",
            "1 ",
            "1.0",
            "1e3",
            "١",
            "184467440737095516160",
        ] {
            cases.push((
                Some(serde_json::json!(value)),
                Err("invalid progress generation"),
            ));
        }
        cases.push((
            Some(serde_json::json!("18446744073709551616")),
            Err("number too large to fit in target type"),
        ));
        for (value, message) in [
            (
                serde_json::json!(1),
                "invalid type: integer `1`, expected a string",
            ),
            (
                serde_json::json!(null),
                "invalid type: null, expected a string",
            ),
            (
                serde_json::json!(true),
                "invalid type: boolean `true`, expected a string",
            ),
            (
                serde_json::json!(1.5),
                "invalid type: floating point `1.5`, expected a string",
            ),
            (
                serde_json::json!([]),
                "invalid type: sequence, expected a string",
            ),
            (
                serde_json::json!({}),
                "invalid type: map, expected a string",
            ),
        ] {
            cases.push((Some(value), Err(message)));
        }
        cases.push((None, Err("missing field `generation`")));
        cases
    }

    fn assert_generation_protocol_case<T>(payload: serde_json::Value, expected: Result<T, &str>)
    where
        T: serde::de::DeserializeOwned + Serialize + PartialEq + std::fmt::Debug,
    {
        let wire = payload.to_string();
        for (boundary, decoded) in [
            ("from_value", serde_json::from_value::<T>(payload.clone())),
            ("from_str", serde_json::from_str::<T>(&wire)),
        ] {
            let context = format!("{} {boundary}: {wire}", std::any::type_name::<T>());
            match &expected {
                Ok(expected) => {
                    let actual = decoded.unwrap_or_else(|error| panic!("{context}: {error}"));
                    assert_eq!(&actual, expected, "{context}");
                    assert_eq!(serde_json::to_value(&actual).unwrap(), payload, "{context}");
                }
                Err(expected_message) => {
                    let error =
                        decoded.expect_err(&format!("{context}: accepted invalid generation"));
                    assert_eq!(
                        error.classify(),
                        serde_json::error::Category::Data,
                        "{context}"
                    );
                    let message = error.to_string();
                    let location = format!(" at line {} column {}", error.line(), error.column());
                    assert_eq!(
                        message.strip_suffix(&location).unwrap_or(&message),
                        *expected_message,
                        "{context} error compatibility"
                    );
                }
            }
        }
    }

    #[test]
    fn generations_round_trip_as_exact_decimal_strings_on_every_surface() {
        for (digits, expected) in generation_protocol_cases() {
            let Ok(number) = expected else { continue };
            let digits = digits.unwrap();
            let generation = ProgressGeneration(number);
            assert_eq!(
                serde_json::to_string(&generation).unwrap(),
                format!("\"{number}\"")
            );
            assert_generation_protocol_case(digits.clone(), Ok(generation));
            let lease = ProgressLease {
                id: "job".into(),
                generation,
            };
            assert_generation_protocol_case(
                serde_json::json!({ "id": "job", "generation": digits }),
                Ok(lease),
            );
            let item = ProgressItem {
                id: "job".into(),
                generation,
                progress: 30.0,
                finished: false,
                state: ProgressState::Running,
                count: None,
                failure: None,
            };
            let event = ProgressEvent {
                id: "job".into(),
                generation,
                progress: 30.0,
                finished: false,
                state: ProgressState::Running,
                cleared: false,
                count: None,
                failure: None,
            };
            assert_eq!(serde_json::to_value(&item).unwrap()["generation"], digits);
            assert_generation_protocol_case(
                serde_json::json!({
                    "id": "job", "generation": digits, "progress": 30.0,
                    "finished": false, "state": "running", "cleared": false,
                }),
                Ok(event),
            );
        }
    }

    #[test]
    fn generations_reject_noncanonical_or_out_of_range_wire_values() {
        for (value, expected) in generation_protocol_cases() {
            let Err(message) = expected else { continue };
            let mut lease = serde_json::json!({ "id": "job" });
            let mut event = serde_json::json!({
                "id": "job", "progress": 30.0,
                "finished": false, "state": "running", "cleared": false,
            });
            if let Some(value) = value {
                assert_generation_protocol_case::<ProgressGeneration>(value.clone(), Err(message));
                lease["generation"] = value.clone();
                event["generation"] = value;
            }
            assert_generation_protocol_case::<ProgressLease>(lease, Err(message));
            assert_generation_protocol_case::<ProgressEvent>(event, Err(message));
        }
    }

    #[test]
    fn high_generations_remain_distinct_and_exhaustion_preserves_the_store() {
        let store = ProgressStore::default();
        store.state.lock().unwrap().generation_clock = 9_007_199_254_740_992;
        let first = store.start("job".into()).unwrap();
        let second = store.start("job".into()).unwrap();
        assert_eq!(first.generation, 9_007_199_254_740_993);
        assert_eq!(second.generation, 9_007_199_254_740_994);
        assert!(matches!(
            store.transition(&first, 50.0, ProgressState::Running),
            Err(Error::StaleProgressLease)
        ));

        let now = Instant::now();
        for index in 0..PROGRESS_CAPACITY {
            store.start_at(format!("capacity-{index}"), now).unwrap();
        }
        store.state.lock().unwrap().generation_clock = u64::MAX - 1;
        let last = store.start_at("job".into(), now).unwrap();
        assert_eq!(last.generation, u64::MAX);
        let before = {
            let state = store.state.lock().unwrap();
            (state.entries.clone(), state.access_clock)
        };
        for id in ["job", "new"] {
            assert!(matches!(
                store.start_at(id.into(), now + RUNNING_TTL),
                Err(Error::Conflict(_))
            ));
            let capture = crate::error::LogCaptureScope::start();
            assert!(matches!(
                begin_progress_with_emitter(&store, id.into(), |_| panic!(
                    "exhausted start must not emit"
                )),
                Err(Error::Conflict(message)) if message == "progress generation exhausted"
            ));
            assert!(capture.records().is_empty());
            assert!(matches!(store.clear(id), Err(Error::Conflict(_))));
        }
        let state = store.state.lock().unwrap();
        assert_eq!(state.generation_clock, u64::MAX);
        assert_eq!(state.access_clock, before.1);
        assert_eq!(state.entries.len(), before.0.len());
        for (id, entry) in &before.0 {
            let after = &state.entries[id];
            assert_eq!(after.item, entry.item);
            assert_eq!(after.updated_at, entry.updated_at);
            assert_eq!(after.last_access, entry.last_access);
        }
        drop(state);
        assert!(matches!(
            store.transition(&second, 50.0, ProgressState::Running),
            Err(Error::StaleProgressLease)
        ));
        assert!(store
            .transition(&last, 50.0, ProgressState::Running)
            .is_ok());
    }

    #[test]
    fn exhaustion_keeps_live_download_noop_clear_and_rejects_other_clears_without_emitting() {
        let store = ProgressStore::default();
        let operations = OperationRegistry::default();
        let ticket = operations.prepare_download("main").unwrap();
        let download = operations
            .claim_download(&ticket, "main", "download", "job", "job", false, 8)
            .unwrap();
        store.state.lock().unwrap().generation_clock = u64::MAX - 1;
        let lease = store.start("job".into()).unwrap();
        let mut emit = |_| -> Result<(), Error> { panic!("exhausted clear must not emit") };
        assert_eq!(
            clear_progress_with(&store, &operations, "job".into(), &mut emit).unwrap(),
            lease.generation
        );
        drop(download);
        assert!(matches!(
            clear_progress_with(&store, &operations, "job".into(), &mut emit),
            Err(Error::Conflict(_))
        ));
        assert_eq!(
            store.get("job").unwrap().unwrap().generation,
            lease.generation
        );
        assert_eq!(store.state.lock().unwrap().generation_clock, u64::MAX);
    }

    #[test]
    fn stale_reporter_is_rejected_after_restart_and_clear() {
        let store = ProgressStore::default();
        let first = store.start("job".into()).unwrap();
        let second = store.start("job".into()).unwrap();
        assert!(store
            .transition(&first, 50.0, ProgressState::Running)
            .is_err());
        store.clear("job").unwrap();
        assert!(store
            .transition(&second, 50.0, ProgressState::Running)
            .is_err());
        let third = store.start("job".into()).unwrap();
        assert!(third.generation > second.generation);
    }

    #[test]
    fn clear_progress_excludes_download_admission_through_the_store_decision() {
        use std::sync::atomic::{AtomicBool, Ordering};

        for live_download in [false, true] {
            let store = ProgressStore::default();
            let operations = OperationRegistry::default();
            let id = uuid::Uuid::new_v4().to_string();
            store.start(id.clone()).unwrap();
            let _download = live_download.then(|| {
                let ticket = operations.prepare_download("main").unwrap();
                operations
                    .claim_download(&ticket, "main", "download", &id, &id, false, 8)
                    .unwrap()
            });
            let observed = Arc::new(AtomicBool::new(false));
            let hook_observed = observed.clone();
            let hook_operations = operations.clone();
            let hook_store = store.clone();
            CLEAR_DECISION_HOOKS.arm(
                id.clone(),
                Box::new(move || {
                    assert!(
                        hook_operations.download_admission_is_locked_for_test(),
                        "clear_progress must hold download admission through the store clear decision"
                    );
                    assert!(matches!(
                        hook_store.state.try_lock(),
                        Err(std::sync::TryLockError::WouldBlock)
                    ));
                    hook_observed.store(true, Ordering::SeqCst);
                }),
            );
            let mut emitted = false;
            clear_progress_with(&store, &operations, id, &mut |_| {
                assert!(!operations.download_admission_is_locked_for_test());
                assert!(store.state.try_lock().is_ok());
                emitted = true;
                Ok(())
            })
            .unwrap();
            assert!(
                observed.load(Ordering::SeqCst),
                "clear_progress must reach the store clear decision hook"
            );
            assert_eq!(emitted, !live_download);
        }
    }

    #[test]
    fn clear_returns_generation_when_the_cleared_event_cannot_be_emitted() {
        let store = ProgressStore::default();
        store.start("job".into()).unwrap();
        let generation = clear_progress_with(
            &store,
            &OperationRegistry::default(),
            "job".into(),
            &mut |_item| Err(Error::Conflict("event channel unavailable".into())),
        )
        .unwrap();

        assert_ne!(generation, 0);
        assert!(store.get("job").unwrap().is_none());
    }

    #[test]
    fn clear_preserves_live_running_download_generation_and_emits_nothing() {
        let store = ProgressStore::default();
        let operations = OperationRegistry::default();
        let ticket = operations.prepare_download("other-owner").unwrap();
        let _download = operations
            .claim_download(&ticket, "other-owner", "download", "job", "job", false, 8)
            .unwrap();
        let lease = store.start("job".into()).unwrap();
        store
            .transition(&lease, 35.0, ProgressState::Running)
            .unwrap();
        let before = store.get("job").unwrap().unwrap();
        let generation = clear_progress_with(&store, &operations, "job".into(), &mut |_| {
            panic!("a preserved running item must not emit a clear")
        })
        .unwrap();
        assert_eq!(generation, lease.generation);
        assert_eq!(store.get("job").unwrap().unwrap(), before);
        assert_eq!(
            store.state.lock().unwrap().generation_clock,
            lease.generation
        );
        assert!(
            store
                .transition(&lease, 50.0, ProgressState::Running)
                .unwrap()
                .1
        );
    }

    #[test]
    fn clear_removes_running_progress_after_download_cancel_or_lease_drop() {
        for drop_lease in [false, true] {
            let store = ProgressStore::default();
            let operations = OperationRegistry::default();
            let ticket = operations.prepare_download("main").unwrap();
            let download = operations
                .claim_download(&ticket, "main", "download", "job", "job", false, 8)
                .unwrap();
            let lease = store.start("job".into()).unwrap();
            if drop_lease {
                drop(download);
            } else {
                operations
                    .cancel_download_for_progress("job", "main")
                    .unwrap();
            }
            let mut emitted = Vec::new();
            let generation = clear_progress_with(&store, &operations, "job".into(), &mut |item| {
                emitted.push(item);
                Ok(())
            })
            .unwrap();
            assert!(generation > lease.generation);
            assert!(store.get("job").unwrap().is_none());
            assert!(matches!(
                store.transition(&lease, 50.0, ProgressState::Running),
                Err(Error::StaleProgressLease)
            ));
            assert_eq!(emitted.len(), 1);
            assert_eq!(emitted[0].generation, generation);
            assert_eq!(emitted[0].state, ProgressState::Cancelled);
        }
    }

    #[test]
    fn clear_clears_terminal_or_absent_items_even_with_a_live_download() {
        for terminal in [
            Some(ProgressState::Succeeded),
            Some(ProgressState::Failed),
            Some(ProgressState::Cancelled),
            None,
        ] {
            let store = ProgressStore::default();
            let operations = OperationRegistry::default();
            let ticket = operations.prepare_download("main").unwrap();
            let download = operations
                .claim_download(&ticket, "main", "download", "job", "job", false, 8)
                .unwrap();
            let previous_generation = if let Some(terminal) = terminal {
                let lease = store.start("job".into()).unwrap();
                store.transition(&lease, 35.0, terminal).unwrap();
                lease.generation.to_string().parse::<u64>().unwrap()
            } else {
                0
            };
            let mut emitted = Vec::new();
            let generation = clear_progress_with(&store, &operations, "job".into(), &mut |item| {
                emitted.push(item);
                Ok(())
            })
            .unwrap();
            assert!(generation.to_string().parse::<u64>().unwrap() > previous_generation);
            assert!(store.get("job").unwrap().is_none());
            assert_eq!(emitted.len(), 1);
            assert_eq!(emitted[0].generation, generation);
            assert!(!download.token().is_cancelled());
        }
    }

    #[test]
    fn clear_does_not_preserve_an_unrelated_running_item_and_propagates_registry_failure() {
        let store = ProgressStore::default();
        let operations = OperationRegistry::default();
        let ticket = operations.prepare_download("main").unwrap();
        let _download = operations
            .claim_download(&ticket, "main", "download", "other", "other", false, 8)
            .unwrap();
        let lease = store.start("job".into()).unwrap();
        let generation =
            clear_progress_with(&store, &operations, "job".into(), &mut |_| Ok(())).unwrap();
        assert!(generation > lease.generation);
        assert!(store.get("job").unwrap().is_none());
        let lease = store.start("job".into()).unwrap();
        operations.poison_for_test();
        assert!(matches!(
            clear_progress_with(&store, &operations, "job".into(), &mut |_| panic!(
                "registry failure must not emit"
            )),
            Err(Error::Conflict(_))
        ));
        assert_eq!(
            store.get("job").unwrap().unwrap().generation,
            lease.generation
        );
    }

    #[test]
    fn terminal_transition_is_immutable_and_all_terminal_states_are_explicit() {
        let store = ProgressStore::default();
        let success = store.start("success".into()).unwrap();
        let (done, _) = store
            .transition(&success, 100.0, ProgressState::Succeeded)
            .unwrap();
        let (unchanged, changed) = store
            .transition(&success, 0.0, ProgressState::Failed)
            .unwrap();
        assert!(!changed);
        assert_eq!(unchanged, done);

        for terminal in [ProgressState::Failed, ProgressState::Cancelled] {
            let lease = store.start(format!("{terminal:?}")).unwrap();
            assert_eq!(
                store.transition(&lease, 10.0, terminal).unwrap().0.state,
                terminal
            );
        }
    }

    #[test]
    fn failed_progress_snapshot_returns_payload_without_clearing() {
        let store = ProgressStore::default();
        let lease = store.start("file".into()).unwrap();
        let (failed, _) = store
            .transition_with_failure_at(
                &lease,
                37.0,
                ProgressState::Failed,
                Some(Error::InvalidInput("Download failed".into()).renderer_payload()),
                Instant::now(),
            )
            .unwrap();
        let without_payload = store.start("without-payload".into()).unwrap();
        store
            .transition(&without_payload, 12.0, ProgressState::Failed)
            .unwrap();
        store.start("running".into()).unwrap();
        let cleared = store.start("cleared".into()).unwrap();
        store
            .transition_with_failure_at(
                &cleared,
                15.0,
                ProgressState::Failed,
                failed.failure.clone(),
                Instant::now(),
            )
            .unwrap();
        store.clear("cleared").unwrap();

        assert_eq!(store.failed_snapshot().unwrap(), vec![failed.clone()]);
        assert_eq!(store.get("file").unwrap(), Some(failed.clone()));
        assert_eq!(store.failed_snapshot().unwrap(), vec![failed]);
        assert!(store.get("cleared").unwrap().is_none());
    }

    #[test]
    fn download_failure_payload_keeps_high_water() {
        let app = job_progress_test_app();
        let store = ProgressStore::default();
        let lease = begin_progress(&store, &app, "file".into()).unwrap();
        update_progress_with_state(&store, &app, &lease, 37.0, ProgressState::Running).unwrap();
        let payload = Error::RemoteHttpRejection(crate::error::RemoteHttpRejection {
            status: 403,
            authorization_sent: true,
        })
        .renderer_payload();
        let events = Arc::new(Mutex::new(Vec::<ProgressEvent>::new()));
        let observed = events.clone();
        let listener = ProgressEvent::listen(&app, move |event| {
            observed.lock().unwrap().push(event.payload);
        });
        publish_download_failure(&store, &app, &lease, payload.clone()).unwrap();
        let failed = store.get("file").unwrap().unwrap();
        assert_eq!(failed.progress, 37.0);
        assert_eq!(failed.state, ProgressState::Failed);
        assert!(failed.finished);
        assert_eq!(failed.failure, Some(payload.clone()));
        assert_eq!(events.lock().unwrap().len(), 1);
        let event = events.lock().unwrap()[0].clone();
        assert_eq!(event.failure, Some(payload));
        assert_eq!(event.progress, 37.0);
        assert_eq!(event.state, ProgressState::Failed);
        let wire = serde_json::to_value(&event).unwrap();
        assert!(wire["failure"].get("progressGeneration").is_none());
        assert_eq!(
            serde_json::from_value::<ProgressEvent>(wire).unwrap(),
            event
        );

        publish_download_failure(&store, &app, &lease, Error::Cancellation.renderer_payload())
            .unwrap();
        update_progress_with_state(&store, &app, &lease, 100.0, ProgressState::Succeeded).unwrap();
        assert_eq!(store.get("file").unwrap().unwrap(), failed);
        assert_eq!(events.lock().unwrap().len(), 1);
        clear_progress_with(
            &store,
            &OperationRegistry::default(),
            "file".into(),
            &mut |item| {
                assert!(item.failure.is_none());
                emit(&app, item, true)
            },
        )
        .unwrap();
        let cleared = events.lock().unwrap().last().unwrap().clone();
        assert!(cleared.cleared);
        assert!(cleared.failure.is_none());
        assert!(serde_json::to_value(cleared)
            .unwrap()
            .get("failure")
            .is_none());
        tauri::Listener::unlisten(&app, listener);

        for terminal in [
            ProgressState::Succeeded,
            ProgressState::Cancelled,
            ProgressState::Failed,
        ] {
            let lease = store.start("terminal".into()).unwrap();
            let (original, _) = store.transition(&lease, 15.0, terminal).unwrap();
            publish_download_failure(&store, &app, &lease, Error::Cancellation.renderer_payload())
                .unwrap();
            assert_eq!(store.get("terminal").unwrap().unwrap(), original);
        }
    }

    #[test]
    fn stale_lease_cannot_attach_download_failure() {
        let app = job_progress_test_app();
        let store = ProgressStore::default();
        let stale = store.start("file".into()).unwrap();
        let current = store.start("file".into()).unwrap();
        let original = store.get("file").unwrap().unwrap();
        assert!(matches!(
            publish_download_failure(&store, &app, &stale, Error::Cancellation.renderer_payload()),
            Err(Error::StaleProgressLease)
        ));
        assert_eq!(store.get("file").unwrap().unwrap(), original);
        store.clear("file").unwrap();
        assert!(matches!(
            publish_download_failure(
                &store,
                &app,
                &current,
                Error::Cancellation.renderer_payload()
            ),
            Err(Error::StaleProgressLease)
        ));
        assert!(store.get("file").unwrap().is_none());
    }

    #[test]
    fn concurrent_reporters_cannot_regress_or_replace_terminal_state() {
        let store = Arc::new(ProgressStore::default());
        let lease = store.start("job".into()).unwrap();
        let mut workers = Vec::new();
        for progress in [10.0, 90.0, 25.0, 75.0, f32::NAN, 101.0] {
            let store = store.clone();
            let lease = lease.clone();
            workers.push(thread::spawn(move || {
                store
                    .transition(&lease, progress, ProgressState::Running)
                    .unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(store.get("job").unwrap().unwrap().progress, 100.0);
        store
            .transition(&lease, 100.0, ProgressState::Succeeded)
            .unwrap();
        assert_eq!(
            store
                .transition(&lease, 5.0, ProgressState::Running)
                .unwrap()
                .0
                .state,
            ProgressState::Succeeded
        );
    }

    #[test]
    fn reads_expire_terminal_entries_earlier_than_running_entries() {
        let store = ProgressStore::default();
        let now = Instant::now();
        let done = store.start_at("done".into(), now).unwrap();
        let running = store.start_at("running".into(), now).unwrap();
        store
            .transition_at(&done, 100.0, ProgressState::Succeeded, now)
            .unwrap();
        store
            .transition_at(&running, 50.0, ProgressState::Running, now)
            .unwrap();
        let after_terminal_ttl = now + TERMINAL_TTL + Duration::from_millis(1);
        assert!(store.get_at("done", after_terminal_ttl).unwrap().is_none());
        assert!(store
            .get_at("running", after_terminal_ttl)
            .unwrap()
            .is_some());
        assert!(store
            .get_at("running", now + RUNNING_TTL + Duration::from_millis(1))
            .unwrap()
            .is_none());
    }

    #[test]
    fn capacity_uses_deterministic_lru_and_evicted_producer_cannot_recreate() {
        let store = ProgressStore::default();
        let now = Instant::now();
        let mut first = None;
        let mut second = None;
        for index in 0..PROGRESS_CAPACITY {
            let lease = store.start_at(format!("{index:04}"), now).unwrap();
            if index == 0 {
                first = Some(lease);
            } else if index == 1 {
                second = Some(lease);
            }
        }
        assert!(store.get_at("0000", now).unwrap().is_some());
        store.start_at("overflow".into(), now).unwrap();
        assert!(store.get_at("0000", now).unwrap().is_some());
        assert!(store.get_at("0001", now).unwrap().is_none());
        assert!(store
            .transition(first.as_ref().unwrap(), 50.0, ProgressState::Running)
            .is_ok());
        assert!(store
            .transition(second.as_ref().unwrap(), 50.0, ProgressState::Running)
            .is_err());
    }

    fn job_progress_test_app() -> tauri::AppHandle<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events!(ProgressEvent))
            .mount_events(&app);
        app.manage(crate::AppState::default());
        app.handle().clone()
    }

    fn assert_initial_snapshot(item: &ProgressItem, lease: &ProgressLease) {
        assert_eq!(item.id, lease.id);
        assert_eq!(item.generation, lease.generation);
        assert_eq!(item.progress, 0.0);
        assert_eq!(item.state, ProgressState::Running);
        assert!(!item.finished);
    }

    #[test]
    fn start_snapshot_retains_atomic_identity_after_store_replacement() {
        let store = ProgressStore::default();
        let id = "atomic-start";
        let mut replacement = None;
        let mut observe = || {
            let newer = store.start(id.into()).unwrap();
            let item = store
                .transition(&newer, 61.0, ProgressState::Running)
                .unwrap()
                .0;
            replacement = Some((newer, item));
        };
        let (lease, item) = store
            .start_with_snapshot_at(id.into(), Instant::now(), Some(&mut observe))
            .unwrap();

        assert_eq!(lease.id, id);
        assert_eq!(lease.generation, 1);
        assert_eq!(
            item.generation, lease.generation,
            "initial snapshot must belong to the original start lease"
        );
        assert_initial_snapshot(&item, &lease);
        let (newer, stored) = replacement.unwrap();
        assert_eq!(newer.id, id);
        assert!(newer.generation > lease.generation);
        assert_eq!(stored.generation, newer.generation);
        assert_eq!(stored.progress, 61.0);
        assert_eq!(store.get(id).unwrap().unwrap(), stored);
        assert_eq!(
            store.state.lock().unwrap().generation_clock,
            newer.generation
        );
    }

    fn assert_initial_emit_diagnostic(
        capture: &crate::error::LogCaptureScope,
        lease: &ProgressLease,
        error_debug: &str,
    ) {
        let records = capture.records();
        assert_eq!(records.len(), 1, "one native initialization diagnostic");
        assert_eq!(records[0].level, log::Level::Error);
        assert_eq!(
            records[0].message,
            format!(
                "progress start event failed for {} generation {}: {error_debug}",
                lease.id, lease.generation
            )
        );
    }

    fn initial_emit_failure_lease(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        id: &str,
    ) -> ProgressLease {
        let capture = crate::error::LogCaptureScope::start();
        let store = &app.state::<AppState>().progress_state;
        let error = Error::Tauri(Box::new(tauri::Error::Io(std::io::Error::other(
            "injected native initial emitter failure",
        ))));
        let error_debug = format!("{error:?}");
        let mut initial = None;
        let lease = begin_progress_with_emitter(store, id.into(), |item| {
            assert_eq!(store.get(id).unwrap().as_ref(), Some(&item));
            initial = Some(item);
            Err(error)
        })
        .expect("failed initial delivery must return the initialized lease to its owner");
        assert_initial_snapshot(&initial.unwrap(), &lease);
        assert_initial_emit_diagnostic(&capture, &lease, &error_debug);
        lease
    }

    #[test]
    fn initial_emit_failure_returns_owned_lease_for_terminal_completion() {
        for terminal in [
            ProgressState::Succeeded,
            ProgressState::Failed,
            ProgressState::Cancelled,
        ] {
            let app = job_progress_test_app();
            let lease = initial_emit_failure_lease(&app, "initial-complete");
            let progress = JobProgress {
                app: app.clone(),
                lease: lease.clone(),
            };
            progress.complete(terminal);
            let store = &app.state::<AppState>().progress_state;
            let item = store.get(&lease.id).unwrap().unwrap();
            assert_eq!(item.generation, lease.generation);
            assert_eq!(item.state, terminal);
            assert!(item.finished);
            assert_eq!(
                item.progress,
                if terminal == ProgressState::Succeeded {
                    100.0
                } else {
                    0.0
                }
            );
            drop(progress);
            assert_eq!(store.get(&lease.id).unwrap().unwrap(), item);
        }
    }

    #[test]
    fn initial_emit_failure_returns_owned_lease_for_drop() {
        let app = job_progress_test_app();
        let lease = initial_emit_failure_lease(&app, "initial-drop");
        drop(JobProgress {
            app: app.clone(),
            lease: lease.clone(),
        });
        let item = app
            .state::<AppState>()
            .progress_state
            .get(&lease.id)
            .unwrap()
            .unwrap();
        assert_eq!(item.generation, lease.generation);
        assert_eq!(item.state, ProgressState::Cancelled);
        assert!(item.finished);
        assert_eq!(item.progress, 0.0);
    }

    #[test]
    fn initial_emit_failure_preserves_a_concurrently_newer_generation() {
        let app = job_progress_test_app();
        let store = &app.state::<AppState>().progress_state;
        let capture = crate::error::LogCaptureScope::start();
        let error = Error::Tauri(Box::new(tauri::Error::Io(std::io::Error::other(
            "injected initial delivery failure after replacement",
        ))));
        let error_debug = format!("{error:?}");
        let mut initial = None;
        let mut replacement = None;
        let lease = begin_progress_with_emitter(store, "initial-replaced".into(), |item| {
            let concurrent_store = store.clone();
            let id = item.id.clone();
            replacement = Some(
                thread::spawn(move || {
                    let newer = concurrent_store.start(id).unwrap();
                    let item = concurrent_store
                        .transition(&newer, 61.0, ProgressState::Running)
                        .unwrap()
                        .0;
                    (newer, item)
                })
                .join()
                .unwrap(),
            );
            initial = Some(item);
            Err(error)
        })
        .expect("failed initial delivery must return even a superseded lease to its owner");
        assert_initial_snapshot(&initial.unwrap(), &lease);
        assert_initial_emit_diagnostic(&capture, &lease, &error_debug);
        let (newer, before) = replacement.unwrap();
        assert!(newer.generation > lease.generation);
        assert_eq!(
            store.state.lock().unwrap().generation_clock,
            newer.generation
        );
        assert_eq!(store.get(&lease.id).unwrap().unwrap(), before);
        let progress = JobProgress {
            app: app.clone(),
            lease: lease.clone(),
        };
        progress.complete(ProgressState::Succeeded);
        drop(progress);
        assert_eq!(store.get(&newer.id).unwrap().unwrap(), before);
        assert_eq!(
            store.state.lock().unwrap().generation_clock,
            newer.generation
        );
        assert_initial_emit_diagnostic(&capture, &lease, &error_debug);
    }

    #[test]
    fn job_progress_complete_succeeded_stores_100() {
        let app = job_progress_test_app();
        let progress = JobProgress::new(app.clone(), "job".into()).unwrap();
        progress.complete(ProgressState::Succeeded);
        let item = app
            .state::<crate::AppState>()
            .progress_state
            .get("job")
            .unwrap()
            .unwrap();
        assert_eq!(item.state, ProgressState::Succeeded);
        assert_eq!(item.progress, 100.0);
    }

    #[test]
    fn job_progress_dropped_without_complete_stores_cancelled() {
        let app = job_progress_test_app();
        let progress = JobProgress::new(app.clone(), "job".into()).unwrap();
        drop(progress);
        let item = app
            .state::<crate::AppState>()
            .progress_state
            .get("job")
            .unwrap()
            .unwrap();
        assert_eq!(item.state, ProgressState::Cancelled);
        assert!(item.finished);
    }

    #[test]
    fn job_progress_complete_does_not_overwrite_the_first_terminal_state() {
        let app = job_progress_test_app();
        let progress = JobProgress::new(app.clone(), "job".into()).unwrap();
        progress.complete(ProgressState::Succeeded);
        progress.complete(ProgressState::Failed);
        let item = app
            .state::<crate::AppState>()
            .progress_state
            .get("job")
            .unwrap()
            .unwrap();
        assert_eq!(item.state, ProgressState::Succeeded);
        assert_eq!(item.progress, 100.0);
    }

    #[test]
    fn injected_emit_failure_is_diagnosed_without_replacing_the_worker_result() {
        let app = job_progress_test_app();
        let progress = JobProgress::new(app.clone(), "job".into()).unwrap();
        let state = app.state::<crate::AppState>();
        let mut diagnostics = Vec::new();

        let result = complete_preserving_result(Ok::<_, Error>(42), |terminal| {
            progress.transition_with(
                &state.progress_state,
                100.0,
                terminal,
                |_| Err(Error::Conflict("injected progress emit failure".into())),
                |message| diagnostics.push(message),
            );
        });

        assert_eq!(result.unwrap(), 42);
        assert_eq!(
            state.progress_state.get("job").unwrap().unwrap().state,
            ProgressState::Succeeded
        );
        assert_eq!(diagnostics.len(), 1);
        assert!(diagnostics[0].contains("injected progress emit failure"));
    }

    #[test]
    fn poisoned_store_operations_return_typed_failures() {
        let store = Arc::new(ProgressStore::default());
        let lease = store.start("before-poison".into()).unwrap();
        let poisoned = Arc::clone(&store);
        let _ = thread::spawn(move || {
            let _guard = poisoned.state.lock().unwrap();
            panic!("poison progress store");
        })
        .join();
        assert!(matches!(store.start("job".into()), Err(Error::Conflict(_))));
        assert!(matches!(store.get("job"), Err(Error::Conflict(_))));
        assert!(matches!(store.clear("job"), Err(Error::Conflict(_))));
        assert!(matches!(
            clear_progress_with(
                &store,
                &OperationRegistry::default(),
                "job".into(),
                &mut |_| panic!("progress store failure must not emit")
            ),
            Err(Error::Conflict(message)) if message == "progress store poisoned"
        ));
        assert!(matches!(
            store.transition(&lease, 1.0, ProgressState::Running),
            Err(Error::Conflict(_))
        ));
    }

    #[tokio::test]
    async fn clear_expiry_and_eviction_do_not_release_a_held_native_blocking_worker() {
        let registry = crate::infra::operations::OperationRegistry::default();
        let operation = registry.accept("held progress worker").unwrap();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let native = tokio::spawn(crate::infra::operations::run_native_operation(
            operation,
            "held progress worker",
            async move {
                crate::infra::blocking::BLOCKING_GATEWAY
                    .spawn(move || {
                        release_rx
                            .recv_timeout(Duration::from_secs(2))
                            .map_err(|_| Error::Conflict("held progress worker timed out".into()))
                    })
                    .await
            },
        ));
        tokio::task::yield_now().await;

        let store = ProgressStore::default();
        let now = Instant::now();
        store.start_at("clear".into(), now).unwrap();
        store.clear("clear").unwrap();
        assert_eq!(
            registry.outstanding_labels().unwrap(),
            vec!["held progress worker"]
        );

        store.start_at("expire".into(), now).unwrap();
        assert!(store
            .get_at("expire", now + RUNNING_TTL + Duration::from_millis(1))
            .unwrap()
            .is_none());
        assert_eq!(registry.outstanding_labels().unwrap().len(), 1);

        for index in 0..=PROGRESS_CAPACITY {
            store.start_at(format!("evict-{index}"), now).unwrap();
        }
        assert_eq!(registry.outstanding_labels().unwrap().len(), 1);

        release_tx.send(()).unwrap();
        native.await.unwrap().unwrap();
        assert!(registry.wait_for_drain(Duration::ZERO).unwrap());
    }

    #[test]
    fn progress_store_count_semantics_emit_monotonic_and_preserve_on_none_and_terminal() {
        let store = ProgressStore::default();
        let lease = store.start("count-job".into()).unwrap();
        assert_eq!(store.get("count-job").unwrap().unwrap().count, None);

        // Count-only change emits.
        let (item, changed) = store
            .transition_with_count(&lease, 0.0, Some(5), ProgressState::Running)
            .unwrap();
        assert!(changed);
        assert_eq!(item.count, Some(5));
        assert_eq!(item.progress, 0.0);

        // Same count does not emit.
        let (_, changed) = store
            .transition_with_count(&lease, 0.0, Some(5), ProgressState::Running)
            .unwrap();
        assert!(!changed);

        // Lower count never replaces higher count.
        let (item, changed) = store
            .transition_with_count(&lease, 0.0, Some(3), ProgressState::Running)
            .unwrap();
        assert!(!changed);
        assert_eq!(item.count, Some(5));

        // Higher count replaces and emits.
        let (item, changed) = store
            .transition_with_count(&lease, 0.0, Some(9), ProgressState::Running)
            .unwrap();
        assert!(changed);
        assert_eq!(item.count, Some(9));

        // Percentage-only update without a count keeps existing count.
        let (item, changed) = store
            .transition(&lease, 40.0, ProgressState::Running)
            .unwrap();
        assert!(changed);
        assert_eq!(item.progress, 40.0);
        assert_eq!(item.count, Some(9));

        // Terminal transitions keep the count.
        for terminal in [
            ProgressState::Succeeded,
            ProgressState::Failed,
            ProgressState::Cancelled,
        ] {
            let terminal_store = ProgressStore::default();
            let terminal_lease = terminal_store.start("terminal-job".into()).unwrap();
            terminal_store
                .transition_with_count(&terminal_lease, 25.0, Some(17), ProgressState::Running)
                .unwrap();
            let (item, changed) = terminal_store
                .transition(&terminal_lease, 100.0, terminal)
                .unwrap();
            assert!(changed);
            assert_eq!(item.state, terminal);
            assert_eq!(item.count, Some(17));
            assert_eq!(
                terminal_store.get("terminal-job").unwrap().unwrap().count,
                Some(17)
            );
        }
    }

    #[test]
    fn begin_progress_with_count_emits_initial_count_in_start_event() {
        let store = ProgressStore::default();
        let mut emitted = Vec::new();
        let lease = begin_progress_with_count_emitter(&store, "chunk-2".into(), Some(42), |item| {
            emitted.push(item);
            Ok(())
        })
        .unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].id, "chunk-2");
        assert_eq!(emitted[0].generation, lease.generation);
        assert_eq!(emitted[0].count, Some(42));
        assert_eq!(emitted[0].state, ProgressState::Running);
        assert_eq!(store.get("chunk-2").unwrap().unwrap().count, Some(42));
    }

    #[test]
    fn count_progress_throttle_bounds_running_emissions_within_250ms() {
        let start = Instant::now();
        let mut throttle = CountProgressThrottle::new(None);
        assert!(throttle.record_if_due(1, start));
        assert!(!throttle.record_if_due(2, start + Duration::from_millis(50)));
        assert!(!throttle.record_if_due(10, start + Duration::from_millis(249)));
        assert!(throttle.record_if_due(11, start + COUNT_EMIT_INTERVAL));
        assert!(!throttle.record_final(11));
        assert!(throttle.record_final(12));
    }
}
