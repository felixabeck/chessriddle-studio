use super::*;
use crate::infra::fs::{
    set_test_atomic_file_injector, windows_test_junction, AtomicFileFaultPoint,
    AtomicWriterInjector,
};
use std::{
    ffi::OsStr,
    ptr::null,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use windows_sys::{
    Wdk::Storage::FileSystem::FILE_OPEN,
    Win32::{
        Foundation::{GENERIC_READ, GENERIC_WRITE},
        Storage::FileSystem::SYNCHRONIZE,
    },
};

#[test]
fn listing_child_windows_prepare_permission_is_partial_only_for_databases() {
    for puzzle in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let root_path = directory.path().join("root");
        fs::create_dir(&root_path).unwrap();
        fs::write(root_path.join("blocked.db3"), b"blocked").unwrap();
        fs::write(root_path.join("healthy.db3"), b"healthy").unwrap();
        let mut authority =
            PathAuthority::open(directory.path().join("registry.json"), vec![]).unwrap();
        let (root, purpose, operation) = if puzzle {
            let root = authority
                .get_or_create_puzzle_root(&root_path, "Puzzles", None)
                .unwrap();
            (
                root.path_ref().clone(),
                EntryPurpose::PuzzleFile,
                PathOperation::PuzzleRead,
            )
        } else {
            let root = authority
                .get_or_create_database_root(&root_path, "Databases", None)
                .unwrap();
            (
                root.path_ref().clone(),
                EntryPurpose::DatabaseFile,
                PathOperation::DatabaseRead,
            )
        };
        let before = authority.persistent.clone();
        let result = authority.reconcile_db3_listing(
            &root,
            purpose,
            operation,
            &CancellationToken::new(),
            |authority, filename, display, observed| {
                if filename == OsStr::new("blocked.db3") {
                    return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied).into());
                }
                let entry = if puzzle {
                    authority.prepare_puzzle_listing_child(
                        &PuzzleRootHandle::new(root.clone()),
                        &filename,
                        observed,
                    )?
                } else {
                    authority.prepare_database_listing_child(
                        &DatabaseRootHandle::new(root.clone()),
                        &filename,
                        display,
                        observed,
                        true,
                    )?
                };
                Ok((entry, ()))
            },
        );
        if puzzle {
            assert_eq!(result.unwrap_err().category(), ErrorCategory::Permission);
            assert!(authority.persistent == before);
        } else {
            let (entries, unread) = result.unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(unread.len(), 1);
            assert_eq!(unread[0].category, ErrorCategory::Permission);
        }
    }
}

#[test]
fn missing_entry_windows_open_status_producer() {
    use windows_sys::Win32::Foundation::{
        STATUS_ACCESS_DENIED, STATUS_BAD_NETWORK_NAME, STATUS_BAD_NETWORK_PATH,
        STATUS_NO_SUCH_FILE, STATUS_OBJECT_NAME_COLLISION, STATUS_OBJECT_NAME_NOT_FOUND,
        STATUS_OBJECT_PATH_NOT_FOUND,
    };
    for (status, missing) in [
        (STATUS_OBJECT_NAME_NOT_FOUND, true),
        (STATUS_NO_SUCH_FILE, true),
        (STATUS_OBJECT_PATH_NOT_FOUND, true),
        (STATUS_BAD_NETWORK_PATH, false),
        (STATUS_BAD_NETWORK_NAME, false),
        (STATUS_ACCESS_DENIED, false),
        (STATUS_OBJECT_NAME_COLLISION, false),
    ] {
        let error = windows_open_status_error(status);
        assert_eq!(error.is_missing_entry(), missing, "{status:#x}: {error:?}");
    }
}

