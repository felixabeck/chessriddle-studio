//! Actor registration and launch: pending actors, registration guards, launch resolution, option leases and shutdown aggregation.

use super::*;

pub(super) async fn reject_actor(
    pending: &Arc<PendingActor>,
    entries: Arc<DashMap<u64, Arc<PendingActor>>>,
    primary: Error,
) -> Error {
    Error::with_cleanup(primary, pending.terminate(entries).await)
}

pub(super) struct ObservedTerminationTarget {
    pub(super) key: EngineKey,
    pub(super) generation: u64,
    pub(super) actor: Option<Arc<EngineActor>>,
    pub(super) attempt: Option<Arc<PendingTermination>>,
}

pub(super) struct ActorShutdownFailure {
    pub(super) key: EngineKey,
    pub(super) generation: u64,
    pub(super) error: Error,
}

pub(super) async fn observe_pending_terminations(
    targets: impl IntoIterator<Item = (Arc<PendingActor>, Arc<PendingTermination>)>,
) -> Vec<ActorShutdownFailure> {
    let results =
        futures_util::future::join_all(targets.into_iter().map(|(entry, attempt)| async move {
            attempt
                .wait()
                .await
                .err()
                .map(|error| ActorShutdownFailure {
                    key: entry.key.clone(),
                    generation: entry.generation,
                    error,
                })
        }))
        .await;
    results.into_iter().flatten().collect()
}

pub(crate) struct RegistrationGuard {
    pub(super) supervisor: Arc<EngineSupervisor>,
    pub(super) key: EngineKey,
    pub(super) generation: u64,
    pub(super) taken: bool,
    pub(super) search: bool,
}

pub(super) struct PendingActor {
    pub(super) actor: OnceLock<Arc<EngineActor>>,
    pub(super) cleanup: Option<Arc<ChildOwner>>,
    pub(super) spawning: AtomicBool,
    pub(super) ready: Notify,
    pub(super) key: EngineKey,
    pub(super) generation: u64,
    pub(super) owner_generation: u64,
    pub(super) engine_id: String,
    pub(super) executable: PathRef,
    pub(super) resources: Vec<PathRef>,
    pub(super) termination: StdMutex<Option<Arc<PendingTermination>>>,
}

pub(crate) struct EngineBinaryRetirement {
    pub(super) targets: Vec<(Arc<PendingActor>, Arc<PendingTermination>)>,
    pub(super) observed: AtomicBool,
    pub(super) observation: Mutex<()>,
}

#[derive(Default)]
pub(super) struct PendingTermination {
    pub(super) result: OnceLock<Result<(), Arc<Error>>>,
    pub(super) completed: Notify,
}

impl PendingTermination {
    pub(super) async fn wait(&self) -> Result<(), Error> {
        loop {
            let completed = self.completed.notified();
            tokio::pin!(completed);
            completed.as_mut().enable();
            if let Some(result) = self.result.get().cloned() {
                return result.map_err(Error::Shared);
            }
            completed.await;
        }
    }
}

impl PendingActor {
    pub(super) fn new(
        actor: Arc<EngineActor>,
        key: EngineKey,
        generation: u64,
        engine_id: String,
        executable: PathRef,
    ) -> Self {
        let resources = actor
            .resources
            .iter()
            .filter_map(|lease| lease.path_ref().cloned())
            .collect();
        Self {
            cleanup: actor.cleanup.clone(),
            actor: OnceLock::from(actor),
            spawning: AtomicBool::new(false),
            ready: Notify::new(),
            key,
            generation,
            owner_generation: generation,
            engine_id,
            executable,
            resources,
            termination: StdMutex::default(),
        }
    }

    pub(super) fn finish_spawn(&self) {
        self.spawning.store(false, Ordering::SeqCst);
        self.ready.notify_waiters();
    }

    pub(super) async fn await_spawn(&self) {
        loop {
            let ready = self.ready.notified();
            tokio::pin!(ready);
            ready.as_mut().enable();
            if !self.spawning.load(Ordering::SeqCst) {
                return;
            }
            ready.await;
        }
    }

    pub(super) fn start_termination(
        self: &Arc<Self>,
        entries: Arc<DashMap<u64, Arc<Self>>>,
    ) -> Arc<PendingTermination> {
        self.start_termination_with_stop(entries, false)
    }

