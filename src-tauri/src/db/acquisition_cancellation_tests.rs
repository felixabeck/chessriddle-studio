//! Behavioral anchors for command tokens at the real, exhausted SQLite pool boundary.

#[cfg(test)]
mod tests {
    use super::super::*;
    use std::{
        sync::mpsc,
        thread::{self, ScopedJoinHandle},
        time::Duration,
    };

    type App = tauri::AppHandle<tauri::test::MockRuntime>;
    const ACQUISITION_BOUND: Duration = Duration::from_secs(3);
    const ARRIVAL_BOUND: Duration = Duration::from_secs(10);

    // Field order closes native owners before removing the database directory, including on unwind.
    struct OrdinaryFixture {
        app: App,
        database: DatabaseHandle,
        directory: tempfile::TempDir,
    }

    impl OrdinaryFixture {
        fn new() -> Self {
            let (directory, app, database, _) = blocking_database_case();
            Self {
                app,
                database,
                directory,
            }
        }

        fn assert_cancellation(
            &self,
            run: impl Fn(&CancellationToken) -> Result<(), Error> + Sync,
        ) {
            let state = self.app.state::<AppState>();
            let target = resolve_database(
                &state.pgn_path_authority,
                &self.database,
                PathOperation::DatabaseRead,
            )
            .unwrap();
            assert_acquisition_cancellation(&state.database_repository, &target, run);
        }
    }