#[test]
fn windows_child_open_maps_missing_entry_and_refuses_wrong_target_types() {
    let dir = tempfile::tempdir().unwrap();
    let parent = open_windows_nofollow(dir.path(), false).unwrap();
    let read_access = SYNCHRONIZE | GENERIC_READ;
    let absent = open_windows_child(
        &parent,
        OsStr::new("missing"),
        FILE_OPEN,
        read_access,
        null(),
        false,
        true,
    )
    .expect_err("an absent child must fail");
    assert!(absent.is_missing_entry(), "{absent:?}");

    fs::create_dir(dir.path().join("directory")).unwrap();
    fs::write(dir.path().join("file"), b"file").unwrap();
    assert!(open_windows_child(
        &parent,
        OsStr::new("directory"),
        FILE_OPEN,
        read_access,
        null(),
        false,
        true,
    )
    .is_err());
    assert!(open_windows_child(
        &parent,
        OsStr::new("file"),
        FILE_OPEN,
        read_access | GENERIC_WRITE,
        null(),
        true,
        true,
    )
    .is_err());
}

#[test]
fn windows_child_open_refuses_a_junction_object() {
    let dir = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    windows_test_junction(&dir.path().join("junction"), target.path());
    let parent = open_windows_nofollow(dir.path(), false).unwrap();
    let error = open_windows_child(
        &parent,
        OsStr::new("junction"),
        FILE_OPEN,
        SYNCHRONIZE | GENERIC_READ,
        null(),
        true,
        true,
    )
    .expect_err("a junction object must be refused");
    assert!(
        matches!(error, Error::InvalidInput(ref message) if message == "reparse points cannot be authorized"),
        "{error:?}"
    );
}

#[test]
fn windows_missing_entry_non_final_component_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let parent = open_windows_nofollow(dir.path(), false).unwrap();
    let expected = windows_file_identity(&parent).unwrap();
    let components = vec![OsString::from("missing"), OsString::from("target")];
    let result = resolved::resolve_windows(
        dir.path(),
        &expected,
        true,
        None,
        &components,
        PathOperation::DownloadFile,
        None,
    );
    assert!(matches!(
        result,
        Err(error) if error.is_missing_entry()
    ));
}

/// A directory engine resource is promoted through the real dialog API and resolved with an
/// empty component list, exactly as production does. The lease must carry the retained
/// no-follow handle *and* a non-empty target, because `uci_value` returns that target.
#[test]
fn windows_engine_resource_directory_lease_carries_its_target() {
    let dir = tempfile::tempdir().unwrap();
    let tables = dir.path().join("tables");
    fs::create_dir(&tables).unwrap();
    fs::write(tables.join("tablebase"), b"table").unwrap();
    let mut authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    let grant = authority
        .grant_dialog(
            &tables,
            "resource",
            PathClass::SingleDialogGrant,
            PathOperation::EngineResourceRead,
            std::time::Duration::from_secs(30),
            1,
        )
        .unwrap();
    let handle = authority
        .promote_engine_resource(&grant, EngineResourceHandleKind::Directory, "resource")
        .unwrap();
    let lease = authority.engine_resource(&handle).unwrap();
    let value = lease.uci_value().unwrap();
    assert!(!value.is_empty(), "directory lease must carry a target");
    assert!(value.contains("tables"), "{value}");
}

/// The junction refusal is the no-follow walk's, not a platform refusal: the directory is
/// promoted first, then swapped for a junction, and `engine_resource` must reach
/// `open_windows_nofollow` and return `InvalidInput` rather than the old off-unix refusal.
#[test]
fn windows_engine_resource_directory_junction_is_invalid_input() {
    let dir = tempfile::tempdir().unwrap();
    let tables = dir.path().join("tables");
    fs::create_dir(&tables).unwrap();
    let elsewhere = dir.path().join("elsewhere");
    fs::create_dir(&elsewhere).unwrap();
    let mut authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    let grant = authority
        .grant_dialog(
            &tables,
            "resource",
            PathClass::SingleDialogGrant,
            PathOperation::EngineResourceRead,
            std::time::Duration::from_secs(30),
            1,
        )
        .unwrap();
    let handle = authority
        .promote_engine_resource(&grant, EngineResourceHandleKind::Directory, "resource")
        .unwrap();
    fs::remove_dir(&tables).unwrap();
    windows_test_junction(&tables, &elsewhere);
    assert!(matches!(
        authority.engine_resource(&handle),
        Err(Error::InvalidInput(_))
    ));
}

