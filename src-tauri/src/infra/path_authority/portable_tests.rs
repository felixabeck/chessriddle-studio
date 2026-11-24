use super::*;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// Tauri resolves real user directories even in a mock app, so behavior cannot isolate this wiring.
#[test]
fn instance_admission_production_wires_all_per_user_roots() {
    use crate::infra::blocking::source_scan::{body_at_indent, normalise, Literals};
    let mod_source = include_str!("mod.rs");
    let (mod_production, _) = mod_source
        .split_once("#[cfg(test)]\npub(crate) mod portable_tests;")
        .expect("mod.rs declares portable_tests after its production items");
    let body = body_at_indent(
        mod_production,
        "pub(crate) fn admit_instance<R: tauri::Runtime>(",
    );
    let compact = |text: &str| {
        normalise(text, Literals::Keep)
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>()
    };
    let body = compact(body);
    let config = body
        .find("letconfig=app.path().app_config_dir()")
        .expect("configuration resolution");
    let local = body
        .find("letlocal=app.path().app_local_data_dir()")
        .expect("local-data resolution");
    let call = body.find(&compact("admit_instance_with_lock(app_data, &[(\"configuration\", &config), (\"local data\", &local)], |file| {")).expect("data, configuration and local-data admission in that order");
    assert!(config < local && local < call);
    let production = normalise(test_source_files::production_source(), Literals::Blank);
    assert_eq!(
        production.matches("admit_instance_with_lock(").count(),
        2,
        "only the definition and the production admission call may occur in infra/path_authority"
    );
    assert_eq!(body.matches("admit_instance_with_lock(").count(), 1);
}

#[test]
fn instance_lock_refuses_competitor_and_keeps_leaf_after_drop() {
    let capture = crate::error::LogCaptureScope::start();
    let temp = tempfile::tempdir().unwrap();
    let app_data = AppDataDir::for_test(temp.path());
    fs::write(temp.path().join("instance.lock"), b"retained contents").unwrap();
    let InstanceAdmission::Owned(guard) = admit_test_instance(&app_data, &[]).unwrap() else {
        panic!("first admission must own the lock");
    };
    assert!(matches!(
        admit_test_instance(&app_data, &[]).unwrap(),
        InstanceAdmission::HeldElsewhere
    ));
    let records = capture.records();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].level, log::Level::Warn);
    assert_eq!(
            records[0].message,
            "another ChessRiddle Studio process holds the application data directory; this launch exits"
        );
    drop(guard);
    assert!(temp.path().join("instance.lock").is_file());
    assert_eq!(
        fs::read(temp.path().join("instance.lock")).unwrap(),
        b"retained contents"
    );
    let _guard = crate::infra::fs::retry_until_lock_released(|| {
        match admit_test_instance(&app_data, &[]).unwrap() {
            InstanceAdmission::Owned(guard) => Some(guard),
            InstanceAdmission::HeldElsewhere => None,
            InstanceAdmission::Unguarded => panic!("re-admission must own the instance lock"),
        }
    })
    .expect("instance lock was not released within the deadline after the holder dropped");
    assert!(temp.path().join("instance.lock").is_file());
}

fn admit_test_instance(
    app_data: &AppDataDir,
    extra_roots: &[(&'static str, &Path)],
) -> Result<InstanceAdmission, Error> {
    admit_instance_with_lock(app_data, extra_roots, |file| {
        crate::infra::fs::lock_advisory_file(file, crate::infra::fs::AdvisoryLockMode::NonBlocking)
    })
}

#[test]
fn instance_lock_refuses_shared_config_with_distinct_data_roots() {
    let capture = crate::error::LogCaptureScope::start();
    let temp = tempfile::tempdir().unwrap();
    let first = AppDataDir::for_test(&temp.path().join("data-one"));
    let second = AppDataDir::for_test(&temp.path().join("data-two"));
    let config = temp.path().join("config");
    let InstanceAdmission::Owned(_guard) = admit_test_instance(
        &first,
        &[("configuration", &config), ("local data", first.as_path())],
    )
    .unwrap() else {
        panic!("first process must own its distinct roots");
    };
    assert!(matches!(
        admit_test_instance(
            &second,
            &[("configuration", &config), ("local data", second.as_path())]
        )
        .unwrap(),
        InstanceAdmission::HeldElsewhere
    ));
    assert_eq!(capture.records().len(), 1);
    assert_eq!(capture.records()[0].level, log::Level::Warn);
    // A failed admission must release the data-root lock it acquired before finding contention.
    let _second_guard =
        crate::infra::fs::retry_until_lock_released(|| {
            match admit_test_instance(&second, &[]).unwrap() {
                InstanceAdmission::Owned(guard) => Some(guard),
                InstanceAdmission::HeldElsewhere => None,
                InstanceAdmission::Unguarded => panic!("data-root re-admission must own the lock"),
            }
        })
        .expect("data-root lock was not released within the deadline after failed admission");
}

#[test]
fn instance_lock_allows_fully_distinct_roots() {
    let capture = crate::error::LogCaptureScope::start();
    let temp = tempfile::tempdir().unwrap();
    let mut guards = Vec::new();
    for suffix in ["one", "two"] {
        let data = AppDataDir::for_test(&temp.path().join(format!("data-{suffix}")));
        let config = temp.path().join(format!("config-{suffix}"));
        let local = temp.path().join(format!("local-{suffix}"));
        let InstanceAdmission::Owned(guard) =
            admit_test_instance(&data, &[("configuration", &config), ("local data", &local)])
                .unwrap()
        else {
            panic!("distinct roots must coexist");
        };
        assert_eq!(guard._files.len(), 3);
        guards.push(guard);
    }
    assert!(capture.records().is_empty());
}

#[test]
fn instance_lock_deduplicates_retained_directory_identity() {
    let capture = crate::error::LogCaptureScope::start();
    let temp = tempfile::tempdir().unwrap();
    let data = AppDataDir::for_test(temp.path());
    let InstanceAdmission::Owned(guard) = admit_test_instance(
        &data,
        &[("configuration", temp.path()), ("local data", temp.path())],
    )
    .unwrap() else {
        panic!("repeated roots must not contend with themselves");
    };
    assert_eq!(guard._files.len(), 1);
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    assert!(capture.records().is_empty());
}

#[test]
fn instance_lock_classifies_per_root_outcomes() {
    #[cfg(unix)]
    let unsupported = rustix::io::Errno::NOSYS.raw_os_error();
    #[cfg(windows)]
    let unsupported = windows_sys::Win32::Foundation::ERROR_NOT_SUPPORTED as i32;
    let temp = tempfile::tempdir().unwrap();
    let data = AppDataDir::for_test(&temp.path().join("data"));
    let config = temp.path().join("config");
    let local = temp.path().join("local");
    for outcomes in [
        [None, Some(unsupported), None],
        [Some(unsupported), None, None],
        [Some(unsupported); 3],
        [None, Some(0), None],
    ] {
        let capture = crate::error::LogCaptureScope::start();
        let mut calls = 0;
        let result = admit_instance_with_lock(
            &data,
            &[("configuration", &config), ("local data", &local)],
            |_| {
                let outcome = outcomes[calls];
                calls += 1;
                match outcome {
                    None => Ok(()),
                    Some(0) => Err(crate::infra::fs::AdvisoryLockError::Io(
                        std::io::Error::new(
                            std::io::ErrorKind::PermissionDenied,
                            "injected second-root failure",
                        ),
                    )),
                    Some(code) => Err(crate::infra::fs::AdvisoryLockError::Io(
                        std::io::Error::from_raw_os_error(code),
                    )),
                }
            },
        );
        let records = capture.records();
        match outcomes {
            [None, Some(code), None] if code == unsupported => {
                let InstanceAdmission::Owned(guard) = result.unwrap() else {
                    panic!("supported roots must remain guarded");
                };
                assert_eq!(guard._files.len(), 2);
                assert!(guard.app_data_locked());
                assert_eq!(records.len(), 1);
                assert_eq!(records[0].level, log::Level::Warn);
                assert!(records[0].message.starts_with(
                    "the configuration directory's filesystem does not support advisory locking."
                ));
            }
            [Some(code), None, None] if code == unsupported => {
                let InstanceAdmission::Owned(guard) = result.unwrap() else {
                    panic!("supported roots must remain guarded");
                };
                assert!(!guard.app_data_locked());
                assert_eq!(guard._files.len(), 2);
                assert_eq!(records.len(), 1);
                assert_eq!(records[0].level, log::Level::Warn);
                assert!(records[0].message.starts_with("the application data directory's filesystem does not support advisory locking."));
            }
            [Some(_), Some(_), Some(_)] => {
                assert!(matches!(result.unwrap(), InstanceAdmission::Unguarded));
                assert_eq!(records.len(), 3);
                assert!(records
                    .iter()
                    .all(|record| record.level == log::Level::Warn));
                for (record, role) in
                    records
                        .iter()
                        .zip(["application data", "configuration", "local data"])
                {
                    assert!(record.message.starts_with(&format!(
                        "the {role} directory's filesystem does not support advisory locking."
                    )));
                }
            }
            _ => {
                assert!(result.is_err());
                assert_eq!(calls, 2);
                assert_eq!(records.len(), 1);
                assert_eq!(records[0].level, log::Level::Error);
            }
        }
    }
    assert!(matches!(
        admit_test_instance(&data, &[]).unwrap(),
        InstanceAdmission::Owned(_)
    ));
}

#[cfg(unix)]
#[test]
fn instance_lock_refuses_symlink_as_error() {
    let capture = crate::error::LogCaptureScope::start();
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("target");
    fs::write(&target, b"unchanged").unwrap();
    std::os::unix::fs::symlink(&target, temp.path().join("instance.lock")).unwrap();
    assert!(admit_test_instance(&AppDataDir::for_test(temp.path()), &[]).is_err());
    assert_eq!(fs::read(&target).unwrap(), b"unchanged");
    assert_eq!(capture.records().len(), 1);
    assert_eq!(capture.records()[0].level, log::Level::Error);
}

#[test]
fn instance_lock_injected_errors_log_and_classify_once() {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let (unsupported, ordinary) = {
        use rustix::io::Errno;
        (
            [
                Errno::OPNOTSUPP.raw_os_error(),
                Errno::NOTSUP.raw_os_error(),
                Errno::NOSYS.raw_os_error(),
            ],
            [Errno::NOLCK.raw_os_error(), Errno::ACCESS.raw_os_error()],
        )
    };
    #[cfg(windows)]
    let (unsupported, ordinary) = {
        use windows_sys::Win32::Foundation::{
            ERROR_ACCESS_DENIED, ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED,
            ERROR_NO_SYSTEM_RESOURCES,
        };
        (
            [ERROR_NOT_SUPPORTED as i32, ERROR_INVALID_FUNCTION as i32],
            [ERROR_NO_SYSTEM_RESOURCES as i32, ERROR_ACCESS_DENIED as i32],
        )
    };
    let temp = tempfile::tempdir().unwrap();
    let app_data = AppDataDir::for_test(temp.path());
    for code in unsupported.into_iter().chain(ordinary) {
        let capture = crate::error::LogCaptureScope::start();
        let result = admit_instance_with_lock(&app_data, &[], |_| {
            Err(crate::infra::fs::AdvisoryLockError::Io(
                std::io::Error::from_raw_os_error(code),
            ))
        });
        let records = capture.records();
        assert_eq!(records.len(), 1, "{code}");
        if unsupported.contains(&code) {
            assert!(matches!(result, Ok(InstanceAdmission::Unguarded)), "{code}");
            assert_eq!(records[0].level, log::Level::Warn);
            assert!(records[0].message.starts_with(
                "the application data directory's filesystem does not support advisory locking."
            ));
        } else {
            let error = result.err().expect("ordinary error refuses startup");
            assert_eq!(records[0].level, log::Level::Error);
            assert_eq!(
                error.diagnostic(),
                "I/O failure: application data directory instance lock could not be acquired"
            );
            assert!(matches!(error, Error::Io(error) if error.raw_os_error().is_none()));
        }
    }
}

#[test]
fn instance_lock_is_released_after_child_is_killed() {
    let _capture = crate::error::LogCaptureScope::start();
    const CHILD_ROOT: &str = "CHESSFABLE_INSTANCE_LOCK_CHILD_ROOT";
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        let root = PathBuf::from(root);
        let app_data = AppDataDir::for_test(&root);
        let InstanceAdmission::Owned(_guard) = admit_test_instance(&app_data, &[]).unwrap() else {
            panic!("child must own the instance lock");
        };
        fs::write(root.join("child-ready"), b"ready").unwrap();
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    struct ChildGuard(std::process::Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let mut child = ChildGuard(std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "infra::path_authority::portable_tests::instance_lock_is_released_after_child_is_killed", "--nocapture"])
            .env(CHILD_ROOT, temp.path())
            .spawn().unwrap());
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !temp.path().join("child-ready").exists() && std::time::Instant::now() < deadline {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "child exited before readiness"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        temp.path().join("child-ready").exists(),
        "child did not become ready"
    );
    let app_data = AppDataDir::for_test(temp.path());
    assert!(matches!(
        admit_test_instance(&app_data, &[]).unwrap(),
        InstanceAdmission::HeldElsewhere
    ));
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    assert!(temp.path().join("instance.lock").is_file());
    let _guard = crate::infra::fs::retry_until_lock_released(|| {
        match admit_test_instance(&app_data, &[]).expect("post-crash admission must not fail") {
            InstanceAdmission::Owned(guard) => Some(guard),
            InstanceAdmission::HeldElsewhere => None,
            InstanceAdmission::Unguarded => panic!("post-crash admission must own the lock"),
        }
    })
    .expect("instance lock was not released within the deadline after the child exited");
}

pub(crate) struct EngineImageCleanupFixture {
    _temp: tempfile::TempDir,
    pub(crate) registry: PathBuf,
    pub(crate) authority: PathAuthority,
    pub(crate) app_data: PathBuf,
    pub(crate) image_dir: AuthorizedDir,
    pub(crate) leaf: OsString,
    pub(crate) installed: VerifiedIdentity,
}

impl EngineImageCleanupFixture {
    pub(crate) fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let image_dir = ensure_app_owned_default_dir(
            &AppDataDir::for_test(temp.path()),
            AppOwnedDefaultRoot::EngineImages,
        )
        .unwrap();
        let app_data = image_dir.path().parent().unwrap().to_path_buf();
        let registry = app_data.join("registry.json");
        let authority = PathAuthority::open(registry.clone(), vec![]).unwrap();
        let leaf = OsString::from(uuid::Uuid::new_v4().to_string());
        let (_, installed) = image_dir
            .atomic_replace_leaf_identified(&leaf, |file| {
                file.write_all(b"unregistered image").map_err(Error::from)
            })
            .unwrap();
        Self {
            _temp: temp,
            registry,
            authority,
            app_data,
            image_dir,
            leaf,
            installed,
        }
    }

    pub(crate) fn assert_no_intent(&self) {
        assert!(self.authority.image_cleanup.is_empty());
        assert!(!self.authority.registry_durability_pending);
        assert!(!self.registry.exists());
    }

    pub(crate) fn reload_and_remove(self) {
        drop(self.authority);
        let mut reopened = PathAuthority::open(self.registry.clone(), vec![]).unwrap();
        assert_eq!(reopened.image_cleanup.len(), 1);
        let images = ensure_app_owned_default_dir(
            &AppDataDir::for_test(&self.app_data),
            AppOwnedDefaultRoot::EngineImages,
        )
        .unwrap();
        reopened.cleanup_engine_images(&images, false).unwrap();
        assert!(!images.path().join(&self.leaf).exists());
        drop(reopened);
        assert!(PathAuthority::open(self.registry.clone(), vec![])
            .unwrap()
            .image_cleanup
            .is_empty());
    }

    pub(crate) fn fill_admission_bound(&mut self) {
        let template = StoredEntry {
            id: PathRef::fresh(),
            display_name: UNREGISTERED_ENGINE_IMAGE_DISPLAY_NAME.into(),
            class: PathClass::PersistentFile,
            operations: canonical_operations(EntryPurpose::EngineImage),
            path: NativePath::from_path(&self.image_dir.path().join(&self.leaf)),
            identity: Identity {
                a: self.installed.pair().0,
                b: self.installed.pair().1,
            },
            parent_identity: Some(Identity {
                a: self.image_dir.identity().pair().0,
                b: self.image_dir.identity().pair().1,
            }),
            target_is_dir: false,
            purpose: Some(EntryPurpose::EngineImage),
            practice_key: None,
        };
        for _ in 0..MAX_AUTHORITY_IDS {
            let mut entry = template.clone();
            entry.id = PathRef::fresh();
            self.authority
                .image_cleanup
                .insert(entry.id.id.clone(), entry);
        }
        self.authority.save().unwrap();
    }

    fn sweep_leaf(&self, name: impl Into<OsString>) -> OsString {
        let name = name.into();
        fs::write(self.image_dir.path().join(&name), b"crash orphan").unwrap();
        name
    }

    fn sweep_temp(&self) -> OsString {
        self.sweep_leaf(format!(".atomic-{}", Uuid::new_v4()))
    }
}

#[test]
fn engine_image_cleanup_sweep_removes_uuid_and_atomic_orphans() {
    let mut f = EngineImageCleanupFixture::new();
    let temp = f.sweep_temp();
    f.authority
        .set_engine_image_sweep_root(Some(AppDataDir::for_test(&f.app_data)));
    f.authority
        .cleanup_engine_images(&f.image_dir, false)
        .unwrap();
    assert!(
        !f.image_dir.path().join(&f.leaf).exists(),
        "UUID crash orphan must be swept"
    );
    assert!(
        !f.image_dir.path().join(temp).exists(),
        "atomic crash temp must be swept"
    );
}

#[test]
fn engine_image_cleanup_sweep_preserves_case_renamed_registered_uuid() {
    let mut f = EngineImageCleanupFixture::new();
    let leaf = f.sweep_leaf("abcdefab-cdef-4abc-8def-abcdefabcdef");
    let installed = f.image_dir.open_leaf_identified(&leaf).unwrap();
    let registered = f
        .authority
        .register_engine_image(&f.image_dir, &leaf, installed, "registered".into())
        .unwrap();
    let uppercase = leaf.to_ascii_uppercase();
    assert_ne!(leaf, uppercase);
    fs::rename(
        f.image_dir.path().join(&leaf),
        f.image_dir.path().join(&uppercase),
    )
    .unwrap();
    assert_eq!(
        f.authority.persistent[&registered.path_ref().id]
            .stored
            .path
            .to_path()
            .unwrap(),
        f.image_dir.path().join(&leaf)
    );
    f.authority
        .set_engine_image_sweep_root(Some(AppDataDir::for_test(&f.app_data)));

    f.authority
        .cleanup_engine_images(&f.image_dir, false)
        .unwrap();

    assert!(
        f.image_dir.path().join(&uppercase).is_file(),
        "case-renamed registered UUID image must survive"
    );
    assert_eq!(
        f.image_dir.open_leaf_identified(&uppercase).unwrap().pair(),
        installed.pair()
    );
    assert!(
        !f.image_dir.path().join(&f.leaf).exists(),
        "unreferenced UUID must still be swept"
    );
}

#[test]
fn engine_image_cleanup_empty_intents_retry_durability_then_sweep() {
    let mut f = EngineImageCleanupFixture::new();
    let temp = f.sweep_temp();
    assert!(f.authority.image_cleanup.is_empty());
    f.authority.registry_durability_pending = true;
    f.authority
        .set_engine_image_sweep_root(Some(AppDataDir::for_test(&f.app_data)));

    f.authority
        .cleanup_engine_images(&f.image_dir, false)
        .unwrap();

    assert!(!f.authority.registry_durability_pending);
    assert!(f.registry.is_file(), "retry must persist the registry");
    assert!(
        !f.image_dir.path().join(&f.leaf).exists(),
        "successful retry must sweep the UUID orphan despite empty intents"
    );
    assert!(
        !f.image_dir.path().join(temp).exists(),
        "successful retry must sweep the atomic temp despite empty intents"
    );
}

