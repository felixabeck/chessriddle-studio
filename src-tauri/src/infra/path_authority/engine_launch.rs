use super::*;
use std::io::Write;

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
