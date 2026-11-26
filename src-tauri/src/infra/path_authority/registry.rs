use super::*;
use crate::infra::fs::{atomic_replace, AtomicFileOutcome};
use std::io::Write;

#[derive(Clone)]
pub(super) struct RegistryAdmissionSnapshot {
    pub(super) bytes: usize,
    pub(super) serialized: Vec<u8>,
    pub(super) admission_units: usize,
    pub(super) pending_count: usize,
}

impl PathAuthority {
    #[cfg(any(test, not(target_os = "macos")))]
    pub fn open(registry_path: PathBuf, app_roots: Vec<AppOwnedRoot>) -> Result<Self, Error> {
        Self::open_with_clock(
            registry_path,
            app_roots,
            Arc::new(SystemClock),
            DEFAULT_DIALOG_CAPACITY,
        )
    }

    /// Opens the engine-test authority with the platform's launch root.
    #[cfg(test)]
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn open_for_engine_test(directory: &Path) -> Result<Self, Error> {
        #[cfg(target_os = "macos")]
        {
            Self::open_with_launch_root(
                directory.join("registry.json"),
                Vec::new(),
                EngineLaunchRoot::for_test(directory)?,
            )
        }
        #[cfg(not(target_os = "macos"))]
        {
            Self::open(directory.join("registry.json"), Vec::new())
        }
    }

    /// The production entry point, so startup does not assemble a clock and a capacity at the
    /// call site.
    pub(crate) fn open_for_app(
        registry_path: PathBuf,
        app_roots: Vec<AppOwnedRoot>,
        launch_root: LaunchRootArgument,
    ) -> Result<Self, Error> {
        Self::open_with_launch_root_argument(
            registry_path,
            app_roots,
            Arc::new(SystemClock),
            DEFAULT_DIALOG_CAPACITY,
            launch_root,
        )
    }

    /// Test-only since the startup branches moved to `open_for_app`: its remaining callers
    /// are the macOS engine-launch tests, so it is gated on them rather than carrying
    /// `allow(dead_code)` into the shipped binary.
    #[cfg(all(test, target_os = "macos"))]
    pub(crate) fn open_with_launch_root(
        registry_path: PathBuf,
        app_roots: Vec<AppOwnedRoot>,
        launch_root: EngineLaunchRoot,
    ) -> Result<Self, Error> {
        Self::open_with_launch_root_argument(
            registry_path,
            app_roots,
            Arc::new(SystemClock),
            DEFAULT_DIALOG_CAPACITY,
            Some(launch_root),
        )
    }

    #[cfg(any(test, not(target_os = "macos")))]
    pub fn open_with_clock(
        registry_path: PathBuf,
        app_roots: Vec<AppOwnedRoot>,
        clock: Arc<dyn Clock>,
        dialog_capacity: usize,
    ) -> Result<Self, Error> {
        Self::open_with_launch_root_argument(
            registry_path,
            app_roots,
            clock,
            dialog_capacity,
            #[cfg(target_os = "macos")]
            None,
            #[cfg(not(target_os = "macos"))]
            (),
        )
    }

