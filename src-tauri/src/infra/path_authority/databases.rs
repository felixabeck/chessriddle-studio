use super::*;

impl PathAuthority {
    pub(crate) fn active_database_root(&mut self) -> Result<Option<DatabaseRootHandle>, Error> {
        if self.has_unresolved_journal(FolderSwitchKind::Database) {
            return Err(Self::interrupted_move_root_error());
        }
        self.resolve_active_root(
            self.active_database_root.clone(),
            PathOperation::DatabaseRead,
        )
        .map(|id| id.map(DatabaseRootHandle::new))
    }

    pub(crate) fn active_puzzle_root(&mut self) -> Result<Option<PuzzleRootDescriptor>, Error> {
        if self.has_unresolved_journal(FolderSwitchKind::Puzzle) {
            return Err(Self::interrupted_move_root_error());
        }
        let Some(id) =
            self.resolve_active_root(self.active_puzzle_root.clone(), PathOperation::PuzzleRead)?
        else {
            return Ok(None);
        };
        let display_name = self.root_display_name(&id, "puzzle")?;
        Ok(Some(PuzzleRootDescriptor {
            root: PuzzleRootHandle::new(id),
            display_name,
        }))
    }

    pub(crate) fn database_root_descriptor(
        &self,
        root: DatabaseRootHandle,
    ) -> Result<DatabaseRootDescriptor, Error> {
        let display_name = self.root_display_name(root.path_ref(), "database")?;
        Ok(DatabaseRootDescriptor { root, display_name })
    }

    /// Opens a database root directory through the authority for namespace mutations
    /// (writable on Windows so `remove_entry_at` can flush the parent after unlinking).
    pub(crate) fn open_database_root_for_mutation(
        &mut self,
        root: &DatabaseRootHandle,
    ) -> Result<fs::File, Error> {
        if self.has_unresolved_journal(FolderSwitchKind::Database) {
            return Err(Self::interrupted_move_root_error());
        }
        Ok(self
            .capability_directory(root.path_ref(), PathOperation::DatabaseMutate)?
            .directory)
    }

    pub(super) fn live_practice_stored(&self, id: &PathRef) -> Result<&StoredEntry, Error> {
        if self.pending_unpersisted_removals.contains(&id.id) {
            return Err(Error::InvalidInput(
                "unknown or revoked practice deck".into(),
            ));
        }
        let Some(entry) = self.persistent.get(&id.id) else {
            return Err(Error::InvalidInput(
                "unknown or unauthorized practice deck".into(),
            ));
        };
        Ok(&entry.stored)
    }

    /// Checks a practice deck capability without making availability part of authorisation.
    /// Membership and the operation bit are inspected before refresh so a wrong-purpose id
    /// cannot cause filesystem validation of its target. Migration and repair intentionally pass
    /// `false`: membership is enough for those recovery operations.
    /// Returns the practice storage key callers must use for store addressing.
    pub(crate) fn authorize_practice_deck(
        &mut self,
        id: &PathRef,
        requires_read_pgn: bool,
    ) -> Result<String, Error> {
        let storage_key = {
            let stored = self.live_practice_stored(id)?;
            if requires_read_pgn && !stored.operations.contains(&PathOperation::ReadPgn) {
                return Err(Error::InvalidInput(
                    "unknown or unauthorized practice deck".into(),
                ));
            }
            practice_storage_key(stored).to_owned()
        };
        self.refresh_persistent_id(id);
        Ok(storage_key)
    }

    pub(crate) fn practice_storage_key(&self, id: &PathRef) -> Result<String, Error> {
        Ok(practice_storage_key(self.live_practice_stored(id)?).to_owned())
    }

    pub(crate) fn live_handle_for_practice_storage_key(
        &self,
        key: &str,
    ) -> Result<Option<PathRef>, Error> {
        let mut found = None;
        for entry in self.persistent.values() {
            if self
                .pending_unpersisted_removals
                .contains(&entry.stored.id.id)
            {
                continue;
            }
            if practice_storage_key(&entry.stored) == key {
                if found.is_some() {
                    return Err(Error::Conflict("practice storage key is ambiguous".into()));
                }
                found = Some(entry.stored.id.clone());
            }
        }
        Ok(found)
    }

