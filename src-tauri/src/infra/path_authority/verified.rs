/// The field is private to this submodule so a pathname-opened `File` cannot be
/// substituted at the `main.rs` call sites.
mod mint {
    pub(crate) struct VerifiedFile(crate::infra::inode_ownership::OwnedFile);

    impl VerifiedFile {
        pub(super) fn from_resolved(resolved: &mut super::super::ResolvedPath) -> Option<Self> {
            resolved.take_file().map(Self)
        }

        pub(in crate::infra::path_authority) fn into_inner(
            self,
        ) -> crate::infra::inode_ownership::OwnedFile {
            self.0
        }

        pub(in crate::infra::path_authority) fn as_file(
            &self,
        ) -> &crate::infra::inode_ownership::OwnedFile {
            &self.0
        }

        pub(in crate::infra::path_authority) fn sha256(
            &mut self,
            #[cfg(test)] observer: Option<
                &std::sync::Arc<dyn super::super::ActivationObserver + Send + Sync>,
            >,
        ) -> Result<(u64, String), super::super::Error> {
            super::super::sha256_open_file(
                &mut self.0,
                #[cfg(test)]
                observer,
            )
        }

        #[cfg(all(test, unix))]
        pub(in crate::infra::path_authority) fn try_clone_inner(
            &self,
        ) -> std::io::Result<crate::infra::inode_ownership::OwnedFile> {
            self.0.try_clone()
        }
    }
}

pub(crate) use mint::VerifiedFile;

impl super::PathAuthority {
    /// Opens an exact, revalidated image capability and applies the pre-read
    /// metadata bound. The caller reads through [`super::read_verified_image_bytes`] or
    /// [`super::read_engine_image_bytes`] after the authority guard has been dropped.
    pub(super) fn open_image_path(
        &mut self,
        path: &super::PathRef,
        max_bytes: usize,
    ) -> Result<(VerifiedFile, u64), super::Error> {
        let mut resolved = self.resolve(path, super::PathOperation::ImageRead, &[])?;
        let declared = resolved
            .file()
            .ok_or_else(|| super::Error::InvalidInput("image capability is not a file".into()))?
            .metadata()?
            .len();
        if declared > max_bytes as u64 {
            return Err(super::Error::ResourceLimit(
                "image exceeds the supported size limit".into(),
            ));
        }
        let file = VerifiedFile::from_resolved(&mut resolved)
            .ok_or_else(|| super::Error::InvalidInput("image capability is not a file".into()))?;
        Ok((file, declared))
    }

    /// Opens an exact, revalidated engine image capability and applies the pre-read
    /// metadata bound. The caller reads through [`super::read_engine_image_bytes`] after the
    /// authority guard has been dropped.
    pub(super) fn open_engine_image(
        &mut self,
        image: &super::EngineImageHandle,
        max_bytes: usize,
    ) -> Result<(VerifiedFile, u64), super::Error> {
        self.open_image_path(image.path_ref(), max_bytes)
    }

    /// Prepares exactly the artifact covered by a durable reservation after atomic replacement.
    /// Retains the no-follow opened descriptor and validates the pending reservation, root,
    /// payload bound, post-rename identity marker and replacement baseline before reading bytes.
    /// Failed preparation leaves the durable intent in place so restart recovery can proceed
    /// without losing a published file.
    pub(super) fn prepare_download_artifact(
        &mut self,
        reservation: &super::PendingArtifactReservation,
    ) -> Result<super::PreparedArtifactActivation, super::Error> {
        let pending = self
            .pending_artifacts
            .iter()
            .find(|pending| pending.id == reservation.id)
            .cloned()
            .ok_or_else(|| {
                super::Error::InvalidInput("unknown download artifact reservation".into())
            })?;
        if !pending.payload_bound {
            return Err(super::Error::Conflict(
                "download artifact payload differs from its durable reservation".into(),
            ));
        }
        let root = self
            .persistent
            .get(&pending.root.id)
            .cloned()
            .ok_or_else(|| {
                super::Error::Conflict(
                    "download root disappeared before artifact activation".into(),
                )
            })?;
        let acquired = super::acquire_stored_target(
            &root.stored,
            super::AcquireShape::Root {
                parent_access: super::parent_access_for_operations(&[
                    super::PathOperation::DownloadFile,
                ]),
            },
            "download root changed before artifact activation",
        )?;
        let root_path = acquired.path;
        let root_identity = acquired.identity;
        if pending.root_identity.as_ref() != Some(&root_identity) {
            return Err(super::Error::Conflict(
                "download root changed before artifact activation".into(),
            ));
        }
        let filename = pending.filename.to_path()?;
        let leaf = filename
            .file_name()
            .ok_or_else(|| super::Error::InvalidInput("artifact reservation has no leaf".into()))?
            .to_os_string();
        let mut resolved =
            self.resolve(&pending.root, super::PathOperation::DownloadFile, &[leaf])?;
        let descriptor = VerifiedFile::from_resolved(&mut resolved).ok_or_else(|| {
            super::Error::Conflict("artifact target is not a regular file".into())
        })?;
        let (a, b) = super::opened_file_identity(descriptor.as_file())?;
        let descriptor_identity = super::Identity { a, b };
        let descriptor_change_stamp = super::opened_file_change_stamp(descriptor.as_file())?;
        if pending.installed_identity.as_ref() != Some(&descriptor_identity)
            || pending.installed_ctime_nanos != Some(descriptor_change_stamp)
        {
            return Err(super::Error::Conflict(
                "download artifact has no durable post-rename identity marker".into(),
            ));
        }
        if pending
            .baseline
            .as_ref()
            .is_some_and(|baseline| baseline == &descriptor_identity)
        {
            return Err(super::Error::Conflict(
                "download artifact target was not replaced before activation".into(),
            ));
        }
        #[cfg(test)]
        let observer = self.activation_observer.clone();

        Ok(super::PreparedArtifactActivation {
            descriptor,
            pending,
            root_id: root.stored.id.clone(),
            root_path,
            root_identity,
            prepared_identity: descriptor_identity,
            prepared_change_stamp: descriptor_change_stamp,
            #[cfg(test)]
            observer,
        })
    }
}
