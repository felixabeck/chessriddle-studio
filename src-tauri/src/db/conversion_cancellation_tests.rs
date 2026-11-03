//! Portable tests through the production ticketed command core and real SQLite transactions.
use super::*;
use tauri::Manager;

const PGN: &str = "[Event \"Cancellation fixture\"]\n[White \"White\"]\n[Black \"Black\"]\n[Result \"*\"]\n\n1. e4 e5 *\n";

type App = tauri::AppHandle<tauri::test::MockRuntime>;
type Fixture = (
    tempfile::TempDir,
    App,
    DatabaseHandle,
    FileWorkspaceHandle,
    std::path::PathBuf,
);

fn fixture() -> Fixture {
    fixture_with_empty_target(false)
}

fn fixture_with_empty_target(empty: bool) -> Fixture {
    let (dir, app, database, path) = if empty {
        arbitrary_database_case(&[])
    } else {
        blocking_database_case()
    };
    tauri_specta::Builder::<tauri::test::MockRuntime>::new()
        .events(tauri_specta::collect_events!(ConvertProgress))
        .mount_events(&app);
    let source = dir.path().join("source.pgn");
    std::fs::write(&source, PGN).unwrap();
    let file = grant_pgn_file(&app, &source, "source.pgn", vec![PathOperation::ReadPgn]);
    (dir, app, database, file, path)
}

async fn convert(
    app: App,
    database: DatabaseHandle,
    file: FileWorkspaceHandle,
    ticket: Option<String>,
    id: String,
) -> Result<(), Error> {
    let state = app.state::<AppState>();
    convert_pgn_command_core(
        id,
        vec![file],
        database,
        app.clone(),
        "Fixture".into(),
        None,
        ticket.as_deref(),
        "main",
        &state,
    )
    .await
}

fn contents(path: &std::path::Path) -> (i64, u64) {
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    (
        games::table.count().get_result(&mut db).unwrap(),
        repository::read_data_revision(&mut db).unwrap(),
    )
}

fn pause(
    hooks: &crate::infra::test_hooks::KeyedTestHooks<String>,
    id: &str,
) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    hooks.arm(
        id.to_owned(),
        Box::new(move || {
            entered_tx.send(()).unwrap();
            release_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
        }),
    );
    (entered_rx, release_tx)
}

