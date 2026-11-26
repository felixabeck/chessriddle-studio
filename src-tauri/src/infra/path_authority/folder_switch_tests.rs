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
    let status = execute_folder_move_blocking(
        &authority,
        Some(&grant),
        &prepared,
        &lookups,
        &CancellationToken::new(),
    )
    .unwrap();
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
    let status = execute_folder_move_blocking(
        &authority,
        Some(&grant),
        &prepared,
        &lookups,
        &CancellationToken::new(),
    )
    .unwrap();
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
    execute_folder_move_blocking(
        &authority,
        Some(&grant),
        &prepared,
        &lookups,
        &CancellationToken::new(),
    )
    .unwrap();

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
    let err = execute_folder_move_blocking(
        &authority,
        Some(&grant),
        &prepared,
        &lookups,
        &CancellationToken::new(),
    )
    .unwrap_err();
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
    execute_folder_move_blocking(
        &authority,
        Some(&grant),
        &prepared,
        &lookups,
        &CancellationToken::new(),
    )
    .unwrap();

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
    let err = execute_folder_move_blocking(
        &authority,
        Some(&nested_grant),
        &prepared_nested,
        &lookups,
        &CancellationToken::new(),
    )
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
    let err = execute_folder_move_blocking(
        &authority,
        Some(&outer_grant),
        &prepared_outer,
        &lookups,
        &CancellationToken::new(),
    )
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
    let err = execute_folder_move_blocking(
        &authority,
        Some(&col_grant),
        &prepared_col,
        &lookups,
        &CancellationToken::new(),
    )
    .unwrap_err();
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
    let err = execute_folder_move_blocking(
        &authority,
        Some(&nested_grant),
        &same_prepared,
        &lookups,
        &CancellationToken::new(),
    )
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
            let err = execute_folder_move_blocking(
                &authority,
                Some(&ro_grant),
                &ro_prepared,
                &lookups,
                &CancellationToken::new(),
            )
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
        let err = execute_folder_move_blocking(
            &authority,
            Some(&grant),
            &prepared,
            &lookups,
            &CancellationToken::new(),
        )
        .unwrap_err();
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
        let err = execute_folder_move_blocking(
            &authority,
            Some(&grant),
            &prepared,
            &lookups,
            &CancellationToken::new(),
        )
        .unwrap_err();
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
        let err = execute_folder_move_blocking(
            &authority,
            Some(&grant),
            &prepared,
            &lookups,
            &CancellationToken::new(),
        )
        .unwrap_err();
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
        let err = execute_folder_move_blocking(
            &authority,
            Some(&grant),
            &prepared,
            &lookups,
            &CancellationToken::new(),
        )
        .unwrap_err();
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
    let status = execute_folder_move_blocking(
        &authority,
        Some(&grant),
        &prepared,
        &lookups,
        &CancellationToken::new(),
    )
    .unwrap();
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
        let err = execute_folder_move_blocking(
            &authority,
            Some(&grant),
            &prepared,
            &lookups,
            &CancellationToken::new(),
        )
        .unwrap_err();
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
        let err = execute_folder_move_blocking(
            &authority,
            Some(&grant),
            &prepared,
            &lookups,
            &CancellationToken::new(),
        )
        .unwrap_err();
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
    let status = execute_folder_move_blocking(
        &authority,
        Some(&grant),
        &prepared,
        &lookups,
        &CancellationToken::new(),
    )
    .unwrap();
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
        .with_mut(|auth| auth.commit_folder_move(Some(&grant), &prepared, &moved_items, &lookups))
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

fn make_test_default_dir_source(
    home_dir: &Path,
    app_data_dir: &Path,
) -> DefaultDirSource<tauri::test::MockRuntime> {
    let home_path = home_dir.to_path_buf();
    let app_path = app_data_dir.to_path_buf();
    DefaultDirSource::Custom {
        home: Arc::new(move || Ok(HomeDir::for_test(&home_path, "com.chessriddle.studio"))),
        app_data: Arc::new(move || Ok(AppDataDir::for_test(&app_path))),
    }
}

fn make_migration_app_state(authority: SharedPathAuthority) -> crate::AppState {
    crate::AppState {
        pgn_path_authority: authority,
        ..crate::AppState::default()
    }
}

#[tokio::test]
async fn legacy_default_migration_moves_content_keeps_ids_and_removes_legacy_dir() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&app_data).unwrap();
    let (home_fn, app_fn) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&home_fn, &app_fn);
    let default_dirs = make_test_default_dir_source(&home, &app_data);

    let legacy_db_dir = app_data.join("db");
    let legacy_puzzle_dir = app_data.join("puzzles");
    let legacy_engine_dir = app_data.join("engines");
    fs::create_dir_all(&legacy_db_dir).unwrap();
    fs::create_dir_all(&legacy_puzzle_dir).unwrap();
    fs::create_dir_all(&legacy_engine_dir).unwrap();

    let authority = open_test_authority(&tmp);
    let (db_handle, puzzle_handle, engine_handle, engine_resource_handle) = authority
        .with_mut(|auth| {
            // Seed legacy database root with one database.
            let db_root = auth
                .get_or_create_database_root(
                    &legacy_db_dir,
                    "db",
                    Some(VerifiedIdentity::from_pair(dir_identity(&legacy_db_dir))),
                )
                .unwrap();
            auth.set_active_database_root(&db_root).unwrap();
            create_initialized_sqlite_db(&legacy_db_dir.join("legacy-games.db3"));
            let db_listing = auth
                .list_database_children_cancellable(&db_root, &CancellationToken::new())
                .unwrap();
            let db_handle = db_listing.entries[0].handle.clone();

            // Seed legacy puzzle root with one puzzle database.
            let puzzle_root = auth
                .get_or_create_puzzle_root(
                    &legacy_puzzle_dir,
                    "puzzles",
                    Some(VerifiedIdentity::from_pair(dir_identity(
                        &legacy_puzzle_dir,
                    ))),
                )
                .unwrap();
            auth.set_active_puzzle_root(&puzzle_root).unwrap();
            create_initialized_sqlite_db(&legacy_puzzle_dir.join("legacy-puzzles.db3"));
            let puzzle_listing = auth
                .list_puzzle_children_cancellable(&puzzle_root, &CancellationToken::new())
                .unwrap();
            let puzzle_handle = puzzle_listing[0].file.clone();

            // Seed legacy engine root with one catalog install and one registered resource file.
            let engine_root = auth
                .get_or_create_engine_root(
                    &legacy_engine_dir,
                    "engines",
                    Some(VerifiedIdentity::from_pair(dir_identity(
                        &legacy_engine_dir,
                    ))),
                )
                .unwrap();
            auth.set_active_engine_root(&engine_root).unwrap();
            let root_path = auth.engine_root_path(&engine_root).unwrap();
            let stage = tempfile::tempdir_in(&root_path).unwrap();
            fs::write(stage.path().join("stockfish"), b"#!/bin/sh\necho uciok\n").unwrap();
            fs::write(stage.path().join("nn.nnue"), b"weights-bytes").unwrap();
            let mut owner = OwnedStagingDir::adopt(&stage).unwrap();
            let _kept = stage.keep();
            let resolved_install = auth
                .resolve(
                    engine_root.path_ref(),
                    PathOperation::DownloadArchive,
                    &[OsString::from("stockfish-legacy1234")],
                )
                .unwrap();
            auth.publish_catalog_install(engine_root.path_ref(), &resolved_install, &mut owner)
                .unwrap();
            let engine_handle = auth
                .register_installed_engine_for_test(&engine_root, "stockfish-legacy1234/stockfish")
                .unwrap();
            let res_path = legacy_engine_dir.join("stockfish-legacy1234/nn.nnue");
            let res_grant = auth
                .grant_dialog(
                    &res_path,
                    "nn.nnue",
                    PathClass::SingleDialogGrant,
                    PathOperation::EngineResourceRead,
                    PICKER_DIALOG_GRANT_TTL,
                    1,
                )
                .unwrap();
            let engine_resource_handle = auth
                .promote_engine_resource(&res_grant, EngineResourceHandleKind::File, "nn.nnue")
                .unwrap();

            (
                db_handle,
                puzzle_handle,
                engine_handle,
                engine_resource_handle,
            )
        })
        .unwrap();

    let candidates = authority
        .with_mut(|auth| auth.plan_legacy_default_migrations(&lookups))
        .unwrap();
    assert_eq!(candidates.len(), 3);
    let engine_candidate = candidates
        .iter()
        .find(|c| c.kind == FolderSwitchKind::Engine)
        .expect("Engine candidate must be planned");
    assert!(
        engine_candidate
            .engine_descendants
            .contains(&engine_handle.id),
        "Engine candidate must include registered engine executable in engine_descendants"
    );
    assert!(
        engine_candidate
            .engine_descendants
            .contains(engine_resource_handle.path_ref()),
        "Engine candidate must include registered engine resource in engine_descendants"
    );

    let state = make_migration_app_state(authority.clone());
    let pending = state.folder_switch.raise_migration_gates(candidates);
    for kind in FolderSwitchKind::ALL {
        assert!(state.folder_switch.is_migration_gated(kind));
    }

    crate::workspace_commands::run_legacy_default_migrations(state.clone(), default_dirs, pending)
        .await;

    for kind in FolderSwitchKind::ALL {
        assert!(!state.folder_switch.is_migration_gated(kind));
    }

    let visible_db = home.join("ChessRiddle Studio/Databases");
    let visible_puzzles = home.join("ChessRiddle Studio/Puzzles");
    let visible_engines = home.join("ChessRiddle Studio/Engines");
    assert!(visible_db.join("legacy-games.db3").exists());
    assert!(visible_puzzles.join("legacy-puzzles.db3").exists());
    assert!(visible_engines
        .join("stockfish-legacy1234/stockfish")
        .exists());
    assert!(
        !legacy_db_dir.exists(),
        "empty legacy db dir must be removed"
    );
    assert!(
        !legacy_puzzle_dir.exists(),
        "empty legacy puzzles dir must be removed"
    );
    assert!(
        !legacy_engine_dir.exists(),
        "empty legacy engines dir must be removed"
    );

    authority
        .with_mut(|auth| {
            // Every PathRef id is preserved and resolves at the new visible default.
            let resolved_db = auth
                .resolve(db_handle.path_ref(), PathOperation::DatabaseRead, &[])
                .unwrap();
            assert_eq!(
                resolved_db.target().unwrap().to_path_buf(),
                visible_db.join("legacy-games.db3").canonicalize().unwrap()
            );
            let resolved_puzzle = auth
                .resolve(&puzzle_handle, PathOperation::PuzzleRead, &[])
                .unwrap();
            assert_eq!(
                resolved_puzzle.puzzle_database_path().unwrap(),
                visible_puzzles
                    .join("legacy-puzzles.db3")
                    .canonicalize()
                    .unwrap()
            );
            let resolved_engine = auth
                .resolve(&engine_handle.id, PathOperation::EngineExecute, &[])
                .unwrap();
            assert_eq!(
                resolved_engine.target().unwrap().to_path_buf(),
                visible_engines
                    .join("stockfish-legacy1234/stockfish")
                    .canonicalize()
                    .unwrap()
            );

            for kind in FolderSwitchKind::ALL {
                let status = auth.folder_status_for_kind(kind, &lookups).unwrap();
                assert!(status.is_default, "{kind:?} must report is_default=true");
            }
        })
        .unwrap();
}

