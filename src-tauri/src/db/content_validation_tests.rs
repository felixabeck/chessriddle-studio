use super::*;
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::Duration,
};

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
type App = tauri::AppHandle<tauri::test::MockRuntime>;

#[test]
fn database_storage_size_serializes_exact_decimal_strings_across_u64_range() {
    for decimal in [
        "0",
        "1",
        "9007199254740991",
        "9007199254740992",
        "9007199254740993",
        "18446744073709551615",
    ] {
        let info = DatabaseInfo {
            title: "Storage size".into(),
            description: String::new(),
            player_count: 1,
            event_count: 2,
            game_count: 3,
            storage_size: decimal.parse().unwrap(),
            filename: "games.db3".into(),
            indexed: false,
        };
        let wire = serde_json::to_value(info).unwrap();
        assert_eq!(wire["storage_size"], serde_json::json!(decimal));
        assert_eq!(wire["player_count"], 1);
        assert_eq!(wire["event_count"], 2);
        assert_eq!(wire["game_count"], 3);
    }
}

#[tokio::test]
async fn database_storage_size_matches_actual_metadata_length_as_a_json_string() {
    let _serial = SERIAL.lock().await;
    let (_dir, app, handle, path) = blocking_database_case();
    let state = app.state::<AppState>();
    let metadata = get_db_info_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle,
    )
    .unwrap();
    let length = std::fs::metadata(path).unwrap().len();
    assert!(length > 0);
    let wire = serde_json::to_value(metadata.info).unwrap();
    assert_eq!(wire["storage_size"], serde_json::json!(length.to_string()));
}

fn stamp_path(path: &Path) -> PathBuf {
    path.with_file_name(search_index::integrity_stamp_leaf(
        path.file_name().unwrap(),
    ))
}

fn target(app: &App, handle: &DatabaseHandle) -> DatabaseFileTarget {
    resolve_database(
        &app.state::<AppState>().pgn_path_authority,
        handle,
        PathOperation::DatabaseMutate,
    )
    .unwrap()
}

fn warm(app: &App, handle: &DatabaseHandle) -> DatabaseIdentity {
    let state = app.state::<AppState>();
    let target = target(app, handle);
    let _connection = get_db_or_create(
        &state.database_repository,
        &target,
        None,
        &state.pgn_path_authority,
        handle,
    )
    .unwrap();
    state
        .database_repository
        .database_identity(&target)
        .unwrap()
}

fn import_example(app: &App, handle: &DatabaseHandle, directory: &Path) -> Result<(), Error> {
    let pgn = directory.join("games.pgn");
    std::fs::write(&pgn, "[Event \"Example\"]\n[Result \"*\"]\n\n1. e4 *\n").unwrap();
    let state = app.state::<AppState>();
    let commit = state
        .pgn_path_authority
        .raw_for_test()
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .grant_persistent_file_for_test(&pgn, "games.pgn", vec![PathOperation::ReadPgn]);
    convert_pgn_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        vec![FileWorkspaceHandle::new(commit.id)],
        handle.clone(),
        None,
        app.clone(),
        "created".into(),
        None,
        "create".into(),
        &CancellationToken::new(),
    )
}

fn corrupt(app: &App, handle: &DatabaseHandle, foreign_key: bool) {
    let state = app.state::<AppState>();
    let target = target(app, handle);
    let mut connection = state.database_repository.connection(&target, None).unwrap();
    corrupt_connection(&mut connection, foreign_key);
    drop(connection);
    if !foreign_key {
        let bound = bound_sqlite::BoundDatabase::acquire(&target).unwrap();
        let mut read_only =
            SqliteConnection::establish(&bound.uri(bound_sqlite::SqliteMode::ReadOnly).unwrap())
                .unwrap();
        let result =
            sqlite_cancellation::with_sqlite_cancellation(&CancellationToken::new(), || {
                migrations::validate_content(&mut read_only)
            });
        assert!(
            matches!(result, Err(Error::InvalidInput(message)) if message == "SQLite integrity_check failed")
        );
    }
}

fn corrupt_connection(connection: &mut SqliteConnection, foreign_key: bool) {
    if foreign_key {
        connection.batch_execute("PRAGMA foreign_keys=OFF; INSERT INTO Games (WhiteID) VALUES (999); PRAGMA foreign_keys=ON;").unwrap();
    } else {
        // The bundled SQLite's read-only integrity_check misses Games.Result CHECK violations.
        // Commit a NULL before declaring NOT NULL in an auxiliary table so the
        // canonical schema stays readable and integrity_check finds a real defect.
        connection
            .batch_execute(
                "CREATE TABLE ContentValidationCorruption (Value TEXT);
                 INSERT INTO ContentValidationCorruption VALUES (NULL);
                 PRAGMA writable_schema=ON;
                 UPDATE sqlite_master
                    SET sql='CREATE TABLE ContentValidationCorruption (Value TEXT NOT NULL)'
                  WHERE type='table' AND name='ContentValidationCorruption';
                 PRAGMA writable_schema=RESET;",
            )
            .unwrap();
    }
    connection.batch_execute("INSERT OR REPLACE INTO Info VALUES ('Title', 'Stored title'), ('GameCount', '42'), ('PlayerCount', '9'), ('EventCount', '3');").unwrap();
}