    pub(crate) fn open_with_launch_root_argument(
        registry_path: PathBuf,
        app_roots: Vec<AppOwnedRoot>,
        clock: Arc<dyn Clock>,
        dialog_capacity: usize,
        _launch_root: LaunchRootArgument,
    ) -> Result<Self, Error> {
        if dialog_capacity == 0 {
            return Err(Error::InvalidInput(
                "dialog capacity must be at least one".into(),
            ));
        }
        let (
            mut persistent,
            active_database_root,
            active_puzzle_root,
            active_engine_root,
            pending_artifacts,
            provisional_attachments,
            image_cleanup,
            catalog_installs,
            catalog_uses,
        ) = if registry_path.exists() {
            let file = fs::File::open(&registry_path)?;
            let bytes = read_registry_bytes(file)?;
            let registry: Registry = serde_json::from_slice(&bytes)
                .map_err(|e| Error::InvalidInput(format!("invalid path registry: {e}")))?;
            if registry.schema_version != SCHEMA_VERSION {
                return Err(Error::InvalidInput(format!(
                    "unsupported path registry schema {}",
                    registry.schema_version
                )));
            }
            let image_cleanup_records = registry.image_cleanup;
            catalog_install::validate_records(&registry.catalog_installs)?;
            let catalog_uses = catalog_install::decode_uses(registry.catalog_uses)?;
            let provisional_attachments = registry.provisional_attachments.clone();
            let mut loaded = BTreeMap::new();
            for mut stored in registry.entries {
                validate_persisted_shape(&stored)?;
                let needs_purpose_backfill = stored.purpose.is_none();
                let legacy_engine_file_operations = [
                    PathOperation::EngineExecute,
                    PathOperation::EngineConfigure,
                    PathOperation::EngineInstall,
                ];
                if stored.class == PathClass::PersistentFile
                    && same_operation_set(&stored.operations, &legacy_engine_file_operations)
                {
                    // This exact, class-restricted backfill is idempotent, so the registry schema
                    // does not need to change. Engine roots are PersistentCustomRoot and must keep
                    // their exact operation vector for stable reuse across restarts.
                    stored.operations.push(PathOperation::EngineBinaryInspect);
                }
                if needs_purpose_backfill {
                    stored.purpose =
                        purpose_for_shape(stored.class, stored.target_is_dir, &stored.operations);
                }
                if needs_purpose_backfill {
                    if let Some(purpose) = stored.purpose {
                        stored.operations = canonical_operations(purpose);
                    }
                } else if stored.purpose == Some(EntryPurpose::EngineExecutable)
                    && same_operation_set(
                        &stored.operations,
                        &[
                            PathOperation::EngineExecute,
                            PathOperation::EngineConfigure,
                            PathOperation::EngineInstall,
                            PathOperation::EngineBinaryInspect,
                        ],
                    )
                {
                    // Explicitly tagged registries written during the engine-inspection
                    // transition may contain the historical install bit. Treat it as recognized
                    // history, but leave other purpose-tagged subsets for their issuer to upgrade.
                    stored.operations = canonical_operations(EntryPurpose::EngineExecutable);
                }
                let mut entry = Entry {
                    stored,
                    availability: PathAvailability::Unavailable,
                };
                refresh_entry(&mut entry);
                if loaded.insert(entry.stored.id.id.clone(), entry).is_some() {
                    return Err(Error::InvalidInput(
                        "duplicate path registry identifier".into(),
                    ));
                }
            }
            validate_loaded_attachment_metadata(
                &loaded,
                &provisional_attachments,
                &image_cleanup_records,
            )?;
            let image_cleanup = image_cleanup_records
                .into_iter()
                .map(|stored| (stored.id.id.clone(), stored))
                .collect();
            let active = registry.active_database_root.filter(|id| {
                loaded.get(&id.id).is_some_and(|entry| {
                    entry.stored.target_is_dir
                        && entry
                            .stored
                            .operations
                            .contains(&PathOperation::DatabaseRead)
                })
            });
            let active_puzzle_root = registry.active_puzzle_root.filter(|id| {
                loaded.get(&id.id).is_some_and(|entry| {
                    entry.stored.target_is_dir
                        && entry.stored.operations.contains(&PathOperation::PuzzleRead)
                })
            });
            let active_engine_root = registry.active_engine_root.filter(|id| {
                loaded.get(&id.id).is_some_and(|entry| {
                    entry.stored.target_is_dir
                        && entry
                            .stored
                            .operations
                            .contains(&PathOperation::EngineInstall)
                })
            });
            (
                loaded,
                active,
                active_puzzle_root,
                active_engine_root,
                registry.pending_artifacts,
                provisional_attachments,
                image_cleanup,
                registry.catalog_installs,
                catalog_uses,
            )
        } else {
            (
                BTreeMap::new(),
                None,
                None,
                None,
                Vec::new(),
                BTreeSet::new(),
                BTreeMap::new(),
                BTreeMap::new(),
                BTreeMap::new(),
            )
        };
        let loaded_candidate_ids = persistent.keys().cloned().collect();
        for root in app_roots {
            fs::create_dir_all(&root.path)?;
            let stored = StoredEntry {
                id: root.id.clone(),
                display_name: root.display_name,
                class: PathClass::AppOwnedRoot,
                purpose: None,
                operations: root.operations,
                path: NativePath::from_path(&root.path),
                identity: validate_target(&root.path, PathClass::AppOwnedRoot)?,
                parent_identity: None,
                target_is_dir: true,
                practice_key: None,
            };
            persistent.insert(
                stored.id.id.clone(),
                Entry {
                    stored,
                    availability: PathAvailability::Available,
                },
            );
        }
        let mut authority = Self {
            registry_path,
            persistent,
            dialogs: HashMap::new(),
            clock,
            dialog_capacity,
            next_insertion: 0,
            active_database_root,
            active_puzzle_root,
            active_engine_root,
            pending_artifacts,
            pending_unpersisted_removals: BTreeSet::new(),
            loaded_candidate_ids,
            session_protected_ids: BTreeSet::new(),
            completion_resources: BTreeMap::new(),
            completed_owner_families: BTreeSet::new(),
            startup_retained_ids: BTreeSet::new(),
            startup_unowned_roots_reconciled: false,
            provisional_attachments,
            retired_attachments: BTreeMap::new(),
            image_cleanup,
            catalog_installs,
            catalog_session: Uuid::new_v4().to_string(),
            catalog_protected: BTreeSet::new(),
            catalog_uses,
            attachments_sealed: false,
            registry_durability_pending: false,
            active_image_issuances: Arc::new(ActiveImageIssuances::new()),
            engine_image_sweep_root: None,
            unresolved_journals: BTreeSet::new(),
            quiesced_engine_roots: Arc::new(
                std::sync::Mutex::new(std::collections::HashSet::new()),
            ),
            #[cfg(test)]
            activation_observer: None,
            #[cfg(target_os = "macos")]
            engine_launch_root: _launch_root,
        };
        // Recovery validates pending roots by their stored spelling; repair legacy spellings
        // before it runs so a recovered artifact sees the same canonical root as the registry.
        authority.rebind_legacy_spellings_and_parent_identities();
        authority.recover_pending_artifacts()?;
        Ok(authority)
    }

