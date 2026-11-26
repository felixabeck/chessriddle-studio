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

fn windows_verbatim_spelling(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(stripped) = text.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        PathBuf::from(format!(r"\\?\{text}"))
    }
}

fn windows_short_path(path: &Path) -> Option<PathBuf> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut buffer = vec![0u16; 1024];
    let len = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetShortPathNameW(
            wide.as_ptr(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
        )
    };
    if len == 0 || (len as usize) >= buffer.len() {
        return None;
    }
    buffer.truncate(len as usize);
    let short = PathBuf::from(std::ffi::OsString::from_wide(&buffer));
    (short != path).then_some(short)
}

#[test]
fn home_owned_default_root_junction_component_is_refused_as_io() {
    for (kind, leaf) in [
        (VisibleDefaultKind::Databases, "Databases"),
        (VisibleDefaultKind::Puzzles, "Puzzles"),
        (VisibleDefaultKind::Engines, "Engines"),
        (VisibleDefaultKind::Pgn, "PGN"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = dir.path().join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        let studio = dir.path().join("ChessRiddle Studio");
        windows_test_junction(&studio, &elsewhere);
        let error = ensure_home_owned_default_dir(
            &HomeDir::for_test(dir.path(), RELEASE_APP_IDENTIFIER),
            kind,
        )
        .expect_err("a junction studio folder must be refused");
        assert!(
            matches!(error, Error::Io(ref inner) if inner.to_string().contains("reparse point")),
            "{kind:?} studio must be refused as Error::Io mentioning a reparse point: {error:?}"
        );
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);

        let dir = tempfile::tempdir().unwrap();
        let studio = dir.path().join("ChessRiddle Studio");
        fs::create_dir(&studio).unwrap();
        let elsewhere = dir.path().join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        let leaf_path = studio.join(leaf);
        windows_test_junction(&leaf_path, &elsewhere);
        let error = ensure_home_owned_default_dir(
            &HomeDir::for_test(dir.path(), RELEASE_APP_IDENTIFIER),
            kind,
        )
        .expect_err("a junction leaf must be refused");
        assert!(
            matches!(error, Error::Io(ref inner) if inner.to_string().contains("reparse point")),
            "{kind:?} leaf must be refused as Error::Io mentioning a reparse point: {error:?}"
        );
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
    }
}

#[test]
fn default_get_or_create_reuses_by_live_identity_for_verbatim_and_8_3_spellings() {
    let dir = tempfile::tempdir().unwrap();
    let home_path = dir.path().join("home");
    fs::create_dir(&home_path).unwrap();
    let authorized = ensure_home_owned_default_dir(
        &HomeDir::for_test(&home_path, RELEASE_APP_IDENTIFIER),
        VisibleDefaultKind::Databases,
    )
    .unwrap();
    let mut authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    let first = authority
        .get_or_create_database_root(authorized.path(), "Databases", Some(authorized.identity()))
        .unwrap();
    let verbatim = windows_verbatim_spelling(authorized.path());
    assert_ne!(verbatim, authorized.path());
    let second = authority
        .get_or_create_database_root(&verbatim, "Databases", Some(authorized.identity()))
        .unwrap();
    assert_eq!(first.path_ref(), second.path_ref());
    if let Some(short) = windows_short_path(authorized.path()) {
        let third = authority
            .get_or_create_database_root(&short, "Databases", Some(authorized.identity()))
            .unwrap();
        assert_eq!(first.path_ref(), third.path_ref());
    }
    // The registered root stays usable: activation and listing re-prove its stored spelling.
    authority.set_active_database_root(&first).unwrap();
    authority
        .list_database_children_cancellable(&first, &tokio_util::sync::CancellationToken::new())
        .unwrap();
}

#[test]
fn default_root_under_a_case_variant_studio_folder_activates_and_lists() {
    let dir = tempfile::tempdir().unwrap();
    let home_path = dir.path().join("home");
    // The user already has the studio folder in another case; NTFS opens it case-insensitively.
    fs::create_dir_all(home_path.join("chessriddle studio")).unwrap();
    let authorized = ensure_home_owned_default_dir(
        &HomeDir::for_test(&home_path, RELEASE_APP_IDENTIFIER),
        VisibleDefaultKind::Databases,
    )
    .unwrap();
    let mut authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    let root = authority
        .get_or_create_database_root(authorized.path(), "Databases", Some(authorized.identity()))
        .unwrap();
    authority.set_active_database_root(&root).unwrap();
    authority
        .list_database_children_cancellable(&root, &tokio_util::sync::CancellationToken::new())
        .unwrap();
    // A database below the default re-proves under the on-disk spelling too.
    let child = authority
        .create_database_child(&root, OsStr::new("games.db3"))
        .unwrap();
    authority
        .database_file_target(&child, PathOperation::DatabaseMutate)
        .unwrap();
}