fn seed_version_two_file(path: &Path, version: &str, corrupt_content: bool) {
    let mut connection = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    connection
        .batch_execute("PRAGMA foreign_keys = ON;")
        .unwrap();
    let schema = match version {
        migrations::PRE_ORIENTATION_DATABASE_VERSION => migrations::pre_orientation_schema(),
        migrations::PRE_GAME_COUNT_DATABASE_VERSION => migrations::pre_game_count_schema(),
        other => {
            panic!("seed_version_two_file is a test helper for version-two schemas, got {other}")
        }
    };
    connection.batch_execute(&schema).unwrap();
    sql_query("INSERT INTO Info (Name, Value) VALUES ('Version', ?)")
        .bind::<Text, _>(version)
        .execute(&mut connection)
        .unwrap();
    if corrupt_content {
        if version == migrations::PRE_ORIENTATION_DATABASE_VERSION {
            // ADD COLUMN Orientation rebuilds Games and would abort on a stored
            // Games.Result CHECK; use the auxiliary integrity_check fixture.
            corrupt_connection(&mut connection, false);
        } else {
            connection
                .batch_execute(
                    "PRAGMA ignore_check_constraints = ON;
                     INSERT INTO Games (Result) VALUES ('invalid');
                     PRAGMA ignore_check_constraints = OFF;",
                )
                .unwrap();
        }
    }
}

fn frames(app: &App) -> Arc<std::sync::Mutex<Vec<DatabaseContentFailure>>> {
    tauri_specta::Builder::<tauri::test::MockRuntime>::new()
        .events(tauri_specta::collect_events!(
            DatabaseContentFailure,
            ConvertProgress
        ))
        .mount_events(app);
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = Arc::clone(&events);
    DatabaseContentFailure::listen(app, move |event| {
        captured.lock().unwrap().push(event.payload)
    });
    events
}

// Exercise the production command, including metadata lease release before scan admission.
async fn fetch(app: &App, handle: &DatabaseHandle) -> Result<DatabaseInfo, Error> {
    let state = app.state::<AppState>();
    let result = get_db_info(handle.clone(), app.clone(), app.state::<AppState>()).await;
    // run_accepted_blocking has released the metadata lease before scan admission.
    assert!(!state
        .operations
        .outstanding_labels()
        .unwrap()
        .iter()
        .any(|label| label == "get_db_info"));
    result
}

async fn wait_until(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !ready() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
}

async fn drain(app: &App) {
    wait_until(|| {
        app.state::<AppState>()
            .operations
            .outstanding_labels()
            .unwrap()
            .is_empty()
    })
    .await;
}

async fn assert_pending_integrity_retry(
    app: &App,
    handle: &DatabaseHandle,
    path: &Path,
    events: &std::sync::Mutex<Vec<DatabaseContentFailure>>,
) {
    migrations::take_content_pragma_counts();
    let state = app.state::<AppState>();
    assert!(
        matches!(get_db_info_blocking(&state.pgn_path_authority, &state.database_repository, handle.clone()), Err(Error::InvalidInput(message)) if message == "SQLite integrity_check failed")
    );
    assert_eq!(migrations::take_content_pragma_counts(), (0, 0));
    assert!(stamp_path(path).is_file());
    assert!(fetch(app, handle).await.is_err());
    assert!(state.operations.outstanding_labels().unwrap().is_empty());
    assert_eq!(events.lock().unwrap().len(), 1);
}

#[derive(Default)]
struct Pause {
    started: AtomicUsize,
    ended: AtomicUsize,
    release: AtomicBool,
}
struct PauseGuard(Arc<Pause>);
impl Drop for PauseGuard {
    fn drop(&mut self) {
        self.0.release.store(true, Ordering::SeqCst);
        *content_validation::TEST_CHECKPOINT.lock() = None;
    }
}

fn pause_scans(paths: Vec<PathBuf>) -> PauseGuard {
    let pause = Arc::new(Pause::default());
    let observed = Arc::clone(&pause);
    *content_validation::TEST_CHECKPOINT.lock() = Some(Arc::new(move |path, token| {
        if !paths.iter().any(|candidate| {
            candidate == path
                || std::fs::canonicalize(candidate)
                    .ok()
                    .zip(std::fs::canonicalize(path).ok())
                    .is_some_and(|(candidate, path)| candidate == path)
        }) {
            return;
        }
        let observed = Arc::clone(&observed);
        let token = token.clone();
        let mut first = true;
        sqlite_cancellation::set_callback_hook(move || {
            if !first {
                return;
            }
            first = false;
            observed.started.fetch_add(1, Ordering::SeqCst);
            while !observed.release.load(Ordering::SeqCst) && !token.is_cancelled() {
                std::thread::sleep(Duration::from_millis(1));
            }
            observed.ended.fetch_add(1, Ordering::SeqCst);
        });
    }));
    PauseGuard(pause)
}