#[test]
fn windows_engine_resource_file_root_refuses_directory_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let resource = dir.path().join("network");
    fs::write(&resource, b"authorized network").unwrap();
    let mut authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    let grant = authority
        .grant_dialog(
            &resource,
            "network",
            PathClass::SingleDialogGrant,
            PathOperation::EngineResourceRead,
            Duration::from_secs(30),
            1,
        )
        .unwrap();
    let handle = authority
        .promote_engine_resource(&grant, EngineResourceHandleKind::File, "network")
        .unwrap();
    {
        let lease = authority.engine_resource(&handle).unwrap();
        assert_eq!(
            fs::read(lease.uci_value().unwrap()).unwrap(),
            b"authorized network"
        );
    }
    fs::rename(&resource, dir.path().join("original-network")).unwrap();
    fs::create_dir(&resource).unwrap();
    fs::write(resource.join("substituted"), b"unrelated directory").unwrap();
    assert!(authority.engine_resource(&handle).is_err());
}

#[test]
fn windows_engine_resource_nested_objects_refuse_reparse_components() {
    let dir = tempfile::tempdir().unwrap();
    let tables = dir.path().join("tables");
    fs::create_dir_all(tables.join("nested")).unwrap();
    fs::write(tables.join("nested/network"), b"nested network").unwrap();
    let mut authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    let grant = authority
        .grant_dialog(
            &tables,
            "tables",
            PathClass::SingleDialogGrant,
            PathOperation::EngineResourceRead,
            Duration::from_secs(30),
            1,
        )
        .unwrap();
    let handle = authority
        .promote_engine_resource(&grant, EngineResourceHandleKind::Directory, "tables")
        .unwrap();
    {
        let directory = authority
            .resolve(
                handle.path_ref(),
                PathOperation::EngineResourceRead,
                &[OsString::from("nested")],
            )
            .unwrap();
        assert!(directory.directory().unwrap().metadata().unwrap().is_dir());
        let file = authority
            .resolve(
                handle.path_ref(),
                PathOperation::EngineResourceRead,
                &[OsString::from("nested"), OsString::from("network")],
            )
            .unwrap();
        let mut bytes = Vec::new();
        file.file()
            .unwrap()
            .try_clone()
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, b"nested network");
    }
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("network"), b"outside network").unwrap();
    windows_test_junction(&tables.join("junction"), outside.path());
    for components in [
        vec![OsString::from("junction")],
        vec![OsString::from("junction"), OsString::from("network")],
    ] {
        assert!(matches!(
            authority.resolve(
                handle.path_ref(),
                PathOperation::EngineResourceRead,
                &components
            ),
            Err(Error::InvalidInput(_))
        ));
    }
}

#[test]
fn registry_save_entries_persists_on_windows() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let file = dir.path().join("book.bin");
    fs::write(&file, b"book").unwrap();
    let mut authority = PathAuthority::open(registry.clone(), vec![]).unwrap();
    authority
        .migrate_legacy_os_path(
            file.into_os_string(),
            "book",
            PathClass::PersistentFile,
            vec![PathOperation::OpeningBookRead],
        )
        .unwrap();

    let reloaded = PathAuthority::open(registry, vec![]).unwrap();
    assert_eq!(reloaded.persistent.len(), 1);
}