#[test]
fn engine_image_cleanup_empty_intents_retry_failure_preserves_orphans() {
    use crate::infra::fs::{install_test_atomic_file_injector, ParentSyncFault};
    let mut f = EngineImageCleanupFixture::new();
    let temp = f.sweep_temp();
    assert!(f.authority.image_cleanup.is_empty());
    f.authority.registry_durability_pending = true;
    f.authority
        .set_engine_image_sweep_root(Some(AppDataDir::for_test(&f.app_data)));
    let _guard = install_test_atomic_file_injector(Arc::new(ParentSyncFault(
        "empty-intent retry parent sync failed",
    )));

    let result = f.authority.cleanup_engine_images(&f.image_dir, false);

    assert!(
        matches!(
            result,
            Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::RegistryReplacement
            ))
        ),
        "failed retry must return its registry durability error: {result:?}"
    );
    assert!(f.authority.registry_durability_pending);
    assert!(
        f.image_dir.path().join(&f.leaf).is_file(),
        "failed retry must preserve the UUID orphan"
    );
    assert!(
        f.image_dir.path().join(temp).is_file(),
        "failed retry must preserve the atomic temp"
    );
}

#[test]
fn engine_image_cleanup_sweep_retains_admitted_root_after_path_replacement() {
    let mut f = EngineImageCleanupFixture::new();
    let temp = f.sweep_temp();
    f.authority
        .set_engine_image_sweep_root(Some(AppDataDir::for_test(&f.app_data)));
    // Windows can refuse an ancestor rename while this unused child handle is open.
    // Keep the authority's admitted app-data handle for the sweep's root-binding proof.
    drop(f.image_dir);
    let retained = tempfile::tempdir().unwrap();
    let admitted = retained.path().join("admitted");
    fs::rename(&f.app_data, &admitted).unwrap();
    let foreign_root = AppDataDir::for_test(&f.app_data);
    let foreign_images =
        ensure_app_owned_default_dir(&foreign_root, AppOwnedDefaultRoot::EngineImages).unwrap();
    fs::write(foreign_images.path().join(&f.leaf), b"foreign image").unwrap();
    fs::write(foreign_images.path().join(&temp), b"foreign temp").unwrap();

    f.authority
        .cleanup_engine_images(&foreign_images, false)
        .unwrap();

    assert!(
        foreign_images.path().join(&f.leaf).is_file(),
        "an unlocked profile's UUID image must survive"
    );
    assert!(
        foreign_images.path().join(&temp).is_file(),
        "an unlocked profile's atomic temp must survive"
    );
    let admitted_images = admitted.join(AppOwnedDefaultRoot::EngineImages.leaf());
    assert!(!admitted_images.join(&f.leaf).exists());
    assert!(!admitted_images.join(&temp).exists());
}

#[test]
fn engine_image_cleanup_sweep_directory_derivation_failure_skips_orphans() {
    let mut f = EngineImageCleanupFixture::new();
    let temp = f.sweep_temp();
    f.authority
        .set_engine_image_sweep_root(Some(AppDataDir::for_test(&f.app_data)));
    let retained_images = f.app_data.join("retained-images");
    fs::rename(f.image_dir.path(), &retained_images).unwrap();
    fs::write(f.image_dir.path(), b"directory obstruction").unwrap();
    let category = ensure_app_owned_default_dir(
        f.authority.engine_image_sweep_root.as_ref().unwrap(),
        AppOwnedDefaultRoot::EngineImages,
    )
    .expect_err("obstructed EngineImages child must fail derivation")
    .category();
    let capture = crate::error::LogCaptureScope::start();

    let result = f.authority.cleanup_engine_images(&f.image_dir, false);

    assert!(
        result.is_ok(),
        "directory derivation must skip the sweep: {result:?}"
    );
    assert!(retained_images.join(&f.leaf).is_file());
    assert!(retained_images.join(temp).is_file());
    let records = capture.records();
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0].level, log::Level::Warn);
    assert_eq!(
        records[0].message,
        format!("engine image orphan sweep directory derivation failed: {category}")
    );
}

#[test]
fn engine_image_cleanup_sweep_listed_candidate_preserves_replacement_inode() {
    let f = EngineImageCleanupFixture::new();
    let listed = read_directory_entries_at(
        f.image_dir.directory.as_file(),
        &CancellationToken::new(),
        Some(MAX_ENGINE_IMAGE_SWEEP_ENTRIES),
        &mut |_| true,
    )
    .unwrap()
    .into_iter()
    .find(|entry| entry.name == f.leaf)
    .expect("real orphan inode must be listed");
    let replacement = f.image_dir.path().join(&f.leaf);
    fs::rename(&replacement, f.image_dir.path().join("listed-inode")).unwrap();
    fs::write(&replacement, b"replacement inode").unwrap();
    assert_ne!(
        f.image_dir.open_leaf_identified(&f.leaf).unwrap().pair(),
        listed.identity
    );

    PathAuthority::sweep_engine_image_candidate(&f.image_dir, &BTreeSet::new(), &listed);

    assert!(
        replacement.is_file(),
        "replacement inode must survive the listed/open identity mismatch"
    );
    assert_eq!(fs::read(replacement).unwrap(), b"replacement inode");
    assert!(f.image_dir.path().join("listed-inode").is_file());
}

#[test]
fn engine_image_cleanup_sweep_preserves_persistent_and_retired_leaf_names() {
    for different_parent in [false, true] {
        let mut f = EngineImageCleanupFixture::new();
        let persistent = f
            .authority
            .register_engine_image(&f.image_dir, &f.leaf, f.installed, "persistent".into())
            .unwrap();
        let retired_leaf = f.sweep_leaf(Uuid::new_v4().to_string());
        let retired_identity = f.image_dir.open_leaf_identified(&retired_leaf).unwrap();
        let retired = f
            .authority
            .register_engine_image(
                &f.image_dir,
                &retired_leaf,
                retired_identity,
                "retired".into(),
            )
            .unwrap();
        let entry = f
            .authority
            .persistent
            .remove(&retired.path_ref().id)
            .unwrap();
        f.authority
            .retired_attachments
            .insert(retired.path_ref().id.clone(), entry);
        if different_parent {
            for (id, leaf) in [
                (persistent.path_ref().id.clone(), &f.leaf),
                (retired.path_ref().id.clone(), &retired_leaf),
            ] {
                let entry = f
                    .authority
                    .persistent
                    .get_mut(&id)
                    .or_else(|| f.authority.retired_attachments.get_mut(&id))
                    .unwrap();
                entry.stored.path =
                    NativePath::from_path(&f.app_data.join("different-parent").join(leaf));
            }
        }
        let orphan = f.sweep_leaf(Uuid::new_v4().to_string());
        f.authority
            .set_engine_image_sweep_root(Some(AppDataDir::for_test(&f.app_data)));
        f.authority
            .cleanup_engine_images(&f.image_dir, false)
            .unwrap();
        assert!(f.image_dir.path().join(&f.leaf).is_file());
        assert!(f.image_dir.path().join(retired_leaf).is_file());
        assert!(!f.image_dir.path().join(orphan).exists());
    }
}

#[test]
fn engine_image_cleanup_sweep_follows_successful_intent_walk() {
    let mut f = EngineImageCleanupFixture::new();
    assert_eq!(
        f.authority
            .record_engine_image_cleanup(&f.image_dir, &f.leaf, f.installed)
            .diagnostic(),
        "recorded"
    );
    let temp = f.sweep_temp();
    f.authority
        .set_engine_image_sweep_root(Some(AppDataDir::for_test(&f.app_data)));
    f.authority
        .cleanup_engine_images(&f.image_dir, false)
        .unwrap();
    assert!(f.authority.image_cleanup.is_empty());
    assert!(!f.image_dir.path().join(&f.leaf).exists());
    assert!(!f.image_dir.path().join(temp).exists());
}

#[test]
fn engine_image_cleanup_sweep_waits_for_issuance_lease() {
    let mut f = EngineImageCleanupFixture::new();
    let temp = f.sweep_temp();
    f.authority
        .set_engine_image_sweep_root(Some(AppDataDir::for_test(&f.app_data)));
    let lease = f.authority.begin_engine_image_issuance().unwrap();
    f.authority
        .cleanup_engine_images(&f.image_dir, false)
        .unwrap();
    assert!(f.image_dir.path().join(&f.leaf).is_file());
    assert!(f.image_dir.path().join(&temp).is_file());
    drop(lease);
    f.authority
        .cleanup_engine_images(&f.image_dir, false)
        .unwrap();
    assert!(!f.image_dir.path().join(&f.leaf).exists());
    assert!(!f.image_dir.path().join(temp).exists());
}

#[test]
fn engine_image_cleanup_sweep_requires_permission() {
    let mut f = EngineImageCleanupFixture::new();
    let temp = f.sweep_temp();
    f.authority
        .cleanup_engine_images(&f.image_dir, false)
        .unwrap();
    assert!(f.image_dir.path().join(&f.leaf).is_file());
    assert!(f.image_dir.path().join(temp).is_file());
}

#[test]
fn engine_image_cleanup_sweep_preserves_nonregular_and_unrelated_names() {
    let mut f = EngineImageCleanupFixture::new();
    let directory = f
        .image_dir
        .path()
        .join(format!(".atomic-{}", Uuid::new_v4()));
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("child"), b"preserve child").unwrap();
    let target = f.app_data.join("link-target");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("child"), b"preserve target").unwrap();
    let link = f.image_dir.path().join(Uuid::new_v4().to_string());
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link).unwrap();
    #[cfg(windows)]
    crate::infra::fs::windows_test_junction(&link, &target);
    let unrelated = [
        f.sweep_leaf("unrelated"),
        f.sweep_leaf(".atomic-not-a-uuid"),
        f.sweep_leaf(format!(".other-{}", Uuid::new_v4())),
    ];
    f.authority
        .set_engine_image_sweep_root(Some(AppDataDir::for_test(&f.app_data)));
    f.authority
        .cleanup_engine_images(&f.image_dir, false)
        .unwrap();
    assert!(directory.is_dir());
    assert_eq!(
        fs::read(directory.join("child")).unwrap(),
        b"preserve child"
    );
    assert!(fs::symlink_metadata(&link).is_ok());
    assert_eq!(fs::read(target.join("child")).unwrap(), b"preserve target");
    for leaf in unrelated {
        assert!(f.image_dir.path().join(leaf).is_file());
    }
    assert!(!f.image_dir.path().join(&f.leaf).exists());
}

#[test]
fn engine_image_cleanup_sweep_removes_4097_orphans() {
    let mut f = EngineImageCleanupFixture::new();
    for _ in 1..4097 {
        f.sweep_leaf(Uuid::new_v4().to_string());
    }
    assert_eq!(fs::read_dir(f.image_dir.path()).unwrap().count(), 4097);
    f.authority
        .set_engine_image_sweep_root(Some(AppDataDir::for_test(&f.app_data)));
    f.authority
        .cleanup_engine_images(&f.image_dir, false)
        .unwrap();
    assert_eq!(fs::read_dir(f.image_dir.path()).unwrap().count(), 0);
}

#[test]
fn engine_image_cleanup_sweep_listing_overflow_deletes_nothing() {
    let mut f = EngineImageCleanupFixture::new();
    for index in 1..8193 {
        f.sweep_leaf(format!("unrelated-{index}"));
    }
    f.authority
        .set_engine_image_sweep_root(Some(AppDataDir::for_test(&f.app_data)));
    f.authority
        .cleanup_engine_images(&f.image_dir, false)
        .unwrap();
    assert_eq!(fs::read_dir(f.image_dir.path()).unwrap().count(), 8193);
    assert!(f.image_dir.path().join(&f.leaf).is_file());
}

#[cfg(unix)]
struct FailFirstImageRemovals(AtomicUsize);

#[cfg(unix)]
impl crate::infra::fs::RemovalInjector for FailFirstImageRemovals {
    fn inject(&self, point: crate::infra::fs::RemovalFaultPoint) -> std::io::Result<Option<u64>> {
        if point == crate::infra::fs::RemovalFaultPoint::BeforeTopOpen
            && self
                .0
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                    left.checked_sub(1)
                })
                .is_ok()
        {
            return Err(std::io::Error::other(
                "injected one-shot image removal failure",
            ));
        }
        Ok(None)
    }
}

#[cfg(unix)]
#[test]
fn engine_image_cleanup_sweep_continues_after_two_removal_errors() {
    let mut f = EngineImageCleanupFixture::new();
    let leaves = [
        f.leaf.clone(),
        f.sweep_leaf(Uuid::new_v4().to_string()),
        f.sweep_leaf(Uuid::new_v4().to_string()),
    ];
    f.authority
        .set_engine_image_sweep_root(Some(AppDataDir::for_test(&f.app_data)));
    let _guard = crate::infra::fs::scoped_test_removal_injector(Arc::new(FailFirstImageRemovals(
        AtomicUsize::new(2),
    )));
    f.authority
        .cleanup_engine_images(&f.image_dir, false)
        .unwrap();
    assert_eq!(
        leaves
            .iter()
            .filter(|leaf| f.image_dir.path().join(leaf).is_file())
            .count(),
        2
    );
}

#[cfg(windows)]
#[test]
fn engine_image_cleanup_sweep_windows_sharing_failure_is_nonfatal() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
    let mut f = EngineImageCleanupFixture::new();
    let free = f.sweep_leaf(Uuid::new_v4().to_string());
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(f.image_dir.path().join(&f.leaf))
        .unwrap();
    f.authority
        .set_engine_image_sweep_root(Some(AppDataDir::for_test(&f.app_data)));
    f.authority
        .cleanup_engine_images(&f.image_dir, false)
        .unwrap();
    assert!(f.image_dir.path().join(&f.leaf).is_file());
    assert!(!f.image_dir.path().join(free).exists());
    drop(held);
}

#[test]
fn engine_image_cleanup_sweep_unreadable_reference_deletes_nothing() {
    #[cfg(unix)]
    let foreign = NativePath::Windows {
        utf16: vec![67, 58, 92],
    };
    #[cfg(windows)]
    let foreign = NativePath::Unix {
        bytes: String::new(),
    };
    let root = EngineImageCleanupFixture::new()
        .app_data
        .ancestors()
        .last()
        .unwrap()
        .to_path_buf();
    for path in [foreign, NativePath::from_path(&root)] {
        let mut f = EngineImageCleanupFixture::new();
        let handle = f
            .authority
            .register_engine_image(&f.image_dir, &f.leaf, f.installed, "reference".into())
            .unwrap();
        f.authority
            .persistent
            .get_mut(&handle.path_ref().id)
            .unwrap()
            .stored
            .path = path;
        let orphan = f.sweep_leaf(Uuid::new_v4().to_string());
        f.authority
            .set_engine_image_sweep_root(Some(AppDataDir::for_test(&f.app_data)));
        f.authority
            .cleanup_engine_images(&f.image_dir, false)
            .unwrap();
        assert!(f.image_dir.path().join(&f.leaf).is_file());
        assert!(f.image_dir.path().join(orphan).is_file());
    }
}

#[test]
fn engine_image_cleanup_sweep_intent_error_skips_orphans() {
    let mut f = EngineImageCleanupFixture::new();
    assert_eq!(
        f.authority
            .record_engine_image_cleanup(&f.image_dir, &f.leaf, f.installed)
            .diagnostic(),
        "recorded"
    );
    let orphan = OsString::from(Uuid::new_v4().to_string());
    // Atomic creation grants this orphan its own DELETE right on Windows, independently
    // of the parent DACL that the fixture restricts below.
    let _ = f
        .image_dir
        .atomic_replace_leaf_identified(&orphan, |file| {
            file.write_all(b"separate orphan").map_err(Error::from)
        })
        .unwrap();
    f.authority
        .set_engine_image_sweep_root(Some(AppDataDir::for_test(&f.app_data)));
    #[cfg(unix)]
    let _guard = crate::infra::fs::scoped_test_removal_injector(Arc::new(FailFirstImageRemovals(
        AtomicUsize::new(1),
    )));
    #[cfg(windows)]
    let mut parent_acl = crate::infra::fs::TestTargetSecurityGuard::restrict(
        f.image_dir.path(),
        windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS
            & !windows_sys::Win32::Storage::FileSystem::FILE_DELETE_CHILD,
    )
    .unwrap();
    #[cfg(windows)]
    let mut leaf_acl = crate::infra::fs::TestTargetSecurityGuard::restrict(
        &f.image_dir.path().join(&f.leaf),
        windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE
            | windows_sys::Win32::Foundation::GENERIC_READ
            | windows_sys::Win32::Storage::FileSystem::READ_CONTROL,
    )
    .unwrap();
    let result = f.authority.cleanup_engine_images(&f.image_dir, false);
    #[cfg(windows)]
    {
        let leaf_restore = leaf_acl.restore();
        let parent_restore = parent_acl.restore();
        leaf_restore.expect("intent leaf DACL must be restored");
        parent_restore.expect("image directory DACL must be restored");
    }
    assert!(matches!(result, Err(Error::Io(_))), "{result:?}");
    assert!(f.image_dir.path().join(&f.leaf).is_file());
    assert!(f.image_dir.path().join(orphan).is_file());
    assert_eq!(f.authority.image_cleanup.len(), 1);
}

#[test]
fn engine_image_cleanup_intent_persists_reloads_and_removes() {
    let mut f = EngineImageCleanupFixture::new();
    assert_eq!(
        f.authority
            .record_engine_image_cleanup(&f.image_dir, &f.leaf, f.installed)
            .diagnostic(),
        "recorded"
    );
    let stored = f.authority.image_cleanup.values().next().unwrap();
    assert_eq!(stored.display_name, UNREGISTERED_ENGINE_IMAGE_DISPLAY_NAME);
    assert_eq!(
        stored.parent_identity,
        Some(Identity {
            a: f.image_dir.identity().pair().0,
            b: f.image_dir.identity().pair().1
        })
    );
    f.reload_and_remove();
}

#[test]
fn engine_image_cleanup_intent_is_allowed_while_sealed() {
    let mut f = EngineImageCleanupFixture::new();
    f.authority.seal_engine_attachments();
    assert_eq!(
        f.authority
            .record_engine_image_cleanup(&f.image_dir, &f.leaf, f.installed)
            .diagnostic(),
        "recorded"
    );
    f.reload_and_remove();
}

#[test]
fn engine_image_cleanup_intent_write_failure_is_retained_and_cleanup_persists() {
    let mut f = EngineImageCleanupFixture::new();
    let outcome =
        f.authority
            .record_engine_image_cleanup_with(&f.image_dir, &f.leaf, f.installed, |_, _| {
                Err(Error::Io(Box::new(std::io::Error::other(
                    "registry write failed",
                ))))
            });
    assert!(outcome
        .diagnostic()
        .contains("not recorded, retained in memory: I/O failure: registry write failed"));
    assert_eq!(f.authority.image_cleanup.len(), 1);
    assert!(f.authority.registry_durability_pending);
    assert!(!f.registry.exists());
    assert!(f.image_dir.path().join(&f.leaf).is_file());
    f.authority
        .cleanup_engine_images(&f.image_dir, false)
        .unwrap();
    assert!(!f.image_dir.path().join(&f.leaf).exists());
    assert!(!f.authority.registry_durability_pending);
    assert!(PathAuthority::open(f.registry.clone(), vec![])
        .unwrap()
        .image_cleanup
        .is_empty());
}

#[test]
fn engine_image_cleanup_intent_uncertain_write_is_committed_and_pending() {
    let mut f = EngineImageCleanupFixture::new();
    let outcome = f.authority.record_engine_image_cleanup_with(
        &f.image_dir,
        &f.leaf,
        f.installed,
        |target, write| {
            assert!(matches!(
                atomic_replace(target, write)?,
                AtomicFileOutcome::DurableCommit
            ));
            Ok(AtomicFileOutcome::CommittedDurabilityUncertain(
                std::io::Error::other("registry parent sync failed"),
            ))
        },
    );
    assert_eq!(outcome.diagnostic(), "recorded, durability uncertain");
    assert_eq!(f.authority.image_cleanup.len(), 1);
    assert!(f.authority.registry_durability_pending);
    f.reload_and_remove();
}