#[tokio::test]
async fn content_validation_scan_refuses_same_parent_hard_link_alias_without_registration() {
    let _serial = SERIAL.lock().await;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("original.db3");
    let alias = directory.path().join("alias.db3");
    File::create(&path).unwrap();
    std::fs::hard_link(&path, &alias).unwrap();
    let original_target = DatabaseFileTarget::for_test_path(&path).unwrap();
    let alias_target = DatabaseFileTarget::for_test_path(&alias).unwrap();
    let repository = DatabaseRepository::default();
    {
        let bound = bound_sqlite::BoundDatabase::acquire(&original_target).unwrap();
        let mut connection =
            SqliteConnection::establish(&bound.uri(bound_sqlite::SqliteMode::ReadWrite).unwrap())
                .unwrap();
        connection
            .batch_execute(
                "CREATE TABLE Info (Name TEXT PRIMARY KEY, Value TEXT);
            INSERT INTO Info VALUES ('DataRevision', '0');",
            )
            .unwrap();
    }
    let identity = repository.database_identity(&alias_target).unwrap();
    let owner = bound_sqlite::BoundDatabase::acquire(&original_target).unwrap();
    let outcome = content_validation::scan_worker(
        &repository,
        &alias_target,
        &identity,
        &CancellationToken::new(),
    );
    assert!(
        matches!(outcome.result,
            Err(Error::Conflict(message)) if message == "database is open through another name"
        ),
        "content-validation scans must fail closed for a competing same-parent alias"
    );
    assert!(outcome.event.is_none());
    assert!(!stamp_path(&alias).exists());
    assert!(
        !bound_sqlite::has_binding_for_test(&alias_target),
        "a refused content scan must leave no alias registration or reservation"
    );
    drop(owner);
    let alias_bound = bound_sqlite::BoundDatabase::acquire(&alias_target).unwrap();
    assert!(alias_bound
        .uri(bound_sqlite::SqliteMode::ReadWrite)
        .unwrap()
        .contains("/alias.db3?"));
}

#[tokio::test]
async fn content_validation_current_version_returns_stored_metadata_without_pragmas_and_empty_open_fails(
) {
    let _serial = SERIAL.lock().await;
    let (_dir, app, handle, path) = blocking_database_case();
    corrupt(&app, &handle, false);
    migrations::take_content_pragma_counts();
    let state = app.state::<AppState>();
    let metadata = get_db_info_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
    )
    .unwrap();
    assert_eq!(metadata.title, "Stored title");
    assert_eq!(
        (
            metadata.game_count,
            metadata.player_count,
            metadata.event_count
        ),
        (42, 9, 3)
    );
    assert_ne!(metadata.storage_size.to_string(), "0");
    assert!(metadata.scan.is_some());
    assert_eq!(migrations::take_content_pragma_counts(), (0, 0));
    let identity = warm(&app, &handle);
    let result = content_validation::scan_worker(
        &state.database_repository,
        &target(&app, &handle),
        &identity,
        &CancellationToken::new(),
    );
    assert!(matches!(result.result, Ok(())));
    assert!(
        matches!(get_db_info_blocking(&state.pgn_path_authority, &state.database_repository, handle), Err(Error::InvalidInput(message)) if message == "SQLite integrity_check failed")
    );
    assert!(stamp_path(&path).exists());

    let empty = _dir.path().join("empty.db3");
    File::create(&empty).unwrap();
    let (empty_app, empty_handle) =
        database_app_with_grant(_dir.path(), &empty, "empty", full_database_operations());
    let state = empty_app.state::<AppState>();
    assert!(
        matches!(get_db_info_blocking(&state.pgn_path_authority, &state.database_repository, empty_handle), Err(Error::InvalidInput(message)) if message == "Database has not been initialized yet")
    );
}

#[tokio::test]
async fn content_validation_query_only_read_write_scan_detects_committed_games_check_violation() {
    let _serial = SERIAL.lock().await;
    let (_dir, app, handle, path) = blocking_database_case();
    let state = app.state::<AppState>();
    let target = target(&app, &handle);
    {
        let mut writer = state.database_repository.connection(&target, None).unwrap();
        writer.batch_execute("PRAGMA ignore_check_constraints=ON; INSERT INTO Games (Result) VALUES ('broken'); PRAGMA ignore_check_constraints=OFF; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    }
    {
        let bound = bound_sqlite::BoundDatabase::acquire(&target).unwrap();
        let mut scan_connection =
            SqliteConnection::establish(&bound.uri(bound_sqlite::SqliteMode::ReadWrite).unwrap())
                .unwrap();
        scan_connection
            .batch_execute("PRAGMA query_only=ON;")
            .unwrap();
        assert!(matches!(
            migrations::validate_content(&mut scan_connection),
            Err(Error::InvalidInput(message)) if message == "SQLite integrity_check failed"
        ));
    }
    let events = frames(&app);
    migrations::take_content_pragma_counts();
    let metadata = get_db_info_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
    )
    .unwrap();
    assert!(metadata.scan.is_some());
    assert_eq!(migrations::take_content_pragma_counts(), (0, 0));
    fetch(&app, &handle).await.unwrap();
    drain(&app).await;
    {
        let captured = events.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].message, "SQLite integrity_check failed");
    }
    assert!(stamp_path(&path).is_file());
    assert!(
        matches!(fetch(&app, &handle).await, Err(Error::InvalidInput(message)) if message == "SQLite integrity_check failed")
    );
    assert_eq!(events.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn content_validation_schedule_rechecks_a_newly_published_current_stamp() {
    let _serial = SERIAL.lock().await;
    let (_dir, app, handle, path) = blocking_database_case();
    let state = app.state::<AppState>();
    let metadata = get_db_info_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
    )
    .unwrap();
    let (scan_path, identity) = metadata.scan.unwrap();
    let events = frames(&app);
    let _pause = pause_scans(vec![path.clone()]);
    content_validation::publish_passed_stamp(
        &state.database_repository,
        &state.pgn_path_authority,
        &handle,
        &identity,
    );
    assert!(stamp_path(&path).is_file());
    content_validation::schedule(
        Arc::clone(&state.database_repository),
        state.pgn_path_authority.clone(),
        &state.operations,
        app.clone(),
        handle,
        scan_path,
        identity,
    )
    .await;
    assert!(!state
        .operations
        .outstanding_labels()
        .unwrap()
        .iter()
        .any(|label| label == "database_content_validation"));
    assert!(events.lock().unwrap().is_empty());
}