    // Own both sides of the contention. Cleanup releases the pool before joining even if an
    // assertion panics, and consumes a worker panic without causing a second panic during unwind.
    struct ContendedWorker<'scope> {
        holders: Vec<repository::DatabaseConnection>,
        worker: Option<ScopedJoinHandle<'scope, ()>>,
        cancellation: CancellationToken,
    }

    impl ContendedWorker<'_> {
        fn settle(&mut self) -> thread::Result<()> {
            self.cancellation.cancel();
            self.holders.clear();
            self.worker.take().map_or(Ok(()), |worker| worker.join())
        }
    }

    impl Drop for ContendedWorker<'_> {
        fn drop(&mut self) {
            let _ = self.settle();
        }
    }

    struct PoolCleanup<'a> {
        repository: &'a DatabaseRepository,
        target: &'a DatabaseFileTarget,
    }

    impl Drop for PoolCleanup<'_> {
        fn drop(&mut self) {
            // Retirement drains native connection and factory owners as well as checked-out leases.
            // Never turn an earlier assertion panic into a double panic during cleanup.
            let _ = self.repository.close_and_invalidate(self.target);
        }
    }

    fn assert_acquisition_cancellation(
        repository: &DatabaseRepository,
        target: &DatabaseFileTarget,
        run: impl Fn(&CancellationToken) -> Result<(), Error> + Sync,
    ) {
        let _pool_cleanup = PoolCleanup { repository, target };
        // Warm validation before saturation and hook installation. Setup never uses the forwarding
        // helper under test, so mutating that helper cannot turn the negative control into setup failure.
        drop(repository.connection(target, None).unwrap());
        let holders = repository.hold_all_connections_for_test(target).unwrap();
        let (arrived_tx, arrived_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let hooks = repository::configure_test_hooks(target.path(), |hooks| {
            hooks.before_pool_get = Some(Box::new(move || {
                let _ = arrived_tx.send(());
            }));
        });
        thread::scope(|scope| {
            let cancellation = CancellationToken::new();
            let worker_token = cancellation.clone();
            // Construct the cleanup owner before spawning, so spawn failure also releases holders.
            let mut owned = ContendedWorker {
                holders,
                worker: None,
                cancellation,
            };
            let run = &run;
            owned.worker = Some(scope.spawn(move || {
                let _ = done_tx.send(run(&worker_token));
            }));
            arrived_rx
                .recv_timeout(ARRIVAL_BOUND)
                .expect("command must reach the selected BeforePoolGet acquisition boundary");
            owned.cancellation.cancel();
            let result = done_rx.recv_timeout(ACQUISITION_BOUND);
            // The holders must remain retained through this assertion. Releasing first would let
            // later SQL cancellation hide a missing token or an unrelated live token at acquisition.
            assert!(
            matches!(result, Ok(Err(Error::Cancellation))),
            "ACQUISITION_CANCELLATION: expected typed Cancellation within {ACQUISITION_BOUND:?} while all pool holders remain retained, got {result:?}"
        );
            owned.settle().expect("acquisition worker must not panic");
        });
        drop(hooks);
        run(&CancellationToken::new()).expect("fresh invocation of the same route must recover");
        repository
            .close_and_invalidate(target)
            .expect("native pool owners must drain before fixture removal");
    }

    #[test]
    fn validated_mutation_acquisition_cancels_and_recovers() {
        let fixture = OrdinaryFixture::new();
        let state = fixture.app.state::<AppState>();
        fixture.assert_cancellation(|token| {
            edit_db_info_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                fixture.database.clone(),
                Some("Acquisition recovery".into()),
                None,
                token,
            )
        });
    }

    #[test]
    fn conversion_acquisition_cancels_and_recovers() {
        let fixture = OrdinaryFixture::new();
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events!(ConvertProgress))
            .mount_events(&fixture.app);
        let source = fixture.directory.path().join("source.pgn");
        std::fs::write(&source, "[Result \"*\"]\n\n1. e4 e5 *\n").unwrap();
        let source = grant_pgn_file(
            &fixture.app,
            &source,
            "source.pgn",
            vec![PathOperation::ReadPgn],
        );
        let state = fixture.app.state::<AppState>();
        fixture.assert_cancellation(|token| {
            convert_pgn_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                vec![source.clone()],
                fixture.database.clone(),
                None,
                fixture.app.clone(),
                "Acquisition recovery".into(),
                None,
                "acquisition-conversion".into(),
                token,
            )
        });
    }

    #[test]
    fn ordinary_index_acquisition_cancels_and_recovers() {
        let fixture = OrdinaryFixture::new();
        let state = fixture.app.state::<AppState>();
        fixture.assert_cancellation(|token| {
            generate_search_index(
                &fixture.database,
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                token,
            )
        });
    }

    #[test]
    fn create_indexes_acquisition_cancels_and_recovers() {
        let fixture = OrdinaryFixture::new();
        let state = fixture.app.state::<AppState>();
        fixture.assert_cancellation(|token| {
            create_indexes_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                fixture.database.clone(),
                token,
            )
        });
    }

    #[test]
    fn delete_indexes_acquisition_cancels_and_recovers() {
        let fixture = OrdinaryFixture::new();
        let state = fixture.app.state::<AppState>();
        create_indexes_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            fixture.database.clone(),
            &CancellationToken::new(),
        )
        .unwrap();
        fixture.assert_cancellation(|token| {
            delete_indexes_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                fixture.database.clone(),
                token,
            )
        });
    }

    #[test]
    fn games_acquisition_cancels_and_recovers() {
        let fixture = OrdinaryFixture::new();
        let state = fixture.app.state::<AppState>();
        fixture.assert_cancellation(|token| {
            get_games_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                fixture.database.clone(),
                GameQuery::new(),
                token,
            )
            .map(|_| ())
        });
    }

    #[test]
    fn players_acquisition_cancels_and_recovers() {
        let fixture = OrdinaryFixture::new();
        let state = fixture.app.state::<AppState>();
        fixture.assert_cancellation(|token| {
            get_players_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                fixture.database.clone(),
                PlayerQuery {
                    options: QueryOptions {
                        skip_count: false,
                        page: None,
                        page_size: None,
                        sort: PlayerSort::Id,
                        direction: SortDirection::Asc,
                    },
                    name: None,
                    name_match: None,
                    range: None,
                },
                token,
            )
            .map(|_| ())
        });
    }

    #[test]
    fn tournaments_acquisition_cancels_and_recovers() {
        let fixture = OrdinaryFixture::new();
        let state = fixture.app.state::<AppState>();
        fixture.assert_cancellation(|token| {
            get_tournaments_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                fixture.database.clone(),
                TournamentQuery {
                    options: QueryOptions {
                        skip_count: false,
                        page: None,
                        page_size: None,
                        sort: TournamentSort::Name,
                        direction: SortDirection::Asc,
                    },
                    name: None,
                },
                token,
            )
            .map(|_| ())
        });
    }

    #[test]
    fn player_game_info_acquisition_cancels_and_recovers() {
        let fixture = OrdinaryFixture::new();
        let state = fixture.app.state::<AppState>();
        fixture.assert_cancellation(|token| {
            get_players_game_info_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                fixture.database.clone(),
                1,
                (fixture.app.clone(), None),
                token,
                None,
            )
            .map(|_| ())
        });
    }

    #[cfg(unix)]
    #[test]
    fn export_acquisition_cancels_and_recovers() {
        let fixture = OrdinaryFixture::new();
        let destination = fixture.directory.path().join("export.pgn");
        std::fs::write(&destination, b"").unwrap();
        let destination = grant_pgn_file(
            &fixture.app,
            &destination,
            "export.pgn",
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
        );
        let state = fixture.app.state::<AppState>();
        fixture.assert_cancellation(|token| {
            export_to_pgn_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                fixture.database.clone(),
                destination.clone(),
                token,
            )
        });
    }

    #[cfg(unix)]
    struct LinkedFixtureOwner(Option<linked_collections::tests::Fixture>);

    #[cfg(unix)]
    impl Drop for LinkedFixtureOwner {
        fn drop(&mut self) {
            if let Some(linked_collections::tests::Fixture {
                directory,
                state,
                workspace,
                service,
            }) = self.0.take()
            {
                drop(state);
                drop(service);
                drop(workspace);
                drop(directory);
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn linked_index_acquisition_cancels_and_recovers() {
        let owner = LinkedFixtureOwner(Some(linked_collections::tests::Fixture::new()));
        let fixture = owner.0.as_ref().unwrap();
        fixture.create(
            "linked",
            &linked_collections::tests::game(None, "e4 e5", "acquisition"),
            crate::file_workspace::WorkspaceFileType::Game,
        );
        let database = fixture.list().pop().unwrap().database.unwrap();
        let state = &fixture.state;
        // Complete collection refresh before arming the hook. The tested route then reaches the
        // direct linked branch in generate_search_index_locked without an earlier acquisition.
        fixture
            .service
            .resolve_database(
                &state.pgn_path_authority,
                &database,
                PathOperation::DatabaseRead,
                &CancellationToken::new(),
            )
            .unwrap();
        assert!(fixture.service.is_linked(&database).unwrap());
        let target = resolve_database(
            &state.pgn_path_authority,
            &database,
            PathOperation::DatabaseRead,
        )
        .unwrap();
        assert_acquisition_cancellation(&state.database_repository, &target, |token| {
            generate_search_index_locked(
                &target,
                &state.database_repository,
                &state.search_cache,
                token,
                &state.pgn_path_authority,
                &database,
            )
        });
    }
}
