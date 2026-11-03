use super::operations::completions::{
    CompletionOutcome, EngineInstallIntent, EngineInstallRequest, InstalledEngineResult,
};
use super::operations::{run_native_operation, OperationRegistry, MAX_ACCEPTED_OPERATIONS};
use crate::error::Error;

use super::operations::accounts::{self, AccountImportRequest, AccountImportTarget};
use super::path_authority::{ArtifactPublication, CommitDurability, PathOperation, PathRef};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn reload_completion_mount_account_events(app: &tauri::AppHandle<tauri::test::MockRuntime>) {
    tauri_specta::Builder::<tauri::test::MockRuntime>::new()
        .events(tauri_specta::collect_events!(
            crate::progress::ProgressEvent,
            crate::db::ConvertProgress,
            super::operations::completions::CompletionChanged
        ))
        .mount_events(app);
}

fn reload_completion_account_fixture() -> (
    tempfile::TempDir,
    tauri::AppHandle<tauri::test::MockRuntime>,
    std::path::PathBuf,
    AccountImportRequest,
    ArtifactPublication,
) {
    use tauri::Manager as _;
    let (directory, app, database, path) = crate::db::schema_database_case(
        "account",
        vec![
            PathOperation::DatabaseRead,
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseMutate,
        ],
    );
    reload_completion_mount_account_events(&app);
    let pgn = directory.path().join("account.pgn");
    std::fs::write(&pgn, "[Event \"Import\"]\n[White \"Player\"]\n[Black \"Opponent\"]\n[Result \"1-0\"]\n\n1. e4 e5 1-0\n\n[Event \"Empty\"]\n[White \"Player\"]\n[Black \"Opponent\"]\n[Result \"*\"]\n\n*\n").unwrap();
    let handle = app
        .state::<crate::AppState>()
        .pgn_path_authority
        .with_mut(|authority| {
            authority.get_or_create_persistent_file(
                &pgn,
                "account.pgn",
                vec![PathOperation::ReadPgn],
            )
        })
        .unwrap()
        .unwrap()
        .id;
    let publication = ArtifactPublication {
        handle: super::path_authority::FileWorkspaceHandle::new(handle),
        durability: CommitDurability::DurabilityUncertain(
            crate::error::DurabilityStage::DownloadTargetReplacement,
        ),
    };
    let request = AccountImportRequest {
        provider: "chesscom".into(),
        account: "Player".into(),
        account_handle: None,
        destination: PathRef {
            id: "destination".into(),
        },
        pending_batch: None,
        since_ms: None,
        target: AccountImportTarget::Unlinked {
            database,
            title: "Player Chess.com".into(),
        },
    };
    (directory, app, path, request, publication)
}

fn reload_completion_account_rows(path: &std::path::Path) -> i64 {
    rusqlite::Connection::open(path)
        .unwrap()
        .query_row("SELECT count(*) FROM Games", [], |row| row.get(0))
        .unwrap()
}

fn unlinked_lichess_game(id: &str, date: &str) -> String {
    format!("[White \"Player\"]\n[Black \"Opponent\"]\n[Site \"https://lichess.org/{id}\"]\n[UTCDate \"{date}\"]\n[UTCTime \"12:00:00\"]\n\n1. e4 e5 *\n\n")
}

