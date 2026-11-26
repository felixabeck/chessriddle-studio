use super::*;

impl PathAuthority {
    /// Windows counterpart of the unix arm below, keeping its split exactly: an **existing**
    /// regular file is identity-checked and its bytes are left untouched, and only a **missing**
    /// one is created exclusively. It deliberately does not route through
    /// `atomic_replace_at_identified` — the unix arm does not either, and replacing here would
    /// destroy the very file the caller selected, before a single game had been written.
    #[cfg(windows)]
    pub(crate) fn create_pgn_export_destination(
        &mut self,
        path: &Path,
        display_name: impl Into<String>,
    ) -> Result<FileWorkspaceDescriptor, Error> {
        if matches!(
            path.as_os_str().as_encoded_bytes().last(),
            Some(b'/') | Some(b'\\')
        ) {
            return Err(Error::InvalidInput(
                "PGN export destination must have a .pgn filename".into(),
            ));
        }
        let extension_is_pgn = path
            .extension()
            .and_then(OsStr::to_str)
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pgn"));
        if !extension_is_pgn || path.file_stem().is_none_or(|stem| stem.is_empty()) {
            return Err(Error::InvalidInput(
                "PGN export destination must have a .pgn filename".into(),
            ));
        }

        // The parent observed here is the one the identity check below pins the canonicalized
        // open against, so a swap between the two is a `Conflict` rather than a create in a
        // directory the caller never chose. Canonicalization on its own is not that pin.
        let parent_probe = open_windows_nofollow(parent_of(path), false)?;
        if !parent_probe.metadata()?.is_dir() {
            return Err(Error::InvalidInput(
                "PGN export destination parent must be a directory".into(),
            ));
        }
        let parent_identity = opened_file_identity(&parent_probe)?;
        drop(parent_probe);
        #[cfg(test)]
        ACQUIRE_TARGET_BEFORE_PROOF_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        let canonical = canonical_binding(path)?;
        // A0: the parent is opened writable, because the create below flushes it.
        let parent = crate::infra::fs::open_parent_no_follow(&canonical)?;
        if opened_file_identity(&parent)? != parent_identity {
            return Err(Error::Conflict(
                "PGN export destination changed before creation".into(),
            ));
        }
        let canonical = pgn_export_equivalent_path(&parent, &canonical)?;
        let leaf = canonical
            .file_name()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                Error::InvalidInput("PGN export destination must have a .pgn filename".into())
            })?
            .to_os_string();

        let mut created_identity = None;
        let display_name = display_name.into();
        let operations = canonical_operations(EntryPurpose::PgnFile);
        let result = (|| {
            let identity = match crate::infra::fs::entry_identity_at(&parent, &leaf, false) {
                Ok(identity) => identity,
                Err(error) if error.is_missing_entry() => {
                    let (file, identity) = crate::infra::fs::create_regular_at(&parent, &leaf)?;
                    created_identity = Some(identity);
                    file.sync_all()?;
                    parent.sync_all()?;
                    #[cfg(test)]
                    PGN_EXPORT_POST_CREATE_HOOK.with(|slot| {
                        if let Some(hook) = slot.borrow_mut().take() {
                            hook();
                        }
                    });
                    identity
                }
                Err(Error::InvalidInput(_)) => {
                    return Err(Error::InvalidInput(
                        "PGN export destination must be a regular file".into(),
                    ));
                }
                Err(error) => return Err(error),
            };
            let grant = self.grant_acquired(
                AcquiredTarget {
                    path: canonical.clone(),
                    identity: Identity {
                        a: identity.0,
                        b: identity.1,
                    },
                    parent_identity: Some(Identity {
                        a: parent_identity.0,
                        b: parent_identity.1,
                    }),
                    target_is_dir: false,
                    parent_and_leaf: None,
                },
                display_name.clone(),
                PathClass::BoundedDialogGrant,
                operations.clone(),
                PGN_FILE_DIALOG_GRANT_TTL,
                PGN_FILE_DIALOG_GRANT_USES,
            )?;
            let commit = self.promote_dialog(
                &grant,
                PathClass::PersistentFile,
                display_name.clone(),
                operations,
            )?;
            require_durable(commit.durability)?;
            Ok(FileWorkspaceDescriptor {
                handle: FileWorkspaceHandle::new(commit.id),
                display_name,
                availability: PathAvailability::Available,
            })
        })();

        match result {
            Err(primary) if !matches!(primary, Error::CommittedDurabilityUncertain(_)) => {
                match created_identity {
                    Some(identity) => Err(pgn_export_error_after_cleanup(
                        primary,
                        crate::infra::fs::remove_entry_at(&parent, &leaf, identity, false),
                        &leaf,
                    )),
                    None => Err(primary),
                }
            }
            other => other,
        }
    }

    /// Turns a native save-dialog choice into one persistent, exact PGN destination. The renderer
    /// receives only the resulting workspace handle; the selected native path never leaves this
    /// authority boundary. A new target is materialized before the dialog grant is promoted so
    /// the persisted identity is the object the subsequent atomic PGN write must replace.
    #[cfg(unix)]
    pub(crate) fn create_pgn_export_destination(
        &mut self,
        path: &Path,
        display_name: impl Into<String>,
    ) -> Result<FileWorkspaceDescriptor, Error> {
        use rustix::fs::{self as rfs, AtFlags, FileType};
        use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};

        if path.as_os_str().as_bytes().last() == Some(&b'/') {
            return Err(Error::InvalidInput(
                "PGN export destination must have a .pgn filename".into(),
            ));
        }
        let extension_is_pgn = path
            .extension()
            .and_then(OsStr::to_str)
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pgn"));
        if !extension_is_pgn || path.file_stem().is_none_or(|stem| stem.is_empty()) {
            return Err(Error::InvalidInput(
                "PGN export destination must have a .pgn filename".into(),
            ));
        }

        let parent_path = parent_of(path);
        let parent_metadata = fs::metadata(parent_path)?;
        if !parent_metadata.is_dir() {
            return Err(Error::InvalidInput(
                "PGN export destination parent must be a directory".into(),
            ));
        }
        let parent_identity = (parent_metadata.dev(), parent_metadata.ino());
        #[cfg(test)]
        ACQUIRE_TARGET_BEFORE_PROOF_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        let canonical = canonical_binding(path)?;
        let parent = crate::infra::fs::open_parent_no_follow(&canonical)?;
        if opened_file_identity(&parent)? != parent_identity {
            return Err(Error::Conflict(
                "PGN export destination changed before creation".into(),
            ));
        }
        let canonical = pgn_export_equivalent_path(&parent, &canonical)?;
        let leaf = canonical
            .file_name()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                Error::InvalidInput("PGN export destination must have a .pgn filename".into())
            })?
            .to_os_string();

        let mut created_identity = None;
        let display_name = display_name.into();
        let operations = canonical_operations(EntryPurpose::PgnFile);
        let result = (|| {
            let identity = match rfs::statat(&parent, &leaf, AtFlags::SYMLINK_NOFOLLOW) {
                Ok(stat) => {
                    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
                        return Err(Error::InvalidInput(
                            "PGN export destination must be a regular file".into(),
                        ));
                    }
                    crate::infra::fs::raw_stat_identity(&stat)
                }
                Err(error) if error == rustix::io::Errno::NOENT => {
                    let (file, identity) = crate::infra::fs::create_regular_at(&parent, &leaf)?;
                    created_identity = Some(identity);
                    file.sync_all()?;
                    parent.sync_all()?;
                    #[cfg(test)]
                    PGN_EXPORT_POST_CREATE_HOOK.with(|slot| {
                        if let Some(hook) = slot.borrow_mut().take() {
                            hook();
                        }
                    });
                    identity
                }
                Err(error) => return Err(Error::Io(Box::new(error.into()))),
            };
            let grant = self.grant_acquired(
                AcquiredTarget {
                    path: canonical.clone(),
                    identity: Identity {
                        a: identity.0,
                        b: identity.1,
                    },
                    parent_identity: Some(Identity {
                        a: parent_identity.0,
                        b: parent_identity.1,
                    }),
                    target_is_dir: false,
                    parent_and_leaf: None,
                },
                display_name.clone(),
                PathClass::BoundedDialogGrant,
                operations.clone(),
                PGN_FILE_DIALOG_GRANT_TTL,
                PGN_FILE_DIALOG_GRANT_USES,
            )?;
            let commit = self.promote_dialog(
                &grant,
                PathClass::PersistentFile,
                display_name.clone(),
                operations,
            )?;
            require_durable(commit.durability)?;
            Ok(FileWorkspaceDescriptor {
                handle: FileWorkspaceHandle::new(commit.id),
                display_name,
                availability: PathAvailability::Available,
            })
        })();

        match result {
            Err(primary) if !matches!(primary, Error::CommittedDurabilityUncertain(_)) => {
                match created_identity {
                    Some(identity) => Err(pgn_export_error_after_cleanup(
                        primary,
                        crate::infra::fs::remove_entry_at(&parent, &leaf, identity, false),
                        &leaf,
                    )),
                    None => Err(primary),
                }
            }
            other => other,
        }
    }

    /// Returns the native root for a persistent, directory-backed workspace after checking its
    /// identity and required operation. This is intentionally crate-private: renderer code only
    /// ever receives [`FileWorkspaceHandle`], while native workspace commands use this one
    /// authority boundary for every filesystem operation.
    pub(crate) fn workspace_root(
        &mut self,
        workspace: &FileWorkspaceHandle,
        operation: PathOperation,
    ) -> Result<PathBuf, Error> {
        let entry = self
            .persistent
            .get(&workspace.path_ref().id)
            .cloned()
            .ok_or_else(|| Error::InvalidInput("workspace is not persistent".into()))?;
        if !entry.stored.target_is_dir || !entry.stored.operations.contains(&operation) {
            return Err(Error::InvalidInput(
                "workspace does not permit this operation".into(),
            ));
        }
        let acquired = acquire_stored_target(
            &entry.stored,
            AcquireShape::Root {
                parent_access: parent_access_for_operations(&[operation]),
            },
            "workspace is unavailable because its root changed",
        )?;
        self.session_protected_ids
            .insert(workspace.path_ref().id.clone());
        Ok(acquired.path)
    }

    /// Persists an opaque child handle for an entry observed through a retained directory
    /// descriptor. The supplied identity is the one captured during enumeration.
    pub(crate) fn register_workspace_child_observed_with_parent(
        &mut self,
        workspace: &FileWorkspaceHandle,
        components: &[OsString],
        display_name: impl Into<String>,
        binding: IdentityBinding,
        is_dir: bool,
        operation: PathOperation,
    ) -> Result<FileWorkspaceHandle, Error> {
        let prepared = self.prepare_workspace_listing_child(
            workspace,
            components,
            display_name,
            binding,
            is_dir,
            operation,
        )?;
        let commit = self.publish_prepared_entry(prepared)?;
        require_durable(commit.durability)?;
        Ok(FileWorkspaceHandle::new(commit.id))
    }

    pub(crate) fn prepare_workspace_listing_child(
        &mut self,
        workspace: &FileWorkspaceHandle,
        components: &[OsString],
        display_name: impl Into<String>,
        binding: IdentityBinding,
        is_dir: bool,
        operation: PathOperation,
    ) -> Result<PreparedEntry, Error> {
        validate_components(components)?;
        if components.is_empty() {
            return Err(Error::InvalidInput("workspace child is required".into()));
        }
        let root_entry = self
            .persistent
            .get(&workspace.path_ref().id)
            .cloned()
            .ok_or_else(|| Error::InvalidInput("workspace is not persistent".into()))?;
        if !root_entry.stored.target_is_dir || !root_entry.stored.operations.contains(&operation) {
            return Err(Error::InvalidInput("invalid PGN workspace root".into()));
        }
        let root = root_entry.stored.path.to_path()?;
        let path = components.iter().fold(root, |mut path, component| {
            path.push(component);
            path
        });
        let class = if is_dir {
            PathClass::PersistentCustomRoot
        } else {
            PathClass::PersistentFile
        };
        self.prepare_workspace_child(
            root_entry,
            path,
            display_name.into(),
            class,
            binding,
            is_dir,
        )
    }

    #[cfg(test)]
    pub(crate) fn register_workspace_child_observed(
        &mut self,
        workspace: &FileWorkspaceHandle,
        components: &[OsString],
        display_name: impl Into<String>,
        identity: (u64, u64),
        is_dir: bool,
        operation: PathOperation,
    ) -> Result<FileWorkspaceHandle, Error> {
        let root_entry = self
            .persistent
            .get(&workspace.path_ref().id)
            .expect("test workspace is persistent");
        let path =
            components
                .iter()
                .fold(root_entry.stored.path.to_path()?, |mut path, component| {
                    path.push(component);
                    path
                });
        let parent = crate::infra::fs::open_parent_no_follow(&path)?;
        self.register_workspace_child_observed_with_parent(
            workspace,
            components,
            display_name,
            IdentityBinding::from_pairs(identity, opened_file_identity(&parent)?),
            is_dir,
            operation,
        )
    }

    pub(super) fn prepare_workspace_child(
        &self,
        root_entry: Entry,
        path: PathBuf,
        display_name: String,
        class: PathClass,
        binding: IdentityBinding,
        is_dir: bool,
    ) -> Result<PreparedEntry, Error> {
        let parent_identity = if is_dir {
            None
        } else {
            Some(binding.parent_identity.clone().ok_or_else(|| {
                Error::InvalidInput("workspace file has no observed parent identity".into())
            })?)
        };
        let purpose =
            (root_entry.stored.purpose == Some(EntryPurpose::PgnWorkspace)).then_some(if is_dir {
                EntryPurpose::PgnWorkspace
            } else {
                EntryPurpose::PgnFile
            });
        if let Some((id, entry)) = self.persistent.iter().find(|(_, entry)| {
            entry.stored.class == class
                && entry.stored.path.to_path().ok().as_ref() == Some(&path)
                && entry.stored.identity == binding.identity
                && entry.stored.parent_identity == parent_identity
                && entry.stored.target_is_dir == is_dir
                && entry.stored.purpose == purpose
                && (purpose.is_some()
                    || same_operation_set(&entry.stored.operations, &root_entry.stored.operations))
        }) {
            let mut stored = entry.stored.clone();
            stored.id = PathRef { id: id.clone() };
            if let Some(purpose) = purpose {
                stored.operations = canonical_operations(purpose);
            }
            return Ok(PreparedEntry {
                stored,
                reused: true,
            });
        }
        let id = PathRef::fresh();
        let stored = StoredEntry {
            id: id.clone(),
            display_name,
            class,
            purpose,
            operations: purpose
                .map(canonical_operations)
                .unwrap_or(root_entry.stored.operations),
            path: NativePath::from_path(&path),
            identity: binding.identity,
            parent_identity,
            target_is_dir: is_dir,
            practice_key: None,
        };
        Ok(PreparedEntry {
            stored,
            reused: false,
        })
    }

    /// Rebinds a successfully renamed entry without reopening its mutable pathname. `renameat`
    /// preserves the object identity already stored on the capability; a later resolver either
    /// observes that exact object at the new path or fails closed.
    pub(crate) fn rebind_workspace_entry(
        &mut self,
        handle: &FileWorkspaceHandle,
        path: &Path,
        display_name: impl Into<String>,
        parent_identity: (u64, u64),
    ) -> Result<(), Error> {
        let mut candidate = self.persistent.clone();
        let entry = candidate
            .get_mut(&handle.path_ref().id)
            .ok_or_else(|| Error::Conflict("workspace entry disappeared".into()))?;
        entry.stored.path = NativePath::from_path(path);
        entry.stored.display_name = display_name.into();
        entry.stored.parent_identity = Some(Identity {
            a: parent_identity.0,
            b: parent_identity.1,
        });
        entry.availability = PathAvailability::Available;
        require_durable(self.commit_candidate(candidate, None)?)?;
        Ok(())
    }

    /// Checks the current registry location without opening the file or consulting collections.
    /// Workspace membership is path-based, as it is for workspace moves and descendant removal.
    pub(crate) fn ensure_pgn_not_trashed(&self, handle: &FileWorkspaceHandle) -> Result<(), Error> {
        let Some(entry) = self.persistent.get(&handle.path_ref().id) else {
            return Ok(());
        };
        let path = entry.stored.path.to_path()?;
        for root in self.persistent.values().filter(|entry| {
            entry.stored.target_is_dir && entry.stored.operations.contains(&PathOperation::ReadPgn)
        }) {
            let root_path = root.stored.path.to_path()?;
            if let Ok(relative) = path.strip_prefix(root_path) {
                let locator: Vec<_> = relative
                    .components()
                    .map(|part| part.as_os_str().to_os_string())
                    .collect();
                if crate::file_workspace::is_trash_locator(&locator) {
                    return Err(Error::FileTrashed);
                }
            }
        }
        Ok(())
    }

    pub(crate) fn workspace_entry_path(
        &mut self,
        handle: &FileWorkspaceHandle,
        operation: PathOperation,
    ) -> Result<PathBuf, Error> {
        let entry = self.persistent_entry_for(handle, operation)?;
        let parent_access = parent_access_for_operations(&[operation]);
        let shape = if entry.stored.target_is_dir {
            AcquireShape::Root { parent_access }
        } else {
            AcquireShape::File { parent_access }
        };
        let acquired = acquire_stored_target(
            &entry.stored,
            shape,
            "workspace entry is unavailable because its object changed",
        )?;
        let (parent, _) = acquired
            .parent_and_leaf
            .ok_or_else(|| Error::InvalidInput("workspace entry needs a leaf name".into()))?;
        if !entry.stored.target_is_dir {
            verify_parent_identity(&parent, entry.stored.parent_identity.as_ref())?;
        }
        self.session_protected_ids
            .insert(handle.path_ref().id.clone());
        Ok(acquired.path)
    }

    /// Resolves an opaque workspace capability into retained no-follow descriptors.  This is the
    /// mutation boundary: callers must not reopen `path()` for filesystem changes.
    pub(crate) fn workspace_mutation_target(
        &mut self,
        handle: &FileWorkspaceHandle,
    ) -> Result<WorkspaceMutationTarget, Error> {
        let target = self.retained_workspace_target(handle, PathOperation::WritePgn)?;
        let directory = if target.target_is_dir {
            Some(
                crate::infra::fs::open_verified_directory(&target.path, target.identity)?
                    .into_file(),
            )
        } else {
            None
        };
        Ok(WorkspaceMutationTarget {
            parent: target.parent,
            directory,
            leaf: target.leaf,
            identity: target.identity,
            is_dir: target.target_is_dir,
            path: target.path,
        })
    }

    pub(super) fn retained_workspace_target(
        &mut self,
        handle: &FileWorkspaceHandle,
        required_operation: PathOperation,
    ) -> Result<RetainedWorkspaceTarget, Error> {
        let entry = self.persistent_entry_for(handle, required_operation)?;
        let path = entry.stored.path.to_path()?;
        let expected = (entry.stored.identity.a, entry.stored.identity.b);
        let (parent, leaf) = crate::infra::fs::open_verified_parent(
            &path,
            expected,
            entry.stored.target_is_dir,
            ParentAccess::Writable,
        )?;
        if !entry.stored.target_is_dir {
            verify_parent_identity(&parent, entry.stored.parent_identity.as_ref())?;
        }
        self.session_protected_ids
            .insert(handle.path_ref().id.clone());
        Ok(RetainedWorkspaceTarget {
            parent,
            leaf,
            identity: expected,
            target_is_dir: entry.stored.target_is_dir,
            path,
        })
    }

    /// Remove workspace registry entries and return the save's durability and the number of
    /// registry ids this call removed that an earlier failed save had not already removed.
    /// The count is returned only with a committed save. Workspace deletion error counts instead
    /// come from physical target removal, including engine retirement errors. Pending ids are
    /// excluded because an earlier call removed them from its candidate map but failed to save it,
    /// so this directory's candidate or the commit prune would otherwise count them again.
    /// This is neither a count of filesystem entries nor the registry-size delta.
    pub(crate) fn remove_workspace_entry(
        &mut self,
        handle: &FileWorkspaceHandle,
        status: WorkspaceRemovalStatus,
        dropped_engine_executables: &mut Vec<PathRef>,
    ) -> Result<(CommitDurability, usize), Error> {
        let removed = self
            .persistent
            .get(&handle.path_ref().id)
            .cloned()
            .ok_or_else(|| Error::InvalidInput("workspace entry is not persistent".into()))?;
        let removed_path = removed.stored.path.to_path()?;
        self.remove_workspace_path(
            &removed_path,
            removed.stored.target_is_dir,
            status,
            dropped_engine_executables,
        )
    }

    pub(crate) fn remove_workspace_path(
        &mut self,
        removed_path: &Path,
        is_dir: bool,
        status: WorkspaceRemovalStatus,
        dropped_engine_executables: &mut Vec<PathRef>,
    ) -> Result<(CommitDurability, usize), Error> {
        let mut candidate = self.persistent.clone();
        candidate.retain(|id, entry| {
            let _ = id;
            let Ok(path) = entry.stored.path.to_path() else {
                return true;
            };
            if path == removed_path {
                return status == WorkspaceRemovalStatus::Partial;
            }
            let is_descendant = is_dir && path.strip_prefix(removed_path).is_ok();
            if !is_descendant {
                return true;
            }
            if status == WorkspaceRemovalStatus::Complete {
                return false;
            }
            refresh_entry(entry);
            entry.availability == PathAvailability::Available
        });

        let removed_ids: Vec<_> = self
            .persistent
            .keys()
            .filter(|id| !candidate.contains_key(*id))
            .cloned()
            .collect();
        dropped_engine_executables.extend(removed_ids.iter().filter_map(|id| {
            let entry = self.persistent.get(id)?;
            entry
                .stored
                .operations
                .iter()
                .any(|operation| {
                    matches!(
                        operation,
                        PathOperation::EngineExecute | PathOperation::EngineConfigure
                    )
                })
                .then(|| PathRef { id: id.clone() })
        }));
        let mut pending_artifacts = self.pending_artifacts.clone();
        pending_artifacts.retain(|pending| !removed_ids.contains(&pending.root.id));
        // An intent whose root was removed by this operation can never activate. This is scoped
        // here rather than made a general commit invariant because other commits do not establish
        // that a missing root was deliberately deleted.
        //
        // After a successful save, workspace records no longer outlive the objects they name. If
        // saving fails, however, this prune is not adopted: in-memory state must not diverge from
        // what was persisted, so the unavailable records remain until a later successful,
        // explicit reconciliation. Residual accumulation is therefore limited to registry-save
        // failures rather than ordinary workspace create-and-delete use.
        let newly_removed_ids = removed_ids
            .iter()
            .filter(|id| !self.pending_unpersisted_removals.contains(*id))
            .count();
        match self.commit_candidate_with_pending(candidate, pending_artifacts, None) {
            Ok(durability) => Ok((durability, newly_removed_ids)),
            Err(error) => {
                self.pending_unpersisted_removals.extend(removed_ids);
                Err(error)
            }
        }
    }

    /// Rebind every persistent child below a moved directory in one registry replacement. This
    /// keeps already-open tabs and recents attached to their original filesystem identities
    /// after a native directory move; paths never need to be reconstructed in the renderer.
    pub(crate) fn rebase_workspace_entries(
        &mut self,
        old_root: &Path,
        new_root: &Path,
    ) -> Result<(), Error> {
        self.rebase_workspace_records(old_root, new_root, None)
    }

    pub(crate) fn restore_workspace_records(
        &mut self,
        old_root: &Path,
        new_root: &Path,
        parent_identity: (u64, u64),
    ) -> Result<(), Error> {
        self.rebase_workspace_records(old_root, new_root, Some(parent_identity))
    }

    pub(super) fn rebase_workspace_records(
        &mut self,
        old_root: &Path,
        new_root: &Path,
        parent_identity: Option<(u64, u64)>,
    ) -> Result<(), Error> {
        let mut candidate = self.persistent.clone();
        let mut changed = false;
        for entry in candidate.values_mut() {
            let path = entry.stored.path.to_path()?;
            if let Ok(suffix) = path.strip_prefix(old_root) {
                let target = if suffix.as_os_str().is_empty() {
                    new_root.to_path_buf()
                } else {
                    new_root.join(suffix)
                };
                entry.stored.path = NativePath::from_path(&target);
                if path == old_root && !entry.stored.target_is_dir {
                    if let Some((a, b)) = parent_identity {
                        entry.stored.parent_identity = Some(Identity { a, b });
                    }
                }
                entry.availability = PathAvailability::Available;
                changed = true;
            }
        }
        if changed {
            require_durable(self.commit_candidate(candidate, None)?)?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn fill_trash_registry_for_test(
        &mut self,
        workspace: &FileWorkspaceHandle,
    ) -> Result<usize, Error> {
        let template = self
            .persistent
            .get(&workspace.path_ref().id)
            .cloned()
            .ok_or_else(|| Error::InvalidInput("test workspace missing".into()))?;
        for index in 0..MAX_AUTHORITY_IDS {
            if self.persistent.len() == MAX_AUTHORITY_IDS {
                break;
            }
            let mut entry = template.clone();
            entry.stored.id.id = format!("trash-capacity-{index}");
            self.persistent
                .entry(entry.stored.id.id.clone())
                .or_insert(entry);
        }
        require_durable(self.save()?)?;
        Ok(self.persistent.len())
    }

    pub(crate) fn database_folder_status(
        &mut self,
        lookups: &DefaultDirLookups<'_>,
    ) -> Result<FolderStatus, Error> {
        self.kind_folder_status(
            self.active_database_root.clone(),
            PathOperation::DatabaseRead,
            VisibleDefaultKind::Databases,
            lookups,
        )
    }

    pub(crate) fn engine_folder_status(
        &mut self,
        lookups: &DefaultDirLookups<'_>,
    ) -> Result<FolderStatus, Error> {
        self.kind_folder_status(
            self.active_engine_root.clone(),
            PathOperation::EngineInstall,
            VisibleDefaultKind::Engines,
            lookups,
        )
    }

    pub(crate) fn puzzle_folder_status(
        &mut self,
        lookups: &DefaultDirLookups<'_>,
    ) -> Result<FolderStatus, Error> {
        self.kind_folder_status(
            self.active_puzzle_root.clone(),
            PathOperation::PuzzleRead,
            VisibleDefaultKind::Puzzles,
            lookups,
        )
    }

    pub(crate) fn file_workspace_descriptor(
        &self,
        workspace: FileWorkspaceHandle,
    ) -> Result<FileWorkspaceDescriptor, Error> {
        let entry = self
            .persistent
            .get(&workspace.path_ref().id)
            .ok_or_else(|| Error::Conflict("file workspace disappeared".into()))?;
        Ok(FileWorkspaceDescriptor {
            handle: workspace,
            display_name: entry.stored.display_name.clone(),
            availability: entry.availability,
        })
    }

    pub(crate) fn file_folder_status(
        &mut self,
        workspace: &FileWorkspaceHandle,
        lookups: &DefaultDirLookups<'_>,
    ) -> Result<FolderStatus, Error> {
        let id = workspace.path_ref();
        let Some(entry) = self.persistent.get(&id.id) else {
            return Err(Error::InvalidInput("workspace is not persistent".into()));
        };
        let display_name = folder_leaf_display_name(&entry.stored);
        let is_default = self.root_matches_default(id, VisibleDefaultKind::Pgn, lookups);
        let root_failure = match self.workspace_root(workspace, PathOperation::ReadPgn) {
            Ok(_) => None,
            Err(error) => error.label_root_failure().root_failure(),
        };
        Ok(FolderStatus {
            display_name,
            is_default,
            root_failure,
        })
    }

    fn kind_folder_status(
        &mut self,
        active: Option<PathRef>,
        operation: PathOperation,
        default_kind: VisibleDefaultKind,
        lookups: &DefaultDirLookups<'_>,
    ) -> Result<FolderStatus, Error> {
        let switch_kind = match default_kind {
            VisibleDefaultKind::Databases => Some(FolderSwitchKind::Database),
            VisibleDefaultKind::Engines => Some(FolderSwitchKind::Engine),
            VisibleDefaultKind::Puzzles => Some(FolderSwitchKind::Puzzle),
            VisibleDefaultKind::Pgn => None,
        };
        let default_display = default_kind.leaf();
        let Some(id) = active else {
            let root_failure = switch_kind
                .filter(|kind| self.has_unresolved_journal(*kind))
                .map(|_| crate::error::RootFailure::InterruptedMove);
            return Ok(FolderStatus {
                display_name: default_display.to_string(),
                is_default: true,
                root_failure,
            });
        };
        let display_name = self
            .persistent
            .get(&id.id)
            .map(|entry| folder_leaf_display_name(&entry.stored))
            .unwrap_or_else(|| default_display.to_string());
        let is_default = self.root_matches_default(&id, default_kind, lookups);
        if switch_kind.is_some_and(|kind| self.has_unresolved_journal(kind)) {
            return Ok(FolderStatus {
                display_name,
                is_default,
                root_failure: Some(crate::error::RootFailure::InterruptedMove),
            });
        }
        let root_failure = match self.resolve_active_root(Some(id), operation) {
            Ok(_) => None,
            Err(error) => error.label_root_failure().root_failure(),
        };
        Ok(FolderStatus {
            display_name,
            is_default,
            root_failure,
        })
    }

    fn root_matches_default(
        &self,
        id: &PathRef,
        default_kind: VisibleDefaultKind,
        lookups: &DefaultDirLookups<'_>,
    ) -> bool {
        let Some(entry) = self.persistent.get(&id.id) else {
            return false;
        };
        live_visible_default_identity(lookups, default_kind)
            .is_some_and(|live| live == entry.stored.identity)
    }

    pub(crate) fn database_folder_open_path(
        &mut self,
        lookups: &DefaultDirLookups<'_>,
    ) -> Result<PathBuf, Error> {
        self.kind_folder_open_path(
            self.active_database_root.clone(),
            PathOperation::DatabaseRead,
            VisibleDefaultKind::Databases,
            lookups,
        )
    }

    pub(crate) fn engine_folder_open_path(
        &mut self,
        lookups: &DefaultDirLookups<'_>,
    ) -> Result<PathBuf, Error> {
        self.kind_folder_open_path(
            self.active_engine_root.clone(),
            PathOperation::EngineInstall,
            VisibleDefaultKind::Engines,
            lookups,
        )
    }

    pub(crate) fn puzzle_folder_open_path(
        &mut self,
        lookups: &DefaultDirLookups<'_>,
    ) -> Result<PathBuf, Error> {
        self.kind_folder_open_path(
            self.active_puzzle_root.clone(),
            PathOperation::PuzzleRead,
            VisibleDefaultKind::Puzzles,
            lookups,
        )
    }

    pub(crate) fn file_folder_open_path(
        &mut self,
        workspace: &FileWorkspaceHandle,
    ) -> Result<PathBuf, Error> {
        self.workspace_root(workspace, PathOperation::ReadPgn)
            .map(|path| native_shell_path(&path))
            .map_err(|error| error.label_root_failure())
    }

    /// Idle (no active root) materialises the resolver default so Show in folder and
    /// the next picker both land on the same directory the rest of the app will use.
    fn kind_folder_open_path(
        &mut self,
        active: Option<PathRef>,
        operation: PathOperation,
        default_kind: VisibleDefaultKind,
        lookups: &DefaultDirLookups<'_>,
    ) -> Result<PathBuf, Error> {
        if let Some(id) = active {
            return self
                .root_path(&id, operation)
                .map(|path| native_shell_path(&path))
                .map_err(|error| error.label_root_failure());
        }
        let authorized = resolve_visible_default_dir(lookups, default_kind)?;
        Ok(native_shell_path(authorized.path()))
    }
}

fn folder_leaf_display_name(stored: &StoredEntry) -> String {
    let name = stored.display_name.trim();
    if !name.is_empty() && !name.contains('/') && !name.contains('\\') {
        return stored.display_name.clone();
    }
    stored
        .path
        .to_path()
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|leaf| leaf.to_string_lossy().into_owned())
        })
        .filter(|leaf| !leaf.is_empty())
        .unwrap_or_else(|| stored.display_name.clone())
}
