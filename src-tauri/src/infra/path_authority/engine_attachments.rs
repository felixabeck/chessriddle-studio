use super::*;
use crate::infra::fs::{
    atomic_replace, is_atomic_temp_name, read_bounded_bytes, remove_atomic_temp_orphan_at,
    AtomicFileOutcome, AtomicTempSweepOutcome,
};
#[cfg(target_os = "macos")]
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};
use tokio::sync::Notify;

/// Counts complete blocking image issuances so shutdown cannot clean up before they settle.
pub(crate) struct ActiveImageIssuances {
    pub(super) active: AtomicUsize,
    pub(super) notify: Notify,
}

impl ActiveImageIssuances {
    pub(super) fn new() -> Self {
        Self {
            active: AtomicUsize::new(0),
            notify: Notify::new(),
        }
    }

    pub(crate) async fn wait_for_zero(&self) {
        loop {
            // Arm the notification before observing the count. Otherwise a release between
            // the check and `notified().await` can leave shutdown asleep forever.
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.active.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }
}

pub(crate) struct ActiveImageIssuanceLease {
    pub(super) tracker: Arc<ActiveImageIssuances>,
}

impl Drop for ActiveImageIssuanceLease {
    fn drop(&mut self) {
        self.tracker.active.fetch_sub(1, Ordering::AcqRel);
        self.tracker.notify.notify_waiters();
    }
}

impl PathAuthority {
    pub(crate) fn active_engine_root(&mut self) -> Result<Option<EngineRootHandle>, Error> {
        if self.has_unresolved_journal(FolderSwitchKind::Engine) {
            return Err(Self::interrupted_move_root_error());
        }
        self.resolve_active_root(
            self.active_engine_root.clone(),
            PathOperation::EngineInstall,
        )
        .map(|id| id.map(EngineRootHandle::new))
    }

    pub(crate) fn engine_root_path(&mut self, root: &EngineRootHandle) -> Result<PathBuf, Error> {
        self.root_path(root.path_ref(), PathOperation::EngineInstall)
    }

    pub(crate) fn set_active_engine_root(&mut self, root: &EngineRootHandle) -> Result<(), Error> {
        let _ = self.engine_root_path(root)?;
        let durability = self.commit_state(
            self.persistent.clone(),
            self.active_database_root.clone(),
            self.active_puzzle_root.clone(),
            Some(root.path_ref().clone()),
            self.pending_artifacts.clone(),
            None,
        )?;
        if let CommitDurability::DurabilityUncertain(stage) = durability {
            log::warn!("active engine root committed with uncertain durability: {stage}");
        }
        Ok(())
    }

    /// Registers one exact executable picked in a native dialog. The renderer receives only
    /// its opaque handle; every later execution and probe revalidates this identity. A file
    /// replaced at a stored path gets a fresh capability, and the stale entry is left for
    /// startup reconciliation once the renderer stops retaining it (d-20261113-02).
    pub(crate) fn register_engine_file(
        &mut self,
        path: &Path,
        display_name: impl Into<String>,
    ) -> Result<EngineHandle, Error> {
        if self.is_under_quiesced_engine_root(path, None, None) {
            return Err(Error::Conflict("engine folder move is in progress".into()));
        }
        let operations = engine_file_operations();
        let commit = self.get_or_create_persistent_file_inner(
            path,
            display_name.into(),
            operations,
            None,
            None,
            RegistrationDoor::PickerSelection,
        )?;
        let registered = self
            .persistent
            .get(&commit.id.id)
            .ok_or_else(|| Error::Conflict("registered engine authority disappeared".into()))?
            .stored
            .path
            .to_path()?;
        self.protect_catalog_path(&registered, false, false, None)?;
        Ok(keep_adopted_handle(
            commit.durability,
            EngineHandle::new(commit.id),
        ))
    }

    pub(super) fn register_engine_file_from_resolved(
        &mut self,
        path: &Path,
        display_name: String,
        identity: VerifiedIdentity,
        parent_identity: VerifiedIdentity,
    ) -> Result<EngineHandle, Error> {
        let operations = engine_file_operations();
        let binding = IdentityBinding::from_pairs(identity.pair(), parent_identity.pair());
        let commit = self.get_or_create_persistent_file_from_identity(
            path,
            display_name,
            operations,
            binding,
            RegistrationDoor::ExplicitReauthorization,
        )?;
        Ok(keep_adopted_handle(
            commit.durability,
            EngineHandle::new(commit.id),
        ))
    }

    /// Persists a picker-selected UCI resource with only resource-read
    /// authority.  Callers must hand us the one-time dialog grant; raw paths
    /// never cross the IPC boundary.
    pub(crate) fn promote_engine_resource(
        &mut self,
        grant: &PathRef,
        kind: EngineResourceHandleKind,
        display_name: impl Into<String>,
    ) -> Result<EngineResourceHandle, Error> {
        let display_name = display_name.into();
        let class = match kind {
            EngineResourceHandleKind::File => PathClass::PersistentFile,
            EngineResourceHandleKind::Directory => PathClass::PersistentCustomRoot,
        };
        let commit = self.promote_dialog(
            grant,
            class,
            display_name.clone(),
            canonical_operations(EntryPurpose::EngineResource),
        )?;
        Ok(keep_adopted_handle(
            commit.durability,
            EngineResourceHandle::new(commit.id, kind, display_name),
        ))
    }

