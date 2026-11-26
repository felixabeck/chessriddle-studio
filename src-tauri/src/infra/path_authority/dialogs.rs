use super::*;

#[derive(Clone)]
pub(super) struct DialogGrant {
    pub(super) entry: Entry,
    pub(super) expires_at: SystemTime,
    pub(super) uses_left: u32,
    pub(super) inserted_at: u64,
    pub(super) folder_switch: Option<folder_switch::FolderSwitchGrantMetadata>,
}

impl PathAuthority {
    pub fn grant_dialog(
        &mut self,
        path: &Path,
        display_name: impl Into<String>,
        class: PathClass,
        operation: PathOperation,
        ttl: Duration,
        uses_left: u32,
    ) -> Result<PathRef, Error> {
        self.grant_dialog_operations(path, display_name, class, vec![operation], ttl, uses_left)
    }

    pub(super) fn check_dialog_grant_shape(
        class: PathClass,
        operations: &[PathOperation],
        uses_left: u32,
    ) -> Result<(), Error> {
        if !matches!(
            class,
            PathClass::SingleDialogGrant | PathClass::BoundedDialogGrant
        ) || (class == PathClass::SingleDialogGrant && uses_left != 1)
            || (class == PathClass::BoundedDialogGrant && uses_left == 0)
            || operations.is_empty()
        {
            return Err(Error::InvalidInput("invalid dialog grant shape".into()));
        }
        Ok(())
    }

    pub(super) fn grant_acquired(
        &mut self,
        acquired: AcquiredTarget,
        display_name: String,
        class: PathClass,
        operations: Vec<PathOperation>,
        ttl: Duration,
        uses_left: u32,
    ) -> Result<PathRef, Error> {
        self.insert_dialog_grant(
            acquired,
            display_name,
            class,
            operations,
            (ttl, uses_left),
            None,
        )
    }

    pub(super) fn insert_dialog_grant(
        &mut self,
        acquired: AcquiredTarget,
        display_name: String,
        class: PathClass,
        operations: Vec<PathOperation>,
        (ttl, uses_left): (Duration, u32),
        folder_switch: Option<folder_switch::FolderSwitchGrantMetadata>,
    ) -> Result<PathRef, Error> {
        Self::check_dialog_grant_shape(class, &operations, uses_left)?;
        // Validate before evicting: malformed dialog input must not affect live grants.
        self.evict_dialogs();
        if self.dialogs.len() >= self.dialog_capacity {
            if let Some(oldest) = self
                .dialogs
                .iter()
                .min_by_key(|(_, g)| g.inserted_at)
                .map(|(id, _)| id.clone())
            {
                self.dialogs.remove(&oldest);
            }
        }
        let id = PathRef::fresh();
        self.next_insertion += 1;
        let stored = StoredEntry {
            id: id.clone(),
            display_name,
            class,
            purpose: None,
            operations,
            path: NativePath::from_path(&acquired.path),
            identity: acquired.identity,
            parent_identity: acquired.parent_identity,
            target_is_dir: acquired.target_is_dir,
            practice_key: None,
        };
        self.dialogs.insert(
            id.id.clone(),
            DialogGrant {
                entry: Entry {
                    stored,
                    availability: PathAvailability::Available,
                },
                expires_at: self.clock.now() + ttl,
                uses_left,
                inserted_at: self.next_insertion,
                folder_switch,
            },
        );
        Ok(id)
    }