    #[cfg(test)]
    pub(crate) fn set_practice_key_for_test(&mut self, id: &PathRef, key: impl Into<String>) {
        self.persistent
            .get_mut(&id.id)
            .expect("test registry entry")
            .stored
            .practice_key = Some(key.into());
    }

    pub(crate) fn set_active_database_root(
        &mut self,
        root: &DatabaseRootHandle,
    ) -> Result<(), Error> {
        self.set_active_database_root_core(root, false)
    }

    pub(crate) fn set_active_default_database_root(
        &mut self,
        root: &DatabaseRootHandle,
    ) -> Result<(), Error> {
        self.set_active_database_root_core(root, true)
    }

    pub(super) fn set_active_database_root_core(
        &mut self,
        root: &DatabaseRootHandle,
        label_root_failure: bool,
    ) -> Result<(), Error> {
        let _ = self.database_root_path(root).map_err(|error| {
            if label_root_failure {
                error.label_root_failure()
            } else {
                error
            }
        })?;
        let active = Some(root.path_ref().clone());
        let durability = self.commit_state(
            self.persistent.clone(),
            active,
            self.active_puzzle_root.clone(),
            self.active_engine_root.clone(),
            self.pending_artifacts.clone(),
            None,
        )?;
        if let CommitDurability::DurabilityUncertain(stage) = durability {
            log::warn!("active database root committed with uncertain durability: {stage}");
        }
        Ok(())
    }

    pub(crate) fn set_active_puzzle_root(&mut self, root: &PuzzleRootHandle) -> Result<(), Error> {
        let _ = self.puzzle_root_path(root)?;
        let durability = self.commit_state(
            self.persistent.clone(),
            self.active_database_root.clone(),
            Some(root.path_ref().clone()),
            self.active_engine_root.clone(),
            self.pending_artifacts.clone(),
            None,
        )?;
        if let CommitDurability::DurabilityUncertain(stage) = durability {
            log::warn!("active puzzle root committed with uncertain durability: {stage}");
        }
        Ok(())
    }

    pub(crate) fn list_puzzle_children_cancellable(
        &mut self,
        root: &PuzzleRootHandle,
        cancellation: &CancellationToken,
    ) -> Result<Vec<PuzzleDatabaseDescriptor>, Error> {
        if self.has_unresolved_journal(FolderSwitchKind::Puzzle) {
            return Err(Self::interrupted_move_root_error());
        }
        self.reconcile_db3_listing(
            root.path_ref(),
            EntryPurpose::PuzzleFile,
            PathOperation::PuzzleRead,
            cancellation,
            |authority, filename, display_name, identity| {
                let entry = authority.prepare_puzzle_listing_child(root, &filename, identity)?;
                let id = entry.id();
                Ok((
                    entry,
                    PuzzleDatabaseDescriptor {
                        file: id,
                        filename: display_name,
                    },
                ))
            },
        )
        .map(|(entries, _)| entries)
    }

    pub(super) fn reconcile_db3_listing<T>(
        &mut self,
        root: &PathRef,
        purpose: EntryPurpose,
        operation: PathOperation,
        cancellation: &CancellationToken,
        mut adapt: impl FnMut(
            &mut Self,
            OsString,
            String,
            (u64, u64),
        ) -> Result<(PreparedEntry, T), Error>,
    ) -> Result<(Vec<T>, Vec<DatabaseUnread>), Error> {
        let snapshot = self.directory_listing_snapshot(root, &[purpose], false, None)?;
        let root_directory = self.capability_directory(root, operation)?;
        let mut prepared = Vec::new();
        let mut unread = Vec::new();
        let mut unread_paths = Vec::new();
        let mut database_names = BTreeMap::new();
        if purpose == EntryPurpose::DatabaseFile {
            for entry in &snapshot.entries {
                if let Some(leaf) = entry.path.to_path()?.file_name() {
                    database_names.insert(nfc_leaf_name(leaf), leaf.to_os_string());
                }
            }
        }
        let children = map_db3_children_cancellable(
            &root_directory,
            cancellation,
            |filename, display_name, identity| {
                if purpose == EntryPurpose::DatabaseFile {
                    let normalized = nfc_leaf_name(&filename);
                    if database_names
                        .get(&normalized)
                        .is_some_and(|name| name != &filename)
                    {
                        return Err(Error::Conflict("database filename already exists".into()));
                    }
                    database_names.insert(normalized, filename.clone());
                }
                let result = identity.and_then(|identity| {
                    let prepared = adapt(self, filename.clone(), display_name.clone(), identity)?;
                    // Probe read access without opening a Unix leaf held by SQLite.
                    let probed = probe_regular_file_at(&root_directory.directory, &filename)?;
                    refuse_unobserved(VerifiedIdentity::from_pair(probed.identity), identity)?;
                    Ok(prepared)
                });
                match result {
                    Ok((entry, child)) => {
                        prepared.push(entry);
                        Ok(Some(child))
                    }
                    Err(error) if purpose == EntryPurpose::PuzzleFile => Err(error),
                    Err(error) => {
                        if let Some(category) = listing_child_outcome(error)? {
                            unread_paths.push((vec![filename], false));
                            unread.push(DatabaseUnread {
                                filename: display_name,
                                category,
                            });
                        }
                        Ok(None)
                    }
                }
            },
        )?;
        let retained = snapshot.retained_ids(&unread_paths)?;
        self.commit_directory_listing(snapshot, prepared, &retained, cancellation)?;
        Ok((children, unread))
    }