#[test]
fn default_root_whose_kind_folder_exists_in_another_case_activates_and_resolves_children() {
    let dir = tempfile::tempdir().unwrap();
    let home_path = dir.path().join("home");
    let home = HomeDir::for_test(&home_path, RELEASE_APP_IDENTIFIER);
    // The kind folder already exists lower-case inside the studio folder.
    fs::create_dir_all(home.as_path().join(home.studio_leaf()).join("databases")).unwrap();
    let authorized = ensure_home_owned_default_dir(&home, VisibleDefaultKind::Databases).unwrap();
    assert_eq!(
        authorized.path().file_name(),
        Some(OsStr::new("databases")),
        "the default carries the on-disk case"
    );
    let mut authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    let root = authority
        .get_or_create_database_root(authorized.path(), "Databases", Some(authorized.identity()))
        .unwrap();
    authority.set_active_database_root(&root).unwrap();
    let child = authority
        .create_database_child(&root, OsStr::new("games.db3"))
        .unwrap();
    authority
        .database_file_target(&child, PathOperation::DatabaseMutate)
        .unwrap();
}

#[test]
fn windows_collision_folding_matches_rtl_upcase() {
    // 1. Production RtlUpcaseUnicodeChar collision folding. Greek σ folds to Σ; the final
    // sigma ς is left unchanged by RtlUpcaseUnicodeChar (observed in rust-windows-test,
    // Test run 45780981166), so the collision check treats ς and Σ as distinct names.
    assert_eq!(
        folder_switch::fold_leaf_name_for_collision(OsStr::new("Game.db3")),
        folder_switch::fold_leaf_name_for_collision(OsStr::new("game.db3"))
    );
    assert_eq!(
        folder_switch::fold_leaf_name_for_collision(OsStr::new("\u{03C3}.db3")),
        folder_switch::fold_leaf_name_for_collision(OsStr::new("\u{03A3}.db3"))
    );
    assert_ne!(
        folder_switch::fold_leaf_name_for_collision(OsStr::new("\u{03C2}.db3")),
        folder_switch::fold_leaf_name_for_collision(OsStr::new("\u{03A3}.db3"))
    );
}