    pub(super) fn start_termination_with_stop(
        self: &Arc<Self>,
        entries: Arc<DashMap<u64, Arc<Self>>>,
        stop_first: bool,
    ) -> Arc<PendingTermination> {
        if !stop_first {
            if let Some(actor) = self.actor.get() {
                actor.interrupt.cancel();
            }
        }
        let mut termination = self
            .termination
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(attempt) = termination.as_ref() {
            if attempt.result.get().is_none()
                || !self
                    .cleanup
                    .as_ref()
                    .is_some_and(|owner| owner.unresolved())
            {
                return attempt.clone();
            }
        }
        let retry = termination.is_some();
        let attempt = Arc::new(PendingTermination::default());
        *termination = Some(attempt.clone());
        let entry = self.clone();
        let running = attempt.clone();
        tokio::spawn(async move {
            entry.await_spawn().await;
            let result = if retry || entry.actor.get().is_none() {
                let cleanup = match &entry.cleanup {
                    Some(owner) => {
                        owner
                            .terminate(Duration::ZERO, EngineDeadlines::default().kill_reap, false)
                            .await
                    }
                    None => Ok(()),
                };
                let joined = match entry.actor.get() {
                    Some(actor) => actor.reap_task().await,
                    None => Ok(()),
                };
                combine_shutdown_results(cleanup, joined)
            } else {
                match entry.actor.get() {
                    Some(actor) => {
                        let stop = if stop_first {
                            actor.stop_current().await
                        } else {
                            Ok(())
                        };
                        combine_shutdown_results(stop, actor.terminate().await)
                    }
                    None => Err(Error::EngineDisconnected),
                }
            }
            .map_err(Arc::new);
            if let Err(error) = &result {
                log_pending_actor_termination_error(&entry.key, entry.generation, error);
            }
            let _ = running.result.set(result);
            if !entry
                .cleanup
                .as_ref()
                .is_some_and(|owner| owner.unresolved())
            {
                entries.remove(&entry.generation);
            }
            running.completed.notify_waiters();
        });
        attempt
    }

    pub(super) async fn terminate(
        self: &Arc<Self>,
        entries: Arc<DashMap<u64, Arc<Self>>>,
    ) -> Result<(), Error> {
        self.start_termination(entries).wait().await
    }
}

pub(super) struct PendingActorGuard {
    pub(super) entry: Option<Arc<PendingActor>>,
    pub(super) entries: Arc<DashMap<u64, Arc<PendingActor>>>,
}

impl PendingActorGuard {
    pub(super) fn new(
        entry: Arc<PendingActor>,
        entries: Arc<DashMap<u64, Arc<PendingActor>>>,
    ) -> Self {
        Self {
            entry: Some(entry),
            entries,
        }
    }

    pub(super) fn disarm(&mut self) {
        self.entry = None;
    }
}

impl Drop for PendingActorGuard {
    fn drop(&mut self) {
        let Some(entry) = self.entry.take() else {
            return;
        };
        entry.finish_spawn();
        entry.start_termination(self.entries.clone());
    }
}

#[cfg(test)]
pub(crate) static CLEANUP_FAILURE_LOG: StdMutex<Vec<String>> = StdMutex::new(Vec::new());

#[cfg(test)]
pub(crate) static REGISTRATION_GUARD_DROPS: StdMutex<Vec<(EngineKey, u64, bool)>> =
    StdMutex::new(Vec::new());

#[cfg(test)]
pub(super) static PENDING_ACTOR_CLEANUP_ERRORS: StdMutex<Vec<String>> = StdMutex::new(Vec::new());

#[cfg(test)]
pub(super) static SHUTDOWN_FAILURE_LOGS: StdMutex<Vec<String>> = StdMutex::new(Vec::new());

pub(super) fn log_pending_actor_termination_error(key: &EngineKey, generation: u64, error: &Error) {
    let message = format!(
        "engine actor termination failed for {}:{} generation={generation} category={} diagnostic={}",
        key.tab,
        key.engine,
        error.category(),
        error.diagnostic()
    );
    #[cfg(test)]
    match PENDING_ACTOR_CLEANUP_ERRORS.lock() {
        Ok(mut errors) => errors.push(message.clone()),
        Err(poisoned) => poisoned.into_inner().push(message.clone()),
    }
    error!("{message}");
}