#[test]
fn engine_image_cleanup_intent_admission_refusal_restores_state_and_disk() {
    let mut f = EngineImageCleanupFixture::new();
    f.fill_admission_bound();
    let before = f.authority.image_cleanup.clone();
    let bytes = fs::read(&f.registry).unwrap();
    let outcome =
        f.authority
            .record_engine_image_cleanup_with(&f.image_dir, &f.leaf, f.installed, |_, _| {
                panic!("admission must refuse before writing")
            });
    assert!(outcome
        .diagnostic()
        .contains("not recorded: Resource limit: path registry identifier limit reached"));
    assert_eq!(f.authority.image_cleanup, before);
    assert_eq!(fs::read(&f.registry).unwrap(), bytes);
    assert!(!f.authority.registry_durability_pending);
    assert!(f.image_dir.path().join(&f.leaf).is_file());
}

#[test]
fn engine_image_cleanup_intent_invalid_leaf_has_no_side_effects() {
    let mut f = EngineImageCleanupFixture::new();
    for leaf in [
        "not-a-uuid",
        "00000000-0000-0000-0000-000000000000/child",
        "../00000000-0000-0000-0000-000000000000",
    ] {
        let outcome =
            f.authority
                .record_engine_image_cleanup(&f.image_dir, OsStr::new(leaf), f.installed);
        assert!(outcome.diagnostic().starts_with("not recorded:"));
        f.assert_no_intent();
    }
}

#[cfg(unix)]
#[test]
fn engine_image_cleanup_retained_intent_retries_persistence_when_removal_still_fails() {
    use crate::infra::fs::{scoped_test_removal_injector, RemovalFault, RemovalFaultPoint};
    let mut f = EngineImageCleanupFixture::new();
    let outcome =
        f.authority
            .record_engine_image_cleanup_with(&f.image_dir, &f.leaf, f.installed, |_, _| {
                Err(Error::Io(Box::new(std::io::Error::other(
                    "registry write failed",
                ))))
            });
    assert!(matches!(outcome, EngineImageCleanupIntent::Retained(_)));
    let guard =
        scoped_test_removal_injector(Arc::new(RemovalFault(RemovalFaultPoint::BeforeTopOpen)));
    let error = f
        .authority
        .cleanup_engine_images(&f.image_dir, true)
        .unwrap_err();
    assert!(error.diagnostic().contains("injected removal failure"));
    assert!(!f.authority.registry_durability_pending);
    assert!(f.image_dir.path().join(&f.leaf).is_file());
    assert_eq!(
        PathAuthority::open(f.registry.clone(), vec![])
            .unwrap()
            .image_cleanup
            .len(),
        1
    );
    drop(guard);
    f.reload_and_remove();
}

#[cfg(unix)]
#[test]
fn engine_image_cleanup_changed_set_write_failure_preserves_both_causes_and_intents() {
    use crate::infra::fs::{
        install_test_atomic_file_injector, scoped_test_removal_injector, AtomicFileFaultPoint,
        CancelAtomicFileAt, RemovalFault, RemovalFaultPoint,
    };
    let mut f = EngineImageCleanupFixture::new();
    let missing_leaf = OsString::from(uuid::Uuid::new_v4().to_string());
    let (_, missing_identity) = f
        .image_dir
        .atomic_replace_leaf_identified(&missing_leaf, |file| {
            file.write_all(b"missing image").map_err(Error::from)
        })
        .unwrap();
    for (leaf, identity) in [(&missing_leaf, missing_identity), (&f.leaf, f.installed)] {
        assert_eq!(
            f.authority
                .record_engine_image_cleanup(&f.image_dir, leaf, identity)
                .diagnostic(),
            "recorded"
        );
    }
    let intents = f.authority.image_cleanup.clone();
    assert_eq!(intents.len(), 2);
    fs::remove_file(f.image_dir.path().join(&missing_leaf)).unwrap();

    let _removal_guard =
        scoped_test_removal_injector(Arc::new(RemovalFault(RemovalFaultPoint::BeforeTopOpen)));
    let _write_guard = install_test_atomic_file_injector(Arc::new(CancelAtomicFileAt {
        cancel_at: AtomicFileFaultPoint::Cleanup,
        fail_at: Some(AtomicFileFaultPoint::Write),
        cancellation: tokio_util::sync::CancellationToken::new(),
    }));
    let error = f
        .authority
        .cleanup_engine_images(&f.image_dir, false)
        .unwrap_err();
    assert!(matches!(error, Error::OperationAndCleanup { .. }));
    let diagnostic = error.diagnostic();
    assert!(
        diagnostic.contains("injected Write failure"),
        "{diagnostic}"
    );
    assert!(
        diagnostic.contains("injected removal failure"),
        "{diagnostic}"
    );
    assert_eq!(f.authority.image_cleanup, intents);
    assert!(f.image_dir.path().join(&f.leaf).is_file());
}

#[cfg(unix)]
fn assert_engine_image_cleanup_retry_failure(
    injector: Arc<dyn crate::infra::fs::AtomicWriterInjector + Send + Sync>,
    registry_diagnostic: &str,
    persisted: bool,
) {
    use crate::infra::fs::{
        install_test_atomic_file_injector, scoped_test_removal_injector, AtomicFileFaultPoint,
        CancelAtomicFileAt, RemovalFault, RemovalFaultPoint,
    };
    let mut f = EngineImageCleanupFixture::new();
    let initial_guard = install_test_atomic_file_injector(Arc::new(CancelAtomicFileAt {
        cancel_at: AtomicFileFaultPoint::Cleanup,
        fail_at: Some(AtomicFileFaultPoint::Write),
        cancellation: tokio_util::sync::CancellationToken::new(),
    }));
    let outcome = f
        .authority
        .record_engine_image_cleanup(&f.image_dir, &f.leaf, f.installed);
    assert!(matches!(outcome, EngineImageCleanupIntent::Retained(_)));
    drop(initial_guard);
    let intent = f.authority.image_cleanup.clone();
    assert_eq!(intent.len(), 1);
    assert!(f.authority.registry_durability_pending);
    assert!(!f.registry.exists());

    let removal_guard =
        scoped_test_removal_injector(Arc::new(RemovalFault(RemovalFaultPoint::BeforeTopOpen)));
    let retry_guard = install_test_atomic_file_injector(injector);
    let error = f
        .authority
        .cleanup_engine_images(&f.image_dir, true)
        .unwrap_err();
    let Error::OperationAndCleanup { primary, cleanup } = &error else {
        panic!("expected composed cleanup error: {}", error.diagnostic());
    };
    assert!(primary.contains(registry_diagnostic), "{primary}");
    assert!(cleanup.contains("injected removal failure"), "{cleanup}");
    let diagnostic = error.diagnostic();
    assert!(diagnostic.contains(registry_diagnostic), "{diagnostic}");
    assert!(
        diagnostic.contains("injected removal failure"),
        "{diagnostic}"
    );
    assert!(f.authority.registry_durability_pending);
    assert_eq!(f.authority.image_cleanup, intent);
    assert!(f.image_dir.path().join(&f.leaf).is_file());
    drop(retry_guard);
    drop(removal_guard);
    if persisted {
        assert_eq!(
            PathAuthority::open(f.registry.clone(), vec![])
                .unwrap()
                .image_cleanup,
            intent
        );
        f.reload_and_remove();
    } else {
        assert!(!f.registry.exists());
    }
}

#[cfg(unix)]
#[test]
fn engine_image_cleanup_retained_intent_retry_write_failure_preserves_both_causes() {
    use crate::infra::fs::{AtomicFileFaultPoint, CancelAtomicFileAt};
    assert_engine_image_cleanup_retry_failure(
        Arc::new(CancelAtomicFileAt {
            cancel_at: AtomicFileFaultPoint::Cleanup,
            fail_at: Some(AtomicFileFaultPoint::Write),
            cancellation: tokio_util::sync::CancellationToken::new(),
        }),
        "injected Write failure",
        false,
    );
}

#[cfg(unix)]
#[test]
fn engine_image_cleanup_retained_intent_retry_uncertainty_preserves_both_causes() {
    assert_engine_image_cleanup_retry_failure(
        Arc::new(crate::infra::fs::ParentSyncFault(
            "registry retry parent sync failed",
        )),
        "registry replacement",
        true,
    );
}

#[cfg(unix)]
pub(crate) fn reload_with_undecodable_root(registry_path: &Path) -> PathAuthority {
    let mut registry: Registry = serde_json::from_slice(&fs::read(registry_path).unwrap()).unwrap();
    assert_eq!(registry.entries.len(), 1);
    registry.entries[0].path = NativePath::Unix {
        bytes: "!invalid-base64!".into(),
    };
    super::tests::write_registry(registry_path, &registry);
    PathAuthority::open(registry_path.to_path_buf(), vec![]).unwrap()
}

pub(super) fn get_or_create_app_owned_test_root(
    path_authority: &mut PathAuthority,
    root: AppOwnedDefaultRoot,
    directory: &AuthorizedDir,
    expected_identity: VerifiedIdentity,
) -> Result<PathRef, Error> {
    match root {
        AppOwnedDefaultRoot::Databases => path_authority
            .get_or_create_database_root(directory.path(), "Databases", Some(expected_identity))
            .map(|handle| handle.path_ref().clone()),
        AppOwnedDefaultRoot::Engines => path_authority
            .get_or_create_engine_root(directory.path(), "Engines", Some(expected_identity))
            .map(|handle| handle.path_ref().clone()),
        AppOwnedDefaultRoot::Puzzles => path_authority
            .get_or_create_puzzle_root(directory.path(), "Puzzles", Some(expected_identity))
            .map(|handle| handle.path_ref().clone()),
        AppOwnedDefaultRoot::Collections
        | AppOwnedDefaultRoot::EngineImages
        | AppOwnedDefaultRoot::Credentials
        | AppOwnedDefaultRoot::Practice
        | AppOwnedDefaultRoot::UnsavedGames => {
            panic!(
                    "engine images, credentials, practice and unsaved games do not have a persistent root entry"
                )
        }
        #[cfg(target_os = "macos")]
        AppOwnedDefaultRoot::EngineLaunch => {
            panic!("engine launch does not have a persistent root entry")
        }
    }
}

pub(super) fn set_active_app_owned_test_root(
    path_authority: &mut PathAuthority,
    root: AppOwnedDefaultRoot,
    id: &PathRef,
) {
    match root {
        AppOwnedDefaultRoot::Databases => path_authority
            .set_active_database_root(&DatabaseRootHandle::new(id.clone()))
            .unwrap(),
        AppOwnedDefaultRoot::Engines => path_authority
            .set_active_engine_root(&EngineRootHandle::new(id.clone()))
            .unwrap(),
        AppOwnedDefaultRoot::Puzzles => path_authority
            .set_active_puzzle_root(&PuzzleRootHandle::new(id.clone()))
            .unwrap(),
        AppOwnedDefaultRoot::Collections
        | AppOwnedDefaultRoot::EngineImages
        | AppOwnedDefaultRoot::Credentials
        | AppOwnedDefaultRoot::Practice
        | AppOwnedDefaultRoot::UnsavedGames => {
            panic!(
                    "engine images, credentials, practice and unsaved games do not have a persistent root entry"
                )
        }
        #[cfg(target_os = "macos")]
        AppOwnedDefaultRoot::EngineLaunch => {
            panic!("engine launch does not have a persistent root entry")
        }
    }
}

pub(super) fn active_app_owned_test_root(
    path_authority: &mut PathAuthority,
    root: AppOwnedDefaultRoot,
) -> Result<Option<PathRef>, Error> {
    match root {
        AppOwnedDefaultRoot::Databases => path_authority
            .active_database_root()
            .map(|root| root.map(|root| root.path_ref().clone())),
        AppOwnedDefaultRoot::Engines => path_authority
            .active_engine_root()
            .map(|root| root.map(|root| root.path_ref().clone())),
        AppOwnedDefaultRoot::Puzzles => path_authority
            .active_puzzle_root()
            .map(|root| root.map(|root| root.root.path_ref().clone())),
        AppOwnedDefaultRoot::Collections
        | AppOwnedDefaultRoot::EngineImages
        | AppOwnedDefaultRoot::Credentials
        | AppOwnedDefaultRoot::Practice
        | AppOwnedDefaultRoot::UnsavedGames => {
            panic!(
                    "engine images, credentials, practice and unsaved games do not have a persistent root entry"
                )
        }
        #[cfg(target_os = "macos")]
        AppOwnedDefaultRoot::EngineLaunch => {
            panic!("engine launch does not have a persistent root entry")
        }
    }
}

pub(crate) fn assert_workspace_body_refuses_unusable_selections_without_defaults(
    domain: AppOwnedDefaultRoot,
    body: impl Fn(
        &crate::infra::path_authority::SharedPathAuthority,
        &dyn Fn() -> Result<AppDataDir, Error>,
    ) -> Result<PathRef, Error>,
) {
    use crate::error::RootFailure;

    let leaf = APP_OWNED_DEFAULT_ROOT_LEAVES
        .iter()
        .find(|(root, _)| *root == domain)
        .unwrap()
        .1;
    for reason in [
        RootFailure::Missing,
        RootFailure::Changed,
        #[cfg(unix)]
        RootFailure::Unusable,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let selected_path = dir.path().join("selected");
        let app_path = dir.path().join("app-data");
        fs::create_dir(&selected_path).unwrap();
        fs::create_dir(&app_path).unwrap();
        let registry = dir.path().join("registry.json");
        let mut authority = PathAuthority::open(registry.clone(), vec![]).unwrap();
        // None stores the acquired spelling, as the pickers do; Some keeps the caller's
        // spelling, which on Windows is the temp directory's 8.3 short form.
        let id = match domain {
            AppOwnedDefaultRoot::Databases => authority
                .get_or_create_database_root(&selected_path, "Selected", None)
                .map(|handle| handle.path_ref().clone()),
            AppOwnedDefaultRoot::Engines => authority
                .get_or_create_engine_root(&selected_path, "Selected", None)
                .map(|handle| handle.path_ref().clone()),
            AppOwnedDefaultRoot::Puzzles => authority
                .get_or_create_puzzle_root(&selected_path, "Selected", None)
                .map(|handle| handle.path_ref().clone()),
            _ => unreachable!(),
        }
        .unwrap();
        set_active_app_owned_test_root(&mut authority, domain, &id);
        match reason {
            RootFailure::Missing => fs::remove_dir(&selected_path).unwrap(),
            RootFailure::Changed => {
                fs::rename(&selected_path, dir.path().join("moved")).unwrap();
                fs::create_dir(&selected_path).unwrap();
            }
            #[cfg(unix)]
            RootFailure::Unusable => authority = reload_with_undecodable_root(&registry),
            _ => unreachable!(),
        }
        let before = fs::read(&registry).unwrap();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(authority);
        let looked_up = std::cell::Cell::new(false);
        let lookup = || {
            looked_up.set(true);
            Ok(AppDataDir::for_test(&app_path))
        };
        let error = body(&authority, &lookup).unwrap_err();
        assert_eq!(error.root_failure(), Some(reason), "{domain:?}: {reason:?}");
        assert!(!looked_up.get(), "{domain:?}: {reason:?}");
        assert!(!app_path.join(leaf).exists(), "{domain:?}: {reason:?}");
        assert_eq!(
            fs::read(&registry).unwrap(),
            before,
            "{domain:?}: {reason:?}"
        );
    }
}

pub(crate) fn assert_workspace_body_defaults_only_without_a_selection(
    domain: AppOwnedDefaultRoot,
    body: impl FnOnce(
        &crate::infra::path_authority::SharedPathAuthority,
        &dyn Fn() -> Result<AppDataDir, Error>,
    ) -> Result<PathRef, Error>,
) {
    let dir = tempfile::tempdir().unwrap();
    let app_path = dir.path().join("app-data");
    fs::create_dir(&app_path).unwrap();
    let authority = crate::infra::path_authority::SharedPathAuthority::installed(
        PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap(),
    );
    let id = body(&authority, &|| Ok(AppDataDir::for_test(&app_path))).unwrap();
    let leaf = APP_OWNED_DEFAULT_ROOT_LEAVES
        .iter()
        .find(|(root, _)| *root == domain)
        .unwrap()
        .1;
    assert!(app_path.join(leaf).is_dir(), "{domain:?}");
    let selected = active_app_owned_test_root(
        authority.raw_for_test().lock().unwrap().as_mut().unwrap(),
        domain,
    )
    .unwrap()
    .unwrap();
    assert_eq!(selected, id, "{domain:?}");
}

#[test]
fn active_roots_refuse_missing_and_changed_selections_and_recover_without_writing() {
    use crate::error::RootFailure;
    for domain in [
        AppOwnedDefaultRoot::Databases,
        AppOwnedDefaultRoot::Engines,
        AppOwnedDefaultRoot::Puzzles,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
        assert_eq!(
            active_app_owned_test_root(&mut authority, domain).unwrap(),
            None
        );
        let directory =
            ensure_app_owned_default_dir(&AppDataDir::for_test(dir.path()), domain).unwrap();
        let id = get_or_create_app_owned_test_root(
            &mut authority,
            domain,
            &directory,
            directory.identity(),
        )
        .unwrap();
        set_active_app_owned_test_root(&mut authority, domain, &id);
        let registry = dir.path().join("registry.json");
        let before = fs::read(&registry).unwrap();
        let modified = fs::metadata(&registry).unwrap().modified().unwrap();
        assert_eq!(
            active_app_owned_test_root(&mut authority, domain).unwrap(),
            Some(id.clone())
        );

        let moved = dir.path().join("moved");
        fs::rename(directory.path(), &moved).unwrap();
        assert_eq!(
            active_app_owned_test_root(&mut authority, domain)
                .unwrap_err()
                .root_failure(),
            Some(RootFailure::Missing)
        );
        fs::rename(&moved, directory.path()).unwrap();
        assert_eq!(
            active_app_owned_test_root(&mut authority, domain).unwrap(),
            Some(id.clone())
        );
        fs::rename(directory.path(), &moved).unwrap();
        fs::create_dir(directory.path()).unwrap();
        assert_eq!(
            active_app_owned_test_root(&mut authority, domain)
                .unwrap_err()
                .root_failure(),
            Some(RootFailure::Changed)
        );
        let active = match domain {
            AppOwnedDefaultRoot::Databases => &authority.active_database_root,
            AppOwnedDefaultRoot::Engines => &authority.active_engine_root,
            AppOwnedDefaultRoot::Puzzles => &authority.active_puzzle_root,
            _ => unreachable!(),
        };
        assert_eq!(active, &Some(id));
        assert_eq!(fs::read(&registry).unwrap(), before);
        assert_eq!(
            fs::metadata(&registry).unwrap().modified().unwrap(),
            modified
        );
    }
}
fn assert_app_data_acquisition_missing_entry(
    source: Error,
    missing: bool,
    category: crate::error::ErrorCategory,
) {
    let result = app_data_acquisition_failure(source);
    assert_eq!(result.is_missing_entry(), missing);
    assert_eq!(result.category(), category);
    assert_eq!(
        result.diagnostic(),
        "I/O failure: application data directory could not be acquired"
    );
    assert!(matches!(result, Error::Io(error) if error.raw_os_error().is_none()));
}

#[test]
fn app_data_acquisition_missing_entry_conflict_is_sanitized_io() {
    assert_app_data_acquisition_missing_entry(
        Error::Conflict("native path was replaced".into()),
        false,
        crate::error::ErrorCategory::Io,
    );
}

#[test]
fn app_data_acquisition_missing_entry_preserves_native_classification() {
    use crate::error::ErrorCategory;
    #[cfg(unix)]
    let cases = [
        (libc::ENOENT, true, ErrorCategory::MissingResource),
        (libc::EACCES, false, ErrorCategory::Permission),
    ];
    #[cfg(windows)]
    let cases = {
        use windows_sys::Win32::Foundation::{ERROR_BAD_NETPATH, ERROR_FILE_NOT_FOUND};
        [
            (ERROR_BAD_NETPATH as i32, false, ErrorCategory::Io),
            (
                ERROR_FILE_NOT_FOUND as i32,
                true,
                ErrorCategory::MissingResource,
            ),
        ]
    };
    for (code, missing, category) in cases {
        assert_app_data_acquisition_missing_entry(
            std::io::Error::from_raw_os_error(code).into(),
            missing,
            category,
        );
    }
}