#[tokio::test]
async fn legacy_default_migration_empty_legacy_switches_and_removes_dir() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&app_data).unwrap();
    let (home_fn, app_fn) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&home_fn, &app_fn);
    let default_dirs = make_test_default_dir_source(&home, &app_data);

    let legacy_db_dir = app_data.join("db");
    fs::create_dir_all(&legacy_db_dir).unwrap();

    let authority = open_test_authority(&tmp);
    authority
        .with_mut(|auth| {
            let root = auth
                .get_or_create_database_root(
                    &legacy_db_dir,
                    "db",
                    Some(VerifiedIdentity::from_pair(dir_identity(&legacy_db_dir))),
                )
                .unwrap();
            auth.set_active_database_root(&root).unwrap();
        })
        .unwrap();

    let candidates = authority
        .with_mut(|auth| auth.plan_legacy_default_migrations(&lookups))
        .unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].kind, FolderSwitchKind::Database);

    let state = make_migration_app_state(authority.clone());
    let pending = state.folder_switch.raise_migration_gates(candidates);

    crate::workspace_commands::run_legacy_default_migrations(state.clone(), default_dirs, pending)
        .await;

    assert!(!state
        .folder_switch
        .is_migration_gated(FolderSwitchKind::Database));
    assert!(
        !legacy_db_dir.exists(),
        "empty legacy default directory must be removed"
    );
    let visible_db = home.join("ChessRiddle Studio/Databases");
    assert!(visible_db.is_dir());
    authority
        .with_mut(|auth| {
            let status = auth.database_folder_status(&lookups).unwrap();
            assert!(status.is_default);
            assert_eq!(status.display_name, "Databases");
        })
        .unwrap();
}

#[test]
fn legacy_default_migration_leaves_custom_root_untouched() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let custom_dir = tmp.path().join("my-custom-dbs");
    let legacy_db_dir = app_data.join("db");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&legacy_db_dir).unwrap();
    fs::create_dir_all(&custom_dir).unwrap();
    create_initialized_sqlite_db(&custom_dir.join("custom.db3"));
    let (home_fn, app_fn) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&home_fn, &app_fn);

    let authority = open_test_authority(&tmp);
    authority
        .with_mut(|auth| {
            let root = auth
                .get_or_create_database_root(&custom_dir, "my-custom-dbs", None)
                .unwrap();
            auth.set_active_database_root(&root).unwrap();
        })
        .unwrap();

    let candidates = authority
        .with_mut(|auth| auth.plan_legacy_default_migrations(&lookups))
        .unwrap();
    assert!(candidates.is_empty(), "custom root must never be migrated");
    assert!(custom_dir.join("custom.db3").exists());
    assert!(legacy_db_dir.exists());
    assert!(!home.join("ChessRiddle Studio").exists());
}

#[tokio::test]
async fn legacy_default_migration_skips_when_resolver_falls_back_to_legacy() {
    let tmp = TempDir::new().unwrap();
    let app_data = tmp.path().join("app");
    let legacy_db_dir = app_data.join("db");
    fs::create_dir_all(&legacy_db_dir).unwrap();
    create_initialized_sqlite_db(&legacy_db_dir.join("keep.db3"));

    let authority = open_test_authority(&tmp);
    let legacy_root_id = authority
        .with_mut(|auth| {
            let root = auth
                .get_or_create_database_root(
                    &legacy_db_dir,
                    "db",
                    Some(VerifiedIdentity::from_pair(dir_identity(&legacy_db_dir))),
                )
                .unwrap();
            auth.set_active_database_root(&root).unwrap();
            root.path_ref().clone()
        })
        .unwrap();

    // Case 1: unresolvable home -> plan_legacy_default_migrations skips it.
    let failing_home = || -> Result<HomeDir, Error> {
        Err(Error::Io(Box::new(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "home unavailable",
        ))))
    };
    let app_path = app_data.clone();
    let app_fn = move || Ok(AppDataDir::for_test(&app_path));
    let lookups = DefaultDirLookups::new(&failing_home, &app_fn);
    let candidates = authority
        .with_mut(|auth| auth.plan_legacy_default_migrations(&lookups))
        .unwrap();
    assert!(
        candidates.is_empty(),
        "resolver falling back to legacy must skip planning"
    );

    // Case 2: even if a candidate reaches execution when home becomes unusable,
    // resolve_visible_default_dir falls back to legacy (target_identity == source_identity)
    // and leaves legacy active, untouched, and not removed.
    let state = make_migration_app_state(authority.clone());
    let candidate = LegacyMigrationCandidate {
        kind: FolderSwitchKind::Database,
        source_root: legacy_root_id.clone(),
        source_path: legacy_db_dir.clone(),
        source_identity: dir_identity(&legacy_db_dir),
        engine_descendants: HashSet::new(),
    };
    let guard = state
        .folder_switch
        .raise_migration_gate(FolderSwitchKind::Database, HashSet::new());
    let app_path2 = app_data.clone();
    let failing_default_dirs: DefaultDirSource<tauri::test::MockRuntime> =
        DefaultDirSource::Custom {
            home: Arc::new(|| {
                Err(Error::Io(Box::new(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "home unavailable",
                ))))
            }),
            app_data: Arc::new(move || Ok(AppDataDir::for_test(&app_path2))),
        };
    crate::workspace_commands::run_legacy_default_migrations(
        state.clone(),
        failing_default_dirs,
        vec![(candidate, guard)],
    )
    .await;

    assert!(!state
        .folder_switch
        .is_migration_gated(FolderSwitchKind::Database));
    assert!(legacy_db_dir.join("keep.db3").exists());
    authority
        .with_mut(|auth| {
            assert_eq!(
                auth.active_root_id_for_kind(FolderSwitchKind::Database),
                Some(legacy_root_id)
            );
        })
        .unwrap();
}

#[tokio::test]
async fn legacy_default_migration_failure_keeps_legacy_active_releases_gate_and_retries() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let legacy_db_dir = app_data.join("db");
    let visible_db_dir = home.join("ChessRiddle Studio/Databases");
    fs::create_dir_all(&legacy_db_dir).unwrap();
    fs::create_dir_all(&visible_db_dir).unwrap();
    create_initialized_sqlite_db(&legacy_db_dir.join("collide.db3"));
    // Pre-create colliding file in destination to trigger preflight NameCollision refusal.
    fs::write(visible_db_dir.join("collide.db3"), b"foreign").unwrap();

    let (home_fn, app_fn) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&home_fn, &app_fn);
    let default_dirs = make_test_default_dir_source(&home, &app_data);

    let authority = open_test_authority(&tmp);
    let legacy_root_id = authority
        .with_mut(|auth| {
            let root = auth
                .get_or_create_database_root(
                    &legacy_db_dir,
                    "db",
                    Some(VerifiedIdentity::from_pair(dir_identity(&legacy_db_dir))),
                )
                .unwrap();
            auth.set_active_database_root(&root).unwrap();
            root.path_ref().clone()
        })
        .unwrap();

    let state = make_migration_app_state(authority.clone());
    let candidates = authority
        .with_mut(|auth| auth.plan_legacy_default_migrations(&lookups))
        .unwrap();
    assert_eq!(candidates.len(), 1);
    let pending = state.folder_switch.raise_migration_gates(candidates);

    crate::workspace_commands::run_legacy_default_migrations(
        state.clone(),
        default_dirs.clone(),
        pending,
    )
    .await;

    // Failure leaves legacy root active, intact, and releases the gate.
    assert!(!state
        .folder_switch
        .is_migration_gated(FolderSwitchKind::Database));
    assert!(legacy_db_dir.join("collide.db3").exists());
    authority
        .with_mut(|auth| {
            assert_eq!(
                auth.active_root_id_for_kind(FolderSwitchKind::Database),
                Some(legacy_root_id.clone())
            );
        })
        .unwrap();

    // Clear the collision and simulate next start: migration retries and succeeds!
    fs::remove_file(visible_db_dir.join("collide.db3")).unwrap();
    let retry_candidates = authority
        .with_mut(|auth| auth.plan_legacy_default_migrations(&lookups))
        .unwrap();
    assert_eq!(retry_candidates.len(), 1);
    let retry_pending = state.folder_switch.raise_migration_gates(retry_candidates);
    crate::workspace_commands::run_legacy_default_migrations(
        state.clone(),
        default_dirs,
        retry_pending,
    )
    .await;

    assert!(!state
        .folder_switch
        .is_migration_gated(FolderSwitchKind::Database));
    assert!(visible_db_dir.join("collide.db3").exists());
    assert!(!legacy_db_dir.exists());

    // Panic backstop: dropping MigrationGateGuard during unwind releases the gate.
    let coord = FolderSwitchCoordinator::default();
    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = coord.raise_migration_gate(FolderSwitchKind::Puzzle, HashSet::new());
        assert!(coord.is_migration_gated(FolderSwitchKind::Puzzle));
        panic!("simulated migration task panic");
    }));
    assert!(caught.is_err());
    assert!(!coord.is_migration_gated(FolderSwitchKind::Puzzle));
}