pub(crate) fn log_registration_cleanup_error(
    key: Option<&EngineKey>,
    generation: Option<u64>,
    error: &Error,
) {
    let message = match (key, generation) {
        (Some(key), Some(generation)) => format!(
            "exact engine termination failed for {}:{} generation={generation} category={} error={}",
            key.tab,
            key.engine,
            error.category(),
            error.diagnostic()
        ),
        _ => format!(
            "exact engine termination failed for unregistered actor generation=unassigned category={} error={}",
            error.category(),
            error.diagnostic()
        ),
    };
    #[cfg(test)]
    match CLEANUP_FAILURE_LOG.lock() {
        Ok(mut errors) => errors.push(message.clone()),
        Err(poisoned) => poisoned.into_inner().push(message.clone()),
    }
    error!("{message}");
}

impl RegistrationGuard {
    pub(crate) fn new(supervisor: Arc<EngineSupervisor>, key: EngineKey, generation: u64) -> Self {
        Self {
            supervisor,
            key,
            generation,
            taken: false,
            search: false,
        }
    }

    pub(crate) fn for_search(
        supervisor: Arc<EngineSupervisor>,
        key: EngineKey,
        generation: u64,
    ) -> Self {
        Self {
            supervisor,
            key,
            generation,
            taken: false,
            search: true,
        }
    }

    pub(crate) fn disarm(&mut self) {
        self.taken = true;
    }

    pub(crate) async fn terminate_now(mut self) -> Result<(), Error> {
        let result =
            terminate_exact_and_log(&self.supervisor, &self.key, self.generation, self.search)
                .await;
        self.disarm();
        result
    }
}

pub(super) async fn terminate_exact_and_log(
    supervisor: &EngineSupervisor,
    key: &EngineKey,
    generation: u64,
    search: bool,
) -> Result<(), Error> {
    let result = if search {
        supervisor.release_generation(key, generation).await
    } else {
        supervisor.terminate_exact(key, generation).await
    };
    if let Err(error) = &result {
        log_registration_cleanup_error(Some(key), Some(generation), error);
    }
    result
}

impl Drop for RegistrationGuard {
    fn drop(&mut self) {
        if self.taken {
            return;
        }
        let supervisor = self.supervisor.clone();
        let key = self.key.clone();
        let generation = self.generation;
        let search = self.search;
        #[cfg(test)]
        REGISTRATION_GUARD_DROPS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((key.clone(), generation, false));
        tokio::spawn(async move {
            // The helper logs a failure; a dropped guard has nobody to return it to.
            let _ = terminate_exact_and_log(&supervisor, &key, generation, search).await;
            #[cfg(test)]
            {
                let mut drops = REGISTRATION_GUARD_DROPS
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some((_, _, completed)) =
                    drops
                        .iter_mut()
                        .rev()
                        .find(|(dropped_key, dropped_generation, _)| {
                            dropped_key == &key && *dropped_generation == generation
                        })
                {
                    *completed = true;
                }
            }
        });
    }
}

#[derive(Debug)]
pub(super) enum PinFailure {
    Primary(Error),
    #[cfg(target_os = "macos")]
    OperationAndCleanup {
        primary: Error,
        cleanup: Error,
    },
}

impl PinFailure {
    pub(super) fn into_error(self, key: &EngineKey, engine_id: &str) -> Error {
        #[cfg(not(target_os = "macos"))]
        let _ = (key, engine_id);
        match self {
            Self::Primary(error) => error,
            #[cfg(target_os = "macos")]
            Self::OperationAndCleanup { primary, cleanup } => {
                log_pin_cleanup_failure(key, engine_id, &primary, &cleanup);
                Error::with_cleanup(primary, Err(cleanup))
            }
        }
    }
}

#[cfg(any(target_os = "macos", test))]
pub(super) fn log_pin_cleanup_failure(
    key: &EngineKey,
    engine_id: &str,
    primary: &Error,
    cleanup: &Error,
) {
    error!(
        "engine launch pin failed for key={}:{} engine_id={} primary_category={} cleanup_category={} primary={} cleanup={}",
        key.tab, key.engine, engine_id, primary.category(), cleanup.category(), primary.diagnostic(), cleanup.diagnostic()
    );
}