fn root_failure_database_fixture() -> (
    tempfile::TempDir,
    crate::infra::path_authority::SharedPathAuthority,
    DatabaseRootHandle,
    PathBuf,
) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("databases");
    fs::create_dir(&root).unwrap();
    let mut authority = PathAuthority::open_with_clock(
        directory.path().join("registry.json"),
        vec![],
        Arc::new(SystemClock),
        2,
    )
    .unwrap();
    let handle = authority
        .get_or_create_database_root(&root, "Databases", None)
        .unwrap();
    (
        directory,
        crate::infra::path_authority::SharedPathAuthority::installed(authority),
        handle,
        root,
    )
}

#[test]
fn root_failure_database_child_replaced_during_listing_is_unlabelled() {
    let (directory, registry, handle, root) = root_failure_database_fixture();
    let child = root.join("child.db3");
    fs::write(&child, b"old").unwrap();
    let saved = directory.path().join("old.db3");
    DATABASE_CHILD_POST_RESOLVE_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            fs::rename(&child, saved).unwrap();
            fs::write(&child, b"new").unwrap();
        }));
    });
    let error = crate::workspace_commands::list_workspace_databases_blocking(
        &registry,
        handle,
        &CancellationToken::new(),
    )
    .unwrap_err();
    assert_eq!(error.root_failure(), None);
    assert_eq!(error.category(), crate::error::ErrorCategory::Conflict);
    assert_eq!(
        error.to_string(),
        format!("Conflict: {VERIFIED_REGISTRATION_CONFLICT}")
    );
}

// Enumeration and the resolved child's parent retain the root without delete sharing.
#[cfg(unix)]
#[test]
fn root_failure_database_root_swap_or_removal_first_seen_in_child_keeps_original_message() {
    for replace in [false, true] {
        let (directory, registry, handle, root) = root_failure_database_fixture();
        fs::write(root.join("child.db3"), b"old").unwrap();
        let saved = directory.path().join("old-root");
        DATABASE_CHILD_POST_RESOLVE_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                fs::rename(&root, saved).unwrap();
                if replace {
                    fs::create_dir(&root).unwrap();
                }
            }));
        });
        let error = crate::workspace_commands::list_workspace_databases_blocking(
            &registry,
            handle,
            &CancellationToken::new(),
        )
        .unwrap_err();
        assert_eq!(
            error.root_failure(),
            Some(if replace {
                crate::error::RootFailure::Changed
            } else {
                crate::error::RootFailure::Missing
            }),
            "{error:?}"
        );
        assert_eq!(
            error.category(),
            if replace {
                crate::error::ErrorCategory::Conflict
            } else {
                crate::error::ErrorCategory::MissingResource
            }
        );
        assert_eq!(
            error.to_string(),
            if replace {
                "Conflict: workspace is unavailable because its root changed"
            } else {
                "I/O failure"
            }
        );
    }
}

#[test]
fn root_failure_database_root_removed_or_replaced_before_listing_keeps_original_error() {
    for replace in [false, true] {
        let (directory, registry, handle, root) = root_failure_database_fixture();
        fs::write(root.join("child.db3"), b"old").unwrap();
        // Registration retains identity, not an OS handle: both mutations are portable.
        fs::rename(&root, directory.path().join("old-root")).unwrap();
        if replace {
            fs::create_dir(&root).unwrap();
        }
        let original = registry
            .raw_for_test()
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .list_database_children_cancellable(&handle, &CancellationToken::new())
            .unwrap_err();
        assert_eq!(original.root_failure(), None);
        let error = crate::workspace_commands::list_workspace_databases_blocking(
            &registry,
            handle,
            &CancellationToken::new(),
        )
        .unwrap_err();
        assert_eq!(
            error.root_failure(),
            Some(if replace {
                crate::error::RootFailure::Changed
            } else {
                crate::error::RootFailure::Missing
            })
        );
        assert_eq!(error.category(), original.category());
        assert_eq!(error.to_string(), original.to_string());
        assert_eq!(error.diagnostic(), original.diagnostic());
        assert_eq!(
            error.to_string(),
            if replace {
                "Conflict: path authority is unavailable because its object changed"
            } else {
                "I/O failure"
            }
        );
    }
}

#[test]
fn root_failure_database_failed_listing_cancels_at_probe_is_unlabelled() {
    let (_directory, registry, handle, root) = root_failure_database_fixture();
    fs::remove_dir(&root).unwrap();
    let token = CancellationToken::new();
    let cancel = token.clone();
    let _hook = ListingRootFailureHookGuard(handle.path_ref().id.clone());
    LISTING_ROOT_FAILURE_HOOKS.arm(
        handle.path_ref().id.clone(),
        Box::new(move |original| {
            assert!(
                matches!(original, Error::Io(error) if error.kind() == std::io::ErrorKind::NotFound)
            );
            assert_eq!(original.root_failure(), None);
            cancel.cancel();
        }),
    );
    let error =
        crate::workspace_commands::list_workspace_databases_blocking(&registry, handle, &token)
            .unwrap_err();
    assert!(
        token.is_cancelled(),
        "the failed listing must reach its probe"
    );
    assert!(matches!(error, Error::Cancellation));
    assert_eq!(error.root_failure(), None);
}

#[test]
fn root_failure_database_root_swap_during_resolution_keeps_original_message() {
    let (directory, registry, handle, root) = root_failure_database_fixture();
    let saved = directory.path().join("old-root");
    RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            fs::rename(&root, saved).unwrap();
            fs::create_dir(&root).unwrap();
        }));
    });
    let error = crate::workspace_commands::list_workspace_databases_blocking(
        &registry,
        handle,
        &CancellationToken::new(),
    )
    .unwrap_err();
    assert_eq!(
        error.root_failure(),
        Some(crate::error::RootFailure::Changed)
    );
    assert_eq!(error.category(), crate::error::ErrorCategory::Conflict);
    assert_eq!(error.to_string(), "Conflict: root changed concurrently");
}

#[test]
fn root_failure_database_listing_authority_poison_and_initialization_stay_unlabelled() {
    for poison in [false, true] {
        let (_directory, registry, handle, _root) = root_failure_database_fixture();
        if poison {
            registry.poison();
        } else {
            registry.uninstall();
        }
        let error = crate::workspace_commands::list_workspace_databases_blocking(
            &registry,
            handle.clone(),
            &CancellationToken::new(),
        )
        .unwrap_err();
        assert_eq!(error.root_failure(), None);
        assert_eq!(
            error.to_string(),
            if poison {
                "Conflict: path authority lock was poisoned"
            } else {
                "Conflict: path authority is not initialized"
            }
        );
        let error = probe_listing_root_failure(
            &registry,
            handle.path_ref(),
            PathOperation::DatabaseRead,
            Error::InvalidInput("child failure".into()),
            &CancellationToken::new(),
        );
        assert_eq!(error.root_failure(), None);
        assert_eq!(error.to_string(), "Invalid input: child failure");
    }
}

#[test]
fn root_failure_probe_cancellation_before_and_during_resolution_is_unlabelled() {
    for during in [false, true] {
        let (_directory, registry, handle, _root) = root_failure_database_fixture();
        let token = CancellationToken::new();
        if during {
            let token = token.clone();
            RESOLVE_PRE_ROOT_OPEN_HOOK
                .with(|slot| *slot.borrow_mut() = Some(Box::new(move || token.cancel())));
        } else {
            token.cancel();
        }
        let error = probe_listing_root_failure(
            &registry,
            handle.path_ref(),
            PathOperation::DatabaseRead,
            Error::Conflict("original".into()),
            &token,
        );
        assert!(matches!(error, Error::Cancellation));
        assert_eq!(error.root_failure(), None);
    }
}

#[test]
fn root_failure_probe_skips_cancelled_and_already_labelled_errors() {
    let (_directory, registry, handle, root) = root_failure_database_fixture();
    fs::remove_dir(&root).unwrap();
    for cancelled in [false, true] {
        let original = if cancelled {
            Error::Cancellation
        } else {
            crate::infra::fs::check_directory_listing_bound(1, 1).unwrap_err()
        };
        let error = probe_listing_root_failure(
            &registry,
            handle.path_ref(),
            PathOperation::DatabaseRead,
            original,
            &CancellationToken::new(),
        );
        if cancelled {
            assert!(matches!(error, Error::Cancellation));
            assert_eq!(error.root_failure(), None);
        } else {
            assert_eq!(
                error.root_failure(),
                Some(crate::error::RootFailure::TooLarge)
            );
            assert_eq!(
                error.to_string(),
                "Resource limit: directory listing exceeded 1 entries"
            );
        }
    }
}

#[test]
fn root_failure_probe_cancellation_while_waiting_for_authority_is_unlabelled() {
    let (_directory, registry, handle, _root) = root_failure_database_fixture();
    let observer = crate::infra::cancellable_lock::observe_std_lock_wait(registry.raw_for_test());
    let held = registry.raw_for_test().lock().unwrap();
    let token = CancellationToken::new();
    let worker_registry = registry.clone();
    let worker_token = token.clone();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let error = probe_listing_root_failure(
            &worker_registry,
            handle.path_ref(),
            PathOperation::DatabaseRead,
            Error::Conflict("original".into()),
            &worker_token,
        );
        done_tx.send(error).unwrap();
    });
    observer.recv_timeout(Duration::from_secs(5)).unwrap();
    token.cancel();
    let error = done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(error, Error::Cancellation));
    assert_eq!(error.root_failure(), None);
    drop(held);
    worker.join().unwrap();
}

#[cfg(unix)]
#[test]
fn root_failure_probe_cancellation_during_enumeration_is_unlabelled() {
    let (_directory, registry, handle, _root) = root_failure_database_fixture();
    let token = CancellationToken::new();
    let cancel = token.clone();
    set_capability_directory_post_entries_hook(Some(Box::new(move || cancel.cancel())));
    let error = probe_listing_root_failure(
        &registry,
        handle.path_ref(),
        PathOperation::DatabaseRead,
        Error::Conflict("original".into()),
        &token,
    );
    assert!(matches!(error, Error::Cancellation));
    assert_eq!(error.root_failure(), None);
}

#[test]
fn root_failure_database_listing_bound_is_too_large_and_keeps_message() {
    let (_directory, registry, handle, root) = root_failure_database_fixture();
    for index in 0..=crate::infra::fs::MAX_DIRECTORY_LISTING_ENTRIES {
        fs::write(root.join(index.to_string()), b"").unwrap();
    }
    let error = crate::workspace_commands::list_workspace_databases_blocking(
        &registry,
        handle,
        &CancellationToken::new(),
    )
    .unwrap_err();
    assert_eq!(
        error.root_failure(),
        Some(crate::error::RootFailure::TooLarge)
    );
    assert_eq!(error.category(), crate::error::ErrorCategory::ResourceLimit);
    assert_eq!(
        error.to_string(),
        "Resource limit: directory listing exceeded 4096 entries"
    );
}

#[test]
fn root_failure_database_picker_same_path_refusal_is_changed() {
    let (directory, registry, _handle, root) = root_failure_database_fixture();
    fs::rename(&root, directory.path().join("old-root")).unwrap();
    fs::create_dir(&root).unwrap();
    let error = registry
        .raw_for_test()
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .get_or_create_database_root(&root, "Databases", None)
        .unwrap_err();
    assert_eq!(
        error.root_failure(),
        Some(crate::error::RootFailure::Changed)
    );
    assert_eq!(error.category(), crate::error::ErrorCategory::Conflict);
    assert_eq!(
        error.to_string(),
        "Conflict: database root changed; select it again"
    );
}

#[test]
fn root_failure_default_registration_and_activation_label_only_root_validation() {
    for activate in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let app_data = AppDataDir::for_test(directory.path());
        let authorized =
            ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Databases).unwrap();
        let mut registry = PathAuthority::open_with_clock(
            directory.path().join("registry.json"),
            vec![],
            Arc::new(SystemClock),
            2,
        )
        .unwrap();
        let root = if activate {
            Some(
                registry
                    .get_or_create_database_root(
                        authorized.path(),
                        "Databases",
                        Some(authorized.identity()),
                    )
                    .unwrap(),
            )
        } else {
            None
        };
        fs::rename(authorized.path(), directory.path().join("old-root")).unwrap();
        fs::create_dir(authorized.path()).unwrap();
        let error = match root {
            Some(root) => registry
                .set_active_default_database_root(&root)
                .unwrap_err(),
            None => registry
                .get_or_create_database_root(
                    authorized.path(),
                    "Databases",
                    Some(authorized.identity()),
                )
                .unwrap_err(),
        };
        assert_eq!(
            error.root_failure(),
            Some(crate::error::RootFailure::Changed)
        );
        assert_eq!(error.category(), crate::error::ErrorCategory::Conflict);
        assert_eq!(
            error.to_string(),
            if activate {
                "Conflict: workspace is unavailable because its root changed".to_owned()
            } else {
                format!("Conflict: {VERIFIED_REGISTRATION_CONFLICT}")
            }
        );
    }
}

#[test]
fn root_failure_default_registry_persistence_and_capacity_are_unlabelled() {
    use crate::infra::fs::{
        set_test_atomic_file_injector, AtomicFileFaultPoint, AtomicWriterInjector,
    };
    struct PersistenceFailure;
    impl AtomicWriterInjector for PersistenceFailure {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == AtomicFileFaultPoint::Rename {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "registry persistence test failure",
                ))
            } else {
                Ok(())
            }
        }
    }
    for activate in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let app_data = AppDataDir::for_test(directory.path());
        let authorized =
            ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Databases).unwrap();
        let mut registry = PathAuthority::open_with_clock(
            directory.path().join("registry.json"),
            vec![],
            Arc::new(SystemClock),
            2,
        )
        .unwrap();
        let root = if activate {
            Some(
                registry
                    .get_or_create_database_root(
                        authorized.path(),
                        "Databases",
                        Some(authorized.identity()),
                    )
                    .unwrap(),
            )
        } else {
            None
        };
        set_test_atomic_file_injector(Some(Arc::new(PersistenceFailure)));
        let result = match root {
            Some(root) => registry.set_active_default_database_root(&root),
            None => registry
                .get_or_create_database_root(
                    authorized.path(),
                    "Databases",
                    Some(authorized.identity()),
                )
                .map(|_| ()),
        };
        set_test_atomic_file_injector(None);
        let error = result.unwrap_err();
        assert_eq!(error.root_failure(), None);
        assert_eq!(error.category(), crate::error::ErrorCategory::Permission);
        assert_eq!(error.to_string(), "I/O failure");
    }
    let (_directory, mut registry, workspace, _root) = directory_listing_bound_fixture().unwrap();
    directory_listing_bound_fill(&mut registry, workspace.path_ref(), MAX_AUTHORITY_IDS).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let app_data = AppDataDir::for_test(directory.path());
    let error = crate::workspace_commands::get_default_database_workspace(&mut registry, &app_data)
        .unwrap_err();
    assert_eq!(error.root_failure(), None);
    assert_eq!(error.category(), crate::error::ErrorCategory::ResourceLimit);
}

#[cfg(unix)]
#[test]
fn root_failure_root_read_without_search_permission_is_permission() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let (_directory, registry, handle, root) = root_failure_database_fixture();
    fs::write(root.join("child.db3"), b"").unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o400)).unwrap();
    let result = crate::workspace_commands::list_workspace_databases_blocking(
        &registry,
        handle,
        &CancellationToken::new(),
    );
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let error = result.unwrap_err();
    assert_eq!(
        error.root_failure(),
        Some(crate::error::RootFailure::Permission),
        "{error:?}"
    );
    assert_eq!(error.category(), crate::error::ErrorCategory::Permission);
    assert_eq!(error.to_string(), "I/O failure");
}

fn directory_listing_bound_fixture() -> Result<
    (
        tempfile::TempDir,
        PathAuthority,
        FileWorkspaceHandle,
        PathBuf,
    ),
    Error,
> {
    let directory = tempfile::tempdir()?;
    let root = directory.path().join("workspace");
    fs::create_dir(&root)?;
    let mut authority = PathAuthority::open_with_clock(
        directory.path().join("registry.json"),
        vec![],
        Arc::new(SystemClock),
        2,
    )?;
    let commit = authority.migrate_legacy_os_path(
        root.clone().into_os_string(),
        "workspace",
        PathClass::PersistentCustomRoot,
        canonical_operations(EntryPurpose::PgnWorkspace),
    )?;
    require_durable(commit.durability)?;
    Ok((
        directory,
        authority,
        FileWorkspaceHandle::new(commit.id),
        root,
    ))
}

fn directory_listing_bound_prepare(
    authority: &mut PathAuthority,
    workspace: &FileWorkspaceHandle,
    root: &Path,
    name: &str,
) -> Result<PreparedEntry, Error> {
    let child = identity(&root.join(name))?;
    let parent = identity(root)?;
    authority.prepare_workspace_listing_child(
        workspace,
        &[OsString::from(name)],
        name,
        IdentityBinding::from_pairs((child.a, child.b), (parent.a, parent.b)),
        false,
        PathOperation::ReadPgn,
    )
}

fn directory_listing_bound_fill(
    authority: &mut PathAuthority,
    root: &PathRef,
    size: usize,
) -> Result<(), Error> {
    let template = authority
        .persistent
        .get(&root.id)
        .cloned()
        .ok_or_else(|| Error::Conflict("test root missing".into()))?;
    for index in authority.persistent.len()..size {
        let mut entry = template.clone();
        entry.stored.id.id = format!("unrelated-root-{index}");
        authority
            .persistent
            .insert(entry.stored.id.id.clone(), entry);
    }
    require_durable(authority.save()?)
}

#[test]
fn listing_child_paths_match_ascii_case_only_on_windows() {
    assert_eq!(
        listing_paths_match(Path::new("root/folder"), Path::new("root/Folder")),
        cfg!(windows)
    );
    assert!(!listing_paths_match(
        Path::new("root/ä"),
        Path::new("root/Ä")
    ));
}

