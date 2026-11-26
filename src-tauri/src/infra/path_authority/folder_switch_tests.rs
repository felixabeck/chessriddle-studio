use super::folder_switch::*;
use super::*;
use crate::error::{ErrorCategory, ErrorPayloadTag, FolderSwitchFailure, RootFailure};
use crate::infra::fs::{entry_identity_at, OwnedStagingDir};
use crate::infra::path_authority::SharedPathAuthority;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

fn make_lookups<'a>(
    home: &'a Path,
    app_data: &'a Path,
) -> (
    impl Fn() -> Result<HomeDir, Error> + 'a,
    impl Fn() -> Result<AppDataDir, Error> + 'a,
) {
    let home_path = home.to_path_buf();
    let app_path = app_data.to_path_buf();
    (
        move || Ok(HomeDir::for_test(&home_path, "com.chessriddle.studio")),
        move || Ok(AppDataDir::for_test(&app_path)),
    )
}

fn open_test_authority(dir: &TempDir) -> SharedPathAuthority {
    SharedPathAuthority::installed(
        PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap(),
    )
}

fn dir_identity(path: &Path) -> (u64, u64) {
    opened_file_identity(&open_directory_nofollow_readonly(path).unwrap()).unwrap()
}

fn create_initialized_sqlite_db(path: &Path) {
    use diesel::{Connection, RunQueryDsl, SqliteConnection};
    let mut conn = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    diesel::sql_query("CREATE TABLE IF NOT EXISTS Info (Name TEXT PRIMARY KEY, Value TEXT);")
        .execute(&mut conn)
        .unwrap();
    diesel::sql_query("INSERT OR REPLACE INTO Info (Name, Value) VALUES ('Title', 'Test DB');")
        .execute(&mut conn)
        .unwrap();
}

#[test]
fn same_volume_move_preserves_path_refs_and_foreign_files_stay() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let source = tmp.path().join("src-dbs");
    let target = tmp.path().join("dst-dbs");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&app_data).unwrap();
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();

    let authority = open_test_authority(&tmp);
    let (h, a) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&h, &a);

    let db_handle = authority
        .with_mut(|auth| {
            let root = auth.get_or_create_database_root(&source, "src-dbs", None)?;
            auth.set_active_database_root(&root)?;
            auth.create_database_child(&root, OsStr::new("games.db3"))
        })
        .unwrap()
        .unwrap();
    fs::write(source.join("foreign.txt"), b"keep me").unwrap();

    let pending = authority
        .with_mut(|auth| {
            auth.choose_folder_switch(FolderSwitchKind::Database, &target, "dst-dbs".into(), None)
        })
        .unwrap()
        .unwrap();
    let (grant, display_name, item_count) = pending.expect("movable db should yield Pending");
    assert_eq!(display_name, "dst-dbs");
    assert_eq!(item_count, 1);

    let prepared = authority
        .with_mut(|auth| auth.prepare_folder_move(&grant))
        .unwrap()
        .unwrap()
        .expect("live grant");
    let status = execute_folder_move_blocking(&authority, &grant, &prepared, &lookups).unwrap();
    assert_eq!(status.display_name, "dst-dbs");
    assert!(!status.is_default);

    // Same PathRef resolves at the new destination (verified by directory identity, not raw TempDir spelling).
    let resolved = authority
        .with_mut(|auth| auth.database_file_target(&db_handle, PathOperation::DatabaseRead))
        .unwrap()
        .unwrap();
    assert_eq!(
        opened_file_identity(resolved.parent()).unwrap(),
        dir_identity(&target)
    );
    assert!(!source.join("games.db3").exists());
    assert!(target.join("games.db3").exists());
    // Foreign file stays untouched in source.
    assert!(source.join("foreign.txt").exists());
    assert!(!target.join("foreign.txt").exists());

    // Lost-reply replay returns the same committed status.
    let replay = authority
        .with_mut(|auth| auth.prepare_folder_move(&grant))
        .unwrap()
        .unwrap();
    let Err(replayed_status) = replay else {
        panic!("replaying committed grant should return cached FolderStatus");
    };
    assert_eq!(replayed_status, status);
}

#[test]
fn volume_identity_decides_rename_vs_copy_and_exdev_falls_back_to_copy() {
    assert!(same_volume_identities((100, 1), (100, 2)));
    assert!(!same_volume_identities((100, 1), (200, 1)));

    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let source = tmp.path().join("src-exdev");
    let target = tmp.path().join("dst-exdev");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&app_data).unwrap();
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();

    let authority = open_test_authority(&tmp);
    let (h, a) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&h, &a);

    let db_handle = authority
        .with_mut(|auth| {
            let root = auth.get_or_create_database_root(&source, "src-exdev", None)?;
            auth.set_active_database_root(&root)?;
            auth.create_database_child(&root, OsStr::new("exdev.db3"))
        })
        .unwrap()
        .unwrap();
    fs::write(source.join("exdev.db3"), b"sqlite-placeholder-bytes").unwrap();

    let (grant, _, _) = authority
        .with_mut(|auth| {
            auth.choose_folder_switch(
                FolderSwitchKind::Database,
                &target,
                "dst-exdev".into(),
                None,
            )
        })
        .unwrap()
        .unwrap()
        .expect("Pending");
    let prepared = authority
        .with_mut(|auth| auth.prepare_folder_move(&grant))
        .unwrap()
        .unwrap()
        .ok()
        .unwrap();

    let _fault = install_folder_switch_fault(FolderSwitchTestFault::SimulateExdevOnFirstRename);
    let status = execute_folder_move_blocking(&authority, &grant, &prepared, &lookups).unwrap();
    assert_eq!(status.display_name, "dst-exdev");
    assert!(target.join("exdev.db3").exists());
    assert!(!source.join("exdev.db3").exists());
    assert_eq!(
        fs::read(target.join("exdev.db3")).unwrap(),
        b"sqlite-placeholder-bytes"
    );
    let target_file = authority
        .with_mut(|auth| auth.database_file_target(&db_handle, PathOperation::DatabaseRead))
        .unwrap()
        .unwrap();
    assert_eq!(
        opened_file_identity(target_file.parent()).unwrap(),
        dir_identity(&target)
    );
}

#[test]
fn copy_mode_verifies_and_rebinds_ecsi_and_integrity_headers() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let source = tmp.path().join("src-copy");
    let target = tmp.path().join("dst-copy");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&app_data).unwrap();
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();

    let authority = open_test_authority(&tmp);
    let (h, a) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&h, &a);
    let repo = crate::db::DatabaseRepository::default();

    let db_handle = authority
        .with_mut(|auth| {
            let root = auth.get_or_create_database_root(&source, "src-copy", None)?;
            auth.set_active_database_root(&root)?;
            auth.create_database_child(&root, OsStr::new("indexed.db3"))
        })
        .unwrap()
        .unwrap();

    let src_db_path = source.join("indexed.db3");
    create_initialized_sqlite_db(&src_db_path);

    let src_target = authority
        .with_mut(|auth| auth.database_file_target(&db_handle, PathOperation::DatabaseMutate))
        .unwrap()
        .unwrap();
    let src_db_identity = repo
        .database_identity_expected(&src_target, src_target.identity(), None)
        .unwrap();
    let src_index_source = crate::IndexSource::from_database_identity(&src_db_identity).unwrap();
    let chunk = crate::db::SearchIndexChunk::new();
    let _ = chunk
        .write_to_with_source(source.join("indexed.db3.ecsi"), src_index_source.clone())
        .unwrap();
    crate::db::write_stamp_for_test(&repo, &src_target, &src_db_identity).unwrap();
    drop(src_target);

    let (grant, _, _) = authority
        .with_mut(|auth| {
            auth.choose_folder_switch(FolderSwitchKind::Database, &target, "dst-copy".into(), None)
        })
        .unwrap()
        .unwrap()
        .expect("Pending");
    let prepared = authority
        .with_mut(|auth| auth.prepare_folder_move(&grant))
        .unwrap()
        .unwrap()
        .ok()
        .unwrap();

    let _fault = install_folder_switch_fault(FolderSwitchTestFault::ForceCopyMode);
    execute_folder_move_blocking(&authority, &grant, &prepared, &lookups).unwrap();

    assert!(!src_db_path.exists());
    assert!(!source.join("indexed.db3.ecsi").exists());
    assert!(!source.join("indexed.db3.integrity").exists());
    let dst_db_path = target.join("indexed.db3");
    let dst_ecsi_path = target.join("indexed.db3.ecsi");
    let dst_stamp_path = target.join("indexed.db3.integrity");
    assert!(dst_db_path.exists());
    assert!(dst_ecsi_path.exists());
    assert!(dst_stamp_path.exists());

    // PathRef preserved and resolves at destination; open_valid_preferred accepts the rebound
    // index without rebuild, and content_validation::inspect accepts the rebound stamp!
    let resolved = authority
        .with_mut(|auth| auth.database_file_target(&db_handle, PathOperation::DatabaseRead))
        .unwrap()
        .unwrap();
    assert_eq!(
        opened_file_identity(resolved.parent()).unwrap(),
        dir_identity(&target)
    );
    let dst_db_identity = repo
        .database_identity_expected(&resolved, resolved.identity(), None)
        .unwrap();
    let expected_dst_source = crate::IndexSource::from_database_identity(&dst_db_identity).unwrap();
    assert_ne!(expected_dst_source.object, src_index_source.object);

    let opened = crate::db::open_valid_preferred(
        &resolved,
        &expected_dst_source,
        &CancellationToken::new(),
        None,
    )
    .unwrap();
    assert!(
        opened.is_some(),
        "open_valid_preferred must accept the rebound .ecsi without rebuilding"
    );

    let needs_scan = crate::db::inspect_content_validation(
        &repo,
        &resolved,
        &dst_db_identity,
        &authority,
        &db_handle,
    )
    .unwrap();
    assert!(
        !needs_scan,
        "rebound .integrity stamp must be accepted without scheduling a re-scan"
    );
}