    pub(crate) fn puzzle_download_destination(
        &mut self,
        root: &PuzzleRootHandle,
    ) -> Result<PathRef, Error> {
        let _ = self.resolve(root.path_ref(), PathOperation::DownloadFile, &[])?;
        Ok(root.path_ref().clone())
    }

    pub(super) fn puzzle_root_path(&mut self, root: &PuzzleRootHandle) -> Result<PathBuf, Error> {
        self.root_path(root.path_ref(), PathOperation::PuzzleRead)
    }

    pub(super) fn prepare_puzzle_listing_child(
        &mut self,
        root: &PuzzleRootHandle,
        filename: &OsStr,
        observed: (u64, u64),
    ) -> Result<PreparedEntry, Error> {
        validate_components(&[filename.to_os_string()])?;
        let resolved = self.resolve(
            root.path_ref(),
            PathOperation::PuzzleRead,
            &[filename.to_os_string()],
        )?;
        let resolved_identity = refuse_unobserved(resolved.identity()?, observed)?;
        let parent_identity = VerifiedIdentity::from_pair(resolved.parent_identity()?);
        #[cfg(test)]
        PUZZLE_CHILD_POST_RESOLVE_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        let path = self.puzzle_root_path(root)?.join(filename);
        let operations = canonical_operations(EntryPurpose::PuzzleFile);
        let (path, binding) = Self::registration_target(
            &path,
            PathClass::PersistentFile,
            &operations,
            Some(resolved_identity),
            Some(parent_identity),
        )?;
        #[cfg(test)]
        PERSISTENT_FILE_POST_TARGET_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        self.prepare_persistent_file(
            &path,
            filename.to_string_lossy().into_owned(),
            operations,
            binding,
            RegistrationDoor::PassiveObservation,
        )
    }

    /// Returns database children known below a root and reconciles newly
    /// discovered native files into persistent opaque handles.  File names are
    /// backend-derived display metadata only; callers cannot feed them back as
    /// paths.
    pub(crate) fn list_database_children_cancellable(
        &mut self,
        root: &DatabaseRootHandle,
        cancellation: &CancellationToken,
    ) -> Result<DatabaseListing, Error> {
        if self.has_unresolved_journal(FolderSwitchKind::Database) {
            return Err(Self::interrupted_move_root_error());
        }
        self.reconcile_db3_listing(
            root.path_ref(),
            EntryPurpose::DatabaseFile,
            PathOperation::DatabaseRead,
            cancellation,
            |authority, filename, display_name, identity| {
                let entry = authority.prepare_database_listing_child(
                    root,
                    &filename,
                    display_name.clone(),
                    identity,
                    true,
                )?;
                let id = entry.id();
                Ok((
                    entry,
                    DatabaseDescriptor {
                        handle: DatabaseHandle::new(id),
                        filename: display_name,
                        availability: PathAvailability::Available,
                    },
                ))
            },
        )
        .map(|(entries, unread)| DatabaseListing { entries, unread })
    }