#[tokio::test]
async fn content_validation_stamp_for_another_file_identity_does_not_suppress_scan() {
    let _serial = SERIAL.lock().await;
    let (_other_dir, other_app, other_handle, other_path) = blocking_database_case();
    let other_identity = warm(&other_app, &other_handle);
    let other_state = other_app.state::<AppState>();
    content_validation::publish_passed_stamp(
        &other_state.database_repository,
        &other_state.pgn_path_authority,
        &other_handle,
        &other_identity,
    );
    assert!(stamp_path(&other_path).is_file());
    let (_dir, app, handle, path) = blocking_database_case();
    std::fs::copy(stamp_path(&other_path), stamp_path(&path)).unwrap();
    let state = app.state::<AppState>();
    let metadata = get_db_info_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
    )
    .unwrap();
    assert!(metadata.scan.is_some());
    assert_ne!(metadata.scan.as_ref().unwrap().1, other_identity);
    let events = frames(&app);
    fetch(&app, &handle).await.unwrap();
    drain(&app).await;
    assert!(get_db_info_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle
    )
    .unwrap()
    .scan
    .is_none());
    assert!(events.lock().unwrap().is_empty());
    assert_ne!(
        std::fs::read(stamp_path(&path)).unwrap(),
        std::fs::read(stamp_path(&other_path)).unwrap()
    );
}

#[tokio::test]
async fn content_validation_worker_rechecks_completed_stamp_without_pragmas_write_or_event() {
    let _serial = SERIAL.lock().await;
    for failure in [None, Some(false), Some(true)] {
        let (_dir, app, handle, path) = blocking_database_case();
        if let Some(foreign) = failure {
            corrupt(&app, &handle, foreign);
        }
        let identity = warm(&app, &handle);
        let state = app.state::<AppState>();
        let target = target(&app, &handle);
        migrations::take_content_pragma_counts();
        let outcome = content_validation::scan_worker(
            &state.database_repository,
            &target,
            &identity,
            &CancellationToken::new(),
        );
        outcome.result.unwrap();
        assert_eq!(outcome.event.is_some(), failure.is_some());
        assert_eq!(migrations::take_content_pragma_counts(), (1, 1));
        let stamp = stamp_path(&path);
        let bytes = std::fs::read(&stamp).unwrap();
        let pinned = std::time::UNIX_EPOCH + Duration::from_secs(100);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&stamp)
            .unwrap()
            .set_modified(pinned)
            .unwrap();
        let modified = std::fs::metadata(&stamp).unwrap().modified().unwrap();
        let repeated = content_validation::scan_worker(
            &state.database_repository,
            &target,
            &identity,
            &CancellationToken::new(),
        );
        repeated.result.unwrap();
        assert!(repeated.event.is_none());
        assert_eq!(migrations::take_content_pragma_counts(), (0, 0));
        assert_eq!(std::fs::read(&stamp).unwrap(), bytes);
        assert_eq!(
            std::fs::metadata(&stamp).unwrap().modified().unwrap(),
            modified
        );
        assert_eq!(
            usize::from(outcome.event.is_some()) + usize::from(repeated.event.is_some()),
            usize::from(failure.is_some())
        );
    }
}

#[tokio::test]
async fn content_validation_pre_epoch_modified_time_round_trips_and_pass_stamp_suppresses_scan() {
    let _serial = SERIAL.lock().await;
    for nanoseconds in [250_000_000, 0] {
        let (_dir, app, handle, path) = blocking_database_case();
        warm(&app, &handle);
        let state = app.state::<AppState>();
        let target = target(&app, &handle);
        {
            let mut writer = state.database_repository.connection(&target, None).unwrap();
            writer
                .batch_execute("PRAGMA wal_checkpoint(TRUNCATE);")
                .unwrap();
        }
        let expected =
            std::time::UNIX_EPOCH - Duration::from_secs(86_400) + Duration::from_nanos(nanoseconds);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(expected)
            .unwrap();
        let identity = state
            .database_repository
            .database_identity(&target)
            .unwrap();
        assert_eq!(identity.modified, expected);
        migrations::take_content_pragma_counts();
        let outcome = content_validation::scan_worker(
            &state.database_repository,
            &target,
            &identity,
            &CancellationToken::new(),
        );
        outcome.result.unwrap();
        assert_eq!(migrations::take_content_pragma_counts(), (1, 1));
        assert!(stamp_path(&path).is_file());
        let encoded: serde_json::Value =
            serde_json::from_slice(&std::fs::read(stamp_path(&path)).unwrap()).unwrap();
        assert_eq!(encoded["identity"]["modified"]["seconds"], -86_400);
        assert_eq!(encoded["identity"]["modified"]["nanoseconds"], nanoseconds);
        let metadata = get_db_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
        )
        .unwrap();
        assert!(metadata.scan.is_none());
        assert_eq!(migrations::take_content_pragma_counts(), (0, 0));
        assert!(outcome.event.is_none());
        // An unreadable timestamp remains a missing stamp, never a corruption verdict.
        let mut malformed = encoded;
        malformed["identity"]["modified"]["nanoseconds"] = serde_json::json!(1_000_000_000_u32);
        std::fs::write(stamp_path(&path), serde_json::to_vec(&malformed).unwrap()).unwrap();
        assert!(get_db_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle
        )
        .unwrap()
        .scan
        .is_some());
    }
}