// A plain test: every call below is synchronous, as production runs them on a blocking worker.
// Inside `#[tokio::test]` a schema upgrade spawned by `connection` would wait on the one runtime
// thread it blocks (CI run 45808657841 hung there with a partial-schema fixture).
#[test]
fn windows_quiesce_drains_sqlite_and_ecsi_before_rename() {
    use tokio_util::sync::CancellationToken;

    // 2. Drain a real open SQLite pool AND a real mmapped .ecsi in SearchCache via quiesce_root
    //    before renaming both files on Windows.
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("SrcDbs");
    let src_case_variant = dir.path().join("srcdbs");
    let dst = dir.path().join("DstDbs");
    fs::create_dir(&src).unwrap();
    fs::create_dir(&dst).unwrap();

    let mut auth = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    // Roots arrive in their on-disk spelling (folder picker, producers); only the tombstone
    // below uses the case variant.
    let root = auth
        .get_or_create_database_root(&src, "SrcDbs", None)
        .unwrap();
    auth.set_active_database_root(&root).unwrap();
    let db_handle = auth
        .create_database_child(&root, OsStr::new("pooled.db3"))
        .unwrap();
    // A complete current schema: a partial one would send `connection` into a schema upgrade
    // that refuses the file.
    crate::db::create_schema_database_file(&src, "pooled");

    let target = auth
        .database_file_target(&db_handle, PathOperation::DatabaseMutate)
        .unwrap();
    let repo = crate::db::DatabaseRepository::default();
    let _ = repo.connection(&target, None).unwrap();

    // Open and cache a real .ecsi mmap in SearchCache.
    let db_id = repo
        .database_identity_expected(&target, target.identity(), None)
        .unwrap();
    let index_source = crate::IndexSource::from_database_identity(&db_id).unwrap();
    let _ = crate::db::SearchIndexChunk::new()
        .write_to_with_source(src.join("pooled.db3.ecsi"), index_source.clone())
        .unwrap();
    let search_cache = crate::SearchCache::default();
    let (idx_id, mmap_idx) =
        crate::db::open_valid_preferred(&target, &index_source, &CancellationToken::new(), None)
            .unwrap()
            .expect("valid .ecsi");
    let snap = search_cache.invalidation_snapshot();
    let _ = search_cache.insert_index(idx_id, mmap_idx, snap);
    assert_eq!(search_cache.cached_index_count(), 1);

    let src_id = opened_file_identity(&open_windows_nofollow(&src, false).unwrap()).unwrap();
    let dst_id = opened_file_identity(&open_windows_nofollow(&dst, false).unwrap()).unwrap();

    // NTFS case-variant tombstone under `srcdbs\pooled.db3` must still block quiesce_root on `SrcDbs`!
    repo.insert_tombstone_for_test(src_case_variant.join("pooled.db3"));
    assert!(repo
        .quiesce_root(src_id, &src, &CancellationToken::new())
        .is_err());
    repo.remove_tombstone_for_test(&src_case_variant.join("pooled.db3"));

    // The identity probe must really open NTFS directories (a failing probe would also make
    // quiesce_root refuse conservatively, so the blocking assertion above cannot prove it).
    assert_eq!(
        opened_file_identity(&open_directory_for_identity_probe(&src_case_variant).unwrap())
            .unwrap(),
        src_id
    );

    let src_dir = crate::infra::fs::open_verified_directory(&src, src_id).unwrap();
    let dst_dir = crate::infra::fs::open_verified_directory(&dst, dst_id).unwrap();
    let file_id =
        crate::infra::fs::entry_identity_at(src_dir.as_file(), OsStr::new("pooled.db3"), false)
            .unwrap();
    let ecsi_id = crate::infra::fs::entry_identity_at(
        src_dir.as_file(),
        OsStr::new("pooled.db3.ecsi"),
        false,
    )
    .unwrap();

    // No "rename is blocked before quiesce" premise: the index is opened with FILE_SHARE_DELETE,
    // and NTFS renames a mapped file opened that way (CI run 45820095311). Quiesce is what keeps
    // the cache from serving the moved file; the eviction count below proves it.

    let db_guard = repo
        .quiesce_root(src_id, &src, &CancellationToken::new())
        .unwrap();
    let sc_guard = search_cache.quiesce_root(src_id);
    assert_eq!(search_cache.cached_index_count(), 0);

    let _ = crate::infra::fs::rename_entry_at(
        src_dir.as_file(),
        OsStr::new("pooled.db3"),
        file_id,
        false,
        dst_dir.as_file(),
        OsStr::new("pooled.db3"),
    )
    .unwrap();
    let _ = crate::infra::fs::rename_entry_at(
        src_dir.as_file(),
        OsStr::new("pooled.db3.ecsi"),
        ecsi_id,
        false,
        dst_dir.as_file(),
        OsStr::new("pooled.db3.ecsi"),
    )
    .unwrap();
    assert!(dst.join("pooled.db3").exists());
    assert!(dst.join("pooled.db3.ecsi").exists());
    assert!(!src.join("pooled.db3").exists());
    assert!(!src.join("pooled.db3.ecsi").exists());
    drop(sc_guard);
    db_guard.lift();

    // A tombstone in another existing directory must not block quiesce_root.
    repo.insert_tombstone_for_test(dst.join("unrelated.db3"));
    repo.quiesce_root(src_id, &src, &CancellationToken::new())
        .expect("unrelated tombstone in another existing directory must not block quiesce_root")
        .lift();
    repo.remove_tombstone_for_test(&dst.join("unrelated.db3"));
}