#[tokio::test]
async fn legacy_default_migration_gate_waits_for_commands_and_engine_admissions() {
    use crate::engine::EngineKey;
    use std::time::Duration;
    use tauri::Manager;

    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let legacy_db_dir = app_data.join("db");
    let legacy_puzzle_dir = app_data.join("puzzles");
    let legacy_engine_dir = app_data.join("engines");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&legacy_db_dir).unwrap();
    fs::create_dir_all(&legacy_puzzle_dir).unwrap();
    fs::create_dir_all(&legacy_engine_dir).unwrap();
    let (home_fn, app_fn) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&home_fn, &app_fn);

    let authority = open_test_authority(&tmp);
    let (db_root, db_handle, puzzle_handle, legacy_exec, legacy_res) = authority
        .with_mut(|auth| {
            let db_root = auth
                .get_or_create_database_root(
                    &legacy_db_dir,
                    "db",
                    Some(VerifiedIdentity::from_pair(dir_identity(&legacy_db_dir))),
                )
                .unwrap();
            auth.set_active_database_root(&db_root).unwrap();
            create_initialized_sqlite_db(&legacy_db_dir.join("gated.db3"));
            let db_listing = auth
                .list_database_children_cancellable(&db_root, &CancellationToken::new())
                .unwrap();
            let db_handle = db_listing.entries[0].handle.clone();

            let puzzle_root = auth
                .get_or_create_puzzle_root(
                    &legacy_puzzle_dir,
                    "puzzles",
                    Some(VerifiedIdentity::from_pair(dir_identity(
                        &legacy_puzzle_dir,
                    ))),
                )
                .unwrap();
            auth.set_active_puzzle_root(&puzzle_root).unwrap();
            create_initialized_sqlite_db(&legacy_puzzle_dir.join("gated-puzzles.db3"));
            let puzzle_listing = auth
                .list_puzzle_children_cancellable(&puzzle_root, &CancellationToken::new())
                .unwrap();
            let puzzle_handle = puzzle_listing[0].file.clone();

            let engine_root = auth
                .get_or_create_engine_root(
                    &legacy_engine_dir,
                    "engines",
                    Some(VerifiedIdentity::from_pair(dir_identity(
                        &legacy_engine_dir,
                    ))),
                )
                .unwrap();
            auth.set_active_engine_root(&engine_root).unwrap();
            let root_path = auth.engine_root_path(&engine_root).unwrap();
            let stage = tempfile::tempdir_in(&root_path).unwrap();
            fs::write(stage.path().join("stockfish"), b"#!/bin/sh\necho uciok\n").unwrap();
            fs::write(stage.path().join("weights.nnue"), b"weights").unwrap();
            let mut owner = OwnedStagingDir::adopt(&stage).unwrap();
            let _kept = stage.keep();
            let resolved_install = auth
                .resolve(
                    engine_root.path_ref(),
                    PathOperation::DownloadArchive,
                    &[OsString::from("sf-gated")],
                )
                .unwrap();
            auth.publish_catalog_install(engine_root.path_ref(), &resolved_install, &mut owner)
                .unwrap();
            let engine_handle = auth
                .register_installed_engine_for_test(&engine_root, "sf-gated/stockfish")
                .unwrap();
            let res_grant = auth
                .grant_dialog(
                    &legacy_engine_dir.join("sf-gated/weights.nnue"),
                    "weights.nnue",
                    PathClass::SingleDialogGrant,
                    PathOperation::EngineResourceRead,
                    PICKER_DIALOG_GRANT_TTL,
                    1,
                )
                .unwrap();
            let res_handle = auth
                .promote_engine_resource(&res_grant, EngineResourceHandleKind::File, "weights.nnue")
                .unwrap();
            (
                db_root,
                db_handle,
                puzzle_handle,
                engine_handle.id,
                res_handle.path_ref().clone(),
            )
        })
        .unwrap();

    // Feed gates directly from `plan_legacy_default_migrations` (never hand-built) and use
    // `AppState::default()` so the real `AppState -> EngineSupervisor` coordinator wiring is tested.
    let candidates = authority
        .with_mut(|auth| auth.plan_legacy_default_migrations(&lookups))
        .unwrap();
    assert_eq!(candidates.len(), 3);

    let state = make_migration_app_state(authority.clone());
    let app = tauri::test::mock_app();
    app.manage(state.clone());

    // Pre-prepare one search reservation BEFORE raising the Engine gate so we can test
    // `consume_engine_search` waiting on the gate as well.
    let consume_key = EngineKey::new("tab-consume".into(), "eng-consume".into()).unwrap();
    let prepared_gen = state
        .engine_supervisor
        .prepare_engine_search(
            consume_key.clone(),
            "eng-consume".into(),
            legacy_exec.clone(),
        )
        .await
        .unwrap();

    let mut guards_by_kind = BTreeMap::new();
    for (candidate, guard) in state.folder_switch.raise_migration_gates(candidates) {
        guards_by_kind.insert(candidate.kind, guard);
    }

    // 1. Real Database commands (`get_db_info`, `create_workspace_database`) wait on Database gate.
    let app_db_info = app.handle().clone();
    let db_handle_clone = db_handle.clone();
    let db_info_waiter = tokio::spawn(async move {
        crate::db::get_db_info(
            db_handle_clone,
            app_db_info.clone(),
            app_db_info.state::<crate::AppState>(),
        )
        .await
    });
    let app_create_db = app.handle().clone();
    let db_root_clone = db_root.clone();
    let create_db_waiter = tokio::spawn(async move {
        crate::workspace_commands::create_workspace_database(
            db_root_clone,
            "created-after-gate.db3".into(),
            app_create_db.state::<crate::AppState>(),
        )
        .await
    });

    // 2. Real Puzzle file command (`delete_puzzle_database`) waits on Puzzle gate.
    let app_del_puzzle = app.handle().clone();
    let puzzle_handle_clone = puzzle_handle.clone();
    let delete_puzzle_waiter = tokio::spawn(async move {
        crate::puzzle::delete_puzzle_database(
            puzzle_handle_clone,
            app_del_puzzle.state::<crate::AppState>(),
        )
        .await
    });

    // 3. Real startup reconciliation (`reconcile_startup_path_owners_core`) waits on Engine gate.
    let state_reconcile = state.clone();
    let reconcile_waiter = tokio::spawn(async move {
        crate::reconcile_startup_path_owners_core(
            StartupPathOwners {
                retained_ids: Vec::new(),
                trusted_families: Vec::new(),
            },
            &state_reconcile,
        )
        .await
    });

    // 4. Engine supervisor admissions (search prepare, search consume, launch/config/game,
    //    analysis operation, and external engine with legacy resource) wait on Engine gate.
    let external_exec = PathRef {
        id: "external-engine-exec".into(),
    };
    let ext_key = EngineKey::new("tab-ext".into(), "ext-1".into()).unwrap();
    let _ext_lease = state
        .engine_supervisor
        .admit_for_launch(ext_key, "ext-1".into(), external_exec.clone())
        .await
        .unwrap();

    let sup_search = Arc::clone(&state.engine_supervisor);
    let exec_search = legacy_exec.clone();
    let search_waiter = tokio::spawn(async move {
        let key = EngineKey::new("tab-1".into(), "eng-1".into()).unwrap();
        sup_search
            .prepare_engine_search(key, "eng-1".into(), exec_search)
            .await
    });

    let sup_consume = Arc::clone(&state.engine_supervisor);
    let exec_consume = legacy_exec.clone();
    let consume_waiter = tokio::spawn(async move {
        sup_consume
            .consume_engine_search(
                consume_key,
                "eng-consume".into(),
                exec_consume,
                &prepared_gen,
            )
            .await
            .map(|_| ())
    });

    let sup_launch = Arc::clone(&state.engine_supervisor);
    let exec_launch = legacy_exec.clone();
    let launch_waiter = tokio::spawn(async move {
        let key = EngineKey::new("engine-config".into(), "probe-1".into()).unwrap();
        sup_launch
            .admit_for_launch(key, "probe-1".into(), exec_launch)
            .await
            .map(|_| ())
    });

    let sup_op = Arc::clone(&state.engine_supervisor);
    let exec_op = legacy_exec.clone();
    let op_waiter = tokio::spawn(async move {
        let key = EngineKey::new("analysis".into(), "eng-2".into()).unwrap();
        sup_op
            .admit_for_operation(key, "eng-2".into(), exec_op, CancellationToken::new())
            .await
            .map(|_| ())
    });

    // External engine executable carrying an EngineOption::Resource inside the legacy engine root.
    let sup_res = Arc::clone(&state.engine_supervisor);
    let ext_for_res = external_exec.clone();
    let legacy_res_clone = legacy_res.clone();
    let resource_waiter = tokio::spawn(async move {
        let key = EngineKey::new("tab-res".into(), "ext-res".into()).unwrap();
        sup_res
            .admit_for_launch_with_resources(
                key,
                "ext-res".into(),
                ext_for_res,
                &[legacy_res_clone],
            )
            .await
            .map(|_| ())
    });

    // Parked admission must be visible to `terminate_tab` while waiting on the gate (P4-03).
    let sup_tab_cancel = Arc::clone(&state.engine_supervisor);
    let exec_tab_cancel = legacy_exec.clone();
    let tab_cancel_waiter = tokio::spawn(async move {
        let key = EngineKey::new("tab-close-me".into(), "eng-close".into()).unwrap();
        sup_tab_cancel
            .prepare_engine_search(key, "eng-close".into(), exec_tab_cancel)
            .await
    });

    tokio::time::sleep(Duration::from_millis(40)).await;
    assert!(
        !db_info_waiter.is_finished(),
        "get_db_info must wait on Database gate"
    );
    assert!(
        !create_db_waiter.is_finished(),
        "create_workspace_database must wait on Database gate"
    );
    assert!(
        !delete_puzzle_waiter.is_finished(),
        "delete_puzzle_database must wait on Puzzle gate"
    );
    assert!(
        !reconcile_waiter.is_finished(),
        "reconcile_startup_path_owners_core must wait on Engine gate"
    );
    assert!(
        !search_waiter.is_finished(),
        "prepare_engine_search must wait on Engine gate"
    );
    assert!(
        !consume_waiter.is_finished(),
        "consume_engine_search must wait on Engine gate"
    );
    assert!(
        !launch_waiter.is_finished(),
        "admit_for_launch must wait on Engine gate"
    );
    assert!(
        !op_waiter.is_finished(),
        "admit_for_operation must wait on Engine gate"
    );
    assert!(
        !resource_waiter.is_finished(),
        "external engine with legacy resource must wait on Engine gate"
    );
    assert!(
        !tab_cancel_waiter.is_finished(),
        "parked prepare_engine_search must wait on Engine gate before terminate_tab"
    );

    // Tab close cancels the parked admission immediately without waiting for gate release.
    state
        .engine_supervisor
        .terminate_tab("tab-close-me")
        .await
        .unwrap();
    assert!(
        matches!(tab_cancel_waiter.await.unwrap(), Err(Error::Cancellation)),
        "terminate_tab must cancel a parked admission immediately"
    );

    // Bounded timeout returns SwitchInProgress; explicit cancellation returns Cancellation.
    let timed_out = state
        .folder_switch
        .wait_for_migration_with_timeout(
            FolderSwitchKind::Database,
            None,
            Duration::from_millis(20),
        )
        .await;
    assert_eq!(
        timed_out.err().and_then(|e| e.folder_switch_failure()),
        Some(FolderSwitchFailure::SwitchInProgress)
    );
    let cancel_token = CancellationToken::new();
    let cancel_clone = cancel_token.clone();
    let cancel_coord = state.folder_switch.clone();
    let cancel_waiter = tokio::spawn(async move {
        cancel_coord
            .wait_for_migration(FolderSwitchKind::Database, Some(&cancel_clone))
            .await
    });
    tokio::time::sleep(Duration::from_millis(15)).await;
    cancel_token.cancel();
    assert!(matches!(
        cancel_waiter.await.unwrap(),
        Err(Error::Cancellation)
    ));

    // Release all three gates -> every parked real command and engine admission completes cleanly.
    guards_by_kind
        .remove(&FolderSwitchKind::Database)
        .unwrap()
        .release();
    guards_by_kind
        .remove(&FolderSwitchKind::Puzzle)
        .unwrap()
        .release();
    guards_by_kind
        .remove(&FolderSwitchKind::Engine)
        .unwrap()
        .release();

    db_info_waiter.await.unwrap().unwrap();
    create_db_waiter.await.unwrap().unwrap();
    delete_puzzle_waiter.await.unwrap().unwrap();
    reconcile_waiter.await.unwrap().unwrap();
    search_waiter.await.unwrap().unwrap();
    consume_waiter.await.unwrap().unwrap();
    launch_waiter.await.unwrap().unwrap();
    op_waiter.await.unwrap().unwrap();
    resource_waiter.await.unwrap().unwrap();

    // Shutdown (`terminate_all`) also cancels a parked admission immediately while gated (P4-03).
    let mut desc = HashSet::new();
    desc.insert(legacy_exec.clone());
    let _shutdown_gate = state
        .folder_switch
        .raise_migration_gate(FolderSwitchKind::Engine, desc);
    let sup_shutdown = Arc::clone(&state.engine_supervisor);
    let exec_shutdown = legacy_exec.clone();
    let shutdown_admit_waiter = tokio::spawn(async move {
        let key = EngineKey::new("tab-shutdown".into(), "eng-shutdown".into()).unwrap();
        sup_shutdown
            .admit_for_launch(key, "eng-shutdown".into(), exec_shutdown)
            .await
            .map(|_| ())
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!shutdown_admit_waiter.is_finished());
    state.engine_supervisor.terminate_all().await.unwrap();
    assert!(
        matches!(
            shutdown_admit_waiter.await.unwrap(),
            Err(Error::Cancellation) | Err(Error::Conflict(_))
        ),
        "terminate_all must cancel a parked admission immediately"
    );
}

