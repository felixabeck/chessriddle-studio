//! Engine supervision: supervised engines and searches, the publication barrier, admission leases and the `EngineSupervisor` registry.

use super::*;

#[derive(Clone)]
pub struct SupervisedEngine {
    pub generation: u64,
    pub engine_id: String,
    pub executable: PathRef,
    pub actor: Arc<EngineActor>,
    pub cancelled: Arc<std::sync::atomic::AtomicBool>,
    pub(super) barrier: PublicationBarrier,
    pub(crate) interactive: Arc<Mutex<Option<crate::chess::WarmEngine>>>,
    pub(super) search: Arc<StdMutex<Option<SupervisedSearch>>>,
}

/// One publication boundary per search, independent of the actor's lifetime.
#[derive(Clone)]
pub(crate) struct SupervisedSearch {
    pub generation: u64,
    pub cancelled: Arc<AtomicBool>,
    pub(super) barrier: PublicationBarrier,
}

/// Shared mechanics, with separate instances for actor lifetime and search ownership.
#[derive(Clone)]
pub(super) struct PublicationBarrier {
    pub(super) cancelled: Arc<AtomicBool>,
    pub(super) publish: Arc<StdMutex<()>>,
}

impl PublicationBarrier {
    pub(super) fn new(cancelled: Arc<AtomicBool>) -> Self {
        Self {
            cancelled,
            publish: Arc::default(),
        }
    }

    pub fn mark_cancelled(&self) {
        let _publish = self
            .publish
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn try_publish<E>(&self, emit: impl FnOnce() -> Result<(), E>) -> Result<bool, E> {
        let _publish = self
            .publish
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.cancelled.load(Ordering::SeqCst) {
            return Ok(false);
        }
        emit()?;
        Ok(true)
    }
}

impl SupervisedSearch {
    pub(super) fn new(generation: u64, cancelled: Arc<AtomicBool>) -> Self {
        Self {
            generation,
            barrier: PublicationBarrier::new(cancelled.clone()),
            cancelled,
        }
    }

    pub fn mark_cancelled(&self) {
        self.barrier.mark_cancelled();
    }

    pub fn try_publish<E>(&self, emit: impl FnOnce() -> Result<(), E>) -> Result<bool, E> {
        self.barrier.try_publish(emit)
    }
}

impl SupervisedEngine {
    pub fn new(
        generation: u64,
        engine_id: String,
        executable: PathRef,
        actor: Arc<EngineActor>,
        cancelled: Arc<AtomicBool>,
    ) -> Self {
        Self {
            generation,
            engine_id,
            executable,
            actor,
            barrier: PublicationBarrier::new(cancelled.clone()),
            cancelled,
            interactive: Arc::default(),
            search: Arc::default(),
        }
    }

    pub fn mark_cancelled(&self) {
        self.barrier.mark_cancelled();
        if let Some(search) = self.current_search() {
            search.mark_cancelled();
        }
    }

    pub(crate) fn current_search(&self) -> Option<SupervisedSearch> {
        self.search
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub(crate) fn owner_generation(&self) -> u64 {
        self.current_search()
            .map_or(self.generation, |search| search.generation)
    }

    pub(super) fn bind_search(&self, search: SupervisedSearch) {
        let mut current = self
            .search
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(previous) = current.replace(search) {
            previous.mark_cancelled();
        }
        if self.cancelled.load(Ordering::SeqCst) {
            if let Some(search) = current.as_ref() {
                search.mark_cancelled();
            }
        }
    }

    pub fn try_publish<E>(&self, emit: impl FnOnce() -> Result<(), E>) -> Result<bool, E> {
        if let Some(search) = self.current_search() {
            return search.try_publish(emit);
        }
        self.barrier.try_publish(emit)
    }
}

pub(super) struct RetiredSet<T> {
    pub(super) order: VecDeque<T>,
    pub(super) entries: HashSet<T>,
    pub(super) capacity: usize,
}

impl<T: Eq + Hash + Clone> RetiredSet<T> {
    pub(super) fn new(capacity: usize) -> Self {
        Self {
            order: VecDeque::new(),
            entries: HashSet::new(),
            capacity,
        }
    }

    pub(super) fn insert(&mut self, entry: T) {
        if !self.entries.insert(entry.clone()) {
            return;
        }
        self.order.push_back(entry);
        if self.order.len() > self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
    }

    pub(super) fn remove(&mut self, entry: &T) {
        if self.entries.remove(entry) {
            self.order.retain(|queued| queued != entry);
        }
    }
}

// EngineKey::new reserves this namespace for native EngineKey::game construction.
// Pair retirement preserves a game's original binary until its exact-key cleanup.
pub(super) fn is_game_engine_key(key: &EngineKey) -> bool {
    key.tab.starts_with(GAME_ENGINE_KEY_PREFIX)
}

/// Owns the registry boundary for interactive, report, config-probe, and game
/// engines. Replacement removes exactly one opaque key, shuts down that actor,
/// then publishes the new generation. `retire_engine` reaps every actor owned
/// by an application engine id. `retire_executables` tombstones PathRefs and
/// terminates matching actors without retiring the application id.
/// RAII guard for an engine-move quiesce barrier. Lifts the barrier on explicit `lift()` or
/// on `Drop` (never panics, never inserts into `retired_executables`).
pub(crate) struct EngineQuiesceGuard<'a> {
    supervisor: &'a EngineSupervisor,
    executables: HashSet<PathRef>,
    resources: HashSet<PathRef>,
    lifted: bool,
}

impl EngineQuiesceGuard<'_> {
    pub(crate) fn lift(mut self) {
        self.lift_inner();
    }

    fn lift_inner(&mut self) {
        if self.lifted {
            return;
        }
        self.lifted = true;
        let mut quiesced = self
            .supervisor
            .quiesced_executables
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for executable in &self.executables {
            quiesced.remove(executable);
        }
        drop(quiesced);
        let mut quiesced_resources = self
            .supervisor
            .quiesced_resources
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for resource in &self.resources {
            quiesced_resources.remove(resource);
        }
    }
}

impl Drop for EngineQuiesceGuard<'_> {
    fn drop(&mut self) {
        self.lift_inner();
    }
}

pub struct EngineSupervisor {
    #[cfg(test)]
    pub(super) spawn_attempts: std::sync::atomic::AtomicUsize,
    pub(super) child_slots: Arc<Semaphore>,
    pub(super) next_generation: AtomicU64,
    pub(super) sealed: AtomicBool,
    pub(super) actors: DashMap<EngineKey, SupervisedEngine>,
    pub(super) pending_actors: Arc<DashMap<u64, Arc<PendingActor>>>,
    pub(super) admissions: Arc<DashMap<EngineKey, EngineAdmission>>,
    pub(super) admission_coordination: StdMutex<()>,
    pub(super) registration: Mutex<()>,
    pub(super) retired: StdMutex<RetiredSet<String>>,
    pub(super) retired_executables: StdMutex<RetiredSet<PathRef>>,
    pub(super) retired_binaries: StdMutex<RetiredSet<(String, PathRef)>>,
    pub(super) quiesced_executables: StdMutex<HashSet<PathRef>>,
    pub(super) quiesced_resources: StdMutex<HashSet<PathRef>>,
    pub(super) folder_switch: crate::infra::path_authority::FolderSwitchCoordinator,
    // `lifecycle` provides the per-key transition locks. Lifecycle transitions
    // may capture an actor before awaiting the per-key lock and recheck under
    // that lock before mutating an actor they still own. Kill and
    // `handoff_published_locked` instead cancel and move actors into
    // `pending_actors` under registration, then admission coordination,
    // without taking the lifecycle lock.
    pub(super) lifecycle: KeyedLocks<EngineKey>,
}