#[test]
fn listing_child_recursive_case_retains_snapshot_ids_only_on_windows() -> Result<(), Error> {
    let (_directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
    fs::create_dir(root.join("folder"))?;
    fs::write(root.join("folder/child.pgn"), b"*")?;
    let mut ids = Vec::new();
    for (components, is_dir) in [
        (vec![OsString::from("folder")], true),
        (
            vec![OsString::from("folder"), OsString::from("child.pgn")],
            false,
        ),
    ] {
        let path = components
            .iter()
            .fold(root.clone(), |path, leaf| path.join(leaf));
        let child = identity(&path)?;
        let parent = identity(path.parent().unwrap())?;
        let prepared = authority.prepare_workspace_listing_child(
            &workspace,
            &components,
            "child",
            IdentityBinding::from_pairs((child.a, child.b), (parent.a, parent.b)),
            is_dir,
            PathOperation::ReadPgn,
        )?;
        ids.push(authority.publish_prepared_entry(prepared)?.id);
    }
    let snapshot = authority.workspace_listing_snapshot(&workspace, OsStr::new("trash"))?;
    assert_eq!(snapshot.entries.len(), 2);
    let retained = snapshot.retained_ids(&[(vec![OsString::from("Folder")], true)])?;
    assert_eq!(retained.contains(&ids[0].id), cfg!(windows));
    assert_eq!(retained.contains(&ids[1].id), cfg!(windows));
    assert_eq!(retained.len(), if cfg!(windows) { 2 } else { 0 });
    Ok(())
}

#[test]
fn directory_listing_bound_matches_authority_limit() {
    assert_eq!(
        crate::infra::fs::MAX_DIRECTORY_LISTING_ENTRIES,
        MAX_AUTHORITY_IDS
    );
}

#[test]
fn directory_listing_bound_practice_directory_remains_unbounded() -> Result<(), Error> {
    let directory = tempfile::tempdir()?;
    for index in 0..=crate::infra::fs::MAX_DIRECTORY_LISTING_ENTRIES {
        fs::write(directory.path().join(index.to_string()), b"")?;
    }
    let authorized = authorize_existing_dir(directory.path())?;
    assert_eq!(
        authorized.entries(&mut |_| true)?.len(),
        MAX_AUTHORITY_IDS + 1
    );
    Ok(())
}

#[test]
fn directory_listing_bound_net_replacement_and_legacy_relist_at_capacity() -> Result<(), Error> {
    for capacity in [MAX_AUTHORITY_IDS, MAX_AUTHORITY_IDS + 1] {
        let (_directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
        fs::write(root.join("a.pgn"), b"old")?;
        let old = directory_listing_bound_prepare(&mut authority, &workspace, &root, "a.pgn")?;
        let old_id = authority.publish_prepared_entry(old)?.id;
        directory_listing_bound_fill(&mut authority, workspace.path_ref(), capacity)?;
        let snapshot = authority.workspace_listing_snapshot(&workspace, OsStr::new("trash"))?;
        fs::rename(root.join("a.pgn"), root.with_extension("old-pgn"))?;
        fs::write(root.join("a.pgn"), b"new")?;
        let new = directory_listing_bound_prepare(&mut authority, &workspace, &root, "a.pgn")?;
        let new_id = new.id();
        assert!(!new.reused);
        authority.commit_directory_listing(
            snapshot,
            vec![new],
            &BTreeSet::new(),
            &CancellationToken::new(),
        )?;
        assert_eq!(authority.persistent.len(), capacity);
        assert!(!authority.persistent.contains_key(&old_id.id));
        assert!(authority.persistent.contains_key(&new_id.id));
        let snapshot = authority.workspace_listing_snapshot(&workspace, OsStr::new("trash"))?;
        let reused = directory_listing_bound_prepare(&mut authority, &workspace, &root, "a.pgn")?;
        assert_eq!(reused.id(), new_id);
        struct NoWrite;
        impl crate::infra::fs::AtomicWriterInjector for NoWrite {
            fn inject(&self, _: crate::infra::fs::AtomicFileFaultPoint) -> std::io::Result<()> {
                Err(std::io::Error::other("unchanged listing must not write"))
            }
        }
        crate::infra::fs::set_test_atomic_file_injector(Some(Arc::new(NoWrite)));
        let relisted = authority.commit_directory_listing(
            snapshot,
            vec![reused],
            &BTreeSet::new(),
            &CancellationToken::new(),
        );
        crate::infra::fs::set_test_atomic_file_injector(None);
        relisted?;
    }
    Ok(())
}

#[test]
fn directory_listing_bound_growth_refusal_precedes_canonicalization_and_retirement(
) -> Result<(), Error> {
    let (_directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
    for name in ["canonical.pgn", "removed.pgn"] {
        fs::write(root.join(name), b"*")?;
        let prepared = directory_listing_bound_prepare(&mut authority, &workspace, &root, name)?;
        let id = authority.publish_prepared_entry(prepared)?.id;
        if name == "canonical.pgn" {
            if let Some(entry) = authority.persistent.get_mut(&id.id) {
                entry.stored.operations = vec![PathOperation::ReadPgn];
            }
        }
    }
    directory_listing_bound_fill(&mut authority, workspace.path_ref(), MAX_AUTHORITY_IDS)?;
    let snapshot = authority.workspace_listing_snapshot(&workspace, OsStr::new("trash"))?;
    fs::remove_file(root.join("removed.pgn"))?;
    let mut prepared = Vec::new();
    for name in ["canonical.pgn", "new-a.pgn", "new-b.pgn"] {
        if name != "canonical.pgn" {
            fs::write(root.join(name), b"*")?;
        }
        prepared.push(directory_listing_bound_prepare(
            &mut authority,
            &workspace,
            &root,
            name,
        )?);
    }
    let before = authority.persistent.clone();
    let disk = fs::read(&authority.registry_path)?;
    assert!(matches!(
        authority.commit_directory_listing(
            snapshot,
            prepared,
            &BTreeSet::new(),
            &CancellationToken::new()
        ),
        Err(Error::ResourceLimit(_))
    ));
    assert!(authority.persistent == before);
    assert_eq!(fs::read(&authority.registry_path)?, disk);
    Ok(())
}

#[test]
fn directory_listing_bound_snapshot_preserves_new_ids_rebinds_trash_and_other_purposes(
) -> Result<(), Error> {
    let (_directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
    let mut ids = Vec::new();
    for name in [
        "removed.pgn",
        "rebound.pgn",
        "trash/hidden.pgn",
        "other.pgn",
        "identity-changed.pgn",
        "purpose-changed.pgn",
    ] {
        if let Some(parent) = root.join(name).parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(root.join(name), b"*")?;
        let components = Path::new(name)
            .components()
            .map(|c| c.as_os_str().to_os_string())
            .collect::<Vec<_>>();
        let file_identity = identity(&root.join(name))?;
        let parent_identity = identity(
            root.join(name)
                .parent()
                .ok_or_else(|| Error::Conflict("test parent missing".into()))?,
        )?;
        let id = authority.register_workspace_child_observed_with_parent(
            &workspace,
            &components,
            name,
            IdentityBinding::new(file_identity, Some(parent_identity)),
            false,
            PathOperation::ReadPgn,
        )?;
        ids.push(id.path_ref().clone());
    }
    if let Some(entry) = authority.persistent.get_mut(&ids[3].id) {
        entry.stored.purpose = Some(EntryPurpose::OpeningBook);
        entry.stored.operations = canonical_operations(EntryPurpose::OpeningBook);
    }
    let snapshot = authority.workspace_listing_snapshot(&workspace, OsStr::new("trash"))?;
    // Model the path rebind performed by trashing while the walk is unlocked.
    if let Some(entry) = authority.persistent.get_mut(&ids[1].id) {
        entry.stored.path = NativePath::from_path(&root.join("trash/rebound.pgn"));
    }
    if let Some(entry) = authority.persistent.get_mut(&ids[4].id) {
        entry.stored.identity.b += 1;
    }
    if let Some(entry) = authority.persistent.get_mut(&ids[5].id) {
        entry.stored.purpose = Some(EntryPurpose::OpeningBook);
        entry.stored.operations = canonical_operations(EntryPurpose::OpeningBook);
    }
    fs::write(root.join("late.pgn"), b"*")?;
    let late = directory_listing_bound_prepare(&mut authority, &workspace, &root, "late.pgn")?;
    let late_id = authority.publish_prepared_entry(late)?.id;
    authority.commit_directory_listing(
        snapshot,
        vec![],
        &BTreeSet::new(),
        &CancellationToken::new(),
    )?;
    assert!(!authority.persistent.contains_key(&ids[0].id));
    for id in [
        &ids[1],
        &ids[2],
        &ids[3],
        &ids[4],
        &ids[5],
        &late_id,
        workspace.path_ref(),
    ] {
        assert!(authority.persistent.contains_key(&id.id));
    }
    Ok(())
}

#[test]
fn directory_listing_bound_reuse_failure_does_not_publish_fresh_ids_or_retire() -> Result<(), Error>
{
    use crate::infra::fs::{
        set_test_atomic_file_injector, AtomicFileFaultPoint, AtomicWriterInjector,
    };
    #[derive(Clone, Copy)]
    enum ReuseFaultKind {
        WriteFailure,
        ParentSyncDurabilityUncertain,
        CancelOnParentSync,
    }
    struct ReuseFault {
        kind: ReuseFaultKind,
        token: CancellationToken,
    }
    impl AtomicWriterInjector for ReuseFault {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if (matches!(self.kind, ReuseFaultKind::WriteFailure)
                && point == AtomicFileFaultPoint::Write)
                || (matches!(self.kind, ReuseFaultKind::ParentSyncDurabilityUncertain)
                    && point == AtomicFileFaultPoint::ParentSync)
            {
                return Err(std::io::Error::other("reuse persistence fault"));
            }
            if matches!(self.kind, ReuseFaultKind::CancelOnParentSync)
                && point == AtomicFileFaultPoint::ParentSync
            {
                self.token.cancel();
            }
            Ok(())
        }
    }
    for kind in [
        ReuseFaultKind::WriteFailure,
        ReuseFaultKind::ParentSyncDurabilityUncertain,
        ReuseFaultKind::CancelOnParentSync,
    ] {
        let (_directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
        let mut ids = Vec::new();
        for name in ["canonical.pgn", "removed.pgn"] {
            fs::write(root.join(name), b"*")?;
            let prepared =
                directory_listing_bound_prepare(&mut authority, &workspace, &root, name)?;
            ids.push(authority.publish_prepared_entry(prepared)?.id);
        }
        if let Some(entry) = authority.persistent.get_mut(&ids[0].id) {
            entry.stored.operations = vec![PathOperation::ReadPgn];
        }
        require_durable(authority.save()?)?;
        let snapshot = authority.workspace_listing_snapshot(&workspace, OsStr::new("trash"))?;
        fs::remove_file(root.join("removed.pgn"))?;
        fs::write(root.join("new.pgn"), b"*")?;
        let reused =
            directory_listing_bound_prepare(&mut authority, &workspace, &root, "canonical.pgn")?;
        let fresh = directory_listing_bound_prepare(&mut authority, &workspace, &root, "new.pgn")?;
        let fresh_id = fresh.id();
        let token = CancellationToken::new();
        set_test_atomic_file_injector(Some(Arc::new(ReuseFault {
            kind,
            token: token.clone(),
        })));
        let result = authority.commit_directory_listing(
            snapshot,
            vec![reused, fresh],
            &BTreeSet::new(),
            &token,
        );
        set_test_atomic_file_injector(None);
        match kind {
            ReuseFaultKind::WriteFailure => assert!(matches!(result, Err(Error::Io(_)))),
            ReuseFaultKind::ParentSyncDurabilityUncertain => assert!(matches!(
                result,
                Err(Error::CommittedDurabilityUncertain(_))
            )),
            ReuseFaultKind::CancelOnParentSync => {
                assert!(matches!(result, Err(Error::Cancellation)))
            }
        }
        assert!(!authority.persistent.contains_key(&fresh_id.id));
        for id in ids {
            assert!(authority.persistent.contains_key(&id.id));
        }
    }
    Ok(())
}

#[test]
fn directory_listing_bound_snapshot_hard_failure_uncertainty_and_cancellation() -> Result<(), Error>
{
    use crate::infra::fs::{
        set_test_atomic_file_injector, AtomicFileFaultPoint, AtomicWriterInjector,
    };
    struct Fault {
        uncertain: bool,
        writes: AtomicU64,
    }
    impl AtomicWriterInjector for Fault {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == AtomicFileFaultPoint::Write {
                self.writes.fetch_add(1, Ordering::SeqCst);
            }
            if point
                == if self.uncertain {
                    AtomicFileFaultPoint::ParentSync
                } else {
                    AtomicFileFaultPoint::Write
                }
            {
                return Err(std::io::Error::other("snapshot fault"));
            }
            Ok(())
        }
    }
    for uncertain in [false, true] {
        let (_directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
        fs::write(root.join("old.pgn"), b"old")?;
        let old = directory_listing_bound_prepare(&mut authority, &workspace, &root, "old.pgn")?;
        let old_id = authority.publish_prepared_entry(old)?.id;
        let before = authority.persistent.clone();
        let snapshot = authority.workspace_listing_snapshot(&workspace, OsStr::new("trash"))?;
        fs::remove_file(root.join("old.pgn"))?;
        fs::write(root.join("new.pgn"), b"new")?;
        let prepared =
            directory_listing_bound_prepare(&mut authority, &workspace, &root, "new.pgn")?;
        let new_id = prepared.id();
        let fault = Arc::new(Fault {
            uncertain,
            writes: AtomicU64::new(0),
        });
        set_test_atomic_file_injector(Some(fault.clone()));
        let result = authority.commit_directory_listing(
            snapshot,
            vec![prepared],
            &BTreeSet::new(),
            &CancellationToken::new(),
        );
        set_test_atomic_file_injector(None);
        if uncertain {
            assert!(matches!(
                result,
                Err(Error::CommittedDurabilityUncertain(_))
            ));
            assert!(authority.persistent.contains_key(&new_id.id));
            assert!(!authority.persistent.contains_key(&old_id.id));
            assert!(authority.session_protected_ids.contains(&new_id.id));
            assert_eq!(fault.writes.load(Ordering::SeqCst), 1);
        } else {
            assert!(matches!(result, Err(Error::Io(_))));
            assert!(authority.persistent == before);
        }
    }
    let (_directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
    let snapshot = authority.workspace_listing_snapshot(&workspace, OsStr::new("trash"))?;
    fs::write(root.join("new.pgn"), b"new")?;
    let prepared = directory_listing_bound_prepare(&mut authority, &workspace, &root, "new.pgn")?;
    let before = authority.persistent.clone();
    let token = CancellationToken::new();
    token.cancel();
    assert!(matches!(
        authority.commit_directory_listing(snapshot, vec![prepared], &BTreeSet::new(), &token),
        Err(Error::Cancellation)
    ));
    assert!(authority.persistent == before);
    Ok(())
}

fn replace_by_rename_over(path: &Path, contents: &[u8]) {
    let staging = path.with_file_name(format!(
        ".{}-staging",
        path.file_name().unwrap().to_string_lossy()
    ));
    fs::write(&staging, contents).unwrap();
    fs::rename(&staging, path).unwrap();
}

fn published_listing_child(
    authority: &mut PathAuthority,
    workspace: &FileWorkspaceHandle,
    root: &Path,
    name: &str,
) -> Result<PathRef, Error> {
    let prepared = directory_listing_bound_prepare(authority, workspace, root, name)?;
    Ok(authority.publish_prepared_entry(prepared)?.id)
}

fn relist_workspace_files(
    authority: &mut PathAuthority,
    workspace: &FileWorkspaceHandle,
    root: &Path,
    names: &[&str],
    retained: &BTreeSet<String>,
) -> Result<Vec<PreparedEntry>, Error> {
    let snapshot = authority.workspace_listing_snapshot(workspace, OsStr::new("trash"))?;
    let mut prepared = Vec::new();
    for name in names {
        prepared.push(directory_listing_bound_prepare(
            authority, workspace, root, name,
        )?);
    }
    authority.commit_directory_listing(
        snapshot,
        prepared.clone(),
        retained,
        &CancellationToken::new(),
    )?;
    Ok(prepared)
}

fn practice_key_of(authority: &PathAuthority, id: &PathRef) -> Option<String> {
    authority
        .persistent
        .get(&id.id)
        .and_then(|entry| entry.stored.practice_key.clone())
}

#[test]
fn listing_inherits_practice_key_on_same_path_replacement() -> Result<(), Error> {
    let (_directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
    fs::write(root.join("a.pgn"), b"old")?;
    let donor = published_listing_child(&mut authority, &workspace, &root, "a.pgn")?;
    let before = identity(&root.join("a.pgn"))?;
    replace_by_rename_over(&root.join("a.pgn"), b"new");
    let after = identity(&root.join("a.pgn"))?;
    assert_ne!(before, after);
    let prepared = relist_workspace_files(
        &mut authority,
        &workspace,
        &root,
        &["a.pgn"],
        &BTreeSet::new(),
    )?;
    let fresh = prepared[0].id();
    assert_ne!(fresh.id, donor.id);
    assert!(!authority.persistent.contains_key(&donor.id));
    assert_eq!(practice_key_of(&authority, &fresh), Some(donor.id));
    Ok(())
}

#[test]
fn listing_inherits_practice_key_on_same_identity_rename() -> Result<(), Error> {
    let (_directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
    fs::write(root.join("a.pgn"), b"*")?;
    let donor = published_listing_child(&mut authority, &workspace, &root, "a.pgn")?;
    let before = identity(&root.join("a.pgn"))?;
    fs::rename(root.join("a.pgn"), root.join("b.pgn"))?;
    assert_eq!(identity(&root.join("b.pgn"))?, before);
    let prepared = relist_workspace_files(
        &mut authority,
        &workspace,
        &root,
        &["b.pgn"],
        &BTreeSet::new(),
    )?;
    let fresh = prepared[0].id();
    assert_ne!(fresh.id, donor.id);
    assert_eq!(practice_key_of(&authority, &fresh), Some(donor.id));
    Ok(())
}

#[test]
fn listing_inherits_practice_key_on_ascii_case_only_rename() -> Result<(), Error> {
    let (_directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
    fs::write(root.join("a.pgn"), b"*")?;
    let donor = published_listing_child(&mut authority, &workspace, &root, "a.pgn")?;
    let before = identity(&root.join("a.pgn"))?;
    fs::rename(root.join("a.pgn"), root.join("tmp.pgn"))?;
    fs::rename(root.join("tmp.pgn"), root.join("A.pgn"))?;
    assert_eq!(identity(&root.join("A.pgn"))?, before);
    let prepared = relist_workspace_files(
        &mut authority,
        &workspace,
        &root,
        &["A.pgn"],
        &BTreeSet::new(),
    )?;
    let fresh = prepared[0].id();
    assert_ne!(fresh.id, donor.id);
    assert!(!authority.persistent.contains_key(&donor.id));
    assert_eq!(practice_key_of(&authority, &fresh), Some(donor.id));
    Ok(())
}

#[test]
fn listing_inherits_identity_before_same_path_in_one_commit() -> Result<(), Error> {
    let (_directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
    fs::write(root.join("a.pgn"), b"donor")?;
    let donor = published_listing_child(&mut authority, &workspace, &root, "a.pgn")?;
    let donor_identity = identity(&root.join("a.pgn"))?;
    fs::rename(root.join("a.pgn"), root.join("b.pgn"))?;
    assert_eq!(identity(&root.join("b.pgn"))?, donor_identity);
    fs::write(root.join("a.pgn"), b"unrelated")?;
    assert_ne!(identity(&root.join("a.pgn"))?, donor_identity);
    let prepared = relist_workspace_files(
        &mut authority,
        &workspace,
        &root,
        &["a.pgn", "b.pgn"],
        &BTreeSet::new(),
    )?;
    let renamed = prepared
        .iter()
        .find(|entry| entry.stored.display_name == "b.pgn")
        .expect("renamed listing child");
    let replacement = prepared
        .iter()
        .find(|entry| entry.stored.display_name == "a.pgn")
        .expect("replacement listing child");
    assert!(!authority.persistent.contains_key(&donor.id));
    assert_ne!(renamed.id().id, donor.id);
    assert_ne!(replacement.id().id, donor.id);
    assert_eq!(
        practice_key_of(&authority, &renamed.id()),
        Some(donor.id.clone())
    );
    assert!(practice_key_of(&authority, &replacement.id()).is_none());
    Ok(())
}

#[test]
fn listing_inherits_original_practice_key_across_chained_replacement() -> Result<(), Error> {
    let (_directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
    fs::write(root.join("a.pgn"), b"first")?;
    let original = published_listing_child(&mut authority, &workspace, &root, "a.pgn")?;
    replace_by_rename_over(&root.join("a.pgn"), b"second");
    let mid = relist_workspace_files(
        &mut authority,
        &workspace,
        &root,
        &["a.pgn"],
        &BTreeSet::new(),
    )?[0]
        .id();
    assert_eq!(practice_key_of(&authority, &mid), Some(original.id.clone()));
    replace_by_rename_over(&root.join("a.pgn"), b"third");
    let last = relist_workspace_files(
        &mut authority,
        &workspace,
        &root,
        &["a.pgn"],
        &BTreeSet::new(),
    )?[0]
        .id();
    assert_ne!(last.id, mid.id);
    assert_eq!(practice_key_of(&authority, &last), Some(original.id));
    Ok(())
}

#[test]
fn listing_inherits_nothing_for_ambiguous_identity_pair() -> Result<(), Error> {
    let (_directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
    fs::write(root.join("a.pgn"), b"*")?;
    fs::write(root.join("b.pgn"), b"*")?;
    fs::write(root.join("c.pgn"), b"*")?;
    let shared = identity(&root.join("a.pgn"))?;
    let donor_a = published_listing_child(&mut authority, &workspace, &root, "a.pgn")?;
    let donor_b = published_listing_child(&mut authority, &workspace, &root, "b.pgn")?;
    if let Some(entry) = authority.persistent.get_mut(&donor_b.id) {
        entry.stored.identity = shared.clone();
    }
    let snapshot = authority.workspace_listing_snapshot(&workspace, OsStr::new("trash"))?;
    let mut fresh = directory_listing_bound_prepare(&mut authority, &workspace, &root, "c.pgn")?;
    fresh.stored.identity = shared;
    fresh.reused = false;
    authority.commit_directory_listing(
        snapshot,
        vec![fresh.clone()],
        &BTreeSet::new(),
        &CancellationToken::new(),
    )?;
    assert!(practice_key_of(&authority, &fresh.id()).is_none());
    assert!(!authority.persistent.contains_key(&donor_a.id));
    assert!(!authority.persistent.contains_key(&donor_b.id));
    Ok(())
}

#[test]
fn listing_inherits_nothing_from_reused_hard_link_donor() -> Result<(), Error> {
    let (_directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
    fs::write(root.join("a.pgn"), b"*")?;
    fs::hard_link(root.join("a.pgn"), root.join("b.pgn"))?;
    assert_eq!(
        identity(&root.join("a.pgn"))?,
        identity(&root.join("b.pgn"))?
    );
    let donor = published_listing_child(&mut authority, &workspace, &root, "a.pgn")?;
    let prepared = relist_workspace_files(
        &mut authority,
        &workspace,
        &root,
        &["a.pgn", "b.pgn"],
        &BTreeSet::new(),
    )?;
    let reused = prepared
        .iter()
        .find(|entry| entry.stored.id.id == donor.id)
        .expect("original path is reused");
    assert!(reused.reused);
    let fresh = prepared
        .iter()
        .find(|entry| entry.stored.id.id != donor.id)
        .expect("second link is fresh");
    assert!(!fresh.reused);
    assert!(practice_key_of(&authority, &fresh.id()).is_none());
    Ok(())
}

#[test]
fn listing_inherits_nothing_from_unread_retained_donor() -> Result<(), Error> {
    let (_directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
    fs::write(root.join("a.pgn"), b"old")?;
    let donor = published_listing_child(&mut authority, &workspace, &root, "a.pgn")?;
    replace_by_rename_over(&root.join("a.pgn"), b"new");
    let mut retained = BTreeSet::new();
    retained.insert(donor.id.clone());
    let prepared =
        relist_workspace_files(&mut authority, &workspace, &root, &["a.pgn"], &retained)?;
    let fresh = prepared[0].id();
    assert!(authority.persistent.contains_key(&donor.id));
    assert_ne!(fresh.id, donor.id);
    assert!(practice_key_of(&authority, &fresh).is_none());
    Ok(())
}

#[test]
fn listing_inherits_nothing_for_non_pgn_file() -> Result<(), Error> {
    let (_directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
    fs::write(root.join("a.pgn"), b"old")?;
    let donor = published_listing_child(&mut authority, &workspace, &root, "a.pgn")?;
    if let Some(entry) = authority.persistent.get_mut(&donor.id) {
        entry.stored.purpose = Some(EntryPurpose::OpeningBook);
        entry.stored.operations = canonical_operations(EntryPurpose::OpeningBook);
    }
    let snapshot = DirectoryListingSnapshot {
        root: root.clone(),
        entries: vec![authority.persistent.get(&donor.id).unwrap().stored.clone()],
    };
    replace_by_rename_over(&root.join("a.pgn"), b"new");
    let fresh = directory_listing_bound_prepare(&mut authority, &workspace, &root, "a.pgn")?;
    authority.commit_directory_listing(
        snapshot,
        vec![fresh.clone()],
        &BTreeSet::new(),
        &CancellationToken::new(),
    )?;
    assert!(practice_key_of(&authority, &fresh.id()).is_none());
    Ok(())
}

#[test]
fn listing_inherits_nothing_when_donor_path_does_not_convert() -> Result<(), Error> {
    let (_directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
    fs::write(root.join("a.pgn"), b"*")?;
    fs::write(root.join("b.pgn"), b"*")?;
    let donor = published_listing_child(&mut authority, &workspace, &root, "a.pgn")?;
    let shared = identity(&root.join("b.pgn"))?;
    if let Some(entry) = authority.persistent.get_mut(&donor.id) {
        entry.stored.identity = shared.clone();
        #[cfg(unix)]
        {
            entry.stored.path = NativePath::Windows {
                utf16: vec![u16::from(b'x')],
            };
        }
        #[cfg(windows)]
        {
            entry.stored.path = NativePath::Unix { bytes: "eA".into() };
        }
    }
    let snapshot = DirectoryListingSnapshot {
        root: root.clone(),
        entries: vec![authority.persistent.get(&donor.id).unwrap().stored.clone()],
    };
    let mut fresh = directory_listing_bound_prepare(&mut authority, &workspace, &root, "b.pgn")?;
    fresh.stored.identity = shared;
    authority.commit_directory_listing(
        snapshot,
        vec![fresh.clone()],
        &BTreeSet::new(),
        &CancellationToken::new(),
    )?;
    assert!(practice_key_of(&authority, &fresh.id()).is_none());
    Ok(())
}

#[test]
fn practice_key_survives_registry_reload_and_pgn_replace_rebind() -> Result<(), Error> {
    let (directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
    fs::write(root.join("a.pgn"), b"old")?;
    let id = published_listing_child(&mut authority, &workspace, &root, "a.pgn")?;
    if let Some(entry) = authority.persistent.get_mut(&id.id) {
        entry.stored.practice_key = Some("kept-key".into());
    }
    require_durable(authority.save()?)?;
    let registry = directory.path().join("registry.json");
    let raw = fs::read_to_string(&registry)?;
    assert!(raw.contains("kept-key"));
    let expected = {
        let entry = authority.persistent.get(&id.id).unwrap();
        (entry.stored.identity.a, entry.stored.identity.b)
    };
    replace_by_rename_over(&root.join("a.pgn"), b"installed");
    let installed = identity(&root.join("a.pgn"))?;
    authority.rebind_pgn_file_after_replace(&id, expected, (installed.a, installed.b))?;
    assert_eq!(
        practice_key_of(&authority, &id).as_deref(),
        Some("kept-key")
    );
    let reloaded = PathAuthority::open(registry, vec![])?;
    assert_eq!(practice_key_of(&reloaded, &id).as_deref(), Some("kept-key"));
    Ok(())
}

#[test]
fn registry_without_practice_key_loads_unchanged() -> Result<(), Error> {
    let (directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
    fs::write(root.join("a.pgn"), b"*")?;
    let id = published_listing_child(&mut authority, &workspace, &root, "a.pgn")?;
    require_durable(authority.save()?)?;
    let registry = directory.path().join("registry.json");
    let raw = fs::read_to_string(&registry)?;
    assert!(!raw.contains("practice_key"));
    let reloaded = PathAuthority::open(registry, vec![])?;
    assert!(practice_key_of(&reloaded, &id).is_none());
    assert_eq!(reloaded.practice_storage_key(&id)?, id.id);
    Ok(())
}

pub(super) struct TestClock(AtomicU64);
impl TestClock {
    pub(super) fn new(v: u64) -> Self {
        Self(AtomicU64::new(v))
    }
    pub(super) fn advance(&self, n: u64) {
        self.0.fetch_add(n, Ordering::SeqCst);
    }
}
impl Clock for TestClock {
    fn now(&self) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(self.0.load(Ordering::SeqCst))
    }
}
pub(super) fn authority(dir: &tempfile::TempDir, clock: Arc<TestClock>) -> PathAuthority {
    PathAuthority::open_with_clock(dir.path().join("registry.json"), vec![], clock, 2).unwrap()
}

#[test]
fn stale_startup_owner_ids_allow_durable_sweep_across_trusted_families() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let book_path = dir.path().join("live.book");
    let puzzle_path = dir.path().join("live.puzzle");
    let unowned_path = dir.path().join("unowned.book");
    for path in [&book_path, &puzzle_path, &unowned_path] {
        fs::write(path, b"fixture").unwrap();
    }
    let (book_id, puzzle_id, unowned_id) = {
        let mut initial = PathAuthority::open(registry.clone(), vec![]).unwrap();
        let book = initial.register_opening_book(&book_path, "live").unwrap();
        let puzzle = initial
            .get_or_create_persistent_file(
                &puzzle_path,
                "live",
                canonical_operations(EntryPurpose::PuzzleFile),
            )
            .unwrap();
        let unowned = initial
            .register_opening_book(&unowned_path, "unowned")
            .unwrap();
        (book.id, puzzle.id, unowned.id)
    };
    let live_ids = vec![book_id.clone(), puzzle_id.clone()];
    let unknown_ids = (0..=MAX_AUTHORITY_IDS)
        .map(|index| PathRef {
            id: format!(
                "stale-{}-{index}",
                ["book", "puzzle", "workspace"][index % 3]
            ),
        })
        .collect::<Vec<_>>();
    let mut retained_ids = live_ids.clone();
    retained_ids.extend(unknown_ids.iter().cloned());
    let mut authority = PathAuthority::open(registry.clone(), vec![]).unwrap();
    assert_eq!(
        authority
            .reconcile_startup_owners(StartupPathOwners {
                retained_ids,
                trusted_families: vec![
                    PathOwnerFamily::OpeningBook,
                    PathOwnerFamily::PuzzleDatabase,
                ],
            })
            .unwrap(),
        CommitDurability::Durable
    );
    assert!(!authority.persistent.contains_key(&unowned_id.id));
    assert_eq!(
        authority.startup_retained_ids,
        live_ids.iter().map(|id| id.id.clone()).collect()
    );
    for id in &unknown_ids {
        assert!(!authority.startup_retained_ids.contains(&id.id));
    }
    for (id, operation) in [
        (&book_id, PathOperation::OpeningBookRead),
        (&puzzle_id, PathOperation::PuzzleRead),
    ] {
        assert!(authority.persistent.contains_key(&id.id));
        assert!(authority.resolve(id, operation, &[]).is_ok());
    }
    drop(authority);
    let mut reloaded = PathAuthority::open(registry, vec![]).unwrap();
    assert!(!reloaded.persistent.contains_key(&unowned_id.id));
    for (id, operation) in [
        (&book_id, PathOperation::OpeningBookRead),
        (&puzzle_id, PathOperation::PuzzleRead),
    ] {
        assert!(reloaded.persistent.contains_key(&id.id));
        assert!(reloaded.resolve(id, operation, &[]).is_ok());
    }
}

#[test]
fn startup_owner_raw_input_cap_accepts_boundary_and_preserves_state_above_it() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let live_path = dir.path().join("live.book");
    let unowned_path = dir.path().join("unowned.book");
    fs::write(&live_path, b"live").unwrap();
    fs::write(&unowned_path, b"unowned").unwrap();
    let (live_id, unowned_id) = {
        let mut initial = PathAuthority::open(registry.clone(), vec![]).unwrap();
        let live = initial.register_opening_book(&live_path, "live").unwrap();
        let unowned = initial
            .register_opening_book(&unowned_path, "unowned")
            .unwrap();
        (live.id, unowned.id)
    };
    let mut authority = PathAuthority::open(registry.clone(), vec![]).unwrap();
    let input_limit = authority.authority_id_input_limit() + MAX_OWNER_UNKNOWN_IDS;
    let mut retained_ids = vec![live_id.clone()];
    retained_ids.extend((0..input_limit - 1).map(|index| PathRef {
        id: format!("unknown-{index}"),
    }));
    assert_eq!(retained_ids.len(), input_limit);
    assert_eq!(
        authority
            .reconcile_startup_owners(StartupPathOwners {
                retained_ids: retained_ids.clone(),
                trusted_families: vec![PathOwnerFamily::PuzzleDatabase],
            })
            .unwrap(),
        CommitDurability::Durable
    );
    assert!(authority.persistent.contains_key(&unowned_id.id));
    assert_eq!(authority.startup_retained_ids, BTreeSet::from([live_id.id]));
    assert_eq!(
        authority.completed_owner_families,
        BTreeSet::from([PathOwnerFamily::PuzzleDatabase])
    );
    let persistent_before = authority.persistent.clone();
    let retained_before = authority.startup_retained_ids.clone();
    let completed_before = authority.completed_owner_families.clone();
    let disk_before = fs::read(&registry).unwrap();
    retained_ids.push(PathRef {
        id: "one-too-many".into(),
    });
    assert_eq!(retained_ids.len(), input_limit + 1);
    assert!(matches!(
        authority.reconcile_startup_owners(StartupPathOwners {
            retained_ids,
            trusted_families: vec![PathOwnerFamily::OpeningBook],
        }),
        Err(Error::ResourceLimit(_))
    ));
    assert!(authority.persistent == persistent_before);
    assert_eq!(authority.startup_retained_ids, retained_before);
    assert_eq!(authority.completed_owner_families, completed_before);
    assert_eq!(fs::read(&registry).unwrap(), disk_before);
}

#[test]
fn startup_owner_raw_input_cap_scales_with_grandfathered_registry() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let book_path = dir.path().join("legacy.book");
    fs::write(&book_path, b"book").unwrap();
    {
        let mut initial = PathAuthority::open(registry.clone(), vec![]).unwrap();
        let book = initial.register_opening_book(&book_path, "legacy").unwrap();
        let template = initial.persistent.get(&book.id.id).unwrap().clone();
        for index in 0..(MAX_AUTHORITY_IDS + 1) {
            let mut entry = template.clone();
            entry.stored.id.id = format!("legacy-book-{index}");
            initial.persistent.insert(entry.stored.id.id.clone(), entry);
        }
        initial.save().unwrap();
    }
    let mut authority = PathAuthority::open(registry.clone(), vec![]).unwrap();
    assert_eq!(authority.authority_id_input_limit(), MAX_AUTHORITY_IDS + 2);
    let registry_ids = authority
        .persistent
        .keys()
        .map(|id| PathRef { id: id.clone() })
        .collect::<Vec<_>>();
    let input_limit = authority.authority_id_input_limit() + MAX_OWNER_UNKNOWN_IDS;
    let mut retained_ids = registry_ids.clone();
    retained_ids.extend((0..MAX_OWNER_UNKNOWN_IDS).map(|index| PathRef {
        id: format!("unknown-{index}"),
    }));
    assert_eq!(retained_ids.len(), input_limit);
    assert!(retained_ids.len() > MAX_AUTHORITY_IDS + MAX_OWNER_UNKNOWN_IDS);
    assert_eq!(
        authority
            .reconcile_startup_owners(StartupPathOwners {
                retained_ids: retained_ids.clone(),
                trusted_families: vec![],
            })
            .unwrap(),
        CommitDurability::Durable
    );
    for id in &registry_ids {
        assert!(authority.persistent.contains_key(&id.id));
    }
    let persistent_before = authority.persistent.clone();
    let retained_before = authority.startup_retained_ids.clone();
    let completed_before = authority.completed_owner_families.clone();
    let disk_before = fs::read(&registry).unwrap();
    retained_ids.push(PathRef {
        id: "one-too-many".into(),
    });
    assert_eq!(retained_ids.len(), input_limit + 1);
    assert!(matches!(
        authority.reconcile_startup_owners(StartupPathOwners {
            retained_ids,
            trusted_families: vec![],
        }),
        Err(Error::ResourceLimit(_))
    ));
    assert!(authority.persistent == persistent_before);
    assert_eq!(authority.startup_retained_ids, retained_before);
    assert_eq!(authority.completed_owner_families, completed_before);
    assert_eq!(fs::read(&registry).unwrap(), disk_before);
}

#[cfg(windows)]
#[test]
fn directory_root_open_removal_is_conflict() {
    struct RootHookCleanup;
    impl Drop for RootHookCleanup {
        fn drop(&mut self) {
            RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| slot.borrow_mut().take());
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("root");
    fs::create_dir(&root_path).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_database_root(&root_path, "root", None)
        .unwrap();
    let cleanup = RootHookCleanup;
    RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || {
                fs::remove_dir(&root_path).unwrap();
            })))
            .is_none());
    });
    let result = authority.resolve(root.path_ref(), PathOperation::DatabaseRead, &[]);
    assert!(
        matches!(&result, Err(Error::Conflict(message))
                if message == "path authority is unavailable because its object changed"),
        "unexpected resolution: {:?}",
        result.err()
    );
    drop(cleanup);
}

#[cfg(windows)]
#[test]
fn file_parent_open_removal_is_conflict() {
    struct RootHookCleanup;
    impl Drop for RootHookCleanup {
        fn drop(&mut self) {
            RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| slot.borrow_mut().take());
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("root");
    let retained = dir.path().join("retained");
    fs::create_dir(&root_path).unwrap();
    let book_path = root_path.join("book.bin");
    fs::write(&book_path, b"book").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let book = authority.register_opening_book(&book_path, "book").unwrap();
    let cleanup = RootHookCleanup;
    RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || {
                fs::rename(&root_path, retained).unwrap();
            })))
            .is_none());
    });
    let result = authority.resolve(book.path_ref(), PathOperation::OpeningBookRead, &[]);
    assert!(
        matches!(&result, Err(Error::Conflict(message))
                if message == "path authority is unavailable because its object changed"),
        "unexpected resolution: {:?}",
        result.err()
    );
    drop(cleanup);
}

#[cfg(windows)]
#[test]
fn conflict_if_replaced_maps_windows_swap_errors() {
    use windows_sys::Win32::Foundation::{
        ERROR_DIRECTORY, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND,
    };

    let message = "test object changed";
    for error in [
        Error::Io(Box::new(std::io::Error::from_raw_os_error(
            ERROR_FILE_NOT_FOUND as i32,
        ))),
        Error::Io(Box::new(std::io::Error::from_raw_os_error(
            ERROR_PATH_NOT_FOUND as i32,
        ))),
        Error::Io(Box::new(std::io::Error::from_raw_os_error(
            ERROR_DIRECTORY as i32,
        ))),
        Error::InvalidInput("reparse points cannot be authorized".into()),
    ] {
        let result = conflict_if_replaced(error, message);
        assert!(
            matches!(&result, Error::Conflict(actual) if actual == message),
            "unexpected classification: {result:?}"
        );
    }
}

#[cfg(windows)]
#[test]
fn conflict_if_replaced_preserves_other_windows_errors() {
    use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;

    let result = conflict_if_replaced(
        Error::InvalidInput("other invalid input".into()),
        "test object changed",
    );
    assert!(matches!(&result, Error::InvalidInput(message) if message == "other invalid input"));
    let result = conflict_if_replaced(
        Error::Io(Box::new(std::io::Error::from_raw_os_error(
            ERROR_ACCESS_DENIED as i32,
        ))),
        "test object changed",
    );
    assert!(matches!(result, Error::Io(error)
            if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32)));
}

/// `LaunchRootArgument` is `Option<EngineLaunchRoot>` on macOS and `()` everywhere else, so a
/// launch-root argument written at a call site compiles on exactly one of the two. Every test
/// that opens the authority over an explicit registry path and app roots goes through this
/// wrapper, which keeps the per-platform literal in one place; passing it as a value instead
/// would trip `clippy::unit_arg` off macOS.
#[cfg(unix)]
pub(super) fn authority_at(
    registry_path: PathBuf,
    app_roots: Vec<AppOwnedRoot>,
    clock: Arc<dyn Clock>,
    dialog_capacity: usize,
) -> Result<PathAuthority, Error> {
    #[cfg(target_os = "macos")]
    {
        PathAuthority::open_with_launch_root_argument(
            registry_path,
            app_roots,
            clock,
            dialog_capacity,
            None,
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        PathAuthority::open_with_launch_root_argument(
            registry_path,
            app_roots,
            clock,
            dialog_capacity,
            (),
        )
    }
}

/// FAT32 and exFAT have no POSIX rename, so the Windows replace falls back to the classic
/// rename, which refuses to replace a file that is still open. `replace_pgn_atomic` must
/// therefore close the resolution's and the snapshot's handles on the old PGN before the
/// rename (f-20261124-17). The `rust-windows-test` job mounts both volumes.
#[cfg(windows)]
#[test]
fn pgn_replacement_commits_on_volumes_without_posix_rename() {
    use std::io::{Read, Write};
    let roots = [
        ("fat32", std::env::var_os("CHESSFABLE_FAT32_ROOT")),
        ("exfat", std::env::var_os("CHESSFABLE_EXFAT_ROOT")),
    ];
    let missing_root = roots
        .iter()
        .any(|(_, root)| root.as_ref().is_none_or(|root| root.is_empty()));
    if std::env::var_os("GITHUB_ACTIONS").is_none() && missing_root {
        return;
    }
    assert!(!missing_root, "both volume roots are required in CI");
    for (filesystem, root) in roots {
        let volume = tempfile::tempdir_in(std::path::PathBuf::from(root.unwrap())).unwrap();
        let registry = tempfile::tempdir().unwrap();
        let path = volume.path().join("game.pgn");
        let mut authority = authority(&registry, Arc::new(TestClock::new(1)));
        let destination = authority
            .create_pgn_export_destination(&path, "game.pgn")
            .unwrap();
        fs::write(&path, b"1. e4 *").unwrap();
        let mut resolved = authority
            .resolve(destination.handle.path_ref(), PathOperation::WritePgn, &[])
            .unwrap();
        let snapshot = resolved.pgn_snapshot().unwrap();
        resolved
            .replace_pgn_atomic(
                snapshot,
                &tokio_util::sync::CancellationToken::new(),
                |source, temporary| {
                    let mut old = Vec::new();
                    source.read_to_end(&mut old)?;
                    assert_eq!(old, b"1. e4 *");
                    temporary.write_all(b"1. d4 *").map_err(Error::from)
                },
            )
            .unwrap_or_else(|error| panic!("{filesystem}: {error:?}"));
        assert_eq!(fs::read(&path).unwrap(), b"1. d4 *", "{filesystem}");
    }
}

#[test]
fn pgn_export_destination_binds_unicode_composition_variant() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("exports");
    fs::create_dir(&root).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let first = authority
        .create_pgn_export_destination(&root.join("José.pgn"), "José.pgn")
        .unwrap();
    fs::write(root.join("José.pgn"), b"1. d4 *").unwrap();
    let second = authority
        .create_pgn_export_destination(&root.join("Jose\u{301}.pgn"), "Jose\u{301}.pgn")
        .unwrap();
    let original = authority
        .resolve(first.handle.path_ref(), PathOperation::ReadPgn, &[])
        .unwrap();
    let variant = authority
        .resolve(second.handle.path_ref(), PathOperation::WritePgn, &[])
        .unwrap();
    assert_eq!(original.identity().unwrap(), variant.identity().unwrap());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    assert_eq!(fs::read(root.join("José.pgn")).unwrap(), b"1. d4 *");
}

#[test]
fn pgn_export_destination_succeeds_when_the_folder_exceeds_the_listing_bound() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("exports");
    fs::create_dir(&root).unwrap();
    for index in 0..=crate::infra::fs::MAX_DIRECTORY_LISTING_ENTRIES {
        fs::write(root.join(index.to_string()), b"").unwrap();
    }
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    authority
        .create_pgn_export_destination(&root.join("games.pgn"), "games.pgn")
        .unwrap();
    assert!(root.join("games.pgn").is_file());
}

#[cfg(target_os = "linux")]
#[test]
fn pgn_export_destination_refuses_existing_unicode_composition_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("exports");
    fs::create_dir(&root).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    fs::write(root.join("José.pgn"), b"1. d4 *").unwrap();
    authority
        .create_pgn_export_destination(&root.join("José.pgn"), "José.pgn")
        .unwrap();
    fs::write(root.join("Jose\u{301}.pgn"), b"1. e4 *").unwrap();
    let registry = fs::read(dir.path().join("registry.json")).unwrap();
    for name in ["José.pgn", "Jose\u{301}.pgn"] {
        let error = authority
            .create_pgn_export_destination(&root.join(name), name)
            .unwrap_err();
        assert!(matches!(error, Error::Conflict(ref message)
                if message == "PGN export filename already exists in multiple Unicode forms"));
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        assert_eq!(fs::read(root.join("José.pgn")).unwrap(), b"1. d4 *");
        assert_eq!(fs::read(root.join("Jose\u{301}.pgn")).unwrap(), b"1. e4 *");
        assert_eq!(
            fs::read(dir.path().join("registry.json")).unwrap(),
            registry
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn pgn_export_destination_preserves_ascii_case_distinctions() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("exports");
    fs::create_dir(&root).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    for name in ["Foo.pgn", "foo.pgn"] {
        authority
            .create_pgn_export_destination(&root.join(name), name)
            .unwrap();
    }
    assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
}

/// Exercises exclusive creation, both syncs, and promotion to a persistent capability.
#[test]
fn pgn_export_destination_is_persistent_writable_and_rejects_non_pgn_targets() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("export.pgn");
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let destination = authority
        .create_pgn_export_destination(&path, "export.pgn")
        .unwrap();
    assert!(path.is_file());
    let resolved = authority
        .resolve(destination.handle.path_ref(), PathOperation::ReadPgn, &[])
        .unwrap();
    let expected_parent = identity_from_open_file(resolved.parent().unwrap()).unwrap();
    assert_eq!(
        authority.parent_identity_for_test(destination.handle.path_ref()),
        Some((expected_parent.a, expected_parent.b))
    );
    drop(resolved);
    assert!(authority
        .resolve(destination.handle.path_ref(), PathOperation::WritePgn, &[],)
        .is_ok());
    assert!(matches!(
        authority.create_pgn_export_destination(&dir.path().join("export.txt"), "export.txt"),
        Err(Error::InvalidInput(_))
    ));
}

#[cfg(unix)]
#[test]
fn pgn_export_promotion_keeps_the_retained_parent_identity_across_registration_race() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("exports");
    fs::create_dir(&root).unwrap();
    let path = root.join("export.pgn");
    let parent = crate::infra::fs::open_parent_no_follow(&path).unwrap();
    let expected_parent = identity_from_open_file(&parent).unwrap();
    let moved = dir.path().join("exports.old");
    let root_for_hook = root.clone();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    PROMOTE_DIALOG_POST_ACQUIRE_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || {
                fs::rename(&root_for_hook, &moved).unwrap();
                fs::create_dir(&root_for_hook).unwrap();
                fs::hard_link(moved.join("export.pgn"), root_for_hook.join("export.pgn")).unwrap();
            })))
            .is_none());
    });

    let destination = authority
        .create_pgn_export_destination(&path, "export.pgn")
        .unwrap();

    assert_eq!(
        authority.parent_identity_for_test(destination.handle.path_ref()),
        Some((expected_parent.a, expected_parent.b))
    );
    assert!(matches!(
        authority.resolve(destination.handle.path_ref(), PathOperation::ReadPgn, &[]),
        Err(Error::Conflict(_))
    ));
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
}