#[tokio::test]
async fn legacy_default_migration_shutdown_cancels_waiters_and_remaining_kinds() {
    use std::time::Duration;

    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let legacy_db_dir = app_data.join("db");
    let legacy_puzzle_dir = app_data.join("puzzles");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&legacy_db_dir).unwrap();
    fs::create_dir_all(&legacy_puzzle_dir).unwrap();
    create_initialized_sqlite_db(&legacy_db_dir.join("alpha.db3"));
    create_initialized_sqlite_db(&legacy_db_dir.join("beta.db3"));
    create_initialized_sqlite_db(&legacy_puzzle_dir.join("puz.db3"));

    let (home_fn, app_fn) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&home_fn, &app_fn);
    let default_dirs = make_test_default_dir_source(&home, &app_data);
    let authority = open_test_authority(&tmp);
    authority
        .with_mut(|auth| {
            let db_root = auth
                .get_or_create_database_root(
                    &legacy_db_dir,
                    "db",
                    Some(VerifiedIdentity::from_pair(dir_identity(&legacy_db_dir))),
                )
                .unwrap();
            auth.set_active_database_root(&db_root).unwrap();
            let puzzle_root = auth
                .get_or_create_puzzle_root(
                    &legacy_puzzle_dir,
                    "puzzles",
                    Some(VerifiedIdentity::from_pair(dir_identity(
                        &legacy_puzzle_dir,
                    ))),
                )
                .unwrap();
            auth.set_active_puzzle_root(&puzzle_root).unwrap();
        })
        .unwrap();

    // 1. A waiter blocked on `wait_for_migration` is released with `Error::Cancellation`
    //    when `shutdown_migrations` cancels the coordinator.
    let shutdown_coord = FolderSwitchCoordinator::default();
    let _held_guard =
        shutdown_coord.raise_migration_gate(FolderSwitchKind::Database, HashSet::new());
    let waiter_coord = shutdown_coord.clone();
    let blocked_waiter = tokio::spawn(async move {
        waiter_coord
            .wait_for_migration(FolderSwitchKind::Database, None)
            .await
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!blocked_waiter.is_finished());
    shutdown_coord
        .shutdown_migrations(Duration::from_secs(1))
        .await;
    assert!(
        matches!(blocked_waiter.await.unwrap(), Err(Error::Cancellation)),
        "shutdown_migrations must unblock gate waiters with Error::Cancellation"
    );

    // 2. Multi-kind `run_legacy_default_migrations` cancelled mid-transfer on the first kind
    //    (Database) skips remaining kinds (Puzzle) and releases every kind's gate cleanly.
    let state = make_migration_app_state(authority.clone());
    let candidates = authority
        .with_mut(|auth| auth.plan_legacy_default_migrations(&lookups))
        .unwrap();
    assert_eq!(candidates.len(), 2);
    let pending = state.folder_switch.raise_migration_gates(candidates);
    {
        let _arm = arm_cancel_after_first_transfer(
            dir_identity(&legacy_db_dir),
            state.folder_switch.migration_cancellation(),
        );
        let task_state = state.clone();
        let handle = tauri::async_runtime::spawn(async move {
            crate::workspace_commands::run_legacy_default_migrations(
                task_state,
                default_dirs,
                pending,
            )
            .await;
        });
        state.folder_switch.set_migration_task(handle);
        // Wait until cancellation fires on Database, then drive `shutdown_migrations`.
        state
            .folder_switch
            .migration_cancellation()
            .cancelled()
            .await;
        state
            .folder_switch
            .shutdown_migrations(Duration::from_secs(5))
            .await;
    }

    assert!(!state
        .folder_switch
        .is_migration_gated(FolderSwitchKind::Database));
    assert!(!state
        .folder_switch
        .is_migration_gated(FolderSwitchKind::Puzzle));
    // Puzzle (the second kind) was skipped due to cancellation and remains untouched in legacy dir.
    assert!(legacy_puzzle_dir.join("puz.db3").exists());
    assert!(!home.join("ChessRiddle Studio/Puzzles/puz.db3").exists());
}