#[tokio::test]
async fn content_validation_create_and_migration_run_both_pragmas_and_publish_passed_stamps() {
    let _serial = SERIAL.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("created.db3");
    File::create(&path).unwrap();
    let (app, handle) =
        database_app_with_grant(dir.path(), &path, "created", full_database_operations());
    frames(&app);
    let state = app.state::<AppState>();
    migrations::take_content_pragma_counts();
    import_example(&app, &handle, dir.path()).unwrap();
    assert_eq!(migrations::take_content_pragma_counts(), (1, 1));
    let metadata = get_db_info_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle,
    )
    .unwrap();
    assert!(metadata.scan.is_none());
    assert!(stamp_path(&path).exists());

    let legacy = dir.path().join("legacy.db3");
    let mut connection = SqliteConnection::establish(legacy.to_str().unwrap()).unwrap();
    connection.batch_execute("CREATE TABLE Info (Name TEXT UNIQUE NOT NULL, Value TEXT);
        CREATE TABLE Players (ID INTEGER PRIMARY KEY, Name TEXT UNIQUE, Elo INTEGER);
        CREATE TABLE Events (ID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT UNIQUE);
        CREATE TABLE Sites (ID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT UNIQUE);
        CREATE TABLE Games (ID INTEGER PRIMARY KEY AUTOINCREMENT, EventID INTEGER, SiteID INTEGER, Date TEXT, UTCTime TEXT, Round INTEGER, WhiteID INTEGER, WhiteElo INTEGER, BlackID INTEGER, BlackElo INTEGER, WhiteMaterial INTEGER, BlackMaterial INTEGER, Result INTEGER, TimeControl TEXT, ECO TEXT, PlyCount INTEGER, FEN TEXT, Moves BLOB, PawnHome BLOB);
        INSERT INTO Info VALUES ('Version', '1.0.0');").unwrap();
    drop(connection);
    let (legacy_app, legacy_handle) =
        database_app_with_grant(dir.path(), &legacy, "legacy", full_database_operations());
    migrations::take_content_pragma_counts();
    {
        let state = legacy_app.state::<AppState>();
        let _connection = state
            .database_repository
            .connection(&target(&legacy_app, &legacy_handle), None)
            .unwrap();
        assert!(!stamp_path(&legacy).exists());
    }
    warm(&legacy_app, &legacy_handle);
    assert_eq!(migrations::take_content_pragma_counts(), (1, 1));
    assert!(stamp_path(&legacy).exists());
    let state = legacy_app.state::<AppState>();
    assert!(get_db_info_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        legacy_handle
    )
    .unwrap()
    .scan
    .is_none());
}

#[tokio::test]
async fn content_validation_additive_migration_defers_content_scan() {
    let _serial = SERIAL.lock().await;
    for version in [
        migrations::PRE_GAME_COUNT_DATABASE_VERSION,
        migrations::PRE_ORIENTATION_DATABASE_VERSION,
    ] {
        for corrupt_content in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("games.db3");
            seed_version_two_file(&path, version, corrupt_content);
            let (app, handle) =
                database_app_with_grant(dir.path(), &path, "games", full_database_operations());
            let state = app.state::<AppState>();
            migrations::take_content_pragma_counts();
            {
                let _connection = state
                    .database_repository
                    .connection(&target(&app, &handle), None)
                    .unwrap();
            }
            assert_eq!(migrations::take_content_pragma_counts(), (0, 0));
            assert!(!stamp_path(&path).exists());
            let metadata = get_db_info_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle.clone(),
            )
            .unwrap();
            assert!(metadata.scan.is_some());
            assert!(!stamp_path(&path).exists());
            let (scan_path, identity) = metadata.scan.unwrap();
            let outcome = content_validation::scan_worker(
                &state.database_repository,
                &target(&app, &handle),
                &identity,
                &CancellationToken::new(),
            );
            outcome.result.unwrap();
            assert_eq!(
                std::fs::canonicalize(&scan_path).unwrap(),
                std::fs::canonicalize(&path).unwrap()
            );
            if corrupt_content {
                assert_eq!(
                    outcome.event.as_ref().map(|event| event.message.as_str()),
                    Some("SQLite integrity_check failed")
                );
                assert!(
                    matches!(get_db_info_blocking(&state.pgn_path_authority, &state.database_repository, handle), Err(Error::InvalidInput(message)) if message == "SQLite integrity_check failed")
                );
            } else {
                assert!(outcome.event.is_none());
                assert!(stamp_path(&path).is_file());
                assert!(get_db_info_blocking(
                    &state.pgn_path_authority,
                    &state.database_repository,
                    handle
                )
                .unwrap()
                .scan
                .is_none());
            }
        }
    }
}

#[tokio::test]
async fn content_validation_rolled_back_create_leaves_no_integrity_stamp() {
    let _serial = SERIAL.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("created.db3");
    File::create(&path).unwrap();
    let (app, handle) =
        database_app_with_grant(dir.path(), &path, "created", full_database_operations());
    frames(&app);
    let source = dir.path().join("games.pgn");
    migrations::take_content_pragma_counts();
    {
        // Remove the granted input after the pool opens. Creation's nested
        // transaction succeeds, but the import's outer transaction rolls back.
        let _hooks = repository::configure_test_hooks(&path, |hooks| {
            hooks.post_get = Some(Box::new(move || std::fs::remove_file(&source).unwrap()));
        });
        assert!(import_example(&app, &handle, dir.path()).is_err());
    }
    assert_eq!(migrations::take_content_pragma_counts(), (1, 1));
    assert!(!stamp_path(&path).exists());
    let state = app.state::<AppState>();
    let mut connection = state
        .database_repository
        .initialization_connection(&target(&app, &handle), None)
        .unwrap();
    let tables: Vec<IndexInfo> = sql_query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .load(&mut *connection)
    .unwrap();
    assert!(tables.is_empty());
}

