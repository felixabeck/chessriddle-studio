use super::*;

/// A directory reached through a `PathRef` capability. It carries no pathname.
pub(crate) struct CapabilityDirectory {
    pub(super) directory: fs::File,
}

impl CapabilityDirectory {
    pub(crate) fn identity(&self) -> Result<(u64, u64), Error> {
        opened_file_identity(&self.directory)
    }

    /// One descriptor-relative read of this directory, on both platforms.
    ///
    /// `probe_listing_root_failure` uses this fail-fast reader to re-check the root.
    /// Listing walks use `listing_entries` to preserve named child stat failures.
    pub(crate) fn entries(
        &self,
        cancellation: &CancellationToken,
        keep: &mut dyn FnMut(&OsStr) -> bool,
    ) -> Result<Vec<DirectoryEntry>, Error> {
        let entries = read_directory_entries_at(
            &self.directory,
            cancellation,
            Some(crate::infra::fs::MAX_DIRECTORY_LISTING_ENTRIES),
            keep,
        )?;
        #[cfg(all(test, unix))]
        CAPABILITY_DIRECTORY_POST_ENTRIES_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        Ok(entries)
    }

    /// Listing-only reader. Other authority consumers retain the fail-fast `entries` contract.
    pub(crate) fn listing_entries(
        &self,
        cancellation: &CancellationToken,
        keep: &mut dyn FnMut(&OsStr) -> bool,
    ) -> Result<crate::infra::fs::ListingDirectoryEntries, Error> {
        let entries = crate::infra::fs::read_listing_directory_entries_at(
            &self.directory,
            cancellation,
            Some(crate::infra::fs::MAX_DIRECTORY_LISTING_ENTRIES),
            keep,
        )?;
        #[cfg(all(test, unix))]
        CAPABILITY_DIRECTORY_POST_ENTRIES_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        Ok(entries)
    }

    /// Remaps the errors a concurrent swap of the child produces into the one retryable
    /// `Conflict` the workspace listing reports, so a directory replaced between enumeration and
    /// open is a retry rather than a hard failure. Unix sees `LOOP`/`NOTDIR`/`NOENT`; Windows sees
    /// the NT counterparts, plus `open_windows_child`'s reparse refusal, because an entry that was
    /// a directory at enumeration time and is a junction when it is opened is the same swap.
    pub(super) fn child_open_swap(error: Error) -> Error {
        conflict_if_replaced(error, "workspace directory changed concurrently")
    }

    pub(crate) fn open_child_directory(
        &self,
        entry: &DirectoryEntry,
    ) -> Result<CapabilityDirectory, Error> {
        if entry.kind != DirectoryEntryKind::Directory {
            return Err(Error::InvalidInput(
                "directory entry is not a directory".into(),
            ));
        }
        crate::infra::fs::single_leaf(&entry.name)?;
        #[cfg(all(test, unix))]
        CAPABILITY_CHILD_PRE_OPEN_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        let opened = open_directory_at(&self.directory, &entry.name, false)
            .map_err(Self::child_open_swap)?;
        Ok(CapabilityDirectory {
            directory: VerifiedDir::new(opened, entry.identity)?.into_file(),
        })
    }

    pub(crate) fn confirm_entry(&self, entry: &DirectoryEntry) -> Result<(), Error> {
        crate::infra::fs::single_leaf(&entry.name)?;
        assert_entry_identity(
            &self.directory,
            &entry.name,
            entry.identity,
            entry.kind == DirectoryEntryKind::Directory,
        )
    }

    pub(crate) fn open_metadata_sidecar(
        &self,
        pgn: &DirectoryEntry,
    ) -> Result<Option<OwnedFile>, Error> {
        crate::infra::fs::single_leaf(&pgn.name)?;
        let sidecar = workspace_sidecar_leaf(&pgn.name)?;
        #[cfg(all(test, unix))]
        WORKSPACE_METADATA_PRE_OPEN_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        let opened = match open_regular_at(&self.directory, &sidecar, RegularFileAccess::ReadOnly) {
            Ok(file) => {
                #[cfg(all(test, unix))]
                WORKSPACE_METADATA_POST_OPEN_HOOK.with(|slot| {
                    if let Some(hook) = slot.borrow_mut().take() {
                        hook(&file);
                    }
                });
                Some(file)
            }
            Err(error) if error.is_missing_entry() => None,
            Err(error) => return Err(error),
        };
        self.confirm_entry(pgn)?;
        Ok(opened)
    }
}