#[tokio::test]
async fn legacy_default_migration_quit_mid_transfer_recovers_next_start_via_journal() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let legacy_db_dir = app_data.join("db");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&legacy_db_dir).unwrap();
    create_initialized_sqlite_db(&legacy_db_dir.join("alpha.db3"));
    create_initialized_sqlite_db(&legacy_db_dir.join("beta.db3"));

    let (home_fn, app_fn) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&home_fn, &app_fn);
    let default_dirs = make_test_default_dir_source(&home, &app_data);
    let registry_path = tmp.path().join("registry.json");

    let authority =
        SharedPathAuthority::installed(PathAuthority::open(registry_path.clone(), vec![]).unwrap());
    authority
        .with_mut(|auth| {
            let root = auth
                .get_or_create_database_root(
                    &legacy_db_dir,
                    "db",
                    Some(VerifiedIdentity::from_pair(dir_identity(&legacy_db_dir))),
                )
                .unwrap();
            auth.set_active_database_root(&root).unwrap();
        })
        .unwrap();

    // Quit/cancel right after transferring the first item: journal remains on disk,
    // active root is still legacy, and the gate is released.
    let state = make_migration_app_state(authority.clone());
    let candidates = authority
        .with_mut(|auth| auth.plan_legacy_default_migrations(&lookups))
        .unwrap();
    assert_eq!(candidates.len(), 1);
    let pending = state.folder_switch.raise_migration_gates(candidates);
    {
        let _arm = arm_cancel_after_first_transfer(
            dir_identity(&legacy_db_dir),
            state.folder_switch.migration_cancellation(),
        );
        crate::workspace_commands::run_legacy_default_migrations(
            state.clone(),
            default_dirs.clone(),
            pending,
        )
        .await;
    }

    assert!(!state
        .folder_switch
        .is_migration_gated(FolderSwitchKind::Database));
    let journal_path = authority
        .with_mut(|auth| auth.journal_path(FolderSwitchKind::Database))
        .unwrap();
    assert!(
        journal_path.exists(),
        "quit mid-transfer must leave durable journal on disk for next-start recovery"
    );

    // Next start: open registry, run F's journal recovery -> rolls alpha.db3 back to legacy
    // and removes the journal.
    let mut reopened = PathAuthority::open(registry_path.clone(), vec![]).unwrap();
    reopened.recover_folder_switch_journals(&lookups);
    assert!(
        !journal_path.exists(),
        "next-start recovery must settle and remove the journal"
    );
    assert!(legacy_db_dir.join("alpha.db3").exists());
    assert!(legacy_db_dir.join("beta.db3").exists());
    assert!(!home.join("ChessRiddle Studio/Databases/alpha.db3").exists());

    // Then next start's migration retries and completes cleanly.
    let retry_candidates = reopened.plan_legacy_default_migrations(&lookups);
    assert_eq!(retry_candidates.len(), 1);
    let reopened_shared = SharedPathAuthority::installed(reopened);
    let retry_state = make_migration_app_state(reopened_shared.clone());
    let retry_pending = retry_state
        .folder_switch
        .raise_migration_gates(retry_candidates);
    crate::workspace_commands::run_legacy_default_migrations(
        retry_state,
        default_dirs,
        retry_pending,
    )
    .await;

    assert!(home.join("ChessRiddle Studio/Databases/alpha.db3").exists());
    assert!(home.join("ChessRiddle Studio/Databases/beta.db3").exists());
    assert!(!legacy_db_dir.exists());
}

#[test]
fn legacy_default_migration_skips_kind_with_unresolved_journal() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let legacy_db_dir = app_data.join("db");
    let legacy_puzzle_dir = app_data.join("puzzles");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&legacy_db_dir).unwrap();
    fs::create_dir_all(&legacy_puzzle_dir).unwrap();
    let (home_fn, app_fn) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&home_fn, &app_fn);

    let mut auth = PathAuthority::open(tmp.path().join("registry.json"), vec![]).unwrap();
    let db_root = auth
        .get_or_create_database_root(
            &legacy_db_dir,
            "db",
            Some(VerifiedIdentity::from_pair(dir_identity(&legacy_db_dir))),
        )
        .unwrap();
    auth.set_active_database_root(&db_root).unwrap();
    let puzzle_root = auth
        .get_or_create_puzzle_root(
            &legacy_puzzle_dir,
            "puzzles",
            Some(VerifiedIdentity::from_pair(dir_identity(
                &legacy_puzzle_dir,
            ))),
        )
        .unwrap();
    auth.set_active_puzzle_root(&puzzle_root).unwrap();

    // Write a corrupt journal for Database so startup recovery marks Database unresolved.
    fs::write(auth.journal_path(FolderSwitchKind::Database), b"{corrupt").unwrap();
    auth.recover_folder_switch_journals(&lookups);
    assert!(auth.has_unresolved_journal(FolderSwitchKind::Database));

    let candidates = auth.plan_legacy_default_migrations(&lookups);
    let kinds: Vec<_> = candidates.iter().map(|c| c.kind).collect();
    assert_eq!(
        kinds,
        vec![FolderSwitchKind::Puzzle],
        "Database has an unresolved journal and must not be migrated; Puzzle must still be planned"
    );
}

#[tokio::test]
async fn ticketed_read_parked_on_migration_gate_cancels_via_ticket_not_migration_reads() {
    use std::time::Duration;

    let state = crate::AppState::default();
    let gate = state
        .folder_switch
        .raise_migration_gate(FolderSwitchKind::Database, HashSet::new());

    // 1. A ticketed read parked on the Database gate is NOT cancelled by `cancel_active_reads()`
    //    (used by `execute_quiesced_folder_move`), but IS cancelled immediately by the renderer's
    //    `cancel_read(ticket)` (P4-15).
    let ticket_cancel = state.operations.prepare_read("main").unwrap();
    let state_cancel = state.clone();
    let ticket_cancel_clone = ticket_cancel.clone();
    let cancelled_waiter = tokio::spawn(async move {
        crate::wait_for_read_migration(
            &state_cancel,
            FolderSwitchKind::Database,
            Some(&ticket_cancel_clone),
            "main",
        )
        .await
    });

    // 2. A second ticketed read survives `cancel_active_reads()`, wakes when the gate releases,
    //    and then claims its ticket cleanly.
    let ticket_survive = state.operations.prepare_read("main").unwrap();
    let state_survive = state.clone();
    let ticket_survive_clone = ticket_survive.clone();
    let surviving_waiter = tokio::spawn(async move {
        crate::wait_for_read_migration(
            &state_survive,
            FolderSwitchKind::Database,
            Some(&ticket_survive_clone),
            "main",
        )
        .await?;
        state_survive
            .operations
            .claim_read(&ticket_survive_clone, "main", "list_workspace_databases")
            .map(|_| ())
    });

    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(!cancelled_waiter.is_finished());
    assert!(!surviving_waiter.is_finished());

    // Migration's `cancel_active_reads()` must NOT cancel either parked ticketed read.
    state.operations.cancel_active_reads();
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(
        !cancelled_waiter.is_finished(),
        "migration cancel_active_reads must not cancel a read parked on the gate"
    );
    assert!(
        !surviving_waiter.is_finished(),
        "migration cancel_active_reads must not cancel a read parked on the gate"
    );

    // Renderer `cancel_read(ticket)` cancels only its parked read immediately.
    state
        .operations
        .cancel_read(&ticket_cancel, "main")
        .unwrap();
    assert!(
        matches!(cancelled_waiter.await.unwrap(), Err(Error::Cancellation)),
        "renderer cancel_read(ticket) must immediately cancel a parked read wait"
    );
    assert!(
        !surviving_waiter.is_finished(),
        "cancelling another ticket must not disturb unrelated parked reads"
    );

    gate.release();
    surviving_waiter.await.unwrap().unwrap();
}