    /// Registers an exact database child after validating it relative to the
    /// root.  This avoids a join-and-open race and preserves non-UTF8 names in
    /// the registry; only lossy display metadata leaves the backend.
    #[cfg(all(test, unix))]
    pub(crate) fn register_database_child(
        &mut self,
        root: &DatabaseRootHandle,
        filename: &OsStr,
        display_name: impl Into<String>,
        observed: (u64, u64),
    ) -> Result<DatabaseHandle, Error> {
        let prepared = self.prepare_database_listing_child(
            root,
            filename,
            display_name.into(),
            observed,
            false,
        )?;
        let commit = self.publish_prepared_entry(prepared)?;
        require_durable(commit.durability)?;
        Ok(DatabaseHandle::new(commit.id))
    }

    pub(super) fn prepare_database_listing_child(
        &mut self,
        root: &DatabaseRootHandle,
        filename: &OsStr,
        display_name: impl Into<String>,
        observed: (u64, u64),
        // Listing labels a root-acquisition failure so the per-child classifier
        // cannot treat a removed root as a vanished child. Registration and create
        // keep the unlabelled error.
        label_root_acquisition: bool,
    ) -> Result<PreparedEntry, Error> {
        validate_windows_database_leaf(filename)?;
        let components = vec![filename.to_os_string()];
        let resolved = self.resolve(root.path_ref(), PathOperation::DatabaseRead, &components)?;
        let resolved_identity = refuse_unobserved(resolved.identity()?, observed)?;
        #[cfg(test)]
        DATABASE_CHILD_POST_RESOLVE_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        self.prepare_database_child_verified(
            root,
            filename,
            display_name.into(),
            &resolved,
            resolved_identity,
            label_root_acquisition,
        )
    }

    pub(super) fn register_database_child_verified(
        &mut self,
        root: &DatabaseRootHandle,
        filename: &OsStr,
        display_name: String,
        resolved: &ResolvedPath,
        expected_identity: VerifiedIdentity,
    ) -> Result<DatabaseHandle, Error> {
        let prepared = self.prepare_database_child_verified(
            root,
            filename,
            display_name,
            resolved,
            expected_identity,
            false,
        )?;
        let commit = self.publish_prepared_entry(prepared)?;
        require_durable(commit.durability)?;
        Ok(DatabaseHandle::new(commit.id))
    }

    pub(super) fn prepare_database_child_verified(
        &mut self,
        root: &DatabaseRootHandle,
        filename: &OsStr,
        display_name: String,
        resolved: &ResolvedPath,
        expected_identity: VerifiedIdentity,
        label_root_acquisition: bool,
    ) -> Result<PreparedEntry, Error> {
        if resolved.parent().is_none() || resolved.leaf().is_none() {
            return Err(Error::InvalidInput(
                "database child has no retained parent boundary".into(),
            ));
        }
        let (a, b) = resolved.parent_identity()?;
        let parent_identity = Identity { a, b };
        let root_path = self.database_root_path(root).map_err(|error| {
            if label_root_acquisition {
                error.label_root_failure()
            } else {
                error
            }
        })?;
        let path = root_path.join(filename);
        let validated_identity =
            validate_target(&path, PathClass::PersistentFile).map_err(|error| {
                if resolved.is_regular_file()
                    && (error.is_missing_entry()
                        || matches!(&error, Error::InvalidInput(message)
                        if message == "file authority must be a regular file"
                            || message == "symbolic links cannot be authorized"))
                {
                    Error::Conflict(VERIFIED_REGISTRATION_CONFLICT.into())
                } else {
                    error
                }
            })?;
        let verified_identity =
            verified_identity::database_child_identity(expected_identity, &validated_identity)?;
        if let Some(entry) = self.persistent.values().find(|entry| {
            entry.stored.class == PathClass::PersistentFile
                && entry.stored.path.to_path().ok().as_ref() == Some(&path)
                && entry.stored.identity == validated_identity
                && entry.stored.parent_identity.as_ref() == Some(&parent_identity)
                && !entry.stored.target_is_dir
                && entry.stored.purpose == Some(EntryPurpose::DatabaseFile)
                && entry
                    .stored
                    .operations
                    .contains(&PathOperation::DatabaseRead)
        }) {
            let mut stored = entry.stored.clone();
            stored.operations = canonical_operations(EntryPurpose::DatabaseFile);
            return Ok(PreparedEntry {
                stored,
                reused: true,
            });
        }
        let id = PathRef::fresh();
        let stored = StoredEntry {
            id: id.clone(),
            display_name,
            class: PathClass::PersistentFile,
            purpose: Some(EntryPurpose::DatabaseFile),
            operations: canonical_operations(EntryPurpose::DatabaseFile),
            path: NativePath::from_path(&path),
            identity: {
                let (a, b) = verified_identity.pair();
                Identity { a, b }
            },
            parent_identity: Some(parent_identity),
            target_is_dir: false,
            practice_key: None,
        };
        Ok(PreparedEntry {
            stored,
            reused: false,
        })
    }