impl Default for EngineSupervisor {
    fn default() -> Self {
        Self::with_folder_switch(crate::infra::path_authority::FolderSwitchCoordinator::default())
    }
}

impl EngineSupervisor {
    pub(crate) fn with_folder_switch(
        folder_switch: crate::infra::path_authority::FolderSwitchCoordinator,
    ) -> Self {
        Self {
            #[cfg(test)]
            spawn_attempts: std::sync::atomic::AtomicUsize::new(0),
            child_slots: Arc::new(Semaphore::new(MAX_OWNED_CHILDREN)),
            next_generation: AtomicU64::default(),
            sealed: AtomicBool::default(),
            actors: DashMap::default(),
            pending_actors: Arc::default(),
            admissions: Arc::default(),
            admission_coordination: StdMutex::default(),
            registration: Mutex::default(),
            retired: StdMutex::new(RetiredSet::new(MAX_RETIRED_ENGINE_IDS)),
            retired_executables: StdMutex::new(RetiredSet::new(MAX_RETIRED_PATH_REFS)),
            retired_binaries: StdMutex::new(RetiredSet::new(MAX_RETIRED_ENGINE_BINARIES)),
            quiesced_executables: StdMutex::new(HashSet::new()),
            quiesced_resources: StdMutex::new(HashSet::new()),
            folder_switch,
            lifecycle: KeyedLocks::default(),
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum AdmissionCancellation {
    Cancelled,
    EngineRetired,
}

impl AdmissionCancellation {
    pub(super) fn error(self) -> Error {
        match self {
            Self::Cancelled => Error::Cancellation,
            Self::EngineRetired => Error::EngineRetired,
        }
    }
}

#[derive(Clone)]
pub(super) struct EngineAdmission {
    pub(super) generation: u64,
    pub(super) engine_id: String,
    pub(super) executable: PathRef,
    pub(super) cancelled: Arc<AtomicBool>,
    pub(super) cancellation_reason: Arc<OnceLock<AdmissionCancellation>>,
    pub(super) cancel_token: CancellationToken,
    pub(super) waiting_on_migration: Arc<AtomicBool>,
    pub(super) prepared: bool,
}

impl EngineAdmission {
    pub(super) fn cancel(&self, reason: AdmissionCancellation) {
        // Publish the immutable reason before the cancellation flag. Late lease holders retain
        // this exact admission's reason even after its registry entry has been removed.
        self.cancellation_reason.get_or_init(|| reason);
        self.cancelled.store(true, Ordering::SeqCst);
        self.cancel_token.cancel();
    }

    pub(super) fn cancel_error(&self) -> Option<Error> {
        self.cancelled.load(Ordering::SeqCst).then(|| {
            self.cancellation_reason
                .get()
                .copied()
                .unwrap_or(AdmissionCancellation::Cancelled)
                .error()
        })
    }
}

pub(crate) struct AdmissionLease {
    pub(super) admissions: Arc<DashMap<EngineKey, EngineAdmission>>,
    pub(super) key: EngineKey,
    pub(super) admission: EngineAdmission,
    pub(super) operation_cancellation: Option<CancellationToken>,
    pub(super) disarmed: bool,
}

impl AdmissionLease {
    pub(super) fn generation(&self) -> u64 {
        self.admission.generation
    }

    pub(super) fn cancel_error(&self) -> Option<Error> {
        if self
            .operation_cancellation
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Some(Error::Cancellation);
        }
        self.admission.cancel_error()
    }

    pub(super) fn disarm(&mut self) {
        self.disarmed = true;
    }

    pub(super) fn operation_cancellation(&self) -> Option<CancellationToken> {
        self.operation_cancellation.clone()
    }

    pub(super) fn cancellation_probe(&self) -> (Arc<AtomicBool>, Option<CancellationToken>) {
        (
            self.admission.cancelled.clone(),
            self.operation_cancellation.clone(),
        )
    }
}

impl Drop for AdmissionLease {
    fn drop(&mut self) {
        if self.disarmed {
            return;
        }
        cancel_admission_exact(&self.admissions, &self.key, &self.admission);
    }
}

pub(super) fn cancel_admission_exact(
    admissions: &DashMap<EngineKey, EngineAdmission>,
    key: &EngineKey,
    admission: &EngineAdmission,
) -> bool {
    // Flag the captured lease even if a newer admission has already replaced
    // its map entry. A late holder must still observe cancellation of its Arc.
    admission.cancel(AdmissionCancellation::Cancelled);
    admissions
        .remove_if(key, |_, current| current.generation == admission.generation)
        .is_some()
}

impl EngineSupervisor {
    pub(super) fn allocate_generation(&self) -> Result<u64, Error> {
        self.next_generation
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                value.checked_add(1)
            })
            .map(|previous| previous + 1)
            .map_err(|_| Error::ResourceLimit("engine generation exhausted".into()))
    }

    pub(super) fn validate_admission_policy(
        &self,
        key: &EngineKey,
        engine_id: &str,
        executable: &PathRef,
    ) -> Result<(), Error> {
        self.validate_admission_policy_inner(key, engine_id, executable, true)
    }

    fn validate_admission_policy_inner(
        &self,
        key: &EngineKey,
        engine_id: &str,
        executable: &PathRef,
        check_quiesced: bool,
    ) -> Result<(), Error> {
        if self.sealed.load(Ordering::SeqCst) {
            return Err(Error::Conflict("application is shutting down".into()));
        }
        if self.is_retired(engine_id) {
            return Err(Error::EngineRetired);
        }
        if self.is_retired_executable(executable) {
            return Err(Error::Conflict("engine executable is retired".into()));
        }
        if check_quiesced
            && (self
                .quiesced_executables
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains(executable)
                || self
                    .quiesced_resources
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .contains(executable))
        {
            return Err(Error::Conflict("engine folder move is in progress".into()));
        }
        if !is_game_engine_key(key) && self.is_retired_binary(engine_id, executable) {
            return Err(Error::Conflict("engine binary pair is retired".into()));
        }
        Ok(())
    }

    pub(super) fn cancel_admission(&self, key: &EngineKey, admission: &EngineAdmission) -> bool {
        cancel_admission_exact(&self.admissions, key, admission)
    }

    pub(super) fn cancel_admissions_matching(
        &self,
        reason: AdmissionCancellation,
        predicate: impl Fn(&EngineKey, &EngineAdmission) -> bool,
    ) {
        let targets: Vec<_> = self
            .admissions
            .iter()
            .filter(|entry| predicate(entry.key(), entry.value()))
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect();
        for (key, admission) in targets {
            admission.cancel(reason);
            self.cancel_admission(&key, &admission);
        }
    }

    pub(super) async fn admit(
        &self,
        key: EngineKey,
        engine_id: String,
        executable: PathRef,
        prepared: bool,
    ) -> Result<AdmissionLease, Error> {
        self.admit_with_resources_and_cancellation(key, engine_id, executable, &[], prepared, None)
            .await
    }