#[test]
fn sidecar_rebind_followed_by_commit_failure_rolls_back_completely() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let source = tmp.path().join("src-rebind-fail");
    let target = tmp.path().join("dst-rebind-fail");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&app_data).unwrap();
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();

    let authority = open_test_authority(&tmp);
    let (h, a) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&h, &a);
    let repo = crate::db::DatabaseRepository::default();

    let db_handle = authority
        .with_mut(|auth| {
            let root = auth.get_or_create_database_root(&source, "src-rebind-fail", None)?;
            auth.set_active_database_root(&root)?;
            auth.create_database_child(&root, OsStr::new("rebind.db3"))
        })
        .unwrap()
        .unwrap();
    create_initialized_sqlite_db(&source.join("rebind.db3"));
    let src_target = authority
        .with_mut(|auth| auth.database_file_target(&db_handle, PathOperation::DatabaseMutate))
        .unwrap()
        .unwrap();
    let src_id = repo
        .database_identity_expected(&src_target, src_target.identity(), None)
        .unwrap();
    let src_index_source = crate::IndexSource::from_database_identity(&src_id).unwrap();
    let _ = crate::db::SearchIndexChunk::new()
        .write_to_with_source(source.join("rebind.db3.ecsi"), src_index_source)
        .unwrap();
    crate::db::write_stamp_for_test(&repo, &src_target, &src_id).unwrap();
    drop(src_target);

    let (grant, _, _) = authority
        .with_mut(|auth| {
            auth.choose_folder_switch(
                FolderSwitchKind::Database,
                &target,
                "dst-rebind-fail".into(),
                None,
            )
        })
        .unwrap()
        .unwrap()
        .expect("Pending");
    let prepared = authority
        .with_mut(|auth| auth.prepare_folder_move(&grant))
        .unwrap()
        .unwrap()
        .ok()
        .unwrap();

    // Copy + rebind both sidecars (giving them new inodes), then fail commit -> must roll back cleanly!
    let _faults = install_folder_switch_faults(&[
        FolderSwitchTestFault::ForceCopyMode,
        FolderSwitchTestFault::FailCommit,
    ]);
    let err = execute_folder_move_blocking(&authority, &grant, &prepared, &lookups).unwrap_err();
    assert_eq!(
        err.folder_switch_failure(),
        Some(FolderSwitchFailure::TransferFailedRolledBack)
    );
    assert!(!authority
        .with_mut(|auth| auth.has_unresolved_journal(FolderSwitchKind::Database))
        .unwrap());
    assert!(fs::read_dir(&target).unwrap().next().is_none());
    assert!(source.join("rebind.db3").exists());
    assert!(source.join("rebind.db3.ecsi").exists());
    assert!(source.join("rebind.db3.integrity").exists());
}

#[test]
fn mismatched_or_corrupt_source_sidecar_is_not_rebound_on_move() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let source = tmp.path().join("src-stale");
    let target = tmp.path().join("dst-stale");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&app_data).unwrap();
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();

    let authority = open_test_authority(&tmp);
    let (h, a) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&h, &a);
    let repo = crate::db::DatabaseRepository::default();

    let (stale_handle, corrupt_handle) = authority
        .with_mut(|auth| {
            let root = auth.get_or_create_database_root(&source, "src-stale", None)?;
            auth.set_active_database_root(&root)?;
            let a = auth.create_database_child(&root, OsStr::new("stale.db3"))?;
            let b = auth.create_database_child(&root, OsStr::new("corrupt.db3"))?;
            Ok::<_, Error>((a, b))
        })
        .unwrap()
        .unwrap();
    create_initialized_sqlite_db(&source.join("stale.db3"));
    create_initialized_sqlite_db(&source.join("corrupt.db3"));

    // Write a mismatched .ecsi and .integrity for stale.db3 (pointing to a bogus object id).
    let stale_target = authority
        .with_mut(|auth| auth.database_file_target(&stale_handle, PathOperation::DatabaseMutate))
        .unwrap()
        .unwrap();
    let real_id = repo
        .database_identity_expected(&stale_target, stale_target.identity(), None)
        .unwrap();
    crate::db::write_stamp_for_test(&repo, &stale_target, &real_id).unwrap();
    // Tamper the stamp's recorded object identity so it no longer matches stale.db3.
    let stamp_path = source.join("stale.db3.integrity");
    let mut stamp_json: serde_json::Value =
        serde_json::from_slice(&fs::read(&stamp_path).unwrap()).unwrap();
    stamp_json["identity"]["object"] = serde_json::json!([999_999u64, 888_888u64]);
    fs::write(&stamp_path, serde_json::to_vec(&stamp_json).unwrap()).unwrap();

    let mut bogus_id = real_id;
    bogus_id.object = (999_999, 888_888);
    let bogus_source = crate::IndexSource::from_database_identity(&bogus_id).unwrap();
    let _ = crate::db::SearchIndexChunk::new()
        .write_to_with_source(source.join("stale.db3.ecsi"), bogus_source)
        .unwrap();
    drop(stale_target);

    // Write a truncated/corrupt .ecsi for corrupt.db3 -> move must NOT fail with InvalidData.
    fs::write(source.join("corrupt.db3.ecsi"), b"BAD!").unwrap();

    let (grant, _, _) = authority
        .with_mut(|auth| {
            auth.choose_folder_switch(
                FolderSwitchKind::Database,
                &target,
                "dst-stale".into(),
                None,
            )
        })
        .unwrap()
        .unwrap()
        .expect("Pending");
    let prepared = authority
        .with_mut(|auth| auth.prepare_folder_move(&grant))
        .unwrap()
        .unwrap()
        .ok()
        .unwrap();

    let _fault = install_folder_switch_fault(FolderSwitchTestFault::ForceCopyMode);
    execute_folder_move_blocking(&authority, &grant, &prepared, &lookups).unwrap();

    // Mismatched sidecars must NOT be made valid by the move.
    let dst_stale = authority
        .with_mut(|auth| auth.database_file_target(&stale_handle, PathOperation::DatabaseRead))
        .unwrap()
        .unwrap();
    let dst_stale_id = repo
        .database_identity_expected(&dst_stale, dst_stale.identity(), None)
        .unwrap();
    let expected_src = crate::IndexSource::from_database_identity(&dst_stale_id).unwrap();
    assert!(
        crate::db::open_valid_preferred(&dst_stale, &expected_src, &CancellationToken::new(), None)
            .unwrap()
            .is_none(),
        "stale .ecsi must remain rejected after move"
    );
    assert!(
        crate::db::inspect_content_validation(
            &repo,
            &dst_stale,
            &dst_stale_id,
            &authority,
            &stale_handle,
        )
        .unwrap(),
        "stale .integrity stamp must remain rejected after move"
    );

    // Corrupt .ecsi database still moved and resolves cleanly.
    let dst_corrupt = authority
        .with_mut(|auth| auth.database_file_target(&corrupt_handle, PathOperation::DatabaseRead))
        .unwrap()
        .unwrap();
    assert_eq!(
        opened_file_identity(dst_corrupt.parent()).unwrap(),
        dir_identity(&target)
    );
}