    pub fn grant_dialog_operations(
        &mut self,
        path: &Path,
        display_name: impl Into<String>,
        class: PathClass,
        operations: Vec<PathOperation>,
        ttl: Duration,
        uses_left: u32,
    ) -> Result<PathRef, Error> {
        Self::check_dialog_grant_shape(class, &operations, uses_left)?;
        let acquired = acquire_target(
            path,
            AcquireShape::Dialog {
                parent_access: parent_access_for_operations(&operations),
            },
        )?;
        self.grant_acquired(
            acquired,
            display_name.into(),
            class,
            operations,
            ttl,
            uses_left,
        )
    }
    /// Consumes an exact live dialog grant and persists the same native object as a root or file.
    pub fn promote_dialog(
        &mut self,
        dialog: &PathRef,
        persistent_class: PathClass,
        display_name: impl Into<String>,
        operations: Vec<PathOperation>,
    ) -> Result<PathCommit, Error> {
        if !matches!(
            persistent_class,
            PathClass::PersistentCustomRoot | PathClass::PersistentFile
        ) {
            return Err(Error::InvalidInput(
                "promotion target must be persistent".into(),
            ));
        }
        if operations.is_empty() {
            return Err(Error::InvalidInput(
                "persistent operations cannot be empty".into(),
            ));
        }
        let target_is_dir = persistent_class == PathClass::PersistentCustomRoot;
        let purpose = purpose_for_shape(persistent_class, target_is_dir, &operations);
        if self.attachments_sealed && is_attachment_purpose(purpose) {
            return Err(Error::Conflict(
                "engine attachment mutations are sealed".into(),
            ));
        }
        let grant = self.dialogs.get(&dialog.id).cloned().ok_or_else(|| {
            Error::InvalidInput("unknown, revoked, or expired dialog grant".into())
        })?;
        if grant.folder_switch.is_some() {
            return Err(Error::InvalidInput(
                "unknown, revoked, or expired dialog grant".into(),
            ));
        }
        self.dialogs.remove(&dialog.id);
        if grant.expires_at <= self.clock.now() {
            return Err(Error::InvalidInput(
                "unknown, revoked, or expired dialog grant".into(),
            ));
        }
        if operations
            .iter()
            .any(|op| !grant.entry.stored.operations.contains(op))
        {
            return Err(Error::InvalidInput(
                "promotion cannot escalate dialog operation authority".into(),
            ));
        }
        let path = grant.entry.stored.path.to_path()?;
        let shape = AcquireShape::for_persistent_class(
            persistent_class,
            parent_access_for_operations(&operations),
        );
        let acquired = acquire_target(&path, shape)?;
        #[cfg(test)]
        PROMOTE_DIALOG_POST_ACQUIRE_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        if acquired.path != path
            || acquired.identity != grant.entry.stored.identity
            || acquired.parent_identity != grant.entry.stored.parent_identity
        {
            return Err(
                Error::Conflict("dialog target changed before promotion".into())
                    .with_root_failure(crate::error::RootFailure::Changed),
            );
        }
        let expected = acquired.identity.clone();
        if let Some(purpose) = purpose {
            let same_path = |entry: &Entry| {
                entry.stored.class == persistent_class
                    && entry.stored.purpose == Some(purpose)
                    && entry.stored.path.to_path().ok().as_ref() == Some(&path)
            };
            // Reuse is identity-first so a Library listing that already minted the current
            // object at this path is reused. A same-path PersistentFile whose identity no
            // longer matches is left in place for startup reconciliation (d-20261113-02);
            // the picker mints a fresh entry with no practice key (d-20261115-01). Custom
            // workspace roots still refuse with Changed.
            if let Some(existing) = self
                .persistent
                .values()
                .find(|entry| same_path(entry) && entry.stored.identity == expected)
            {
                let id = existing.stored.id.clone();
                let mut candidate = self.persistent.clone();
                if let Some(entry) = candidate.get_mut(&id.id) {
                    entry.stored.operations = canonical_operations(purpose);
                    entry.stored.parent_identity = acquired.parent_identity.clone();
                }
                let durability = self.commit_candidate(candidate, Some(dialog))?;
                self.session_protected_ids.insert(id.id.clone());
                return Ok(PathCommit { id, durability });
            } else if persistent_class == PathClass::PersistentCustomRoot
                && self.persistent.values().any(same_path)
            {
                return Err(Error::Conflict(
                    "persistent target changed; acquire a new capability".into(),
                )
                .with_root_failure(crate::error::RootFailure::Changed));
            }
        }
        let id = PathRef::fresh();
        let operations = purpose.map(canonical_operations).unwrap_or(operations);
        let stored = StoredEntry {
            id: id.clone(),
            display_name: display_name.into(),
            class: persistent_class,
            purpose,
            operations,
            path: NativePath::from_path(&acquired.path),
            identity: expected,
            parent_identity: acquired.parent_identity,
            target_is_dir,
            practice_key: None,
        };
        let mut candidate = self.persistent.clone();
        candidate.insert(
            id.id.clone(),
            Entry {
                stored,
                availability: PathAvailability::Available,
            },
        );
        let provisional = matches!(
            purpose,
            Some(EntryPurpose::EngineResource | EntryPurpose::EngineImage)
        );
        if provisional {
            self.provisional_attachments.insert(id.id.clone());
        }
        let durability = match self.commit_candidate(candidate, Some(dialog)) {
            Ok(durability) => durability,
            Err(error) => {
                if provisional {
                    self.provisional_attachments.remove(&id.id);
                }
                return Err(error);
            }
        };
        self.session_protected_ids.insert(id.id.clone());
        Ok(PathCommit { id, durability })
    }

    /// Consumes one use of a live dialog grant. A missing (never issued, consumed or
    /// evicted-as-expired) grant is `Error::UnknownPathCapability`, a missing resource: `resolve`
    /// reaches this only after the persistent lookup failed, so renderer owners such as recent
    /// files can drop the id.
    pub(super) fn take_dialog(
        &mut self,
        id: &PathRef,
        required: Option<PathOperation>,
    ) -> Result<DialogGrant, Error> {
        self.evict_dialogs();
        if self
            .dialogs
            .get(&id.id)
            .is_some_and(|grant| grant.folder_switch.is_some())
        {
            return Err(Error::UnknownPathCapability);
        }
        let mut grant = self
            .dialogs
            .remove(&id.id)
            .ok_or(Error::UnknownPathCapability)?;
        if let Some(op) = required {
            if !grant.entry.stored.operations.contains(&op) {
                self.dialogs.insert(id.id.clone(), grant);
                return Err(Error::InvalidInput(
                    "dialog grant does not permit this operation".into(),
                ));
            }
        }
        grant.uses_left -= 1;
        if grant.uses_left > 0 {
            self.dialogs.insert(id.id.clone(), grant.clone());
        }
        Ok(grant)
    }
    pub(super) fn evict_dialogs(&mut self) {
        let now = self.clock.now();
        self.dialogs.retain(|_, g| g.expires_at > now);
    }
}