    pub(super) async fn wait_for_migration_under_lease(
        &self,
        lease: &AdmissionLease,
        path_refs: &[&PathRef],
        operation_cancellation: Option<&CancellationToken>,
    ) -> Result<(), Error> {
        struct WaitingOnMigrationReset<'a>(&'a AtomicBool);
        impl Drop for WaitingOnMigrationReset<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        // Always clear `waiting_on_migration` on every exit path (including the early return
        // below when the gate released between admission insertion and this wait), so a later
        // `quiesce_executables` never skips a live admission.
        let _reset = WaitingOnMigrationReset(&lease.admission.waiting_on_migration);
        if !self.folder_switch.is_engine_admission_gated(path_refs) {
            return Ok(());
        }
        lease
            .admission
            .waiting_on_migration
            .store(true, Ordering::SeqCst);
        let wait_result = self
            .folder_switch
            .wait_for_engine_admission(
                path_refs,
                Some(&lease.admission.cancel_token),
                operation_cancellation,
            )
            .await;
        drop(_reset);
        if let Some(error) = lease.cancel_error() {
            return Err(error);
        }
        wait_result
    }

    async fn admit_with_resources_and_cancellation(
        &self,
        key: EngineKey,
        engine_id: String,
        executable: PathRef,
        resources: &[PathRef],
        prepared: bool,
        operation_cancellation: Option<&CancellationToken>,
    ) -> Result<AdmissionLease, Error> {
        validate_uci_text("engine", &engine_id)?;
        let mut gated_refs: Vec<&PathRef> = Vec::with_capacity(1 + resources.len());
        gated_refs.push(&executable);
        gated_refs.extend(resources.iter());
        let migration_gated = self.folder_switch.is_engine_admission_gated(&gated_refs);
        self.validate_admission_policy_inner(&key, &engine_id, &executable, !migration_gated)?;
        let generation = self.allocate_generation()?;
        let admission = EngineAdmission {
            generation,
            engine_id,
            executable,
            cancelled: Arc::new(AtomicBool::new(false)),
            cancellation_reason: Arc::default(),
            cancel_token: CancellationToken::new(),
            waiting_on_migration: Arc::new(AtomicBool::new(migration_gated)),
            prepared,
        };
        let lease = AdmissionLease {
            admissions: self.admissions.clone(),
            key,
            admission,
            operation_cancellation: operation_cancellation.cloned(),
            disarmed: false,
        };
        {
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let still_gated = {
                let mut refs: Vec<&PathRef> = Vec::with_capacity(1 + resources.len());
                refs.push(&lease.admission.executable);
                refs.extend(resources.iter());
                self.folder_switch.is_engine_admission_gated(&refs)
            };
            lease
                .admission
                .waiting_on_migration
                .store(still_gated, Ordering::SeqCst);
            self.validate_admission_policy_inner(
                &lease.key,
                &lease.admission.engine_id,
                &lease.admission.executable,
                !still_gated,
            )?;
            if prepared
                && self
                    .admissions
                    .iter()
                    .filter(|entry| entry.value().prepared && entry.key() != &lease.key)
                    .count()
                    >= MAX_PENDING_ENGINE_SEARCHES
            {
                return Err(Error::ResourceLimit(
                    "too many pending engine searches".into(),
                ));
            }
            if let Some(previous) = self
                .admissions
                .insert(lease.key.clone(), lease.admission.clone())
            {
                previous.cancel(AdmissionCancellation::Cancelled);
            }
        }
        // Wait on the Engine migration gate AFTER inserting the admission into `self.admissions`,
        // so tab close, kill, retirement, replacement, and shutdown cancel this parked caller
        // immediately without leaking a reservation.
        {
            let mut refs: Vec<&PathRef> = Vec::with_capacity(1 + resources.len());
            refs.push(&lease.admission.executable);
            refs.extend(resources.iter());
            self.wait_for_migration_under_lease(&lease, &refs, operation_cancellation)
                .await?;
        }
        let _registration = self.registration.lock().await;
        if let Some(error) = lease.cancel_error() {
            return Err(error);
        }
        self.validate_admission_policy(
            &lease.key,
            &lease.admission.engine_id,
            &lease.admission.executable,
        )?;
        Ok(lease)
    }

    /// Reserves the exact engine generation and binds its publication barrier to the owning
    /// native operation. Cancellation is checked by the admission lease before an actor can be
    /// published, without creating a second engine identity or cancellation registry.
    #[cfg(test)]
    pub(crate) async fn admit_for_operation(
        &self,
        key: EngineKey,
        engine_id: String,
        executable: PathRef,
        cancellation: CancellationToken,
    ) -> Result<AdmissionLease, Error> {
        self.admit_for_operation_with_resources(key, engine_id, executable, &[], cancellation)
            .await
    }

    pub(crate) async fn admit_for_operation_with_resources(
        &self,
        key: EngineKey,
        engine_id: String,
        executable: PathRef,
        resources: &[PathRef],
        cancellation: CancellationToken,
    ) -> Result<AdmissionLease, Error> {
        let mut admission = self
            .admit_with_resources_and_cancellation(
                key,
                engine_id,
                executable,
                resources,
                false,
                Some(&cancellation),
            )
            .await?;
        admission.operation_cancellation = Some(cancellation);
        if let Some(error) = admission.cancel_error() {
            return Err(error);
        }
        Ok(admission)
    }

    pub(crate) async fn admit_for_launch(
        &self,
        key: EngineKey,
        engine_id: String,
        executable: PathRef,
    ) -> Result<AdmissionLease, Error> {
        self.admit_for_launch_with_resources(key, engine_id, executable, &[])
            .await
    }

    pub(crate) async fn admit_for_launch_with_resources(
        &self,
        key: EngineKey,
        engine_id: String,
        executable: PathRef,
        resources: &[PathRef],
    ) -> Result<AdmissionLease, Error> {
        self.admit_with_resources_and_cancellation(
            key, engine_id, executable, resources, false, None,
        )
        .await
    }

    pub async fn prepare_engine_search(
        &self,
        key: EngineKey,
        engine_id: String,
        executable: PathRef,
    ) -> Result<String, Error> {
        let mut lease = self.admit(key, engine_id, executable, true).await?;
        let generation = lease.generation();
        lease.disarm();
        Ok(generation.to_string())
    }

    pub(crate) async fn consume_engine_search(
        &self,
        key: EngineKey,
        engine_id: String,
        executable: PathRef,
        generation: &str,
    ) -> Result<AdmissionLease, Error> {
        let generation = generation.parse::<u64>().map_err(|_| {
            Error::Conflict("engine search reservation is invalid or expired".into())
        })?;
        let lease = {
            let _registration = self.registration.lock().await;
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(admission) = self.admissions.get(&key).map(|entry| entry.clone()) else {
                return Err(Error::Conflict(
                    "engine search reservation is invalid or expired".into(),
                ));
            };
            if admission.generation != generation {
                return Err(Error::Conflict(
                    "engine search reservation is invalid or expired".into(),
                ));
            }
            if let Some(error) = admission.cancel_error() {
                return Err(error);
            }
            if admission.engine_id != engine_id
                || admission.executable != executable
                || !admission.prepared
            {
                return Err(Error::Conflict(
                    "engine search reservation does not match the request".into(),
                ));
            }
            let updated = EngineAdmission {
                prepared: false,
                ..admission
            };
            self.admissions.insert(key.clone(), updated.clone());
            AdmissionLease {
                admissions: self.admissions.clone(),
                key,
                admission: updated,
                operation_cancellation: None,
                disarmed: false,
            }
        };
        // Wait on the Engine migration gate while the live admission lease is in `self.admissions`,
        // so tab close, kill, retirement, or shutdown cancels a parked consumer immediately.
        let exec_ref = lease.admission.executable.clone();
        self.wait_for_migration_under_lease(&lease, &[&exec_ref], None)
            .await?;
        let _registration = self.registration.lock().await;
        if let Some(error) = lease.cancel_error() {
            return Err(error);
        }
        self.validate_admission_policy(
            &lease.key,
            &lease.admission.engine_id,
            &lease.admission.executable,
        )?;
        Ok(lease)
    }

    pub(super) fn with_retired<T>(
        &self,
        operation: impl FnOnce(&mut RetiredSet<String>) -> T,
    ) -> T {
        match self.retired.lock() {
            Ok(mut retired) => operation(&mut retired),
            Err(poisoned) => operation(&mut poisoned.into_inner()),
        }
    }

    pub(super) fn is_retired(&self, engine_id: &str) -> bool {
        self.with_retired(|retired| retired.entries.contains(engine_id))
    }

    pub(super) fn with_retired_executables<T>(
        &self,
        operation: impl FnOnce(&mut RetiredSet<PathRef>) -> T,
    ) -> T {
        match self.retired_executables.lock() {
            Ok(mut retired) => operation(&mut retired),
            Err(poisoned) => operation(&mut poisoned.into_inner()),
        }
    }

    pub(super) fn is_retired_executable(&self, executable: &PathRef) -> bool {
        self.with_retired_executables(|retired| retired.entries.contains(executable))
    }

    pub(super) fn with_retired_binaries<T>(
        &self,
        operation: impl FnOnce(&mut RetiredSet<(String, PathRef)>) -> T,
    ) -> T {
        let mut retired = self
            .retired_binaries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        operation(&mut retired)
    }

    pub(super) fn is_retired_binary(&self, engine_id: &str, executable: &PathRef) -> bool {
        self.with_retired_binaries(|retired| {
            retired
                .entries
                .contains(&(engine_id.into(), executable.clone()))
        })
    }

    pub(super) fn lifecycle_lease(&self, key: &EngineKey) -> KeyedLockLease<'_, EngineKey> {
        self.lifecycle.lease(key.clone())
    }

    #[cfg(test)]
    pub async fn replace(
        &self,
        key: EngineKey,
        actor: EngineActor,
    ) -> Result<SupervisedEngine, Error> {
        let engine_id = key.engine.clone();
        let executable = PathRef {
            id: format!("test-{}", key.engine),
        };
        self.replace_handle(key, Arc::new(actor), engine_id, executable)
            .await
    }

    #[cfg(test)]
    pub async fn replace_handle(
        &self,
        key: EngineKey,
        actor: Arc<EngineActor>,
        engine_id: String,
        executable: PathRef,
    ) -> Result<SupervisedEngine, Error> {
        let admission = match self
            .admit(key.clone(), engine_id.clone(), executable.clone(), false)
            .await
        {
            Ok(admission) => admission,
            Err(primary) => {
                return Err(Error::with_cleanup(primary, actor.terminate().await));
            }
        };
        let pending = self.track_pending_actor(key.clone(), actor, &admission);
        let mut actor_guard = PendingActorGuard::new(pending.clone(), self.pending_actors.clone());
        let result = self.publish_admitted(key, pending, admission).await;
        actor_guard.disarm();
        result
    }

    pub(super) async fn publish_admitted(
        &self,
        key: EngineKey,
        pending: Arc<PendingActor>,
        admission: AdmissionLease,
    ) -> Result<SupervisedEngine, Error> {
        let previous = {
            let _registration = self.registration.lock().await;
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let valid = admission.cancel_error().is_none()
                && self
                    .validate_admission_policy(
                        &key,
                        &admission.admission.engine_id,
                        &admission.admission.executable,
                    )
                    .is_ok();
            if valid {
                self.observe_previous_termination_locked(&key, admission.generation())
            } else {
                None
            }
        };
        let lifecycle = self.lifecycle_lease(&key);
        let _transition = lifecycle.lock().await;
        self.publish_admitted_locked(key, pending, admission, previous)
            .await
    }

    pub(super) async fn publish_admitted_locked(
        &self,
        key: EngineKey,
        pending: Arc<PendingActor>,
        mut admission: AdmissionLease,
        previous: Option<Arc<PendingTermination>>,
    ) -> Result<SupervisedEngine, Error> {
        let actor = pending
            .actor
            .get()
            .cloned()
            .ok_or(Error::EngineDisconnected)?;
        let _ = actor
            .registration_identity
            .set((key.clone(), admission.generation()));
        debug_assert!(actor
            .registration_identity
            .get()
            .is_some_and(|(bound_key, generation)| {
                bound_key == &key && *generation == admission.generation()
            }));
        if let Some(error) = admission.cancel_error() {
            return Err(reject_actor(&pending, self.pending_actors.clone(), error).await);
        }
        if let Err(error) = self.validate_admission_policy(
            &key,
            &admission.admission.engine_id,
            &admission.admission.executable,
        ) {
            return Err(reject_actor(&pending, self.pending_actors.clone(), error).await);
        }
        let previous = if previous.is_some() {
            previous
        } else {
            let _registration = self.registration.lock().await;
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.observe_previous_termination_locked(&key, admission.generation())
        };
        if let Some(previous) = previous {
            if let Err(primary) = previous.wait().await {
                return Err(reject_actor(&pending, self.pending_actors.clone(), primary).await);
            }
        }
        let registration = self.registration.lock().await;
        if let Err(error) = self.validate_admission_policy(
            &key,
            &admission.admission.engine_id,
            &admission.admission.executable,
        ) {
            drop(registration);
            return Err(reject_actor(&pending, self.pending_actors.clone(), error).await);
        }
        let resource_quiesced = {
            let quiesced_resources = self
                .quiesced_resources
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            pending
                .resources
                .iter()
                .any(|resource| quiesced_resources.contains(resource))
        };
        if resource_quiesced {
            drop(registration);
            return Err(reject_actor(
                &pending,
                self.pending_actors.clone(),
                Error::Conflict("engine folder move is in progress".into()),
            )
            .await);
        }
        let published = {
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let current = self.admissions.get(&key).map(|entry| entry.clone());
            if current.as_ref().is_none_or(|current| {
                current.generation != admission.generation()
                    || current.cancelled.load(Ordering::SeqCst)
            }) {
                None
            } else {
                let generation = admission.generation();
                let entry = SupervisedEngine::new(
                    generation,
                    admission.admission.engine_id.clone(),
                    admission.admission.executable.clone(),
                    actor.clone(),
                    Arc::new(AtomicBool::new(false)),
                );
                debug_assert!(actor.registration_identity.get().is_some_and(
                    |(bound_key, bound_generation)| {
                        bound_key == &key && *bound_generation == generation
                    }
                ));
                self.actors.insert(key, entry.clone());
                self.pending_actors.remove(&generation);
                self.admissions.remove_if(&admission.key, |_, current| {
                    current.generation == generation
                });
                Some(entry)
            }
        };
        drop(registration);
        let Some(entry) = published else {
            return Err(
                reject_actor(&pending, self.pending_actors.clone(), Error::Cancellation).await,
            );
        };
        admission.disarm();
        Ok(entry)
    }

    /// Serialize stop, options, position, ready and go with the existing lifecycle lease.
    /// The returned snapshot owns only this search's output; the mirror stays with the actor.
    pub(crate) async fn start_interactive_search(
        self: &Arc<Self>,
        key: EngineKey,
        engine: EngineHandle,
        authority: crate::infra::path_authority::SharedPathAuthority,
        mut admission: AdmissionLease,
        options: crate::chess::EngineOptions,
        mode: &GoMode,
    ) -> Result<
        (
            crate::chess::EngineProcess,
            SupervisedEngine,
            SupervisedSearch,
        ),
        Error,
    > {
        let mut guard =
            RegistrationGuard::for_search(self.clone(), key.clone(), admission.generation());
        let option_resources = crate::engine::resource_path_refs(&options.extra_options);
        if !option_resources.is_empty() {
            let refs: Vec<&PathRef> = option_resources.iter().collect();
            self.wait_for_migration_under_lease(&admission, &refs, None)
                .await?;
        }
        let lifecycle = self.lifecycle_lease(&key);
        let _transition = lifecycle.lock().await;
        if let Some(error) = admission.cancel_error() {
            return Err(error);
        }
        self.validate_admission_policy(&key, &admission.admission.engine_id, &engine.id)?;
        let search = SupervisedSearch::new(
            admission.generation(),
            admission.admission.cancelled.clone(),
        );
        let mut reused = None;
        if let Some(current) = self.get_exact(&key) {
            if current.engine_id == admission.admission.engine_id
                && current.executable == engine.id
                && !current.cancelled.load(Ordering::SeqCst)
                && current.actor.terminal_snapshot().is_none()
            {
                let mirror = current.interactive.lock().await;
                if mirror.as_ref().is_some_and(|warm| warm.can_reuse(&options)) {
                    reused = Some(current.clone());
                }
            }
        }
        let current = if let Some(current) = reused {
            current.bind_search(search.clone());
            if search.cancelled.load(Ordering::SeqCst) {
                return Err(Error::Cancellation);
            }
            if let Err(primary) = current.actor.stop_current().await {
                let primary =
                    cancelled_search_error(primary, search.cancelled.load(Ordering::SeqCst));
                let cleanup = self.reap_published(&key, current.generation).await;
                return Err(Error::with_cleanup(primary, cleanup));
            }
            if search.cancelled.load(Ordering::SeqCst) {
                return Err(Error::Cancellation);
            }
            let _registration = self.registration.lock().await;
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(error) = admission.cancel_error() {
                return Err(error);
            }
            self.validate_admission_policy(&key, &admission.admission.engine_id, &engine.id)?;
            self.admissions
                .remove_if(&key, |_, pending| pending.generation == search.generation);
            admission.disarm();
            current
        } else {
            let (executable, resolved) = resolve_launch(
                authority,
                engine,
                PathOperation::EngineExecute,
                &options.extra_options,
                &admission,
            )
            .await?;
            let pending = self.spawn_pending(&key, executable, &admission).await?;
            let mut guard = PendingActorGuard::new(pending.clone(), self.pending_actors.clone());
            let published = self
                .publish_admitted_locked(key.clone(), pending, admission, None)
                .await;
            guard.disarm();
            let current = published?;
            current.bind_search(search.clone());
            let initialized =
                crate::chess::WarmEngine::new(current.actor.clone(), resolved, &search.cancelled)
                    .await;
            match initialized {
                Ok(warm) => *current.interactive.lock().await = Some(warm),
                Err(primary) => {
                    let primary =
                        cancelled_search_error(primary, search.cancelled.load(Ordering::SeqCst));
                    let cleanup = self.reap_published(&key, current.generation).await;
                    return Err(Error::with_cleanup(primary, cleanup));
                }
            }
            current
        };
        let result = async {
            if search.cancelled.load(Ordering::SeqCst) {
                return Err(Error::Cancellation);
            }
            let mut mirror = current.interactive.lock().await;
            let warm = mirror.as_mut().ok_or(Error::EngineNotInitialized)?;
            warm.start(options, mode, &search.cancelled).await
        }
        .await;
        match result {
            Ok(process) => {
                guard.disarm();
                let mut snapshot = current;
                snapshot.search = Arc::new(StdMutex::new(Some(search.clone())));
                Ok((process, snapshot, search))
            }
            Err(Error::Cancellation) => {
                guard.disarm();
                Err(Error::Cancellation)
            }
            Err(primary) => {
                let primary =
                    cancelled_search_error(primary, search.cancelled.load(Ordering::SeqCst));
                let cleanup = self.reap_published(&key, current.generation).await;
                Err(Error::with_cleanup(primary, cleanup))
            }
        }
    }

    pub async fn terminate_exact(&self, key: &EngineKey, generation: u64) -> Result<(), Error> {
        let target = {
            let _registration = self.registration.lock().await;
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let current = self
                .get_exact(key)
                .filter(|entry| entry.generation == generation);
            if let Some(current) = &current {
                current.mark_cancelled();
            }
            let targeted = current.map(|entry| entry.actor).or_else(|| {
                self.pending_actors
                    .get(&generation)
                    .filter(|entry| &entry.key == key)
                    .and_then(|entry| entry.actor.get().cloned())
            });
            if let Some(actor) = &targeted {
                actor.interrupt.cancel();
            }
            if let Some(admission) = self
                .admissions
                .get(key)
                .map(|entry| entry.clone())
                .filter(|entry| entry.generation == generation)
            {
                self.cancel_admission(key, &admission);
            }
            let attempt = self.observe_termination_locked(key, generation, false);
            ObservedTerminationTarget {
                key: key.clone(),
                generation,
                actor: targeted,
                attempt,
            }
        };
        self.wait_for_termination(&target).await
    }

    pub(super) async fn wait_for_termination(
        &self,
        target: &ObservedTerminationTarget,
    ) -> Result<(), Error> {
        let lifecycle = self.lifecycle_lease(&target.key);
        let _transition = lifecycle.lock().await;
        match (&target.attempt, &target.actor) {
            (Some(attempt), _) => attempt.wait().await,
            (None, Some(actor)) => actor.final_termination_outcome().await,
            (None, None) => Ok(()),
        }
    }

    #[cfg(test)]
    pub async fn stop_exact(&self, key: &EngineKey) -> Result<(), Error> {
        self.stop_generation(key, None).await
    }

    #[cfg(test)]
    pub async fn stop_generation(
        &self,
        key: &EngineKey,
        generation: Option<u64>,
    ) -> Result<(), Error> {
        self.stop_or_release(key, generation, generation.is_none())
            .await
            .map(|_| ())
    }

    /// Whether this exact stop retained an actor serving the requested search.
    pub async fn stop_search(
        &self,
        key: &EngineKey,
        generation: Option<u64>,
    ) -> Result<bool, Error> {
        self.stop_or_release(key, generation, generation.is_none())
            .await
    }

    pub async fn release_generation(&self, key: &EngineKey, generation: u64) -> Result<(), Error> {
        self.stop_or_release(key, Some(generation), true)
            .await
            .map(|_| ())
    }

    pub(super) async fn stop_or_release(
        &self,
        key: &EngineKey,
        generation: Option<u64>,
        release: bool,
    ) -> Result<bool, Error> {
        let (owner_generation, captured_admission, pending_owners) = {
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let owner_generation = self.actors.get(key).map(|entry| entry.owner_generation());
            let captured_admission = if generation.is_none() {
                self.admissions.get(key).map(|entry| entry.clone())
            } else {
                None
            };
            let pending_owners = if generation.is_none() {
                self.pending_actors
                    .iter()
                    .filter(|entry| &entry.key == key)
                    .map(|entry| entry.owner_generation)
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            (owner_generation, captured_admission, pending_owners)
        };
        let mut target_generations = HashSet::new();
        if let Some(generation) = generation {
            target_generations.insert(generation);
        } else {
            target_generations.extend(owner_generation);
            target_generations.extend(pending_owners);
            target_generations.extend(captured_admission.as_ref().map(|entry| entry.generation));
        }
        if target_generations.is_empty() {
            return Ok(false);
        }
        let selected_actor = self
            .get_exact(key)
            .filter(|current| target_generations.contains(&current.owner_generation()))
            .map(|current| current.generation);
        if let Some(current) = self.get_exact(key) {
            if let Some(search) = current
                .current_search()
                .filter(|search| target_generations.contains(&search.generation))
            {
                search.mark_cancelled();
            }
        }
        let registration = self.registration.lock().await;
        let attempts = {
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let admission = match generation {
                Some(generation) => self
                    .admissions
                    .get(key)
                    .map(|entry| entry.clone())
                    .filter(|entry| entry.generation == generation),
                None => captured_admission,
            };
            if let Some(admission) = &admission {
                self.cancel_admission(key, admission);
            }
            if let Some(current) = self
                .get_exact(key)
                .filter(|entry| target_generations.contains(&entry.owner_generation()))
            {
                if release {
                    current.mark_cancelled();
                } else if let Some(search) = current.current_search() {
                    search.mark_cancelled();
                }
            }
            // Warm stop keeps serving the actor. Physical release, a terminal
            // actor, or an already handed-off owner binds cleanup before waiting.
            let physical = self.get_exact(key).filter(|current| {
                target_generations.contains(&current.owner_generation())
                    && (release || current.actor.terminal_snapshot().is_some())
            });
            let mut generations = self
                .pending_actors
                .iter()
                .filter_map(|entry| {
                    (&entry.key == key
                        && (target_generations.contains(&entry.owner_generation)
                            || selected_actor == Some(entry.generation)))
                    .then_some(entry.generation)
                })
                .collect::<HashSet<_>>();
            generations.extend(physical.map(|current| current.generation));
            generations
                .into_iter()
                .filter_map(|generation| self.observe_termination_locked(key, generation, true))
                .collect::<Vec<_>>()
        };
        drop(registration);
        let lifecycle = self.lifecycle_lease(key);
        let _transition = lifecycle.lock().await;
        if !attempts.is_empty() {
            let results =
                futures_util::future::join_all(attempts.iter().map(|attempt| attempt.wait())).await;
            return results
                .into_iter()
                .fold(Ok(()), combine_shutdown_results)
                .map(|_| false);
        }
        let Some(current) = self.actors.get(key).map(|entry| entry.clone()) else {
            if let Some(generation) = selected_actor {
                self.reap_published(key, generation).await?;
            }
            return Ok(false);
        };
        if !target_generations.contains(&current.owner_generation()) {
            // Equal actor generations mean the published actor now serves another search.
            // Leave that actor published so a stale exact stop cannot reap its new owner.
            if let Some(generation) =
                selected_actor.filter(|generation| *generation != current.generation)
            {
                self.reap_published(key, generation).await?;
            }
            return Ok(false);
        }
        if !release && current.actor.terminal_snapshot().is_none() {
            if let Some(search) = current.current_search() {
                search.mark_cancelled();
                let stop = current.actor.stop_current().await;
                return match stop {
                    Ok(()) => Ok(true),
                    Err(primary) => {
                        let cleanup = self.reap_published(key, current.generation).await;
                        Err(Error::with_cleanup(primary, cleanup))
                    }
                };
            }
        }
        current.mark_cancelled();
        let stop = current.actor.stop_current().await;
        let terminate = self.reap_published(key, current.generation).await;
        combine_shutdown_results(stop, terminate).map(|_| false)
    }

    /// Cancels work already admitted for this key without waiting for its launch lock.
    pub async fn kill_engine(&self, key: &EngineKey) -> Result<(), Error> {
        let (published, pending) = {
            let _registration = self.registration.lock().await;
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(mut admission) = self.admissions.get_mut(key) {
                admission.cancel(AdmissionCancellation::Cancelled);
                admission.prepared = false;
            }
            let published = self
                .get_exact(key)
                .and_then(|current| self.handoff_published_locked(key, current.generation));
            let pending: Vec<_> = self
                .pending_actors
                .iter()
                .filter(|entry| {
                    &entry.key == key
                        && published
                            .as_ref()
                            .is_none_or(|published| published.generation != entry.generation)
                })
                .map(|entry| entry.value().clone())
                .collect();
            let published = published.map(|entry| {
                let attempt = entry.start_termination(self.pending_actors.clone());
                (entry, attempt)
            });
            let pending = pending
                .into_iter()
                .map(|entry| {
                    let attempt = entry.start_termination(self.pending_actors.clone());
                    (entry, attempt)
                })
                .collect::<Vec<_>>();
            (published, pending)
        };
        #[cfg(test)]
        for (entry, _) in published.iter().chain(pending.iter()) {
            if let Some(gate) = TEARDOWN_SNAPSHOT_GATES.take(&(entry.key.clone(), entry.generation))
            {
                gate.park().await;
            }
        }
        let published = async {
            match published {
                Some((_, attempt)) => attempt.wait().await,
                None => Ok(()),
            }
        };
        let pending = futures_util::future::join_all(
            pending
                .into_iter()
                .map(|(_, attempt)| async move { attempt.wait().await }),
        );
        let (published, pending) = tokio::join!(published, pending);
        pending
            .into_iter()
            .fold(published, combine_shutdown_results)
    }

    // Caller holds registration, then admission coordination. Insert before removal so
    // every drain can see the child until the shared termination task completes.
    pub(super) fn handoff_published_locked(
        &self,
        key: &EngineKey,
        generation: u64,
    ) -> Option<Arc<PendingActor>> {
        if let Some(current) = self
            .get_exact(key)
            .filter(|entry| entry.generation == generation)
        {
            current.mark_cancelled();
            let pending = self
                .pending_actors
                .entry(generation)
                .or_insert_with(|| {
                    let mut pending = PendingActor::new(
                        current.actor.clone(),
                        key.clone(),
                        generation,
                        current.engine_id.clone(),
                        current.executable.clone(),
                    );
                    pending.owner_generation = current.owner_generation();
                    Arc::new(pending)
                })
                .clone();
            self.actors
                .remove_if(key, |_, entry| entry.generation == generation);
            Some(pending)
        } else {
            self.pending_actors
                .get(&generation)
                .filter(|entry| &entry.key == key)
                .map(|entry| entry.value().clone())
        }
    }

    pub(super) async fn reap_published(
        &self,
        key: &EngineKey,
        generation: u64,
    ) -> Result<(), Error> {
        let attempt = {
            let _registration = self.registration.lock().await;
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.observe_termination_locked(key, generation, false)
        };
        match attempt {
            Some(attempt) => attempt.wait().await,
            None => Ok(()),
        }
    }

    // Bind the immutable attempt under the publication barrier, before any
    // lifecycle wait. The attempt task owns cleanup even if its caller cancels.
    pub(super) fn observe_termination_locked(
        &self,
        key: &EngineKey,
        generation: u64,
        stop_first: bool,
    ) -> Option<Arc<PendingTermination>> {
        self.handoff_published_locked(key, generation)
            .map(|entry| entry.start_termination_with_stop(self.pending_actors.clone(), stop_first))
    }

    pub(super) fn observe_previous_termination_locked(
        &self,
        key: &EngineKey,
        generation: u64,
    ) -> Option<Arc<PendingTermination>> {
        let previous = self
            .get_exact(key)
            .map(|current| current.generation)
            .or_else(|| {
                self.pending_actors
                    .iter()
                    .filter(|entry| &entry.key == key && entry.generation < generation)
                    .filter(|entry| {
                        entry
                            .termination
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .as_ref()
                            .is_some_and(|attempt| attempt.result.get().is_none())
                    })
                    .map(|entry| entry.generation)
                    .max()
            });
        previous.and_then(|previous| self.observe_termination_locked(key, previous, true))
    }

    pub fn get_exact(&self, key: &EngineKey) -> Option<SupervisedEngine> {
        self.actors.get(key).map(|entry| entry.clone())
    }

    #[cfg(test)]
    pub(crate) fn registered_keys_for_tab(&self, tab: &str) -> Vec<EngineKey> {
        self.actors
            .iter()
            .filter(|entry| entry.key().tab == tab)
            .map(|entry| entry.key().clone())
            .collect()
    }

    #[cfg(all(test, unix))]
    pub(crate) fn owned_keys_for_tab(&self, tab: &str) -> Vec<EngineKey> {
        let mut keys = self.registered_keys_for_tab(tab);
        for entry in self
            .pending_actors
            .iter()
            .filter(|entry| entry.key.tab == tab)
        {
            if !keys.contains(&entry.key) {
                keys.push(entry.key.clone());
            }
        }
        keys
    }

    #[cfg(test)]
    pub(crate) fn owns_generation(&self, key: &EngineKey, generation: u64) -> bool {
        self.get_exact(key)
            .is_some_and(|entry| entry.generation == generation)
            || self
                .pending_actors
                .get(&generation)
                .is_some_and(|entry| &entry.key == key)
    }

    pub fn cancel_exact(&self, key: &EngineKey, generation: u64) -> bool {
        let Some(current) = self.actors.get(key) else {
            return false;
        };
        if current.generation != generation {
            return false;
        }
        current.mark_cancelled();
        true
    }

    pub async fn terminate_tab(&self, tab: &str) -> Result<(), Error> {
        // Same publication barrier as `terminate_all` / `retire_engine`: wait
        // for in-flight admission and `publish_admitted` checks before scanning,
        // then drain until this tab has no actors.
        let registration = self.registration.lock().await;
        let _coordination = self
            .admission_coordination
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.cancel_admissions_matching(AdmissionCancellation::Cancelled, |key, _| key.tab == tab);
        drop(_coordination);
        drop(registration);
        self.drain_matching(|key, _, _| key.tab == tab).await
    }

    pub async fn retire_engine(&self, engine_id: String) -> Result<(), Error> {
        validate_uci_text("engine", &engine_id)?;
        self.with_retired(|retired| retired.insert(engine_id.clone()));
        self.retire_matching(AdmissionCancellation::EngineRetired, |key, owner, _| {
            key.engine == engine_id || owner == engine_id
        })
        .await
    }

    #[cfg(test)]
    pub async fn retire_engine_binary(
        &self,
        engine_id: String,
        retired: PathRef,
        current: PathRef,
    ) -> Result<(), Error> {
        let retirement = self
            .capture_binary_retirement(engine_id, retired, current, true)
            .await?;
        self.resume_binary_retirement(&retirement).await
    }

    /// Capture the original transition once. A workflow retains these exact generations so a
    /// later document can observe cleanup without changing the user's newer admission state.
    pub(crate) async fn capture_binary_retirement(
        &self,
        engine_id: String,
        retired: PathRef,
        current: PathRef,
        transition: bool,
    ) -> Result<EngineBinaryRetirement, Error> {
        validate_uci_text("engine", &engine_id)?;
        if retired == current || !transition {
            return Ok(EngineBinaryRetirement {
                targets: Vec::new(),
                observed: AtomicBool::new(false),
                observation: Mutex::new(()),
            });
        }
        let _registration = self.registration.lock().await;
        let _coordination = self
            .admission_coordination
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.with_retired_binaries(|binaries| {
            binaries.remove(&(engine_id.clone(), current));
            binaries.insert((engine_id.clone(), retired.clone()));
        });
        let matches = |key: &EngineKey, owner: &str, path: &PathRef| {
            !is_game_engine_key(key) && owner == engine_id && path == &retired
        };
        self.cancel_admissions_matching(AdmissionCancellation::Cancelled, |key, admission| {
            matches(key, &admission.engine_id, &admission.executable)
        });
        let published: Vec<_> = self
            .actors
            .iter()
            .filter(|entry| matches(entry.key(), &entry.engine_id, &entry.executable))
            .map(|entry| (entry.key().clone(), entry.generation))
            .collect();
        let mut targets: Vec<_> = self
            .pending_actors
            .iter()
            .filter(|entry| matches(&entry.key, &entry.engine_id, &entry.executable))
            .map(|entry| entry.value().clone())
            .collect();
        for (key, generation) in published {
            if let Some(entry) = self.handoff_published_locked(&key, generation) {
                if !targets.iter().any(|target| target.generation == generation) {
                    targets.push(entry);
                }
            }
        }
        // Bind cleanup before releasing the barrier, including spawning children.
        let targets = targets
            .into_iter()
            .map(|entry| {
                let attempt = entry.start_termination(self.pending_actors.clone());
                (entry, attempt)
            })
            .collect();
        Ok(EngineBinaryRetirement {
            targets,
            observed: AtomicBool::new(false),
            observation: Mutex::new(()),
        })
    }

    pub(crate) async fn resume_binary_retirement(
        &self,
        retirement: &EngineBinaryRetirement,
    ) -> Result<(), Error> {
        let _observation = retirement.observation.lock().await;
        let first = !retirement.observed.swap(true, Ordering::SeqCst);
        let failures =
            observe_pending_terminations(retirement.targets.iter().map(|(entry, original)| {
                let attempt = if first {
                    original.clone()
                } else {
                    entry.start_termination(self.pending_actors.clone())
                };
                (entry.clone(), attempt)
            }))
            .await;
        aggregate_shutdown_failures(failures)
    }

    pub async fn retire_executables(&self, executables: Vec<PathRef>) -> Result<(), Error> {
        if executables.is_empty() {
            return Ok(());
        }
        let executable_set: HashSet<_> = executables.iter().cloned().collect();
        self.with_retired_executables(|retired| {
            for executable in executables {
                retired.insert(executable);
            }
        });
        self.retire_matching(AdmissionCancellation::Cancelled, |_, _, executable| {
            executable_set.contains(executable)
        })
        .await
    }

    /// Cancels all admissions (including prepared search reservations across all tabs, game and
    /// configure keys), refuses new admits for `executables`, and drains matching actors (including
    /// actors holding a resource lease in `resources`) without inserting into `retired_executables`.
    /// The returned guard lifts the barrier on every exit path so the same `PathRef` ids can start
    /// again afterwards.
    pub(crate) async fn quiesce_executables<'a>(
        &'a self,
        executables: HashSet<PathRef>,
        resources: HashSet<PathRef>,
    ) -> Result<EngineQuiesceGuard<'a>, Error> {
        let guard = {
            let registration = self.registration.lock().await;
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            {
                let mut quiesced = self
                    .quiesced_executables
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                for executable in &executables {
                    quiesced.insert(executable.clone());
                }
                drop(quiesced);
                let mut quiesced_resources = self
                    .quiesced_resources
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                for resource in &resources {
                    quiesced_resources.insert(resource.clone());
                }
            }
            let guard = EngineQuiesceGuard {
                supervisor: self,
                executables: executables.clone(),
                resources: resources.clone(),
                lifted: false,
            };
            self.cancel_admissions_matching(AdmissionCancellation::Cancelled, |_, admission| {
                !admission.waiting_on_migration.load(Ordering::SeqCst)
                    && (executables.contains(&admission.executable)
                        || resources.contains(&admission.executable))
            });
            drop(_coordination);
            drop(registration);
            guard
        };
        if let Err(error) = self
            .drain_matching_actors(
                |_, entry| {
                    executables.contains(&entry.executable)
                        || entry.actor.resources.iter().any(|lease| {
                            lease
                                .path_ref()
                                .is_some_and(|path_ref| resources.contains(path_ref))
                        })
                },
                |pending| {
                    executables.contains(&pending.executable)
                        || pending.resources.iter().any(|r| resources.contains(r))
                },
            )
            .await
        {
            guard.lift();
            return Err(error);
        }
        Ok(guard)
    }

    /// All tombstone operations cross the same admission/publication barrier before draining.
    pub(super) async fn retire_matching(
        &self,
        reason: AdmissionCancellation,
        matches: impl Fn(&EngineKey, &str, &PathRef) -> bool,
    ) -> Result<(), Error> {
        let registration = self.registration.lock().await;
        {
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.cancel_admissions_matching(reason, |key, admission| {
                matches(key, &admission.engine_id, &admission.executable)
            });
        }
        drop(registration);
        self.drain_matching(matches).await
    }

    pub async fn terminate_all(&self) -> Result<(), Error> {
        self.sealed.store(true, Ordering::SeqCst);
        // Synchronize with admission and the final `publish_admitted` check.
        // Once this barrier is crossed, no production path can add an actor.
        let registration = self.registration.lock().await;
        let _coordination = self
            .admission_coordination
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.cancel_admissions_matching(AdmissionCancellation::Cancelled, |_, _| true);
        for entry in self.actors.iter() {
            entry.mark_cancelled();
        }
        drop(_coordination);
        drop(registration);
        self.drain_matching(|_, _, _| true).await
    }

    pub(super) async fn drain_matching(
        &self,
        matches: impl Fn(&EngineKey, &str, &PathRef) -> bool,
    ) -> Result<(), Error> {
        self.drain_matching_actors(
            |key, entry| matches(key, &entry.engine_id, &entry.executable),
            |pending| matches(&pending.key, &pending.engine_id, &pending.executable),
        )
        .await
    }

    pub(super) async fn drain_matching_actors(
        &self,
        matches_actor: impl Fn(&EngineKey, &SupervisedEngine) -> bool,
        matches_pending: impl Fn(&PendingActor) -> bool,
    ) -> Result<(), Error> {
        let mut failures = Vec::new();
        let mut visited = HashSet::new();
        loop {
            // Publication moves between the two sets under this same barrier.
            let (targets, pending) = {
                let _registration = self.registration.lock().await;
                let _coordination = self
                    .admission_coordination
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let targets: Vec<_> = self
                    .actors
                    .iter()
                    .filter(|entry| matches_actor(entry.key(), entry.value()))
                    .filter(|entry| !visited.contains(&entry.generation))
                    .map(|entry| {
                        (
                            entry.key().clone(),
                            entry.value().generation,
                            entry.actor.clone(),
                        )
                    })
                    .collect();
                let pending: Vec<_> = self
                    .pending_actors
                    .iter()
                    .filter(|entry| matches_pending(entry.value()))
                    .filter(|entry| !visited.contains(&entry.generation))
                    .map(|entry| entry.value().clone())
                    .collect();
                let targets = targets
                    .into_iter()
                    .map(|(key, generation, actor)| {
                        let attempt = self.observe_termination_locked(&key, generation, false);
                        ObservedTerminationTarget {
                            key,
                            generation,
                            actor: Some(actor),
                            attempt,
                        }
                    })
                    .collect::<Vec<_>>();
                let pending = pending
                    .into_iter()
                    .map(|entry| {
                        let attempt = entry.start_termination(self.pending_actors.clone());
                        (entry, attempt)
                    })
                    .collect::<Vec<_>>();
                (targets, pending)
            };
            if targets.is_empty() && pending.is_empty() {
                break;
            }
            visited.extend(targets.iter().map(|target| target.generation));
            visited.extend(pending.iter().map(|(entry, _)| entry.generation));
            #[cfg(test)]
            for target in &targets {
                if let Some(gate) =
                    TEARDOWN_SNAPSHOT_GATES.take(&(target.key.clone(), target.generation))
                {
                    gate.park().await;
                }
            }
            #[cfg(test)]
            for (entry, _) in &pending {
                if let Some(gate) =
                    TEARDOWN_SNAPSHOT_GATES.take(&(entry.key.clone(), entry.generation))
                {
                    gate.park().await;
                }
            }
            let pending = observe_pending_terminations(pending);
            let (registered, pending) = tokio::join!(self.terminate_targets(targets), pending);
            failures.extend(registered);
            failures.extend(pending);
        }
        aggregate_shutdown_failures(failures)
    }

    pub(super) async fn terminate_targets(
        &self,
        targets: Vec<ObservedTerminationTarget>,
    ) -> Vec<ActorShutdownFailure> {
        let results =
            futures_util::future::join_all(targets.into_iter().map(|target| async move {
                let result = self.wait_for_termination(&target).await;
                (target.key, target.generation, result)
            }))
            .await;
        results
            .into_iter()
            .filter_map(|(key, generation, result)| {
                result.err().map(|error| ActorShutdownFailure {
                    key,
                    generation,
                    error,
                })
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn insert_test_actor_with_resources(
        &self,
        key: EngineKey,
        engine_id: String,
        executable: PathRef,
        resources: Vec<Arc<crate::infra::path_authority::EngineResourceLease>>,
        pending_only: bool,
    ) {
        let (actor, _) = EngineActor::recording_test_actor_with_resources_and_deadlines_impl(
            &["uciok", "readyok"],
            resources,
            EngineDeadlines::default(),
            None,
        );
        let generation = self.next_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = actor.registration_identity.set((key.clone(), generation));
        if pending_only {
            let pending = Arc::new(PendingActor::new(
                actor, key, generation, engine_id, executable,
            ));
            self.pending_actors.insert(generation, pending);
        } else {
            let cancelled = Arc::new(AtomicBool::new(false));
            let barrier = PublicationBarrier::new(cancelled.clone());
            self.actors.insert(
                key,
                SupervisedEngine {
                    generation,
                    engine_id,
                    executable,
                    actor,
                    cancelled,
                    barrier,
                    interactive: Arc::new(Mutex::new(None)),
                    search: Arc::new(StdMutex::new(None)),
                },
            );
        }
    }

    #[cfg(test)]
    pub(crate) fn actor_count_for_test(&self) -> usize {
        self.actors.len()
    }

    #[cfg(test)]
    pub(crate) fn pending_actor_count_for_test(&self) -> usize {
        self.pending_actors.len()
    }

    #[cfg(test)]
    pub(super) fn track_pending_actor(
        &self,
        key: EngineKey,
        actor: Arc<EngineActor>,
        admission: &AdmissionLease,
    ) -> Arc<PendingActor> {
        let _coordination = self
            .admission_coordination
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let generation = admission.generation();
        let _ = actor.registration_identity.set((key.clone(), generation));
        let pending = Arc::new(PendingActor::new(
            actor,
            key,
            generation,
            admission.admission.engine_id.clone(),
            admission.admission.executable.clone(),
        ));
        self.pending_actors.insert(generation, pending.clone());
        pending
    }

    pub(super) async fn spawn_pending(
        &self,
        key: &EngineKey,
        executable: EngineExecutable,
        admission: &AdmissionLease,
    ) -> Result<Arc<PendingActor>, Error> {
        if let Some(error) = admission.cancel_error() {
            return Err(error);
        }
        let slot =
            self.child_slots.clone().try_acquire_owned().map_err(|_| {
                Error::ResourceLimit("engine child ownership capacity reached".into())
            })?;
        let cleanup = Arc::new(ChildOwner::default());
        cleanup.state.lock().unwrap_or_else(|e| e.into_inner()).slot = Some(slot);
        let pending_resources: Vec<PathRef> = executable
            .resource_leases()
            .iter()
            .filter_map(|lease| lease.path_ref().cloned())
            .collect();
        let pending = Arc::new(PendingActor {
            actor: OnceLock::new(),
            cleanup: Some(cleanup.clone()),
            spawning: AtomicBool::new(true),
            ready: Notify::new(),
            key: key.clone(),
            generation: admission.generation(),
            owner_generation: admission.generation(),
            engine_id: admission.admission.engine_id.clone(),
            executable: admission.admission.executable.clone(),
            resources: pending_resources.clone(),
            termination: StdMutex::default(),
        });
        {
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(error) = admission.cancel_error() {
                return Err(error);
            }
            if !pending_resources.is_empty() {
                let quiesced_resources = self
                    .quiesced_resources
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if pending_resources
                    .iter()
                    .any(|r| quiesced_resources.contains(r))
                {
                    return Err(Error::Conflict("engine folder move is in progress".into()));
                }
            }
            self.pending_actors
                .insert(pending.generation, pending.clone());
        }
        let mut guard = PendingActorGuard::new(pending.clone(), self.pending_actors.clone());
        #[cfg(test)]
        self.spawn_attempts.fetch_add(1, Ordering::SeqCst);
        let spawned =
            EngineActor::spawn_owned(executable, EngineDeadlines::default(), cleanup).await;
        match spawned {
            Ok(actor) => {
                let actor = Arc::new(actor);
                let _ = actor
                    .registration_identity
                    .set((key.clone(), pending.generation));
                let _ = pending.actor.set(actor);
                pending.finish_spawn();
                guard.disarm();
                Ok(pending)
            }
            Err(primary) => {
                pending.finish_spawn();
                let result = reject_actor(&pending, self.pending_actors.clone(), primary).await;
                guard.disarm();
                Err(result)
            }
        }
    }
}