#[test]
fn preflight_refusals_leave_source_and_registry_unchanged() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let outer = tmp.path().join("outer");
    let source = outer.join("source");
    let nested_child = source.join("child");
    let target = tmp.path().join("target");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&app_data).unwrap();
    fs::create_dir_all(&nested_child).unwrap();
    fs::create_dir_all(&target).unwrap();

    let authority = open_test_authority(&tmp);
    let (h, a) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&h, &a);

    authority
        .with_mut(|auth| {
            let root = auth.get_or_create_database_root(&source, "source", None)?;
            auth.set_active_database_root(&root)?;
            auth.create_database_child(&root, OsStr::new("a.db3"))
        })
        .unwrap()
        .unwrap();

    // 1. Nested folder (target inside source)
    let (nested_grant, _, _) = authority
        .with_mut(|auth| {
            auth.choose_folder_switch(
                FolderSwitchKind::Database,
                &nested_child,
                "child".into(),
                None,
            )
        })
        .unwrap()
        .unwrap()
        .expect("Pending");
    let prepared_nested = authority
        .with_mut(|auth| auth.prepare_folder_move(&nested_grant))
        .unwrap()
        .unwrap()
        .ok()
        .unwrap();
    let err = execute_folder_move_blocking(&authority, &nested_grant, &prepared_nested, &lookups)
        .unwrap_err();
    assert_eq!(
        err.folder_switch_failure(),
        Some(FolderSwitchFailure::NestedFolders)
    );
    assert!(source.join("a.db3").exists());

    // 2. Nested folder (source inside target)
    let (outer_grant, _, _) = authority
        .with_mut(|auth| {
            auth.choose_folder_switch(FolderSwitchKind::Database, &outer, "outer".into(), None)
        })
        .unwrap()
        .unwrap()
        .expect("Pending");
    let prepared_outer = authority
        .with_mut(|auth| auth.prepare_folder_move(&outer_grant))
        .unwrap()
        .unwrap()
        .ok()
        .unwrap();
    let err = execute_folder_move_blocking(&authority, &outer_grant, &prepared_outer, &lookups)
        .unwrap_err();
    assert_eq!(
        err.folder_switch_failure(),
        Some(FolderSwitchFailure::NestedFolders)
    );

    // 3. Name collision reports only a count
    fs::write(target.join("a.db3"), b"existing").unwrap();
    let (col_grant, _, _) = authority
        .with_mut(|auth| {
            auth.choose_folder_switch(FolderSwitchKind::Database, &target, "target".into(), None)
        })
        .unwrap()
        .unwrap()
        .expect("Pending");
    let prepared_col = authority
        .with_mut(|auth| auth.prepare_folder_move(&col_grant))
        .unwrap()
        .unwrap()
        .ok()
        .unwrap();
    let err =
        execute_folder_move_blocking(&authority, &col_grant, &prepared_col, &lookups).unwrap_err();
    assert_eq!(
        err.folder_switch_failure(),
        Some(FolderSwitchFailure::NameCollision { count: 1 })
    );
    let serialized = serde_json::to_string(&err).unwrap();
    assert!(!serialized.contains("a.db3"));
    assert!(!serialized.contains(target.to_string_lossy().as_ref()));

    // 4. Cancelled / expired grant
    authority
        .with_mut(|auth| auth.cancel_folder_switch_grant(&col_grant))
        .unwrap();
    let err = authority
        .with_mut(|auth| auth.prepare_folder_move(&col_grant))
        .unwrap()
        .unwrap_err();
    assert_eq!(
        err.folder_switch_failure(),
        Some(FolderSwitchFailure::ExpiredGrant)
    );

    // 5. SameFolder via direct preflight
    let mut same_prepared = prepared_col;
    same_prepared.target_path = same_prepared.source_path.clone();
    same_prepared.target_identity = same_prepared.source_identity;
    let err = execute_folder_move_blocking(&authority, &nested_grant, &same_prepared, &lookups)
        .unwrap_err();
    assert_eq!(
        err.folder_switch_failure(),
        Some(FolderSwitchFailure::SameFolder)
    );

    // 6. TargetUnwritable and SourceUnreadable (Unix chmod when non-root)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } != 0 {
            let ro_target = tmp.path().join("ro-target");
            fs::create_dir_all(&ro_target).unwrap();
            let (ro_grant, _, _) = authority
                .with_mut(|auth| {
                    auth.choose_folder_switch(
                        FolderSwitchKind::Database,
                        &ro_target,
                        "ro-target".into(),
                        None,
                    )
                })
                .unwrap()
                .unwrap()
                .expect("Pending");
            let ro_prepared = authority
                .with_mut(|auth| auth.prepare_folder_move(&ro_grant))
                .unwrap()
                .unwrap()
                .ok()
                .unwrap();
            fs::set_permissions(&ro_target, fs::Permissions::from_mode(0o555)).unwrap();
            let err = execute_folder_move_blocking(&authority, &ro_grant, &ro_prepared, &lookups)
                .unwrap_err();
            fs::set_permissions(&ro_target, fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(
                err.folder_switch_failure(),
                Some(FolderSwitchFailure::TargetUnwritable)
            );

            // SourceUnreadable on enumeration
            let unreadable_src = tmp.path().join("unreadable-src");
            fs::create_dir_all(&unreadable_src).unwrap();
            let src_file = open_directory_nofollow_readonly(&unreadable_src).unwrap();
            fs::set_permissions(&unreadable_src, fs::Permissions::from_mode(0o000)).unwrap();
            let enum_err = authority
                .with_mut(|auth| {
                    auth.enumerate_movable_for_kind(
                        FolderSwitchKind::Database,
                        &src_file,
                        opened_file_identity(&src_file).unwrap(),
                    )
                })
                .unwrap()
                .err();
            fs::set_permissions(&unreadable_src, fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(
                enum_err.and_then(|e| e.folder_switch_failure()),
                Some(FolderSwitchFailure::SourceUnreadable)
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn symlink_inside_moved_tree_is_refused() {
    use std::os::unix::fs::symlink;
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let source = tmp.path().join("src-link");
    let target = tmp.path().join("dst-link");
    let outside = tmp.path().join("outside.db3");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&app_data).unwrap();
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    fs::write(&outside, b"outside").unwrap();
    symlink(&outside, source.join("linked.db3")).unwrap();

    let authority = open_test_authority(&tmp);
    authority
        .with_mut(|auth| {
            let root = auth.get_or_create_database_root(&source, "src-link", None)?;
            auth.set_active_database_root(&root)
        })
        .unwrap()
        .unwrap();

    let err = authority
        .with_mut(|auth| {
            auth.choose_folder_switch(FolderSwitchKind::Database, &target, "dst-link".into(), None)
        })
        .unwrap()
        .unwrap_err();
    assert_eq!(
        err.folder_switch_failure(),
        Some(FolderSwitchFailure::SymlinkInTree)
    );
}

#[test]
fn transfer_failure_rolls_back_and_rollback_failure_returns_closed_reason() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let source = tmp.path().join("src-fail");
    let target = tmp.path().join("dst-fail");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&app_data).unwrap();
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();

    let authority = open_test_authority(&tmp);
    let (h, a) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&h, &a);

    authority
        .with_mut(|auth| {
            let root = auth.get_or_create_database_root(&source, "src-fail", None)?;
            auth.set_active_database_root(&root)?;
            auth.create_database_child(&root, OsStr::new("one.db3"))?;
            auth.create_database_child(&root, OsStr::new("two.db3"))
        })
        .unwrap()
        .unwrap();

    // 1. Journal-write failure touches nothing
    let (grant, _, _) = authority
        .with_mut(|auth| {
            auth.choose_folder_switch(FolderSwitchKind::Database, &target, "dst-fail".into(), None)
        })
        .unwrap()
        .unwrap()
        .expect("Pending");
    let prepared = authority
        .with_mut(|auth| auth.prepare_folder_move(&grant))
        .unwrap()
        .unwrap()
        .ok()
        .unwrap();
    {
        let _fault = install_folder_switch_fault(FolderSwitchTestFault::FailJournalWrite);
        let err =
            execute_folder_move_blocking(&authority, &grant, &prepared, &lookups).unwrap_err();
        assert_eq!(
            err.folder_switch_failure(),
            Some(FolderSwitchFailure::JournalWriteFailed)
        );
    }
    assert!(source.join("one.db3").exists());
    assert!(source.join("two.db3").exists());
    assert!(!target.join("one.db3").exists());

    // 2. Transfer failure rolls back in-process (old root active, target clean)
    {
        let _fault = install_folder_switch_fault(FolderSwitchTestFault::FailTransferAfterFirst);
        let err =
            execute_folder_move_blocking(&authority, &grant, &prepared, &lookups).unwrap_err();
        assert_eq!(
            err.folder_switch_failure(),
            Some(FolderSwitchFailure::TransferFailedRolledBack)
        );
    }
    assert!(source.join("one.db3").exists());
    assert!(source.join("two.db3").exists());
    assert!(!target.join("one.db3").exists());
    assert!(!target.join("two.db3").exists());
    assert!(!authority
        .with_mut(|auth| auth.has_unresolved_journal(FolderSwitchKind::Database))
        .unwrap());

    // 3. Drive execute_folder_move_blocking with injected transfer + rollback failure:
    //    must return closed RollbackIncomplete (NOT OperationAndCleanup), keep journal, mark unresolved.
    {
        let _faults = install_folder_switch_faults(&[
            FolderSwitchTestFault::FailTransferAfterFirst,
            FolderSwitchTestFault::FailRollback,
        ]);
        let err =
            execute_folder_move_blocking(&authority, &grant, &prepared, &lookups).unwrap_err();
        assert_ne!(err.category(), ErrorCategory::OperationAndCleanup);
        assert_eq!(err.renderer_payload().tag, ErrorPayloadTag::FolderSwitch);
        assert_eq!(
            err.folder_switch_failure(),
            Some(FolderSwitchFailure::RollbackIncomplete)
        );
    }
    assert!(authority
        .with_mut(|auth| auth.has_unresolved_journal(FolderSwitchKind::Database))
        .unwrap());
    let journal_path = authority
        .with_mut(|auth| auth.journal_path(FolderSwitchKind::Database))
        .unwrap();
    assert!(journal_path.exists());
}