    /// Resolves a UCI resource through no-follow traversal and returns a
    /// descriptor lease. The caller owns this object until the engine exits.
    pub(crate) fn engine_resource(
        &mut self,
        resource: &EngineResourceHandle,
    ) -> Result<EngineResourceLease, Error> {
        #[cfg(all(test, unix))]
        observe_engine_resolution("resource");
        let mut resolved =
            self.resolve(resource.path_ref(), PathOperation::EngineResourceRead, &[])?;
        #[cfg(windows)]
        let directories = resolved.windows_resource_directory_seals()?;
        match resource.kind {
            EngineResourceHandleKind::File => {
                #[cfg(unix)]
                let file = resolved
                    .take_file()
                    .ok_or_else(|| Error::InvalidInput("engine resource must be a file".into()))?;
                #[cfg(windows)]
                let _file = resolved
                    .take_file()
                    .ok_or_else(|| Error::InvalidInput("engine resource must be a file".into()))?;
                #[cfg(unix)]
                return Ok(EngineResourceLease::from_file(file, false, None)?
                    .with_path_ref(resource.path_ref().clone()));
                #[cfg(windows)]
                Ok(EngineResourceLease {
                    path_ref: Some(resource.path_ref().clone()),
                    _file,
                    _directories: directories,
                    target: resolved.take_target().ok_or_else(|| {
                        Error::Conflict("engine resource target is unavailable".into())
                    })?,
                })
            }
            EngineResourceHandleKind::Directory => {
                #[cfg(unix)]
                {
                    let file = resolved.take_directory().ok_or_else(|| {
                        Error::InvalidInput("engine resource must be a directory".into())
                    })?;
                    Ok(
                        EngineResourceLease::from_file(OwnedFile::directory(file)?, true, None)?
                            .with_path_ref(resource.path_ref().clone()),
                    )
                }
                #[cfg(windows)]
                {
                    // The no-follow walk leaves the verified directory handle in the
                    // `directory` slot and its computed path in `target`, mirroring the File
                    // arm above. The handle is retained for the lease lifetime; the path is
                    // only the UCI/CreateProcess string.
                    Ok(EngineResourceLease {
                        path_ref: Some(resource.path_ref().clone()),
                        _directories: directories,
                        _file: OwnedFile::directory(resolved.take_directory().ok_or_else(
                            || Error::InvalidInput("engine resource must be a directory".into()),
                        )?)?,
                        target: resolved.take_target().ok_or_else(|| {
                            Error::Conflict("engine resource target is unavailable".into())
                        })?,
                    })
                }
            }
        }
    }

    /// Registers an app-owned copied engine-image asset. The native picker is
    /// consumed before this point, so only the managed copy is persistent.
    pub(crate) fn register_engine_image(
        &mut self,
        dir: &AuthorizedDir,
        leaf: &OsStr,
        installed: VerifiedIdentity,
        display_name: String,
    ) -> Result<EngineImageHandle, Error> {
        if self.attachments_sealed {
            return Err(Error::Conflict(
                "engine attachment mutations are sealed".into(),
            ));
        }
        crate::infra::fs::single_leaf(leaf)
            .map_err(|_| Error::InvalidInput("engine image leaf must be one component".into()))?;
        let path = dir.path().join(leaf);
        #[cfg(test)]
        ENGINE_IMAGE_PRE_REGISTRATION_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        let commit = self.get_or_create_persistent_file_verified(
            &path,
            display_name,
            canonical_operations(EntryPurpose::EngineImage),
            installed,
            dir.identity(),
            RegistrationDoor::ExplicitReauthorization,
        )?;
        Ok(keep_adopted_handle(
            commit.durability,
            EngineImageHandle::new(commit.id),
        ))
    }

    /// Keeps an installed, unregistered UUID image reachable by startup and shutdown cleanup.
    /// Sealed attachments still admit cleanup intents while issuance leases drain.
    pub(crate) fn record_engine_image_cleanup(
        &mut self,
        dir: &AuthorizedDir,
        leaf: &OsStr,
        installed: VerifiedIdentity,
    ) -> EngineImageCleanupIntent {
        self.record_engine_image_cleanup_with(dir, leaf, installed, |target, write| {
            atomic_replace(target, write)
        })
    }

    pub(super) fn record_engine_image_cleanup_with<F>(
        &mut self,
        dir: &AuthorizedDir,
        leaf: &OsStr,
        installed: VerifiedIdentity,
        mut replace: F,
    ) -> EngineImageCleanupIntent
    where
        F: FnMut(
            &Path,
            Box<dyn FnOnce(&mut OwnedFile) -> Result<(), Error>>,
        ) -> Result<AtomicFileOutcome, Error>,
    {
        if crate::infra::fs::single_leaf(leaf).is_err()
            || leaf
                .to_str()
                .is_none_or(|leaf| uuid::Uuid::parse_str(leaf).is_err())
        {
            return EngineImageCleanupIntent::NotRecorded(Error::InvalidInput(
                "engine image cleanup leaf must be one UUID component".into(),
            ));
        }
        let baseline = match self.registry_admission_snapshot(
            &self.persistent,
            &self.active_database_root,
            &self.active_puzzle_root,
            &self.active_engine_root,
            &self.pending_artifacts,
            &self.provisional_attachments,
            &self.retired_attachments,
            &self.image_cleanup,
        ) {
            Ok(baseline) => baseline,
            Err(error) => return EngineImageCleanupIntent::NotRecorded(error),
        };
        let id = loop {
            let id = uuid::Uuid::new_v4().to_string();
            if !self.persistent.contains_key(&id)
                && !self.retired_attachments.contains_key(&id)
                && !self.image_cleanup.contains_key(&id)
            {
                break id;
            }
        };
        self.image_cleanup.insert(
            id.clone(),
            StoredEntry {
                id: PathRef { id: id.clone() },
                display_name: UNREGISTERED_ENGINE_IMAGE_DISPLAY_NAME.into(),
                class: PathClass::PersistentFile,
                operations: canonical_operations(EntryPurpose::EngineImage),
                path: NativePath::from_path(&dir.path().join(leaf)),
                identity: Identity {
                    a: installed.pair().0,
                    b: installed.pair().1,
                },
                parent_identity: Some(Identity {
                    a: dir.identity().pair().0,
                    b: dir.identity().pair().1,
                }),
                target_is_dir: false,
                purpose: Some(EntryPurpose::EngineImage),
                practice_key: None,
            },
        );
        let mut write_started = false;
        let result = self.save_entries_with_baseline(
            &self.persistent,
            &self.active_database_root,
            &self.active_puzzle_root,
            &self.active_engine_root,
            &self.pending_artifacts,
            Some(baseline),
            |target, write| {
                write_started = true;
                replace(target, write)
            },
        );
        match result {
            Ok(CommitDurability::Durable) => {
                self.registry_durability_pending = false;
                EngineImageCleanupIntent::Recorded
            }
            Ok(CommitDurability::DurabilityUncertain(_)) => {
                self.registry_durability_pending = true;
                EngineImageCleanupIntent::DurabilityUncertain
            }
            Err(error) if write_started => {
                self.registry_durability_pending = true;
                EngineImageCleanupIntent::Retained(error)
            }
            Err(error) => {
                self.image_cleanup.remove(&id);
                EngineImageCleanupIntent::NotRecorded(error)
            }
        }
    }

    pub(crate) fn register_opening_book(
        &mut self,
        path: &Path,
        display_name: impl Into<String>,
    ) -> Result<OpeningBookHandle, Error> {
        let commit = self.get_or_create_persistent_file_inner(
            path,
            display_name.into(),
            canonical_operations(EntryPurpose::OpeningBook),
            None,
            None,
            RegistrationDoor::PickerSelection,
        )?;
        Ok(keep_adopted_handle(
            commit.durability,
            OpeningBookHandle::new(commit.id),
        ))
    }