/// Records only identities eligible for this listing before its unlocked walk.
pub(crate) struct DirectoryListingSnapshot {
    pub(super) root: PathBuf,
    pub(super) entries: Vec<StoredEntry>,
}

impl DirectoryListingSnapshot {
    /// Match only the pre-walk paths, without observing the filesystem again.
    pub(crate) fn retained_ids(
        &self,
        unread: &[(Vec<OsString>, bool)],
    ) -> Result<BTreeSet<String>, Error> {
        let mut retained = BTreeSet::new();
        for (components, recursive) in unread {
            let path = components
                .iter()
                .fold(self.root.clone(), |path, leaf| path.join(leaf));
            for stored in &self.entries {
                let recorded = stored.path.to_path()?;
                let descendant = *recursive
                    && if cfg!(windows) {
                        recorded
                            .ancestors()
                            .any(|ancestor| listing_paths_match(ancestor, &path))
                    } else {
                        recorded.starts_with(&path)
                    };
                if listing_paths_match(&recorded, &path) || descendant {
                    retained.insert(stored.id.id.clone());
                }
            }
        }
        Ok(retained)
    }
}

impl PathAuthority {
    pub(super) fn directory_listing_snapshot(
        &self,
        root: &PathRef,
        purposes: &[EntryPurpose],
        recursive: bool,
        excluded_prefix: Option<&OsStr>,
    ) -> Result<DirectoryListingSnapshot, Error> {
        let root_path = self
            .persistent
            .get(&root.id)
            .ok_or_else(|| Error::Conflict("listing root is not persistent".into()))?
            .stored
            .path
            .to_path()?;
        let excluded = excluded_prefix.map(|prefix| root_path.join(prefix));
        let mut entries = Vec::new();
        for entry in self.persistent.values() {
            if !entry
                .stored
                .purpose
                .is_some_and(|purpose| purposes.contains(&purpose))
            {
                continue;
            }
            let path = entry.stored.path.to_path()?;
            let child = if recursive {
                path != root_path && path.starts_with(&root_path)
            } else {
                path.parent() == Some(root_path.as_path())
            };
            if child
                && !excluded
                    .as_ref()
                    .is_some_and(|prefix| path.starts_with(prefix))
            {
                entries.push(entry.stored.clone());
            }
        }
        Ok(DirectoryListingSnapshot {
            root: root_path,
            entries,
        })
    }

    pub(crate) fn workspace_listing_snapshot(
        &self,
        workspace: &FileWorkspaceHandle,
        trash_prefix: &OsStr,
    ) -> Result<DirectoryListingSnapshot, Error> {
        self.directory_listing_snapshot(
            workspace.path_ref(),
            &[EntryPurpose::PgnFile, EntryPurpose::PgnWorkspace],
            true,
            Some(trash_prefix),
        )
    }

    pub(crate) fn trash_listing_snapshot(
        &self,
        workspace: &FileWorkspaceHandle,
        trash_prefix: &OsStr,
    ) -> Result<DirectoryListingSnapshot, Error> {
        let mut snapshot = self.directory_listing_snapshot(
            workspace.path_ref(),
            &[EntryPurpose::PgnFile, EntryPurpose::PgnWorkspace],
            true,
            None,
        )?;
        let prefix = snapshot.root.join(trash_prefix);
        snapshot.entries.retain(|entry| {
            entry
                .path
                .to_path()
                .is_ok_and(|path| path.starts_with(&prefix))
        });
        Ok(snapshot)
    }

    pub(crate) fn retained_listing_records(
        snapshot: &DirectoryListingSnapshot,
        cancellation: &CancellationToken,
    ) -> Result<BTreeSet<String>, Error> {
        let mut retained = BTreeSet::new();
        for recorded in &snapshot.entries {
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            let shape = if recorded.target_is_dir {
                AcquireShape::Root {
                    parent_access: ParentAccess::Readable,
                }
            } else {
                AcquireShape::File {
                    parent_access: ParentAccess::Readable,
                }
            };
            let retain = match acquire_stored_target(recorded, shape, "trash entry changed") {
                Ok(_) => true,
                Err(error) => {
                    !matches!(
                        classify_probe_error_kind(&error),
                        ProbeErrorClass::NotFound
                            | ProbeErrorClass::Reparse
                            | ProbeErrorClass::WrongKind
                    ) && !matches!(error, Error::Conflict(_) | Error::InvalidInput(_))
                }
            };
            if retain {
                retained.insert(recorded.id.id.clone());
            }
        }
        Ok(retained)
    }