#[test]
fn rename_mode_crash_before_journal_write_recovers_item_to_source() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let source = tmp.path().join("src-crash");
    let target = tmp.path().join("dst-crash");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&app_data).unwrap();
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();

    let (h, a) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&h, &a);

    let mut auth = PathAuthority::open(tmp.path().join("registry.json"), vec![]).unwrap();
    let root = auth
        .get_or_create_database_root(&source, "src-crash", None)
        .unwrap();
    auth.set_active_database_root(&root).unwrap();
    auth.create_database_child(&root, OsStr::new("window.db3"))
        .unwrap();

    let src_id = dir_identity(&source);
    let dst_id = dir_identity(&target);
    let file_id = entry_identity_at(
        &open_directory_nofollow_readonly(&source).unwrap(),
        OsStr::new("window.db3"),
        false,
    )
    .unwrap();

    // Simulate crash AFTER rename_entry_at succeeded and BEFORE write_journal_file recorded transferred=true!
    fs::rename(source.join("window.db3"), target.join("window.db3")).unwrap();
    let journal = FolderSwitchJournal {
        version: JOURNAL_VERSION,
        kind: FolderSwitchKind::Database,
        grant_id: "g-window".into(),
        mode: TransferMode::Rename,
        source_root_id: root.path_ref().clone(),
        source_root_path: NativePath::from_path(&source),
        source_root_identity: Identity {
            a: src_id.0,
            b: src_id.1,
        },
        target_root_path: NativePath::from_path(&target),
        target_root_identity: Identity {
            a: dst_id.0,
            b: dst_id.1,
        },
        target_display_name: "dst-crash".into(),
        stage: JournalStage::Transferring,
        items: vec![JournalItem {
            leaf: NativePath::from_path(Path::new("window.db3")),
            is_dir: false,
            is_primary_db: true,
            source_identity: Identity {
                a: file_id.0,
                b: file_id.1,
            },
            target_identity: None,
            transferred: false,
        }],
    };
    auth.write_journal_file(&journal).unwrap();

    auth.recover_folder_switch_journals(&lookups);
    assert!(!auth.has_unresolved_journal(FolderSwitchKind::Database));
    assert!(source.join("window.db3").exists());
    assert!(!target.join("window.db3").exists());
}

#[test]
fn copy_mode_mid_copy_failure_and_crash_after_creation_leave_target_clean() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let source = tmp.path().join("src-mid");
    let target = tmp.path().join("dst-mid");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&app_data).unwrap();
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();

    let authority = open_test_authority(&tmp);
    let (h, a) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&h, &a);

    authority
        .with_mut(|auth| {
            let root = auth.get_or_create_database_root(&source, "src-mid", None)?;
            auth.set_active_database_root(&root)?;
            auth.create_database_child(&root, OsStr::new("big.db3"))
        })
        .unwrap()
        .unwrap();
    fs::write(source.join("big.db3"), vec![0xAB; 128 * 1024]).unwrap();

    let (grant, _, _) = authority
        .with_mut(|auth| {
            auth.choose_folder_switch(FolderSwitchKind::Database, &target, "dst-mid".into(), None)
        })
        .unwrap()
        .unwrap()
        .expect("Pending");
    let prepared = authority
        .with_mut(|auth| auth.prepare_folder_move(&grant))
        .unwrap()
        .unwrap()
        .ok()
        .unwrap();

    // 1. Mid-file copy failure removes partial destination file.
    {
        let _faults = install_folder_switch_faults(&[
            FolderSwitchTestFault::ForceCopyMode,
            FolderSwitchTestFault::FailCopyMidFile,
        ]);
        let err =
            execute_folder_move_blocking(&authority, &grant, &prepared, &lookups).unwrap_err();
        assert_eq!(
            err.folder_switch_failure(),
            Some(FolderSwitchFailure::TransferFailedRolledBack)
        );
    }
    assert!(fs::read_dir(&target).unwrap().next().is_none());
    assert!(source.join("big.db3").exists());

    // 2. Crash after destination file creation (transferred=false, target_identity=Some) recovers clean.
    fs::write(target.join("big.db3"), b"partial").unwrap();
    let partial_id = entry_identity_at(
        &open_directory_nofollow_readonly(&target).unwrap(),
        OsStr::new("big.db3"),
        false,
    )
    .unwrap();
    let src_file_id = entry_identity_at(
        &open_directory_nofollow_readonly(&source).unwrap(),
        OsStr::new("big.db3"),
        false,
    )
    .unwrap();
    let journal = FolderSwitchJournal {
        version: JOURNAL_VERSION,
        kind: FolderSwitchKind::Database,
        grant_id: "g-partial".into(),
        mode: TransferMode::Copy,
        source_root_id: prepared.source_root.clone(),
        source_root_path: NativePath::from_path(&source),
        source_root_identity: Identity {
            a: prepared.source_identity.0,
            b: prepared.source_identity.1,
        },
        target_root_path: NativePath::from_path(&target),
        target_root_identity: Identity {
            a: prepared.target_identity.0,
            b: prepared.target_identity.1,
        },
        target_display_name: "dst-mid".into(),
        stage: JournalStage::Transferring,
        items: vec![JournalItem {
            leaf: NativePath::from_path(Path::new("big.db3")),
            is_dir: false,
            is_primary_db: true,
            source_identity: Identity {
                a: src_file_id.0,
                b: src_file_id.1,
            },
            target_identity: Some(Identity {
                a: partial_id.0,
                b: partial_id.1,
            }),
            transferred: false,
        }],
    };
    authority
        .with_mut(|auth| {
            auth.write_journal_file(&journal)?;
            auth.recover_folder_switch_journals(&lookups);
            Ok::<_, Error>(())
        })
        .unwrap()
        .unwrap();
    assert!(!target.join("big.db3").exists());
    assert!(source.join("big.db3").exists());
    assert!(!authority
        .with_mut(|auth| auth.has_unresolved_journal(FolderSwitchKind::Database))
        .unwrap());
}