#[test]
fn remove_workspace_entry_count_excludes_pending_unpersisted_removals() -> Result<(), Error> {
    use crate::infra::fs::{
        set_test_atomic_file_injector, AtomicFileFaultPoint, AtomicWriterInjector,
    };

    struct RegistryWriteFailure;
    impl AtomicWriterInjector for RegistryWriteFailure {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == AtomicFileFaultPoint::Write {
                Err(std::io::Error::other("registry write failure"))
            } else {
                Ok(())
            }
        }
    }

    let (_directory, mut authority, workspace, root) = directory_listing_bound_fixture()?;
    let victim = root.join("victim");
    fs::create_dir(&victim)?;
    let entry = authority.register_workspace_child_observed_with_parent(
        &workspace,
        &[OsString::from("victim")],
        "victim",
        IdentityBinding::new(identity(&victim)?, Some(identity(&root)?)),
        true,
        PathOperation::ReadPgn,
    )?;
    let executable_path = victim.join("engine");
    fs::write(&executable_path, b"engine")?;
    let executable = authority
        .register_engine_file(&executable_path, "engine")?
        .id;
    let mut pending_entries = Vec::new();
    for name in ["victim/pending.pgn", "outside.pgn"] {
        let path = root.join(name);
        fs::write(&path, b"*")?;
        let components = Path::new(name)
            .components()
            .map(|component| component.as_os_str().to_os_string())
            .collect::<Vec<_>>();
        let pending = authority.register_workspace_child_observed_with_parent(
            &workspace,
            &components,
            name,
            IdentityBinding::new(identity(&path)?, Some(identity(path.parent().unwrap())?)),
            false,
            PathOperation::ReadPgn,
        )?;
        pending_entries.push((path, pending));
    }

    let mut dropped = Vec::new();
    for (path, pending) in &pending_entries {
        fs::remove_file(path)?;
        let persistent_before = authority.persistent.clone();
        set_test_atomic_file_injector(Some(Arc::new(RegistryWriteFailure)));
        let result = authority.remove_workspace_entry(
            pending,
            WorkspaceRemovalStatus::Complete,
            &mut dropped,
        );
        set_test_atomic_file_injector(None);
        assert!(result.is_err());
        assert!(authority.persistent == persistent_before);
        assert!(authority
            .pending_unpersisted_removals
            .contains(&pending.path_ref().id));
    }

    let persistent_before = authority.persistent.clone();
    let pending_before = authority.pending_unpersisted_removals.clone();
    assert_eq!(pending_before.len(), 2);
    fs::remove_dir_all(&victim)?;
    let (durability, count) =
        authority.remove_workspace_entry(&entry, WorkspaceRemovalStatus::Complete, &mut dropped)?;

    assert!(matches!(durability, CommitDurability::Durable));
    let newly_removed = persistent_before
        .keys()
        .filter(|id| !authority.persistent.contains_key(*id) && !pending_before.contains(*id))
        .count();
    assert_eq!(count, newly_removed);
    assert_eq!(count, 2);
    assert_eq!(persistent_before.len() - authority.persistent.len(), 4);
    assert!(authority.pending_unpersisted_removals.is_empty());
    assert_eq!(dropped, vec![executable]);
    Ok(())
}