fn unlinked_cursor(path: &std::path::Path) -> Option<i64> {
    use rusqlite::OptionalExtension;
    rusqlite::Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT CAST(Value AS INTEGER) FROM Info WHERE Name = 'AccountSyncCursor'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unlinked_lichess_adopted_holds_persist_cursor_and_next_download_imports_correspondence_once(
) {
    use tauri::Manager as _;
    // Both an ongoing game and a finished game missing from the export must hold coverage.
    for ongoing in [true, false] {
        let (directory, app, path, mut request, publication) = reload_completion_account_fixture();
        let state = app.state::<crate::AppState>().inner().clone();
        request.provider = "lichess".into();
        request.since_ms = Some(9_999_999_999_999);
        let blitz = unlinked_lichess_game("blitz001", "2026.10.10");
        let correspondence = unlinked_lichess_game("corresp1", "2026.10.01");
        std::fs::write(directory.path().join("account.pgn"), &blitz).unwrap();
        let hold_start = 1_790_856_000_000;
        let first_publication = publication.clone();
        let first = accounts::import_account_games_with_download(
            request.clone(),
            app.clone(),
            "main".into(),
            state.clone(),
            move |download_request, _, _, _, _| async move {
                assert_eq!(
                    download_request.since_ms, None,
                    "native legacy cursor overrides renderer input"
                );
                accounts::adopt_account_download(
                    Ok(super::operations::RuntimeDownload {
                        publication: first_publication,
                        receipt_error: Some(Error::Conflict("linked receipt unavailable".into())),
                        coverage_holds: Some(vec![crate::lichess::CoverageHold {
                            id: "corresp1".into(),
                            created_at_ms: hold_start,
                            ongoing,
                        }]),
                    }),
                    "lichess",
                    "Player",
                )
            },
        )
        .await
        .unwrap();
        assert!(matches!(first.outcome, CompletionOutcome::Succeeded(_)));
        assert_eq!(unlinked_cursor(&path), Some(hold_start - 1));
        assert_eq!(reload_completion_account_rows(&path), 1);
        state
            .operations
            .acknowledge_account_completion(&first.id, "main")
            .unwrap();
        std::fs::write(
            directory.path().join("account.pgn"),
            format!("{blitz}{correspondence}"),
        )
        .unwrap();
        for _ in 0..2 {
            let expected = unlinked_cursor(&path);
            let publication = publication.clone();
            let next = accounts::import_account_games_with_download(
                request.clone(),
                app.clone(),
                "main".into(),
                state.clone(),
                move |download_request, _, _, _, _| async move {
                    assert_eq!(download_request.since_ms, expected);
                    accounts::adopt_account_download(
                        Ok(super::operations::RuntimeDownload {
                            publication,
                            receipt_error: None,
                            coverage_holds: Some(vec![crate::lichess::CoverageHold {
                                id: "corresp1".into(),
                                created_at_ms: hold_start,
                                ongoing: false,
                            }]),
                        }),
                        "lichess",
                        "Player",
                    )
                },
            )
            .await
            .unwrap();
            assert!(matches!(next.outcome, CompletionOutcome::Succeeded(_)));
            assert_eq!(reload_completion_account_rows(&path), 2);
            assert_eq!(unlinked_cursor(&path), Some(1_791_633_600_000));
            state
                .operations
                .acknowledge_account_completion(&next.id, "main")
                .unwrap();
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unlinked_lichess_failed_conversion_retries_retained_publication_with_original_holds() {
    use tauri::Manager as _;
    let (directory, app, path, mut request, publication) = reload_completion_account_fixture();
    let state = app.state::<crate::AppState>().inner().clone();
    request.provider = "lichess".into();
    let blitz = unlinked_lichess_game("blitz001", "2026.10.10");
    std::fs::write(
        directory.path().join("account.pgn"),
        format!("{blitz}[White \"unterminated"),
    )
    .unwrap();
    let hold_start = 1_790_856_000_000;
    let first = accounts::import_account_games_with_download(
        request.clone(),
        app.clone(),
        "main".into(),
        state.clone(),
        move |_, _, _, _, _| async move {
            accounts::adopt_account_download(
                Ok(super::operations::RuntimeDownload {
                    publication,
                    receipt_error: None,
                    coverage_holds: Some(vec![crate::lichess::CoverageHold {
                        id: "corresp1".into(),
                        created_at_ms: hold_start,
                        ongoing: true,
                    }]),
                }),
                "lichess",
                "Player",
            )
        },
    )
    .await
    .unwrap();
    assert!(matches!(first.outcome, CompletionOutcome::Failed(_)));
    assert_eq!(reload_completion_account_rows(&path), 0);
    assert_eq!(unlinked_cursor(&path), None);
    state
        .operations
        .acknowledge_account_completion(&first.id, "main")
        .unwrap();
    assert_eq!(
        state.operations.account_completions("main").unwrap().len(),
        1
    );
    std::fs::write(directory.path().join("account.pgn"), blitz).unwrap();
    let retry = accounts::import_account_games_with_download(
        request,
        app,
        "main".into(),
        state.clone(),
        |_, _, _, _, _| async { panic!("conversion retry must use the retained publication") },
    )
    .await
    .unwrap();
    assert!(matches!(retry.outcome, CompletionOutcome::Succeeded(_)));
    assert_eq!(retry.id, first.id);
    assert_eq!(retry.attempt, first.attempt + 1);
    assert_eq!(reload_completion_account_rows(&path), 1);
    assert_eq!(unlinked_cursor(&path), Some(hold_start - 1));
}

async fn reload_completion_drain(registry: OperationRegistry) {
    assert!(
        tokio::task::spawn_blocking(move || registry.wait_for_drain(Duration::from_secs(10)))
            .await
            .unwrap()
            .unwrap()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reload_completion_account_unlinked_commits_before_reconnect_and_retains_result() {
    use tauri::Manager as _;
    let (_directory, app, path, request, publication) = reload_completion_account_fixture();
    let state = app.state::<crate::AppState>().inner().clone();
    let (attempt, start) = state
        .operations
        .admit_account_completion("main", request.clone())
        .unwrap();
    let start = start.unwrap();
    let id = start.snapshot.id.clone();
    let (_, joined) = state
        .operations
        .admit_account_completion("main", request.clone())
        .unwrap();
    assert!(
        joined.is_none(),
        "a running identical request joins without another lease"
    );
    let (hook, entered, release) = crate::pgn::BoundedHook::new();
    accounts::BEFORE_CONVERT.arm(id.clone(), Box::new(move || hook.notify_and_wait()));
    let downloads = Arc::new(AtomicUsize::new(0));
    let observed_downloads = downloads.clone();
    let native = state.clone();
    let command_app = app.clone();
    let mut command = Box::pin(async move {
        accounts::start_account_completion(
            start,
            command_app,
            "main".into(),
            native,
            move |_, _, _, _, _| async move {
                observed_downloads.fetch_add(1, Ordering::SeqCst);
                Ok(super::operations::RuntimeDownload {
                    publication,
                    receipt_error: None,
                    coverage_holds: None,
                })
            },
        )
        .await;
        attempt.await
    });
    assert!(futures_util::poll!(&mut command).is_pending());
    tokio::time::timeout(Duration::from_secs(10), entered)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        reload_completion_account_rows(&path),
        0,
        "the receiver is dropped before import can commit"
    );
    drop(command);
    state.operations.cancel_owner_reservations("main").unwrap();
    release.send(()).unwrap();
    reload_completion_drain(state.operations.clone()).await;
    // No replacement command, snapshot or acknowledgement has run since the receiver dropped.
    assert_eq!(reload_completion_account_rows(&path), 1);
    let retained = state.operations.account_completions("main").unwrap();
    assert_eq!(
        retained.len(),
        1,
        "account completion must remain retained after command receiver loss"
    );
    assert_eq!(retained[0].id, id);
    assert!(matches!(
        retained[0].outcome,
        CompletionOutcome::Succeeded(_)
    ));
    assert!(matches!(
        retained[0].publication.as_ref().unwrap().durability,
        CommitDurability::DurabilityUncertain(_)
    ));
    let mut second = request;
    second.account = "PLAYER".into();
    second.destination.id = "another-destination".into();
    let joined = accounts::import_account_games_with_download(
        second,
        app,
        "main".into(),
        state.clone(),
        |_, _, _, _, _| async { panic!("a second account start must not download") },
    )
    .await
    .unwrap();
    assert_eq!(joined.id, id);
    assert_eq!(downloads.load(Ordering::SeqCst), 1);
    assert_eq!(reload_completion_account_rows(&path), 1);
    assert!(state
        .operations
        .account_completions("other")
        .unwrap()
        .is_empty());
    assert!(state
        .operations
        .acknowledge_account_completion(&id, "other")
        .is_err());
    state
        .operations
        .acknowledge_account_completion(&id, "main")
        .unwrap();
    state
        .operations
        .acknowledge_account_completion(&id, "main")
        .unwrap();
    assert_eq!(reload_completion_account_rows(&path), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reload_completion_account_deletion_checkpoint_survives_ack_and_retries_only_deletion() {
    use tauri::Manager as _;
    let (_directory, app, path, request, publication) = reload_completion_account_fixture();
    let state = app.state::<crate::AppState>().inner().clone();
    let (attempt, start) = state
        .operations
        .admit_account_completion("main", request.clone())
        .unwrap();
    let start = start.unwrap();
    let id = start.snapshot.id.clone();
    let conversions = Arc::new(AtomicUsize::new(0));
    let count = conversions.clone();
    accounts::BEFORE_CONVERT.arm(
        id.clone(),
        Box::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
        }),
    );
    accounts::DELETE_FAILURE.arm(
        id.clone(),
        Error::Conflict("empty-game deletion failed".into()),
    );
    let downloads = Arc::new(AtomicUsize::new(0));
    let count = downloads.clone();
    accounts::start_account_completion(
        start,
        app.clone(),
        "main".into(),
        state.clone(),
        move |_, _, _, _, _| async move {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(super::operations::RuntimeDownload {
                publication,
                receipt_error: None,
                coverage_holds: None,
            })
        },
    )
    .await;
    let failed = attempt.await.unwrap();
    assert!(matches!(failed.outcome, CompletionOutcome::Failed(_)));
    assert!(failed.deletion_pending);
    assert!(failed.committed_database.is_some());
    assert!(matches!(
        failed.publication.as_ref().unwrap().durability,
        CommitDurability::DurabilityUncertain(_)
    ));
    assert_eq!(reload_completion_account_rows(&path), 2);
    state
        .operations
        .acknowledge_account_completion(&id, "main")
        .unwrap();
    assert_eq!(
        state.operations.account_completions("main").unwrap().len(),
        1
    );
    let deletions = Arc::new(AtomicUsize::new(0));
    let count = deletions.clone();
    accounts::BEFORE_DELETE.arm(
        id.clone(),
        Box::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
        }),
    );
    let count = conversions.clone();
    accounts::BEFORE_CONVERT.arm(
        id.clone(),
        Box::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
        }),
    );
    let count = downloads.clone();
    let success = accounts::import_account_games_with_download(
        request,
        app,
        "main".into(),
        state.clone(),
        move |_, _, _, _, _| async move {
            count.fetch_add(1, Ordering::SeqCst);
            Err(Error::Conflict("must not redownload".into()))
        },
    )
    .await
    .unwrap();
    accounts::BEFORE_CONVERT.clear(&id);
    assert!(matches!(success.outcome, CompletionOutcome::Succeeded(_)));
    assert!(!success.deletion_pending);
    assert_eq!(deletions.load(Ordering::SeqCst), 1);
    assert_eq!(downloads.load(Ordering::SeqCst), 1);
    assert_eq!(conversions.load(Ordering::SeqCst), 1);
    assert_eq!(reload_completion_account_rows(&path), 1);
    state
        .operations
        .acknowledge_account_completion(&id, "main")
        .unwrap();
    assert!(state
        .operations
        .account_completions("main")
        .unwrap()
        .is_empty());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reload_completion_account_pending_batch_appends_without_transfer_before_reconnect() {
    use crate::db::linked_collections::tests::{game, Fixture};
    use crate::file_workspace::WorkspaceFileType;
    let fixture = Fixture::new();
    fixture.create(
        "source",
        &game(Some("1"), "e4 e5", "original"),
        WorkspaceFileType::Game,
    );
    let collection = fixture.list().pop().unwrap();
    fixture.account(&collection.id, "chesscom");
    let batch = fixture.create(
        "batch",
        &game(Some("2"), "d4 d5", "incoming"),
        WorkspaceFileType::Other,
    );
    let request = AccountImportRequest {
        provider: "chesscom".into(),
        account: "player".into(),
        account_handle: None,
        destination: fixture.download_destination(),
        pending_batch: Some(batch),
        since_ms: None,
        target: AccountImportTarget::Linked {
            collection: collection.id.clone(),
        },
    };
    let app = fixture.app();
    reload_completion_mount_account_events(app.handle());
    let (hook, entered, release) = crate::pgn::BoundedHook::new();
    *fixture.service.append_admission_hook.lock().unwrap() = Some(hook);
    let mut command = Box::pin(accounts::import_account_games_with_download(
        request.clone(),
        app.handle().clone(),
        "main".into(),
        fixture.state.clone(),
        |_, _, _, _, _| async { panic!("a prepared pending batch must not transfer") },
    ));
    assert!(futures_util::poll!(&mut command).is_pending());
    tokio::time::timeout(Duration::from_secs(10), entered)
        .await
        .unwrap()
        .unwrap();
    assert!(!std::fs::read_to_string(fixture.path("source"))
        .unwrap()
        .contains("incoming"));
    drop(command);
    release.send(()).unwrap();
    reload_completion_drain(fixture.state.operations.clone()).await;
    let committed = std::fs::read_to_string(fixture.path("source")).unwrap();
    assert_eq!(
        committed.matches("incoming").count(),
        1,
        "append commits while there is no command receiver"
    );
    let retained = fixture
        .state
        .operations
        .account_completions("main")
        .unwrap();
    assert_eq!(retained.len(), 1);
    assert!(matches!(
        retained[0].outcome,
        CompletionOutcome::Succeeded(_)
    ));
    let joined = accounts::import_account_games_with_download(
        request,
        app.handle().clone(),
        "main".into(),
        fixture.state.clone(),
        |_, _, _, _, _| async { panic!("a joined pending batch must not transfer") },
    )
    .await
    .unwrap();
    assert_eq!(joined.id, retained[0].id);
    assert_eq!(
        std::fs::read_to_string(fixture.path("source")).unwrap(),
        committed
    );
}

#[tokio::test]
async fn reload_completion_command_returns_terminal_snapshot_after_event_consumer_acknowledges() {
    use super::operations::completions::CompletionChanged;
    use tauri::Listener as _;
    use tauri_specta::Event as _;

    let app = tauri::test::mock_app();
    tauri_specta::Builder::<tauri::test::MockRuntime>::new()
        .events(tauri_specta::collect_events!(
            crate::progress::ProgressEvent,
            CompletionChanged
        ))
        .mount_events(&app);
    let state = crate::AppState::default();
    let id = Uuid::new_v4().to_string();
    let ticket = state.operations.prepare_download("main").unwrap();
    let operations = state.operations.clone();
    let acknowledged_id = id.clone();
    let acknowledged = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = acknowledged.clone();
    let listener = app.listen_any(CompletionChanged::NAME, move |_| {
        operations
            .acknowledge_engine_completion(&acknowledged_id, "main")
            .unwrap();
        observed.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    // Missing authority deterministically produces a terminal failure without network or child IO.
    // Its event consumer removes that exact result synchronously, before emit_to returns.
    let response = crate::fs::install_engine_workflow_runtime(
        id.clone(),
        reload_completion_request(false),
        ticket,
        app.handle().clone(),
        "main".into(),
        state.clone(),
    )
    .await;
    app.unlisten(listener);
    assert!(acknowledged.load(std::sync::atomic::Ordering::SeqCst));
    assert!(state.operations.engine_completion(&id, "main").is_err());
    let terminal =
        response.expect("acknowledgement must not turn a terminal response into an IPC error");
    assert_eq!(terminal.id, id);
    assert!(matches!(terminal.outcome, CompletionOutcome::Failed(_)));
}

#[test]
fn reload_completion_retains_the_normal_renderer_safe_error_payload() {
    use crate::error::{RemoteHttpRejection, RootFailure};
    let snapshot = crate::engine::EngineTerminalSnapshot {
        kind: crate::engine::EngineFailureKind::ProtocolFailure,
        exit_status: None,
        reason: Some("command e2e4 rejected".into()),
        entries: vec![],
    };
    for error in [
        Error::Cancellation,
        Error::RemoteHttpRejection(RemoteHttpRejection {
            status: 401,
            authorization_sent: true,
        }),
        Error::Io(Box::new(std::io::Error::other("/private/password=secret")))
            .with_root_failure(RootFailure::Permission),
        Error::EngineFailure {
            snapshot: Some(Box::new(snapshot)),
            cause: Box::new(Error::Io(Box::new(std::io::Error::other(
                "/private/token=secret",
            )))),
            cleanup: None,
        },
    ] {
        let registry = OperationRegistry::default();
        let id = Uuid::new_v4().to_string();
        let ticket = registry.prepare_download("main").unwrap();
        let (_, lease) = registry
            .admit_engine_completion(&id, "main", &ticket, reload_completion_request(false), 32)
            .unwrap();
        let expected = serde_json::to_value(&error).unwrap();
        registry.finish_engine_completion(&id, &Err(error)).unwrap();
        drop(lease);
        let CompletionOutcome::Failed(payload) =
            registry.engine_completion(&id, "main").unwrap().outcome
        else {
            panic!("failure must be retained")
        };
        let actual = serde_json::to_value(payload).unwrap();
        assert_eq!(actual, expected);
        assert!(!actual.to_string().contains("private"));
        assert!(!actual.to_string().contains("secret"));
        if actual["category"] == "cancellation" {
            assert_eq!(actual["message"], "Cancellation");
        }
    }
}

#[tokio::test]
async fn reload_completion_acknowledgement_receiver_drop_joins_owned_release() {
    let dir = tempfile::tempdir().unwrap();
    let state = crate::AppState::default();
    state
        .pgn_path_authority
        .install(
            crate::infra::path_authority::PathAuthority::open(
                dir.path().join("authority.json"),
                vec![],
            )
            .unwrap(),
        )
        .unwrap();
    let id = Uuid::new_v4().to_string();
    let ticket = state.operations.prepare_download("main").unwrap();
    let (_, lease) = state
        .operations
        .admit_engine_completion(&id, "main", &ticket, reload_completion_request(false), 32)
        .unwrap();
    state
        .operations
        .finish_engine_completion(&id, &Err(Error::Cancellation))
        .unwrap();
    drop(lease);
    let (held_tx, held_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let authority = state.pgn_path_authority.clone();
    let holder = tokio::task::spawn_blocking(move || {
        authority
            .with_mut(|_| {
                let _ = held_tx.send(());
                let _ = release_rx.recv_timeout(Duration::from_secs(10));
            })
            .unwrap()
    });
    held_rx.await.unwrap();
    let app = tauri::test::mock_app();
    let mut original = Box::pin(crate::fs::acknowledge_engine_completion_runtime(
        id.clone(),
        app.handle().clone(),
        "main".into(),
        state.clone(),
    ));
    assert!(futures_util::poll!(&mut original).is_pending());
    drop(original);
    let mut replacement = Box::pin(crate::fs::acknowledge_engine_completion_runtime(
        id.clone(),
        app.handle().clone(),
        "main".into(),
        state.clone(),
    ));
    assert!(futures_util::poll!(&mut replacement).is_pending());
    assert_eq!(
        state.operations.engine_completions("main").unwrap().len(),
        1
    );
    release_tx.send(()).unwrap();
    holder.await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), replacement)
        .await
        .unwrap()
        .unwrap();
    assert!(state
        .operations
        .engine_completions("main")
        .unwrap()
        .is_empty());
    assert!(state.operations.wait_for_drain(Duration::ZERO).unwrap());
    crate::fs::acknowledge_engine_completion_runtime(
        id,
        app.handle().clone(),
        "main".into(),
        state,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn reload_completion_retirement_command_receiver_drop_joins_original_attempt_and_preserves_new_a(
) {
    use crate::engine::{EngineActor, EngineKey};
    use crate::infra::path_authority::{EngineHandle, PathRef};
    use std::sync::atomic::Ordering;
    struct ReleaseGate(Box<dyn Fn()>);
    impl Drop for ReleaseGate {
        fn drop(&mut self) {
            (self.0)();
        }
    }
    for failed in [false, true] {
        let state = crate::AppState::default();
        let id = Uuid::new_v4().to_string();
        let request = reload_completion_request(true);
        let EngineInstallIntent::Upgrade {
            expected,
            engine_id,
        } = &request.intent
        else {
            unreachable!()
        };
        let a = expected.clone();
        let b = EngineHandle::new(PathRef {
            id: "installed-b".into(),
        });
        let ticket = state.operations.prepare_download("main").unwrap();
        let (_, lease) = state
            .operations
            .admit_engine_completion(&id, "main", &ticket, request.clone(), 32)
            .unwrap();
        state
            .operations
            .finish_engine_completion(
                &id,
                &Ok(InstalledEngineResult {
                    handle: b.clone(),
                    config: crate::chess::EngineConfig::default(),
                    filename: "engine".into(),
                }),
            )
            .unwrap();
        drop(lease);
        let original_key = EngineKey::new("original".into(), engine_id.clone()).unwrap();
        let (actor, gate, calls) =
            EngineActor::gated_pending_test_actor(failed.then_some("original cleanup failed"));
        let gate_cleanup = gate.clone();
        let _release_on_drop = ReleaseGate(Box::new(move || gate_cleanup.open()));
        state
            .engine_supervisor
            .replace_handle(original_key, actor, engine_id.clone(), a.id.clone())
            .await
            .unwrap();
        let mut original = Box::pin(crate::fs::retire_engine_completion_runtime(
            id.clone(),
            Some(b.clone()),
            "main".into(),
            state.clone(),
        ));
        assert!(futures_util::poll!(&mut original).is_pending());
        tokio::time::timeout(Duration::from_secs(3), async {
            while !gate.parked.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        drop(original);
        let mut replacement = Box::pin(crate::fs::retire_engine_completion_runtime(
            id.clone(),
            Some(b.clone()),
            "main".into(),
            state.clone(),
        ));
        assert!(futures_util::poll!(&mut replacement).is_pending());
        gate.open();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), replacement)
                .await
                .unwrap()
                .is_err(),
            failed
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "reconnecting must join the original cleanup"
        );
        assert_eq!(
            state
                .operations
                .engine_completion(&id, "main")
                .unwrap()
                .retired,
            !failed
        );
        let reverse = state
            .engine_supervisor
            .capture_binary_retirement(engine_id.clone(), b.id.clone(), a.id.clone(), true)
            .await
            .unwrap();
        state
            .engine_supervisor
            .resume_binary_retirement(&reverse)
            .await
            .unwrap();
        let key = EngineKey::new("new-a".into(), engine_id.clone()).unwrap();
        let (actor, _) = EngineActor::recording_test_actor(&[]);
        let selected = state
            .engine_supervisor
            .replace_handle(key.clone(), actor.clone(), engine_id.clone(), a.id.clone())
            .await
            .unwrap();
        assert_eq!(
            crate::fs::retire_engine_completion_runtime(
                id.clone(),
                Some(a.clone()),
                "main".into(),
                state.clone()
            )
            .await
            .is_err(),
            failed
        );
        assert_eq!(
            state.engine_supervisor.get_exact(&key).unwrap().generation,
            selected.generation
        );
        assert!(actor.logs().await.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        state
            .engine_supervisor
            .prepare_engine_search(
                EngineKey::new("further-search".into(), engine_id.clone()).unwrap(),
                engine_id.clone(),
                a.id,
            )
            .await
            .unwrap();
        state.engine_supervisor.terminate_all().await.unwrap();
    }
}
use std::time::Duration;
use uuid::Uuid;

fn reload_completion_request(upgrade: bool) -> EngineInstallRequest {
    use crate::infra::path_authority::{EngineHandle, EngineRootHandle, PathRef};
    EngineInstallRequest {
        intent: if upgrade {
            EngineInstallIntent::Upgrade {
                engine_id: "engine".into(),
                expected: EngineHandle::new(PathRef { id: "old".into() }),
            }
        } else {
            EngineInstallIntent::Add {
                engine_id: Uuid::new_v4().to_string(),
            }
        },
        root: EngineRootHandle::new(PathRef { id: "root".into() }),
        progress_id: Uuid::new_v4().to_string(),
        url: "https://example.com/engine.zip".into(),
        sha256: "a".repeat(64),
        signature: "signature".into(),
        relative_path: "engine".into(),
        name: "Engine".into(),
        version: "1".into(),
        elo: None,
        download_size: None,
    }
}

#[test]
fn reload_completion_account_capacity_is_separate_and_never_evicts_unacknowledged_records() {
    let registry = OperationRegistry::default();
    let request = AccountImportRequest {
        provider: "chesscom".into(),
        account: "player".into(),
        account_handle: None,
        destination: PathRef {
            id: "destination".into(),
        },
        pending_batch: None,
        since_ms: None,
        target: AccountImportTarget::Unlinked {
            database: super::path_authority::DatabaseHandle::new(PathRef {
                id: "database".into(),
            }),
            title: "Player Chess.com".into(),
        },
    };
    let mut ids = Vec::new();
    for index in 0..MAX_ACCEPTED_OPERATIONS {
        let mut next = request.clone();
        next.account = format!("player{index}");
        let (_, start) = registry.admit_account_completion("main", next).unwrap();
        let start = start.unwrap();
        let mut snapshot = start.snapshot.clone();
        ids.push(snapshot.id.clone());
        snapshot.outcome = CompletionOutcome::Failed(Error::Cancellation.renderer_payload());
        registry.update_account_completion(snapshot).unwrap();
        drop(start);
    }
    assert!(matches!(
        registry.admit_account_completion("main", request.clone()),
        Err(Error::ResourceLimit(_))
    ));
    assert_eq!(
        registry.account_completions("main").unwrap().len(),
        MAX_ACCEPTED_OPERATIONS
    );
    let ticket = registry.prepare_download("main").unwrap();
    let (_, engine) = registry
        .admit_engine_completion(
            &Uuid::new_v4().to_string(),
            "main",
            &ticket,
            reload_completion_request(false),
            32,
        )
        .unwrap();
    drop(engine);
    assert_eq!(registry.engine_completions("main").unwrap().len(), 1);
    registry
        .acknowledge_account_completion(&ids[0], "main")
        .unwrap();
    assert!(registry.admit_account_completion("main", request).is_ok());
}

#[tokio::test]
async fn reload_completion_mailbox_survives_command_receiver_and_rejoins_exact_request() {
    let registry = OperationRegistry::default();
    let id = Uuid::new_v4().to_string();
    let ticket = registry.prepare_download("main").unwrap();
    let request = reload_completion_request(true);
    let (_, lease) = registry
        .admit_engine_completion(&id, "main", &ticket, request.clone(), 32)
        .unwrap();
    let (release, released) = tokio::sync::oneshot::channel();
    let retained = registry.clone();
    let completed_id = id.clone();
    let mut receiver = Box::pin(run_native_operation(
        lease.unwrap(),
        "completion-test",
        async move {
            released.await.unwrap();
            retained.finish_engine_completion(
                &completed_id,
                &Ok(InstalledEngineResult {
                    handle: crate::infra::path_authority::EngineHandle::new(
                        crate::infra::path_authority::PathRef {
                            id: "installed".into(),
                        },
                    ),
                    config: crate::chess::EngineConfig::default(),
                    filename: "engine".into(),
                }),
            )?;
            Ok(())
        },
    ));
    assert!(futures_util::poll!(&mut receiver).is_pending());
    drop(receiver);
    registry.cancel_owner_reservations("main").unwrap();
    assert!(matches!(
        registry.engine_completions("main").unwrap()[0].outcome,
        CompletionOutcome::Running
    ));
    release.send(()).unwrap();
    let drained = registry.clone();
    assert!(
        tokio::task::spawn_blocking(move || drained.wait_for_drain(Duration::from_secs(5)))
            .await
            .unwrap()
            .unwrap()
    );
    let snapshot = registry.engine_completion(&id, "main").unwrap();
    assert!(matches!(snapshot.outcome, CompletionOutcome::Succeeded(_)));
    let (joined, repeated) = registry
        .admit_engine_completion(&id, "main", "no-new-ticket", request.clone(), 32)
        .unwrap();
    assert!(repeated.is_none());
    assert!(matches!(joined.outcome, CompletionOutcome::Succeeded(_)));
    assert!(registry.engine_completions("other").unwrap().is_empty());
    assert!(registry.engine_completion(&id, "other").is_err());
    assert!(registry
        .admit_engine_completion(&id, "other", &ticket, request.clone(), 32)
        .is_err());
    let mut different = request.clone();
    different.version = "different".into();
    assert!(registry
        .admit_engine_completion(&id, "main", &ticket, different, 32)
        .is_err());
    let next_ticket = registry.prepare_download("main").unwrap();
    let mut next_request = request.clone();
    next_request.intent = EngineInstallIntent::Upgrade {
        engine_id: "engine".into(),
        expected: crate::infra::path_authority::EngineHandle::new(
            crate::infra::path_authority::PathRef {
                id: "installed".into(),
            },
        ),
    };
    next_request.version = "C".into();
    next_request.progress_id = Uuid::new_v4().to_string();
    assert!(
        registry
            .admit_engine_completion(
                &Uuid::new_v4().to_string(),
                "main",
                &next_ticket,
                next_request.clone(),
                32
            )
            .is_err(),
        "partial A to B must exclude B to C"
    );
    assert!(registry.acknowledge_engine_completion(&id, "main").is_err());
    registry.finish_engine_retirement(&id, "main").unwrap();
    registry.acknowledge_engine_completion(&id, "main").unwrap();
    assert!(registry.engine_completions("main").unwrap().is_empty());
    assert!(registry
        .admit_engine_completion(
            &Uuid::new_v4().to_string(),
            "main",
            &next_ticket,
            next_request,
            32
        )
        .is_ok());
}

#[test]
fn reload_completion_capacity_never_evicts_pending_application_and_tail_can_release_full_mailbox() {
    let registry = OperationRegistry::default();
    let mut ids = Vec::new();
    for _ in 0..MAX_ACCEPTED_OPERATIONS {
        let id = Uuid::new_v4().to_string();
        let ticket = registry.prepare_download("main").unwrap();
        let (_, lease) = registry
            .admit_engine_completion(&id, "main", &ticket, reload_completion_request(false), 32)
            .unwrap();
        registry
            .finish_engine_completion(&id, &Err(Error::Cancellation))
            .unwrap();
        drop(lease);
        ids.push(id);
    }
    let ticket = registry.prepare_download("main").unwrap();
    assert!(matches!(
        registry.admit_engine_completion(
            &Uuid::new_v4().to_string(),
            "main",
            &ticket,
            reload_completion_request(false),
            32
        ),
        Err(Error::ResourceLimit(_))
    ));
    assert_eq!(
        registry.engine_completions("main").unwrap().len(),
        MAX_ACCEPTED_OPERATIONS
    );
    let tail = registry.accept_completion_tail(&ids[0], "main").unwrap();
    assert!(registry
        .acknowledge_engine_completion(&ids[0], "other")
        .is_err());
    registry
        .acknowledge_engine_completion(&ids[0], "main")
        .unwrap();
    drop(tail);
    assert!(registry
        .admit_engine_completion(
            &Uuid::new_v4().to_string(),
            "main",
            &ticket,
            reload_completion_request(false),
            32
        )
        .is_ok());
}