#[test]
fn registry_parent_sync_failure_reports_uncertain_without_retry() {
    struct ParentSyncFailure(Arc<AtomicUsize>);

    impl AtomicWriterInjector for ParentSyncFailure {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == AtomicFileFaultPoint::ParentSync {
                self.0.fetch_add(1, Ordering::SeqCst);
                Err(std::io::Error::other("injected parent sync failure"))
            } else {
                Ok(())
            }
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let authority = PathAuthority::open(registry, vec![]).unwrap();
    let attempts = Arc::new(AtomicUsize::new(0));
    set_test_atomic_file_injector(Some(Arc::new(ParentSyncFailure(Arc::clone(&attempts)))));
    let durability = authority
        .save_entries(&authority.persistent, &None, &None, &None, &[])
        .unwrap();
    set_test_atomic_file_injector(None);

    assert_eq!(
        durability,
        CommitDurability::DurabilityUncertain(crate::error::DurabilityStage::RegistryReplacement)
    );
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
}

#[test]
fn registry_uncertain_candidate_state_adoption() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let file = dir.path().join("book.bin");
    fs::write(&file, b"book").unwrap();
    let mut authority = PathAuthority::open(registry.clone(), vec![]).unwrap();
    let dialog = authority
        .grant_dialog(
            &file,
            "book",
            PathClass::SingleDialogGrant,
            PathOperation::OpeningBookRead,
            Duration::from_secs(30),
            1,
        )
        .unwrap();
    let id = PathRef::fresh();
    let stored = StoredEntry {
        id: id.clone(),
        display_name: "book".into(),
        class: PathClass::PersistentFile,
        purpose: None,
        operations: vec![PathOperation::OpeningBookRead],
        path: NativePath::from_path(&file),
        identity: identity(&file).unwrap(),
        parent_identity: None,
        target_is_dir: false,
        practice_key: None,
    };
    let mut candidate = authority.persistent.clone();
    candidate.insert(
        id.id.clone(),
        Entry {
            stored,
            availability: PathAvailability::Available,
        },
    );

    set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
        "injected parent sync failure",
    ))));
    let durability = authority
        .commit_candidate(candidate, Some(&dialog))
        .unwrap();
    set_test_atomic_file_injector(None);

    assert_eq!(
        durability,
        CommitDurability::DurabilityUncertain(crate::error::DurabilityStage::RegistryReplacement)
    );
    assert!(authority.registry_durability_pending);
    assert!(authority.persistent.contains_key(&id.id));
    assert!(!authority.dialogs.contains_key(&dialog.id));
    assert!(authority
        .resolve(&dialog, PathOperation::OpeningBookRead, &[])
        .is_err());
    let reloaded = PathAuthority::open(registry, vec![]).unwrap();
    assert!(reloaded.persistent.contains_key(&id.id));
}