    /// Resolves an exact opening-book descriptor without exposing a native path.
    /// The caller moves this already-opened file to its bounded blocking worker.
    pub(crate) fn opening_book_descriptor(
        &mut self,
        book: &OpeningBookHandle,
    ) -> Result<OpeningBookDescriptor, Error> {
        let mut resolved = self.resolve(book.path_ref(), PathOperation::OpeningBookRead, &[])?;
        let file_name = self.display_name(book.path_ref())?;
        let file = resolved.take_file().ok_or_else(|| {
            Error::InvalidInput("opening-book capability names a directory".into())
        })?;
        Ok(OpeningBookDescriptor { file_name, file })
    }

    #[cfg(test)]
    pub(crate) fn register_installed_engine_for_test(
        &mut self,
        root: &EngineRootHandle,
        relative_path: &str,
    ) -> Result<EngineHandle, Error> {
        self.register_installed_engine(root, relative_path, &mut EngineRootProbe::default())
    }

    pub(crate) fn register_installed_engine(
        &mut self,
        root: &EngineRootHandle,
        relative_path: &str,
        probe: &mut EngineRootProbe,
    ) -> Result<EngineHandle, Error> {
        let components = engine_relative_components(relative_path)?;
        let (catalog_root, catalog_path, root_directory) =
            self.prepare_catalog_engine_registration(root, &components, probe)?;
        if self.is_engine_root_quiesced((catalog_root.identity.a, catalog_root.identity.b)) {
            return Err(Error::Conflict("engine folder move is in progress".into()));
        }
        let resolved = self.resolve_with_engine_probe(
            root.path_ref(),
            PathOperation::EngineInstall,
            &components,
            probe,
        )?;
        if resolved.file().is_none() {
            return Err(Error::InvalidInput(
                "installed engine must be a regular file".into(),
            ));
        }
        let identity = resolved.identity()?;
        let parent_identity = VerifiedIdentity::from_pair(resolved.parent_identity()?);
        let path = resolved
            .target()
            .ok_or_else(|| Error::InvalidInput("installed engine must be a regular file".into()))?
            .to_path_buf();
        #[cfg(test)]
        INSTALLED_ENGINE_POST_RESOLVE_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        self.confirm_catalog_engine_registration(
            &catalog_root,
            &catalog_path,
            &root_directory,
            Some((&path, identity)),
            probe,
        )?;
        resolved.mark_engine_executable()?;
        let display_name = components
            .last()
            .ok_or_else(|| Error::InvalidInput("engine path is required".into()))?
            .to_string_lossy()
            .into_owned();
        self.register_engine_file_from_resolved(&path, display_name, identity, parent_identity)
    }

    #[cfg(test)]
    pub(crate) fn engine_archive_destination(
        &mut self,
        root: &EngineRootHandle,
    ) -> Result<PathRef, Error> {
        self.engine_archive_destination_with_probe(root, &mut EngineRootProbe::default())
    }

    pub(crate) fn engine_archive_destination_with_probe(
        &mut self,
        root: &EngineRootHandle,
        probe: &mut EngineRootProbe,
    ) -> Result<PathRef, Error> {
        let _ = self.resolve_with_engine_probe(
            root.path_ref(),
            PathOperation::DownloadArchive,
            &[],
            probe,
        )?;
        Ok(root.path_ref().clone())
    }