    /// Creates an empty database leaf exactly once below a validated database
    /// root, then persists its opaque identity before returning it.  The
    /// filename is a single native component and cannot escape the root.
    pub(crate) fn create_database_child(
        &mut self,
        root: &DatabaseRootHandle,
        filename: &OsStr,
    ) -> Result<DatabaseHandle, Error> {
        validate_windows_database_leaf(filename)?;
        validate_components(&[filename.to_os_string()])?;
        if std::path::Path::new(filename).extension() != Some(OsStr::new("db3")) {
            return Err(Error::InvalidInput(
                "database filename must end in .db3".into(),
            ));
        }
        let components = vec![filename.to_os_string()];
        let resolved = self.resolve(root.path_ref(), PathOperation::DatabaseCreate, &components)?;
        #[cfg(test)]
        DATABASE_CHILD_POST_RESOLVE_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        let parent = resolved
            .parent()
            .ok_or_else(|| Error::InvalidInput("database child has no retained parent".into()))?;
        let leaf = resolved
            .leaf()
            .ok_or_else(|| Error::InvalidInput("database child has no retained leaf".into()))?;
        if !equivalent_sibling_leaves(parent, leaf, &CancellationToken::new())?.is_empty() {
            return Err(Error::Conflict("database filename already exists".into()));
        }
        let (file, verified_identity) = match resolved.create_database_file() {
            Ok(created) => created,
            Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(Error::Conflict("database filename already exists".into()));
            }
            Err(error) => return Err(error),
        };
        let sync_result = (|| {
            file.sync_all()?;
            parent.sync_all()?;
            Ok::<_, Error>(())
        })();
        if let Err(error) = sync_result {
            return Err(Self::cleanup_created_database_child(
                parent,
                leaf,
                verified_identity,
                error,
            ));
        }
        #[cfg(test)]
        DATABASE_CHILD_POST_CREATE_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        match self.register_database_child_verified(
            root,
            filename,
            filename.to_string_lossy().into_owned(),
            &resolved,
            verified_identity,
        ) {
            Ok(handle) => Ok(handle),
            Err(error @ Error::CommittedDurabilityUncertain(_)) => Err(error),
            Err(error) => Err(Self::cleanup_created_database_child(
                parent,
                leaf,
                verified_identity,
                error,
            )),
        }
    }

    pub(super) fn cleanup_created_database_child(
        parent: &fs::File,
        leaf: &OsStr,
        identity: VerifiedIdentity,
        primary: Error,
    ) -> Error {
        Error::with_cleanup(
            primary,
            crate::infra::fs::remove_entry_at(parent, leaf, identity.pair(), false),
        )
    }

    pub(crate) fn database_file_target(
        &mut self,
        handle: &DatabaseHandle,
        operation: PathOperation,
    ) -> Result<DatabaseFileTarget, Error> {
        if !is_database_file_operation(operation) {
            return Err(Error::InvalidInput(
                "invalid database file operation".into(),
            ));
        }
        let workspace_handle = FileWorkspaceHandle::new(handle.path_ref().clone());
        let entry = self.persistent_entry_for(&workspace_handle, operation)?;
        if entry.stored.target_is_dir {
            return Err(Error::InvalidInput(
                "database handle must identify a regular file".into(),
            ));
        }
        let stored = entry.stored;
        let expected = (stored.identity.a, stored.identity.b);
        let acquired = acquire_stored_target(
            &stored,
            AcquireShape::File {
                parent_access: parent_access_for_operations(&[operation]),
            },
            "workspace entry is unavailable because its object changed",
        )?;
        let (parent, leaf) = acquired
            .parent_and_leaf
            .ok_or_else(|| Error::InvalidInput("database path needs a leaf name".into()))?;
        verify_parent_identity(&parent, stored.parent_identity.as_ref())?;
        self.session_protected_ids
            .insert(handle.path_ref().id.clone());
        Ok(DatabaseFileTarget::assemble(
            parent,
            leaf,
            expected,
            acquired.path,
        ))
    }

    /// Recovers deletion authority only for an absent leaf in its recorded parent.
    /// A present leaf must pass ordinary database resolution again before deletion.
    pub(crate) fn recover_database_deletion(
        &mut self,
        handle: &DatabaseHandle,
        original: Error,
        cancellation: &CancellationToken,
    ) -> Result<DatabaseDeleteRecovery, Error> {
        let workspace_handle = FileWorkspaceHandle::new(handle.path_ref().clone());
        let entry = self.persistent_entry_for(&workspace_handle, PathOperation::DatabaseMutate)?;
        if entry.stored.target_is_dir {
            return Err(Error::InvalidInput(
                "database handle must identify a regular file".into(),
            ));
        }
        let stored = entry.stored;
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        if stored.parent_identity.is_none() {
            return Err(original);
        }
        let path = stored.path.to_path()?;
        let parent = match crate::infra::fs::open_parent_no_follow(&path) {
            Ok(parent) => parent,
            Err(error) if error.is_missing_entry() => return Err(original),
            Err(error) => return Err(error),
        };
        verify_parent_identity(&parent, stored.parent_identity.as_ref())?;
        let leaf = path
            .file_name()
            .ok_or_else(|| Error::InvalidInput("database path needs a leaf name".into()))?
            .to_os_string();
        let expected = (stored.identity.a, stored.identity.b);
        match crate::infra::fs::entry_identity_at(&parent, &leaf, false) {
            Err(error) if error.is_missing_entry() => {
                self.session_protected_ids
                    .insert(handle.path_ref().id.clone());
                Ok(DatabaseDeleteRecovery::Absent(
                    DatabaseFileTarget::assemble(parent, leaf, expected, path),
                ))
            }
            Ok(identity) if identity == expected => Ok(DatabaseDeleteRecovery::Present),
            Ok(_) => Err(Error::Conflict(
                "workspace entry is unavailable because its object changed".into(),
            )),
            Err(error) => Err(error),
        }
    }

    pub(crate) fn remove_database(&mut self, handle: &DatabaseHandle) -> Result<(), Error> {
        let mut dropped_engine_executables = Vec::new();
        require_durable(
            self.remove_workspace_entry(
                &FileWorkspaceHandle::new(handle.path_ref().clone()),
                WorkspaceRemovalStatus::Complete,
                &mut dropped_engine_executables,
            )?
            .0,
        )
    }

    pub(crate) fn remove_puzzle_database(&mut self, handle: &PathRef) -> Result<(), Error> {
        let mut dropped_engine_executables = Vec::new();
        require_durable(
            self.remove_workspace_entry(
                &FileWorkspaceHandle::new(handle.clone()),
                WorkspaceRemovalStatus::Complete,
                &mut dropped_engine_executables,
            )?
            .0,
        )
    }

    pub(super) fn database_root_path(
        &mut self,
        root: &DatabaseRootHandle,
    ) -> Result<PathBuf, Error> {
        self.root_path(root.path_ref(), PathOperation::DatabaseRead)
    }

    pub(crate) fn database_download_destination(
        &mut self,
        root: &DatabaseRootHandle,
    ) -> Result<PathRef, Error> {
        let _ = self.resolve(root.path_ref(), PathOperation::DownloadFile, &[])?;
        Ok(root.path_ref().clone())
    }

    pub(crate) fn collection_batch_destination(
        &mut self,
        directory: &AuthorizedDir,
    ) -> Result<PathRef, Error> {
        self.get_or_create_root(
            directory.path(),
            "Account download staging",
            canonical_operations(EntryPurpose::DownloadDestination),
            "download",
            Some(VerifiedIdentity::from_pair(directory.identity)),
        )
    }
}