#[tokio::test]
async fn windows_engine_quiesce_releases_actor_handles_before_rename() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("SrcEngines");
    let dst = dir.path().join("DstEngines");
    fs::create_dir(&src).unwrap();
    fs::create_dir(&dst).unwrap();
    let src_id = opened_file_identity(&open_windows_nofollow(&src, false).unwrap()).unwrap();
    let dst_id = opened_file_identity(&open_windows_nofollow(&dst, false).unwrap()).unwrap();
    let src_dir = crate::infra::fs::open_verified_directory(&src, src_id).unwrap();
    let dst_dir = crate::infra::fs::open_verified_directory(&dst, dst_id).unwrap();

    // 3. Drain a published engine actor holding a real OS file handle without FILE_SHARE_DELETE
    //    via EngineSupervisor::quiesce_executables before renaming the engine file on Windows.
    let eng_path = src.join("engine.exe");
    fs::write(&eng_path, b"MZ-test-engine").unwrap();
    let eng_id =
        crate::infra::fs::entry_identity_at(src_dir.as_file(), OsStr::new("engine.exe"), false)
            .unwrap();
    let eng_handle = {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&eng_path)
            .unwrap()
    };
    let supervisor = crate::engine::EngineSupervisor::default();
    let exec_ref = PathRef::fresh();
    let eng_lease = std::sync::Arc::new(
        EngineResourceLease::test_file(eng_handle).with_path_ref(exec_ref.clone()),
    );
    let key = crate::engine::EngineKey::new("win-tab".into(), "win-eng".into()).unwrap();
    supervisor.insert_test_actor_with_resources(
        key,
        "win-eng".into(),
        exec_ref.clone(),
        vec![eng_lease],
        false,
    );
    assert_eq!(supervisor.actor_count_for_test(), 1);
    assert_eq!(supervisor.pending_actor_count_for_test(), 0);
    assert!(
        crate::infra::fs::rename_entry_at(
            src_dir.as_file(),
            OsStr::new("engine.exe"),
            eng_id,
            false,
            dst_dir.as_file(),
            OsStr::new("engine.exe"),
        )
        .is_err(),
        "actor-held handle without FILE_SHARE_DELETE must block rename before quiesce_executables"
    );
    let mut execs = std::collections::HashSet::new();
    execs.insert(exec_ref);
    let sup_guard = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        supervisor.quiesce_executables(execs, std::collections::HashSet::new()),
    )
    .await
    .expect("quiesce_executables did not return within 60 s on Windows")
    .unwrap();
    assert_eq!(supervisor.actor_count_for_test(), 0);
    let _ = crate::infra::fs::rename_entry_at(
        src_dir.as_file(),
        OsStr::new("engine.exe"),
        eng_id,
        false,
        dst_dir.as_file(),
        OsStr::new("engine.exe"),
    )
    .unwrap();
    assert!(dst.join("engine.exe").exists());
    assert!(!src.join("engine.exe").exists());
    sup_guard.lift();
}

#[test]
fn windows_move_backstop_panic_during_unwind_does_not_abort() {
    // 4. Actually construct and drop MoveBackstopGuard with PanicInBackstop during unwinding:
    //    must catch the panic internally and never abort!
    let _fault = folder_switch::install_folder_switch_fault(
        folder_switch::FolderSwitchTestFault::PanicInBackstop,
    );
    let caught = std::panic::catch_unwind(|| {
        let _backstop = folder_switch::MoveBackstopGuard::new(FolderSwitchKind::Database);
        panic!("simulated unwind");
    });
    assert!(caught.is_err());
    assert!(
        !folder_switch::is_test_fault_pending(
            folder_switch::FolderSwitchTestFault::PanicInBackstop
        ),
        "MoveBackstopGuard::drop must have executed and consumed PanicInBackstop"
    );
}

#[test]
fn app_owned_default_whose_leaf_exists_in_another_case_resolves_children() {
    let dir = tempfile::tempdir().unwrap();
    let app_data = dir.path().join("app-data");
    // The legacy leaf already exists upper-case; NTFS opens it case-insensitively.
    fs::create_dir_all(app_data.join("DB")).unwrap();
    let app_data_dir = AppDataDir::for_test(&app_data);
    let authorized =
        ensure_app_owned_default_dir(&app_data_dir, AppOwnedDefaultRoot::Databases).unwrap();
    assert_eq!(authorized.path().file_name(), Some(OsStr::new("DB")));
    let mut authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    let root = authority
        .get_or_create_database_root(authorized.path(), "db", Some(authorized.identity()))
        .unwrap();
    authority.set_active_database_root(&root).unwrap();
    let child = authority
        .create_database_child(&root, OsStr::new("games.db3"))
        .unwrap();
    authority
        .database_file_target(&child, PathOperation::DatabaseMutate)
        .unwrap();
}