    pub(super) fn listing_candidate(
        &self,
        snapshot: &DirectoryListingSnapshot,
        prepared: &[PreparedEntry],
        retained: &BTreeSet<String>,
    ) -> BTreeMap<String, Entry> {
        let reused: BTreeSet<_> = prepared
            .iter()
            .filter(|entry| entry.reused)
            .map(|entry| entry.stored.id.id.as_str())
            .collect();
        // Clone at commit time, preserving registrations made during the unlocked walk.
        let mut candidate = self.persistent.clone();
        let mut removed = Vec::new();
        for recorded in &snapshot.entries {
            if !reused.contains(recorded.id.id.as_str())
                && !retained.contains(&recorded.id.id)
                && candidate.get(&recorded.id.id).is_some_and(|current| {
                    current.stored.path == recorded.path
                        && current.stored.identity == recorded.identity
                        && current.stored.purpose == recorded.purpose
                })
            {
                if let Some(entry) = candidate.remove(&recorded.id.id) {
                    removed.push(entry.stored);
                }
            }
        }
        let inherited = inherit_listing_practice_keys(&removed, prepared);
        for entry in prepared {
            let mut stored = entry.stored.clone();
            if let Some(key) = inherited.get(&stored.id.id) {
                stored.practice_key = Some(key.clone());
            }
            candidate.insert(
                stored.id.id.clone(),
                Entry {
                    stored,
                    availability: PathAvailability::Available,
                },
            );
        }
        candidate
    }

    pub(crate) fn commit_directory_listing(
        &mut self,
        snapshot: DirectoryListingSnapshot,
        prepared: Vec<PreparedEntry>,
        retained: &BTreeSet<String>,
        cancellation: &CancellationToken,
    ) -> Result<(), Error> {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let candidate = self.listing_candidate(&snapshot, &prepared, retained);
        let admission = |entries: &BTreeMap<String, Entry>| {
            self.registry_admission_snapshot(
                entries,
                &self.active_database_root,
                &self.active_puzzle_root,
                &self.active_engine_root,
                &self.pending_artifacts,
                &self.provisional_attachments,
                &self.retired_attachments,
                &self.image_cleanup,
            )
        };
        Self::check_registry_growth(&admission(&candidate)?, &admission(&self.persistent)?)?;
        // Only existing identities may publish canonical operations before the snapshot commit.
        for entry in prepared.iter().filter(|entry| entry.reused) {
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            let commit = self.publish_prepared_entry(PreparedEntry {
                stored: entry.stored.clone(),
                reused: true,
            })?;
            require_durable(commit.durability)?;
        }
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let candidate = self.listing_candidate(&snapshot, &prepared, retained);
        let durability = if candidate != self.persistent {
            self.commit_candidate(candidate, None)?
        } else {
            CommitDurability::Durable
        };
        for entry in prepared {
            self.session_protected_ids.insert(entry.stored.id.id);
        }
        require_durable(durability)
    }

    #[cfg(all(test, unix))]
    pub(crate) fn persistent_snapshot_for_test(&self) -> Vec<(String, (u64, u64), bool)> {
        let mut snapshot = self
            .persistent
            .values()
            .map(|entry| {
                (
                    entry.stored.display_name.clone(),
                    (entry.stored.identity.a, entry.stored.identity.b),
                    entry.stored.target_is_dir,
                )
            })
            .collect::<Vec<_>>();
        snapshot.sort();
        snapshot
    }

    /// Resolves an authorized directory for descriptor-relative enumeration. Database and puzzle
    /// listings share the same retained-directory walk as the PGN workspace listing.
    pub(crate) fn capability_directory(
        &mut self,
        id: &PathRef,
        operation: PathOperation,
    ) -> Result<CapabilityDirectory, Error> {
        let mut resolved = self.resolve(id, operation, &[])?;
        let directory = resolved
            .take_directory()
            .ok_or_else(|| Error::InvalidInput("path capability is not a directory".into()))?;
        Ok(CapabilityDirectory { directory })
    }
}