#[tokio::test]
async fn real_engine_migration_lets_parked_admission_wait_through_quiesce_and_succeed() {
    use crate::engine::EngineKey;
    use std::time::Duration;

    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let legacy_engine_dir = app_data.join("engines");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&legacy_engine_dir).unwrap();
    let (home_fn, app_fn) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&home_fn, &app_fn);
    let default_dirs = make_test_default_dir_source(&home, &app_data);

    let authority = open_test_authority(&tmp);
    let engine_handle = authority
        .with_mut(|auth| {
            let engine_root = auth
                .get_or_create_engine_root(
                    &legacy_engine_dir,
                    "engines",
                    Some(VerifiedIdentity::from_pair(dir_identity(
                        &legacy_engine_dir,
                    ))),
                )
                .unwrap();
            auth.set_active_engine_root(&engine_root).unwrap();
            let root_path = auth.engine_root_path(&engine_root).unwrap();
            let stage = tempfile::tempdir_in(&root_path).unwrap();
            fs::write(stage.path().join("stockfish"), b"#!/bin/sh\necho uciok\n").unwrap();
            let mut owner = OwnedStagingDir::adopt(&stage).unwrap();
            let _kept = stage.keep();
            let resolved_install = auth
                .resolve(
                    engine_root.path_ref(),
                    PathOperation::DownloadArchive,
                    &[OsString::from("sf-real-mig")],
                )
                .unwrap();
            auth.publish_catalog_install(engine_root.path_ref(), &resolved_install, &mut owner)
                .unwrap();
            auth.register_installed_engine_for_test(&engine_root, "sf-real-mig/stockfish")
                .unwrap()
        })
        .unwrap();

    let candidates = authority
        .with_mut(|auth| auth.plan_legacy_default_migrations(&lookups))
        .unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].kind, FolderSwitchKind::Engine);

    let state = make_migration_app_state(authority.clone());
    let pending = state.folder_switch.raise_migration_gates(candidates);

    // Park a real `prepare_engine_search` AND `admit_for_launch` while the Engine gate is held,
    // BEFORE running the real `run_legacy_default_migrations` (which calls `quiesce_executables`).
    let sup_search = Arc::clone(&state.engine_supervisor);
    let exec_search = engine_handle.id.clone();
    let search_waiter = tokio::spawn(async move {
        let key = EngineKey::new("tab-mig".into(), "eng-mig".into()).unwrap();
        sup_search
            .prepare_engine_search(key, "eng-mig".into(), exec_search)
            .await
    });
    let sup_launch = Arc::clone(&state.engine_supervisor);
    let exec_launch = engine_handle.id.clone();
    let launch_waiter = tokio::spawn(async move {
        let key = EngineKey::new("engine-config".into(), "probe-mig".into()).unwrap();
        sup_launch
            .admit_for_launch(key, "probe-mig".into(), exec_launch)
            .await
            .map(|_| ())
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!search_waiter.is_finished());
    assert!(!launch_waiter.is_finished());

    // Run real Engine migration -> `quiesce_executables` must NOT cancel the parked admissions
    // (P4-16), and once migration completes both succeed.
    crate::workspace_commands::run_legacy_default_migrations(state.clone(), default_dirs, pending)
        .await;

    let generation = search_waiter
        .await
        .unwrap()
        .expect("parked prepare_engine_search must survive quiesce_executables and succeed");
    launch_waiter
        .await
        .unwrap()
        .expect("parked admit_for_launch must survive quiesce_executables and succeed");

    // P4-14: After the gate has released, `waiting_on_migration` MUST be `false` on the live
    // prepared admission, so a subsequent manual `quiesce_executables` cancels it cleanly.
    let mut exec_set = HashSet::new();
    exec_set.insert(engine_handle.id.clone());
    let quiesce_guard = state
        .engine_supervisor
        .quiesce_executables(exec_set, HashSet::new())
        .await
        .unwrap();
    quiesce_guard.lift();
    let consume_res = state
        .engine_supervisor
        .consume_engine_search(
            EngineKey::new("tab-mig".into(), "eng-mig".into()).unwrap(),
            "eng-mig".into(),
            engine_handle.id.clone(),
            &generation,
        )
        .await;
    assert!(
        consume_res.is_err(),
        "subsequent quiesce_executables must cancel the live prepared admission once waiting_on_migration is cleared"
    );

    // And the migrated engine resolves inside the visible default.
    authority
        .with_mut(|auth| {
            let resolved = auth
                .resolve(&engine_handle.id, PathOperation::EngineExecute, &[])
                .unwrap();
            assert_eq!(
                resolved.target().unwrap().to_path_buf(),
                home.join("ChessRiddle Studio/Engines/sf-real-mig/stockfish")
                    .canonicalize()
                    .unwrap()
            );
        })
        .unwrap();
}

#[tokio::test]
async fn start_interactive_search_waits_for_migrating_resource_option() {
    use crate::chess::EngineOptions;
    use crate::engine::{EngineKey, EngineOption, GoMode};
    use std::time::Duration;

    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let legacy_engine_dir = app_data.join("engines");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&legacy_engine_dir).unwrap();
    let (home_fn, app_fn) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&home_fn, &app_fn);

    let authority = open_test_authority(&tmp);
    let res_handle = authority
        .with_mut(|auth| {
            let engine_root = auth
                .get_or_create_engine_root(
                    &legacy_engine_dir,
                    "engines",
                    Some(VerifiedIdentity::from_pair(dir_identity(
                        &legacy_engine_dir,
                    ))),
                )
                .unwrap();
            auth.set_active_engine_root(&engine_root).unwrap();
            let weights_path = legacy_engine_dir.join("nnue-weights.nnue");
            fs::write(&weights_path, b"weights").unwrap();
            let grant = auth
                .grant_dialog(
                    &weights_path,
                    "nnue-weights.nnue",
                    PathClass::SingleDialogGrant,
                    PathOperation::EngineResourceRead,
                    PICKER_DIALOG_GRANT_TTL,
                    1,
                )
                .unwrap();
            auth.promote_engine_resource(
                &grant,
                EngineResourceHandleKind::File,
                "nnue-weights.nnue",
            )
            .unwrap()
        })
        .unwrap();

    // Anchor `crate::engine::resource_path_refs` directly as well as through `start_interactive_search`.
    let extra_options = vec![
        EngineOption::String {
            name: "Threads".into(),
            value: "1".into(),
        },
        EngineOption::Resource {
            name: "EvalFile".into(),
            resources: vec![res_handle.clone()],
        },
    ];
    assert_eq!(
        crate::engine::resource_path_refs(&extra_options),
        vec![res_handle.path_ref().clone()],
        "resource_path_refs must extract EngineOption::Resource PathRefs"
    );

    let candidates = authority
        .with_mut(|auth| auth.plan_legacy_default_migrations(&lookups))
        .unwrap();
    assert_eq!(candidates.len(), 1);
    let state = make_migration_app_state(authority.clone());
    let mut pending = state.folder_switch.raise_migration_gates(candidates);
    let (_, engine_guard) = pending.pop().unwrap();

    // External engine executable (NOT in `engine_descendants`) prepares and consumes immediately,
    // then `start_interactive_search` must park on the Engine gate because `extra_options` carries
    // `res_handle` under the migrating legacy engine root (P4-17).
    let external_exec = PathRef {
        id: "external-interactive-exec".into(),
    };
    let key = EngineKey::new("tab-res-search".into(), "ext-search".into()).unwrap();
    let gen_id = state
        .engine_supervisor
        .prepare_engine_search(key.clone(), "ext-search".into(), external_exec.clone())
        .await
        .unwrap();
    let admission = state
        .engine_supervisor
        .consume_engine_search(
            key.clone(),
            "ext-search".into(),
            external_exec.clone(),
            &gen_id,
        )
        .await
        .unwrap();

    let supervisor = Arc::clone(&state.engine_supervisor);
    let search_authority = authority.clone();
    let search_waiter = tokio::spawn(async move {
        let options = EngineOptions {
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".into(),
            moves: Vec::new(),
            extra_options,
        };
        let handle = EngineHandle::new(external_exec);
        supervisor
            .start_interactive_search(
                key,
                handle,
                search_authority,
                admission,
                options,
                &GoMode::Depth(1),
            )
            .await
            .map(|_| ())
    });

    tokio::time::sleep(Duration::from_millis(35)).await;
    assert!(
        !search_waiter.is_finished(),
        "start_interactive_search must wait on the Engine gate for migrating EngineOption::Resource"
    );

    // Releasing the gate unblocks `start_interactive_search` immediately (it proceeds past the
    // gate and fails at `resolve_launch` for the unregistered dummy executable id).
    engine_guard.release();
    let result = tokio::time::timeout(Duration::from_secs(2), search_waiter)
        .await
        .expect("start_interactive_search must wake promptly after gate release")
        .unwrap();
    assert!(
        result.is_err(),
        "after unblocking from the gate, dummy external executable fails at resolve_launch"
    );
}

#[tokio::test]
async fn file_exists_waits_on_engine_migration_and_refuses_during_quiesce() {
    use std::time::Duration;

    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let legacy_engine_dir = app_data.join("engines");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&legacy_engine_dir).unwrap();
    let (home_fn, app_fn) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&home_fn, &app_fn);
    let default_dirs = make_test_default_dir_source(&home, &app_data);

    let authority = open_test_authority(&tmp);
    let engine_handle = authority
        .with_mut(|auth| {
            let engine_root = auth
                .get_or_create_engine_root(
                    &legacy_engine_dir,
                    "engines",
                    Some(VerifiedIdentity::from_pair(dir_identity(
                        &legacy_engine_dir,
                    ))),
                )
                .unwrap();
            auth.set_active_engine_root(&engine_root).unwrap();
            let root_path = auth.engine_root_path(&engine_root).unwrap();
            let stage = tempfile::tempdir_in(&root_path).unwrap();
            fs::write(stage.path().join("stockfish"), b"#!/bin/sh\necho uciok\n").unwrap();
            let mut owner = OwnedStagingDir::adopt(&stage).unwrap();
            let _kept = stage.keep();
            let resolved_install = auth
                .resolve(
                    engine_root.path_ref(),
                    PathOperation::DownloadArchive,
                    &[OsString::from("sf-exists")],
                )
                .unwrap();
            auth.publish_catalog_install(engine_root.path_ref(), &resolved_install, &mut owner)
                .unwrap();
            auth.register_installed_engine_for_test(&engine_root, "sf-exists/stockfish")
                .unwrap()
        })
        .unwrap();

    let candidates = authority
        .with_mut(|auth| auth.plan_legacy_default_migrations(&lookups))
        .unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].kind, FolderSwitchKind::Engine);

    let state = make_migration_app_state(authority.clone());
    let pending = state.folder_switch.raise_migration_gates(candidates);

    let app = tauri::test::mock_app();
    tauri::Manager::manage(&app, state.clone());
    let handle_for_exists = app.handle().clone();
    let ref_for_exists = engine_handle.id.clone();
    let exists_waiter = tokio::spawn(async move {
        use tauri::Manager;
        crate::fs::file_exists(ref_for_exists, handle_for_exists.state::<crate::AppState>()).await
    });
    tokio::time::sleep(Duration::from_millis(35)).await;
    assert!(
        !exists_waiter.is_finished(),
        "file_exists must park while Engine migration gate is raised"
    );

    crate::workspace_commands::run_legacy_default_migrations(state.clone(), default_dirs, pending)
        .await;
    let exists = exists_waiter
        .await
        .unwrap()
        .expect("file_exists must succeed after Engine migration");
    assert!(exists, "migrated engine binary must report existing");

    // During an interactive same-volume Move (root quiesced), even AFTER `{old_root}/{install_dir}`
    // has already been renamed away before the final registry commit (P4-23), `file_exists` must
    // fail with `Error::Conflict` rather than returning a sticky false `Ok(false)`.
    let migrated_root = home.join("ChessRiddle Studio/Engines");
    let new_root_id = dir_identity(&migrated_root);
    let _quiesce_guard = authority
        .with_mut(|auth| auth.quiesce_engine_root(new_root_id))
        .unwrap();
    let relocated_dir = tmp.path().join("relocated-sf-exists");
    fs::rename(migrated_root.join("sf-exists"), &relocated_dir).unwrap();
    let during_rename_window = crate::fs::file_exists(
        engine_handle.id.clone(),
        tauri::Manager::state::<crate::AppState>(&app),
    )
    .await;
    assert!(
        matches!(during_rename_window, Err(crate::error::Error::Conflict(_))),
        "file_exists during rename-to-commit window of a quiesced engine root must fail with Conflict (not Ok(false)), got {during_rename_window:?}"
    );
    fs::rename(&relocated_dir, migrated_root.join("sf-exists")).unwrap();
}