#[test]
fn journal_recovery_settles_prepared_transferring_committed_and_unrecoverable() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let source = tmp.path().join("src-rec");
    let target = tmp.path().join("dst-rec");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&app_data).unwrap();
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();

    let (h, a) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&h, &a);

    let mut auth = PathAuthority::open(tmp.path().join("registry.json"), vec![]).unwrap();
    let root = auth
        .get_or_create_database_root(&source, "src-rec", None)
        .unwrap();
    auth.set_active_database_root(&root).unwrap();
    auth.create_database_child(&root, OsStr::new("r.db3"))
        .unwrap();

    let src_id = dir_identity(&source);
    let dst_id = dir_identity(&target);
    let file_id = entry_identity_at(
        &open_directory_nofollow_readonly(&source).unwrap(),
        OsStr::new("r.db3"),
        false,
    )
    .unwrap();

    let make_journal = |mode, stage, target_identity, transferred| FolderSwitchJournal {
        version: JOURNAL_VERSION,
        kind: FolderSwitchKind::Database,
        grant_id: "g1".into(),
        mode,
        source_root_id: root.path_ref().clone(),
        source_root_path: NativePath::from_path(&source),
        source_root_identity: Identity {
            a: src_id.0,
            b: src_id.1,
        },
        target_root_path: NativePath::from_path(&target),
        target_root_identity: Identity {
            a: dst_id.0,
            b: dst_id.1,
        },
        target_display_name: "dst-rec".into(),
        stage,
        items: vec![JournalItem {
            leaf: NativePath::from_path(Path::new("r.db3")),
            is_dir: false,
            is_primary_db: true,
            source_identity: Identity {
                a: file_id.0,
                b: file_id.1,
            },
            target_identity,
            transferred,
        }],
    };

    // 1. Stage Prepared: nothing moved yet -> recovery deletes journal and leaves source intact.
    auth.write_journal_file(&make_journal(
        TransferMode::Rename,
        JournalStage::Prepared,
        None,
        false,
    ))
    .unwrap();
    auth.recover_folder_switch_journals(&lookups);
    assert!(!auth.has_unresolved_journal(FolderSwitchKind::Database));
    assert!(source.join("r.db3").exists());

    // 2. Stage Transferring (Rename): file in target, active root still source.
    fs::rename(source.join("r.db3"), target.join("r.db3")).unwrap();
    auth.write_journal_file(&make_journal(
        TransferMode::Rename,
        JournalStage::Transferring,
        Some(Identity {
            a: file_id.0,
            b: file_id.1,
        }),
        true,
    ))
    .unwrap();
    assert_eq!(
        auth.choose_folder_switch(FolderSwitchKind::Database, &target, "dst-rec".into(), None)
            .unwrap_err()
            .folder_switch_failure(),
        Some(FolderSwitchFailure::InterruptedMove)
    );
    assert_eq!(
        auth.database_folder_status(&lookups).unwrap().root_failure,
        Some(RootFailure::InterruptedMove)
    );
    assert_eq!(
        auth.active_database_root().unwrap_err().root_failure(),
        Some(RootFailure::InterruptedMove)
    );
    auth.recover_folder_switch_journals(&lookups);
    assert!(!auth.has_unresolved_journal(FolderSwitchKind::Database));
    assert!(source.join("r.db3").exists());
    assert!(!target.join("r.db3").exists());

    // 3. Stage Transferring (Copy): partial copy in target -> recovery deletes copy, leaves source.
    fs::copy(source.join("r.db3"), target.join("r.db3")).unwrap();
    let copy_id = entry_identity_at(
        &open_directory_nofollow_readonly(&target).unwrap(),
        OsStr::new("r.db3"),
        false,
    )
    .unwrap();
    auth.write_journal_file(&make_journal(
        TransferMode::Copy,
        JournalStage::Transferring,
        Some(Identity {
            a: copy_id.0,
            b: copy_id.1,
        }),
        true,
    ))
    .unwrap();
    auth.recover_folder_switch_journals(&lookups);
    assert!(!auth.has_unresolved_journal(FolderSwitchKind::Database));
    assert!(source.join("r.db3").exists());
    assert!(!target.join("r.db3").exists());

    // 4. Stage Committed (active_is_target == true): recovery deletes copied original from source!
    fs::copy(source.join("r.db3"), target.join("r.db3")).unwrap();
    let target_root = auth
        .get_or_create_database_root(&target, "dst-rec", None)
        .unwrap();
    auth.set_active_database_root(&target_root).unwrap();
    auth.write_journal_file(&make_journal(
        TransferMode::Copy,
        JournalStage::Committed,
        Some(Identity {
            a: copy_id.0,
            b: copy_id.1,
        }),
        true,
    ))
    .unwrap();
    auth.recover_folder_switch_journals(&lookups);
    assert!(!auth.has_unresolved_journal(FolderSwitchKind::Database));
    assert!(!source.join("r.db3").exists());
    assert!(target.join("r.db3").exists());

    // 5. Unrecoverable corrupt JSON + InterruptedMove winning over Activated on unusable source!
    fs::write(auth.journal_path(FolderSwitchKind::Database), b"{corrupt").unwrap();
    auth.recover_folder_switch_journals(&lookups);
    assert!(auth.has_unresolved_journal(FolderSwitchKind::Database));
    fs::remove_dir_all(&source).unwrap();
    assert_eq!(
        auth.choose_folder_switch(FolderSwitchKind::Database, &target, "dst-rec".into(), None)
            .unwrap_err()
            .folder_switch_failure(),
        Some(FolderSwitchFailure::InterruptedMove)
    );
}

#[test]
fn post_commit_cleanup_failure_returns_interrupted_move_status() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let source = tmp.path().join("src-cleanup");
    let target = tmp.path().join("dst-cleanup");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&app_data).unwrap();
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();

    let authority = open_test_authority(&tmp);
    let (h, a) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&h, &a);

    authority
        .with_mut(|auth| {
            let root = auth.get_or_create_database_root(&source, "src-cleanup", None)?;
            auth.set_active_database_root(&root)?;
            auth.create_database_child(&root, OsStr::new("c.db3"))
        })
        .unwrap()
        .unwrap();
    fs::write(source.join("c.db3"), b"cleanup-test").unwrap();

    let (grant, _, _) = authority
        .with_mut(|auth| {
            auth.choose_folder_switch(
                FolderSwitchKind::Database,
                &target,
                "dst-cleanup".into(),
                None,
            )
        })
        .unwrap()
        .unwrap()
        .expect("Pending");
    let prepared = authority
        .with_mut(|auth| auth.prepare_folder_move(&grant))
        .unwrap()
        .unwrap()
        .ok()
        .unwrap();

    let _faults = install_folder_switch_faults(&[
        FolderSwitchTestFault::ForceCopyMode,
        FolderSwitchTestFault::FailCleanup,
    ]);
    let status = execute_folder_move_blocking(&authority, &grant, &prepared, &lookups).unwrap();
    assert_eq!(status.root_failure, Some(RootFailure::InterruptedMove));
    assert!(authority
        .with_mut(|auth| auth.has_unresolved_journal(FolderSwitchKind::Database))
        .unwrap());
}

#[test]
fn use_only_reproves_both_source_and_target_identities() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let source_a = tmp.path().join("source-a");
    let target_b = tmp.path().join("target-b");
    let other_c = tmp.path().join("other-c");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&app_data).unwrap();
    fs::create_dir_all(&source_a).unwrap();
    fs::create_dir_all(&target_b).unwrap();
    fs::create_dir_all(&other_c).unwrap();

    let (h, a) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&h, &a);
    let mut auth = PathAuthority::open(tmp.path().join("registry.json"), vec![]).unwrap();

    let root_a = auth
        .get_or_create_database_root(&source_a, "source-a", None)
        .unwrap();
    auth.set_active_database_root(&root_a).unwrap();
    auth.create_database_child(&root_a, OsStr::new("stay.db3"))
        .unwrap();

    let (grant, _, count) = auth
        .choose_folder_switch(
            FolderSwitchKind::Database,
            &target_b,
            "target-b".into(),
            None,
        )
        .unwrap()
        .expect("Pending");
    assert_eq!(count, 1);

    // Switch active root to C before applying UseOnly -> source root changed -> IdentityChanged!
    let root_c = auth
        .get_or_create_database_root(&other_c, "other-c", None)
        .unwrap();
    auth.set_active_database_root(&root_c).unwrap();
    let err = auth
        .apply_folder_switch_use_only(&grant, &lookups)
        .unwrap_err();
    assert_eq!(
        err.folder_switch_failure(),
        Some(FolderSwitchFailure::IdentityChanged)
    );

    // Switch back to A, issue fresh grant, apply UseOnly -> succeeds and moves nothing.
    auth.set_active_database_root(&root_a).unwrap();
    let (grant2, _, _) = auth
        .choose_folder_switch(
            FolderSwitchKind::Database,
            &target_b,
            "target-b".into(),
            None,
        )
        .unwrap()
        .expect("Pending");
    let status = auth
        .apply_folder_switch_use_only(&grant2, &lookups)
        .unwrap();
    assert_eq!(status.display_name, "target-b");
    assert!(source_a.join("stay.db3").exists());
    assert!(!target_b.join("stay.db3").exists());
}