#[test]
fn practice_authorization_checks_membership_and_purpose_before_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("practice.pgn");
    fs::write(&file, b"file").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let stored = StoredEntry {
        id: PathRef {
            id: "practice".into(),
        },
        display_name: "practice".into(),
        class: PathClass::PersistentFile,
        purpose: Some(EntryPurpose::PgnReadOnlyFile),
        operations: vec![PathOperation::ReadPgn],
        path: NativePath::from_path(&file),
        identity: identity(&file).unwrap(),
        parent_identity: None,
        target_is_dir: false,
        practice_key: None,
    };
    authority.persistent.insert(
        "practice".into(),
        Entry {
            stored,
            availability: PathAvailability::Available,
        },
    );
    let id = PathRef {
        id: "practice".into(),
    };
    authority.authorize_practice_deck(&id, true).unwrap();
    fs::remove_file(&file).unwrap();
    authority.authorize_practice_deck(&id, true).unwrap();

    let wrong_path = dir.path().join("wrong.pgn");
    fs::write(&wrong_path, b"file").unwrap();
    let wrong = StoredEntry {
        id: PathRef { id: "wrong".into() },
        display_name: "wrong".into(),
        class: PathClass::PersistentFile,
        purpose: Some(EntryPurpose::DatabaseFile),
        operations: vec![],
        path: NativePath::from_path(&wrong_path),
        identity: identity(&wrong_path).unwrap(),
        parent_identity: None,
        target_is_dir: false,
        practice_key: None,
    };
    authority.persistent.insert(
        "wrong".into(),
        Entry {
            stored: wrong,
            availability: PathAvailability::Available,
        },
    );
    assert!(authority
        .authorize_practice_deck(&PathRef { id: "wrong".into() }, true)
        .is_err());
    assert!(authority
        .authorize_practice_deck(
            &PathRef {
                id: "missing".into()
            },
            true
        )
        .is_err());
    authority
        .pending_unpersisted_removals
        .insert("practice".into());
    assert!(authority.authorize_practice_deck(&id, true).is_err());
    authority.pending_unpersisted_removals.clear();
    assert!(authority.authorize_practice_deck(&id, false).is_ok());
}

#[test]
fn practice_commands_refuse_bad_ids_before_opening_the_practice_root() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("practice.pgn");
    fs::write(&file, b"file").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let stored = |id: &str, operations| StoredEntry {
        id: PathRef { id: id.into() },
        display_name: id.into(),
        class: PathClass::PersistentFile,
        purpose: Some(EntryPurpose::PgnReadOnlyFile),
        operations,
        path: NativePath::from_path(&file),
        identity: identity(&file).unwrap(),
        parent_identity: None,
        target_is_dir: false,
        practice_key: None,
    };

    authority.persistent.insert(
        "staged".into(),
        Entry {
            stored: stored("staged", vec![PathOperation::ReadPgn]),
            availability: PathAvailability::Available,
        },
    );
    authority
        .pending_unpersisted_removals
        .insert("staged".into());
    authority.persistent.insert(
        "wrong-purpose".into(),
        Entry {
            stored: stored("wrong-purpose", Vec::new()),
            availability: PathAvailability::Available,
        },
    );
    authority.persistent.insert(
        "revoked".into(),
        Entry {
            stored: stored("revoked", vec![PathOperation::ReadPgn]),
            availability: PathAvailability::Available,
        },
    );
    authority.persistent.remove("revoked");

    let command_authority = crate::infra::path_authority::SharedPathAuthority::installed(authority);
    for id in ["unknown", "revoked", "staged", "wrong-purpose"] {
        assert!(
            crate::practice::authorize_practice_command(&command_authority, id, true).is_err(),
            "ordinary practice command authorization must refuse {id}"
        );
    }
    assert!(crate::practice::authorize_practice_command(
        &command_authority,
        "wrong-purpose",
        false
    )
    .is_ok());
    assert!(crate::practice::authorize_practice_command(
        &command_authority,
        "wrong-purpose",
        false
    )
    .is_ok());
    assert!(
        !dir.path().join("practice").exists(),
        "authorization must not open the practice root"
    );
}

fn assert_unknown_path_capability(error: Error) {
    assert_eq!(error.category(), ErrorCategory::MissingResource);
    assert!(matches!(error, Error::UnknownPathCapability), "{error:?}");
}

#[test]
fn resolve_never_issued_id_reports_unknown_path_capability() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("revoked.pgn");
    fs::write(&file, b"*").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let error = authority
        .resolve(
            &PathRef {
                id: "never-issued".into(),
            },
            PathOperation::ReadPgn,
            &[],
        )
        .err()
        .expect("never-issued id must fail");
    assert_unknown_path_capability(error);

    let stored = StoredEntry {
        id: PathRef {
            id: "revoked".into(),
        },
        display_name: "revoked".into(),
        class: PathClass::PersistentFile,
        purpose: Some(EntryPurpose::PgnReadOnlyFile),
        operations: vec![PathOperation::ReadPgn],
        path: NativePath::from_path(&file),
        identity: identity(&file).unwrap(),
        parent_identity: None,
        target_is_dir: false,
        practice_key: None,
    };
    authority.persistent.insert(
        "revoked".into(),
        Entry {
            stored,
            availability: PathAvailability::Available,
        },
    );
    authority.persistent.remove("revoked");
    let removed = authority
        .resolve(
            &PathRef {
                id: "revoked".into(),
            },
            PathOperation::ReadPgn,
            &[],
        )
        .err()
        .expect("removed persistent id must fail");
    assert_unknown_path_capability(removed);
}

#[test]
fn resolve_consumed_or_expired_dialog_grant_reports_unknown_path_capability() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("grant.pgn");
    fs::write(&file, b"*").unwrap();
    let clock = Arc::new(TestClock::new(1));
    let mut authority = authority(&dir, clock.clone());
    let consumed = authority
        .grant_dialog(
            &file,
            "grant.pgn",
            PathClass::SingleDialogGrant,
            PathOperation::ReadPgn,
            Duration::from_secs(30),
            1,
        )
        .unwrap();
    authority
        .resolve(&consumed, PathOperation::ReadPgn, &[])
        .unwrap();
    let consumed_error = authority
        .resolve(&consumed, PathOperation::ReadPgn, &[])
        .err()
        .expect("consumed grant must fail");
    assert_unknown_path_capability(consumed_error);

    let expired = authority
        .grant_dialog(
            &file,
            "grant.pgn",
            PathClass::SingleDialogGrant,
            PathOperation::ReadPgn,
            Duration::from_secs(1),
            1,
        )
        .unwrap();
    clock.advance(1);
    let expired_error = authority
        .resolve(&expired, PathOperation::ReadPgn, &[])
        .err()
        .expect("expired grant must fail");
    assert_unknown_path_capability(expired_error);
}

/// The leaves are written out verbatim rather than read back from the enum. A leaf is the
/// identity of an existing user's app-data directory, so a test that asks the enum what
/// its leaf is would copy a mistyped one into its own assertion and stay green forever.
#[test]
fn ensure_app_owned_default_dir_creates_each_root_under_its_own_leaf() {
    let dir = tempfile::tempdir().unwrap();
    for &(root, leaf) in APP_OWNED_DEFAULT_ROOT_LEAVES {
        let created =
            ensure_app_owned_default_dir(&AppDataDir::for_test(dir.path()), root).unwrap();
        // The app-data root is canonical; a Windows tempdir is spelled in 8.3 form.
        assert_eq!(
            created.path(),
            canonical_binding(&dir.path().join(leaf)).unwrap()
        );
        assert!(
            created.path().is_dir(),
            "{root:?} must create the directory {leaf}"
        );
    }
}

#[test]
fn ensure_app_owned_default_dir_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let first = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::Databases,
    )
    .expect("first call creates the root");
    let second = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::Databases,
    )
    .expect("second call accepts the existing root");
    assert_eq!(first.path(), second.path());
    assert!(second.path().is_dir());
}

#[test]
fn default_root_location_resides_at_startup_path_and_reacquires() {
    let app_data = tempfile::tempdir().unwrap();
    let app_data_dir = AppDataDir::for_test(app_data.path());
    let location = app_data_dir.startup_location(AppOwnedDefaultRoot::Credentials);
    let directory =
        ensure_app_owned_default_dir(&app_data_dir, AppOwnedDefaultRoot::Credentials).unwrap();

    assert!(directory.resides_at(&location).unwrap());
    let reacquired = location.reacquire().unwrap();
    assert!(reacquired.resides_at(&location).unwrap());
}

#[cfg(unix)]
#[test]
fn default_root_location_rejects_replaced_and_missing_directories() {
    for recreate in [true, false] {
        let app_data = tempfile::tempdir().unwrap();
        let app_data_dir = AppDataDir::for_test(app_data.path());
        let location = app_data_dir.startup_location(AppOwnedDefaultRoot::Credentials);
        let directory =
            ensure_app_owned_default_dir(&app_data_dir, AppOwnedDefaultRoot::Credentials).unwrap();
        let root = app_data.path().join("credentials");
        fs::rename(&root, app_data.path().join("credentials-renamed")).unwrap();
        if recreate {
            fs::create_dir(&root).unwrap();
        }

        assert!(!directory.resides_at(&location).unwrap());
    }
}

#[cfg(unix)]
#[test]
fn default_root_location_rejects_a_symlinked_leaf() {
    use std::os::unix::fs::symlink;

    let app_data = tempfile::tempdir().unwrap();
    let app_data_dir = AppDataDir::for_test(app_data.path());
    let location = app_data_dir.startup_location(AppOwnedDefaultRoot::Credentials);
    let directory =
        ensure_app_owned_default_dir(&app_data_dir, AppOwnedDefaultRoot::Credentials).unwrap();
    let root = app_data.path().join("credentials");
    let retained = app_data.path().join("credentials-renamed");
    let target = app_data.path().join("target");
    fs::create_dir(&target).unwrap();
    fs::rename(&root, &retained).unwrap();
    symlink(&target, &root).unwrap();

    assert!(!directory.resides_at(&location).unwrap());
}

#[cfg(unix)]
#[test]
fn default_root_location_propagates_unreadable_parent_errors() {
    use std::os::unix::fs::PermissionsExt;

    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let app_data = tempfile::tempdir().unwrap();
    let app_data_dir = AppDataDir::for_test(app_data.path());
    let location = app_data_dir.startup_location(AppOwnedDefaultRoot::Credentials);
    let directory =
        ensure_app_owned_default_dir(&app_data_dir, AppOwnedDefaultRoot::Credentials).unwrap();
    let original = fs::metadata(app_data.path()).unwrap().permissions().mode() & 0o777;
    fs::set_permissions(app_data.path(), fs::Permissions::from_mode(0o0)).unwrap();
    let result = directory.resides_at(&location);
    fs::set_permissions(app_data.path(), fs::Permissions::from_mode(original)).unwrap();

    assert!(
        matches!(result, Err(Error::Io(ref error)) if error.kind() == std::io::ErrorKind::PermissionDenied)
    );
}