#[tokio::test]
async fn parked_reserved_read_does_not_expire_past_ttl_and_purge_cancels_expired_tokens() {
    use std::time::Duration;

    let tmp = TempDir::new().unwrap();
    let authority = open_test_authority(&tmp);
    let mut state = make_migration_app_state(authority);
    state.operations = crate::infra::operations::OperationRegistry::with_reservation_ttl(
        Duration::from_millis(40),
    );

    let parked_ticket = state.operations.prepare_read("main").unwrap();
    let cancel_after_ttl_ticket = state.operations.prepare_read("main").unwrap();
    let unparked_ticket = state.operations.prepare_read("main").unwrap();
    let (unparked_token, unparked_guard) = state
        .operations
        .park_reserved_for_migration(
            &unparked_ticket,
            "main",
            crate::infra::operations::ReservationKind::Read,
        )
        .unwrap()
        .expect("fresh read ticket must expose cancellation token");
    drop(unparked_guard);

    let mut gates = state
        .folder_switch
        .raise_migration_gates(vec![LegacyMigrationCandidate {
            kind: FolderSwitchKind::Database,
            source_root: PathRef {
                id: "db-ttl".into(),
            },
            source_identity: (51, 52),
            source_path: tmp.path().join("source"),
            engine_descendants: HashSet::new(),
        }]);
    let (_, gate) = gates.pop().unwrap();

    let s1 = state.clone();
    let t1 = parked_ticket.clone();
    let parked_waiter = tokio::spawn(async move {
        crate::wait_for_read_migration(&s1, FolderSwitchKind::Database, Some(&t1), "main").await
    });
    let s2 = state.clone();
    let t2 = cancel_after_ttl_ticket.clone();
    let cancel_waiter = tokio::spawn(async move {
        crate::wait_for_read_migration(&s2, FolderSwitchKind::Database, Some(&t2), "main").await
    });

    // Wait longer than the 40ms reservation TTL and trigger `purge_expired`.
    tokio::time::sleep(Duration::from_millis(80)).await;
    let _trigger_purge = state.operations.prepare_read("main").unwrap();

    assert!(
        unparked_token.is_cancelled(),
        "purge_expired must cancel any expired unparked reservation token it drops"
    );
    assert!(
        !parked_waiter.is_finished(),
        "parked read reservation must not be evicted past TTL while waiting on a migration gate"
    );
    assert!(
        !cancel_waiter.is_finished(),
        "parked read reservation must remain waiting past TTL"
    );

    // Cancelling a parked ticket after TTL has elapsed must still cancel it cleanly.
    state
        .operations
        .cancel_read(&cancel_after_ttl_ticket, "main")
        .unwrap();
    assert!(
        matches!(
            cancel_waiter.await.unwrap(),
            Err(crate::error::Error::Cancellation)
        ),
        "cancel_read must still cancel a parked ticket after TTL has elapsed"
    );

    // Releasing the gate wakes `parked_waiter` and refreshes `created_at` so `claim_read` succeeds.
    gate.release();
    parked_waiter
        .await
        .unwrap()
        .expect("parked read must wake cleanly when the migration gate releases");
    let _lease = state
        .operations
        .claim_read(&parked_ticket, "main", "after-long-migration-wait")
        .expect("claim_read must succeed after waiting longer than READ_RESERVATION_TTL");
}

#[tokio::test]
async fn engine_admission_arriving_after_quiesce_during_migration_waits_and_succeeds() {
    use crate::engine::EngineKey;
    use std::time::Duration;

    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let legacy_engine_dir = app_data.join("engines");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&legacy_engine_dir).unwrap();
    let (home_fn, app_fn) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&home_fn, &app_fn);

    let authority = open_test_authority(&tmp);
    let engine_handle = authority
        .with_mut(|auth| {
            let engine_root = auth
                .get_or_create_engine_root(
                    &legacy_engine_dir,
                    "engines",
                    Some(VerifiedIdentity::from_pair(dir_identity(
                        &legacy_engine_dir,
                    ))),
                )
                .unwrap();
            auth.set_active_engine_root(&engine_root).unwrap();
            let root_path = auth.engine_root_path(&engine_root).unwrap();
            let stage = tempfile::tempdir_in(&root_path).unwrap();
            fs::write(stage.path().join("stockfish"), b"#!/bin/sh\necho uciok\n").unwrap();
            let mut owner = OwnedStagingDir::adopt(&stage).unwrap();
            let _kept = stage.keep();
            let resolved_install = auth
                .resolve(
                    engine_root.path_ref(),
                    PathOperation::DownloadArchive,
                    &[OsString::from("sf-post-quiesce")],
                )
                .unwrap();
            auth.publish_catalog_install(engine_root.path_ref(), &resolved_install, &mut owner)
                .unwrap();
            auth.register_installed_engine_for_test(&engine_root, "sf-post-quiesce/stockfish")
                .unwrap()
        })
        .unwrap();

    let candidates = authority
        .with_mut(|auth| auth.plan_legacy_default_migrations(&lookups))
        .unwrap();
    assert_eq!(candidates.len(), 1);
    let state = make_migration_app_state(authority.clone());
    let mut pending = state.folder_switch.raise_migration_gates(candidates);
    let (_, engine_gate) = pending.pop().unwrap();

    // Populate `quiesced_executables` BEFORE the admissions arrive, while the Engine migration
    // gate is still raised (exact window during `execute_quiesced_folder_move`).
    let mut exec_set = HashSet::new();
    exec_set.insert(engine_handle.id.clone());
    let quiesce_guard = state
        .engine_supervisor
        .quiesce_executables(exec_set, HashSet::new())
        .await
        .unwrap();

    let sup_search = Arc::clone(&state.engine_supervisor);
    let exec_search = engine_handle.id.clone();
    let search_waiter = tokio::spawn(async move {
        let key = EngineKey::new("tab-post-q".into(), "eng-post-q".into()).unwrap();
        sup_search
            .prepare_engine_search(key, "eng-post-q".into(), exec_search)
            .await
    });
    let sup_launch = Arc::clone(&state.engine_supervisor);
    let exec_launch = engine_handle.id.clone();
    let launch_waiter = tokio::spawn(async move {
        let key = EngineKey::new("engine-config".into(), "probe-post-q".into()).unwrap();
        sup_launch
            .admit_for_launch(key, "probe-post-q".into(), exec_launch)
            .await
            .map(|_| ())
    });

    tokio::time::sleep(Duration::from_millis(35)).await;
    assert!(
        !search_waiter.is_finished(),
        "prepare_engine_search arriving after quiesce_executables during migration must wait, not fail with Conflict"
    );
    assert!(
        !launch_waiter.is_finished(),
        "admit_for_launch arriving after quiesce_executables during migration must wait, not fail with Conflict"
    );

    quiesce_guard.lift();
    engine_gate.release();

    search_waiter
        .await
        .unwrap()
        .expect("post-quiesce prepare_engine_search must succeed after migration releases");
    launch_waiter
        .await
        .unwrap()
        .expect("post-quiesce admit_for_launch must succeed after migration releases");
}