#[test]
fn windows_reparse_ancestor_stable_entry_rebinds_and_changed_entry_quarantines() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let junction = dir.path().join("junction");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("stable.pgn"), b"stable").unwrap();
    fs::write(real.join("changed.pgn"), b"old").unwrap();
    windows_test_junction(&junction, &real);
    let changed = StoredEntry {
        id: PathRef {
            id: "windows-changed".into(),
        },
        display_name: "changed".into(),
        class: PathClass::PersistentFile,
        purpose: Some(EntryPurpose::PgnFile),
        operations: canonical_operations(EntryPurpose::PgnFile),
        path: NativePath::from_path(&junction.join("changed.pgn")),
        identity: identity(&junction.join("changed.pgn")).unwrap(),
        parent_identity: None,
        target_is_dir: false,
        practice_key: None,
    };
    let stable = StoredEntry {
        id: PathRef {
            id: "windows-stable".into(),
        },
        display_name: "stable".into(),
        class: PathClass::PersistentFile,
        purpose: Some(EntryPurpose::PgnFile),
        operations: canonical_operations(EntryPurpose::PgnFile),
        path: NativePath::from_path(&junction.join("stable.pgn")),
        identity: identity(&junction.join("stable.pgn")).unwrap(),
        parent_identity: None,
        target_is_dir: false,
        practice_key: None,
    };
    fs::write(real.join("replacement.pgn"), b"new").unwrap();
    fs::remove_file(real.join("changed.pgn")).unwrap();
    fs::rename(real.join("replacement.pgn"), real.join("changed.pgn")).unwrap();
    let registry = dir.path().join("registry.json");
    let registry_value = Registry {
        schema_version: SCHEMA_VERSION,
        entries: vec![changed, stable],
        active_database_root: None,
        active_puzzle_root: None,
        active_engine_root: None,
        pending_artifacts: vec![],
        provisional_attachments: BTreeSet::new(),
        image_cleanup: vec![],
        catalog_installs: BTreeMap::new(),
        catalog_uses: Vec::new(),
    };
    fs::write(&registry, serde_json::to_vec(&registry_value).unwrap()).unwrap();
    let capture = crate::error::LogCaptureScope::start();
    let mut authority = PathAuthority::open(registry, vec![]).unwrap();
    // tempfile's TEMP may be an 8.3 spelling; compare canonical_binding of the real leaf.
    assert_eq!(
        authority.persistent["windows-stable"]
            .stored
            .path
            .to_path()
            .unwrap(),
        canonical_binding(&real.join("stable.pgn")).unwrap()
    );
    assert_eq!(
        authority.persistent["windows-stable"].availability,
        PathAvailability::Available
    );
    let mut file = authority
        .resolve(
            &PathRef {
                id: "windows-stable".into(),
            },
            PathOperation::ReadPgn,
            &[],
        )
        .unwrap()
        .into_read_file()
        .unwrap();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"stable");
    assert_eq!(
        authority.persistent["windows-changed"].availability,
        PathAvailability::Unavailable
    );
    let warnings: Vec<_> = capture
        .records()
        .into_iter()
        .filter(|record| record.level == log::Level::Warn)
        .filter(|record| record.message.contains("windows-changed"))
        .collect();
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(warnings[0].message.contains("identity changed"));
}

/// A junction at an app-owned leaf is a directory (`is_dir() == true`) that also carries the
/// reparse attribute, so `authorize_existing_dir` must refuse it before `identity()`:
/// `identity()` would otherwise reject it as `Error::InvalidInput("symbolic links are not path
/// authorities")` and put a different door's fixed text on the wire. The no-follow open of the
/// existing name must not traverse the junction, so the target directory must stay empty.
#[test]
fn app_owned_default_root_junction_leaf_is_refused_as_io() {
    for &(root, leaf) in APP_OWNED_DEFAULT_ROOT_LEAVES {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("app-data");
        let elsewhere = dir.path().join("elsewhere");
        fs::create_dir(&app_data).unwrap();
        fs::create_dir(&elsewhere).unwrap();
        windows_test_junction(&app_data.join(leaf), &elsewhere);

        let error = ensure_app_owned_default_dir(&AppDataDir::for_test(&app_data), root)
            .expect_err("a junction leaf must be refused");
        let rendered = format!("{error:?}");
        assert!(
            matches!(error, Error::Io(inner) if inner.to_string().contains("reparse point")),
            "{root:?} must be refused as Error::Io mentioning a reparse point: {rendered}"
        );
        assert_eq!(
            fs::read_dir(&elsewhere).unwrap().count(),
            0,
            "{root:?} must not write through the junction"
        );
    }
}

#[test]
fn native_shell_path_strips_verbatim_and_unc_prefixes() {
    assert_eq!(
        native_shell_path(Path::new(r"\\?\C:\Users\studio\Engines")),
        PathBuf::from(r"C:\Users\studio\Engines")
    );
    assert_eq!(
        native_shell_path(Path::new(r"\\?\UNC\server\share\Engines")),
        PathBuf::from(r"\\server\share\Engines")
    );
    assert_eq!(
        native_shell_path(Path::new(r"C:\Users\studio\Engines")),
        PathBuf::from(r"C:\Users\studio\Engines")
    );
}