/// Both launch hooks are keyed by the engine identity `resolve_launch` was called for:
/// every concurrent launch reaches these fire sites, so an unkeyed slot made whichever
/// launch arrived first run a foreign test's hook (`f-20260917-09`, `infra::test_hooks`).
#[cfg(all(test, unix))]
pub(super) static ENGINE_LAUNCH_RESOLUTION_HOOKS: crate::infra::test_hooks::KeyedTestHooks<
    EngineKey,
> = crate::infra::test_hooks::KeyedTestHooks::new();

#[cfg(all(test, target_os = "macos"))]
pub(super) static ENGINE_LAUNCH_POST_PIN_HOOKS: crate::infra::test_hooks::KeyedTestHooks<
    EngineKey,
> = crate::infra::test_hooks::KeyedTestHooks::new();

/// Keyed by the engine identity the launch was admitted for; see `infra::test_hooks`.
#[cfg(all(test, target_os = "macos"))]
pub(super) static ENGINE_LAUNCH_VALUE_FAILURES: crate::infra::test_hooks::KeyedTestValues<
    EngineKey,
    (),
> = crate::infra::test_hooks::KeyedTestValues::new();

/// The engine key as the launch root records it on a reserved leaf. Tests that inject a
/// launch failure arm it under this same spelling.
#[cfg(target_os = "macos")]
pub(crate) fn engine_launch_key(key: &EngineKey) -> String {
    format!("{}:{}", key.tab, key.engine)
}

#[cfg(target_os = "macos")]
pub(super) fn cleanup_materialized_files(
    files: Vec<crate::infra::path_authority::MaterializedFile>,
) -> Option<Error> {
    let mut first = None;
    for file in files {
        if let Err(error) = file.remove() {
            if first.is_none() {
                first = Some(error);
            }
        }
    }
    first
}