#[test]
fn engine_kind_move_copies_catalog_install_verifies_inventory_and_rebases_uses() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let source = tmp.path().join("src-eng");
    let target = tmp.path().join("dst-eng");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&app_data).unwrap();
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();

    let authority = open_test_authority(&tmp);
    let (h, a) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&h, &a);

    let (engine_root, engine_handle) = authority
        .with_mut(|auth| {
            let root = auth.get_or_create_engine_root(&source, "src-eng", None)?;
            auth.set_active_engine_root(&root)?;
            let root_path = auth.engine_root_path(&root)?;
            let stage = tempfile::tempdir_in(&root_path).unwrap();
            fs::write(stage.path().join("stockfish"), b"managed-engine-binary").unwrap();
            fs::create_dir(stage.path().join("nnue")).unwrap();
            fs::write(stage.path().join("nnue/net.nnue"), b"managed-net-bytes").unwrap();
            let mut owner = OwnedStagingDir::adopt(&stage).unwrap();
            let _kept = stage.keep();
            let resolved = auth.resolve(
                root.path_ref(),
                PathOperation::DownloadArchive,
                &[OsString::from("sf-17")],
            )?;
            auth.publish_catalog_install(root.path_ref(), &resolved, &mut owner)?;
            let handle = auth.register_installed_engine_for_test(&root, "sf-17/stockfish")?;
            let bin_resolved =
                auth.resolve(handle.path_ref(), PathOperation::EngineExecute, &[])?;
            let bin_path = bin_resolved.target().unwrap().to_path_buf();
            auth.protect_catalog_path(&bin_path, false, false, None)?;
            Ok::<_, Error>((root, handle))
        })
        .unwrap()
        .unwrap();

    // Symlink inside engine tree is refused.
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let outside = tmp.path().join("outside-bin");
        fs::write(&outside, b"x").unwrap();
        let bad_link = source.join("sf-17/bad-link");
        symlink(&outside, &bad_link).unwrap();
        let err = authority
            .with_mut(|auth| {
                auth.choose_folder_switch(FolderSwitchKind::Engine, &target, "dst-eng".into(), None)
            })
            .unwrap()
            .unwrap_err();
        fs::remove_file(&bad_link).unwrap();
        assert_eq!(
            err.folder_switch_failure(),
            Some(FolderSwitchFailure::SymlinkInTree)
        );
    }

    // Mid-tree copy failure leaves target clean.
    let (grant, _, count) = authority
        .with_mut(|auth| {
            auth.choose_folder_switch(FolderSwitchKind::Engine, &target, "dst-eng".into(), None)
        })
        .unwrap()
        .unwrap()
        .expect("Pending");
    assert_eq!(count, 1);
    let prepared = authority
        .with_mut(|auth| auth.prepare_folder_move(&grant))
        .unwrap()
        .unwrap()
        .ok()
        .unwrap();
    {
        let _faults = install_folder_switch_faults(&[
            FolderSwitchTestFault::ForceCopyMode,
            FolderSwitchTestFault::FailCopyMidTree,
        ]);
        let err =
            execute_folder_move_blocking(&authority, &grant, &prepared, &lookups).unwrap_err();
        assert_eq!(
            err.folder_switch_failure(),
            Some(FolderSwitchFailure::TransferFailedRolledBack)
        );
        assert!(fs::read_dir(&target).unwrap().next().is_none());
    }

    // SHA-256 inventory mismatch at the new root is rejected by rebase_catalog_installs_for_move
    // and rolls back cleanly.
    {
        let _faults = install_folder_switch_faults(&[
            FolderSwitchTestFault::ForceCopyMode,
            FolderSwitchTestFault::CorruptCopiedEngineFileBeforeCommit,
        ]);
        let err =
            execute_folder_move_blocking(&authority, &grant, &prepared, &lookups).unwrap_err();
        assert_eq!(
            err.folder_switch_failure(),
            Some(FolderSwitchFailure::TransferFailedRolledBack)
        );
        assert!(fs::read_dir(&target).unwrap().next().is_none());
        assert!(source.join("sf-17/nnue/net.nnue").exists());
    }

    // Now complete Copy move -> tree copied, inventory SHA-256 verified, catalog_installs &
    // catalog_uses rebased, and same PathRef resolves!
    let _fault = install_folder_switch_fault(FolderSwitchTestFault::ForceCopyMode);
    let status = execute_folder_move_blocking(&authority, &grant, &prepared, &lookups).unwrap();
    assert_eq!(status.display_name, "dst-eng");
    assert!(target.join("sf-17/stockfish").exists());
    assert!(target.join("sf-17/nnue/net.nnue").exists());
    assert!(!source.join("sf-17").exists());

    let resolved = authority
        .with_mut(|auth| auth.resolve(engine_handle.path_ref(), PathOperation::EngineExecute, &[]))
        .unwrap()
        .unwrap();
    let resolved_path = resolved.target().unwrap().to_path_buf();
    let resolved_id = resolved.identity().unwrap().pair();
    let target_dir_id = dir_identity(&target);
    assert_eq!(
        dir_identity(resolved_path.parent().unwrap().parent().unwrap()),
        target_dir_id
    );

    // Inspect catalog_installs and catalog_uses after the move!
    authority
        .with_mut(|auth| {
            let installs = auth.active_catalog_install_identities_for_test();
            assert_eq!(installs.len(), 1);
            assert_eq!(
                installs[0].0, target_dir_id,
                "catalog_installs record must be rebased to target root identity"
            );
            assert_eq!(
                installs[0].1,
                dir_identity(&target.join("sf-17")),
                "catalog_installs record identity must match destination directory"
            );
            assert!(
                auth.catalog_uses.contains_key(&(
                    resolved_path.clone(),
                    resolved_id.0,
                    resolved_id.1
                )),
                "catalog_uses must be re-keyed to the moved destination path and identity"
            );
        })
        .unwrap();
    let _ = engine_root;
}

#[cfg(unix)]
#[test]
fn descendant_matching_by_identity_works_with_variant_root_spelling() {
    use std::os::unix::fs::symlink;
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let real_src = tmp.path().join("real-src");
    let alias_parent = tmp.path().join("alias-parent");
    let target = tmp.path().join("dst-variant");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&app_data).unwrap();
    fs::create_dir_all(&real_src).unwrap();
    fs::create_dir_all(&alias_parent).unwrap();
    fs::create_dir_all(&target).unwrap();
    let alias_src = alias_parent.join("link-src");
    symlink(&real_src, &alias_src).unwrap();

    let authority = open_test_authority(&tmp);
    let (h, a) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&h, &a);

    // Register root and child under real_src, then rewrite the root's stored path to a distinct
    // spelling (alias_src) so `child_path.strip_prefix(&source_path)` fails while live directory
    // identity still matches!
    let (root_handle, db_handle) = authority
        .with_mut(|auth| {
            let root = auth.get_or_create_database_root(&real_src, "real-src", None)?;
            auth.set_active_database_root(&root)?;
            let child = auth.create_database_child(&root, OsStr::new("variant.db3"))?;
            Ok::<_, Error>((root, child))
        })
        .unwrap()
        .unwrap();

    // Tombstone recorded under alias spelling must still block quiesce_root on real_src!
    let repo = crate::db::DatabaseRepository::default();
    let alias_db_path = alias_src.join("variant.db3");
    repo.insert_tombstone_for_test(alias_db_path.clone());
    let busy = repo.quiesce_root(
        dir_identity(&real_src),
        &real_src,
        &CancellationToken::new(),
    );
    repo.remove_tombstone_for_test(&alias_db_path);
    assert_eq!(
        busy.err().and_then(|e| e.folder_switch_failure()),
        Some(FolderSwitchFailure::RootBusy),
        "tombstone under variant parent spelling must still be detected by parent identity"
    );

    // An unrelated tombstone in another existing directory must NOT block quiesce_root.
    let unrelated_db_path = target.join("unrelated.db3");
    repo.insert_tombstone_for_test(unrelated_db_path.clone());
    let unrelated_guard = repo
        .quiesce_root(
            dir_identity(&real_src),
            &real_src,
            &CancellationToken::new(),
        )
        .expect("unrelated tombstone in another existing directory must not block quiesce_root");
    unrelated_guard.lift();
    repo.remove_tombstone_for_test(&unrelated_db_path);

    // A tombstone whose parent directory cannot be probed must conservatively block quiesce_root.
    let unprobable_db_path = tmp.path().join("missing-parent-dir").join("ghost.db3");
    repo.insert_tombstone_for_test(unprobable_db_path.clone());
    let unprobable_busy = repo.quiesce_root(
        dir_identity(&real_src),
        &real_src,
        &CancellationToken::new(),
    );
    repo.remove_tombstone_for_test(&unprobable_db_path);
    assert_eq!(
        unprobable_busy
            .err()
            .and_then(|e| e.folder_switch_failure()),
        Some(FolderSwitchFailure::RootBusy),
        "unprobable tombstone parent must conservatively block quiesce_root"
    );

    // Move files from real_src -> target, then run commit_folder_move with prepared.source_path
    // set to alias_src (a variant spelling where strip_prefix fails!) -> commit_folder_move must
    // still rebase `db_handle` by ancestor identity!
    let (grant, _, _) = authority
        .with_mut(|auth| {
            auth.choose_folder_switch(
                FolderSwitchKind::Database,
                &target,
                "dst-variant".into(),
                None,
            )
        })
        .unwrap()
        .unwrap()
        .expect("Pending");
    let mut prepared = authority
        .with_mut(|auth| auth.prepare_folder_move(&grant))
        .unwrap()
        .unwrap()
        .ok()
        .unwrap();
    let file_id = entry_identity_at(
        &open_directory_nofollow_readonly(&real_src).unwrap(),
        OsStr::new("variant.db3"),
        false,
    )
    .unwrap();
    fs::rename(real_src.join("variant.db3"), target.join("variant.db3")).unwrap();
    prepared.source_path = alias_src.clone();
    let moved_items = vec![JournalItem {
        leaf: NativePath::from_path(Path::new("variant.db3")),
        is_dir: false,
        is_primary_db: true,
        source_identity: Identity {
            a: file_id.0,
            b: file_id.1,
        },
        target_identity: Some(Identity {
            a: file_id.0,
            b: file_id.1,
        }),
        transferred: true,
    }];
    authority
        .with_mut(|auth| auth.commit_folder_move(&grant, &prepared, &moved_items, &lookups))
        .unwrap()
        .unwrap();
    let resolved = authority
        .with_mut(|auth| auth.database_file_target(&db_handle, PathOperation::DatabaseRead))
        .unwrap()
        .unwrap();
    assert_eq!(
        opened_file_identity(resolved.parent()).unwrap(),
        dir_identity(&target)
    );
    let _ = root_handle;
}