    pub(super) fn rebind_legacy_spellings_and_parent_identities(&mut self) {
        let ids: Vec<_> = self.persistent.keys().cloned().collect();
        let mut rebound_ids = Vec::new();

        for id in ids {
            let Some(entry) = self.persistent.get_mut(&id) else {
                continue;
            };
            if entry.stored.class == PathClass::AppOwnedRoot {
                continue;
            }
            let path = match entry.stored.path.to_path() {
                Ok(path) => path,
                Err(error) => {
                    entry.availability = PathAvailability::Unavailable;
                    log::warn!(
                        "legacy path rebinding skipped for entry {}: {}",
                        entry.stored.id.id,
                        error.category()
                    );
                    continue;
                }
            };
            let needs_parent_upgrade = !entry.stored.target_is_dir
                && has_normal_leaf(&path)
                && entry.stored.parent_identity.is_none();
            let spelling_needs_rebinding = match classify_canonical_binding(&path) {
                CanonicalBindingStatus::Canonical if !needs_parent_upgrade => continue,
                CanonicalBindingStatus::Leafless => continue,
                CanonicalBindingStatus::Canonical => false,
                CanonicalBindingStatus::NeedsRebinding => true,
                CanonicalBindingStatus::Failed(error) => {
                    entry.availability = PathAvailability::Unavailable;
                    log::warn!(
                        "legacy path rebinding skipped for entry {} at {:?}: {}",
                        entry.stored.id.id,
                        path,
                        error.category()
                    );
                    continue;
                }
            };
            let shape = AcquireShape::for_persistent_class(
                entry.stored.class,
                parent_access_for_operations(&entry.stored.operations),
            );
            let acquired = match acquire_target(&path, shape) {
                Ok(acquired) => acquired,
                Err(error) => {
                    entry.availability = PathAvailability::Unavailable;
                    log::warn!(
                        "legacy {} skipped for entry {} at {:?}: {}",
                        if spelling_needs_rebinding {
                            "path rebinding"
                        } else {
                            "parent identity upgrade"
                        },
                        entry.stored.id.id,
                        path,
                        error.category()
                    );
                    continue;
                }
            };
            if acquired.identity != entry.stored.identity {
                entry.availability = PathAvailability::Unavailable;
                log::warn!(
                    "legacy path rebinding skipped for entry {} at {:?}: identity changed",
                    entry.stored.id.id,
                    path
                );
                continue;
            }
            if let Some(expected_parent) = entry.stored.parent_identity.as_ref() {
                if acquired.parent_identity.as_ref() != Some(expected_parent) {
                    entry.availability = PathAvailability::Unavailable;
                    log::warn!(
                        "legacy path rebinding skipped for entry {} at {:?}: parent identity changed",
                        entry.stored.id.id,
                        path
                    );
                    continue;
                }
            } else if needs_parent_upgrade {
                let Some(parent_identity) = acquired.parent_identity.clone() else {
                    entry.availability = PathAvailability::Unavailable;
                    log::warn!(
                        "legacy parent identity upgrade skipped for entry {} at {:?}: parent is unavailable",
                        entry.stored.id.id,
                        path
                    );
                    continue;
                };
                entry.stored.parent_identity = Some(parent_identity);
            }
            entry.stored.path = NativePath::from_path(&acquired.path);
            entry.availability = PathAvailability::Available;
            rebound_ids.push(id);
        }

        if rebound_ids.is_empty() {
            return;
        }
        let durability = self.commit_registry(
            self.persistent.clone(),
            self.active_database_root.clone(),
            self.active_puzzle_root.clone(),
            self.active_engine_root.clone(),
            self.pending_artifacts.clone(),
            None,
            true,
        );
        if let Err(error) = durability {
            log::warn!(
                "legacy path rebinding could not be persisted for entries {:?}: {}",
                rebound_ids,
                error.category()
            );
        }
    }