    /// Resolves one exact engine object after capability and identity validation. The native
    /// path is for the backend actor only and is never serialized to the renderer.
    pub(crate) fn engine_executable(
        &mut self,
        engine: &EngineHandle,
        operation: PathOperation,
    ) -> Result<EngineExecutable, Error> {
        #[cfg(all(test, unix))]
        observe_engine_resolution("executable");
        if !matches!(
            operation,
            PathOperation::EngineExecute | PathOperation::EngineConfigure
        ) {
            return Err(Error::InvalidInput("invalid engine operation".into()));
        }
        let mut resolved = self.resolve(engine.path_ref(), operation, &[])?;
        let working_directory = resolved
            .parent()
            .ok_or_else(|| Error::Conflict("engine has no validated working directory".into()))?
            .try_clone()?;
        #[cfg(unix)]
        let file = resolved
            .take_file()
            .ok_or_else(|| Error::InvalidInput("engine capability is not a file".into()))?;
        #[cfg(windows)]
        let _file = resolved
            .take_file()
            .ok_or_else(|| Error::InvalidInput("engine capability is not a file".into()))?;
        let verified_path = self.workspace_entry_path(
            &FileWorkspaceHandle::new(engine.path_ref().clone()),
            operation,
        )?;
        let _working_directory_path = verified_path
            .parent()
            .ok_or_else(|| Error::InvalidInput("engine executable has no parent directory".into()))?
            .to_path_buf();
        #[cfg(target_os = "macos")]
        let command_path = descriptor_path(&file)?;
        Ok(EngineExecutable {
            #[cfg(unix)]
            file,
            _working_directory: working_directory,
            #[cfg(windows)]
            working_directory_path: _working_directory_path,
            resource_leases: Vec::new(),
            #[cfg(target_os = "macos")]
            command_path,
            #[cfg(target_os = "macos")]
            launch_root: self.engine_launch_root.clone(),
            #[cfg(target_os = "macos")]
            materialized_files: Vec::new(),
            #[cfg(windows)]
            _file,
            #[cfg(windows)]
            command_path: verified_path,
        })
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn engine_launch_root(&self) -> Result<EngineLaunchRoot, Error> {
        self.engine_launch_root
            .clone()
            .ok_or_else(|| Error::Conflict("engine launch root is not initialized".into()))
    }

    pub(crate) fn engine_root_descriptor(
        &self,
        root: EngineRootHandle,
    ) -> Result<EngineRootDescriptor, Error> {
        let display_name = self.root_display_name(root.path_ref(), "engine")?;
        Ok(EngineRootDescriptor { root, display_name })
    }

    pub(super) fn attachment_entry(entry: &Entry) -> bool {
        is_attachment_purpose(entry.stored.purpose)
    }

    pub(crate) fn seal_engine_attachments(&mut self) {
        self.attachments_sealed = true;
    }

    pub(crate) fn begin_engine_image_issuance(
        &mut self,
    ) -> Result<ActiveImageIssuanceLease, Error> {
        if self.attachments_sealed {
            return Err(Error::Conflict(
                "engine attachment mutations are sealed".into(),
            ));
        }
        self.active_image_issuances
            .active
            .fetch_add(1, Ordering::AcqRel);
        Ok(ActiveImageIssuanceLease {
            tracker: Arc::clone(&self.active_image_issuances),
        })
    }

    pub(crate) fn active_image_issuances(&self) -> Arc<ActiveImageIssuances> {
        Arc::clone(&self.active_image_issuances)
    }

    #[cfg(test)]
    pub(crate) fn engine_attachments_are_sealed(&self) -> bool {
        self.attachments_sealed
    }

    /// Applies one validated whole attachment transaction. Retired entries remain resolvable only
    /// in this process; only the authority and cleanup intent are written to the registry.
    pub(crate) fn reconcile_engine_attachments(
        &mut self,
        action: EngineAttachmentAction,
    ) -> Result<(), Error> {
        if self.attachments_sealed {
            return Err(Error::Conflict(
                "engine attachment mutations are sealed".into(),
            ));
        }
        let (retained, abandoned, startup, reconcile) = match action {
            EngineAttachmentAction::Prepare { retained_ids } => {
                (Some(retained_ids), Vec::new(), false, false)
            }
            EngineAttachmentAction::Reconcile {
                retained_ids,
                abandoned_ids,
                startup,
            } => (retained_ids, abandoned_ids, startup, true),
        };
        if retained.as_ref().is_some_and(|ids| {
            ids.len()
                > self
                    .authority_id_input_limit()
                    .saturating_add(MAX_OWNER_UNKNOWN_IDS)
        }) || abandoned.len() > self.authority_id_input_limit()
            || (startup && retained.is_none())
        {
            return Err(Error::ResourceLimit(
                "engine attachment action exceeds its limit".into(),
            ));
        }
        let mut retained_ids = BTreeSet::new();
        for id in retained.as_ref().into_iter().flatten().map(|id| &id.id) {
            let Some(entry) = self
                .persistent
                .get(id)
                .or_else(|| self.retired_attachments.get(id))
            else {
                continue;
            };
            if !Self::attachment_entry(entry) {
                return Err(Error::InvalidInput(
                    "retained capability is not an engine attachment".into(),
                ));
            }
            retained_ids.insert(id.clone());
        }
        for id in abandoned.iter().map(|id| &id.id) {
            if let Some(entry) = self
                .persistent
                .get(id)
                .or_else(|| self.retired_attachments.get(id))
            {
                if !Self::attachment_entry(entry) {
                    return Err(Error::InvalidInput(
                        "abandoned capability is not an engine attachment".into(),
                    ));
                }
            }
        }

        let old_provisional = self.provisional_attachments.clone();
        let old_cleanup = self.image_cleanup.clone();
        let old_retired = self.retired_attachments.clone();
        let old_admission = self.registry_admission_snapshot(
            &self.persistent,
            &self.active_database_root,
            &self.active_puzzle_root,
            &self.active_engine_root,
            &self.pending_artifacts,
            &old_provisional,
            &old_retired,
            &old_cleanup,
        )?;
        let mut candidate = self.persistent.clone();
        let mut readopted_retired_ids = Vec::new();
        for id in &retained_ids {
            if let Some(entry) = self.retired_attachments.get(id).cloned() {
                candidate.insert(id.clone(), entry);
                readopted_retired_ids.push(id.clone());
            }
            self.provisional_attachments.remove(id);
            self.image_cleanup.remove(id);
        }
        if reconcile {
            let abandon_only = retained.is_none();
            let explicit_abandoned: BTreeSet<_> = abandoned.into_iter().map(|id| id.id).collect();
            let retire_ids = candidate
                .iter()
                .filter_map(|(id, entry)| {
                    if !Self::attachment_entry(entry) || retained_ids.contains(id) {
                        return None;
                    }
                    let provisional = self.provisional_attachments.contains(id);
                    let explicitly_abandoned = explicit_abandoned.contains(id);
                    let should_retire = if abandon_only {
                        explicitly_abandoned && provisional
                    } else {
                        explicitly_abandoned
                            || (!provisional
                                && !(startup && self.session_protected_ids.contains(id)))
                            || (startup
                                && self.loaded_candidate_ids.contains(id)
                                && !self.session_protected_ids.contains(id))
                    };
                    should_retire.then(|| id.clone())
                })
                .collect::<Vec<_>>();
            for id in retire_ids {
                if let Some(entry) = candidate.remove(&id) {
                    self.provisional_attachments.remove(&id);
                    if entry.stored.purpose == Some(EntryPurpose::EngineImage) {
                        self.image_cleanup.insert(id.clone(), entry.stored.clone());
                    }
                    self.retired_attachments.insert(id, entry);
                }
            }
        }
        if candidate == self.persistent
            && self.provisional_attachments == old_provisional
            && self.image_cleanup == old_cleanup
            && self.retired_attachments == old_retired
        {
            if self.registry_durability_pending {
                return self.retry_registry_durability();
            }
            return Ok(());
        }
        match self.commit_candidate_with_pending_baseline(
            candidate,
            self.pending_artifacts.clone(),
            None,
            Some(old_admission),
        ) {
            Ok(durability) => {
                for id in readopted_retired_ids {
                    self.retired_attachments.remove(&id);
                }
                match durability {
                    CommitDurability::Durable => {
                        self.registry_durability_pending = false;
                        Ok(())
                    }
                    CommitDurability::DurabilityUncertain(stage) => {
                        self.registry_durability_pending = true;
                        Err(Error::CommittedDurabilityUncertain(stage))
                    }
                }
            }
            Err(error) => {
                self.provisional_attachments = old_provisional;
                self.image_cleanup = old_cleanup;
                self.retired_attachments = old_retired;
                Err(error)
            }
        }
    }

    pub(crate) fn set_engine_image_sweep_root(&mut self, root: Option<AppDataDir>) {
        self.engine_image_sweep_root = root;
    }

    /// Seals attachment mutations before process teardown. Cleanup never follows a stored path:
    /// intents use the caller's directory, and the orphan sweep uses the retained admitted root.
    pub(crate) fn cleanup_engine_images(
        &mut self,
        image_dir: &AuthorizedDir,
        seal: bool,
    ) -> Result<(), Error> {
        if seal {
            self.seal_engine_attachments();
        }
        if self.image_cleanup.is_empty() {
            if self.registry_durability_pending {
                self.retry_registry_durability()?;
            }
            self.sweep_engine_image_orphans();
            return Ok(());
        }
        let ids = self.image_cleanup.keys().cloned().collect::<Vec<_>>();
        let original_cleanup = self.image_cleanup.clone();
        let mut next_cleanup = original_cleanup.clone();
        let mut failures = Vec::new();
        let mut registry_persistence_error = None;
        for id in ids {
            let Some(stored) = original_cleanup.get(&id).cloned() else {
                continue;
            };
            let Ok(path) = stored.path.to_path() else {
                next_cleanup.remove(&id);
                continue;
            };
            let Some(leaf) = path.file_name() else {
                next_cleanup.remove(&id);
                continue;
            };
            let valid_uuid = uuid::Uuid::parse_str(&leaf.to_string_lossy()).is_ok();
            if !valid_uuid || path.parent() != Some(image_dir.path()) {
                next_cleanup.remove(&id);
                continue;
            }
            let acquired = match image_dir.open_leaf_identified(leaf) {
                Ok(identity) if identity.agrees_with(&stored.identity) => identity,
                Ok(_) => {
                    next_cleanup.remove(&id);
                    continue;
                }
                Err(error) if error.is_missing_entry() => {
                    next_cleanup.remove(&id);
                    continue;
                }
                Err(Error::Conflict(_)) => {
                    next_cleanup.remove(&id);
                    continue;
                }
                Err(error) => {
                    failures.push(error);
                    continue;
                }
            };
            match image_dir.remove_leaf_identified(leaf, acquired) {
                Ok(()) => {
                    next_cleanup.remove(&id);
                }
                Err(error) if error.is_missing_entry() => {
                    next_cleanup.remove(&id);
                }
                Err(Error::Conflict(_)) => {
                    // A substituted leaf is not ours. Complete the obsolete intent without unlinking.
                    next_cleanup.remove(&id);
                }
                Err(error) => failures.push(error),
            }
        }
        if next_cleanup != original_cleanup {
            self.image_cleanup = next_cleanup;
            let durability = self.save_entries(
                &self.persistent,
                &self.active_database_root,
                &self.active_puzzle_root,
                &self.active_engine_root,
                &self.pending_artifacts,
            );
            match durability {
                Ok(CommitDurability::Durable) => {
                    self.registry_durability_pending = false;
                }
                Ok(CommitDurability::DurabilityUncertain(stage)) => {
                    log::warn!(
                        "engine image cleanup registry sync is uncertain at {stage}; completed intents are adopted"
                    );
                    self.registry_durability_pending = true;
                    registry_persistence_error = Some(Error::CommittedDurabilityUncertain(stage));
                }
                Err(error) => {
                    self.image_cleanup = original_cleanup;
                    return match failures.into_iter().next() {
                        Some(cleanup) => Err(Error::with_cleanup(error, Err(cleanup))),
                        None => Err(error),
                    };
                }
            }
        } else if self.registry_durability_pending {
            registry_persistence_error = self.retry_registry_durability().err();
        }
        if let Some(error) = registry_persistence_error {
            return match failures.into_iter().next() {
                Some(cleanup) => Err(Error::with_cleanup(error, Err(cleanup))),
                None => Err(error),
            };
        }
        if let Some(error) = failures.into_iter().next() {
            return Err(error);
        }
        self.sweep_engine_image_orphans();
        Ok(())
    }

    pub(super) fn sweep_engine_image_orphans(&mut self) {
        let Some(root) = self.engine_image_sweep_root.as_ref() else {
            return;
        };
        if self.active_image_issuances.active.load(Ordering::Acquire) != 0 {
            return;
        }
        let image_dir = match ensure_app_owned_default_dir(root, AppOwnedDefaultRoot::EngineImages)
        {
            Ok(image_dir) => image_dir,
            Err(error) => {
                log::warn!(
                    "engine image orphan sweep directory derivation failed: {}",
                    error.category()
                );
                return;
            }
        };
        let mut protected = BTreeSet::new();
        for stored in self
            .persistent
            .values()
            .chain(self.retired_attachments.values())
            .map(|entry| &entry.stored)
            .chain(self.image_cleanup.values())
        {
            let path = match stored.path.to_path() {
                Ok(path) => path,
                Err(error) => {
                    log::warn!(
                        "engine image orphan sweep skipped for unreadable reference: {}",
                        error.category()
                    );
                    return;
                }
            };
            let Some(leaf) = path.file_name().filter(|_| has_normal_leaf(&path)) else {
                log::warn!(
                    "engine image orphan sweep skipped for leafless reference: {}",
                    ErrorCategory::InvalidInput
                );
                return;
            };
            protected.insert(leaf.to_ascii_lowercase());
        }
        let entries = match read_directory_entries_at(
            image_dir.directory.as_file(),
            &CancellationToken::new(),
            Some(MAX_ENGINE_IMAGE_SWEEP_ENTRIES),
            &mut |_| true,
        ) {
            Ok(entries) => entries,
            Err(error) => {
                log::warn!(
                    "engine image orphan sweep listing failed: {}",
                    error.category()
                );
                return;
            }
        };
        let now = SystemTime::now();
        let mut atomic_locks_unsupported = false;
        for entry in entries {
            Self::sweep_engine_image_candidate_with_state(
                &image_dir,
                &protected,
                &entry,
                now,
                &mut atomic_locks_unsupported,
            );
        }
    }

    #[cfg(test)]
    pub(super) fn sweep_engine_image_candidate(
        image_dir: &AuthorizedDir,
        protected: &BTreeSet<OsString>,
        entry: &DirectoryEntry,
    ) {
        let mut atomic_locks_unsupported = false;
        Self::sweep_engine_image_candidate_with_state(
            image_dir,
            protected,
            entry,
            SystemTime::now(),
            &mut atomic_locks_unsupported,
        );
    }

    fn sweep_engine_image_candidate_with_state(
        image_dir: &AuthorizedDir,
        protected: &BTreeSet<OsString>,
        entry: &DirectoryEntry,
        now: SystemTime,
        atomic_locks_unsupported: &mut bool,
    ) {
        if entry.kind != DirectoryEntryKind::RegularFile
            || protected.contains(&entry.name.to_ascii_lowercase())
        {
            return;
        }
        if is_atomic_temp_name(&entry.name) {
            if *atomic_locks_unsupported {
                return;
            }
            match remove_atomic_temp_orphan_at(
                image_dir.directory.as_file(),
                entry,
                now,
                Duration::ZERO,
            ) {
                AtomicTempSweepOutcome::Removed | AtomicTempSweepOutcome::Kept => {}
                AtomicTempSweepOutcome::LockUnsupported => {
                    *atomic_locks_unsupported = true;
                    log::warn!(
                        "engine image orphan sweep skipped remaining atomic temporaries: advisory locks are unsupported"
                    );
                }
                AtomicTempSweepOutcome::Failed(category) => {
                    log::warn!(
                        "engine image orphan sweep removal failed for {}: {category}",
                        entry.name.to_string_lossy()
                    );
                }
            }
            return;
        }
        let Some(name) = entry.name.to_str() else {
            return;
        };
        if Uuid::parse_str(name).is_err() {
            return;
        }
        let identity = match image_dir.open_leaf_identified(&entry.name) {
            Ok(identity) if identity.pair() == entry.identity => identity,
            Ok(_) => return,
            Err(error) if error.is_missing_entry() => return,
            Err(Error::Conflict(_)) => return,
            Err(error) => {
                log::warn!(
                    "engine image orphan sweep open failed for {name}: {}",
                    error.category()
                );
                return;
            }
        };
        if let Err(error) = image_dir.remove_leaf_identified(&entry.name, identity) {
            log::warn!(
                "engine image orphan sweep removal failed for {name}: {}",
                error.category()
            );
        }
    }
}

/// Takes the process-wide authority lock only long enough to open and bound an
/// image descriptor. The guard is dropped before this function returns.
pub(crate) fn image_reader_for(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    path: &PathRef,
    max_bytes: usize,
) -> Result<(VerifiedFile, u64), Error> {
    authority.with_mut(|authority| authority.open_image_path(path, max_bytes))?
}

/// Consumes the no-follow descriptor. `declared` is capped before it sizes the allocation, and
/// each read is limited to the remaining allowance plus one byte used to detect excess.
pub(crate) fn read_verified_image_bytes(
    file: VerifiedFile,
    declared: u64,
    max_bytes: usize,
) -> Result<Vec<u8>, Error> {
    let mut file = file.into_inner();
    read_bounded_bytes(
        &mut file,
        declared,
        max_bytes,
        "image exceeds the supported size limit",
        || Ok(()),
    )
}

/// Takes the process-wide authority lock only long enough to open and bound the
/// image descriptor. The guard is dropped before this function returns.
pub(crate) fn engine_image_reader_for(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    image: &EngineImageHandle,
    max_bytes: usize,
) -> Result<(VerifiedFile, u64), Error> {
    authority.with_mut(|authority| authority.open_engine_image(image, max_bytes))?
}

/// Consumes the no-follow descriptor. `declared` is capped before it sizes the allocation, and
/// each read is limited to the remaining allowance plus one byte used to detect excess.
pub(crate) fn read_engine_image_bytes(
    file: VerifiedFile,
    declared: u64,
    max_bytes: usize,
) -> Result<Vec<u8>, Error> {
    read_verified_image_bytes(file, declared, max_bytes)
}

#[cfg(target_os = "macos")]
pub(super) const MAX_ENGINE_LAUNCH_LEAVES: usize = 64;
#[cfg(target_os = "macos")]
pub(crate) const ENGINE_EXECUTABLE_LEAF_MODE: u32 = 0o700;
#[cfg(target_os = "macos")]
pub(crate) const ENGINE_RESOURCE_LEAF_MODE: u32 = 0o600;
#[cfg(target_os = "macos")]
pub(crate) const ENGINE_LAUNCH_LOCK_MODE: u32 = 0o600;

#[cfg(target_os = "macos")]
#[derive(Debug, Clone)]
pub(crate) struct EngineLaunchRoot {
    pub(super) inner: Arc<EngineLaunchRootInner>,
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
pub(super) struct EngineLaunchRootInner {
    pub(super) _root: fs::File,
    pub(super) _lock: OwnedFile,
    pub(super) instance: fs::File,
    pub(super) instance_path: PathBuf,
    pub(super) registry: std::sync::Mutex<LaunchLeafRegistry>,
}

#[cfg(target_os = "macos")]
impl EngineLaunchRootInner {
    pub(super) fn registry(&self) -> std::sync::MutexGuard<'_, LaunchLeafRegistry> {
        match self.registry.lock() {
            Ok(registry) => registry,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

#[cfg(target_os = "macos")]
#[derive(Debug, Default)]
pub(super) struct LaunchLeafRegistry {
    pub(super) live: usize,
    pub(super) released: Vec<ReleasedLeaf>,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReleasedLeaf {
    pub(crate) leaf: OsString,
    pub(crate) engine_key: String,
    pub(crate) engine_id: String,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Default)]
pub(crate) struct ReclaimReport {
    pub(crate) removed: usize,
    pub(crate) failed: Vec<(ReleasedLeaf, Error)>,
}

#[cfg(target_os = "macos")]
pub(crate) struct MaterializedFile {
    pub(super) root: Arc<EngineLaunchRootInner>,
    pub(super) leaf: OsString,
    pub(super) engine_key: String,
    pub(super) engine_id: String,
    pub(super) attempted: bool,
    pub(super) active: bool,
}

#[cfg(target_os = "macos")]
impl Drop for MaterializedFile {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let mut registry = self.root.registry();
        if self.attempted {
            registry.released.push(ReleasedLeaf {
                leaf: self.leaf.clone(),
                engine_key: self.engine_key.clone(),
                engine_id: self.engine_id.clone(),
            });
        } else {
            registry.live = registry.live.saturating_sub(1);
        }
    }
}

#[cfg(target_os = "macos")]
impl MaterializedFile {
    pub(crate) fn path(&self) -> PathBuf {
        self.root.instance_path.join(&self.leaf)
    }