#[tokio::test]
async fn engine_root_quiesce_blocks_new_registrations_and_drains_resource_lease_actors() {
    let tmp = TempDir::new().unwrap();
    let eng_root = tmp.path().join("eng-root");
    let other_dir = tmp.path().join("other-dir");
    fs::create_dir_all(&eng_root).unwrap();
    fs::create_dir_all(&other_dir).unwrap();
    let bin_in_root = eng_root.join("engine.bin");
    let res_in_root = eng_root.join("weights.nnue");
    fs::write(&bin_in_root, b"bin").unwrap();
    fs::write(&res_in_root, b"nnue").unwrap();

    let mut auth = PathAuthority::open(tmp.path().join("registry.json"), vec![]).unwrap();
    let engine_root_handle = auth
        .get_or_create_engine_root(&eng_root, "eng-root", None)
        .unwrap();
    auth.set_active_engine_root(&engine_root_handle).unwrap();
    let root_id = dir_identity(&eng_root);

    // Pre-resolve a DownloadArchive target before quiesce so we can test publish_catalog_install refusal too.
    let pre_resolved = auth
        .resolve(
            engine_root_handle.path_ref(),
            PathOperation::DownloadArchive,
            &[OsString::from("pkg-mid-move")],
        )
        .unwrap();
    let stage = tempfile::tempdir_in(&eng_root).unwrap();
    fs::write(stage.path().join("engine"), b"bin").unwrap();
    let mut stage_owner = OwnedStagingDir::adopt(&stage).unwrap();
    let _kept = stage.keep();

    let guard = auth.quiesce_engine_root(root_id);

    // While root is quiesced:
    // 1. Registering a new binary under that root is refused.
    assert!(auth.register_engine_file(&bin_in_root, "engine").is_err());
    // 2. Resolving DownloadArchive under that root is refused (P3-09).
    assert!(
        auth.resolve(
            engine_root_handle.path_ref(),
            PathOperation::DownloadArchive,
            &[OsString::from("new-download")],
        )
        .is_err(),
        "DownloadArchive must be refused while engine root is quiesced"
    );
    // 3. Publishing a staged catalog install under that root is refused (P3-09).
    assert!(
        auth.publish_catalog_install(
            engine_root_handle.path_ref(),
            &pre_resolved,
            &mut stage_owner,
        )
        .is_err(),
        "publish_catalog_install must be refused while engine root is quiesced"
    );

    // After lifting the barrier, registration succeeds.
    guard.lift();
    let registered = auth.register_engine_file(&bin_in_root, "engine").unwrap();
    let _ = auth
        .resolve(registered.path_ref(), PathOperation::EngineExecute, &[])
        .unwrap();

    // Quiescing again refuses resolve for EngineExecute on the registered handle too.
    let guard2 = auth.quiesce_engine_root(root_id);
    assert!(auth
        .resolve(registered.path_ref(), PathOperation::EngineExecute, &[])
        .is_err());
    guard2.lift();

    // P3-10: Real published AND pending actors whose executable is OUTSIDE the engines root,
    // holding a real EngineResourceLease under the root, are both drained by quiesce_executables!
    let supervisor = crate::engine::EngineSupervisor::default();
    let exec_ref = PathRef::fresh();
    let res_ref = PathRef::fresh();

    #[cfg(unix)]
    {
        let external_exec_ref = PathRef::fresh();
        let lease_pub = std::sync::Arc::new(
            EngineResourceLease::test_file(fs::File::open(&res_in_root).unwrap())
                .with_path_ref(res_ref.clone()),
        );
        let lease_pend = std::sync::Arc::new(
            EngineResourceLease::test_file(fs::File::open(&res_in_root).unwrap())
                .with_path_ref(res_ref.clone()),
        );
        let pub_key = crate::engine::EngineKey::new("tab-pub".into(), "ext-1".into()).unwrap();
        let pend_key = crate::engine::EngineKey::new("tab-pend".into(), "ext-2".into()).unwrap();
        supervisor.insert_test_actor_with_resources(
            pub_key,
            "ext-1".into(),
            external_exec_ref.clone(),
            vec![lease_pub],
            false,
        );
        supervisor.insert_test_actor_with_resources(
            pend_key,
            "ext-2".into(),
            external_exec_ref,
            vec![lease_pend],
            true,
        );
        assert_eq!(supervisor.actor_count_for_test(), 1);
        assert_eq!(supervisor.pending_actor_count_for_test(), 1);
    }

    let key = crate::engine::EngineKey::new("tab-1".into(), "engine-1".into()).unwrap();
    let _gen = supervisor
        .prepare_engine_search(key.clone(), "engine-1".into(), exec_ref.clone())
        .await
        .unwrap();
    let mut exec_set = HashSet::new();
    exec_set.insert(exec_ref.clone());
    let mut res_set = HashSet::new();
    res_set.insert(res_ref.clone());
    let sup_guard = supervisor
        .quiesce_executables(exec_set, res_set)
        .await
        .unwrap();
    #[cfg(unix)]
    {
        assert_eq!(
            supervisor.actor_count_for_test(),
            0,
            "published actor holding resource lease under quiesced root must be drained"
        );
        assert_eq!(
            supervisor.pending_actor_count_for_test(),
            0,
            "pending actor holding resource lease under quiesced root must be drained"
        );
    }
    assert!(supervisor
        .prepare_engine_search(key.clone(), "engine-1".into(), exec_ref.clone())
        .await
        .is_err());
    sup_guard.lift();
    let gen2 = supervisor
        .prepare_engine_search(key, "engine-1".into(), exec_ref)
        .await
        .unwrap();
    assert!(!gen2.is_empty());
}