    #[cfg(test)]
    pub(super) fn refresh_persistent(&mut self) {
        for entry in self.persistent.values_mut() {
            refresh_entry(entry);
        }
    }
    pub(super) fn refresh_persistent_id(&mut self, id: &PathRef) {
        if let Some(entry) = self.persistent.get_mut(&id.id) {
            refresh_entry(entry);
        }
    }
    #[cfg(test)]
    pub(super) fn save(&mut self) -> Result<CommitDurability, Error> {
        self.commit_registry(
            self.persistent.clone(),
            self.active_database_root.clone(),
            self.active_puzzle_root.clone(),
            self.active_engine_root.clone(),
            self.pending_artifacts.clone(),
            None,
            true,
        )
    }
    pub(super) fn save_entries(
        &self,
        entries: &BTreeMap<String, Entry>,
        active_database_root: &Option<PathRef>,
        active_puzzle_root: &Option<PathRef>,
        active_engine_root: &Option<PathRef>,
        pending_artifacts: &[PendingArtifact],
    ) -> Result<CommitDurability, Error> {
        self.save_entries_with(
            entries,
            active_database_root,
            active_puzzle_root,
            active_engine_root,
            pending_artifacts,
            |target, write| atomic_replace(target, write),
        )
    }

    #[allow(clippy::too_many_arguments)] // one complete persisted-state admission snapshot
    pub(super) fn registry_admission_snapshot(
        &self,
        entries: &BTreeMap<String, Entry>,
        active_database_root: &Option<PathRef>,
        active_puzzle_root: &Option<PathRef>,
        active_engine_root: &Option<PathRef>,
        pending_artifacts: &[PendingArtifact],
        provisional: &BTreeSet<String>,
        retired: &BTreeMap<String, Entry>,
        cleanup: &BTreeMap<String, StoredEntry>,
    ) -> Result<RegistryAdmissionSnapshot, Error> {
        let bytes = serde_json::to_vec(&Registry {
            schema_version: SCHEMA_VERSION,
            entries: entries
                .values()
                .filter(|entry| entry.stored.class != PathClass::AppOwnedRoot)
                .map(|entry| entry.stored.clone())
                .collect(),
            active_database_root: active_database_root.clone(),
            active_puzzle_root: active_puzzle_root.clone(),
            active_engine_root: active_engine_root.clone(),
            pending_artifacts: pending_artifacts.to_vec(),
            provisional_attachments: provisional.clone(),
            image_cleanup: cleanup.values().cloned().collect(),
            catalog_installs: self.catalog_installs.clone(),
            catalog_uses: catalog_install::encode_uses(&self.catalog_uses),
        })
        .map_err(|error| Error::InvalidInput(error.to_string()))?;
        Ok(RegistryAdmissionSnapshot {
            bytes: bytes.len(),
            serialized: bytes,
            admission_units: self.catalog_admission_count()
                + unique_registry_id_count(
                    entries.keys().map(String::as_str).collect(),
                    retired.keys().map(String::as_str).collect(),
                    cleanup.keys().map(String::as_str).collect(),
                    pending_artifacts
                        .iter()
                        .map(|pending| pending.id.id.as_str())
                        .collect(),
                ),
            // This is deliberately a separate admission dimension. A pending artifact can
            // carry an already-counted ID; its number of recovery records is still bounded.
            pending_count: pending_artifacts.len(),
        })
    }