#[cfg(target_os = "macos")]
pub(super) fn pin_engine_launch(
    executable: &mut EngineExecutable,
    key: &EngineKey,
    engine_id: &str,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<Vec<(String, String, Error)>, PinFailure> {
    let root = executable.launch_root().cloned().ok_or_else(|| {
        PinFailure::Primary(Error::Conflict(
            "engine launch root is not initialized".into(),
        ))
    })?;
    let reclaim = root.reclaim();
    let reclaim_failures = reclaim
        .failed
        .into_iter()
        .map(|(leaf, error)| (leaf.engine_key, leaf.engine_id, error))
        .collect::<Vec<_>>();
    let executable_leaf_count = 1;
    let count = executable
        .resource_leases()
        .iter()
        .filter(|lease| !lease.is_directory())
        .count()
        + executable_leaf_count;
    let mut files = match root.reserve_leaves(count, &engine_launch_key(key), engine_id) {
        Ok(files) => files,
        Err(error) => return Err(PinFailure::Primary(error)),
    };
    let result = (|| {
        files[0].create_from(
            executable.image_file(),
            crate::infra::path_authority::ENGINE_EXECUTABLE_LEAF_MODE,
            is_cancelled,
        )?;
        let mut file_index = 1;
        for lease in executable.resource_leases() {
            if lease.is_directory() {
                continue;
            }
            lease.file().metadata().map_err(Error::from)?;
            files[file_index].create_from(
                lease.file(),
                crate::infra::path_authority::ENGINE_RESOURCE_LEAF_MODE,
                is_cancelled,
            )?;
            lease.set_pinned_target(files[file_index].path())?;
            file_index += 1;
        }
        if is_cancelled() {
            return Err(Error::Cancellation);
        }
        let command_path = files[0].path();
        let retained = std::mem::take(&mut files);
        executable.set_launch_materialization(command_path, retained);
        Ok(())
    })();
    if let Err(primary) = result {
        if let Some(cleanup) = cleanup_materialized_files(files) {
            return Err(PinFailure::OperationAndCleanup { primary, cleanup });
        }
        return Err(PinFailure::Primary(primary));
    }
    Ok(reclaim_failures)
}

pub(super) struct LaunchResult {
    pub(super) executable: EngineExecutable,
    pub(super) resolved: Vec<ResolvedEngineOption>,
    pub(super) reclaim_failures: Vec<(String, String, Error)>,
}

pub(crate) async fn resolve_launch(
    authority: crate::infra::path_authority::SharedPathAuthority,
    engine: EngineHandle,
    operation: PathOperation,
    options: &[EngineOption],
    admission: &AdmissionLease,
) -> Result<(EngineExecutable, Vec<ResolvedEngineOption>), Error> {
    let (admission_cancelled, operation_cancellation) = admission.cancellation_probe();
    let engine_id = admission.admission.engine_id.clone();
    let key = admission.key.clone();
    let error_key = key.clone();
    let error_engine_id = engine_id.clone();
    let options = options.to_vec();
    #[cfg(all(test, unix))]
    let resolution_trace = crate::infra::path_authority::take_engine_resolution_trace_for_worker();
    let result = BLOCKING_GATEWAY
        .spawn(move || {
            #[cfg(all(test, unix))]
            let _resolution_trace_guard =
                crate::infra::path_authority::install_engine_resolution_trace_for_worker(
                    resolution_trace,
                );
            let is_cancelled = || {
                admission_cancelled.load(Ordering::SeqCst)
                    || operation_cancellation
                        .as_ref()
                        .is_some_and(CancellationToken::is_cancelled)
            };
            if is_cancelled() {
                return Ok(Err(PinFailure::Primary(Error::Cancellation)));
            }
            let (executable, mut resolved) = authority.with_mut(|authority| {
                let executable = authority.engine_executable(&engine, operation)?;
                let resolved = resolve_engine_option_leases(authority, &options)?;
                Ok::<_, Error>((executable, resolved))
            })??;
            if is_cancelled() {
                return Ok(Err(PinFailure::Primary(Error::Cancellation)));
            }
            #[cfg(all(test, unix))]
            ENGINE_LAUNCH_RESOLUTION_HOOKS.run(&key);
            let option_leases = resolved
                .iter()
                .flat_map(|option| option.resources.iter().cloned())
                .collect();
            let executable = executable.with_resource_leases(option_leases);
            #[cfg(target_os = "macos")]
            let (executable, reclaim_failures) = {
                let mut executable = executable;
                let reclaim_failures =
                    match pin_engine_launch(&mut executable, &key, &engine_id, &is_cancelled) {
                        Ok(reclaim_failures) => reclaim_failures,
                        Err(failure) => return Ok(Err(failure)),
                    };
                (executable, reclaim_failures)
            };
            #[cfg(all(test, target_os = "macos"))]
            if ENGINE_LAUNCH_VALUE_FAILURES.take(&key).is_some() {
                return Ok(Err(PinFailure::Primary(Error::Conflict(
                    "injected engine launch value construction failure".into(),
                ))));
            }
            #[cfg(all(test, target_os = "macos"))]
            ENGINE_LAUNCH_POST_PIN_HOOKS.run(&key);
            #[cfg(not(target_os = "macos"))]
            let reclaim_failures = Vec::new();
            for option in &mut resolved {
                option.refresh_resource_values()?;
            }
            Ok(Ok(LaunchResult {
                executable,
                resolved,
                reclaim_failures,
            }))
        })
        .await?;
    let result = result.map_err(|failure| {
        let error = failure.into_error(&error_key, &error_engine_id);
        // Only a bare cancellation can take the admission's semantic reason. A launch
        // materialization or cleanup failure must keep its own truthful category.
        match error {
            Error::Cancellation => admission.cancel_error().unwrap_or(error),
            error => error,
        }
    })?;
    for (reclaim_key, reclaim_id, error) in result.reclaim_failures {
        error!(
            "engine launch leaf reclaim failed for key={} engine_id={} category={}",
            reclaim_key,
            reclaim_id,
            error.category()
        );
    }
    if let Some(error) = admission.cancel_error() {
        return Err(error);
    }
    Ok((result.executable, result.resolved))
}

pub(crate) async fn resolve_option_leases(
    authority: crate::infra::path_authority::SharedPathAuthority,
    options: &[EngineOption],
    cancellation: CancellationToken,
) -> Result<Vec<ResolvedEngineOption>, Error> {
    let options = options.to_vec();
    BLOCKING_GATEWAY
        .spawn(move || {
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            authority.with_mut(|authority| resolve_engine_option_leases(authority, &options))?
        })
        .await
}

/// Spawns and publishes an actor before any protocol initialization begins.
/// The caller owns the returned armed guard until ownership is transferred or
/// termination completes. Dropping it terminates exactly the published generation.
pub(crate) async fn spawn_registered<T, F, Fut>(
    supervisor: Arc<EngineSupervisor>,
    key: EngineKey,
    executable: EngineExecutable,
    admission: AdmissionLease,
    initialize: F,
) -> Result<(SupervisedEngine, RegistrationGuard, T), Error>
where
    F: FnOnce(Arc<EngineActor>) -> Fut,
    Fut: std::future::Future<Output = Result<T, Error>>,
{
    if let Some(error) = admission.cancel_error() {
        return Err(error);
    }
    let pending = supervisor
        .spawn_pending(&key, executable, &admission)
        .await?;
    initialize_pending_actor(supervisor, key, pending, admission, initialize).await
}

#[cfg(test)]
pub(super) async fn initialize_registered_actor<T, F, Fut>(
    supervisor: Arc<EngineSupervisor>,
    key: EngineKey,
    actor: Arc<EngineActor>,
    engine_id: String,
    executable_ref: PathRef,
    initialize: F,
) -> Result<(SupervisedEngine, RegistrationGuard, T), Error>
where
    F: FnOnce(Arc<EngineActor>) -> Fut,
    Fut: std::future::Future<Output = Result<T, Error>>,
{
    let admission = supervisor
        .admit(key.clone(), engine_id, executable_ref, false)
        .await?;
    initialize_admitted_actor(supervisor, key, actor, admission, initialize).await
}

#[cfg(test)]
pub(super) async fn initialize_admitted_actor<T, F, Fut>(
    supervisor: Arc<EngineSupervisor>,
    key: EngineKey,
    actor: Arc<EngineActor>,
    admission: AdmissionLease,
    initialize: F,
) -> Result<(SupervisedEngine, RegistrationGuard, T), Error>
where
    F: FnOnce(Arc<EngineActor>) -> Fut,
    Fut: std::future::Future<Output = Result<T, Error>>,
{
    let pending = supervisor.track_pending_actor(key.clone(), actor.clone(), &admission);
    initialize_pending_actor(supervisor, key, pending, admission, initialize).await
}

pub(super) async fn initialize_pending_actor<T, F, Fut>(
    supervisor: Arc<EngineSupervisor>,
    key: EngineKey,
    pending: Arc<PendingActor>,
    admission: AdmissionLease,
    initialize: F,
) -> Result<(SupervisedEngine, RegistrationGuard, T), Error>
where
    F: FnOnce(Arc<EngineActor>) -> Fut,
    Fut: std::future::Future<Output = Result<T, Error>>,
{
    let operation_cancellation = admission.operation_cancellation();
    let actor = pending
        .actor
        .get()
        .cloned()
        .ok_or(Error::EngineDisconnected)?;
    let mut actor_guard =
        PendingActorGuard::new(pending.clone(), supervisor.pending_actors.clone());
    let published = supervisor
        .publish_admitted(key.clone(), pending, admission)
        .await;
    actor_guard.disarm();
    let supervised = match published {
        Ok(supervised) => supervised,
        Err(primary) => return Err(primary),
    };
    let guard = RegistrationGuard::new(supervisor.clone(), key.clone(), supervised.generation);
    let initialized = initialize(actor);
    tokio::pin!(initialized);
    let initialized = match operation_cancellation {
        Some(cancellation) => tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(Error::Cancellation),
            value = &mut initialized => value,
        },
        None => initialized.await,
    };
    match initialized {
        Ok(value) => Ok((supervised, guard, value)),
        Err(primary) => {
            let cleanup = guard.terminate_now().await;
            Err(Error::with_cleanup(primary, cleanup))
        }
    }
}

pub(super) fn aggregate_shutdown_failures(
    failures: Vec<ActorShutdownFailure>,
) -> Result<(), Error> {
    let mut representative = None;
    for failure in failures {
        let message = format!(
            "engine cleanup failed for {}:{} generation={} category={}",
            failure.key.tab,
            failure.key.engine,
            failure.generation,
            failure.error.category()
        );
        #[cfg(test)]
        match SHUTDOWN_FAILURE_LOGS.lock() {
            Ok(mut errors) => errors.push(message.clone()),
            Err(poisoned) => poisoned.into_inner().push(message.clone()),
        }
        error!("{message}");
        if representative.is_none() {
            representative = Some(failure.error);
        }
    }
    representative.map_or(Ok(()), Err)
}