async fn entered(receiver: std::sync::mpsc::Receiver<()>) {
    tokio::task::spawn_blocking(move || {
        receiver
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap()
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn convert_pgn_reserved_ticket_cancellation_never_imports() {
    let (_dir, app, database, file, path) = fixture();
    let registry = &app.state::<AppState>().operations;
    let ticket = registry.prepare_conversion("main").unwrap();
    let before = contents(&path);
    assert!(registry.cancel_conversion(&ticket, "main").unwrap());
    assert!(matches!(
        convert(
            app.clone(),
            database,
            file,
            Some(ticket.clone()),
            "reserved".into()
        )
        .await,
        Err(Error::Cancellation)
    ));
    assert_eq!(contents(&path), before);
    assert!(!registry.cancel_conversion(&ticket, "main").unwrap());
}

#[tokio::test]
async fn convert_pgn_ticket_cancellation_rolls_back_existing_content_and_revision() {
    let (_dir, app, database, file, path) = fixture();
    convert(
        app.clone(),
        database.clone(),
        file.clone(),
        None,
        "seed".into(),
    )
    .await
    .unwrap();
    let before = contents(&path);
    let registry = &app.state::<AppState>().operations;
    let ticket = registry.prepare_conversion("main").unwrap();
    let id = format!("rollback:{}", uuid::Uuid::new_v4());
    let (reached, release) = pause(&CONVERSION_BEFORE_REVISION, &id);
    let task = tokio::spawn(convert(
        app.clone(),
        database,
        file,
        Some(ticket.clone()),
        id,
    ));
    entered(reached).await;
    assert!(registry.cancel_conversion(&ticket, "main").unwrap());
    registry.release_conversion(&ticket, "main").unwrap();
    assert!(!registry.outstanding_labels().unwrap().is_empty());
    release.send(()).unwrap();
    assert!(matches!(task.await.unwrap(), Err(Error::Cancellation)));
    assert_eq!(contents(&path), before);
    assert!(registry.outstanding_labels().unwrap().is_empty());
}

#[tokio::test]
async fn convert_pgn_queued_cancel_does_not_cancel_same_target_sibling_and_can_retry() {
    let (_dir, app, database, file, path) = fixture();
    let registry = &app.state::<AppState>().operations;
    let first = registry.prepare_conversion("main").unwrap();
    let second = registry.prepare_conversion("main").unwrap();
    let first_id = format!("first:{}", uuid::Uuid::new_v4());
    let (reached, release) = pause(&CONVERSION_BEFORE_REVISION, &first_id);
    let first_task = tokio::spawn(convert(
        app.clone(),
        database.clone(),
        file.clone(),
        Some(first.clone()),
        first_id,
    ));
    entered(reached).await;
    // The sibling reaches the blocking core while the first owns the target's write lease.
    let (queued, dispatch) = install_database_command_checkpoint("convert_pgn", &database);
    let second_task = tokio::spawn(convert(
        app.clone(),
        database.clone(),
        file.clone(),
        Some(second.clone()),
        "second".into(),
    ));
    entered(queued).await;
    dispatch.send(()).unwrap();
    assert!(registry.cancel_conversion(&second, "main").unwrap());
    assert!(matches!(
        second_task.await.unwrap(),
        Err(Error::Cancellation)
    ));
    release.send(()).unwrap();
    first_task.await.unwrap().unwrap();
    assert_eq!(contents(&path), (1, 1));
    let retry = registry.prepare_conversion("main").unwrap();
    convert(app.clone(), database, file, Some(retry), "retry".into())
        .await
        .unwrap();
    assert_eq!(contents(&path), (2, 2));
}

#[tokio::test]
async fn convert_pgn_committed_success_wins_late_ticket_cancellation() {
    let (_dir, app, database, file, path) = fixture();
    let registry = &app.state::<AppState>().operations;
    let ticket = registry.prepare_conversion("main").unwrap();
    let id = format!("committed:{}", uuid::Uuid::new_v4());
    let (reached, release) = pause(&CONVERSION_AFTER_COMMIT, &id);
    let task = tokio::spawn(convert(
        app.clone(),
        database,
        file,
        Some(ticket.clone()),
        id,
    ));
    entered(reached).await;
    assert!(registry.cancel_conversion(&ticket, "main").unwrap());
    release.send(()).unwrap();
    task.await.unwrap().unwrap();
    assert_eq!(contents(&path), (1, 1));
}

#[tokio::test]
async fn convert_pgn_abandoned_command_survives_reload_and_owner_destruction_until_shutdown() {
    let (_dir, app, database, file, path) = fixture();
    let registry = &app.state::<AppState>().operations;
    let ticket = registry.prepare_conversion("main").unwrap();
    let id = format!("abandoned:{}", uuid::Uuid::new_v4());
    let (reached, release) = pause(&CONVERSION_BEFORE_REVISION, &id);
    let task = tokio::spawn(convert(
        app.clone(),
        database,
        file,
        Some(ticket.clone()),
        id,
    ));
    entered(reached).await;
    task.abort();
    registry.cancel_owner_reservations("main").unwrap();
    registry.cancel_owner("main").unwrap();
    assert!(!registry.outstanding_labels().unwrap().is_empty());
    registry.seal_and_request_cancellation().unwrap();
    assert!(!registry.wait_for_drain(std::time::Duration::ZERO).unwrap());
    release.send(()).unwrap();
    let drained = registry.clone();
    assert!(tokio::task::spawn_blocking(move || drained
        .wait_for_drain(std::time::Duration::from_secs(10))
        .unwrap())
    .await
    .unwrap());
    assert_eq!(contents(&path), (0, 0));
}

#[tokio::test]
async fn convert_pgn_cancelled_new_target_is_deleted_only_after_worker_settlement() {
    let (_dir, app, database, file, path) = fixture_with_empty_target(true);
    let state = app.state::<AppState>();
    let ticket = state.operations.prepare_conversion("main").unwrap();
    let id = format!("new:{}", uuid::Uuid::new_v4());
    let (reached, release) = pause(&CONVERSION_BEFORE_REVISION, &id);
    let task = tokio::spawn(convert(
        app.clone(),
        database.clone(),
        file,
        Some(ticket.clone()),
        id,
    ));
    entered(reached).await;
    state.operations.cancel_conversion(&ticket, "main").unwrap();
    state
        .operations
        .release_conversion(&ticket, "main")
        .unwrap();
    assert!(path.exists());
    assert!(!state.operations.outstanding_labels().unwrap().is_empty());
    release.send(()).unwrap();
    assert!(matches!(task.await.unwrap(), Err(Error::Cancellation)));
    #[derive(QueryableByName)]
    struct TableCount {
        #[diesel(sql_type = diesel::sql_types::BigInt)]
        count: i64,
    }
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    let tables: TableCount =
        sql_query("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'Games'")
            .get_result(&mut db)
            .unwrap();
    assert_eq!(tables.count, 0);
    assert_eq!(repository::read_data_revision(&mut db).unwrap(), 0);
    drop(db);
    delete_database(database, state).await.unwrap();
    assert!(!path.exists());
}