#[test]
fn database_and_puzzle_quiesce_barriers_caches_and_operations() {
    let tmp = TempDir::new().unwrap();
    let db_dir = tmp.path().join("dbs");
    fs::create_dir_all(&db_dir).unwrap();
    let mut auth = PathAuthority::open(tmp.path().join("registry.json"), vec![]).unwrap();
    let root = auth
        .get_or_create_database_root(&db_dir, "dbs", None)
        .unwrap();
    auth.set_active_database_root(&root).unwrap();
    let db_handle = auth
        .create_database_child(&root, OsStr::new("q.db3"))
        .unwrap();
    create_initialized_sqlite_db(&db_dir.join("q.db3"));

    let target = auth
        .database_file_target(&db_handle, PathOperation::DatabaseRead)
        .unwrap();
    let repo = crate::db::DatabaseRepository::default();
    let root_id = dir_identity(&db_dir);

    // Before quiesce, read-only identity probe works.
    let db_id = repo
        .database_identity_expected(&target, target.identity(), None)
        .unwrap();

    // Seed a content-validation failure under db_dir -> quiesce_root must evict it!
    crate::db::seed_content_validation_failure_for_test(
        &repo,
        db_dir.join("q.db3"),
        root_id,
        db_id.clone(),
    );
    assert_eq!(
        crate::db::content_validation_failure_count_for_test(&repo),
        1
    );

    // Tombstone blocks quiesce_root with RootBusy AND does not leak the barrier on failure!
    repo.insert_tombstone_for_test(db_dir.join("q.db3"));
    let busy_err = repo
        .quiesce_root(root_id, &db_dir, &CancellationToken::new())
        .err()
        .and_then(|e| e.folder_switch_failure());
    assert_eq!(busy_err, Some(FolderSwitchFailure::RootBusy));
    assert!(
        !repo.is_root_quiesced(root_id),
        "quiesce_root failure must not leave root barrier installed"
    );
    repo.remove_tombstone_for_test(&db_dir.join("q.db3"));

    // Populate SearchCache with a real MmapSearchIndex before quiescing!
    let index_source = crate::IndexSource::from_database_identity(&db_id).unwrap();
    let _ = crate::db::SearchIndexChunk::new()
        .write_to_with_source(db_dir.join("q.db3.ecsi"), index_source.clone())
        .unwrap();
    let search_cache = crate::SearchCache::default();
    let (idx_id, mmap_idx) =
        crate::db::open_valid_preferred(&target, &index_source, &CancellationToken::new(), None)
            .unwrap()
            .expect("valid .ecsi");
    let snap = search_cache.invalidation_snapshot();
    let _ = search_cache.insert_index(idx_id.clone(), mmap_idx.clone(), snap);
    assert_eq!(search_cache.cached_index_count(), 1);

    // While quiesced, BOTH pooled opens and read-only identity probes are refused, and
    // content_validation failures are evicted!
    let guard = repo
        .quiesce_root(root_id, &db_dir, &CancellationToken::new())
        .unwrap();
    assert_eq!(
        crate::db::content_validation_failure_count_for_test(&repo),
        0,
        "quiesce_root must evict cached content-validation failures for the root"
    );
    assert!(
        repo.database_identity_expected(&target, target.identity(), None)
            .is_err(),
        "read-only search path must be refused while root is quiesced"
    );
    assert!(
        repo.connection(&target, None).is_err(),
        "pooled connection must be refused while root is quiesced"
    );

    // SearchCache::quiesce_root evicts the populated entry AND refuses repopulation while held!
    let sc_guard = search_cache.quiesce_root(root_id);
    assert_eq!(search_cache.cached_index_count(), 0);
    let snap2 = search_cache.invalidation_snapshot();
    let _ = search_cache.insert_index(idx_id.clone(), mmap_idx.clone(), snap2);
    assert_eq!(
        search_cache.cached_index_count(),
        0,
        "SearchCache must refuse repopulation while root is quiesced"
    );
    drop(sc_guard);
    let snap3 = search_cache.invalidation_snapshot();
    let _ = search_cache.insert_index(idx_id, mmap_idx, snap3);
    assert_eq!(search_cache.cached_index_count(), 1);

    // Lifting the guard restores access.
    guard.lift();
    assert!(repo
        .database_identity_expected(&target, target.identity(), None)
        .is_ok());

    // OperationRegistry: has_uninterruptible_work and cancel_active_reads.
    let ops = crate::infra::operations::OperationRegistry::default();
    assert!(!ops.has_uninterruptible_work());
    let read_ticket = ops.prepare_read("owner-1").unwrap();
    let read_lease = ops
        .claim_read(&read_ticket, "owner-1", "get_games")
        .unwrap();
    assert!(!ops.has_uninterruptible_work());
    let conv_ticket = ops.prepare_conversion("owner-1").unwrap();
    let write_lease = ops.claim_conversion(&conv_ticket, "owner-1").unwrap();
    assert!(ops.has_uninterruptible_work());
    ops.cancel_active_reads();
    assert!(read_lease.token().is_cancelled());
    assert!(!write_lease.token().is_cancelled());
    drop(write_lease);
    assert!(!ops.has_uninterruptible_work());

    // PuzzleCache::clear_for_root clears a populated cache entry under root_id!
    let mut puzzle_cache = crate::puzzle::PuzzleCache::new();
    puzzle_cache.seed_for_test(db_dir.join("q.db3"));
    assert!(!puzzle_cache.is_empty());
    puzzle_cache.clear_for_root(root_id, &db_dir);
    assert!(puzzle_cache.is_empty());
}

#[test]
fn concurrent_writer_for_same_kind_refuses_switch_in_progress() {
    let coordinator = FolderSwitchCoordinator::default();
    let _first = coordinator.try_acquire(FolderSwitchKind::Database).unwrap();
    let second = coordinator.try_acquire(FolderSwitchKind::Database);
    assert_eq!(
        second.err().and_then(|e| e.folder_switch_failure()),
        Some(FolderSwitchFailure::SwitchInProgress)
    );
    // Backstop drop during unwinding catches panics and never aborts.
    let _backstop_fault = install_folder_switch_fault(FolderSwitchTestFault::PanicInBackstop);
    let caught = std::panic::catch_unwind(|| {
        let _backstop = MoveBackstopGuard::new(FolderSwitchKind::Database);
        panic!("simulated unwind");
    });
    assert!(caught.is_err());
    assert!(!is_test_fault_pending(
        FolderSwitchTestFault::PanicInBackstop
    ));
}

#[test]
fn collision_folding_rules_and_no_apply_error_carries_a_path() {
    // Call production `fold_leaf_name_for_collision` directly.
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        assert_ne!(
            fold_leaf_name_for_collision(OsStr::new("Game.db3")),
            fold_leaf_name_for_collision(OsStr::new("game.db3"))
        );
        assert_eq!(
            fold_leaf_name_for_collision(OsStr::new("Game.db3")),
            fold_leaf_name_for_collision(OsStr::new("Game.db3"))
        );
    }
    #[cfg(target_os = "macos")]
    {
        assert_eq!(
            fold_leaf_name_for_collision(OsStr::new("Game.db3")),
            fold_leaf_name_for_collision(OsStr::new("game.db3"))
        );
        // NFC vs NFD (é = U+00E9 vs e + U+0301)
        assert_eq!(
            fold_leaf_name_for_collision(OsStr::new("caf\u{00E9}.db3")),
            fold_leaf_name_for_collision(OsStr::new("cafe\u{0301}.db3"))
        );
    }
    #[cfg(windows)]
    {
        assert_eq!(
            fold_leaf_name_for_collision(OsStr::new("Game.db3")),
            fold_leaf_name_for_collision(OsStr::new("game.db3"))
        );
    }

    let all_failures = [
        FolderSwitchFailure::SameFolder,
        FolderSwitchFailure::NestedFolders,
        FolderSwitchFailure::NameCollision { count: 3 },
        FolderSwitchFailure::TargetUnwritable,
        FolderSwitchFailure::SourceUnreadable,
        FolderSwitchFailure::RootBusy,
        FolderSwitchFailure::ExpiredGrant,
        FolderSwitchFailure::IdentityChanged,
        FolderSwitchFailure::JournalWriteFailed,
        FolderSwitchFailure::QuiesceFailed,
        FolderSwitchFailure::SymlinkInTree,
        FolderSwitchFailure::TransferFailedRolledBack,
        FolderSwitchFailure::RollbackIncomplete,
        FolderSwitchFailure::InterruptedMove,
        FolderSwitchFailure::SwitchInProgress,
    ];
    for failure in all_failures {
        let error = Error::FolderSwitch(failure);
        let payload = error.renderer_payload();
        assert_eq!(payload.tag, ErrorPayloadTag::FolderSwitch);
        assert!(!payload.message.contains('/'));
        assert!(!payload.message.contains('\\'));
        assert!(!payload.message.contains(".json"));
        assert!(!payload.message.contains("folder-switch-"));
    }
}