    pub(super) fn commit_candidate(
        &mut self,
        candidate: BTreeMap<String, Entry>,
        consumed_dialog: Option<&PathRef>,
    ) -> Result<CommitDurability, Error> {
        self.commit_candidate_with_pending_baseline(
            candidate,
            self.pending_artifacts.clone(),
            consumed_dialog,
            None,
        )
    }
    pub(super) fn commit_candidate_with_pending(
        &mut self,
        candidate: BTreeMap<String, Entry>,
        pending_artifacts: Vec<PendingArtifact>,
        consumed_dialog: Option<&PathRef>,
    ) -> Result<CommitDurability, Error> {
        self.commit_candidate_with_pending_baseline(
            candidate,
            pending_artifacts,
            consumed_dialog,
            None,
        )
    }

    pub(super) fn commit_candidate_with_pending_baseline(
        &mut self,
        candidate: BTreeMap<String, Entry>,
        pending_artifacts: Vec<PendingArtifact>,
        consumed_dialog: Option<&PathRef>,
        baseline: Option<RegistryAdmissionSnapshot>,
    ) -> Result<CommitDurability, Error> {
        let active_database_root = self
            .active_database_root
            .clone()
            .filter(|id| candidate.contains_key(&id.id));
        let active_puzzle_root = self
            .active_puzzle_root
            .clone()
            .filter(|id| candidate.contains_key(&id.id));
        let active_engine_root = self
            .active_engine_root
            .clone()
            .filter(|id| candidate.contains_key(&id.id));
        let durability = self.commit_state_with_baseline(
            candidate,
            active_database_root,
            active_puzzle_root,
            active_engine_root,
            pending_artifacts,
            consumed_dialog,
            baseline,
        )?;
        Ok(durability)
    }
    pub(super) fn commit_state(
        &mut self,
        candidate: BTreeMap<String, Entry>,
        active_database_root: Option<PathRef>,
        active_puzzle_root: Option<PathRef>,
        active_engine_root: Option<PathRef>,
        pending_artifacts: Vec<PendingArtifact>,
        consumed_dialog: Option<&PathRef>,
    ) -> Result<CommitDurability, Error> {
        self.commit_state_with_baseline(
            candidate,
            active_database_root,
            active_puzzle_root,
            active_engine_root,
            pending_artifacts,
            consumed_dialog,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)] // one complete registry commit plus its old baseline
    pub(super) fn commit_state_with_baseline(
        &mut self,
        candidate: BTreeMap<String, Entry>,
        active_database_root: Option<PathRef>,
        active_puzzle_root: Option<PathRef>,
        active_engine_root: Option<PathRef>,
        pending_artifacts: Vec<PendingArtifact>,
        consumed_dialog: Option<&PathRef>,
        baseline: Option<RegistryAdmissionSnapshot>,
    ) -> Result<CommitDurability, Error> {
        self.commit_registry_with_baseline(
            candidate,
            active_database_root,
            active_puzzle_root,
            active_engine_root,
            pending_artifacts,
            consumed_dialog,
            true,
            baseline,
        )
    }
    #[allow(clippy::too_many_arguments)] // one registry snapshot plus adopt_uncertain
    pub(super) fn commit_registry(
        &mut self,
        candidate: BTreeMap<String, Entry>,
        active_database_root: Option<PathRef>,
        active_puzzle_root: Option<PathRef>,
        active_engine_root: Option<PathRef>,
        pending_artifacts: Vec<PendingArtifact>,
        consumed_dialog: Option<&PathRef>,
        adopt_uncertain: bool,
    ) -> Result<CommitDurability, Error> {
        self.commit_registry_with_baseline(
            candidate,
            active_database_root,
            active_puzzle_root,
            active_engine_root,
            pending_artifacts,
            consumed_dialog,
            adopt_uncertain,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn commit_registry_with_baseline(
        &mut self,
        mut candidate: BTreeMap<String, Entry>,
        mut active_database_root: Option<PathRef>,
        mut active_puzzle_root: Option<PathRef>,
        mut active_engine_root: Option<PathRef>,
        mut pending_artifacts: Vec<PendingArtifact>,
        consumed_dialog: Option<&PathRef>,
        adopt_uncertain: bool,
        baseline: Option<RegistryAdmissionSnapshot>,
    ) -> Result<CommitDurability, Error> {
        candidate.retain(|id, _| !self.pending_unpersisted_removals.contains(id));
        pending_artifacts
            .retain(|pending| !self.pending_unpersisted_removals.contains(&pending.root.id));
        active_database_root = active_database_root.filter(|root| {
            !self.pending_unpersisted_removals.contains(&root.id)
                && candidate.contains_key(&root.id)
        });
        active_puzzle_root = active_puzzle_root.filter(|root| {
            !self.pending_unpersisted_removals.contains(&root.id)
                && candidate.contains_key(&root.id)
        });
        active_engine_root = active_engine_root.filter(|root| {
            !self.pending_unpersisted_removals.contains(&root.id)
                && candidate.contains_key(&root.id)
        });
        let durability = self.save_entries_with_baseline(
            &candidate,
            &active_database_root,
            &active_puzzle_root,
            &active_engine_root,
            &pending_artifacts,
            baseline,
            |target, write| atomic_replace(target, write),
        )?;
        self.registry_durability_pending = !matches!(durability, CommitDurability::Durable);
        if matches!(durability, CommitDurability::Durable) || adopt_uncertain {
            self.persistent = candidate;
            self.active_database_root = active_database_root;
            self.active_puzzle_root = active_puzzle_root;
            self.active_engine_root = active_engine_root;
            self.pending_artifacts = pending_artifacts;
            self.pending_unpersisted_removals.clear();
            self.loaded_candidate_ids
                .retain(|id| self.persistent.contains_key(id));
            self.session_protected_ids
                .retain(|id| self.persistent.contains_key(id));
            self.startup_retained_ids
                .retain(|id| self.persistent.contains_key(id));
            if let Some(dialog) = consumed_dialog {
                self.dialogs.remove(&dialog.id);
            }
        }
        Ok(durability)
    }
    pub(super) fn check_registry_growth(
        candidate: &RegistryAdmissionSnapshot,
        current: &RegistryAdmissionSnapshot,
    ) -> Result<(), Error> {
        if candidate.admission_units > MAX_AUTHORITY_IDS
            && candidate.admission_units > current.admission_units
        {
            return Err(Error::ResourceLimit(
                "path registry identifier limit reached".into(),
            ));
        }
        if candidate.pending_count > MAX_PENDING_ARTIFACTS
            && candidate.pending_count > current.pending_count
        {
            return Err(Error::ResourceLimit(
                "pending path artifact limit reached".into(),
            ));
        }
        if candidate.bytes > MAX_REGISTRY_BYTES && candidate.bytes > current.bytes {
            return Err(Error::ResourceLimit(
                "path registry serialized size limit reached".into(),
            ));
        }
        Ok(())
    }

    pub(super) fn save_entries_with<F>(
        &self,
        source: &BTreeMap<String, Entry>,
        active_database_root: &Option<PathRef>,
        active_puzzle_root: &Option<PathRef>,
        active_engine_root: &Option<PathRef>,
        pending_artifacts: &[PendingArtifact],
        replace: F,
    ) -> Result<CommitDurability, Error>
    where
        F: FnMut(
            &Path,
            Box<dyn FnOnce(&mut OwnedFile) -> Result<(), Error>>,
        ) -> Result<AtomicFileOutcome, Error>,
    {
        self.save_entries_with_baseline(
            source,
            active_database_root,
            active_puzzle_root,
            active_engine_root,
            pending_artifacts,
            None,
            replace,
        )
    }

    #[allow(clippy::too_many_arguments)] // one complete registry encoding plus its old baseline
    pub(super) fn save_entries_with_baseline<F>(
        &self,
        source: &BTreeMap<String, Entry>,
        active_database_root: &Option<PathRef>,
        active_puzzle_root: &Option<PathRef>,
        active_engine_root: &Option<PathRef>,
        pending_artifacts: &[PendingArtifact],
        baseline: Option<RegistryAdmissionSnapshot>,
        mut replace: F,
    ) -> Result<CommitDurability, Error>
    where
        F: FnMut(
            &Path,
            Box<dyn FnOnce(&mut OwnedFile) -> Result<(), Error>>,
        ) -> Result<AtomicFileOutcome, Error>,
    {
        let candidate_snapshot = self.registry_admission_snapshot(
            source,
            active_database_root,
            active_puzzle_root,
            active_engine_root,
            pending_artifacts,
            &self.provisional_attachments,
            &self.retired_attachments,
            &self.image_cleanup,
        )?;
        let current_snapshot = if let Some(baseline) = baseline {
            baseline
        } else {
            self.registry_admission_snapshot(
                &self.persistent,
                &self.active_database_root,
                &self.active_puzzle_root,
                &self.active_engine_root,
                &self.pending_artifacts,
                &self.provisional_attachments,
                &self.retired_attachments,
                &self.image_cleanup,
            )?
        };
        Self::check_registry_growth(&candidate_snapshot, &current_snapshot)?;
        let bytes = candidate_snapshot.serialized;
        let mut attempt = || {
            let bytes = bytes.clone();
            replace(
                &self.registry_path,
                Box::new(move |f| f.write_all(&bytes).map_err(Error::from)),
            )
        };
        let outcome = match attempt() {
            Err(Error::Io(_)) => attempt()?,
            result => result?,
        };
        let stage = crate::infra::fs::map_atomic_file_outcome(
            outcome,
            crate::error::DurabilityStage::RegistryReplacement,
            |error| log::warn!("path authority registry replacement parent sync failed: {error}"),
        );
        Ok(match stage {
            Some(stage) => CommitDurability::DurabilityUncertain(stage),
            None => CommitDurability::Durable,
        })
    }

    pub(super) fn registry_admission_units(&self) -> usize {
        self.catalog_admission_count()
            + unique_registry_id_count(
                self.persistent.keys().map(String::as_str).collect(),
                self.retired_attachments
                    .keys()
                    .map(String::as_str)
                    .collect(),
                self.image_cleanup.keys().map(String::as_str).collect(),
                self.pending_artifacts
                    .iter()
                    .map(|pending| pending.id.id.as_str())
                    .collect(),
            )
    }
}

pub(super) fn validate_loaded_attachment_metadata(
    persistent: &BTreeMap<String, Entry>,
    provisional_ids: &BTreeSet<String>,
    image_cleanup: &[StoredEntry],
) -> Result<(), Error> {
    let is_attachment = |entry: &StoredEntry| {
        let Some(purpose) = entry.purpose else {
            return false;
        };
        matches!(
            purpose,
            EntryPurpose::EngineResource | EntryPurpose::EngineImage
        ) && purpose_matches_shape(purpose, entry.class, entry.target_is_dir)
            && entry.operations == canonical_operations(purpose)
    };

    for id in provisional_ids {
        let Some(entry) = persistent.get(id).map(|entry| &entry.stored) else {
            return Err(Error::InvalidInput(
                "provisional engine attachment is not a persistent entry".into(),
            ));
        };
        if !is_attachment(entry) {
            return Err(Error::InvalidInput(
                "provisional engine attachment has invalid authority shape".into(),
            ));
        }
    }

    let mut cleanup_ids = BTreeSet::new();
    for entry in image_cleanup {
        validate_persisted_shape(entry)?;
        if entry.class != PathClass::PersistentFile
            || entry.target_is_dir
            || entry.purpose != Some(EntryPurpose::EngineImage)
            || entry.operations != canonical_operations(EntryPurpose::EngineImage)
        {
            return Err(Error::InvalidInput(
                "engine image cleanup intent has invalid authority shape".into(),
            ));
        }
        if !cleanup_ids.insert(entry.id.id.clone()) || persistent.contains_key(&entry.id.id) {
            return Err(Error::InvalidInput(
                "duplicate or overlapping engine image cleanup intent".into(),
            ));
        }
        if provisional_ids.contains(&entry.id.id) {
            return Err(Error::InvalidInput(
                "engine attachment cannot be both provisional and cleanup-pending".into(),
            ));
        }
        let path = entry.path.to_path()?;
        let Some(leaf) = path.file_name() else {
            return Err(Error::InvalidInput(
                "engine image cleanup intent has no leaf".into(),
            ));
        };
        if uuid::Uuid::parse_str(&leaf.to_string_lossy()).is_err() {
            return Err(Error::InvalidInput(
                "engine image cleanup intent has an invalid leaf".into(),
            ));
        }
    }
    Ok(())
}

pub(super) fn unique_registry_id_count(
    persistent: Vec<&str>,
    retired: Vec<&str>,
    cleanup: Vec<&str>,
    pending: Vec<&str>,
) -> usize {
    persistent
        .into_iter()
        .chain(retired)
        .chain(cleanup)
        .chain(pending)
        .collect::<BTreeSet<_>>()
        .len()
}

pub(super) fn read_registry_bytes(reader: impl Read) -> Result<Vec<u8>, Error> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_LEGACY_REGISTRY_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_LEGACY_REGISTRY_BYTES {
        return Err(Error::ResourceLimit(
            "path registry exceeds the legacy read limit".into(),
        ));
    }
    Ok(bytes)
}