#[tokio::test]
async fn startup_migration_preserves_unrelated_active_read_while_interactive_move_cancels_it() {
    use diesel::{connection::SimpleConnection, Connection, SqliteConnection};
    use std::time::Duration;
    use tauri::Manager;

    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let legacy_db_dir = app_data.join("db");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&legacy_db_dir).unwrap();
    let (home_fn, app_fn) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&home_fn, &app_fn);
    let default_dirs = make_test_default_dir_source(&home, &app_data);

    let authority = open_test_authority(&tmp);
    let db_handle = authority
        .with_mut(|auth| {
            let db_root = auth
                .get_or_create_database_root(
                    &legacy_db_dir,
                    "db",
                    Some(VerifiedIdentity::from_pair(dir_identity(&legacy_db_dir))),
                )
                .unwrap();
            auth.set_active_database_root(&db_root).unwrap();
            auth.create_database_child(&db_root, OsStr::new("ref.db3"))
                .unwrap()
        })
        .unwrap();

    let legacy_db_path = legacy_db_dir.join("ref.db3");
    {
        let mut conn = SqliteConnection::establish(legacy_db_path.to_str().unwrap()).unwrap();
        conn.batch_execute(include_str!("../../db/create.sql"))
            .unwrap();
        conn.batch_execute(
            "INSERT INTO Info (Name, Value) VALUES ('Version', '2.4.0'); \
             INSERT INTO Info (Name, Value) VALUES ('Title', 'Ref DB');",
        )
        .unwrap();
    }

    let candidates = authority
        .with_mut(|auth| auth.plan_legacy_default_migrations(&lookups))
        .unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].kind, FolderSwitchKind::Database);

    let app = tauri::test::mock_app();
    tauri_specta::Builder::<tauri::test::MockRuntime>::new()
        .events(tauri_specta::collect_events!(
            crate::progress::ProgressEvent
        ))
        .mount_events(&app);
    let state = make_migration_app_state(authority.clone());
    app.manage(state.clone());
    let pending = state.folder_switch.raise_migration_gates(candidates);

    // 1. An unrelated active read (e.g., PGN read or assistant turn) is already active while the
    // startup migration runs. Startup migration MUST NOT call `cancel_active_reads()`, so this
    // unrelated active read remains uncancelled.
    let unrelated_ticket = state.operations.prepare_read("main").unwrap();
    let unrelated_lease = state
        .operations
        .claim_read(&unrelated_ticket, "main", "unrelated-active-read")
        .unwrap();
    let unrelated_token = unrelated_lease.token();

    // 2. An analysis waiting on the Database gate via `wait_for_reserved_migration` before
    // `claim_analysis` waits and then succeeds against the migrated reference database.
    let analysis_id = state.operations.prepare_analysis("main", "tab-a").unwrap();
    let s_analysis = state.clone();
    let id_analysis = analysis_id.clone();
    let db_for_analysis = db_handle.clone();
    let app_for_analysis = app.handle().clone();
    let analysis_waiter = tokio::spawn(async move {
        crate::wait_for_reserved_migration(
            &s_analysis,
            FolderSwitchKind::Database,
            Some(&id_analysis),
            "main",
            crate::infra::operations::ReservationKind::Analysis { tab: "tab-a" },
        )
        .await?;
        let lease =
            s_analysis
                .operations
                .claim_analysis(&id_analysis, "main", "tab-a", "analyze_game")?;
        let token = lease.token();
        crate::db::position_stats_for_operation(
            &s_analysis,
            app_for_analysis,
            "analysis:ref".into(),
            db_for_analysis,
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".into(),
            &token,
        )
        .await
    });

    tokio::time::sleep(Duration::from_millis(35)).await;
    assert!(!analysis_waiter.is_finished());

    crate::workspace_commands::run_legacy_default_migrations(
        state.clone(),
        default_dirs.clone(),
        pending,
    )
    .await;

    assert!(
        !unrelated_token.is_cancelled(),
        "startup legacy migration must NOT cancel an unrelated active read"
    );
    let analysis_stats = analysis_waiter
        .await
        .unwrap()
        .expect("analysis with reference_db must wait through Database migration and succeed");
    assert!(analysis_stats.is_empty());

    // 3. In contrast, an interactive Settings Move (`FolderMoveMode::Interactive`) MUST still
    // cancel active reads before quiescing.
    let custom_target = tmp.path().join("interactive-target-dbs");
    fs::create_dir_all(&custom_target).unwrap();
    let (grant, _, _) = authority
        .with_mut(|auth| {
            auth.choose_folder_switch(
                FolderSwitchKind::Database,
                &custom_target,
                "interactive-target-dbs".into(),
                None,
            )
        })
        .unwrap()
        .unwrap()
        .expect("interactive switch with ref.db3 must yield a Pending grant");
    let prepared = authority
        .with_mut(|auth| auth.prepare_folder_move(&grant))
        .unwrap()
        .unwrap()
        .expect("live interactive folder switch grant");
    let _writer = state
        .folder_switch
        .try_acquire(FolderSwitchKind::Database)
        .unwrap();
    let move_status = crate::workspace_commands::execute_quiesced_folder_move(
        &state,
        default_dirs,
        Some(grant),
        prepared,
        crate::workspace_commands::FolderMoveMode::Interactive,
        "test_interactive_move",
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .expect("interactive folder move must succeed");
    assert!(
        move_status.root_failure.is_none(),
        "interactive folder move must complete cleanly, got {:?}",
        move_status.root_failure
    );
    assert!(
        unrelated_token.is_cancelled(),
        "interactive Move must still cancel active reads"
    );
    drop(unrelated_lease);
}

#[tokio::test]
async fn startup_migration_ignores_unrelated_downloads_and_migrates_second_kind_while_interactive_move_refuses_root_busy(
) {
    use std::time::Duration;

    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("home");
    let app_data = tmp.path().join("app");
    let legacy_db_dir = app_data.join("db");
    let legacy_puzzle_dir = app_data.join("puzzles");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&legacy_db_dir).unwrap();
    fs::create_dir_all(&legacy_puzzle_dir).unwrap();
    let (home_fn, app_fn) = make_lookups(&home, &app_data);
    let lookups = DefaultDirLookups::new(&home_fn, &app_fn);
    let default_dirs = make_test_default_dir_source(&home, &app_data);

    let authority = open_test_authority(&tmp);
    authority
        .with_mut(|auth| {
            let db_root = auth
                .get_or_create_database_root(
                    &legacy_db_dir,
                    "db",
                    Some(VerifiedIdentity::from_pair(dir_identity(&legacy_db_dir))),
                )
                .unwrap();
            auth.set_active_database_root(&db_root).unwrap();
            let _ = auth
                .create_database_child(&db_root, OsStr::new("a.db3"))
                .unwrap();
            let puzzle_root = auth
                .get_or_create_puzzle_root(
                    &legacy_puzzle_dir,
                    "puzzles",
                    Some(VerifiedIdentity::from_pair(dir_identity(
                        &legacy_puzzle_dir,
                    ))),
                )
                .unwrap();
            auth.set_active_puzzle_root(&puzzle_root).unwrap();
            fs::write(legacy_puzzle_dir.join("p.db3"), b"SQLite format 3\0").unwrap();
        })
        .unwrap();

    let candidates = authority
        .with_mut(|auth| auth.plan_legacy_default_migrations(&lookups))
        .unwrap();
    assert_eq!(candidates.len(), 2);
    assert_eq!(candidates[0].kind, FolderSwitchKind::Database);
    assert_eq!(candidates[1].kind, FolderSwitchKind::Puzzle);

    let state = make_migration_app_state(authority.clone());
    let pending = state.folder_switch.raise_migration_gates(candidates);

    // 1. An unrelated active download (e.g. Lichess/Chess.com PGN download or linked account
    // sync) is already active when startup migration runs.
    let unrelated_dl_ticket = state.operations.prepare_download("main").unwrap();
    let unrelated_dl_lease = state
        .operations
        .claim_download(
            &unrelated_dl_ticket,
            "main",
            "unrelated-pgn-download",
            "pgn-dl",
            "pgn-dl",
            false,
            8,
        )
        .unwrap();
    assert!(state.operations.has_uninterruptible_work());

    // 2. A Database waiter wakes as soon as the first kind (`Database`) finishes and immediately
    // claims a `Conversion` lease while the second kind (`Puzzle`) is still pending.
    let conv_ticket = state.operations.prepare_conversion("main").unwrap();
    let s_conv = state.clone();
    let t_conv = conv_ticket.clone();
    let post_db_claim = tokio::spawn(async move {
        crate::wait_for_reserved_migration(
            &s_conv,
            FolderSwitchKind::Database,
            Some(&t_conv),
            "main",
            crate::infra::operations::ReservationKind::Conversion,
        )
        .await?;
        let lease = s_conv.operations.claim_conversion(&t_conv, "main")?;
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(lease);
        Ok::<(), crate::error::Error>(())
    });

    crate::workspace_commands::run_legacy_default_migrations(
        state.clone(),
        default_dirs.clone(),
        pending,
    )
    .await;

    post_db_claim
        .await
        .unwrap()
        .expect("post-Database waiter must wake and claim conversion cleanly");

    // Both `Database` AND `Puzzle` must have migrated to their visible defaults despite the
    // unrelated active download and the post-Database conversion lease.
    assert!(
        home.join("ChessRiddle Studio/Databases/a.db3").exists(),
        "Database kind must migrate while an unrelated download is active"
    );
    assert!(
        home.join("ChessRiddle Studio/Puzzles/p.db3").exists(),
        "second pending kind (Puzzle) must migrate after first kind's waiters woke and claimed leases"
    );

    // 3. In contrast, an interactive Settings Move (`FolderMoveMode::Interactive`) MUST still
    // refuse with `FolderSwitchFailure::RootBusy` while a download is active.
    let custom_target = tmp.path().join("interactive-busy-dbs");
    fs::create_dir_all(&custom_target).unwrap();
    let (grant, _, _) = authority
        .with_mut(|auth| {
            auth.choose_folder_switch(
                FolderSwitchKind::Database,
                &custom_target,
                "interactive-busy-dbs".into(),
                None,
            )
        })
        .unwrap()
        .unwrap()
        .expect("interactive switch with a.db3 must yield Pending");
    let prepared = authority
        .with_mut(|auth| auth.prepare_folder_move(&grant))
        .unwrap()
        .unwrap()
        .expect("live grant");
    let _writer = state
        .folder_switch
        .try_acquire(FolderSwitchKind::Database)
        .unwrap();
    let busy_err = crate::workspace_commands::execute_quiesced_folder_move(
        &state,
        default_dirs,
        Some(grant),
        prepared,
        crate::workspace_commands::FolderMoveMode::Interactive,
        "test_interactive_busy",
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .expect_err("interactive Move must refuse with RootBusy while a download is active");
    assert!(
        matches!(
            busy_err,
            crate::error::Error::FolderSwitch(crate::error::FolderSwitchFailure::RootBusy)
        ),
        "expected FolderSwitchFailure::RootBusy, got {busy_err:?}"
    );
    drop(unrelated_dl_lease);
}