#[tokio::test]
async fn content_validation_committed_import_survives_failed_pass_stamp_and_metadata_schedules_scan(
) {
    let _serial = SERIAL.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("created.db3");
    File::create(&path).unwrap();
    std::fs::create_dir(stamp_path(&path)).unwrap();
    let (app, handle) =
        database_app_with_grant(dir.path(), &path, "created", full_database_operations());
    frames(&app);
    let state = app.state::<AppState>();
    migrations::take_content_pragma_counts();
    import_example(&app, &handle, dir.path()).unwrap();
    assert_eq!(migrations::take_content_pragma_counts(), (1, 1));
    assert!(path.is_file());
    let metadata = get_db_info_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
    )
    .unwrap();
    assert_eq!(metadata.game_count, 1);
    assert!(metadata.scan.is_some());
    assert_eq!(migrations::take_content_pragma_counts(), (0, 0));
    std::fs::remove_dir(stamp_path(&path)).unwrap();
    fetch(&app, &handle).await.unwrap();
    drain(&app).await;
    assert!(stamp_path(&path).is_file());
}

#[tokio::test]
async fn content_validation_fresh_repository_and_registry_reuse_passed_and_failed_stamps() {
    let _serial = SERIAL.lock().await;
    for failure in [None, Some(false), Some(true)] {
        let (_dir, app, handle, path) = blocking_database_case();
        if let Some(foreign) = failure {
            corrupt(&app, &handle, foreign);
        }
        let events = frames(&app);
        fetch(&app, &handle).await.unwrap();
        drain(&app).await;
        assert!(stamp_path(&path).exists());
        assert_eq!(events.lock().unwrap().len(), usize::from(failure.is_some()));
        let (fresh_app, fresh_handle) =
            database_app_with_grant(_dir.path(), &path, "fresh", full_database_operations());
        let fresh_state = fresh_app.state::<AppState>();
        assert!(!Arc::ptr_eq(
            &fresh_state.database_repository,
            &app.state::<AppState>().database_repository
        ));
        migrations::take_content_pragma_counts();
        let result = fetch(&fresh_app, &fresh_handle).await;
        if failure.is_some() {
            assert!(
                matches!(result, Err(Error::InvalidInput(message)) if message == if failure == Some(true) { "SQLite foreign_key_check failed" } else { "SQLite integrity_check failed" })
            );
        } else {
            assert_eq!(result.unwrap().filename, "games.db3");
        }
        assert_eq!(migrations::take_content_pragma_counts(), (0, 0));
        assert!(fresh_state
            .operations
            .outstanding_labels()
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn content_validation_older_scan_finishing_after_newer_cannot_replace_stamp() {
    let _serial = SERIAL.lock().await;
    let (_dir, app, handle, path) = blocking_database_case();
    let identity = warm(&app, &handle);
    let pause = pause_scans(vec![path.clone()]);
    let state = app.state::<AppState>();
    let repository = Arc::clone(&state.database_repository);
    let old_target = target(&app, &handle);
    let old_repository = Arc::clone(&repository);
    let older = std::thread::spawn(move || {
        content_validation::scan_worker(
            &old_repository,
            &old_target,
            &identity,
            &CancellationToken::new(),
        )
    });
    wait_until(|| pause.0.started.load(Ordering::SeqCst) == 1).await;
    *content_validation::TEST_CHECKPOINT.lock() = None;
    {
        let mut connection = repository.connection(&target(&app, &handle), None).unwrap();
        connection
            .batch_execute("INSERT OR REPLACE INTO Info VALUES ('DataRevision', '1')")
            .unwrap();
    }
    let new_identity = warm(&app, &handle);
    content_validation::scan_worker(
        &repository,
        &target(&app, &handle),
        &new_identity,
        &CancellationToken::new(),
    )
    .result
    .unwrap();
    let newer_stamp = std::fs::read(stamp_path(&path)).unwrap();
    pause.0.release.store(true, Ordering::SeqCst);
    assert!(older.join().unwrap().result.is_err());
    assert_eq!(std::fs::read(stamp_path(&path)).unwrap(), newer_stamp);
}

#[tokio::test]
async fn content_validation_transient_execution_error_writes_no_corruption_stamp_or_event() {
    let _serial = SERIAL.lock().await;
    let (_dir, app, handle, path) = blocking_database_case();
    let state = app.state::<AppState>();
    let target = target(&app, &handle);
    let mut connection = state
        .database_repository
        .initialization_connection(&target, None)
        .unwrap();
    connection.batch_execute("DROP TABLE Games; CREATE TABLE Games (ID INTEGER, Ref INTEGER REFERENCES Players(Missing));").unwrap();
    let identity = state
        .database_repository
        .database_identity(&target)
        .unwrap();
    let result = content_validation::scan_worker(
        &state.database_repository,
        &target,
        &identity,
        &CancellationToken::new(),
    );
    assert!(matches!(result.result, Err(Error::Diesel(_))));
    assert!(!stamp_path(&path).exists());
    assert!(result.event.is_none());
}

#[tokio::test]
async fn content_validation_resolved_pass_stamp_warning_names_database_leaf() {
    let _serial = SERIAL.lock().await;
    let (_dir, app, handle, path) = blocking_database_case();
    let identity = warm(&app, &handle);
    std::fs::create_dir(stamp_path(&path)).unwrap();
    let state = app.state::<AppState>();
    let capture = crate::error::LogCaptureScope::start();
    content_validation::publish_passed_stamp(
        &state.database_repository,
        &state.pgn_path_authority,
        &handle,
        &identity,
    );
    let leaf = path.file_name().unwrap().to_string_lossy();
    assert!(capture.messages().iter().any(|message| {
        message.contains("passed content validation stamp publication failed")
            && message.contains(leaf.as_ref())
    }));
    assert!(stamp_path(&path).is_dir());
}

#[tokio::test]
async fn content_validation_failed_stamp_write_and_identity_probe_keep_pending_verdict() {
    use crate::infra::fs::{self, AtomicFileFaultPoint, AtomicWriterInjector};

    struct MissingDuringWrite {
        path: PathBuf,
        backup: PathBuf,
    }
    impl AtomicWriterInjector for MissingDuringWrite {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == AtomicFileFaultPoint::Write {
                std::fs::rename(&self.path, &self.backup)?;
                return Err(std::io::Error::other("injected stamp write failure"));
            }
            Ok(())
        }
    }
    struct Restore {
        path: PathBuf,
        backup: PathBuf,
        previous: Option<Arc<dyn AtomicWriterInjector + Send + Sync>>,
    }
    impl Drop for Restore {
        fn drop(&mut self) {
            fs::set_test_atomic_file_injector(self.previous.take());
            if self.backup.exists() {
                let _ = std::fs::rename(&self.backup, &self.path);
            }
        }
    }

    let _serial = SERIAL.lock().await;
    let (_dir, app, handle, path) = blocking_database_case();
    let state = app.state::<AppState>();
    let target = target(&app, &handle);
    {
        // Close every SQLite handle before the fault renames the primary on Windows.
        let bound = bound_sqlite::BoundDatabase::acquire(&target).unwrap();
        let mut connection =
            SqliteConnection::establish(&bound.uri(bound_sqlite::SqliteMode::ReadWrite).unwrap())
                .unwrap();
        connection
            .batch_execute("PRAGMA journal_mode=WAL;")
            .unwrap();
        corrupt_connection(&mut connection, false);
    }
    let identity = state
        .database_repository
        .database_identity(&target)
        .unwrap();
    let events = frames(&app);
    let failed_probe = Arc::new(AtomicBool::new(false));
    {
        let observed = Arc::clone(&failed_probe);
        let probe_path = path.clone();
        let _hooks = repository::configure_test_hooks(&path, |hooks| {
            hooks.after_probe_current = Some(Box::new(move |_| {
                if !probe_path.exists() {
                    observed.store(true, Ordering::SeqCst);
                }
            }));
        });
        let backup = path.with_extension("held");
        let _restore = Restore {
            path: path.clone(),
            backup: backup.clone(),
            previous: fs::current_test_atomic_file_injector(),
        };
        fs::set_test_atomic_file_injector(Some(Arc::new(MissingDuringWrite {
            path: path.clone(),
            backup,
        })));
        let result = content_validation::scan_worker(
            &state.database_repository,
            &target,
            &identity,
            &CancellationToken::new(),
        );
        if let Some(event) = result.event {
            let _ = event.emit(&app);
        }
        assert!(
            matches!(result.result, Err(Error::Io(error)) if error.to_string() == "injected stamp write failure")
        );
        assert!(failed_probe.load(Ordering::SeqCst));
        assert_eq!(events.lock().unwrap().len(), 1);
        assert!(!stamp_path(&path).exists());
    }
    assert_eq!(
        state
            .database_repository
            .database_identity(&target)
            .unwrap(),
        identity
    );
    assert_pending_integrity_retry(&app, &handle, &path, &events).await;
}

#[tokio::test]
async fn content_validation_failed_stamp_write_keeps_verdict_retries_on_metadata_without_rescan() {
    let _serial = SERIAL.lock().await;
    let (_dir, app, handle, path) = blocking_database_case();
    corrupt(&app, &handle, false);
    std::fs::create_dir(stamp_path(&path)).unwrap();
    let events = frames(&app);
    fetch(&app, &handle).await.unwrap();
    drain(&app).await;
    assert_eq!(events.lock().unwrap().len(), 1);
    std::fs::remove_dir(stamp_path(&path)).unwrap();
    assert_pending_integrity_retry(&app, &handle, &path, &events).await;
}

#[tokio::test]
async fn content_validation_metadata_returns_during_active_scan_and_only_one_of_many_scans_takes_gateway(
) {
    let _serial = SERIAL.lock().await;
    let cases: Vec<_> = (0..7).map(|_| blocking_database_case()).collect();
    for (_, app, handle, _) in &cases {
        warm(app, handle);
        frames(app);
    }
    let pause = pause_scans(cases.iter().map(|case| case.3.clone()).collect());
    fetch(&cases[0].1, &cases[0].2).await.unwrap();
    wait_until(|| pause.0.started.load(Ordering::SeqCst) == 1).await;
    // More due scans than the three free gateway permits still leave metadata responsive.
    for (_, app, handle, _) in &cases {
        tokio::time::timeout(Duration::from_secs(3), fetch(app, handle))
            .await
            .unwrap()
            .unwrap();
    }
    assert_eq!(pause.0.started.load(Ordering::SeqCst), 1);
    assert_eq!(pause.0.ended.load(Ordering::SeqCst), 0);
    let (release, _) = tokio::sync::watch::channel(false);
    let mut held = Vec::new();
    let permits = Arc::new(AtomicUsize::new(0));
    for _ in 0..3 {
        let mut receiver = release.subscribe();
        let acquired = Arc::clone(&permits);
        held.push(tokio::spawn(async move {
            BLOCKING_GATEWAY
                .spawn(move || {
                    acquired.fetch_add(1, Ordering::SeqCst);
                    while !*receiver.borrow() && receiver.has_changed().is_ok() {
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    receiver.mark_changed();
                    Ok(())
                })
                .await
        }));
    }
    wait_until(|| permits.load(Ordering::SeqCst) == 3).await;
    assert_eq!(pause.0.started.load(Ordering::SeqCst), 1);
    release.send(true).unwrap();
    for permit in held {
        permit.await.unwrap().unwrap();
    }
    // Cancels active and queued scans, all on the registries used by the app.
    for (_, app, _, _) in &cases {
        app.state::<AppState>()
            .operations
            .seal_and_request_cancellation()
            .unwrap();
    }
    for (_, app, _, path) in &cases {
        drain(app).await;
        assert!(!stamp_path(path).exists());
    }
    assert_eq!(pause.0.started.load(Ordering::SeqCst), 1);
    assert_eq!(pause.0.ended.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn content_validation_shutdown_ends_active_pragma_without_stamp_or_event() {
    let _serial = SERIAL.lock().await;
    let (_dir, app, handle, path) = blocking_database_case();
    let events = frames(&app);
    let pause = pause_scans(vec![path.clone()]);
    fetch(&app, &handle).await.unwrap();
    wait_until(|| pause.0.started.load(Ordering::SeqCst) == 1).await;
    app.state::<AppState>()
        .operations
        .seal_and_request_cancellation()
        .unwrap();
    drain(&app).await;
    assert_eq!(pause.0.ended.load(Ordering::SeqCst), 1);
    assert!(!stamp_path(&path).exists());
    assert!(events.lock().unwrap().is_empty());
}

#[tokio::test]
async fn content_validation_delete_ends_active_pragma_removes_stamp_and_never_recreates_file() {
    let _serial = SERIAL.lock().await;
    let (_dir, app, handle, path) = blocking_database_case();
    let events = frames(&app);
    let pause = pause_scans(vec![path.clone()]);
    fetch(&app, &handle).await.unwrap();
    wait_until(|| pause.0.started.load(Ordering::SeqCst) == 1).await;
    delete_database(handle, app.state::<AppState>())
        .await
        .unwrap();
    drain(&app).await;
    assert_eq!(pause.0.ended.load(Ordering::SeqCst), 1);
    assert!(!path.exists());
    assert!(!stamp_path(&path).exists());
    assert!(events.lock().unwrap().is_empty());

    let (_dir, app, handle, path) = blocking_database_case();
    fetch(&app, &handle).await.unwrap();
    drain(&app).await;
    assert!(stamp_path(&path).exists());
    delete_database(handle, app.state::<AppState>())
        .await
        .unwrap();
    assert!(!stamp_path(&path).exists());
}

#[tokio::test]
async fn content_validation_failed_scan_emits_exactly_one_failure_after_verdict_and_pass_emits_none(
) {
    let _serial = SERIAL.lock().await;
    let (_dir, app, handle, path) = blocking_database_case();
    corrupt(&app, &handle, true);
    let events = frames(&app);
    let seen = Arc::new(AtomicBool::new(false));
    let seen_at_event = Arc::clone(&seen);
    let event_app = app.clone();
    let event_handle = handle.clone();
    DatabaseContentFailure::listen(&app, move |_| {
        let state = event_app.state::<AppState>();
        let result = get_db_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            event_handle.clone(),
        );
        seen_at_event.store(matches!(result, Err(Error::InvalidInput(message)) if message == "SQLite foreign_key_check failed"), Ordering::SeqCst);
    });
    fetch(&app, &handle).await.unwrap();
    drain(&app).await;
    assert!(seen.load(Ordering::SeqCst));
    {
        let captured = events.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(
            captured[0].filename,
            path.file_name().unwrap().to_string_lossy()
        );
        assert_eq!(captured[0].message, "SQLite foreign_key_check failed");
    }
    assert!(fetch(&app, &handle).await.is_err());
    assert_eq!(events.lock().unwrap().len(), 1);
    let (_dir, app, handle, _) = blocking_database_case();
    let events = frames(&app);
    fetch(&app, &handle).await.unwrap();
    drain(&app).await;
    assert!(events.lock().unwrap().is_empty());
}

#[tokio::test]
async fn content_validation_production_database_lister_excludes_integrity_stamp() {
    let _serial = SERIAL.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("databases");
    std::fs::create_dir(&root_path).unwrap();
    let mut authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    let root = authority
        .get_or_create_database_root(&root_path, "Databases", None)
        .unwrap();
    let handle = authority
        .create_database_child(&root, OsStr::new("games.db3"))
        .unwrap();
    std::fs::write(root_path.join("games.db3.integrity"), b"stamp").unwrap();
    let listed = authority
        .list_database_children_cancellable(&root, &CancellationToken::new())
        .unwrap();
    assert_eq!(listed.entries.len(), 1);
    assert_eq!(listed.entries[0].handle, handle);
    assert_eq!(listed.entries[0].filename, "games.db3");
}