#[test]
fn ensure_app_owned_default_dir_rejects_a_regular_file_as_io() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("db"), b"not a directory").unwrap();
    let error = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::Databases,
    )
    .expect_err("a regular file at the leaf must be refused");
    assert!(
        matches!(error, Error::Io(_)),
        "the refusal must stay Error::Io, which renders fixed text: {error:?}"
    );
}

/// `open_regular_relative` must split the relative spelling itself. A walk built on
/// `Path::components()` drops the interior empty segment and the `.`, so `"a//b"` would
/// normalise to the real `a/b` and open it. The file exists so a post-normalisation ENOENT
/// cannot make the refusal pass by accident; this is the Windows-visible pin.
#[test]
fn authorized_dir_relative_open_rejects_normalised_spellings() {
    let dir = tempfile::tempdir().unwrap();
    let database = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::Databases,
    )
    .unwrap();
    fs::create_dir(database.path().join("a")).unwrap();
    fs::write(database.path().join("a/b"), b"must not open").unwrap();
    for relative in ["a//b", "./x"] {
        assert!(
            database.open_regular_relative(Path::new(relative)).is_err(),
            "{relative} must be refused"
        );
    }
}

/// Positive nested open on every target. The unix-only
/// `authorized_dir_opens_nested_regular_file` cannot see the Windows `relative_components`
/// `/` split or the ungated `open_directory_at` walk; this one can.
#[test]
fn authorized_dir_opens_a_nested_regular_file() {
    use std::io::Read as _;
    let dir = tempfile::tempdir().unwrap();
    let database = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::Databases,
    )
    .unwrap();
    fs::create_dir(database.path().join("a")).unwrap();
    fs::write(database.path().join("a/b"), b"nested bytes").unwrap();
    let mut opened = database
        .open_regular_relative(Path::new("a/b"))
        .expect("a/b must open through the retained directory");
    let mut bytes = Vec::new();
    opened.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"nested bytes");
}

#[test]
fn database_file_target_probe_current_preserves_full_precision_mtime() {
    use std::time::{Duration, UNIX_EPOCH};

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("database.db3");
    fs::write(&path, b"database").unwrap();
    let target = DatabaseFileTarget::for_test_path(&path).unwrap();

    let first_time = UNIX_EPOCH + Duration::new(1_700_000_000, 123_456_789);
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(first_time)
        .unwrap();
    let first = target.probe_current().unwrap();
    assert_eq!(
        first.modified,
        fs::metadata(&path).unwrap().modified().unwrap()
    );

    let second_time = UNIX_EPOCH + Duration::new(1_700_000_000, 987_654_321);
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(second_time)
        .unwrap();
    let second = target.probe_current().unwrap();
    assert_eq!(
        second.modified,
        fs::metadata(&path).unwrap().modified().unwrap()
    );
    assert_ne!(first.modified, second.modified);
}

pub(crate) fn attachment_resource(
    authority: &mut PathAuthority,
    path: &Path,
) -> EngineResourceHandle {
    fs::write(path, b"resource").unwrap();
    let grant = authority
        .grant_dialog(
            path,
            "resource",
            PathClass::SingleDialogGrant,
            PathOperation::EngineResourceRead,
            Duration::from_secs(30),
            1,
        )
        .unwrap();
    authority
        .promote_engine_resource(&grant, EngineResourceHandleKind::File, "resource")
        .unwrap()
}

#[test]
fn attachment_validation_and_loaded_provisional_startup_sweep_are_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.nnue");
    let registry = dir.path().join("registry.json");
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let handle = attachment_resource(&mut authority, &path);
    let before = fs::read(&registry).unwrap();
    let unknown = PathRef {
        id: "unknown".into(),
    };
    assert!(authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![unknown.clone()],
        })
        .is_ok());
    assert_eq!(fs::read(&registry).unwrap(), before);
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: None,
            abandoned_ids: vec![unknown],
            startup: false,
        })
        .unwrap();
    assert_eq!(fs::read(&registry).unwrap(), before);

    let ordinary_path = dir.path().join("ordinary.pgn");
    fs::write(&ordinary_path, b"*").unwrap();
    let ordinary = authority
        .migrate_legacy_os_path(
            ordinary_path.into_os_string(),
            "ordinary",
            PathClass::PersistentFile,
            vec![PathOperation::ReadPgn],
        )
        .unwrap();
    let before_nonattachment = fs::read(&registry).unwrap();
    assert!(matches!(
        authority.reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: None,
            abandoned_ids: vec![ordinary.id],
            startup: false,
        }),
        Err(Error::InvalidInput(_))
    ));
    assert_eq!(fs::read(&registry).unwrap(), before_nonattachment);

    drop(authority);
    let mut reloaded = PathAuthority::open(registry, vec![]).unwrap();
    reloaded
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: Some(vec![]),
            abandoned_ids: vec![],
            startup: true,
        })
        .unwrap();
    assert!(!reloaded.persistent.contains_key(&handle.id.id));

    let fresh_path = dir.path().join("fresh.nnue");
    let fresh = attachment_resource(&mut reloaded, &fresh_path);
    reloaded
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: Some(vec![]),
            abandoned_ids: vec![],
            startup: true,
        })
        .unwrap();
    assert!(reloaded.persistent.contains_key(&fresh.id.id));
}

#[test]
fn attachment_action_validation_matrix_preserves_memory_and_disk() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let resource_path = dir.path().join("resource.nnue");
    let ordinary_path = dir.path().join("ordinary.pgn");
    fs::write(&ordinary_path, b"*").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let attachment = attachment_resource(&mut authority, &resource_path);
    let ordinary = authority
        .migrate_legacy_os_path(
            ordinary_path.into_os_string(),
            "ordinary",
            PathClass::PersistentFile,
            vec![PathOperation::ReadPgn],
        )
        .unwrap();
    let before = fs::read(&registry).unwrap();
    let persistent_before = authority.persistent.clone();
    let provisional_before = authority.provisional_attachments.clone();
    let retired_before = authority.retired_attachments.clone();
    let cleanup_before = authority.image_cleanup.clone();
    let assert_unchanged = |authority: &PathAuthority| {
        assert_eq!(fs::read(&registry).unwrap(), before);
        assert!(authority.persistent == persistent_before);
        assert_eq!(authority.provisional_attachments, provisional_before);
        assert!(authority.retired_attachments == retired_before);
        assert_eq!(authority.image_cleanup, cleanup_before);
    };
    let oversized_retained = (0..=authority
        .authority_id_input_limit()
        .saturating_add(MAX_OWNER_UNKNOWN_IDS))
        .map(|index| PathRef {
            id: format!("oversized-{index}"),
        })
        .collect::<Vec<_>>();
    assert!(matches!(
        authority.reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: oversized_retained,
        }),
        Err(Error::ResourceLimit(_))
    ));
    assert_unchanged(&authority);
    let oversized_abandoned = (0..=authority.authority_id_input_limit())
        .map(|index| PathRef {
            id: format!("oversized-{index}"),
        })
        .collect();
    assert!(matches!(
        authority.reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: Some(vec![]),
            abandoned_ids: oversized_abandoned,
            startup: false,
        }),
        Err(Error::ResourceLimit(_))
    ));
    assert_unchanged(&authority);
    assert!(matches!(
        authority.reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: None,
            abandoned_ids: vec![],
            startup: true,
        }),
        Err(Error::ResourceLimit(_))
    ));
    assert_unchanged(&authority);
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![PathRef {
                id: "unknown-retained".into(),
            }],
        })
        .unwrap();
    assert_unchanged(&authority);
    assert!(matches!(
        authority.reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![ordinary.id.clone()],
        }),
        Err(Error::InvalidInput(_))
    ));
    assert_unchanged(&authority);
    assert!(matches!(
        authority.reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: None,
            abandoned_ids: vec![ordinary.id],
            startup: false,
        }),
        Err(Error::InvalidInput(_))
    ));
    assert_unchanged(&authority);
    assert!(authority.persistent.contains_key(&attachment.id.id));
}

#[test]
fn stale_retained_attachment_id_keeps_named_live_attachment_and_sweeps_the_omitted_one() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let first = attachment_resource(&mut authority, &dir.path().join("first.nnue"));
    let second = attachment_resource(&mut authority, &dir.path().join("second.nnue"));
    let ordinary_path = dir.path().join("ordinary.pgn");
    fs::write(&ordinary_path, b"*").unwrap();
    let ordinary = authority
        .migrate_legacy_os_path(
            ordinary_path.into_os_string(),
            "ordinary",
            PathClass::PersistentFile,
            vec![PathOperation::ReadPgn],
        )
        .unwrap();
    drop(authority);
    let mut reloaded = PathAuthority::open(registry.clone(), vec![]).unwrap();
    let unknown = PathRef {
        id: "unknown-retained".into(),
    };
    let assert_unknown_absent = |authority: &PathAuthority| {
        assert!(!authority.persistent.contains_key(&unknown.id));
        assert!(!authority.retired_attachments.contains_key(&unknown.id));
        assert!(!authority.provisional_attachments.contains(&unknown.id));
        assert!(!authority.image_cleanup.contains_key(&unknown.id));
    };
    reloaded
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![first.id.clone(), unknown.clone()],
        })
        .unwrap();
    assert!(reloaded.persistent.contains_key(&first.id.id));
    assert!(reloaded.persistent.contains_key(&second.id.id));
    assert_unknown_absent(&reloaded);

    reloaded.provisional_attachments.insert(first.id.id.clone());
    reloaded.image_cleanup.insert(
        first.id.id.clone(),
        reloaded
            .persistent
            .get(&first.id.id)
            .expect("live attachment")
            .stored
            .clone(),
    );
    let before = fs::read(&registry).unwrap();
    let persistent_before = reloaded.persistent.clone();
    let provisional_before = reloaded.provisional_attachments.clone();
    let retired_before = reloaded.retired_attachments.clone();
    let cleanup_before = reloaded.image_cleanup.clone();
    assert!(matches!(
        reloaded.reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![first.id.clone(), ordinary.id, unknown.clone()],
        }),
        Err(Error::InvalidInput(_))
    ));
    assert_eq!(fs::read(&registry).unwrap(), before);
    assert!(reloaded.persistent == persistent_before);
    assert_eq!(reloaded.provisional_attachments, provisional_before);
    assert!(reloaded.retired_attachments == retired_before);
    assert_eq!(reloaded.image_cleanup, cleanup_before);

    reloaded
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: Some(vec![first.id.clone(), unknown.clone()]),
            abandoned_ids: vec![],
            startup: true,
        })
        .unwrap();
    assert!(reloaded.persistent.contains_key(&first.id.id));
    assert!(!reloaded.retired_attachments.contains_key(&first.id.id));
    assert!(!reloaded.persistent.contains_key(&second.id.id));
    assert!(reloaded.retired_attachments.contains_key(&second.id.id));
    assert_unknown_absent(&reloaded);
}

#[test]
fn stale_attachment_raw_cap_admits_unknown_ids_up_to_existing_headroom() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    authority.save().unwrap();
    let before = fs::read(&registry).unwrap();
    let persistent_before = authority.persistent.clone();
    let provisional_before = authority.provisional_attachments.clone();
    let retired_before = authority.retired_attachments.clone();
    let cleanup_before = authority.image_cleanup.clone();
    let assert_unchanged = |authority: &PathAuthority| {
        assert_eq!(fs::read(&registry).unwrap(), before);
        assert!(authority.persistent == persistent_before);
        assert_eq!(authority.provisional_attachments, provisional_before);
        assert!(authority.retired_attachments == retired_before);
        assert_eq!(authority.image_cleanup, cleanup_before);
    };
    let unknown_ids = |limit| {
        (0..=limit)
            .map(|index| PathRef {
                id: format!("unknown-{index}"),
            })
            .collect()
    };
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: unknown_ids(authority.authority_id_input_limit()),
        })
        .unwrap();
    assert_unchanged(&authority);
    let exact_cap = authority
        .authority_id_input_limit()
        .saturating_add(MAX_OWNER_UNKNOWN_IDS);
    let exact_cap_ids = (0..exact_cap)
        .map(|index| PathRef {
            id: format!("unknown-{index}"),
        })
        .collect::<Vec<_>>();
    assert_eq!(exact_cap_ids.len(), exact_cap);
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: exact_cap_ids,
        })
        .unwrap();
    assert_unchanged(&authority);
    assert!(matches!(
        authority.reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: unknown_ids(
                authority
                    .authority_id_input_limit()
                    .saturating_add(MAX_OWNER_UNKNOWN_IDS)
            ),
        }),
        Err(Error::ResourceLimit(_))
    ));
    assert_unchanged(&authority);
}

#[test]
fn retired_attachment_is_durably_readopted_and_cleanup_only_id_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let image_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::EngineImages,
    )
    .unwrap();
    let leaf = uuid::Uuid::new_v4().to_string();
    let (_, identity) = image_dir
        .atomic_replace_leaf_identified(OsStr::new(&leaf), |file| {
            file.write_all(b"image").map_err(Error::from)
        })
        .unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let image = authority
        .register_engine_image(&image_dir, OsStr::new(&leaf), identity, "image".into())
        .unwrap();
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![image.id.clone()],
        })
        .unwrap();
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: Some(vec![]),
            abandoned_ids: vec![],
            startup: false,
        })
        .unwrap();
    assert!(!authority.persistent.contains_key(&image.id.id));
    assert!(authority.retired_attachments.contains_key(&image.id.id));
    assert!(authority.image_cleanup.contains_key(&image.id.id));
    let unknown = PathRef {
        id: "unknown-retained".into(),
    };
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![image.id.clone(), unknown.clone()],
        })
        .unwrap();
    assert!(authority.persistent.contains_key(&image.id.id));
    assert!(!authority.retired_attachments.contains_key(&image.id.id));
    assert!(!authority.image_cleanup.contains_key(&image.id.id));
    assert!(!authority.persistent.contains_key(&unknown.id));
    assert!(!authority.retired_attachments.contains_key(&unknown.id));
    assert!(!authority.provisional_attachments.contains(&unknown.id));
    assert!(!authority.image_cleanup.contains_key(&unknown.id));
    drop(authority);
    let reopened = PathAuthority::open(registry, vec![]).unwrap();
    assert!(reopened.persistent.contains_key(&image.id.id));
    assert!(!reopened.image_cleanup.contains_key(&image.id.id));

    for prepare in [true, false] {
        let mut f = EngineImageCleanupFixture::new();
        assert_eq!(
            f.authority
                .record_engine_image_cleanup(&f.image_dir, &f.leaf, f.installed)
                .diagnostic(),
            "recorded"
        );
        let id = f.authority.image_cleanup.keys().next().unwrap().clone();
        let cleanup_before = f.authority.image_cleanup.clone();
        assert!(!f.authority.persistent.contains_key(&id));
        assert!(!f.authority.retired_attachments.contains_key(&id));
        let retained_ids = vec![PathRef { id: id.clone() }];
        let action = if prepare {
            EngineAttachmentAction::Prepare { retained_ids }
        } else {
            EngineAttachmentAction::Reconcile {
                retained_ids: Some(retained_ids),
                abandoned_ids: vec![],
                startup: false,
            }
        };
        f.authority.reconcile_engine_attachments(action).unwrap();
        assert_eq!(f.authority.image_cleanup, cleanup_before);
        assert!(!f.authority.persistent.contains_key(&id));
        assert!(!f.authority.retired_attachments.contains_key(&id));
        assert!(!f.authority.provisional_attachments.contains(&id));
    }
}

#[test]
fn stale_only_startup_snapshot_retires_omitted_loaded_attachments() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let first = attachment_resource(&mut authority, &dir.path().join("first.nnue"));
    let second = attachment_resource(&mut authority, &dir.path().join("second.nnue"));
    drop(authority);
    let mut reloaded = PathAuthority::open(registry, vec![]).unwrap();
    let unknown = PathRef {
        id: "unknown-retained".into(),
    };
    reloaded
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: Some(vec![unknown.clone()]),
            abandoned_ids: vec![],
            startup: true,
        })
        .unwrap();
    for attachment in [first, second] {
        assert!(!reloaded.persistent.contains_key(&attachment.id.id));
        assert!(reloaded.retired_attachments.contains_key(&attachment.id.id));
    }
    assert!(!reloaded.persistent.contains_key(&unknown.id));
    assert!(!reloaded.retired_attachments.contains_key(&unknown.id));
    assert!(!reloaded.provisional_attachments.contains(&unknown.id));
    assert!(!reloaded.image_cleanup.contains_key(&unknown.id));
}

#[test]
fn picked_engine_replaced_at_same_path_gets_fresh_capability() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine");
    fs::write(&path, b"engine").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let first = authority.register_engine_file(&path, "engine").unwrap();
    let original_identity = identity(&path).unwrap();

    let replacement = dir.path().join("replacement");
    fs::write(&replacement, b"replacement").unwrap();
    fs::remove_file(&path).unwrap();
    fs::rename(&replacement, &path).unwrap();
    assert_ne!(identity(&path).unwrap(), original_identity);

    let second = authority.register_engine_file(&path, "engine").unwrap();
    assert_ne!(second.id, first.id);
    assert!(authority
        .resolve(second.path_ref(), PathOperation::EngineBinaryInspect, &[])
        .is_ok());

    let third = authority.register_engine_file(&path, "engine").unwrap();
    assert_eq!(third.id, second.id);

    assert!(authority
        .resolve(first.path_ref(), PathOperation::EngineBinaryInspect, &[])
        .is_err());
    assert!(authority.persistent.contains_key(&first.id.id));
}

#[test]
fn promote_dialog_mints_a_fresh_capability_for_a_replaced_pgn_file() {
    fn promote(authority: &mut PathAuthority, path: &Path) -> PathCommit {
        let operations = vec![PathOperation::ReadPgn, PathOperation::WritePgn];
        let grant = authority
            .grant_dialog_operations(
                path,
                "study",
                PathClass::BoundedDialogGrant,
                operations.clone(),
                Duration::from_secs(60),
                1,
            )
            .unwrap();
        authority
            .promote_dialog(&grant, PathClass::PersistentFile, "study", operations)
            .unwrap()
    }
    fn btree_first_same_path_id(authority: &PathAuthority, path: &Path) -> Option<String> {
        authority.persistent.values().find_map(|entry| {
            (entry.stored.class == PathClass::PersistentFile
                && entry.stored.purpose == Some(EntryPurpose::PgnFile)
                && entry.stored.path.to_path().ok().as_deref() == Some(path))
            .then(|| entry.stored.id.id.clone())
        })
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("study.pgn");
    fs::write(&path, b"1. e4 *").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let mut newest = promote(&mut authority, &path);
    for round in 0..5 {
        let before = identity(&path).unwrap();
        replace_by_rename_over(&path, format!("1. e{round} *").as_bytes());
        assert_ne!(identity(&path).unwrap(), before);
        let picked = promote(&mut authority, &path);
        assert_ne!(picked.id, newest.id);
        assert!(authority.persistent.contains_key(&newest.id.id));
        newest = picked;
    }
    let mut extra = 0u32;
    while btree_first_same_path_id(&authority, &path).as_ref() == Some(&newest.id.id) {
        extra += 1;
        let before = identity(&path).unwrap();
        replace_by_rename_over(&path, format!("1. d{extra} *").as_bytes());
        assert_ne!(identity(&path).unwrap(), before);
        newest = promote(&mut authority, &path);
    }
    let first_unchanged = promote(&mut authority, &path);
    assert_eq!(first_unchanged.id, newest.id);
    let second_unchanged = promote(&mut authority, &path);
    assert_eq!(second_unchanged.id, newest.id);
    assert!(authority
        .resolve(&newest.id, PathOperation::ReadPgn, &[])
        .is_ok());
}