    pub(crate) fn create_from(
        &mut self,
        source: &impl crate::infra::inode_ownership::NativeFile,
        mode: u32,
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<(), Error> {
        self.attempted = true;
        #[cfg(all(test, unix))]
        observe_engine_resolution("leaf");
        if is_cancelled() {
            return Err(Error::Cancellation);
        }
        #[cfg(test)]
        ENGINE_LAUNCH_BEFORE_CLONE_HOOKS.run(&self.engine_key);

        use rustix::fs::{self as rfs, CloneFlags, Mode};
        use rustix::io::Errno;
        #[cfg(test)]
        let forced_failure = ENGINE_LAUNCH_FAILURES.take(&self.engine_key);
        #[cfg(test)]
        let cloned = match forced_failure {
            Some(EngineLaunchFailure::CloneExdev) => Err(Errno::XDEV),
            Some(EngineLaunchFailure::CloneEnotsup) => Err(Errno::NOTSUP),
            Some(EngineLaunchFailure::Copy) => Err(Errno::XDEV),
            _ => rfs::fclonefileat(source, &self.root.instance, &self.leaf, CloneFlags::empty()),
        };
        #[cfg(not(test))]
        let cloned =
            rfs::fclonefileat(source, &self.root.instance, &self.leaf, CloneFlags::empty());
        match cloned {
            Ok(()) => {}
            Err(error) if error == Errno::XDEV || error == Errno::NOTSUP => {
                let (mut target, _) =
                    crate::infra::fs::create_regular_at(&self.root.instance, &self.leaf)?;
                #[cfg(test)]
                if forced_failure == Some(EngineLaunchFailure::Copy) {
                    return Err(Error::Io(Box::new(std::io::Error::other(
                        "injected engine launch copy failure",
                    ))));
                }
                let stat = rfs::fstat(source)
                    .map_err(|error| Error::Io(Box::new(std::io::Error::from(error))))?;
                let size = u64::try_from(stat.st_size).map_err(|_| {
                    Error::InvalidInput("engine launch source has an invalid size".into())
                })?;
                let mut offset = 0_u64;
                let mut buffer = [0_u8; 64 * 1024];
                while offset < size {
                    if is_cancelled() {
                        return Err(Error::Cancellation);
                    }
                    let wanted = usize::try_from((size - offset).min(buffer.len() as u64))
                        .map_err(|_| {
                            Error::ResourceLimit("engine launch file is too large".into())
                        })?;
                    let read = rustix::io::pread(source, &mut buffer[..wanted], offset)
                        .map_err(|error| Error::Io(Box::new(std::io::Error::from(error))))?;
                    if read == 0 {
                        return Err(Error::Io(Box::new(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "engine launch source ended before its descriptor size",
                        ))));
                    }
                    target.write_all(&buffer[..read])?;
                    offset = offset.checked_add(read as u64).ok_or_else(|| {
                        Error::ResourceLimit("engine launch file is too large".into())
                    })?;
                }
            }
            Err(error) => return Err(Error::Io(Box::new(std::io::Error::from(error)))),
        }
        if is_cancelled() {
            return Err(Error::Cancellation);
        }
        let target = crate::infra::fs::open_regular_at(
            &self.root.instance,
            &self.leaf,
            crate::infra::fs::RegularFileAccess::ReadOnly,
        )?;
        let mode = u16::try_from(mode)
            .map_err(|_| Error::InvalidInput("engine launch mode is invalid".into()))?;
        #[cfg(test)]
        if forced_failure == Some(EngineLaunchFailure::Fchmod) {
            return Err(Error::Io(Box::new(std::io::Error::other(
                "injected engine launch fchmod failure",
            ))));
        }
        rfs::fchmod(&target, Mode::from_raw_mode(mode))
            .map_err(|error| Error::Io(Box::new(std::io::Error::from(error))))?;
        if is_cancelled() {
            return Err(Error::Cancellation);
        }
        Ok(())
    }

    pub(crate) fn remove(mut self) -> Result<(), Error> {
        if !self.active {
            return Ok(());
        }
        let result = remove_instance_leaf(&self.root.instance, &self.leaf);
        if result.is_ok() {
            self.active = false;
            let mut registry = self.root.registry();
            registry.live = registry.live.saturating_sub(1);
        }
        result
    }
}

#[cfg(target_os = "macos")]
pub(super) fn remove_instance_leaf(instance: &fs::File, leaf: &OsStr) -> Result<(), Error> {
    match rustix::fs::statat(instance, leaf, rustix::fs::AtFlags::SYMLINK_NOFOLLOW) {
        Err(rustix::io::Errno::NOENT) => Ok(()),
        Err(error) => Err(Error::Io(Box::new(std::io::Error::from(error)))),
        Ok(stat) => crate::infra::fs::remove_entry_at(
            instance,
            leaf,
            crate::infra::fs::raw_stat_identity(&stat),
            false,
        ),
    }
}

#[cfg(target_os = "macos")]
impl EngineLaunchRoot {
    #[cfg(test)]
    pub(crate) fn instance_path(&self) -> PathBuf {
        self.inner.instance_path.clone()
    }

    pub(crate) fn reserve_leaves(
        &self,
        count: usize,
        engine_key: &str,
        engine_id: &str,
    ) -> Result<Vec<MaterializedFile>, Error> {
        let mut registry = self.inner.registry();
        if registry.live.saturating_add(count) > MAX_ENGINE_LAUNCH_LEAVES {
            return Err(Error::ResourceLimit(
                "engine launch leaf limit reached".into(),
            ));
        }
        registry.live += count;
        Ok((0..count)
            .map(|_| MaterializedFile {
                root: self.inner.clone(),
                leaf: OsString::from(format!("{}.leaf", Uuid::new_v4())),
                engine_key: engine_key.into(),
                engine_id: engine_id.into(),
                attempted: false,
                active: true,
            })
            .collect())
    }

    pub(crate) fn reclaim(&self) -> ReclaimReport {
        let released = {
            let mut registry = self.inner.registry();
            std::mem::take(&mut registry.released)
        };
        let mut report = ReclaimReport::default();
        for leaf in released {
            let result = remove_instance_leaf(&self.inner.instance, &leaf.leaf);
            let mut registry = self.inner.registry();
            match result {
                Ok(()) => {
                    report.removed += 1;
                    registry.live = registry.live.saturating_sub(1);
                }
                Err(error) => {
                    registry.released.push(leaf.clone());
                    report.failed.push((leaf, error));
                }
            }
        }
        report
    }

    #[cfg(test)]
    pub(crate) fn registry_snapshot_for_test(&self) -> (usize, Vec<ReleasedLeaf>) {
        let registry = self.inner.registry();
        (registry.live, registry.released.clone())
    }

    #[cfg(test)]
    pub(crate) fn for_test(temp_dir: &Path) -> Result<Self, Error> {
        initialize_engine_launch_root(&AppDataDir::for_test(temp_dir))
    }
}

#[cfg(target_os = "macos")]
pub(super) fn sibling_id(name: &OsStr) -> Option<String> {
    name.to_str()
        .and_then(|name| name.strip_suffix(".lock"))
        .map(str::to_owned)
}

#[cfg(target_os = "macos")]
pub(super) fn log_launch_sibling_failure(id: &str, error: &Error) {
    log::error!(
        "engine launch sibling cleanup failed for {id}: category={}",
        error.category()
    );
}

#[cfg(target_os = "macos")]
pub(super) fn sweep_engine_launch_root(
    root: &AuthorizedDir,
    own_lock: &OsStr,
    own_instance: &OsStr,
) -> Result<(), Error> {
    use crate::infra::fs::{lock_advisory_file, AdvisoryLockError, AdvisoryLockMode};
    let entries = read_directory_entries_at(
        root.directory.as_file(),
        &CancellationToken::new(),
        None,
        &mut |_| true,
    )?;
    let lock_ids = entries
        .iter()
        .filter_map(|entry| sibling_id(&entry.name))
        .collect::<std::collections::HashSet<_>>();
    for entry in &entries {
        if entry.name == own_lock || entry.name == own_instance {
            continue;
        }
        let Some(id) = sibling_id(&entry.name) else {
            continue;
        };
        if entry.kind != DirectoryEntryKind::RegularFile {
            let error = root
                .open_regular_relative(Path::new(&entry.name))
                .err()
                .unwrap_or_else(|| Error::InvalidInput("engine launch lock is not a file".into()));
            log_launch_sibling_failure(&id, &error);
            continue;
        }
        let lock = match crate::infra::fs::open_regular_at(
            root.directory.as_file(),
            &entry.name,
            RegularFileAccess::ReadOnly,
        ) {
            Ok(lock) => lock,
            Err(error) => {
                log_launch_sibling_failure(&id, &error);
                continue;
            }
        };
        match lock_advisory_file(&lock, AdvisoryLockMode::NonBlocking) {
            Err(AdvisoryLockError::HeldElsewhere(_)) => continue,
            Err(error) => {
                log_launch_sibling_failure(&id, &Error::Io(Box::new(error.into_io_error())));
                continue;
            }
            Ok(()) => {}
        }
        let instance_name = OsStr::new(&id);
        if let Some(instance) = entries
            .iter()
            .find(|candidate| candidate.name == instance_name)
        {
            if instance.kind != DirectoryEntryKind::Directory {
                let error = Error::InvalidInput("engine launch instance is not a directory".into());
                log_launch_sibling_failure(&id, &error);
                continue;
            }
            if let Err(error) = crate::infra::fs::remove_entry_at(
                root.directory.as_file(),
                &instance.name,
                instance.identity,
                true,
            ) {
                log_launch_sibling_failure(&id, &error);
                continue;
            }
        }
        if let Err(error) = crate::infra::fs::remove_entry_at(
            root.directory.as_file(),
            &entry.name,
            entry.identity,
            false,
        ) {
            log_launch_sibling_failure(&id, &error);
        }
    }
    for entry in &entries {
        if entry.name == own_lock || entry.name == own_instance {
            continue;
        }
        if entry.kind == DirectoryEntryKind::Directory
            && entry
                .name
                .to_str()
                .is_none_or(|name| !lock_ids.contains(name))
        {
            if let Err(error) = crate::infra::fs::remove_entry_at(
                root.directory.as_file(),
                &entry.name,
                entry.identity,
                true,
            ) {
                log_launch_sibling_failure(&entry.name.to_string_lossy(), &error);
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn initialize_engine_launch_root(
    app_data: &AppDataDir,
) -> Result<EngineLaunchRoot, Error> {
    let root = ensure_app_owned_default_dir(app_data, AppOwnedDefaultRoot::EngineLaunch)?;
    let id = Uuid::new_v4().to_string();
    let lock_name = OsString::from(format!("{id}.lock"));
    let lock = crate::infra::inode_ownership::create_at_mode(
        root.directory.as_file(),
        &lock_name,
        rustix::fs::OFlags::from_bits_retain((libc::O_EXLOCK | libc::O_NONBLOCK) as _),
        rustix::fs::Mode::from_raw_mode(ENGINE_LAUNCH_LOCK_MODE as _),
    )?;
    #[cfg(test)]
    ENGINE_LAUNCH_LOCK_CREATED_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
    let instance_name = OsString::from(id.clone());
    crate::infra::fs::create_dir_at(root.directory.as_file(), &instance_name)?;
    let instance =
        crate::infra::fs::open_directory_at(root.directory.as_file(), &instance_name, false)?;
    sweep_engine_launch_root(&root, &lock_name, &instance_name)?;
    Ok(EngineLaunchRoot {
        inner: Arc::new(EngineLaunchRootInner {
            _root: root.try_clone()?,
            _lock: lock,
            instance,
            instance_path: root.path().join(instance_name),
            registry: std::sync::Mutex::new(LaunchLeafRegistry::default()),
        }),
    })
}

#[cfg(all(test, target_os = "macos"))]
std::thread_local! {
    static ENGINE_LAUNCH_LOCK_CREATED_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

/// Keyed by the engine key the leaf was reserved for; see `infra::test_hooks`.
#[cfg(all(test, target_os = "macos"))]
pub(super) static ENGINE_LAUNCH_BEFORE_CLONE_HOOKS: crate::infra::test_hooks::KeyedTestHooks<
    String,
> = crate::infra::test_hooks::KeyedTestHooks::new();

#[cfg(all(test, target_os = "macos"))]
pub(crate) fn set_engine_launch_lock_created_hook(hook: Option<Box<dyn FnOnce()>>) {
    ENGINE_LAUNCH_LOCK_CREATED_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(all(test, target_os = "macos"))]
pub(crate) fn set_engine_launch_before_clone_hook(
    engine_key: &str,
    hook: Option<crate::infra::test_hooks::TestHook>,
) {
    match hook {
        Some(hook) => ENGINE_LAUNCH_BEFORE_CLONE_HOOKS.arm(engine_key.to_owned(), hook),
        None => ENGINE_LAUNCH_BEFORE_CLONE_HOOKS.clear(&engine_key.to_owned()),
    }
}

#[cfg(all(test, target_os = "macos"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EngineLaunchFailure {
    CloneExdev,
    CloneEnotsup,
    Copy,
    Fchmod,
}

/// Keyed by the engine key the leaf was reserved for; see `infra::test_hooks`.
#[cfg(all(test, target_os = "macos"))]
pub(super) static ENGINE_LAUNCH_FAILURES: crate::infra::test_hooks::KeyedTestValues<
    String,
    EngineLaunchFailure,
> = crate::infra::test_hooks::KeyedTestValues::new();

#[cfg(all(test, target_os = "macos"))]
pub(crate) fn set_engine_launch_failure(engine_key: &str, failure: Option<EngineLaunchFailure>) {
    match failure {
        Some(failure) => ENGINE_LAUNCH_FAILURES.arm(engine_key.to_owned(), failure),
        None => ENGINE_LAUNCH_FAILURES.clear(&engine_key.to_owned()),
    }
}
